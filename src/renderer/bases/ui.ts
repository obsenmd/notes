import { setIcon } from "../../compat/utilities";
import { t } from "../../i18n";

/** Creates an element under `parent` (or detached when null). */
export function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement | null, tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const node = (parent?.ownerDocument ?? document).createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
}
export const div = (parent: HTMLElement | null, cls = "", text?: string): HTMLDivElement => el(parent, "div", cls, text);
export function iconDiv(parent: HTMLElement | null, cls: string, icon: string, tag: "div" | "span" | "button" = "div"): HTMLElement { const node = el(parent, tag, cls); setIcon(node, icon); return node; }
export const toggle = (node: HTMLElement, visible: boolean): void => { node.style.display = visible ? "" : "none"; };
export const isShown = (node: HTMLElement): boolean => node.isConnected && node.style.display !== "none";
/** Activates on click and on Enter/Space, as the reference's tappable rows do. */
export function onActivate(node: HTMLElement, callback: (event: MouseEvent | KeyboardEvent) => void): void {
  node.addEventListener("click", callback);
  node.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target === node && !event.isComposing) { event.preventDefault(); callback(event); } });
}
export function arrayMove<T>(items: T[], from: number, to: number): void {
  if (from < 0 || from >= items.length) return;
  const [item] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(items.length, to)), 0, item!);
}
/** Keeps a floating element inside the viewport, preferring the space below its anchor. */
export function positionBelow(anchor: DOMRect, floating: HTMLElement, gap = 4): void {
  const doc = floating.ownerDocument, width = doc.documentElement.clientWidth, height = doc.documentElement.clientHeight;
  floating.style.left = "0px"; floating.style.top = "0px";
  const box = floating.getBoundingClientRect();
  let left = anchor.left, top = anchor.bottom + gap;
  if (left + box.width > width - 10) left = Math.max(10, width - box.width - 10);
  if (top + box.height > height - 10) top = anchor.top - gap - box.height >= 10 ? anchor.top - gap - box.height : Math.max(10, height - box.height - 10);
  floating.style.left = `${left}px`; floating.style.top = `${top}px`;
  floating.style.maxHeight = `${height - 20}px`;
}
/** Simple subsequence match used by the pickers. */
export function matchesQuery(query: string, ...texts: string[]): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every(token => texts.some(text => text.toLowerCase().includes(token)));
}

/** Row reordering by dragging a handle; `onMove` receives the new index among the row's siblings. */
export function dragReorder(handle: HTMLElement, row: HTMLElement, onMove: (index: number) => void): void {
  handle.addEventListener("pointerdown", down => {
    if (down.button !== 0) return;
    const container = row.parentElement;
    if (!container) return;
    down.preventDefault(); down.stopPropagation();
    const siblings = () => Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== indicator);
    const indicator = div(null, "table-drag-target"); Object.assign(indicator.style, { position: "absolute", height: "2px", left: "0", right: "0", background: "var(--interactive-accent)", pointerEvents: "none" });
    let target = siblings().indexOf(row), moved = false;
    const startY = down.clientY, previousPosition = container.style.position;
    const move = (event: PointerEvent) => {
      if (!moved && Math.abs(event.clientY - startY) < 4) return;
      if (!moved) { moved = true; row.classList.add("is-being-dragged"); if (!container.style.position) container.style.position = "relative"; container.append(indicator); }
      const rows = siblings(), bounds = container.getBoundingClientRect();
      target = rows.length;
      for (let index = 0; index < rows.length; index++) { const box = rows[index]!.getBoundingClientRect(); if (event.clientY < box.top + box.height / 2) { target = index; break; } }
      const edge = target < rows.length ? rows[target]!.getBoundingClientRect().top : rows.at(-1)!.getBoundingClientRect().bottom;
      indicator.style.top = `${edge - bounds.top + container.scrollTop - 1}px`;
    };
    const up = () => {
      handle.ownerDocument.removeEventListener("pointermove", move, true);
      handle.ownerDocument.removeEventListener("pointerup", up, true);
      indicator.remove(); row.classList.remove("is-being-dragged"); container.style.position = previousPosition;
      if (!moved) return;
      const from = siblings().indexOf(row);
      if (target > from) target--;
      if (target !== from) onMove(target);
    };
    handle.ownerDocument.addEventListener("pointermove", move, true);
    handle.ownerDocument.addEventListener("pointerup", up, true);
  });
  handle.addEventListener("click", event => event.stopPropagation());
}

