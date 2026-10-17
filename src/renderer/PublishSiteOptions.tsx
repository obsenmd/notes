import moment from "moment";
import type { PublishSite, PublishSiteOptions as SiteOptions } from "../compat/publish-client";
import { Modal, Notice } from "../compat/ui";
import { setIcon, setTooltip } from "../compat/utilities";
import { t } from "../i18n";
import { createToggle } from "./core/file-recovery";
import { PublishSection, openExternal, settingHeading, settingRow, type PublishModalHost, type PublishPassword, type PublishService } from "./PublishWorkflow";

const DEFAULT_OPTIONS: SiteOptions = {
  indexFile: "", logo: "", siteName: "", noindex: false, defaultTheme: "light", showThemeToggle: false, showNavigation: true, showGraph: true,
  showOutline: false, showSearch: false, googleAnalytics: "", hideTitle: false, readableLineLength: true, strictLineBreaks: false,
  showHoverPreview: false, showBacklinks: false, slidingWindowMode: false, navigationOrdering: [], navigationHiddenItems: [],
};

const backButton = (parent: HTMLElement, onClick: () => void) => parent.createEl("button", { text: t("plugins.publish.button-go-back") }).addEventListener("click", onClick);

/** Site options: general, appearance, reading experience, components and other settings. */
export class SiteOptionsSection extends PublishSection {
  title = t("plugins.publish.label-site-options");

