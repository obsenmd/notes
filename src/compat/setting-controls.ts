import { Component } from "./component";
import { setTooltip as applyTooltip, type TooltipOptions } from "./utilities";
import { t } from "../i18n";
import moment from "moment";

/** Shared behavior of Obsidian's DOM-backed setting controls. */
export class BaseComponent {
  disabled = false;
  then(callback: (component: this) => unknown): this { callback(this); return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
}

export abstract class ValueComponent<T> extends BaseComponent {
  private optionListeners: Array<(value?: T) => T> = [];
  abstract getValue(): T;
  abstract setValue(value: T): this;
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    const listener = listeners[key];
    if (listener) this.optionListeners.push(listener);
    return this;
  }
  protected notifyOptionListeners(value?: T): void {
    for (const listener of this.optionListeners) listener(value);
  }
}

export class ButtonComponent extends BaseComponent {
  readonly buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.buttonEl = document.createElement("button");
    this.buttonEl.type = "button";
    this.buttonEl.className = "clickable-icon";
    containerEl.appendChild(this.buttonEl);
  }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.buttonEl.disabled = disabled; return this; }
  setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
  removeCta(): this { this.buttonEl.classList.remove("mod-cta"); return this; }
  setWarning(): this { return this.setDestructive().setCta(); }
  setDestructive(): this { this.buttonEl.classList.add("mod-destructive"); return this; }
  removeDestructive(): this { this.buttonEl.classList.remove("mod-destructive"); return this; }
  setTooltip(tooltip: string, options?: TooltipOptions): this { applyTooltip(this.buttonEl, tooltip, options); return this; }
  setButtonText(name: string): this { this.buttonEl.textContent = name; return this; }
  setIcon(icon: string): this { this.buttonEl.dataset.icon = icon; this.buttonEl.setAttribute("aria-label", icon); return this; }
  setClass(cls: string): this { this.buttonEl.classList.add(cls); return this; }
  onClick(callback: (evt: MouseEvent) => unknown): this { this.buttonEl.addEventListener("click", callback); return this; }
}

export abstract class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
  readonly inputEl: T;
  private readonly changeCallbacks: Array<(value: string) => unknown> = [];
  constructor(inputEl: T) {
    super(); this.inputEl = inputEl;
    this.inputEl.addEventListener("input", () => this.onChanged());
    this.inputEl.addEventListener("change", () => this.onChanged());
  }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.inputEl.disabled = disabled; return this; }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(placeholder: string): this { this.inputEl.placeholder = placeholder; return this; }
  onChanged(): void { const value = this.getValue(); for (const callback of this.changeCallbacks) callback(value); this.notifyOptionListeners(value); }
  onChange(callback: (value: string) => unknown): this { this.changeCallbacks.push(callback); return this; }
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(containerEl: HTMLElement) { const input = document.createElement("input"); input.type = "text"; super(input); containerEl.appendChild(input); }
}

/** A text field for a date format, with a live sample of the format applied to now. */
export class MomentFormatComponent extends TextComponent {
  sampleEl!: HTMLElement;
  private defaultFormat = "";
  setDefaultFormat(defaultFormat: string): this { this.defaultFormat = defaultFormat; this.inputEl.placeholder = defaultFormat; this.updateSample(); return this; }
  setSampleEl(sampleEl: HTMLElement): this { this.sampleEl = sampleEl; this.updateSample(); return this; }
  override setValue(value: string): this { super.setValue(value); this.updateSample(); return this; }
  override onChanged(): void { super.onChanged(); this.updateSample(); }
  updateSample(): void { if (this.sampleEl) this.sampleEl.textContent = moment().format(this.inputEl.value || this.defaultFormat); }
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(containerEl: HTMLElement) { const input = document.createElement("textarea"); input.className = "setting-input"; super(input); containerEl.appendChild(input); }
}

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  readonly clearButtonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    const input = document.createElement("input"); input.type = "search"; input.className = "search-input"; super(input);
    this.clearButtonEl = document.createElement("button"); this.clearButtonEl.type = "button"; this.clearButtonEl.className = "search-clear-button"; this.clearButtonEl.setAttribute("aria-label", t("plugins.search.tooltip-clear-search")); this.clearButtonEl.textContent = "×";
    this.clearButtonEl.addEventListener("click", () => { this.setValue(""); this.onChanged(); input.focus(); });
    const wrapper = document.createElement("div"); wrapper.className = "search-input-container"; wrapper.append(input, this.clearButtonEl); containerEl.appendChild(wrapper);
  }
}

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

