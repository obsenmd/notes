import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { SearchCursor } from "@codemirror/search";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { t } from "../i18n";
import { formatHotkey } from "../renderer/hotkeys";
import { Scope, type Modifier } from "./commands";
import type { Editor } from "./editor";
import type { App } from "./plugin";
import { setIcon, setTooltip } from "./utilities";

interface Match { from: number; to: number }

const setHighlights = StateEffect.define<Match[]>();
const highlightMark = Decoration.mark({ class: "obsidian-search-match-highlight" });
/** Marks the matches the in-document search bar points at. Installed on demand when missing. */
export const documentSearchHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setHighlights)) value = Decoration.set(effect.value.filter(range => range.from < range.to).map(range => highlightMark.range(range.from, range.to)), true);
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

function make<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = parent.ownerDocument.createElement(tag); node.className = cls; parent.append(node); return node;
}

function iconButton(parent: HTMLElement, tag: "button" | "div", cls: string, icon: string, label: string, hotkey: [Modifier[], string] | null, onClick: () => void): HTMLElement {
  const button = make(parent, tag, `clickable-icon ${cls}`);
  setIcon(button, icon);
  setTooltip(button, hotkey ? `${label}\n${formatHotkey({ modifiers: hotkey[0], key: hotkey[1] })}` : label, { placement: "top" });
  if (tag === "button") button.addEventListener("mousedown", event => event.preventDefault());
  button.addEventListener("click", event => { event.preventDefault(); onClick(); });
  return button;
}

interface BarOptions { closeInButtons: boolean; findNext(): void; findPrevious(): void; close(): void }

/** `div.document-search-container > div.document-search`, shared by the editing and reading bars. */
function buildBar(doc: Document, options: BarOptions) {
  const searchContainerEl = doc.createElement("div"); searchContainerEl.className = "document-search-container";
  const searchEl = make(searchContainerEl, "div", "document-search");
  const inputContainerEl = make(searchEl, "div", "search-input-container document-search-input");
  const searchInputEl = make(inputContainerEl, "input", ""); searchInputEl.removeAttribute("class");
  searchInputEl.type = "text"; searchInputEl.placeholder = t("editor.search.placeholder-find");
  const countEl = make(inputContainerEl, "div", "document-search-count");
  const buttonsEl = make(searchEl, "div", "document-search-buttons");
  iconButton(buttonsEl, "button", "document-search-button", "lucide-arrow-up", t("editor.search.label-previous"), [["Shift"], "F3"], options.findPrevious);
  iconButton(buttonsEl, "button", "document-search-button", "lucide-arrow-down", t("editor.search.label-next"), [[], "F3"], options.findNext);
  const addClose = () => iconButton(options.closeInButtons ? buttonsEl : searchEl, "div", "document-search-close-button", "lucide-x", t("editor.search.label-exit-search"), null, options.close);
  if (options.closeInButtons) addClose();
  return { searchContainerEl, searchEl, searchInputEl, countEl, buttonsEl, addClose };
}

const setCount = (el: HTMLElement, query: string, index: number, total: number) => { el.style.display = query ? "" : "none"; el.textContent = `${index} / ${total}`; };

/** Search and replace bar of the editing modes; walks the document case-insensitively from the cursor. */
export class EditorDocumentSearch {
  readonly searchContainerEl: HTMLElement;
  readonly searchInputEl: HTMLInputElement;
  readonly replaceInputEl: HTMLInputElement;
  readonly countEl: HTMLElement;
  readonly scope: Scope;
  isActive = false;
  isReplace = false;
  private current: Match | null = null;
  private from = 0;
  private to = 0;
  private ready = false;

