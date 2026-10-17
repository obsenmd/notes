import { process } from "../../../platforms/platform";
import { Keymap } from "../../compat/commands";
import type { Editor } from "../../compat/editor";
import type { CachedMetadata, HeadingCache, ReferenceCache } from "../../compat/metadata-cache";
import type { App } from "../../compat/plugin";
import { Notice, type Menu } from "../../compat/ui";
import { stripHeading } from "../../compat/utilities";
import { TFile, type TFolder } from "../../compat/vault";
import { confirmDialog } from "../../controllers/dialogs";
import { t } from "../../i18n";
import type { AppActions } from "../actions";
import { readCorePluginData, writeCorePluginData } from "../core-plugins";
import { FileSuggestModal, type FileSuggestion } from "../prompts";
import { expandTemplate, insertIntoFile, templateFile } from "./templates";
import type { CorePluginModule } from "./types";

/** The "Note composer" core plugin: merge a note into another, or move a selection or heading section out into one. */

type InsertMode = "append" | "prepend";
export interface TextEdit { start: number; end: number; text: string }
interface LinkEdit extends TextEdit { original: string }

const isMac = typeof process !== "undefined" && process.platform === "darwin";
const options = (actions: AppActions) => readCorePluginData(actions.config.configDir, "note-composer").catch(() => ({} as Record<string, unknown>));
/** The text of the first heading in `text`, or null. */
export const headingText = (text: string): string | null => /^#{1,6} (.*)/m.exec(text)?.[1] ?? null;
const splitLink = (link: string) => { const hash = link.indexOf("#"); return hash < 0 ? { path: link, subpath: "" } : { path: link.slice(0, hash), subpath: link.slice(hash) }; };
const references = (cache: CachedMetadata | null): ReferenceCache[] => [...(cache?.links ?? []), ...(cache?.embeds ?? [])];

export function applyEdits(text: string, edits: TextEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

/** Where a `#heading`, `#parent#child` or `#^block` subpath starts in the note the cache describes. */
export function subpathOffset(cache: CachedMetadata, subpath: string): number | null {
  const parts = subpath.split("#").filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1 && parts[0].startsWith("^")) {
    const id = parts[0].slice(1).toLowerCase(), key = Object.keys(cache.blocks ?? {}).find(name => name.toLowerCase() === id);
    return key ? cache.blocks![key].position.start.offset : null;
  }
  let matched = 0, level = 0;
  for (const heading of cache.headings ?? []) {
    if (heading.level <= level) { matched = 0; level = 0; }
    if (heading.level > level && stripHeading(heading.heading) === stripHeading(parts[matched])) { matched++; level = heading.level; if (matched === parts.length) return heading.position.start.offset; }
  }
  return null;
}

/** The same link, pointing at `link` instead: the alias, the embed mark and the link style are kept. */
export function retargetLink(original: string, link: string): string {
  const wiki = /^(!?\[\[)[^\]|]*/.exec(original);
  if (wiki) return wiki[1] + link + original.slice(wiki[0].length);
  const close = original.lastIndexOf("](");
  return close < 0 ? original : `${original.slice(0, close + 2)}${/[()<>]/.test(link) ? `<${link}>` : link.replace(/ /g, "%20")})`;
}

function resolve(app: App, linkpath: string, sourcePath: string): TFile | null {
  const found = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath), file = found ? app.vault.getAbstractFileByPath(found.path) : null;
  return file instanceof TFile ? file : null;
}
const linktextFor = (app: App, file: TFile, sourcePath: string) => app.metadataCache.fileToLinktext(file, sourcePath, true);

/** Links inside the text being moved keep pointing where they did, as seen from the note it moves to. */
function rewriteMovedLinks(app: App, text: string, cache: CachedMetadata, source: TFile, destination: TFile, from: number, to: number): string {
  const edits: TextEdit[] = [];
  for (const reference of references(cache)) {
    const start = reference.position.start.offset, end = reference.position.end.offset;
    if (start < from || end > to || text.slice(start - from, end - from) !== reference.original) continue;
    const { path, subpath } = splitLink(reference.link);
    let link: string | undefined, own = !path;
    if (path) {
      const target = resolve(app, path, source.path);
      if (!target) continue;
      if (target === source) own = true; else link = linktextFor(app, target, destination.path) + subpath;
    }
    if (own) {
      if (!subpath) continue;
      const at = subpathOffset(cache, subpath);
      if (at === null) continue;
      link = at >= from && at <= to ? subpath : linktextFor(app, source, destination.path) + subpath;
    }
    if (link !== undefined && reference.link !== link) edits.push({ start: start - from, end: end - from, text: retargetLink(reference.original, link) });
  }
  return edits.length ? applyEdits(text, edits) : text;
}

