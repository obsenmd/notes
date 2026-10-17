import { process } from "../../platforms/platform";
import { Component } from "../compat/component";
import { Keymap } from "../compat/commands";
import { mountMarkdownEditor, type MarkdownEditorOptions } from "../compat/codemirror-host";
import { Editor } from "../compat/editor";
import { bindEditorFields } from "../compat/api-extras";
import { EditorDocumentSearch } from "../compat/document-search";
import { showEditorContextMenu } from "../compat/editor-menu";
import type { EventRef } from "../compat/events";
import { MarkdownPreviewRenderer, MarkdownRenderer, type MarkdownPostProcessor } from "../compat/markdown";
import { getFrontMatterInfo, parseMarkdownMetadata, type HeadingCache } from "../compat/metadata-cache";
import { PropertiesEditor } from "../compat/properties-editor";
import type { App } from "../compat/plugin";
import { setIcon } from "../compat/utilities";
import { TFile } from "../compat/vault";
import type { WorkspaceLeaf } from "../compat/workspace";
import { t } from "../i18n";
import { readCorePluginData } from "./core-plugins";
import { hideTooltip } from "./tooltip";
import { renderPdfEmbed } from "./pdf/view";

/** The "Page preview" core plugin: hover popovers for internal links, driven by the workspace `hover-link` event. */

export enum PopoverState { Showing, Shown, Hiding, Hidden }
export interface HoverParent { hoverPopover: unknown }
export interface HoverLinkEvent { event: MouseEvent; source: string; hoverParent: HoverParent; targetEl: HTMLElement | null; linktext: string; sourcePath?: string; state?: unknown }
export interface HoverPreviewOptions { isEnabled(): boolean; configDir: string }
interface Point { x: number; y: number; doc: Document }
interface Rect { top: number; bottom: number; left: number; right: number }

/** Sources that need Ctrl/Cmd unless `.obsidian/page-preview.json` says otherwise (the defaults each core plugin registers). */
const DEFAULT_MOD: Record<string, boolean> = { search: true, preview: false, editor: true, "tab-header": true, "file-explorer": true, properties: true, bookmarks: true, outline: true, bases: true, graph: true };
const WAIT = 300;
const IMAGE = /^(?:png|jpe?g|gif|svg|webp|avif|bmp)$/i, AUDIO = /^(?:mp3|wav|m4a|3gp|flac|ogg|oga|opus)$/i, VIDEO = /^(?:mp4|webm|ogv|mov|mkv)$/i;

const pending: HoverPopover[] = [], shown: HoverPopover[] = [];
let pollTimer = 0;
let lastMouse: Point | null = null;

const drop = <T>(list: T[], item: T) => { const index = list.indexOf(item); if (index >= 0) list.splice(index, 1); };
const entered = (event: MouseEvent, el: HTMLElement) => { const related = event.relatedTarget as Node | null; return !related || !el.contains(related); };
const isShown = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0;
const div = (doc: Document, cls: string, parent?: HTMLElement) => { const el = doc.createElement("div"); el.className = cls; parent?.append(el); return el; };

function poll() {
  if (!shown.length) { window.clearInterval(pollTimer); pollTimer = 0; return; }
  if (!lastMouse) return;
  const under = lastMouse.doc.elementFromPoint(lastMouse.x, lastMouse.y);
  for (const popover of [...shown]) popover.detect(under);
  for (const popover of [...shown]) popover.transition();
}
function watch() { if (!pollTimer) pollTimer = window.setInterval(poll, 500); }

function dismiss(event: MouseEvent) {
  for (const popover of [...pending]) popover.hide();
  const target = event.target as Node | null;
  const stale = shown.filter(popover => !popover.isFocused && !popover.hoverEl.contains(target) && !popover.childHovers.some(child => child.hoverEl.contains(target)));
  if (stale.length) window.setTimeout(() => { for (const popover of stale) popover.hide(); }, 5);
}
const track = (event: MouseEvent) => { lastMouse = { x: event.clientX, y: event.clientY, doc: (event.target as Node | null)?.ownerDocument ?? document }; };

/** Routes the Pixi graph's canvas hit-test to the same registered hover-link source as DOM links. */
export function triggerGraphNodeHover(app: App, parent: HoverParent, linktext: string, event: PointerEvent | null, targetEl: HTMLElement | null): void {
  for (const popover of [...pending, ...shown]) if (popover.parent === parent) popover.hide();
  if (!linktext || !event || !targetEl) return;
  app.workspace.trigger("hover-link", { event, source: "graph", hoverParent: parent, targetEl, linktext, sourcePath: "" } satisfies HoverLinkEvent);
}

/** Places `el` beside `rect` like Obsidian: below when it fits, else above, clamped 10px inside the offset parent. */
function place(rect: Rect, el: HTMLElement, gap: number, alignRight: boolean) {
  const doc = el.ownerDocument;
  const parent = (el.offsetParent as HTMLElement | null) ?? doc.documentElement;
  el.style.maxHeight = "";
  const bottomEdge = parent.scrollTop + parent.clientHeight, minTop = parent.scrollTop + 10, maxBottom = bottomEdge - 10;
  const top = Math.min(rect.top, maxBottom), bottom = Math.max(rect.bottom, minTop);
  const height = el.offsetHeight, above = rect.top - minTop, below = maxBottom - rect.bottom;
  const fitsAbove = above >= height + gap, fitsBelow = below >= height + gap;
  let topPx: number | null = null, bottomPx: number | null = null;
  if (fitsBelow) topPx = bottom + gap; else if (fitsAbove || above > below) bottomPx = bottomEdge - (top - gap); else topPx = bottom + gap;
  const minLeft = parent.scrollLeft + 10, maxRight = parent.scrollLeft + parent.clientWidth - 10, width = el.offsetWidth;
  if (alignRight) {
    let right = rect.right;
    if (right > maxRight) right = maxRight; else if (right - width < minLeft) right = minLeft + width;
    el.style.left = ""; el.style.right = `${parent.clientWidth - right}px`;
  } else {
    let left = rect.left;
    if (left < minLeft) left = minLeft; else if (left + width > maxRight) left = maxRight - width;
    el.style.left = `${left}px`; el.style.right = "";
  }
  el.style.top = topPx !== null ? `${topPx}px` : ""; el.style.bottom = bottomPx !== null ? `${bottomPx}px` : "";
  if (!fitsAbove && !fitsBelow) el.style.maxHeight = `${(above > below ? above : below) - gap}px`;
}

