import { ipcRenderer } from "../../../platforms/platform";
import moment from "moment";
import { createDiv } from "../../compat/dom";
import type { App } from "../../compat/plugin";
import { Modal, Notice } from "../../compat/ui";
import { TFile } from "../../compat/vault";
import { t } from "../../i18n";
import { useT } from "../../i18n/react";
import { readCorePluginData } from "../core-plugins";
import { Group, TextInput, describe, usePluginData, type SettingsEnvironment } from "../settings/controls";
import { SettingItem } from "../ui";
import type { CorePluginModule } from "./types";

// ---------------------------------------------------------------------------------------------
// DOM helpers shared by the file recovery, Sync and Publish dialogs (reference component markup).
// ---------------------------------------------------------------------------------------------

/** `Db` in the reference: sizes with two decimals above bytes and thousands separators. */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unit = units.length - 1;
  for (let i = 0; i < units.length; i++) if (bytes < Math.pow(1024, i + 1)) { unit = i; break; }
  const value = bytes / Math.pow(1024, unit), digits = unit === 0 ? 0 : 2;
  const whole = String(parseInt(value.toFixed(digits), 10));
  const head = whole.length > 3 ? whole.length % 3 : 0;
  return `${head ? `${whole.slice(0, head)},` : ""}${whole.slice(head).replace(/(\d{3})(?=\d)/g, "$1,")}${digits ? `.${Math.abs(value - Math.floor(value)).toFixed(digits).slice(2)}` : ""} ${units[unit]}`;
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const extensionOf = (path: string) => { const name = baseName(path), dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""; };
/** Path without a trailing `.md`, as the reference shows notes. */
export const stripMd = (path: string) => extensionOf(path) === "md" ? path.slice(0, -3) : path;

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => undefined);
  new Notice(t("interface.copied_generic"));
}

/** The reference search field: `.search-input-container > input[type=search] + .search-input-clear-button`. */
export function createSearchInput(parent: HTMLElement, placeholder: string, onChange?: (value: string) => void): { containerEl: HTMLElement; inputEl: HTMLInputElement } {
  const containerEl = parent.createDiv("search-input-container");
  const inputEl = containerEl.createEl("input", { type: "search", placeholder, attr: { enterkeyhint: "search", spellcheck: "false" } });
  const clear = containerEl.createDiv("search-input-clear-button");
  clear.addEventListener("mousedown", event => event.preventDefault());
  clear.addEventListener("click", () => { inputEl.value = ""; inputEl.dispatchEvent(new Event("input", { bubbles: true })); inputEl.focus(); });
  inputEl.addEventListener("input", () => onChange?.(inputEl.value));
  return { containerEl, inputEl };
}

export interface ToggleHandle { toggleEl: HTMLElement; getValue(): boolean; setValue(value: boolean): void; setDisabled(disabled: boolean): void; onChange(callback: (value: boolean) => void): void }
/** The reference switch (`label.checkbox-container > input`), optionally in its small form. */
export function createToggle(parent: HTMLElement, small = false): ToggleHandle {
  let on = false, disabled = false, listener: ((value: boolean) => void) | undefined;
  const toggleEl = parent.createEl("label", { cls: small ? "checkbox-container mod-small" : "checkbox-container", attr: { tabIndex: 0 } });
  toggleEl.createEl("input", { attr: { type: "checkbox", tabIndex: -1 } });
  const handle: ToggleHandle = {
    toggleEl,
    getValue: () => on,
    setValue(value) { if (on === value) return; on = value; toggleEl.toggleClass("is-enabled", value); listener?.(value); },
    setDisabled(value) { disabled = value; toggleEl.toggleClass("is-disabled", value); },
    onChange(callback) { listener = callback; },
  };
  const flip = () => { if (!disabled) handle.setValue(!on); };
  toggleEl.addEventListener("click", event => { event.preventDefault(); flip(); });
  toggleEl.addEventListener("keydown", event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); flip(); } });
  return handle;
}

