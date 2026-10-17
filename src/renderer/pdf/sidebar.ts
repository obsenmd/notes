/*
 * The PDF sidebar and its two views: page thumbnails and the document outline ("Table of contents").
 * The reference ships a fork of pdf.js's viewer application for these; the published pdf.js package only
 * has the page viewer, so the sidebar, the thumbnails and the outline tree are written here against the
 * same events (`sidebarviewchanged`, `outlineloaded`, `togglesidebar`, `currentoutlineitem`, …).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { t } from "../../i18n";
import { Menu } from "../../compat/ui";
import { setIcon } from "../../compat/utilities";

export const SidebarView = { UNKNOWN: -1, NONE: 0, THUMBS: 1, OUTLINE: 2 } as const;
export const SIDEBAR_MIN_WIDTH = 140;
export const RenderingStates = { INITIAL: 0, RUNNING: 1, PAUSED: 2, FINISHED: 3 } as const;
const THUMBNAIL_WIDTH = 98;

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

export interface PdfEventBus {
  _on(name: string, listener: (event: any) => void, options?: { once?: boolean; signal?: AbortSignal }): void;
  _off(name: string, listener: (event: any) => void): void;
  on(name: string, listener: (event: any) => void, options?: { once?: boolean; signal?: AbortSignal }): void;
  off(name: string, listener: (event: any) => void): void;
  dispatch(name: string, data?: unknown): void;
}

/** Opens, closes and resizes the sidebar, and switches between its views. */
export class PdfSidebar {
  isOpen = false;
  active: number = SidebarView.THUMBS;
  isInitialViewSet = false;
  isInitialEventDispatched = false;
  haveOutline = false;
  onToggled: (() => void) | null = null;
  onUpdateThumbnails: (() => void) | null = null;
  width = 0;
  private outlineReady = deferred<void>();
  private resizing: AbortController | null = null;
  private startX = 0;
  private startWidth = 0;