export class TextIconButton {
  readonly buttonEl: HTMLElement; readonly iconEl: HTMLElement; readonly labelEl: HTMLElement;
  private disabled = false;
  private callback: ((event: MouseEvent | KeyboardEvent) => void) | null = null;
  constructor(parent: HTMLElement) {
    this.buttonEl = div(parent, "text-icon-button tappable"); this.buttonEl.tabIndex = 0; this.buttonEl.setAttribute("role", "button");
    this.iconEl = el(this.buttonEl, "span", "text-button-icon");
    this.labelEl = el(this.buttonEl, "span", "text-button-label");
    onActivate(this.buttonEl, event => { if (!this.disabled) this.callback?.(event); });
  }
  setIcon(icon: string): this { setIcon(this.iconEl, icon); return this; }
  setText(text: string): this { this.labelEl.textContent = text; return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; this.buttonEl.classList.toggle("is-disabled", disabled); return this; }
  onClick(callback: (event: MouseEvent | KeyboardEvent) => void): this { this.callback = callback; return this; }
}

export class SearchInput {
  readonly containerEl: HTMLElement; readonly inputEl: HTMLInputElement;
  private handler: ((value: string) => void) | null = null;
  constructor(parent: HTMLElement) {
    this.containerEl = div(parent, "search-input-container");
    this.inputEl = el(this.containerEl, "input"); this.inputEl.type = "search"; this.inputEl.setAttribute("enterkeyhint", "search"); this.inputEl.spellcheck = false;
    const clear = div(this.containerEl, "search-input-clear-button");
    clear.addEventListener("mousedown", event => event.preventDefault());
    clear.addEventListener("click", () => { this.inputEl.value = ""; this.handler?.(""); this.inputEl.focus(); });
    this.inputEl.addEventListener("input", () => this.handler?.(this.inputEl.value));
  }
  setClass(cls: string): this { this.containerEl.classList.add(...cls.split(" ")); return this; }
  setPlaceholder(text: string): this { this.inputEl.placeholder = text; return this; }
  onChange(handler: (value: string) => void): this { this.handler = handler; return this; }
  autoSelect(): this { queueMicrotask(() => { this.inputEl.focus({ preventScroll: true }); this.inputEl.select(); }); return this; }
}

/** A grouped, keyboard-navigable list rendered as `.suggestion-group > .suggestion-item`. */
export class Chooser<T extends { group: string }> {
  values: T[] = [];
  suggestions: HTMLElement[] = [];
  selectedItem = 0;
  private groupEls: Record<string, HTMLElement> = {};
  constructor(readonly containerEl: HTMLElement, private readonly render: (item: T, row: HTMLElement) => void, private readonly select: (item: T, event: MouseEvent | KeyboardEvent | null) => void, private readonly groups: string[] | null = null) {}
  getGroupEl(group: string): HTMLElement | null { return this.groupEls[group] ?? null; }
  setSuggestions(items: T[]): void {
    this.containerEl.replaceChildren();
    this.groupEls = {}; this.values = items; this.suggestions = [];
    const groupEl = (group: string) => { const node = div(this.containerEl, "suggestion-group"); node.dataset.group = group; return this.groupEls[group] = node; };
    for (const group of this.groups ?? []) groupEl(group);
    items.forEach((item, index) => {
      const row = div(this.groupEls[item.group] ?? groupEl(item.group), "suggestion-item");
      this.render(item, row);
      row.addEventListener("click", event => { if (event.defaultPrevented) return; this.setSelectedItem(index); this.select(item, event); });
      row.addEventListener("mousemove", () => { if (this.selectedItem !== index) this.setSelectedItem(index, false); });
      this.suggestions.push(row);
    });
    this.setSelectedItem(Math.min(this.selectedItem, items.length - 1), false);
  }
  setSelectedItem(index: number, scroll = true): void {
    if (!this.values.length) { this.selectedItem = 0; return; }
    const next = ((index % this.values.length) + this.values.length) % this.values.length;
    this.suggestions[this.selectedItem]?.classList.remove("is-selected");
    this.selectedItem = next;
    const row = this.suggestions[next];
    row?.classList.add("is-selected");
    if (scroll) row?.scrollIntoView({ block: "nearest" });
  }
  getSelectedValue(): T | null { return this.values[this.selectedItem] ?? null; }
  getSelectedElement(): HTMLElement | null { return this.suggestions[this.selectedItem] ?? null; }
  /** Returns true when the key was consumed. */
  handleKey(event: KeyboardEvent): boolean {
    if (event.isComposing || event.altKey) return false;
    if (event.key === "ArrowDown") this.setSelectedItem(this.selectedItem + 1);
    else if (event.key === "ArrowUp") this.setSelectedItem(this.selectedItem - 1);
    else if (event.key === "Enter") { const item = this.getSelectedValue(); if (!item) return false; this.select(item, event); }
    else return false;
    event.preventDefault();
    return true;
  }
}

