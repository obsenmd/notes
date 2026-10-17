import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AccountClient } from "../src/compat/account";
import { PublishClient } from "../src/compat/publish-client";
import { SyncHttpClient } from "../src/compat/sync-client";

interface Recorded { path: string; body: Record<string, unknown>; headers: IncomingMessage["headers"]; bytes: Buffer }
const requests: Recorded[] = [];
const siteOptions: Record<string, unknown> = { navigationOrdering: ["Notes.md"], navigationHiddenItems: [] };
const reply = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  let body: Record<string, unknown> = {};
  if ((req.headers["content-type"] ?? "").toString().includes("application/json") && bytes.length) body = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  requests.push({ path: req.url ?? "", body, headers: req.headers, bytes });
  switch (req.url) {
    case "/user/signin": return reply(res, { token: "fixture-token", name: "Fixture User", email: "fixture@example.test" });
    case "/user/authtoken": return reply(res, { token: "rotated-fixture-token", name: "Fixture User", email: "fixture@example.test" });
    case "/user/info": return reply(res, { name: "Fixture User", email: "fixture@example.test" });
    case "/user/signout": return reply(res, {});
    case "/vault/regions": return reply(res, { regions: [{ value: "local", name: "Local fixture" }] });
    case "/vault/list": return reply(res, { vaults: [{ id: "vault-1", name: "Fixture vault", host: "127.0.0.1", salt: "fixture-salt", encryption_version: 3 }], shared: [] });
    case "/vault/create": return reply(res, { id: "vault-2", name: body.name, host: "127.0.0.1", salt: "fixture-salt", encryption_version: 3 });
    case "/vault/access": return reply(res, {});
    case "/publish/list": return reply(res, { sites: [{ id: "site-1", host: "127.0.0.1" }], shared: [], limit: 3 });
    case "/publish/create": return reply(res, { id: "site-2", host: "127.0.0.1" });
    case "/api/site": return reply(res, { code: "NOTFOUND", message: "Slug is available" });
    case "/api/slug": case "/api/remove": return reply(res, {});
    case "/api/slugs": return reply(res, { "site-1": "fixture" });
    case "/api/list": return reply(res, { owner: true, files: [{ path: "Notes.md", hash: "abc", size: 12 }] });
    case "/api/options":
      if (body.options && typeof body.options === "object") Object.assign(siteOptions, body.options);
      return reply(res, siteOptions);
    case "/api/upload": return reply(res, {});
    default: return reply(res, { error: "No fixture route" }, 404);
  }
});

const storageValues = new Map<string, string>();
const storage = {
  getItem(key: string) { return storageValues.get(key) ?? null; },
  setItem(key: string, value: string) { storageValues.set(key, value); },
  removeItem(key: string) { storageValues.delete(key); },
};

async function main(): Promise<void> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    const account = new AccountClient({ origin, storage, fetch: fetch as never });
    const signedIn = await account.signIn({ email: "fixture@example.test", password: "fixture-password" });
    assert.equal(signedIn.token, "fixture-token");
    assert.equal((await account.refresh()).token, "rotated-fixture-token");
    assert.equal((await account.info()).email, "fixture@example.test");
    await account.signOut();
    assert.equal(account.session, null);

    const sync = new SyncHttpClient({ baseUrl: origin, fetch: fetch as never });
    assert.deepEqual((await sync.regions("fixture-token")).regions.map(region => region.value), ["local"]);
    assert.equal((await sync.listVaults("fixture-token", 3)).vaults[0]?.id, "vault-1");
    assert.equal((await sync.createVault("fixture-token", { name: "Fixture", keyhash: null, region: "local", encryption_version: 3 })).id, "vault-2");
    await sync.accessVault("fixture-token", { vault_uid: "vault-1", keyhash: "hash", host: origin, encryption_version: 3 });

    const publish = new PublishClient({ accountOrigin: origin, registryOrigin: origin, fetch: fetch as never });
    assert.equal((await publish.list("fixture-token")).sites[0]?.id, "site-1");
    assert.equal((await publish.create("fixture-token")).id, "site-2");
    await publish.slug("fixture-token", "free-slug");
    const site = { id: "site-1", host: origin };
    await publish.setSlug("fixture-token", site, "fixture");
    assert.equal((await publish.slugs("fixture-token", ["site-1"]))["site-1"], "fixture");
    assert.equal((await publish.listFiles("fixture-token", site)).files[0]?.path, "Notes.md");
    assert.deepEqual(await publish.getOptions("fixture-token", site), siteOptions);
    await publish.updateOptions("fixture-token", site, { navigationOrdering: ["Folder/Notes.md", "Notes.md"], navigationHiddenItems: ["Folder"] });
    assert.deepEqual(siteOptions.navigationOrdering, ["Folder/Notes.md", "Notes.md"]);
    assert.deepEqual(siteOptions.navigationHiddenItems, ["Folder"]);
    const data = new TextEncoder().encode("fixture upload");
    await publish.upload("fixture-token", site, "Folder/Note + one.md", data, "hash", { ctime: 1.75, mtime: 2.5 });
    await publish.remove("fixture-token", site, "Folder/Note + one.md");

    const signin = requests.find(request => request.path === "/user/signin")!;
    assert.deepEqual(signin.body, { email: "fixture@example.test", password: "fixture-password", mfa: "" });
    const list = requests.find(request => request.path === "/vault/list")!;
    assert.equal(list.body.supported_encryption_version, 3);
    const access = requests.find(request => request.path === "/vault/access")!;
    assert.deepEqual(Object.keys(access.body).sort(), ["encryption_version", "host", "keyhash", "token", "vault_uid"]);
    const upload = requests.find(request => request.path === "/api/upload")!;
    assert.equal(upload.headers["obs-path"], "Folder%2FNote%20%2B%20one.md");
    assert.equal(upload.headers["obs-token"], "fixture-token");
    assert.equal(upload.headers["obs-ctime"], "1");
    assert.equal(upload.headers["obs-mtime"], "2");
    assert.equal(upload.bytes.toString("utf8"), "fixture upload");
    assert.ok(requests.some(request => request.path === "/api/options" && request.body.options !== undefined));
    console.log(`Local account, Sync and Publish route fixture passed (${requests.length} requests).`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