/** Roving tab index over a list, as the reference's sidebar lists do. */
export function rovingFocus(container: HTMLElement, items: () => HTMLElement[]): (index: number, options?: FocusOptions) => void {
  let current: HTMLElement | null = null;
  container.addEventListener("focusout", event => { if (current && event.target === current) { current.setAttr("tabIndex", -1); current = null; } });
  return (index, options) => {
    const el = items()[index];
    if (!el) return;
    if (current && current !== el) current.setAttr("tabIndex", -1);
    current = el; el.setAttr("tabIndex", 0); el.focus({ preventScroll: true, ...options }); el.scrollIntoView({ block: "nearest" });
  };
}

/** Marks a container as loading while a task runs (`CE` in the reference). */
export async function withLoading<T>(el: HTMLElement, task: () => Promise<T>): Promise<T> {
  el.addClass("is-loading");
  try { return await task(); } finally { el.removeClass("is-loading"); }
}

export interface ConfirmModalOptions { title: string; body(el: HTMLElement): void; cta: string; destructive?: boolean; cancel?: string }
/** The reference confirmation dialog: content, then a button row with the accept button first. */
export function confirmModal(app: App, options: ConfirmModalOptions): Promise<boolean> {
  return new Promise(resolve => {
    let accepted = false;
    const modal = new Modal(app);
    modal.setTitle(options.title);
    options.body(modal.contentEl);
    const buttons = modal.modalEl.createDiv("modal-button-container");
    const accept = buttons.createEl("button", { cls: options.destructive ? "mod-destructive mod-cta" : "mod-cta", text: options.cta });
    accept.addEventListener("click", () => { accepted = true; modal.close(); });
    buttons.createEl("button", { cls: "mod-cancel", text: options.cancel ?? t("dialogue.button-cancel") }).addEventListener("click", () => modal.close());
    modal.setCloseCallback(() => resolve(accepted));
    modal.open();
    accept.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// Diff view (`n2` in the reference): line diff, word-level highlights for similar lines, folding.
// ---------------------------------------------------------------------------------------------

type DiffOp = -1 | 0 | 1;
const MAX_EDIT_DISTANCE = 3000;

/** Myers shortest edit script over two sequences, as runs of [operation, items]. */
function diffSequences<T>(a: T[], b: T[]): Array<[DiffOp, T[]]> {
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start, runs: Array<[DiffOp, T[]]> = [];
  const push = (op: DiffOp, item: T) => { const last = runs[runs.length - 1]; if (last && last[0] === op) last[1].push(item); else runs.push([op, [item]]); };
  for (let i = 0; i < start; i++) push(0, a[i]);
  if (n && m) {
    // Each trace entry keeps the diagonals -d-1..d+1 reached before step d; very different inputs fall back to replace-all.
    const max = Math.min(n + m, MAX_EDIT_DISTANCE), offset = max + 1, trace: Int32Array[] = [];
    const v = new Int32Array(2 * max + 3);
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      trace.push(v.slice(offset - d - 1, offset + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
    }
    if (found < 0) {
      for (let i = 0; i < n; i++) push(-1, a[start + i]);
      for (let i = 0; i < m; i++) push(1, b[start + i]);
    } else {
      const steps: Array<[DiffOp, T]> = [];
      let x = n, y = m;
      for (let d = found; d > 0; d--) {
        const previous = trace[d], at = (k: number) => previous[k + d + 1], k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK), prevY = prevX - prevK;
        while (x > prevX && y > prevY) { x--; y--; steps.push([0, a[start + x]]); }
        if (x === prevX) { y--; steps.push([1, b[start + y]]); } else { x--; steps.push([-1, a[start + x]]); }
      }
      while (x > 0 && y > 0) { x--; y--; steps.push([0, a[start + x]]); }
      // Deletions are reported before insertions within one change, as diff-match-patch does.
      let pendingInsert: T[] = [];
      const flush = () => { for (const item of pendingInsert) push(1, item); pendingInsert = []; };
      for (let i = steps.length - 1; i >= 0; i--) {
        const [op, item] = steps[i];
        if (op === 1) pendingInsert.push(item); else if (op === -1) push(-1, item); else { flush(); push(0, item); }
      }
      flush();
    }
  } else {
    for (let i = 0; i < n; i++) push(-1, a[start + i]);
    for (let i = 0; i < m; i++) push(1, b[start + i]);
  }
  for (let i = endA; i < a.length; i++) push(0, a[i]);
  return runs;
}

const splitLines = (text: string) => { const lines = text.split("\n"); if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); return lines; };
const splitWords = (text: string) => text.match(/\s+|[^\s\w]|\w+/g) ?? [];

/** Renders the changes from `before` to `after` in the reference's `.diff-view` markup. */
export function renderDiff(before: string, after: string): HTMLElement {
  const root = createDiv("diff-view");
  const line = (content: string | DocumentFragment | null, side: "left" | "right" | null) => {
    const el = createDiv("diff-line");
    if (side) el.addClass(`mod-${side}`);
    if (content !== null) el.setText(content);
    el.createEl("br");
    return el;
  };
  let equal: HTMLElement[] = [], left: HTMLElement[] = [], right: HTMLElement[] = [];
  const flushEqual = (last = false) => {
    if (!equal.length) return;
    const first = root.childNodes.length === 0, limit = first || last ? 5 : 10;
    if (equal.length > limit) {
      const hidden: HTMLElement[] = [], fold = createDiv("diff-collapsed");
      fold.addEventListener("click", () => { for (const el of hidden) fold.parentNode?.insertBefore(el, fold); fold.detach(); });
      if (first) { hidden.push(...equal.slice(0, -3)); root.append(fold, ...equal.slice(-3)); }
      else if (last) { root.append(...equal.slice(0, 3), fold); hidden.push(...equal.slice(3)); }
      else { root.append(...equal.slice(0, 3)); hidden.push(...equal.slice(3, -3)); root.append(fold, ...equal.slice(-3)); }
      fold.setText(t("obsen.diff.lines-folded", { count: hidden.length }));
    } else root.append(...equal);
    equal = [];
  };
  const flushChanged = () => { if (left.length || right.length) { root.append(...left, ...right); left = []; right = []; } };
  const add = (oldLine: string | null, newLine: string | null) => {
    if (oldLine === newLine) { flushChanged(); equal.push(line(oldLine, null)); return; }
    if (oldLine && newLine) {
      const words = diffSequences(splitWords(oldLine), splitWords(newLine));
      let distance = 0, inserted = 0, deleted = 0;
      for (const [op, items] of words) {
        const size = items.join("").length;
        if (op === 1) inserted += size; else if (op === -1) deleted += size; else { distance += Math.max(inserted, deleted); inserted = deleted = 0; }
      }
      distance += Math.max(inserted, deleted);
      if (distance < Math.max(oldLine.length, newLine.length) / 2) {
        const oldFragment = document.createDocumentFragment(), newFragment = document.createDocumentFragment();
        for (const [op, items] of words) {
          const text = items.join("");
          if (op === 1) newFragment.createSpan({ cls: "diff-changed", text });
          else if (op === -1) oldFragment.createSpan({ cls: "diff-changed", text });
          else { oldFragment.createSpan({ text }); newFragment.createSpan({ text }); }
        }
        flushEqual(); left.push(line(oldFragment, "left")); right.push(line(newFragment, "right"));
        return;
      }
    }
    flushEqual(); left.push(line(oldLine, "left")); right.push(line(newLine, "right"));
  };
  const runs = diffSequences(splitLines(before.endsWith("\n") ? before : `${before}\n`), splitLines(after.endsWith("\n") ? after : `${after}\n`));
  for (let i = 0; i < runs.length; i++) {
    const [op, lines] = runs[i], next = runs[i + 1];
    if (op === -1 && next?.[0] === 1) {
      for (let j = 0; j < Math.max(lines.length, next[1].length); j++) add(lines[j] ?? null, next[1][j] ?? null);
      i++;
    } else for (const text of lines) add(op === 1 ? null : text, op === -1 ? null : text);
  }
  flushChanged(); flushEqual(true);
  return root;
}


// ---------------------------------------------------------------------------------------------
// Snapshot store: IndexedDB database `<vault id>-backup`, store `backups` ({ path, ts, data }).
// ---------------------------------------------------------------------------------------------

export interface Snapshot { path: string; ts: number; data: string }
interface RecoveryOptions { intervalMinutes: number; keepDays: number }

const DEFAULTS: RecoveryOptions = { intervalMinutes: 5, keepDays: 7 };
const STORE = "backups";
const SNAPSHOT_EXTENSIONS = new Set(["md", "canvas", "base"]);

const request = <T,>(source: IDBRequest<T>) => new Promise<T>((resolve, reject) => { source.onsuccess = () => resolve(source.result); source.onerror = () => reject(source.error); });

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { autoIncrement: true });
      store.createIndex("path", "path"); store.createIndex("ts", "ts");
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => reject(new Error("blocked"));
  });
}

