import { ipcRenderer } from "../../platforms/platform";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { Events } from "../compat/events";
import { SyncHttpClient, SyncSocketClient, type JsonObject, type SyncConnectionStatus, type SyncPushEntry, type SyncWebSocketFactory, type VaultRegion, type VaultSummary } from "../compat/sync-client";
import { AccountClient } from "../compat/account";
import { SyncHistoryApi, type SyncHistoryEntry, type SyncHistoryPage } from "../compat/sync-history";
import { SyncInitialTransferEngine, type SyncInitialTransferResult } from "../compat/sync-engine";
import { createSyncEncryptionProvider, deriveSyncPasswordKey, type SyncEncryptionProvider } from "../compat/sync-crypto";
import { TFile, type Vault } from "../compat/vault";
import { confirmDialog } from "../controllers/dialogs";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import type { App } from "../compat/plugin";
import { Dropdown, SettingItem } from "./ui";
import { ContinuousSyncEngine, type SyncCheckpoint } from "../compat/sync-continuous";

export type SyncState = "uninitialized" | "disconnected" | "error" | "paused" | "syncing" | "synced";
export interface SyncLogEntry { ts: number; info: string; file?: string; error: boolean; type: "" | "merge" | "skip"; el?: HTMLElement; textContent?: string }
export interface SyncServerFile { path: string; uid?: string; hash?: string; size: number; mtime: number; ctime: number; folder: boolean; deleted: boolean; device?: string; user?: string; ts?: number }

const MAX_LOG_ENTRIES = 1000;
const syncIncludes = (path: string) => !path.startsWith(".obsidian/") && !path.startsWith(".trash/");

/** Keep low-level crypto diagnostics out of the user-facing Sync activity log. */
export function syncErrorCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Invalid encryption key") return t("obsen.sync.error-invalid-key");
  if (message === "Encryption version not supported") return t("obsen.sync.error-encryption-version");
  if (message === "Encrypted data is bad" || message === "Invalid encrypted string" || message.startsWith("AES-SIV:") || (error instanceof Error && error.name === "OperationError")) return t("obsen.sync.error-decrypt");
  return message;
}

/**
 * Sync state of one local vault: the connection, its status text, the activity log and the
 * latest known remote files. Triggers "status-change" and "new-log".
 */
export class VaultSync extends Events {
  initialized = false;
  pause = false;
  syncing = false;
  error = false;
  /** Tooltip text of the status bar item. */
  syncStatus = t("obsen.sync.status-uninitialized");
  syncLog: SyncLogEntry[] = [];
  serverFiles: Record<string, SyncServerFile> = {};
  userId = "";
  private session: { options: InitialVaultSyncOptions; encryption: SyncEncryptionProvider; version: number } | null = null;
  private socket: SyncSocketClient | null = null;
  private engine: ContinuousSyncEngine | null = null;
  private decoding: Promise<void> = Promise.resolve();
  private stopWatching: (() => void) | null = null;
  private readonly remoteChanges = new Map<string, number>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private app: App | null = null;

  constructor(readonly vault: Vault) { super(); }

  attachApp(app: App): void { this.app = app; }

  get vaultId(): string { return this.session?.options.remote.id ?? ""; }
  get vaultName(): string { const remote = this.session?.options.remote; return remote ? remote.name || remote.id : ""; }
  get dataLoaded(): boolean { return this.initialized; }

  setInitialized(): void { if (!this.initialized) { this.initialized = true; this.trigger("status-change"); } }

  getStatus(): SyncState {
    if (!this.initialized) return "uninitialized";
    if (!this.session) return "disconnected";
    return this.error ? "error" : this.pause ? "paused" : this.syncing ? "syncing" : "synced";
  }

  setStatus(status: string): void { this.syncStatus = status; this.trigger("status-change"); }

