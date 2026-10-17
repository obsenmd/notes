import { process } from "../../../platforms/platform";
import { mountMarkdownEditor } from "../../compat/codemirror-host";
import { Keymap } from "../../compat/commands";
import { Component } from "../../compat/component";
import { Editor } from "../../compat/editor";
import { MarkdownRenderer } from "../../compat/markdown";
import { MarkdownView } from "../../compat/markdown-view";
import { PropertiesEditor } from "../../compat/properties-editor";
import { debounce, setIcon, setTooltip } from "../../compat/utilities";
import type { TFile } from "../../compat/vault";
import { ItemView, type WorkspaceLeaf } from "../../compat/workspace";
import { t } from "../../i18n";
import type { CorePluginContext, CorePluginModule } from "./types";

const VIEW_TYPE = "footnotes";

interface Footnote {
  id: string;
  /** The definition's text, with the continuation indent removed. */
  text: string;
  /** Offsets of the whole definition, from its `[^id]:` marker to the end of its last line. */
  from: number; to: number;
  line: number;
  /** Offset of the first reference, or -1 when nothing refers to it. */
  firstRef: number;
}

/** Footnote definitions of a note, ordered by their first reference; unreferenced ones come last. */
export function parseFootnotes(source: string): Footnote[] {
  const lines = source.split("\n"), notes = new Map<string, Footnote>(), refs = new Map<string, number>();
  const continues = (index: number) => /^(?: {4}|\t)/.test(lines[index] ?? "");
  let offset = 0, fence: string | null = null;
  const starts = lines.map(line => { const start = offset; offset += line.length + 1; return start; });
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    for (const ref of line.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) if (!refs.has(ref[1])) refs.set(ref[1], starts[index] + ref.index);
    const definition = /^( {0,3})\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(line);
    if (!definition) continue;
    const body = [definition[3].replace(/\r$/, "")];
    let last = index;
    for (let next = index + 1; next < lines.length; next++) {
      if (continues(next)) { for (let blank = last + 1; blank < next; blank++) body.push(""); body.push(lines[next].replace(/^(?: {4}|\t)/, "").replace(/\r$/, "")); last = next; }
      else if (lines[next].trim()) break;
    }
    if (!notes.has(definition[2])) notes.set(definition[2], { id: definition[2], text: body.join("\n"), from: starts[index] + definition[1].length, to: starts[last] + lines[last].replace(/\r$/, "").length, line: index, firstRef: -1 });
    index = last;
  }
  const list = [...notes.values()];
  for (const note of list) note.firstRef = refs.get(note.id) ?? -1;
  const rank = (note: Footnote) => note.firstRef < 0 ? Infinity : note.firstRef;
  return list.sort((a, b) => rank(a) === rank(b) ? 0 : rank(a) - rank(b));
}

const serialize = (note: Pick<Footnote, "id">, text: string, indent: string) => `[^${note.id}]: ${text.replace(/\n/g, "\n" + indent)}`;

/** One footnote: its number and its text, rendered until a click turns it into an editor. */
class FootnoteItem extends Component {
  readonly containerEl: HTMLElement;
  private readonly idEl: HTMLElement;
  private readonly embedEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly sizerEl: HTMLElement;
  private readonly editorContainerEl: HTMLElement;
  private renderGeneration = 0;
  private editing: { el: HTMLElement; editor: Editor; destroy(): void } | null = null;
  text = "";

  constructor(private readonly view: FootnotesView, private readonly file: TFile, readonly id: string) {
    super();
    const doc = view.containerEl.ownerDocument;
    this.containerEl = doc.createElement("div"); this.containerEl.className = "footnote-list-item";
    const row = this.containerEl.createDiv("footnote");
    this.idEl = row.createDiv("footnote-id");
    this.embedEl = row.createDiv("footnote-content").createDiv("markdown-embed");
    this.embedEl.dataset.type = "footnote";
    const previewContent = this.embedEl.createDiv("markdown-embed-content node-insert-event");
    this.previewEl = previewContent.createDiv("markdown-preview-view markdown-rendered node-insert-event show-indentation-guide allow-fold-headings allow-fold-lists show-properties");
    this.sizerEl = this.previewEl.createDiv("markdown-preview-sizer markdown-preview-section");
    const pusher = this.sizerEl.createDiv("markdown-preview-pusher");
    Object.assign(pusher.style, { width: "1px", height: "0.1px", marginBottom: "0px" });
    const header = this.sizerEl.createDiv("mod-header mod-ui");
    header.createDiv("inline-title");
    const properties = new PropertiesEditor({ onChange: () => {} }, doc);
    properties.containerEl.addClass("is-collapsed"); properties.containerEl.style.display = "none";
    properties.containerEl.querySelector(".metadata-properties-heading")?.addClass("is-collapsed");
    properties.containerEl.querySelector(".collapse-indicator")?.addClass("is-collapsed");
    header.append(properties.containerEl);
    this.editorContainerEl = this.embedEl.createDiv("markdown-embed-content node-insert-event");
    const link = this.embedEl.createDiv("markdown-embed-link");
    setIcon(link, "lucide-maximize-2");
    setTooltip(link, t("editor.link-popover.tooltip-open-link"));
    link.addEventListener("click", event => { event.stopPropagation(); void view.openDefinition(file, id, event); });
    link.addEventListener("auxclick", event => { if (event.button === 1) { event.preventDefault(); void view.openDefinition(file, id, event); } });
    this.containerEl.addEventListener("click", event => this.edit(event));
  }

