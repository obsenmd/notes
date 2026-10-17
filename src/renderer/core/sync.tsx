import moment from "moment";
import { Keymap } from "../../compat/commands";
import { createDiv } from "../../compat/dom";
import { debounce, setIcon, setTooltip } from "../../compat/utilities";
import type { App } from "../../compat/plugin";
import { Menu, Modal, Notice } from "../../compat/ui";
import { TFile } from "../../compat/vault";
import { ItemView, type WorkspaceLeaf } from "../../compat/workspace";
import { t } from "../../i18n";
import { openSyncDeletedFiles, openSyncHistory } from "../SyncHistoryPanel";
import { getVaultSync, syncErrorCopy, type SyncLogEntry, type SyncServerFile, type VaultSync } from "../SyncVaultManager";
import { baseName, createSearchInput, extensionOf } from "./file-recovery";
import type { CorePluginContext, CorePluginModule } from "./types";

export const SYNC_VIEW_TYPE = "sync";

// ---------------------------------------------------------------------------------------------
// Activity log (`.modal.mod-sync-log`)
// ---------------------------------------------------------------------------------------------

const logStamp = (entry: SyncLogEntry) => moment(entry.ts).format("YYYY-MM-DD HH:mm");

class SyncLogModal extends Modal {
  private filterEventType = "all";
  private searchQuery = "";
  private readonly syncLogContainerEl: HTMLElement;
  private readonly updateSyncLog = () => {
    const container = this.syncLogContainerEl, shown: HTMLElement[] = [], query = this.searchQuery;
    for (const entry of this.sync.syncLog) {
      if (!entry.el) {
        entry.textContent = `${logStamp(entry)} - ${entry.info} ${entry.file ?? ""}`;
        entry.el = createDiv({ cls: "list-item", text: entry.textContent });
        if (entry.error) entry.el.addClass("mod-error");
      }
      if ((this.filterEventType === "errors" && !entry.error) || (this.filterEventType === "merge" && entry.type !== "merge") || (this.filterEventType === "skipped" && entry.type !== "skip")) continue;
      const text = entry.textContent ?? "";
      if (query) {
        const at = text.toLowerCase().indexOf(query);
        if (at === -1) continue;
        entry.el.empty();
        entry.el.append(text.slice(0, at)); entry.el.createSpan({ cls: "search-result-file-matched-text", text: text.slice(at, at + query.length) }); entry.el.append(text.slice(at + query.length));
      } else entry.el.setText(text);
      shown.push(entry.el);
    }
    container.replaceChildren(...shown);
    container.scrollTop = container.scrollHeight;
  };

  constructor(app: App, private readonly sync: VaultSync) {
    super(app);
    const { contentEl } = this;
    this.modalEl.addClass("mod-sync-log", "mod-lg");
    this.setTitle(t("plugins.sync.label-sync-log"));
    const setting = contentEl.createDiv("setting-item");
    const info = setting.createDiv("setting-item-info"); info.createDiv("setting-item-name"); info.createDiv("setting-item-description");
    const control = setting.createDiv("setting-item-control");
    const select = control.createEl("select", "dropdown");
    for (const [value, key] of [["all", "plugins.sync.option-event-type-all"], ["errors", "plugins.sync.option-event-type-errors"], ["skipped", "plugins.sync.option-event-type-skipped"], ["merge", "plugins.sync.option-event-type-merge-conflicts"]]) select.createEl("option", { value, text: t(key) });
    select.addEventListener("change", () => { this.filterEventType = select.value; this.updateSyncLog(); });
    createSearchInput(control, t("interface.prompt-filter"), value => { this.searchQuery = value.trim().toLowerCase(); this.updateSyncLog(); });
    this.syncLogContainerEl = contentEl.createDiv("sync-log-container");
    const buttons = contentEl.createDiv("modal-button-container");
    buttons.createEl("button", { text: t("plugins.sync.button-copy-sync-log"), cls: "mod-cta" }).addEventListener("click", () => this.onCopyResults());
    buttons.createEl("button", { text: t("dialogue.button-done") }).addEventListener("click", () => this.close());
  }

  private logRef: ReturnType<VaultSync["on"]> | null = null;
  override onOpen(): void { this.updateSyncLog(); this.logRef = this.sync.on("new-log", this.updateSyncLog); }
  override onClose(): void { if (this.logRef) this.sync.offref(this.logRef); this.logRef = null; }

