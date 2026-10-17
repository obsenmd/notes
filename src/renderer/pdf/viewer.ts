/*
 * The PDF viewer shared by the PDF view and PDF embeds: toolbar, page viewer, sidebar, find bar and
 * password prompt, with the DOM the reference stylesheet expects (`.pdf-toolbar`, `.pdf-container`, …).
 *
 * The reference drives a fork of pdf.js's viewer application (`createObsidianPDFViewer`). Here the
 * published pdf.js page viewer (`PDFViewer`, `PDFLinkService`, `PDFFindController`) is wrapped by
 * `PdfViewerApp`, which reproduces the parts of that application the reference uses: opening and closing
 * documents, the initial view, the per-document view history, zoom, and the event wiring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { t } from "../../i18n";
import { loadPdfJs, loadPdfJsViewer, pdfJsBaseUrl, pdfJsDocumentOptions, type PdfJsLibrary, type PdfJsViewer } from "../../compat/pdf";
import type { App } from "../../compat/plugin";
import { Menu } from "../../compat/ui";
import { setIcon, setTooltip } from "../../compat/utilities";
import type { TFile } from "../../compat/vault";
import { formatHotkey } from "../hotkeys";
import { PdfOutlineViewer, PdfSidebar, PdfThumbnailViewer, RenderingStates, SIDEBAR_MIN_WIDTH, SidebarView, type PdfEventBus } from "./sidebar";

const THEMED_KEY = "pdfjs-is-themed", SEARCH_SETTINGS_KEY = "pdfjs-search-settings";
const DEFAULT_SCALE_VALUE = "auto", DEFAULT_SCALE = 1, MIN_SCALE = 0.1, MAX_SCALE = 10;
const DEFAULT_ZOOM_VALUE = "page-width", ZOOM_DELAY = 400, MAX_CANVAS_PIXELS = 16777216;
const FORCE_PAGES_LOADED_TIMEOUT = 10000;

export interface PdfViewerOptions {
  removePageBorders?: boolean;
  isEmbed?: boolean;
  height?: number | "page" | "auto";
  initDelay?: number;
  displayMode?: boolean;
}

interface PdfDom { containerEl: HTMLElement; contentEl: HTMLElement; outlineViewEl: HTMLElement; pdfContainerEl: HTMLElement; sidebarContainerEl: HTMLElement; thumbnailViewEl: HTMLElement; viewerContainerEl: HTMLDivElement; viewerEl: HTMLDivElement }
type SubpathHighlight = { type: "annotation"; page: number; id: string } | { type: "text"; page: number; range: [[number, number], [number, number]] };

const toInt = (value: string | null | undefined): number | null => { if (!value) return null; const parsed = parseInt(value); return Number.isNaN(parsed) ? null : parsed; };
const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
const isEditable = (node: EventTarget | null): boolean => node instanceof HTMLElement && (node.nodeName === "INPUT" || node.contentEditable === "true");

/** Scrolls so that `element` sits `offset` pixels below the top of its scrolling container. */
function scrollIntoContainer(element: HTMLElement, offset: number, scrollMatches = false): void {
  let parent = element.offsetParent as HTMLElement | null;
  if (!parent) return;
  let top = element.offsetTop;
  while ((parent.clientHeight === parent.scrollHeight && parent.clientWidth === parent.scrollWidth)
    || (scrollMatches && (parent.classList.contains("markedContent") || parent.ownerDocument.defaultView?.getComputedStyle(parent).overflow === "hidden"))) {
    top += parent.offsetTop;
    parent = parent.offsetParent as HTMLElement | null;
    if (!parent) return;
  }
  parent.scrollTop = top + offset;
}

/** The last view of each of the twenty most recent documents, as pdf.js keeps it (`pdfjs.history`). */
class ViewHistory {
  private readonly database: { files: Array<Record<string, unknown>> };
  private readonly file: Record<string, unknown>;
  constructor(fingerprint: string) {
    let database: { files?: Array<Record<string, unknown>> } = {};
    try { database = JSON.parse(localStorage.getItem("pdfjs.history") || "{}"); } catch { /* A damaged history starts over. */ }
    if (!Array.isArray(database.files)) database.files = [];
    let index = database.files.findIndex(entry => entry.fingerprint === fingerprint);
    if (index === -1) {
      if (database.files.length >= 20) database.files.shift();
      index = database.files.push({ fingerprint }) - 1;
    }
    this.file = database.files[index];
    this.database = database as { files: Array<Record<string, unknown>> };
  }
  private write(): void { try { localStorage.setItem("pdfjs.history", JSON.stringify(this.database)); } catch { /* Storage may be unavailable. */ } }
  set(name: string, value: unknown): void { this.file[name] = value; this.write(); }
  setMultiple(values: Record<string, unknown>): void { Object.assign(this.file, values); this.write(); }
  getMultiple<T extends Record<string, unknown>>(defaults: T): T {
    const values: Record<string, unknown> = { ...defaults };
    for (const name of Object.keys(defaults)) if (this.file[name] !== undefined) values[name] = this.file[name];
    return values as T;
  }
}

/** The strings pdf.js asks its localisation service for; the reference answers from its own `pdf.*` copy. */
class PdfL10n {
  getLanguage(): string { return document.documentElement.lang || "en"; }
  getDirection(): string { return "ltr"; }
  async get(): Promise<string> { return ""; }
  async translate(): Promise<void> {}
  async translateOnceReady(): Promise<void> {}
  pause(): void {}
  resume(): void {}
  async destroy(): Promise<void> {}
}

/** The toolbar above the pages. */
export class PdfToolbar {
  readonly toolbarEl: HTMLElement;
  toolbarLeftEl!: HTMLElement;
  toolbarRightEl!: HTMLElement;
  private sidebarToggleEl!: HTMLElement;
  private zoomOutEl!: HTMLElement;
  private zoomInEl!: HTMLElement;
  pageInputEl!: HTMLInputElement;
  private pageNumberEl!: HTMLElement;
  private pageNumber = 0;
  private pageLabel: string | null = null;
  private hasPageLabels = false;
  private pagesCount = 0;
  pageScaleValue: string = DEFAULT_SCALE_VALUE;
  pageScale = DEFAULT_SCALE;

  constructor(app: App, containerEl: HTMLElement, child: PdfViewerChild) {
    const viewer = child.pdfViewer!, eventBus = viewer.eventBus;
    this.toolbarEl = containerEl.createDiv({ cls: "pdf-toolbar", prepend: true }, toolbar => {
      toolbar.createDiv("pdf-toolbar-left", left => {
        this.toolbarLeftEl = left;
        this.sidebarToggleEl = left.createDiv("clickable-icon", el => {
          setTooltip(el, t("pdf.action-toggle-sidebar")); setIcon(el, "lucide-layout-list");
          el.addEventListener("click", () => eventBus.dispatch("togglesidebar", { source: this }));
        });
        left.createDiv("clickable-icon", el => {
          setIcon(el, "lucide-chevron-down"); setTooltip(el, t("pdf.tooltip-sidebar-options"));
          let open = false;
          el.addEventListener("click", () => {
            if (open) return;
            const sidebar = viewer.pdfSidebar, outline = viewer.pdfOutlineViewer.outline;
            const thumbnails = sidebar.isOpen && sidebar.active === SidebarView.THUMBS, contents = sidebar.isOpen && sidebar.active === SidebarView.OUTLINE;
            const menu = new Menu().addSections(["view", "action"])
              .addItem(item => item.setSection("view").setIcon("lucide-layout-grid").setTitle(t("pdf.action-show-thumbnails")).setChecked(thumbnails).onClick(() => sidebar.switchView(thumbnails ? SidebarView.NONE : SidebarView.THUMBS, true)))
              .addItem(item => item.setSection("view").setIcon("lucide-list").setTitle(t("pdf.action-show-outline")).setChecked(contents).setDisabled(!outline).onClick(() => sidebar.switchView(contents ? SidebarView.NONE : SidebarView.OUTLINE, true)))
              .addItem(item => item.setSection("action").setIcon("lucide-list-start").setTitle(t("pdf.action-reveal-in-outline")).setDisabled(!outline).onClick(() => { if (!contents) sidebar.switchView(SidebarView.OUTLINE, true); eventBus.dispatch("currentoutlineitem", { source: this }); }));
            menu.onHide(() => { open = false; });
            const box = el.getBoundingClientRect();
            menu.setParentElement(el).showAtPosition({ x: box.x, y: box.bottom, width: box.width, overlap: true, left: false }, el.ownerDocument);
            open = true;
          });
        });
        left.createDiv("pdf-toolbar-spacer");
        this.zoomOutEl = left.createDiv("clickable-icon", el => {
          setTooltip(el, t("commands.zoom-out")); setIcon(el, "lucide-zoom-out");
          el.addEventListener("click", () => eventBus.dispatch("zoomout", { source: this }));
        });
        left.createDiv("pdf-toolbar-divider");
        this.zoomInEl = left.createDiv("clickable-icon", el => {
          setTooltip(el, t("commands.zoom-in")); setIcon(el, "lucide-zoom-in");
          el.addEventListener("click", () => eventBus.dispatch("zoomin", { source: this }));
        });
        left.createDiv("clickable-icon", el => {
          setIcon(el, "lucide-chevron-down"); setTooltip(el, t("pdf.tooltip-display-options"));
          let open = false;
          el.addEventListener("click", () => {
            if (open) return;
            const scale = viewer.pdfViewer.currentScaleValue, spread = viewer.pdfViewer.spreadMode, themed = app.loadLocalStorage(THEMED_KEY);
            const spreadItem = (mode: number, icon: string, title: string) => (item: import("../../compat/ui").MenuItem) => item.setSection("spread").setIcon(icon).setTitle(title).setChecked(spread === mode).onClick(() => eventBus.dispatch("switchspreadmode", { source: this, mode }));
            const menu = new Menu().addSections(["zoom", "spread", "appearance"])
              .addItem(item => item.setSection("zoom").setIcon("lucide-move-horizontal").setTitle(t("pdf.action-fit-width")).setChecked(scale === "page-width").onClick(() => eventBus.dispatch("scalechanged", { source: this, value: "page-width" })))
              .addItem(item => item.setSection("zoom").setIcon("lucide-move-vertical").setTitle(t("pdf.action-fit-height")).setChecked(scale === "page-height").onClick(() => eventBus.dispatch("scalechanged", { source: this, value: "page-height" })))
              .addItem(spreadItem(0, "lucide-rectangle-vertical", t("pdf.label-spread-single")))
              .addItem(spreadItem(1, "rectangle-vertical-double", t("pdf.label-spread-odd")))
              .addItem(spreadItem(2, "rectangle-vertical-double", t("pdf.label-spread-even")))
              .addItem(item => item.setSection("appearance").setIcon("lucide-palette").setTitle(t("pdf.label-adapt-to-theme")).setChecked(!!themed).onClick(() => { app.saveLocalStorage(THEMED_KEY, themed ? null : "true"); child.onCSSChange(); }));
            menu.onHide(() => { open = false; });
            const box = el.getBoundingClientRect();
            menu.setParentElement(el).showAtPosition({ x: box.x, y: box.bottom, width: box.width, overlap: true, left: false }, el.ownerDocument);
            open = true;
          });
        });
        left.createDiv("pdf-toolbar-spacer");
        this.pageInputEl = left.createEl("input", { cls: "pdf-page-input" }, el => {
          el.addEventListener("click", () => el.select());
          el.addEventListener("change", () => eventBus.dispatch("pagenumberchanged", { source: this, value: el.value }));
        });
        this.pageNumberEl = left.createSpan("pdf-page-numbers");
      });
      toolbar.createDiv("pdf-toolbar-right", right => { this.toolbarRightEl = right; });
    });
    eventBus._on("sidebarviewchanged", (event: { view: number }) => { this.sidebarToggleEl.toggleClass("is-active", event.view > 0); });
    this.reset();
  }

