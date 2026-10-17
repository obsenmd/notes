import { process } from "../../platforms/platform";
import { Component } from "./component";
import { t } from "../i18n";
import { Keymap } from "./commands";
import type { App } from "./plugin";
import { TFile } from "./vault";
import { getFrontMatterInfo, parseMarkdownMetadata } from "./metadata-cache";
import { renderMarkdown as parseMarkdown } from "./markdown-parser";
import { finishReadingView } from "./mermaid";

export interface MarkdownPostProcessor {
  (el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<unknown> | void;
  sortOrder?: number;
}

const renderedSectionInformation = new WeakMap<HTMLElement, MarkdownSectionInformation>();
/** @internal Source positions for view scroll synchronization, retained without DOM attributes. */
export function getRenderedSectionInformation(el: HTMLElement): MarkdownSectionInformation | undefined { return renderedSectionInformation.get(el); }

export interface MarkdownSectionInformation {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export interface MarkdownPostProcessorContext {
  docId: string;
  sourcePath: string;
  frontmatter: unknown | null | undefined;
  addChild(child: MarkdownRenderChild): void;
  getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
}

/** Component whose lifetime follows the rendered markdown section containing its element. */
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) { super(); }
}

type ProcessorEntry = { processor: MarkdownPostProcessor; order: number; serial: number };
let processorSerial = 0;
const postProcessors: ProcessorEntry[] = [];
const renderOwners = new WeakMap<HTMLElement, { component: Component; owner: MarkdownRenderChild }>();

type FileEmbedRenderer = (file: TFile, el: HTMLElement, options: { sourcePath: string; subpath: string; linktext?: string }) => Component;
const fileEmbedRenderers = new WeakMap<App, Map<string, FileEmbedRenderer>>();
/** Built-in file embeds share the markdown render owner's lifetime. Registrations are per vault. */
export function registerFileEmbedRenderer(app: App, extension: string, renderer: FileEmbedRenderer): () => void {
  let renderers = fileEmbedRenderers.get(app);
  if (!renderers) fileEmbedRenderers.set(app, renderers = new Map());
  renderers.set(extension, renderer);
  return () => { if (renderers.get(extension) === renderer) renderers.delete(extension); };
}

/** Markdown rendering and post-processor compatibility surface. */
export abstract class MarkdownRenderer extends MarkdownRenderChild {
  app!: App;
  hoverPopover: unknown | null = null;
  abstract get file(): unknown;

  /** @internal Release processor children owned by the previous render in this container. */
  static clearRender(el: HTMLElement): void {
    const previous = renderOwners.get(el);
    if (!previous) return;
    renderOwners.delete(el);
    previous.component.removeChild(previous.owner);
  }