export class ColorComponent extends ValueComponent<string> {
  readonly colorEl: HTMLInputElement;
  private readonly callbacks: Array<(value: string) => unknown> = [];
  constructor(containerEl: HTMLElement) {
    super(); this.colorEl = document.createElement("input"); this.colorEl.type = "color"; this.colorEl.value = "#000000";
    this.colorEl.addEventListener("input", () => this.changed()); this.colorEl.addEventListener("change", () => this.changed()); containerEl.appendChild(this.colorEl);
  }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.colorEl.disabled = disabled; return this; }
  getValue(): string { return this.colorEl.value; }
  setValue(value: string): this { if (/^#[\da-f]{6}$/i.test(value)) this.colorEl.value = value; return this; }
  getValueRgb(): RGB { const v = this.getValue(); return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16) }; }
  getValueHsl(): HSL {
    const { r: rr, g: gg, b: bb } = this.getValueRgb(); const r = rr / 255, g = gg / 255, b = bb / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; let h = 0, s = 0; const l = (max + min) / 2;
    if (d) { s = d / (1 - Math.abs(2 * l - 1)); if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  setValueRgb(rgb: RGB): this { const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"); return this.setValue(`#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`); }
  setValueHsl(hsl: HSL): this {
    const h = ((hsl.h % 360) + 360) % 360 / 360, s = Math.max(0, Math.min(100, hsl.s)) / 100, l = Math.max(0, Math.min(100, hsl.l)) / 100;
    const hue = (p: number, q: number, t: number) => { if (t < 0) t++; if (t > 1) t--; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    if (s === 0) return this.setValueRgb({ r: l * 255, g: l * 255, b: l * 255 });
    const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return this.setValueRgb({ r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 });
  }
  onChange(callback: (value: string) => unknown): this { this.callbacks.push(callback); return this; }
  private changed(): void { const value = this.getValue(); this.callbacks.forEach(cb => cb(value)); this.notifyOptionListeners(value); }
}

export class SliderComponent extends ValueComponent<number> {
  readonly sliderEl: HTMLInputElement;
  private readonly displayEl: HTMLElement;
  readonly containerEl: HTMLElement;
  private callbacks: Array<(value: number) => unknown> = [];
  private instant = true;
  private format: (value: number) => string = String;
  constructor(containerEl: HTMLElement) {
    super(); this.containerEl = document.createElement("div"); this.containerEl.className = "setting-slider-control"; this.sliderEl = document.createElement("input"); this.sliderEl.type = "range"; this.sliderEl.className = "slider";
    this.displayEl = document.createElement("span"); this.displayEl.className = "slider-value";
    this.sliderEl.addEventListener("input", () => { this.updateDisplay(); if (this.instant) this.changed(); });
    this.sliderEl.addEventListener("change", () => { this.updateDisplay(); this.changed(); });
    this.containerEl.append(this.sliderEl, this.displayEl); containerEl.appendChild(this.containerEl); this.updateDisplay();
  }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.sliderEl.disabled = disabled; return this; }
  setInstant(instant: boolean): this { this.instant = instant; return this; }
  setLimits(min: number | null, max: number | null, step: number | "any"): this { if (min !== null) this.sliderEl.min = String(min); else this.sliderEl.removeAttribute("min"); if (max !== null) this.sliderEl.max = String(max); else this.sliderEl.removeAttribute("max"); this.sliderEl.step = String(step); this.updateDisplay(); return this; }
  getValue(): number { return Number(this.sliderEl.value); }
  setValue(value: number): this { this.sliderEl.value = String(value); this.updateDisplay(); return this; }
  getValuePretty(): string { return this.format(this.getValue()); }
  setDisplayFormat(format: (value: number) => string): this { this.format = format; this.updateDisplay(); return this; }
  setDynamicTooltip(): this { return this; }
  onChange(callback: (value: number) => unknown): this { this.callbacks.push(callback); return this; }
  private updateDisplay(): void { this.displayEl.textContent = this.getValuePretty(); }
  private changed(): void { const value = this.getValue(); this.callbacks.forEach(cb => cb(value)); this.notifyOptionListeners(value); }
}

export class ExtraButtonComponent extends BaseComponent {
  readonly extraSettingsEl: HTMLElement;
  readonly buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) { super(); this.extraSettingsEl = containerEl; this.buttonEl = document.createElement("button"); this.buttonEl.type = "button"; this.buttonEl.className = "clickable-icon"; containerEl.appendChild(this.buttonEl); }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.buttonEl.disabled = disabled; return this; }
  setTooltip(tooltip: string, options?: TooltipOptions): this { applyTooltip(this.buttonEl, tooltip, options); return this; }
  setIcon(icon: string): this { this.buttonEl.dataset.icon = icon; this.buttonEl.setAttribute("aria-label", icon); return this; }
  onClick(callback: () => unknown): this { this.buttonEl.addEventListener("click", callback); return this; }
}

