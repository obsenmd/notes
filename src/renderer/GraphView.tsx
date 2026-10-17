import { path, originalFs as fs } from "../../platforms/platform";
import { useEffect, useMemo, useRef, useState } from "react";


import { Keymap } from "../compat/commands";
import { getAllTags } from "../compat/metadata-cache";
import type { App } from "../compat/plugin";
import { Menu, Notice } from "../compat/ui";
import { TFile } from "../compat/vault";
import type { WorkspaceLeaf } from "../compat/workspace";
import { compileSearchQuery } from "../controllers/search-query";
import { PixiGraph, type GraphNodeKind, type GraphOptions } from "../graph/PixiGraph";
import { t as translate } from "../i18n";
import { useT } from "../i18n/react";
import { writeJson } from "./config";
import { ClickableIcon, CollapseIcon, SearchInput, SettingItem, Slider, Toggle, cx } from "./ui";
import { triggerGraphNodeHover } from "./hover-preview";

export interface ColorGroup { query: string; color: { a: number; rgb: number } }
/** Options stored in `.obsidian/graph.json`, using the reference file's keys and value ranges. */
export interface GraphSettings {
  "collapse-filter": boolean; search: string; showTags: boolean; showAttachments: boolean; hideUnresolved: boolean; showOrphans: boolean;
  "collapse-color-groups": boolean; colorGroups: ColorGroup[];
  "collapse-display": boolean; showArrow: boolean; textFadeMultiplier: number; nodeSizeMultiplier: number; lineSizeMultiplier: number;
  "collapse-forces": boolean; centerStrength: number; repelStrength: number; linkStrength: number; linkDistance: number;
  scale: number; close: boolean;
  /** Local graph only (kept in the tab's state rather than graph.json). */
  localJumps?: number; localBacklinks?: boolean; localForelinks?: boolean; localInterlinks?: boolean;
}
export const DEFAULT_LOCAL_GRAPH_SETTINGS = { localJumps: 1, localBacklinks: true, localForelinks: true, localInterlinks: false };
const DEFAULT_FILTERS = { showAttachments: false, hideUnresolved: false, showOrphans: true, showTags: false, ...DEFAULT_LOCAL_GRAPH_SETTINGS };
const DEFAULT_DISPLAY = { showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1, lineSizeMultiplier: 1 };
const DEFAULT_FORCES = { centerStrength: 0.518713248970312, repelStrength: 10, linkStrength: 1, linkDistance: 250 };
/** Reference pacing: clamp(0.5 * sqrt(node count), 5, 100) nodes per second. */
const timelapseStepMs = (nodeCount: number) => 1000 / Math.max(5, Math.min(100, 0.5 * Math.sqrt(nodeCount)));
export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  "collapse-filter": true, search: "", showTags: false, showAttachments: false, hideUnresolved: false, showOrphans: true,
  "collapse-color-groups": true, colorGroups: [],
  "collapse-display": true, ...DEFAULT_DISPLAY,
  "collapse-forces": true, ...DEFAULT_FORCES,
  scale: 1, close: true,
};

// Calibrated so default node and label sizes match the reference graph at its default zoom.
const NODE_SCALE = 0.85, LABEL_SIZE = 11.5;
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;
/** The force sliders are perceptual; the simulation takes the exponential value. */
const forceCurve = (value: number) => (Math.pow(0.01, 1 - value) - 0.01) / 0.99;
const isAttachment = (filePath: string) => !/\.(md|canvas|base)$/i.test(filePath);
function hslToRgb(h: number, s: number, l: number): number {
  const a = s / 100 * Math.min(l / 100, 1 - l / 100), channel = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return (channel(0) << 16) | (channel(8) << 8) | channel(4);
}

