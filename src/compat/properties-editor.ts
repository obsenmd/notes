import { t } from "../i18n";
import moment from "moment";
import { stringify as stringifyYamlDocument } from "yaml";
import { confirmDialog } from "../controllers/dialogs";
import type { App } from "./plugin";
import { PropertyList } from "./property-list";
import { getPropertyDailyNoteOpener } from "./property-daily-notes";
import { Menu } from "./ui";
import { parseYaml, setIcon } from "./utilities";

export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime" | "aliases" | "tags" | "unknown";
const TYPE_ICONS: Record<PropertyType, string> = { text: "lucide-text", multitext: "lucide-list", number: "lucide-binary", checkbox: "lucide-check-square", date: "lucide-calendar", datetime: "lucide-clock", aliases: "lucide-forward", tags: "lucide-tags", unknown: "lucide-file-question" };
const FIXED_TYPES: Record<string, PropertyType> = { aliases: "aliases", tags: "tags", cssclasses: "multitext" };
const acceptsListValue = (value: unknown): boolean => value == null || typeof value === "string"
  || (Array.isArray(value) && value.every(item => item == null || typeof item === "string"));

export function inferPropertyType(key: string, value: unknown): PropertyType {
  const fixed = Object.hasOwn(FIXED_TYPES, key.toLowerCase()) ? FIXED_TYPES[key.toLowerCase()] : undefined;
  if (fixed && acceptsListValue(value)) return fixed;
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return acceptsListValue(value) ? "multitext" : "unknown";
  if (value !== null && typeof value === "object") return "unknown";
  if (typeof value === "string" && /^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d$/.test(value)) return "datetime";
  if (typeof value === "string" && /^\d{4}-[01]\d-[0-3]\d$/.test(value)) return "date";
  return "text";
}

export interface PropertiesEditorOptions {
  app?: App;
  /** Called with the new YAML body (without fences), or null when no properties remain. */
  onChange(yaml: string | null): void;
  onOpenLink?(target: string, event: MouseEvent): void;
  truncateText?: boolean;
  onOpenDate?(date: string, event: MouseEvent): void;
  onShowSource?(): void;
  onTypeChange?(key: string, type: PropertyType): void;
}

/** The "Properties" panel shown above a note: a typed editor over the YAML frontmatter. */
export class PropertiesEditor {
  readonly containerEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly headingEl: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly addEl: HTMLElement;
  private data: Record<string, unknown> = {};
  private source: string | null = null;
  private sourceEchoPending = false;
  private collapsed = false;
  private focusKey: string | null = null;
  private types: Record<string, string> = {};
  private lists: PropertyList[] = [];
  private forcedTypes = new Map<string, { value: unknown; type: PropertyType }>();

