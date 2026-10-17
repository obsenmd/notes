import { process } from "../../platforms/platform";
import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ItemView, WorkspaceLeaf, WorkspaceSidedock, WorkspaceSplit, WorkspaceTabs, WorkspaceWindow, type Workspace, type WorkspaceItem } from "../compat/workspace";
import { FileView } from "../compat/file-views";
import { Menu } from "../compat/ui";
import { useT } from "../i18n/react";
import { t } from "../i18n";
import { ClickableIcon, IconEl, cx, useForceUpdate } from "./ui";
import { formatHotkey } from "./hotkeys";

const LEAF_DRAG_TYPE = "application/x-workspace-leaf";

export interface EmptyStateAction { id: string; icon: string; label: string; commandId?: string; onClick: () => void }

export interface WorkspaceHost {
  workspace: Workspace;
  /** Content for views the host renders with React; returning undefined mounts the view's own container. */
  renderLeaf(leaf: WorkspaceLeaf): ReactNode | undefined;
  /** Whether the host renders this leaf's content itself. */
  isHosted(leaf: WorkspaceLeaf): boolean;
  /** Bookmark state for a leaf's header button; null when the view cannot be bookmarked. */
  bookmarkState(leaf: WorkspaceLeaf): { bookmarked: boolean; toggle(): void } | null;
  emptyStateActions(leaf: WorkspaceLeaf): EmptyStateAction[];
  /** Adds view-specific entries to a tab or "More options" menu. */
  extendPaneMenu(menu: Menu, leaf: WorkspaceLeaf, source: "tab-header" | "more-options"): void;
  toggleRightSidebar(): void;
  executeCommand(id: string): void;
}

const HostContext = createContext<WorkspaceHost | null>(null);
export const WorkspaceHostProvider = HostContext.Provider;
export function useWorkspaceHost(): WorkspaceHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("Workspace components need a WorkspaceHostProvider.");
  return host;
}

/** Mount content independently of the pane tree so moving a leaf preserves its DOM. */
export function WorkspaceLeaves() {
  const host = useWorkspaceHost(), leaves: WorkspaceLeaf[] = [];
  host.workspace.iterateAllLeaves(leaf => { leaves.push(leaf); });
  return <>{leaves.map(leaf => {
    let dock: WorkspaceSidedock | null = null;
    for (let node: WorkspaceItem | null = leaf; node; node = node.parent) if (node instanceof WorkspaceSidedock) dock = node;
    const visible = !dock?.collapsed && (leaf.getContainer() instanceof WorkspaceWindow || !!leaf.parent?.isStacked || leaf.parent?.activeLeaf === leaf);
    return <LeafView key={leaf.id} leaf={leaf} visible={visible} sidedock={!!dock} />;
  })}</>;
}

/** Re-renders the caller whenever the pane tree or the active leaf changes. */
export function useWorkspaceLayout(workspace: Workspace): void {
  const update = useForceUpdate();
  useEffect(() => {
    const refs = ["layout-change", "active-leaf-change"].map(event => workspace.on(event, update));
    return () => refs.forEach(ref => workspace.offref(ref));
  }, [workspace]);
}

/** Tab groups that touch the top edge of a pane tree, left to right. */
export function topTabGroups(item: WorkspaceItem): WorkspaceTabs[] {
  if (item instanceof WorkspaceTabs) return [item];
  if (!(item instanceof WorkspaceSplit)) return [];
  const children = item.children.filter(child => !(child instanceof WorkspaceSidedock));
  if (!children.length) return [];
  return item.direction === "vertical" && !(item instanceof WorkspaceSidedock) ? children.flatMap(topTabGroups) : topTabGroups(children[0]);
}

export interface ChromeEdges { topLeft: WorkspaceTabs | null; topRight: WorkspaceTabs | null; top: Set<WorkspaceTabs> }
const EdgesContext = createContext<ChromeEdges>({ topLeft: null, topRight: null, top: new Set() });
export const ChromeEdgesProvider = EdgesContext.Provider;

export function computeChromeEdges(workspace: Workspace): ChromeEdges {
  const groups = [
    ...(workspace.leftSplit && !workspace.leftSplit.collapsed ? topTabGroups(workspace.leftSplit) : []),
    ...topTabGroups(workspace.rootSplit),
    ...(workspace.rightSplit && !workspace.rightSplit.collapsed ? topTabGroups(workspace.rightSplit) : []),
  ];
  return { topLeft: groups[0] ?? null, topRight: groups.at(-1) ?? null, top: new Set(groups) };
}