  setPageNumber(pageNumber: number, pageLabel: string | null): void { this.pageNumber = pageNumber; this.pageLabel = pageLabel; this.updateUIState(false); }
  setPagesCount(pagesCount: number, hasPageLabels: boolean): void { this.pagesCount = pagesCount; this.hasPageLabels = hasPageLabels; this.updateUIState(true); }
  setPageScale(value: string | undefined, scale: number): void { this.pageScaleValue = (value || scale).toString(); this.pageScale = scale; this.updateUIState(false); }

  reset(): void {
    this.pageNumber = 0; this.pageLabel = null; this.hasPageLabels = false; this.pagesCount = 0;
    this.pageScaleValue = DEFAULT_SCALE_VALUE; this.pageScale = DEFAULT_SCALE;
    this.updateUIState(true);
    this.updateLoadingIndicatorState();
  }

  private updateUIState(resetPageCount: boolean): void {
    const { pagesCount, pageNumber, pageScale, pageInputEl, pageNumberEl } = this;
    if (resetPageCount) {
      if (this.hasPageLabels) pageInputEl.type = "text";
      else { pageInputEl.type = "number"; pageNumberEl.textContent = t("pdf.label-of-pages", { count: pagesCount }); }
      pageInputEl.max = pagesCount.toString();
    }
    if (this.hasPageLabels) { pageInputEl.value = this.pageLabel ?? ""; pageNumberEl.textContent = t("pdf.label-page-of-pages", { current: pageNumber, count: pagesCount }); }
    else pageInputEl.value = pageNumber.toString();
    this.zoomOutEl.toggleClass("mod-disabled", pageScale <= MIN_SCALE);
    this.zoomInEl.toggleClass("mod-disabled", pageScale >= MAX_SCALE);
  }

  updateLoadingIndicatorState(loading = false): void { this.pageInputEl.toggleClass("mod-page-loading", loading); }
}

interface SearchSettings { highlightAll: boolean; caseSensitive: boolean; matchDiacritics: boolean; entireWord: boolean }

/** The find bar that drops over the pages, with its settings popover. */
export class PdfFindBar {
  opened = false;
  private searchSettings: SearchSettings = { highlightAll: false, caseSensitive: false, matchDiacritics: false, entireWord: false };
  private readonly barEl: HTMLElement;
  private readonly settingsEl: HTMLElement;
  private settingsToggleEl!: HTMLElement;
  private findResultsCountEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private inputContainerEl!: HTMLElement;
  private timer = 0;
  private readonly clickOutsideHandler = (event: MouseEvent) => {
    const target = event.target as Node;
    if (target === this.settingsEl || target === this.settingsToggleEl || this.settingsEl.contains(target)) return;
    this.toggleSettings(false);
  };

  constructor(private readonly app: App, private readonly containerEl: HTMLElement, private readonly eventBus: PdfEventBus, private readonly findState: () => { PENDING: number; NOT_FOUND: number }) {
    const stored = app.loadLocalStorage(SEARCH_SETTINGS_KEY);
    if (stored && typeof stored === "object") this.searchSettings = stored as SearchSettings;
    const settings = this.searchSettings;
    const bar = this.barEl = containerEl.createDiv("pdf-findbar pdf-toolbar mod-hidden");
    bar.createDiv("pdf-search-wrapper", wrapper => {
      wrapper.createDiv({ cls: "pdf-findbar-message", attr: { "aria-live": "polite" } }, message => { this.findResultsCountEl = message.createSpan("pdf-toolbar-label pdf-find-results-count"); });
      const container = this.inputContainerEl = wrapper.createDiv("search-input-container global-search-input-container");
      const input = this.inputEl = container.createEl("input", { type: "search", placeholder: t("plugins.search.prompt-start-search"), attr: { enterkeyhint: "search", spellcheck: "false" } });
      const clear = container.createDiv("search-input-clear-button");
      setTooltip(clear, t("plugins.search.tooltip-clear-search"));
      clear.addEventListener("click", () => { input.value = ""; input.focus(); this.dispatchEvent(""); });
      container.createDiv("input-right-decorator clickable-icon", el => {
        setTooltip(el, t("plugins.search.label-match-case")); setIcon(el, "uppercase-lowercase-a");
        el.addEventListener("click", () => { settings.caseSensitive = !settings.caseSensitive; this.saveSettings(); this.dispatchEvent("casesensitivitychange"); el.toggleClass("is-active", settings.caseSensitive); });
        el.toggleClass("is-active", settings.caseSensitive);
      });
      input.addEventListener("input", () => { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.dispatchEvent(""), 250); });
      input.addEventListener("keypress", event => { if (!event.isComposing && event.key === "Enter") this.dispatchEvent("again", event.shiftKey); });
      wrapper.createEl("button", { cls: "pdf-toolbar-button clickable-icon" }, el => {
        setIcon(el, "lucide-arrow-up"); setTooltip(el, formatHotkey({ modifiers: ["Shift"], key: "F3" }), { placement: "top" });
        el.addEventListener("click", () => this.dispatchEvent("again", true));
      });
      wrapper.createEl("button", { cls: "pdf-toolbar-button clickable-icon" }, el => {
        setIcon(el, "lucide-arrow-down"); setTooltip(el, formatHotkey({ modifiers: [], key: "F3" }), { placement: "top" });
        el.addEventListener("click", () => this.dispatchEvent("again", false));
      });
      wrapper.createDiv("clickable-icon pdf-findbar-settings-btn", el => {
        setTooltip(el, t("plugins.search.label-toggle-search-settings")); setIcon(el, "lucide-sliders-horizontal");
        this.settingsToggleEl = el;
        el.addEventListener("click", () => this.toggleSettings());
      });
      wrapper.createDiv("pdf-toolbar-divider");
      wrapper.createDiv("clickable-icon", el => {
        setTooltip(el, t("interface.empty-state.close")); setIcon(el, "lucide-x");
        el.addEventListener("click", () => this.close());
      });
    });
    const doc = containerEl.ownerDocument;
    this.settingsEl = doc.createElement("div");
    this.settingsEl.className = "pdf-findbar-settings";
    const toggle = (name: string, key: "highlightAll" | "matchDiacritics" | "entireWord", event: string) => {
      const row = this.settingsEl.createDiv({ cls: "setting-item mod-toggle", attr: { tabindex: -1 } });
      const info = row.createDiv("setting-item-info");
      info.createDiv({ cls: "setting-item-name", text: name });
      info.createDiv("setting-item-description");
      const label = row.createDiv("setting-item-control").createEl("label", { cls: "checkbox-container mod-small", attr: { tabindex: 0 } });
      const input = label.createEl("input", { type: "checkbox", attr: { tabindex: -1 } });
      const show = () => { label.toggleClass("is-enabled", settings[key]); input.checked = settings[key]; };
      show();
      label.addEventListener("click", click => { click.preventDefault(); settings[key] = !settings[key]; show(); this.saveSettings(); this.dispatchEvent(event); });
    };
    toggle(t("pdf.action-highlight-all"), "highlightAll", "highlightallchange");
    toggle(t("pdf.action-match-diacritics"), "matchDiacritics", "diacriticmatchingchange");
    toggle(t("pdf.action-whole-words"), "entireWord", "entirewordchange");
  }

  toggleSettings(show?: boolean): void {
    const toggle = this.settingsToggleEl, settings = this.settingsEl, win = settings.ownerDocument.defaultView ?? window;
    if (show === false || settings.isConnected) {
      toggle.removeClass("is-active");
      win.removeEventListener("click", this.clickOutsideHandler);
      settings.remove();
      return;
    }
    toggle.addClass("is-active");
    settings.setCssProps({ top: `${toggle.offsetTop + toggle.clientHeight + 6}px`, left: `${toggle.offsetLeft + toggle.clientWidth}px` });
    this.containerEl.append(settings);
    window.setTimeout(() => win.addEventListener("click", this.clickOutsideHandler));
  }

  private saveSettings(): void { this.app.saveLocalStorage(SEARCH_SETTINGS_KEY, this.searchSettings); }
  reset(): void { this.updateUIState(); }

  dispatchEvent(type: string, findPrevious = false): void {
    this.eventBus.dispatch("find", { source: this, type, query: this.inputEl.value, findPrevious, ...this.searchSettings });
  }

  updateUIState(state?: number, _previous?: boolean, matchesCount?: { current: number; total: number }): void {
    const container = this.inputContainerEl, states = this.findState();
    container.removeClasses(["mod-pending", "mod-not-found"]);
    if (state === states.PENDING) container.addClass("mod-pending");
    else if (state === states.NOT_FOUND) container.addClass("mod-not-found");
    this.inputEl.setAttribute("aria-invalid", String(state === states.NOT_FOUND));
    this.updateResultsCount(matchesCount);
  }

  updateResultsCount(matchesCount?: { current: number; total: number }): void {
    const { current, total } = matchesCount || { current: 0, total: 0 };
    let text = "";
    if (total > 0) text = total > 1000 ? t("pdf.msg-max-search-results", { current, limit: 1000 }) : t("pdf.msg-search-count", { current, total, count: total });
    this.findResultsCountEl.textContent = text;
  }

  showSearch(): void {
    if (this.opened && this.inputEl.ownerDocument.activeElement !== this.inputEl) this.autoSelect(); else this.toggle();
  }

  private autoSelect(): void { this.inputEl.focus(); this.inputEl.select(); }

  open(): void {
    const bar = this.barEl;
    if (!this.opened) {
      this.opened = true;
      bar.removeClass("mod-hidden");
      bar.parentElement!.addClass("findbarOpen");
      bar.parentElement!.setCssProps({ "--findbar-height": `${bar.clientHeight}px` });
    }
    this.autoSelect();
    this.eventBus.dispatch("findbaropen", { source: this });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.barEl.addClass("mod-hidden");
    this.barEl.parentElement!.removeClass("findbarOpen");
    this.barEl.parentElement!.setCssProps({ "--findbar-height": "" });
    this.eventBus.dispatch("findbarclose", { source: this });
    this.toggleSettings(false);
  }

  toggle(): boolean { if (this.opened) { this.close(); return false; } this.open(); return true; }
}

