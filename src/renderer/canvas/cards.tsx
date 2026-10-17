import { process } from "../../../platforms/platform";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Keymap } from "../../compat/commands";
import { mountMarkdownEditor } from "../../compat/codemirror-host";
import { Component } from "../../compat/component";
import { Editor } from "../../compat/editor";
import { MarkdownRenderer } from "../../compat/markdown";
import { getFrontMatterInfo } from "../../compat/metadata-cache";
import { PropertiesEditor } from "../../compat/properties-editor";
import { renderMarkdown } from "../../compat/markdown-parser";
import type { LivePreviewHost } from "../../compat/obsidian-markdown";
import type { App } from "../../compat/plugin";
import { TFile } from "../../compat/vault";
import { t } from "../../i18n";
import { IconEl, cx } from "../ui";
import type { CanvasController } from "./controller";
import { isLightColor, isPresetColor, parseCanvas, parseHexColor, type CanvasNode } from "./data";
import { bboxOf, bezier, growBBox, sideAnchor, unionBBox, type Side } from "./geometry";
import { AUDIO_EXTENSIONS, CanvasFilePicker, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, createNoteFromLinktext } from "./modals";

/** Class and custom property that give an element a canvas colour (a preset number or a hex value). */
export function colorProps(color: string): { className: string; style: CSSProperties } {
  if (!color) return { className: "", style: {} };
  if (isPresetColor(color)) return { className: `is-themed mod-canvas-color-${color}`, style: {} };
  const rgb = parseHexColor(color);
  return rgb ? { className: "is-themed mod-canvas-color-custom", style: { "--canvas-color": `#${[rgb.r, rgb.g, rgb.b].map(part => part.toString(16).padStart(2, "0")).join("")}` } as CSSProperties } : { className: "is-themed", style: {} };
}
export const webviewPartition = (app: App) => app.getWebviewPartition();
const YOUTUBE = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)(?:\/(?:[\w\-]+\?(?:.*?\&)*v=|embed\/|v\/)?)([\w\-]+)(?:\??&?(?:t|start)=([0-9]+))?(?:\S+)?$/;
const TWEET = /^(?:https?:\/\/)?(?:mobile\.)?(?:twitter|x)\.com\/.+\/(\d+)/;
/** Pages that only work framed through their embed address. */
export function embedUrl(url: string, dark: boolean): string {
  const video = url.match(YOUTUBE);
  if (video) return `https://www.youtube-nocookie.com/embed/${video[1]}${video[2] ? `?start=${video[2]}` : ""}`;
  const tweet = url.match(TWEET);
  return tweet ? `https://platform.twitter.com/embed/Tweet.html?dnt=true&theme=${dark ? "dark" : "light"}&id=${tweet[1]}` : url;
}