  static async render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    MarkdownRenderer.clearRender(el);
    const owner = new MarkdownRenderChild(el);
    try {
      renderOwners.set(el, { component, owner });
      component.addChild(owner);
      const frontmatterInfo = getFrontMatterInfo(markdown);
      const frontmatter = app.metadataCache?.getCache(sourcePath)?.frontmatter ?? parseMarkdownMetadata(markdown).frontmatter;
      const body = frontmatterInfo.exists ? markdown.slice(frontmatterInfo.contentStart) : markdown;
      const frontmatterLineCount = frontmatterInfo.exists ? markdown.slice(0, frontmatterInfo.contentStart).split(/\r?\n/).length - 1 : 0;
      const sections = parseMarkdown(body, el, frontmatterLineCount, { deferFinish: true, strictLineBreaks: app.editorOptions?.strictLineBreaks });
      for (const node of el.querySelectorAll<HTMLElement>("*")) {
        const info = sections.get(node);
        if (info) renderedSectionInformation.set(node, info);
      }
      if (frontmatterInfo.exists) {
        // Shown only when properties are displayed as source; plugins look for it either way.
        const pre = el.ownerDocument.createElement("pre"), code = el.ownerDocument.createElement("code");
        pre.className = "frontmatter language-yaml"; code.className = "language-yaml";
        code.textContent = frontmatterInfo.frontmatter.replace(/\r?\n$/, "");
        if ((app.editorOptions as { propertiesInDocument?: string } | undefined)?.propertiesInDocument !== "source") pre.style.display = "none";
        pre.append(code); el.prepend(pre);
      }
      for (const checkbox of el.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox[data-task-line]")) {
        const lineIndex = Number(checkbox.dataset.taskLine);
        const expectedLine = markdown.split(/\r?\n/)[lineIndex];
        if (!app.vault || !expectedLine) { checkbox.disabled = true; continue; }
        owner.registerDomEvent(checkbox, "change", () => {
          const file = app.vault.getAbstractFileByPath(sourcePath);
          if (!(file instanceof TFile)) { checkbox.checked = !checkbox.checked; return; }
          const checked = checkbox.checked;
          checkbox.disabled = true;
          void app.vault.process(file, current => toggleTaskLine(current, lineIndex, checked, expectedLine)).catch(() => {
            checkbox.checked = !checked;
          }).finally(() => { checkbox.disabled = false; });
        });
      }
      // Wikilinks are a core Obsidian syntax. Resolve them after parsing so this
      // module can keep its parser independent of the host's vault implementation.
      await resolveInternalLinks(app, el, sourcePath, new Set([sourcePath]), 0, owner);
      // A newer render may have replaced this one while embed files were read.
      if (renderOwners.get(el)?.owner !== owner) return;
      const docId = `${sourcePath}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const sectionInfo = (node: HTMLElement): MarkdownSectionInformation | null => {
        if (sections.has(node)) return sections.get(node)!;
        let current: HTMLElement | null = node;
        while (current && current.parentElement !== el) current = current.parentElement;
        return current ? sections.get(current) ?? null : null;
      };
      const processors = [...postProcessors].sort((a, b) => a.order - b.order || a.serial - b.serial);
      for (const section of [...el.children].filter((node): node is HTMLElement => node instanceof HTMLElement)) {
        const sectionOwner = owner.addChild(new MarkdownRenderChild(section));
        const ctx: MarkdownPostProcessorContext = {
          docId, sourcePath, frontmatter,
          addChild(child) { sectionOwner.addChild(child); },
          getSectionInfo: sectionInfo,
        };
        for (const { processor } of processors) {
          await processor(section, ctx);
          if (renderOwners.get(el)?.owner !== owner) return;
        }
      }
      if (renderOwners.get(el)?.owner !== owner) return;
      finishReadingView(el, app, sourcePath);
    } catch (error) {
      if (renderOwners.get(el)?.owner === owner) renderOwners.delete(el);
      try { component.removeChild(owner); } catch { /* preserve the rendering error */ }
      throw error;
    }
  }

  /** @deprecated Use render(app, markdown, el, sourcePath, component). */
  static async renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    const app = (component as Component & { app?: App }).app;
    await MarkdownRenderer.render(app ?? ({} as App), markdown, el, sourcePath, component);
  }
}

/** Reject stale preview positions so clicking a task cannot overwrite another line. */
export function toggleTaskLine(content: string, lineIndex: number, checked: boolean, expectedLine?: string): string {
  const lines = content.split(/(\r?\n)/);
  const index = lineIndex * 2;
  const line = lines[index];
  if (line === undefined || (expectedLine !== undefined && line !== expectedLine)) throw new Error(t("obsen.editor.error-task-moved"));
  const match = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)([^\]])(\]\s)/.exec(line);
  if (!match) throw new Error(t("obsen.editor.error-task-moved"));
  lines[index] = match[1] + (checked ? "x" : " ") + match[3] + line.slice(match[0].length);
  return lines.join("");
}

async function resolveInternalLinks(app: App, root: HTMLElement, sourcePath: string, ancestry: Set<string>, depth: number, owner: Component): Promise<void> {
  for (const image of [...root.querySelectorAll<HTMLImageElement>("img[data-resource-link], img[src]")]) {
    const link = image.dataset.resourceLink ?? image.getAttribute("src") ?? "";
    if (hasUrlScheme(link) || link.startsWith("#") || link.startsWith("//")) continue;
    const resourcePath = resolveResourceFile(app, link, sourcePath);
    if (!resourcePath) {
      image.classList.add("is-unresolved");
      continue;
    }
    image.src = app.vault.getResourcePath(resourcePath);
    delete image.dataset.resourceLink;
  }
  for (const anchor of [...root.querySelectorAll<HTMLAnchorElement>("a[href]")]) {
    const href = anchor.getAttribute("href") ?? "";
    if (hasUrlScheme(href) || href.startsWith("#") || href.startsWith("//")) continue;
    anchor.dataset.internalLink = href;
    anchor.dataset.markdownLink = "true";
    anchor.removeAttribute("href");
  }
  for (const anchor of [...root.querySelectorAll<HTMLAnchorElement>("a[data-internal-link]")]) {
    const linkpath = anchor.dataset.internalLink ?? "";
    const destination = app.metadataCache?.getFirstLinkpathDest(linkpath, sourcePath);
    const file = destination ? app.vault?.getAbstractFileByPath(destination.path) : null;
    const isEmbed = anchor.dataset.embed === "true";
    anchor.classList.add(isEmbed ? "internal-embed" : "internal-link");
    if (!isEmbed) { anchor.dataset.href = linkpath; anchor.setAttribute("href", linkpath); anchor.target = "_blank"; anchor.rel = "noopener nofollow"; }
    if (!isEmbed) {
      // Unresolved links stay clickable: following one creates the note.
      if (!destination || !(file instanceof TFile)) anchor.classList.add("is-unresolved");
      anchor.addEventListener("click", (event) => {
        if (event.button !== 0 && event.button !== 1) return;
        event.preventDefault();
        if (app.workspace) void app.workspace.openLinkText(linkpath, sourcePath, Keymap.isModEvent(event));
      });
      anchor.addEventListener("auxclick", (event) => { if (event.button === 1) { event.preventDefault(); if (app.workspace) void app.workspace.openLinkText(linkpath, sourcePath, "tab"); } });
      continue;
    }
    if (!destination || !(file instanceof TFile)) {
      anchor.classList.add("is-unresolved");
      continue;
    }
    const embedRenderer = fileEmbedRenderers.get(app)?.get(file.extension.toLowerCase());
    if (embedRenderer) {
      const embedded = root.ownerDocument.createElement(file.extension.toLowerCase() === "pdf" ? "span" : "div");
      anchor.replaceWith(embedded);
      owner.addChild(embedRenderer(file, embedded, { sourcePath, subpath: linkpath.includes("#") ? linkpath.slice(linkpath.indexOf("#")) : "", linktext: linkpath }));
    } else if (file instanceof TFile && file.extension.toLowerCase() === "md" && depth < 5 && !ancestry.has(file.path)) {
      const contents = await app.vault.cachedRead(file);
      const embedded = document.createElement("div");
      embedded.className = "markdown-embed";
      embedded.dataset.embedPath = file.path;
      parseMarkdown(contents, embedded);
      const next = new Set(ancestry); next.add(file.path);
      await resolveInternalLinks(app, embedded, file.path, next, depth + 1, owner);
      anchor.replaceWith(embedded);
    } else if (file instanceof TFile && /^(?:png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(file.extension)) {
      const image = document.createElement("img");
      image.className = "internal-embed";
      image.alt = anchor.textContent ?? file.name;
      image.src = app.vault.getResourcePath(file);
      anchor.replaceWith(image);
    } else {
      anchor.href = `#${encodeURIComponent(destination.path)}`;
    }
  }
}

