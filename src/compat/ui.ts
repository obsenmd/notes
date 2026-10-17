import { App } from "./plugin";
import { t } from "../i18n";
import { Scope } from "./commands";
import { setIcon } from "./utilities";

/** A small DOM-backed modal implementation for plugins running in the desktop renderer. */
/** The document of the focused application window: Obsidian's `activeDocument` global. */
export function currentDocument(): Document {
  const active = (globalThis as { activeDocument?: Document }).activeDocument;
  return active?.defaultView && !active.defaultView.closed ? active : document;
}
/** Tracks focus so `activeWindow` / `activeDocument` follow the window in use; returns a disposer. */
export function trackActiveWindow(win: Window): () => void {
  const globals = globalThis as { activeWindow?: Window; activeDocument?: Document };
  const activate = () => { globals.activeWindow = win; globals.activeDocument = win.document; };
  if (!globals.activeDocument || win.document.hasFocus()) activate();
  win.addEventListener("focus", activate, true); win.addEventListener("pointerdown", activate, true);
  return () => {
    win.removeEventListener("focus", activate, true); win.removeEventListener("pointerdown", activate, true);
    if (globals.activeWindow === win) { globals.activeWindow = window; globals.activeDocument = document; }
  };
}

export class Modal {
  private static readonly openStack: Modal[] = [];
  /** Pushed on the app keymap while open so workspace hotkeys do not fire behind the modal. */
  readonly scope = new Scope();
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly bgEl: HTMLElement;
  readonly headerEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  shouldRestoreSelection = false;
  private closeCallback?: () => unknown;
  private isOpen = false;
  private previouslyFocused: HTMLElement | null = null;
  private readonly titleId = `obsen-modal-title-${Math.random().toString(36).slice(2)}`;
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.isTopmost()) return;
    if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
    if (event.key !== "Tab") return;

    const focusable = this.getFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      this.modalEl.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.containerEl.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || !this.modalEl.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.modalEl.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  private readonly onWindowClosing = () => this.close();

  private openDocument: Document = document;

  constructor(readonly app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "modal-container mod-dim";
    this.bgEl = document.createElement("div");
    this.bgEl.className = "modal-bg";
    this.bgEl.style.opacity = "0.85";
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    const closeButton = document.createElement("div");
    closeButton.className = "modal-header-button mod-raised clickable-icon";
    setIcon(closeButton, "x");
    closeButton.addEventListener("click", () => this.close());
    this.headerEl = document.createElement("div");
    this.headerEl.className = "modal-header";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "modal-title";
    this.titleEl.id = this.titleId;
    this.modalEl.setAttribute("aria-labelledby", this.titleId);
    this.modalEl.tabIndex = -1;
    this.headerEl.append(this.titleEl);
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.append(closeButton, this.headerEl, this.contentEl);
    this.containerEl.append(this.bgEl, this.modalEl);
    this.bgEl.addEventListener("click", () => { if (this.isTopmost()) this.close(); });
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.previouslyFocused = this.containerEl.ownerDocument.activeElement instanceof HTMLElement
      ? this.containerEl.ownerDocument.activeElement
      : null;
    Modal.openStack.push(this);
    this.app?.keymap?.pushScope(this.scope);
    // Dialogs open in the window the user is working in (a pop-out or the settings window).
    this.openDocument = currentDocument();
    this.openDocument.body.append(this.containerEl);
    this.openDocument.addEventListener("keydown", this.onKeyDown);
    this.openDocument.defaultView?.addEventListener("beforeunload", this.onWindowClosing);
    this.focusInitialElement();
    void this.onOpen();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.openDocument.removeEventListener("keydown", this.onKeyDown);
    this.openDocument.defaultView?.removeEventListener("beforeunload", this.onWindowClosing);
    this.containerEl.remove();
    this.app?.keymap?.popScope(this.scope);
    const wasTopmost = Modal.openStack[Modal.openStack.length - 1] === this;
    const index = Modal.openStack.lastIndexOf(this);
    if (index >= 0) Modal.openStack.splice(index, 1);
    try { this.onClose(); } finally { this.closeCallback?.(); }
    if (wasTopmost) {
      const nextModal = Modal.openStack[Modal.openStack.length - 1];
      const restoreTarget = this.previouslyFocused;
      queueMicrotask(() => {
        if (nextModal?.isOpen) nextModal.focusInitialElement();
        else if (restoreTarget?.isConnected) restoreTarget.focus();
      });
    }
  }

  onOpen(): Promise<void> | void {}
  onClose(): void {}

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  private isTopmost(): boolean {
    return this.isOpen && Modal.openStack[Modal.openStack.length - 1] === this;
  }

  private getFocusableElements(): HTMLElement[] {
    return Array.from(this.modalEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
  }

  private focusInitialElement(): void {
    if (!this.isTopmost()) return;
    (this.getFocusableElements()[0] ?? this.modalEl).focus();
  }

  setContent(content: string | DocumentFragment): this {
    this.contentEl.replaceChildren();
    if (typeof content === "string") this.contentEl.textContent = content;
    else this.contentEl.append(content);
    return this;
  }

  setCloseCallback(callback: () => unknown): this {
    this.closeCallback = callback;
    return this;
  }
}

