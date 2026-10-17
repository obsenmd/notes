/** Position in an editor document. Both coordinates are zero based. */
export interface EditorPosition { line: number; ch: number }
export interface EditorRange { from: EditorPosition; to: EditorPosition }
export interface EditorRangeOrCaret { from: EditorPosition; to?: EditorPosition }
export interface EditorSelection { anchor: EditorPosition; head: EditorPosition }
export interface EditorSelectionOrCaret { anchor: EditorPosition; head?: EditorPosition }
export interface EditorScrollInfo { left: number; top: number; width: number; height: number; clientWidth: number; clientHeight: number }
interface EditorHost { exec?: (command: EditorCommandName) => boolean; refresh?: () => void; focus?: () => void; undo?: () => void; redo?: () => void; getScrollInfo?: () => EditorScrollInfo; scrollTo?: (x: number, y: number) => void; scrollIntoView?: (range: EditorRange, center: boolean) => void }
export interface EditorChange extends EditorRangeOrCaret { text: string }
export type EditorCommandName =
  | "goUp" | "goDown" | "goLeft" | "goRight" | "goStart" | "goEnd"
  | "goWordLeft" | "goWordRight" | "indentMore" | "indentLess"
  | "newlineAndIndent" | "swapLineUp" | "swapLineDown" | "deleteLine"
  | "toggleFold" | "foldAll" | "unfoldAll" | "foldMore" | "foldLess";
export interface EditorTransaction {
  replaceSelection?: string;
  changes?: EditorChange[];
  selections?: EditorRangeOrCaret[];
  selection?: EditorRangeOrCaret;
}

/**
 * Small runtime implementation of Obsidian's Editor document API. A host can
 * subclass this class and override focus/scroll hooks to connect a real view.
 */