  constructor(private readonly elements: { outerContainer: HTMLElement; sidebarContainer: HTMLElement; thumbnailView: HTMLElement; outlineView: HTMLElement; resizer: HTMLElement }, private readonly eventBus: PdfEventBus) {
    const { outerContainer, sidebarContainer, resizer } = elements;
    sidebarContainer.addEventListener("transitionend", event => {
      if (event.target !== sidebarContainer) return;
      outerContainer.classList.remove("sidebarMoving");
      eventBus.dispatch("resize", { source: this });
    });
    eventBus._on("outlineloaded", (event: { outlineCount: number }) => {
      if (!event.outlineCount && this.active === SidebarView.OUTLINE) this.switchView(SidebarView.THUMBS);
      this.outlineReady.resolve();
      this.haveOutline = !!event.outlineCount;
    });
    eventBus._on("togglesidebar", (event: { open?: boolean }) => this.toggle(event.open));
    eventBus._on("resize", () => {
      if (!this.width) return;
      if (!this.isOpen) { this.updateWidth(this.width); return; }
      outerContainer.classList.add("sidebarResizing");
      const changed = this.updateWidth(this.width);
      void Promise.resolve().then(() => { outerContainer.classList.remove("sidebarResizing"); if (changed) eventBus.dispatch("resize", { source: this }); });
    });
    resizer.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      this.startX = event.clientX;
      this.startWidth = this.width || SIDEBAR_MIN_WIDTH;
      outerContainer.classList.add("sidebarResizing");
      this.resizing = new AbortController();
      const options = { signal: this.resizing.signal }, win = event.view ?? window;
      const rtl = getComputedStyle(outerContainer).direction === "rtl";
      win.addEventListener("mousemove", move => { this.updateWidth(rtl ? this.startWidth + (this.startX - move.clientX) : this.startWidth - (this.startX - move.clientX)); }, options);
      const end = () => {
        outerContainer.classList.remove("sidebarResizing");
        eventBus.dispatch("resize", { source: this, sidebarWidth: this.width });
        this.resizing?.abort(); this.resizing = null;
      };
      win.addEventListener("mouseup", end, options);
      win.addEventListener("blur", end, options);
    });
  }

  reset(): void {
    this.isInitialViewSet = false;
    this.isInitialEventDispatched = false;
    this.outlineReady.promise.catch(() => {});
    this.outlineReady.reject();
    this.outlineReady = deferred<void>();
    this.haveOutline = false;
  }

  get visibleView(): number { return this.isOpen ? this.active : SidebarView.NONE; }

  async setInitialView(view: number = SidebarView.NONE): Promise<void> {
    if (this.isInitialViewSet) return;
    try { await this.outlineReady.promise; } catch { return; }
    this.isInitialViewSet = true;
    if (view === SidebarView.UNKNOWN) { this.dispatchEvent(); return; }
    this.switchView(view, true);
    if (!this.isInitialEventDispatched) this.dispatchEvent();
  }

  switchView(view: number, forceOpen = false): void {
    const changed = view !== this.active;
    let updateThumbnails = false;
    switch (view) {
      case SidebarView.NONE: if (this.isOpen) this.close(); return;
      case SidebarView.THUMBS: if (this.isOpen && changed) updateThumbnails = true; break;
      case SidebarView.OUTLINE: if (!this.haveOutline) return; break;
      default: return;
    }
    this.active = view;
    this.elements.thumbnailView.classList.toggle("hidden", view !== SidebarView.THUMBS);
    this.elements.outlineView.classList.toggle("hidden", view !== SidebarView.OUTLINE);
    if (forceOpen && !this.isOpen) { this.open(); return; }
    if (updateThumbnails) { this.onUpdateThumbnails?.(); this.onToggled?.(); }
    if (changed) this.dispatchEvent();
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.elements.outerContainer.classList.add("sidebarMoving", "sidebarOpen");
    if (this.active === SidebarView.THUMBS) this.onUpdateThumbnails?.();
    this.onToggled?.();
    this.dispatchEvent();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.elements.outerContainer.classList.add("sidebarMoving");
    this.elements.outerContainer.classList.remove("sidebarOpen");
    this.onToggled?.();
    this.dispatchEvent();
  }

  toggle(open?: boolean): void { if (open === false || this.isOpen) this.close(); else this.open(); }

  updateWidth(width = 0): boolean {
    const maximum = Math.floor(this.elements.outerContainer.clientWidth / 2);
    if (width > maximum) width = maximum;
    if (width < SIDEBAR_MIN_WIDTH) width = SIDEBAR_MIN_WIDTH;
    if (width === this.width) return false;
    this.width = width;
    this.elements.outerContainer.style.setProperty("--sidebar-width", `${width}px`);
    return true;
  }

  private dispatchEvent(): void {
    if (this.isInitialViewSet) this.isInitialEventDispatched ||= true;
    this.eventBus.dispatch("sidebarviewchanged", { source: this, view: this.visibleView });
  }
}

/** One page thumbnail: `a > div.thumbnail > img.thumbnailImage`. */
class PdfThumbnailView {
  readonly renderingId: string;
  renderingState: number = RenderingStates.INITIAL;
  resume: (() => void) | null = null;
  pdfPage: any = null;
  pageLabel: string | null = null;
  readonly anchor: HTMLAnchorElement;
  readonly div: HTMLDivElement;
  private readonly placeholder: HTMLDivElement;
  private image: HTMLImageElement | null = null;
  private renderTask: any = null;
  private canvasHeight = 0;
  private scale = 1;

  constructor(container: HTMLElement, readonly id: number, private viewport: any, private readonly owner: PdfThumbnailViewer) {
    this.renderingId = `thumbnail${id}`;
    const doc = container.ownerDocument;
    const anchor = this.anchor = doc.createElement("a");
    anchor.href = owner.linkService.getAnchorUrl(`#page=${id}`);
    anchor.setAttribute("data-l10n-id", "pdfjs-thumb-page-title");
    anchor.setAttribute("data-l10n-args", this.l10nArgs);
    anchor.onclick = () => { owner.linkService.goToPage(id); return false; };
    const div = this.div = doc.createElement("div");
    div.className = "thumbnail";
    div.setAttribute("data-page-number", String(id));
    div.setAttribute("data-page-label", String(id));
    this.updateDims();
    this.placeholder = doc.createElement("div");
    this.placeholder.className = "thumbnailImage";
    div.append(this.placeholder);
    anchor.append(div);
    container.append(anchor);
  }

  private get l10nArgs(): string { return JSON.stringify({ page: this.pageLabel ?? this.id }); }

