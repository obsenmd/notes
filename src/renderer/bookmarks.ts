import { path, originalFs as fs } from "../../platforms/platform";
import moment from "moment";
import type { App } from "../compat/plugin";
import { Setting } from "../compat/setting-controls";
import { Modal } from "../compat/ui";
import { t } from "../i18n";
import { writeJson } from "./config";

/** An entry in `.obsidian/bookmarks.json`; unknown fields written by other clients are preserved. */
export interface BookmarkItem {
  type: "file" | "folder" | "search" | "graph" | "url" | "group" | string;
  ctime?: number;
  path?: string;
  subpath?: string;
  title?: string;
  url?: string;
  query?: string;
  items?: BookmarkItem[];
  [key: string]: unknown;
}
export type BookmarkLocation = number[];

const asItems = (value: unknown): BookmarkItem[] =>
  Array.isArray(value) ? value.filter((item): item is BookmarkItem => !!item && typeof item === "object" && typeof (item as BookmarkItem).type === "string") : [];

function mapItems(items: BookmarkItem[], map: (item: BookmarkItem) => BookmarkItem | null): BookmarkItem[] {
  return items.flatMap(item => {
    const mapped = map(item.type === "group" ? { ...item, items: mapItems(asItems(item.items), map) } : item);
    return mapped ? [mapped] : [];
  });
}
function listAt(items: BookmarkItem[], parent: BookmarkLocation): BookmarkItem[] | null {
  let list = items;
  for (const index of parent) {
    const group = list[index];
    if (!group || group.type !== "group") return null;
    list = asItems(group.items);
  }
  return list;
}
function replaceList(items: BookmarkItem[], parent: BookmarkLocation, next: BookmarkItem[]): BookmarkItem[] {
  if (!parent.length) return next;
  const [index, ...rest] = parent;
  return items.map((item, position) => position === index ? { ...item, items: replaceList(asItems(item.items), rest, next) } : item);
}

const baseName = (filePath: string) => filePath.slice(filePath.lastIndexOf("/") + 1);
const withoutExtension = (name: string) => { const dot = name.lastIndexOf("."); return dot > 0 ? name.slice(0, dot) : name; };
const withoutMarkdown = (name: string) => name.replace(/\.md$/i, "");

/** Bookmark constructors, in the shapes the reference writes. */
export const fileBookmark = (filePath: string, subpath?: string): BookmarkItem => ({ type: "file", ctime: Date.now(), path: filePath, ...(subpath ? { subpath } : {}) });
export const folderBookmark = (folderPath: string): BookmarkItem => ({ type: "folder", ctime: Date.now(), path: folderPath });
export const groupBookmark = (title?: string): BookmarkItem => ({ type: "group", ctime: Date.now(), items: [], title: title || t("plugins.bookmarks.label-untitled-group") });
export const graphBookmark = (options?: unknown, title?: string): BookmarkItem => ({ type: "graph", ctime: Date.now(), title: title || t("plugins.bookmarks.label-untitled-graph"), ...(options ? { options } : {}) });
export const urlBookmark = (url: string, title?: string): BookmarkItem => ({ type: "url", ctime: Date.now(), url, title: title || "" });
export const searchBookmark = (query: string): BookmarkItem => ({ type: "search", ctime: Date.now(), query });

/** The label shown for a bookmark: its own title, or one derived from what it points at. */
export function bookmarkTitle(item: BookmarkItem): string {
  if (item.title) return item.title;
  if (item.type === "file" && item.subpath) return withoutExtension(baseName(item.path ?? "")) + item.subpath;
  if (item.type === "file") return withoutMarkdown(baseName(item.path ?? ""));
  if (item.type === "folder") return baseName(item.path ?? "");
  if (item.type === "search") return item.query ?? "";
  if (item.type === "url") return item.url ?? "";
  if (item.type === "graph") return t("plugins.bookmarks.label-untitled-graph");
  if (item.type === "group") return t("plugins.bookmarks.label-untitled-group");
  return item.title ?? "";
}

