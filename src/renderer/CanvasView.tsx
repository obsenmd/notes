import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import type { App } from "../compat/plugin";
import { Menu } from "../compat/ui";
import { TFile } from "../compat/vault";
import { brandName } from "../i18n";
import { useT } from "../i18n/react";
import { CanvasCard, colorProps } from "./canvas/cards";
import { CanvasController } from "./canvas/controller";
import { CANVAS_CONFIG, parseHexColor, type CanvasData, type CanvasEdge } from "./canvas/data";
import { ARROW_POINTS, ARROW_ROTATION, CORNERS, SIDES, bboxOf, growBBox, rectOf, type BBox, type ResizeHandle, type Side } from "./canvas/geometry";
import { CanvasHelpModal, modScrollHint, pickAttachment, pickMedia, pickNote } from "./canvas/modals";
import { formatHotkey } from "./hotkeys";
import { ClickableIcon, IconEl, cx } from "./ui";

export { parseCanvas, serializeCanvas } from "./canvas/data";
export type { CanvasData, CanvasEdgeData, CanvasNodeData } from "./canvas/data";
export { CanvasController } from "./canvas/controller";

export interface CanvasViewProps {
  app: App; sourcePath: string; data: CanvasData; onChange(data: CanvasData): void;
  /** The controller of the hosting view; without one the surface keeps its own and follows `data`. */
  controller?: CanvasController;
}

const HANDLES: ResizeHandle[] = [...SIDES, ...CORNERS];
const frameStyle = (box: BBox): CSSProperties => { const rect = rectOf(growBBox(box, 10)); return { transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height }; };

/** The label of a connection, typed in place. */
function EdgeLabel({ ctl, edge, editing }: { ctl: CanvasController; edge: CanvasEdge; editing: boolean }) {
  const t = useT(), ref = useRef<HTMLDivElement>(null);
  const center = ctl.edgeGeometry(edge)?.center, color = colorProps(edge.color);
  useLayoutEffect(() => {
    const label = ref.current;
    if (!label) return;
    if (!editing) { if (label.innerText !== edge.label) label.textContent = edge.label; return; }
    const doc = label.ownerDocument, point = ctl.edgeLabelPoint;
    let range = point ? doc.caretRangeFromPoint(point.x, point.y) : null;
    if (!range) { range = doc.createRange(); range.selectNodeContents(label); }
    const selection = doc.defaultView?.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    label.focus();
    return () => { label.blur(); };
  }, [editing]);
  if (!center) return null;
  const finish = () => {
    if (ctl.edgeLabelEditing !== edge.id) return;
    ctl.edgeLabelEditing = null;
    if (ctl.edgeLabelInitial !== edge.label) ctl.requestSave(); else ctl.host.render();
  };
  return <div className={cx("canvas-path-label-wrapper", color.className)} data-edge={edge.id} style={{ transform: `translate(${center.x}px, ${center.y}px)`, ...color.style }}
    onClick={event => {
      if (ctl.readonly) return;
      if (event.shiftKey) { ctl.toggleSelect(edge.id); return; }
      if (ctl.selection.size === 1 && ctl.selection.has(edge.id)) { if (!editing) ctl.editEdgeLabel(edge.id, { x: event.clientX, y: event.clientY }); } else ctl.selectOnly(edge.id);
    }}>
    <div className={cx("canvas-path-label", editing && "is-editing")} ref={ref} contentEditable={editing} suppressContentEditableWarning data-placeholder={t("plugins.canvas.prompt-add-text")}
      onInput={event => { ctl.patchEdge(edge.id, { label: event.currentTarget.innerText }); ctl.requestSave(false); }} onBlur={finish}
      onKeyDown={event => { if (event.key === "Escape") { finish(); ctl.wrapperEl?.focus(); } event.stopPropagation(); }} />
  </div>;
}

