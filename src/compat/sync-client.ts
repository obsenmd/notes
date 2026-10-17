/** UI-independent transport helpers for Obsen's observed headless sync wire protocol.
 * Vault paths, hashes, and file bytes are treated as opaque: encryption belongs to
 * the caller, and this module does not derive keys or transform content.
 */

export type JsonObject = Record<string, unknown>;

export class SyncTransportError extends Error {
  constructor(message: string, readonly status?: number, readonly payload?: unknown) {
    super(message);
    this.name = "SyncTransportError";
  }
}

export interface SyncFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
export type SyncFetch = (input: string, init?: {
  method?: string; headers?: Record<string, string>; body?: string | Uint8Array;
}) => Promise<SyncFetchResponse>;

export interface SyncHttpOptions {
  baseUrl: string;
  fetch: SyncFetch;
  origin?: string;
}

export interface SignInResult { token: string; name: string; email: string; }
export interface UserInfo { name: string; email: string; }
export interface VaultRegion { value: string; name: string; }
export interface VaultSummary {
  id: string; name: string; region?: string; host?: string; salt?: string;
  password?: string; encryption_version?: number;
}
export interface VaultListing { vaults: VaultSummary[]; shared: VaultSummary[]; }
export interface CreatedVault { id: string; name: string; region?: string; host?: string; salt?: string; password?: string; encryption_version?: number; }
export interface PublishSite { id: string; host: string; }
export interface PublishListing { sites: PublishSite[]; shared: PublishSite[]; }

/** JSON account/vault/publish requests; authentication tokens stay in JSON bodies. */
export class SyncHttpClient {
  readonly baseUrl: string;
  constructor(private readonly options: SyncHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  signIn(email: string, password: string, mfa = ""): Promise<SignInResult> {
    return this.post("/user/signin", { email, password, mfa }, { origin: this.options.origin ?? "https://obsidian.md", preflight: true }) as Promise<SignInResult>;
  }
  async signOut(token: string): Promise<void> { await this.post("/user/signout", { token }); }
  userInfo(token: string): Promise<UserInfo> { return this.post("/user/info", { token }) as Promise<UserInfo>; }
  regions(token: string, host?: string): Promise<{ regions: VaultRegion[] }> {
    return this.post("/vault/regions", { token, ...(host === undefined ? {} : { host }) }) as Promise<{ regions: VaultRegion[] }>;
  }
  listVaults(token: string, supportedEncryptionVersion: number): Promise<VaultListing> {
    return this.post("/vault/list", { token, supported_encryption_version: supportedEncryptionVersion }) as Promise<VaultListing>;
  }
  createVault(token: string, input: { name: string; keyhash: string | null; salt?: string; region: string; encryption_version: number }): Promise<CreatedVault> {
    return this.post("/vault/create", { token, ...input }) as Promise<CreatedVault>;
  }
  accessVault(token: string, input: { vault_uid: string; keyhash: string; host: string; encryption_version: number }): Promise<void> {
    return this.post("/vault/access", { token, ...input }).then(() => undefined);
  }
  listPublishSites(token: string): Promise<PublishListing> { return this.post("/publish/list", { token }) as Promise<PublishListing>; }
  createPublishSite(token: string): Promise<PublishSite> { return this.post("/publish/create", { token }) as Promise<PublishSite>; }
  assignSlug(token: string, input: { id: string; host: string; slug: string }): Promise<void> {
    return this.post("/api/slug", { token, ...input }).then(() => undefined);
  }
  slugs(token: string, ids: string[]): Promise<Record<string, string>> { return this.post("/api/slugs", { token, ids }) as Promise<Record<string, string>>; }
  publishFiles(token: string, id: string): Promise<{ files: Array<{ path: string; hash: string; [key: string]: unknown }> }> {
    return this.post("/api/list", { token, id, version: 2 }) as Promise<{ files: Array<{ path: string; hash: string; [key: string]: unknown }> }>;
  }
  publishOptions(token: string, id: string, options?: JsonObject): Promise<JsonObject> {
    return this.post("/api/options", { token, id, ...(options === undefined ? {} : { options }) }) as Promise<JsonObject>;
  }
  removePublishedPath(token: string, id: string, path: string): Promise<void> {
    return this.post("/api/remove", { token, id, path }).then(() => undefined);
  }
  uploadPublishedFile(input: { token: string; id: string; path: string; hash: string; bytes: Uint8Array; ctime?: number; mtime?: number }): Promise<void> {
    const headers: Record<string, string> = {
      "obs-token": input.token, "obs-id": input.id, "obs-path": encodeURIComponent(input.path),
      "obs-hash": input.hash, "Content-Type": "application/octet-stream",
    };
    if (input.ctime !== undefined) headers["obs-ctime"] = String(input.ctime);
    if (input.mtime !== undefined) headers["obs-mtime"] = String(input.mtime);
    return this.request("/api/upload", { method: "POST", headers, body: input.bytes }).then(() => undefined);
  }

  private async post(path: string, body: JsonObject, opts: { origin?: string; preflight?: boolean } = {}): Promise<unknown> {
    if (opts.preflight) {
      const preflight = await this.options.fetch(`${this.baseUrl}${path}`, {
        method: "OPTIONS", headers: { ...(opts.origin ? { Origin: opts.origin } : {}) },
      });
      if (!preflight.ok) throw new SyncTransportError(`HTTP preflight failed (${preflight.status})`, preflight.status);
    }
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.origin ? { Origin: opts.origin } : {}) },
      body: JSON.stringify(body),
    });
  }
  private async request(path: string, init: Parameters<SyncFetch>[1]): Promise<unknown> {
    const response = await this.options.fetch(`${this.baseUrl}${path}`, init);
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok) throw new SyncTransportError(`HTTP request failed (${response.status})`, response.status, payload);
    if (isObject(payload) && has(payload, "error")) throw new SyncTransportError(String(payload.error), response.status, payload);
    if (isObject(payload) && has(payload, "code") && has(payload, "message")) {
      throw new SyncTransportError(String(payload.message), Number(payload.code), payload);
    }
    return payload;
  }
}

