import { EditorSelection } from "@codemirror/state";
import moment from "moment";
import { Keymap } from "../../compat/commands";
import { Notice } from "../../compat/ui";
import { normalizePath } from "../../compat/utilities";
import { TFile, type TFolder } from "../../compat/vault";
import { t } from "../../i18n";
import { readCorePluginData } from "../core-plugins";
import { Group, TextInput, describe, usePluginData, type SettingsEnvironment } from "../settings/controls";
import { SettingItem } from "../ui";
import { TemplateFile } from "../settings/tabs-core";
import type { CorePluginContext, CorePluginModule } from "./types";

const DEFAULT_FORMAT = "YYYYMMDDHHmm";
const text = (value: unknown): string => typeof value === "string" ? value : "";
const formatOf = (options: Record<string, unknown>) => text(options.format) || DEFAULT_FORMAT;

/**
 * A name no file starts with: the formatted current time, moved forward by the smallest unit
 * the format can express until it is free.
 */
function uniqueName({ app }: CorePluginContext, format: string, suffix = ""): string | null {
  const files = app.vault.getAllLoadedFiles();
  const taken = (prefix: string) => files.some(file => file instanceof TFile && file.name.startsWith(prefix));
  const now = moment();
  let name = now.format(format);
  if (suffix) name += " " + suffix;
  if (!taken(name)) return name;
  const unit = (["m", "h", "d", "w", "M", "y"] as const).find(step => now.clone().add(1, step).format(format) !== name);
  if (!unit) { new Notice(t("plugins.unique-note-creator.msg-failed-to-generate", { format })); return null; }
  for (const next = now.clone(); ;) { const candidate = next.add(1, unit).format(format); if (!taken(candidate)) return candidate; }
}

async function createUniqueNote(context: CorePluginContext): Promise<TFile | null> {
  const { app, actions, configDir } = context;
  const options = await readCorePluginData(configDir, "zk-prefixer");
  const name = uniqueName(context, formatOf(options));
  if (!name) return null;
  const folderOption = text(options.folder);
  let parent: TFolder;
  if (folderOption) {
    const folder = app.vault.getFolderByPath(normalizePath(folderOption));
    if (!folder) { new Notice(t("plugins.unique-note-creator.msg-folder-not-found", { folderOption })); return null; }
    parent = folder;
  } else parent = app.fileManager.getNewFileParent("", name);
  let content = "";
  if (text(options.template)) {
    let template = normalizePath(text(options.template));
    if (!/\.[^./]+$/.test(template)) template += ".md";
    const file = app.vault.getFileByPath(template);
    if (!file) {
      new Notice(t("plugins.unique-note-creator.msg-template-file-not-found", { template }), 10000).addButton(t("interface.settings"), () => actions.openSettings("zk-prefixer"));
      return null;
    }
    content = await actions.expandTemplate(await app.vault.cachedRead(file), name);
  }
  try { return await app.fileManager.createNewMarkdownFile(parent, name, content); }
  catch (error) { console.error(error); new Notice(t("obsen.notes.error-create-unique")); return null; }
}

async function onCreateNote(context: CorePluginContext): Promise<void> {
  const { app } = context;
  const leaf = app.workspace.getLeaf(Keymap.isModEvent(app.lastEvent as MouseEvent | KeyboardEvent | null));
  const file = await createUniqueNote(context);
  if (!file) return;
  await leaf.openFile(file, { active: true, state: { mode: "source" }, eState: { rename: "end" } });
  app.workspace.setActiveLeaf(leaf);
  // The new note opens with the caret at the end of its title.
  requestAnimationFrame(() => {
    const title = leaf.containerEl.querySelector<HTMLElement>(".inline-title[contenteditable='true']");
    if (!title) return;
    title.focus();
    const range = title.ownerDocument.createRange(); range.selectNodeContents(title); range.collapse(false);
    const selection = title.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
}

/** Wraps each selection in a link to a fresh unique name (`[[202601011200 selection]]`). */
async function addUniqueLink(context: CorePluginContext): Promise<void> {
  const editor = context.actions.activeEditor();
  if (!editor) return;
  const format = formatOf(await readCorePluginData(context.configDir, "zk-prefixer"));
  const view = editor.cm;
  if (!view) {
    const name = uniqueName(context, format, editor.getSelection());
    if (name) editor.replaceSelection(`[[${name}]]`);
    return;
  }
  const { state } = view;
  view.dispatch({ ...state.changeByRange(range => {
    const name = uniqueName(context, format, state.sliceDoc(range.from, range.to));
    if (!name) return { range };
    const next = range.empty ? EditorSelection.cursor(range.from + 2 + name.length) : EditorSelection.range(range.from + 2, range.from + 2 + name.length);
    return { changes: { from: range.from, to: range.to, insert: `[[${name}]]` }, range: next };
  }), userEvent: "input.autocomplete" });
}

function UniqueNoteOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "zk-prefixer", { folder: "", template: "", format: "" });
  return <Group>
    <SettingItem name={t("plugins.unique-note-creator.option-new-file-location")} description={describe("plugins.unique-note-creator.option-new-file-location")}>
      <TextInput value={text(data.folder)} placeholder={t("setting.folder-path-example-placeholder")} onChange={value => set({ folder: value })} />
    </SettingItem>
    <SettingItem name={t("plugins.unique-note-creator.option-template-file")} description={describe("plugins.unique-note-creator.option-template-file")}>
      <TemplateFile environment={environment} value={text(data.template)} placeholder={t("plugins.unique-note-creator.option-template-file-placeholder")} onChange={value => set({ template: value })} />
    </SettingItem>
    <SettingItem name={t("plugins.unique-note-creator.option-id-format")} description={<>
      {t("plugins.daily-notes.label-refer-to-syntax")}<a href="https://momentjs.com/docs/#/displaying/format/" target="_blank" rel="noopener nofollow">{t("plugins.daily-notes.label-syntax-link")}</a><br />
      {t("plugins.daily-notes.label-syntax-live-preview")}<b className="u-pop">{moment().format(text(data.format) || DEFAULT_FORMAT)}</b>
    </>}>
      <TextInput value={text(data.format)} placeholder={DEFAULT_FORMAT} onChange={value => set({ format: value.trim() })} />
    </SettingItem>
  </Group>;
}

export const uniqueNotePlugin: CorePluginModule = {
  id: "zk-prefixer",
  commands: context => [
    { id: "zk-prefixer", run: () => onCreateNote(context) },
    { id: "insert-unique-link", check: () => !!context.actions.activeEditor(), run: () => addUniqueLink(context) },
  ],
  ribbon: context => [{ id: "zk-prefixer", icon: "sheets-in-box", title: t("plugins.unique-note-creator.action-create-note"), onClick: () => context.actions.run(() => onCreateNote(context)) }],
  settings: UniqueNoteOptions,
};