/** Bookmark tree persisted in the reference file format. */
export class BookmarkStore {
  items: BookmarkItem[] = [];
  /** Set when the data file exists but could not be parsed. */
  invalid = false;
  private extra: Record<string, unknown> = {};
  private readonly file: string;
  private readonly listeners = new Set<() => void>();
  private writing: Promise<void> = Promise.resolve();

  /** The store of the open vault, for menus built outside the bookmarks view. */
  static current: BookmarkStore | null = null;

  constructor(configDir: string) { this.file = path.join(configDir, "bookmarks.json"); BookmarkStore.current = this; }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("bookmarks.json must contain an object");
      const { items, ...extra } = parsed as Record<string, unknown>;
      this.items = asItems(items); this.extra = extra; this.invalid = false;
    } catch (error) {
      this.items = [];
      this.invalid = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    this.emit();
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of [...this.listeners]) listener(); }
  private commit(items: BookmarkItem[]): void {
    this.items = items; this.invalid = false;
    this.emit();
    const data = { ...this.extra, items };
    this.writing = this.writing.catch(() => undefined).then(() => writeJson(this.file, data));
  }

  get count(): number { const count = (items: BookmarkItem[]): number => items.reduce((sum, item) => sum + (item.type === "group" ? count(asItems(item.items)) : 1), 0); return count(this.items); }
  children(item: BookmarkItem): BookmarkItem[] { return asItems(item.items); }
  itemAt(location: BookmarkLocation): BookmarkItem | null { return listAt(this.items, location.slice(0, -1))?.[location.at(-1)!] ?? null; }
  /** Every group with its location, depth first. */
  groups(): Array<{ item: BookmarkItem; location: BookmarkLocation }> {
    const result: Array<{ item: BookmarkItem; location: BookmarkLocation }> = [];
    (function walk(items: BookmarkItem[], prefix: BookmarkLocation) { items.forEach((item, index) => { if (item.type === "group") { result.push({ item, location: [...prefix, index] }); walk(asItems(item.items), [...prefix, index]); } }); })(this.items, []);
    return result;
  }

  /** Location of the first bookmark matching the predicate. */
  find(predicate: (item: BookmarkItem) => boolean, items = this.items, prefix: BookmarkLocation = []): BookmarkLocation | null {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (predicate(item)) return [...prefix, index];
      if (item.type === "group") { const nested = this.find(predicate, asItems(item.items), [...prefix, index]); if (nested) return nested; }
    }
    return null;
  }
  /** Location of the bookmark for a file (and optional heading/block subpath). */
  findFile(filePath: string, subpath = ""): BookmarkLocation | null { return this.find(item => item.type === "file" && item.path === filePath && (item.subpath ?? "") === subpath); }
  /** Location of the bookmark for a file or folder itself, as the "Bookmark..." menu item looks it up. */
  findPath(target: string): BookmarkLocation | null { return this.find(item => (item.type === "folder" || (item.type === "file" && !item.subpath)) && item.path === target); }
  findUrl(url: string): BookmarkLocation | null { return this.find(item => item.type === "url" && item.url === url); }

  add(item: BookmarkItem, group: BookmarkLocation = []): void {
    const list = listAt(this.items, group);
    if (list) this.commit(replaceList(this.items, group, [...list, { ctime: Date.now(), ...item }]));
  }
  /** Inserts at a position inside a group (drops from other views, paste). */
  insert(item: BookmarkItem, group: BookmarkLocation, index: number): void {
    const list = listAt(this.items, group);
    if (!list) return;
    const next = [...list];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, { ctime: Date.now(), ...item });
    this.commit(replaceList(this.items, group, next));
  }
  remove(location: BookmarkLocation): void {
    const parent = location.slice(0, -1), list = listAt(this.items, parent);
    if (list) this.commit(replaceList(this.items, parent, list.filter((_item, index) => index !== location.at(-1))));
  }
  /** Removes several items at once; locations refer to the tree before the removal. */
  removeMany(locations: BookmarkLocation[]): void {
    const doomed = new Set(locations.map(location => this.itemAt(location)).filter(Boolean));
    if (doomed.size) this.commit(this.without(doomed as Set<BookmarkItem>));
  }
  private without(doomed: Set<BookmarkItem>, items = this.items): BookmarkItem[] {
    return items.flatMap(item => doomed.has(item) ? [] : [item.type === "group" ? { ...item, items: this.without(doomed, asItems(item.items)) } : item]);
  }
  update(location: BookmarkLocation, patch: Partial<BookmarkItem>): void {
    const parent = location.slice(0, -1), list = listAt(this.items, parent);
    if (!list) return;
    this.commit(replaceList(this.items, parent, list.map((item, index) => {
      if (index !== location.at(-1)) return item;
      const next = { ...item, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
      return next;
    })));
  }
  /** Moves an item to `index` inside the group at `targetParent`; a group cannot move into itself. */
  move(source: BookmarkLocation, targetParent: BookmarkLocation, index: number): void {
    const item = this.itemAt(source);
    if (!item || (targetParent.length >= source.length && source.every((part, position) => targetParent[position] === part))) return;
    const marker = Symbol("moving");
    const tagged = replaceList(this.items, source.slice(0, -1), listAt(this.items, source.slice(0, -1))!.map((entry, position) => position === source.at(-1) ? { ...entry, [marker]: true } : entry));
    const destination = [...(listAt(tagged, targetParent) ?? [])];
    destination.splice(Math.max(0, Math.min(index, destination.length)), 0, item);
    const inserted = replaceList(tagged, targetParent, destination);
    this.commit(mapItems(inserted, entry => (entry as unknown as Record<symbol, unknown>)[marker] ? null : entry));
  }

  /** Keeps bookmarks pointing at renamed or moved files and folders. */
  renamePath(oldPath: string, newPath: string): void {
    let changed = false;
    const next = mapItems(this.items, item => {
      if (!item.path || (item.path !== oldPath && !item.path.startsWith(`${oldPath}/`))) return item;
      changed = true; return { ...item, path: newPath + item.path.slice(oldPath.length) };
    });
    if (changed) this.commit(next);
  }
  /** A bookmark outlives its file, as in the reference: it is hidden until the path exists again. */
  removePath(deleted: string): void {
    if (this.find(item => !!item.path && (item.path === deleted || item.path.startsWith(`${deleted}/`)))) this.emit();
  }
}

