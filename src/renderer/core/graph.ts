import { Keymap } from "../../compat/commands";
import type { Menu } from "../../compat/ui";
import { TFile } from "../../compat/vault";
import type { WorkspaceLeaf } from "../../compat/workspace";
import { t } from "../../i18n";
import { GraphWorkspaceView } from "../CoreViews";
import type { CorePluginContext, CorePluginModule } from "./types";

/** Opens the graph of a note beside a tab and links the two, so the graph follows that tab. */
async function openLocalGraph({ app }: CorePluginContext, leaf: WorkspaceLeaf, file: TFile): Promise<void> {
  await app.workspace.createLeafBySplit(leaf, "vertical").setViewState({ type: "localgraph", active: true, group: leaf, state: { file: file.path } });
}

export const graphModule: CorePluginModule = {
  id: "graph",
  commands: context => {
    const { app } = context, workspace = app.workspace;
    return [
      { id: "graph:open", run: () => workspace.getLeaf(Keymap.isModEvent(app.lastEvent as MouseEvent | KeyboardEvent | null)).setViewState({ type: "graph", active: true, state: {} }) },
      { id: "graph:open-local", check: () => !!workspace.activeFile && !!workspace.activeLeaf, run: () => openLocalGraph(context, workspace.activeLeaf!, workspace.activeFile!) },
      { id: "graph:animate", check: () => !!workspace.getActiveViewOfType(GraphWorkspaceView), run: () => workspace.trigger("graph:animate") },
    ];
  },
  install(context) {
    const { app } = context;
    const ref = app.workspace.on("file-menu", (...data: unknown[]) => {
      const [menu, file, source, leaf] = data as [Menu, unknown, string, WorkspaceLeaf | null | undefined];
      if (!(file instanceof TFile) || !leaf || file.extension !== "md" || source === "sidebar-context-menu") return;
      menu.addItem(item => item.setSection("view.linked").setTitle(t("plugins.graph-view.action-open-local")).setIcon("lucide-git-fork").onClick(() => void openLocalGraph(context, leaf, file)));
    });
    app.workspace.registerHoverLinkSource("graph", { display: t("plugins.graph-view.name"), defaultMod: true });
    return () => { app.workspace.offref(ref); app.workspace.unregisterHoverLinkSource("graph"); };
  },
};