function vaultDatabaseName(app: App): string {
  const vault = ipcRenderer.sendSync("vault") as { id?: string; path?: string } | null;
  return `${vault?.id || vault?.path || app.vault.getName()}-backup`;
}

export class FileRecovery {
  db: IDBDatabase | null = null;
  private options: RecoveryOptions = { ...DEFAULTS };
  private tsCache: Record<string, number> = {};
  private readonly pendingFiles = new Set<string>();
  private disposers: Array<() => void> = [];

  constructor(readonly app: App, private readonly configDir: string) {}

  async enable(): Promise<void> {
    const { app } = this;
    await this.loadOptions();
    const changed = (file: unknown) => { void this.onFileChanged(file).catch(error => console.error(error)); };
    const refs = [app.vault.on("modify", changed), app.workspace.on("file-open", changed)];
    this.disposers.push(() => { app.vault.offref(refs[0]); app.workspace.offref(refs[1]); });
    // Files indexed while the vault loads are not "created"; only later additions are snapshotted.
    app.workspace.onLayoutReady(() => { if (!this.disposed) { const ref = app.vault.on("create", changed); this.disposers.push(() => app.vault.offref(ref)); } });
    const settings = app.workspace.on("core-plugin-settings-change", (id: unknown) => { if (id === "file-recovery") void this.loadOptions(); });
    this.disposers.push(() => app.workspace.offref(settings));
    const resave = window.setInterval(() => void this.resave(), 60_000), hourly = window.setInterval(() => void this.cleanup(), 3_600_000);
    this.disposers.push(() => { window.clearInterval(resave); window.clearInterval(hourly); });
    try {
      const db = await openDatabase(vaultDatabaseName(app));
      if (this.disposed) { db.close(); return; }
      this.db = db;
      const first = window.setTimeout(() => void this.cleanup(), 60_000);
      this.disposers.push(() => window.clearTimeout(first));
    } catch (error) { console.error("File Recovery failed to connect to IndexedDB", error); }
  }

