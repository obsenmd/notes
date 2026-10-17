import { ipcRenderer } from "../../platforms/platform";
import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import type { Workspace, WorkspaceSidedock } from "../compat/workspace";
import { useT } from "../i18n/react";
import { ChromeEdgesProvider, WorkspaceItemView, computeChromeEdges, useWorkspaceLayout } from "./WorkspaceTree";
import { ClickableIcon, IconEl, cx } from "./ui";
import { logoSvg } from "./logo";
import { showAppMenu } from "./app-menu";

const MINIMIZE = '<svg aria-hidden="false" width="12" height="12" viewBox="0 0 12 12"><rect fill="currentColor" width="10" height="1" x="1" y="6"></rect></svg>';
const MAXIMIZE = '<svg aria-hidden="false" width="12" height="12" viewBox="0 0 12 12"><rect width="9" height="9" x="1.5" y="1.5" fill="none" stroke="currentColor"></rect></svg>';
const RESTORE = '<svg aria-hidden="false" width="12" height="12" viewBox="0 0 12 12"><rect width="7" height="7" x="1.5" y="3.5" fill="none" stroke="currentColor"></rect><polyline points="3.5 3.5 3.5 1.5 10.5 1.5 10.5 8.5 8.5 8.5" fill="none" stroke="currentColor"></polyline></svg>';
const CLOSE = '<svg aria-hidden="false" width="12" height="12" viewBox="0 0 12 12"><path fill="currentColor" fill-rule="evenodd" d="M10.052 10.968 1.03 1.93l.849-.848 9.023 9.037-.849.848Z"></path><path fill="currentColor" fill-rule="evenodd" d="M1.023 10.112 10.06 1.09l.848.85-9.037 9.023-.848-.85Z"></path></svg>';
/** The window frame style in effect since launch: "hidden", "custom" or "native" (which has no title bar of ours). */
export const FRAME_STYLE: string = (() => { try { return (ipcRenderer.sendSync("frame") as string) || "hidden"; } catch { return "hidden"; } })();
/** Body classes for the frame style, as the reference sets them. */
export const FRAME_CLASSES = FRAME_STYLE === "native" ? [] : FRAME_STYLE === "hidden" ? ["is-frameless", "is-hidden-frameless"] : ["is-frameless"];
// The full logo shows while the pointer is over the button, the outline otherwise.
const LOGO = logoSvg(18, "full") + logoSvg(18, "wireframe");

/** Frameless window chrome: the drag region, window title and window buttons. */
export function Titlebar({ title, targetWindow = window, maximizable = true }: { title: string; targetWindow?: Window; maximizable?: boolean }) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);
  // Child windows share this renderer, so they are addressed by their title.
  const control = (action: string) => ipcRenderer.invoke("window:control", action, targetWindow === window ? undefined : title) as Promise<{ maximized: boolean } | undefined>;
  useEffect(() => {
    let cancelled = false;
    const refresh = () => void control("state").then(state => { if (!cancelled && state) setMaximized(state.maximized); }).catch(() => undefined);
    refresh(); targetWindow.addEventListener("resize", refresh);
    return () => { cancelled = true; targetWindow.removeEventListener("resize", refresh); };
  }, [targetWindow]);
  useEffect(() => { targetWindow.document.title = title; }, [title, targetWindow]);
  const button = (kind: string, label: string, svg: string, action: string) =>
    <div className={`titlebar-button mod-${kind}`} aria-label={label} onClick={() => void control(action)} dangerouslySetInnerHTML={{ __html: svg }} />;
  if (FRAME_STYLE === "native") return null;
  return <div className="titlebar">
    <div className="titlebar-inner">
      <div className="titlebar-text">{title}</div>
      <div className="titlebar-button-container mod-left">{maximizable && <div className="titlebar-button mod-logo" onMouseDown={event => event.preventDefault()} onClick={showAppMenu} onContextMenu={showAppMenu} dangerouslySetInnerHTML={{ __html: LOGO }} />}</div>
      <div className="titlebar-button-container mod-right">
        {button("minimize", t("interface.window.minimize"), MINIMIZE, "minimize")}
        {maximizable && button("maximize", t(maximized ? "interface.window.restore-down" : "interface.window.maximize"), maximized ? RESTORE : MAXIMIZE, "maximize")}
        {button("close", t("interface.window.close-window"), CLOSE, "close")}
      </div>
    </div>
  </div>;
}

export interface RibbonAction { id: string; icon: string; title: string; onClick: (event: React.MouseEvent) => void }

export interface WorkspaceShellProps {
  workspace: Workspace;
  ribbon: RibbonAction[];
  vaultName: string;
  status: ReactNode;
  onToggleLeft(): void;
  onVaultMenu(event: React.MouseEvent): void;
  onSettings(): void;
  onHelp(): void;
  children?: ReactNode;
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  const { workspace } = props;
  const t = useT();
  useWorkspaceLayout(workspace);
  const edges = computeChromeEdges(workspace);
  const left = workspace.leftSplit, right = workspace.rightSplit;
  const leftOpen = !!left && !left.collapsed, rightOpen = !!right && !right.collapsed;

