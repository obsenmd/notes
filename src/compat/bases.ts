import moment from "moment";
import type { TFile } from "./vault";
import type { App } from "./plugin";
import { Component } from "./component";
import { getIcon, setIcon } from "./utilities";

const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
const pad2 = (value: number) => String(value).padStart(2, "0");
const printDate = (date: Date) => `${String(date.getFullYear()).padStart(4, "0")}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const printTime = (date: Date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
function child<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const el = parent.ownerDocument.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}
/** Case-insensitive own-key lookup, as frontmatter keys are matched. */
export function resolveKey(record: Record<string, unknown>, key: string): string {
  if (Object.hasOwn(record, key)) return key;
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(record)) if (candidate.toLowerCase() === lower) return candidate;
  return key;
}

/** Value objects used by Bases queries and formula-facing plugin APIs. */
export abstract class Value {
  static type = "any";
  icon = "lucide-file-question";
  abstract toString(): string;
  abstract isTruthy(): boolean;
  /** Called only with a value of the same class; see the static helpers for mixed comparisons. */
  equals(other: this): boolean { return this.toString() === other.toString(); }
  looseEquals(_other: Value): boolean { return false; }
  renderTo(el: HTMLElement, _ctx: RenderContext): void { el.textContent = this.toString(); }
  /** Names reachable through `value.name`. */
  keys(): string[] { return []; }
  /** Property access used by formulas; null when the member does not exist. */
  objectAccess(_key: string): Value | null { return null; }
  static equals(a: Value | null, b: Value | null): boolean {
    if (a === b) return true;
    return !!a && !!b && a.constructor === b.constructor && a.equals(b as never);
  }
  static looseEquals(a: Value | null, b: Value | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (a.constructor === b.constructor && a.equals(b as never)) || a.looseEquals(b) || b.looseEquals(a);
  }
}

export abstract class NotNullValue extends Value {}

export abstract class PrimitiveValue<T> extends NotNullValue {
  constructor(readonly value: T) { super(); }
  /** The reference's name for the wrapped primitive. */
  get data(): T { return this.value; }
  toString(): string { return String(this.value); }
  isTruthy(): boolean { return Boolean(this.value); }
  override equals(other: this): boolean { return this.value === other.value; }
  // eslint-disable-next-line eqeqeq
  override looseEquals(other: Value): boolean { return other instanceof PrimitiveValue && this.value == other.value; }
}

export class StringValue extends PrimitiveValue<string> {
  static type = "string";
  override icon = "lucide-text";
  override keys(): string[] { return ["length"]; }
  override objectAccess(key: string): Value | null { return key.toLowerCase() === "length" ? new NumberValue(this.value.length) : null; }
}
export class NumberValue extends PrimitiveValue<number> {
  static type = "number";
  override icon = "lucide-binary";
  override renderTo(el: HTMLElement): void { el.textContent = Number.isFinite(this.value) || Number.isNaN(this.value) ? this.toString() : "∞"; }
}
export class BooleanValue extends PrimitiveValue<boolean> {
  static type = "boolean";
  override icon = "lucide-check-square";
  override renderTo(el: HTMLElement): void { const input = child(el, "input"); input.type = "checkbox"; input.disabled = true; input.checked = this.value; }
}

export class NullValue extends Value {
  static type = "null";
  static readonly value = new NullValue();
  private constructor() { super(); }
  toString(): string { return ""; }
  isTruthy(): boolean { return false; }
  override equals(): boolean { return true; }
  override renderTo(): void {}
}

export class ErrorValue extends Value {
  static type = "error";
  override icon = "lucide-alert-triangle";
  readonly message: string;
  constructor(error?: unknown) { super(); this.message = error instanceof Error || error instanceof ErrorValue ? error.message : error == null ? "" : String(error); }
  toString(): string { return `Error: ${this.message}`; }
  isTruthy(): boolean { return false; }
  override equals(other: this): boolean { return other.message === this.message; }
  override renderTo(el: HTMLElement): void {
    const wrap = child(el, "div", "bases-formula-error"); wrap.setAttribute("aria-label", this.message);
    setIcon(child(wrap, "div", "warning-icon"), "lucide-alert-triangle");
    child(wrap, "div", "bases-formula-error-message", this.message);
  }
}

export class ListValue extends NotNullValue {
  static type = "list";
  override icon = "lucide-list";
  readonly value: Value[];
  constructor(value: (unknown | Value)[]) {
    super();
    this.value = value.map(wrapValue);
  }
  get data(): Value[] { return this.value; }
  toString(): string { return this.value.map((item) => item.toString()).join(", "); }
  isTruthy(): boolean { return this.value.length > 0; }
  includes(value: Value): boolean { return this.value.some((item) => Value.looseEquals(value, item)); }
  length(): number { return this.value.length; }
  get(index: number): Value { return this.value[index] ?? NullValue.value; }
  concat(other: ListValue): ListValue { return new ListValue([...this.value, ...other.value]); }
  private compare(other: ListValue, same: (a: Value, b: Value) => boolean): boolean {
    return this.value.length === other.value.length && this.value.every((item, index) => same(item, other.value[index]!));
  }
  override equals(other: this): boolean { return this.compare(other, Value.equals); }
  override looseEquals(other: Value): boolean {
    return other instanceof ListValue ? this.compare(other, Value.looseEquals) : this.value.length === 1 && Value.looseEquals(this.value[0]!, other);
  }
  numbers(): number[] { return this.value.filter((item): item is NumberValue => item instanceof NumberValue).map((item) => item.value); }
  dates(): Date[] {
    const dates: Date[] = [];
    for (const item of this.value) {
      const date = item instanceof DateValue ? item : item instanceof StringValue ? DateValue.parseFromString(item.value) : null;
      if (date) dates.push(date.date);
    }
    return dates;
  }
  flatten(): ListValue {
    const out: Value[] = [];
    const visit = (items: Value[]) => { for (const item of items) item instanceof ListValue ? visit(item.value) : out.push(item); };
    visit(this.value);
    return new ListValue(out);
  }
  unique(): ListValue {
    const seen = new Map<string, Value[]>(), out: Value[] = [];
    for (const item of this.value) {
      const key = item.toString(), bucket = seen.get(key) ?? [];
      if (bucket.some((other) => Value.equals(item, other))) continue;
      bucket.push(item); seen.set(key, bucket); out.push(item);
    }
    return new ListValue(out);
  }
  sort(): ListValue {
    const key = (item: Value) => item instanceof PrimitiveValue ? item.value as unknown : item.toString();
    return new ListValue([...this.value].sort((a, b) => {
      const x = key(a), y = key(b);
      return typeof x === "number" && typeof y === "number" ? x - y : naturalCompare(String(x), String(y));
    }));
  }
  override keys(): string[] { return ["length"]; }
  override objectAccess(key: string): Value | null { return key.toLowerCase() === "length" ? new NumberValue(this.value.length) : null; }
  override renderTo(el: HTMLElement, ctx: RenderContext): void {
    const container = child(el, "div", "value-list-container");
    this.value.forEach((item, index) => {
      item.renderTo(child(container, "span", "value-list-element"), ctx);
      if (index < this.value.length - 1) child(container, "span", "value-list-gap", "\n");
    });
  }
}

export class ObjectValue extends NotNullValue {
  static type = "object";
  override icon = "lucide-list";
  private cache = new Map<string, Value>();
  /** `convert` turns raw members into values lazily; frontmatter uses it to recognise links, dates and tags. */
  constructor(readonly value: Record<string, unknown>, private readonly convert: (key: string, raw: unknown) => Value = (_key, raw) => wrapValue(raw)) { super(); }
  get data(): Record<string, unknown> { return this.value; }
  toString(): string { return JSON.stringify(Object.fromEntries(Object.keys(this.value).map((key) => [key, this.get(key)?.toString() ?? ""]))); }
  isTruthy(): boolean { return Object.keys(this.value).length > 0; }
  isEmpty(): boolean { return Object.keys(this.value).length === 0; }
  get(key: string): Value | null {
    if (!Object.prototype.hasOwnProperty.call(this.value, key)) return NullValue.value;
    let value = this.cache.get(key);
    if (!value) this.cache.set(key, value = this.convert(key, this.value[key]));
    return value;
  }
  getInsensitive(key: string): Value { return this.get(resolveKey(this.value, key)) ?? NullValue.value; }
  values(): Value[] { return Object.keys(this.value).map((key) => this.get(key) ?? NullValue.value); }
  override equals(other: this): boolean {
    const keys = Object.keys(this.value);
    return keys.length === Object.keys(other.value).length && keys.every((key) => Object.hasOwn(other.value, key) && Value.equals(this.get(key), other.get(key)));
  }
  override keys(): string[] { return Object.keys(this.value); }
  override objectAccess(key: string): Value | null { return this.getInsensitive(key); }
}

export class RegExpValue extends NotNullValue {
  static type = "regexp";
  override icon = "lucide-regex";
  constructor(readonly regexp: RegExp) { super(); }
  toString(): string { return this.regexp.toString(); }
  isTruthy(): boolean { return true; }
}

export class DateValue extends NotNullValue {
  static type = "date";
  constructor(readonly date: Date, readonly time = true) { super(); this.icon = time ? "lucide-clock" : "lucide-calendar"; }
  toString(): string { return this.time ? `${printDate(this.date)}T${printTime(this.date)}` : printDate(this.date); }
  printDate(): string { return printDate(this.date); }
  printTime(): string { return printTime(this.date); }
  dateOnly(): DateValue { return this.time ? new DateValue(new Date(`${printDate(this.date)}T00:00:00`), false) : this; }
  relative(): string { return moment(this.date).fromNow(); }
  isTruthy(): boolean { return true; }
  override equals(other: this): boolean { return this.time === other.time && this.date.getTime() === other.date.getTime(); }
  override looseEquals(other: Value): boolean {
    const date = other instanceof StringValue ? DateValue.parseFromString(other.value) ?? other : other;
    if (!(date instanceof DateValue)) return false;
    return this.time && date.time ? this.date.getTime() === date.date.getTime() : this.dateOnly().date.getTime() === date.dateOnly().date.getTime();
  }
  override keys(): string[] { return ["year", "month", "day", "hour", "minute", "second", "millisecond", "timestamp"]; }
  override objectAccess(key: string): Value | null {
    const date = this.date;
    switch (key.toLowerCase()) {
      case "year": return new NumberValue(date.getFullYear());
      case "month": return new NumberValue(date.getMonth() + 1);
      case "day": return new NumberValue(date.getDate());
      case "hour": return new NumberValue(date.getHours());
      case "minute": return new NumberValue(date.getMinutes());
      case "second": return new NumberValue(date.getSeconds());
      case "millisecond": return new NumberValue(date.getMilliseconds());
      case "timestamp": return new NumberValue(date.getTime());
    }
    return null;
  }
  static parseFromString(text: string): DateValue | null {
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(text)) return new DateValue(new Date(text.replace(" ", "T")), true);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new DateValue(new Date(`${text}T00:00:00`), false);
    return null;
  }
  override renderTo(el: HTMLElement): void { el.textContent = moment(this.date).format(this.time ? "L LT" : "L"); }
}

/** A date shown as "3 days ago". */
export class RelativeDateValue extends DateValue {
  override toString(): string { return this.relative(); }
  override renderTo(el: HTMLElement): void { child(el, "span", this.time ? "mod-datetime" : "mod-date", this.relative()); }
}

export class DurationValue extends NotNullValue {
  static type = "duration";
  override icon = "lucide-calendar-range";
  constructor(readonly years: number, readonly months: number, readonly days: number, readonly hours: number, readonly minutes: number, readonly seconds: number, readonly milliseconds: number) { super(); }
  private parts(): number[] { return [this.years, this.months, this.days, this.hours, this.minutes, this.seconds, this.milliseconds]; }
  toString(): string { const [years, months, days, hours, minutes, seconds, milliseconds] = this.parts(); return moment.duration({ years, months, days, hours, minutes, seconds, milliseconds }).humanize(); }
  isTruthy(): boolean { return this.parts().some((part) => part !== 0); }
  override equals(other: this): boolean { const mine = this.parts(); return other.parts().every((part, index) => part === mine[index]); }
  override looseEquals(other: Value): boolean {
    const duration = other instanceof StringValue ? DurationValue.parseFromString(other.value) ?? other : other;
    return duration instanceof DurationValue && this.getMilliseconds() === duration.getMilliseconds();
  }
  addToDate(value: DateValue, subtract = false): DateValue {
    const sign = subtract ? -1 : 1, date = new Date(value.date);
    let time = value.time;
    if (this.years) date.setFullYear(date.getFullYear() + sign * this.years);
    if (this.months) date.setMonth(date.getMonth() + sign * this.months);
    if (this.days) date.setDate(date.getDate() + sign * this.days);
    if (this.hours) { date.setHours(date.getHours() + sign * this.hours); time = true; }
    if (this.minutes) { date.setMinutes(date.getMinutes() + sign * this.minutes); time = true; }
    if (this.seconds) { date.setSeconds(date.getSeconds() + sign * this.seconds); time = true; }
    if (this.milliseconds) { date.setMilliseconds(date.getMilliseconds() + sign * this.milliseconds); time = true; }
    return new DateValue(date, time);
  }
  getMilliseconds(): number { const now = new DateValue(new Date()); return this.addToDate(now).date.getTime() - now.date.getTime(); }
  scale(factor: number): DurationValue { const [y, mo, d, h, mi, s, ms] = this.parts().map((part) => part * factor); return new DurationValue(y!, mo!, d!, h!, mi!, s!, ms!); }
  plus(other: DurationValue, sign = 1): DurationValue { const theirs = other.parts(); const [y, mo, d, h, mi, s, ms] = this.parts().map((part, index) => part + theirs[index]! * sign); return new DurationValue(y!, mo!, d!, h!, mi!, s!, ms!); }
  override keys(): string[] { return ["years", "months", "days", "weeks", "hours", "minutes", "seconds", "milliseconds"]; }
  override objectAccess(key: string): Value | null {
    const unit = key.toLowerCase();
    if (!this.keys().includes(unit)) return null;
    const now = new DateValue(new Date());
    return new NumberValue(moment(this.addToDate(now).date).diff(now.date, unit as moment.unitOfTime.Diff, true));
  }
  static parseFromString(text: string): DurationValue | null {
    const iso = text.match(/P(?:([.,\d]+)Y)?(?:([.,\d]+)M)?(?:([.,\d]+)W)?(?:([.,\d]+)D)?T(?:([.,\d]+)H)?(?:([.,\d]+)M)?(?:([.,\d]+)S)?/);
    if (iso) { const n = (part?: string) => part === undefined ? 0 : parseInt(part); return new DurationValue(n(iso[1]), n(iso[2]), 7 * n(iso[3]) + n(iso[4]), n(iso[5]), n(iso[6]), n(iso[7]), 0); }
    const match = text.match(/^(-?\d+(?:\.\d+)?) ?(ms|[dhmswMy]|(?:millisecond|second|minute|hour|day|week|month|year)s?)$/);
    if (!match) return null;
    const amount = parseFloat(match[1]!), unit = match[2]!.length > 2 ? match[2]!.replace(/s$/, "") : match[2]!;
    switch (unit) {
      case "y": case "year": return new DurationValue(amount, 0, 0, 0, 0, 0, 0);
      case "M": case "month": return new DurationValue(0, amount, 0, 0, 0, 0, 0);
      case "w": case "week": return new DurationValue(0, 0, 7 * amount, 0, 0, 0, 0);
      case "d": case "day": return new DurationValue(0, 0, amount, 0, 0, 0, 0);
      case "h": case "hour": return new DurationValue(0, 0, 0, amount, 0, 0, 0);
      case "m": case "minute": return new DurationValue(0, 0, 0, 0, amount, 0, 0);
      case "s": case "second": return new DurationValue(0, 0, 0, 0, 0, amount, 0);
      case "ms": case "millisecond": return new DurationValue(0, 0, 0, 0, 0, 0, amount);
    }
    return null;
  }
  static fromMilliseconds(milliseconds: number): DurationValue { return new DurationValue(0, 0, 0, 0, 0, 0, milliseconds); }
}

export class IconValue extends StringValue {
  static type = "icon";
  override icon = "lucide-image";
  override renderTo(el: HTMLElement): void { const svg = getIcon(this.value) ?? getIcon("question-mark-glyph"); if (svg) el.append(svg); }
}

export class UrlValue extends StringValue {
  static type = "url";
  override icon = "lucide-link";
  constructor(value: string, readonly display: Value | null = null) { super(value); }
  override equals(other: this): boolean { return this.value === other.value && Value.equals(this.display, other.display); }
  override renderTo(el: HTMLElement, ctx: RenderContext): void { ctx.renderExternalLink(this.value, this.display, el); }
}

export class LinkValue extends StringValue {
  static type = "link";
  override icon = "lucide-link";
  constructor(readonly app: App | null, value: string, readonly sourcePath = "", readonly display: Value | null = null) { super(value); }
  override toString(): string { return `[[${this.value}${this.display ? `|${this.display}` : ""}]]`; }
  override isTruthy(): boolean { return true; }
  override equals(other: this): boolean { return this.value === other.value && this.sourcePath === other.sourcePath && Value.equals(this.display, other.display); }
  override looseEquals(other: Value): boolean {
    if (other instanceof LinkValue) { const mine = this.resolve(), theirs = other.resolve(); return mine && theirs ? mine === theirs : this.value === other.value; }
    if (other instanceof FileValue) return this.resolve() === other.value;
    if (other instanceof StringValue) { const parsed = LinkValue.parseFromString(this.app, other.value, ""); return !!parsed && this.looseEquals(parsed); }
    return false;
  }
  resolve(): TFile | null {
    if (!this.app) return null;
    const dest = this.app.metadataCache.getFirstLinkpathDest(this.value.split("|")[0]!.split("#")[0]!, this.sourcePath);
    return dest ? this.app.vault.getFileByPath(dest.path) : null;
  }
  override renderTo(el: HTMLElement, ctx: RenderContext): void { ctx.renderFileLink(this.value, this.display, el, this.sourcePath); }
  static parseFromString(app: App | null, text: string, sourcePath: string): LinkValue | null {
    if (!text.startsWith("[[") || !text.endsWith("]]")) return null;
    const inner = text.slice(2, -2), bar = inner.lastIndexOf("|");
    return bar < 0 ? new LinkValue(app, inner, sourcePath) : new LinkValue(app, inner.slice(0, bar), sourcePath, new StringValue(inner.slice(bar + 1)));
  }
}

export class ImageValue extends StringValue {
  static type = "image";
  override icon = "lucide-image";
  constructor(value: string, private readonly app: App | null = null) { super(value); }
  override toString(): string { return /^[a-z][a-z\d+.-]*:/i.test(this.value) ? `![](${this.value})` : `![[${this.value}]]`; }
  override renderTo(el: HTMLElement): void {
    if (/^[a-z][a-z\d+.-]*:/i.test(this.value)) { child(el, "img").src = this.value; return; }
    const dest = this.app?.metadataCache.getFirstLinkpathDest(this.value, ""), file = dest ? this.app!.vault.getFileByPath(dest.path) : null;
    if (file && IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) child(el, "img").src = this.app!.vault.getResourcePath(file);
  }
}

export class HTMLValue extends StringValue {
  static type = "html";
  override icon = "lucide-code-2";
  override renderTo(el: HTMLElement): void {
    const parsed = new DOMParser().parseFromString(this.value, "text/html");
    parsed.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
    for (const node of parsed.body.querySelectorAll("*")) for (const attribute of Array.from(node.attributes)) if (attribute.name.toLowerCase().startsWith("on") || /^\s*javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
    el.append(...Array.from(parsed.body.childNodes).map((node) => el.ownerDocument.importNode(node, true)));
  }
}

export class TagValue extends StringValue {
  static type = "tag";
  readonly lowerTag: string;
  constructor(tag: string) { super(tag.startsWith("#") ? tag : `#${tag}`); this.lowerTag = this.value.toLowerCase(); }
  /** True for the tag itself and for any tag nested under it. */
  tagMatches(other: Value): boolean {
    if (!(other instanceof StringValue)) return false;
    const prefix = other instanceof TagValue ? other.lowerTag : (other.value.startsWith("#") ? other.value : `#${other.value}`).toLowerCase();
    return this.lowerTag.startsWith(prefix) && (this.lowerTag.length === prefix.length || this.lowerTag.charAt(prefix.length) === "/");
  }
  override renderTo(el: HTMLElement, ctx: RenderContext): void { ctx.renderTag(this.value, el); }
}

