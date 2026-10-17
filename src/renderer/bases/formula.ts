import moment from "moment";
import type { App } from "../../compat/plugin";
import {
  BooleanValue, DateValue, DurationValue, ErrorValue, FileValue, HTMLValue, IconValue, ImageValue, LinkValue, ListValue, NotNullValue, NullValue, NumberValue,
  ObjectValue, RegExpValue, RelativeDateValue, StringValue, TagValue, UrlValue, Value, wrapValue,
} from "../../compat/bases";
import { t } from "../../i18n";

/** What an expression is evaluated against: a note row, a summary's value list, or a nested `map`/`filter` scope. */
export interface FormulaContext {
  app: App | null;
  getByIdentifier(id: string): Value | null;
}

export type Node =
  | { type: "empty" }
  | { type: "invalid"; text: string; error?: string }
  | { type: "primitive"; value: string | number | boolean | null }
  | { type: "regexp"; value: RegExpValue }
  | { type: "ident"; id: string }
  | { type: "array"; elements: Node[] }
  | { type: "paren"; expr: Node }
  | { type: "not"; expr: Node }
  | { type: "negate"; expr: Node }
  | { type: "compare"; op: string; left: Node; right: Node }
  | { type: "math"; op: string; left: Node; right: Node }
  | { type: "object_access"; object: Node; index: string }
  | { type: "array_access"; array: Node; index: Node }
  | { type: "call"; name: string; subject: Node | null; args: Node[] };

// ---------------------------------------------------------------------------------------------------------------------
// Tokenizer and parser

interface Token { kind: "num" | "str" | "id" | "op" | "regexp" | "end"; text: string; pos: number; value?: string | number; flags?: string }
const OPERATORS = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]", ",", "."];
const IDENT_START = /[\p{L}_$]/u, IDENT_PART = /[\p{L}\p{N}_$]/u;

class ParseError extends Error {}
const fail = (pos: number): never => { throw new ParseError(t("obsen.bases.error-parse-position", { position: pos })); };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  // A slash starts a regular expression only where an operand is expected.
  const operandExpected = () => { const last = tokens.at(-1); return !last || (last.kind === "op" && last.text !== ")" && last.text !== "]"); };
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (/\d/.test(ch) || (ch === "." && /\d/.test(source[i + 1] ?? ""))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))!;
      i += match[0].length;
      tokens.push({ kind: "num", text: match[0], pos: start, value: parseFloat(match[0]) });
    } else if (ch === '"' || ch === "'") {
      let text = ""; i++;
      for (;;) {
        if (i >= source.length) fail(start);
        const c = source[i++]!;
        if (c === ch) break;
        if (c !== "\\") { text += c; continue; }
        const escaped = source[i++];
        if (escaped === undefined) fail(start);
        else if (escaped === "n") text += "\n";
        else if (escaped === "t") text += "\t";
        else if (escaped === "r") text += "\r";
        else if (escaped === "u" && /^[\da-fA-F]{4}/.test(source.slice(i))) { text += String.fromCharCode(parseInt(source.slice(i, i + 4), 16)); i += 4; }
        else text += escaped;
      }
      tokens.push({ kind: "str", text: source.slice(start, i), pos: start, value: text });
    } else if (IDENT_START.test(ch)) {
      while (i < source.length && IDENT_PART.test(source[i]!)) i++;
      tokens.push({ kind: "id", text: source.slice(start, i), pos: start });
    } else if (ch === "/" && operandExpected()) {
      let inClass = false; i++;
      for (;; i++) {
        if (i >= source.length) fail(start);
        const c = source[i]!;
        if (c === "\\") i++;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      const pattern = source.slice(start + 1, i); i++;
      const flagStart = i;
      while (i < source.length && /[a-z]/.test(source[i]!)) i++;
      tokens.push({ kind: "regexp", text: source.slice(start, i), pos: start, value: pattern, flags: source.slice(flagStart, i) });
    } else {
      const op = OPERATORS.find(candidate => source.startsWith(candidate, i));
      if (!op) fail(i);
      i += op!.length;
      tokens.push({ kind: "op", text: op!, pos: start });
    }
  }
  tokens.push({ kind: "end", text: "", pos: source.length });
  return tokens;
}

/** Token ranges for the formula editor's reference syntax classes. */
export function formulaTokenRanges(source: string): Array<{ from: number; to: number; className: string }> {
  try {
    return tokenize(source).filter(token => token.kind !== "end" && token.text !== ".").map(token => ({
      from: token.pos, to: token.pos + token.text.length,
      className: "token " + (token.kind === "num" ? "number" : token.kind === "str" ? "string" : token.kind === "regexp" ? "regex" : token.kind === "id" ? /^(true|false|null)$/.test(token.text) ? "boolean" : "property" : /^[()[\],]$/.test(token.text) ? "punctuation" : "operator"),
    }));
  } catch { return []; }
}

const BINARY: Array<{ ops: string[]; type: "compare" | "math" }> = [
  { ops: ["||"], type: "compare" }, { ops: ["&&"], type: "compare" }, { ops: ["==", "!="], type: "compare" },
  { ops: ["<", ">", "<=", ">="], type: "compare" }, { ops: ["+", "-"], type: "math" }, { ops: ["*", "/", "%"], type: "math" },
];

