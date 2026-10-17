import { fs, fsp, path, process } from "../../platforms/platform";
import type { FSWatcher, Stats } from "node:fs";
import { TFile, TFolder, type TAbstractFile, type Vault } from "./vault";
import { NodeDataAdapter } from "./node-adapter";

export interface VaultFileWatcherOptions {
  /** Quiet period after the last native event before reconciling. Defaults to 120 ms. */
  debounceMs?: number;
  /** Include the application's configuration folder. It is ignored by default. */
  includeConfig?: boolean;
  /** Additional relative paths or path prefixes to exclude. */
  ignore?: string[];
  /** Called when a watcher or reconciliation operation fails. */
  onError?: (error: Error) => void;
}

interface SnapshotEntry {
  path: string;
  type: "file" | "folder";
  size: number;
  mtime: number;
  ctime: number;
  identity: string;
}

/**
 * Bridges native filesystem notifications into Vault events. Native watcher
 * events are hints only: a debounced tree scan is used to handle coalesced,
 * duplicated, and platform-specific rename notifications consistently.
 */
export class VaultFileWatcher {
  private readonly adapter: NodeDataAdapter;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly ignored: string[];
  private readonly debounceMs: number;
  private readonly onError?: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snapshot = new Map<string, SnapshotEntry>();
  private running = false;
  private reconciling = false;
  private rerun = false;
  private readonly suppressedUntil = new Map<string, number>();

  constructor(private readonly vault: Vault, options: VaultFileWatcherOptions = {}) {
    if (!(vault.adapter instanceof NodeDataAdapter)) {
      throw new TypeError("VaultFileWatcher requires a NodeDataAdapter-backed vault.");
    }
    this.adapter = vault.adapter;
    this.debounceMs = Math.max(0, options.debounceMs ?? 120);
    this.onError = options.onError;
    this.ignored = [
      ...(options.includeConfig ? [] : [vault.configDir]),
      ".trash",
      ...(options.ignore ?? []),
    ].map(normalizeRelative).filter(Boolean);
  }

  /** Start monitoring. The vault should have been initialized first. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.snapshot = await this.scan();
      await this.syncWatchers();
    } catch (error) {
      this.running = false;
      this.closeWatchers();
      throw error;
    }
  }

  /** Stop monitoring and discard any pending debounce work. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.closeWatchers();
    this.suppressedUntil.clear();
  }

  dispose(): void { this.stop(); }

  /**
   * Suppress a write initiated by this process from producing a later modify
   * event. The next reconciliation still refreshes file stats and the tree.
   */
  suppressNextChange(vaultPath: string, durationMs = 1500): void {
    const normalized = normalizeRelative(vaultPath);
    this.suppressedUntil.set(normalized, Date.now() + Math.max(0, durationMs));
  }

  /** Request a reconciliation after callers perform an out-of-band operation. */
  refresh(): void { this.schedule(); }