/** The prompt shown in place of the pages for a password-protected document. */
class PdfPasswordPrompt {
  private updateCallback: ((password: string) => void) | null = null;
  private reason: number | null = null;
  private dialogEl: HTMLElement | null = null;
  constructor(private readonly containerEl: HTMLElement, private readonly eventBus: PdfEventBus, private readonly incorrect: () => number) {}

  open(): void {
    const wrong = this.reason === this.incorrect();
    this.dialogEl = this.containerEl.createDiv("pdf-password-dialog", dialog => {
      setIcon(dialog.createDiv("pdf-lock-icon"), "lucide-lock");
      dialog.createDiv({ text: t("pdf.msg-password-protected") });
      dialog.createDiv({ text: wrong ? t("pdf.msg-invalid-password") : t("pdf.msg-enter-password"), cls: wrong ? "mod-warning mod-small" : "mod-small" });
      dialog.createEl("input", { type: "password", placeholder: t("setting.account.label-password") }, input => {
        input.addEventListener("keydown", event => { if (event.code === "Enter") this.verify(input.value); });
        window.setTimeout(() => input.focus());
      });
    });
    this.eventBus.dispatch("passwordpromptopen", { source: this });
  }
  close(): void { this.dialogEl?.remove(); this.dialogEl = null; }
  private verify(password: string): void {
    if (!password?.length || !this.updateCallback) return;
    const callback = this.updateCallback;
    this.close(); this.updateCallback = null;
    callback(password);
  }
  setUpdateCallback(callback: (password: string) => void, reason: number): void { this.updateCallback = callback; this.reason = reason; }
  reset(): void { this.close(); this.updateCallback = null; this.reason = null; }
}

/**
 * What the reference calls the viewer application: the pdf.js components for one viewer and the logic
 * that ties them to a document. Member names follow pdf.js (`pdfViewer`, `pdfLinkService`, `pdfSidebar`,
 * `eventBus`, `pdfDocument`, `page`, `pagesCount`) because plugins reach into them.
 */
export class PdfViewerApp {
  readonly eventBus: PdfEventBus;
  readonly pdfViewer: any;
  readonly pdfLinkService: any;
  readonly findController: any;
  readonly pdfRenderingQueue: any;
  readonly pdfThumbnailViewer: PdfThumbnailViewer;
  readonly pdfSidebar: PdfSidebar;
  pdfOutlineViewer!: PdfOutlineViewer;
  toolbar!: PdfToolbar;
  findBar!: PdfFindBar;
  passwordPrompt!: PdfPasswordPrompt;
  pdfDocument: any = null;
  pdfLoadingTask: any = null;
  store: ViewHistory | null = null;
  isInitialViewSet = false;
  location: { pageNumber: number; scale: number | string; left: number; top: number; rotation: number } | null = null;
  subpath: string | null = null;
  height: number | "page" | "auto";
  readonly isEmbed: boolean;
  pageBackground: string | null;
  pageInvert: boolean;
  private readonly abort = new AbortController();
  private wheelTicks = 0;
  private zoomDisabledTimer = 0;

  constructor(private readonly lib: PdfJsLibrary, private readonly components: PdfJsViewer, readonly dom: PdfDom, options: { eventBus: PdfEventBus; removePageBorders?: boolean; isEmbed?: boolean; height?: number | "page" | "auto"; pageBackground: string | null; pageInvert: boolean }) {
    const eventBus = this.eventBus = options.eventBus;
    this.isEmbed = !!options.isEmbed;
    this.height = options.height ?? "auto";
    this.pageInvert = options.pageInvert;
    this.pageBackground = options.pageBackground && CSS.supports("color", options.pageBackground) ? options.pageBackground : null;
    const linkService = this.pdfLinkService = new components.PDFLinkService({ eventBus, externalLinkTarget: components.LinkTarget.BLANK });
    this.findController = new components.PDFFindController({ linkService, eventBus });
    this.pdfViewer = new components.PDFViewer({
      container: dom.viewerContainerEl, viewer: dom.viewerEl, eventBus, linkService, findController: this.findController,
      removePageBorders: options.removePageBorders, l10n: new PdfL10n(), textLayerMode: 1, annotationMode: 2,
      imageResourcesPath: `${pdfJsBaseUrl()}images/`, maxCanvasPixels: MAX_CANVAS_PIXELS, enableHWA: true, abortSignal: this.abort.signal,
    });
    const queue = this.pdfRenderingQueue = this.pdfViewer.renderingQueue;
    linkService.setViewer(this.pdfViewer);
    this.pdfThumbnailViewer = new PdfThumbnailViewer(dom.thumbnailViewEl, eventBus, linkService, queue);
    queue.setThumbnailViewer(this.pdfThumbnailViewer);
    queue.onIdle = () => { if (!this.pdfDocument) return; this.pdfViewer.cleanup(); this.pdfThumbnailViewer.cleanup(); this.pdfDocument.cleanup(); };
    const sidebar = this.pdfSidebar = new PdfSidebar({ outerContainer: dom.contentEl, outlineView: dom.outlineViewEl, sidebarContainer: dom.sidebarContainerEl, thumbnailView: dom.thumbnailViewEl, resizer: dom.sidebarContainerEl.createDiv("pdf-sidebar-resizer") }, eventBus);
    sidebar.onToggled = () => this.forceRendering();
    sidebar.onUpdateThumbnails = () => {
      for (const pageView of this.pdfViewer.getCachedPageViews()) if (pageView.renderingState === RenderingStates.FINISHED) this.pdfThumbnailViewer.getThumbnail(pageView.id - 1)?.setImage(pageView);
      this.pdfThumbnailViewer.scrollThumbnailIntoView(this.pdfViewer.currentPageNumber);
    };
    this.bindEvents();
    eventBus._on("resize", () => { if (this.height === "page") this.setHeight("page"); });
  }

  get page(): number { return this.pdfViewer.currentPageNumber; }
  set page(value: number) { this.pdfViewer.currentPageNumber = value; }
  get pagesCount(): number { return this.pdfDocument ? this.pdfDocument.numPages : 0; }

