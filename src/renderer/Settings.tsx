import { ipcRenderer } from "../../platforms/platform";
import { brandName } from "../i18n";
import { useConfig } from "./config";
import { Titlebar } from "./WorkspaceShell";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Scope } from "../compat/commands";
import type { PluginSettingTab } from "../compat/plugin";
import { prepareSimpleSearch, type SearchResult } from "../compat/suggest";
import { useT } from "../i18n/react";
import { trackActiveWindow } from "../compat/ui";
import { installTooltips } from "./tooltip";
import { CORE_PLUGINS, useCorePlugins } from "./core-plugins";
import { CORE_PLUGIN_MODULES } from "./core";
import { SettingsContext, type SettingPageDefinition, type SettingsContextValue, type SettingsEnvironment } from "./settings/controls";
import { AppearanceTab, EditorTab, FilesTab, GeneralTab, InterfaceTab } from "./settings/tabs-core";
import { BacklinkOptions, CanvasOptions, CommandPaletteOptions, CommunityPluginsTab, CorePluginsTab, DailyNotesOptions, FileRecoveryOptions, WebViewerOptions, HotkeysTab, KeychainTab, NoteComposerOptions, PagePreviewOptions, SwitcherOptions, SyncOptions, TemplatesOptions } from "./settings/tabs-plugins";
import { ClickableIcon, IconEl, SearchInput, cx } from "./ui";

export type { SettingsEnvironment };

interface TabDefinition { id: string; name: string; icon: string; render(): ReactNode; /** Tabs that render themselves imperatively are found by name only. */ indexed?: boolean }

/** Mounts a community plugin's settings tab, which renders itself into a container element. */
function PluginTab({ tab }: { tab: PluginSettingTab }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    el.append(tab.containerEl);
    tab.containerEl.replaceChildren();
    try { tab.display(); } catch (error) { console.error("Plugin settings failed to render", error); }
    return () => { try { tab.hide(); } catch (error) { console.error(error); } tab.containerEl.remove(); };
  }, [tab]);
  return <div ref={container} style={{ display: "contents" }} />;
}

const VERSION: string = ipcRenderer.sendSync("version");

// ---------------------------------------------------------------- search index

interface IndexEntry { tab: TabDefinition; pagePath: string[]; pageName: string | null; name: string; description: string; aliases: string[] }
interface IndexPage { tab: TabDefinition; pagePath: string[]; name: string }
interface SearchGroup { tab: TabDefinition; pagePath: string[]; pageName: string | null; tabNameMatch: SearchResult | null; results: Array<{ entry: IndexEntry; nameMatch: SearchResult | null; score: number }>; bestScore: number }

const pagePathOf = (element: Element, root: Element): string[] => {
  const path: string[] = [];
  for (let page = element.closest("[data-setting-page]"); page && root.contains(page); page = page.parentElement?.closest("[data-setting-page]") ?? null) path.unshift(page.getAttribute("data-setting-page") ?? "");
  return path;
};

/** Reads the rows of the off-screen copy of every tab: what the reference gets from its setting definitions. */
function scrapeIndex(root: HTMLElement, tabs: TabDefinition[]): { entries: IndexEntry[]; pages: IndexPage[] } {
  const entries: IndexEntry[] = [], pages: IndexPage[] = [];
  for (const tab of tabs) {
    const container = root.querySelector<HTMLElement>(`[data-index-tab="${CSS.escape(tab.id)}"]`);
    if (!container) continue;
    for (const page of container.querySelectorAll<HTMLElement>("[data-setting-page]")) pages.push({ tab, pagePath: [...pagePathOf(page.parentElement!, container), page.dataset.settingPage ?? ""], name: page.dataset.settingPageName ?? "" });
    for (const row of container.querySelectorAll<HTMLElement>(".setting-item:not(.setting-item-heading):not(.mod-empty-state)")) {
      if (row.dataset.searchable === "false" || row.style.display === "none") continue;
      const name = row.dataset.searchName ?? row.querySelector(":scope > .setting-item-info > .setting-item-name")?.textContent ?? "";
      if (!name.trim()) continue;
      const pagePath = pagePathOf(row, container);
      let aliases: string[] = [];
      try { aliases = row.dataset.searchAliases ? JSON.parse(row.dataset.searchAliases) as string[] : []; } catch { /* no aliases */ }
      entries.push({ tab, pagePath, pageName: pagePath.length ? pages.find(page => page.tab.id === tab.id && page.pagePath.join("\n") === pagePath.join("\n"))?.name ?? pagePath[pagePath.length - 1] : null, name,
        description: row.querySelector(":scope > .setting-item-info > .setting-item-description")?.textContent ?? "", aliases });
    }
  }
  return { entries, pages };
}

