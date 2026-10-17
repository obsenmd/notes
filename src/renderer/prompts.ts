import { process } from "../../platforms/platform";
import { Keymap, type Command } from "../compat/commands";
import type { App } from "../compat/plugin";
import { FuzzySuggestModal, SuggestModal, fuzzySearch, prepareQuery, renderResults, sortSearchResults, type FuzzyMatch, type PreparedQuery, type SearchMatches, type SearchResult } from "../compat/suggest";
import { TFile } from "../compat/vault";
import { t } from "../i18n";
import type { AppActions } from "./actions";
import type { BookmarkItem, BookmarkStore } from "./bookmarks";
import { formatHotkey } from "./hotkeys";
import { readCorePluginData } from "./core-plugins";

const isMac = typeof process !== "undefined" && process.platform === "darwin";
const collator = new Intl.Collator(undefined, { usage: "sort", sensitivity: "base", numeric: true });
const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
const RECENT_COMMANDS = "recent-commands";

let sharedBookmarks: BookmarkStore | null = null;
/** The vault's bookmarks, so file prompts can list them without every caller passing the store. */
export function setPromptBookmarks(store: BookmarkStore | null): void { sharedBookmarks = store; }

/** Moves the entries listed in `order` to the front, in that order; the rest keep their relative order. */
function sortByOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index] as const));
  const position = (item: T) => rank.get(item.id) ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => position(a) - position(b));
}

/** Lists every command available in the current context: pinned ones first, then recently used, then by name. */
export class CommandPaletteModal extends FuzzySuggestModal<Command> {
  private pinned: string[] = [];
  private commands: Command[] | null = null;
  private readonly recent: string[];
  constructor(app: App, private readonly actions: AppActions) {
    super(app);
    this.emptyStateText = t("plugins.command-palette.label-no-commands");
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.command-palette.instruction-navigate") },
      { command: "↵", purpose: t("plugins.command-palette.instruction-use") },
      { command: "esc", purpose: t("plugins.command-palette.instruction-dismiss") },
    ]);
    this.setPlaceholder(t("plugins.command-palette.prompt-add-command"));
    const stored = app.loadLocalStorage(RECENT_COMMANDS);
    this.recent = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    this.scope.register(null, "Tab", () => false);
    this.scope.register(null, "Enter", event => { if (event.isComposing) return; this.selectActiveSuggestion(event); return false; });
  }
  override async onOpen(): Promise<void> {
    this.commands = null;
    this.inputEl.focus();
    const data = await readCorePluginData(this.actions.config.configDir, "command-palette").catch(() => ({} as Record<string, unknown>));
    this.pinned = Array.isArray(data.pinned) ? data.pinned.filter((id): id is string => typeof id === "string") : [];
    this.updateSuggestions();
  }
  override onClose(): void { this.commands = null; super.onClose(); }
  getItems(): Command[] {
    if (this.commands) return this.commands;
    const context = this.app.getCommandContext();
    const available = [...this.app.commands.commands.values()].filter(command => this.app.commands.isAvailable(command.id, context));
    const pinned = new Set(this.pinned);
    const first = sortByOrder(available.filter(command => pinned.has(command.id)), this.pinned);
    const rest = sortByOrder(available.filter(command => !pinned.has(command.id)).sort((a, b) => collator.compare(a.name, b.name)), this.recent);
    return this.commands = first.concat(rest);
  }
  getItemText(command: Command): string { return command.name; }
  override sortSuggestions(results: FuzzyMatch<Command>[]): void {
    for (const result of results) if (result.match.score > 0) result.match.score += result.item.name.length / 10000;
    super.sortSuggestions(results);
  }
  override renderSuggestion(value: FuzzyMatch<Command>, el: HTMLElement): void {
    el.classList.add("mod-complex");
    const content = el.createDiv("suggestion-content"), aux = el.createDiv("suggestion-aux"), title = content.createDiv("suggestion-title");
    const command = value.item, name = command.name, colon = name.indexOf(": ");
    if (colon !== -1) {
      renderResults(title.createSpan("suggestion-prefix"), name.slice(0, colon), value.match);
      renderResults(title.createSpan(), name.slice(colon + 2), value.match, -(colon + 2));
    } else renderResults(title.createSpan(), name, value.match);
    for (const hotkey of command.hotkeys ?? []) aux.createEl("kbd", { cls: "suggestion-hotkey", text: formatHotkey(hotkey) });
    if (this.pinned.includes(command.id)) aux.createSpan({ cls: "suggestion-flair" }, flair => this.app.setIcon(flair, "lucide-pin"));
  }
  onChooseItem(command: Command, event: MouseEvent | KeyboardEvent): void {
    this.app.lastEvent = event;
    this.app.executeCommandById(command.id);
    const recent = this.recent, index = recent.indexOf(command.id);
    if (index >= 0) recent.splice(index, 1);
    recent.unshift(command.id);
    if (recent.length > 100) recent.length = 100;
    this.app.saveLocalStorage(RECENT_COMMANDS, recent);
  }
}