  override async show(): Promise<void> {
    const { el, parentModal } = this, { plugin } = parentModal;
    el.empty();
    let saved: SiteOptions;
    try { saved = await plugin.apiOptions(); }
    catch (error) {
      parentModal.handleError(error);
      backButton(el.createDiv("modal-button-container"), () => void parentModal.openReviewChanges());
      super.show();
      return;
    }
    const changed: SiteOptions = {}, value = (key: string) => Object.hasOwn(saved, key) ? saved[key] : DEFAULT_OPTIONS[key];
    const container = el.createDiv("publish-site-settings-container");
    const text = (key: string, name: string, description: string, placeholder: string) => {
      const input = settingRow(container, name, description).controlEl.createEl("input", { type: "text", placeholder, attr: { spellcheck: "false" } });
      input.value = String(value(key) ?? "");
      input.addEventListener("input", () => { changed[key] = input.value; });
      return input;
    };
    const toggle = (key: string, name: string, description: string) => {
      const row = settingRow(container, name, description);
      row.settingEl.addClass("mod-toggle");
      const control = createToggle(row.controlEl);
      control.setValue(value(key) === true);
      control.onChange(next => { changed[key] = next; });
    };
    const button = (name: string, description: string, label: string, onClick: () => void) => settingRow(container, name, description).controlEl.createEl("button", { text: label }).addEventListener("click", onClick);

    settingHeading(container, t("plugins.publish.option-site-general"));
    text("siteName", t("plugins.publish.option-site-name"), t("plugins.publish.option-site-name-description"), t("plugins.publish.option-site-name-placeholder"));
    text("indexFile", t("plugins.publish.option-home-page-file"), t("plugins.publish.option-home-page-file-description"), t("plugins.publish.option-home-page-file-placeholder"));
    text("logo", t("plugins.publish.option-logo"), t("plugins.publish.option-logo-description"), t("plugins.publish.option-logo-placeholder"));
    if (!plugin.isGuest) {
      button(t("plugins.publish.option-site-collaboration"), t("plugins.publish.option-site-collaboration-desc"), t("plugins.publish.button-manage-collaborators"), () => {
        const siteId = plugin.siteId ?? "";
        void plugin.getCurrentSlug().then(slug => new CollaboratorsModal(parentModal, slug, siteId).open());
      });
      button(t("plugins.publish.option-custom-domain"), t("plugins.publish.option-custom-domain-desc"), t("plugins.publish.button-configure"), () => void parentModal.openCustomDomain());
      toggle("noindex", t("plugins.publish.option-noindex"), t("plugins.publish.option-noindex-desc"));
    }
    settingHeading(container, t("plugins.publish.option-site-appearance"));
    const theme = settingRow(container, t("plugins.publish.option-theme"), t("plugins.publish.option-theme-description")).controlEl.createEl("select", "dropdown");
    for (const [option, label] of [["light", t("setting.appearance.light-theme")], ["dark", t("setting.appearance.dark-theme")], ["system", t("plugins.publish.option-theme-system")]]) theme.createEl("option", { value: option, text: label });
    theme.value = String(value("defaultTheme"));
    theme.addEventListener("change", () => { changed.defaultTheme = theme.value; });
    toggle("showThemeToggle", t("plugins.publish.option-show-theme-toggle"), t("plugins.publish.option-show-theme-toggle-description"));
    settingHeading(container, t("plugins.publish.option-site-reading-experience"));
    toggle("showHoverPreview", t("plugins.publish.option-hover-preview-file"), t("plugins.publish.option-hover-preview-file-description"));
    toggle("hideTitle", t("plugins.publish.option-hide-title"), t("plugins.publish.option-hide-title-description"));
    toggle("readableLineLength", t("plugins.publish.option-readable-line-length"), t("plugins.publish.option-readable-line-length-description"));
    toggle("strictLineBreaks", t("setting.editor.option-strict-line-break"), t("setting.editor.option-strict-line-break-description"));
    toggle("slidingWindowMode", t("plugins.publish.option-sliding-window-mode"), t("plugins.publish.option-sliding-window-mode-description"));
    settingHeading(container, t("plugins.publish.option-site-components"));
    toggle("showNavigation", t("plugins.publish.option-show-navigation"), t("plugins.publish.option-show-navigation-description"));
    button(t("plugins.publish.option-customize-navigation"), t("plugins.publish.option-customize-navigation-desc"), t("plugins.publish.button-configure"), () => new CustomizeNavigationModal(parentModal).open());
    toggle("showSearch", t("plugins.publish.option-show-search"), t("plugins.publish.option-show-search-description"));
    toggle("showGraph", t("plugins.publish.option-show-graph"), t("plugins.publish.option-show-graph-description"));
    toggle("showOutline", t("plugins.publish.option-show-outline"), t("plugins.publish.option-show-outline-description"));
    toggle("showBacklinks", t("plugins.publish.option-show-backlinks"), t("plugins.publish.option-show-backlinks-description"));
    if (!plugin.isGuest) {
      settingHeading(container, t("plugins.publish.option-site-misc"));
      button(t("plugins.publish.option-site-password"), t("plugins.publish.option-site-password-description"), t("plugins.publish.button-manage-passwords"), () => void parentModal.openPasswords());
      text("googleAnalytics", t("plugins.publish.option-google-analytics"), t("plugins.publish.option-google-analytics-description"), "UA-XXXXX-Y or G-XXXXXXXX").style.width = "200px";
    }
    const buttons = el.createDiv("modal-button-container");
    buttons.createEl("button", { text: t("plugins.publish.button-save-site-settings"), cls: "mod-cta" }).addEventListener("click", () => {
      void plugin.apiOptions(changed).then(() => { new Notice(t("plugins.publish.msg-updated-options")); return parentModal.openReviewChanges(); }, error => parentModal.handleError(error));
    });
    backButton(buttons, () => void parentModal.openReviewChanges());

    super.show();
  }
}

/** Edits the site's navigation order and hidden paths through the authenticated options endpoint. */
class CustomizeNavigationModal extends Modal {
  constructor(private readonly host: PublishModalHost) { super(host.app); }

