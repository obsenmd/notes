import { process } from "../../platforms/platform";
import { TextFileView } from "../compat/file-views";
import { Component } from "../compat/component";
import { MarkdownPreviewRenderer, MarkdownRenderChild, type MarkdownPostProcessor } from "../compat/markdown";
import type { App } from "../compat/plugin";
import { TFile } from "../compat/vault";
import { chooseItem } from "../controllers/dialogs";
import { t } from "../i18n";
import { MarkdownView } from "../compat/markdown-view";
import { BasesController } from "./bases/controller";
import { BasesQuery } from "./bases/query";
import { TableView } from "./bases/views";

function parseQuery(text: string, file: TFile | null, save: (query: BasesQuery) => void): BasesQuery | Error {
  try {
    const query = BasesQuery.fromString(text);
    query.file = file; query.saveFn = save;
    return query;
  } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

/** The `.base` file view: a query over the vault shown as a table, cards or a list. */
export class BasesFileView extends TextFileView {
  controller: BasesController | null = null;
  private query: BasesQuery | null = null;
  private parsed: BasesQuery | Error | null = null;
  private text = "";
  getViewType() { return "bases"; }
  getIcon() { return this.controller?.getViewRegistrations()[this.controller?.getViewConfig()?.type ?? ""]?.icon ?? "lucide-layout-list"; }
  canAcceptExtension(extension: string) { return extension === "base"; }

  protected onOpen() {
    this.contentEl.replaceChildren();
    this.controller = this.addChild(new BasesController(this.app, this.contentEl, this.file));
    this.controller.onViewChanged = () => { this.app.workspace.notifyLayoutChange(); this.app.workspace.requestSaveLayout(); };
    // The file may have been loaded before the view was opened.
    if (this.parsed) this.controller.setQuery(this.parsed);
  }
  async onClose() {
    await super.onClose();
    if (this.controller) { this.removeChild(this.controller); this.controller = null; }
    this.contentEl.replaceChildren();
  }
  getViewData() { return this.text; }
  setViewData(data: string, clear: boolean) {
    // Our own save comes back through the file watcher; re-parsing it would discard open menus for nothing.
    if (!clear && this.query && data === this.text) return;
    this.text = data;
    const parsed = this.parsed = parseQuery(data, this.file, query => this.onQueryChanged(query));
    this.query = parsed instanceof Error ? null : parsed;
    this.controller?.updateCurrentFile(this.file);
    this.controller?.setQuery(parsed, clear ? "" : undefined);
  }
  clear() { this.text = ""; this.query = null; this.parsed = null; }
  private onQueryChanged(query: BasesQuery): void {
    this.text = query.toString();
    this.controller?.setQuery(query);
    this.requestSave();
  }
  async onRename(file: TFile) { await super.onRename(file); if (this.query) this.query.file = this.file; }
  override onResize(): void { this.controller?.view?.onResize(); }
  override getState(): Record<string, unknown> { return { ...super.getState(), viewName: this.controller?.viewName || undefined }; }
  override async setState(state: unknown, result: Parameters<TextFileView["setState"]>[1]): Promise<void> {
    await super.setState(state, result);
    const viewName = state && typeof state === "object" ? (state as { viewName?: unknown }).viewName : null;
    if (typeof viewName === "string" && viewName && this.query?.getViewConfig(viewName)) this.controller?.selectView(viewName);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands

const activeBase = (app: App): BasesFileView | null => app.workspace.getActiveViewOfType(BasesFileView);
export const defaultBaseBlock = () => `\`\`\`base\nviews:\n  - type: table\n    name: ${JSON.stringify(t("plugins.bases.table.name"))}\n\`\`\`\n`;

/** Handlers for the Bases commands; `check` mirrors the reference's checkCallback. */
export function basesCommands(app: App): Record<string, { check?: () => boolean; run: () => unknown }> {
  const controller = () => activeBase(app)?.controller ?? null;
  return {
    "bases:add-item": { check: () => !!controller()?.query, run: () => controller()?.openNewItem() },
    "bases:add-view": { check: () => !!controller()?.query, run: () => controller()?.promptForAddView() },
    "bases:change-view": {
      check: () => (controller()?.getQueryViewNames().length ?? 0) > 1,
      run: async () => {
        const target = controller();
        if (!target) return;
        const name = await chooseItem(app, target.getQueryViewNames(), item => item, { placeholder: t("plugins.bases.command-change-view") });
        if (name) target.selectView(name);
      },
    },
    "bases:copy-table": { check: () => controller()?.view instanceof TableView, run: () => controller()?.view?.copyToClipboard() },
    "bases:insert": {
      check: () => app.workspace.getActiveViewOfType(MarkdownView)?.getMode() === "source",
      run: async () => {
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const folder = app.fileManager.getNewFileParent(view.file?.path ?? "");
        const prefix = folder.path && folder.path !== "/" ? `${folder.path}/` : "";
        const file = await app.vault.create(app.vault.getAvailablePath(prefix + t("plugins.file-explorer.label-untitled-file"), "base"), "");
        const link = `![[${file.path}]]\n`;
        view.editor.replaceSelection((view.editor.getCursor("from").ch > 0 ? "\n" : "") + link);
      },
    },
  };
}
/** Inserts an empty ```base block at the cursor, on a line of its own. */
export function insertBaseBlock(editor: { replaceSelection(text: string): void; getCursor(side?: "from"): { line: number; ch: number } }): void {
  editor.replaceSelection((editor.getCursor("from").ch > 0 ? "\n" : "") + defaultBaseBlock());
}

// ---------------------------------------------------------------------------------------------------------------------
// Embeds and code blocks

export interface BaseBlockOptions {
  /** The note that contains the block or embed; `this` in formulas refers to it. */
  sourcePath: string;
  /** Persists edits made through the toolbar. Without it they last until the block is re-rendered. */
  save?: (yaml: string) => void | Promise<void>;
  viewName?: string;
}

/** Renders base YAML into `el` (which becomes `.bases-embed`). Add the returned component to a parent, or load/unload it yourself. */
export function renderBase(app: App, source: string, el: HTMLElement, options: BaseBlockOptions, file: TFile | null = null): Component & { controller: BasesController; setSource(source: string): void } {
  el.classList.add("bases-embed", "interactive-child");
  el.replaceChildren();
  class BaseBlock extends Component {
    controller = this.addChild(new BasesController(app, el, app.vault.getFileByPath(options.sourcePath)));
    private text = source;
    private timer: ReturnType<typeof setTimeout> | null = null;
    override onload(): void { this.setSource(source, options.viewName ?? ""); }
    override onunload(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; void options.save?.(this.text); } }
    setSource(next: string, viewName?: string): void {
      this.text = next;
      this.controller.setQuery(parseQuery(next, file, query => {
        this.text = query.toString();
        this.controller.setQuery(query);
        if (!options.save) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void options.save!(this.text); }, 1000);
      }), viewName);
    }
    get source(): string { return this.text; }
  }
  return new BaseBlock();
}