  private onCopyResults(): void {
    let text = "";
    for (const entry of this.sync.syncLog) text += `${logStamp(entry)} - ${entry.info}${entry.file ? ` ${entry.file}` : ""}\n`;
    void navigator.clipboard.writeText(text).catch(() => undefined);
    new Notice(t("plugins.sync.msg-successfully-copied-sync-log"));
  }
}

// ---------------------------------------------------------------------------------------------
// "Sync changes" sidebar view
// ---------------------------------------------------------------------------------------------

type GroupId = "today" | "yesterday" | "week" | "older";
interface Group { id: GroupId; el: HTMLElement; childrenEl: HTMLElement; flairEl: HTMLElement; collapsed: boolean }
const GROUP_LABELS: Array<[GroupId, string]> = [["today", "plugins.sync.label-today"], ["yesterday", "plugins.sync.label-yesterday"], ["week", "plugins.sync.label-this-week"], ["older", "plugins.sync.label-older"]];
const OLDER_LIMIT = 100;

class SyncView extends ItemView {
  navigation = false;
  private hideMyChanges = false;
  private searchQuery = "";
  private userMap: Record<string, string> = {};
  private userMapLoaded = false;
  private previousRefreshDate = moment();
  private navHeaderEl!: HTMLElement;
  private uninitializedEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private groups!: Record<GroupId, Group>;
  private fileEls: Record<string, HTMLElement> = {};

  constructor(leaf: WorkspaceLeaf, private readonly sync: VaultSync, private readonly showHistory: (path: string) => void) { super(leaf); }
  getViewType() { return SYNC_VIEW_TYPE; }
  getDisplayText() { return t("plugins.sync.label-sync-changes"); }
  getIcon() { return "refresh-ccw"; }

