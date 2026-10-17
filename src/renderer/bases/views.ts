import type { App } from "../../compat/plugin";
import { Component } from "../../compat/component";
import type { TFile } from "../../compat/vault";
import { ListValue, NullValue, NumberValue, ObjectValue, StringValue, FileValue, LinkValue, Value, parsePropertyId, resolveKey } from "../../compat/bases";
import { inferPropertyType, type PropertyType } from "../../compat/properties-editor";
import { Menu, Notice } from "../../compat/ui";
import { setIcon } from "../../compat/utilities";
import { t } from "../../i18n";
import type { BasesController } from "./controller";
import { toPropertyId, type Entry, type EntryGroup, type PropertyId, type ViewConfig, type ViewData } from "./query";
import { arrayMove, div, el, iconDiv, isShown, setCollapsed } from "./ui";

const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
const px = (value: string, fallback: number) => { const parsed = parseFloat(value); return Number.isFinite(parsed) ? parsed : fallback; };

/** Reorders/removes children without detaching nodes that are already in place, so focused editors survive updates. */
export function setChildren(parent: HTMLElement, children: HTMLElement[]): void {
  const wanted = new Set<Element>(children);
  for (const child of Array.from(parent.children)) if (!wanted.has(child)) child.remove();
  let cursor = parent.firstElementChild;
  for (const child of children) { if (child === cursor) cursor = cursor.nextElementSibling; else parent.insertBefore(child, cursor); }
}

