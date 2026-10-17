import type { App } from "../../compat/plugin";
import type { TFile } from "../../compat/vault";
import {
  BasesEntry, BasesEntryGroup, BasesQueryResult, QueryController, BooleanValue, DateValue, DurationValue, ErrorValue, FileValue, LinkValue, ListValue, NotNullValue, NullValue, NumberValue, StringValue, UrlValue, Value,
  frontmatterValue, naturalCompare, parsePropertyId, resolveKey, wrapValue, type ObjectValue,
} from "../../compat/bases";
import { parseYaml, stringifyYaml } from "../../compat/utilities";
import { t } from "../../i18n";
import { Formula, defaultSummaries, evaluate, needsQuoting, type FormulaContext, type Node } from "./formula";

export type Direction = "ASC" | "DESC";
export type PropertyId = string;
export interface SortSpec { property: PropertyId; direction: Direction }
export type Conjunction = "and" | "or" | "not";

export const FILE_PROPERTIES: PropertyId[] = ["file.file", "file.name", "file.basename", "file.fullname", "file.path", "file.folder", "file.ext", "file.ctime", "file.mtime", "file.size", "file.links", "file.backlinks", "file.embeds", "file.tags"];
const FILE_PROPERTY_LABELS: Record<string, () => string> = {
  "file.file": () => t("plugins.bases.label-file-prop-file"), "file.name": () => t("plugins.bases.label-file-prop-name"),
  "file.basename": () => t("plugins.bases.label-file-prop-base-name"), "file.fullname": () => t("plugins.bases.label-file-prop-full-name"),
  "file.path": () => t("plugins.bases.label-file-prop-path"), "file.folder": () => t("plugins.bases.label-file-prop-folder"),
  "file.ext": () => t("plugins.bases.label-file-prop-ext"), "file.ctime": () => t("plugins.bases.label-file-prop-ctime"),
  "file.mtime": () => t("plugins.bases.label-file-prop-mtime"), "file.size": () => t("plugins.bases.label-file-prop-size"),
  "file.links": () => t("plugins.bases.label-file-prop-links"), "file.backlinks": () => t("plugins.bases.label-file-prop-backlinks"),
  "file.embeds": () => t("plugins.bases.label-file-prop-embeds"), "file.tags": () => t("plugins.bases.label-file-prop-tags"),
};

/** `status` → `note.status`, `file` → `file.file`; ids always carry their namespace internally. */
export function toPropertyId(key: string): PropertyId {
  if (key.startsWith("note.") || key.startsWith("formula.") || key.startsWith("file.")) return key;
  return key === "file" ? "file.file" : `note.${key}`;
}
/** The short form written to the file: note properties lose their prefix unless that would be ambiguous. */
export function fromPropertyId(id: PropertyId): string {
  if (id.length > 5 && id.startsWith("note.")) {
    const name = id.slice(5);
    return ["file", "formula", "note"].includes(name.split(".")[0]!) ? id : name;
  }
  return id === "file.file" ? "file" : id;
}
/** The expression that reads a property inside a formula. */
export function propertyExpression(id: PropertyId): string {
  if (id === "") return "";
  const { type, name } = parsePropertyId(id);
  if (type === "file" && name === "file") return "file";
  if (needsQuoting(name)) return `${type}[${JSON.stringify(name)}]`;
  return type === "note" ? name : `${type}.${name}`;
}
export function uniqueName(taken: Set<string>, base: string): string {
  let name = base;
  for (let index = 2; taken.has(name); index++) name = `${base} ${index}`;
  return name;
}

// ---------------------------------------------------------------------------------------------------------------------
// Filters

export class FilterRule {
  constructor(readonly rule: Formula) {}
  hasError(): boolean { return this.rule.isInvalid; }
  serialize(): string { return this.rule.toString(); }
  test(ctx: FormulaContext): boolean { return this.rule.test(ctx); }
}
export class FilterGroup {
  constructor(readonly conjunction: Conjunction, readonly filters: Filter[]) {}
  hasError(): boolean { return this.filters.some(filter => filter.hasError()); }
  serialize(): Record<string, unknown> { return { [this.conjunction]: this.filters.map(filter => filter.serialize()) }; }
  test(ctx: FormulaContext): boolean {
    if (this.conjunction === "and") return this.filters.every(filter => filter.test(ctx));
    if (this.conjunction === "or") return this.filters.some(filter => filter.test(ctx));
    return !this.filters.some(filter => filter.test(ctx));
  }
}
export type Filter = FilterRule | FilterGroup;

