import { path } from "../../platforms/platform";
import { createRoot, type Root } from "react-dom/client";
import { Keymap } from "../compat/commands";
import { TextFileView } from "../compat/file-views";
import { Menu, Notice } from "../compat/ui";
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "../compat/workspace";
import { NodeDataAdapter } from "../compat/node-adapter";
import { t } from "../i18n";
import { CanvasController, CanvasView, parseCanvas, serializeCanvas, type CanvasData } from "./CanvasView";
import type { CanvasViewState } from "./canvas/controller";
import { exportCanvasImage } from "./canvas/export";
import { DEFAULT_GRAPH_SETTINGS, GraphView, copyGraphScreenshot, type GraphSettings } from "./GraphView";
import { FileView } from "../compat/file-views";

/**
 * Each native React view owns its content element. A layout-neutral child keeps
 * its independent React root separate from other native content and lifecycle cleanup.
 */
function reactHost(container: HTMLElement): HTMLElement {
  const host = container.ownerDocument.createElement("div");
  host.className = "view-react-host"; host.style.display = "contents";
  container.append(host);
  return host;
}
function dropReactHosts(container: HTMLElement): void {
  for (const host of container.querySelectorAll(":scope > .view-react-host:empty")) host.remove();
}

/** Canvas documents are JSON text files edited through the canvas surface. */
export class CanvasFileView extends TextFileView {
  private root: Root | null = null;
  private invalid = false;
  /** The document differs from the text that was loaded; until then the file is left byte for byte as it is. */
  private dirty = false;
  readonly canvas: CanvasController;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.canvas = new CanvasController({
      app: this.app, sourcePath: () => this.file?.path ?? "", render: () => {},
      onChange: () => { if (this.invalid) return; this.dirty = true; this.requestSave(); },
      onLocalChange: () => { if (this.file) this.app.saveLocalStorage("canvas-" + this.file.path, this.canvas.readonly ? { readonly: true } : null); },
    });
  }
  getViewType() { return "canvas"; }
  getIcon() { return "lucide-layout-dashboard"; }
  canAcceptExtension(extension: string) { return extension === "canvas"; }
  // An unreadable file is left untouched rather than overwritten with an empty canvas.
  getViewData() { return this.invalid || !this.dirty ? this.data : serializeCanvas(this.canvas.data); }
  setViewData(data: string, clear: boolean) {
    // The file as this view last wrote it is not a change: reloading it would reorder fields and add an undo step.
    if (!clear && !this.invalid && this.dirty && data === serializeCanvas(this.canvas.data)) return;
    let parsed: CanvasData | null = null;
    try { parsed = parseCanvas(data); this.invalid = false; }
    catch { this.invalid = true; new Notice(t("interface.msg-failed-to-load-file", { filepath: this.file?.path ?? "" })); }
    this.dirty = false;
    this.canvas.setData(parsed, clear);
    if (clear) {
      const local = this.file ? this.app.loadLocalStorage("canvas-" + this.file.path) as { readonly?: unknown } | null : null;
      if (typeof local?.readonly === "boolean") this.canvas.setReadonly(local.readonly);
    }
    this.render();
  }
  clear() { this.canvas.clear(); this.invalid = false; this.dirty = false; this.render(); }
  getState() { return { ...super.getState(), viewState: this.canvas.getState() }; }
  async setState(state: unknown, result: ViewStateResult) {
    await super.setState(state, result);
    const viewState = (state as { viewState?: Partial<CanvasViewState> } | null)?.viewState;
    if (viewState) this.canvas.setState(viewState);
  }
  setEphemeralState(state: unknown) {
    super.setEphemeralState(state);
    const next = (state ?? {}) as { focus?: boolean; match?: { nodeId?: string } };
    if (next.focus) this.canvas.wrapperEl?.focus({ preventScroll: true });
    const node = next.match?.nodeId ? this.canvas.node(next.match.nodeId) : null;
    if (node) { this.canvas.selectOnly(node.id); this.canvas.panIntoView({ minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height }); }
  }
  onResize() { this.canvas.onResize(); }
  exportImage() { return exportCanvasImage(this.canvas, this.file?.basename ?? ""); }
  onPaneMenu(menu: Menu, source: string) {
    super.onPaneMenu(menu, source);
    menu.addItem(item => item.setSection("action").setTitle(t("plugins.canvas.action-export-png")).setIcon("lucide-image").onClick(() => void this.exportImage()));
  }
  protected onOpen() {
    Object.assign(this.contentEl.style, { padding: "0px", overflow: "hidden", position: "relative" });
    this.root = createRoot(reactHost(this.contentEl)); this.render();
    // Commands registered by the app shell address the canvas by its file path.
    this.registerEvent(this.app.workspace.on("canvas:command", (command: unknown, target: unknown) => {
      if (target !== this.file?.path) return;
      if (command === "jump-to-group") this.canvas.jumpToGroup();
      else if (command === "export-as-image") void this.exportImage();
      else if (command === "convert-to-file") { const card = this.canvas.convertibleSelection(); if (card) this.canvas.convertToFile(card.id); }
    }));
  }
  private render() {
    if (!this.root) return;
    this.root.render(<CanvasView app={this.app} sourcePath={this.file?.path ?? ""} data={EMPTY_CANVAS} onChange={() => {}} controller={this.canvas} />);
  }
  async onClose() {
    await super.onClose();
    const root = this.root; this.root = null;
    await Promise.resolve();
    root?.unmount(); dropReactHosts(this.contentEl);
    Object.assign(this.contentEl.style, { padding: "", overflow: "", position: "" });
  }
}
const EMPTY_CANVAS: CanvasData = { nodes: [], edges: [] };