function parseTokens(tokens: Token[]): Node {
  let at = 0;
  const peek = () => tokens[at]!;
  const isOp = (text: string) => peek().kind === "op" && peek().text === text;
  const expect = (text: string) => { if (!isOp(text)) fail(peek().pos); at++; };
  const list = (close: string): Node[] => {
    const items: Node[] = [];
    while (!isOp(close)) {
      items.push(binary(0));
      if (isOp(",")) at++; else if (!isOp(close)) fail(peek().pos);
    }
    at++;
    return items;
  };
  const primary = (): Node => {
    const token = tokens[at++]!;
    if (token.kind === "num") return { type: "primitive", value: token.value as number };
    if (token.kind === "str") return { type: "primitive", value: token.value as string };
    if (token.kind === "regexp") {
      try { return { type: "regexp", value: new RegExpValue(new RegExp(token.value as string, token.flags)) }; }
      catch { throw new ParseError(t("obsen.bases.error-regexp-position", { position: token.pos })); }
    }
    if (token.kind === "id") {
      if (token.text === "true" || token.text === "false") return { type: "primitive", value: token.text === "true" };
      if (token.text === "null") return { type: "primitive", value: null };
      return { type: "ident", id: token.text };
    }
    if (token.kind === "op" && token.text === "(") { const expr = binary(0); expect(")"); return { type: "paren", expr }; }
    if (token.kind === "op" && token.text === "[") return { type: "array", elements: list("]") };
    return fail(token.pos);
  };
  const postfix = (): Node => {
    let node = primary();
    for (;;) {
      if (isOp(".")) {
        at++;
        const name = tokens[at++]!;
        if (name.kind !== "id") fail(name.pos);
        node = { type: "object_access", object: node, index: name.text };
      } else if (isOp("[")) {
        at++;
        const index = binary(0); expect("]");
        node = { type: "array_access", array: node, index };
      } else if (isOp("(")) {
        const open = peek().pos; at++;
        const args = list(")");
        if (node.type === "ident") node = { type: "call", name: node.id, subject: null, args };
        else if (node.type === "object_access") node = { type: "call", name: node.index, subject: node.object, args };
        else throw new ParseError(t("obsen.bases.error-function-name-position", { position: open }));
      } else return node;
    }
  };
  const unary = (): Node => {
    if (isOp("!")) { at++; return { type: "not", expr: unary() }; }
    if (isOp("-")) {
      at++;
      const expr = unary();
      return expr.type === "primitive" && typeof expr.value === "number" ? { type: "primitive", value: -expr.value } : { type: "negate", expr };
    }
    return postfix();
  };
  const binary = (level: number): Node => {
    if (level >= BINARY.length) return unary();
    let left = binary(level + 1);
    const { ops, type } = BINARY[level]!;
    while (peek().kind === "op" && ops.includes(peek().text)) {
      const op = tokens[at++]!.text;
      left = { type, op, left, right: binary(level + 1) };
    }
    return left;
  };
  const node = binary(0);
  if (peek().kind !== "end") fail(peek().pos);
  return node;
}

export function parseFormula(text: string): Node {
  if (text.trim() === "") return { type: "empty" };
  try { return parseTokens(tokenize(text)); }
  catch (error) {
    if (error instanceof ParseError) return { type: "invalid", text, error: error.message };
    return { type: "invalid", text, error: t("formulas.msg-error-parse-formula", { formula: JSON.stringify(text) }) };
  }
}

/** True when a property name cannot be written as a bare identifier and needs `note["..."]`. */
export function needsQuoting(name: string): boolean {
  const node = parseFormula(name);
  return node.type !== "ident" || node.id !== name;
}

// ---------------------------------------------------------------------------------------------------------------------
// Functions

type ValueClass = abstract new (...args: never[]) => Value;
interface Param { name: string; type: ValueClass[]; optional?: boolean; variadic?: boolean; widget?: string }
export interface FormulaFunction {
  name: string;
  params: Param[];
  /** Boolean predicates are offered as operators by the filter builder. */
  predicate?: boolean;
  apply(ctx: FormulaContext, ...args: Array<Value | null>): Value | null;
}

const p = (name: string, ...type: ValueClass[]): Param => ({ name, type });
const opt = (name: string, ...type: ValueClass[]): Param => ({ name, type, optional: true });
const rest = (name: string, ...type: ValueClass[]): Param => ({ name, type, variadic: true });
const widget = (name: string, customWidget: string, ...type: ValueClass[]): Param => ({ name, type, widget: customWidget });
/** Everything except null, mirroring the reference's "not null" parameter type. */
const NotNull = NotNullValue as ValueClass;
const typeName = (value: Value | ValueClass) => { const type = (typeof value === "function" ? value : value.constructor) as unknown as { type: string }; return type.type.charAt(0).toUpperCase() + type.type.slice(1); };

