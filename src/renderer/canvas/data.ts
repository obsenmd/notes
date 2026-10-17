import { bboxOf, centerOf, facingSide, pointsBBox, sideAnchor, unionBBox, type EdgeEnd, type Point, type Rect, type Side } from "./geometry";

/** A card as written in a `.canvas` file (JSON Canvas); fields this app does not know are kept as they are. */
export interface CanvasNodeData { id: string; type: "text" | "file" | "link" | "group" | string; x: number; y: number; width: number; height: number; color?: string; text?: string; file?: string; subpath?: string; url?: string; label?: string; background?: string; backgroundStyle?: string; [key: string]: unknown }
export interface CanvasEdgeData { id: string; fromNode: string; fromSide?: Side; toNode: string; toSide?: Side; fromEnd?: EdgeEnd; toEnd?: EdgeEnd; color?: string; label?: string; [key: string]: unknown }
/** A JSON Canvas document; unknown top-level fields are preserved. */
export interface CanvasData { nodes: CanvasNodeData[]; edges: CanvasEdgeData[]; [key: string]: unknown }

export function parseCanvas(source: string): CanvasData {
  if (!source.trim()) return { nodes: [], edges: [] };
  const parsed = JSON.parse(source) as Partial<CanvasData>;
  return { ...parsed, nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
}

const flat = (value: unknown) => typeof value !== "object";
function lines(value: unknown): string[] {
  if (value === undefined) return ["null"];
  if (flat(value) || !value || Object.prototype.toString.call(value) === "[object Date]") return [JSON.stringify(value)];
  const nest = (parts: string[], last: boolean, out: string[]) => parts.forEach((part, index) => out.push("\t" + part + (index === parts.length - 1 && !last ? "," : "")));
  if (Array.isArray(value)) {
    if (value.every(flat)) return [JSON.stringify(value)];
    const out = ["["];
    value.forEach((item, index) => nest(lines(item), index === value.length - 1, out));
    return [...out, "]"];
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).every(key => flat(record[key]))) return [JSON.stringify(record)];
  const out = ["{"], keys = Object.keys(record).filter(key => record[key] !== undefined);
  keys.forEach((key, index) => { const parts = lines(record[key]); parts[0] = JSON.stringify(key) + ":" + parts[0]; nest(parts, index === keys.length - 1, out); });
  return [...out, "}"];
}
/** The reference's file layout: tab-indented, with every card and connection on one line. */
export const serializeCanvas = (data: unknown): string => lines(data).join("\n");

const PRESET = /^(\d+)$/, RGB_TRIPLE = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/i;
export const isPresetColor = (color: string) => PRESET.test(color);
/** Colours are a preset number ("1"-"6") or hex; an "r,g,b" triple from older files becomes hex. */
export function normalizeColor(color: unknown): string {
  if (typeof color !== "string") return "";
  const triple = color.match(RGB_TRIPLE);
  return triple ? "#" + [triple[1], triple[2], triple[3]].map(part => Math.min(255, parseInt(part)).toString(16).padStart(2, "0")).join("") : color;
}
export function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color.trim()), long = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(color.trim());
  const parts = short ? short.slice(1).map(part => part + part) : long ? long.slice(1) : null;
  return parts ? { r: parseInt(parts[0], 16), g: parseInt(parts[1], 16), b: parseInt(parts[2], 16) } : null;
}
export const isLightColor = ({ r, g, b }: { r: number; g: number; b: number }) => (299 * r + 587 * g + 114 * b) / 1000 >= 150;

export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, "0")).join("");

export type NodeType = "text" | "file" | "link" | "group";
/** A card on the canvas. `rest` holds the file's other fields in their original order. */
export interface CanvasNode extends Rect {
  id: string; type: NodeType; color: string; z: number; rest: Record<string, unknown>;
  /** Created but not yet drawn: the reference gives a card its place in the stack on its first frame, so until then it is saved first. */
  unplaced?: boolean;
  text: string; file: string; subpath: string; url: string; label: string; background: string; backgroundStyle: string;
}
export interface CanvasEdge { id: string; fromNode: string; fromSide: Side; fromEnd: EdgeEnd; toNode: string; toSide: Side; toEnd: EdgeEnd; color: string; label: string; rest: Record<string, unknown> }
export const NODE_TYPES = new Set(["text", "file", "link", "group"]);

