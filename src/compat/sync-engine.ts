/**
 * Initial one-shot Sync transfer built on the observed socket protocol.
 * This deliberately does not implement continuous watchers, three-way merge,
 * rename lineage, or durable per-file sync state. See protocol.md for the
 * boundary between this initial transfer and the full desktop client.
 */
import { Vault, TFile, TFolder } from "./vault";
import { SyncSocketClient, type InitSyncInput, type SyncPushEntry } from "./sync-client";
import type { SyncEncryptionProvider } from "./sync-crypto";

export interface SyncInitialTransferOptions {
  socket: SyncSocketClient;
  vault: Vault;
  encryption: SyncEncryptionProvider;
  init: Omit<InitSyncInput, "initial">;
  /** On a same-path initial conflict, defaults to the remote copy. */
  conflictPolicy?: "remote" | "local";
  /** Injectable digest for deterministic tests and alternate crypto runtimes. */
  digest?: (bytes: Uint8Array) => Promise<string>;
  include?: (path: string) => boolean;
}

export interface SyncInitialTransferResult {
  pulled: string[];
  uploaded: string[];
  deleted: string[];
  conflicts: string[];
  ignored: string[];
}

type RemoteEntry = SyncPushEntry & { path: string; uid?: string | number };

/** Performs one initial remote replay, tombstone reconciliation and transfer. */
export class SyncInitialTransferEngine {
  private readonly digest: (bytes: Uint8Array) => Promise<string>;
  constructor(private readonly options: SyncInitialTransferOptions) {
    this.digest = options.digest ?? sha256;
  }

  async run(): Promise<SyncInitialTransferResult> {
    const result: SyncInitialTransferResult = { pulled: [], uploaded: [], deleted: [], conflicts: [], ignored: [] };
    const announced: SyncPushEntry[] = [];
    // Subscribe before init: an initial server replay can arrive before ready.
    const unsubscribe = this.options.socket.subscribeToPushes(entry => announced.push({ ...entry }));
    try {
      await this.options.socket.initialize({ ...this.options.init, initial: true });
      await this.options.socket.waitUntilReady();

      const latest = new Map<string, RemoteEntry>();
      for (const item of announced) {
        const decoded = await this.decodeEntry(item);
        if (decoded) latest.set(decoded.path, decoded);
      }
      const deletedResponse = await this.options.socket.deleted();
      const tombstones = Array.isArray(deletedResponse.items) ? deletedResponse.items : [];
      for (const item of tombstones) {
        if (!isRecord(item)) continue;
        const decoded = await this.decodeEntry(item as SyncPushEntry);
        if (decoded) latest.set(decoded.path, { ...decoded, deleted: true });
      }

      // Remote tombstones suppress stale local files on a fresh initial sync.
      for (const entry of latest.values()) {
        if (!entry.deleted) continue;
        const local = this.options.vault.getAbstractFileByPath(entry.path);
        if (!local) continue;
        await this.options.vault.delete(local);
        result.deleted.push(entry.path);
      }

      // Create remote folders from shallowest to deepest before pulling files.
      const remoteFolders = [...latest.values()]
        .filter(entry => entry.folder && !entry.deleted)
        .sort((a, b) => depth(a.path) - depth(b.path));
      for (const entry of remoteFolders) {
        if (!safeVaultPath(entry.path)) { result.ignored.push(entry.path); continue; }
        await this.ensureFolders(entry.path, false);
      }

      for (const entry of latest.values()) {
        if (entry.deleted || entry.folder) continue;
        if (!safeVaultPath(entry.path) || entry.uid === undefined || entry.uid === null) {
          result.ignored.push(entry.path);
          continue;
        }
        const local = this.options.vault.getAbstractFileByPath(entry.path);
        if (local && !(local instanceof TFile)) { result.conflicts.push(entry.path); continue; }
        const localFile = local instanceof TFile ? local : null;
        let localHash: string | undefined;
        if (localFile) {
          const localBytes = new Uint8Array(await this.options.vault.readBinary(localFile));
          localHash = await this.options.encryption.deterministicEncodeStr(await this.digest(localBytes));
          if (localHash === entry.hash) continue;
        }
        if (localFile && this.options.conflictPolicy === "local") {
          await this.uploadFile(localFile);
          result.uploaded.push(entry.path);
          continue;
        }
        if (localFile) {
          const dot = entry.path.lastIndexOf("."), suffix = `.sync-conflict-${Date.now()}`;
          const conflict = dot > entry.path.lastIndexOf("/") ? entry.path.slice(0, dot) + suffix + entry.path.slice(dot) : entry.path + suffix;
          await this.options.vault.createBinary(conflict, await this.options.vault.readBinary(localFile));
        }
        const encrypted = await this.options.socket.pull(String(entry.uid));
        const encryptedBuffer = encrypted.slice().buffer as ArrayBuffer;
        const clear = new Uint8Array(await this.options.encryption.decrypt(encryptedBuffer));
        await this.ensureFolders(entry.path, true);
        const existing = this.options.vault.getFileByPath(entry.path);
        if (existing) await this.options.vault.modifyBinary(existing, clear.buffer as ArrayBuffer, { ctime: entry.ctime, mtime: entry.mtime });
        else await this.options.vault.createBinary(entry.path, clear.buffer as ArrayBuffer, { ctime: entry.ctime, mtime: entry.mtime });
        result.pulled.push(entry.path);
        if (localFile) result.conflicts.push(entry.path);
      }

      // Upload local files/folders missing on the remote. Existing remote paths
      // win unless callers explicitly choose the local conflict policy above.
      const remotePaths = new Set([...latest.values()].filter(entry => !entry.deleted).map(entry => entry.path));
      const folders = this.options.vault.getAllFolders().sort((a, b) => depth(a.path) - depth(b.path));
      for (const folder of folders) {
        if (this.options.include && !this.options.include(folder.path)) continue;
        if (remotePaths.has(folder.path)) continue;
        await this.options.socket.push({
          path: await this.options.encryption.deterministicEncodeStr(folder.path),
          hash: "", ctime: 0, mtime: 0, folder: true,
        });
        result.uploaded.push(folder.path);
      }
      for (const file of this.options.vault.getFiles()) {
        if (this.options.include && !this.options.include(file.path)) continue;
        const remote = latest.get(file.path);
        if (remote && !remote.deleted) {
          // A remote folder or incompatible entry at the same path is a real conflict.
          if (remote.folder) result.conflicts.push(file.path);
          continue;
        }
        await this.uploadFile(file);
        result.uploaded.push(file.path);
      }
      await this.options.vault.refresh();
      return result;
    } finally { unsubscribe(); }
  }