  constructor(private readonly app: App, private readonly ownerEl: HTMLElement, private readonly getEditor: () => Editor) {
    const bar = buildBar(ownerEl.ownerDocument, { closeInButtons: false, findNext: () => this.findNext(), findPrevious: () => this.findPrevious(), close: () => this.hide() });
    this.searchContainerEl = bar.searchContainerEl; this.searchInputEl = bar.searchInputEl; this.countEl = bar.countEl;
    bar.addClose();
    iconButton(bar.buttonsEl, "button", "document-search-button", "lucide-text-select", t("editor.search.label-find-all"), [["Alt"], "Enter"], () => this.searchAll());
    const replaceEl = make(this.searchContainerEl, "div", "document-replace");
    this.replaceInputEl = make(replaceEl, "input", "document-replace-input");
    this.replaceInputEl.type = "text"; this.replaceInputEl.placeholder = t("editor.search.placeholder-replace");
    const replaceButtonsEl = make(replaceEl, "div", "document-replace-buttons");
    iconButton(replaceButtonsEl, "button", "document-search-button", "lucide-replace", t("editor.search.label-replace"), [[], "Enter"], () => this.replaceCurrentMatch());
    iconButton(replaceButtonsEl, "button", "document-search-button", "lucide-replace-all", t("editor.search.label-replace-all"), [["Mod", "Alt"], "Enter"], () => this.replaceAll());
    this.searchInputEl.addEventListener("input", () => this.onSearchInput());

    const scope = this.scope = new Scope(app.commands.rootScope);
    const inView = (run: () => void) => () => { if (!this.ownerEl.contains(this.ownerEl.ownerDocument.activeElement)) return undefined; run(); return false; };
    const inInput = (run: (event: KeyboardEvent) => void) => (event: KeyboardEvent) => { if (event.isComposing || !this.inputFocused()) return undefined; run(event); return false; };
    scope.register([], "F3", inView(() => this.findNext()));
    scope.register(["Mod"], "G", inView(() => this.findNext()));
    scope.register(["Shift"], "F3", inView(() => this.findPrevious()));
    scope.register(["Mod", "Shift"], "G", inView(() => this.findPrevious()));
    scope.register([], "Enter", inInput(() => this.findNextOrReplace()));
    scope.register(["Shift"], "Enter", inInput(() => this.findPrevious()));
    scope.register([], "Escape", inView(() => this.hide()));
    const nextInput = inInput(() => { (this.isReplace && this.focused(this.searchInputEl) ? this.replaceInputEl : this.searchInputEl).focus(); });
    scope.register([], "Tab", event => this.isReplace ? nextInput(event) : undefined);
    scope.register(["Shift"], "Tab", event => this.isReplace ? nextInput(event) : undefined);
    scope.register(["Alt"], "Enter", inInput(() => this.searchAll()));
    scope.register(["Mod", "Alt"], "Enter", event => this.isReplace && this.focused(this.replaceInputEl) ? inInput(() => this.replaceAll())(event) : undefined);
  }

  private get cm(): EditorView | null { return this.getEditor().cm; }
  private focused(el: HTMLElement): boolean { return el.ownerDocument.activeElement === el; }
  private inputFocused(): boolean { return this.focused(this.searchInputEl) || this.focused(this.replaceInputEl); }
  getQuery(): string { return this.searchInputEl.value; }

  show(replace = false): void {
    const cm = this.cm;
    if (!cm) return;
    this.isActive = true; this.isReplace = replace;
    this.searchContainerEl.classList.toggle("mod-replace-mode", replace);
    (cm.dom.parentElement ?? this.ownerEl).prepend(this.searchContainerEl);
    const selection = this.getEditor().getSelection();
    if (selection) this.searchInputEl.value = selection;
    this.searchInputEl.focus(); this.searchInputEl.select();
    this.app.keymap.pushScope(this.scope);
    this.onSearchInput();
  }

  hide(focus = true): void {
    if (!this.isActive) return;
    this.isActive = false;
    const cm = this.cm, current = this.current;
    if (cm && current && this.inputFocused()) { const length = cm.state.doc.length; cm.dispatch({ selection: { anchor: Math.min(current.from, length), head: Math.min(current.to, length) } }); }
    this.searchContainerEl.remove();
    this.searchInputEl.value = ""; this.searchInputEl.classList.remove("mod-no-match");
    this.current = null; this.ready = false;
    this.highlight([]);
    this.app.keymap.popScope(this.scope);
    if (focus) { this.getEditor().focus(); cm?.focus(); }
  }

