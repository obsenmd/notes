import { process } from "../../platforms/platform";
import { Component } from "./component";
import { Events } from "./events";
import { Keymap, CommandRegistry, Scope, installPluginCommandApi } from "./commands";
import { AccountClient, type AccountSession } from "./account";
import { getIcon as resolveIcon, setIcon as renderIcon } from "./utilities";
import { SecretStorage } from "./secret-storage";
import { SettingTab } from "./setting-controls";
import type { EditorSuggest } from "./suggest";
import { MarkdownPreviewRenderer, type MarkdownPostProcessor } from "./markdown";
import { registerBasesView, type BasesViewRegistration } from "./bases-registry";

export type DesktopPlatform = "win" | "macOS" | "linux" | "mobile";

export const Platform = Object.freeze({
  isDesktop: true,
  isMobile: false,
  isTablet: false,
  isPhone: false,
  isMacOS: typeof process !== "undefined" && process.platform === "darwin",
  isWin: typeof process !== "undefined" && process.platform === "win32",
  isLinux: typeof process !== "undefined" && process.platform === "linux",
  isIosApp: false,
  isAndroidApp: false,
  isDesktopApp: true,
  isMobileApp: false,
  isSafari: false,
  isDesktopOnly: true,
  isIos: false,
  isAndroid: false,
  isMobileOnly: false,
});

/** The subset of the official App surface currently provided by the host. */
export class App extends Events {
  readonly commands = new CommandRegistry();
  readonly commandRegistry = this.commands;
  readonly plugins = new PluginManager(this);
  readonly localStorage: StorageLike;
  readonly storageNamespace: string;
  lastEvent: MouseEvent | KeyboardEvent | TouchEvent | PointerEvent | null = null;
  readonly renderContext: Record<string, unknown> = {};
  readonly accountClient: AccountClient;
  readonly secretStorage: SecretStorage;
  readonly keymap = new Keymap();
  readonly scope = new Scope();
  readonly settingTabs = new Map<string, PluginSettingTab>();
  /** Handlers for `obsidian://<action>` links registered by plugins. */
  readonly obsidianProtocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  /** @internal Handlers registered by plugins for the desktop CLI bridge. */
  readonly cliHandlers = new Map<string, CliHandlerRegistration>();
  editorExtensions: import("@codemirror/state").Extension[] = [];
  editorOptions: import("./codemirror-host").MarkdownEditorOptions = { tabSize: 4, useTab: true, spellcheck: true };
  private readonly browserPartition: string;
  vault!: import("./vault").Vault;
  workspace!: import("./workspace").Workspace;
  metadataCache!: import("./metadata-cache").MetadataCache;
  fileManager!: import("./file-manager").FileManager;

  constructor(options: { localStorage?: StorageLike; storageNamespace?: string; vaultId?: string } = {}) {
    super();
    this.commands.setContextProvider(() => this.getCommandContext());
    this.localStorage = options.localStorage ?? memoryStorage();
    this.storageNamespace = options.storageNamespace ?? "";
    this.browserPartition = "persist:vault-" + (options.vaultId || encodeURIComponent(this.storageNamespace) || this.appId);
    this.accountClient = new AccountClient({
      origin: "https://api.obsidian.md",
      storage: this.localStorage,
    });
    this.secretStorage = new SecretStorage(this.localStorage, this.storageNamespace || "app");
  }

  get appId(): string { return "app.obsidian"; }
  getWebviewPartition(): string { return this.browserPartition; }
  get isMobile(): boolean { return false; }
  get isDesktop(): boolean { return true; }
  get account(): AccountSession | null { return this.accountClient.session; }

  getIcon(name: string): SVGSVGElement | null { return resolveIcon(name); }
  setIcon(element: HTMLElement, name: string): void { renderIcon(element, name); }

