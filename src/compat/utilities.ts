import { Buffer } from "../../platforms/platform";
import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from "yaml";
/** Small cross-platform helpers exposed by the Obsidian compatibility layer. */
import { iconAliases, lucideIcons } from "../../assets/obsidian/lucide-icons";
import { customIcons } from "../../assets/icons";

export interface Debouncer<T extends unknown[], V> {
  (...args: T): this;
  cancel(): this;
  run(): V | void;
}

export function debounce<T extends unknown[], V>(cb: (...args: T) => V, timeout = 0, resetTimer = true): Debouncer<T, V> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let args: T | undefined;
  let result: V | undefined;
  const invoke = (): V | void => {
    if (!args) return;
    const pending = args;
    args = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    result = cb(...pending);
    return result;
  };
  const debounced = ((...next: T) => {
    args = next;
    if (timer !== undefined && resetTimer) clearTimeout(timer);
    if (timer === undefined || resetTimer) timer = setTimeout(invoke, Math.max(0, timeout));
    return debounced;
  }) as Debouncer<T, V>;
  debounced.cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; args = undefined; return debounced; };
  debounced.run = () => invoke();
  return debounced;
}

/** Normalize separators and redundant path segments while keeping relative paths relative. */
export function normalizePath(path: string): string {
  const absolute = /^[\\/]/.test(path);
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

export function getLinkpath(linktext: string): string {
  let value = linktext.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  value = value.split("|", 1)[0].split("#", 1)[0].trim();
  return normalizePath(value);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Convert binary data to a base64 string without depending on browser-only APIs. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunk to avoid overflowing the argument stack for large vault files.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, Math.min(start + 0x8000, bytes.length)));
  }
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}

/** Convert binary data to lowercase hexadecimal. */
export function arrayBufferToHex(data: ArrayBuffer): string {
  return Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const text = linktext.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  const withoutAlias = text.split("|", 1)[0].trim();
  const hash = withoutAlias.indexOf("#");
  return hash < 0
    ? { path: normalizePath(withoutAlias), subpath: "" }
    : { path: normalizePath(withoutAlias.slice(0, hash)), subpath: withoutAlias.slice(hash + 1).trim() };
}

export function parseFrontMatterEntry(frontmatter: any | null, key: string | RegExp): any | null {
  if (!frontmatter || typeof frontmatter !== "object") return null;
  if (typeof key === "string") return Object.prototype.hasOwnProperty.call(frontmatter, key) ? frontmatter[key] : null;
  for (const [name, value] of Object.entries(frontmatter)) {
    key.lastIndex = 0;
    if (key.test(name)) return value;
  }
  return null;
}

export function parseFrontMatterStringArray(frontmatter: any | null, key: string | RegExp): string[] | null {
  const value = parseFrontMatterEntry(frontmatter, key);
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? value.slice() : null;
}

export function parseFrontMatterAliases(frontmatter: any | null): string[] | null {
  return parseFrontMatterStringArray(frontmatter, "aliases");
}

export function parseFrontMatterTags(frontmatter: any | null): string[] | null {
  const tags = parseFrontMatterStringArray(frontmatter, "tags");
  if (!tags) return null;
  return tags.map((tag) => tag.startsWith("#") ? tag.slice(1) : tag);
}