function buttonRow(modal: Modal): HTMLElement { const row = document.createElement("div"); row.className = "modal-button-container"; modal.modalEl.append(row); return row; }
function button(parent: HTMLElement, text: string, className: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = text; if (className) el.className = className;
  el.addEventListener("click", onClick); parent.append(el);
  return el;
}
/** Fills a "Bookmark group" dropdown; returns the location for an option value. */
function groupOptions(store: BookmarkStore, select: HTMLSelectElement): Map<string, BookmarkLocation> {
  const options = new Map<string, BookmarkLocation>();
  for (const { item, location } of store.groups()) {
    const option = document.createElement("option");
    option.value = location.join("-"); option.textContent = " ".repeat(4 * (location.length - 1)) + bookmarkTitle(item);
    select.append(option); options.set(option.value, location);
  }
  return options;
}

/**
 * The "Add bookmark" / "Edit bookmark" dialog. `location` is given when the bookmark already exists;
 * `group` preselects the group a new bookmark goes to.
 */
export function openBookmarkDialog(app: App, store: BookmarkStore, item: BookmarkItem, options: { location?: BookmarkLocation | null; group?: BookmarkLocation; onSaved?: () => void } = {}): void {
  const location = options.location ?? null, existing = !!location;
  const initialGroup = existing ? location!.slice(0, -1) : options.group ?? [];
  let group = initialGroup, title = item.title ?? "";
  class BookmarkDialog extends Modal {
    override onOpen() {
      this.modalEl.classList.add("mod-bookmark", "mod-lg");
      this.setTitle(t(existing ? "plugins.bookmarks.action-edit-bookmark" : "plugins.bookmarks.action-add-bookmark"));
      const save = () => {
        const patch = { title: title || undefined };
        if (existing) {
          store.update(location!, patch);
          if (group.join("-") !== initialGroup.join("-")) store.move(location!, group, Number.MAX_SAFE_INTEGER);
        } else { const next = { ...item, ...patch }; if (!title) delete next.title; store.add(next, group); }
        options.onSaved?.();
        this.close();
      };
      const readOnly = (name: string, value: string) => new Setting(this.contentEl).setName(name).addText(text => text.setDisabled(true).setValue(value));
      if (item.type === "file" || item.type === "folder") readOnly(t("plugins.bookmarks.option-path"), withoutMarkdown(item.path ?? "") + (item.type === "file" ? item.subpath ?? "" : ""));
      else if (item.type === "search") readOnly(t("plugins.bookmarks.option-query"), item.query ?? "");
      else if (item.type === "url") readOnly(t("obsen.bookmarks.option-url"), item.url ?? "");
      let input: HTMLInputElement | null = null;
      new Setting(this.contentEl).setName(t("plugins.bookmarks.option-title")).addText(text => {
        input = text.inputEl; input.enterKeyHint = "done";
        text.setPlaceholder(bookmarkTitle(item)).setValue(title).onChange(value => { title = value; });
        input.addEventListener("keydown", event => { if (!event.isComposing && event.key === "Enter") { event.preventDefault(); save(); } });
      });
      new Setting(this.contentEl).setName(t("plugins.bookmarks.option-group")).addDropdown(dropdown => {
        const locations = groupOptions(store, dropdown.selectEl);
        // A group cannot be filed under itself.
        if (existing && item.type === "group") for (const option of [...dropdown.selectEl.options]) if (option.value === location!.join("-") || option.value.startsWith(location!.join("-") + "-")) option.remove();
        dropdown.selectEl.value = group.join("-");
        if (!group.length) dropdown.selectEl.selectedIndex = -1;
        dropdown.onChange(value => { group = locations.get(value) ?? []; });
      });
      const row = buttonRow(this);
      if (existing) button(row, t("plugins.bookmarks.menu-opt-remove"), "mod-destructive mod-secondary", () => { store.remove(location!); this.close(); });
      button(row, t("dialogue.button-cancel"), "mod-cancel", () => this.close());
      button(row, t("dialogue.button-save"), "mod-cta", save);
      const field = input as HTMLInputElement | null;
      field?.focus(); field?.select();
    }
  }
  new BookmarkDialog(app).open();
}

