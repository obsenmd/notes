import type { App } from "../compat/plugin";
import { Modal } from "../compat/ui";
import { FuzzySuggestModal } from "../compat/suggest";
import { t } from "../i18n";

function button(text: string, className: string, onClick: () => void, doc = document): HTMLButtonElement {
  const el = doc.createElement("button");
  el.textContent = text; if (className) el.className = className;
  el.addEventListener("click", onClick);
  return el;
}

/** Text entry dialog with the standard modal lifecycle; resolves null when dismissed. */
export function requestText(app: App, title: string, initial = "", options: { placeholder?: string; cta?: string } = {}): Promise<string | null> {
  return new Promise(resolve => {
    let result: string | null = null;
    class TextDialog extends Modal {
      override onOpen() {
        this.setTitle(title);
        const input = document.createElement("input");
        input.type = "text"; input.value = initial; input.placeholder = options.placeholder ?? ""; input.style.width = "100%";
        const submit = () => { result = input.value; this.close(); };
        input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); } });
        const buttons = document.createElement("div"); buttons.className = "modal-button-container";
        buttons.append(button(options.cta ?? t("dialogue.button-save"), "mod-cta", submit), button(t("dialogue.button-cancel"), "mod-cancel", () => this.close()));
        this.contentEl.append(input);
        this.modalEl.append(buttons);
        input.focus(); input.select();
      }
      override onClose() { resolve(result); }
    }
    new TextDialog(app).open();
  });
}

export interface ConfirmOptions {
  title: string;
  /** Paragraphs shown in the dialog body. */
  message: string[];
  /** Some reference dialogs use an unwrapped body instead of paragraphs. */
  body?: (container: HTMLElement) => void;
  cancelFirst?: boolean;
  cta: string;
  warning?: boolean;
  /** A destructive call to action, as dialogs built with the reference's button component have. */
  destructive?: boolean;
  /** Label for an optional "don't ask again" style checkbox. */
  checkbox?: string;
}

export function confirmDialog(app: App, options: ConfirmOptions): Promise<{ confirmed: boolean; checked: boolean }> {
  return new Promise(resolve => {
    let confirmed = false, checked = false;
    class ConfirmDialog extends Modal {
      override onOpen() {
        this.setTitle(options.title);
        const doc = this.contentEl.ownerDocument;
        if (options.body) options.body(this.contentEl);
        else for (const line of options.message) { const paragraph = doc.createElement("p"); paragraph.textContent = line; this.contentEl.append(paragraph); }
        const buttons = doc.createElement("div"); buttons.className = "modal-button-container";
        if (options.checkbox) {
          const label = doc.createElement("label"); label.className = "mod-checkbox";
          const input = doc.createElement("input"); input.type = "checkbox"; input.tabIndex = -1;
          input.addEventListener("change", () => { checked = input.checked; });
          label.append(input, options.checkbox);
          buttons.append(label);
        }
        const confirm = button(options.cta, options.destructive ? "mod-destructive mod-cta" : options.warning ? "mod-warning" : "mod-cta", () => { confirmed = true; this.close(); }, doc);
        const cancel = button(t("dialogue.button-cancel"), "mod-cancel", () => this.close(), doc);
        buttons.append(...(options.cancelFirst ? [cancel, confirm] : [confirm, cancel]));
        this.modalEl.append(buttons);
        confirm.focus();
      }
      override onClose() { resolve({ confirmed, checked }); }
    }
    new ConfirmDialog(app).open();
  });
}

export interface ChooseOptions<T> { placeholder: string; instructions?: Array<{ command: string; purpose: string }>; emptyText?: string; render?: (item: T, el: HTMLElement) => void }

export function chooseItem<T>(app: App, items: T[], text: (item: T) => string, options: ChooseOptions<T>): Promise<T | null> {
  return new Promise(resolve => {
    let chosen: T | null = null;
    class Picker extends FuzzySuggestModal<T> {
      getItems() { return items; }
      getItemText(item: T) { return text(item); }
      onChooseItem(item: T) { chosen = item; resolve(item); }
      override onClose() { super.onClose(); queueMicrotask(() => { if (chosen === null) resolve(null); }); }
    }
    const picker = new Picker(app);
    picker.setPlaceholder(options.placeholder);
    if (options.emptyText) picker.emptyStateText = options.emptyText;
    picker.setInstructions(options.instructions ?? [
      { command: "↑↓", purpose: t("plugins.file-explorer.instruction-navigate") },
      { command: "↵", purpose: t("plugins.command-palette.instruction-use") },
      { command: "esc", purpose: t("plugins.file-explorer.instruction-dismiss") },
    ]);
    picker.open();
  });
}

export interface ButtonChoice<T> { label: string; value: T; cta?: boolean }

/** Dialog offering several named answers; resolves null when dismissed. */
export function chooseButton<T>(app: App, options: { title: string; message: string[]; choices: Array<ButtonChoice<T>> }): Promise<T | null> {
  return new Promise(resolve => {
    let result: T | null = null;
    class ChoiceDialog extends Modal {
      override onOpen() {
        this.setTitle(options.title);
        for (const line of options.message) { const paragraph = document.createElement("p"); paragraph.textContent = line; this.contentEl.append(paragraph); }
        const buttons = document.createElement("div"); buttons.className = "modal-button-container";
        const elements = options.choices.map(choice => button(choice.label, choice.cta ? "mod-cta" : "", () => { result = choice.value; this.close(); }));
        buttons.append(...elements);
        this.modalEl.append(buttons);
        (elements[options.choices.findIndex(choice => choice.cta)] ?? elements[0])?.focus();
      }
      override onClose() { resolve(result); }
    }
    new ChoiceDialog(app).open();
  });
}
