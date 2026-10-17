// Second prompts comparison: bookmark rows in the quick switcher, the extract-heading prompt,
// the merge confirmation dialog, and hover previews of a heading link, a block link and a link
// in the editor. Runs in the two offscreen fixture vaults (see README.md in this folder).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const output = process.argv[2] ?? 'dist/todo-backup/prompts-comparison-2';
const referencePort = Number(process.env.OBSEN_REFERENCE_PORT ?? 9351), ownPort = Number(process.env.OBSEN_SMOKE_PORT ?? 9341);
await fs.mkdir(output, { recursive: true });
const clients = [['reference', await fixtureClient(referencePort, 'obsen-reference-audit-')], ['obsen', await fixtureClient(ownPort, 'obsen-electron-smoke-')]];
const samples = {
  'Prompt audit 2/Delta note.md': '---\nstatus: draft\n---\n# Delta heading\n\nDelta opening paragraph.\n\n## Target section\n\nSection body with a marked line. ^marked\n\n## Later section\n\nLater text.\n',
  'Prompt audit 2/Epsilon note.md': '# Epsilon heading\n\nSee [[Delta note#Target section]] and [[Delta note#^marked]] and [[Delta note]].\n\n## Movable part\n\nText that moves with its heading.\n',
  'Prompt audit 2/Zeta note.md': 'Zeta body to be merged.\n',
};
const warm = c => Promise.race([c.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined), delay(3000)]);
const report = {};
const rows = `[...document.querySelectorAll('.prompt .suggestion-item')].map(e => ({ cls: e.className.replace(/\\bis-selected\\b/, '').trim(), title: (e.querySelector('.suggestion-title') ?? e).textContent, note: e.querySelector('.suggestion-note')?.textContent ?? null, aux: [...e.querySelectorAll('.suggestion-aux > *')].map(x => x.className + ':' + x.textContent), icons: [...e.querySelectorAll('svg')].map(s => s.getAttribute('class')) }))`;
const instructions = `[...document.querySelectorAll('.prompt .prompt-instruction')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`;
const openNote = (c, name, mode) => c.evaluate(`(async () => { await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Prompt audit 2/${name}.md')); const view = app.workspace.activeLeaf.view; if (view.getMode() !== '${mode}') await view.setState({ ...view.getState(), mode: '${mode}' }, { history: false }); })()`);
try {
  for (const entry of clients) {
    const name = entry[0], port = name === 'reference' ? referencePort : ownPort;
    let c = entry[1];
    console.log(`Preparing ${name} prompts fixture`);
    const result = report[name] = {};
    const capture = async (scenario, selector) => { result[scenario + ':rect'] = await c.capture(output, `${name}-${scenario}`, selector); };
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.key('Escape');
    await c.evaluate(`(async () => {
      if (!app.vault.getFolderByPath('Prompt audit 2')) await app.vault.createFolder('Prompt audit 2');
      for (const [p, text] of Object.entries(${JSON.stringify(samples)})) { const f = app.vault.getFileByPath(p); if (f) await app.vault.modify(f, text); else await app.vault.create(p, text); }
      const merged = app.vault.getFileByPath('Prompt audit 2/Movable part.md'); if (merged) await app.vault.delete(merged);
    })()`);
    // Bookmarks are seeded on disk and picked up by a reload, which works the same way in both apps.
    await c.evaluate(`app.vault.adapter.write('.obsidian/bookmarks.json', ${JSON.stringify(JSON.stringify({ items: [{ type: 'file', ctime: 1, path: 'Prompt audit 2/Delta note.md', title: 'Audit two delta' }, { type: 'search', ctime: 2, query: 'tag:#audit', title: 'Audit two search' }] }))})`);
    await delay(300);
    await c.send('Page.reload');
    // Chromium replaces the execution context during reload. Reconnect before waiting for the new app.
    c.socket.close();
    const reconnectDeadline = Date.now() + 30000;
    while (true) {
      try { c = await fixtureClient(port, name === 'reference' ? 'obsen-reference-audit-' : 'obsen-electron-smoke-', { waitForApp: true }); entry[1] = c; break; }
      catch (error) { if (Date.now() >= reconnectDeadline) throw error; await delay(200); }
    }
    await delay(1500);
    await c.wait(`!!window.app?.workspace?.layoutReady`, 'reloaded');
    await delay(1500);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.evaluate(`(() => { if (!app.workspace.rightSplit.collapsed) app.commands.executeCommandById('app:toggle-right-sidebar'); if (app.workspace.leftSplit.collapsed) app.commands.executeCommandById('app:toggle-left-sidebar'); })()`);
    await delay(1200);
    await openNote(c, 'Epsilon note', 'source');
    await delay(500);
    await warm(c);

    // A bookmarked file and a bookmarked search show up in the switcher as bookmark rows.
    await delay(400);
    await c.evaluate(`app.commands.executeCommandById('switcher:open')`);
    await c.wait(`!!document.querySelector('.prompt input')`, 'switcher open');
    await c.send('Input.insertText', { text: 'audit two' });
    await delay(500);
    result['switcher-bookmark'] = await c.evaluate(rows);
    await capture('switcher-bookmark', '.prompt');
    await c.key('Escape'); await delay(150);

    // Extract the heading under the cursor: prompt, then the result on disk.
    await c.evaluate(`(() => { const e = app.workspace.activeLeaf.view.editor; e.focus(); e.setCursor({ line: 4, ch: 3 }); app.commands.executeCommandById('note-composer:extract-heading'); })()`);
    let extractPrompt = true;
    try { await c.wait(`!!document.querySelector('.prompt input')`, 'extract heading prompt'); } catch { extractPrompt = false; }
    result.extractHeadingPrompt = extractPrompt;
    if (extractPrompt) {
      await delay(400);
      result['extract-heading:value'] = await c.evaluate(`document.querySelector('.prompt input').value`);
      result['extract-heading:placeholder'] = await c.evaluate(`document.querySelector('.prompt input').placeholder`);
      result['extract-heading:rows'] = (await c.evaluate(rows)).slice(0, 4);
      result['extract-heading:instructions'] = await c.evaluate(instructions);
      await capture('extract-heading', '.prompt');
      await c.key('Escape'); await delay(200);
    }
    result['extract-heading:files'] = await c.evaluate(`app.vault.getMarkdownFiles().filter(f => f.path.startsWith('Prompt audit 2/')).map(f => f.path).sort()`);
    result['extract-heading:source'] = await c.evaluate(`app.vault.read(app.vault.getFileByPath('Prompt audit 2/Epsilon note.md'))`);

    // Merge: choosing a file asks for confirmation.
    await openNote(c, 'Zeta note', 'source');
    await delay(400);
    await c.evaluate(`app.commands.executeCommandById('note-composer:merge-file')`);
    await c.wait(`!!document.querySelector('.prompt input')`, 'merge prompt');
    await c.send('Input.insertText', { text: 'delta note' }); await delay(450);
    await c.key('Enter');
    let confirm = true;
    try { await c.wait(`!!document.querySelector('.modal-container .modal')`, 'merge confirmation'); } catch { confirm = false; }
    result.mergeConfirmShown = confirm;
    if (confirm) {
      await delay(300);
      result['merge-confirm'] = await c.evaluate(`(() => { const m = document.querySelector('.modal-container .modal'); return { cls: m.className, title: m.querySelector('.modal-title')?.textContent ?? null, text: [...m.querySelectorAll('.modal-content > *')].map(e => e.tagName + ':' + e.textContent), buttons: [...m.querySelectorAll('button')].map(b => b.className + ':' + b.textContent), checkbox: [...m.querySelectorAll('.mod-checkbox, label')].map(e => e.className + ':' + e.textContent) }; })()`);
      await capture('merge-confirm', '.modal-container .modal');
      await c.key('Escape'); await delay(250);
    }
    result['merge:untouched'] = await c.evaluate(`!!app.vault.getFileByPath('Prompt audit 2/Zeta note.md')`);

    // Hover previews: heading link and block link in reading view.
    const hover = async (scenario, find, modifiers = 0) => {
      const point = await c.evaluate(`(() => { const a = ${find}; if (!a) return null; a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!point) { result[scenario + ':shown'] = 'no link'; return; }
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - 60, y: point.y + 80, modifiers });
      await delay(100);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - 2, y: point.y, modifiers });
      await delay(60);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, modifiers });
      let shown = true;
      try { await c.wait(`!!document.querySelector('.popover.hover-popover .markdown-preview-view')`, scenario); } catch { shown = false; }
      result[scenario + ':shown'] = shown;
      if (shown) {
        await delay(600);
        result[scenario + ':text'] = await c.evaluate(`document.querySelector('.popover.hover-popover').innerText.replace(/\\s+/g, ' ').trim()`);
        result[scenario + ':structure'] = await c.evaluate(`(() => { const p = document.querySelector('.popover.hover-popover'); return { cls: p.className, embed: p.querySelector('.markdown-embed')?.className ?? null, title: p.querySelector('.markdown-embed-title')?.textContent ?? null, properties: !!p.querySelector('.metadata-container') && getComputedStyle(p.querySelector('.metadata-container')).display }; })()`);
        await capture(scenario, '.popover.hover-popover');
      }
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
      await delay(800);
    };
    await openNote(c, 'Epsilon note', 'preview');
    await c.wait(`!![...document.querySelectorAll('.markdown-reading-view a.internal-link')].find(a => a.offsetParent)`, 'reading view links');
    const readingLink = href => `[...document.querySelectorAll('.markdown-reading-view a.internal-link')].find(a => a.offsetParent && a.getAttribute('data-href') === ${JSON.stringify(href)})`;
    await hover('hover-heading', readingLink('Delta note#Target section'));
    await hover('hover-block', readingLink('Delta note#^marked'));
    await hover('hover-properties', readingLink('Delta note'));
    // Hover from the editor needs the modifier key.
    await openNote(c, 'Epsilon note', 'source');
    await delay(500);
    await c.evaluate(`(() => { const e = app.workspace.activeLeaf.view.editor; e.setCursor({ line: 0, ch: 0 }); })()`);
    await delay(300);
    const editorLink = `[...document.querySelectorAll('.workspace-leaf.mod-active .cm-content .cm-hmd-internal-link, .workspace-leaf.mod-active .cm-content .cm-underline')].find(a => a.offsetParent && a.textContent.includes('Delta note'))`;
    await hover('hover-editor-plain', editorLink);
    await hover('hover-editor-mod', editorLink, 2);
    result.errors = c.errors.slice();
    console.log(`${name}: ${JSON.stringify({ bookmarkRows: result['switcher-bookmark'].length, extractPrompt, confirm, hovers: Object.fromEntries(Object.entries(result).filter(([k]) => k.endsWith(':shown'))), errors: result.errors.length })}`);
  }
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2));
  const differences = [];
  for (const key of Object.keys(report.reference)) {
    if (key.endsWith(':rect') || key === 'errors') continue;
    try { assert.deepEqual(report.obsen[key], report.reference[key]); } catch { differences.push(key); }
  }
  for (const key of Object.keys(report.reference).filter(k => k.endsWith(':rect'))) {
    const a = report.reference[key], b = report.obsen[key];
    if (!b || a.width !== b.width || a.height !== b.height || a.x !== b.x || a.y !== b.y) differences.push(key);
  }
  await fs.writeFile(path.join(output, 'differences.json'), JSON.stringify(Object.fromEntries(differences.map(key => [key, { reference: report.reference[key], obsen: report.obsen[key] }])), null, 2));
  console.log(differences.length ? `Differences: ${differences.join(', ')}` : 'No behavioral or geometry differences.');
  console.log(`Renderer errors: reference ${report.reference.errors.length}, obsen ${report.obsen.errors.length}`);
  if (differences.length || report.reference.errors.length || report.obsen.errors.length) process.exitCode = 1;
} finally { for (const [, c] of clients) c.socket.close(); }