  override async onOpen(): Promise<void> {
    this.setTitle(t("plugins.publish.option-customize-navigation"));
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: t("plugins.publish.label-navigation-modal-desc") });
    const list = contentEl.createDiv("publish-navigation-order-list");
    const buttons = this.modalEl.createDiv("modal-button-container");
    const save = buttons.createEl("button", { cls: "mod-cta", text: t("plugins.publish.button-save-site-settings") });
    buttons.createEl("button", { text: t("dialogue.button-cancel") }).addEventListener("click", () => this.close());
    try {
      const [options, published] = await Promise.all([this.host.plugin.apiOptions(), this.host.plugin.apiList()]);
      const files = published.files.map(file => file.path);
      const paths = new Set<string>(files);
      for (const file of files) {
        let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
        while (parent) { paths.add(parent); parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : ""; }
      }
      const folders = new Set<string>();
      for (const file of files) {
        let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
        while (parent) { folders.add(parent); parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : ""; }
      }
      const currentOrder = Array.isArray(options.navigationOrdering) ? options.navigationOrdering.filter((path): path is string => typeof path === "string") : [];
      const currentHidden = new Set(Array.isArray(options.navigationHiddenItems) ? options.navigationHiddenItems.filter((path): path is string => typeof path === "string") : []);
      const order = [...currentOrder.filter(path => paths.has(path)), ...[...paths].filter(path => !currentOrder.includes(path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))];
      const render = () => {
        list.replaceChildren();
        order.forEach((path, index) => {
          const row = list.createDiv("list-item publish-navigation-item"), check = row.createEl("input", { type: "checkbox", attr: { "aria-label": t("plugins.publish.option-hide-in-navigation") } });
          row.draggable = true;
          check.checked = currentHidden.has(path);
          row.createDiv({ cls: "list-item-part mod-extended", text: `${folders.has(path) ? "▸ " : ""}${path}` });
          check.addEventListener("change", () => { if (check.checked) currentHidden.add(path); else currentHidden.delete(path); });
          const move = (delta: number) => {
            const target = index + delta;
            if (target < 0 || target >= order.length) return;
            [order[index], order[target]] = [order[target]!, order[index]!]; render();
          };
          const up = row.createEl("button", { text: "↑", attr: { "aria-label": t("plugins.publish.label-move-navigation-up"), disabled: index === 0 } });
          up.addEventListener("click", () => move(-1));
          const down = row.createEl("button", { text: "↓", attr: { "aria-label": t("plugins.publish.label-move-navigation-down"), disabled: index === order.length - 1 } });
          down.addEventListener("click", () => move(1));
          row.addEventListener("dragstart", event => {
            if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }
          });
          row.addEventListener("dragover", event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; });
          row.addEventListener("drop", event => {
            event.preventDefault();
            const source = Number(event.dataTransfer?.getData("text/plain"));
            if (!Number.isInteger(source) || source < 0 || source >= order.length || source === index) return;
            const [item] = order.splice(source, 1);
            if (item !== undefined) order.splice(index, 0, item);
            render();
          });
        });
      };
      render();
      save.addEventListener("click", () => {
        save.disabled = true;
        void this.host.plugin.apiOptions({ navigationOrdering: order, navigationHiddenItems: [...currentHidden] })
          .then(() => { new Notice(t("plugins.publish.msg-updated-options")); this.close(); })
          .catch(error => { save.disabled = false; this.host.handleError(error); });
      });
    } catch (error) { this.host.handleError(error); }
  }
}

/** Publish filters: folders whose files are selected automatically, and folders left out. */
export class SiteFiltersSection extends PublishSection {
  title = t("plugins.publish.label-site-options");

  override show(): void {
    const { el, parentModal } = this, { plugin } = parentModal;
    el.empty();
    const container = el.createDiv("publish-site-settings-container");
    const row = (name: string, description: string, current: string, paths: string[], open: () => void) => {
      const fragment = document.createDocumentFragment();
      fragment.append(description);
      if (paths.length) { fragment.append(current); const list = fragment.createEl("ul"); for (const path of paths) list.createEl("li", { text: path }); }
      settingRow(container, name, fragment).controlEl.createEl("button", { text: t("interface.button-manage") }).addEventListener("click", open);
    };
    row(t("plugins.publish.option-included-folders"), t("plugins.publish.option-included-folders-desc"), t("plugins.publish.option-currently-included-folders"), plugin.includes, () => new FolderListModal(parentModal, {
      title: t("plugins.publish.label-manage-included-folders"), name: t("plugins.publish.label-add-included-folder"), description: t("plugins.publish.label-add-included-folder-desc"),
      labelKey: "plugins.publish.label-number-of-folders-included", get: () => plugin.includes, set: paths => plugin.setIncludes(paths), onClose: () => this.show(),
    }).open());
    row(t("plugins.publish.option-excluded-folders"), t("plugins.publish.option-excluded-folders-desc"), t("plugins.sync.option-currently-excluded-folders"), plugin.excludes, () => new FolderListModal(parentModal, {
      title: t("plugins.sync.label-manage-excluded-folders"), name: t("plugins.sync.label-add-excluded-folder"), description: t("plugins.sync.label-add-excluded-folder-desc"),
      labelKey: "plugins.publish.label-number-of-folders-excluded", get: () => plugin.excludes, set: paths => plugin.setExcludes(paths), onClose: () => this.show(),
    }).open());
    el.createDiv("modal-button-container").createEl("button", { cls: "mod-cta", text: t("dialogue.button-done") }).addEventListener("click", () => void parentModal.openReviewChanges());
    super.show();
  }
}

