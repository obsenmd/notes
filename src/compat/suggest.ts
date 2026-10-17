import { Component } from "./component";
import { t } from "../i18n";
import { Scope } from "./commands";
import { Modal } from "./ui";
import { BaseComponent } from "./setting-controls";
import type { App } from "./plugin";
import type { Editor, EditorPosition } from "./editor";
import type { TFile } from "./vault";

/** A matched text range, `[from, to)`. */
export type SearchMatchPart = [number, number];
export type SearchMatches = SearchMatchPart[];
/** `score` is zero or negative; the best match has the highest score. */
export interface SearchResult { score: number; matches: SearchMatches; }
export interface SearchResultContainer { match: SearchResult; }
export interface FuzzyMatch<T> { item: T; match: SearchResult; }
export interface Instruction { command: string; purpose: string; }
/** @internal A query split once so it can be run against many strings. */
export interface PreparedQuery { query: string; tokens: string[]; fuzzy: string[]; }

const PUNCTUATION = /[ -⁯⸀-⹿\\'!"#$%&()*+,\-.\/:;<=>?@\[\]^_`{|}~]/, WHITESPACE = /\s/;
const CJK = /[ༀ-࿿぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

/** Splits a query into words (punctuation and CJK characters are words of their own) and into single characters. */
export function prepareQuery(query: string): PreparedQuery {
  const lower = query.toLowerCase(), tokens: string[] = [];
  let start = 0;
  for (let index = 0; index < lower.length; index++) {
    const char = lower.charAt(index);
    if (WHITESPACE.test(char)) { if (start !== index) tokens.push(lower.substring(start, index)); start = index + 1; }
    else if (PUNCTUATION.test(char) || CJK.test(char)) { if (start !== index) tokens.push(lower.substring(start, index)); tokens.push(char); start = index + 1; }
  }
  if (start !== lower.length) tokens.push(lower.substring(start));
  return { query, tokens, fuzzy: lower.split("").filter(char => char !== " ") };
}

/** Fewer, tighter, earlier matches in shorter strings rank higher; `penalty` counts matches that start inside a word. */
function scoreMatches(matches: SearchMatches, queryLength: number, textLength: number, penalty: number): number {
  if (!matches.length) return 0;
  const first = matches[0][0];
  return -Math.max(0, matches.length - 1) - penalty / 10 - (matches[matches.length - 1][1] - first + 1 - queryLength) / 100 - first / 1000 - textLength / 10000;
}

function matchInOrder(parts: string[], query: string, text: string, fuzzy: boolean): SearchResult | null {
  if (!parts.length) return null;
  const lower = text.toLowerCase(), matches: SearchMatches = [];
  let penalty = 0, from = 0;
  for (const part of parts) {
    const at = lower.indexOf(part, from);
    if (at < 0) return null;
    const char = text.charAt(at);
    if (at > 0 && !PUNCTUATION.test(char) && !CJK.test(char)) {
      const before = text.charAt(at - 1);
      const insideWord = (char.toLowerCase() !== char && before.toLowerCase() !== before)
        || (char.toUpperCase() !== char && !PUNCTUATION.test(before) && !WHITESPACE.test(before) && !CJK.test(before));
      if (insideWord && !(fuzzy && at === from)) penalty++;
    }
    const last = matches[matches.length - 1];
    if (last && last[1] >= at) last[1] = at + part.length; else matches.push([at, at + part.length]);
    from = at + part.length;
  }
  return { matches, score: scoreMatches(matches, query.length, lower.length, penalty) };
}

/** Whole words in order first; failing that, the query's characters in order. */
export function fuzzySearch(query: PreparedQuery, text: string): SearchResult | null {
  if (query.query === "") return { score: 0, matches: [] };
  return matchInOrder(query.tokens, query.query, text, false) ?? matchInOrder(query.fuzzy, query.query, text, true);
}

export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const prepared = prepareQuery(query);
  return text => fuzzySearch(prepared, text);
}

const mergeMatches = (matches: SearchMatches): SearchMatches => {
  if (!matches.length) return matches;
  matches.sort((a, b) => a[0] - b[0]);
  const merged: SearchMatches = [matches[0]];
  for (let index = 1; index < matches.length; index++) {
    const last = merged[merged.length - 1], next = matches[index];
    if (last[1] < next[0]) merged.push(next); else if (last[1] < next[1]) last[1] = next[1];
  }
  return merged;
};

/** Every space-separated word must occur somewhere in the text; all occurrences are reported. */
export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const words = query.toLowerCase().split(" ");
  return text => {
    const lower = text.toLowerCase(), matches: SearchMatches = [];
    for (const word of words) {
      if (!word) continue;
      let found = false;
      for (let at = -1; (at = lower.indexOf(word, at)) !== -1; at += word.length + 1) { found = true; matches.push([at, at + word.length]); }
      if (!found) return null;
    }
    const merged = mergeMatches(matches);
    return { score: scoreMatches(merged, query.length, text.length, 0), matches: merged };
  };
}