const noticeContainers = new WeakMap<Document, HTMLElement>();

/** Transient notification stacked in the window's shared notice container. */
export class Notice {
  readonly noticeEl: HTMLElement;
  readonly containerEl: HTMLElement;
  readonly messageEl: HTMLElement;
  private buttonContainerEl: HTMLElement | null = null;
  private timeout?: ReturnType<typeof setTimeout>;
  private hidden = false;

  constructor(message: string | DocumentFragment, duration = 4000) {
    const doc = currentDocument();
    let container = noticeContainers.get(doc);
    if (!container) { container = doc.createElement("div"); container.className = "notice-container"; noticeContainers.set(doc, container); }
    if (!container.isConnected) doc.body.append(container);
    this.containerEl = document.createElement("div");
    this.containerEl.className = "notice";
    this.messageEl = this.noticeEl = document.createElement("div");
    this.messageEl.className = "notice-message";
    this.containerEl.append(this.messageEl);
    container.append(this.containerEl);
    this.containerEl.addEventListener("click", () => this.hide());
    this.setMessage(message);
    this.setAutoHide(duration);
  }

  setMessage(message: string | DocumentFragment): this {
    this.messageEl.replaceChildren();
    if (typeof message === "string") this.messageEl.textContent = message;
    else this.messageEl.append(message);
    return this;
  }

  setAutoHide(duration: number): this {
    if (this.timeout !== undefined) { clearTimeout(this.timeout); this.timeout = undefined; }
    if (duration > 0) {
      let hovered = false;
      const expire = () => { if (!hovered) this.hide(); };
      this.timeout = setTimeout(expire, duration);
      this.containerEl.addEventListener("mouseenter", () => { hovered = true; });
      this.containerEl.addEventListener("mouseleave", () => { hovered = false; setTimeout(expire, 1000); });
    }
    return this;
  }

  addButton(text: string, callback: (event: MouseEvent) => unknown): this {
    if (!this.buttonContainerEl) { this.buttonContainerEl = document.createElement("div"); this.buttonContainerEl.className = "notice-button-container"; this.containerEl.append(this.buttonContainerEl); }
    const button = document.createElement("div"); button.className = "notice-cta"; button.textContent = text;
    button.addEventListener("click", event => { event.stopPropagation(); this.hide(); callback(event); });
    this.buttonContainerEl.append(button);
    return this;
  }

  hide(): void {
    if (this.hidden) return;
    this.hidden = true;
    if (this.timeout !== undefined) clearTimeout(this.timeout);
    const container = this.containerEl.parentElement;
    this.containerEl.remove();
    if (container && container.childElementCount === 0) container.remove();
  }
}

type MenuEntry = MenuItem | null;

/** Context menu rendered with the reference menu structure, sections and keyboard navigation. */
export class Menu {
  private static eventMenus = new WeakMap<Event, Menu>();
  private entries: MenuEntry[] = [];
  private sections: string[] = [];
  private sectionSubmenus = new Map<string, { title: string; icon?: string }>();
  private sectionItemOrders = new Map<string, string[]>();
  private root?: HTMLElement;
  private parent?: HTMLElement;
  private hideCallbacks: Array<() => unknown> = [];
  private activeCleanups: Array<() => unknown> = [];
  private noIcon = false;
  private extraClasses: string[] = [];
  private selected = -1;
  private openSubmenu: Menu | null = null;
  /** @internal */ parentMenu: Menu | null = null;

  get dom(): HTMLElement | undefined { return this.root; }
  get items(): MenuItem[] { return this.entries.filter((entry): entry is MenuItem => entry !== null); }
  setNoIcon(): this { this.noIcon = true; return this; }
  setUseNativeMenu(_useNativeMenu: boolean): this { return this; }
  /** @internal */ addClass(...classes: string[]): this { this.extraClasses.push(...classes); return this; }