export interface Excerpt { title: { source: string; level: number } | null; body: string; missing?: boolean }
/** The part of a note a `#heading` or `#^block` subpath refers to: a heading becomes the card's title and its section the body. */
export function excerptOf(app: App, file: TFile, content: string, subpath: string): Excerpt {
  const cache = app.metadataCache.getFileCache(file), target = subpath.replace(/^#/, "");
  if (!target || !cache) return { title: null, body: content };
  if (target.startsWith("^")) {
    const id = target.slice(1).toLowerCase(), block = Object.values(cache.blocks ?? {}).find(item => item.id.toLowerCase() === id) ?? cache.sections?.find(section => section.id?.toLowerCase() === id);
    return block ? { title: null, body: content.slice(block.position.start.offset, block.position.end.offset) } : { title: null, body: "", missing: true };
  }
  const plain = (text: string) => text.replace(/[#^|[\]]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const headings = cache.headings ?? [], wanted = plain(target.split("#").at(-1)!), index = headings.findIndex(heading => plain(heading.heading) === wanted);
  if (index < 0) return { title: null, body: "", missing: true };
  const heading = headings[index], next = headings.slice(index + 1).find(other => other.level <= heading.level);
  const bodyStart = Math.min(content.length, heading.position.end.offset + 1);
  return { title: { source: content.slice(heading.position.start.offset, bodyStart), level: heading.level }, body: content.slice(bodyStart, next ? next.position.start.offset : content.length) };
}
/** Kept for callers that want the excerpt as one piece of Markdown. */
export function sliceSubpath(app: App, file: TFile, content: string, subpath: string): string {
  const excerpt = excerptOf(app, file, content, subpath);
  return excerpt.missing ? content : (excerpt.title?.source ?? "") + excerpt.body;
}

function useLivePreviewHost(app: App, sourcePath: string): LivePreviewHost {
  return useMemo<LivePreviewHost>(() => ({
    renderMarkdown: (source, el) => { renderMarkdown(source, el, 0, { mermaid: app, strictLineBreaks: app.editorOptions.strictLineBreaks }); },
    mermaidAllowed: () => app.loadLocalStorage("mermaid-vault-trust") === true,
    allowMermaid: () => { app.saveLocalStorage("mermaid-vault-trust", true); app.workspace.trigger("post-processor-change"); },
    resolveImage: target => {
      const found = app.metadataCache.getFirstLinkpathDest(target.split("#")[0], sourcePath), file = found ? app.vault.getAbstractFileByPath(found.path) : null;
      return file instanceof TFile && IMAGE_EXTENSIONS.includes(file.extension.toLowerCase()) ? app.vault.getResourcePath(file) : null;
    },
    isResolved: target => !target || !!app.metadataCache.getFirstLinkpathDest(target, sourcePath),
    openLink: (target, event) => { void app.workspace.openLinkText(target, sourcePath, Keymap.isModEvent(event)); },
    openTag: tag => { app.workspace.trigger("search:open", `tag:${tag}`); },
  }), [app, sourcePath]);
}

interface EmbedHeader { file: TFile; title: Excerpt["title"]; frontmatter: string | null; whole: boolean }
/** Rendered Markdown in the reference's embed structure (sections under a sizer, a header for notes), and its editor while the card is being edited. */
function MarkdownBody({ app, source, sourcePath, editing, point, onInput, onEscape, header }: { app: App; source: string; sourcePath: string; editing: boolean; point: { x: number; y: number } | null; onInput(text: string): void; onEscape(): void; header?: EmbedHeader }) {
  const preview = useRef<HTMLDivElement>(null), editorFrame = useRef<HTMLIFrameElement>(null);
  const host = useLivePreviewHost(app, sourcePath);
  const latest = useRef({ source, onInput, point, onEscape }); latest.current = { source, onInput, point, onEscape };
  const options = app.editorOptions as unknown as Record<string, unknown>;
  const headerFile = header?.file ?? null, titleSource = header?.title?.source ?? null, titleLevel = header?.title?.level ?? 0, frontmatter = header?.frontmatter ?? null, whole = header?.whole ?? false;
  useLayoutEffect(() => {
    const sizer = preview.current;
    if (!sizer) return;
    const doc = sizer.ownerDocument, make = (cls: string, parent?: HTMLElement) => { const node = doc.createElement("div"); node.className = cls; parent?.append(node); return node; };
    const owner = new Component(); owner.load();
    let cancelled = false;
    const pusher = make("markdown-preview-pusher"); Object.assign(pusher.style, { width: "1px", height: "0.1px", marginBottom: "0px" });
    const fixed: HTMLElement[] = [pusher];
    const pending: Array<Promise<unknown>> = [];
    if (headerFile) {
      const head = make("mod-header mod-ui"), title = make("inline-title", head);
      title.contentEditable = titleSource === null && whole ? "true" : "false"; title.spellcheck = true; title.tabIndex = -1;
      title.setAttribute("autocapitalize", "on"); title.setAttribute("enterkeyhint", "done");
      title.textContent = headerFile.basename;
      if (titleSource !== null) {
        const staging = doc.createElement("div");
        pending.push(MarkdownRenderer.render(app, titleSource, staging, sourcePath, owner).then(() => {
          const heading = staging.querySelector("h1,h2,h3,h4,h5,h6");
          heading?.querySelector(".heading-collapse-indicator")?.remove(); heading?.removeAttribute("dir");
          if (heading) { title.classList.add("markdown-rendered"); title.replaceChildren(heading); }
          title.setAttribute("data-level", String(titleLevel));
        }).catch(() => {}));
      } else if (whole) {
        // The title of a whole note renames it, as in a note's own tab.
        const rename = () => {
          const name = (title.textContent ?? "").trim();
          if (!name || name === headerFile.basename) { title.textContent = headerFile.basename; return; }
          const parent = headerFile.parent && headerFile.parent.path && headerFile.parent.path !== "/" ? headerFile.parent.path + "/" : "";
          void app.fileManager.renameFile(headerFile, `${parent}${name}.${headerFile.extension}`).catch(() => { title.textContent = headerFile.basename; });
        };
        title.addEventListener("blur", rename);
        title.addEventListener("keydown", event => { event.stopPropagation(); if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); if (event.key === "Escape") title.textContent = headerFile.basename; title.blur(); } });
      }
      const write = (yaml: string | null) => void app.vault.process(headerFile, current => {
        const now = getFrontMatterInfo(current), block = yaml === null ? "" : `---\n${yaml}\n---\n`;
        return block + (now.exists ? current.slice(now.contentStart) : current);
      });
      const properties = new PropertiesEditor({ app, onChange: write, onOpenLink: (target, event) => { void app.workspace.openLinkText(target, headerFile.path, Keymap.isModEvent(event)); } }, doc);
      if (frontmatter !== null) properties.setSource(frontmatter.replace(/\r?\n$/, ""));
      const count = properties.containerEl.querySelectorAll(".metadata-property").length;
      if (!properties.containerEl.hasAttribute("data-property-count")) properties.containerEl.setAttribute("data-property-count", String(count));
      head.append(properties.containerEl);
      fixed.push(head);
    }
    const staging = doc.createElement("div");
    pending.push(MarkdownRenderer.render(app, source, staging, sourcePath, owner).catch(() => { staging.textContent = ""; const fallback = doc.createElement("p"); fallback.textContent = source; staging.append(fallback); }));
    void Promise.all(pending).then(() => {
      if (cancelled) return;
      const sections = ([...staging.children] as HTMLElement[]).map(child => { const section = make(child.matches("pre.frontmatter") ? "el-pre mod-frontmatter mod-ui" : `el-${child.classList.contains("callout") ? "div" : child.tagName.toLowerCase()}`); section.append(child); return section; });
      sizer.replaceChildren(...fixed, ...sections);
    });
    return () => { cancelled = true; owner.unload(); };
  }, [app, source, sourcePath, headerFile, titleSource, titleLevel, frontmatter, whole]);
  useLayoutEffect(() => {
    const frame = editorFrame.current;
    if (!frame || !editing) return;
    const doc = frame.contentDocument;
    if (!doc?.head || !doc.body) return;
    const parent = frame.ownerDocument;
    const copyAttributes = (from: HTMLElement, to: HTMLElement) => {
      for (const attribute of Array.from(from.attributes)) to.setAttribute(attribute.name, attribute.value);
      const computed = parent.defaultView?.getComputedStyle(from);
      if (computed) for (let index = 0; index < computed.length; index++) {
        const name = computed.item(index);
        if (name.startsWith("--")) to.style.setProperty(name, computed.getPropertyValue(name));
      }
    };
    doc.head.replaceChildren(); doc.body.replaceChildren();
    const base = doc.createElement("base"); base.href = parent.baseURI; doc.head.append(base);
    for (const stylesheet of Array.from(parent.head.querySelectorAll('style,link[rel="stylesheet"]'))) doc.head.append(stylesheet.cloneNode(true));
    copyAttributes(parent.documentElement, doc.documentElement);
    copyAttributes(parent.body, doc.body);
    doc.documentElement.style.cssText += ";width:100%;height:100%;overflow:hidden";
    doc.body.style.cssText += ";width:100%;height:100%;margin:0;overflow:hidden;background:transparent";
    frame.className = "embed-iframe is-controlled";
    frame.setAttribute("sandbox", "allow-forms allow-presentation allow-same-origin allow-scripts allow-modals");
    frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:transparent";
    const el = doc.createElement("div");
    el.className = cx("markdown-source-view cm-s-obsidian mod-cm6 node-insert-event", app.editorOptions.livePreview !== false && "is-live-preview");
    Object.assign(el.style, { width: "100%", height: "100%", overflow: "hidden" });
    doc.body.append(el);
    const editor = new Editor(latest.current.source);
    const mounted = mountMarkdownEditor(el, editor, { ...app.editorOptions, showLineNumber: false, extensions: app.editorExtensions }, host);
    const changed = () => latest.current.onInput(editor.getValue());
    editor.onChange(changed);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); latest.current.onEscape(); }
    };
    doc.addEventListener("keydown", onKeyDown, true);
    const at = latest.current.point, offset = at ? mounted.view.posAtCoords(at) : null;
    mounted.view.dispatch({ selection: { anchor: offset ?? mounted.view.state.doc.length } });
    frame.focus({ preventScroll: true });
    mounted.view.focus();
    return () => { doc.removeEventListener("keydown", onKeyDown, true); editor.offChange(changed); mounted.destroy(); doc.body.replaceChildren(); };
  }, [app, editing, host]);
  const viewClass = cx("markdown-preview-view markdown-rendered node-insert-event", options.showIndentGuide !== false && "show-indentation-guide", options.foldHeading !== false && "allow-fold-headings",
    options.foldIndent !== false && "allow-fold-lists", !!options.rightToLeft && "rtl", !!header && options.propertiesInDocument !== "hidden" && "show-properties");
  return <>
    <div className="markdown-embed-content node-insert-event" style={editing ? { display: "none" } : undefined}>
      <div className={viewClass}><div className="markdown-preview-sizer markdown-preview-section" style={{ paddingBottom: 0 }} ref={preview} /></div>
    </div>
    <div className="markdown-embed-content node-insert-event" style={editing ? undefined : { display: "none" }}>
      {editing && <iframe ref={editorFrame} className="embed-iframe is-controlled" title={headerFile?.basename ?? "Canvas text editor"}
        sandbox="allow-forms allow-presentation allow-same-origin allow-scripts allow-modals" />}
    </div>
    {header && <IconEl className="markdown-embed-link" icon="lucide-maximize-2" aria-label={t("editor.link-popover.tooltip-open-link")}
      onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
      onClick={event => { event.preventDefault(); void app.workspace.openLinkText(header.file.path, "", Keymap.isModEvent(event.nativeEvent)); }} />}
  </>;
}