/** Best match first. The sort is stable, so equal scores keep their incoming order. */
export function sortSearchResults(results: SearchResultContainer[]): void { results.sort((a, b) => b.match.score - a.match.score); }

export abstract class PopoverSuggest<T> extends Component {
  readonly scope: Scope;
  protected rootEl: HTMLElement | null = null;
  protected listEl: HTMLElement | null = null;
  protected instructionsEl: HTMLElement | null = null;
  private instructions: Instruction[] = [];
  protected activeIndex = -1;
  protected values: T[] = [];
  protected readonly keyHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") { this.close(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); this.setActive(this.activeIndex + 1); }
    if (event.key === "ArrowUp") { event.preventDefault(); this.setActive(this.activeIndex - 1); }
    if (event.key === "Enter" && this.activeIndex >= 0) {
      event.preventDefault(); this.selectSuggestion(this.values[this.activeIndex], event);
    }
  };
  constructor(readonly app: App, scope?: Scope) { super(); this.scope = scope ?? new Scope(); }
  open(): void {
    if (this.rootEl) return;
    this.rootEl = document.createElement("div"); this.rootEl.className = "suggestion-container";
    this.listEl = document.createElement("div"); this.listEl.className = "suggestion"; this.rootEl.append(this.listEl);
    this.instructionsEl = document.createElement("div"); this.instructionsEl.className = "prompt-instructions";
    if (this.instructions.length) { this.renderInstructions(); this.rootEl.append(this.instructionsEl); } else this.instructionsEl = null;
    document.body.append(this.rootEl); document.addEventListener("keydown", this.keyHandler);
  }
  close(): void { document.removeEventListener("keydown", this.keyHandler); this.rootEl?.remove(); this.rootEl = null; this.listEl = null; this.instructionsEl = null; this.activeIndex = -1; }
  setInstructions(instructions: Instruction[]): void {
    this.instructions = instructions.map(({ command, purpose }) => ({ command, purpose }));
    if (!this.rootEl) return;
    if (!this.instructions.length) { this.instructionsEl?.remove(); this.instructionsEl = null; return; }
    if (!this.instructionsEl) { this.instructionsEl = document.createElement("div"); this.instructionsEl.className = "prompt-instructions"; this.rootEl.append(this.instructionsEl); }
    this.renderInstructions();
  }
  private renderInstructions(): void {
    if (!this.instructionsEl) return;
    this.instructionsEl.replaceChildren(...this.instructions.map(({ command, purpose }) => {
      const item = document.createElement("div"); item.className = "prompt-instruction";
      const key = document.createElement("span"); key.className = "prompt-instruction-command"; key.textContent = command;
      const text = document.createElement("span"); text.textContent = purpose;
      item.append(key, text); return item;
    }));
  }
  protected render(values: T[]): void {
    this.values = values;
    if (!this.listEl) this.open();
    this.listEl?.replaceChildren();
    values.forEach((value, index) => {
      const row = document.createElement("div"); row.className = "suggestion-item"; row.setAttribute("role", "option");
      this.renderSuggestion(value, row);
      row.addEventListener("mouseenter", () => this.setActive(index));
      row.addEventListener("mousedown", (event) => { event.preventDefault(); this.selectSuggestion(value, event); });
      this.listEl?.append(row);
    });
    this.setActive(values.length ? 0 : -1);
  }
  protected setActive(index: number): void {
    if (!this.values.length) { this.activeIndex = -1; return; }
    this.activeIndex = (index + this.values.length) % this.values.length;
    this.listEl?.querySelectorAll<HTMLElement>(".suggestion-item").forEach((row, i) => {
      row.classList.toggle("is-selected", i === this.activeIndex);
      if (i === this.activeIndex) row.scrollIntoView?.({ block: "nearest" });
    });
  }
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
  override onunload(): void { this.close(); }
}

