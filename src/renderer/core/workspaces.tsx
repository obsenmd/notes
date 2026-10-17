import moment from "moment";
import type { App } from "../../compat/plugin";
import { FuzzySuggestModal, renderMatches, type FuzzyMatch } from "../../compat/suggest";
import { Modal, Notice } from "../../compat/ui";
import { setIcon, setTooltip } from "../../compat/utilities";
import { t } from "../../i18n";
import { readCorePluginData, writeCorePluginData } from "../core-plugins";
import type { CorePluginContext, CorePluginModule } from "./types";

type Layout = Record<string, unknown> & { mtime?: string };

/** Saved layouts, stored in `.obsidian/workspaces.json` as `{ workspaces: { name: layout }, active: name }`. */
class WorkspaceLayouts {
  workspaces: Record<string, Layout> = {};
  activeWorkspace = "";
  private writing: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(readonly app: App, private readonly configDir: string) {
    this.ready = readCorePluginData(configDir, "workspaces").then(data => {
      const saved = data.workspaces;
      this.workspaces = saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, Layout> : {};
      this.activeWorkspace = typeof data.active === "string" ? data.active : "";
    }).catch(error => { console.error(error); });
  }

  has(name: string): boolean { return Object.hasOwn(this.workspaces, name); }
  names(): string[] { return Object.keys(this.workspaces); }

  saveData(): Promise<void> {
    const data = { workspaces: this.workspaces, active: this.activeWorkspace };
    this.writing = this.writing.catch(() => undefined).then(() => writeCorePluginData(this.configDir, "workspaces", data));
    return this.writing;
  }
  saveWorkspace(name: string): void {
    const layout = JSON.parse(JSON.stringify(this.app.workspace.getLayout())) as Layout;
    layout.mtime = moment().format();
    this.workspaces[name] = layout;
    void this.saveData();
  }
  setActiveWorkspace(name: string): void { this.activeWorkspace = name; void this.saveData(); }
  async loadWorkspace(name: string): Promise<void> {
    if (!this.has(name)) return;
    this.activeWorkspace = name;
    // The modification time belongs to the saved entry, not to the workspace's own layout file.
    const { mtime: _mtime, ...layout } = this.workspaces[name];
    await this.app.workspace.changeLayout(JSON.parse(JSON.stringify(layout)));
    await this.saveData();
  }
  async deleteWorkspace(name: string): Promise<void> { delete this.workspaces[name]; await this.saveData(); }
}

const activeFlair = (parent: HTMLElement) => parent.createSpan({ cls: "flair mod-pop", text: t("setting.appearance.label-currently-active") });

/** "Manage workspace layouts": save the current layout under a name, load or delete saved ones. */
class ManageWorkspacesModal extends Modal {
  private readonly nameEl: HTMLInputElement;
  private readonly listContainerEl: HTMLElement;

  constructor(app: App, private readonly layouts: WorkspaceLayouts) {
    super(app);
    this.titleEl.setText(t("plugins.workspaces.action-manage-layouts"));
    const row = this.contentEl.createDiv("list-item");
    const input = this.nameEl = row.createEl("input", { cls: "list-item-part mod-extended", type: "text" });
    input.placeholder = t("plugins.workspaces.placeholder-save-current-layout-as");
    input.addEventListener("keypress", event => { if (!event.isComposing && event.key === "Enter") this.onFinish(); });
    const save = row.createEl("button", { cls: "list-item-part", text: t("plugins.workspaces.button-save") });
    save.addEventListener("mousedown", event => event.preventDefault());
    save.addEventListener("click", () => this.onFinish());
    this.listContainerEl = this.contentEl.createDiv("list-container mod-manage-workspaces");
    this.renderList();
  }

  override onOpen(): void { this.nameEl.focus(); void this.layouts.ready.then(() => this.renderList()); }

