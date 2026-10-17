// Adapted from the user-authored obsen-sync/web graph viewer.

import { useEffect, useRef, useState } from 'react';
import { createGraphWorker } from '../../platforms/platform';

function noteTitle(path: string) { return path.split("/").pop()?.replace(/\.md$/i, "") ?? path; }

export type GraphData = { nodes: string[]; edges: [number, number][] };
export interface GraphOptions {
  centerStrength: number; linkStrength: number; linkDistance: number; repelStrength: number;
  nodeScale: number; linkWidth: number; textFade: number; arrows: boolean;
  /** Base label size in CSS pixels (defaults to 14). */
  labelSize?: number;
  groups: Array<{ query: string; color: string }>;
}
type Point = { x: number; y: number };
type WorkerFrame = { ignore?: boolean; shared?: SharedArrayBuffer; id?: string[]; buffer?: ArrayBufferLike };
type PixiDisplayObject = {
  position: { set(x: number, y: number): void };
  scale: { set(x: number, y?: number): void };
  anchor?: { set(x: number, y?: number): void };
  visible: boolean;
  alpha: number;
  destroy(options?: unknown): void;
};
type PixiContainer = PixiDisplayObject & { addChild<T extends PixiDisplayObject>(child: T): T };
type PixiGraphics = PixiDisplayObject & {
  clear(): PixiGraphics;
  lineStyle(width: number, color: number, alpha?: number): PixiGraphics;
  moveTo(x: number, y: number): PixiGraphics;
  lineTo(x: number, y: number): PixiGraphics;
  beginFill(color: number, alpha?: number): PixiGraphics;
  drawCircle(x: number, y: number, radius: number): PixiGraphics;
  endFill(): PixiGraphics;
};
type PixiText = PixiDisplayObject & { text: string; style: { fill: number; fontFamily: string } };
type PixiApplication = {
  stage: PixiContainer;
  renderer: { resize(width: number, height: number): void; render(stage: PixiContainer): void };
  ticker: { stop(): void };
  destroy(removeView?: boolean, options?: unknown): void;
};
type PixiNamespace = {
  Application: new (options: Record<string, unknown>) => PixiApplication;
  Container: new () => PixiContainer;
  Graphics: new () => PixiGraphics;
  Text: new (text: string, style: Record<string, unknown>) => PixiText;
  utils: { string2hex(value: string): number };
};

let pixiLoading: Promise<PixiNamespace> | undefined;
function loadPixi(): Promise<PixiNamespace> {
  return pixiLoading ??= (async () => {
    const host = window as unknown as { PIXI?: PixiNamespace };
    const loadScript = (filename: string) => new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(filename, document.baseURI).href;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { script.remove(); reject(new Error(`Unable to load ${filename}`)); };
      document.head.append(script);
    });
    if (!host.PIXI) await loadScript("pixi.min.js");
    await loadScript("unsafe-eval.min.js");
    return host.PIXI!;
  })().catch(error => { pixiLoading = undefined; throw error; });
}

let colorProbe: HTMLElement | null = null;
function colorValue(pixi: PixiNamespace, value: string, fallback: string) {
  const color = value.trim() || fallback;
  const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) return pixi.utils.string2hex(color);
  let rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgb) {
    // Theme variables may resolve to hsl() or color-mix(); let the browser compute them.
    if (!colorProbe) { colorProbe = document.createElement('span'); colorProbe.style.display = 'none'; document.body.appendChild(colorProbe); }
    colorProbe.style.color = ''; colorProbe.style.color = color;
    rgb = getComputedStyle(colorProbe).color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  }
  return rgb ? (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]) : pixi.utils.string2hex(fallback);
}

export type GraphNodeKind = 'unresolved' | 'tag' | 'attachment';
export interface GraphCopy { canvasLabel: string; error: string; listSummary: string }
const defaultCopy: GraphCopy = {
  canvasLabel: 'Interactive note graph. Drag nodes or background, scroll to zoom. Use arrow keys to pan, plus and minus to zoom, zero to fit.',
  error: 'Graph could not start. Notes are available in navigation.',
  listSummary: 'Graph notes',
};