function containsLeaf(item: WorkspaceItem, leaf: WorkspaceLeaf | null): boolean {
  for (let node: WorkspaceItem | null = leaf; node; node = node.parent) if (node === item) return true;
  return false;
}

function startResize(event: ReactPointerEvent<HTMLHRElement>, previous: WorkspaceItem, next: WorkspaceItem, vertical: boolean, workspace: Workspace) {
  const handle = event.currentTarget, container = handle.parentElement?.parentElement;
  const previousEl = handle.parentElement?.previousElementSibling as HTMLElement | null, nextEl = handle.parentElement;
  if (!container || !previousEl || !nextEl) return;
  event.preventDefault();
  const before = vertical ? previousEl.getBoundingClientRect().width : previousEl.getBoundingClientRect().height;
  const after = vertical ? nextEl.getBoundingClientRect().width : nextEl.getBoundingClientRect().height;
  const totalSize = before + after;
  const totalWeight = (previous.dimension ?? 50) + (next.dimension ?? 50);
  const start = vertical ? event.clientX : event.clientY;
  const doc = handle.ownerDocument;
  doc.body.classList.add("is-grabbing");
  const move = (moveEvent: PointerEvent) => {
    const delta = (vertical ? moveEvent.clientX : moveEvent.clientY) - start;
    const share = Math.max(0.05, Math.min(0.95, (before + delta) / totalSize));
    previous.dimension = totalWeight * share; next.dimension = totalWeight - previous.dimension;
    workspace.trigger("layout-change"); workspace.trigger("resize");
  };
  const stop = () => {
    doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", stop); doc.removeEventListener("pointercancel", stop);
    doc.body.classList.remove("is-grabbing"); workspace.requestSaveLayout();
  };
  doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", stop); doc.addEventListener("pointercancel", stop);
}

const flexStyle = (item: WorkspaceItem): CSSProperties | undefined => item.dimension == null ? undefined : { flexGrow: item.dimension };

export function WorkspaceItemView({ item, sibling, parentVertical }: { item: WorkspaceItem; sibling?: WorkspaceItem; parentVertical?: boolean }) {
  const { workspace } = useWorkspaceHost();
  const handle = <hr className="workspace-leaf-resize-handle tappable" onPointerDown={sibling ? event => startResize(event, sibling, item, parentVertical ?? true, workspace) : undefined} />;
  if (item instanceof WorkspaceTabs) return <TabGroup tabs={item} handle={handle} />;
  if (!(item instanceof WorkspaceSplit)) return null;
  const children = item.children.filter(child => !(child instanceof WorkspaceSidedock));
  const vertical = item.direction === "vertical";
  return <div className={cx("workspace-split", vertical ? "mod-vertical" : "mod-horizontal", item === workspace.rootSplit && "mod-root")} style={flexStyle(item)}>
    {handle}
    {children.map((child, index) => <WorkspaceItemView key={child.id} item={child} sibling={index > 0 ? children[index - 1] : undefined} parentVertical={vertical} />)}
  </div>;
}

