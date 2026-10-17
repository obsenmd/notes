import { originalFs as fs, path, getRemote, process } from "../../platforms/platform";
import { useEffect, useState } from "react";

/** Preferences persisted in `.obsidian/app.json`. */
export interface AppConfig {
  attachmentFolderPath: string; spellcheck: boolean; spellcheckLanguages: string[] | null; showUnsupportedFiles: boolean; showHiddenFiles: boolean; propertiesInDocument: "visible" | "hidden" | "source";
  autoConvertHtml: boolean; newLinkFormat: "shortest" | "relative" | "absolute"; userIgnoreFilters: string[] | null; newFileLocation: "root" | "current" | "folder";
  newFileFolderPath: string; alwaysUpdateLinks: boolean; promptDelete: boolean; trashOption: "system" | "local" | "none"; deleteUnlinkedAttachments: "ask" | "always" | "never";
  useMarkdownLinks: boolean; foldHeading: boolean; foldIndent: boolean; rightToLeft: boolean; showIndentGuide: boolean; readableLineLength: boolean; strictLineBreaks: boolean;
  livePreview: boolean; useTab: boolean; tabSize: number; autoPairBrackets: boolean; autoPairMarkdown: boolean; smartIndentList: boolean; showLineNumber: boolean;
  settingsPopoutWindow: boolean; uriCallbacks: boolean; showRibbon: boolean; showInlineTitle: boolean; focusNewTab: boolean; defaultViewMode: "source" | "preview";
  autoFullScreen: boolean; openBehavior: string; vimMode: boolean; nativeMenus: boolean | null; floatingNavigation: boolean; showViewHeader: boolean; showTabTitleBar: boolean;
  detectAllFileExtensions: boolean; editableInlineTitle: boolean; showFrontmatter: boolean; zoomLevel: number;
}
/** Preferences persisted in `.obsidian/appearance.json`. */
export interface AppearanceConfig {
  theme: "system" | "obsidian" | "moonstone"; accentColor: string; cssTheme: string; enabledCssSnippets: string[]; translucency: boolean;
  interfaceFontFamily: string; textFontFamily: string; monospaceFontFamily: string; baseFontSize: number; baseFontSizeAction: boolean; nativeMenus?: boolean | null; showRibbon?: boolean; showViewHeader?: boolean;
  slidingSidebar?: boolean; floatingNavigation?: boolean; autoFullScreen?: boolean;
}
export type Config = AppConfig & AppearanceConfig;
export type ConfigKey = keyof Config;

export const DEFAULT_APP_CONFIG: AppConfig = {
  attachmentFolderPath: "/", spellcheck: true, spellcheckLanguages: null, showUnsupportedFiles: false, showHiddenFiles: false, propertiesInDocument: "visible", autoConvertHtml: true,
  newLinkFormat: "shortest", userIgnoreFilters: null, newFileLocation: "root", newFileFolderPath: "/", alwaysUpdateLinks: false, promptDelete: true, trashOption: "system",
  deleteUnlinkedAttachments: "ask", useMarkdownLinks: false, foldHeading: true, foldIndent: true, rightToLeft: false, showIndentGuide: true, readableLineLength: true,
  strictLineBreaks: false, livePreview: true, useTab: true, tabSize: 4, autoPairBrackets: true, autoPairMarkdown: true, smartIndentList: true, showLineNumber: false,
  settingsPopoutWindow: true, uriCallbacks: false, showRibbon: true, showInlineTitle: true, focusNewTab: true, defaultViewMode: "source", autoFullScreen: true, openBehavior: "",
  vimMode: false, nativeMenus: null, floatingNavigation: true, showViewHeader: true, showTabTitleBar: true, detectAllFileExtensions: false, editableInlineTitle: true,
  showFrontmatter: false, zoomLevel: 0,
};
export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  theme: "system", accentColor: "", cssTheme: "", enabledCssSnippets: [], translucency: false, interfaceFontFamily: "", textFontFamily: "", monospaceFontFamily: "",
  baseFontSize: 16, baseFontSizeAction: false,
};
/** The reference's appearance key list: these are written to appearance.json, everything else to app.json. */
const APPEARANCE_KEYS = new Set<string>(["accentColor", "theme", "cssTheme", "enabledCssSnippets", "showViewHeader", "showRibbon", "nativeMenus", "translucency", "textFontFamily", "interfaceFontFamily",
  "monospaceFontFamily", "baseFontSize", "baseFontSizeAction", "slidingSidebar", "floatingNavigation", "autoFullScreen"]);
/** Per-device values the reference keeps outside the vault (zoom is the window's zoom level, not a vault preference). */
const LOCAL_KEYS = new Set<string>(["zoomLevel", "baseFontSize"]);

/**
 * Application-level options that the main process owns in the reference (updates, hardware acceleration, window frame, CLI, icon).
 * They are kept in `<userData>/options.json` so the main process can read them at startup.
 */