export interface EditorSuggestTriggerInfo {
  start: EditorPosition;
  end: EditorPosition;
  query: string;
}
export interface EditorSuggestContext extends EditorSuggestTriggerInfo {
  editor: Editor;
  file: TFile;
}

/** Live editor suggestion owner. Register it with Plugin.registerEditorSuggest. */
export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  context: EditorSuggestContext | null = null;
  limit = 100;
  private attached = false;
  private editor: Editor | null = null;
  private generation = 0;
  private readonly updateHandler = (editor: Editor) => { void this.update(editor); };
  private readonly workspaceEditorHandler = (editor: unknown) => this.bindEditor(editor);

  constructor(app: App) { super(app); }

  abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null;
  abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;

  /** @internal Called by Plugin.registerEditorSuggest; safe to call more than once. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const workspace = this.app.workspace;
    const onEditorChange = (editor: unknown) => this.workspaceEditorHandler(editor);
    const onActiveLeaf = () => this.bindEditor(workspace.activeEditor);
    const onFileChange = () => { if (this.editor) void this.update(this.editor); };
    this.registerEvent(workspace.on("editor-change", onEditorChange));
    this.registerEvent(workspace.on("active-leaf-change", onActiveLeaf));
    this.registerEvent(workspace.on("file-open", onFileChange));
    this.bindEditor(workspace.activeEditor);
  }

  /** @internal Detaches editor listeners and closes any visible popover. */
  detach(): void {
    this.generation++;
    this.unload();
    this.unbindEditor();
    this.context = null;
    this.close();
  }

  override close(): void {
    if (this.context) { this.context = null; this.generation++; }
    super.close();
  }

  private bindEditor(candidate: unknown): void {
    const next = candidate && typeof candidate === "object" && "onUpdate" in candidate && "getCursor" in candidate
      ? candidate as Editor : null;
    if (this.editor === next) { if (next) void this.update(next); return; }
    this.unbindEditor();
    this.editor = next;
    if (next) next.onUpdate(this.updateHandler);
    else this.clearContext();
    if (next) void this.update(next);
  }

  private unbindEditor(): void {
    if (!this.editor) return;
    this.editor.offUpdate(this.updateHandler);
    this.editor = null;
    this.clearContext();
  }

  private clearContext(): void {
    this.generation++;
    this.context = null;
    this.values = [];
    super.close();
  }

  private async update(editor: Editor): Promise<void> {
    if (!this.attached || this.editor !== editor || !editor.hasFocus()) { this.clearContext(); return; }
    const file = this.app.workspace.getActiveFile() as TFile | null;
    let trigger: EditorSuggestTriggerInfo | null;
    try { trigger = this.onTrigger(editor.getCursor(), editor, file); }
    catch (error) { this.clearContext(); console.error("Editor suggestion trigger failed", error); return; }
    if (!trigger || !file || !validTrigger(trigger, editor)) { this.clearContext(); return; }
    const context: EditorSuggestContext = {
      start: { ...trigger.start }, end: { ...trigger.end }, query: trigger.query,
      editor, file,
    };
    this.context = context;
    const generation = ++this.generation;
    try {
      const suggestions = await this.getSuggestions(context);
      if (generation !== this.generation || this.context !== context || this.editor !== editor) return;
      const values = this.limit > 0 ? suggestions.slice(0, this.limit) : suggestions;
      if (!values.length) { this.values = []; super.close(); return; }
      this.render(values);
    } catch (error) {
      if (generation === this.generation) { this.values = []; this.close(); }
      console.error("Editor suggestion query failed", error);
    }
  }

  override onunload(): void { this.generation++; this.unbindEditor(); super.onunload(); }
}