  private async decodeEntry(entry: SyncPushEntry): Promise<RemoteEntry | null> {
    if (typeof entry.path !== "string") return null;
    let path: string;
    try { path = await this.options.encryption.deterministicDecodeStr(entry.path); }
    catch { return null; }
    if (!safeVaultPath(path)) return null;
    if (this.options.include && !this.options.include(path)) return null;
    return { ...entry, path, uid: typeof entry.uid === "string" || typeof entry.uid === "number" ? entry.uid : undefined };
  }

  private async uploadFile(file: TFile): Promise<void> {
    const bytes = new Uint8Array(await this.options.vault.readBinary(file));
    const hash = await this.options.encryption.deterministicEncodeStr(await this.digest(bytes));
    const encrypted = new Uint8Array(await this.options.encryption.encrypt(bytes));
    const extension = file.extension.toLowerCase();
    await this.options.socket.push({
      path: await this.options.encryption.deterministicEncodeStr(file.path),
      extension, hash, ctime: file.stat.ctime, mtime: file.stat.mtime,
      bytes: encrypted,
    });
  }

  private async ensureFolders(path: string, includeSelf: boolean): Promise<void> {
    const parts = path.split("/");
    const folders = includeSelf ? parts.slice(0, -1) : parts;
    let current = "";
    for (const part of folders) {
      current = current ? `${current}/${part}` : part;
      if (!this.options.vault.getAbstractFileByPath(current)) {
        try { await this.options.vault.createFolder(current); }
        catch (error) {
          // A file at an ancestor path is a conflict; do not overwrite it.
          if (!(this.options.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
        }
      }
    }
  }
}

function safeVaultPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every(part => part.length > 0 && part !== "." && part !== "..");
}
function depth(path: string): number { return path.split("/").length; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
