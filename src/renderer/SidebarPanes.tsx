import { clipboard, process } from "../../platforms/platform";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Keymap } from "../compat/commands";
import { CoreDockView } from "../compat/core-view";
import type { Editor } from "../compat/editor";
import { FileView } from "../compat/file-views";
import type { CachedMetadata, HeadingCache } from "../compat/metadata-cache";
import { parseCanvasReferences } from "../compat/metadata-cache";
import { assignPropertyType, readPropertyTypes, writePropertyTypes } from "../compat/property-types";
import { PropertiesEditor, inferPropertyType, type PropertyType } from "../compat/properties-editor";
import { Setting } from "../compat/setting-controls";
import { prepareFuzzySearch } from "../compat/suggest";
import { Menu, Modal, Notice } from "../compat/ui";
import { parseLinktext } from "../compat/utilities";
import { TFile, TFolder, type TAbstractFile } from "../compat/vault";
import type { WorkspaceLeaf } from "../compat/workspace";
import { PathMatcher, PropertyMatcher, QuoteMatcher, SearchQuery, TagMatcher, TextMatcher, compileSearchQuery, countMatches, mergeRanges, parseSearch, tokenizeSearch, wholeWordSource, type PropertyMatch, type SearchCache, type SearchInfo, type SearchRange, type SearchResult, type SearchToken } from "../controllers/search-query";
import { confirmDialog } from "../controllers/dialogs";
import { useT } from "../i18n/react";
import { t } from "../i18n";
import type { AppActions, OpenTarget } from "./actions";
import { BookmarkStore, bookmarkTitle, fileBookmark, folderBookmark, graphBookmark, groupBookmark, openBookmarkDialog, searchBookmark, urlBookmark, type BookmarkItem, type BookmarkLocation } from "./bookmarks";
import { readCorePluginData, writeCorePluginData } from "./core-plugins";
import { FILE_SORTERS, FILE_SORT_GROUPS, FILE_SORT_LABELS, VAULT_DRAG_TYPE, addFileMenuItems, isSortOrder, readDraggedPaths, renameInExplorer, revealInExplorer, type SortOrder } from "./FileExplorer";
import { displayTooltip, hideTooltip } from "./tooltip";
import { ViewHeader } from "./WorkspaceTree";
import { ClickableIcon, CollapseIcon, Dropdown, IconEl, SearchInput, SettingItem, Toggle, cx, useForceUpdate } from "./ui";

export { compileSearchQuery };

const collator = new Intl.Collator(undefined, { usage: "sort", sensitivity: "base", numeric: true });
const SPACER: CSSProperties = { width: "1px", height: "0.1px", marginBottom: 0 };
const WIDE_SPACER: CSSProperties = { width: "100%", height: "0.1px", marginBottom: 0 };
const HIDDEN: CSSProperties = { display: "none" };
const indent = (depth: number) => (el: HTMLElement | null) => { el?.style.setProperty("margin-inline-start", `${-17 * depth}px`, "important"); el?.style.setProperty("padding-inline-start", `${24 + 17 * depth}px`, "important"); };
const HEADING_DRAG_TYPE = "application/x-vault-heading", BOOKMARK_DRAG_TYPE = "application/x-bookmark";
const HOVER_PARENT = { hoverPopover: null };
const entered = (event: React.MouseEvent | React.PointerEvent) => !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null);

export interface PaneProps { leaf: WorkspaceLeaf; actions: AppActions }

/** Re-renders when files, metadata or the active file change. */
function useVaultRevision(actions: AppActions): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let frame = 0;
    const bump = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setRevision(value => value + 1); }); };
    const { vault, workspace, host } = actions;
    const vaultRefs = (["create", "delete", "modify"] as const).map(name => vault.on(name, bump)).concat(vault.on("rename", bump));
    const cacheRefs = [host.metadataCache.on("resolved", bump), host.metadataCache.on("changed", bump)];
    const workspaceRefs = [workspace.on("active-leaf-change", bump), workspace.on("file-open", bump), workspace.on("layout-change", bump)];
    return () => { cancelAnimationFrame(frame); vaultRefs.forEach(ref => vault.offref(ref)); cacheRefs.forEach(ref => host.metadataCache.offref(ref)); workspaceRefs.forEach(ref => workspace.offref(ref)); };
  }, [actions]);
  return revision;
}

function usePaneState<T extends object>(leaf: WorkspaceLeaf, defaults: T): [T, (patch: Partial<T>) => void] {
  const read = (current: T): T => {
    const saved = leaf.view.getState() as Record<string, unknown>, next = { ...current } as Record<string, unknown>;
    // Only values of the expected type are taken from a saved layout.
    for (const key of Object.keys(defaults)) if (typeof saved[key] === typeof (defaults as Record<string, unknown>)[key]) next[key] = saved[key];
    return next as T;
  };
  const [state, setState] = useState<T>(() => read(defaults));
  const latest = useRef(state); latest.current = state;
  useEffect(() => {
    const ref = leaf.workspace.on("core-view-state-change", (changed: unknown) => {
      if (changed !== leaf) return;
      const next = read(latest.current);
      if (JSON.stringify(next) !== JSON.stringify(latest.current)) { latest.current = next; setState(next); }
    });
    return () => leaf.workspace.offref(ref);
  }, [leaf]);
  return [state, patch => {
    const next = { ...latest.current, ...patch };
    latest.current = next; setState(next);
    void leaf.view.setState({ ...leaf.view.getState(), ...next }, { history: false }); leaf.workspace.requestSaveLayout();
  }];
}

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return settled;
}
/** The filter typed into a pane's search field, parsed with the vault search syntax; null when empty or invalid. */
function useFilter(shown: boolean, text: string): SearchQuery | null {
  const settled = useDebounced(shown ? text : "", 150);
  return useMemo(() => { if (!settled) return null; try { const query = new SearchQuery(settled, false); return query.matcher ? query : null; } catch { return null; } }, [settled]);
}
/** The file a file-bound sidebar view shows: the active file, or the one its pinned/linked leaf holds. */
function useBoundFile(leaf: WorkspaceLeaf, actions: AppActions): TFile | null {
  return leaf.view instanceof CoreDockView && leaf.view.followsFile ? leaf.view.getBoundFile() : actions.activeFile();
}

interface NavSearch { shown: boolean; value: string; onChange(value: string): void; onHide(): void }
function NavHeader({ children, search }: { children: ReactNode; search?: NavSearch }) {
  const t = useT();
  const holder = useRef<HTMLDivElement>(null), wasShown = useRef(search?.shown ?? false);
  useEffect(() => {
    if (search?.shown && !wasShown.current) { const input = holder.current?.querySelector<HTMLInputElement>("input[type=search]"); input?.focus(); input?.select(); }
    wasShown.current = search?.shown ?? false;
  }, [search?.shown]);
  return <div className="nav-header" ref={holder}>
    <div className="nav-buttons-container">{children}</div>
    {search && <SearchInput style={search.shown ? undefined : HIDDEN} value={search.value} onChange={search.onChange} placeholder={t("plugins.search.prompt-start-search")} clearLabel={t("plugins.search.tooltip-clear-search")}
      onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); search.onHide(); } }} />}
  </div>;
}

const NavButton = ({ icon, label, active, onClick, disabled }: { icon: string; label: string; active?: boolean; onClick?: (event: React.MouseEvent) => void; disabled?: boolean }) =>
  <ClickableIcon icon={icon} className={cx("nav-action-button", active && "is-active")} label={label} aria-disabled={disabled} onClick={disabled ? undefined : onClick} />;
const SearchButton = ({ search }: { search: NavSearch }) => {
  const t = useT();
  return <NavButton icon="lucide-search" label={t("plugins.backlinks.label-show-search")} active={search.shown} onClick={() => search.shown ? search.onHide() : search.onChange(search.value)} />;
};
/** Search toggle state backed by the pane's persisted `showSearch` / `searchQuery`. */
const navSearch = (state: { showSearch: boolean; searchQuery: string }, setState: (patch: { showSearch?: boolean; searchQuery?: string }) => void): NavSearch =>
  ({ shown: state.showSearch, value: state.searchQuery, onChange: searchQuery => setState({ showSearch: true, searchQuery }), onHide: () => setState({ showSearch: false, searchQuery: "" }) });

function showSortMenu<T extends string>(event: React.MouseEvent, groups: T[][], labels: Record<T, string>, current: T, choose: (order: T) => void, noIcon = true) {
  event.preventDefault();
  const menu = new Menu();
  if (noIcon) menu.setNoIcon();
  for (const group of groups) {
    for (const order of group) menu.addItem(item => item.setTitle(t(labels[order])).setChecked(order === current ? true : null).onClick(() => choose(order)));
    menu.addSeparator();
  }
  menu.showAtMouseEvent(event.nativeEvent);
}

/**
 * Keyboard navigation shared by the sidebar trees. Rows are the visible elements matching `selector`
 * and carry a `data-id`; collapsing goes through the row's collapse icon, activation through a click.
 */
function treeKeyDown(event: React.KeyboardEvent, container: HTMLElement | null, focused: string | null, setFocused: (id: string | null) => void, selector = ".tree-item-self[data-id]"): boolean {
  const target = event.target as HTMLElement;
  if (!container || target.isContentEditable || (target.tagName === "INPUT" && !["ArrowDown", "ArrowUp"].includes(event.key)) || target.tagName === "SELECT") return false;
  const rows = [...container.querySelectorAll<HTMLElement>(selector)].filter(row => row.getClientRects().length > 0);
  const index = rows.findIndex(row => row.dataset.id === focused), current = index >= 0 ? rows[index] : null;
  const focus = (row: HTMLElement | undefined | null) => { if (row) { setFocused(row.dataset.id ?? null); row.scrollIntoView({ block: "nearest" }); } };
  const item = current?.closest<HTMLElement>(".tree-item") ?? null, icon = current?.querySelector<HTMLElement>(":scope > .collapse-icon") ?? null;
  const collapsible = !!icon && icon.style.visibility !== "hidden", collapsed = !!item?.classList.contains("is-collapsed");
  if (event.key === "ArrowDown") focus(index < 0 ? rows[0] : rows[index + 1]);
  else if (event.key === "ArrowUp") { if (index <= 0 && target.tagName !== "INPUT") { if (index < 0) focus(rows[rows.length - 1]); } else focus(rows[index - 1]); }
  else if (event.key === "ArrowLeft" && current) {
    if (collapsible && !collapsed) icon!.click();
    else { const parent = (current.matches(".tree-item-self") ? item?.parentElement : current.parentElement)?.closest<HTMLElement>(".tree-item"); focus(parent?.querySelector<HTMLElement>(selector)); }
  } else if (event.key === "ArrowRight" && current) { if (collapsible && collapsed) icon!.click(); else if (collapsible) focus(rows[index + 1]); }
  else if ((event.key === "Enter" || event.key === " ") && current && target.tagName !== "INPUT") current.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: false, shiftKey: false, view: current.ownerDocument.defaultView }));
  else return false;
  event.preventDefault();
  return true;
}

/** Alt-click / Shift-click multi-selection over rows carrying `data-id`. */
function useSelection(container: React.RefObject<HTMLElement | null>, focusPane?: () => void) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const order = () => [...container.current?.querySelectorAll<HTMLElement>(".tree-item-self[data-id]") ?? []].filter(row => row.getClientRects().length > 0).map(row => row.dataset.id!);
  /** Returns true when the click only changed the selection. */
  const click = (event: React.MouseEvent, id: string): boolean => {
    if (!Keymap.isModEvent(event.nativeEvent)) {
      if (event.altKey && !event.shiftKey) { focusPane?.(); setSelected(current => { const next = new Set(current); if (!next.delete(id)) { next.add(id); setFocused(id); anchor.current = id; } return next; }); return true; }
      if (event.shiftKey) {
        focusPane?.();
        const ids = order(), from = anchor.current ? ids.indexOf(anchor.current) : -1, to = ids.indexOf(id);
        const range = from < 0 ? [id] : ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected(current => new Set([...current, ...range]));
        return true;
      }
      if (event.currentTarget.classList.contains("is-active")) { focusPane?.(); setFocused(id); return true; }
    }
    if (event.detail > 0) { setSelected(current => current.size ? new Set() : current); setFocused(null); }
    anchor.current = id;
    return false;
  };
  const clear = () => { setSelected(current => current.size ? new Set() : current); setFocused(null); };
  return { selected, setSelected, focused, setFocused, click, clear, anchor };
}

// ---------------------------------------------------------------- Drop position inside a tree

interface DropPlace { id: string | null; placement: "before" | "after"; inside: boolean; x: number; y: number }
/** Where a dragged item would land: before/after a row, or inside a collapsible one when over its middle. */
function dropPlace(event: React.DragEvent, container: HTMLElement, excluded?: ReadonlySet<string>): DropPlace | null {
  const rows = [...container.querySelectorAll<HTMLElement>(".tree-item-self[data-id]")].filter(row => row.getClientRects().length > 0);
  const box = container.getBoundingClientRect(), offset = (rect: DOMRect, edge: "top" | "bottom") => rect[edge] - box.top + container.scrollTop;
  if (!rows.length) return { id: null, placement: "before", inside: false, x: 0, y: 0 };
  const first = rows[0].getBoundingClientRect(), last = rows[rows.length - 1].getBoundingClientRect(), left = first.left - box.left;
  if (event.clientY < first.top) return { id: rows[0].dataset.id!, placement: "before", inside: false, x: left, y: offset(first, "top") };
  if (event.clientY > last.bottom) return { id: null, placement: "after", inside: false, x: left, y: offset(last, "bottom") };
  let result: DropPlace | null = null;
  for (const row of rows) {
    if (excluded && [...excluded].some(id => row.dataset.id === id || row.dataset.id?.startsWith(`${id}-`))) continue;
    const rect = row.getBoundingClientRect();
    if (event.clientY < rect.top || (excluded ? rect.bottom - event.clientY >= 2 * rect.height : event.clientY > rect.bottom + 2)) continue;
    const half = rect.height / 2, middle = rect.top + half, collapsible = row.classList.contains("mod-collapsible");
    const inside = collapsible && Math.abs(event.clientY - middle) / half < 0.9;
    const placement = inside || event.clientY > middle ? "after" : "before";
    result = { id: row.dataset.id!, placement, inside, x: rect.left - box.left + parseFloat(getComputedStyle(row).paddingLeft || "0") - 24 + 0, y: offset(rect, placement === "before" ? "top" : "bottom") };
    if (!excluded) return result;
  }
  return result;
}
const DropIndicator = ({ place }: { place: DropPlace | null }) => place && !place.inside ? <div className="drop-indicator is-active" style={{ left: `${place.x}px`, top: `${place.y + (place.placement === "after" ? 1 : -1) - 2}px` }} /> : null;

// ---------------------------------------------------------------- Result tree (search, backlinks, unlinked mentions)

interface FileResult { file: TFile; result: SearchResult; content: string }
export interface Snippet { start: number; end: number; before: boolean; after: boolean; matches: SearchRange[] }

