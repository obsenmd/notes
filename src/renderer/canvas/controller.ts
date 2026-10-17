import { getRemote, process } from "../../../platforms/platform";
import { Keymap } from "../../compat/commands";
import type { App } from "../../compat/plugin";
import { Menu, Notice } from "../../compat/ui";
import { debounce, parseLinktext } from "../../compat/utilities";
import { TFile, TFolder } from "../../compat/vault";
import { t } from "../../i18n";
import { readCorePluginData, writeCorePluginData } from "../core-plugins";
import {
  CANVAS_CONFIG, CanvasDocument, CanvasHistory, DEFAULT_CANVAS_OPTIONS, ZOOM_BREAKPOINT, cloneData, newId, stackOrder,
  type CanvasData, type CanvasEdge, type CanvasNode, type CanvasOptions, type NodeType,
} from "./data";
import {
  OPPOSITE, alignRects, arrangeRects, bboxOf, clamp, containsBBox, distance, distributeRects, edgeGeometry, frameBBox, gridSpacing, growBBox, intersectsBBox, justifyRects,
  nearestAnchor, nudgeDelta, placeRect, pointsBBox, rectOf, resizeRect, sameBBox, sideAnchor, snapGuides, snapMove, unionBBox,
  type Alignment, type Axis, type BBox, type EdgeEnd, type EdgeGeometry, type Point, type Rect, type ResizeHandle, type Side, type Size, type SnapMatch, type SnapOptions,
} from "./geometry";
import { TextPromptModal } from "./dom";
import { BaseViewPicker, CanvasFilePicker, GroupPicker, NarrowPicker, createNoteFromLinktext, pickAttachment, pickImage, pickMedia, pickNote, promptFileName, promptUrl } from "./modals";

const isMac = typeof process !== "undefined" && process.platform === "darwin";
/** Pan easing per millisecond and the fraction of a wheel step that is applied. */
const EASE = 0.984, SETTLED = 0.01, WHEEL_PAN = 0.93;
const YOUTUBE = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)(?:\/(?:[\w\-]+\?(?:.*?\&)*v=|embed\/|v\/)?)([\w\-]+)(?:\??&?(?:t|start)=([0-9]+))?(?:\S+)?$/;
const DUMMY = "\0dummy";

/** Set by the canvas plugin: adds the items every file menu carries (and fires `file-menu`). */
export const canvasHooks: { fileMenu?: (menu: Menu, file: TFile, source: string) => void } = {};

export interface DragHandlers { move?(event: PointerEvent): void; end?(event: PointerEvent | Event): void; cancel?(): void; cleanup?(): void; keydown?(event: KeyboardEvent): void; keyup?(event: KeyboardEvent): void }
/** Follows a pointer from its press: `start` runs once it has moved `threshold` pixels and supplies the handlers. */
export function trackDrag(event: PointerEvent, start: () => DragHandlers | null | undefined | void, threshold = 5): void {
  if (!event.isPrimary) return;
  let handlers: DragHandlers | null | undefined | void = null;
  if (threshold === 0 && !(handlers = start())) return;
  const win = event.view ?? window, origin = { x: event.clientX, y: event.clientY };
  const stop = () => {
    win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); win.removeEventListener("pointercancel", cancel);
    win.removeEventListener("dragstart", end); win.removeEventListener("drop", end); win.removeEventListener("contextmenu", abort);
    window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup);
    handlers?.cleanup?.();
  };
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    if (!handlers) {
      if (distance(origin, { x: next.clientX, y: next.clientY }) < threshold) return;
      if (!(handlers = start())) { stop(); return; }
    }
    handlers.move?.(next);
  };
  const up = (next: PointerEvent) => { if (next.button === event.button && next.pointerId === event.pointerId) { stop(); handlers?.end?.(next); } };
  const cancel = (next: PointerEvent) => { if (next.pointerId === event.pointerId) { stop(); handlers?.cancel?.(); } };
  const end = (next: Event) => { stop(); handlers?.end?.(next); };
  const abort = () => { stop(); handlers?.cancel?.(); };
  const keydown = (next: KeyboardEvent) => { if (next.key === "Escape") { stop(); handlers?.cancel?.(); } handlers?.keydown?.(next); };
  const keyup = (next: KeyboardEvent) => handlers?.keyup?.(next);
  win.addEventListener("pointermove", move); win.addEventListener("pointerup", up); win.addEventListener("pointercancel", cancel);
  win.addEventListener("dragstart", end); win.addEventListener("drop", end); win.addEventListener("contextmenu", abort);
  window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup);
}
/** Swallows the next event of a type on an element (the click that ends a drag). */
export function suppressNext(target: Element, type: string): void {
  const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
  target.addEventListener(type, swallow, { capture: true });
  setTimeout(() => target.removeEventListener(type, swallow, { capture: true }), 0);
}
export const isEditableTarget = (target: EventTarget | null) => {
  const element = target as (Element & { closest?: (selectors: string) => Element | null }) | null;
  return !!element && typeof element.closest === "function" && !!element.closest("input, textarea, select, iframe.embed-iframe, [contenteditable='true'], .cm-editor, .metadata-container, .inline-title");
};
const scrollsInside = (event: WheelEvent, root: Element) => {
  for (let node = event.target as Element | null; node && node !== root; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && ["auto", "scroll"].includes(getComputedStyle(node).overflowY)) return true;
  }
  return false;
};

export interface CanvasHost {
  app: App;
  /** Vault path of the canvas file ("" while none is loaded). */
  sourcePath(): string;
  /** The document changed and should be saved. */
  onChange(data: CanvasData): void;
  /** Per-file local state (read-only mode) changed. */
  onLocalChange(): void;
  /** State changed in a way the surface must re-render. */
  render(): void;
}
export interface CanvasViewState { x: number; y: number; zoom: number }
interface NodeSpec { pos: Point; size?: Size; position?: "center" | Side; save?: boolean; focus?: boolean }
export type Selectable = { kind: "node"; node: CanvasNode } | { kind: "edge"; edge: CanvasEdge };

/** State and behaviour of one canvas: the document, the viewport, the selection and every pointer interaction. */
export class CanvasController {
  readonly doc = new CanvasDocument();
  readonly history = new CanvasHistory<CanvasData>(100);
  /** The document as last saved or loaded; supplies the fields this app does not own. */
  data: Record<string, unknown> = {};
  options: CanvasOptions = { ...DEFAULT_CANVAS_OPTIONS };
  readonly selection = new Set<string>();
  /** Card being edited, and where the edit was started (for placing the cursor). */
  editing: string | null = null;
  editPoint: Point | null = null;
  /** Group whose label is being typed; connection whose label is being typed. */
  labelEditing: string | null = null;
  edgeLabelEditing: string | null = null;
  edgeLabelPoint: Point | null = null;
  readonly = false; dragging = false; connecting = false; holdingSpace = false; screenshotting = false; garbled = false; animating = false;
  empty = true;
  /** Cards drawn with the drag shadow; outline boxes shown while dragging (new cards, clones). */
  readonly lifted = new Set<string>();
  ghosts: Rect[] = [];
  marquee: BBox | null = null;
  guides: ReturnType<typeof snapGuides> = [];
  /** Card under the pointer, which shows the resize and connection handles. */
  hover: string | null = null;
  /** Connection being drawn or re-attached, and the one it stands in for. */
  tempEdge: CanvasEdge | null = null;
  hiddenEdge: string | null = null;
  dummy: Rect = { x: 0, y: 0, width: 0, height: 0 };
  submenu: "color" | null = null;
  watermark: { x: number; y: number; scale: number } | null = null;
  /** Width / height that cards holding a picture or video keep when resized. */
  readonly aspect = new Map<string, number>();

  x = 0; y = 0; zoom = 0; scale = 1; tx = 0; ty = 0; tZoom = 0;
  private zoomCenter: Point | null = null;
  private finishAnimation = false; private zoomToFitQueued = false; private viewportChanged = true; private wasAnimating = false; private pauseAnimation = 0;
  private frame = 0; private frameWin: Window | null = null; private pointerFrame = 0;
  private pointer: Point = { x: 0, y: 0 };
  rect = { left: 0, top: 0, width: 0, height: 0, cx: 0, cy: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  wrapperEl: HTMLElement | null = null; canvasEl: HTMLElement | null = null; patternEl: SVGPatternElement | null = null; menuContainerEl: HTMLElement | null = null; menuEl: HTMLElement | null = null;
  private disposers: Array<() => void> = [];
  private readonly requestPushHistory = debounce((data: CanvasData) => this.pushHistory(data), 250, true);
  private readonly requestFileOpen = debounce((file: TFile | null) => this.updateFileOpen(file), 200);

  constructor(readonly host: CanvasHost) {}
  get app(): App { return this.host.app; }
  private get configDir(): string { const adapter = this.app.vault.adapter as { basePath?: string }; return `${adapter.basePath ?? ""}/${this.app.vault.configDir}`; }

  // ---- Lifecycle ----

  attach(wrapper: HTMLElement, canvas: HTMLElement, pattern: SVGPatternElement): void {
    this.wrapperEl = wrapper; this.canvasEl = canvas; this.patternEl = pattern;
    const win = wrapper.ownerDocument.defaultView ?? window, doc = wrapper.ownerDocument;
    const listen = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K | string, handler: (event: never) => void, options?: AddEventListenerOptions) => {
      target.addEventListener(type, handler as EventListener, options); this.disposers.push(() => target.removeEventListener(type, handler as EventListener, options));
    };
    listen(wrapper, "keydown", (event: KeyboardEvent) => this.onKeydown(event));
    listen(wrapper, "pointerdown", (event: PointerEvent) => this.onPriorityPointerdown(event), { capture: true });
    listen(wrapper, "pointerdown", (event: PointerEvent) => this.onPointerdown(event));
    listen(wrapper, "dblclick", (event: MouseEvent) => this.onDoubleClick(event));
    listen(wrapper, "contextmenu", (event: MouseEvent) => this.onContextMenu(event));
    listen(wrapper, "wheel", (event: WheelEvent) => this.onWheel(event), { passive: false });
    listen(wrapper, "pointermove", (event: PointerEvent) => { if (event.pointerType !== "touch") this.interactionHitTest(event); });
    listen(wrapper, "dragover", (event: DragEvent) => this.onDragOver(event));
    listen(wrapper, "drop", (event: DragEvent) => this.onDrop(event));
    listen(win, "keydown", (event: KeyboardEvent) => this.onGlobalKeydown(event));
    listen(win, "keydown", (event: KeyboardEvent) => { if (event.key === "Escape" && !event.repeat && wrapper.contains(doc.activeElement) && doc.querySelector(".menu")) this.deselectAll(); }, { capture: true });
    listen(win, "keyup", (event: KeyboardEvent) => { if (event.key === " " && this.holdingSpace) { this.holdingSpace = false; this.host.render(); } });
    listen(doc, "copy", (event: ClipboardEvent) => this.handleCopy(event));
    listen(doc, "cut", (event: ClipboardEvent) => this.handleCut(event));
    listen(doc, "paste", (event: ClipboardEvent) => this.handlePaste(event));
    const resize = new ResizeObserver(() => this.onResize()); resize.observe(wrapper); this.disposers.push(() => resize.disconnect());
    const ref = this.app.workspace.on("core-plugin-settings-change", (id: unknown) => { if (id === "canvas") void this.loadOptions(); });
    this.disposers.push(() => this.app.workspace.offref(ref));
    void this.loadOptions();
    this.onResize();
    this.takeFocus();
  }
  /** An opened canvas takes the keyboard focus when its tab is the active one and nothing else holds it (the reference focuses the surface on opening). */
  private takeFocus(): void {
    const attempt = () => {
      const wrapper = this.wrapperEl, active = wrapper?.ownerDocument.activeElement;
      if (wrapper && this.app.workspace.activeLeaf?.view.containerEl.contains(wrapper) && (!active || active === wrapper.ownerDocument.body)) wrapper.focus({ preventScroll: true });
    };
    attempt(); setTimeout(attempt, 0); setTimeout(attempt, 100);
  }
  detach(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.requestPushHistory.cancel(); this.requestFileOpen.cancel();
    if (this.frame) this.frameWin?.cancelAnimationFrame(this.frame); if (this.pointerFrame) this.frameWin?.cancelAnimationFrame(this.pointerFrame);
    this.frame = this.pointerFrame = 0;
    this.wrapperEl = this.canvasEl = this.patternEl = null;
  }
  async loadOptions(): Promise<void> {
    this.options = { ...DEFAULT_CANVAS_OPTIONS, ...await readCorePluginData(this.configDir, "canvas").catch(() => ({})) };
    this.viewportChanged = true; this.requestFrame(); this.host.render();
  }
  saveOptions(): void { void writeCorePluginData(this.configDir, "canvas", this.options).then(() => this.app.workspace.trigger("core-plugin-settings-change", "canvas")); this.host.render(); }

