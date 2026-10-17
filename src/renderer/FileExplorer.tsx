import { path as nodePath, originalFs as fs, clipboard, webUtils } from "../../platforms/platform";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import moment from "moment";


import { Keymap } from "../compat/commands";
import { Menu, Notice } from "../compat/ui";
import { TFile, TFolder, type TAbstractFile } from "../compat/vault";
import type { WorkspaceLeaf } from "../compat/workspace";
import { SearchQuery } from "../controllers/search-query";
import { useT } from "../i18n/react";
import { t } from "../i18n";
import { unsafeNameWarning, validateFileName, type AppActions } from "./actions";
import { BookmarkStore, fileBookmark, folderBookmark, openBookmarkDialog, openBookmarksDialog } from "./bookmarks";
import { useConfig } from "./config";
import { displayTooltip, hideTooltip } from "./tooltip";
import { ClickableIcon, CollapseIcon, SearchInput, cx } from "./ui";

export type SortOrder = "alphabetical" | "alphabeticalReverse" | "byModifiedTime" | "byModifiedTimeReverse" | "byCreatedTime" | "byCreatedTimeReverse";
export const FILE_SORT_GROUPS: SortOrder[][] = [["alphabetical", "alphabeticalReverse"], ["byModifiedTime", "byModifiedTimeReverse"], ["byCreatedTime", "byCreatedTimeReverse"]];
export const FILE_SORT_LABELS: Record<SortOrder, string> = {
  alphabetical: "plugins.file-explorer.label-sort-a-to-z", alphabeticalReverse: "plugins.file-explorer.label-sort-z-to-a",
  byModifiedTime: "plugins.file-explorer.label-sort-new-to-old", byModifiedTimeReverse: "plugins.file-explorer.label-sort-old-to-new",
  byCreatedTime: "plugins.file-explorer.label-sort-created-new-to-old", byCreatedTimeReverse: "plugins.file-explorer.label-sort-created-old-to-new",
};
const collator = new Intl.Collator(undefined, { usage: "sort", sensitivity: "base", numeric: true });
export const FILE_SORTERS: Record<SortOrder, (a: TFile, b: TFile) => number> = {
  alphabetical: (a, b) => collator.compare(a.basename, b.basename), alphabeticalReverse: (a, b) => -collator.compare(a.basename, b.basename),
  byModifiedTime: (a, b) => b.stat.mtime - a.stat.mtime, byModifiedTimeReverse: (a, b) => a.stat.mtime - b.stat.mtime,
  byCreatedTime: (a, b) => b.stat.ctime - a.stat.ctime, byCreatedTimeReverse: (a, b) => a.stat.ctime - b.stat.ctime,
};
export const isSortOrder = (value: unknown): value is SortOrder => typeof value === "string" && Object.hasOwn(FILE_SORTERS, value);
/** Drag payload shared by the sidebar views: a JSON array of vault paths. */
export const VAULT_DRAG_TYPE = "application/x-vault-path";
const FILES_CLIPBOARD = "obsidian/files";
const FOLDS_KEY = "file-explorer-unfold";
const ROW_PITCH = 27, WINDOW_THRESHOLD = 400, OVERSCAN = 30;

const isRoot = (file: TAbstractFile) => file instanceof TFolder && file.isRoot();
const prefixOf = (folder: TFolder) => folder.isRoot() ? "" : `${folder.path}/`;
/** Whether `file` may be moved into `folder`. */
const canMoveInto = (file: TAbstractFile, folder: TFolder) => !isRoot(file) && file !== folder && !(file instanceof TFolder && folder.path.startsWith(`${file.path}/`));
/** Drops items that are inside another selected folder. */
function topLevel(files: TAbstractFile[]): TAbstractFile[] { return files.filter(file => !files.some(other => other !== file && other instanceof TFolder && file.path.startsWith(`${other.path}/`))); }
function availablePath(actions: AppActions, folder: TFolder, file: TAbstractFile): string {
  const target = prefixOf(folder) + file.name;
  return file instanceof TFile ? actions.vault.getAvailablePath(file.extension ? target.slice(0, -file.extension.length - 1) : target, file.extension) : actions.vault.getAvailablePath(target);
}
async function moveInto(actions: AppActions, files: TAbstractFile[], folder: TFolder): Promise<void> {
  for (const file of topLevel(files)) if (file.parent !== folder && canMoveInto(file, folder)) await actions.app.fileManager.renameFile(file, availablePath(actions, folder, file));
}
export function readDraggedPaths(event: { dataTransfer: DataTransfer }): string[] {
  try { const parsed = JSON.parse(event.dataTransfer.getData(VAULT_DRAG_TYPE)) as unknown; return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; } catch { return []; }
}

/** Shows the file explorer with `file` expanded into view and focused. */
export async function revealInExplorer(actions: AppActions, file: TAbstractFile): Promise<void> {
  await actions.revealLeafOfType("file-explorer", "left");
  actions.workspace.trigger("file-explorer:reveal", file.path);
}
/** Starts the explorer's inline rename for `file`. */
export async function renameInExplorer(actions: AppActions, file: TAbstractFile): Promise<void> {
  await actions.revealLeafOfType("file-explorer", "left");
  actions.workspace.trigger("file-explorer:rename", file.path);
}
function bookmarkPath(actions: AppActions, file: TAbstractFile): void {
  const store = BookmarkStore.current;
  if (!store) return;
  const location = store.findPath(file.path);
  openBookmarkDialog(actions.app, store, location ? store.itemAt(location)! : file instanceof TFolder ? folderBookmark(file.path) : fileBookmark(file.path), { location });
}
const copied = () => { new Notice(t("interface.copied_generic")); };
const populatedFileMenus = new WeakSet<Menu>();
export const hasFileMenuItems = (menu: Menu): boolean => populatedFileMenus.has(menu);

/**
 * The items every file or folder menu carries besides those of the view that opened it: open in a
 * new window, move, search in folder, bookmark, copy path, default app and system explorer.
 * `source` is the reference menu source id; `makeCopy` slots the caller's "Make a copy" before "Move".
 */
