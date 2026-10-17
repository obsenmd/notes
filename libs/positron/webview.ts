import { EventEmitter } from "node:events";
import { session } from "./session";

export interface BrowserWebview extends HTMLElement {
  src: string;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  isLoading(): boolean;
  stop(): void;
  reload(): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  getWebContentsId(): number;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: string): void;
  executeJavaScript(code: string): Promise<unknown>;
}
let sequence = 1000;
export class BrowserWebContents extends EventEmitter {
  readonly id = ++sequence;
  noContextMenu = false;
  private destroyed = false;
  ignoreMenuShortcuts = false;
  isDestroyed(): boolean { return this.destroyed; }
  setIgnoreMenuShortcuts(value: boolean): void { this.ignoreMenuShortcuts = value; }
  destroy(): void { this.destroyed = true; this.emit("destroyed"); this.removeAllListeners(); registry.delete(this.id); }
}
const registry = new Map<number, BrowserWebContents>();
export const webContents = { fromId: (id: number) => registry.get(id) };

/** Browser navigation behind the subset of WebviewTag used by the app. */
export function createBrowserWebview(doc: Document = document, allowRequest: (url: string, partition: string) => Promise<boolean> = (url, partition) => session.fromPartition(partition).allows(url)): BrowserWebview {
  const host = doc.createElement("div") as unknown as BrowserWebview;
  host.className = "positron-webview";
  Object.assign(host.style, { flex: "1", minHeight: "0", width: "100%", height: "100%", overflow: "hidden", position: "relative" });
  const frame = doc.createElement("iframe"); frame.title = "Web page";
  Object.assign(frame.style, { width: "100%", height: "calc(100% - 28px)", display: "block", border: "0", background: "white" });
  frame.setAttribute("allow", "fullscreen; clipboard-write");
  const footer = doc.createElement("div"), external = doc.createElement("a");
  Object.assign(footer.style, { height: "28px", padding: "4px 10px", boxSizing: "border-box", fontSize: "12px", background: "var(--background-secondary)", color: "var(--text-normal)" });
  external.textContent = "Open in browser"; external.target = "_blank"; external.rel = "noopener noreferrer";
  footer.append(external); host.append(frame, footer);
  const contents = new BrowserWebContents(); registry.set(contents.id, contents);
  const currentSession = () => session.fromPartition(host.getAttribute("partition") ?? "default");
  let address = "about:blank", title = "", loading = false, zoom = 1, findId = 0;
  let finish: (() => void) | undefined;
  let navigation = 0;
  let fetched: Document | undefined;
  let fetchController: AbortController | undefined;
  let fetchReady: Promise<void> = Promise.resolve();
  const clearFetched = () => { fetched = undefined; };
  let connectedSession = currentSession();
  connectedSession.on("clear-storage", clearFetched);
  const emit = (name: string, detail: Record<string, unknown> = {}) => host.dispatchEvent(Object.assign(new Event(name), detail));
  const page = (): Document | undefined => { try { return frame.contentDocument ?? undefined; } catch { return undefined; } };
  const complete = () => { loading = false; finish?.(); finish = undefined; emit("did-stop-loading"); emit("did-finish-load"); };
  const wirePage = () => {
    const document = page();
    if (!document) return;
    title = document.title || title;
    if (document.documentElement) document.documentElement.style.setProperty("zoom", String(zoom));
    document.addEventListener("keydown", event => {
      contents.emit("before-input-event", { preventDefault: () => event.preventDefault() }, { type: "keyDown", code: event.code, key: event.key, shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, meta: event.metaKey, isAutoRepeat: event.repeat });
      if (contents.ignoreMenuShortcuts) event.preventDefault();
    });
    document.addEventListener("mousedown", () => contents.emit("input-event", {}, { type: "mouseDown" }));
    document.addEventListener("contextmenu", event => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest<HTMLAnchorElement>("a[href]"), image = target?.closest<HTMLImageElement>("img");
      const context = { linkURL: link?.href, linkText: link?.textContent, selectionText: document.getSelection()?.toString(), isEditable: !!target?.closest("input, textarea, [contenteditable=true]"), mediaType: image ? "image" : "none", srcURL: image?.src };
      if (contents.noContextMenu) event.preventDefault();
      emit("context-menu", { params: context });
    });
  };
  frame.addEventListener("load", () => {
    if (page()?.URL === "about:blank" && address !== "about:blank") return;
    wirePage(); emit("dom-ready"); emit("did-navigate-in-page", { isMainFrame: true, url: address });
    emit("page-title-updated", { title }); complete();
  });
  frame.addEventListener("error", () => { emit("did-fail-load", { isMainFrame: true, url: address, errorCode: -2 }); complete(); });
  const load = async (url: string): Promise<void> => {
    const generation = ++navigation;
    const requested = new URL(url, doc.baseURI).href;
    address = requested;
    host.setAttribute("src", requested);
    if (/^https?:/.test(requested) && !await allowRequest(requested, host.getAttribute("partition") ?? "default")) {
      emit("did-fail-load", { isMainFrame: true, url: requested, errorCode: -20 }); complete(); return;
    }
    if (generation !== navigation) return;
    if (connectedSession !== currentSession()) { connectedSession.off("clear-storage", clearFetched); connectedSession = currentSession(); connectedSession.on("clear-storage", clearFetched); }
    address = new URL(url, doc.baseURI).href;
    fetched = undefined; fetchController?.abort(); title = /^https?:/.test(address) ? new URL(address).hostname : "";
    host.setAttribute("src", address); external.href = address; footer.hidden = !/^https?:/.test(address);
    loading = true; emit("did-start-navigation", { isMainFrame: true, url: address });
    finish?.();
    const ready = new Promise<void>(resolve => { finish = resolve; });
    frame.src = address;
    if (/^https?:|^data:text\/html/.test(address)) {
      fetchController = new AbortController();
      fetchReady = fetch(address, { signal: fetchController.signal }).then(async response => {
        if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
        const source = await response.text();
        if (response.url && response.url !== address) return;
        fetched = new DOMParser().parseFromString(source, "text/html");
        const base = fetched.createElement("base"); base.href = address; fetched.head.prepend(base);
        if (fetched.title) { title = fetched.title; emit("page-title-updated", { title }); }
      }).catch(() => undefined);
    }
    return ready;
  };
  const observer = new MutationObserver(() => {
    const requested = host.getAttribute("src");
    if (requested && requested !== address) void load(requested);
  });
  observer.observe(host, { attributes: true, attributeFilter: ["src"] });
  Object.defineProperty(host, "src", { configurable: true, get: () => address, set: (url: string) => { void load(url); } });
  Object.assign(host, {
    getURL: () => address, getTitle: () => title, getWebContentsId: () => contents.id,
    isLoading: () => loading,
    loadURL: load,
    stop() { navigation++; try { frame.contentWindow?.stop(); } catch { /* Cross-origin frames own their loading state. */ } fetchController?.abort(); complete(); },
    reload() { void load(address); },
    getZoomFactor: () => zoom,
    setZoomFactor(factor: number) { zoom = Math.max(0.25, Math.min(5, factor)); const document = page(); if (document) document.documentElement.style.setProperty("zoom", String(zoom)); else { frame.style.transform = `scale(${zoom})`; frame.style.transformOrigin = "top left"; frame.style.width = `${100 / zoom}%`; frame.style.height = `calc(${100 / zoom}% - 28px)`; } },
    findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }) {
      const id = ++findId;
      const document = page(), source = (document?.body.innerText ?? fetched?.body.textContent ?? "").toLocaleLowerCase();
      const needle = text.toLocaleLowerCase(); let matches = 0, position = -1;
      if (needle) while ((position = source.indexOf(needle, position + 1)) >= 0) matches++;
      try { (frame.contentWindow as (Window & { find?: (value: string, caseSensitive: boolean, backwards: boolean) => boolean }) | null)?.find?.(text, false, options?.forward === false); } catch { /* Count fetched content when the page is cross-origin. */ }
      emit("found-in-page", { result: { requestId: id, finalUpdate: true, matches, activeMatchOrdinal: matches ? 1 : 0 } });
      return id;
    },
    stopFindInPage() { page()?.getSelection()?.removeAllRanges(); },
    async executeJavaScript(code: string): Promise<unknown> {
      if (code.includes("new Readability(")) await fetchReady;
      const document = page();
      if (code.includes("new Readability(") && (document ?? fetched)) {
        const { Readability } = await import("@mozilla/readability");
        return new Readability((document ?? fetched)!.cloneNode(true) as Document).parse();
      }
      if (!document) return undefined;
      const evaluate = (frame.contentWindow as (Window & { eval(source: string): unknown }) | null)?.eval;
      return evaluate?.call(frame.contentWindow, code);
    },
  });
  const originalRemove = host.remove.bind(host);
  host.remove = () => { observer.disconnect(); fetchController?.abort(); connectedSession.off("clear-storage", clearFetched); contents.destroy(); finish?.(); originalRemove(); emit("destroyed"); };
  queueMicrotask(() => { if (navigation === 0 && !host.hasAttribute("src")) void load("about:blank"); });
  return host;
}
