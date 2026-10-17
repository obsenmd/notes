import assert from "node:assert/strict";
import fs from "node:fs/promises";
import originalFs from "original-fs";
import os from "node:os";
import path from "node:path";
import { Editor } from "../src/compat/editor";
import { MarkdownView } from "../src/compat/markdown-view";
import type { App } from "../src/compat/plugin";
import { Menu } from "../src/compat/ui";
import { TFile, type Vault } from "../src/compat/vault";
import { Workspace } from "../src/compat/workspace";
import { CorePluginStore, watchCoreHoverLinkSources } from "../src/renderer/core-plugins";
import { noteComposerPlugin } from "../src/renderer/core/note-composer";
import type { CorePluginContext } from "../src/renderer/core/types";
import { HoverPopover, PopoverState } from "../src/renderer/hover-preview";
import { VaultConfig, writeJson } from "../src/renderer/config";
import { t } from "../src/i18n";

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsen-followups-node-"));
  const previousWindow = globalThis.window;
  const fakeWindow = Object.assign(new EventTarget(), { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  globalThis.window = fakeWindow as unknown as Window & typeof globalThis;
  const originalShow = Menu.prototype.showAtMouseEvent;
  try {
    assert.equal(t("nouns.result-with-count", { count: 1200 }), "1,200 results", "numeric interpolation follows the active locale");
    const settingsFile = path.join(directory, "overlapping-settings.json"), settings = { value: 0 };
    const saves: Promise<void>[] = [];
    for (let value = 0; value < 60; value++) { settings.value = value; saves.push(writeJson(settingsFile, settings)); }
    settings.value = 999;
    await Promise.all(saves);
    assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, "utf8")), { value: 59 }, "overlapping saves preserve submission order and snapshot data");
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith(".tmp")), false, "successful saves leave no temporary files");
    const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), deviceValues = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => deviceValues.get(key) ?? null, setItem: (key: string, value: string) => deviceValues.set(key, value) } });
    try {
      const fontVault = path.join(directory, "font-preferences"), appearancePath = path.join(fontVault, ".obsidian", "appearance.json");
      await writeJson(appearancePath, {baseFontSize: 18});
      const preferences = new VaultConfig(fontVault); await preferences.load();
      assert.equal(preferences.get("baseFontSize"), 18, "legacy font preference migrates to this device");
      preferences.set("baseFontSize", 20);
      assert.equal(preferences.getRaw("baseFontSize"), 18, "device font setting preserves the vault's raw preference");
      preferences.setRaw("baseFontSize", 22); await preferences.flush();
      assert.equal(preferences.get("baseFontSize"), 20, "a later raw vault write does not override the migrated device preference");
      assert.equal(JSON.parse(await fs.readFile(appearancePath, "utf8")).baseFontSize, 22, "raw preference persists in the vault");
      const reopened = new VaultConfig(fontVault); await reopened.load();
      assert.equal(reopened.get("baseFontSize"), 20, "reopening retains the device preference");
      deviceValues.clear();
      assert.equal(reopened.get("baseFontSize"), 22, "a new device starts from the latest stored vault preference");
    } finally {
      if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
    if (process.platform === "win32") {
      const rename = originalFs.promises.rename;
      let attempts = 0;
      originalFs.promises.rename = (async (...args: Parameters<typeof rename>) => {
        if (args[1] === settingsFile && ++attempts <= 2) {
          assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, "utf8")), { value: 59 }, "locked replacement preserves existing settings");
          throw Object.assign(new Error("Temporary destination lock"), { code: "EPERM" });
        }
        return rename(...args);
      }) as typeof rename;
      try { await writeJson(settingsFile, { value: 60 }); }
      finally { originalFs.promises.rename = rename; }
      assert.equal(attempts, 3, "transient Windows rename locks are retried");
      assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, "utf8")), { value: 60 });
      assert.equal((await fs.readdir(directory)).some(name => name.endsWith(".tmp")), false);
    }
    const recoveryFile = path.join(directory, "failed-settings.json");
    await fs.mkdir(recoveryFile);
    await assert.rejects(writeJson(recoveryFile, { value: 1 }));
    await fs.rmdir(recoveryFile);
    await writeJson(recoveryFile, { value: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(recoveryFile, "utf8")), { value: 2 }, "a failed save does not poison later saves");
    const app = {} as App;
    app.workspace = new Workspace(app);
    const workspace = app.workspace;
    const store = new CorePluginStore(directory);
    const changes: string[] = [];
    workspace.on("hover-link-sources-changed", () => changes.push("changed"));
    assert.equal(workspace.hoverLinkSources.preview.defaultMod, false, "reading view requires no modifier by default");
    assert.equal(workspace.hoverLinkSources.editor.defaultMod, true);
    workspace.registerHoverLinkSource("community-fixture", { display: "Community preview", defaultMod: false });
    const stopSources = watchCoreHoverLinkSources(workspace, store);
    assert.equal(workspace.hoverLinkSources.graph.defaultMod, true);
    await store.setEnabled("graph", false);
    assert.equal(workspace.hoverLinkSources.graph, undefined, "disabling a core plugin removes its source");
    await store.setEnabled("graph", true);
    assert.equal(workspace.hoverLinkSources.graph.defaultMod, true, "re-enabling restores its source");
    stopSources();
    assert.equal(workspace.hoverLinkSources.graph, undefined);
    assert.equal(workspace.hoverLinkSources["community-fixture"].defaultMod, false, "core cleanup preserves community sources");
    workspace.unregisterHoverLinkSource("community-fixture");
    assert.ok(changes.length > 6, "registry mutations notify settings subscribers");

    const file = new TFile({} as Vault, "Context.md");
    const editor = new Editor("# Heading\n\nA body selection");
    const target = {} as Node;
    editor.cm = { contentDOM: { contains: (node: Node) => node === target } } as unknown as Editor["cm"];
    const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, { app, file, editor, currentMode: {}, previewMode: {} });
    const disposeComposer = noteComposerPlugin.install!({ app, actions: {} } as CorePluginContext);
    let observed = 0, captured: Menu | null = null, clicked = false;
    const ref = workspace.on("editor-menu", (...args) => {
      const [menu, actualEditor, owner] = args as [Menu, Editor, MarkdownView];
      assert.equal(actualEditor, editor); assert.equal(owner, view); assert.equal(owner.file, file);
      observed++;
      menu.addItem(item => item.setTitle("Community action").onClick(() => { clicked = true; }));
    });
    Menu.prototype.showAtMouseEvent = function () { captured = this; return this; };
    const pendingMenus: Array<() => void> = [];
    const sharedEvent = Object.assign(new Event("contextmenu", { cancelable: true }), {
      view: { setTimeout(callback: () => void) { pendingMenus.push(callback); return 1; } },
    }) as unknown as MouseEvent;
    const firstHandlerMenu = Menu.forEvent(sharedEvent);
    firstHandlerMenu.addItem(item => item.setTitle("First plugin action"));
    const secondHandlerMenu = Menu.forEvent(sharedEvent);
    secondHandlerMenu.addItem(item => item.setTitle("Second plugin action"));
    assert.equal(firstHandlerMenu, secondHandlerMenu, "handlers for one event contribute to one shared menu");
    assert.equal(sharedEvent.defaultPrevented, true);
    assert.equal(captured, null, "the menu waits until handlers finish contributing entries");
    assert.equal(pendingMenus.length, 1, "the same event schedules only one menu presentation");
    pendingMenus[0]();
    assert.equal(captured, firstHandlerMenu);
    assert.deepEqual(firstHandlerMenu.items.map(item => (item as unknown as { title: string }).title), ["First plugin action", "Second plugin action"]);
    const open = () => {
      const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      (view as unknown as { onEditorContextMenu(event: MouseEvent): void }).onEditorContextMenu(event as unknown as MouseEvent);
      assert.equal(event.defaultPrevented, true, "editor menu replaces the native context menu");
      return (captured as unknown as Menu).items.map(item => String((item as unknown as { title: string }).title));
    };
    editor.setSelection({ line: 2, ch: 0 }, { line: 2, ch: 6 });
    assert.ok(open().includes("Extract current selection..."));
    assert.equal(editor.getSelection(), "A body", "opening the menu preserves the selection");
    assert.ok(!open().includes("Extract this heading..."));
    editor.setCursor({ line: 0, ch: 2 });
    const titles = open();
    assert.ok(titles.includes("Extract this heading...") && !titles.includes("Extract current selection..."));
    const menu = captured as unknown as Menu;
    menu.items[titles.indexOf("Community action")].handleEvent({} as MouseEvent);
    assert.equal(clicked, true, "community menu actions remain executable");
    if (typeof disposeComposer === "function") disposeComposer();
    assert.ok(!open().includes("Extract this heading..."), "unloading note composer removes its entries");
    workspace.offref(ref);
    assert.ok(observed >= 4);

    const fakeDoc = { defaultView: fakeWindow, createElement: () => Object.assign(new EventTarget(), { className: "", isConnected: false, remove() { this.isConnected = false; } }) };
    const fakeTarget = Object.assign(new EventTarget(), { ownerDocument: fakeDoc, isConnected: true });
    const popover = new HoverPopover({ hoverPopover: null }, fakeTarget as unknown as HTMLElement);
    popover.position = () => { Object.assign(popover.hoverEl, { isConnected: true }); };
    let revealed = 0;
    popover.whenShown(() => { assert.equal(popover.hoverEl.isConnected, true); revealed++; });
    assert.equal(revealed, 0, "scrolling waits through the hover delay");
    popover.show();
    assert.equal(revealed, 1, "pre-rendered content scrolls when the popover appears");
    popover.whenShown(() => { revealed++; });
    assert.equal(revealed, 2, "content rendered after showing scrolls immediately");
    popover.hide();
    popover.whenShown(() => { revealed++; });
    assert.equal(revealed, 2, "a dismissed preview never scrolls");
    assert.equal(popover.state, PopoverState.Hidden);
    console.log("Editor follow-ups passed: menu owner/selection/composer/community callbacks, hover source lifecycle, deferred preview scrolling.");
  } finally {
    Menu.prototype.showAtMouseEvent = originalShow;
    globalThis.window = previousWindow;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
