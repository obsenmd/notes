import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vault } from "../src/compat/vault";
import { NodeDataAdapter } from "../src/compat/node-adapter";
import { ContinuousSyncEngine, type SyncCheckpoint } from "../src/compat/sync-continuous";
import type { SyncSocketClient, SyncPushEntry } from "../src/compat/sync-client";
import type { SyncEncryptionProvider } from "../src/compat/sync-crypto";

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsen-sync-model-"));
  let engine: ContinuousSyncEngine | undefined;
  try {
    const vault = new Vault(new NodeDataAdapter(directory)); await vault.initialize();
    await vault.create("Test.md", "initial");
    const pushes: any[] = [], listeners = new Set<(entry: SyncPushEntry) => void>();
    let fail = false, checkpoint: SyncCheckpoint | undefined;
    const activity: Array<{ action: string; path: string }> = [];
    const socket = {
      connectionStatus: "ready", initialize: async () => ({}), waitUntilReady: async () => ({}), deleted: async () => ({ items: [] }),
      subscribeToPushes: (listener: (entry: SyncPushEntry) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      push: async (entry: any) => { if (fail) throw new Error("offline"); pushes.push(entry); return {}; },
      pull: async () => new TextEncoder().encode("remote"),
    } as unknown as SyncSocketClient;
    const encryption = { deterministicEncodeStr: async (text: string) => text, deterministicDecodeStr: async (text: string) => text, encrypt: async (bytes: Uint8Array) => bytes.buffer, decrypt: async (bytes: ArrayBuffer) => bytes } as unknown as SyncEncryptionProvider;
    engine = new ContinuousSyncEngine({ vault, socket, encryption, init: { token: "fixture", id: "fixture", keyhash: "", device: "fixture", version: 3, encryption_version: 0 }, digest: async bytes => Buffer.from(bytes).toString("hex"), saveState: async state => { checkpoint = state; }, include: file => !file.endsWith(".ignored"), onActivity: (action, file) => activity.push({ action, path: file }), reconnectDelay: 20 });
    await engine.start(); assert.equal(pushes.length, 1);
    assert.deepEqual(activity[0], { action: "upload", path: "Test.md" }, "initial activity comes from a completed transfer");
    fail = true; await vault.modify(vault.getFileByPath("Test.md")!, "local edit"); await delay();
    assert.deepEqual(checkpoint?.pending, ["Test.md"], "failed outbound writes remain durable");
    fail = false; await delay(); assert.ok(pushes.length >= 2); assert.deepEqual(checkpoint?.pending, []);
    await vault.create("Skip.ignored", "skip"); await delay(); assert.ok(!pushes.some(entry => entry.path === "Skip.ignored"));
    // A second edit races a remote change: keep the local bytes in a conflict sibling.
    fail = true; await vault.modify(vault.getFileByPath("Test.md")!, "unsent local"); await delay();
    for (const listener of listeners) listener({ path: "Test.md", hash: "remotehash", uid: "1" }); await delay();
    assert.equal(await vault.read(vault.getFileByPath("Test.md")!), "remote");
    assert.ok(vault.getFiles().some(file => file.path.includes("sync-conflict")));
    assert.ok(activity.some(event => event.action === "merge" && event.path === "Test.md"), "concurrent edits emit a merge activity");
    assert.ok(activity.some(event => event.action === "download" && event.path === "Test.md"), "remote bytes emit download activity");
    await engine.stop(); engine = undefined;
    console.log("continuous sync durable retry, selective files and conflict preservation smoke passed");
  } finally { await engine?.stop(); await fs.rm(directory, { recursive: true, force: true }); }
}
function delay() { return new Promise(resolve => setTimeout(resolve, 65)); }
void main();