export type FileSuggestion =
  | { type: "file"; file: TFile; match: SearchResult | null; downranked?: boolean }
  | { type: "alias"; alias: string; file: TFile; match: SearchResult; downranked?: boolean }
  | { type: "unresolved"; linktext: string; match: SearchResult }
  | { type: "bookmark"; item: BookmarkItem; bookmarkPath: string; match: SearchResult };

const withoutMarkdownExtension = (filePath: string) => /\.md$/i.test(filePath) ? filePath.slice(0, -3) : filePath;
const baseName = (filePath: string) => filePath.slice(filePath.lastIndexOf("/") + 1);
/** The text a suggestion stands for: what Tab completes to and what a drag carries. */
function suggestionPath(value: FileSuggestion): string {
  return value.type === "file" || value.type === "alias" ? withoutMarkdownExtension(value.file.path) : value.type === "unresolved" ? value.linktext : value.bookmarkPath;
}
/** Tab completes up to the folder that follows the last matched character, or to the whole path. */
function completePath(text: string, matches: SearchMatches | null | undefined): string {
  if (matches?.length) { const slash = text.indexOf("/", matches[matches.length - 1][1]); if (slash !== -1) return text.slice(0, slash + 1); }
  return text;
}
/** A path matches on its file name when it can, otherwise anywhere in the path at a small cost. */
function searchPath(query: PreparedQuery, filePath: string): SearchResult | null {
  const name = baseName(filePath), byName = fuzzySearch(query, name);
  if (byName) { const shift = filePath.length - name.length; for (const range of byName.matches) { range[0] += shift; range[1] += shift; } return byName; }
  const byPath = fuzzySearch(query, filePath);
  if (byPath) byPath.score -= 1;
  return byPath;
}
function ignoreMatcher(filters: string[] | null | undefined): (filePath: string) => boolean {
  const tests = (filters ?? []).flatMap(filter => {
    if (filter.length > 2 && filter.startsWith("/") && filter.endsWith("/")) { try { const pattern = new RegExp(filter.slice(1, -1)); return [(filePath: string) => pattern.test(filePath)]; } catch { return []; } }
    return filter ? [(filePath: string) => filePath.startsWith(filter)] : [];
  });
  return filePath => tests.some(test => test(filePath));
}

/**
 * The file prompt behind the quick switcher and the note composer: recent files while the input is empty, then
 * files, aliases, links to notes that do not exist yet, and bookmarks. A `null` suggestion stands for "create".
 */
