import { process } from "../../platforms/platform";
import { Component } from "./component";
import { setIcon } from "./utilities";
import { currentDocument } from "./ui";

/** Document-owned image gallery; remains usable after its originating preview closes. */
export class ImageLightbox extends Component {
  readonly containerEl: HTMLElement;
  private readonly media: HTMLElement;
  private readonly title: HTMLElement;
  private readonly wrappers: HTMLElement[];
  private index: number;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private spaceHeld = false;
  private drag: { id: number; x: number; y: number; time: number; moved: boolean } | null = null;
  private velocityX = 0;
  private velocityY = 0;
  private momentumFrame: number | null = null;
  private ignoreClick = false;
  private readonly previousFocus: HTMLElement | null;
  private readonly background: HTMLElement;
  private readonly titlebar: HTMLElement;
  private readonly initialIndex: number;
  private readonly initialSource: HTMLImageElement;
  private readonly animations = new Set<Animation>();
  private closing = false;
  private openedAt = 0;
  private readonly touches = new Map<number, { x: number; y: number }>();
  private touchStart = { x: 0, y: 0, previousX: 0, previousY: 0, time: 0 };
  private gesture: "none" | "pan" | "swipe" | "dismiss" | "pinch" = "none";
  private touchVelocity = 0;
  private pinch: { distance: number; zoom: number; x: number; y: number; panX: number; panY: number } | null = null;
  private pinchClosing = false;
  private lastTap = { time: 0, x: 0, y: 0 };
  private readonly closeButton: HTMLElement;
  private lastTouchAt = 0;