/** Outline of another canvas, shown when a canvas is placed on a canvas. */
export function CanvasMinimap({ source }: { source: string }) {
  const parts = useMemo(() => {
    let data; try { data = parseCanvas(source); } catch { return null; }
    if (!data.nodes.length) return null;
    const boxes = new Map(data.nodes.map(node => [node.id, bboxOf(node)]));
    let bounds = unionBBox([...boxes.values()]);
    const stroke = Math.sqrt((bounds.maxX - bounds.minX) / 10);
    const rect = (node: (typeof data.nodes)[number]) => { const color = colorProps(typeof node.color === "string" ? node.color : ""); return <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} rx="20" ry="20" className={color.className || undefined} style={color.style} />; };
    const paths = data.edges.flatMap(edge => {
      const from = boxes.get(edge.fromNode), to = boxes.get(edge.toNode);
      if (!from || !to) return [];
      const fromSide = (edge.fromSide ?? "right") as Side, toSide = (edge.toSide ?? "left") as Side, color = colorProps(typeof edge.color === "string" ? edge.color : "");
      return [<path key={edge.id} d={bezier(sideAnchor(from, fromSide), fromSide, sideAnchor(to, toSide), toSide).path} className={color.className || undefined} style={{ ...color.style, strokeWidth: String(stroke) }} />];
    });
    bounds = growBBox(bounds, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 20);
    return { viewBox: `${bounds.minX} ${bounds.minY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`, children: [...data.nodes.filter(node => node.type === "group").map(rect), ...paths, ...data.nodes.filter(node => node.type !== "group").map(rect)] };
  }, [source]);
  return parts ? <svg className="canvas-minimap" viewBox={parts.viewBox}>{parts.children}</svg> : null;
}

