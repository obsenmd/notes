import type { App } from "../compat/plugin";
import { PublishRequestError, type PublishSite, type PublishSiteList } from "../compat/publish-client";
import { Modal } from "../compat/ui";
import { setIcon, setTooltip } from "../compat/utilities";
import { t } from "../i18n";
import { confirmModal } from "./core/file-recovery";
import { AddPasswordSection, CustomDomainSection, EditSiteSlugSection, ListPasswordSection, SiteFiltersSection, SiteOptionsSection } from "./PublishSiteOptions";
import { PublishSection, PublishService, ReviewChangesSection, UploadProgressSection, openExternal, settingHeading, settingRow, type PublishChange, type PublishModalHost } from "./PublishWorkflow";
import type { SettingsEnvironment } from "./settings/controls";

const ACCOUNT_URL = "https://obsidian.md/account";

class OfflineSection extends PublishSection {
  constructor(parentModal: PublishModalHost) { super(parentModal); this.el.createEl("p", { text: t("plugins.publish.label-no-internet-access") }); }
}

class NoAccountSection extends PublishSection {
  constructor(parentModal: PublishModalHost, openLogin: () => void) {
    super(parentModal);
    this.el.createEl("p", { text: t("plugins.publish.label-publish-service-description") });
    this.el.createEl("p", { text: t("plugins.publish.label-please-login") });
    const buttons = this.el.createDiv("modal-button-container");
    buttons.createEl("button", { cls: "mod-cta", text: t("setting.account.link-sign-up-now") }).addEventListener("click", () => openExternal(ACCOUNT_URL));
    buttons.createEl("button", { text: t("setting.account.button-login") }).addEventListener("click", () => { parentModal.close(); openLogin(); });
  }
}

/** Sites of the account: choose, rename, delete, or create one. */
class ManageSitesSection extends PublishSection {
  title = t("plugins.publish.label-manage-sites");
  private slugInputEl: HTMLInputElement | null = null;
  constructor(parentModal: PublishModalHost, private readonly modal: PublishModal) { super(parentModal); }

  override async show(): Promise<void> {
    const { parentModal, el, modal } = this, { plugin, app } = parentModal;
    el.empty();
    let listing: PublishSiteList;
    try { listing = await plugin.listSites(); }
    catch (error) { parentModal.handleError(error); return; }
    const { sites, shared, limit } = listing;
    settingHeading(el, t("plugins.publish.label-your-sites"));
    const container = el.createDiv("site-list-container");
    let slugs: Record<string, string> = {};
    try { slugs = await plugin.slugs([...sites, ...shared].map(site => site.id)); } catch (error) { console.error(error); }
    const choose = (item: HTMLElement, site: PublishSite) => item.createEl("button", { text: t("plugins.publish.button-choose") }).addEventListener("click", () => {
      void plugin.setup(site.id, site.host).then(() => parentModal.openReviewChanges(), error => parentModal.handleError(error));
    });
    const icon = (item: HTMLElement, name: string, tooltip: string, onClick: () => void) => { const button = item.createDiv("clickable-icon"); setIcon(button, name); setTooltip(button, tooltip); button.addEventListener("click", onClick); };
    if (!sites.length && limit !== 0) container.createDiv("site-empty-state u-center-text").createEl("p", { text: t("plugins.publish.label-no-sites") });
    else for (const site of sites) {
      const item = container.createDiv("site-list-item list-item"), name = slugs[site.id] || site.id;
      item.createDiv({ cls: "list-item-part mod-extended", text: name });
      choose(item, site);
      icon(item, "lucide-edit-3", t("plugins.publish.tooltip-edit-site-id"), () => void modal.editSlug(site, slugs[site.id] || ""));
      icon(item, "lucide-x", t("plugins.publish.tooltip-delete-site"), () => {
        void confirmModal(app, {
          title: t("plugins.publish.label-confirm-delete-site", { site: name }), cta: t("dialogue.button-delete"), destructive: true,
          body: body => { body.createEl("p", { text: t("plugins.publish.label-delete-site-confirmation") }); body.createEl("p", { cls: "setting-message mod-warning", text: t("plugins.publish.label-delete-site-details") }); },
        }).then(confirmed => { if (confirmed) void modal.deleteSite(site.id); });
      });
    }
    if (sites.length < limit) {
      const row = settingRow(el, t("plugins.publish.option-site-id"), t("plugins.publish.option-site-id-description"));
      row.settingEl.addClass("site-list-site-id-setting");
      const input = this.slugInputEl = row.controlEl.createEl("input", { type: "text", placeholder: t("plugins.publish.option-site-id-placeholder"), attr: { spellcheck: "false" } });
      input.addEventListener("keydown", event => { if (!event.isComposing && event.key === "Enter") void this.createSite(); });
      el.createDiv("u-center-text").createEl("button", { text: t("plugins.publish.button-create"), cls: "mod-cta" }).addEventListener("click", () => void this.createSite());
    } else {
      const item = container.createDiv("list-item");
      item.createDiv({ cls: "list-item-part mod-extended u-muted", text: limit === 0 ? t("plugins.publish.label-no-sites-bought") : t("plugins.publish.label-site-usage", { site: String(sites.length), limit: t("nouns.site-with-count", { count: limit }) }) });
      item.createEl("button", { cls: "list-item-part mod-cta", text: t(limit === 0 ? "plugins.publish.button-get-site" : "plugins.publish.button-add-more-sites") }).addEventListener("click", () => openExternal(ACCOUNT_URL));
    }
    if (shared.length) {
      settingHeading(el, t("plugins.publish.label-sites-shared-with-you"));
      const sharedContainer = el.createDiv("site-list-container");
      for (const site of shared) {
        const item = sharedContainer.createDiv("site-list-item list-item"), name = slugs[site.id] || site.id;
        item.createDiv({ cls: "list-item-part mod-extended", text: name });
        choose(item, site);
        icon(item, "lucide-x", t("plugins.publish.tooltip-leave-site-sharing"), () => {
          void confirmModal(app, {
            title: t("plugins.publish.label-leave-site-confirmation", { site: name }), cta: t("plugins.publish.button-leave"), destructive: true,
            body: body => { body.createEl("p", { cls: "setting-message mod-warning", text: t("plugins.publish.label-leave-site-confirmation-details") }); body.createEl("p", { text: t("plugins.publish.label-leave-site-confirmation-details-2") }); },
          }).then(confirmed => { if (confirmed) void modal.deleteSiteShare(site.id, site.share_uid ?? ""); });
        });
      }
    }
    super.show();
  }

