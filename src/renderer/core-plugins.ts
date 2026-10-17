import { path, originalFs as fs } from "../../platforms/platform";
import { useEffect, useState } from "react";
import { writeJson } from "./config";
import type { Workspace } from "../compat/workspace";
import { t } from "../i18n";

export interface CorePluginDefinition {
  id: string;
  /** Locale group under `plugins.` holding `name` and `desc`. */
  group: string;
  defaultOn: boolean;
  icon?: string;
  /** Plugins with their own settings tab. */
  hasSettings?: boolean;
}

/** The pinned release's core plugin registry, in the order the settings list shows it. */
export const CORE_PLUGINS: CorePluginDefinition[] = [
  { id: "file-explorer", group: "file-explorer", defaultOn: true, icon: "lucide-folder-closed" },
  { id: "monaco-editor", group: "monaco-editor", defaultOn: true, icon: "lucide-code-xml" },
  { id: "global-search", group: "search", defaultOn: true, icon: "lucide-search" },
  { id: "switcher", group: "quick-switcher", defaultOn: true, icon: "lucide-file-search", hasSettings: true },
  { id: "graph", group: "graph-view", defaultOn: true, icon: "lucide-git-fork" },
  { id: "backlink", group: "backlinks", defaultOn: true, icon: "links-coming-in", hasSettings: true },
  { id: "canvas", group: "canvas", defaultOn: true, icon: "lucide-layout-dashboard", hasSettings: true },
  { id: "outgoing-link", group: "outgoing-links", defaultOn: true, icon: "links-going-out" },
  { id: "tag-pane", group: "tag-pane", defaultOn: true, icon: "lucide-tags" },
  { id: "footnotes", group: "footnotes-pane", defaultOn: false, icon: "lucide-file-signature" },
  { id: "properties", group: "properties", defaultOn: true, icon: "lucide-archive" },
  { id: "page-preview", group: "page-preview", defaultOn: true, icon: "lucide-scan-eye", hasSettings: true },
  { id: "daily-notes", group: "daily-notes", defaultOn: true, icon: "lucide-calendar", hasSettings: true },
  { id: "templates", group: "templates", defaultOn: true, icon: "lucide-files", hasSettings: true },
  { id: "note-composer", group: "note-composer", defaultOn: true, icon: "lucide-merge", hasSettings: true },
  { id: "command-palette", group: "command-palette", defaultOn: true, icon: "lucide-terminal", hasSettings: true },
  { id: "slash-command", group: "slash-command", defaultOn: false, icon: "lucide-terminal-square" },
  { id: "editor-status", group: "editor-status", defaultOn: true, icon: "lucide-edit-3" },
  { id: "bookmarks", group: "bookmarks", defaultOn: true, icon: "lucide-bookmark" },
  { id: "zk-prefixer", group: "unique-note-creator", defaultOn: false, icon: "sheets-in-box", hasSettings: true },
  { id: "random-note", group: "random-note", defaultOn: false, icon: "lucide-dice" },
  { id: "outline", group: "outline", defaultOn: true, icon: "lucide-list" },
  { id: "word-count", group: "word-count", defaultOn: true, icon: "lucide-pilcrow" },
  { id: "slides", group: "slides", defaultOn: false, icon: "lucide-presentation" },
  { id: "audio-recorder", group: "audio-recorder", defaultOn: false, icon: "lucide-mic" },
  { id: "workspaces", group: "workspaces", defaultOn: false, icon: "lucide-layout" },
  { id: "file-recovery", group: "file-recovery", defaultOn: true, icon: "lucide-history", hasSettings: true },
  { id: "publish", group: "publish", defaultOn: false, icon: "lucide-send" },
  { id: "sync", group: "sync", defaultOn: true, icon: "lucide-refresh-cw", hasSettings: true },
  { id: "bases", group: "bases", defaultOn: true, icon: "lucide-layout-list" },
  { id: "webviewer", group: "web-viewer", defaultOn: false, icon: "lucide-globe-2", hasSettings: true },
];

/** Enablement stored in `.obsidian/core-plugins.json` (an id-to-boolean map; the legacy array form is also read). */
export class CorePluginStore {
  private state: Record<string, boolean> = Object.fromEntries(CORE_PLUGINS.map(plugin => [plugin.id, plugin.defaultOn]));
  private readonly listeners = new Set<() => void>();
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(configDir: string) { this.file = path.join(configDir, "core-plugins.json"); }

  async load(): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(await fs.promises.readFile(this.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (Array.isArray(parsed)) {
      const enabled = new Set(parsed.filter((id): id is string => typeof id === "string"));
      for (const plugin of CORE_PLUGINS) this.state[plugin.id] = enabled.has(plugin.id) || plugin.id === "monaco-editor";
    } else if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(parsed)) if (typeof value === "boolean") this.state[id === "starred" ? "bookmarks" : id] = value;
    }
    this.emit();
  }

  isEnabled(id: string): boolean { return this.state[id] === true; }
  snapshot(): Record<string, boolean> { return { ...this.state }; }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    if (this.state[id] === enabled) return this.writing;
    this.state[id] = enabled;
    this.emit();
    const data = this.snapshot();
    this.writing = this.writing.catch(() => undefined).then(() => writeJson(this.file, data));
    return this.writing;
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of [...this.listeners]) listener(); }
}

export function useCorePlugins(store: CorePluginStore): Record<string, boolean> {
  const [state, setState] = useState(() => store.snapshot());
  useEffect(() => { setState(store.snapshot()); return store.onChange(() => setState(store.snapshot())); }, [store]);
  return state;
}

/** Core plugins expose their preview source only while enabled. Community plugins use the same workspace registry. */
export function watchCoreHoverLinkSources(workspace: Workspace, store: CorePluginStore): () => void {
  const sources = CORE_PLUGINS.filter(plugin => ["graph", "bases", "bookmarks", "file-explorer", "outline", "properties"].includes(plugin.id));
  const registered = new Map<string, { display: string; defaultMod: boolean }>();
  const update = () => {
    for (const { id, group } of sources) {
      const current = registered.get(id), display = t(`plugins.${group}.name`);
      if (store.isEnabled(id)) {
        if (!current || current.display !== display) {
          const info = { display, defaultMod: true };
          registered.set(id, info); workspace.registerHoverLinkSource(id, info);
        }
      } else if (current) {
        if (workspace.hoverLinkSources[id] === current) workspace.unregisterHoverLinkSource(id);
        registered.delete(id);
      }
    }
  };
  update();
  const stop = store.onChange(update);
  window.addEventListener("language-changed", update);
  return () => {
    stop(); window.removeEventListener("language-changed", update);
    for (const [id, info] of registered) if (workspace.hoverLinkSources[id] === info) workspace.unregisterHoverLinkSource(id);
  };
}

/** Reads a core plugin's data file (`.obsidian/<id>.json`). */
export async function readCorePluginData(configDir: string, id: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(configDir, `${id}.json`), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}
export function writeCorePluginData(configDir: string, id: string, data: Record<string, unknown>): Promise<void> {
  return writeJson(path.join(configDir, `${id}.json`), data);
}
