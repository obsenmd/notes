import { process } from "../../platforms/platform";
import type { App } from "./plugin";
import { Editor } from "./editor";
import type { TFile } from "./vault";
import { COMMAND_INVENTORY, commandName } from "../controllers/command-inventory";
import { requestText } from "../controllers/dialogs";
import { t } from "../i18n";
import { Menu } from "./ui";

const HIGHLIGHT_COLORS: Record<string, string> = { red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢", blue: "🔵", purple: "🟣" };
const HIGHLIGHT_MARKERS = Object.values(HIGHLIGHT_COLORS);

/** Editing surfaces include Markdown tabs and editable embeds. */
interface MarkdownEditorContext { file: TFile | null; contentEl: HTMLElement; getMode(): string; showSearch(replace?: boolean): void }

/** Link target under the cursor: a wikilink, a Markdown link destination, or a bare URL. */
export function linkAtCursor(editor: Editor): string | null {
  const cursor = editor.getCursor(), line = editor.getLine(cursor.line);
  const patterns: Array<[RegExp, (match: RegExpExecArray) => string]> = [
    [/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, match => match[1]],
    [/!?\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))[^)]*\)/g, match => decodeLinkTarget(match[1] ?? match[2])],
    [/https?:\/\/[^\s<>)\]]+/g, match => match[0]],
  ];
  for (const [pattern, target] of patterns) for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (cursor.ch >= match.index && cursor.ch <= match.index + match[0].length) return target(match);
  }
  return null;
}
function decodeLinkTarget(target: string): string { try { return decodeURIComponent(target); } catch { return target; } }

function openLinkAtCursor(app: App, editor: Editor, view: MarkdownEditorContext, newLeaf: false | "tab" | "window" | "split"): void {
  const link = linkAtCursor(editor); if (!link) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) { window.open(link); return; }
  void app.workspace.openLinkText(link, view.file?.path ?? "", newLeaf);
}