  protected onOpen(): void {
    const contentEl = this.contentEl;
    contentEl.empty();
    const header = this.navHeaderEl = createDiv("nav-header");
    const buttons = header.createDiv("nav-buttons-container");
    const mine = buttons.createDiv("clickable-icon nav-action-button");
    setIcon(mine, "users"); setTooltip(mine, t("plugins.sync.button-hide-my-changes"));
    mine.addEventListener("click", () => { this.hideMyChanges = !this.hideMyChanges; mine.toggleClass("is-active", this.hideMyChanges); void this.updateRecentChanges(); });
    const searchButton = buttons.createDiv("clickable-icon nav-action-button");
    setIcon(searchButton, "lucide-search"); setTooltip(searchButton, t("plugins.backlinks.label-show-search"));
    const search = createSearchInput(header, t("plugins.search.prompt-start-search"), value => { this.searchQuery = value.trim().toLowerCase(); this.applySearchFilter(); });
    search.containerEl.style.display = "none";
    searchButton.addEventListener("click", () => {
      const show = search.containerEl.style.display === "none";
      search.containerEl.style.display = show ? "" : "none"; searchButton.toggleClass("is-active", show);
      if (show) search.inputEl.focus(); else { search.inputEl.value = ""; this.searchQuery = ""; this.applySearchFilter(); }
    });
    header.style.display = "none";

    this.uninitializedEl = contentEl.createDiv({ cls: "pane-empty sync-uninitialized", text: t("plugins.sync.label-sync-disconnected") });
    this.uninitializedEl.style.display = "none";
    const tree = this.treeEl = contentEl.createDiv("recent-changes-container");
    tree.style.display = "none";
    const folds = this.loadFolds();
    this.groups = Object.fromEntries(GROUP_LABELS.map(([id, key]) => {
      const el = tree.createDiv("tree-item nav-folder"), self = el.createDiv("tree-item-self nav-folder-title is-clickable mod-collapsible");
      self.createDiv("tree-item-icon collapse-icon");
      self.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: t(key) });
      const flairEl = self.createDiv("tree-item-flair-outer").createSpan("tree-item-flair");
      const group: Group = { id, el, childrenEl: el.createDiv("tree-item-children nav-folder-children"), flairEl, collapsed: false };
      self.addEventListener("click", () => { this.setCollapsed(group, !group.collapsed); this.saveFolds(); });
      this.setCollapsed(group, folds ? folds.includes(id) : id === "older");
      return [id, group];
    })) as Record<GroupId, Group>;

    this.registerEvent(this.app.vault.on("delete", file => this.removeFile(file.path)));
    this.registerEvent(this.app.vault.on("rename", (_file, oldPath) => this.removeFile(String(oldPath))));
    this.registerEvent(this.app.workspace.on("file-open", () => this.markActive()));
    const refresh = debounce(() => { void this.updateRecentChanges(); }, 1000, true);
    const ref = this.sync.on("status-change", refresh);
    this.register(() => this.sync.offref(ref));
    // The day boundaries move at midnight.
    this.registerInterval(window.setInterval(() => { if (!moment().isSame(this.previousRefreshDate, "day")) void this.updateRecentChanges(); }, 300_000));
    this.register(() => this.navHeaderEl.remove());
    void this.updateRecentChanges();
  }

  protected onClose(): void { this.navHeaderEl?.remove(); this.contentEl.empty(); }

  private foldKey() { return `obsen:sync-view-folds:${this.app.vault.getName()}`; }
  private loadFolds(): string[] | null { try { const value = JSON.parse(localStorage.getItem(this.foldKey()) ?? "null") as unknown; return Array.isArray(value) ? value.map(String) : null; } catch { return null; } }
  private saveFolds(): void { try { localStorage.setItem(this.foldKey(), JSON.stringify(Object.values(this.groups).filter(group => group.collapsed).map(group => group.id))); } catch { /* storage is optional */ } }
  private setCollapsed(group: Group, collapsed: boolean): void {
    group.collapsed = collapsed;
    group.el.toggleClass("is-collapsed", collapsed);
    group.el.querySelector(".collapse-icon")?.toggleClass("is-collapsed", collapsed);
    group.childrenEl.style.display = collapsed ? "none" : "";
  }

  private removeFile(path: string): void { this.fileEls[path]?.remove(); delete this.fileEls[path]; }

  private markActive(): void {
    const active = this.app.workspace.getActiveFile();
    const path = active instanceof TFile ? active.path : "";
    for (const [filePath, el] of Object.entries(this.fileEls)) el.firstElementChild?.toggleClass("is-active", filePath === path);
  }

  private applySearchFilter(): void {
    const query = this.searchQuery;
    for (const [path, el] of Object.entries(this.fileEls)) el.style.display = !query || path.toLowerCase().includes(query) ? "" : "none";
  }

  private async loadUsernameMap(): Promise<void> {
    if (this.userMapLoaded) return;
    const status = this.sync.getStatus();
    if (status !== "synced" && status !== "syncing") return;
    try { this.userMap = await this.sync.getUsernames(); this.userMapLoaded = true; } catch (error) { console.error(error); }
  }

  private getRecentSyncFiles(): Record<GroupId, SyncServerFile[]> {
    const { sync, hideMyChanges } = this, result: Record<GroupId, SyncServerFile[]> = { today: [], yesterday: [], week: [], older: [] };
    const today = moment().startOf("day").valueOf(), yesterday = today - 86_400_000, week = today - 518_400_000;
    for (const file of Object.values(sync.serverFiles)) {
      if (file.folder || file.deleted || file.path.startsWith(`${this.app.vault.configDir}/`)) continue;
      if (hideMyChanges && !(file.user && file.user !== sync.userId)) continue;
      (file.mtime > today ? result.today : file.mtime > yesterday ? result.yesterday : file.mtime > week ? result.week : result.older).push(file);
    }
    for (const files of Object.values(result)) files.sort((a, b) => b.mtime - a.mtime);
    return result;
  }

  private createFileItem(file: SyncServerFile): HTMLElement {
    const el = createDiv("tree-item nav-file"), self = el.createDiv("tree-item-self nav-file-title is-clickable");
    const extension = extensionOf(file.path), name = baseName(file.path);
    self.createDiv({ cls: "tree-item-inner nav-file-title-content", text: extension ? name.slice(0, -(extension.length + 1)) : name });
    if (extension !== "md") self.createDiv({ cls: "nav-file-tag", text: extension });
    self.setAttr("data-path", file.path);
    self.draggable = true;
    self.addEventListener("dragstart", event => { event.dataTransfer?.setData("text/plain", `[[${file.path.replace(/\.md$/, "")}]]`); });
    self.addEventListener("click", event => { void this.app.workspace.openLinkText(file.path, "", Keymap.isModEvent(event)); });
    self.addEventListener("contextmenu", event => {
      event.preventDefault();
      const menu = new Menu(), target = this.app.vault.getAbstractFileByPath(file.path);
      menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(() => { void this.app.workspace.openLinkText(file.path, "", "tab"); }));
      menu.addItem(item => item.setSection("view").setTitle(t("plugins.sync.menu-opt-view-version-history")).setIcon("lucide-history").onClick(() => this.showHistory(file.path)));
      if (target) this.app.workspace.trigger("file-menu", menu, target, "sync-context-menu", this.leaf);
      menu.showAtMouseEvent(event);
    });
    return el;
  }

  private async updateRecentChanges(): Promise<void> {
    const sync = this.sync;
    if (!sync.dataLoaded || !this.treeEl) return;
    await this.loadUsernameMap();
    const header = this.navHeaderEl, parent = this.contentEl.parentElement;
    if (parent && header.parentElement !== parent) parent.insertBefore(header, this.contentEl);
    const multiUser = Object.keys(this.userMap).length > 1;
    header.style.display = multiUser ? "" : "none";
    if (!multiUser) this.hideMyChanges = false;
    const status = sync.getStatus(), connected = status !== "uninitialized" && status !== "disconnected";
    this.treeEl.style.display = connected ? "" : "none"; this.uninitializedEl.style.display = connected ? "none" : "";
    const recent = this.getRecentSyncFiles(), previous = this.fileEls;
    this.fileEls = {};
    for (const [id] of GROUP_LABELS) {
      const group = this.groups[id], files = recent[id], children: HTMLElement[] = [];
      files.slice(0, id === "older" ? OLDER_LIMIT : undefined).forEach(file => { children.push(this.fileEls[file.path] = previous[file.path] ?? this.createFileItem(file)); });
      if (id === "older" && files.length > OLDER_LIMIT) {
        const more = createDiv("tree-item nav-file");
        more.createDiv("tree-item-self more-button").createDiv({ cls: "tree-item-inner nav-file-title-content", text: t("plugins.sync.label-more", { count: files.length - OLDER_LIMIT }) });
        children.push(more);
      }
      group.childrenEl.replaceChildren(...children);
      group.flairEl.setText(t("nouns.count", { count: files.length }));
    }
    this.markActive(); this.applySearchFilter();
    this.previousRefreshDate = moment();
  }
}