  // ---- Document ----

  /** Loads file contents. `clear` is a fresh file: history, selection and viewport start over. */
  setData(data: CanvasData | null, clear: boolean): void {
    if (clear) this.clear();
    if (data) { this.doc.load(data, true); this.data = data; this.history.push(data); }
    this.empty = !this.doc.nodes.size;
    for (const id of [...this.selection]) if (!this.doc.nodes.has(id) && !this.doc.edges.has(id)) this.selection.delete(id);
    if (clear) { this.zoomToFitQueued = true; this.onResize(); this.takeFocus(); }
    this.host.render();
  }
  getData(): CanvasData { return this.doc.save(this.data); }
  clear(): void {
    this.selection.clear(); this.editing = this.labelEditing = this.edgeLabelEditing = null; this.doc.nodes.clear(); this.doc.edges.clear(); this.doc.foreign = [];
    this.history.clear(); this.data = {}; this.requestPushHistory.cancel(); this.requestFileOpen.cancel(); this.setViewport(0, 0, 0); this.readonly = false; this.hover = null; this.empty = true;
  }
  /** Saves the document; `record` also adds an undo step once edits pause. */
  requestSave(record = true): void {
    const data = this.getData(); this.data = data;
    if (record) this.requestPushHistory(data);
    this.empty = this.empty && !this.doc.nodes.size;
    this.host.onChange(data); this.host.render();
  }
  /** Saves a change that should not be undone on its own (a card settling to its picture's proportions). */
  overrideHistory(): void { this.requestPushHistory.run(); const data = this.getData(); this.data = data; this.history.replace(data); this.host.onChange(data); this.host.render(); }
  undo(): void { const data = this.history.undo(); if (data) this.applyHistory(data); }
  redo(): void { const data = this.history.redo(); if (data) this.applyHistory(data); }
  private applyHistory(data: CanvasData): void {
    this.doc.load(data, true); this.data = data;
    for (const id of [...this.selection]) if (!this.doc.nodes.has(id) && !this.doc.edges.has(id)) this.selection.delete(id);
    if (this.editing && !this.doc.nodes.has(this.editing)) this.editing = null;
    this.host.onChange(data); this.host.render();
  }
  private pushHistory(data: CanvasData): void { this.history.push(data); this.host.render(); }

  node(id: string): CanvasNode | undefined { return this.doc.nodes.get(id); }
  patch(id: string, change: Partial<CanvasNode>): CanvasNode | null {
    const node = this.doc.nodes.get(id);
    if (!node) return null;
    const next = { ...node, ...change };
    for (const key of ["x", "y", "width", "height"] as const) next[key] = Math.round(next[key]);
    this.doc.nodes.set(id, next);
    return next;
  }
  patchEdge(id: string, change: Partial<CanvasEdge>): void { const edge = this.doc.edges.get(id); if (edge) this.doc.edges.set(id, { ...edge, ...change }); }
  private raise(id: string): void { const node = this.doc.nodes.get(id); if (node && node.type !== "group" && node.z !== this.doc.topZ) this.patch(id, { z: this.doc.nextZ() }); }
  nodeBBox = (node: Rect): BBox => bboxOf(node);
  rectFor(id: string): Rect | null { return id === DUMMY ? this.dummy : this.doc.nodes.get(id) ?? null; }
  edgeGeometry(edge: CanvasEdge): EdgeGeometry | null {
    const from = this.rectFor(edge.fromNode), to = this.rectFor(edge.toNode);
    return from && to ? edgeGeometry(bboxOf(from), edge.fromSide, edge.fromEnd, bboxOf(to), edge.toSide, edge.toEnd) : null;
  }
  edgeBBox(edge: CanvasEdge): BBox | null {
    const from = this.rectFor(edge.fromNode), to = this.rectFor(edge.toNode);
    return from && to ? pointsBBox(sideAnchor(bboxOf(from), edge.fromSide), sideAnchor(bboxOf(to), edge.toSide)) : null;
  }
  selected(): Selectable[] {
    const items: Selectable[] = [];
    for (const id of this.selection) { const node = this.doc.nodes.get(id), edge = this.doc.edges.get(id); if (node) items.push({ kind: "node", node }); else if (edge) items.push({ kind: "edge", edge }); }
    const order = (item: Selectable) => item.kind === "node" ? stackOrder(item.node) : -1;
    return items.sort((a, b) => order(a) - order(b));
  }
  selectedNodes(): CanvasNode[] { return this.selected().flatMap(item => item.kind === "node" ? [item.node] : []); }
  selectionBBox(): BBox | null {
    const boxes = this.selected().flatMap(item => item.kind === "node" ? [bboxOf(item.node)] : (box => box ? [box] : [])(this.edgeBBox(item.edge)));
    return boxes.length ? unionBBox(boxes) : null;
  }
  intersecting(box: BBox): CanvasNode[] { return [...this.doc.nodes.values()].filter(node => intersectsBBox(box, bboxOf(node))); }
  containedIn(box: BBox): CanvasNode[] { return this.intersecting(box).filter(node => containsBBox(box, bboxOf(node))); }
  viewportNodes(excludeSelected = false): CanvasNode[] { return this.intersecting(this.viewportBBox()).filter(node => !excludeSelected || !this.selection.has(node.id)); }
  hitTestNode(point: Point, tolerance = 0): CanvasNode | null {
    return this.intersecting(growBBox({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }, tolerance)).sort((a, b) => stackOrder(b) - stackOrder(a))[0] ?? null;
  }
  /** Stacking position of a card: a lone selected card is lifted above the rest. */
  zIndex(node: CanvasNode): number { return node.type === "group" ? stackOrder(node) : this.selection.size === 1 && this.selection.has(node.id) ? this.doc.topZ + 1 : node.z; }

  // ---- Selection ----

  private previousSelection = new Set<string>();
  edgeLabelInitial = "";
  private selectionChanged(): void {
    let resave = false;
    for (const id of this.previousSelection) {
      const edge = this.selection.has(id) ? undefined : this.doc.edges.get(id);
      if (edge?.label && (this.edgeLabelEditing === id ? this.edgeLabelInitial : "") !== edge.label) resave = true;
    }
    this.previousSelection = new Set(this.selection);
    if (resave && !this.readonly) queueMicrotask(() => this.requestSave());
    this.submenu = null;
    if (this.editing && !(this.selection.size === 1 && this.selection.has(this.editing))) this.editing = null;
    if (this.labelEditing && !(this.selection.size === 1 && this.selection.has(this.labelEditing))) this.labelEditing = null;
    if (this.edgeLabelEditing && !(this.selection.size === 1 && this.selection.has(this.edgeLabelEditing))) this.edgeLabelEditing = null;
    const only = this.selection.size === 1 ? this.doc.nodes.get([...this.selection][0]) : null;
    this.requestFileOpen(only?.type === "file" ? this.fileOf(only) : null);
    this.host.render();
  }
  select(id: string): void { if (!this.selection.has(id)) { this.selection.add(id); this.selectionChanged(); } }
  deselect(id: string): void { if (this.selection.delete(id)) this.selectionChanged(); }
  toggleSelect(id: string): void { if (!this.selection.delete(id)) this.selection.add(id); this.selectionChanged(); }
  selectOnly(id: string): void { if (this.selection.size === 1 && this.selection.has(id)) return; this.selection.clear(); this.selection.add(id); this.selectionChanged(); }
  selectAll(ids?: Iterable<string>): void { this.selection.clear(); for (const id of ids ?? this.doc.nodes.keys()) this.selection.add(id); this.selectionChanged(); }
  deselectAll(): void { if (this.selection.size) { this.selection.clear(); this.selectionChanged(); } }
  deleteSelection(): void {
    if (this.readonly) return;
    for (const id of [...this.selection]) { if (this.doc.nodes.has(id)) this.doc.removeNode(id); else this.doc.edges.delete(id); }
    this.selection.clear(); this.selectionChanged(); this.requestSave();
  }
  private updateFileOpen(file: TFile | null): void {
    const workspace = this.app.workspace, wrapper = this.wrapperEl;
    if (!wrapper || !workspace.activeLeaf?.view.containerEl.contains(wrapper)) return;
    workspace.trigger("file-open", file ?? this.app.vault.getAbstractFileByPath(this.host.sourcePath()));
  }
  fileOf(node: CanvasNode): TFile | null { const file = node.file ? this.app.vault.getAbstractFileByPath(node.file) : null; return file instanceof TFile ? file : null; }

