import { useEffect, useState } from "react";
import { Menu } from "../compat/ui";
import { MarkdownView } from "../compat/markdown-view";
import { countWords, withoutProperties } from "../compat/word-count";
import { useT } from "../i18n/react";
import type { AppActions } from "./actions";
import { useConfig } from "./config";
import { useCorePlugins } from "./core-plugins";
import { IconEl } from "./ui";

type EditorStatus = "read" | "source" | "live-preview";
const STATUS_ICONS: Record<EditorStatus, string> = { read: "lucide-book-open", source: "lucide-code-2", "live-preview": "lucide-edit-3" };
const STATUS_LABELS: Record<EditorStatus, string> = { read: "plugins.editor-status.read", source: "plugins.editor-status.edit-source", "live-preview": "plugins.editor-status.edit-live-preview" };

/** Built-in status items in the reference order; plugin items are appended to the same container. */
export function StatusBarItems({ actions }: { actions: AppActions }) {
  const t = useT();
  const { workspace, host } = actions;
  const plugins = useCorePlugins(actions.corePlugins);
  useConfig(actions.config, "livePreview");
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick(tick => tick + 1);
    const refs = ["active-leaf-change", "layout-change", "file-open", "editor-change"].map(name => workspace.on(name, bump));
    const cacheRefs = [host.metadataCache.on("resolved", bump), host.metadataCache.on("changed", bump)];
    return () => { refs.forEach(ref => workspace.offref(ref)); cacheRefs.forEach(ref => host.metadataCache.offref(ref)); };
  }, [workspace, host]);

  // The note the bar describes: the active Markdown view, or the last one while a sidebar pane has the focus.
  const activeView = workspace.activeLeaf?.view, recentView = workspace.getMostRecentLeaf()?.view;
  const file = workspace.activeFile ?? null;
  const view = activeView instanceof MarkdownView ? activeView : recentView instanceof MarkdownView && !!file && recentView.file === file ? recentView : null;
  const editor = view?.editor ?? null;
  // Selection changes do not reach the workspace as events; follow the editor itself.
  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick(tick => tick + 1);
    editor.onUpdate(bump);
    return () => editor.offUpdate(bump);
  }, [editor]);

  // A selection is counted as it is; otherwise the whole note without its properties.
  const selection = view && view.getMode() !== "preview" ? editor?.getSelection() ?? "" : "";
  const counted = view ? selection || withoutProperties(view.getViewData()) : null;
  const backlinks = file ? actions.backlinkCount(file) : 0;
  const properties = file ? Object.keys(host.metadataCache.getFileCache(file)?.frontmatter ?? {}).length : 0;
  const status: EditorStatus | null = view ? (view.getMode() === "preview" ? "read" : view.sourceMode ? "source" : "live-preview") : null;
  const setStatus = (next: EditorStatus) => {
    if (!view) return;
    if (next !== "read") view.setSourceMode(next === "source");
    view.setMode(next === "read" ? "preview" : "source");
    workspace.notifyLayoutChange();
  };
  const statusMenu = (event: React.MouseEvent) => {
    if (!view || !status) return;
    event.preventDefault();
    const menu = new Menu();
    for (const id of ["read", "source", "live-preview"] as const) menu.addItem(item => item.setTitle(t(STATUS_LABELS[id])).setIcon(STATUS_ICONS[id]).setChecked(status === id).onClick(() => setStatus(id)));
    menu.showAtMouseEvent(event.nativeEvent);
  };
  const hidden = { display: "none" } as const;

  return <>
    {plugins.backlink && <div className="status-bar-item plugin-backlink mod-clickable" style={file ? undefined : hidden} onClick={() => actions.run(() => actions.revealLeafOfType("backlink", "right"))}>
      {file ? t("nouns.backlink-with-count", { count: backlinks }) : ""}
    </div>}
    {plugins.properties && <div className="status-bar-item plugin-properties mod-clickable" style={properties > 0 ? undefined : hidden} onClick={() => actions.run(() => actions.revealLeafOfType("file-properties", "right"))}>
      {t("nouns.properties-with-count", { count: properties })}
    </div>}
    {plugins["editor-status"] && <div className="status-bar-item plugin-editor-status mod-clickable" style={status ? undefined : hidden} aria-label={status ? t(STATUS_LABELS[status]) : undefined} data-tooltip-position="top" onClick={statusMenu} onContextMenu={statusMenu}>
      <IconEl tag="span" className="status-bar-item-icon" icon={STATUS_ICONS[status ?? "live-preview"]} />
    </div>}
    {plugins["word-count"] && <div className="status-bar-item plugin-word-count" style={counted !== null ? undefined : hidden}>
      <span className="status-bar-item-segment">{counted !== null ? t("nouns.word-with-count", { count: countWords(counted) }) : ""}</span>
      <span className="status-bar-item-segment">{counted !== null ? t("nouns.character-with-count", { count: counted.length }) : ""}</span>
    </div>}
  </>;
}
