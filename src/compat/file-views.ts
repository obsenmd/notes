import { Editor } from "./editor";
import { registerFileViewType } from "./file-view-type";
import type { TAbstractFile, TFile } from "./vault";
import { ItemView, type ViewStateResult } from "./workspace";

/** A view that displays one vault file and participates in file navigation. */
export abstract class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  navigation = true;

  constructor(leaf: ConstructorParameters<typeof ItemView>[0]) { super(leaf); }

  override getDisplayText(): string { return this.file?.basename ?? this.getViewType(); }
  override getState(): Record<string, unknown> { return { ...super.getState(), file: this.file?.path ?? null }; }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const path = state && typeof state === "object" && "file" in state ? (state as { file?: unknown }).file : null;
    const next = typeof path === "string" ? this.app.vault.getFileByPath(path) : null;
    if (!next && !this.allowNoFile) return;
    if (this.file?.path === next?.path) {
      if (!(state as { sync?: unknown } | null)?.sync && (result.history || result.layout)) result.done = () => this.syncState();
      return;
    }
    const previous = this.file;
    if (previous) await this.onUnloadFile(previous);
    this.file = next;
    result.history = true;
    if (next) await this.onLoadFile(next);
    await super.setState(state, result);
    if (!(state as { sync?: unknown } | null)?.sync && (result.history || result.layout)) result.done = () => this.syncState();
  }

  /** Synchronize linked file views without changing peers' source/reading mode. */
  syncState(): void {
    if (!this.leaf.group) return;
    for (const leaf of this.app.workspace.getGroupLeaves(this.leaf.group)) if (leaf !== this.leaf && leaf.view instanceof FileView) leaf.view.receiveSyncState(this);
  }
  receiveSyncState(source: FileView): void {
    if (this.file !== source.file) {
      if (source.file) void this.leaf.openFile(source.file, { eState: source.getEphemeralState() }).catch(error => console.error(error));
    } else this.setEphemeralState(source.getEphemeralState());
  }

  override onload(): void { super.onload(); }
  override async onClose(): Promise<void> {
    if (this.file) {
      const previous = this.file;
      try { await this.onUnloadFile(previous); }
      finally { this.file = null; }
    }
    await super.onClose();
  }

  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async onRename(file: TFile): Promise<void> { if (this.file?.path === file.path) this.file = file; }
  async onDelete(file: TAbstractFile): Promise<void> {
    if (file !== this.file) return;
    const leaf = this.leaf;
    if (this.allowNoFile) await this.setState({ ...this.getState(), file: null }, { history: false });
    else {
      if (leaf.history.backHistory.length) await leaf.history.back();
      else await leaf.setViewState({ type: "empty" });
      if (leaf.view.getViewType() === "empty" && (leaf.parent?.children.length ?? 0) > 1) leaf.detach();
    }
    leaf.workspace.onLeafViewChanged(leaf); leaf.workspace.notifyLayoutChange();
  }
  canAcceptExtension(_extension: string): boolean { return false; }
}

/** Base for file views that edit their contents. */
export abstract class EditableFileView extends FileView {
  readonly editor: Editor;
  constructor(leaf: ConstructorParameters<typeof ItemView>[0]) {
    super(leaf);
    this.editor = new Editor();
  }
}

/** Text-backed file view with debounced persistence and subclass-owned rendering. */
export abstract class TextFileView extends EditableFileView {
  data = "";
  private savedData = "";
  private saveQueue: Promise<void> = Promise.resolve();
  get isDirty(): boolean { return this.getViewData() !== this.savedData; }
  acceptExternalChange(data: string): void { this.savedData = data; this.data = data; this.setViewData(data, false); }
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  readonly requestSave = (): void => {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch((error) => console.error("Failed to save text view", error));
    }, 2000);
  };

  override async onLoadFile(file: TFile): Promise<void> {
    this.clear();
    this.data = await this.app.vault.read(file);
    this.savedData = this.data;
    this.setViewData(this.data, true);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await this.save();
    await super.onUnloadFile(file);
  }

  async save(clear = false): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.file;
    if (file) {
      const data = this.getViewData();
      if (data !== this.savedData) {
        this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
          await this.app.vault.modify(file, data);
          this.savedData = data;
        });
        await this.saveQueue;
      }
    }
    if (clear) this.clear();
  }

  override async onClose(): Promise<void> {
    try { await super.onClose(); }
    finally { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = null; }
  }

  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;
}

registerFileViewType(FileView);