/** Normalize heading text for matching against generated heading slugs. */
export function stripHeading(heading: string): string {
  return heading.replace(/\\([\\`*_{}\[\]()#+.!>])/g, "$1").replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Make heading text suitable for inclusion in a wikilink. */
export function stripHeadingForLink(heading: string): string {
  return heading.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/\\([\\`*_{}\[\]()#+.!>])/g, "$1").replace(/[\r\n]+/g, " ").trim();
}

export type HexString = string;
export type TooltipPlacement = "bottom" | "right" | "left" | "top";
export interface TooltipOptions { placement?: TooltipPlacement; classes?: string[]; gap?: number; delay?: number }
/** Tooltips are rendered by the renderer's delegated `[aria-label]` handler. */
export function setTooltip(el: HTMLElement, tooltip: string, options: TooltipOptions = {}): void {
  el.setAttribute("aria-label", tooltip);
  if (options.placement && options.placement !== "bottom") el.setAttribute("data-tooltip-position", options.placement);
  if (options.classes?.length) el.setAttribute("data-tooltip-classes", options.classes.join(" "));
  if (options.delay) el.setAttribute("data-tooltip-delay", String(options.delay));
  if (options.gap) el.setAttribute("data-tooltip-gap", String(options.gap));
}

export function displayTooltip(el: HTMLElement, content: string | DocumentFragment, options: TooltipOptions = {}): void {
  const text = typeof content === "string" ? content : content.textContent ?? "";
  setTooltip(el, text, options);
}

// Matches the pinned desktop reference (Obsidian 1.14.4).
export let apiVersion = "1.12.7";
export function requireApiVersion(version: string): boolean {
  const requested = version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const current = apiVersion.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(requested.length, current.length); i++) {
    const difference = (current[i] ?? 0) - (requested[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/^#/, "").replace(/\s+/g, "");
  if (clean.length % 2 || !/^[\da-f]*$/i.test(clean)) throw new TypeError("Invalid hexadecimal string");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

/** Parse YAML frontmatter, including nested maps, sequences, aliases and block scalars. */
export function parseYaml(yaml: string): unknown {
  return parseYamlDocument(yaml, { schema: "core", maxAliasCount: 100 });
}

export function stringifyYaml(value: unknown): string {
  return stringifyYamlDocument(value, { schema: "core", lineWidth: 0 });
}

const icons = new Map<string, string>();
/** Register or replace a custom SVG icon. Sanitization is applied when the icon is rendered. */
export function addIcon(iconId: string, svgContent: string): void { icons.set(iconId, svgContent); }
/** Remove a previously registered custom icon. */
export function removeIcon(iconId: string): void { icons.delete(iconId); }
export function getIconIds(): string[] { return [...Object.keys(lucideIcons).map(id => `lucide-${id}`), ...icons.keys(), ...Object.keys(customIcons)]; }
const STROKED = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
/** Resolution order matches the reference: lucide ids, registered icons, built-in glyphs, then legacy aliases. */
function resolveIcon(iconId: string): { source: string; className: string } | null {
  if (iconId.startsWith("lucide-")) {
    const body = lucideIcons[iconId.slice(7)];
    return body === undefined ? null : { source: `<svg ${STROKED}>${body}</svg>`, className: iconId };
  }
  const registered = icons.get(iconId);
  if (registered !== undefined) return { source: /<svg/i.test(registered) ? registered : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${registered}</svg>`, className: iconId };
  if (Object.hasOwn(customIcons, iconId)) return { source: customIcons[iconId], className: iconId };
  const id = Object.hasOwn(iconAliases, iconId) ? iconAliases[iconId] : iconId;
  return Object.hasOwn(lucideIcons, id) ? { source: `<svg ${STROKED}>${lucideIcons[id]}</svg>`, className: `lucide-${id}` } : null;
}
export function getIcon(iconId: string): SVGSVGElement | null {
  const resolved = resolveIcon(iconId);
  const source = resolved?.source;
  if (source === undefined || typeof DOMParser === "undefined" || typeof document === "undefined") return null;
  // Reject DTDs outright; plugin supplied SVG should never cause entity expansion.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return null;
  // Custom icons are often supplied as SVG fragments without an explicit xmlns.
  const parserSource = /<svg\b[^>]*\bxmlns\s*=/.test(source)
    ? source
    : source.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const parsedDocument = new DOMParser().parseFromString(parserSource, "image/svg+xml");
  const parsed = parsedDocument.documentElement;
  if (parsed.localName !== "svg" || parsed.namespaceURI !== "http://www.w3.org/2000/svg" || parsedDocument.querySelector("parsererror")) return null;

  // Keep SVG drawing primitives and internal fragment references, but strip active
  // content, event handlers, inline CSS, and remote resource loads before insertion.
  parsed.querySelectorAll("script, style, foreignObject, iframe, object, embed, audio, video, image").forEach((node) => node.remove());
  const elements = [parsed, ...Array.from(parsed.querySelectorAll("*"))];
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "style" || name === "src") {
        element.removeAttributeNode(attribute);
      } else if ((name === "href" || name === "src") && value && !value.startsWith("#")) {
        element.removeAttributeNode(attribute);
      } else if (/javascript\s*:/i.test(value) || /url\(\s*["']?(?!#)/i.test(value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  const icon = document.importNode(parsed, true) as unknown as SVGSVGElement;
  icon.classList.add("svg-icon", resolved!.className);
  return icon;
}
export function setIcon(parent: HTMLElement, iconId: string): void {
  const icon = getIcon(iconId);
  if (!icon) { parent.replaceChildren(); return; }
  parent.replaceChildren(icon);
}