function resolveResourceFile(app: App, link: string, sourcePath: string): TFile | null {
  let decoded = link.trim();
  try { decoded = decodeURIComponent(decoded); } catch { /* Retain invalid escapes as literal path characters. */ }
  const clean = decoded.split(/[?#]/, 1)[0]!.replace(/\\/g, "/");
  const candidates = [clean.startsWith("/") ? clean.slice(1) : `${sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) + "/" : ""}${clean}`, clean.replace(/^\.\//, "")];
  for (const candidate of candidates) {
    const file = app.vault?.getAbstractFileByPath(candidate);
    if (file instanceof TFile) return file;
  }
  return null;
}

export class MarkdownPreviewRenderer {
  static registerPostProcessor(processor: MarkdownPostProcessor, sortOrder = processor.sortOrder ?? 0): void {
    if (postProcessors.some((entry) => entry.processor === processor)) return;
    postProcessors.push({ processor, order: sortOrder, serial: processorSerial++ });
  }

  static unregisterPostProcessor(processor: MarkdownPostProcessor): void {
    const index = postProcessors.findIndex((entry) => entry.processor === processor);
    if (index !== -1) postProcessors.splice(index, 1);
  }

  static createCodeBlockPostProcessor(
    language: string,
    handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<unknown> | void,
  ): MarkdownPostProcessor {
    const processor: MarkdownPostProcessor = async (el, ctx) => {
      const blocks = [...el.querySelectorAll<HTMLElement>("pre > code")];
      if (el.matches("pre") && el.querySelector("code")) blocks.unshift(el.querySelector<HTMLElement>("code")!);
      const wanted = `language-${language.toLowerCase()}`;
      for (const code of blocks) {
        if (![...code.classList].some((name) => name.toLowerCase() === wanted)) continue;
        const pre = code.parentElement;
        if (pre) await handler(code.textContent ?? "", pre, ctx);
      }
    };
    return processor;
  }
}

function hasUrlScheme(value: string): boolean { return value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value); }