  private disposed = false;
  disable(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.db?.close(); this.db = null;
  }

  private async loadOptions(): Promise<void> {
    try { this.options = { ...DEFAULTS, ...await readCorePluginData(this.configDir, "file-recovery") as Partial<RecoveryOptions> }; }
    catch (error) { console.error(error); }
  }

  private store(mode: IDBTransactionMode): IDBObjectStore { return this.db!.transaction(STORE, mode, { durability: "relaxed" }).objectStore(STORE); }

  async getLastVersionByPath(path: string): Promise<Snapshot | null> {
    const cursor = await request(this.store("readonly").index("path").openCursor(path, "prev"));
    return cursor ? cursor.value as Snapshot : null;
  }

  /** Every snapshot of one file, newest first. */
  async getVersions(path: string): Promise<Snapshot[]> {
    if (!this.db) return [];
    const versions = await request(this.store("readonly").index("path").getAll(path)) as Snapshot[];
    return versions.sort((a, b) => b.ts - a.ts);
  }

  /** Paths that have at least one snapshot. */
  getPaths(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) { resolve([]); return; }
      const paths: string[] = [], cursorRequest = this.store("readonly").index("path").openCursor(null, "nextunique");
      cursorRequest.onsuccess = () => { const cursor = cursorRequest.result; if (cursor) { paths.push((cursor.value as Snapshot).path); cursor.continue(); } else resolve(paths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))); };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  }

  private async onFileChanged(file: unknown): Promise<void> {
    if (!(file instanceof TFile) || !SNAPSHOT_EXTENSIONS.has(file.extension) || !this.db) return;
    const path = file.path;
    let last: Snapshot | null = null, lastTs = this.tsCache[path];
    if (!Object.hasOwn(this.tsCache, path)) { last = await this.getLastVersionByPath(path); lastTs = this.tsCache[path] = last ? last.ts : 0; }
    const now = Date.now();
    let interval = Number(this.options.intervalMinutes);
    if (isNaN(interval) || interval < 0) interval = 5;
    if (now - lastTs < interval * 60_000) { this.pendingFiles.add(path); return; }
    const data = await this.app.vault.cachedRead(file);
    if (!this.db) return;
    last ??= await this.getLastVersionByPath(path);
    if (last && last.data === data) return;
    await request(this.store("readwrite").add({ path, ts: now, data } satisfies Snapshot));
    this.tsCache[path] = now;
  }

  /** Adds a snapshot regardless of the interval (after restoring a version). */
  async forceAdd(path: string, data: string): Promise<void> {
    if (!this.db) return;
    const ts = Date.now();
    await request(this.store("readwrite").add({ path, ts, data } satisfies Snapshot));
    this.tsCache[path] = ts;
  }

  private async resave(): Promise<void> {
    for (const path of [...this.pendingFiles]) {
      this.pendingFiles.delete(path);
      await this.onFileChanged(this.app.vault.getAbstractFileByPath(path)).catch(error => console.error(error));
    }
  }

  private cleanup(): Promise<void> {
    return new Promise(resolve => {
      if (!this.db) { resolve(); return; }
      let keep = Number(this.options.keepDays);
      if (isNaN(keep) || keep < 1) keep = 7;
      const cursorRequest = this.store("readwrite").index("ts").openCursor(IDBKeyRange.upperBound(Date.now() - keep * 86_400_000));
      cursorRequest.onsuccess = () => { const cursor = cursorRequest.result; if (cursor) { cursor.delete(); cursor.continue(); } else resolve(); };
      cursorRequest.onerror = () => { console.error(cursorRequest.error); resolve(); };
    });
  }

  clearData(): void {
    if (this.db) this.store("readwrite").clear();
    this.tsCache = {};
  }

  openModal(path?: string): void {
    const modal = new FileRecoveryModal(this.app, this);
    modal.open();
    if (path) void modal.switchToPath(path);
  }
}