  private updateDims(): void {
    const { width, height } = this.viewport;
    this.canvasHeight = (THUMBNAIL_WIDTH / (width / height)) | 0;
    this.scale = THUMBNAIL_WIDTH / width;
    this.div.style.setProperty("--thumbnail-width", `${THUMBNAIL_WIDTH}px`);
    this.div.style.setProperty("--thumbnail-height", `${this.canvasHeight}px`);
  }

  setPdfPage(pdfPage: any): void {
    this.pdfPage = pdfPage;
    this.viewport = pdfPage.getViewport({ scale: 1 });
    this.reset();
  }

  reset(): void {
    this.cancelRendering();
    this.renderingState = RenderingStates.INITIAL;
    this.div.removeAttribute("data-loaded");
    this.image?.replaceWith(this.placeholder);
    this.updateDims();
    if (this.image) { this.image.removeAttribute("src"); this.image = null; }
  }

  cancelRendering(): void {
    if (this.renderTask) { this.renderTask.cancel(); this.renderTask = null; }
    this.resume = null;
  }

  private canvas(factor: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
    const canvas = this.div.ownerDocument.createElement("canvas");
    canvas.width = factor * THUMBNAIL_WIDTH; canvas.height = factor * this.canvasHeight;
    return { canvas, context: canvas.getContext("2d", { alpha: false })! };
  }

  async draw(): Promise<void> {
    if (this.renderingState !== RenderingStates.INITIAL) return;
    const pdfPage = this.pdfPage;
    if (!pdfPage) { this.renderingState = RenderingStates.FINISHED; throw new Error("pdfPage is not loaded"); }
    this.renderingState = RenderingStates.RUNNING;
    // Drawn at twice the size and reduced, as the reference does, for sharper small text.
    const { canvas, context } = this.canvas(2);
    const renderTask = this.renderTask = pdfPage.render({ canvasContext: context, canvas, viewport: this.viewport.clone({ scale: 2 * this.scale }) });
    renderTask.onContinue = (resume: () => void) => {
      if (this.owner.renderingQueue.isHighestPriority(this)) { resume(); return; }
      this.renderingState = RenderingStates.PAUSED;
      this.resume = () => { this.renderingState = RenderingStates.RUNNING; resume(); };
    };
    let failure: unknown = null;
    try { await renderTask.promise; }
    catch (error) {
      if ((error as { name?: string })?.name === "RenderingCancelledException") { canvas.width = canvas.height = 0; return; }
      failure = error;
    }
    finally { if (renderTask === this.renderTask) this.renderTask = null; }
    this.renderingState = RenderingStates.FINISHED;
    this.convert(canvas);
    canvas.width = canvas.height = 0;
    this.owner.eventBus.dispatch("thumbnailrendered", { source: this, pageNumber: this.id, pdfPage });
    if (failure) throw failure;
  }

  /** Reuses an already rendered page instead of drawing the thumbnail again. */
  setImage(pageView: { thumbnailCanvas?: HTMLCanvasElement | null; pdfPage: any; scale: number }): void {
    if (this.renderingState !== RenderingStates.INITIAL) return;
    const source = pageView.thumbnailCanvas;
    if (!source) return;
    if (!this.pdfPage) this.setPdfPage(pageView.pdfPage);
    if (pageView.scale < this.scale) return;
    this.renderingState = RenderingStates.FINISHED;
    this.convert(source);
  }

