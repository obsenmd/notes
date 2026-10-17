import { getRemote, Buffer } from "../../platforms/platform";
import { Events } from "./events";
import type { StorageLike } from "./plugin";

/** Persistent implementation of the official SecretStorage contract. */
export class SecretStorage extends Events {
  private readonly values = new Map<string, string>();
  private readonly storageKey: string;
  private readonly safeStorage?: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string };

  constructor(private readonly storage: StorageLike, namespace = "app") {
    super();
    this.storageKey = `obsen:vault:${namespace === "app" ? "secrets-encrypted" : `secrets-encrypted:${namespace}`}`;
    try {
      const remote = getRemote() as { safeStorage?: SecretStorage["safeStorage"] };
      this.safeStorage = remote.safeStorage;
    } catch { /* A non-Electron test host can still use the unencrypted fallback. */ }
    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) return;
      let decoded = raw;
      if (this.safeStorage?.isEncryptionAvailable()) decoded = this.safeStorage.decryptString(Buffer.from(raw, "base64"));
      const value: unknown = JSON.parse(decoded);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [id, secret] of Object.entries(value)) if (typeof secret === "string") this.values.set(id, secret);
      }
    } catch { /* Ignore corrupt secret data and allow secrets to be reset. */ }
  }

  setSecret(id: string, secret: string): void {
    if (!this.validateId(id)) throw new Error("Secret ID must contain only lowercase letters, numbers, and dashes, and be at most 64 characters.");
    if (typeof secret !== "string") throw new TypeError("Secret must be a string.");
    const previous = this.values.get(id);
    if (previous === secret) return;
    this.values.set(id, secret);
    this.persist();
  }

  getSecret(id: string): string | null { return this.peekSecret(id); }
  peekSecret(id: string): string | null { return this.values.get(id) ?? null; }
  listSecrets(): string[] { return [...this.values.keys()]; }
  validateId(id: string): boolean { return /^[a-z0-9-]{1,64}$/.test(id); }
  isEncryptionAvailable(): boolean { return this.safeStorage?.isEncryptionAvailable() ?? false; }

  /** Host helper for removing a secret; deletion reports whether a key existed. */
  deleteSecret(id: string): boolean {
    if (!this.values.delete(id)) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    if (this.values.size === 0) { this.storage.removeItem(this.storageKey); return; }
    const serialized = JSON.stringify(Object.fromEntries(this.values));
    const stored = this.isEncryptionAvailable() ? this.safeStorage!.encryptString(serialized).toString("base64") : serialized;
    this.storage.setItem(this.storageKey, stored);
  }
}
