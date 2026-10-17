/*
 * pdf.js, loaded on first use. The library, its viewer components and its worker are ES modules
 * copied next to the page by the build (lib/pdfjs, see scripts/build-runtime.mjs) and loaded by URL,
 * together with the character maps, standard fonts, image decoders and colour profiles they fetch.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The pdf.js library object (`pdfjsLib`). */
export type PdfJsLibrary = any;
/** The pdf.js viewer components (`PDFViewer`, `EventBus`, `PDFLinkService`, `PDFFindController`, …). */
export type PdfJsViewer = any;

let library: Promise<PdfJsLibrary> | null = null;
let viewer: Promise<PdfJsViewer> | null = null;

/** Directory the pdf.js files are served from, with a trailing slash. */
export function pdfJsBaseUrl(): string { return new URL("lib/pdfjs/", document.baseURI).href; }

/** Document parameters shared by every `getDocument` call in the app. */
export function pdfJsDocumentOptions(): Record<string, unknown> {
  const base = pdfJsBaseUrl();
  return { cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/`, isEvalSupported: false, enableXfa: true, verbosity: 0 };
}

// A URL only known at run time keeps the module out of the renderer bundle.
const importModule = (url: string): Promise<any> => import(/* @vite-ignore */ url);

async function loadLibrary(): Promise<PdfJsLibrary> {
  const base = pdfJsBaseUrl();
  const module = await importModule(`${base}pdf.min.mjs`);
  const lib = (globalThis as { pdfjsLib?: PdfJsLibrary }).pdfjsLib ?? module;
  lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
  return lib;
}

/** Plugin API: resolves to the pdf.js library object once it is loaded. */
export function loadPdfJs(): Promise<PdfJsLibrary> {
  library ??= loadLibrary().catch(error => { library = null; throw error; });
  return library;
}

/** Loads the library and then the viewer components, which read the library from `globalThis.pdfjsLib`. */
export function loadPdfJsViewer(): Promise<PdfJsViewer> {
  viewer ??= loadPdfJs().then(() => importModule(`${pdfJsBaseUrl()}pdf.viewer.min.mjs`)).catch(error => { viewer = null; throw error; });
  return viewer;
}
