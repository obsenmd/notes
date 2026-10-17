import { parse as parseYamlDocument } from "yaml";
import { Events } from "./events";

/** The file fields MetadataCache needs; the host can supply its own TFile class. */
export interface MetadataFile {
  path: string;
  basename: string;
  extension: string;
}

export interface MetadataResolver {
  getFiles(): readonly MetadataFile[];
  getFileByPath(path: string): MetadataFile | null;
}

export interface Loc { line: number; col: number; offset: number }
export interface Pos { start: Loc; end: Loc }
export interface CacheItem { position: Pos }
export interface Reference { link: string; original: string; displayText?: string }
export interface ReferenceCache extends Reference, CacheItem {}
export interface LinkCache extends ReferenceCache {}
export interface EmbedCache extends ReferenceCache {}
export interface HeadingCache extends CacheItem { heading: string; level: number }
export interface TagCache extends CacheItem { tag: string }
export interface SectionCache extends CacheItem { type: string; id?: string }
export interface FrontMatterCache { [key: string]: unknown }
export interface FrontMatterInfo { exists: boolean; frontmatter: string; from: number; to: number; contentStart: number }
export interface CachedMetadata {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  sections?: SectionCache[];
  frontmatter?: FrontMatterCache;
  frontmatterPosition?: Pos;
  blocks?: Record<string, { id: string; position: Pos }>;
}

/**
 * Indexes Markdown metadata and resolves internal links against a host-provided
 * file tree. The adapter keeps this module independent of any particular Vault.
 */
export class MetadataCache extends Events {
  readonly resolvedLinks: Record<string, Record<string, number>> = {};
  readonly unresolvedLinks: Record<string, Record<string, number>> = {};
  private readonly cacheByPath = new Map<string, CachedMetadata>();
  private readonly dataByPath = new Map<string, string>();
  private readonly canvasLinks = new Map<string, Reference[]>();
  readonly uniqueFileLookup: Record<string, string> = {};

  constructor(private readonly resolver: MetadataResolver) { super(); }

  getFileCache(file: MetadataFile): CachedMetadata | null {
    return this.getCache(file.path);
  }

  getFileInfoForLink(linktext: string, sourcePath: string): { path: string; exists: boolean } | null {
    const file = this.getFirstLinkpathDest(linktext, sourcePath);
    return file ? { path: file.path, exists: true } : null;
  }

  getCache(path: string): CachedMetadata | null {
    return this.cacheByPath.get(normalizePath(path)) ?? null;
  }

  /** Index supplied file data, then emit the official `changed` notification. */
  setFileCache(file: MetadataFile, data: string, cache = file.extension.toLowerCase() === "canvas" ? {} : parseMarkdownMetadata(data)): CachedMetadata {
    const path = normalizePath(file.path);
    this.dataByPath.set(path, data);
    this.cacheByPath.set(path, cache);
    if (file.extension.toLowerCase() === "canvas") this.canvasLinks.set(path, parseCanvasReferences(data));
    else this.canvasLinks.delete(path);
    this.rebuildLinkMaps();
    this.trigger("changed", file, data, cache);
    this.trigger("resolve", file);
    this.trigger("resolved");
    return cache;
  }