// ---------------------------------------------------------------------------------------------
// Module: status bar item, commands, file menu
// ---------------------------------------------------------------------------------------------

function createController({ app, actions }: CorePluginContext) {
  const sync = getVaultSync(app.vault, app);
  const openSettings = () => actions.openSettings("sync");
  const showVersionHistory = (path: string) => openSyncHistory(app, sync, path);
  const showSyncLog = () => { if (sync.vaultId) new SyncLogModal(app, sync).open(); else openSettings(); };
  const showDeletedFiles = () => { if (sync.vaultId) void openSyncDeletedFiles(app, sync); else openSettings(); };
  const activeFile = () => { const file = app.workspace.getActiveFile(); return file instanceof TFile ? file : null; };
  return { sync, openSettings, showVersionHistory, showSyncLog, showDeletedFiles, activeFile };
}

function installStatusBar(context: CorePluginContext, controller: ReturnType<typeof createController>): () => void {
  const { sync } = controller;
  // The shell still renders a static placeholder for this item; the live one below replaces it.
  const style = document.head.createEl("style", { text: ".status-bar > .status-bar-item.plugin-sync:not([data-sync-status]) { display: none; }" });
  const statusBarEl = createDiv({ cls: "status-bar-item plugin-sync", attr: { "data-sync-status": "" } });
  const iconEl = statusBarEl.createDiv("status-bar-item-segment").createSpan("status-bar-item-icon sync-status-icon");
  const attach = () => { if (!statusBarEl.isConnected) document.querySelector<HTMLElement>(".status-bar")?.append(statusBarEl); };
  const update = () => {
    attach();
    const status = sync.getStatus();
    setTooltip(statusBarEl, sync.syncStatus, { placement: "top" });
    statusBarEl.setAttr("data-sync-status", status);
    iconEl.removeClass("mod-success", "mod-working", "mod-error");
    const [icon, cls] = status === "uninitialized" ? ["sync-small", "mod-working"] : status === "disconnected" ? ["refresh-cw-off", "mod-error"] : status === "paused" ? ["paused", "mod-working"]
      : status === "syncing" ? ["sync-small", "mod-working"] : status === "synced" ? ["check-small", "mod-success"] : ["sync-small", "mod-error"];
    setIcon(iconEl, icon); iconEl.addClass(cls);
  };
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    const menu = new Menu(), file = controller.activeFile();
    menu.addItem(item => item.setSection("status").setTitle(t("plugins.sync.label-sync-status", { status: sync.syncStatus })).setIsLabel(true));
    if (sync.vaultId) {
      const paused = sync.pause;
      menu.addItem(item => item.setSection("status").setTitle(t(paused ? "plugins.sync.button-resume" : "plugins.sync.button-pause")).setIcon(paused ? "lucide-play-circle" : "paused").onClick(() => { void sync.setPause(!paused); }));
      menu.addItem(item => item.setSection("selection").setTitle(t("plugins.sync.label-version-history")).setIcon("lucide-history").setDisabled(!file).onClick(() => { if (file) controller.showVersionHistory(file.path); }));
      menu.addItem(item => item.setSection("global").setTitle(t("plugins.sync.option-sync-log")).setIcon("lucide-align-left").onClick(controller.showSyncLog));
      menu.addItem(item => item.setSection("global").setTitle(t("plugins.sync.option-view-deleted-files")).setIcon("lucide-trash-2").onClick(controller.showDeletedFiles));
      menu.addItem(item => item.setSection("global").setTitle(t("interface.settings")).setIcon("lucide-settings").onClick(controller.openSettings));
    } else menu.addItem(item => item.setTitle(t("interface.settings")).setIcon("lucide-settings").onClick(controller.openSettings));
    menu.showAtMouseEvent(event);
  };
  statusBarEl.addEventListener("click", openMenu); statusBarEl.addEventListener("contextmenu", openMenu);
  const requestUpdate = debounce(update, 100, false);
  const ref = sync.on("status-change", requestUpdate);
  const layout = context.app.workspace.on("layout-change", attach);
  update();
  context.app.workspace.onLayoutReady(() => {
    sync.setInitialized(); update();
    void sync.reconnectSaved().catch(error => {
      sync.log(syncErrorCopy(error), undefined, true);
      sync.setStatus(t("dialogue.label-error"));
    });
  });
  return () => { sync.offref(ref); context.app.workspace.offref(layout); statusBarEl.remove(); style.remove(); };
}

