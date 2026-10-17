import { Menu, trackActiveWindow } from "./ui";
import { Component } from "./component";
import { t } from "../i18n";
import { Events, type EventRef } from "./events";
import type { App } from "./plugin";
import { Editor, type EditorPosition, type EditorRange } from "./editor";
import { TFile } from "./vault";
import { parseMarkdownMetadata } from "./metadata-cache";
import { debounce, setIcon } from "./utilities";
import { installDomExtensions } from "./dom";
import { isFileView } from "./file-view-type";

export type PaneType = "tab" | "split" | "window";
export type SplitDirection = "vertical" | "horizontal";
export type IconName = string;

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  icon?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  group?: WorkspaceLeaf | null;
}

export interface OpenViewState {
  state?: Record<string, unknown>;
  eState?: Record<string, unknown>;
  active?: boolean;
  group?: WorkspaceLeaf | null;
}

export interface ViewStateResult { history: boolean; layout?: boolean; close?: boolean; done?: () => void }
export type ViewCreator = (leaf: WorkspaceLeaf) => View;

/** Base class for content hosted by a WorkspaceLeaf. */
export abstract class View extends Component {
  app: App;
  icon: IconName = "lucide-file";
  navigation = true;
  readonly leaf: WorkspaceLeaf;
  readonly containerEl: HTMLElement;
  scope: unknown = null;
  private ephemeralState: Record<string, unknown> = {};

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.workspace.app;
    this.containerEl = makeContainer(leaf.containerEl.ownerDocument);
    if (this.containerEl.classList) this.containerEl.className = "workspace-leaf-content";
  }

  protected onOpen(): Promise<void> | void {}
  protected onClose(): Promise<void> | void {}
  abstract getViewType(): string;
  abstract getDisplayText(): string;
  get appId(): string { return "app.obsidian"; }
  get contentEl(): HTMLElement { return this.containerEl; }
  getState(): Record<string, unknown> { return {}; }
  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}
  getEphemeralState(): Record<string, unknown> { return { ...this.ephemeralState }; }
  setEphemeralState(state: unknown): void {
    this.ephemeralState = state && typeof state === "object" ? { ...state as Record<string, unknown> } : {};
  }
  getIcon(): IconName { return this.icon; }
  onResize(): void {}
  onPaneMenu(_menu: unknown, _source: string): void {}

  /** @internal */
  async openView(): Promise<void> {
    if (this.containerEl.dataset) this.containerEl.dataset.type = this.getViewType();
    this.load();
    try { await this.onOpen(); }
    catch (error) {
      try { await this.onClose(); }
      catch (closeError) {
        try { this.unload(); }
        catch (unloadError) { throw new AggregateError([error, closeError, unloadError], "View failed to open and cleanup failed."); }
        throw new AggregateError([error, closeError], "View failed to open and cleanup failed.");
      }
      this.unload();
      throw error;
    }
  }

  /** @internal */
  async closeView(): Promise<void> {
    try { await this.onClose(); }
    finally { this.unload(); }
  }
}

/** A view with a content area and optional header actions. */
export abstract class ItemView extends View {
  /** @internal Native frame for the host's header portal, separate from view-owned content. */
  readonly headerEl: HTMLElement;
  private readonly itemContentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.headerEl = makeContainer(this.containerEl.ownerDocument);
    if (this.headerEl.classList) this.headerEl.className = "view-header";
    this.itemContentEl = makeContainer(this.containerEl.ownerDocument);
    if (this.itemContentEl.classList) this.itemContentEl.className = "view-content";
    this.containerEl.append?.(this.headerEl, this.itemContentEl);
  }
  override get contentEl(): HTMLElement { return this.itemContentEl; }

  /** @internal Header buttons registered by the view; the host places them in `.view-actions`. */
  readonly actionEls: HTMLElement[] = [];

  addAction(icon: IconName, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
    const action = this.containerEl.ownerDocument.createElement("button");
    action.className = "clickable-icon view-action";
    action.setAttribute("aria-label", title);
    setIcon(action, icon);
    action.addEventListener("click", callback);
    this.actionEls.push(action);
    this.app.workspace.trigger("layout-change");
    this.register(() => { const index = this.actionEls.indexOf(action); if (index >= 0) this.actionEls.splice(index, 1); action.remove(); });
    return action;
  }
}

/** A plugin pane restored before it is first selected is materialized on demand. */
class DeferredView extends View {
  private state: Record<string, unknown>;
  private rerenderPromise: Promise<void> | null = null;
  constructor(leaf: WorkspaceLeaf, private readonly viewState: ViewState, private readonly creator: ViewCreator) {
    super(leaf);
    this.state = { ...(viewState.state ?? {}) };
  }
  getViewType(): string { return this.viewState.type; }
  getDisplayText(): string { return this.viewState.title ?? this.viewState.type; }
  override getIcon(): string { return this.viewState.icon ?? "lucide-ghost"; }
  override getState(): Record<string, unknown> { return { ...this.state }; }
  override async setState(state: unknown): Promise<void> {
    this.state = state && typeof state === "object" ? { ...state as Record<string, unknown> } : {};
  }
  async rerender(): Promise<void> {
    if (this.leaf.view !== this) return;
    if (this.rerenderPromise) return this.rerenderPromise;
    this.rerenderPromise = (async () => {
      const view = this.creator(this.leaf);
      await this.leaf.open(view);
      await view.setState(this.state, { history: false });
      view.setEphemeralState(this.getEphemeralState());
    })();
    try { await this.rerenderPromise; }
    finally { this.rerenderPromise = null; }
  }
}

/** A node in the workspace pane tree. */
export abstract class WorkspaceItem extends Events {
  id = allocateLeafId();
  dimension: number | null = null;
  parent: WorkspaceParent | null = null;
  getRoot(): WorkspaceItem {
    let item: WorkspaceItem = this;
    while (item.parent && !(item instanceof WorkspaceSidedock)) item = item.parent;
    return item;
  }
  getContainer(): WorkspaceContainer {
    let root: WorkspaceItem = this;
    while (root.parent) root = root.parent;
    if (root instanceof WorkspaceContainer) return root;
    throw new Error("Workspace item is not attached to a root container.");
  }
}

export abstract class WorkspaceParent extends WorkspaceItem {
  abstract readonly children: WorkspaceItem[];
  addChild(child: WorkspaceItem, index = this.children.length): void {
    assertNoWorkspaceCycle(this, child);
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, child);
  }
  moveChild(child: WorkspaceItem, index: number): void {
    const oldIndex = this.children.indexOf(child);
    if (child.parent === this && oldIndex >= 0) {
      this.children.splice(oldIndex, 1);
      this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, child);
      return;
    }
    this.addChild(child, index);
  }
  reorderChild(child: WorkspaceItem, index: number): void { this.moveChild(child, index); }
  removeChild(child: WorkspaceItem): number {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
    }
    return index;
  }
  replaceChild(oldChild: WorkspaceItem, newChild: WorkspaceItem): void {
    assertNoWorkspaceCycle(this, newChild);
    const index = this.children.indexOf(oldChild);
    if (index < 0) throw new Error("Workspace child is not attached to this parent.");
    oldChild.parent = null;
    newChild.parent?.removeChild(newChild);
    newChild.parent = this;
    this.children[index] = newChild;
  }
}

/** A split node lays out children along one axis. `vertical` means side by side. */
export class WorkspaceSplit extends WorkspaceParent {
  readonly children: WorkspaceItem[] = [];
  constructor(public direction: SplitDirection = "vertical") { super(); }
  override addChild(child: WorkspaceItem, index = this.children.length): void {
    if (!(child instanceof WorkspaceSplit) && !(child instanceof WorkspaceTabs)) {
      throw new TypeError("Workspace splits can only contain nested splits or tab groups.");
    }
    super.addChild(child, index);
  }
}

export class WorkspaceTabs extends WorkspaceParent {
  readonly children: WorkspaceLeaf[] = [];
  declare parent: WorkspaceSplit | null;
  activeLeaf: WorkspaceLeaf | null = null;
  /** Stacked tab groups lay their tabs out side by side as sliding panes. */
  isStacked = false;
  get leaves(): WorkspaceLeaf[] { return this.children; }
  getLeafIndex(leaf: WorkspaceLeaf): number { return this.children.indexOf(leaf); }
  addLeaf(leaf: WorkspaceLeaf, index = this.children.length): void {
    if (!(leaf instanceof WorkspaceLeaf)) throw new TypeError("Workspace tabs can only contain workspace leaves.");
    if (leaf.parent === this) {
      this.reorderLeaf(leaf, index);
      return;
    }
    leaf.parent?.removeChild(leaf);
    leaf.parent = this;
    this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, leaf);
    if (!this.activeLeaf) this.activeLeaf = leaf;
  }
  moveLeaf(leaf: WorkspaceLeaf, index: number): void { this.addLeaf(leaf, index); }
  reorderLeaf(leaf: WorkspaceLeaf, index: number): void {
    const oldIndex = this.children.indexOf(leaf);
    if (oldIndex < 0) throw new Error("Workspace leaf is not in this tab group.");
    this.children.splice(oldIndex, 1);
    this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, leaf);
  }
  activateLeaf(leaf: WorkspaceLeaf): void {
    if (leaf.parent !== this) throw new Error("Only a leaf in this tab group can be activated.");
    this.activeLeaf = leaf;
  }
  override addChild(child: WorkspaceItem, index = this.children.length): void {
    if (!(child instanceof WorkspaceLeaf)) throw new TypeError("Workspace tab groups can only contain leaves.");
    this.addLeaf(child, index);
  }
  override removeChild(child: WorkspaceItem): number {
    if (!(child instanceof WorkspaceLeaf)) return -1;
    const index = this.children.indexOf(child);
    if (index < 0) return -1;
    this.children.splice(index, 1);
    child.parent = null;
    if (this.activeLeaf === child) this.activeLeaf = this.children[Math.min(index, this.children.length - 1)] ?? null;
    return index;
  }
  override replaceChild(oldChild: WorkspaceItem, newChild: WorkspaceItem): void {
    if (!(newChild instanceof WorkspaceLeaf)) throw new TypeError("Workspace tab groups can only contain leaves.");
    const index = this.removeChild(oldChild);
    if (index < 0) throw new Error("Workspace child is not attached to this tab group.");
    this.addLeaf(newChild, index);
  }
}

