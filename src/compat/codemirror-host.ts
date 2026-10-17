import { bindEditorFields, editorApiFields } from "./api-extras";
import type { SyntaxNode } from "@lezer/common";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, undo, moveLineDown, moveLineUp } from "@codemirror/commands";
import { deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { codeFolding, foldAll, foldCode, foldEffect, foldable, foldedRanges, foldService, syntaxTree, indentUnit, unfoldAll, unfoldCode, unfoldEffect } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { documentSearchHighlights } from "./document-search";
import type { Editor } from "./editor";
import { activeLines, blockWidgets, linkInteractions, markdownDecorations, obsidianMarkdownLanguage, type LivePreviewHost } from "./obsidian-markdown";

export interface MarkdownEditorOptions {
  tabSize?: number; useTab?: boolean; spellcheck?: boolean; showLineNumber?: boolean; foldHeading?: boolean; foldIndent?: boolean; rightToLeft?: boolean;
  livePreview?: boolean; autoPairBrackets?: boolean; autoPairMarkdown?: boolean; smartIndentList?: boolean; showIndentGuide?: boolean; readableLineLength?: boolean;
  /** How a leading YAML block is presented: in the properties panel, hidden, or as source. */
  propertiesInDocument?: "visible" | "hidden" | "source";
  strictLineBreaks?: boolean;
  /** Mode new Markdown tabs open in. */
  defaultViewMode?: "source" | "preview";
  extensions?: Extension[];
  onFocus?: () => void;
  onFold?: () => void;
  /** Embedded editors fit their text without the document's trailing viewport space. */
  scrollPastEnd?: boolean;
}

/** Copy nested extension arrays so Compartment reconfiguration sees in-place plugin mutations. */
const refreshExtensionArray = (extensions: Extension[]): Extension[] => extensions.map(extension =>
  Array.isArray(extension) ? refreshExtensionArray(extension as Extension[]) : extension,
);

/** Search bindings without the stock panel: finding is handled by the document search bar. */
const editorSearchKeymap = searchKeymap.filter(binding => !["Mod-f", "F3", "Mod-g", "Escape", "Mod-Alt-g"].includes(binding.key ?? ""));

const inertHost: LivePreviewHost = { renderMarkdown: (source, el) => { el.textContent = source; }, resolveImage: () => null, isResolved: () => true, openLink: () => {}, openTag: () => {} };

const headingFolds = foldService.of((state, start, end) => {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(end, -1); node && node.from >= start; node = node.parent) {
    const level = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)?.[1];
    if (!level) continue;
    let next = node.nextSibling;
    while (next) {
      const nextLevel = /^(?:ATX|Setext)Heading(\d)$/.exec(next.name)?.[1];
      if (nextLevel && Number(nextLevel) <= Number(level)) break;
      next = next.nextSibling;
    }
    const to = next ? Math.max(end, next.from - 1) : node.parent?.to ?? state.doc.length;
    return to > end ? {from: end, to} : null;
  }
  return null;
});

/**
 * Mounts a CodeMirror editor bound to an `Editor` document. The DOM is arranged like
 * the reference editor: `.cm-scroller > .cm-sizer > .cm-contentContainer > .cm-content`,
 * so headers such as the inline title can sit in the sizer above the content.
 */