/** Links that stay behind in the source but point at a heading or block that is moving. */
function staleSourceLinks(app: App, data: string, cache: CachedMetadata, source: TFile, destination: TFile, from: number, to: number): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const reference of references(cache)) {
    const start = reference.position.start.offset, end = reference.position.end.offset;
    if ((start >= from && end <= to) || data.slice(start, end) !== reference.original) continue;
    const { path, subpath } = splitLink(reference.link);
    if ((path && resolve(app, path, source.path) !== source) || !subpath) continue;
    const at = subpathOffset(cache, subpath);
    if (at === null || at < from || at > to) continue;
    const link = linktextFor(app, destination, source.path) + subpath;
    if (reference.link !== link) edits.push({ start, end, text: retargetLink(reference.original, link) });
  }
  return edits;
}

/** Links from other notes to `source` that `moves(subpath)` says must now lead to `destination`. */
function backlinkEdits(app: App, source: TFile, destination: TFile, moves: (subpath: string) => boolean): Map<TFile, LinkEdit[]> {
  const result = new Map<TFile, LinkEdit[]>();
  for (const file of app.vault.getMarkdownFiles()) {
    if (file === source) continue;
    const edits: LinkEdit[] = [];
    for (const reference of references(app.metadataCache.getFileCache(file))) {
      const { path, subpath } = splitLink(reference.link);
      if (!path || resolve(app, path, file.path) !== source || !moves(subpath)) continue;
      const link = (file === destination ? "" : linktextFor(app, destination, file.path)) + subpath;
      if (!link) continue;
      edits.push({ start: reference.position.start.offset, end: reference.position.end.offset, original: reference.original, text: retargetLink(reference.original, link) });
    }
    if (edits.length) result.set(file, edits);
  }
  return result;
}

/** Rewrites the collected backlinks, after the same "Update links" prompt a rename gets. */
async function updateBacklinks(app: App, changes: Map<TFile, LinkEdit[]>): Promise<void> {
  const links = [...changes.values()].reduce((sum, edits) => sum + edits.length, 0), host = app.fileManager.linkUpdateHost;
  if (!links || (host?.confirm && !await host.confirm(links, changes.size))) return;
  for (const [file, edits] of changes) {
    if (!app.vault.getAbstractFileByPath(file.path)) continue;
    await app.vault.process(file, data => {
      // Positions hold unless the note itself just changed (the merge target); then each link is found by its text.
      if (edits.every(edit => data.slice(edit.start, edit.end) === edit.original)) return applyEdits(data, edits);
      for (const edit of edits) data = data.split(edit.original).join(edit.text);
      return data;
    });
  }
  host?.done?.(links, changes.size);
}

/** Wraps moved text in the configured template: `{{content}}`, `{{fromTitle}}`, `{{newTitle}}`, `{{date}}`, `{{time}}`. */
export async function applyComposerTemplate(actions: AppActions, content: string, fromTitle: string, newTitle: string): Promise<string> {
  const template = templateFile(actions.app, (await options(actions)).template);
  if (!template) return content;
  if (!template.file) { new Notice(t("plugins.note-composer.msg-fail-to-fetch-template", { template: template.path })); return content; }
  let text = await actions.vault.cachedRead(template.file);
  if (!text) return content;
  if (!text.includes("{{content}}")) text += "\n\n{{content}}";
  return expandTemplate(text, { fromTitle, newTitle, content });
}

/** Moves all of `source` into `destination`, deletes it, and points its backlinks at the destination. */
export async function mergeFile(actions: AppActions, destination: TFile, source: TFile, mode: InsertMode = "append"): Promise<void> {
  const { app } = actions;
  const content = await applyComposerTemplate(actions, await app.vault.read(source), source.basename, destination.basename);
  const backlinks = backlinkEdits(app, source, destination, () => true);
  await insertIntoFile(app, destination, content, mode);
  await app.fileManager.trashFile(source);
  await updateBacklinks(app, backlinks);
}

/** Moves `[from, to)` of the note in `editor` into `destination`, leaving a link, an embed or nothing in its place. */
export async function extractSection(actions: AppActions, editor: Editor, source: TFile, destination: TFile, from: number, to: number, mode: InsertMode = "append"): Promise<void> {
  const { app } = actions, data = editor.getValue(), cache = app.metadataCache.getFileCache(source);
  let moved = data.substring(from, to);
  if (cache) moved = rewriteMovedLinks(app, moved, cache, source, destination, from, to);
  const content = await applyComposerTemplate(actions, moved, source.basename, destination.basename);
  const edits = cache ? staleSourceLinks(app, data, cache, source, destination, from, to) : [];
  const replacement = (await options(actions)).replacementText, link = app.fileManager.generateMarkdownLink(destination, source.path);
  edits.push({ start: from, end: to, text: replacement === "embed" ? `!${link}` : replacement === "none" ? "" : link });
  const backlinks = cache ? backlinkEdits(app, source, destination, subpath => { const at = subpath ? subpathOffset(cache, subpath) : null; return at !== null && at >= from && at <= to; }) : new Map<TFile, LinkEdit[]>();
  await insertIntoFile(app, destination, content, mode);
  if (editor.getValue() !== data) return;
  for (const edit of edits.sort((a, b) => b.start - a.start)) editor.replaceRange(edit.text, editor.offsetToPos(edit.start), editor.offsetToPos(edit.end));
  await updateBacklinks(app, backlinks);
}

