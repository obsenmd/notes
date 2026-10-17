// Compare the quick switcher, command palette, note composer prompts, status bar and hover preview
// in the two running offscreen fixture vaults (see README.md in this folder for how they are started).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const output = process.argv[2] ?? 'dist/todo-backup/prompts-comparison';
const referencePort = Number(process.env.OBSEN_REFERENCE_PORT ?? 9351), ownPort = Number(process.env.OBSEN_SMOKE_PORT ?? 9341);
await fs.mkdir(output, { recursive: true });
const clients = [['reference', await fixtureClient(referencePort, 'obsen-reference-audit-')], ['obsen', await fixtureClient(ownPort, 'obsen-electron-smoke-')]];
const samples = {
  'Prompt audit/Alpha note.md': '---\naliases:\n  - First alias\n  - Zeta nickname\ntags:\n  - audit\n---\n# Alpha heading\n\nAlpha links to [[Beta note]] and to [[Missing audit target]].\n\n## Second heading\n\nSome more text here.\n',
  'Prompt audit/Beta note.md': '# Beta heading\n\nBeta body with **bold** text and a link back to [[Alpha note]].\n\n- one\n- two\n',
  'Prompt audit/Gamma note.md': 'Gamma mentions Alpha note in plain text.\n',
};
const warm = c => Promise.race([c.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined), delay(3000)]);
const report = {};
// Suggestion rows as text, so order and content can be compared without pixels.
const rows = `[...document.querySelectorAll('.prompt .suggestion-item')].map(e => ({ cls: e.className.replace(/\\bis-selected\\b/, '').trim(), title: (e.querySelector('.suggestion-title') ?? e).textContent, note: e.querySelector('.suggestion-note')?.textContent ?? null, aux: [...e.querySelectorAll('.suggestion-aux > *')].map(x => x.className + ':' + x.textContent) }))`;
const instructions = `[...document.querySelectorAll('.prompt .prompt-instruction')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`;
try {
  for (const [name, c] of clients) {
    console.log(`Preparing ${name} prompts fixture`);
    const result = report[name] = {};
    const capture = async (scenario, selector) => { result[scenario + ':rect'] = await c.capture(output, `${name}-${scenario}`, selector); };
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.key('Escape');
    // Reused fixtures can have accumulated split panes. Keep the active main
    // leaf so screenshot coordinates compare the same content width.
    result.rootPaneNormalization = await c.evaluate(`(()=>{const ws=app.workspace,keep=ws.activeLeaf,leaves=[];ws.iterateAllLeaves?.(leaf=>leaves.push(leaf));if(!leaves.length)leaves.push(...ws.getLeavesOfType('markdown'));const before=leaves.map(l=>({type:l.view?.getViewType?.(),active:l===keep,root:!!l.containerEl?.closest('.workspace-split.mod-root'),cls:l.containerEl?.className}));let removed=0;for(const leaf of leaves)if(leaf!==keep&&leaf.containerEl?.closest('.workspace-split.mod-root')){leaf.detach();removed++}return {removed,before,remaining:[...document.querySelectorAll('.workspace-split.mod-root .workspace-leaf')].length,dom:[...document.querySelectorAll('.workspace-split.mod-root .workspace-leaf')].map(e=>e.className)}})()`);
    await c.evaluate(`(async () => {
      if (!app.vault.getFolderByPath('Prompt audit')) await app.vault.createFolder('Prompt audit');
      for (const [p, text] of Object.entries(${JSON.stringify(samples)})) { const f = app.vault.getFileByPath(p); if (f) await app.vault.modify(f, text); else await app.vault.create(p, text); }
    })()`);
    // The same pane layout in both apps, so positions are comparable.
    await c.evaluate(`(() => { if (!app.workspace.rightSplit.collapsed) app.commands.executeCommandById('app:toggle-right-sidebar'); if (app.workspace.leftSplit.collapsed) app.commands.executeCommandById('app:toggle-left-sidebar'); })()`);
    await delay(1200);
    // The same recent-file order in both apps: Gamma, Beta, then Alpha (most recent).
    for (const file of ['Gamma note', 'Beta note', 'Alpha note']) { await c.evaluate(`app.workspace.getLeaf().openFile(app.vault.getFileByPath('Prompt audit/${file}.md'))`); await delay(350); }
    // The recreated workspace records a file as recent when it is left; native
    // records opens immediately. Seed the same resulting three paths directly
    // in both throwaway fixtures so earlier audit history cannot change captures.
    await c.evaluate(`(() => { const ws=app.workspace, recent=['Beta note','Gamma note','Alpha note'].map(file=>'Prompt audit/'+file+'.md'); if (!app.internalPlugins && Array.isArray(ws.recentFiles)) ws.recentFiles.splice(0,ws.recentFiles.length,...recent); else if (ws.recentFileTracker) ws.recentFileTracker.lastOpenFiles=[...recent]; })()`);
    await warm(c);

    // Quick switcher: recents, alias, unresolved link, nothing found.
    const switcher = async (query, scenario) => {
      await c.evaluate(`app.commands.executeCommandById('switcher:open')`);
      await c.wait(`!!document.querySelector('.prompt input')`, 'switcher open');
      if (query) await c.send('Input.insertText', { text: query });
      await delay(450);
      result[scenario] = await c.evaluate(rows);
      result[scenario + ':instructions'] = await c.evaluate(instructions);
      await capture(scenario, '.prompt');
      await c.key('Escape'); await delay(150);
    };
    await switcher('', 'switcher-recent');
    result['switcher-recent'] = result['switcher-recent'].slice(0, 3);
    await switcher('zeta nick', 'switcher-alias');
    await switcher('Zeta nickname', 'switcher-alias-exact');
    await switcher('missing audit', 'switcher-unresolved');
    await switcher('Missing audit target', 'switcher-unresolved-exact');
    await switcher('prompt audit beta', 'switcher-path');
    await switcher('qqqzzz no such thing', 'switcher-create');

    // Command palette.
    const palette = async (query, scenario) => {
      if (scenario === 'palette-bold' && name === 'obsen') result.commandAvailability = await c.evaluate(`(()=>{const command=app.commands.commands.get('editor:toggle-bold'),context=app.getCommandContext();return {name:command?.name,available:app.commands.isAvailable('editor:toggle-bold',context),hasEditor:!!context.editor,viewMode:context.view?.getMode?.()??null,activeView:app.workspace.activeMarkdownView?.getViewType?.()??null}})()`);
      await c.evaluate(`app.commands.executeCommandById('command-palette:open')`);
      await c.wait(`!!document.querySelector('.prompt input')`, 'palette open');
      await c.send('Input.insertText', { text: query });
      await delay(450);
      result[scenario] = (await c.evaluate(rows)).slice(0, 6);
      result[scenario + ':instructions'] = await c.evaluate(instructions);
      await capture(scenario, '.prompt');
      await c.key('Escape'); await delay(150);
    };
    await palette('toggle bold', 'palette-bold');
    await palette('split right', 'palette-split');

    // Note composer prompts.
    await c.evaluate(`(async () => { await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Prompt audit/Beta note.md')); const view = app.workspace.activeLeaf.view; if (view.getMode() !== 'source') await view.setState({ ...view.getState(), mode: 'source' }, { history: false }); })()`);
    await delay(400);
    await c.evaluate(`app.commands.executeCommandById('note-composer:merge-file')`);
    await c.wait(`!!document.querySelector('.prompt input')`, 'merge prompt');
    await c.send('Input.insertText', { text: 'alpha' }); await delay(400);
    result.merge = await c.evaluate(rows);
    result['merge:instructions'] = await c.evaluate(instructions);
    result['merge:placeholder'] = await c.evaluate(`document.querySelector('.prompt input').placeholder`);
    await capture('merge', '.prompt');
    await c.key('Escape'); await delay(150);
    await c.evaluate(`(() => { const e = app.workspace.activeLeaf.view.editor; e.focus(); e.setSelection({ line: 2, ch: 0 }, { line: 2, ch: 9 }); app.commands.executeCommandById('note-composer:split-file'); })()`);
    await c.wait(`!!document.querySelector('.prompt input')`, 'extract prompt');
    await c.send('Input.insertText', { text: 'gamma' }); await delay(400);
    result.extract = await c.evaluate(rows);
    result['extract:instructions'] = await c.evaluate(instructions);
    result['extract:placeholder'] = await c.evaluate(`document.querySelector('.prompt input').placeholder`);
    await capture('extract', '.prompt');
    await c.key('Escape'); await delay(150);

    // Status bar and its mode menu.
    result.status = await c.evaluate(`[...document.querySelectorAll('.status-bar .status-bar-item')].filter(e => e.offsetParent && !e.classList.contains('plugin-sync')).map(e => e.className + ' | ' + e.textContent.trim())`);
    await c.click('.status-bar .status-bar-item.plugin-editor-status');
    await c.wait(`!!document.querySelector('.menu')`, 'mode menu');
    result.modeMenu = await c.evaluate(`[...document.querySelectorAll('.menu .menu-item')].map(e => e.querySelector('.menu-item-title')?.textContent + (e.querySelector('.menu-item-icon.mod-checked, .mod-selected') || e.classList.contains('mod-selected') ? ' (checked)' : ''))`);
    await capture('mode-menu', '.menu');
    await c.key('Escape'); await delay(150);

    // Hover preview of a note link in reading view.
    await c.evaluate(`(async () => { await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Prompt audit/Alpha note.md')); const view = app.workspace.activeLeaf.view; await view.setState({ ...view.getState(), mode: 'preview' }, { history: false }); })()`);
    await c.wait(`!![...document.querySelectorAll('.markdown-reading-view a.internal-link')].find(a => a.offsetParent && a.textContent === 'Beta note')`, 'reading view link');
    const point = await c.evaluate(`(() => { const a = [...document.querySelectorAll('.markdown-reading-view a.internal-link')].find(a => a.offsetParent && a.textContent === 'Beta note'); const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    result.hoverTarget = await c.evaluate(`(() => { const a = [...document.querySelectorAll('.markdown-reading-view a.internal-link')].find(a => a.offsetParent && a.textContent === 'Beta note'); const r = a.getBoundingClientRect(), root=a.closest('.markdown-reading-view').getBoundingClientRect(); return { target: { x:r.x,y:r.y,width:r.width,height:r.height }, reading: {x:root.x,y:root.y,width:root.width,height:root.height} }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - 60, y: point.y + 80 });
    await delay(100);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - 2, y: point.y });
    await delay(60);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    let hover = true;
    try { await c.wait(`!!document.querySelector('.popover.hover-popover .markdown-preview-view')`, 'hover popover'); } catch { hover = false; }
    result.hoverShown = hover;
    if (hover) {
      await delay(500);
      result.hoverText = await c.evaluate(`document.querySelector('.popover.hover-popover').innerText.replace(/\\s+/g, ' ').trim()`);
      result.hoverRect = await c.evaluate(`(()=>{const r=document.querySelector('.popover.hover-popover').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
      await capture('hover', '.popover.hover-popover');
    }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await delay(700);
    await c.evaluate(`(async () => { const view = app.workspace.activeLeaf.view; await view.setState({ ...view.getState(), mode: 'source' }, { history: false }); })()`);
    result.errors = c.errors.slice();
    console.log(`${name}: ${JSON.stringify({ recents: result['switcher-recent'].map(r => r.title), alias: result['switcher-alias'].length, unresolved: result['switcher-unresolved'].length, create: result['switcher-create'].length, hover: result.hoverShown, errors: result.errors.length })}`);
  }
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2));
  const differences = [];
  for (const key of Object.keys(report.reference)) {
    if (key.endsWith(':rect') || key === 'errors' || key === 'rootPaneNormalization') continue;
    try { assert.deepEqual(report.obsen[key], report.reference[key]); } catch { differences.push(key); }
  }
  for (const key of Object.keys(report.reference).filter(k => k.endsWith(':rect'))) {
    const a = report.reference[key], b = report.obsen[key];
    if (!b || a.width !== b.width || a.height !== b.height || a.x !== b.x || a.y !== b.y) differences.push(key);
  }
  await fs.writeFile(path.join(output, 'differences.json'), JSON.stringify(Object.fromEntries(differences.map(key => [key, { reference: report.reference[key], obsen: report.obsen[key] }])), null, 2));
  console.log(differences.length ? `Differences: ${differences.join(', ')}` : 'No behavioral or geometry differences.');
  console.log(`Renderer errors: reference ${report.reference.errors.length}, obsen ${report.obsen.errors.length}`);
} finally { for (const [, c] of clients) c.socket.close(); }
