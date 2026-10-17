/** Pure canvas geometry: boxes, connection paths, snapping and layout. Shared by the canvas surface and its tests. */

export type Side = "top" | "right" | "bottom" | "left";
export type ResizeHandle = Side | "topright" | "bottomright" | "bottomleft" | "topleft";
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export const SIDES: Side[] = ["top", "right", "bottom", "left"];
export const CORNERS: ResizeHandle[] = ["topright", "bottomright", "bottomleft", "topleft"];
export const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

export const bboxOf = (rect: Rect): BBox => ({ minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height });
export const rectOf = (box: BBox): Rect => ({ x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY });
export const pointsBBox = (a: Point, b: Point): BBox => ({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });
export function unionBBox(boxes: BBox[]): BBox {
  const all = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const box of boxes) { all.minX = Math.min(all.minX, box.minX); all.minY = Math.min(all.minY, box.minY); all.maxX = Math.max(all.maxX, box.maxX); all.maxY = Math.max(all.maxY, box.maxY); }
  return all;
}
export const growBBox = (box: BBox, by: number): BBox => ({ minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by });
export const containsBBox = (outer: BBox, inner: BBox) => outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
export const intersectsBBox = (a: BBox, b: BBox) => b.minX <= a.maxX && b.minY <= a.maxY && b.maxX >= a.minX && b.maxY >= a.minY;
export const sameBBox = (a: BBox, b: BBox) => a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
export const centerOf = (box: BBox): Point => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Where a new card of `size` goes for a pointer position: centred on it, or attached to it by one of its sides. */
export function placeRect(pos: Point, size: Size, position?: "center" | Side): Rect {
  const { width, height } = size;
  if (position === "center") return { x: pos.x - width / 2, y: pos.y - height / 2, width, height };
  if (position === "left") return { x: pos.x, y: pos.y - height / 2, width, height };
  if (position === "top") return { x: pos.x - width / 2, y: pos.y, width, height };
  if (position === "right") return { x: pos.x - width, y: pos.y - height / 2, width, height };
  if (position === "bottom") return { x: pos.x - width / 2, y: pos.y - height, width, height };
  return { x: pos.x, y: pos.y, width, height };
}

// ---- Connections ----

export function sideAnchor(box: BBox, side: Side): Point {
  if (side === "top") return { x: (box.minX + box.maxX) / 2, y: box.minY };
  if (side === "right") return { x: box.maxX, y: (box.minY + box.maxY) / 2 };
  if (side === "bottom") return { x: (box.minX + box.maxX) / 2, y: box.maxY };
  return { x: box.minX, y: (box.minY + box.maxY) / 2 };
}
const push = (side: Side, point: Point, by: number): Point =>
  side === "left" ? { x: point.x - by, y: point.y } : side === "right" ? { x: point.x + by, y: point.y } : side === "top" ? { x: point.x, y: point.y - by } : { x: point.x, y: point.y + by };

/** The side of `from` that faces `to`, used when a connection does not name one. */
export function facingSide(from: Rect, to: Rect): Side {
  const a = centerOf(bboxOf(from)), b = centerOf(bboxOf(to));
  const angle = Math.atan2(b.y - a.y, b.x - a.x), corner = Math.atan2(from.height, from.width);
  return angle > -corner && angle <= corner ? "right" : angle > corner && angle <= Math.PI - corner ? "bottom" : angle > Math.PI - corner || angle <= -(Math.PI - corner) ? "left" : "top";
}

export interface Bezier { from: Point; to: Point; cp1: Point; cp2: Point; path: string }
export function bezier(from: Point, fromSide: Side, to: Point, toSide: Side): Bezier {
  const reach = clamp(distance(from, to) / 2, 70, 150), cp1 = push(fromSide, from, reach), cp2 = push(toSide, to, reach);
  return { from, to, cp1, cp2, path: `M${from.x},${from.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${to.x},${to.y}` };
}
export function bezierPoint(t: number, curve: Bezier): Point {
  const u = 1 - t, a = u * u * u, b = 3 * t * u * u, c = 3 * t * t * u, d = t * t * t;
  return { x: a * curve.from.x + b * curve.cp1.x + c * curve.cp2.x + d * curve.to.x, y: a * curve.from.y + b * curve.cp1.y + c * curve.cp2.y + d * curve.to.y };
}