/** The section of the heading on `line`: from the heading to the next one of the same or a higher level. */
export function headingRange(cache: CachedMetadata | null, line: number, data: string): { heading: string; startOffset: number; endOffset: number } | null {
  const headings: HeadingCache[] = cache?.headings ?? [], at = headings.findIndex(heading => heading.position.start.line === line);
  if (at < 0) return null;
  const current = headings[at], next = headings.slice(at + 1).find(heading => heading.level <= current.level);
  let endOffset = next ? next.position.start.offset : data.length;
  if (data.charAt(endOffset - 1) === "\n") endOffset--;
  return { heading: current.heading.trim(), startOffset: current.position.start.offset, endOffset };
}

async function createNote(app: App, parent: TFolder | null, name: string): Promise<TFile> {
  if (/[\\:*?"<>|]/.test(name)) throw new Error(t("plugins.file-explorer.msg-invalid-characters") + '\\ / : * ? " < > |');
  const clean = name.trim().replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
  const filePath = app.vault.getAvailablePath((parent && !parent.isRoot() ? `${parent.path}/` : "") + (clean || t("plugins.file-explorer.label-untitled-file")), "md");
  const folders = filePath.split("/").slice(0, -1);
  for (let depth = 1; depth <= folders.length; depth++) { const folder = folders.slice(0, depth).join("/"); if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder); }
  return app.vault.create(filePath, "");
}
/** A linktext with a folder is a path from the vault root; a bare name goes where new notes go. */
const createFromLinktext = (app: App, linktext: string, sourcePath: string) => createNote(app, linktext.includes("/") ? null : app.fileManager.getNewFileParent(sourcePath, linktext), linktext);

const modEnter = isMac ? "cmd ↵" : "ctrl ↵";

class MergeModal extends FileSuggestModal {
  constructor(actions: AppActions, private readonly currentFile: TFile) {
    super(actions.app, actions);
    this.emptyStateText = t("plugins.note-composer.label-no-files");
    this.shouldShowNonImageAttachments = false; this.shouldShowImages = false; this.shouldShowNonAttachments = false;
    this.setPlaceholder(t("plugins.note-composer.prompt-select-file-to-merge"));
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.note-composer.instruction-navigate") },
      { command: "↵", purpose: t("plugins.note-composer.instruction-merge") },
      { command: modEnter, purpose: t("plugins.note-composer.instruction-create-new") },
      { command: "shift ↵", purpose: t("plugins.note-composer.instruction-merge-at-top") },
      { command: "esc", purpose: t("plugins.note-composer.instruction-dismiss") },
    ]);
    this.scope.register(["Shift"], "Enter", event => { this.selectActiveSuggestion(event); return false; });
    this.scope.register(["Mod"], "Enter", event => { this.selectActiveSuggestion(event); return false; });
  }
  onChooseSuggestion(value: FileSuggestion | null, event: MouseEvent | KeyboardEvent): void {
    const { actions, app, currentFile } = this, input = this.inputEl.value;
    actions.run(async () => {
      let destination: TFile | null = null;
      if (Keymap.isModifier(event, "Mod") || !value || value.type === "unresolved") {
        const name = value?.type === "unresolved" ? value.linktext : input;
        try { destination = await createNote(app, app.fileManager.getNewFileParent(currentFile.path, name), name); } catch (error) { console.error(error); new Notice(t("obsen.notes.error-create")); return; }
      } else if (value.type === "bookmark") { const file = value.item.type === "file" ? app.vault.getAbstractFileByPath(value.item.path ?? "") : null; if (file instanceof TFile) destination = file; }
      else destination = value.file;
      if (!destination || destination === currentFile) return;
      const data = await options(actions);
      if (data.askBeforeMerging !== false) {
        const answer = await confirmDialog(app, {
          title: t("plugins.note-composer.label-merge-file"), message: [t("plugins.note-composer.label-confirm-file-merge", { file: currentFile.basename, destination: destination.basename })],
          cta: t("plugins.note-composer.button-merge"), destructive: true, checkbox: t("dialogue.label-do-not-ask-again"),
        });
        if (!answer.confirmed) return;
        if (answer.checked) await writeCorePluginData(actions.config.configDir, "note-composer", { ...data, askBeforeMerging: false });
      }
      await mergeFile(actions, destination, currentFile, event.shiftKey ? "prepend" : "append");
      await actions.openFile(destination);
    });
  }
}

