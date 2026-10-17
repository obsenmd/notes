import { process } from "../../platforms/platform";
import { bindEditorFields } from "./api-extras";
import { foldable, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import { t } from "../i18n";
import { showEditorContextMenu } from "./editor-menu";
import { Keymap } from "./commands";
import { mountMarkdownEditor, type MarkdownEditorOptions } from "./codemirror-host";
import { EditorDocumentSearch, PreviewDocumentSearch } from "./document-search";
import { Editor } from "./editor";
import { TextFileView } from "./file-views";
import { getRenderedSectionInformation, MarkdownPreviewRenderer, MarkdownRenderer } from "./markdown";
import { renderMarkdown } from "./markdown-parser";
import { setHeadingFold, setListFold } from "./markdown-folding";
import { frontmatterRange, refreshMarkdownDecorations, type LivePreviewHost } from "./obsidian-markdown";
import type { App } from "./plugin";
import { PropertiesEditor } from "./properties-editor";
import { assignPropertyType, readPropertyTypes } from "./property-types";
import { Menu, Notice } from "./ui";
import { setIcon } from "./utilities";
import { TFile } from "./vault";
import type { ViewStateResult, WorkspaceLeaf } from "./workspace";

export type MarkdownViewModeType = "source" | "preview";
interface FoldInfo { folds: {from: number; to: number}[]; lines: number }

export interface MarkdownSubView {
  isScrolling?: boolean;
  getScroll(): number;
  applyScroll(scroll: number): void;
  get(): string;
  set(data: string, clear: boolean): void;
  getFoldInfo(): FoldInfo;
  applyFoldInfo(info: FoldInfo | null): void;
}

/** Source editor subview used by the desktop Markdown view. */
export class MarkdownEditView implements MarkdownSubView {
  isScrolling = false;
  applyingFold = false;
  constructor(readonly view: MarkdownView) {}
  get app(): App { return this.view.app; }
  get file(): TFile { if (!this.view.file) throw new Error("Markdown editor has no active file."); return this.view.file; }
  get(): string { return this.view.editor.getValue(); }
  set(data: string, clear: boolean): void { this.view.setViewData(data, clear); }
  clear(): void { this.view.clear(); }
  getSelection(): string { return this.view.editor.getSelection(); }
  getFoldInfo(): FoldInfo {
    const cm = this.view.editor.cm;
    if (!cm) return {folds: [], lines: this.view.editor.lineCount()};
    const folds: FoldInfo["folds"] = [];
    for (const iterator = foldedRanges(cm.state).iter(); iterator.value; iterator.next()) folds.push({from: cm.state.doc.lineAt(iterator.from).number - 1, to: cm.state.doc.lineAt(iterator.to).number - 1});
    return {folds, lines: cm.state.doc.lines};
  }
  applyFoldInfo(info: FoldInfo | null): void {
    const cm = this.view.editor.cm;
    if (!cm || (info && info.lines !== cm.state.doc.lines)) return;
    const effects = [];
    for (const iterator = foldedRanges(cm.state).iter(); iterator.value; iterator.next()) effects.push(unfoldEffect.of({from: iterator.from, to: iterator.to}));
    for (const fold of info?.folds ?? []) {
      if (fold.from < 0 || fold.from >= cm.state.doc.lines) continue;
      const start = cm.state.doc.line(fold.from + 1), end = cm.state.doc.line(Math.max(1, Math.min(fold.to + 1, cm.state.doc.lines)));
      const range = foldable(cm.state, start.from, start.to);
      if (range) effects.push(foldEffect.of({from: range.from, to: Math.max(range.to, end.to)}));
    }
    if (effects.length) {
      this.applyingFold = true;
      try { cm.dispatch({effects}); }
      finally { this.applyingFold = false; }
    }
  }
  getScroll(): number {
    const cm = this.view.editor.cm;
    if (!cm) return 0;
    const inset = cm.contentDOM.offsetTop, top = cm.scrollDOM.scrollTop;
    const block = cm.lineBlockAtHeight(Math.max(0, top - inset));
    const first = cm.state.doc.lineAt(block.from).number - 1;
    const count = cm.state.doc.lineAt(block.to).number - first;
    const height = block.height + (first === 0 ? inset : 0);
    const offset = top - block.top - (first === 0 ? 0 : inset);
    return first + count * Math.max(0, offset) / Math.max(1, height);
  }
  applyScroll(scroll: number): void {
    const cm = this.view.editor.cm;
    if (!cm || !Number.isFinite(scroll)) return;
    const position = Math.max(0, Math.min(scroll, cm.state.doc.lines - 0.99));
    const line = cm.state.doc.line(Math.floor(position) + 1);
    const measure = () => {
      const block = cm.lineBlockAt(line.from), first = cm.state.doc.lineAt(block.from).number - 1;
      const count = cm.state.doc.lineAt(block.to).number - first, inset = cm.contentDOM.offsetTop;
      return block.top + (first === 0 ? 0 : inset) + (position - first) * (block.height + (first === 0 ? inset : 0)) / count;
    };
    if (cm.visibleRanges.some(range => range.from <= line.from && line.from <= range.to)) { const top = measure(); this.isScrolling = Math.abs(cm.scrollDOM.scrollTop - top) > 0.5; cm.scrollDOM.scrollTop = top; }
    else {
      this.view.editor.scrollIntoView({ from: {line: line.number - 1, ch: 0}, to: {line: line.number - 1, ch: 0} });
      cm.requestMeasure({read: () => undefined, write: () => cm.requestMeasure({read: measure, write: top => {this.isScrolling = Math.abs(cm.scrollDOM.scrollTop - top) > 0.5; cm.scrollDOM.scrollTop = top;}})});
    }
  }
}

/** Rendered Markdown subview: sections are wrapped in `el-*` blocks inside the preview sizer. */
export class MarkdownPreviewView extends MarkdownRenderer implements MarkdownSubView {
  isScrolling = false;
  private data = "";
  private renderGeneration = 0;
  private renderedSections: HTMLElement[] = [];
  /** @internal Elements that frame the rendered sections. */
  headerEl: HTMLElement | null = null;
  footerEl: HTMLElement | null = null;
  constructor(readonly view: MarkdownView, public containerEl: HTMLElement) {
    super(containerEl); this.app = view.app;
    this.registerDomEvent(containerEl, "markdown-fold-change", () => {
      if (view.file) {
        const info = this.getFoldInfo();
        view.app.saveLocalStorage(`note-fold-${view.file.path}`, info.folds.length ? info : null);
      }
    });
  }
  getFoldInfo(): FoldInfo {
    const folds: FoldInfo["folds"] = [];
    const sections = this.renderedSections.map(el => ({el, info: el.firstElementChild && getRenderedSectionInformation(el.firstElementChild as HTMLElement)}));
    for (let index = 0; index < sections.length; index++) {
      const {el, info} = sections[index];
      if (!info) continue;
      if (el.classList.contains("is-collapsed")) folds.push({from: info.lineStart, to: sections[index + 1]?.info?.lineStart !== undefined ? sections[index + 1].info!.lineStart - 1 : info.lineEnd + 1});
    }
    for (const {el, info} of sections) {
      if (!info) continue;
      for (const item of el.querySelectorAll<HTMLElement>("li.is-collapsed[data-line]")) {
        const line = Number(item.dataset.line), next = item.nextElementSibling as HTMLElement | null;
        const end = next ? Number(next.dataset.line) - 1 : info.lineEnd;
        if (Number.isFinite(line) && Number.isFinite(end)) folds.push({from: info.lineStart + line, to: end});
      }
    }
    return {folds, lines: this.data.split("\n").length};
  }
  applyFoldInfo(info: FoldInfo | null): void {
    if (info && info.lines !== this.data.split("\n").length) return;
    const starts = new Set(info?.folds.map(fold => fold.from));
    // Expand first so every section is back in document order before applying nested folds.
    for (const section of this.renderedSections) {
      const heading = section.querySelector<HTMLElement>(".heading-collapse-indicator");
      if (heading) setHeadingFold(heading, false);
    }
    for (const section of [...this.renderedSections].reverse()) {
      const metadata = section.firstElementChild && getRenderedSectionInformation(section.firstElementChild as HTMLElement);
      if (!metadata) continue;
      const heading = section.querySelector<HTMLElement>(".heading-collapse-indicator");
      if (heading) setHeadingFold(heading, starts.has(metadata.lineStart));
      for (const indicator of section.querySelectorAll<HTMLElement>(".list-collapse-indicator")) {
        setListFold(indicator, starts.has(metadata.lineStart + Number(indicator.parentElement?.dataset.line)));
      }
    }
  }
  get file(): TFile { if (!this.view.file) throw new Error("Markdown preview has no active file."); return this.view.file; }
  get(): string { return this.data; }
  set(data: string, clear: boolean): void { this.data = data; if (clear) this.containerEl.parentElement && (this.containerEl.parentElement.scrollTop = 0); void this.rerender(); }
  clear(): void { this.renderGeneration++; this.data = ""; this.removeSections(); }
  private scrollSections() {
    const viewport = this.containerEl.parentElement;
    if (!viewport) return [];
    const elements = [...this.containerEl.children] as HTMLElement[];
    const blocks = elements.flatMap(el => {
      const child = el.firstElementChild as HTMLElement | null, info = child && getRenderedSectionInformation(child);
      return info ? [{el, start: info.lineStart, end: info.lineEnd + 1}] : [];
    });
    const origin = viewport.getBoundingClientRect().top;
    return blocks.map((block, index) => {
      const top = block.el.getBoundingClientRect().top - origin + viewport.scrollTop;
      const next = blocks[index + 1];
      const bottom = next ? next.el.getBoundingClientRect().top - origin + viewport.scrollTop : top + block.el.getBoundingClientRect().height;
      return {start: index === 0 ? 0 : block.start, end: next?.start ?? block.end, top: index === 0 ? 0 : top, bottom};
    });
  }
  getScroll(): number {
    const top = this.containerEl.parentElement?.scrollTop ?? 0, sections = this.scrollSections();
    const section = sections.find(section => top < section.bottom) ?? sections.at(-1);
    return section ? section.start + Math.max(0, Math.min(1, (top - section.top) / Math.max(1, section.bottom - section.top))) * (section.end - section.start) : 0;
  }
  applyScroll(scroll: number): void {
    if (!Number.isFinite(scroll)) return;
    const viewport = this.containerEl.parentElement, sections = this.scrollSections();
    const section = sections.find(section => scroll < section.end) ?? sections.at(-1);
    if (viewport && section) { const top = Math.max(0, section.top + (scroll - section.start) * (section.bottom - section.top) / Math.max(1, section.end - section.start)); this.isScrolling = Math.abs(viewport.scrollTop - top) > 0.5; viewport.scrollTop = top; }
  }
  private removeSections(): void {
    this.renderedSections = [];
    for (const child of [...this.containerEl.children]) if (child !== this.headerEl && child !== this.footerEl && !child.classList.contains("markdown-preview-pusher")) child.remove();
  }
  async rerender(_full = false): Promise<void> {
    const rebuilding = this.renderedSections.length > 0;
    const generation = ++this.renderGeneration;
    const file = this.view.file;
    if (!file) return;
    const staging = this.containerEl.ownerDocument.createElement("div");
    await MarkdownRenderer.render(this.app, this.data, staging, file.path, this);
    if (generation !== this.renderGeneration) return;
    this.removeSections();
    for (const child of [...staging.children] as HTMLElement[]) {
      const section = this.containerEl.ownerDocument.createElement("div");
      section.className = `el-${child.classList.contains("callout") ? "div" : child.tagName.toLowerCase()}${child.classList.contains("frontmatter") ? " mod-frontmatter mod-ui" : ""}`;
      section.append(child);
      this.renderedSections.push(section);
      if (this.footerEl) this.containerEl.insertBefore(section, this.footerEl); else this.containerEl.append(section);
    }
    const stored = this.app.loadLocalStorage(`note-fold-${file.path}`) as FoldInfo | null;
    if (!stored || (Array.isArray(stored.folds) && Number.isInteger(stored.lines))) this.applyFoldInfo(stored);
    // A full preview rebuild replaces the arrow widgets while retaining collapsed sections.
    if (_full && rebuilding) for (const section of this.renderedSections) {
      section.querySelector(".heading-collapse-indicator")?.classList.remove("is-collapsed");
      for (const indicator of section.querySelectorAll<HTMLElement>(".list-collapse-indicator")) {
        setListFold(indicator, false);
        if (!indicator.parentElement?.className) indicator.parentElement?.removeAttribute("class");
      }
    }
    this.view.previewSearch?.refresh();
  }
  static createCodeBlockPostProcessor(language: string, handler: Parameters<typeof MarkdownPreviewRenderer.createCodeBlockPostProcessor>[1]) {
    return MarkdownPreviewRenderer.createCodeBlockPostProcessor(language, handler);
  }
}

const IMAGE_EXTENSIONS = /^(?:png|jpe?g|gif|svg|webp|avif|bmp)$/i;

/** Plugin-facing Markdown file view with source, Live Preview and reading modes. */
export class MarkdownView extends TextFileView {
  override editor: Editor;
  readonly previewMode: MarkdownPreviewView;
  readonly editMode: MarkdownEditView;
  currentMode: MarkdownSubView;
  hoverPopover: unknown | null = null;
  /** True when the editor shows raw Markdown instead of Live Preview. */
  sourceMode: boolean;
  private readonly sourceEl: HTMLElement;
  private readonly readingEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly sizerEl: HTMLElement;
  private readonly sourceTitleEl: HTMLElement;
  private readonly previewTitleEl: HTMLElement;
  private readonly properties: PropertiesEditor;
  private readonly previewProperties: PropertiesEditor;
  private modeButton: HTMLElement | null = null;
  private sourceHost: ReturnType<typeof mountMarkdownEditor> | null = null;
  private externallyManaged = false;
  private propertyTypesRevision = 0;
  private syncing = false;
  private receivingScroll = false;
  private scrollPosition: number | null = null;
  private editSearch: EditorDocumentSearch | null = null;
  /** @internal Search bar of reading mode, while shown. */
  previewSearch: PreviewDocumentSearch | null = null;

  private readonly renameTitle = async (title: string) => {
    if (!this.file || /[\\/<>:"|?*]/.test(title) || title === "." || title === "..") throw new Error(t("plugins.file-explorer.msg-invalid-characters") + '\\ / : * ? " < > |');
    await this.save();
    const parent = this.file.parent?.path && this.file.parent.path !== "/" ? `${this.file.parent.path}/` : "";
    await this.app.fileManager.renameFile(this.file, `${parent}${title}.md`);
    this.refreshTitle(); this.app.workspace.notifyLayoutChange();
  };

  private readonly onEditorChange = (editor: Editor) => {
    if (this.syncing) return;
    this.data = editor.getValue();
    this.requestSave();
    this.syncProperties();
    if (this.currentMode === this.previewMode) this.previewMode.set(this.data, false);
  };

  private readonly livePreviewHost: LivePreviewHost = {
    renderMarkdown: (source, el) => { renderMarkdown(source, el, 0, { mermaid: this.app, strictLineBreaks: this.app.editorOptions.strictLineBreaks }); },
    mermaidAllowed: () => this.app.loadLocalStorage("mermaid-vault-trust") === true,
    allowMermaid: () => { this.app.saveLocalStorage("mermaid-vault-trust", true); this.app.workspace.trigger("post-processor-change"); },
    resolveImage: target => {
      const file = this.app.metadataCache.getFirstLinkpathDest(target.split("#")[0], this.file?.path ?? "");
      const resolved = file ? this.app.vault.getAbstractFileByPath(file.path) : null;
      return resolved instanceof TFile && IMAGE_EXTENSIONS.test(resolved.extension) ? this.app.vault.getResourcePath(resolved) : null;
    },
    isResolved: target => !target || !!this.app.metadataCache.getFirstLinkpathDest(target, this.file?.path ?? ""),
    openLink: (target, event) => { void this.app.workspace.openLinkText(target, this.file?.path ?? "", Keymap.isModEvent(event)); },
    openTag: tag => { this.app.workspace.trigger("search:open", `tag:${tag}`); },
  };

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.editor = new Editor();
    this.sourceMode = this.app.editorOptions.livePreview === false;
    const doc = this.contentEl.ownerDocument;
    const el = (tag: string, cls: string) => { const node = doc.createElement(tag); node.className = cls; return node; };
    this.sourceEl = el("div", "markdown-source-view cm-s-obsidian mod-cm6 node-insert-event");
    this.readingEl = el("div", "markdown-reading-view");
    Object.assign(this.readingEl.style, { width: "100%", height: "100%", display: "none" });
    this.previewEl = el("div", "markdown-preview-view markdown-rendered node-insert-event");
    this.sizerEl = el("div", "markdown-preview-sizer markdown-preview-section");
    const pusher = el("div", "markdown-preview-pusher"); Object.assign(pusher.style, { width: "1px", height: "0.1px", marginBottom: "0px" });
    const header = el("div", "mod-header mod-ui"), footer = el("div", "mod-footer mod-ui");
    const footerBacklinks = el("div", "embedded-backlinks"); footerBacklinks.style.display = "none"; footer.append(footerBacklinks);
    const makeTitle = () => { const title = el("div", "inline-title"); title.contentEditable = "true"; title.spellcheck = true; title.tabIndex = -1; return title; };
    this.sourceTitleEl = makeTitle(); this.previewTitleEl = makeTitle();
    const changeProperties = (yaml: string | null) => this.writeFrontmatter(yaml);
    const showSource = () => { this.setSourceMode(true); this.setMode("source"); this.editor.focus(); };
    const changeType = (key: string, type: string) => { void assignPropertyType(this.app, key, type).catch(error => new Notice(String(error))); };
    this.properties = new PropertiesEditor({ app: this.app, onChange: changeProperties, onShowSource: showSource, onTypeChange: changeType }, doc);
    this.previewProperties = new PropertiesEditor({ app: this.app, onChange: changeProperties, onShowSource: showSource, onTypeChange: changeType }, doc);
    header.append(this.previewTitleEl, this.previewProperties.containerEl);
    this.sizerEl.append(pusher, header, footer);
    this.previewEl.append(this.sizerEl); this.readingEl.append(this.previewEl);
    this.contentEl.replaceChildren(this.sourceEl, this.readingEl);
    this.editMode = new MarkdownEditView(this);
    this.previewMode = new MarkdownPreviewView(this, this.sizerEl);
    this.previewMode.headerEl = header; this.previewMode.footerEl = footer;
    this.addChild(this.previewMode);
    this.currentMode = this.editMode;
    this.editor.onChange(this.onEditorChange);
  }

  /** @internal Bind a host-owned editor so plugin and visible editor state share one document. */
  bindEditor(editor: Editor): void {
    if (this.editor === editor) return;
    this.sourceHost?.destroy(); this.sourceHost = null; this.externallyManaged = true;
    this.editor.offChange(this.onEditorChange);
    this.editor = editor;
    this.editor.onChange(this.onEditorChange);
    this.data = editor.getValue();
    if (this.currentMode === this.previewMode) this.previewMode.set(this.data, true);
  }

  getViewType(): string { return "markdown"; }
  getIcon(): string { return "lucide-file"; }
  canAcceptExtension(extension: string): boolean { return extension.toLowerCase() === "md"; }
  /** Whether the linked-mentions panel is shown at the end of this note. */
  showBacklinks = false;
  setShowBacklinks(show: boolean): void {
    this.showBacklinks = show;
    this.app.workspace.trigger("markdown-backlinks-change", this.leaf);
    this.app.workspace.requestSaveLayout();
  }
  getState(): Record<string, unknown> { return { ...super.getState(), mode: this.getMode(), source: this.sourceMode, backlinks: this.showBacklinks }; }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const hadFile = !!this.file, modeBefore = this.getMode(), sourceBefore = this.sourceMode;
    await super.setState(state, result);
    this.refreshTitle();
    if (state && typeof state === "object") {
      const next = state as { mode?: unknown; source?: unknown; backlinks?: unknown };
      if (typeof next.source === "boolean") this.sourceMode = next.source;
      if (typeof next.backlinks === "boolean" && next.backlinks !== this.showBacklinks) { this.showBacklinks = next.backlinks; this.app.workspace.trigger("markdown-backlinks-change", this.leaf); }
      this.setMode(next.mode === "preview" ? "preview" : next.mode === "source" ? "source" : !hadFile && this.app.editorOptions.defaultViewMode === "preview" && !("mode" in next) ? "preview" : this.getMode());
    }
    this.applyOptions();
    if (modeBefore !== this.getMode() || sourceBefore !== this.sourceMode) {
      result.layout = true;
      if (!(state as { sync?: unknown } | null)?.sync) result.done = () => this.syncState();
    }
  }
  getMode(): MarkdownViewModeType { return this.currentMode === this.previewMode ? "preview" : "source"; }
  override getEphemeralState(): Record<string, unknown> {
    const state = super.getEphemeralState();
    if (this.getMode() === "source") state.cursor = {from: this.editor.getCursor("anchor"), to: this.editor.getCursor("head")};
    if (this.scrollPosition !== null) state.scroll = this.scrollPosition;
    return state;
  }
  override setEphemeralState(value: unknown): void {
    super.setEphemeralState(value);
    if (!value || typeof value !== "object") return;
    const state = value as {cursor?: {from?: {line: number; ch: number}; to?: {line: number; ch: number}}; scroll?: number};
    this.receivingScroll = true;
    try {
      if (this.getMode() === "source" && state.cursor?.from) {
        const saved = this.editor.getScrollInfo();
        this.editor.setSelection(state.cursor.from, state.cursor.to);
        this.editor.scrollTo(saved.left, saved.top);
        this.editor.focus();
      }
      if (typeof state.scroll === "number" && Number.isFinite(state.scroll)) {
        this.scrollPosition = state.scroll;
        this.currentMode.applyScroll(state.scroll);
      }
    } finally { this.receivingScroll = false; }
  }
  syncScroll(): void {
    this.scrollPosition = this.currentMode.getScroll();
    this.app.workspace.trigger("markdown-scroll", this);
    this.syncState();
  }
  getViewData(): string { return this.editor.getValue(); }
  override async onUnloadFile(file: TFile): Promise<void> {
    const info = this.currentMode.getFoldInfo();
    this.app.saveLocalStorage(`note-fold-${file.path}`, info.folds.length ? info : null);
    await super.onUnloadFile(file);
  }
  override async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.refreshTitle();
    if (this.file === file) {
      const info = this.currentMode.getFoldInfo();
      this.app.saveLocalStorage(`note-fold-${file.path}`, info.folds.length ? info : null);
    }
  }
  setViewData(data: string, clear: boolean): void {
    this.syncing = true;
    try {
      if (clear) this.editor.setValue("");
      this.data = data;
      if (clear) this.editor.setValue(data);
      else this.editor.setValuePreservingSelection(data);
      if (clear) this.editor.setCursor({ line: 0, ch: 0 });
      this.previewMode.set(data, clear);
      if (clear && this.file) this.editMode.applyFoldInfo(this.app.loadLocalStorage(`note-fold-${this.file.path}`) as FoldInfo | null);
    } finally { this.syncing = false; }
    this.syncProperties();
  }
  clear(): void {
    this.syncing = true;
    try { this.scrollPosition = null; this.data = ""; this.editor.setValue(""); this.previewMode.clear(); }
    finally { this.syncing = false; }
  }
  /** Shows the in-document search bar of the visible mode; replacing is only offered while editing. */
  showSearch(replace = false): void {
    if (this.getMode() === "preview") {
      this.previewSearch ??= new PreviewDocumentSearch(this.app, this.contentEl, this.readingEl, this.previewEl, this.sizerEl, () => { this.previewSearch = null; });
      this.previewSearch.focus();
    } else (this.editSearch ??= new EditorDocumentSearch(this.app, this.contentEl, () => this.editor)).show(replace);
  }
  private closeSearch(): void { this.editSearch?.hide(false); this.previewSearch?.close(); }

  private get options(): MarkdownEditorOptions { return { ...this.app.editorOptions, livePreview: !this.sourceMode, extensions: this.app.editorExtensions, onFold: () => this.onMarkdownFold() }; }
  onMarkdownFold(): void {
    if (this.syncing || this.editMode.applyingFold || !this.file || this.getMode() !== "source") return;
    const info = this.editMode.getFoldInfo();
    this.app.saveLocalStorage(`note-fold-${this.file.path}`, info.folds.length ? info : null);
  }

  /** Applies preferences to both subviews: editor configuration and the state classes the theme keys on. */
  private applyOptions(): void {
    const options = this.options;
    const properties = options.propertiesInDocument ?? "visible";
    this.sourceHost?.setOptions(options);
    // Plugins read the owning view and the editing mode from the editor state.
    this.editor.cm?.dispatch({ effects: bindEditorFields.of({ info: this, livePreview: !this.sourceMode }) });
    const toggle = (el: HTMLElement, name: string, on: boolean) => el.classList.toggle(name, on);
    toggle(this.sourceEl, "is-readable-line-width", options.readableLineLength !== false);
    toggle(this.sourceEl, "is-live-preview", !this.sourceMode);
    toggle(this.sourceEl, "is-folding", options.foldHeading !== false || options.foldIndent !== false);
    toggle(this.sourceEl, "show-properties", properties === "visible");
    toggle(this.sourceEl, "is-rtl", !!options.rightToLeft);
    toggle(this.previewEl, "is-readable-line-width", options.readableLineLength !== false);
    toggle(this.previewEl, "allow-fold-headings", options.foldHeading !== false);
    toggle(this.previewEl, "allow-fold-lists", options.foldIndent !== false);
    toggle(this.previewEl, "show-indentation-guide", options.showIndentGuide !== false);
    toggle(this.previewEl, "show-properties", properties === "visible");
    toggle(this.previewEl, "rtl", !!options.rightToLeft);
    this.syncProperties();
    this.refreshModeButton();
  }

  private refreshTitle(): void {
    const title = this.file?.basename ?? "";
    for (const el of [this.sourceTitleEl, this.previewTitleEl]) if (el.ownerDocument.activeElement !== el) el.textContent = title;
  }

  private syncProperties(): void {
    const revision = ++this.propertyTypesRevision;
    void readPropertyTypes(this.app).then(types => { if (revision === this.propertyTypesRevision) { this.properties.setTypes(types); this.previewProperties.setTypes(types); } });
    const range = frontmatterRange({ length: this.data.length, sliceString: (from, to) => this.data.slice(from, to), toString: () => this.data });
    const yaml = range ? this.data.slice(range.contentFrom, range.contentTo) : null;
    const show = (this.app.editorOptions.propertiesInDocument ?? "visible") === "visible";
    for (const [editor, hideInSource] of [[this.properties, this.sourceMode], [this.previewProperties, false]] as const) {
      editor.setSource(yaml);
      editor.containerEl.style.display = show && !hideInSource && (yaml !== null) ? "" : "none";
    }
  }

  /** Starts a new row in the properties panel of the visible mode. */
  addProperty(): void { (this.getMode() === "preview" ? this.previewProperties : this.properties).addProperty(); }
  /** Replaces (or adds/removes) the leading YAML block from an edit in the properties panel. */
  private writeFrontmatter(yaml: string | null): void {
    const current = this.editor.getValue();
    const range = frontmatterRange({ length: current.length, sliceString: (from, to) => current.slice(from, to), toString: () => current });
    const block = yaml === null ? "" : `---\n${yaml}\n---\n`;
    const next = range ? block + current.slice(range.to) : block + current;
    if (next !== current) this.editor.replaceRange(block, { line: 0, ch: 0 }, this.editor.offsetToPos(range ? range.to : 0));
  }

  private refreshModeButton(): void {
    if (!this.modeButton) return;
    const reading = this.getMode() === "preview";
    setIcon(this.modeButton, reading ? "lucide-edit-3" : "lucide-book-open");
    this.modeButton.setAttribute("aria-label", [t(reading ? "interface.menu.read-view" : "interface.menu.edit-view"), t(reading ? "interface.menu.switch-to-edit-view" : "interface.menu.switch-to-read-view"), t("interface.menu.mod-click-open-new-tab", { key: process.platform === "darwin" ? "Cmd" : "Ctrl" })].join("\n"));
  }

  private bindTitle(title: HTMLElement): void {
    this.registerDomEvent(title, "keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); title.blur(); if (this.getMode() === "source") this.editor.focus(); }
      else if (event.key === "Escape") { event.preventDefault(); title.textContent = this.file?.basename ?? ""; title.blur(); }
      event.stopPropagation();
    });
    this.registerDomEvent(title, "paste", event => { event.preventDefault(); title.ownerDocument.execCommand("insertText", false, (event.clipboardData?.getData("text/plain") ?? "").replace(/[\r\n]+/g, " ")); });
    this.registerDomEvent(title, "blur", () => {
      const value = title.textContent?.trim();
      if (value && value !== this.file?.basename) void this.renameTitle(value).catch((error: Error) => { this.refreshTitle(); new Notice(error.message); });
      else this.refreshTitle();
    });
  }

  private onEditorContextMenu(event: MouseEvent): void {
    if (this.getMode() === "source") showEditorContextMenu(this.app, this.editor, this, event);
  }

  override onload(): void {
    super.onload();
    if (!this.externallyManaged) {
      this.sourceHost = mountMarkdownEditor(this.sourceEl, this.editor, this.options, this.livePreviewHost);
      const backlinks = this.contentEl.ownerDocument.createElement("div"); backlinks.className = "embedded-backlinks"; backlinks.style.display = "none";
      this.sourceHost.sizerEl.prepend(this.sourceTitleEl, this.properties.containerEl);
      this.sourceHost.sizerEl.append(backlinks);
    }
    this.bindTitle(this.sourceTitleEl); this.bindTitle(this.previewTitleEl);
    this.registerDomEvent(this.contentEl, "scroll", event => {
      if (this.receivingScroll || !this.file) return;
      const target = event.target as HTMLElement;
      if (target !== this.editor.cm?.scrollDOM && target !== this.previewEl) return;
      if (this.currentMode.isScrolling) { this.currentMode.isScrolling = false; return; }
      const position = this.currentMode.getScroll();
      if (this.scrollPosition !== null && Math.abs(this.scrollPosition - position) < 0.03) return;
      this.syncScroll();
    }, {capture: true});
    this.registerDomEvent(this.sourceEl, "contextmenu", event => this.onEditorContextMenu(event));
    this.registerDomEvent(this.sourceEl, "focusin", () => { if (this.app.workspace.activeLeaf === this.leaf) this.app.workspace.activeEditor = this; });
    this.modeButton = this.addAction("lucide-book-open", "", event => {
      const next = this.getMode() === "preview" ? "source" : "preview";
      if (Keymap.isModEvent(event)) { void this.app.workspace.duplicateLeaf(this.leaf, "split", "vertical").then(leaf => { (leaf.view as MarkdownView).setMode?.(next); this.app.workspace.notifyLayoutChange(); }); return; }
      this.setMode(next); this.app.workspace.notifyLayoutChange();
    });
    this.registerEvent(this.app.workspace.on("editor-options-change", () => this.applyOptions()));
    this.registerEvent(this.app.workspace.on("editor-extensions-change", () => this.sourceHost?.setExtensions(this.app.editorExtensions)));
    this.registerEvent(this.app.workspace.on("post-processor-change", () => {
      if (this.file) void this.previewMode.rerender();
      this.editor.cm?.dispatch({ effects: refreshMarkdownDecorations.of(null) });
    }));
    this.registerEvent(this.app.workspace.on("property-types-change", (value: unknown) => { if (!value || typeof value !== "object" || Array.isArray(value)) return; this.propertyTypesRevision++; const types = value as Record<string, string>; this.properties.setTypes(types); this.previewProperties.setTypes(types); }));
    this.register(() => { this.closeSearch(); this.sourceHost?.destroy(); this.sourceHost = null; this.editor.offChange(this.onEditorChange); });
    this.applyOptions();
  }

  /** Switches between Live Preview and source editing without leaving edit mode. */
  setSourceMode(source: boolean): void {
    if (this.sourceMode === source) return;
    this.sourceMode = source;
    this.applyOptions();
    this.app.workspace.requestSaveLayout();
  }

  setMode(mode: MarkdownViewModeType): void {
    const changing = mode !== this.getMode();
    if (changing) {
      this.closeSearch();
      if (this.file) {
        const info = this.currentMode.getFoldInfo();
        this.app.saveLocalStorage(`note-fold-${this.file.path}`, info.folds.length ? info : null);
      }
    }
    const scroll = this.currentMode.getScroll();
    this.currentMode = mode === "preview" ? this.previewMode : this.editMode;
    this.sourceEl.style.display = mode === "preview" ? "none" : "";
    this.readingEl.style.display = mode === "preview" ? "" : "none";
    if (mode === "preview") this.previewMode.set(this.data, false);
    else {
      this.sourceHost?.view.requestMeasure();
      if (changing && this.file) this.editMode.applyFoldInfo(this.app.loadLocalStorage(`note-fold-${this.file.path}`) as FoldInfo | null);
    }
    this.currentMode.applyScroll(scroll);
    this.refreshModeButton();
  }
}
