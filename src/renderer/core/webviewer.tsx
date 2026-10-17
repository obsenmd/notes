import { ipcRenderer } from "../../../platforms/platform";
import { useEffect, useState } from "react";
import { Keymap } from "../../compat/commands";

import type { App } from "../../compat/plugin";
import { Menu, Modal } from "../../compat/ui";
import { t } from "../../i18n";
import { button, div, settingRow, toggle } from "../canvas/dom";
import { readCorePluginData } from "../core-plugins";
import { Group, TextInput, ToggleRow, describe, usePluginData, type SettingsEnvironment } from "../settings/controls";
import { SettingItem, Slider } from "../ui";
import { Dropdown } from "../settings/controls";
import { DEFAULT_SEARCH_ENGINE, DEFAULT_WEB_VIEWER_SETTINGS, HISTORY_KEY, SEARCH_ENGINES, WEB_HISTORY_VIEW_TYPE, WEB_VIEW_TYPE, WebViewerView, electronRemote, searchEngineUrl, webViewerHost, webviewPartition, type WebViewerSettings } from "../WebViewer";
import type { PaneType } from "../../compat/workspace";
import type { CorePluginContext, CorePluginModule } from "./types";

const readSettings = async (configDir: string): Promise<WebViewerSettings> => ({ ...DEFAULT_WEB_VIEWER_SETTINGS, ...await readCorePluginData(configDir, "webviewer").catch(() => ({})) as Partial<WebViewerSettings> });
const activeViewer = ({ app }: CorePluginContext) => app.workspace.getActiveViewOfType(WebViewerView);
function openUrl(app: App, url: string, target: PaneType | boolean, active = true): void {
  void app.workspace.getLeaf(target).setViewState({ type: WEB_VIEW_TYPE, active, state: { url, title: url, navigate: true } });
}
/** Ad-block lists and their update interval are shared by all vaults, so they live outside the vault. */
const ADBLOCK_LISTS = "obsen-adblock-lists", ADBLOCK_FREQUENCY = "obsen-adblock-frequency", DEFAULT_LISTS = ["https://easylist.to/easylist/easylist.txt", "https://easylist.to/easylist/easyprivacy.txt"];
const storedLists = (): string[] => {
  try { const legacy = JSON.parse(localStorage.getItem(ADBLOCK_LISTS) ?? "null"); if (Array.isArray(legacy)) { ipcRenderer.sendSync("adblock-lists", legacy); localStorage.removeItem(ADBLOCK_LISTS); } } catch { /* Ignore malformed legacy data. */ }
  return ipcRenderer.sendSync("adblock-lists") ?? DEFAULT_LISTS;
};
const storedFrequency = (): number => {
  const legacy = localStorage.getItem(ADBLOCK_FREQUENCY);
  if (legacy !== null) { const days = Number(legacy); if (Number.isFinite(days)) ipcRenderer.sendSync("adblock-frequency", days); localStorage.removeItem(ADBLOCK_FREQUENCY); }
  return ipcRenderer.sendSync("adblock-frequency") ?? 4;
};

/** "Search the web": a prompt whose text is looked up with the configured search engine in a new tab. */
class WebSearchModal extends Modal {
  constructor(app: App, private readonly configDir: string) {
    super(app);
    this.modalEl.classList.remove("modal"); this.modalEl.classList.add("prompt"); this.modalEl.replaceChildren();
    const input = div("prompt-input-container", this.modalEl).appendChild(Object.assign(document.createElement("input"), { className: "prompt-input", type: "text", placeholder: t("plugins.web-viewer.label-search-the-web") }));
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      void readSettings(this.configDir).then(settings => this.app.workspace.getLeaf("tab").setViewState({ type: WEB_VIEW_TYPE, active: true, state: { url: searchEngineUrl(input.value, settings), navigate: true } }));
      this.close();
    });
    queueMicrotask(() => input.focus());
  }
}

