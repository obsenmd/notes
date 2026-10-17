import { getElectron, Buffer, createWebview } from "../../platforms/platform";
import { Keymap } from "../compat/commands";
import { Component } from "../compat/component";
import { sanitizeHTMLToDom } from "../compat/dom";
import { ImageLightbox } from "../compat/image-lightbox";
import { MarkdownRenderer } from "../compat/markdown";
import type { App } from "../compat/plugin";
import { renderMatches, type SearchMatches } from "../compat/suggest";
import { Menu, Notice } from "../compat/ui";
import { debounce, setIcon, setTooltip } from "../compat/utilities";
import type { TFile } from "../compat/vault";
import { ItemView, type PaneType, type WorkspaceLeaf } from "../compat/workspace";
import { t } from "../i18n";
import { BookmarkStore, openBookmarkDialog, urlBookmark } from "./bookmarks";
import { EXTRACT_ARTICLE, htmlToMarkdown, titleToFileName } from "./core/web-content";
import { formatHotkey } from "./hotkeys";

/** The subset of Electron's `<webview>` element the viewer drives. */
interface WebviewElement extends HTMLElement {
  src: string;
  getURL(): string; getTitle(): string; loadURL(url: string): Promise<void>;
  isLoading(): boolean; stop(): void; reload(): void;
  getZoomFactor(): number; setZoomFactor(factor: number): void;
  getWebContentsId(): number;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number; stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  executeJavaScript(code: string): Promise<unknown>;
}
interface ContextMenuParams { linkURL?: string; linkText?: string; selectionText?: string; isEditable?: boolean; mediaType?: string; srcURL?: string }
interface MenuTemplateItem { label?: string; type?: "separator"; role?: string; accelerator?: string; enabled?: boolean; click?: () => void }
interface Remote {
  Menu: { buildFromTemplate(template: MenuTemplateItem[]): { popup(options?: unknown): void } };
  getCurrentWindow(): unknown;
  webContents: { fromId(id: number): { noContextMenu?: boolean; isDestroyed(): boolean; on(event: string, listener: (...args: never[]) => void): void; setIgnoreMenuShortcuts(ignore: boolean): void } | undefined };
  session: { fromPartition(partition: string): { clearStorageData(options: { storages: string[] }): Promise<void>; clearData?(): Promise<void> } };
  nativeImage: { createFromBuffer(buffer: Buffer): unknown };
  clipboard: { writeImage(image: unknown): void; writeText(text: string): void };
}
export const electronRemote = (): Remote | null => { try { return (getElectron() as { remote?: Remote }).remote ?? null; } catch { return null; } };