const globals = new Map<string, FormulaFunction>();
const methods = new Map<ValueClass, Map<string, FormulaFunction>>();
function define(owner: ValueClass | null, name: string, params: Param[], apply: (ctx: FormulaContext, ...args: any[]) => Value | null | boolean): void {
  const fn: FormulaFunction = { name, params, apply: (ctx, ...args) => { const result = apply(ctx, ...args); return typeof result === "boolean" ? new BooleanValue(result) : result; } };
  if (!owner) { globals.set(name.toLowerCase(), fn); return; }
  let table = methods.get(owner);
  if (!table) methods.set(owner, table = new Map());
  table.set(name.toLowerCase(), fn);
}
function predicate(owner: ValueClass, name: string, params: Param[], apply: (ctx: FormulaContext, ...args: any[]) => boolean): void {
  define(owner, name, params, apply);
  methods.get(owner)!.get(name.toLowerCase())!.predicate = true;
}
function prototypeChain(value: Value): ValueClass[] {
  const chain: ValueClass[] = [];
  for (let type = value.constructor as ValueClass; type; type = Object.getPrototypeOf(type) as ValueClass) { chain.push(type); if (type === (Value as ValueClass)) break; }
  return chain;
}
export function findMethod(value: Value, name: string): FormulaFunction | null {
  const lower = name.toLowerCase();
  for (const type of prototypeChain(value)) { const fn = methods.get(type)?.get(lower); if (fn) return fn; }
  return null;
}
/** Methods callable on a value, nearest class first. */
export function methodsFor(value: Value): FormulaFunction[] {
  const found = new Map<string, FormulaFunction>();
  for (const type of prototypeChain(value)) for (const [name, fn] of methods.get(type) ?? []) if (!found.has(name)) found.set(name, fn);
  return [...found.values()];
}
export function serializeCall(fn: FormulaFunction, subject: string, args: string[]): string { return `${subject}.${fn.name}(${args.join(", ")})`; }

const str = (value: string) => new StringValue(value);
const num = (value: number) => new NumberValue(value);
const numbersOrNull = (list: ListValue, reduce: (numbers: number[]) => number): Value => { const numbers = list.numbers(); return numbers.length ? num(reduce(numbers)) : NullValue.value; };
const linkpath = (text: string) => text.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.split("#")[0]!;
const resolveFile = (ctx: FormulaContext, path: string) => { const dest = ctx.app?.metadataCache.getFirstLinkpathDest(linkpath(path), "") ?? null; return dest ? ctx.app!.vault.getFileByPath(dest.path) : null; };
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

define(null, "now", [], () => new DateValue(new Date(), true));
define(null, "today", [], () => new DateValue(new Date()).dateOnly());
define(null, "date", [p("input", StringValue, DateValue)], (_ctx, input: StringValue | DateValue) => {
  if (input instanceof DateValue) return input;
  const parsed = DateValue.parseFromString(input.value);
  if (parsed) return parsed;
  const digits = input.value;
  if (/^\d{12}$/.test(digits)) return new DateValue(new Date(+digits.slice(0, 4), +digits.slice(4, 6) - 1, +digits.slice(6, 8), +digits.slice(8, 10), +digits.slice(10, 12)), true);
  if (/^\d{8}$/.test(digits)) return new DateValue(new Date(+digits.slice(0, 4), +digits.slice(4, 6) - 1, +digits.slice(6, 8)), false);
  return NullValue.value;
});
define(null, "random", [], () => num(Math.random()));
define(null, "min", [rest("inputs", NumberValue)], (_ctx, ...inputs: Array<NumberValue | null>) => { const values = inputs.filter(Boolean).map(input => input!.value); return values.length ? num(Math.min(...values)) : null; });
define(null, "max", [rest("inputs", NumberValue)], (_ctx, ...inputs: Array<NumberValue | null>) => { const values = inputs.filter(Boolean).map(input => input!.value); return values.length ? num(Math.max(...values)) : null; });
define(null, "list", [p("self", NotNull)], (_ctx, self: Value) => self instanceof ListValue ? self : new ListValue([self]));
define(null, "link", [p("self", StringValue, FileValue), opt("display", Value)], (ctx, self: StringValue | FileValue, display: Value | null) => {
  if (self instanceof FileValue) return new LinkValue(ctx.app, self.value.path, "", display);
  if (self instanceof UrlValue || /^[a-z][a-z\d+.-]*:\/\//i.test(self.value)) return new UrlValue(self.value, display);
  return LinkValue.parseFromString(ctx.app, self.value, "") ?? new LinkValue(ctx.app, self.value, "", display);
});
define(null, "number", [p("input", NotNull)], (_ctx, input: Value) => {
  if (input instanceof NumberValue) return input;
  if (input instanceof BooleanValue) return num(input.value ? 1 : 0);
  if (input instanceof DateValue) return num(input.date.getTime());
  if (input instanceof StringValue) {
    const parsed = parseFloat(input.value);
    if (Number.isNaN(parsed)) throw new Error(t("obsen.bases.error-number-parse", { value: input.value }));
    return num(parsed);
  }
  throw new Error(t("obsen.bases.error-number-convert", { type: typeName(input) }));
});
define(null, "duration", [p("input", StringValue)], (_ctx, input: StringValue) => DurationValue.parseFromString(input.value) ?? NullValue.value);
define(null, "image", [p("input", StringValue, FileValue)], (ctx, input: Value) => {
  if (input instanceof LinkValue) { const file = input.resolve(); return file ? new ImageValue(file.path, ctx.app) : NullValue.value; }
  if (input instanceof FileValue) return new ImageValue(input.value.path, ctx.app);
  return new ImageValue((input as StringValue).value, ctx.app);
});
define(null, "icon", [p("input", StringValue)], (_ctx, input: StringValue) => new IconValue(input.value));
define(null, "file", [p("input", StringValue, FileValue)], (ctx, input: Value) => {
  if (input instanceof FileValue) return input;
  const file = input instanceof LinkValue ? input.resolve() : resolveFile(ctx, (input as StringValue).value);
  return file ? new FileValue(file, ctx.app) : NullValue.value;
});
define(null, "html", [p("input", StringValue)], (_ctx, input: StringValue) => new HTMLValue(input.value));
define(null, "escapeHTML", [p("input", StringValue)], (_ctx, input: StringValue) => str(input.value.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]!)));

