import { process } from "../../../platforms/platform";
import moment from "moment";
import type { Editor } from "../../compat/editor";
import { getFrontMatterInfo } from "../../compat/metadata-cache";
import type { App } from "../../compat/plugin";
import { FuzzySuggestModal } from "../../compat/suggest";
import { Notice } from "../../compat/ui";
import { normalizePath, parseYaml, stringifyYaml } from "../../compat/utilities";
import { TFile, TFolder, Vault } from "../../compat/vault";
import { t } from "../../i18n";
import type { AppActions } from "../actions";
import { readCorePluginData } from "../core-plugins";

/** The "Templates" core plugin, and the template and property helpers the other note-creating plugins share. */

export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD", DEFAULT_TIME_FORMAT = "HH:mm";
export interface TemplateFormats { dateFormat?: unknown; timeFormat?: unknown }
type Properties = Record<string, unknown>;

/** Replaces each `{{name}}` in `variables` (any capitalisation), then `{{date}}`, `{{time}}` and their `{{date:FORMAT}}` forms. */
export function expandTemplate(source: string, variables: Record<string, string>, formats: TemplateFormats = {}, now?: moment.Moment): string {
  for (const [name, value] of Object.entries(variables)) source = source.replace(new RegExp(`{{${name}}}`, "gi"), () => value);
  let stamp = now ?? null;
  return source.replace(/{{(date|time)(?::(.*?))?}}/gi, (_match, kind: string, format: string | undefined) => {
    stamp ??= moment();
    if (format) return stamp.format(format);
    const configured = kind.toLowerCase() === "date" ? formats.dateFormat : formats.timeFormat;
    return stamp.format(typeof configured === "string" && configured ? configured : kind.toLowerCase() === "date" ? DEFAULT_DATE_FORMAT : DEFAULT_TIME_FORMAT);
  });
}

/** Splits a note into its body and parsed properties; throws when the properties are not a readable YAML mapping. */
export function splitProperties(text: string): { content: string; frontmatter: Properties } {
  const info = getFrontMatterInfo(text);
  if (!info.exists || !info.frontmatter.trim()) return { content: text.slice(info.contentStart), frontmatter: {} };
  const parsed = parseYaml(info.frontmatter);
  if (parsed == null) return { content: text.slice(info.contentStart), frontmatter: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("obsen.errors.properties-mapping"));
  return { content: text.slice(info.contentStart), frontmatter: parsed as Properties };
}

/** Adds `extra` to `target`: lists are joined without duplicates, nested mappings merge, other set values are replaced. */
export function mergeProperties(target: Properties, extra: Properties): void {
  for (const key of Object.keys(extra)) {
    const current = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined, value = extra[key];
    if (!current) target[key] = value;
    else if (Array.isArray(current) && Array.isArray(value)) target[key] = [...new Set([...current, ...value])];
    else if (typeof current === "object" && value !== null && typeof value === "object") mergeProperties(current as Properties, value as Properties);
    else if (value !== null) target[key] = value;
  }
}

export const propertiesBlock = (properties: Properties): string => Object.keys(properties).length ? `---\n${stringifyYaml(properties).trim()}\n---\n` : "";

/** `addition` placed before or after the body of `existing`, a blank line apart, with the properties of both merged. */
export function insertIntoText(existing: string, addition: string, mode: "append" | "prepend" = "append", onInvalid?: () => void): string {
  const read = (text: string) => { try { return splitProperties(text); } catch { onInvalid?.(); return { content: text, frontmatter: {} as Properties }; } };
  const added = read(addition), current = read(existing);
  const first = mode === "prepend" ? added.content : current.content, second = mode === "prepend" ? current.content : added.content;
  const body = first && second && !(first.slice(-2) + second.slice(0, 2)).includes("\n\n")
    ? first + (first.endsWith("\n") || second.startsWith("\n") ? "\n" : "\n\n") + second : first + second;
  mergeProperties(current.frontmatter, added.frontmatter);
  return propertiesBlock(current.frontmatter) + body;
}

export function insertIntoFile(app: App, file: TFile, text: string, mode: "append" | "prepend" = "append"): Promise<string> {
  return app.vault.process(file, data => insertIntoText(data, text, mode, () => new Notice(t("properties.msg-invalid-properties"))));
}

