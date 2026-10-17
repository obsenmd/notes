/*
 * TeX rendering with MathJax (CHTML output). The library is only evaluated the first
 * time a formula is rendered; its stylesheet is kept in the document head and
 * refreshed after each batch of formulas.
 */

type Typeset = (source: string, display: boolean) => HTMLElement;

// The reference's extension list on top of MathJax's default TeX packages.
const PACKAGES = ["base", "ams", "newcommand", "noundefined", "configmacros", "action", "amscd", "bbox", "boldsymbol", "braket", "bussproofs", "cancel", "cases", "centernot", "color", "colortbl", "empheq", "enclose", "extpfeil", "gensymb", "html", "mathtools", "mhchem", "noerrors", "tagformat", "textcomp", "unicode", "upgreek", "verb"];

let loading: Promise<Typeset> | null = null;
let typeset: Typeset | null = null;
let styleSheet: (() => HTMLElement) | null = null;
let installed: HTMLElement | null = null;
let pending: Promise<void> | null = null, settle: (() => void) | null = null, timer = 0;

async function load(): Promise<Typeset> {
  const root = new URL("lib/mathjax/", document.baseURI).href;
  const host = window as unknown as { MathJax: { startup: { promise: Promise<void>; document: { options: Record<string, unknown> } }; tex2chtml(source: string, options: { display: boolean }): HTMLElement; chtmlStylesheet(): HTMLElement } };
  Object.assign(window, { MathJax: {
    loader: { paths: { mathjax: root.replace(/\/$/, ""), "mathjax-tex": root + "tex-font", "mathjax-mhchem-extension": root + "mhchem-font-extension" }, load: [...PACKAGES.filter(name => name !== "base").map(name => "[tex]/" + name), "ui/safe"] },
    output: { font: "mathjax-tex", fontExtensions: ["mathjax-mhchem"] },
    tex: { packages: { "[+]": PACKAGES.filter(name => name !== "base") }, macros: { RequirePackage: ["\\require{#1}", 1], usepackage: ["\\require{#1}", 1] }, inlineMath: [], displayMath: [], processEscapes: false, processEnvironments: false, processRefs: false },
    startup: { typeset: false },
    options: { enableMenu: false, enableEnrichment: false, enableExplorer: false, safeOptions: { safeProtocols: { http: true, https: true, file: true, javascript: false, data: false } } },
  } });
  localStorage.removeItem("MathJax-Menu-Settings");
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = root + "tex-chtml-nofont.js";
    script.onload = () => resolve(); script.onerror = () => reject(new Error("Unable to load bundled MathJax"));
    document.head.appendChild(script);
  });
  await host.MathJax.startup.promise;
  Object.assign(host.MathJax.startup.document.options, { enableMenu: false, enableEnrichment: false, enableExplorer: false });
  styleSheet = () => host.MathJax.chtmlStylesheet();
  return typeset = (source, display) => host.MathJax.tex2chtml(source, { display });
}

/** Loads MathJax; resolves once `renderMath` can be called. */
export function loadMathJax(): Promise<void> {
  loading ??= load();
  return loading.then(() => {});
}

/** Renders TeX to a `mjx-container` element. `loadMathJax` must have resolved. */
export function renderMath(source: string, display: boolean): HTMLElement {
  if (!typeset) throw new Error("MathJax is not loaded");
  return typeset(source, display);
}

/** Flushes the styles needed by the formulas rendered since the last call. */
export function finishRenderMath(): Promise<void> {
  pending ??= new Promise(resolve => { settle = resolve; });
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const sheet = styleSheet?.() ?? null;
    if (sheet && (sheet !== installed || !sheet.isConnected)) { installed?.remove(); installed = sheet; document.head.appendChild(sheet); }
    if (installed) installed.dataset.change = installed.dataset.change === "1" ? "2" : "1";
    settle?.(); pending = settle = null;
  }, 100);
  return pending;
}

function fill(el: HTMLElement, source: string, display: boolean, done?: () => void): void {
  el.replaceChildren();
  try { el.append(renderMath(source, display)); } catch { el.append(source); }
  el.classList.add("is-loaded");
  done?.();
  void finishRenderMath();
}

/** Replaces an element's content with the rendered formula, as soon as MathJax is available. */
export function renderMathInto(el: HTMLElement, source: string, display: boolean, done?: () => void): void {
  if (typeset) fill(el, source, display, done);
  else void loadMathJax().then(() => fill(el, source, display, done), () => { done?.(); });
}