function validTrigger(trigger: EditorSuggestTriggerInfo, editor: Editor): boolean {
  if (!trigger || typeof trigger.query !== "string" || !trigger.start || !trigger.end) return false;
  for (const position of [trigger.start, trigger.end]) {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.ch) || position.line < 0 || position.line > editor.lastLine() || position.ch < 0 || position.ch > editor.getLine(position.line).length) return false;
  }
  const start = editor.posToOffset(trigger.start), end = editor.posToOffset(trigger.end);
  return start <= end && end <= editor.getValue().length;
}

/** Renders `text` with the matched ranges wrapped in the reference highlight span; `offset` shifts the ranges. */
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatches | null | undefined, offset = 0): void {
  const doc = el.ownerDocument ?? document;
  if (!matches?.length) { el.append(doc.createTextNode(text)); return; }
  let cursor = 0;
  for (let index = 0; cursor < text.length && index < matches.length; index++) {
    let start = matches[index][0] + offset;
    const end = matches[index][1] + offset;
    if (end <= 0) continue;
    if (start >= text.length) break;
    if (start < 0) start = 0;
    if (start !== cursor) el.append(doc.createTextNode(text.substring(cursor, start)));
    const highlight = doc.createElement("span"); highlight.className = "suggestion-highlight"; highlight.textContent = text.substring(start, end);
    el.append(highlight); cursor = end;
  }
  if (cursor < text.length) el.append(doc.createTextNode(text.substring(cursor)));
}
export function renderResults(el: HTMLElement, text: string, result: SearchResult | null | undefined, offset = 0): void { renderMatches(el, text, result?.matches ?? null, offset); }

/** @internal What a suggestion list reports back to its owner. */
export interface SuggestOwner<T> {
  renderSuggestion(value: T, el: HTMLElement): void;
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
  onSelectedChange?(value: T, evt: MouseEvent | KeyboardEvent | null): void;
}

/** @internal The suggestion list of a prompt: rows, the selected row, and the keys and clicks that move or use it. */
export class SuggestChooser<T> {
  values: T[] | null = [];
  suggestions: HTMLElement[] = [];
  selectedItem = 0;
  selectOnHover = true;
  constructor(private readonly owner: SuggestOwner<T>, readonly containerEl: HTMLElement, scope: Scope) {
    const row = (event: Event) => (event.target as Element | null)?.closest?.<HTMLElement>(".suggestion-item") ?? null;
    const click = (event: MouseEvent) => { const el = row(event); if (el && containerEl.contains(el)) this.onSuggestionClick(event, el); };
    containerEl.addEventListener("click", click); containerEl.addEventListener("auxclick", click);
    containerEl.addEventListener("mousemove", event => { const el = row(event); if (el && this.selectOnHover && this.suggestions[this.selectedItem] !== el) this.setSelectedItem(this.suggestions.indexOf(el), event); });
    const key = (handler: (event: KeyboardEvent) => void) => (event: KeyboardEvent) => { if (event.isComposing) return; handler(event); return false; };
    const moveUp = key(event => this.setSelectedItem(this.selectedItem - 1, event)), moveDown = key(event => this.setSelectedItem(this.selectedItem + 1, event));
    scope.register([], "ArrowUp", moveUp); scope.register([], "ArrowDown", moveDown);
    scope.register([], "PageUp", key(event => this.page(-1, event))); scope.register([], "PageDown", key(event => this.page(1, event)));
    scope.register([], "Home", event => { this.setSelectedItem(0, event); return false; });
    scope.register([], "End", event => { this.setSelectedItem(this.suggestions.length - 1, event); return false; });
    scope.register(["Ctrl"], "P", moveUp); scope.register(["Ctrl"], "N", moveDown);
    scope.register([], "Enter", key(event => { this.useSelectedItem(event); }));
  }
  getSelectedValue(): T | null { return this.values?.[this.selectedItem] ?? null; }
  private page(direction: 1 | -1, event: KeyboardEvent): void {
    const el = this.containerEl, rowHeight = this.suggestions[this.selectedItem]?.clientHeight;
    if (!rowHeight) return;
    const visible = Math.floor(el.clientHeight / rowHeight);
    const top = Math.floor((el.scrollTop - (parseFloat(getComputedStyle(el).paddingTop) || 0)) / rowHeight);
    if (direction < 0) { let target = top; if (this.selectedItem <= target) target -= visible; this.setSelectedItem(Math.max(0, target), event); }
    else { let target = top + (visible - 1); if (this.selectedItem >= target) target += visible; this.setSelectedItem(Math.min(this.suggestions.length - 1, target), event); }
  }
  setSuggestions(values: T[] | null): void {
    this.values = values;
    this.containerEl.replaceChildren();
    this.suggestions = (values ?? []).map(value => {
      const el = this.containerEl.ownerDocument.createElement("div"); el.className = "suggestion-item";
      this.containerEl.append(el); this.owner.renderSuggestion(value, el);
      return el;
    });
    this.selectedItem = 0;
    this.setSelectedItem(0, null);
  }
  addMessage(text: string): HTMLElement {
    const el = this.containerEl.ownerDocument.createElement("div"); el.className = "suggestion-empty"; el.textContent = text;
    this.containerEl.append(el); return el;
  }
  setSelectedItem(index: number, event: MouseEvent | KeyboardEvent | null): void {
    const rows = this.suggestions;
    if (!rows.length) return;
    if (index < 0) index = rows.length - 1; else if (index >= rows.length) index = 0;
    rows[this.selectedItem]?.classList.remove("is-selected");
    this.selectedItem = index;
    const selected = rows[index];
    selected.classList.add("is-selected");
    // The pointer is already over the row it selects; only keys (and a fresh list) scroll.
    if (!event || event.type.startsWith("key")) selected.scrollIntoView?.({ block: "nearest" });
    if (this.values) this.owner.onSelectedChange?.(this.values[index], event);
  }
  private onSuggestionClick(event: MouseEvent, el: HTMLElement): void {
    if (event.defaultPrevented) return;
    event.preventDefault();
    this.setSelectedItem(this.suggestions.indexOf(el), event);
    this.useSelectedItem(event);
  }
  useSelectedItem(event: MouseEvent | KeyboardEvent): boolean {
    if (!this.values) return false;
    const value = this.values[this.selectedItem];
    if (value === undefined) return false;
    this.owner.selectSuggestion(value, event);
    return true;
  }
}

