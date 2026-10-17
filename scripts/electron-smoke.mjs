import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsen-electron-smoke-"));
const vault = path.join(directory, "vault");
const plugin = path.join(vault, ".obsidian", "plugins", "smoke-fixture");
await fs.mkdir(plugin, { recursive: true });
await fs.mkdir(path.join(directory, "profile"));
await fs.writeFile(path.join(vault, "Welcome.md"), "# Welcome\n\nA local note with [[Target]].\n");
await fs.writeFile(path.join(vault, "Target.md"), "# Target\n\nA linked note.\n");
await fs.writeFile(path.join(vault, "Hover.md"), "---\ntitle: Hover\n---\n\n" + Array.from({ length: 70 }, (_, index) => index === 60 ? "needle-later" : `Paragraph ${index}`).join("\n\n"));
await fs.writeFile(path.join(vault, "Tasks.md"), "---\ntitle: Tasks\n---\n- [ ] Persist this task\n");
await fs.writeFile(path.join(vault, "Inventory.base"), 'filters: file.ext == "md"\nviews:\n  - type: table\n    name: Table\n    order: [file.name]\n  - type: cards\n    name: Cards\n  - type: list\n    name: List\n');
if (process.argv.includes("--bases-audit") || process.argv.includes("--bases-compare")) {
  await fs.mkdir(path.join(vault, "Dataset"));
  await Promise.all(Array.from({ length: 1200 }, (_, index) => fs.writeFile(path.join(vault, "Dataset", `Row ${String(index).padStart(4, "0")}.md`), `---\nscore: ${index}\nstatus: ${index % 2 ? "done" : "todo"}\n---\nDataset row ${index}.\n`)));
  await fs.writeFile(path.join(vault, "Audit.base"), 'filters: file.inFolder("Dataset")\nviews:\n  - type: table\n    name: Table\n    order: [file.name, score, status]\n    sort:\n      - property: score\n        direction: DESC\n    summaries:\n      score: Sum\n  - type: cards\n    name: Cards\n    order: [file.name, score]\n  - type: list\n    name: List\n    order: [file.name, score]\n  - type: smoke-bases\n    name: Plugin\n    order: [file.name, score]\n');
}
await fs.writeFile(path.join(vault, "Bases.md"), '---\ntitle: Bases\n---\n# Bases\n\n![[Inventory.base#Cards]]\n\n```base\nfilters: file.ext == "md"\nviews:\n  - type: table\n    name: Inline\n```\n');
await fs.writeFile(path.join(vault, ".obsidian", "app.json"), JSON.stringify({ settingsInNewWindow: true }));
await fs.writeFile(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["smoke-fixture"]));
await fs.writeFile(path.join(plugin, "manifest.json"), JSON.stringify({ id: "smoke-fixture", name: "Smoke fixture", version: "1.0.0", minAppVersion: "0.0.0", author: "Test", description: "Temporary Electron smoke fixture", isDesktopOnly: true }));
await fs.writeFile(path.join(plugin, "main.js"), `
const { Plugin, ItemView, BasesView, BasesQueryResult, BasesEntryGroup, BasesViewConfig } = require("obsidian");
module.exports = class extends Plugin {
  onload() {
    window.__obsenSmokeApp = this.app;
    window.__obsenSmokePlugin = this;
    window.__obsenSmokeApi = require("obsidian");
    window.__obsenSmokeEditorField = require("@codemirror/state").StateField.define({ create: () => true, update: value => value });
    this.registerEditorExtension(window.__obsenSmokeEditorField);
    window.__obsenSmokeBasesRegistered = this.registerBasesView("smoke-bases", {
      name: "Fixture layout", icon: "lucide-test-tube",
      factory: (controller, containerEl) => new class extends BasesView {
        type = "smoke-bases";
        onload() { window.__obsenSmokeBasesLoads = (window.__obsenSmokeBasesLoads || 0) + 1; }
        onunload() { window.__obsenSmokeBasesUnloads = (window.__obsenSmokeBasesUnloads || 0) + 1; }
        onDataUpdated() {
          if (!(this.data instanceof BasesQueryResult) || !(this.config instanceof BasesViewConfig) || !this.data.groupedData.every(group => group instanceof BasesEntryGroup)) throw new Error("Bases API constructor identity mismatch");
          containerEl.replaceChildren(); const row = containerEl.createDiv({ cls: "smoke-bases-result" });
          row.textContent = String(this.data.data.length);
          window.__obsenSmokeBasesSummary = this.data.getSummaryValue(controller, this.data.data, "note.score", "Sum").toString();
        }
      }(controller),
      options: () => [
        { type: "text", key: "caption", displayName: "Fixture caption", default: "Default caption" },
        { type: "group", displayName: "Fixture advanced", items: [
          { type: "formula", key: "expression", displayName: "Fixture formula", default: "1 + 2" },
          { type: "file", key: "file", displayName: "Fixture file", filter: file => file.extension === "md" },
          { type: "folder", key: "folder", displayName: "Fixture folder" },
          { type: "multitext", key: "labels", displayName: "Fixture labels", default: ["one", "two"] },
          { type: "toggle", key: "enabled", displayName: "Fixture toggle", default: false },
          { type: "slider", key: "size", displayName: "Fixture size", default: 2, min: 1, max: 5, step: 1, instant: false },
        ] },
      ],
    });
    this.registerHoverLinkSource("smoke-fixture", { display: "Fixture preview", defaultMod: false });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, owner) => {
      window.__obsenSmokeEditorMenu = { file: owner.file?.path, selection: editor.getSelection(), sameEditor: editor === owner.editor };
      menu.addItem(item => item.setTitle("Fixture editor action").onClick(() => { window.__obsenSmokeEditorAction = true; }));
    }));
    this.registerView("smoke-failure", leaf => new class extends ItemView {
      getViewType() { return "smoke-failure"; }
      getDisplayText() { return "Failure"; }
      onOpen() { this.containerEl.replaceChildren(document.createElement("div")); throw new Error("Expected fixture failure"); }
    }(leaf));
  }
};
`);
const environment = { ...process.env, OBSEN_SMOKE_ROOT: root, OBSEN_SMOKE_DIRECTORY: directory };
if (process.argv.includes("--editor-followups")) environment.OBSEN_SMOKE_EDITOR_FOLLOWUPS = "1";
if (process.argv.includes("--bases-audit")) environment.OBSEN_SMOKE_BASES_AUDIT = "1";
if (process.argv.includes("--bases-compare")) environment.OBSEN_SMOKE_BASES_COMPARE = "1";
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(root, "scripts", "electron-smoke.cjs")], {
  cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
if (process.argv.includes("--bases-compare")) await fs.writeFile(path.join(root, "dist", "todo-backup", `obsen-comparison-fixture${process.env.OBSEN_SMOKE_PORT ? "-" + process.env.OBSEN_SMOKE_PORT : ""}.json`), JSON.stringify({ directory, pid: child.pid }));
let output = "";
child.stdout.on("data", bytes => { output += bytes; process.stdout.write(bytes); });
child.stderr.on("data", bytes => { output += bytes; process.stderr.write(bytes); });
const timeout = process.argv.includes("--bases-compare") ? null : setTimeout(() => child.kill(), 90000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, `Electron smoke failed. Artifacts: ${directory}\n${output}`);
  console.log(`Electron smoke artifacts: ${directory}`);
} finally { clearTimeout(timeout); }