  const resizeDock = (event: ReactPointerEvent<HTMLHRElement>, dock: WorkspaceSidedock) => {
    event.preventDefault();
    const start = event.clientX, width = dock.dimension ?? 300, direction = dock.side === "left" ? 1 : -1;
    const doc = event.currentTarget.ownerDocument;
    doc.body.classList.add("is-grabbing");
    const move = (moveEvent: PointerEvent) => {
      const next = width + direction * (moveEvent.clientX - start);
      // Dragging well past the minimum width collapses the sidebar, as the reference does.
      if (next < 100) dock.collapsed = true;
      else { dock.collapsed = false; dock.dimension = Math.max(200, Math.min(doc.documentElement.clientWidth - 300, next)); }
      workspace.trigger("layout-change"); workspace.trigger("resize");
    };
    const stop = () => {
      doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", stop); doc.removeEventListener("pointercancel", stop);
      doc.body.classList.remove("is-grabbing"); workspace.requestSaveLayout();
    };
    doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", stop); doc.addEventListener("pointercancel", stop);
  };

  const dock = (side: "left" | "right", value: WorkspaceSidedock | null) => {
    const collapsed = !value || value.collapsed;
    return <div className={cx("workspace-split mod-horizontal mod-sidedock", side === "left" ? "mod-primary-split mod-left-split" : "mod-secondary-split mod-right-split", collapsed && "is-sidedock-collapsed")}
      style={collapsed ? { width: 0, display: "none" } : { width: value.dimension ?? 300 }}>
      <hr className="workspace-leaf-resize-handle tappable" style={collapsed ? { opacity: 0 } : undefined} onPointerDown={value ? event => resizeDock(event, value) : undefined} />
      {side === "left" && <div className="workspace-sidedock-vault-profile">
        <div className="workspace-drawer-vault-switcher" aria-label="" data-tooltip-position="top" onClick={props.onVaultMenu}>
          <IconEl className="workspace-drawer-vault-switcher-icon" icon="lucide-chevrons-up-down" />
          <div className="workspace-drawer-vault-name">{props.vaultName}</div>
        </div>
        <div className="workspace-drawer-vault-actions">
          <ClickableIcon tag="span" icon="help" label={t("interface.help")} onClick={props.onHelp} />
          <ClickableIcon tag="span" icon="lucide-settings" label={t("interface.settings")} onClick={props.onSettings} />
        </div>
      </div>}
      <div className="workspace-sidedock-empty-state" style={value?.children.length ? { display: "none" } : undefined}>
        <p className="u-muted">{t("interface.empty-sidebar")}</p>
      </div>
      {value?.children.map((child, index) => <WorkspaceItemView key={child.id} item={child} sibling={index > 0 ? value.children[index - 1] : undefined} parentVertical={false} />)}
    </div>;
  };

  return <ChromeEdgesProvider value={edges}>
    <div className="app-container">
      <div className="horizontal-main-container">
        <div className={cx("workspace", leftOpen && "is-primary-sidedock-open is-left-sidedock-open", rightOpen && "is-secondary-sidedock-open is-right-sidedock-open")}>
          <div className="workspace-ribbon side-dock-ribbon mod-primary">
            <div className="sidebar-toggle-button mod-primary mod-left" aria-label={t(leftOpen ? "interface.sidebar-collapse" : "interface.sidebar-expand")} data-tooltip-position="right" onClick={props.onToggleLeft}>
              <ClickableIcon icon="sidebar-toggle-button-icon" />
            </div>
            <div className="side-dock-actions">
              {props.ribbon.map(action => <ClickableIcon key={action.id} icon={action.icon} className="side-dock-ribbon-action" label={action.title} data-ribbon-id={action.id} data-icon={action.icon} data-tooltip-position="right" onClick={action.onClick} />)}
            </div>
            <div className="side-dock-settings" />
          </div>
          {dock("left", left)}
          <WorkspaceItemView item={workspace.rootSplit} />
          {dock("right", right)}
          <div className="workspace-ribbon side-dock-ribbon mod-secondary is-collapsed" />
        </div>
      </div>
      <div className="status-bar">{props.status}</div>
      {props.children}
    </div>
  </ChromeEdgesProvider>;
}

/** Window title in the reference format: `<tab> - <vault> - <app> <version>`. */
export function useWindowTitle(workspace: Workspace | undefined, vaultName: string, appName: string, version: string, leafTitle: (workspace: Workspace) => string): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!workspace) return;
    const refs = ["layout-change", "active-leaf-change", "file-open"].map(event => workspace.on(event, () => setTick(tick => tick + 1)));
    return () => refs.forEach(ref => workspace.offref(ref));
  }, [workspace]);
  return [workspace ? leafTitle(workspace) : "", vaultName, `${appName} ${version}`].filter(Boolean).join(" - ");
}