  loadLocalStorage(key: string): unknown | null {
    try {
      const prefix = this.storageNamespace ? `${this.storageNamespace}:` : "";
      const raw = this.localStorage.getItem(`obsen:vault:${prefix}${key}`) ?? this.localStorage.getItem(`obsen:vault:${key}`);
      return raw === null ? null : JSON.parse(raw);
    }
    catch { return null; }
  }
  saveLocalStorage(key: string, data: unknown | null): void {
    const prefix = this.storageNamespace ? `${this.storageNamespace}:` : "";
    const storageKey = `obsen:vault:${prefix}${key}`;
    if (data === null) this.localStorage.removeItem(storageKey);
    else this.localStorage.setItem(storageKey, JSON.stringify(data));
  }
  isDarkMode(): boolean {
    if (typeof document === "undefined") return true;
    return document.documentElement.dataset.theme !== "light";
  }

  getViewRegistry(): Map<string, import("./workspace").ViewCreator> { return this.workspace.viewRegistry; }

  getScope(): Scope { return this.scope; }

  addCommand(command: Command): Command {
    if (!command.id) throw new Error("A command must have an id.");
    this.commands.add(command);
    return command;
  }

  registerPluginApi(plugin: Plugin): void { plugin.installCommandApi(); }

  removeCommand(id: string): void { this.commands.remove(id); }

  executeCommandById(id: string): boolean {
    const command = this.commands.commands.get(id);
    if (!command) return false;
    return this.commands.execute(id, this.getCommandContext());
  }

  /** @internal Dispatch a parsed CLI request after the host has selected a vault. */
  async invokeCliHandler(command: string, params: CliData): Promise<string> {
    const registration = this.cliHandlers.get(command);
    if (!registration) throw new Error(`Unknown CLI command: ${command}`);
    return await registration.handler(params);
  }

  getCommandContext(): import("./commands").CommandContext {
    const workspace = this.workspace;
    const active = workspace?.activeEditor as { editor?: unknown } | null | undefined;
    if (active?.editor) return { editor: active.editor, view: active };
    const view = workspace?.activeMarkdownView as (import("./workspace").View & { editor?: unknown }) | null | undefined;
    return { editor: view?.editor ?? workspace?.activeEditor, view: view ?? undefined };
  }
}