/** Options stored in `.obsidian/webviewer.json`, with the reference file's keys. */
export interface WebViewerSettings {
  openExternalURLs: boolean; enableAdblocking: boolean; homepage: string; markdownPath: string; searchEngine: string; customSearchEngine: string;
  /** Key written by earlier versions of this app; read when `customSearchEngine` is absent. */
  customSearchUrl?: string;
}
export const DEFAULT_WEB_VIEWER_SETTINGS: WebViewerSettings = { openExternalURLs: true, enableAdblocking: true, homepage: "", markdownPath: "", searchEngine: "duckduckgo", customSearchEngine: "" };
export const SEARCH_ENGINES: Record<string, { display: string; url?: string }> = {
  duckduckgo: { display: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" }, brave: { display: "Brave", url: "https://search.brave.com/search?q=%s" },
  bing: { display: "Bing", url: "https://www.bing.com/search?q=%s" }, google: { display: "Google", url: "https://www.google.com/search?q=%s" }, custom: { display: "custom" },
};
export const DEFAULT_SEARCH_ENGINE = "duckduckgo";
export const WEB_VIEW_TYPE = "webviewer", WEB_HISTORY_VIEW_TYPE = "webviewer-history";
/** The browsing session of a vault's web viewers (cookies, cache), shared with web pages placed on a canvas. */
export const webviewPartition = (app: App) => app.getWebviewPartition();
/** What an empty web view holds, so that it has loaded something and can be navigated. */
const BLANK_DOCUMENT = "data:text/plain,";

export function searchEngineUrl(query: string, settings: Partial<WebViewerSettings>): string {
  const custom = settings.customSearchEngine || settings.customSearchUrl;
  const template = (settings.searchEngine === "custom" ? custom : SEARCH_ENGINES[settings.searchEngine ?? ""]?.url) || SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE].url!;
  return template.replace("%s", encodeURIComponent(query));
}
/** Resolves what was typed in the address bar to a URL, searching when it is not an address. */
export function resolveAddress(input: string, settings: Partial<WebViewerSettings>): string {
  const text = input.trim(), lower = text.toLowerCase();
  if (!text || lower === "about:blank") return "about:blank";
  if (lower.startsWith("http://") || lower.startsWith("https://")) return text;
  const host = /([^\/?#]+)/.exec(lower)?.[0] ?? "", dot = host.lastIndexOf(".");
  return dot !== -1 && dot !== host.length - 1 && !/\s/.test(host) ? "https://" + text : searchEngineUrl(text, settings);
}

export interface WebHistoryItem { url: string; title: string; time: number }
const HISTORY_KEY = "webviewer-history", ICONS_KEY = "webviewer-icons", HISTORY_LIMIT = 1000;
const domainOf = (url: string) => url.toLowerCase().match(/^https?:\/\/([^\/?#]+)/)?.[1];

/** Browsing history, kept per vault in local storage, newest first. */
export class WebHistory {
  private readonly listeners = new Set<() => void>();
  /** Site icons by host name; set by the app when it can persist them. */
  icons: { load(): Record<string, string>; save(icons: Record<string, string>): void } | null = null;
  private iconCache: Record<string, string> | null = null;
  constructor(private readonly load: () => unknown, private readonly save: (items: WebHistoryItem[]) => void) {}
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private write(items: WebHistoryItem[]): void { this.save(items); for (const listener of [...this.listeners]) listener(); }
  items(): WebHistoryItem[] { const raw = this.load(); return Array.isArray(raw) ? raw.filter((item): item is WebHistoryItem => !!item && typeof (item as WebHistoryItem).url === "string") : []; }
  /** Records a visit; reloading the page that was visited last adds nothing. */
  add(url: string, title: string): void {
    const items = this.items();
    if (!/^https?:/i.test(url) || items[0]?.url === url) return;
    this.write([{ url, title: title || "", time: Date.now() }, ...items].slice(0, HISTORY_LIMIT));
  }
  remove(target: string | WebHistoryItem): void { this.write(this.items().filter(item => typeof target === "string" ? item.url !== target : item.url !== target.url || item.time !== target.time)); }
  clear(): void { this.write([]); }
  private allIcons(): Record<string, string> { return this.iconCache ??= { ...this.icons?.load() }; }
  getIcon(url: string): string | null { const domain = domainOf(url); return domain ? this.allIcons()[domain] ?? null : null; }
  storeIcon(url: string, icon: string): void { const domain = domainOf(url); if (!domain || this.allIcons()[domain] === icon) return; this.allIcons()[domain] = icon; this.icons?.save(this.allIcons()); }
  /** Fills an element with a site's icon, or the globe when none is known. */
  setIcon(el: HTMLElement, url: string, icon?: string): void {
    if (icon) this.storeIcon(url, icon);
    const known = this.getIcon(url);
    if (!known) { setIcon(el, "globe-2"); return; }
    const image = el.ownerDocument.createElement("img"); image.src = known;
    image.addEventListener("error", () => { image.remove(); setIcon(el, "globe-2"); });
    el.append(image);
  }
}

export interface WebViewerEnvironment { settings(): Promise<WebViewerSettings>; history: WebHistory; saveNote(title: string, markdown: string, folder: string): Promise<void> }

const make = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = parent.ownerDocument.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
};
const shorten = (text: string, length: number) => text.length <= length ? text : text.slice(0, length - 1).trim() + "…";
const openExternally = (url: string) => window.open(url, "_external");
function bookmark(app: App, url: string, title = ""): void { const store = BookmarkStore.current; if (store) openBookmarkDialog(app, store, urlBookmark(url, title)); }
/** Set by the plugin module: whether the Bookmarks plugin is on, which decides if pages and links can be bookmarked. */
export const webViewerHost = { bookmarksEnabled: (): boolean => true };
const bookmarksEnabled = (_app: App) => !!BookmarkStore.current && webViewerHost.bookmarksEnabled();

interface AddressSuggestion { title: string; url: string; type: "about" | "history" | "bookmark" | "typed" | "search"; matches: SearchMatches | null }
/** The list under the address bar: what was typed (as an address or a search), then matching history and bookmarks. */
class AddressSuggest {
  private rootEl: HTMLElement | null = null;
  private values: AddressSuggestion[] = [];
  private selected = 0;
  private generation = 0;
  constructor(private readonly view: WebViewerView, private readonly inputEl: HTMLInputElement) {
    inputEl.addEventListener("input", () => void this.update());
    inputEl.addEventListener("blur", () => this.close());
    inputEl.addEventListener("keydown", event => {
      if (!this.rootEl || event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.select(this.selected + (event.key === "ArrowDown" ? 1 : -1)); }
      else if (event.key === "Enter") { const value = this.values[this.selected]; if (value) { event.preventDefault(); event.stopImmediatePropagation(); this.choose(value); } }
      else if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.close(); }
    }, true);
  }
  open(): void { void this.update(); }
  close(): void {
    this.generation++; this.rootEl?.remove(); this.rootEl = null; this.values = [];
    this.inputEl.ownerDocument.removeEventListener("scroll", this.reposition, true);
    this.inputEl.ownerDocument.defaultView?.removeEventListener("resize", this.reposition);
  }
  private readonly reposition = (): void => {
    const root = this.rootEl, doc = this.inputEl.ownerDocument;
    if (!root) return;
    const anchor = this.inputEl.getBoundingClientRect(), width = doc.documentElement.clientWidth, height = doc.documentElement.clientHeight;
    root.style.maxHeight = "";
    const above = anchor.top - 10, below = height - 10 - anchor.bottom, fitsAbove = above >= root.offsetHeight + 5, fitsBelow = below >= root.offsetHeight + 5;
    if (fitsBelow || (!fitsAbove && above <= below)) { root.style.top = `${Math.max(anchor.bottom, 10) + 5}px`; root.style.bottom = ""; }
    else { root.style.top = ""; root.style.bottom = `${height - Math.min(anchor.top, height - 10) + 5}px`; }
    if (!fitsAbove && !fitsBelow) root.style.maxHeight = `${Math.max(0, Math.max(above, below) - 5)}px`;
    if (doc.defaultView?.getComputedStyle(root).direction === "rtl") {
      const right = Math.max(10 + root.offsetWidth, Math.min(anchor.right, width - 10));
      root.style.left = ""; root.style.right = `${width - right}px`;
    } else { root.style.right = ""; root.style.left = `${Math.min(Math.max(anchor.left, 10), width - 10 - root.offsetWidth)}px`; }
  };
  private choose(value: AddressSuggestion): void { this.inputEl.blur(); this.view.navigate(value.url, true); this.close(); }
  private async suggestions(raw: string): Promise<AddressSuggestion[]> {
    const query = raw.toLowerCase(), byUrl = new Map<string, AddressSuggestion>();
    byUrl.set("about:blank", { url: "about:blank", title: t("obsen.web-viewer.blank"), type: "about", matches: null });
    for (const item of this.view.environment.history.items()) if (!byUrl.has(item.url)) byUrl.set(item.url, { url: item.url, title: item.title, type: "history", matches: null });
    const collect = (items: Array<{ type: string; url?: string; title?: string; items?: unknown }>) => { for (const item of items) { if (item.type === "url" && item.url) byUrl.set(item.url, { url: item.url, title: item.title ?? "", type: "bookmark", matches: null }); else if (item.type === "group" && Array.isArray(item.items)) collect(item.items as never); } };
    if (webViewerHost.bookmarksEnabled()) collect(BookmarkStore.current?.items ?? []);
    const results: AddressSuggestion[] = [];
    let exact = false;
    for (const item of byUrl.values()) {
      if (!query) { results.push(item); continue; }
      if (item.url.toLowerCase() === query) exact = true;
      const text = `${item.title} ${item.url}`.toLowerCase(), matches: SearchMatches = [];
      for (let at = -1; (at = text.indexOf(query, at)) !== -1; at += query.length + 1) matches.push([at, at + query.length]);
      if (matches.length) results.push({ ...item, matches });
    }
    if (exact || !query) return results;
    const settings = await this.view.environment.settings(), host = /([^\/?#]+)/.exec(query)?.[0] ?? "", dot = host.lastIndexOf(".");
    const protocol = query.startsWith("http://") || query.startsWith("https://"), typed = protocol || (dot !== -1 && dot !== host.length - 1);
    const url = typed ? (protocol ? raw : "https://" + raw) : searchEngineUrl(raw, settings);
    results.unshift(typed ? { title: "", url, type: "typed", matches: null } : { title: t("plugins.web-viewer.action-search-for-query", { query: raw }), url, type: "search", matches: null });
    return results;
  }
  private async update(): Promise<void> {
    const generation = ++this.generation, values = (await this.suggestions(this.inputEl.value)).slice(0, 100), doc = this.inputEl.ownerDocument;
    if (generation !== this.generation || doc.activeElement !== this.inputEl) return;
    if (!values.length) { this.close(); this.generation = generation; return; }
    this.values = values;
    const root = this.rootEl ??= make(doc.body, "div", "suggestion-container"), box = this.inputEl.getBoundingClientRect();
    Object.assign(root.style, { position: "fixed", width: `${box.width}px`, maxWidth: `${box.width}px` });
    root.replaceChildren();
    const list = make(root, "div", "suggestion");
    values.forEach((value, index) => {
      const row = make(list, "div", "suggestion-item mod-complex webviewer-addressbar-suggestion");
      const icon = make(row, "div", "suggestion-icon"), content = make(row, "div", "suggestion-content"), aux = make(row, "div", "suggestion-aux");
      if (value.type === "search") setIcon(make(icon, "span", "suggestion-flair-left"), "lucide-search");
      else if (value.type === "history" || value.type === "bookmark") this.view.environment.history.setIcon(make(icon, "span", "suggestion-flair-left"), value.url);
      if (value.type === "bookmark") setIcon(make(aux, "span", "suggestion-flair"), "lucide-bookmark");
      renderMatches(make(content, "div", "suggestion-title"), value.title, value.matches);
      if (value.type !== "search") renderMatches(make(content, "div", "suggestion-url"), value.url, value.matches, -(value.title.length + 1));
      row.addEventListener("mousemove", () => this.select(index));
      row.addEventListener("mousedown", event => { event.preventDefault(); this.choose(value); });
    });
    this.select(0);
    this.reposition();
    doc.addEventListener("scroll", this.reposition, { capture: true, passive: true });
    doc.defaultView?.addEventListener("resize", this.reposition);
  }
  private select(index: number): void {
    const rows = this.rootEl?.querySelectorAll<HTMLElement>(".suggestion-item") ?? [];
    if (!rows.length) return;
    this.selected = (index + rows.length) % rows.length;
    rows.forEach((row, at) => { row.classList.toggle("is-selected", at === this.selected); if (at === this.selected) row.scrollIntoView?.({ block: "nearest" }); });
  }
}

/** Web page tab: an address bar in the header and the page in a `<webview>`. */
export class WebViewerView extends ItemView {
  navigation = true;
  url = "";
  title = "";
  mode: "blank" | "webview" | "reader" | "error" = "blank";
  private webview!: WebviewElement;
  private errorView!: HTMLElement;
  private readerView!: HTMLElement;
  private searchContainerEl!: HTMLElement;
  private searchBar: { el: HTMLElement; input: HTMLInputElement; count: HTMLElement; matches: number; current: number } | null = null;
  private readerOwner: Component | null = null;
  private readerButton: HTMLElement | null = null;
  private readonly reloadEl: HTMLElement;
  private readonly reloadButtonEl: HTMLButtonElement;
  private readonly addressEl: HTMLInputElement;
  private readonly suggest: AddressSuggest;
  private faviconEl: HTMLElement | null = null;
  private faviconUrl: string | undefined;
  private mounted = false; private configured = false; private firstLoadFinished = false;
  private loadFirstPage: (() => void) | null = null;
  /** Address asked for before the web view was ready. */
  private pendingUrl = "";
  private pendingLoad: { url: string; title?: string; navigate?: boolean } | null = null;
  private readonly requestCommit = debounce(() => void this.commitPageLoad(), 0, true);
  /** @internal Replaces the title in the tab's header with the address bar. */
  readonly headerTitleEl: HTMLElement;
  readonly headerTitleClass = "webviewer-address-container";

  constructor(leaf: WorkspaceLeaf, readonly environment: WebViewerEnvironment) {
    super(leaf);
    const doc = this.contentEl.ownerDocument;
    this.headerTitleEl = doc.createElement("div"); this.headerTitleEl.className = "webviewer-address";
    this.addressEl = make(this.headerTitleEl, "input"); this.addressEl.type = "text"; this.addressEl.setAttribute("spellcheck", "false");
    this.suggest = new AddressSuggest(this, this.addressEl);
    environment.history.icons ??= { load: () => (this.app.loadLocalStorage(ICONS_KEY) ?? {}) as Record<string, string>, save: icons => this.app.saveLocalStorage(ICONS_KEY, icons) };
    this.reloadEl = doc.createElement("div"); this.reloadEl.className = "view-header-reload-button";
    this.reloadButtonEl = make(this.reloadEl, "button", "clickable-icon"); setIcon(this.reloadButtonEl, "rotate-cw");
    this.reloadButtonEl.addEventListener("click", () => { if (!this.webview) return; if (this.webview.isLoading()) { this.webview.stop(); this.showLoadingIndicator(false); } else this.webview.reload(); });
    let before = "";
    this.addressEl.addEventListener("focus", () => { doc.defaultView?.setTimeout(() => this.addressEl.select(), 100); before = this.addressEl.value; this.suggest.open(); });
    this.addressEl.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.addressEl.blur(); this.addressEl.value = before; }
      else if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); const value = this.addressEl.value; this.addressEl.blur(); void this.environment.settings().then(settings => this.navigate(resolveAddress(value, settings), true)); }
    });
  }
  getViewType() { return WEB_VIEW_TYPE; }
  getIcon() { return "globe-2"; }
  getDisplayText() { return this.title || t("plugins.web-viewer.label-new-web-viewer"); }
  getState() { return { ...super.getState(), url: this.url || this.pendingUrl, title: this.title, mode: this.mode }; }
  async setState(state: unknown) {
    const next = (state ?? {}) as { url?: unknown; title?: unknown; navigate?: unknown };
    if (typeof next.url !== "string" || !next.url || this.url === next.url) return;
    if (typeof next.title === "string" && next.title) this.title = next.title;
    this.navigate(next.url, next.navigate === true);
  }

  protected onOpen() {
    const content = this.contentEl, doc = content.ownerDocument;
    content.classList.add("webviewer-content");
    this.searchContainerEl = make(content, "div", "search-in-page");
    this.readerView = make(content, "div", "reader-mode-content"); this.readerView.style.display = "none";
    this.readerView.addEventListener("contextmenu", event => this.onReaderContextMenu(event));
    this.instantiateWebView();
    this.errorView = make(content, "div", "error-notice"); this.errorView.style.display = "none";
    make(this.errorView, "h1", "", t("plugins.web-viewer.label-fail-to-load")); make(this.errorView, "p", "", t("plugins.web-viewer.label-fail-to-load-desc"));
    this.readerButton = this.addAction("glasses", t("plugins.web-viewer.action-reader-view"), () => this.toggleReaderMode());
    // The header is drawn by the workspace; the reload button and the tab's site icon are placed into it once it exists.
    const decorate = () => this.decorateHeader();
    this.registerEvent(this.app.workspace.on("layout-change", () => doc.defaultView?.requestAnimationFrame(decorate)));
    doc.defaultView?.requestAnimationFrame(decorate);
    this.register(() => { this.suggest.close(); this.reloadEl.remove(); this.readerOwner?.unload(); });
  }
  protected onClose() { this.webview?.remove(); this.contentEl.classList.remove("webviewer-content"); this.contentEl.replaceChildren(); }

  private decorateHeader(): void {
    const container = this.headerTitleEl.parentElement, header = container?.parentElement;
    if (container && header) { header.classList.add("view-header-always-show"); if (this.reloadEl.nextElementSibling !== container) header.insertBefore(this.reloadEl, container); }
    this.placeFavicon();
  }
  /** The tab of this view, found by its position among its siblings. */
  private tabIconEl(): HTMLElement | null {
    const tabs = this.contentEl.closest(".workspace-tabs"), index = this.leaf.parent?.children.indexOf(this.leaf) ?? -1;
    return index < 0 ? null : tabs?.querySelectorAll<HTMLElement>(":scope > .workspace-tab-header-container .workspace-tab-header")[index]?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon") ?? null;
  }
  private placeFavicon(): void {
    const icon = this.tabIconEl();
    if (!icon || !this.faviconEl || this.faviconEl.parentElement === icon) return;
    icon.replaceChildren(this.faviconEl);
  }
  private setFavicon(icon: string | undefined): void {
    if (icon && this.faviconUrl === icon) return;
    this.faviconUrl = icon;
    if (this.faviconEl) this.faviconEl.replaceChildren(); else { this.faviconEl = this.contentEl.ownerDocument.createElement("div"); this.faviconEl.className = "webviewer-favicon-container"; }
    const page = this.webview.src;
    if (!page) return;
    this.environment.history.setIcon(this.faviconEl, page, icon);
    this.placeFavicon();
  }
  private static selectFavicon(icons: string[]): string | undefined {
    if (icons.length <= 1) return icons[0];
    let best = icons[0], size = 0;
    for (const icon of icons) { const match = icon.match(/(\d+)x\d+/); if (!match) continue; const width = Number.parseInt(match[1]); if (width === 32) return icon; if (width > size) { size = width; best = icon; } }
    return best;
  }

  // ---- The page ----

  private instantiateWebView(): void {
    const content = this.contentEl, doc = content.ownerDocument;
    this.webview?.remove();
    this.configured = false; this.mounted = false; this.firstLoadFinished = false;
    const webview = this.webview = createWebview(doc) as WebviewElement;
    webview.style.backgroundColor = "white";
    webview.setAttribute("allowpopups", "true"); webview.setAttribute("partition", webviewPartition(this.app)); webview.setAttribute("src", this.url && this.url !== "about:blank" ? this.url : BLANK_DOCUMENT);
    type NavigationEvent = Event & { isMainFrame?: boolean; url?: string; errorCode?: number; favicons?: string[]; title?: string; params?: ContextMenuParams; result?: { finalUpdate?: boolean; matches?: number; activeMatchOrdinal?: number } };
    const on = (name: string, handler: (event: NavigationEvent) => void) => webview.addEventListener(name, handler as EventListener);
    on("did-start-navigation", event => { if (event.isMainFrame) this.reportPageLoad(event.url, undefined, true); });
    on("did-redirect-navigation", event => { if (event.isMainFrame) this.reportPageLoad(event.url, undefined, false); });
    on("dom-ready", () => { this.mounted = true; const first = this.loadFirstPage; this.loadFirstPage = null; first?.(); this.requestCommit(); });
    on("did-stop-loading", () => this.showLoadingIndicator(false));
    on("did-finish-load", () => this.showLoadingIndicator(false));
    on("did-fail-load", event => { if (event.errorCode !== -3 && event.isMainFrame) { this.showLoadingIndicator(false); this.displayErrorView(); this.requestCommit(); } });
    on("did-navigate-in-page", () => this.requestCommit());
    on("page-favicon-updated", event => this.setFavicon(WebViewerView.selectFavicon(event.favicons ?? [])));
    on("page-title-updated", event => { this.title = event.title ?? ""; this.app.workspace.trigger("layout-change"); });
    on("context-menu", event => this.displayContextMenu(event));
    on("found-in-page", event => { const bar = this.searchBar; if (bar && event.result?.finalUpdate) { bar.matches = event.result.matches ?? 0; bar.current = event.result.activeMatchOrdinal ?? 0; bar.count.style.display = bar.input.value ? "" : "none"; bar.count.textContent = `${bar.current} / ${bar.matches}`; } });
    // A web view that moves to another window (a pop-out) is destroyed there and has to be made again.
    on("destroyed", () => { if (doc !== this.contentEl.ownerDocument) this.instantiateWebView(); });
    content.insertBefore(webview, this.errorView ?? null);
  }
  private reportPageLoad(url: string | undefined, title: string | undefined, navigate: boolean | undefined): void {
    if (!url) return;
    this.requestCommit.cancel();
    if (this.pendingLoad && Object.hasOwn(this.pendingLoad, "navigate")) navigate = this.pendingLoad.navigate;
    this.showLoadingIndicator(true);
    this.pendingLoad = { url, title, navigate };
  }
  private showLoadingIndicator(loading: boolean): void {
    if (this.contentEl.classList.contains("is-loading") === loading) return;
    setIcon(this.reloadButtonEl, loading ? "x" : "rotate-cw");
    this.contentEl.classList.toggle("is-loading", loading);
  }
  private async commitPageLoad(): Promise<void> {
    const load = this.pendingLoad;
    if (!load) return;
    this.pendingLoad = null;
    if (load.url === BLANK_DOCUMENT) return;
    if (load.navigate && this.firstLoadFinished) this.pushViewStackHistory(load.url); else this.firstLoadFinished = true;
    this.url = load.url; this.addressEl.value = load.url;
    this.title = load.title || this.webview.getTitle();
    if (this.title !== BLANK_DOCUMENT) this.environment.history.add(this.url, this.title);
    if (!this.configured) { this.configured = true; this.configureWebContents(); }
    if (this.mode === "reader") void this.displayReaderView();
    else void this.webview.executeJavaScript(`document.querySelectorAll('[target="_blank"]').forEach(el => { el.removeAttribute('target') })`).catch(() => undefined);
    this.app.workspace.trigger("layout-change"); this.app.workspace.requestSaveLayout();
  }
  /** Lets the app's hotkeys work while the page has the focus, and makes a click in the page activate its tab. */
  private configureWebContents(): void {
    try {
      const contents = electronRemote()?.webContents.fromId(this.webview.getWebContentsId());
      if (!contents) return;
      contents.noContextMenu = true;
      contents.on("before-input-event", ((_event: unknown, input: { type: string; code: string; key: string; shift: boolean; alt: boolean; control: boolean; meta: boolean; isAutoRepeat: boolean }) => {
        if (input.type !== "keyDown" || contents.isDestroyed()) return;
        const handled = this.app.keymap.handleKey(new KeyboardEvent("keydown", { code: input.code, key: input.key, shiftKey: input.shift, altKey: input.alt, ctrlKey: input.control, metaKey: input.meta, repeat: input.isAutoRepeat }));
        contents.setIgnoreMenuShortcuts(!!handled);
      }) as never);
      contents.on("input-event", ((_event: unknown, input: { type: string }) => { if (input.type === "mouseDown") this.app.workspace.setActiveLeaf(this.leaf); }) as never);
    } catch (error) { console.error(error); }
  }
  private pushViewStackHistory(next: string): void {
    const previous = (this.leaf.history.backHistory.at(-1)?.state.state as { url?: string } | undefined)?.url;
    if (!this.url || this.url === next || previous === this.url) return;
    this.leaf.recordHistory({ title: this.title, icon: "globe-2", state: { type: WEB_VIEW_TYPE, state: { url: this.url } }, eState: {} } as Parameters<WorkspaceLeaf["recordHistory"]>[0]);
  }
  navigate(url: string, navigate = false): void {
    if (!url) return;
    if (!this.mounted) { this.pendingUrl = url; this.loadFirstPage = () => this.navigate(url, navigate); return; }
    if (url !== BLANK_DOCUMENT) this.addressEl.value = url;
    if (url === "about:blank") { this.url = "about:blank"; this.displayBlank(); return; }
    if (!/^https?:\/\//.test(url)) return;
    this.reportPageLoad(url, undefined, navigate);
    this.webview.stop();
    void this.webview.loadURL(url).then(() => { if (this.mode !== "webview" && this.mode !== "reader") this.displayWebView(); }).catch(() => undefined);
  }

  // ---- What the tab shows ----

  private hideAll(): void {
    this.readerButton?.classList.remove("mod-webviewer"); this.closeSearch();
    this.webview.style.display = "none"; this.errorView.style.display = "none"; this.readerView.style.display = "none";
  }
  private displayErrorView(): void { this.hideAll(); this.mode = "error"; this.errorView.style.display = ""; }
  private displayWebView(): void { this.hideAll(); this.mode = "webview"; this.webview.style.display = ""; this.readerOwner?.unload(); this.readerOwner = null; this.app.workspace.requestSaveLayout(); }
  private displayBlank(): void {
    this.hideAll(); this.mode = "blank"; this.title = "";
    this.contentEl.ownerDocument.defaultView?.setTimeout(() => this.addressEl.focus(), 100);
    this.app.workspace.trigger("layout-change"); this.app.workspace.requestSaveLayout();
  }
  /** The page's article as Markdown, with a title usable as a file name. */
  private async getReaderModeContent(): Promise<{ md: string; title: string } | null> {
    type Article = { title?: unknown; siteName?: unknown; content?: unknown } | null;
    let page: Article;
    try {
      const script = await fetch(new URL("lib/readability.js", this.contentEl.ownerDocument.baseURI)).then(response => { if (!response.ok) throw new Error("Readability script unavailable"); return response.text(); });
      await this.webview.executeJavaScript(script);
    }
    catch { new Notice(t("plugins.web-viewer.msg-error-extracting-content")); return null; }
    try { page = await this.webview.executeJavaScript(EXTRACT_ARTICLE) as Article; }
    catch { new Notice(t("plugins.web-viewer.msg-error-finding-content")); return null; }
    if (!page || typeof page.content !== "string" || !page.content) { new Notice(t("plugins.web-viewer.msg-error-finding-content")); return null; }
    const rawTitle = page.title || page.siteName || t("plugins.file-explorer.label-untitled-file");
    if (typeof rawTitle !== "string") { new Notice(t("plugins.web-viewer.msg-error-finding-content")); return null; }
    const title = titleToFileName(rawTitle);
    try { return { md: htmlToMarkdown(sanitizeHTMLToDom(page.content)), title }; }
    catch (error) { console.error(error); new Notice(t("plugins.web-viewer.msg-error-extracting-content")); return null; }
  }
  private async displayReaderView(): Promise<void> {
    const content = await this.getReaderModeContent();
    if (!content) return;
    const doc = this.contentEl.ownerDocument;
    this.readerView.classList.toggle("is-readable-line-width", (this.app.editorOptions as { readableLineLength?: boolean }).readableLineLength !== false);
    this.readerOwner?.unload();
    const owner = this.readerOwner = new Component(); owner.load();
    this.readerView.replaceChildren();
    const preview = make(this.readerView, "div", "markdown-preview-view markdown-rendered"), sizer = make(preview, "div", "markdown-preview-sizer markdown-preview-section");
    const staging = doc.createElement("div");
    await MarkdownRenderer.render(this.app, content.md, staging, "", owner);
    const pusher = make(sizer, "div", "markdown-preview-pusher");
    Object.assign(pusher.style, { width: "1px", height: "0.1px", marginBottom: "0px" });
    for (const child of Array.from(staging.children)) {
      const section = make(sizer, "div", `el-${child.classList.contains("callout") ? "div" : child.tagName.toLowerCase()}`);
      section.append(child);
    }
    for (const strike of sizer.querySelectorAll("s")) { const del = doc.createElement("del"); del.append(...Array.from(strike.childNodes)); strike.replaceWith(del); }
    for (const item of sizer.querySelectorAll("li")) {
      const bullet = item.querySelector(":scope > .list-bullet"), indicator = item.querySelector(":scope > .list-collapse-indicator");
      if (bullet && indicator) item.insertBefore(bullet, indicator);
    }
    sizer.querySelectorAll(".copy-code-button").forEach(button => button.remove());
    const openImage = (event: MouseEvent) => {
      const target = event.composedPath()[0] as HTMLImageElement;
      if (!event.defaultPrevented && target?.nodeName === "IMG") {
        new ImageLightbox(Array.from(sizer.querySelectorAll("img")), target);
      }
    };
    owner.registerDomEvent(sizer, "click", openImage);
    owner.registerDomEvent(sizer, "contextmenu", openImage);
    // Links in the article load in this tab rather than leaving the app.
    owner.registerDomEvent(sizer, "click", event => {
      const link = (event.target as Element).closest?.("a"), href = link?.getAttribute("href") ?? "";
      if (/^https?:\/\//.test(href)) { event.preventDefault(); event.stopPropagation(); this.navigate(href, true); }
    }, true);
    if (owner !== this.readerOwner || doc !== this.contentEl.ownerDocument) return;
    this.hideAll(); this.readerButton?.classList.add("mod-webviewer"); this.readerView.style.display = ""; this.mode = "reader";
    this.app.workspace.requestSaveLayout();
  }
  toggleReaderMode(): void { if (this.mode === "reader") this.displayWebView(); else void this.displayReaderView(); }
  focusAddressBar(): void { this.addressEl.ownerDocument.defaultView?.setTimeout(() => this.addressEl.focus(), 50); }
  zoomIn(): void { const factor = this.webview.getZoomFactor(); if (factor < 3) this.webview.setZoomFactor(factor + 0.1); }
  zoomOut(): void { const factor = this.webview.getZoomFactor(); if (factor > 0.5) this.webview.setZoomFactor(factor - 0.1); }
  zoomReset(): void { this.webview.setZoomFactor(1); }
  /** Used by the app shell's zoom commands: a positive or negative step, or null to reset. */
  zoom(delta: number | null): void { if (delta === null) this.zoomReset(); else if (delta > 0) this.zoomIn(); else this.zoomOut(); }

  /** Saves the page's article as a note in the configured folder; resolves to the note. */
  async saveAsMarkdown(): Promise<TFile | null> {
    const content = await this.getReaderModeContent();
    if (!content) return null;
    const folder = ((await this.environment.settings()).markdownPath || "").replace(/^\/+|\/+$/g, "");
    return this.app.vault.create(this.app.vault.getAvailablePath((folder ? folder + "/" : "") + content.title, "md"), content.md);
  }
  async saveToVault(): Promise<void> {
    try { const file = await this.saveAsMarkdown(); if (file) await this.app.workspace.getLeaf("tab").openFile(file); }
    catch (error) { console.error(error); new Notice(t("plugins.web-viewer.msg-error-extracting-content")); }
  }

  // ---- Find in page ----

  showSearch(): void {
    if (this.mode !== "webview") return;
    if (!this.searchBar) {
      const el = this.contentEl.ownerDocument.createElement("div"); el.className = "document-search-container";
      const search = make(el, "div", "document-search"), inputContainer = make(search, "div", "search-input-container document-search-input"), input = make(inputContainer, "input");
      input.type = "text"; input.placeholder = t("editor.search.placeholder-find");
      const count = make(inputContainer, "div", "document-search-count"), buttons = make(search, "div", "document-search-buttons");
      const bar = this.searchBar = { el, input, count, matches: 0, current: 0 };
      const find = (forward: boolean, next: boolean) => { if (input.value) this.webview.findInPage(input.value, { forward, findNext: next }); else this.webview.stopFindInPage("clearSelection"); };
      const iconButton = (parent: HTMLElement, tag: "button" | "div", cls: string, icon: string, label: string, onClick: () => void) => {
        const button = make(parent, tag, `clickable-icon ${cls}`); setIcon(button, icon); setTooltip(button, label, { placement: "top" });
        button.addEventListener("mousedown", event => event.preventDefault()); button.addEventListener("click", onClick);
      };
      iconButton(buttons, "button", "document-search-button", "lucide-arrow-up", `${t("editor.search.label-previous")}\n${formatHotkey({ modifiers: ["Shift"], key: "F3" })}`, () => find(false, false));
      iconButton(buttons, "button", "document-search-button", "lucide-arrow-down", `${t("editor.search.label-next")}\n${formatHotkey({ modifiers: [], key: "F3" })}`, () => find(true, bar.current === bar.matches));
      iconButton(search, "div", "document-search-close-button", "lucide-x", t("editor.search.label-exit-search"), () => this.closeSearch());
      input.addEventListener("input", () => find(true, true));
      input.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); this.closeSearch(); }
        else if (event.key === "Enter" || event.key === "F3") { event.preventDefault(); find(!event.shiftKey, event.shiftKey ? false : bar.current === bar.matches); }
        event.stopPropagation();
      });
    }
    this.searchContainerEl.prepend(this.searchBar.el);
    this.searchBar.input.focus(); this.searchBar.input.select();
    if (this.searchBar.input.value) this.webview.findInPage(this.searchBar.input.value, { findNext: true });
  }
  private closeSearch(): void {
    if (!this.searchBar?.el.isConnected) return;
    try { this.webview.stopFindInPage("clearSelection"); } catch { /* the page is gone */ }
    this.searchBar.el.remove();
  }

  // ---- Menus ----

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (!this.webview) return;
    let factor = 1; try { factor = this.webview.getZoomFactor(); } catch { /* not attached yet */ }
    menu.addItem(item => item.setTitle(t("plugins.web-viewer.action-save-to-vault")).setIcon("lucide-file-down").onClick(() => void this.saveToVault()));
    menu.addItem(item => item.setSection("action").setTitle(t("interface.menu.find")).setIcon("lucide-file-search").onClick(() => this.showSearch()));
    menu.addItem(item => item.setSection("action").setTitle(t("plugins.web-viewer.action-open-default-browser")).setIcon("lucide-globe-2").onClick(() => openExternally(this.url)));
    menu.addItem(item => item.setTitle(t("commands.zoom-in")).setIcon("zoom-in").setSection("zoom").setDisabled(factor >= 3).onClick(() => this.zoomIn()));
    menu.addItem(item => item.setTitle(t("commands.reset-zoom")).setIcon("rotate-cw").setSection("zoom").setDisabled(factor === 1).onClick(() => this.zoomReset()));
    menu.addItem(item => item.setTitle(t("commands.zoom-out")).setIcon("zoom-out").setSection("zoom").setDisabled(factor <= 0.5).onClick(() => this.zoomOut()));
  }
  private openLink(url: string, target?: PaneType): void { void this.app.workspace.getLeaf(target ?? false).setViewState({ type: WEB_VIEW_TYPE, active: true, state: { url, navigate: true } }); }
  private itemsForLink(url: string): MenuTemplateItem[] {
    const items: MenuTemplateItem[] = [
      { label: t("plugins.web-viewer.action-open-link"), click: () => this.openLink(url) },
      { label: t("plugins.web-viewer.action-open-link-new-tab"), click: () => this.openLink(url, "tab") },
      { label: t("plugins.web-viewer.action-open-link-new-split"), click: () => this.openLink(url, "split") },
      { label: t("plugins.web-viewer.action-open-link-new-window"), click: () => this.openLink(url, "window") },
      { label: t("plugins.web-viewer.action-open-link-default-browser"), click: () => openExternally(url) },
      { type: "separator" },
      { label: t("plugins.web-viewer.action-copy-link-address"), click: () => void navigator.clipboard.writeText(url) },
    ];
    if (bookmarksEnabled(this.app)) items.push({ label: t("plugins.web-viewer.action-bookmark-link"), click: () => bookmark(this.app, url) });
    return items;
  }
  private itemsForSelection(text: string, editable?: boolean): MenuTemplateItem[] {
    const items: MenuTemplateItem[] = [
      { label: t("plugins.web-viewer.action-search-for-query", { query: shorten(text, 15) }), click: () => void this.environment.settings().then(settings => this.openLink(searchEngineUrl(text, settings), "tab")) },
      { label: t("plugins.web-viewer.action-extract-selection"), click: () => void (async () => {
        const path = this.app.vault.getAvailablePath(titleToFileName(this.title) || t("plugins.file-explorer.label-untitled-file"), "md");
        await this.app.vault.create(path, text);
        await this.app.workspace.openLinkText(path, "", true);
      })().catch(error => { console.error(error); new Notice(t("obsen.web-viewer.action-error")); }) },
      { type: "separator" },
      { label: t("plugins.web-viewer.action-copy-selection"), accelerator: "CmdOrCtrl+C", role: "copy" },
    ];
    if (editable) items.push({ label: t("plugins.web-viewer.action-cut"), accelerator: "CmdOrCtrl+X", role: "cut" }, { label: t("plugins.web-viewer.action-paste"), accelerator: "CmdOrCtrl+V", role: "paste" },
      { label: t("plugins.web-viewer.action-delete"), accelerator: "Delete", role: "delete" }, { label: t("plugins.web-viewer.action-select-all"), accelerator: "CmdOrCtrl+A", role: "selectAll" });
    return items;
  }
  private itemsForImage(src: string): MenuTemplateItem[] {
    const download = async () => { const response = await fetch(src); return { buffer: await response.arrayBuffer(), type: response.headers.get("content-type") ?? "" }; };
    return [
      { label: t("plugins.web-viewer.action-save-image"), click: () => void (async () => {
        const { buffer, type } = await download();
        let name = decodeURIComponent(src.split(/[?#]/)[0].split("/").at(-1) ?? "");
        const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp" } as Record<string, string>)[type.split(";")[0]] ?? (name.includes(".") ? name.split(".").at(-1)! : "png");
        name = (titleToFileName(name.replace(/\.[^.]*$/, "")) || "image") + "." + extension;
        const target = await this.app.fileManager.getAvailablePathForAttachment(name);
        await this.app.vault.createBinary(target, buffer);
        new Notice(t("obsen.web-viewer.stored-as", { path: target }));
      })().catch(error => { console.error(error); new Notice(t("obsen.web-viewer.action-error")); }) },
      { label: t("interface.menu.copy-image"), click: () => void (async () => { const remote = electronRemote(), { buffer } = await download(); if (remote) remote.clipboard.writeImage(remote.nativeImage.createFromBuffer(Buffer.from(buffer))); })().catch(error => { console.error(error); new Notice(t("obsen.web-viewer.action-error")); }) },
      { label: t("plugins.web-viewer.action-copy-image-link"), click: () => void navigator.clipboard.writeText(src) },
    ];
  }
  private itemsForPage(selectAll: MenuTemplateItem): MenuTemplateItem[] {
    const items: MenuTemplateItem[] = [];
    if (bookmarksEnabled(this.app)) items.push({ label: t("plugins.web-viewer.action-bookmark-page"), click: () => bookmark(this.app, this.url, this.title) });
    items.push({ label: t("plugins.web-viewer.action-open-default-browser"), click: () => openExternally(this.url) }, selectAll);
    return items;
  }
  private popup(items: MenuTemplateItem[]): void {
    const remote = electronRemote();
    if (!remote || !items.length) return;
    const win = this.contentEl.ownerDocument.defaultView as (Window & { require?: (name: string) => { remote?: Remote } }) | null;
    const ownerRemote = win?.require?.("electron").remote ?? remote;
    remote.Menu.buildFromTemplate(items).popup({ window: ownerRemote.getCurrentWindow() });
  }
  private displayContextMenu(event: Event & { params?: ContextMenuParams }): void {
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const params = event.params ?? {}, items: MenuTemplateItem[] = [], separate = () => { if (items.length) items.push({ type: "separator" }); };
    if (params.linkURL) items.push(...this.itemsForLink(params.linkURL));
    if (params.selectionText) { separate(); items.push(...this.itemsForSelection(params.selectionText, params.isEditable)); }
    else if (params.isEditable) { separate(); items.push({ label: t("plugins.web-viewer.action-paste"), role: "paste" }, { label: t("plugins.web-viewer.action-select-all"), role: "selectAll" }); }
    if (params.mediaType === "image" && params.srcURL) { separate(); items.push(...this.itemsForImage(params.srcURL)); }
    if (!params.selectionText && (params.mediaType ?? "none") === "none" && !params.linkURL) {
      separate();
      const history = this.leaf.history;
      items.push({ label: t("plugins.web-viewer.action-backward"), enabled: history.backHistory.length > 0, click: () => void history.back() }, { label: t("plugins.web-viewer.action-forward"), enabled: history.forwardHistory.length > 0, click: () => void history.forward() },
        { label: t("plugins.web-viewer.action-reload"), click: () => this.webview.reload() }, ...this.itemsForPage({ label: t("plugins.web-viewer.action-select-all"), accelerator: "CmdOrCtrl+A", role: "selectAll" }));
    }
    this.popup(items);
  }
  private onReaderContextMenu(event: MouseEvent): void {
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const target = (event.composedPath()[0] ?? event.target) as HTMLElement, items: MenuTemplateItem[] = [];
    const link = target.nodeName === "A" ? target : null, image = target.nodeName === "IMG" ? target : null;
    if (link?.getAttribute("href")) items.push(...this.itemsForLink(link.getAttribute("href")!));
    else if (image?.getAttribute("src")) items.push(...this.itemsForImage(image.getAttribute("src")!));
    const win = target.ownerDocument.defaultView!, selection = win.getSelection()?.toString();
    if (selection) { if (items.length) items.push({ type: "separator" }); items.push(...this.itemsForSelection(selection)); }
    if (!items.length) items.push(...this.itemsForPage({ label: t("plugins.web-viewer.action-select-all"), accelerator: "CmdOrCtrl+A", click: () => {
      const range = target.ownerDocument.createRange(); range.selectNodeContents(this.readerView);
      const current = win.getSelection(); current?.removeAllRanges(); current?.addRange(range);
    } }));
    this.popup(items);
  }
}

/** Sidebar list of visited pages. */
export class WebHistoryView extends ItemView {
  navigation = false;
  private readonly requestUpdate = debounce(() => this.update(), 100);
  constructor(leaf: WorkspaceLeaf, private readonly history: WebHistory) { super(leaf); }
  getViewType() { return WEB_HISTORY_VIEW_TYPE; }
  getIcon() { return "lucide-clock"; }
  getDisplayText() { return t("plugins.web-viewer.history-name"); }
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    menu.addItem(item => item.setSection("action").setTitle(t("plugins.web-viewer.action-clear-history")).setIcon("lucide-eraser").onClick(() => this.history.clear()));
  }
  protected onOpen() {
    this.update(); this.register(this.history.onChange(() => this.requestUpdate()));
    this.registerEvent(this.app.workspace.on("webviewer:update-history", () => this.requestUpdate()));
  }
  protected onClose() { this.requestUpdate.cancel(); this.contentEl.replaceChildren(); }
  private update(): void {
    const doc = this.contentEl.ownerDocument, list = doc.createDocumentFragment() as unknown as HTMLElement;
    for (const entry of this.history.items()) {
      const row = doc.createElement("div"); row.className = "tree-item"; list.append(row);
      const self = make(row, "div", "tree-item-self is-clickable"), icon = make(self, "div", "tree-item-icon");
      this.history.setIcon(icon, entry.url);
      make(make(self, "div", "tree-item-inner"), "div", "tree-item-inner-text webviewer-history-view-item", entry.title || entry.url);
      make(row, "div", "tree-item-children");
      self.addEventListener("click", event => void this.app.workspace.getLeaf(Keymap.isModEvent(event)).setViewState({ type: WEB_VIEW_TYPE, active: true, state: { url: entry.url, title: entry.title, navigate: true } }));
      self.addEventListener("auxclick", event => { if (event.button === 1) void this.app.workspace.getLeaf("tab").setViewState({ type: WEB_VIEW_TYPE, active: true, state: { url: entry.url, title: entry.title, navigate: true } }); });
      self.addEventListener("contextmenu", event => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const menu = new Menu();
        menu.addItem(item => item.setTitle(t("plugins.web-viewer.action-copy-u-r-l")).setIcon("lucide-copy").setSection("action").onClick(() => void navigator.clipboard.writeText(entry.url)));
        menu.addItem(item => item.setTitle(t("plugins.web-viewer.action-remove-from-history")).setIcon("lucide-trash-2").setSection("danger").setWarning(true).onClick(() => this.history.remove(entry)));
        menu.showAtMouseEvent(event);
      });
    }
    this.contentEl.replaceChildren(list);
  }
}

export { HISTORY_KEY, ICONS_KEY };