/** "Clear web viewer data": cookies, cache and history, or everything the session stores. */
class ClearDataModal extends Modal {
  constructor(app: App) {
    super(app);
    this.setTitle(t("plugins.web-viewer.title-clear-data-modal"));
    const state = { cookies: true, cache: true, history: true, all: false }, content = this.contentEl;
    const cookies = settingRow(content, t("plugins.web-viewer.action-clear-data-cookies"), t("plugins.web-viewer.action-clear-data-cookies-desc"), "mod-toggle"), cookiesToggle = toggle(cookies.controlEl, true, value => { state.cookies = value; });
    const cache = settingRow(content, t("plugins.web-viewer.action-clear-data-cache"), "", "mod-toggle"), cacheToggle = toggle(cache.controlEl, true, value => { state.cache = value; });
    const history = settingRow(content, t("plugins.web-viewer.action-clear-data-history"), "", "mod-toggle"), historyToggle = toggle(history.controlEl, true, value => { state.history = value; });
    toggle(settingRow(content, t("plugins.web-viewer.action-clear-data-all"), t("plugins.web-viewer.action-clear-data-all-desc"), "mod-toggle").controlEl, false, value => {
      state.all = value;
      for (const row of [cookies, cache, history]) row.setDisabled(value);
      if (value) { cookiesToggle.set(true); cacheToggle.set(true); historyToggle.set(true); state.cookies = state.cache = state.history = true; }
    });
    const buttons = div("modal-button-container", this.modalEl);
    button(buttons, t("plugins.web-viewer.action-clear-data"), "mod-warning mod-cta", () => void (async () => {
      const storages = state.all ? ["cookies", "filesystem", "indexdb", "localstorage", "shadercache", "serviceworkers", "cachestorage"] : [...(state.cookies ? ["cookies"] : []), ...(state.cache ? ["cachestorage"] : [])];
      const session = storages.length ? electronRemote()?.session.fromPartition(webviewPartition(app)) : null;
      if (session) { await session.clearStorageData({ storages }); if (state.all) await session.clearData?.(); }
      if (state.history) { app.saveLocalStorage(HISTORY_KEY, []); app.workspace.trigger("webviewer:update-history"); }
      this.close();
    })().catch(error => console.error(error)));
    button(buttons, t("dialogue.button-cancel"), "mod-cancel", () => this.close());
  }
}

function WebViewerSettingsTab({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "webviewer", { ...DEFAULT_WEB_VIEWER_SETTINGS } as WebViewerSettings & Record<string, unknown>);
  const [lists, setLists] = useState(() => storedLists().join("\n")), [frequency, setFrequency] = useState(storedFrequency);
  const [engineDraft, setEngineDraft] = useState<string | null>(null), [engineError, setEngineError] = useState(false);
  // As in the reference, the custom row is drawn with the tab and only hidden once another engine is picked.
  const [customShown, setCustomShown] = useState<boolean | null>(null);
  const fallback = SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE].url!, custom = data.customSearchEngine || data.customSearchUrl || fallback;
  useEffect(() => { if (!engineError) return; const timer = setTimeout(() => setEngineError(false), 2000); return () => clearTimeout(timer); }, [engineError]);
  return <Group>
    <ToggleRow name={t("plugins.web-viewer.option-open-external-links")} description={describe("plugins.web-viewer.option-open-external-links")} value={data.openExternalURLs} onChange={value => set({ openExternalURLs: value })} />
    <SettingItem name={t("plugins.web-viewer.option-homepage")} description={describe("plugins.web-viewer.option-homepage")}><TextInput value={data.homepage} onChange={value => set({ homepage: value })} /></SettingItem>
    <SettingItem name={t("plugins.web-viewer.option-saved-markdown")} description={describe("plugins.web-viewer.option-saved-markdown")}><TextInput value={data.markdownPath} placeholder={t("setting.folder-path-example-placeholder")} onChange={value => set({ markdownPath: value })} /></SettingItem>
    <SettingItem name={t("plugins.web-viewer.option-search-engine")} description={describe("plugins.web-viewer.option-search-engine")}>
      <Dropdown value={data.searchEngine || DEFAULT_SEARCH_ENGINE} options={Object.entries(SEARCH_ENGINES).map(([value, engine]) => ({ value, label: engine.display === "custom" ? t("plugins.web-viewer.option-search-engine-custom-drop-down") : engine.display }))}
        onChange={value => { setCustomShown(value === "custom"); set({ searchEngine: value, ...(value === "custom" && !data.customSearchEngine ? { customSearchEngine: custom } : {}) }); }} />
    </SettingItem>
    {(customShown ?? true) && <SettingItem name={t("plugins.web-viewer.option-search-engine-custom")} description={describe("plugins.web-viewer.option-search-engine")}>
      <input type="text" spellCheck={false} placeholder={fallback} value={engineDraft ?? custom} aria-label={engineError ? t("obsen.web-viewer.search-engine-error") : undefined} className={engineError ? "is-invalid" : undefined}
        onChange={event => setEngineDraft(event.target.value)}
        onBlur={() => { if (engineDraft === null) return; if (engineDraft.includes("%s")) set({ customSearchEngine: engineDraft }); else setEngineError(true); setEngineDraft(null); }} />
    </SettingItem>}
    <ToggleRow name={t("plugins.web-viewer.option-enable-adblock")} description={describe("plugins.web-viewer.option-enable-adblock")} value={data.enableAdblocking} onChange={value => set({ enableAdblocking: value })} />
    <SettingItem className={data.enableAdblocking ? "is-disabled" : undefined} name={t("plugins.web-viewer.option-adblock-lists")} description={describe("plugins.web-viewer.option-adblock-lists")}>
      <textarea className="webviewer-adblock-lists" spellCheck={false} value={lists} onChange={event => setLists(event.target.value)}
        onBlur={() => ipcRenderer.sendSync("adblock-lists", lists.split("\n"))} />
    </SettingItem>
    <SettingItem name={t("plugins.web-viewer.option-adblock-frequency")} description={describe("plugins.web-viewer.option-adblock-frequency")}>
      <Slider value={frequency} min={0} max={24} step={1} format={String} onChange={value => setFrequency(ipcRenderer.sendSync("adblock-frequency", value))} />
    </SettingItem>
    <SettingItem name={t("plugins.web-viewer.label-web-viewer-data")}><button onClick={() => new ClearDataModal(environment.host.app).open()}>{t("plugins.web-viewer.label-clear-data")}</button></SettingItem>
  </Group>;
}