  private forceRendering(): void {
    this.pdfRenderingQueue.isThumbnailViewEnabled = this.pdfSidebar.visibleView === SidebarView.THUMBS;
    this.pdfRenderingQueue.renderHighestPriority();
  }

  private updateZoom(steps: number): void {
    const box = this.pdfViewer.container.getBoundingClientRect();
    this.pdfViewer.updateScale({ drawingDelay: ZOOM_DELAY, steps, scaleFactor: null, origin: [box.left + box.width / 2, box.top + box.height / 2] });
  }
  zoomIn(): void { this.updateZoom(1); }
  zoomOut(): void { this.updateZoom(-1); }

  private bindEvents(): void {
    const bus = this.eventBus, viewer = this.pdfViewer, on = (name: string, listener: (event: any) => void) => bus._on(name, listener, { signal: this.abort.signal });
    on("resize", () => {
      if (!this.pdfDocument) return;
      const value = viewer.currentScaleValue;
      if (value === "auto" || value === "page-fit" || value === "page-width") viewer.currentScaleValue = value;
      viewer.update();
    });
    on("pagerender", event => { if (event.pageNumber === this.page) this.toolbar?.updateLoadingIndicatorState(true); });
    on("pagerendered", event => {
      if (event.pageNumber === this.page) this.toolbar?.updateLoadingIndicatorState(false);
      if (!event.isDetailView && this.pdfSidebar.visibleView === SidebarView.THUMBS) {
        const pageView = viewer.getPageView(event.pageNumber - 1);
        if (pageView) this.pdfThumbnailViewer.getThumbnail(event.pageNumber - 1)?.setImage(pageView);
      }
      if (event.error) console.error(event.error);
    });
    on("updateviewarea", event => {
      this.location = event.location;
      if (this.isInitialViewSet && !this.isEmbed) this.store?.setMultiple({ page: event.location.pageNumber, zoom: event.location.scale, scrollLeft: event.location.left, scrollTop: event.location.top, rotation: event.location.rotation });
    });
    on("pagechanging", event => {
      this.toolbar?.setPageNumber(event.pageNumber, event.pageLabel ?? null);
      if (this.pdfSidebar.visibleView === SidebarView.THUMBS) this.pdfThumbnailViewer.scrollThumbnailIntoView(event.pageNumber);
      this.toolbar?.updateLoadingIndicatorState(viewer.getPageView(event.pageNumber - 1)?.renderingState === RenderingStates.RUNNING);
    });
    on("scalechanging", event => { this.toolbar?.setPageScale(event.presetValue, event.scale); viewer.update(); });
    on("rotationchanging", event => { this.forceRendering(); viewer.currentPageNumber = event.pageNumber; });
    on("sidebarviewchanged", event => {
      this.pdfRenderingQueue.isThumbnailViewEnabled = event.view === SidebarView.THUMBS;
      if (!this.isInitialViewSet) return;
      this.store?.set("sidebarView", event.view);
      try { localStorage.setItem("pdfjs.sidebarView", String(event.view)); } catch { /* Storage may be unavailable. */ }
    });
    on("resize", event => { if (event.source === this.pdfSidebar && event.sidebarWidth && !this.isEmbed) { try { localStorage.setItem("pdfjs.sidebarWidth", String(event.sidebarWidth)); } catch { /* Storage may be unavailable. */ } } });
    on("namedaction", event => { if (event.action === "Find") this.findBar?.toggle(); });
    on("firstpage", () => { this.page = 1; });
    on("lastpage", () => { this.page = this.pagesCount; });
    on("nextpage", () => viewer.nextPage());
    on("previouspage", () => viewer.previousPage());
    on("zoomin", () => this.zoomIn());
    on("zoomout", () => this.zoomOut());
    on("zoomreset", () => { viewer.currentScaleValue = DEFAULT_SCALE_VALUE; });
    on("pagenumberchanged", event => {
      if (event.value !== "") this.pdfLinkService.goToPage(event.value);
      if (event.value !== viewer.currentPageNumber.toString() && event.value !== viewer.currentPageLabel) this.toolbar?.setPageNumber(viewer.currentPageNumber, viewer.currentPageLabel);
    });
    on("scalechanged", event => { viewer.currentScaleValue = event.value; });
    on("rotatecw", () => { viewer.pagesRotation += 90; });
    on("rotateccw", () => { viewer.pagesRotation -= 90; });
    on("optionalcontentconfig", event => { viewer.optionalContentConfigPromise = event.promise; });
    on("switchscrollmode", event => { viewer.scrollMode = event.mode; });
    on("scrollmodechanged", event => { if (this.isInitialViewSet) this.store?.set("scrollMode", event.mode); });
    on("switchspreadmode", event => { viewer.spreadMode = event.mode; });
    on("spreadmodechanged", event => { if (this.isInitialViewSet) this.store?.set("spreadMode", event.mode); });
    on("findfromurlhash", event => bus.dispatch("find", { source: event.source, type: "", query: event.query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: true }));
    on("updatefindmatchescount", event => this.findBar?.updateResultsCount(event.matchesCount));
    on("updatefindcontrolstate", event => this.findBar?.updateUIState(event.state, event.previous, event.matchesCount));
    // Ctrl + wheel zooms, one step per thirty pixels of travel.
    this.dom.viewerContainerEl.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) {
        window.clearTimeout(this.zoomDisabledTimer);
        this.zoomDisabledTimer = window.setTimeout(() => { this.zoomDisabledTimer = 0; }, 1000);
        return;
      }
      event.preventDefault();
      if (this.zoomDisabledTimer || this.dom.viewerContainerEl.ownerDocument.visibilityState === "hidden") return;
      const delta = -(event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY / 30 : event.deltaY);
      if ((this.wheelTicks > 0 && delta < 0) || (this.wheelTicks < 0 && delta > 0)) this.wheelTicks = 0;
      this.wheelTicks += delta;
      const ticks = Math.trunc(this.wheelTicks);
      this.wheelTicks -= ticks;
      if (ticks) this.updateZoom(ticks);
    }, { passive: false, signal: this.abort.signal });
  }

  /** Releases the listeners this viewer added outside its own elements. */
  unbindWindowEvents(): void { this.abort.abort(); }

  async open(args: { data: ArrayBuffer | Uint8Array; ownerDocument?: Document }): Promise<void> {
    if (this.pdfLoadingTask) await this.close();
    const bytes = args.data instanceof Uint8Array ? args.data : new Uint8Array(args.data);
    const task = this.pdfLoadingTask = this.lib.getDocument({ ...pdfJsDocumentOptions(), data: bytes, ownerDocument: args.ownerDocument });
    task.onPassword = (update: (password: string) => void, reason: number) => { this.passwordPrompt.setUpdateCallback(update, reason); this.passwordPrompt.open(); };
    const pdfDocument = await task.promise;
    if (task !== this.pdfLoadingTask) return;
    this.load(pdfDocument);
  }

  async close(): Promise<void> {
    this.passwordPrompt?.close();
    const task = this.pdfLoadingTask;
    if (!task) return;
    this.pdfLoadingTask = null;
    if (this.pdfDocument) {
      this.pdfDocument = null;
      this.pdfThumbnailViewer.setDocument(null);
      this.pdfViewer.setDocument(null);
      this.pdfLinkService.setDocument(null);
      this.findController.setDocument(null);
    }
    this.isInitialViewSet = false;
    this.store = null;
    this.location = null;
    this.pdfSidebar.reset();
    this.pdfOutlineViewer?.reset();
    this.findBar?.reset();
    this.toolbar?.reset();
    try { await task.destroy(); } catch { /* The worker may already be gone. */ }
  }

  private load(pdfDocument: any): void {
    this.pdfDocument = pdfDocument;
    const viewer = this.pdfViewer;
    this.toolbar?.setPagesCount(pdfDocument.numPages, false);
    this.pdfLinkService.setDocument(pdfDocument);
    this.findController.setDocument(pdfDocument);
    viewer.setDocument(pdfDocument);
    // An embed can be asked for page height before pdf.js has created its
    // pagesPromise. Reapply now that setDocument has initialized the pages.
    if (this.height === "page") this.setHeight("page");
    const { firstPagePromise, onePageRendered, pagesPromise } = viewer;
    this.pdfThumbnailViewer.setDocument(pdfDocument);
    const store = this.store = new ViewHistory(pdfDocument.fingerprints[0]);
    const stored = store.getMultiple({ page: null as number | null, zoom: DEFAULT_SCALE_VALUE as string | number, scrollLeft: "0" as string | number, scrollTop: "0" as string | number, rotation: null as number | null, sidebarView: SidebarView.UNKNOWN as number, scrollMode: -1, spreadMode: -1 });
    void firstPagePromise.then(async () => {
      if (pdfDocument !== this.pdfDocument) return;
      try {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        let hash: string | null = `zoom=${DEFAULT_ZOOM_VALUE}`, rotation: number | null = null, scrollMode = -1, spreadMode = -1;
        let sidebarView: number = SidebarView.NONE;
        if (stored.page) {
          hash = `page=${stored.page}&zoom=${DEFAULT_ZOOM_VALUE},${stored.scrollLeft},${stored.scrollTop}`;
          rotation = parseInt(String(stored.rotation), 10);
          scrollMode = Number(stored.scrollMode) | 0;
          spreadMode = Number(stored.spreadMode) | 0;
        }
        // The sidebar's view and width are remembered for all documents, not per document.
        let savedView: string | null = null, savedWidth: string | null = null;
        try { savedView = localStorage.getItem("pdfjs.sidebarView"); savedWidth = this.isEmbed ? null : localStorage.getItem("pdfjs.sidebarWidth"); } catch { /* Storage may be unavailable. */ }
        if (savedView) sidebarView = parseInt(savedView);
        const sidebarWidth = savedWidth ? parseInt(savedWidth) : SIDEBAR_MIN_WIDTH;
        ({ hash, sidebarView } = this.initialViewOverrides(stored, hash, sidebarView));
        this.setInitialView(hash, { rotation, sidebarView, scrollMode, spreadMode, sidebarWidth });
        this.eventBus.dispatch("documentinit", { source: this });
        if (!this.isEmbed) viewer.focus?.();
        await Promise.race([pagesPromise, new Promise(resolve => window.setTimeout(resolve, FORCE_PAGES_LOADED_TIMEOUT))]);
        if (pdfDocument !== this.pdfDocument || !hash || viewer.hasEqualPageSizes) return;
        // Pages of different sizes move the target once they are known; apply the position again.
        viewer.currentScaleValue = viewer.currentScaleValue;
        this.setInitialView(hash);
      } catch (error) { console.error(error); this.setInitialView(null); }
      finally { if (pdfDocument === this.pdfDocument) viewer.update(); }
    });
    void onePageRendered.then(() => {
      void pdfDocument.getOutline().then((outline: any) => { if (pdfDocument === this.pdfDocument) this.pdfOutlineViewer.renderTree({ outline, pdfDocument }); })
        .catch(() => { if (pdfDocument === this.pdfDocument) this.pdfOutlineViewer.renderTree({ outline: null, pdfDocument }); });
    });
    void this.initializePageLabels(pdfDocument).then(labels => { if (pdfDocument === this.pdfDocument) this.pdfOutlineViewer.setPageLabels(labels); }).catch(() => {});
  }

  /** Page labels are only used when they differ from plain page numbers. */
  private async initializePageLabels(pdfDocument: any): Promise<string[] | null> {
    const labels: string[] | null = await pdfDocument.getPageLabels();
    if (pdfDocument !== this.pdfDocument || !labels) return null;
    const count = labels.length;
    let standard = 0, empty = 0;
    for (let index = 0; index < count; index++) {
      if (labels[index] === (index + 1).toString()) standard++;
      else if (labels[index] === "") empty++;
      else break;
    }
    if (standard >= count || empty >= count) return null;
    this.pdfViewer.setPageLabels(labels);
    this.pdfThumbnailViewer.setPageLabels(labels);
    this.toolbar?.setPagesCount(count, true);
    this.toolbar?.setPageNumber(this.pdfViewer.currentPageNumber, this.pdfViewer.currentPageLabel);
    return labels;
  }

  /** A link's subpath, when there is one, decides the first position instead of the remembered one. */
  private initialViewOverrides(stored: { page: number | null; scrollLeft: string | number; scrollTop: string | number }, hash: string | null, sidebarView: number): { hash: string | null; sidebarView: number } {
    const subpath = this.subpath, parameters = subpath?.includes("=") ? new URLSearchParams(subpath) : null;
    if (subpath && !parameters) return { hash: subpath, sidebarView };
    const search = parameters?.get("search"), height = parameters?.get("height") ?? this.height;
    let page: string | number | null | undefined = parameters?.get("page") ?? stored.page, zoom = parameters?.get("zoom") ?? DEFAULT_ZOOM_VALUE;
    if (this.isEmbed) {
      sidebarView = SidebarView.NONE;
      page = parameters?.get("page");
      if (height) this.setHeight(height === "page" || height === "auto" ? height : parseInt(String(height)));
    } else if (!subpath && stored.page) zoom += `,${stored.scrollLeft},${stored.scrollTop}`;
    const parts: string[] = [];
    for (const [name, value] of [["zoom", zoom], ["page", page], ["search", search]] as const) if (value) parts.push(`${name}=${value}`);
    return { hash: parts.join("&") || hash, sidebarView };
  }

  private setInitialView(hash: string | null, options: { rotation?: number | null; sidebarView?: number; scrollMode?: number; spreadMode?: number; sidebarWidth?: number } = {}): void {
    const viewer = this.pdfViewer;
    this.isInitialViewSet = true;
    void this.pdfSidebar.setInitialView(options.sidebarView);
    if (options.sidebarWidth !== undefined) this.pdfSidebar.updateWidth(options.sidebarWidth);
    if (options.scrollMode !== undefined && [0, 1, 2, 3].includes(options.scrollMode)) viewer.scrollMode = options.scrollMode;
    if (options.spreadMode !== undefined && [0, 1, 2].includes(options.spreadMode)) viewer.spreadMode = options.spreadMode;
    if (hash) {
      if (typeof options.rotation === "number" && options.rotation % 90 === 0) viewer.pagesRotation = options.rotation;
      this.pdfLinkService.setHash(hash);
    }
    this.toolbar?.setPageNumber(viewer.currentPageNumber, viewer.currentPageLabel);
    this.pdfOutlineViewer?.setPageNumber(viewer.currentPageNumber);
    if (!viewer.currentScaleValue) viewer.currentScaleValue = DEFAULT_SCALE_VALUE;
  }

  /** Embeds are as tall as a number of pixels, or as the current page. */
  setHeight(height: number | "page" | "auto"): void {
    const toolbarHeight = this.toolbar.toolbarEl.clientHeight, container = this.dom.containerEl, viewer = this.pdfViewer;
    if (typeof height === "number" && !Number.isNaN(height)) container.style.height = `${height + toolbarHeight}px`;
    else if (height === "page" && viewer.pagesPromise) {
      void viewer.pagesPromise.then(() => {
        const pageView = viewer.getPageView(viewer.currentPageNumber - 1);
        if (pageView) container.style.height = `${pageView.viewport.height + toolbarHeight}px`;
      });
    }
    this.height = height ?? "auto";
  }

  /** Records the theme-adapted page colour; `PdfViewerChild.paintPage` applies it to the drawn pages. */
  setBackground(background: string | null, invert: boolean): void {
    this.pageBackground = background;
    this.pageInvert = invert;
    this.pdfThumbnailViewer.setImageFilter(background && invert ? "invert(100%) hue-rotate(180deg)" : "");
  }

  /** Moves to a destination: a pdf.js hash (`page=3&zoom=…`), a named destination, or an explicit one as JSON. */
  applySubpath(subpath: string): void {
    if (!subpath.includes("=")) {
      if (this.isInitialViewSet) this.pdfLinkService.setHash(subpath);
      this.subpath = subpath;
      return;
    }
    const parameters = new URLSearchParams(subpath), parts: string[] = [];
    for (const name of ["zoom", "page", "search"]) { const value = parameters.get(name); if (value) parts.push(`${name}=${value}`); }
    if (parts.length) { if (this.isInitialViewSet) this.pdfLinkService.setHash(parts.join("&")); this.subpath = subpath; }
    if (this.isEmbed) {
      const height = parameters.get("height") ?? this.height;
      if (height) this.setHeight(height === "page" || height === "auto" ? height : parseInt(String(height)));
    }
  }
}