  private renderList(): void {
    const { layouts, listContainerEl } = this;
    listContainerEl.empty();
    for (const name of layouts.names()) {
      const layout = layouts.workspaces[name], item = listContainerEl.createDiv("list-item");
      const info = item.createDiv("list-item-part mod-extended");
      info.createSpan({ text: name });
      if (name === layouts.activeWorkspace) activeFlair(info);
      const description = info.createDiv("list-item-desc");
      if (layout?.mtime) description.createDiv({ cls: "list-item-part", text: t("plugins.workspaces.label-workspace-modified-time", { time: moment(layout.mtime).fromNow() }) });
      const actions = item.createDiv("list-item-actions");
      actions.createEl("button", { cls: "list-item-part", text: t("plugins.workspaces.button-load") })
        .addEventListener("click", () => { void layouts.loadWorkspace(name).catch(error => { console.error(error); new Notice(t("obsen.workspaces.error-load")); }); this.close(); });
      const remove = actions.createDiv("list-item-part clickable-icon");
      setIcon(remove, "lucide-x");
      setTooltip(remove, t("plugins.workspaces.tooltip-delete-layout"));
      remove.addEventListener("mousedown", event => event.preventDefault());
      remove.addEventListener("click", () => { void layouts.deleteWorkspace(name).then(() => this.renderList()); });
    }
  }

  private onFinish(): void {
    const name = this.nameEl.value.trim();
    if (!name) { new Notice(t("plugins.workspaces.msg-enter-name")); return; }
    this.layouts.saveWorkspace(name);
    this.layouts.setActiveWorkspace(name);
    new Notice(t("plugins.workspaces.msg-save-layout-success", { name }));
    this.nameEl.value = "";
    this.renderList();
  }
}

/** Prompt listing the saved layouts; optionally saves the active one before switching. */
class LoadWorkspaceModal extends FuzzySuggestModal<string> {
  constructor(app: App, private readonly layouts: WorkspaceLayouts, private readonly shouldSave: boolean) {
    super(app);
    this.emptyStateText = t("plugins.workspaces.label-no-layout-found");
    this.setPlaceholder(t("plugins.workspaces.placeholder-type-to-search-layouts"));
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.command-palette.instruction-navigate") },
      { command: "↵", purpose: t("plugins.command-palette.instruction-use") },
      { command: "esc", purpose: t("plugins.command-palette.instruction-dismiss") },
    ]);
  }
  getItems(): string[] { return this.layouts.names(); }
  getItemText(name: string): string { return name; }
  override renderSuggestion(value: FuzzyMatch<string>, el: HTMLElement): void {
    renderMatches(el, value.item, value.match?.matches);
    if (value.item === this.layouts.activeWorkspace) activeFlair(el);
  }
  onChooseItem(name: string): void {
    const { layouts } = this;
    if (this.shouldSave && layouts.activeWorkspace && layouts.has(layouts.activeWorkspace)) layouts.saveWorkspace(layouts.activeWorkspace);
    void layouts.loadWorkspace(name).catch(error => { console.error(error); new Notice(t("obsen.workspaces.error-load")); });
  }
}

const stores = new WeakMap<App, WorkspaceLayouts>();
function layoutsOf({ app, configDir }: CorePluginContext): WorkspaceLayouts {
  let store = stores.get(app);
  if (!store) stores.set(app, store = new WorkspaceLayouts(app, configDir));
  return store;
}

const openModal = (context: CorePluginContext) => new ManageWorkspacesModal(context.app, layoutsOf(context)).open();
const openLoader = async (context: CorePluginContext, save: boolean) => { const layouts = layoutsOf(context); await layouts.ready; new LoadWorkspaceModal(context.app, layouts, save).open(); };
async function saveActive(context: CorePluginContext): Promise<void> {
  const layouts = layoutsOf(context);
  await layouts.ready;
  const name = layouts.activeWorkspace;
  if (!name) { openModal(context); return; }
  if (!layouts.has(name)) return;
  layouts.saveWorkspace(name);
  new Notice(t("plugins.workspaces.msg-save-layout-success", { name }));
}

export const workspacesPlugin: CorePluginModule = {
  id: "workspaces",
  commands: context => [
    { id: "workspaces:load", run: () => openLoader(context, false) },
    { id: "workspaces:save", run: () => saveActive(context) },
    { id: "workspaces:save-and-load", run: () => openLoader(context, true) },
    { id: "workspaces:open-modal", run: () => openModal(context) },
  ],
  ribbon: context => [{ id: "workspaces", icon: "lucide-layout", title: t("plugins.workspaces.action-manage-layouts"), onClick: () => openModal(context) }],
  install(context) {
    layoutsOf(context);
    // Every change is written as it happens; dropping the store makes the next enable read the file afresh.
    return () => { stores.delete(context.app); };
  },
};