export class HoverPopover extends Component {
  readonly hoverEl: HTMLElement;
  state = PopoverState.Showing;
  onTarget = true; onHover = false; isFocused = false;
  private timer = 0;
  private observer: ResizeObserver | null = null;
  private readonly showCallbacks: Array<() => void> = [];
  private readonly win: Window;

  constructor(public parent: HoverParent, public targetEl: HTMLElement | null, public waitTime = WAIT, public staticPos: Point | null = null) {
    super();
    const doc = targetEl?.ownerDocument ?? document;
    this.win = doc.defaultView ?? window;
    const el = this.hoverEl = div(doc, "popover hover-popover");
    targetEl?.addEventListener("mouseover", this.onMouseIn); targetEl?.addEventListener("mouseout", this.onMouseOut);
    el.addEventListener("mouseover", event => { if (entered(event, el)) { this.onHover = true; this.transition(); } });
    el.addEventListener("mouseout", event => { if (entered(event, el)) { this.onHover = false; this.transition(); } });
    this.timer = this.win.setTimeout(() => this.show(), waitTime);
    pending.push(this);
  }

  private onMouseIn = (event: MouseEvent) => { if (!this.targetEl || entered(event, this.targetEl)) { this.onTarget = true; this.transition(); } };
  private onMouseOut = (event: MouseEvent) => { if (!this.targetEl || entered(event, this.targetEl)) { this.onTarget = false; this.transition(); } };

  detect(el: Element | null): void {
    if (this.targetEl) this.onTarget = !!el && this.targetEl.contains(el);
    this.onHover = !!el && this.hoverEl.contains(el);
  }
  get childHovers(): HoverPopover[] { return shown.filter(other => other !== this && !!other.targetEl && this.hoverEl.contains(other.targetEl)); }
  shouldShowSelf(): boolean { return this.onTarget || this.onHover || this.isFocused || this.hoverEl.contains(this.hoverEl.ownerDocument.activeElement); }
  shouldShowChild(): boolean { return this.childHovers.some(child => child.shouldShow()); }
  shouldShow(): boolean { return this.shouldShowSelf() || this.shouldShowChild(); }
  setIsFocused(focused: boolean): void { this.isFocused = focused; }

  transition(): void {
    const show = this.shouldShow(), state = this.state;
    if (show) { if (state === PopoverState.Hiding) { this.state = PopoverState.Shown; this.win.clearTimeout(this.timer); } }
    else if (state === PopoverState.Showing) this.hide();
    else if (state === PopoverState.Shown) {
      this.state = PopoverState.Hiding;
      this.timer = this.win.setTimeout(() => { if (this.shouldShow()) this.transition(); else this.hide(); }, this.waitTime);
    }
  }

  show(): void {
    if (this.state === PopoverState.Hidden) return;
    if (this.targetEl && !this.targetEl.isConnected) { this.hide(); return; }
    this.state = PopoverState.Shown; this.timer = 0;
    this.position(); this.onShow();
    drop(pending, this); shown.push(this); watch();
    this.load();
    for (const callback of this.showCallbacks.splice(0)) callback();
    this.hoverEl.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 80, easing: "cubic-bezier(0, 0.55, 0.45, 1)" });
  }

  hide(): void {
    if (this.state === PopoverState.Hidden) return;
    this.state = PopoverState.Hidden;
    this.showCallbacks.length = 0;
    drop(pending, this); drop(shown, this);
    this.win.clearTimeout(this.timer);
    this.hoverEl.remove();
    this.targetEl?.removeEventListener("mouseover", this.onMouseIn); this.targetEl?.removeEventListener("mouseout", this.onMouseOut);
    this.onTarget = false; this.onHover = false;
    for (const other of [...shown]) if (!other.shouldShowSelf() && other.targetEl && this.hoverEl.contains(other.targetEl)) other.hide();
    this.onHide();
    this.observer?.disconnect(); this.observer = null;
    this.unload();
  }

  onShow(): void {
    const previous = this.parent.hoverPopover as HoverPopover | null;
    if (previous && previous !== this) previous.hide?.();
    this.parent.hoverPopover = this;
    hideTooltip();
  }
  onHide(): void { if (this.parent.hoverPopover === this) this.parent.hoverPopover = null; }

  /** Content can finish rendering during the hover delay; defer scrolling until the popover is attached. */
  whenShown(callback: () => void): void {
    if (this.state === PopoverState.Hidden) return;
    if (this.state === PopoverState.Showing) this.showCallbacks.push(callback);
    else callback();
  }

  position(): void {
    const { hoverEl, targetEl } = this;
    const point = this.staticPos ?? lastMouse;
    let rect: Rect, rtl = false;
    if (!this.staticPos && targetEl) {
      if (lastMouse && targetEl.offsetHeight > 300) { this.staticPos = lastMouse; rect = { top: lastMouse.y - 10, bottom: lastMouse.y + 10, left: lastMouse.x, right: lastMouse.x }; }
      else { const box = targetEl.getBoundingClientRect(); rect = { top: box.top, bottom: box.top + (targetEl.offsetHeight || box.height), left: box.left, right: box.left + (targetEl.offsetWidth || box.width) }; }
    } else if (point) { rect = { top: point.y - 10, bottom: point.y + 10, left: point.x, right: point.x }; this.staticPos = point; }
    else rect = { top: 0, bottom: 0, left: 0, right: 0 };
    const doc = targetEl?.ownerDocument ?? hoverEl.ownerDocument;
    if (targetEl) rtl = this.win.getComputedStyle(targetEl).direction === "rtl";
    if (hoverEl.parentElement !== doc.body) doc.body.appendChild(hoverEl);
    place(rect, hoverEl, 10, rtl);
  }

  /** Repositions while the content settles (images loading, embeds resolving). */
  watchResize(el: HTMLElement): void {
    if (!this.observer) {
      let count = 0;
      this.observer = new ResizeObserver(() => {
        if (this.state !== PopoverState.Shown) return;
        if (++count >= 10) { this.observer?.disconnect(); this.observer = null; return; }
        this.position();
      });
    }
    this.observer.observe(el);
  }
}