  private schedule(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile();
    }, this.debounceMs);
  }

  private async reconcile(): Promise<void> {
    if (!this.running) return;
    if (this.reconciling) { this.rerun = true; return; }
    this.reconciling = true;
    try {
      const next = await this.scan();
      const previous = this.snapshot;
      const previousObjects = new Map(this.vault.getAllLoadedFiles().map(file => [file.path, file]));
      this.snapshot = next;
      await this.syncWatchers();
      await this.vault.refresh();
      this.emitDiff(previous, next, previousObjects);
    } catch (error) {
      this.onError?.(asError(error));
      this.vault.trigger("watch-error", asError(error));
    } finally {
      this.reconciling = false;
      if (this.rerun) { this.rerun = false; this.schedule(); }
    }
  }

  private emitDiff(previous: Map<string, SnapshotEntry>, next: Map<string, SnapshotEntry>, previousObjects: Map<string, TAbstractFile>): void {
    const removed = [...previous.values()].filter(entry => !next.has(entry.path));
    const added = [...next.values()].filter(entry => !previous.has(entry.path));

    // Where the filesystem provides stable file IDs, turn a remove/add pair
    // into a rename event. Editors commonly save via temp-file replacement;
    // a changed ID at the same path is consequently reported as modify.
    const addedByIdentity = new Map<string, SnapshotEntry[]>();
    for (const item of added) {
      if (!item.identity) continue;
      const group = addedByIdentity.get(item.identity) ?? [];
      group.push(item);
      addedByIdentity.set(item.identity, group);
    }
    const renamedOld = new Set<string>();
    const renamedNew = new Set<string>();
    for (const old of removed) {
      if (!old.identity) continue;
      const match = addedByIdentity.get(old.identity)?.find(item => !renamedNew.has(item.path));
      if (!match) continue;
      const file = this.vault.getAbstractFileByPath(match.path);
      if (file) this.vault.trigger("rename", file, old.path);
      renamedOld.add(old.path);
      renamedNew.add(match.path);
    }

    for (const old of removed) {
      if (renamedOld.has(old.path) || this.isSuppressed(old.path)) continue;
      const file = previousObjects.get(old.path) ?? null;
      // Vault.refresh has removed deleted objects from its index. Build a
      // lightweight event target with the same shape for plugin listeners.
      const target = file ?? makeDetachedEntry(this.vault, old);
      this.vault.trigger("delete", target);
    }
    for (const item of added) {
      if (renamedNew.has(item.path) || this.isSuppressed(item.path)) continue;
      const file = this.vault.getAbstractFileByPath(item.path);
      if (file) this.vault.trigger("create", file);
    }

    for (const [entryPath, current] of next) {
      const before = previous.get(entryPath);
      if (!before || current.type !== "file" || before.type !== "file") continue;
      if (before.size === current.size && before.mtime === current.mtime) continue;
      if (this.isSuppressed(entryPath)) continue;
      const file = this.vault.getFileByPath(entryPath);
      if (file) this.vault.trigger("modify", file);
    }
    const now = Date.now();
    for (const [entryPath, until] of this.suppressedUntil) if (until <= now) this.suppressedUntil.delete(entryPath);
  }

  private isSuppressed(entryPath: string): boolean {
    const until = this.suppressedUntil.get(entryPath);
    return until !== undefined && until > Date.now();
  }

  private async scan(): Promise<Map<string, SnapshotEntry>> {
    const found = new Map<string, SnapshotEntry>();
    const root = this.adapter.basePath;
    const walk = async (absolute: string, relative: string): Promise<void> => {
      let children: import("node:fs").Dirent[];
      try { children = await fsp.readdir(absolute, { withFileTypes: true }); }
      catch (error) {
        if (relative && isMissing(error)) return;
        throw error;
      }
      for (const child of children) {
        const childRelative = relative ? `${relative}/${child.name}` : child.name;
        if (this.isIgnored(childRelative)) continue;
        const childAbsolute = path.join(absolute, child.name);
        let stat: Stats;
        try { stat = await fsp.lstat(childAbsolute); }
        catch (error) { if (isMissing(error)) continue; throw error; }
        if (stat.isSymbolicLink()) continue;
        if (!stat.isDirectory() && !stat.isFile()) continue;
        found.set(childRelative, {
          path: childRelative,
          type: stat.isDirectory() ? "folder" : "file",
          size: stat.size,
          mtime: stat.mtimeMs,
          ctime: stat.birthtimeMs,
          identity: stat.ino ? `${stat.dev}:${stat.ino}` : "",
        });
        if (stat.isDirectory()) await walk(childAbsolute, childRelative);
      }
    };
    await walk(root, "");
    return found;
  }

  private async syncWatchers(): Promise<void> {
    if (!this.running) return;
    const directories = new Set<string>([this.adapter.basePath]);
    for (const entry of this.snapshot.values()) {
      if (entry.type === "folder") directories.add(path.join(this.adapter.basePath, ...entry.path.split("/")));
    }
    for (const [watched, watcher] of this.watchers) {
      if (!directories.has(watched)) { watcher.close(); this.watchers.delete(watched); }
    }
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = fs.watch(directory, { persistent: false }, () => this.schedule());
        watcher.on("error", error => {
          this.watchers.delete(directory);
          watcher.close();
          this.onError?.(error);
          this.schedule();
        });
        this.watchers.set(directory, watcher);
      } catch (error) {
        // A directory can disappear between scanning and registering; the next
        // parent event will bring the watcher set back in sync.
        if (!isMissing(error)) this.onError?.(asError(error));
      }
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private isIgnored(relative: string): boolean {
    const value = normalizeRelative(relative).toLocaleLowerCase();
    return this.ignored.some(prefix => value === prefix.toLocaleLowerCase() || value.startsWith(`${prefix.toLocaleLowerCase()}/`));
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function makeDetachedEntry(vault: Vault, entry: SnapshotEntry): TAbstractFile {
  const file = entry.type === "folder"
    ? new TFolder(vault, entry.path)
    : new TFile(vault, entry.path, { ctime: entry.ctime, mtime: entry.mtime, size: entry.size });
  return file;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code));
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
