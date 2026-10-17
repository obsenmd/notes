import { hasTranslation, t } from "../i18n";

/** Vault search query engine: the reference tokenizer, parser and matcher tree. */

export type SearchRange = [number, number];
export interface PropertyMatch { key: string; subkey?: Array<string | number>; pos?: SearchRange }
/** Matched ranges per searched string; `canvas-<node id>` keys hold ranges inside a canvas text node. */
export interface SearchResult { filename?: SearchRange[]; filepath?: SearchRange[]; content?: SearchRange[]; propertyName?: SearchRange[]; tag?: SearchRange[]; properties?: PropertyMatch[]; [canvasNode: `canvas-${string}`]: SearchRange[] | undefined }
type RangeKey = "filename" | "filepath" | "content" | "propertyName" | "tag";
const RANGE_KEYS: RangeKey[] = ["filename", "filepath", "content", "propertyName", "tag"];

interface Position { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } }
export interface SearchListItem { position: Position; parent?: number; task?: string }
/** The metadata fields the matchers read; a superset of what the vault's cache provides. */
export interface SearchCache {
  headings?: Array<{ heading: string; level: number; position: Position }>;
  sections?: Array<{ type: string; position: Position }>;
  listItems?: SearchListItem[];
  tags?: Array<{ tag: string; position: Position }>;
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: Position;
}
export interface SearchDocument { path: string; name: string; content: string; cache?: SearchCache | null }
export interface SearchFile { path: string; name: string; extension: string }
export interface SearchToken { type: "text" | "quote" | "regex" | "bracket" | "parenthesis" | "colon" | "greaterthan" | "lessthan" | "not" | "or" | "true" | "false" | "empty"; content: string; pos: number }
export interface SearchInfo { text: string; children?: SearchInfo[]; key?: SearchInfo; value?: SearchInfo }
export interface SearchContext { matcherStack: Matcher[]; token: SearchToken }
type MatchResult = SearchResult | null | undefined;
type RequiredInputs = { content?: boolean };

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const WORD = "\\p{L}\\p{N}";
// Scripts written without spaces never get word boundaries.
const UNSPACED = "\\u0F00\\u0F40-\\u0F47\\u0F49-\\u0F6C\\u0F88-\\u0F8C\\u3041-\\u3096\\u309D-\\u309F\\u30A1-\\u30FA\\u30FC-\\u30FF\\u4E00-\\u9FD5\\uAC00-\\uD7A3\\uA960-\\uA97C\\uD7B0-\\uD7C6";
const isWordChar = (char: string) => new RegExp(`[${WORD}]`, "u").test(char) && !new RegExp(`[${UNSPACED}]`).test(char);
/** Regex source matching `text` as a whole word (boundaries only where the text starts or ends with a word character). */
export function wholeWordSource(text: string): string {
  if (!text) return "";
  const chars = [...text];
  return (isWordChar(chars[0]) ? `(?:(?<![${WORD}])|(?<=[${UNSPACED}]))` : "") + escapeRegex(text) + (isWordChar(chars[chars.length - 1]) ? `(?:(?![${WORD}])|(?=[${UNSPACED}]))` : "");
}

const fail = (key: string, values?: Record<string, unknown>): Error => new Error(hasTranslation(key) ? t(key, values) : t("obsen.search.error-invalid-query"));

export function mergeRanges(ranges: SearchRange[]): SearchRange[] {
  if (!ranges.length) return ranges;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: SearchRange[] = [ranges[0]];
  for (let index = 1; index < ranges.length; index++) {
    const last = merged[merged.length - 1];
    if (last[1] < ranges[index][0]) merged.push(ranges[index]); else if (last[1] < ranges[index][1]) last[1] = ranges[index][1];
  }
  return merged;
}
/** Number of matches in a result, as shown next to a result file. */
export function countMatches(result: SearchResult): number {
  let count = result.properties?.length ?? 0;
  for (const key of RANGE_KEYS) count += result[key]?.length ?? 0;
  return count;
}
function mergeInto(target: SearchResult, source: SearchResult): void {
  for (const [key, value] of Object.entries(source) as Array<[RangeKey, SearchRange[] | undefined]>) if ((key as string) !== "properties" && value) target[key] = value.concat(target[key] ?? []);
  if (source.properties) target.properties = source.properties.concat(target.properties ?? []);
}