function useFileText(app: App, file: TFile | null, enabled: boolean, paused: boolean): string | null {
  const [content, setContent] = useState<string | null>(null);
  const hold = useRef(paused); hold.current = paused;
  useEffect(() => {
    if (!file || !enabled) { setContent(null); return; }
    let cancelled = false;
    const load = () => void app.vault.cachedRead(file).then(text => { if (!cancelled) setContent(text); }).catch(() => { if (!cancelled) setContent(""); });
    load();
    const ref = app.vault.on("modify", changed => { if (changed === file && !hold.current) load(); });
    return () => { cancelled = true; app.vault.offref(ref); };
  }, [app, file, enabled]);
  return content;
}

function EmptyEmbed({ ctl, node, sourcePath }: { ctl: CanvasController; node: CanvasNode; sourcePath: string }) {
  const app = ctl.app, linktext = node.file + node.subpath, extension = node.file.includes(".") ? node.file.split(".").at(-1)!.toLowerCase() : "";
  const action = (icon: string, label: string, onClick: () => void, extra = "") => <div className={cx("text-icon-button tappable mod-pill empty-state-action", extra)} role="button" tabIndex={0} onClick={event => { event.stopPropagation(); onClick(); }}>
    <IconEl tag="span" className="text-button-icon" icon={icon} /><span className="text-button-label">{label}</span>
  </div>;
  return <div className="canvas-node-content mod-canvas-empty"><div className="canvas-empty-embed-container">
    <div className="canvas-empty-embed-label">{t("plugins.canvas.label-empty-embed", { linktext })}</div>
    <div className="empty-state-action-list">
      {(extension === "md" || extension === "") && action("lucide-square-pen", t("plugins.file-explorer.action-new-note"), () => void createNoteFromLinktext(app, node.file, sourcePath).then(file => { ctl.patch(node.id, { file: file.path }); ctl.requestSave(); }))}
      {action("lucide-repeat", t("plugins.canvas.action-swap-file"), () => new CanvasFilePicker(app, { create: true, sourcePath }, file => { ctl.patch(node.id, { file: file.path, subpath: "" }); ctl.requestSave(); }).open())}
      {action("lucide-trash-2", t("plugins.canvas.action-remove"), () => { ctl.doc.removeNode(node.id); ctl.deselect(node.id); ctl.requestSave(); }, "mod-destructive mod-warning")}
    </div>
  </div></div>;
}