export function addFileMenuItems(menu: Menu, actions: AppActions, file: TAbstractFile, source: string, leaf: WorkspaceLeaf | null = null, makeCopy?: (event: globalThis.MouseEvent | globalThis.KeyboardEvent) => void, notifyPlugins = true): void {
  if (populatedFileMenus.has(menu)) return;
  populatedFileMenus.add(menu);
  const { corePlugins, workspace } = actions, root = isRoot(file), explorer = source === "file-explorer-context-menu";
  if (file instanceof TFile) menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-window")).setIcon("lucide-picture-in-picture-2").onClick(() => actions.run(() => actions.openFile(file, "window"))));
  if (file instanceof TFolder && explorer) {
    if (corePlugins.isEnabled("canvas")) menu.addItem(item => item.setSection("action-primary").setTitle(t("plugins.canvas.action-new-canvas")).setIcon("lucide-layout-dashboard").onClick(event => actions.run(() => actions.newCanvas(file, Keymap.isModEvent(event as globalThis.MouseEvent)))));
    if (corePlugins.isEnabled("bases")) menu.addItem(item => item.setSection("action-primary").setTitle(t("plugins.bases.action-new-base")).setIcon("lucide-layout-list").onClick(event => actions.run(() => actions.newBase(file, Keymap.isModEvent(event as globalThis.MouseEvent)))));
  }
  if (makeCopy) menu.addItem(item => item.setSection("action").setTitle(t("plugins.file-explorer.menu-opt-make-copy")).setIcon("lucide-files").onClick(makeCopy));
  if (!root) menu.addItem(item => item.setSection("action").setTitle(t(file instanceof TFile ? "plugins.file-explorer.action-move-file" : "plugins.file-explorer.action-move-folder")).setIcon("lucide-folder-tree").onClick(() => actions.run(() => actions.moveTo(file))));
  if (file instanceof TFolder && explorer && !root && corePlugins.isEnabled("global-search")) menu.addItem(item => item.setSection("action").setTitle(t("plugins.search.menu-opt-search-in-folder")).setIcon("lucide-folder-search").onClick(() => actions.run(() => actions.openSearch(`path:"${file.path}/" `))));
  if (!root && corePlugins.isEnabled("bookmarks") && BookmarkStore.current) menu.addItem(item => item.setSection("action").setTitle(t(BookmarkStore.current!.findPath(file.path) ? "plugins.bookmarks.action-edit-bookmark" : "plugins.bookmarks.action-bookmark")).setIcon("lucide-bookmark").onClick(() => bookmarkPath(actions, file)));
  if (!root) {
    menu.setSectionSubmenu("info.copy", { title: t("interface.menu.copy-path"), icon: "lucide-clipboard" });
    if (file instanceof TFile) menu.addItem(sub => sub.setSection("info.copy").setTitle(t("interface.menu.copy-obsidian-url")).setIcon("lucide-link").onClick(() => actions.copyUrl(file)));
    menu.addItem(sub => sub.setSection("info.copy").setTitle(t("interface.menu.copy-vault-path")).setIcon("vault").onClick(() => { clipboard.writeText(file instanceof TFile ? file.path.replace(/\.md$/i, "") : file.path); copied(); }));
    menu.addItem(sub => sub.setSection("info.copy").setTitle(t("interface.menu.copy-full-path")).setIcon("lucide-hard-drive").onClick(() => { actions.copyFullPath(file); copied(); }));
  }
  if (file instanceof TFile) menu.addItem(item => item.setSection("system").setTitle(t("plugins.open-with-default-app.action-open-file")).setIcon("lucide-arrow-up-right").onClick(() => actions.openWithDefaultApp(file)));
  if (!root) menu.addItem(item => item.setSection("system").setTitle(t("plugins.open-with-default-app.action-show-in-folder")).setIcon("lucide-arrow-up-right").onClick(() => actions.showInFolder(file)));
  if (file instanceof TFile && !explorer && corePlugins.isEnabled("file-explorer")) menu.addItem(item => item.setSection("system").setTitle(t("plugins.file-explorer.action-reveal-file")).setIcon("lucide-folder-open").onClick(() => actions.run(() => revealInExplorer(actions, file))));
  if (notifyPlugins) workspace.trigger("file-menu", menu, file, source, leaf);
}

interface ExplorerState { sortOrder: SortOrder; autoReveal: boolean; showSearch: boolean; searchQuery: string }
interface Drop { path: string; timer: number }