export class TagsValue extends ListValue {
  override icon = "lucide-tags";
  constructor(tags: string[]) { super(tags.map((tag) => new TagValue(tag))); }
  override includes(value: Value): boolean { return this.value.some((tag) => (tag as TagValue).tagMatches(value)); }
}

export class FileValue extends NotNullValue {
  static type = "file";
  override icon = "lucide-file";
  private links?: ListValue; private backlinks?: ListValue; private embeds?: ListValue; private tags?: TagsValue; private props?: ObjectValue;
  constructor(readonly value: TFile, readonly app: App | null = null) { super(); }
  get file(): TFile { return this.value; }
  toString(): string { return this.value.path; }
  isTruthy(): boolean { return true; }
  override equals(other: this): boolean { return this.value === other.value; }
  override looseEquals(other: Value): boolean { return other instanceof StringValue && !(other instanceof LinkValue) && this.value.path === other.value; }
  getLinks(): ListValue {
    if (this.links) return this.links;
    const cache = this.app?.metadataCache.getFileCache(this.value), file = this.value;
    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...frontmatterLinks(cache?.frontmatter)];
    return this.links = new ListValue(refs.map((ref) => new LinkValue(this.app, ref.link, file.path, ref.displayText && ref.displayText !== ref.link ? new StringValue(ref.displayText) : null)));
  }
  getBacklinks(): ListValue {
    if (this.backlinks) return this.backlinks;
    const resolved = this.app?.metadataCache.resolvedLinks ?? {}, out: Value[] = [];
    for (const source in resolved) if (Object.hasOwn(resolved[source]!, this.value.path)) out.push(new LinkValue(this.app, source, "", new StringValue(source.slice(source.lastIndexOf("/") + 1).replace(/\.md$/i, ""))));
    return this.backlinks = new ListValue(out);
  }
  getEmbeds(): ListValue {
    return this.embeds ??= new ListValue((this.app?.metadataCache.getFileCache(this.value)?.embeds ?? []).map((ref) => new LinkValue(this.app, ref.link, this.value.path, ref.displayText && ref.displayText !== ref.link ? new StringValue(ref.displayText) : null)));
  }
  getTags(): TagsValue {
    if (this.tags) return this.tags;
    const cache = this.app?.metadataCache.getFileCache(this.value), tags = (cache?.tags ?? []).map((tag) => tag.tag);
    const raw = cache?.frontmatter ? cache.frontmatter[resolveKey(cache.frontmatter, "tags")] ?? cache.frontmatter[resolveKey(cache.frontmatter, "tag")] : null;
    for (const tag of Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : []) if (typeof tag === "string" && tag.trim()) tags.push(tag.trim().startsWith("#") ? tag.trim() : `#${tag.trim()}`);
    return this.tags = new TagsValue([...new Set(tags)]);
  }
  getProps(): ObjectValue { return this.props ??= frontmatterValue(this.app, this.value, this.app?.metadataCache.getFileCache(this.value)?.frontmatter ?? {}); }
  override keys(): string[] { return ["file", "name", "basename", "fullname", "path", "folder", "ext", "ctime", "mtime", "size", "links", "embeds", "backlinks", "tags", "properties"]; }
  override objectAccess(key: string): Value | null {
    const file = this.value;
    switch (key.toLowerCase()) {
      case "file": return this;
      case "name": return new StringValue(file.extension.toLowerCase() === "md" ? file.basename : file.name);
      case "basename": return new StringValue(file.basename);
      case "fullname": return new StringValue(file.name);
      case "path": return new StringValue(file.path);
      case "folder": return new StringValue(file.parent?.path || "/");
      case "ext": return new StringValue(file.extension);
      case "ctime": return new DateValue(new Date(file.stat.ctime));
      case "mtime": return new DateValue(new Date(file.stat.mtime));
      case "size": return new NumberValue(file.stat.size);
      case "links": return this.getLinks();
      case "embeds": return this.getEmbeds();
      case "backlinks": return this.getBacklinks();
      case "tags": return this.getTags();
      case "properties": return this.getProps();
    }
    return null;
  }
  override renderTo(el: HTMLElement, ctx: RenderContext): void { ctx.renderFileLink(this.value, null, el); }
}

