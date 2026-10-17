import { Decoration, EditorView, ViewPlugin, placeholder as editorPlaceholder, type DecorationSet } from "@codemirror/view";
import type { App } from "../../compat/plugin";
import { getBasesViewRegistrations } from "../../compat/bases-registry";
import { TFile, TFolder } from "../../compat/vault";
import { DateValue, FileValue, ListValue, NullValue, NumberValue, QueryController, RenderContext, Value, parsePropertyId, wrapValue } from "../../compat/bases";
import { inferPropertyType } from "../../compat/properties-editor";
import { Menu, Notice } from "../../compat/ui";
import { setIcon } from "../../compat/utilities";
import { MarkdownView } from "../../compat/markdown-view";
import { WorkspaceLeaf } from "../../compat/workspace";
import { AbstractInputSuggest, prepareFuzzySearch, renderMatches, type FuzzyMatch } from "../../compat/suggest";
import { HoverPopover, PopoverState } from "../hover-preview";
import { t } from "../../i18n";
import { Formula, defaultSummaries, formulaTokenRanges, summaryLabel, methodsFor, serializeCall, widgetForValue, type FormulaFunction, type Node } from "./formula";
import {
  BasesQuery, Entry, FILE_PROPERTIES, FilterGroup, FilterRule, MockContext, QueryContext, ViewConfig, ViewData, applySearch, combineFilters, newItemDefaults, propertyExpression,
  sampleForWidget, summaryContext, toPropertyId, uniqueName, type Conjunction, type Direction, type Filter, type PropertyId,
} from "./query";
import {
  Chooser, Combobox, MenuAction, MenuPage, SearchInput, TextIconButton, ToolbarItem, ToolbarMenu, arrayMove, div, dragReorder, el, iconDiv, matchesQuery, setCollapsed, toggle,
  type ComboItem,
} from "./ui";
import { BasesView, CardsView, ListView, TableView, WIDGET_ICONS, renderWidget, toDelimited, type ViewOption, type ViewOptionGroup, type Widget } from "./views";

export interface ViewRegistration { name: () => string; icon: string; factory: (controller: BasesController, containerEl: HTMLElement) => BasesView; options?: (config: ViewConfig) => Array<ViewOption | ViewOptionGroup> }
/** Layouts a view can use; plugins may add their own. */
export const VIEW_REGISTRY: Record<string, ViewRegistration> = {
  table: { name: () => t("plugins.bases.table.name"), icon: "lucide-table", factory: (controller, containerEl) => new TableView(controller, containerEl), options: TableView.getViewOptions },
  cards: { name: () => t("plugins.bases.cards.name"), icon: "lucide-layout-grid", factory: (controller, containerEl) => new CardsView(controller, containerEl), options: CardsView.getViewOptions },
  list: { name: () => t("plugins.bases.list.name"), icon: "lucide-list", factory: (controller, containerEl) => new ListView(controller, containerEl), options: ListView.getViewOptions },
};

const GROUP_FOLDS_KEY = "bases-group-fold-";
const PROPERTY_TYPES_KEY = "bases-property-types";
const INVALID_VIEW_NAME = /[#^|:]|%%|\[\[|\]\]/;
const INVALID_VIEW_NAME_CHARS = ["#", ":", "|", "^", "%%", "[[", "]]"].join(" ");
/** Filter-builder captions. The reference ships these in English only, so there are no locale keys for them. */
const OPERATOR_LABELS: Record<string, [() => string, () => string]> = {
  hasproperty: [() => t("obsen.bases.operators.has-property"), () => t("obsen.bases.operators.does-not-have-property")], isempty: [() => t("obsen.bases.operators.is-empty"), () => t("obsen.bases.operators.is-not-empty")], startswith: [() => t("obsen.bases.operators.starts-with"), () => t("obsen.bases.operators.does-not-start-with")],
  endswith: [() => t("obsen.bases.operators.ends-with"), () => t("obsen.bases.operators.does-not-end-with")], contains: [() => t("obsen.bases.operators.contains"), () => t("obsen.bases.operators.does-not-contain")], containsany: [() => t("obsen.bases.operators.contains-any-of"), () => t("obsen.bases.operators.does-not-contain-any-of")],
  containsall: [() => t("obsen.bases.operators.contains-all-of"), () => t("obsen.bases.operators.does-not-contain-all-of")], matches: [() => t("obsen.bases.operators.matches"), () => t("obsen.bases.operators.does-not-match")], haslink: [() => t("obsen.bases.operators.links-to"), () => t("obsen.bases.operators.does-not-link-to")],
  infolder: [() => t("obsen.bases.operators.in-folder"), () => t("obsen.bases.operators.is-not-in-folder")], hastag: [() => t("obsen.bases.operators.has-tag"), () => t("obsen.bases.operators.does-not-have-tag")],
};
const COMPARISON_LABELS: Record<string, { text: string | (() => string); number?: string; date?: string | (() => string); list?: () => string }> = {
  "==": { text: () => t("obsen.bases.comparisons.is"), number: "=", date: () => t("obsen.bases.comparisons.on"), list: () => t("obsen.bases.operators.is-exactly") }, "!=": { text: () => t("obsen.bases.operators.is-not"), number: "≠", date: () => t("obsen.bases.operators.not-on"), list: () => t("obsen.bases.operators.is-not-exactly") },
  "<": { text: "<", date: () => t("obsen.bases.comparisons.before") }, "<=": { text: "≤", date: () => t("obsen.bases.operators.on-or-before") }, ">": { text: ">", date: () => t("obsen.bases.comparisons.after") }, ">=": { text: "≥", date: () => t("obsen.bases.operators.on-or-after") },
};

const HELP_URL = "https://help.obsidian.md/bases/functions";
const NO_GROUPING = ["file.file", "file.path", "file.ctime", "file.mtime", "file.name", "file.fullname", "file.basename"];

function debounced(callback: () => void, delay: number): { (): void; cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => { timer = null; callback(); };
  const request = () => { if (timer) clearTimeout(timer); timer = setTimeout(run, delay); };
  request.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  request.flush = () => { if (timer) { clearTimeout(timer); run(); } };
  return request;
}
function textInput(parent: HTMLElement, value: string, placeholder = ""): HTMLInputElement {
  const input = el(parent, "input"); input.type = "text"; input.value = value; input.placeholder = placeholder; input.spellcheck = false;
  return input;
}
function inputRow(form: HTMLElement, label?: string): { rowEl: HTMLElement; labelEl: HTMLElement | null; contentEl: HTMLElement } {
  const rowEl = div(form, "input-row"), labelEl = label === undefined ? null : div(rowEl, "input-row-label", label);
  return { rowEl, labelEl, contentEl: div(rowEl, "input-row-content") };
}

/** The formula box used for computed properties and advanced filters. */
class FormulaEditor {
  readonly editor: EditorView;
  destroy: () => void;
  constructor(parent: HTMLElement, formula: Formula | null, options: { update(formula: Formula): void; placeholder?: string; status?: boolean }) {
    const container = parent.classList.contains("formula-editor-container") ? parent : div(parent, "formula-editor-container");
    container.replaceChildren();
    const host = div(container, "formula-editor");
    const status = options.status === false ? null : div(container, "formula-editor-status"), statusIcon = status ? div(status, "status-icon") : null, statusText = status ? el(status, "span") : null;
    const show = (current: Formula | null) => {
      if (!status) return;
      const invalid = !!current?.isInvalid;
      status.classList.toggle("mod-error", invalid); status.classList.toggle("mod-empty", !current || current.toString() === "");
      setIcon(statusIcon!, invalid ? "lucide-x-circle" : "lucide-circle-check");
      statusText!.textContent = invalid ? t("obsen.bases.formula-invalid") : t("obsen.bases.formula-valid");
      if (invalid) status.setAttribute("aria-label", current!.errorMessage); else status.removeAttribute("aria-label");
    };
    show(formula);
    let timer: ReturnType<typeof setTimeout> | null = null, last = formula?.toString() ?? "";
    const commit = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const text = this.editor.state.doc.toString();
      if (text === last) return;
      last = text;
      const next = new Formula(text);
      show(next); options.update(next);
    };
    this.editor = new EditorView({
      doc: last, parent: host,
      extensions: [
        EditorView.lineWrapping, editorPlaceholder(options.placeholder ?? "x + y"),
        ViewPlugin.fromClass(class {
          decorations: DecorationSet;
          constructor(view: EditorView) { this.decorations = this.highlight(view); }
          highlight(view: EditorView) { return Decoration.set(formulaTokenRanges(view.state.doc.toString()).map(token => Decoration.mark({ class: token.className }).range(token.from, token.to))); }
          update(update: { docChanged: boolean; view: EditorView }) { if (update.docChanged) this.decorations = this.highlight(update.view); }
        }, { decorations: plugin => plugin.decorations }),
        EditorView.domEventHandlers({ blur: () => { commit(); } }),
        EditorView.updateListener.of(update => { if (update.docChanged) { if (timer) clearTimeout(timer); timer = setTimeout(commit, 250); } }),
      ],
    });
    this.destroy = () => { commit(); this.editor.destroy(); };
  }
  static appendHelpIcon(labelEl: HTMLElement): void { iconDiv(labelEl, "clickable-icon help-icon", "lucide-help-circle").addEventListener("click", () => window.open(HELP_URL, "_blank")); }
}

type PropertyItem = ComboItem<PropertyId>;
/** Property picker listing file properties, formulas and every note property in the vault. */
class PropertyCombobox extends Combobox<PropertyId, PropertyItem> {
  constructor(private readonly controller: BasesController, parent: HTMLElement, filter?: (property: PropertyId) => boolean) {
    super(parent);
    this.setItems(() => controller.getPropertyItems(filter));
  }
  setProperty(property: PropertyId | null): this {
    return this.setValueById(property, value => ({ value, icon: "lucide-file-question", display: this.controller.getDisplayName(value) }));
  }
}