/** The embedded file of a file card, by kind: note, picture, audio, video, PDF, canvas or anything the Markdown embed can show. */
function FileContent({ ctl, node, file, sourcePath, editing }: { ctl: CanvasController; node: CanvasNode; file: TFile; sourcePath: string; editing: boolean }) {
  const app = ctl.app, extension = file.extension.toLowerCase(), src = app.vault.getResourcePath(file);
  const textual = extension === "md" || extension === "canvas";
  const content = useFileText(app, file, textual, editing);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout> | null; text: string | null }>({ timer: null, text: null });
  const flush = () => { const state = pending.current; if (state.timer) clearTimeout(state.timer); state.timer = null; if (state.text !== null) { const text = state.text; state.text = null; void app.vault.modify(file, text); } };
  useEffect(() => () => flush(), [file]);
  useEffect(() => { if (!editing) flush(); }, [editing]);
  useEffect(() => { if (!IMAGE_EXTENSIONS.includes(extension) && !VIDEO_EXTENSIONS.includes(extension)) ctl.fitAspect(node.id, 0); }, [extension, node.id]);
  if (extension === "md") {
    const whole = !node.subpath;
    let body: string | null = null, header: EmbedHeader | undefined;
    if (content !== null) {
      const text = content.replace(/\r\n?/g, "\n");
      if (whole) { const info = getFrontMatterInfo(text); body = text; // the renderer takes the frontmatter out itself (and keeps it as a hidden block)
        header = { file, title: null, frontmatter: info.exists ? info.frontmatter : null, whole: true }; }
      else {
        const excerpt = excerptOf(app, file, text, node.subpath);
        body = excerpt.missing ? `##### ${t("interface.label-unable-to-find-section", { subpath: node.subpath.slice(1).replace(/(\[|\])/g, "\\$1"), file: file.basename })}` : excerpt.body;
        header = { file, title: excerpt.title, frontmatter: null, whole: false };
      }
    }
    return <div className="canvas-node-content markdown-embed is-loaded">{body !== null && <MarkdownBody app={app} source={editing && whole ? content ?? "" : body} sourcePath={file.path} editing={editing && whole} point={ctl.editPoint} header={header}
      onInput={text => { pending.current.text = text; if (pending.current.timer) clearTimeout(pending.current.timer); pending.current.timer = setTimeout(flush, 1000); }} onEscape={() => ctl.pauseEditing()} />}</div>;
  }
  if (IMAGE_EXTENSIONS.includes(extension)) return <div className="canvas-node-content media-embed image-embed is-loaded"><img alt={file.name} draggable={false} src={src} onLoad={event => ctl.fitAspect(node.id, event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} /></div>;
  if (VIDEO_EXTENSIONS.includes(extension)) return <div className="canvas-node-content media-embed video-embed is-loaded"><video controls preload="metadata" src={src + (node.subpath.startsWith("#t=") ? node.subpath : "")} onLoadedMetadata={event => ctl.fitAspect(node.id, event.currentTarget.videoWidth / event.currentTarget.videoHeight)} /></div>;
  if (AUDIO_EXTENSIONS.includes(extension)) return <div className="canvas-node-content media-embed audio-embed is-loaded"><audio controls preload="metadata" src={src} ref={el => { if (el && el.clientHeight && Math.abs(node.height - el.clientHeight) > 1) { ctl.patch(node.id, { height: el.clientHeight || 42 }); ctl.overrideHistory(); } }} /></div>;
  if (extension === "pdf") return <div className="canvas-node-content pdf-embed is-loaded"><iframe className="pdf-container" src={src + node.subpath} style={{ width: "100%", height: "100%", border: 0 }} /></div>;
  if (extension === "canvas") return <div className="canvas-node-content canvas-embed is-loaded">{content !== null && <CanvasMinimap source={content} />}</div>;
  return <div className={cx("canvas-node-content is-loaded", extension === "base" ? "bases-embed" : "file-embed")}><EmbedBody app={app} linktext={file.path + node.subpath} sourcePath={sourcePath} /></div>;
}
/** Files without a renderer of their own go through the Markdown embed pipeline (bases, plugin-provided embeds, the generic file card). */
function EmbedBody({ app, linktext, sourcePath }: { app: App; linktext: string; sourcePath: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const owner = new Component(); owner.load();
    void MarkdownRenderer.render(app, `![[${linktext}]]`, el, sourcePath, owner).catch(() => { el.textContent = linktext; });
    return () => owner.unload();
  }, [app, linktext, sourcePath]);
  return <div ref={ref} style={{ display: "contents" }} />;
}