  private convert(source: HTMLCanvasElement): void {
    const { canvas, context } = this.canvas(1);
    // Halve repeatedly rather than in one step, which keeps thin strokes visible.
    let current: HTMLCanvasElement = source, width = source.width, height = source.height;
    while (width > 2 * canvas.width) {
      const step = this.div.ownerDocument.createElement("canvas");
      step.width = width >> 1; step.height = height >> 1;
      step.getContext("2d")!.drawImage(current, 0, 0, width, height, 0, 0, step.width, step.height);
      current = step; width = step.width; height = step.height;
    }
    context.drawImage(current, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    const image = this.div.ownerDocument.createElement("img");
    image.className = "thumbnailImage";
    image.setAttribute("data-l10n-id", "pdfjs-thumb-page-canvas");
    image.setAttribute("data-l10n-args", this.l10nArgs);
    image.src = canvas.toDataURL();
    if (this.owner.imageFilter) image.style.filter = this.owner.imageFilter;
    this.image = image;
    this.div.setAttribute("data-loaded", "true");
    this.placeholder.replaceWith(image);
    canvas.width = canvas.height = 0;
  }

  setPageLabel(label: string | null): void {
    this.pageLabel = typeof label === "string" ? label : null;
    this.div.setAttribute("data-page-label", label ?? String(this.id));
    this.anchor.setAttribute("data-l10n-args", this.l10nArgs);
    this.image?.setAttribute("data-l10n-args", this.l10nArgs);
  }
}

/** The thumbnail strip. Thumbnails are drawn through the page viewer's rendering queue, when it is idle. */
export class PdfThumbnailViewer {
  private thumbnails: PdfThumbnailView[] = [];
  private pdfDocument: any = null;
  private currentPageNumber = 1;
  /** CSS filter for theme-adapted dark pages; see `PdfViewerApp.setBackground`. */
  imageFilter = "";

  constructor(readonly container: HTMLElement, readonly eventBus: PdfEventBus, readonly linkService: any, readonly renderingQueue: any) {
    container.addEventListener("scroll", () => { if (this.pdfDocument) this.renderingQueue.renderHighestPriority(); });
    eventBus._on("pagechanging", (event: { pageNumber: number }) => { this.select(event.pageNumber); });
  }

  getThumbnail(index: number): PdfThumbnailView | undefined { return this.thumbnails[index]; }

  private select(pageNumber: number): void {
    if (!this.pdfDocument) return;
    this.thumbnails[this.currentPageNumber - 1]?.div.classList.remove("selected");
    this.thumbnails[pageNumber - 1]?.div.classList.add("selected");
    this.currentPageNumber = pageNumber;
  }

  private visible(): { first: { id: number; view: PdfThumbnailView }; last: { id: number; view: PdfThumbnailView }; views: Array<{ id: number; view: PdfThumbnailView }>; ids: Set<number> } | null {
    const box = this.container.getBoundingClientRect();
    if (!box.height) return null;
    const views = this.thumbnails.filter(thumbnail => { const rect = thumbnail.div.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom; }).map(view => ({ id: view.id, view }));
    return views.length ? { first: views[0], last: views[views.length - 1], views, ids: new Set(views.map(entry => entry.id)) } : null;
  }

  scrollThumbnailIntoView(pageNumber: number): void {
    if (!this.pdfDocument) return;
    this.select(pageNumber);
    const thumbnail = this.thumbnails[pageNumber - 1];
    if (!thumbnail) return;
    const box = this.container.getBoundingClientRect(), rect = thumbnail.div.getBoundingClientRect();
    if (!box.height || (rect.top >= box.top && rect.bottom <= box.bottom)) return;
    this.container.scrollTop += rect.top - box.top - 19;
  }

  cleanup(): void {
    for (const thumbnail of this.thumbnails) if (thumbnail.renderingState !== RenderingStates.FINISHED) thumbnail.reset();
  }

  /** Called by the rendering queue; returns true when a thumbnail was scheduled. */
  forceRendering(): boolean {
    const visible = this.visible();
    if (!visible) return false;
    const thumbnail = this.renderingQueue.getHighestPriority(visible, this.thumbnails, true) as PdfThumbnailView | null;
    if (!thumbnail) return false;
    const document = this.pdfDocument;
    void (thumbnail.pdfPage ? Promise.resolve(thumbnail.pdfPage) : document.getPage(thumbnail.id).then((page: any) => { if (document === this.pdfDocument && !thumbnail.pdfPage) thumbnail.setPdfPage(page); return page; }))
      .then(() => { if (document === this.pdfDocument) this.renderingQueue.renderView(thumbnail); })
      .catch(() => {});
    return true;
  }

  setDocument(pdfDocument: any): void {
    for (const thumbnail of this.thumbnails) thumbnail.cancelRendering();
    this.thumbnails = [];
    this.currentPageNumber = 1;
    this.container.textContent = "";
    this.pdfDocument = pdfDocument;
    if (!pdfDocument) return;
    void pdfDocument.getPage(1).then((firstPage: any) => {
      if (pdfDocument !== this.pdfDocument) return;
      const viewport = firstPage.getViewport({ scale: 1 });
      for (let page = 1; page <= pdfDocument.numPages; page++) this.thumbnails.push(new PdfThumbnailView(this.container, page, viewport.clone(), this));
      this.thumbnails[0]?.setPdfPage(firstPage);
      this.thumbnails[this.currentPageNumber - 1]?.div.classList.add("selected");
    }).catch(() => {});
  }