  constructor(private readonly sources: HTMLImageElement[], source: HTMLImageElement) {
    super();
    const doc = currentDocument();
    this.previousFocus = doc.activeElement as HTMLElement | null;
    const make = (parent: HTMLElement, cls: string) => { const el = doc.createElement("div"); el.className = cls; parent.append(el); return el; };
    this.index = Math.max(0, sources.indexOf(source));
    this.initialIndex = this.index; this.initialSource = source;
    this.containerEl = doc.createElement("div"); this.containerEl.className = "lightbox"; this.containerEl.tabIndex = -1;
    this.background = make(this.containerEl, "lightbox-bg"); this.background.style.opacity = "0";
    const content = make(this.containerEl, "lightbox-content");
    this.media = make(content, "lightbox-media"); make(content, "lightbox-controls");
    this.titlebar = make(this.containerEl, "lightbox-titlebar"); this.titlebar.style.opacity = "0";
    this.title = make(this.titlebar, "lightbox-titlebar-text");
    const close = make(this.containerEl, "modal-close-button mod-raised clickable-icon"); setIcon(close, "x");
    this.closeButton = close;
    this.wrappers = sources.map(original => {
      const wrapper = doc.createElement("div"); wrapper.className = "media-wrapper";
      const image = doc.createElement("img"); image.src = original.src; image.alt = original.alt; image.draggable = false; image.decoding = "async";
      wrapper.append(image); return wrapper;
    });
    this.showImage();
    this.registerDomEvent(close, "click", () => this.close());
    if (doc.defaultView) this.registerDomEvent(doc.defaultView, "pagehide", () => this.unload());
    this.registerDomEvent(this.media, "click", event => { if (this.ignoreClick) { this.ignoreClick = false; event.preventDefault(); event.stopImmediatePropagation(); return; } if ((event.target as Node).nodeName !== "IMG") this.close(); });
    this.registerDomEvent(this.containerEl, "keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.close(); }
      else if (event.key === " ") { event.preventDefault(); if (!event.repeat) this.spaceHeld = true; }
      else if (event.key === "=" || event.key === "-") {
        event.preventDefault(); const up = event.key === "=";
        this.zoom = Math.min(10, Math.max(1, (up ? Math.ceil : Math.floor)(10 * Number((this.zoom * (up ? 1.2 : 1 / 1.2)).toFixed(2))) / 10));
        if (this.zoom === 1) this.panX = this.panY = 0;
        this.applyZoom();
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); this.navigate(event.key === "ArrowRight" ? 1 : -1); }
    });
    this.registerDomEvent(this.containerEl, "keyup", event => { if (event.key === " " && this.spaceHeld) { event.preventDefault(); this.close(); } });
    this.registerDomEvent(content, "wheel", event => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault(); const old = this.zoom, delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1);
        const mac = typeof process !== "undefined" && process.platform === "darwin";
        this.zoom = Math.min(10, Math.max(1, old - delta / 150 * (mac && !Number.isInteger(event.deltaY) ? 2 : 1)));
        const rect = this.media.getBoundingClientRect(), x = event.clientX - rect.left - rect.width / 2, y = event.clientY - rect.top - rect.height / 2;
        this.panX = (this.panX - x) * this.zoom / old + x; this.panY = (this.panY - y) * this.zoom / old + y;
        if (this.zoom === 1) this.panX = this.panY = 0;
        this.applyZoom();
      } else if (this.zoom > 1) { event.preventDefault(); this.panX -= 1.5 * event.deltaX; this.panY -= 1.5 * event.deltaY; this.applyZoom(); }
    }, { passive: false });
    this.registerDomEvent(this.media, "dblclick", event => {
      if ((event.target as Node).nodeName !== "IMG") return;
      const compatibility = event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean }; pointerType?: string };
      if (Date.now() - this.openedAt < 300 || Date.now() - this.lastTouchAt < 400 || compatibility.sourceCapabilities?.firesTouchEvents || compatibility.pointerType && compatibility.pointerType !== "mouse") return;
      this.doubleZoom(event.clientX, event.clientY);
    });
    this.registerDomEvent(this.media, "pointerdown", event => {
      if (event.pointerType === "touch") { this.touchDown(event); return; }
      if (event.button !== 0 || this.zoom <= 1 || (event.target as Node).nodeName !== "IMG") return;
      this.stopMomentum();
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, moved: false };
      this.media.setPointerCapture(event.pointerId); doc.body.classList.add("is-grabbing");
    });
    this.registerDomEvent(this.media, "pointermove", event => {
      if (event.pointerType === "touch") { this.touchMove(event); return; }
      if (this.drag?.id !== event.pointerId) return;
      const x = event.clientX - this.drag.x, y = event.clientY - this.drag.y, elapsed = event.timeStamp - this.drag.time;
      if (elapsed > 0) { this.velocityX = 0.5 * x / elapsed + 0.5 * this.velocityX; this.velocityY = 0.5 * y / elapsed + 0.5 * this.velocityY; }
      this.drag.moved ||= x !== 0 || y !== 0;
      this.panX += x; this.panY += y; this.drag.x = event.clientX; this.drag.y = event.clientY; this.drag.time = event.timeStamp; this.applyZoom();
    });
    const endDrag = () => { this.drag = null; doc.body.classList.remove("is-grabbing"); };
    this.registerDomEvent(this.media, "pointerup", event => { if (event.pointerType === "touch") { this.touchEnd(event, false); return; } if (this.drag) { this.ignoreClick = this.drag.moved; endDrag(); this.startMomentum(); } });
    this.registerDomEvent(this.media, "pointercancel", event => { if (event.pointerType === "touch") { this.touchEnd(event, true); return; } endDrag(); this.stopMomentum(); });
    this.register(() => { this.stopMomentum(); for (const animation of this.animations) animation.cancel(); this.animations.clear(); endDrag(); this.containerEl.remove(); if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true }); });
    this.load(); doc.body.append(this.containerEl); this.containerEl.focus({ preventScroll: true });
    this.openedAt = Date.now();
    const image = this.wrappers[this.index].firstElementChild as HTMLImageElement;
    image.style.opacity = "0";
    const open = () => doc.defaultView?.requestAnimationFrame(() => {
      if (!this.isLoaded() || this.closing) return;
      const transform = this.sourceTransform(image, true);
      image.style.opacity = "";
      image.style.transform = transform;
      doc.defaultView?.requestAnimationFrame(() => {
        if (!this.isLoaded() || this.closing) return;
        void this.animate(this.background, "opacity", "0", "0.9");
        void this.animate(this.titlebar, "opacity", "0", "1", 200, "");
        void this.animate(image, "transform", transform, "translate(0px, 0px) scale(1)", 200, "");
      });
    });
    if (image.complete && image.naturalWidth > 0) open(); else this.registerDomEvent(image, "load", open, { once: true });
  }

  private sourceTransform(image: HTMLElement, opening: boolean): string {
    const source = this.initialSource.getBoundingClientRect(), target = image.getBoundingClientRect();
    const padding = parseFloat(image.ownerDocument.defaultView!.getComputedStyle(image).paddingLeft) || 0;
    const width = target.width - 2 * padding, height = target.height - 2 * padding;
    const scale = width > 0 && height > 0 ? (opening ? Math.max : Math.min)(source.width / width, source.height / height) : 1;
    return `translate(${source.left + source.width / 2 - target.left - target.width / 2}px, ${source.top + source.height / 2 - target.top - target.height / 2}px) scale(${scale})`;
  }
  private async animate(el: HTMLElement, property: string, from: string, to: string, duration = 200, finalValue = to): Promise<void> {
    const animation = el.animate([{ [property]: from }, { [property]: to }], { duration, easing: "cubic-bezier(0.4, 0, 0.22, 1)", fill: "both" });
    this.animations.add(animation);
    try { await animation.finished; if (this.isLoaded()) el.style.setProperty(property, finalValue); } catch { /* Owner unload cancels animation. */ }
    finally { this.animations.delete(animation); animation.cancel(); }
  }
  private close(): void {
    if (this.closing || !this.isLoaded()) return;
    this.closing = true;
    this.stopMomentum();
    if (this.index !== this.initialIndex || this.zoom !== 1) { this.unload(); return; }
    const image = this.wrappers[this.index].firstElementChild as HTMLElement;
    void this.animate(this.background, "opacity", "0.9", "0");
    void this.animate(this.titlebar, "opacity", "1", "0");
    void this.animate(image, "transform", "translate(0px, 0px) scale(1)", this.sourceTransform(image, false)).then(() => this.unload());
  }

  private showImage(): void {
    this.media.replaceChildren(this.wrappers[this.index]);
    this.updateTitle();
  }
  private updateTitle(): void {
    const source = this.sources[this.index];
    let filename = ""; try { if (!source.src.startsWith("data:")) filename = decodeURIComponent(new URL(source.src).pathname.split("/").at(-1) ?? ""); } catch { /* Invalid URLs have no fallback name. */ }
    this.title.textContent = source.title || source.alt || filename;
  }
  private navigate(delta: number): void {
    this.stopMomentum();
    this.index = (this.index + delta + this.sources.length) % this.sources.length;
    this.zoom = 1; this.panX = this.panY = 0; this.showImage(); this.applyZoom();
  }
  private applyZoom(): void {
    const image = this.wrappers[this.index].firstElementChild as HTMLElement;
    const maxX = Math.max(0, (image.offsetWidth * this.zoom - this.media.offsetWidth) / 2), maxY = Math.max(0, (image.offsetHeight * this.zoom - this.media.offsetHeight) / 2);
    this.panX = Math.min(maxX, Math.max(-maxX, this.panX)); this.panY = Math.min(maxY, Math.max(-maxY, this.panY));
    this.containerEl.classList.toggle("is-zoomed", this.zoom > 1);
    image.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }
  private stopMomentum(): void {
    if (this.momentumFrame !== null) this.containerEl.ownerDocument.defaultView?.cancelAnimationFrame(this.momentumFrame);
    this.momentumFrame = null; this.velocityX = this.velocityY = 0;
  }
  private touchDown(event: PointerEvent): void {
    this.lastTouchAt = Date.now();
    this.stopMomentum(); this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      if (this.gesture === "dismiss") this.resetTouchTransform();
      this.gesture = "pinch";
      this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, panX: this.panX, panY: this.panY };
    } else if (this.touches.size === 1) {
      this.touchStart = { x: event.clientX, y: event.clientY, previousX: event.clientX, previousY: event.clientY, time: event.timeStamp };
      this.touchVelocity = 0; this.gesture = "none";
    }
  }
  private touchMove(event: PointerEvent): void {
    this.lastTouchAt = Date.now();
    if (!this.touches.has(event.pointerId)) return;
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.gesture === "pinch" && this.pinch && this.touches.size === 2) {
      event.preventDefault(); const [a, b] = [...this.touches.values()], start = this.pinch;
      if (start.distance <= 0) return;
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / start.distance;
      if (start.zoom <= 1 && ratio < 1) {
        this.pinchClosing = true; this.containerEl.classList.add("is-dismissing"); this.zoom = Math.max(0.1, ratio); this.panX = this.panY = 0;
        const opacity = Math.max(0.1, (this.zoom - 0.3) / 0.7); this.background.style.opacity = String(0.9 * opacity); this.closeButton.style.opacity = String(opacity);
      } else {
        if (this.pinchClosing) { this.pinchClosing = false; this.containerEl.classList.remove("is-dismissing"); this.background.style.opacity = "0.9"; this.closeButton.style.opacity = ""; }
        const rect = this.media.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        this.zoom = Math.max(1, Math.min(10, start.zoom * ratio));
        this.panX = (a.x + b.x) / 2 - x - (start.x - x - start.panX) / start.zoom * this.zoom;
        this.panY = (a.y + b.y) / 2 - y - (start.y - y - start.panY) / start.zoom * this.zoom;
      }
      this.applyZoom(); return;
    }
    if (this.touches.size !== 1 || this.gesture === "pinch") return;
    const start = this.touchStart, x = event.clientX - start.x, y = event.clientY - start.y;
    if (this.gesture === "none" || this.gesture === "pan") {
      const image = this.wrappers[this.index].firstElementChild as HTMLElement;
      const bound = Math.max(0, (image.offsetWidth * this.zoom - this.media.offsetWidth) / 2);
      if (Math.abs(x) > 20 && Math.abs(x) > 2.5 * Math.abs(y) && (this.zoom <= 1 || x > 0 && this.panX >= bound - 10 || x < 0 && this.panX <= 10 - bound)) this.gesture = "swipe";
      else if (this.zoom <= 1 && y > 20 && Math.abs(y) > 1.5 * Math.abs(x)) { this.gesture = "dismiss"; this.containerEl.classList.add("is-dismissing"); }
      else if (this.zoom > 1 && Math.hypot(x, y) >= 5) this.gesture = "pan";
    }
    const elapsed = event.timeStamp - start.time;
    if (this.gesture === "swipe" || this.gesture === "dismiss") {
      event.preventDefault(); const vertical = this.gesture === "dismiss";
      if (elapsed > 0) this.touchVelocity = 0.5 * ((vertical ? event.clientY - start.previousY : event.clientX - start.previousX) / elapsed) + 0.5 * this.touchVelocity;
      this.wrappers[this.index].style.transform = vertical ? `translateY(${Math.max(0, y)}px)` : `translateX(${x}px)`;
      if (vertical) { const opacity = Math.max(0.1, 1 - Math.max(0, y) / (0.6 * this.containerEl.offsetHeight)); this.background.style.opacity = String(0.9 * opacity); this.closeButton.style.opacity = String(opacity); }
    } else if (this.gesture === "pan") {
      event.preventDefault(); const dx = event.clientX - start.previousX, dy = event.clientY - start.previousY;
      if (elapsed > 0) { this.velocityX = 0.5 * dx / elapsed + 0.5 * this.velocityX; this.velocityY = 0.5 * dy / elapsed + 0.5 * this.velocityY; }
      this.panX += dx; this.panY += dy; this.applyZoom();
    }
    start.previousX = event.clientX; start.previousY = event.clientY; start.time = event.timeStamp;
  }
  private resetTouchTransform(): void {
    const wrapper = this.wrappers[this.index];
    void this.animate(wrapper, "transform", wrapper.style.transform || "none", "translate(0px, 0px)", 200, "");
    this.containerEl.classList.remove("is-dismissing");
    void this.animate(this.background, "opacity", this.background.style.opacity || "0.9", "0.9");
    void this.animate(this.closeButton, "opacity", this.closeButton.style.opacity || "1", "1", 200, "");
  }
  private touchEnd(event: PointerEvent, cancelled: boolean): void {
    this.lastTouchAt = Date.now();
    this.touches.delete(event.pointerId);
    if (this.gesture === "pinch" && this.touches.size < 2) {
      this.gesture = "none"; this.pinch = null;
      if (!cancelled && this.pinchClosing) {
        this.pinchClosing = false;
        if (this.zoom < 0.75) { this.gestureDismiss(true); return; }
        const image = this.wrappers[this.index].firstElementChild as HTMLElement, transform = image.style.transform;
        this.zoom = 1; this.panX = this.panY = 0; this.applyZoom(); this.resetTouchTransform();
        void this.animate(image, "transform", transform, image.style.transform, 250);
      }
      if (this.touches.size === 1) { const point = [...this.touches.values()][0]; this.touchStart.x = point.x; this.touchStart.y = point.y; }
    }
    if (this.touches.size) return;
    const gesture = this.gesture, x = event.clientX - this.touchStart.x, y = event.clientY - this.touchStart.y;
    if (cancelled) { if (gesture === "swipe" || gesture === "dismiss") this.resetTouchTransform(); this.stopMomentum(); }
    else if (gesture === "swipe") {
      const fast = Math.abs(this.touchVelocity) > 0.4 && (this.zoom <= 1 || Math.abs(x) > 0.1 * this.media.clientWidth);
      if (this.sources.length > 1 && (fast || Math.abs(x) > 0.33 * this.media.clientWidth)) this.swipeNavigate((fast ? this.touchVelocity : x) > 0 ? -1 : 1, x);
      else this.resetTouchTransform();
    } else if (gesture === "dismiss") {
      if (this.touchVelocity > 0.4 || y > 0.33 * this.media.clientHeight) { this.gestureDismiss(false); return; }
      this.resetTouchTransform();
    } else if (gesture === "pan") this.startMomentum();
    else if (Math.abs(x) < 10 && Math.abs(y) < 10) {
      if (event.timeStamp - this.lastTap.time < 300 && Math.hypot(event.clientX - this.lastTap.x, event.clientY - this.lastTap.y) < 40) {
        this.lastTap.time = 0;
        this.doubleZoom(event.clientX, event.clientY);
      } else this.lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    }
    this.gesture = "none";
  }
  private gestureDismiss(pinch: boolean): void {
    this.closing = true; this.stopMomentum();
    const target = pinch ? this.wrappers[this.index].firstElementChild as HTMLElement : this.wrappers[this.index];
    const duration = pinch ? 150 : Math.max(80, Math.round(300 * (1 - Math.max(0, this.touchStart.previousY - this.touchStart.y) / (this.containerEl.offsetHeight + 50))));
    void this.animate(target, "transform", target.style.transform || "none", pinch ? "scale(0.25)" : `translateY(${this.containerEl.offsetHeight + 50}px)`, duration);
    if (pinch) void this.animate(target, "opacity", "1", "0", duration);
    void this.animate(this.closeButton, "opacity", this.closeButton.style.opacity || "1", "0", duration);
    void this.animate(this.background, "opacity", this.background.style.opacity || "0.9", "0", duration).then(() => this.unload());
  }
  private doubleZoom(x: number, y: number): void {
    const image = this.wrappers[this.index].firstElementChild as HTMLElement, previous = image.style.transform || "translate(0px, 0px) scale(1)";
    if (this.zoom > 1) { this.zoom = 1; this.panX = this.panY = 0; }
    else { const rect = this.media.getBoundingClientRect(); this.zoom = 2.5; this.panX = -2.5 * (x - rect.left - rect.width / 2); this.panY = -2.5 * (y - rect.top - rect.height / 2); }
    this.applyZoom(); void this.animate(image, "transform", previous, image.style.transform, 250);
  }
  private swipeNavigate(delta: number, offset: number): void {
    const outgoing = this.wrappers[this.index];
    this.index = (this.index + delta + this.sources.length) % this.sources.length; this.updateTitle();
    const incoming = this.wrappers[this.index], distance = this.media.offsetWidth + 50;
    const duration = Math.max(80, Math.round(300 * Math.max(0, 1 - Math.abs(offset) / distance)));
    outgoing.classList.add("is-sliding"); incoming.classList.add("is-sliding");
    incoming.style.transition = ""; incoming.style.transform = ""; this.media.append(incoming);
    void this.animate(outgoing, "transform", `translateX(${offset}px)`, `translateX(${delta < 0 ? distance : -distance}px)`, duration, "").then(() => {
      (outgoing.firstElementChild as HTMLElement).style.transform = ""; outgoing.remove(); outgoing.classList.remove("is-sliding");
    });
    void this.animate(incoming, "opacity", "0", "1", 250, "");
    void this.animate(incoming, "transform", `translateX(${delta < 0 ? "-20%" : "20%"})`, "translateX(0px)", 250, "").then(() => {
      if (!this.isLoaded()) return;
      incoming.classList.remove("is-sliding"); this.zoom = 1; this.panX = this.panY = 0; this.applyZoom();
    });
  }
  private startMomentum(): void {
    if (Math.hypot(this.velocityX, this.velocityY) < 0.03) return;
    const win = this.containerEl.ownerDocument.defaultView!;
    let previous: number | null = null;
    const step = (time: number) => {
      if (!this.isLoaded()) return;
      const elapsed = previous === null ? 16 : time - previous; previous = time;
      this.panX += this.velocityX * elapsed; this.panY += this.velocityY * elapsed;
      const decay = Math.pow(0.5, elapsed / 200); this.velocityX *= decay; this.velocityY *= decay;
      this.applyZoom();
      if (this.velocityX ** 2 + this.velocityY ** 2 < (0.1 / 16) ** 2) this.stopMomentum();
      else this.momentumFrame = win.requestAnimationFrame(step);
    };
    this.momentumFrame = win.requestAnimationFrame(step);
  }
}