/** The dialog that files several bookmarks under a new group ("Bookmark all tabs...", multi-selection). */
export function openBookmarksDialog(app: App, store: BookmarkStore, items: BookmarkItem[]): void {
  if (!items.length) return;
  const placeholder = moment().format("LLL");
  let title = "", group: BookmarkLocation = [];
  class BookmarksDialog extends Modal {
    override onOpen() {
      this.modalEl.classList.add("mod-bookmark");
      this.setTitle(t("obsen.bookmarks.title-add-many", { count: items.length }));
      const save = () => { store.add({ ...groupBookmark(title || placeholder), items }, group); this.close(); };
      new Setting(this.contentEl).setName(t("plugins.bookmarks.option-title")).addText(text => {
        text.setPlaceholder(placeholder).setValue(title).onChange(value => { title = value; });
        text.inputEl.addEventListener("keydown", event => { if (!event.isComposing && event.key === "Enter") { event.preventDefault(); save(); } });
      });
      new Setting(this.contentEl).setName(t("plugins.bookmarks.option-group")).addDropdown(dropdown => {
        const locations = groupOptions(store, dropdown.selectEl);
        dropdown.selectEl.selectedIndex = -1;
        dropdown.onChange(value => { group = locations.get(value) ?? []; });
      });
      const row = buttonRow(this);
      button(row, t("dialogue.button-cancel"), "mod-cancel", () => this.close());
      button(row, t("dialogue.button-save"), "mod-cta", save);
    }
  }
  new BookmarksDialog(app).open();
}