export abstract class SuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = t("setting.third-party-plugin.label-no-results-found");
  readonly inputEl: HTMLInputElement;
  readonly resultContainerEl: HTMLElement;
  /** @internal */ readonly ctaEl: HTMLElement;
  /** @internal */ readonly clearButtonEl: HTMLElement;
  /** @internal */ readonly instructionsEl: HTMLElement;
  /** @internal */ readonly chooser: SuggestChooser<T>;
  private searchGeneration = 0;
  constructor(app: App) {
    super(app);
    // A prompt replaces the standard modal frame with the input, results and instruction rows.
    this.modalEl.classList.remove("modal"); this.modalEl.classList.add("prompt");
    this.modalEl.replaceChildren();
    const inputContainer = document.createElement("div"); inputContainer.className = "prompt-input-container mod-raised";
    const input = this.inputEl = document.createElement("input"); input.className = "prompt-input"; input.type = "text";
    input.setAttribute("autocapitalize", "off"); input.setAttribute("spellcheck", "false"); input.setAttribute("enterkeyhint", "done");
    this.ctaEl = document.createElement("div"); this.ctaEl.className = "prompt-input-cta";
    const clear = this.clearButtonEl = document.createElement("div"); clear.className = "search-input-clear-button";
    clear.addEventListener("mousedown", event => { if (input.value !== "") event.preventDefault(); });
    clear.addEventListener("click", () => { if (input.value !== "") { input.value = ""; this.onInput(); } else this.close(); });
    inputContainer.append(input, this.ctaEl, clear);
    this.resultContainerEl = document.createElement("div"); this.resultContainerEl.className = "prompt-results";
    this.instructionsEl = document.createElement("div"); this.instructionsEl.className = "prompt-instructions";
    this.modalEl.append(inputContainer, this.resultContainerEl);
    this.chooser = new SuggestChooser<T>(this, this.resultContainerEl, this.scope);
    input.addEventListener("input", () => this.onInput());
    // The app keymap only hears the main window; the input forwards keys so a prompt also works in a pop-out. Each event runs the scope once.
    const scope = this.scope, handle = scope.handleKey.bind(scope), seen = new WeakSet<KeyboardEvent>();
    scope.handleKey = event => { if (seen.has(event)) return false; seen.add(event); return handle(event); };
    input.addEventListener("keydown", event => { scope.handleKey(event); });
  }
  override onOpen(): Promise<void> | void { this.inputEl.value = ""; this.inputEl.focus(); this.updateSuggestions(); }
  override onClose(): void { this.searchGeneration++; }
  setPlaceholder(placeholder: string): void { this.inputEl.placeholder = placeholder; }
  setInstructions(instructions: Instruction[]): void {
    this.instructionsEl.replaceChildren(...instructions.map((instruction) => {
      const item = document.createElement("div"); item.className = "prompt-instruction";
      const command = document.createElement("span"); command.className = "prompt-instruction-command"; command.textContent = instruction.command;
      const purpose = document.createElement("span"); purpose.textContent = instruction.purpose;
      item.append(command, purpose); return item;
    }));
    if (instructions.length) this.modalEl.append(this.instructionsEl); else this.instructionsEl.remove();
  }
  /** @internal */ onInput(): void { this.updateSuggestions(); }
  /** @internal */
  updateSuggestions(): void {
    const generation = ++this.searchGeneration;
    const show = (values: T[] | null | undefined) => {
      if (generation !== this.searchGeneration) return;
      if (!values?.length) { this.onNoSuggestion(); return; }
      this.chooser.setSuggestions(this.limit > 0 ? values.slice(0, this.limit) : values);
    };
    try {
      const result = this.getSuggestions(this.inputEl.value);
      if (Array.isArray(result)) show(result);
      else void result.then(show, error => { console.error("Suggestion query failed", error); show(null); });
    } catch (error) { console.error("Suggestion query failed", error); show(null); }
  }
  onNoSuggestion(): void { this.chooser.setSuggestions(null); this.chooser.addMessage(this.emptyStateText); }
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void { this.close(); this.onChooseSuggestion(value, evt); }
  selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void { this.chooser.useSelectedItem(evt); }
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  /** @internal */ sortSuggestions(results: FuzzyMatch<T>[]): void { sortSearchResults(results); }
  override getSuggestions(query: string): FuzzyMatch<T>[] {
    const prepared = prepareQuery(query.trim()), results: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) { const match = fuzzySearch(prepared, this.getItemText(item)); if (match) results.push({ match, item }); }
    this.sortSuggestions(results);
    return results;
  }
  override renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void { this.renderFuzzyMatch(value, el); }
  renderFuzzyMatch(value: FuzzyMatch<T>, el: HTMLElement): void { renderResults(el, this.getItemText(value.item), value.match); }
  override onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void { this.onChooseItem(item.item, evt); }
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