const contentCache = new Map<string, { mtime: number; size: number; text: string }>();
async function readText(actions: AppActions, file: TFile): Promise<string> {
  const hit = contentCache.get(file.path);
  if (hit && hit.mtime === file.stat.mtime && hit.size === file.stat.size) return hit.text;
  const text = await actions.vault.cachedRead(file).catch(() => "");
  if (contentCache.size > 20000) contentCache.clear();
  contentCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, text });
  return text;
}
const cacheOf = (actions: AppActions, file: TFile) => actions.host.metadataCache.getFileCache(file) as (CachedMetadata & SearchCache) | null;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** The part of the matched line shown by default: up to `limit` characters either side. */
function lineWindow(content: string, range: SearchRange, limit = 100): [number, number, boolean, boolean] {
  let start = range[0] - 1, taken = 0;
  for (; taken < limit && start >= 0 && content.charAt(start) !== "\n"; start--) taken++;
  start++;
  let end = range[1], after = 0;
  for (; after < limit && end < content.length && content.charAt(end) !== "\n"; end++) after++;
  return [start, end, taken === limit, after === limit];
}
const LIST_LINE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]/;
const blankAt = (content: string, at: number) => { const pattern = /\r?\n\r?\n/y; pattern.lastIndex = at; return pattern.test(content); };
/** "Show more context": the whole list item (with its nested items) or paragraph around the match. */
function contextWindow(content: string, range: SearchRange): [number, number] {
  let start = range[0];
  for (const limit = start - 1000; start > 0 && start > limit && content.charCodeAt(start - 1) !== 10;) start--;
  let end = range[0];
  for (const limit = end + 1000; end < content.length && end < limit && content.charCodeAt(end) !== 10;) end++;
  const list = LIST_LINE.exec(content.substring(start, end));
  if (list) {
    let last = end;
    while (last < content.length) {
      let next = content.indexOf("\n", last + 1);
      if (next === -1) next = content.length;
      const line = content.substring(last + 1, next), nested = LIST_LINE.exec(line);
      if (!line.trim() || (nested && nested[1].length <= list[1].length) || (!nested && !/^\s/.test(line))) break;
      last = next;
    }
    return [start, last];
  }
  let from = start;
  for (const limit = range[0] - 1000; from > 0 && from > limit && !blankAt(content, from);) from--;
  while (content.charCodeAt(from) === 10 && from < start) from++;
  let to = end;
  for (const limit = range[0] + 1000; to < content.length && to < limit && !blankAt(content, to);) to++;
  return [from, to];
}
/** Groups sorted match ranges into the excerpts shown under a result. */
export function matchSnippets(content: string, ranges: SearchRange[], extraContext: boolean, separate: boolean): Snippet[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]), snippets: Snippet[] = [];
  for (let index = 0; index < sorted.length;) {
    const [start, initialEnd, before, after] = extraContext ? [...contextWindow(content, sorted[index]), false, false] as [number, number, boolean, boolean] : lineWindow(content, sorted[index]);
    let end = initialEnd, next = index + 1;
    if (!separate) while (next < sorted.length) {
      const range = sorted[next];
      if (range[0] >= end) break;
      if (range[1] > end) { end = range[1]; next++; break; }
      next++;
    }
    snippets.push({ start, end, before, after, matches: sorted.slice(index, next) });
    index = next;
  }
  return snippets;
}
function highlighted(text: string, from: number, to: number, ranges: SearchRange[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = from;
  for (const [rawStart, rawEnd] of ranges) {
    if (rawStart >= to) break;
    if (rawEnd < from) continue;
    const start = Math.max(rawStart, from), end = Math.min(rawEnd, to);
    if (start > cursor) parts.push(<span key={`t${cursor}`}>{text.substring(cursor, start)}</span>);
    parts.push(<span key={`m${start}`} className="search-result-file-matched-text">{text.substring(start, end)}</span>);
    cursor = end;
  }
  if (cursor < to) parts.push(<span key={`t${cursor}`}>{text.substring(cursor, to)}</span>);
  return parts;
}

async function openResult(actions: AppActions, file: TFile, target: OpenTarget, range?: SearchRange | null, nodeId?: string): Promise<void> {
  const leaf = await actions.openFile(file, target);
  if (nodeId && file.extension === "canvas") { leaf.setEphemeralState({ focus: true, match: { nodeId } }); return; }
  const editor = (leaf.view as { editor?: Editor }).editor;
  if (!range || !editor || file.extension !== "md") return;
  const from = editor.offsetToPos(range[0]), to = editor.offsetToPos(range[1]);
  editor.setSelection(from, to); editor.scrollIntoView({ from, to }, true);
}
/** The menu of a link to a file: open, rename, the common file items and optionally delete. */
function showFileLinkMenu(actions: AppActions, file: TFile, event: React.MouseEvent, withDelete: boolean) {
  event.preventDefault(); event.stopPropagation();
  const menu = new Menu();
  menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(() => actions.run(() => actions.openFile(file, "tab"))));
  menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-to-the-right")).setIcon("lucide-separator-vertical").onClick(() => actions.run(() => actions.openFile(file, "split"))));
  menu.addItem(item => item.setSection("action").setTitle(t("plugins.file-explorer.menu-opt-rename")).setIcon("lucide-edit-3").onClick(() => actions.run(() => renameInExplorer(actions, file))));
  addFileMenuItems(menu, actions, file, "link-context-menu");
  if (withDelete) menu.addItem(item => item.setSection("danger").setTitle(t("interface.menu.delete-file")).setIcon("lucide-trash-2").setWarning(true).onClick(() => actions.run(() => actions.delete(file))));
  menu.showAtMouseEvent(event.nativeEvent);
}
const hoverFile = (actions: AppActions, source: string, linktext: string, event: React.MouseEvent | React.PointerEvent, sourcePath?: string) => {
  if (entered(event)) actions.workspace.trigger("hover-link", { event: event.nativeEvent, source, hoverParent: HOVER_PARENT, targetEl: event.currentTarget, linktext, sourcePath });
};

function Match({ id, line, text, snippet, focused, onOpen, onMenu, onHover, children }: { id: string; line?: number; text: string; snippet: Snippet; focused: boolean; onOpen(event: React.MouseEvent): void; onMenu(event: React.MouseEvent): void; onHover?(event: React.MouseEvent): void; children?: ReactNode }) {
  const t = useT();
  const [span, setSpan] = useState<[number, number] | null>(null);
  const [hovered, setHovered] = useState(false);
  const start = span?.[0] ?? snippet.start, end = span?.[1] ?? snippet.end, active = hovered || focused;
  const lineStart = (at: number) => { while (at > 0 && text.charCodeAt(at - 1) !== 10) at--; return at; };
  const lineEnd = (at: number) => { while (at < text.length && text.charCodeAt(at) !== 10) at++; return at; };
  const moreBefore = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); let at = start; while (at > 0) { at--; const previous = lineStart(at); if (previous < at) { at = previous; break; } } setSpan([at, end]); };
  const moreAfter = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); let at = end; while (at < text.length) { at++; const next = lineEnd(at); if (next > at) { at = next; break; } } setSpan([start, at]); };
  return <div className={cx("search-result-file-match tappable", focused && "has-focus")} data-id={id} data-line={line} onClick={event => { if (!event.defaultPrevented) onOpen(event); }} onAuxClick={event => { if (event.button === 1) onOpen(event); }} onContextMenu={onMenu}
    onMouseOver={event => { if (entered(event)) { setHovered(true); onHover?.(event); } }} onMouseOut={event => { if (entered(event)) setHovered(false); }}
    onKeyDown={undefined}>
    {snippet.before && !span && "..."}
    {highlighted(text, start, end, snippet.matches)}
    <IconEl icon="lucide-chevron-up" className="search-result-hover-button mod-top" aria-label={t("plugins.search.label-more-context")} data-tooltip-position="top" style={active && start > 0 ? undefined : HIDDEN} onClick={moreBefore} />
    <IconEl icon="lucide-chevron-down" className="search-result-hover-button mod-bottom" aria-label={t("plugins.search.label-more-context")} style={active && end < text.length ? undefined : HIDDEN} onClick={moreAfter} />
    {snippet.after && !span && "..."}
    {children}
  </div>;
}

function PropertyResult({ id, matches, frontmatter, focused, onOpen, onMenu }: { id: string; matches: PropertyMatch[]; frontmatter: Record<string, unknown>; focused: boolean; onOpen(event: React.MouseEvent): void; onMenu(event: React.MouseEvent): void }) {
  const key = matches[0].key, value = frontmatter[key];
  const ranges = (list: PropertyMatch[]) => mergeRanges(list.flatMap(match => match.pos ? [[...match.pos] as SearchRange] : []));
  return <div className={cx("search-result-file-match tappable", focused && "has-focus")} data-id={id} onClick={onOpen} onContextMenu={onMenu}>
    <span>{`${key}: `}</span>
    {Array.isArray(value) ? value.map((entry, index) => entry ? <Fragment key={index}><span>{matches.some(match => match.pos && match.subkey?.[0] === index) ? highlighted(String(entry), 0, String(entry).length, ranges(matches.filter(match => match.pos && match.subkey?.[0] === index))) : String(entry)}</span><span> </span></Fragment> : null)
      : highlighted(String(value), 0, String(value).length, ranges(matches))}
  </div>;
}

interface ResultTreeProps {
  results: FileResult[]; actions: AppActions; collapseAll: boolean; extraContext: boolean; sortOrder: SortOrder; emptyText: string; working?: boolean;
  /** Without titles the matches of the single result are listed directly (outgoing unlinked mentions). */
  showTitle?: boolean; separate?: boolean; focused?: string | null;
  extra?(result: FileResult, range: SearchRange): ReactNode;
  onCollapseAll?(collapsed: boolean): void;
}
const RESULT_PAGE = 100;
function ResultTree({ results, actions, collapseAll, extraContext, sortOrder, emptyText, working, showTitle = true, separate = false, focused = null, extra, onCollapseAll }: ResultTreeProps) {
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [limit, setLimit] = useState(RESULT_PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => setToggled(new Set()), [collapseAll]);
  const sorted = useMemo(() => [...results].sort((a, b) => FILE_SORTERS[sortOrder](a.file, b.file)), [results, sortOrder]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setLimit(current => current + RESULT_PAGE); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [sorted.length > limit, limit]);

  const matchesOf = ({ file, result, content }: FileResult): ReactNode[] => {
    const nodes: ReactNode[] = [], menu = (event: React.MouseEvent) => showFileLinkMenu(actions, file, event, false);
    const open = (range: SearchRange | null, nodeId?: string) => (event: React.MouseEvent) => { event.preventDefault(); actions.run(() => openResult(actions, file, Keymap.isModEvent(event.nativeEvent), range, nodeId)); };
    const excerpt = (text: string, ranges: SearchRange[], prefix: string) => {
      for (const snippet of matchSnippets(text, ranges, extraContext, separate)) {
        const id = `${file.path}\n${prefix}${snippet.matches[0][0]}`;
        const line = prefix ? undefined : text.slice(0, snippet.matches[0][0]).split("\n").length - 1;
        nodes.push(<Match key={`${id}:${snippet.matches[0][1]}:${snippet.start}:${snippet.end}`} id={id} line={line} text={text} snippet={snippet} focused={focused === id} onOpen={open(prefix ? null : snippet.matches[0], prefix ? prefix.slice(0,-1) : undefined)} onMenu={menu} onHover={event => actions.workspace.trigger("hover-link", { event: event.nativeEvent, source: "search", hoverParent: HOVER_PARENT, targetEl: event.currentTarget, linktext: file.path, state: line === undefined ? undefined : { scroll: line } })}>
          {!prefix && extra?.({ file, result, content }, snippet.matches[0])}
        </Match>);
      }
    };
    if (file.extension === "canvas" && content) {
      try {
        const data = JSON.parse(content) as { nodes?: Array<{ id: string; type: string; text?: string; x?: number; y?: number }> };
        for (const node of (data.nodes ?? []).filter(node => node.type === "text").sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))) { const ranges = result[`canvas-${node.id}`]; if (ranges?.length) excerpt(node.text ?? "", ranges, `${node.id}:`); }
      } catch { /* listed by name only */ }
      return nodes;
    }
    if (result.properties?.length) {
      const groups = new Map<string, PropertyMatch[]>();
      for (const match of result.properties) groups.set(match.key, [...(groups.get(match.key) ?? []), match]);
      const frontmatter = cacheOf(actions, file)?.frontmatter ?? {};
      for (const [key, list] of groups) { const id = `${file.path}\n[${key}]`; nodes.push(<PropertyResult key={id} id={id} matches={list} frontmatter={frontmatter} focused={focused === id} onOpen={open(null)} onMenu={menu} />); }
    }
    if (result.content?.length) excerpt(content, result.content, "");
    return nodes;
  };
  const title = (file: TFile, result: SearchResult): ReactNode => {
    if (result.filepath) {
      const shift = file.path.length - file.name.length;
      return highlighted(file.path, 0, file.path.length, mergeRanges([...result.filepath.map(range => [...range] as SearchRange), ...(result.filename ?? []).map(range => [range[0] + shift, range[1] + shift] as SearchRange)]));
    }
    if (result.filename) {
      const text = file.extension === "md" && (!result.filename.length || result.filename[result.filename.length - 1][1] <= file.basename.length) ? file.basename : file.name;
      return highlighted(text, 0, text.length, result.filename);
    }
    return file.extension === "md" ? file.basename : file.name;
  };

  return <>
    <div className="search-results-children" style={sorted.length ? undefined : { minHeight: 0 }}>
      {sorted.length > 0 && <div style={SPACER} />}
      {sorted.slice(0, limit).map(entry => {
        const { file, result } = entry, collapsed = toggled.has(file.path) !== collapseAll, count = countMatches({ ...result, filename: undefined });
        const matches = matchesOf(entry);
        const hasMatches = matches.length > 0 || count > 0;
        if (!showTitle) return <div key={file.path} className="tree-item search-result"><div className="search-result-file-matches"><div style={SPACER} />{matches}</div></div>;
        return <div key={file.path} className={cx("tree-item search-result", collapsed && "is-collapsed")}>
          <div className={cx("tree-item-self search-result-file-title is-clickable", focused === file.path && "has-focus")} data-path={file.path} data-id={file.path} draggable
            onDragStart={event => { event.dataTransfer.setData(VAULT_DRAG_TYPE, JSON.stringify([file.path])); event.dataTransfer.setData("text/plain", `[[${file.extension === "md" ? file.basename : file.name}]]`); }}
            onClick={event => { if (event.defaultPrevented) return; event.preventDefault(); actions.run(() => openResult(actions, file, Keymap.isModEvent(event.nativeEvent), result.content?.[0] ?? null)); }}
            onAuxClick={event => { if (event.button === 1) actions.run(() => openResult(actions, file, "tab")); }}
            onMouseOver={event => hoverFile(actions, "search", file.path, event)} onContextMenu={event => showFileLinkMenu(actions, file, event, true)}>
            <IconEl icon="right-triangle" className={cx("tree-item-icon collapse-icon", collapsed && "is-collapsed")} style={hasMatches ? undefined : { visibility: "hidden" }}
              onClick={event => { event.preventDefault(); event.stopPropagation(); if (Keymap.isModifier(event.nativeEvent, "Mod") && onCollapseAll) onCollapseAll(!collapsed); else setToggled(current => { const next = new Set(current); if (!next.delete(file.path)) next.add(file.path); return next; }); }} />
            <div className="tree-item-inner">{title(file, result)}</div>
            {count > 0 && <div className="tree-item-flair-outer"><span className="tree-item-flair">{count}</span></div>}
          </div>
          <div className="search-result-file-matches" style={collapsed ? HIDDEN : !hasMatches ? { minHeight: 0 } : undefined}>
            {hasMatches && <div style={SPACER} />}
            {!collapsed && matches}
          </div>
        </div>;
      })}
      {sorted.length > limit && <div ref={sentinel} style={{ height: "1px" }} />}
    </div>
    {!sorted.length && !working && <div className="search-empty-state">{emptyText}</div>}
  </>;
}
const totalMatches = (results: FileResult[]) => results.reduce((sum, entry) => sum + countMatches(entry.result), 0);

// ---------------------------------------------------------------- Search

interface SearchState { query: string; matchingCase: boolean; explainSearch: boolean; collapseAll: boolean; extraContext: boolean; sortOrder: SortOrder }
type Suggestion = { type: "group"; name: string; icon: string; tooltip: string; action(): void } | { type: "operator"; name: string; token: string; info: string } | { type: "string" | "property-key" | "history"; name: string };
const SEARCH_OPTIONS: Array<[string, string, string]> = [
  ["path:", "path:", "plugins.search.label-path-option-description"], ["file:", "file:", "plugins.search.label-file-name-option-description"], ["tag:", "tag:", "plugins.search.label-tag-option-description"],
  ["line:", "line:()", "plugins.search.label-line-option-description"], ["section:", "section:()", "plugins.search.label-section-option-description"], ["[property]", "[]", "plugins.search.label-property-option-description"],
];
const RECENT_SEARCHES = "recent-searches", SEARCH_HELP = "https://help.obsidian.md/plugins/search";
const tokenEnd = (token: SearchToken) => token.pos + token.content.length + (token.type === "quote" || token.type === "regex" ? 2 : 0);

