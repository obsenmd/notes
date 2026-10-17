import { originalFs as nodeFs, path } from "../../platforms/platform";
import { t } from "../i18n";
import type { EventRef } from "./events";
import { CommunityPluginLoader, type CommunityPluginFailure } from "./community-plugin-loader";
import { FileManager } from "./file-manager";
import { MetadataCache, parseMarkdownMetadata } from "./metadata-cache";
import { FileSystemAdapter } from "./node-adapter";
import { App, type StorageLike } from "./plugin";
import { setPropertyDailyNoteOpener } from "./property-daily-notes";
import { setBasesEnabled } from "./bases-registry";
import { Vault, TFile, type TAbstractFile } from "./vault";
import { Workspace } from "./workspace";
import { VaultFileWatcher } from "./vault-watch";
import { installDomExtensions } from "./dom";
import { MarkdownView } from "./markdown-view";
import { MediaFileView, MEDIA_EXTENSIONS } from "./media-view";
import { installPdfSupport } from "../renderer/pdf/view";
import { FileView, TextFileView } from "./file-views";
import { CanvasFileView, GraphWorkspaceView, LocalGraphWorkspaceView } from "../renderer/CoreViews";

import { BasesFileView } from "../renderer/BasesFileView";
import { DEFAULT_WEB_VIEWER_SETTINGS, HISTORY_KEY, WebHistory, WebHistoryView, WebViewerView, type WebViewerEnvironment, type WebViewerSettings } from "../renderer/WebViewer";
import { readCorePluginData } from "../renderer/core-plugins";
import { disconnectVaultSync } from "../renderer/SyncVaultManager";
import { CORE_DOCK_VIEWS, CORE_VIEW_PLUGINS, CoreDockView, type CoreDockType } from "./core-view";

/** Plugin-facing properties attached by the desktop compatibility host. */
export interface RuntimeHostOptions {
  vaultPath: string;
  vaultId?: string;
  storage: StorageLike;
  vaultName?: string;
  workspaceElement?: HTMLElement;
  openFile?: (path: string) => Promise<void>;
  onPluginsChanged?: (plugins: Array<{ id: string; name: string; version: string }>) => void;
  onPluginError?: (id: string, error: Error) => void;
  corePlugins?: Record<string, boolean>;
  /** Runs with loaded files, before indexing and community plugin startup. */
  prepareVault?: (host: RuntimeHost) => Promise<void>;
  /** When set, community plugins are not loaded (the vault has not been trusted). */
  restrictedMode?: boolean;
}

/** Owns the Obsidian-compatible objects and community plugin lifecycle. */
export class RuntimeHost {
  readonly app: App;
  readonly adapter: FileSystemAdapter;
  readonly vault: Vault;
  readonly metadataCache: MetadataCache;
  readonly workspace: Workspace;
  readonly pluginLoader: CommunityPluginLoader;
  readonly watcher: VaultFileWatcher;
  readonly accountClient: App["accountClient"];
  readonly pluginErrors: CommunityPluginFailure[] = [];
  private readonly eventRefs: EventRef[] = [];
  private disposed = false;
  private pluginsReady = false;
  private readonly activeCoreViews = new Set<string>();

  get loadedCommunityPlugins(): Array<{ id: string; name: string; version: string }> {
    return this.app.plugins.listPlugins().map(plugin => ({ id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version }));
  }

