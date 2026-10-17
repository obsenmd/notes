import { ipcRenderer } from "../../platforms/platform";
import moment from "moment";
import { AccountClient } from "../compat/account";
import { renderMarkdown } from "../compat/markdown-parser";
import { createEl, installDomExtensions } from "../compat/dom";
import type { App } from "../compat/plugin";
import type { SyncHistoryEntry } from "../compat/sync-history";
import { Modal, Notice } from "../compat/ui";
import { setIcon, setTooltip } from "../compat/utilities";
import { t } from "../i18n";
import { confirmDialog } from "../controllers/dialogs";
import { baseName, copyText, createToggle, dirName, extensionOf, formatBytes, openLocalHistory, isFileRecoveryEnabled, renderDiff, stripMd, withLoading, type ToggleHandle } from "./core/file-recovery";
import type { VaultSync } from "./SyncVaultManager";

type HistoryItem = SyncHistoryEntry & { username?: string; email?: string };

const AVATAR_COLORS = ["mod-avatar-color-1", "mod-avatar-color-2", "mod-avatar-color-3", "mod-avatar-color-4", "mod-avatar-color-5", "mod-avatar-color-6", "mod-avatar-color-7", "mod-avatar-color-8"];
const GROUP_WINDOW = 3_600_000;
const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
const TEXT_EXTENSIONS = ["md", "json", "css", "js", "base"];
const SHOW_DIFF_KEY = "history-show-diff";

const decodeText = (data: ArrayBuffer) => new TextDecoder().decode(data);
const accountName = () => { try { return new AccountClient({ origin: ipcRenderer.sendSync("obsen-server-url") || "https://api.obsidian.md", storage: localStorage }).session?.name ?? ""; } catch { return ""; } };