export type EdgeEnd = "none" | "arrow";
export const ARROW_POINTS = "0,0 6.5,10.4 -6.5,10.4";
export const ARROW_ROTATION: Record<Side, string> = { top: "180", bottom: "0", left: "90", right: "270" };
export interface EdgeGeometry { path: string; curve: Bezier; from: Point; to: Point; center: Point }
/** The drawn path of a connection: the curve runs between points 7px off each card, an arrow or a straight stub covering the gap. */
export function edgeGeometry(fromBox: BBox, fromSide: Side, fromEnd: EdgeEnd, toBox: BBox, toSide: Side, toEnd: EdgeEnd): EdgeGeometry {
  const from = sideAnchor(fromBox, fromSide), start = push(fromSide, from, 7), to = sideAnchor(toBox, toSide), end = push(toSide, to, 7);
  const curve = bezier(start, fromSide, end, toSide);
  let path = curve.path;
  if (fromEnd !== "arrow") path = `M${from.x} ${from.y} L${start.x} ${start.y} ${path}`;
  if (toEnd !== "arrow") path = `${path} M${end.x} ${end.y} L${to.x} ${to.y}`;
  return { path, curve, from, to, center: bezierPoint(0.5, curve) };
}

/** The connection point nearest to `point` among `boxes`; the first one within `within` wins outright. */
export function nearestAnchor<T>(point: Point, items: T[], box: (item: T) => BBox, within: number): { side: Side; item: T } | null {
  let best: { side: Side; item: T } | null = null, bestDistance = Infinity;
  for (const item of items) for (const side of SIDES) {
    const d = distance(point, sideAnchor(box(item), side));
    if (d <= within) return { side, item };
    if (d < bestDistance) { bestDistance = d; best = { side, item }; }
  }
  return best;
}

// ---- Snapping ----

export const gridSpacing = (zoom: number) => zoom < -3.3 ? 160 : zoom < -2.16 ? 80 : zoom < -0.91 ? 40 : 20;

/** The points of a set of boxes that can align with others: corners and centres, without duplicates. */
export function snapPoints(boxes: BBox[]): Point[] {
  const points = boxes.flatMap(({ minX, minY, maxX, maxY }) => [{ x: minX, y: minY }, { x: minX, y: maxY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }]);
  points.sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  return points.filter((point, index) => !index || points[index - 1].x !== point.x || points[index - 1].y !== point.y);
}

export interface SnapMatch { matches: Array<{ src: Point[]; dest: Point[] }>; delta: number }
/** The smallest shift along one axis (at most `within`) that lines moving points up with resting ones. */
export function matchSnap(source: Point[], target: Point[], within: number, axis: "x" | "y"): SnapMatch | null {
  if (!source.length || !target.length) return null;
  const at = (point: Point) => point[axis];
  const src = [...source].sort((a, b) => at(a) - at(b)), dest = [...target].sort((a, b) => at(a) - at(b));
  let delta = within, matches: SnapMatch["matches"] = [], from: Point[] = [], to: Point[] = [], last = Infinity;
  for (const point of src) {
    const value = at(point);
    if (value === last) { if (from.length && at(from[from.length - 1]) === value) from.push(point); continue; }
    last = value;
    if (from.length || to.length) { matches.push({ src: from, dest: to }); from = []; to = []; }
    let low = 0, high = dest.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1, difference = value - at(dest[middle]);
      if (difference > 0) low = middle + 1;
      else if (difference < 0) high = middle - 1;
      else { low = high = middle; break; }
    }
    if (low !== high) {
      if (high < 0) high = 0;
      else if (low >= dest.length - 1) low = dest.length - 1;
      else {
        const above = at(dest[low]) - value, below = value - at(dest[high]);
        if (above === below) { if (above === delta) high = low; else low = high; } else low = high = above < below ? low : high;
      }
    }
    const nearest = at(dest[low]), shift = nearest - value;
    if (shift === delta || Math.abs(shift) < Math.abs(delta)) {
      if (shift !== delta) { matches = []; from = []; to = []; delta = shift; }
      while (low > 0 && at(dest[low - 1]) === nearest) low--;
      while (high < dest.length - 1 && at(dest[high + 1]) === nearest) high++;
      from.push(point);
      for (let index = low; index <= high; index++) to.push(dest[index]);
    }
  }
  if (from.length || to.length) matches.push({ src: from, dest: to });
  return matches.length ? { matches, delta } : null;
}