/** Query fences use the same result rows as Search, with their own lifetime and query. */
export function EmbeddedQueryResults({ actions, query: source, sourcePath }: { actions: AppActions; query: string; sourcePath: string }) {
  const t = useT();
  const revision = useDebounced(useVaultRevision(actions), 100);
  const [results, setResults] = useState<FileResult[]>([]), [working, setWorking] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setWorking(true);
    void (async () => {
      const found: FileResult[] = [];
      try {
        const query = new SearchQuery(source.replace(/\r?\n/g, " "), false);
        if (query.matcher) for (const file of actions.vault.getFiles()) {
          let text = ["md", "canvas"].includes(file.extension) && query.requiredInputs.content ? await readText(actions, file) : "";
          if (cancelled) return;
          if (file.path === sourcePath) text = text.replace(/```query([\s\S]*?)(```|$)/g, fence => fence.replace(/./g, " "));
          const result = query.match(file, text, file.extension === "md" ? cacheOf(actions, file) : null);
          if (result) found.push({ file, result, content: text || (file.extension === "md" ? await readText(actions, file) : "") });
        }
      } catch (error) { console.log(error); }
      if (!cancelled) { setResults(found); setWorking(false); }
    })();
    return () => { cancelled = true; };
  }, [actions, source, sourcePath, revision]);
  return <ResultTree results={results} actions={actions} collapseAll={false} extraContext={false} sortOrder="alphabetical" emptyText={t("plugins.search.label-no-matches")} working={working} />;
}

function SearchExplanation({ info }: { info: SearchInfo }) {
  const t = useT();
  return <>
    <div>{info.text}</div>
    {info.children && <div className="search-info-children">{info.children.map((child, index) => <SearchExplanation key={index} info={child} />)}</div>}
    {info.key && <div className="search-info-children">
      <span>{t("obsen.search.label-key")}</span><div className="search-info-children"><SearchExplanation info={info.key} /></div>
      {info.value && <><span>{t("obsen.search.label-value")}</span><div className="search-info-children"><SearchExplanation info={info.value} /></div></>}
    </div>}
  </>;
}

/** The "Copy search results" dialog; its options are kept in the plugin's data file. */
function openCopyResults(actions: AppActions, files: TFile[]) {
  class CopyResults extends Modal {
    override async onOpen() {
      this.setTitle(t("plugins.search.label-copy-search-results"));
      const options = await readCorePluginData(actions.config.configDir, "global-search").catch(() => ({} as Record<string, unknown>));
      const box = document.createElement("div"); box.className = "copy-search-result-container";
      const area = document.createElement("textarea"); area.className = "copy-search-result-textarea";
      box.append(area); this.contentEl.append(box);
      let showPath = !!options.showFullPath, linkStyle = typeof options.linkStyle === "string" ? options.linkStyle : "none", listStyle = typeof options.listStyle === "string" ? options.listStyle : "none";
      const shortName = (file: TFile) => file.extension === "md" ? file.basename : file.name;
      const update = (save: boolean) => {
        area.value = files.map((file, index) => {
          let line = showPath ? file.path : shortName(file);
          if (linkStyle === "wikilink") line = `[[${line}]]`; else if (linkStyle === "markdown") line = `[${file.basename}](${line})`;
          return listStyle === "-" ? `- ${line}` : listStyle === "*" ? `* ${line}` : listStyle === "num" ? `${index + 1}. ${line}` : line;
        }).join("\n");
        area.select();
        if (save) void writeCorePluginData(actions.config.configDir, "global-search", { ...options, showFullPath: showPath, linkStyle, listStyle });
      };
      new Setting(box).setName(t("plugins.search.option-show-path")).setDesc(t("plugins.search.option-show-path-description")).addToggle(toggle => toggle.setValue(showPath).onChange(value => { showPath = value; update(true); }));
      new Setting(box).setName(t("plugins.search.option-link-style")).setDesc(t("plugins.search.option-link-style-description")).addDropdown(dropdown => dropdown
        .addOption("none", t("plugins.search.option-choice-link-style-none")).addOption("wikilink", t("plugins.search.option-choice-link-style-wikilink")).addOption("markdown", t("plugins.search.option-choice-link-style-markdown-link"))
        .setValue(linkStyle).onChange(value => { linkStyle = value; update(true); }));
      new Setting(box).setName(t("plugins.search.option-list-prefix")).setDesc(t("plugins.search.option-list-prefix-description")).addDropdown(dropdown => dropdown
        .addOption("none", t("plugins.search.option-choice-list-style-none")).addOption("-", t("plugins.search.option-choice-list-style-dash")).addOption("*", t("plugins.search.option-choice-list-style-asterisk")).addOption("num", t("plugins.search.option-choice-list-style-numbered"))
        .setValue(listStyle).onChange(value => { listStyle = value; update(true); }));
      const buttons = document.createElement("div"); buttons.className = "modal-button-container";
      const copy = document.createElement("button"); copy.className = "mod-cta"; copy.textContent = t("plugins.search.button-copy-results");
      copy.addEventListener("click", () => { clipboard.writeText(area.value); new Notice(t("plugins.search.msg-successfully-copied")); });
      const done = document.createElement("button"); done.textContent = t("dialogue.button-done"); done.addEventListener("click", () => this.close());
      buttons.append(copy, done); this.contentEl.append(buttons);
      update(false);
    }
  }
  new CopyResults(actions.app).open();
}

export function SearchPane({ leaf, actions }: PaneProps) {
  const t = useT();
  const [state, setState] = usePaneState<SearchState>(leaf, { query: "", matchingCase: false, explainSearch: false, collapseAll: false, extraContext: false, sortOrder: "alphabetical" });
  const sortOrder = isSortOrder(state.sortOrder) ? state.sortOrder : "alphabetical";
  const [showSettings, setShowSettings] = useState(false);
  const [results, setResults] = useState<FileResult[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<{ items: Suggestion[]; selected: number; box: { left: number; top: number; width: number } } | null>(null);
  const generation = useRef(0), holder = useRef<HTMLDivElement>(null), resultsEl = useRef<HTMLDivElement>(null), tokens = useRef<SearchToken[]>([]);
  const { vault } = actions;
  const revision = useVaultRevision(actions);
  const settledRevision = useDebounced(revision, 500);
  const inputEl = () => holder.current?.querySelector<HTMLInputElement>("input[type=search]") ?? null;

  const parsed = useMemo(() => { try { return { query: new SearchQuery(state.query, state.matchingCase), error: "" }; } catch (reason) { return { query: null, error: (reason as Error).message }; } }, [state.query, state.matchingCase]);
  useEffect(() => {
    const run = ++generation.current, query = parsed.query;
    setError(parsed.error);
    if (!query?.matcher) { setResults([]); setWorking(false); return; }
    setWorking(true);
    const timer = setTimeout(async () => {
      const found: FileResult[] = [];
      let last = performance.now();
      for (const file of vault.getFiles()) {
        const text = (file.extension === "md" || file.extension === "canvas") && query.requiredInputs.content ? await readText(actions, file) : "";
        if (run !== generation.current) return;
        const result = query.match(file, text, file.extension === "md" ? cacheOf(actions, file) : null);
        if (result) found.push({ file, result, content: text || (file.extension === "md" ? await readText(actions, file) : "") });
        if (performance.now() - last > 12) { await pause(); if (run !== generation.current) return; last = performance.now(); }
      }
      if (run === generation.current) { setResults(found); setWorking(false); }
    }, 60);
    return () => clearTimeout(timer);
  }, [parsed, settledRevision, vault]);
  // The query that was searched joins the history a little later, as in the reference.
  useEffect(() => {
    if (!state.query) return;
    const timer = setTimeout(() => {
      const saved = actions.app.loadLocalStorage(RECENT_SEARCHES), list = (Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === "string") : []).filter(entry => entry !== state.query);
      list.unshift(state.query);
      actions.app.saveLocalStorage(RECENT_SEARCHES, list.slice(0, 20));
    }, 5000);
    return () => clearTimeout(timer);
  }, [state.query]);

  const suggestionsFor = (value: string, input: HTMLInputElement): Suggestion[] => {
    if (input.selectionStart !== input.selectionEnd) return [];
    const caret = input.selectionStart ?? value.length;
    if (caret < value.length - 1 && value.charAt(caret) !== " ") return [];
    const list = tokens.current = tokenizeSearch(value.slice(0, caret));
    let context;
    try { context = parseSearch(list)?.getContext(caret) ?? null; } catch { return []; }
    const readMore = (name: string): Suggestion => ({ type: "group", name, icon: "lucide-info", tooltip: t("plugins.search.tooltip-read-more"), action: () => { window.open(SEARCH_HELP, "_blank"); } });
    let typed = "";
    if (context) {
      const token = context.token;
      if (["quote", "text", "regex"].includes(token.type)) typed = token.content;
      let top = context.matcherStack[0];
      if (top instanceof QuoteMatcher || top instanceof TextMatcher) { context.matcherStack.shift(); top = context.matcherStack[0]; }
      const ranked = (names: string[], type: "string" | "property-key", strip = 0) => { const search = prepareFuzzySearch(typed); return names.flatMap(name => { const match = search(name.slice(strip)); return match ? [{ name, score: match.score }] : []; }).sort((a, b) => b.score - a.score).map(entry => ({ type, name: entry.name }) as Suggestion); };
      if (top instanceof PropertyMatcher) {
        if (top.value || token.type === "colon" || token.content === "]") return [];
        const names = new Map<string, string>();
        for (const note of vault.getMarkdownFiles()) for (const name of Object.keys(cacheOf(actions, note)?.frontmatter ?? {})) if (name !== "position" && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
        const found = ranked([...names.values()], "property-key");
        return found.length ? [readMore(t("plugins.search.label-properties-group")), ...found] : [];
      }
      if (top instanceof TagMatcher) {
        const found = ranked(Object.keys(vaultTags(actions)).sort(collator.compare), "string", 1);
        return found.length ? [readMore(t("plugins.search.label-tags-group")), ...found] : [];
      }
      if (top instanceof PathMatcher) return ranked(vault.getAllFolders(false).map(folder => folder.path), "string");
      if (token.type === "quote" || context.matcherStack.length > 0) return [];
    }
    const items: Suggestion[] = [], options = SEARCH_OPTIONS.filter(([name]) => name.startsWith(typed.toLowerCase()));
    if (options.length) items.push(readMore(t("plugins.search.label-search-options")), ...options.map(([name, token, info]) => ({ type: "operator", name, token, info: t(info) }) as Suggestion));
    if (!value) {
      const saved = actions.app.loadLocalStorage(RECENT_SEARCHES), history = Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === "string") : [];
      if (history.length) items.push({ type: "group", name: t("plugins.search.label-history"), icon: "lucide-x", tooltip: t("plugins.search.tooltip-clear-history"), action: () => actions.app.saveLocalStorage(RECENT_SEARCHES, null) }, ...history.map(name => ({ type: "history", name }) as Suggestion));
    }
    return items;
  };
  const refreshSuggest = (value?: string) => {
    const input = inputEl();
    if (!input || input.ownerDocument.activeElement !== input) { setSuggest(null); return; }
    const items = suggestionsFor(value ?? input.value, input);
    if (!items.length) { setSuggest(null); return; }
    const box = input.getBoundingClientRect();
    setSuggest({ items, selected: items[0].type === "group" ? Math.min(1, items.length - 1) : 0, box: { left: box.left, top: box.bottom + 2, width: Math.max(input.offsetWidth, 300) } });
  };
  const choose = (item: Suggestion, shift: boolean) => {
    const input = inputEl();
    if (!input || item.type === "group") return;
    const caret = input.selectionStart ?? input.value.length, value = input.value, list = tokens.current;
    let index = list.length - 1;
    while (index >= 0 && list[index].pos > caret) index--;
    let token: SearchToken | null | undefined = list[index];
    while (token && !["text", "regex", "quote"].includes(token.type)) token = list[++index];
    if (token && caret > tokenEnd(token)) token = null;
    const start = token ? token.pos : caret, end = token ? tokenEnd(token) : value.length;
    let insert = item.name;
    if (item.type === "string" && /[[\]()\s:]/.test(insert)) insert = `"${insert}"`;
    if (item.type === "property-key") insert = shift ? `"${insert}"] ` : `"${insert}":`;
    if (item.type === "string") insert += " "; else if (item.type === "operator") insert = item.token;
    const next = value.slice(0, start) + insert + value.slice(end).trimStart() + (item.type === "string" ? " " : "");
    const position = start + insert.length - (item.type === "operator" && /[)\]]$/.test(item.token) ? 1 : 0);
    setState({ query: next });
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(position, position); refreshSuggest(next); });
  };
  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (suggest) {
      const move = (delta: number) => { event.preventDefault(); setSuggest(current => current && { ...current, selected: (current.selected + delta + current.items.length) % current.items.length }); };
      if (event.key === "ArrowDown") return move(1);
      if (event.key === "ArrowUp") return move(-1);
      if (event.key === "Escape") { event.preventDefault(); setSuggest(null); return; }
      if (event.key === "Enter") { const item = suggest.items[suggest.selected]; if (item && item.type !== "group") { event.preventDefault(); choose(item, event.shiftKey); return; } }
    }
    if (event.key === "Enter") { setSuggest(null); generation.current++; setState({ query: event.currentTarget.value }); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") treeKeyDown(event, resultsEl.current, focused, setFocused, RESULT_ROWS);
  };

  const menu = (event: React.MouseEvent) => {
    const menu = new Menu();
    menu.addItem(item => item.setSection("action").setIcon("lucide-copy").setTitle(t("plugins.search.label-copy-search-results")).onClick(() => openCopyResults(actions, [...results].sort((a, b) => FILE_SORTERS[sortOrder](a.file, b.file)).map(entry => entry.file))));
    const store = bookmarkStoreOf(actions);
    if (store && state.query) menu.addItem(item => item.setSection("action").setTitle(t("plugins.bookmarks.action-bookmark")).setIcon("lucide-bookmark").onClick(() => openBookmarkDialog(actions.app, store, searchBookmark(state.query))));
    actions.workspace.trigger("search:results-menu", menu, leaf.view);
    menu.showAtMouseEvent(event.nativeEvent);
  };
  const sortOptions = FILE_SORT_GROUPS.flat().map(value => ({ value, label: t(FILE_SORT_LABELS[value]) }));
  const toggle = (name: string, key: "collapseAll" | "extraContext" | "explainSearch") =>
    <SettingItem className="mod-toggle" name={name}><Toggle value={state[key]} onChange={value => setState({ [key]: value })} /></SettingItem>;
  const explanation = parsed.query?.explain() ?? null;

  return <>
    <div className="search-row" ref={holder} onFocus={event => { if ((event.target as HTMLElement).tagName === "INPUT") refreshSuggest(); }} onBlur={() => setSuggest(null)}>
      <SearchInput className="global-search-input-container" value={state.query} onChange={query => { setFocused(null); setState({ query }); requestAnimationFrame(() => refreshSuggest(query)); }} onKeyDown={onInputKey} placeholder={t("plugins.search.prompt-start-search")} clearLabel={t("plugins.search.tooltip-clear-search")}>
        <ClickableIcon icon="uppercase-lowercase-a" className={cx("input-right-decorator", state.matchingCase && "is-active")} label={t("plugins.search.label-match-case")} onClick={() => setState({ matchingCase: !state.matchingCase })} />
      </SearchInput>
      <ClickableIcon icon="lucide-sliders-horizontal" className={cx(showSettings && "is-active")} label={t("plugins.search.label-toggle-search-settings")} onClick={() => setShowSettings(value => !value)} />
    </div>
    <div className="search-info-container" style={state.explainSearch ? undefined : HIDDEN}>
      {error ? <div className="search-info">{error}</div> : explanation && <SearchExplanation info={explanation} />}
    </div>
    <div className="search-params" style={showSettings ? undefined : HIDDEN}>
      {toggle(t("plugins.search.label-collapse-results"), "collapseAll")}
      {toggle(t("plugins.search.label-more-context"), "extraContext")}
      {toggle(t("plugins.search.label-explain-search-term"), "explainSearch")}
    </div>
    <div className="search-results-info" style={state.query && parsed.query?.matcher ? undefined : HIDDEN}>
      <div className="clickable-icon search-results-result-count" onClick={menu}>
        <span>{t("plugins.search.label-result-count", { count: totalMatches(results) })}</span>
        <IconEl icon="lucide-more-horizontal" className="more-options-icon" />
      </div>
      <Dropdown value={sortOrder} options={sortOptions} autoWidth onChange={value => setState({ sortOrder: value })} />
    </div>
    <div className={cx("search-result-container mod-global-search node-insert-event", working && "is-loading")} style={{ position: "relative" }} tabIndex={-1} ref={resultsEl}
      onKeyDown={event => {
        if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { resultsEl.current?.querySelector<HTMLElement>(`.search-result-file-match.has-focus .search-result-hover-button.${event.key === "ArrowUp" ? "mod-top" : "mod-bottom"}`)?.click(); event.preventDefault(); }
        else treeKeyDown(event, resultsEl.current, focused, setFocused, RESULT_ROWS);
      }}>
      <ResultTree results={results} actions={actions} collapseAll={state.collapseAll} extraContext={state.extraContext} sortOrder={sortOrder} emptyText={t("plugins.search.label-no-matches")} working={working} focused={focused} onCollapseAll={collapseAll => setState({ collapseAll })} />
    </div>
    {suggest && createPortal(<div className="suggestion-container mod-search-suggestion" style={{ left: `${suggest.box.left}px`, top: `${suggest.box.top}px`, width: `${suggest.box.width}px` }} onMouseDown={event => event.preventDefault()}>
      <div className="suggestion">
        {suggest.items.map((item, index) => <div key={`${item.type}:${item.name}`} className={cx("suggestion-item mod-complex search-suggest-item", item.type === "group" && "mod-group", index === suggest.selected && "is-selected")}
          onMouseMove={() => { if (suggest.selected !== index) setSuggest(current => current && { ...current, selected: index }); }} onClick={event => { event.preventDefault(); choose(item, event.shiftKey); }}>
          <div className="suggestion-content">
            <div className={cx("suggestion-title", item.type === "group" && "list-item-part mod-extended")}><span>{item.name}</span>{item.type === "operator" && <span className="search-suggest-info-text">{item.info}</span>}</div>
          </div>
          <div className="suggestion-aux">
            {item.type === "group" && <ClickableIcon icon={item.icon} className="list-item-part search-suggest-icon" label={item.tooltip} onClick={event => { event.preventDefault(); event.stopPropagation(); item.action(); refreshSuggest(); }} />}
          </div>
        </div>)}
      </div>
    </div>, holder.current?.ownerDocument.body ?? document.body)}
  </>;
}
const RESULT_ROWS = ".search-result-file-title[data-id], .search-result-file-match[data-id]";
const bookmarkStoreOf = (actions: AppActions): BookmarkStore | null => actions.corePlugins.isEnabled("bookmarks") ? BookmarkStore.current : null;

