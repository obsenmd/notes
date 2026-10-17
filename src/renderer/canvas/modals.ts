import { process } from "../../../platforms/platform";
import type { App } from "../../compat/plugin";
import { FuzzySuggestModal, SuggestModal, prepareFuzzySearch, renderMatches, type SearchResult } from "../../compat/suggest";
import { Modal } from "../../compat/ui";
import { parseYaml, setIcon } from "../../compat/utilities";
import { TFile } from "../../compat/vault";
import { t } from "../../i18n";
import { validateFileName } from "../actions";
import { hotkeyParts, modKeyName } from "../hotkeys";
import type { Modifier } from "../../compat/commands";
import { newId, type CanvasNode } from "./data";
import { div, el, TextPromptModal } from "./dom";

const isMac = typeof process !== "undefined" && process.platform === "darwin";
export const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "mov", "mkv"];
const EMBEDDABLE = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, "pdf"]);

/** Keys in the help dialog: modifiers by their platform name, gestures by their translated name. */
function keyLabel(keys: string[]): string {
  const gestures: Record<string, string> = { Scroll: "obsen.canvas.key-scroll", Drag: "obsen.canvas.key-drag", Click: "obsen.canvas.key-click", "Drag to select": "obsen.canvas.key-drag-to-select" };
  const modifiers = keys.filter(key => ["Mod", "Ctrl", "Alt", "Shift", "Meta"].includes(key)) as Modifier[], rest = keys.filter(key => !modifiers.includes(key as Modifier));
  const names = rest.map(key => gestures[key] ? t(gestures[key]) : hotkeyParts({ modifiers: [], key: key === "Space" ? " " : key })[0]);
  const parts = [...(modifiers.length ? hotkeyParts({ modifiers, key: "x" }).slice(0, -1) : []), ...names];
  return parts.join(isMac ? " " : " + ");
}
export const modDragLabel = () => keyLabel(["Mod", "Drag"]);

export class CanvasHelpModal extends Modal {
  constructor(app: App, wheelZooms: boolean) {
    super(app);
    this.modalEl.classList.add("mod-canvas-help"); this.setTitle(t("plugins.canvas.label-canvas-help"));
    const list = div("canvas-help", this.contentEl);
    const row = (label: string, keys: string[][]) => {
      const item = div("canvas-instruction", list); div("canvas-instruction-label", item, label);
      const desc = div("canvas-instruction-desc", item);
      for (const combination of keys) el("span", "setting-hotkey", keyLabel(combination), desc);
    };
    let pan = [["Scroll"]], panHorizontal = [["Shift", "Scroll"]], zoom = [["Mod", "Scroll"], ["Space", "Scroll"]];
    if (wheelZooms) { [pan, zoom] = [zoom, pan]; panHorizontal = [["Mod", "Shift", "Scroll"], ["Shift", "Space", "Scroll"]]; }
    row(t("plugins.canvas.label-pan"), [["Space", "Drag"], ...pan]);
    row(t("plugins.canvas.label-pan-horizontal"), panHorizontal);
    row(t("plugins.canvas.label-zoom"), zoom);
    row(t("plugins.canvas.action-zoom-to-fit"), [["Shift", "1"]]);
    row(t("plugins.canvas.action-zoom-to-selection"), [["Shift", "2"]]);
    row(t("plugins.canvas.label-select-all"), [["Mod", "A"]]);
    row(t("plugins.canvas.label-add-remove-selection"), [["Shift", "Click"], ["Shift", "Drag to select"]]);
    row(t("plugins.canvas.action-create-with-size"), [["Mod", "Drag to select"]]);
    row(t("plugins.canvas.label-clone-card"), [[isMac ? "Alt" : "Ctrl", "Drag"]]);
    row(t("plugins.canvas.label-constrain-movement-axis"), [["Shift", "Drag"]]);
    row(t("plugins.canvas.label-disable-drag-snapping"), [[isMac ? "Ctrl" : "Alt"]]);
    row(t("plugins.canvas.label-remove-card"), [["Backspace"], ["Delete"]]);
    row(t("setting.mobile-toolbar.option-undo"), [["Mod", "Z"]]);
    row(t("setting.mobile-toolbar.option-redo"), [["Mod", "Y"], ["Mod", "Shift", "Z"]]);
  }
}
export const modScrollHint = () => `${modKeyName} + ${t("plugins.canvas.label-scroll-to-zoom")}`;