export interface PluginManifest {
  id: string;
  name: string;
  author: string;
  version: string;
  minAppVersion: string;
  description: string;
  dir?: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export interface Command {
  id: string;
  name: string;
  icon?: string;
  mobileOnly?: boolean;
  repeatable?: boolean;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export interface CliFlag { value?: string; description: string; required?: boolean }
export type CliFlags = Record<string, CliFlag>;
export type CliData = Record<string, string | "true">;
export type CliHandler = (params: CliData) => string | Promise<string>;
export interface CliHandlerRegistration { pluginId: string; description: string; flags: CliFlags | null; handler: CliHandler }

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Runtime base for plugins, including command ownership and persisted data. */
export abstract class Plugin extends Component {
  settings?: unknown;
  private readonly ownedCommands = new Set<string>();
  private commandApiInstalled = false;
  private commandIds = new Set<string>();
  get manifestDir(): string { return this.manifest.dir ?? ""; }
  get appId(): string { return this.app.appId; }
  get icon(): string { return this.manifest.id; }

  constructor(readonly app: App, readonly manifest: PluginManifest) { super(); }

  override onload(): Promise<void> | void {}
  /** Called after a user explicitly enables this plugin, after onload has finished. */
  onUserEnable(): void {}
  registerEditorExtension(extension: import("@codemirror/state").Extension): void {
    this.app.editorExtensions = [...this.app.editorExtensions, extension];
    this.app.workspace.trigger("editor-extensions-change");
    this.register(() => {
      this.app.editorExtensions = this.app.editorExtensions.filter(item => item !== extension);
      this.app.workspace.trigger("editor-extensions-change");
    });
  }
  addSettingTab(tab: PluginSettingTab): void {
    this.app.settingTabs.set(this.manifest.id, tab);
    this.register(() => { tab.hide(); this.app.settingTabs.delete(this.manifest.id); });
  }
  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.app.obsidianProtocolHandlers.set(action, handler);
    this.register(() => { if (this.app.obsidianProtocolHandlers.get(action) === handler) this.app.obsidianProtocolHandlers.delete(action); });
  }
  registerCliHandler(command: string, description: string, flags: CliFlags | null, handler: CliHandler): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(command)) throw new Error("A CLI command must use letters, numbers, colons, underscores, or hyphens.");
    if (this.app.cliHandlers.has(command)) throw new Error(`CLI command already registered: ${command}`);
    const registration: CliHandlerRegistration = { pluginId: this.manifest.id, description, flags: flags ? { ...flags } : null, handler };
    this.app.cliHandlers.set(command, registration);
    this.register(() => { if (this.app.cliHandlers.get(command) === registration) this.app.cliHandlers.delete(command); });
  }
  registerView(type: string, creator: import("./workspace").ViewCreator): void {
    this.app.workspace.registerPluginView(type, creator);
    this.register(() => { this.app.workspace.detachLeavesOfType(type); this.app.workspace.unregisterView(type); });
  }
  registerBasesView(viewId: string, registration: BasesViewRegistration): boolean {
    const dispose = registerBasesView(this.app, viewId, registration);
    if (!dispose) return false;
    this.register(dispose); return true;
  }
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
    this.app.workspace.registerHoverLinkSource(id, info);
    this.register(() => this.app.workspace.unregisterHoverLinkSource(id));
  }
  registerExtensions(extensions: string[], viewType: string): void {
    this.app.workspace.registerExtensions(extensions, viewType);
    this.register(() => this.app.workspace.unregisterExtensions(viewType));
  }
  registerEditorSuggest<T>(suggest: EditorSuggest<T>): void {
    suggest.attach();
    this.register(() => suggest.detach());
  }
  registerCommand(command: Command): void { this.app.commands.add(command); this.commandIds.add(command.id); }
  unregisterCommand(id: string): void { this.app.commands.remove(id); this.commandIds.delete(id); }
  registerMarkdownPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): MarkdownPostProcessor {
    MarkdownPreviewRenderer.registerPostProcessor(postProcessor, sortOrder);
    this.register(() => MarkdownPreviewRenderer.unregisterPostProcessor(postProcessor));
    return postProcessor;
  }
  registerMarkdownCodeBlockProcessor(
    language: string,
    handler: Parameters<typeof MarkdownPreviewRenderer.createCodeBlockPostProcessor>[1],
    sortOrder?: number,
  ): MarkdownPostProcessor {
    return this.registerMarkdownPostProcessor(MarkdownPreviewRenderer.createCodeBlockPostProcessor(language, handler), sortOrder);
  }
  override onunload(): void { for (const id of [...this.commandIds]) this.unregisterCommand(id); }

  /** @internal Install host APIs before invoking an asynchronous onload. */
  installCommandApi(): void {
    if (this.commandApiInstalled) return;
    this.commandApiInstalled = true;
    installPluginCommandApi(this, this.app.commands);
  }

  addCommand(command: Command): Command {
    const id = `${this.manifest.id}:${command.id}`;
    const value = { ...command, id, name: `${this.manifest.name}: ${command.name}` };
    const registered = this.app.addCommand(value);
    this.ownedCommands.add(id);
    this.register(() => this.removeCommand(id));
    return registered;
  }

  removeCommand(commandId: string): void {
    const id = commandId.includes(":") ? commandId : `${this.manifest.id}:${commandId}`;
    this.app.removeCommand(id);
    this.ownedCommands.delete(id);
  }

  async loadData(): Promise<unknown> {
    if (this.app.vault) {
      const filename = `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`;
      if (!await this.app.vault.adapter.exists(filename)) return null;
      return JSON.parse(await this.app.vault.adapter.read(filename));
    }
    const raw = this.app.localStorage.getItem(this.dataKey);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async saveData(data: unknown): Promise<void> {
    if (this.app.vault) {
      const directory = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      const filename = `${directory}/data.json`;
      if (data === undefined) { if (await this.app.vault.adapter.exists(filename)) await this.app.vault.adapter.remove(filename); return; }
      if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory);
      await this.app.vault.adapter.write(filename, JSON.stringify(data, null, 2));
      return;
    }
    if (data === undefined) { this.app.localStorage.removeItem(this.dataKey); return; }
    this.app.localStorage.setItem(this.dataKey, JSON.stringify(data));
  }

  addRibbonIcon(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
    const button = document.createElement("div");
    button.className = "clickable-icon side-dock-ribbon-action"; button.setAttribute("aria-label", title); button.setAttribute("data-ribbon-id", this.manifest.id); button.setAttribute("data-icon", icon); button.setAttribute("data-tooltip-position", "right");
    this.app.setIcon(button, icon); button.addEventListener("click", callback);
    document.querySelector<HTMLElement>(".side-dock-actions")?.append(button);
    this.register(() => button.remove());
    return button;
  }

  addStatusBarItem(): HTMLElement {
    const item = document.createElement("div"); item.className = `status-bar-item plugin-${this.manifest.id}`;
    document.querySelector<HTMLElement>(".status-bar")?.append(item);
    this.register(() => item.remove());
    return item;
  }

  private get dataKey(): string { const prefix = this.app.storageNamespace ? `${this.app.storageNamespace}:` : ""; return `obsen:plugin:${prefix}${this.manifest.id}:data`; }
}