function TabGroup({ tabs, handle }: { tabs: WorkspaceTabs; handle: ReactNode }) {
  const host = useWorkspaceHost(), { workspace } = host;
  const t = useT();
  const edges = useContext(EdgesContext);
  const inSidedock = (() => { for (let node: WorkspaceItem | null = tabs; node; node = node.parent) if (node instanceof WorkspaceSidedock) return true; return false; })();
  const onDrop = (event: DragEvent, index: number) => {
    const id = event.dataTransfer.getData(LEAF_DRAG_TYPE);
    if (!id) return;
    event.preventDefault(); event.stopPropagation();
    const dragged = workspace.getLeafById(id);
    if (dragged) { workspace.moveLeafToTabs(dragged, tabs, index); workspace.setActiveLeaf(dragged); }
  };
  const stacked = tabs.isStacked && !inSidedock;
  const container = useRef<HTMLDivElement>(null);
  // Leaf elements belong to the workspace, not to a React tab-group subtree.
  // Reparent only when their order changes; moving a webview unnecessarily can
  // recreate its guest process.
  useLayoutEffect(() => {
    const parent = container.current; if (!parent) return;
    const headers = [...parent.querySelectorAll<HTMLElement>(":scope > .workspace-tab-header")];
    tabs.children.forEach((leaf, index) => {
      if (stacked) {
        const header = headers[index];
        if (header && header.nextElementSibling !== leaf.containerEl) header.after(leaf.containerEl);
      } else if (parent.children[index] !== leaf.containerEl) {
        parent.insertBefore(leaf.containerEl, parent.children[index] ?? null);
      }
    });
  });
  useLayoutEffect(() => {
    const parent = container.current;
    return () => { for (const leaf of tabs.children) if (leaf.containerEl.parentElement === parent) leaf.containerEl.remove(); };
  }, [tabs]);
  const activeIndex = tabs.activeLeaf ? tabs.children.indexOf(tabs.activeLeaf) : 0;
  // Stacked tabs: headers stick to both edges while their panes slide underneath, as in the reference.
  useLayoutEffect(() => {
    const el = container.current; if (!el) return;
    if (!stacked) {
      for (const leaf of tabs.children) Object.assign(leaf.containerEl.style, { left: "", minWidth: "", maxWidth: "" });
      return;
    }
    const layout = () => {
      const headers = [...el.querySelectorAll<HTMLElement>(":scope > .workspace-tab-header")], leaves = [...el.querySelectorAll<HTMLElement>(":scope > .workspace-leaf")];
      const widths = headers.map(header => header.offsetWidth), total = widths.reduce((sum, width) => sum + width, 0);
      const max = Math.max(300, el.clientWidth - total), min = max / Math.max(1, leaves.length);
      let left = 0, right = total;
      headers.forEach((header, index) => {
        header.style.left = left + "px"; left += widths[index]; right -= widths[index]; header.style.right = right + "px";
        const leaf = leaves[index]; if (leaf) Object.assign(leaf.style, { left: left + "px", minWidth: min + "px", maxWidth: max + "px" });
      });
    };
    layout();
    const observer = new ResizeObserver(layout); observer.observe(el);
    return () => observer.disconnect();
  }, [stacked, tabs.children.length]);
  useEffect(() => {
    const el = container.current; if (!el || !stacked) return;
    const headers = [...el.querySelectorAll<HTMLElement>(":scope > .workspace-tab-header")], leaves = [...el.querySelectorAll<HTMLElement>(":scope > .workspace-leaf")];
    const leaf = leaves[activeIndex]; if (!leaf) return;
    let before = 0, headersBefore = 0, headersAfter = 0;
    headers.forEach((header, index) => { if (index <= activeIndex) { headersBefore += header.offsetWidth; before += header.offsetWidth; if (index < activeIndex) before += leaves[index].offsetWidth; } else headersAfter += header.offsetWidth; });
    const min = before + leaf.offsetWidth - el.clientWidth + headersAfter, max = before - headersBefore;
    if (el.scrollLeft < min) el.scrollTo({ behavior: "smooth", left: min }); else if (el.scrollLeft > max) el.scrollTo({ behavior: "smooth", left: max });
  }, [stacked, activeIndex, tabs.children.length]);
  return <div className={cx("workspace-tabs", stacked && "mod-stacked", edges.top.has(tabs) && "mod-top", edges.topLeft === tabs && "mod-top-left-space", edges.topRight === tabs && "mod-top-right-space", containsLeaf(tabs, workspace.activeLeaf) && "mod-active")} style={flexStyle(tabs)}>
    {handle}
    <div className="workspace-tab-header-container" onDragOver={event => { if (event.dataTransfer.types.includes(LEAF_DRAG_TYPE)) event.preventDefault(); }} onDrop={event => onDrop(event, tabs.children.length)}>
      <div className="workspace-tab-header-container-inner" style={{ "--animation-dur": "250ms" } as CSSProperties}>
        {!stacked && tabs.children.map((leaf, index) => <TabHeader key={leaf.id} leaf={leaf} tabs={tabs} onDrop={event => onDrop(event, index)} />)}
      </div>
      <div className="workspace-tab-header-new-tab">
        <ClickableIcon tag="span" icon="lucide-plus" label={t("interface.label-new-tab")} onClick={() => {
          if (tabs.activeLeaf) workspace.setActiveLeaf(tabs.activeLeaf);
          workspace.setActiveLeaf(workspace.getLeaf("tab"));
        }} />
      </div>
      <div className="workspace-tab-header-spacer" />
      <div className="workspace-tab-header-tab-list">
        <ClickableIcon tag="span" icon="lucide-chevron-down" onClick={event => tabListMenu(host, tabs).showAtMouseEvent(event.nativeEvent)} />
      </div>
      {edges.topRight === tabs && <div className="sidebar-toggle-button mod-secondary mod-right" aria-label={t(workspace.rightSplit?.collapsed === false ? "interface.sidebar-collapse" : "interface.sidebar-expand")} onClick={host.toggleRightSidebar}>
        <ClickableIcon icon="sidebar-toggle-button-icon" />
      </div>}
    </div>
    <div className="workspace-tab-container" ref={container}>
      {stacked && tabs.children.map((leaf, index) => <TabHeader key={"header:" + leaf.id} leaf={leaf} tabs={tabs} onDrop={event => onDrop(event, index)} />)}
    </div>
  </div>;
}