export abstract class FileSuggestModal extends SuggestModal<FileSuggestion | null> {
  shouldShowUnresolved = false;
  shouldShowMarkdown = true;
  shouldShowNonAttachments = true;
  shouldShowAlias = true;
  shouldShowNonImageAttachments = true;
  shouldShowImages = true;
  shouldShowAllTypes = false;
  shouldShowNonFileBookmarks = false;
  allowCreateNewFile = false;
  constructor(app: App, protected readonly actions: AppActions, protected readonly bookmarks: BookmarkStore | null = sharedBookmarks) {
    super(app);
    this.limit = 20;
    this.scope.register([], "Tab", event => {
      if (event.isComposing) return;
      const selected = this.chooser.getSelectedValue();
      if (selected) {
        let completed = completePath(suggestionPath(selected), selected.match?.matches);
        if (completed === this.inputEl.value) completed += "/";
        this.inputEl.value = completed;
        this.onInput();
      }
      return false;
    });
  }
  get supportsCreate(): boolean { return this.allowCreateNewFile && this.shouldShowMarkdown; }
  override onNoSuggestion(): void {
    const query = this.inputEl.value.trim();
    if (query && this.supportsCreate) { this.chooser.setSuggestions([null]); return; }
    this.chooser.setSuggestions(null);
    this.chooser.addMessage(query ? this.emptyStateText : t("setting.third-party-plugin.label-no-recent-files-found"));
  }
  private accepts(file: TFile): boolean {
    const extension = file.extension.toLowerCase();
    if (extension === "md") return this.shouldShowMarkdown;
    if (extension === "canvas" || extension === "base") return this.shouldShowNonAttachments;
    if (IMAGE_EXTENSIONS.includes(extension)) return this.shouldShowImages;
    return this.shouldShowAllTypes || (this.shouldShowNonImageAttachments && !!this.app.workspace.getViewTypeByExtension(extension));
  }
  getSuggestions(input: string): Array<FileSuggestion | null> {
    const query = input.trim(), { vault, metadataCache, workspace } = this.app;
    const ignored = ignoreMatcher(this.actions.config.get("userIgnoreFilters"));
    const results: FileSuggestion[] = [];
    if (!query) {
      for (const filePath of workspace.getLastOpenFiles()) {
        const file = vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile && !ignored(file.path) && this.accepts(file)) results.push({ type: "file", file, match: null });
      }
      return results;
    }
    const prepared = prepareQuery(query);
    for (const file of vault.getFiles()) {
      if (!this.accepts(file)) continue;
      const downranked = ignored(file.path), match = searchPath(prepared, withoutMarkdownExtension(file.path));
      if (match) { if (downranked) match.score -= 10; results.push({ type: "file", file, match, downranked }); }
      if (!this.shouldShowAlias) continue;
      for (const alias of fileAliases(metadataCache.getFileCache(file)?.frontmatter)) {
        const aliasMatch = fuzzySearch(prepared, alias);
        if (aliasMatch) { if (downranked) aliasMatch.score -= 10; results.push({ type: "alias", alias, file, match: aliasMatch, downranked }); }
      }
    }
    if (this.shouldShowUnresolved) {
      const linktexts = new Set<string>();
      for (const links of Object.values(metadataCache.unresolvedLinks)) for (const linktext of Object.keys(links)) { const linkpath = linktext.split("#", 1)[0].trim(); if (linkpath) linktexts.add(linkpath); }
      for (const linktext of linktexts) { const match = fuzzySearch(prepared, linktext); if (match) results.push({ type: "unresolved", linktext, match }); }
    }
    if (this.bookmarks && this.actions.corePlugins.isEnabled("bookmarks")) {
      const visit = (items: BookmarkItem[], prefix: string) => {
        for (const item of items) {
          if (item.type === "group") { visit(this.bookmarks!.children(item), `${prefix}${item.title ?? ""}/`); continue; }
          if (item.type === "file" && !item.subpath) { const file = vault.getAbstractFileByPath(item.path ?? ""); if (!(file instanceof TFile) || !this.accepts(file)) continue; }
          else if (!this.shouldShowNonFileBookmarks) continue;
          const bookmarkPath = prefix + bookmarkTitle(this.app, item), match = fuzzySearch(prepared, bookmarkPath);
          if (match) results.push({ type: "bookmark", match, item, bookmarkPath });
        }
      };
      visit(this.bookmarks.items, "");
    }
    sortSearchResults(results as Array<{ match: SearchResult }>);
    return results;
  }
  renderSuggestion(value: FileSuggestion | null, el: HTMLElement): void {
    el.classList.add("mod-complex");
    const content = el.createDiv("suggestion-content"), aux = el.createDiv("suggestion-aux");
    if (!value) {
      content.createDiv({ cls: "suggestion-title", text: this.inputEl.value });
      aux.createSpan({ cls: "suggestion-action", text: t("interface.label-enter-to-create") });
      return;
    }
    const title = content.createDiv("suggestion-title");
    let alias = "";
    const flair = (icon: string, label?: string) => aux.createSpan({ cls: "suggestion-flair" }, span => { this.app.setIcon(span, icon); if (label) span.setAttribute("aria-label", label); });
    if (value.type !== "unresolved" && value.type !== "bookmark" && value.downranked) el.classList.add("mod-downranked");
    if (value.type === "file") { renderResults(title, withoutMarkdownExtension(value.file.path), value.match); aux.createSpan({ cls: "suggestion-flair" }); }
    else if (value.type === "alias") {
      alias = value.alias;
      renderResults(title, value.alias, value.match);
      content.createDiv({ cls: "suggestion-note", text: withoutMarkdownExtension(value.file.path) });
      flair("lucide-forward", t("interface.tooltip.alias"));
    } else if (value.type === "unresolved") { renderResults(title, value.linktext, value.match); flair("lucide-file-plus", t("interface.tooltip.not-created-yet")); }
    else {
      const item = value.item, note = content.createDiv("suggestion-note");
      alias = item.title ?? "";
      renderResults(title, value.bookmarkPath, value.match);
      if (item.type === "file") { flair("lucide-bookmark"); note.textContent = withoutMarkdownExtension(item.path ?? "") + (item.subpath ?? ""); }
      else if (item.type === "folder") { flair("lucide-bookmark"); note.textContent = item.path ?? ""; }
      else if (item.type === "search") { flair("lucide-search"); note.textContent = item.query ?? ""; }
      else if (item.type === "graph") { flair("lucide-git-fork"); note.remove(); }
      else if (item.type === "url") { flair("globe-2"); note.textContent = item.url ?? ""; }
      else aux.createSpan({ cls: "suggestion-flair" });
    }
    const linktext = suggestionPath(value);
    if (!linktext) return;
    el.draggable = true;
    el.addEventListener("dragstart", event => {
      if (!event.dataTransfer) return;
      this.inputEl.focus({ preventScroll: true });
      event.dataTransfer.effectAllowed = "all";
      event.dataTransfer.setData("text/plain", `[[${linktext}${alias && alias !== linktext ? `|${alias}` : ""}]]`);
      for (const target of [el, this.containerEl]) target.classList.add("is-being-dragged");
      el.addEventListener("dragend", () => { for (const target of [el, this.containerEl]) target.classList.remove("is-being-dragged"); }, { once: true });
    });
  }
}