export interface ComboItem<V extends string = string> { value: V; display?: string; icon?: string; aux?: string }

/** The reference's combobox: a button showing the current choice that opens a searchable list. */
export class Combobox<V extends string = string, I extends ComboItem<V> = ComboItem<V>> {
  readonly buttonEl: HTMLElement; readonly iconEl: HTMLElement; readonly labelEl: HTMLElement;
  selected: I | null = null;
  private items: I[] | (() => I[]) = [];
  private clearable = false;
  private popup: HTMLElement | null = null;
  private selectCb: ((item: I | null) => void) | null = null;
  private cleanup: (() => void) | null = null;
  constructor(readonly containerEl: HTMLElement) {
    const button = this.buttonEl = div(containerEl, "combobox-button"); button.tabIndex = 0;
    this.iconEl = div(button, "combobox-button-icon"); toggle(this.iconEl, false);
    this.labelEl = div(button, "combobox-button-label");
    const clear = iconDiv(button, "combobox-clear-button", "lucide-x");
    clear.addEventListener("mousedown", event => event.preventDefault());
    clear.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); button.blur(); this.choose(null); });
    iconDiv(button, "combobox-button-chevron", "lucide-chevrons-up-down");
    button.addEventListener("click", event => { if (event.defaultPrevented) return; event.preventDefault(); this.popup ? this.close() : this.open(); });
    button.addEventListener("keydown", event => { if (event.isComposing) return; if (event.key.startsWith("Arrow") || event.key === "Enter" || event.key === " ") { event.preventDefault(); this.open(); } });
  }
  setPlaceholder(text: string): this { this.labelEl.setAttribute("placeholder", text); return this; }
  setItems(items: I[] | (() => I[])): this { this.items = items; return this; }
  getItems(): I[] { return typeof this.items === "function" ? this.items() : this.items; }
  setClearable(clearable: boolean): this { this.clearable = clearable; this.buttonEl.classList.toggle("mod-clearable", clearable && this.selected !== null); return this; }
  setValue(item: I | null): this {
    this.selected = item;
    this.labelEl.textContent = item ? item.display ?? item.value : "";
    if (item?.icon) setIcon(this.iconEl, item.icon); else this.iconEl.replaceChildren();
    toggle(this.iconEl, !!item?.icon);
    this.buttonEl.classList.toggle("mod-clearable", this.clearable && item !== null);
    return this;
  }
  /** Selects a known item; unknown ids are shown via `fallback` so stale configuration stays visible. */
  setValueById(value: string | null, fallback?: (value: string) => I): this {
    const item = value ? this.getItems().find(candidate => candidate.value === value) ?? fallback?.(value) ?? null : null;
    return this.setValue(item);
  }
  onSelect(callback: (item: I | null) => void): this { this.selectCb = callback; return this; }
  focus(): void { this.buttonEl.focus({ preventScroll: true }); }
  private choose(item: I | null): void { this.setValue(item); this.close(); this.focus(); this.selectCb?.(item); }
  close(): void {
    if (!this.popup) return;
    this.popup.remove(); this.popup = null;
    this.buttonEl.classList.remove("has-focus");
    this.cleanup?.(); this.cleanup = null;
  }
  open(): void {
    if (this.popup) return;
    const doc = this.buttonEl.ownerDocument;
    const popup = this.popup = div(null, "suggestion-container combobox"); Object.assign(popup.style, { position: "fixed", display: "flex", minWidth: `${Math.max(180, this.buttonEl.offsetWidth)}px` });
    const search = new SearchInput(popup).setPlaceholder(t("plugins.search.prompt-start-search"));
    const list = div(popup, "suggestion");
    list.addEventListener("mousedown", event => event.preventDefault());
    const chooser = new Chooser<I & { group: string }>(list, (item, row) => {
      row.classList.add("mod-complex", "mod-toggle");
      if (this.selected?.value === item.value) iconDiv(row, "suggestion-icon mod-checked", "lucide-check");
      if (item.icon) setIcon(el(div(row, "suggestion-icon"), "span", "suggestion-flair"), item.icon);
      div(div(row, "suggestion-content"), "suggestion-title", item.display ?? item.value);
      if (item.aux) el(div(row, "suggestion-aux"), "span", "suggestion-flair u-small", item.aux);
    }, item => this.choose(this.getItems().find(candidate => candidate.value === item.value) ?? item));
    const all = this.getItems();
    const refresh = (query: string) => {
      chooser.selectedItem = 0;
      chooser.setSuggestions(all.filter(item => matchesQuery(query, item.value, item.display ?? "")).map(item => ({ ...item, group: "" })));
      // A single unnamed group needs no wrapper element.
      const group = chooser.getGroupEl("");
      if (group) { group.replaceWith(...Array.from(group.children)); }
      positionBelow(this.buttonEl.getBoundingClientRect(), popup, 2);
    };
    search.onChange(refresh);
    search.inputEl.addEventListener("focus", () => popup.classList.add("has-input-focus"));
    search.inputEl.addEventListener("blur", () => popup.classList.remove("has-input-focus"));
    search.inputEl.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); this.focus(); }
      else if (event.key === "Tab") { this.close(); this.focus(); }
      else if (chooser.handleKey(event)) event.stopPropagation();
    });
    doc.body.append(popup);
    this.buttonEl.classList.add("has-focus");
    refresh("");
    const selected = all.findIndex(item => item.value === this.selected?.value);
    if (selected >= 0) chooser.setSelectedItem(selected);
    search.autoSelect();
    const outside = (event: MouseEvent) => { const target = event.target as Node; if (!popup.contains(target) && !this.buttonEl.contains(target)) this.close(); };
    doc.addEventListener("mousedown", outside, true);
    this.cleanup = () => doc.removeEventListener("mousedown", outside, true);
  }
}