let instance: FileRecovery | null = null;

/** Opens "Saved snapshots" (optionally on one file); false when the plugin is not enabled. */
export function openLocalHistory(path?: string): boolean {
  if (!instance) return false;
  instance.openModal(path);
  return true;
}
export const isFileRecoveryEnabled = () => instance !== null;

// ---------------------------------------------------------------------------------------------
// "File recovery" dialog
// ---------------------------------------------------------------------------------------------

/** File picker under the dialog's search field (`.suggestion-container`). */
class PathSuggest {
  private rootEl: HTMLElement | null = null;
  private values: string[] = [];
  private selected = 0;
  get isOpen() { return this.rootEl !== null; }

  constructor(private readonly inputEl: HTMLInputElement, private readonly paths: string[], private readonly onChoose: (path: string) => void) {
    inputEl.addEventListener("input", this.onInputChange);
    inputEl.addEventListener("focus", this.onInputChange);
    inputEl.addEventListener("blur", this.close);
    inputEl.addEventListener("keydown", this.onKeyDown);
  }

  destroy(): void {
    this.close();
    this.inputEl.removeEventListener("input", this.onInputChange); this.inputEl.removeEventListener("focus", this.onInputChange);
    this.inputEl.removeEventListener("blur", this.close); this.inputEl.removeEventListener("keydown", this.onKeyDown);
  }