function LinkContent({ ctl, node, onTitle }: { ctl: CanvasController; node: CanvasNode; onTitle(title: string): void }) {
  const ref = useRef<HTMLElement>(null), valid = /^https?:\/\//.test(node.url);
  const src = valid ? embedUrl(node.url, document.body.classList.contains("theme-dark")) : "about:blank";
  useEffect(() => {
    const frame = ref.current as (HTMLElement & { getTitle?(): string }) | null;
    if (!frame) return;
    const update = () => onTitle(frame.getTitle?.() || node.url);
    frame.addEventListener("page-title-updated", update);
    return () => frame.removeEventListener("page-title-updated", update);
  }, [node.url]);
  // React does not know the Electron tag's attributes; they are passed through as written.
  return <div className="canvas-node-content"><webview ref={ref as never} className="canvas-link" src={src} partition={webviewPartition(ctl.app)} {...{ allowpopups: "true" } as object} style={{ width: "100%", height: "100%" }} /></div>;
}

function GroupLabel({ ctl, node, editing }: { ctl: CanvasController; node: CanvasNode; editing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const tone = useMemo(() => {
    if (!node.color) return "";
    const value = isPresetColor(node.color) ? getComputedStyle(document.body).getPropertyValue(`--canvas-color-${node.color}`).trim() : node.color;
    const rgb = parseHexColor(value) ?? (match => match ? { r: +match[1], g: +match[2], b: +match[3] } : null)(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value));
    return rgb ? isLightColor(rgb) ? "mod-foreground-dark" : "mod-foreground-light" : "";
  }, [node.color]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!editing) { el.textContent = node.label; return; }
    el.focus();
    const range = el.ownerDocument.createRange(); range.selectNodeContents(el);
    const selection = el.ownerDocument.defaultView?.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }, [editing, node.label]);
  const commit = () => {
    const el = ref.current;
    if (!el || ctl.labelEditing !== node.id) return;
    const label = el.textContent ?? "";
    ctl.labelEditing = null;
    if (label !== node.label) { ctl.patch(node.id, { label }); ctl.requestSave(); } else ctl.host.render();
  };
  return <div className={cx("canvas-group-label", tone)} ref={ref} spellCheck={false} contentEditable={editing} suppressContentEditableWarning style={!node.label && !editing ? { display: "none" } : undefined}
    onPointerDown={event => { if (!editing) ctl.onNodePointerdown(event.nativeEvent, node.id, event.currentTarget.parentElement!); }}
    onDoubleClick={event => { event.stopPropagation(); ctl.startEditing(node.id); }}
    onKeyPress={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }}
    onKeyDown={event => { if (editing) event.stopPropagation(); }} onBlur={commit} />;
}

