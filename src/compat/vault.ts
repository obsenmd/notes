import { process } from "../../platforms/platform";
import { t } from "../i18n";
import { Events, type EventRef } from "./events";

const isHiddenPath = (value: string): boolean => value.split("/").some(part => part.startsWith("."));

export interface Stat {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

export interface FileStats { ctime: number; mtime: number; size: number }
export interface ListedFiles { files: string[]; folders: string[] }
export interface DataWriteOptions { ctime?: number; mtime?: number }
export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

/** Adapter contract used by Vault to access a backing store. */
export interface DataAdapter {
  getName(): string;
  getFullPath(path: string): string;
  exists(path: string, sensitive?: boolean): Promise<boolean>;
  stat(path: string): Promise<Stat | null>;
  list(path: string): Promise<ListedFiles>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string, options?: DataWriteOptions): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  append(path: string, data: string, options?: DataWriteOptions): Promise<void>;
  appendBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  process(path: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
  getResourcePath(path: string): string;
  mkdir(path: string): Promise<void>;
  trashSystem(path: string): Promise<boolean>;
  trashLocal(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  copy(path: string, newPath: string): Promise<void>;
}

export abstract class TAbstractFile {
  vault!: Vault;
  path: string;
  name: string;
  parent: TFolder | null = null;

  protected constructor(vault: Vault, path: string) {
    this.vault = vault;
    this.path = normalizePath(path);
    this.name = basename(this.path);
  }
}

export class TFile extends TAbstractFile {
  stat: FileStats;
  basename: string;
  extension: string;

  constructor(vault: Vault, path: string, stat: FileStats = emptyStats()) {
    super(vault, path);
    const dot = this.name.lastIndexOf(".");
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.stat = { ...stat };
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  constructor(vault: Vault, path: string) { super(vault, path); }
  isRoot(): boolean { return this.path === "/" || this.path === ""; }
}

/**
 * Vault facade over a DataAdapter. Call `initialize()` (or `refresh()`) to
 * populate the synchronous in-memory tree used by lookup and metadata APIs.
 */
export class Vault extends Events {
  readonly adapter: DataAdapter;
  readonly configDir: string;
  private readonly vaultName: string;
  private readonly filesByPath = new Map<string, TAbstractFile>();
  private readonly root: TFolder;
  private initialized = false;

  constructor(adapter: DataAdapter, name = adapter.getName(), configDir = ".obsidian") {
    super();
    this.adapter = adapter;
    this.vaultName = name;
    this.configDir = configDir;
    this.root = new TFolder(this, "");
    this.root.path = "/";
    this.filesByPath.set("", this.root);
  }

  getName(): string { return this.vaultName; }
  /** @internal Backing store for `getConfig` / `setConfig`, supplied by the host (app.json and appearance.json). */
  configStore: { getRaw(key: string): unknown; setRaw(key: string, value: unknown): void } | null = null;
  /** A vault setting by its key in the configuration files (for example `attachmentFolderPath`). */
  getConfig(key: string): unknown { return this.configStore?.getRaw(key); }
  setConfig(key: string, value: unknown): void { this.configStore?.setRaw(key, value); }
  getAvailablePath(base: string, extension = ""): string {
    const suffix = extension ? `.${extension}` : "";
    const exists = (target: string) => this.getAllLoadedFiles().some(file => file.path.toLowerCase() === target.toLowerCase());
    let target = `${base}${suffix}`, index = 1;
    while (exists(target)) target = `${base} ${index++}${suffix}`;
    return target;
  }

  /** Populate the initial in-memory tree and announce the entries already in the vault. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.refresh();
    this.initialized = true;
    // Obsidian's vault create event includes pre-existing files and folders
    // when the vault is first loaded. Keep this behavior in initialize rather
    // than refresh: watcher reconciliation emits its own create/delete diff.
    for (const file of descendants(this.root)) this.trigger("create", file);
  }

  async refresh(): Promise<void> {
    const seen = new Set<string>([""]);
    const walk = async (folder: TFolder): Promise<void> => {
      const listed = await this.adapter.list(folder.path);
      const children: TAbstractFile[] = [];
      for (const name of listed.folders) {
        const path = normalizePath(name);
        if (path === ".trash" || path === this.configDir) continue;
        seen.add(path);
        let child = this.filesByPath.get(path);
        if (!(child instanceof TFolder)) child = this.makeFolder(path);
        child.parent = folder;
        children.push(child);
      }
      for (const name of listed.files) {
        const path = normalizePath(name);
        if (path === ".trash" || path === this.configDir) continue;
        seen.add(path);
        const stat = await this.adapter.stat(path);
        let child = this.filesByPath.get(path);
        if (!(child instanceof TFile)) child = this.makeFile(path, toFileStats(stat));
        else if (stat) child.stat = toFileStats(stat);
        child.parent = folder;
        children.push(child);
      }
      folder.children = children;
      for (const child of children) if (child instanceof TFolder) await walk(child);
    };
    await walk(this.root);
    for (const [path, entry] of [...this.filesByPath]) {
      if (path && !seen.has(path)) this.filesByPath.delete(path);
    }
  }

  getFileByPath(path: string): TFile | null {
    const entry = this.getAbstractFileByPath(path);
    return entry instanceof TFile ? entry : null;
  }
  getFolderByPath(path: string): TFolder | null {
    const entry = this.getAbstractFileByPath(path);
    return entry instanceof TFolder ? entry : null;
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (path === "/") return this.root;
    return path ? this.filesByPath.get(path) ?? null : null;
  }
  getRoot(): TFolder { return this.root; }

  async create(path: string, data: string, options?: DataWriteOptions): Promise<TFile> {
    const normalized = normalizePath(path);
    this.assertNewPath(normalized);
    await this.adapter.write(normalized, data, options);
    const file = this.makeFile(normalized, await this.fileStats(normalized));
    this.attach(file);
    this.trigger("create", file);
    return file;
  }

  async createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<TFile> {
    const normalized = normalizePath(path);
    this.assertNewPath(normalized);
    await this.adapter.writeBinary(normalized, data, options);
    const file = this.makeFile(normalized, await this.fileStats(normalized));
    this.attach(file);
    this.trigger("create", file);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    const normalized = normalizePath(path);
    this.assertNewPath(normalized);
    await this.adapter.mkdir(normalized);
    const folder = this.makeFolder(normalized);
    this.attach(folder);
    this.trigger("create", folder);
    return folder;
  }

  read(file: TFile): Promise<string> { return this.adapter.read(file.path); }
  cachedRead(file: TFile): Promise<string> { return this.read(file); }
  readBinary(file: TFile): Promise<ArrayBuffer> { return this.adapter.readBinary(file.path); }
  getResourcePath(file: TFile): string { return this.adapter.getResourcePath(file.path); }

  async modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    await this.adapter.write(file.path, data, options);
    await this.updateStat(file);
    this.trigger("modify", file);
  }
  async modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    await this.adapter.writeBinary(file.path, data, options);
    await this.updateStat(file);
    this.trigger("modify", file);
  }
  async append(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    await this.adapter.append(file.path, data, options);
    await this.updateStat(file);
    this.trigger("modify", file);
  }
  async appendBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    await this.adapter.appendBinary(file.path, data, options);
    await this.updateStat(file);
    this.trigger("modify", file);
  }
  async process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
    const data = await this.adapter.process(file.path, fn, options);
    await this.updateStat(file);
    this.trigger("modify", file);
    return data;
  }

  async delete(file: TAbstractFile, _force = false): Promise<void> {
    await this.removeFromAdapter(file);
    this.detach(file);
    this.trigger("delete", file);
  }
  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    if (system && await this.adapter.trashSystem(file.path)) {
      this.detach(file);
      this.trigger("delete", file);
      return;
    }
    await this.adapter.trashLocal(file.path);
    this.detach(file);
    this.trigger("delete", file);
  }
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const normalized = normalizePath(newPath);
    this.assertNewPath(normalized, file);
    const oldPath = file.path;
    // The item itself moves along with everything inside it.
    const entries = [file, ...descendants(file)];
    await this.adapter.rename(oldPath, normalized);
    this.detach(file, false);
    for (const entry of entries) {
      const previous = entry.path;
      const suffix = previous === oldPath ? "" : previous.slice(oldPath.length + 1);
      const updated = suffix ? joinPath(normalized, suffix) : normalized;
      this.filesByPath.delete(previous);
      entry.path = updated;
      entry.name = basename(updated);
      if (entry instanceof TFile) {
        const dot = entry.name.lastIndexOf(".");
        entry.extension = dot > 0 ? entry.name.slice(dot + 1) : "";
        entry.basename = dot > 0 ? entry.name.slice(0, dot) : entry.name;
      }
      this.filesByPath.set(updated, entry);
    }
    this.attach(file);
    this.trigger("rename", file, oldPath);
  }
  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    const normalized = normalizePath(newPath);
    this.assertNewPath(normalized);
    await this.adapter.copy(file.path, normalized);
    await this.refresh();
    const copy = this.getAbstractFileByPath(normalized);
    if (!copy || (file instanceof TFile) !== (copy instanceof TFile)) throw new Error(t("obsen.errors.copied-item-unavailable"));
    this.trigger("create", copy);
    return copy as T;
  }

  getAllLoadedFiles(): TAbstractFile[] { return [this.root, ...descendants(this.root)]; }
  getAllFolders(includeRoot = false, includeHidden = false): TFolder[] {
    return this.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && (includeRoot || !file.isRoot()) && (includeHidden || !isHiddenPath(file.path)));
  }
  getMarkdownFiles(includeHidden = false): TFile[] { return this.getFiles(includeHidden).filter(file => file.extension.toLowerCase() === "md"); }
  getFiles(includeHidden = false): TFile[] { return this.getAllLoadedFiles().filter((file): file is TFile => file instanceof TFile && (includeHidden || !isHiddenPath(file.path))); }

  on(name: "create" | "modify" | "delete", callback: (file: TAbstractFile) => unknown, ctx?: unknown): EventRef;
  on(name: "rename", callback: (file: TAbstractFile, oldPath: string) => unknown, ctx?: unknown): EventRef;
  on(name: string, callback: (...data: any[]) => any, ctx?: unknown): EventRef {
    return super.on(name, callback, ctx);
  }

  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => unknown): void {
    for (const child of root.children) { cb(child); if (child instanceof TFolder) Vault.recurseChildren(child, cb); }
  }

  private makeFile(path: string, stat: FileStats): TFile {
    const file = new TFile(this, path, stat);
    this.filesByPath.set(file.path, file);
    return file;
  }
  private makeFolder(path: string): TFolder {
    const folder = new TFolder(this, path);
    this.filesByPath.set(folder.path, folder);
    return folder;
  }
  private attach(file: TAbstractFile): void {
    const parentPath = dirname(file.path);
    const parent = this.filesByPath.get(parentPath);
    if (!(parent instanceof TFolder)) throw new Error(t("obsen.errors.parent-folder-missing", { parentPath }));
    file.parent = parent;
    if (!parent.children.includes(file)) parent.children.push(file);
  }
  private detach(file: TAbstractFile, removeDescendants = true): void {
    file.parent?.children.splice(file.parent.children.indexOf(file), 1);
    for (const entry of removeDescendants ? [file, ...descendants(file)] : [file]) this.filesByPath.delete(entry.path);
  }
  private assertNewPath(path: string, moving?: TAbstractFile): void {
    if (!path || path === "." || path.startsWith("../") || path === "..") throw new Error(t("obsen.errors.invalid-vault-path"));
    const existing = this.getAbstractFileByPath(path);
    if (existing && existing !== moving) throw new Error(t("obsen.errors.path-exists", { path }));
    const parentPath = dirname(path);
    if (!(this.filesByPath.get(parentPath) instanceof TFolder)) throw new Error(t("obsen.errors.parent-folder-missing", { parentPath }));
  }
  private async removeFromAdapter(file: TAbstractFile): Promise<void> {
    if (file instanceof TFolder) await this.adapter.rmdir(file.path, true);
    else await this.adapter.remove(file.path);
  }
  private async fileStats(path: string): Promise<FileStats> { return toFileStats(await this.adapter.stat(path)); }
  private async updateStat(file: TFile): Promise<void> { file.stat = await this.fileStats(file.path); }
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new Error(t("obsen.errors.path-outside-vault")); parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}
function joinPath(parent: string, child: string): string { return normalizePath(parent ? `${parent}/${child}` : child); }
function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function dirname(path: string): string { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); }
function descendants(folder: TFolder | TAbstractFile): TAbstractFile[] {
  if (!(folder instanceof TFolder)) return [];
  return folder.children.flatMap(child => [child, ...descendants(child)]);
}
function emptyStats(): FileStats { return { ctime: Date.now(), mtime: Date.now(), size: 0 }; }
function toFileStats(stat: Stat | null): FileStats {
  return stat ? { ctime: stat.ctime, mtime: stat.mtime, size: stat.size } : emptyStats();
}
