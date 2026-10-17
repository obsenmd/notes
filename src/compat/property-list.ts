import { t } from "../i18n";
import { sanitizeHTMLToDom } from "./dom";
import { getAllTags } from "./metadata-cache";
import type { App } from "./plugin";
import { Menu } from "./ui";
import { prepareFuzzySearch } from "./suggest";
import { setIcon } from "./utilities";

interface ListOptions {
  type: "multitext" | "aliases" | "tags";
  key: string;
  app?: App;
  onChange(values: string[]): void;
}

const tagName = (value: string) => value.replace(/^#/, "");
const validTag = (value: string) => /^[\p{L}\p{N}_/-]+$/u.test(tagName(value)) && /[\p{L}_/-]/u.test(tagName(value));

/** Native property pills keep their input mounted across value changes. */
export class PropertyList {
  readonly containerEl: HTMLElement;
  readonly inputEl: HTMLElement;
  private values: string[];
  private pills: HTMLElement[] = [];
  private popup: HTMLElement | null = null;
  private suggestionValues: string[] = [];
  private suggestionIndex = 0;
  private popupObserver: MutationObserver | null = null;
  private errorEl: HTMLElement | null = null;
  private disposed = false;
  private tagClickTimers = new Set<number>();

  constructor(parent: HTMLElement, values: string[], private readonly options: ListOptions) {
    const doc = parent.ownerDocument;
    this.values = values.slice();
    this.containerEl = doc.createElement("div"); this.containerEl.className = "multi-select-container"; this.containerEl.tabIndex = -1;
    this.inputEl = this.makeInput(); this.containerEl.append(this.inputEl); parent.append(this.containerEl);
    this.renderPills();
    this.containerEl.addEventListener("click", event => { if (event.target === this.containerEl) this.inputEl.focus(); });
    this.inputEl.addEventListener("input", () => { this.clearError(); this.updateSuggestions(); });
    this.inputEl.addEventListener("focus", () => this.updateSuggestions());
    this.inputEl.addEventListener("blur", () => { if (!this.disposed) this.flush(); this.closeSuggestions(); });
    this.inputEl.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (this.popup && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        this.selectIndex(this.suggestionIndex < 0 ? (event.key === "ArrowDown" ? 0 : this.suggestionValues.length - 1) : this.suggestionIndex + (event.key === "ArrowDown" ? 1 : -1)); return;
      }
      if (event.key === "Enter") {
        if (this.popup && this.suggestionValues.length && this.suggestionIndex >= 0) { event.preventDefault(); this.addSuggestion(this.suggestionValues[this.suggestionIndex]); }
        else if (this.inputEl.textContent) { event.preventDefault(); if (this.flush()) this.updateSuggestions(); }
      } else if (event.key === "Backspace" && !this.inputEl.textContent && this.pills.length) {
        event.preventDefault(); this.pills.at(-1)?.focus();
      } else if (event.key === "ArrowLeft" && !this.inputEl.textContent && this.pills.length) {
        event.preventDefault(); this.pills.at(-1)?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault(); this.closeSuggestions(); parent.closest<HTMLElement>(".metadata-container")?.focus();
      }
    });
  }

  private makeInput(): HTMLElement {
    const input = this.containerEl.ownerDocument.createElement("div"); input.className = "multi-select-input"; input.contentEditable = "true"; input.tabIndex = 0;
    input.autocapitalize = "none";
    input.addEventListener("input", () => {
      input.normalize();
      if (input.childNodes.length === 1 && input.firstChild?.nodeType === 3) return;
      input.textContent = input.textContent ?? "";
      if (input.ownerDocument.activeElement === input) {
        const range = input.ownerDocument.createRange(); range.selectNodeContents(input); range.collapse(false);
        const selection = input.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
    });
    input.addEventListener("paste", event => {
      event.preventDefault();
      const data = event.clipboardData;
      const uri = (data?.getData("text/uri-list") ?? "").split("\n")[0].trim();
      const html = data?.getData("text/html") ?? "";
      const text = data?.getData("text/plain") || uri || (html ? sanitizeHTMLToDom(html).textContent : "") || "";
      if (!text) return;
      const doc = input.ownerDocument;
      if (doc.queryCommandSupported("insertText")) doc.execCommand("insertText", false, text);
      else {
        const selection = doc.getSelection(); if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0); if (!input.contains(range.commonAncestorContainer)) return;
        range.deleteContents(); const node = doc.createTextNode(text); range.insertNode(node);
        range.selectNodeContents(node); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
      }
      input.normalize();
    });
    return input;
  }

  private createValue(text: string): string | null {
    if (this.options.type === "multitext") return text || null;
    if (!text.trim()) return null;
    if (this.options.type === "tags") {
      if (!validTag(text)) { this.showError(); return null; }
      this.clearError(); return text;
    }
    return text.trim();
  }

  private duplicate(value: string, except = -1): number {
    if (this.options.type === "multitext") return -1;
    return this.values.findIndex((entry, index) => index !== except && (this.options.type === "tags" ? tagName(entry) === tagName(value) : entry === value));
  }

  private markDuplicate(index: number): void {
    const pill = this.pills[index]; if (!pill) return;
    pill.classList.add("multi-select-duplicate");
    pill.ownerDocument.defaultView?.setTimeout(() => pill.classList.remove("multi-select-duplicate"), 2000);
  }

  private flush(): boolean {
    const value = this.createValue(this.inputEl.textContent ?? ""); if (!value) return false;
    const duplicate = this.duplicate(value); if (duplicate >= 0) { this.markDuplicate(duplicate); return false; }
    this.values.push(value); this.inputEl.textContent = ""; this.renderPills(); this.options.onChange(this.values.slice()); return true;
  }

  private remove(index: number, focusPrevious = false): void {
    this.values.splice(index, 1); this.renderPills();
    if (focusPrevious) this.focusPill(index - 1);
    this.options.onChange(this.values.slice()); this.updateSuggestions();
  }

  private focusPill(index: number): void { (this.pills[Math.max(0, index)] ?? this.inputEl).focus(); }

  private renderPills(): void {
    for (const pill of this.pills) pill.remove(); this.pills = [];
    for (const [index, value] of this.values.entries()) {
      const doc = this.containerEl.ownerDocument;
      const pill = doc.createElement("div"); pill.className = "multi-select-pill"; pill.tabIndex = 0;
      const content = doc.createElement("div"); content.className = "multi-select-pill-content";
      if (this.options.type === "tags") {
        const span = doc.createElement("span"); span.textContent = tagName(value); content.append(span);
        this.bindTagClick(content, tagName(value));
        if (!validTag(value)) { pill.classList.add("is-invalid"); pill.setAttribute("aria-label", t("properties.msg-invalid-tag")); }
      } else {
        content.textContent = value;
        if (this.options.type === "aliases" && !value.trim()) pill.classList.add("is-invalid");
      }
      if (this.duplicate(value, index) >= 0 && this.values.slice(0, index).some(entry => this.options.type === "tags" ? tagName(entry) === tagName(value) : entry === value)) pill.classList.add("is-invalid");
      const remove = doc.createElement("div"); remove.className = "multi-select-pill-remove-button"; setIcon(remove, "lucide-x");
      remove.addEventListener("mousedown", event => event.preventDefault());
      remove.addEventListener("click", event => { event.preventDefault(); this.remove(index); });
      pill.addEventListener("copy", event => { event.clipboardData?.setData("text/plain", value); event.preventDefault(); });
      pill.addEventListener("dblclick", event => { event.preventDefault(); this.edit(index); });
      pill.addEventListener("contextmenu", event => {
        event.preventDefault(); event.stopPropagation();
        const menu = new Menu();
        menu.addItem(item => item.setSection("action-primary").setTitle(t("interface.menu.edit")).setIcon("lucide-edit-3").onClick(() => this.edit(index)));
        menu.addItem(item => item.setSection("action-primary").setTitle(t("interface.menu.copy")).setIcon("lucide-copy").onClick(() => { void doc.defaultView?.navigator.clipboard.writeText(value); }));
        menu.addItem(item => item.setSection("action-primary").setTitle(t("interface.menu.remove-from-list")).setIcon("lucide-trash-2").setWarning(true).onClick(() => this.remove(index)));
        menu.showAtMouseEvent(event);
      });
      pill.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); this.edit(index); }
        else if (event.key === "Backspace") { event.preventDefault(); this.remove(index, true); }
        else if (event.key === "Escape" || event.key === "ArrowDown") { event.preventDefault(); this.inputEl.focus(); }
        else if (event.key === "ArrowUp") { event.preventDefault(); this.focusPill(0); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); this.focusPill(index + (event.key === "ArrowLeft" ? -1 : 1)); }
      });
      pill.append(content, remove); this.containerEl.insertBefore(pill, this.inputEl); this.pills.push(pill);
    }
    const placeholder = this.values.length ? "" : t("properties.label-no-value");
    this.inputEl.dataset.placeholder = placeholder; this.inputEl.setAttribute("placeholder", placeholder);
  }

  private edit(index: number): void {
    const pill = this.pills[index]; if (!pill) return;
    const input = this.makeInput(); input.textContent = this.values[index];
    this.containerEl.insertBefore(input, pill); pill.remove();
    let editing = true;
    const cancel = () => { editing = false; this.containerEl.insertBefore(pill, input); input.remove(); pill.focus(); };
    const commit = (focus: boolean) => {
      const value = this.createValue(input.textContent ?? ""); if (!value) return false;
      const duplicate = this.duplicate(value, index); if (duplicate >= 0) { this.markDuplicate(duplicate); return false; }
      editing = false; input.remove(); this.values[index] = value; this.renderPills();
      if (focus) this.focusPill(index); this.options.onChange(this.values.slice()); return true;
    };
    input.addEventListener("blur", () => { if (editing && !this.disposed) { if (input.textContent) commit(false); else cancel(); } });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter" && input.textContent) { event.preventDefault(); commit(true); }
      else if (event.key === "Escape") { event.preventDefault(); cancel(); }
    });
    input.focus(); const range = input.ownerDocument.createRange(); range.selectNodeContents(input);
    const selection = input.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }

  private bindTagClick(content: HTMLElement, tag: string): void {
    let timer = 0;
    const win = content.ownerDocument.defaultView;
    content.addEventListener("mousedown", event => {
      if (event.detail > 1) { win?.clearTimeout(timer); this.tagClickTimers.delete(timer); }
    });
    content.addEventListener("click", event => {
      if (!win || event.defaultPrevented || event.detail > 1 || event.shiftKey) return;
      const selection = content.ownerDocument.getSelection();
      for (let i = 0; selection && i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (!range.collapsed && (content.contains(range.startContainer) || content.contains(range.endContainer))) return;
      }
      const active = content.ownerDocument.activeElement;
      if (active !== content && active && content.contains(active)) return;
      let overText = false;
      const target = event.target as Node | null;
      for (const node of target?.childNodes ?? []) {
        if (node.nodeType !== 3) continue;
        const range = content.ownerDocument.createRange(); range.selectNodeContents(node);
        if ([...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) overText = true;
      }
      timer = win.setTimeout(() => {
        this.tagClickTimers.delete(timer);
        if (this.disposed || !content.isConnected || event.defaultPrevented) return;
        const app = this.options.app;
        if (app?.workspace.viewRegistry.has("search")) {
          event.preventDefault(); app.workspace.trigger("search:open", "tag:" + tag);
        }
      }, overText ? 150 : 10);
      this.tagClickTimers.add(timer);
    });
  }

  private tags(withHash: boolean): string[] {
    const app = this.options.app; if (!app) return [];
    const tags = new Set<string>();
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file); if (!cache) continue;
      for (const tag of getAllTags(cache) ?? []) {
        const parts = tagName(tag).split("/"); for (let length = 1; length <= parts.length; length++) tags.add(parts.slice(0, length).join("/"));
      }
    }
    return [...tags].map(tag => withHash ? "#" + tag : tag).filter(tag => !this.values.includes(tag)).sort((a, b) => a.localeCompare(b));
  }

  private propertyValues(): string[] {
    const app = this.options.app; if (!app) return [];
    const values = new Set<string>(), key = this.options.key.toLowerCase();
    for (const file of app.vault.getMarkdownFiles()) {
      const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
      for (const [name, raw] of Object.entries(frontmatter ?? {})) {
        if (name.toLowerCase() !== key) continue;
        for (const value of Array.isArray(raw) ? raw : [raw]) if (typeof value === "string" && !this.values.includes(value)) values.add(value);
      }
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }

  private updateSuggestions(): void {
    if (this.options.type === "aliases" || this.disposed || this.inputEl.ownerDocument.activeElement !== this.inputEl) { this.closeSuggestions(); return; }
    const query = (this.inputEl.textContent ?? "").toLowerCase();
    const match = prepareFuzzySearch(query);
    const values = this.options.type === "tags" ? this.tags(query.startsWith("#")) : this.propertyValues();
    this.suggestionValues = values.map(tag => ({ tag, match: match(tag) })).filter(item => item.match !== null)
      .sort((a, b) => b.match!.score - a.match!.score).slice(0, 100).map(item => item.tag);
    if (!this.suggestionValues.length) { this.closeSuggestions(); return; }
    const doc = this.inputEl.ownerDocument;
    if (!this.popup) {
      this.popup = doc.createElement("div"); this.popup.className = "suggestion-container mod-property-value"; doc.body.append(this.popup);
      if (this.options.type === "multitext") this.popup.dataset.propertyKey = this.options.key;
      this.observeRemoval();
    }
    const box = this.inputEl.getBoundingClientRect();
    const list = doc.createElement("div"); list.className = "suggestion";
    for (const [index, value] of this.suggestionValues.entries()) {
      const row = doc.createElement("div"); row.className = this.options.type === "multitext" ? "suggestion-item mod-nowrap" : "suggestion-item";
      const at = query ? value.toLowerCase().indexOf(query) : -1;
      if (at >= 0) { row.append(value.slice(0, at)); const highlight = doc.createElement("span"); highlight.className = "suggestion-highlight"; highlight.textContent = value.slice(at, at + query.length); row.append(highlight, value.slice(at + query.length)); }
      else row.textContent = value;
      row.addEventListener("mouseenter", () => this.selectIndex(index));
      row.addEventListener("mousedown", event => { event.preventDefault(); this.addSuggestion(value); }); list.append(row);
    }
    this.popup.replaceChildren(list);
    if (query) this.selectIndex(0); else { this.suggestionIndex = -1; this.renderSelection(); }
    // Placement uses the integer layout size, matching the native suggester's
    // viewport clamp rather than introducing a fractional horizontal offset.
    const size = { width: this.popup.offsetWidth, height: this.popup.offsetHeight }, win = doc.defaultView;
    const left = Math.max(10, Math.min(box.left, (win?.innerWidth ?? box.right) - size.width - 10));
    const top = box.bottom + 5 + size.height > (win?.innerHeight ?? box.bottom + size.height + 15) - 10 ? box.top - size.height - 5 : box.bottom + 5;
    Object.assign(this.popup.style, { left: left + "px", top: Math.max(10, top) + "px" });
  }

  private selectIndex(index: number): void {
    this.suggestionIndex = (index + this.suggestionValues.length) % this.suggestionValues.length;
    this.renderSelection();
  }
  private renderSelection(): void {
    this.popup?.querySelectorAll(".suggestion-item").forEach((row, i) => row.classList.toggle("is-selected", i === this.suggestionIndex));
  }
  private addSuggestion(value: string): void {
    this.inputEl.textContent = value; this.flush();
    // Suggestion selection clears the query even when the option is a duplicate.
    this.inputEl.textContent = ""; this.updateSuggestions();
  }
  private observeRemoval(): void {
    if (this.popupObserver) return;
    const doc = this.inputEl.ownerDocument, Observer = doc.defaultView?.MutationObserver;
    if (Observer) { this.popupObserver = new Observer(() => { if (!this.inputEl.isConnected) this.dispose(); }); this.popupObserver.observe(doc.body, { childList: true, subtree: true }); }
  }
  private closeSuggestions(): void {
    this.popup?.remove(); this.popup = null;
    if (!this.errorEl) { this.popupObserver?.disconnect(); this.popupObserver = null; }
  }
  private showError(): void {
    this.clearError(); const doc = this.inputEl.ownerDocument, box = this.inputEl.getBoundingClientRect();
    this.errorEl = doc.createElement("div"); this.errorEl.className = "tooltip mod-error"; this.errorEl.textContent = t("properties.msg-invalid-tag");
    Object.assign(this.errorEl.style, { left: box.left + box.width / 2 + "px", top: box.bottom + 8 + "px", transform: "translateX(-50%)" }); doc.body.append(this.errorEl); this.observeRemoval();
  }
  private clearError(): void {
    this.errorEl?.remove(); this.errorEl = null;
    if (!this.popup) { this.popupObserver?.disconnect(); this.popupObserver = null; }
  }
  resetPending(): void {
    if (this.containerEl.contains(this.inputEl.ownerDocument.activeElement)) return;
    this.inputEl.textContent = ""; this.closeSuggestions(); this.clearError();
  }
  dispose(): void {
    this.disposed = true; this.closeSuggestions(); this.clearError();
    for (const timer of this.tagClickTimers) this.containerEl.ownerDocument.defaultView?.clearTimeout(timer);
    this.tagClickTimers.clear();
  }
}