function frontmatterLinks(frontmatter: Record<string, unknown> | undefined): Array<{ link: string; displayText?: string }> {
  const out: Array<{ link: string; displayText?: string }> = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") { const match = value.match(/^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/); if (match) out.push({ link: match[1]!, displayText: match[2] }); }
    else if (Array.isArray(value)) value.forEach(visit);
  };
  if (frontmatter) Object.values(frontmatter).forEach(visit);
  return out;
}

/** Wraps a frontmatter mapping so that `tags`, wikilinks, URLs and ISO dates become typed values. */
export function frontmatterValue(app: App | null, file: TFile | null, frontmatter: Record<string, unknown>): ObjectValue {
  const sourcePath = file?.path ?? "";
  const convert = (key: string | null, raw: unknown): Value => {
    if (key !== null && key.toLowerCase() === "tags") {
      if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) return new TagsValue(raw as string[]);
      if (typeof raw === "string") return new TagsValue(raw.split(/[\s,]+/).filter(Boolean));
    }
    if (typeof raw === "string") {
      const link = LinkValue.parseFromString(app, raw, sourcePath);
      if (link) return link;
      if (/^(https?|obsidian|file|mailto):\/?\/?\S+$/i.test(raw)) return new UrlValue(raw);
      return DateValue.parseFromString(raw) ?? new StringValue(raw);
    }
    if (raw instanceof Date) return new DateValue(raw);
    if (Array.isArray(raw)) return new ListValue(raw.map((item) => convert(null, item)));
    if (raw && typeof raw === "object" && !(raw instanceof Value)) return new ObjectValue(raw as Record<string, unknown>, convert);
    return wrapValue(raw);
  };
  return new ObjectValue({ ...frontmatter }, convert);
}