/** Opens the search view with `term`; with Ctrl/Cmd the term is toggled inside the current query instead. */
function searchFor(actions: AppActions, term: string, toggle: boolean) {
  const current = String((actions.workspace.getLeavesOfType("search")[0]?.view.getState() as { query?: unknown } | undefined)?.query ?? "");
  actions.run(() => actions.openSearch(!toggle || !current ? term : current.includes(term) ? current.replace(term, "").trim() : `${current.trim()} ${term}`));
}

// ---------------------------------------------------------------- Bookmarks

const groupFoldId = (item: BookmarkItem) => `item-${item.ctime}`;
const BOOKMARK_FOLDS = "bookmarks-folds";
/** The bookmark for what a leaf shows, as "Bookmark the active tab..." creates it. */
function bookmarkForLeaf(leaf: WorkspaceLeaf | null): BookmarkItem | null {
  const view = leaf?.view;
  if (!view) return null;
  const type = view.getViewType();
  if (type === "graph") return graphBookmark((view as { getGraphOptions?: () => unknown }).getGraphOptions?.() ?? (view.getState() as { options?: unknown }).options);
  if (type === "search") { const query = (view.getState() as { query?: unknown }).query; return typeof query === "string" && query ? searchBookmark(query) : null; }
  if (view instanceof FileView && view.file) return fileBookmark(view.file.path);
  const url = (view as { url?: unknown }).url;
  return typeof url === "string" && url ? urlBookmark(url, view.getDisplayText()) : null;
}

export function BookmarksPane({ leaf, actions, store }: PaneProps & { store: BookmarkStore }) {
  const t = useT();
  const update = useForceUpdate();
  const [state, setState] = usePaneState(leaf, { showSearch: false, searchQuery: "" });
  const [collapsed, setCollapsedRaw] = useState<Set<string>>(() => { const saved = actions.app.loadLocalStorage(BOOKMARK_FOLDS); return new Set(Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === "string") : []); });
  const setCollapsed = (next: Set<string>) => { setCollapsedRaw(next); actions.app.saveLocalStorage(BOOKMARK_FOLDS, [...next]); };
  const [renaming, setRenaming] = useState<BookmarkItem | null>(null);
  const [place, setPlace] = useState<DropPlace | null>(null);
  const expandTimer = useRef<{ win: Window; timer: number; group: string } | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const selection = useSelection(content, () => { actions.workspace.setActiveLeaf(leaf); content.current?.focus(); });
  const { selected, focused } = selection;
  useEffect(() => store.onChange(update), [store]);
  useVaultRevision(actions);
  const search = navSearch(state, setState), filter = useFilter(state.showSearch, state.searchQuery);
  const activePath = actions.activeFile()?.path ?? null;

  // Rows are addressed by their position in the tree; ids are rebuilt on every render.
  const locations = new Map<string, BookmarkLocation>();
  const idOf = (location: BookmarkLocation) => location.join("-");
  const itemOf = (id: string | null) => id !== null && locations.has(id) ? store.itemAt(locations.get(id)!) : null;
  const displayed = (item: BookmarkItem) => item.type !== "file" || !!actions.vault.getAbstractFileByPath(item.path ?? "");
  const titlePath = (location: BookmarkLocation) => location.map((_part, index) => bookmarkTitle(store.itemAt(location.slice(0, index + 1))!)).join("/");
  const passes = (item: BookmarkItem, location: BookmarkLocation): boolean => !filter || (displayed(item) && !!filter.matchContent(titlePath(location))) || (item.type === "group" && store.children(item).some((child, index) => passes(child, [...location, index])));
  const groups = store.groups();
  const allCollapsed = groups.length > 0 && groups.every(group => collapsed.has(groupFoldId(group.item)));

  const icon = (item: BookmarkItem) => item.type === "file" ? (item.path?.endsWith(".canvas") ? "lucide-layout-dashboard" : item.subpath?.startsWith("#^") ? "lucide-toy-brick" : item.subpath?.startsWith("#") ? "lucide-heading" : "lucide-file")
    : item.type === "folder" ? "lucide-folder" : item.type === "search" ? "lucide-search" : item.type === "graph" ? "lucide-git-fork" : item.type === "url" ? "lucide-globe-2" : "lucide-bookmark";
  const openInLeaf = async (item: BookmarkItem, target: OpenTarget) => {
    if (item.type === "file" && item.path) await actions.workspace.openLinkText(item.path + (item.subpath ?? ""), "", target);
    else if (item.type === "graph") await actions.openBookmark(item, target);
  };
  const open = (item: BookmarkItem, target: OpenTarget, focusPaneAfter = false) => actions.run(async () => {
    if (item.type === "file" || item.type === "graph") await openInLeaf(item, target);
    else if (item.type === "url" && item.url && /^https?:/i.test(item.url)) window.open(item.url, "_blank", "noopener,noreferrer");
    else if (item.type === "folder" && item.path) { const folder = actions.vault.getAbstractFileByPath(item.path); if (folder) await revealInExplorer(actions, folder); }
    else if (item.type === "search" && item.query) searchFor(actions, item.query, !!target);
    if (focusPaneAfter) { actions.workspace.setActiveLeaf(leaf); content.current?.focus(); }
  });
  const openAll = (items: BookmarkItem[], target: OpenTarget) => actions.run(async () => { let first = true; for (const item of items.filter(entry => entry.type === "file" || entry.type === "graph")) { await openInLeaf(item, first ? target : "tab"); first = false; } });
  const newGroup = (parent: BookmarkLocation = []) => {
    const group = groupBookmark();
    store.add(group, parent);
    const created = store.itemAt([...parent, (parent.length ? store.children(store.itemAt(parent)!) : store.items).length - 1]);
    if (parent.length) { const next = new Set(collapsed); if (next.delete(groupFoldId(store.itemAt(parent)!))) setCollapsed(next); }
    setRenaming(created);
  };
  const addActive = (group: BookmarkLocation = []) => { const item = bookmarkForLeaf(actions.workspace.getMostRecentLeaf()); if (item) openBookmarkDialog(actions.app, store, item, { group }); };
  const removeSelected = () => { const doomed = (selected.size ? [...selected] : focused ? [focused] : []).map(id => locations.get(id)).filter((location): location is BookmarkLocation => !!location); if (doomed.length) { store.removeMany(doomed); selection.clear(); } };

  const itemMenu = (location: BookmarkLocation, item: BookmarkItem, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation();
    const menu = new Menu().setParentElement(event.currentTarget).addSections(["title", "open", "action", "view", "info", "", "danger"]), id = idOf(location);
    const openItems = (run: (target: OpenTarget) => void) => {
      menu.addItem(entry => entry.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(() => run("tab")));
      menu.addItem(entry => entry.setSection("open").setTitle(t("interface.menu.open-to-the-right")).setIcon("lucide-separator-vertical").onClick(() => run("split")));
      menu.addItem(entry => entry.setSection("open").setTitle(t("interface.menu.open-in-new-window")).setIcon("lucide-picture-in-picture-2").onClick(() => run("window")));
    };
    if (selected.size > 1 && selected.has(id)) {
      const items = [...selected].map(itemOf).filter((entry): entry is BookmarkItem => !!entry);
      openItems(target => openAll(items, target));
      menu.addItem(entry => entry.setSection("danger").setTitle(t("plugins.bookmarks.menu-opt-remove")).setIcon("lucide-trash-2").onClick(removeSelected));
      actions.workspace.trigger("bookmarks:bookmarks-menu", menu, items);
    } else {
      if (item.type === "group") openItems(target => openAll(store.children(item), target));
      else if (item.type === "file" || item.type === "graph") openItems(target => open(item, target));
      menu.addItem(entry => entry.setSection("action").setTitle(t("plugins.bookmarks.menu-opt-rename")).setIcon("lucide-pencil").onClick(() => setRenaming(item)));
      if (item.type === "group") {
        menu.addItem(entry => entry.setSection("action").setTitle(t("plugins.bookmarks.action-new-bookmark")).setIcon("lucide-bookmark-plus").onClick(() => addActive(location)));
        menu.addItem(entry => entry.setSection("action").setIcon("lucide-folder-plus").setTitle(t("plugins.bookmarks.action-new-group")).onClick(() => newGroup(location)));
      } else menu.addItem(entry => entry.setSection("action").setTitle(t("plugins.bookmarks.menu-opt-edit")).setIcon("lucide-wrench").onClick(() => openBookmarkDialog(actions.app, store, item, { location })));
      const target = (item.type === "file" || item.type === "folder") && item.path ? actions.vault.getAbstractFileByPath(item.path) : null;
      if (target) menu.addItem(entry => entry.setSection("view").setTitle(t("plugins.file-explorer.action-reveal-file")).setIcon("lucide-folder-open").onClick(() => actions.run(() => revealInExplorer(actions, target))));
      menu.addItem(entry => entry.setSection("danger").setTitle(t("plugins.bookmarks.menu-opt-remove")).setIcon("lucide-trash-2").onClick(() => store.remove(location)));
      actions.workspace.trigger("bookmarks:bookmarks-menu", menu, [item]);
      selection.setFocused(id);
    }
    menu.showAtMouseEvent(event.nativeEvent);
  };

  // ---- drag and drop
  const droppedItems = (event: React.DragEvent): BookmarkItem[] => {
    const heading = event.dataTransfer.getData(HEADING_DRAG_TYPE);
    if (heading) { try { const data = JSON.parse(heading) as { path: string; heading: string }; return [fileBookmark(data.path, `#${data.heading.replace(/[#|^\\[\]]/g, " ").replace(/\s+/g, " ").trim()}`)]; } catch { return []; } }
    const files = readDraggedPaths(event).map(path => actions.vault.getAbstractFileByPath(path)).filter((file): file is TAbstractFile => !!file);
    return files.filter(file => !files.some(other => other !== file && other instanceof TFolder && file.path.startsWith(`${other.path}/`))).map(file => file instanceof TFolder ? folderBookmark(file.path) : fileBookmark(file.path));
  };
  const accepts = (event: React.DragEvent) => [BOOKMARK_DRAG_TYPE, VAULT_DRAG_TYPE, HEADING_DRAG_TYPE].some(type => event.dataTransfer.types.includes(type));
  const clearExpandTimer = () => { if (expandTimer.current) expandTimer.current.win.clearTimeout(expandTimer.current.timer); expandTimer.current = null; };
  useEffect(() => () => clearExpandTimer(), []);
  useEffect(() => {
    // The reference keeps a pending group expansion after native drag cancellation.
    if (!place) return;
    const group = itemOf(place.id);
    if (!place.inside || group?.type !== "group" || !collapsed.has(groupFoldId(group))) { clearExpandTimer(); return; }
    const key = groupFoldId(group);
    if (expandTimer.current?.group === key) return;
    clearExpandTimer();
    const win = content.current?.ownerDocument.defaultView ?? window;
    const timer = win.setTimeout(() => { expandTimer.current = null; const next = new Set(collapsed); next.delete(key); setCollapsed(next); }, 750);
    expandTimer.current = { win, timer, group: key };
  }, [place?.id, place?.inside, collapsed, store.items]);
  const onDragOver = (event: React.DragEvent) => {
    if (!accepts(event) || !content.current) return;
    event.preventDefault();
    const internal = event.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE);
    event.dataTransfer.dropEffect = internal ? "move" : "copy";
    const next = dropPlace(event, content.current, selected);
    setPlace(next && next.inside && itemOf(next.id)?.type !== "group" ? { ...next, inside: false } : next);
  };
  const onDrop = (event: React.DragEvent) => {
    clearExpandTimer();
    const target = place ?? (content.current ? dropPlace(event, content.current, selected) : null);
    setPlace(null);
    if (!accepts(event) || !target) return;
    event.preventDefault();
    // Resolve the list and index the drop points at.
    const at = target.id !== null ? locations.get(target.id) : undefined, anchor = at ? store.itemAt(at) : null;
    let parent: BookmarkLocation = [], index = store.items.length;
    if (at && anchor) {
      if (anchor.type === "group" && target.placement === "after" && (target.inside || !collapsed.has(groupFoldId(anchor)))) { parent = at; index = 0; }
      else { parent = at.slice(0, -1); index = at[at.length - 1] + (target.placement === "after" ? 1 : 0); }
    } else if (target.placement === "before") index = 0;
    const raw = event.dataTransfer.getData(BOOKMARK_DRAG_TYPE);
    if (raw) {
      // The reference inserts each visible source at the same destination index.
      const sources = (JSON.parse(raw) as BookmarkLocation[]).map(location => store.itemAt(location)).filter((item): item is BookmarkItem => !!item);
      const destination = parent.length ? store.itemAt(parent) : null, same = (a: BookmarkItem, b: BookmarkItem) => a === b || (a.type === b.type && a.ctime === b.ctime && bookmarkTitle(a) === bookmarkTitle(b));
      const selectedItems = [...selected].map(itemOf).filter((item): item is BookmarkItem => !!item), focusedItem = itemOf(focused), anchorItem = itemOf(selection.anchor.current);
      sources.forEach(item => {
        // Moving rebuilds the groups it touches, so both ends are looked up again each time.
        const from = store.find(entry => same(entry, item)), to = destination ? store.find(entry => same(entry, destination)) : [];
        if (from && to && !same(item, destination ?? {} as BookmarkItem)) store.move(from, to, index);
      });
      // Positional row ids change when a drop rebuilds the tree. Keep selection on the same bookmarks.
      const newId = (item: BookmarkItem | null) => { const at = item && store.find(entry => same(entry, item)); return at ? idOf(at) : null; };
      selection.setSelected(new Set(selectedItems.map(newId).filter((id): id is string => id !== null)));
      selection.setFocused(newId(focusedItem)); selection.anchor.current = newId(anchorItem);
    } else droppedItems(event).forEach((item, offset) => store.insert(item, parent, index + offset));
  };
  const dragProps = (location: BookmarkLocation, item: BookmarkItem) => ({
    draggable: renaming !== item,
    onDragStart: (event: React.DragEvent) => {
      event.stopPropagation();
      const id = idOf(location), dragged = selected.size > 1 && selected.has(id)
        ? [...(content.current?.querySelectorAll<HTMLElement>(".tree-item-self[data-id]") ?? [])].filter(row => selected.has(row.dataset.id!)).map(row => locations.get(row.dataset.id!)!).filter(Boolean)
        : [location];
      if (!selected.has(id)) selection.setSelected(new Set([id]));
      event.dataTransfer.setData(BOOKMARK_DRAG_TYPE, JSON.stringify(dragged)); event.dataTransfer.setData("text/plain", bookmarkTitle(item)); event.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => setPlace(null),
  });

  const label = (item: BookmarkItem, location: BookmarkLocation) => <div className="tree-item-inner"><RenameText className="tree-item-inner-text" tag="span" text={bookmarkTitle(item)} editing={renaming === item}
    onDone={value => { setRenaming(null); const clean = value?.trim(); if (clean && clean !== bookmarkTitle(item)) store.update(location, { title: clean }); content.current?.focus(); }} /></div>;
  const renderItems = (items: BookmarkItem[], parent: BookmarkLocation): ReactNode => items.map((item, index) => {
    const location = [...parent, index], id = idOf(location), depth = parent.length;
    locations.set(id, location);
    const shown = passes(item, location), dropInto = place?.inside && place.id === id;
    const classes = cx(focused === id && "has-focus", selected.has(id) && "is-selected", renaming === item && "is-being-renamed", dropInto && "is-being-dragged-over");
    if (item.type === "group") {
      const isCollapsed = collapsed.has(groupFoldId(item));
      const toggle = () => { const next = new Set(collapsed); if (!next.delete(groupFoldId(item))) next.add(groupFoldId(item)); setCollapsed(next); };
      return <div key={`${item.ctime}-${id}`} className={cx("tree-item", isCollapsed && "is-collapsed", !shown && "is-filtered-out")} data-path={titlePath(location)}>
        <div className={cx("tree-item-self bookmark mod-collapsible is-clickable", classes)} data-id={id} ref={indent(depth)} {...dragProps(location, item)}
          onClick={event => { if (renaming === item || selection.click(event, id)) return; toggle(); }} onContextMenu={event => itemMenu(location, item, event)}>
          <CollapseIcon collapsed={isCollapsed} />
          {label(item, location)}
        </div>
        <div className="tree-item-children" style={isCollapsed ? HIDDEN : undefined}>{store.children(item).length > 0 && <div style={SPACER} />}{renderItems(store.children(item), location)}</div>
      </div>;
    }
    return <div key={`${item.ctime}-${id}`} className={cx("tree-item", !shown && "is-filtered-out")} data-path={titlePath(location)} style={displayed(item) ? undefined : HIDDEN}>
      <div className={cx("tree-item-self bookmark is-clickable", item.type === "file" && !item.subpath && item.path === activePath && "is-active", classes)} data-id={id} ref={indent(depth)} {...dragProps(location, item)}
        onClick={event => { if (renaming === item || selection.click(event, id)) return; open(item, Keymap.isModEvent(event.nativeEvent)); }}
        onAuxClick={event => { if (event.button === 1) open(item, "tab"); }} onContextMenu={event => itemMenu(location, item, event)}
        onPointerOver={event => { if (item.type === "file" && item.path && event.pointerType !== "touch") hoverFile(actions, "bookmarks", item.path + (item.subpath ?? ""), event); }}>
        <IconEl className="tree-item-icon" icon={icon(item)} />
        {label(item, location)}
      </div>
    </div>;
  });
  const anyDisplayed = (items: BookmarkItem[]): boolean => items.some(item => item.type === "group" || displayed(item));
  const tree = renderItems(store.items, []);

  return <>
    <NavHeader search={search}>
      <NavButton icon="lucide-bookmark-plus" label={t("plugins.bookmarks.action-new-bookmark")} onClick={() => addActive()} />
      <NavButton icon="lucide-folder-plus" label={t("plugins.bookmarks.action-new-group")} onClick={() => newGroup()} />
      <NavButton icon={allCollapsed ? "lucide-chevrons-up-down" : "lucide-chevrons-down-up"} label={t(allCollapsed ? "plugins.file-explorer.action-expand-all" : "plugins.bookmarks.action-collapse-all")} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map(group => groupFoldId(group.item))))} />
      <SearchButton search={search} />
    </NavHeader>
    <ViewHeader leaf={leaf} sidedock />
    <div className="view-content node-insert-event" style={{ position: "relative" }} tabIndex={-1} ref={content} onDragOver={onDragOver} onDragLeave={event => { if (entered(event)) setPlace(null); }} onDrop={onDrop}
      onClick={event => { if (event.target === event.currentTarget) selection.clear(); }}
      onContextMenu={event => { if (event.defaultPrevented) return; event.preventDefault(); new Menu().addItem(item => item.setIcon("lucide-folder-plus").setTitle(t("plugins.bookmarks.action-new-group")).onClick(() => newGroup())).showAtMouseEvent(event.nativeEvent); }}
      onKeyDown={event => {
        if (renaming) return;
        if (event.key === "F2" && focused) { const item = itemOf(focused); if (item) { event.preventDefault(); setRenaming(item); } }
        else if (event.key === "Delete") { event.preventDefault(); removeSelected(); }
        else if (event.key === "Escape" && selected.size) { event.preventDefault(); selection.setSelected(new Set()); }
        else treeKeyDown(event, content.current, focused ?? selection.anchor.current, next => {
          selection.setFocused(next);
          if (event.shiftKey && ["ArrowDown", "ArrowUp"].includes(event.key) && next) selection.setSelected(current => new Set([...current, ...(focused ? [focused] : []), next]));
          if (["ArrowDown", "ArrowUp"].includes(event.key) && Keymap.isModEvent(event.nativeEvent)) { const item = itemOf(next); if (item && item.type !== "group") open(item, false, true); }
        });
      }}
      onCopy={event => { const items = (selected.size ? [...selected] : focused ? [focused] : []).map(itemOf).filter(Boolean); if (items.length && !renaming) { event.preventDefault(); event.clipboardData.setData("obsidian/bookmarks", JSON.stringify(items)); } }}
      onCut={event => { const items = (selected.size ? [...selected] : focused ? [focused] : []).map(itemOf).filter(Boolean); if (items.length && !renaming) { event.preventDefault(); event.clipboardData.setData("obsidian/bookmarks", JSON.stringify(items)); removeSelected(); } }}
      onPaste={event => {
        const raw = event.clipboardData.getData("obsidian/bookmarks");
        if (!raw || renaming) return;
        let items: unknown; try { items = JSON.parse(raw); } catch { return; }
        if (!Array.isArray(items)) return;
        event.preventDefault();
        const at = focused ? locations.get(focused) : undefined, parent = at ? (itemOf(focused)?.type === "group" ? at : at.slice(0, -1)) : [];
        for (const item of items as BookmarkItem[]) if (item && typeof item.type === "string") store.add({ ...item, ctime: Date.now() }, parent);
      }}>
      <DropIndicator place={place} />
      <div style={{ minHeight: 0 }}>{store.items.length > 0 && <div style={SPACER} />}{tree}</div>
      {store.invalid ? <div className="pane-empty mod-error"><div>{t("plugins.bookmarks.label-invalid-data")}</div><div>{t("plugins.bookmarks.label-invalid-data-desc")}</div></div>
        : !anyDisplayed(store.items) && <div className="pane-empty bookmarks-pane-empty">{t("plugins.bookmarks.label-no-bookmarks")}</div>}
    </div>
  </>;
}

