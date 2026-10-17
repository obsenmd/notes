import { nodeScrypt, Buffer } from "../../platforms/platform";
/**
 * Obsidian Sync encryption adapter reconstructed from the pinned headless
 * client (0.0.14, commit 0d0ec4364bfde6c715c539cf3555ff8272bb7a58).
 * See private/docs/protocol.md and private/analysis/headless.formatted.js
 * around lines 11292-11446 for the observed algorithms.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = globalThis.crypto.subtle;
const KEY_HASH_INFO = encoder.encode("ObsidianKeyHash");
const CONTENT_INFO = encoder.encode("ObsidianAesGcm");
const SIV_MAC_INFO = encoder.encode("ObsidianAesSivMac");
const SIV_ENC_INFO = encoder.encode("ObsidianAesSivEnc");

export type SyncEncryptionVersion = 0 | 2 | 3;

export async function deriveSyncPasswordKey(password: string, salt: string): Promise<Uint8Array> {
  const normalizedPassword = password.normalize("NFKC");
  const normalizedSalt = salt.normalize("NFKC");
  const key = await new Promise<Buffer>((resolve, reject) => nodeScrypt(
    Buffer.from(normalizedPassword, "utf8"), Buffer.from(normalizedSalt, "utf8"), 32,
    { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 * 2 },
    (error, derived) => error ? reject(error) : resolve(derived),
  ));
  return new Uint8Array(key);
}

export async function deriveSyncKeyHash(key: Uint8Array, salt: string, version: SyncEncryptionVersion): Promise<string> {
  if (key.byteLength !== 32) throw new Error("Invalid encryption key");
  const hash = version === 0
    ? await subtle.digest("SHA-256", source(key))
    : await deriveHkdf(key, encoder.encode(salt), KEY_HASH_INFO, "AES-CBC", true);
  return toHex(new Uint8Array(hash));
}

export interface SyncEncryptionProvider {
  readonly encryptionVersion: SyncEncryptionVersion;
  readonly keyHash: string;
  encrypt(data: BufferSource): Promise<ArrayBuffer>;
  decrypt(data: BufferSource): Promise<ArrayBuffer>;
  deterministicEncodeStr(text: string): Promise<string>;
  deterministicDecodeStr(encoded: string): Promise<string>;
}

export async function createSyncEncryptionProvider(
  version: SyncEncryptionVersion,
  keyBytes: Uint8Array,
  salt: string,
): Promise<SyncEncryptionProvider> {
  if (version !== 0 && version !== 2 && version !== 3) throw new Error("Encryption version not supported");
  if (keyBytes.byteLength !== 32) throw new Error("Invalid encryption key");
  const key = keyBytes.slice();
  const keyHash = await deriveSyncKeyHash(key, salt, version);
  let contentKey: CryptoKey;
  let pathCipher: AesSiv | null = null;
  if (version === 0) {
    contentKey = await subtle.importKey("raw", source(key), "AES-GCM", false, ["encrypt", "decrypt"]);
  } else {
    const hkdfKey = await subtle.importKey("raw", source(key), "HKDF", false, ["deriveKey"]);
    pathCipher = await AesSiv.create(hkdfKey, encoder.encode(salt));
    contentKey = await subtle.deriveKey({ name: "HKDF", salt: new Uint8Array(), info: CONTENT_INFO, hash: "SHA-256" }, hkdfKey,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  return {
    encryptionVersion: version,
    keyHash,
    async encrypt(data) {
      const bytes = toBytes(data);
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv: source(iv) }, contentKey, source(bytes));
      const result = new Uint8Array(12 + ciphertext.byteLength);
      result.set(iv); result.set(new Uint8Array(ciphertext), 12);
      return result.buffer;
    },
    async decrypt(data) {
      const bytes = toBytes(data);
      if (bytes.byteLength < 12) throw new Error("Encrypted data is bad");
      if (bytes.byteLength === 12) return new ArrayBuffer(0);
      return subtle.decrypt({ name: "AES-GCM", iv: source(bytes.subarray(0, 12)) }, contentKey, source(bytes.subarray(12)));
    },
    async deterministicEncodeStr(text) {
      const bytes = encoder.encode(text);
      if (pathCipher) return toHex(await pathCipher.seal(bytes));
      const digest = await subtle.digest("SHA-256", source(bytes));
      const iv = new Uint8Array(digest, 0, 12);
      const encrypted = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: source(iv) }, contentKey, source(bytes)));
      const combined = new Uint8Array(12 + encrypted.length); combined.set(iv); combined.set(encrypted, 12);
      return toHex(combined);
    },
    async deterministicDecodeStr(encoded) {
      const bytes = fromHex(encoded);
      if (pathCipher) return decoder.decode(await pathCipher.open(bytes));
      if (bytes.byteLength < 12) throw new Error("Encrypted data is bad");
      const clear = await subtle.decrypt({ name: "AES-GCM", iv: source(bytes.subarray(0, 12)) }, contentKey, source(bytes.subarray(12)));
      return decoder.decode(clear);
    },
  };
}

async function deriveHkdf(key: Uint8Array, salt: Uint8Array, info: Uint8Array, algorithm: "AES-CBC" | "AES-GCM", extractable: boolean): Promise<ArrayBuffer> {
  const material = await subtle.importKey("raw", source(key), "HKDF", false, ["deriveKey"]);
  const derived = await subtle.deriveKey({ name: "HKDF", salt: source(salt), info: source(info), hash: "SHA-256" }, material,
    { name: algorithm, length: 256 }, extractable, ["encrypt"]);
  return subtle.exportKey("raw", derived);
}

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
function source(bytes: Uint8Array): BufferSource { return bytes as unknown as BufferSource; }
function toHex(bytes: Uint8Array): string { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
function fromHex(value: string): Uint8Array {
  if (value.length % 2 || !/^[\da-f]*$/i.test(value)) throw new Error("Invalid encrypted string");
  return Uint8Array.from({ length: value.length / 2 }, (_, i) => Number.parseInt(value.slice(i * 2, i * 2 + 2), 16));
}

// RFC 5297 S2V/AES-SIV, matching the headless client's HKDF-separated CMAC
// and CTR keys and its specified tag bit clearing.
class AesSiv {
  private constructor(private readonly macKey: CryptoKey, private readonly ctrKey: CryptoKey) {}
  static async create(master: CryptoKey, salt: Uint8Array): Promise<AesSiv> {
    const macKey = await subtle.deriveKey({ name: "HKDF", salt: source(salt), info: source(SIV_MAC_INFO), hash: "SHA-256" }, master,
      { name: "AES-CBC", length: 256 }, false, ["encrypt"]);
    const ctrKey = await subtle.deriveKey({ name: "HKDF", salt: source(salt), info: source(SIV_ENC_INFO), hash: "SHA-256" }, master,
      { name: "AES-CTR", length: 256 }, false, ["encrypt"]);
    return new AesSiv(macKey, ctrKey);
  }
  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const tag = await this.s2v(plain);
    const ctr = tag.slice(); ctr[8] &= 0x7f; ctr[12] &= 0x7f;
    const encrypted = await subtle.encrypt({ name: "AES-CTR", counter: source(ctr), length: 16 }, this.ctrKey, source(plain));
    const result = new Uint8Array(16 + encrypted.byteLength); result.set(tag); result.set(new Uint8Array(encrypted), 16); return result;
  }
  async open(cipher: Uint8Array): Promise<Uint8Array> {
    if (cipher.byteLength < 16) throw new Error("AES-SIV: ciphertext is truncated");
    const tag = cipher.subarray(0, 16); const ctr = tag.slice(); ctr[8] &= 0x7f; ctr[12] &= 0x7f;
    // AES-CTR is symmetric; upstream's provider calls encryptCtr for both directions.
    const plain = new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter: source(ctr), length: 16 }, this.ctrKey, source(cipher.subarray(16))));
    const expected = await this.s2v(plain);
    if (!constantTimeEqual(tag, expected)) { plain.fill(0); throw new Error("AES-SIV: ciphertext verification failure!"); }
    return plain;
  }
  private async s2v(plain: Uint8Array): Promise<Uint8Array> {
    let d = await this.cmac(new Uint8Array(16));
    if (plain.byteLength >= 16) {
      const prefix = plain.slice(0, plain.byteLength - 16); const tail = plain.slice(-16);
      for (let i = 0; i < 16; i++) tail[i] ^= d[i];
      return this.cmac(concat(prefix, tail));
    }
    d = doubleBlock(d);
    const padded = new Uint8Array(16); padded.set(plain); padded[plain.length] = 0x80;
    for (let i = 0; i < 16; i++) padded[i] ^= d[i];
    return this.cmac(padded);
  }
  private async cmac(message: Uint8Array): Promise<Uint8Array> {
    const zero = new Uint8Array(16);
    const l = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: source(zero) }, this.macKey, source(zero))).subarray(0, 16);
    const k1 = doubleBlock(l), k2 = doubleBlock(k1);
    const complete = message.length > 0 && message.length % 16 === 0;
    const blocks = Math.max(1, Math.ceil(message.length / 16));
    let state = new Uint8Array(16);
    for (let block = 0; block < blocks - 1; block++) {
      const current = message.subarray(block * 16, block * 16 + 16);
      for (let i = 0; i < 16; i++) state[i] ^= current[i];
      state = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: source(zero) }, this.macKey, source(state))).subarray(0, 16);
    }
    const last = new Uint8Array(16); const offset = (blocks - 1) * 16;
    last.set(message.subarray(offset));
    if (complete) { for (let i = 0; i < 16; i++) last[i] ^= k1[i]; }
    else { last[message.length - offset] = 0x80; for (let i = 0; i < 16; i++) last[i] ^= k2[i]; }
    for (let i = 0; i < 16; i++) state[i] ^= last[i];
    return new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: source(zero) }, this.macKey, source(state))).subarray(0, 16);
  }
}
function doubleBlock(block: Uint8Array): Uint8Array {
  const result = new Uint8Array(16); let carry = 0;
  for (let i = 15; i >= 0; i--) { const next = block[i] >>> 7; result[i] = ((block[i] << 1) | carry) & 0xff; carry = next; }
  if (carry) result[15] ^= 0x87;
  return result;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