interface FolderListOptions { title: string; name: string; description: string; labelKey: string; get(): string[]; set(paths: string[]): Promise<void>; onClose(): void }

/** Editable list of folders (included or excluded). */
class FolderListModal extends Modal {
  private readonly displayEl: HTMLElement;
  constructor(host: PublishModalHost, private readonly options: FolderListOptions) {
    super(host.app);
    this.setTitle(options.title);
    this.displayEl = this.contentEl.createEl("p");
    const input = settingRow(this.contentEl, options.name, options.description).controlEl.createEl("input", { type: "text", attr: { spellcheck: "false" } });
    const folders = () => host.app.vault.getAllFolders().map(folder => folder.path).filter(path => !options.get().includes(path));
    const list = this.contentEl.createEl("datalist"); list.id = `publish-folders-${Date.now()}`;
    input.setAttribute("list", list.id);
    input.addEventListener("focus", () => { list.empty(); for (const path of folders()) list.createEl("option", { value: path }); });
    const add = async () => {
      const path = input.value.trim().replace(/^\/+|\/+$/g, "");
      if (!path) return;
      input.value = "";
      if (!options.get().includes(path)) await options.set([...options.get(), path]);
      this.updateDisplay();
    };
    input.addEventListener("keydown", event => { if (!event.isComposing && event.key === "Enter") void add(); });
    this.modalEl.createDiv("modal-button-container").createEl("button", { cls: "mod-cancel", text: t("dialogue.button-done") }).addEventListener("click", () => this.close());
  }
  override onOpen(): void { this.updateDisplay(); }
  override onClose(): void { this.options.onClose(); }
  private updateDisplay(): void {
    const paths = this.options.get(), el = this.displayEl;
    el.empty();
    el.setText(t(this.options.labelKey, { folders: t("nouns.folder-with-count", { count: paths.length }) }));
    for (const path of paths) {
      const item = el.createDiv("sync-exclude-folder"), remove = item.createDiv("sync-exclude-folder-remove clickable-icon");
      setIcon(remove, "lucide-x"); setTooltip(remove, t("plugins.sync.tooltip-remove-excluded-folder"));
      remove.addEventListener("click", () => { void this.options.set(this.options.get().filter(entry => entry !== path)).then(() => this.updateDisplay()); });
      setIcon(item.createSpan("clickable-icon"), "lucide-folder-open");
      item.createDiv({ cls: "sync-exclude-folder-name" }).createSpan({ text: path });
    }
  }
}