/** Root container metadata; it does not represent a native or popout window. */
export class WorkspaceContainer extends WorkspaceSplit {
  readonly win: Window;
  readonly doc: Document;
  constructor(direction: SplitDirection = "vertical", win?: Window) {
    super(direction);
    this.win = win ?? (typeof window === "undefined" ? {} as Window : window);
    this.doc = win?.document ?? (typeof document === "undefined" ? {} as Document : document);
  }
}

export class WorkspaceRoot extends WorkspaceContainer {}
export interface WorkspaceWindowInitData { x?: number; y?: number; size?: { width: number; height: number }; width?: number; height?: number; }
export class WorkspaceWindow extends WorkspaceContainer {
  constructor(win: Window) { super("vertical", win); }
}

export class WorkspaceSidedock extends WorkspaceSplit {
  collapsed = false;
  constructor(readonly side: "left" | "right") { super("horizontal"); }
  toggle(): void { this.collapsed = !this.collapsed; }
  collapse(): void { this.collapsed = true; }
  expand(): void { this.collapsed = false; }
}

/** A workspace pane. View replacement awaits close/open hooks before resolving. */
export class WorkspaceLeaf extends WorkspaceItem {
  activeTime = 0;
  readonly containerEl: HTMLElement;
  declare parent: WorkspaceTabs | null;
  view: View;
  hoverPopover: unknown = null;
  pinned = false;
  group: string | null = null;
  get isDeferred(): boolean { return this.view instanceof DeferredView; }
  private openQueue: Promise<unknown> = Promise.resolve();
  private navigatingHistory = false;
  readonly history = {
    backHistory: [] as Array<{ title: string; icon: string; state: ViewState; eState: Record<string, unknown> }>,
    forwardHistory: [] as Array<{ title: string; icon: string; state: ViewState; eState: Record<string, unknown> }>,
    back: () => this.navigateHistory(-1),
    forward: () => this.navigateHistory(1),
  };
  getHistoryState() { return { title: this.getDisplayText(), icon: this.getIcon(), state: structuredCloneSafe(this.getViewState()), eState: structuredCloneSafe(this.getEphemeralState()) }; }
  recordHistory(state: ReturnType<WorkspaceLeaf["getHistoryState"]>): void {
    const previous = this.history.backHistory.at(-1);
    if (previous && JSON.stringify(previous.state) === JSON.stringify(state.state)) return;
    this.history.backHistory.push(state); this.history.forwardHistory.splice(0);
  }
  private async navigateHistory(direction: number): Promise<void> {
    const source = direction < 0 ? this.history.backHistory : this.history.forwardHistory;
    const destination = direction < 0 ? this.history.forwardHistory : this.history.backHistory;
    const target = source.pop(); if (!target) return;
    const current = this.getHistoryState(); this.navigatingHistory = true;
    try { await this.setViewState({ ...target.state, active: true }); this.setEphemeralState(target.eState); destination.push(current); }
    catch (error) { source.push(target); throw error; }
    finally { this.navigatingHistory = false; this.workspace.notifyLayoutChange(); }
  }

  constructor(readonly workspace: Workspace, containerEl?: HTMLElement) {
    super();
    this.containerEl = containerEl ?? makeContainer();
    if (this.containerEl.classList) this.containerEl.classList.add("workspace-leaf");
    this.view = new EmptyView(this);
    void this.view.openView();
  }

  async open(view: View): Promise<View> {
    if (view.leaf !== this) throw new Error("A view can only be opened in the leaf it was created for.");
    const opening = this.openQueue.then(async () => {
      const previous = this.view;
      if (previous === view) return view;
      // Each view owns its frame. Opening or closing a replacement cannot empty
      // the prior view's DOM or invalidate its React root.
      this.view = view;
      try {
        await view.openView();
        try { await previous.closeView(); }
        catch (error) { await view.closeView(); throw error; }
        previous.containerEl.remove?.();
      } catch (error) {
        this.view = previous;
        throw error;
      }
      this.workspace.onLeafViewChanged(this);
      this.workspace.notifyLayoutChange();
      return view;
    });
    this.openQueue = opening.catch(() => undefined);
    return opening;
  }

  async openFile(file: TFile, openState?: OpenViewState): Promise<void> {
    const current = this.view as View & { canAcceptExtension?: (extension: string) => boolean; canAcceptPath?: (path: string) => boolean };
    const type = current.canAcceptExtension?.(file.extension) && (current.canAcceptPath?.(file.path) ?? true) ? current.getViewType() : this.workspace.getViewTypeByExtension(file.extension, file.path);
    if (!type) { this.workspace.trigger("open-with-default-app", file); return; }
    await this.setViewState({ type, state: { ...openState?.state, file: file.path }, active: openState?.active ?? this.workspace.activeLeaf === this, group: openState?.group });
    if (openState?.eState) this.view.setEphemeralState(openState.eState);
    this.workspace.setOpenedFile(file);
    this.trigger("open-file", file);
  }

  getViewState(): ViewState {
    return { type: this.view.getViewType(), state: this.view.getState(), icon: this.getIcon(), title: this.getDisplayText(), ...(this.pinned ? { pinned: true } : {}) };
  }

  async setViewState(viewState: ViewState, result: ViewStateResult = { history: false }): Promise<void> {
    const previous = this.view.getViewType() !== "empty" ? this.getHistoryState() : null;
    let view: View;
    try {
      view = this.view.getViewType() === viewState.type && !(this.view instanceof UnavailableView && this.workspace.viewRegistry.has(viewState.type)) ? this.view : this.workspace.createView(viewState.type, this);
      if (view !== this.view) { await this.open(view); result.history = true; }
    } catch (error) {
      throw error;
    }
    await view.setState(viewState.state ?? {}, result);
    if (viewState.pinned !== undefined) this.setPinned(viewState.pinned);
    if (viewState.group !== undefined) this.setGroupMember(viewState.group);
    if (viewState.active) { this.workspace.setActiveLeaf(this); await this.loadIfDeferred(); }
    this.workspace.onLeafViewChanged(this);
    if (!this.navigatingHistory && previous && result.history && view.navigation) this.recordHistory(previous);
    this.workspace.notifyLayoutChange();
    result.done?.();
  }

  async loadIfDeferred(): Promise<void> {
    if (this.view instanceof DeferredView) await this.view.rerender();
  }
  getEphemeralState(): Record<string, unknown> { return this.view.getEphemeralState(); }
  setEphemeralState(state: unknown): void { this.view.setEphemeralState(state); }
  togglePinned(): void { this.setPinned(!this.pinned); }
  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.trigger("pinned-change", pinned);
    this.workspace.notifyLayoutChange();
    if (this.group) for (const leaf of this.workspace.getGroupLeaves(this.group)) if (leaf.pinned !== pinned) leaf.setPinned(pinned);
  }
  setGroupMember(other: WorkspaceLeaf | null): void {
    if (other === this) return;
    let group: string | null = null;
    if (other) {
      group = other.group;
      if (!group) { group = crypto.randomUUID().replaceAll("-", "").slice(0, 16); other.setGroup(group); }
    }
    this.setGroup(group);
  }
  setGroup(group: string | null): void {
    if (this.group === group) return;
    this.setPinned(this.pinned || this.workspace.getGroupLeaves(group).some(leaf => leaf.pinned));
    this.group = group;
    this.trigger("group-change", group);
    this.workspace.notifyLayoutChange();
  }
  detach(): void { this.workspace.detachLeaf(this); }
  getIcon(): IconName { return this.view.getIcon(); }
  getDisplayText(): string { return this.view.getDisplayText(); }
  onResize(): void { this.view.onResize(); }

  override on(name: "pinned-change", callback: (pinned: boolean) => unknown, ctx?: unknown): EventRef;
  override on(name: "group-change", callback: (group: string) => unknown, ctx?: unknown): EventRef;
  override on(name: string, callback: (...data: any[]) => any, ctx?: unknown): EventRef {
    return super.on(name, callback, ctx);
  }
}

/** Plugin-facing handle for the ribbon elements rendered by the workspace shell. */
type WorkspaceRibbonItem = { id: string; icon: string; title: string; callback: (event: MouseEvent) => void; hidden: boolean; buttonEl: HTMLElement };
export class WorkspaceRibbon {
  private readonly itemCache = new Map<HTMLElement, WorkspaceRibbonItem>();
  private readonly currentItems: WorkspaceRibbonItem[] = [];
  constructor(readonly workspace: Workspace, readonly side: "left" | "right") {}
  get containerEl(): HTMLElement | null {
    return this.workspace.containerEl.ownerDocument.querySelector(`.workspace-ribbon.${this.side === "left" ? "mod-primary" : "mod-secondary"}`);
  }
  get ribbonItemsEl(): HTMLElement | null { return this.containerEl?.querySelector(".side-dock-actions") ?? null; }
  get ribbonSettingEl(): HTMLElement | null { return this.containerEl?.querySelector(".side-dock-settings") ?? null; }
  get items(): WorkspaceRibbonItem[] {
    const buttons = [...(this.ribbonItemsEl?.querySelectorAll<HTMLElement>(".side-dock-ribbon-action") ?? [])];
    for (const buttonEl of this.itemCache.keys()) if (!buttons.includes(buttonEl)) this.itemCache.delete(buttonEl);
    const next = buttons.map(buttonEl => {
      const title = buttonEl.getAttribute("aria-label") ?? "";
      const source = buttonEl.dataset.ribbonId ?? "";
      let item = this.itemCache.get(buttonEl);
      if (!item) {
        item = {
          id: source ? `${source}:${title}` : title,
          icon: buttonEl.dataset.icon ?? [...(buttonEl.querySelector("svg")?.classList ?? [])].find(name => name !== "svg-icon") ?? "",
          title,
          callback: () => buttonEl.click(),
          hidden: buttonEl.hidden || buttonEl.style.display === "none",
          buttonEl,
        };
        this.itemCache.set(buttonEl, item);
      }
      item.hidden = buttonEl.hidden || buttonEl.style.display === "none";
      return item;
    });
    this.currentItems.splice(0, this.currentItems.length, ...next);
    return this.currentItems;
  }
}