  get isEditing(): boolean { return !!this.editing; }
  override onunload(): void { this.editing?.destroy(); this.editing = null; this.containerEl.remove(); }

  update(index: number, note: Footnote): void {
    this.idEl.toggleClass("mod-no-occurrences", note.firstRef < 0);
    const label = String(index + 1);
    if (this.idEl.textContent !== label) this.idEl.setText(label);
    if (this.text === note.text && this.sizerEl.querySelector(":scope > .el-p, :scope > .el-div")) return;
    this.text = note.text;
    const generation = ++this.renderGeneration, staging = this.previewEl.ownerDocument.createElement("div");
    void MarkdownRenderer.render(this.view.app, note.text, staging, this.file.path, this).then(() => {
      if (generation !== this.renderGeneration || !this.containerEl.isConnected) return;
      for (const child of [...this.sizerEl.children]) if (!child.classList.contains("mod-header") && !child.classList.contains("markdown-preview-pusher")) child.remove();
      for (const child of [...staging.children]) this.sizerEl.createDiv(`el-${child.tagName.toLowerCase()}`).append(child);
    }).catch(error => console.error(error));
  }

  private edit(event?: MouseEvent): void {
    if (this.editing) return;
    const { containerEl, previewEl } = this, doc = containerEl.ownerDocument, win = doc.defaultView ?? window;
    const options = this.view.app.editorOptions;
    const el = this.editorContainerEl.createDiv(`markdown-source-view cm-s-obsidian mod-cm6 node-insert-event${options.livePreview === false ? "" : " is-live-preview"}`);
    const editor = new Editor(this.text);
    const mounted = mountMarkdownEditor(el, editor, { ...options, showLineNumber: false, readableLineLength: false, scrollPastEnd: false });
    const finish = () => { if (this.editing?.editor === editor) this.showPreview(true); };
    const outside = (event: MouseEvent) => { if (!containerEl.contains(event.target as Node)) finish(); };
    const keys = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); } };
    win.addEventListener("click", outside);
    el.addEventListener("keydown", keys, true);
    this.editing = { el, editor, destroy: () => { win.removeEventListener("click", outside); el.removeEventListener("keydown", keys, true); mounted.destroy(); el.remove(); } };
    previewEl.style.display = "none";
    containerEl.addClass("is-editing");
    const offset = event && editor.cm?.posAtCoords({ x: event.clientX, y: event.clientY });
    editor.setCursor(editor.offsetToPos(typeof offset === "number" ? offset : this.text.length));
    editor.focus();
  }

  /** Leaves the editor; a changed text is written back to the note first. */
  showPreview(save: boolean): void {
    const editing = this.editing;
    if (!editing) return;
    const text = editing.editor.getValue();
    this.editing = null;
    editing.destroy();
    this.previewEl.style.display = "";
    this.containerEl.removeClass("is-editing");
    if (save && text !== this.text) void this.view.saveFootnote(this.file, this.id, text).catch(error => console.error(error));
    else this.view.requestUpdate();
  }
}

/** Sidebar list of the active note's footnotes. */
class FootnotesView extends ItemView {
  navigation = false;
  private listEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  /** The note whose footnotes are listed (a field named `file` would be read by the sidebar host). */
  private current: TFile | null = null;
  private readonly items = new Map<string, FootnoteItem>();
  readonly requestUpdate = debounce(() => { void this.update().catch(error => console.error(error)); }, 10, true);
  private readonly requestEditorUpdate = debounce(() => { void this.update().catch(error => console.error(error)); }, 300, true);

