import { ipcRenderer, shell } from "../../platforms/platform";
import { AccountClient } from "../compat/account";
import { createDiv } from "../compat/dom";
import type { App } from "../compat/plugin";
import { PublishClient, PublishRequestError, type PublishFileList, type PublishSite, type PublishSiteList, type PublishSiteOptions as SiteOptions } from "../compat/publish-client";
import { Menu, Modal, Notice } from "../compat/ui";
import { setIcon, setTooltip } from "../compat/utilities";
import { TFile, TFolder } from "../compat/vault";
import { t } from "../i18n";
import { readCorePluginData, writeCorePluginData } from "./core-plugins";
import { baseName, confirmModal, createSearchInput, dirName, extensionOf, renderDiff, stripMd } from "./core/file-recovery";

/** Public site origin and slug registry of the Publish service. */
export const PUBLISH_ORIGIN = "https://publish.obsidian.md";
const DEFAULT_ACCOUNT_ORIGIN = "https://api.obsidian.md";
const MAX_FILE_SIZE = 52_428_800;
const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
const PUBLISHABLE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus", "mp4", "webm", "ogv", "mov", "mkv", "pdf", "md", "canvas"]);
const SITE_FILES = ["obsidian.css", "publish.css", "favicon.ico", "publish.js"];

export type PublishChangeType = "new" | "changed" | "deleted" | "to-delete";
export interface PublishChange { path: string; ctime: number; mtime: number; size: number; type: PublishChangeType; checked: boolean }
export interface PublishPassword { name?: string; ts?: number }

const encodePathPart = (part: string) => encodeURIComponent(part).replace(/%20/g, "+");
/** Address of a note on the public site (`IZ(Vl(path))` in the reference). */
export const livePath = (path: string) => stripMd(path).split("/").map(encodePathPart).join("/");
export const openExternal = (url: string) => { void shell.openExternal(url); };

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Publish state of one vault (`publish.json`: siteId, host, included, excluded) and the service calls. */
export class PublishService {
  siteId: string | null = null;
  host: string | null = null;
  isGuest: boolean | null = null;
  includes: string[] = [];
  excludes: string[] = [];
  /** Paths on the site as of the last file listing; null until one succeeded. */
  publishedPaths: Set<string> | null = null;
  private loaded: Promise<void> | null = null;
  private readonly accountOrigin: string = ipcRenderer.sendSync("obsen-server-url") || DEFAULT_ACCOUNT_ORIGIN;
  private readonly registryOrigin = this.accountOrigin === DEFAULT_ACCOUNT_ORIGIN ? PUBLISH_ORIGIN : this.accountOrigin;
  private readonly client = new PublishClient({ accountOrigin: this.accountOrigin, registryOrigin: this.registryOrigin });

  constructor(readonly app: App, private readonly configDir: string) {}

  get token(): string { return new AccountClient({ origin: this.accountOrigin, storage: localStorage }).session?.token ?? ""; }
  private get site(): PublishSite {
    if (!this.siteId || !this.host) throw new PublishRequestError("NOSITE", t("plugins.publish.label-no-sites"));
    return { id: this.siteId, host: this.host };
  }

  load(): Promise<void> {
    return this.loaded ??= readCorePluginData(this.configDir, "publish").then(data => {
      this.siteId = typeof data.siteId === "string" ? data.siteId : null;
      this.host = typeof data.host === "string" ? data.host : null;
      this.includes = Array.isArray(data.included) ? data.included.map(String) : [];
      this.excludes = Array.isArray(data.excluded) ? data.excluded.map(String) : [];
    }).catch(error => { console.error(error); });
  }
  private save(): Promise<void> { return writeCorePluginData(this.configDir, "publish", { siteId: this.siteId, host: this.host, included: this.includes, excluded: this.excludes }); }
  async setup(siteId: string | null, host: string | null): Promise<void> { this.siteId = siteId; this.host = host; this.publishedPaths = null; this.isGuest = null; await this.save(); }
  async setIncludes(paths: string[]): Promise<void> { this.includes = paths; await this.save(); }
  async setExcludes(paths: string[]): Promise<void> { this.excludes = paths; await this.save(); }

  /** Confirms the saved account token still works; throws the service's error otherwise. */
  async checkAccount(): Promise<void> { await new AccountClient({ origin: this.accountOrigin, storage: localStorage }).info(); }

  isFileSupported(file: TFile): boolean { return PUBLISHABLE_EXTENSIONS.has(file.extension.toLowerCase()) || SITE_FILES.includes(file.name); }

