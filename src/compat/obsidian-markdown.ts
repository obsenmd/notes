import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, foldable, foldedRanges, foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { GFM, type InlineContext, type MarkdownConfig } from "@lezer/markdown";
import { t } from "../i18n";
import { HIGHLIGHT_MARKERS, highlightColor } from "./highlight";
import { renderMathInto } from "./math";
import { FENCE_OPEN, codeLanguageName, codeLineTokens } from "./editor-code-languages";
import { mountMermaid } from "./mermaid";
import { Menu, Notice } from "./ui";
import { setIcon, setTooltip } from "./utilities";

/*
 * Markdown syntax for the editor: CommonMark + GFM, extended with the wiki-style
 * constructs (links, embeds, highlights, tags, comments, math, block ids, footnotes). Tokens are tagged with the reference stylesheet's class names so the
 * stock theme CSS applies; Live Preview additionally hides markup away from the cursor.
 */

const HighlightDelimiter = { resolve: "Highlight", mark: "HighlightMark" };
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13 || code < 0;
const TAG_CHAR = /[^ -⁯⸀-⹿'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]/;

function closing(cx: InlineContext, from: number, token: string): number {
  const index = cx.slice(from, cx.end).indexOf(token);
  return index < 0 ? -1 : from + index;
}

const wikiSyntax: MarkdownConfig = {
  defineNodes: ["WikiLink", "WikiLinkMark", "WikiLinkTarget", "WikiLinkPipe", "WikiLinkAlias", "WikiEmbed", "Highlight", "HighlightMark", "Hashtag", "InlineComment", "CommentMark", "InlineMath", "MathBlock", "MathMark", "BlockId", "FootnoteRef", "InlineFootnote", "FootnoteMark"],
  parseBlock: [
    // Display math fenced by lines that open and close with `$$`; unlike inline math it may hold blank lines.
    { name: "MathBlock", before: "FencedCode", parse(cx, line) {
      const open = /^(\${2,})[ \t]*[^$]*$/.exec(line.text.slice(line.pos));
      if (!open) return false;
      const from = cx.lineStart + line.pos, depth = cx.depth;
      const marks = [cx.elt("MathMark", from, from + open[1].length)];
      while (cx.nextLine() && (line as unknown as { depth: number }).depth >= depth) {
        marks.push(...line.markers);
        const close = /^[^$]*?(\${2,})[ \t]*$/.exec(line.text.slice(line.pos));
        if (!close || close[1].length < open[1].length) continue;
        const end = cx.lineStart + line.text.replace(/[ \t]+$/, "").length;
        marks.push(cx.elt("MathMark", end - close[1].length, end));
        cx.nextLine(); break;
      }
      cx.addElement(cx.elt("MathBlock", from, cx.prevLineEnd(), marks));
      return true;
    } },
  ],
  parseInline: [
    { name: "WikiEmbed", before: "Image", parse(cx, next, pos) {
      if (next !== 33 || cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
      const end = closing(cx, pos + 3, "]]");
      if (end < 0 || cx.slice(pos + 3, end).includes("\n")) return -1;
      return cx.addElement(cx.elt("WikiEmbed", pos, end + 2, [cx.elt("WikiLinkMark", pos, pos + 3), cx.elt("WikiLinkTarget", pos + 3, end), cx.elt("WikiLinkMark", end, end + 2)]));
    } },
    { name: "WikiLink", before: "Link", parse(cx, next, pos) {
      if (next !== 91 || cx.char(pos + 1) !== 91) return -1;
      const end = closing(cx, pos + 2, "]]");
      if (end < 0 || end === pos + 2 || cx.slice(pos + 2, end).includes("\n")) return -1;
      const pipe = cx.slice(pos + 2, end).indexOf("|");
      const children = [cx.elt("WikiLinkMark", pos, pos + 2)];
      if (pipe < 0) children.push(cx.elt("WikiLinkTarget", pos + 2, end));
      else children.push(cx.elt("WikiLinkTarget", pos + 2, pos + 2 + pipe), cx.elt("WikiLinkPipe", pos + 2 + pipe, pos + 3 + pipe), cx.elt("WikiLinkAlias", pos + 3 + pipe, end));
      children.push(cx.elt("WikiLinkMark", end, end + 2));
      return cx.addElement(cx.elt("WikiLink", pos, end + 2, children));
    } },
    { name: "FootnoteRef", before: "Link", parse(cx, next, pos) {
      if (next !== 91 || cx.char(pos + 1) !== 94) return -1;
      const end = closing(cx, pos + 2, "]");
      if (end < 0 || end === pos + 2 || /[\s\]]/.test(cx.slice(pos + 2, end))) return -1;
      return cx.addElement(cx.elt("FootnoteRef", pos, end + 1, [cx.elt("FootnoteMark", pos, pos + 2), cx.elt("FootnoteMark", end, end + 1)]));
    } },
    { name: "InlineFootnote", before: "Link", parse(cx, next, pos) {
      if (next !== 94 || cx.char(pos + 1) !== 91) return -1;
      let end = pos + 2;
      for (let depth = 1; end < cx.end; end++) {
        const code = cx.char(end);
        if (code === 92) end++;
        else if (code === 91) depth++;
        else if (code === 93 && --depth === 0) break;
      }
      if (end >= cx.end) return -1;
      return cx.addElement(cx.elt("InlineFootnote", pos, end + 1, [cx.elt("FootnoteMark", pos, pos + 2), cx.elt("FootnoteMark", end, end + 1)]));
    } },
    { name: "Highlight", parse(cx, next, pos) {
      if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.char(pos - 1), after = cx.char(pos + 2);
      return cx.addDelimiter(HighlightDelimiter, pos, pos + 2, !isSpace(after), !isSpace(before));
    } },
    { name: "InlineComment", parse(cx, next, pos) {
      if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
      const end = closing(cx, pos + 2, "%%");
      if (end < 0) return -1;
      return cx.addElement(cx.elt("InlineComment", pos, end + 2, [cx.elt("CommentMark", pos, pos + 2), cx.elt("CommentMark", end, end + 2)]));
    } },
    { name: "InlineMath", parse(cx, next, pos) {
      if (next !== 36) return -1;
      const double = cx.char(pos + 1) === 36, size = double ? 2 : 1;
      if (!double && (isSpace(cx.char(pos + 1)) || /\d/.test(String.fromCharCode(cx.char(pos - 1) < 0 ? 32 : cx.char(pos - 1))))) return -1;
      const end = closing(cx, pos + size, double ? "$$" : "$");
      if (end < 0 || end === pos + size || (!double && (cx.slice(pos + 1, end).includes("\n") || isSpace(cx.char(end - 1))))) return -1;
      return cx.addElement(cx.elt("InlineMath", pos, end + size, [cx.elt("MathMark", pos, pos + size), cx.elt("MathMark", end, end + size)]));
    } },
    { name: "Hashtag", parse(cx, next, pos) {
      if (next !== 35 || !isSpace(cx.char(pos - 1))) return -1;
      let end = pos + 1;
      while (end < cx.end && TAG_CHAR.test(String.fromCharCode(cx.char(end)))) end++;
      const body = cx.slice(pos + 1, end);
      if (!body || /^\d+$/.test(body)) return -1;
      return cx.addElement(cx.elt("Hashtag", pos, end));
    } },
    { name: "BlockId", parse(cx, next, pos) {
      if (next !== 94 || !isSpace(cx.char(pos - 1))) return -1;
      const rest = cx.slice(pos + 1, cx.end);
      const match = /^[A-Za-z0-9-]+(?=\s*$|\s*\n)/.exec(rest);
      return match ? cx.addElement(cx.elt("BlockId", pos, pos + 1 + match[0].length)) : -1;
    } },
  ],
};

export const obsidianMarkdownLanguage = markdown({ base: markdownLanguage, extensions: [GFM, wikiSyntax], addKeymap: false });

export interface FrontmatterRange { from: number; to: number; contentFrom: number; contentTo: number }
/** Range of a leading YAML block (`---` … `---`), including its closing fence line. */
export function frontmatterRange(doc: { toString(): string; length: number; sliceString(from: number, to?: number): string }): FrontmatterRange | null {
  if (doc.sliceString(0, 4) !== "---\n" && doc.sliceString(0, 5) !== "---\r\n") return null;
  const text = doc.sliceString(0, Math.min(doc.length, 64 * 1024));
  const match = /^---\r?\n([\s\S]*?)\r?\n?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const contentFrom = text.indexOf("\n") + 1;
  return { from: 0, to: match[0].length, contentFrom, contentTo: contentFrom + match[1].length };
}

export interface LivePreviewHost {
  /** Renders Markdown into an element with the reading-view renderer. */
  renderMarkdown(source: string, el: HTMLElement): void;
  /** Resolves an embed target to a displayable URL when it is an image. */
  resolveImage(target: string): string | null;
  isResolved(target: string): boolean;
  openLink(target: string, event: MouseEvent): void;
  openTag(tag: string): void;
  hoverLink?(target: string, event: MouseEvent, el: HTMLElement): void;
  /** Whether this vault may render Mermaid diagrams. Absent hosts leave the fence as source. */
  mermaidAllowed?(): boolean;
  /** Records that choice and asks open notes to render their diagrams. */
  allowMermaid?(): void;
}

/** Asks Live Preview to rebuild after the Mermaid choice changes. */
export const refreshMarkdownDecorations = StateEffect.define<null>();

export interface MarkdownDecorationOptions {
  livePreview: boolean;
  /** Hide the leading YAML block (it is shown in the properties panel instead). */
  hideFrontmatter: boolean;
  host: LivePreviewHost;
}

const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, attributes });
const line = (cls: string, attributes?: Record<string, string>) => Decoration.line({ class: cls, attributes });
const hidden = Decoration.replace({});
const formatting = (cls: string) => Decoration.mark({ class: `cm-formatting ${cls}`, attributes: { spellcheck: "false" } });

class HeadingFoldWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly collapsed: boolean) { super(); }
  eq(other: HeadingFoldWidget) { return other.from === this.from && other.to === this.to && other.collapsed === this.collapsed; }
  toDOM(view: EditorView) {
    const indicator = document.createElement("div");
    indicator.className = `cm-fold-indicator${this.collapsed ? " is-collapsed" : ""}`;
    indicator.contentEditable = "false";
    const icon = document.createElement("div");
    icon.className = `collapse-indicator collapse-icon${this.collapsed ? " is-collapsed" : ""}`;
    setIcon(icon, "right-triangle");
    indicator.append(icon);
    indicator.addEventListener("mousedown", event => event.preventDefault());
    indicator.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: (this.collapsed ? unfoldEffect : foldEffect).of({ from: this.from, to: this.to }) });
    });
    return indicator;
  }
  ignoreEvent() { return true; }
}
class BulletWidget extends WidgetType {
  constructor(readonly text: string, readonly level: number) { super(); }
  eq(other: BulletWidget) { return other.text === this.text && other.level === this.level; }
  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-formatting cm-formatting-list cm-formatting-list-ul cm-list-${this.level}`;
    const bullet = document.createElement("span"); bullet.className = "list-bullet"; bullet.textContent = this.text;
    wrapper.append(bullet, " ");
    return wrapper;
  }
  ignoreEvent() { return false; }
}
class CheckboxWidget extends WidgetType {
  constructor(readonly status: string, readonly pos: number) { super(); }
  eq(other: CheckboxWidget) { return other.status === this.status && other.pos === this.pos; }
  toDOM(view: EditorView) {
    const label = document.createElement("label"); label.className = "task-list-label"; label.contentEditable = "false";
    const input = document.createElement("input"); input.type = "checkbox"; input.className = "task-list-item-checkbox";
    input.checked = this.status !== " "; input.dataset.task = this.status;
    input.addEventListener("mousedown", event => event.preventDefault());
    input.addEventListener("click", event => {
      event.preventDefault();
      const at = view.posAtDOM(label), text = view.state.doc.sliceString(at, at + 3);
      if (/^\[.\]$/.test(text)) view.dispatch({ changes: { from: at + 1, to: at + 2, insert: text[1] === " " ? "x" : " " } });
    });
    label.append(input);
    return label;
  }
  ignoreEvent() { return true; }
}
class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return document.createElement("hr"); }
  ignoreEvent() { return false; }
}
class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width: string) { super(); }
  eq(other: ImageWidget) { return other.src === this.src && other.alt === this.alt && other.width === this.width; }
  toDOM() {
    const wrapper = document.createElement("div"); wrapper.className = "internal-embed media-embed image-embed is-loaded"; wrapper.contentEditable = "false";
    const image = document.createElement("img"); image.src = this.src; image.alt = this.alt;
    if (this.width) image.width = Number(this.width);
    wrapper.append(image);
    return wrapper;
  }
  ignoreEvent() { return false; }
}
// Menu titles for the highlight colours, keyed like HIGHLIGHT_MARKERS.
const HIGHLIGHT_LABELS: Record<string, string> = {
  red: "interface.formatting.highlight-color.red", orange: "interface.formatting.highlight-color.orange", yellow: "interface.formatting.highlight-color.yellow",
  green: "interface.formatting.highlight-color.green", blue: "interface.formatting.highlight-color.blue", purple: "interface.formatting.highlight-color.purple",
};
/** Stands in for a highlight's colour emoji while its markup is revealed; a click picks another colour. */
class HighlightColorWidget extends WidgetType {
  constructor(readonly color: string) { super(); }
  eq(other: HighlightColorWidget) { return other.color === this.color; }
  toDOM(view: EditorView) {
    const wrapper = document.createElement("span"); wrapper.className = "cm-highlight-color-widget"; wrapper.dataset.highlight = this.color;
    const swatch = document.createElement("img"); swatch.className = "highlight-swatch"; swatch.draggable = false; swatch.dataset.highlight = this.color;
    swatch.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
    wrapper.append(swatch, "\u200b");
    const modified = (event: MouseEvent) => event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
    wrapper.addEventListener("mousedown", event => { if (!modified(event)) event.preventDefault(); });
    wrapper.addEventListener("click", event => {
      if (modified(event) || !view.state.selection.main.empty) return;
      const at = view.posAtDOM(wrapper);
      const setColor = (color: string) => view.dispatch({ changes: { from: at, to: at + highlightColor(view.state.doc.sliceString(at, at + 2)).length, insert: HIGHLIGHT_MARKERS[color] ?? "" }, userEvent: "input.type" });
      const menu = new Menu();
      menu.addItem(item => item.setTitle(t("interface.formatting.highlight-color-default")).setIcon("lucide-highlighter").setChecked(this.color === "").onClick(() => setColor("")));
      for (const color of Object.keys(HIGHLIGHT_MARKERS)) menu.addItem(item => item.setTitle(t(HIGHLIGHT_LABELS[color])).setChecked(this.color === color).onClick(() => setColor(color)));
      menu.showAtMouseEvent(event);
    });
    return wrapper;
  }
  ignoreEvent() { return false; }
}
/** Rendered TeX: `span.math` for `$…$`, `div.math.math-block.cm-embed-block` for `$$…$$`. */
class MathWidget extends WidgetType {
  constructor(readonly source: string, readonly display: boolean) { super(); }
  eq(other: MathWidget) { return other.source === this.source && other.display === this.display; }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span"); el.className = this.display ? "math math-block cm-embed-block" : "math"; el.contentEditable = "false";
    const edit = this.display ? document.createElement("div") : null;
    if (edit) { edit.className = "edit-block-button"; el.append(document.createElement("br"), document.createElement("br")); }
    renderMathInto(el, this.source, this.display, () => { if (edit) el.append(edit); view.requestMeasure(); });
    // A click places the cursor at the formula, which reveals its source for editing.
    el.addEventListener("mousedown", event => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) }, scrollIntoView: true }); view.focus();
    });
    return el;
  }
  ignoreEvent() { return true; }
}
/** Language name in the corner of a fence whose markers are hidden; a click copies the code. */
class CodeFlairWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string) { super(); }
  eq(other: CodeFlairWidget) { return other.lang === this.lang && other.code === this.code; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "code-block-flair";
    if (this.lang) el.textContent = this.lang;
    else setIcon(el, "lucide-copy");
    setTooltip(el, t("interface.menu.copy"));
    el.addEventListener("click", () => {
      const text = this.code.endsWith("\n") ? this.code.slice(0, -1) : this.code;
      void navigator.clipboard.writeText(text).then(() => new Notice(t("interface.copied_generic")));
    });
    return el;
  }
  ignoreEvent() { return false; }
}
const widgetResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
/** Live Preview rendering of a fence whose language draws something (Mermaid), shown while the cursor is outside it. */
class CodeBlockWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string, readonly allowed: boolean, readonly host: LivePreviewHost) { super(); }
  eq(other: CodeBlockWidget) { return other.lang === this.lang && other.code === this.code && other.allowed === this.allowed; }
  get estimatedHeight() { return 50; }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = `cm-preview-code-block cm-embed-block markdown-rendered cm-lang-${this.lang}`;
    el.tabIndex = -1;
    el.contentEditable = "false";
    mountMermaid(el, this.code, this.allowed, () => {
      this.host.allowMermaid?.();
      view.dispatch({ effects: refreshMarkdownDecorations.of(null) });
    });
    const actions = el.appendChild(document.createElement("div"));
    actions.className = "embed-actions";
    const edit = actions.appendChild(document.createElement("div"));
    edit.className = "embed-action edit-block-button";
    setIcon(edit, "lucide-code-2");
    setTooltip(edit, t("editor.menu.label-edit-block"));
    // Selecting the code reveals the fence for editing.
    edit.addEventListener("click", () => {
      try {
        const start = Math.min(view.state.doc.length, view.state.doc.lineAt(view.posAtDOM(el)).to + 1);
        view.focus();
        view.dispatch({ selection: { head: start, anchor: Math.min(view.state.doc.length, start + this.code.length) }, scrollIntoView: true });
      } catch { /* the widget was removed meanwhile */ }
    });
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(el, { box: "border-box" });
    widgetResizeObservers.set(el, observer);
    return el;
  }
  destroy(dom: HTMLElement) { widgetResizeObservers.get(dom)?.disconnect(); }
  ignoreEvent() { return true; }
}
class RenderedBlockWidget extends WidgetType {
  constructor(readonly source: string, readonly kind: string, readonly host: LivePreviewHost, readonly from: number) { super(); }
  eq(other: RenderedBlockWidget) { return other.source === this.source && other.kind === this.kind; }
  toDOM(view: EditorView) {
    const block = document.createElement("div"); block.className = `cm-embed-block markdown-rendered cm-${this.kind}`; block.contentEditable = "false";
    this.host.renderMarkdown(this.source, block);
    if (this.kind === "table-widget") {
      // The reference table widget pads cells through a wrapper element.
      const table = block.querySelector("table");
      if (table) {
        const wrapper = document.createElement("div"); wrapper.className = "table-wrapper";
        table.classList.add("table-editor"); table.before(wrapper); wrapper.append(table);
        for (const cell of table.querySelectorAll("th, td")) { const inner = document.createElement("div"); inner.className = "table-cell-wrapper"; inner.append(...cell.childNodes); cell.append(inner); }
      }
    }
    const edit = document.createElement("div"); edit.className = "edit-block-button";
    block.append(edit);
    // A click places the cursor inside the block, which reveals its source for editing.
    block.addEventListener("mousedown", event => {
      if ((event.target as HTMLElement).closest("a, input, button, .callout-fold")) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(block) }, scrollIntoView: true }); view.focus();
    });
    return block;
  }
  ignoreEvent() { return true; }
}

const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
/** A closed top-level fence that Live Preview replaces with a rendering while the cursor is outside it. */
function renderedFence(state: EditorState, node: SyntaxNode, options: MarkdownDecorationOptions): { from: number; to: number; lang: string; code: string } | null {
  if (!options.livePreview || !options.host.mermaidAllowed || node.parent?.name !== "Document") return null;
  const open = state.doc.lineAt(node.from), close = state.doc.lineAt(node.to);
  if (close.number === open.number || !FENCE_CLOSE.test(close.text)) return null;
  const lang = FENCE_OPEN.exec(open.text)?.[2] ?? "";
  if (lang !== "mermaid" || touches(state, open.from, close.to)) return null;
  const codeFrom = open.to + 1;
  return { from: open.from, to: close.to, lang, code: state.doc.sliceString(codeFrom, Math.max(codeFrom, close.from - 1)) };
}

const LIST_PREFIX = /^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?/;
/**
 * The reference's indentation guides: each tab or run of four spaces at the start of a line is a
 * `cm-indent` (`cm-active-indent` for the level that encloses the cursor's block), shorter runs are
 * `cm-indent-spacing`. Returns the marks for one line.
 */
function indentGuides(state: EditorState): (current: { from: number; number: number; text: string }) => Array<{ from: number; to: number; cls: string }> {
  const doc = state.doc;
  let anchor = doc.lineAt(state.selection.main.from), prefix = "", hang = "";
  const own = LIST_PREFIX.exec(anchor.text);
  if (own && own[0]) {
    prefix = own[1];
    if (own[2]) hang = " ".repeat(own[2].length);
    else for (let number = anchor.number - 1; number > 0; number--) {
      const candidate = doc.line(number), match = LIST_PREFIX.exec(candidate.text);
      if (!match || !match[0]) break;
      if (match[2] || match[1] !== prefix) {
        const outer = match[1] || "";
        if (match[2] && prefix.startsWith(outer) && match[0].length <= prefix.length) { anchor = candidate; prefix = match[1]; hang = " ".repeat(match[2].length); }
        break;
      }
    }
  }
  let end = anchor.number + 1;
  while (end <= doc.lines) {
    let text = doc.line(end).text;
    if (!text.startsWith(prefix)) break;
    text = text.slice(prefix.length);
    if (hang) { if (text.startsWith(hang)) { end++; continue; } hang = ""; }
    if (!/^(\t| {4})/.test(text)) break;
    end++;
  }
  return current => {
    const marks: Array<{ from: number; to: number; cls: string }> = [], lead = /^[\s>]+/.exec(current.text)?.[0];
    if (!lead) return marks;
    const inside = anchor.number < current.number && current.number < end;
    for (let at = 0; at < lead.length;) {
      const char = lead.charAt(at), start = current.from + at, active = inside && at === prefix.length;
      if (char === ">") { at++; if (lead.charAt(at) === " ") at++; continue; }
      if (char === "\t") at++;
      else {
        let stop = at;
        while (stop < at + 4 && lead.charAt(stop) === " ") stop++;
        if (stop < at + 4) { if (stop > at) marks.push({ from: start, to: current.from + stop, cls: "cm-indent-spacing" }); at = stop + 1; continue; }
        at = stop;
      }
      marks.push({ from: start, to: current.from + at, cls: active ? "cm-indent cm-active-indent" : "cm-indent" });
    }
    return marks;
  };
}

function touches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) if (range.from <= to && range.to >= from) return true;
  return false;
}
function lineTouched(state: EditorState, from: number, to: number): boolean {
  const start = state.doc.lineAt(from).from, end = state.doc.lineAt(to).to;
  return touches(state, start, end);
}

/** TeX between a math node's delimiters. */
function mathSource(state: EditorState, node: SyntaxNode): string {
  const marks = node.getChildren("MathMark");
  return state.doc.sliceString(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to).trim();
}
/** Line range of top-level `$$…$$` math that fills its lines, which Live Preview shows as a block. */
function mathBlockLines(state: EditorState, node: SyntaxNode): { from: number; to: number } | null {
  const container = node.name === "MathBlock" ? node.parent : node.name === "InlineMath" && node.parent?.name === "Paragraph" ? node.parent.parent : null;
  if (container?.name !== "Document" || node.getChildren("MathMark").length < 2 || state.doc.sliceString(node.from, node.from + 2) !== "$$") return null;
  const from = state.doc.lineAt(node.from).from, to = state.doc.lineAt(node.to).to;
  return state.doc.sliceString(from, node.from).trim() || state.doc.sliceString(node.to, to).trim() ? null : { from, to };
}

function listLevel(node: SyntaxNode): number {
  let level = 0;
  for (let parent: SyntaxNode | null = node; parent; parent = parent.parent) if (parent.name === "BulletList" || parent.name === "OrderedList") level++;
  return Math.max(1, level);
}
function quoteLevel(node: SyntaxNode): number {
  let level = 0;
  for (let parent: SyntaxNode | null = node; parent; parent = parent.parent) if (parent.name === "Blockquote") level++;
  return Math.max(1, level);
}

function buildDecorations(view: EditorView, options: MarkdownDecorationOptions): DecorationSet {
  const { state } = view, { livePreview } = options;
  const editorFocused = view.hasFocus;
  const ranges: Range<Decoration>[] = [];
  const frontmatter = frontmatterRange(state.doc);
  const add = (from: number, to: number, decoration: Decoration) => { if (to > from) ranges.push(decoration.range(from, to)); };
  const addLine = (pos: number, decoration: Decoration) => ranges.push(decoration.range(state.doc.lineAt(pos).from));
  const hide = (from: number, to: number) => add(from, to, hidden);
  // `[^id]: …` at the start of a line defines a footnote; Live Preview keeps only the id as a label.
  const footnoteDefinition = (from: number): boolean => {
    const current = state.doc.lineAt(from), match = current.from === from ? /^\[\^([^\]\s]+)\]:/.exec(current.text) : null;
    if (!match) return false;
    const labelFrom = from + 2, labelTo = labelFrom + match[1].length, cls = "cm-link cm-hmd-barelink cm-hmd-footnote";
    addLine(from, line("HyperMD-footnote"));
    add(labelFrom, labelTo, mark(cls, { spellcheck: "false" }));
    if (livePreview && !touches(state, from, labelTo + 2)) { hide(from, labelFrom); add(labelFrom, labelTo, mark("cm-underline")); hide(labelTo, labelTo + 2); }
    else { add(from, labelFrom, formatting(`cm-formatting-link ${cls}`)); add(labelTo, labelTo + 2, formatting(`cm-formatting-link ${cls}`)); }
    return true;
  };

  for (const visible of view.visibleRanges) {
    if (frontmatter && visible.from < frontmatter.to) {
      for (let pos = Math.max(visible.from, 0); pos < Math.min(frontmatter.to, visible.to);) {
        const current = state.doc.lineAt(pos);
        const fence = current.from === 0 || current.to >= frontmatter.contentTo;
        ranges.push(line(`HyperMD-frontmatter HyperMD-frontmatter-bg${current.from === 0 ? " HyperMD-frontmatter-begin HyperMD-frontmatter-begin-bg" : ""}${fence && current.from !== 0 ? " HyperMD-frontmatter-end HyperMD-frontmatter-end-bg" : ""}`).range(current.from));
        if (fence) add(current.from, current.to, mark("cm-def cm-hmd-frontmatter"));
        else {
          const colon = current.text.indexOf(":");
          if (colon > 0 && /^[\w-]/.test(current.text)) { add(current.from, current.from + colon, mark("cm-atom cm-hmd-frontmatter")); add(current.from + colon, current.from + colon + 1, mark("cm-hmd-frontmatter cm-meta")); add(current.from + colon + 1, current.to, mark("cm-hmd-frontmatter cm-string")); }
          else add(current.from, current.to, mark("cm-hmd-frontmatter cm-string"));
        }
        pos = current.to + 1;
      }
    }
    syntaxTree(state).iterate({
      from: visible.from, to: visible.to,
      enter: cursor => {
        const { name, from, to } = cursor;
        if (frontmatter && from < frontmatter.to) return name === "Document" ? undefined : false;
        const node = cursor.node;
        const revealed = !livePreview || (editorFocused && touches(state, from, to));
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          const level = heading[1];
          addLine(from, line(`HyperMD-header HyperMD-header-${level}`));
          const headingLine = state.doc.lineAt(from);
          const fold = foldable(state, headingLine.from, headingLine.to);
          if (fold) {
            let collapsed = false;
            foldedRanges(state).between(fold.from, fold.to, (start, end) => { if (start === fold.from && end === fold.to) collapsed = true; });
            ranges.push(Decoration.widget({ widget: new HeadingFoldWidget(fold.from, fold.to, collapsed), side: -1 }).range(headingLine.from));
          }
          const markNode = node.getChild("HeaderMark");
          const contentFrom = markNode && name.startsWith("ATX") ? Math.min(to, markNode.to + 1) : from;
          add(contentFrom, to, mark(`cm-header cm-header-${level}`));
          if (markNode && name.startsWith("ATX")) {
            if (livePreview && !(editorFocused && lineTouched(state, from, to))) hide(markNode.from, contentFrom);
            else add(markNode.from, contentFrom, formatting(`cm-formatting-header cm-formatting-header-${level} cm-header cm-header-${level}`));
          }
          return;
        }
        switch (name) {
          case "StrongEmphasis": case "Emphasis": case "Strikethrough": case "Highlight": {
            const cls = name === "StrongEmphasis" ? "strong" : name === "Emphasis" ? "em" : name === "Strikethrough" ? "strikethrough" : "highlight";
            const marks = node.getChildren(name === "Strikethrough" ? "StrikethroughMark" : name === "Highlight" ? "HighlightMark" : "EmphasisMark");
            const inner = marks.length >= 2 ? [marks[0].to, marks[marks.length - 1].from] : [from, to];
            // A colour emoji right after the opening `==` is markup: it tints the highlight and is hidden with the marks.
            const { color, length } = name === "Highlight" && marks.length >= 2 ? highlightColor(state.doc.sliceString(inner[0], Math.min(inner[1], inner[0] + 2))) : { color: "", length: 0 };
            const tint = color ? ` cm-highlight-${color}` : "";
            add(inner[0] + length, inner[1], mark(`cm-${cls}${tint}`));
            for (const item of marks) {
              const marker = item === marks[0] ? length : 0;
              if (!revealed) hide(item.from, item.to + marker);
              else if (marker && livePreview) { add(item.from, item.to, formatting(`cm-formatting-${cls} cm-${cls}${tint}`)); ranges.push(Decoration.replace({ widget: new HighlightColorWidget(color) }).range(item.to, item.to + marker)); }
              else add(item.from, item.to + marker, formatting(`cm-formatting-${cls} cm-${cls}${tint}`));
            }
            return;
          }
          case "InlineCode": {
            const marks = node.getChildren("CodeMark");
            add(marks[0]?.to ?? from, marks[1]?.from ?? to, mark("cm-inline-code", { spellcheck: "false" }));
            for (const item of marks) { if (revealed) add(item.from, item.to, formatting("cm-formatting-code cm-inline-code")); else hide(item.from, item.to); }
            return false;
          }
          case "WikiLink": {
            const target = node.getChild("WikiLinkTarget"), alias = node.getChild("WikiLinkAlias"), pipe = node.getChild("WikiLinkPipe");
            const marks = node.getChildren("WikiLinkMark");
            const linkText = target ? state.doc.sliceString(target.from, target.to) : "";
            const unresolved = !options.host.isResolved(linkText.split("#")[0] || linkText);
            const link = mark(`cm-hmd-internal-link${unresolved ? " is-unresolved" : ""}`, { "data-link-target": linkText });
            if (revealed) {
              if (marks[0]) add(marks[0].from, marks[0].to, formatting("cm-formatting-link cm-formatting-link-start"));
              if (target) add(target.from, target.to, alias ? mark(`cm-hmd-internal-link cm-link-has-alias${unresolved ? " is-unresolved" : ""}`, { "data-link-target": linkText }) : link);
              if (pipe) add(pipe.from, pipe.to, mark("cm-hmd-internal-link cm-link-alias-pipe"));
              if (alias) add(alias.from, alias.to, mark("cm-hmd-internal-link cm-link-alias", { "data-link-target": linkText }));
              if (marks[1]) add(marks[1].from, marks[1].to, formatting("cm-formatting-link cm-formatting-link-end"));
            } else {
              const shown = alias ?? target;
              if (shown) { hide(from, shown.from); add(shown.from, shown.to, link); add(shown.from, shown.to, mark("cm-underline", { draggable: "true" })); hide(shown.to, to); }
            }
            return false;
          }
          case "WikiEmbed": {
            const target = node.getChild("WikiLinkTarget");
            const text = target ? state.doc.sliceString(target.from, target.to) : "";
            const [file, size = ""] = text.split("|");
            const src = livePreview ? options.host.resolveImage(file) : null;
            add(from, to, mark("cm-hmd-embed cm-hmd-internal-link", { "data-link-target": file }));
            for (const item of node.getChildren("WikiLinkMark")) add(item.from, item.to, formatting("cm-formatting-link cm-formatting-embed"));
            if (src) {
              if (!revealed) hide(from, to);
              ranges.push(Decoration.widget({ widget: new ImageWidget(src, file, /^\d+/.exec(size)?.[0] ?? ""), side: 1 }).range(to));
            }
            return false;
          }
          case "Link": {
            const marks = node.getChildren("LinkMark"), url = node.getChild("URL");
            if (marks.length < 2) return;
            add(marks[0].to, marks[1].from, mark("cm-link"));
            if (revealed) {
              add(marks[0].from, marks[0].to, formatting("cm-formatting-link cm-link"));
              add(marks[1].from, marks[1].to, formatting("cm-formatting-link cm-link"));
              if (marks[2]) add(marks[2].from, marks[2].to, formatting("cm-formatting-link-string cm-string cm-url"));
              if (url) add(url.from, url.to, mark("cm-string cm-url", { spellcheck: "false" }));
              if (marks[3]) add(marks[3].from, marks[3].to, formatting("cm-formatting-link-string cm-string cm-url"));
            } else {
              hide(marks[0].from, marks[0].to); hide(marks[1].from, to);
              add(marks[0].to, marks[1].from, mark("cm-underline", { "data-link-url": url ? state.doc.sliceString(url.from, url.to) : "" }));
            }
            return false;
          }
          case "Image": {
            const url = node.getChild("URL");
            add(from, to, mark("cm-image cm-link"));
            const src = url ? state.doc.sliceString(url.from, url.to) : "";
            const resolved = livePreview && src ? (/^(?:https?:|data:|file:|app:)/i.test(src) ? src : options.host.resolveImage(decodeURIComponent(src))) : null;
            if (resolved) { if (!revealed) hide(from, to); ranges.push(Decoration.widget({ widget: new ImageWidget(resolved, "", ""), side: 1 }).range(to)); }
            return false;
          }
          case "URL": case "Autolink": add(from, to, mark("cm-url", { spellcheck: "false" })); return false;
          case "Hashtag": {
            const tag = state.doc.sliceString(from + 1, to).replace(/[^\p{L}\p{N}_-]/gu, "");
            add(from, from + 1, mark(`cm-hashtag cm-hashtag-begin cm-meta cm-tag-${tag}`, { spellcheck: "false" }));
            add(from + 1, to, mark(`cm-hashtag cm-hashtag-end cm-meta cm-tag-${tag}`, { spellcheck: "false" }));
            return false;
          }
          case "InlineComment": add(from, to, mark("cm-comment")); return false;
          case "InlineMath": case "MathBlock": {
            const marks = node.getChildren("MathMark"), display = (marks[0]?.to ?? from) - from === 2;
            // Formulas spanning lines are replaced by the block layer, or stay source when nested.
            if (!revealed && marks.length === 2 && !mathBlockLines(state, node) && state.doc.lineAt(from).number === state.doc.lineAt(to).number) {
              ranges.push(Decoration.replace({ widget: new MathWidget(mathSource(state, node), display) }).range(from, to));
              return false;
            }
            if (marks[0]) add(marks[0].from, marks[0].to, formatting(`cm-formatting-math cm-formatting-math-begin cm-math${display ? " cm-math-block" : ""}`));
            add(marks[0]?.to ?? from, marks[1]?.from ?? to, mark("cm-math", { spellcheck: "false" }));
            if (marks[1]) add(marks[1].from, marks[1].to, formatting("cm-formatting-math cm-formatting-math-end cm-math"));
            return false;
          }
          case "BlockId": add(from, to, mark("cm-blockid", { spellcheck: "false" })); return false;
          case "LinkReference": return footnoteDefinition(from) ? false : undefined;
          case "FootnoteRef": {
            if (footnoteDefinition(from)) return false;
            const marks = node.getChildren("FootnoteMark"), cls = "cm-hmd-barelink cm-footref";
            add(marks[0].from, marks[0].to, formatting(`cm-formatting-link cm-formatting-link-start ${cls}`));
            add(marks[0].to, marks[1].from, mark(cls, { spellcheck: "false" }));
            add(marks[1].from, marks[1].to, formatting(`cm-formatting-link cm-formatting-link-end ${cls}`));
            return false;
          }
          case "InlineFootnote": {
            const marks = node.getChildren("FootnoteMark"), cls = "cm-footref cm-inline-footnote";
            add(marks[0].from, marks[0].to, mark(`cm-inline-footnote-start cm-formatting-inline-footnote ${cls}`));
            add(marks[0].to, marks[1].from, mark(cls));
            add(marks[1].from, marks[1].to, mark(`${cls} cm-inline-footnote-end cm-formatting-inline-footnote`));
            return false;
          }
          case "Escape": add(from, from + 1, formatting("cm-formatting-escape cm-hmd-escape-backslash")); add(from + 1, to, mark("cm-hmd-escape")); return false;
          case "HTMLTag": case "HTMLBlock": case "Comment": add(from, to, mark(name === "Comment" ? "cm-comment" : "cm-tag")); return false;
          case "HorizontalRule": {
            addLine(from, line("hr"));
            if (livePreview && !lineTouched(state, from, to)) ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
            else add(from, to, mark("cm-hr"));
            return false;
          }
          case "FencedCode": case "CodeBlock": {
            const first = state.doc.lineAt(from).number, lastLine = state.doc.lineAt(to).number;
            const fenced = name === "FencedCode";
            // Drawn by the block layer.
            if (fenced && renderedFence(state, node, options)) return false;
            const open = state.doc.line(first), close = state.doc.line(lastLine);
            const closed = fenced && lastLine !== first && FENCE_CLOSE.test(close.text);
            const info = fenced ? (FENCE_OPEN.exec(state.doc.sliceString(from, open.to))?.[2] ?? "") : "";
            const bodyFirst = first + 1, bodyLast = closed ? lastLine - 1 : lastLine;
            const body: string[] = [];
            if (fenced) for (let number = bodyFirst; number <= bodyLast; number++) body.push(state.doc.line(number).text);
            const tokens = info ? codeLineTokens(info, body) : null;
            // Live Preview shows only the language's name on the fence lines while the cursor is outside the block.
            const collapsed = livePreview && closed && !touches(state, open.from, close.to);
            const guides = indentGuides(state);
            for (let number = first; number <= lastLine; number++) {
              const current = state.doc.line(number);
              if (current.to < visible.from || current.from > visible.to) continue;
              const begin = fenced && number === first, end = fenced && number === lastLine && closed;
              ranges.push(line(`HyperMD-codeblock HyperMD-codeblock-bg${begin ? " HyperMD-codeblock-begin HyperMD-codeblock-begin-bg" : ""}${end ? " HyperMD-codeblock-end HyperMD-codeblock-end-bg" : ""}`, { spellcheck: "false" }).range(current.from));
              if ((begin || end) && collapsed) {
                hide(begin ? from : current.from, current.to);
                if (begin) ranges.push(Decoration.widget({ widget: new CodeFlairWidget(codeLanguageName(info), body.join("\n")) }).range(current.to));
                continue;
              }
              if (begin || end) add(current.from, current.to, formatting("cm-formatting-code-block cm-hmd-codeblock"));
              else {
                // One span per token, carrying the block's class and the language mode's classes.
                let at = 0;
                for (const token of (fenced && tokens?.[number - bodyFirst]) || []) {
                  add(current.from + at, current.from + token.from, mark("cm-hmd-codeblock"));
                  add(current.from + token.from, current.from + token.to, mark(`cm-hmd-codeblock ${token.cls}`));
                  at = token.to;
                }
                add(current.from + at, current.to, mark("cm-hmd-codeblock"));
              }
              for (const guide of guides(current)) add(guide.from, guide.to, mark(guide.cls));
            }
            return false;
          }
          case "Blockquote": {
            const level = quoteLevel(node);
            const first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number;
            for (let number = first; number <= last; number++) ranges.push(line(`HyperMD-quote HyperMD-quote-${level}`).range(state.doc.line(number).from));
            return;
          }
          case "QuoteMark": {
            const level = quoteLevel(node);
            if (livePreview && !lineTouched(state, from, to)) add(from, Math.min(state.doc.lineAt(from).to, to + 1), mark(`cm-formatting cm-formatting-quote cm-formatting-quote-${level} cm-quote cm-quote-${level} cm-transparent`));
            else add(from, to, formatting(`cm-formatting-quote cm-formatting-quote-${level} cm-quote cm-quote-${level}`));
            return false;
          }
          case "Paragraph": {
            if (node.parent?.name === "Blockquote") add(from, to, mark(`cm-quote cm-quote-${quoteLevel(node)}`));
            return;
          }
          case "ListItem": {
            const level = listLevel(node);
            const first = state.doc.lineAt(from);
            const markNode = node.getChild("ListMark");
            const task = node.getChild("Task");
            const taskMark = task?.getChild("TaskMarker");
            const status = taskMark ? state.doc.sliceString(taskMark.from + 1, taskMark.from + 2) : null;
            const indent = /^\s*/.exec(first.text)![0].length;
            const hang = (markNode ? markNode.to - first.from + 1 : indent) + (taskMark ? taskMark.to - taskMark.from + 1 : 0);
            ranges.push(Decoration.line({ class: `HyperMD-list-line HyperMD-list-line-${level}${status !== null ? " HyperMD-task-line" : ""}`, attributes: { style: `text-indent: -${hang}ch; padding-inline-start: ${hang}ch;`, ...(status !== null ? { "data-task": status } : {}) } }).range(first.from));
            if (indent) add(first.from, first.from + indent, mark("cm-hmd-list-indent cm-hmd-list-indent-" + (level - 1)));
            if (markNode) {
              const ordered = node.parent?.name === "OrderedList";
              const markEnd = Math.min(first.to, markNode.to + 1);
              if (livePreview && taskMark && !touches(state, markNode.from, taskMark.to)) hide(markNode.from, markEnd);
              else if (livePreview && !ordered && !touches(state, markNode.from, markNode.to)) ranges.push(Decoration.replace({ widget: new BulletWidget(state.doc.sliceString(markNode.from, markNode.to), level) }).range(markNode.from, markEnd));
              else add(markNode.from, markEnd, formatting(`cm-formatting-list cm-formatting-list-${ordered ? "ol" : "ul"} cm-list-${level}`));
              add(markEnd, first.to, mark(`cm-list-${level}`));
            }
            if (taskMark) {
              if (livePreview && !touches(state, taskMark.from, taskMark.to)) ranges.push(Decoration.replace({ widget: new CheckboxWidget(status!, taskMark.from) }).range(taskMark.from, taskMark.to));
              else add(taskMark.from, taskMark.to, formatting(`cm-formatting-task cm-meta`));
            }
            return;
          }
          case "Table": {
            const first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number;
            for (let number = first; number <= last; number++) {
              const current = state.doc.line(number);
              ranges.push(line(`HyperMD-table-row HyperMD-table-2 HyperMD-table-row-${number - first}`).range(current.from));
            }
            return;
          }
          case "TableDelimiter": add(from, to, mark("cm-hmd-table-sep")); return false;
        }
        return;
      },
    });
  }
  // Fully hide a leading YAML block when it is edited through the properties panel.
  if (frontmatter && options.hideFrontmatter && livePreview) {
    return Decoration.set(ranges.filter(range => range.from >= frontmatter.to), true);
  }
  return Decoration.set(ranges, true);
}

/** Token and line classes for the visible viewport, plus Live Preview markup hiding. */
export function markdownDecorations(options: MarkdownDecorationOptions): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDecorations(view, options); }
    update(update: ViewUpdate) {
      const refresh = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshMarkdownDecorations) || effect.is(foldEffect) || effect.is(unfoldEffect)));
      if (refresh || update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = buildDecorations(update.view, options);
    }
  }, { decorations: plugin => plugin.decorations });
}

/** Marks the lines that hold a cursor with the reference's `cm-active` class. */
export const activeLines: Extension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.selectionSet) this.decorations = this.build(update.view); }
  build(view: EditorView) {
    const lines = new Set<number>();
    for (const range of view.state.selection.ranges) {
      if (!range.empty && view.state.selection.ranges.length === 1 && view.state.doc.lineAt(range.from).number !== view.state.doc.lineAt(range.to).number) continue;
      lines.add(view.state.doc.lineAt(range.head).from);
    }
    return Decoration.set([...lines].sort((a, b) => a - b).map(from => Decoration.line({ class: "cm-active" }).range(from)));
  }
}, { decorations: plugin => plugin.decorations });

function blockDecorations(state: EditorState, options: MarkdownDecorationOptions): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const frontmatter = frontmatterRange(state.doc);
  if (frontmatter && options.hideFrontmatter && options.livePreview) {
    ranges.push(Decoration.replace({ block: true, inclusive: true }).range(0, Math.max(0, frontmatter.to - (state.doc.sliceString(frontmatter.to - 1, frontmatter.to) === "\n" ? 1 : 0))));
  }
  if (!options.livePreview) return Decoration.set(ranges, true);
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  tree.iterate({
    enter: cursor => {
      if (frontmatter && cursor.from < frontmatter.to && cursor.name !== "Document") return false;
      if (cursor.name === "Blockquote" && cursor.node.parent?.name === "Document") {
        const text = state.doc.sliceString(cursor.from, cursor.to);
        if (!/^>\s*\[![^\]]+\]/.test(text)) return false;
        const from = state.doc.lineAt(cursor.from).from, to = state.doc.lineAt(cursor.to).to;
        if (!touches(state, from, to)) ranges.push(Decoration.replace({ block: true, widget: new RenderedBlockWidget(text, "callout", options.host, from) }).range(from, to));
        return false;
      }
      // Display math is replaced by its rendering, which stays below the source while that is being edited.
      const math = cursor.name === "MathBlock" ? cursor.node : cursor.name === "Paragraph" && cursor.node.firstChild?.name === "InlineMath" ? cursor.node.firstChild : null;
      const lines = math && mathBlockLines(state, math);
      if (math && lines) {
        const widget = new MathWidget(mathSource(state, math), true);
        if (touches(state, lines.from, lines.to)) ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(lines.to));
        else ranges.push(Decoration.replace({ block: true, widget }).range(lines.from, lines.to));
        return false;
      }
      if (cursor.name === "FencedCode") {
        const fence = renderedFence(state, cursor.node, options);
        if (fence) ranges.push(Decoration.replace({ block: true, widget: new CodeBlockWidget(fence.lang, fence.code, options.host.mermaidAllowed!(), options.host) }).range(fence.from, fence.to));
        return false;
      }
      if (cursor.name === "Table" && cursor.node.parent?.name === "Document") {
        const from = state.doc.lineAt(cursor.from).from, to = state.doc.lineAt(cursor.to).to;
        if (!touches(state, from, to)) ranges.push(Decoration.replace({ block: true, widget: new RenderedBlockWidget(state.doc.sliceString(from, to), "table-widget", options.host, from) }).range(from, to));
        return false;
      }
      return cursor.name === "Document";
    },
  });
  return Decoration.set(ranges, true);
}

/** Block-level Live Preview replacements (callouts, tables, display math, hidden properties block). */
export function blockWidgets(options: MarkdownDecorationOptions): Extension {
  return StateField.define<DecorationSet>({
    create: state => blockDecorations(state, options),
    update: (value, transaction) => transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(refreshMarkdownDecorations)) ? blockDecorations(transaction.state, options) : value,
    provide: field => EditorView.decorations.from(field),
  });
}

/** Link, tag and embed interactions that the decorations expose through data attributes. */
export function linkInteractions(options: MarkdownDecorationOptions): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement;
      const mod = event.ctrlKey || event.metaKey;
      const internal = target.closest<HTMLElement>("[data-link-target]");
      if (internal && (options.livePreview ? !internal.closest(".cm-active") || mod : mod) && event.button !== 2) {
        if (options.livePreview && !target.closest(".cm-underline, .cm-hmd-internal-link")) return false;
        event.preventDefault();
        options.host.openLink(internal.dataset.linkTarget ?? "", event);
        return true;
      }
      const external = target.closest<HTMLElement>("[data-link-url]");
      if (external?.dataset.linkUrl && event.button === 0) {
        event.preventDefault();
        const url = external.dataset.linkUrl;
        if (/^[a-z][a-z\d+.-]*:/i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); else options.host.openLink(decodeURIComponent(url), event);
        return true;
      }
      const tag = target.closest<HTMLElement>(".cm-hashtag");
      if (tag && options.livePreview && event.button === 0 && !tag.closest(".cm-active")) {
        event.preventDefault();
        const position = view.posAtDOM(tag), current = view.state.doc.lineAt(position);
        const match = /#[^\s#]+/.exec(current.text.slice(Math.max(0, current.text.lastIndexOf("#", position - current.from))));
        if (match) options.host.openTag(match[0]);
        return true;
      }
      return false;
    },
    mouseover(event) {
      const internal = (event.target as HTMLElement).closest<HTMLElement>("[data-link-target]");
      if (internal) options.host.hoverLink?.(internal.dataset.linkTarget ?? "", event, internal);
      return false;
    },
  });
}