/** Minimal workspace and view registry for plugins that create their own panes. */
export class Workspace extends Events {
  readonly containerEl: HTMLElement;
  readonly app: App;
  private ready = false;
  get layoutReady(): boolean { return this.ready; }
  activeLeaf: WorkspaceLeaf | null = null;
  private currentActiveEditor: unknown = null;
  private currentActiveFile: import("./vault").TFile | null = null;
  private boundEditor: Editor | null = null;
  private readonly onBoundEditorChange = (editor: Editor) => {
    this.trigger("editor-change", editor, this.getEditorInfo(editor));
  };
  get activeEditor(): unknown {
    if (this.currentActiveEditor && !(this.currentActiveEditor instanceof Editor) && (this.currentActiveEditor as { editor?: unknown }).editor) return this.currentActiveEditor;
    const view = this.activeMarkdownView as (View & { editor?: unknown }) | null;
    return view?.editor ?? this.currentActiveEditor;
  }
  set activeEditor(editor: unknown) {
    if (this.currentActiveEditor === editor) return;
    this.currentActiveEditor = editor;
    this.bindActiveEditor();
  }
  get activeFile(): import("./vault").TFile | null {
    const editorFile = (this.currentActiveEditor as { file?: import("./vault").TFile } | null)?.file;
    if (editorFile) return editorFile;
    const view = this.activeMarkdownView as (View & { file?: import("./vault").TFile | null }) | null;
    return view?.file ?? this.currentActiveFile;
  }
  set activeFile(file: import("./vault").TFile | null) {
    if (this.currentActiveFile === file) return;
    this.currentActiveFile = file;
    this.trigger("file-open", file);
  }
  get activeMarkdownView(): View | null { return this.activeLeaf?.view ?? null; }
  readonly rootSplit = new WorkspaceRoot();
  readonly leftRibbon = new WorkspaceRibbon(this, "left");
  readonly rightRibbon = new WorkspaceRibbon(this, "right");
  readonly floatingSplit: WorkspaceWindow[] = [];
  private nextPopoutId = 0;
  rightSplit: WorkspaceSidedock | null = null;
  leftSplit: WorkspaceSidedock | null = null;
  private readonly leaves = new Set<WorkspaceLeaf>();
  private readonly viewCreators = new Map<string, ViewCreator>();
  private readonly pluginViewTypes = new Set<string>();
  private readonly recentFiles: string[] = [];
  private readonly extensionTypes = new Map<string, string>([["md", "markdown"]]);
  private saveQueue: Promise<void> = Promise.resolve();
  private restoringLayout = false;
  private disposing = false;
  private stopTabLink: (() => void) | null = null;
  private layoutExtras: Record<string, unknown> = {};
  readonly requestSaveLayout = debounce(() => { void this.saveLayout(); }, 1000, true);
  getViewTypeByExtension(extension: string, filePath?: string): string | null {
    const configDir = this.app.vault?.configDir;
    if (filePath && configDir && (filePath === configDir || filePath.startsWith(`${configDir}/`))) return this.extensionTypes.get("*") ?? this.extensionTypes.get(extension.toLowerCase()) ?? null;
    return this.extensionTypes.get(extension.toLowerCase()) ?? null;
  }
  registerExtensions(extensions: string[], viewType: string): void { for (const extension of extensions) this.extensionTypes.set(extension.toLowerCase(), viewType); }
  unregisterExtensions(viewType: string): void { for (const [extension, type] of this.extensionTypes) if (type === viewType) this.extensionTypes.delete(extension); }
  async saveLayout(): Promise<void> {
    if (this.restoringLayout || this.disposing || !this.layoutReady || !this.app.vault) return;
    const snapshot = JSON.stringify(this.getLayout(), null, 2);
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
      const directory = this.app.vault.configDir;
      if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory);
      await this.app.vault.adapter.write(`${directory}/workspace.json`, snapshot);
    });
    await this.saveQueue;
  }
  async loadLayout(): Promise<void> {
    const filename = `${this.app.vault.configDir}/workspace.json`;
    this.restoringLayout = true;
    try {
      if (await this.app.vault.adapter.exists(filename)) await this.changeLayout(JSON.parse(await this.app.vault.adapter.read(filename)));
      if (!this.getMostRecentLeaf()) this.getLeaf();
    } finally {
      this.restoringLayout = false; this.ready = true;
      for (const callback of this.layoutReadyCallbacks.splice(0)) callback();
    }
  }
  stopPersistence(): void { this.disposing = true; this.stopTabLink?.(); this.requestSaveLayout.cancel(); }
  get viewRegistry(): Map<string, ViewCreator> { return this.viewCreators; }
  private readonly layoutReadyCallbacks: Array<() => unknown> = [];

  constructor(app: App, containerEl?: HTMLElement) {
    super();
    this.app = app;
    this.containerEl = containerEl ?? makeContainer();
  }

  registerView(type: string, creator: ViewCreator): void {
    if (!type.trim()) throw new Error("A view type is required.");
    if (this.viewCreators.has(type)) throw new Error(`View type already registered: ${type}`);
    this.viewCreators.set(type, creator);
    for (const leaf of this.leaves) if (leaf.view instanceof UnavailableView && leaf.view.getViewType() === type) void leaf.setViewState(leaf.getViewState());
    this.trigger("view-registered", type);
  }

  /** @internal Plugin views restored in background tabs are loaded when first selected. */
  registerPluginView(type: string, creator: ViewCreator): void {
    if (!type.trim()) throw new Error("A view type is required.");
    if (this.viewCreators.has(type)) throw new Error(`View type already registered: ${type}`);
    this.viewCreators.set(type, creator);
    this.pluginViewTypes.add(type);
    for (const leaf of this.leaves) {
      if (!(leaf.view instanceof UnavailableView) || leaf.view.getViewType() !== type) continue;
      const state = leaf.getViewState();
        if (leaf !== this.activeLeaf) {
        void leaf.open(new DeferredView(leaf, state, creator)).catch(error => console.error(`Failed to defer plugin view ${type}`, error));
      } else {
        void leaf.setViewState(state).catch(error => console.error(`Failed to restore plugin view ${type}`, error));
      }
    }
    this.trigger("view-registered", type);
  }

  unregisterView(type: string): void {
    this.viewCreators.delete(type);
    this.pluginViewTypes.delete(type);
    this.detachLeavesOfType(type);
  }

  createView(type: string, leaf: WorkspaceLeaf): View {
    if (type === "empty") return new EmptyView(leaf);
    const creator = this.viewCreators.get(type);
    if (!creator) return new UnavailableView(leaf, type);
    const view = creator(leaf);
    if (!(view instanceof View)) throw new Error(`View creator for ${type} did not return a View.`);
    return view;
  }

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) callback();
    else this.layoutReadyCallbacks.push(callback);
  }

  getLeaf(newLeaf?: PaneType | boolean, direction: SplitDirection = "vertical"): WorkspaceLeaf {
    if (newLeaf === undefined || newLeaf === false) {
      return this.getUnpinnedLeaf();
    }
    if (newLeaf === "window") return this.openPopoutLeaf();
    if (newLeaf === "split") {
      if (this.activeLeaf) return this.createLeafBySplit(this.activeLeaf, direction);
      return this.createRootLeaf();
    }
    const recent = this.getMostRecentLeaf();
    if (recent?.view.getViewType() === "empty") { this.setActiveLeaf(recent); return recent; }
    const leaf = this.createTabLeaf(recent?.parent ?? this.findFirstTabs());
    if (recent?.parent && leaf.parent === recent.parent) leaf.parent.reorderLeaf(leaf, leaf.parent.children.indexOf(recent) + 1);
    if (!this.activeLeaf || newLeaf === "tab" || newLeaf === true) this.setActiveLeaf(leaf);
    return leaf;
  }

  createLeafBySplit(leaf: WorkspaceLeaf, direction: SplitDirection = "vertical", before = false): WorkspaceLeaf {
    const tabs = leaf.parent;
    if (!tabs) throw new Error("Cannot split a detached workspace leaf.");
    const parent = tabs.parent;
    if (!parent) throw new Error("Cannot split a workspace leaf without an attached tab group.");
    const siblingTabs = new WorkspaceTabs();
    const siblingLeaf = new WorkspaceLeaf(this);
    siblingTabs.addChild(siblingLeaf);
    this.leaves.add(siblingLeaf);
    const siblingIndex = parent.children.indexOf(tabs) + (before ? 0 : 1);
    if (parent instanceof WorkspaceSplit && parent.direction === direction) {
      parent.addChild(siblingTabs, siblingIndex);
    } else {
      const split = new WorkspaceSplit(direction);
      parent.replaceChild(tabs, split);
      split.addChild(before ? siblingTabs : tabs);
      split.addChild(before ? tabs : siblingTabs);
    }
    this.setActiveLeaf(siblingLeaf);
    this.notifyLayoutChange();
    return siblingLeaf;
  }

  openPopoutLeaf(data: WorkspaceWindowInitData = {}): WorkspaceLeaf {
    const win = this.rootSplit.win.open("about:blank", `obsen-popout-${this.rootSplit.id}-${++this.nextPopoutId}`, `width=${data.size?.width ?? data.width ?? 800},height=${data.size?.height ?? data.height ?? 600},left=${data.x ?? 100},top=${data.y ?? 100}`);
    if (!win) throw new Error(t("obsen.workspaces.error-open-popout"));
    installDomExtensions(win);
    win.document.title = this.app.vault.getName();
    win.document.body.className = this.rootSplit.doc.body.className;
    win.document.body.classList.remove("is-focused", "is-grabbing");
    win.document.body.classList.add("is-popout-window");
    win.document.body.style.cssText = this.rootSplit.doc.body.style.cssText;
    win.document.documentElement.style.cssText = this.rootSplit.doc.documentElement.style.cssText;
    for (const style of this.rootSplit.doc.querySelectorAll("style,link[rel=stylesheet]")) win.document.head.append(style.cloneNode(true));
    const container = new WorkspaceWindow(win), tabs = new WorkspaceTabs();
    container.addChild(tabs); this.floatingSplit.push(container);
    const element = win.document.createElement("div"); element.className = "workspace-leaf"; element.style.height = "100vh"; win.document.body.append(element);
    const leaf = new WorkspaceLeaf(this, element); tabs.addChild(leaf); this.leaves.add(leaf);
    const stopTrackingWindow = trackActiveWindow(win);
    win.addEventListener("resize", () => { for (const child of this.collectLeaves(container)) child.view.onResize(); this.trigger("resize"); });
    win.addEventListener("beforeunload", () => {
      stopTrackingWindow();
      for (const child of this.collectLeaves(container)) child.detach();
      const index = this.floatingSplit.indexOf(container); if (index >= 0) this.floatingSplit.splice(index, 1);
      this.trigger("window-close", container, win);
      if (!this.disposing) this.rootSplit.win.setTimeout(() => {
        this.rootSplit.win.focus();
        const mainLeaves = this.collectLeaves(this.rootSplit, true);
        const current = this.activeLeaf && mainLeaves.includes(this.activeLeaf) ? this.activeLeaf : mainLeaves.sort((a, b) => b.activeTime - a.activeTime)[0];
        if (current) { this.setActiveLeaf(current); const view = current.view as View & { editor?: { focus(): void } }; view.editor?.focus(); }
      }, 0);
    });
    this.trigger("window-open", container, win); this.setActiveLeaf(leaf); this.notifyLayoutChange();
    return leaf;
  }

  moveLeafToPopout(leaf: WorkspaceLeaf, data?: WorkspaceWindowInitData): WorkspaceWindow {
    const oldTabs = leaf.parent, oldParent = oldTabs?.parent ?? null;
    const placeholder = this.openPopoutLeaf(data), parent = placeholder.parent!;
    const container = placeholder.getContainer() as WorkspaceWindow;
    parent.addChild(leaf); placeholder.detach();
    if (oldTabs && oldTabs.children.length === 0) {
      oldParent?.removeChild(oldTabs);
      this.collapseEmptySplits(oldParent);
    }
    container.doc.body.replaceChildren(leaf.containerEl); leaf.containerEl.style.height = "100vh";
    this.setActiveLeaf(leaf); this.notifyLayoutChange(); return container;
  }

  createLeafInParent(parent: WorkspaceSplit, index: number): WorkspaceLeaf {
    const tabs = new WorkspaceTabs();
    const leaf = new WorkspaceLeaf(this);
    tabs.addChild(leaf);
    parent.addChild(tabs, index);
    this.leaves.add(leaf);
    this.notifyLayoutChange();
    return leaf;
  }

  splitActiveLeaf(direction: SplitDirection = "vertical"): WorkspaceLeaf {
    return this.activeLeaf ? this.createLeafBySplit(this.activeLeaf, direction) : this.createRootLeaf();
  }

  /** Create a neighboring leaf and restore the source leaf's view state into it. */
  async duplicateLeaf(leaf: WorkspaceLeaf, direction?: SplitDirection): Promise<WorkspaceLeaf>;
  async duplicateLeaf(leaf: WorkspaceLeaf, leafType: PaneType | boolean, direction?: SplitDirection): Promise<WorkspaceLeaf>;
  async duplicateLeaf(
    leaf: WorkspaceLeaf,
    leafTypeOrDirection: PaneType | boolean | SplitDirection = "vertical",
    requestedDirection: SplitDirection = "vertical",
  ): Promise<WorkspaceLeaf> {
    if (!this.leaves.has(leaf)) throw new Error("Cannot duplicate a detached workspace leaf.");
    // The deprecated overload takes a direction as its second argument.
    const legacyDirection = leafTypeOrDirection === "vertical" || leafTypeOrDirection === "horizontal";
    const paneType: PaneType | boolean = legacyDirection ? "split" : leafTypeOrDirection;
    const direction = legacyDirection ? leafTypeOrDirection : requestedDirection;

    const sourceState = leaf.getViewState();
    const duplicate = paneType === "window" ? this.openPopoutLeaf() : paneType === "tab" || paneType === false
      ? this.createTabLeaf(leaf.parent)
      : this.createLeafBySplit(leaf, direction);
    try {
      await duplicate.setViewState({
        ...sourceState,
        state: sourceState.state ? structuredCloneSafe(sourceState.state) : undefined,
        active: true,
        group: leaf.group ? leaf : undefined,
      });
      return duplicate;
    } catch (error) {
      duplicate.detach();
      throw error;
    }
  }

  setActiveLeaf(leaf: WorkspaceLeaf | null): void {
    if (leaf && !this.leaves.has(leaf)) {
      this.leaves.add(leaf);
      if (!leaf.parent) this.attachLeafToMainTabs(leaf);
    }
    if (leaf?.isDeferred) void leaf.loadIfDeferred().catch(error => console.error("Failed to load deferred view", error));
    if (this.currentActiveEditor && !(this.currentActiveEditor instanceof Editor)) { this.currentActiveEditor = null; this.bindActiveEditor(); }
    if (this.activeLeaf === leaf) return;
    this.activeLeaf = leaf;
    if (leaf) leaf.activeTime = Date.now();
    if (leaf?.parent) leaf.parent.activateLeaf(leaf);
    const viewFile = (leaf?.view as View & { file?: import("./vault").TFile | null } | undefined)?.file;
    if (viewFile !== undefined) { this.recordOpenedFile(viewFile); this.activeFile = viewFile; }
    this.bindActiveEditor();
    this.trigger("active-leaf-change", leaf);
  }

  /** @internal Keep the active editor event subscription aligned with the active leaf. */
  onLeafViewChanged(leaf: WorkspaceLeaf): void {
    if (leaf === this.activeLeaf) {
      if (this.currentActiveEditor && !(this.currentActiveEditor instanceof Editor)) this.currentActiveEditor = null;
      if (leaf.view.getViewType() === "empty") { this.activeFile = null; this.activeEditor = null; }
      this.bindActiveEditor();
    }
  }

  /** @internal Emit file-open once when a leaf opens a file. */
  setOpenedFile(file: import("./vault").TFile): void {
    this.recordOpenedFile(file);
    this.activeFile = file;
  }

  private bindActiveEditor(): void {
    const active = this.activeEditor, editor = active instanceof Editor ? active : (active as { editor?: unknown } | null)?.editor;
    const next = editor instanceof Editor ? editor : null;
    if (next === this.boundEditor) return;
    this.boundEditor?.offChange(this.onBoundEditorChange);
    this.boundEditor = next;
    this.boundEditor?.onChange(this.onBoundEditorChange);
  }

  private getEditorInfo(editor: Editor): unknown {
    const active = this.activeEditor;
    if ((active as { editor?: unknown } | null)?.editor === editor) return active;
    const view = this.activeMarkdownView as (View & { editor?: Editor }) | null;
    if (view?.editor === editor) return view;
    return { app: this.app, file: this.activeFile, editor };
  }

  /** Reorder a tab or move it to another tab group, preserving workspace events and tree collapse. */
  moveLeafToTabs(leaf: WorkspaceLeaf, target: WorkspaceTabs, index: number): void {
    if (!this.leaves.has(leaf) || !leaf.parent) throw new Error("Cannot move a detached workspace leaf.");
    const oldTabs = leaf.parent;
    const oldParent = oldTabs.parent;
    target.addLeaf(leaf, index);
    if (this.activeLeaf === leaf) target.activateLeaf(leaf);
    if (oldTabs !== target && oldTabs.children.length === 0) {
      oldParent?.removeChild(oldTabs);
      this.collapseEmptySplits(oldParent);
    }
    this.notifyLayoutChange();
  }

  /** Move/reorder a tab group or nested split within the pane tree. */
  movePane(item: WorkspaceTabs | WorkspaceSplit, target: WorkspaceSplit, index: number): void {
    const oldParent = item.parent;
    target.moveChild(item, index);
    if (oldParent && oldParent !== target) this.collapseEmptySplits(oldParent);
    this.notifyLayoutChange();
  }

  getUnpinnedLeaf(): WorkspaceLeaf {
    const canNavigate = (leaf: WorkspaceLeaf) => !leaf.pinned && (leaf.view.navigation || leaf.view.getViewType() === "empty");
    const leaf = this.activeLeaf && canNavigate(this.activeLeaf) ? this.activeLeaf : this.collectLeaves(this.rootSplit, true).filter(leaf => canNavigate(leaf) && leaf.parent?.activeLeaf === leaf).sort((a, b) => b.activeTime - a.activeTime)[0] ?? this.createTabLeaf(this.getMostRecentLeaf()?.parent ?? this.findFirstTabs());
    this.setActiveLeaf(leaf); return leaf;
  }

  getActiveViewOfType<T extends View>(type: abstract new (...args: never[]) => T): T | null {
    return this.activeLeaf?.view instanceof type ? this.activeLeaf.view : null;
  }

  getLeafById(id: string): WorkspaceLeaf | null { return [...this.leaves].find((leaf) => leaf.id === id) ?? null; }
  /** Return a serializable snapshot of split, tab and leaf state. */
  getLayout(): Record<string, unknown> {
    const mainChildren = this.rootSplit.children.filter((item) => !(item instanceof WorkspaceSidedock));
    return {
      ...this.layoutExtras,
      main: {
        type: "split",
        id: this.rootSplit.id,
        direction: this.rootSplit.direction,
        children: mainChildren.map(serializeWorkspaceItem),
      },
      left: this.leftSplit ? serializeWorkspaceItem(this.leftSplit) : null,
      right: this.rightSplit ? serializeWorkspaceItem(this.rightSplit) : null,
      floating: this.floatingSplit.map(container => ({ ...serializeWorkspaceItem(container), x: container.win.screenX, y: container.win.screenY, width: container.win.outerWidth, height: container.win.outerHeight })),
      active: this.activeLeaf?.id ?? null,
      lastOpenFiles: [...this.recentFiles],
    };
  }

  /**
   * Restore a serialized layout. The input tree and all view types are
   * validated before any current panes are closed or detached.
   */
  async changeLayout(value: unknown): Promise<void> {
    const layout = validateWorkspaceLayout(value, this.viewCreators);
    const extras = isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !["main", "left", "right", "active", "lastOpenFiles"].includes(key))) : {};
    const stagedLeaves = new Map<string, WorkspaceLeaf>();
    const stagedViews: View[] = [];
    const stageNode = async (node: SerializedWorkspaceNode): Promise<WorkspaceSplit | WorkspaceTabs> => {
      if (node.type === "tabs") {
        const tabs = new WorkspaceTabs();
        if (node.id) tabs.id = node.id;
        tabs.dimension = node.dimension;
        for (const leafNode of node.children) {
          const leaf = new WorkspaceLeaf(this);
          await leaf.view.closeView();
          leaf.id = leafNode.id;
          leaf.dimension = leafNode.dimension;
          leaf.pinned = leafNode.pinned;
          leaf.group = leafNode.group;
          reserveLeafId(leaf.id);
          const creator = this.viewCreators.get(leafNode.state.type);
            const deferPluginView = this.restoringLayout && this.pluginViewTypes.has(leafNode.state.type) && leafNode.id !== layout.active;
          const view = deferPluginView && creator
            ? new DeferredView(leaf, leafNode.state, creator)
            : this.createView(leafNode.state.type, leaf);
          if (!(view instanceof View)) throw new Error(`View creator for ${leafNode.state.type} did not return a View.`);
          leaf.view = view;
          stagedViews.push(view);
          await view.openView();
          if (leafNode.state.state) await view.setState(leafNode.state.state, { history: false });
          tabs.addLeaf(leaf);
          stagedLeaves.set(leaf.id, leaf);
        }
        const selected = node.children[node.currentTab];
        if (selected) tabs.activateLeaf(stagedLeaves.get(selected.id)!);
        tabs.isStacked = node.stacked === true;
        return tabs;
      }
      if (node.type !== "split") throw new TypeError("A workspace split can contain only nested split or tabs nodes.");
      const split = new WorkspaceSplit(node.direction);
      if (node.id) split.id = node.id;
      split.dimension = node.dimension;
      for (const child of node.children) split.addChild(await stageNode(child));
      return split;
    };

    let stagedMain: WorkspaceSplit | WorkspaceTabs;
    let stagedLeft: WorkspaceSidedock | null = null;
    let stagedRight: WorkspaceSidedock | null = null;
    try {
      stagedMain = await stageNode(layout.main);
      if (layout.left) stagedLeft = await stageSideDock("left", layout.left.node, stageNode, layout.left.collapsed, layout.left.width);
      if (layout.right) stagedRight = await stageSideDock("right", layout.right.node, stageNode, layout.right.collapsed, layout.right.width);
    } catch (error) {
      await closeStagedViews(stagedViews);
      throw error;
    }

    const oldLeaves = [...this.leaves];
    const closeResults = await Promise.allSettled(oldLeaves.map((leaf) => leaf.view.closeView()));
    const closeErrors = closeResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (closeErrors.length) {
      await closeStagedViews(stagedViews);
      throw new AggregateError(closeErrors, "Previous workspace views failed to close; the current layout was kept.");
    }
    for (const child of [...this.rootSplit.children]) this.rootSplit.removeChild(child);
    for (const container of [...this.floatingSplit]) container.win.close();
    this.floatingSplit.splice(0);
    this.leaves.clear();
    this.rootSplit.direction = layout.main.direction;
    if (layout.main.id) this.rootSplit.id = layout.main.id;
    this.layoutExtras = extras;
    if (stagedLeft) { this.leftSplit = stagedLeft; this.rootSplit.addChild(stagedLeft, 0); }
    else this.leftSplit = null;
    if (stagedMain instanceof WorkspaceSplit) {
      for (const child of [...stagedMain.children]) this.rootSplit.addChild(child);
    } else this.rootSplit.addChild(stagedMain);
    if (stagedRight) { this.rightSplit = stagedRight; this.rootSplit.addChild(stagedRight); }
    else this.rightSplit = null;
    for (const leaf of stagedLeaves.values()) this.leaves.add(leaf);
    this.recentFiles.splice(0, this.recentFiles.length, ...layout.lastOpenFiles);
    const active = layout.active ? stagedLeaves.get(layout.active) ?? null : firstLeaf(stagedLeaves);
    this.activeLeaf = null;
    // A sidebar may own focus at startup; retain the visible document as the file context.
    const visible = this.collectLeaves(this.rootSplit, true).filter(leaf => leaf.parent?.activeLeaf === leaf);
    const fileOf = (leaf: WorkspaceLeaf | undefined) => (leaf?.view as (View & { file?: import("./vault").TFile | null }) | undefined)?.file;
    const documentLeaf = visible.find(leaf => fileOf(leaf)?.path === layout.lastOpenFiles[0]) ?? visible.find(leaf => !!fileOf(leaf));
    this.activeFile = fileOf(documentLeaf) ?? null;
    this.setActiveLeaf(active);
    await active?.loadIfDeferred();
    if (isRecord(value) && Array.isArray(value.floating)) {
      for (const raw of value.floating) {
        if (!isRecord(raw)) continue;
        const states: ViewState[] = [];
        const visit = (node: unknown): void => { if (!isRecord(node)) return; if (node.type === "leaf" && isRecord(node.state) && typeof node.state.type === "string") states.push(node.state as unknown as ViewState); else if (Array.isArray(node.children)) node.children.forEach(visit); };
        visit(raw);
        for (const state of states) {
          if (!this.viewCreators.has(state.type)) continue;
          const leaf = this.openPopoutLeaf({ x: typeof raw.x === "number" ? raw.x : undefined, y: typeof raw.y === "number" ? raw.y : undefined, size: { width: typeof raw.width === "number" ? raw.width : 800, height: typeof raw.height === "number" ? raw.height : 600 } });
          await leaf.setViewState(state);
        }
      }
    }
    this.notifyLayoutChange();
  }

  getGroupLeaves(group: string | null): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    if (group) this.iterateAllLeaves(leaf => { if (leaf.group === group) leaves.push(leaf); });
    return leaves;
  }
  /** Select the destination of the pane-menu "Link with tab" action. */
  onStartLink(source: WorkspaceLeaf): void {
    this.stopTabLink?.();
    const doc = source.containerEl.ownerDocument, win = doc?.defaultView;
    if (!win) return;
    const overlay = doc.createElement("div"); overlay.className = "workspace-drop-overlay";
    const targetAt = (event: MouseEvent): WorkspaceLeaf | null => {
      let target: WorkspaceLeaf | null = null;
      const tabs = doc.elementFromPoint(event.clientX, event.clientY)?.closest(".workspace-tabs");
      this.iterateAllLeaves(leaf => {
        if (target || leaf.containerEl.ownerDocument !== doc) return;
        const box = leaf.containerEl.getBoundingClientRect();
        if (!box.width || !box.height) return;
        // The reference resolves a tab group first, then uses its active leaf,
        // including when the pointer is over a stacked background pane.
        if (tabs ? leaf.containerEl.closest(".workspace-tabs") === tabs && leaf.parent?.activeLeaf === leaf
          : event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom) target = leaf;
      });
      return target;
    };
    const eligible = (target: WorkspaceLeaf | null): target is WorkspaceLeaf => !!target && target.view instanceof ItemView
      // Navigation/sidebar panes that merely expose contentEl are not ItemViews
      // in the reference; only its file-bound hosted panes can be linked targets.
      && (!("followsFile" in target.view) || Boolean(target.view.followsFile));
    const move = (event: MouseEvent) => {
      event.preventDefault();
      const target = targetAt(event);
      if (!eligible(target)) { overlay.style.display = "none"; return; }
      const box = target.containerEl.getBoundingClientRect();
      if (!overlay.isConnected) doc.body.append(overlay);
      overlay.style.display = "";
      Object.assign(overlay.style, { transform: `translate(${box.x}px, ${box.y}px)`, width: box.width + "px", height: box.height + "px" });
    };
    const stop = () => {
      win.removeEventListener("mousemove", move); win.removeEventListener("mouseup", finish);
      overlay.remove();
      if (this.stopTabLink === stop) this.stopTabLink = null;
    };
    const finish = (event: MouseEvent) => { stop(); const target = targetAt(event); if (eligible(target)) source.setGroupMember(target); };
    this.stopTabLink = stop;
    win.addEventListener("mousemove", move); win.addEventListener("mouseup", finish);
  }
  getLeavesOfType(viewType: string): WorkspaceLeaf[] { return [...this.leaves].filter((leaf) => leaf.view.getViewType() === viewType); }
  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void { this.visitLeaves(this.rootSplit, callback, true); }
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
    this.visitLeaves(this.rootSplit, callback, true);
    if (this.leftSplit) this.visitLeaves(this.leftSplit, callback);
    if (this.rightSplit) this.visitLeaves(this.rightSplit, callback);
    for (const container of this.floatingSplit) if (this.visitLeaves(container, callback)) break;
  }
  detachLeavesOfType(viewType: string): void { for (const leaf of this.getLeavesOfType(viewType)) leaf.detach(); }
  getMostRecentLeaf(root?: WorkspaceParent): WorkspaceLeaf | null {
    const candidates = root ? this.collectLeaves(root, root === this.rootSplit) : this.collectLeaves(this.rootSplit, true);
    if (this.activeLeaf && candidates.includes(this.activeLeaf)) return this.activeLeaf;
    return candidates.at(-1) ?? null;
  }
  getLeftLeaf(split: boolean): WorkspaceLeaf | null { return this.getSideLeaf("left", split); }
  getRightLeaf(split: boolean): WorkspaceLeaf | null { return this.getSideLeaf("right", split); }
  async ensureSideLeaf(type: string, side: "left" | "right", options: { active?: boolean; split?: boolean; reveal?: boolean; state?: unknown } = {}): Promise<WorkspaceLeaf> {
    let leaf: WorkspaceLeaf | undefined = this.getLeavesOfType(type)[0];
    if (!leaf) leaf = this.getSideLeaf(side, options.split ?? false) ?? undefined;
    if (!leaf) throw new Error(`Unable to create ${side} workspace leaf.`);
    if (leaf.view.getViewType() !== type || options.state !== undefined) {
      const state = options.state ?? (leaf.view.getViewType() === type ? leaf.getViewState().state : {});
      await leaf.setViewState({ type, state: state as Record<string, unknown>, active: options.active });
    }
    if (options.active) this.setActiveLeaf(leaf);
    if (options.reveal) await this.revealLeaf(leaf);
    return leaf;
  }
  /** Host helper: append a tab to the dock without selecting a main editor leaf. */
  createDockLeaf(side: "left" | "right"): WorkspaceLeaf {
    const existing = this.getSideLeaf(side, false)!;
    if (existing.view.getViewType() === "empty") return existing;
    const tabs = existing.parent!;
    const leaf = new WorkspaceLeaf(this); tabs.addChild(leaf); this.leaves.add(leaf);
    this.notifyLayoutChange(); return leaf;
  }
  getLeafByType(viewType: string): WorkspaceLeaf | null { return this.getLeavesOfType(viewType)[0] ?? null; }
  async openLinkText(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState): Promise<void> {
    const destinationText = linktext.split("|", 1)[0]!.trim();
    const destination = this.app.metadataCache?.getFirstLinkpathDest(destinationText, sourcePath);
    let file = destination ? this.app.vault?.getAbstractFileByPath(destination.path) : null;
    if (!(file instanceof TFile)) {
      // Following a link to a note that does not exist yet creates it.
      const name = destinationText.split("#", 1)[0]!.trim();
      if (!name) file = this.app.vault?.getAbstractFileByPath(sourcePath) ?? null;
      else if (this.app.fileManager) {
        const folderPart = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
        const parent = folderPart ? this.app.vault.getFolderByPath(folderPart) ?? await this.app.vault.createFolder(folderPart) : this.app.fileManager.getNewFileParent(sourcePath);
        file = await this.app.fileManager.createNewMarkdownFile(parent, name.slice(name.lastIndexOf("/") + 1));
      }
      if (!(file instanceof TFile)) return;
    }
    const previousActiveLeaf = this.activeLeaf;
    const leaf = this.getLeaf(newLeaf);
    await leaf.openFile(file, openViewState);
    if (openViewState?.active === false) this.setActiveLeaf(previousActiveLeaf);
    else this.setActiveLeaf(leaf);
    const separator = destinationText.indexOf("#");
    if (separator < 0) return;
    let subpath = destinationText.slice(separator + 1);
    try { subpath = decodeURIComponent(subpath); } catch { /* Keep literal heading text. */ }
    const content = await this.app.vault.cachedRead(file);
    let offset = -1;
    if (subpath.startsWith("^")) {
      const blockId = subpath.slice(1).trim();
      const match = new RegExp(`\\^${escapeRegExp(blockId)}\\s*$`, "m").exec(content);
      if (match) offset = match.index;
    } else {
      const normalized = subpath.replace(/_/g, " ").trim().toLocaleLowerCase();
      const heading = (this.app.metadataCache?.getFileCache(file)?.headings ?? parseMarkdownMetadata(content).headings ?? [])
        .find((item) => item.heading.replace(/\\([\\`*_{}\[\]<>()#+.!|])/g, "$1").trim().toLocaleLowerCase() === normalized);
      if (heading) offset = heading.position.start.offset;
    }
    if (offset < 0) return;
    await nextFrame();
    const editor = (leaf.view as View & { editor?: unknown }).editor ?? this.activeEditor;
    const textEditor = editor as { offsetToPos?: (offset: number) => EditorPosition; setCursor?: (position: EditorPosition) => void; scrollIntoView?: (range: EditorRange, center?: boolean) => void } | null;
    if (!textEditor?.offsetToPos || !textEditor.setCursor) return;
    const position = textEditor.offsetToPos(offset);
    textEditor.setCursor(position);
    textEditor.scrollIntoView?.({ from: position, to: position }, true);
  }
  getLastOpenFiles(): string[] { return this.getRecentFiles({ showNonImageAttachments: true, showImages: true }); }
  updateOptions(): void {
    this.trigger("editor-options-change");
    this.trigger("editor-extensions-change");
  }
  handleLinkContextMenu(menu: Menu, linktext: string, sourcePath: string, leaf?: WorkspaceLeaf): boolean {
    if (!linktext) return false;
    const destination = this.app.metadataCache?.getFirstLinkpathDest(linktext.split("#", 1)[0]!, sourcePath);
    const file = destination ? this.app.vault?.getAbstractFileByPath(destination.path) : null;
    if (!(file instanceof TFile)) return false;
    menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(() => { void this.openLinkText(linktext, sourcePath, "tab"); }));
    menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-to-the-right")).setIcon("lucide-separator-vertical").onClick(() => { void this.openLinkText(linktext, sourcePath, "split"); }));
    this.trigger("file-menu", menu, file, "link-context-menu", leaf);
    return true;
  }
  getActiveFileView(): import("./file-views").FileView | null {
    if (this.activeLeaf?.view.navigation) return isFileView(this.activeLeaf.view) ? this.activeLeaf.view : null;
    let recent: WorkspaceLeaf | null = null;
    let view: import("./file-views").FileView | null = null;
    this.iterateAllLeaves(leaf => {
      if (leaf.view.navigation && (!recent || recent.activeTime < leaf.activeTime)) {
        recent = leaf; view = isFileView(leaf.view) ? leaf.view : null;
      }
    });
    return view;
  }
  getActiveFile(): TFile | null {
    const editorFile = (this.activeEditor as { file?: TFile } | null)?.file;
    return editorFile ?? this.getActiveFileView()?.file ?? null;
  }
  getActiveView(): View | null { return this.activeLeaf?.view ?? null; }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const root = leaf.getRoot();
    if (root instanceof WorkspaceSidedock) {
      root.expand(); leaf.parent?.activateLeaf(leaf); this.notifyLayoutChange();
      await leaf.loadIfDeferred(); return;
    }
    await leaf.loadIfDeferred(); this.setActiveLeaf(leaf);
  }
  detachLeafGroup(group: string): void { for (const leaf of [...this.leaves]) if (leaf.group === group) leaf.detach(); }

  /** Places that can show a page preview on hover, keyed by source id (see Plugin.registerHoverLinkSource). */
  readonly hoverLinkSources: Record<string, { display: string; defaultMod: boolean }> = {
    search: { display: t("plugins.page-preview.label-source-search"), defaultMod: true },
    preview: { display: t("plugins.page-preview.label-source-preview"), defaultMod: false },
    editor: { display: t("plugins.page-preview.label-source-editor"), defaultMod: true },
    "tab-header": { display: t("plugins.page-preview.label-source-tab-header"), defaultMod: true },
  };
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void { this.hoverLinkSources[id] = info; this.trigger("hover-link-sources-changed"); }
  unregisterHoverLinkSource(id: string): void { delete this.hoverLinkSources[id]; this.trigger("hover-link-sources-changed"); }
  /** View states of recently closed main-area tabs, most recent last. */
  readonly closedLeafStates: ViewState[] = [];
  /** Reopens the most recently closed tab; returns false when there is none. */
  async reopenClosedLeaf(): Promise<boolean> {
    const state = this.closedLeafStates.pop(); if (!state) return false;
    const leaf = this.getLeaf("tab");
    await leaf.setViewState({ ...state, active: true }); this.setActiveLeaf(leaf);
    return true;
  }
  detachLeaf(leaf: WorkspaceLeaf): void {
    if (!this.disposing && this.leaves.has(leaf) && leaf.view.getViewType() !== "empty" && this.collectLeaves(this.rootSplit, true).includes(leaf)) {
      this.closedLeafStates.push(structuredCloneSafe({ ...leaf.getViewState(), active: true, ...(leaf.pinned ? { pinned: true } : {}) }));
      if (this.closedLeafStates.length > 20) this.closedLeafStates.shift();
    }
    if (!this.leaves.delete(leaf)) return;
    const tabs = leaf.parent;
    if (tabs) {
      tabs.removeChild(leaf);
      if (tabs.children.length === 0) {
        const parent = tabs.parent;
        parent?.removeChild(tabs);
        this.collapseEmptySplits(parent);
      }
    }
    void leaf.view.closeView();
    leaf.containerEl.remove?.();
    if (!this.disposing && !this.collectLeaves(this.rootSplit, true).length) this.createRootLeaf();
    if (this.activeLeaf === leaf) this.setActiveLeaf([...this.leaves].at(-1) ?? null);
    leaf.trigger("detach");
    this.notifyLayoutChange();
  }

  private createRootLeaf(): WorkspaceLeaf {
    return this.createTabLeaf(this.findFirstTabs());
  }

  private createTabLeaf(preferred: WorkspaceTabs | null): WorkspaceLeaf {
    const tabs = preferred ?? this.findFirstTabs() ?? new WorkspaceTabs();
    if (!tabs.parent) this.rootSplit.addChild(tabs);
    const leaf = new WorkspaceLeaf(this);
    tabs.addChild(leaf);
    this.leaves.add(leaf);
    this.notifyLayoutChange();
    return leaf;
  }

  private attachLeafToMainTabs(leaf: WorkspaceLeaf): void {
    const tabs = this.findFirstTabs() ?? new WorkspaceTabs();
    if (!tabs.parent) this.rootSplit.addChild(tabs);
    tabs.addChild(leaf);
  }

  private findFirstTabs(parent: WorkspaceParent = this.rootSplit): WorkspaceTabs | null {
    for (const child of parent.children) {
      if (child instanceof WorkspaceTabs) return child;
      if (child instanceof WorkspaceParent && !(child instanceof WorkspaceSidedock)) {
        const tabs = this.findFirstTabs(child);
        if (tabs) return tabs;
      }
    }
    return null;
  }

  private visitLeaves(parent: WorkspaceParent, callback: (leaf: WorkspaceLeaf) => unknown, excludeSideDocks = false): boolean {
    for (const child of parent.children) {
      if (excludeSideDocks && child instanceof WorkspaceSidedock) continue;
      if (child instanceof WorkspaceLeaf) { if (callback(child)) return true; }
      else if (child instanceof WorkspaceParent && this.visitLeaves(child, callback, excludeSideDocks)) return true;
    }
    return false;
  }
  private collectLeaves(parent: WorkspaceParent, excludeSideDocks = false): WorkspaceLeaf[] {
    const result: WorkspaceLeaf[] = [];
    for (const child of parent.children) {
      if (excludeSideDocks && child instanceof WorkspaceSidedock) continue;
      if (child instanceof WorkspaceLeaf) result.push(child);
      else if (child instanceof WorkspaceParent) result.push(...this.collectLeaves(child, excludeSideDocks));
    }
    return result;
  }

  private getSideLeaf(side: "left" | "right", split: boolean): WorkspaceLeaf | null {
    let dock = side === "left" ? this.leftSplit : this.rightSplit;
    if (!dock) {
      dock = new WorkspaceSidedock(side);
      this.rootSplit.addChild(dock, side === "left" ? 0 : this.rootSplit.children.length);
      if (side === "left") this.leftSplit = dock; else this.rightSplit = dock;
    }
    dock.expand();
    const current = this.collectLeaves(dock).at(-1);
    if (current && split) return this.createLeafBySplit(current, "horizontal");
    if (current) return current;
    const tabs = new WorkspaceTabs();
    const leaf = new WorkspaceLeaf(this);
    tabs.addChild(leaf);
    dock.addChild(tabs);
    this.leaves.add(leaf);
    this.notifyLayoutChange();
    return leaf;
  }

  private collapseEmptySplits(start: WorkspaceParent | null): void {
    let parent = start;
    let node: WorkspaceSplit | null = parent instanceof WorkspaceSplit ? parent : null;
    while (node && node !== this.rootSplit) {
      const ancestor = node.parent;
      if (node.children.length === 0) {
        if (node === this.leftSplit) this.leftSplit = null;
        if (node === this.rightSplit) this.rightSplit = null;
        ancestor?.removeChild(node);
      } else if (node.children.length === 1 && ancestor && node !== this.leftSplit && node !== this.rightSplit) {
        ancestor.replaceChild(node, node.children[0]);
      } else break;
      parent = ancestor;
      node = parent instanceof WorkspaceSplit ? parent : null;
    }
  }

  /** @internal */
  recordOpenedFile(file: unknown): void {
    const path = typeof file === "object" && file !== null && "path" in file ? String((file as { path: unknown }).path) : "";
    // As in the reference, the list holds the files that were left, not the one now showing.
    const previous = this.lastRecordedFile;
    if (path === previous) return;
    this.lastRecordedFile = path;
    if (previous) this.collectRecentFile(previous);
  }
  private lastRecordedFile = "";

  /** @internal Puts a path at the head of the recent files, keeping a bounded number per kind of file. */
  collectRecentFile(path: string): void {
    if (!path || this.recentFiles[0] === path) return;
    const kind = (name: string) => { const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase(); return extension === "md" ? "md" : extension === "canvas" || extension === "base" ? "canvas" : RECENT_IMAGE_EXTENSIONS.has(extension) ? "image" : "other"; };
    const room: Record<string, number> = { md: 25, canvas: 10, image: 10, other: 10 }, next = [path];
    for (const recent of this.recentFiles) {
      if (recent === path) continue;
      const type = kind(recent);
      if (room[type] <= 0) continue;
      next.push(recent); room[type]--;
    }
    this.recentFiles.splice(0, this.recentFiles.length, ...next);
    this.requestSaveLayout();
  }
  /** @internal Keeps the recent files pointing at a renamed file. */
  renameRecentFile(newPath: string, oldPath: string): void {
    const index = this.recentFiles.indexOf(oldPath);
    if (index >= 0) { this.recentFiles[index] = newPath; this.requestSaveLayout(); }
    if (this.lastRecordedFile === oldPath) this.lastRecordedFile = newPath;
  }
  /** Recently used files, newest first, filtered by kind (notes and canvases by default) and capped. */
  getRecentFiles(options: { showMarkdown?: boolean; showNonAttachments?: boolean; showNonImageAttachments?: boolean; showImages?: boolean; maxCount?: number } = {}): string[] {
    const settings = { showMarkdown: true, showNonAttachments: true, showNonImageAttachments: false, showImages: false, maxCount: 10, ...options };
    const result: string[] = [];
    for (const recent of this.recentFiles) {
      const extension = recent.slice(recent.lastIndexOf(".") + 1).toLowerCase();
      const shown = extension === "md" ? settings.showMarkdown : extension === "canvas" || extension === "base" ? settings.showNonAttachments : RECENT_IMAGE_EXTENSIONS.has(extension) ? settings.showImages : settings.showNonImageAttachments;
      if (shown) result.push(recent);
      if (result.length >= settings.maxCount) break;
    }
    return result;
  }

  /** @internal */
  private groupCleanupPending = false;
  notifyLayoutChange(): void {
    // Group construction and removal can touch several leaves synchronously.
    // Like the reference's queued layout update, prune singletons after that
    // transaction, rather than removing a group between its two assignments.
    if (this.layoutReady && !this.groupCleanupPending) {
      this.groupCleanupPending = true;
      queueMicrotask(() => {
        this.groupCleanupPending = false;
        if (this.disposing) return;
        const groups = new Map<string, WorkspaceLeaf[]>();
        this.iterateAllLeaves(leaf => {
          if (!leaf.group) return;
          const members = groups.get(leaf.group);
          if (members) members.push(leaf); else groups.set(leaf.group, [leaf]);
        });
        for (const members of groups.values()) if (members.length === 1) members[0]!.setGroup(null);
      });
    }
    this.trigger("layout-change"); this.requestSaveLayout();
  }

  override on(name: "active-leaf-change", callback: (leaf: WorkspaceLeaf | null) => unknown, ctx?: unknown): EventRef;
  override on(name: "layout-change" | "resize", callback: () => unknown, ctx?: unknown): EventRef;
  override on(name: "editor-change", callback: (editor: Editor, info: unknown) => unknown, ctx?: unknown): EventRef;
  override on(name: "file-open", callback: (file: import("./vault").TFile | null) => unknown, ctx?: unknown): EventRef;
  override on(name: "view-registered", callback: (type: string) => unknown, ctx?: unknown): EventRef;
  override on(name: "file-open", callback: (file: unknown) => unknown, ctx?: unknown): EventRef;
  override on(name: "quick-preview", callback: (file: unknown, data: string) => unknown, ctx?: unknown): EventRef;
  override on(name: "css-change", callback: () => unknown, ctx?: unknown): EventRef;
  override on(name: "quit", callback: (tasks: unknown) => unknown, ctx?: unknown): EventRef;
  override on(name: string, callback: (...data: unknown[]) => unknown, ctx?: unknown): EventRef;
  override on(name: string, callback: (...data: any[]) => any, ctx?: unknown): EventRef {
    return super.on(name, callback, ctx);
  }
}

class EmptyView extends ItemView {
  navigation = true;
  getViewType(): string { return "empty"; }
  getDisplayText(): string { return t("interface.label-new-tab"); }
}

class UnavailableView extends View {
  private state: Record<string, unknown> = {};
  constructor(leaf: WorkspaceLeaf, private readonly type: string) { super(leaf); this.icon = "lucide-ghost"; }
  getViewType(): string { return this.type; }
  getDisplayText(): string { return this.type; }
  getState(): Record<string, unknown> { return { ...this.state }; }
  async setState(state: unknown): Promise<void> { this.state = isRecord(state) ? { ...state } : {}; }
  protected onOpen(): void {
    // Workspace state also runs without a DOM (for example in headless hosts).
    const document = this.containerEl.ownerDocument;
    if (!document) return;
    const message = document.createElement("div"); message.className = "pane-empty";
    message.textContent = `${t("interface.empty-state.unknown-pane-title")}. ${t("interface.empty-state.unknown-pane-desc", { type: this.type })}`;
    this.containerEl.replaceChildren(message);
  }
  // This frame belongs only to the placeholder; a registered view owns a new frame.
  protected onClose(): void { this.containerEl.replaceChildren?.(); }
}

let leafSequence = 0;

interface SerializedLeafNode {
  type: "leaf";
  id: string;
  state: ViewState;
  pinned: boolean;
  group: string | null;
  dimension: number | null;
}
interface SerializedTabsNode { type: "tabs"; id?: string; dimension: number | null; children: SerializedLeafNode[]; currentTab: number; stacked?: boolean }
interface SerializedSplitNode { type: "split"; id?: string; dimension: number | null; direction: SplitDirection; children: SerializedWorkspaceNode[] }
type SerializedWorkspaceNode = SerializedLeafNode | SerializedTabsNode | SerializedSplitNode;
interface ValidatedWorkspaceLayout {
  main: SerializedSplitNode;
  left: { node: SerializedWorkspaceNode; collapsed: boolean; width: number | null } | null;
  right: { node: SerializedWorkspaceNode; collapsed: boolean; width: number | null } | null;
  active: string | null;
  lastOpenFiles: string[];
}

const allocatedLeafIds = new Set<string>();
function allocateLeafId(): string {
  let id: string;
  do { id = `leaf-${++leafSequence}`; } while (allocatedLeafIds.has(id));
  allocatedLeafIds.add(id);
  return id;
}
function reserveLeafId(id: string): void {
  allocatedLeafIds.add(id);
  const match = /^leaf-(\d+)$/.exec(id);
  if (match) leafSequence = Math.max(leafSequence, Number(match[1]));
}

function serializeWorkspaceItem(item: WorkspaceItem): Record<string, unknown> {
  if (item instanceof WorkspaceLeaf) {
    return {
      type: "leaf", id: item.id, ...(item.pinned ? { pinned: true } : {}), ...(item.group ? { group: item.group } : {}), ...(item.dimension !== null ? { dimension: item.dimension } : {}),
      state: { type: item.view.getViewType(), state: item.view.getState(), icon: item.getIcon(), title: item.getDisplayText() },
    };
  }
  if (item instanceof WorkspaceTabs) {
    const currentTab = Math.max(0, item.activeLeaf ? item.children.indexOf(item.activeLeaf) : 0);
    return { type: "tabs", id: item.id, ...(item.dimension !== null ? { dimension: item.dimension } : {}), children: item.children.map(serializeWorkspaceItem), ...(currentTab ? { currentTab } : {}), ...(item.isStacked ? { stacked: true } : {}) };
  }
  if (item instanceof WorkspaceSplit) {
    if (item instanceof WorkspaceSidedock) {
      return { id: item.id, type: "split", children: item.children.map(serializeWorkspaceItem), direction: item.direction, width: item.dimension ?? 300, ...(item.collapsed ? { collapsed: true } : {}) };
    }
    return {
      id: item.id, type: "split", ...(item.dimension !== null ? { dimension: item.dimension } : {}),
      children: item.children.map(serializeWorkspaceItem), direction: item.direction,
    };
  }
  throw new TypeError("Cannot serialize an unknown workspace item.");
}

function validateWorkspaceLayout(value: unknown, creators: Map<string, ViewCreator>): ValidatedWorkspaceLayout {
  if (!isRecord(value) || !isRecord(value.main)) throw new TypeError("Workspace layout must contain a main split node.");
  const ids = new Set<string>();
  const parseNode = (raw: unknown): SerializedWorkspaceNode => {
    if (!isRecord(raw) || typeof raw.type !== "string") throw new TypeError("Workspace layout node must have a type.");
    if (raw.type === "leaf") {
      if (typeof raw.id !== "string" || !raw.id.trim() || ids.has(raw.id)) throw new TypeError("Workspace layout leaf IDs must be non-empty and unique.");
      if (!isRecord(raw.state) || typeof raw.state.type !== "string" || !raw.state.type.trim()) throw new TypeError(`Workspace leaf ${raw.id} must specify a view state type.`);
      if (raw.state.state !== undefined && !isRecord(raw.state.state)) throw new TypeError(`Workspace leaf ${raw.id} has an invalid view state payload.`);
      ids.add(raw.id);
      return {
        type: "leaf", id: raw.id,
        state: {
          type: raw.state.type,
          ...(raw.state.state ? { state: raw.state.state as Record<string, unknown> } : {}),
          ...(typeof raw.state.icon === "string" ? { icon: raw.state.icon } : {}),
          ...(typeof raw.state.title === "string" ? { title: raw.state.title } : {}),
        },
        pinned: Boolean(raw.pinned), group: typeof raw.group === "string" ? raw.group : null,
        dimension: typeof raw.dimension === "number" ? raw.dimension : null,
      };
    }
    if (!Array.isArray(raw.children)) throw new TypeError(`Workspace ${raw.type} node must contain children.`);
    if (raw.type === "tabs") {
      const children = raw.children.map(parseNode);
      if (children.some((child) => child.type !== "leaf")) throw new TypeError("Workspace tabs can contain only leaves.");
      const currentTab = raw.currentTab === undefined ? 0 : Number(raw.currentTab);
      if (!Number.isInteger(currentTab) || (children.length > 0 && (currentTab < 0 || currentTab >= children.length))) throw new TypeError("Workspace tab currentTab is outside its children.");
      return { type: "tabs", id: typeof raw.id === "string" ? raw.id : undefined, dimension: typeof raw.dimension === "number" ? raw.dimension : null, children: children as SerializedLeafNode[], currentTab, stacked: raw.stacked === true };
    }
    if (raw.type === "split") {
      if (raw.direction !== "vertical" && raw.direction !== "horizontal") throw new TypeError("Workspace split direction must be vertical or horizontal.");
      const children = raw.children.map(parseNode);
      if (children.some((child) => child.type === "leaf")) throw new TypeError("Workspace splits can contain split or tabs nodes.");
      return { type: "split", id: typeof raw.id === "string" ? raw.id : undefined, dimension: typeof raw.dimension === "number" ? raw.dimension : null, direction: raw.direction, children };
    }
    throw new TypeError(`Unsupported workspace node type: ${raw.type}`);
  };
  const parsedMain = parseNode(value.main);
  if (parsedMain.type !== "split") throw new TypeError("Workspace main node must be a split.");
  const parseDock = (raw: unknown): { node: SerializedWorkspaceNode; collapsed: boolean; width: number | null } | null => {
    if (raw == null) return null;
    if (!isRecord(raw)) throw new TypeError("Workspace side dock must be a split or tabs node.");
    const node = parseNode(raw);
    if (node.type === "leaf") throw new TypeError("A side dock must be represented as a split or tabs node.");
    return { node, collapsed: Boolean(raw.collapsed), width: typeof raw.width === "number" ? raw.width : null };
  };
  const left = parseDock(value.left);
  const right = parseDock(value.right);
  const active = typeof value.active === "string" ? value.active : null;
  if (active && !ids.has(active)) throw new TypeError(`Active workspace leaf does not exist: ${active}`);
  const lastOpenFiles = Array.isArray(value.lastOpenFiles) && value.lastOpenFiles.every((path) => typeof path === "string")
    ? value.lastOpenFiles as string[] : [];
  return { main: parsedMain, left, right, active, lastOpenFiles };
}

async function stageSideDock(
  side: "left" | "right",
  node: SerializedWorkspaceNode,
  stageNode: (node: SerializedWorkspaceNode) => Promise<WorkspaceSplit | WorkspaceTabs>,
  collapsed: boolean,
  width: number | null = null,
): Promise<WorkspaceSidedock> {
  if (node.type === "leaf") throw new TypeError("A side dock must contain split or tabs nodes, not a bare leaf.");
  const staged = await stageNode(node);
  const dock = new WorkspaceSidedock(side);
  if (node.id) dock.id = node.id;
  dock.collapsed = collapsed;
  dock.dimension = width;
  if (staged instanceof WorkspaceSplit) {
    for (const child of [...staged.children]) dock.addChild(child);
  } else dock.addChild(staged);
  return dock;
}
async function closeStagedViews(views: View[]): Promise<void> {
  const errors: unknown[] = [];
  for (const view of [...views].reverse()) {
    try { await view.closeView(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Staged workspace views failed to close cleanly.");
}
function firstLeaf(leaves: Map<string, WorkspaceLeaf>): WorkspaceLeaf | null { return leaves.values().next().value ?? null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function assertNoWorkspaceCycle(parent: WorkspaceParent, child: WorkspaceItem): void {
  let ancestor: WorkspaceItem | null = parent;
  while (ancestor) {
    if (ancestor === child) throw new Error("A workspace item cannot be moved into itself or one of its descendants.");
    ancestor = ancestor.parent;
  }
}

function makeContainer(ownerDocument?: Document): HTMLElement {
  if (ownerDocument) return ownerDocument.createElement("div");
  if (typeof document !== "undefined") return document.createElement("div");
  return {} as HTMLElement;
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

const RECENT_IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