  /** The note's `publish` property, else the folder filters; null when nothing decides. */
  getPublishFlag(file: TFile): boolean | null {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return null;
    let flag: unknown = (cache.frontmatter as Record<string, unknown> | undefined)?.publish;
    if (flag !== null && flag !== undefined) {
      if (typeof flag === "string") { flag = flag.toLowerCase(); if (flag === "false" || flag === "no") return false; if (flag === "true" || flag === "yes") return true; }
      return Boolean(flag);
    }
    for (const folder of this.excludes) if (file.path.startsWith(`${folder}/`)) return false;
    for (const folder of this.includes) if (file.path.startsWith(`${folder}/`)) return true;
    return null;
  }

  async getHash(file: TFile): Promise<string> { return sha256(await this.app.vault.readBinary(file)); }

  async scanForChanges(): Promise<PublishChange[]> {
    const vault = this.app.vault, changes: PublishChange[] = [], listing = await this.apiList(), remote = new Set<string>();
    this.isGuest = !listing.owner;
    for (const entry of listing.files) {
      const { path } = entry, base = { path, ctime: Number(entry.ctime ?? 0), mtime: Number(entry.mtime ?? 0), size: Number(entry.size ?? 0) };
      remote.add(path);
      const local = vault.getAbstractFileByPath(path), flag = local instanceof TFile ? this.getPublishFlag(local) : false;
      if (!(local instanceof TFile) || flag === false) changes.push({ ...base, type: "deleted", checked: false });
      else if (await this.getHash(local) !== entry.hash) changes.push({ ...base, type: "changed", checked: flag === true });
      else changes.push({ ...base, type: "to-delete", checked: false });
    }
    for (const file of vault.getFiles()) {
      if (!this.isFileSupported(file) || remote.has(file.path)) continue;
      const flag = this.getPublishFlag(file);
      if (flag !== false) changes.push({ path: file.path, ctime: 0, mtime: 0, size: 0, type: "new", checked: flag === true });
    }
    return changes;
  }

  listSites(): Promise<PublishSiteList> { return this.client.list(this.token); }
  createSite(): Promise<PublishSite> { return this.client.create(this.token); }
  /** Resolves when the slug is free. */
  checkSlug(slug: string): Promise<void> { return this.client.slug(this.token, slug); }
  setSlug(site: PublishSite, slug: string): Promise<void> { return this.client.setSlug(this.token, site, slug); }
  slugs(ids: string[]): Promise<Record<string, string>> { return this.client.slugs(this.token, ids); }
  async getCurrentSlug(): Promise<string> {
    const id = this.siteId ?? "";
    try { return (await this.slugs([id]))[id] || id; } catch { return id; }
  }
  async apiList(): Promise<PublishFileList> {
    const listing = await this.client.listFiles(this.token, this.site);
    this.publishedPaths = new Set(listing.files.map(file => file.path));
    return listing;
  }
  apiOptions(options?: SiteOptions): Promise<SiteOptions> {
    return options ? this.client.updateOptions(this.token, this.site, options).then(() => options) : this.client.getOptions(this.token, this.site);
  }
  async apiRemoveFile(path: string): Promise<void> { await this.client.remove(this.token, this.site, path); this.publishedPaths?.delete(path); }
  async apiUploadFile(file: TFile): Promise<void> {
    if (file.stat.size > MAX_FILE_SIZE) throw new PublishRequestError("TOOLARGE", t("obsen.publish.error-too-large"));
    const bytes = await this.app.vault.readBinary(file);
    await this.client.upload(this.token, this.site, file.path, bytes, await sha256(bytes), { ctime: file.stat.ctime, mtime: file.stat.mtime });
    this.publishedPaths?.add(file.path);
  }
  async apiDownloadFile(path: string): Promise<ArrayBuffer> {
    const response = await this.raw(this.backend(), "/api/download", { token: this.token, id: this.site.id, path });
    return response.arrayBuffer();
  }
  apiGetPassword(): Promise<{ pass: PublishPassword[] | null }> { return this.json(this.backend(), "/api/password", { token: this.token, id: this.site.id }, true); }
  apiAddPassword(name: string, pw: string): Promise<unknown> { return this.json(this.backend(), "/api/password", { token: this.token, id: this.site.id, name, pw }, true); }
  apiDelPassword(index: number): Promise<unknown> { return this.json(this.backend(), "/api/password", { token: this.token, id: this.site.id, del: index }, true); }
  apiCustomUrl(url?: string, redirect?: boolean): Promise<{ url?: string; redirect?: boolean }> {
    return this.json(this.registryOrigin, "/api/customurl", { token: this.token, id: this.site.id, host: this.site.host, url, redirect }, true);
  }
  deleteSite(siteId: string): Promise<unknown> { return this.json(this.accountOrigin, "/publish/delete", { token: this.token, site_uid: siteId }, false); }
  listShares(siteId: string): Promise<{ shares?: Array<{ uid: string; name?: string; email: string; accepted?: boolean }> }> { return this.json(this.accountOrigin, "/publish/share/list", { token: this.token, site_uid: siteId }, false); }
  inviteShare(siteId: string, email: string): Promise<unknown> { return this.json(this.accountOrigin, "/publish/share/invite", { token: this.token, site_uid: siteId, email }, false); }
  removeShare(siteId: string, shareId: string): Promise<unknown> { return this.json(this.accountOrigin, "/publish/share/remove", { token: this.token, site_uid: siteId, share_uid: shareId }, false); }