/** People a site is shared with. */
class CollaboratorsModal extends Modal {
  private readonly plugin: PublishService;
  constructor(host: PublishModalHost, name: string, private readonly siteId: string) {
    super(host.app);
    this.plugin = host.plugin;
    this.setTitle(t("plugins.publish.label-manage-sharing", { name }));
    this.modalEl.createDiv("modal-button-container").createEl("button", { text: t("dialogue.button-done") }).addEventListener("click", () => this.close());
    void this.display();
  }
  private async display(): Promise<void> {
    const { contentEl, plugin, siteId } = this;
    contentEl.empty();
    let shares;
    try { shares = (await plugin.listShares(siteId)).shares ?? []; }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); return; }
    if (shares.length) {
      contentEl.createEl("p", { cls: "u-muted", text: t("plugins.publish.label-sharing-with-users") });
      const list = contentEl.createDiv();
      for (const share of shares) {
        const item = list.createDiv("list-item");
        if (share.name) { item.createDiv({ cls: "list-item-part", text: share.name }); item.createDiv({ cls: "list-item-part mod-extended", text: `<${share.email}>` }); }
        else item.createDiv({ cls: "list-item-part mod-extended", text: share.email });
        if (!share.accepted) item.createDiv({ cls: "list-item-part" }).createSpan({ cls: "u-muted", text: t("plugins.publish.label-invite-pending") });
        const remove = item.createDiv("list-item-part");
        setIcon(remove, "lucide-x"); setTooltip(remove, t("plugins.publish.tooltip-remove-user"));
        remove.addEventListener("click", () => { void plugin.removeShare(siteId, share.uid).catch(error => new Notice(error instanceof Error ? error.message : String(error))).then(() => this.display()); });
      }
    } else contentEl.createEl("p", { cls: "u-muted", text: t("plugins.publish.label-not-sharing") });
    const control = settingRow(contentEl, t("plugins.publish.option-invite-user")).controlEl;
    const input = control.createEl("input", { type: "text", placeholder: t("plugins.publish.placeholder-invite-user") });
    const invite = () => {
      const email = input.value.trim();
      if (!email || !email.includes("@")) { new Notice(t("plugins.publish.error-email-must-be-valid")); return; }
      void plugin.inviteShare(siteId, email).catch(error => new Notice(error instanceof Error ? error.message : String(error))).then(() => this.display());
    };
    input.addEventListener("keydown", event => { if (!event.isComposing && event.key === "Enter") invite(); });
    control.createEl("button", { cls: "mod-cta", text: t("interface.button-add") }).addEventListener("click", invite);
  }
}

/** Change a site's ID (its public slug). */
export class EditSiteSlugSection extends PublishSection {
  title = t("plugins.publish.tooltip-edit-site-id");
  private site: PublishSite | null = null;
  private readonly slugInputEl: HTMLInputElement;

  constructor(parentModal: PublishModalHost) {
    super(parentModal);
    const row = settingRow(this.el, t("plugins.publish.option-site-id"), t("plugins.publish.option-site-id-description"));
    row.settingEl.addClass("site-list-site-id-setting");
    this.slugInputEl = row.controlEl.createEl("input", { type: "text", placeholder: t("plugins.publish.option-site-id-placeholder"), attr: { spellcheck: "false" } });
    const buttons = this.el.createEl("p", "modal-button-container");
    buttons.createEl("button", { cls: "mod-cta", text: t("plugins.publish.button-change") }).addEventListener("click", () => {
      if (!this.site) return;
      void parentModal.plugin.setSlug(this.site, this.slugInputEl.value.toLowerCase()).then(() => parentModal.openSiteOptions(), error => parentModal.handleError(error));
    });
    buttons.createEl("button", { text: t("dialogue.button-cancel") }).addEventListener("click", () => void parentModal.openManageSites());
  }
  setSite(site: PublishSite, slug: string): void { this.site = site; this.slugInputEl.value = slug; }
}

/** Passwords protecting the site. */
export class ListPasswordSection extends PublishSection {
  title = t("plugins.publish.label-manage-passwords");

  override async show(): Promise<void> {
    const { el, parentModal } = this;
    let passwords: PublishPassword[] | null;
    try { passwords = (await parentModal.plugin.apiGetPassword()).pass ?? null; }
    catch (error) { parentModal.handleError(error); return; }
    el.empty();
    if (passwords === null) el.createEl("p", { cls: "u-muted", text: t("plugins.publish.label-no-password") });
    else {
      el.createEl("p", { cls: "u-muted", text: t("plugins.publish.label-have-password") });
      el.createEl("hr");
      const container = el.createDiv("passwords-container");
      passwords.forEach((password, index) => {
        const item = container.createDiv("list-item password-item");
        item.createDiv({ cls: "list-item-part", text: password.name || t("plugins.publish.label-untitled-password") });
        item.createDiv({ cls: "u-muted u-small list-item-part mod-extended", text: t("plugins.publish.label-password-created-time", { time: moment(password.ts).fromNow() }) });
        const remove = item.createDiv("list-item-part clickable-icon");
        setIcon(remove, "lucide-x"); setTooltip(remove, t("dialogue.button-delete"));
        remove.addEventListener("click", () => { void parentModal.plugin.apiDelPassword(index).then(() => parentModal.openPasswords(), error => parentModal.handleError(error)); });
      });
    }
    const buttons = el.createDiv("modal-button-container");
    buttons.createEl("button", { cls: "mod-cta", text: t("plugins.publish.action-new-password") }).addEventListener("click", () => void parentModal.openAddPassword());
    backButton(buttons, () => void parentModal.openSiteOptions());
    super.show();
  }
}