/** A label that becomes editable in place: Enter or leaving the field accepts, Escape cancels. */
function RenameText({ text, editing, className, tag = "div", children, spellcheck = false, onDone }: { text: string; editing: boolean; className?: string; tag?: "div" | "span"; children?: ReactNode; spellcheck?: boolean; onDone(value: string | null, element?: HTMLElement): void }) {
  const ref = useRef<HTMLElement>(null), done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    done.current = false;
    el.textContent = text; el.focus();
    const selection = el.ownerDocument.getSelection(); selection?.selectAllChildren(el);
  }, [editing]);
  const Tag = tag as "div";
  if (!editing) return <Tag className={className}>{children ?? text}</Tag>;
  const finish = (value: string | null) => { if (done.current) return; done.current = true; onDone(value, ref.current ?? undefined); };
  return <Tag ref={ref as React.RefObject<HTMLDivElement>} className={className} contentEditable suppressContentEditableWarning spellCheck={spellcheck} onClick={event => event.stopPropagation()} onDragStart={event => event.preventDefault()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finish(ref.current?.textContent ?? ""); } else if (event.key === "Escape") { event.preventDefault(); finish(null); } }}
    onBlur={() => finish(ref.current?.textContent ?? "")} />;
}

// ---------------------------------------------------------------- Backlinks and outgoing links

function Section({ title, count, collapsed, onToggle, children, containerStyle }: { title: string; count?: number; collapsed: boolean; onToggle(): void; children: ReactNode; containerStyle?: CSSProperties }) {
  const t = useT();
  return <>
    <div className={cx("tree-item-self is-clickable", collapsed && "is-collapsed")} aria-label={t(collapsed ? "interface.tooltip.click-to-expand" : "interface.tooltip.click-to-collapse")} data-tooltip-position="left" onClick={onToggle}>
      <IconEl tag="span" icon="right-triangle" className={cx("tree-item-icon collapse-icon", collapsed && "is-collapsed")} />
      <div className="tree-item-inner">{title}</div>
      <div className="tree-item-flair-outer"><span className="tree-item-flair" style={collapsed || count === undefined ? HIDDEN : undefined}>{count}</span></div>
    </div>
    <div className="search-result-container" style={collapsed ? HIDDEN : containerStyle}>{children}</div>
  </>;
}

const aliasesOf = (cache: CachedMetadata | null): string[] => {
  const frontmatter = cache?.frontmatter, key = frontmatter ? Object.keys(frontmatter).find(name => /^aliases$/i.test(name)) : undefined, value = key ? frontmatter![key] : null;
  return (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []).map(alias => alias.trim()).filter(Boolean);
};
/** Whether [start, end) lies inside a link, an embed or the frontmatter of the note. */
const insideLink = (cache: CachedMetadata | null, start: number, end: number) => !!cache && ([...(cache.links ?? []), ...(cache.embeds ?? [])].some(link => link.position.start.offset <= start && link.position.end.offset >= end) || (!!cache.frontmatterPosition && cache.frontmatterPosition.start.offset <= start && cache.frontmatterPosition.end.offset >= end));
/** Replaces a plain mention with a link to `target`. */
async function linkMention(actions: AppActions, source: TFile, target: TFile, range: SearchRange): Promise<void> {
  const text = await actions.vault.read(source), mention = text.slice(range[0], range[1]);
  await actions.vault.modify(source, text.slice(0, range[0]) + actions.app.fileManager.generateMarkdownLink(target, source.path, "", mention) + text.slice(range[1]));
}

interface BacklinkState { collapseAll: boolean; extraContext: boolean; sortOrder: SortOrder; showSearch: boolean; searchQuery: string; backlinkCollapsed: boolean; unlinkedCollapsed: boolean }
const DEFAULT_BACKLINK_STATE: BacklinkState = { collapseAll: false, extraContext: false, sortOrder: "alphabetical", showSearch: false, searchQuery: "", backlinkCollapsed: false, unlinkedCollapsed: true };

export function BacklinksPane({ leaf, actions }: PaneProps) {
  const [state, setState] = usePaneState<BacklinkState>(leaf, DEFAULT_BACKLINK_STATE);
  useVaultRevision(actions);
  return <>
    <ViewHeader leaf={leaf} sidedock />
    <div className="view-content"><BacklinksBody actions={actions} file={useBoundFile(leaf, actions)} state={state} setState={setState} /></div>
  </>;
}

/** The linked-mentions panel shown at the end of a note ("backlinks in document"). */
export function EmbeddedBacklinks({ actions, file }: { actions: AppActions; file: TFile | null }) {
  const [state, setState] = useState(DEFAULT_BACKLINK_STATE);
  return <BacklinksBody actions={actions} file={file} state={state} setState={patch => setState(current => ({ ...current, ...patch }))} />;
}