export const webviewerModule: CorePluginModule = {
  id: "webviewer",
  commands: context => {
    const { app, actions, configDir } = context;
    const viewer = (run: (view: WebViewerView) => unknown) => ({ check: () => !!activeViewer(context), run: () => { const view = activeViewer(context); if (view) return run(view); } });
    return [
      { id: "webviewer:open", run: async () => app.workspace.getLeaf(true).setViewState({ type: WEB_VIEW_TYPE, active: true, state: { url: (await readSettings(configDir)).homepage || "about:blank" } }) },
      { id: "webviewer:open-history", run: () => actions.revealLeafOfType(WEB_HISTORY_VIEW_TYPE, "left") },
      { id: "webviewer:toggle-reader-mode", ...viewer(view => view.toggleReaderMode()) },
      { id: "webviewer:focus-address-bar", ...viewer(view => view.focusAddressBar()) },
      { id: "webviewer:zoom-in", ...viewer(view => view.zoomIn()) },
      { id: "webviewer:zoom-reset", ...viewer(view => view.zoomReset()) },
      { id: "webviewer:zoom-out", ...viewer(view => view.zoomOut()) },
      { id: "webviewer:search", run: () => new WebSearchModal(app, configDir).open() },
      { id: "webviewer:save-to-vault", ...viewer(view => view.saveToVault()) },
    ];
  },
  install(context) {
    const { app, configDir, corePlugins } = context;
    storedLists(); storedFrequency();
    let settings = DEFAULT_WEB_VIEWER_SETTINGS;
    const load = () => void readSettings(configDir).then(next => { settings = next; ipcRenderer.send("create-browser-session", webviewPartition(app), settings.enableAdblocking); });
    load();
    webViewerHost.bookmarksEnabled = () => corePlugins.isEnabled("bookmarks");
    const refs = [
      app.workspace.on("core-plugin-settings-change", (id: unknown) => { if (id === "webviewer") load(); }),
      app.workspace.on("url-menu", (...data: unknown[]) => {
        const [menu, url] = data as [Menu, string];
        menu.addItem(item => item.setTitle(t("plugins.web-viewer.action-open-link-web-viewer")).setIcon("lucide-globe-2").setSection("open").onClick(event => openUrl(app, url, Keymap.isModEvent(event as MouseEvent))));
      }),
    ];
    const windows = new Set<Window>();
    const open = (event: Event) => {
      if (!settings.openExternalURLs) return;
      const detail = (event as CustomEvent<{ url: string; leaf: PaneType | boolean; active: boolean }>).detail;
      if (!detail || !/^https?:\/\//i.test(detail.url)) return;
      event.preventDefault();
      const doc = (event.currentTarget as Window).document;
      openUrl(app, detail.url, doc.querySelector(".modal-container") ? "window" : detail.leaf, detail.active);
    };
    const attach = (win: Window) => { if (!windows.has(win)) { windows.add(win); win.addEventListener("open-url", open); } };
    const detach = (win: Window) => { win.removeEventListener("open-url", open); windows.delete(win); };
    attach(app.workspace.rootSplit.win);
    app.workspace.floatingSplit.forEach(container => attach(container.win));
    refs.push(app.workspace.on("window-open", (_container, win) => attach(win as Window)), app.workspace.on("window-close", (_container, win) => detach(win as Window)));
    return () => { windows.forEach(detach); webViewerHost.bookmarksEnabled = () => true; for (const ref of refs) app.workspace.offref(ref); };
  },
  settings: WebViewerSettingsTab,
};
