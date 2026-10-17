// Compare file recovery behavior in the two running offscreen fixture vaults (see core-audit.mjs for how they are started).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const output = process.argv[2] ?? 'dist/todo-backup/recovery-comparison';
await fs.mkdir(output, { recursive: true });
const clients = [['reference', await fixtureClient(9351, 'obsen-reference-audit-')], ['obsen', await fixtureClient(9341, 'obsen-electron-smoke-')]];
const FILE = 'Recovery audit.md';
// Snapshot records of one file, oldest first, read straight from the plugin's IndexedDB store.
const snapshots = `(async () => {
  const name = (await indexedDB.databases()).map(d => d.name).find(n => n.endsWith('-backup'));
  if (!name) return null;
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    const all = await new Promise((resolve, reject) => { const r = db.transaction('backups').objectStore('backups').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    return all.filter(x => x.path === ${JSON.stringify(FILE)}).sort((a, b) => a.ts - b.ts).map(x => ({ data: x.data, ageDays: Math.round((Date.now() - x.ts) / 864e5) }));
  } finally { db.close(); }
})()`;
const addOld = `(async () => {
  const name = (await indexedDB.databases()).map(d => d.name).find(n => n.endsWith('-backup'));
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try { await new Promise((resolve, reject) => { const tx = db.transaction('backups', 'readwrite'); tx.objectStore('backups').add({ path: ${JSON.stringify(FILE)}, ts: Date.now() - 30 * 864e5, data: 'thirty days old' }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
})()`;
const write = text => `(async () => { const f = app.vault.getFileByPath(${JSON.stringify(FILE)}); if (f) await app.vault.modify(f, ${JSON.stringify(text)}); else await app.vault.create(${JSON.stringify(FILE)}, ${JSON.stringify(text)}); })()`;
const setOptions = options => `(async () => {
  await app.vault.adapter.write('.obsidian/file-recovery.json', ${JSON.stringify(JSON.stringify(options))});
  const plugin = app.internalPlugins?.plugins['file-recovery'];
  if (plugin) { if (!plugin.enabled) await plugin.enable(false); Object.assign(plugin.instance.options, ${JSON.stringify(options)}); }
})()`;
// A compositor capture wakes the offscreen window; it only resolves when a frame is produced, so it must not block.
const warm = c => Promise.race([c.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined), delay(3000)]);
const report = {};
try {
  for (const [name, c] of clients) {
    console.log(`Preparing ${name} recovery fixture`);
    const result = report[name] = {};
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.key('Escape');
    // No interval, so every distinct save is a snapshot.
    await c.evaluate(setOptions({ intervalMinutes: 0, keepDays: 7 }));
    await c.evaluate(`(async () => { const f = app.vault.getFileByPath(${JSON.stringify(FILE)}); if (f) await app.vault.delete(f); })()`);
    if (name === 'obsen') { await c.send('Page.reload'); await c.wait(`!!window.__obsenSmokeApp?.commands.findCommand('file-recovery:open')`, 'recovery plugin after reload'); }
    await warm(c);
    const before = (await c.evaluate(snapshots))?.length ?? 0;
    for (const text of ['alpha\n', 'alpha\nbeta\n', 'alpha\nbeta\n', 'alpha\nbeta\ngamma\n']) { await c.evaluate(write(text)); await delay(700); }
    result.unthrottled = (await c.evaluate(snapshots)).slice(before).map(x => x.data);

    // With a five minute interval, saves right after a snapshot are not recorded.
    await c.evaluate(setOptions({ intervalMinutes: 5, keepDays: 7 }));
    if (name === 'obsen') { await c.send('Page.reload'); await c.wait(`!!window.__obsenSmokeApp?.commands.findCommand('file-recovery:open')`, 'recovery plugin after reload'); }
    const throttledFrom = (await c.evaluate(snapshots)).length;
    for (const text of ['one\n', 'two\n']) { await c.evaluate(write(text)); await delay(700); }
    result.throttled = (await c.evaluate(snapshots)).slice(throttledFrom).map(x => x.data);

    // The dialog: list, preview, changes, restore.
    await c.evaluate(`(async () => { await app.workspace.getLeaf().openFile(app.vault.getFileByPath(${JSON.stringify(FILE)})); app.commands.executeCommandById('file-recovery:open'); })()`);
    await c.wait(`document.querySelectorAll('.modal.mod-sync-history .modal-sidebar-list-item').length > 1`, 'snapshot list');
    result.listed = await c.evaluate(`document.querySelectorAll('.modal.mod-sync-history .modal-sidebar-list-item').length`);
    result.dialog = await c.capture(output, `${name}-dialog`, '.modal.mod-sync-history');
    // Oldest entry is last in the list.
    await c.evaluate(`[...document.querySelectorAll('.modal.mod-sync-history .modal-sidebar-list-item')].at(-1).click()`);
    await c.wait(`!!document.querySelector('.modal.mod-sync-history textarea, .modal.mod-sync-history .file-recovery-text')`, 'snapshot preview');
    result.previewText = await c.evaluate(`(document.querySelector('.modal.mod-sync-history textarea') ?? document.querySelector('.modal.mod-sync-history .file-recovery-text')).value`);
    await c.click('.modal.mod-sync-history .modal-setting-titlebar .checkbox-container');
    await c.wait(`!!document.querySelector('.modal.mod-sync-history .diff-view')?.offsetParent`, 'diff view');
    result.diff = await c.evaluate(`(() => { const view = document.querySelector('.modal.mod-sync-history .diff-view'); const outline = e => ({ tag: e.tagName.toLowerCase(), class: e.getAttribute('class') ?? '', ...(e.children.length ? { children: [...e.children].map(outline) } : { text: e.textContent }) }); return outline(view); })()`);
    await c.capture(output, `${name}-changes`, '.modal.mod-sync-history');
    const restore = await c.evaluate(`(() => { const buttons = [...document.querySelectorAll('.modal.mod-sync-history .modal-setting-titlebar button')]; buttons.at(-1).click(); return buttons.map(b => b.textContent); })()`);
    result.buttons = restore;
    await c.wait(`(async () => (await app.vault.adapter.read(${JSON.stringify(FILE)})) === ${JSON.stringify(result.previewText)})()`, 'restore wrote the snapshot');
    result.modalOpenAfterRestore = await c.evaluate(`!!document.querySelector('.modal.mod-sync-history')`);
    await c.key('Escape');

    // Retention: an entry older than the limit is dropped by the periodic clean-up (60 s after start).
    await c.evaluate(addOld);
    assert.ok((await c.evaluate(snapshots)).some(x => x.ageDays >= 29), 'old record inserted');
    await c.send('Page.reload');
    await c.wait(name === 'obsen' ? `!!window.__obsenSmokeApp?.commands.findCommand('file-recovery:open')` : `!!window.app?.workspace?.layoutReady`, 'reload for retention');
    await warm(c);
    const deadline = Date.now() + 100000; let old = true;
    while (old && Date.now() < deadline) { await delay(5000); old = (await c.evaluate(snapshots)).some(x => x.ageDays >= 29); }
    result.oldRemoved = !old;
    result.keptAfterCleanup = (await c.evaluate(snapshots)).length;
    result.errors = c.errors.slice();
    console.log(`${name}: ${JSON.stringify({ unthrottled: result.unthrottled, throttled: result.throttled, listed: result.listed, buttons: result.buttons, oldRemoved: result.oldRemoved, errors: result.errors.length })}`);
  }
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2));
  // Totals (`listed`, `keptAfterCleanup`) depend on how often each fixture has been through this script, so they are reported, not compared.
  for (const key of ['unthrottled', 'throttled', 'previewText', 'buttons', 'modalOpenAfterRestore', 'oldRemoved']) assert.deepEqual(report.obsen[key], report.reference[key], `same ${key}`);
  assert.deepEqual(report.obsen.diff, report.reference.diff, 'same diff markup');
  console.log('File recovery behaves the same in both fixtures.');
} finally { for (const [, c] of clients) c.socket.close(); }