export function parseFilter(raw: unknown): Filter {
  if (typeof raw === "string") return new FilterRule(new Formula(raw));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(t("plugins.bases.msg-error-filter-type"));
  const keys = Object.keys(raw);
  const conjunction = keys[0] as Conjunction;
  if (keys.length !== 1 || !["and", "or", "not"].includes(conjunction)) throw new Error(t("plugins.bases.msg-error-filter-allowed-keys"));
  const items = (raw as Record<string, unknown>)[conjunction];
  if (!Array.isArray(items)) throw new Error(t("plugins.bases.msg-error-filter-must-be-array", { conjunction }));
  return new FilterGroup(conjunction, items.map(parseFilter));
}
export function combineFilters(...filters: Array<Filter | null | undefined>): Filter | null {
  const present = filters.filter((filter): filter is Filter => !!filter);
  return present.length === 0 ? null : present.length === 1 ? present[0]! : new FilterGroup("and", present);
}
/** Leaf rules with whether an odd number of `not` groups encloses them. */
function filterRules(filter: Filter | null, negated = false): Array<{ rule: Formula; negated: boolean }> {
  if (!filter) return [];
  if (filter instanceof FilterRule) return [{ rule: filter.rule, negated }];
  return filter.filters.flatMap(item => filterRules(item, negated !== (filter.conjunction === "not")));
}

// ---------------------------------------------------------------------------------------------------------------------
// Query model

export class PropertyConfig {
  displayName?: string;
  extra: Record<string, unknown> = {};
  constructor(private readonly query: BasesQuery, readonly propertyId: PropertyId) {}
  serialize(): Record<string, unknown> | null {
    const out = { ...this.extra };
    if (this.displayName) out.displayName = this.displayName;
    return Object.keys(out).length ? out : null;
  }
  getDisplayName(): string { return this.displayName || FILE_PROPERTY_LABELS[this.propertyId]?.() || parsePropertyId(this.propertyId).name; }
  setDisplayName(name: string | null): void { this.displayName = name || undefined; this.query.save(); }
}

export class ViewConfig {
  filters?: Filter;
  groupBy?: SortSpec | null;
  groupOrder?: unknown[] | null;
  order?: PropertyId[];
  sort?: SortSpec[];
  limit?: number;
  summaries?: Record<PropertyId, string>;
  /** Layout-specific and unknown keys (columnSize, rowHeight, image, cardSize, …), written back untouched. */
  data: Record<string, unknown> = {};
  constructor(readonly query: BasesQuery, public type: string, public name: string) {}

  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = { type: this.type, name: this.name };
    if (this.filters) out.filters = this.filters.serialize();
    if (this.groupBy) out.groupBy = { property: fromPropertyId(this.groupBy.property), direction: this.groupBy.direction };
    if (this.groupOrder) out.groupOrder = [...this.groupOrder];
    if (this.order) out.order = this.order.map(fromPropertyId);
    if (this.sort) out.sort = this.sort.map(sort => ({ property: fromPropertyId(sort.property), direction: sort.direction }));
    if (this.limit) out.limit = this.limit;
    if (this.summaries) out.summaries = Object.fromEntries(Object.entries(this.summaries).map(([key, value]) => [fromPropertyId(key), value]));
    for (const [key, value] of Object.entries(this.data)) if (!Object.hasOwn(out, key)) out[key] = value;
    return out;
  }
  clone(name: string): ViewConfig { return parseView(this.query, { ...this.serialize(), name }, this.query.views.length); }
  get(key: string): unknown { return this.data[key]; }
  set(key: string, value: unknown): void {
    if (value === null || value === undefined) delete this.data[key]; else this.data[key] = value;
    this.query.save();
  }
  getAsPropertyId(key: string): PropertyId | null { const value = this.data[key]; return value && typeof value === "string" ? toPropertyId(value) : null; }
  getEvaluatedFormula(view: { controller: { app: App; getCurrentFile(): TFile | null } }, key: string): Value {
    const source = this.get(key);
    if (typeof source !== "string" || !source) return NullValue.value;
    const formula = new Formula(source);
    if (formula.isInvalid) return NullValue.value;
    const current = view.controller.getCurrentFile();
    try { return formula.getValue(current ? new Entry(new QueryContext(view.controller.app, null, this.query.formulas, current), current) : new MockContext(view.controller.app, this.query.formulas, () => ({}), null)); }
    catch { return NullValue.value; }
  }
  getOrder(): PropertyId[] { return this.order ? [...this.order] : ["file.name"]; }
  setOrder(order: PropertyId[]): void { this.order = order; this.query.save(); }
  getSort(): SortSpec[] { return this.sort ?? []; }
  setSort(sort: SortSpec[]): void { this.sort = sort; this.query.save(); }
  setSortProperty(property: PropertyId, direction: Direction | "TOGGLE" | "NONE"): void {
    const sort = [...this.getSort()], index = sort.findIndex(item => item.property === property);
    if (index >= 0) {
      if (direction === "TOGGLE") direction = sort[index]!.direction === "ASC" ? "DESC" : "NONE";
      sort.splice(index, 1);
    }
    if (direction === "TOGGLE") direction = "ASC";
    if (direction === "ASC" || direction === "DESC") sort.unshift({ property, direction });
    this.setSort(sort);
  }
  getLimit(): number { return this.limit || 0; }
  setLimit(limit: number): void { this.limit = limit; this.query.save(); }
  setGroupBy(groupBy: SortSpec | null): void {
    const current = this.groupBy;
    if (!groupBy && !current) return;
    if (!groupBy) { this.groupBy = null; this.groupOrder = null; this.query.save(); return; }
    if (current && current.property === groupBy.property && current.direction === groupBy.direction) return;
    if (groupBy.property !== current?.property) this.groupOrder = null;
    this.groupBy = groupBy; this.query.save();
  }
  setGroupOrder(order: unknown[] | null): void { this.groupOrder = order; this.query.save(); }
  getSummaryKey(property: PropertyId): string | null { return this.summaries && Object.hasOwn(this.summaries, property) ? this.summaries[property]! : null; }
  setSummaryKey(property: PropertyId, key: string | null): void {
    if (key === null) { if (!this.summaries || !Object.hasOwn(this.summaries, property)) return; delete this.summaries[property]; }
    else (this.summaries ??= {})[property] = key;
    this.query.save();
  }
  getDisplayName(property: PropertyId): string { return this.query.getPropertyConfig(property).getDisplayName(); }
}