/** Loads pdf.js, builds the viewer in `containerEl`, and adds what the reference layers on top: link copying, highlights and annotation popups. */
export class PdfViewerChild {
  pdfViewer: PdfViewerApp | null = null;
  toolbar: PdfToolbar | null = null;
  findBar: PdfFindBar | null = null;
  file: TFile | null = null;
  unloaded = false;
  private lib: PdfJsLibrary = null;
  private subpathHighlight: SubpathHighlight | null = null;
  private annotationHighlight: HTMLElement | null = null;
  private highlightedText: Array<[number, number]> = [];
  private activeAnnotationPopupEl: HTMLElement | null = null;
  private readonly annotations = new WeakMap<object, Promise<any[]>>();
  private readonly resizeObserver: ResizeObserver;
  private resizeTimer = 0;
  private loadSerial = 0;
  private pendingInsertion: MutationObserver | null = null;

  constructor(readonly app: App, readonly containerEl: HTMLElement, readonly opts: PdfViewerOptions = {}) {
    this.resizeObserver = new ResizeObserver(() => { window.clearTimeout(this.resizeTimer); this.resizeTimer = window.setTimeout(() => this.onResize(), 200); });
  }

  async load(): Promise<void> {
    if (this.opts.initDelay) { await sleep(this.opts.initDelay); if (this.unloaded) return; }
    const components = await loadPdfJsViewer(), lib = this.lib = await loadPdfJs();
    if (this.unloaded) return;
    const { app, opts } = this, doc = this.containerEl.ownerDocument;
    const eventBus: PdfEventBus = new components.EventBus();
    const pdfContainerEl = doc.createElement("div"); pdfContainerEl.className = "pdf-container";
    // The page viewer measures its container when it is created, so the container is in the document from the start.
    this.containerEl.append(pdfContainerEl);
    const themed = app.loadLocalStorage(THEMED_KEY);
    let pageBackground: string | null = null, pageInvert = false;
    if (themed) {
      pdfContainerEl.addClass("mod-themed");
      pageBackground = getComputedStyle(pdfContainerEl).getPropertyValue("--pdf-page-background").trim() || null;
      pageInvert = doc.body.hasClass("theme-dark");
    }
    const contentEl = pdfContainerEl.createDiv("pdf-content-container");
    const viewerContainerEl = contentEl.createDiv("pdf-viewer-container", el => {
      el.style.position = "absolute";
      el.addEventListener("transitionend", event => { if (event.target === el) eventBus.dispatch("resize", { source: el }); }, true);
      el.addEventListener("contextmenu", event => { void this.onContextMenu(event); });
      el.addEventListener("pointerdown", event => this.onAnnotationPointerDown(event));
    });
    const viewerEl = viewerContainerEl.createDiv("pdfViewer");
    const sidebarContainerEl = contentEl.createDiv("pdf-sidebar-container", el => { el.addEventListener("contextmenu", event => this.onThumbnailContextMenu(event)); });
    const sidebarContentEl = sidebarContainerEl.createDiv("pdf-sidebar-content-wrapper").createDiv("pdf-sidebar-content");
    const thumbnailViewEl = sidebarContentEl.createDiv("pdf-thumbnail-view"), outlineViewEl = sidebarContentEl.createDiv("pdf-outline-view hidden");
    const dom: PdfDom = { containerEl: this.containerEl, contentEl, outlineViewEl, pdfContainerEl, sidebarContainerEl, thumbnailViewEl, viewerContainerEl, viewerEl };
    const viewer = this.pdfViewer = new PdfViewerApp(lib, components, dom, { eventBus, height: opts.height, isEmbed: opts.isEmbed, removePageBorders: opts.removePageBorders, pageBackground, pageInvert });
    // pdf.js creates this helper asynchronously when a document's pages are
    // initialized, after the viewer constructor has returned. The reference
    // stylesheet addresses it by class and positions it outside page layout.
    eventBus._on("pagesinit", () => {
      const copyEl = viewerContainerEl.querySelector("#hiddenCopyElement");
      if (copyEl) { copyEl.removeAttribute("id"); copyEl.className = "hiddenCopyElement"; }
    });
    viewer.toolbar = this.toolbar = new PdfToolbar(app, this.containerEl, this);
    viewer.findBar = this.findBar = new PdfFindBar(app, contentEl, eventBus, () => components.FindState);
    viewer.passwordPrompt = new PdfPasswordPrompt(viewerContainerEl, eventBus, () => lib.PasswordResponses.INCORRECT_PASSWORD);
    viewer.pdfOutlineViewer = new PdfOutlineViewer(this, outlineViewEl, eventBus);
    viewer.pdfOutlineViewer.linkService = viewer.pdfLinkService;
    if (pageBackground) viewer.setBackground(pageBackground, pageInvert);
    eventBus._on("sidebarviewchanged", (event: { view: number }) => { sidebarContainerEl.setAttr("data-view", event.view); });
    eventBus._on("find", () => this.clearEphemeralUI());
    this.resizeObserver.observe(pdfContainerEl);
    if (opts.isEmbed && opts.height) viewer.setHeight(opts.height);
    eventBus._on("textlayerrendered", (event: { source: any }) => {
      const pageView = event.source;
      if (!pageView) return;
      this.markTextLayer(pageView);
      const highlight = this.subpathHighlight;
      if (highlight?.type === "text" && pageView.id === highlight.page) this.highlightText(highlight.page, highlight.range);
    });
    // The find highlighter rewrites the text spans and drops their classes; restore them.
    eventBus.on("updatetextlayermatches", (event: { pageIndex: number }) => {
      if (event.pageIndex >= 0) { const pageView = viewer.pdfViewer.getPageView(event.pageIndex); if (pageView) this.markTextLayer(pageView); }
      else for (const pageView of viewer.pdfViewer.getCachedPageViews()) this.markTextLayer(pageView);
    });
    eventBus._on("pagerendered", (event: { source: any }) => { this.paintPage(event.source); });
    if (opts.isEmbed) eventBus.on("pagerendered", () => { pdfContainerEl.querySelector(".hiddenCopyElement")?.remove(); }, { once: true });
    eventBus._on("annotationlayerrendered", (event: { source: any }) => {
      const pageView = event.source;
      // The reference shows its own popup for an annotation, not pdf.js's.
      for (const popup of pageView?.annotationLayer?.div?.querySelectorAll?.(".popupAnnotation") ?? []) (popup as HTMLElement).style.display = "none";
      // The reference's pdf.js fork exposes popup-bearing highlights as one
      // hit target. Upstream pdf.js splits this into a pointer trigger and a
      // hover highlight; normalize the public DOM classes while our viewer's
      // coordinate-based pointer handling supplies the same interaction.
      for (const highlight of pageView?.annotationLayer?.div?.querySelectorAll?.(".highlightAnnotation.popupTriggerArea") ?? []) {
        highlight.setAttribute("class", "hasPopup highlightAnnotation");
      }
      const highlight = this.subpathHighlight;
      if (highlight?.type === "annotation" && pageView?.id === highlight.page) void this.highlightAnnotation(highlight.page, highlight.id);
    });
  }