  private constructor(private readonly options: RuntimeHostOptions) {
    if (typeof window !== "undefined") installDomExtensions(window);
    this.app = new App({ localStorage: options.storage, storageNamespace: options.vaultPath, vaultId: options.vaultId });
    this.accountClient = this.app.accountClient;
    this.adapter = new FileSystemAdapter(options.vaultPath, options.vaultName);
    this.vault = new Vault(this.adapter, options.vaultName);
    this.metadataCache = new MetadataCache({
      getFiles: () => this.vault.getFiles(),
      getFileByPath: (path) => this.vault.getFileByPath(path),
    });
    this.workspace = new Workspace(this.app, options.workspaceElement);
    this.workspace.registerView("markdown", (leaf) => new MarkdownView(leaf));
    for (const type of Object.keys(MEDIA_EXTENSIONS) as Array<keyof typeof MEDIA_EXTENSIONS>) {
      this.workspace.registerView(type, leaf => new MediaFileView(leaf, type));
      this.workspace.registerExtensions([...MEDIA_EXTENSIONS[type]], type);
    }
    this.setCorePlugins(options.corePlugins ?? {});

    this.app.vault = this.vault;
    this.app.workspace = this.workspace;
    this.app.metadataCache = this.metadataCache;
    // PDF files have a native view and embed, like images, audio and video.
    installPdfSupport(this.app);
    const appConfig = (): Record<string, unknown> => {
      try { return JSON.parse(nodeFs.readFileSync(path.join(options.vaultPath, this.vault.configDir, "app.json"), "utf8")) as Record<string, unknown>; }
      catch { return {}; }
    };
    this.app.fileManager = new FileManager(
      this.vault,
      this.workspace,
      this.metadataCache,
      {
        useSystemTrash: () => appConfig().trashOption !== "local",
        linkSettings: () => { const config = appConfig(); return { newLinkFormat: typeof config.newLinkFormat === "string" ? config.newLinkFormat : undefined, useMarkdownLinks: config.useMarkdownLinks === true }; },
        // "Default location for new attachments" from the vault's app.json.
        attachmentFolder: (sourcePath) => {
          const configured = String(appConfig().attachmentFolderPath ?? "/");
          const sourceFolder = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
          if (configured === "/" || configured === "") return "";
          if (configured === "./" || configured === ".") return sourceFolder;
          if (configured.startsWith("./")) return [sourceFolder, configured.slice(2)].filter(Boolean).join("/");
          return configured.replace(/^\/+|\/+$/g, "");
        },
        openLink: async (linktext, sourcePath) => {
          const destination = this.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
          const file = destination && this.vault.getFileByPath(destination.path);
          if (!file) throw new Error(t("dialogue.msg-file-or-folder-not-found", { path: linktext }));
          const leaf = this.workspace.getMostRecentLeaf() ?? this.workspace.getLeaf(true);
          await leaf.openFile(file);
        },
      },
    );
    // New and renamed files take part in the recent-file list, as in the reference.
    this.eventRefs.push(this.vault.on("create", file => { if (this.workspace.layoutReady && file instanceof TFile) this.workspace.collectRecentFile(file.path); }));
    this.eventRefs.push(this.vault.on("rename", (file, oldPath) => { if (this.workspace.layoutReady) this.workspace.renameRecentFile(file.path, oldPath); }));
    this.watcher = new VaultFileWatcher(this.vault, { includeConfig: true, ignore: [".obsidian/plugins"], onError: (error) => {
      this.pluginErrors.push({ id: "<vault-watch>", error });
      options.onPluginError?.("<vault-watch>", error);
    } });
    this.pluginLoader = new CommunityPluginLoader(this.app.plugins, {
      onError: (id, error) => {
        this.pluginErrors.push({ id, error });
        options.onPluginError?.(id, error);
      },
    });
    this.connectMetadataEvents();
  }