  private cursor(from: number, to?: number): SearchCursor {
    const doc = this.cm!.state.doc;
    return new SearchCursor(doc, this.getQuery(), Math.min(from, doc.length), to ?? doc.length, text => text.toLowerCase());
  }
  private all(limit = Infinity): Match[] {
    const matches: Match[] = [];
    if (!this.cm || !this.getQuery()) return matches;
    for (const cursor = this.cursor(0); matches.length < limit && !cursor.next().done;) matches.push({ from: cursor.value.from, to: cursor.value.to });
    return matches;
  }
  private select(match: Match | null): void {
    this.current = match;
    if (match) { this.from = match.from; this.to = match.to; this.highlight([match]); } else this.highlight([]);
    this.updateCount();
  }

  updateCount(): void {
    const current = this.current;
    let index = 0, total = 0;
    if (current && this.getQuery()) for (const match of this.all(9999)) { if (match.from <= current.to) index++; total++; }
    setCount(this.countEl, this.getQuery(), index, total);
  }

  private onSearchInput(): void {
    const cm = this.cm, query = this.getQuery();
    if (!cm) return;
    const main = cm.state.selection.main;
    this.from = main.from; this.to = main.to; this.ready = true; this.current = null;
    if (query) this.findNext(); else this.select(null);
    this.searchInputEl.classList.toggle("mod-no-match", !!query && !this.current);
  }

  findNext(): void {
    if (!this.ready || !this.cm) return;
    if (!this.getQuery()) return this.select(null);
    let cursor = this.cursor(this.to).next();
    if (cursor.done) cursor = this.cursor(0).next();
    this.select(cursor.done ? null : { from: cursor.value.from, to: cursor.value.to });
  }

  findPrevious(): void {
    if (!this.ready || !this.cm) return;
    const matches = this.all();
    let found: Match | null = null;
    for (const match of matches) { if (match.to > this.from) break; found = match; }
    this.select(found ?? matches[matches.length - 1] ?? null);
  }

  private replaceCurrent(text: string): void {
    const cm = this.cm, current = this.current;
    if (!cm || !current || current.to > cm.state.doc.length) return;
    cm.dispatch({ changes: { from: current.from, to: current.to, insert: text }, userEvent: "input.replace" });
    this.to = current.from + text.length;
  }
  private findNextOrReplace(): void {
    if (!this.ready) return;
    const text = this.replaceInputEl.value;
    if (this.isReplace && this.focused(this.replaceInputEl) && text !== "") this.replaceCurrent(text);
    this.findNext();
  }
  replaceCurrentMatch(): void {
    if (!this.ready) return;
    this.replaceCurrent(this.replaceInputEl.value);
    this.findNext();
  }
  replaceAll(): void {
    const cm = this.cm, text = this.replaceInputEl.value, matches = this.all();
    if (!cm || !matches.length) return;
    cm.dispatch({ changes: matches.map(match => ({ from: match.from, to: match.to, insert: text })), userEvent: "input.replace.all" });
    this.select(null);
    this.searchInputEl.classList.toggle("mod-no-match", !this.all(1).length);
  }
  searchAll(): void { if (this.ready) this.highlight(this.all()); }

  private highlight(matches: Match[]): void {
    const cm = this.cm;
    if (!cm) return;
    const installed = cm.state.field(documentSearchHighlights, false) !== undefined;
    if (!installed) { if (!matches.length) return; cm.dispatch({ effects: StateEffect.appendConfig.of(documentSearchHighlights) }); }
    const length = cm.state.doc.length, ranges = matches.filter(match => match.to <= length);
    const effects: StateEffect<unknown>[] = [setHighlights.of(ranges)];
    const folded = foldedRanges(cm.state);
    for (const match of ranges) folded.between(match.from, match.to, (from, to) => { if (match.to !== from && match.from !== to) effects.push(unfoldEffect.of({ from, to })); });
    if (ranges[0]) effects.push(EditorView.scrollIntoView(ranges[0].from, { y: "center" }));
    cm.dispatch({ effects });
  }
}

interface PreviewRange { section: HTMLElement; start: number; end: number; active: boolean }