  readonly onInputChange = () => {
    const query = this.inputEl.value.toLowerCase();
    this.values = this.paths.filter(path => path.toLowerCase().includes(query)).slice(0, 100);
    if (!this.values.length) { this.close(); return; }
    const doc = this.inputEl.ownerDocument;
    if (!this.rootEl) { this.rootEl = doc.body.createDiv("suggestion-container"); this.rootEl.createDiv("suggestion"); }
    const list = this.rootEl.firstElementChild as HTMLElement;
    list.empty();
    this.values.forEach((path, index) => {
      const item = list.createDiv({ cls: "suggestion-item", text: stripMd(path) });
      item.addEventListener("mousemove", () => this.select(index));
      item.addEventListener("mousedown", event => event.preventDefault());
      item.addEventListener("click", () => this.choose(index));
    });
    const rect = (this.inputEl.parentElement ?? this.inputEl).getBoundingClientRect();
    Object.assign(this.rootEl.style, { left: `${rect.left}px`, top: `${rect.bottom + 5}px`, width: `${rect.width}px` });
    this.select(0);
  };

  private readonly close = () => { this.rootEl?.remove(); this.rootEl = null; };

  private select(index: number): void {
    this.selected = (index + this.values.length) % this.values.length;
    this.rootEl?.querySelectorAll<HTMLElement>(".suggestion-item").forEach((el, i) => { el.toggleClass("is-selected", i === this.selected); if (i === this.selected) el.scrollIntoView({ block: "nearest" }); });
  }

  private choose(index: number): void {
    const path = this.values[index];
    this.close();
    if (path) this.onChoose(path);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.rootEl || event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopImmediatePropagation(); this.select(this.selected + (event.key === "ArrowDown" ? 1 : -1)); }
    else if (event.key === "Enter") { event.preventDefault(); this.choose(this.selected); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
  };
}

class FileRecoveryModal extends Modal {
  private currentVersion: Snapshot | null = null;
  private activeVersionEl: HTMLElement | null = null;
  private versions: Snapshot[] = [];
  private versionEls: HTMLElement[] = [];
  private suggestion: PathSuggest | null = null;
  private readonly searchInputEl: HTMLInputElement;
  private readonly versionListEl: HTMLElement;
  private readonly fileContentEl: HTMLElement;
  private readonly contentTitleEl: HTMLElement;
  private readonly textareaEl: HTMLTextAreaElement;
  private readonly diffEl: HTMLElement;
  private readonly diffToggle: ToggleHandle;
  private readonly focusVersionAt: (index: number, options?: FocusOptions) => void;

  constructor(app: App, private readonly plugin: FileRecovery) {
    super(app);
    this.setTitle(t("plugins.file-recovery.name"));
    this.modalEl.addClass("mod-sync-history", "mod-sidebar-layout");
    const inner = this.contentEl.createDiv("modal-sidebar mod-history").createDiv("modal-sidebar-inner");
    const search = createSearchInput(inner, t("plugins.file-recovery.placeholder-choose-file"));
    search.containerEl.addClass("mod-raised");
    this.searchInputEl = search.inputEl;
    this.searchInputEl.addEventListener("keydown", event => {
      const input = this.searchInputEl;
      if (event.key !== "ArrowDown" || this.suggestion?.isOpen || input.selectionStart !== input.value.length) return;
      event.preventDefault(); this.focusVersionAt(0);
    });
    const list = this.versionListEl = inner.createDiv("modal-sidebar-list");
    list.setAttr("tabIndex", -1);
    this.focusVersionAt = rovingFocus(list, () => this.versionEls);
    list.addEventListener("keydown", event => {
      if (event.isComposing || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target === list) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.focusVersionAt(Math.max(0, this.activeVersionEl ? this.versionEls.indexOf(this.activeVersionEl) : 0)); }
        return;
      }
      const index = this.versionEls.indexOf(target);
      if (index === -1) return;
      if (event.key === "ArrowUp" && index === 0) { event.preventDefault(); this.searchInputEl.focus(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.focusVersionAt(index + (event.key === "ArrowDown" ? 1 : -1)); }
      else if (event.key === "Enter") { event.preventDefault(); this.selectVersion(index); }
    });