type NodeType = "" | "tag" | "unresolved" | "attachment";
interface GraphNode { type: NodeType; links: Set<string>; color?: string }
type FileFilter = Map<string, boolean | string>;
export interface GraphBuildOptions extends Pick<GraphSettings, "showTags" | "showAttachments" | "hideUnresolved" | "showOrphans"> { localFile?: string | null; localJumps?: number; localBacklinks?: boolean; localForelinks?: boolean; localInterlinks?: boolean }
export interface GraphSource { files: string[]; resolvedLinks: Record<string, Record<string, number>>; unresolvedLinks: Record<string, Record<string, number>>; tagsOf(file: string): string[] }
export interface GraphQueries { filter: FileFilter; hasFilter: boolean; any: boolean; matchTag(tag: string): boolean; matchFilename(file: string): boolean }

/** The notes around one note: links are followed outwards `localJumps` times in the enabled directions; tags are never walked through. */
export function localGraph(nodes: Map<string, GraphNode>, options: GraphBuildOptions): Map<string, GraphNode> {
  const center = options.localFile ?? "", result = new Map<string, GraphNode>(), origin = nodes.get(center);
  result.set(center, { type: origin?.type ?? "", links: new Set() });
  if (!origin) return result;
  const copy = (id: string): GraphNode => { const node = nodes.get(id); return { type: node?.type ?? "", links: new Set(), ...(node?.color ? { color: node.color } : {}) }; };
  for (let jump = 0; jump < (options.localJumps ?? 1); jump++) {
    const added = new Map<string, GraphNode>();
    for (const [source, node] of nodes) {
      if (node.type === "tag") continue;
      for (const target of node.links) {
        const from = result.get(source), to = result.get(target);
        if (options.localForelinks !== false && from && !to && from.type !== "tag") { if (!added.has(target)) added.set(target, copy(target)); from.links.add(target); }
        else if (options.localBacklinks !== false && to && !from && to.type !== "tag") { if (!added.has(source)) added.set(source, copy(source)); added.get(source)!.links.add(target); }
      }
    }
    for (const [id, node] of added) result.set(id, node);
  }
  if (options.localInterlinks) for (const id of result.keys()) { const full = nodes.get(id); if (full) result.set(id, full); }
  return result;
}

/** Nodes and links for the current filters, as the reference computes them from the link index. */
export function buildGraph(source: GraphSource, options: GraphBuildOptions, queries: GraphQueries): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>(), local = options.localFile;
  const accept = (id: string, type: NodeType): boolean | string => {
    if (!queries.any) return true;
    if (type === "") return id === local || (queries.filter.has(id) ? queries.filter.get(id)! : !queries.hasFilter);
    if (type === "tag") return queries.matchTag(id);
    if (type === "attachment") return queries.matchFilename(id);
    return true;
  };
  const canonical = new Map<string, string>();
  if (options.showTags) for (const file of source.files) for (const tag of source.tagsOf(file)) if (!canonical.has(tag.toLowerCase())) canonical.set(tag.toLowerCase(), tag);
  for (const file of source.files) {
    const attachment = isAttachment(file);
    if (attachment && !options.showAttachments) continue;
    const passed = accept(file, attachment ? "attachment" : "");
    if (!passed) continue;
    const node: GraphNode = { type: attachment ? "attachment" : "", links: new Set() };
    if (typeof passed === "string") node.color = passed;
    nodes.set(file, node);
    for (const target of Object.keys(source.resolvedLinks[file] ?? {})) {
      const targetAttachment = isAttachment(target);
      if ((options.showAttachments || !targetAttachment) && accept(target, targetAttachment ? "attachment" : "")) node.links.add(target);
    }
    if (!options.hideUnresolved) for (const target of Object.keys(source.unresolvedLinks[file] ?? {})) { node.links.add(target); if (!nodes.has(target)) nodes.set(target, { type: "unresolved", links: new Set() }); }
    if (options.showTags) for (const raw of source.tagsOf(file)) {
      if (!accept(raw, "tag")) continue;
      const tag = canonical.get(raw.toLowerCase()) ?? raw;
      node.links.add(tag); if (!nodes.has(tag)) nodes.set(tag, { type: "tag", links: new Set() });
    }
  }
  const scoped = local ? localGraph(nodes, options) : nodes;
  if (!options.showOrphans) {
    const linked = new Set<string>();
    for (const [id, node] of scoped) for (const target of node.links) if (target !== id) linked.add(target);
    for (const [id, node] of [...scoped]) if (!linked.has(id) && ![...node.links].some(target => target !== id && scoped.has(target))) scoped.delete(id);
  }
  return scoped;
}