  private async createSite(): Promise<void> {
    const { parentModal } = this, { plugin } = parentModal, slug = (this.slugInputEl?.value ?? "").toLowerCase();
    parentModal.hideError();
    if (!/^[a-z0-9-]+$/.test(slug)) { parentModal.showError(t("plugins.publish.msg-invalid-site-id")); return; }
    try { await plugin.checkSlug(slug); }
    catch (error) {
      if (error instanceof PublishRequestError && error.code === "SLUGINUSE") parentModal.showError(t("plugins.publish.msg-site-id-in-use")); else parentModal.handleError(error);
      return;
    }
    try {
      const site = await plugin.createSite();
      await plugin.setSlug(site, slug);
      await plugin.setup(site.id, site.host);
      await parentModal.openReviewChanges();
    } catch (error) { parentModal.handleError(error); }
  }
}

/** The "Publish changes" dialog: one visible section at a time over a shared error line and loader. */
export class PublishModal extends Modal implements PublishModalHost {
  private readonly errorMessageEl: HTMLElement;
  private readonly loaderEl: HTMLElement;
  private currentSection: PublishSection | null = null;
  private autoLoadSection: PublishSection | null = null;
  private readonly offlineSection: PublishSection;
  private readonly noAccountSection: PublishSection;
  private readonly manageSitesSection: ManageSitesSection;
  private readonly siteOptionsSection: SiteOptionsSection;
  private readonly siteFiltersSection: SiteFiltersSection;
  readonly reviewChangesSection: ReviewChangesSection;
  readonly uploadProgressSection: UploadProgressSection;
  private readonly editSiteSlugSection: EditSiteSlugSection;
  private readonly listPasswordSection: ListPasswordSection;
  private readonly addPasswordSection: AddPasswordSection;
  private readonly customDomainSection: CustomDomainSection;

  constructor(app: App, readonly plugin: PublishService, openLogin: () => void) {
    super(app);
    this.modalEl.addClass("mod-publish", "mod-lg", "mod-scrollable-content");
    this.setTitle(t("plugins.publish.action-publish-changes"));
    this.errorMessageEl = this.contentEl.createDiv("message-container").createDiv("message mod-error");
    this.errorMessageEl.style.display = "none";
    this.offlineSection = new OfflineSection(this);
    const loader = this.loaderEl = this.contentEl.createDiv("loader-cube");
    for (let cube = 1; cube <= 9; cube++) loader.createDiv({ cls: `sk-cube sk-cube${cube}` });
    loader.style.display = "none";
    this.noAccountSection = new NoAccountSection(this, openLogin);
    this.manageSitesSection = new ManageSitesSection(this, this);
    this.siteOptionsSection = new SiteOptionsSection(this);
    this.siteFiltersSection = new SiteFiltersSection(this);
    this.reviewChangesSection = new ReviewChangesSection(this);
    this.uploadProgressSection = new UploadProgressSection(this);
    this.editSiteSlugSection = new EditSiteSlugSection(this);
    this.listPasswordSection = new ListPasswordSection(this);
    this.addPasswordSection = new AddPasswordSection(this);
    this.customDomainSection = new CustomDomainSection(this);
  }