export class BasesEntry {
  constructor(readonly file: TFile, private readonly values: Map<string, Value | null> = new Map()) {}
  getValue(propertyId: BasesPropertyId): Value | null { return this.values.get(propertyId) ?? null; }
}

export class BasesEntryGroup {
  constructor(public key: Value | undefined, public entries: BasesEntry[]) {}
  hasKey(): boolean { return this.key !== undefined && !(this.key instanceof NullValue); }
}

export class BasesQueryResult {
  constructor(public data: BasesEntry[] = [], private visibleProperties: BasesPropertyId[] = [], private groups?: BasesEntryGroup[]) {}
  get groupedData(): BasesEntryGroup[] {
    if (this.groups) return this.groups;
    return [new BasesEntryGroup(undefined, this.data)];
  }
  get properties(): BasesPropertyId[] { return [...this.visibleProperties]; }
  getSummaryValue(_queryController: QueryController, entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
    const values = entries.map((entry) => entry.getValue(prop) ?? NullValue.value);
    const present = values.filter((value) => !(value instanceof NullValue));
    const key = summaryKey.trim().toLocaleLowerCase().replace(/[ _-]+/g, "");
    if (key === "count" || key === "filled") return new NumberValue(present.length);
    if (key === "countunique" || key === "unique") {
      return new NumberValue(new Set(present.map((value) => stableValueKey(value))).size);
    }
    if (key === "empty" || key === "countempty") return new NumberValue(values.length - present.length);
    if (key === "checked" || key === "true") return new NumberValue(present.filter(isTrue).length);
    if (key === "unchecked" || key === "false") return new NumberValue(present.filter((value) => !isTrue(value)).length);

    const numbers = present.map(toNumeric).filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
    if (key === "sum") return numbers.length ? new NumberValue(numbers.reduce((sum, value) => sum + value, 0)) : NullValue.value;
    if (key === "average" || key === "avg" || key === "mean") return numbers.length ? new NumberValue(numbers.reduce((sum, value) => sum + value, 0) / numbers.length) : NullValue.value;
    if (key === "min" || key === "minimum" || key === "earliest") return sortedValues(present)[0] ?? NullValue.value;
    if (key === "max" || key === "maximum" || key === "latest") return sortedValues(present).at(-1) ?? NullValue.value;
    if (key === "range") return numbers.length ? new NumberValue(numbers.at(-1)! - numbers[0]!) : NullValue.value;
    if (key === "median") {
      const middle = Math.floor(numbers.length / 2);
      return numbers.length ? new NumberValue(numbers.length % 2 ? numbers[middle]! : (numbers[middle - 1]! + numbers[middle]!) / 2) : NullValue.value;
    }
    if (key === "percenttrue" || key === "percentchecked") return values.length ? new NumberValue(present.filter(isTrue).length / values.length * 100) : NullValue.value;
    return NullValue.value;
  }
}

