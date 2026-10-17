import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommunityPluginLoader } from "../src/compat/community-plugin-loader";
import { App } from "../src/compat/plugin";

async function main(): Promise<void> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "obsen-plugin-smoke-"));
  const app = new App();
  const errors: Error[] = [];
  const loader = new CommunityPluginLoader(app.plugins, { onError: (_id, error) => errors.push(error) });
  const id = "async-fixture";
  const root = path.join(vault, ".obsidian", "plugins", id);
  const list = path.join(vault, ".obsidian", "community-plugins.json");
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({
      id, name: "Async fixture", author: "test", version: "1", minAppVersion: "1",
    }));
    await fs.writeFile(path.join(root, "main.js"), `
      const { Plugin } = require("obsidian");
      module.exports = class extends Plugin {
        async onload() {
          this.registerCliHandler("async-fixture:echo", "Echo a value", { value: { value: "<text>", description: "Text to echo", required: true } }, params => String(params.value ?? ""));
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      };
    `);
    await fs.writeFile(list, JSON.stringify([id]));
    const results = await Promise.all([loader.loadVault(vault), loader.reloadVault(vault), loader.loadVault(vault)]);
    assert.equal(results.flatMap(result => result.failures).length, 0, "concurrent startup and reload must not collide");
    assert.equal(app.plugins.listPlugins().length, 1);
    assert.equal(app.plugins.getPlugin(id)?.manifest.description, undefined, "the reference accepts a manifest without description");
    assert.equal(await app.invokeCliHandler("async-fixture:echo", { value: "fixture argument" }), "fixture argument", "registered plugin CLI handlers receive parsed arguments and return their output");
    assert.equal(app.cliHandlers.get("async-fixture:echo")?.flags?.value?.required, true, "CLI flag metadata is retained for host help and validation");
    const optionalManifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
    optionalManifest.description = "";
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(optionalManifest));
    assert.equal((await loader.reloadVault(vault)).failures.length, 0, "an empty optional description is accepted");
    await fs.writeFile(list, "[]");
    await loader.reloadVault(vault);
    assert.equal(app.plugins.getPlugin(id), undefined, "disabling unloads the plugin");
    assert.equal(app.cliHandlers.has("async-fixture:echo"), false, "disabling removes the plugin's CLI handler");
    await fs.writeFile(list, JSON.stringify([id]));
    await loader.reloadVault(vault);
    assert.ok(app.plugins.getPlugin(id), "enabling starts the plugin again");
    assert.equal(await app.invokeCliHandler("async-fixture:echo", { value: "again" }), "again", "re-enabling registers the CLI handler again");
    await fs.writeFile(list, "invalid-json");
    assert.equal((await loader.reloadVault(vault)).failures.length, 1);
    assert.ok(app.plugins.getPlugin(id), "invalid configuration preserves the running plugin");
    await fs.writeFile(list, "[]");
    await loader.reloadVault(vault);
    assert.equal(app.plugins.listPlugins().length, 0, "the queue recovers after invalid configuration");
    assert.equal(errors.length, 1, "only the deliberate invalid JSON produces an error");
    await fs.writeFile(path.join(root, "data.json"), '{"retained":true}');
    const lifecycle = globalThis as typeof globalThis & { __pluginEnableLifecycle?: string[] };
    lifecycle.__pluginEnableLifecycle = [];
    const release = { manifest: { id, name: "Updated fixture", author: "test", version: "2", minAppVersion: "1", description: "Install fixture" }, main: 'const {Plugin}=require("obsidian");module.exports=class extends Plugin {onload(){globalThis.__pluginEnableLifecycle.push("onload")}onUserEnable(){globalThis.__pluginEnableLifecycle.push("onUserEnable")}onunload(){globalThis.__pluginEnableLifecycle.push("onunload")}};' };
    const installed = await loader.install(vault, id, release);
    assert.equal(installed.failures.length, 0);
    assert.equal(app.plugins.getPlugin(id)?.manifest.version, "2");
    assert.deepEqual(lifecycle.__pluginEnableLifecycle, ["onload"], "startup/install does not call the explicit user-enable hook");
    assert.equal(await fs.readFile(path.join(root, "data.json"), "utf8"), '{"retained":true}', "updates retain user plugin data");
    await loader.setEnabled(vault, id, false); assert.equal(app.plugins.getPlugin(id), undefined);
    assert.deepEqual(lifecycle.__pluginEnableLifecycle, ["onload", "onunload"], "disabling a plugin without registrations still calls onunload");
    await loader.setEnabled(vault, id, true); assert.ok(app.plugins.getPlugin(id));
    assert.deepEqual(lifecycle.__pluginEnableLifecycle, ["onload", "onunload", "onload", "onUserEnable"], "user enable follows the new plugin's onload exactly once");
    console.log("community plugin concurrency and enable/disable smoke passed");
  } finally {
    loader.unloadAll();
    await fs.rm(vault, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