  /** Construct the host, index existing Markdown files, then start enabled plugins. */
  setCorePlugins(preferences: Record<string, boolean>): void {
    setPropertyDailyNoteOpener(this.app, preferences["daily-notes"] !== false
      ? (date, event) => this.workspace.trigger("daily-note:open", date, event) : undefined);
    setBasesEnabled(this.app, preferences.bases !== false);
    const factories = new Map<string, { plugin: string; create: import("./workspace").ViewCreator; extensions?: string[] }>();
    for (const type of Object.keys(CORE_DOCK_VIEWS) as CoreDockType[]) factories.set(type, { plugin: CORE_VIEW_PLUGINS[type], create: leaf => new CoreDockView(leaf, type) });
    factories.set("canvas", { plugin: "canvas", create: leaf => new CanvasFileView(leaf), extensions: ["canvas"] });
    factories.set("graph", { plugin: "graph", create: leaf => new GraphWorkspaceView(leaf) });
    factories.set("localgraph", { plugin: "graph", create: leaf => new LocalGraphWorkspaceView(leaf) });
    const history = new WebHistory(() => this.app.loadLocalStorage(HISTORY_KEY), items => this.app.saveLocalStorage(HISTORY_KEY, items));
    const web: WebViewerEnvironment = {
      history,
      settings: async () => ({ ...DEFAULT_WEB_VIEWER_SETTINGS, ...await readCorePluginData(path.join(this.adapter.basePath, this.vault.configDir), "webviewer") as Partial<WebViewerSettings> }),
      saveNote: async (title, markdown, folder) => {
        const name = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
        const parent = folder && this.vault.getFolderByPath(folder) || this.app.fileManager.getNewFileParent("");
        const file = await this.app.fileManager.createNewMarkdownFile(parent, name, markdown);
        await this.workspace.getLeaf("tab").openFile(file);
      },
    };
    factories.set("webviewer", { plugin: "webviewer", create: leaf => new WebViewerView(leaf, web) });
    factories.set("webviewer-history", { plugin: "webviewer", create: leaf => new WebHistoryView(leaf, history) });
    factories.set("bases", { plugin: "bases", create: leaf => new BasesFileView(leaf), extensions: ["base"] });
    for (const [type, entry] of factories) {
      const enabled = entry.plugin === "webviewer" ? preferences[entry.plugin] === true : preferences[entry.plugin] !== false;
      if (enabled && !this.activeCoreViews.has(type)) {
        this.workspace.registerView(type, entry.create); this.activeCoreViews.add(type);
        if (entry.extensions) this.workspace.registerExtensions(entry.extensions, type);
      } else if (!enabled && this.activeCoreViews.delete(type)) {
        this.workspace.unregisterExtensions(type); this.workspace.unregisterView(type);
      }
    }
    if (preferences.sync === false && this.vault) void disconnectVaultSync(this.vault).catch(error => this.options.onPluginError?.("sync", asError(error)));
    this.app.trigger("core-plugins-changed", { ...preferences });
  }

  static async create(options: RuntimeHostOptions): Promise<RuntimeHost> {
    const host = new RuntimeHost(options);
    try {
      await host.vault.initialize();
      await options.prepareVault?.(host);
      await host.reindexMarkdown();
      await host.watcher.start();
      host.pluginsReady = true;
      try {
        if (!options.restrictedMode) {
          const result = await host.pluginLoader.loadVault(options.vaultPath);
          host.pluginErrors.push(...result.failures);
        }
        options.onPluginsChanged?.(host.loadedCommunityPlugins);
      } catch (cause) {
        const error = asError(cause);
        host.pluginErrors.push({ id: "<plugin-list>", error });
        options.onPluginError?.("<plugin-list>", error);
      }
      await host.workspace.loadLayout();
      return host;
    } catch (error) {
      host.dispose();
      throw error;
    }
  }

