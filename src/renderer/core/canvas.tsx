import { process } from "../../../platforms/platform";
import { createRoot } from "react-dom/client";
import { Keymap } from "../../compat/commands";
import { Component } from "../../compat/component";
import { registerFileEmbedRenderer } from "../../compat/markdown";
import { Notice } from "../../compat/ui";
import { debounce } from "../../compat/utilities";
import { TFile, TFolder } from "../../compat/vault";
import { t } from "../../i18n";
import { CanvasMinimap } from "../canvas/cards";
import { serializeCanvas, type CanvasData } from "../canvas/data";
import { modDragLabel } from "../canvas/modals";
import { canvasHooks } from "../canvas/controller";
import { CanvasFileView } from "../CoreViews";
import { addFileMenuItems } from "../FileExplorer";
import { readCorePluginData } from "../core-plugins";
import { Group, SliderRow, TextInput, ToggleRow, describe, usePluginData, type SettingsEnvironment } from "../settings/controls";
import { SettingItem } from "../ui";
import { Dropdown } from "../settings/controls";
import type { CorePluginContext, CorePluginModule } from "./types";

const activeCanvas = ({ app }: CorePluginContext) => app.workspace.getActiveViewOfType(CanvasFileView);

/** Folder new canvases go to: the vault root, the active file's folder, or the configured one. */
async function newCanvasParent({ app, configDir }: CorePluginContext): Promise<TFolder> {
  const options = await readCorePluginData(configDir, "canvas").catch(() => ({} as Record<string, unknown>)), active = app.workspace.activeFile;
  if (options.newFileLocation === "folder") { const folder = app.vault.getAbstractFileByPath(String(options.newFileFolderPath ?? "")); if (folder instanceof TFolder) return folder; }
  else if (options.newFileLocation === "current" && active?.parent) return active.parent;
  return app.vault.getRoot();
}

/** Canvases that embed a renamed file follow the rename (file cards and group backgrounds). */
function followRenames({ app }: CorePluginContext): () => void {
  let renames: Array<[string, string]> = [];
  let queue = Promise.resolve();
  const flush = debounce(() => {
    const batch = renames; renames = [];
    queue = queue.then(async () => {
      const from = new Set(batch.map(([oldPath]) => oldPath)), affected: TFile[] = [];
      for (const file of app.vault.getFiles()) {
        if (file.extension !== "canvas") continue;
        try {
          const data = JSON.parse(await app.vault.cachedRead(file) || "{}") as Partial<CanvasData>;
          if (data.nodes?.some(node => (node.type === "file" && from.has(String(node.file))) || (node.type === "group" && from.has(String(node.background))))) affected.push(file);
        } catch { /* an unreadable canvas is left alone */ }
      }
      if (!affected.length) return;
      const notice = new Notice(t("plugins.canvas.msg-updating-links", { count: affected.length }), 0);
      let updated = 0;
      for (const file of affected) await app.vault.process(file, text => {
        if (!text) return text;
        const data = JSON.parse(text) as CanvasData;
        for (const node of data.nodes) for (const [oldPath, newPath] of batch) {
          if (node.type === "file" && node.file === oldPath) { node.file = newPath; updated++; }
          else if (node.type === "group" && node.background === oldPath) { node.background = newPath; updated++; }
        }
        return serializeCanvas(data);
      }).catch(error => console.error(error));
      if (updated > 0) { notice.setMessage(t("plugins.canvas.msg-updated-links", { count: updated })); setTimeout(() => notice.hide(), 4000); } else notice.hide();
    }).catch(error => console.error(error));
  }, 500, true);
  const local = (path: string) => "canvas-" + path;
  const renamed = app.vault.on("rename", (file, oldPath) => {
    if (!(file instanceof TFile)) return;
    if (file.extension === "canvas") { const state = app.loadLocalStorage(local(oldPath)); if (state) { app.saveLocalStorage(local(oldPath), null); app.saveLocalStorage(local(file.path), state); } }
    renames.push([oldPath, file.path]); flush();
  });
  const deleted = app.vault.on("delete", file => { if (file instanceof TFile && file.extension === "canvas") app.saveLocalStorage(local(file.path), null); });
  return () => { app.vault.offref(renamed); app.vault.offref(deleted); flush.cancel(); };
}