/** Splits a query into the reference token stream. */
export function tokenizeSearch(query: string): SearchToken[] {
  const tokens: SearchToken[] = [], length = query.length;
  let at = 0;
  const word = (content: string, pos: number) => tokens.push({ type: content === "TRUE" ? "true" : content === "FALSE" ? "false" : content === "EMPTY" ? "empty" : content === "OR" ? "or" : "text", content, pos });
  while (at < length) {
    const char = query.charAt(at);
    if (char === '"') {
      const pos = at++; let text = "";
      for (; at <= length;) {
        if (at === length) { tokens.push({ type: "quote", content: text, pos }); break; }
        const next = query.charAt(at++);
        if (next === "\\" && at < length) text += query.charAt(at++);
        else if (next === '"') { tokens.push({ type: "quote", content: text, pos }); break; }
        else text += next;
      }
    } else if (char === "/") {
      const pos = at++; let source = "";
      for (; at <= length;) {
        if (at === length) { tokens.push({ type: "regex", content: source, pos }); break; }
        const next = query.charAt(at++);
        if (next === "\\" && at < length) {
          const escaped = query.charAt(at);
          if (escaped === "/") { source += escaped; at++; continue; }
          if (escaped === "\\") { source += "\\\\"; at++; continue; }
        }
        if (next === "/") { tokens.push({ type: "regex", content: source, pos }); break; }
        source += next;
      }
    } else if (char === "-") tokens.push({ type: "not", content: char, pos: at++ });
    else {
      let start = at, text = "";
      for (; at <= length;) {
        if (at === length) { if (text) word(text, start); break; }
        const next = query.charAt(at++);
        const type = next === "[" || next === "]" ? "bracket" : next === "(" || next === ")" ? "parenthesis" : next === ":" ? "colon" : next === ">" ? "greaterthan" : next === "<" ? "lessthan" : null;
        if (type) { if (text) word(text, start); tokens.push({ type, content: next, pos: at - 1 }); break; }
        if (next === " ") { if (text) { word(text, start); start += text.length; } break; }
        text += next;
      }
    }
  }
  return tokens;
}
const tokenEnd = (token: SearchToken) => token.pos + token.content.length + (token.type === "quote" || token.type === "regex" ? 2 : 0);

const PROPERTY_VALUE = Symbol("property value"), SECTION_STATE = Symbol("section state"), STRUCTURE = Symbol("structure");
class MatchInput {
  cache: SearchCache | null = null;
  data: Map<symbol, unknown> | null = null;
  constructor(public strings: Partial<Record<RangeKey, string>>, public original: string, public keys: RangeKey[], public caseSensitive: boolean) {}
  clone(): MatchInput {
    const copy = new MatchInput({ ...this.strings }, this.original, this.keys.slice(), this.caseSensitive);
    copy.cache = this.cache;
    if (this.data) copy.data = new Map(this.data);
    return copy;
  }
  forPropertyValue(value: unknown): MatchInput {
    const copy = this.clone();
    copy.keys = ["content"]; copy.strings.content = String(value); copy.setData(PROPERTY_VALUE, value);
    return copy;
  }
  setData(key: symbol, value: unknown) { (this.data ??= new Map()).set(key, value); }
  getData(key: symbol): unknown { return this.data ? this.data.get(key) : null; }
  deleteData(key: symbol) { if (this.data) { this.data.delete(key); if (!this.data.size) this.data = null; } }
}

const regexCache = new Map<string, RegExp>();
function compiled(source: string, caseSensitive: boolean, unicode: boolean): RegExp {
  const key = `${caseSensitive ? 1 : 0}${unicode ? 1 : 0}${source}`;
  let regex = regexCache.get(key);
  if (!regex) { if (regexCache.size > 500) regexCache.clear(); regexCache.set(key, regex = new RegExp(source, `gm${caseSensitive ? "" : "i"}${unicode ? "u" : ""}`)); }
  return regex;
}
function findAll(regex: RegExp, text: string | undefined): SearchRange[] {
  const ranges: SearchRange[] = [];
  if (!text) return ranges;
  regex.lastIndex = 0;
  for (;;) {
    const match = regex.exec(text);
    if (!match) break;
    if (match[0].length) ranges.push([match.index, match.index + match[0].length]); else regex.lastIndex++;
  }
  return ranges;
}
function matchKeys(input: MatchInput, source: string, unicode: boolean): SearchResult | null {
  const regex = compiled(source, input.caseSensitive, unicode), result: SearchResult = {};
  let any = false;
  for (const key of input.keys) { const ranges = findAll(regex, input.strings[key]); if (ranges.length) { result[key] = ranges; any = true; } }
  return any ? result : null;
}