const without = (source: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
const round = (value: unknown, fallback: number) => { const number = Math.round(Number(value)); return isNaN(number) ? fallback : number; };
const text = (value: unknown) => typeof value === "string" ? value : "";

export function readNode(raw: CanvasNodeData, previous?: CanvasNode): CanvasNode {
  const type = raw.type as NodeType;
  return {
    id: raw.id, type, x: round(raw.x, previous?.x ?? 0), y: round(raw.y, previous?.y ?? 0), width: round(raw.width, previous?.width ?? 100), height: round(raw.height, previous?.height ?? 100),
    color: normalizeColor(raw.color), z: previous?.z ?? -1,
    rest: without(raw, type === "group" ? ["x", "y", "width", "height", "color", "label", "background", "backgroundStyle"] : ["x", "y", "width", "height", "color"]),
    text: type === "text" ? text(raw.text) : "", file: type === "file" ? text(raw.file) : "", subpath: type === "file" ? text(raw.subpath) : "", url: type === "link" ? text(raw.url) : "",
    label: type === "group" ? text(raw.label) : "", background: type === "group" ? text(raw.background) : "", backgroundStyle: type === "group" && raw.background ? text(raw.backgroundStyle) : "",
  };
}
export function writeNode(node: CanvasNode): CanvasNodeData {
  const data: Record<string, unknown> = { ...node.rest, id: node.id, x: node.x, y: node.y, width: node.width, height: node.height };
  if (node.color) data.color = node.color;
  data.type = node.type;
  if (node.type === "file") { data.file = node.file; data.subpath = node.subpath || undefined; }
  else if (node.type === "text") data.text = node.text;
  else if (node.type === "link") data.url = node.url;
  else {
    if (node.label) data.label = node.label;
    if (node.background) { data.background = node.background; if (node.backgroundStyle && node.backgroundStyle !== "cover") data.backgroundStyle = node.backgroundStyle; }
  }
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  return data as CanvasNodeData;
}
export function readEdge(raw: CanvasEdgeData, from: Rect, to: Rect): CanvasEdge {
  return {
    id: raw.id, fromNode: raw.fromNode, toNode: raw.toNode, fromSide: raw.fromSide ?? facingSide(from, to), toSide: raw.toSide ?? facingSide(to, from),
    fromEnd: raw.fromEnd || "none", toEnd: raw.toEnd || "arrow", color: normalizeColor(raw.color), label: text(raw.label),
    rest: without(raw, ["fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"]),
  };
}
export function writeEdge(edge: CanvasEdge): CanvasEdgeData {
  const data: Record<string, unknown> = { ...edge.rest, id: edge.id, fromNode: edge.fromNode, fromSide: edge.fromSide, toNode: edge.toNode, toSide: edge.toSide };
  if (edge.fromEnd !== "none") data.fromEnd = edge.fromEnd;
  if (edge.toEnd !== "arrow") data.toEnd = edge.toEnd;
  if (edge.color) data.color = edge.color;
  if (edge.label) data.label = edge.label;
  return data as CanvasEdgeData;
}

/** Groups sit below cards, larger ones below smaller ones; cards stack in the order they were last touched. */
export const stackOrder = (node: CanvasNode) => node.unplaced ? -1 : node.type === "group" ? Math.round(-node.width * node.height) : node.z;
export const byStack = (a: CanvasNode, b: CanvasNode) => stackOrder(a) - stackOrder(b);

/** The cards and connections of a document. Cards of a type this app cannot show are carried along untouched. */
export class CanvasDocument {
  nodes = new Map<string, CanvasNode>();
  edges = new Map<string, CanvasEdge>();
  /** Raw cards of unknown types, with the index they had in the file. */
  foreign: Array<{ index: number; data: CanvasNodeData }> = [];
  private counter = 1;

  nextZ(): number { return ++this.counter; }
  get topZ(): number { return this.counter; }

  /** Applies file data; with `replace`, cards and connections missing from it are removed. Returns the cards it touched. */
  load(data: Partial<CanvasData>, replace: boolean, preserveStack = false): CanvasNode[] {
    const touched: CanvasNode[] = [];
    if (!Array.isArray(data.nodes)) return touched;
    const seen = new Set<string>(), foreign: CanvasDocument["foreign"] = [];
    let highest = 0;
    data.nodes.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return;
      if (!NODE_TYPES.has(raw.type)) { foreign.push({ index, data: raw }); return; }
      const node = readNode(raw, this.nodes.get(raw.id));
      // File loads need to make file order monotonic. During history replay, keep
      // the live ranks of existing cards and give only newly restored cards a
      // fresh top rank, matching the reference's incremental stack behavior.
      if (node.z < 0 || (!preserveStack && node.z < highest)) node.z = this.nextZ();
      highest = Math.max(highest, node.z);
      this.nodes.set(node.id, node); seen.add(node.id); touched.push(node);
    });
    if (replace) { this.foreign = foreign; for (const id of [...this.nodes.keys()]) if (!seen.has(id)) this.removeNode(id); }
    if (!Array.isArray(data.edges)) return touched;
    const kept = new Set<string>();
    for (const raw of data.edges) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string") continue;
      const from = this.nodes.get(raw.fromNode), to = this.nodes.get(raw.toNode);
      if (from && to) { this.edges.set(raw.id, readEdge(raw, from, to)); kept.add(raw.id); } else this.edges.delete(raw.id);
    }
    if (replace) for (const id of [...this.edges.keys()]) if (!kept.has(id)) this.edges.delete(id);
    return touched;
  }

  /** The document as it is saved: `base` supplies the top-level fields this app does not own. */
  save(base: Record<string, unknown> = {}): CanvasData {
    const nodes = [...this.nodes.values()].sort(byStack).map(writeNode);
    for (const { index, data } of [...this.foreign].sort((a, b) => a.index - b.index)) nodes.splice(Math.min(index, nodes.length), 0, data);
    return { ...base, nodes, edges: [...this.edges.values()].map(writeEdge) };
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    for (const edge of [...this.edges.values()]) if (edge.fromNode === id || edge.toNode === id) this.edges.delete(edge.id);
  }
  edgesOf(id: string): CanvasEdge[] { return [...this.edges.values()].filter(edge => edge.fromNode === id || edge.toNode === id); }

  /** Cards and the connections between them, as they are put on the clipboard. */
  selectionData(ids: Iterable<string>): { nodes: CanvasNodeData[]; edges: CanvasEdgeData[]; center: Point } {
    const chosen = new Set(ids), nodes = [...this.nodes.values()].filter(node => chosen.has(node.id)).sort(byStack);
    const edges = [...this.edges.values()].filter(edge => chosen.has(edge.fromNode) && chosen.has(edge.toNode));
    const boxes = [...nodes.map(bboxOf), ...[...this.edges.values()].filter(edge => chosen.has(edge.id)).flatMap(edge => {
      const from = this.nodes.get(edge.fromNode), to = this.nodes.get(edge.toNode);
      return from && to ? [pointsBBox(sideAnchor(bboxOf(from), edge.fromSide), sideAnchor(bboxOf(to), edge.toSide))] : [];
    })];
    return { nodes: nodes.map(writeNode), edges: edges.map(writeEdge), center: boxes.length ? centerOf(unionBBox(boxes)) : { x: 0, y: 0 } };
  }
}

