/*
 * Mermaid diagrams, rendered the way the reference does: `mermaid.render` (Mermaid 11.13.0, the
 * reference's version and configuration) into `div.mermaid`. The library is only evaluated when the
 * first diagram is rendered. A vault has to allow diagrams first (`mermaid-vault-trust`); until then
 * the reference's guard is shown in place of the diagram.
 */

import { t } from "../i18n";
import { highlightCodeBlocks } from "./prism";

const TRUST_KEY = "mermaid-vault-trust";

export interface MermaidHost {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
  workspace: { trigger(name: string, ...data: unknown[]): void; openLinkText?(linktext: string, sourcePath: string, newLeaf?: unknown): unknown };
}

export interface MermaidApi {
  initialize(config?: unknown): void;
  render(id: string, text: string, container?: Element): Promise<{ svg: string }>;
  run?(options?: unknown): Promise<void>;
}

/** The reference's `mermaid.initialize` call. */
const CONFIG = {
  startOnLoad: false, securityLevel: "strict", themeVariables: { fontFamily: "var(--font-mermaid)" },
  flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false },
  gantt: { useMaxWidth: true, axisFormatter: [["%Y-%m-%d", (date: Date) => date.getDay() === 1]] },
  journey: { useMaxWidth: true }, class: { useMaxWidth: true }, git: { useMaxWidth: false }, state: { useMaxWidth: true }, er: { useMaxWidth: false }, pie: { useMaxWidth: true },
};

let loading: Promise<MermaidApi> | null = null;

async function load(): Promise<MermaidApi> {
  if (typeof document === "undefined") {
    // Mermaid needs a DOM. Outside a browser (the Node-side checks) diagrams come from pele's string renderer.
    const { render } = await import("pele");
    return { initialize() {}, render: async (_id, text) => ({ svg: render(text).svg }), run: async () => {} };
  }
  const mermaid = (await import("mermaid/dist/mermaid.esm.min.mjs")).default as unknown as MermaidApi;
  mermaid.initialize(CONFIG);
  (globalThis as { mermaid?: MermaidApi }).mermaid = mermaid;
  return mermaid;
}

/** Loads Mermaid; resolves to the `mermaid` object, which is also published as a global. */
export function loadMermaid(): Promise<MermaidApi> {
  loading ??= load().catch(error => { loading = null; throw error; });
  return loading;
}

function trustStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key && key.startsWith("obsen:vault:") && key.endsWith(TRUST_KEY)) keys.push(key);
    }
  } catch { /* storage can be unavailable */ }
  return keys;
}

export function mermaidTrusted(host: MermaidHost | null | undefined): boolean {
  if (host) return host.loadLocalStorage(TRUST_KEY) === true;
  return trustStorageKeys().some(key => { try { return JSON.parse(localStorage.getItem(key) || "null") === true; } catch { return false; } });
}

export function allowMermaid(host: MermaidHost | null | undefined): void {
  if (host) {
    host.saveLocalStorage(TRUST_KEY, true);
    host.workspace.trigger("post-processor-change");
    return;
  }
  try { localStorage.setItem(trustStorageKeys()[0] ?? `obsen:vault:${TRUST_KEY}`, "true"); } catch { /* the button still swaps this one diagram */ }
}

// Source of a rendered or pending diagram, without the fence's trailing line break.
const sources = new WeakMap<Element, string>();
function sourceOf(code: Element): string {
  const known = sources.get(code);
  if (known !== undefined) return known;
  let text = code.textContent ?? "";
  if (text.endsWith("\n")) text = text.slice(0, -1);
  sources.set(code, text);
  return text;
}

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
const shown = (el: HTMLElement) => el.isConnected && el.offsetParent !== null;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface RenderContext { host?: MermaidHost | null; sourcePath?: string }