  log(info: string, file?: string, error = false, type: SyncLogEntry["type"] = ""): void {
    const log = this.syncLog, synced = t("obsen.sync.status-synced");
    if (info === synced && log[log.length - 1]?.info === info) return;
    log.push({ file, info, ts: Date.now(), error, type });
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, 100);
    this.trigger("new-log");
  }

  async connect(options: InitialVaultSyncOptions): Promise<void> {
    await this.disconnect();
    const remote = options.remote, version = Number(remote.encryption_version ?? 3);
    if (version !== 0 && version !== 2 && version !== 3) throw new Error(t("obsen.sync.error-unsupported-encryption", { version }));
    if (!remote.host || !remote.salt || !remote.id) throw new Error(t("obsen.sync.error-incomplete-vault"));
    const key = await deriveSyncPasswordKey(remote.password || options.password, remote.salt);
    let encryption;
    try { encryption = await createSyncEncryptionProvider(version, key, remote.salt); } finally { key.fill(0); }
    await options.accessVault({ vault_uid: remote.id, keyhash: encryption.keyHash, host: remote.host, encryption_version: version });
    this.session = { options, encryption, version };
    this.pause = false; this.serverFiles = {};
    try { await this.start(); this.persistReconnectOptions(options); }
    catch (error) { this.session = null; this.error = false; this.setStatus(t("obsen.sync.status-uninitialized")); throw error; }
  }

  async disconnect(): Promise<void> {
    const had = this.session !== null;
    await this.stop();
    this.session = null; this.pause = false; this.error = false; this.syncing = false; this.serverFiles = {};
    this.app?.secretStorage.deleteSecret(syncReconnectKey(this.vault));
    if (had) this.setStatus(t("obsen.sync.status-uninitialized"));
  }

  private persistReconnectOptions(options: InitialVaultSyncOptions): void {
    if (!this.app) return;
    this.app.secretStorage.setSecret(syncReconnectKey(this.vault), JSON.stringify({
      remote: options.remote,
      password: options.password,
      deviceId: options.deviceId,
    }));
  }

  async reconnectSaved(): Promise<boolean> {
    if (!this.app || this.session || this.pause) return false;
    const raw = this.app.secretStorage.getSecret(syncReconnectKey(this.vault));
    if (!raw) return false;
    let saved: { remote?: VaultSummary; password?: string; deviceId?: string };
    try { saved = JSON.parse(raw) as typeof saved; } catch { this.app.secretStorage.deleteSecret(syncReconnectKey(this.vault)); return false; }
    if (!saved.remote?.id || !saved.remote.host || !saved.remote.salt) return false;
    const accountOrigin = ipcRenderer.sendSync("obsen-server-url") || "https://api.obsidian.md";
    const account = new AccountClient({ origin: accountOrigin, storage: localStorage });
    if (!account.session) return false;
    const session = await account.refresh();
    const client = new SyncHttpClient({ baseUrl: localStorage.getItem("obsen:sync-origin") || "https://sync.obsidian.md", fetch: (input, init) => fetch(input, init as RequestInit) });
    await this.connect({
      token: session.token, password: saved.password ?? "", remote: saved.remote, vault: this.vault,
      deviceId: saved.deviceId,
      accessVault: input => client.accessVault(session.token, input),
    });
    return true;
  }

  async setPause(pause: boolean): Promise<void> {
    if (!this.session || this.pause === pause) return;
    this.pause = pause;
    if (pause) { await this.stop(); this.error = false; this.setStatus(t("obsen.sync.status-paused")); this.log(t("obsen.sync.status-paused")); return; }
    this.log(t("obsen.sync.log-resumed"));
    try { await this.start(); } catch { /* start() reported the failure through the log and status */ }
  }

  private async start(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const { options, encryption, version } = session, remote = options.remote, vault = this.vault;
    this.error = false; this.syncing = true;
    this.setStatus(t("obsen.sync.status-connecting-server")); this.log(t("obsen.sync.status-connecting-server"));
    const create: SyncWebSocketFactory = options.createWebSocket ?? (url => new WebSocket(url));
    const socket = new SyncSocketClient({
      url: buildSyncSocketUrl(remote.host!),
      createWebSocket: url => {
        const raw = create(url);
        // The engine consumes the init reply; the account's user id is read off the same frame.
        raw.addEventListener("message", (event: MessageEvent) => {
          if (this.userId || typeof event.data !== "string") return;
          try { const message = JSON.parse(event.data) as JsonObject; if (message.res === "ok" && message.userId !== undefined) this.userId = String(message.userId); } catch { /* not JSON */ }
        });
        return raw;
      },
      onStatus: status => { options.onStatus?.(status); if (this.socket === socket) this.onSocketStatus(status); },
      onPush: entry => { if (this.socket === socket) this.onServerPush(entry as SyncPushEntry); },
    });
    const statePath = `.obsidian/sync-state-${remote.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    const engine = new ContinuousSyncEngine({ socket, vault, encryption,
      init: { token: options.token, id: remote.id, keyhash: encryption.keyHash, version: 3, device: options.deviceId ?? getSyncDeviceIdentifier(remote.id), encryption_version: version },
      include: syncIncludes,
      onActivity: (action, path) => {
        const key = action === "upload" ? "obsen.sync.log-uploading-file" : action === "delete" ? "obsen.sync.log-deleting-remote-file"
          : action === "download" ? "obsen.sync.log-downloading-file" : "obsen.sync.log-merge-conflict";
        this.log(t(key), path, false, action === "merge" ? "merge" : "");
        if (action === "upload" || action === "delete") this.busy(t("obsen.sync.status-uploading", { path }));
        else if (action === "download") this.busy(t("obsen.sync.status-downloading", { path }));
      },
      loadState: async () => { try { return JSON.parse(await vault.adapter.read(statePath)) as SyncCheckpoint; } catch { return null; } },
      saveState: async state => { if (!await vault.adapter.exists(".obsidian")) await vault.adapter.mkdir(".obsidian"); await vault.adapter.write(statePath, JSON.stringify(state)); },
      onError: error => { if (this.engine === engine) this.failed(error); },
    });
    this.socket = socket; this.engine = engine;
    try { await engine.start(); }
    catch (error) {
      if (this.engine === engine) { this.engine = null; this.socket = null; this.syncing = false; this.failed(error); }
      socket.close();
      throw error;
    }
    if (this.engine !== engine) return;
    this.watchVault();
    this.log(t("obsen.sync.log-connected"));
    this.settle();
  }

  private async stop(): Promise<void> {
    const { engine, socket } = this;
    this.engine = null; this.socket = null;
    this.stopWatching?.(); this.stopWatching = null;
    clearTimeout(this.idleTimer); this.syncing = false;
    try { await engine?.stop(); } catch (error) { console.error(error); }
    socket?.close();
  }

  private failed(error: unknown): void {
    this.error = true;
    this.log(syncErrorCopy(error), undefined, true);
    this.setStatus(t("dialogue.label-error"));
  }

  private settle(): void {
    clearTimeout(this.idleTimer);
    this.syncing = false;
    if (this.error || this.pause || !this.session) { this.trigger("status-change"); return; }
    this.log(t("obsen.sync.status-synced")); this.setStatus(t("obsen.sync.status-synced"));
  }

  private busy(status: string): void {
    this.syncing = true;
    this.setStatus(status);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.settle(), 1500);
  }

  private onSocketStatus(status: SyncConnectionStatus): void {
    if (!this.engine) return;
    if (status === "ready") { if (this.error) { this.error = false; this.log(t("obsen.sync.log-connected")); } if (!this.syncing) this.settle(); }
    else if (status === "connecting") { this.syncing = true; this.setStatus(t("obsen.sync.status-connecting-server")); }
    else if (status === "error") { this.error = true; this.syncing = false; this.setStatus(t("dialogue.label-error")); this.log(t("obsen.sync.status-error"), undefined, true); }
  }

  private onServerPush(entry: SyncPushEntry): void {
    const encryption = this.session?.encryption;
    if (!encryption || typeof entry.path !== "string") return;
    const encoded = entry.path;
    this.decoding = this.decoding.then(async () => {
      const path = await encryption.deterministicDecodeStr(encoded);
      if (!path || !syncIncludes(path)) return;
      this.serverFiles[path] = {
        path, uid: entry.uid === undefined ? undefined : String(entry.uid), hash: entry.hash, size: Number(entry.size ?? 0),
        mtime: Number(entry.mtime ?? 0), ctime: Number(entry.ctime ?? 0), folder: entry.folder === true, deleted: entry.deleted === true,
        device: entry.device, user: entry.user === undefined ? undefined : String(entry.user), ts: entry.ts,
      };
      this.remoteChanges.set(path, Date.now());
      this.log(t("obsen.sync.log-server-pushed"), path);
      if (this.stopWatching) this.busy(t("obsen.sync.status-downloading", { path }));
      else this.trigger("status-change");
    }).catch(() => undefined);
  }

  /** The engine reports no progress, so local activity is read from the vault's own change events. */
  private watchVault(): void {
    const vault = this.vault;
    const changed = (path: string, deleted: boolean) => {
      if (!syncIncludes(path) || this.pause || !this.engine) return;
      const remote = this.remoteChanges.get(path);
      if (remote && Date.now() - remote < 5000) return;
      const file = vault.getAbstractFileByPath(path);
      if (!deleted && file instanceof TFile) this.serverFiles[path] = { ...this.serverFiles[path], path, size: file.stat.size, mtime: file.stat.mtime, ctime: file.stat.ctime, folder: false, deleted: false, user: this.userId || undefined };
      else if (deleted && this.serverFiles[path]) this.serverFiles[path].deleted = true;
    };
    const refs = [
      vault.on("create", file => changed(file.path, false)), vault.on("modify", file => changed(file.path, false)),
      vault.on("delete", file => changed(file.path, true)), vault.on("rename", (file, oldPath) => { changed(String(oldPath), true); changed(file.path, false); }),
    ];
    this.stopWatching = () => { for (const ref of refs) vault.offref(ref); };
  }

  private requireSocket(): { socket: SyncSocketClient; encryption: SyncEncryptionProvider } {
    if (!this.socket || !this.session || this.socket.connectionStatus !== "ready") throw new Error(t("plugins.sync.label-sync-disconnected"));
    return { socket: this.socket, encryption: this.session.encryption };
  }

  /** One page of a file's remote history, newest first; `last` continues after that revision. */
  getHistory(path: string, last?: string | null): Promise<SyncHistoryPage> {
    const { socket, encryption } = this.requireSocket();
    return new SyncHistoryApi(socket, text => encryption.deterministicEncodeStr(text), text => encryption.deterministicDecodeStr(text)).list(path, last ?? undefined);
  }

  /** Decrypted bytes of one revision. */
  async getContentForVersion(uid: string): Promise<ArrayBuffer> {
    const { socket, encryption } = this.requireSocket();
    const encrypted = await socket.pull(uid);
    return encrypted.byteLength ? encryption.decrypt(encrypted.slice().buffer as ArrayBuffer) : new ArrayBuffer(0);
  }

  /** Restores a revision on the server, or writes its content to `path` when one is given. */
  async restoreVersion(uid: string, path?: string): Promise<void> {
    const { socket } = this.requireSocket();
    if (!path) { await socket.restore(uid); return; }
    const data = await this.getContentForVersion(uid), vault = this.vault, existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) { await vault.modifyBinary(existing, data); return; }
    let folder = "";
    for (const part of path.split("/").slice(0, -1)) { folder = folder ? `${folder}/${part}` : part; if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder); }
    await vault.createBinary(path, data);
  }

  /** Restore the newest retained content for a tombstoned remote path. */
  async restoreDeletedFile(path: string): Promise<void> {
    const history = await this.getHistory(path);
    const revision = history.items.find(item => !item.deleted && !item.folder && !item.relatedpath && item.uid);
    if (!revision) throw new Error(t("plugins.sync.label-unable-to-retrieve"));
    await this.restoreVersion(revision.uid);
  }

  /** Deleted remote files with decoded paths, oldest first as the server lists them. */
  async listDeleted(): Promise<SyncHistoryEntry[]> {
    const { socket, encryption } = this.requireSocket();
    const reply = await socket.deleted(), items = Array.isArray(reply.items) ? reply.items as JsonObject[] : [];
    const result: SyncHistoryEntry[] = [];
    for (const item of items) {
      if (typeof item.path !== "string") continue;
      try { result.push({ ...item, uid: String(item.uid ?? ""), path: await encryption.deterministicDecodeStr(item.path), deleted: true, folder: item.folder === true } as SyncHistoryEntry); }
      catch { /* undecodable entries belong to another key */ }
    }
    return result;
  }

  /** User id to display name for everyone with access to the remote vault. */
  async getUsernames(): Promise<Record<string, string>> {
    const reply = await this.requireSocket().socket.usernames();
    const source = reply.usernames && typeof reply.usernames === "object" ? reply.usernames as JsonObject : reply;
    return Object.fromEntries(Object.entries(source).filter(([key, value]) => typeof value === "string" && key !== "op" && key !== "res").map(([key, value]) => [key, String(value)]));
  }
}

const vaultSyncs = new WeakMap<Vault, VaultSync>();
/** The Sync state object of a vault (created on first use). */
export function getVaultSync(vault: Vault, app?: App): VaultSync {
  let sync = vaultSyncs.get(vault);
  if (!sync) vaultSyncs.set(vault, sync = new VaultSync(vault));
  if (app) sync.attachApp(app);
  return sync;
}

function syncReconnectKey(vault: Vault): string {
  const basePath = String((vault.adapter as typeof vault.adapter & { basePath?: string }).basePath ?? vault.getName());
  let hash = 2166136261;
  for (let index = 0; index < basePath.length; index++) hash = Math.imul(hash ^ basePath.charCodeAt(index), 16777619);
  return `sync-vault-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function disconnectVaultSync(vault: Vault) { await vaultSyncs.get(vault)?.disconnect(); }
export async function connectVaultSync(options: InitialVaultSyncOptions, app?: App) { await getVaultSync(options.vault, app).connect(options); }

export function useVaultSync(sync: VaultSync | null): SyncState | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sync) return;
    const ref = sync.on("status-change", () => setTick(tick => tick + 1));
    return () => sync.offref(ref);
  }, [sync]);
  return sync ? sync.getStatus() : null;
}

