import { loader } from "@monaco-editor/react";
import { Editor, type Monaco, type OnMount, type Theme } from "@monaco-editor/react";
import { createRoot, type Root } from "react-dom/client";
import { TextFileView } from "../../compat/file-views";
import type { TFile } from "../../compat/vault";
import type { WorkspaceLeaf } from "../../compat/workspace";
import { t } from "../../i18n";
import type { CorePluginContext, CorePluginModule } from "./types";

const languageByExtension: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", csv: "plaintext", go: "go", h: "cpp", hpp: "cpp",
  html: "html", java: "java", js: "javascript", json: "json", jsx: "javascript", less: "less", lua: "lua", m: "objective-c",
  md: "markdown", mjs: "javascript", py: "python", rs: "rust", scss: "scss", sh: "shell", sql: "sql", svg: "xml", ts: "typescript",
  tsx: "typescript", txt: "plaintext", xml: "xml", yaml: "yaml", yml: "yaml",
};

function languageFor(extension: string): string { return languageByExtension[extension.toLowerCase()] ?? "plaintext"; }

function defineObsenTheme(monaco: Monaco): void {
  const style = getComputedStyle(document.body);
  const token = (name: string, fallback: string): string => {
    const raw = style.getPropertyValue(name).trim() || fallback;
    if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(raw)) return raw;
    const sample = document.createElement("span"); sample.style.color = raw; document.body.append(sample);
    if (!sample.style.color) { sample.remove(); return fallback; }
    const resolved = getComputedStyle(sample).color; sample.remove();
    const parts = resolved.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i);
    if (!parts) return fallback;
    const hex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
    const alpha = parts[4] ? Number(parts[4].replace("%", "")) / (parts[4].endsWith("%") ? 100 : 1) : 1;
    return `#${hex(Number(parts[1]))}${hex(Number(parts[2]))}${hex(Number(parts[3]))}${alpha < 1 ? hex(alpha * 255) : ""}`;
  };
  const light = document.body.classList.contains("theme-light");
  monaco.editor.defineTheme("obsen-editor", {
    base: light ? "vs" : "vs-dark", inherit: true, rules: [], colors: {
      "editor.background": token("--background-primary", light ? "#ffffff" : "#1e1e1e"),
      "editor.foreground": token("--text-normal", light ? "#222222" : "#dddddd"),
      "editorLineNumber.foreground": token("--text-faint", light ? "#999999" : "#777777"),
      "editorCursor.foreground": token("--text-accent", light ? "#7c5cff" : "#a88bfa"),
      "editor.selectionBackground": token("--text-selection", "#264f78"),
      "editor.inactiveSelectionBackground": token("--background-modifier-hover", "#303030"),
    },
  });
}

function CodeEditor({ file, value, fontFamily, onChange, onMount }: { file: TFile; value: string; fontFamily: string; onChange(value: string): void; onMount: OnMount }) {
  return <Editor
    height="100%"
    language={languageFor(file.extension)}
    theme={"obsen-editor" as Theme}
    value={value}
    loading={<div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--text-muted)", background: "var(--background-primary)" }}>{t("plugins.monaco-editor.loading")}</div>}
    options={{ automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontFamily, fontSize: 13, tabSize: 2, padding: { top: 12, bottom: 12 }, wordWrap: "off" }}
    beforeMount={defineObsenTheme}
    onMount={onMount}
    onChange={value => { if (value !== undefined) onChange(value); }}
  />;
}

/** Opens any file beneath the vault's .obsidian folder with Monaco. */
export class MonacoCodeView extends TextFileView {
  private root: Root | null = null;
  private monaco: Monaco | null = null;
  private editorSubscription: { dispose(): void } | null = null;
  private themeObserver: MutationObserver | null = null;

  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return "monaco-editor"; }
  override getDisplayText() { return this.file?.name ?? t("plugins.monaco-editor.name"); }
  getIcon() { return "lucide-code-xml"; }
  canAcceptExtension(_extension: string) { return true; }
  canAcceptPath(path: string) { const configDir = this.app.vault.configDir; return path === configDir || path.startsWith(`${configDir}/`); }

  protected onOpen(): void {
    Object.assign(this.contentEl.style, { padding: "0px", overflow: "hidden", position: "relative" });
    this.root = createRoot(this.contentEl);
    this.renderEditor();
    this.themeObserver = new MutationObserver(() => {
      if (this.monaco) { defineObsenTheme(this.monaco); this.monaco.editor.setTheme("obsen-editor"); }
      this.renderEditor();
    });
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  }

  getViewData(): string { return this.data; }
  setViewData(data: string, _clear: boolean): void { this.data = data; this.renderEditor(); }
  clear(): void { this.data = ""; this.renderEditor(); }

  private renderEditor(): void {
    const file = this.file;
    if (!this.root || !file) return;
    const fontFamily = getComputedStyle(document.body).getPropertyValue("--font-monospace").trim() || "monospace";
    this.root.render(<CodeEditor key={file.path} file={file} value={this.data} fontFamily={fontFamily} onMount={(editor, monaco) => {
      this.editorSubscription?.dispose(); this.monaco = monaco;
      this.editorSubscription = editor.onDidChangeModelContent(() => { this.data = editor.getValue(); this.requestSave(); });
    }} onChange={value => { this.data = value; this.requestSave(); }} />);
  }

  override async onClose(): Promise<void> {
    try { await super.onClose(); }
    finally {
      this.themeObserver?.disconnect(); this.themeObserver = null;
      const root = this.root; this.root = null;
      await Promise.resolve(); root?.unmount(); this.editorSubscription?.dispose(); this.editorSubscription = null; this.monaco = null;
      Object.assign(this.contentEl.style, { padding: "", overflow: "", position: "" });
    }
  }
}

export const monacoEditorModule: CorePluginModule = {
  id: "monaco-editor",
  views: () => ({ "monaco-editor": leaf => new MonacoCodeView(leaf) }),
  extensions: { "monaco-editor": ["*"] },
  install(_context: CorePluginContext) {
    const vs = new URL("./monaco/vs", document.baseURI).href.replace(/\/$/, "");
    loader.config({ paths: { vs } });
  },
};