  handleError(error: unknown): void {
    console.error(error);
    this.loaderEl.style.display = "none";
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PublishRequestError && error.code === "AUTHFAIL") { void this.openSection(this.manageSitesSection); this.showError(t("plugins.publish.msg-no-permission-to-publish-to-site")); }
    else if (error instanceof PublishRequestError && error.code === "NET") this.showError(`${t("plugins.publish.msg-network-error")} ${message}`);
    else if (error instanceof PublishRequestError) this.showError(message);
    else this.showError(`${t("plugins.publish.msg-something-went-wrong")} ${message}`);
  }
  showError(message: string): void { this.errorMessageEl.setText(message); this.errorMessageEl.style.display = ""; }
  hideError(): void { this.errorMessageEl.style.display = "none"; }

  override async onOpen(): Promise<void> {
    const { plugin } = this;
    this.closeSection();
    this.loaderEl.style.display = "";
    await plugin.load();
    if (!plugin.token) { await this.openSection(this.noAccountSection); return; }
    try { await plugin.checkAccount(); }
    catch (error) { await this.openSection(error instanceof Error && ["Not logged in", t("obsen.account.error-not-logged-in")].some(text => error.message.includes(text)) ? this.noAccountSection : this.offlineSection); return; }
    if (!plugin.siteId) { await this.openSection(this.manageSitesSection); return; }
    const section = this.autoLoadSection;
    this.autoLoadSection = null;
    await this.openSection(section ?? this.reviewChangesSection);
  }

  /** Opens straight to the upload of the given changes the next time the dialog opens. */
  autoUpload(changes: PublishChange[]): void { this.uploadProgressSection.addChanges(changes); this.autoLoadSection = this.uploadProgressSection; }

  async deleteSite(siteId: string): Promise<void> {
    try { await this.plugin.deleteSite(siteId); if (this.plugin.siteId === siteId) await this.plugin.setup(null, null); await this.openSection(this.manageSitesSection); }
    catch (error) { this.handleError(error); }
  }
  async deleteSiteShare(siteId: string, shareId: string): Promise<void> {
    try { await this.plugin.removeShare(siteId, shareId); if (this.plugin.siteId === siteId) await this.plugin.setup(null, null); await this.openSection(this.manageSitesSection); }
    catch (error) { this.handleError(error); }
  }
  editSlug(site: PublishSite, slug: string): Promise<void> { this.editSiteSlugSection.setSite(site, slug); return this.openSection(this.editSiteSlugSection); }

  openReviewChanges(): Promise<void> { return this.openSection(this.reviewChangesSection); }
  openManageSites(): Promise<void> { return this.openSection(this.manageSitesSection); }
  openSiteOptions(): Promise<void> { return this.openSection(this.siteOptionsSection); }
  openSiteFilters(): Promise<void> { return this.openSection(this.siteFiltersSection); }
  openPasswords(): Promise<void> { return this.openSection(this.listPasswordSection); }
  openAddPassword(): Promise<void> { return this.openSection(this.addPasswordSection); }
  openCustomDomain(): Promise<void> { return this.openSection(this.customDomainSection); }
  uploadChanges(changes: PublishChange[]): Promise<void> { this.uploadProgressSection.addChanges(changes); return this.openSection(this.uploadProgressSection); }
  async refreshReview(): Promise<void> { if (this.currentSection === this.reviewChangesSection) await this.reviewChangesSection.show(); }

  private closeSection(): void { this.hideError(); this.currentSection?.hide(); this.currentSection = null; }
  private async openSection(section: PublishSection): Promise<void> {
    this.closeSection();
    if (section.title) this.setTitle(section.title);
    this.currentSection = section;
    this.loaderEl.style.display = "";
    try { await section.show(); } catch (error) { this.handleError(error); }
    this.loaderEl.style.display = "none";
  }
}

const services = new WeakMap<App, PublishService>();
/** The vault's Publish state (site, filters) shared by the dialog and the commands. */
export function getPublishService(app: App, configDir: string): PublishService {
  let service = services.get(app);
  if (!service) { services.set(app, service = new PublishService(app, configDir)); void service.load(); }
  return service;
}

let openModal: PublishModal | null = null;
/** Opens the "Publish changes" dialog; with `upload`, straight on the upload of those changes. */
export function openPublishModal<E extends Pick<SettingsEnvironment, "host" | "config" | "actions">>(environment: E, upload?: PublishChange[]): void {
  const app = environment.host.app;
  openModal?.close();
  const modal = openModal = new PublishModal(app, getPublishService(app, environment.config.configDir), () => environment.actions.openSettings("about"));
  modal.setCloseCallback(() => { if (openModal === modal) openModal = null; });
  if (upload) modal.autoUpload(upload);
  modal.open();
}