/** Embeds rendered inside popovers: links in them resolve against the embedded file and nest under its popover. */
const embeds = new WeakMap<HTMLElement, HoverParent & { sourcePath: string }>();

const splitLink = (linktext: string) => { const text = linktext.split("|", 1)[0]!.trim(), hash = text.indexOf("#"); return hash < 0 ? { path: text, subpath: "" } : { path: text.slice(0, hash), subpath: text.slice(hash) }; };
const extensionOf = (path: string) => { const name = path.slice(path.lastIndexOf("/") + 1), dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""; };
const subpathType = (subpath: string) => subpath.startsWith("#[^") ? "footnote" : subpath.startsWith("#^") ? "block" : "heading";
const plainHeading = (text: string) => text.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~\/\[\]\\\r\n]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const indentWidth = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, "    ").length;

interface Excerpt { type: "heading" | "block" | "footnote"; content: string; heading?: string; level?: number; title?: string; from?: number; to?: number; indent?: string }

/** The part of `data` a `#heading`, `#^block` or `#[^footnote]` subpath points at. */
function extractSubpath(data: string, subpath: string, editable = false): Excerpt | null {
  const parts = subpath.split("#").filter(Boolean);
  if (!parts.length) return null;
  const lines = data.split("\n"), first = parts[0]!;
  if (parts.length === 1 && first.startsWith("^")) {
    const marker = new RegExp(`(?:^|\\s)\\^${first.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    let fenced = false, at = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i]!)) { fenced = !fenced; continue; }
      if (!fenced && marker.test(lines[i]!)) { at = i; break; }
    }
    if (at < 0) return null;
    let start = at, end = at, dedent = 0;
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s/.exec(lines[at]!);
    if (item) {
      dedent = item[1]!.length;
      const indent = indentWidth(lines[at]!);
      while (end + 1 < lines.length && lines[end + 1]!.trim() && indentWidth(lines[end + 1]!) > indent) end++;
    } else {
      if (!lines[at]!.replace(marker, "").trim()) {
        // An id on its own line names the block above it (a table, quote or code block).
        start = at - 1;
        while (start >= 0 && !lines[start]!.trim()) start--;
        if (start < 0) return null;
        end = start;
        if (/^\s*(```|~~~)/.test(lines[start]!)) { start--; while (start > 0 && !/^\s*(```|~~~)/.test(lines[start]!)) start--; }
      }
      while (start > 0 && lines[start - 1]!.trim() && !/^ {0,3}#{1,6}\s/.test(lines[start - 1]!) && !/^\s*(```|~~~)/.test(lines[start - 1]!) && !/^\s*(```|~~~)/.test(lines[start]!)) start--;
    }
    const indent = item?.[1] ?? "", width = indentWidth(indent);
    const content = lines.slice(start, end + 1).map((line, index) => {
      const raw = !editable && start + index === at ? line.replace(marker, "") : line;
      if (!editable) return raw.slice(Math.min(dedent, /^\s*/.exec(line)![0].length));
      let consumed = 0, columns = 0;
      while (consumed < raw.length && columns < width && /[ \t]/.test(raw[consumed]!)) columns += raw[consumed++] === "\t" ? 4 : 1;
      return raw.slice(consumed);
    });
    const from = lines.slice(0, start).reduce((offset, line) => offset + line.length + 1, 0);
    return { type: "block", content: content.join("\n"), from, to: from + lines.slice(start, end + 1).join("\n").length, indent };
  }
  if (parts.length === 1 && first.startsWith("[^")) {
    const prefix = `${first}:`, at = lines.findIndex(line => line.startsWith(prefix));
    if (at < 0) return null;
    const lineStart = lines.slice(0, at).reduce((offset, line) => offset + line.length + 1, 0);
    let end = at;
    while (end + 1 < lines.length && /^( {4}|\t)/.test(lines[end + 1]!)) end++;
    const raw = lines.slice(at, end + 1).join("\n"), label = /^\[\^[^\]]+\]:\s*/.exec(raw)![0];
    return { type: "footnote", content: raw.slice(label.length).replace(/\n( {4}|\t)/g, "\n"), from: lineStart + label.length, to: lineStart + raw.length };
  }
  const headings: HeadingCache[] = parseMarkdownMetadata(data).headings ?? [];
  let matched = 0, level = 0, current: HeadingCache | null = null, next: HeadingCache | null = null;
  for (const heading of headings) {
    if (current && heading.level <= level) { next = heading; break; }
    if (!current && heading.level > level && plainHeading(heading.heading) === plainHeading(parts[matched]!)) { matched++; level = heading.level; if (matched === parts.length) current = heading; }
  }
  if (!current) return null;
  const start = current.position.start.offset, bodyStart = Math.min(data.length, current.position.end.offset + 1);
  return { type: "heading", heading: data.slice(start, bodyStart), level: current.level, title: current.heading, content: data.slice(bodyStart, next ? next.position.start.offset : data.length), from: bodyStart, to: next ? next.position.start.offset : data.length };
}

function installHoverEditor(app: App, file: TFile, subpath: string, data: string, container: HTMLElement, preview: HTMLElement, editorContainer: HTMLElement, owner: HoverPopover, options: Record<string, unknown>, state: unknown): void {
  if (subpath && !extractSubpath(data, subpath, true)) return;
  const doc = container.ownerDocument, win = doc.defaultView ?? window;
  let editor: Editor | null = null, mounted: ReturnType<typeof mountMarkdownEditor> | null = null;
  let timer = 0, clickTimer = 0, revision = 0, savedRevision = 0, writing = Promise.resolve();
  let editorContext: { app: App; file: TFile; editor: Editor; hoverPopover: HoverPopover; contentEl: HTMLElement; getMode(): string; showSearch(replace?: boolean): void; save(): void } | null = null;
  let search: EditorDocumentSearch | null = null;
  const save = () => {
    win.clearTimeout(timer);
    if (!editor || revision === savedRevision) return;
    const text = editor.getValue(), savingRevision = revision;
    writing = writing.catch(() => undefined).then(async () => {
      await app.vault.process(file, current => {
        const normalized = current.replace(/\r\n?/g, "\n"), newline = current.includes("\r\n") ? "\r\n" : "\n";
        let next = text;
        if (subpath) {
          const section = extractSubpath(normalized, subpath, true);
          if (!section || section.from === undefined || section.to === undefined) throw new Error(t("interface.label-unable-to-find-section", { subpath, file: file.basename }));
          const indent = section.type === "footnote" ? (app.vault.getConfig("useTab") ? "\t" : "    ") : section.indent ?? "";
          const indented = text.replace(section.type === "footnote" ? /\n/g : /(^|\n)/g, "$&" + indent);
          next = normalized.slice(0, section.from) + indented + normalized.slice(section.to);
        }
        return newline === "\n" ? next : next.replace(/\n/g, newline);
      });
      savedRevision = savingRevision;
    });
    void writing.catch(error => console.error(error));
  };
  const start = (point?: { x: number; y: number }) => {
    if (editor || owner.state === PopoverState.Hidden) return;
    const section = subpath ? extractSubpath(data, subpath, true) : null;
    editor = new Editor(section?.content ?? data);
    editorContext = { app, file, editor, hoverPopover: owner, contentEl: editorContainer, getMode: () => "source", showSearch: (replace = false) => (search ??= new EditorDocumentSearch(app, container, () => editor!)).show(replace), save };
    app.workspace.activeEditor = editorContext;
    preview.style.display = "none"; editorContainer.style.display = "";
    owner.setIsFocused(true); owner.hoverEl.classList.add("is-editing");
    const source = div(doc, "markdown-source-view cm-s-obsidian mod-cm6", editorContainer);
    mounted = mountMarkdownEditor(source, editor, { ...options as MarkdownEditorOptions, extensions: app.editorExtensions, onFocus: () => { app.workspace.activeEditor = editorContext; }, scrollPastEnd: false, propertiesInDocument: "source" }, {
      renderMarkdown: (text, el) => { void MarkdownRenderer.render(app, text, el, file.path, owner); },
      resolveImage: target => { const resolved = app.metadataCache.getFirstLinkpathDest(target, file.path), image = resolved && app.vault.getFileByPath(resolved.path); return image ? app.vault.getResourcePath(image) : null; },
      isResolved: target => !!app.metadataCache.getFirstLinkpathDest(target, file.path),
      openLink: (target, event) => { void app.workspace.openLinkText(target, file.path, Keymap.isModEvent(event)); },
      openTag: tag => { app.workspace.trigger("search:open", `tag:${tag}`); },
    });
    mounted.view.dispatch({ effects: bindEditorFields.of({ info: editorContext, livePreview: (options as MarkdownEditorOptions).livePreview !== false }) });
    owner.registerEvent(app.workspace.on("editor-extensions-change", () => mounted?.setExtensions(app.editorExtensions)));
    owner.registerDomEvent(source, "contextmenu", event => showEditorContextMenu(app, editor!, editorContext, event));
    owner.registerDomEvent(source, "focusin", () => { app.workspace.activeEditor = editorContext; });
    editor.onChange(() => { revision++; win.clearTimeout(timer); timer = win.setTimeout(save, 2000); });
    if (point) { const position = mounted.view.posAtCoords(point); if (position !== null) editor.setCursor(editor.offsetToPos(position)); }
    editor.focus(); mounted.view.requestMeasure(); owner.position();
  };
  owner.registerDomEvent(container, "click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.detail > 1 || event.shiftKey || (event.target as Element).closest("a, button, input, .metadata-container, .inline-title, .collapse-indicator, .interactive-child, .markdown-embed-link")) return;
    if (win.getSelection()?.isCollapsed === false) return;
    win.clearTimeout(clickTimer);
    clickTimer = win.setTimeout(() => { if (!event.defaultPrevented) start({ x: event.clientX, y: event.clientY }); }, 150);
  });
  owner.registerDomEvent(doc, "click", event => { if (editor && !event.defaultPrevented && !owner.hoverEl.contains(event.target as Node)) owner.hide(); });
  owner.registerDomEvent(doc, "keydown", event => { if (editor && !event.defaultPrevented && event.key === "Escape") { event.preventDefault(); owner.hide(); } });
  owner.register(() => { win.clearTimeout(clickTimer); save(); search?.hide(false); if (app.workspace.activeEditor === editorContext) app.workspace.activeEditor = null; mounted?.destroy(); });
  if ((state as { mode?: string } | null)?.mode === "source") owner.whenShown(() => start());
}

const UNFOLD_PROPERTIES = "page-preview-unfold-properties";

/** Renders into `sizer`; resolves to the section holding source line `line`, when one was asked for. */
async function renderSections(app: App, markdown: string, sizer: HTMLElement, footer: HTMLElement, sourcePath: string, owner: Component, readOnlyTasks: boolean, line: number | null = null): Promise<HTMLElement | null> {
  const doc = sizer.ownerDocument, staging = doc.createElement("div");
  const lines = new Map<HTMLElement, { start: number; end: number }>();
  const track: MarkdownPostProcessor = (el, ctx) => { if (el.parentElement !== staging) return; const info = ctx.getSectionInfo(el); if (info) lines.set(el, { start: info.lineStart, end: info.lineEnd }); };
  if (line !== null) MarkdownPreviewRenderer.registerPostProcessor(track, -1000);
  try { await MarkdownRenderer.render(app, markdown, staging, sourcePath, owner); }
  finally { if (line !== null) MarkdownPreviewRenderer.unregisterPostProcessor(track); }
  for (const child of [...sizer.children]) if (!/markdown-preview-pusher|mod-header|mod-footer/.test(child.className)) child.remove();
  let target: HTMLElement | null = null, before: HTMLElement | null = null;
  for (const child of [...staging.children] as HTMLElement[]) {
    const section = div(doc, `el-${child.classList.contains("callout") ? "div" : child.tagName.toLowerCase()}${child.classList.contains("frontmatter") ? " mod-frontmatter mod-ui" : ""}`), range = lines.get(child);
    if (range && line !== null) { if (range.start <= line && line <= range.end) target ??= section; else if (range.end < line) before = section; }
    section.append(child); sizer.insertBefore(section, footer);
  }
  // Task lines of an excerpt are numbered within the excerpt, so toggling them cannot be mapped back onto the file.
  if (readOnlyTasks) for (const box of sizer.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox")) { const copy = box.cloneNode(true) as HTMLInputElement; copy.disabled = true; box.replaceWith(copy); }
  return target ?? before;
}

/** The note's properties above the preview, as reading view shows them; folded unless the last preview left them open. */
function addProperties(app: App, file: TFile, data: string | null, header: HTMLElement, owner: Component): void {
  const info = data === null ? { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 } : getFrontMatterInfo(data);
  const write = (yaml: string | null) => void app.vault.process(file, current => {
    const now = getFrontMatterInfo(current), block = yaml === null ? "" : `---\n${yaml}\n---\n`;
    return block + (now.exists ? current.slice(now.contentStart) : current);
  });
  const properties = new PropertiesEditor({ app, onChange: write, onOpenLink: (target, event) => { void app.workspace.openLinkText(target, file.path, Keymap.isModEvent(event)); } }, header.ownerDocument);
  // The block is part of every whole-note preview; without properties it stays empty and hidden.
  properties.setSource(info.exists ? info.frontmatter.replace(/\r?\n$/, "") : null);
  const el = properties.containerEl;
  if (!info.exists) el.style.display = "none";
  header.append(el);
  if (!app.loadLocalStorage(UNFOLD_PROPERTIES)) el.querySelector<HTMLElement>(".metadata-properties-heading")?.click();
  owner.register(() => app.saveLocalStorage(UNFOLD_PROPERTIES, !el.classList.contains("is-collapsed")));
}

interface CanvasBox { minX: number; minY: number; maxX: number; maxY: number }
type CanvasSide = "top" | "right" | "bottom" | "left";

/** The miniature of a canvas the reference embeds: one rectangle per card or group, one curve per connection. */
function renderCanvasMinimap(containerEl: HTMLElement, json: string): void {
  let data: { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> };
  try { data = JSON.parse(json); } catch { return; }
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [], edges = Array.isArray(data?.edges) ? data.edges : [];
  if (!nodes.length) return;
  const doc = containerEl.ownerDocument, svgEl = (tag: string) => doc.createElementNS("http://www.w3.org/2000/svg", tag);
  const svg = svgEl("svg"); svg.classList.add("canvas-minimap");
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const boxes = new Map<unknown, CanvasBox>();
  for (const node of nodes) { const x = number(node.x), y = number(node.y); boxes.set(node.id, { minX: x, minY: y, maxX: x + number(node.width), maxY: y + number(node.height) }); }
  let bounds: CanvasBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const box of boxes.values()) bounds = { minX: Math.min(bounds.minX, box.minX), minY: Math.min(bounds.minY, box.minY), maxX: Math.max(bounds.maxX, box.maxX), maxY: Math.max(bounds.maxY, box.maxY) };
  const paint = (el: SVGElement, color: unknown) => {
    const value = typeof color === "string" ? color.trim() : "";
    el.classList.toggle("is-themed", !!value);
    if (/^\d+$/.test(value)) el.classList.add(`mod-canvas-color-${value}`);
    else if (/^#[0-9a-f]{3,8}$/i.test(value)) {
      const hex = value.length < 7 ? value.slice(1).split("").map(char => char + char).join("") : value.slice(1);
      el.classList.add("mod-canvas-color-custom"); el.style.setProperty("--canvas-color", `#${hex.slice(0, 6)}`);
    }
  };
  const rect = (node: Record<string, unknown>) => {
    const el = svgEl("rect");
    for (const [name, value] of Object.entries({ x: number(node.x), y: number(node.y), width: number(node.width), height: number(node.height), rx: 20, ry: 20 })) el.setAttribute(name, String(value));
    paint(el, node.color); svg.append(el);
  };
  const anchor = (box: CanvasBox, side: unknown) => side === "top" ? { x: (box.minX + box.maxX) / 2, y: box.minY } : side === "right" ? { x: box.maxX, y: (box.minY + box.maxY) / 2 }
    : side === "bottom" ? { x: (box.minX + box.maxX) / 2, y: box.maxY } : side === "left" ? { x: box.minX, y: (box.minY + box.maxY) / 2 } : null;
  const control = (side: CanvasSide, point: { x: number; y: number }, reach: number) => side === "left" ? { x: point.x - reach, y: point.y } : side === "right" ? { x: point.x + reach, y: point.y }
    : side === "top" ? { x: point.x, y: point.y - reach } : { x: point.x, y: point.y + reach };
  for (const node of nodes) if (node.type === "group") rect(node);
  const strokeWidth = Math.sqrt((bounds.maxX - bounds.minX) / 10);
  for (const edge of edges) {
    const fromBox = boxes.get(edge.fromNode), toBox = boxes.get(edge.toNode);
    const from = fromBox && anchor(fromBox, edge.fromSide), to = toBox && anchor(toBox, edge.toSide);
    if (!from || !to) continue;
    const reach = Math.min(150, Math.max(70, Math.hypot(to.x - from.x, to.y - from.y) / 2));
    const first = control(edge.fromSide as CanvasSide, from, reach), second = control(edge.toSide as CanvasSide, to, reach);
    const path = svgEl("path");
    path.setAttribute("d", `M${from.x},${from.y} C${first.x},${first.y} ${second.x},${second.y} ${to.x},${to.y}`);
    path.style.strokeWidth = String(strokeWidth); paint(path, edge.color); svg.append(path);
  }
  for (const node of nodes) if (node.type !== "group") rect(node);
  const margin = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 20;
  svg.setAttribute("viewBox", `${bounds.minX - margin} ${bounds.minY - margin} ${bounds.maxX - bounds.minX + 2 * margin} ${bounds.maxY - bounds.minY + 2 * margin}`);
  containerEl.append(svg);
}

async function loadMarkdownEmbed(app: App, containerEl: HTMLElement, file: TFile, subpath: string, owner: Component, state?: unknown): Promise<void> {
  const doc = containerEl.ownerDocument, options = app.editorOptions as unknown as Record<string, unknown>;
  containerEl.classList.add("markdown-embed");
  const previewEl = div(doc, "markdown-embed-content node-insert-event", containerEl), editorEl = div(doc, "markdown-embed-content node-insert-event", containerEl);
  editorEl.style.display = "none";
  const link = div(doc, "markdown-embed-link", containerEl);
  setIcon(link, "lucide-maximize-2"); link.setAttribute("aria-label", t("editor.link-popover.tooltip-open-link"));
  link.addEventListener("mousedown", event => { if (event.button === 1) event.preventDefault(); });
  const open = (event: MouseEvent) => { if (event.button !== 0 && event.button !== 1) return; event.preventDefault(); void app.workspace.openLinkText(file.path + subpath, "", Keymap.isModEvent(event)); };
  link.addEventListener("click", open); link.addEventListener("auxclick", open);

  const view = div(doc, ["markdown-preview-view markdown-rendered node-insert-event", options.showIndentGuide !== false && "show-indentation-guide", options.foldHeading !== false && "allow-fold-headings",
    options.foldIndent !== false && "allow-fold-lists", options.rightToLeft && "rtl", options.propertiesInDocument !== "hidden" && "show-properties"].filter(Boolean).join(" "), previewEl);
  const sizer = div(doc, "markdown-preview-sizer markdown-preview-section", view);
  const pusher = div(doc, "markdown-preview-pusher", sizer); Object.assign(pusher.style, { width: "1px", height: "0.1px", marginBottom: "0px" });
  const header = div(doc, "mod-header mod-ui", sizer), footer = div(doc, "mod-footer mod-ui", sizer);
  const title = div(doc, "inline-title", header);
  title.contentEditable = "false"; title.tabIndex = -1; title.textContent = file.basename;

  let data = (await app.vault.cachedRead(file)).replace(/\r\n?/g, "\n"), excerpt: Excerpt | null = null;
  if (subpath) {
    // An excerpt carries the (empty, hidden) properties block too.
    if (options.propertiesInDocument !== "hidden") addProperties(app, file, null, header, owner);
    excerpt = extractSubpath(data, subpath);
    const label = subpath.slice(1).replace(/(\[|\])/g, "\\$1");
    if (excerpt) {
      containerEl.dataset.type = excerpt.type; data = excerpt.content;
      if (excerpt.type !== "heading") title.textContent = "";
      if (excerpt.type === "heading") {
        const staging = doc.createElement("div");
        await MarkdownRenderer.render(app, excerpt.heading ?? "", staging, file.path, owner);
        const heading = staging.querySelector("h1,h2,h3,h4,h5,h6");
        heading?.querySelector(".heading-collapse-indicator")?.remove();
        if (heading) { title.classList.add("markdown-rendered"); title.replaceChildren(heading); } else title.textContent = excerpt.title ?? "";
        title.setAttribute("data-level", String(excerpt.level ?? 1));
      }
    } else if (subpathType(subpath) === "footnote") {
      data = t("plugins.page-preview.label-missing-footote", { id: label });
      containerEl.dataset.type = "footnote"; containerEl.classList.add("mod-empty");
      const create = () => {
        containerEl.classList.remove("mod-empty"); containerEl.removeEventListener("click", create);
        void app.vault.process(file, current => { const trailing = /\n*$/.exec(current)![0].length; return `${current}${"\n".repeat(2 - Math.min(trailing, 2))}${subpath.slice(1)}: \n`; });
      };
      containerEl.addEventListener("click", create);
    } else data = `##### ${t("interface.label-unable-to-find-section", { subpath: label, file: file.basename })}`;
  }
  else if (options.propertiesInDocument !== "hidden") addProperties(app, file, data, header, owner);
  const scroll = (state as { scroll?: unknown } | null | undefined)?.scroll;
  const line = !subpath && typeof scroll === "number" && Number.isFinite(scroll) ? Math.max(0, Math.floor(scroll)) : null;
  const target = await renderSections(app, data, sizer, footer, file.path, owner, !!subpath, line);
  // The footer only anchors the sections while rendering; a popover has none.
  if (!footer.childElementCount) footer.remove();
  if (owner instanceof HoverPopover) installHoverEditor(app, file, subpath, (await app.vault.cachedRead(file)).replace(/\r\n?/g, "\n"), containerEl, previewEl, editorEl, owner, options, state);
  if (!target) return;
  // A preview opened for a search match shows the matching line, centred and flashed.
  const reveal = () => { if (!target.isConnected) return; target.scrollIntoView({ block: "center" }); target.classList.add("is-flashing"); doc.defaultView?.setTimeout(() => target.classList.remove("is-flashing"), 3000); };
  if (owner instanceof HoverPopover) owner.whenShown(reveal);
  else if (containerEl.isConnected && containerEl.getClientRects().length) reveal(); else doc.defaultView?.requestAnimationFrame(reveal);
}

/** Fills `containerEl` with the embed for `linktext`, as Obsidian's embed registry does for a hover popover. */
async function loadEmbed(app: App, containerEl: HTMLElement, linktext: string, sourcePath: string, owner: Component, state?: unknown): Promise<void> {
  const doc = containerEl.ownerDocument, { path, subpath } = splitLink(linktext);
  const destination = path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : null;
  const file = app.vault.getAbstractFileByPath(destination?.path ?? (path ? "" : sourcePath));
  containerEl.replaceChildren();
  if (file instanceof TFile && file.extension.toLowerCase() === "md") containerEl.classList.add("markdown-embed");
  containerEl.classList.add("is-loaded");
  embeds.set(containerEl, { hoverPopover: null, sourcePath: file instanceof TFile ? file.path : sourcePath });
  const openLink = (event: MouseEvent) => { void app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event)); };
  if (!(file instanceof TFile)) {
    const extension = extensionOf(path);
    containerEl.classList.add("file-embed");
    if (!extension || /^(?:md|canvas|base)$/.test(extension)) {
      containerEl.classList.add("mod-empty"); containerEl.append(t("plugins.page-preview.label-empty-note", { linktext }));
      containerEl.addEventListener("click", openLink);
    } else { containerEl.classList.add("mod-empty-attachment"); containerEl.append(t("plugins.page-preview.label-empty-attachment", { linktext })); }
    return;
  }
  const extension = file.extension.toLowerCase();
  if (extension === "md") { await loadMarkdownEmbed(app, containerEl, file, subpath, owner, state); return; }
  if (extension === "pdf") {
    // Reuse the native pdf.js embed so page fragments and the viewer's toolbar behave as they do in notes.
    owner.addChild(renderPdfEmbed(app, file, containerEl, { sourcePath, subpath, linktext }));
    return;
  }
  if (extension === "canvas") {
    containerEl.classList.add("canvas-embed");
    containerEl.addEventListener("click", openLink);
    renderCanvasMinimap(containerEl, await app.vault.cachedRead(file));
    return;
  }
  if (extension === "base") {
    // Whatever the Bases plugin registered for embeds renders the preview; without it the file card below is used.
    const staging = doc.createElement("div");
    await MarkdownRenderer.render(app, `![[${file.path}${subpath}]]`, staging, sourcePath, owner);
    const embed = staging.querySelector<HTMLElement>(".bases-embed") ?? [...staging.querySelectorAll<HTMLElement>("div")].find(el => !el.closest("p") && el.childElementCount > 0) ?? null;
    if (embed) { if (embed.classList.contains("bases-embed")) { containerEl.classList.add("bases-embed"); containerEl.append(...embed.childNodes); } else containerEl.append(embed); return; }
  }
  const src = app.vault.getResourcePath(file);
  if (IMAGE.test(extension)) {
    containerEl.classList.add("media-embed", "image-embed");
    const image = doc.createElement("img"); image.src = src; image.alt = file.name; containerEl.append(image);
  } else if (AUDIO.test(extension) || VIDEO.test(extension)) {
    const kind = AUDIO.test(extension) ? "audio" : "video";
    containerEl.classList.add("media-embed", `${kind}-embed`);
    const media = doc.createElement(kind); media.controls = true; media.preload = "metadata"; media.src = src; containerEl.append(media);
  } else {
    containerEl.classList.add("file-embed", "mod-generic");
    const title = div(doc, "file-embed-title", containerEl), icon = doc.createElement("span");
    icon.className = "file-embed-icon"; setIcon(icon, "lucide-file"); title.append(icon, ` ${file.name}`);
    containerEl.addEventListener("click", openLink);
  }
}