  setPageLabels(labels: string[] | null): void {
    this.thumbnails.forEach((thumbnail, index) => thumbnail.setPageLabel(labels?.[index] ?? null));
  }

  setImageFilter(filter: string): void {
    this.imageFilter = filter;
    for (const image of this.container.querySelectorAll<HTMLElement>("img.thumbnailImage")) image.style.filter = filter;
  }
}

export interface PdfOutlineNode { title: string; bold?: boolean; italic?: boolean; dest: string | unknown[] | null; url?: string | null; action?: string; setOCGState?: unknown; items: PdfOutlineNode[] }
export interface PdfOutlineHost { file: { basename: string } | null; opts?: { isEmbed?: boolean }; getMarkdownLink(subpath: string, alias?: string): string }

/** One row of the outline: the reference's tree item markup with the page number as flair. */
class PdfOutlineItem {
  readonly el: HTMLDivElement;
  readonly selfEl: HTMLDivElement;
  readonly innerEl: HTMLDivElement;
  readonly childrenEl: HTMLDivElement;
  children: PdfOutlineItem[] = [];
  collapsed = false;
  private collapseEl: HTMLDivElement | null = null;
  private explicitDest: unknown[] | null | undefined;
  private pageNumber: number | null | undefined;

  constructor(readonly owner: PdfOutlineViewer, readonly item: PdfOutlineNode, readonly parent: PdfOutlineItem | null, doc: Document) {
    this.el = doc.createElement("div"); this.el.className = "tree-item";
    this.selfEl = this.el.createDiv("tree-item-self");
    this.innerEl = this.selfEl.createDiv("tree-item-inner");
    this.childrenEl = doc.createElement("div"); this.childrenEl.className = "tree-item-children";
    this.el.append(this.childrenEl);
    this.innerEl.setText(item.title);
    void this.renderLabels();
    this.selfEl.addEventListener("click", event => { if (!event.defaultPrevented) owner.onItemClick(this); });
    this.selfEl.addEventListener("contextmenu", event => { if (!event.defaultPrevented) void owner.onItemContextMenu(this, event); });
  }

  render(): void {
    const collapsible = this.children.length > 0;
    this.selfEl.classList.toggle("mod-collapsible", collapsible);
    if (collapsible && !this.collapseEl) {
      this.collapseEl = this.selfEl.createDiv({ cls: "tree-item-icon collapse-icon", prepend: true });
      setIcon(this.collapseEl, "right-triangle");
      this.collapseEl.addEventListener("click", event => { event.preventDefault(); this.setCollapsed(!this.collapsed); });
    }
    this.selfEl.classList.add("is-clickable");
    if (this.item.bold) this.innerEl.style.fontWeight = "bold";
    if (this.item.italic) this.innerEl.style.fontStyle = "italic";
    for (const child of this.children) { child.render(); this.childrenEl.append(child.el); }
    this.setCollapsed(this.collapsed);
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed && this.children.length > 0;
    this.el.classList.toggle("is-collapsed", this.collapsed);
    this.collapseEl?.classList.toggle("is-collapsed", this.collapsed);
    // A collapsed item's children are taken out of the document, as in the reference tree.
    if (this.collapsed) this.childrenEl.remove(); else if (!this.childrenEl.isConnected) this.el.append(this.childrenEl);
  }

  async getExplicitDestination(): Promise<unknown[] | null> {
    if (this.explicitDest !== undefined) return this.explicitDest;
    const document = this.owner.pdfDocument, dest = this.item.dest;
    let resolved: unknown[] | null = null;
    if (typeof dest === "string") {
      try {
        const found = await document.getDestination(dest);
        if (document !== this.owner.pdfDocument) return null;
        if (Array.isArray(found) && typeof (found[0] as { num?: unknown })?.num === "number") resolved = found;
      } catch (error) { console.error(error); }
    } else if (Array.isArray(dest)) resolved = dest;
    return this.explicitDest = resolved;
  }