export interface CanvasCardProps {
  ctl: CanvasController; node: CanvasNode; sourcePath: string;
  focused: boolean; selected: boolean; editing: boolean; labelEditing: boolean; lifted: boolean;
  /** The card is still the one being edited, but shows its preview (after Escape in its editor). */
  previewing?: boolean;
  /** Contents are drawn (the zoom is above the breakpoint). */
  mounted: boolean; zIndex: number; labels: "always" | "hover" | "never"; readonly: boolean;
  /** Bumped when the vault's files change, so missing files are looked up again. */
  revision: number;
}

/** One card: its frame, its contents by type, and its label. */
export const CanvasCard = memo(function CanvasCard({ ctl, node, sourcePath, focused, selected, editing, previewing, labelEditing, lifted, mounted, zIndex, labels, readonly }: CanvasCardProps) {
  const typing = editing && !previewing;
  const app = ctl.app, color = colorProps(node.color), group = node.type === "group";
  const file = node.type === "file" ? ctl.fileOf(node) : null;
  const [pageTitle, setPageTitle] = useState("");
  const background = group && node.background ? app.vault.getAbstractFileByPath(node.background) : null;
  useEffect(() => {
    if (!group) return;
    if (!(background instanceof TFile) || node.backgroundStyle !== "ratio") { ctl.fitAspect(node.id, 0); return; }
    const image = new Image(); image.onload = () => ctl.fitAspect(node.id, image.naturalWidth / image.naturalHeight); image.src = app.vault.getResourcePath(background);
  }, [group, background, node.backgroundStyle, node.id]);
  const extension = file?.extension.toLowerCase() ?? "";
  // Pictures and canvas outlines stay drawn when zoomed out; pages stay loaded.
  const keep = node.type === "link" || (node.type === "file" && (IMAGE_EXTENSIONS.includes(extension) || extension === "canvas"));
  const shown = mounted || editing || keep;
  let label: ReactNode = null, placeholder: ReactNode = null, content: ReactNode = null;
  if (node.type === "text") {
    placeholder = <IconEl className="canvas-icon-placeholder" icon="lucide-align-left" />;
    content = <div className="canvas-node-content markdown-embed"><MarkdownBody app={app} source={node.text} sourcePath={sourcePath} editing={typing} point={ctl.editPoint}
      onInput={text => { if (ctl.node(node.id)?.text !== text) { ctl.patch(node.id, { text }); ctl.requestSave(); } }} onEscape={() => ctl.pauseEditing()} /></div>;
  } else if (node.type === "file") {
    const name = file ? (file.extension === "md" ? file.basename : file.name) + (node.subpath && file.extension === "md" ? " › " + node.subpath.substring(1) : "") : node.file;
    label = file ? name : <><IconEl tag="span" icon="lucide-alert-triangle" /><span>{node.file}</span></>;
    placeholder = name;
    content = file ? <FileContent ctl={ctl} node={node} file={file} sourcePath={sourcePath} editing={typing} /> : <EmptyEmbed ctl={ctl} node={node} sourcePath={sourcePath} />;
  } else if (node.type === "link") {
    label = pageTitle || node.url;
    content = <LinkContent ctl={ctl} node={node} onTitle={setPageTitle} />;
  }
  const open = (target: ReturnType<typeof Keymap.isModEvent>) => {
    if (node.type === "file") void app.workspace.openLinkText(node.file + node.subpath, "", target);
    else window.open(node.url, "_blank");
  };
  const style = { transform: `translate(${node.x}px, ${node.y}px)`, width: node.width, height: node.height, zIndex, "--canvas-node-width": `${node.width}px`, "--canvas-node-height": `${node.height}px`, ...color.style } as CSSProperties;
  return <div className={cx("canvas-node", group && "canvas-node-group", focused && "is-focused", selected && "is-selected", editing && "is-editing", lifted && "is-dragging", color.className)} data-id={node.id} style={style}
    onClick={event => ctl.onNodeClick(event.nativeEvent, node.id)} onContextMenu={event => ctl.onNodeContextMenu(event.nativeEvent, node.id)}>
    <div className="canvas-node-container" onPointerDown={event => ctl.onNodePointerdown(event.nativeEvent, node.id, event.currentTarget.parentElement!)}
      onDoubleClick={event => {
        if (event.defaultPrevented || readonly || typing || (event.target as Element).closest("button, input, .collapse-indicator, .interactive-child, .empty-state-action")) return;
        if (node.type === "text" || (node.type === "file" && extension === "md" && !node.subpath)) ctl.startEditing(node.id, { x: event.clientX, y: event.clientY });
      }}>
      {group ? <div className="canvas-node-content" style={background instanceof TFile ? {
        backgroundImage: `url("${CSS.escape(app.vault.getResourcePath(background))}")`, backgroundRepeat: node.backgroundStyle === "repeat" ? "repeat" : "no-repeat",
        backgroundPosition: node.backgroundStyle === "repeat" ? "top left" : "center center", backgroundSize: node.backgroundStyle === "repeat" ? "auto" : "cover",
      } : undefined} />
        : shown ? <>{content}{!(node.type === "file" && !file) && <div className="canvas-node-content-blocker" />}</> : <div className="canvas-node-placeholder">{placeholder}</div>}
    </div>
    {label !== null && labels !== "never" && <div className={cx("canvas-node-label", labels === "hover" && "mod-hover-label")}
      onPointerDown={event => ctl.onNodePointerdown(event.nativeEvent, node.id, event.currentTarget.parentElement!)}
      onClick={event => { const target = Keymap.isModEvent(event.nativeEvent); if (target) open(target); }} onDoubleClick={event => { event.stopPropagation(); open(false); }}>{label}</div>}
    {group && <GroupLabel ctl={ctl} node={node} editing={labelEditing} />}
  </div>;
});