const copyScreenshotItem = (menu: Menu, containerEl: HTMLElement) =>
  menu.addItem(item => item.setSection("action").setTitle(t("plugins.graph-view.action-copy-screenshot")).setIcon("lucide-image").onClick(() => void copyGraphScreenshot(containerEl)));

/** Hosts the graph viewer in a workspace leaf. */
export class GraphWorkspaceView extends ItemView {
  private root: Root | null = null;
  private options: Partial<GraphSettings> = {};
  private settingsRevision = 0;
  getViewType() { return "graph"; }
  getDisplayText() { return t("plugins.graph-view.name"); }
  getIcon() { return "lucide-git-fork"; }
  onPaneMenu(menu: Menu, source: string) { super.onPaneMenu(menu, source); copyScreenshotItem(menu, this.contentEl); }
  /** @internal Graph bookmark options are separate from the reference's empty global-view state. */
  getGraphOptions() { return this.options; }
  setGraphOptions(options: Partial<GraphSettings>) { this.options = { ...DEFAULT_GRAPH_SETTINGS, ...options }; this.settingsRevision++; this.render(); }
  protected async onOpen() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof NodeDataAdapter)) return;
    let saved: Partial<GraphSettings> = {};
    try { saved = JSON.parse(await adapter.read(`${this.app.vault.configDir}/graph.json`)) as Partial<GraphSettings>; } catch { /* A new vault uses the defaults. */ }
    this.options = { ...DEFAULT_GRAPH_SETTINGS, ...saved };
    Object.assign(this.contentEl.style, { padding: "0px", overflow: "hidden", position: "relative" });
    this.root = createRoot(reactHost(this.contentEl));
    this.render();
  }
  private render() {
    const adapter = this.app.vault.adapter;
    if (!this.root || !(adapter instanceof NodeDataAdapter)) return;
    // A note opens in the graph's own tab (the graph stays in its history) unless a modifier asks for another one.
    this.root.render(<GraphView key={this.settingsRevision} app={this.app} leaf={this.leaf} initial={this.options} onSettingsChange={settings => { this.options = settings; }} vaultPath={adapter.basePath} configDir={path.join(adapter.basePath, this.app.vault.configDir)}
      onOpen={(target, event) => { void this.app.workspace.openLinkText(target, "", Keymap.isModEvent(event)); }} />);
  }
  protected async onClose() {
    const root = this.root; this.root = null;
    // Plugin disablement can close this view from the app shell's React effect.
    // Let that commit finish before tearing down this independent React root.
    await Promise.resolve();
    root?.unmount(); dropReactHosts(this.contentEl);
    Object.assign(this.contentEl.style, { padding: "", overflow: "", position: "" });
  }
}