export function promptUrl(app: App, value: string, onSave: (url: string) => void): void {
  new TextPromptModal(app, t("plugins.canvas.label-enter-url"), value, onSave, url => { try { new URL(url); return ""; } catch { return t("obsen.canvas.invalid-url"); } }).open();
}
export function promptFileName(app: App, onSave: (name: string) => void): void {
  new TextPromptModal(app, t("dialogue.label-rename-file-generic"), t("plugins.file-explorer.label-untitled-file"), onSave, name => validateFileName(name) ?? "").open();
}

/** Creates the note a link text points at, in the folder new notes go to. */
export async function createNoteFromLinktext(app: App, linktext: string, sourcePath: string): Promise<TFile> {
  const clean = linktext.split("#")[0].replace(/\.md$/i, "");
  const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
  const parent = folder ? app.vault.getFolderByPath(folder) ?? await app.vault.createFolder(folder) : app.fileManager.getNewFileParent(sourcePath);
  return app.fileManager.createNewMarkdownFile(parent, clean.slice(clean.lastIndexOf("/") + 1));
}

interface FileItem { file: TFile | null; text: string; match: SearchResult | null }
export interface FilePickerOptions { markdown?: boolean; documents?: boolean; images?: boolean; attachments?: boolean; create?: boolean; emptyText?: string; chooseLabel?: string; sourcePath?: string; onClose?: () => void }
/** Chooses a vault file for a card; the kinds of file offered depend on what the card may hold. */
export class CanvasFilePicker extends SuggestModal<FileItem> {
  private readonly allTypes: boolean;
  constructor(app: App, private readonly options: FilePickerOptions, private readonly onChoose: (file: TFile) => void) {
    super(app);
    this.limit = 20;
    this.allTypes = (app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("showUnsupportedFiles") === true;
    this.emptyStateText = options.emptyText ?? t("plugins.quick-switcher.label-no-note-create-new");
    this.setPlaceholder(t("plugins.canvas.prompt-start-search"));
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.quick-switcher.instruction-navigate") },
      { command: "↵", purpose: t(options.chooseLabel ?? "plugins.quick-switcher.instruction-open") },
      ...(this.canCreate ? [{ command: "shift ↵", purpose: t("plugins.quick-switcher.instruction-create") }] : []),
      { command: "esc", purpose: t("plugins.quick-switcher.instruction-dismiss") },
    ]);
    this.inputEl.addEventListener("keydown", event => {
      if (event.key === "Enter" && event.shiftKey && this.canCreate && this.inputEl.value.trim()) { event.preventDefault(); event.stopImmediatePropagation(); this.selectSuggestion({ file: null, text: this.inputEl.value.trim(), match: null }, event); }
    }, true);
  }
  private get canCreate(): boolean { return this.options.create === true && this.options.markdown !== false; }
  private accepts(file: TFile): boolean {
    const extension = file.extension.toLowerCase(), { markdown = true, documents = true, images = true, attachments = true } = this.options;
    if (extension === "md") return markdown;
    if (extension === "canvas" || extension === "base") return documents;
    if (IMAGE_EXTENSIONS.includes(extension)) return images;
    return attachments && (this.allTypes || EMBEDDABLE.has(extension));
  }
  private display(file: TFile): string { return file.extension === "md" ? file.path.slice(0, -3) : file.path; }
  getSuggestions(query: string): FileItem[] {
    const trimmed = query.trim();
    if (!trimmed) {
      const recent = (this.app.workspace as unknown as { getLastOpenFiles?(): string[] }).getLastOpenFiles?.() ?? [];
      return recent.map(path => this.app.vault.getAbstractFileByPath(path)).filter((file): file is TFile => file instanceof TFile && this.accepts(file)).map(file => ({ file, text: this.display(file), match: null }));
    }
    const search = prepareFuzzySearch(trimmed);
    return this.app.vault.getFiles().filter(file => this.accepts(file)).flatMap(file => { const text = this.display(file), match = search(text); return match ? [{ file, text, match }] : []; })
      .sort((a, b) => b.match!.score - a.match!.score || a.text.length - b.text.length);
  }
  override onNoSuggestion(): void {
    const query = this.inputEl.value.trim();
    if (query && this.canCreate) { this.chooser.setSuggestions([{ file: null, text: query, match: null }]); return; }
    this.chooser.setSuggestions(null);
    this.chooser.addMessage(query ? this.emptyStateText : t("setting.third-party-plugin.label-no-recent-files-found"));
  }
  renderSuggestion(value: FileItem, row: HTMLElement): void {
    row.classList.add("mod-complex");
    const title = div("suggestion-title", div("suggestion-content", row)), aux = div("suggestion-aux", row);
    if (!value.file) { title.textContent = value.text; el("span", "suggestion-action", t("interface.label-enter-to-create"), aux); return; }
    renderMatches(title, value.text, value.match?.matches);
    el("span", "suggestion-flair", undefined, aux);
  }
  onChooseSuggestion(value: FileItem): void {
    if (value.file) { this.onChoose(value.file); return; }
    void createNoteFromLinktext(this.app, value.text, this.options.sourcePath ?? "").then(this.onChoose);
  }
  override onClose(): void { super.onClose(); this.options.onClose?.(); }
}
export const pickNote = (app: App, sourcePath: string, onChoose: (file: TFile) => void, onClose?: () => void) => new CanvasFilePicker(app, { images: false, attachments: false, create: true, sourcePath, onClose }, onChoose).open();
export const pickMedia = (app: App, onChoose: (file: TFile) => void) => new CanvasFilePicker(app, { markdown: false, emptyText: t("plugins.canvas.label-no-media") }, onChoose).open();
export const pickAttachment = (app: App, sourcePath: string, onChoose: (file: TFile) => void) => new CanvasFilePicker(app, { markdown: false, documents: false, create: true, sourcePath }, onChoose).open();
export const pickImage = (app: App, onChoose: (file: TFile) => void) => new CanvasFilePicker(app, { markdown: false, documents: false, attachments: false, emptyText: t("plugins.canvas.label-no-images"), chooseLabel: "plugins.quick-switcher.instruction-select" }, onChoose).open();