export class AddPasswordSection extends PublishSection {
  title = t("plugins.publish.label-add-password");
  private readonly passwordFieldEl: HTMLInputElement;
  private readonly nicknameFieldEl: HTMLInputElement;

  constructor(parentModal: PublishModalHost) {
    super(parentModal);
    this.passwordFieldEl = settingRow(this.el, t("plugins.publish.option-password-name"), t("plugins.publish.option-password-desc")).controlEl.createEl("input", { type: "password", placeholder: t("plugins.publish.option-password-placeholder") });
    this.nicknameFieldEl = settingRow(this.el, t("plugins.publish.option-nickname-name"), t("plugins.publish.option-nickname-desc")).controlEl.createEl("input", { type: "text" });
    const buttons = this.el.createDiv("modal-button-container");
    buttons.createEl("button", { text: t("plugins.publish.action-add-password"), cls: "mod-cta" }).addEventListener("click", () => {
      void parentModal.plugin.apiAddPassword(this.nicknameFieldEl.value, this.passwordFieldEl.value).then(() => { new Notice(t("plugins.publish.msg-added-new-password")); return parentModal.openPasswords(); }, error => parentModal.handleError(error));
    });
    backButton(buttons, () => void parentModal.openPasswords());
  }
  override show(): void { this.passwordFieldEl.value = ""; this.nicknameFieldEl.value = ""; super.show(); }
}

export class CustomDomainSection extends PublishSection {
  title = t("plugins.publish.label-configure-custom-domain");

  override async show(): Promise<void> {
    const { el, parentModal } = this;
    el.empty();
    super.show();
    let current: { url?: string; redirect?: boolean };
    try { current = await parentModal.plugin.apiCustomUrl(); }
    catch (error) { parentModal.handleError(error); backButton(el.createDiv("modal-button-container"), () => void parentModal.openSiteOptions()); return; }
    const url = settingRow(el, t("plugins.publish.option-custom-url-name"), t("plugins.publish.option-custom-url-desc")).controlEl.createEl("input", { type: "text", placeholder: "example.com", attr: { spellcheck: "false" } });
    url.value = current.url || "";
    const redirectRow = settingRow(el, t("plugins.publish.option-custom-url-redirect"), t("plugins.publish.option-custom-url-redirect-desc"));
    redirectRow.settingEl.addClass("mod-toggle");
    const redirect = createToggle(redirectRow.controlEl);
    redirect.setValue(current.redirect === true);
    // The sentence carries the link's position as `{{link}}`.
    const [before, after = ""] = t("plugins.publish.label-custom-domain-instructions", { link: "\u0000" }).split("\u0000");
    const note = el.createEl("p", { cls: "u-muted" });
    note.append(before);
    note.createEl("a", { text: t("plugins.publish.label-custom-domain-link-name") }).addEventListener("click", event => { event.preventDefault(); openExternal("https://help.obsidian.md/publish/domains"); });
    note.append(after);
    const buttons = el.createDiv("modal-button-container");
    buttons.createEl("button", { text: t("plugins.publish.button-update-custom-domain"), cls: "mod-cta" }).addEventListener("click", () => {
      void parentModal.plugin.apiCustomUrl(url.value, redirect.getValue()).then(() => parentModal.openSiteOptions(), error => parentModal.handleError(error));
    });
    backButton(buttons, () => void parentModal.openSiteOptions());
  }
}