function BacklinksBody({ actions, file, state, setState }: { actions: AppActions; file: TFile | null; state: BacklinkState; setState(patch: Partial<BacklinkState>): void }) {
  const t = useT();
  const revision = useDebounced(useVaultRevision(actions), 100);
  const cache = actions.host.metadataCache;
  const sortOrder = isSortOrder(state.sortOrder) ? state.sortOrder : "alphabetical";
  const search = navSearch(state, setState);
  const settledQuery = useDebounced(state.showSearch ? state.searchQuery : "", 300);
  const filter = useMemo(() => { if (!settledQuery) return null; try { const query = new SearchQuery(settledQuery, false); return query.matcher ? query : null; } catch (reason) { new Notice((reason as Error).message); return null; } }, [settledQuery]);
  const [linked, setLinked] = useState<FileResult[]>([]);
  const [unlinked, setUnlinked] = useState<FileResult[]>([]);
  const unlinkedStarted = useRef(false);
  const unlinkedExtras = useRef(new Set<string>());
  const [working, setWorking] = useState({ linked: false, unlinked: false });
  const passesFilter = (note: TFile, text: string) => !filter || !!filter.match(note, text, cacheOf(actions, note));
  // The initial unlinked scan contains Markdown files; the live queue also accepts later file events.
  useEffect(() => { unlinkedExtras.current.clear(); }, [file?.path, filter]);
  useEffect(() => {
    const add = (file: TAbstractFile) => { if (unlinkedStarted.current && file instanceof TFile && file.extension === "canvas") unlinkedExtras.current.add(file.path); };
    const refs = [actions.vault.on("create", add), actions.vault.on("modify", add)];
    return () => refs.forEach(ref => actions.vault.offref(ref));
  }, [actions]);

  useEffect(() => {
    if (!file) { setLinked([]); return; }
    let cancelled = false;
    setWorking(current => ({ ...current, linked: true }));
    void (async () => {
      const found: FileResult[] = [];
      for (const [sourcePath, targets] of Object.entries(cache.resolvedLinks)) {
        if (sourcePath === file.path || !Object.hasOwn(targets, file.path)) continue;
        const source = actions.vault.getAbstractFileByPath(sourcePath);
        if (!(source instanceof TFile)) continue;
        const text = await readText(actions, source);
        if (cancelled) return;
        if (source.extension === "canvas") {
          if (!passesFilter(source, text)) continue;
          const result: SearchResult = {};
          for (const link of parseCanvasReferences(text)) if (link.position && cache.getFirstLinkpathDest(link.link, source.path)?.path === file.path) {
            const key = `canvas-${link.nodeId}` as const;
            (result[key] ??= []).push([link.position.start.offset, link.position.end.offset]);
          }
          found.push({ file: source, result, content: text });
          continue;
        }
        const metadata = cache.getFileCache(source);
        if (!metadata || !passesFilter(source, text)) continue;
        const content: SearchRange[] = [];
        for (const link of [...(metadata.links ?? []), ...(metadata.embeds ?? [])]) if (cache.getFirstLinkpathDest(parseLinktext(link.link).path || source.path, source.path)?.path === file.path) content.push([link.position.start.offset, link.position.end.offset]);
        if (content.length) found.push({ file: source, result: { content }, content: text });
      }
      if (!cancelled) { setLinked(found); setWorking(current => ({ ...current, linked: false })); }
    })();
    return () => { cancelled = true; };
  }, [file?.path, revision, state.backlinkCollapsed, filter]);

  useEffect(() => {
    if (!file) { setUnlinked([]); return; }
    if (!state.unlinkedCollapsed) unlinkedStarted.current = true;
    if (!unlinkedStarted.current) return;
    let cancelled = false;
    setWorking(current => ({ ...current, unlinked: true }));
    void (async () => {
      const patterns = [file.basename, ...aliasesOf(cache.getFileCache(file))].map(name => new RegExp(wholeWordSource(name), "giu"));
      const found: FileResult[] = [];
      let last = performance.now();
      for (const note of actions.vault.getFiles().filter(note => note.extension === "md" || unlinkedExtras.current.has(note.path))) {
        if (note.path === file.path) continue;
        const text = await readText(actions, note);
        if (cancelled) return;
        if (!passesFilter(note, text)) continue;
        const metadata = cache.getFileCache(note), content: SearchRange[] = [];
        for (const pattern of patterns) { pattern.lastIndex = 0; for (let match = pattern.exec(text); match; match = pattern.exec(text)) { if (!match[0].length) { pattern.lastIndex++; continue; } if (!insideLink(metadata, match.index, match.index + match[0].length)) content.push([match.index, match.index + match[0].length]); } }
        if (content.length) found.push({ file: note, result: { content: content.sort((a, b) => a[0] - b[0] || a[1] - b[1]) }, content: text });
        if (performance.now() - last > 12) { await pause(); if (cancelled) return; last = performance.now(); }
      }
      if (!cancelled) { setUnlinked(found); setWorking(current => ({ ...current, unlinked: false })); }
    })();
    return () => { cancelled = true; };
  }, [file?.path, revision, state.unlinkedCollapsed, filter]);

  return <>
    <NavHeader search={search}>
      <NavButton icon="lucide-list" label={t("plugins.search.label-collapse-results")} active={state.collapseAll} onClick={() => setState({ collapseAll: !state.collapseAll })} />
      <NavButton icon="lucide-move-vertical" label={t("plugins.search.label-more-context")} active={state.extraContext} onClick={() => setState({ extraContext: !state.extraContext })} />
      <NavButton icon="lucide-sort-asc" label={t("plugins.file-explorer.action-change-sort")} onClick={event => showSortMenu(event, FILE_SORT_GROUPS, FILE_SORT_LABELS, sortOrder, order => setState({ sortOrder: order }))} />
      <SearchButton search={search} />
    </NavHeader>
    <div className="backlink-pane node-insert-event" style={{ position: "relative" }}>
      <Section title={t("plugins.backlinks.label-linked-mentions")} count={totalMatches(linked)} collapsed={state.backlinkCollapsed} onToggle={() => setState({ backlinkCollapsed: !state.backlinkCollapsed })}>
        <ResultTree results={linked} actions={actions} collapseAll={state.collapseAll} extraContext={state.extraContext} sortOrder={sortOrder} emptyText={t("plugins.backlinks.label-no-backlinks")} working={working.linked && !linked.length} onCollapseAll={collapseAll => setState({ collapseAll })} />
      </Section>
      <Section title={t("plugins.backlinks.label-unlinked-mentions")} count={unlinkedStarted.current ? totalMatches(unlinked) : undefined} collapsed={state.unlinkedCollapsed} onToggle={() => setState({ unlinkedCollapsed: !state.unlinkedCollapsed })}>
        <ResultTree results={unlinked} actions={actions} collapseAll={state.collapseAll} extraContext={state.extraContext} sortOrder={sortOrder} emptyText={t("plugins.backlinks.label-no-unlinked-mentions")} working={!unlinkedStarted.current || (working.unlinked && !unlinked.length)} separate onCollapseAll={collapseAll => setState({ collapseAll })}
          extra={(result, range) => file && <button className="search-result-file-match-replace-button" onClick={event => { event.preventDefault(); event.stopPropagation(); actions.run(() => linkMention(actions, result.file, file, range)); }}>{t("plugins.backlinks.label-link-button-text")}</button>} />
      </Section>
    </div>
  </>;
}

interface OutgoingLink { key: string; linktext: string; text: string; subtext: string; icon: string; target: TFile | null }
export function OutgoingLinksPane({ leaf, actions }: PaneProps) {
  const t = useT();
  const revision = useDebounced(useVaultRevision(actions), 50);
  const [state, setState] = usePaneState(leaf, { linksCollapsed: false, unlinkedCollapsed: true });
  const file = useBoundFile(leaf, actions);
  const cache = actions.host.metadataCache;
  const [metadataRevision, setMetadataRevision] = useState(0);
  useEffect(() => {
    const update = () => setMetadataRevision(value => value + 1);
    const refs = [cache.on("changed", update), cache.on("resolved", update)];
    return () => refs.forEach(ref => cache.offref(ref));
  }, [cache]);
  const links = useMemo(() => {
    if (!file || file.extension !== "md") return [];
    const metadata = cache.getFileCache(file), seen = new Set<string>(), list: OutgoingLink[] = [];
    const references = [...(metadata?.links ?? []), ...(metadata?.embeds ?? [])].sort((a, b) => a.position.start.offset - b.position.start.offset);
    for (const reference of references) {
      const { path: linkpath, subpath: rawSubpath } = parseLinktext(reference.link), subpath = rawSubpath ? `#${rawSubpath}` : "";
      const destination = cache.getFirstLinkpathDest(linkpath || file.path, file.path), found = destination ? actions.vault.getAbstractFileByPath(destination.path) : null;
      const target = found instanceof TFile ? found : null, key = (target?.path ?? linkpath) + subpath;
      if (seen.has(key)) continue;
      seen.add(key);
      let icon = "lucide-link", text = linkpath, subtext = "";
      if (!target) icon = "lucide-file-plus";
      else if (subpath) {
        const targetCache = cache.getFileCache(target), wanted = rawSubpath.toLowerCase();
        if (rawSubpath.startsWith("^")) { const block = targetCache?.blocks?.[rawSubpath.slice(1)] ?? targetCache?.blocks?.[wanted.slice(1)]; icon = block ? "lucide-layout-list" : "lucide-file-question"; text = block ? block.id : subpath; }
        else { const heading = targetCache?.headings?.find(entry => entry.heading.toLowerCase() === wanted); icon = heading ? "heading-glyph" : "lucide-file-question"; text = heading ? heading.heading : subpath; }
        subtext = linkpath;
      } else if (target.parent && !target.parent.isRoot()) subtext = target.parent.path;
      list.push({ key, linktext: reference.link, text, subtext, icon, target });
    }
    return list;
  }, [file?.path, revision, metadataRevision]);

  const [mentions, setMentions] = useState<{ result: FileResult; targets: Map<number, TFile[]> } | null>(null);
  useEffect(() => {
    if (!file || file.extension !== "md" || state.unlinkedCollapsed) { setMentions(null); return; }
    let cancelled = false;
    void (async () => {
      const text = await readText(actions, file);
      if (cancelled) return;
      const names = new Map<string, TFile[]>();
      const add = (name: string, note: TFile) => { const key = name.toLowerCase(), list = names.get(key) ?? []; if (!list.includes(note)) list.push(note); names.set(key, list); };
      for (const note of actions.vault.getMarkdownFiles()) { if (note.path === file.path) continue; add(note.basename, note); for (const alias of aliasesOf(cache.getFileCache(note))) add(alias, note); }
      const metadata = cache.getFileCache(file), lower = text.toLowerCase(), from = metadata?.frontmatterPosition?.end.offset ?? 0;
      const content: SearchRange[] = [], targets = new Map<number, TFile[]>();
      let last = performance.now();
      for (const [name, notes] of [...names].sort((a, b) => collator.compare(a[0], b[0]))) {
        if (!name) continue;
        const pattern = new RegExp(wholeWordSource(name), "giuy");
        for (let at = lower.indexOf(name, from); at !== -1; at = lower.indexOf(name, at + name.length)) {
          pattern.lastIndex = at;
          if (!pattern.test(text) || insideLink(metadata, at, at + name.length)) continue;
          if (targets.has(at)) targets.get(at)!.push(...notes.filter(note => !targets.get(at)!.includes(note))); else { targets.set(at, [...notes]); content.push([at, at + name.length]); }
        }
        if (performance.now() - last > 12) { await pause(); if (cancelled) return; last = performance.now(); }
      }
      if (!cancelled) setMentions({ result: { file, result: { content }, content: text }, targets });
    })();
    return () => { cancelled = true; };
  }, [file?.path, revision, state.unlinkedCollapsed]);
  const open = (link: OutgoingLink, event: React.MouseEvent) => { if (event.button === 0 || event.button === 1) actions.run(() => actions.workspace.openLinkText(link.linktext, file?.path ?? "", Keymap.isModEvent(event.nativeEvent))); };
  const linkMenu = (link: OutgoingLink, event: React.MouseEvent) => {
    if (link.target) { showFileLinkMenu(actions, link.target, event, false); return; }
    event.preventDefault();
    new Menu().addItem(item => item.setSection("open").setTitle(t("interface.menu.create-file")).setIcon("lucide-file").onClick(clicked => actions.run(() => actions.workspace.openLinkText(link.linktext, file?.path ?? "", Keymap.isModEvent(clicked as MouseEvent))))).showAtMouseEvent(event.nativeEvent);
  };
  const mentionResults = mentions && mentions.result.result.content?.length ? [mentions.result] : [];

  return <>
    <ViewHeader leaf={leaf} sidedock />
    <div className="view-content">
      <div className="outgoing-link-pane node-insert-event" style={{ position: "relative" }}>
        <Section title={t("plugins.outgoing-links.label-links")} count={state.linksCollapsed ? undefined : links.length} collapsed={state.linksCollapsed} onToggle={() => setState({ linksCollapsed: !state.linksCollapsed })}>
          <div style={WIDE_SPACER} />
          {links.map(link => <div key={link.key} className="tree-item-self is-clickable outgoing-link-item" draggable={!!link.target} aria-label={link.target ? undefined : t("plugins.outgoing-links.tooltip-not-created")}
            onDragStart={event => { if (link.target) { event.dataTransfer.setData(VAULT_DRAG_TYPE, JSON.stringify([link.target.path])); event.dataTransfer.setData("text/plain", `[[${link.linktext}]]`); } }}
            onClick={event => open(link, event)} onAuxClick={event => open(link, event)} onContextMenu={event => linkMenu(link, event)} onMouseOver={event => hoverFile(actions, "search", link.linktext, event, file?.path)}>
            <IconEl tag="span" className="tree-item-icon" icon={link.icon} />
            <div className="tree-item-inner"><div className="tree-item-inner-text">{link.text}</div>{link.subtext && <div className="tree-item-inner-subtext">{link.subtext}</div>}</div>
          </div>)}
        </Section>
        <Section title={t("plugins.outgoing-links.label-unlinked-mentions")} count={state.unlinkedCollapsed ? undefined : mentions?.result.result.content?.length ?? 0} collapsed={state.unlinkedCollapsed} onToggle={() => setState({ unlinkedCollapsed: !state.unlinkedCollapsed })}>
          <ResultTree results={mentionResults} actions={actions} collapseAll={false} extraContext={false} sortOrder="alphabetical" emptyText={t("plugins.outgoing-links.label-unlinked-mentions")} working={!mentions} showTitle={false} separate
            extra={(result, range) => <div className="search-result-file-match-destination-file-container">
              {(mentions?.targets.get(range[0]) ?? []).map(target => <div key={target.path} className="search-result-file-match-destination-file" aria-label={`${target.parent && !target.parent.isRoot() ? `${target.path.replace(/\.md$/i, "")}\n\n` : ""}${t("plugins.outgoing-links.tooltip-link-file")}`}
                onClick={event => { event.preventDefault(); event.stopPropagation(); actions.run(() => linkMention(actions, result.file, target, range)); }}>
                <IconEl tag="span" className="search-result-file-match-destination-file-icon" icon="lucide-link" />
                <span className="search-result-file-match-destination-file-name">{target.basename}</span>
              </div>)}
            </div>} />
        </Section>
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------- Tags

type TagSort = "frequency" | "frequencyReverse" | "alphabetical" | "alphabeticalReverse";
const TAG_SORT_GROUPS: TagSort[][] = [["alphabetical", "alphabeticalReverse"], ["frequency", "frequencyReverse"]];
const TAG_SORT_LABELS: Record<TagSort, string> = { alphabetical: "plugins.tag-pane.label-sort-by-name-a-to-z", alphabeticalReverse: "plugins.tag-pane.label-sort-by-name-z-to-a", frequency: "plugins.tag-pane.label-sort-by-frequency-high-to-low", frequencyReverse: "plugins.tag-pane.label-sort-by-frequency-low-to-high" };
const PROPERTY_SORT_LABELS: Record<TagSort, string> = { alphabetical: "plugins.properties.label-sort-by-name-a-to-z", alphabeticalReverse: "plugins.properties.label-sort-by-name-z-to-a", frequency: "plugins.properties.label-sort-by-frequency-high-to-low", frequencyReverse: "plugins.properties.label-sort-by-frequency-low-to-high" };
const isTagSort = (value: unknown): value is TagSort => typeof value === "string" && Object.hasOwn(TAG_SORT_LABELS, value);
const TAG_FOLDS = "tag-pane-fold";

/** Every tag with its number of occurrences; a nested tag also counts towards its parents. Keys keep the commonest spelling. */
function vaultTags(actions: AppActions): Record<string, number> {
  const raw = new Map<string, number>();
  const count = (tag: string): void => {
    if (tag.endsWith("/")) tag = tag.slice(0, -1);
    if (tag.length < 2 || !tag.startsWith("#")) return;
    raw.set(tag, (raw.get(tag) ?? 0) + 1);
    const cut = tag.lastIndexOf("/");
    if (cut > 0) count(tag.slice(0, cut));
  };
  for (const note of actions.vault.getMarkdownFiles()) {
    const cache = actions.host.metadataCache.getFileCache(note);
    if (!cache) continue;
    const frontmatter = cache.frontmatter, key = frontmatter ? Object.keys(frontmatter).find(name => /^tags$/i.test(name)) : undefined, declared = key ? frontmatter![key] : null;
    for (const tag of typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared.filter((entry): entry is string => typeof entry === "string") : []) { const clean = tag.trim(); if (clean && !clean.includes(" ")) count(clean.startsWith("#") ? clean : `#${clean}`); }
    for (const tag of cache.tags ?? []) count(tag.tag);
  }
  const merged = new Map<string, { tag: string; count: number; max: number }>();
  for (const [tag, total] of raw) {
    const entry = merged.get(tag.toLowerCase());
    if (!entry) merged.set(tag.toLowerCase(), { tag, count: total, max: total }); else { entry.count += total; if (total > entry.max) { entry.max = total; entry.tag = tag; } }
  }
  return Object.fromEntries([...merged.values()].map(entry => [entry.tag, entry.count]));
}

interface TagNode { tag: string; count: number; children: TagNode[] }
export function TagPane({ leaf, actions }: PaneProps) {
  const t = useT();
  const revision = useDebounced(useVaultRevision(actions), 50);
  const [state, setState] = usePaneState(leaf, { sortOrder: "frequency" as TagSort, useHierarchy: true, showSearch: false, searchQuery: "" });
  const sortOrder = isTagSort(state.sortOrder) ? state.sortOrder : "frequency";
  const [collapsed, setCollapsedRaw] = useState<Set<string>>(() => { const saved = actions.app.loadLocalStorage(TAG_FOLDS); return new Set(Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === "string") : []); });
  const setCollapsed = (next: Set<string>) => { setCollapsedRaw(next); actions.app.saveLocalStorage(TAG_FOLDS, [...next]); };
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const search = navSearch(state, setState), filter = useFilter(state.showSearch, state.searchQuery);
  const counts = useMemo(() => vaultTags(actions), [revision]);
  const tree = useMemo(() => {
    const nodes = new Map<string, TagNode>(), roots: TagNode[] = [];
    const node = (tag: string): TagNode => { const key = tag.toLowerCase(); let entry = nodes.get(key); if (!entry) { entry = { tag, count: counts[tag] ?? 0, children: [] }; nodes.set(key, entry); } return entry; };
    const place = (tag: string, entry: TagNode) => {
      const cut = tag.lastIndexOf("/");
      if (state.useHierarchy && cut > 0) { const parent = node(tag.slice(0, cut)); if (!parent.children.includes(entry)) parent.children.push(entry); place(tag.slice(0, cut), parent); }
      else if (!roots.includes(entry)) roots.push(entry);
    };
    for (const tag of Object.keys(counts)) node(tag);
    for (const tag of Object.keys(counts)) place(tag, node(tag));
    const byName = (a: TagNode, b: TagNode) => collator.compare(a.tag, b.tag), direction = sortOrder === "frequencyReverse" ? -1 : 1;
    const sorter = sortOrder === "alphabetical" ? byName : sortOrder === "alphabeticalReverse" ? (a: TagNode, b: TagNode) => -byName(a, b) : (a: TagNode, b: TagNode) => a.count === b.count ? byName(a, b) : direction * (b.count - a.count);
    const sortAll = (list: TagNode[]): TagNode[] => { list.sort(sorter); list.forEach(entry => sortAll(entry.children)); return list; };
    return sortAll(roots);
  }, [counts, sortOrder, state.useHierarchy]);
  const passes = (node: TagNode): boolean => !filter || !!filter.matchContent(node.tag) || node.children.some(passes);
  const parents = () => { const all: string[] = []; (function walk(nodes: TagNode[]) { for (const node of nodes) if (node.children.length) { all.push(node.tag.toLowerCase()); walk(node.children); } })(tree); return all; };

  const render = (nodes: TagNode[], depth: number): ReactNode => nodes.map(node => {
    const key = node.tag.toLowerCase(), collapsible = node.children.length > 0, isCollapsed = collapsible && collapsed.has(key);
    const name = node.tag.slice(1), last = name.slice(name.lastIndexOf("/") + 1);
    const toggle = () => { const next = new Set(collapsed); if (!next.delete(key)) next.add(key); setCollapsed(next); };
    return <div key={key} className={cx("tree-item", isCollapsed && "is-collapsed", !passes(node) && "is-filtered-out")}>
      <div className={cx("tree-item-self tag-pane-tag is-clickable", collapsible && "mod-collapsible", focused === key && "has-focus")} data-id={key} ref={indent(depth)} draggable
        onDragStart={event => event.dataTransfer.setData("text/plain", node.tag)}
        onClick={event => { event.stopPropagation(); const mod = !!Keymap.isModEvent(event.nativeEvent); searchFor(actions, `tag:${node.tag}`, mod); if (mod) setFocused(null); }}>
        {collapsible && <IconEl icon="right-triangle" className={cx("tree-item-icon collapse-icon", isCollapsed && "is-collapsed")} onClick={event => { event.preventDefault(); event.stopPropagation(); toggle(); }} />}
        <div className="tree-item-inner"><div className="tree-item-inner-text"><span className="tag-pane-tag-parent">{name.slice(0, name.length - last.length)}</span><span className="tree-item-inner-text">{last}</span></div></div>
        <div className="tree-item-flair-outer"><span className="tag-pane-tag-count tree-item-flair">{node.count}</span></div>
      </div>
      {!isCollapsed && <div className="tree-item-children">{node.children.length > 0 && <div style={SPACER} />}{render(node.children, depth + 1)}</div>}
    </div>;
  });
  return <>
    <NavHeader search={search}>
      <NavButton icon="lucide-sort-asc" label={t("plugins.file-explorer.action-change-sort")} onClick={event => showSortMenu(event, TAG_SORT_GROUPS, TAG_SORT_LABELS, sortOrder, order => setState({ sortOrder: order }), false)} />
      <NavButton icon="lucide-folder-tree" label={t("plugins.tag-pane.action-show-nested-tags")} active={state.useHierarchy} onClick={() => setState({ useHierarchy: !state.useHierarchy })} />
      <ClickableIcon icon="lucide-chevrons-up-down" className="nav-action-button" label={t("plugins.tag-pane.action-expand-all")} aria-disabled={!state.useHierarchy} onClick={() => { setCollapsed(allCollapsed ? new Set() : new Set(parents())); setAllCollapsed(!allCollapsed); }} />
      <SearchButton search={search} />
    </NavHeader>
    <div className="tag-container node-insert-event" style={{ position: "relative" }} tabIndex={-1} ref={container} onClick={() => setFocused(null)} onKeyDown={event => treeKeyDown(event, container.current, focused, setFocused)}>
      <div style={{ minHeight: 0 }}>{tree.length > 0 && <div style={WIDE_SPACER} />}{render(tree, 0)}</div>
      {!tree.length && <div className="pane-empty tag-pane-empty">{t("plugins.tag-pane.label-no-tags")}</div>}
    </div>
  </>;
}