/** The reference's settings search: every word must occur in the name, description or an alias; grouped by tab or page, best first. */
function searchIndex(query: string, tabs: TabDefinition[], index: { entries: IndexEntry[]; pages: IndexPage[] }): SearchGroup[] {
  if (!query) return [];
  const match = prepareSimpleSearch(query), groups: SearchGroup[] = [];
  const group = (tab: TabDefinition, pagePath: string[] = [], pageName: string | null = null) => {
    const key = pagePath.join("\n");
    let found = groups.find(item => item.tab.id === tab.id && item.pagePath.join("\n") === key);
    if (!found) groups.push(found = { tab, pagePath, pageName, tabNameMatch: null, results: [], bestScore: -Infinity });
    return found;
  };
  for (const entry of index.entries) {
    const nameMatch = match(entry.name), descriptionMatch = entry.description ? match(entry.description) : null;
    let aliasMatch: SearchResult | null = null;
    for (const alias of entry.aliases) { const result = match(alias); if (result && (!aliasMatch || result.score > aliasMatch.score)) aliasMatch = result; }
    const score = Math.max(nameMatch?.score ?? -Infinity, descriptionMatch?.score ?? -Infinity, aliasMatch?.score ?? -Infinity);
    if ((nameMatch || descriptionMatch || aliasMatch) && score > -Infinity) group(entry.tab, entry.pagePath, entry.pageName).results.push({ entry, nameMatch, score });
  }
  for (const tab of tabs) { const result = match(tab.name); if (result) group(tab).tabNameMatch = result; }
  for (const page of index.pages) { const result = match(page.name); if (result) group(page.tab, page.pagePath, page.name).tabNameMatch = result; }
  for (const item of groups) {
    item.results.sort((a, b) => b.score - a.score);
    item.bestScore = Math.max(item.results[0]?.score ?? -Infinity, item.tabNameMatch?.score ?? -Infinity);
  }
  return groups.sort((a, b) => b.bestScore - a.bestScore);
}