export class Editor {
  cm: import("@codemirror/view").EditorView | null = null;
  private value: string;
  private selections: EditorSelection[] = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }];
  private mainSelection = 0;
  private undoStack: Array<{ value: string; selections: EditorSelection[] }> = [];
  private redoStack: Array<{ value: string; selections: EditorSelection[] }> = [];
  private focused = false;
  private scroll = { top: 0, left: 0 };
  private host: EditorHost | null = null;
  private readonly changeListeners = new Set<(editor: Editor, info: { lineStart: number; lineEnd: number; text: string[]; origin: string }) => unknown>();
  private readonly updateListeners = new Set<(editor: Editor) => unknown>();

  constructor(value = "") { this.value = value; }
  getDoc(): this { return this; }
  /** @internal Connects the document model to its visible editor surface. */
  attachHost(host: EditorHost | null): void {
    this.host = host;
    if (host?.scrollTo) host.scrollTo(this.scroll.left, this.scroll.top);
  }
  refresh(): void { this.host?.refresh?.(); }
  getValue(): string { return this.value; }
  setValue(content: string): void {
    if (this.cm) content = content.replace(/\r\n?/g, "\n");
    const previous = this.value;
    const previousLines = previous.split("\n");
    this.value = content;
    const end = this.cm ? { line: 0, ch: 0 } : this.offsetToPos(content.length);
    this.selections = [{ anchor: end, head: end }];
    this.mainSelection = 0;
    if (previous !== content) this.emitChange({ lineStart: 0, lineEnd: Math.max(previousLines.length - 1, this.lineCount() - 1), text: content.split("\n"), origin: "setValue" });
  }
  /** @internal Synchronize a second view of the same document without moving its caret. */
  setValuePreservingSelection(content: string): void {
    if (this.cm) content = content.replace(/\r\n?/g, "\n");
    if (content === this.value) return;
    const previousLines = this.lineCount();
    const selections = this.listSelections();
    this.value = content;
    this.selections = selections.map((selection) => ({ anchor: this.clampPos(selection.anchor), head: this.clampPos(selection.head) }));
    this.mainSelection = Math.max(0, Math.min(this.mainSelection, this.selections.length - 1));
    this.emitChange({ lineStart: 0, lineEnd: Math.max(previousLines - 1, this.lineCount() - 1), text: content.split("\n"), origin: "sync" });
  }
  getLine(line: number): string { return this.lines()[this.clampLine(line)] ?? ""; }
  setLine(line: number, text: string): void {
    const n = this.clampLine(line);
    this.replaceRange(text, { line: n, ch: 0 }, { line: n, ch: this.getLine(n).length }, "setLine");
  }
  lineCount(): number { return this.lines().length; }
  lastLine(): number { return this.lineCount() - 1; }
  getSelection(): string {
    const { from, to } = this.primaryRange();
    return this.value.slice(this.posToOffset(from), this.posToOffset(to));
  }
  somethingSelected(): boolean { return this.selections.some(s => !samePos(s.anchor, s.head)); }
  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.value.slice(this.posToOffset(from), this.posToOffset(to));
  }
  replaceSelection(replacement: string, origin?: string): void {
    if (this.cm) replacement = replacement.replace(/\r\n?/g, "\n");
    const ranges = this.selections.map((selection, index) => {
      const [from, to] = ordered(selection.anchor, selection.head);
      return { start: this.posToOffset(from), end: this.posToOffset(to), index };
    }).sort((a, b) => a.start - b.start || a.end - b.end);
    // Editors normalize overlapping selections. Merge them here as callers may
    // set selections directly through the compatibility API.
    const normalized: Array<{ start: number; end: number; indexes: number[] }> = [];
    for (const range of ranges) {
      const previous = normalized[normalized.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
        previous.indexes.push(range.index);
      } else normalized.push({ start: range.start, end: range.end, indexes: [range.index] });
    }
    if (!normalized.length) return;
    const original = this.value;
    const previousSelections = this.listSelections();
    const lineStart = this.offsetToPos(normalized[0].start).line;
    const lineEnd = this.offsetToPos(normalized[normalized.length - 1].end).line;
    const changes = normalized.map((range) => ({ ...range, text: replacement }));
    for (const change of [...changes].reverse()) {
      this.value = this.value.slice(0, change.start) + replacement + this.value.slice(change.end);
    }
    const changed = this.value !== original;
    if (changed) {
      this.undoStack.push({ value: original, selections: previousSelections });
      this.redoStack = [];
    }
    const caretByIndex = new Map<number, EditorPosition>();
    let delta = 0;
    for (const change of changes) {
      const caret = this.offsetToPos(change.start + delta + replacement.length);
      for (const index of change.indexes) caretByIndex.set(index, caret);
      delta += replacement.length - (change.end - change.start);
    }
    this.selections = previousSelections.map((selection, index) => {
      const caret = caretByIndex.get(index) ?? this.clampPos(selection.head);
      return { anchor: copyPos(caret), head: copyPos(caret) };
    });
    if (changed) this.emitChange({ lineStart, lineEnd, text: this.lines(), origin: origin ?? "input" });
    else this.emitUpdate();
  }
  replaceRange(replacement: string, from: EditorPosition, to: EditorPosition = from, _origin?: string): void {
    if (this.cm) replacement = replacement.replace(/\r\n?/g, "\n");
    const start = this.posToOffset(from), end = this.posToOffset(to);
    if (this.value.slice(0, start) + replacement + this.value.slice(end) === this.value) return;
    const offsets = this.cm ? this.selections.map(s => ({ anchor: this.posToOffset(s.anchor), head: this.posToOffset(s.head) })) : null;
    this.commit();
    this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
    const caret = this.offsetToPos(start + replacement.length);
    if (offsets) {
      const map = (offset: number) => offset <= start ? offset : offset >= end ? offset + replacement.length - (end - start) : start;
      this.selections = offsets.map(s => ({ anchor: this.offsetToPos(map(s.anchor)), head: this.offsetToPos(map(s.head)) }));
    } else {
      this.selections = [{ anchor: caret, head: caret }];
      this.mainSelection = 0;
    }
    this.emitChange({ lineStart: from.line, lineEnd: to.line, text: replacement.split("\n"), origin: _origin ?? "input" });
  }

  onChange(callback: (editor: Editor, info: { lineStart: number; lineEnd: number; text: string[]; origin: string }) => unknown): void { this.changeListeners.add(callback); }
  offChange(callback: (editor: Editor, info: { lineStart: number; lineEnd: number; text: string[]; origin: string }) => unknown): void { this.changeListeners.delete(callback); }
  onUpdate(callback: (editor: Editor) => unknown): void { this.updateListeners.add(callback); }
  offUpdate(callback: (editor: Editor) => unknown): void { this.updateListeners.delete(callback); }
  private emitChange(info: { lineStart: number; lineEnd: number; text: string[]; origin: string }): void { for (const callback of this.changeListeners) callback(this, info); this.emitUpdate(); }
  private emitUpdate(): void { for (const callback of this.updateListeners) callback(this); }
  getCursor(side: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
    const selection = this.selections[this.mainSelection] ?? this.selections[0];
    if (side === "head") return copyPos(selection.head);
    if (side === "anchor") return copyPos(selection.anchor);
    const [from, to] = ordered(selection.anchor, selection.head);
    return copyPos(side === "from" ? from : to);
  }
  listSelections(): EditorSelection[] { return this.selections.map(s => ({ anchor: copyPos(s.anchor), head: copyPos(s.head) })); }
  setCursor(pos: EditorPosition | number, ch = 0): void {
    const cursor = typeof pos === "number" ? { line: pos, ch } : pos;
    this.setSelection(cursor);
  }
  setSelection(anchor: EditorPosition, head: EditorPosition = anchor): void {
    this.selections = [{ anchor: this.clampPos(anchor), head: this.clampPos(head) }];
    this.mainSelection = 0;
    this.emitUpdate();
  }
  setSelections(ranges: EditorSelectionOrCaret[], main = 0): void {
    this.selections = ranges.length
      ? ranges.map(r => ({ anchor: this.clampPos(r.anchor), head: this.clampPos(r.head ?? r.anchor) }))
      : [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }];
    this.mainSelection = Math.max(0, Math.min(main, this.selections.length - 1));
    this.emitUpdate();
  }
  focus(): void { this.host?.focus?.(); if (!this.focused) { this.focused = true; this.emitUpdate(); } }
  blur(): void { if (this.focused) { this.focused = false; this.emitUpdate(); } }
  hasFocus(): boolean { return this.focused; }
  getScrollInfo(): EditorScrollInfo { return this.host?.getScrollInfo?.() ?? { ...this.scroll, width: 0, height: 0, clientWidth: 0, clientHeight: 0 }; }
  scrollTo(x?: number | null, y?: number | null): void {
    if (x != null) this.scroll.left = x;
    if (y != null) this.scroll.top = y;
    this.host?.scrollTo?.(this.scroll.left, this.scroll.top);
  }
  scrollIntoView(range: EditorRange, center = false): void {
    const from = this.clampPos(range.from), to = this.clampPos(range.to);
    this.host?.scrollIntoView?.({ from, to }, center);
  }
  undo(): void {
    if (this.host?.undo) { this.host.undo(); return; }
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push({ value: this.value, selections: this.listSelections() });
    const oldLines = this.lineCount();
    this.value = previous.value; this.selections = previous.selections;
    this.mainSelection = Math.min(this.mainSelection, this.selections.length - 1);
    this.emitChange({ lineStart: 0, lineEnd: Math.max(oldLines, this.lineCount()) - 1, text: this.lines(), origin: "undo" });
  }
  redo(): void {
    if (this.host?.redo) { this.host.redo(); return; }
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ value: this.value, selections: this.listSelections() });
    const oldLines = this.lineCount();
    this.value = next.value; this.selections = next.selections;
    this.mainSelection = Math.min(this.mainSelection, this.selections.length - 1);
    this.emitChange({ lineStart: 0, lineEnd: Math.max(oldLines, this.lineCount()) - 1, text: this.lines(), origin: "redo" });
  }
  exec(command: EditorCommandName): void {
    if (this.host?.exec?.(command)) return;
    const cursor = this.getCursor();
    const moveSelections = (move: (selection: EditorSelection) => EditorSelection) => {
      this.setSelections(this.selections.map(move), this.mainSelection);
    };
    if (["goStart", "goEnd", "goLeft", "goRight", "goWordLeft", "goWordRight", "goUp", "goDown"].includes(command)) {
      return moveSelections((selection) => {
        const cursor = selection.head;
        let target: EditorPosition;
        if (command === "goStart") target = { line: cursor.line, ch: 0 };
        else if (command === "goEnd") target = { line: cursor.line, ch: this.getLine(cursor.line).length };
        else if (command === "goLeft" || command === "goRight") {
          const [from, to] = ordered(selection.anchor, selection.head);
          const hasSelection = !samePos(from, to);
          if (hasSelection) target = command === "goLeft" ? from : to;
          else {
            const offset = Math.max(0, Math.min(this.value.length, this.posToOffset(cursor) + (command === "goLeft" ? -1 : 1)));
            target = this.offsetToPos(offset);
          }
        } else if (command === "goWordLeft" || command === "goWordRight") {
          const offset = this.posToOffset(cursor);
          const text = this.value;
          const words = [...text.matchAll(/[\p{L}\p{N}_$]+/gu)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
          if (command === "goWordLeft") {
            const previous = [...words].reverse().find((word) => word.start < offset);
            target = this.offsetToPos(previous?.start ?? 0);
          } else {
            const next = words.find((word) => word.end > offset);
            target = this.offsetToPos(next?.end ?? text.length);
          }
        } else target = { line: cursor.line + (command === "goUp" ? -1 : 1), ch: cursor.ch };
        return { anchor: copyPos(target), head: copyPos(target) };
      });
    }
    if (command === "newlineAndIndent") {
      const indent = this.getLine(cursor.line).match(/^\s*/)?.[0] ?? "";
      return this.replaceSelection("\n" + indent);
    }
    if (command === "deleteLine") {
      const deletedLines = [...new Set(this.selections.map((selection) => selection.head.line))].sort((a, b) => b - a);
      const original = this.value;
      const originalSelections = this.listSelections();
      let lines = this.lines();
      for (const line of deletedLines) {
        if (lines.length === 1) lines[0] = "";
        else if (line === lines.length - 1) lines.splice(line - 1, 2, lines[line - 1]);
        else lines.splice(line, 1);
      }
      const result = lines.join("\n");
      if (result === original) return;
      this.commit();
      this.value = result;
      const mapLine = (line: number) => Math.max(0, line - deletedLines.filter((deleted) => deleted < line).length);
      this.setSelections(originalSelections.map((selection) => {
        const line = mapLine(selection.head.line);
        const pos = { line, ch: Math.min(selection.head.ch, this.getLine(line).length) };
        return { anchor: pos, head: pos };
      }), this.mainSelection);
      this.emitChange({ lineStart: Math.max(0, Math.min(...deletedLines)), lineEnd: this.lastLine(), text: this.lines(), origin: "deleteLine" });
      return;
    }
    if (command === "swapLineUp" || command === "swapLineDown") {
      const direction = command === "swapLineUp" ? -1 : 1;
      const other = cursor.line + direction;
      if (other < 0 || other > this.lastLine()) return;
      const lines = this.lines();
      [lines[cursor.line], lines[other]] = [lines[other], lines[cursor.line]];
      const selection = this.listSelections();
      this.commit();
      this.value = lines.join("\n");
      this.setSelections(selection.map((range) => ({
        anchor: { line: range.anchor.line === cursor.line ? other : range.anchor.line === other ? cursor.line : range.anchor.line, ch: range.anchor.ch },
        head: { line: range.head.line === cursor.line ? other : range.head.line === other ? cursor.line : range.head.line, ch: range.head.ch },
      })), this.mainSelection);
      this.emitChange({ lineStart: Math.min(cursor.line, other), lineEnd: Math.max(cursor.line, other), text: this.lines(), origin: command });
      return;
    }
    if (command === "indentMore") {
      return this.indentSelectedLines("  ");
    }
    if (command === "indentLess") {
      return this.indentSelectedLines("");
    }
  }

  private indentSelectedLines(prefix: string): void {
    const ranges = this.listSelections();
    const selected = ranges.map((selection) => {
      const [from, to] = ordered(selection.anchor, selection.head);
      return { first: from.line, last: to.line, selection };
    });
    const lineSet = new Set<number>();
    for (const range of selected) {
      const last = range.last > range.first && range.selection.head.ch === 0 ? range.last - 1 : range.last;
      for (let line = range.first; line <= last; line++) lineSet.add(line);
    }
    if (!lineSet.size) return;
    const lines = this.lines();
    const shifts = new Map<number, number>();
    for (const line of [...lineSet].sort((a, b) => a - b)) {
      if (prefix) { lines[line] = prefix + lines[line]; shifts.set(line, prefix.length); }
      else {
        const removed = lines[line].match(/^ {1,2}/)?.[0].length ?? 0;
        if (removed) lines[line] = lines[line].slice(removed);
        shifts.set(line, -removed);
      }
    }
    if ([...shifts.values()].every((shift) => shift === 0)) return;
    this.commit();
    this.value = lines.join("\n");
    this.setSelections(ranges.map((range) => ({
      anchor: { line: range.anchor.line, ch: Math.max(0, range.anchor.ch + (shifts.get(range.anchor.line) ?? 0)) },
      head: { line: range.head.line, ch: Math.max(0, range.head.ch + (shifts.get(range.head.line) ?? 0)) },
    })), this.mainSelection);
    const changedLines = [...lineSet].sort((a, b) => a - b);
    this.emitChange({ lineStart: changedLines[0], lineEnd: changedLines[changedLines.length - 1], text: lines.slice(changedLines[0], changedLines[changedLines.length - 1] + 1), origin: "indent" });
  }
  transaction(tx: EditorTransaction, origin?: string): void {
    const original = this.value;
    const originalSelections = this.listSelections();
    const originalOffsets = originalSelections.map(s => ({ anchor: this.posToOffset(s.anchor), head: this.posToOffset(s.head) }));
    const changes: Array<{ start: number; end: number; text: string; selectionIndexes?: number[] }> = [];
    if (tx.replaceSelection !== undefined) {
      const ranges = originalSelections.map((selection, index) => {
        const [from, to] = ordered(selection.anchor, selection.head);
        return { start: this.posToOffset(from), end: this.posToOffset(to), selectionIndexes: [index] };
      }).sort((a, b) => a.start - b.start || a.end - b.end);
      const normalized: typeof ranges = [];
      for (const range of ranges) {
        const previous = normalized[normalized.length - 1];
        if (previous && range.start <= previous.end) {
          previous.end = Math.max(previous.end, range.end);
          previous.selectionIndexes.push(...range.selectionIndexes);
        } else normalized.push({ ...range, selectionIndexes: [...range.selectionIndexes] });
      }
      const text = this.cm ? tx.replaceSelection.replace(/\r\n?/g, "\n") : tx.replaceSelection;
      changes.push(...normalized.map(range => ({ ...range, text })));
    }
    for (const change of tx.changes ?? []) {
      changes.push({ start: this.posToOffset(change.from), end: this.posToOffset(change.to ?? change.from), text: this.cm ? change.text.replace(/\r\n?/g, "\n") : change.text });
    }
    changes.sort((a, b) => b.start - a.start || b.end - a.end);
    const changedFromLine = changes.length ? this.offsetToPos(changes[changes.length - 1].start).line : 0;
    const changedToLine = changes.length ? this.offsetToPos(changes[0].end).line : 0;
    // Reject overlapping edits: silently applying them in reverse order produces
    // results that depend on input ordering and does not match a single editor transaction.
    for (let i = 1; i < changes.length; i++) {
      if (changes[i].end > changes[i - 1].start) throw new RangeError("Editor transaction contains overlapping changes");
    }
    if (changes.length) {
      for (const c of changes) this.value = this.value.slice(0, c.start) + c.text + this.value.slice(c.end);
      if (this.value !== original) {
        this.undoStack.push({ value: original, selections: originalSelections });
        this.redoStack = [];
        const mapOffset = (offset: number) => {
          let delta = 0;
          for (const c of [...changes].reverse()) {
            if (offset < c.start) break;
            if (offset <= c.end) return c.start + delta + c.text.length;
            delta += c.text.length - (c.end - c.start);
          }
          return offset + delta;
        };
        this.selections = originalOffsets.map(s => ({
          anchor: this.offsetToPos(mapOffset(s.anchor)),
          head: this.offsetToPos(mapOffset(s.head)),
        }));
        for (const change of changes) if (change.selectionIndexes) {
          const cursor = this.offsetToPos(mapOffset(change.start));
          for (const index of change.selectionIndexes) this.selections[index] = { anchor: cursor, head: cursor };
        }
        this.emitChange({ lineStart: changedFromLine, lineEnd: Math.max(changedFromLine, changedToLine), text: this.lines(), origin: origin ?? "input" });
      }
    }
    if (tx.selections) this.setSelections(tx.selections.map(r => ({ anchor: r.from, head: r.to ?? r.from })));
    else if (tx.selection) this.setSelection(tx.selection.from, tx.selection.to ?? tx.selection.from);
  }
  wordAt(pos: EditorPosition): EditorRange | null {
    const line = this.getLine(pos.line);
    const re = /[\p{L}\p{N}_$]+/gu;
    for (const match of line.matchAll(re)) {
      const start = match.index ?? 0, end = start + match[0].length;
      if (pos.ch >= start && pos.ch <= end) return { from: { line: pos.line, ch: start }, to: { line: pos.line, ch: end } };
    }
    return null;
  }
  posToOffset(pos: EditorPosition): number {
    const lines = this.lines(), line = this.clampLine(pos.line);
    let offset = 0;
    for (let i = 0; i < line; i++) offset += lines[i].length + 1;
    return offset + Math.max(0, Math.min(pos.ch, lines[line].length));
  }
  offsetToPos(offset: number): EditorPosition {
    const safe = Math.max(0, Math.min(Math.trunc(offset), this.value.length));
    const before = this.value.slice(0, safe), line = before.split("\n").length - 1;
    return { line, ch: before.length - (before.lastIndexOf("\n") + 1) };
  }
  processLines<T>(read: (line: number, text: string) => T | null,
    write: (line: number, text: string, value: T | null) => EditorChange | void, ignoreEmpty = false): void {
    const changes: EditorChange[] = [];
    this.lines().forEach((text, line) => {
      if (ignoreEmpty && text.length === 0) return;
      const change = write(line, text, read(line, text));
      if (change) changes.push(change);
    });
    if (changes.length) this.transaction({ changes });
  }
  private lines(): string[] { return this.value.split("\n"); }
  private clampLine(line: number): number { return Math.max(0, Math.min(Math.trunc(line) || 0, this.lineCount() - 1)); }
  private clampPos(pos: EditorPosition): EditorPosition {
    const line = this.clampLine(pos.line);
    return { line, ch: Math.max(0, Math.min(Math.trunc(pos.ch) || 0, this.getLine(line).length)) };
  }
  private primaryRange(): EditorRange { const [from, to] = ordered(this.getCursor("anchor"), this.getCursor("head")); return { from, to }; }
  private commit(): void {
    this.undoStack.push({ value: this.value, selections: this.listSelections() });
    this.redoStack = [];
  }
}

function copyPos(pos: EditorPosition): EditorPosition { return { line: pos.line, ch: pos.ch }; }
function samePos(a: EditorPosition, b: EditorPosition): boolean { return a.line === b.line && a.ch === b.ch; }
function ordered(a: EditorPosition, b: EditorPosition): [EditorPosition, EditorPosition] {
  return a.line < b.line || (a.line === b.line && a.ch <= b.ch) ? [a, b] : [b, a];
}