// ---------------------------------------------------------------- Outline

/** Heading text as shown in the outline: Markdown formatting and link syntax removed. */
const plainHeading = (heading: string) => heading.replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2").replace(/(^|[^\\*_])([*_])([^*_]+)\2/g, "$1$3").replace(/`([^`]*)`/g, "$1").replace(/<[^>]+>/g, "").replace(/\\([\\`*_{}[\]()#+.!|-])/g, "$1").trim() || heading;
const withBlankLine = (text: string) => text.endsWith("\n\n") ? text : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
interface OutlineNode { heading: HeadingCache; index: number; path: string; children: OutlineNode[] }

export function OutlinePane({ leaf, actions }: PaneProps) {
  const t = useT();
  const revision = useVaultRevision(actions);
  const [state, setState] = usePaneState(leaf, { followCursor: false, showSearch: false, searchQuery: "" });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [place, setPlace] = useState<DropPlace | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const file = useBoundFile(leaf, actions);
  const search = navSearch(state, setState), filter = useFilter(state.showSearch, state.searchQuery);
  const lastCache = useRef<{ file: TFile | null; cache: CachedMetadata | null }>({ file: null, cache: null });
  let cache: CachedMetadata | null = file && file.extension === "md" ? actions.host.metadataCache.getFileCache(file) : null;
  if (cache || lastCache.current.file !== file) lastCache.current = { file, cache };
  else cache = lastCache.current.cache;
  const headings = cache?.headings ?? [];
  const tree = useMemo(() => {
    const roots: OutlineNode[] = [], stack: OutlineNode[] = [];
    headings.forEach((heading, index) => {
      while (stack.length && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
      const parent = stack[stack.length - 1], node: OutlineNode = { heading, index, path: `${parent?.path ?? ""}#${heading.heading}`, children: [] };
      (parent ? parent.children : roots).push(node); stack.push(node);
    });
    return roots;
  }, [cache, revision]);
  useEffect(() => { setCollapsed(new Set()); setActiveIndex(-1); }, [file?.path]);
  const nodeKey = (node: OutlineNode) => `${node.index}:${node.heading.level}:${node.heading.heading}`;
  const collapsibleKeys = () => { const keys: string[] = []; (function walk(nodes: OutlineNode[]) { for (const node of nodes) { keys.push(nodeKey(node)); walk(node.children); } })(tree); return keys; };
  const allKeys = collapsibleKeys(), allCollapsed = allKeys.length > 0 && allKeys.every(key => collapsed.has(key));

  /** The leaf showing this file: the active file view, else any Markdown view of the file. */
  const ownerLeaf = (): WorkspaceLeaf | null => {
    const isOwner = (candidate: WorkspaceLeaf | null) => !!candidate && candidate.view instanceof FileView && candidate.view.file?.path === file?.path;
    const recent = actions.workspace.getMostRecentLeaf();
    if (isOwner(recent)) return recent;
    let found: WorkspaceLeaf | null = null;
    actions.workspace.iterateRootLeaves(candidate => { if (!found && isOwner(candidate)) found = candidate; });
    return found;
  };
  const jump = (heading: HeadingCache) => actions.run(async () => {
    if (!file) return;
    const owner = ownerLeaf() ?? await actions.openFile(file);
    actions.workspace.setActiveLeaf(owner);
    const view = owner.view as { editor?: Editor; getMode?: () => string; containerEl: HTMLElement };
    const position = { line: heading.position.start.line, ch: 0 };
    if (view.getMode?.() === "preview") {
      const wanted = plainHeading(heading.heading);
      [...view.containerEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].find(el => el.tagName === `H${heading.level}` && (el.dataset.heading === heading.heading || el.textContent?.trim() === wanted))?.scrollIntoView({ block: "start" });
    } else if (view.editor) { view.editor.setCursor(position); view.editor.scrollIntoView({ from: position, to: position }, true); view.editor.focus(); }
  });
  // Reading mode follows the top of the preview; source mode follows the cursor.
  useEffect(() => {
    if (!file) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const view = ownerLeaf()?.view as { editor?: Editor; getMode?: () => string; containerEl: HTMLElement } | undefined;
      const list = actions.host.metadataCache.getFileCache(file)?.headings ?? [];
      if (view?.getMode?.() === "preview") {
        const scroller = view.containerEl.querySelector<HTMLElement>(".markdown-reading-view .markdown-preview-view");
        if (!scroller) return;
        const top = scroller.getBoundingClientRect().top;
        // Only this note's top-level headings count, not headings inside embeds.
        const rendered = [...scroller.querySelectorAll<HTMLElement>(".markdown-preview-sizer > .el-h1, .markdown-preview-sizer > .el-h2, .markdown-preview-sizer > .el-h3, .markdown-preview-sizer > .el-h4, .markdown-preview-sizer > .el-h5, .markdown-preview-sizer > .el-h6")];
        let index = list[0]?.position.end.line === 0 ? 0 : -1;
        rendered.forEach((section, at) => { if (section.getBoundingClientRect().top <= top) index = at; });
        setActiveIndex(index);
        return;
      }
      const editor = view?.editor;
      if (!editor) { setActiveIndex(-1); return; }
      const line = editor.getCursor("head").line;
      let index = -1;
      for (let at = 0; at < list.length && list[at].position.start.line <= line; at++) index = at;
      setActiveIndex(index);
    };
    const request = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const doc = content.current?.ownerDocument ?? document;
    doc.addEventListener("selectionchange", request);
    const onScroll = (event: Event) => { if ((event.target as Element | null)?.classList?.contains("markdown-preview-view")) request(); };
    doc.addEventListener("scroll", onScroll, true);
    const refs = [actions.workspace.on("editor-change", request), actions.workspace.on("active-leaf-change", request), actions.workspace.on("file-open", request), actions.workspace.on("layout-change", request), actions.workspace.on("markdown-scroll", request)];
    request();
    return () => { cancelAnimationFrame(frame); doc.removeEventListener("selectionchange", request); doc.removeEventListener("scroll", onScroll, true); refs.forEach(ref => actions.workspace.offref(ref)); };
  }, [file?.path, revision]);
  useEffect(() => { if (state.followCursor && activeIndex >= 0) content.current?.querySelector<HTMLElement>(".tree-item-self.is-active")?.scrollIntoView({ block: "nearest" }); }, [activeIndex, state.followCursor]);

  /** Moves a heading with everything under it to before the heading at `target` (or to the end). */
  const moveHeading = (from: number, target: number) => actions.run(async () => {
    const dragged = headings[from], anchor = headings[target];
    if (!file || !dragged || from === target) return;
    let after = from + 1;
    while (after < headings.length && headings[after].level > dragged.level) after++;
    const start = dragged.position.start.offset;
    let end = after < headings.length ? headings[after].position.start.offset : -1, to = anchor ? anchor.position.start.offset : -1;
    const beyond = Math.max(start, end, to) + 1;
    if ((to === -1 ? beyond : to) >= start && (to === -1 ? beyond : to) <= (end === -1 ? beyond : end)) return;
    const text = await actions.vault.read(file);
    if (end === -1) end = text.length;
    if (to === -1) to = text.length;
    const moved = withBlankLine(text.substring(start, end));
    await actions.vault.modify(file, to < start ? withBlankLine(text.substring(0, to)) + moved + text.substring(to, start) + text.substring(end) : text.substring(0, start) + withBlankLine(text.substring(end, to)) + moved + text.substring(to));
  });
  const accepts = (event: React.DragEvent) => event.dataTransfer.types.includes(HEADING_DRAG_TYPE);
  const onDrop = (event: React.DragEvent) => {
    const target = place ?? (content.current ? dropPlace(event, content.current) : null);
    setPlace(null);
    if (!accepts(event)) return;
    event.preventDefault();
    let data: { path?: string; index?: number };
    try { data = JSON.parse(event.dataTransfer.getData(HEADING_DRAG_TYPE)); } catch { return; }
    if (data.path !== file?.path || typeof data.index !== "number" || !target) return;
    const row = target.id === null ? headings.length : Number(target.id.split(":")[0]);
    moveHeading(data.index, row + (target.id !== null && target.placement === "after" ? 1 : 0));
  };

  const passes = (node: OutlineNode): boolean => !filter || !!filter.matchContent(node.path) || node.children.some(passes);
  const render = (nodes: OutlineNode[], depth: number): ReactNode => nodes.map(node => {
    const key = nodeKey(node), collapsible = node.children.length > 0, isCollapsed = collapsed.has(key), text = plainHeading(node.heading.heading);
    const match = filter?.matchContent(node.heading.heading)?.content ?? null;
    return <div key={key} className={cx("tree-item", isCollapsed && "is-collapsed", !passes(node) && "is-filtered-out")}>
      <div className={cx("tree-item-self is-clickable", collapsible && "mod-collapsible", node.index === activeIndex && "is-active", focused === key && "has-focus")} data-id={key} ref={indent(depth)} draggable
        onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData(HEADING_DRAG_TYPE, JSON.stringify({ path: file?.path, index: node.index, heading: node.heading.heading })); event.dataTransfer.setData("text/plain", node.heading.heading); event.dataTransfer.effectAllowed = "copyMove"; }}
        onDragEnd={() => setPlace(null)}
        onClick={event => { if (event.button === 0 && !event.defaultPrevented) jump(node.heading); }}
        onPointerOver={event => { if (file && event.pointerType !== "touch") hoverFile(actions, "outline", `${file.path}#${node.heading.heading.replace(/[#|^\\[\]]/g, " ").replace(/\s+/g, " ").trim()}`, event); }}>
        {collapsible && <IconEl icon="right-triangle" className={cx("tree-item-icon collapse-icon", isCollapsed && "is-collapsed")} onClick={event => { event.preventDefault(); event.stopPropagation(); setCollapsed(current => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; }); }} />}
        <div className={cx("tree-item-inner", match && "is-match")}>{match && text === node.heading.heading ? fuzzyHighlight(text, match) : text}</div>
      </div>
      {!isCollapsed && <div className="tree-item-children">{node.children.length > 0 && <div style={SPACER} />}{render(node.children, depth + 1)}</div>}
    </div>;
  });
  return <>
    <NavHeader search={search}>
      <SearchButton search={search} />
      <NavButton icon="lucide-gallery-vertical" label={t("plugins.outline.label-follow-cursor")} active={state.followCursor} onClick={() => setState({ followCursor: !state.followCursor })} />
      <NavButton icon={allCollapsed ? "lucide-chevrons-up-down" : "lucide-chevrons-down-up"} label={t(allCollapsed ? "plugins.tag-pane.action-expand-all" : "plugins.tag-pane.action-collapse-all")} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(allKeys))} />
    </NavHeader>
    <ViewHeader leaf={leaf} sidedock />
    <div className="view-content node-insert-event" style={{ position: "relative" }} tabIndex={-1} ref={content} onKeyDown={event => treeKeyDown(event, content.current, focused, setFocused)}
      onDragOver={event => { if (!accepts(event) || !content.current || !headings.length) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; const next = dropPlace(event, content.current); setPlace(next && { ...next, inside: false }); }}
      onDragLeave={event => { if (entered(event)) setPlace(null); }} onDrop={onDrop}>
      <DropIndicator place={place} />
      <div style={{ minHeight: 0 }}>{tree.length > 0 && <div style={SPACER} />}{render(tree, 0)}</div>
      {!headings.length && <div className="pane-empty">{t("plugins.outline.label-no-headings")}</div>}
    </div>
  </>;
}
function fuzzyHighlight(text: string, ranges: SearchRange[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) { if (start > cursor) parts.push(text.substring(cursor, start)); parts.push(<span key={start} className="suggestion-highlight">{text.substring(start, end)}</span>); cursor = end; }
  if (cursor < text.length) parts.push(text.substring(cursor));
  return parts;
}