  /** Remove a file's index and notify listeners with its last available cache. */
  removeFile(file: MetadataFile): void {
    const path = normalizePath(file.path);
    const previous = this.cacheByPath.get(path) ?? null;
    this.cacheByPath.delete(path);
    this.dataByPath.delete(path);
    this.canvasLinks.delete(path);
    this.rebuildLinkMaps();
    this.trigger("deleted", file, previous);
    this.trigger("resolved");
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): MetadataFile | null {
    const linkPath = linkpath.trim().split(/[?#]/, 1)[0];
    const normalized = normalizePath(linkPath), available = this.resolver.getFiles();
    const suffix = /\.([^/.]+)$/.exec(normalized)?.[1].toLowerCase();
    const extension = suffix && available.some(file => file.extension.toLowerCase() === suffix) ? suffix : null;
    const clean = extension ? stripExtension(normalized) : normalized;
    if (!clean) return null;
    const files = extension ? available.filter(file => file.extension.toLowerCase() === extension) : available;
    const asGiven = this.findFile(normalized);
    if (asGiven) return asGiven;
    const direct = !extension || extension === "md" ? this.findFile(`${clean}.md`) : null;
    if (direct) return direct;

    const sourceFolder = dirname(normalizePath(sourcePath));
    const relative = normalizePath(sourceFolder ? `${sourceFolder}/${clean}` : clean);
    const relativeMatch = this.matchCandidates(files, relative);
    if (relativeMatch) return relativeMatch;

    const aliasMatch = files.find(file => {
      const cache = this.getCache(file.path);
      const aliases = cache?.frontmatter?.aliases;
      const values = Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : [];
      return values.some(alias => String(alias).toLocaleLowerCase() === clean.toLocaleLowerCase());
    });
    if (aliasMatch) return aliasMatch;

    const targetBase = basename(clean).toLocaleLowerCase();
    const candidates = files.filter(file =>
      file.basename.toLocaleLowerCase() === targetBase || stripExtension(file.path).toLocaleLowerCase() === clean.toLocaleLowerCase(),
    );
    candidates.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return candidates[0] ?? null;
  }

  fileToLinktext(file: MetadataFile, _sourcePath: string, omitMdExtension = false): string {
    const files = this.resolver.getFiles();
    const sameName = files.filter(candidate => candidate.basename.toLocaleLowerCase() === file.basename.toLocaleLowerCase());
    const result = sameName.length > 1 ? normalizePath(file.path) : file.basename;
    return omitMdExtension && /\.md$/i.test(result) ? result.slice(0, -3) : result;
  }

  private findFile(path: string): MetadataFile | null {
    return this.resolver.getFileByPath(path) ?? this.resolver.getFileByPath(stripExtension(path));
  }

  private matchCandidates(files: readonly MetadataFile[], target: string): MetadataFile | null {
    const targetNorm = target.toLocaleLowerCase();
    return files.find(file => stripExtension(normalizePath(file.path)).toLocaleLowerCase() === targetNorm)
      ?? files.find(file => normalizePath(file.path).toLocaleLowerCase() === `${targetNorm}.md`)
      ?? null;
  }

  private rebuildLinkMaps(): void {
    for (const key of Object.keys(this.uniqueFileLookup)) delete this.uniqueFileLookup[key];
    for (const key of Object.keys(this.resolvedLinks)) delete this.resolvedLinks[key];
    for (const key of Object.keys(this.unresolvedLinks)) delete this.unresolvedLinks[key];
    for (const [sourcePath, cache] of this.cacheByPath) {
      const resolved: Record<string, number> = {};
      const unresolved: Record<string, number> = {};
      for (const link of this.canvasLinks.get(sourcePath) ?? [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
        if (/^(?:[a-z]+:)?\/\//i.test(link.link) || link.link.startsWith("mailto:")) continue;
        const destination = this.getFirstLinkpathDest(link.link, sourcePath);
        const target = destination ? resolved : unresolved;
        const path = destination?.path ?? link.link;
        target[path] = (target[path] ?? 0) + 1;
      }
      if (Object.keys(resolved).length) this.resolvedLinks[sourcePath] = resolved;
      if (Object.keys(unresolved).length) this.unresolvedLinks[sourcePath] = unresolved;
    }
    for (const file of this.resolver.getFiles()) {
      const key = file.basename.toLocaleLowerCase();
      if (this.uniqueFileLookup[key] !== undefined) this.uniqueFileLookup[key] = "";
      else this.uniqueFileLookup[key] = file.path;
    }
  }
}

/** Canvas keeps its public cache empty; node references still contribute to link resolution. */
export function parseCanvasReferences(data: string): Array<Reference & { nodeId: string; position?: Pos }> {
  try {
    const document = JSON.parse(data) as { nodes?: Array<{ id?: string; type?: string; text?: string; file?: string; subpath?: string; background?: string }> };
    const references: Array<Reference & { nodeId: string; position?: Pos }> = [];
    for (const node of document.nodes ?? []) {
      if (typeof node.id !== "string") continue;
      if (node.type === "text" && typeof node.text === "string") {
        const cache = parseMarkdownMetadata(node.text);
        for (const link of [...(cache.links ?? []), ...(cache.embeds ?? [])]) references.push({ ...link, nodeId: node.id });
      } else {
        const path = node.type === "file" ? node.file : node.type === "group" ? node.background : undefined;
        if (typeof path === "string" && path) references.push({ nodeId: node.id, link: path + (node.subpath ?? ""), original: path });
      }
    }
    return references;
  } catch { return []; }
}

/** Return cached inline and frontmatter tags without duplicate entries. */
export function getAllTags(cache: CachedMetadata): string[] | null {
  const frontmatterTags = cache.frontmatter?.tags;
  const fromFrontmatter = typeof frontmatterTags === "string"
    ? frontmatterTags.split(/[\s,]+/).filter(Boolean)
    : Array.isArray(frontmatterTags) ? frontmatterTags.filter((tag): tag is string => typeof tag === "string") : [];
  const tags = [...(cache.tags ?? []).map(item => item.tag), ...fromFrontmatter.map(tag => tag.startsWith("#") ? tag : `#${tag}`)];
  return tags.length ? [...new Set(tags)] : null;
}

/** Find the YAML frontmatter block at the start of Markdown content. */
export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const from = opening[0].length;
  const closing = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/m.exec(content.slice(from));
  if (!closing) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const delimiterOffset = closing[0].startsWith("\r\n") ? 2 : closing[0].startsWith("\n") ? 1 : 0;
  const to = from + closing.index + delimiterOffset;
  return { exists: true, frontmatter: content.slice(from, to), from, to, contentStart: from + closing.index + closing[0].length };
}

/** Parse the commonly used Markdown metadata fields into Obsidian cache shapes. */
export function parseMarkdownMetadata(data: string): CachedMetadata {
  const result: CachedMetadata = {};
  const links: LinkCache[] = [];
  const embeds: EmbedCache[] = [];
  const tags: TagCache[] = [];
  const headings: HeadingCache[] = [];
  const sections: SectionCache[] = [];
  const blocks: Record<string, { id: string; position: Pos }> = {};
  const lines = data.split(/\r?\n/);
  let offset = 0;
  let inCodeFence = false;
  let frontmatterEnd = -1;

  if (lines[0]?.trim() === "---") {
    let closing = 1;
    while (closing < lines.length && !["---", "..."].includes(lines[closing].trim())) closing++;
    if (closing < lines.length) {
      const startOffset = lines[0].length + 1;
      let endOffset = startOffset;
      for (let i = 1; i < closing; i++) endOffset += lines[i].length + 1;
      result.frontmatter = parseSimpleYaml(lines.slice(1, closing));
      result.frontmatterPosition = makePos(data, startOffset, endOffset);
      frontmatterEnd = closing;
    }
  }

  lines.forEach((line, lineIndex) => {
    const lineOffset = offset;
    offset += line.length + 1;
    if (lineIndex <= frontmatterEnd) return;
    if (/^\s*(```|~~~)/.test(line)) { inCodeFence = !inCodeFence; return; }
    if (inCodeFence) return;

    const heading = /^( {0,3})(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const start = lineOffset + heading[1].length;
      headings.push({ heading: heading[3], level: heading[2].length, position: makePos(data, start, lineOffset + line.length) });
      sections.push({ type: "heading", position: makePos(data, lineOffset, lineOffset + line.length) });
    }

    const block = /(?:^|\s)\^([\w-]+)\s*$/.exec(line);
    if (block) blocks[block[1]] = { id: block[1], position: makePos(data, lineOffset + block.index, lineOffset + line.length) };

    const tagPattern = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
    for (const match of line.matchAll(tagPattern)) {
      const start = lineOffset + (match.index ?? 0) + match[1].length;
      tags.push({ tag: `#${match[2]}`, position: makePos(data, start, start + match[2].length + 1) });
    }

    const linkPattern = /(!?)\[\[([^\]]+)\]\]|(!?)\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of line.matchAll(linkPattern)) {
      const original = match[0];
      const isEmbed = match[1] === "!" || match[3] === "!";
      const raw = (match[2] ?? match[4] ?? "").trim();
      const wiki = match[2] !== undefined;
      const pipe = wiki ? raw.indexOf("|") : -1;
      const destination = wiki ? (pipe < 0 ? raw : raw.slice(0, pipe).trim()) : markdownDestination(raw);
      if (/^(?:[a-z]+:)?\/\//i.test(destination) || destination.startsWith("mailto:")) continue;
      const displayText = pipe < 0 ? undefined : raw.slice(pipe + 1).trim();
      const item: LinkCache = {
        link: destination,
        original,
        ...(displayText ? { displayText } : {}),
        position: makePos(data, lineOffset + (match.index ?? 0), lineOffset + (match.index ?? 0) + original.length),
      };
      (isEmbed ? embeds : links).push(item);
    }
    if (line.trim() && !heading && !/^\s*(?:[-*+]\s|\d+\.\s)/.test(line)) {
      sections.push({ type: /^\s*>/.test(line) ? "blockquote" : "paragraph", position: makePos(data, lineOffset, lineOffset + line.length) });
    }
  });

  if (links.length) result.links = links;
  if (embeds.length) result.embeds = embeds;
  if (tags.length) result.tags = tags;
  if (headings.length) result.headings = headings;
  if (sections.length) result.sections = sections;
  if (Object.keys(blocks).length) result.blocks = blocks;
  return result;
}

function parseSimpleYaml(lines: string[]): FrontMatterCache {
  try {
    const parsed: unknown = parseYamlDocument(lines.join("\n"), { schema: "core", maxAliasCount: 100 });
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as FrontMatterCache : {};
  } catch { return {}; }
}

function makePos(data: string, start: number, end: number): Pos {
  return { start: makeLoc(data, start), end: makeLoc(data, end) };
}

function makeLoc(data: string, offset: number): Loc {
  const before = data.slice(0, offset);
  const line = (before.match(/\n/g) ?? []).length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, col: offset - lastBreak - 1, offset };
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}

function stripExtension(path: string): string { return path.replace(/\.[^/.]+$/, ""); }
function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function dirname(path: string): string { const index = path.lastIndexOf("/"); return index < 0 ? "" : path.slice(0, index); }

/** The target of a Markdown link: without angle brackets or a title, and percent-decoded, as the reference caches it. */
function markdownDestination(raw: string): string {
  const bracketed = /^<([^>]*)>/.exec(raw);
  const target = bracketed ? bracketed[1] : raw.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "");
  try { return decodeURI(target); } catch { return target; }
}