export interface LinkPopoverSpec { hoverParent: HoverParent; targetEl: HTMLElement | null; linktext: string; sourcePath?: string; waitTime?: number; position?: Point | null; state?: unknown }

/** Opens the popover for a link; resolves to null when the pointer left before the content was due. */
export async function createLinkPopover(app: App, spec: LinkPopoverSpec): Promise<HoverPopover | null> {
  const popover = new HoverPopover(spec.hoverParent, spec.targetEl, spec.waitTime ?? WAIT, spec.position ?? null);
  await new Promise(resolve => window.setTimeout(resolve, Math.max(0, popover.waitTime - 100)));
  if (popover.state === PopoverState.Hidden) return null;
  const containerEl = div(popover.hoverEl.ownerDocument, "", popover.hoverEl);
  containerEl.removeAttribute("class");
  popover.watchResize(containerEl);
  try { await loadEmbed(app, containerEl, spec.linktext, spec.sourcePath ?? "", popover, spec.state); }
  catch (error) { console.error(error); popover.hide(); return null; }
  if ((popover.state as PopoverState) === PopoverState.Shown) popover.position();
  return popover;
}

interface Hovered { source: string; targetEl: HTMLElement; linktext: string; sourcePath: string; hoverParent: HoverParent }

export function installHoverPreview(app: App, options: HoverPreviewOptions, doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  const sourceParents = new Map<string, HoverParent>();
  const parentFor = (source: string) => { let parent = sourceParents.get(source); if (!parent) sourceParents.set(source, parent = { hoverPopover: null }); return parent; };
  let settings: Record<string, unknown> = {}, settingsRead = 0, settingsLoad: Promise<void> | null = null;
  const loadSettings = (): Promise<void> => {
    if (Date.now() - settingsRead < 1000) return Promise.resolve();
    return settingsLoad ??= readCorePluginData(options.configDir, "page-preview").then(data => { settings = data; }, () => undefined).then(() => { settingsRead = Date.now(); settingsLoad = null; });
  };
  void loadSettings();

  const leafOf = (el: Element): WorkspaceLeaf | null => { let found: WorkspaceLeaf | null = null; app.workspace.iterateAllLeaves(leaf => { if (!found && leaf.containerEl.contains(el)) found = leaf; }); return found; };
  const leafPath = (leaf: WorkspaceLeaf | null) => { const file = (leaf?.view as { file?: { path?: unknown } | null } | undefined)?.file; return typeof file?.path === "string" ? file.path : ""; };
  const activePath = () => { const file = app.workspace.getActiveFile() as { path?: unknown } | null; return typeof file?.path === "string" ? file.path : ""; };
  const paneType = (el: Element) => el.closest<HTMLElement>(".workspace-leaf-content")?.dataset.type ?? "";
  const rowPath = (row: HTMLElement) => {
    if (row.dataset.path) return row.dataset.path;
    const text = (row.querySelector(".tree-item-inner-text") ?? row.querySelector(".tree-item-inner"))?.textContent?.trim() ?? "";
    return text ? app.metadataCache.getFirstLinkpathDest(text, "")?.path ?? text : "";
  };

  const identify = (target: Element): Hovered | null => {
    const editor = target.closest<HTMLElement>(".markdown-source-view");
    if (editor && !target.closest(".markdown-rendered, .markdown-embed, .internal-embed")) {
      const el = target.closest<HTMLElement>("[data-link-target], [data-link-url]");
      if (!el || !editor.contains(el)) return null;
      let linktext = el.dataset.linkTarget ?? "";
      if (!linktext) {
        const url = el.dataset.linkUrl ?? "";
        if (!url || /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) return null;
        try { linktext = decodeURIComponent(url); } catch { linktext = url; }
      }
      const leaf = leafOf(el);
      return { source: "editor", targetEl: el, linktext, sourcePath: leafPath(leaf) || activePath(), hoverParent: leaf ?? parentFor("editor") };
    }
    const anchor = target.closest<HTMLElement>(".internal-link, .metadata-link-inner.internal-link");
    if (anchor) {
      const linktext = anchor.dataset.href ?? anchor.getAttribute("href") ?? anchor.dataset.internalLink ?? "";
      if (!linktext) return null;
      const source = anchor.closest(".metadata-container") ? "properties" : anchor.closest(".bases-view, .bases-embed") ? "bases" : "preview";
      for (let el: HTMLElement | null = anchor; el; el = el.parentElement) {
        const embed = embeds.get(el);
        if (embed) return { source, targetEl: anchor, linktext, sourcePath: embed.sourcePath, hoverParent: embed };
      }
      const leaf = leafOf(anchor), nested = anchor.closest<HTMLElement>("[data-embed-path]")?.dataset.embedPath;
      return { source, targetEl: anchor, linktext, sourcePath: nested || leafPath(leaf) || activePath(), hoverParent: leaf ?? parentFor(source) };
    }
    const file = target.closest<HTMLElement>(".nav-file-title[data-path]");
    if (file) return file.querySelector("input, [contenteditable='true']") ? null : { source: "file-explorer", targetEl: file, linktext: file.dataset.path ?? "", sourcePath: "", hoverParent: parentFor("file-explorer") };
    const tab = target.closest<HTMLElement>(".workspace-tab-header");
    if (tab) {
      const tabs = tab.closest(".workspace-tabs"), index = [...(tab.parentElement?.children ?? [])].indexOf(tab);
      const leafEl = tabs?.querySelectorAll(":scope > .workspace-tab-container > .workspace-leaf")[index];
      const leaf = leafEl ? leafOf(leafEl.querySelector(".view-content") ?? leafEl) : null;
      const path = (leaf?.getViewState().state as { file?: unknown } | undefined)?.file;
      return leaf && typeof path === "string" && app.vault.getAbstractFileByPath(path) instanceof TFile ? { source: "tab-header", targetEl: tab, linktext: path, sourcePath: "", hoverParent: leaf } : null;
    }
    const row = target.closest<HTMLElement>(".tree-item-self");
    if (!row || target.closest(".collapse-icon")) return null;
    const pane = paneType(row);
    if (pane === "outline") {
      const heading = row.querySelector(".tree-item-inner")?.textContent?.trim(), path = activePath();
      return heading && path ? { source: "outline", targetEl: row, linktext: `#${heading}`, sourcePath: path, hoverParent: parentFor("outline") } : null;
    }
    const source = row.classList.contains("bookmark") && !row.classList.contains("mod-collapsible") ? "bookmarks"
      : row.matches(".search-result-file-title, .outgoing-link-item") || pane === "search" || pane === "backlink" || pane === "outgoing-link" ? "search" : "";
    if (!source || (source === "search" && !row.matches(".search-result-file-title, .outgoing-link-item"))) return null;
    const linktext = rowPath(row);
    if (!linktext || (source === "bookmarks" && !(app.vault.getAbstractFileByPath(linktext) instanceof TFile))) return null;
    return { source, targetEl: row, linktext, sourcePath: pane === "outgoing-link" || pane === "backlink" ? activePath() : "", hoverParent: parentFor(source) };
  };

  const onMouseOver = (event: MouseEvent) => {
    if (!options.isEnabled()) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const hovered = identify(target);
    if (!hovered || !entered(event, hovered.targetEl)) return;
    app.workspace.trigger("hover-link", { event, ...hovered } satisfies HoverLinkEvent);
  };

  const openPopover = (parent: HoverParent, targetEl: HTMLElement | null, linktext: string, sourcePath: string, state?: unknown) => {
    const current = parent.hoverPopover as HoverPopover | null;
    if (current && current.state !== PopoverState.Hidden && targetEl && current.targetEl === targetEl) return;
    void createLinkPopover(app, { hoverParent: parent, targetEl, linktext, sourcePath, state });
  };

  const onHoverLink = (payload: unknown) => {
    if (!options.isEnabled() || !payload || typeof payload !== "object") return;
    const { event, source, hoverParent, targetEl, linktext, sourcePath = "", state } = payload as HoverLinkEvent;
    if (!event || !hoverParent || typeof linktext !== "string") return;
    if ((event as PointerEvent).pointerType && (event as PointerEvent).pointerType !== "mouse") return;
    const related = event.relatedTarget as HTMLElement | null;
    if (related && typeof related.getClientRects === "function" && !isShown(related)) return;
    track(event);
    const eventDoc = (event.target as Node | null)?.ownerDocument ?? doc;
    const stillThere = () => !targetEl || targetEl.isConnected;
    void loadSettings().then(() => {
      if (!stillThere()) return;
      const registered = (app.workspace as unknown as { hoverLinkSources?: Record<string, { defaultMod?: boolean }> }).hoverLinkSources?.[source];
      const needsMod = Object.prototype.hasOwnProperty.call(settings, source) ? !!settings[source] : registered?.defaultMod ?? DEFAULT_MOD[source] ?? true;
      if (!needsMod || Keymap.isModifier(event, "Mod")) { openPopover(hoverParent, targetEl, linktext, sourcePath, state); return; }
      if (!targetEl) return;
      // Wait for Ctrl/Cmd to be pressed while the pointer rests on the link.
      let done = false, idle = 0;
      const stop = () => {
        done = true; win.clearTimeout(idle);
        eventDoc.removeEventListener("keydown", onKey); eventDoc.removeEventListener("mouseover", onOver); eventDoc.removeEventListener("mouseleave", onLeave);
        eventDoc.removeEventListener("mousemove", onMove); eventDoc.removeEventListener("click", stop);
      };
      const onKey = (key: KeyboardEvent) => {
        if (done) return;
        if (!stillThere() || (source === "graph" && targetEl?.dataset.graphHover !== linktext) || key.key.startsWith("Arrow") || key.key.length === 1) stop();
        else if (Keymap.isModifier(key, "Mod")) { stop(); openPopover(hoverParent, targetEl, linktext, sourcePath, state); }
      };
      const onMove = () => { win.clearTimeout(idle); idle = win.setTimeout(stop, 2000); };
      const onOver = (over: MouseEvent) => { if (!done && !targetEl.contains(over.target as Node)) stop(); };
      const onLeave = (leave: MouseEvent) => { if (!done && leave.target === eventDoc) stop(); };
      eventDoc.addEventListener("keydown", onKey); eventDoc.addEventListener("mouseleave", onLeave); eventDoc.addEventListener("mouseover", onOver);
      eventDoc.addEventListener("mousemove", onMove); eventDoc.addEventListener("click", stop);
    });
  };

  const ref: EventRef = app.workspace.on("hover-link", onHoverLink);
  doc.addEventListener("mouseover", onMouseOver);
  win.addEventListener("click", dismiss, { capture: true }); win.addEventListener("contextmenu", dismiss, { capture: true }); win.addEventListener("mousemove", track);
  return () => {
    app.workspace.offref(ref);
    doc.removeEventListener("mouseover", onMouseOver);
    win.removeEventListener("click", dismiss, { capture: true }); win.removeEventListener("contextmenu", dismiss, { capture: true }); win.removeEventListener("mousemove", track);
    for (const popover of [...pending, ...shown]) if (popover.hoverEl.ownerDocument === doc) popover.hide();
  };
}