/** Vault tree with the reference's row structure, sorting, selection, inline rename, drag and drop and menus. */
export function FileExplorer({ leaf, actions }: { leaf: WorkspaceLeaf; actions: AppActions }) {
  const t = useT();
  const { vault, workspace } = actions;
  const [revision, setRevision] = useState(0);
  const [state, setStateRaw] = useState<ExplorerState>(() => { const saved = leaf.view.getState() as Partial<ExplorerState>; return { sortOrder: isSortOrder(saved.sortOrder) ? saved.sortOrder : "alphabetical", autoReveal: saved.autoReveal === true, showSearch: saved.showSearch === true, searchQuery: typeof saved.searchQuery === "string" ? saved.searchQuery : "" }; });
  const stateRef = useRef(state); stateRef.current = state;
  const setState = (patch: Partial<ExplorerState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next; setStateRaw(next);
    void leaf.view.setState({ ...leaf.view.getState(), ...next }, { history: false }); workspace.requestSaveLayout();
  };
  const [expanded, setExpandedRaw] = useState<Set<string>>(() => { const saved = actions.app.loadLocalStorage(FOLDS_KEY); return new Set(Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === "string") : []); });
  const setExpanded = (update: (current: Set<string>) => Set<string>) => setExpandedRaw(current => {
    const next = update(current);
    if (next !== current) actions.app.saveLocalStorage(FOLDS_KEY, [...next]);
    return next;
  });
  const [focused, setFocused] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [cut, setCut] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<Set<string>>(() => new Set());
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [pitch, setPitch] = useState(ROW_PITCH);
  /** The row the last plain click landed on: where keyboard navigation and range selection start. */
  const anchor = useRef<string | null>(null);
  const drop = useRef<Drop | null>(null);
  const pendingScroll = useRef<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const showUnsupported = useConfig(actions.config, "showUnsupportedFiles");
  const showHidden = useConfig(actions.config, "showHiddenFiles");
  const spellcheck = useConfig(actions.config, "spellcheck");
  const activePath = workspace.getActiveFile()?.path ?? null;

  useEffect(() => {
    let frame = 0;
    const bump = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setRevision(value => value + 1); }); };
    const rekey = (set: Set<string>, oldPath: string, newPath: string) => {
      let next: Set<string> | null = null;
      for (const entry of set) if (entry === oldPath || entry.startsWith(`${oldPath}/`)) { next ??= new Set(set); next.delete(entry); next.add(newPath + entry.slice(oldPath.length)); }
      return next ?? set;
    };
    const refs = [vault.on("create", bump), vault.on("delete", (file: TAbstractFile) => {
      setSelected(current => { if (!current.has(file.path)) return current; const next = new Set(current); next.delete(file.path); return next; });
      setFocused(current => current === file.path ? null : current);
      if (anchor.current === file.path) anchor.current = null;
      bump();
    }), vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      setExpanded(current => rekey(current, oldPath, file.path));
      setSelected(current => rekey(current, oldPath, file.path));
      setFocused(current => current === oldPath ? file.path : current);
      if (anchor.current === oldPath) anchor.current = file.path;
      bump();
    }), vault.on("modify", () => { if (stateRef.current.sortOrder === "byModifiedTime" || stateRef.current.sortOrder === "byModifiedTimeReverse") bump(); })];
    const workspaceRefs = [
      workspace.on("active-leaf-change", bump), workspace.on("file-open", bump), workspace.on("layout-change", bump),
      workspace.on("file-explorer:rename", (target: unknown) => startRename(String(target))),
      workspace.on("file-explorer:reveal", (target: unknown) => { reveal(String(target)); setFocused(String(target)); pendingScroll.current = String(target); container.current?.focus(); }),
    ];
    return () => { cancelAnimationFrame(frame); refs.forEach(ref => vault.offref(ref)); workspaceRefs.forEach(ref => workspace.offref(ref)); };
  }, [vault, workspace]);
  // Options changed from elsewhere (a restored layout) reach the mounted view through its state.
  useEffect(() => {
    const ref = workspace.on("core-view-state-change", (changed: unknown) => {
      if (changed !== leaf) return;
      const saved = leaf.view.getState() as Partial<ExplorerState>, current = stateRef.current;
      const next = { sortOrder: isSortOrder(saved.sortOrder) ? saved.sortOrder : current.sortOrder, autoReveal: typeof saved.autoReveal === "boolean" ? saved.autoReveal : current.autoReveal, showSearch: typeof saved.showSearch === "boolean" ? saved.showSearch : current.showSearch, searchQuery: typeof saved.searchQuery === "string" ? saved.searchQuery : current.searchQuery };
      if (JSON.stringify(next) !== JSON.stringify(current)) { stateRef.current = next; setStateRaw(next); }
    });
    return () => workspace.offref(ref);
  }, [leaf, workspace]);

  function reveal(target: string) {
    setExpanded(current => {
      let next = current;
      const parts = target.split("/");
      for (let index = 1; index < parts.length; index++) { const folder = parts.slice(0, index).join("/"); if (!next.has(folder)) { if (next === current) next = new Set(current); next.add(folder); } }
      return next;
    });
  }
  function startRename(target: string) { reveal(target); setFocused(target); setRenaming(target); pendingScroll.current = target; }
  useEffect(() => { if (state.autoReveal && activePath && !renaming) { reveal(activePath); pendingScroll.current = activePath; setRevision(value => value + 1); } }, [state.autoReveal, activePath]);

  const filter = useMemo(() => {
    if (!state.showSearch || !state.searchQuery) return null;
    try { const query = new SearchQuery(state.searchQuery, false); return query.matcher ? query : null; } catch { return null; }
  }, [state.showSearch, state.searchQuery]);
  const isSupported = (file: TFile) => !!workspace.getViewTypeByExtension(file.extension, file.path);
  // Per-render caches: sorted children, filter verdicts and row counts of the folders that are looked at.
  const caches = useMemo(() => ({ children: new Map<string, TAbstractFile[]>(), passes: new Map<string, boolean>(), rows: new Map<string, number>() }), [revision, state.sortOrder, filter, showUnsupported, showHidden, expanded]);
  const passes = (file: TAbstractFile): boolean => {
    const hiddenPath = file.path.split("/").some(part => part.startsWith("."));
    if (hiddenPath && !showHidden) return false;
    if (file instanceof TFile) return (showUnsupported || isSupported(file) || (showHidden && hiddenPath)) && (!filter || !!filter.matchFilepath(file.path));
    if (!filter) return true;
    let verdict = caches.passes.get(file.path);
    if (verdict === undefined) { verdict = !!filter.matchFilepath(file.path) || (file as TFolder).children.some(passes); caches.passes.set(file.path, verdict); }
    return verdict;
  };
  const childrenOf = (folder: TFolder): TAbstractFile[] => {
    let list = caches.children.get(folder.path);
    if (!list) {
      const sorter = FILE_SORTERS[state.sortOrder];
      list = folder.children.filter(file => passes(file) || (file instanceof TFile && !file.name.startsWith(".") && !isSupported(file) && (!filter || !!filter.matchFilepath(file.path)))).sort((a, b) => {
        const first = a instanceof TFolder, second = b instanceof TFolder;
        return first || second ? (first && !second ? -1 : second && !first ? 1 : collator.compare(a.name, b.name)) : sorter(a as TFile, b as TFile);
      });
      caches.children.set(folder.path, list);
    }
    return list;
  };
  const isCollapsed = (folder: TFolder) => !expanded.has(folder.path);
  /** Rows a file takes including its expanded descendants. */
  const rowsOf = (file: TAbstractFile): number => {
    if (file instanceof TFile && !showUnsupported && !isSupported(file) && !(showHidden && file.path.split("/").some(part => part.startsWith(".")))) return 0;
    if (!(file instanceof TFolder) || isCollapsed(file)) return 1;
    let count = caches.rows.get(file.path);
    if (count === undefined) { count = 1; for (const child of childrenOf(file)) count += rowsOf(child); caches.rows.set(file.path, count); }
    return count;
  };
  const root = vault.getRoot();
  const flatRows = (): TAbstractFile[] => {
    const rows: TAbstractFile[] = [];
    (function walk(folder: TFolder) { for (const child of childrenOf(folder)) { if (!rowsOf(child)) continue; rows.push(child); if (child instanceof TFolder && !isCollapsed(child)) walk(child); } })(root);
    return rows;
  };
  const totalRows = childrenOf(root).reduce((sum, child) => sum + rowsOf(child), 0);
  const windowed = totalRows > WINDOW_THRESHOLD && viewport.height > 0;
  const firstRow = windowed ? Math.floor(viewport.top / pitch) - OVERSCAN : 0, lastRow = windowed ? Math.ceil((viewport.top + viewport.height) / pitch) + OVERSCAN : Infinity;

  const scrollTo = (target: string) => {
    const el = container.current;
    if (!el) return;
    const row = el.querySelector<HTMLElement>(`.tree-item-self[data-path="${CSS.escape(target)}"]`);
    if (row) { row.scrollIntoView({ block: "nearest" }); return; }
    const index = flatRows().findIndex(file => file.path === target);
    if (index >= 0) el.scrollTop = Math.max(0, index * pitch - el.clientHeight / 2);
  };
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    if (el.clientHeight !== viewport.height) setViewport({ top: el.scrollTop, height: el.clientHeight });
    const rows = el.querySelectorAll<HTMLElement>(".tree-item");
    if (rows.length > 1 && !windowed) {
      const first = rows[0], second = rows[1];
      const measured = first.contains(second) ? 0 : second.getBoundingClientRect().top - first.getBoundingClientRect().top;
      if (measured > 8 && Math.abs(measured - pitch) > 0.5) setPitch(measured);
    }
    if (pendingScroll.current) { const target = pendingScroll.current; pendingScroll.current = null; scrollTo(target); }
  });
  useEffect(() => {
    const el = container.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewport(current => current.height === el.clientHeight ? current : { top: el.scrollTop, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const allFolders = () => vault.getAllFolders(false).map(folder => folder.path);
  const allCollapsed = expanded.size === 0;
  const fileOf = (target: string | null) => target ? vault.getAbstractFileByPath(target) : null;
  const selectedFiles = (): TAbstractFile[] => {
    const paths = selected.size ? [...selected] : focused ? [focused] : [];
    return paths.map(fileOf).filter((file): file is TAbstractFile => !!file && !isRoot(file));
  };
  const toggleFolder = (folder: TFolder) => setExpanded(current => { const next = new Set(current); if (!next.delete(folder.path)) next.add(folder.path); return next; });
  const setFolderCollapsed = (folder: TFolder, collapsed: boolean) => setExpanded(current => { if (current.has(folder.path) !== collapsed) return current; const next = new Set(current); if (collapsed) next.delete(folder.path); else next.add(folder.path); return next; });
  const focusPane = () => { workspace.setActiveLeaf(leaf); container.current?.focus(); };

  /** Alt-click toggles, Shift-click extends from the anchor row; returns true when the click was consumed. */
  function handleSelection(event: MouseEvent | KeyboardEvent, file: TAbstractFile): boolean {
    const native = event.nativeEvent, mouse = "button" in native;
    if (!Keymap.isModEvent(native)) {
      if (event.altKey && !event.shiftKey) {
        focusPane();
        setSelected(current => { const next = new Set(current); if (!next.delete(file.path)) { next.add(file.path); setFocused(file.path); anchor.current = file.path; } return next; });
        return true;
      }
      if (event.shiftKey) {
        focusPane();
        const rows = flatRows().map(row => row.path), from = anchor.current ? rows.indexOf(anchor.current) : -1, to = rows.indexOf(file.path);
        const range = from < 0 ? [file.path] : rows.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected(current => new Set([...current, ...range]));
        return true;
      }
      if (renaming === file.path) return true;
      if (file.path === activePath && mouse) { focusPane(); setFocused(file.path); return true; }
    }
    if (mouse) { setSelected(current => current.size ? new Set() : current); setFocused(null); }
    anchor.current = file.path;
    return false;
  }
  function activate(file: TAbstractFile, event: MouseEvent | KeyboardEvent) {
    if (renaming === file.path) return;
    if (file instanceof TFolder) { if (!handleSelection(event, file)) toggleFolder(file); return; }
    if (handleSelection(event, file) || !(file instanceof TFile)) return;
    actions.run(() => actions.openFile(file, Keymap.isModEvent(event.nativeEvent)));
  }

  async function afterCreate(file: TAbstractFile | null, target: ReturnType<typeof Keymap.isModEvent>) {
    if (!file) return;
    if (file instanceof TFile) await actions.openFile(file, target, { mode: "source" });
    else requestAnimationFrame(() => startRename(file.path));
  }
  const makeCopy = (file: TAbstractFile) => (event: globalThis.MouseEvent | globalThis.KeyboardEvent) => actions.run(async () => {
    const target = file instanceof TFile ? vault.getAvailablePath(file.extension ? file.path.slice(0, -file.extension.length - 1) : file.path, file.extension) : vault.getAvailablePath(file.path);
    await afterCreate(await vault.copy(file, target), Keymap.isModifier(event, "Mod") ? "tab" : false);
  });
  const deleteFiles = (files: TAbstractFile[]) => actions.run(async () => {
    const rows = flatRows().map(row => row.path), doomed = new Set(files.map(file => file.path));
    const start = focused ? rows.indexOf(focused) : -1;
    const next = rows.slice(Math.max(0, start)).find(path => !doomed.has(path) && ![...doomed].some(parent => path.startsWith(`${parent}/`))) ?? rows.slice(0, Math.max(0, start)).reverse().find(path => !doomed.has(path)) ?? null;
    let removed = false;
    for (const file of files) if (vault.getAbstractFileByPath(file.path) === file && await actions.delete(file)) removed = true;
    if (removed) { setSelected(new Set()); setFocused(next); container.current?.focus(); }
  });

  function fileMenu(file: TAbstractFile, event: MouseEvent) {
    if (renaming === file.path) return;
    event.preventDefault(); event.stopPropagation();
    const menu = new Menu().addSections(["title", "open", "action-primary", "action", "info", "info.copy", "view", "system", "", "danger"]), source = "file-explorer-context-menu";
    if (selected.size > 1 && selected.has(file.path)) {
      const files = [...selected].map(fileOf).filter((entry): entry is TAbstractFile => !!entry), top = topLevel(files);
      menu.addItem(item => item.setSection("action-primary").setTitle(t("plugins.file-explorer.action-new-folder-with-count", { count: top.length })).setIcon("lucide-folder-plus").onClick(() => actions.run(async () => {
        const parent = file instanceof TFolder ? file : file.parent ?? root;
        const created = await vault.createFolder(vault.getAvailablePath(prefixOf(parent) + t("plugins.file-explorer.label-untitled-folder")));
        await moveInto(actions, top, created);
        setSelected(new Set()); requestAnimationFrame(() => startRename(created.path));
      })));
      menu.addItem(item => item.setSection("action").setTitle(t("plugins.file-explorer.action-move-items", { count: files.length })).setIcon("lucide-folder-tree").onClick(() => actions.run(async () => {
        // The folder picker takes one item; the rest follow it.
        const before = top[0].parent;
        await actions.moveTo(top[0]);
        if (top[0].parent && top[0].parent !== before) await moveInto(actions, top.slice(1), top[0].parent);
      })));
      if (actions.corePlugins.isEnabled("bookmarks") && BookmarkStore.current) menu.addItem(item => item.setSection("action").setTitle(t("plugins.bookmarks.action-bookmark")).setIcon("lucide-bookmark").onClick(() => openBookmarksDialog(actions.app, BookmarkStore.current!, top.map(entry => entry instanceof TFolder ? folderBookmark(entry.path) : fileBookmark(entry.path)))));
      menu.addItem(item => item.setSection("danger").setTitle(t("plugins.file-explorer.menu-opt-delete")).setIcon("lucide-trash-2").setWarning(true).onClick(() => deleteFiles(files)));
      workspace.trigger("files-menu", menu, files, source, null);
    } else {
      const fileIsRoot = isRoot(file);
      if (file instanceof TFolder) {
        menu.addItem(item => item.setSection("action-primary").setTitle(t("plugins.file-explorer.menu-opt-new-note")).setIcon("lucide-edit").onClick(clicked => { setFolderCollapsed(file, false); actions.run(() => actions.newNote(file, Keymap.isModifier(clicked, "Mod") ? "tab" : false)); }));
        menu.addItem(item => item.setSection("action-primary").setTitle(t("plugins.file-explorer.menu-opt-new-folder")).setIcon("lucide-folder-open").onClick(() => { setFolderCollapsed(file, false); actions.run(() => actions.newFolder(file)); }));
      } else if (file instanceof TFile) {
        menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(() => actions.run(() => actions.openFile(file, "tab"))));
        menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-to-the-right")).setIcon("lucide-separator-vertical").onClick(() => actions.run(() => actions.openFile(file, "split"))));
      }
      addFileMenuItems(menu, actions, file, source, null, fileIsRoot ? undefined : makeCopy(file));
      if (!fileIsRoot) {
        menu.addItem(item => item.setSection("danger").setTitle(t("plugins.file-explorer.menu-opt-rename")).setIcon("lucide-edit-3").onClick(() => startRename(file.path)));
        menu.addItem(item => item.setSection("danger").setTitle(t("plugins.file-explorer.menu-opt-delete")).setIcon("lucide-trash-2").setWarning(true).onClick(() => actions.run(() => actions.delete(file))));
      }
    }
    menu.addItem(item => item.setSection("view").setTitle(t(showHidden ? "plugins.file-explorer.menu-hide-hidden-files" : "plugins.file-explorer.menu-show-hidden-files")).setIcon(showHidden ? "lucide-eye-off" : "lucide-eye").setChecked(showHidden).onClick(() => {
      actions.config.set("showHiddenFiles", !showHidden);
      void actions.config.flush().catch(error => console.error("Failed to save hidden files preference", error));
    }));
    if (!isRoot(file)) setFocused(file.path);
    menu.showAtMouseEvent(event.nativeEvent);
  }
  function rootMenu(event: MouseEvent) {
    event.preventDefault();
    if (event.target !== container.current && event.target !== container.current?.firstElementChild) return;
    setSelected(new Set()); setFocused(null);
    fileMenu(root, event);
  }
  function sortMenu(event: MouseEvent) {
    event.preventDefault();
    const menu = new Menu().setNoIcon();
    for (const group of FILE_SORT_GROUPS) {
      for (const order of group) menu.addItem(item => item.setTitle(t(FILE_SORT_LABELS[order])).setChecked(state.sortOrder === order ? true : null).onClick(() => setState({ sortOrder: order })));
      menu.addSeparator();
    }
    menu.showAtMouseEvent(event.nativeEvent);
  }

  // ---- drag and drop
  const clearDrop = () => { if (drop.current) window.clearTimeout(drop.current.timer); drop.current = null; setDropPath(null); };
  const hoverDrop = (folder: TFolder) => {
    if (drop.current?.path === folder.path) return;
    if (drop.current) window.clearTimeout(drop.current.timer);
    // Hovering a collapsed folder opens it.
    drop.current = { path: folder.path, timer: window.setTimeout(() => { if (drop.current?.path === folder.path && !folder.isRoot()) setFolderCollapsed(folder, false); }, 750) };
    setDropPath(folder.path);
  };
  async function importExternal(items: File[], folder: TFolder) {
    const copyInto = async (source: string, parent: string): Promise<void> => {
      const stat = await fs.promises.stat(source), name = nodePath.basename(source);
      if (stat.isDirectory()) {
        const target = vault.getAvailablePath((parent ? `${parent}/` : "") + name);
        await vault.createFolder(target);
        for (const entry of await fs.promises.readdir(source)) await copyInto(nodePath.join(source, entry), target);
      } else {
        const extension = nodePath.extname(name).slice(1), base = extension ? name.slice(0, -extension.length - 1) : name;
        const data = await fs.promises.readFile(source);
        await vault.createBinary(vault.getAvailablePath((parent ? `${parent}/` : "") + base, extension), data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      }
    };
    for (const item of items) {
      const source = webUtils?.getPathForFile ? webUtils.getPathForFile(item) : "";
      if (source) await copyInto(source, folder.isRoot() ? "" : folder.path);
      else { const dot = item.name.lastIndexOf("."); await vault.createBinary(vault.getAvailablePath(prefixOf(folder) + (dot > 0 ? item.name.slice(0, dot) : item.name), dot > 0 ? item.name.slice(dot + 1) : ""), await item.arrayBuffer()); }
    }
  }
  const dropProps = (folder: TFolder) => ({
    onDragOver: (event: DragEvent) => {
      const types = event.dataTransfer.types, internal = types.includes(VAULT_DRAG_TYPE);
      if (!internal && !types.includes("Files")) return;
      event.preventDefault(); event.stopPropagation();
      if (internal && dragging.size && ![...dragging].some(path => { const file = fileOf(path); return file && canMoveInto(file, folder); })) { event.dataTransfer.dropEffect = "none"; clearDrop(); return; }
      event.dataTransfer.dropEffect = internal ? "move" : "copy";
      hoverDrop(folder);
    },
    onDragLeave: (event: DragEvent) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null) && drop.current?.path === folder.path) clearDrop(); },
    onDrop: (event: DragEvent) => {
      const paths = readDraggedPaths(event), external = [...event.dataTransfer.files];
      if (!paths.length && !external.length) return;
      event.preventDefault(); event.stopPropagation();
      clearDrop(); setDragging(new Set());
      if (paths.length) {
        const files = paths.map(fileOf).filter((file): file is TAbstractFile => !!file);
        if (files.some(file => !canMoveInto(file, folder))) return;
        actions.run(async () => { await moveInto(actions, files, folder); if (isCollapsed(folder)) setSelected(new Set()); });
      } else actions.run(() => importExternal(external, folder));
    },
  });
  const dragProps = (file: TAbstractFile) => ({
    draggable: renaming === null,
    onDragStart: (event: DragEvent) => {
      event.stopPropagation();
      const paths = selected.size > 1 && selected.has(file.path) ? topLevel([...selected].map(fileOf).filter((entry): entry is TAbstractFile => !!entry)).map(entry => entry.path) : [file.path];
      event.dataTransfer.setData(VAULT_DRAG_TYPE, JSON.stringify(paths));
      event.dataTransfer.setData("text/plain", paths.map(path => { const entry = fileOf(path); return entry instanceof TFile ? `[[${entry.extension === "md" ? entry.basename : entry.name}]]` : path; }).join("\n"));
      event.dataTransfer.effectAllowed = "copyMove";
      setDragging(new Set(paths));
    },
    onDragEnd: () => { setDragging(new Set()); clearDrop(); },
  });

  // ---- tooltips and page preview
  const counts = (folder: TFolder): [number, number] => { let files = 0, folders = 0; for (const child of folder.children) { if (child instanceof TFolder) { const [inner, nested] = counts(child); files += inner; folders += 1 + nested; } else files++; } return [files, folders]; };
  const onRowEnter = (file: TAbstractFile) => (event: React.PointerEvent<HTMLElement>) => {
    const el = event.currentTarget;
    if (event.pointerType === "touch" || el.contains(event.relatedTarget as Node | null) || renaming === file.path) return;
    const inner = el.querySelector<HTMLElement>(".tree-item-inner");
    let text = inner && inner.scrollWidth > inner.clientWidth ? (file instanceof TFile ? file.basename : file.name) : "";
    if (file instanceof TFile) text += `${text ? "\n\n" : ""}${t("plugins.file-explorer.tooltip-modified-time", { time: moment(file.stat.mtime).format("YYYY-MM-DD HH:mm") })}\n${t("plugins.file-explorer.tooltip-created-time", { time: moment(file.stat.ctime).format("YYYY-MM-DD HH:mm") })}`;
    else if (file instanceof TFolder) { const [files, folders] = counts(file); text += `${text ? "\n\n" : ""}${t("nouns.file-with-count", { count: files })}, ${t("nouns.folder-with-count", { count: folders })}`; }
    if (text) displayTooltip(el, text, { placement: "right", delay: 1000 });
    if (file instanceof TFile) workspace.trigger("hover-link", { event: event.nativeEvent, source: "file-explorer", hoverParent: { hoverPopover: null }, targetEl: el, linktext: file.path });
  };
  const onRowLeave = (event: React.PointerEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideTooltip(); };

  // Indentation matches the reference: each level shifts the row by 17px with a compensating padding.
  const setIndent = (depth: number) => (el: HTMLElement | null) => {
    if (!el) return;
    el.style.setProperty("margin-inline-start", `${-17 * depth}px`, "important");
    el.style.setProperty("padding-inline-start", `${24 + 17 * depth}px`, "important");
  };
  /** Children of a folder, leaving out the rows scrolled far out of view (their height is kept by the pusher). */
  const renderChildren = (folder: TFolder, depth: number, top: number): { nodes: ReactNode[]; before: number; total: number } => {
    const nodes: ReactNode[] = [];
    let index = top, before = 0;
    for (const child of childrenOf(folder)) {
      const size = rowsOf(child), from = index;
      index += size;
      if (windowed && index <= firstRow) { before += size; continue; }
      if (windowed && from >= lastRow) continue;
      nodes.push(renderItem(child, depth, from));
    }
    return { nodes, before, total: index - top };
  };
  const pusher = (before: number) => <div style={{ width: "100%", height: "0.1px", marginBottom: windowed && before ? `${before * pitch}px` : 0 }} />;
  const rowClasses = (file: TAbstractFile) => cx(focused === file.path && "has-focus", selected.has(file.path) && "is-selected", renaming === file.path && "is-being-renamed", cut.has(file.path) && "is-cut", dragging.has(file.path) && "is-being-dragged");
  const rowEvents = (file: TAbstractFile) => ({
    onClick: (event: MouseEvent) => { if (event.button === 0 && !event.defaultPrevented) activate(file, event); },
    onAuxClick: (event: MouseEvent) => { if (event.button === 1 && file instanceof TFile) { event.preventDefault(); activate(file, event); } },
    onContextMenu: (event: MouseEvent) => fileMenu(file, event), onPointerOver: onRowEnter(file), onPointerOut: onRowLeave,
  });
  const title = (file: TAbstractFile, className: string) => <Title file={file} renaming={renaming === file.path} className={className} spellcheck={spellcheck} validate={name => nameProblem(file, name, false)} onDone={finishRename} />;
  const renderItem = (file: TAbstractFile, depth: number, row: number): ReactNode => {
    if (file instanceof TFolder) {
      const collapsed = isCollapsed(file), children = collapsed ? null : renderChildren(file, depth + 1, row + 1);
      return <div key={file.path} className={cx("tree-item nav-folder", collapsed && "is-collapsed", dropPath === file.path && "is-being-dragged-over")} {...dropProps(file)}>
        <div className={cx("tree-item-self nav-folder-title is-clickable mod-collapsible", rowClasses(file))} data-path={file.path} ref={setIndent(depth)} {...dragProps(file)} {...rowEvents(file)}>
          <CollapseIcon collapsed={collapsed} />
          {title(file, "nav-folder-title-content")}
        </div>
        {children && <div className="tree-item-children nav-folder-children" style={windowed ? { minHeight: `${children.total * pitch}px` } : undefined}>
          {pusher(children.before)}
          {children.nodes}
        </div>}
      </div>;
    }
    const item = file as TFile, supported = isSupported(item) || (showHidden && item.path.split("/").some(part => part.startsWith(".")));
    return <div key={file.path} className="tree-item nav-file">
      <div className={cx("tree-item-self nav-file-title tappable is-clickable", activePath === file.path && "is-active", !supported && "is-unsupported", rowClasses(file))} data-path={file.path} ref={setIndent(depth)} {...dragProps(file)} {...rowEvents(file)}>
        {title(file, "nav-file-title-content")}
        {item.extension !== "md" && <div className="nav-file-tag">{item.extension}</div>}
      </div>
    </div>;
  };

  // ---- rename
  function nameProblem(file: TAbstractFile, name: string, final: boolean): string {
    const extension = file instanceof TFile && file.extension ? `.${file.extension}` : "";
    const sibling = name ? vault.getAbstractFileByPath(prefixOf(file.parent ?? root) + name + extension) : null;
    if (!name) return final ? t("plugins.file-explorer.msg-empty-file-name") : "";
    return validateFileName(name) ?? (sibling && sibling !== file && sibling.path.toLowerCase() !== file.path.toLowerCase() ? t("plugins.file-explorer.msg-file-already-exists") : final ? "" : unsafeNameWarning(name) ?? "");
  }
  /** Returns a problem to show while staying in rename mode, or null when the rename is over. */
  async function finishRename(file: TAbstractFile, name: string | null, el: HTMLElement | null): Promise<string | null> {
    const end = () => { setRenaming(null); hideTooltip(); if (container.current?.contains(document.activeElement) || document.activeElement === document.body) container.current?.focus(); pendingScroll.current = file.path; return null; };
    if (name === null) return end();
    const clean = name.trim(), current = file instanceof TFile ? file.basename : file.name;
    if (clean === current) return end();
    const problem = nameProblem(file, clean, true);
    if (problem) { const row = el?.closest<HTMLElement>(".tree-item-self"); if (row) { displayTooltip(row, problem, { placement: "bottom", classes: ["mod-error"] }); window.setTimeout(hideTooltip, 2000); } return problem; }
    try { await actions.app.fileManager.renameFile(file, prefixOf(file.parent ?? root) + clean + (file instanceof TFile && file.extension ? `.${file.extension}` : "")); }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    return end();
  }

  // ---- keyboard and clipboard
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (renaming || (event.target as HTMLElement).isContentEditable) return;
    const rows = flatRows(), mod = Keymap.isModifier(event.nativeEvent, "Mod");
    const start = focused && rows.some(row => row.path === focused) ? focused : anchor.current && rows.some(row => row.path === anchor.current) ? anchor.current : selected.size ? [...selected].at(-1)! : null;
    const index = rows.findIndex(row => row.path === start), current = index >= 0 ? rows[index] : null;
    const focus = (file: TAbstractFile | undefined) => { if (file) { setFocused(file.path); pendingScroll.current = file.path; } return file; };
    const step = (direction: 1 | -1) => {
      const next = focus(index < 0 ? (direction === 1 ? rows[0] : rows[rows.length - 1]) : rows[index + direction]);
      if (!next) return;
      if (mod && next instanceof TFile) actions.run(async () => { await actions.openFile(next); focusPane(); });
      if (event.shiftKey) setSelected(previous => new Set([...previous, ...(current ? [current.path] : []), next.path]));
    };
    if (event.key === "ArrowDown") step(1);
    else if (event.key === "ArrowUp") step(-1);
    else if (event.key === "ArrowLeft") {
      if (!current) setExpanded(previous => previous.size ? new Set() : previous);
      else if (current instanceof TFolder && !isCollapsed(current)) setFolderCollapsed(current, true);
      else if (!current.parent || current.parent.isRoot()) { if (!(current instanceof TFolder)) setExpanded(previous => previous.size ? new Set() : previous); }
      else { if (!(current instanceof TFolder)) setFolderCollapsed(current.parent, true); focus(current.parent); }
    } else if (event.key === "ArrowRight") {
      if (current instanceof TFile) activate(current, event);
      else if (current instanceof TFolder) { if (isCollapsed(current)) setFolderCollapsed(current, false); else if (childrenOf(current).length) focus(rows[index + 1]); }
    } else if ((event.key === "Enter" || event.key === " ") && !event.shiftKey && !event.altKey) { if (current && focused) activate(current, event); else return; }
    else if (event.key === "F2" && focused) { const file = fileOf(focused); if (file) startRename(file.path); }
    else if (event.key === "Delete" && !mod) { const files = selectedFiles(); if (files.length) deleteFiles(files); else return; }
    else if (event.key === "Escape") { if (selected.size) setSelected(new Set()); else return; }
    else return;
    event.preventDefault();
  }
  const clipboardPaths = () => topLevel(selectedFiles()).map(file => file.path);
  function onCopy(event: ClipboardEvent) {
    if (renaming) return;
    const paths = clipboardPaths();
    if (!paths.length) return;
    event.preventDefault(); event.clipboardData.setData(FILES_CLIPBOARD, JSON.stringify({ operation: "copy", paths }));
  }
  function onCut(event: ClipboardEvent) {
    if (renaming) return;
    const paths = clipboardPaths();
    if (!paths.length) return;
    setCut(new Set(selectedFiles().map(file => file.path)));
    event.preventDefault(); event.clipboardData.setData(FILES_CLIPBOARD, JSON.stringify({ operation: "cut", paths }));
  }
  function onPaste(event: ClipboardEvent) {
    const raw = event.clipboardData.getData(FILES_CLIPBOARD);
    if (!raw || renaming) return;
    let data: { operation?: string; paths?: unknown } = {};
    try { data = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(data.paths)) return;
    event.preventDefault();
    const focusedFile = fileOf(focused), target = focusedFile instanceof TFolder ? focusedFile : focusedFile?.parent ?? root;
    const files = topLevel(data.paths.filter((entry): entry is string => typeof entry === "string").sort(collator.compare).map(fileOf).filter((file): file is TAbstractFile => !!file));
    if (!files.length) return;
    actions.run(async () => {
      const created: string[] = [];
      if (data.operation === "cut") { const movable = files.filter(file => canMoveInto(file, target)); await moveInto(actions, movable, target); created.push(...movable.map(file => file.path)); }
      else for (const file of files) {
        if (isRoot(file) || (file instanceof TFolder && target.path.startsWith(`${file.path}/`))) continue;
        const destination = availablePath(actions, file === target ? target.parent ?? root : target, file);
        await vault.copy(file, destination); created.push(destination);
      }
      setCut(new Set()); setSelected(new Set(created));
      if (created[0]) { reveal(created[0]); setFocused(created[0]); pendingScroll.current = created[0]; }
    });
  }

  const rootChildren = renderChildren(root, 0, 0);
  return <>
    <div className="nav-header">
      <div className="nav-buttons-container">
        <ClickableIcon icon="lucide-edit" className="nav-action-button" label={t("plugins.file-explorer.action-new-note")} onClick={event => { event.preventDefault(); const target = Keymap.isModEvent(event.nativeEvent); actions.run(() => target ? actions.newNote(null, target) : actions.newNote()); }} />
        <ClickableIcon icon="lucide-folder-plus" className="nav-action-button" label={t("plugins.file-explorer.action-new-folder")} onClick={event => { event.preventDefault(); actions.run(() => actions.newFolder()); }} />
        <ClickableIcon icon="lucide-sort-asc" className="nav-action-button" label={t("plugins.file-explorer.action-change-sort")} onClick={sortMenu} />
        <ClickableIcon icon="lucide-gallery-vertical" className={cx("nav-action-button", state.autoReveal && "is-active")} label={t("plugins.file-explorer.action-auto-reveal")} onClick={() => setState({ autoReveal: !state.autoReveal })} />
        <ClickableIcon icon={allCollapsed ? "lucide-chevrons-up-down" : "lucide-chevrons-down-up"} className="nav-action-button" label={t(allCollapsed ? "plugins.file-explorer.action-expand-all" : "plugins.file-explorer.action-collapse-all")}
          onClick={() => setExpanded(() => allCollapsed ? new Set(allFolders()) : new Set())} />
        <ClickableIcon icon="lucide-search" className={cx("nav-action-button", state.showSearch && "is-active")} label={t("plugins.backlinks.label-show-search")} style={{ display: "none" }} onClick={() => setState({ showSearch: !state.showSearch, searchQuery: "" })} />
      </div>
      <SearchInput style={state.showSearch ? undefined : { display: "none" }} value={state.searchQuery} onChange={value => setState({ searchQuery: value })} placeholder={t("plugins.search.prompt-start-search")} clearLabel={t("plugins.search.tooltip-clear-search")}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setState({ showSearch: false, searchQuery: "" }); } }} />
    </div>
    <div className={cx("nav-files-container node-insert-event", showUnsupported && "show-unsupported", dropPath === root.path && "is-being-dragged-over")} style={{ position: "relative" }} tabIndex={-1} ref={container}
      onKeyDown={onKeyDown} onCopy={onCopy} onCut={onCut} onPaste={onPaste} onContextMenu={rootMenu} {...dropProps(root)}
      onScroll={event => { const el = event.currentTarget; if (totalRows > WINDOW_THRESHOLD && Math.abs(el.scrollTop - viewport.top) > pitch * 8) setViewport({ top: el.scrollTop, height: el.clientHeight }); }}
      onClick={event => { if (event.target === event.currentTarget || event.target === event.currentTarget.firstElementChild) { setSelected(new Set()); setFocused(null); } }}>
      <div style={windowed ? { minHeight: `${rootChildren.total * pitch}px` } : undefined}>
        {pusher(rootChildren.before)}
        {rootChildren.nodes}
      </div>
    </div>
  </>;
}

