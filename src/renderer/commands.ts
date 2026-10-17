import { ipcRenderer, path, originalFs as fs, process } from "../../platforms/platform";
import type { Hotkey } from "../compat/commands";



import { Notice, type Modal } from "../compat/ui";
import { renderMarkdown } from "../compat/markdown-parser";
import { TFile } from "../compat/vault";
import { chooseItem, confirmDialog } from "../controllers/dialogs";
import { readCorePluginData } from "./core-plugins";
import { listThemes } from "./custom-css";
import { FrontmatterMigrationModal } from "./migrate-frontmatter";
import type { CorePluginCommand } from "./core";
import { WebViewerView } from "./WebViewer";
import { FileView } from "../compat/file-views";
import { MarkdownView } from "../compat/markdown-view";
import { WorkspaceLeaf, WorkspaceTabs } from "../compat/workspace";
import { COMMAND_INVENTORY, commandName, type CommandDefinition } from "../controllers/command-inventory";
import { registerEditorCommands } from "../compat/editor-actions";
import { t } from "../i18n";
import type { AppActions } from "./actions";
import type { BookmarkStore } from "./bookmarks";
import { CommandPaletteModal, QuickSwitcherModal, setPromptBookmarks } from "./prompts";
import { currentDailyNoteTime, loadDailyNoteOptions, openAdjacentDailyNote } from "./core/daily-notes";
import { extractHeading, headingText, openExtractPrompt, openMergePrompt } from "./core/note-composer";
import { insertCurrentMoment } from "./core/templates";

interface Handler {
  /** Core plugin that must be enabled for the command to exist. */
  plugin?: string;
  /** Returns false when the command does not apply to the current context. */
  check?: () => boolean;
  run: () => unknown;
}

export interface CommandEnvironment {
  actions: AppActions;
  bookmarks: BookmarkStore;
  customHotkeys: Record<string, Hotkey[]>;
  /** Commands contributed by enabled core plugin modules; they take precedence over built-in handlers. */
  moduleCommands?: CorePluginCommand[];
}

const openPrompts = new Map<string, Modal>();
/** Commands of core plugins that are disabled by default, which the captured inventory does not list. */
const EXTRA_COMMANDS: CommandDefinition[] = [
  { id: "random-note", prefixKey: "plugins.random-note.name", nameKey: "plugins.random-note.action-open" },
  { id: "workspaces:load", prefixKey: "plugins.workspaces.name", nameKey: "plugins.workspaces.action-load-layout" },
  { id: "workspaces:save", prefixKey: "plugins.workspaces.name", nameKey: "plugins.workspaces.action-save" },
  { id: "workspaces:save-and-load", prefixKey: "plugins.workspaces.name", nameKey: "plugins.workspaces.action-save-and-load-layout" },
  { id: "workspaces:open-modal", prefixKey: "plugins.workspaces.name", nameKey: "plugins.workspaces.action-manage-layouts" },
  { id: "zk-prefixer", prefixKey: "plugins.unique-note-creator.name", nameKey: "plugins.unique-note-creator.action-create-note" },
  { id: "insert-unique-link", prefixKey: "plugins.unique-note-creator.name", nameKey: "plugins.unique-note-creator.action-add-link" },
  { id: "footnotes:open", prefixKey: "plugins.footnotes-pane.name", nameKey: "plugins.footnotes-pane.action-show" },
  { id: "slides:start", prefixKey: "plugins.slides.name", nameKey: "plugins.slides.action-start" },
  { id: "audio-recorder:start", prefixKey: "plugins.audio-recorder.name", nameKey: "plugins.audio-recorder.action-start" },
  { id: "audio-recorder:stop", prefixKey: "plugins.audio-recorder.name", nameKey: "plugins.audio-recorder.action-stop" },
];