function Resizers({ onResize, onConnect, onDoubleClick }: { onResize(event: PointerEvent, handle: ResizeHandle): void; onConnect?(event: PointerEvent, side: Side): void; onDoubleClick?(handle: ResizeHandle): void }) {
  return <>{HANDLES.map(handle => <div key={handle} className="canvas-node-resizer" data-resize={handle}
    onPointerDown={event => { if (event.target === event.currentTarget && (event.pointerType === "mouse" || !SIDES.includes(handle as Side))) onResize(event.nativeEvent, handle); }}
    onDoubleClick={handle === "bottom" || handle === "right" ? () => onDoubleClick?.(handle) : undefined}>
    {onConnect && SIDES.includes(handle as Side) && <div className="canvas-node-connection-point" data-side={handle} onPointerDown={event => onConnect(event.nativeEvent, handle as Side)} />}
  </div>)}</>;
}

/** The buttons above the selection: remove, colour, zoom, group, arrange, and what the selected card or connection can be edited as. */
function SelectionMenu({ ctl }: { ctl: CanvasController }) {
  const t = useT();
  const items = ctl.selected(), last = items[items.length - 1], single = items.length === 1, readonly = ctl.readonly;
  if (!last) return null;
  const lastNode = last.kind === "node" ? last.node : null, lastEdge = last.kind === "edge" ? last.edge : null;
  const color = (lastNode ?? lastEdge)!.color;
  const edges = items.every(item => item.kind === "edge");
  const direction = lastEdge ? lastEdge.fromEnd === "arrow" ? "lucide-move-horizontal" : lastEdge.toEnd === "none" ? "line-horizontal" : "lucide-arrow-right" : "";
  const file = lastNode?.type === "file" ? ctl.fileOf(lastNode) : null;
  const editable = !!lastNode && (lastNode.type === "text" || lastNode.type === "group" || (file?.extension === "md" && !lastNode.subpath));
  const custom = !["", "1", "2", "3", "4", "5", "6"].includes(color) && parseHexColor(color) ? color : "";
  const tool = (key: string, icon: string, label: string, onClick: (event: React.MouseEvent<HTMLElement>) => void, always = false, active = false) =>
    readonly && !always ? null : <ClickableIcon key={key} tag="button" icon={icon} className={active ? "is-active" : undefined} label={label} data-tooltip-position="top" onClick={onClick} />;
  return <div className="canvas-menu" ref={el => { ctl.menuEl = el; }}>
    {tool("remove", "lucide-trash-2", t("plugins.canvas.action-remove"), () => ctl.deleteSelection())}
    {tool("color", "lucide-palette", t("plugins.canvas.action-set-color"), () => { ctl.submenu = ctl.submenu === "color" ? null : "color"; ctl.host.render(); }, false, ctl.submenu === "color")}
    {tool("zoom", "zoom-to-selection", `${t("plugins.canvas.action-zoom-to-selection")}\n(${formatHotkey({ modifiers: ["Shift"], key: "2" })})`, () => ctl.zoomToSelection(), true)}
    {!single && lastNode && tool("group", "create-group", t("plugins.canvas.action-create-group"), () => ctl.groupSelection())}
    {((!single && lastNode) || (single && lastNode?.type === "group")) && tool("align", "lucide-align-start-vertical", t("plugins.canvas.action-align"), event => ctl.showAlignMenu(event.currentTarget))}
    {lastEdge && edges && tool("direction", direction, t("plugins.canvas.label-line-direction"), event => ctl.showDirectionMenu(event.currentTarget, direction))}
    {single && lastEdge && (lastEdge.label || ctl.edgeLabelEditing === lastEdge.id) && tool("unlabel", "lucide-x-square", t("plugins.canvas.action-remove-label"), () => { ctl.edgeLabelEditing = null; ctl.patchEdge(lastEdge.id, { label: "" }); ctl.requestSave(); })}
    {single && lastEdge && tool("label", "lucide-edit", t("plugins.canvas.action-edit-label"), () => ctl.editEdgeLabel(lastEdge.id))}
    {single && lastNode && editable && tool("edit", "lucide-edit", t(lastNode.type === "group" ? "plugins.canvas.action-edit-label" : "interface.menu.edit"), () => ctl.startEditing(lastNode.id))}
    {single && lastNode?.type === "group" && tool("background", "lucide-image", t(lastNode.background ? "plugins.canvas.action-edit-background" : "plugins.canvas.action-set-background"), event => ctl.showBackgroundMenu(event.currentTarget, lastNode.id))}
    {ctl.submenu === "color" && !readonly && <div className="canvas-submenu">
      {["", "1", "2", "3", "4", "5", "6"].map(preset => <div key={preset} className={cx("canvas-color-picker-item", color === preset && "is-active", preset && `mod-canvas-color-${preset}`)} onClick={() => ctl.setColor(preset)} />)}
      <div className={cx("canvas-color-picker-item canvas-color-picker-custom", custom && "is-active")} style={{ "--canvas-color": custom || "#000000" } as CSSProperties}>
        <input type="color" defaultValue={custom || "#000000"} onInput={event => ctl.setColor(event.currentTarget.value, false)} onChange={event => ctl.setColor(event.currentTarget.value, false)} onBlur={event => ctl.setColor(event.currentTarget.value)} />
      </div>
    </div>}
  </div>;
}

