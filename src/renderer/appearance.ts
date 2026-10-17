import { webFrame, getRemote, process } from "../../platforms/platform";
import { getRibbonLayout, type VaultConfig } from "./config";
import { FRAME_CLASSES } from "./WorkspaceShell";
import type { Workspace, WorkspaceWindow } from "../compat/workspace";
import { watchCustomCss } from "./custom-css";

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const r = (value >> 16 & 255) / 255, g = (value >> 8 & 255) / 255, b = (value & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / (l > 0.5 ? 2 - max - min : max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) };
}

const fontList = (value: string) => value.split(",").map(font => font.trim()).filter(Boolean)
  .map(font => /^[a-z-]+$/i.test(font) ? font : `"${font.replace(/^["']|["']$/g, "")}"`).join(", ");

const PLATFORM_CLASS = process.platform === "darwin" ? "mod-macos" : process.platform === "win32" ? "mod-windows" : "mod-linux";

/** Applies preferences to a document the way the reference does: body classes plus override variables. */
export function applyAppearance(config: VaultConfig, doc: Document = window.document): void {
  const body = doc.body, win = doc.defaultView ?? window;
  const theme = config.get("theme");
  const dark = theme === "obsidian" || (theme === "system" && win.matchMedia("(prefers-color-scheme: dark)").matches);
  body.classList.toggle("theme-dark", dark);
  body.classList.toggle("theme-light", !dark);
  body.classList.add(PLATFORM_CLASS, ...FRAME_CLASSES, "obsidian-app", "styled-scrollbars");
  body.classList.toggle("show-inline-title", config.get("showInlineTitle"));
  body.classList.toggle("is-floating-nav", config.get("floatingNavigation"));
  body.classList.toggle("auto-full-screen", config.get("autoFullScreen"));
  body.classList.toggle("show-ribbon", config.get("showRibbon"));
  body.classList.toggle("show-view-header", config.get("showViewHeader"));
  body.classList.toggle("is-translucent", config.get("translucency"));
  body.classList.toggle("is-focused", doc.hasFocus());

  const style = body.style;
  const setOrRemove = (property: string, value: string | null) => { if (value) style.setProperty(property, value); else style.removeProperty(property); };
  // Zoom is the frame's zoom level, as in the reference; the variable lets the title bar compensate.
  const zoom = Number(config.get("zoomLevel")) || 0;
  if (doc === window.document && webFrame.getZoomLevel() !== zoom) webFrame.setZoomLevel(zoom);
  style.setProperty("--zoom-factor", String(Math.pow(1.2, zoom)));
  const accent = hexToHsl(config.get("accentColor"));
  setOrRemove("--accent-h", accent ? String(accent.h) : null);
  setOrRemove("--accent-s", accent ? `${accent.s}%` : null);
  setOrRemove("--accent-l", accent ? `${accent.l}%` : null);
  const textFont = fontList(config.get("textFontFamily"));
  setOrRemove("--font-interface-override", fontList(config.get("interfaceFontFamily")) || null);
  setOrRemove("--font-text-override", textFont || null);
  setOrRemove("--font-print-override", textFont || null);
  setOrRemove("--font-monospace-override", fontList(config.get("monospaceFontFamily")) || null);
  const fontSize = config.get("baseFontSize");
  style.setProperty("--font-text-size", `${fontSize}px`);
  style.setProperty("--indent-size", String(config.get("tabSize")));
  doc.documentElement.style.fontSize = `calc(${fontSize}px * var(--preferred-text-scale, 1))`;
}

/** The reference's rule for the spellchecker: the chosen languages that are available, or the system locale. */
export function getSpellcheckLanguages(): string[] | null {
  try { const value = JSON.parse(localStorage.getItem("spellcheck-languages") ?? "null") as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null; }
  catch { return null; }
}
export function setSpellcheckLanguages(languages: string[] | null): void {
  if (languages?.length) localStorage.setItem("spellcheck-languages", JSON.stringify(languages)); else localStorage.removeItem("spellcheck-languages");
  applySpellcheckLanguages(languages);
}
export function applySpellcheckLanguages(languages: string[] | null): void {
  if (process.platform === "darwin") return;
  try {
    const remote = getRemote() as { app: { getLocale(): string }; getCurrentWebContents(): { session: { availableSpellCheckerLanguages: string[]; setSpellCheckerLanguages(languages: string[]): void } } };
    const session = remote.getCurrentWebContents().session, wanted = languages?.length ? languages : [remote.app.getLocale()];
    session.setSpellCheckerLanguages(wanted.filter(language => session.availableSpellCheckerLanguages.includes(language)));
  } catch (error) { console.error(error); }
}

/** Keeps a document's appearance in sync with preferences, the OS color scheme and window focus. */
export function watchAppearance(config: VaultConfig, doc: Document = window.document): () => void {
  const win = doc.defaultView ?? window;
  const apply = () => applyAppearance(config, doc);
  const media = win.matchMedia("(prefers-color-scheme: dark)");
  const stop = config.onChange(apply);
  media.addEventListener("change", apply);
  win.addEventListener("focus", apply); win.addEventListener("blur", apply);
  apply();
  const stopExtras: Array<() => void> = [];
  if (doc === window.document) {
    if (getSpellcheckLanguages()) applySpellcheckLanguages(getSpellcheckLanguages());
    stopExtras.push(getRibbonLayout(config.vaultPath).watch());
  }
  // "Quick font size adjustment": Ctrl + wheel over a note changes the base font size.
  let lastPlainWheel = 0;
  const onWheel = (event: WheelEvent) => {
    const target = event.target as Element | null;
    if (!config.get("baseFontSizeAction") || typeof target?.closest !== "function" || !target.closest('.workspace-leaf-content[data-type="markdown"]')) return;
    const now = Date.now();
    if (!event.ctrlKey || lastPlainWheel > now - 500) { lastPlainWheel = now; return; }
    if (event.deltaY === 0 || (process.platform === "darwin" && Number.isInteger(event.deltaY))) return;
    config.set("baseFontSize", Math.max(10, Math.min(30, config.get("baseFontSize") + (event.deltaY < 0 ? 1 : -1))));
  };
  doc.addEventListener("wheel", onWheel, { passive: true });
  stopExtras.push(() => doc.removeEventListener("wheel", onWheel));
  return () => { for (const stopExtra of stopExtras) stopExtra(); stop(); media.removeEventListener("change", apply); win.removeEventListener("focus", apply); win.removeEventListener("blur", apply); };
}

/** Keep existing and newly restored popout documents on the vault's live appearance preferences. */
export function watchPopoutAppearance(config: VaultConfig, workspace: Workspace): () => void {
  const stops = new Map<Window, () => void>();
  const open = (_container: WorkspaceWindow, win: Window) => {
    if (stops.has(win) || win.closed) return;
    win.document.body.classList.add("is-popout-window");
    const stopAppearance = watchAppearance(config, win.document), stopCss = watchCustomCss(config, win.document);
    stops.set(win, () => { stopAppearance(); stopCss(); });
  };
  const close = (_container: WorkspaceWindow, win: Window) => { stops.get(win)?.(); stops.delete(win); };
  for (const container of workspace.floatingSplit) open(container, container.win);
  const refs = [workspace.on("window-open", (container, win) => open(container as WorkspaceWindow, win as Window)), workspace.on("window-close", (container, win) => close(container as WorkspaceWindow, win as Window))];
  return () => { refs.forEach(ref => workspace.offref(ref)); for (const stop of stops.values()) stop(); stops.clear(); };
}