  /** Stop plugins and detach host-owned vault listeners. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    setPropertyDailyNoteOpener(this.app, undefined);
    this.workspace.stopPersistence();
    void disconnectVaultSync(this.vault).catch(error => this.options.onPluginError?.("sync", asError(error)));
    for (const container of [...this.workspace.floatingSplit]) container.win.close();
    const errors: unknown[] = [];
    try { this.pluginLoader.unloadAll(); } catch (error) { errors.push(error); }
    try { this.watcher.dispose(); } catch (error) { errors.push(error); }
    try { this.app.plugins.unloadAll(); } catch (error) { errors.push(error); }
    for (const ref of this.eventRefs.splice(0)) {
      try { this.vault.offref(ref); } catch (error) { errors.push(error); }
    }
    for (const leaf of this.getLeaves()) {
      try { leaf.detach(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Runtime host failed to dispose cleanly.");
  }

  private connectMetadataEvents(): void {
    this.eventRefs.push(this.vault.on("create", (file) => { void this.indexFile(file); }));
    const maybeReloadPlugins = (file: TAbstractFile) => {
      if (!this.pluginsReady || this.disposed || this.options.restrictedMode) return;
      if (!(file instanceof TFile) || file.path !== `${this.vault.configDir}/community-plugins.json`) return;
      void this.pluginLoader.reloadVault(this.options.vaultPath)
        .then(() => this.options.onPluginsChanged?.(this.loadedCommunityPlugins))
        .catch(error => {
          const failure = asError(error);
          this.pluginErrors.push({ id: "<plugin-list>", error: failure });
          this.options.onPluginError?.("<plugin-list>", failure);
        });
    };
    this.eventRefs.push(this.vault.on("create", maybeReloadPlugins));
    this.eventRefs.push(this.vault.on("modify", (file) => {
      maybeReloadPlugins(file);
      void this.indexFile(file);
      if (file instanceof TFile) {
        for (const leaf of this.getLeaves()) {
          const view = leaf.view;
          if (view instanceof TextFileView && view.file === file && !view.isDirty) void this.vault.read(file).then(data => { if (view.file === file && !view.isDirty) view.acceptExternalChange(data); });
        }
      }
    }));
    this.eventRefs.push(this.vault.on("delete", maybeReloadPlugins));
    this.eventRefs.push(this.vault.on("delete", (file) => this.removeFile(file)));
    this.eventRefs.push(this.vault.on("delete", (file) => {
      for (const leaf of this.getLeaves()) if (leaf.view instanceof FileView && leaf.view.file && (leaf.view.file === file || leaf.view.file.path.startsWith(`${file.path}/`))) {
        void leaf.view.onDelete(file);
      }
    }));
    this.eventRefs.push(this.vault.on("rename", (file, oldPath) => {
      const renamedPath = file.path;
      for (const leaf of this.getLeaves()) if (leaf.view instanceof FileView && leaf.view.file && (leaf.view.file.path === renamedPath || leaf.view.file.path.startsWith(`${renamedPath}/`))) void leaf.view.onRename(leaf.view.file);
      this.workspace.notifyLayoutChange();
      const renamedFiles = file instanceof TFile
        ? [file]
        : this.vault.getFiles().filter(candidate => candidate.path === renamedPath || candidate.path.startsWith(`${renamedPath}/`));
      for (const candidate of renamedFiles) {
        const suffix = candidate.path === renamedPath ? "" : candidate.path.slice(renamedPath.length);
        const previousPath = `${oldPath}${suffix}`;
        this.metadataCache.removeFile({ path: previousPath, basename: basename(previousPath), extension: extension(previousPath) });
        void this.indexFile(candidate);
      }
    }));
  }

  private async reindexMarkdown(): Promise<void> {
    for (const file of this.vault.getFiles()) await this.indexFile(file);
  }

  private async indexFile(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.path.split("/").some(part => part.startsWith(".")) || !["md", "canvas"].includes(file.extension.toLowerCase()) || this.disposed) return;
    try {
      const data = await this.vault.cachedRead(file);
      if (!this.disposed && this.vault.getFileByPath(file.path) === file) {
        this.metadataCache.setFileCache(file, data, file.extension.toLowerCase() === "canvas" ? {} : parseMarkdownMetadata(data));
      }
    } catch (cause) {
      const error = asError(cause);
      this.pluginErrors.push({ id: `<metadata:${file.path}>`, error });
    }
  }

  private removeFile(file: TAbstractFile): void {
    if (file instanceof TFile && ["md", "canvas"].includes(file.extension.toLowerCase())) this.metadataCache.removeFile(file);
  }

  private getLeaves() {
    const leaves: ReturnType<Workspace["getLeaf"]>[] = [];
    this.workspace.iterateAllLeaves((leaf) => { leaves.push(leaf); });
    return leaves;
  }
}

function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