export const syncPlugin: CorePluginModule = {
  id: "sync",
  views: context => {
    const controller = createController(context);
    return { [SYNC_VIEW_TYPE]: leaf => new SyncView(leaf, controller.sync, controller.showVersionHistory) };
  },
  commands: context => {
    const controller = createController(context), { sync } = controller;
    return [
      { id: "sync:setup", check: () => !sync.vaultId, run: controller.openSettings },
      { id: "sync:view-version-history", check: () => Boolean(sync.vaultId) && controller.activeFile() !== null, run: () => { const file = controller.activeFile(); if (file) controller.showVersionHistory(file.path); } },
      { id: "sync:open-sync-view", check: () => Boolean(sync.vaultId), run: () => context.actions.revealLeafOfType(SYNC_VIEW_TYPE, "right") },
      { id: "sync:open-sync-log", check: () => Boolean(sync.vaultId), run: controller.showSyncLog },
    ];
  },
  install(context) {
    const controller = createController(context), { workspace } = context.app;
    const removeStatusBar = installStatusBar(context, controller);
    const refs = [
      workspace.on("file-menu", (menu: unknown, file: unknown, source: unknown) => {
        if (!(file instanceof TFile) || !["tab-header", "more-options", "file-explorer-context-menu"].includes(String(source))) return;
        (menu as Menu).addItem(item => item.setSection("view").setTitle(t("plugins.sync.menu-opt-view-version-history")).setIcon("lucide-history").onClick(() => controller.showVersionHistory(file.path)));
      }),
      // Raised by the Sync settings rows.
      workspace.on("sync:show-log", controller.showSyncLog),
      workspace.on("sync:show-deleted-files", controller.showDeletedFiles),
    ];
    return () => { for (const ref of refs) workspace.offref(ref); removeStatusBar(); };
  },
};