function TabHeader({ leaf, tabs, onDrop }: { leaf: WorkspaceLeaf; tabs: WorkspaceTabs; onDrop: (event: DragEvent) => void }) {
  const host = useWorkspaceHost(), { workspace } = host;
  const t = useT();
  const title = leafTitle(leaf);
  return <div className={cx("workspace-tab-header tappable", tabs.activeLeaf === leaf && "is-active", workspace.activeLeaf === leaf && "mod-active")}
    draggable aria-label={title} data-tooltip-delay="300" data-type={leaf.view.getViewType()}
    onDragStart={event => { event.dataTransfer.setData(LEAF_DRAG_TYPE, leaf.id); event.dataTransfer.effectAllowed = "move"; }}
    onDragOver={event => { if (event.dataTransfer.types.includes(LEAF_DRAG_TYPE)) event.preventDefault(); }} onDrop={onDrop}
    onClick={() => workspace.setActiveLeaf(leaf)}
    onAuxClick={event => { if (event.button === 1 && !leaf.pinned) leaf.detach(); }}
    onContextMenu={event => { event.preventDefault(); paneMenu(host, leaf, "tab-header").showAtMouseEvent(event.nativeEvent); }}>
    <div className="workspace-tab-header-inner">
      <IconEl className="workspace-tab-header-inner-icon" icon={leaf.getIcon()} />
      <div className="workspace-tab-header-inner-title">{title}</div>
      <div className="workspace-tab-header-status-container">
        {leaf.pinned && <IconEl className="workspace-tab-header-status-icon mod-pinned" icon="lucide-pin" aria-label={t("interface.menu.unpin")} onClick={event => { event.stopPropagation(); leaf.setPinned(false); }} />}
        {leaf.group && <IconEl className="workspace-tab-header-status-icon mod-linked" icon="lucide-link" />}
      </div>
      <IconEl className="workspace-tab-header-inner-close-button" icon="lucide-x" aria-label={t("interface.menu.close")} onClick={event => { event.stopPropagation(); leaf.detach(); }} />
    </div>
  </div>;
}

export function leafTitle(leaf: WorkspaceLeaf): string {
  return leaf.view.getViewType() === "empty" ? t("interface.label-new-tab") : leaf.getDisplayText();
}

function LeafView({ leaf, visible, sidedock }: { leaf: WorkspaceLeaf; visible: boolean; sidedock: boolean }) {
  const host = useWorkspaceHost(), { workspace } = host;
  const view = leaf.view, type = view.getViewType();
  // Views in background tabs are deferred until first shown, as in the reference.
  const [shown, setShown] = useState(visible);
  if (visible && !shown) setShown(true);
  const hostedType = host.isHosted(leaf);
  const hosted = hostedType ? (shown ? host.renderLeaf(leaf) : null) : undefined;
  const empty = type === "empty";
  const mode = (view as { getMode?: () => string }).getMode?.();
  useLayoutEffect(() => {
    const root = leaf.containerEl, frame = view.containerEl;
    root.classList.toggle("mod-active", workspace.activeLeaf === leaf);
    root.style.display = visible ? "" : "none";
    frame.classList.toggle("node-insert-event", !shown);
    frame.dataset.type = !shown ? "undefined" : type;
    if (mode) frame.dataset.mode = mode; else delete frame.dataset.mode;
    if (frame.parentElement !== root) root.append(frame);
    if (shown && !hostedType && view instanceof ItemView) {
      if (view.headerEl.parentElement !== frame) frame.prepend(view.headerEl);
      if (frame.lastElementChild !== view.contentEl) frame.append(view.contentEl);
    }
  });
  useLayoutEffect(() => {
    const activate = () => { if (workspace.activeLeaf !== leaf) workspace.setActiveLeaf(leaf); };
    leaf.containerEl.addEventListener("pointerdown", activate, true);
    return () => { leaf.containerEl.removeEventListener("pointerdown", activate, true); leaf.containerEl.remove(); };
  }, [leaf, workspace]);
  useEffect(() => { if (visible) view.onResize(); }, [visible, view]);
  return <>
    {createPortal(<hr className="workspace-leaf-resize-handle tappable" />, leaf.containerEl)}
    {hosted !== undefined ? createPortal(hosted, view.containerEl) : shown && view instanceof ItemView && <>
      <ViewHeader leaf={leaf} sidedock={sidedock} containerEl={view.headerEl} />
      {empty && createPortal(<EmptyState leaf={leaf} />, view.contentEl)}
    </>}
  </>;
}