export class ProgressBarComponent extends ValueComponent<number> {
  readonly progressEl: HTMLElement;
  private value = 0;
  constructor(containerEl: HTMLElement) { super(); this.progressEl = document.createElement("div"); this.progressEl.className = "progress-bar"; this.progressEl.setAttribute("role", "progressbar"); this.progressEl.setAttribute("aria-valuemin", "0"); this.progressEl.setAttribute("aria-valuemax", "100"); const fill = document.createElement("div"); fill.className = "progress-bar-line"; this.progressEl.appendChild(fill); containerEl.appendChild(this.progressEl); }
  getValue(): number { return this.value; }
  setValue(value: number): this { this.value = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)); this.progressEl.setAttribute("aria-valuenow", String(this.value)); (this.progressEl.firstElementChild as HTMLElement).style.width = `${this.value}%`; return this; }
}

export class DisplayValueComponent {
  readonly valueEl: HTMLElement;
  constructor(containerEl: HTMLElement) { this.valueEl = document.createElement("div"); this.valueEl.className = "setting-item-control-value"; containerEl.appendChild(this.valueEl); }
  setValue(value: string | null): this { this.valueEl.textContent = value ?? ""; return this; }
  setStatus(status: "warning" | null): this { this.valueEl.classList.toggle("mod-warning", status === "warning"); return this; }
}

export class ToggleComponent extends ValueComponent<boolean> {
  readonly toggleEl: HTMLElement;
  private readonly changeCallbacks: Array<(value: boolean) => unknown> = [];
  private value = false;
  constructor(containerEl: HTMLElement) {
    super(); this.toggleEl = document.createElement("div"); this.toggleEl.className = "checkbox-container"; this.toggleEl.setAttribute("role", "switch"); this.toggleEl.tabIndex = 0;
    this.toggleEl.addEventListener("click", () => this.onClick());
    this.toggleEl.addEventListener("keydown", (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); this.onClick(); } });
    containerEl.appendChild(this.toggleEl); this.setValue(false);
  }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.toggleEl.classList.toggle("is-disabled", disabled); this.toggleEl.setAttribute("aria-disabled", String(disabled)); return this; }
  getValue(): boolean { return this.value; }
  setValue(on: boolean): this { this.value = Boolean(on); this.toggleEl.classList.toggle("is-enabled", this.value); this.toggleEl.setAttribute("aria-checked", String(this.value)); return this; }
  setTooltip(tooltip: string, options?: TooltipOptions): this { applyTooltip(this.toggleEl, tooltip, options); return this; }
  onClick(): void { if (this.disabled) return; this.setValue(!this.value); for (const callback of this.changeCallbacks) callback(this.value); this.notifyOptionListeners(this.value); }
  onChange(callback: (value: boolean) => unknown): this { this.changeCallbacks.push(callback); return this; }
}