/** Options for evaluating the structural portion of a Bases query. Formula-string
 * filters are left to the caller; predicates can evaluate them with its formula runtime. */
export interface BasesQueryOptions {
  properties?: BasesPropertyId[];
  filter?: (entry: BasesEntry) => boolean;
  sort?: Array<{ property: BasesPropertyId; direction?: "ASC" | "DESC" | "asc" | "desc" }>;
  groupBy?: BasesPropertyId;
  limit?: number;
}

/** Build a deterministic result from candidate rows, applying filter, sort, limit,
 * then grouping in the same order that a view consumes the data. */
export function executeBasesQuery(entries: Iterable<BasesEntry>, options: BasesQueryOptions = {}): BasesQueryResult {
  let data = [...entries];
  if (options.filter) data = data.filter(options.filter);
  if (options.sort?.length) data.sort((a, b) => {
    for (const sort of options.sort!) {
      const av = a.getValue(sort.property) ?? NullValue.value;
      const bv = b.getValue(sort.property) ?? NullValue.value;
      const direction = sort.direction?.toLocaleLowerCase() === "desc" ? -1 : 1;
      const compared = compareValues(av, bv);
      if (compared) return compared * direction;
    }
    return a.file.path.localeCompare(b.file.path);
  });
  if (options.limit !== undefined && Number.isFinite(options.limit)) data = data.slice(0, Math.max(0, Math.floor(options.limit)));
  let groups: BasesEntryGroup[] | undefined;
  if (options.groupBy) {
    const grouped = new Map<string, { key: Value; entries: BasesEntry[] }>();
    for (const entry of data) {
      const key = entry.getValue(options.groupBy) ?? NullValue.value;
      const stableKey = stableValueKey(key);
      let group = grouped.get(stableKey);
      if (!group) grouped.set(stableKey, group = { key, entries: [] });
      group.entries.push(entry);
    }
    groups = [...grouped.values()].map(({ key, entries: groupEntries }) => new BasesEntryGroup(key, groupEntries));
  }
  return new BasesQueryResult(data, options.properties ?? [], groups);
}