/** Replaces the `pre` around `code` with the diagram; a diagram that does not parse leaves its message in the code element. */
async function renderDiagram(mermaid: MermaidApi, container: HTMLElement, code: HTMLElement, context: RenderContext): Promise<void> {
  const source = sourceOf(code), pre = code.parentElement, doc = code.ownerDocument, win = doc.defaultView ?? window;
  if (!pre) return;
  const width = pre.clientWidth || container.clientWidth || win.innerWidth;
  const id = "m" + hex(8);
  // Mermaid measures text in this element, so it has to be laid out, at the width the diagram will get.
  const stage = document.body.appendChild(document.createElement("div"));
  stage.className = "mermaid";
  try {
    stage.style.width = width + "px"; stage.style.visibility = "hidden"; stage.style.position = "absolute";
    const { svg } = await mermaid.render(id, source, stage);
    stage.remove();
    const diagram = doc.createElement("div");
    diagram.className = "mermaid";
    diagram.innerHTML = svg;
    pre.replaceWith(diagram);
    sources.set(diagram, source);
    // Nodes given the class `internal-link` link to the note named by their label.
    for (const label of diagram.querySelectorAll<HTMLElement>('[*|class*="internal-link"] > g.label foreignObject > div')) {
      const text = label.textContent;
      if (!text) continue;
      const link = doc.createElement("a");
      link.className = "internal-link"; link.setAttribute("href", text); link.dataset.href = text; link.textContent = text;
      link.addEventListener("click", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        void context.host?.workspace.openLinkText?.(text, context.sourcePath ?? "", event.ctrlKey || event.metaKey);
      });
      label.replaceChildren(link);
    }
    for (const anchor of diagram.querySelectorAll("a")) {
      const href = (anchor as unknown as SVGAElement).href;
      if (href && typeof href === "object" && !href.baseVal) href.baseVal = anchor.getAttribute("href") ?? "";
    }
    // Marker ids are the same in every diagram of a kind; make them unique so that diagrams do not share arrowheads.
    const style = diagram.querySelector("style");
    if (style) {
      const original = style.innerHTML;
      let css = original;
      for (const marker of diagram.querySelectorAll("marker")) {
        const markerId = marker.id;
        if (!markerId) continue;
        const unique = `${id}-${markerId}`;
        marker.id = unique;
        for (const attribute of ["marker-start", "marker-end"]) {
          for (const user of diagram.querySelectorAll(`[${attribute}="url(#${markerId})"]`)) user.setAttribute(attribute, `url(#${unique})`);
        }
        css = css.replace(new RegExp(`#${escapeRegExp(markerId)}(?!\\w|-)`, "g"), "#" + unique);
      }
      if (css !== original) style.innerHTML = css;
    }
  } catch (error) {
    doc.getElementById("d" + id)?.remove();
    stage.remove();
    console.error(error);
    const failure = error as { str?: string; message?: string };
    code.replaceChildren(t("obsen.mermaid.parse-error", { message: failure.str || failure.message || String(error) }));
  }
}

/** Renders `code.language-mermaid` elements, each as soon as it is laid out. */
export function renderDiagrams(container: HTMLElement, codes: HTMLElement[], context: RenderContext = {}): Promise<void> {
  return loadMermaid().then(async mermaid => {
    const pending: Promise<void>[] = [];
    for (const code of codes) {
      if (shown(code) || shown(container)) { pending.push(renderDiagram(mermaid, container, code, context)); continue; }
      // Not in the page yet (a widget being built, a hidden tab): wait until it has a box.
      const Observer = (code.ownerDocument.defaultView ?? window).ResizeObserver;
      const observer = new Observer(() => {
        if (!shown(code)) return;
        observer.disconnect();
        void renderDiagram(mermaid, container, code, context);
      });
      // An inline element never reports a size; its block parent does.
      observer.observe(code.parentElement ?? code);
    }
    if (pending.length) await Promise.all(pending);
  });
}

/** Fills `target` with the diagram when diagrams are allowed, with the reference's guard otherwise. */
export function mountMermaid(target: HTMLElement, source: string, allowed: boolean, onAllow: () => void, context: RenderContext = {}): void {
  const doc = target.ownerDocument;
  const block = (parent: HTMLElement) => {
    const pre = parent.appendChild(doc.createElement("pre")), code = pre.appendChild(doc.createElement("code"));
    code.className = "language-mermaid"; code.textContent = source;
    return code;
  };
  if (allowed) {
    target.classList.add("is-loading");
    void renderDiagrams(target, [block(target)], context).catch(error => console.error(error)).finally(() => target.classList.remove("is-loading"));
    return;
  }
  const div = (parent: HTMLElement, cls: string, text?: string) => {
    const el = parent.appendChild(doc.createElement("div"));
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const wrapper = div(target, "mermaid-wrapper is-guarded"), header = div(wrapper, "mermaid-guard-header");
  const text = div(header, "mermaid-guard-text");
  div(text, "mermaid-guard-title", t("plugins.mermaid.label-guard-title"));
  div(text, "mermaid-guard-description", t("plugins.mermaid.label-guard-desc"));
  const allow = div(header, "mermaid-guard-actions").appendChild(doc.createElement("button"));
  allow.textContent = t("dialogue.button-allow");
  allow.addEventListener("mousedown", event => event.stopPropagation());
  allow.addEventListener("click", () => onAllow());
  block(div(wrapper, "mermaid-guard-source"));
}

/** Replaces `mermaid` fences of a rendered document. Trusted vaults get diagrams; others get the guard. */
export function renderMermaidBlocks(root: HTMLElement, host: MermaidHost | null | undefined, sourcePath = ""): void {
  const codes = [...root.querySelectorAll<HTMLElement>("code.language-mermaid")].filter(code => !code.closest(".mermaid-guard-source") && code.parentElement?.tagName === "PRE");
  if (!codes.length) return;
  const context = { host, sourcePath };
  if (mermaidTrusted(host)) { void renderDiagrams(root, codes, context).catch(error => console.error(error)); return; }
  for (const code of codes) {
    const source = sourceOf(code), holder = root.ownerDocument.createElement("div");
    code.parentElement!.replaceWith(holder);
    mountMermaid(holder, source, false, () => {
      allowMermaid(host);
      // Without a vault to ask for a re-render, swap this one diagram.
      if (!host) { holder.replaceChildren(); mountMermaid(holder, source, true, () => {}, context); }
    }, context);
  }
}

/** Mermaid rendering and Prism highlighting for a finished Markdown tree, after the other post processors. */
export function finishReadingView(root: HTMLElement, host: MermaidHost | null | undefined, sourcePath = ""): void {
  renderMermaidBlocks(root, host, sourcePath);
  highlightCodeBlocks(root);
}