export function ViewHeader({ leaf, sidedock, containerEl }: { leaf: WorkspaceLeaf; sidedock?: boolean; containerEl?: HTMLElement }) {
  const host = useWorkspaceHost();
  const t = useT();
  const actions = useRef<HTMLDivElement>(null);
  const view = leaf.view;
  const file = view instanceof FileView ? view.file : (view as { getBoundFile?: () => FileView["file"] }).getBoundFile?.() ?? null;
  const crumbs = file?.parent && file.parent.path !== "/" && file.parent.path ? file.parent.path.split("/") : [];
  // Actions registered by the view (newest first) sit before the built-in buttons.
  const viewActions = (view as { actionEls?: HTMLElement[] }).actionEls;
  const bookmark = host.bookmarkState(leaf);
  // Some views (the web viewer) replace the title with their own control.
  const customTitle = (view as { headerTitleEl?: HTMLElement }).headerTitleEl, customTitleClass = (view as { headerTitleClass?: string }).headerTitleClass;
  const titleContainer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!customTitle || !titleContainer.current) return;
    titleContainer.current.append(customTitle);
    return () => customTitle.remove();
  }, [customTitle]);
  useLayoutEffect(() => {
    const parent = actions.current;
    if (!parent || !viewActions?.length) return;
    const anchor = parent.querySelector(".view-action:last-child");
    for (const action of [...viewActions].reverse()) parent.insertBefore(action, anchor);
    return () => { for (const action of viewActions) action.remove(); };
  }, [view, viewActions?.length]);
  useLayoutEffect(() => { if (containerEl) containerEl.style.display = sidedock ? "none" : ""; }, [containerEl, sidedock]);
  const contents = <>
    <div className="view-header-left">
      <div className="view-header-nav-buttons">
        <ClickableIcon tag="button" icon="lucide-arrow-left" label={t("commands.navigate-back")} aria-disabled={!leaf.history.backHistory.length} onClick={() => void leaf.history.back()} />
        <ClickableIcon tag="button" icon="lucide-arrow-right" label={t("commands.navigate-forward")} aria-disabled={!leaf.history.forwardHistory.length} onClick={() => void leaf.history.forward()} />
      </div>
    </div>
    {customTitle ? <div className={cx("view-header-title-container mod-at-start mod-at-end", customTitleClass)} ref={titleContainer} /> : <div className="view-header-title-container mod-at-start mod-fade mod-at-end">
      <div className="view-header-title-parent">
        {crumbs.map((crumb, index) => <Fragment key={index}>
          <span className="view-header-breadcrumb">{crumb}</span><span className="view-header-breadcrumb-separator">/</span>
        </Fragment>)}
      </div>
      <div className="view-header-title">{leafTitle(leaf)}</div>
    </div>}
    <div className="view-actions mod-raised" ref={actions}>
      <ClickableIcon tag="button" icon="lucide-bookmark" className={cx("view-action mod-bookmark", bookmark?.bookmarked && "mod-bookmarked mod-filled")} label={t(bookmark?.bookmarked ? "plugins.bookmarks.label-bookmarked" : "plugins.bookmarks.label-bookmark")} style={bookmark?.bookmarked ? undefined : { display: "none" }} onClick={() => bookmark?.toggle()} />
      <ClickableIcon tag="button" icon="lucide-more-vertical" className="view-action" label={t("interface.menu.more-options")} onClick={event => paneMenu(host, leaf, "more-options").showAtMouseEvent(event.nativeEvent)} />
    </div>
  </>;
  return containerEl ? createPortal(contents, containerEl) : <div className="view-header" style={sidedock ? { display: "none" } : undefined}>{contents}</div>;
}