    const container = this.fileContentEl = this.contentEl.createDiv("sync-history-content-container mod-empty");
    container.createEl("p", { cls: "sync-history-content-empty", text: t("plugins.file-recovery.label-select-file") });
    const content = container.createDiv("sync-history-content");
    const titlebar = content.createDiv("modal-setting-titlebar");
    this.contentTitleEl = titlebar.createDiv("modal-setting-title");
    const actions = titlebar.createDiv("modal-setting-titlebar-actions");
    this.diffToggle = createToggle(actions.createSpan({ text: t("plugins.sync.label-show-diff"), cls: "modal-setting-titlebar-toggle" }), true);
    actions.createEl("button", { text: t("interface.label-copy-short") }).addEventListener("click", () => { if (this.currentVersion) copyText(this.currentVersion.data); });
    actions.createEl("button", { text: t("plugins.sync.label-restore-this-version") }).addEventListener("click", () => { void this.restore().catch(error => new Notice(error instanceof Error ? error.message : String(error))); });
    this.textareaEl = content.createEl("textarea", { cls: "file-recovery-text", attr: { spellcheck: "false" } });
    this.diffEl = content.createDiv("file-recovery-diff");
  }

  private async restore(): Promise<void> {
    const version = this.currentVersion;
    if (!version) return;
    const { vault } = this.app, { data, path, ts } = version, folder = dirName(path);
    if (folder && !await vault.adapter.exists(folder)) await vault.createFolder(folder);
    const time = moment(ts).fromNow(), existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await vault.modify(existing, data); else await vault.create(path, data);
    await this.plugin.forceAdd(path, data);
    new Notice(t("plugins.sync.msg-restored-version", { time }));
    await this.loadVersions(path);
  }

  async switchToPath(path: string): Promise<void> {
    const name = stripMd(path);
    this.searchInputEl.value = name; this.searchInputEl.blur();
    this.contentTitleEl.setText(name); this.setTitle(name);
    await this.loadVersions(path);
    this.focusVersionAt(0, { focusVisible: false } as FocusOptions);
  }

  private selectVersion(index: number): void {
    const version = this.versions[index], el = this.versionEls[index];
    if (!version) return;
    this.activeVersionEl?.removeClass("is-active");
    this.activeVersionEl = el; el.addClass("is-active");
    this.fileContentEl.removeClass("mod-empty");
    this.currentVersion = version;
    this.openHistory(version, this.versions[index + 1]);
  }

  private async loadVersions(path: string): Promise<void> {
    const list = this.versionListEl;
    list.empty(); this.versionEls = [];
    const versions = this.versions = await this.plugin.getVersions(path);
    this.activeVersionEl = null;
    versions.forEach((version, index) => {
      const item = list.createDiv("modal-sidebar-list-item file-recovery-list-item-header tappable");
      item.setAttr("tabIndex", -1);
      const details = item.createDiv({ cls: "modal-sidebar-list-item-details file-recovery-list-item-details", text: moment(version.ts).format("llll") });
      details.createDiv("u-small u-muted").setText(formatBytes(version.data.length));
      details.addEventListener("click", () => { this.selectVersion(index); this.focusVersionAt(index, { focusVisible: false } as FocusOptions); });
      this.versionEls.push(item);
    });
    if (versions.length > 0) this.selectVersion(0);
  }

  private openHistory(version: Snapshot, previous?: Snapshot): void {
    const { textareaEl, diffEl, diffToggle } = this;
    textareaEl.value = version.data;
    textareaEl.setAttr("data-ext", extensionOf(version.path));
    diffEl.empty();
    let rendered = false;
    const update = () => {
      const showDiff = diffToggle.getValue();
      textareaEl.style.display = showDiff ? "none" : ""; diffEl.style.display = showDiff ? "" : "none";
      if (showDiff && !rendered) { rendered = true; diffEl.empty(); diffEl.appendChild(renderDiff(previous ? previous.data : "", version.data)); }
    };
    diffToggle.onChange(update); update();
    if (!this.fileContentEl.parentNode) this.contentEl.appendChild(this.fileContentEl);
  }

  override async onOpen(): Promise<void> {
    const paths = await withLoading(this.contentEl, () => this.plugin.getPaths()).catch(error => { console.error(error); return [] as string[]; });
    if (!paths.length) { this.contentEl.createEl("p", { text: t("plugins.file-recovery.label-no-history-found") }); return; }
    const input = this.searchInputEl;
    this.suggestion = new PathSuggest(input, paths, path => { void this.switchToPath(path); });
    if (!input.value) { if (input.ownerDocument.activeElement === input) this.suggestion.onInputChange(); else input.focus({ preventScroll: true }); }
  }

  override onClose(): void { this.suggestion?.destroy(); this.suggestion = null; }
}