/** Merges `extra` into the properties at the top of the editor's document, creating the block when there is none. */
export function insertEditorProperties(editor: Editor, extra: Properties): void {
  if (!Object.keys(extra).length) return;
  const text = editor.getValue(), info = getFrontMatterInfo(text);
  let current: Properties;
  try { current = splitProperties(text).frontmatter; } catch { new Notice(t("properties.msg-invalid-properties")); return; }
  mergeProperties(current, extra);
  editor.replaceRange(propertiesBlock(current), { line: 0, ch: 0 }, editor.offsetToPos(info.exists ? info.contentStart : 0));
}

/** A template setting names a note with or without its extension. */
export function templateFile(app: App, setting: unknown): { path: string; file: TFile | null } | null {
  if (typeof setting !== "string" || !setting.trim()) return null;
  let filePath = normalizePath(setting);
  if (!/\.[^./]+$/.test(filePath)) filePath += ".md";
  return { path: filePath, file: app.vault.getFileByPath(filePath) };
}

const collator = new Intl.Collator(undefined, { usage: "sort", sensitivity: "base", numeric: true });
const options = (actions: AppActions) => readCorePluginData(actions.config.configDir, "templates").catch(() => ({} as Record<string, unknown>));

export async function insertTemplate(actions: AppActions, template: TFile): Promise<void> {
  const editor = actions.activeEditor();
  if (!editor) return;
  const formats = await options(actions);
  const text = expandTemplate(await actions.vault.cachedRead(template), { title: actions.activeFile()?.basename ?? "" }, formats);
  const cursor = editor.getCursor("from");
  if (cursor.line === 0 && cursor.ch === 0) { editor.replaceSelection(text); return; }
  let parts: ReturnType<typeof splitProperties>;
  try { parts = splitProperties(text); } catch { new Notice(t("plugins.templates.msg-fail-invalid-template-properties")); return; }
  editor.replaceSelection(parts.content);
  insertEditorProperties(editor, parts.frontmatter);
}

class TemplateModal extends FuzzySuggestModal<TFile> {
  constructor(private readonly actions: AppActions, private readonly files: TFile[], private readonly folderPath: string) {
    super(actions.app);
    this.emptyStateText = t("plugins.templates.msg-no-templates-found");
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.templates.instruction-navigate") },
      { command: "↵", purpose: t("plugins.templates.instruction-insert") },
      { command: "esc", purpose: t("plugins.templates.instruction-dismiss") },
    ]);
    this.setPlaceholder(t("plugins.templates.prompt-type-template"));
    this.scope.register(null, "Tab", () => false);
  }
  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path.slice(0, file.path.length - file.extension.length - 1).slice(this.folderPath.length + 1); }
  onChooseItem(file: TFile): void { this.actions.run(() => insertTemplate(this.actions, file)); }
}

/** Opens the template prompt for the configured folder, or says why it cannot. */
export async function openTemplatePicker(actions: AppActions): Promise<void> {
  const setting = (await options(actions)).folder;
  if (typeof setting !== "string" || !setting) { new Notice(t("plugins.templates.msg-no-folder-set")); return; }
  const folderPath = normalizePath(setting), folder = actions.vault.getFolderByPath(folderPath);
  if (!folder) { new Notice(t("plugins.templates.msg-fail-folder-not-found", { folderOption: setting })); return; }
  if (folder.isRoot()) { new Notice(t("plugins.templates.msg-fail-invalid-folder")); return; }
  const files: TFile[] = [];
  Vault.recurseChildren(folder as TFolder, file => { if (file instanceof TFile && file.extension === "md") files.push(file); });
  files.sort((a, b) => collator.compare(a.path, b.path));
  new TemplateModal(actions, files, folderPath).open();
}

/** Inserts the current date or time at the cursor, in the format set for templates. */
export async function insertCurrentMoment(actions: AppActions, kind: "date" | "time"): Promise<void> {
  const editor = actions.activeEditor();
  if (!editor) return;
  const configured = (await options(actions))[kind === "date" ? "dateFormat" : "timeFormat"];
  const text = moment().format(typeof configured === "string" && configured ? configured : kind === "date" ? DEFAULT_DATE_FORMAT : DEFAULT_TIME_FORMAT);
  const head = editor.getCursor("head");
  editor.replaceRange(text, head);
  editor.setCursor({ line: head.line, ch: head.ch + text.length });
}
