/** DOM helpers used by Obsidian plugins. Prototype helpers are installed explicitly. */

export type DomAttributeValue = string | number | boolean | null;

export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, DomAttributeValue>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

export interface DomElementExtensions {
  empty(): void;
  detach(): void;
  getText(): string;
  setText(value: string | DocumentFragment): void;
  addClass(...classes: string[]): void;
  addClasses(classes: string[]): void;
  removeClass(...classes: string[]): void;
  removeClasses(classes: string[]): void;
  toggleClass(classes: string | string[], value: boolean): void;
  hasClass(cls: string): boolean;
  setAttr(name: string, value: DomAttributeValue): void;
  setAttrs(attrs: Record<string, DomAttributeValue>): void;
  getAttr(name: string): string | null;
  setCssProps(props: Record<string, string>): void;
}

declare global {
  interface Element extends DomElementExtensions {}
  interface HTMLElement extends DomElementExtensions {}
  interface Node {
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, info?: DomElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
    createDiv(info?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(info?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
  }
}

function normalizeInfo(info?: DomElementInfo | string): DomElementInfo {
  return typeof info === "string" ? { cls: info } : info ?? {};
}

function applyInfo<T extends HTMLElement>(element: T, info: DomElementInfo, parent?: Node): T {
  if (info.cls) element.classList.add(...(Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/)).filter(Boolean));
  if (info.text !== undefined) element.replaceChildren(typeof info.text === "string" ? element.ownerDocument.createTextNode(info.text) : info.text);
  if (info.title !== undefined) element.title = info.title;
  if (info.value !== undefined && "value" in element) (element as unknown as HTMLInputElement).value = info.value;
  if (info.type !== undefined && "type" in element) (element as unknown as HTMLInputElement).type = info.type;
  if (info.placeholder !== undefined && "placeholder" in element) (element as unknown as HTMLInputElement).placeholder = info.placeholder;
  if (info.href !== undefined && "href" in element) (element as unknown as HTMLAnchorElement).href = info.href;
  if (info.attr) setAttrs(element, info.attr);
  const target = info.parent ?? parent;
  if (target) info.prepend ? target.insertBefore(element, target.firstChild) : target.appendChild(element);
  return element;
}

export function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, info?: DomElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
  if (typeof document === "undefined") throw new Error("createEl requires a DOM document");
  const element = applyInfo(document.createElement(tag), normalizeInfo(info));
  callback?.(element);
  return element;
}

export function createDiv(info?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement {
  return createEl("div", info, callback);
}

export function createSpan(info?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement {
  return createEl("span", info, callback);
}

export function empty(node: Node): void { while (node.firstChild) node.removeChild(node.firstChild); }
export function setCssProps(element: HTMLElement | SVGElement, props: Record<string, string>): void {
  for (const [name, value] of Object.entries(props)) element.style.setProperty(name, value);
}
export function setAttr(element: Element, name: string, value: DomAttributeValue): void {
  if (value === null || value === false) element.removeAttribute(name);
  else element.setAttribute(name, value === true ? "" : String(value));
}
export function setAttrs(element: Element, attrs: Record<string, DomAttributeValue>): void {
  for (const [name, value] of Object.entries(attrs)) setAttr(element, name, value);
}

/** Parse HTML into a detached fragment after removing executable elements and attributes. */
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  if (typeof document === "undefined" || typeof DOMParser === "undefined") throw new Error("sanitizeHTMLToDom requires a DOM document");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, iframe, object, embed, base, meta[http-equiv], form").forEach(element => element.remove());
  for (const element of Array.from(parsed.body.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLocaleLowerCase();
      if (name.startsWith("on") || name === "srcdoc") { element.removeAttribute(attribute.name); continue; }
      if (["href", "src", "xlink:href", "action", "formaction"].includes(name) && /^\s*(?:javascript|vbscript|data):/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const fragment = document.createDocumentFragment();
  while (parsed.body.firstChild) {
    const child = parsed.body.firstChild;
    fragment.appendChild(document.importNode(child, true));
    parsed.body.removeChild(child);
  }
  return fragment;
}

const installed = new WeakMap<object, WeakSet<object>>();
/** Install the common element methods on a DOM realm's prototypes; safe to call repeatedly. */
export function installDomExtensions(win: Window = window): void {
  const proto = (win as unknown as { Element: typeof Element }).Element.prototype;
  const nodeProto = (win as unknown as { Node: typeof Node }).Node.prototype;
  let nodePrototypes = installed.get(proto);
  if (!nodePrototypes) { nodePrototypes = new WeakSet<object>(); installed.set(proto, nodePrototypes); }
  if (nodePrototypes.has(nodeProto)) return;
  nodePrototypes.add(nodeProto);
  const methods: Partial<DomElementExtensions> = {
    empty(this: Element) { this.replaceChildren(); },
    detach(this: Element) { this.remove(); },
    getText(this: Element) { return this.textContent ?? ""; },
    setText(this: Element, value: string | DocumentFragment) { this.replaceChildren(typeof value === "string" ? this.ownerDocument.createTextNode(value) : value); },
    addClass(this: Element, ...classes: string[]) { this.classList.add(...classes.flatMap((c) => c.split(/\s+/)).filter(Boolean)); },
    addClasses(this: Element, classes: string[]) { this.classList.add(...classes.flatMap((c) => c.split(/\s+/)).filter(Boolean)); },
    removeClass(this: Element, ...classes: string[]) { this.classList.remove(...classes.flatMap((c) => c.split(/\s+/)).filter(Boolean)); },
    removeClasses(this: Element, classes: string[]) { this.classList.remove(...classes.flatMap((c) => c.split(/\s+/)).filter(Boolean)); },
    toggleClass(this: Element, classes: string | string[], value: boolean) { for (const name of (Array.isArray(classes) ? classes : [classes]).flatMap((c) => c.split(/\s+/)).filter(Boolean)) this.classList.toggle(name, value); },
    hasClass(this: Element, cls: string) { return this.classList.contains(cls); },
    setAttr(this: Element, name: string, value: DomAttributeValue) { setAttr(this, name, value); },
    setAttrs(this: Element, attrs: Record<string, DomAttributeValue>) { setAttrs(this, attrs); },
    getAttr(this: Element, name: string) { return this.getAttribute(name); },
    setCssProps(this: HTMLElement, props: Record<string, string>) { setCssProps(this, props); },
  };
  for (const [name, fn] of Object.entries(methods)) {
    if (!(name in proto)) Object.defineProperty(proto, name, { configurable: true, writable: true, value: fn });
  }
  const creators = {
    createEl<K extends keyof HTMLElementTagNameMap>(this: Node, tag: K, info?: DomElementInfo | string, callback?: (el: HTMLElementTagNameMap[K]) => void) {
      if (!this.ownerDocument && this.nodeType !== 9) throw new Error("Cannot create an element without an owner document");
      const doc = this.nodeType === 9 ? this as Document : this.ownerDocument!;
      const element = applyInfo(doc.createElement(tag), normalizeInfo(info), this);
      callback?.(element);
      return element;
    },
    createDiv(this: Node, info?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void) { const el = this.createEl("div", info); callback?.(el); return el; },
    createSpan(this: Node, info?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void) { const el = this.createEl("span", info); callback?.(el); return el; },
  };
  for (const [name, fn] of Object.entries(creators)) {
    if (!(name in nodeProto)) Object.defineProperty(nodeProto, name, { configurable: true, writable: true, value: fn });
  }
}