/** Account-level remote vault management and one-shot initial transfer. */
export interface SyncVaultManagerProps {
  origin: string;
  token: string;
  vault?: Vault;
}

export interface InitialVaultSyncOptions {
  token: string;
  password: string;
  remote: VaultSummary;
  vault: Vault;
  accessVault(input: { vault_uid: string; keyhash: string; host: string; encryption_version: number }): Promise<void>;
  createWebSocket?: SyncWebSocketFactory;
  deviceId?: string;
  onStatus?: (status: SyncConnectionStatus) => void;
}

/** Run a user-triggered, one-shot initial transfer. This does not install watchers or reconnect. */
export async function runInitialVaultSync(options: InitialVaultSyncOptions): Promise<SyncInitialTransferResult> {
  const { remote } = options;
  const version = Number(remote.encryption_version ?? 3);
  if (version !== 0 && version !== 2 && version !== 3) throw new Error(t("obsen.sync.error-unsupported-encryption", { version }));
  if (!remote.id || !remote.host || !remote.salt) throw new Error(t("obsen.sync.error-incomplete-vault"));
  const password = remote.password || options.password;
  if (!password) throw new Error(t("plugins.sync.msg-please-enter-password"));

  const key = await deriveSyncPasswordKey(password, remote.salt);
  let encryption;
  try { encryption = await createSyncEncryptionProvider(version, key, remote.salt); }
  finally { key.fill(0); }
  await options.accessVault({ vault_uid: remote.id, keyhash: encryption.keyHash, host: remote.host, encryption_version: version });

  const socket = new SyncSocketClient({
    url: buildSyncSocketUrl(remote.host),
    createWebSocket: options.createWebSocket ?? ((url) => new WebSocket(url)),
    onStatus: options.onStatus,
  });
  try {
    return await new SyncInitialTransferEngine({
      socket,
      vault: options.vault,
      encryption,
      init: {
        token: options.token,
        id: remote.id,
        keyhash: encryption.keyHash,
        version: 3,
        device: options.deviceId ?? getSyncDeviceIdentifier(remote.id),
        encryption_version: version,
      },
    }).run();
  } finally {
    socket.close();
  }
}

