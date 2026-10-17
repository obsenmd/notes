/*
 * The `pdf` file view and the `.pdf-embed` used by `![[file.pdf]]`, both around the shared viewer in
 * `viewer.ts`. `installPdfSupport` registers them for a vault; PDF support does not depend on a core plugin.
 */
import { t } from "../../i18n";
import { Component } from "../../compat/component";
import { FileView } from "../../compat/file-views";
import { registerFileEmbedRenderer } from "../../compat/markdown";
import type { App } from "../../compat/plugin";
import { Menu } from "../../compat/ui";
import { setIcon, setTooltip } from "../../compat/utilities";
import { TFile } from "../../compat/vault";
import type { OpenViewState, PaneType, WorkspaceLeaf } from "../../compat/workspace";
import { isEditableTarget, PdfViewerChild, type PdfViewerOptions } from "./viewer";

export const PDF_VIEW_TYPE = "pdf";

/** Owns one viewer: builds it when loaded and queues calls made before pdf.js has arrived. */
export class PdfViewerComponent extends Component {
  child: PdfViewerChild | null = null;
  private next: Array<(child: PdfViewerChild) => void> | null = [];

  constructor(readonly app: App, readonly containerEl: HTMLElement, readonly opts: PdfViewerOptions = {}) { super(); }

  override onload(): void {
    this.registerEvent(this.app.workspace.on("css-change", () => { this.then(child => child.onCSSChange()); }));
    if (this.child) return;
    const child = this.child = new PdfViewerChild(this.app, this.containerEl, this.opts);
    void child.load().then(() => {
      if (this.child !== child || child.unloaded || !child.pdfViewer) return;
      const next = this.next ?? [];
      this.next = null;
      for (const callback of next) callback(child);
    }).catch(error => console.error(error));
  }

  override onunload(): void {
    this.child?.unload();
    this.child = null;
    this.next = [];
  }

  /** Runs `callback` with the viewer, now or as soon as it exists. */
  then(callback: (child: PdfViewerChild) => void): void {
    if (this.next) this.next.push(callback);
    else if (this.child) callback(this.child);
  }

  loadFile(file: TFile, subpath?: string): Promise<void> {
    return new Promise(resolve => {
      if (!this.isLoaded()) { resolve(); return; }
      this.then(child => { void child.loadFile(file, subpath).then(resolve, () => resolve()); });
    });
  }
}

