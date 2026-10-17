import { SyncSocketClient, type HistoryResult, type JsonObject } from "./sync-client";

/** A decoded, stable view of the history entries exposed by the Sync wire protocol. */
export interface SyncHistoryEntry {
  uid: string;
  path: string;
  relatedpath?: string;
  hash?: string;
  deleted: boolean;
  folder: boolean;
  size?: number;
  ctime?: number;
  mtime?: number;
  ts?: number;
  device?: string;
  user?: string;
  [key: string]: unknown;
}

export interface SyncHistoryPage {
  items: SyncHistoryEntry[];
  more: boolean;
  last?: string;
}

/**
 * History paths are encrypted on the wire. Supply deterministic path encode/decode
 * functions from the vault's existing encryption provider; this class never handles keys.
 */
export class SyncHistoryApi {
  constructor(
    private readonly socket: SyncSocketClient,
    private readonly encodePath: (path: string) => Promise<string>,
    private readonly decodePath: (path: string) => Promise<string>,
  ) {}

  async list(path: string, last?: string): Promise<SyncHistoryPage> {
    const encoded = await this.encodePath(path);
    const result = await this.socket.history(encoded, last);
    const items = await Promise.all(result.items.map((item) => this.decodeEntry(item)));
    return { items, more: result.more === true, ...(typeof result.last === "string" ? { last: result.last } : {}) };
  }

  /** Appends a new remote revision copied from the selected historical revision. */
  restore(uid: string): Promise<JsonObject> {
    if (!uid) return Promise.reject(new Error("A history revision ID is required."));
    return this.socket.restore(uid);
  }

  /** Reads the selected historical bytes. The caller is responsible for decryption and writing. */
  pull(uid: string): Promise<Uint8Array> {
    if (!uid) return Promise.reject(new Error("A history revision ID is required."));
    return this.socket.pull(uid);
  }

  private async decodeEntry(item: JsonObject): Promise<SyncHistoryEntry> {
    const entry = { ...item };
    if (typeof entry.path === "string") entry.path = await this.decodePath(entry.path);
    if (typeof entry.relatedpath === "string") entry.relatedpath = await this.decodePath(entry.relatedpath);
    return {
      ...entry,
      uid: String(entry.uid ?? ""),
      path: String(entry.path ?? ""),
      deleted: entry.deleted === true,
      folder: entry.folder === true,
    } as SyncHistoryEntry;
  }
}

/** Normalize raw client data when a caller needs to persist or inspect a page. */
export function isHistoryPage(value: unknown): value is HistoryResult {
  return typeof value === "object" && value !== null && Array.isArray((value as HistoryResult).items);
}