function CanvasSettings({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "canvas", { newFileLocation: "root", newFileFolderPath: "", defaultWheelBehavior: "pan", defaultModDragBehavior: "menu", cardLabelVisibility: "always", snapToGrid: true, snapToObjects: true, zoomBreakpoint: 0 });
  return <Group>
    <SettingItem name={t("plugins.canvas.option-new-canvas-location")}>
      <Dropdown value={data.newFileLocation} options={[{ value: "root", label: t("setting.file.option-choice-vault-root") }, { value: "current", label: t("setting.file.option-choice-current-folder") }, { value: "folder", label: t("setting.file.option-choice-specified-folder") }]} onChange={value => set({ newFileLocation: value })} />
    </SettingItem>
    {data.newFileLocation === "folder" && <SettingItem name={t("plugins.canvas.option-new-canvas-folder-path")} description={describe("plugins.canvas.option-new-canvas-folder-path")}><TextInput value={data.newFileFolderPath} placeholder={t("setting.folder-path-example-placeholder")} onChange={value => set({ newFileFolderPath: value })} /></SettingItem>}
    <SettingItem name={t("plugins.canvas.option-wheel-behavior")}>
      <Dropdown value={data.defaultWheelBehavior} options={[{ value: "pan", label: t("plugins.canvas.label-pan") }, { value: "zoom", label: t("plugins.canvas.label-zoom") }]} onChange={value => set({ defaultWheelBehavior: value })} />
    </SettingItem>
    <SettingItem name={t("plugins.canvas.option-mod-drag-behavior", { key: modDragLabel() })}>
      <Dropdown value={data.defaultModDragBehavior} options={[
        { value: "menu", label: t("plugins.canvas.option-show-menu") }, { value: "card", label: t("plugins.canvas.action-add-card") }, { value: "note", label: t("plugins.canvas.action-add-note") },
        { value: "media", label: t("plugins.canvas.action-add-media") }, { value: "webpage", label: t("plugins.canvas.action-add-website") }, { value: "group", label: t("plugins.canvas.action-create-group") },
      ]} onChange={value => set({ defaultModDragBehavior: value })} />
    </SettingItem>
    <SettingItem name={t("plugins.canvas.option-node-label")}>
      <Dropdown value={data.cardLabelVisibility} options={[{ value: "always", label: t("plugins.canvas.label-always") }, { value: "hover", label: t("plugins.canvas.label-hover") }, { value: "never", label: t("plugins.canvas.label-never") }]} onChange={value => set({ cardLabelVisibility: value })} />
    </SettingItem>
    <ToggleRow name={t("plugins.canvas.option-snap-to-grid")} description={describe("plugins.canvas.option-snap-to-grid")} value={data.snapToGrid} onChange={value => set({ snapToGrid: value })} />
    <ToggleRow name={t("plugins.canvas.option-snap-to-objects")} description={describe("plugins.canvas.option-snap-to-objects")} value={data.snapToObjects} onChange={value => set({ snapToObjects: value })} />
    <SliderRow name={t("plugins.canvas.option-zoom-breakpoint")} description={describe("plugins.canvas.option-zoom-breakpoint")} value={data.zoomBreakpoint} defaultValue={0} min={-0.7} max={2.3999999999999995} step={0.01}
      format={value => `${Math.round(100 * Math.pow(1.2, value))}%`} onChange={value => set({ zoomBreakpoint: value })} />
  </Group>;
}

export const canvasModule: CorePluginModule = {
  id: "canvas",
  commands: context => [
    { id: "canvas:new-file", run: async () => context.actions.run(async () => { await context.actions.newCanvas(await newCanvasParent(context), Keymap.isModEvent(context.app.lastEvent as MouseEvent | null)); }) },
    { id: "canvas:export-as-image", check: () => !!activeCanvas(context), run: () => activeCanvas(context)?.exportImage() },
    { id: "canvas:jump-to-group", check: () => !!activeCanvas(context), run: () => activeCanvas(context)?.canvas.jumpToGroup() },
    { id: "canvas:convert-to-file", check: () => !!activeCanvas(context)?.canvas.convertibleSelection(), run: () => { const canvas = activeCanvas(context)?.canvas, card = canvas?.convertibleSelection(); if (canvas && card) canvas.convertToFile(card.id); } },
  ],
  install(context) {
    const { app } = context;
    // A canvas embedded in a note is drawn as an outline that opens the canvas.
    const removeEmbed = registerFileEmbedRenderer(app, "canvas", (file, el, options) => {
      class CanvasEmbed extends Component {
        private root = createRoot(el);
        override onload(): void {
          el.classList.add("canvas-embed");
          const draw = () => void app.vault.cachedRead(file).then(source => { if (this.isLoaded()) this.root.render(<CanvasMinimap source={source} />); });
          draw();
          this.registerEvent(app.vault.on("modify", changed => { if (changed === file) draw(); }));
          this.registerDomEvent(el, "click", event => void app.workspace.openLinkText(file.path + options.subpath, options.sourcePath, Keymap.isModEvent(event)));
        }
        override onunload(): void { this.root.unmount(); el.classList.remove("canvas-embed"); }
      }
      return new CanvasEmbed();
    });
    const stopRenames = followRenames(context);
    canvasHooks.fileMenu = (menu, file, source) => addFileMenuItems(menu, context.actions, file, source);
    return () => { removeEmbed(); stopRenames(); canvasHooks.fileMenu = undefined; };
  },
  settings: CanvasSettings,
};
