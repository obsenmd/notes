import { Buffer } from "../../platforms/platform";
import { TFile, TFolder } from "./vault";
import type { EventRef } from "./events";
import { SyncInitialTransferEngine, type SyncInitialTransferOptions } from "./sync-engine";
import type { SyncPushEntry } from "./sync-client";

export interface SyncCheckpoint { hashes: Record<string, string>; pending: string[]; }
export interface ContinuousSyncOptions extends SyncInitialTransferOptions {
  include?: (path: string) => boolean;
  loadState?: () => Promise<SyncCheckpoint | null>;
  saveState?: (state: SyncCheckpoint) => Promise<void>;
  onError?: (error: Error) => void;
  onActivity?: (action: "upload" | "delete" | "download" | "merge", path: string) => void;
  reconnectDelay?: number;
}

/** Serialized continuous transfers with durable outbound retries and preserved conflicts. */
export class ContinuousSyncEngine {
  private running = false;
  private applying = false;
  private queue: Promise<void> = Promise.resolve();
  private refs: EventRef[] = [];
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private state: SyncCheckpoint = { hashes: {}, pending: [] };
  constructor(private readonly options: ContinuousSyncOptions) {}
  async start() {
    if (this.running) return;
    this.state = await this.options.loadState?.() ?? this.state;
    this.running = true;
    const vault = this.options.vault;
    for (const event of ["create", "modify", "delete"] as const) this.refs.push(vault.on(event, file => this.changed(file.path)));
    this.refs.push(vault.on("rename", (file, oldPath) => { this.changed(oldPath); this.changed(file.path); }));
    try {
      this.applying = true;
      const initial = await new SyncInitialTransferEngine(this.options).run();
      for (const path of initial.uploaded) this.options.onActivity?.("upload", path);
      for (const path of initial.deleted) this.options.onActivity?.("delete", path);
      for (const path of initial.pulled) this.options.onActivity?.("download", path);
      for (const path of initial.conflicts) this.options.onActivity?.("merge", path);
      for (const file of vault.getFiles()) if (this.includes(file.path)) this.state.hashes[file.path] = await this.hash(file);
      await this.persist();
      await this.flush();
    } catch (error) { this.failed(error); await this.stop(); throw error; }
    finally { this.applying = false; }
    this.unsubscribe = this.options.socket.subscribeToPushes(entry => { if (this.running) this.enqueue(() => this.receive(entry)); });
    this.poll();
  }
  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    for (const ref of this.refs) this.options.vault.offref(ref);
    this.refs = [];
    await this.queue;
    await this.persist();
  }
  private includes(path: string) { return !path.startsWith(".trash/") && (this.options.include?.(path) ?? true); }
  private changed(path: string) {
    if (!this.running || this.applying || !this.includes(path)) return;
    if (!this.state.pending.includes(path)) this.state.pending.push(path);
    this.enqueue(async () => { await this.persist(); await this.flush(); });
  }
  private enqueue(task: () => Promise<void>) { this.queue = this.queue.then(task).catch(error => this.failed(error)); }
  private failed(error: unknown) { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
  private async persist() { await this.options.saveState?.({ hashes: { ...this.state.hashes }, pending: [...this.state.pending] }); }
  private async hash(file: TFile) {
    const bytes = new Uint8Array(await this.options.vault.readBinary(file));
    const digest = this.options.digest ? await this.options.digest(bytes) : Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    return this.options.encryption.deterministicEncodeStr(digest);
  }
  private async flush() {
    if (!this.running || this.options.socket.connectionStatus !== "ready") return;
    for (const path of [...this.state.pending]) {
      const file = this.options.vault.getAbstractFileByPath(path);
      const encoded = await this.options.encryption.deterministicEncodeStr(path);
      if (!file) { await this.options.socket.push({ path: encoded, hash: "", deleted: true }); delete this.state.hashes[path]; this.options.onActivity?.("delete", path); }
      else if (file instanceof TFolder) await this.options.socket.push({ path: encoded, hash: "", folder: true });
      else if (file instanceof TFile) {
        const hash = await this.hash(file);
        if (hash !== this.state.hashes[path]) {
          const bytes = new Uint8Array(await this.options.vault.readBinary(file));
          await this.options.socket.push({ path: encoded, hash, extension: file.extension, ctime: file.stat.ctime, mtime: file.stat.mtime, bytes: new Uint8Array(await this.options.encryption.encrypt(bytes)) });
          this.state.hashes[path] = hash;
          this.options.onActivity?.("upload", path);
        }
      }
      this.state.pending = this.state.pending.filter(item => item !== path); await this.persist();
    }
  }
  private async receive(entry: SyncPushEntry) {
    if (typeof entry.path !== "string") return;
    const path = await this.options.encryption.deterministicDecodeStr(entry.path);
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") || !this.includes(path)) return;
    this.applying = true;
    try {
      const vault = this.options.vault, local = vault.getAbstractFileByPath(path);
      if (local instanceof TFile && this.state.hashes[path] && await this.hash(local) !== this.state.hashes[path] && entry.hash !== await this.hash(local)) {
        const dot = path.lastIndexOf("."), suffix = `.sync-conflict-${Date.now()}`;
        const conflict = dot > path.lastIndexOf("/") ? path.slice(0, dot) + suffix + path.slice(dot) : path + suffix;
        await vault.createBinary(conflict, await vault.readBinary(local));
        this.state.pending.push(conflict);
        this.options.onActivity?.("merge", path);
      }
      if (entry.deleted) { if (local) await vault.delete(local); delete this.state.hashes[path]; }
      else if (entry.folder) { if (!local) await vault.createFolder(path); }
      else if (entry.uid !== undefined && entry.hash !== this.state.hashes[path]) {
        const encrypted = await this.options.socket.pull(String(entry.uid));
        const clear = await this.options.encryption.decrypt(encrypted.slice().buffer as ArrayBuffer);
        const parent = path.split("/").slice(0, -1); let current = "";
        for (const part of parent) { current = current ? `${current}/${part}` : part; if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current); }
        if (local instanceof TFile) await vault.modifyBinary(local, clear, { mtime: entry.mtime, ctime: entry.ctime });
        else await vault.createBinary(path, clear, { mtime: entry.mtime, ctime: entry.ctime });
        this.state.hashes[path] = String(entry.hash ?? "");
        this.options.onActivity?.("download", path);
      }
      await this.persist();
    } finally { this.applying = false; }
  }
  private poll() {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.enqueue(async () => {
        if (["closed", "error"].includes(this.options.socket.connectionStatus)) { await this.options.socket.initialize({ ...this.options.init, initial: false }); await this.options.socket.waitUntilReady(); }
        await this.flush();
      });
      this.poll();
    }, this.options.reconnectDelay ?? 3000);
  }
}