  addItem(callback: (item: MenuItem) => unknown): this {
    if (this.root) return this;
    const item = new MenuItem(this);
    callback(item);
    this.entries.push(item);
    return this;
  }

  addSeparator(): this {
    if (!this.root) this.entries.push(null);
    return this;
  }

  addSections(sections: string[]): this {
    const missing = sections.filter(section => !this.sections.includes(section));
    const unnamed = this.sections.indexOf("");
    this.sections.splice(unnamed < 0 ? this.sections.length : unnamed, 0, ...missing);
    return this;
  }

  /** Groups a section's contributed actions under a named submenu. */
  setSectionSubmenu(section: string, options: { title: string; icon?: string }): this {
    this.sectionSubmenus.set(section, options);
    return this;
  }

  /** @internal */ setSectionItemOrder(section: string, titles: string[]): this {
    this.sectionItemOrders.set(section, [...titles]);
    return this;
  }

  setParentElement(el: HTMLElement): this { this.parent?.classList.remove("has-active-menu"); this.parent = el; return this; }

  showAtMouseEvent(event: MouseEvent): this {
    const action = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".view-actions [aria-label]")
      : null;
    const viewActionsButton = action?.getAttribute("aria-label") === t("interface.menu.more-options") ? action : null;
    if (viewActionsButton) {
      const box = viewActionsButton.getBoundingClientRect();
      return this.showAtPosition({ x: box.right + 2, y: box.bottom }, viewActionsButton.ownerDocument);
    }
    // Keyboard-activated and synthetic clicks carry no pointer position; anchor below the target instead.
    if (!event.clientX && !event.clientY && event.target instanceof Element) {
      const box = event.target.getBoundingClientRect();
      return this.showAtPosition({ x: box.left, y: box.bottom + 2, width: box.width }, event.target.ownerDocument);
    }
    return this.showAtPosition({ x: event.clientX, y: event.clientY }, event.view?.document ?? document);
  }

  showAtPosition(position: { x: number; y: number; width?: number; overlap?: boolean; left?: boolean }, doc: Document = document): this {
    this.hide();
    const root = doc.createElement("div");
    root.className = ["menu", ...(this.noIcon ? ["mod-no-icon"] : []), ...this.extraClasses].join(" ");
    root.setAttribute("role", "menu");
    const grabber = doc.createElement("div"); grabber.className = "menu-grabber";
    const scroll = doc.createElement("div"); scroll.className = "menu-scroll";
    root.append(grabber, scroll);

    // Declared sections precede unknown plugin sections. The unnamed section also carries explicit separators.
    const bySection = new Map<string, MenuEntry[]>([["", []]]);
    const sections = [...this.sections];
    for (const entry of this.entries) {
      const section = entry?.section ?? "";
      if (section && !sections.includes(section)) {
        const base = section.split(".")[0];
        const lastRelated = sections.reduce((last, value, index) => value.split(".")[0] === base ? index : last, -1);
        if (section.includes(".") && lastRelated >= 0) sections.splice(lastRelated + 1, 0, section);
        else sections.push(section);
      }
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section)!.push(entry);
    }
    const ordered: MenuEntry[] = [];
    let previous: string | null = null;
    for (const section of sections) {
      if (!bySection.has(section)) continue;
      const base = section.split(".")[0];
      if (previous !== base) { if (previous !== null) ordered.push(null); previous = base; }
      const entries = bySection.get(section)!;
      const submenuOptions = this.sectionSubmenus.get(section);
      if (submenuOptions && entries.some(entry => entry !== null)) {
        const parent = new MenuItem(this).setTitle(submenuOptions.title).setIcon(submenuOptions.icon ?? null);
        const submenu = parent.setSubmenu();
        const itemOrder = this.sectionItemOrders.get(section);
        submenu.entries = itemOrder
          ? [...entries].map((entry, index) => ({ entry, index })).sort((a, b) => {
            const rank = (item: MenuEntry) => item ? itemOrder.indexOf(item.getTitleForOrdering()) : Number.MAX_SAFE_INTEGER;
            const ar = rank(a.entry), br = rank(b.entry);
            return (ar < 0 ? itemOrder.length : ar) - (br < 0 ? itemOrder.length : br) || a.index - b.index;
          }).map(({ entry }) => entry)
          : [...entries];
        ordered.push(parent);
      } else ordered.push(...entries);
    }
    if (!sections.includes("")) ordered.push(...bySection.get("")!);
    while (ordered.length && ordered.at(-1) === null) ordered.pop();
    const rendered: Array<{ item: MenuItem; el: HTMLElement }> = [];
    let groupEl: HTMLElement | null = null;
    for (const item of ordered) {
      if (!item) {
        groupEl = null;
        const separator = doc.createElement("div"); separator.className = "menu-separator"; scroll.append(separator);
      } else {
        if (!groupEl) { groupEl = doc.createElement("div"); groupEl.className = "menu-group"; scroll.append(groupEl); }
        const el = item.render(doc); groupEl.append(el); rendered.push({ item, el });
      }
    }

    this.parent?.classList.add("has-active-menu");
    doc.body.append(root);
    const box = { width: root.offsetWidth, height: root.offsetHeight };
    const viewportWidth = doc.documentElement.clientWidth, viewportHeight = doc.documentElement.clientHeight;
    const rightAnchor = position.width ? position.x + (position.overlap ? 0 : position.width) : position.x + 2;
    const leftAnchor = position.width ? position.x + (position.overlap ? position.width : 0) : position.x - 2;
    let left = rightAnchor + box.width > viewportWidth || (position.left && leftAnchor >= box.width) ? Math.max(0, leftAnchor - box.width) : rightAnchor;
    let top = position.y;
    if (top + box.height > viewportHeight) top = Math.max(0, top - box.height);
    root.style.left = `${Math.max(0, left)}px`;
    root.style.top = `${top + 2}px`;
    this.root = root;
    this.selected = -1;

    const select = (index: number) => {
      rendered[this.selected]?.el.classList.remove("selected");
      this.selected = index;
      const target = rendered[index];
      if (target) { target.el.classList.add("selected"); target.el.scrollIntoView({ block: "nearest" }); }
    };
    const step = (direction: number) => {
      if (!rendered.length) return;
      let index = this.selected;
      for (let attempts = 0; attempts < rendered.length; attempts++) {
        index = (index + direction + rendered.length) % rendered.length;
        if (rendered[index].item.isSelectable) { select(index); return; }
      }
    };
    rendered.forEach(({ item, el }, index) => {
      el.addEventListener("mouseenter", () => {
        if (!item.isSelectable) return;
        select(index);
        if (this.openSubmenu && this.openSubmenu !== item.submenu) { this.openSubmenu.hide(); this.openSubmenu = null; }
        if (item.submenu && this.openSubmenu !== item.submenu) this.showSubmenu(item, el, doc);
      });
    });
    root.addEventListener("mouseleave", () => { if (!this.openSubmenu) select(-1); });

    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (root.contains(target) || this.openSubmenu?.containsNode(target)) return;
      if (this.parentMenu) return; // The root menu owns outside-click dismissal.
      this.hide();
    };
    const keydown = (event: KeyboardEvent) => {
      if (this.openSubmenu) return;
      if (event.key === "Escape" || (event.key === "ArrowLeft" && this.parentMenu)) { this.hide(); }
      else if (event.key === "ArrowDown") step(1);
      else if (event.key === "ArrowUp") step(-1);
      else if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
        const target = rendered[this.selected];
        if (!target) return;
        if (target.item.submenu) { this.showSubmenu(target.item, target.el, doc); }
        else if (event.key !== "ArrowRight") target.item.handleEvent(event);
      } else return;
      event.preventDefault(); event.stopPropagation();
    };
    const blur = () => { if (!this.parentMenu) this.hide(); };
    doc.addEventListener("mousedown", dismiss, true);
    doc.addEventListener("contextmenu", dismiss, true);
    doc.addEventListener("keydown", keydown, true);
    doc.defaultView?.addEventListener("blur", blur);
    doc.defaultView?.addEventListener("resize", blur);
    this.activeCleanups.push(() => {
      doc.removeEventListener("mousedown", dismiss, true);
      doc.removeEventListener("contextmenu", dismiss, true);
      doc.removeEventListener("keydown", keydown, true);
      doc.defaultView?.removeEventListener("blur", blur);
      doc.defaultView?.removeEventListener("resize", blur);
    });
    return this;
  }

  private showSubmenu(item: MenuItem, el: HTMLElement, doc: Document): void {
    const submenu = item.submenu;
    if (!submenu) return;
    this.openSubmenu?.hide();
    const box = el.getBoundingClientRect();
    submenu.parentMenu = this;
    const style = doc.defaultView!.getComputedStyle(this.root!);
    const top = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
    const left = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) + 2;
    const right = parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth) + 2;
    submenu.showAtPosition({ x: box.x - left, y: box.y - top, width: box.width + left + right }, doc);
    this.openSubmenu = submenu;
    submenu.onHide(() => { if (this.openSubmenu === submenu) this.openSubmenu = null; });
  }

  /** @internal */
  containsNode(node: Node): boolean { return !!this.root?.contains(node) || !!this.openSubmenu?.containsNode(node); }

  hide(): this {
    if (!this.root) return this;
    this.openSubmenu?.hide();
    this.openSubmenu = null;
    this.root.remove();
    this.parent?.classList.remove("has-active-menu");
    this.root = undefined;
    for (const cleanup of this.activeCleanups.splice(0)) cleanup();
    for (const callback of [...this.hideCallbacks]) callback();
    return this;
  }

  /** @internal Closes this menu and every ancestor menu. */
  hideAll(): void { let menu: Menu | null = this; while (menu) { const parent: Menu | null = menu.parentMenu; menu.hide(); menu = parent; } }

  close(): void { this.hide(); }
  onHide(callback: () => unknown): void { this.hideCallbacks.push(callback); }

  static forEvent(event: PointerEvent | MouseEvent): Menu {
    event.preventDefault();
    const existing = Menu.eventMenus.get(event);
    if (existing) return existing;
    const menu = new Menu();
    Menu.eventMenus.set(event, menu);
    const win = event.view ?? (event.target as Node | null)?.ownerDocument?.defaultView ?? window;
    win.setTimeout(() => menu.showAtMouseEvent(event), 0);
    return menu;
  }
}