/** The pipe table around the cursor, with the cursor's row and column inside it. */
interface TableContext { start: number; end: number; rows: string[][]; row: number; column: number }
const splitRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(cell => cell.trim());
const isTableLine = (line: string) => line.trim().startsWith("|");
export function tableAtCursor(editor: Editor): TableContext | null {
  const cursor = editor.getCursor();
  if (!isTableLine(editor.getLine(cursor.line))) return null;
  let start = cursor.line, end = cursor.line;
  while (start > 0 && isTableLine(editor.getLine(start - 1))) start--;
  while (end < editor.lastLine() && isTableLine(editor.getLine(end + 1))) end++;
  if (end - start < 1 || !/^\|?[\s:|-]+$/.test(editor.getLine(start + 1).trim()) || !editor.getLine(start + 1).includes("-")) return null;
  const rows: string[][] = [];
  for (let line = start; line <= end; line++) rows.push(splitRow(editor.getLine(line)));
  const before = editor.getLine(cursor.line).slice(0, cursor.ch);
  const column = Math.max(0, Math.min(rows[0].length - 1, (before.match(/(?<!\\)\|/g)?.length ?? 1) - 1));
  return { start, end, rows, row: cursor.line - start, column };
}
function writeTable(editor: Editor, table: TableContext, rows: string[][], row: number, column: number): void {
  const width = Math.max(...rows.map(cells => cells.length));
  const lines = rows.map(cells => "| " + Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ") + " |");
  editor.replaceRange(lines.join("\n"), { line: table.start, ch: 0 }, { line: table.end, ch: editor.getLine(table.end).length });
  const target = Math.max(0, Math.min(rows.length - 1, row)), cells = rows[target] ?? [];
  let ch = 2; for (let index = 0; index < Math.min(column, cells.length - 1); index++) ch += (cells[index] ?? "").length + 3;
  editor.setCursor({ line: table.start + target, ch: Math.min(ch, lines[target].length) });
}
type TableEdit = (table: TableContext) => { rows: string[][]; row: number; column: number } | null;
const bodyRow = (table: TableContext) => Math.max(2, table.row);
const move = <T,>(items: T[], from: number, to: number) => { const next = [...items]; next.splice(to, 0, ...next.splice(from, 1)); return next; };
const setAlignment = (cell: string, align: "left" | "center" | "right") => {
  const current = cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "";
  const dashes = "-".repeat(Math.max(3, cell.replace(/:/g, "").length));
  if (current === align) return dashes;
  return align === "left" ? ":" + dashes : align === "right" ? dashes + ":" : ":" + dashes + ":";
};
const TABLE_EDITS: Record<string, TableEdit> = {
  "editor:table-row-before": table => { const at = bodyRow(table); const rows = [...table.rows]; rows.splice(at, 0, table.rows[0].map(() => "")); return { rows, row: at, column: table.column }; },
  "editor:table-row-after": table => { const index = table.row < 2 ? 2 : table.row + 1; const rows = [...table.rows]; rows.splice(index, 0, table.rows[0].map(() => "")); return { rows, row: index, column: table.column }; },
  "editor:table-row-up": table => table.row > 2 ? { rows: move(table.rows, table.row, table.row - 1), row: table.row - 1, column: table.column } : null,
  "editor:table-row-down": table => table.row >= 2 && table.row < table.rows.length - 1 ? { rows: move(table.rows, table.row, table.row + 1), row: table.row + 1, column: table.column } : null,
  "editor:table-row-copy": table => { if (table.row < 2) return null; const rows = [...table.rows]; rows.splice(table.row + 1, 0, [...table.rows[table.row]]); return { rows, row: table.row + 1, column: table.column }; },
  "editor:table-row-delete": table => table.row >= 2 ? { rows: table.rows.filter((_, index) => index !== table.row), row: Math.min(table.row, table.rows.length - 2), column: table.column } : null,
  "editor:table-col-before": table => ({ rows: table.rows.map((cells, index) => { const next = [...cells]; next.splice(table.column, 0, index === 1 ? "---" : ""); return next; }), row: table.row, column: table.column }),
  "editor:table-col-after": table => ({ rows: table.rows.map((cells, index) => { const next = [...cells]; next.splice(table.column + 1, 0, index === 1 ? "---" : ""); return next; }), row: table.row, column: table.column + 1 }),
  "editor:table-col-left": table => table.column > 0 ? { rows: table.rows.map(cells => move(cells, table.column, table.column - 1)), row: table.row, column: table.column - 1 } : null,
  "editor:table-col-right": table => table.column < table.rows[0].length - 1 ? { rows: table.rows.map(cells => move(cells, table.column, table.column + 1)), row: table.row, column: table.column + 1 } : null,
  "editor:table-col-copy": table => ({ rows: table.rows.map(cells => { const next = [...cells]; next.splice(table.column + 1, 0, cells[table.column] ?? ""); return next; }), row: table.row, column: table.column + 1 }),
  "editor:table-col-delete": table => table.rows[0].length > 1 ? { rows: table.rows.map(cells => cells.filter((_, index) => index !== table.column)), row: table.row, column: Math.max(0, table.column - 1) } : null,
};
for (const align of ["left", "center", "right"] as const) TABLE_EDITS[`editor:table-col-align-${align}`] = table => ({ rows: table.rows.map((cells, index) => index === 1 ? cells.map((cell, column) => column === table.column ? setAlignment(cell, align) : cell) : cells), row: table.row, column: table.column });

function setHeading(editor: Editor, level: number): void {
  transformLines(editor, line => (level ? "#".repeat(level) + " " : "") + line.replace(/^#{1,6}\s+/, ""));
}

function toggleColorHighlight(editor: Editor, color: string): void {
  const marker = HIGHLIGHT_COLORS[color], selection = editor.getSelection();
  const from = editor.getCursor("from"), to = editor.getCursor("to"), text = editor.getValue();
  const start = editor.posToOffset(from), end = editor.posToOffset(to);
  const before = text.slice(0, start), after = text.slice(end);
  const open = HIGHLIGHT_MARKERS.map(item => "==" + item).find(item => before.endsWith(item)) ?? (before.endsWith("==") ? "==" : null);
  if (open && after.startsWith("==")) {
    // Already highlighted: remove the highlight when it has this colour, otherwise recolour it.
    const replacement = open === "==" + marker ? selection : "==" + marker + selection + "==";
    editor.replaceRange(replacement, editor.offsetToPos(start - open.length), editor.offsetToPos(end + 2));
    const offset = start - open.length + (open === "==" + marker ? 0 : 2 + marker.length);
    editor.setSelection(editor.offsetToPos(offset), editor.offsetToPos(offset + selection.length));
    return;
  }
  editor.replaceSelection("==" + marker + selection + "==");
  editor.setSelection(editor.offsetToPos(start + 2 + marker.length), editor.offsetToPos(end + 2 + marker.length));
}

function clearFormatting(editor: Editor): void {
  const from = editor.getCursor("from"), start = editor.posToOffset(from);
  const cleared = editor.getSelection()
    .replace(/(\*\*|__|~~|==|%%)(.*?)\1/gs, "$2").replace(/(\*|_)(.*?)\1/gs, "$2")
    .replace(/`([^`]*)`/g, "$1").replace(/<\/?(?:mark|u|sub|sup|b|i|em|strong|s|del|span)(?:\s[^>]*)?>/gi, "")
    .replace(new RegExp("^(?:" + HIGHLIGHT_MARKERS.join("|") + ")", "u"), "");
  editor.replaceSelection(cleared);
  editor.setSelection(from, editor.offsetToPos(start + cleared.length));
}

function cycleListChecklist(editor: Editor): void {
  transformLines(editor, line => {
    const match = /^(\s*)(?:([-+*]|\d+[.)])\s+(?:\[(.)\]\s+)?)?(.*)$/.exec(line)!;
    const [, indent, bullet, mark, rest] = match;
    if (!bullet) return indent + "- " + rest;
    if (mark === undefined) return indent + bullet + " [ ] " + rest;
    if (mark === " ") return indent + bullet + " [x] " + rest;
    return indent + rest;
  });
}

function insertFootnote(editor: Editor): void {
  const text = editor.getValue();
  let index = 1; while (text.includes("[^" + index + "]")) index++;
  const reference = "[^" + index + "]", cursor = editor.getCursor("to");
  editor.replaceRange(reference, cursor);
  const trailing = /\n*$/.exec(editor.getValue())![0].length, last = editor.lastLine();
  editor.replaceRange("\n".repeat(2 - Math.min(trailing, 2)) + reference + ": ", { line: last, ch: editor.getLine(last).length });
  const end = editor.lastLine();
  editor.setCursor({ line: end, ch: editor.getLine(end).length });
}

function addCursor(editor: Editor, offset: 1 | -1): void {
  const selections = editor.listSelections();
  const edge = selections.reduce((best, selection) => (offset > 0 ? selection.head.line > best.head.line : selection.head.line < best.head.line) ? selection : best, selections[0]);
  const line = edge.head.line + offset; if (line < 0 || line > editor.lastLine()) return;
  const caret = { line, ch: Math.min(edge.head.ch, editor.getLine(line).length) };
  editor.setSelections([...selections, { anchor: caret, head: caret }], selections.length);
}

function showHeadingMenu(editor: Editor, view: MarkdownEditorContext): void {
  const menu = new Menu();
  for (let level = 0; level <= 6; level++) menu.addItem(item => item
    .setIcon(level ? "lucide-heading-" + level : "lucide-type")
    .setTitle(level ? t("editor.heading-suggestion.label-heading-level", { level }) : t("editor.heading-suggestion.label-no-heading"))
    .onClick(() => setHeading(editor, level)));
  const box = cursorBox(view);
  menu.showAtPosition({ x: box.left, y: box.bottom }, view.contentEl.ownerDocument);
}
function cursorBox(view: MarkdownEditorContext): DOMRect {
  const el = view.contentEl.querySelector(".cm-cursor-primary") ?? view.contentEl.querySelector(".cm-active") ?? view.contentEl;
  return el.getBoundingClientRect();
}

async function renameHeading(app: App, editor: Editor, view: MarkdownEditorContext): Promise<void> {
  const cursor = editor.getCursor(), match = /^(#{1,6}\s+)(.*?)\s*$/.exec(editor.getLine(cursor.line));
  const file = view.file; if (!match || !file) return;
  const next = (await requestText(app, t("dialogue.label-rename-heading"), match[2]))?.trim();
  if (!next || next === match[2]) return;
  editor.setLine(cursor.line, match[1] + next);
  // Keep links to the heading pointing at it.
  const old = match[2].toLowerCase();
  for (const other of app.vault.getMarkdownFiles()) {
    const pattern = /\[\[([^\]|#]*)#([^\]|]+)/g;
    const rewrite = (source: string) => source.replace(pattern, (whole, linkpath: string, heading: string) => {
      const target = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, other.path) : other;
      return target?.path === file.path && heading.toLowerCase() === old ? "[[" + linkpath + "#" + next : whole;
    });
    if (other === file) { const value = editor.getValue(), rewritten = rewrite(value); if (rewritten !== value) editor.setValuePreservingSelection(rewritten); }
    else await app.vault.process(other, rewrite);
  }
}

function attachFile(app: App, editor: Editor, view: MarkdownEditorContext): void {
  const doc = view.contentEl.ownerDocument, input = doc.createElement("input");
  input.type = "file"; input.multiple = true;
  input.addEventListener("change", () => void (async () => {
    const embeds: string[] = [];
    for (const picked of Array.from(input.files ?? [])) {
      const target = await app.fileManager.getAvailablePathForAttachment(picked.name, view.file?.path);
      const created = await app.vault.createBinary(target, await picked.arrayBuffer());
      embeds.push("!" + app.fileManager.generateMarkdownLink(created, view.file?.path ?? "").replace(/^!/, ""));
    }
    if (embeds.length) editor.replaceSelection(embeds.join("\n"));
  })());
  input.click();
}

export function toggleInlineFormat(editor: Editor, left: string, right = left): void {
  const selection = editor.getSelection();
  const from = editor.getCursor("from"), to = editor.getCursor("to");
  const start = editor.posToOffset(from), end = editor.posToOffset(to), text = editor.getValue();
  if (selection.startsWith(left) && selection.endsWith(right) && selection.length >= left.length + right.length) {
    editor.replaceSelection(selection.slice(left.length, selection.length - right.length));
    editor.setSelection(editor.offsetToPos(start), editor.offsetToPos(end - left.length - right.length));
  } else if (text.slice(start - left.length, start) === left && text.slice(end, end + right.length) === right) {
    editor.replaceRange(selection, editor.offsetToPos(start - left.length), editor.offsetToPos(end + right.length));
    editor.setSelection(editor.offsetToPos(start - left.length), editor.offsetToPos(end - left.length));
  } else {
    editor.replaceSelection(left + selection + right);
    editor.setSelection(editor.offsetToPos(start + left.length), editor.offsetToPos(end + left.length));
  }
}

function transformLines(editor: Editor, transform: (line: string, index: number) => string): void {
  const from = editor.getCursor("from"), to = editor.getCursor("to");
  const end = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
  const first = { line: from.line, ch: 0 }, last = { line: end, ch: editor.getLine(end).length };
  const lines = editor.getRange(first, last).split("\n");
  editor.replaceRange(lines.map(transform).join("\n"), first, last);
}

/** Register only commands with working editor behavior; inventory is version matched. */
export function registerEditorCommands(app: App, customHotkeys: Record<string, import("./commands").Hotkey[]> = {}): () => void {
  /** Commands that only apply in some editor contexts. */
  const checks: Record<string, (editor: Editor, view: MarkdownEditorContext) => boolean> = {
    "editor:clear-formatting": editor => editor.somethingSelected(),
    "editor:rename-heading": editor => /^#{1,6}\s/.test(editor.getLine(editor.getCursor().line)),
  };
  for (const id of ["editor:follow-link", "editor:open-link-in-new-leaf", "editor:open-link-in-new-window", "editor:open-link-in-new-split"]) checks[id] = editor => !!linkAtCursor(editor);
  for (const id of ["editor:toggle-bullet-list", "editor:toggle-numbered-list", "editor:toggle-checklist-status", "editor:cycle-list-checklist", "editor:insert-callout", "editor:insert-codeblock", "editor:insert-table"]) checks[id] = editor => !tableAtCursor(editor);
  const actions: Record<string, (editor: Editor, view: MarkdownEditorContext) => void> = {
    "editor:follow-link": (editor, view) => openLinkAtCursor(app, editor, view, false),
    "editor:open-link-in-new-leaf": (editor, view) => openLinkAtCursor(app, editor, view, "tab"),
    "editor:open-link-in-new-window": (editor, view) => openLinkAtCursor(app, editor, view, "window"),
    "editor:open-link-in-new-split": (editor, view) => openLinkAtCursor(app, editor, view, "split"),
    "editor:rename-heading": (editor, view) => void renameHeading(app, editor, view),
    "editor:insert-tag": editor => { const at = editor.getCursor("from"); editor.replaceRange("#", at); editor.setCursor({ line: at.line, ch: at.ch + 1 }); },
    "editor:set-heading": showHeadingMenu,
    "editor:clear-formatting": clearFormatting,
    "editor:cycle-list-checklist": cycleListChecklist,
    "editor:insert-footnote": insertFootnote,
    "editor:attach-file": (editor, view) => attachFile(app, editor, view),
    "editor:delete-paragraph": editor => editor.exec("deleteLine"),
    "editor:add-cursor-below": editor => addCursor(editor, 1),
    "editor:add-cursor-above": editor => addCursor(editor, -1),
    "editor:fold-more": editor => editor.exec("foldMore"),
    "editor:fold-less": editor => editor.exec("foldLess"),
    "editor:context-menu": (_, view) => { const box = cursorBox(view); (view.contentEl.querySelector(".cm-content") ?? view.contentEl).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom, view: view.contentEl.ownerDocument.defaultView ?? window })); },
    "editor:open-search": (_, view) => view.showSearch(),
    "editor:open-search-replace": (_, view) => view.showSearch(true),
    "editor:focus": editor => editor.focus(),
    "editor:toggle-fold": editor => editor.exec("toggleFold"),
    "editor:fold-all": editor => editor.exec("foldAll"),
    "editor:unfold-all": editor => editor.exec("unfoldAll"),
    "editor:indent-list": editor => editor.exec("indentMore"),
    "editor:unindent-list": editor => editor.exec("indentLess"),
    "editor:swap-line-up": editor => editor.exec("swapLineUp"),
    "editor:swap-line-down": editor => editor.exec("swapLineDown"),
    "editor:toggle-blockquote": editor => transformLines(editor, line => line.startsWith("> ") ? line.slice(2) : "> " + line),
    "editor:toggle-bullet-list": editor => transformLines(editor, line => /^(\s*)[-+*]\s/.test(line) ? line.replace(/^(\s*)[-+*]\s/, "$1") : line.replace(/^(\s*)/, "$1- ")),
    "editor:toggle-numbered-list": editor => transformLines(editor, (line, index) => /^(\s*)\d+\.\s/.test(line) ? line.replace(/^(\s*)\d+\.\s/, "$1") : line.replace(/^(\s*)/, `$1${index + 1}. `)),
    "editor:toggle-checklist-status": editor => transformLines(editor, line => /\[[ xX]\]/.test(line) ? line.replace(/\[([ xX])\]/, (_, mark: string) => mark === " " ? "[x]" : "[ ]") : line.replace(/^(\s*)(?:[-+*]\s)?/, "$1- [ ] ")),
    "editor:insert-callout": editor => editor.replaceSelection("> [!note]\n> " + editor.getSelection()),
    "editor:insert-horizontal-rule": editor => editor.replaceSelection("\n---\n"),
    "editor:insert-table": editor => { const at = editor.getCursor("from"); editor.replaceSelection((editor.getLine(at.line).slice(0, at.ch).trim() ? "\n" : "") + "|  |  |\n| --- | --- |\n|  |  |"); },
  };
  const wrappers: Record<string, [string, string?]> = {
    "editor:toggle-bold": ["**"], "editor:toggle-italics": ["*"], "editor:toggle-strikethrough": ["~~"],
    "editor:toggle-highlight": ["=="], "editor:toggle-code": ["`"], "editor:toggle-inline-math": ["$"],
    "editor:toggle-comments": ["%%"], "editor:insert-wikilink": ["[[", "]]"], "editor:insert-embed": ["![[", "]]"],
    "editor:insert-link": ["[", "]()"], "editor:insert-codeblock": ["```\n", "\n```"], "editor:insert-mathblock": ["$$\n", "\n$$"],
  };
  for (const [id, [left, right]] of Object.entries(wrappers)) actions[id] = editor => toggleInlineFormat(editor, left, right);
  for (let level = 0; level <= 6; level++) actions[`editor:set-heading-${level}`] = editor => setHeading(editor, level);
  for (const color of Object.keys(HIGHLIGHT_COLORS)) actions[`editor:toggle-highlight-${color}`] = editor => toggleColorHighlight(editor, color);
  for (const [id, edit] of Object.entries(TABLE_EDITS)) {
    checks[id] = editor => { const table = tableAtCursor(editor); return !!table && !!edit(table); };
    actions[id] = editor => { const table = tableAtCursor(editor), result = table && edit(table); if (table && result) writeTable(editor, table, result.rows, result.row, result.column); };
  }
  const ids: string[] = [];
  for (const definition of COMMAND_INVENTORY) {
    const action = actions[definition.id]; if (!action) continue;
    app.commands.add({ id: definition.id, name: commandName(definition), hotkeys: customHotkeys[definition.id] ?? definition.hotkeys, editorCheckCallback: (checking, editor, view) => {
      const context = view as MarkdownEditorContext | undefined;
      if (!(editor instanceof Editor) || !context || typeof context.getMode !== "function" || context.getMode() !== "source" || !context.contentEl || typeof context.showSearch !== "function") return false;
      if (checks[definition.id] && !checks[definition.id](editor, context)) return false;
      if (!checking) action(editor, context);
      return true;
    } });
    ids.push(definition.id);
  }
  return () => ids.forEach(id => app.commands.remove(id));
}
