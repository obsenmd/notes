import { EventEmitter } from "node:events";

/** Storage and frame lifecycle belonging to one polyfilled browser session. */
export class BrowserSession extends EventEmitter {
  readonly partition: string;
  readonly prefix: string;
  private userAgent = navigator.userAgent;
  availableSpellCheckerLanguages = [...navigator.languages];
  constructor(partition: string) { super(); this.partition = partition; this.prefix = `positron:${partition}:`; }
  getUserAgent(): string { return this.userAgent; }
  setUserAgent(value: string): void { this.userAgent = value; }
  setSpellCheckerLanguages(languages: string[]): void { this.emit("spellcheck-languages", languages); }
  webRequest = {
    onBeforeRequest: (_filter: unknown, listener: (details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void) => { this.beforeRequest = listener; },
  };
  private beforeRequest?: (details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void;
  async allows(url: string): Promise<boolean> {
    if (!this.beforeRequest) return true;
    return new Promise(resolve => this.beforeRequest!({ url }, response => resolve(!response.cancel)));
  }
  async clearStorageData(options: { storages?: string[] } = {}): Promise<void> {
    const kinds = options.storages ?? ["cachestorage", "localstorage"];
    if (kinds.includes("cachestorage") && typeof caches !== "undefined") {
      for (const name of await caches.keys()) if (name.startsWith(this.prefix)) await caches.delete(name);
    }
    if ((kinds.includes("localstorage") || kinds.includes("cookies")) && typeof localStorage !== "undefined") {
      for (let index = localStorage.length - 1; index >= 0; index--) { const name = localStorage.key(index); if (name?.startsWith(this.prefix)) localStorage.removeItem(name); }
    }
    this.emit("clear-storage", kinds);
  }
  async clearData(): Promise<void> { await this.clearStorageData(); }
}
const sessions = new Map<string, BrowserSession>();
export const session = {
  fromPartition(partition: string): BrowserSession {
    let selected = sessions.get(partition);
    if (!selected) { selected = new BrowserSession(partition); sessions.set(partition, selected); }
    return selected;
  },
};