/** The part of an element that is actually visible, in the element's own coordinates. */
function visibleRect(node: HTMLElement): { top: number; bottom: number; left: number; right: number } {
  const box = node.getBoundingClientRect(), win = node.ownerDocument.defaultView ?? window;
  let left = 0, right = win.innerWidth, top = 0, bottom = win.innerHeight;
  for (let parent = node.parentElement; parent && parent !== node.ownerDocument.body; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    if ((parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) && style.overflow !== "visible") {
      const bounds = parent.getBoundingClientRect();
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return { left: left - box.left, right: Math.max(left, right) - box.left, top: top - box.top, bottom: Math.max(top, bottom) - box.top };
}

/** Calls `callback` when anything that contains `node` scrolls. */
function watchScroll(node: HTMLElement, callback: () => void): () => void {
  const doc = node.ownerDocument;
  const onScroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(node)) callback(); };
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => doc.removeEventListener("scroll", onScroll, { capture: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// Property editing widgets

export interface WidgetOptions { app: App; sourcePath: string; onChange(value: unknown): void; placeholder?: string }
export interface Widget { type: string; focus(): void; setValue?(value: unknown): void }

/** Renders the in-place editor for a frontmatter value, using the same DOM as the note properties panel. */
export function renderWidget(parent: HTMLElement, type: string, value: unknown, options: WidgetOptions): Widget {
  const { app, sourcePath, onChange } = options;
  parent.replaceChildren();
  if (type === "checkbox") {
    const input = el(parent, "input", "metadata-input-checkbox"); input.type = "checkbox"; input.checked = value === true; input.dataset.indeterminate = String(value == null);
    input.addEventListener("change", () => onChange(input.checked));
    return { type, focus: () => input.focus() };
  }
  if (type === "number") {
    const input = el(parent, "input", "metadata-input metadata-input-number"); input.type = "number"; input.placeholder = options.placeholder ?? t("properties.label-no-value");
    input.value = typeof value === "number" ? String(value) : "";
    input.addEventListener("change", () => onChange(input.value === "" ? null : Number(input.value)));
    input.addEventListener("keydown", event => { if (event.key === "Enter") input.blur(); });
    return { type, focus: () => input.focus() };
  }
  if (type === "date" || type === "datetime") {
    const input = el(parent, "input", `metadata-input metadata-input-text mod-${type}`); input.type = type === "date" ? "date" : "datetime-local"; input.max = type === "date" ? "9999-12-31" : "9999-12-31T23:59";
    input.value = typeof value === "string" ? value.slice(0, type === "date" ? 10 : 16) : "";
    input.classList.toggle("is-empty", !input.value);
    input.addEventListener("change", () => { input.classList.toggle("is-empty", !input.value); onChange(input.value || null); });
    return { type, focus: () => input.focus() };
  }
  if (type === "multitext" || type === "aliases" || type === "tags") {
    const container = div(parent, "multi-select-container"); container.tabIndex = -1;
    let values = Array.isArray(value) ? value.filter(item => item != null).map(String) : value == null || value === "" ? [] : [String(value)];
    const input = div(null, "multi-select-input"); input.contentEditable = "true"; input.tabIndex = 0;
    const draw = () => {
      container.replaceChildren();
      values.forEach((entry, index) => {
        const pill = div(container, "multi-select-pill"); pill.tabIndex = 0;
        const content = div(pill, "multi-select-pill-content");
        const link = type === "multitext" ? /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(entry) : null;
        if (link) {
          const inner = el(content, "a", "internal-link", link[2] || link[1]!.slice(link[1]!.lastIndexOf("/") + 1)); inner.dataset.href = link[1]!;
          inner.classList.toggle("is-unresolved", !app.metadataCache.getFirstLinkpathDest(link[1]!.split("#")[0]!, sourcePath));
          inner.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void app.workspace.openLinkText(link[1]!, sourcePath, event.ctrlKey || event.metaKey); });
        } else content.textContent = type === "tags" ? entry.replace(/^#/, "") : entry;
        const remove = iconDiv(pill, "multi-select-pill-remove-button", "lucide-x");
        const drop = () => update(values.filter((_item, position) => position !== index));
        remove.addEventListener("click", event => { event.stopPropagation(); drop(); });
        pill.addEventListener("keydown", event => { if (event.key === "Backspace" || event.key === "Delete") drop(); });
      });
      input.dataset.placeholder = values.length ? "" : options.placeholder ?? t("properties.label-no-value");
      container.append(input);
    };
    const update = (next: string[]) => { values = next; draw(); onChange(next); };
    const flush = () => { const text = (input.textContent ?? "").trim().replace(type === "tags" ? /^#/ : /^$/, ""); input.textContent = ""; if (text) update([...values, text]); };
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === ",") { event.preventDefault(); flush(); queueMicrotask(() => input.focus()); }
      else if (event.key === "Backspace" && !input.textContent && values.length) update(values.slice(0, -1));
      else if (event.key === "Escape") { input.textContent = ""; input.blur(); }
    });
    input.addEventListener("blur", flush);
    container.addEventListener("click", event => { if (event.target === container) input.focus(); });
    draw();
    return { type, focus: () => input.focus(), setValue: next => { values = Array.isArray(next) ? next.map(String) : next ? [String(next)] : []; draw(); } };
  }
  // Text: wikilinks show as a link with an edit affordance, everything else is edited in place.
  let current = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const field = div(null, "metadata-input-longtext mod-truncate"); field.contentEditable = "true"; field.tabIndex = 0; field.spellcheck = false;
  field.dataset.placeholder = options.placeholder ?? t("properties.label-no-value");
  const edit = () => { parent.replaceChildren(field); field.focus(); const selection = field.ownerDocument.getSelection(); selection?.selectAllChildren(field); selection?.collapseToEnd(); };
  const draw = () => {
    field.textContent = current;
    const link = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(current), url = /^https?:\/\/\S+$/.test(current);
    if (!link && !url) { parent.replaceChildren(field); return; }
    const wrap = div(null, "metadata-link"), inner = div(wrap, `metadata-link-inner ${link ? "internal-link" : "external-link"}`, link ? link[2] || link[1]!.slice(link[1]!.lastIndexOf("/") + 1) : current);
    if (link) { inner.dataset.href = link[1]!; inner.classList.toggle("is-unresolved", !app.metadataCache.getFirstLinkpathDest(link[1]!.split("#")[0]!, sourcePath)); }
    inner.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (link) void app.workspace.openLinkText(link[1]!, sourcePath, event.ctrlKey || event.metaKey); else window.open(current, "_blank");
    });
    iconDiv(wrap, "metadata-link-flair", "lucide-pencil");
    wrap.addEventListener("click", event => { if (!event.defaultPrevented) edit(); });
    parent.replaceChildren(wrap);
  };
  field.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); field.blur(); }
    else if (event.key === "Escape") { field.textContent = current; field.blur(); }
  });
  field.addEventListener("blur", () => {
    const text = field.textContent ?? "";
    if (text !== current) { current = text; onChange(text === "" ? null : text); }
    draw();
  });
  draw();
  return { type: "text", focus: edit, setValue: next => { current = next == null ? "" : String(next); draw(); } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Cell renderers

abstract class CellRenderer {
  entry: Entry | null = null;
  constructor(readonly view: BasesView, readonly prop: PropertyId, readonly el: HTMLElement) {}
  abstract render(entry: Entry): void;
}

/** `file.name`: a link to the row's file. */
class FileNameRenderer extends CellRenderer {
  private path = "";
  constructor(view: BasesView, prop: PropertyId, cell: HTMLElement) { super(view, prop, cell); cell.classList.add("bases-rendered-value"); }
  render(entry: Entry): void {
    const previous = this.entry;
    this.entry = entry;
    if (previous?.file === entry.file && this.path === entry.file.path) return;
    this.path = entry.file.path;
    this.el.replaceChildren();
    this.view.controller.renderContext.renderFileLink(entry.file, null, this.el);
  }
}

/** Read-only values: file properties and formulas. */
class ValueRenderer extends CellRenderer {
  private value: Value | null = null; private error: string | null = null; private rendered = false;
  constructor(view: BasesView, prop: PropertyId, cell: HTMLElement) { super(view, prop, cell); cell.classList.add("bases-rendered-value"); }
  render(entry: Entry): void {
    let value: Value | null = null, error: string | null = null;
    try { value = entry.getValue(this.prop); } catch (thrown) { error = (thrown as Error).message; }
    this.entry = entry;
    if (this.rendered && Value.equals(this.value, value) && error === this.error && !(value instanceof FileValue || value instanceof LinkValue || value instanceof ListValue || value instanceof ObjectValue)) return;
    this.value = value; this.error = error; this.rendered = true;
    const cell = this.el;
    cell.replaceChildren();
    cell.dataset.propertyType = value ? valueWidgetType(value) : "";
    if (error !== null) {
      const wrap = div(cell, "bases-formula-error"); wrap.setAttribute("aria-label", error);
      setIcon(div(wrap, "warning-icon"), "lucide-info");
      div(wrap, "bases-formula-error-message", error);
      wrap.addEventListener("dblclick", event => { event.preventDefault(); this.view.controller.openPropertyEditor(this.prop, cell); });
      return;
    }
    value?.renderTo(cell, this.view.controller.renderContext);
  }
}
function valueWidgetType(value: Value): string {
  if (value instanceof NullValue || value instanceof StringValue) return "text";
  if (value instanceof NumberValue) return "number";
  if (value instanceof ListValue) return "multitext";
  const type = (value.constructor as typeof Value).type;
  return type === "boolean" ? "checkbox" : type === "date" ? "date" : "unknown";
}

/** Note properties: an editor that writes back to the note's frontmatter. */
class NoteRenderer extends CellRenderer {
  widget: Widget | null = null;
  private serialized: string | undefined; private type = ""; private path = "";
  constructor(view: BasesView, prop: PropertyId, cell: HTMLElement) { super(view, prop, cell); cell.classList.add("bases-metadata-value", "metadata-property-value"); }
  render(entry: Entry): void {
    const { name } = parsePropertyId(this.prop), cell = this.el, raw = entry.getRawProperty(name), serialized = JSON.stringify(raw) ?? "null";
    this.entry = entry;
    if (entry.file.extension.toLowerCase() !== "md") { this.widget = null; this.serialized = undefined; cell.replaceChildren(); cell.setAttribute("disabled", "true"); return; }
    cell.removeAttribute("disabled");
    const type = raw == null ? this.view.controller.getPropertyWidget(this.prop) : inferPropertyType(name, raw);
    if (this.widget && type === this.type && serialized === this.serialized && this.path === entry.file.path) return;
    // Never rebuild an editor the user is typing in; the pending change will come back through the cache.
    if (this.widget && cell.contains(cell.ownerDocument.activeElement) && this.path === entry.file.path && type === this.type) { this.serialized = serialized; return; }
    this.type = type; this.serialized = serialized; this.path = entry.file.path;
    cell.dataset.propertyType = type;
    this.widget = renderWidget(cell, type, raw, {
      app: this.view.app, sourcePath: entry.file.path, placeholder: "",
      onChange: value => {
        const next = JSON.stringify(value) ?? "null";
        if (next === this.serialized) return;
        this.serialized = next;
        void this.view.updateProperty(this.entry!.file, name, value);
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout base

export interface ViewOption {
  displayName: string; key: string; type: "dropdown" | "slider" | "text" | "toggle" | "property" | "file" | "folder" | "formula" | "multitext";
  options?: Record<string, string>; min?: number; max?: number; step?: number; instant?: boolean; default?: unknown; placeholder?: string;
  filter?: (value: any) => boolean; shouldHide?: (config: ViewConfig) => boolean;
}
export interface ViewOptionGroup { displayName: string; type: "group"; items: ViewOption[]; shouldHide?: () => boolean }

export abstract class BasesView extends Component {
  abstract readonly type: string;
  config!: ViewConfig;
  data!: ViewData;
  allProperties: PropertyId[] = [];
  readonly app: App;
  protected viewCleanups: Array<() => void> = [];
  readonly scrollEl: HTMLElement;
  constructor(readonly controller: BasesController, scrollEl?: HTMLElement) { super(); this.app = controller.app; this.scrollEl = scrollEl ?? controller.viewContainerEl; }
  get queryController(): BasesController { return this.controller; }
  createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    return this.controller.openNewItem(baseFileName, frontmatterProcessor);
  }
  abstract onDataUpdated(): void;
  onResize(): void {}
  focus(): void {}
  private destroyed = false;
  destroy(): void {
    this.unload();
    this.destroyed = true;
    if (this.frame) (this.scrollEl.ownerDocument.defaultView ?? window).cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const cleanup of this.viewCleanups.splice(0)) cleanup();
    this.scrollEl.replaceChildren();
  }
  onGroupCollapsedChange(_group: EntryGroup): void {}

  createGroupHeadingEl(group: EntryGroup): HTMLElement | null {
    if (!group.key) return null;
    const heading = div(null, "bases-group-heading mod-collapsible"), config = this.config;
    heading.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || (event.target as Element).closest("a")) return;
      event.preventDefault();
      this.toggleGroupCollapsed(group);
      setCollapsed(heading, this.isGroupCollapsed(group));
    });
    if (config.groupBy) div(heading, "bases-group-property", config.getDisplayName(config.groupBy.property));
    const valueEl = div(heading, "bases-group-value");
    if (group.key instanceof NullValue) valueEl.textContent = t("plugins.bases.label-group-key-none"); else group.key.renderTo(valueEl, this.controller.renderContext);
    iconDiv(heading, "collapse-indicator collapse-icon", "lucide-chevron-right");
    setCollapsed(heading, this.isGroupCollapsed(group));
    return heading;
  }
  static getGroupId(group: EntryGroup): string | null { return group.key ? `${(group.key.constructor as typeof Value).type}:${group.key}` : null; }
  isGroupCollapsed(group: EntryGroup): boolean { const id = BasesView.getGroupId(group); return !!id && this.controller.getGroupFolds().has(id); }
  toggleGroupCollapsed(group: EntryGroup): void {
    const id = BasesView.getGroupId(group);
    if (!id) return;
    const folds = this.controller.getGroupFolds();
    if (!folds.delete(id)) folds.add(id);
    this.controller.saveGroupFolds();
    this.onGroupCollapsedChange(group);
  }
  async updateProperty(file: TFile, name: string, value: unknown): Promise<void> {
    try {
      await this.app.fileManager.processFrontMatter(file, frontmatter => {
        const key = resolveKey(frontmatter, name);
        if (!Object.hasOwn(frontmatter, key) && value == null) return;
        frontmatter[key] = value;
      });
    } catch (error) { new Notice((error as Error).message); }
  }
  exportTable(): { headers: string[]; rows: string[][] } {
    const { data, config } = this;
    return {
      headers: data.properties.map(property => config.getDisplayName(property)),
      rows: data.data.map(entry => data.properties.map(property => { try { const value = entry.getValue(property); return !value || value instanceof NullValue ? "" : value.toString(); } catch { return ""; } })),
    };
  }
  async copyToClipboard(): Promise<void> {
    const table = this.exportTable();
    try {
      const tsv = toDelimited(table, "\t"), markdown = toMarkdownTable(table);
      const html = `<table><thead><tr>${table.headers.map(cell => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${table.rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([tsv || markdown], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      else await navigator.clipboard.writeText(tsv);
      new Notice(t("interface.copied_generic"));
    } catch { new Notice(t("interface.copy_failed")); }
  }
  createRenderer(prop: PropertyId, cell: HTMLElement): CellRenderer {
    return prop === "file.name" ? new FileNameRenderer(this, prop, cell) : parsePropertyId(prop).type === "note" ? new NoteRenderer(this, prop, cell) : new ValueRenderer(this, prop, cell);
  }
  /** Schedules one relayout per frame however many scroll and resize events arrive. */
  protected frame = 0;
  protected scheduleDisplay(): void {
    if (this.frame || this.destroyed) return;
    const win = this.scrollEl.ownerDocument.defaultView ?? window;
    this.frame = win.requestAnimationFrame(() => { this.frame = 0; this.updateVirtualDisplay(); });
  }
  protected updateVirtualDisplay(): void {}
}
const escapeHtml = (text: string) => text.replace(/[&<>]/g, ch => ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;");
export function toDelimited(table: { headers: string[]; rows: string[][] }, separator: string): string {
  const quote = (cell: string) => separator === "," ? (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell) : cell.replace(/[\t\r\n]+/g, " ");
  return [table.headers, ...table.rows].map(row => row.map(quote).join(separator)).join("\n");
}
export function toMarkdownTable(table: { headers: string[]; rows: string[][] }): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const line = (row: string[]) => `| ${row.map(cell).join(" | ")} |`;
  return [line(table.headers), `| ${table.headers.map(() => "---").join(" | ")} |`, ...table.rows.map(line)].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Table

class ColumnInfo {
  headerWidth = 0; contentWidth = 0; customWidth = 0;
  getWidth(min: number, max: number): number { return this.customWidth ? Math.max(min, this.customWidth) : Math.max(min, Math.min(max, Math.max(this.contentWidth, this.headerWidth) + 1)); }
}
abstract class TableCell { readonly el = div(null, "bases-td"); constructor(readonly view: TableView, public prop: PropertyId) {} }
abstract class TableRow<C extends TableCell> {
  readonly el = div(null, "bases-tr");
  cells: C[] = [];
  constructor(readonly view: TableView) {}
  protected abstract createCell(prop: PropertyId): C;
  /** Reuses cells for columns that are still shown. */
  protected syncCells(props: PropertyId[]): void {
    const existing = new Map(this.cells.map(cell => [cell.prop, cell]));
    this.cells = props.map(prop => existing.get(prop) ?? this.createCell(prop));
  }
  layout(widths: number[]): void {
    let offset = 0;
    this.cells.forEach((cell, index) => { const width = widths[index] ?? 0; cell.el.style.insetInlineStart = `${offset}px`; cell.el.style.width = `${width}px`; offset += width; });
    setChildren(this.el, this.cells.map(cell => cell.el));
  }
}

class HeaderCell extends TableCell {
  readonly headerEl: HTMLElement; readonly innerEl: HTMLElement; readonly iconEl: HTMLElement; readonly nameEl: HTMLElement; readonly sortEl: HTMLElement; readonly resizerEl: HTMLElement;
  constructor(view: TableView, prop: PropertyId) {
    super(view, prop);
    const cell = this.el;
    cell.draggable = true;
    this.headerEl = div(cell, "bases-table-header");
    this.innerEl = div(this.headerEl, "bases-table-header-label");
    this.sortEl = div(cell, "bases-table-header-sort");
    this.resizerEl = div(cell, "bases-table-header-resizer"); this.resizerEl.draggable = true;
    this.iconEl = div(this.innerEl, "bases-table-header-icon");
    this.nameEl = div(this.innerEl, "bases-table-header-name");
    cell.addEventListener("click", event => { if (event.defaultPrevented || event.button !== 0 || event.target === this.resizerEl) return; event.preventDefault(); view.config.setSortProperty(this.prop, "TOGGLE"); });
    cell.addEventListener("contextmenu", event => { if (event.defaultPrevented || event.target === this.resizerEl) return; event.preventDefault(); this.showMenu(event); });
    cell.addEventListener("dragstart", event => { if (event.target === this.resizerEl) return; view.startColumnDrag(event, this); });
    this.resizerEl.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
    this.resizerEl.addEventListener("dblclick", event => { event.preventDefault(); event.stopPropagation(); view.resetColumnSize(this.prop); });
    this.resizerEl.addEventListener("dragstart", event => event.preventDefault());
    this.resizerEl.addEventListener("pointerdown", event => view.startColumnResize(event, this));
  }
  private measuredFor = ""; private measured = 0;
  /** Natural width of the label, re-measured only when the caption or sort marker changes. */
  measure(): number {
    const key = `${this.nameEl.textContent}|${this.el.dataset.sort ?? ""}`;
    if (key === this.measuredFor && this.measured) return this.measured;
    this.el.classList.add("is-measuring");
    const width = this.innerEl.scrollWidth;
    this.el.classList.remove("is-measuring");
    if (width > 0) { this.measuredFor = key; this.measured = width; }
    return width;
  }
  render(): void {
    const { view, prop, el: cell } = this, { type } = parsePropertyId(prop), config = view.config;
    cell.classList.toggle("mod-formula", type === "formula"); cell.classList.toggle("mod-implicit", type === "file");
    this.nameEl.textContent = config.getDisplayName(prop);
    setIcon(this.iconEl, view.controller.getPropertyIcon(prop));
    const sort = config.getSort().find(item => item.property === prop);
    if (sort) { cell.dataset.sort = sort.direction; setIcon(this.sortEl, sort.direction === "ASC" ? "lucide-chevron-up" : "lucide-chevron-down"); }
    else { delete cell.dataset.sort; this.sortEl.replaceChildren(); }
  }
  private showMenu(event: MouseEvent): void {
    const { view, prop } = this, { type, name } = parsePropertyId(prop), config = view.config, controller = view.controller;
    const menu = new Menu();
    menu.addItem(item => item.setTitle(t("plugins.bases.table.action-hide-column")).setSection("action").setIcon("lucide-eye-off").onClick(() => config.setOrder(config.getOrder().filter(other => other !== prop))));
    menu.addItem(item => item.setTitle(t("plugins.bases.table.action-select-summary")).setSection("action").setIcon("lucide-calculator").onClick(() => controller.openSummaryMenu(prop, view.data.data, this.el)));
    if (controller.canGroupBy(prop)) menu.addItem(item => item.setTitle(t("plugins.bases.table.action-group-by")).setSection("action").setIcon("lucide-group").onClick(() => config.setGroupBy({ property: prop, direction: "ASC" })));
    if (type === "note") menu.addItem(item => {
      item.setTitle(t("properties.option-property-type")).setIcon("lucide-info").setSection("action");
      const submenu = item.setSubmenu(), current = controller.getPropertyWidget(prop);
      for (const widget of ["text", "multitext", "number", "checkbox", "date", "datetime"] as PropertyType[]) submenu.addItem(entry => entry.setTitle(t(`properties.types.option-${widget}`)).setIcon(WIDGET_ICONS[widget] ?? "lucide-text").setChecked(current === widget ? true : null).onClick(() => controller.setPropertyWidget(name, widget)));
    });
    if (view.hasCustomColumnSize(prop)) menu.addItem(item => item.setTitle(t("plugins.bases.table.action-reset-column-size")).setSection("resize").setIcon("lucide-rotate-ccw").onClick(() => view.resetColumnSize(prop)));
    const sort = config.getSort().find(item => item.property === prop);
    menu.addItem(item => item.setTitle(t("plugins.bases.table.action-sort-a-z")).setSection("sort").setChecked(sort?.direction === "ASC" ? true : null).setIcon("lucide-arrow-down-wide-narrow").onClick(() => config.setSortProperty(prop, "ASC")));
    menu.addItem(item => item.setTitle(t("plugins.bases.table.action-sort-z-a")).setSection("sort").setChecked(sort?.direction === "DESC" ? true : null).setIcon("lucide-arrow-up-narrow-wide").onClick(() => config.setSortProperty(prop, "DESC")));
    if (sort) menu.addItem(item => item.setTitle(t("plugins.bases.table.action-sort-default")).setSection("sort").setIcon("lucide-eraser").setWarning(true).onClick(() => config.setSortProperty(prop, "NONE")));
    menu.addItem(item => item.setTitle(t(type === "formula" ? "plugins.bases.table.action-edit-formula" : "plugins.bases.table.action-edit-property")).setSection("danger").setIcon("lucide-edit-3").onClick(() => controller.openPropertyEditor(prop, this.headerEl)));
    this.el.classList.add("has-active-menu");
    menu.onHide(() => this.el.classList.remove("has-active-menu"));
    menu.showAtMouseEvent(event);
  }
}
export const WIDGET_ICONS: Record<string, string> = { text: "lucide-text", multitext: "lucide-list", number: "lucide-binary", checkbox: "lucide-check-square", date: "lucide-calendar", datetime: "lucide-clock", aliases: "lucide-forward", tags: "lucide-tags" };

class HeaderRow extends TableRow<HeaderCell> {
  constructor(view: TableView) { super(view); this.el.dataset.ignoreSwipe = "true"; }
  protected createCell(prop: PropertyId): HeaderCell { return new HeaderCell(this.view, prop); }
  render(props: PropertyId[]): void { this.syncCells(props); for (const cell of this.cells) cell.render(); }
}

class BodyCell extends TableCell {
  readonly renderer: CellRenderer;
  constructor(view: TableView, prop: PropertyId) {
    super(view, prop);
    this.el.dataset.property = prop;
    const inner = div(this.el, "bases-table-cell");
    this.renderer = view.createRenderer(prop, inner);
    inner.addEventListener("click", event => {
      if (event.defaultPrevented || event.target !== inner || !(this.renderer instanceof NoteRenderer)) return;
      const widget = this.renderer.widget;
      if (widget && widget.type !== "checkbox") widget.focus();
    });
  }
}
class BodyRow extends TableRow<BodyCell> {
  entry: Entry | null = null;
  protected createCell(prop: PropertyId): BodyCell { return new BodyCell(this.view, prop); }
  render(entry: Entry, props: PropertyId[]): void { this.entry = entry; this.syncCells(props); for (const cell of this.cells) cell.renderer.render(entry); }
}

class SummaryCell extends TableCell {
  private readonly innerEl: HTMLElement;
  private entries: Entry[] = [];
  constructor(view: TableView, prop: PropertyId) {
    super(view, prop);
    const cell = div(this.el, "bases-table-summary-cell");
    iconDiv(cell, "summary-expand-button", "lucide-chevrons-up-down");
    this.innerEl = div(cell, "summary-content");
    cell.addEventListener("click", () => view.controller.openSummaryMenu(this.prop, this.entries, cell));
  }
  render(entries: Entry[]): void {
    this.entries = entries;
    const { view, prop, innerEl } = this, key = view.config.getSummaryKey(prop);
    innerEl.replaceChildren();
    if (!key) { el(innerEl, "span", "placeholder", t("plugins.bases.table.label-summary")); return; }
    const value = view.data.getSummaryValue(view.controller.query!, entries, prop, key);
    div(innerEl, "summary-function-name", key);
    div(innerEl, "summary-function-value", value instanceof NullValue ? t("properties.label-no-value") : value.toString());
  }
}
class SummaryRow extends TableRow<SummaryCell> {
  constructor(view: TableView, private readonly location: "group" | "footer") { super(view); }
  protected createCell(prop: PropertyId): SummaryCell { return new SummaryCell(this.view, prop); }
  shouldDisplay(): boolean {
    const summaries = this.view.config.summaries, order = new Set(this.view.config.getOrder());
    if (!summaries || !Object.keys(summaries).some(prop => order.has(prop))) return false;
    return this.view.data.groupedData.length > 1 || this.location === "footer";
  }
  render(props: PropertyId[], entries: Entry[]): void { this.syncCells(props); for (const cell of this.cells) cell.render(entries); }
}

class TableGroup {
  readonly tableEl = div(null, "bases-table");
  readonly summaryRow: SummaryRow;
  readonly tbodyEl: HTMLElement;
  selfHeight = 0; childStart = 0;
  constructor(readonly view: TableView) {
    this.summaryRow = new SummaryRow(view, "group");
    this.summaryRow.el.classList.add("bases-table-group-summary-row");
    this.tbodyEl = div(this.tableEl, "bases-tbody");
  }
  render(props: PropertyId[], group: EntryGroup): void {
    const children = [this.tbodyEl], heading = this.view.createGroupHeadingEl(group);
    if (heading) children.unshift(heading);
    if (this.summaryRow.shouldDisplay()) { children.splice(children.length - 1, 0, this.summaryRow.el); this.summaryRow.render(props, group.entries); }
    setChildren(this.tableEl, children);
  }
}

export class TableView extends BasesView {
  readonly type = "table";
  private readonly theadEl: HTMLElement; readonly containerEl: HTMLElement;
  private readonly header: HeaderRow; private readonly footer: SummaryRow;
  private groups: TableGroup[] = [];
  private rows = new Map<Entry, BodyRow>();
  private columnInfo: Record<PropertyId, ColumnInfo> = {};
  private minColWidth = 40; private maxColWidth = 300;
  private widths: number[] = [];

  constructor(controller: BasesController, scrollEl: HTMLElement) {
    super(controller, scrollEl);
    this.theadEl = div(scrollEl, "bases-thead");
    this.header = new HeaderRow(this);
    this.theadEl.append(this.header.el);
    this.containerEl = div(scrollEl, "bases-table-container is-loading"); this.containerEl.tabIndex = 0;
    this.footer = new SummaryRow(this, "footer");
    this.footer.el.classList.add("bases-table-footer");
    this.viewCleanups.push(watchScroll(this.containerEl, () => this.scheduleDisplay()));
  }
  static getViewOptions(): ViewOption[] {
    return [{ displayName: t("plugins.bases.table.label-row-height"), type: "dropdown", key: "rowHeight", options: { "": t("plugins.bases.table.option-short"), medium: t("plugins.bases.table.option-medium"), tall: t("plugins.bases.table.option-tall"), extra: t("plugins.bases.table.option-extra-tall") } }];
  }
  override focus(): void { this.containerEl.focus({ preventScroll: true }); }
  override onResize(): void { this.scheduleDisplay(); }
  override onGroupCollapsedChange(): void { this.updateVirtualDisplay(); }
  onDataUpdated(): void { this.containerEl.classList.remove("is-loading"); this.display(); }

  private display(): void {
    const props = this.data.properties, sizes = this.config.get("columnSize");
    for (const prop of props) {
      const info = this.columnInfo[prop] ??= new ColumnInfo();
      const stored = sizes && typeof sizes === "object" ? (sizes as Record<string, unknown>)[prop] ?? (sizes as Record<string, unknown>)[prop.replace(/^note\./, "")] : null;
      info.customWidth = typeof stored === "number" && stored > 0 ? stored : 0;
    }
    const grouped = this.data.groupedData;
    while (this.groups.length < grouped.length) this.groups.push(new TableGroup(this));
    this.groups.length = grouped.length;
    this.groups.forEach((group, index) => group.render(props, grouped[index]!));
    this.header.render(props);
    this.footer.render(props, this.data.data);
    this.updateVirtualDisplay();
  }
  private rowHeight(): number {
    const base = px(getComputedStyle(this.scrollEl).getPropertyValue("--bases-table-row-height"), 30);
    const mult = ({ medium: 2, tall: 4, extra: 8 } as Record<string, number>)[String(this.config.get("rowHeight") ?? "")] ?? 1;
    this.containerEl.classList.toggle("mod-multiline", mult > 1);
    return base * mult;
  }
  /** Measures the widest value of each unsized column by rendering it once off to the side. */
  private measureColumns(props: PropertyId[]): void {
    const pending = props.filter(prop => { const info = this.columnInfo[prop]!; return !info.customWidth && !info.contentWidth; });
    // Nothing can be measured while the tab is hidden; try again once it has a size.
    if (!pending.length || !this.groups.length || !this.data.data.length || !this.containerEl.isConnected) return;
    const probe = div(this.groups[0]!.tbodyEl, "bases-tr"), sample = this.data.data.slice(0, 400), cells: BodyCell[] = [];
    for (const prop of pending) {
      let longest: Entry | null = null, length = -1;
      for (const entry of sample) { try { const text = entry.getValue(prop)?.toString() ?? ""; if (text.length > length) { length = text.length; longest = entry; } } catch { /* ignore */ } }
      if (!longest) continue;
      const cell = new BodyCell(this, prop);
      probe.append(cell.el); cell.renderer.render(longest);
      cell.el.style.contain = "strict"; cell.el.classList.add("is-measuring");
      cells.push(cell);
    }
    // An all-empty column still counts as measured once the table has a size, so it is not probed on every frame.
    const laidOut = this.scrollEl.clientWidth > 0;
    for (const cell of cells) this.columnInfo[cell.prop]!.contentWidth = Math.max(laidOut ? 1 : 0, cell.renderer.el.scrollWidth);
    probe.remove();
  }
  protected override updateVirtualDisplay(): void {
    const { data, config, containerEl, scrollEl } = this;
    if (!data || !config || !isShown(scrollEl) || !scrollEl.isConnected) return;
    const props = data.properties, grouped = data.groupedData, style = getComputedStyle(containerEl);
    setChildren(containerEl, this.groups.map(group => group.tableEl));
    this.minColWidth = px(style.getPropertyValue("--bases-table-column-min-width"), 40);
    this.maxColWidth = px(style.getPropertyValue("--bases-table-column-max-width"), 300);
    const gap = px(style.getPropertyValue("--bases-table-group-gap"), 10), rowHeight = this.rowHeight();
    this.measureColumns(props);
    setChildren(this.header.el, this.header.cells.map(cell => cell.el));
    for (const cell of this.header.cells) this.columnInfo[cell.prop]!.headerWidth = cell.measure();
    const widths = this.widths = props.map(prop => this.columnInfo[prop]!.getWidth(this.minColWidth, this.maxColWidth));
    let total = widths.reduce((sum, width) => sum + width, 0);
    const available = scrollEl.clientWidth - 1, last = props.at(-1);
    if (last && !this.columnInfo[last]!.customWidth && total < available) { widths[widths.length - 1]! += available - total; total = available; }

    this.groups.forEach((group, index) => {
      const collapsed = this.isGroupCollapsed(grouped[index]!);
      group.tableEl.classList.toggle("is-collapsed", collapsed);
      group.tableEl.style.width = `${total}px`;
      group.tbodyEl.style.height = `${collapsed ? 0 : grouped[index]!.entries.length * rowHeight}px`;
      group.tbodyEl.style.setProperty("--bases-table-row-height", `${rowHeight}px`);
      if (group.summaryRow.shouldDisplay()) { group.summaryRow.el.style.width = `${total}px`; group.summaryRow.layout(widths); }
    });
    for (const group of this.groups) {
      const outer = group.tableEl.getBoundingClientRect(), inner = group.tbodyEl.getBoundingClientRect();
      group.selfHeight = outer.height - inner.height; group.childStart = inner.top - outer.top;
    }
    const viewport = visibleRect(containerEl), overscan = rowHeight * 8, used = new Map<Entry, BodyRow>();
    let offset = 0;
    this.groups.forEach((group, index) => {
      const entries = grouped[index]!.entries, collapsed = this.isGroupCollapsed(grouped[index]!), bodyHeight = collapsed ? 0 : entries.length * rowHeight;
      const bodyTop = offset + group.childStart, bodyBottom = bodyTop + bodyHeight, rowEls: HTMLElement[] = [];
      group.tableEl.style.top = `${offset}px`;
      if (!collapsed && bodyTop <= viewport.bottom + overscan && bodyBottom >= viewport.top - overscan) {
        const first = Math.floor(Math.max(viewport.top - overscan - bodyTop, 0) / rowHeight), end = entries.length - Math.floor(Math.max(bodyBottom - viewport.bottom - overscan, 0) / rowHeight);
        for (let rowIndex = first; rowIndex < end; rowIndex++) {
          const entry = entries[rowIndex]!, row = this.rows.get(entry) ?? this.adoptRow(entry) ?? new BodyRow(this);
          used.set(entry, row);
          row.render(entry, props); row.layout(widths);
          row.el.style.top = `${rowIndex * rowHeight}px`; row.el.style.width = `${total}px`;
          rowEls.push(row.el);
        }
      }
      setChildren(group.tbodyEl, rowEls);
      offset += group.selfHeight + bodyHeight + (index < this.groups.length - 1 ? gap : 0);
    });
    this.rows = used;
    this.header.layout(widths);
    this.theadEl.style.width = `${total}px`;
    containerEl.style.width = `${total}px`; containerEl.style.height = `${offset}px`;
    const children = [this.theadEl, containerEl];
    if (this.footer.shouldDisplay()) { children.push(this.footer.el); this.footer.el.style.width = `${total}px`; this.footer.layout(widths); }
    setChildren(scrollEl, children);
  }
  /** After a re-query the entries are new objects; keep the row (and any focused editor) for the same file. */
  private adoptRow(entry: Entry): BodyRow | null {
    for (const [previous, row] of this.rows) if (previous.file === entry.file) { this.rows.delete(previous); return row; }
    return null;
  }

  hasCustomColumnSize(prop: PropertyId): boolean { return (this.columnInfo[prop]?.customWidth ?? 0) > 0; }
  resetColumnSize(prop: PropertyId): void {
    const info = this.columnInfo[prop];
    if (!info) return;
    info.customWidth = 0; info.contentWidth = 0;
    this.updateVirtualDisplay(); this.saveColumnSizes();
  }
  private saveColumnSizes(): void {
    const sizes: Record<string, number> = {};
    for (const prop of this.data.properties) { const width = this.columnInfo[prop]?.customWidth; if (width) sizes[prop] = width; }
    this.config.set("columnSize", Object.keys(sizes).length ? sizes : null);
  }
  startColumnResize(event: PointerEvent, cell: HeaderCell): void {
    if (event.button !== 0) return;
    const info = this.columnInfo[cell.prop];
    if (!info) return;
    event.preventDefault(); event.stopPropagation();
    const resizer = cell.resizerEl, startX = event.clientX, startWidth = cell.el.offsetWidth, rtl = getComputedStyle(cell.el).direction === "rtl", doc = resizer.ownerDocument;
    resizer.classList.add("is-active"); doc.body.classList.add("is-grabbing");
    const move = (moveEvent: PointerEvent) => { moveEvent.preventDefault(); info.customWidth = Math.max(this.minColWidth, Math.round(startWidth + (moveEvent.clientX - startX) * (rtl ? -1 : 1))); this.scheduleDisplay(); };
    const stop = () => {
      doc.removeEventListener("pointermove", move, true); doc.removeEventListener("pointerup", stop, true); doc.removeEventListener("pointercancel", stop, true);
      resizer.classList.remove("is-active"); doc.body.classList.remove("is-grabbing");
      this.saveColumnSizes();
    };
    doc.addEventListener("pointermove", move, true); doc.addEventListener("pointerup", stop, true); doc.addEventListener("pointercancel", stop, true);
  }
  /** Drag a header to reorder columns; a vertical marker shows where it will land. */
  startColumnDrag(event: DragEvent, cell: HeaderCell): void {
    const props = this.data.properties, from = props.findIndex(property => property === cell.prop), doc = this.scrollEl.ownerDocument;
    if (from < 0 || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", this.config.getDisplayName(cell.prop));
    const marker = div(null, "table-drag-target mod-col"); Object.assign(marker.style, { top: "0", transition: "all 75ms ease-in" });
    let target = from;
    const over = (dragEvent: DragEvent) => {
      dragEvent.preventDefault(); if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
      const bounds = this.containerEl.getBoundingClientRect(), x = dragEvent.clientX - bounds.left;
      if (!marker.isConnected) this.containerEl.append(marker);
      let edge = 0; target = 0;
      for (const width of this.widths) { if (x < edge + width / 2) break; edge += width; target++; }
      marker.style.insetInlineStart = `${Math.max(edge, 2)}px`; marker.style.height = `${bounds.height}px`;
    };
    const finish = () => { doc.removeEventListener("dragover", over, true); doc.removeEventListener("dragenter", over, true); doc.removeEventListener("drop", drop, true); marker.remove(); };
    const drop = (dropEvent: DragEvent) => {
      dropEvent.preventDefault(); finish();
      if (target > from) target--;
      if (target === from) return;
      const order = [...props]; arrayMove(order, from, target);
      this.config.setOrder(order);
    };
    doc.addEventListener("dragover", over, true); doc.addEventListener("dragenter", over, true); doc.addEventListener("drop", drop, true);
    cell.el.addEventListener("dragend", finish, { once: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards

class CardProperty {
  readonly el = div(null, "bases-cards-property");
  private readonly labelEl: HTMLElement; private readonly renderer: CellRenderer;
  constructor(private readonly view: CardsView, readonly prop: PropertyId) {
    this.labelEl = div(this.el, "bases-cards-label");
    const lineEl = div(this.el, "bases-cards-line");
    this.el.dataset.property = prop;
    this.renderer = new ValueRenderer(view, prop, lineEl);
  }
  render(entry: Entry): void {
    const label = this.view.config.getDisplayName(this.prop);
    if (this.labelEl.textContent !== label) this.labelEl.textContent = label;
    this.renderer.render(entry);
  }
}
class CardItem {
  readonly el = div(null, "bases-cards-item");
  entry: Entry | null = null;
  private props: CardProperty[] = [];
  private coverEl: HTMLElement | null = null;
  constructor(private readonly view: CardsView) {
    const card = this.el, app = view.app;
    card.tabIndex = 0;
    const open = (event: MouseEvent) => {
      if ((event.button !== 0 && event.button !== 1) || event.defaultPrevented || !this.entry) return;
      const selection = card.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && card.contains(selection.anchorNode)) return;
      if ((event.target as Element).closest("a")) return;
      event.preventDefault();
      void app.workspace.openLinkText(this.entry.file.path, "", event.button === 1 || event.ctrlKey || event.metaKey);
    };
    card.addEventListener("click", open); card.addEventListener("auxclick", open);
    card.addEventListener("contextmenu", event => {
      if (!this.entry || event.defaultPrevented) return;
      event.preventDefault();
      const menu = new Menu(), file = this.entry.file;
      app.workspace.trigger("file-menu", menu, file, "bases-context-menu", null);
      menu.addItem(item => item.setSection("danger").setTitle(t("interface.menu.delete-file")).setIcon("lucide-trash-2").setWarning(true).onClick(() => { void app.fileManager.promptForDeletion(file).then(confirmed => confirmed ? app.fileManager.trashFile(file) : undefined); }));
      menu.showAtMouseEvent(event);
    });
  }
  render(entry: Entry, order: PropertyId[]): void {
    this.entry = entry;
    const view = this.view, m = view.measurements, existing = new Map(this.props.map(prop => [prop.prop, prop]));
    this.props = order.map(prop => existing.get(prop) ?? new CardProperty(view, prop));
    const children: HTMLElement[] = [];
    let top = 0;
    if (view.imageProp) {
      const cover = this.coverEl ??= div(null, "bases-cards-cover");
      view.applyCover(entry, cover);
      Object.assign(cover.style, { top: `${top}px`, insetInline: "0", height: `${m.coverHeight}px`, backgroundSize: view.imageFitContain ? "contain" : "cover" });
      children.push(cover); top += m.coverHeight;
    } else this.coverEl = null;
    top += m.cardPad.top;
    this.props.forEach((prop, index) => {
      prop.render(entry);
      prop.el.classList.toggle("mod-title", index === 0);
      const height = index === 0 ? m.titleHeight : m.propHeight;
      Object.assign(prop.el.style, { top: `${top}px`, insetInlineStart: `${m.cardPad.start}px`, insetInlineEnd: `${m.cardPad.end}px`, height: `${height}px` });
      children.push(prop.el); top += height + m.propGap;
    });
    setChildren(this.el, children);
  }
}
interface Padding { top: number; bottom: number; start: number; end: number }
const padding = (style: CSSStyleDeclaration): Padding => ({ top: px(style.paddingTop, 0), bottom: px(style.paddingBottom, 0), start: px(style.paddingInlineStart, 0), end: px(style.paddingInlineEnd, 0) });

export class CardsView extends BasesView {
  readonly type = "cards";
  readonly containerEl: HTMLElement;
  imageProp: PropertyId | null = null; imageFitContain = false; imageAspectRatio = 1;
  measurements = { pad: { top: 0, bottom: 0, start: 0, end: 0 } as Padding, groupGap: 0, groupHeadingHeight: 0, groupPad: { top: 0, bottom: 0, start: 0, end: 0 } as Padding, cardGap: 0, cardPad: { top: 0, bottom: 0, start: 0, end: 0 } as Padding, propGap: 0, cardsPerRow: 1, cardWidth: 200, cardHeight: 200, coverHeight: 100, titleHeight: 24, propHeight: 24 };
  private groups: Array<{ containerEl: HTMLElement; headingEl: HTMLElement | null }> = [];
  private items = new Map<Entry, CardItem>();
  private testers: Record<"group" | "groupHeading" | "card" | "cover" | "title" | "prop", HTMLElement> | null = null;

  constructor(controller: BasesController, scrollEl: HTMLElement) {
    super(controller, scrollEl);
    this.containerEl = div(scrollEl, "bases-cards-container is-loading"); this.containerEl.tabIndex = 0;
    this.viewCleanups.push(watchScroll(this.containerEl, () => this.scheduleDisplay()));
  }
  static getViewOptions(): ViewOption[] {
    return [
      { displayName: t("plugins.bases.cards.label-card-size"), type: "slider", key: "cardSize", min: 50, max: 800, step: 10, default: 200 },
      { displayName: t("plugins.bases.cards.label-image-property"), type: "property", key: "image", filter: prop => prop === "file.file" || !prop.startsWith("file."), placeholder: t("plugins.bases.label-property-key") },
      { displayName: t("plugins.bases.cards.label-image-fit"), type: "dropdown", key: "imageFit", options: { "": t("plugins.bases.cards.option-image-fit-cover"), contain: t("plugins.bases.cards.option-image-fit-contain") } },
      { displayName: t("plugins.bases.cards.label-image-aspect-ratio"), key: "imageAspectRatio", type: "slider", min: 0.25, max: 2.5, step: 0.05, default: 1 },
    ];
  }
  override focus(): void { this.containerEl.focus({ preventScroll: true }); }
  override onResize(): void { this.scheduleDisplay(); }
  override onGroupCollapsedChange(): void { this.updateVirtualDisplay(); }
  onDataUpdated(): void {
    this.containerEl.classList.remove("is-loading");
    if (!this.data.data.length) { this.containerEl.replaceChildren(); this.containerEl.style.height = ""; this.groups = []; return; }
    this.groups = this.data.groupedData.map(group => ({ containerEl: div(null, "bases-cards-group"), headingEl: this.createGroupHeadingEl(group) }));
    // Entries are rebuilt by a re-query; keep each file's card element.
    const byFile = new Map([...this.items].map(([entry, item]) => [entry.file, item]));
    this.items = new Map();
    for (const entry of this.data.data) { const item = byFile.get(entry.file); if (item) this.items.set(entry, item); }
    this.updateVirtualDisplay();
  }
  /** Shows the image a card's cover property points at: a vault file, a URL or a hex colour. */
  applyCover(entry: Entry, cover: HTMLElement): void {
    let value: Value | null = null;
    try { value = entry.getValue(this.imageProp!); while (value instanceof ListValue) value = value.get(0); } catch { /* no cover */ }
    let color = "", src = "", file: TFile | null = null;
    if (value instanceof FileValue) file = value.value;
    else if (value instanceof LinkValue) file = value.resolve();
    else if (value instanceof StringValue) {
      const text = value.value;
      if (/^https?:\/\//.test(text)) src = text;
      else if (/^#[a-f\d]{6}$/i.test(text)) color = text;
      else { const dest = this.app.metadataCache.getFirstLinkpathDest(text, entry.file.path); file = dest ? this.app.vault.getFileByPath(dest.path) : null; }
    }
    if (file && IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) src = this.app.vault.getResourcePath(file);
    cover.style.backgroundColor = color;
    cover.style.backgroundImage = src ? `url("${src.replace(/"/g, "%22")}")` : "";
  }
  protected override updateVirtualDisplay(): void {
    const { data, config, containerEl } = this;
    if (!data || !config || !this.scrollEl.isConnected || !isShown(this.scrollEl) || !this.groups.length) return;
    const props = data.properties, m = this.measurements;
    let testers = this.testers;
    if (!testers) {
      testers = this.testers = { group: div(null, "bases-cards-group"), groupHeading: div(null, "bases-group-heading", "Fj"), card: div(null, "bases-cards-item"), cover: div(null, "bases-cards-cover"), title: div(null, "bases-cards-property mod-title"), prop: div(null, "bases-cards-property") };
      testers.group.append(testers.card); testers.card.append(testers.cover, testers.title, testers.prop);
      for (const line of [testers.title, testers.prop]) { div(line, "bases-cards-label", "Fj"); div(line, "bases-cards-line", "Fj"); }
      Object.assign(testers.groupHeading.style, { opacity: "0", pointerEvents: "none", zIndex: "-1" });
      Object.assign(testers.group.style, { opacity: "0", pointerEvents: "none", zIndex: "-1", width: `${m.cardWidth}px`, height: "100px" });
      Object.assign(testers.card.style, { width: "100%", height: "100%" });
      // Property lines are absolutely positioned in real cards; let the probes take their natural height.
      for (const line of [testers.title, testers.prop]) line.style.position = "relative";
    }
    if (!testers.group.isConnected) containerEl.prepend(testers.group);
    if (!testers.groupHeading.isConnected) containerEl.prepend(testers.groupHeading);
    const image = config.get("image");
    this.imageProp = image && typeof image === "string" ? toPropertyId(image) : null;
    this.imageFitContain = config.get("imageFit") === "contain";
    const ratio = config.get("imageAspectRatio"), size = config.get("cardSize");
    this.imageAspectRatio = typeof ratio === "number" && ratio > 0 ? ratio : 1;
    let cardSize = typeof size === "number" && size > 0 ? size : 200;
    const containerStyle = getComputedStyle(containerEl), scale = px(containerStyle.getPropertyValue("--bases-cards-scale"), 1);
    if (scale > 0) cardSize *= scale;
    m.pad = padding(containerStyle); m.groupGap = px(containerStyle.gap, 0);
    const groupStyle = getComputedStyle(testers.group);
    m.groupPad = padding(groupStyle); m.cardGap = px(groupStyle.gap, 0);
    m.groupHeadingHeight = testers.groupHeading.offsetHeight;
    const cardStyle = getComputedStyle(testers.card);
    m.cardPad = padding(cardStyle); m.propGap = px(cardStyle.gap, 0);
    m.titleHeight = testers.title.offsetHeight || 24; m.propHeight = testers.prop.offsetHeight || 24; m.coverHeight = testers.cover.offsetHeight;
    const inner = containerEl.clientWidth - m.pad.start - m.groupPad.start - m.groupPad.end - m.pad.end;
    m.cardsPerRow = Math.max(1, Math.floor(inner / cardSize));
    m.cardWidth = (inner - m.cardGap * (m.cardsPerRow - 1)) / m.cardsPerRow;
    m.cardHeight = 0;
    if (this.imageProp) { m.coverHeight = m.cardWidth * this.imageAspectRatio; m.cardHeight += m.coverHeight; }
    if (props.length > 0) m.cardHeight += m.cardPad.top + m.cardPad.bottom + m.titleHeight;
    if (props.length > 1) m.cardHeight += (m.propHeight + m.propGap) * (props.length - 1);

    const viewport = visibleRect(containerEl), overscan = m.cardHeight * 2, children: HTMLElement[] = [testers.groupHeading, testers.group], used = new Map<Entry, CardItem>();
    let offset = m.pad.top;
    data.groupedData.forEach((group, index) => {
      const view = this.groups[index]!, entries = group.entries, collapsed = this.isGroupCollapsed(group), rows = Math.ceil(entries.length / m.cardsPerRow);
      const shown = !collapsed && entries.length > 0, gridHeight = shown ? rows * m.cardHeight + (rows - 1) * m.cardGap : 0, groupHeight = collapsed ? 0 : m.groupPad.top + gridHeight + m.groupPad.bottom;
      let top = offset;
      view.containerEl.classList.toggle("is-collapsed", collapsed);
      Object.assign(view.containerEl.style, { padding: collapsed ? "0" : "", borderWidth: collapsed ? "0" : "" });
      if (view.headingEl) { view.headingEl.style.top = `${top}px`; top += m.groupHeadingHeight; children.push(view.headingEl); }
      Object.assign(view.containerEl.style, { top: `${top}px`, insetInlineStart: `${m.pad.start}px`, insetInlineEnd: `${m.pad.end}px`, height: `${groupHeight}px` });
      const gridTop = top + m.groupPad.top, gridBottom = gridTop + gridHeight, cards: HTMLElement[] = [];
      if (shown && gridTop <= viewport.bottom + overscan && gridBottom >= viewport.top - overscan) {
        const pitch = m.cardHeight + m.cardGap;
        const first = Math.floor(Math.max(viewport.top - overscan - gridTop, 0) / pitch), end = rows - Math.floor(Math.max(gridBottom - viewport.bottom - overscan, 0) / pitch);
        for (let row = first; row < end; row++) for (let column = 0; column < m.cardsPerRow; column++) {
          const entry = entries[row * m.cardsPerRow + column];
          if (!entry) break;
          const item = this.items.get(entry) ?? new CardItem(this);
          used.set(entry, item);
          item.render(entry, props);
          Object.assign(item.el.style, { top: `${m.groupPad.top + row * pitch}px`, insetInlineStart: `${m.groupPad.start + column * (m.cardWidth + m.cardGap)}px`, width: `${m.cardWidth}px`, height: `${m.cardHeight}px` });
          cards.push(item.el);
        }
      }
      setChildren(view.containerEl, cards);
      children.push(view.containerEl);
      offset = top + groupHeight + m.groupGap;
    });
    this.items = used;
    setChildren(containerEl, children);
    containerEl.style.height = `${Math.max(0, offset - m.groupGap + m.pad.bottom)}px`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// List

class ListCell {
  readonly el = el(null, "span");
  private readonly renderer: CellRenderer;
  constructor(view: ListView, readonly prop: PropertyId) { this.renderer = prop === "file.name" ? view.createRenderer(prop, this.el) : new ValueRenderer(view, prop, this.el); }
  /** Returns null for empty values so the list can skip them entirely. */
  render(entry: Entry): HTMLElement | null {
    try {
      const value = entry.getValue(this.prop);
      if (!value || value instanceof NullValue || (value instanceof ListValue && value.length() === 0) || (value instanceof StringValue && value.value === "") || (value instanceof ObjectValue && value.isEmpty())) return null;
    } catch { /* show the error */ }
    this.renderer.render(entry);
    return this.el;
  }
}
class ListRow {
  readonly el = div(null, "bases-list-item");
  height = 0; measured = false; empty = false;
  private index = -1;
  private readonly propertiesEl: HTMLElement; private readonly nestedEl: HTMLElement;
  private cells: ListCell[] = [];
  constructor(private readonly view: ListView, readonly entry: Entry) {
    this.propertiesEl = div(this.el, "bases-list-item-properties");
    this.nestedEl = div(null, "bases-list-item-properties nested");
  }
  render(index: number): void {
    if (this.index === index) return;
    this.index = index;
    const view = this.view, doc = this.el.ownerDocument, existing = new Map(this.cells.map(cell => [cell.prop, cell]));
    this.cells = view.order.map(prop => existing.get(prop) ?? new ListCell(view, prop));
    const indent = !!view.config.get("indentProperties"), markers = ListView.getMarkers(view.config), first: HTMLElement[] = [], nested: HTMLElement[] = [];
    const marker = (parent: HTMLElement) => { if (markers === "bullet") el(parent, "span", "list-bullet", "-"); else if (markers === "number") el(parent, "span", "list-number", `${index}.`); };
    for (let position = 0; position < this.cells.length; position++) {
      const content = this.cells[position]!.render(this.entry);
      if (!content) { if (position === 0 && indent) break; continue; }
      const property = doc.createElement("span"); property.className = "bases-list-property";
      if (!first.length) { marker(property); property.append(content); first.push(property); }
      else if (indent) { el(property, "span", "list-bullet", "-"); property.append(content); nested.push(property); }
      else { first.push(el(null, "span", "bases-list-separator", view.propertySeparator)); property.append(content); first.push(property); }
    }
    this.propertiesEl.replaceChildren(...first);
    if (indent && nested.length) { this.nestedEl.replaceChildren(...nested); this.el.append(this.nestedEl); } else this.nestedEl.remove();
  }
  isEmpty(): boolean { return !this.propertiesEl.hasChildNodes(); }
}
class ListGroup {
  readonly containerEl = div(null, "bases-list-group");
  readonly headingEl: HTMLElement | null; readonly listEl: HTMLElement;
  headerHeight = 0; height = 0;
  constructor(readonly view: ListView, readonly group: EntryGroup) {
    this.headingEl = view.createGroupHeadingEl(group);
    if (this.headingEl) this.containerEl.append(this.headingEl);
    this.listEl = div(this.containerEl, "bases-list-group-list");
  }
}

export class ListView extends BasesView {
  readonly type = "list";
  readonly containerEl: HTMLElement;
  order: PropertyId[] = [];
  propertySeparator = ", ";
  private groups: ListGroup[] = [];
  private rows = new Map<Entry, ListRow>();
  private measuredTotal = 0; private measuredCount = 0;
  private width = 0;

  constructor(controller: BasesController, scrollEl: HTMLElement) {
    super(controller, scrollEl);
    this.containerEl = div(scrollEl, "bases-list-container is-loading"); this.containerEl.tabIndex = 0;
    this.viewCleanups.push(watchScroll(this.containerEl, () => this.scheduleDisplay()));
  }
  static getMarkers(config: ViewConfig): "bullet" | "number" | "none" { const markers = config.get("markers"); return markers === "number" || markers === "none" ? markers : "bullet"; }
  static getViewOptions(): ViewOption[] {
    return [
      { displayName: t("plugins.bases.list.label-markers"), key: "markers", type: "dropdown", options: { bullet: t("plugins.bases.list.option-bullet"), number: t("plugins.bases.list.option-number"), none: t("plugins.bases.list.option-none") }, default: "bullet" },
      { displayName: t("plugins.bases.list.label-indent-properties"), key: "indentProperties", type: "toggle", default: false },
      { displayName: t("plugins.bases.list.label-property-separator"), key: "separator", type: "text", default: ", ", shouldHide: config => !!config.get("indentProperties") },
    ];
  }
  override focus(): void { this.containerEl.focus({ preventScroll: true }); }
  override onResize(): void { if (this.containerEl.clientWidth !== this.width) this.invalidate(); this.scheduleDisplay(); }
  override onGroupCollapsedChange(): void { this.updateVirtualDisplay(); }
  onDataUpdated(): void {
    this.containerEl.classList.remove("is-loading");
    if (!this.data.data.length) { this.containerEl.replaceChildren(); this.containerEl.style.height = ""; this.groups = []; return; }
    this.propertySeparator = String(this.config.get("separator") || ", ");
    this.order = this.config.getOrder();
    this.invalidate();
    this.updateVirtualDisplay();
  }
  private invalidate(): void {
    this.groups = this.data?.groupedData.map(group => new ListGroup(this, group)) ?? [];
    this.rows = new Map(); this.measuredTotal = 0; this.measuredCount = 0;
  }
  private averageHeight(): number { return this.measuredCount ? this.measuredTotal / this.measuredCount : 28; }
  protected override updateVirtualDisplay(): void {
    const { containerEl, data } = this;
    if (!data || !this.scrollEl.isConnected || !isShown(this.scrollEl) || !this.groups.length) return;
    this.width = containerEl.clientWidth;
    setChildren(containerEl, this.groups.map(group => group.containerEl));
    const viewport = visibleRect(containerEl), margin = 400;
    let offset = 0, pending = false;
    for (const group of this.groups) {
      const entries = group.group.entries, collapsed = this.isGroupCollapsed(group.group), shown: HTMLElement[] = [];
      group.containerEl.classList.toggle("is-collapsed", collapsed);
      if (!group.headerHeight && group.headingEl) group.headerHeight = group.headingEl.getBoundingClientRect().height;
      group.containerEl.style.top = `${offset}px`;
      const listTop = offset + group.headerHeight;
      let y = 0, number = 0;
      if (!collapsed) for (const entry of entries) {
        let row = this.rows.get(entry);
        const estimate = row?.measured ? row.height : this.averageHeight(), top = listTop + y;
        if (row?.empty) continue;
        number++;
        if (top <= viewport.bottom + margin && top + estimate >= viewport.top - margin) {
          if (!row) this.rows.set(entry, row = new ListRow(this, entry));
          row.render(number);
          if (row.isEmpty()) { row.empty = true; number--; continue; }
          row.el.style.top = `${y}px`;
          if (!row.el.isConnected) group.listEl.append(row.el);
          if (!row.measured) {
            // A zero height means the list is not laid out yet (hidden tab); keep estimating until it is.
            const height = row.el.getBoundingClientRect().height;
            if (height > 0) { row.height = height; row.measured = true; this.measuredTotal += height; this.measuredCount++; pending = true; }
          }
          shown.push(row.el);
          y += row.measured ? row.height : estimate;
        } else y += estimate;
      }
      setChildren(group.listEl, shown);
      group.listEl.style.height = `${y}px`;
      group.height = y + group.headerHeight;
      group.containerEl.style.height = `${group.height}px`;
      offset += group.height;
    }
    containerEl.style.height = `${offset}px`;
    // Measuring changed the estimates; settle on the next frame.
    if (pending) this.scheduleDisplay();
  }
}