/** One screen of a toolbar menu; pages stack so that "back" returns to the previous one. */
export class MenuPage {
  title = "";
  readonly actionEls: HTMLElement[] = [];
  readonly containerEl: HTMLElement;
  constructor(readonly host: ToolbarMenu, cls = "bases-toolbar-menu-container") { this.containerEl = div(null, cls); }
  get isShown(): boolean { return this.host.isCurrentPage(this); }
  setTitle(title: string): this { this.title = title; return this; }
  addAction(icon: string, callback: (event: MouseEvent, actionEl: HTMLElement) => void): void {
    const action = iconDiv(null, "clickable-icon", icon);
    action.addEventListener("click", event => callback(event, action));
    this.actionEls.push(action);
  }
  onShow(): void {}
  onHide(): void {}
  /** Return true to consume a key press before the menu's own Escape handling. */
  onKey(_event: KeyboardEvent): boolean { return false; }
}

/** The popover attached to a toolbar button (`.menu.bases-toolbar-menu`). */
export class ToolbarMenu {
  readonly menuEl: HTMLElement; readonly scrollEl: HTMLElement;
  enabled = true;
  handleOpen?: () => void; handleClose?: () => void;
  private readonly pageHeaderEl: HTMLElement; private readonly pageBackEl: HTMLElement; private readonly pageTitleEl: HTMLElement; private readonly pageCloseEl: HTMLElement;
  private pages: MenuPage[] = [];
  private createRootPage: (() => MenuPage) | null = null;
  private open = false;
  private cleanup: (() => void) | null = null;
  private observer: ResizeObserver | null = null;
  constructor(readonly parentEl: HTMLElement, readonly title: string) {
    const menu = this.menuEl = div(null, "menu bases-toolbar-menu");
    div(menu, "menu-grabber");
    this.scrollEl = div(menu, "menu-scroll");
    const header = this.pageHeaderEl = div(null, "bases-toolbar-menu-container-header");
    const back = this.pageBackEl = div(header, "back-button");
    iconDiv(back, "back-icon", "lucide-chevron-left");
    this.pageTitleEl = div(back, "back-label");
    back.addEventListener("click", () => this.back());
    this.pageCloseEl = iconDiv(header, "close-icon clickable-icon", "lucide-x");
    this.pageCloseEl.addEventListener("click", () => this.close());
    menu.addEventListener("keydown", event => {
      if (event.isComposing || event.defaultPrevented) return;
      if (this.pages.at(-1)?.onKey(event)) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (this.pages.length > 1) this.back(); else this.setOpen(false); }
    });
  }
  get isOpen(): boolean { return this.open; }
  setRootPage(create: () => MenuPage): this { this.createRootPage = create; return this; }
  isCurrentPage(page: MenuPage): boolean { return this.pages.at(-1) === page; }
  show(page: MenuPage): void { this.pages.at(-1)?.onHide(); this.pages.push(page); this.displayPage(page); }
  back(): void {
    this.pages.pop()?.onHide();
    const page = this.pages.at(-1);
    if (page) this.displayPage(page);
  }
  backToRoot(): void { while (this.pages.length > 1) this.back(); }
  close(): void { this.setOpen(false); }
  toggle(): void { this.setOpen(!this.open); }
  private displayPage(page: MenuPage): void {
    if (this.pages.length > 1) {
      this.pageTitleEl.textContent = page.title;
      this.pageHeaderEl.replaceChildren(this.pageBackEl, ...page.actionEls, this.pageCloseEl);
      page.containerEl.prepend(this.pageHeaderEl);
    } else this.pageHeaderEl.remove();
    this.scrollEl.replaceChildren(page.containerEl);
    page.onShow();
    this.position();
  }
  position(): void { if (this.open) positionBelow(this.parentEl.getBoundingClientRect(), this.menuEl); }
  setOpen(open: boolean): void {
    if (this.open === open || (open && !this.enabled)) return;
    this.open = open;
    this.parentEl.classList.toggle("has-active-menu", open);
    const doc = this.parentEl.ownerDocument, win = doc.defaultView!;
    if (open) {
      this.handleOpen?.();
      doc.body.append(this.menuEl);
      if (this.createRootPage) this.show(this.createRootPage());
      this.position();
      this.observer = new ResizeObserver(() => this.position());
      this.observer.observe(this.menuEl);
      // Clicks in pickers, context menus and dialogs opened from the menu do not dismiss it.
      const outside = (event: MouseEvent) => {
        const target = event.target as Element | null;
        if (!target?.isConnected || this.parentEl.contains(target) || this.menuEl.contains(target) || target.closest?.(".suggestion-container, .menu, .modal-container")) return;
        this.setOpen(false);
      };
      const timer = win.setTimeout(() => doc.addEventListener("mousedown", outside, true), 0);
      const gone = win.setInterval(() => { if (!this.parentEl.isConnected) this.setOpen(false); }, 500);
      this.cleanup = () => { win.clearTimeout(timer); win.clearInterval(gone); doc.removeEventListener("mousedown", outside, true); };
    } else {
      this.handleClose?.();
      this.pages.at(-1)?.onHide(); this.pages = [];
      this.cleanup?.(); this.cleanup = null;
      this.observer?.disconnect(); this.observer = null;
      const hadFocus = this.menuEl.contains(doc.activeElement);
      this.menuEl.remove();
      if (hadFocus) this.parentEl.focus({ preventScroll: true });
    }
  }
}

