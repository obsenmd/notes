import { t } from "../i18n";
import { TFile } from "./vault";
import { ItemView, type WorkspaceLeaf } from "./workspace";

/** Built-in sidebar views: [title locale key, icon]. View type ids match the reference layout files. */
export const CORE_DOCK_VIEWS = {
  "file-explorer": ["plugins.file-explorer.name", "lucide-folder-closed"],
  search: ["plugins.search.name", "lucide-search"],
  bookmarks: ["plugins.bookmarks.name", "lucide-bookmark"],
  backlink: ["plugins.backlinks.name", "links-coming-in"],
  "outgoing-link": ["plugins.outgoing-links.name", "links-going-out"],
  tag: ["plugins.tag-pane.short-name", "lucide-tags"],
  outline: ["plugins.outline.name", "lucide-list"],
  "all-properties": ["plugins.properties.name-global", "lucide-archive"],
  "file-properties": ["plugins.properties.name-local", "lucide-info"],
} as const;
export type CoreDockType = keyof typeof CORE_DOCK_VIEWS;
export const CORE_VIEW_PLUGINS: Record<CoreDockType, string> = {
  "file-explorer": "file-explorer", search: "global-search", bookmarks: "bookmarks", backlink: "backlink",
  "outgoing-link": "outgoing-link", tag: "tag-pane", outline: "outline", "all-properties": "properties", "file-properties": "properties",
};
export const isCoreDockType = (type: string): type is CoreDockType => Object.hasOwn(CORE_DOCK_VIEWS, type);

const CORE_DOCK_DEFAULT_STATES: Partial<Record<CoreDockType, Record<string, unknown>>> = {
  search: { query: "", matchingCase: false, explainSearch: false, collapseAll: false, extraContext: false, sortOrder: "alphabetical" },
  backlink: { collapseAll: false, extraContext: false, sortOrder: "alphabetical", showSearch: false, searchQuery: "", backlinkCollapsed: false, unlinkedCollapsed: true },
  "outgoing-link": { linksCollapsed: false, unlinkedCollapsed: true },
  tag: { sortOrder: "frequency", useHierarchy: true, showSearch: false, searchQuery: "" },
  outline: { followCursor: false, showSearch: false, searchQuery: "" },
  "all-properties": { sortOrder: "frequency", showSearch: false, searchQuery: "" },
};

/** Views that show one file: they follow the active file unless their leaf is pinned or linked to another tab. */
const FILE_BOUND_TITLES: Partial<Record<CoreDockType, string>> = {
  backlink: "plugins.backlinks.tab-title", "outgoing-link": "plugins.outgoing-links.tab-title", outline: "plugins.outline.tab-title", "file-properties": "plugins.properties.tab-title",
};

/** A workspace leaf lifecycle boundary for built-in sidebar views; the host renders their content. */
export class CoreDockView extends ItemView {
  navigation = false;
  private state: Record<string, unknown> = {};
  private observedFile: TFile | null | undefined;
  private followedFile: TFile | null = null;
  constructor(leaf: WorkspaceLeaf, readonly type: CoreDockType) { super(leaf); this.headerEl.remove?.(); super.contentEl.remove?.(); }
  // Hosted content belongs to the persistent view portal. Explorer, search and
  // tags have no ItemView content area in the reference.
  override get contentEl(): HTMLElement { return this.containerEl.querySelector<HTMLElement>(":scope > .view-content") ?? undefined!; }
  getViewType() { return this.type; }
  get followsFile(): boolean { return Object.hasOwn(FILE_BOUND_TITLES, this.type); }
  get isLeafBoundToFile(): boolean { return this.followsFile && (this.leaf.pinned || !!this.leaf.group); }
  /** The file a file-bound view is showing (named so it is not mistaken for a file view's `file`). */
  getBoundFile(): TFile | null {
    if (!this.followsFile) return null;
    const workspace = this.app.workspace;
    const active = workspace.getActiveFile();
    if (this.observedFile === undefined || this.observedFile !== active) {
      this.observedFile = active;
      if (!this.isLeafBoundToFile) this.followedFile = active;
    }
    const retainDeleted = this.type === "outline" || this.type === "file-properties";
    if (!retainDeleted && this.followedFile && this.app.vault.getFileByPath(this.followedFile.path) !== this.followedFile) this.followedFile = null;
    if (this.followedFile) this.state.file = this.followedFile.path; else delete this.state.file;
    return this.followedFile;
  }
  getDisplayText() {
    const file = this.isLeafBoundToFile ? this.getBoundFile() : null;
    return file ? t(FILE_BOUND_TITLES[this.type]!, { displayText: file.basename }) : t(CORE_DOCK_VIEWS[this.type][0]);
  }
  getIcon() { return CORE_DOCK_VIEWS[this.type][1]; }
  getState() {
    if (this.followsFile) this.getBoundFile();
    return { ...CORE_DOCK_DEFAULT_STATES[this.type], ...this.state };
  }
  async setState(state: unknown) {
    this.state = state && typeof state === "object" ? { ...state as Record<string, unknown> } : {};
    this.followedFile = typeof this.state.file === "string" ? this.app.vault.getFileByPath(this.state.file) : null;
    this.observedFile = Object.hasOwn(this.state, "file") ? this.app.workspace.getActiveFile() : undefined;
    this.app.workspace.trigger("core-view-state-change", this.leaf);
  }
}