function stableValueKey(value: Value): string {
  if (value instanceof NumberValue) return `number:${value.value}`;
  if (value instanceof BooleanValue) return `boolean:${value.value}`;
  if (value instanceof NullValue) return "null:";
  if (value instanceof ListValue) return `list:${value.value.map(stableValueKey).join("|")}`;
  return `${(value.constructor as typeof Value).type}:${value.toString().trim().toLocaleLowerCase()}`;
}

function isTrue(value: Value): boolean {
  return value instanceof BooleanValue ? value.value : value.isTruthy();
}

function toNumeric(value: Value): number | null {
  if (value instanceof NumberValue) return value.value;
  if (value instanceof BooleanValue) return value.value ? 1 : 0;
  if (value instanceof DateValue) return value.date.getTime();
  if (value instanceof DurationValue) return value.getMilliseconds();
  if (value instanceof StringValue && value.value.trim() !== "") {
    const parsed = Number(value.value);
    if (Number.isFinite(parsed)) return parsed;
    const date = Date.parse(value.value);
    return Number.isFinite(date) ? date : null;
  }
  return null;
}

function sortedValues(values: Value[]): Value[] {
  return [...values].sort(compareValues);
}

/** Natural, case-insensitive ordering used for names and group keys. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compareValues(a: Value, b: Value): number {
  if (a instanceof NullValue) return b instanceof NullValue ? 0 : -1;
  if (b instanceof NullValue) return 1;
  const an = toNumeric(a), bn = toNumeric(b);
  if (an !== null && bn !== null) return an - bn;
  return naturalCompare(a.toString(), b.toString());
}

export type BasesPropertyType = "note" | "formula" | "file";
export type BasesPropertyId = `${BasesPropertyType}.${string}`;
export interface BasesProperty { type: BasesPropertyType; name: string }
export class QueryController extends Component {}

/** Renders links and tags inside value cells the way the host application does. */
export class RenderContext {
  hoverPopover: unknown = null;
  constructor(readonly app: App | null = null) {}
  renderFileLink(target: TFile | string, display: Value | null, el: HTMLElement, sourcePath = ""): void {
    const app = this.app;
    let path: string, file: TFile | null;
    if (typeof target === "string") {
      const dest = app?.metadataCache.getFirstLinkpathDest(target.split("#")[0]!, sourcePath) ?? null;
      file = dest ? app!.vault.getFileByPath(dest.path) : null; path = target;
    } else { file = target; path = target.path; }
    el.classList.add("markdown-rendered");
    const link = child(el, "span", "internal-link");
    if (display) display.renderTo(link, this);
    else if (typeof target === "string") link.textContent = target.slice(target.lastIndexOf("/") + 1).replace(/\.md(?=#|$)/i, "").replace(/#\^?/g, " > ").replace(/^ > /, "");
    else link.textContent = file!.extension.toLowerCase() === "md" ? file!.basename : file!.name;
    link.dataset.href = path;
    link.classList.toggle("is-unresolved", !file);
    const open = (event: MouseEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      void app?.workspace.openLinkText(path, sourcePath, event.button === 1 || event.ctrlKey || event.metaKey);
    };
    link.addEventListener("click", open);
    link.addEventListener("auxclick", open);
  }
  renderExternalLink(url: string, display: Value | null, el: HTMLElement): void {
    const link = child(el, "a", "external-link");
    link.href = url; link.target = "_blank"; link.rel = "noopener";
    if (display) display.renderTo(link, this); else link.textContent = url;
  }
  renderTag(tag: string, el: HTMLElement): void {
    const name = tag.replace(/^#/, "");
    const link = child(el, "a", "tag", name);
    link.addEventListener("click", (event) => { event.preventDefault(); this.app?.workspace.trigger("search:open", `tag:#${name}`); });
  }
}

export function parsePropertyId(propertyId: BasesPropertyId | string): BasesProperty {
  const dot = propertyId.indexOf(".");
  const type = dot < 0 ? "" : propertyId.slice(0, dot);
  if (type !== "note" && type !== "formula" && type !== "file") return { type: "note", name: propertyId };
  return { type, name: propertyId.slice(dot + 1) };
}

export function wrapValue(value: unknown): Value {
  if (value instanceof Value) return value;
  if (value === null || value === undefined || typeof value === "function") return NullValue.value;
  if (typeof value === "string") return new StringValue(value);
  if (typeof value === "number") return new NumberValue(value);
  if (typeof value === "boolean") return new BooleanValue(value);
  if (Array.isArray(value)) return new ListValue(value);
  if (value instanceof Date) return new DateValue(new Date(value));
  if (typeof value === "object") return new ObjectValue(value as Record<string, unknown>);
  return new StringValue(String(value));
}
