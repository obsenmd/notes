import { detachEventRef, type EventRef } from "./events";
import { createEl, createDiv, createSpan, empty, setCssProps, setAttr, setAttrs, sanitizeHTMLToDom, installDomExtensions } from "./dom";

type Cleanup = () => unknown;

export class Component {
  private loaded = false;
  private loading = false;
  private unloading = false;
  private cleanups: Cleanup[] = [];
  private children: Component[] = [];

  get dom(): typeof import("./dom") { return { createEl, createDiv, createSpan, empty, setCssProps, setAttr, setAttrs, sanitizeHTMLToDom, installDomExtensions }; }

  registerEvent(eventRef: EventRef): void {
    this.register(() => detachEventRef(eventRef));
  }

  load(): void {
    if (this.loaded || this.loading || this.unloading) return;
    this.loading = true;
    this.loaded = true;
    try {
      this.onload();
      for (const child of this.children) child.load();
    } catch (error) {
      try {
        this.unload();
      } catch (unloadError) {
        throw new AggregateError([error, unloadError], "Component failed to load and unload cleanly.");
      }
      throw error;
    } finally {
      this.loading = false;
    }
  }

  isLoaded(): boolean { return this.loaded; }
  /** @internal Async plugin startup invokes onload separately; still track its active lifecycle. */
  markLoaded(): void { this.loaded = true; }
  registerDomEventSelector<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    selector: string,
    type: K,
    callback: (this: HTMLElement, event: HTMLElementEventMap[K], delegateTarget: HTMLElement) => unknown,
  ): void {
    const listener = (event: Event) => {
      const origin = event.target instanceof Element ? event.target.closest(selector) : null;
      if (origin && el.contains(origin)) callback.call(origin as HTMLElement, event as HTMLElementEventMap[K], origin as HTMLElement);
    };
    el.addEventListener(type, listener);
    this.register(() => el.removeEventListener(type, listener));
  }

  onload(): void {}

  unload(): void {
    if (this.unloading || (!this.loaded && this.cleanups.length === 0 && this.children.length === 0)) return;
    this.unloading = true;
    this.loaded = false;
    const errors: unknown[] = [];
    const children = this.children.splice(0).reverse();
    for (const child of children) {
      try {
        child.unload();
      } catch (error) {
        errors.push(error);
      }
    }
    const cleanups = this.cleanups.splice(0).reverse();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.onunload();
    } catch (error) {
      errors.push(error);
    } finally {
      this.unloading = false;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Component failed to unload cleanly.");
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    if ((component as Component) === this || this.children.includes(component)) return component;
    this.children.push(component);
    if (this.loaded) component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      this.children.splice(index, 1);
      component.unload();
    }
    return component;
  }

  register(cb: () => unknown): void {
    this.cleanups.push(cb);
  }

  registerDomEvent<K extends keyof WindowEventMap>(
    el: Window,
    type: K,
    callback: (this: HTMLElement, event: WindowEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent<K extends keyof DocumentEventMap>(
    el: Document,
    type: K,
    callback: (this: HTMLElement, event: DocumentEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    callback: (this: HTMLElement, event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: ((this: HTMLElement, event: never) => unknown) | EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const listener = callback as EventListenerOrEventListenerObject;
    el.addEventListener(type, listener, options);
    this.register(() => el.removeEventListener(type, listener, options));
  }

  registerInterval(id: number): number {
    this.register(() => window.clearInterval(id));
    return id;
  }
}