export const appOptions = {
  file(): string | null {
    try { return path.join((getRemote() as { app: { getPath(name: string): string } }).app.getPath("userData"), "options.json"); }
    catch { return null; }
  },
  read(): Record<string, unknown> {
    const file = this.file();
    try { const parsed = file ? JSON.parse(fs.readFileSync(file, "utf8")) as unknown : null; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
    catch { return {}; }
  },
  get<T>(key: string, fallback: T): T { const value = this.read()[key]; return value === undefined ? fallback : value as T; },
  set(key: string, value: unknown): void {
    const file = this.file(); if (!file) return;
    const data = this.read();
    if (value === null || value === undefined) delete data[key]; else data[key] = value;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); } catch (error) { console.error(error); }
  },
};
/** Quits and starts the application again (the reference's `app.relaunch()`). */
export function relaunchApp(): void {
  try { const { app } = getRemote() as { app: { relaunch(): void; quit(): void } }; app.relaunch(); app.quit(); }
  catch { window.location.reload(); }
}

type Listener = (key: ConfigKey | null) => void;

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

const jsonWrites = new Map<string, Promise<void>>();
let jsonWriteSerial = 0;
/** Serialize saves to one file and snapshot each value at the time it is submitted. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  const key = path.resolve(file), text = JSON.stringify(data, null, 2);
  const temporary = `${key}.${process.pid}.${++jsonWriteSerial}.tmp`;
  const task = (jsonWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await fs.promises.mkdir(path.dirname(key), { recursive: true });
    try {
      await fs.promises.writeFile(temporary, text, "utf8");
      // Windows file watchers can briefly hold the destination open. Keep the
      // atomic replacement and its original destination intact while retrying.
      for (let attempt = 0; ; attempt++) {
        try { await fs.promises.rename(temporary, key); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 5) throw error;
          await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
        }
      }
    } finally { await fs.promises.unlink(temporary).catch(() => undefined); }
  });
  jsonWrites.set(key, task);
  try { await task; }
  finally { if (jsonWrites.get(key) === task) jsonWrites.delete(key); }
}

/** Vault preferences stored in the reference file layout; unknown keys are preserved on save. */
export class VaultConfig {
  private app: Record<string, unknown> = {};
  private appearance: Record<string, unknown> = {};
  private readonly listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = new Set<"app" | "appearance">();
  private writing: Promise<void> = Promise.resolve();
  readonly configDir: string;

  constructor(readonly vaultPath: string, configDirName = ".obsidian") { this.configDir = path.join(vaultPath, configDirName); }

  async load(): Promise<void> {
    [this.app, this.appearance] = await Promise.all([readJson(path.join(this.configDir, "app.json")), readJson(path.join(this.configDir, "appearance.json"))]);
    this.emit(null);
  }

  get<K extends ConfigKey>(key: K): Config[K] {
    if (LOCAL_KEYS.has(key)) {
      // The base font size starts from the vault's stored value, as in the reference, and is per device afterwards.
      try { const stored = localStorage.getItem(this.localKey(key)); if (stored !== null) return JSON.parse(stored) as Config[K]; } catch { /* fall through to the stored or default value */ }
    }
    const value = this.storedValue(key);
    if (key === "baseFontSize" && (Object.hasOwn(this.appearance, key) || Object.hasOwn(this.app, key))) {
      // Migrate the historical vault preference once; later raw vault writes do not replace the device preference.
      try { localStorage.setItem(this.localKey(key), JSON.stringify(value)); } catch { /* A host without storage still uses its vault preference. */ }
    }
    return value;
  }

  private storedValue<K extends ConfigKey>(key: K): Config[K] {
    const store = APPEARANCE_KEYS.has(key) ? this.appearance : this.app;
    if (Object.hasOwn(store, key) && store[key] !== undefined) return store[key] as Config[K];
    // Some appearance preferences were historically written to app.json.
    if (Object.hasOwn(this.app, key) && this.app[key] !== undefined) return this.app[key] as Config[K];
    return ({ ...DEFAULT_APP_CONFIG, ...DEFAULT_APPEARANCE_CONFIG } as Config)[key];
  }

  set<K extends ConfigKey>(key: K, value: Config[K]): void {
    if (LOCAL_KEYS.has(key)) {
      if (JSON.stringify(this.get(key)) === JSON.stringify(value)) return;
      localStorage.setItem(this.localKey(key), JSON.stringify(value));
      this.emit(key);
      return;
    }
    this.setStored(key, value);
  }

  private setStored(key: ConfigKey, value: unknown): void {
    const target = APPEARANCE_KEYS.has(key) ? "appearance" : "app";
    const store = this[target];
    if (JSON.stringify(store[key]) === JSON.stringify(value)) return;
    store[key] = value;
    this.dirty.add(target);
    this.emit(key);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 300);
  }

  private localKey(key: string): string { return `obsen:local-config:${this.vaultPath}:${key}`; }

  /** Raw access for plugin-facing `vault.getConfig` callers using keys outside the typed set. */
  getRaw(key: string): unknown { return key === "baseFontSize" ? this.storedValue("baseFontSize") : (this.get as (key: string) => unknown).call(this, key); }
  setRaw(key: string, value: unknown): void { if (key === "baseFontSize") this.setStored("baseFontSize", value); else (this.set as (key: string, value: unknown) => void).call(this, key, value); }

  flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const targets = [...this.dirty]; this.dirty.clear();
    this.writing = this.writing.catch(() => undefined).then(async () => {
      for (const target of targets) await writeJson(path.join(this.configDir, `${target}.json`), this[target]);
    });
    return this.writing;
  }

  onChange(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(key: ConfigKey | null) { for (const listener of [...this.listeners]) listener(key); }
}