const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[(.)\][ \t]+)?/;
/** List items and blocks derived from the text, for caches that do not carry them. */
function structure(input: MatchInput): { listItems: SearchListItem[]; blocks: SearchRange[] } {
  const key = STRUCTURE;
  const cached = input.getData(key) as { listItems: SearchListItem[]; blocks: SearchRange[] } | null;
  if (cached) return cached;
  const text = input.original, listItems: SearchListItem[] = [], blocks: SearchRange[] = [];
  let offset = 0, line = 0, block: SearchRange | null = null, fence = false;
  const stack: Array<{ indent: number; line: number }> = [];
  const frontmatterEnd = input.cache?.frontmatterPosition?.end.offset ?? -1;
  for (const raw of text.split("\n")) {
    const start = offset, end = offset + raw.length - (raw.endsWith("\r") ? 1 : 0);
    offset += raw.length + 1;
    const blank = !raw.trim(), item = fence ? null : LIST_ITEM.exec(raw);
    if (start <= frontmatterEnd) { line++; continue; }
    if (/^\s*(```|~~~)/.test(raw)) { if (!fence) { if (block) blocks.push(block); block = [start, end]; } else if (block) { block[1] = end; blocks.push(block); block = null; } fence = !fence; }
    else if (fence) { if (block) block[1] = end; }
    else if (item) {
      if (block) { blocks.push(block); block = null; }
      const indent = item[1].replace(/\t/g, "    ").length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      listItems.push({ position: { start: { line, col: item[1].length, offset: start + item[1].length }, end: { line, col: end - start, offset: end } }, parent: stack.length ? stack[stack.length - 1].line : -line - 1, task: item[2] });
      stack.push({ indent, line });
    } else if (blank) { if (block) { blocks.push(block); block = null; } stack.length = 0; }
    else if (/^ {0,3}#{1,6}\s/.test(raw)) { if (block) blocks.push(block); blocks.push([start, end]); block = null; stack.length = 0; }
    else if (stack.length && /^\s/.test(raw)) listItems[listItems.length - 1].position.end = { line, col: end - start, offset: end };
    else if (block) block[1] = end; else { block = [start, end]; stack.length = 0; }
    line++;
  }
  if (block) blocks.push(block);
  const result = { listItems: input.cache?.listItems ?? listItems, blocks };
  input.setData(key, result);
  return result;
}

export abstract class Matcher {
  matchedTokens: SearchToken[] = [];
  abstract match(input: MatchInput): MatchResult;
  abstract getInfo(): string;
  abstract requiredInputs(): RequiredInputs;
  eatToken(state: ParseState) { this.matchedTokens.push(state.tokens[state.pos]); state.pos++; }
  getContext(position: number): SearchContext | null {
    for (const token of this.matchedTokens) if (position >= token.pos && position <= tokenEnd(token)) return { matcherStack: [this], token };
    return null;
  }
  describe(): SearchInfo { return { text: this.getInfo() }; }
}

class LiteralMatcher extends Matcher {
  private readonly expected: boolean | null;
  constructor(token: string) { super(); this.expected = token === "TRUE" ? true : token === "FALSE" ? false : null; }
  match(input: MatchInput): MatchResult {
    const value = input.getData(PROPERTY_VALUE);
    return value === this.expected ? { content: [[0, String(value).length]] } : null;
  }
  getInfo() { return t(this.expected === true ? "plugins.search.label-match-true" : this.expected === false ? "plugins.search.label-match-false" : "plugins.search.label-match-empty"); }
  requiredInputs() { return {}; }
}
class AnythingMatcher extends Matcher {
  match(input: MatchInput): MatchResult { const result: SearchResult = {}; for (const key of input.keys) if (input.strings[key]) result[key] = [[0, 0]]; return result; }
  getInfo() { return ""; }
  requiredInputs() { return {}; }
}
export class RegexMatcher extends Matcher {
  constructor(public regex: string, protected unicode = false) { super(); }
  match(input: MatchInput): MatchResult { return this.regex === "" ? undefined : matchKeys(input, this.regex, this.unicode); }
  getInfo() { return `${t("plugins.search.label-match-regex")}/${this.regex}/`; }
  requiredInputs(): RequiredInputs { return { content: true }; }
}
export class TextMatcher extends RegexMatcher {
  constructor(public text: string) { super(escapeRegex(text), true); }
  setText(text: string) { this.text = text; this.regex = escapeRegex(text); }
  getInfo() { return `${t("plugins.search.label-match-text")}"${this.text}"`; }
  match(input: MatchInput): MatchResult { return this.text === "" ? null : super.match(input); }
}
export class QuoteMatcher extends Matcher {
  private readonly wholeWord: string; private readonly partial: string;
  constructor(public text: string) { super(); this.wholeWord = wholeWordSource(text); this.partial = escapeRegex(text); }
  match(input: MatchInput): MatchResult {
    if (this.text === "") return undefined;
    const result: SearchResult = {};
    let any = false;
    for (const key of input.keys) {
      if (key === "propertyName") { if (input.strings[key]!.toLowerCase() === this.text.toLowerCase()) { result[key] = [[0, this.text.length]]; any = true; } continue; }
      const ranges = findAll(compiled(key === "content" ? this.wholeWord : this.partial, input.caseSensitive, true), input.strings[key]);
      if (ranges.length) { result[key] = ranges; any = true; }
    }
    return any ? result : null;
  }
  getInfo() { return `${t("plugins.search.label-match-exact-text")}"${this.text}"`; }
  requiredInputs(): RequiredInputs { return { content: true }; }
}
export class PropertyMatcher extends Matcher {
  constructor(public key: Matcher, public value: Matcher | null) { super(); }
  match(input: MatchInput): MatchResult {
    if (!Object.hasOwn(input.strings, "content")) return undefined;
    const frontmatter = input.cache?.frontmatter;
    if (!frontmatter) return null;
    const names: string[] = [];
    for (const name of Object.keys(frontmatter)) {
      if (name === "position") continue;
      const probe = input.clone();
      probe.keys = ["propertyName"]; probe.strings.propertyName = name;
      if (this.key.match(probe)) names.push(name);
    }
    const matches: PropertyMatch[] = [];
    for (const key of names) {
      if (this.value === null) { matches.push({ key }); continue; }
      const value = frontmatter[key];
      if (Array.isArray(value)) value.forEach((entry, index) => { const found = this.value!.match(input.forPropertyValue(entry)); if (found?.content) for (const pos of mergeRanges(found.content)) matches.push({ key, subkey: [index], pos }); });
      else { const found = this.value.match(input.forPropertyValue(value)); if (found?.content) for (const pos of found.content) matches.push({ key, pos }); }
    }
    return matches.length ? { properties: matches } : null;
  }
  getInfo() { return t("plugins.search.label-match-property"); }
  requiredInputs() { return {}; }
  getContext(position: number) {
    const context = this.key.getContext(position) ?? this.value?.getContext(position);
    if (context) { context.matcherStack.push(this); return context; }
    return super.getContext(position);
  }
  describe(): SearchInfo { return { text: this.getInfo(), key: this.key.describe(), value: this.value?.describe() }; }
}
abstract class GroupMatcher extends Matcher {
  constructor(public matchers: Matcher[]) { super(); }
  requiredInputs() { return Object.assign({}, ...this.matchers.map(matcher => matcher.requiredInputs())) as RequiredInputs; }
  getContext(position: number) {
    for (const matcher of this.matchers) { const context = matcher.getContext(position); if (context) { context.matcherStack.push(this); return context; } }
    const own = super.getContext(position);
    own?.matcherStack.push(this);
    return own;
  }
  describe(): SearchInfo { return { text: this.getInfo(), children: this.matchers.map(matcher => matcher.describe()) }; }
}
class AllMatcher extends GroupMatcher {
  match(input: MatchInput): MatchResult {
    let result: MatchResult;
    for (const matcher of this.matchers) {
      const found = matcher.match(input);
      if (found === null) return null;
      if (result) { if (found) mergeInto(result, found); } else result = found;
    }
    return result;
  }
  getInfo() { return t("plugins.search.label-match-all"); }
}
class AnyMatcher extends GroupMatcher {
  match(input: MatchInput): MatchResult {
    let result: MatchResult;
    for (const matcher of this.matchers) {
      const found = matcher.match(input);
      if (result || found === undefined) { if (found && result) mergeInto(result, found); } else result = found;
    }
    return result;
  }
  getInfo() { return t("plugins.search.label-match-any"); }
}
abstract class WrapMatcher extends Matcher {
  constructor(public matcher: Matcher) { super(); }
  requiredInputs() { return this.matcher.requiredInputs(); }
  getContext(position: number) {
    const context = this.matcher.getContext(position);
    if (context) { context.matcherStack.push(this); return context; }
    return super.getContext(position);
  }
  describe(): SearchInfo { return { text: this.getInfo(), children: [this.matcher.describe()] }; }
}
class CompareMatcher extends Matcher {
  private readonly text: string;
  constructor(private readonly type: "greaterthan" | "lessthan", operand: Matcher) {
    super();
    if (!(operand instanceof TextMatcher) && !(operand instanceof QuoteMatcher)) throw fail("obsen.search.error-comparison", { operator: type, matcher: operand.getInfo() });
    this.text = operand.text;
  }
  match(input: MatchInput): MatchResult {
    const value = input.getData(PROPERTY_VALUE) as string | number | null | undefined;
    return value != null && (this.type === "lessthan" ? value < this.text : value > this.text) ? { content: [[0, String(value).length]] } : null;
  }
  getInfo() { return t(this.type === "lessthan" ? "plugins.search.label-match-less-than" : "plugins.search.label-match-greater-than") + this.text; }
  requiredInputs() { return {}; }
}
class NotMatcher extends WrapMatcher {
  match(input: MatchInput): MatchResult { const found = this.matcher.match(input); return found === undefined ? undefined : found ? null : {}; }
  getInfo() { return t("plugins.search.label-excluding"); }
}
class CaseMatcher extends WrapMatcher {
  constructor(matcher: Matcher, private readonly caseSensitive: boolean) { super(matcher); }
  match(input: MatchInput): MatchResult { const copy = input.clone(); copy.caseSensitive = this.caseSensitive; return this.matcher.match(copy); }
  getInfo() { return t(this.caseSensitive ? "plugins.search.label-case-sensitive" : "plugins.search.label-case-insensitive"); }
}
class ScopeMatcher extends WrapMatcher {
  constructor(matcher: Matcher, private readonly key: "filepath" | "filename" | "content") { super(matcher); }
  match(input: MatchInput): MatchResult {
    if (!Object.hasOwn(input.strings, this.key)) return undefined;
    const copy = input.clone();
    copy.keys = [this.key];
    return this.matcher.match(copy);
  }
  getInfo() { return t(this.key === "filepath" ? "plugins.search.label-match-file-path" : this.key === "filename" ? "plugins.search.label-match-file-name" : "plugins.search.label-match-content"); }
  requiredInputs(): RequiredInputs { return this.key === "content" ? { content: true } : {}; }
}
export class PathMatcher extends ScopeMatcher { constructor(matcher: Matcher) { super(matcher, "filepath"); } }
/** Matches the wrapped term against each piece of the content separately (a line, block, section or task). */
abstract class SplitMatcher extends WrapMatcher {
  requiredInputs(): RequiredInputs { return { content: true }; }
  protected split(input: MatchInput, each: (scope: MatchInput, emit: (text: string, offset: number) => void) => void): MatchResult {
    const scope = input.clone();
    scope.keys = ["content"];
    let matched = false, skipped = false;
    const ranges: SearchRange[] = [];
    each(scope, (text, offset) => {
      scope.strings.content = text;
      const found = this.matcher.match(scope);
      if (found === undefined) skipped = true;
      else if (found) { matched = true; if (found.content) for (const range of found.content) ranges.push([range[0] + offset, range[1] + offset]); else ranges.push([offset, offset]); }
    });
    return matched ? { content: ranges } : skipped ? undefined : null;
  }
}
class LineMatcher extends SplitMatcher {
  match(input: MatchInput): MatchResult {
    if (!Object.hasOwn(input.strings, "content")) return undefined;
    const content = input.strings.content!;
    return this.split(input, (_scope, emit) => { let offset = 0; for (const line of content.split("\n")) { emit(line, offset); offset += line.length + 1; } });
  }
  getInfo() { return t("plugins.search.label-match-line"); }
}
class BlockMatcher extends SplitMatcher {
  match(input: MatchInput): MatchResult {
    if (!Object.hasOwn(input.strings, "content")) return undefined;
    if (!input.cache) return null;
    const content = input.strings.content!, { blocks, listItems } = structure(input);
    return this.split(input, (_scope, emit) => {
      for (const [start, end] of blocks) emit(content.substring(start, end), start);
      for (const item of listItems) emit(content.substring(item.position.start.offset, item.position.end.offset), item.position.start.offset);
    });
  }
  getInfo() { return t("plugins.search.label-match-block"); }
}
interface SectionSpan { start: number; end: number; children: number }
class SectionMatcher extends SplitMatcher {
  match(input: MatchInput): MatchResult {
    if (!Object.hasOwn(input.strings, "content")) return undefined;
    const cache = input.cache;
    if (!cache) return null;
    const state = input.getData(SECTION_STATE) as { sections: SectionSpan[] | null; index: number } | null, headings = cache.headings;
    if (!headings?.length) {
      if (state) return null;
      input.setData(SECTION_STATE, { sections: null, index: 0 });
      const found = this.matcher.match(input);
      input.deleteData(SECTION_STATE);
      return found;
    }
    const original = input.original;
    let sections: SectionSpan[], from: number, to: number, base = 0;
    if (state?.sections) {
      sections = state.sections;
      const current = sections[state.index];
      if (!current.children) return null;
      base = current.start; from = state.index + 1; to = Math.min(sections.length, from + current.children);
    } else {
      sections = [];
      headings.forEach((heading, index) => {
        const start = heading.position.start.offset;
        if (index === 0 && start > 0) sections.push({ start: 0, end: start, children: 0 });
        let children = 0;
        for (let next = index + 1; next < headings.length && headings[next].level > heading.level; next++) children++;
        sections.push({ start, end: headings[index + 1]?.position.start.offset ?? original.length, children });
      });
      from = 0; to = sections.length;
    }
    return this.split(input, (scope, emit) => {
      for (let index = from; index < to; index++) {
        const { start, end } = sections[index];
        if (end <= start) continue;
        scope.setData(SECTION_STATE, { sections, index });
        emit(original.substring(start, end), start - base);
      }
    });
  }
  getInfo() { return t("plugins.search.label-match-section"); }
}
class TaskMatcher extends SplitMatcher {
  constructor(matcher: Matcher, private readonly completed: boolean | undefined) { super(matcher instanceof QuoteMatcher && matcher.text === "" ? new AnythingMatcher() : matcher); }
  match(input: MatchInput): MatchResult {
    if (!Object.hasOwn(input.strings, "content")) return undefined;
    if (!input.cache) return null;
    const content = input.strings.content!, completed = this.completed;
    return this.split(input, (_scope, emit) => {
      for (const item of structure(input).listItems) {
        if (item.task === undefined || (typeof completed === "boolean" && completed !== (item.task !== " "))) continue;
        emit(content.substring(item.position.start.offset, item.position.end.offset), item.position.start.offset);
      }
    });
  }
  getInfo() { return t(this.completed === true ? "plugins.search.label-match-task-done" : this.completed === false ? "plugins.search.label-match-task-todo" : "plugins.search.label-match-task"); }
}
const INLINE_TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
function frontmatterTags(frontmatter: Record<string, unknown> | undefined): { key: string; tags: string[] } | null {
  if (!frontmatter) return null;
  const key = Object.keys(frontmatter).find(name => /^tags$/i.test(name));
  if (!key) return null;
  const value = frontmatter[key];
  const list = typeof value === "string" ? [value.trim()] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map(entry => entry.trim()) : null;
  return list ? { key, tags: list.filter(tag => tag && !tag.includes(" ")).map(tag => tag.startsWith("#") ? tag : `#${tag}`) } : null;
}
export class TagMatcher extends Matcher {
  constructor(public matcher: TextMatcher) { super(); if (matcher.text.charAt(0) !== "#") matcher.setText(`#${matcher.text}`); }
  match(input: MatchInput): MatchResult {
    const regex = new RegExp(`^${this.matcher.regex}($|\\/)`, "i");
    if (Object.hasOwn(input.strings, "tag") && regex.test(input.strings.tag!)) return {};
    if (!Object.hasOwn(input.strings, "content")) return undefined;
    const cache = input.cache;
    if (!cache) return null;
    let properties: PropertyMatch[] | undefined, matched = false;
    const ranges: SearchRange[] = [], declared = frontmatterTags(cache.frontmatter);
    if (declared) for (const tag of declared.tags) if (regex.test(tag)) { matched = true; properties = [{ key: declared.key }]; }
    for (const tag of cache.tags ?? []) if (regex.test(tag.tag)) { ranges.push([tag.position.start.offset, tag.position.end.offset]); matched = true; }
    return matched ? { content: ranges, properties } : null;
  }
  getInfo() { return t("plugins.search.label-match-tag") + this.matcher.text; }
  requiredInputs(): RequiredInputs { return { content: true }; }
  getContext(position: number) {
    const context = this.matcher.getContext(position);
    if (context) { context.matcherStack.push(this); return context; }
    return super.getContext(position);
  }
}

interface Operator { exclusive?: boolean; allowSelf?: boolean; operate(operand: Matcher): Matcher }
const OPERATORS: Record<string, Operator> = {
  "match-case": { operate: operand => new CaseMatcher(operand, true) },
  "ignore-case": { operate: operand => new CaseMatcher(operand, false) },
  path: { exclusive: true, operate: operand => new PathMatcher(operand) },
  file: { exclusive: true, operate: operand => new ScopeMatcher(operand, "filename") },
  content: { exclusive: true, operate: operand => new ScopeMatcher(operand, "content") },
  line: { exclusive: true, operate: operand => new LineMatcher(operand) },
  block: { exclusive: true, operate: operand => new BlockMatcher(operand) },
  section: { exclusive: true, allowSelf: true, operate: operand => new SectionMatcher(operand) },
  task: { exclusive: true, operate: operand => new TaskMatcher(operand, undefined) },
  "task-todo": { exclusive: true, operate: operand => new TaskMatcher(operand, false) },
  "task-done": { exclusive: true, operate: operand => new TaskMatcher(operand, true) },
  tag: { exclusive: true, operate: operand => { if (!(operand instanceof TextMatcher)) throw fail("obsen.search.error-tag-operand"); return new TagMatcher(operand); } },
};
export const SEARCH_OPERATORS = Object.keys(OPERATORS);

interface ParseState { tokens: SearchToken[]; pos: number; operatorStack: string[] }
const peek = (state: ParseState, type: SearchToken["type"]) => state.pos < state.tokens.length && state.tokens[state.pos].type === type;

function parseAny(state: ParseState): Matcher | null {
  const groups: Matcher[] = [], separators: SearchToken[] = [];
  while (state.pos < state.tokens.length) {
    const group = parseAll(state);
    if (group) {
      groups.push(group);
      if (state.pos < state.tokens.length && state.tokens[state.pos].type === "or") { separators.push(state.tokens[state.pos]); state.pos++; continue; }
    }
    break;
  }
  if (!groups.length) return null;
  if (groups.length === 1) return groups[0];
  const any = new AnyMatcher(groups);
  any.matchedTokens = separators;
  return any;
}
function parseAll(state: ParseState): Matcher | null {
  const terms: Matcher[] = [];
  while (state.pos < state.tokens.length) { const term = parseTerm(state); if (!term) break; terms.push(term); }
  return !terms.length ? null : terms.length === 1 ? terms[0] : new AllMatcher(terms);
}
function parseTerm(state: ParseState): Matcher | null {
  const token = state.tokens[state.pos];
  if (!token) return null;
  const { type, content } = token;
  if (type === "text" && state.pos < state.tokens.length - 1 && state.tokens[state.pos + 1].type === "colon" && !state.operatorStack.includes("[")) {
    const name = content.toLowerCase(), operator = Object.hasOwn(OPERATORS, name) ? OPERATORS[name] : null;
    if (!operator) throw fail("obsen.search.error-operator-unknown", { operator: name });
    if (operator.exclusive) for (const parent of state.operatorStack) {
      const outer = OPERATORS[parent];
      if (outer?.exclusive && (!outer.allowSelf || parent !== name)) throw fail("obsen.search.error-operator-nested", { operator: name, parent });
    }
    state.operatorStack.push(name); state.pos++;
    const colon = state.tokens[state.pos];
    state.pos++;
    const operand = parseTerm(state) ?? new TextMatcher("");
    state.operatorStack.pop();
    const matcher = operator.operate(operand);
    matcher.matchedTokens.push(token, colon);
    return matcher;
  }
  if (type === "bracket" && content === "[") {
    if (state.operatorStack.includes("[")) throw fail("obsen.search.error-property-nested");
    state.operatorStack.push(content); state.pos++;
    const key = parseAny(state) ?? new TextMatcher("");
    let value: Matcher | null = null;
    const colons: SearchToken[] = [];
    if (peek(state, "colon")) {
      const colon = state.tokens[state.pos];
      state.operatorStack.push(colon.content); colons.push(colon); state.pos++;
      value = parseAny(state);
      state.operatorStack.pop();
    }
    const matcher = new PropertyMatcher(key, value);
    matcher.matchedTokens = colons;
    matcher.matchedTokens.push(token);
    state.operatorStack.pop();
    if (peek(state, "bracket")) matcher.eatToken(state);
    return matcher;
  }
  if (type === "bracket" && content === "]") return null;
  if (type === "text") { const matcher = new TextMatcher(content); matcher.eatToken(state); return matcher; }
  if (type === "quote") { const matcher = new QuoteMatcher(content); matcher.eatToken(state); return matcher; }
  if (type === "regex") {
    try { new RegExp(content); } catch (error) { throw fail("obsen.search.error-regex", { message: (error as Error).message }); }
    const matcher = new RegexMatcher(content); matcher.eatToken(state); return matcher;
  }
  if (type === "parenthesis" && content === "(") {
    state.pos++;
    let inner = parseAny(state);
    if (state.pos < state.tokens.length) { const next = state.tokens[state.pos]; if (next.type === "parenthesis" && next.content === ")") { inner?.matchedTokens.push(next); state.pos++; } }
    inner ??= new TextMatcher("");
    inner.matchedTokens.push(token);
    return inner;
  }
  if ((type === "parenthesis" && content === ")") || type === "or" || type === "colon") return null;
  if (type === "false" || type === "true" || type === "empty") { const matcher = new LiteralMatcher(content); matcher.eatToken(state); return matcher; }
  if (type === "not") { state.pos++; const operand = parseTerm(state); if (!operand) return null; const matcher = new NotMatcher(operand); matcher.matchedTokens.push(token); return matcher; }
  if (type === "greaterthan" || type === "lessthan") { state.pos++; const operand = parseTerm(state); if (!operand) return null; const matcher = new CompareMatcher(type, operand); matcher.matchedTokens.push(token); return matcher; }
  throw fail("obsen.search.error-parse", { position: token.pos, token: content });
}
export function parseSearch(tokens: SearchToken[]): Matcher | null { return parseAny({ tokens, pos: 0, operatorStack: [] }); }

const INTERNAL_EXTENSIONS = ["md", "canvas", "base"];
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A parsed query; `matcher` is null for an empty query. Throws a localized error for an invalid one. */
export class SearchQuery {
  readonly matcher: Matcher | null;
  readonly requiredInputs: RequiredInputs;
  constructor(readonly query: string, readonly caseSensitive = false) {
    this.matcher = parseSearch(tokenizeSearch(query));
    this.requiredInputs = this.matcher?.requiredInputs() ?? {};
  }
  /** Matches a vault file; returns null when it does not match, otherwise the matched ranges. */
  match(file: SearchFile, content: string, cache?: SearchCache | null): SearchResult | null {
    const extension = file.extension.toLowerCase();
    if (extension === "canvas") {
      let data: { nodes?: Array<{ id: string; type: string; text?: string }> } | undefined;
      try { data = JSON.parse(content); } catch { /* matched by name only */ }
      if (data && Array.isArray(data.nodes)) {
        let matched = false;
        const result: SearchResult = {};
        for (const node of data.nodes) {
          if (node.type !== "text" || typeof node.text !== "string") continue;
          const input = new MatchInput({ filename: file.name, filepath: file.path, content: node.text }, node.text, ["content"], this.caseSensitive);
          input.cache = scanCache(node.text);
          const found = this.run(input);
          if (found !== null) { matched = true; if (found.content) result[`canvas-${node.id}`] = found.content; }
        }
        const named = this.run(new MatchInput({ content: "", filename: file.name, filepath: file.path }, "", ["content", "filename"], this.caseSensitive));
        if (named !== null) { matched = true; if (named.filename) result.filename = named.filename; }
        if (matched) return result;
      }
    }
    const keys: RangeKey[] = [];
    if (INTERNAL_EXTENSIONS.includes(extension)) keys.push("filename");
    if (extension === "md") keys.push("content");
    const input = new MatchInput({ filename: file.name, filepath: file.path, content }, content, keys, this.caseSensitive);
    if (extension === "md") input.cache = cache ?? scanCache(content);
    return this.run(input);
  }
  matchContent(content: string): SearchResult | null { return this.run(new MatchInput({ content }, content, ["content"], this.caseSensitive)); }
  matchTag(tag: string): SearchResult | null { return this.run(new MatchInput({ tag }, tag, ["tag"], this.caseSensitive)); }
  matchFilename(path: string): SearchResult | null { return this.run(new MatchInput({ filename: fileName(path), filepath: path }, path, ["filename"], this.caseSensitive)); }
  matchFilepath(path: string): SearchResult | null { return this.run(new MatchInput({ filename: fileName(path), filepath: path }, path, ["filepath"], this.caseSensitive)); }
  getContext(position: number): SearchContext | null { return this.matcher?.getContext(position) ?? null; }
  explain(): SearchInfo | null { return this.matcher?.describe() ?? null; }
  private run(input: MatchInput): SearchResult | null {
    if (!this.matcher) return null;
    const result = this.matcher.match(input);
    if (result) for (const key of RANGE_KEYS) if (result[key]) result[key] = mergeRanges(result[key]!);
    return result === undefined ? {} : result;
  }
}

/** Minimal metadata read straight from the text, for callers without a metadata cache. */
function scanCache(content: string): SearchCache {
  const cache: SearchCache = { tags: [], headings: [] };
  let offset = 0, line = 0, fence = false;
  const position = (start: number, end: number, lineStart: number): Position => ({ start: { line, col: start - lineStart, offset: start }, end: { line, col: end - lineStart, offset: end } });
  for (const raw of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    else if (!fence) {
      const heading = /^( {0,3})(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
      if (heading) cache.headings!.push({ heading: heading[3], level: heading[2].length, position: position(offset + heading[1].length, offset + raw.length, offset) });
      for (const match of raw.matchAll(INLINE_TAG)) { const start = offset + match.index! + match[1].length; cache.tags!.push({ tag: `#${match[2]}`, position: position(start, start + match[2].length + 1, offset) }); }
    }
    offset += raw.length + 1; line++;
  }
  return cache;
}

type Predicate = (document: SearchDocument) => boolean;
/** Compiles a query into a document predicate; `highlight` lists the plain terms it looks for. */
export function compileSearchQuery(query: string, matchCase = false): { test: Predicate; highlight: string[]; query: SearchQuery } {
  const compiled = new SearchQuery(query, matchCase), highlight: string[] = [];
  (function collect(matcher: Matcher | null, negated: boolean): void {
    if (!matcher) return;
    if (matcher instanceof NotMatcher) collect(matcher.matcher, true);
    else if (matcher instanceof GroupMatcher) matcher.matchers.forEach(child => collect(child, negated));
    else if (matcher instanceof ScopeMatcher) { if (matcher.requiredInputs().content) collect(matcher.matcher, negated); }
    else if (matcher instanceof WrapMatcher) collect(matcher.matcher, negated);
    else if (!negated && (matcher instanceof TextMatcher || matcher instanceof QuoteMatcher) && matcher.text) highlight.push(matcher.text);
  })(compiled.matcher, false);
  const test: Predicate = document => {
    const name = document.name || fileName(document.path), dot = name.lastIndexOf(".");
    const extension = dot > 0 && /^[a-z0-9]+$/i.test(name.slice(dot + 1)) ? name.slice(dot + 1) : "md";
    return compiled.match({ path: document.path, name, extension }, document.content, extension === "md" ? document.cache ?? undefined : undefined) !== null;
  };
  return { test, highlight, query: compiled };
}