/** `aliases` of a note's properties, whatever the key's capitalisation; a single string counts as one alias. */
function fileAliases(frontmatter: Record<string, unknown> | undefined): string[] {
  if (!frontmatter) return [];
  const key = Object.keys(frontmatter).find(name => /^aliases$/i.test(name)), value = key ? frontmatter[key] : null;
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return list.map(item => item.trim()).filter(Boolean);
}

function bookmarkTitle(app: App, item: BookmarkItem): string {
  if (item.title) return item.title;
  const name = withoutMarkdownExtension(baseName(item.path ?? ""));
  if (item.type === "file" && item.subpath) return name + item.subpath;
  if (item.type === "file") { const file = app.vault.getAbstractFileByPath(item.path ?? ""); return file instanceof TFile ? (file.extension === "md" ? file.basename : file.name) : name; }
  if (item.type === "folder") return app.vault.getAbstractFileByPath(item.path ?? "")?.name ?? name;
  if (item.type === "search") return item.query ?? "";
  return item.title ?? "";
}

export interface SwitcherOptions { showExistingOnly?: boolean; showAttachments?: boolean; showAllFileTypes?: boolean }
const SWITCHER_DEFAULTS: Required<SwitcherOptions> = { showExistingOnly: false, showAttachments: true, showAllFileTypes: false };