/** A PDF opened in a tab. */
export class PdfFileView extends FileView {
  icon = "lucide-file-text";
  readonly viewer: PdfViewerComponent;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.viewer = this.addChild(new PdfViewerComponent(this.app, this.contentEl, {}));
  }

  getViewType(): string { return PDF_VIEW_TYPE; }
  override canAcceptExtension(extension: string): boolean { return extension.toLowerCase() === "pdf"; }

  override onload(): void {
    // Clear this view's content before the PDF child initializes it.
    this.contentEl.replaceChildren();
    super.onload();
    this.registerEvent(this.app.vault.on("modify", file => { if (file === this.file && file instanceof TFile) void this.onLoadFile(file); }));
    // The reference registers these on the view's key scope, which is active while the tab is.
    const doc = this.contentEl.ownerDocument;
    this.registerDomEvent(doc, "keydown", event => this.onKeyDown(event), true);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const child = this.viewer.child, viewer = child?.pdfViewer;
    if (!child || !viewer || this.app.workspace.activeLeaf?.view !== this) return;
    const doc = this.contentEl.ownerDocument;
    if (doc.querySelector(".modal-container, .menu, .prompt, .suggestion-container")) return;
    const mod = event.ctrlKey || event.metaKey, plain = !mod && !event.altKey && !event.shiftKey;
    const inside = this.contentEl.contains(doc.activeElement) || doc.activeElement === doc.body;
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if (mod && !event.altKey && !event.shiftKey && event.code === "KeyF" && inside) { consume(); this.showSearch(); return; }
    const findBar = child.findBar;
    if (findBar?.opened && (event.key === "F3" || (mod && event.code === "KeyG")) && !event.altKey) { consume(); findBar.dispatchEvent("again", event.shiftKey); return; }
    if (plain && event.key === "Escape" && inside) { child.clearEphemeralUI(); if (findBar?.opened) { consume(); findBar.close(); } return; }
    if (plain && (event.key === "ArrowLeft" || event.key === "ArrowRight") && inside && !isEditableTarget(event.target)) {
      const value = viewer.pdfViewer.currentScaleValue;
      if (value !== "page-width" && value !== "page-height") return;
      consume();
      if (event.key === "ArrowLeft") viewer.pdfViewer.previousPage(); else viewer.pdfViewer.nextPage();
    }
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.viewer.loadFile(file);
  }

  override setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const { subpath, focus } = (state && typeof state === "object" ? state : {}) as { subpath?: string; focus?: boolean };
    this.viewer.then(child => {
      child.applySubpath(subpath);
      if (focus) void child.pdfViewer?.pdfViewer.firstPagePromise?.then(() => child.pdfViewer?.pdfViewer.focus?.());
    });
  }

  override getEphemeralState(): Record<string, unknown> { return {}; }

  override async onUnloadFile(file: TFile): Promise<void> {
    this.viewer.then(child => { void child.pdfViewer?.close(); });
    await super.onUnloadFile(file);
  }

  override async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.viewer.then(child => { if (child.file?.path === file.path) child.file = file; });
  }

  showSearch(): void { this.viewer.then(child => child.findBar?.showSearch()); }
}

interface PdfEmbedContext { app: App; containerEl: HTMLElement; linktext: string; sourcePath: string; displayMode?: boolean }

/** `![[file.pdf#page=2&height=400]]`: the viewer inside a note, as tall as the page or as the link says. */
export class PdfEmbed extends Component {
  readonly app: App;
  readonly containerEl: HTMLElement;
  readonly viewer: PdfViewerComponent;

  constructor(context: PdfEmbedContext, readonly file: TFile, readonly subpath: string) {
    super();
    this.app = context.app;
    this.containerEl = context.containerEl;
    let height: number | "page" = "page";
    if (subpath) {
      const requested = parseInt(new URLSearchParams(subpath.substring(1)).get("height") ?? "");
      if (requested > 0) height = requested;
    }
    this.containerEl.addClass("pdf-embed");
    this.viewer = this.addChild(new PdfViewerComponent(this.app, this.containerEl, { removePageBorders: true, isEmbed: true, height, initDelay: 300, displayMode: context.displayMode }));
    this.viewer.then(child => {
      const right = child.toolbar!.toolbarRightEl;
      right.createDiv("pdf-toolbar-spacer");
      right.createDiv("clickable-icon", el => {
        setIcon(el, "lucide-more-vertical"); setTooltip(el, t("setting.about.button-open"));
        el.addEventListener("click", () => {
          const menu = new Menu().setParentElement(el);
          if (!linkMenu(context.app, menu, context.linktext, context.sourcePath)) return;
          const box = el.getBoundingClientRect();
          menu.showAtPosition({ x: box.x, y: box.bottom, width: box.width, overlap: true, left: true }, el.ownerDocument);
        });
      });
      // An embed that is taken out of the document and put back keeps its scroll position.
      const scroller = child.pdfViewer!.dom.viewerContainerEl;
      let left = 0, top = 0;
      scroller.addEventListener("scroll", () => { if (scroller.isConnected) { left = scroller.scrollLeft; top = scroller.scrollTop; } }, { passive: true });
      const observer = new MutationObserver(() => { if (scroller.isConnected && (left || top) && !scroller.scrollLeft && !scroller.scrollTop) { scroller.scrollLeft = left; scroller.scrollTop = top; } });
      observer.observe(this.containerEl.ownerDocument.body, { childList: true, subtree: true });
      this.register(() => observer.disconnect());
    });
  }