  unload(): void {
    this.unloaded = true;
    this.pendingInsertion?.disconnect(); this.pendingInsertion = null;
    this.resizeObserver.disconnect();
    window.clearTimeout(this.resizeTimer);
    this.pdfViewer?.unbindWindowEvents();
    void this.pdfViewer?.close();
    this.pdfViewer = null;
    this.toolbar = null;
    this.findBar?.close();
    this.findBar = null;
    this.containerEl.empty();
    this.destroyAnnotationPopup();
  }

  /** Text spans carry the reference's class and their index, which selection links are written in. */
  private markTextLayer(pageView: any): void {
    const divs: HTMLElement[] | undefined = pageView?._textHighlighter?.textDivs ?? pageView?.textLayer?.highlighter?.textDivs;
    if (!divs) return;
    divs.forEach((div, index) => { if (div?.classList) { div.classList.add("textLayerNode"); div.dataset.idx = String(index); } });
  }

  private textItems(pageView: any): { divs: HTMLElement[]; strings: string[] } | null {
    const highlighter = pageView?._textHighlighter ?? pageView?.textLayer?.highlighter;
    return highlighter?.textDivs && highlighter.textContentItemsStr ? { divs: highlighter.textDivs, strings: highlighter.textContentItemsStr } : null;
  }

  /** "Adapt to theme" without the reference's patched renderer: blend the page into the themed background. */
  private paintPage(pageView: any): void {
    const viewer = this.pdfViewer, canvas: HTMLCanvasElement | null | undefined = pageView?.canvas;
    if (!viewer || !canvas) return;
    const wrapper = canvas.parentElement;
    if (viewer.pageBackground) {
      // Dark themes: inverted colours with their hue kept, lightened onto the background. Light themes: darkened onto it.
      canvas.style.filter = viewer.pageInvert ? "invert(100%) hue-rotate(180deg)" : "";
      canvas.style.mixBlendMode = viewer.pageInvert ? "screen" : "multiply";
      if (wrapper) wrapper.style.backgroundColor = viewer.pageBackground;
    } else {
      canvas.style.filter = ""; canvas.style.mixBlendMode = "";
      if (wrapper) wrapper.style.backgroundColor = "";
    }
  }

  getPage(pageNumber: number): any { return this.pdfViewer?.pdfViewer.getPageView(pageNumber - 1); }

  private pageAnnotations(pageView: any): Promise<any[]> {
    const page = pageView?.pdfPage;
    if (!page) return Promise.resolve([]);
    let pending = this.annotations.get(page);
    if (!pending) this.annotations.set(page, pending = page.getAnnotations().catch(() => []));
    return pending!;
  }

  private pagePoint(pageView: any, event: MouseEvent): [number, number] {
    const box = (pageView.div.querySelector(".canvasWrapper") ?? pageView.div).getBoundingClientRect();
    return pageView.viewport.convertToPdfPoint(event.clientX - box.left, event.clientY - box.top);
  }