  constructor(private readonly options: PropertiesEditorOptions, doc: Document = document) {
    const el = (tag: string, cls: string, parent?: HTMLElement) => { const node = doc.createElement(tag); node.className = cls; parent?.append(node); return node; };
    this.containerEl = el("div", "metadata-container"); this.containerEl.tabIndex = -1;
    this.errorEl = el("div", "metadata-error-container", this.containerEl); this.errorEl.style.display = "none";
    this.headingEl = el("div", "metadata-properties-heading", this.containerEl); this.headingEl.tabIndex = 0;
    setIcon(el("div", "collapse-indicator collapse-icon", this.headingEl), "right-triangle");
    el("div", "metadata-properties-title", this.headingEl).textContent = t("properties.label-heading");
    this.contentEl = el("div", "metadata-content", this.containerEl);
    this.listEl = el("div", "metadata-properties", this.contentEl);
    const add = this.addEl = el("div", "metadata-add-button text-icon-button", this.contentEl); add.tabIndex = 0;
    setIcon(el("span", "text-button-icon", add), "lucide-plus");
    el("span", "text-button-label", add).textContent = t("properties.label-add-property-button");
    add.addEventListener("click", () => this.addProperty());
    this.headingEl.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.contentEl.style.display = this.collapsed ? "none" : "";
      for (const part of [this.containerEl, this.headingEl, this.headingEl.firstElementChild]) part?.classList.toggle("is-collapsed", this.collapsed);
    });
  }

  /** Loads the YAML body; an unparsable block shows the reference's error state. */
  setSource(yaml: string | null): void {
    if (yaml === this.source) {
      if (this.sourceEchoPending) { this.sourceEchoPending = false; for (const list of this.lists) list.resetPending(); }
      return;
    }
    this.sourceEchoPending = false;
    const previous = JSON.stringify(this.data), hadError = this.errorEl.style.display !== "none";
    this.source = yaml;
    this.errorEl.style.display = "none";
    this.errorEl.replaceChildren();
    this.containerEl.classList.remove("mod-error");
    this.headingEl.style.display = "";
    this.contentEl.style.display = this.collapsed ? "none" : "";
    this.addEl.style.display = "";
    try {
      const parsed = yaml === null || !yaml.trim() ? {} : parseYaml(yaml);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.data = parsed as Record<string, unknown>;
      else if (parsed == null) this.data = {};
      else throw new Error("not a mapping");
      // A save may change YAML whitespace without changing values. Keep the
      // current widgets so the focused field and its selection survive that echo.
      if (!hadError && JSON.stringify(this.data) === previous) {
        for (const list of this.lists) list.resetPending();
        return;
      }
    } catch {
      this.data = {};
      this.errorEl.style.display = "";
      this.containerEl.classList.add("mod-error");
      this.headingEl.style.display = "none";
      this.addEl.style.display = "none";
      const doc = this.containerEl.ownerDocument;
      const title = doc.createElement("div"); title.className = "metadata-error-title"; title.textContent = t("properties.label-invalid-heading");
      const showSource = doc.createElement("div"); showSource.className = "text-icon-button metadata-show-source-button";
      const label = doc.createElement("span"); label.className = "text-button-label"; label.textContent = t("properties.label-show-source"); showSource.append(label);
      showSource.addEventListener("click", () => this.options.onShowSource?.()); this.errorEl.append(title, showSource);
    }
    this.containerEl.dataset.propertyCount = String(Object.keys(this.data).length);
    this.render();
  }

  get isEmpty(): boolean { return Object.keys(this.data).length === 0 && this.errorEl.style.display === "none"; }
  blur(): void {
    const active = this.containerEl.ownerDocument.activeElement;
    const ElementClass = this.containerEl.ownerDocument.defaultView?.HTMLElement;
    if (ElementClass && active instanceof ElementClass && this.containerEl.contains(active)) active.blur();
  }
  setTypes(types: Record<string, string>): void { if (JSON.stringify(this.types) === JSON.stringify(types)) return; this.types = { ...types }; this.render(); }
  private typeOf(key: string, value: unknown): PropertyType {
    const fixed = Object.hasOwn(FIXED_TYPES, key.toLowerCase()) ? FIXED_TYPES[key.toLowerCase()] : undefined;
    const assigned = Object.entries(this.types).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    return fixed ?? (assigned && Object.hasOwn(TYPE_ICONS, assigned) ? assigned as PropertyType : inferPropertyType(key, value));
  }
  private accepts(type: PropertyType, value: unknown): boolean {
    if (value == null) return true;
    if (type === "unknown") return true;
    if (type === "text") return typeof value === "string";
    if (type === "number") return typeof value === "number";
    if (type === "checkbox") return typeof value === "boolean";
    if (["multitext", "aliases", "tags"].includes(type)) return acceptsListValue(value);
    const formats = type === "date" ? ["YYYY-MM-DD"] : ["YYYY-MM-DD[T]HH:mm:ss", "YYYY-MM-DD[T]HH:mm", "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm"];
    return !value || moment(value as moment.MomentInput, formats).isValid();
  }

  private commit(): void {
    const keys = Object.keys(this.data);
    const yaml = keys.length ? stringifyYamlDocument(this.data, { schema: "core", lineWidth: 0, nullStr: "" }).replace(/\n+$/, "") : null;
    this.source = yaml;
    this.sourceEchoPending = true;
    this.containerEl.dataset.propertyCount = String(keys.length);
    this.options.onChange(yaml);
  }

  addProperty(): void {
    let key = "", index = 0;
    do { key = index ? `property ${index}` : ""; index++; } while (Object.hasOwn(this.data, key));
    this.data = { ...this.data, [key]: null };
    this.focusKey = key;
    this.render();
  }

  private rename(oldKey: string, newKey: string): boolean {
    if (newKey === oldKey) return true;
    if (!newKey.trim()) { if (this.data[oldKey] == null) { delete this.data[oldKey]; this.commit(); this.render(); } return false; }
    if (Object.hasOwn(this.data, newKey)) return false;
    this.data = Object.fromEntries(Object.entries(this.data).map(([key, value]) => [key === oldKey ? newKey : key, value]));
    this.commit(); this.render();
    return true;
  }

  private render(): void {
    const doc = this.containerEl.ownerDocument;
    for (const [key, forced] of this.forcedTypes) {
      if (!Object.hasOwn(this.data, key) || forced.value !== this.data[key] || forced.type !== this.typeOf(key, this.data[key])) this.forcedTypes.delete(key);
    }
    for (const list of this.lists) list.dispose();
    this.lists = [];
    this.listEl.replaceChildren();
    for (const [key, value] of Object.entries(this.data)) {
      const type = this.typeOf(key, value);
      const mismatch = !this.accepts(type, value);
      const forced = this.forcedTypes.get(key);
      const displayExpected = forced !== undefined && forced.value === value && forced.type === type;
      const row = doc.createElement("div"); row.className = "metadata-property"; row.tabIndex = 0;
      row.dataset.propertyKey = key;
      const keyEl = doc.createElement("div"); keyEl.className = "metadata-property-key";
      const icon = doc.createElement("span"); icon.className = "metadata-property-icon"; icon.setAttribute("aria-label", t(`properties.types.option-${type}`));
      setIcon(icon, TYPE_ICONS[type]);
      icon.addEventListener("click", event => this.propertyMenu(key, event));
      const keyInput = doc.createElement("input"); keyInput.className = "metadata-property-key-input"; keyInput.type = "text"; keyInput.autocapitalize = "none"; keyInput.spellcheck = false;
      keyInput.value = key; keyInput.setAttribute("aria-label", key);
      keyInput.addEventListener("blur", () => { if (!this.rename(key, keyInput.value.trim())) keyInput.value = key; });
      keyInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); (row.querySelector(".metadata-property-value [contenteditable], .metadata-property-value input") as HTMLElement | null)?.focus(); } });
      keyEl.append(icon, keyInput);
      const valueEl = doc.createElement("div"); valueEl.className = "metadata-property-value";
      const fieldType = mismatch && !displayExpected ? inferPropertyType(key, value) : type;
      valueEl.dataset.propertyType = fieldType;
      this.renderValue(valueEl, key, fieldType, value);
      row.append(keyEl, valueEl);
      const warning = doc.createElement("div"); warning.className = "clickable-icon metadata-property-warning-icon"; warning.style.display = mismatch && !displayExpected ? "" : "none"; setIcon(warning, "lucide-alert-triangle"); warning.setAttribute("aria-label", t("properties.label-type-mismatch-warning", { type: t(`properties.types.option-${type}`) })); row.append(warning);
      warning.addEventListener("click", () => { void this.repairProperty(key); });
      row.addEventListener("contextmenu", event => this.propertyMenu(key, event));
      this.listEl.append(row);
      if (this.focusKey === key) { this.focusKey = null; queueMicrotask(() => keyInput.focus()); }
    }
  }

  private set(key: string, value: unknown): void { this.data[key] = value; this.commit(); }

  private async repairProperty(key: string): Promise<void> {
    const app = this.options.app; if (!app || !Object.hasOwn(this.data, key)) return;
    const value = this.data[key], expected = this.typeOf(key, value), actual = inferPropertyType(key, value);
    const result = await confirmDialog(app, {
      title: t("properties.label-change-property-type", { type: expected }),
      message: [t("properties.label-change-property-type-desc", { oldType: actual })],
      cta: t("dialogue.button-update"),
    });
    if (!result.confirmed || !this.containerEl.isConnected || !Object.hasOwn(this.data, key)) return;
    const type = this.typeOf(key, this.data[key]);
    this.forcedTypes.set(key, { value: this.data[key], type });
    const row = [...this.listEl.children].find(el => (el as HTMLElement).dataset.propertyKey === key);
    const holder = row?.querySelector<HTMLElement>(".metadata-property-value"); if (!holder) return;
    this.lists = this.lists.filter(list => { if (list.containerEl.parentElement !== holder) return true; list.dispose(); return false; });
    holder.replaceChildren(); holder.dataset.propertyType = type; this.renderValue(holder, key, type, this.data[key]);
    const warning = row?.querySelector<HTMLElement>(".metadata-property-warning-icon"); if (warning) warning.style.display = "none";
    // Run after the modal's selection restoration, keeping focus in the newly
    // adapted control without saving until the user edits it.
    queueMicrotask(() => holder.querySelector<HTMLElement>(".multi-select-input, .metadata-input-longtext, input, .metadata-property-value-item")?.focus());
  }

  private renderValue(parent: HTMLElement, key: string, type: PropertyType, value: unknown): void {
    const doc = parent.ownerDocument;
    if (type === "unknown") {
      const field = doc.createElement("span"); field.className = "metadata-property-value-item mod-unknown"; field.tabIndex = 0;
      field.textContent = JSON.stringify(value); parent.append(field); return;
    }
    if (type === "checkbox") {
      const input = doc.createElement("input"); input.type = "checkbox"; input.className = "metadata-input-checkbox"; input.checked = value === true; input.dataset.indeterminate = String(value == null);
      input.addEventListener("change", () => this.set(key, input.checked));
      parent.append(input); return;
    }
    if (type === "number") {
      const input = doc.createElement("input"); input.type = "number"; input.className = "metadata-input metadata-input-number"; input.placeholder = t("properties.label-no-value");
      input.value = typeof value === "number" ? String(value) : "";
      input.addEventListener("change", () => this.set(key, input.value === "" ? null : Number(input.value)));
      parent.append(input); return;
    }
    if (type === "date" || type === "datetime") {
      const input = doc.createElement("input"); input.type = type === "date" ? "date" : "datetime-local"; input.className = "metadata-input metadata-input-text mod-" + type; input.max = type === "date" ? "9999-12-31" : "9999-12-31T23:59";
      input.placeholder = t("properties.label-no-value");
      const formats = type === "date" ? ["YYYY-MM-DD"] : ["YYYY-MM-DD[T]HH:mm:ss", "YYYY-MM-DD[T]HH:mm", "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm"];
      const format = type === "date" ? "YYYY-MM-DD" : "YYYY-MM-DD[T]HH:mm:ss";
      let saved = value == null ? "" : String(value), date = moment(saved, formats), dirty = false;
      input.value = date.isValid() ? date.format(format) : "";
      input.classList.toggle("is-empty", !saved);
      parent.append(input);
      let link: HTMLElement | undefined;
      const onOpenDate = this.options.onOpenDate ?? (this.options.app && getPropertyDailyNoteOpener(this.options.app));
      if (type === "date" && onOpenDate) {
        link = doc.createElement("div"); link.className = "clickable-icon"; setIcon(link, "lucide-link"); link.setAttribute("aria-label", t("plugins.properties.action-open-daily-note")); link.style.display = date.isValid() ? "" : "none";
        link.addEventListener("click", event => onOpenDate(date.format("YYYY-MM-DD"), event)); parent.append(link);
      }
      const parse = (text = input.value) => { date = moment(text, formats); if (link) link.style.display = date.isValid() ? "" : "none"; };
      input.addEventListener("input", () => { input.classList.toggle("is-empty", !input.value); parse(); dirty = true; });
      input.addEventListener("blur", () => {
        if (dirty && (!input.value || date.isValid())) {
          saved = input.value; dirty = false; this.set(key, date.isValid() ? date.format(format) : null);
        }
      });
      input.addEventListener("keydown", event => {
        if (event.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
        event.preventDefault();
        if (event.key === "Escape") { dirty = false; input.value = saved; input.classList.toggle("is-empty", !saved); parse(saved); }
        input.closest<HTMLElement>(".metadata-property")?.focus();
      });
      return;
    }
    if (type === "multitext" || type === "aliases" || type === "tags") {
      const values = Array.isArray(value) ? value.filter(item => item != null).map(String) : value == null || value === "" ? [] : [String(value)];
      this.lists.push(new PropertyList(parent, values, { type, key, app: this.options.app, onChange: next => this.set(key, next) }));
      return;
    }
    const field = doc.createElement("div"); field.className = "metadata-input-longtext" + (this.options.truncateText ? " mod-truncate" : ""); field.contentEditable = "true"; field.tabIndex = 0;
    field.dataset.placeholder = t("properties.label-no-value");
    field.setAttribute("placeholder", t("properties.label-no-value"));
    field.textContent = value == null ? "" : String(value);
    field.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); field.blur(); } });
    field.addEventListener("blur", () => { const text = field.textContent ?? ""; if (text !== (value == null ? "" : String(value))) this.set(key, text === "" ? null : text); });
    parent.append(field);
  }

  private convert(key: string, type: PropertyType): void {
    if (this.options.onTypeChange) { this.options.onTypeChange(key, type); return; }
    const value = this.data[key];
    const text = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
    this.data[key] = type === "checkbox" ? value === true || text === "true" : type === "number" ? (Number.isFinite(Number(text)) && text !== "" ? Number(text) : null)
      : type === "multitext" ? (Array.isArray(value) ? value : text ? text.split(",").map(item => item.trim()).filter(Boolean) : [])
      : type === "date" ? (/^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : new Date().toISOString().slice(0, 10))
      : type === "datetime" ? (/^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 16) : new Date().toISOString().slice(0, 16)) : text || null;
    this.commit(); this.render();
  }

  private propertyMenu(key: string, event: MouseEvent): void {
    event.preventDefault(); event.stopPropagation();
    const menu = new Menu();
    if (!Object.hasOwn(FIXED_TYPES, key.toLowerCase())) {
      menu.addItem(item => {
        item.setTitle(t("properties.option-property-type")).setIcon("lucide-info").setSection("type");
        const submenu = item.setSubmenu();
        const current = this.typeOf(key, this.data[key]);
        for (const type of ["text", "multitext", "number", "checkbox", "date", "datetime"] as PropertyType[]) submenu.addItem(entry => entry.setTitle(t(`properties.types.option-${type}`)).setIcon(TYPE_ICONS[type]).setChecked(current === type ? true : null).onClick(() => this.convert(key, type)));
      });
    }
    menu.addItem(item => item.setTitle(t("interface.menu.remove")).setIcon("lucide-trash-2").setWarning(true).setSection("danger").onClick(() => { delete this.data[key]; this.commit(); this.render(); }));
    menu.showAtMouseEvent(event);
  }
}