  private backend(): string {
    const host = this.site.host;
    if (/^https?:\/\//i.test(host)) return host.replace(/\/$/, "");
    return `${/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) ? "http" : "https"}://${host}`;
  }
  private async raw(origin: string, path: string, body: unknown): Promise<Response> {
    let response: Response;
    try { response = await fetch(`${origin.replace(/\/$/, "")}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    catch (error) { throw new PublishRequestError("NET", error instanceof Error ? error.message : String(error)); }
    if (response.status < 200 || response.status >= 400) throw new PublishRequestError("NET", String(response.status), response.status);
    return response;
  }
  private async json<T>(origin: string, path: string, body: unknown, publishEnvelope: boolean): Promise<T> {
    const response = await this.raw(origin, path, body);
    let value: Record<string, unknown>;
    try { value = await response.json() as Record<string, unknown>; } catch { throw new PublishRequestError("NET", String(response.status), response.status); }
    if (publishEnvelope && value?.code && value.message) throw new PublishRequestError(String(value.code), String(value.message), response.status);
    if (!publishEnvelope && value?.error) throw new PublishRequestError("ACCOUNT", String(value.error), response.status);
    return value as T;
  }
}

// ---------------------------------------------------------------------------------------------
// Dialog sections
// ---------------------------------------------------------------------------------------------

/** What a section needs from the "Publish changes" dialog. */
export interface PublishModalHost {
  readonly app: App;
  readonly contentEl: HTMLElement;
  readonly plugin: PublishService;
  handleError(error: unknown): void;
  showError(message: string): void;
  hideError(): void;
  close(): void;
  open(): void;
  openReviewChanges(): Promise<void>;
  openManageSites(): Promise<void>;
  openSiteOptions(): Promise<void>;
  openSiteFilters(): Promise<void>;
  openPasswords(): Promise<void>;
  openAddPassword(): Promise<void>;
  openCustomDomain(): Promise<void>;
  uploadChanges(changes: PublishChange[]): Promise<void>;
  refreshReview(): Promise<void>;
}

export abstract class PublishSection {
  title: string | null = null;
  readonly el: HTMLElement;
  constructor(readonly parentModal: PublishModalHost) { this.el = parentModal.contentEl.createDiv(); this.hide(); }
  show(): Promise<void> | void { this.el.style.display = ""; }
  hide(): void { this.el.style.display = "none"; }
}

/** A row in the reference settings markup. */
export function settingRow(parent: HTMLElement, name: string, description: string | DocumentFragment = ""): { settingEl: HTMLElement; controlEl: HTMLElement; descEl: HTMLElement } {
  const settingEl = parent.createDiv("setting-item"), info = settingEl.createDiv("setting-item-info");
  info.createDiv({ cls: "setting-item-name", text: name });
  const descEl = info.createDiv({ cls: "setting-item-description", text: description });
  return { settingEl, controlEl: settingEl.createDiv("setting-item-control"), descEl };
}
export function settingHeading(parent: HTMLElement, name: string): HTMLElement {
  const settingEl = parent.createDiv("setting-item setting-item-heading");
  settingEl.createDiv("setting-item-info").createDiv({ cls: "setting-item-name", text: name });
  return settingEl;
}

interface TreeNode { el: HTMLElement; selfEl: HTMLElement; visible: boolean; parent: FolderNode | null; name: string; setChecked(checked: boolean): void; updateChecked(): void; applyQuery(query: string): void }
interface FileNode extends TreeNode { kind: "file"; diff: PublishChange }
interface FolderNode extends TreeNode { kind: "folder"; children: Array<FileNode | FolderNode>; childrenEl: HTMLElement; count(): { count: number; checked: number }; collapse(collapsed: boolean): void }

const flairKey: Record<PublishChangeType, string> = { new: "plugins.publish.label-new-files-to-be-published", changed: "plugins.publish.label-changed-files-to-be-published", deleted: "plugins.publish.label-status-deleted", "to-delete": "plugins.publish.label-status-to-delete" };
const sortNodes = (a: FileNode | FolderNode, b: FileNode | FolderNode) => a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** One collapsible group of the review list (`.file-tree.publish-section`). */
class ChangeSection {
  collapsed = false;
  files: Record<string, FileNode> = {};
  private folders: Record<string, FolderNode> = {};
  private roots: Array<FileNode | FolderNode> = [];
  readonly sectionEl: HTMLElement;
  private readonly childrenEl: HTMLElement;
  private readonly selectedEl: HTMLElement;
  private readonly selectedCountEl: HTMLElement;

  constructor(private readonly review: ReviewChangesSection, parent: HTMLElement, title: string) {
    const section = this.sectionEl = parent.createDiv("file-tree publish-section"), header = section.createDiv("publish-section-header");
    this.childrenEl = section.createDiv("publish-change-list");
    const toggle = header.createDiv("publish-section-header-toggle-collapsed-button collapse-icon");
    setIcon(toggle, "right-triangle");
    toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    header.createDiv({ cls: "publish-section-header-text", text: title }).addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.selectedEl = header.createDiv("publish-section-header-selected");
    this.selectedCountEl = this.selectedEl.createSpan({ cls: "publish-section-header-selected-count", text: "0" });
    this.selectedEl.createSpan({ text: t("plugins.publish.label-file-selected") });
    header.createDiv({ cls: "publish-section-header-action button", text: t("plugins.publish.button-select-all-files") }).addEventListener("click", () => this.checkAll(true));
    header.createDiv({ cls: "publish-section-header-action", text: t("plugins.publish.button-deselect-all-files") }).addEventListener("click", () => this.checkAll(false));
  }

  get isEmpty(): boolean { return this.roots.length === 0; }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.sectionEl.toggleClass("is-collapsed", collapsed);
    this.sectionEl.querySelector(".collapse-icon")?.toggleClass("is-collapsed", collapsed);
    this.childrenEl.style.display = collapsed ? "none" : "";
  }
  collapseAll(): void { for (const folder of Object.values(this.folders)) folder.collapse(true); }
  private checkAll(checked: boolean): void { for (const node of this.roots) node.setChecked(checked); this.updateChecked(); }

  updateChecked(): void {
    const files = Object.values(this.files), checked = files.filter(file => file.diff.checked).length;
    this.selectedCountEl.setText(`${checked}/${files.length}`);
    this.selectedEl.toggleClass("u-pop", checked > 0);
  }
  private updateAncestors(node: TreeNode): void { for (let folder = node.parent; folder; folder = folder.parent) folder.updateChecked(); this.updateChecked(); }

  private attach(node: FileNode | FolderNode, path: string): void {
    const folderPath = dirName(path);
    if (!folderPath) { this.roots.push(node); return; }
    let folder = this.folders[folderPath];
    if (!folder) { folder = this.folders[folderPath] = this.createFolder(folderPath); this.attach(folder, folderPath); }
    folder.children.push(node); node.parent = folder;
  }

  private createFolder(path: string): FolderNode {
    const el = createDiv("tree-item"), selfEl = el.createDiv("tree-item-self mod-folder is-clickable mod-collapsible");
    const collapseEl = selfEl.createDiv("tree-item-icon collapse-icon");
    setIcon(collapseEl, "right-triangle");
    const inner = selfEl.createDiv("tree-item-inner file-tree-item");
    const checkboxEl = inner.createEl("input", { cls: "file-tree-item-checkbox", type: "checkbox" });
    setIcon(inner.createDiv("file-tree-item-icon"), "lucide-folder-open");
    inner.createDiv({ cls: "file-tree-item-title", text: baseName(path) });
    const node: FolderNode = {
      kind: "folder", el, selfEl, visible: true, parent: null, name: baseName(path), children: [], childrenEl: el.createDiv("tree-item-children"),
      count() { let count = 0, checked = 0; for (const child of node.children) { if (child.kind === "file") { count++; if (child.diff.checked) checked++; } else { const sub = child.count(); count += sub.count; checked += sub.checked; } } return { count, checked }; },
      setChecked(checked) { for (const child of node.children) child.setChecked(checked); node.updateChecked(); },
      updateChecked() { const { count, checked } = node.count(), all = count > 0 && checked === count; checkboxEl.checked = all; checkboxEl.indeterminate = !all && checked > 0; selfEl.toggleClass("is-selected", all); },
      applyQuery(query) { let any = false; for (const child of node.children) { child.applyQuery(query); any ||= child.visible; } node.visible = any; el.style.display = any ? "" : "none"; },
      collapse(collapsed) { el.toggleClass("is-collapsed", collapsed); collapseEl.toggleClass("is-collapsed", collapsed); node.childrenEl.style.display = collapsed ? "none" : ""; },
    };
    collapseEl.addEventListener("click", event => { event.stopPropagation(); node.collapse(!el.hasClass("is-collapsed")); });
    selfEl.addEventListener("click", event => {
      if (event.target === checkboxEl) event.preventDefault();
      const { count, checked } = node.count();
      if (!count) return;
      // Deferred so the browser's own checkbox toggle cannot override the computed state.
      setTimeout(() => { for (const child of node.children) child.setChecked(checked < count); node.updateChecked(); this.updateAncestors(node); });
    });
    return node;
  }

  createItem(diff: PublishChange): void {
    const { plugin, app } = this.review.parentModal, extension = extensionOf(diff.path), fileName = baseName(diff.path), name = extension === "md" ? fileName.slice(0, -3) : fileName;
    const el = createDiv("tree-item"), selfEl = el.createDiv(`tree-item-self mod-file mod-${diff.type} is-clickable`), inner = selfEl.createDiv("tree-item-inner file-tree-item");
    const checkboxEl = inner.createEl("input", { cls: "file-tree-item-checkbox", type: "checkbox" });
    setIcon(inner.createDiv("file-tree-item-icon"), "lucide-file");
    inner.createDiv({ cls: "file-tree-item-title", text: name });
    const node: FileNode = {
      kind: "file", el, selfEl, visible: true, parent: null, name, diff,
      setChecked(checked) { diff.checked = checked; node.updateChecked(); },
      updateChecked() { checkboxEl.checked = diff.checked; selfEl.toggleClass("is-selected", diff.checked); },
      applyQuery(query) { node.visible = diff.checked || diff.path.toLowerCase().includes(query); el.style.display = node.visible ? "" : "none"; },
    };
    node.updateChecked();
    inner.createDiv("tree-item-flair-outer").createSpan({ cls: "tree-item-flair", text: t(flairKey[diff.type]) });
    const compare = () => new CompareModal(this.review.parentModal, diff.path).open();
    if (diff.type === "changed" && ["md", "css", "js"].includes(extension)) {
      const button = inner.createDiv("clickable-icon");
      setIcon(button, "lucide-columns"); setTooltip(button, t("plugins.publish.label-compare-with-live"));
      button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); compare(); });
    }
    selfEl.addEventListener("click", event => {
      if (event.target === checkboxEl) event.preventDefault();
      const next = !diff.checked;
      setTimeout(() => { node.setChecked(next); this.updateAncestors(node); });
    });
    selfEl.addEventListener("contextmenu", event => {
      event.preventDefault();
      void plugin.getCurrentSlug().then(slug => {
        const menu = new Menu(), { type, path } = diff;
        if (type !== "new") menu.addItem(item => item.setIcon("lucide-globe").setTitle(t("plugins.publish.label-open-in-live-site")).onClick(() => openExternal(`${PUBLISH_ORIGIN}/${slug}/${livePath(path)}`)));
        if (type !== "deleted") menu.addItem(item => item.setIcon("lucide-folder-open").setTitle(t("plugins.publish.label-open-file")).onClick(() => {
          const file = app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) { void app.workspace.getLeaf().openFile(file, { active: true }); this.review.parentModal.close(); }
        }));
        if (type === "changed") menu.addItem(item => item.setIcon("lucide-columns").setTitle(t("plugins.publish.label-compare-with-live")).onClick(compare));
        if (type === "changed" || type === "deleted") menu.addItem(item => item.setIcon("lucide-pencil").setTitle(t("plugins.publish.button-use-live-version")).onClick(() => { void useLiveVersion(this.review.parentModal, path).catch(error => this.review.parentModal.handleError(error)); }));
        menu.showAtMouseEvent(event);
      });
    });
    this.files[diff.path] = node;
    this.attach(node, diff.path);
  }

  render(): void {
    const place = (parent: HTMLElement, nodes: Array<FileNode | FolderNode>) => {
      nodes.sort(sortNodes);
      parent.replaceChildren(...nodes.map(node => node.el));
      for (const node of nodes) if (node.kind === "folder") { place(node.childrenEl, node.children); node.updateChecked(); }
    };
    place(this.childrenEl, this.roots);
    this.updateChecked();
  }
  applyQuery(query: string): void { for (const node of this.roots) node.applyQuery(query); }
  clear(): void { this.roots = []; this.folders = {}; this.files = {}; this.childrenEl.empty(); this.updateChecked(); }
}

/** Replaces the local file with the site's copy, asking first when a local file exists. */
async function useLiveVersion(host: PublishModalHost, path: string, downloaded?: ArrayBuffer): Promise<void> {
  const { app, plugin } = host, data = downloaded ?? await plugin.apiDownloadFile(path), local = app.vault.getAbstractFileByPath(path);
  if (local instanceof TFile) {
    const confirmed = await confirmModal(app, {
      title: t("plugins.publish.label-confirm-override"), cta: t("plugins.publish.button-proceed"), destructive: true,
      body: el => { el.createEl("p", { text: t("plugins.publish.label-confirm-override-1") }); el.createEl("p", { text: t("plugins.publish.label-confirm-override-2") }); },
    });
    if (!confirmed) return;
    await app.vault.modifyBinary(local, data);
  } else {
    let folder = "";
    for (const part of path.split("/").slice(0, -1)) { folder = folder ? `${folder}/${part}` : part; if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await app.vault.createFolder(folder); }
    await app.vault.createBinary(path, data);
  }
  new Notice(t("plugins.publish.message-successfully-used-live-version"));
  await host.refreshReview();
}

/** "Compare with live version": the site's copy against the local file. */
class CompareModal extends Modal {
  constructor(private readonly host: PublishModalHost, private readonly path: string) { super(host.app); }
  override async onOpen(): Promise<void> {
    const { app, plugin } = this.host, { path } = this, local = app.vault.getAbstractFileByPath(path), extension = extensionOf(path);
    this.setTitle(t("plugins.publish.label-compare-with-live"));
    this.contentEl.style.overflow = "auto";
    let live: ArrayBuffer;
    try { live = await plugin.apiDownloadFile(path); }
    catch (error) { this.close(); this.host.handleError(error); return; }
    if (extension === "md" || extension === "css" || extension === "js") this.contentEl.appendChild(renderDiff(new TextDecoder().decode(live), local instanceof TFile ? await app.vault.cachedRead(local) : ""));
    else if (IMAGE_EXTENSIONS.includes(extension)) {
      if (local instanceof TFile) this.contentEl.createEl("img").src = app.vault.getResourcePath(local);
      const url = URL.createObjectURL(new Blob([new Uint8Array(live)], { type: `image/${extension === "svg" ? "svg+xml" : extension}` })), image = this.contentEl.createEl("img");
      image.addEventListener("load", () => URL.revokeObjectURL(url)); image.addEventListener("error", () => URL.revokeObjectURL(url));
      image.src = url;
    }
    const buttons = this.modalEl.createDiv("modal-button-container");
    if (local instanceof TFile) buttons.createEl("button", { text: t("plugins.publish.button-use-live-version") }).addEventListener("click", () => { void useLiveVersion(this.host, path, live).then(() => this.close()).catch(error => this.host.handleError(error)); });
    buttons.createEl("button", { cls: "mod-cta", text: t("plugins.publish.button-done") }).addEventListener("click", () => this.close());
  }
}

/** The file review list: changed, unchanged and new files with their selection. */
export class ReviewChangesSection extends PublishSection {
  title = t("plugins.publish.name");
  private pathToDiffMap: Record<string, PublishChange> = {};
  private query = "";
  private readonly siteNameEl: HTMLAnchorElement;
  private readonly noChangesEl: HTMLElement;
  private readonly sectionChanged: ChangeSection;
  private readonly sectionUnchanged: ChangeSection;
  private readonly sectionNew: ChangeSection;

  constructor(parentModal: PublishModalHost) {
    super(parentModal);
    const info = this.el.createDiv({ cls: "publish-changes-info" });
    info.createDiv({ cls: "publish-changes-info-publishing-to", text: t("plugins.publish.label-publishing-to") });
    this.siteNameEl = info.createEl("a", "publish-changes-current-site-name");
    this.siteNameEl.addEventListener("click", event => { event.preventDefault(); if (this.siteNameEl.dataset.href) openExternal(this.siteNameEl.dataset.href); });
    const switcher = info.createDiv("publish-changes-switch-site");
    const icon = (name: string, tooltip: string, onClick: () => void) => { const el = switcher.createSpan("clickable-icon"); setIcon(el, name); setTooltip(el, tooltip); el.addEventListener("click", onClick); };
    icon("lucide-repeat", t("plugins.publish.tooltip-switch-site"), () => void parentModal.openManageSites());
    icon("lucide-settings", t("plugins.publish.tooltip-open-site-options"), () => void parentModal.openSiteOptions());
    icon("lucide-filter", t("plugins.publish.tooltip-manage-publish-filters"), () => void parentModal.openSiteFilters());
    icon("lucide-life-buoy", t("plugins.publish.tooltip-contact-support"), () => openExternal("mailto:support@obsidian.md?subject=Obsidian%20Publish%20Support"));
    createSearchInput(info, t("setting.hotkeys.prompt-filter"), value => { this.query = value.trim().toLowerCase(); this.applyQuery(); });
    const linked = info.createEl("button", { cls: "publish-changes-add-linked-btn", text: t("plugins.publish.button-add-linked") });
    setTooltip(linked, t("plugins.publish.tooltip-add-linked"));
    linked.addEventListener("click", () => this.addLinked());
    this.noChangesEl = this.el.createEl("p", { text: t("plugins.publish.label-no-changes-detected") });
    const sections = this.el.createDiv("publish-sections-container");
    this.sectionChanged = new ChangeSection(this, sections, t("plugins.publish.label-changed-files-to-be-published"));
    this.sectionUnchanged = new ChangeSection(this, sections, t("plugins.publish.label-unchanged-files-already-published"));
    this.sectionNew = new ChangeSection(this, sections, t("plugins.publish.label-new-files-to-be-published"));
    const buttons = this.el.createDiv("modal-button-container");
    buttons.createEl("button", { cls: "mod-cta", text: t("plugins.publish.button-publish") }).addEventListener("click", () => this.uploadChanges());
    buttons.createEl("button", { text: t("dialogue.button-cancel") }).addEventListener("click", () => parentModal.close());
  }

  private applyQuery(): void { for (const section of [this.sectionChanged, this.sectionUnchanged, this.sectionNew]) section.applyQuery(this.query); }

  private addLinked(): void {
    const { metadataCache } = this.parentModal.app, linked = new Set<string>();
    for (const [path, diff] of Object.entries(this.pathToDiffMap)) {
      if (!diff.checked || diff.type === "deleted") continue;
      const cache = metadataCache.getCache(path);
      for (const link of [...cache?.links ?? [], ...cache?.embeds ?? []]) { const target = metadataCache.getFirstLinkpathDest(link.link.split("#")[0], path); if (target) linked.add(target.path); }
    }
    let count = 0;
    for (const path of linked) {
      const diff = this.pathToDiffMap[path], node = this.sectionNew.files[path];
      if (!diff || diff.checked || diff.type !== "new" || !node) continue;
      node.setChecked(true); count++;
    }
    this.sectionNew.render();
    new Notice(t("plugins.publish.msg-added-linked-files", { count }));
  }

  override async show(): Promise<void> {
    const { parentModal } = this, { sectionChanged: changed, sectionUnchanged: unchanged, sectionNew: fresh } = this;
    this.pathToDiffMap = {};
    void parentModal.plugin.getCurrentSlug().then(slug => { this.siteNameEl.setText(slug); this.siteNameEl.dataset.href = `${PUBLISH_ORIGIN}/${slug}`; this.siteNameEl.setAttribute("href", `${PUBLISH_ORIGIN}/${slug}`); });
    let changes: PublishChange[];
    try { changes = await parentModal.plugin.scanForChanges(); }
    catch (error) { parentModal.handleError(error); return; }
    this.noChangesEl.style.display = changes.length ? "none" : "";
    changed.clear(); unchanged.clear(); fresh.clear();
    for (const change of changes) {
      this.pathToDiffMap[change.path] = change;
      if (change.type === "changed" || change.type === "deleted") changed.createItem(change);
      else if (change.type === "new") fresh.createItem(change);
      else unchanged.createItem(change);
    }
    if (!changed.isEmpty) {
      changed.setCollapsed(false); unchanged.setCollapsed(true); fresh.setCollapsed(true);
      for (const node of Object.values(changed.files)) if (node.diff.type !== "deleted") node.setChecked(true);
    } else { changed.setCollapsed(true); unchanged.setCollapsed(true); fresh.setCollapsed(false); }
    changed.render(); unchanged.collapseAll(); unchanged.render(); fresh.collapseAll(); fresh.render();
    this.applyQuery();
    super.show();
  }

  private uploadChanges(): void {
    const selected = Object.values(this.pathToDiffMap).filter(change => change.checked);
    if (!selected.length) { new Notice(t("plugins.publish.msg-select-at-least-one-file")); return; }
    void this.parentModal.uploadChanges(selected);
  }
}

/** Upload progress: one row per selected change, published or removed in order. */
export class UploadProgressSection extends PublishSection {
  title = t("plugins.publish.label-upload-changes");
  private changes: PublishChange[] = [];
  private run: { cancelled: boolean } | null = null;
  private readonly changesContainer: HTMLElement;
  private readonly successMessageEl: HTMLElement;
  private readonly siteLinkEl: HTMLAnchorElement;
  private readonly doneButton: HTMLButtonElement;

  constructor(parentModal: PublishModalHost) {
    super(parentModal);
    this.changesContainer = this.el.createDiv("list-item-parent upload-progress-container");
    this.successMessageEl = this.el.createDiv();
    this.successMessageEl.createEl("p", { text: t("plugins.publish.label-clear-cache") });
    this.siteLinkEl = this.successMessageEl.createEl("p", { text: t("plugins.publish.label-visit-site") }).createEl("a");
    this.siteLinkEl.addEventListener("click", event => { event.preventDefault(); if (this.siteLinkEl.dataset.href) openExternal(this.siteLinkEl.dataset.href); });
    this.successMessageEl.style.display = "none";
    const buttons = this.el.createDiv("modal-button-container");
    this.doneButton = buttons.createEl("button", { cls: "mod-cta", text: t("plugins.publish.button-done") });
    this.doneButton.addEventListener("click", () => { if (this.run) this.run.cancelled = true; else parentModal.close(); });
    buttons.createEl("button", { text: t("plugins.publish.button-go-back") }).addEventListener("click", () => { if (this.run) this.run.cancelled = true; void parentModal.openReviewChanges(); });
  }

  addChanges(changes: PublishChange[]): void { this.changes = changes; }

  override show(): void {
    if (this.run) this.run.cancelled = true;
    super.show();
    this.successMessageEl.style.display = "none";
    this.changesContainer.removeClass("is-finished");
    this.doneButton.addClass("mod-warning"); this.doneButton.setText(t("plugins.publish.button-stop"));
    this.changesContainer.empty();
    const rows = new Map<string, HTMLElement>();
    for (const change of this.changes) {
      const row = this.changesContainer.createDiv("publish-upload-item list-item");
      setIcon(row.createDiv("list-item-part"), "lucide-file");
      row.createDiv({ cls: "list-item-part mod-extended publish-upload-item-title", text: change.path.replace(/\.[^./]+$/, "") });
      const flair = row.createDiv("list-item-part").createSpan("flair");
      if (change.type === "new" || change.type === "changed") flair.setText(t("plugins.publish.label-status-to-publish"));
      else flair.setText(t("plugins.publish.label-status-to-delete"));
      rows.set(change.path, row);
    }
    void this.startUpload(rows);
  }

  private async startUpload(rows: Map<string, HTMLElement>): Promise<void> {
    const { app, plugin } = this.parentModal, run = this.run = { cancelled: false };
    for (const change of this.changes) {
      const row = rows.get(change.path)!, flair = row.querySelector<HTMLElement>(".flair")!;
      if (run.cancelled) { flair.setText(t("plugins.publish.label-status-cancelled")); row.addClass("mod-failed", "mod-completed"); continue; }
      try {
        flair.setText(t("plugins.publish.label-status-uploading"));
        if (change.type === "deleted" || change.type === "to-delete") { await plugin.apiRemoveFile(change.path); flair.setText(t("plugins.publish.label-status-deleted")); }
        else {
          const file = app.vault.getAbstractFileByPath(change.path);
          if (file instanceof TFile) { await plugin.apiUploadFile(file); flair.setText(t("plugins.publish.label-status-published")); }
        }
        row.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (error) { this.parentModal.handleError(error); flair.setText(t("plugins.publish.label-status-failed")); row.addClass("mod-failed"); }
      row.addClass("mod-completed");
    }
    if (this.run !== run) return;
    this.run = null;
    this.doneButton.removeClass("mod-warning"); this.doneButton.setText(t("plugins.publish.button-done"));
    const url = `${PUBLISH_ORIGIN}/${await plugin.getCurrentSlug()}`;
    this.siteLinkEl.setText(url); this.siteLinkEl.dataset.href = url; this.siteLinkEl.setAttribute("href", url);
    this.successMessageEl.style.display = "";
    this.changesContainer.addClass("is-finished");
  }
}