/** Subscribes a component to one preference (or all preferences when no key is given). */
export function useConfig<K extends ConfigKey>(config: VaultConfig, key: K): Config[K] {
  const [, setTick] = useState(0);
  useEffect(() => config.onChange(changed => { if (changed === null || changed === key) setTick(tick => tick + 1); }), [config, key]);
  return config.get(key);
}
export function useAnyConfig(config: VaultConfig): void {
  const [, setTick] = useState(0);
  useEffect(() => config.onChange(() => setTick(tick => tick + 1)), [config]);
}

/** A button of the left ribbon as the configuration page lists it. */
export interface RibbonItem { id: string; title: string; icon: string; hidden: boolean }

/**
 * "Ribbon menu configuration": which ribbon buttons are hidden and in what order they appear.
 * The reference keeps `{ hiddenItems: { id: boolean } }` (key order is the display order) under `left-ribbon` in workspace.json;
 * here the same object is kept per vault in local storage and applied to the ribbon's buttons directly.
 */
export class RibbonLayout {
  private readonly listeners = new Set<() => void>();
  private applying = false;
  constructor(private readonly doc: Document, private readonly storageKey: string) {}

  private read(): Record<string, boolean> {
    try { const value = JSON.parse(localStorage.getItem(this.storageKey) ?? "{}") as { hiddenItems?: unknown }; return value.hiddenItems && typeof value.hiddenItems === "object" ? value.hiddenItems as Record<string, boolean> : {}; }
    catch { return {}; }
  }
  private write(hiddenItems: Record<string, boolean>): void { localStorage.setItem(this.storageKey, JSON.stringify({ hiddenItems })); this.apply(); for (const listener of [...this.listeners]) listener(); }
  private buttons(): HTMLElement[] { return [...this.doc.querySelectorAll<HTMLElement>(".side-dock-actions > .side-dock-ribbon-action")]; }
  private static idOf(button: HTMLElement): string { return button.getAttribute("aria-label") ?? ""; }

  /** Every ribbon button, in display order. */
  items(): RibbonItem[] {
    const saved = this.read(), order = Object.keys(saved), seen = new Set<string>();
    const found = this.buttons().map(button => ({ id: RibbonLayout.idOf(button), title: button.getAttribute("aria-label") ?? "", icon: [...(button.querySelector("svg")?.classList ?? [])].find(name => name !== "svg-icon") ?? "" }))
      .filter(item => item.id && !seen.has(item.id) && !!seen.add(item.id));
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    return found.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index).map(({ item }) => ({ ...item, hidden: saved[item.id] === true }));
  }
  private save(items: RibbonItem[]): void { this.write(Object.fromEntries(items.map(item => [item.id, item.hidden]))); }
  setHidden(id: string, hidden: boolean): void { this.save(this.items().map(item => item.id === id ? { ...item, hidden } : item)); }
  /** Moves a visible item to another position among the visible ones. */
  move(from: number, to: number): void {
    const items = this.items(), visible = items.filter(item => !item.hidden);
    if (from === to || !visible[from] || !visible[to]) return;
    const [moved] = visible.splice(from, 1); visible.splice(to, 0, moved);
    this.save([...visible, ...items.filter(item => item.hidden)]);
  }
  /** Hides and orders the ribbon buttons; ordering uses the flex `order` so the elements themselves stay where their owner put them. */
  apply(): void {
    if (this.applying) return;
    this.applying = true;
    try {
      const items = this.items(), position = new Map(items.map((item, index) => [item.id, index])), hidden = new Set(items.filter(item => item.hidden).map(item => item.id));
      const customized = Object.keys(this.read()).length > 0;
      for (const button of this.buttons()) {
        const id = RibbonLayout.idOf(button);
        const display = hidden.has(id) ? "none" : "", order = customized ? String(position.get(id) ?? items.length) : "";
        if (button.style.display !== display) button.style.display = display;
        if (button.style.order !== order) button.style.order = order;
      }
    } finally { this.applying = false; }
  }
  /** Keeps the layout applied as buttons come and go (plugins toggled, language changed). */
  watch(): () => void {
    this.apply();
    let signature = this.buttons().map(RibbonLayout.idOf).join("\n");
    const observer = new MutationObserver(() => {
      const next = this.buttons().map(RibbonLayout.idOf).join("\n");
      if (next === signature) return;
      signature = next; this.apply();
      for (const listener of [...this.listeners]) listener();
    });
    observer.observe(this.doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
    return () => observer.disconnect();
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
let ribbonLayout: RibbonLayout | null = null;
/** The ribbon layout of this window's vault. */
export function getRibbonLayout(vaultPath: string): RibbonLayout {
  return ribbonLayout ??= new RibbonLayout(window.document, `obsen:left-ribbon:${vaultPath}`);
}
