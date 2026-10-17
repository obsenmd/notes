const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { checkEditorFollowups, checkSettingsFollowups } = require("./editor-followups-smoke.cjs");
const { checkBasesAudit } = require("./bases-audit-smoke.cjs");
process.prependListener("uncaughtException", error => { console.error(error.stack); app.exit(1); });

// Create the main test windows hidden from the start; child windows are handled below.
const smokeElectron = Object.create(require("electron"));
const NativeBrowserWindow = BrowserWindow;
require('./dev/fixture-external-urls.cjs')(smokeElectron, require('electron'));
Object.defineProperty(smokeElectron, "BrowserWindow", {
  value: class BrowserWindow extends NativeBrowserWindow {
    constructor(options) { super({ ...options, ...(process.env.OBSEN_SMOKE_BASES_COMPARE === "1" || process.env.OBSEN_SMOKE_BASES_AUDIT === "1" ? { width: 1280, height: 900, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } } : {}), show: false, focusable: false }); }
  },
});
const Module = require("node:module");
const loadModule = Module._load;
Module._load = function (id, ...args) { return id === "electron" ? smokeElectron : loadModule.call(this, id, ...args); };

const root = process.env.OBSEN_SMOKE_ROOT;
const directory = process.env.OBSEN_SMOKE_DIRECTORY;
require("./dev/fixture-crash-diagnostics.cjs")(require("electron"), directory);
const vault = path.join(directory, "vault");
const profileName = process.env.OBSEN_SMOKE_PROFILE || "profile";
if (!/^[A-Za-z0-9_-]+$/.test(profileName)) throw new Error("OBSEN_SMOKE_PROFILE must be a single fixture-local profile directory name");
app.setPath("userData", path.join(directory, profileName));
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (process.env.OBSEN_SMOKE_BASES_COMPARE === "1") app.commandLine.appendSwitch("disable-lcd-text");
if (process.env.OBSEN_SMOKE_BASES_COMPARE === "1") app.commandLine.appendSwitch("remote-debugging-port", process.env.OBSEN_SMOKE_PORT || "9341");
process.argv = [process.argv[0], root, "--vault", vault];
const errors = [];
app.on("web-contents-created", (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on("dom-ready", () => {
    if (process.env.OBSEN_SMOKE_TRACE_ROOTS !== "1") return;
    void contents.executeJavaScript(`(() => { const original = console.error; console.error = (...args) => original(...args, new Error('Console error origin').stack); })()`);
  });
  const setWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler = handler => setWindowOpenHandler(details => {
    const result = handler(details);
    return result.action === "allow" ? { ...result, overrideBrowserWindowOptions: { ...result.overrideBrowserWindowOptions, show: false, focusable: false } } : result;
  });
  contents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  contents.on("preload-error", (_event, _filename, error) => errors.push(error.stack));
  contents.on("did-fail-load", (_event, code, description) => errors.push(`Load ${code}: ${description}`));
});
app.on("browser-window-created", (_event, window) => {
  window.hide();
  if (window.webContents.isOffscreen()) {
    window.webContents.on("paint", () => {});
    window.webContents.setFrameRate(60); window.webContents.startPainting();
  }
  // Production show/focus calls must not interrupt the user's desktop during a smoke run.
  window.show = () => {};
  window.showInactive = () => {};
  window.focus = () => {};
});
require(path.join(process.env.OBSEN_DIST ? path.resolve(process.env.OBSEN_DIST) : path.join(root, "dist"), "app.asar", "main.cjs"));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function capture(contents, filename) {
  // Chromium can wait indefinitely for a compositor frame from a never-shown window.
  // DOM/behavior assertions run hidden; screenshot capture is an explicit opt-in.
  if (process.env.OBSEN_SMOKE_CAPTURE !== "1") return;
  contents.debugger.attach("1.3");
  try {
    const { data } = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: false });
    await fs.writeFile(path.join(directory, filename), Buffer.from(data, "base64"));
  } finally { contents.debugger.detach(); }
}
async function waitFor(check, label) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}\n${errors.join("\n")}`);
}

async function run() {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length > 0, "vault window");
  const window = BrowserWindow.getAllWindows()[0];
  const evaluate = async code => {
    let timer;
    try {
      return await Promise.race([window.webContents.executeJavaScript(code), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Renderer evaluation timed out: ${code.slice(0, 220)}`)), 10000); })]);
    } finally { clearTimeout(timer); }
  };
  await waitFor(() => evaluate(`Boolean(window.app?.workspace.layoutReady)`).catch(() => false), "restricted workspace startup");
  // Trust only the throwaway fixture vault, then verify its community plugin loads on restart.
  await waitFor(() => evaluate(`Boolean(document.querySelector('.modal button.mod-cta'))`), "fixture vault trust prompt");
  await evaluate(`document.querySelector('.modal button.mod-cta').click()`);
  await waitFor(() => evaluate(`Boolean(window.__obsenSmokeApp?.workspace.layoutReady && document.querySelector('.workspace-tabs'))`).catch(() => false), "workspace startup");
  if (process.env.OBSEN_SMOKE_BASES_COMPARE === "1") {
    await evaluate(`(async () => { const a = window.app; await a.workspace.getLeaf().openFile(a.vault.getFileByPath('Audit.base')); })()`);
    console.log("Bases comparison fixture ready.");
    await new Promise(() => {});
  }
  if (process.env.OBSEN_SMOKE_BASES_AUDIT === "1") {
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Page.enable");
    // Offscreen screenshots activate Chromium's compositor without a native show/focus.
    // This also lets requestAnimationFrame drive scroll virtualization in the fixture.
    await window.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
    const inputText = async text => {
      await window.webContents.debugger.sendCommand("Input.insertText", { text });
    };
    await checkBasesAudit({ evaluate, waitFor, inputText, vault });
    assert.deepEqual(errors, [], "Bases audit has no renderer errors");
    return;
  }
  if (process.env.OBSEN_SMOKE_EDITOR_FOLLOWUPS === "1") {
    await evaluate(`(async () => { const a = window.app; await a.workspace.getLeaf().openFile(a.vault.getFileByPath('Welcome.md')); a.workspace.activeLeaf.view.setMode('source'); })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.cm-content')?.textContent.includes('Welcome'))`), "follow-up editor");
    await checkEditorFollowups({ evaluate, waitFor, capture: filename => capture(window.webContents, filename) });
    console.log("Electron follow-ups: editor checks passed, opening settings.");
    await evaluate(`document.querySelector('[aria-label^="Settings"]').click()`);
    await waitFor(() => BrowserWindow.getAllWindows().length === 2, "follow-up settings window");
    const settings = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
    await waitFor(() => settings.webContents.executeJavaScript(`Boolean(document.querySelector('.vertical-tabs-container'))`).catch(() => false), "follow-up settings content");
    await checkSettingsFollowups({ evaluate, settings, waitFor, vault, capture: filename => capture(settings.webContents, filename) });
    assert.deepEqual(errors, [], "editor follow-ups have no renderer errors");
    console.log("Electron editor follow-ups passed: extract/community menus and prompts, zero/later-line hover previews, switcher visibility/persistence, daily-note presets/custom validation, filtered/dynamic preview sources and plugin enablement.");
    return;
  }
  await evaluate(`(async () => { const a = window.app; await a.workspace.getLeaf().openFile(a.vault.getFileByPath('Inventory.base')); })()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.bases-table-container .bases-tbody .bases-tr'))`), "Bases table rows");
  assert.equal(await evaluate(`['bases:insert','bases:copy-table','bases:change-view','bases:add-view','bases:add-item'].every(id => window.app.commands.commands.has(id))`), true, "Bases commands registered");
  await evaluate(`window.app.workspace.activeLeaf.view.controller.selectView('Cards')`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.bases-cards-container'))`), "Bases cards layout");
  await evaluate(`window.app.workspace.activeLeaf.view.controller.selectView('List')`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.bases-list-container'))`), "Bases list layout");
  await evaluate(`(async () => { const v = window.app.workspace.activeLeaf.view; v.controller.query.views[0].setLimit(2); await v.save(); })()`);
  assert.ok((await fs.readFile(path.join(vault, "Inventory.base"), "utf8")).includes("limit: 2"), "Bases toolbar writes YAML");
  await evaluate(`window.app.workspace.activeLeaf.view.controller.openNewItem()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.bases-new-item-popover .cm-content'))`), "Bases new item editor popover");
  await evaluate(`(() => { const title = document.querySelector('.bases-new-item-popover .inline-title'); title.textContent = 'Created from Bases'; title.dispatchEvent(new Event('blur')); })()`);
  await waitFor(async () => fs.readFile(path.join(vault, "Created from Bases.md"), "utf8").then(() => true).catch(() => false), "new Bases item title rename");
  await evaluate(`document.querySelector('.bases-new-item-popover').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`);
  await waitFor(() => evaluate(`!document.querySelector('.bases-new-item-popover')`), "new item popover closes");
  await evaluate(`(async () => { const a = window.app; await a.workspace.activeLeaf.openFile(a.vault.getFileByPath('Bases.md')); a.workspace.activeLeaf.view.setMode('preview'); })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.markdown-preview-section .bases-header').length === 2`), "Bases file embed and fence");
  assert.equal(await evaluate(`Boolean(document.querySelector('.markdown-preview-section .bases-cards-container'))`), true, "embed subpath selects view");
  await evaluate(`document.querySelector('.block-language-base .bases-toolbar-result-count .text-icon-button').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.bases-results-page input[type=number]'))`), "inline Bases results menu");
  await evaluate(`(() => { const input = document.querySelector('.bases-results-page input[type=number]'); input.value = '2'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); })()`);
  await waitFor(async () => (await fs.readFile(path.join(vault, "Bases.md"), "utf8")).includes("limit: 2"), "inline Bases toolbar writes correct fence after frontmatter");
  await capture(window.webContents, "bases.png");
  console.log("Electron smoke: Bases passed, opening editor.");
  await evaluate(`window.__obsenSmokeApp.workspace.openLinkText('Welcome', '', false)`);
  await evaluate(`window.app.workspace.activeLeaf.view.setMode('source')`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.cm-content')?.textContent.includes('Welcome'))`), "CodeMirror note");
  assert.equal(await evaluate(`window.__obsenSmokeApp.workspace.activeLeaf.view.file.path`), "Welcome.md");
  console.log("Electron smoke: editor ready, checking follow-ups.");
  await checkEditorFollowups({ evaluate, waitFor, capture: filename => capture(window.webContents, filename) });
  console.log("Electron smoke: editor follow-ups passed, opening popout.");
  await evaluate(`(async () => { const w = window.__obsenSmokeApp.workspace; const original = w.activeLeaf; const pop = w.openPopoutLeaf({size:{width:650,height:500}}); await pop.openFile(window.__obsenSmokeApp.vault.getFileByPath('Target.md')); window.__obsenSmokePop = pop; w.setActiveLeaf(original); })()`);
  await waitFor(() => evaluate(`Boolean(window.__obsenSmokePop.getContainer().doc.querySelector('.cm-content')?.textContent.includes('Target'))`), "native popout editor");
  assert.equal(await evaluate(`window.__obsenSmokePop.workspace === window.__obsenSmokeApp.workspace && window.__obsenSmokePop.view.app.vault === window.__obsenSmokeApp.vault`), true, "popout shares vault and workspace lifecycle");
  await evaluate(`window.__obsenSmokePop.getContainer().win.close()`);
  await waitFor(() => BrowserWindow.getAllWindows().length === 1, "native popout close");
  await delay(200);
  await evaluate(`(() => { const e = window.__obsenSmokeApp.workspace.activeLeaf.view.editor; e.setCursor(e.offsetToPos(e.getValue().length)); e.focus(); })()`);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Input.insertText", { text: "Z" });
  window.webContents.debugger.detach();
  await waitFor(() => evaluate(`window.__obsenSmokeApp.workspace.activeLeaf.view.editor.getValue().endsWith('Z')`), "keyboard editing");
  await evaluate(`window.__obsenSmokeApp.workspace.activeLeaf.view.save()`);
  assert.ok((await fs.readFile(path.join(vault, "Welcome.md"), "utf8")).endsWith("Z"), "editor saves to disk");
  await evaluate(`document.querySelector('.view-actions [aria-label*="Click to read"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.markdown-preview-section h1')?.textContent.includes('Welcome'))`), "reading view");
  await evaluate(`(async () => { const a = window.__obsenSmokeApp; await a.workspace.activeLeaf.openFile(a.vault.getFileByPath('Tasks.md')); a.workspace.activeLeaf.view.setMode('preview'); })()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.markdown-preview-section .task-list-item-checkbox:not(:disabled)'))`), "interactive reading task");
  await evaluate(`document.querySelector('.markdown-preview-section .task-list-item-checkbox').click()`);
  await waitFor(async () => (await fs.readFile(path.join(vault, "Tasks.md"), "utf8")).includes("- [x] Persist this task"), "reading task persists with frontmatter offset");
  await evaluate(`(async () => { const a = window.__obsenSmokeApp; await a.workspace.activeLeaf.openFile(a.vault.getFileByPath('Welcome.md')); a.workspace.activeLeaf.view.setMode('preview'); })()`);
  await evaluate(`document.querySelector('.view-actions [aria-label*="Click to edit"]').click()`);
  await evaluate(`(async () => { const w = window.__obsenSmokeApp.workspace; await w.duplicateLeaf(w.activeLeaf, 'vertical'); await w.duplicateLeaf(w.activeLeaf, 'horizontal'); })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.workspace-split.mod-root .workspace-tabs').length === 3`), "nested split rendering");
  await evaluate(`(async () => { const w = window.__obsenSmokeApp.workspace; const leaf = w.activeLeaf, previous = leaf.view; try { await leaf.setViewState({ type: 'smoke-failure' }); } catch (e) { if (e.message !== 'Expected fixture failure') throw e; } if (leaf.view !== previous || !leaf.view.isLoaded() || !previous.editor.cm.dom.isConnected) throw new Error('Failed view replaced the active editor'); })()`);
  await evaluate(`window.__obsenSmokeApp.workspace.saveLayout()`);
  assert.equal(await evaluate(`(() => { const root = document.querySelector('.workspace-split.mod-root'); const width = [...root.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 0); return Math.abs(root.getBoundingClientRect().width - width) < 2; })()`), true, "workspace fills available width");
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.workspace-split.mod-root .view-header')).display`), "flex", "view actions are visible");
  assert.equal(await evaluate(`document.querySelector('.workspace-split.mod-root .view-actions .view-action:last-child svg').getBoundingClientRect().width >= 16`), true, "toolbar icons are not squeezed by button padding");
  await delay(300);
  await capture(window.webContents, "editor.png");
  await window.webContents.reload();
  await waitFor(() => evaluate(`Boolean(window.__obsenSmokeApp?.workspace.layoutReady && document.querySelectorAll('.workspace-split.mod-root .workspace-tabs').length === 3)`).catch(() => false), "persisted split restoration");
  assert.equal(await evaluate(`window.__obsenSmokeApp.workspace.activeLeaf.view.editor.getValue().endsWith('Z')`), true);
  await evaluate(`(async () => { const w = window.__obsenSmokeApp.workspace; await w.getLeaf('tab').setViewState({ type: 'graph', active: true }); })()`);
  await waitFor(() => evaluate(`document.querySelector('[data-type=graph] canvas')?.dataset.graphReady === 'true'`), "graph worker simulation");
  await delay(300);
  await capture(window.webContents, "graph.png");
  await evaluate(`document.querySelector('[aria-label^="Settings"]').click()`);
  await waitFor(() => BrowserWindow.getAllWindows().length === 2, "settings popup");
  const settings = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
  await waitFor(() => settings.webContents.executeJavaScript(`Boolean(document.querySelector('.vertical-tabs-container'))`).catch(() => false), "settings content");
  await settings.webContents.executeJavaScript(`document.querySelector('[data-setting-id="editor"]').click()`);
  await waitFor(() => settings.webContents.executeJavaScript(`Boolean(document.querySelector('[data-setting-id="editor"].is-active')) && document.querySelector('.vertical-tab-content')?.textContent.includes('Default editing mode')`), "settings navigation");
  await delay(200);
  await capture(settings.webContents, "settings.png");
  await checkSettingsFollowups({ evaluate, settings, waitFor, vault, capture: filename => capture(settings.webContents, filename) });
  await evaluate(`(async () => { const a = window.app; await a.workspace.activeLeaf.openFile(a.vault.getFileByPath('Bases.md')); a.workspace.activeLeaf.view.setMode('preview'); })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.markdown-preview-section .bases-header').length === 2`), "Bases embeds before disable");
  await settings.webContents.executeJavaScript(`document.querySelector('[data-setting-id="plugins"]').click()`);
  await waitFor(() => settings.webContents.executeJavaScript(`Boolean(document.querySelector('[data-setting-id="plugins"].is-active')) && [...document.querySelectorAll('.setting-item-name')].some(el => el.textContent === 'Bases')`), "core plugins settings");
  const toggleBases = `(() => { const row = [...document.querySelectorAll('.setting-item')].find(row => row.querySelector('.setting-item-name')?.textContent === 'Bases'); row.querySelector('.checkbox-container').click(); })()`;
  await settings.webContents.executeJavaScript(toggleBases);
  await waitFor(() => evaluate(`!window.app.commands.commands.has('bases:insert') && !document.querySelector('.markdown-preview-section .bases-header')`), "Bases commands and embeds removed when disabled");
  await settings.webContents.executeJavaScript(toggleBases);
  await waitFor(() => evaluate(`window.app.commands.commands.has('bases:insert') && document.querySelectorAll('.markdown-preview-section .bases-header').length === 2`), "Bases commands and embeds restored when enabled");
  settings.close();
  await waitFor(() => BrowserWindow.getAllWindows().length === 1, "settings close");
  assert.equal(await evaluate(`document.querySelector('[role=alert]')?.textContent ?? ''`), "", "workspace has no runtime errors");
  await evaluate(`require('electron').ipcRenderer.send('starter')`);
  await waitFor(() => BrowserWindow.getAllWindows().length === 2, "vault chooser");
  const starter = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
  await waitFor(() => starter.webContents.executeJavaScript(`Boolean(document.querySelector('.recent-vaults-list-item'))`).catch(() => false), "recent vault list");
  assert.deepEqual(errors, [], "renderer startup and interactions have no errors");
  console.log("Electron smoke passed: vault startup, plugin loading, Bases layouts/embeds/new-item/fence persistence, editing, disk save, reading view, nested splits, failed-view recovery, layout restore, graph simulation, settings, vault chooser.");
}
run().then(() => app.exit(0)).catch(async error => {
  console.error(error.stack);
  console.error(errors.join("\n"));
  for (const window of BrowserWindow.getAllWindows()) {
    if (process.env.OBSEN_SMOKE_CAPTURE === "1") await window.webContents.capturePage(undefined, { stayHidden: true }).then(image => fs.writeFile(path.join(directory, `failure-${window.id}.png`), image.toPNG())).catch(() => {});
    console.error(await window.webContents.executeJavaScript("document.body.innerText").catch(() => "Renderer unavailable"));
  }
  app.exit(1);
});