function EmptyState({ leaf }: { leaf: WorkspaceLeaf }) {
  const host = useWorkspaceHost();
  useT();
  const commands = host.workspace.app.commands.commands;
  return <div className="empty-state">
    <div className="empty-state-container">
      <div className="empty-state-title" />
      <div className="empty-state-action-list">
        {host.emptyStateActions(leaf).map(action => {
          const hotkey = action.commandId ? commands.get(action.commandId)?.hotkeys?.[0] : undefined;
          return <div key={action.id} className="text-icon-button tappable mod-pill empty-state-action" role="button" tabIndex={0} aria-label={action.label}
            onClick={action.onClick} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action.onClick(); } }}>
            <IconEl tag="span" className="text-button-icon" icon={action.icon} />
            <span className="text-button-label">{action.label}</span>
            {hotkey && <span className="empty-state-hotkey">{formatHotkey(hotkey)}</span>}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

/** Menu shown for a tab header and for a view's "More options" button. */
export function paneMenu(host: WorkspaceHost, leaf: WorkspaceLeaf, source: "tab-header" | "more-options"): Menu {
  const { workspace } = host;
  const menu = new Menu();
  if (source === "more-options") menu.addSections(["close", "pane", "open", "action", "find", "info", "view", "system", "", "danger"]);
  if (source === "tab-header") {
    menu.addItem(item => item.setSection("close").setTitle(t("interface.menu.close")).setIcon("lucide-x").onClick(() => leaf.detach()));
    const siblings = leaf.parent?.children ?? [];
    if (siblings.length > 1) {
      menu.addItem(item => item.setSection("close").setTitle(t("interface.menu.close-others")).setIcon("lucide-x").onClick(() => { for (const other of [...siblings]) if (other !== leaf && !other.pinned) other.detach(); }));
      const after = siblings.slice(siblings.indexOf(leaf) + 1);
      if (after.length) menu.addItem(item => item.setSection("close").setTitle(t("interface.menu.close-after")).setIcon("lucide-x").onClick(() => { for (const other of after) if (!other.pinned) other.detach(); }));
    }
    menu.addItem(item => item.setSection("pane").setTitle(t(leaf.pinned ? "interface.menu.unpin" : "interface.menu.pin")).setIcon("lucide-pin").onClick(() => leaf.togglePinned()));
    if (leaf.group) menu.addItem(item => item.setSection("pane").setTitle(t("interface.menu.unlink-tab")).setIcon("lucide-unlink").onClick(() => leaf.setGroupMember(null)));
    else menu.addItem(item => item.setSection("pane").setTitle(t("interface.menu.link-tab")).setIcon("lucide-link").onClick(() => workspace.onStartLink(leaf)));
    menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.move-to-new-window")).setIcon("lucide-picture-in-picture").onClick(() => { workspace.moveLeafToPopout(leaf); }));
  }
  menu.addItem(item => item.setSection("open").setTitle(t("commands.split-right")).setIcon("lucide-separator-vertical").onClick(() => { void workspace.duplicateLeaf(leaf, "split", "vertical"); }));
  menu.addItem(item => item.setSection("open").setTitle(t("commands.split-down")).setIcon("lucide-separator-horizontal").onClick(() => { void workspace.duplicateLeaf(leaf, "split", "horizontal"); }));
  host.extendPaneMenu(menu, leaf, source);
  leaf.view.onPaneMenu(menu, source);
  return menu;
}

function tabListMenu(host: WorkspaceHost, tabs: WorkspaceTabs): Menu {
  const { workspace } = host;
  const menu = new Menu().addClass("mod-tab-list");
  menu.addItem(item => item.setSection("tabs").setTitle(t(tabs.isStacked ? "interface.menu.unstack-tabs" : "interface.menu.stack-tabs")).setIcon("lucide-layers").onClick(() => host.executeCommand("workspace:toggle-stacked-tabs")));
  menu.addItem(item => item.setSection("tabs").setTitle(t("plugins.bookmarks.action-bookmark-tab-group", { count: tabs.children.length })).setIcon("lucide-bookmark").onClick(() => host.executeCommand("bookmarks:bookmark-all-tabs")));
  menu.addItem(item => item.setSection("close").setTitle(t("interface.menu.close-all")).setIcon("lucide-x").onClick(() => { for (const leaf of [...tabs.children]) if (!leaf.pinned) leaf.detach(); }));
  for (const leaf of tabs.children) menu.addItem(item => item.setSection("leaves").setTitle(leafTitle(leaf)).setIcon(leaf.getIcon()).setChecked(leaf === tabs.activeLeaf ? true : null).onClick(() => workspace.setActiveLeaf(leaf)));
  return menu;
}