function collectText(node: Node, out: Text[]): void {
  if (node.nodeType === 3) { out.push(node as Text); return; }
  if (node.nodeType === 1 && ((node as HTMLElement).hidden || (node as HTMLElement).style?.display === "none")) return;
  for (let child = node.firstChild; child; child = child.nextSibling) collectText(child, out);
}

function textRange(nodes: Text[], start: number, end: number): Range | null {
  let offset = 0, startNode: Text | null = null, startOffset = -1, endNode: Text | null = null, endOffset = -1;
  for (const node of nodes) {
    const next = offset + node.data.length;
    if (offset <= start && start <= next) { startNode = node; startOffset = start - offset; }
    if (offset <= end && end <= next) { endNode = node; endOffset = end - offset; break; }
    offset = next;
  }
  if (!startNode || !endNode) return null;
  const range = startNode.ownerDocument.createRange();
  range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
  return range;
}

/** Search bar of reading mode: matches the rendered text and outlines the hits in `div.search-highlight`. */
export class PreviewDocumentSearch {
  readonly searchContainerEl: HTMLElement;
  readonly searchInputEl: HTMLInputElement;
  readonly countEl: HTMLElement;
  readonly scope: Scope;
  private highlightRanges: PreviewRange[] | null = null;
  private highlightEl: HTMLElement | null = null;
  private selectedRange = -1;
  private lastQuery: string | null = null;
  private inputTimer: number | null = null;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(private readonly app: App, private readonly ownerEl: HTMLElement, containerEl: HTMLElement, private readonly previewEl: HTMLElement, private readonly sizerEl: HTMLElement, private readonly onClose: () => void) {
    const bar = buildBar(containerEl.ownerDocument, { closeInButtons: true, findNext: () => this.findNext(), findPrevious: () => this.findPrevious(), close: () => this.close() });
    this.searchContainerEl = bar.searchContainerEl; this.searchInputEl = bar.searchInputEl; this.countEl = bar.countEl;
    containerEl.prepend(this.searchContainerEl);
    const win = containerEl.ownerDocument.defaultView ?? window;
    this.searchInputEl.addEventListener("input", () => {
      if (this.inputTimer !== null) win.clearTimeout(this.inputTimer);
      this.inputTimer = win.setTimeout(() => { this.inputTimer = null; this.onSearchInput(); }, 150);
    });
    const scope = this.scope = new Scope(app.commands.rootScope);
    const inView = (run: () => void) => () => { if (!this.ownerEl.contains(this.ownerEl.ownerDocument.activeElement)) return undefined; run(); return false; };
    const inInput = (run: () => void) => (event: KeyboardEvent) => { if (event.isComposing || this.searchInputEl.ownerDocument.activeElement !== this.searchInputEl) return undefined; run(); return false; };
    scope.register([], "F3", inView(() => this.findNext()));
    scope.register(["Mod"], "G", inView(() => this.findNext()));
    scope.register(["Shift"], "F3", inView(() => this.findPrevious()));
    scope.register(["Mod", "Shift"], "G", inView(() => this.findPrevious()));
    scope.register([], "Enter", inInput(() => this.findNext()));
    scope.register(["Shift"], "Enter", inInput(() => this.findPrevious()));
    scope.register([], "Escape", inView(() => this.close()));
    app.keymap.pushScope(scope);
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.renderHighlights());
    this.resizeObserver?.observe(sizerEl);
    const selection = win.getSelection()?.toString();
    if (selection) this.searchInputEl.value = selection;
    this.updateQuery(); this.updateCount();
  }

  getQuery(): string { return this.searchInputEl.value; }
  focus(): void { this.searchInputEl.focus(); this.searchInputEl.select(); }

  close(): void {
    if (this.inputTimer !== null) (this.searchContainerEl.ownerDocument.defaultView ?? window).clearTimeout(this.inputTimer);
    this.resizeObserver?.disconnect();
    this.searchContainerEl.remove();
    this.searchInputEl.value = ""; this.searchInputEl.classList.remove("mod-no-match");
    this.highlightRanges = null; this.renderHighlights();
    this.app.keymap.popScope(this.scope);
    this.onClose();
  }

  /** Re-matches after the preview was rendered again, keeping the selected hit when it still exists. */
  refresh(): void {
    const selected = this.selectedRange;
    this.updateQuery(true);
    const ranges = this.highlightRanges;
    if (ranges?.length && selected >= 0) { this.selectedRange = Math.min(selected, ranges.length - 1); ranges[this.selectedRange].active = true; }
    this.renderHighlights(); this.updateCount();
  }

  private sections(): HTMLElement[] {
    return ([...this.sizerEl.children] as HTMLElement[]).filter(el => el !== this.highlightEl && !el.classList.contains("markdown-preview-pusher") && !el.classList.contains("search-highlight"));
  }

  private updateQuery(force = false): void {
    const query = this.getQuery().toLowerCase();
    if (!force && this.lastQuery === query) return;
    this.lastQuery = query; this.selectedRange = -1;
    this.searchInputEl.classList.remove("mod-no-match");
    this.highlightRanges = null;
    if (query) {
      const ranges: PreviewRange[] = [];
      for (const section of this.sections()) {
        const nodes: Text[] = []; collectText(section, nodes);
        const text = nodes.map(node => node.data).join("").toLowerCase();
        for (let at = 0; (at = text.indexOf(query, at)) !== -1;) { const end = at + query.length; ranges.push({ section, start: at, end, active: false }); at = end; }
      }
      this.highlightRanges = ranges;
      this.searchInputEl.classList.toggle("mod-no-match", ranges.length === 0);
    }
    this.renderHighlights();
  }

  private updateCount(): void { setCount(this.countEl, this.getQuery(), this.selectedRange + 1, this.highlightRanges?.length ?? 0); }
  private onSearchInput(): void { this.updateQuery(); this.selectRange(0); this.updateCount(); }
  findNext(): void { this.selectRange(this.selectedRange + 1); this.updateCount(); }
  findPrevious(): void { this.selectRange(this.selectedRange - 1); this.updateCount(); }

  private selectRange(index: number): void {
    const ranges = this.highlightRanges;
    if (!ranges?.length) return;
    if (index > ranges.length - 1) index = 0;
    if (index < 0) index = ranges.length - 1;
    const previous = ranges[this.selectedRange];
    if (previous) previous.active = false;
    this.selectedRange = index;
    const selected = ranges[index];
    selected.active = true;
    const nodes: Text[] = []; collectText(selected.section, nodes);
    const rect = textRange(nodes, selected.start, selected.end)?.getBoundingClientRect(), view = this.previewEl.getBoundingClientRect();
    if (rect && (rect.width || rect.height) && (rect.top < view.top + 40 || rect.bottom > view.bottom - 40)) this.previewEl.scrollTop += rect.top + rect.height / 2 - (view.top + view.height / 2);
    this.renderHighlights();
  }

  private renderHighlights(): void {
    this.highlightEl?.remove(); this.highlightEl = null;
    const ranges = this.highlightRanges, parent = this.sizerEl.offsetParent as HTMLElement | null;
    if (!ranges?.length || !parent) return;
    const doc = this.sizerEl.ownerDocument, base = parent.getBoundingClientRect(), scale = base.width ? parent.offsetWidth / Math.round(base.width) : 1;
    const highlightEl = doc.createElement("div"); highlightEl.className = "search-highlight";
    let section: HTMLElement | null = null, nodes: Text[] = [];
    for (const range of ranges) {
      if (range.section !== section) { section = range.section; nodes = []; collectText(section, nodes); }
      const rects = textRange(nodes, range.start, range.end)?.getClientRects();
      if (!rects) continue;
      for (const rect of rects) {
        const el = doc.createElement("div");
        if (range.active) el.className = "is-active";
        Object.assign(el.style, { left: `${(rect.x - base.x + parent.scrollLeft) * scale}px`, top: `${(rect.y - base.y + parent.scrollTop) * scale}px`, width: `${rect.width * scale}px`, height: `${rect.height * scale}px` });
        highlightEl.append(el);
      }
    }
    if (!highlightEl.childElementCount) return;
    this.sizerEl.append(highlightEl); this.highlightEl = highlightEl;
  }
}
