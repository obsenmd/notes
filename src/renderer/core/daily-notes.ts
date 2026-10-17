import moment from "moment";
import { Keymap } from "../../compat/commands";
import { Notice } from "../../compat/ui";
import { normalizePath } from "../../compat/utilities";
import { TFile, TFolder, Vault } from "../../compat/vault";
import { t } from "../../i18n";
import type { AppActions } from "../actions";
import { readCorePluginData } from "../core-plugins";
import { expandTemplate, templateFile } from "./templates";

/** The "Daily notes" core plugin: today's note (created from the template when missing) and stepping between existing ones. */

const DEFAULT_FORMAT = "YYYY-MM-DD";
type Options = Record<string, unknown>;
const cache = new Map<string, Options>();

/** Reads `daily-notes.json`; the last read stays available to the synchronous command checks. */
export async function loadDailyNoteOptions(actions: AppActions): Promise<Options> {
  const dir = actions.config.configDir, data = await readCorePluginData(dir, "daily-notes").catch(() => ({} as Options));
  cache.set(dir, data);
  return data;
}
const cached = (actions: AppActions): Options => cache.get(actions.config.configDir) ?? {};
const formatOf = (options: Options) => typeof options.format === "string" && options.format ? options.format : DEFAULT_FORMAT;
const prefixOf = (folder: TFolder) => folder.isRoot() ? "" : `${folder.path}/`;
const withoutExtension = (name: string) => { const dot = name.lastIndexOf("."); return dot <= 0 || dot === name.length - 1 ? name : name.slice(0, dot); };

function folderOf(actions: AppActions, options: Options): TFolder | null {
  return typeof options.folder === "string" && options.folder ? actions.vault.getFolderByPath(normalizePath(options.folder)) : actions.vault.getRoot();
}

/** The note for `date` (today by default), created when it does not exist; null when the settings make that impossible. */
export async function getDailyNote(actions: AppActions, date = moment()): Promise<TFile | null> {
  const { vault } = actions, options = await loadDailyNoteOptions(actions), format = formatOf(options);
  let name: string;
  try { name = date.format(format).trim(); } catch (error) { new Notice(t("plugins.daily-notes.msg-fail-format", { format })); console.error(error); return null; }
  let parent: TFolder;
  if (typeof options.folder === "string" && options.folder) {
    const folder = vault.getAbstractFileByPath(normalizePath(options.folder));
    if (!(folder instanceof TFolder)) { new Notice(t("plugins.daily-notes.msg-fail-folder", { folderOption: options.folder })); return null; }
    parent = folder;
  } else parent = actions.newFileParent();
  const filePath = normalizePath(`${prefixOf(parent)}${name}.md`), lower = filePath.toLowerCase();
  const existing = vault.getAbstractFileByPath(filePath) ?? vault.getAllLoadedFiles().find(file => file.path.toLowerCase() === lower) ?? null;
  if (existing) return existing instanceof TFile ? existing : null;
  try {
    let content = "";
    const template = templateFile(actions.app, options.template);
    if (template) {
      if (!template.file) { new Notice(t("plugins.daily-notes.msg-fail-template-file", { template: template.path })); return null; }
      // Daily notes expand `{{date}}` and `{{time}}` with the built-in formats, not the ones set for templates.
      content = expandTemplate(await vault.cachedRead(template.file), { title: name }, {});
    }
    // A format such as YYYY/MM/DD files the note into folders that may not exist yet.
    const folders = filePath.split("/").slice(0, -1);
    for (let depth = 1; depth <= folders.length; depth++) { const folder = folders.slice(0, depth).join("/"); if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder); }
    return await vault.create(filePath, content);
  } catch (error) { console.error(error); new Notice(t("obsen.notes.error-create-daily")); return null; }
}

/** Opens today's note in editing view, in the pane the triggering click or key asks for. */
export async function openDailyNote(actions: AppActions, event?: MouseEvent | KeyboardEvent | null): Promise<void> {
  const file = await getDailyNote(actions);
  if (file) await actions.openFile(file, Keymap.isModEvent(event ?? actions.app.lastEvent as MouseEvent | KeyboardEvent | null), { mode: "source" });
}

function eachDailyNote(actions: AppActions, options: Options, callback: (file: TFile, time: number) => void): void {
  const folder = folderOf(actions, options), format = formatOf(options);
  if (!folder) { new Notice(t("plugins.daily-notes.msg-missing-folder")); return; }
  const prefix = prefixOf(folder);
  Vault.recurseChildren(folder, file => {
    if (!(file instanceof TFile) || !file.path.startsWith(prefix)) return;
    const date = moment(withoutExtension(file.path.slice(prefix.length)), format, true);
    if (date.isValid()) callback(file, date.valueOf());
  });
}

/** The date of the active note when it is a daily note, as a timestamp. */
export function currentDailyNoteTime(actions: AppActions): number | null {
  const options = cached(actions), folder = folderOf(actions, options), file = actions.activeFile();
  if (!folder || !file || file.extension !== "md") return null;
  const prefix = prefixOf(folder);
  if (!file.path.startsWith(prefix)) return null;
  const date = moment(withoutExtension(file.path.slice(prefix.length)), formatOf(options), true);
  return date.isValid() ? date.valueOf() : null;
}

/** Opens the closest existing daily note before (-1) or after (1) the active one. */
export async function openAdjacentDailyNote(actions: AppActions, direction: 1 | -1): Promise<void> {
  const options = await loadDailyNoteOptions(actions), from = currentDailyNoteTime(actions);
  if (from === null) return;
  let best: TFile | null = null, bestTime = direction < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  eachDailyNote(actions, options, (file, time) => {
    if (direction < 0 ? time < from && time > bestTime : time > from && time < bestTime) { best = file; bestTime = time; }
  });
  if (!best) { new Notice(t(direction < 0 ? "plugins.daily-notes.msg-no-previous" : "plugins.daily-notes.msg-no-next")); return; }
  await actions.openFile(best);
}