  // ---- Viewport ----

  get gridSpacing(): number { return gridSpacing(this.zoom); }
  get snapDistance(): number { return Math.ceil(CANVAS_CONFIG.objectSnapDistance / this.scale); }
  get zoomBreakpoint(): number { return ZOOM_BREAKPOINT - (this.options.zoomBreakpoint || 0); }
  /** Whether card contents are drawn at this zoom, rather than placeholders. */
  get contentVisible(): boolean { return this.zoom > this.zoomBreakpoint; }
  private shownContent = true;
  private snapOptions(): SnapOptions { return { snapToGrid: !!this.options.snapToGrid, snapToObjects: !!this.options.snapToObjects, snapDistance: this.snapDistance, gridSpacing: this.gridSpacing }; }
  canSnap(event: MouseEvent | KeyboardEvent): boolean { return isMac ? !event.ctrlKey : !event.altKey; }
  domPosFromEvt(event: { clientX: number; clientY: number }): Point { return { x: event.clientX - this.rect.cx, y: event.clientY - this.rect.cy }; }
  posFromDom(point: Point): Point { return { x: this.x + point.x / this.scale, y: this.y + point.y / this.scale }; }
  domFromPos(point: Point): Point { return { x: (point.x - this.x) * this.scale, y: (point.y - this.y) * this.scale }; }
  posFromEvt(event: { clientX: number; clientY: number }): Point { return this.posFromDom(this.domPosFromEvt(event)); }
  posCenter(): Point { return this.posFromDom({ x: 0, y: 0 }); }
  viewportBBox(): BBox { return pointsBBox(this.posFromDom({ x: this.rect.minX, y: this.rect.minY }), this.posFromDom({ x: this.rect.maxX, y: this.rect.maxY })); }
  private markViewportChanged(): void { this.viewportChanged = true; this.requestFrame(); }
  setViewport(x: number, y: number, zoom: number): void {
    if (x === this.x && y === this.y && zoom === this.zoom) return;
    this.x = this.tx = x; this.y = this.ty = y; this.zoom = this.tZoom = zoom; this.markViewportChanged();
  }
  zoomBy(amount: number, center?: Point): void { this.tZoom += amount; this.zoomCenter = center ?? { x: 0, y: 0 }; this.markViewportChanged(); }
  panBy(dx: number, dy: number): void { this.x += dx; this.y += dy; this.tx = this.x; this.ty = this.y; this.markViewportChanged(); }
  zoomToBbox(box: BBox): void {
    const frame = frameBBox(box, this.rect);
    if (!frame) return;
    this.tx = frame.x; this.ty = frame.y; this.zoomCenter = null; this.tZoom = frame.zoom; this.markViewportChanged();
  }
  queueZoomToFit(): void { this.zoomToFitQueued = true; this.onResize(); }
  zoomToFit(): void { if (this.doc.nodes.size) this.zoomToBbox(unionBBox([...this.doc.nodes.values()].map(bboxOf))); }
  zoomToSelection(): void { const box = this.selectionBBox(); if (box) this.zoomToBbox(box); }
  panIntoView(target: BBox, margin = this.gridSpacing): void {
    const box = growBBox(target, margin), view = this.viewportBBox();
    if (box.maxX - box.minX > view.maxX - view.minX || box.maxY - box.minY > view.maxY - view.minY) { this.zoomToBbox(box); return; }
    if (box.minX < view.minX) this.tx = this.x + box.minX - view.minX;
    if (box.minY < view.minY) this.ty = this.y + box.minY - view.minY;
    if (box.maxX > view.maxX) this.tx = this.x + box.maxX - view.maxX;
    if (box.maxY > view.maxY) this.ty = this.y + box.maxY - view.maxY;
    this.markViewportChanged();
  }
  getState(): CanvasViewState { return { x: this.tx, y: this.ty, zoom: this.tZoom }; }
  setState(state: Partial<CanvasViewState> | null | undefined): void {
    if (!state || typeof state.x !== "number" || typeof state.y !== "number" || typeof state.zoom !== "number") return;
    this.setViewport(state.x, state.y, state.zoom); this.zoomToFitQueued = false;
  }
  onResize(): void {
    const wrapper = this.wrapperEl;
    if (!wrapper) return;
    const box = wrapper.getBoundingClientRect(), left = box.left + wrapper.clientLeft, top = box.top + wrapper.clientTop, width = wrapper.clientWidth, height = wrapper.clientHeight;
    this.rect = { left, top, width, height, cx: left + width / 2, cy: top + height / 2, minX: -width / 2, minY: -height / 2, maxX: width / 2, maxY: height / 2 };
    this.viewportChanged = true; this.requestFrame();
    if (width > 0 && this.zoomToFitQueued && this.doc.nodes.size) { this.zoomToFitQueued = false; this.finishAnimation = true; this.zoomToFit(); }
  }
  requestFrame(since = performance.now()): void {
    const win = this.wrapperEl?.ownerDocument.defaultView;
    if (this.frame || !win) return;
    this.frameWin = win;
    this.frame = win.requestAnimationFrame(() => { this.frame = 0; this.tick(since); });
  }
  private tick(since: number): void {
    const wrapper = this.wrapperEl, canvas = this.canvasEl;
    if (!wrapper || !canvas || !this.viewportChanged) return;
    const now = performance.now();
    let blend = 1 - (this.finishAnimation ? 0 : Math.pow(EASE, now - since));
    this.finishAnimation = false;
    let { x, y, zoom, scale, tx, ty } = this;
    if (!this.screenshotting) this.tZoom = clamp(this.tZoom, -4, 1);
    const tZoom = this.tZoom, zoomBy = tZoom - zoom, center = this.zoomCenter;
    if (Math.abs(zoomBy) < SETTLED) blend = 1;
    if (!isFinite(zoomBy)) { zoom = this.tZoom = 0; scale = 1; }
    else if (zoomBy === 0) { zoom = tZoom; scale = Math.pow(2, zoom); }
    else if (center) {
      const before = scale;
      zoom += zoomBy * blend; scale = Math.pow(2, zoom);
      x -= center.x / scale - center.x / before; y -= center.y / scale - center.y / before;
      tx = this.tx = x; ty = this.ty = y;
    } else { zoom += zoomBy * blend; scale = Math.pow(2, zoom); }
    const dx = tx - x, dy = ty - y;
    x += dx * blend; if (dx !== 0 && Math.abs(dx) < SETTLED) x = tx;
    y += dy * blend; if (dy !== 0 && Math.abs(dy) < SETTLED) y = ty;
    Object.assign(this, { x, y, zoom, scale });
    const { width, height } = this.rect, spacing = this.gridSpacing;
    wrapper.classList.toggle("mod-zoomed-out", zoom <= ZOOM_BREAKPOINT);
    canvas.style.transform = `translate(${width / 2}px, ${height / 2}px) scale(${scale}) translate(${-x}px, ${-y}px)`;
    const pattern = this.patternEl;
    if (pattern) { pattern.setAttribute("x", String(width / 2 - x % spacing * scale)); pattern.setAttribute("y", String(height / 2 - y % spacing * scale)); pattern.setAttribute("width", String(spacing * scale)); pattern.setAttribute("height", String(spacing * scale)); }
    if (this.x !== tx || this.y !== ty || this.zoom !== this.tZoom || Date.now() < this.pauseAnimation) { this.requestFrame(now); this.wasAnimating = true; }
    else {
      wrapper.style.setProperty("--zoom-multiplier", String(Math.sqrt(1 / (this.screenshotting ? Math.min(1, scale) : scale))));
      wrapper.classList.toggle("mod-animating", this.wasAnimating);
      this.wasAnimating = false; this.viewportChanged = false;
      this.app.workspace.requestSaveLayout();
    }
    if (this.contentVisible !== this.shownContent) { this.shownContent = this.contentVisible; this.host.render(); }
    this.positionMenu();
  }
  /** Places the selection toolbar above the selection, inside the viewport. */
  positionMenu(): void {
    const container = this.menuContainerEl, menu = this.menuEl, box = this.selectionBBox();
    if (!container || !menu || !box) return;
    const items = this.selected(), last = items[items.length - 1], single = items.length === 1, scale = this.scale;
    let x = (box.minX + box.maxX) / 2, y = box.minY - 10 / scale;
    if (items.some(item => item.kind === "node" && item.node.type === "group")) y = box.minY - 35 / Math.sqrt(scale);
    else if (last.kind === "node" && last.node.type === "file") y = box.minY - 30 / Math.sqrt(scale);
    if (last.kind === "edge" && single) {
      const center = this.edgeGeometry(last.edge)?.center, label = this.canvasEl?.querySelector<HTMLElement>(`.canvas-path-label-wrapper[data-edge="${last.edge.id}"]`)?.clientHeight || 20;
      if (center) y = Math.min(y, center.y - 20 / scale - label / 2);
    }
    const size = menu.getBoundingClientRect(), { width, height } = this.rect;
    container.style.left = clamp((x - this.x) * scale - size.width / 2 + width / 2, 10, width - size.width - 10) + "px";
    container.style.top = clamp((y - this.y) * scale - size.height + height / 2, 10, height - size.height - 10) + "px";
  }
  private setDragging(dragging: boolean): void { if (this.dragging !== dragging) { this.dragging = dragging; this.host.render(); } }

  // ---- Creating cards ----