/** The reference uses fuzzy path suggestions for file/folder view options. */
class ViewPathSuggest extends AbstractInputSuggest<FuzzyMatch<TFile | TFolder>> {
  constructor(app: App, input: HTMLInputElement, private kind: "file" | "folder", private predicate?: (value: TFile | TFolder) => boolean) {
    super(app, input);
    this.registerDomEvent(input, "focus", () => input.dispatchEvent(new Event("input")));
    this.registerDomEvent(input, "blur", () => { setTimeout(() => { if (input.ownerDocument.activeElement !== input) this.close(); }, 100); });
  }
  protected getSuggestions(query: string): Array<FuzzyMatch<TFile | TFolder>> {
    const match = prepareFuzzySearch(query), values: Array<FuzzyMatch<TFile | TFolder>> = [];
    for (const item of this.app.vault.getAllLoadedFiles()) {
      if (item.path.split("/").some(part => part.startsWith("."))) continue;
      if (this.kind === "file" ? !(item instanceof TFile) : !(item instanceof TFolder)) continue;
      if (this.predicate && !this.predicate(item as TFile | TFolder)) continue;
      const result = match(item.path);
      if (result) values.push({ item: item as TFile | TFolder, match: result });
      if (values.length === 100) break;
    }
    return values.sort((a, b) => b.match.score - a.match.score);
  }
  override open(): void {
    super.open();
    const rect = this.textInputEl.getBoundingClientRect();
    if (this.rootEl) Object.assign(this.rootEl.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.bottom}px`, width: `${Math.max(rect.width, 200)}px` });
  }
  renderSuggestion(value: FuzzyMatch<TFile | TFolder>, row: HTMLElement): void {
    row.classList.add("mod-nowrap");
    renderMatches(row, value.item instanceof TFile && value.item.extension === "md" ? value.item.path.slice(0, -3) : value.item.path, value.match.matches);
  }
  override selectSuggestion(value: FuzzyMatch<TFile | TFolder>, event: MouseEvent | KeyboardEvent): void {
    this.setValue(value.item.path);
    this.textInputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.textInputEl.dispatchEvent(new Event("change", { bubbles: true }));
    super.selectSuggestion(value, event);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Toolbar: views

class ViewConfigPage extends MenuPage {
  private readonly formEl: HTMLElement;
  private controls = new Map<ViewOption | ViewOptionGroup, HTMLElement>();
  private optionDisposers: Array<() => void> = [];
  constructor(host: ToolbarMenu, private readonly controller: BasesController, private readonly view: ViewConfig, private isNew: boolean) {
    super(host);
    this.setTitle(t("plugins.bases.label-configure-view"));
    this.addAction("lucide-more-vertical", event => this.showActions(event));
    this.formEl = div(this.containerEl, "bases-toolbar-menu-form view-config-menu");
    this.display(isNew);
  }
  private display(select = false): void {
    const { controller, view, formEl } = this, query = controller.query!;
    this.optionDisposers.splice(0).forEach(dispose => dispose());
    formEl.replaceChildren(); this.controls.clear();
    const input = textInput(inputRow(formEl).contentEl, view.name, t("plugins.bases.label-view-name"));
    let name = view.name, error = "";
    const validate = () => {
      if (name === "") return t("plugins.bases.msg-empty-view-name");
      if (INVALID_VIEW_NAME.test(name)) return t("plugins.bases.msg-invalid-view-name") + INVALID_VIEW_NAME_CHARS;
      return query.views.some(other => other !== view && other.name === name) ? t("plugins.bases.msg-duplicate-view-name") : "";
    };
    input.addEventListener("input", () => { name = input.value.trim(); error = validate(); input.classList.toggle("mod-error", !!error); if (error) input.setAttribute("aria-label", error); else input.removeAttribute("aria-label"); });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = name = view.name; error = ""; input.blur(); }
      else if (event.key === "Enter") { event.preventDefault(); if (error) new Notice(error); else input.blur(); }
    });
    input.addEventListener("blur", () => {
      if ((!this.isNew && view.name === name) || error) return;
      view.name = name;
      if (this.isNew) { query.views.push(view); this.isNew = false; }
      controller.viewName = name;
      query.save();
    });
    if (select) queueMicrotask(() => { input.focus(); input.select(); });

    const layout = inputRow(formEl, t("plugins.bases.label-view-layout"));
    new Combobox(layout.contentEl).setItems(Object.entries(controller.getViewRegistrations()).map(([value, registration]) => ({ value, display: registration.name(), icon: registration.icon })))
      .setValueById(view.type, value => ({ value, display: value, icon: "lucide-file-question" }))
      .onSelect(item => { if (!item) return; view.type = item.value; this.display(); if (!this.isNew) query.save(); });

    const renderOption = (option: ViewOption | ViewOptionGroup, parent: HTMLElement) => {
      if (option.type === "group") {
        const rowEl = div(parent, "input-group-container"); this.controls.set(option, rowEl);
        if (parent.children.length > 1) div(rowEl, "input-group-divider");
        const header = div(div(rowEl, "input-group"), "input-group-header"), icon = iconDiv(header, "collapse-icon is-collapsed", "right-triangle");
        div(header, "input-group-header-text", option.displayName);
        const contentEl = div(rowEl, "input-group-content"); toggle(contentEl, false);
        header.addEventListener("click", event => { event.preventDefault(); const collapsed = icon.classList.toggle("is-collapsed"); toggle(contentEl, !collapsed); });
        for (const item of option.items) renderOption(item, contentEl);
        return;
      }
      const { rowEl, labelEl, contentEl } = inputRow(parent, option.displayName), current = view.get(option.key) ?? option.default;
      const set = (value: unknown) => { if (this.isNew) { if (value == null) delete view.data[option.key]; else view.data[option.key] = value; } else view.set(option.key, value); this.updateHidden(); };
      this.controls.set(option, rowEl);
      if (option.type === "dropdown") {
        const select = el(contentEl, "select", "dropdown");
        for (const [value, label] of Object.entries(option.options ?? {})) { const item = el(select, "option", "", label); item.value = value; }
        select.value = typeof current === "string" ? current : "";
        select.addEventListener("change", () => set(select.value === "" ? null : select.value));
      } else if (option.type === "slider") {
        const slider = el(contentEl, "input", "slider"); slider.type = "range";
        slider.min = String(option.min ?? 0); slider.max = String(option.max ?? 100); slider.step = String(option.step ?? 1);
        slider.value = String(typeof current === "number" ? current : option.default ?? option.min ?? 0);
        const fill = () => slider.style.setProperty("--slider-fill-ratio", String((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min) || 1)));
        fill();
        slider.addEventListener("input", () => { fill(); if (option.instant !== false) set(Number(slider.value)); });
        if (option.instant === false) slider.addEventListener("change", () => set(Number(slider.value)));
      } else if (option.type === "text" || option.type === "file" || option.type === "folder") {
        const text = textInput(contentEl, typeof current === "string" ? current : "", option.placeholder ?? "");
        text.addEventListener("input", () => set(text.value));
        if (option.type !== "text") {
          const suggest = new ViewPathSuggest(controller.app, text, option.type, option.filter); suggest.load();
          this.optionDisposers.push(() => suggest.unload());
        }
      } else if (option.type === "formula") {
        const editor = new FormulaEditor(contentEl, new Formula(typeof current === "string" ? current : ""), { placeholder: option.placeholder, update: formula => set(formula.toString()) });
        this.optionDisposers.push(() => editor.destroy());
        if (labelEl) FormulaEditor.appendHelpIcon(labelEl);
      } else if (option.type === "multitext") {
        renderWidget(contentEl, "multitext", current, { app: controller.app, sourcePath: controller.sourcePath, placeholder: option.placeholder, onChange: set });
      } else if (option.type === "toggle") {
        const box = div(contentEl, `checkbox-container${current === true ? " is-enabled" : ""}`); box.tabIndex = 0;
        const check = el(box, "input"); check.type = "checkbox"; check.tabIndex = -1; check.checked = current === true;
        box.addEventListener("click", event => { event.preventDefault(); const next = !box.classList.contains("is-enabled"); box.classList.toggle("is-enabled", next); check.checked = next; set(next); });
      } else if (option.type === "property") {
        new PropertyCombobox(controller, contentEl, option.filter).setPlaceholder(option.placeholder ?? "").setClearable(true)
          .setProperty(typeof current === "string" && current ? toPropertyId(current) : null).onSelect(item => set(item?.value ?? null));
      }
    };
    for (const option of controller.getViewRegistrations()[view.type]?.options?.(view) ?? []) renderOption(option, formEl);
    this.updateHidden();
  }
  private updateHidden(): void { for (const [option, rowEl] of this.controls) toggle(rowEl, !option.shouldHide?.(this.view)); }
  override onHide(): void { this.optionDisposers.splice(0).forEach(dispose => dispose()); }
  private showActions(event: MouseEvent): void {
    const { view, controller, host } = this, query = controller.query!;
    const menu = new Menu();
    menu.addItem(item => item.setTitle(t("plugins.bases.action-set-default-view")).setIcon("lucide-layers-2").setSection("action").setChecked(query.views.indexOf(view) === 0 ? true : null).onClick(() => {
      if (this.isNew) return;
      arrayMove(query.views, query.views.indexOf(view), 0); query.save();
    }));
    menu.addItem(item => item.setTitle(t("plugins.bases.action-duplicate-view")).setIcon("lucide-files").setSection("action").onClick(() => {
      host.back();
      host.show(new ViewConfigPage(host, controller, view.clone(uniqueName(new Set(query.views.map(other => other.name)), view.name)), true));
    }));
    if (query.views.length > 1 || this.isNew) menu.addItem(item => item.setTitle(t("plugins.bases.action-delete-view")).setIcon("lucide-trash-2").setSection("danger").setWarning(true).onClick(() => {
      const index = query.views.indexOf(view);
      if (index >= 0) { query.views.splice(index, 1); controller.viewName = query.views[Math.max(0, Math.min(index - 1, query.views.length - 1))]!.name; }
      host.back(); query.save();
    }));
    menu.showAtMouseEvent(event);
  }
}

type ViewItem = { group: string; config: ViewConfig | null };
class ViewsPage extends MenuPage {
  private readonly search: SearchInput;
  private readonly chooser: Chooser<ViewItem>;
  constructor(host: ToolbarMenu, private readonly controller: BasesController) {
    super(host);
    this.containerEl.classList.add("bases-views-page");
    this.search = new SearchInput(this.containerEl).setClass("mod-raised").setPlaceholder(t("plugins.search.prompt-start-search")).onChange(() => this.renderViews());
    this.chooser = new Chooser<ViewItem>(div(this.containerEl, "bases-toolbar-items"), (item, row) => this.renderItem(item, row), item => {
      if (item.config) { controller.selectView(item.config.name); host.close(); } else this.addView();
    });
  }
  override onShow(): void { this.search.autoSelect(); this.renderViews(); }
  override onKey(event: KeyboardEvent): boolean {
    if (event.key === "ArrowRight" && this.search.inputEl.value === "") { const config = this.chooser.getSelectedValue()?.config; if (config) { this.host.show(new ViewConfigPage(this.host, this.controller, config, false)); return true; } }
    return this.chooser.handleKey(event);
  }
  private renderViews(): void {
    const items: ViewItem[] = this.controller.query!.views.filter(view => matchesQuery(this.search.inputEl.value, view.name)).map(config => ({ config, group: "views" }));
    items.push({ config: null, group: "actions" });
    this.chooser.setSuggestions(items);
  }
  private renderItem(item: ViewItem, row: HTMLElement): void {
    const config = item.config, controller = this.controller;
    row.classList.add("bases-toolbar-menu-item");
    const info = div(row, "bases-toolbar-menu-item-info"), icon = div(info, "bases-toolbar-menu-item-info-icon");
    if (!config) { setIcon(icon, "lucide-plus"); div(info, "bases-toolbar-menu-item-name", t("plugins.bases.button-add-view")); return; }
    setIcon(icon, controller.getViewRegistrations()[config.type]?.icon ?? "lucide-table");
    div(info, "bases-toolbar-menu-item-name", config.name);
    row.classList.toggle("mod-active", controller.viewName === config.name);
    iconDiv(row, "clickable-icon bases-toolbar-menu-item-icon", "lucide-chevron-right").addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.host.show(new ViewConfigPage(this.host, controller, config, false)); });
    dragReorder(icon, row, index => { const query = controller.query!; arrayMove(query.views, query.views.indexOf(config), index); query.save(); this.renderViews(); });
  }
  addView(): void {
    const query = this.controller.query!, base = this.search.inputEl.value.trim() || t("plugins.bases.label-default-view");
    this.host.show(new ViewConfigPage(this.host, this.controller, new ViewConfig(query, "table", uniqueName(new Set(query.views.map(view => view.name)), base)), true));
  }
}

class ViewsMenu {
  readonly toolbarItem: ToolbarItem;
  private page: ViewsPage | null = null;
  constructor(private readonly controller: BasesController, toolbarEl: HTMLElement) {
    const item = this.toolbarItem = new ToolbarItem(toolbarEl, t("plugins.bases.label-views"), "lucide-table"), menu = item.menu;
    menu.setRootPage(() => this.page = new ViewsPage(menu, controller));
    item.addClass("bases-toolbar-views-menu");
    item.button.buttonEl.addEventListener("contextmenu", event => {
      event.preventDefault();
      const config = controller.getViewConfig();
      if (!config) return;
      item.setOpen(true); menu.show(new ViewConfigPage(menu, controller, config, false));
    });
    setIcon(el(item.button.buttonEl, "span", "text-button-icon mod-aux"), "lucide-chevrons-up-down");
  }
  setView(name: string, icon: string): void { this.toolbarItem.button.setText(name).setIcon(icon); }
  promptForAddView(): void { this.toolbarItem.setOpen(true); this.toolbarItem.menu.backToRoot(); this.page?.addView(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Toolbar: results

class ResultsMenu {
  readonly toolbarItem: ToolbarItem;
  resultCount = 0; shownCount = 0;
  constructor(private readonly controller: BasesController, toolbarEl: HTMLElement) {
    const item = this.toolbarItem = new ToolbarItem(toolbarEl, t("plugins.bases.label-results"), "lucide-text-align-start");
    item.addClass("bases-toolbar-results-menu"); item.containerEl.classList.add("bases-toolbar-result-count");
    item.menu.setRootPage(() => this.createPage(item.menu));
  }
  get isLimited(): boolean { return this.shownCount < this.resultCount; }
  updateQuery(config: ViewConfig, count: number): void {
    const limit = config.getLimit();
    this.resultCount = count; this.shownCount = limit > 0 && count > limit ? limit : count;
    this.toolbarItem.button.setText(t("nouns.result-with-count", { count: this.shownCount }));
    this.toolbarItem.button.buttonEl.classList.toggle("is-active", this.isLimited);
  }
  private createPage(host: ToolbarMenu): MenuPage {
    const page = new MenuPage(host, "bases-results-page").setTitle(t("plugins.bases.label-results")), controller = this.controller;
    page.onShow = () => {
      const config = controller.getViewConfig(), view = controller.view, container = page.containerEl;
      // The stack header is re-attached by the host; only the page's own content is rebuilt.
      for (const child of Array.from(container.children)) if (!child.classList.contains("bases-toolbar-menu-container-header")) child.remove();
      if (!config) return;
      const form = div(container, "bases-toolbar-menu-form"), actions = div(div(div(container, "bases-toolbar-section"), "bases-toolbar-items"), "bases-menu-group mod-actions");
      const input = el(inputRow(form, t("plugins.bases.label-limit")).contentEl, "input"); input.type = "number"; input.min = "1"; input.step = "1";
      input.placeholder = t("plugins.bases.placeholder-limit"); input.value = config.getLimit() ? String(config.getLimit()) : "";
      const showAll = new MenuAction(actions).setIcon("lucide-rotate-ccw").onClick(() => { config.setLimit(0); host.close(); });
      const refresh = () => {
        const limit = config.getLimit();
        showAll.setText(limit === 0 ? t("plugins.bases.button-show-all") : t("plugins.bases.button-show-all-count", { count: this.resultCount }));
        showAll.rowEl.classList.toggle("mod-hidden", limit === 0);
      };
      input.addEventListener("input", () => {
        input.classList.remove("mod-error");
        const limit = input.value === "" ? 0 : parseInt(input.value, 10);
        if (Number.isNaN(limit) || limit < 0) input.classList.add("mod-error"); else config.setLimit(limit);
        refresh();
      });
      input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); host.close(); } });
      refresh();
      new MenuAction(actions).setIcon("lucide-copy").setText(t("interface.label-copy")).onClick(() => { host.close(); void view?.copyToClipboard(); });
      new MenuAction(actions).setIcon("lucide-file-down").setText(t("plugins.bases.action-export-c-s-v")).onClick(() => { host.close(); if (view) controller.exportCsv(view, `${config.name}.csv`); });
    };
    return page;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Toolbar: sort and group

class SortRow {
  rowEl!: HTMLElement;
  private wrapperEl!: HTMLElement;
  private propertyCombobox!: PropertyCombobox; private directionCombobox!: Combobox<Direction | "MANUAL">;
  constructor(private readonly controller: BasesController, public property: PropertyId | null, public direction: Direction, private readonly handlers: { save(): void; remove(): void; filter(property: PropertyId): boolean; manual?: { isActive(): boolean; setActive(active: boolean): void } }) {}
  render(container: HTMLElement): this {
    const row = this.rowEl = div(container, "base-toolbar-sort-item"), wrapper = this.wrapperEl = div(row, "metadata-property bases-sort-property-container");
    this.propertyCombobox = new PropertyCombobox(this.controller, wrapper, this.handlers.filter).setProperty(this.property).setPlaceholder(t("plugins.bases.label-property-key"))
      .onSelect(item => { if (!item || this.property === item.value) return; this.property = item.value; this.configure(); this.handlers.save(); this.directionCombobox.focus(); });
    this.propertyCombobox.buttonEl.classList.add("bases-sort-property");
    this.directionCombobox = new Combobox<Direction | "MANUAL">(wrapper).onSelect(item => {
      if (!item) return;
      if (item.value === "MANUAL") { this.handlers.manual?.setActive(true); this.configure(); return; }
      this.handlers.manual?.setActive(false); this.direction = item.value; this.handlers.save();
    });
    this.directionCombobox.buttonEl.classList.add("bases-sort-direction");
    this.configure();
    iconDiv(row, "clickable-icon", "lucide-trash-2").addEventListener("click", () => this.handlers.remove());
    return this;
  }
  update(property: PropertyId | null, direction: Direction): void { this.property = property; this.direction = direction; this.propertyCombobox.setProperty(property); this.configure(); }
  private configure(): void {
    let labels: Record<Direction, string> = { ASC: t("plugins.bases.label-sort-a-z"), DESC: t("plugins.bases.label-sort-z-a") };
    if (this.property) {
      const widget = this.controller.getWidgetForProperty(this.property);
      if (widget === "date" || widget === "datetime") labels = { ASC: t("plugins.bases.label-sort-old-new"), DESC: t("plugins.bases.label-sort-new-old") };
      else if (widget === "number") labels = { ASC: t("plugins.bases.label-sort01"), DESC: t("plugins.bases.label-sort10") };
    }
    const { type, name } = this.property ? parsePropertyId(this.property) : { type: "", name: "" };
    const invalid = type === "formula" && !Object.hasOwn(this.controller.query?.formulas ?? {}, name);
    this.wrapperEl.classList.toggle("mod-error", invalid);
    if (invalid) { setIcon(this.propertyCombobox.iconEl, "lucide-alert-triangle"); toggle(this.propertyCombobox.iconEl, true); this.propertyCombobox.iconEl.setAttribute("aria-label", t("plugins.bases.msg-error-invalid-property")); }
    this.directionCombobox.setItems([{ value: "ASC", display: labels.ASC }, { value: "DESC", display: labels.DESC }, ...(this.handlers.manual ? [{ value: "MANUAL" as const, display: t("plugins.bases.label-sort-manual") }] : [])]).setValueById(this.handlers.manual?.isActive() ? "MANUAL" : this.direction);
  }
  focus(): void { this.propertyCombobox.focus(); }
}

class SortPage extends MenuPage {
  private rows: SortRow[] = [];
  private readonly rowsEl: HTMLElement;
  constructor(host: ToolbarMenu, private readonly controller: BasesController) {
    super(host, "bases-sort-page");
    this.setTitle(t("plugins.bases.label-sort"));
    const section = div(this.containerEl, "bases-toolbar-section bases-sort-container");
    div(section, "bases-toolbar-section-header", t("plugins.bases.label-sort-by"));
    this.rowsEl = div(div(section, "bases-toolbar-section-content"), "bases-toolbar-items");
    new MenuAction(div(this.containerEl, "bases-toolbar-section bases-toolbar-menu-actions")).setIcon("lucide-plus").setText(t("plugins.bases.label-add-sort")).onClick(() => this.addRow(null, "ASC").focus());
  }
  override onShow(): void { this.display(); }
  display(): void {
    // Rows without a property yet are kept so that a refresh does not discard what the user is building.
    const pending = this.rows.filter(row => !row.property), sort = this.controller.getViewConfig()?.getSort() ?? [];
    const shown = this.rows.filter(row => row.property).map(row => ({ property: row.property, direction: row.direction }));
    if (this.rows.length && JSON.stringify(shown) === JSON.stringify(sort.map(item => ({ property: item.property, direction: item.direction })))) return;
    this.rowsEl.replaceChildren(); this.rows = [];
    for (const item of sort) this.addRow(item.property, item.direction);
    for (const row of pending) this.addRow(null, row.direction);
    if (!this.rows.length) this.addRow(null, "ASC");
  }
  private addRow(property: PropertyId | null, direction: Direction): SortRow {
    const row: SortRow = new SortRow(this.controller, property, direction, {
      save: () => this.save(), remove: () => { this.rows.splice(this.rows.indexOf(row), 1); row.rowEl.remove(); this.save(); if (!this.rows.length) this.addRow(null, "ASC"); },
      filter: other => other !== "file.file" && other !== "file.backlinks",
    }).render(this.rowsEl);
    const grip = iconDiv(null, "grip-handle", "grip-vertical");
    row.rowEl.prepend(grip);
    dragReorder(grip, row.rowEl, index => { arrayMove(this.rows, this.rows.indexOf(row), index); this.save(); this.display(); });
    this.rows.push(row);
    return row;
  }
  private save(): void {
    this.controller.getViewConfig()?.setSort(this.rows.filter(row => row.property).map(row => ({ property: row.property!, direction: row.direction })));
  }
}

class SortMenu {
  readonly toolbarItem: ToolbarItem;
  private page: SortPage | null = null;
  private readonly flairEl: HTMLElement;
  constructor(controller: BasesController, toolbarEl: HTMLElement) {
    const item = this.toolbarItem = new ToolbarItem(toolbarEl, t("plugins.bases.label-sort"), "lucide-arrow-up-down");
    item.addClass("bases-toolbar-sort-menu");
    item.menu.setRootPage(() => this.page = new SortPage(item.menu, controller));
    this.flairEl = el(item.button.buttonEl, "span", "flair toolbar-badge"); toggle(this.flairEl, false);
  }
  updateQuery(config: ViewConfig): void {
    const count = config.getSort().length;
    this.flairEl.textContent = String(count); toggle(this.flairEl, count > 0);
    this.toolbarItem.button.buttonEl.classList.toggle("is-active", count > 0);
    if (this.page?.isShown && !this.page.containerEl.contains(this.page.containerEl.ownerDocument.activeElement)) this.page.display();
  }
}

class GroupPage extends MenuPage {
  private row: SortRow | null = null;
  private readonly rowEl: HTMLElement;
  private readonly listSection: HTMLElement;
  private readonly chooser: Chooser<{ group: string; key?: Value; count?: number; checked?: boolean; name?: string; icon?: string; action?: () => void }>;
  private rows: Array<{ group: string; key: Value; count: number; checked: boolean }> = [];
  private saving = false;
  private removedOrder: unknown[] | null = null;
  constructor(host: ToolbarMenu, private readonly controller: BasesController) {
    super(host, "bases-group-page");
    this.setTitle(t("plugins.bases.label-group"));
    const section = div(this.containerEl, "bases-toolbar-section bases-groupby-container");
    div(section, "bases-toolbar-section-header", t("plugins.bases.label-group-by"));
    this.rowEl = div(div(section, "bases-toolbar-section-content"), "bases-toolbar-items");
    this.listSection = div(this.containerEl, "bases-toolbar-section bases-group-list-container");
    this.chooser = new Chooser(div(this.listSection, "bases-toolbar-items bases-group-list"), (item, row) => {
      row.classList.add("bases-toolbar-menu-item");
      row.addEventListener("mousedown", event => event.preventDefault());
      if (item.group === "actions") {
        const info = div(row, "bases-toolbar-menu-item-info"); iconDiv(info, "bases-toolbar-menu-item-info-icon", item.icon!); div(info, "bases-toolbar-menu-item-name", item.name!); return;
      }
      row.classList.add("bases-group-row"); row.classList.toggle("mod-hidden", !item.checked);
      const handle = iconDiv(row, "grip-handle", "grip-vertical");
      dragReorder(handle, row, index => this.moveRow(item, index));
      const check = el(row, "input"); check.type = "checkbox"; check.checked = !!item.checked;
      const label = div(div(row, "bases-toolbar-menu-item-info"), "bases-toolbar-menu-item-name");
      if (item.key instanceof NullValue) label.textContent = t("plugins.bases.label-group-key-none"); else item.key!.renderTo(label, controller.renderContext);
      div(row, "bases-group-row-count", item.count!.toLocaleString());
    }, item => { if (item.action) item.action(); else { item.checked = !item.checked; this.saveOrder(); this.renderRows(); } }, ["rows", "actions"]);
  }
  override onShow(): void { this.display(); }
  display(): void {
    const config = this.controller.getViewConfig(), groupBy = config?.groupBy ?? null;
    if (!this.row) {
      const row: SortRow = this.row = new SortRow(this.controller, groupBy?.property ?? null, groupBy?.direction ?? "ASC", {
        save: () => { if (row.property) this.controller.getViewConfig()?.setGroupBy({ property: row.property, direction: row.direction }); },
        remove: () => { this.controller.getViewConfig()?.setGroupBy(null); row.update(null, "ASC"); },
        filter: property => this.controller.canGroupBy(property),
        manual: { isActive: () => !!this.controller.getViewConfig()?.groupOrder, setActive: active => {
          const current = this.controller.getViewConfig();
          if (!current || !row.property) return;
          if (active) { current.setGroupBy({ property: row.property, direction: row.direction }); current.setGroupOrder(this.removedOrder ?? []); }
          else { this.removedOrder = current.groupOrder?.slice() ?? null; current.setGroupOrder(null); }
        } },
      }).render(this.rowEl);
    } else this.row.update(groupBy?.property ?? null, groupBy?.direction ?? "ASC");
    const manual = !!config?.groupOrder;
    toggle(this.listSection, manual);
    if (!this.saving) this.rows = manual ? this.controller.getAllGroups().map(group => ({ group: "rows", key: group.key, count: group.count, checked: group.isVisible })) : [];
    this.renderRows();
  }
  private renderRows(): void {
    if (!this.controller.getViewConfig()?.groupOrder) { this.chooser.setSuggestions([]); return; }
    const visible = this.rows.some(row => row.checked);
    this.chooser.setSuggestions([...this.rows,
      { group: "actions", name: t("plugins.bases.action-add-group"), icon: "lucide-plus", action: () => this.addGroup() },
      { group: "actions", name: t(visible ? "plugins.bases.action-hide-all" : "plugins.bases.button-show-all"), icon: visible ? "lucide-eye-off" : "lucide-eye", action: () => { this.rows.forEach(row => row.checked = !visible); this.saveOrder(); this.renderRows(); } },
    ]);
  }
  private saveOrder(): void {
    this.saving = true;
    try { this.controller.getViewConfig()?.setGroupOrder(this.rows.filter(row => row.checked).map(row => row.key instanceof NullValue ? null : row.key instanceof NumberValue ? row.key.value : "value" in row.key ? (row.key as { value: unknown }).value : row.key.toString())); }
    finally { this.saving = false; }
  }
  private moveRow(item: { key?: Value }, index: number): void {
    const from = this.rows.findIndex(row => row.key === item.key); if (from < 0) return;
    arrayMove(this.rows, from, Math.min(index, this.rows.length - 1)); this.saveOrder(); this.renderRows();
  }
  override onKey(event: KeyboardEvent): boolean {
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const item = this.chooser.getSelectedValue();
      if (item?.key && item.checked) { const index = this.rows.findIndex(row => row.key === item.key); this.moveRow(item, Math.max(0, index + (event.key === "ArrowUp" ? -1 : 1))); this.chooser.setSelectedItem(this.rows.findIndex(row => row.key === item.key)); }
      return true;
    }
    return this.chooser.handleKey(event);
  }
  private addGroup(): void {
    const row = div(this.chooser.getGroupEl("rows")!, "bases-toolbar-menu-item bases-group-row is-editing");
    iconDiv(row, "grip-handle", "grip-vertical"); const check = el(row, "input"); check.type = "checkbox"; check.checked = true;
    const valueEl = div(div(div(row, "bases-toolbar-menu-item-info"), "metadata-property bases-group-add-line"), "metadata-property-value");
    div(row, "bases-group-row-count");
    const property = this.controller.getViewConfig()?.groupBy?.property;
    const type = property ? this.controller.getWidgetForProperty(property) : "text";
    valueEl.dataset.propertyType = type;
    const add = (value: unknown) => {
      if (value == null || value === "") return;
      const key = (type === "date" || type === "datetime") && typeof value === "string" ? new DateValue(new Date(value), type === "datetime") : wrapValue(value);
      const existing = this.rows.find(item => Value.looseEquals(item.key, key));
      if (existing) existing.checked = true; else this.rows.push({ group: "rows", key, count: 0, checked: true });
      this.saveOrder(); this.renderRows();
    };
    if (type === "text") {
      const input = textInput(valueEl, "", t("properties.label-no-value")); input.className = "metadata-input metadata-input-text";
      input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); add(input.value); } else if (event.key === "Escape") { event.stopPropagation(); row.remove(); } });
      input.addEventListener("blur", () => { if (input.value) add(input.value); else row.remove(); }); input.focus();
    } else renderWidget(valueEl, type, null, { app: this.controller.app, sourcePath: this.controller.sourcePath, onChange: add }).focus();
  }
}
class GroupMenu {
  readonly toolbarItem: ToolbarItem;
  private page: GroupPage | null = null;
  constructor(controller: BasesController, toolbarEl: HTMLElement) {
    const item = this.toolbarItem = new ToolbarItem(toolbarEl, t("plugins.bases.label-group"), "lucide-stretch-horizontal");
    item.addClass("bases-toolbar-group-menu");
    item.menu.setRootPage(() => this.page = new GroupPage(item.menu, controller));
  }
  updateQuery(config: ViewConfig): void {
    this.toolbarItem.button.buttonEl.classList.toggle("is-active", !!config.groupBy);
    if (this.page?.isShown) this.page.display();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Toolbar: filters

interface OperatorItem extends ComboItem { fn?: FormulaFunction; inverse?: boolean }
const COMPARISONS = ["==", "!=", "<", ">", "<=", ">="];

/** Reads a property id back out of the left-hand side of a simple filter; throws when it is something else. */
function propertyFromNode(node: Node | null): PropertyId {
  if (node?.type === "object_access" && node.object.type === "ident" && ["note", "formula", "file"].includes(node.object.id)) return `${node.object.id}.${node.index}`;
  if (node?.type === "array_access" && node.array.type === "ident" && ["note", "formula", "file"].includes(node.array.id) && node.index.type === "primitive" && typeof node.index.value === "string") return `${node.array.id}.${node.index.value}`;
  if (node?.type === "ident" && !["true", "false", "null", "this"].includes(node.id)) return toPropertyId(node.id);
  throw new Error(t("obsen.bases.error-formula-deserialize"));
}
function literalFromNodes(nodes: Node[]): unknown {
  const link = (node: Node): string | null => node.type === "call" && !node.subject && node.name === "link" && node.args[0]?.type === "primitive"
    ? `[[${node.args[0].value}${node.args[1]?.type === "primitive" ? `|${node.args[1].value}` : ""}]]` : null;
  const single = (node: Node): unknown => {
    if (node.type === "primitive") return node.value;
    const linked = link(node);
    if (linked) return linked;
    throw new Error(t("obsen.bases.error-formula-deserialize"));
  };
  if (nodes.length === 0) return "";
  if (nodes.length > 1) return nodes.map(node => String(single(node)));
  const node = nodes[0]!;
  return node.type === "array" ? node.elements.map(element => String(single(element))) : single(node);
}
function quoteLiteral(value: unknown): string {
  if (typeof value === "string") {
    if (value.startsWith("[[") && value.endsWith("]]")) { const bar = value.indexOf("|"); return bar >= 0 ? `link(${JSON.stringify(value.slice(2, bar))}, ${JSON.stringify(value.slice(bar + 1, -2))})` : `link(${JSON.stringify(value.slice(2, -2))})`; }
    return JSON.stringify(value);
  }
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

abstract class FilterNodeView {
  abstract containerEl: HTMLElement;
  constructor(readonly editor: FilterBuilder, public parent: FilterGroupView | null) {}
  abstract serialize(): unknown;
  static from(filter: Filter | null, editor: FilterBuilder, parent: FilterGroupView | null): FilterNodeView {
    if (filter instanceof FilterGroup) return new FilterGroupView(filter.conjunction, filter.filters, editor, parent);
    if (!parent) return new FilterGroupView("and", filter ? [filter] : [], editor, null);
    return new FilterStatementView(filter, editor, parent);
  }
}

class FilterGroupView extends FilterNodeView {
  readonly containerEl: HTMLElement;
  private children: FilterNodeView[];
  private readonly listEl: HTMLElement;
  constructor(private conjunction: Conjunction, filters: Filter[], editor: FilterBuilder, parent: FilterGroupView | null) {
    super(editor, parent);
    this.children = filters.length ? filters.map(filter => FilterNodeView.from(filter, editor, this)) : [new FilterStatementView(null, editor, this)];
    const container = this.containerEl = div(null, "filter-group"), header = div(container, "filter-group-header");
    const select = el(header, "select", "conjunction dropdown");
    for (const [value, label] of [["and", t("plugins.bases.label-all-the-following")], ["or", t("plugins.bases.label-any-of-the-following")], ["not", t("plugins.bases.label-none-of-the-following")]] as const) { const option = el(select, "option", "", label); option.value = value; }
    select.value = conjunction;
    select.addEventListener("change", () => { this.conjunction = select.value as Conjunction; this.renderChildren(); if (this.children.at(-1)?.serialize()) editor.save(); });
    const actions = div(header, "filter-group-header-actions");
    if (parent) iconDiv(actions, "clickable-icon", "lucide-trash-2", "button").addEventListener("click", () => parent.removeChild(this));
    this.listEl = div(container, "filter-group-statements");
    this.renderChildren();
    const footer = div(container, "filter-group-actions");
    new TextIconButton(footer).setIcon("lucide-plus").setText(t("plugins.bases.button-add-filter")).onClick(() => { const child = new FilterStatementView(null, editor, this); this.children.push(child); this.renderChildren(); child.focus(); });
    new TextIconButton(footer).setIcon("lucide-plus").setText(t("plugins.bases.button-add-filter-group")).onClick(() => { this.children.push(new FilterGroupView("and", [], editor, this)); this.renderChildren(); });
  }
  private renderChildren(): void {
    this.listEl.replaceChildren();
    this.children.forEach((child, index) => {
      const row = div(this.listEl, "filter-row");
      el(row, "span", "conjunction", index === 0 ? t("plugins.bases.label-where") : this.conjunction === "and" ? t("plugins.bases.label-and") : t("plugins.bases.label-or"));
      if (child instanceof FilterGroupView) row.classList.add("mod-group");
      row.append(child.containerEl);
    });
  }
  removeChild(child: FilterNodeView): void {
    this.children.splice(this.children.indexOf(child), 1);
    if (this.children.length) { this.renderChildren(); this.editor.save(); }
    else if (this.parent) this.parent.removeChild(this);
    else this.editor.reset();
  }
  serialize(): Record<string, unknown> | null {
    const filters = this.children.map(child => child.serialize()).filter(Boolean);
    return filters.length ? { [this.conjunction]: filters } : null;
  }
}

class FilterStatementView extends FilterNodeView {
  readonly containerEl: HTMLElement;
  private readonly property: PropertyCombobox; private readonly operator: Combobox<string, OperatorItem>;
  private readonly rhsEl: HTMLElement; private readonly advancedEl: HTMLElement; private readonly errorEl: HTMLElement; private readonly modeButton: HTMLElement;
  private rhsWidget: Widget | null = null; private rhsValue: unknown = null;
  private advanced = false; private advancedText = ""; private advancedEditor: FormulaEditor | null = null;
  constructor(filter: Filter | null, editor: FilterBuilder, parent: FilterGroupView) {
    super(editor, parent);
    const container = this.containerEl = div(null, "filter-statement"), expression = div(container, "filter-expression metadata-property");
    this.property = new PropertyCombobox(editor.controller, expression, property => property !== "note.tags" && property !== "file.backlinks").setPlaceholder(t("plugins.bases.label-property-key")).onSelect(() => {
      const operators = this.updateOperators(), current = this.operator.selected;
      if (!current || !operators.some(item => item.value === current.value)) { this.rhsValue = null; this.operator.setValue(operators[0] ?? null); }
      this.renderRhs(); this.operator.focus(); this.update();
    });
    this.property.buttonEl.classList.add("filter-property-select");
    this.operator = new Combobox<string, OperatorItem>(expression).onSelect(() => { this.renderRhs(); this.update(); this.rhsWidget?.focus(); });
    this.operator.buttonEl.classList.add("filter-operator");
    this.rhsEl = div(expression, "filter-rhs-container metadata-property-value");
    this.advancedEl = div(expression, "formula-editor-container node-insert-event"); div(this.advancedEl, "formula-editor"); toggle(this.advancedEl, false);
    const actions = div(expression, "filter-row-actions");
    this.errorEl = div(container, "filter-row-error"); toggle(this.errorEl, false);
    this.modeButton = el(actions, "button", "clickable-icon filer-expression-mode-toggle");
    this.modeButton.addEventListener("click", () => {
      const text = this.serialize();
      if (!this.advanced) { this.advanced = true; this.advancedText = text; this.reconcile(); return; }
      if (!text) { this.load(null); return; }
      const formula = new Formula(text);
      if (formula.isInvalid) { new Notice(t("plugins.bases.msg-filter-cannot-parse")); this.setError(formula.errorMessage); return; }
      this.load(formula);
      if (this.advanced) new Notice(t("plugins.bases.msg-filter-simple-unavailable"));
    });
    const remove = iconDiv(actions, "clickable-icon", "trash-2", "button"); remove.setAttribute("aria-label", t("plugins.bases.tooltip-remove-filter"));
    remove.addEventListener("click", () => parent.removeChild(this));
    this.load(filter instanceof FilterRule ? filter.rule : null);
  }
  focus(): void { if (this.advanced) this.advancedEditor?.editor.focus(); else this.property.focus(); }
  private propertyId(): PropertyId { return this.property.selected?.value ?? ""; }
  private lhsValue(): Value { return this.editor.controller.mockContext.evaluateIdent(propertyExpression(this.propertyId())); }
  private updateOperators(): OperatorItem[] {
    const value = this.lhsValue(), items: OperatorItem[] = [], current = this.operator.selected?.value ?? "";
    let predicates = methodsFor(value).filter(fn => fn.predicate);
    if (!(value instanceof NullValue)) predicates = predicates.filter(fn => fn.params[0]?.type.some(type => value instanceof type));
    if (!(value instanceof FileValue)) {
      const label = (op: string) => { const labels = COMPARISON_LABELS[op]!; const label = (value instanceof NumberValue ? labels.number : value instanceof DateValue ? labels.date : value instanceof ListValue ? labels.list : undefined) ?? labels.text; return typeof label === "function" ? label() : label; };
      items.push({ value: "==", display: label("==") }, { value: "!=", display: label("!=") });
      if (value instanceof NumberValue || value instanceof DateValue || ["<", ">", "<=", ">="].includes(current)) for (const op of ["<", "<=", ">", ">="]) items.push({ value: op, display: label(op) });
    }
    for (const inverse of [false, true]) for (const fn of predicates) {
      const key = fn.name.toLowerCase();
      items.push({ value: (inverse ? "!" : "") + key, display: OPERATOR_LABELS[key]?.[inverse ? 1 : 0]() ?? (inverse ? t("obsen.bases.operator-not", { function: fn.name }) : fn.name), fn, inverse });
    }
    this.operator.setItems(items);
    return items;
  }
  private setOperator(name: string, inverse: boolean): void {
    const wanted = (inverse && !COMPARISONS.includes(name) ? "!" : "") + name.toLowerCase();
    const item = this.operator.getItems().find(candidate => candidate.value === wanted);
    if (!item || (inverse && COMPARISONS.includes(name))) throw new Error(t("obsen.bases.error-unsupported-operator"));
    this.operator.setValue(item);
  }
  private renderRhs(): void {
    const controller = this.editor.controller, selected = this.operator.selected;
    let widget = "text";
    if (!selected) { this.rhsWidget = null; this.rhsEl.replaceChildren(); return; }
    if (COMPARISONS.includes(selected.value)) widget = controller.getWidgetForProperty(this.propertyId());
    else {
      const param = selected.fn?.params[1];
      if (!param) { this.rhsWidget = null; this.rhsValue = null; this.rhsEl.replaceChildren(); return; }
      widget = param.widget ?? (param.variadic ? "multitext" : widgetForValue(sampleFor(param.type[0])));
    }
    if (!["text", "number", "checkbox", "date", "datetime", "multitext", "tags"].includes(widget)) widget = "text";
    if (widget === "multitext" || widget === "tags") { if (!Array.isArray(this.rhsValue)) this.rhsValue = this.rhsValue == null || this.rhsValue === "" ? [] : [String(this.rhsValue)]; }
    else if (Array.isArray(this.rhsValue)) this.rhsValue = this.rhsValue[0] ?? null;
    if (widget === "checkbox" && typeof this.rhsValue !== "boolean") this.rhsValue = false;
    this.rhsEl.dataset.propertyType = widget;
    if (widget === "text") {
      this.rhsEl.replaceChildren();
      const input = textInput(this.rhsEl, this.rhsValue == null ? "" : String(this.rhsValue), t("properties.label-no-value"));
      input.className = "metadata-input metadata-input-text";
      input.addEventListener("input", () => { this.rhsValue = input.value; this.update(); });
      this.rhsWidget = { type: "text", focus: () => input.focus() };
      return;
    }
    this.rhsWidget = renderWidget(this.rhsEl, widget, this.rhsValue, { app: controller.app, sourcePath: controller.sourcePath, onChange: value => { this.rhsValue = value; this.update(); } });
  }
  /** Shows a parsed filter in the simple builder when it has a property-operator-value shape, otherwise as text. */
  private load(formula: Formula | null): void {
    this.advanced = false;
    if (!formula) {
      this.rhsValue = null;
      this.property.setProperty("file.file");
      this.operator.setValue(this.updateOperators()[0] ?? null);
      this.renderRhs(); this.reconcile();
      return;
    }
    let node = formula.node, inverse = false, simple = false;
    if (node.type === "not") { inverse = true; node = node.expr; }
    try {
      if (node.type === "compare" && COMPARISONS.includes(node.op)) {
        this.property.setProperty(propertyFromNode(node.left)); this.rhsValue = literalFromNodes([node.right]);
        this.updateOperators(); this.setOperator(node.op, inverse); this.renderRhs(); simple = true;
      } else if (node.type === "call" && node.subject) {
        this.property.setProperty(propertyFromNode(node.subject)); this.rhsValue = literalFromNodes(node.args);
        this.updateOperators(); this.setOperator(node.name, inverse); this.renderRhs(); simple = true;
      } else if (node.type === "invalid") this.setError(formula.errorMessage);
    } catch { simple = false; }
    if (!simple) { this.advanced = true; this.advancedText = formula.toString(); }
    this.reconcile();
  }
  private reconcile(): void {
    toggle(this.advancedEl, this.advanced); toggle(this.property.buttonEl, !this.advanced); toggle(this.operator.buttonEl, !this.advanced); toggle(this.rhsEl, !this.advanced);
    if (this.advanced) {
      this.advancedEl.replaceChildren();
      this.advancedEditor = new FormulaEditor(this.advancedEl, new Formula(this.advancedText), { status: false, placeholder: t("plugins.bases.placeholder-filter-advanced-mode"), update: formula => { this.advancedText = formula.toString(); this.update(); } });
      // The editor brings its own wrapper; the statement only needs the inner editing surface.
      const inner = this.advancedEl.firstElementChild; if (inner) this.advancedEl.replaceChildren(...Array.from(inner.children));
      setIcon(this.modeButton, "mouse-pointer-click"); this.modeButton.setAttribute("aria-label", t("plugins.bases.tooltip-filter-simple-mode"));
    } else {
      this.advancedEditor?.editor.destroy(); this.advancedEditor = null;
      setIcon(this.modeButton, "code-xml"); this.modeButton.setAttribute("aria-label", t("plugins.bases.tooltip-filter-advanced-mode"));
    }
  }
  private setError(message: string): void {
    this.containerEl.classList.toggle("mod-error", !!message);
    this.errorEl.textContent = message; toggle(this.errorEl, !!message);
    if (message) setIcon(this.modeButton, "lucide-circle-alert"); else if (this.advanced) setIcon(this.modeButton, "mouse-pointer-click");
  }
  private update(): void {
    this.setError("");
    if (!this.advanced && this.rhsWidget && (this.rhsValue === null || this.rhsValue === "" || (Array.isArray(this.rhsValue) && !this.rhsValue.length))) return;
    const formula = new Formula(this.serialize());
    if (formula.isInvalid && this.advanced && this.advancedText) this.setError(formula.errorMessage);
    this.editor.save();
  }
  serialize(): string {
    if (this.advanced) return this.advancedText;
    const property = this.propertyId(), selected = this.operator.selected;
    if (!property || !selected) return "";
    const subject = propertyExpression(property), value = this.rhsValue;
    if (selected.fn) {
      let call: string;
      if (selected.fn.params.length > 1) {
        if (value === "" || value == null || (Array.isArray(value) && !value.length)) return "";
        call = serializeCall(selected.fn, subject, Array.isArray(value) ? value.map(quoteLiteral) : [quoteLiteral(value)]);
      } else call = serializeCall(selected.fn, subject, []);
      return selected.inverse ? `!${call}` : call;
    }
    return COMPARISONS.includes(selected.value) && value != null && value !== "" ? `${subject} ${selected.value} ${quoteLiteral(value)}` : "";
  }
}
function sampleFor(type: unknown): Value {
  for (const sample of [sampleForWidget("text"), sampleForWidget("number"), sampleForWidget("checkbox"), sampleForWidget("date"), sampleForWidget("multitext")]) if (typeof type === "function" && sample instanceof (type as abstract new () => Value)) return sample;
  return NullValue.value;
}

/** The nested and/or/not editor for one filter (the view's or the whole base's). */
class FilterBuilder {
  private readonly innerEl: HTMLElement;
  private root: FilterNodeView | null = null;
  private saveFn: ((raw: unknown) => void) | null = null;
  constructor(readonly controller: BasesController, parent: HTMLElement) { this.innerEl = div(parent, "bases-query-container"); }
  save(): void { this.saveFn?.(this.root?.serialize() ?? null); }
  reset(): void { this.root = FilterNodeView.from(null, this, null); this.innerEl.replaceChildren(this.root.containerEl); this.save(); }
  updateQuery(save: (raw: unknown) => void, filter: Filter | null): void {
    this.saveFn = save;
    const current = this.root?.serialize() ?? null, next = filter?.serialize() ?? null;
    // Wrapping a lone rule in an "and" group is a display detail, not a difference.
    const normalize = (raw: unknown) => typeof raw === "string" ? { and: [raw] } : raw;
    if (this.root && JSON.stringify(normalize(current)) === JSON.stringify(normalize(next))) return;
    if (this.root && this.innerEl.contains(this.innerEl.ownerDocument.activeElement)) return;
    this.root = FilterNodeView.from(filter, this, null);
    this.innerEl.replaceChildren(this.root.containerEl);
  }
}

class FilterMenu {
  readonly toolbarItem: ToolbarItem;
  private readonly toolbarFlairEl: HTMLElement; private globalFlairEl!: HTMLElement; private localFlairEl!: HTMLElement;
  private globalBuilder!: FilterBuilder; private viewBuilder!: FilterBuilder;
  constructor(controller: BasesController, toolbarEl: HTMLElement) {
    const item = this.toolbarItem = new ToolbarItem(toolbarEl, t("plugins.bases.label-filter"), "lucide-list-filter");
    item.addClass("bases-toolbar-filter-menu");
    this.toolbarFlairEl = el(item.button.buttonEl, "span", "flair toolbar-badge"); toggle(this.toolbarFlairEl, false);
    const section = (label: string, collapsed: boolean) => {
      const sectionEl = div(item.menu.scrollEl, "bases-toolbar-section"), header = div(sectionEl, "bases-toolbar-section-header");
      iconDiv(header, "tree-item-icon collapse-icon", "right-triangle");
      el(header, "span", "", label);
      const flair = el(header, "span", "flair"), content = div(sectionEl, "bases-toolbar-section-content");
      let isCollapsed = collapsed;
      const apply = () => { setCollapsed(header, isCollapsed); toggle(content, !isCollapsed); item.menu.position(); };
      header.addEventListener("click", event => { event.preventDefault(); isCollapsed = !isCollapsed; apply(); });
      apply();
      return { flair, builder: new FilterBuilder(controller, content) };
    };
    ({ flair: this.globalFlairEl, builder: this.globalBuilder } = section(t("plugins.bases.label-all-views"), true));
    ({ flair: this.localFlairEl, builder: this.viewBuilder } = section(t("plugins.bases.label-current-view"), false));
  }
  updateQuery(query: BasesQuery, config: ViewConfig): void {
    this.globalBuilder.updateQuery(raw => query.setGlobalFilters(raw), query.filters ?? null);
    this.viewBuilder.updateQuery(raw => query.setViewFilters(config.name, raw), config.filters ?? null);
    const count = (filter?: Filter) => !filter ? 0 : filter instanceof FilterGroup ? filter.filters.length : 1;
    const show = (flair: HTMLElement, value: number) => { flair.textContent = String(value); toggle(flair, value > 0); };
    const local = count(config.filters);
    show(this.globalFlairEl, count(query.filters)); show(this.localFlairEl, local); show(this.toolbarFlairEl, local);
    const button = this.toolbarItem.button.buttonEl;
    button.classList.toggle("mod-error", !!query.filters?.hasError() || !!config.filters?.hasError());
    button.classList.toggle("is-active", local > 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Toolbar: properties

/** Display name, type and formula of one property (the "Edit property" form). */
class PropertyForm {
  readonly containerEl = div(null, "bases-toolbar-menu-form");
  private handleDelete?: () => void;
  constructor(private readonly controller: BasesController, private propId: PropertyId, isNew: boolean) {
    const query = controller.query!, config = controller.getViewConfig()!, { type } = parsePropertyId(propId);
    let { name } = parsePropertyId(propId);
    const display = inputRow(this.containerEl, isNew ? undefined : t("plugins.bases.label-display-name"));
    const input = textInput(display.contentEl, config.getDisplayName(propId), name);
    queueMicrotask(() => { input.focus(); input.select(); });
    input.addEventListener("blur", () => {
      const value = input.value.trim();
      if (value === config.getDisplayName(this.propId) || (isNew && !value)) return;
      if (!isNew) { query.getPropertyConfig(this.propId).setDisplayName(value || null); return; }
      // A property that was just created is renamed outright rather than given a caption.
      const next = `${type}.${value}`;
      if (type === "formula") { if (Object.hasOwn(query.formulas, value)) { input.value = name; return; } query.renameFormula(name, value); }
      config.setOrder(config.getOrder().map(other => other === this.propId ? next : other));
      this.propId = next; name = value;
    });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = config.getDisplayName(this.propId); input.blur(); }
      else if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    });
    if (type === "note") {
      const row = inputRow(this.containerEl, t("plugins.bases.label-property-type")), select = el(row.contentEl, "select", "dropdown");
      for (const widget of ["text", "multitext", "number", "checkbox", "date", "datetime"]) { const option = el(select, "option", "", t(`properties.types.option-${widget}`)); option.value = widget; }
      const current = controller.getPropertyWidget(propId);
      if (!["text", "multitext", "number", "checkbox", "date", "datetime"].includes(current)) { const option = el(select, "option", "", t(`properties.types.option-${current === "tags" || current === "aliases" ? current : "unknown"}`)); option.value = current; select.disabled = true; }
      select.value = current;
      select.addEventListener("change", () => controller.setPropertyWidget(name, select.value));
    } else if (type === "formula") {
      const row = inputRow(this.containerEl, t("plugins.bases.label-formula"));
      FormulaEditor.appendHelpIcon(row.labelEl!);
      new FormulaEditor(row.contentEl, query.formulas[name] ?? null, { update: formula => query.setFormulas({ ...query.formulas, [parsePropertyId(this.propId).name]: formula }) });
    }
  }
  onDelete(callback: () => void): this { this.handleDelete = callback; return this; }
  showActions(event: MouseEvent): void {
    const controller = this.controller, query = controller.query!, config = controller.getViewConfig()!, propId = this.propId, { type, name } = parsePropertyId(propId), shown = config.getOrder().includes(propId);
    const menu = new Menu();
    menu.addItem(item => item.setTitle(shown ? t("plugins.bases.label-hide-property") : t("plugins.bases.label-show-property")).setSection("action").setIcon("lucide-eye-off").onClick(() => {
      const order = config.getOrder();
      config.setOrder(order.includes(propId) ? order.filter(other => other !== propId) : [...order, propId]);
    }));
    if (type === "formula") menu.addItem(item => item.setTitle(t("plugins.bases.action-delete-formula")).setSection("danger").setIcon("lucide-trash-2").setWarning(true).onClick(() => { query.removeFormula(name); this.handleDelete?.(); }));
    menu.showAtMouseEvent(event);
  }
}
class EditPropertyPage extends MenuPage {
  constructor(host: ToolbarMenu, controller: BasesController, propId: PropertyId, isNew = false) {
    super(host);
    this.setTitle(isNew ? t("plugins.bases.label-edit-property") : t("plugins.bases.title-edit-property", { name: parsePropertyId(propId).name }));
    const form = new PropertyForm(controller, propId, isNew).onDelete(() => host.back());
    this.addAction("lucide-more-vertical", event => form.showActions(event));
    this.containerEl.append(form.containerEl);
  }
}

type PropertyRow = { group: string; type: "property"; propId: PropertyId } | { group: string; type: "action"; name: string; icon: string; callback(): void };
class PropertiesPage extends MenuPage {
  private query = "";
  private readonly search: SearchInput;
  private readonly chooser: Chooser<PropertyRow>;
  constructor(host: ToolbarMenu, private readonly controller: BasesController) {
    super(host);
    this.setTitle(t("plugins.bases.label-properties"));
    this.containerEl.classList.add("bases-properties-page");
    this.search = new SearchInput(this.containerEl).setClass("mod-raised").setPlaceholder(t("plugins.bases.placeholder-search-property")).onChange(value => { this.query = value; this.renderProperties(); });
    this.search.inputEl.addEventListener("focus", () => this.containerEl.classList.add("has-input-focus"));
    this.search.inputEl.addEventListener("blur", () => this.containerEl.classList.remove("has-input-focus"));
    this.chooser = new Chooser<PropertyRow>(div(this.containerEl, "bases-toolbar-items"), (item, row) => this.renderItem(item, row), item => {
      if (item.type === "action") { item.callback(); return; }
      this.toggleVisibility(item.propId);
      const row = this.chooser.getSelectedElement();
      if (row) { row.replaceChildren(); this.renderItem(item, row); }
    });
  }
  override onShow(): void { this.search.autoSelect(); this.renderProperties(); }
  override onKey(event: KeyboardEvent): boolean {
    const selected = this.chooser.getSelectedValue();
    if (event.key === "ArrowRight" && this.search.inputEl.value === "" && selected?.type === "property") { this.showEditPage(selected.propId); return true; }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && selected?.type === "property") {
      const config = this.controller.getViewConfig()!, order = config.getOrder(), index = order.indexOf(selected.propId);
      if (index >= 0) { arrayMove(order, index, index + (event.key === "ArrowUp" ? -1 : 1)); config.setOrder(order); this.renderProperties(); this.chooser.setSelectedItem(this.chooser.values.findIndex(item => item.type === "property" && item.propId === selected.propId)); }
      return true;
    }
    return this.chooser.handleKey(event);
  }
  private showEditPage(propId: PropertyId, isNew = false): void { this.host.show(new EditPropertyPage(this.host, this.controller, propId, isNew)); }
  private toggleVisibility(propId: PropertyId): void {
    const config = this.controller.getViewConfig()!, order = config.getOrder();
    config.setOrder(order.includes(propId) ? order.filter(other => other !== propId) : [...order, propId]);
  }
  renderProperties(): void {
    const controller = this.controller, config = controller.getViewConfig();
    if (!config) return;
    const order = config.getOrder(), query = this.query.trim(), known = controller.getAllNoteProperties();
    const properties = controller.getProperties().filter(property => property !== "file.file");
    if (query) for (const name of known.values()) if (!properties.includes(`note.${name}`)) properties.push(`note.${name}`);
    for (const property of order) if (!properties.includes(property)) properties.push(property);
    const position = new Map(order.map((property, index) => [property, index]));
    properties.sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity) || a.localeCompare(b));
    const items: PropertyRow[] = properties.filter(property => matchesQuery(query, config.getDisplayName(property), parsePropertyId(property).name)).map(propId => ({ type: "property", propId, group: "properties" }));
    if (query && !known.has(query.toLowerCase())) items.push({ type: "action", group: "actions", name: t("plugins.bases.action-add-property", { name: query }), icon: "lucide-plus", callback: () => {
      const propId = `note.${query}`;
      if (!config.getOrder().includes(propId)) config.setOrder([...config.getOrder(), propId]);
      this.showEditPage(propId, true);
    } });
    items.push({ type: "action", group: "actions", name: t("plugins.bases.action-add-formula"), icon: "lucide-square-function", callback: () => {
      const base = controller.query!, name = uniqueName(new Set(Object.keys(base.formulas)), query || t("plugins.bases.label-untitled-property")), propId = `formula.${name}`;
      base.formulas = { ...base.formulas, [name]: new Formula("") };
      config.setOrder([...config.getOrder(), propId]);
      this.showEditPage(propId, true);
    } });
    items.push({ type: "action", group: "actions", name: t("plugins.bases.action-hide-all"), icon: "lucide-eye-off", callback: () => { config.setOrder([]); this.renderProperties(); } });
    this.chooser.setSuggestions(items);
  }
  private renderItem(item: PropertyRow, row: HTMLElement): void {
    const controller = this.controller, config = controller.getViewConfig()!;
    row.classList.add("bases-toolbar-menu-item");
    row.addEventListener("mousedown", event => event.preventDefault());
    const info = div(row, "bases-toolbar-menu-item-info"), icon = div(info, "bases-toolbar-menu-item-info-icon");
    if (item.type === "action") { setIcon(icon, item.icon); div(info, "bases-toolbar-menu-item-name", item.name); return; }
    const propId = item.propId, { type, name } = parsePropertyId(propId), checkbox = el(null, "input"); checkbox.type = "checkbox";
    row.prepend(checkbox);
    if (type === "note") setIcon(icon, WIDGET_ICONS[controller.getPropertyWidget(propId)] ?? "lucide-text");
    else if (type === "formula") {
      setIcon(icon, "lucide-square-function");
      const formula = controller.query!.formulas[name];
      icon.classList.toggle("mod-error", !!formula?.isInvalid);
      if (formula?.isInvalid) icon.setAttribute("aria-label", formula.errorMessage);
    } else setIcon(icon, "lucide-info");
    row.classList.toggle("mod-implicit", type === "file"); row.classList.toggle("mod-formula", type === "formula");
    div(info, "bases-toolbar-menu-item-name", config.getDisplayName(propId));
    const visible = config.getOrder().includes(propId);
    row.classList.toggle("mod-hidden", !visible); checkbox.checked = visible;
    iconDiv(row, "clickable-icon bases-toolbar-menu-item-icon", "lucide-chevron-right").addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.showEditPage(propId); });
    if (visible) dragReorder(icon, row, index => { const order = config.getOrder(); arrayMove(order, order.indexOf(propId), index); config.setOrder(order); this.renderProperties(); });
  }
}
class PropertiesMenu {
  readonly toolbarItem: ToolbarItem;
  private page: PropertiesPage | null = null;
  constructor(controller: BasesController, toolbarEl: HTMLElement) {
    const item = this.toolbarItem = new ToolbarItem(toolbarEl, t("plugins.bases.label-properties"), "list");
    item.menu.setRootPage(() => this.page = new PropertiesPage(item.menu, controller));
    item.addClass("bases-toolbar-properties-menu");
  }
  updateQuery(hasError: boolean): void { this.toolbarItem.button.buttonEl.classList.toggle("mod-error", hasError); if (this.page?.isShown && !this.page.containerEl.contains(this.page.containerEl.ownerDocument.activeElement)) this.page.renderProperties(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Toolbar: search and new item

class SearchMenu {
  private open = false;
  private readonly button: TextIconButton; private readonly inputEl: HTMLInputElement; private readonly countEl: HTMLElement;
  private readonly update: ReturnType<typeof debounced>;
  constructor(private readonly controller: BasesController, toolbarEl: HTMLElement, private readonly searchBarEl: HTMLElement) {
    toggle(searchBarEl, false);
    this.button = new TextIconButton(div(toolbarEl, "bases-toolbar-item bases-toolbar-search")).setIcon("lucide-search").setText(t("plugins.bases.label-search")).onClick(() => this.open ? this.close() : this.show());
    const search = new SearchInput(searchBarEl).setClass("document-search-input").setPlaceholder(t("editor.search.placeholder-find"));
    this.inputEl = search.inputEl;
    this.countEl = div(search.containerEl, "document-search-count"); toggle(this.countEl, false);
    this.update = debounced(() => { toggle(this.countEl, !!this.inputEl.value); controller.updateSearchQuery(this.inputEl.value); }, 100);
    search.onChange(() => this.update());
    this.inputEl.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); } });
  }
  show(): void {
    this.inputEl.value = this.controller.getSearchQuery() ?? "";
    if (!this.open) { this.open = true; this.button.buttonEl.classList.add("is-active"); toggle(this.searchBarEl, true); }
    this.inputEl.focus({ preventScroll: true }); this.inputEl.select();
  }
  close(): void {
    if (!this.open) return;
    this.open = false; this.update.cancel();
    this.button.buttonEl.classList.remove("is-active"); toggle(this.searchBarEl, false); toggle(this.countEl, false);
    this.controller.updateSearchQuery(null);
  }
  updateCount(count: number): void { this.countEl.textContent = t("plugins.bases.label-search-results", { count }); }
}

/** One page of built-in and custom summaries for a column. */
class SummaryEditorPage extends MenuPage {
  private editor: FormulaEditor;
  private deleted = false;
  constructor(host: ToolbarMenu, private readonly query: BasesQuery, private name: string) {
    super(host); this.setTitle(t("plugins.bases.title-edit-property", { name }));
    this.addAction("lucide-more-vertical", event => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle(t("plugins.bases.action-delete-summary")).setSection("danger").setWarning(true).onClick(() => { this.deleted = true; query.deleteSummaryFormula(this.name); host.back(); }));
      menu.showAtMouseEvent(event);
    });
    const form = div(this.containerEl, "bases-toolbar-menu-form"), input = textInput(inputRow(form, t("plugins.bases.label-summary-name")).contentEl, name, name);
    input.addEventListener("blur", () => { const next = input.value.trim(); if (next !== this.name) { query.renameSummaryFormula(this.name, next); this.name = next; } });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.value = this.name; input.blur(); }
      else if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    });
    const formula = inputRow(form, t("plugins.bases.label-formula"));
    FormulaEditor.appendHelpIcon(formula.labelEl!);
    this.editor = new FormulaEditor(formula.contentEl, query.summaryFormulas?.[name] ?? null, { placeholder: "values.reduce( ... )", update: value => { if (!this.deleted) query.setSummaryFormula(this.name, value); } });
    queueMicrotask(() => { input.focus(); input.select(); });
  }
  override onHide(): void { this.editor.destroy(); }
}

class SummaryPage extends MenuPage {
  constructor(host: ToolbarMenu, controller: BasesController, config: ViewConfig, property: PropertyId, values: Value[]) {
    super(host);
    const search = new SearchInput(this.containerEl).setPlaceholder(t("plugins.bases.placeholder-search-property"));
    type Row = { group: string; name: string | null; formula?: Formula; icon?: string; action?: () => void };
    const query = controller.query!, sample = values.find(value => !(value instanceof NullValue)) ?? null, ctx = summaryContext(controller.app, values);
    const chooser = new Chooser<Row>(div(this.containerEl, "bases-toolbar-items"), (item, row) => {
      row.classList.add("bases-toolbar-menu-item", "bases-summary-menu-item");
      const info = div(row, "bases-toolbar-menu-item-info"), icon = div(info, "bases-toolbar-menu-item-info-icon");
      if (!item.formula) { setIcon(icon, item.icon!); div(info, "bases-toolbar-menu-item-name", item.name!); return; }
      row.classList.toggle("mod-active", config.getSummaryKey(property) === item.name);
      div(info, "bases-toolbar-menu-item-name", item.name! in (query.summaryFormulas ?? {}) ? item.name! : summaryLabel(item.name!));
      const value = item.formula.getValue(ctx);
      setIcon(icon, value instanceof NullValue ? "lucide-square-function" : value.icon);
      if (!(value instanceof NullValue)) div(info, "bases-toolbar-menu-item-value", value instanceof NumberValue ? value.value.toLocaleString() : value.toString());
      iconDiv(row, "clickable-icon bases-toolbar-menu-item-icon", "lucide-chevron-right").addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if (!Object.hasOwn(query.summaryFormulas ?? {}, item.name!)) query.setSummaryFormula(item.name!, item.formula!);
        host.show(new SummaryEditorPage(host, query, item.name!));
      });
    }, item => { if (item.action) item.action(); else { config.setSummaryKey(property, item.name); host.close(); } });
    const render = () => {
      const formulas: Record<string, Formula> = Object.fromEntries(Object.entries(defaultSummaries(sample)).map(([name, text]) => [name, new Formula(text)]));
      Object.assign(formulas, query.summaryFormulas ?? {});
      const rows: Row[] = Object.keys(formulas).sort((a, b) => a.localeCompare(b)).filter(name => matchesQuery(search.inputEl.value, name in (query.summaryFormulas ?? {}) ? name : summaryLabel(name))).map(name => ({ group: "formulas", name, formula: formulas[name]! }));
      const draft = search.inputEl.value.trim(), creating = !!draft && !Object.hasOwn(formulas, draft);
      rows.push({ group: "actions", name: creating ? t("plugins.bases.action-add-summary", { name: draft }) : t("plugins.bases.button-add-summary"), icon: creating ? "lucide-plus" : "lucide-square-function", action: () => {
        const name = creating ? draft : uniqueName(new Set(Object.keys(formulas)), t("obsen.bases.new-summary-name"));
        if (creating) query.setSummaryFormula(name, new Formula(""));
        config.setSummaryKey(property, name); host.show(new SummaryEditorPage(host, query, name));
      } });
      if (config.getSummaryKey(property) !== null) rows.push({ group: "actions", name: t("plugins.bases.button-hide-summary"), icon: "lucide-trash-2", action: () => { config.setSummaryKey(property, null); host.close(); } });
      chooser.setSuggestions(rows);
    };
    search.onChange(render);
    this.onShow = () => { search.autoSelect(); render(); };
    this.onKey = event => chooser.handleKey(event);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Controller

/** Owns one rendered base: toolbar, query execution and the active layout. Used by the file view, embeds and code blocks. */
export class BasesController extends QueryController {
  query: BasesQuery | null = null;
  viewName = "";
  view: BasesView | null = null;
  readonly renderContext: RenderContext;
  mockContext: MockContext;
  readonly headerEl: HTMLElement; readonly errorEl: HTMLElement; readonly viewContainerEl: HTMLElement;
  private readonly viewMenu: ViewsMenu; private readonly resultsMenu: ResultsMenu; private readonly sortMenu: SortMenu; private readonly groupMenu: GroupMenu;
  private readonly filterMenu: FilterMenu; private readonly propertyMenu: PropertiesMenu; private readonly searchMenu: SearchMenu; private readonly newItemButton: TextIconButton;
  private results = new Map<TFile, Entry>();
  private errors = new Set<string>();
  private ctx: QueryContext | null = null;
  private queryState = "";
  private searchQuery: string | null = null;
  private error: "query" | "view" | null = null;
  private groupFolds: Record<string, Set<string>> | null = null;
  private relevantProperties = new Map<string, string>();
  private noteWidgets = new Map<string, string>();
  private allNoteProperties: Map<string, string> | null = null;
  private popups: ToolbarMenu[] = [];
  hoverPopover: HoverPopover | null = null;
  private creatingItem = false;
  onViewChanged?: () => void;
  private readonly requestNotify = debounced(() => this.notifyView(), 50);
  private readonly requestRun = debounced(() => { this.queryState = ""; this.update(); }, 250);

  constructor(readonly app: App, readonly containerEl: HTMLElement, private currentFile: TFile | null) {
    super();
    this.renderContext = new RenderContext(app);
    this.mockContext = new MockContext(app, {}, () => ({}));
    this.headerEl = div(containerEl, "bases-header");
    const toolbar = div(this.headerEl, "bases-toolbar");
    this.viewMenu = new ViewsMenu(this, toolbar);
    this.resultsMenu = new ResultsMenu(this, toolbar);
    this.sortMenu = new SortMenu(this, toolbar);
    this.groupMenu = new GroupMenu(this, toolbar);
    this.filterMenu = new FilterMenu(this, toolbar);
    this.propertyMenu = new PropertiesMenu(this, toolbar);
    const searchRow = div(containerEl, "bases-search-row");
    this.searchMenu = new SearchMenu(this, toolbar, searchRow);
    this.newItemButton = new TextIconButton(div(toolbar, "bases-toolbar-item bases-toolbar-new-item-menu")).setIcon("plus").setText(t("plugins.bases.label-new-item")).onClick(() => { void this.openNewItem(); });
    this.errorEl = div(containerEl, "bases-error"); toggle(this.errorEl, false);
    this.viewContainerEl = div(containerEl, "bases-view");
    this.viewContainerEl.addEventListener("keydown", event => {
      if (event.isComposing || !event.key.startsWith("Page") || !(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const names = this.getQueryViewNames(), index = names.indexOf(this.viewName);
      if (names.length < 2) return;
      event.preventDefault();
      this.selectView(names[(index + (event.key === "PageUp" ? names.length - 1 : 1)) % names.length]!);
      this.view?.focus();
    });
  }

  override onload(): void {
    const { metadataCache, vault } = this.app;
    for (const name of ["bases-view-registered", "bases-view-unregistered"]) this.registerEvent(this.app.workspace.on(name, () => this.update()));
    this.registerEvent(metadataCache.on("changed", (file: unknown) => this.onFileChanged(file)));
    this.registerEvent(metadataCache.on("deleted", (file: unknown) => { const known = [...this.results.keys()].find(other => other.path === (file as { path: string }).path); if (known) { this.results.delete(known); this.requestNotify(); } }));
    this.registerEvent(metadataCache.on("resolved", () => { if (this.usesLinkGraph()) this.requestRun(); }));
    this.registerEvent(vault.on("create", () => this.requestRun()));
    this.registerEvent(vault.on("delete", () => this.requestRun()));
    this.registerEvent(vault.on("rename", () => this.requestRun()));
    const observer = new ResizeObserver(() => this.view?.onResize());
    observer.observe(this.viewContainerEl);
    this.register(() => observer.disconnect());
  }
  override onunload(): void {
    this.requestNotify.cancel(); this.requestRun.cancel();
    for (const menu of [this.viewMenu, this.resultsMenu, this.sortMenu, this.groupMenu, this.filterMenu, this.propertyMenu]) menu.toolbarItem.menu.close();
    for (const popup of this.popups.splice(0)) popup.close();
    this.hoverPopover?.hide(); this.hoverPopover = null;
    this.view?.destroy(); this.view = null;
  }

  // ---- query and view selection ----
  get sourcePath(): string { return this.currentFile?.path ?? this.query?.file?.path ?? ""; }
  getCurrentFile(): TFile | null { return this.currentFile; }
  updateCurrentFile(file: TFile | null): void { if (file === this.currentFile) return; this.currentFile = file; this.queryState = ""; if (this.query) this.update(); }
  getQueryViewNames(): string[] { return this.query?.views.map(view => view.name) ?? []; }
  getViewRegistrations(): Record<string, ViewRegistration> { return { ...VIEW_REGISTRY, ...getBasesViewRegistrations(this.app) }; }
  getAllGroups(): Array<{ key: Value; count: number; isVisible: boolean }> {
    const config = this.getViewConfig(); if (!config?.groupBy || !config.groupOrder) return [];
    const allConfig = config.clone(config.name); allConfig.groupOrder = null;
    const all = new ViewData(this.app, allConfig, this.getProperties(), [...this.results.values()]).groupedData;
    const visible = new ViewData(this.app, config, this.getProperties(), [...this.results.values()]).groupedData;
    return [...visible.map(group => ({ key: group.key ?? NullValue.value, count: group.entries.length, isVisible: true })),
      ...all.filter(group => !visible.some(other => Value.looseEquals(group.key ?? NullValue.value, other.key ?? NullValue.value))).map(group => ({ key: group.key ?? NullValue.value, count: group.entries.length, isVisible: false }))];
  }
  getViewConfig(): ViewConfig | null { return this.query?.getViewConfig(this.viewName) ?? null; }
  getDisplayName(property: PropertyId): string { return this.query?.getPropertyConfig(property).getDisplayName() ?? parsePropertyId(property).name; }
  getSearchQuery(): string | null { return this.searchQuery; }
  updateSearchQuery(search: string | null): void { if (this.searchQuery === (search || null)) return; this.searchQuery = search || null; if (this.query) this.requestNotify(); }
  promptForAddView(): void { this.viewMenu.promptForAddView(); }
  selectView(name: string): void {
    if (this.viewName === name) return;
    this.viewName = name;
    if (this.error === "view") this.clearError();
    this.update();
    this.onViewChanged?.();
  }
  /** Shows a parsed query, or the reference's error panel when the source could not be parsed. */
  setQuery(query: BasesQuery | Error, viewName?: string): void {
    this.clearError();
    if (viewName !== undefined) this.viewName = viewName;
    if (query instanceof Error) { this.query = null; this.displayError("query", query); return; }
    if (this.query !== query) { this.query = query; this.groupFolds = null; }
    this.update();
  }
  update(): void {
    const query = this.query;
    if (!query) return;
    if (this.error === "view") this.clearError();
    const config = query.getViewConfig(this.viewName);
    if (!config) { this.displayError("view", new Error(t("plugins.bases.msg-error-view-not-found", { view: this.viewName }))); this.viewMenu.setView(this.viewName, "lucide-file-question"); this.queryState = ""; return; }
    this.viewName = config.name;
    const registration = this.getViewRegistrations()[config.type];
    this.viewMenu.setView(config.name, registration?.icon ?? "lucide-file-question");
    if (config.type !== this.view?.type || !registration) {
      this.view?.destroy(); this.view = null; this.viewContainerEl.replaceChildren();
      if (!registration) { this.displayError("view", new Error(t("plugins.bases.msg-error-unknown-view-type", { viewtype: config.type }))); return; }
      this.view = registration.factory(this, this.viewContainerEl);
    }
    this.view.config = config;
    this.view.load();
    this.viewContainerEl.dataset.viewType = this.view.type; this.viewContainerEl.dataset.viewName = this.viewName;
    this.viewContainerEl.classList.toggle("is-grouped", !!config.groupBy);
    const filter = combineFilters(query.filters, config.filters);
    const state = JSON.stringify({ filter: filter?.serialize() ?? null, formulas: Object.fromEntries(Object.entries(query.formulas).map(([name, formula]) => [name, formula.toString()])), local: this.currentFile?.path ?? null });
    if (state !== this.queryState) { this.queryState = state; this.runQuery(new QueryContext(this.app, filter, query.formulas, this.currentFile)); }
    else this.notifyView();
  }
  private usesLinkGraph(): boolean { return /backlinks|\bthis\b/.test(this.queryState) || !!this.getViewConfig()?.getOrder().includes("file.backlinks"); }
  private test(ctx: QueryContext, file: TFile): Entry | null {
    try { const entry = new Entry(ctx, file); return !ctx.filter || ctx.filter.test(entry) ? entry : null; }
    catch (error) { this.errors.add(t("plugins.bases.msg-error-filter-failed-to-evaluate", { message: (error as Error).message })); return null; }
  }
  private runQuery(ctx: QueryContext): void {
    this.ctx = ctx;
    this.errors.clear(); this.results = new Map(); this.allNoteProperties = null;
    for (const file of this.app.vault.getFiles()) { const entry = this.test(ctx, file); if (entry) this.results.set(file, entry); }
    this.notifyView();
  }
  private onFileChanged(changed: unknown): void {
    const ctx = this.ctx, file = changed instanceof TFile ? changed : this.app.vault.getFileByPath((changed as { path?: string })?.path ?? "");
    if (!ctx || !file || !this.query) return;
    this.allNoteProperties = null;
    if (file === this.currentFile && /\bthis\b/.test(this.queryState)) { this.requestRun(); return; }
    const entry = this.test(ctx, file);
    if (entry) this.results.set(file, entry); else this.results.delete(file);
    this.requestNotify();
  }
  private notifyView(): void {
    const { query, view } = this;
    this.requestNotify.cancel();
    if (!query) return;
    const errors = [...this.errors]; this.errors.clear();
    for (const message of errors.slice(0, 3)) new Notice(message);
    const config = query.getViewConfig(this.viewName);
    if (!config) return;
    const all = [...this.results.values()], total = all.length, matched = [...applySearch(all, this.searchQuery, config.getOrder())], found = matched.length;
    matched.sort((a, b) => a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0);
    this.collectProperties(matched);
    this.overrides = null;
    const properties = this.getProperties();
    this.mockContext = new MockContext(this.app, query.formulas, () => this.sampleValues());
    if (view) { view.allProperties = properties; view.data = new ViewData(this.app, config, properties, matched); view.onDataUpdated(); }
    const formulaError = Object.values(query.formulas).some(formula => formula.isInvalid);
    this.filterMenu.updateQuery(query, config);
    this.propertyMenu.updateQuery(formulaError);
    this.sortMenu.updateQuery(config);
    this.groupMenu.updateQuery(config);
    this.resultsMenu.updateQuery(config, total);
    this.searchMenu.updateCount(found);
  }
  private displayError(kind: "query" | "view", error: Error): void {
    this.error = kind;
    toggle(this.viewContainerEl, false); toggle(this.headerEl, kind !== "query");
    for (const menu of [this.filterMenu, this.propertyMenu, this.groupMenu]) menu.toolbarItem.setEnabled(false);
    this.errorEl.replaceChildren();
    if (kind === "query") el(this.errorEl, "p", "", t("plugins.bases.msg-error-unable-to-parse"));
    el(this.errorEl, "p", "", error.message);
    toggle(this.errorEl, true);
  }
  private clearError(): void {
    this.error = null;
    toggle(this.viewContainerEl, true); toggle(this.headerEl, true);
    this.errorEl.replaceChildren(); toggle(this.errorEl, false);
    for (const menu of [this.filterMenu, this.propertyMenu, this.groupMenu]) menu.toolbarItem.setEnabled(true);
  }

  // ---- properties ----
  private collectProperties(entries: Entry[]): void {
    const names = this.relevantProperties = new Map<string, string>(), widgets = this.noteWidgets = new Map<string, string>();
    for (const entry of entries) for (const key of entry.getPropertyKeys()) {
      const lower = key.toLowerCase();
      if (!names.has(lower)) names.set(lower, key);
      if (!widgets.has(lower)) { const raw = entry.frontmatter[key]; if (raw != null) widgets.set(lower, inferPropertyType(key, raw)); }
    }
  }
  /** Every property this base can show: file properties, note properties of the matched files, and formulas. */
  getProperties(): PropertyId[] {
    return [...FILE_PROPERTIES, ...[...this.relevantProperties.values()].map(name => `note.${name}`), ...Object.keys(this.query?.formulas ?? {}).map(name => `formula.${name}`)];
  }
  /** Note property names across the whole vault, keyed by lower-case name. */
  getAllNoteProperties(): Map<string, string> {
    if (this.allNoteProperties) return this.allNoteProperties;
    const names = new Map<string, string>();
    for (const file of this.app.vault.getMarkdownFiles()) for (const key of Object.keys(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {})) if (!names.has(key.toLowerCase())) names.set(key.toLowerCase(), key);
    return this.allNoteProperties = names;
  }
  private overrides: Record<string, string> | null = null;
  private typeOverrides(): Record<string, string> {
    if (this.overrides) return this.overrides;
    const stored = this.app.loadLocalStorage(PROPERTY_TYPES_KEY);
    return this.overrides = stored && typeof stored === "object" ? stored as Record<string, string> : {};
  }
  getPropertyWidget(property: PropertyId): string {
    const { type, name } = parsePropertyId(property), lower = name.toLowerCase();
    if (type !== "note") return this.getWidgetForProperty(property);
    if (lower === "tags" || lower === "aliases") return lower;
    if (lower === "cssclasses") return "multitext";
    return this.typeOverrides()[lower] ?? this.noteWidgets.get(lower) ?? "text";
  }
  setPropertyWidget(name: string, widget: string): void {
    this.app.saveLocalStorage(PROPERTY_TYPES_KEY, { ...this.typeOverrides(), [name.toLowerCase()]: widget });
    this.overrides = null;
    this.notifyView();
  }
  getWidgetForProperty(property: PropertyId): string {
    switch (property) {
      case "file.file": case "file.path": return "file";
      case "file.tags": return "tags";
      case "file.ctime": case "file.mtime": return "date";
      case "file.folder": return "folder";
    }
    if (parsePropertyId(property).type === "note") return this.getPropertyWidget(property);
    return widgetForValue(this.mockContext.evaluateIdent(propertyExpression(property)));
  }
  getPropertyIcon(property: PropertyId): string {
    const { type } = parsePropertyId(property);
    return type === "note" ? WIDGET_ICONS[this.getPropertyWidget(property)] ?? "lucide-text" : type === "formula" ? "lucide-square-function" : "lucide-info";
  }
  canGroupBy(property: PropertyId): boolean { return !NO_GROUPING.includes(property) && property.toLowerCase() !== "note.aliases"; }
  private sampleValues(): Record<string, Value> {
    const samples: Record<string, Value> = {};
    for (const name of this.getAllNoteProperties().values()) samples[name] = sampleForWidget(this.getPropertyWidget(`note.${name}`));
    return samples;
  }
  getPropertyItems(filter?: (property: PropertyId) => boolean): PropertyItem[] {
    const properties = [...this.getProperties().filter(property => !property.startsWith("note.")), ...[...this.getAllNoteProperties().values()].map(name => `note.${name}`)];
    return properties.filter(property => !filter || filter(property)).map(property => {
      const { type, name } = parsePropertyId(property), display = this.getDisplayName(property);
      const icon = type === "note" ? WIDGET_ICONS[this.getPropertyWidget(property)] ?? "lucide-text" : type === "formula" ? "lucide-square-function" : this.fileIcon(property);
      return { value: property, display, icon, aux: (type === "file" && name !== "file") || name !== display ? property : undefined };
    });
  }
  private fileIcon(property: PropertyId): string {
    const value = this.mockContext.evaluateIdent(propertyExpression(property));
    return value instanceof NullValue ? ({ "file.file": "lucide-file", "file.ctime": "lucide-clock", "file.mtime": "lucide-clock", "file.size": "lucide-binary", "file.tags": "lucide-tags", "file.links": "lucide-list", "file.backlinks": "lucide-list", "file.embeds": "lucide-list" } as Record<string, string>)[property] ?? "lucide-text" : value.icon;
  }

  // ---- group folds ----
  getGroupFolds(): Set<string> {
    if (!this.groupFolds) {
      this.groupFolds = Object.create(null) as Record<string, Set<string>>;
      const path = this.query?.file?.path, stored = path ? this.app.loadLocalStorage(GROUP_FOLDS_KEY + path) : null, names = this.getQueryViewNames();
      if (stored && typeof stored === "object") for (const [name, folds] of Object.entries(stored)) if (Array.isArray(folds) && names.includes(name)) this.groupFolds[name] = new Set(folds as string[]);
    }
    return this.groupFolds[this.viewName] ??= new Set();
  }
  saveGroupFolds(): void {
    const path = this.query?.file?.path;
    if (!path || !this.groupFolds) return;
    const stored: Record<string, string[]> = {};
    for (const [name, folds] of Object.entries(this.groupFolds)) if (folds.size) stored[name] = [...folds];
    this.app.saveLocalStorage(GROUP_FOLDS_KEY + path, Object.keys(stored).length ? stored : null);
  }

  // ---- popovers opened from the layouts ----
  private popup(anchor: HTMLElement, title: string, build: (menu: ToolbarMenu) => MenuPage): void {
    const menu = new ToolbarMenu(anchor, title);
    menu.setRootPage(() => build(menu));
    menu.handleClose = () => { const index = this.popups.indexOf(menu); if (index >= 0) this.popups.splice(index, 1); };
    this.popups.push(menu);
    menu.setOpen(true);
  }
  openPropertyEditor(property: PropertyId, anchor: HTMLElement): void {
    if (!this.query || !this.getViewConfig()) return;
    this.popup(anchor, parsePropertyId(property).name, menu => {
      const page = new MenuPage(menu), header = div(page.containerEl, "bases-toolbar-menu-container-header");
      div(div(header, "menu-title"), "menu-title-inner", t("plugins.bases.title-edit-property", { name: parsePropertyId(property).name }));
      const form = new PropertyForm(this, property, false).onDelete(() => menu.close());
      iconDiv(header, "clickable-icon", "lucide-more-vertical").addEventListener("click", event => form.showActions(event));
      page.containerEl.append(form.containerEl);
      return page;
    });
  }
  openSummaryMenu(property: PropertyId, entries: Entry[], anchor: HTMLElement): void {
    const config = this.getViewConfig();
    if (!config || anchor.classList.contains("has-active-menu")) return;
    const values = entries.map(entry => { try { return entry.getValue(property) ?? NullValue.value; } catch { return NullValue.value; } });
    this.popup(anchor, parsePropertyId(property).name, menu => new SummaryPage(menu, this, config, property, values));
  }
  exportCsv(view: BasesView, filename: string): void {
    try {
      const doc = this.containerEl.ownerDocument, link = doc.createElement("a"), url = URL.createObjectURL(new Blob([toDelimited(view.exportTable(), ",")], { type: "text/csv" }));
      link.href = url; link.download = filename; doc.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) { console.error(error); new Notice(t("interface.msg-failed-to-export", { filename })); }
  }

  // ---- new items ----
  /** Creates a note using the template and defaults inferred from the base's simple filters. */
  async createItem(basename?: string, modify?: (frontmatter: Record<string, unknown>, file: TFile) => void): Promise<TFile | null> {
    const { app, query } = this, config = this.getViewConfig();
    if (!query || !config) return null;
    try {
      let frontmatter: Record<string, unknown> = {}, folder = query.newItemFolder ?? "", content = "", fromTemplate = false;
      const template = query.newItemTemplate ? app.vault.getFileByPath(query.newItemTemplate) ?? app.vault.getFileByPath(`${query.newItemTemplate}.md`) : null;
      if (template) { if (!folder) folder = template.parent?.path ?? ""; content = await app.vault.cachedRead(template); fromTemplate = true; }
      const defaults = newItemDefaults(query, config, this.mockContext, name => ["multitext", "tags", "aliases"].includes(this.getPropertyWidget(`note.${name}`)));
      if (!fromTemplate) frontmatter = defaults.frontmatter;
      if (!folder) folder = defaults.folder;
      folder = folder.replace(/^\/+|\/+$/g, "");
      const parent = folder ? app.vault.getFolderByPath(folder) ?? await app.vault.createFolder(folder) : app.fileManager.getNewFileParent(this.sourcePath);
      const file = await app.fileManager.createNewMarkdownFile(parent, basename, content);
      if (Object.keys(frontmatter).length || modify) await app.fileManager.processFrontMatter(file, target => { Object.assign(target, frontmatter); modify?.(target, file); });
      // The metadata cache indexes the new note asynchronously; only then can it be checked against the filters.
      setTimeout(() => { if (this.query && ![...this.results.keys()].some(other => other.path === file.path)) new Notice(t("plugins.bases.msg-new-item-filtered")); }, 600);
      return file;
    } catch (error) { new Notice((error as Error).message); return null; }
  }
  /** The reference creates the note immediately and lets the user edit it in a focused hover popover. */
  async openNewItem(baseFileName?: string, frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    if (this.hoverPopover) { this.hoverPopover.hide(); return; }
    if (this.creatingItem) return;
    this.creatingItem = true;
    try {
      const file = await this.createItem(baseFileName, frontmatterProcessor);
      if (!file || !this.isLoaded()) return;
      const popover = new HoverPopover(this, this.newItemButtonEl, 0);
      this.hoverPopover = popover;
      popover.setIsFocused(true);
      popover.hoverEl.classList.add("bases-new-item-popover");
      this.newItemButtonEl.classList.add("has-active-menu");
      const leaf = new WorkspaceLeaf(this.app.workspace), view = new MarkdownView(leaf);
      // This editor is embedded directly in the popover, outside the workspace
      // renderer. Mount its own content instead of sharing the leaf element.
      const host = view.contentEl;
      host.className = "markdown-embed is-loaded";
      popover.hoverEl.append(host);
      popover.register(() => { void view.closeView().catch(error => new Notice((error as Error).message)); this.newItemButtonEl.classList.remove("has-active-menu"); if (this.hoverPopover === popover) this.hoverPopover = null; });
      await leaf.open(view);
      await view.setState({ file: file.path, mode: "source" }, { history: false });
      if (!this.isLoaded() || popover.state === PopoverState.Hidden) { popover.hide(); await view.closeView(); return; }
      popover.watchResize(host);
      const title = host.querySelector<HTMLElement>(".inline-title");
      title?.focus();
      if (title) title.ownerDocument.getSelection()?.selectAllChildren(title);
      const outside = (event: MouseEvent) => { const target = event.target as globalThis.Node | null; if (target && !popover.hoverEl.contains(target) && !this.newItemButtonEl.contains(target)) popover.hide(); };
      host.ownerDocument.addEventListener("mousedown", outside);
      popover.register(() => host.ownerDocument.removeEventListener("mousedown", outside));
      popover.hoverEl.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); popover.hide(); this.newItemButtonEl.focus(); } });
    } catch (error) { this.hoverPopover?.hide(); new Notice((error as Error).message); }
    finally { this.creatingItem = false; }
  }
  get newItemButtonEl(): HTMLElement { return this.newItemButton.buttonEl; }
}
