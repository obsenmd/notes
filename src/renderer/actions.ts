import { path, clipboard, shell } from "../../platforms/platform";
import type moment from "moment";

import type { RuntimeHost } from "../compat/runtime-host";
import { TFile, TFolder, type TAbstractFile } from "../compat/vault";
import { Notice } from "../compat/ui";
import type { Editor } from "../compat/editor";
import type { PaneType, WorkspaceLeaf } from "../compat/workspace";
import { chooseItem, confirmDialog } from "../controllers/dialogs";
import { t } from "../i18n";
import type { BookmarkItem } from "./bookmarks";
import type { VaultConfig } from "./config";
import type { CorePluginStore } from "./core-plugins";
import { openDailyNote } from "./core/daily-notes";
import { expandTemplate, openTemplatePicker } from "./core/templates";

export type OpenTarget = PaneType | boolean;
const INVALID_NAME = /[\\/:*?"<>|]/;
const UNSAFE_NAME = /[#^[\]|]/;

/** Returns a localized problem with a proposed file or folder name, or null when it is usable. */
export function validateFileName(name: string): string | null {
  if (!name.trim()) return t("plugins.file-explorer.msg-empty-file-name");
  if (INVALID_NAME.test(name)) return t("plugins.file-explorer.msg-invalid-characters") + '\\ / : * ? " < > |';
  if (name.startsWith(".")) return t("plugins.file-explorer.msg-bad-dotfile");
  return null;
}
export function unsafeNameWarning(name: string): string | null {
  return UNSAFE_NAME.test(name) ? t("plugins.file-explorer.msg-unsafe-characters") + "# ^ [ ] |" : null;
}

const notify = (error: unknown) => { new Notice(error instanceof Error ? error.message : String(error)); };

/** Workspace operations shared by commands, menus, the ribbon and sidebar views. */
export class AppActions {
  constructor(readonly host: RuntimeHost, readonly config: VaultConfig, readonly corePlugins: CorePluginStore, readonly vaultPath: string,
    private readonly ui: { openSettings(tab?: string): void; openVaultChooser(): void }) {}

  get app() { return this.host.app; }
  get vault() { return this.host.vault; }
  get workspace() { return this.host.workspace; }

  /** Runs an operation and reports a failure as a notice instead of an unhandled rejection. */
  run = (operation: () => unknown): void => { try { void Promise.resolve(operation()).catch(notify); } catch (error) { notify(error); } };

  activeFile(): TFile | null { return this.workspace.getActiveFile(); }
  activeEditor(): Editor | null { return (this.app.getCommandContext().editor as Editor | undefined) ?? null; }

  /** Most recent leaf in the main area, creating a tab when it only holds non-navigable views. */
  private leafFor(target: OpenTarget = false): WorkspaceLeaf {
    if (target) return this.workspace.getLeaf(target);
    return this.workspace.getUnpinnedLeaf();
  }

  async openFile(file: TFile, target: OpenTarget = false, state?: Record<string, unknown>): Promise<WorkspaceLeaf> {
    const leaf = this.leafFor(target);
    await leaf.openFile(file, { active: true, state });
    this.workspace.setActiveLeaf(leaf);
    return leaf;
  }

  async openPath(filePath: string, target: OpenTarget = false): Promise<void> {
    const file = this.vault.getFileByPath(filePath);
    if (!file) { new Notice(t("dialogue.msg-file-or-folder-not-found", { path: filePath })); return; }
    await this.openFile(file, target);
  }

  /** Folder that new notes go to, following the "Default location for new notes" preference. */
  newFileParent(): TFolder {
    const location = this.config.get("newFileLocation");
    if (location === "current") return this.activeFile()?.parent ?? this.vault.getRoot();
    if (location === "folder") return this.vault.getFolderByPath(this.config.get("newFileFolderPath").replace(/^\/+|\/+$/g, "")) ?? this.vault.getRoot();
    return this.vault.getRoot();
  }

  async newNote(parent?: TFolder | null, target: OpenTarget = this.workspace.activeLeaf?.view.getViewType() === "empty" ? false : "tab"): Promise<TFile> {
    const folder = parent ?? this.newFileParent();
    const prefix = folder.path && folder.path !== "/" ? `${folder.path}/` : "";
    const file = await this.vault.create(this.vault.getAvailablePath(prefix + t("plugins.file-explorer.label-untitled-file"), "md"), "");
    const leaf = await this.openFile(file, target, { mode: "source" });
    // A new note starts with its title selected for renaming.
    requestAnimationFrame(() => {
      const title = leaf.containerEl.querySelector<HTMLElement>(".inline-title[contenteditable='true']");
      if (!title) return;
      title.focus();
      const range = title.ownerDocument.createRange(); range.selectNodeContents(title);
      const selection = title.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    });
    return file;
  }

  async newFolder(parent?: TFolder | null): Promise<TFolder> {
    const folder = parent ?? this.vault.getRoot();
    const prefix = folder.path && folder.path !== "/" ? `${folder.path}/` : "";
    const created = await this.vault.createFolder(this.vault.getAvailablePath(prefix + t("plugins.file-explorer.label-untitled-folder")));
    this.workspace.trigger("file-explorer:rename", created.path);
    return created;
  }

  async newCanvas(parent?: TFolder | null, target: OpenTarget = "tab"): Promise<TFile> {
    const folder = parent ?? this.newFileParent();
    const prefix = folder.path && folder.path !== "/" ? `${folder.path}/` : "";
    const file = await this.vault.create(this.vault.getAvailablePath(prefix + t("plugins.file-explorer.label-untitled-file"), "canvas"), "{}");
    await this.openFile(file, target);
    return file;
  }

  async newBase(parent?: TFolder | null, target: OpenTarget = "tab"): Promise<TFile> {
    const folder = parent ?? this.newFileParent();
    const prefix = folder.path && folder.path !== "/" ? `${folder.path}/` : "";
    const file = await this.vault.create(this.vault.getAvailablePath(prefix + t("plugins.file-explorer.label-untitled-file"), "base"), "");
    await this.openFile(file, target);
    return file;
  }

  /** Renames in place; `name` excludes the extension for files. */
  async rename(file: TAbstractFile, name: string): Promise<boolean> {
    const clean = name.trim();
    const problem = validateFileName(clean);
    if (problem) { new Notice(problem); return false; }
    const extension = file instanceof TFile && file.extension ? `.${file.extension}` : "";
    const parent = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const next = `${parent}${clean}${extension}`;
    if (next === file.path) return true;
    const existing = this.vault.getAbstractFileByPath(next);
    if (existing && existing !== file && next.toLowerCase() !== file.path.toLowerCase()) { new Notice(t("plugins.file-explorer.msg-file-already-exists")); return false; }
    await this.app.fileManager.renameFile(file, next);
    return true;
  }

  async delete(file: TAbstractFile): Promise<boolean> {
    const option = this.config.get("trashOption");
    if (this.config.get("promptDelete")) {
      const isFolder = file instanceof TFolder;
      const message = [t("dialogue.label-confirm-deletion", { filename: file.name })];
      if (isFolder && file.children.length) message.push(t("dialogue.label-non-empty-folder"), t("dialogue.label-delete-folder-warning"));
      if (file instanceof TFile) {
        const count = this.backlinkCount(file);
        if (count) message.push(t("dialogue.label-existing-backlink", { count }));
      }
      message.push(t(option === "system" ? "dialogue.label-move-to-system-trash" : option === "local" ? "dialogue.label-move-to-vault-trash" : "dialogue.label-permanent-delete"));
      const result = await confirmDialog(this.app, { title: t(isFolder ? "dialogue.label-delete-folder" : "dialogue.label-delete-file"), message, cta: t("dialogue.button-delete"), warning: true, checkbox: t("dialogue.label-do-not-ask-again") });
      if (!result.confirmed) return false;
      if (result.checked) this.config.set("promptDelete", false);
    }
    if (option === "none") await this.vault.delete(file, true);
    else await this.vault.trash(file, option === "system");
    return true;
  }

  backlinkCount(file: TFile): number {
    let count = 0;
    const resolved = this.host.metadataCache.resolvedLinks;
    for (const source of Object.keys(resolved)) if (source !== file.path) count += resolved[source][file.path] ?? 0;
    return count;
  }

  async duplicate(file: TFile): Promise<TFile> {
    const parent = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const target = this.vault.getAvailablePath(`${parent}${file.basename} 1`, file.extension);
    const copy = await this.vault.createBinary(target, await this.vault.adapter.readBinary(file.path));
    return copy;
  }

  async moveTo(file: TAbstractFile): Promise<void> {
    const folders = this.vault.getAllFolders(true).filter(folder => folder !== file && folder !== file.parent && !(file instanceof TFolder && (folder.path + "/").startsWith(file.path + "/")));
    const destination = await chooseItem(this.app, folders, folder => folder.path === "/" || !folder.path ? "/" : folder.path, {
      placeholder: t("plugins.file-explorer.prompt-type-folder"), emptyText: t("plugins.file-explorer.label-no-folders"),
      instructions: [
        { command: "↑↓", purpose: t("plugins.file-explorer.instruction-navigate") },
        { command: "↵", purpose: t("plugins.file-explorer.instruction-move") },
        { command: "esc", purpose: t("plugins.file-explorer.instruction-dismiss") },
      ],
    });
    if (!destination) return;
    await this.move(file, destination);
  }

  async move(file: TAbstractFile, destination: TFolder): Promise<void> {
    const prefix = destination.path && destination.path !== "/" ? `${destination.path}/` : "";
    if (this.vault.getAbstractFileByPath(prefix + file.name)) { new Notice(t("plugins.file-explorer.msg-file-already-exists")); return; }
    await this.app.fileManager.renameFile(file, prefix + file.name);
  }

  absolutePath(file: TAbstractFile): string { return path.join(this.vaultPath, ...file.path.split("/")); }
  showInFolder(file: TAbstractFile): void { shell.showItemInFolder(this.absolutePath(file)); }
  openWithDefaultApp(file: TAbstractFile): void { void shell.openPath(this.absolutePath(file)); }
  copyVaultPath(file: TAbstractFile): void { clipboard.writeText(file.path); }
  copyFullPath(file: TAbstractFile): void { clipboard.writeText(this.absolutePath(file)); }
  copyUrl(file: TAbstractFile): void { clipboard.writeText(`obsidian://open?vault=${encodeURIComponent(this.vault.getName())}&file=${encodeURIComponent(file.path.replace(/\.md$/i, ""))}`); }

  async revealLeafOfType(type: string, side: "left" | "right"): Promise<WorkspaceLeaf> {
    let leaf = this.workspace.getLeavesOfType(type)[0];
    if (!leaf) { leaf = this.workspace.createDockLeaf(side); await leaf.setViewState({ type }); }
    const dock = side === "left" ? this.workspace.leftSplit : this.workspace.rightSplit;
    if (dock?.collapsed) dock.expand();
    leaf.parent?.activateLeaf(leaf);
    this.workspace.setActiveLeaf(leaf);
    this.workspace.notifyLayoutChange();
    return leaf;
  }

  toggleSidebar(side: "left" | "right"): void {
    const dock = side === "left" ? this.workspace.leftSplit : this.workspace.rightSplit;
    if (!dock) return;
    dock.toggle();
    this.workspace.notifyLayoutChange();
    this.workspace.trigger("resize");
  }

  async openGraph(target: OpenTarget = false): Promise<void> {
    const existing = this.workspace.getLeavesOfType("graph").find(leaf => !(leaf.view.getState() as { local?: boolean }).local);
    if (existing && !target) { this.workspace.setActiveLeaf(existing); return; }
    const leaf = this.leafFor(target || (this.workspace.activeLeaf?.view.getViewType() === "empty" ? false : "tab"));
    await leaf.setViewState({ type: "graph", active: true });
    this.workspace.setActiveLeaf(leaf);
  }

  async openSearch(query?: string): Promise<void> {
    const leaf = await this.revealLeafOfType("search", "left");
    if (query !== undefined) await leaf.setViewState({ type: "search", state: { ...leaf.view.getState(), query } });
    requestAnimationFrame(() => leaf.containerEl.ownerDocument.querySelector<HTMLInputElement>('.workspace-leaf-content[data-type="search"] input[type="search"]')?.focus());
  }

  /** Opens today's daily note, creating it from the configured template when it does not exist. */
  openDailyNote(event?: MouseEvent | KeyboardEvent | null): Promise<void> { return openDailyNote(this, event); }

  /** Replaces `{{title}}`, `{{date}}`, `{{time}}` and their `:format` variants, with the built-in date and time formats. */
  async expandTemplate(source: string, title: string, date?: moment.Moment): Promise<string> { return expandTemplate(source, { title }, {}, date); }

  /** Opens the template prompt of the "Templates" plugin. */
  insertTemplate(): Promise<void> { return openTemplatePicker(this); }

  /** Opens what a bookmark points at: a file (and heading or block), a folder, a search, a graph or a web page. */
  async openBookmark(item: BookmarkItem, target: OpenTarget = false): Promise<void> {
    if (item.type === "file" && item.path) {
      if (item.subpath) await this.workspace.openLinkText(item.path + item.subpath, "", target, { active: true });
      else await this.openPath(item.path, target);
    } else if (item.type === "graph" && this.corePlugins.isEnabled("graph")) {
      const leaf = this.workspace.getLeaf(target);
      await leaf.setViewState({ type: "graph", active: true });
      if (item.options && typeof item.options === "object") (leaf.view as unknown as { setGraphOptions?: (options: object) => void }).setGraphOptions?.(item.options);
      this.workspace.setActiveLeaf(leaf);
    }
    else if (item.type === "url" && item.url) window.open(item.url, "_blank");
    else if (item.type === "folder" && item.path) { await this.revealLeafOfType("file-explorer", "left"); this.workspace.trigger("file-explorer:reveal", item.path); }
    else if (item.type === "search" && this.corePlugins.isEnabled("global-search")) await this.openSearch(item.query ?? "");
  }

  openSettings(tab?: string): void { this.ui.openSettings(tab); }
  openVaultChooser(): void { this.ui.openVaultChooser(); }
  openHelp(): void { void shell.openExternal("https://help.obsidian.md"); }
}