  private addNode(type: NodeType, spec: NodeSpec, fields: Partial<CanvasNode>, fallback: Size): CanvasNode {
    const rect = placeRect(spec.pos, spec.size ?? fallback, spec.position);
    const node: CanvasNode = {
      id: newId(), type, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), color: "", z: this.doc.nextZ(), rest: {},
      text: "", file: "", subpath: "", url: "", label: "", background: "", backgroundStyle: "", ...fields, unplaced: true,
    };
    this.doc.nodes.set(node.id, node); this.empty = false;
    if (spec.save !== false) this.requestSave();
    // Text cards and groups that take the focus are drawn at once; the others on the next frame.
    const placeImmediately = spec.focus !== false && (type === "text" || type === "group");
    if (placeImmediately) this.place(node.id); else setTimeout(() => this.place(node.id), 0);
    return this.doc.nodes.get(node.id) ?? node;
  }
  private place(id: string): void {
    const node = this.doc.nodes.get(id);
    if (!node?.unplaced) return;
    const { unplaced: _unplaced, ...placed } = node;
    this.doc.nodes.set(id, placed);
  }
  createTextNode(spec: NodeSpec & { text?: string }): CanvasNode {
    const node = this.addNode("text", spec, { text: spec.text ?? "" }, CANVAS_CONFIG.defaultTextNodeDimensions);
    if (spec.focus !== false) { this.selectOnly(node.id); this.startEditing(node.id); }
    return node;
  }
  createFileNode(spec: NodeSpec & { file: TFile; subpath?: string }): CanvasNode {
    const node = this.addNode("file", spec, { file: spec.file.path, subpath: spec.subpath ?? "" }, CANVAS_CONFIG.defaultFileNodeDimensions);
    if (spec.focus !== false) this.selectOnly(node.id);
    return node;
  }
  createFileNodes(files: TFile[], at: Point): CanvasNode[] {
    const size = CANVAS_CONFIG.defaultFileNodeDimensions;
    return files.map((file, index) => this.createFileNode({ pos: { x: at.x + (size.width + 45) * (index % 10), y: at.y + (size.height + 45) * Math.trunc(index / 10) }, size, file, save: false, focus: false }));
  }
  createLinkNode(spec: NodeSpec & { url: string }): CanvasNode {
    const node = this.addNode("link", { ...spec, size: spec.size ?? (YOUTUBE.test(spec.url) ? { width: 640, height: 360 } : undefined) }, { url: spec.url }, CANVAS_CONFIG.defaultFileNodeDimensions);
    if (spec.focus !== false) this.selectOnly(node.id);
    return node;
  }
  createGroupNode(spec: NodeSpec & { label?: string }): CanvasNode {
    const node = this.addNode("group", spec, { label: spec.label || t("plugins.canvas.label-untitled-group") }, CANVAS_CONFIG.defaultFileNodeDimensions);
    if (spec.focus !== false) { this.selectOnly(node.id); this.labelEditing = node.id; this.host.render(); }
    return node;
  }
  groupSelection(): void {
    const box = this.selectionBBox();
    if (box) { const rect = rectOf(growBBox(box, 20)); this.createGroupNode({ pos: rect, size: rect }); }
  }
  startEditing(id: string, point: Point | null = null): void {
    const node = this.doc.nodes.get(id);
    if (!node || this.readonly) return;
    this.selectOnly(id);
    if (this.zoom < this.zoomBreakpoint + 0.1) this.zoomToBbox(bboxOf(node));
    if (node.type === "group") this.labelEditing = id; else { this.editing = id; this.editingPreview = false; this.editPoint = point; }
    this.host.render();
  }
  /** A card's media reported its proportions: the card adopts them (without an undo step). */
  fitAspect(id: string, ratio: number): void {
    const node = this.doc.nodes.get(id);
    if (!ratio || !isFinite(ratio)) { this.aspect.delete(id); return; }
    this.aspect.set(id, ratio);
    if (!node || Math.abs(node.width / node.height - ratio) < 0.01) return;
    this.patch(id, { width: Math.min(node.width, node.height * ratio), height: Math.min(node.height, node.width / ratio) });
    this.overrideHistory();
  }
  stopEditing(): void { if (this.editing) { this.editing = null; this.editingPreview = false; this.host.render(); } }
  /** Escape in a card's editor: the card shows its preview again and the focus is dropped, but (as in the reference) it stays the card being edited until it is deselected. */
  editingPreview = false;
  pauseEditing(): void {
    if (!this.editing || this.editingPreview) return;
    this.editingPreview = true; this.host.render();
    const active = this.wrapperEl?.ownerDocument.activeElement;
    if (active instanceof HTMLElement && this.wrapperEl?.contains(active)) active.blur();
  }
  editEdgeLabel(id: string, point: Point | null = null): void { this.edgeLabelInitial = this.doc.edges.get(id)?.label ?? ""; this.edgeLabelEditing = id; this.edgeLabelPoint = point; this.host.render(); }
  convertToFile(id: string): void {
    const node = this.doc.nodes.get(id), sourcePath = this.host.sourcePath();
    if (!node || node.type !== "text") return;
    promptFileName(this.app, name => void (async () => {
      const file = await this.app.fileManager.createNewMarkdownFile(this.app.fileManager.getNewFileParent(sourcePath, name), name, node.text);
      const created = this.createFileNode({ pos: node, size: node, file, save: false, focus: false });
      for (const edge of this.doc.edgesOf(id)) this.doc.edges.set(edge.id, { ...edge, fromNode: edge.fromNode === id ? created.id : edge.fromNode, toNode: edge.toNode === id ? created.id : edge.toNode });
      this.doc.nodes.delete(id); this.selectOnly(created.id); this.requestSave();
    })().catch(error => new Notice(error instanceof Error ? error.message : String(error))));
  }
  /** The single selected text card, which "Convert to file..." applies to. */
  convertibleSelection(): CanvasNode | null { const nodes = this.selection.size === 1 ? this.selectedNodes() : []; return nodes[0]?.type === "text" ? nodes[0] : null; }
  jumpToGroup(): void { new GroupPicker(this.app, () => [...this.doc.nodes.values()].filter(node => node.type === "group"), group => this.zoomToBbox(bboxOf(group))).open(); }
  setReadonly(readonly: boolean): void { this.readonly = readonly; if (readonly) this.editing = this.labelEditing = this.edgeLabelEditing = null; this.host.render(); }
  toggleReadonly(): void { this.setReadonly(!this.readonly); this.host.onLocalChange(); }

  // ---- Clipboard ----

  private get focused(): boolean { return !!this.wrapperEl && this.wrapperEl.ownerDocument.activeElement === this.wrapperEl; }
  handleCopy(event: ClipboardEvent): void {
    if (!this.focused) return;
    event.preventDefault();
    if (this.selection.size) event.clipboardData?.setData("obsidian/canvas", JSON.stringify(this.doc.selectionData(this.selection)));
  }
  handleCut(event: ClipboardEvent): void {
    if (this.readonly || !this.focused) return;
    this.handleCopy(event); this.deleteSelection();
  }
  private importData(data: Pick<CanvasData, "nodes" | "edges">): string[] {
    const ids = this.doc.load(data, false).map(node => { this.raise(node.id); return node.id; });
    this.empty = this.empty && !this.doc.nodes.size;
    return ids;
  }
  duplicateSelection(): void {
    const ids = this.importData(cloneData(this.doc.selectionData(this.selection), { x: this.gridSpacing, y: this.gridSpacing }));
    this.selectAll(ids); this.requestSave();
  }
  /** Copies files from outside the vault into its attachment folder. */
  async importAttachments(files: File[]): Promise<TFile[]> {
    const created: TFile[] = [];
    for (const file of files) {
      const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14), name = file.name && file.name !== "image.png" ? file.name : `Pasted image ${stamp}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
      const target = await this.app.fileManager.getAvailablePathForAttachment(name, this.host.sourcePath());
      created.push(await this.app.vault.createBinary(target, await file.arrayBuffer()));
    }
    return created;
  }
  handlePaste(event: ClipboardEvent): void {
    if (event.defaultPrevented || this.readonly || !this.focused) return;
    event.preventDefault();
    const center = this.posCenter(), clipboard = event.clipboardData, files = [...(clipboard?.files ?? [])];
    if (files.length) { void this.importAttachments(files).then(created => { this.createFileNodes(created, center); this.requestSave(); }); return; }
    const raw = clipboard?.getData("obsidian/canvas");
    if (raw) {
      let data: { nodes?: unknown; edges?: unknown; center?: Point };
      try { data = JSON.parse(raw); } catch (error) { console.error(error); return; }
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return;
      const ids = this.importData(cloneData(data as CanvasData, data.center ? { x: center.x - data.center.x, y: center.y - data.center.y } : null));
      this.selectAll(ids); this.requestSave();
      return;
    }
    const text = textOf(clipboard);
    if (isWebUrl(text)) this.createLinkNode({ pos: center, position: "center", url: text });
    else if (text) {
      this.createTextNode({ pos: center, position: "center", text });
      // The initial file write precedes placement, but undo/redo captures the placed card's stack rank.
      this.requestPushHistory(this.getData());
    }
  }
  private clipboardCommand(command: "cut" | "copy" | "paste"): void {
    this.wrapperEl?.focus();
    const contents = getRemote().getCurrentWebContents();
    if (contents) contents[command](); else this.wrapperEl?.ownerDocument.execCommand(command);
  }

  // ---- Keyboard ----

  private onKeydown(event: KeyboardEvent): void {
    if (event.repeat || event.defaultPrevented || isEditableTarget(event.target)) return;
    if (event.key === "Escape") this.deselectAll();
    else if ((event.key === "Backspace" || event.key === "Delete") && !this.dragging && this.focused) this.deleteSelection();
  }
  /** Keys that act on the canvas whenever its tab is the active one and no field has the focus. */
  private onGlobalKeydown(event: KeyboardEvent): void {
    const wrapper = this.wrapperEl;
    if (!wrapper || event.defaultPrevented || isEditableTarget(event.target)) return;
    if (!this.app.workspace.activeLeaf?.view.containerEl.contains(wrapper) || wrapper.ownerDocument.querySelector(".modal-container, .menu")) return;
    const mod = Keymap.isModifier(event, "Mod"), key = event.key.length === 1 ? event.key.toLowerCase() : event.key, plain = !mod && !event.altKey;
    if (key === " " && !this.holdingSpace && !this.editing) { this.holdingSpace = true; this.host.render(); return; }
    const done = () => { event.preventDefault(); event.stopPropagation(); };
    if (mod && !event.altKey && key === "z") { done(); if (event.shiftKey) this.redo(); else this.undo(); }
    else if (mod && !event.altKey && !event.shiftKey && key === "y") { done(); this.redo(); }
    else if (mod && !event.altKey && !event.shiftKey && key === "a") { done(); this.selectAll(); }
    else if (plain && event.shiftKey && event.code === "Digit1") { done(); this.zoomToFit(); }
    else if (plain && event.shiftKey && event.code === "Digit2") { done(); this.zoomToSelection(); }
    else if (plain && key.startsWith("Arrow")) { done(); this.nudgeSelection(event.shiftKey, key.slice(5).toLowerCase() as "up" | "down" | "left" | "right"); }
  }
  nudgeSelection(shift: boolean, direction: "up" | "down" | "left" | "right"): void {
    const nodes = this.selectedNodes(), box = this.selectionBBox();
    if (!nodes.length || !box || this.readonly) return;
    const delta = nudgeDelta(direction, shift, this.gridSpacing, !!this.options.snapToGrid, box);
    for (const node of nodes) this.patch(node.id, { x: node.x + delta.x, y: node.y + delta.y });
    this.requestSave();
  }

  // ---- Pointer: background ----

  private onPriorityPointerdown(event: PointerEvent): void {
    if (event.pointerType !== "mouse") return;
    const pan = (origin: Point, after?: () => void): DragHandlers => ({
      move: next => { const at = this.posFromEvt(next); this.panBy(origin.x - at.x, origin.y - at.y); },
      end: next => next.preventDefault(),
      cleanup: () => { after?.(); this.setDragging(false); },
    });
    if (event.button === 1) { event.preventDefault(); const origin = this.posFromEvt(event); this.setDragging(true); trackDrag(event, () => pan(origin), 0); }
    if (event.button === 2 || (isMac && event.button === 1 && event.ctrlKey)) {
      event.preventDefault();
      const origin = this.posFromEvt(event), wrapper = this.wrapperEl!;
      trackDrag(event, () => { this.setDragging(true); return pan(origin, () => suppressNext(wrapper, "contextmenu")); });
    }
  }
  private onPointerdown(event: PointerEvent): void {
    if (event.target !== this.wrapperEl || event.pointerType !== "mouse" || event.button !== 0) return;
    const additive = event.shiftKey, previous = new Set(this.selection);
    if (!additive) this.deselectAll();
    trackDrag(event, () => this.handleDragToSelect(event, additive, previous));
  }
  private interactionHitTest(event: PointerEvent): void {
    this.pointer = this.posFromEvt(event);
    const win = this.wrapperEl?.ownerDocument.defaultView;
    if (this.pointerFrame || !win) return;
    this.pointerFrame = win.requestAnimationFrame(() => {
      this.pointerFrame = 0;
      if (this.dragging) return;
      const hit = this.hitTestNode(this.pointer, 8 / this.scale), next = hit && !(this.selection.size > 1 && this.selection.has(hit.id)) ? hit.id : null;
      if (next !== this.hover) { this.hover = next; this.host.render(); }
    });
  }
  onMoverPointerdown(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0) return;
    const origin = this.posFromEvt(event);
    trackDrag(event, () => ({ move: next => { const at = this.posFromEvt(next); this.panBy(origin.x - at.x, origin.y - at.y); } }));
  }
  private handleDragToSelect(event: PointerEvent, additive: boolean, previous: Set<string>): DragHandlers {
    const origin = this.posFromEvt(event);
    const done = () => { this.marquee = null; this.host.render(); };
    return this.handleDragWithPan(event, {
      move: next => {
        const box = this.marquee = pointsBBox(origin, this.posFromEvt(next));
        let hits = new Set(this.intersecting(box).filter(node => node.type !== "group" || containsBBox(box, bboxOf(node))).map(node => node.id));
        if (additive) { const merged = new Set(previous); for (const id of hits) if (!merged.delete(id)) merged.add(id); hits = merged; }
        this.selectAll(hits);
      },
      end: next => {
        const box = this.marquee, rect = box ? rectOf(box) : null;
        if (rect && next instanceof MouseEvent && Keymap.isModifier(next, "Mod") && !this.readonly) {
          const spec = { pos: rect, size: rect }, sourcePath = this.host.sourcePath();
          switch (this.options.defaultModDragBehavior) {
            case "card": this.createTextNode(spec); done(); break;
            case "note": pickNote(this.app, sourcePath, file => this.createFileNode({ ...spec, file }), done); break;
            case "media": pickAttachment(this.app, sourcePath, file => this.createFileNode({ ...spec, file })); done(); break;
            case "webpage": promptUrl(this.app, "", url => this.createLinkNode({ ...spec, url })); done(); break;
            case "group": this.createGroupNode(spec); done(); break;
            default: { const menu = new Menu(); this.showCreationMenu(menu, rect, rect); menu.onHide(done); menu.showAtMouseEvent(next); }
          }
        } else done();
        if (this.wrapperEl) suppressNext(this.wrapperEl, "click");
      },
      cancel: () => { this.selectAll(previous); done(); },
    });
  }
  private onDoubleClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.target !== this.wrapperEl || this.dragging || this.readonly) return;
    this.createTextNode({ pos: this.posFromEvt(event), position: "center" });
  }
  private onContextMenu(event: MouseEvent): void {
    if (event.defaultPrevented || event.target !== this.wrapperEl || this.readonly) return;
    event.preventDefault(); this.deselectAll();
    const menu = new Menu();
    this.showCreationMenu(menu, this.posFromEvt(event));
    menu.addSeparator();
    if (this.history.canUndo()) menu.addItem(item => item.setTitle(t("setting.mobile-toolbar.option-undo")).setSection("history").setIcon("lucide-undo-2").onClick(() => this.undo()));
    if (this.history.canRedo()) menu.addItem(item => item.setTitle(t("setting.mobile-toolbar.option-redo")).setSection("history").setIcon("lucide-redo-2").onClick(() => this.redo()));
    menu.addSeparator().addItem(item => item.setTitle(t("interface.menu.paste")).setSection("clipboard").setIcon("lucide-clipboard-check").onClick(() => this.clipboardCommand("paste")));
    this.showQuickSettingsMenu(menu);
    menu.showAtMouseEvent(event);
  }
  showQuickSettingsMenu(menu: Menu): void {
    menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.option-snap-to-grid")).setIcon("lucide-grid").setChecked(!!this.options.snapToGrid).onClick(() => { this.options.snapToGrid = !this.options.snapToGrid; this.saveOptions(); }));
    menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.option-snap-to-objects")).setIcon("snap-to-object").setChecked(!!this.options.snapToObjects).onClick(() => { this.options.snapToObjects = !this.options.snapToObjects; this.saveOptions(); }));
    menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.label-readonly")).setIcon("lucide-lock").setChecked(this.readonly).onClick(() => this.toggleReadonly()));
  }
  showCreationMenu(menu: Menu, pos: Point, size?: Size): void {
    const sourcePath = this.host.sourcePath();
    menu.addItem(item => item.setTitle(t("plugins.canvas.action-add-card")).setSection("create").setIcon("lucide-sticky-note").onClick(() => this.createTextNode({ pos, size })));
    menu.addItem(item => item.setTitle(t("plugins.canvas.action-add-note")).setSection("create").setIcon("lucide-file-text").onClick(() => pickNote(this.app, sourcePath, file => this.createFileNode({ pos, size, file }))));
    menu.addItem(item => item.setTitle(t("plugins.canvas.action-add-media")).setSection("create").setIcon("lucide-file-image").onClick(() => pickMedia(this.app, file => this.createFileNode({ pos, size, file }))));
    menu.addItem(item => item.setTitle(t("plugins.canvas.action-add-website")).setSection("create").setIcon("lucide-external-link").onClick(() => promptUrl(this.app, "", url => this.createLinkNode({ pos, size, url }))));
    menu.addItem(item => item.setTitle(t("plugins.canvas.action-create-group")).setSection("create").setIcon("create-group").onClick(() => this.createGroupNode({ pos, size })));
  }
  private onWheel(event: WheelEvent): void {
    const wrapper = this.wrapperEl;
    if (this.dragging || event.defaultPrevented || !wrapper) return;
    const legacy = event as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
    const mod = event.ctrlKey || event.metaKey, mouseWheel = Math.abs(legacy.wheelDeltaY ?? 0) === 240 && legacy.wheelDeltaX === 0;
    let zooming = mod || this.holdingSpace;
    if (this.options.defaultWheelBehavior === "zoom" && !mouseWheel) zooming = !zooming;
    if (isMac && event.ctrlKey && event.deltaX === 0 && event.deltaY === 0) { this.smartZoom(event); return; }
    if (!mod && scrollsInside(event, wrapper)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1, dx = event.deltaX * unit, dy = event.deltaY * unit;
    if (zooming) {
      this.zoomBy((-dy / 300) * (isMac && !Number.isInteger(dy) ? 2 : 1), dy < 0 ? this.domPosFromEvt(event) : undefined);
      this.pauseAnimation = Date.now() + 200;
    } else if (event.shiftKey && dx === 0) { this.tx += dy / this.scale * WHEEL_PAN; this.markViewportChanged(); }
    else { this.tx += dx / this.scale * WHEEL_PAN; this.ty += dy / this.scale * WHEEL_PAN; this.markViewportChanged(); }
    const wheelX = legacy.wheelDeltaX, wheelY = legacy.wheelDeltaY;
    const stepped = (dx === 0 && Number.isInteger(wheelY) && Math.abs(wheelY!) === 120 && wheelY !== -3 * event.deltaY) || (dy === 0 && Number.isInteger(wheelX) && Math.abs(wheelX!) === 120 && wheelX !== -3 * event.deltaX);
    if (!stepped) this.finishAnimation = true;
  }
  private smartZoom(event: MouseEvent): void {
    const at = this.posFromEvt(event), point = { minX: at.x, minY: at.y, maxX: at.x, maxY: at.y }, selected = this.selectionBBox();
    if (selected && containsBBox(selected, point)) { this.zoomToSelection(); return; }
    const hits = this.intersecting(point).sort((a, b) => a.width * a.height - b.width * b.height);
    if (hits.length) this.zoomToBbox(bboxOf(hits[0])); else this.zoomToFit();
  }

  // ---- Pointer: moving ----

  /** Wraps drag handlers so the view scrolls when the pointer nears an edge, and tidies up afterwards. */
  private handleDragWithPan(event: PointerEvent, handlers: DragHandlers): DragHandlers {
    const wrapper = this.wrapperEl!, bounds = wrapper.getBoundingClientRect(), win = event.view ?? window;
    this.setDragging(true);
    let dx = 0, dy = 0, timer = 0;
    return {
      ...handlers,
      move: next => {
        const inner = growBBox(bboxOf(bounds), -30);
        dx = next.clientX < inner.minX ? next.clientX - inner.minX : next.clientX > inner.maxX ? next.clientX - inner.maxX : 0;
        dy = next.clientY < inner.minY ? next.clientY - inner.minY : next.clientY > inner.maxY ? next.clientY - inner.maxY : 0;
        if (dx || dy) {
          dx = clamp(dx, -40, 40); dy = clamp(dy, -40, 40);
          if (!timer) timer = win.setInterval(() => { const speed = 0.5 / Math.sqrt(this.scale); this.panBy(dx * speed, dy * speed); }, 1000 / 60);
        } else if (timer) { win.clearInterval(timer); timer = 0; }
        handlers.move?.(next);
      },
      cleanup: () => {
        if (timer) win.clearInterval(timer);
        this.guides = []; this.setDragging(false); handlers.cleanup?.(); this.host.render();
      },
    };
  }
  private showSnap(matchX: SnapMatch | null, matchY: SnapMatch | null, dx: number, dy: number): void { this.guides = matchX || matchY ? snapGuides(matchX, matchY, dx, dy) : []; }
  private getSnapping(moving: BBox[], resting: BBox[], moveX: boolean, moveY: boolean): Point {
    const snap = snapMove(moving, resting, moveX, moveY, this.snapOptions());
    this.showSnap(snap.matchX, snap.matchY, snap.x, snap.y);
    return { x: snap.x, y: snap.y };
  }
  /** Drags the selection (or the card that was pressed); Ctrl/Alt drags a copy, Shift locks the axis. */
  handleSelectionDrag(event: PointerEvent, target: Element | null, pressed?: string): DragHandlers | null {
    if (this.readonly) return null;
    const origin = this.posFromEvt(event);
    if (pressed && !this.selection.has(pressed)) this.selectOnly(pressed);
    const ids = new Set<string>();
    for (const node of this.selectedNodes()) { ids.add(node.id); if (node.type === "group") for (const inner of this.containedIn(bboxOf(node))) ids.add(inner.id); }
    const moving = [...ids].map(id => this.doc.nodes.get(id)!), start = new Map(moving.map(node => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]));
    for (const node of moving) { this.lifted.add(node.id); this.raise(node.id); }
    let cloning = false;
    const offset = (next: PointerEvent | KeyboardEvent, pointer: Point): Point => {
      const delta = { x: pointer.x - origin.x, y: pointer.y - origin.y };
      if (next.shiftKey) { if (Math.abs(delta.x) > Math.abs(delta.y)) delta.y = 0; else delta.x = 0; }
      if (!this.canSnap(next)) return delta;
      const groups = moving.filter(node => node.type === "group");
      let anchors = moving;
      if (groups.length === 1) anchors = groups;
      else if (groups.length > 1) anchors = groups.filter(group => !groups.some(other => other !== group && containsBBox(bboxOf(other), bboxOf(group)) && !sameBBox(bboxOf(other), bboxOf(group))));
      const boxes = anchors.map(node => { const from = start.get(node.id)!; return bboxOf({ ...from, x: from.x + delta.x, y: from.y + delta.y }); });
      const resting = this.viewportNodes().filter(node => !ids.has(node.id) && (groups.length > 0) === (node.type === "group")).map(bboxOf);
      const snap = this.getSnapping(boxes, resting, delta.x !== 0, delta.y !== 0);
      return { x: delta.x + snap.x, y: delta.y + snap.y };
    };
    let last = origin;
    const apply = (next: PointerEvent | KeyboardEvent) => {
      this.guides = [];
      cloning = isMac ? next.altKey : next.ctrlKey;
      const delta = offset(next, last);
      const placed = moving.map(node => { const from = start.get(node.id)!; return { ...from, x: from.x + delta.x, y: from.y + delta.y }; });
      if (cloning) { this.ghosts = placed; for (const node of moving) this.patch(node.id, start.get(node.id)!); }
      else { this.ghosts = []; moving.forEach((node, index) => this.patch(node.id, placed[index])); }
      this.host.render();
      return delta;
    };
    return this.handleDragWithPan(event, {
      move: next => { last = this.posFromEvt(next); apply(next); },
      end: next => {
        if (cloning && next instanceof PointerEvent) {
          const delta = offset(next, this.posFromEvt(next));
          this.selectAll(this.importData(cloneData(this.doc.selectionData(ids), delta)));
        }
        this.requestSave();
      },
      cancel: () => { for (const node of moving) this.patch(node.id, start.get(node.id)!); },
      cleanup: () => { this.ghosts = []; this.lifted.clear(); if (target) suppressNext(target, "click"); },
      keydown: next => { if (!next.repeat) apply(next); },
      keyup: next => apply(next),
    });
  }
  /** Drags an outline from the card bar; `create` receives where it was dropped. */
  dragTempNode(event: PointerEvent, size: Size, create: (pos: Point) => void): void {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    trackDrag(event, () => {
      let rect: Rect = { x: 0, y: 0, ...size };
      return this.handleDragWithPan(event, {
        move: next => {
          this.guides = [];
          rect = placeRect(this.posFromEvt(next), size, "center");
          if (this.canSnap(next)) { const snap = this.getSnapping([bboxOf(rect)], this.viewportNodes().filter(node => node.type !== "group").map(bboxOf), true, true); rect.x += snap.x; rect.y += snap.y; }
          this.ghosts = [rect]; this.host.render();
        },
        end: () => create({ x: Math.round(rect.x), y: Math.round(rect.y) }),
        cleanup: () => { this.ghosts = []; },
      });
    });
  }

  // ---- Pointer: cards ----

  onNodePointerdown(event: PointerEvent, id: string, target: Element): void {
    if (!event.isPrimary || event.button !== 0 || this.editing === id || event.pointerType !== "mouse" || this.readonly || isEditableTarget(event.target)) return;
    trackDrag(event, () => this.handleSelectionDrag(event, target, id));
  }
  onNodeClick(event: MouseEvent, id: string): void {
    if (this.editing === id) return;
    this.wrapperEl?.focus({ preventScroll: true });
    if (event.shiftKey) this.toggleSelect(id); else this.selectOnly(id);
  }
  onNodeContextMenu(event: MouseEvent, id: string): void {
    if (this.editing === id || event.defaultPrevented) return;
    if (this.selection.has(id) && this.selection.size > 1) { this.onSelectionContextMenu(event); return; }
    event.preventDefault();
    this.selectOnly(id);
    const menu = new Menu().addSections(["title", "canvas", "open", "action-primary", "action", "info", "view", "system", "", "danger"]);
    this.showNodeMenu(menu, id);
    menu.showAtMouseEvent(event);
  }
  private showNodeMenu(menu: Menu, id: string): void {
    const node = this.doc.nodes.get(id)!, app = this.app, change = (patch: Partial<CanvasNode>) => { this.patch(id, patch); this.requestSave(); };
    if (!this.readonly) menu.addItem(item => item.setSection("danger").setTitle(t("plugins.canvas.action-remove")).setIcon("lucide-trash-2").setWarning(true).onClick(() => { this.doc.removeNode(id); this.selection.delete(id); this.selectionChanged(); this.requestSave(); }));
    menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-zoom-to-selection")).setIcon("zoom-to-selection").onClick(() => this.zoomToSelection()));
    app.workspace.trigger("canvas:node-menu", menu, node);
    if (node.type === "text" && !this.readonly) {
      menu.addItem(item => item.setSection("canvas").setTitle(t("interface.menu.edit")).setIcon("lucide-edit").onClick(() => this.startEditing(id)));
      menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-convert-to-file")).setIcon("lucide-file-input").onClick(() => this.convertToFile(id)));
    } else if (node.type === "group" && !this.readonly) {
      menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-edit-label")).setIcon("lucide-edit").onClick(() => this.startEditing(id)));
    } else if (node.type === "link") {
      if (!this.readonly) menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-change-url")).setIcon("lucide-link").onClick(() => promptUrl(app, node.url, url => change({ url }))));
      menu.addItem(item => item.setSection("canvas").setTitle(t("interface.menu.open-in-browser")).setIcon("lucide-globe").onClick(() => window.open(node.url, "_blank")));
      menu.addItem(item => item.setSection("canvas").setTitle(t("interface.menu.copy-url")).setIcon("lucide-copy").onClick(() => { void navigator.clipboard.writeText(node.url); new Notice(t("interface.copied", { item: "URL" })); }));
      menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-reload-page")).setIcon("lucide-rotate-ccw").onClick(() => {
        const frame = this.canvasEl?.querySelector<HTMLElement & { loadURL?(url: string): void }>(`.canvas-node[data-id="${id}"] .canvas-link`);
        if (frame && /^https?:\/\//.test(node.url)) try { frame.loadURL?.(node.url); } catch { /* the frame is not ready yet */ }
      }));
    } else if (node.type === "file") {
      const file = this.fileOf(node), extension = file?.extension.toLowerCase();
      if (!this.readonly) menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-swap-file")).setIcon(file ? "lucide-arrow-left-right" : "lucide-repeat").onClick(() => {
        const documents = !file || extension === "md" || extension === "canvas", attachments = !file || extension !== "md";
        new CanvasFilePicker(app, { markdown: documents, documents, images: attachments, attachments, create: true, sourcePath: this.host.sourcePath() }, next => change({ file: next.path, subpath: "" })).open();
      }));
      if (!file) return;
      if (extension === "md") menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(() => void app.workspace.getLeaf("tab").openFile(file)));
      if (!this.readonly && extension === "md") {
        menu.addItem(item => item.setSection("canvas").setTitle(t("interface.menu.edit")).setIcon("lucide-edit").onClick(() => this.startEditing(id)));
        menu.addItem(item => item.setSection("canvas").setIcon("lucide-minimize-2").setTitle(t("plugins.canvas.action-narrow-heading")).onClick(() => new NarrowPicker(app, file, "heading", subpath => change({ subpath })).open()));
        menu.addItem(item => item.setSection("canvas").setIcon("lucide-minimize-2").setTitle(t("plugins.canvas.action-narrow-block")).onClick(() => new NarrowPicker(app, file, "block", subpath => change({ subpath })).open()));
      }
      if (!this.readonly && extension === "base") menu.addItem(item => item.setSection("canvas").setIcon("lucide-minimize-2").setTitle(t("plugins.canvas.action-narrow-bases-view")).onClick(() => void BaseViewPicker.open(app, file, node.subpath.slice(1), name => change({ subpath: name ? "#" + name : "" }))));
      if (!node.subpath) {
        menu.addItem(item => item.setSection("action").setTitle(t("plugins.file-explorer.menu-opt-rename")).setIcon("lucide-edit-3").onClick(() => promptRename(app, file)));
        if (canvasHooks.fileMenu) canvasHooks.fileMenu(menu, file, "canvas-menu"); else app.workspace.trigger("file-menu", menu, file, "canvas-menu");
      }
    }
  }
  onSelectionContextMenu(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const menu = new Menu().addSections(["title", "open", "selection", "clipboard", "action", "view", "info", "", "danger"]);
    if (!this.readonly) menu.addItem(item => item.setTitle(t("interface.delete-action-short-name")).setSection("danger").setIcon("lucide-trash-2").onClick(() => this.deleteSelection()));
    menu.addItem(item => item.setTitle(t("plugins.canvas.action-zoom-to-selection")).setSection("selection").setIcon("zoom-to-selection").onClick(() => this.zoomToSelection()));
    if (!this.readonly) {
      menu.addItem(item => item.setTitle(t("plugins.canvas.action-create-group")).setSection("selection").setIcon("create-group").onClick(() => this.groupSelection()));
      menu.addItem(item => item.setTitle(t("interface.menu.cut")).setIcon("lucide-scissors").setSection("clipboard").onClick(() => this.clipboardCommand("cut")));
      menu.addItem(item => item.setTitle(t("interface.menu.copy")).setIcon("lucide-copy").setSection("clipboard").onClick(() => this.clipboardCommand("copy")));
      menu.addItem(item => item.setTitle(t("interface.menu.paste")).setIcon("lucide-clipboard-check").setSection("clipboard").onClick(() => this.clipboardCommand("paste")));
    }
    this.app.workspace.trigger("canvas:selection-menu", menu, this);
    const files = this.selectedNodes().flatMap(node => node.type === "file" ? (file => file ? [file] : [])(this.fileOf(node)) : []);
    if (files.length > 1) this.app.workspace.trigger("files-menu", menu, files, "canvas:selection-menu", null);
    menu.showAtMouseEvent(event);
  }
  /** Resizes one card from a handle; pictures keep their proportions. */
  onResizePointerdown(event: PointerEvent, id: string, handle: ResizeHandle): void {
    const aspectRatio = this.aspect.get(id) ?? 0;
    const node = this.doc.nodes.get(id);
    if (!node || !event.isPrimary || event.button !== 0 || this.readonly) return;
    event.preventDefault();
    trackDrag(event, () => {
      const origin: Rect = { x: node.x, y: node.y, width: node.width, height: node.height }, minimum = CANVAS_CONFIG.minContainerDimension;
      this.selectOnly(id); this.lifted.add(id);
      return this.handleDragWithPan(event, {
        move: next => {
          const result = resizeRect({ handle, pointer: this.posFromEvt(next), origin, minWidth: minimum, minHeight: minimum, aspectRatio, snap: this.canSnap(next), resting: this.viewportNodes(true).map(bboxOf), options: this.snapOptions() });
          this.showSnap(result.matchX, result.matchY, result.dx, result.dy);
          this.patch(id, result.rect); this.host.render();
        },
        end: () => this.requestSave(),
        cancel: () => { this.patch(id, origin); this.requestSave(); },
        cleanup: () => this.lifted.delete(id),
      });
    });
  }
  /** Resizes the whole selection from the frame around it, scaling every card with it. */
  onSelectionResizePointerdown(event: PointerEvent, handle: ResizeHandle): void {
    const aspectRatios = this.aspect;
    const box = this.selectionBBox();
    if (!box || !event.isPrimary || event.button !== 0 || event.pointerType !== "mouse" || this.readonly) return;
    event.preventDefault();
    trackDrag(event, () => {
      const origin = rectOf(box), nodes = this.selectedNodes(), start = nodes.map(node => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
      const share = start.map(rect => ({ width: rect.width / origin.width, height: rect.height / origin.height }));
      const inset = start.map(rect => ({ minX: (rect.x - box.minX) / origin.width, minY: (rect.y - box.minY) / origin.height, maxX: (rect.x + rect.width - box.maxX) / origin.width, maxY: (rect.y + rect.height - box.maxY) / origin.height }));
      for (const node of nodes) this.lifted.add(node.id);
      const minimum = CANVAS_CONFIG.minContainerDimension, locked = nodes.some(node => aspectRatios.get(node.id));
      return this.handleDragWithPan(event, {
        move: next => {
          const keep = next.shiftKey ? !locked : locked;
          const result = resizeRect({
            handle, pointer: this.posFromEvt(next), origin, minWidth: minimum / Math.min(...share.map(item => item.width)), minHeight: minimum / Math.min(...share.map(item => item.height)),
            aspectRatio: keep && origin.height ? origin.width / origin.height : 0, snap: this.canSnap(next), resting: this.viewportNodes(true).map(bboxOf), options: this.snapOptions(),
          });
          this.showSnap(result.matchX, result.matchY, result.dx, result.dy);
          const frame = bboxOf(result.rect), { width, height } = result.rect;
          nodes.forEach((node, index) => this.patch(node.id, rectOf({ minX: frame.minX + inset[index].minX * width, minY: frame.minY + inset[index].minY * height, maxX: frame.maxX + inset[index].maxX * width, maxY: frame.maxY + inset[index].maxY * height })));
          this.host.render();
        },
        end: () => this.requestSave(),
        cancel: () => { nodes.forEach((node, index) => this.patch(node.id, start[index])); this.requestSave(); },
        cleanup: () => this.lifted.clear(),
      });
    });
  }
  onSelectionPointerdown(event: PointerEvent, target: Element): void {
    if (!event.isPrimary || event.button !== 0 || event.defaultPrevented) return;
    trackDrag(event, () => this.handleSelectionDrag(event, target));
  }

  // ---- Pointer: connections ----

  private connectTargets(point: Point, exclude: (node: CanvasNode) => boolean): { side: Side; item: CanvasNode } | null {
    const within = CANVAS_CONFIG.objectSnapDistance;
    return nearestAnchor(point, this.intersecting(growBBox({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }, within)).filter(node => !exclude(node)), bboxOf, within);
  }
  /** Draws a new connection out of a card's side. Dropped on nothing, it offers to create the card it leads to. */
  onConnectionPointerdown(event: PointerEvent, id: string, side: Side): void {
    const source = this.doc.nodes.get(id);
    if (!source || !event.isPrimary || event.button !== 0 || this.readonly) return;
    event.preventDefault(); event.stopPropagation();
    trackDrag(event, () => {
      const opposite = OPPOSITE[side];
      let edge: CanvasEdge = { id: newId(), fromNode: id, fromSide: side, fromEnd: "none", toNode: DUMMY, toSide: opposite, toEnd: "arrow", color: "", label: "", rest: {} };
      let target: { side: Side; item: CanvasNode } | null = null;
      this.connecting = true; this.deselectAll(); this.tempEdge = edge;
      const sourceBox = bboxOf(source);
      const attach = (node: CanvasNode) => { this.doc.edges.set(edge.id, { ...edge, toNode: node.id, toSide: opposite }); this.tempEdge = null; this.requestSave(); };
      return this.handleDragWithPan(event, {
        move: next => {
          const at = this.posFromEvt(next);
          this.dummy = { x: at.x, y: at.y, width: 0, height: 0 };
          target = this.connectTargets(at, node => node.id === id || (node.type === "group" && containsBBox(bboxOf(node), sourceBox)) || (source.type === "group" && containsBBox(sourceBox, bboxOf(node))));
          this.tempEdge = edge = target ? { ...edge, toNode: target.item.id, toSide: target.side } : { ...edge, toNode: DUMMY, toSide: opposite };
          this.host.render();
        },
        end: next => {
          if (target) { this.doc.edges.set(edge.id, edge); this.tempEdge = null; this.requestSave(); return; }
          if (!(next instanceof MouseEvent)) { this.tempEdge = null; return; }
          const app = this.app, at = this.posFromEvt(next), menu = new Menu();
          let kept = false;
          menu.onHide(() => setTimeout(() => { if (!kept) { this.tempEdge = null; this.host.render(); } kept = false; }, 50));
          const addFile = (file: TFile, subpath = "") => attach(this.createFileNode({ pos: at, position: opposite, file, subpath }));
          const add = async (linktext: string, sourcePath: string) => {
            kept = true;
            if (!linktext) { attach(this.createTextNode({ pos: at, position: opposite })); return; }
            const { path, subpath } = parseLinktext(linktext), found = app.metadataCache.getFirstLinkpathDest(path, sourcePath), existing = found ? app.vault.getAbstractFileByPath(found.path) : null;
            addFile(existing instanceof TFile ? existing : await createNoteFromLinktext(app, path, sourcePath), subpath);
          };
          menu.addItem(item => item.setTitle(t("plugins.canvas.action-add-card")).setSection("action").onClick(() => void add("", "")));
          menu.addItem(item => item.setTitle(t("plugins.canvas.action-add-note")).setSection("action").onClick(() => { kept = true; pickNote(app, this.host.sourcePath(), file => { kept = true; addFile(file); }, () => setTimeout(() => { if (this.tempEdge) { this.tempEdge = null; this.host.render(); } }, 50)); }));
          const file = source.type === "file" ? this.fileOf(source) : null;
          if (file) {
            const connected = new Set(this.doc.edgesOf(id).filter(other => other.fromNode === id).flatMap(other => { const to = this.doc.nodes.get(other.toNode); return to?.type === "file" ? [to.file + to.subpath] : []; }));
            let listed = 0;
            for (const link of app.metadataCache.getFileCache(file)?.links ?? []) {
              const { path, subpath } = parseLinktext(link.link), destination = app.metadataCache.getFirstLinkpathDest(path, file.path), key = destination ? destination.path + subpath : "";
              if (!destination || connected.has(key)) continue;
              connected.add(key);
              menu.addItem(item => item.setTitle(key).setSection("file").onClick(() => void add(key, file.path)));
              if (++listed >= 20) break;
            }
          }
          app.workspace.trigger("canvas:node-connection-drop-menu", menu, source, edge);
          menu.showAtMouseEvent(next);
        },
        cancel: () => { this.tempEdge = null; },
        cleanup: () => { this.connecting = false; },
      });
    });
  }
  /** Drags the nearer end of a connection to another card; dropped on nothing, the connection is removed. */
  onEdgePointerdown(event: PointerEvent, id: string, target: Element): void {
    const original = this.doc.edges.get(id);
    if (!original || !event.isPrimary || event.button !== 0 || this.readonly) return;
    event.preventDefault();
    trackDrag(event, () => {
      const geometry = this.edgeGeometry(original);
      if (!geometry) return null;
      const at = this.posFromEvt(event), end: "from" | "to" = distance(at, geometry.from) > distance(at, geometry.to) ? "to" : "from", fixed = end === "from" ? original.toNode : original.fromNode;
      let found: { side: Side; item: CanvasNode } | null = null;
      this.connecting = true; this.deselectAll(); this.hiddenEdge = id; this.tempEdge = original;
      return this.handleDragWithPan(event, {
        move: next => {
          const pointer = this.posFromEvt(next);
          this.dummy = { x: pointer.x, y: pointer.y, width: 0, height: 0 };
          found = this.connectTargets(pointer, node => node.id === fixed);
          this.tempEdge = end === "from" ? { ...original, fromNode: found ? found.item.id : DUMMY, fromSide: found ? found.side : original.fromSide } : { ...original, toNode: found ? found.item.id : DUMMY, toSide: found ? found.side : original.toSide };
          this.host.render();
        },
        end: () => { if (found && this.tempEdge) this.doc.edges.set(id, this.tempEdge); else this.doc.edges.delete(id); this.requestSave(); },
        cleanup: () => { this.connecting = false; this.tempEdge = null; this.hiddenEdge = null; suppressNext(target, "click"); },
      });
    });
  }
  onEdgeClick(event: MouseEvent, id: string): void {
    if (event.button !== 0 || this.readonly) return;
    this.wrapperEl?.focus({ preventScroll: true });
    if (event.shiftKey) this.toggleSelect(id);
    else if (this.selection.size === 1 && this.selection.has(id)) this.editEdgeLabel(id);
    else this.selectOnly(id);
  }
  onEdgeContextMenu(event: MouseEvent, id: string): void {
    const edge = this.doc.edges.get(id);
    if (!edge || event.defaultPrevented) return;
    if (this.selection.has(id) && this.selection.size > 1) { this.onSelectionContextMenu(event); return; }
    if (!this.readonly) this.selectOnly(id);
    const menu = new Menu().addSections(["canvas"]);
    if (!this.readonly) {
      menu.addItem(item => item.setSection("danger").setTitle(t("plugins.canvas.action-remove")).setIcon("lucide-trash-2").setWarning(true).onClick(() => { this.doc.edges.delete(id); this.selection.delete(id); this.selectionChanged(); this.requestSave(); }));
      menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-edit-label")).setIcon("lucide-edit").onClick(() => this.editEdgeLabel(id)));
    }
    menu.addItem(item => item.setSection("canvas").setTitle(t("plugins.canvas.action-follow-connection")).setIcon("lucide-corner-down-right").onClick(() => {
      const geometry = this.edgeGeometry(edge), at = this.posFromEvt(event);
      const node = geometry ? this.doc.nodes.get(distance(at, geometry.from) > distance(at, geometry.to) ? edge.fromNode : edge.toNode) : null;
      if (node) this.zoomToBbox(bboxOf(node));
    }));
    this.app.workspace.trigger("canvas:edge-menu", menu, edge);
    event.preventDefault(); menu.showAtMouseEvent(event);
  }

  // ---- Selection toolbar actions ----

  setColor(color: string, commit = true): void {
    for (const id of this.selection) { if (this.doc.nodes.has(id)) this.patch(id, { color }); else this.patchEdge(id, { color }); }
    if (commit) this.submenu = null;
    this.requestSave();
  }
  /** The cards an arrangement applies to: the selected cards, or the contents of a lone selected group. */
  private arrangeTargets(): [CanvasNode[], BBox] {
    const nodes = this.selectedNodes();
    if (this.selection.size === 1 && nodes[0]?.type === "group") { const box = bboxOf(nodes[0]); return [this.containedIn(box).filter(node => node.id !== nodes[0].id), growBBox(box, -20)]; }
    return [nodes, nodes.length ? unionBBox(nodes.map(bboxOf)) : { minX: 0, minY: 0, maxX: 0, maxY: 0 }];
  }
  private applyRects(rects: Map<string, Rect>): void { for (const [id, rect] of rects) this.patch(id, rect); this.requestSave(); }
  align(mode: Alignment): void { const [nodes, box] = this.arrangeTargets(); this.applyRects(alignRects(nodes, box, mode)); }
  distribute(axis: Axis): void { const [nodes, box] = this.arrangeTargets(); if (nodes.length > 1) this.applyRects(distributeRects(nodes, box, axis)); }
  justify(axis: Axis): void { const [nodes, box] = this.arrangeTargets(); if (nodes.length > 1) this.applyRects(justifyRects(nodes, box, axis)); }
  arrange(mode: Axis | "grid"): void { const [nodes, box] = this.arrangeTargets(); if (nodes.length > 1) this.applyRects(arrangeRects(nodes, box, mode, this.gridSpacing)); }
  showAlignMenu(anchor: HTMLElement): void {
    if (anchor.classList.contains("has-active-menu")) return;
    const menu = new Menu(), entry = (section: string, key: string, icon: string, run: () => void) => menu.addItem(item => item.setSection(section).setTitle(t(key)).setIcon(icon).onClick(run));
    entry("align-h", "plugins.canvas.action-align-left", "lucide-align-start-vertical", () => this.align("left"));
    entry("align-h", "plugins.canvas.action-align-center", "lucide-align-center-vertical", () => this.align("center"));
    entry("align-h", "plugins.canvas.action-align-right", "lucide-align-end-vertical", () => this.align("right"));
    entry("align-v", "plugins.canvas.action-align-top", "lucide-align-start-horizontal", () => this.align("top"));
    entry("align-v", "plugins.canvas.action-align-middle", "lucide-align-center-horizontal", () => this.align("middle"));
    entry("align-v", "plugins.canvas.action-align-bottom", "lucide-align-end-horizontal", () => this.align("bottom"));
    entry("arrange", "plugins.canvas.action-arrange-horizontally", "stack-horizontal", () => this.arrange("horizontal"));
    entry("arrange", "plugins.canvas.action-arrange-vertically", "stack-vertical", () => this.arrange("vertical"));
    entry("arrange", "plugins.canvas.action-arrange-grid", "lucide-layout-grid", () => this.arrange("grid"));
    entry("distribute", "plugins.canvas.action-distribute-horizontal-spacing", "distribute-space-horizontal", () => this.distribute("horizontal"));
    entry("distribute", "plugins.canvas.action-distribute-vertical-spacing", "distribute-space-vertical", () => this.distribute("vertical"));
    entry("justify", "plugins.canvas.action-justify-horizontally", "stretch-horizontal", () => this.justify("horizontal"));
    entry("justify", "plugins.canvas.action-justify-vertically", "stretch-vertical", () => this.justify("vertical"));
    this.showMenuBelow(menu, anchor);
  }
  private showMenuBelow(menu: Menu, anchor: HTMLElement): void {
    const box = anchor.getBoundingClientRect();
    menu.setParentElement(anchor).showAtPosition({ x: box.x, y: box.bottom, width: box.width, overlap: true }, anchor.ownerDocument);
  }
  showDirectionMenu(anchor: HTMLElement, current: string): void {
    if (anchor.classList.contains("has-active-menu")) return;
    const set = (fromEnd: EdgeEnd, toEnd: EdgeEnd) => { for (const id of this.selection) this.patchEdge(id, { fromEnd, toEnd }); this.requestSave(); };
    const menu = new Menu();
    menu.addItem(item => item.setTitle(t("plugins.canvas.label-nondirectional")).setIcon("line-horizontal").setChecked(current === "line-horizontal").onClick(() => set("none", "none")));
    menu.addItem(item => item.setTitle(t("plugins.canvas.label-unidirectional")).setIcon("lucide-arrow-right").setChecked(current === "lucide-arrow-right").onClick(() => set("none", "arrow")));
    menu.addItem(item => item.setTitle(t("plugins.canvas.label-bidirectional")).setIcon("lucide-move-horizontal").setChecked(current === "lucide-move-horizontal").onClick(() => set("arrow", "arrow")));
    this.showMenuBelow(menu, anchor);
  }
  showBackgroundMenu(anchor: HTMLElement, id: string): void {
    const group = this.doc.nodes.get(id);
    if (!group || anchor.classList.contains("has-active-menu")) return;
    const change = (patch: Partial<CanvasNode>) => { this.patch(id, patch); this.requestSave(); };
    const choose = () => pickImage(this.app, file => change({ background: file.path }));
    if (!group.background) { choose(); return; }
    const style = group.backgroundStyle, menu = new Menu();
    menu.addItem(item => item.setSection("image").setTitle(t("plugins.canvas.action-replace-background")).setIcon("lucide-repeat").onClick(choose));
    menu.addItem(item => item.setSection("image").setTitle(t("plugins.canvas.action-remove-background")).setIcon("lucide-image-off").onClick(() => change({ background: "", backgroundStyle: "" })));
    menu.addItem(item => item.setSection("style").setTitle(t("plugins.canvas.option-background-cover")).setIcon("lucide-scaling").setChecked(!style || style === "cover").onClick(() => change({ backgroundStyle: "cover" })));
    menu.addItem(item => item.setSection("style").setTitle(t("plugins.canvas.option-background-ratio")).setIcon("aspect-ratio").setChecked(style === "ratio").onClick(() => change({ backgroundStyle: "ratio" })));
    menu.addItem(item => item.setSection("style").setTitle(t("plugins.canvas.option-background-repeat")).setIcon("lucide-layout-grid").setChecked(style === "repeat").onClick(() => change({ backgroundStyle: "repeat" })));
    this.showMenuBelow(menu, anchor);
  }

  // ---- Drops ----

  private onDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (this.readonly || !["application/x-vault-path", "Files", "text/plain", "text/uri-list", "text/html"].some(type => types.includes(type))) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes("application/x-vault-path") || types.includes("Files") ? "copy" : "link";
  }
  private onDrop(event: DragEvent): void {
    const transfer = event.dataTransfer;
    if (event.defaultPrevented || !transfer || this.readonly) return;
    event.preventDefault();
    const at = this.posFromEvt(event), vaultPath = transfer.getData("application/x-vault-path");
    if (vaultPath) {
      const dropped = this.app.vault.getAbstractFileByPath(vaultPath);
      if (dropped instanceof TFile) this.createFileNode({ pos: at, file: dropped });
      else if (dropped instanceof TFolder) {
        const files: TFile[] = [], collect = (folder: TFolder) => { for (const child of folder.children) { if (child instanceof TFile) files.push(child); else if (child instanceof TFolder) collect(child); } };
        collect(dropped); files.sort((a, b) => a.basename.localeCompare(b.basename));
        this.selectAll(this.createFileNodes(files, at).map(node => node.id)); this.requestSave();
      }
      this.wrapperEl?.focus();
      return;
    }
    const files = [...transfer.files];
    if (files.length) { void this.importAttachments(files).then(created => { this.createFileNodes(created, at); this.requestSave(); }); return; }
    const text = textOf(transfer);
    if (isWebUrl(text)) this.createLinkNode({ pos: at, position: "center", url: text });
    else if (text) this.createTextNode({ pos: at, position: "center", text });
  }
}

function textOf(transfer: DataTransfer | null | undefined): string {
  if (!transfer) return "";
  const plain = transfer.getData("text/plain");
  if (plain) return plain;
  const uri = transfer.getData("text/uri-list").split("\n")[0].trim();
  if (uri) return uri;
  const html = transfer.getData("text/html");
  return html ? new DOMParser().parseFromString(html, "text/html").body.textContent ?? "" : "";
}
function isWebUrl(text: string): boolean { try { const url = new URL(text); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } }
function promptRename(app: App, file: TFile): void {
  new TextPromptModal(app, t(file.extension === "md" ? "dialogue.label-rename-file" : "dialogue.label-rename-file-generic"), file.basename, name => {
    const parent = file.parent && file.parent.path !== "/" && file.parent.path ? file.parent.path + "/" : "";
    void app.fileManager.renameFile(file, `${parent}${name}.${file.extension}`).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
  }).open();
}