/** Opens or creates notes by name; mirrors the reference quick switcher's modifiers. */
export class QuickSwitcherModal extends FileSuggestModal {
  constructor(app: App, actions: AppActions, bookmarks: BookmarkStore | null = sharedBookmarks) {
    super(app, actions, bookmarks);
    this.emptyStateText = t("plugins.quick-switcher.label-no-note-create-new");
    this.shouldShowNonFileBookmarks = true;
    this.allowCreateNewFile = true;
    this.applyOptions(SWITCHER_DEFAULTS);
    this.setPlaceholder(t("plugins.quick-switcher.prompt-type-file-name"));
    this.setInstructions([
      { command: "↑↓", purpose: t("plugins.quick-switcher.instruction-navigate") },
      { command: "↵", purpose: t("plugins.quick-switcher.instruction-open") },
      { command: isMac ? "⌘ ↵" : "ctrl ↵", purpose: t("plugins.quick-switcher.instruction-open-in-new-tab") },
      { command: isMac ? "⌘ ⌥ ↵" : "ctrl alt ↵", purpose: t("plugins.quick-switcher.instruction-open-to-the-right") },
      { command: "shift ↵", purpose: t("plugins.quick-switcher.instruction-create") },
      { command: "esc", purpose: t("plugins.quick-switcher.instruction-dismiss") },
    ]);
    // Later registrations win: Enter with any modifiers uses the selection, except with Shift, which always creates.
    const create = (event: KeyboardEvent) => { if (this.inputEl.value.trim()) this.selectSuggestion(null, event); return false; };
    this.scope.register(null, "Enter", event => { if (event.isComposing) return; this.selectActiveSuggestion(event); return false; });
    this.scope.register(["Shift"], "Enter", create);
    this.scope.register(["Mod", "Shift"], "Enter", create);
  }
  private applyOptions(options: SwitcherOptions): void {
    const { showExistingOnly, showAttachments, showAllFileTypes } = { ...SWITCHER_DEFAULTS, ...options };
    this.shouldShowUnresolved = !showExistingOnly;
    this.shouldShowNonImageAttachments = showAttachments;
    this.shouldShowImages = showAttachments;
    this.shouldShowAllTypes = showAllFileTypes;
  }
  override async onOpen(): Promise<void> {
    this.inputEl.focus();
    this.applyOptions(await readCorePluginData(this.actions.config.configDir, "switcher").catch(() => ({})));
    this.updateSuggestions();
  }
  onChooseSuggestion(value: FileSuggestion | null, event: MouseEvent | KeyboardEvent): void {
    const { actions } = this, pane = Keymap.isModEvent(event);
    const active = actions.workspace.activeLeaf?.view as { getViewType?(): string; file?: TFile | null } | undefined;
    const sourcePath = active?.getViewType?.() === "markdown" ? active.file?.path ?? "" : "";
    actions.run(async () => {
      if (!value) await this.app.workspace.openLinkText(this.inputEl.value, sourcePath, pane, { active: true });
      else if (value.type === "file" || value.type === "alias") await actions.openFile(value.file, pane);
      else if (value.type === "unresolved") await this.app.workspace.openLinkText(value.linktext, sourcePath, pane, { active: true });
      else await actions.openBookmark(value.item, pane);
    });
  }
}