  private async annotationAt(pageView: any, event: MouseEvent): Promise<any | null> {
    const [x, y] = this.pagePoint(pageView, event);
    for (const data of await this.pageAnnotations(pageView)) {
      const quads: ArrayLike<number> | null = data.quadPoints?.length ? data.quadPoints : null;
      if (quads) {
        for (let index = 0; index < quads.length; index += 8) {
          const xs = [quads[index], quads[index + 2], quads[index + 4], quads[index + 6]], ys = [quads[index + 1], quads[index + 3], quads[index + 5], quads[index + 7]];
          if (x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys)) return data;
        }
      } else if (data.rect) {
        const [left, bottom, right, top] = data.rect;
        if (x >= left && x <= right && y >= bottom && y <= top) return data;
      }
    }
    return null;
  }

  /** Position of an annotation's rectangle inside the page, in the percentages the annotation layer uses. */
  private annotationBox(pageView: any, rect: number[]): { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number } {
    const view: number[] = pageView.pdfPage.view, dims = pageView.viewport.rawDims as { pageWidth: number; pageHeight: number; pageX: number; pageY: number };
    const [left, top, right, bottom] = this.lib.Util.normalizeRect([rect[0], view[3] - rect[1] + view[1], rect[2], view[3] - rect[3] + view[1]]) as number[];
    return { left, top, right, bottom, width: dims.pageWidth, height: dims.pageHeight, x: dims.pageX, y: dims.pageY };
  }

  private renderAnnotationPopup(pageView: any, data: any): void {
    const layer: HTMLElement | undefined = pageView.annotationLayer?.div;
    if (!layer) return;
    const page: number = pageView.id, doc = layer.ownerDocument;
    const popup = doc.createElement("div"); popup.className = "popup";
    popup.createDiv({ cls: "popupContent", attr: { dir: data.contentsObj?.dir ?? "ltr" } }, content => {
      const lines = String(data.contentsObj?.str ?? "").split(/(?:\r\n?|\n)/);
      lines.forEach((line, index) => { content.append(line); if (index < lines.length - 1) content.createEl("br"); });
    });
    popup.createDiv("popupMeta", meta => {
      if (data.titleObj?.str) meta.createDiv({ cls: "popupTitle", text: data.titleObj.str, attr: { dir: data.titleObj.dir } });
      const modified: Date | null = this.lib.PDFDateString.toDateObject(data.modificationDate);
      if (modified) meta.createSpan({ cls: "popupDate", text: `${modified.toLocaleDateString()}, ${modified.toLocaleTimeString()}` });
      meta.createDiv("clickable-icon", button => {
        setIcon(button, "lucide-copy"); setTooltip(button, t("interface.menu.copy"));
        button.addEventListener("click", () => {
          void (async () => {
            const parts: string[] = [], quoted = await this.getAnnotatedText(pageView, data.id);
            if (quoted) parts.push(`> ${quoted}`);
            parts.push(this.getMarkdownLink(`#page=${page}&annotation=${data.id}`));
            if (data.contentsObj?.str) parts.push(String(data.contentsObj.str));
            await navigator.clipboard.writeText(parts.join("\n\n"));
            setIcon(button, "lucide-check");
          })();
        });
      });
    });
    const box = this.annotationBox(pageView, data.rect);
    const wrapper = doc.createElement("div"); wrapper.className = "popupWrapper"; wrapper.setAttribute("data-annotation-id", data.id);
    wrapper.append(popup);
    wrapper.setCssProps({ left: `${100 * ((box.left + box.right) / 2 - box.x) / box.width}%`, top: `${100 * (box.bottom - box.y) / box.height}%` });
    if (data.color) wrapper.style.setProperty("--annotation-color", `${data.color[0]}, ${data.color[1]}, ${data.color[2]}`);
    layer.append(wrapper);
    wrapper.animate([{ transform: "translate(-50%, -1px) scale(0.97)" }, { transform: "translate(-50%, 0) scale(1)" }], { duration: 200, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    const visible = this.pdfViewer!.dom.viewerContainerEl.getBoundingClientRect(), placed = wrapper.getBoundingClientRect();
    if (!(placed.top > visible.top && placed.bottom < visible.bottom)) wrapper.scrollIntoView({ behavior: "smooth", block: "end" });
    this.activeAnnotationPopupEl = wrapper;
  }

  private destroyAnnotationPopup(): void {
    const popup = this.activeAnnotationPopupEl;
    if (!popup) return;
    this.activeAnnotationPopupEl = null;
    const animation = popup.animate([{ transform: "translate(-50%, 0) scale(1)", opacity: 1 }, { transform: "translate(-50%, -1px) scale(0.9)", opacity: 0 }], { duration: 200, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    animation.onfinish = animation.oncancel = () => popup.remove();
  }

  clearEphemeralUI(): void {
    this.destroyAnnotationPopup();
    this.clearAnnotationHighlight();
    this.clearTextHighlight();
    this.subpathHighlight = null;
  }

  private onAnnotationPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || this.activeAnnotationPopupEl?.contains(event.target as Node)) return;
    const pageEl = (event.target as Element).closest<HTMLElement>(".page");
    if (!pageEl?.dataset.pageNumber) { this.clearEphemeralUI(); return; }
    const pageView = this.getPage(parseInt(pageEl.dataset.pageNumber)), win = event.view ?? window;
    const { clientX, clientY, pointerId } = event;
    let moved = false;
    const move = (next: PointerEvent) => { if (next.pointerId === pointerId && Math.hypot(clientX - next.clientX, clientY - next.clientY) > 5) moved = true; };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); win.removeEventListener("pointercancel", up);
      const shown = this.activeAnnotationPopupEl?.dataset.annotationId;
      this.clearEphemeralUI();
      if (moved || !pageView) return;
      void this.annotationAt(pageView, event).then(data => { if (data && data.subtype !== "Widget" && data.subtype !== "Link" && data.id !== shown && !this.unloaded) this.renderAnnotationPopup(pageView, data); });
    };
    win.addEventListener("pointermove", move); win.addEventListener("pointerup", up); win.addEventListener("pointercancel", up);
  }

  private getPageLinkAlias(page: number): string { return `${this.file?.basename ?? ""}, ${t("pdf.label-page", { page })}`; }

  /** `beginIndex,beginOffset,endIndex,endOffset` of the selection inside one page's text layer. */
  private getTextSelectionRangeStr(pageEl: HTMLElement): string | null {
    const selection = pageEl.ownerDocument.defaultView?.getSelection(), range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || range.collapsed) return null;
    const nodeOf = (node: Node): HTMLElement | null => {
      if (!pageEl.contains(node)) return null;
      const element = node instanceof HTMLElement ? node : node.parentElement;
      const found = element?.closest<HTMLElement>("[data-idx]") ?? null;
      return found && pageEl.contains(found) ? found : null;
    };
    const offsetIn = (root: HTMLElement, node: Node, offset: number): number | null => {
      if (!root.contains(node)) return null;
      const walker = root.ownerDocument.createNodeIterator(root, NodeFilter.SHOW_TEXT);
      let total = offset, current: Node | null;
      while ((current = walker.nextNode()) && current !== node) total += current.textContent!.length;
      return total;
    };
    const begin = nodeOf(range.startContainer), end = nodeOf(range.endContainer);
    if (!begin || !end) return null;
    const beginOffset = offsetIn(begin, range.startContainer, range.startOffset), endOffset = offsetIn(end, range.endContainer, range.endOffset);
    return beginOffset === null || endOffset === null ? null : `${begin.dataset.idx},${beginOffset},${end.dataset.idx},${endOffset}`;
  }

  private async onContextMenu(event: MouseEvent): Promise<void> {
    const pageEl = (event.target as Element).closest<HTMLElement>(".page");
    if (!pageEl) return;
    const page = parseInt(pageEl.dataset.pageNumber ?? "");
    if (Number.isNaN(page)) return;
    event.preventDefault();
    const pageView = this.getPage(page), win = event.view ?? window;
    let selected = win.getSelection()?.toString() ?? "";
    if (selected) selected = this.lib.normalizeUnicode(selected.replace(/[\n\r]+/g, " ")).replace(/\x00/g, "");
    const selectionRange = this.getTextSelectionRangeStr(pageEl);
    const menu = new Menu().addSections(["action", "selection", "annotation"]);
    const annotation = pageView ? await this.annotationAt(pageView, event) : null;
    let annotationId: string | null = null, annotated: string | null = null;
    if (annotation && annotation.subtype !== "Widget") { annotationId = annotation.id; annotated = await this.getAnnotatedText(pageView, annotation.id); }
    const copy = (text: string) => () => { void win.navigator.clipboard.writeText(text); };
    if (selected) menu.addItem(item => item.setSection("selection").setTitle(t("interface.menu.copy")).setIcon("lucide-copy").onClick(copy(selected)));
    if (selectionRange) {
      const link = this.getMarkdownLink(`#page=${page}&selection=${selectionRange}`, this.getPageLinkAlias(page));
      menu.addItem(item => item.setSection("selection").setTitle(t("pdf.action-copy-quote")).setIcon("lucide-copy").onClick(copy(`> ${selected.replace(/[\r\n]+/g, " ")}\n\n${link}`)));
      menu.addItem(item => item.setSection("selection").setTitle(t("pdf.action-copy-selection-link")).setIcon("lucide-copy").onClick(copy(link)));
    }
    if (annotationId) {
      const link = this.getMarkdownLink(`#page=${page}&annotation=${annotationId}`, this.getPageLinkAlias(page));
      if (annotated) menu.addItem(item => item.setSection("annotation").setTitle(t("pdf.action-copy-annotation")).setIcon("lucide-copy").onClick(copy(`> ${annotated}\n\n${link}`)));
      menu.addItem(item => item.setSection("annotation").setTitle(t("pdf.action-copy-annot-link")).setIcon("lucide-copy").onClick(copy(link)));
    }
    this.clearEphemeralUI();
    if (menu.items.length) menu.showAtMouseEvent(event);
  }

  private onThumbnailContextMenu(event: MouseEvent): void {
    const target = (event.target as Element).closest<HTMLElement>(".thumbnail");
    if (!target) return;
    const page = parseInt(target.dataset.pageNumber ?? "");
    if (Number.isNaN(page)) return;
    const link = this.getMarkdownLink(`#page=${page}`, this.getPageLinkAlias(page));
    new Menu().addItem(item => item.setTitle(t("pdf.action-copy-page-link", { page })).setIcon("lucide-copy").onClick(() => { void (event.view ?? window).navigator.clipboard.writeText(link); })).showAtMouseEvent(event);
  }

  /** The page text under a highlight or underline annotation. */
  async getAnnotatedText(pageView: any, id: string): Promise<string | null> {
    const data = (await this.pageAnnotations(pageView)).find(entry => entry.id === id), quads: ArrayLike<number> | undefined = data?.quadPoints;
    if (!quads?.length) return null;
    let text = "";
    for (let index = 0; index < quads.length; index += 8) {
      const xs = [quads[index], quads[index + 2], quads[index + 4], quads[index + 6]], ys = [quads[index + 1], quads[index + 3], quads[index + 5], quads[index + 7]];
      const part = this.getTextByRect(pageView, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      if (part && text !== "") text += " ";
      text += part;
    }
    return text.trim() || null;
  }

  /** Characters whose centre lies inside a rectangle given in PDF units, measured from the rendered text layer. */
  private getTextByRect(pageView: any, [left, bottom, right, top]: number[]): string {
    const layer: HTMLElement | undefined = pageView.textLayer?.div;
    if (!layer) return "";
    const origin = (pageView.div.querySelector(".canvasWrapper") ?? pageView.div).getBoundingClientRect();
    const range = layer.ownerDocument.createRange(), walker = layer.ownerDocument.createNodeIterator(layer, NodeFilter.SHOW_TEXT);
    let text = "", node: Node | null;
    while ((node = walker.nextNode())) {
      const content = node.textContent ?? "";
      for (let index = 0; index < content.length; index++) {
        range.setStart(node, index); range.setEnd(node, index + 1);
        const box = range.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        const [x, y] = pageView.viewport.convertToPdfPoint(box.left + box.width / 2 - origin.left, box.top + box.height / 2 - origin.top) as [number, number];
        if (x >= left && x <= right && y >= bottom && y <= top) text += content[index];
      }
    }
    return text;
  }

  private clearAnnotationHighlight(): void { this.annotationHighlight?.remove(); this.annotationHighlight = null; }

  private async highlightAnnotation(page: number, id: string): Promise<void> {
    this.clearAnnotationHighlight();
    const viewer = this.pdfViewer;
    if (!viewer || page < 1 || page > viewer.pagesCount) return;
    const pageView = this.getPage(page);
    if (!pageView?.div.dataset.loaded || !pageView.annotationLayer?.div) return;
    const data = (await this.pageAnnotations(pageView)).find(entry => entry.id === id);
    if (!data || this.unloaded) return;
    this.clearAnnotationHighlight();
    const box = this.annotationBox(pageView, data.rect);
    const el = this.annotationHighlight = (pageView.annotationLayer.div as HTMLElement).createDiv("boundingRect mod-focused");
    el.setCssProps({ left: `${100 * (box.left - box.x) / box.width}%`, top: `${100 * (box.top - box.y) / box.height}%`, width: `${100 * (box.right - box.left) / box.width}%`, height: `${100 * (box.bottom - box.top) / box.height}%` });
    window.setTimeout(() => { if (el.isConnected && this.pdfViewer) scrollIntoContainer(el, -51); });
  }

  private clearTextHighlight(): void {
    for (const [page, index] of this.highlightedText) {
      const items = this.textItems(this.getPage(page)), div = items?.divs[index];
      if (!items || !div) continue;
      div.textContent = items.strings[index];
      div.className = div.dataset.idx !== undefined ? "textLayerNode" : "";
    }
    this.highlightedText = [];
  }

  /** Marks a range of the text layer, as a `#page=N&selection=…` link asks for. */
  private highlightText(page: number, range: [[number, number], [number, number]]): void {
    this.clearTextHighlight();
    const viewer = this.pdfViewer;
    if (!viewer || page < 1 || page > viewer.pagesCount) return;
    const pageView = this.getPage(page), items = pageView?.div.dataset.loaded ? this.textItems(pageView) : null;
    if (!items) return;
    const { divs, strings } = items, marked: Array<[number, number]> = [];
    const [[beginIndex, beginOffset], [endIndex, endOffset]] = range;
    if (!divs[beginIndex] || !divs[endIndex]) return;
    const append = (index: number, from: number, to: number | undefined, cls?: string) => {
      marked.push([page, index]);
      const div = divs[index], text = div.ownerDocument.createTextNode(strings[index].substring(from, to));
      if (cls) div.createSpan(`${cls} appended`).append(text); else div.append(text);
    };
    const begin = (index: number, to: number, cls?: string) => {
      marked.push([page, index]);
      if (marked.length === 1) scrollIntoContainer(divs[index], -50, true);
      divs[index].textContent = "";
      append(index, 0, to, cls);
    };
    begin(beginIndex, beginOffset);
    if (beginIndex === endIndex) append(beginIndex, beginOffset, endOffset, "mod-focused selected");
    else {
      append(beginIndex, beginOffset, undefined, "mod-focused begin selected");
      for (let index = beginIndex + 1; index < endIndex; index++) { marked.push([page, index]); divs[index].classList.add("mod-focused", "middle", "selected"); }
      begin(endIndex, endOffset, "mod-focused endselected");
    }
    append(endIndex, endOffset, undefined);
    this.highlightedText = marked;
  }

  async loadFile(file: TFile, subpath?: string): Promise<void> {
    const viewer = this.pdfViewer;
    if (this.unloaded || !viewer) return;
    this.pendingInsertion?.disconnect(); this.pendingInsertion = null;
    const serial = ++this.loadSerial;
    viewer.subpath = null;
    this.file = null;
    const open = async () => {
      try {
        if (subpath) this.applySubpath(subpath);
        const data = await this.app.vault.readBinary(file);
        if (this.unloaded || serial !== this.loadSerial) return;
        this.file = file;
        await viewer.open({ data, ownerDocument: this.containerEl.ownerDocument });
      } catch (error) { if ((error as { name?: string })?.name !== "PasswordException") console.error(error); }
    };
    // Embeds can be constructed before their Markdown section is attached.
    // pdf.js measures and scrolls its pages during opening, so defer that work
    // until the container participates in layout, as the reference does.
    if (!this.containerEl.offsetParent) {
      const observer = this.pendingInsertion = new MutationObserver(() => {
        if (!this.containerEl.offsetParent || this.unloaded) return;
        observer.disconnect();
        if (this.pendingInsertion === observer) this.pendingInsertion = null;
        void open();
      });
      observer.observe(this.containerEl.ownerDocument.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
      return;
    }
    await open();
  }

  /** `#page=3`, `#page=3&offset=…`, `#page=3&selection=…`, `#page=3&annotation=…`, or a named destination. */
  applySubpath(subpath: string | null | undefined): void {
    if (!subpath) return;
    const viewer = this.pdfViewer;
    if (!viewer) return;
    if (subpath[0] === "#") subpath = subpath.substring(1);
    const parameters = new URLSearchParams(subpath);
    let dest = subpath, highlight: SubpathHighlight | null = null;
    if (parameters.has("page")) {
      const page = toInt(parameters.get("page")) ?? 1, offset = parameters.has("offset") ? parameters.get("offset")!.split(",") : [];
      const left = toInt(offset[0]), top = toInt(offset[1]), zoom = toInt(offset[2]);
      dest = JSON.stringify(zoom === null ? [page - 1, { name: "FitBH" }, top] : [page - 1, { name: "XYZ" }, left, top, zoom]);
      if (parameters.has("annotation")) highlight = { type: "annotation", page, id: parameters.get("annotation")! };
      else if (parameters.has("selection")) {
        const [beginIndex, beginOffset, endIndex, endOffset] = parameters.get("selection")!.split(",").map(toInt);
        if (beginIndex !== null && beginOffset !== null && endIndex !== null && endOffset !== null && beginIndex !== undefined && beginOffset !== undefined && endIndex !== undefined && endOffset !== undefined) highlight = { type: "text", page, range: [[beginIndex, beginOffset], [endIndex, endOffset]] };
      }
    }
    const task = viewer.pdfLoadingTask;
    if (task) void task.promise.then(() => { if (this.pdfViewer === viewer) viewer.applySubpath(dest); }).catch(() => {});
    else viewer.subpath = dest;

    this.subpathHighlight = highlight;
  }

  onResize(): void {
    if (this.containerEl.isConnected && this.containerEl.getClientRects().length && this.pdfViewer) this.pdfViewer.eventBus.dispatch("resize", { source: this });
  }

  on(name: string, callback: (event: any) => void): void { this.pdfViewer?.eventBus._on(name, callback); }
  off(name: string, callback: (event: any) => void): void { this.pdfViewer?.eventBus._off(name, callback); }

  /** Re-reads the "Adapt to theme" preference and the theme's page colour. */
  onCSSChange(): void {
    const viewer = this.pdfViewer;
    if (!viewer) return;
    const container = viewer.dom.pdfContainerEl, themed = this.app.loadLocalStorage(THEMED_KEY);
    container.toggleClass("mod-themed", !!themed);
    const background = themed ? getComputedStyle(container).getPropertyValue("--pdf-page-background").trim() || null : null;
    const invert = !!themed && container.ownerDocument.body.hasClass("theme-dark");
    if (background === viewer.pageBackground && invert === viewer.pageInvert) return;
    container.toggleClass("mod-themed", !!background);
    viewer.setBackground(background, invert);
    for (const pageView of viewer.pdfViewer.getCachedPageViews()) this.paintPage(pageView);
  }

  getMarkdownLink(subpath: string, alias?: string, embed?: boolean): string {
    if (!this.file) return "";
    const link = this.app.fileManager.generateMarkdownLink(this.file, "", subpath, alias).replace(/^!/, "");
    return embed ? `!${link}` : link;
  }
}

export { isEditable as isEditableTarget };