/** Consecutive revisions by one device within an hour and on one day form a group; renames and deletions stand alone. */
function groupHistory(items: HistoryItem[]): HistoryItem[][] {
  const groups: HistoryItem[][] = [];
  let current: HistoryItem[] = [];
  for (const item of items) {
    if ((item.deleted && item.relatedpath) || item.folder) continue;
    if (!current.length) { current.push(item); continue; }
    const first = current[0];
    if (item.deleted || item.relatedpath || !moment(first.ts).isSame(item.ts, "day")) { groups.push(current); current = [item]; }
    else if (first.device === item.device && first.username === item.username && Number(first.ts) - Number(item.ts) < GROUP_WINDOW) current.push(item);
    else { groups.push(current); current = [item]; }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Version history of one file in the connected remote vault (`.modal.mod-sync-history`). */
export class SyncHistoryModal extends Modal {
  private items: HistoryItem[][] = [];
  private activeItem: HistoryItem | null = null;
  private activeItemEl: HTMLElement | null = null;
  private activeItemParentEl: HTMLElement | null = null;
  private readonly cache: Record<string, ArrayBuffer> = {};
  private readonly listEl: HTMLElement;
  private readonly loadMoreButtonEl: HTMLButtonElement;
  private readonly contentContainerEl: HTMLElement;
  private readonly contentTitlebarEl: HTMLElement;
  private readonly contentPreviewEl: HTMLElement;
  private readonly contentDiffEl: HTMLElement;
  private readonly diffToggle: ToggleHandle;
  private readonly contentCopyButton: HTMLButtonElement;
  private readonly restoreVersionButton: HTMLButtonElement;
  private copyContent: (() => void) | null = null;

  constructor(app: App, private readonly sync: VaultSync, private readonly filepath: string) {
    super(app);
    const modalWindow = this.contentEl.ownerDocument.defaultView;
    if (modalWindow) installDomExtensions(modalWindow);
    this.setTitle(filepath);
    const { contentEl } = this;
    this.modalEl.addClass("mod-sync-history", "mod-sidebar-layout");
    const back = this.titleEl.createDiv("clickable-icon modal-setting-back-button mod-raised");
    setIcon(back, "lucide-arrow-left"); back.style.display = "none";
    const inner = contentEl.createDiv("modal-sidebar mod-history sync-history-list-container").createDiv("modal-sidebar-inner");
    this.listEl = inner.createDiv("modal-sidebar-list sync-history-list");
    this.loadMoreButtonEl = createEl("button", { cls: "sync-history-button", text: t("plugins.sync.label-load-more") });
    this.loadMoreButtonEl.addEventListener("click", () => void this.fetchMore());
    const container = this.contentContainerEl = contentEl.createDiv("sync-history-content-container");
    const content = container.createDiv("sync-history-content");
    const titlebar = this.contentTitlebarEl = content.createDiv("modal-setting-titlebar");
    titlebar.createDiv({ cls: "modal-setting-title", text: extensionOf(filepath) === "md" ? baseName(filepath).slice(0, -3) : filepath });
    const actions = titlebar.createDiv("modal-setting-titlebar-actions");
    this.diffToggle = createToggle(actions.createSpan({ text: t("plugins.sync.label-show-diff"), cls: "modal-setting-titlebar-toggle" }), true);
    this.diffToggle.setValue(Boolean(localStorage.getItem(SHOW_DIFF_KEY)));
    this.contentCopyButton = actions.createEl("button", { text: t("interface.label-copy-short") });
    this.contentCopyButton.addEventListener("click", () => this.copyContent?.());
    this.restoreVersionButton = actions.createEl("button", { text: t("plugins.sync.label-restore-this-version") });
    this.restoreVersionButton.addEventListener("click", () => void this.restore());
    this.contentPreviewEl = content.createDiv("sync-history-preview");
    this.contentDiffEl = content.createDiv("sync-history-diff");
  }

  private async restore(): Promise<void> {
    const item = this.activeItem;
    if (!item) return;
    if (item === this.items[0]?.[0]) { new Notice(t("plugins.sync.msg-already-latest-version")); return; }
    try {
      await this.sync.restoreVersion(item.uid, this.filepath !== item.path ? this.filepath : "");
      new Notice(t("plugins.sync.msg-restored-version", { time: moment(item.ts).fromNow() }));
      this.close();
    } catch (error) { console.error(error); new Notice(t("plugins.sync.label-unable-to-retrieve")); }
  }

  override onOpen(): void {
    void this.fetchMore();
    if (extensionOf(this.filepath) === "md" && isFileRecoveryEnabled()) {
      const button = this.listEl.createEl("button", { prepend: true, cls: "sync-history-button", text: t("plugins.file-recovery.action-open") });
      button.addEventListener("click", () => { openLocalHistory(this.filepath); });
    }
  }

  private async getContentForVersion(uid: string): Promise<ArrayBuffer> {
    if (!Object.hasOwn(this.cache, uid)) this.cache[uid] = await this.sync.getContentForVersion(uid);
    return this.cache[uid];
  }

  private async openHistory(item: HistoryItem, previous: HistoryItem | null): Promise<void> {
    const { contentContainerEl, diffToggle, contentPreviewEl: preview, contentDiffEl: diff, contentCopyButton, contentTitlebarEl, restoreVersionButton } = this;
    preview.removeClass("markdown-rendered"); preview.empty(); diff.empty();
    contentTitlebarEl.style.display = "none"; diffToggle.setDisabled(true);
    contentCopyButton.setAttr("disabled", true); restoreVersionButton.style.display = "none";
    this.copyContent = null;
    const description = (text: string) => { preview.createDiv({ cls: "sync-history-desc", text }); preview.style.display = ""; };
    if (item.relatedpath) {
      const oldName = baseName(item.relatedpath), newName = baseName(item.path), oldFolder = dirName(item.relatedpath), newFolder = dirName(item.path);
      if (oldName === newName) description(t("plugins.sync.label-file-moved-from-to", { from: oldFolder || "/", to: newFolder || "/" }));
      else if (oldFolder === newFolder) description(t("plugins.sync.label-file-renamed-from-to", { from: oldName, to: newName }));
      else description(t("plugins.sync.label-file-renamed-from-to", { from: item.relatedpath, to: item.path }));
      return;
    }
    if (item.deleted) { description(t("plugins.sync.label-file-deleted")); return; }
    restoreVersionButton.style.display = ""; contentTitlebarEl.style.display = "";
    try {
      await withLoading(contentContainerEl, async () => {
        const extension = extensionOf(this.filepath);
        if (TEXT_EXTENSIONS.includes(extension)) {
          const text = decodeText(await this.getContentForVersion(item.uid));
          preview.addClass("markdown-rendered"); diffToggle.setDisabled(false); contentCopyButton.removeAttribute("disabled");
          this.copyContent = () => copyText(text);
          let previewRendered = false, diffRendered = false;
          const update = async () => {
            if (this.activeItemRequest !== item) return;
            const showDiff = diffToggle.getValue();
            if (showDiff) localStorage.setItem(SHOW_DIFF_KEY, "true"); else localStorage.removeItem(SHOW_DIFF_KEY);
            preview.style.display = showDiff ? "none" : ""; diff.style.display = showDiff ? "" : "none";
            if (showDiff && !diffRendered) {
              diffRendered = true;
              const before = previous ? decodeText(await this.getContentForVersion(previous.uid)) : text;
              diff.empty(); diff.appendChild(renderDiff(before, text));
            } else if (!showDiff && !previewRendered) {
              previewRendered = true;
              if (extension === "md") renderMarkdown(text, preview.createDiv()); else preview.createEl("pre").setText(text);
            }
          };
          diffToggle.onChange(() => { void update().catch(error => console.error(error)); });
          await update();
          return;
        }
        if (IMAGE_EXTENSIONS.includes(extension)) {
          const url = URL.createObjectURL(new Blob([await this.getContentForVersion(item.uid)], { type: `image/${extension === "svg" ? "svg+xml" : extension}` }));
          const image = preview.createEl("img");
          const release = () => URL.revokeObjectURL(url);
          image.addEventListener("load", release); image.addEventListener("error", release);
          image.src = url;
        } else preview.createDiv({ text: t("plugins.sync.label-preview-unsupported-file-type", { type: extension }) });
        preview.style.display = ""; diff.style.display = "none";
      });
    } catch (error) { console.error(error); new Notice(t("plugins.sync.label-unable-to-retrieve")); }
  }

  /** The revision whose content is being shown; late loads for another revision are dropped. */
  private activeItemRequest: HistoryItem | null = null;
  private show(item: HistoryItem, previous: HistoryItem | null): Promise<void> { this.activeItemRequest = item; return this.openHistory(item, previous); }

  private setActiveHistoryItem(el: HTMLElement, item: HistoryItem, parent?: HTMLElement): void {
    this.activeItemEl?.removeClass("is-active"); this.activeItemParentEl?.removeClass("is-active");
    this.activeItemEl = el; el.addClass("is-active"); this.activeItem = item;
    this.activeItemParentEl = parent ?? null; parent?.addClass("is-active");
  }

  private createHistoryItemAvatar(parent: HTMLElement, item: HistoryItem): void {
    const other = item.username || item.email, name = other || accountName();
    const initials = name.split(" ").map(part => part.charAt(0)).slice(0, 2).join("");
    let color = "mod-avatar-current-user";
    if (other) { let sum = 0; for (let i = 0; i < other.length; i++) sum += other.charCodeAt(i); color = AVATAR_COLORS[sum % AVATAR_COLORS.length]; }
    let tip = item.username ? (item.email ? `${item.username} (${item.email})` : item.username) : item.email ?? "";
    if (tip) tip += "\n";
    if (item.device) tip += item.device;
    if (!(item.relatedpath || item.deleted || item.size === 0)) tip += `, ${formatBytes(Number(item.size ?? 0))}`;
    setTooltip(parent.createDiv({ cls: `sync-history-list-item-avatar ${color}`, text: initials }), tip, { placement: "bottom" });
  }

  private async fetchMore(): Promise<void> {
    const { items, listEl, loadMoreButtonEl } = this, first = items.length === 0;
    let last: string | null = null, path = this.filepath;
    loadMoreButtonEl.detach();
    if (items.length) { const group = items[items.length - 1], oldest = group[group.length - 1]; last = oldest.uid; path = oldest.relatedpath || oldest.path; }
    let page;
    try { page = await this.sync.getHistory(path, last); }
    catch (error) { console.error(error); new Notice(t("plugins.sync.label-unable-to-retrieve")); listEl.append(loadMoreButtonEl); return; }
    let entries = page.items as HistoryItem[], more = page.more;
    // History continues under the previous path after a rename.
    const renamed = entries.findIndex(entry => entry.relatedpath && !entry.deleted);
    if (renamed !== -1) { if (renamed < entries.length - 1) entries = entries.slice(0, renamed + 1); more = true; }
    for (const group of groupHistory(entries)) this.addGroup(group, first);
    if (first) {
      if (!items.length) listEl.createDiv({ cls: "list-item mod-empty", text: t("plugins.sync.label-no-history") });
      else await this.show(items[0][0], items.length > 1 ? items[1][0] : null);
    }
    if (more) listEl.append(loadMoreButtonEl);
  }

  private addGroup(group: HistoryItem[], first: boolean): void {
    const { items, listEl } = this, head = group[0], index = items.push(group) - 1;
    const itemEl = listEl.createDiv("sync-history-list-item");
    if (!head.username && !head.email) itemEl.addClass("mod-current-user");
    const header = itemEl.createDiv("modal-sidebar-list-item sync-history-list-item-header");
    const ts = Number(head.ts);
    this.createHistoryItemAvatar(header, head);
    const details = header.createDiv({ cls: "modal-sidebar-list-item-details sync-history-list-item-details", text: ts + 86_400_000 < Date.now() ? moment(ts).format("llll") : moment(ts).fromNow() });
    const flairOuter = header.createDiv("tree-item-flair-outer"), sub = details.createDiv("u-small u-muted");
    if (head.relatedpath) {
      const oldName = baseName(head.relatedpath), newName = baseName(head.path), oldFolder = dirName(head.relatedpath), newFolder = dirName(head.path);
      sub.setText(oldName === newName ? t("plugins.sync.label-file-moved-from", { from: oldFolder || "/" }) : t("plugins.sync.label-file-renamed-from", { from: oldFolder === newFolder ? oldName : head.relatedpath }));
    } else if (head.deleted) sub.setText(head.username || head.email ? t("plugins.sync.label-file-deleted") : t("plugins.sync.label-file-deleted-via", { device: head.device ?? "" }));
    else if (head.size === 0) sub.setText(t("plugins.sync.label-empty-file"));
    else sub.setText(t("plugins.sync.label-revision", { count: group.length }) + (head.username || head.email ? "" : ` ${t("plugins.sync.label-via-device", { device: head.device ?? "" })}`));

    const versions = itemEl.createDiv("version-group-container");
    versions.style.display = "none";
    versions.createSpan("connecting-line");
    const nextGroupHead = () => { const at = items.indexOf(group); return at !== -1 && at !== items.length - 1 ? items[at + 1][0] : null; };
    group.forEach((item, position) => {
      const versionEl = versions.createDiv({ cls: "version-group-item", text: moment(item.ts).format("LT") });
      versionEl.addEventListener("click", () => {
        const previous = position === group.length - 1 ? nextGroupHead() : group[position + 1];
        this.setActiveHistoryItem(versionEl, item, header);
        void this.show(item, previous);
      });
    });
    const collapse = flairOuter.createSpan({ cls: "is-collapsed tree-item-flair collapse-icon" });
    const toggle = () => { const collapsed = !collapse.hasClass("is-collapsed"); collapse.toggleClass("is-collapsed", collapsed); versions.style.display = collapsed ? "none" : ""; };
    setIcon(collapse, "right-triangle");
    collapse.addEventListener("click", event => { event.stopPropagation(); toggle(); });
    header.addEventListener("click", event => {
      if (collapse.contains(event.target as Node)) return;
      if (this.activeItem === head) { toggle(); return; }
      this.setActiveHistoryItem(header, head);
      void this.show(head, nextGroupHead());
    });
    if (first && !this.activeItemEl && index === 0) this.setActiveHistoryItem(header, head);
  }
}

/** Deleted files of the remote vault; a row opens that file's version history. */
export class SyncDeletedFilesModal extends Modal {
  private offset = 0;
  private readonly history: SyncHistoryEntry[];
  private readonly historyListEl: HTMLElement;
  private readonly selected = new Set<string>();
  private readonly restoreButton: HTMLButtonElement;

  constructor(app: App, private readonly sync: VaultSync, history: SyncHistoryEntry[]) {
    super(app);
    const modalWindow = this.contentEl.ownerDocument.defaultView;
    if (modalWindow) installDomExtensions(modalWindow);
    this.history = history.filter(entry => !entry.folder);
    this.setTitle(t("plugins.sync.label-deleted-files"));
    this.modalEl.addClass("mod-lg");
    const header = this.contentEl.createDiv({ cls: "sync-modal-header" });
    header.createEl("p", { cls: "u-faded-text", text: t("nouns.file-with-count", { count: this.history.length }) });
    header.createEl("p", { text: t("plugins.sync.label-click-to-see-history") });
    this.restoreButton = header.createEl("button", { cls: "mod-cta", text: t("plugins.sync.button-bulk-restore"), attr: { disabled: "" } });
    this.restoreButton.addEventListener("click", () => void this.restoreSelected());
    const list = this.historyListEl = this.contentEl.createDiv("sync-file-tree-container");
    list.addEventListener("scroll", () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - list.clientHeight / 2) this.loadMore(); }, { passive: true });
  }

  override onOpen(): void { this.loadMore(); }

  private loadMore(): void {
    for (const end = Math.min(this.offset + 30, this.history.length); this.offset < end;) {
      const entry = this.history[this.offset++];
      const row = createEl("div", { cls: "list-item mod-selectable tappable", parent: this.historyListEl });
      const part = createEl("div", { cls: "list-item-part mod-extended", parent: row });
      const checkbox = createEl("input", { type: "checkbox", cls: "sync-deleted-file-checkbox", parent: row, attr: { "aria-label": t("plugins.sync.label-select-file-to-restore", { file: stripMd(entry.path) }) } });
      checkbox.checked = this.selected.has(entry.uid);
      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("change", () => { if (checkbox.checked) this.selected.add(entry.uid); else this.selected.delete(entry.uid); this.updateRestoreButton(); });
      createEl("div", { text: stripMd(entry.path), parent: part });
      const time = moment(entry.ts).fromNow();
      createEl("div", { cls: "u-muted u-small list-item-part", text: entry.device ? `[${entry.device}] ${time}` : time, parent: part });
      row.addEventListener("click", () => new SyncHistoryModal(this.app, this.sync, entry.path).open());
    }
  }

  private updateRestoreButton(): void {
    this.restoreButton.disabled = this.selected.size === 0;
    this.restoreButton.setText(t("plugins.sync.button-restore-files", { count: this.selected.size }));
  }

  private async restoreSelected(): Promise<void> {
    const entries = this.history.filter(entry => this.selected.has(entry.uid));
    if (!entries.length) return;
    const confirmation = await confirmDialog(this.app, {
      title: t("plugins.sync.button-bulk-restore"),
      message: [t("plugins.sync.msg-confirm-bulk-restore", { count: entries.length })],
      cta: t("plugins.sync.button-restore-files", { count: entries.length }),
      warning: true,
    });
    if (!confirmation.confirmed) return;
    this.restoreButton.disabled = true;
    let restored = 0;
    try {
      for (const entry of entries) {
        await this.sync.restoreDeletedFile(entry.path);
        this.selected.delete(entry.uid);
        restored++;
      }
      new Notice(t("plugins.sync.msg-bulk-restored", { count: restored }));
      this.close();
    } catch (error) {
      console.error(error);
      new Notice(t("plugins.sync.msg-bulk-restore-failed", { restored, count: entries.length }));
      this.updateRestoreButton();
    }
  }
}

export function openSyncHistory(app: App, sync: VaultSync, path: string): void { new SyncHistoryModal(app, sync, path).open(); }

export async function openSyncDeletedFiles(app: App, sync: VaultSync): Promise<void> {
  try { new SyncDeletedFilesModal(app, sync, (await sync.listDeleted()).reverse()).open(); }
  catch (error) { console.error(error); new Notice(t("plugins.sync.label-unable-to-retrieve")); }
}

export default openSyncHistory;