/** Registers every inventory command that has an implementation; returns an unregister function. */
export function registerCoreCommands({ actions, bookmarks, customHotkeys, moduleCommands = [] }: CommandEnvironment): () => void {
  const { app, workspace, config } = actions;
  setPromptBookmarks(bookmarks);
  void loadDailyNoteOptions(actions);
  const active = () => workspace.activeLeaf;
  const activeFile = () => actions.activeFile();
  const hasFile = () => !!activeFile();
  const mainLeaf = () => { const leaf = active(); return leaf && !isInSidebar(leaf) ? leaf : workspace.getMostRecentLeaf(); };
  const isInSidebar = (leaf: WorkspaceLeaf) => { for (let node = leaf.parent?.parent ?? null; node; node = node.parent as typeof node) if (node === workspace.leftSplit || node === workspace.rightSplit) return true; return false; };
  const markdown = () => { const view = mainLeaf()?.view; return view instanceof MarkdownView ? view : null; };
  const siblings = () => (mainLeaf()?.parent?.children ?? []) as WorkspaceLeaf[];
  const cycleTab = (offset: number) => { const leaf = mainLeaf(), tabs = siblings(); if (leaf && tabs.length) workspace.setActiveLeaf(tabs[(tabs.indexOf(leaf) + offset + tabs.length) % tabs.length]); };
  const toggle = (key: "showRibbon" | "readableLineLength" | "showLineNumber" | "spellcheck" | "showInlineTitle" | "showViewHeader") => () => config.set(key, !config.get(key));
  const setMode = (view: MarkdownView, mode: "source" | "preview") => { view.setMode(mode); workspace.notifyLayoutChange(); };
  const tabGroups = () => { const groups: WorkspaceTabs[] = []; workspace.iterateRootLeaves(leaf => { if (leaf.parent && !groups.includes(leaf.parent)) groups.push(leaf.parent); }); return groups; };
  const focusGroup = (offset: number) => { const groups = tabGroups(), current = mainLeaf()?.parent; const index = current ? groups.indexOf(current) : -1; const next = groups[(index + offset + groups.length) % groups.length]; if (next?.activeLeaf) workspace.setActiveLeaf(next.activeLeaf); };
  const searchQuery = () => String((workspace.getLeavesOfType("search")[0]?.getViewState().state as { query?: unknown } | undefined)?.query ?? "").trim();
  const webView = () => { const view = mainLeaf()?.view; return view instanceof WebViewerView ? view : null; };
  const zoom = (delta: number | null) => () => config.set("zoomLevel", delta === null ? 0 : Math.max(-3, Math.min(5, config.get("zoomLevel") + delta)));

  const sourceEditor = () => { const { view, editor } = app.getCommandContext(); return (view as { getMode?(): string } | undefined)?.getMode?.() === "source" ? editor as import("../compat/editor").Editor : null; };
  /** The Markdown editor a command acts on, with its file: only while the note is being edited. */
  const editing = () => { const file = activeFile(), editor = sourceEditor(); return file && editor ? { editor, file } : null; };
  /** One prompt of a kind at a time, as in the reference: its hotkey does not stack a second one. */
  const openPrompt = (kind: string, create: () => Modal) => {
    const previous = openPrompts.get(kind);
    if (previous) {
      const owner = previous.containerEl.ownerDocument.defaultView;
      if (previous.containerEl.isConnected && !owner?.closed) return;
      // A renderer can outlive a popup document's unload event. Close the
      // stale modal so its keymap scope and singleton guard are both released.
      previous.close();
    }
    const modal = create();
    openPrompts.set(kind, modal);
    modal.setCloseCallback(() => { if (openPrompts.get(kind) === modal) openPrompts.delete(kind); }).open();
  };
  const headingAtCursor = () => { const editor = sourceEditor(); const match = editor && /^(#{1,6})\s+(.*?)\s*$/.exec(editor.getLine(editor.getCursor().line)); return match ? { level: match[1].length, text: match[2] } : null; };
  const exportPdf = async () => {
    const file = activeFile()!, holder = document.body.createDiv({ cls: "print" });
    const preview = holder.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    try {
      preview.createEl("h1", { text: file.basename });
      renderMarkdown((await app.vault.cachedRead(file)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""), preview.createDiv(), 0, { mermaid: app, strictLineBreaks: app.editorOptions.strictLineBreaks });
      await ipcRenderer.invoke("export-pdf", file.basename);
    } finally { holder.remove(); }
  };

  const handlers: Record<string, Handler> = {
    "workspace:toggle-stacked-tabs": { check: () => !!mainLeaf()?.parent, run: () => { const tabs = mainLeaf()!.parent!; tabs.isStacked = !tabs.isStacked; workspace.notifyLayoutChange(); workspace.requestSaveLayout(); } },
    "app:show-release-notes": { run: () => window.open("https://obsidian.md/changelog/") },
    "app:open-sandbox-vault": { run: () => { ipcRenderer.sendSync("sandbox"); } },
    "app:migrate-frontmatter": { run: () => new FrontmatterMigrationModal(app).open() },
    "backlink:toggle-backlinks-in-document": { plugin: "backlink", check: () => !!markdown(), run: () => { const view = markdown()!; view.setShowBacklinks(!view.showBacklinks); } },
    "editor:toggle-fold-properties": { check: () => !!markdown(), run: () => markdown()!.containerEl.querySelectorAll<HTMLElement>(".metadata-container .metadata-properties-heading").forEach(heading => { if (heading.offsetParent) heading.click(); }) },
    "publish:publish-file": { plugin: "publish", check: hasFile, run: () => workspace.trigger("publish:open") },
    "sync:view-version-history": { plugin: "sync", check: hasFile, run: () => actions.openSettings("sync") },
    "sync:open-sync-view": { plugin: "sync", run: () => actions.openSettings("sync") },
    "sync:open-sync-log": { plugin: "sync", run: () => actions.openSettings("sync") },
    "webviewer:open": { plugin: "webviewer", run: async () => { const leaf = workspace.getLeaf("tab"); await leaf.setViewState({ type: "webviewer", active: true, state: { url: String((await readCorePluginData(config.configDir, "webviewer")).homepage ?? "about:blank") } }); workspace.setActiveLeaf(leaf); webView()?.focusAddressBar(); } },
    "webviewer:open-history": { plugin: "webviewer", run: () => actions.revealLeafOfType("webviewer-history", "right") },
    "webviewer:toggle-reader-mode": { plugin: "webviewer", check: () => !!webView(), run: () => webView()!.toggleReaderMode() },
    "webviewer:focus-address-bar": { plugin: "webviewer", check: () => !!webView(), run: () => webView()!.focusAddressBar() },
    "webviewer:search": { plugin: "webviewer", check: () => !!webView(), run: () => webView()!.focusAddressBar() },
    "webviewer:zoom-in": { plugin: "webviewer", check: () => !!webView(), run: () => webView()!.zoom(0.5) },
    "webviewer:zoom-out": { plugin: "webviewer", check: () => !!webView(), run: () => webView()!.zoom(-0.5) },
    "webviewer:zoom-reset": { plugin: "webviewer", check: () => !!webView(), run: () => webView()!.zoom(null) },
    "webviewer:save-to-vault": { plugin: "webviewer", check: () => !!webView(), run: () => webView()!.saveToVault() },
    "canvas:jump-to-group": { plugin: "canvas", check: () => activeFile()?.extension === "canvas", run: () => workspace.trigger("canvas:command", "jump-to-group", activeFile()!.path) },
    "canvas:convert-to-file": { plugin: "canvas", check: () => activeFile()?.extension === "canvas", run: () => workspace.trigger("canvas:command", "convert-to-file", activeFile()!.path) },
    "canvas:export-as-image": { plugin: "canvas", check: () => activeFile()?.extension === "canvas", run: () => workspace.trigger("canvas:command", "export-as-image", activeFile()!.path) },
    "app:open-file": { run: async () => {
      // A file from outside the vault is copied in as an attachment and opened.
      const picked = await ipcRenderer.invoke("pick-file") as string | null; if (!picked) return;
      const inside = path.relative(actions.vaultPath, picked);
      if (inside && !inside.startsWith("..") && !path.isAbsolute(inside)) { await actions.openPath(inside.split(path.sep).join("/"), "tab"); return; }
      const target = await app.fileManager.getAvailablePathForAttachment(path.basename(picked), activeFile()?.path);
      const data = await fs.promises.readFile(picked);
      const created = await app.vault.createBinary(target, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      await actions.openFile(created, "tab");
    } },
    "editor:download-attachments": { check: () => !!sourceEditor() && hasFile(), run: async () => {
      const editor = sourceEditor()!, source = activeFile()!;
      const pattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, urls = [...new Set([...editor.getValue().matchAll(pattern)].map(match => match[2]))];
      if (!urls.length) return;
      const answer = await confirmDialog(app, { title: t("dialogue.label-download-attachments"), message: urls.slice(0, 12), cta: t("dialogue.label-download-attachments") });
      if (!answer.confirmed) return;
      const saved = new Map<string, string>();
      for (const url of urls) {
        try {
          const response = await fetch(url); if (!response.ok) continue;
          const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "attachment").replace(/[\\/:*?"<>|]/g, "-") || "attachment";
          const target = await app.fileManager.getAvailablePathForAttachment(/\.[a-z0-9]+$/i.test(name) ? name : name + ".png", source.path);
          const file = await app.vault.createBinary(target, await response.arrayBuffer());
          saved.set(url, app.fileManager.generateMarkdownLink(file, source.path));
        } catch (error) { console.warn("Could not download attachment", url, error); }
      }
      if (saved.size) editor.setValuePreservingSelection(editor.getValue().replace(pattern, (whole, _alt: string, url: string) => saved.has(url) ? "!" + saved.get(url)!.replace(/^!/, "") : whole));
    } },
    "workspace:undo-close-pane": { check: () => workspace.closedLeafStates.length > 0, run: () => workspace.reopenClosedLeaf() },
    "workspace:export-pdf": { check: () => !!markdown() && hasFile(), run: exportPdf },
    "window:toggle-always-on-top": { run: () => ipcRenderer.invoke("window:control", "always-on-top") },
    "theme:switch": { run: async () => {
      const themes = ["", ...await listThemes(config.configDir)];
      const picked = await chooseItem(app, themes, name => name || t("setting.appearance.label-default-theme"), { placeholder: t("plugins.custom-css.prompt-filter") });
      if (picked !== null) config.set("cssTheme", picked);
    } },
    "markdown:add-metadata-property": { check: () => !!markdown(), run: () => markdown()!.addProperty() },
    "markdown:add-alias": { check: () => !!markdown() && hasFile(), run: () => app.fileManager.processFrontMatter(activeFile()!, frontmatter => { if (!Array.isArray(frontmatter.aliases)) frontmatter.aliases = frontmatter.aliases ? [frontmatter.aliases] : []; }) },
    "markdown:clear-metadata-properties": { check: () => !!markdown() && hasFile() && !!app.metadataCache.getFileCache(activeFile()!)?.frontmatter, run: () => app.vault.process(activeFile()!, content => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")) },
    "note-composer:merge-file": { plugin: "note-composer", check: () => activeFile()?.extension === "md", run: () => openMergePrompt(actions, activeFile()!) },
    "note-composer:split-file": { plugin: "note-composer", check: () => !!editing()?.editor.somethingSelected(), run: () => { const { editor, file } = editing()!; openExtractPrompt(actions, editor, file); } },
    "note-composer:extract-heading": { plugin: "note-composer", check: () => { const target = editing(); return !!target && headingText(target.editor.getLine(target.editor.getCursor().line)) !== null; }, run: () => { const { editor, file } = editing()!; extractHeading(actions, editor, file); } },
    "bookmarks:bookmark-current-search": { plugin: "bookmarks", check: () => !!searchQuery(), run: () => bookmarks.add({ type: "search", query: searchQuery() }) },
    "bookmarks:bookmark-current-heading": { plugin: "bookmarks", check: () => !!headingAtCursor() && hasFile(), run: () => bookmarks.add({ type: "file", path: activeFile()!.path, subpath: "#" + headingAtCursor()!.text }) },
    "bookmarks:bookmark-current-section": { plugin: "bookmarks", check: () => !!sourceEditor() && hasFile() && !!sourceEditor()!.getLine(sourceEditor()!.getCursor().line).trim(), run: () => {
      const editor = sourceEditor()!; let line = editor.getCursor().line;
      // The block ends at the next blank line; reuse its id when it already has one.
      while (line < editor.lastLine() && editor.getLine(line + 1).trim()) line++;
      const text = editor.getLine(line), existing = /\s\^([A-Za-z0-9-]+)$/.exec(text);
      const id = existing?.[1] ?? Math.random().toString(36).slice(2, 8);
      if (!existing) editor.setLine(line, text + " ^" + id);
      bookmarks.add({ type: "file", path: activeFile()!.path, subpath: "#^" + id });
    } },
    "editor:save-file": { check: hasFile, run: () => (app.getCommandContext().view as { save?: () => unknown } | undefined)?.save?.() },
    "app:open-settings": { run: () => actions.openSettings() },
    "app:open-vault": { run: () => actions.openVaultChooser() },
    "app:open-help": { run: () => actions.openHelp() },
    "app:reload": { run: () => window.location.reload() },
    "app:show-debug-info": { run: () => new Notice(`${navigator.userAgent}`) },
    "app:toggle-ribbon": { run: toggle("showRibbon") },
    "app:toggle-left-sidebar": { run: () => actions.toggleSidebar("left") },
    "app:toggle-right-sidebar": { run: () => actions.toggleSidebar("right") },
    "app:toggle-default-new-pane-mode": { run: () => { const next = config.get("defaultViewMode") === "source" ? "preview" : "source"; config.set("defaultViewMode", next); new Notice(t(next === "preview" ? "interface.msg-switched-to-read" : "interface.msg-switched-to-edit")); } },
    "app:go-back": { check: () => !!mainLeaf()?.history.backHistory.length, run: () => mainLeaf()?.history.back() },
    "app:go-forward": { check: () => !!mainLeaf()?.history.forwardHistory.length, run: () => mainLeaf()?.history.forward() },
    "app:delete-file": { check: hasFile, run: () => actions.delete(activeFile()!) },
    "window:zoom-in": { run: zoom(1) }, "window:zoom-out": { run: zoom(-1) }, "window:reset-zoom": { run: zoom(null) },
    "editor:toggle-readable-line-length": { run: toggle("readableLineLength") },
    "editor:toggle-line-numbers": { run: toggle("showLineNumber") },
    "editor:toggle-spellcheck": { run: toggle("spellcheck") },
    "editor:toggle-source": { check: () => !!markdown(), run: () => { const view = markdown()!; view.setSourceMode(!view.sourceMode); workspace.notifyLayoutChange(); } },
    "markdown:toggle-preview": { check: () => !!markdown(), run: () => { const view = markdown()!; setMode(view, view.getMode() === "preview" ? "source" : "preview"); } },
    "workspace:toggle-pin": { check: () => !!mainLeaf(), run: () => mainLeaf()?.togglePinned() },
    "workspace:split-vertical": { check: () => !!mainLeaf(), run: () => workspace.duplicateLeaf(mainLeaf()!, "split", "vertical") },
    "workspace:split-horizontal": { check: () => !!mainLeaf(), run: () => workspace.duplicateLeaf(mainLeaf()!, "split", "horizontal") },
    "workspace:new-tab": { run: () => workspace.setActiveLeaf(workspace.getLeaf("tab")) },
    "workspace:new-window": { run: () => workspace.setActiveLeaf(workspace.getLeaf("window")) },
    "workspace:move-to-new-window": { check: () => !!mainLeaf(), run: () => { workspace.moveLeafToPopout(mainLeaf()!); } },
    "workspace:open-in-new-window": { check: hasFile, run: () => actions.openFile(activeFile()!, "window") },
    "workspace:close": { check: () => !!mainLeaf(), run: () => mainLeaf()?.detach() },
    "workspace:close-window": { run: () => window.close() },
    "workspace:close-others": { check: () => siblings().length > 1, run: () => { const leaf = mainLeaf(), others: WorkspaceLeaf[] = []; workspace.iterateRootLeaves(other => { if (other !== leaf && !other.pinned) others.push(other); }); others.forEach(other => other.detach()); } },
    "workspace:close-tab-group": { check: () => !!mainLeaf(), run: () => [...siblings()].forEach(leaf => { if (!leaf.pinned) leaf.detach(); }) },
    "workspace:close-others-tab-group": { check: () => siblings().length > 1, run: () => { const leaf = mainLeaf(); [...siblings()].forEach(other => { if (other !== leaf && !other.pinned) other.detach(); }); } },
    "workspace:next-tab": { check: () => siblings().length > 1, run: () => cycleTab(1) },
    "workspace:previous-tab": { check: () => siblings().length > 1, run: () => cycleTab(-1) },
    "workspace:goto-last-tab": { run: () => { const leaf = siblings().at(-1); if (leaf) workspace.setActiveLeaf(leaf); } },
    "editor:focus-top": { check: () => tabGroups().length > 1, run: () => focusGroup(-1) }, "editor:focus-left": { check: () => tabGroups().length > 1, run: () => focusGroup(-1) },
    "editor:focus-bottom": { check: () => tabGroups().length > 1, run: () => focusGroup(1) }, "editor:focus-right": { check: () => tabGroups().length > 1, run: () => focusGroup(1) },
    "app:switch-vault": { run: () => actions.openVaultChooser() },
    "app:open-another-vault": { run: () => actions.openVaultChooser() },
    "theme:toggle-light-dark": { run: () => config.set("theme", document.body.classList.contains("theme-dark") ? "moonstone" : "obsidian") },
    "app:increase-font-size": { run: () => config.set("baseFontSize", Math.min(30, config.get("baseFontSize") + 1)) },
    "app:decrease-font-size": { run: () => config.set("baseFontSize", Math.max(10, config.get("baseFontSize") - 1)) },
    "insert-current-date": { plugin: "templates", check: () => !!actions.activeEditor(), run: () => insertCurrentMoment(actions, "date") },
    "insert-current-time": { plugin: "templates", check: () => !!actions.activeEditor(), run: () => insertCurrentMoment(actions, "time") },
    "backlink:open-backlinks": { plugin: "backlink", check: hasFile, run: () => actions.revealLeafOfType("backlink", "right") },
    "outgoing-links:open-for-current": { plugin: "outgoing-link", check: hasFile, run: () => actions.revealLeafOfType("outgoing-link", "right") },
    "outline:open-for-current": { plugin: "outline", check: hasFile, run: () => actions.revealLeafOfType("outline", "right") },
    "properties:open-local": { plugin: "properties", check: hasFile, run: () => actions.revealLeafOfType("file-properties", "right") },
    "publish:view-changes": { plugin: "publish", run: () => workspace.trigger("publish:open") },
    "sync:setup": { plugin: "sync", run: () => actions.openSettings("sync") },
    "file-recovery:open": { plugin: "file-recovery", run: () => actions.openSettings("file-recovery") },
    "workspace:edit-file-title": { check: hasFile, run: () => {
      const title = mainLeaf()?.containerEl.querySelector<HTMLElement>(".inline-title[contenteditable='true']");
      if (!title) { workspace.trigger("file-explorer:rename", activeFile()!.path); void actions.revealLeafOfType("file-explorer", "left"); return; }
      title.focus();
      const range = title.ownerDocument.createRange(); range.selectNodeContents(title);
      const selection = title.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    } },
    "workspace:copy-path": { check: hasFile, run: () => actions.copyVaultPath(activeFile()!) },
    "workspace:copy-full-path": { check: hasFile, run: () => actions.copyFullPath(activeFile()!) },
    "workspace:copy-url": { check: hasFile, run: () => actions.copyUrl(activeFile()!) },
    "workspace:show-trash": { check: () => config.get("trashOption") === "local", run: () => { const trash = actions.vault.getAbstractFileByPath(".trash"); if (trash) actions.showInFolder(trash); } },
    "file-explorer:new-file": { run: () => actions.newNote() },
    "file-explorer:new-file-in-current-tab": { run: () => actions.newNote(null, false) },
    "file-explorer:new-file-in-new-pane": { run: () => actions.newNote(null, "split") },
    "file-explorer:new-folder": { plugin: "file-explorer", run: () => actions.newFolder() },
    "file-explorer:open": { plugin: "file-explorer", run: () => actions.revealLeafOfType("file-explorer", "left") },
    "file-explorer:reveal-active-file": { plugin: "file-explorer", check: hasFile, run: async () => { await actions.revealLeafOfType("file-explorer", "left"); workspace.trigger("file-explorer:reveal", activeFile()!.path); } },
    "file-explorer:move-file": { plugin: "file-explorer", check: hasFile, run: () => actions.moveTo(activeFile()!) },
    "file-explorer:duplicate-file": { plugin: "file-explorer", check: hasFile, run: async () => { await actions.openFile(await actions.duplicate(activeFile()!), "tab"); } },
    "open-with-default-app:open": { check: hasFile, run: () => actions.openWithDefaultApp(activeFile()!) },
    "open-with-default-app:show": { check: hasFile, run: () => actions.showInFolder(activeFile()!) },
    "global-search:open": { plugin: "global-search", run: () => actions.openSearch(actions.activeEditor()?.getSelection() || undefined) },
    "switcher:open": { plugin: "switcher", run: () => openPrompt("switcher", () => new QuickSwitcherModal(app, actions, bookmarks)) },
    "command-palette:open": { plugin: "command-palette", run: () => openPrompt("command-palette", () => new CommandPaletteModal(app, actions)) },
    "graph:open": { plugin: "graph", run: () => actions.openGraph() },
    "graph:open-local": { plugin: "graph", check: hasFile, run: async () => {
      const leaf = workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: "localgraph", active: true, state: { file: activeFile()!.path } });
    } },
    "graph:animate": { plugin: "graph", check: () => ["graph", "localgraph"].includes(active()?.view.getViewType() ?? ""), run: () => workspace.trigger("graph:animate") },
    "canvas:new-file": { plugin: "canvas", run: () => actions.newCanvas() },
    "bases:new-file": { plugin: "bases", run: () => actions.newBase() },
    "daily-notes": { plugin: "daily-notes", run: () => actions.openDailyNote() },
    "daily-notes:goto-prev": { plugin: "daily-notes", check: () => currentDailyNoteTime(actions) !== null, run: () => openAdjacentDailyNote(actions, -1) },
    "daily-notes:goto-next": { plugin: "daily-notes", check: () => currentDailyNoteTime(actions) !== null, run: () => openAdjacentDailyNote(actions, 1) },
    "insert-template": { plugin: "templates", run: () => actions.insertTemplate() },
    "backlink:open": { plugin: "backlink", run: () => actions.revealLeafOfType("backlink", "right") },
    "outgoing-links:open": { plugin: "outgoing-link", run: () => actions.revealLeafOfType("outgoing-link", "right") },
    "tag-pane:open": { plugin: "tag-pane", run: () => actions.revealLeafOfType("tag", "right") },
    "outline:open": { plugin: "outline", run: () => actions.revealLeafOfType("outline", "right") },
    "properties:open": { plugin: "properties", run: () => actions.revealLeafOfType("all-properties", "right") },
    "bookmarks:open": { plugin: "bookmarks", run: () => actions.revealLeafOfType("bookmarks", "left") },
    "bookmarks:bookmark-current-view": { plugin: "bookmarks", check: () => hasFile() && !bookmarks.findFile(activeFile()!.path), run: () => bookmarks.add({ type: "file", path: activeFile()!.path }) },
    "bookmarks:unbookmark-current-view": { plugin: "bookmarks", check: () => hasFile() && !!bookmarks.findFile(activeFile()!.path), run: () => { const location = bookmarks.findFile(activeFile()!.path); if (location) bookmarks.remove(location); } },
    "bookmarks:bookmark-all-tabs": { plugin: "bookmarks", run: () => {
      const items: Array<{ type: string; path: string }> = [];
      workspace.iterateRootLeaves(leaf => { const file = leaf.view instanceof FileView ? leaf.view.file : null; if (file) items.push({ type: "file", path: file.path }); });
      if (items.length) bookmarks.add({ type: "group", title: t("plugins.bookmarks.placeholder-bookmark-group"), items });
    } },
  };
  for (let index = 1; index <= 8; index++) handlers[`workspace:goto-tab-${index}`] = { check: () => siblings().length >= index, run: () => workspace.setActiveLeaf(siblings()[index - 1]) };

  for (const command of moduleCommands) handlers[command.id] = { check: command.check, run: command.run };

  const ids: string[] = [];
  const register = (definition: CommandDefinition, handler: Handler) => {
    app.commands.add({
      id: definition.id, name: commandName(definition), hotkeys: customHotkeys[definition.id] ?? definition.hotkeys,
      checkCallback: checking => {
        if (handler.check && !handler.check()) return false;
        if (!checking) actions.run(handler.run);
        return true;
      },
    });
    ids.push(definition.id);
  };
  for (const definition of [...COMMAND_INVENTORY, ...EXTRA_COMMANDS]) {
    const handler = handlers[definition.id];
    if (handler && (!handler.plugin || actions.corePlugins.isEnabled(handler.plugin))) register(definition, handler);
  }
  const unregisterEditor = registerEditorCommands(app, customHotkeys);
  return () => { ids.forEach(id => app.commands.remove(id)); unregisterEditor(); };
}