  constructor(leaf: WorkspaceLeaf, private readonly context: CorePluginContext) { super(leaf); }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return t("plugins.footnotes-pane.short-name"); }
  getIcon() { return "lucide-file-signature"; }

  protected onOpen(): void {
    const wrapper = this.contentEl.createDiv("footnotes-view");
    this.listEl = wrapper.createDiv("footnotes-list"); this.listEl.style.display = "none";
    this.emptyEl = wrapper.createDiv({ cls: "pane-empty", text: t("plugins.footnotes-pane.label-no-footnotes") }); this.emptyEl.style.display = "none";
    const { workspace, metadataCache, vault } = this.app;
    const follow = () => { if (!this.leaf.pinned) this.setFile(workspace.getActiveFile() as TFile | null); };
    this.registerEvent(workspace.on("file-open", follow));
    this.registerEvent(workspace.on("active-leaf-change", follow));
    this.registerEvent(metadataCache.on("resolve", (file: unknown) => { if (file === this.current) this.requestUpdate(); }));
    this.registerEvent(workspace.on("editor-change", () => this.requestEditorUpdate()));
    this.registerEvent(vault.on("delete", file => { if (file === this.current) this.setFile(null); }));
    workspace.onLayoutReady(follow);
  }

  protected onClose(): void {
    this.requestUpdate.cancel(); this.requestEditorUpdate.cancel();
    this.clearItems();
    this.contentEl.querySelector(":scope > .footnotes-view")?.remove();
  }

  private setFile(file: TFile | null): void {
    const next = file?.extension === "md" ? file : null;
    if (next === this.current) return;
    this.clearItems();
    this.current = next;
    this.requestUpdate();
  }

  private clearItems(): void {
    for (const item of this.items.values()) this.removeChild(item);
    this.items.clear();
  }

  private editorOf(file: TFile): Editor | null {
    let editor: Editor | null = null;
    this.app.workspace.iterateAllLeaves(leaf => { if (!editor && leaf.view instanceof MarkdownView && leaf.view.file === file) editor = leaf.view.editor; });
    return editor;
  }
  private async read(file: TFile): Promise<string> { return this.editorOf(file)?.getValue() ?? await this.app.vault.cachedRead(file); }

  private async update(): Promise<void> {
    const file = this.current, { listEl, emptyEl, items } = this;
    if (!listEl) return;
    const notes = file ? parseFootnotes(await this.read(file)) : [];
    if (file !== this.current) return;
    listEl.style.display = notes.length ? "" : "none";
    emptyEl.style.display = notes.length ? "none" : "";
    if (!notes.length || !file) { this.clearItems(); return; }
    // An open editor is left alone; the list catches up when it closes.
    for (const item of items.values()) if (item.isEditing) return;
    const elements = notes.map((note, index) => {
      let item = items.get(note.id);
      if (!item) items.set(note.id, item = this.addChild(new FootnoteItem(this, file, note.id)));
      item.update(index, note);
      return item.containerEl;
    });
    elements.forEach((el, index) => { if (listEl.children[index] !== el) listEl.insertBefore(el, listEl.children[index] ?? null); });
    const ids = new Set(notes.map(note => note.id));
    for (const [id, item] of [...items]) if (!ids.has(id)) { items.delete(id); this.removeChild(item); }
  }

  /** Replaces a footnote's text in the note, through its open editor when there is one. */
  async saveFootnote(file: TFile, id: string, text: string): Promise<void> {
    const options = this.app.editorOptions, indent = options.useTab === false ? " ".repeat(options.tabSize ?? 4) : "\t";
    const splice = (source: string): { from: number; to: number; insert: string } | null => {
      const note = parseFootnotes(source).find(candidate => candidate.id === id);
      return note && note.text !== text ? { from: note.from, to: note.to, insert: serialize(note, text, indent) } : null;
    };
    const editor = this.editorOf(file);
    if (editor) {
      const change = splice(editor.getValue());
      if (change) editor.replaceRange(change.insert, editor.offsetToPos(change.from), editor.offsetToPos(change.to));
    } else await this.app.vault.process(file, source => { const change = splice(source); return change ? source.slice(0, change.from) + change.insert + source.slice(change.to) : source; });
    this.requestUpdate();
  }

  /** Opens the note with the cursor on the footnote's definition. */
  async openDefinition(file: TFile, id: string, event: MouseEvent): Promise<void> {
    const leaf = await this.context.actions.openFile(file, Keymap.isModEvent(event));
    const editor = leaf.view instanceof MarkdownView ? leaf.view.editor : null;
    const note = editor && parseFootnotes(editor.getValue()).find(candidate => candidate.id === id);
    if (!editor || !note) return;
    const position = { line: note.line, ch: 0 };
    editor.setCursor(position);
    editor.scrollIntoView({ from: position, to: position }, true);
  }
}

export const footnotesPlugin: CorePluginModule = {
  id: "footnotes",
  views: context => ({ [VIEW_TYPE]: leaf => new FootnotesView(leaf, context) }),
  commands: ({ actions }) => [{ id: "footnotes:open", run: () => actions.revealLeafOfType(VIEW_TYPE, "right") }],
};