/** Reads a colour the theme assigns to a graph element (for example the focused node), as the reference does. */
function themeColor(cls: string): string | null {
  const probe = document.body.appendChild(Object.assign(document.createElement("div"), { className: "graph-view " + cls }));
  const color = getComputedStyle(probe).color; probe.remove();
  const parts = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,/\s]+([\d.]+))?/);
  return parts && parts[4] !== "0" ? hex((+parts[1] << 16) | (+parts[2] << 8) | +parts[3]) : null;
}

/** Copies the graph as drawn (transparent background) to the clipboard. */
export async function copyGraphScreenshot(container: HTMLElement): Promise<void> {
  const host = container.querySelector<HTMLElement>(".publish-graph-container"), source = host?.querySelector("canvas");
  if (!host || !source) return;
  const win = container.ownerDocument.defaultView ?? window, copy = container.ownerDocument.createElement("canvas"); copy.width = source.width; copy.height = source.height;
  const context = copy.getContext("2d")!;
  // The drawing buffer only holds the picture during the frame it was drawn in, so the graph is asked to
  // redraw and the copy is taken after that frame's drawing (resize observers run then), until one has content.
  const painted = () => { const { data } = context.getImageData(0, 0, copy.width, copy.height); for (let index = 3; index < data.length; index += 4 * 97) if (data[index]) return true; return false; };
  await new Promise<void>(resolve => {
    let frames = 0;
    const probe = container.ownerDocument.createElement("div"); probe.style.cssText = "position:absolute;width:1px;height:1px;visibility:hidden"; host.append(probe);
    const observer = new win.ResizeObserver(() => {
      context.clearRect(0, 0, copy.width, copy.height); context.drawImage(source, 0, 0);
      if (painted() || ++frames > 20) { observer.disconnect(); probe.remove(); resolve(); return; }
      host.dispatchEvent(new CustomEvent("graph:redraw"));
      win.requestAnimationFrame(() => { probe.style.width = `${1 + frames % 2}px`; });
    });
    host.dispatchEvent(new CustomEvent("graph:redraw"));
    observer.observe(probe);
  });
  try {
    const blob = await new Promise<Blob | null>(resolve => copy.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("toBlob");
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    new Notice(translate("plugins.graph-view.msg-screenshot-copied"));
  } catch (error) { console.error(error); new Notice(translate("obsen.graph.error-copy-screenshot")); }
}

export interface GraphViewProps {
  app: App; vaultPath: string; configDir: string;
  /** Present for a local graph: the note it is centred on. */
  localFile?: string | null;
  /** The tab showing the graph; file menus and link opening are relative to it. */
  leaf?: WorkspaceLeaf;
  onOpen(path: string, event: MouseEvent): void; onNodeMenu?(path: string, event: MouseEvent): void; initial?: Partial<GraphSettings>; onSettingsChange?(settings: GraphSettings): void;
}

export function GraphView({ app, configDir, onOpen, onNodeMenu, initial, onSettingsChange, localFile, leaf }: GraphViewProps) {
  const isLocal = localFile !== undefined;
  const t = useT();
  const file = path.join(configDir, "graph.json");
  const [settings, setSettings] = useState<GraphSettings>({ ...DEFAULT_GRAPH_SETTINGS, ...(isLocal ? DEFAULT_LOCAL_GRAPH_SETTINGS : null), ...initial });
  const [timelapse, setTimelapse] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [redraw, setRedraw] = useState(0);
  const [focusFile, setFocusFile] = useState(() => app.workspace.activeFile?.path ?? "");
  const [filter, setFilter] = useState<{ filter: FileFilter; searching: boolean }>({ filter: new Map(), searching: false });
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostRef = useRef<HTMLDivElement>(null), timelapseTotal = useRef(0), timelapseStartedAt = useRef(0);
  const startTimelapse = () => { timelapseStartedAt.current = Date.now(); setTimelapse(1); };

  useEffect(() => {
    let cancelled = false;
    if (isLocal) { loaded.current = true; return; }
    void fs.promises.readFile(file, "utf8").then(raw => JSON.parse(raw) as Partial<GraphSettings>).catch(() => ({})).then(saved => {
      if (cancelled) return;
      loaded.current = true;
      setSettings(current => ({ ...current, ...saved, ...initial }));
    });
    return () => { cancelled = true; };
  }, [file]);
  const update = (patch: Partial<GraphSettings>) => setSettings(current => {
    const next = { ...current, ...patch };
    if (loaded.current && !isLocal) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void writeJson(file, next).catch(error => console.error("Could not save graph settings", error)), 500);
    }
    onSettingsChange?.(next);
    return next;
  });

  useEffect(() => {
    const bump = () => setRevision(value => value + 1);
    const refs = [app.metadataCache.on("resolved", bump), app.metadataCache.on("changed", bump)];
    const vaultRefs = [app.vault.on("create", bump), app.vault.on("delete", bump), app.vault.on("rename", bump)];
    const active = app.workspace.on("file-open", (opened: { path?: string } | null) => setFocusFile(opened?.path ?? ""));
    const animate = app.workspace.on("graph:animate", () => { if (!isLocal && app.workspace.activeLeaf?.view.containerEl.contains(hostRef.current)) startTimelapse(); });
    const host = hostRef.current, repaint = () => setRedraw(value => value + 1);
    host?.addEventListener("graph:redraw", repaint);
    return () => { refs.forEach(ref => app.metadataCache.offref(ref)); vaultRefs.forEach(ref => app.vault.offref(ref)); app.workspace.offref(active); app.workspace.offref(animate); host?.removeEventListener("graph:redraw", repaint); };
  }, [app]);
  useEffect(() => {
    if (timelapse === null) return;
    // Follow elapsed time on each frame; a state update can land on the same
    // integer progression for several frames at the reference's low rates.
    const timer = setInterval(() => {
      const steps = Math.max(1, timelapseTotal.current);
      const progression = Math.min(steps, 1 + Math.floor((Date.now() - timelapseStartedAt.current) / timelapseStepMs(steps)));
      setTimelapse(current => current === null || progression >= steps ? null : Math.max(current, progression));
    }, 16);
    return () => clearInterval(timer);
  }, [timelapse === null]);

  // The search box and the colour groups use the search pane's query language, matched against each file's contents.
  const queries = useMemo(() => {
    const compile = (query: string) => { try { return query.trim() ? compileSearchQuery(query).test : null; } catch { return null; } };
    return { search: compile(settings.search), groups: settings.colorGroups.flatMap(group => { const test = compile(group.query); return test ? [{ test, color: hex(group.color.rgb) }] : []; }) };
  }, [settings.search, settings.colorGroups]);
  const contents = useRef(new Map<string, { mtime: number; text: string }>());
  useEffect(() => {
    if (!queries.search && !queries.groups.length) { setFilter({ filter: new Map(), searching: false }); return; }
    let cancelled = false;
    setFilter(current => ({ ...current, searching: true }));
    const timer = setTimeout(() => void (async () => {
      const next: FileFilter = new Map();
      for (const item of app.vault.getFiles()) {
        let text = "";
        if (item.extension === "md") {
          const cached = contents.current.get(item.path);
          if (cached && cached.mtime === item.stat.mtime) text = cached.text;
          else { text = await app.vault.cachedRead(item).catch(() => ""); contents.current.set(item.path, { mtime: item.stat.mtime, text }); }
          if (cancelled) return;
        }
        const document = { path: item.path, name: item.name, content: text };
        if (queries.search && !queries.search(document)) { next.set(item.path, false); continue; }
        next.set(item.path, queries.groups.find(group => group.test(document))?.color ?? true);
      }
      if (!cancelled) setFilter({ filter: next, searching: false });
    })(), 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [app, queries, revision]);

  const previous = useRef<{ key: string; data: { nodes: string[]; edges: [number, number][] } } | null>(null);
  const graph = useMemo(() => {
    const source: GraphSource = {
      files: app.vault.getFiles().map(item => item.path), resolvedLinks: app.metadataCache.resolvedLinks, unresolvedLinks: app.metadataCache.unresolvedLinks,
      tagsOf: filePath => { const item = app.vault.getFileByPath(filePath), cache = item ? app.metadataCache.getFileCache(item) : null; return cache ? [...new Set(getAllTags(cache) ?? [])] : []; },
    };
    const plain = (text: string) => ({ path: text, name: text.split("/").at(-1)!, content: text });
    const nodes = isLocal && !localFile ? new Map<string, GraphNode>() : buildGraph(source, { ...settings, localFile: isLocal ? localFile : null }, {
      filter: filter.filter, hasFilter: !!queries.search, any: !!queries.search || queries.groups.length > 0,
      matchTag: tag => !queries.search || queries.search({ path: tag, name: tag, content: tag }), matchFilename: name => !queries.search || queries.search({ ...plain(name), content: "" }),
    });
    let visible = [...nodes.keys()];
    if (timelapse !== null) {
      const created = (id: string) => { const stat = app.vault.getFileByPath(id)?.stat; return stat ? Math.min(stat.ctime, stat.mtime) : Number.MAX_SAFE_INTEGER; };
      const steps = Math.max(1, visible.length);
      visible = [...visible].sort((a, b) => created(a) - created(b)).slice(0, Math.ceil(visible.length * timelapse / steps));
    } else timelapseTotal.current = visible.length;
    const index = new Map(visible.map((id, position) => [id, position]));
    const edges: [number, number][] = [];
    for (const id of visible) for (const target of nodes.get(id)!.links) { const a = index.get(id)!, b = index.get(target); if (b !== undefined && a !== b) edges.push([a, b]); }
    const kinds: Record<string, GraphNodeKind> = {}, labels: Record<string, string> = {}, colors: Record<string, string> = {};
    for (const id of visible) {
      const node = nodes.get(id)!;
      if (node.type) kinds[id] = node.type;
      if (node.color) colors[id] = node.color;
      labels[id] = node.type === "tag" || node.type === "unresolved" ? id : id.split("/").at(-1)!.replace(/\.md$/i, "");
    }
    // The simulation restarts whenever it is given new data, so an unchanged graph keeps its data object.
    const key = JSON.stringify([visible, edges]);
    const data = previous.current?.key === key ? previous.current.data : { nodes: visible, edges };
    previous.current = { key, data };
    return { data, kinds, labels, colors, types: nodes };
  }, [app, revision, timelapse, localFile, filter.filter, queries, settings.localJumps, settings.localBacklinks, settings.localForelinks, settings.localInterlinks, settings.showAttachments, settings.hideUnresolved, settings.showTags, settings.showOrphans]);
  // The note being read is drawn in the theme's "focused" colour.
  const colors = useMemo(() => {
    const focused = focusFile && graph.types.has(focusFile) ? themeColor("color-fill-focused") : null;
    return focused ? { ...graph.colors, [focusFile]: focused } : { ...graph.colors };
  }, [graph.colors, graph.types, focusFile, redraw]);

  const options = useMemo<GraphOptions>(() => ({
    centerStrength: forceCurve(settings.centerStrength), repelStrength: settings.repelStrength ** 3, linkStrength: forceCurve(settings.linkStrength), linkDistance: settings.linkDistance,
    nodeScale: settings.nodeSizeMultiplier * NODE_SCALE, labelSize: LABEL_SIZE, linkWidth: settings.lineSizeMultiplier, textFade: settings.textFadeMultiplier, arrows: settings.showArrow, groups: [],
  }), [settings.centerStrength, settings.repelStrength, settings.linkStrength, settings.linkDistance, settings.nodeSizeMultiplier, settings.lineSizeMultiplier, settings.textFadeMultiplier, settings.showArrow]);

  const typeOf = (id: string) => graph.types.get(id)?.type ?? "";
  const searchTag = (tag: string) => app.workspace.trigger("search:open", "tag:" + tag);
  const select = (id: string, event: MouseEvent) => { if (typeOf(id) === "tag") searchTag(id); else onOpen(id, event); };
  const nodeMenu = (id: string, event: MouseEvent) => {
    if (onNodeMenu) { onNodeMenu(id, event); return; }
    if (typeOf(id) === "tag") { searchTag(id); return; }
    const found = app.metadataCache.getFirstLinkpathDest(id, ""), target = found ? app.vault.getAbstractFileByPath(found.path) : null;
    if (!(target instanceof TFile)) return;
    const menu = new Menu();
    menu.addItem(item => item.setSection("title").setTitle(target.extension === "md" ? target.basename : target.name).setIsLabel(true));
    menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(click => void app.workspace.openLinkText(id, "", Keymap.isModEvent(click as MouseEvent) || true)));
    app.workspace.trigger("file-menu", menu, target, "graph-context-menu", leaf);
    menu.addItem(item => item.setSection("danger").setTitle(t("interface.menu.delete-file")).setIcon("lucide-trash-2").setWarning(true).onClick(() => void app.fileManager.promptForDeletion(target)));
    menu.showAtMouseEvent(event);
  };
  // Hovering a note offers its page preview (with the modifier key, as configured for the "graph" source).
  const hoverParent = useRef<{ hoverPopover: unknown }>({ hoverPopover: null }), lastMove = useRef<MouseEvent | null>(null), typeRef = useRef(typeOf); typeRef.current = typeOf;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const move = (event: MouseEvent) => { lastMove.current = event; };
    host.addEventListener("mousemove", move);
    let canvas: HTMLCanvasElement | null = null;
    const hovered = new MutationObserver(() => {
      const id = canvas?.dataset.graphHover, event = lastMove.current;
      if (id && event && ["", "attachment"].includes(typeRef.current(id))) app.workspace.trigger("hover-link", { event, source: "graph", hoverParent: hoverParent.current, targetEl: null, linktext: id });
    });
    const watch = () => { const next = host.querySelector("canvas"); if (next && next !== canvas) { canvas = next; hovered.disconnect(); hovered.observe(next, { attributes: true, attributeFilter: ["data-graph-hover"] }); } };
    const children = new MutationObserver(watch); children.observe(host, { childList: true }); watch();
    return () => { host.removeEventListener("mousemove", move); hovered.disconnect(); children.disconnect(); };
  }, [app]);

  // Colour groups are reordered by dragging their swatch.
  const groupsEl = useRef<HTMLDivElement>(null), groupsRef = useRef(settings.colorGroups); groupsRef.current = settings.colorGroups;
  const dragGroup = (event: React.MouseEvent, index: number) => {
    if (event.button !== 0) return;
    const row = (event.currentTarget as HTMLElement).closest<HTMLElement>(".graph-color-group"), container = groupsEl.current;
    if (!row || !container) return;
    const startX = event.clientX, startY = event.clientY, box = row.getBoundingClientRect(), offsetX = startX - box.x, offsetY = startY - box.y, doc = row.ownerDocument;
    let ghost: HTMLElement | null = null;
    const others = () => [...container.querySelectorAll<HTMLElement>(".graph-color-group")].filter(item => item !== row);
    const dropIndex = (y: number) => { const rows = others(); for (let at = 0; at < rows.length; at++) { const rect = rows[at].getBoundingClientRect(); if (y < rect.top + rect.height / 2) return at; } return rows.length; };
    const move = (next: MouseEvent) => {
      next.preventDefault();
      if (!ghost) {
        if ((next.clientX - startX) ** 2 + (next.clientY - startY) ** 2 < 25) return;
        ghost = row.cloneNode(true) as HTMLElement; ghost.classList.add("drag-ghost"); ghost.style.width = row.offsetWidth + "px";
        doc.body.append(ghost); doc.body.classList.add("is-grabbing"); container.classList.add("is-grabbing"); row.style.display = "none";
      }
      ghost.style.left = next.clientX - offsetX + "px"; ghost.style.top = next.clientY - offsetY + "px";
      const at = dropIndex(next.clientY);
      others().forEach((item, position) => { item.style.top = position < at ? "0" : `${item.offsetHeight}px`; });
    };
    const up = (next: MouseEvent) => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      if (!ghost) return;
      const at = dropIndex(next.clientY);
      ghost.remove(); doc.body.classList.remove("is-grabbing"); container.classList.remove("is-grabbing"); row.style.display = "";
      for (const item of others()) item.style.top = "";
      const groups = [...groupsRef.current], [moved] = groups.splice(index, 1);
      groups.splice(at, 0, moved); update({ colorGroups: groups });
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  const section = (key: "filter" | "color-groups" | "display" | "forces", title: string, children: React.ReactNode) => {
    const collapsed = settings[`collapse-${key}`];
    return <div className={cx("tree-item graph-control-section", `mod-${key}`, collapsed && "is-collapsed")}>
      <div className="tree-item-self mod-collapsible" onClick={() => update({ [`collapse-${key}`]: !collapsed } as Partial<GraphSettings>)}>
        <CollapseIcon collapsed={collapsed} />
        <div className="tree-item-inner"><header className="graph-control-section-header">{title}</header></div>
      </div>
      {!collapsed && <div className="tree-item-children">{children}</div>}
    </div>;
  };
  const toggle = (name: string, description: string, key: "showTags" | "showAttachments" | "hideUnresolved" | "showOrphans" | "showArrow" | "localBacklinks" | "localForelinks" | "localInterlinks") =>
    <SettingItem className="mod-toggle" name={name} nameLabel={description}><Toggle value={!!settings[key]} onChange={value => update({ [key]: value })} /></SettingItem>;
  const slider = (name: string, key: "textFadeMultiplier" | "nodeSizeMultiplier" | "lineSizeMultiplier" | "centerStrength" | "repelStrength" | "linkStrength" | "linkDistance", min: number, max: number, step: number | "any", digits = 2) =>
    <SettingItem className="mod-slider" name={name}><Slider value={settings[key]} min={min} max={max} step={step} format={value => value.toFixed(digits)} onChange={value => update({ [key]: value })} /></SettingItem>;

  return <>
    <div className="publish-graph-container absolute inset-0" ref={hostRef}>
      <PixiGraph id={isLocal ? "local" : "vault"} current="" data={graph.data} expanded={false} options={options}
        nodeColors={colors} nodeKinds={graph.kinds} nodeLabels={graph.labels}
        copy={{ canvasLabel: t("obsen.graph.canvas-label"), error: t("obsen.graph.error"), listSummary: t("obsen.graph.list-summary") }}
        onSelect={select} onNodeMenu={nodeMenu}
        onNodeHover={(path, event) => { if (leaf) triggerGraphNodeHover(app, leaf, path, event, event?.target as HTMLElement | null); }} />
    </div>
    <div className={cx("graph-controls", settings.close && "is-close")} data-ignore-swipe="true">
      <ClickableIcon icon="lucide-x" className="graph-controls-button mod-close" label={t("interface.menu.close")} onClick={() => update({ close: true })} />
      <ClickableIcon icon="lucide-settings" className="graph-controls-button mod-open" label={t("plugins.graph-view.tooltip-open-graph-settings")} onClick={() => update({ close: false })} />
      {!isLocal && <ClickableIcon icon="lucide-wand-2" className="graph-controls-button mod-animate" label={t("plugins.graph-view.tooltip-start-timelapse-animation")} onClick={startTimelapse} />}
      <ClickableIcon icon="lucide-rotate-ccw" className="graph-controls-button mod-reset" label={t("interface.tooltip-restore-default-settings")} onClick={() => update({ ...DEFAULT_FILTERS, colorGroups: [], ...DEFAULT_DISPLAY, ...DEFAULT_FORCES })} />
      {section("filter", t("plugins.graph-view.label-filters"), <>
        <SettingItem className={cx("mod-search-setting", filter.searching && "is-loading")} noInfo><SearchInput value={settings.search} onChange={value => update({ search: value })} placeholder={t("plugins.graph-view.prompt-filter-nodes")} clearLabel={t("plugins.search.tooltip-clear-search")} /></SettingItem>
        {isLocal && <>
          <SettingItem className="mod-local-jumps mod-slider" name={t("plugins.graph-view.option-depth")} nameLabel={t("plugins.graph-view.option-depth-description")}><Slider value={settings.localJumps ?? 1} min={1} max={5} step={1} format={value => String(value)} onChange={value => update({ localJumps: value })} /></SettingItem>
          {toggle(t("plugins.graph-view.option-backlinks"), t("plugins.graph-view.option-backlinks-description"), "localBacklinks")}
          {toggle(t("plugins.graph-view.option-forelinks"), t("plugins.graph-view.option-forelinks-description"), "localForelinks")}
          {toggle(t("plugins.graph-view.option-neighbor-links"), t("plugins.graph-view.option-neighbor-links-description"), "localInterlinks")}
        </>}
        {toggle(t("plugins.graph-view.option-show-tags"), t("plugins.graph-view.option-show-tags-description"), "showTags")}
        {toggle(t("plugins.graph-view.option-show-attachments"), t("plugins.graph-view.option-show-attachments-description"), "showAttachments")}
        {toggle(t("plugins.graph-view.option-show-existing-files-only"), t("plugins.graph-view.option-show-existing-files-only-description"), "hideUnresolved")}
        {!isLocal && toggle(t("plugins.graph-view.option-show-orphans"), t("plugins.graph-view.option-show-orphans-description"), "showOrphans")}
      </>)}
      {section("color-groups", t("plugins.graph-view.label-groups"), <>
        <div className="graph-color-groups-container" ref={groupsEl}>
          {settings.colorGroups.map((group, index) => <div className="graph-color-group" key={index}>
            <input type="text" spellCheck={false} placeholder={t("plugins.graph-view.placeholder-enter-query")} value={group.query}
              onChange={event => update({ colorGroups: settings.colorGroups.map((item, position) => position === index ? { ...item, query: event.target.value } : item) })} />
            <input type="color" aria-label={t("plugins.graph-view.tooltip-click-to-change-drag-to-reorder")} value={hex(group.color.rgb)} onMouseDown={event => dragGroup(event, index)}
              onChange={event => update({ colorGroups: settings.colorGroups.map((item, position) => position === index ? { ...item, color: { a: 1, rgb: parseInt(event.target.value.slice(1), 16) } } : item) })} />
            <ClickableIcon icon="lucide-x" aria-label={t("plugins.graph-view.tooltip-delete-graph")} onClick={() => update({ colorGroups: settings.colorGroups.filter((_item, position) => position !== index) })} />
          </div>)}
        </div>
        <div className="graph-color-button-container">
          <button onClick={() => update({ colorGroups: [...settings.colorGroups, { query: "", color: { a: 1, rgb: hslToRgb(40 * settings.colorGroups.length % 360, app.isDarkMode() ? 70 : 60, 60) } }] })}>{t("plugins.graph-view.button-new-group")}</button>
        </div>
      </>)}
      {section("display", t("plugins.graph-view.label-display"), <>
        {toggle(t("plugins.graph-view.option-show-arrows"), t("plugins.graph-view.option-show-arrows-description"), "showArrow")}
        {slider(t("plugins.graph-view.option-text-fade"), "textFadeMultiplier", -3, 3, 0.1)}
        {slider(t("plugins.graph-view.option-node-size"), "nodeSizeMultiplier", 0.1, 5, "any")}
        {slider(t("plugins.graph-view.option-link-thickness"), "lineSizeMultiplier", 0.1, 5, "any")}
        {!isLocal && <SettingItem noInfo><button onClick={startTimelapse}>{t("plugins.graph-view.button-animate-timelapse")}</button></SettingItem>}
      </>)}
      {section("forces", t("plugins.graph-view.label-forces"), <>
        {slider(t("plugins.graph-view.option-center-force"), "centerStrength", 0, 1, "any")}
        {slider(t("plugins.graph-view.option-repel-force"), "repelStrength", 0, 20, "any")}
        {slider(t("plugins.graph-view.option-link-force"), "linkStrength", 0, 1, "any")}
        {slider(t("plugins.graph-view.option-link-distance"), "linkDistance", 30, 500, 1, 0)}
      </>)}
    </div>
  </>;
}