/** A toolbar button together with the menu it opens. */
export class ToolbarItem {
  readonly containerEl: HTMLElement; readonly button: TextIconButton; readonly menu: ToolbarMenu;
  enabled = true;
  constructor(toolbarEl: HTMLElement, readonly name: string, readonly icon: string) {
    this.containerEl = div(toolbarEl, "bases-toolbar-item");
    this.button = new TextIconButton(this.containerEl).setIcon(icon).setText(name).onClick(() => this.setOpen(!this.menu.isOpen));
    this.menu = new ToolbarMenu(this.button.buttonEl, name);
  }
  addClass(cls: string): void { this.containerEl.classList.add(cls); this.menu.menuEl.classList.add(cls); }
  setEnabled(enabled: boolean): this {
    this.enabled = enabled; this.menu.enabled = enabled; this.button.setDisabled(!enabled);
    if (!enabled && this.menu.isOpen) this.menu.setOpen(false);
    return this;
  }
  setOpen(open: boolean): void { if (!open || this.enabled) this.menu.setOpen(open); }
}

/** A clickable row inside a menu (`.bases-toolbar-menu-item.bases-toolbar-menu-action`). */
export class MenuAction {
  readonly rowEl: HTMLElement; private readonly iconEl: HTMLElement; private readonly nameEl: HTMLElement;
  constructor(parent: HTMLElement) {
    this.rowEl = div(parent, "bases-toolbar-menu-item bases-toolbar-menu-action tappable"); this.rowEl.tabIndex = 0;
    const info = div(this.rowEl, "bases-toolbar-menu-item-info");
    this.iconEl = div(info, "bases-toolbar-menu-item-info-icon");
    this.nameEl = div(info, "bases-toolbar-menu-item-name");
  }
  setIcon(icon: string): this { setIcon(this.iconEl, icon); return this; }
  setText(text: string): this { this.nameEl.textContent = text; return this; }
  onClick(callback: (event: MouseEvent | KeyboardEvent) => void): this { onActivate(this.rowEl, callback); return this; }
}

/** Collapsible section header state, shared by the filter menu and view options. */
export function setCollapsed(header: HTMLElement, collapsed: boolean): void {
  header.classList.toggle("is-collapsed", collapsed);
  header.querySelector(":scope > .collapse-icon")?.classList.toggle("is-collapsed", collapsed);
}