function Highlighted({ text, match }: { text: string; match: SearchResult | null }) {
  if (!match?.matches.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of match.matches) {
    if (start >= text.length) break;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<span className="suggestion-highlight" key={start}>{text.slice(start, end)}</span>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

// ---------------------------------------------------------------- modal

export function SettingsModal({ environment, initialTab, onClose }: { environment: SettingsEnvironment; initialTab?: string; onClose(): void }) {
  const t = useT();
  // "Open settings in new window": the same content, hosted in its own window.
  const popout = useConfig(environment.config, "settingsPopoutWindow");
  const [popoutWindow, setPopoutWindow] = useState<Window | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const escapeRef = useRef<() => boolean>(() => false);
  useEffect(() => {
    if (!popout) return;
    const win = window.open("about:blank", "obsen-settings", "width=900,height=700");
    if (!win) return;
    for (const style of document.querySelectorAll("style,link[rel=stylesheet]")) win.document.head.append(style.cloneNode(true));
    const syncBody = () => { win.document.body.className = [...document.body.className.split(/\s+/).filter(name => name && !/^is-(focused|maximized|fullscreen)$/.test(name)), "is-popout-window", "is-popout-modal", ...(win.document.hasFocus() ? ["is-focused"] : [])].join(" "); win.document.body.style.cssText = document.body.style.cssText; };
    syncBody();
    const observer = new MutationObserver(syncBody); observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    win.addEventListener("focus", syncBody); win.addEventListener("blur", syncBody);
    const closed = () => closeRef.current();
    win.addEventListener("beforeunload", closed);
    win.addEventListener("keydown", event => { if (event.key === "Escape" && !event.defaultPrevented && !win.document.querySelector(".modal-container, .menu, .suggestion-container") && !escapeRef.current()) win.close(); });
    const stopTooltips = installTooltips(win.document), stopTracking = trackActiveWindow(win);
    win.focus();
    setPopoutWindow(win);
    return () => { stopTooltips(); stopTracking(); observer.disconnect(); win.removeEventListener("beforeunload", closed); win.close(); setPopoutWindow(null); };
  }, [popout]);
  const { host, corePlugins } = environment;
  const enabled = useCorePlugins(corePlugins);
  const [active, setActive] = useState(initialTab ?? localStorage.getItem("obsen:settings-tab") ?? "about");
  const [hotkeyQuery, setHotkeyQuery] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<SettingPageDefinition[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [index, setIndex] = useState<{ entries: IndexEntry[]; pages: IndexPage[] }>({ entries: [], pages: [] });
  const [, setTick] = useState(0);
  const indexRoot = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const pageRegistry = useRef(new Map<string, SettingPageDefinition>());
  const open = (id: string, query?: string) => { if (id === "hotkeys") setHotkeyQuery(query ?? ""); setActive(id); setPages([]); localStorage.setItem("obsen:settings-tab", id); };
  // Escape leaves a page before it closes the settings.
  escapeRef.current = () => { if (!pages.length) return false; setPages(stack => stack.slice(0, -1)); return true; };

  // Settings behave as a modal for the keymap: workspace hotkeys are suspended and Escape closes.
  useEffect(() => {
    const scope = new Scope();
    scope.register([], "Escape", () => { if (!escapeRef.current()) onClose(); return false; });
    host.app.keymap.pushScope(scope);
    const ref = host.app.on("plugin-settings-changed", () => setTick(tick => tick + 1));
    return () => { host.app.keymap.popScope(scope); host.app.offref(ref); };
  }, [host, onClose]);

  const optionTabs: TabDefinition[] = useMemo(() => [
    { id: "about", name: t("setting.about.name"), icon: "lucide-circle-user", render: () => <GeneralTab environment={environment} version={VERSION} /> },
    { id: "appearance", name: t("setting.appearance.name"), icon: "lucide-palette", render: () => <AppearanceTab environment={environment} /> },
    { id: "interface", name: t("setting.interface.name"), icon: "lucide-monitor", render: () => <InterfaceTab environment={environment} /> },
    { id: "editor", name: t("setting.editor.name"), icon: "lucide-pen-line", render: () => <EditorTab environment={environment} /> },
    { id: "file", name: t("setting.file.name"), icon: "lucide-folder-cog", render: () => <FilesTab environment={environment} /> },
    { id: "hotkeys", name: t("setting.hotkeys.name"), icon: "lucide-command", render: () => <HotkeysTab key={hotkeyQuery} environment={environment} initialQuery={hotkeyQuery} />, indexed: false },
    { id: "keychain", name: t("setting.keychain.name"), icon: "lucide-key-round", render: () => <KeychainTab environment={environment} /> },
    { id: "plugins", name: t("setting.builtin-plugins"), icon: "lucide-toy-brick", render: () => <CorePluginsTab environment={environment} onOpenTab={open} /> },
    { id: "community-plugins", name: t("setting.third-party-plugin.name"), icon: "lucide-puzzle", render: () => <CommunityPluginsTab environment={environment} onOpenTab={open} /> },
  ], [environment, t, hotkeyQuery]);

  const coreRenderers: Record<string, () => ReactNode> = {
    backlink: () => <BacklinkOptions environment={environment} />, canvas: () => <CanvasOptions environment={environment} />,
    "command-palette": () => <CommandPaletteOptions environment={environment} />, "daily-notes": () => <DailyNotesOptions environment={environment} />,
    "file-recovery": () => <FileRecoveryOptions environment={environment} />, "note-composer": () => <NoteComposerOptions environment={environment} />,
    "page-preview": () => <PagePreviewOptions environment={environment} />, switcher: () => <SwitcherOptions environment={environment} />,
    sync: () => <SyncOptions environment={environment} />, webviewer: () => <WebViewerOptions environment={environment} />, templates: () => <TemplatesOptions environment={environment} />,
  };
  for (const module of CORE_PLUGIN_MODULES) if (module.settings) { const Options = module.settings; coreRenderers[module.id] = () => <Options environment={environment} />; }
  // Registration order (the plugin registry's) decides ties in the search; the sidebar lists them by name.
  const coreTabsByRegistration: TabDefinition[] = CORE_PLUGINS.filter(plugin => enabled[plugin.id] && coreRenderers[plugin.id])
    .map(plugin => ({ id: plugin.id, name: t(`plugins.${plugin.group}.name`), icon: plugin.icon ?? "lucide-settings", render: coreRenderers[plugin.id] }));
  const coreTabs = [...coreTabsByRegistration].sort((a, b) => a.name.localeCompare(b.name));
  const communityTabs: TabDefinition[] = [...host.app.settingTabs.entries()].map(([id, tab]) => ({ id: `plugin:${id}`, name: tab.plugin?.manifest.name ?? id, icon: "lucide-puzzle", render: () => <PluginTab tab={tab} />, indexed: false }));
  const groups = [{ section: "options", title: t("setting.options"), tabs: optionTabs }, { section: "core-plugins", title: t("setting.builtin-plugins"), tabs: coreTabs },
    { section: "community-plugins", title: t("setting.third-party-plugin.name"), tabs: [...communityTabs].sort((a, b) => a.name.localeCompare(b.name)) }];
  const searchTabs = [...optionTabs, ...coreTabsByRegistration, ...communityTabs];
  const current = searchTabs.find(tab => tab.id === active) ?? optionTabs[0];
  const page = pages.length ? pages[pages.length - 1] : null;

  const query = search.trim();
  const searching = query !== "";
  // The index is read from an off-screen copy of every tab, kept mounted (and re-read when it changes) while a search is active.
  useEffect(() => {
    const root = indexRoot.current;
    if (!searching || !root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => { timer = null; setIndex(scrapeIndex(root, searchTabs)); };
    read();
    const observer = new MutationObserver(() => { if (timer === null) timer = setTimeout(read, 50); });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] });
    return () => { observer.disconnect(); if (timer !== null) clearTimeout(timer); };
  }, [searching, searchTabs.map(tab => tab.id).join("\n"), t]);
  useEffect(() => setExpanded(new Set()), [query]);
  const results = useMemo(() => searching ? searchIndex(query, searchTabs, index) : [], [query, index]);

  const flash = (name: string) => {
    const rows = [...content.current?.querySelectorAll<HTMLElement>(".setting-item") ?? []];
    const row = rows.find(item => (item.querySelector(":scope > .setting-item-info > .setting-item-name")?.textContent ?? "") === name) ?? rows.find(item => (item.querySelector(":scope > .setting-item-info > .setting-item-name")?.textContent ?? "").startsWith(name));
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("is-flashing");
    (row.ownerDocument.defaultView ?? window).setTimeout(() => row.classList.remove("is-flashing"), 750);
  };
  const pendingFlash = useRef<string | null>(null);
  useEffect(() => { if (pendingFlash.current !== null) { const name = pendingFlash.current; pendingFlash.current = null; (content.current?.ownerDocument.defaultView ?? window).requestAnimationFrame(() => flash(name)); } });
  const navigate = (group: SearchGroup, entry?: IndexEntry) => {
    if (group.tab.id === "hotkeys") setHotkeyQuery("");
    setActive(group.tab.id); localStorage.setItem("obsen:settings-tab", group.tab.id);
    setPages(group.pagePath.map((_id, depth) => pageRegistry.current.get(`${group.tab.id}\n${group.pagePath.slice(0, depth + 1).join("\n")}`)).filter((item): item is SettingPageDefinition => !!item));
    if (entry) pendingFlash.current = entry.name;
  };

  const context: SettingsContextValue = useMemo(() => ({ indexing: false, openPage: next => setPages(stack => stack.some(item => item.id === next.id) ? stack : [...stack, next]), closePage: () => setPages(stack => stack.slice(0, -1)) }), []);
  const back = () => { if (pages.length) setPages(stack => stack.slice(0, -1)); else if (!popout) onClose(); };

  const body = <div className="modal mod-settings mod-sidebar-layout">
      <ClickableIcon icon="lucide-x" className="modal-header-button mod-raised" onClick={onClose} />
      <div className="modal-header"><div className="modal-title"><ClickableIcon icon="lucide-arrow-left" className="modal-setting-back-button mod-raised" onClick={back} /><div>{page ? page.title : current.name}</div></div></div>
      <div className="modal-content vertical-tabs-container">
        <div className="vertical-tab-header" tabIndex={-1}>
          <div className="setting-search-container"><SearchInput className="mod-raised" value={search} onChange={setSearch} placeholder={t("setting.search-settings")} /></div>
          <div className="setting-search-results" style={searching ? undefined : { display: "none" }}>
            {results.map(group => {
              const key = `${group.tab.id}\n${group.pagePath.join("\n")}`, showAll = expanded.has(key), hiddenCount = Math.max(0, group.results.length - 3);
              return <div className="setting-search-result-group" key={key}>
                <div className="vertical-tab-nav-item setting-search-result-tab tappable" tabIndex={-1} onClick={() => navigate(group)}>
                  <IconEl className="vertical-tab-nav-item-icon" icon={group.tab.icon} />
                  <div className="setting-search-result-tab-text">
                    <div className="setting-search-result-tab-label"><Highlighted text={group.pageName ?? group.tab.name} match={group.tabNameMatch} /></div>
                    {group.pageName !== null && <div className="setting-search-result-tab-sublabel">{group.tab.name}</div>}
                  </div>
                  <IconEl className="vertical-tab-nav-item-chevron" icon="lucide-chevron-right" />
                </div>
                {group.results.length > 0 && <div className="setting-search-result-group-items">
                  {group.results.map((result, position) => <div key={position} className="vertical-tab-nav-item setting-search-result-item tappable" tabIndex={-1} style={position >= 3 && !showAll ? { display: "none" } : undefined} onClick={() => navigate(group, result.entry)}>
                    <div className="vertical-tab-nav-item-title"><Highlighted text={result.entry.name} match={result.nameMatch} /></div>
                    <IconEl className="vertical-tab-nav-item-chevron" icon="lucide-chevron-right" />
                  </div>)}
                  {hiddenCount > 0 && !showAll && <div className="vertical-tab-nav-item setting-search-result-item setting-search-result-show-more tappable" tabIndex={-1} onClick={() => setExpanded(previous => new Set(previous).add(key))}>{t("setting.search-show-more", { count: hiddenCount })}</div>}
                </div>}
              </div>;
            })}
            {!results.length && <div className="setting-search-empty">{t("setting.no-search-results")}</div>}
          </div>
          <div className="vertical-tab-header-group-container" style={searching ? { display: "none" } : undefined}>
            {groups.map(group => <div className="vertical-tab-header-group" key={group.section}>
              <div className="vertical-tab-header-group-title" style={group.tabs.length ? undefined : { display: "none" }}>{group.title}</div>
              <div className="vertical-tab-header-group-items" data-section={group.section}>
                {group.tabs.map(tab => <div key={tab.id} className={cx("vertical-tab-nav-item tappable", tab.id === current.id && "is-active")} data-setting-id={tab.id} tabIndex={-1} onClick={() => open(tab.id)}>
                  <IconEl className="vertical-tab-nav-item-icon" icon={tab.icon} />
                  <div className="vertical-tab-nav-item-title">{tab.name}</div>
                  <IconEl className="vertical-tab-nav-item-chevron" icon="lucide-chevron-right" />
                </div>)}
              </div>
            </div>)}
          </div>
          {searching && <div ref={indexRoot} style={{ display: "none" }} aria-hidden="true">
            {searchTabs.filter(tab => tab.indexed !== false).map(tab => <div key={tab.id} data-index-tab={tab.id}>
              <SettingsContext.Provider value={{ indexing: true, pagePath: [], openPage: () => undefined, closePage: () => undefined, registerPage: (pagePath, definition) => { pageRegistry.current.set(`${tab.id}\n${pagePath.join("\n")}`, definition); } }}>{tab.render()}</SettingsContext.Provider>
            </div>)}
          </div>}
        </div>
        <div className="vertical-tab-content-container" tabIndex={-1} ref={content}>
          <SettingsContext.Provider value={context}>
            {page
              ? <div className="setting-page vertical-tab-content" key={`${current.id}\n${pages.map(item => item.id).join("\n")}`}>
                  <div className="setting-page-titlebar">
                    <ClickableIcon icon="lucide-chevron-left" className="setting-page-back-button" onClick={() => setPages(stack => stack.slice(0, -1))} />
                    <div className="setting-page-title">{page.title}</div>
                  </div>
                  <div className="setting-page-content">{page.render()}</div>
                </div>
              : <div className="vertical-tab-content" key={current.id}>{current.render()}</div>}
          </SettingsContext.Provider>
        </div>
      </div>
    </div>;
  if (popout) return popoutWindow ? createPortal(<><Titlebar title={`${t("interface.settings")} - ${environment.vault.name} - ${brandName()} ${VERSION}`} targetWindow={popoutWindow} />{body}</>, popoutWindow.document.body) : null;
  return <div className="modal-container mod-dim">
    <div className="modal-bg" style={{ opacity: 0.85 }} onClick={onClose} />
    {body}
  </div>;
}