/** Infinite canvas: pan and zoom, cards (text, notes, media, pages, groups) and the connections between them. */
export function CanvasView({ app, sourcePath, data, onChange, controller }: CanvasViewProps) {
  const t = useT();
  const [, force] = useReducer((tick: number) => tick + 1, 0);
  const [revision, setRevision] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null), pattern = useRef<SVGPatternElement>(null);
  const [patternId] = useState(() => "canvas-" + Math.random().toString(36).slice(2));
  const latest = useRef({ sourcePath, onChange }); latest.current = { sourcePath, onChange };
  const emitted = useRef<CanvasData | null>(null), loaded = useRef<string | null>(null);
  const own = useRef<CanvasController | null>(null);
  const ctl = controller ?? (own.current ??= new CanvasController({ app, sourcePath: () => latest.current.sourcePath, onChange: next => { emitted.current = next; latest.current.onChange(next); }, onLocalChange: () => {}, render: () => {} }));

  useLayoutEffect(() => {
    ctl.host.render = force;
    ctl.attach(wrapper.current!, canvas.current!, pattern.current!);
    return () => { ctl.host.render = () => {}; ctl.detach(); };
  }, [ctl]);
  // Without a hosting view the document follows the `data` prop; a new path is a new file.
  useEffect(() => {
    if (controller || data === emitted.current) return;
    ctl.setData(data, loaded.current !== sourcePath); loaded.current = sourcePath;
  }, [controller, data, sourcePath]);
  useEffect(() => {
    const bump = () => setRevision(value => value + 1);
    const refs = [app.vault.on("create", bump), app.vault.on("delete", bump), app.vault.on("rename", bump)];
    return () => refs.forEach(ref => app.vault.offref(ref));
  }, [app]);
  useLayoutEffect(() => { ctl.positionMenu(); });

  const doc = ctl.doc, top = doc.topZ, single = ctl.selection.size === 1, labels = ctl.options.cardLabelVisibility ?? "always";
  const edges = [...doc.edges.values()].filter(edge => edge.id !== ctl.hiddenEdge);
  if (ctl.tempEdge) edges.push(ctl.tempEdge);
  const selectionBox = ctl.selection.size > 1 ? ctl.selectionBBox() : null;
  const hover = ctl.hover && !ctl.readonly ? doc.nodes.get(ctl.hover) : null;
  const text = CANVAS_CONFIG.defaultTextNodeDimensions, file = CANVAS_CONFIG.defaultFileNodeDimensions;
  const fitHeight = (id: string) => {
    // Double-clicking the bottom handle fits a note card to its text.
    const preview = canvas.current?.querySelector<HTMLElement>(`.canvas-node[data-id="${id}"] .markdown-preview-view`), node = doc.nodes.get(id);
    if (!preview || !node) return;
    const sizer = preview.querySelector<HTMLElement>(".markdown-preview-sizer");
    const needed = (sizer?.scrollHeight ?? preview.scrollHeight) + (preview.offsetHeight - (sizer?.offsetHeight ?? preview.clientHeight));
    if (Math.abs(needed - node.height) >= 1) { ctl.patch(id, { height: Math.max(CANVAS_CONFIG.minContainerDimension, needed) }); ctl.requestSave(); }
  };

  return <div className={cx("canvas-wrapper node-insert-event", ctl.dragging && "is-dragging", ctl.readonly && "mod-readonly", ctl.screenshotting && "is-screenshotting", ctl.garbled && "is-text-garbled")} ref={wrapper} tabIndex={-1} data-ignore-swipe="true">
    <svg className="canvas-background"><pattern id={patternId} patternUnits="userSpaceOnUse" ref={pattern}><circle cx="0.7" cy="0.7" r="0.7" /></pattern><rect x="0" y="0" width="100%" height="100%" fill={`url(#${patternId})`} /></svg>
    <div className="canvas-card-menu" style={{ zIndex: top + 1 }}>
      <IconEl className="canvas-card-menu-button mod-draggable" icon="lucide-sticky-note" aria-label={t("plugins.canvas.action-drag-to-add-card")} data-tooltip-position="top"
        onClick={() => { if (!ctl.readonly) ctl.createTextNode({ pos: ctl.posCenter(), position: "center" }); }}
        onPointerDown={event => { if (!ctl.readonly) ctl.dragTempNode(event.nativeEvent, text, pos => { ctl.deselectAll(); ctl.createTextNode({ pos, size: text }); }); }} />
      <IconEl className="canvas-card-menu-button mod-draggable" icon="lucide-file-text" aria-label={t("plugins.canvas.action-drag-to-add-note")} data-tooltip-position="top"
        onClick={() => { if (!ctl.readonly) pickNote(app, sourcePath, chosen => ctl.createFileNode({ pos: ctl.posCenter(), file: chosen })); }}
        onPointerDown={event => { if (!ctl.readonly) ctl.dragTempNode(event.nativeEvent, file, pos => pickNote(app, sourcePath, chosen => ctl.createFileNode({ pos, size: file, file: chosen }))); }} />
      <IconEl className="canvas-card-menu-button mod-draggable" icon="lucide-file-image" aria-label={t("plugins.canvas.action-drag-to-add-media")} data-tooltip-position="top"
        onClick={() => { if (!ctl.readonly) pickMedia(app, chosen => ctl.createFileNode({ pos: ctl.posCenter(), position: "center", file: chosen })); }}
        onPointerDown={event => { if (!ctl.readonly) ctl.dragTempNode(event.nativeEvent, file, pos => pickAttachment(app, sourcePath, chosen => ctl.createFileNode({ pos, size: file, file: chosen }))); }} />
    </div>
    <div className="canvas-controls" style={{ zIndex: top + 1 }}>
      <div className="canvas-control-group mod-raised">
        <IconEl className="canvas-control-item" icon={ctl.readonly ? "lucide-lock" : "lucide-settings"} aria-label={t(ctl.readonly ? "plugins.canvas.label-disable-readonly" : "plugins.canvas.label-canvas-settings")} data-tooltip-position="left"
          onClick={event => {
            if (ctl.readonly) { ctl.toggleReadonly(); return; }
            if (event.currentTarget.classList.contains("has-active-menu")) return;
            const menu = new Menu(); ctl.showQuickSettingsMenu(menu); menu.setParentElement(event.currentTarget).showAtMouseEvent(event.nativeEvent);
          }} />
      </div>
      <div className="canvas-control-group mod-raised">
        <IconEl className="canvas-control-item" icon="lucide-plus" aria-label={t("commands.zoom-in")} data-tooltip-position="left" onClick={() => ctl.zoomBy(CANVAS_CONFIG.zoomMultiplier)} />
        <IconEl className="canvas-control-item" icon="lucide-rotate-cw" aria-label={t("commands.reset-zoom")} data-tooltip-position="left" onClick={() => ctl.zoomBy(-ctl.zoom)} />
        <IconEl className="canvas-control-item" icon="lucide-maximize" aria-label={`${t("plugins.canvas.action-zoom-to-fit")}\n(${formatHotkey({ modifiers: ["Shift"], key: "1" })})`} data-tooltip-position="left" onClick={() => ctl.zoomToFit()} />
        <IconEl className="canvas-control-item" icon="lucide-minus" aria-label={t("commands.zoom-out")} data-tooltip-position="left" onClick={() => ctl.zoomBy(-CANVAS_CONFIG.zoomMultiplier)} />
      </div>
      <div className="canvas-control-group mod-raised">
        <IconEl className={cx("canvas-control-item", !ctl.history.canUndo() && "is-disabled")} icon="lucide-undo-2" aria-label={t("setting.mobile-toolbar.option-undo")} data-tooltip-position="left" onClick={() => ctl.undo()} />
        <IconEl className={cx("canvas-control-item", !ctl.history.canRedo() && "is-disabled")} icon="lucide-redo-2" aria-label={t("setting.mobile-toolbar.option-redo")} data-tooltip-position="left" onClick={() => ctl.redo()} />
      </div>
      <div className="canvas-control-group mod-raised">
        <IconEl className="canvas-control-item" icon="lucide-help-circle" aria-label={t("plugins.canvas.label-canvas-help")} data-tooltip-position="left" onClick={() => new CanvasHelpModal(app, ctl.options.defaultWheelBehavior === "zoom").open()} />
      </div>
    </div>
    <div className={cx("canvas", ctl.connecting && "is-connecting")} ref={canvas}>
      <svg className="canvas-edges">
        {edges.map(edge => {
          const geometry = ctl.edgeGeometry(edge), color = colorProps(edge.color);
          return geometry && <g key={edge.id} className={cx(ctl.selection.has(edge.id) && "is-focused", color.className) || undefined} style={color.style}
            onClick={event => ctl.onEdgeClick(event.nativeEvent, edge.id)} onContextMenu={event => ctl.onEdgeContextMenu(event.nativeEvent, edge.id)} onPointerDown={event => ctl.onEdgePointerdown(event.nativeEvent, edge.id, event.currentTarget)}>
            <path className="canvas-interaction-path" d={geometry.path} /><path className="canvas-display-path" d={geometry.path} />
          </g>;
        })}
      </svg>
      <svg className="canvas-edges">
        {edges.map(edge => {
          const geometry = ctl.edgeGeometry(edge), color = colorProps(edge.color);
          const end = (key: string, at: { x: number; y: number }, side: Side) => <g key={key} style={{ transform: `translate(${at.x}px, ${at.y}px) rotate(${ARROW_ROTATION[side]}deg)` }}><polygon className="canvas-path-end" points={ARROW_POINTS} /></g>;
          return geometry && <g key={edge.id} className={cx(ctl.selection.has(edge.id) && "is-focused", color.className) || undefined} style={color.style}>
            {edge.fromEnd === "arrow" && end("from", geometry.from, edge.fromSide)}{edge.toEnd === "arrow" && end("to", geometry.to, edge.toSide)}
          </g>;
        })}
      </svg>
      {[...doc.nodes.values()].map(node => <CanvasCard key={node.id} ctl={ctl} node={node} sourcePath={sourcePath} revision={revision} readonly={ctl.readonly}
        focused={single && ctl.selection.has(node.id)} selected={!single && ctl.selection.has(node.id)} editing={ctl.editing === node.id} previewing={ctl.editing === node.id && ctl.editingPreview} labelEditing={ctl.labelEditing === node.id}
        lifted={ctl.lifted.has(node.id)} mounted={ctl.contentVisible || ctl.screenshotting} zIndex={ctl.zIndex(node)} labels={labels} />)}
      {edges.filter(edge => edge !== ctl.tempEdge && (edge.label || ctl.edgeLabelEditing === edge.id)).map(edge => <EdgeLabel key={edge.id} ctl={ctl} edge={edge} editing={ctl.edgeLabelEditing === edge.id} />)}
      {hover && <div className="canvas-node-interaction-layer" style={{ transform: `translate(${hover.x}px, ${hover.y}px)`, width: hover.width, height: hover.height, zIndex: top + 1 }}>
        <Resizers onResize={(event, handle) => ctl.onResizePointerdown(event, hover.id, handle)} onConnect={(event, side) => ctl.onConnectionPointerdown(event, hover.id, side)} onDoubleClick={handle => { if (handle === "bottom") fitHeight(hover.id); }} />
      </div>}
      {selectionBox && <div className="canvas-selection mod-group-selection" style={frameStyle(selectionBox)}
        onContextMenu={event => ctl.onSelectionContextMenu(event.nativeEvent)} onPointerDown={event => { if (event.target === event.currentTarget) ctl.onSelectionPointerdown(event.nativeEvent, event.currentTarget); }}>
        <Resizers onResize={(event, handle) => ctl.onSelectionResizePointerdown(event, handle)} />
      </div>}
      {ctl.marquee && <div className="canvas-selection" style={frameStyle(ctl.marquee)} />}
      {ctl.ghosts.map((ghost, index) => <div key={index} className="canvas-node is-dummy is-dragging" style={{ transform: `translate(${Math.round(ghost.x)}px, ${Math.round(ghost.y)}px)`, width: ghost.width, height: ghost.height, zIndex: top + 2 }}><div className="canvas-node-container" /></div>)}
      {ctl.guides.length > 0 && <svg className="canvas-snaps" style={{ zIndex: top + 2 }}>
        {ctl.guides.map((guide, index) => <g key={index}>{guide.points.map((point, at) => <circle key={at} cx={point.x} cy={point.y} r="4" />)}<line x1={guide.line[0].x} y1={guide.line[0].y} x2={guide.line[1].x} y2={guide.line[1].y} /></g>)}
      </svg>}
      {ctl.empty && <div className="canvas-placeholder-message">{t("plugins.canvas.label-drag-from-below")}<br />{t("plugins.canvas.label-space-drag-pan")}<br />{modScrollHint()}</div>}
      {ctl.watermark && <div className="canvas-watermark" style={{ position: "absolute", left: ctl.watermark.x, top: ctl.watermark.y, transform: `translate(0, -100%) scale(${ctl.watermark.scale})`, transformOrigin: "bottom left", display: "flex", whiteSpace: "pre", alignItems: "center", gap: 3, zIndex: 9999999, fontWeight: 600 }}>{brandName()}</div>}
    </div>
    {ctl.selection.size > 0 && !ctl.dragging && <div className="canvas-menu-container" ref={el => { ctl.menuContainerEl = el; }} style={{ zIndex: top + 3 }} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}><SelectionMenu ctl={ctl} /></div>}
    {ctl.holdingSpace && <div className="canvas-mover" style={{ zIndex: top + 4 }} onPointerDown={event => ctl.onMoverPointerdown(event.nativeEvent)} />}
  </div>;
}

/** Whether a vault file can be shown as a canvas. */
export const isCanvasFile = (file: unknown): file is TFile => file instanceof TFile && file.extension === "canvas";