// ---------------------------------------------------------------------------------------------
// Settings tab and module
// ---------------------------------------------------------------------------------------------

function FileRecoverySettings({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const [data, set] = usePluginData(environment, "file-recovery", { ...DEFAULTS });
  const app = environment.host.app;
  if (typeof indexedDB === "undefined") return <Group><SettingItem name={t("interface.msg-indexed-db-not-supported")} description={t("interface.msg-indexed-db-i-o-s")} /></Group>;
  const number = (value: string, fallback: number, min: number) => { const parsed = Number(value); return value.trim() === "" || isNaN(parsed) ? fallback : Math.max(min, parsed); };
  const clear = async () => {
    const confirmed = await confirmModal(app, {
      title: t("plugins.file-recovery.option-clear"), cta: t("plugins.file-recovery.button-clear-history"), destructive: true,
      body: el => { el.createEl("p", { cls: "mod-warning", text: t("plugins.file-recovery.label-clear-warning") }); },
    });
    if (!confirmed) return;
    instance?.clearData();
    new Notice(t("plugins.file-recovery.msg-clear-complete"));
  };
  return <Group>
    <SettingItem name={t("plugins.file-recovery.option-interval")} description={describe("plugins.file-recovery.option-interval")}>
      <TextInput type="number" value={String(data.intervalMinutes)} onChange={value => set({ intervalMinutes: number(value, DEFAULTS.intervalMinutes, 0) })} />
    </SettingItem>
    <SettingItem name={t("plugins.file-recovery.option-keep")} description={describe("plugins.file-recovery.option-keep")}>
      <TextInput type="number" value={String(data.keepDays)} onChange={value => set({ keepDays: number(value, DEFAULTS.keepDays, 1) })} />
    </SettingItem>
    <SettingItem name={t("plugins.file-recovery.option-open-history")} description={describe("plugins.file-recovery.option-open-history")}>
      <button onClick={() => { openLocalHistory(); }}>{t("plugins.file-recovery.button-view-history")}</button>
    </SettingItem>
    <SettingItem name={t("plugins.file-recovery.option-clear")} description={describe("plugins.file-recovery.option-clear")}>
      <button className="mod-destructive" onClick={() => void clear()}>{t("plugins.file-recovery.button-clear-history")}</button>
    </SettingItem>
  </Group>;
}

export const fileRecoveryPlugin: CorePluginModule = {
  id: "file-recovery",
  commands: ({ app }) => [{
    id: "file-recovery:open",
    run: () => { const file = app.workspace.getActiveFile(); openLocalHistory(file instanceof TFile && file.extension === "md" ? file.path : ""); },
  }],
  install({ app, configDir }) {
    const recovery = instance = new FileRecovery(app, configDir);
    void recovery.enable().catch(error => console.error(error));
    return () => { recovery.disable(); if (instance === recovery) instance = null; };
  },
  settings: FileRecoverySettings,
};

