import type { App } from "../../compat/plugin";
import { Modal } from "../../compat/ui";
import { setIcon } from "../../compat/utilities";
import { t } from "../../i18n";

/** Small DOM builders for dialogs that follow the reference settings-row structure. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string, parent?: HTMLElement | DocumentFragment): HTMLElementTagNameMap[K] {
  const node = (parent?.ownerDocument ?? document).createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
}
export const div = (cls = "", parent?: HTMLElement | DocumentFragment, text?: string) => el("div", cls, text, parent);
export function iconDiv(parent: HTMLElement, cls: string, icon: string, label?: string, placement?: string): HTMLDivElement {
  const node = div(cls, parent); setIcon(node, icon);
  if (label) node.setAttribute("aria-label", label);
  if (placement) node.setAttribute("data-tooltip-position", placement);
  return node;
}

export interface SettingRow { settingEl: HTMLElement; nameEl: HTMLElement; descEl: HTMLElement; controlEl: HTMLElement; setVisible(visible: boolean): void; setDisabled(disabled: boolean): void }
export function settingRow(parent: HTMLElement, name: string, description = "", cls = ""): SettingRow {
  const settingEl = div("setting-item" + (cls ? " " + cls : ""), parent); settingEl.tabIndex = -1;
  const info = div("setting-item-info", settingEl), nameEl = div("setting-item-name", info, name), descEl = div("setting-item-description", info, description), controlEl = div("setting-item-control", settingEl);
  return { settingEl, nameEl, descEl, controlEl, setVisible: visible => { settingEl.style.display = visible ? "" : "none"; }, setDisabled: disabled => settingEl.classList.toggle("is-disabled", disabled) };
}
export interface ToggleControl { el: HTMLElement; get(): boolean; set(value: boolean): void }
export function toggle(parent: HTMLElement, value: boolean, onChange: (value: boolean) => void): ToggleControl {
  const label = el("label", "checkbox-container", undefined, parent); label.tabIndex = 0;
  const input = el("input", "", undefined, label); input.type = "checkbox"; input.tabIndex = -1;
  const control: ToggleControl = { el: label, get: () => label.classList.contains("is-enabled"), set: next => { label.classList.toggle("is-enabled", next); input.checked = next; } };
  const flip = () => { if (label.closest(".is-disabled")) return; control.set(!control.get()); onChange(control.get()); };
  label.addEventListener("click", event => { event.preventDefault(); flip(); });
  label.addEventListener("keydown", event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); flip(); } });
  control.set(value);
  return control;
}
export function dropdown(parent: HTMLElement, options: Array<[string, string]>, value: string, onChange: (value: string) => void): HTMLSelectElement {
  const select = el("select", "dropdown", undefined, parent);
  for (const [id, label] of options) { const option = el("option", "", label, select); option.value = id; }
  select.value = value; select.addEventListener("change", () => onChange(select.value));
  return select;
}
export function slider(parent: HTMLElement, min: number, max: number, step: number | "any", value: number, format: (value: number) => string, onChange: (value: number) => void): HTMLInputElement {
  const display = el("span", "slider-value", format(value), parent), input = el("input", "slider", undefined, parent);
  input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  const fill = () => input.style.setProperty("--slider-fill-ratio", String(max === min ? 0 : Math.max(0, Math.min(1, (Number(input.value) - min) / (max - min)))));
  input.addEventListener("input", () => { display.textContent = format(Number(input.value)); fill(); onChange(Number(input.value)); });
  fill();
  return input;
}
export function button(parent: HTMLElement, text: string, cls: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const node = el("button", cls, text, parent); node.addEventListener("click", onClick); return node;
}

/** The reference's single-field dialog (used for renaming): a growing text area with Save and Cancel. */
export class TextPromptModal extends Modal {
  readonly inputEl: HTMLTextAreaElement;
  constructor(app: App, private readonly heading: string, value: string, private readonly onSave: (value: string) => void, private readonly validate: (value: string) => string = () => "") {
    super(app);
    this.modalEl.classList.add("mod-file-rename");
    const input = this.inputEl = el("textarea", "rename-textarea", undefined, this.contentEl); input.rows = 1; input.value = value;
    const grow = () => { input.rows = 1; input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
    input.addEventListener("keypress", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); this.submit(); } });
    input.addEventListener("input", () => { grow(); this.showError(this.validate(input.value.trim())); });
    const buttons = div("modal-button-container", this.modalEl);
    button(buttons, t("dialogue.button-save"), "mod-cta", () => this.submit());
    button(buttons, t("dialogue.button-cancel"), "mod-cancel", () => this.close());
    queueMicrotask(grow);
  }
  override onOpen(): void { this.setTitle(this.heading); this.inputEl.select(); this.inputEl.focus(); }
  private showError(message: string): void {
    this.inputEl.classList.toggle("is-invalid", !!message);
    if (message) this.inputEl.setAttribute("aria-label", message); else this.inputEl.removeAttribute("aria-label");
  }
  private submit(): void {
    const value = this.inputEl.value.trim(), error = this.validate(value);
    if (error) { this.showError(error); return; }
    this.close(); this.onSave(value);
  }
}