/** Gives copied cards and connections fresh ids (optionally shifted), keeping the connections attached. */
export function cloneData<T extends { nodes: CanvasNodeData[]; edges: CanvasEdgeData[] }>(data: T, offset?: Point | null): T {
  const ids: Record<string, string> = {};
  for (const node of data.nodes) { const id = newId(); ids[node.id] = id; node.id = id; if (offset) { node.x += offset.x; node.y += offset.y; } }
  for (const edge of data.edges) { edge.fromNode = ids[edge.fromNode] || ""; edge.toNode = ids[edge.toNode] || ""; edge.id = newId(); }
  return data;
}

/** Undo stack of whole-document snapshots. */
export class CanvasHistory<T> {
  private data: T[] = [];
  private current = 0;
  constructor(private readonly max = 100) {}
  canUndo(): boolean { return this.current > 0; }
  undo(): T | null { return this.canUndo() ? this.data[--this.current] : null; }
  canRedo(): boolean { return this.current < this.data.length - 1; }
  redo(): T | null { return this.canRedo() ? this.data[++this.current] : null; }
  push(entry: T): void {
    if (this.data.length - 1 > this.current) this.data.length = this.current + 1;
    this.data.push(entry);
    if (this.data.length >= this.max) this.data.shift();
    this.current = this.data.length - 1;
  }
  replace(entry: T): void { if (!this.data.length) { this.data.push(entry); this.current = 0; } else this.data[this.current] = entry; }
  clear(): void { this.data.length = 0; this.current = 0; }
}

/** Options stored in `.obsidian/canvas.json`. */
export interface CanvasOptions {
  snapToObjects: boolean; snapToGrid: boolean;
  newFileLocation?: "root" | "current" | "folder"; newFileFolderPath?: string;
  defaultWheelBehavior?: "pan" | "zoom"; defaultModDragBehavior?: "menu" | "card" | "note" | "media" | "webpage" | "group";
  cardLabelVisibility?: "always" | "hover" | "never"; zoomBreakpoint?: number;
  [key: string]: unknown;
}
export const DEFAULT_CANVAS_OPTIONS: CanvasOptions = { snapToObjects: true, snapToGrid: true };
export const CANVAS_CONFIG = { zoomMultiplier: 0.5, objectSnapDistance: 15, minContainerDimension: 50, defaultTextNodeDimensions: { width: 250, height: 60 }, defaultFileNodeDimensions: { width: 400, height: 400 } };
/** Zoom (log2) at or below which card contents are replaced by placeholders. */
export const ZOOM_BREAKPOINT = -1.7;