export function mountMarkdownEditor(parent: HTMLElement, editor: Editor, options: MarkdownEditorOptions = {}, host: LivePreviewHost = inertHost) {
  // CodeMirror normalizes line endings. Keep model offsets in the same document
  // coordinates before connecting its selections and subsequent transactions.
  editor.setValuePreservingSelection(editor.getValue().replace(/\r\n?/g, "\n"));
  let syncing = false;
  const plugins = new Compartment(), configuration = new Compartment();
  const configured = (current: MarkdownEditorOptions): Extension => {
    const decorationOptions = { livePreview: current.livePreview !== false, hideFrontmatter: (current.propertiesInDocument ?? "visible") !== "source", host };
    return [
      EditorState.tabSize.of(current.tabSize ?? 4),
      indentUnit.of(current.useTab === false ? " ".repeat(current.tabSize ?? 4) : "\t"),
      EditorView.contentAttributes.of({ spellcheck: String(current.spellcheck ?? true), autocorrect: "on", autocapitalize: "on", ...(current.rightToLeft ? { dir: "rtl" } : {}) }),
      current.showLineNumber ? lineNumbers() : [],
      current.autoPairBrackets === false ? [] : closeBrackets(),
      markdownDecorations(decorationOptions), blockWidgets(decorationOptions), linkInteractions(decorationOptions),
      keymap.of(current.smartIndentList === false ? [] : [{ key: "Enter", run: insertNewlineContinueMarkup }, { key: "Backspace", run: deleteMarkupBackward }]),
    ];
  };
  const view = new EditorView({ parent, state: EditorState.create({
    doc: editor.getValue(),
    selection: EditorSelection.create(editor.listSelections().map(range => EditorSelection.range(editor.posToOffset(range.anchor), editor.posToOffset(range.head)))),
    extensions: [
      EditorState.allowMultipleSelections.of(true), configuration.of(configured(options)), headingFolds, obsidianMarkdownLanguage, activeLines,
      EditorView.lineWrapping, drawSelection(), dropCursor(), rectangularSelection(), history(), codeFolding(),
      documentSearchHighlights, editorApiFields,
      keymap.of([...closeBracketsKeymap, ...editorSearchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      plugins.of(options.extensions ?? []),
      EditorView.updateListener.of(update => {
        if (update.geometryChanged) pad();
        if (update.transactions.some(transaction => transaction.effects.some(effect => effect.is(foldEffect) || effect.is(unfoldEffect)))) options.onFold?.();
        if (syncing) return;
        syncing = true;
        try {
          if (update.docChanged) {
            const changes: Array<{ from: ReturnType<Editor["offsetToPos"]>; to: ReturnType<Editor["offsetToPos"]>; text: string }> = [];
            update.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => changes.push({ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text: inserted.toString() }));
            editor.transaction({ changes });
          }
          if (update.docChanged || update.selectionSet) editor.setSelections(update.state.selection.ranges.map(range => ({ anchor: editor.offsetToPos(range.anchor), head: editor.offsetToPos(range.head) })), update.state.selection.mainIndex);
          if (update.focusChanged) {
            if (update.view.hasFocus) { editor.focus(); options.onFocus?.(); }
            else editor.blur();
          }
        } finally { syncing = false; }
      }),
    ],
  }) });
  view.dispatch({ effects: bindEditorFields.of({ view }) });

  // Rearrange the content into the reference's sizer structure.
  const doc = parent.ownerDocument;
  const sizerEl = doc.createElement("div"); sizerEl.className = "cm-sizer";
  const contentContainerEl = doc.createElement("div"); contentContainerEl.className = "cm-contentContainer";
  view.contentDOM.before(sizerEl);
  contentContainerEl.append(view.contentDOM);
  sizerEl.append(contentContainerEl);
  view.scrollDOM.tabIndex = -1;
  // Half a viewport of trailing space lets the last line scroll to the middle.
  function pad() {
    const padding = options.scrollPastEnd === false ? "0px" : `${Math.max(0, Math.round(view.scrollDOM.clientHeight / 2))}px`;
    if (view.contentDOM.style.paddingBottom !== padding) view.contentDOM.style.paddingBottom = padding;
  }
  pad();
  // Clicking the empty area below the text places the cursor at the end, as in the reference.
  const onSizerMouseDown = (event: MouseEvent) => {
    if (event.target !== sizerEl && event.target !== contentContainerEl) return;
    event.preventDefault();
    view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus();
  };
  sizerEl.addEventListener("mousedown", onSizerMouseDown);

  editor.cm = view;
  const sync = () => {
    if (syncing) return;
    syncing = true;
    try {
      const value = editor.getValue(), previous = view.state.doc.toString();
      const selection = EditorSelection.create(editor.listSelections().map(range => EditorSelection.range(editor.posToOffset(range.anchor), editor.posToOffset(range.head))));
      if (value !== previous) {
        let from = 0, oldTo = previous.length, newTo = value.length;
        while (from < oldTo && from < newTo && previous[from] === value[from]) from++;
        while (oldTo > from && newTo > from && previous[oldTo - 1] === value[newTo - 1]) { oldTo--; newTo--; }
        view.dispatch({ changes: { from, to: oldTo, insert: value.slice(from, newTo) }, selection });
      } else if (!view.state.selection.eq(selection)) view.dispatch({ selection, scrollIntoView: true });
      if (editor.hasFocus() && !view.hasFocus) view.focus();
    } finally { syncing = false; }
  };
  editor.onUpdate(sync);
  editor.attachHost({
    refresh: () => view.requestMeasure(),
    focus: () => view.focus(), undo: () => { undo(view); }, redo: () => { redo(view); },
    exec: command => {
      if (command === "foldAll") return foldAll(view);
      if (command === "unfoldAll") return unfoldAll(view);
      if (command === "toggleFold") return foldCode(view) || unfoldCode(view);
      if (command === "foldMore") return foldLevel(view, true);
      if (command === "foldLess") return foldLevel(view, false);
      if (command === "indentMore") return indentMore(view);
      if (command === "indentLess") return indentLess(view);
      if (command === "swapLineUp") return moveLineUp(view);
      if (command === "swapLineDown") return moveLineDown(view);
      return false;
    },
    getScrollInfo: () => ({ left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop, width: view.scrollDOM.scrollWidth, height: view.scrollDOM.scrollHeight, clientWidth: view.scrollDOM.clientWidth, clientHeight: view.scrollDOM.clientHeight }),
    scrollTo: (x, y) => { view.scrollDOM.scrollLeft = x; view.scrollDOM.scrollTop = y; },
    scrollIntoView: (range, center) => view.dispatch({ effects: EditorView.scrollIntoView(editor.posToOffset(range.from), { y: center ? "center" : "nearest" }) }),
  });
  return {
    view, sizerEl, contentContainerEl,
    setExtensions: (extensions: Extension[]) => view.dispatch({ effects: plugins.reconfigure(refreshExtensionArray(extensions)) }),
    setOptions: (next: MarkdownEditorOptions) => view.dispatch({ effects: configuration.reconfigure(configured(next)) }),
    destroy: () => { sizerEl.removeEventListener("mousedown", onSizerMouseDown); editor.offUpdate(sync); if (editor.cm === view) { editor.cm = null; editor.attachHost(null); } view.destroy(); },
  };
}

/**
 * "Fold more" folds the deepest heading level that is still open; "fold less" opens the
 * shallowest level that is folded.
 */
function foldLevel(view: EditorView, more: boolean): boolean {
  const { state } = view, folded = foldedRanges(state);
  const isFolded = (from: number, to: number) => { let found = false; folded.between(from, to, (a, b) => { if (a === from && b === to) found = true; }); return found; };
  const byLevel = new Map<number, Array<{ from: number; to: number; folded: boolean }>>();
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number), heading = /^(#{1,6})\s/.exec(line.text); if (!heading) continue;
    const range = foldable(state, line.from, line.to); if (!range) continue;
    const level = heading[1].length, list = byLevel.get(level) ?? [];
    list.push({ ...range, folded: isFolded(range.from, range.to) }); byLevel.set(level, list);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const level = more ? [...levels].reverse().find(item => byLevel.get(item)!.some(range => !range.folded)) : levels.find(item => byLevel.get(item)!.some(range => range.folded));
  if (level === undefined) return true;
  const effects = byLevel.get(level)!.filter(range => range.folded !== more).map(range => (more ? foldEffect : unfoldEffect).of({ from: range.from, to: range.to }));
  if (effects.length) view.dispatch({ effects });
  return true;
}