/** `![[file.base]]` / `![[file.base#View]]`: renders a base file and writes toolbar changes back to it. */
export function renderBaseEmbed(app: App, file: TFile, el: HTMLElement, options: { sourcePath: string; subpath?: string }): Component {
  // Markdown embeds are ordinary internal embeds in the reference DOM; Bases adds
  // its own renderer classes when the query view mounts below.
  el.classList.add("internal-embed");
  const viewName = options.subpath?.replace(/^#/, "") ?? "";
  let written = "";
  class BaseEmbed extends Component {
    private block: ReturnType<typeof renderBase> | null = null;
    override onload(): void {
      void app.vault.cachedRead(file).then(text => {
        if (!this.isLoaded()) return;
        this.block = this.addChild(renderBase(app, text, el, { sourcePath: options.sourcePath, viewName, save: async yaml => { written = yaml; await app.vault.modify(file, yaml); } }, file));
        el.classList.add("is-loaded");
      });
      this.registerEvent(app.vault.on("modify", changed => {
        if (changed !== file) return;
        void app.vault.cachedRead(file).then(text => { if (this.isLoaded() && text !== written && this.block) this.block.setSource(text); });
      }));
    }
  }
  return new BaseEmbed();
}

/** Post processor that turns ```base fenced blocks into live bases; edits are written back into the fence. */
export function createBasesCodeBlockProcessor(app: App): MarkdownPostProcessor {
  return MarkdownPreviewRenderer.createCodeBlockPostProcessor("base", (source, pre, ctx) => {
    const info = ctx.getSectionInfo(pre);
    let previous = source;
    const host = pre.ownerDocument.createElement("div");
    host.className = "block-language-base";
    pre.replaceWith(host);
    const save = async (yaml: string) => {
      const note = app.vault.getFileByPath(ctx.sourcePath);
      if (!info || !note) return;
      await app.vault.process(note, data => {
        return updateBaseFence(data, info.lineStart, previous, yaml);
      });
      previous = yaml;
    };
    const child = new MarkdownRenderChild(host);
    child.addChild(renderBase(app, source, host, { sourcePath: ctx.sourcePath, save }));
    ctx.addChild(child);
  });
}

/** Refuse stale positions/content so toolbar edits cannot overwrite another block or a newer edit. */
export function updateBaseFence(data: string, start: number, previous: string, yaml: string): string {
  const newline = data.includes("\r\n") ? "\r\n" : "\n", lines = data.split(/\r?\n/);
  const fence = /^(\s*)(`{3,}|~{3,})\s*base\s*$/.exec(lines[start] ?? "");
  const stale = () => { throw new Error(t("obsen.bases.error-block-changed")); };
  if (!fence) return stale();
  let end = start + 1;
  const close = new RegExp(`^\\s*${fence[2]![0]}{${fence[2]!.length},}\\s*$`);
  while (end < lines.length && !close.test(lines[end]!)) end++;
  if (end === lines.length) return stale();
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const current = lines.slice(start + 1, end).map(line => line.startsWith(fence[1]!) ? line.slice(fence[1]!.length) : line).join("\n");
  if (normalize(current) !== normalize(previous)) return stale();
  lines.splice(start + 1, end - start - 1, ...normalize(yaml).split("\n").map(line => fence[1] + line));
  return lines.join(newline);
}