function parseView(query: BasesQuery, raw: unknown, index: number): ViewConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(t("plugins.bases.msg-error-view-invalid-format", { index }));
  const item = raw as Record<string, any>, viewName = item.name;
  if (!viewName || typeof viewName !== "string") throw new Error(t("plugins.bases.msg-error-view-name-invalid", { index }));
  if (!item.type) throw new Error(t("plugins.bases.msg-error-view-missing-required-key", { key: "type", viewName }));
  if (typeof item.type !== "string") throw new Error(t("plugins.bases.msg-error-view-incorrect-type", { key: "type", type: "string", viewName }));
  const view = new ViewConfig(query, item.type, viewName);
  const direction = (value: unknown): value is Direction => value === "ASC" || value === "DESC";
  for (const key of Object.keys(item)) {
    const value = item[key];
    switch (key) {
      case "type": case "name": break;
      case "filters":
        try { view.filters = parseFilter(value); }
        catch (error) { throw new Error(t("plugins.bases.msg-error-view-parsing-filters", { message: (error as Error).message, viewName })); }
        break;
      case "groupBy":
        if (!value || typeof value !== "object" || !Object.hasOwn(value, "property") || !Object.hasOwn(value, "direction")) throw new Error(t("plugins.bases.msg-error-view-incorrect-type", { key: "groupBy", type: "object", viewName }));
        if (value.property && typeof value.property === "string" && direction(value.direction)) view.groupBy = { property: toPropertyId(value.property), direction: value.direction };
        break;
      case "groupOrder": if (Array.isArray(value)) view.groupOrder = [...value]; break;
      case "summaries":
        if (!value || typeof value !== "object") throw new Error(t("plugins.bases.msg-error-view-incorrect-type", { key: "summaries", type: "object", viewName }));
        view.summaries = {};
        for (const [property, summary] of Object.entries(value)) {
          if (typeof summary !== "string") throw new Error(t("plugins.bases.msg-error-view-incorrect-value-type", { key: "summaries", type: "string", viewName }));
          view.summaries[toPropertyId(property)] = summary;
        }
        break;
      case "order":
        if (!Array.isArray(value)) throw new Error(t("plugins.bases.msg-error-view-incorrect-type", { key: "order", type: "array", viewName }));
        view.order = value.filter(entry => typeof entry === "string").map(toPropertyId);
        break;
      case "sort":
        if (Array.isArray(value)) {
          view.sort = [];
          for (const entry of value) {
            const property = entry?.property ?? entry?.column;
            if (property && typeof property === "string" && direction(entry.direction)) view.sort.push({ property: toPropertyId(property), direction: entry.direction });
          }
        }
        break;
      case "limit": if (typeof value === "number" && value > 0) view.limit = value; break;
      default: view.data[key] = value;
    }
  }
  if (!view.groupBy) view.groupOrder = null;
  return view;
}

/** The parsed contents of a `.base` file. Unknown keys survive a round trip. */
export class BasesQuery {
  views: ViewConfig[] = [];
  filters?: Filter;
  formulas: Record<string, Formula> = {};
  summaryFormulas?: Record<string, Formula>;
  properties: Record<PropertyId, PropertyConfig> = {};
  newItemFolder?: string;
  newItemTemplate?: string;
  extra: Record<string, unknown> = {};
  file: TFile | null = null;
  saveFn?: (query: BasesQuery) => void;