/** Lightweight wrapper for input controls that supports an attached picker. */
export class SuggestComponent extends BaseComponent {
  readonly inputEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) { super(); this.inputEl = document.createElement("input"); this.inputEl.type = "text"; this.inputEl.className = "setting-input"; containerEl.append(this.inputEl); }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.inputEl.addEventListener("change", () => callback(this.getValue())); return this; }
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  private readonly selectCallbacks: Array<(value: T, evt: MouseEvent | KeyboardEvent) => unknown> = [];
  private readonly onInput = () => void this.update();
  constructor(app: App, readonly textInputEl: HTMLInputElement | HTMLDivElement) {
    super(app);
    textInputEl.addEventListener("input", this.onInput);
    this.register(() => textInputEl.removeEventListener("input", this.onInput));
    this.registerDomEvent(textInputEl, "keydown", (event) => this.keyHandler(event as KeyboardEvent));
  }
  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
  setValue(value: string): void { if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value; else this.textInputEl.textContent = value; }
  getValue(): string { return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : (this.textInputEl.textContent ?? ""); }
  onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this { this.selectCallbacks.push(callback); return this; }
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void { for (const callback of this.selectCallbacks) callback(value, evt); this.close(); }
  private generation = 0;
  private async update(): Promise<void> {
    const generation = ++this.generation;
    const query = this.getValue();
    if (!query) { this.close(); return; }
    const suggestions = await this.getSuggestions(query);
    if (generation !== this.generation) return;
    const rows = this.limit > 0 ? suggestions.slice(0, this.limit) : suggestions;
    if (!rows.length) { this.close(); return; }
    this.open(); this.render(rows);
  }
}