export interface SnapOptions { snapToGrid: boolean; snapToObjects: boolean; snapDistance: number; gridSpacing: number }
export interface SnapResult extends Point { x: number; y: number; matchX: SnapMatch | null; matchY: SnapMatch | null }
/** Correction for boxes being moved: objects win over the grid, each axis is decided separately. */
export function snapMove(moving: BBox[], resting: BBox[], moveX: boolean, moveY: boolean, options: SnapOptions): SnapResult {
  let x = 0, y = 0, matchX: SnapMatch | null = null, matchY: SnapMatch | null = null;
  if (!moving.length) return { x, y, matchX, matchY };
  if (options.snapToObjects) {
    const source = snapPoints(moving), target = snapPoints(resting);
    if ((matchX = matchSnap(source, target, moveX ? options.snapDistance : 0, "x"))) x += matchX.delta;
    if ((matchY = matchSnap(source, target, moveY ? options.snapDistance : 0, "y"))) y += matchY.delta;
  }
  if (options.snapToGrid && (!matchX || !matchY)) {
    const bounds = unionBBox(moving), grid = options.gridSpacing;
    if (!matchX && moveX) x += Math.round(bounds.minX / grid) * grid - bounds.minX;
    if (!matchY && moveY) y += Math.round(bounds.minY / grid) * grid - bounds.minY;
  }
  return { x, y, matchX, matchY };
}

/** Guide circles and lines for a snap: the matched points after the correction has been applied. */
export function snapGuides(matchX: SnapMatch | null, matchY: SnapMatch | null, dx: number, dy: number): Array<{ points: Point[]; line: [Point, Point] }> {
  return [...(matchX?.matches ?? []), ...(matchY?.matches ?? [])].map(({ src, dest }) => {
    const points = [...src.map(point => ({ x: point.x + dx, y: point.y + dy })), ...dest];
    const box = unionBBox(points.map(point => ({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y })));
    return { points, line: [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.maxY }] as [Point, Point] };
  });
}

/** The point a resize handle drags, and the axes it changes. */
export function resizeSource(handle: ResizeHandle, pointer: Point, rect: Rect): { source: Rect; resizeX: boolean; resizeY: boolean } {
  if (handle === "top" || handle === "bottom") return { source: { x: rect.x, y: pointer.y, width: rect.width, height: 0 }, resizeX: false, resizeY: true };
  if (handle === "left" || handle === "right") return { source: { x: pointer.x, y: rect.y, width: 0, height: rect.height }, resizeX: true, resizeY: false };
  return { source: { x: pointer.x, y: pointer.y, width: 0, height: 0 }, resizeX: true, resizeY: true };
}

