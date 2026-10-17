import assert from "node:assert/strict";
import { CommandRegistry, makeHotkey } from "../src/compat/commands";
import { App, Plugin, type PluginManifest } from "../src/compat/plugin";
import { Editor } from "../src/compat/editor";
import { Workspace, View } from "../src/compat/workspace";
import type { App as AppType } from "../src/compat/plugin";

async function main() {
const registry = new CommandRegistry();
const calls: string[] = [];
let available = true;
registry.add({ id: "conditional", name: "Conditional", checkCallback: (checking) => {
  calls.push(checking ? "check" : "run");
  if (checking) return available;
  calls.push("effect");
  return available;
} });
assert.equal(registry.execute("conditional"), true);
assert.deepEqual(calls, ["check", "run", "effect"]);
calls.length = 0;
assert.equal(registry.execute("conditional"), true, "direct command invocation checks then runs");
assert.deepEqual(calls, ["check", "run", "effect"]);
calls.length = 0;
const registryKeymap = registry.keymap;
const directEvent = { key: "x", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault() {} } as unknown as KeyboardEvent;
registry.add({ id: "hotkey", name: "Hotkey", hotkeys: [makeHotkey([], "x")], callback: () => { calls.push("hotkey-run"); } });
assert.equal(registryKeymap.handleKey(directEvent), true);
available = false;
assert.equal(registry.execute("conditional"), false);
assert.equal(registry.isAvailable("conditional"), false);

const app = new App();
const workspace = new Workspace(app as unknown as AppType);
app.workspace = workspace;
let editorCalls = 0;
let callbackCalls = 0;
let editor: Editor;
let view: SmokeView;
const editorCommand = {
  id: "edit", name: "Edit",
  callback: () => { callbackCalls++; },
  editorCheckCallback: (checking: boolean, actualEditor: unknown, actualView: unknown) => {
    assert.equal(actualEditor, editor);
    assert.equal(actualView, view);
    if (!checking) editorCalls++;
    return true;
  },
  hotkeys: [makeHotkey(["Mod"], "k")],
};
class SmokeView extends View {
  editor = new Editor("text");
  getViewType(): string { return "smoke"; }
  getDisplayText(): string { return "Smoke"; }
}
const leaf = workspace.getLeaf(true);
workspace.setActiveLeaf(leaf);
view = new SmokeView(leaf);
workspace.registerView("smoke", (target) => new SmokeView(target));
await leaf.open(view);
editor = view.editor;
workspace.activeEditor = editor;
const manifest: PluginManifest = { id: "sample", name: "Sample", author: "test", version: "1", minAppVersion: "1", description: "test" };
class SmokePlugin extends Plugin { getView(): SmokeView { return view; } }
const plugin = await app.plugins.loadPlugin(SmokePlugin, manifest);
plugin.registerCommand({ ...editorCommand, id: "sample:edit", name: "Sample: Edit" });
const commandId = "sample:edit";
assert.equal(app.commands.isAvailable(commandId, app.getCommandContext()), true);
assert.equal(app.commands.isAvailable(commandId), false, "editor command is hidden without an active editor");
assert.equal(app.executeCommandById(commandId), true);
assert.equal(editorCalls, 1);
assert.equal(callbackCalls, 0, "editorCheckCallback overrides callback");
let prevented = false;
const event = {
  key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
  preventDefault: () => { prevented = true; },
} as unknown as KeyboardEvent;
assert.equal(app.keymap.handleKey(event), true);
assert.equal(prevented, true);
assert.equal(editorCalls, 2, "hotkey dispatch receives the active editor and view");
const otherLeaf = workspace.getLeaf(true);
const otherView = new SmokeView(otherLeaf);
await otherLeaf.open(otherView);
workspace.setActiveLeaf(otherLeaf);
assert.equal(app.getCommandContext().editor, otherView.editor, "active leaf switches editor command context");
assert.equal(app.getCommandContext().view, otherView);
const embeddedEditor = new Editor("embedded");
const embeddedInfo = { app, editor: embeddedEditor };
workspace.activeEditor = embeddedInfo;
assert.equal(app.getCommandContext().editor, embeddedEditor, "embedded editor takes command focus");
assert.equal(app.getCommandContext().view, embeddedInfo);
let changedInfo: unknown;
const changeRef = workspace.on("editor-change", (_editor, info) => { changedInfo = info; });
embeddedEditor.setValue("embedded change");
assert.equal(changedInfo, embeddedInfo, "embedded editor events identify their owner");
workspace.setActiveLeaf(otherLeaf);
assert.equal(app.getCommandContext().editor, otherView.editor, "activating the current leaf clears embedded focus");
workspace.activeEditor = embeddedInfo;
const replacementView = new SmokeView(otherLeaf);
await otherLeaf.open(replacementView);
assert.equal(app.getCommandContext().editor, replacementView.editor, "view replacement clears embedded focus");
workspace.offref(changeRef);
workspace.setActiveLeaf(leaf);
plugin.removeCommand("edit");
assert.equal(app.commands.commands.has(commandId), false);
assert.equal(app.keymap.handleKey(event), false, "removed command no longer consumes its hotkey");
await app.plugins.unloadAll();
workspace.iterateAllLeaves((item) => item.detach());
console.log("Command registry smoke passed");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