  async getPageNumber(): Promise<number | null> {
    if (this.pageNumber !== undefined) return this.pageNumber;
    const document = this.owner.pdfDocument, dest = await this.getExplicitDestination();
    if (!dest) return this.pageNumber = null;
    const ref = dest[0];
    let page: number | null = null;
    if (typeof ref === "object" && ref !== null) {
      page = document.cachedPageNumber(ref);
      if (page === null) {
        try { page = await document.getPageIndex(ref) + 1; } catch { /* An invalid reference has no page. */ }
        if (document !== this.owner.pdfDocument) return null;
      }
    } else if (Number.isInteger(ref)) page = (ref as number) + 1;
    else return this.pageNumber = null;
    return this.pageNumber = page;
  }

  async getMarkdownLink(): Promise<string | null> {
    const dest = await this.getExplicitDestination(), page = await this.getPageNumber();
    if (!dest || page === null) return null;
    let subpath = `page=${page}`;
    if ((dest[1] as { name?: string } | null)?.name === "XYZ" && dest.length === 5 && dest[2] !== null) {
      const offset = [dest[2]];
      if (dest[3] !== null) { offset.push(dest[3]); if (dest[4] !== null) offset.push(dest[4]); }
      subpath += `&offset=${offset.join(",")}`;
    }
    const title = this.item.title?.replace(/[\s\n\r]+/g, " "), viewer = this.owner.viewer;
    return viewer.getMarkdownLink(`#${subpath}`, `${viewer.file?.basename ?? ""}, ${title}`);
  }

  private async renderLabels(): Promise<void> {
    const page = await this.getPageNumber();
    if (!this.owner.outline || page === null) return;
    const label = String(this.owner.pageLabels?.[page - 1] ?? page);
    this.selfEl.createDiv("tree-item-flair-outer").createSpan({ cls: "tree-item-flair", text: label });
  }

  setActive(active: boolean): void { this.selfEl.classList.toggle("mod-active", active); }

  reveal(): void {
    for (let parent = this.parent; parent; parent = parent.parent) parent.setCollapsed(false);
    this.selfEl.scrollIntoView({ block: "start" });
  }
}

/** The outline ("Table of contents") tree. */
export class PdfOutlineViewer {
  outline: PdfOutlineNode[] | null = null;
  pdfDocument: any = null;
  pageLabels: string[] | null = null;
  linkService: any = null;
  private allItems: PdfOutlineItem[] = [];
  private highlighted: PdfOutlineItem | null = null;
  private currentPageNumber = 1;
  private isPagesLoaded: boolean | null = null;
  private sidebarView = 0;
  private pageNumberToDest: Promise<Map<number | null, unknown> | null> | null = null;
  private currentOutlineItem: Deferred<boolean> | null = null;

  constructor(readonly viewer: PdfOutlineHost, readonly containerEl: HTMLElement, private readonly eventBus: PdfEventBus) {
    eventBus._on("toggleoutlinetree", () => this.toggleAllTreeItems());
    eventBus._on("currentoutlineitem", () => { void this.findCurrentOutlineItem().catch(error => console.error(error)); });
    eventBus._on("pagechanging", (event: { pageNumber: number }) => { this.currentPageNumber = event.pageNumber; });
    eventBus._on("pagesloaded", (event: { pagesCount: number }) => { this.isPagesLoaded = !!event.pagesCount; this.currentOutlineItem?.resolve(this.isPagesLoaded); });
    eventBus._on("sidebarviewchanged", (event: { view: number }) => { this.sidebarView = event.view; });
    this.reset();
  }

  reset(): void {
    this.outline = null;
    this.pageNumberToDest = null;
    this.currentPageNumber = 1;
    this.isPagesLoaded = null;
    this.highlighted = null;
    this.allItems = [];
    this.currentOutlineItem?.resolve(false);
    this.currentOutlineItem = null;
    this.containerEl.replaceChildren();
  }

  setPageNumber(page: number): void { this.currentPageNumber = page; }