/** Graph of the notes around one file. It follows the active note unless its tab is pinned or linked to another tab, whose note it then shows. */
export class LocalGraphWorkspaceView extends ItemView {
  navigation = false;
  private root: Root | null = null;
  private centerPath: string | null = null;
  private options: Partial<GraphSettings> = {};
  private get bound(): boolean { return this.leaf.pinned || !!this.leaf.group; }
  getViewType() { return "localgraph"; }
  getDisplayText() {
    const name = this.centerPath && this.bound ? this.app.vault.getFileByPath(this.centerPath)?.basename : null;
    return name ? t("plugins.graph-view.tab-title", { displayText: name }) : t("plugins.graph-view.local-name");
  }
  getIcon() { return "lucide-git-fork"; }
  getState() { return { file: this.centerPath, options: this.options }; }
  async setState(state: unknown) {
    const next = (state ?? {}) as { file?: unknown; options?: unknown; group?: unknown };
    if (typeof next.file === "string") this.centerPath = next.file;
    if (next.options && typeof next.options === "object") this.options = next.options as Partial<GraphSettings>;
    this.render();
  }
  onPaneMenu(menu: Menu, source: string) { super.onPaneMenu(menu, source); copyScreenshotItem(menu, this.contentEl); }
  /** The note of the tab this one is linked to, if any. */
  private groupFile(): string | null {
    if (!this.leaf.group) return null;
    for (const other of this.app.workspace.getGroupLeaves(this.leaf.group)) if (other !== this.leaf && other.view instanceof FileView && other.view.file) return other.view.file.path;
    return null;
  }
  private show(filePath: string | null): void {
    if (filePath === this.centerPath) return;
    this.centerPath = filePath; this.render(); this.app.workspace.notifyLayoutChange();
  }
  protected onOpen() {
    Object.assign(this.contentEl.style, { padding: "0px", overflow: "hidden", position: "relative" });
    this.root = createRoot(reactHost(this.contentEl));
    this.centerPath ??= this.groupFile() ?? this.app.workspace.activeFile?.path ?? null;
    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (this.leaf.group) { const linked = this.groupFile(); if (linked) this.show(linked); return; }
      if (this.leaf.pinned || !file || !(this.app.workspace.activeLeaf?.view instanceof FileView)) return;
      this.show(file.path);
    }));
    this.registerEvent(this.leaf.on("group-change", () => this.show(this.groupFile() ?? this.app.workspace.activeFile?.path ?? this.centerPath)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (oldPath === this.centerPath) { this.centerPath = file.path; this.render(); } }));
    this.render();
  }
  private render() {
    const adapter = this.app.vault.adapter;
    if (!this.root || !(adapter instanceof NodeDataAdapter)) return;
    this.root.render(<GraphView key="local" app={this.app} leaf={this.leaf} vaultPath={adapter.basePath} configDir={path.join(adapter.basePath, this.app.vault.configDir)} localFile={this.centerPath}
      initial={this.options} onSettingsChange={settings => { this.options = settings; this.app.workspace.requestSaveLayout(); }}
      onOpen={(target, event) => { void this.app.workspace.openLinkText(target, "", Keymap.isModEvent(event)); }} />);
  }
  protected async onClose() {
    const root = this.root; this.root = null;
    await Promise.resolve();
    root?.unmount(); dropReactHosts(this.contentEl);
    Object.assign(this.contentEl.style, { padding: "", overflow: "", position: "" });
  }
}