export interface ResizeInput { handle: ResizeHandle; pointer: Point; origin: Rect; minWidth: number; minHeight: number; aspectRatio: number; snap: boolean; resting: BBox[]; options: SnapOptions }
export interface ResizeOutput { rect: Rect; matchX: SnapMatch | null; matchY: SnapMatch | null; dx: number; dy: number }
/** One step of dragging a resize handle: snapping, minimum size and a locked aspect ratio. */
export function resizeRect({ handle, pointer, origin, minWidth, minHeight, aspectRatio, snap, resting, options }: ResizeInput): ResizeOutput {
  const { source, resizeX, resizeY } = resizeSource(handle, pointer, origin);
  let matchX: SnapMatch | null = null, matchY: SnapMatch | null = null, dx = 0, dy = 0;
  if (snap) {
    if (options.snapToObjects) {
      const points = snapPoints([bboxOf(source)]), target = snapPoints(resting);
      if (resizeX && (matchX = matchSnap(points, target, options.snapDistance, "x"))) dx = matchX.delta;
      if (resizeY && (matchY = matchSnap(points, target, options.snapDistance, "y"))) dy = matchY.delta;
    }
    if (options.snapToGrid) {
      const grid = options.gridSpacing;
      if (resizeX && !matchX) dx = Math.round(pointer.x / grid) * grid - pointer.x;
      if (resizeY && !matchY) dy = Math.round(pointer.y / grid) * grid - pointer.y;
    }
  }
  const x = pointer.x + dx, y = pointer.y + dy, box = bboxOf(origin);
  if (handle.includes("top")) { box.minY = Math.min(box.maxY - minHeight, y); if (box.minY !== y) { matchY = null; dy = box.minY - pointer.y; } }
  if (handle.includes("left")) { box.minX = Math.min(box.maxX - minWidth, x); if (box.minX !== x) { matchX = null; dx = box.minX - pointer.x; } }
  if (handle.includes("bottom")) { box.maxY = Math.max(box.minY + minHeight, y); if (box.maxY !== y) { matchY = null; dy = box.maxY - pointer.y; } }
  if (handle.includes("right")) { box.maxX = Math.max(box.minX + minWidth, x); if (box.maxX !== x) { matchX = null; dx = box.maxX - pointer.x; } }
  const rect = rectOf(box);
  if (aspectRatio) {
    let width = rect.width, height = rect.height;
    if (resizeX && resizeY) {
      const wide = Math.max(width, height * aspectRatio);
      height = Math.max(height, width / aspectRatio); width = wide;
      if (width !== rect.width) matchX = null; else if (height !== rect.height) matchY = null;
    } else if (resizeX) height = width / aspectRatio;
    else if (resizeY) width = height * aspectRatio;
    if (handle.includes("left")) { const left = origin.x + origin.width - width; dx += left - rect.x; rect.x = left; }
    if (handle.includes("top")) { const top = origin.y + origin.height - height; dy += top - rect.y; rect.y = top; }
    if (handle.includes("right")) dx += width - rect.width;
    if (handle.includes("bottom")) dy += height - rect.height;
    rect.width = width; rect.height = height;
  }
  return { rect, matchX, matchY, dx, dy };
}

// ---- Arranging a selection ----

export type Placed<T> = T & Rect;
type Move = Map<string, Rect>;
const moved = <T extends Rect & { id: string }>(items: T[]): Move => new Map(items.map(item => [item.id, { x: item.x, y: item.y, width: item.width, height: item.height }]));

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";
export function alignRects<T extends Rect & { id: string }>(items: T[], bounds: BBox, mode: Alignment): Move {
  const result = moved(items);
  for (const rect of result.values()) {
    if (mode === "left") rect.x = bounds.minX;
    else if (mode === "right") rect.x = bounds.maxX - rect.width;
    else if (mode === "top") rect.y = bounds.minY;
    else if (mode === "bottom") rect.y = bounds.maxY - rect.height;
    else if (mode === "center") rect.x = (bounds.minX + bounds.maxX - rect.width) / 2;
    else rect.y = (bounds.minY + bounds.maxY - rect.height) / 2;
  }
  return result;
}