  override onload(): void {
    this.registerEvent(this.app.vault.on("modify", file => { if (file === this.file) void this.loadFile(); }));
    // Wait for pdf.js and the viewer child to finish initialization before the
    // first read. This also makes dynamically rendered hover previews load.
    this.viewer.then(child => { void child.loadFile(this.file, this.subpath); });
  }

  loadFile(): Promise<void> { return this.viewer.loadFile(this.file, this.subpath); }
}

/** The menu of a link's target, as `Workspace.handleLinkContextMenu` builds it in the reference. */
function linkMenu(app: App, menu: Menu, linktext: string, sourcePath: string): boolean {
  if (!linktext) return false;
  const destination = app.metadataCache.getFirstLinkpathDest(linktext.split("#", 1)[0], sourcePath);
  const file = destination ? app.vault.getAbstractFileByPath(destination.path) : null;
  if (!(file instanceof TFile)) return false;
  menu.addSections(["open", "action"]);
  menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-in-new-tab")).setIcon("lucide-file-plus").onClick(() => { void app.workspace.openLinkText(linktext, sourcePath, "tab"); }));
  menu.addItem(item => item.setSection("open").setTitle(t("interface.menu.open-to-the-right")).setIcon("lucide-separator-vertical").onClick(() => { void app.workspace.openLinkText(linktext, sourcePath, "split"); }));
  app.workspace.trigger("file-menu", menu, file, "link-context-menu");
  return true;
}

/** Renders a PDF embed into `el`; the returned component owns the viewer. */
export function renderPdfEmbed(app: App, file: TFile, el: HTMLElement, options: { sourcePath: string; subpath: string; linktext?: string }): PdfEmbed {
  const linktext = options.linktext?.split("#", 1)[0] || file.name;
  el.addClass("internal-embed");
  el.setAttr("src", `${linktext}${options.subpath}`);
  el.setAttr("alt", options.subpath ? `${linktext} > ${options.subpath.substring(1)}` : linktext);
  const embed = new PdfEmbed({ app, containerEl: el, linktext: `${file.path}${options.subpath}`, sourcePath: options.sourcePath }, file, options.subpath);
  el.addClass("is-loaded");
  embed.register(() => { el.removeClass("pdf-embed"); });
  return embed;
}

/**
 * Registers the PDF view for `.pdf` files and the PDF embed renderer, and passes a link's subpath
 * (`[[file.pdf#page=3]]`) to the view as ephemeral state, which is how the reference tells a view where to go.
 */
export function installPdfSupport(app: App): () => void {
  const workspace = app.workspace;
  workspace.registerView(PDF_VIEW_TYPE, leaf => new PdfFileView(leaf));
  workspace.registerExtensions(["pdf"], PDF_VIEW_TYPE);
  const removeEmbed = registerFileEmbedRenderer(app, "pdf", (file, el, options) => renderPdfEmbed(app, file, el, options));
  const openLinkText = workspace.openLinkText;
  const forwarding = async function (this: typeof workspace, linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState): Promise<void> {
    const target = linktext.split("|", 1)[0].trim(), separator = target.indexOf("#");
    if (separator > 0 && /\.pdf$/i.test(target.slice(0, separator))) {
      let subpath = target.slice(separator);
      try { subpath = decodeURIComponent(subpath); } catch { /* Keep the literal subpath. */ }
      openViewState = { ...openViewState, eState: { ...openViewState?.eState, subpath } };
    }
    return openLinkText.call(this, linktext, sourcePath, newLeaf, openViewState);
  };
  workspace.openLinkText = forwarding;
  return () => {
    removeEmbed();
    workspace.unregisterExtensions(PDF_VIEW_TYPE); workspace.unregisterView(PDF_VIEW_TYPE);
    if (workspace.openLinkText === forwarding) workspace.openLinkText = openLinkText;
  };
}