  private recurse(nodes: PdfOutlineNode[], all: PdfOutlineItem[], parent: PdfOutlineItem | null = null): PdfOutlineItem[] {
    return nodes.map(node => {
      const item = new PdfOutlineItem(this, node, parent, this.containerEl.ownerDocument);
      if (node.items.length) item.collapsed = true;
      item.children = this.recurse(node.items, all, item);
      all.push(item);
      return item;
    });
  }

  renderTree({ outline, pdfDocument }: { outline: PdfOutlineNode[] | null; pdfDocument: any }): void {
    if (this.outline) { if (this.outline !== outline) this.reset(); else this.containerEl.replaceChildren(); }
    this.outline = outline || null;
    this.pdfDocument = pdfDocument || null;
    if (!outline) { this.dispatchEvent(0); return; }
    const all: PdfOutlineItem[] = this.allItems = [];
    for (const root of this.recurse(outline, all)) { root.render(); this.containerEl.append(root.el); }
    this.highlighted = null;
    this.dispatchEvent(all.length);
  }

  private dispatchEvent(outlineCount: number): void {
    const capability = this.currentOutlineItem = deferred<boolean>();
    if (outlineCount === 0 || this.pdfDocument?.loadingParams.disableAutoFetch) capability.resolve(false);
    else if (this.isPagesLoaded !== null) capability.resolve(this.isPagesLoaded);
    this.eventBus.dispatch("outlineloaded", { source: this, outlineCount, currentOutlineItemPromise: capability.promise });
  }

  onItemClick(item: PdfOutlineItem): void {
    const { url, action, dest, setOCGState } = item.item;
    if (!dest) { if (item.children.length) item.setCollapsed(!item.collapsed); return; }
    if (this.highlighted !== item) { this.highlighted?.setActive(false); item.setActive(true); this.highlighted = item; }
    if (url) window.open(url.replace(/\x00/g, ""), "_blank");
    else if (action) this.linkService.executeNamedAction(action);
    else if (setOCGState) this.linkService.executeSetOCGState(setOCGState);
    else void this.linkService.goToDestination(dest);
  }

  async onItemContextMenu(item: PdfOutlineItem, event: MouseEvent): Promise<void> {
    if (this.viewer.opts?.isEmbed) event.preventDefault();
    const link = await item.getMarkdownLink();
    if (!link) return;
    const title = item.item.title?.replace(/[\s\n\r]+/g, " ");
    const label = title ? t("pdf.action-copy-section-link-title", { title: title.length <= 40 ? title : `${title.slice(0, 39).trim()}…` }) : t("pdf.action-copy-section-link");
    new Menu().addItem(entry => entry.setTitle(label).setIcon("lucide-copy").onClick(() => { void (event.view ?? window).navigator.clipboard.writeText(link); })).showAtMouseEvent(event);
  }

  private toggleAllTreeItems(): void {
    if (!this.allItems.length) return;
    const collapsed = this.allItems[0].collapsed;
    for (const item of this.allItems) item.setCollapsed(!collapsed);
  }

  private async findCurrentOutlineItem(): Promise<void> {
    if (!this.isPagesLoaded) throw new Error("findCurrentOutlineItem: All pages have not been loaded.");
    if (!this.outline || !this.pdfDocument) return;
    const pages = await this.getPageNumberToDest(this.pdfDocument);
    if (!pages) return;
    this.highlighted?.setActive(false);
    this.highlighted = null;
    if (this.sidebarView !== SidebarView.OUTLINE) return;
    for (let page = this.currentPageNumber; page > 0; page--) {
      const dest = pages.get(page);
      if (!dest) continue;
      const item = this.allItems.find(entry => entry.item.dest && entry.item.dest === dest);
      if (item) { item.setActive(true); item.reveal(); this.highlighted = item; return; }
    }
  }

  private getPageNumberToDest(pdfDocument: any): Promise<Map<number | null, unknown> | null> {
    return this.pageNumberToDest ??= (async () => {
      const pages = new Map<number | null, unknown>();
      for (const item of this.allItems) {
        const page = await item.getPageNumber();
        if (pdfDocument !== this.pdfDocument) return null;
        pages.set(page, item.item.dest);
      }
      return pages.size > 0 ? pages : null;
    })();
  }

  setPageLabels(labels: string[] | null): void {
    this.pageLabels = labels || null;
    if (this.pdfDocument) this.renderTree({ outline: this.outline, pdfDocument: this.pdfDocument });
  }
}