export function PixiGraph({ id, current, data, expanded, onSelect, options, nodeColors, nodeKinds, nodeLabels, copy = defaultCopy, onNodeMenu, onNodeHover }: {
  id: string; current: string; data: GraphData; expanded: boolean; onSelect?: (path: string, event: PointerEvent) => void; options?: GraphOptions;
  /** Per-node color overrides (for example color groups resolved by the host). */
  nodeColors?: Record<string, string>;
  nodeKinds?: Record<string, GraphNodeKind>;
  nodeLabels?: Record<string, string>;
  copy?: GraphCopy;
  onNodeMenu?: (path: string, event: MouseEvent) => void;
  onNodeHover?: (path: string, event: PointerEvent | null) => void;
}) {
  // A renderer cannot be re-created on a canvas whose WebGL context it destroyed, so each run of the setup effect gets a fresh canvas.
  const generation = useRef(0), generationKey = useRef<unknown[]>([]);
  if (generationKey.current[0] !== id || generationKey.current[1] !== current) { generationKey.current = [id, current]; generation.current++; }
  const canvasRef = useRef<HTMLCanvasElement>(null), drawRef = useRef<() => void>(() => {}), selectRef = useRef(onSelect);
  const dataRef = useRef(data), previousDataRef = useRef(data);
  const pendingPositions = useRef(new Map<string, Point>());
  const degreeRef = useRef(new Map<string, number>());
  dataRef.current = data;
  if (previousDataRef.current === data && degreeRef.current.size === 0) degreeRef.current = new Map(data.nodes.map(path => [path, 0]));
  selectRef.current = onSelect;
  const optionsRef = useRef(options); optionsRef.current = options;
  const colorsRef = useRef(nodeColors); colorsRef.current = nodeColors;
  const kindsRef = useRef(nodeKinds); kindsRef.current = nodeKinds;
  const labelsRef = useRef(nodeLabels); labelsRef.current = nodeLabels;
  const menuRef = useRef(onNodeMenu); menuRef.current = onNodeMenu;
  const hoverRef = useRef(onNodeHover); hoverRef.current = onNodeHover;
  useEffect(() => { drawRef.current(); }, [nodeColors, nodeKinds]);
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => {
    workerRef.current?.postMessage({ forces: options, alpha: .3, run: true });
    drawRef.current();
  }, [options]);
  // Apply graph changes to the live worker. Timelapse adds an ordered prefix of
  // the final graph, so it can append nodes and links without throwing away
  // the existing Pixi canvas, worker, positions, velocities, and WebGL context.
  useEffect(() => {
    const previous = previousDataRef.current;
    previousDataRef.current = data;
    const degree = new Map(data.nodes.map(path => [path, 0]));
    for (const [a, b] of data.edges) {
      const left = data.nodes[a], right = data.nodes[b];
      if (left) degree.set(left, (degree.get(left) ?? 0) + 1);
      if (right) degree.set(right, (degree.get(right) ?? 0) + 1);
    }
    degreeRef.current = degree;
    const worker = workerRef.current;
    if (!worker || previous === data) return;
    const isAppend = previous.nodes.every((id, index) => data.nodes[index] === id)
      && previous.edges.every(edge => data.edges.some(next => next[0] === edge[0] && next[1] === edge[1]));
    if (!isAppend) {
      // Filter, deletion, and arbitrary graph changes still keep the running
      // simulation where possible; the worker reconciles retained node state.
      const nodePositions: Record<string, [number, number]> = {};
      data.nodes.forEach((id, index) => {
        const point = pendingPositions.current.get(id);
        if (point) nodePositions[id] = [point.x, point.y];
        else {
          const angle = index * 2.399963229728653, radius = 18 * Math.sqrt(index);
          nodePositions[id] = [Math.cos(angle) * radius, Math.sin(angle) * radius];
        }
      });
      worker.postMessage({ nodes: nodePositions, links: data.edges.map(([a, b]) => [data.nodes[a], data.nodes[b]] as [string, string]), forces: optionsRef.current, alpha: .3, run: true });
    } else {
      const additions: Record<string, [number, number]> = {};
      data.nodes.slice(previous.nodes.length).forEach((id, offset) => {
        const index = previous.nodes.length + offset, angle = index * 2.399963229728653, radius = 18 * Math.sqrt(index);
        const point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        pendingPositions.current.set(id, point);
        additions[id] = [point.x, point.y];
      });
      worker.postMessage({ addNodes: additions, links: data.edges.map(([a, b]) => [data.nodes[a], data.nodes[b]] as [string, string]), forces: optionsRef.current, alpha: .3, run: true });
    }
    drawRef.current();
  }, [data]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const view = canvas as HTMLCanvasElement;
    const container = view.closest<HTMLElement>('.publish-graph-container');
    let cancelled = false, worker: Worker | undefined, app: PixiApplication | undefined, resize: ResizeObserver | undefined;
    const positions = new Map<string, Point>(), labelObjects = new Map<string, PixiText>();
    let camera: PixiContainer, graph: PixiGraphics, pixi: PixiNamespace | undefined;
    let width = 1, height = 1, scale = .5, panX = 0, panY = 0, hover = '', autoFit = true;
    let animation = 0, lastFrame = 0, targetScale = scale, zoomPoint: Point | null = null, pointer: Point | null = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const visuals = new Map<string, { alpha: number; color: number; offset: number }>();
    const edgeVisuals = new Map<number, { alpha: number; color: number }>();
    const themeObserver = new MutationObserver(requestDraw);
    for (const element of [document.documentElement, document.body, view.closest('.publish-reader')]) {
      if (element) themeObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    reducedMotion.addEventListener('change', requestDraw);
    let drag: { id: string | null; x: number; y: number; moved: boolean; pointerId: number } | null = null;

    function sendNode(id: string, x: number | null, y: number | null, run = true) {
      worker?.postMessage({ alpha: .3, alphaTarget: run ? .3 : 0, forceNode: { id, x, y }, run });
    }
    function nodeSize(path: string) { return Math.max(8, Math.min(3 * Math.sqrt((degreeRef.current.get(path) ?? 0) + 1), 30)) * (optionsRef.current?.nodeScale ?? 1); }
    function requestDraw() { if (!cancelled && !animation) animation = requestAnimationFrame(draw); }
    function setHover(next: string, event: PointerEvent | null = null) {
      const changed = next !== hover;
      hover = next; view.dataset.graphHover = next;
      view.style.cursor = drag ? 'grabbing' : next ? 'pointer' : 'grab';
      if (changed) hoverRef.current?.(next, event);
    }
    function fit() {
      if (!positions.size || width < 60 || height < 60) return;
      if (positions.size === 1) {
        const point = positions.values().next().value as Point;
        scale = targetScale = .5; panX = -point.x * scale; panY = -point.y * scale;
        return;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const point of positions.values()) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
      const spanX = Math.max(90, maxX - minX), spanY = Math.max(90, maxY - minY);
      // Reserve room for the hovered label and its downward animation.
      scale = Math.max(.025, Math.min(expandedRef.current ? 1.7 : 1, (width - 44) / spanX, (height - 100) / spanY));
      targetScale = scale;
      panX = -(minX + maxX) / 2 * scale; panY = -(minY + maxY) / 2 * scale;
    }
    function draw(now = performance.now()) {
      animation = 0;
      if (!app || !pixi || !camera || !graph) return;
      const elapsed = lastFrame ? Math.min(64, now - lastFrame) : 1000 / 60; lastFrame = now;
      const blend = reducedMotion.matches ? 1 : 1 - Math.pow(.9, elapsed / (1000 / 60));
      let changing = false;
      function ease(value: number, target: number) {
        if (Math.abs(value - target) < .001) return target;
        changing = true; return value + (target - value) * blend;
      }
      function tint(value: number, target: number) {
        const channels = [16, 8, 0].map(shift => {
          const from = (value >> shift) & 255, to = (target >> shift) & 255;
          if (from === to) return to;
          changing = true; return from + Math.sign(to - from) * Math.max(1, Math.round(Math.abs(to - from) * blend));
        });
        return (channels[0] << 16) | (channels[1] << 8) | channels[2];
      }
      if (zoomPoint && scale !== targetScale) {
        const before = world(zoomPoint.x, zoomPoint.y); scale = ease(scale, targetScale);
        panX = zoomPoint.x - width / 2 - before.x * scale; panY = zoomPoint.y - height / 2 - before.y * scale;
      }
      if (pointer && !drag) setHover(hit(pointer.x, pointer.y));
      const style = getComputedStyle(view);
      const normal = colorValue(pixi, style.getPropertyValue('--graph-node'), '#888888');
      const accent = colorValue(pixi, style.getPropertyValue('--graph-node-focused'), '#a68af9');
      const highlight = colorValue(pixi, style.getPropertyValue('--interactive-accent'), '#a68af9');
      const line = colorValue(pixi, style.getPropertyValue('--graph-line'), '#363636');
      const text = colorValue(pixi, style.getPropertyValue('--graph-text'), '#dadada');
      const kindColors = {
        unresolved: colorValue(pixi, style.getPropertyValue('--graph-node-unresolved'), '#666666'),
        tag: colorValue(pixi, style.getPropertyValue('--graph-node-tag'), '#44cf6e'),
        attachment: colorValue(pixi, style.getPropertyValue('--graph-node-attachment'), '#e0de71'),
      };
      camera.position.set(width / 2 + panX, height / 2 + panY); camera.scale.set(scale);
      graph.clear();
      const graphData = dataRef.current;
      const degree = new Map(graphData.nodes.map(path => [path, 0]));
      const adjacency = new Map(graphData.nodes.map(path => [path, new Set<string>()]));
      for (const [a, b] of graphData.edges) {
        const left = graphData.nodes[a], right = graphData.nodes[b];
        if (!left || !right) continue;
        degree.set(left, (degree.get(left) ?? 0) + 1); degree.set(right, (degree.get(right) ?? 0) + 1);
        adjacency.get(left)?.add(right); adjacency.get(right)?.add(left);
      }
      for (const [index, [a, b]] of graphData.edges.entries()) {
        const left = graphData.nodes[a], right = graphData.nodes[b], p = left && positions.get(left), q = right && positions.get(right);
        if (!p || !q) continue;
        const connected = !hover || left === hover || right === hover;
        const visual = edgeVisuals.get(index) ?? { alpha: 1, color: line };
        visual.alpha = ease(visual.alpha, connected ? 1 : .2); visual.color = tint(visual.color, hover && connected ? highlight : line);
        edgeVisuals.set(index, visual);
        const dx = q.x - p.x, dy = q.y - p.y, length = Math.hypot(dx, dy);
        const start = nodeSize(left) / Math.sqrt(scale), end = nodeSize(right) / Math.sqrt(scale);
        if (length > start + end) {
          const x = q.x - dx * end / length, y = q.y - dy * end / length;
          graph.lineStyle((optionsRef.current?.linkWidth ?? 1) / scale, visual.color, visual.alpha).moveTo(p.x + dx * start / length, p.y + dy * start / length).lineTo(x, y);
          if (optionsRef.current?.arrows) {
            const angle = Math.atan2(dy, dx), size = 6 / scale;
            graph.moveTo(x - Math.cos(angle - .5) * size, y - Math.sin(angle - .5) * size).lineTo(x, y).lineTo(x - Math.cos(angle + .5) * size, y - Math.sin(angle + .5) * size);
          }
        }
      }
      for (let i = 0; i < graphData.nodes.length; i++) {
        const path = graphData.nodes[i], p = positions.get(path);
        if (!p) continue;
        const neighbors = adjacency.get(hover);
        const related = !hover || hover === path || Boolean(neighbors?.has(path));
        const size = nodeSize(path);
        const radius = size / Math.sqrt(scale);
        const override = colorsRef.current?.[path];
        const group = override ? undefined : optionsRef.current?.groups.find(group => group.query && path.toLowerCase().includes(group.query.toLowerCase()));
        const kind = kindsRef.current?.[path];
        const baseColor = path === current ? accent : override ? colorValue(pixi, override, '#888888') : group ? colorValue(pixi, group.color, '#888888') : kind ? kindColors[kind] : normal;
        const visual = visuals.get(path) ?? { alpha: 0, color: baseColor, offset: 0 };
        visual.alpha = ease(visual.alpha, related ? 1 : .2);
        visual.color = tint(visual.color, path === hover ? highlight : baseColor);
        visual.offset = ease(visual.offset, path === hover ? 15 : 0);
        visuals.set(path, visual);
        graph.lineStyle(0, 0, 0).beginFill(visual.color, visual.alpha).drawCircle(p.x, p.y, radius).endFill();
        if (path === hover) graph.lineStyle(1 / scale, accent, 1).drawCircle(p.x, p.y, radius + .5 / scale);
        const textAlpha = Math.max(0, Math.min(1, Math.log2(scale) - (optionsRef.current?.textFade ?? 0)));
        const showLabel = path === hover || textAlpha * visual.alpha > .001;
        let label = labelObjects.get(path);
        if (showLabel && !label) {
          label = new pixi.Text(labelsRef.current?.[path] ?? noteTitle(path), { fontFamily: style.fontFamily, fontSize: (optionsRef.current?.labelSize ?? 14) + size / 4, fill: text, resolution: window.devicePixelRatio, wordWrap: true, wordWrapWidth: 300, align: 'center' });
          label.anchor?.set(.5, 0); camera.addChild(label); labelObjects.set(path, label);
        }
        if (label) {
          label.visible = showLabel; label.scale.set(path === hover && scale < 1 ? 1 / scale : 1 / Math.sqrt(scale));
          label.position.set(p.x, p.y + (size + 5) / Math.sqrt(scale) + visual.offset / scale);
          label.alpha = path === hover ? 1 : textAlpha * visual.alpha; label.style.fill = text; label.style.fontFamily = style.fontFamily;
        }
      }
      app.renderer.render(app.stage);
      if (changing) requestDraw();
    }
    drawRef.current = requestDraw;

    let awaitingSize: ResizeObserver | undefined;
    // A tab that is not showing has no size yet; the renderer is created once it does.
    const whenSized = (start: () => void) => {
      const box = container ?? view;
      if (box.clientWidth && box.clientHeight) return start();
      awaitingSize = new ResizeObserver(() => {
        if (!box.clientWidth || !box.clientHeight) return;
        awaitingSize?.disconnect(); awaitingSize = undefined;
        if (!cancelled) try { start(); } catch { setError(true); }
      });
      awaitingSize.observe(box);
    };
    loadPixi().then(loaded => whenSized(() => {
      if (cancelled) return;
      pixi = loaded;
      const rect = view.getBoundingClientRect(); width = rect.width; height = rect.height;
      app = new pixi.Application({ view, width, height, resolution: window.devicePixelRatio || 1, autoDensity: true, antialias: true, backgroundAlpha: 0, autoStart: false });
      app.ticker.stop();
      camera = new pixi.Container(); graph = new pixi.Graphics(); camera.addChild(graph);
      app.stage.addChild(camera);
      resize = new ResizeObserver(() => {
        const bounds = container?.getBoundingClientRect() ?? view.getBoundingClientRect(); if (!bounds.width || !bounds.height || !app) return;
        if (container) {
          const css = getComputedStyle(container);
          width = container.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
          height = container.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
        } else { width = bounds.width; height = bounds.height; }
        app.renderer.resize(width, height);
        if (autoFit) fit(); requestDraw();
      });
      resize.observe(container ?? view);
      worker = createGraphWorker();
      workerRef.current = worker;
      worker.onerror = () => { if (!cancelled) setError(true); };
      worker.onmessage = ({ data: frame }: MessageEvent<WorkerFrame>) => {
        if (frame.ignore) return;
        const ids = frame.id ?? dataRef.current.nodes;
        if (!frame.buffer) return;
        const coordinates = new Float32Array(frame.buffer);
        ids.forEach((path, index) => { positions.set(path, { x: coordinates[index * 2], y: coordinates[index * 2 + 1] }); });
        view.dataset.graphReady = 'true';
        view.dataset.graphNodes = String(positions.size);
        if (autoFit) fit(); requestDraw();
      };
      const nodes: Record<string, [number, number]> = {};
      dataRef.current.nodes.forEach((path, index) => {
        const angle = index * 2.399963229728653, radius = 18 * Math.sqrt(index);
        const point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        nodes[path] = [point.x, point.y]; positions.set(path, point);
      });
      const links = dataRef.current.edges.map(([a, b]) => [dataRef.current.nodes[a], dataRef.current.nodes[b]] as [string, string]).filter(([a, b]) => Boolean(a && b));
      worker.postMessage({ nodes, links, forces: optionsRef.current, alpha: .3, run: true });
      fit(); requestDraw();
    })).catch(() => { if (!cancelled) setError(true); });

    function point(event: PointerEvent | WheelEvent) {
      const rect = view.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    function world(x: number, y: number) { return { x: (x - width / 2 - panX) / scale, y: (y - height / 2 - panY) / scale }; }
    function hit(x: number, y: number) {
      let nearest = '', distance = Infinity;
      for (const [path, p] of positions) {
        const dx = p.x * scale + width / 2 + panX - x, dy = p.y * scale + height / 2 + panY - y, d = dx * dx + dy * dy;
        const radius = Math.max(10, nodeSize(path) * Math.sqrt(scale));
        if (d <= radius * radius && d < distance) { distance = d; nearest = path; }
      }
      return nearest;
    }
    function move(event: PointerEvent) {
      const p = point(event); pointer = p;
      if (drag) {
        const dx = p.x - drag.x, dy = p.y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        if (drag.id) {
          const at = world(p.x, p.y); positions.set(drag.id, at); sendNode(drag.id, at.x, at.y);
        } else { panX += dx; panY += dy; }
        drag.x = p.x; drag.y = p.y; autoFit = false;
      } else {
        setHover(hit(p.x, p.y), event);
      }
      drawRef.current();
    }
    function down(event: PointerEvent) {
      if (event.button !== 0) return;
      const p = point(event); drag = { id: hit(p.x, p.y) || null, ...p, moved: false, pointerId: event.pointerId };
      if (drag.id) setHover(drag.id, event);
      view.setPointerCapture(event.pointerId); view.style.cursor = 'grabbing'; requestDraw();
    }
    function release(event: PointerEvent) {
      if (!drag) return;
      const selected = drag;
      if (selected.id) {
        sendNode(selected.id, null, null, false);
        if (!selected.moved && event.type === 'pointerup') selectRef.current?.(selected.id, event);
      }
      if (view.hasPointerCapture(event.pointerId)) view.releasePointerCapture(event.pointerId);
      drag = null; pointer = event.type === 'pointercancel' ? null : point(event); setHover(pointer ? hit(pointer.x, pointer.y) : '', event); drawRef.current();
    }
    function zoom(factor: number, x = width / 2, y = height / 2) {
      targetScale = Math.max(.025, Math.min(8, targetScale * factor)); zoomPoint = { x, y }; autoFit = false; drawRef.current();
    }
    function wheel(event: WheelEvent) { event.preventDefault(); const p = point(event); zoom(Math.pow(1.5, -event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1) / 120), p.x, p.y); }
    function key(event: KeyboardEvent) {
      if (!['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '0'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === '+' || event.key === '=') zoom(1.2);
      if (event.key === '-') zoom(1 / 1.2);
      if (event.key === '0') { autoFit = true; fit(); drawRef.current(); }
      if (event.key.startsWith('Arrow')) { autoFit = false; if (event.key === 'ArrowLeft') panX += 25; if (event.key === 'ArrowRight') panX -= 25; if (event.key === 'ArrowUp') panY += 25; if (event.key === 'ArrowDown') panY -= 25; drawRef.current(); }
    }
    function contextMenu(event: MouseEvent) {
      const rect = view.getBoundingClientRect(), target = hit(event.clientX - rect.left, event.clientY - rect.top);
      if (target && menuRef.current) { event.preventDefault(); menuRef.current(target, event); }
    }
    view.addEventListener('contextmenu', contextMenu);
    function leave() { pointer = null; if (!drag) { setHover(''); drawRef.current(); } }
    view.addEventListener('pointermove', move); view.addEventListener('pointerdown', down); view.addEventListener('pointerup', release); view.addEventListener('pointercancel', release); view.addEventListener('pointerleave', leave); view.addEventListener('wheel', wheel, { passive: false }); view.addEventListener('keydown', key);
    return () => {
      cancelled = true; awaitingSize?.disconnect(); cancelAnimationFrame(animation); themeObserver.disconnect(); reducedMotion.removeEventListener('change', requestDraw); drawRef.current = () => {}; worker?.terminate(); workerRef.current = null; resize?.disconnect();
      view.removeEventListener('pointermove', move); view.removeEventListener('pointerdown', down); view.removeEventListener('pointerup', release); view.removeEventListener('pointercancel', release); view.removeEventListener('pointerleave', leave); view.removeEventListener('wheel', wheel); view.removeEventListener('keydown', key); view.removeEventListener('contextmenu', contextMenu);
      app?.destroy(false, { children: true, texture: true, baseTexture: true });
    };
  }, [id, current]);

  return <><canvas key={generation.current} ref={canvasRef} data-graph-ready="false" data-graph-nodes="0" tabIndex={0} aria-label={copy.canvasLabel} />{error && <p role="alert">{copy.error}</p>}<details className="publish-graph-accessible"><summary>{copy.listSummary} ({data.nodes.length})</summary><ul>{data.nodes.map(path => <li key={path}><button onClick={event => selectRef.current?.(path, event.nativeEvent as PointerEvent)}>{nodeLabels?.[path] ?? noteTitle(path)}</button></li>)}</ul></details></>;
}