  static fromString(text: string): BasesQuery {
    if (text.trim() === "") { const query = new BasesQuery(); query.views.push(new ViewConfig(query, "table", t("plugins.bases.label-default-view"))); return query; }
    return BasesQuery.parse(parseYaml(text.replace(/^(\t+)/gm, tabs => "    ".repeat(tabs.length))));
  }
  static parse(raw: unknown): BasesQuery {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(t("plugins.bases.msg-error-invalid-query-format"));
    const source = raw as Record<string, any>, query = new BasesQuery();
    const mapping = (key: string, value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("plugins.bases.msg-error-must-be-a-type", { key, type: "object" }));
      return value as Record<string, unknown>;
    };
    if (source.views !== undefined && source.views !== null && !Array.isArray(source.views)) throw new Error(t("plugins.bases.msg-error-view-type"));
    (source.views as unknown[] | undefined ?? []).forEach((view, index) => query.views.push(parseView(query, view, index + 1)));
    if (!query.views.length) query.views.push(new ViewConfig(query, "table", t("plugins.bases.label-default-view")));
    if (source.filters) query.filters = parseFilter(source.filters);
    if (source.properties) {
      if (typeof source.properties !== "object" || Array.isArray(source.properties)) throw new Error(t("plugins.bases.msg-error-invalid-properties-section"));
      for (const [key, value] of Object.entries(source.properties as Record<string, unknown>)) {
        if (value == null) continue;
        if (typeof value !== "object") throw new Error(t("plugins.bases.msg-error-invalid-properties-section"));
        const config = query.properties[key] = new PropertyConfig(query, toPropertyId(key));
        for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
          if (name === "displayName") { if (typeof entry === "string") config.displayName = entry; }
          else config.extra[name] = entry;
        }
      }
    }
    if (source.display) for (const [key, value] of Object.entries(mapping("display", source.display))) {
      if (typeof value !== "string") throw new Error(t("plugins.bases.msg-error-display-values", { key }));
      query.getPropertyConfig(toPropertyId(key)).displayName ||= value;
    }
    if (source.formulas) for (const [key, value] of Object.entries(mapping("formulas", source.formulas))) {
      if (typeof value !== "string") { if (typeof value === "number" || typeof value === "boolean") { query.formulas[key] = new Formula(String(value)); continue; } throw new Error(t("plugins.bases.msg-error-formula-values", { key })); }
      query.formulas[key] = new Formula(value);
    }
    if (source.summaries) {
      query.summaryFormulas = {};
      for (const [key, value] of Object.entries(mapping("summaries", source.summaries))) {
        if (typeof value !== "string") throw new Error(t("plugins.bases.msg-error-formula-values", { key }));
        query.summaryFormulas[key] = new Formula(value);
      }
    }
    for (const key of ["newItemFolder", "newItemTemplate"] as const) if (source[key]) {
      if (typeof source[key] !== "string") throw new Error(t("plugins.bases.msg-error-must-be-a-type", { key, type: "string" }));
      query[key] = source[key];
    }
    for (const key of Object.keys(source)) if (!["views", "filters", "display", "properties", "formulas", "summaries", "newItemFolder", "newItemTemplate"].includes(key)) query.extra[key] = source[key];
    return query;
  }

  getSerializable(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.extra };
    if (this.filters) out.filters = this.filters.serialize();
    if (Object.keys(this.formulas).length) out.formulas = Object.fromEntries(Object.entries(this.formulas).map(([key, formula]) => [key, formula.toString()]));
    if (this.summaryFormulas && Object.keys(this.summaryFormulas).length) out.summaries = Object.fromEntries(Object.entries(this.summaryFormulas).map(([key, formula]) => [key, formula.toString()]));
    const properties: Record<string, unknown> = {};
    for (const [key, config] of Object.entries(this.properties)) { const serialized = config.serialize(); if (serialized) properties[key] = serialized; }
    if (Object.keys(properties).length) out.properties = properties;
    out.views = this.views.map(view => view.serialize());
    if (this.newItemFolder) out.newItemFolder = this.newItemFolder;
    if (this.newItemTemplate) out.newItemTemplate = this.newItemTemplate;
    return out;
  }
  toString(): string { const data = this.getSerializable(); return Object.keys(data).length ? stringifyYaml(data) : ""; }
  save(): void { this.saveFn?.(this); }

  setGlobalFilters(raw: unknown): void { if (raw) this.filters = parseFilter(raw); else delete this.filters; this.save(); }
  setViewFilters(viewName: string, raw: unknown): void {
    const view = this.getViewConfig(viewName);
    if (!view) throw new Error(t("obsen.bases.error-invalid-view"));
    if (raw) view.filters = parseFilter(raw); else delete view.filters;
    this.save();
  }
  setFormulas(formulas: Record<string, Formula>): void { this.formulas = formulas; this.save(); }
  setSummaryFormula(name: string, formula: Formula | null): void {
    if (formula) (this.summaryFormulas ??= {})[name] = formula; else if (this.summaryFormulas) delete this.summaryFormulas[name];
    this.save();
  }
  renameSummaryFormula(from: string, to: string): void {
    if (this.summaryFormulas && Object.hasOwn(this.summaryFormulas, from)) { this.summaryFormulas[to] = this.summaryFormulas[from]!; delete this.summaryFormulas[from]; }
    for (const view of this.views) for (const property of Object.keys(view.summaries ?? {})) if (view.summaries![property] === from) view.summaries![property] = to;
    this.save();
  }
  deleteSummaryFormula(name: string): void {
    if (this.summaryFormulas) delete this.summaryFormulas[name];
    for (const view of this.views) for (const property of Object.keys(view.summaries ?? {})) if (view.summaries![property] === name) delete view.summaries![property];
    this.save();
  }
  getSummaryFormula(sample: Value | null, name: string): Formula | null {
    if (this.summaryFormulas && Object.hasOwn(this.summaryFormulas, name)) return this.summaryFormulas[name]!;
    const builtin = defaultSummaries(sample)[name];
    return builtin ? new Formula(builtin) : null;
  }
  getPropertyConfig(property: PropertyId): PropertyConfig {
    // Configs are keyed by the form used in the file ("status"), so look both spellings up.
    const short = fromPropertyId(property);
    return this.properties[property] ?? this.properties[short] ?? (this.properties[property] = new PropertyConfig(this, property));
  }
  removeFormula(name: string): void {
    if (!Object.hasOwn(this.formulas, name)) return;
    const id = `formula.${name}`;
    delete this.formulas[name]; delete this.properties[id];
    for (const view of this.views) {
      if (view.order) view.order = view.order.filter(property => property !== id);
      if (view.sort) view.sort = view.sort.filter(sort => sort.property !== id);
      if (view.summaries) delete view.summaries[id];
      if (view.groupBy?.property === id) { view.groupBy = null; view.groupOrder = null; }
    }
    this.save();
  }
  renameFormula(oldName: string, newName: string): void {
    const formula = this.formulas[oldName];
    if (!formula || oldName === newName) return;
    this.formulas = Object.fromEntries(Object.entries(this.formulas).map(([key, value]) => [key === oldName ? newName : key, value]));
    const from = `formula.${oldName}`, to = `formula.${newName}`;
    if (this.properties[from]) { this.properties[to] = this.properties[from]!; delete this.properties[from]; }
    for (const view of this.views) {
      if (view.order) view.order = view.order.map(property => property === from ? to : property);
      if (view.sort) view.sort = view.sort.map(sort => sort.property === from ? { ...sort, property: to } : sort);
      if (view.groupBy?.property === from) view.groupBy = { ...view.groupBy, property: to };
      if (view.summaries && Object.hasOwn(view.summaries, from)) { view.summaries[to] = view.summaries[from]!; delete view.summaries[from]; }
    }
    this.save();
  }
  getViewConfig(name?: string | null): ViewConfig | null { return name ? this.views.find(view => view.name === name) ?? null : this.views[0] ?? null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation

/** State shared by every row of one query run. */
export class QueryContext {
  readonly local: Entry | null;
  constructor(readonly app: App, readonly filter: Filter | null, readonly formulas: Record<string, Formula>, localFile: TFile | null) {
    this.local = localFile ? new Entry(this, localFile) : null;
  }
}

/** `this`: the file that hosts the base, exposing its own properties as members. */
class ThisFileValue extends FileValue {
  static override type = "thisfile";
  constructor(file: TFile, app: App, private readonly entry: Entry) { super(file, app); }
  override keys(): string[] { return this.entry.getPropertyKeys(); }
  override objectAccess(key: string): Value | null { return this.entry.getByIdentifier(key); }
}
class FormulasValue extends NotNullValue {
  static type = "formulas";
  override icon = "lucide-square-function";
  constructor(private readonly entry: Entry) { super(); }
  toString(): string { return `Formulas${JSON.stringify(Object.keys(this.entry.ctx.formulas))}`; }
  isTruthy(): boolean { return true; }
  override keys(): string[] { return Object.keys(this.entry.ctx.formulas); }
  override objectAccess(key: string): Value | null {
    const value = this.entry.getFormulaValue(key);
    if (value instanceof ErrorValue) throw new Error(value.message);
    return value ?? NullValue.value;
  }
}

const IN_PROGRESS = Symbol("formula in progress");

/** One file seen through a base: its frontmatter, file metadata and computed formulas. */
export class Entry extends BasesEntry implements FormulaContext {
  readonly app: App;
  readonly frontmatter: Record<string, unknown>;
  private noteValue?: ObjectValue;
  private fileValue?: FileValue;
  private formulaCache: Record<string, Value | typeof IN_PROGRESS> = {};
  constructor(readonly ctx: QueryContext, file: TFile) {
    super(file);
    this.app = ctx.app;
    this.frontmatter = (ctx.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  }
  get note(): ObjectValue { return this.noteValue ??= frontmatterValue(this.app, this.file, this.frontmatter); }
  get implicit(): FileValue { return this.fileValue ??= new FileValue(this.file, this.app); }
  override getValue(propertyId: string): Value | null {
    const { type, name } = parsePropertyId(propertyId);
    if (type === "note") return this.note.objectAccess(name);
    if (type === "file") return this.implicit.objectAccess(name);
    return this.getFormulaValue(name);
  }
  getFormulaValue(name: string): Value | null {
    const formulas = this.ctx.formulas, key = resolveKey(formulas, name);
    if (Object.hasOwn(this.formulaCache, key)) {
      const cached = this.formulaCache[key]!;
      if (cached === IN_PROGRESS) throw new Error(t("plugins.bases.msg-error-infinite-loop"));
      return cached;
    }
    if (!Object.hasOwn(formulas, key)) return null;
    this.formulaCache[key] = IN_PROGRESS;
    return this.formulaCache[key] = formulas[key]!.getValue(this);
  }
  getByIdentifier(id: string): Value | null {
    switch (id.toLowerCase()) {
      case "this": { const local = this.ctx.local; return local ? new ThisFileValue(local.file, this.app, local) : NullValue.value; }
      case "note": return this.note;
      case "file": return this.implicit;
      case "formula": return new FormulasValue(this);
    }
    return this.note.getInsensitive(id);
  }
  getPropertyKeys(): string[] { return Object.keys(this.frontmatter); }
  getRawProperty(name: string): unknown { const key = resolveKey(this.frontmatter, name); return Object.hasOwn(this.frontmatter, key) ? this.frontmatter[key] : null; }
}

/** Evaluates expressions when there is no row, e.g. to learn what type `file.mtime` or a formula produces. */
export class MockContext implements FormulaContext {
  private formulaCache: Record<string, Value | null> = {};
  private sampleCache: Record<string, Value> | null = null;
  constructor(readonly app: App, private readonly formulas: Record<string, Formula>, private readonly loadSamples: () => Record<string, Value>, private readonly localFile?: TFile | null) {}
  private samples(): Record<string, Value> { return this.sampleCache ??= this.loadSamples(); }
  getByIdentifier(id: string): Value | null {
    const file = this.localFile === undefined ? this.app.workspace.getActiveFile() as TFile | null : this.localFile;
    switch (id.toLowerCase()) {
      case "this": case "file": return file ? new FileValue(file, this.app) : NullValue.value;
      case "note": return new SampleObject(this.samples());
      case "formula": return new SampleObject({}, name => this.formula(name));
    }
    const samples = this.samples();
    return samples[resolveKey(samples, id)] ?? NullValue.value;
  }
  private formula(name: string): Value | null {
    const key = resolveKey(this.formulas, name);
    if (!Object.hasOwn(this.formulas, key)) return null;
    if (Object.hasOwn(this.formulaCache, key)) return this.formulaCache[key]!;
    this.formulaCache[key] = NullValue.value;
    try { return this.formulaCache[key] = evaluate(this.formulas[key]!.node, this); }
    catch { return NullValue.value; }
  }
  evaluateIdent(expression: string): Value {
    try { return evaluate(new Formula(expression).node, this); }
    catch { return NullValue.value; }
  }
}
class SampleObject extends NotNullValue {
  static type = "object";
  constructor(private readonly samples: Record<string, Value>, private readonly lookup?: (name: string) => Value | null) { super(); }
  toString(): string { return "{}"; }
  isTruthy(): boolean { return true; }
  override objectAccess(key: string): Value | null { return this.lookup ? this.lookup(key) ?? NullValue.value : this.samples[resolveKey(this.samples, key)] ?? NullValue.value; }
}

/** A representative value for a property-editor widget type. */
export function sampleForWidget(widget: string): Value {
  switch (widget) {
    case "file": case "folder": case "text": return new StringValue("");
    case "number": return new NumberValue(0);
    case "checkbox": return new BooleanValue(true);
    case "date": return new DateValue(new Date(), false);
    case "datetime": return new DateValue(new Date(), true);
    case "tags": case "aliases": case "multitext": return new ListValue([""]);
  }
  return NullValue.value;
}

/** The text a value contributes to sorting and searching. */
export function displayText(value: Value): string {
  return (value instanceof LinkValue || value instanceof UrlValue) && value.display ? value.display.toString() : value.toString();
}
export function compareGroupKeys(a: Value | undefined, b: Value | undefined): number {
  if (Value.equals(a ?? null, b ?? null)) return 0;
  return a instanceof NumberValue && b instanceof NumberValue ? a.value - b.value : naturalCompare(a?.toString() ?? "", b?.toString() ?? "");
}

export class EntryGroup extends BasesEntryGroup {
  constructor(public entries: Entry[], public key: Value | undefined = undefined) { super(key, entries); }
  hasKey(): boolean { return !!this.key && !(this.key instanceof NullValue); }
}

/** The rows a view displays: sorted, limited and grouped according to its config. */
export class ViewData extends BasesQueryResult {
  private grouped?: EntryGroup[];
  private summaryCache = new WeakMap<BasesEntry[], Record<string, Record<string, Value>>>();
  private propertyOrder: PropertyId[];
  override get properties(): import("../../compat/bases").BasesPropertyId[] { return this.propertyOrder as import("../../compat/bases").BasesPropertyId[]; }
  constructor(readonly app: App, readonly config: ViewConfig, readonly allProperties: PropertyId[], readonly data: Entry[]) {
    super(data);
    this.propertyOrder = config.getOrder();
    this.applySort();
    const limit = config.getLimit();
    if (limit > 0 && data.length > limit) data.length = limit;
  }
  private applySort(): void {
    const known = new Set(this.allProperties);
    let sort = this.config.getSort().filter(item => known.has(item.property) || item.property.startsWith("note."));
    if (!sort.length) sort = [{ property: "file.name", direction: "ASC" }];
    // Values are computed once per row and column rather than once per comparison.
    const keys = new Map<Entry, Array<Value | null>>();
    for (const entry of this.data) keys.set(entry, sort.map(item => { try { return entry.getValue(item.property) ?? NullValue.value; } catch { return null; } }));
    const compare = (a: Value | null, b: Value | null): number => {
      if (!a || !b) return 0;
      if (a instanceof NullValue && b instanceof NullValue) return 0;
      if (a instanceof BooleanValue || b instanceof BooleanValue) return (a.isTruthy() ? 1 : -1) - (b.isTruthy() ? 1 : -1);
      if (a instanceof NullValue) return Infinity;
      if (b instanceof NullValue) return -Infinity;
      if (a instanceof NumberValue && b instanceof NumberValue) return a.value - b.value;
      if (a instanceof DateValue && b instanceof DateValue) return a.date.getTime() - b.date.getTime();
      if (a instanceof DurationValue && b instanceof DurationValue) return a.getMilliseconds() - b.getMilliseconds();
      return naturalCompare(displayText(a), displayText(b));
    };
    this.data.sort((x, y) => {
      const a = keys.get(x)!, b = keys.get(y)!;
      for (let index = 0; index < sort.length; index++) {
        const result = compare(a[index]!, b[index]!);
        // Empty values stay last whichever way the column is sorted.
        if (result === Infinity) return 1;
        if (result === -Infinity) return -1;
        if (result) return sort[index]!.direction === "ASC" ? result : -result;
      }
      return 0;
    });
  }
  get groupedData(): EntryGroup[] {
    if (this.grouped) return this.grouped;
    const { groupBy, groupOrder } = this.config;
    if (!groupBy) return this.grouped = [new EntryGroup(this.data)];
    const groups: EntryGroup[] = [], byText = new Map<string, EntryGroup[]>();
    for (const entry of this.data) {
      let key: Value;
      try { key = entry.getValue(groupBy.property) ?? NullValue.value; } catch { key = NullValue.value; }
      const text = key.toString().toLowerCase(), bucket = byText.get(text) ?? [];
      let group = bucket.find(candidate => Value.looseEquals(candidate.key ?? null, key));
      if (!group) { group = new EntryGroup([], key); groups.push(group); bucket.push(group); byText.set(text, bucket); }
      group.entries.push(entry);
    }
    if (groupOrder) {
      // Listed groups retain their order and exist even when no note has that value.
      return this.grouped = groupOrder.map(stored => {
        const key = wrapValue(stored);
        return groups.find(group => Value.looseEquals(group.key ?? NullValue.value, key) || group.key?.toString() === key.toString()) ?? new EntryGroup([], key);
      });
    }
    const sign = groupBy.direction === "ASC" ? 1 : -1;
    groups.sort((a, b) => a.hasKey() && b.hasKey() ? compareGroupKeys(a.key, b.key) * sign : a.hasKey() ? -1 : b.hasKey() ? 1 : 0);
    return this.grouped = groups;
  }
  getSummaryValue(queryOrController: BasesQuery | QueryController, entries: BasesEntry[], property: PropertyId, key: string): Value {
    const query = queryOrController instanceof BasesQuery ? queryOrController : (queryOrController as QueryController & { query?: BasesQuery | null }).query;
    if (!query) return NullValue.value;
    let byProperty = this.summaryCache.get(entries);
    if (!byProperty) this.summaryCache.set(entries, byProperty = {});
    const cache = byProperty[property] ??= {};
    if (Object.hasOwn(cache, key)) return cache[key]!;
    const values = entries.map(entry => { try { return entry.getValue(property as import("../../compat/bases").BasesPropertyId) ?? NullValue.value; } catch { return NullValue.value; } });
    const formula = query.getSummaryFormula(values.find(value => !(value instanceof NullValue)) ?? null, key);
    return cache[key] = formula ? formula.getValue(summaryContext(this.app, values)) : NullValue.value;
  }
}
export function summaryContext(app: App, values: Value[]): FormulaContext {
  return { app, getByIdentifier: id => id.toLowerCase() === "values" ? new ListValue(values) : NullValue.value };
}

/** Keeps the rows whose visible properties contain every search term. */
export function applySearch(entries: Entry[], search: string | null, properties: PropertyId[]): Entry[] {
  const tokens = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries;
  return entries.filter(entry => {
    const remaining = [...tokens];
    for (const property of properties) {
      try {
        const value = entry.getValue(property);
        if (!value || value instanceof NullValue) continue;
        const text = displayText(value).toLowerCase();
        for (let index = remaining.length - 1; index >= 0; index--) if (text.includes(remaining[index]!)) remaining.splice(index, 1);
        if (!remaining.length) return true;
      } catch { /* a failing formula simply does not match */ }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// New items

function propertyOf(node: Node | null): { type: string; name: string } | null {
  if (!node) return null;
  if (node.type === "ident") return ["true", "false", "null", "this", "file", "note", "formula"].includes(node.id) ? (node.id === "file" ? { type: "file", name: "file" } : null) : { type: "note", name: node.id };
  if (node.type === "object_access" && node.object.type === "ident" && ["note", "file", "formula"].includes(node.object.id)) return { type: node.object.id, name: node.index };
  if (node.type === "array_access" && node.array.type === "ident" && ["note", "file", "formula"].includes(node.array.id) && node.index.type === "primitive" && typeof node.index.value === "string") return { type: node.array.id, name: node.index.value };
  return null;
}
function literalOf(node: Node, ctx: FormulaContext): unknown {
  if (node.type === "primitive") return node.value;
  if (node.type === "array") return node.elements.map(element => literalOf(element, ctx));
  if (node.type === "call" && !node.subject && node.name === "link" && node.args[0]?.type === "primitive") return `[[${node.args[0].value}${node.args[1]?.type === "primitive" ? `|${node.args[1].value}` : ""}]]`;
  const value = evaluate(node, ctx);
  if (value instanceof NullValue) throw new Error(t("obsen.bases.error-no-literal"));
  return value instanceof NumberValue || value instanceof BooleanValue ? value.value : value instanceof ListValue ? value.value.map(item => item.toString()) : value.toString();
}

/** Derives the frontmatter and folder a new note needs so that it satisfies the base's filters where that is unambiguous. */
export function newItemDefaults(query: BasesQuery, view: ViewConfig | null, ctx: FormulaContext, isList: (name: string) => boolean): { frontmatter: Record<string, unknown>; folder: string } {
  const frontmatter: Record<string, unknown> = {};
  let folder = "";
  for (const { rule, negated } of filterRules(combineFilters(query.filters, view?.filters))) {
    if (negated) continue;
    const node = rule.node;
    try {
      if (node.type === "not") {
        if (node.expr.type === "call" && node.expr.name === "isEmpty") { const target = propertyOf(node.expr.subject); if (target?.type === "note" && !Object.hasOwn(frontmatter, target.name)) frontmatter[target.name] = ""; }
      } else if (node.type === "compare" && [">=", "<=", "=="].includes(node.op)) {
        const target = propertyOf(node.left), value = literalOf(node.right, ctx);
        if (target?.type === "note") frontmatter[target.name] = value;
        else if (target?.type === "file" && target.name === "folder" && node.op === "==" && typeof value === "string") folder = value;
      } else if (node.type === "call" && node.subject) {
        const target = propertyOf(node.subject), args = node.args.map(arg => literalOf(arg, ctx)), value = args.length === 1 ? args[0] : args;
        if (target?.type === "note") {
          if (["startsWith", "endsWith", "contains", "containsAll"].includes(node.name)) frontmatter[target.name] = isList(target.name) && !Array.isArray(value) ? [value] : value;
          else if (node.name === "containsAny") { const first = Array.isArray(value) ? value[0] : value; frontmatter[target.name] = isList(target.name) ? [first] : first; }
        } else if (target?.type === "file") {
          if (target.name === "file" && node.name === "hasTag") { const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as unknown[] : []; for (const tag of args) if (typeof tag === "string") tags.push(tag.replace(/^#/, "")); frontmatter.tags = tags; }
          else if (target.name === "file" && node.name === "inFolder" && typeof value === "string") folder = value;
          else if (target.name === "file" && node.name === "hasProperty" && typeof value === "string") frontmatter[value] = null;
          else if (target.name === "tags" && node.name === "containsAny") frontmatter.tags = [String(Array.isArray(value) ? value[0] : value).replace(/^#/, "")];
          else if (target.name === "tags" && ["contains", "containsAll"].includes(node.name)) frontmatter.tags = (Array.isArray(value) ? value : [value]).map(tag => String(tag).replace(/^#/, ""));
        }
      }
    } catch { /* rules that are not simple literals contribute nothing */ }
  }
  return { frontmatter, folder };
}
