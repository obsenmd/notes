import { process } from "../../platforms/platform";
import type { App } from "../compat/plugin";
import { Modal } from "../compat/ui";
import { parseYaml, stringifyYaml } from "../compat/utilities";
import { t } from "../i18n";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The key an object already uses for `name`, whatever its letter case; `name` itself when it has none. */
function existingKey(data: Record<string, unknown>, name: string): string {
  return Object.keys(data).find(key => key.toLowerCase() === name) ?? name;
}
/** Renames a key in place, keeping the order of the properties. */
function renameKey(data: Record<string, unknown>, from: string, to: string): void {
  const entries = Object.entries(data);
  for (const key of Object.keys(data)) delete data[key];
  for (const [key, value] of entries) data[key === from ? to : key] = value;
}

/**
 * Rewrites a note's properties to the strict format: `alias`, `tag` and `cssclass` become their
 * plural keys, and text values of those keys become lists. Returns the text unchanged when
 * nothing needs converting.
 */
export function migrateFrontmatter(text: string): string {
  const match = FRONTMATTER.exec(text);
  if (!match) return text;
  let data: unknown;
  try { data = parseYaml(match[1]); } catch { return text; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return text;
  const properties = data as Record<string, unknown>;
  let changed = false;
  for (const [plural, singular, separator] of [["aliases", "alias", /[,\n]/], ["tags", "tag", /[ ,\n]/], ["cssclasses", "cssclass", /[ ,\n]/]] as const) {
    const key = existingKey(properties, plural);
    if (!Object.hasOwn(properties, key)) {
      const legacy = Object.keys(properties).find(name => name.toLowerCase() === singular);
      if (legacy) { renameKey(properties, legacy, key); changed = true; }
    }
    const value = properties[key];
    if (Object.hasOwn(properties, key) && typeof value === "string") {
      properties[key] = value.split(separator).map(item => item.trim()).filter(Boolean);
      changed = true;
    }
  }
  if (!changed) return text;
  return "---\n" + stringifyYaml(properties).replace(/\n*$/, "\n") + "---\n" + text.slice(match[0].length);
}

/** "Frontmatter migration": converts every note in the vault, with progress and a way to stop. */
export class FrontmatterMigrationModal extends Modal {
  private readonly conversionsEl: HTMLElement;
  private readonly resultEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly processedEl: HTMLElement;
  private readonly modifiedEl: HTMLElement;
  private readonly failedEl: HTMLElement;
  private readonly cancelEl: HTMLElement;
  private readonly goBackEl: HTMLElement;
  private readonly doneEl: HTMLElement;
  private cancelled = false;
  private running = false;

  constructor(app: App) {
    super(app);
    const key = (name: string) => t(`plugins.markdown-format-importer.${name}`);
    this.setTitle(key("frontmatter-migration"));
    const conversions = this.conversionsEl = this.contentEl.createDiv();
    conversions.createEl("p", { cls: "setting-message", text: key("frontmatter-migration-description") });
    conversions.createEl("p", { cls: "setting-message mod-warning", text: `${key("msg-all-files-warning")} ${key("msg-override-files-warning")}` });
    const start = conversions.createDiv("modal-button-container");
    start.createEl("button", { cls: "mod-cancel", text: t("dialogue.button-cancel") }).addEventListener("click", () => this.close());
    start.createEl("button", { cls: "mod-cta", text: key("label-start-conversion") }).addEventListener("click", () => void this.process());

    const result = this.resultEl = this.contentEl.ownerDocument.createElement("div");
    this.statusEl = result.createEl("p", { cls: "u-center-text" });
    this.processedEl = result.createDiv("changelog-item mod-success");
    this.modifiedEl = result.createDiv("changelog-item mod-highlighted");
    this.failedEl = result.createDiv("changelog-item mod-failed");
    this.renderStats({ processed: 0, modified: 0, failed: 0 });
    const end = result.createDiv("modal-button-container");
    this.cancelEl = end.createEl("button", { cls: "mod-warning", text: key("label-stop") });
    this.cancelEl.addEventListener("click", () => this.cancel());
    this.goBackEl = end.createEl("button", { text: key("label-go-back") });
    this.goBackEl.addEventListener("click", () => this.goBack());
    this.doneEl = end.createEl("button", { cls: "mod-cta", text: key("label-done") });
    this.doneEl.addEventListener("click", () => this.close());
  }

  private renderStats(stats: { processed: number; modified: number; failed: number }): void {
    const key = (name: string) => t(`plugins.markdown-format-importer.${name}`);
    this.processedEl.setText(key("label-processed-files")); this.processedEl.setAttribute("data-label", String(stats.processed));
    this.modifiedEl.setText(key("label-modified-files")); this.modifiedEl.setAttribute("data-label", String(stats.modified));
    this.failedEl.style.display = stats.failed > 0 ? "" : "none";
    this.failedEl.setText(key("label-failed")); this.failedEl.setAttribute("data-label", String(stats.failed));
  }
  private cancel(): void {
    if (!this.running || this.cancelled) return;
    this.cancelled = true;
    this.cancelEl.style.display = "none";
    this.statusEl.setText(t("plugins.markdown-format-importer.label-cancelling"));
  }
  private goBack(): void { this.resultEl.remove(); this.contentEl.append(this.conversionsEl); }
  override onClose(): void { this.cancel(); this.goBack(); }

  private async process(): Promise<void> {
    this.cancelled = false; this.running = true;
    this.conversionsEl.remove(); this.contentEl.append(this.resultEl);
    this.cancelEl.style.display = ""; this.goBackEl.style.display = "none"; this.doneEl.style.display = "none";
    this.statusEl.setText(t("plugins.markdown-format-importer.label-processing"));
    const stats = { processed: 0, modified: 0, failed: 0 };
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.cancelled) break;
      try { await this.app.vault.process(file, text => { const next = migrateFrontmatter(text); if (next !== text) stats.modified++; return next; }); }
      catch (error) { stats.failed++; console.error(error); }
      stats.processed++;
      this.renderStats(stats);
      // Let the dialog repaint and the Stop button respond on large vaults.
      if (stats.processed % 10 === 0) await new Promise(resolve => window.setTimeout(resolve, 0));
    }
    this.running = false;
    this.renderStats(stats);
    this.cancelEl.style.display = "none"; this.goBackEl.style.display = ""; this.doneEl.style.display = "";
    this.statusEl.setText(t("plugins.markdown-format-importer.label-finished"));
  }
}