class ExtractModal extends FileSuggestModal {
  private readonly defaultValue: string;
  constructor(actions: AppActions, private readonly editor: Editor, private readonly currentFile: TFile, heading?: string) {
    super(actions.app, actions);
    this.allowCreateNewFile = true; this.shouldShowUnresolved = true;
    this.shouldShowNonImageAttachments = false; this.shouldShowImages = false; this.shouldShowNonAttachments = false;
    this.defaultValue = heading || headingText(editor.getSelection().split("\n")[0]) || "";
    this.setPlaceholder(t("plugins.note-composer.prompt-select-file-to-merge"));
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.note-composer.instruction-navigate") },
      { command: "↵", purpose: t("plugins.note-composer.instruction-append") },
      { command: modEnter, purpose: t("plugins.note-composer.instruction-create-new") },
      { command: "shift ↵", purpose: t("plugins.note-composer.instruction-prepend") },
      { command: "esc", purpose: t("plugins.note-composer.instruction-dismiss") },
    ]);
    this.scope.register(["Shift"], "Enter", event => { this.selectActiveSuggestion(event); return false; });
    this.scope.register(["Mod"], "Enter", event => { this.selectActiveSuggestion(event); return false; });
  }
  override onOpen(): void { super.onOpen(); this.inputEl.value = this.defaultValue; this.updateSuggestions(); }
  onChooseSuggestion(value: FileSuggestion | null, event: MouseEvent | KeyboardEvent): void {
    const { actions, app, editor, currentFile } = this, input = this.inputEl.value;
    actions.run(async () => {
      let destination: TFile | null = null;
      try {
        if (Keymap.isModifier(event, "Mod") || !value) destination = await createFromLinktext(app, input, currentFile.path);
        else if (value.type === "unresolved") destination = await createFromLinktext(app, value.linktext, currentFile.path);
        else if (value.type === "file" || value.type === "alias") destination = value.file;
      } catch (error) { console.error(error); new Notice(t("obsen.notes.error-create")); return; }
      if (!destination || destination === currentFile) return;
      await extractSection(actions, editor, currentFile, destination, editor.posToOffset(editor.getCursor("from")), editor.posToOffset(editor.getCursor("to")), event.shiftKey ? "prepend" : "append");
    });
  }
}

export function openMergePrompt(actions: AppActions, file: TFile): void { new MergeModal(actions, file).open(); }
export function openExtractPrompt(actions: AppActions, editor: Editor, file: TFile, heading?: string): void { new ExtractModal(actions, editor, file, heading).open(); }

/** Selects the section of the heading under the cursor and asks where to move it. */
export function extractHeading(actions: AppActions, editor: Editor, file: TFile): void {
  const range = headingRange(actions.app.metadataCache.getFileCache(file), editor.getCursor().line, editor.getValue());
  if (!range) { new Notice(t("plugins.note-composer.msg-fail-to-find-heading")); return; }
  editor.setSelection(editor.offsetToPos(range.startOffset), editor.offsetToPos(range.endOffset));
  openExtractPrompt(actions, editor, file, range.heading);
}

/** Context menu entries: "Merge entire file with..." on Markdown files, the two extract actions in the editor. */
export const noteComposerPlugin: CorePluginModule = {
    id: "note-composer",
    install({ app, actions }) {
      const refs = [
        app.workspace.on("file-menu", (...data: unknown[]) => {
          const [menu, file, source] = data as [Menu, unknown, unknown];
          if (source === "link-context-menu" || !(file instanceof TFile) || file.extension !== "md") return;
          menu.addItem(item => item.setSection("action").setTitle(t("plugins.note-composer.action-merge-file")).setIcon("lucide-git-merge").onClick(() => openMergePrompt(actions, file)));
        }),
        app.workspace.on("editor-menu", (...data: unknown[]) => {
          const [menu, editor, info] = data as [Menu, Editor, { file?: TFile | null } | null];
          const file = info?.file;
          if (!file) return;
          if (editor.getSelection().trim()) menu.addItem(item => item.setTitle(t("plugins.note-composer.command-split-file")).setIcon("lucide-git-branch-plus").setSection("selection").onClick(() => openExtractPrompt(actions, editor, file)));
          if (headingText(editor.getLine(editor.getCursor().line)) !== null) menu.addItem(item => item.setTitle(t("plugins.note-composer.command-extract-heading")).setSection("action").setIcon("lucide-git-branch-plus").onClick(() => extractHeading(actions, editor, file)));
        }),
      ];
      return () => { for (const ref of refs) app.workspace.offref(ref); };
    },
};