export interface SyncWebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void, options?: AddEventListenerOptions): void;
}
export type SyncWebSocketFactory = (url: string) => SyncWebSocketLike;
export interface SyncSocketOptions {
  url: string;
  createWebSocket: SyncWebSocketFactory;
  onPush?: (entry: JsonObject) => void;
  onReady?: (event: JsonObject) => void;
  onStatus?: (status: SyncConnectionStatus) => void;
}
export type SyncConnectionStatus = "connecting" | "open" | "initializing" | "ready" | "closed" | "error";
export interface SyncPushEntry {
  path?: string; relatedpath?: string; hash?: string; folder?: boolean; deleted?: boolean;
  size?: number; ctime?: number; mtime?: number; device?: string; user?: string; ts?: number;
  [key: string]: unknown;
}
export interface InitSyncInput {
  token: string; id: string; keyhash: string; version: number; initial: boolean;
  device: string; encryption_version: number;
}
export interface PushSyncInput {
  path: string; relatedpath?: string; extension?: string; hash: string; ctime?: number; mtime?: number;
  folder?: boolean; deleted?: boolean; bytes?: Uint8Array;
}
export interface HistoryResult { items: JsonObject[]; more?: boolean; last?: string; }

/** Raw JSON/binary WebSocket transport. It serializes requests because the
 * observed protocol has a single response slot and no request IDs. */
export class SyncSocketClient {
  private socket?: SyncWebSocketLike;
  private pending?: { resolve: (value: JsonObject) => void; reject: (error: Error) => void };
  private queue: Array<() => void> = [];
  private readyPromise?: Promise<JsonObject>;
  private status: SyncConnectionStatus = "closed";
  private disposed = false;
  private readonly pushListeners = new Set<(entry: SyncPushEntry) => void>();

  constructor(private readonly options: SyncSocketOptions) {}
  get connectionStatus(): SyncConnectionStatus { return this.status; }