export type PluginConstructor<T extends Plugin = Plugin> = new (app: App, manifest: PluginManifest) => T;

export abstract class PluginSettingTab extends SettingTab {
  readonly id: string;
  readonly name: string;
  constructor(app: App, readonly plugin: Plugin) {
    super(app, document.createElement("div"));
    this.id = plugin.manifest.id; this.name = plugin.manifest.name;
    this.containerEl.className = "vertical-tab-content";
  }
}

/** Owns plugin instances and awaits asynchronous startup before reporting ready. */
export class PluginManager {
  private readonly loaded = new Map<string, Plugin>();
  constructor(private readonly app: App) {}

  getPlugin<T extends Plugin = Plugin>(id: string): T | undefined { return this.loaded.get(id) as T | undefined; }
  listPlugins(): Plugin[] { return [...this.loaded.values()]; }

  createPlugin<T extends Plugin>(PluginType: PluginConstructor<T>, manifest: PluginManifest): T {
    validateManifest(manifest);
    if (this.loaded.has(manifest.id)) throw new Error(`Plugin already loaded: ${manifest.id}`);
    const plugin = new PluginType(this.app, manifest);
    this.loaded.set(manifest.id, plugin);
    return plugin;
  }

  async startPlugin<T extends Plugin>(plugin: T): Promise<T> {
    try {
      plugin.markLoaded();
      await plugin.onload();
      return plugin;
    }
    catch (error) {
      this.loaded.delete(plugin.manifest.id);
      plugin.unload();
      throw error;
    }
  }

  async loadPlugin<T extends Plugin>(PluginType: PluginConstructor<T>, manifest: PluginManifest): Promise<T> {
    const plugin = this.createPlugin(PluginType, manifest);
    this.app.registerPluginApi(plugin);
    return this.startPlugin(plugin);
  }

  /** Load a CommonJS plugin entry point from a plugin directory or bundle path. */
  async loadPluginModule<T extends Plugin>(modulePath: string, manifest: PluginManifest): Promise<T> {
    if (!modulePath.trim()) throw new Error("A plugin module path is required.");
    const { createPluginRequire } = await import("./module-hook");
    const { path } = await import("../../platforms/platform");
    const loaded = createPluginRequire(modulePath, path.dirname(modulePath))(modulePath) as { default?: unknown } | PluginConstructor<T>;
    const candidate = typeof loaded === "function" ? loaded : loaded.default;
    if (typeof candidate !== "function") throw new Error(`Plugin module did not export a Plugin class: ${modulePath}`);
    return this.loadPlugin(candidate as PluginConstructor<T>, manifest);
  }

  unloadPlugin(id: string): boolean {
    const plugin = this.loaded.get(id);
    if (!plugin) return false;
    this.loaded.delete(id);
    plugin.unload();
    return true;
  }

  unloadAll(): void {
    for (const id of [...this.loaded.keys()].reverse()) this.unloadPlugin(id);
  }
}

function validateManifest(manifest: PluginManifest): void {
  if (!manifest || typeof manifest !== "object") throw new Error("A plugin manifest is required.");
    for (const field of ["id", "name", "author", "version", "minAppVersion"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new Error(`Plugin manifest is missing a valid ${field}.`);
      }
    }
    if (manifest.description !== undefined && typeof manifest.description !== "string") throw new Error("Plugin manifest has an invalid description.");
}

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