interface SectionItem { subpath: string; text: string; level?: number; match: SearchResult | null; whole?: boolean; insertAt?: number }
/** "Narrow to heading..." / "Narrow to block...": chooses the part of a note a card shows. */
export class NarrowPicker extends SuggestModal<SectionItem> {
  private content = "";
  constructor(app: App, private readonly file: TFile, private readonly mode: "heading" | "block", private readonly onChoose: (subpath: string) => void) {
    super(app);
    this.emptyStateText = t("plugins.canvas.label-no-section-found");
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.templates.instruction-navigate") },
      { command: "↵", purpose: t(mode === "block" ? "plugins.canvas.instruction-narrow-block" : "plugins.canvas.instruction-narrow-heading") },
      { command: "esc", purpose: t("plugins.templates.instruction-dismiss") },
    ]);
    this.setPlaceholder(t("plugins.canvas.prompt-to-narrow"));
  }
  override async onOpen(): Promise<void> { this.content = await this.app.vault.cachedRead(this.file); super.onOpen(); }
  private items(): SectionItem[] {
    const cache = this.app.metadataCache.getFileCache(this.file);
    if (this.mode === "heading") return (cache?.headings ?? []).map(heading => ({ subpath: "#" + heading.heading, text: heading.heading, level: heading.level, match: null }));
    return (cache?.sections ?? []).filter(section => !["yaml", "thematicBreak"].includes(section.type)).map(section => {
      const source = this.content.slice(section.position.start.offset, section.position.end.offset), id = section.id ?? /\s\^([\w-]+)\s*$/.exec(source)?.[1];
      return { subpath: id ? "#^" + id : "", text: source.replace(/\s+/g, " ").trim().slice(0, 200), match: null, insertAt: id ? undefined : section.position.end.offset };
    }).filter(item => item.text);
  }
  getSuggestions(query: string): SectionItem[] {
    const trimmed = query.trim().replace(/^[#^]+/, ""), items = this.items();
    if (!trimmed) return [{ subpath: "", text: t("plugins.canvas.label-no-narrow"), match: null, whole: true }, ...items];
    const search = prepareFuzzySearch(trimmed);
    return items.flatMap(item => { const match = search(item.text); return match ? [{ ...item, match }] : []; }).sort((a, b) => b.match!.score - a.match!.score);
  }
  renderSuggestion(value: SectionItem, row: HTMLElement): void {
    row.classList.add("mod-complex");
    renderMatches(div("suggestion-title", div("suggestion-content", row)), value.text, value.match?.matches);
    const aux = div("suggestion-aux", row);
    if (value.level) el("span", "suggestion-flair", "H" + value.level, aux);
  }
  onChooseSuggestion(value: SectionItem): void {
    if (value.whole || value.subpath) { this.onChoose(value.subpath); return; }
    // A block without an id gets one, written at the end of the block.
    const id = newId().slice(0, 6), at = value.insertAt ?? this.content.length;
    void this.app.vault.process(this.file, current => current.slice(0, at) + " ^" + id + current.slice(at)).then(() => this.onChoose("#^" + id));
  }
}

interface BaseViewItem { name: string; type?: string }
/** "Pin view...": chooses the view of a base a card shows. */
export class BaseViewPicker extends FuzzySuggestModal<BaseViewItem | null> {
  constructor(app: App, private readonly views: Array<BaseViewItem | null>, private readonly current: string, private readonly onChoose: (name: string) => void) {
    super(app);
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.command-palette.instruction-navigate") },
      { command: "↵", purpose: t("plugins.command-palette.instruction-use") },
      { command: "esc", purpose: t("plugins.command-palette.instruction-dismiss") },
    ]);
  }
  static async open(app: App, file: TFile, current: string, onChoose: (name: string) => void): Promise<void> {
    let views: BaseViewItem[] = [];
    try { const parsed = parseYaml(await app.vault.cachedRead(file)) as { views?: BaseViewItem[] } | null; if (Array.isArray(parsed?.views)) views = parsed.views.filter(view => view && typeof view.name === "string"); } catch { /* an unreadable base offers only its default view */ }
    new BaseViewPicker(app, [null, ...views], current, onChoose).open();
  }
  getItems() { return this.views; }
  getItemText(item: BaseViewItem | null) { return item ? item.name : ""; }
  override renderSuggestion(value: { item: BaseViewItem | null; match: SearchResult }, row: HTMLElement): void {
    row.classList.add("mod-complex");
    const icon = div("suggestion-icon", row), title = div("suggestion-title", el("span", "suggestion-content", undefined, row));
    if (!value.item) { title.textContent = t("plugins.canvas.label-show-default-view"); return; }
    renderMatches(title, value.item.name, value.match.matches);
    if (value.item.name === this.current) el("span", "flair toolbar-badge", t("setting.appearance.label-currently-active"), el("span", "suggestion-aux", undefined, row));
    setIcon(div("suggestion-flair", icon), value.item.type === "cards" ? "lucide-layout-grid" : value.item.type === "list" ? "lucide-list" : value.item.type === "map" ? "lucide-map" : "lucide-table");
  }
  onChooseItem(item: BaseViewItem | null) { this.onChoose(item ? item.name : ""); }
}

/** "Jump to group": lists the canvas's groups. */
export class GroupPicker extends FuzzySuggestModal<CanvasNode> {
  constructor(app: App, private readonly groups: () => CanvasNode[], private readonly onChoose: (group: CanvasNode) => void) {
    super(app);
    this.emptyStateText = t("plugins.canvas.msg-no-groups-found");
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.templates.instruction-navigate") },
      { command: "↵", purpose: t("plugins.canvas.instruction-jump-to-group") },
      { command: "esc", purpose: t("plugins.templates.instruction-dismiss") },
    ]);
    this.setPlaceholder(t("plugins.canvas.action-jump-to-group"));
  }
  getItems() { return this.groups(); }
  getItemText(group: CanvasNode) { return group.label || t("plugins.canvas.label-untitled-group"); }
  onChooseItem(group: CanvasNode) { this.onChoose(group); }
}