// ---------------------------------------------------------------- Properties

const BUILT_IN_PROPERTIES: Record<string, PropertyType> = { aliases: "aliases", cssclasses: "multitext", tags: "tags" };
const PROPERTY_TYPES: Array<{ type: PropertyType; icon: string; label: string; reserved?: string }> = [
  { type: "aliases", icon: "lucide-forward", label: "properties.types.option-aliases", reserved: "aliases" }, { type: "checkbox", icon: "lucide-check-square", label: "properties.types.option-checkbox" },
  { type: "date", icon: "lucide-calendar", label: "properties.types.option-date" }, { type: "datetime", icon: "lucide-clock", label: "properties.types.option-datetime" },
  { type: "multitext", icon: "lucide-list", label: "properties.types.option-multitext" }, { type: "number", icon: "lucide-binary", label: "properties.types.option-number" },
  { type: "tags", icon: "lucide-tags", label: "properties.types.option-tags", reserved: "tags" }, { type: "text", icon: "lucide-text", label: "properties.types.option-text" },
];
const UNKNOWN_PROPERTY_TYPE: typeof PROPERTY_TYPES[number] = { type: "unknown", icon: "lucide-file-question", label: "properties.types.option-unknown" };
const typeInfo = (type: string) => PROPERTY_TYPES.find(entry => entry.type === type) ?? UNKNOWN_PROPERTY_TYPE;
interface PropertyEntry { key: string; name: string; count: number; assigned: string | null; inferred: PropertyType }

/** Assigned property types, as stored in `.obsidian/types.json`. */
function usePropertyTypes(actions: AppActions, revision: number): [Record<string, string>, (next: Record<string, string>) => void] {
  const [types, setTypes] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void readPropertyTypes(actions.app).then(next => { if (!cancelled) setTypes(current => JSON.stringify(current) === JSON.stringify(next) ? current : next); });
    const ref = actions.workspace.on("property-types-change", (next: unknown) => { if (!cancelled && next && typeof next === "object" && !Array.isArray(next)) setTypes(next as Record<string, string>); });
    return () => { cancelled = true; actions.workspace.offref(ref); };
  }, [actions, revision]);
  return [types, next => { setTypes(next); actions.run(() => writePropertyTypes(actions.app, next)); }];
}

export function PropertiesPane({ leaf, actions }: PaneProps) {
  return leaf.view.getViewType() === "file-properties" ? <FilePropertiesPane leaf={leaf} actions={actions} /> : <AllPropertiesPane leaf={leaf} actions={actions} />;
}

function AllPropertiesPane({ leaf, actions }: PaneProps) {
  const t = useT();
  const revision = useDebounced(useVaultRevision(actions), 100);
  const [state, setState] = usePaneState(leaf, { sortOrder: "frequency" as TagSort, showSearch: false, searchQuery: "" });
  const sortOrder = isTagSort(state.sortOrder) ? state.sortOrder : "frequency";
  const [types, saveTypes] = usePropertyTypes(actions, revision);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const content = useRef<HTMLDivElement>(null);
  const selection = useSelection(content);
  const { selected, focused } = selection;
  const search = navSearch(state, setState), filter = useFilter(state.showSearch, state.searchQuery);
  const all = useMemo(() => {
    const map = new Map<string, PropertyEntry>();
    const entry = (name: string, value?: unknown) => { const key = name.toLowerCase(); let item = map.get(key); if (!item) { item = { key, name, count: 0, assigned: null, inferred: inferPropertyType(name, value) }; map.set(key, item); } return item; };
    for (const name of Object.keys(BUILT_IN_PROPERTIES)) entry(name);
    for (const note of actions.vault.getMarkdownFiles()) for (const [name, value] of Object.entries(actions.host.metadataCache.getFileCache(note)?.frontmatter ?? {})) if (name !== "position") entry(name, value).count++;
    for (const [name, type] of Object.entries(types)) entry(name).assigned = type;
    for (const [name, type] of Object.entries(BUILT_IN_PROPERTIES)) entry(name).assigned = type;
    return map;
  }, [revision, types]);
  const properties = useMemo(() => {
    const byName = (a: PropertyEntry, b: PropertyEntry) => collator.compare(a.name, b.name), direction = sortOrder === "frequencyReverse" ? -1 : 1;
    return [...all.values()].filter(entry => (entry.count > 0 || entry.assigned) && (!filter || !!filter.matchContent(entry.key)))
      .sort(sortOrder === "alphabetical" ? byName : sortOrder === "alphabeticalReverse" ? (a, b) => -byName(a, b) : (a, b) => a.count === b.count ? collator.compare(a.key, b.key) : direction * (b.count - a.count));
  }, [all, sortOrder, filter]);
  const reserved = (entry: PropertyEntry) => Object.hasOwn(BUILT_IN_PROPERTIES, entry.key);
  const setType = (entries: PropertyEntry[], type: string | null) => { const next = { ...types }; for (const entry of entries) { for (const name of Object.keys(next)) if (name.toLowerCase() === entry.key) delete next[name]; if (type) next[entry.name] = type; } saveTypes(next); };
  /** Rewrites a property in every note that has it; `to` null removes it. */
  const rewrite = async (entry: PropertyEntry, to: string | null) => {
    for (const note of actions.vault.getMarkdownFiles()) {
      const names = Object.keys(actions.host.metadataCache.getFileCache(note)?.frontmatter ?? {}).filter(name => name.toLowerCase() === entry.key);
      if (!names.length) continue;
      await actions.app.fileManager.processFrontMatter(note, frontmatter => {
        for (const name of Object.keys(frontmatter).filter(candidate => candidate.toLowerCase() === entry.key)) {
          const value = frontmatter[name];
          const ordered = Object.entries(frontmatter);
          delete frontmatter[name];
          if (to === null) continue;
          const existing = Object.keys(frontmatter).find(candidate => candidate.toLowerCase() === to.toLowerCase());
          if (!existing) { for (const key of Object.keys(frontmatter)) delete frontmatter[key]; for (const [key, item] of ordered) frontmatter[key === name ? to : key] = item; }
          else if (Array.isArray(frontmatter[existing]) && Array.isArray(value)) frontmatter[existing] = [...new Set([...(frontmatter[existing] as unknown[]), ...value])];
          else frontmatter[existing] = value;
        }
      });
    }
    const next = { ...types };
    for (const name of Object.keys(next)) if (name.toLowerCase() === entry.key) { if (to !== null && !Object.keys(next).some(other => other.toLowerCase() === to.toLowerCase())) next[to] = next[name]; delete next[name]; }
    if (JSON.stringify(next) !== JSON.stringify(types)) saveTypes(next);
  };
  const remove = (entries: PropertyEntry[]) => actions.run(async () => {
    setBusy(new Set(entries.map(entry => entry.key)));
    try { for (const entry of entries) if (!reserved(entry)) await rewrite(entry, null); } finally { setBusy(new Set()); selection.clear(); }
  });
  const acceptRename = (entry: PropertyEntry, value: string | null, el: HTMLElement | null) => actions.run(async () => {
    setRenaming(null);
    const next = value?.trim();
    if (value === null || next === entry.name) return;
    if (!next) { if (el) { displayTooltip(el, t("properties.msg-empty-property-name"), { placement: "bottom", classes: ["mod-error"] }); window.setTimeout(hideTooltip, 2000); } return; }
    if (all.has(next.toLowerCase()) && next.toLowerCase() !== entry.key) {
      const answer = await confirmDialog(actions.app, { title: t("plugins.properties.msg-merge-properties-warning", { oldKey: entry.name, newKey: next }), message: [], body: el => { el.textContent = t("plugins.properties.msg-merge-properties-warning-desc", { oldKey: entry.name }); }, cancelFirst: true, cta: t("dialogue.button-save") });
      if (!answer.confirmed) return;
    }
    await rewrite(entry, next);
  });
  const menu = (entry: PropertyEntry, event: React.MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    selection.setFocused(entry.key);
    const menu = new Menu(), many = selected.size > 1 && selected.has(entry.key), targets = many ? properties.filter(item => selected.has(item.key)) : [entry], editable = targets.every(item => !reserved(item));
    if (!many) menu.addItem(item => item.setSection("action").setTitle(t("interface.menu.rename")).setIcon("lucide-edit-3").setDisabled(!editable).onClick(() => setRenaming(entry.key)));
    menu.addItem(item => {
      item.setSection("action.changeType").setTitle(t("properties.option-property-type")).setIcon("lucide-menu");
      const submenu = item.setSubmenu();
      if (editable) submenu.addItem(sub => sub.setIcon("lucide-loader").setTitle(many || entry.assigned ? t("plugins.properties.opt-automatic") : t("plugins.properties.opt-automatic-with-type", { type: t(typeInfo(entry.inferred).label) })).setChecked(!many && !entry.assigned ? true : null).onClick(() => setType(targets, null)));
      for (const type of PROPERTY_TYPES) {
        if (type.reserved && type.reserved !== entry.key) continue;
        submenu.addItem(sub => sub.setTitle(t(type.label)).setIcon(type.icon).setDisabled(!editable).setChecked(!many && entry.assigned === type.type ? true : null).onClick(() => setType(targets, type.type)));
      }
    });
    menu.addItem(item => item.setSection("danger").setTitle(t("plugins.properties.opt-delete-properties", { count: targets.length })).setIcon("lucide-trash-2").setDisabled(!editable).setWarning(true).onClick(() => remove(targets)));
    menu.showAtMouseEvent(event.nativeEvent);
  };
  return <>
    <NavHeader search={search}>
      <NavButton icon="lucide-sort-asc" label={t("plugins.file-explorer.action-change-sort")} onClick={event => showSortMenu(event, TAG_SORT_GROUPS, PROPERTY_SORT_LABELS, sortOrder, order => setState({ sortOrder: order }))} />
      <SearchButton search={search} />
    </NavHeader>
    <ViewHeader leaf={leaf} sidedock />
    <div className="view-content node-insert-event" style={{ position: "relative" }} tabIndex={-1} ref={content} onClick={event => { if (event.target === event.currentTarget) selection.clear(); }}
      onKeyDown={event => {
        if (renaming) return;
        if (event.key === "Delete") { const targets = properties.filter(item => selected.size ? selected.has(item.key) : item.key === focused); if (targets.length) { event.preventDefault(); remove(targets); } }
        else if (event.key === "Escape" && selected.size) { event.preventDefault(); selection.setSelected(new Set()); }
        else treeKeyDown(event, content.current, focused ?? selection.anchor.current, selection.setFocused);
      }}>
      <div>
        <div style={WIDE_SPACER} />
        {properties.map(property => <div className="tree-item" key={property.key}>
          <div className={cx("tree-item-self tappable is-clickable", focused === property.key && "has-focus", selected.has(property.key) && "is-selected", renaming === property.key && "is-being-renamed", busy.has(property.key) && "is-cut")} data-id={property.key} ref={indent(0)}
            onClick={event => { if (renaming === property.key || selection.click(event, property.key)) return; searchFor(actions, `["${property.name}"]`, !!Keymap.isModEvent(event.nativeEvent)); }} onContextMenu={event => menu(property, event)}>
            <IconEl className="tree-item-icon" icon={typeInfo(property.assigned ?? property.inferred).icon} />
            <div className="tree-item-inner"><PropertyName property={property} editing={renaming === property.key} spellcheck={actions.config.get("spellcheck")} onDone={(value, el) => acceptRename(property, value, el)} /></div>
            <div className="tree-item-flair-outer"><span className="tree-item-flair">{property.count}</span></div>
          </div>
        </div>)}
      </div>
      {!properties.length && <div className="pane-empty properties-pane-empty">{t("plugins.properties.label-no-properties")}</div>}
    </div>
  </>;
}
function PropertyName({ property, editing, spellcheck, onDone }: { property: PropertyEntry; editing: boolean; spellcheck: boolean; onDone(value: string | null, el: HTMLElement | null): void }) {
  return <RenameText className="tree-item-inner-text" text={property.name} editing={editing} spellcheck={spellcheck} onDone={(value, element) => onDone(value, element?.closest<HTMLElement>(".tree-item-self") ?? null)} />;
}

/** "File properties": the properties editor of the file the view is bound to. */
function FilePropertiesPane({ leaf, actions }: PaneProps) {
  const t = useT();
  const revision = useVaultRevision(actions);
  const file = useBoundFile(leaf, actions), supported = !!file && file.extension === "md";
  const holder = useRef<HTMLDivElement>(null), target = useRef<TFile | null>(null);
  const [types] = usePropertyTypes(actions, revision);
  const editor = useMemo(() => new PropertiesEditor({
    app: actions.app,
    truncateText: false,
    onShowSource: () => actions.run(async () => { if (target.current) await actions.workspace.getLeaf(false).openFile(target.current, { state: { mode: "source" } }); }),
    onTypeChange: (key, type) => actions.run(() => assignPropertyType(actions.app, key, type)),
    onChange: yaml => {
      const note = target.current;
      if (!note) return;
      actions.run(() => actions.vault.process(note, text => {
        const match = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text), body = match ? text.slice(match[0].length) : text;
        return yaml === null || !yaml.trim() ? body : `---\n${yaml.replace(/\n+$/, "")}\n---\n${body}`;
      }));
    },
    onOpenLink: (link, event) => actions.run(() => actions.workspace.openLinkText(link, target.current?.path ?? "", Keymap.isModEvent(event))),
  }), [actions]);
  useLayoutEffect(() => {
    const next = supported ? file : null;
    if (target.current?.path !== next?.path) editor.blur();
    target.current = next;
  }, [editor, file, supported]);
  useEffect(() => editor.setTypes(types), [editor, types]);
  useLayoutEffect(() => { const el = holder.current; if (!el) return; el.prepend(editor.containerEl); return () => editor.containerEl.remove(); }, [editor]);
  useLayoutEffect(() => { editor.containerEl.style.display = supported ? "" : "none"; }, [editor, supported]);
  useEffect(() => {
    if (!supported || !file) { editor.setSource(null); return; }
    let cancelled = false;
    void actions.vault.cachedRead(file).then(text => {
      if (cancelled) return;
      const match = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
      editor.setSource(match ? match[1] : null);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [file?.path, supported, revision]);
  return <>
    <ViewHeader leaf={leaf} sidedock />
    <div className="view-content" ref={holder} onClick={event => { if (event.target === event.currentTarget) editor.containerEl.focus(); }}>
      <div className="pane-empty" style={supported ? HIDDEN : undefined}>{t("plugins.properties.label-no-properties")}</div>
    </div>
  </>;
}