  /** Subscribe to server changes, including the initial replay emitted during init. */
  subscribeToPushes(listener: (entry: SyncPushEntry) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.socket && this.status !== "closed" && this.status !== "error") return Promise.resolve();
    this.disposed = false;
    this.setStatus("connecting");
    const socket = this.options.createWebSocket(this.options.url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => { this.setStatus("open"); resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        this.setStatus("error");
        const error = new SyncTransportError("WebSocket connection failed.");
        this.rejectPending(error);
        reject(error);
      }, { once: true });
      socket.addEventListener("close", () => {
        this.setStatus("closed");
        this.rejectPending(new SyncTransportError("WebSocket connection closed."));
      });
      socket.addEventListener("message", (event) => { void this.handleMessage(event); });
    });
  }

  async initialize(input: InitSyncInput): Promise<JsonObject> {
    await this.connect();
    this.setStatus("initializing");
    const response = await this.requestJson({ op: "init", ...input });
    if (response.res !== "ok") throw new SyncTransportError(`Sync initialization rejected: ${String(response.err ?? response.res ?? "unknown error")}`, undefined, response);
    // The server's ready event may arrive immediately after the init acknowledgment.
    this.readyPromise = new Promise((resolve) => {
      if (this.status === "ready") resolve({ op: "ready" });
      else this.waitReady = resolve;
    });
    return response;
  }

  private waitReady?: (value: JsonObject) => void;
  waitUntilReady(): Promise<JsonObject> {
    if (this.status === "ready") return Promise.resolve({ op: "ready" });
    return this.readyPromise ?? Promise.reject(new SyncTransportError("Sync initialization has not started."));
  }
  ping(): void { this.sendJson({ op: "ping" }); }
  deleted(): Promise<JsonObject> { return this.requestJson({ op: "deleted", suppressrenames: true }); }
  history(path: string, last?: string): Promise<HistoryResult> {
    return this.requestJson({ op: "history", path, ...(last === undefined ? {} : { last }) }) as unknown as Promise<HistoryResult>;
  }
  restore(uid: string): Promise<JsonObject> { return this.requestJson({ op: "restore", uid: syncUid(uid) }); }
  usernames(): Promise<JsonObject> { return this.requestJson({ op: "usernames" }); }
  purge(): Promise<JsonObject> { return this.requestJson({ op: "purge" }); }
  size(): Promise<JsonObject> { return this.requestJson({ op: "size" }); }
  pull(uid: string): Promise<Uint8Array> { return this.requestBinary({ op: "pull", uid: syncUid(uid) }); }
  push(input: PushSyncInput): Promise<JsonObject> {
    const bytes = input.bytes;
    const pieces = bytes?.byteLength ? Math.ceil(bytes.byteLength / (2 * 1024 * 1024)) : 0;
    const metadata: JsonObject = {
      op: "push", path: input.path, relatedpath: input.relatedpath, extension: input.extension ?? "",
      hash: input.hash, ctime: syncTimestamp(input.ctime), mtime: syncTimestamp(input.mtime), folder: input.folder ?? false, deleted: input.deleted ?? false,
      ...(bytes ? { size: bytes.byteLength, pieces } : {}),
    };
    return this.enqueue(async () => {
      const reply = await this.exchangeJson(metadata);
      if (reply.res === "ok" || !bytes || pieces === 0) return reply;
      for (let index = 0; index < pieces; index++) {
        const start = index * 2 * 1024 * 1024;
        const piece = bytes.subarray(start, Math.min(start + 2 * 1024 * 1024, bytes.byteLength));
        const acknowledgment = this.takeReply();
        this.sendBinary(piece);
        await acknowledgment;
      }
      return reply;
    });
  }
  close(): void {
    this.disposed = true;
    this.socket?.close();
    this.socket = undefined;
    this.pushListeners.clear();
    this.setStatus("closed");
    this.rejectPending(new SyncTransportError("WebSocket closed by client."));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => { operation().then(resolve, reject).finally(() => { this.queue.shift(); this.queue[0]?.(); }); };
      this.queue.push(run);
      if (this.queue.length === 1) run();
    });
  }
  private requestJson(message: JsonObject): Promise<JsonObject> { return this.enqueue(() => this.exchangeJson(message)); }
  private async exchangeJson(message: JsonObject): Promise<JsonObject> {
    this.ensureOpen(); this.sendJson(message); return this.takeReply();
  }
  private takeReply(): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      if (this.pending) { reject(new SyncTransportError("A sync reply is already pending.")); return; }
      this.pending = { resolve, reject };
    });
  }
  private requestBinary(message: JsonObject): Promise<Uint8Array> {
    return this.enqueue(async () => {
      const response = await this.exchangeJson(message);
      if (response.deleted === true) return new Uint8Array();
      const count = Number(response.pieces ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new SyncTransportError("Invalid binary piece count in pull response.", undefined, response);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < count; i++) chunks.push(await this.takeBinary());
      const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const result = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    });
  }
  private binaryWaiters: Array<(value: Uint8Array) => void> = [];
  private pendingBinary: Uint8Array[] = [];
  private takeBinary(): Promise<Uint8Array> {
    const ready = this.pendingBinary.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => this.binaryWaiters.push(resolve));
  }
  private async handleMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data !== "string") {
      const bytes = await toBytes(event.data);
      const waiter = this.binaryWaiters.shift();
      if (waiter) waiter(bytes); else this.pendingBinary.push(bytes);
      return;
    }
    let message: unknown;
    try { message = JSON.parse(event.data); } catch { this.rejectPending(new SyncTransportError("Server sent invalid JSON.")); return; }
    if (!isObject(message)) return;
    if (message.op === "pong") return;
    if (message.op === "ready") {
      this.setStatus("ready"); this.options.onReady?.(message); this.waitReady?.(message); this.waitReady = undefined; return;
    }
    if (message.op === "push") {
      const entry = message as SyncPushEntry;
      this.options.onPush?.(entry);
      for (const listener of this.pushListeners) listener(entry);
      return;
    }
    const pending = this.pending; this.pending = undefined;
    if (!pending) return;
    if (has(message, "err")) pending.reject(new SyncTransportError(String(message.err), undefined, message));
    else pending.resolve(message);
  }
  private sendJson(message: JsonObject): void { this.ensureOpen(); this.socket!.send(JSON.stringify(message)); }
  private sendBinary(bytes: Uint8Array): void { this.ensureOpen(); this.socket!.send(bytes); }
  private ensureOpen(): void { if (!this.socket || this.socket.readyState !== 1 || this.disposed) throw new SyncTransportError("WebSocket is not open."); }
  private rejectPending(error: Error): void { const pending = this.pending; this.pending = undefined; pending?.reject(error); }
  private setStatus(status: SyncConnectionStatus): void { this.status = status; this.options.onStatus?.(status); }
}

function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function has(object: JsonObject, key: string): boolean { return Object.prototype.hasOwnProperty.call(object, key); }
function syncUid(uid: string): string | number { const numeric = Number(uid); return Number.isSafeInteger(numeric) ? numeric : uid; }
function syncTimestamp(value: number | undefined): number | undefined { return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : undefined; }
async function toBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new SyncTransportError("Server sent an unsupported binary frame.");
}