define(Value, "toString", [p("self", Value)], (_ctx, self: Value) => str(self.toString()));
define(Value, "isTruthy", [p("self", Value)], (_ctx, self: Value) => self.isTruthy());
define(Value, "isType", [p("self", Value), p("type", StringValue)], (_ctx, self: Value, type: StringValue) => {
  const wanted = type.value.toLowerCase();
  return prototypeChain(self).some(cls => (cls as unknown as { type: string }).type.toLowerCase() === wanted);
});
const NullClass = NullValue as unknown as ValueClass;
predicate(NullClass, "isEmpty", [p("self", NullClass)], () => true);

predicate(StringValue, "startsWith", [p("self", StringValue), p("query", StringValue)], (_ctx, self: StringValue, query: StringValue) => self.value.startsWith(query.value));
predicate(StringValue, "endsWith", [p("self", StringValue), p("query", StringValue)], (_ctx, self: StringValue, query: StringValue) => self.value.endsWith(query.value));
predicate(StringValue, "isEmpty", [p("self", StringValue)], (_ctx, self: StringValue) => self.value.length === 0);
predicate(StringValue, "contains", [p("self", StringValue), p("value", StringValue)], (_ctx, self: StringValue, value: StringValue) => self.value.includes(value.value));
predicate(StringValue, "containsAny", [p("self", StringValue), rest("values", StringValue)], (_ctx, self: StringValue, ...values: StringValue[]) => values.some(value => self.value.includes(value.value)));
predicate(StringValue, "containsAll", [p("self", StringValue), rest("values", StringValue)], (_ctx, self: StringValue, ...values: StringValue[]) => values.every(value => self.value.includes(value.value)));
define(StringValue, "trim", [p("self", StringValue)], (_ctx, self: StringValue) => str(self.value.trim()));
define(StringValue, "title", [p("self", StringValue)], (_ctx, self: StringValue) => str(self.value.split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ")));
define(StringValue, "lower", [p("self", StringValue)], (_ctx, self: StringValue) => str(self.value.toLowerCase()));
define(StringValue, "upper", [p("self", StringValue)], (_ctx, self: StringValue) => str(self.value.toUpperCase()));
define(StringValue, "reverse", [p("self", StringValue)], (_ctx, self: StringValue) => str([...self.value].reverse().join("")));
define(StringValue, "replace", [p("value", StringValue), p("pattern", StringValue, RegExpValue), p("replacement", StringValue)], (_ctx, self: StringValue, pattern: StringValue | RegExpValue, replacement: StringValue) =>
  pattern instanceof RegExpValue ? str(self.value.replace(pattern.regexp, replacement.value)) : pattern.value === "" ? self : str(self.value.split(pattern.value).join(replacement.value)));
define(StringValue, "split", [p("self", StringValue), p("separator", StringValue, RegExpValue), opt("n", NumberValue)], (_ctx, self: StringValue, separator: StringValue | RegExpValue, limit: NumberValue | null) =>
  new ListValue(self.value.split(separator instanceof RegExpValue ? separator.regexp : separator.value, limit?.value)));
define(StringValue, "slice", [p("self", StringValue), p("start", NumberValue), opt("end", NumberValue)], (_ctx, self: StringValue, start: NumberValue, end: NumberValue | null) => str(self.value.slice(start.value, end?.value)));
define(StringValue, "repeat", [p("self", StringValue), p("count", NumberValue)], (_ctx, self: StringValue, count: NumberValue) => str(self.value.repeat(Math.max(0, Math.floor(count.value)))));

define(NumberValue, "round", [p("self", NumberValue), opt("digits", NumberValue)], (_ctx, self: NumberValue, digits: NumberValue | null) => { const scale = 10 ** (digits?.value ?? 0); return num(Math.round(self.value * scale) / scale); });
define(NumberValue, "ceil", [p("self", NumberValue)], (_ctx, self: NumberValue) => num(Math.ceil(self.value)));
define(NumberValue, "floor", [p("self", NumberValue)], (_ctx, self: NumberValue) => num(Math.floor(self.value)));
define(NumberValue, "abs", [p("self", NumberValue)], (_ctx, self: NumberValue) => num(Math.abs(self.value)));
define(NumberValue, "toFixed", [p("self", NumberValue), p("precision", NumberValue)], (_ctx, self: NumberValue, precision: NumberValue) => str(self.value.toFixed(precision.value)));
predicate(NumberValue, "isEmpty", [p("self", NumberValue)], () => false);
predicate(BooleanValue, "isEmpty", [p("self", BooleanValue)], () => false);

predicate(ListValue, "isEmpty", [p("self", ListValue)], (_ctx, self: ListValue) => self.length() === 0);
predicate(ListValue, "contains", [p("self", ListValue), widget("value", "text", Value)], (_ctx, self: ListValue, value: Value) => self.includes(value));
predicate(ListValue, "containsAny", [p("self", ListValue), rest("values", Value)], (_ctx, self: ListValue, ...values: Value[]) => values.some(value => self.includes(value)));
predicate(ListValue, "containsAll", [p("self", ListValue), rest("values", Value)], (_ctx, self: ListValue, ...values: Value[]) => values.every(value => self.includes(value)));
define(ListValue, "earliest", [p("self", ListValue)], (_ctx, self: ListValue) => { const dates = self.dates(); return dates.length ? new DateValue(dates.reduce((a, b) => b < a ? b : a)) : NullValue.value; });
define(ListValue, "latest", [p("self", ListValue)], (_ctx, self: ListValue) => { const dates = self.dates(); return dates.length ? new DateValue(dates.reduce((a, b) => b > a ? b : a)) : NullValue.value; });
define(ListValue, "sum", [p("self", ListValue)], (_ctx, self: ListValue) => numbersOrNull(self, numbers => numbers.reduce((a, b) => a + b, 0)));
define(ListValue, "mean", [p("self", ListValue)], (_ctx, self: ListValue) => numbersOrNull(self, numbers => numbers.reduce((a, b) => a + b, 0) / self.length()));
define(ListValue, "min", [p("self", ListValue)], (_ctx, self: ListValue) => numbersOrNull(self, numbers => Math.min(...numbers)));
define(ListValue, "max", [p("self", ListValue)], (_ctx, self: ListValue) => numbersOrNull(self, numbers => Math.max(...numbers)));
define(ListValue, "median", [p("self", ListValue)], (_ctx, self: ListValue) => numbersOrNull(self, numbers => { numbers.sort((a, b) => a - b); const n = numbers.length; return n % 2 ? numbers[(n - 1) / 2]! : (numbers[n / 2]! + numbers[n / 2 - 1]!) / 2; }));
define(ListValue, "stddev", [p("self", ListValue)], (_ctx, self: ListValue) => numbersOrNull(self, numbers => { const mean = (items: number[]) => items.reduce((a, b) => a + b, 0) / items.length, center = mean(numbers); return Math.sqrt(mean(numbers.map(value => (value - center) ** 2))); }));
define(ListValue, "join", [p("self", ListValue), p("separator", StringValue)], (_ctx, self: ListValue, separator: StringValue) => str(self.value.map(item => item.toString()).join(separator.value)));
define(ListValue, "reverse", [p("self", ListValue)], (_ctx, self: ListValue) => new ListValue([...self.value].reverse()));
define(ListValue, "flat", [p("self", ListValue)], (_ctx, self: ListValue) => self.flatten());
define(ListValue, "unique", [p("self", ListValue)], (_ctx, self: ListValue) => self.unique());
define(ListValue, "sort", [p("self", ListValue)], (_ctx, self: ListValue) => self.sort());
define(ListValue, "slice", [p("self", ListValue), p("start", NumberValue), opt("end", NumberValue)], (_ctx, self: ListValue, start: NumberValue, end: NumberValue | null) => new ListValue(self.value.slice(start.value, end?.value)));

predicate(ObjectValue, "isEmpty", [p("self", ObjectValue)], (_ctx, self: ObjectValue) => self.isEmpty());
define(ObjectValue, "keys", [p("self", ObjectValue)], (_ctx, self: ObjectValue) => new ListValue(self.keys()));
define(ObjectValue, "values", [p("self", ObjectValue)], (_ctx, self: ObjectValue) => new ListValue(self.values()));
predicate(RegExpValue, "matches", [p("self", RegExpValue), p("value", StringValue)], (_ctx, self: RegExpValue, value: StringValue) => { self.regexp.lastIndex = 0; return self.regexp.test(value.value); });

define(DateValue, "format", [p("self", DateValue), p("format", StringValue)], (_ctx, self: DateValue, format: StringValue) => str(moment(self.date).format(format.value)));
define(DateValue, "date", [p("self", DateValue)], (_ctx, self: DateValue) => self.dateOnly());
define(DateValue, "time", [p("self", DateValue)], (_ctx, self: DateValue) => str(self.printTime()));
define(DateValue, "relative", [p("self", DateValue)], (_ctx, self: DateValue) => new RelativeDateValue(self.date, self.time));
predicate(DateValue, "isEmpty", [p("self", DateValue)], () => false);

define(FileValue, "asLink", [p("self", FileValue), opt("display", Value)], (ctx, self: FileValue, display: Value | null) => new LinkValue(ctx.app, self.value.path, "", display));
predicate(FileValue, "hasLink", [p("self", FileValue), widget("dest", "file", FileValue, StringValue)], (ctx, self: FileValue, dest: FileValue | StringValue) => {
  const target = dest instanceof FileValue ? dest.value : dest instanceof LinkValue ? dest.resolve() : resolveFile(ctx, dest.value);
  const path = dest instanceof FileValue ? dest.value.path : linkpath(dest.value);
  return self.getLinks().value.some(link => link instanceof LinkValue && (target ? link.resolve() === target : linkpath(link.value) === path));
});
predicate(FileValue, "inFolder", [p("self", FileValue), widget("folder", "folder", StringValue)], (_ctx, self: FileValue, folder: StringValue) => {
  const normalized = folder.value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized === "" || self.value.path.startsWith(`${normalized}/`);
});
predicate(FileValue, "hasTag", [p("self", FileValue), { name: "values", type: [StringValue], variadic: true, widget: "tags" }], (_ctx, self: FileValue, ...tags: StringValue[]) => {
  const wanted = tags.map(tag => new TagValue(tag.value));
  return self.getTags().value.some(tag => wanted.some(other => (tag as TagValue).tagMatches(other)));
});
predicate(FileValue, "hasProperty", [p("self", FileValue), widget("property", "property", StringValue)], (_ctx, self: FileValue, property: StringValue) => self.getProps().keys().includes(property.value));
predicate(LinkValue, "linksTo", [p("self", LinkValue), p("file", FileValue)], (_ctx, self: LinkValue, file: FileValue) => self.resolve() === file.value);
define(LinkValue, "asFile", [p("self", LinkValue)], (ctx, self: LinkValue) => { const file = self.resolve(); return file ? new FileValue(file, ctx.app) : NullValue.value; });
predicate(TagValue, "matches", [p("self", TagValue), p("tag", StringValue)], (_ctx, self: TagValue, tag: StringValue) => self.tagMatches(tag));

// ---------------------------------------------------------------------------------------------------------------------
// Evaluator

const NULL = NullValue.value;
const bool = (value: boolean) => new BooleanValue(value);
const arity = (name: string, count: number, min: number, max: number) => {
  if (count < min) throw new Error(t("formulas.msg-error-not-enough-arguments", { function: name }));
  if (count > max) throw new Error(t("formulas.msg-error-too-many-arguments", { function: name }));
};
const scoped = (ctx: FormulaContext, locals: Record<string, Value>): FormulaContext => ({
  app: ctx.app,
  getByIdentifier: id => Object.hasOwn(locals, id) ? locals[id]! : ctx.getByIdentifier(id),
});

function compare(op: string, left: Value, right: Value): Value {
  if (op === "==") return bool(Value.looseEquals(left, right));
  if (op === "!=") return bool(!Value.looseEquals(left, right));
  if (left instanceof NullValue || right instanceof NullValue) return NULL;
  let a: number | string, other = right;
  if (left instanceof DateValue) { a = left.date.getTime(); if (right instanceof StringValue) other = DateValue.parseFromString(right.value) ?? right; }
  else if (left instanceof DurationValue) { a = left.getMilliseconds(); if (right instanceof StringValue) other = DurationValue.parseFromString(right.value) ?? right; }
  else a = left instanceof NumberValue ? left.value : left.toString();
  const b = other instanceof DateValue ? other.date.getTime() : other instanceof DurationValue ? other.getMilliseconds() : other instanceof NumberValue ? other.value : other.toString();
  switch (op) {
    case "<": return bool(a < b);
    case ">": return bool(a > b);
    case "<=": return bool(a <= b);
    case ">=": return bool(a >= b);
  }
  return NULL;
}

function arithmetic(op: string, left: Value, right: Value): Value {
  if (left instanceof NumberValue && right instanceof NumberValue) {
    switch (op) {
      case "+": return num(left.value + right.value);
      case "-": return num(left.value - right.value);
      case "*": return num(left.value * right.value);
      case "/": return num(left.value / right.value);
      case "%": return num(left.value % right.value);
    }
    throw new Error(t("obsen.bases.error-operator"));
  }
  if (left instanceof DateValue && right instanceof StringValue) right = DurationValue.parseFromString(right.value) ?? right;
  if (left instanceof DateValue && right instanceof DurationValue) {
    if (op !== "+" && op !== "-") throw new Error(t("obsen.bases.error-date-operator"));
    return right.addToDate(left, op === "-");
  }
  if (left instanceof DurationValue && right instanceof NumberValue && (op === "*" || op === "/")) return left.scale(op === "*" ? right.value : 1 / right.value);
  if (left instanceof DurationValue && right instanceof DurationValue && (op === "+" || op === "-")) return left.plus(right, op === "+" ? 1 : -1);
  if (left instanceof ListValue && right instanceof ListValue && op === "+") return left.concat(right);
  if (op === "+" && (left instanceof StringValue || right instanceof StringValue)) return str((left === NULL ? "" : left.toString()) + (right === NULL ? "" : right.toString()));
  if (op === "-" && left instanceof DateValue && right instanceof DateValue) return DurationValue.fromMilliseconds(left.date.getTime() - right.date.getTime());
  if (left === NULL || right === NULL) return NULL;
  throw new Error(t("obsen.bases.error-operator-types", { left: typeName(left), right: typeName(right) }));
}

function call(node: Extract<Node, { type: "call" }>, ctx: FormulaContext): Value {
  const { name } = node;
  let { subject, args } = node;
  if (name === "if") {
    arity(name, args.length + (subject ? 1 : 0), 2, 3);
    if (!subject) { subject = args[0]!; args = args.slice(1); }
    return evaluate(subject, ctx).isTruthy() ? evaluate(args[0]!, ctx) : args.length === 2 ? evaluate(args[1]!, ctx) : NULL;
  }
  let self: Value | null = null, fn: FormulaFunction | null;
  if (subject) {
    self = evaluate(subject, ctx);
    fn = findMethod(self, name);
    if (!fn && self === NULL) return NULL;
  } else fn = globals.get(name.toLowerCase()) ?? null;

  if (self instanceof ListValue && (name === "map" || name === "filter" || name === "reduce")) {
    const list = self;
    if (name === "reduce") {
      arity(name, args.length, 2, 2);
      let acc = evaluate(args[1]!, ctx);
      list.value.forEach((value, index) => { acc = evaluate(args[0]!, scoped(ctx, { index: num(index), value, acc })); });
      return acc;
    }
    arity(name, args.length, 1, 1);
    const out: Value[] = [];
    list.value.forEach((value, index) => {
      const result = evaluate(args[0]!, scoped(ctx, { index: num(index), value }));
      if (name === "map") out.push(result); else if (result.isTruthy()) out.push(value);
    });
    return new ListValue(out);
  }
  if (self instanceof ObjectValue && (name === "map" || name === "filter")) {
    arity(name, args.length, 1, 1);
    const object = self, mapped: Value[] = [], kept: Record<string, unknown> = {};
    for (const key of object.keys()) {
      const value = object.get(key) ?? NULL, result = evaluate(args[0]!, scoped(ctx, { key: str(key), value }));
      if (name === "map") mapped.push(result); else if (result.isTruthy()) kept[key] = value;
    }
    return name === "map" ? new ListValue(mapped) : new ObjectValue(kept);
  }
  if (!fn) throw new Error(self ? t("formulas.msg-error-invalid-instance-function", { function: name, type: typeName(self) }) : t("formulas.msg-error-invalid-function", { function: name }));

  // Bind arguments to parameters; a null where a value is required makes the whole call null.
  const params = fn.params, bound: Array<Value | null> = [];
  let index = 0;
  const bind = (value: Value): boolean => {
    if (index === params.length) {
      if (!params.at(-1)?.variadic) throw new Error(t("formulas.msg-error-too-many-arguments", { function: name }));
      index--;
    }
    const param = params[index]!;
    if (param.optional && value === NULL) bound.push(null);
    else {
      if (!param.type.some(type => value instanceof type)) {
        if (value === NULL) return false;
        throw new Error(t("formulas.msg-error-type-error", { function: name, parameter: param.name, expected: typeName(param.type[0]!), given: typeName(value) }));
      }
      bound.push(value);
    }
    index++;
    return true;
  };
  if (self && !bind(self)) return NULL;
  for (const arg of args) if (!bind(evaluate(arg, ctx))) return NULL;
  for (let i = index; i < params.length; i++) if (!params[i]!.optional && !params[i]!.variadic) throw new Error(t("formulas.msg-error-not-enough-arguments", { function: name }));
  return fn.apply(ctx, ...bound) ?? NULL;
}

/** Evaluates a parsed expression; throws with the reference's messages on type and lookup errors. */
export function evaluate(node: Node, ctx: FormulaContext): Value {
  switch (node.type) {
    case "empty": case "invalid": return NULL;
    case "primitive": return wrapValue(node.value);
    case "regexp": return node.value;
    case "ident": return ctx.getByIdentifier(node.id) ?? NULL;
    case "array": return new ListValue(node.elements.map(element => evaluate(element, ctx)));
    case "paren": return evaluate(node.expr, ctx);
    case "not": { const value = evaluate(node.expr, ctx); return value === NULL ? value : bool(!value.isTruthy()); }
    case "negate": {
      const value = evaluate(node.expr, ctx);
      if (value === NULL) return value;
      if (!(value instanceof NumberValue)) throw new Error(t("obsen.bases.error-negate", { value: value.toString() }));
      return num(-value.value);
    }
    case "compare":
      if (node.op === "&&") return bool(evaluate(node.left, ctx).isTruthy() && evaluate(node.right, ctx).isTruthy());
      if (node.op === "||") return bool(evaluate(node.left, ctx).isTruthy() || evaluate(node.right, ctx).isTruthy());
      return compare(node.op, evaluate(node.left, ctx), evaluate(node.right, ctx));
    case "math": return arithmetic(node.op, evaluate(node.left, ctx), evaluate(node.right, ctx));
    case "object_access": {
      const object = evaluate(node.object, ctx);
      if (object === NULL) return NULL;
      const value = object.objectAccess(node.index);
      if (value === null) throw new Error(t("formulas.msg-error-invalid-object-access", { index: node.index, type: typeName(object) }));
      return value;
    }
    case "array_access": {
      const array = evaluate(node.array, ctx);
      if (array === NULL) return NULL;
      const index = evaluate(node.index, ctx);
      if (index === NULL) return NULL;
      if (array instanceof ListValue) {
        if (!(index instanceof NumberValue)) throw new Error(t("obsen.bases.error-array-index", { type: typeName(index) }));
        return array.get(index.value < 0 ? index.value + array.length() : index.value);
      }
      if (array instanceof ObjectValue) {
        if (!(index instanceof StringValue)) throw new Error(t("obsen.bases.error-object-index", { type: typeName(index) }));
        return array.objectAccess(index.value) ?? NULL;
      }
      if (index instanceof StringValue) {
        const value = array.objectAccess(index.value);
        if (value === null) throw new Error(t("formulas.msg-error-invalid-object-access", { index: index.value, type: typeName(array) }));
        return value;
      }
      if (array instanceof StringValue) {
        if (!(index instanceof NumberValue)) throw new Error(t("obsen.bases.error-string-index", { type: typeName(index) }));
        return str(array.value.charAt(index.value));
      }
      throw new Error(t("formulas.msg-error-invalid-array-access", { index: index.toString() }));
    }
    case "call": return call(node, ctx);
  }
}

/** A formula source string together with its parse result. */
export class Formula {
  readonly node: Node;
  constructor(readonly text: string) { this.node = parseFormula(text); }
  get isInvalid(): boolean { return this.node.type === "invalid"; }
  get errorMessage(): string { return this.node.type === "invalid" ? this.node.error ?? t("obsen.bases.error-parse") : ""; }
  toString(): string { return this.text; }
  /** Filters treat evaluation errors as exceptions so they can be reported once per query. */
  test(ctx: FormulaContext): boolean { return this.node.type === "empty" || this.node.type === "invalid" ? false : evaluate(this.node, ctx).isTruthy(); }
  getValue(ctx: FormulaContext): Value {
    try { return evaluate(this.node, ctx); }
    catch (error) { return new ErrorValue(error); }
  }
}

/** Built-in summaries offered for a column, keyed by the reference's display names. */
const SUMMARIES: Array<[ValueClass, Record<string, string>]> = [
  [NumberValue, { Average: "values.mean().round(2)", Min: "values.min()", Max: "values.max()", Sum: "values.sum().round(2)", Range: "values.max() - values.min()", Median: "values.median()", Stddev: "values.stddev().round(2)" }],
  [DateValue, { Earliest: "values.earliest()", Latest: "values.latest()", Range: "(values.latest() - values.earliest())" }],
  [BooleanValue, { Checked: "values.filter(value == true).length", Unchecked: "values.filter(value == false).length" }],
  [Value, { Empty: 'values.filter(value.isType("null")).length', Filled: 'values.filter(!value.isType("null")).length', Unique: "values.unique().length" }],
];
export function defaultSummaries(sample: Value | null): Record<string, string> {
  let out: Record<string, string> = {};
  for (const [type, formulas] of SUMMARIES) if (type === (Value as ValueClass) || (sample && sample instanceof type)) out = { ...formulas, ...out };
  return out;
}

/** The property-editor widget that suits a value, as used for filter inputs and sort labels. */
export function widgetForValue(value: Value | null): string {
  if (!value || value instanceof NullValue || value instanceof StringValue) return "text";
  if (value instanceof NumberValue) return "number";
  if (value instanceof ListValue) return "multitext";
  if (value instanceof BooleanValue) return "checkbox";
  if (value instanceof DateValue) return value.time ? "datetime" : "date";
  return "unknown";
}

const SUMMARY_LABEL_KEYS: Record<string, string> = {"Average":"obsen.bases.summaries.average","Min":"obsen.bases.summaries.min","Max":"obsen.bases.summaries.max","Sum":"obsen.bases.summaries.sum","Range":"obsen.bases.summaries.range","Median":"obsen.bases.summaries.median","Stddev":"obsen.bases.summaries.stddev","Earliest":"obsen.bases.summaries.earliest","Latest":"obsen.bases.summaries.latest","Checked":"obsen.bases.summaries.checked","Unchecked":"obsen.bases.summaries.unchecked","Empty":"obsen.bases.summaries.empty","Filled":"obsen.bases.summaries.filled","Unique":"obsen.bases.summaries.unique"};
export function summaryLabel(name: string): string { return SUMMARY_LABEL_KEYS[name] ? t(SUMMARY_LABEL_KEYS[name]!) : name; }