export class MenuItem {
  private title: string | DocumentFragment = "";
  private icon: string | null = null;
  private checked: boolean | null = null;
  private disabled = false;
  private warning = false;
  private label = false;
  /** @internal */ section?: string;
  /** @internal */ submenu: Menu | null = null;
  private click?: (event: MouseEvent | KeyboardEvent) => unknown;

  constructor(private readonly menu: Menu | (() => unknown) = () => {}) {}

  /** @internal */ get isSelectable(): boolean { return !this.disabled && !this.label; }
  /** @internal */ getTitleForOrdering(): string { return typeof this.title === "string" ? this.title : this.title.textContent ?? ""; }
  setTitle(title: string | DocumentFragment): this { this.title = title; return this; }
  setIcon(icon: string | null): this { this.icon = icon; return this; }
  setChecked(checked: boolean | null): this { this.checked = checked; return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
  setWarning(warning: boolean): this { this.warning = warning; return this; }
  setIsLabel(label: boolean): this { this.label = label; return this; }
  setSection(section: string): this { this.section = section; return this; }
  setSubmenu(): Menu { this.submenu ??= new Menu(); return this.submenu; }
  onClick(callback: (event: MouseEvent | KeyboardEvent) => unknown): this { this.click = callback; return this; }

  /** @internal */
  handleEvent(event: MouseEvent | KeyboardEvent): void {
    if (!this.isSelectable || this.submenu) return;
    try { this.click?.(event); }
    finally { if (this.menu instanceof Menu) this.menu.hideAll(); else this.menu(); }
  }

  render(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    el.className = "menu-item tappable";
    el.setAttribute("role", this.label ? "presentation" : "menuitem");
    if (this.section) el.dataset.section = this.section;
    if (this.disabled) el.classList.add("is-disabled");
    if (this.label) el.classList.add("is-label");
    if (this.warning) el.classList.add("is-warning");
    if (this.submenu) el.classList.add("has-submenu");
    const icon = doc.createElement("div");
    icon.className = "menu-item-icon";
    if (this.icon) setIcon(icon, this.icon);
    const title = doc.createElement("div");
    title.className = "menu-item-title";
    if (typeof this.title === "string") title.textContent = this.title;
    else title.append(this.title.cloneNode(true));
    el.append(icon, title);
    if (this.checked) {
      el.classList.add("mod-checked");
      el.setAttribute("aria-checked", "true");
      const check = doc.createElement("div"); check.className = "menu-item-icon mod-checked"; setIcon(check, "lucide-check");
      el.append(check);
    } else if (this.checked === false) el.setAttribute("aria-checked", "false");
    if (this.submenu) {
      const chevron = doc.createElement("div"); chevron.className = "menu-item-icon mod-submenu"; setIcon(chevron, "lucide-chevron-right");
      el.append(chevron);
    }
    el.addEventListener("click", event => this.handleEvent(event));
    return el;
  }
}