export function buildSyncSocketUrl(host: string): string {
  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(host);
  const localHost = /^(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(host);
  const candidate = explicitScheme ? host : `${localHost ? "http" : "https"}://${host}`;
  const url = new URL(candidate);
  if (url.username || url.password || !url.hostname) throw new Error(t("obsen.sync.error-invalid-host"));
  if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol)) throw new Error(t("obsen.sync.error-invalid-host"));
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getSyncDeviceIdentifier(vaultId: string): string {
  const key = `obsen.sync.device.${vaultId}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const generated = globalThis.crypto.randomUUID();
    localStorage.setItem(key, generated);
    return generated;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

const SUPPORTED_ENCRYPTION_VERSION = 3;

export function SyncVaultManager({ origin, token, vault, app }: SyncVaultManagerProps & { app: App }) {
  const t = useT();
  const [regions, setRegions] = useState<VaultRegion[]>([]);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [sharedVaults, setSharedVaults] = useState<VaultSummary[]>([]);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [createdPassword, setCreatedPassword] = useState("");

  const client = useCallback(() => new SyncHttpClient({
    baseUrl: origin,
    fetch: async (input, init) => fetch(input, init as RequestInit),
  }), [origin]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const api = client();
      const [regionResult, listing] = await Promise.all([
        api.regions(token),
        api.listVaults(token, SUPPORTED_ENCRYPTION_VERSION),
      ]);
      setRegions(regionResult.regions);
      setVaults(listing.vaults);
      setSharedVaults(listing.shared);
      setRegion((current) => current && regionResult.regions.some((entry) => entry.value === current)
        ? current
        : regionResult.regions[0]?.value ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client, token]);

  useEffect(() => { void refresh(); }, [refresh]);
  const sync = vault ? getVaultSync(vault, app) : null;
  const state = useVaultSync(sync);
  const connected = Boolean(sync?.vaultId);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || !region || creating) return;
    setCreating(true);
    setError("");
    setMessage("");
    setCreatedPassword("");
    try {
      const created = await client().createVault(token, {
        name: cleanName,
        keyhash: null,
        region,
        encryption_version: SUPPORTED_ENCRYPTION_VERSION,
      });
      setName("");
      setMessage(t("plugins.sync.msg-successfully-created-vault", { name: created.name || cleanName }));
      setCreatedPassword(created.password ?? "");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const renderVault = (remote: VaultSummary) => <SettingItem key={remote.id} name={remote.name || remote.id} description={remote.region || remote.host || ""}>
    <RemoteVaultConnection app={app} token={token} remote={remote} localVault={vault} client={client} />
  </SettingItem>;

  return <>
    <div className="setting-group"><div className="setting-items">
      <SettingItem name={t("plugins.sync.option-remote-vault")} description={connected ? t("plugins.sync.option-remote-vault-desc-connected", { name: sync!.vaultName }) : t("plugins.sync.option-remote-vault-desc-not-connected")}>
        {connected && <button type="button" onClick={() => void sync!.disconnect()}>{t("plugins.sync.button-disconnect-from-remote-vault")}</button>}
      </SettingItem>
      {connected && <>
        <SettingItem name={t("plugins.sync.option-sync-status")} description={state === "paused" ? t("plugins.sync.option-sync-status-desc-paused") : t("plugins.sync.option-sync-status-desc-running")}>
          <button type="button" onClick={() => void sync!.setPause(!sync!.pause)}>{t(sync!.pause ? "plugins.sync.button-resume" : "plugins.sync.button-pause")}</button>
        </SettingItem>
        <SettingItem name={t("plugins.sync.option-view-deleted-files")} description={t("plugins.sync.option-view-deleted-files-desc")}>
          <button type="button" onClick={() => app.workspace.trigger("sync:show-deleted-files")}>{t("plugins.sync.button-view")}</button>
        </SettingItem>
        <SettingItem name={t("plugins.sync.option-sync-log")} description={t("plugins.sync.option-sync-log-desc")}>
          <button type="button" onClick={() => app.workspace.trigger("sync:show-log")}>{t("plugins.sync.button-view")}</button>
        </SettingItem>
      </>}
    </div></div>
    <div className="setting-group">
      <div className="setting-item setting-item-heading"><div className="setting-item-name">{t("plugins.sync.label-create-remote-vault")}</div><div className="setting-item-control" /></div>
      <form className="setting-items" onSubmit={(event) => void create(event)}>
        <SettingItem name={t("plugins.sync.option-vault-name")} description={t("plugins.sync.option-vault-name-desc")}>
          <input type="text" value={name} maxLength={120} placeholder={t("plugins.sync.option-vault-name-placeholder")} onChange={(event) => setName(event.target.value)} />
        </SettingItem>
        <SettingItem name={t("plugins.sync.option-vault-region")} description={t("plugins.sync.option-vault-region-desc")}>
          <Dropdown value={region} options={regions.length ? regions.map(item => ({ value: item.value, label: item.name })) : [{ value: "", label: t("plugins.sync.opt-vault-region-automatic") }]} onChange={setRegion} />
        </SettingItem>
        <SettingItem name={t("plugins.sync.option-encryption")} description={t("plugins.sync.option-encryption-standard")}>
          <button type="submit" className="mod-cta" disabled={creating || loading || !name.trim() || !region}>{t("plugins.sync.button-create-new-remote-vault")}</button>
        </SettingItem>
        {error && <div className="setting-item"><div className="setting-item-info"><div className="setting-item-description mod-warning" role="alert">{error}</div></div></div>}
        {message && <SettingItem name={message} description={createdPassword ? t("plugins.sync.option-encryption-password-desc-warning") : undefined}>
          {createdPassword && <><input type="text" readOnly value={createdPassword} onFocus={(event) => event.currentTarget.select()} /><button type="button" onClick={() => void navigator.clipboard.writeText(createdPassword)}>{t("plugins.sync.label-copy-to-clipboard")}</button></>}
        </SettingItem>}
      </form>
    </div>
    <div className="setting-group">
      <div className="setting-item setting-item-heading"><div className="setting-item-name">{t("plugins.sync.label-remote-vaults")}</div>
        <div className="setting-item-control"><button type="button" disabled={loading || creating} onClick={() => void refresh()}>{t("plugins.sync.button-retry")}</button></div></div>
      <div className="setting-items">
        {[...vaults, ...sharedVaults].map(renderVault)}
        {!vaults.length && !sharedVaults.length && <div className="setting-item mod-empty-state"><div className="setting-item-info"><div className="setting-item-name">{loading ? t("dialogue.msg-loading") : t("plugins.sync.label-not-remote-vaults")}</div></div></div>}
      </div>
    </div>
  </>;
}

function RemoteVaultConnection({ app, token, remote, localVault, client }: {
  app: App;
  token: string;
  remote: VaultSummary;
  localVault?: Vault;
  client: () => SyncHttpClient;
}) {
  const t = useT();
  const [password, setPassword] = useState(remote.password ?? "");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<SyncInitialTransferResult | null>(null);

  useEffect(() => { setPassword(remote.password ?? ""); setStatus(""); setError(""); setResult(null); }, [remote.id, remote.password]);

  const connect = async () => {
    if (!localVault || running) return;
    const confirmation = await confirmDialog(app, { title: t("plugins.sync.button-connect-to-remote-vault"), message: [t("obsen.sync.initial-transfer-warning", { name: remote.name || remote.id })], cta: t("plugins.sync.button-connect-to-remote-vault"), warning: true });
    if (!confirmation.confirmed) return;
    setRunning(true); setError(""); setStatus(t("obsen.sync.status-connecting")); setResult(null);
    try {
      await connectVaultSync({
        token, password, remote, vault: localVault,
        accessVault: (input) => client().accessVault(token, input),
        onStatus: (connection) => setStatus(syncStatusText(connection)),
      }, app);
      setStatus(t("plugins.sync.option-sync-status-desc-running"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("");
    } finally { setRunning(false); }
  };

  return <>
    {!remote.password && <input type="password" value={password} autoComplete="current-password" disabled={running} placeholder={t("plugins.sync.option-encryption-password-placeholder")} aria-label={t("plugins.sync.option-encryption-password")} onChange={(event) => setPassword(event.target.value)} />}
    <button type="button" className="mod-cta" disabled={!localVault || running || (!remote.password && !password.trim())} onClick={() => void connect()}>{t("plugins.sync.button-connect-to-remote-vault")}</button>
    <button type="button" disabled={!localVault || running} onClick={() => { if (localVault) void disconnectVaultSync(localVault).then(() => setStatus(t("plugins.sync.option-remote-vault-desc-not-connected"))); }}>{t("plugins.sync.button-disconnect-from-remote-vault")}</button>
    {(status || error) && <div className={error ? "setting-item-description mod-warning" : "setting-item-description"} role={error ? "alert" : "status"}>{error || status}</div>}
    {result && <div className="setting-item-description" role="status">{t("obsen.sync.transfer-result", { pulled: result.pulled.length, uploaded: result.uploaded.length, deleted: result.deleted.length, conflicts: result.conflicts.length })}</div>}
  </>;
}

function syncStatusText(status: SyncConnectionStatus): string {
  switch (status) {
    case "connecting": case "open": case "initializing": return t("obsen.sync.status-connecting");
    case "ready": return t("plugins.sync.option-sync-status-desc-running");
    case "error": return t("obsen.sync.status-error");
    case "closed": return t("plugins.sync.option-remote-vault-desc-not-connected");
    default: return status;
  }
}

export default SyncVaultManager;