export type Axis = "horizontal" | "vertical";
/** Equal gaps between the first and the last card; those two stay where they are. */
export function distributeRects<T extends Rect & { id: string }>(items: T[], bounds: BBox, axis: Axis): Move {
  const result = moved(items);
  if (items.length <= 1) return result;
  const rects = [...result.values()];
  if (axis === "horizontal") {
    rects.sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const gap = (bounds.maxX - bounds.minX - rects.reduce((sum, rect) => sum + rect.width, 0)) / (rects.length - 1);
    for (let index = 1; index < rects.length - 1; index++) rects[index].x = rects[index - 1].x + rects[index - 1].width + gap;
  } else {
    rects.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
    const gap = (bounds.maxY - bounds.minY - rects.reduce((sum, rect) => sum + rect.height, 0)) / (rects.length - 1);
    for (let index = 1; index < rects.length - 1; index++) rects[index].y = rects[index - 1].y + rects[index - 1].height + gap;
  }
  return result;
}

/** Stretch every card across the selection's width or height. */
export function justifyRects<T extends Rect & { id: string }>(items: T[], bounds: BBox, axis: Axis): Move {
  const result = moved(items);
  if (items.length <= 1) return result;
  for (const rect of result.values()) {
    if (axis === "horizontal") { rect.x = bounds.minX; rect.width = bounds.maxX - bounds.minX; } else { rect.y = bounds.minY; rect.height = bounds.maxY - bounds.minY; }
  }
  return result;
}

/** Lay cards out in reading order as a row, a column, or rows of overlapping bands. */
export function arrangeRects<T extends Rect & { id: string }>(items: T[], bounds: BBox, mode: Axis | "grid", spacing: number): Move {
  const result = moved(items);
  if (items.length <= 1) return result;
  const rects = [...result.values()].sort((a, b) => a.y - b.y);
  const rows: Rect[][] = []; let bottom = -Infinity;
  for (const rect of rects) {
    if (rect.y < bottom) { rows[rows.length - 1].push(rect); if (rect.y + rect.height < bottom) bottom = rect.y + rect.height; }
    else { rows.push([rect]); bottom = rect.y + rect.height; }
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  const ordered = rows.flat();
  if (mode === "horizontal") for (let index = 1; index < ordered.length; index++) { const previous = ordered[index - 1]; ordered[index].x = previous.x + previous.width + spacing; ordered[index].y = previous.y; }
  else if (mode === "vertical") for (let index = 1; index < ordered.length; index++) { const previous = ordered[index - 1]; ordered[index].x = previous.x; ordered[index].y = previous.y + previous.height + spacing; }
  else {
    let top = bounds.minY;
    for (const row of rows) {
      row[0].x = bounds.minX; row[0].y = top;
      let height = row[0].height;
      for (let index = 1; index < row.length; index++) { row[index].x = row[index - 1].x + row[index - 1].width + spacing; row[index].y = top; height = Math.max(height, row[index].height); }
      top += height + spacing;
    }
  }
  return result;
}

/** Arrow-key movement: one grid step (five with Shift), first landing on the grid when snapping is on. */
export function nudgeDelta(direction: "up" | "down" | "left" | "right", shift: boolean, spacing: number, snapToGrid: boolean, bounds: BBox): Point {
  const step = shift ? 5 * spacing : spacing, delta = { x: 0, y: 0 };
  if (direction === "down") delta.y = step; else if (direction === "up") delta.y = -step; else if (direction === "left") delta.x = -step; else delta.x = step;
  if (snapToGrid) {
    const offset = { x: Math.round(bounds.minX % spacing), y: Math.round(bounds.minY % spacing) };
    if ((direction === "left" || direction === "right") && offset.x > 0) { delta.x = -offset.x; if (direction === "right") delta.x += spacing; }
    else if ((direction === "up" || direction === "down") && offset.y > 0) { delta.y = -offset.y; if (direction === "down") delta.y += spacing; }
  }
  return delta;
}

/** Zoom level (log2 of the scale) and centre that frame a box in a viewport. */
export function frameBBox(box: BBox, viewport: Size): { x: number; y: number; zoom: number } | null {
  if (!viewport.width || !viewport.height) return null;
  const scale = clamp(Math.min(viewport.width / (1.1 * (box.maxX - box.minX)), viewport.height / (1.1 * (box.maxY - box.minY))), -4, 1);
  return { ...centerOf(box), zoom: Math.log2(scale) };
}
