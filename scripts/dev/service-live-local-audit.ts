import { createHash, randomUUID } from "node:crypto";
// @ts-expect-error The guarded CDP client is an ESM audit helper.
import { fixtureClient } from "./fixture-client.mjs";
import { AccountClient } from "../../src/compat/account";
import { PublishClient } from "../../src/compat/publish-client";
import { createSyncEncryptionProvider, deriveSyncPasswordKey } from "../../src/compat/sync-crypto";
import { SyncHttpClient, SyncSocketClient } from "../../src/compat/sync-client";

const origin = "http://127.0.0.1:3000";
const client = await fixtureClient(9446, "obsen-electron-smoke-", { waitForApp: true });
try {
  const sessionJson = await client.evaluate(`localStorage.getItem(${JSON.stringify(`obsidian-account:${origin}`)})`);
  if (!sessionJson) throw new Error("The isolated app fixture has no local test account session.");
  const session = JSON.parse(sessionJson) as { token: string; email: string };
  const storage = new Map([[`obsidian-account:${origin}`, sessionJson]]);
  const account = new AccountClient({ origin, storage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: key => { storage.delete(key); },
  } });
  await account.refresh();
  const profile = await account.info();
  if (profile.email !== "default@localhost") throw new Error("Unexpected local test profile.");

  const http = new SyncHttpClient({ baseUrl: origin, fetch: (input, init) => fetch(input, init as RequestInit) as never });
  const [regions, listing] = await Promise.all([http.regions(session.token), http.listVaults(session.token, 3)]);
  const remoteName = "luna-audit-sync-20261014";
  let remote = listing.vaults.find(item => item.name === remoteName);
  if (!remote) remote = await http.createVault(session.token, {
    name: remoteName, keyhash: null, region: regions.regions[0]!.value, encryption_version: 3,
  });
  if (!remote.salt || !remote.host) throw new Error("The local Sync server returned incomplete vault metadata.");
  const password = remote.password ?? listing.vaults.find(item => item.id === remote!.id)?.password;
  if (!password) throw new Error("The dedicated audit vault did not return its standard-mode password.");
  const key = await deriveSyncPasswordKey(password, remote.salt);
  const encryption = await createSyncEncryptionProvider(3, key, remote.salt);
  key.fill(0);
  await http.accessVault(session.token, {
    vault_uid: remote.id, keyhash: encryption.keyHash, host: remote.host, encryption_version: 3,
  });

  const socket = new SyncSocketClient({
    url: `ws://${remote.host}/`, createWebSocket: url => new WebSocket(url),
  });
  try {
    await socket.initialize({
      token: session.token, id: remote.id, keyhash: encryption.keyHash,
      version: 3, initial: true, device: `luna-audit-${randomUUID()}`, encryption_version: 3,
    });
    await socket.waitUntilReady();
    const clear = new TextEncoder().encode("Luna local Sync audit fixture content.");
    const path = await encryption.deterministicEncodeStr("luna-audit-proof.md");
    const encrypted = new Uint8Array(await encryption.encrypt(clear));
    const hash = createHash("sha256").update(clear).digest("hex");
    const timestamp = Date.now();
    await socket.push({ path, hash, extension: "md", ctime: timestamp, mtime: timestamp, bytes: encrypted });
    const firstHistory = await socket.history(path);
    const original = firstHistory.items?.[0];
    if (!original?.uid) throw new Error("The local Sync server did not persist the uploaded revision.");
    const pulled = await socket.pull(String(original.uid));
    const decoded = new TextDecoder().decode(await encryption.decrypt(pulled));
    if (decoded !== new TextDecoder().decode(clear)) throw new Error("Pulled Sync content failed decryption.");
    await socket.push({ path, hash: "", deleted: true });
    const deleted = await socket.deleted();
    if (!Array.isArray(deleted.items) || deleted.items.length === 0) throw new Error("The local Sync server did not expose the deleted revision.");
    await socket.restore(String(original.uid));
    const restoredHistory = await socket.history(path);
    if (!restoredHistory.items?.length) throw new Error("The local Sync server did not restore the prior revision.");
    await socket.push({ path, hash: "", deleted: true });
  } finally { socket.close(); }

  const publish = new PublishClient({ accountOrigin: origin, registryOrigin: origin });
  const sites = await publish.list(session.token);
  const site = await publish.create(session.token);
  const slug = `luna-audit-publish-${Date.now()}`;
  await publish.slug(session.token, slug);
  await publish.setSlug(session.token, site, slug);
  const body = new TextEncoder().encode("Luna local Publish audit fixture content.");
  const publishPath = "luna-audit-proof.md";
  await publish.upload(session.token, site, publishPath, body, createHash("sha256").update(body).digest("hex"), { ctime: Date.now(), mtime: Date.now() });
  const uploaded = await publish.listFiles(session.token, site);
  if (!uploaded.files.some(file => file.path === publishPath)) throw new Error("The local Publish server did not list the uploaded file.");
  await publish.updateOptions(session.token, site, { navigationOrdering: [publishPath], navigationHiddenItems: [] });
  const options = await publish.getOptions(session.token, site);
  if (!Array.isArray(options.navigationOrdering) || !options.navigationOrdering.includes(publishPath)) throw new Error("The local Publish server did not persist navigation options.");
  await publish.remove(session.token, site, publishPath);
  const afterRemove = await publish.listFiles(session.token, site);
  if (afterRemove.files.some(file => file.path === publishPath)) throw new Error("The local Publish server did not remove the audit file.");

  await account.signOut();
  await client.evaluate(`localStorage.removeItem(${JSON.stringify(`obsidian-account:${origin}`)})`);
  console.log(JSON.stringify({
    account: { signInSessionPresent: true, refresh: "passed", profile: profile.email, signOut: "passed" },
    sync: { region: regions.regions[0]?.value, vault: remoteName, access: "passed", websocket: "ready", upload: "passed", downloadDecrypt: "passed", delete: "passed", restore: "passed", finalCleanup: "deleted audit path" },
    publish: { preexistingSites: sites.sites.length, slug, upload: "passed", navigationOptionsPersisted: "passed", delete: "passed", finalContentCount: afterRemove.files.length },
  }, null, 2));
} finally {
  client.socket.close();
}
