import { getFrontMatterInfo } from "../compat/metadata-cache";
import { MarkdownView } from "../compat/markdown-view";
import { normalizePath } from "../compat/utilities";
import { TFile } from "../compat/vault";
import type { AppActions } from "./actions";
import { loadDailyNoteOptions, getDailyNote } from "./core/daily-notes";
import { writeCorePluginData } from "./core-plugins";

/** The enabled core plugin migrates its old preference before community startup. */
export async function migrateStartupPreference(actions: AppActions): Promise<void> {
  if (!actions.corePlugins.isEnabled("daily-notes")) return;
  const options = await loadDailyNoteOptions(actions);
  if (!options.autorun) return;
  if (!actions.config.get("openBehavior")) actions.config.set("openBehavior", "daily");
  delete options.autorun;
  await writeCorePluginData(actions.config.configDir, "daily-notes", options);
}

/** Desktop opening behavior runs once after plugins and workspace restoration. */
export async function runStartupBehavior(actions: AppActions): Promise<void> {
  const { config, vault, workspace, corePlugins } = actions, behavior = config.get("openBehavior");
  if (behavior === "daily" && corePlugins.isEnabled("daily-notes")) {
    const file = await getDailyNote(actions);
    if (file) await workspace.getLeaf().openFile(file);
  } else if (behavior.startsWith("file:")) {
    let path = normalizePath(behavior.slice(5));
    if (path && !path.split("/").at(-1)?.includes(".")) path += ".md";
    const file = vault.getAbstractFileByPath(path) ?? vault.getAllLoadedFiles().find(file => file.path.toLowerCase() === path.toLowerCase());
    if (file instanceof TFile) await workspace.getLeaf().openFile(file);
  } else if (behavior === "new") {
    const view = workspace.getActiveViewOfType(MarkdownView);
    if (view) { const text = view.getViewData(), info = getFrontMatterInfo(text); if (!(info.exists ? text.slice(info.contentStart) : text).trim()) return; }
    await actions.newNote(undefined, false);
  }
}