/** Row label; switches to an in-place editable field while renaming, as the reference does. */
function Title({ file, renaming, className, spellcheck, validate, onDone }: { file: TAbstractFile; renaming: boolean; className: string; spellcheck: boolean; validate(name: string): string; onDone(file: TAbstractFile, name: string | null, el: HTMLElement | null): Promise<string | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const name = file instanceof TFile ? file.basename : file.name;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!renaming || !el) return;
    busy.current = false;
    el.textContent = name;
    el.focus();
    const range = el.ownerDocument.createRange(); range.selectNodeContents(el);
    const selection = el.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return () => { el.scrollLeft = 0; };
  }, [renaming]);
  if (!renaming) return <div className={`tree-item-inner ${className}`}>{name}</div>;
  const finish = (value: string | null, leaving: boolean) => {
    if (busy.current) return;
    busy.current = true;
    void onDone(file, value, ref.current).then(problem => { busy.current = false; if (problem !== null && leaving) void onDone(file, null, ref.current); });
  };
  return <div ref={ref} className={`tree-item-inner ${className}`} contentEditable suppressContentEditableWarning spellCheck={spellcheck}
    onClick={event => event.stopPropagation()} onDragStart={event => event.preventDefault()}
    onInput={() => {
      const el = ref.current;
      if (!el) return;
      // Pasted markup collapses to its text.
      if (el.childNodes.length !== 1 || el.firstChild?.nodeType !== Node.TEXT_NODE) { const text = el.textContent ?? ""; el.textContent = text; const selection = el.ownerDocument.getSelection(); selection?.selectAllChildren(el); selection?.collapseToEnd(); }
      const problem = validate((el.textContent ?? "").trim()), row = el.parentElement;
      if (problem && row) displayTooltip(row, problem, { classes: ["mod-error"] }); else hideTooltip();
    }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finish(ref.current?.textContent ?? "", false); }
      else if (event.key === "Escape") { event.preventDefault(); finish(null, false); }
    }}
    onBlur={() => finish(ref.current?.textContent ?? "", true)} />;
}

/** Tab title of the file explorer view. */
export const fileExplorerTitle = () => t("plugins.file-explorer.name");