export class DropdownComponent extends ValueComponent<string> {
  readonly selectEl: HTMLSelectElement;
  private readonly measureEl: HTMLSelectElement;
  private readonly measureOptionEl: HTMLOptionElement;
  private readonly changeCallbacks: Array<(value: string) => unknown> = [];
  constructor(containerEl: HTMLElement) {
    super(); this.selectEl = document.createElement("select"); this.selectEl.className = "dropdown";
    containerEl.appendChild(this.selectEl);
    this.measureEl = document.createElement("select"); this.measureEl.className = "dropdown is-measuring"; this.measureEl.setAttribute("aria-hidden", "true"); this.measureEl.tabIndex = -1;
    this.measureOptionEl = document.createElement("option"); this.measureEl.append(this.measureOptionEl); containerEl.append(this.measureEl);
    this.selectEl.addEventListener("change", () => { this.resizeToFit(); for (const callback of this.changeCallbacks) callback(this.getValue()); this.notifyOptionListeners(this.getValue()); });
    this.selectEl.addEventListener("mousedown", () => this.selectEl.classList.add("mouse-focus"));
    this.selectEl.addEventListener("blur", () => this.selectEl.classList.remove("mouse-focus"));
    queueMicrotask(() => this.resizeToFit());
  }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.selectEl.disabled = disabled; return this; }
  addOption(value: string, display: string): this { const option = document.createElement("option"); option.value = value; option.textContent = display; this.selectEl.appendChild(option); return this; }
  addOptions(options: Record<string, string>): this { for (const [value, display] of Object.entries(options)) this.addOption(value, display); return this; }
  getValue(): string { return this.selectEl.value; }
  setValue(value: string): this { this.selectEl.value = value; this.resizeToFit(); return this; }
  resizeToFit(): void { const selected = this.selectEl.options[this.selectEl.selectedIndex]; if (selected) { this.measureOptionEl.text = selected.text; this.selectEl.style.setProperty("--dropdown-fitted-width", `${this.measureEl.offsetWidth}px`); } }
  onChange(callback: (value: string) => unknown): this { this.changeCallbacks.push(callback); return this; }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  readonly components: BaseComponent[] = [];
  errorEl: HTMLElement | null = null;
  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement("div"); this.settingEl.className = "setting-item";
    this.infoEl = document.createElement("div"); this.infoEl.className = "setting-item-info";
    this.nameEl = document.createElement("div"); this.nameEl.className = "setting-item-name";
    this.descEl = document.createElement("div"); this.descEl.className = "setting-item-description";
    this.infoEl.append(this.nameEl, this.descEl);
    this.controlEl = document.createElement("div"); this.controlEl.className = "setting-item-control";
    this.settingEl.append(this.infoEl, this.controlEl); containerEl.appendChild(this.settingEl);
  }
  setErrorMessage(message: string | null): this {
    if (!message) { this.errorEl?.remove(); this.errorEl = null; this.settingEl.classList.remove("is-invalid"); return this; }
    if (!this.errorEl) { this.errorEl = document.createElement("div"); this.errorEl.className = "setting-item-error"; this.settingEl.appendChild(this.errorEl); }
    this.errorEl.textContent = message; this.settingEl.classList.add("is-invalid"); return this;
  }
  setName(name: string | DocumentFragment): this { this.nameEl.replaceChildren(typeof name === "string" ? document.createTextNode(name) : name); return this; }
  setDesc(desc: string | DocumentFragment): this { this.descEl.replaceChildren(typeof desc === "string" ? document.createTextNode(desc) : desc); return this; }
  setClass(cls: string): this { this.settingEl.classList.add(cls); return this; }
  setTooltip(tooltip: string, options?: TooltipOptions): this { applyTooltip(this.settingEl, tooltip, options); return this; }
  setHeading(): this { this.settingEl.classList.add("setting-item-heading"); this.controlEl.remove(); return this; }
  setDisabled(disabled: boolean): this { this.settingEl.classList.toggle("is-disabled", disabled); for (const component of this.components) component.setDisabled(disabled); return this; }
  addButton(callback: (component: ButtonComponent) => unknown): this { const c = new ButtonComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this { const c = new ExtraButtonComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addToggle(callback: (component: ToggleComponent) => unknown): this { const c = new ToggleComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addText(callback: (component: TextComponent) => unknown): this { const c = new TextComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addSearch(callback: (component: SearchComponent) => unknown): this { const c = new SearchComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addTextArea(callback: (component: TextAreaComponent) => unknown): this { const c = new TextAreaComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addMomentFormat(callback: (component: MomentFormatComponent) => unknown): this { const c = new MomentFormatComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addColorPicker(callback: (component: ColorComponent) => unknown): this { const c = new ColorComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addSlider(callback: (component: SliderComponent) => unknown): this { const c = new SliderComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addProgressBar(callback: (component: ProgressBarComponent) => unknown): this { const c = new ProgressBarComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addDisplayValue(callback: (component: DisplayValueComponent) => unknown): this { const c = new DisplayValueComponent(this.controlEl); callback(c); return this; }
  addDropdown(callback: (component: DropdownComponent) => unknown): this { const c = new DropdownComponent(this.controlEl); this.components.push(c); callback(c); return this; }
  addComponent<T extends BaseComponent>(factory: (el: HTMLElement) => T): this { this.components.push(factory(this.controlEl)); return this; }
  then(callback: (setting: this) => unknown): this { callback(this); return this; }
  clear(): this { this.components.splice(0).reverse().forEach((component) => { const el = component instanceof ButtonComponent || component instanceof ExtraButtonComponent ? component.buttonEl : component instanceof DropdownComponent ? component.selectEl : component instanceof ToggleComponent ? component.toggleEl : component instanceof SearchComponent ? component.inputEl.parentElement : component instanceof TextComponent || component instanceof TextAreaComponent ? component.inputEl : component instanceof ColorComponent ? component.colorEl : component instanceof SliderComponent ? component.containerEl : component instanceof ProgressBarComponent ? component.progressEl : null; el?.remove(); }); this.controlEl.replaceChildren(); this.nameEl.replaceChildren(); this.descEl.replaceChildren(); this.setErrorMessage(null); return this; }
}

/** Declarative setting control configuration introduced in Obsidian 1.13. */
export interface SettingControlBase<V, K extends string = string> {
  key: K;
  defaultValue?: V;
  validate?: (value: V) => string | void | Promise<string | void>;
  disabled?: boolean | (() => boolean);
}
export interface SettingToggleControl<K extends string = string> extends SettingControlBase<boolean, K> { type: "toggle" }
export interface SettingDropdownControl<K extends string = string> extends SettingControlBase<string, K> { type: "dropdown"; options: Record<string, string> }
export interface SettingTextControl<K extends string = string> extends SettingControlBase<string, K> { type: "text"; placeholder?: string }
export interface SettingTextAreaControl<K extends string = string> extends SettingControlBase<string, K> { type: "textarea"; placeholder?: string; rows?: number }
export interface SettingNumberControl<K extends string = string> extends SettingControlBase<number, K> { type: "number"; placeholder?: string; min?: number; max?: number; step?: number | "any" }
export interface SettingFileControl<K extends string = string> extends SettingControlBase<string, K> { type: "file"; placeholder?: string; filter?: (file: unknown) => boolean }
export interface SettingFolderControl<K extends string = string> extends SettingControlBase<string, K> { type: "folder"; placeholder?: string; filter?: (folder: unknown) => boolean; includeRoot?: boolean }
export interface SettingSliderControl<K extends string = string> extends SettingControlBase<number, K> { type: "slider"; min: number; max: number; step: number; displayFormat?: (value: number) => string }
export interface SettingColorControl<K extends string = string> extends SettingControlBase<string, K> { type: "color" }
export interface SettingSecretControl<K extends string = string> extends SettingControlBase<string, K> { type: "secret" }
export type SettingControl<K extends string = string> = SettingToggleControl<K> | SettingDropdownControl<K> | SettingTextControl<K> | SettingTextAreaControl<K> | SettingNumberControl<K> | SettingFileControl<K> | SettingFolderControl<K> | SettingSliderControl<K> | SettingColorControl<K> | SettingSecretControl<K>;

export interface SettingDefinitionBase {
  name: string;
  desc?: string | DocumentFragment;
  aliases?: string[];
  searchable?: boolean | (() => boolean);
  visible?: boolean | (() => boolean);
}
export interface SettingDefinitionControl<K extends string = string> extends SettingDefinitionBase { control: SettingControl<K>; action?: never; render?: never }
export interface SettingDefinitionAction extends SettingDefinitionBase { action: (el: HTMLElement, index: number) => void; disabled?: boolean | (() => boolean); control?: never; render?: never }
export interface SettingDefinitionRender extends SettingDefinitionBase { render: (setting: Setting, group: SettingGroup) => void | (() => void); control?: never; action?: never }
export interface SettingDefinitionEmpty extends SettingDefinitionBase { control?: never; action?: never; render?: never }
export type SettingDefinition<K extends string = string> = SettingDefinitionControl<K> | SettingDefinitionRender | SettingDefinitionAction | SettingDefinitionEmpty;
export interface SettingDefinitionAddItem { name: string; action: (el: HTMLElement) => void }
export interface SettingDefinitionGroup<K extends string = string> {
  type: "group" | "list"; heading?: string; cls?: string;
  search?: { placeholder?: string; match: (def: SettingDefinition, query: string) => boolean };
  extraButtons?: Array<(component: ExtraButtonComponent) => unknown>;
  items?: SettingGroupItem<K>[]; visible?: boolean | (() => boolean);
}
export interface SettingDefinitionList<K extends string = string> extends SettingDefinitionGroup<K> {
  type: "list"; emptyState?: string | DocumentFragment; onReorder?: (oldIndex: number, newIndex: number) => void;
  onDelete?: (index: number) => void; addItem?: SettingDefinitionAddItem;
}
export interface SettingDefinitionPage<K extends string = string> {
  type: "page"; name: string; desc?: string | DocumentFragment; displayValue?: string | (() => string);
  status?: "warning" | null | (() => "warning" | null); items?: SettingDefinitionItem<K>[];
  page?: () => SettingPage; visible?: boolean | (() => boolean);
}
export type SettingGroupItem<K extends string = string> = SettingDefinition<K> | SettingDefinitionPage<K>;
export type SettingDefinitionItem<K extends string = string> = SettingDefinition<K> | SettingDefinitionGroup<K> | SettingDefinitionList<K> | SettingDefinitionPage<K>;

/** Imperative group used by both legacy settings and definition render callbacks. */
export class SettingGroup {
  readonly listEl: HTMLElement;
  constructor(containerEl: HTMLElement) { this.listEl = document.createElement("div"); this.listEl.className = "setting-group"; containerEl.appendChild(this.listEl); }
  setHeading(text: string | DocumentFragment): this {
    let heading = this.listEl.querySelector<HTMLElement>(".setting-group-heading");
    if (!heading) { heading = document.createElement("div"); heading.className = "setting-group-heading"; this.listEl.prepend(heading); }
    heading.replaceChildren(typeof text === "string" ? document.createTextNode(text) : text); return this;
  }
  addClass(...classes: string[]): this { this.listEl.classList.add(...classes); return this; }
  addSetting(callback: (setting: Setting) => void): this { callback(new Setting(this.listEl)); return this; }
  addSearch(callback: (component: SearchComponent) => unknown): this { callback(new SearchComponent(this.listEl)); return this; }
  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this { callback(new ExtraButtonComponent(this.listEl)); return this; }
}

/** Imperative custom settings sub-page. */
export abstract class SettingPage {
  readonly rootEl: HTMLElement;
  readonly titlebarEl: HTMLElement;
  readonly containerEl: HTMLElement;
  title = "";
  constructor() {
    this.rootEl = document.createElement("div"); this.rootEl.className = "setting-page";
    this.titlebarEl = document.createElement("div"); this.titlebarEl.className = "setting-page-titlebar";
    this.containerEl = document.createElement("div"); this.containerEl.className = "setting-page-container";
    this.rootEl.append(this.titlebarEl, this.containerEl);
  }
  abstract display(): void;
  hide(): void { this.containerEl.replaceChildren(); }
}

/** Base for an imperative plugin settings page. */
export abstract class SettingTab extends Component {
  icon = "";
  settingItems: SettingDefinitionItem[] = [];
  constructor(readonly app: unknown, readonly containerEl: HTMLElement) { super(); }
  getSettingDefinitions(): SettingDefinitionItem[] { return []; }
  update(): void { this.settingItems = this.getSettingDefinitions(); }
  getControlValue(_key: string): unknown { return undefined; }
  setControlValue(_key: string, _value: unknown): void | Promise<void> {}
  refreshDomState(): void {}
  abstract display(): void;
  hide(): void { this.containerEl.replaceChildren(); }
}
