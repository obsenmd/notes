// Guarded paired local-graph and timelapse check. Uses only isolated fixtures
// on ports 9444/9454 and writes its report under dist/luna-canvas/.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const appPort = Number(process.env.GRAPH_OBSEN_PORT ?? 9444), referencePort = Number(process.env.GRAPH_REFERENCE_PORT ?? 9454);
if ([9229, 9342, 9347, 9352, 9357, 9447].includes(appPort) || [9229, 9342, 9347, 9352, 9357, 9457].includes(referencePort)) throw new Error('Refusing to use a fixture port owned by another task.');
const out = process.argv[2] ?? 'dist/luna-canvas/graph-local-timelapse';
await fs.mkdir(out, { recursive: true });
const clients = [
  ['reference', await fixtureClient(referencePort, 'obsen-reference-audit-', { waitForApp: true })],
  ['obsen', await fixtureClient(appPort, 'obsen-electron-smoke-', { waitForApp: true })],
];
const files = {
  'Graph audit/A.md': '# A\n\n[[B]] and [[D]].\n',
  'Graph audit/B.md': '# B\n\n[[C]].\n',
  'Graph audit/C.md': '# C\n',
  'Graph audit/D.md': '# D\n\n[[A]].\n',
  'Graph audit/Island.md': '# Island\n',
};
const steps = {}, errors = {};
const both = async fn => Object.fromEntries(await Promise.all(clients.map(async ([name, c]) => [name, await fn(c)])));
const same = async (key, fn, normalize = x => x) => {
  const values = await both(fn); steps[key] = values;
  assert.deepEqual(normalize(values.obsen), normalize(values.reference), `${key} differs`);
  return values;
};
const setup = async c => c.evaluate(`(async () => {
  const a = window.app ?? window.__obsenSmokeApp;
  const folder = a.vault.getFolderByPath('Graph audit'); if (!folder) await a.vault.createFolder('Graph audit');
  for (const [p, text] of Object.entries(${JSON.stringify(files)})) {
    const old = a.vault.getFileByPath(p); if (old) await a.vault.modify(old, text); else await a.vault.create(p, text);
  }
  for (const size of [12, 100, 400]) {
    const path = 'Graph size ' + size, folder = a.vault.getFolderByPath(path); if (!folder) await a.vault.createFolder(path);
    for (let i = 0; i < size; i++) {
      const p = path + '/Node ' + String(i).padStart(3, '0') + '.md';
      if (!a.vault.getFileByPath(p)) await a.vault.create(p, '# Node ' + i + '\\n');
    }
  }
  await new Promise(resolve => setTimeout(resolve, 900));
  const leaves = a.workspace.getLeavesOfType('graph').concat(a.workspace.getLeavesOfType('localgraph'));
  for (const leaf of leaves) leaf.detach();
  await new Promise(resolve => setTimeout(resolve, 250));
  return true;
})()`);
const openLocal = async (c, file = 'Graph audit/A.md') => {
  await c.evaluate(`(async () => {
    const a = window.app ?? window.__obsenSmokeApp, note = a.vault.getFileByPath(${JSON.stringify(file)});
    await a.workspace.getLeaf().openFile(note);
    await new Promise(resolve => setTimeout(resolve, 200));
    if (a.commands.findCommand?.('graph:open-local') || a.commands.commands?.['graph:open-local']) await a.commands.executeCommandById('graph:open-local');
    else await a.workspace.createLeafBySplit(a.workspace.activeLeaf, 'vertical').setViewState({ type: 'localgraph', active: true, group: a.workspace.activeLeaf, state: { file: ${JSON.stringify(file)} } });
  })()`);
  await c.wait(`!!(window.app ?? window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph').length && !!(window.app ?? window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph')[0].view.contentEl.querySelector('canvas')`, 'local graph open');
  await delay(1200);
};
const graphState = c => c.evaluate(`(() => {
  const leaf = (window.app ?? window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph')[0];
  const canvas = leaf?.view?.contentEl?.querySelector('canvas');
    const renderer = leaf?.view?.engine?.renderer ?? leaf?.view?.dataEngine?.renderer, rendererNodes = renderer?.nodes, lookup = renderer?.nodeLookup;
  const ids = lookup instanceof Map ? [...lookup.keys()] : lookup ? Object.keys(lookup) : Array.isArray(rendererNodes) ? rendererNodes.map(x => typeof x === 'string' ? x : x?.id).filter(Boolean) : [];
  const summary = document.querySelector('.publish-graph-accessible summary')?.textContent ?? '';
  const labels = [...(document.querySelector('.publish-graph-accessible ul')?.querySelectorAll('li') ?? [])].map(x => x.textContent?.trim()).sort();
  const summaryCount = Number(summary.match(/\((\d+)\)/)?.[1] ?? 0);
  return { view: leaf?.view?.getViewType(), file: leaf?.view?.getState?.()?.file ?? null,
    count: canvas?.dataset.graphNodes === undefined ? (summaryCount || rendererNodes?.length || ids.length || labels.length) : Number(canvas.dataset.graphNodes),
    ids: (ids.length ? ids : labels).map(id => String(id).split('/').at(-1).replace(/\.md$/i, '')).sort(), summary, labels };
})()`);
const localParity = value => ({ view: value.view, file: value.file, count: value.count, ids: value.ids });
const openFilters = async c => {
  if (await c.evaluate(`document.querySelector('.graph-controls')?.classList.contains('is-close')`)) await c.click('.graph-controls-button.mod-open');
  if (!await c.evaluate(`document.querySelector('.graph-control-section.mod-filter input[type=range]')`)) await c.click('.graph-control-section.mod-filter .tree-item-self');
  await c.wait(`!!document.querySelector('.graph-control-section.mod-filter input[type=range]')`, 'local graph filter controls');
};
const clickGraphControl = async (c, viewType, selector) => {
  const point = await c.evaluate(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType(${JSON.stringify(viewType)})[0], e=l?.view?.contentEl?.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r=e.getBoundingClientRect(); return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null; })()`);
  if (!point) throw new Error(`Visible ${selector} not found in ${viewType}`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};

try {
  await both(setup);
  await openLocal(clients[0][1]); await openLocal(clients[1][1]);
  await both(openFilters);
  await same('local graph default depth (outbound, inbound; excludes two-hop and island)', graphState, localParity);
  const depthTwo = async c => {
    const focused = await c.evaluate(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph')[0], input=l?.view?.contentEl?.querySelector('.graph-control-section.mod-filter .mod-local-jumps input[type=range]'); input?.focus(); return !!input; })()`);
    if (!focused) throw new Error('Local depth slider not found');
    await c.key('ArrowRight');
    await c.wait(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph')[0]; return l?.view?.contentEl?.querySelector('.graph-control-section.mod-filter .mod-local-jumps input[type=range]')?.value === '2'; })()`, 'local graph depth changed');
    await c.wait(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph')[0], c=l?.view?.contentEl?.querySelector('canvas'), n=l?.view?.engine?.renderer?.nodes; return Number(c?.dataset.graphNodes ?? l?.view?.contentEl?.querySelector('.publish-graph-accessible summary')?.textContent?.match(/\\((\\d+)\\)/)?.[1] ?? 0) >= 4 || n?.length >= 4; })()`, 'local graph depth-two nodes');
    return graphState(c);
  };
  await same('local graph depth two includes two-hop C', depthTwo, localParity);
  const noBacklinks = async c => {
    const rect = await c.evaluate(`(() => { const e=document.querySelector('.graph-control-section.mod-filter .mod-toggle .checkbox-container'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (!rect) throw new Error('Local backlinks toggle not found');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', buttons: 1, clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
    await delay(700); return graphState(c);
  };
  await same('local graph direction toggle', noBacklinks, localParity);

const globalState = c => c.evaluate(`(() => {
  const leaf=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0], canvas=leaf?.view?.contentEl?.querySelector('canvas');
  const engine=leaf?.view?.engine ?? leaf?.view?.dataEngine, nodes=engine?.renderer?.nodes; const summary=leaf?.view?.contentEl?.querySelector('.publish-graph-accessible summary')?.textContent ?? '';
  const summaryCount=Number(summary.match(/\\((\\d+)\\)/)?.[1] ?? 0), progression=engine?.progression ?? null;
  const total = summaryCount || (nodes?.length ?? (canvas?.dataset.graphNodes === undefined ? 0 : Number(canvas.dataset.graphNodes)));
  return { count: progression > 0 ? Math.min(total, progression) : total, total, ready: canvas?.dataset.graphReady === 'true', summary, progression };
})()`);
  const openGlobal = async c => {
    await c.evaluate(`(async () => { const a=window.app ?? window.__obsenSmokeApp; const leaf=a.workspace.getLeaf(); await leaf.setViewState({type:'graph',active:true,state:{}}); })()`);
    await c.wait(`!!(window.app ?? window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0]?.view?.contentEl?.querySelector('canvas')`, 'global graph open');
    await c.wait(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0], c=l?.view?.contentEl?.querySelector('canvas'), n=(l?.view?.engine ?? l?.view?.dataEngine)?.renderer?.nodes; return c?.dataset.graphReady==='true' || (Array.isArray(n) && n.length>0); })()`, 'global graph simulation ready');
    const closed = await c.evaluate(`(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0].view.contentEl.querySelector('.graph-controls')?.classList.contains('is-close')`);
    if (closed) await clickGraphControl(c, 'graph', '.graph-controls-button.mod-open');
    return globalState(c);
  };
  const filterGraph = async (c, size) => {
    const closed = await c.evaluate(`(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0]?.view?.contentEl?.querySelector('.graph-controls')?.classList.contains('is-close')`);
    if (closed) await clickGraphControl(c, 'graph', '.graph-controls-button.mod-open');
    const collapsed = await c.evaluate(`(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0]?.view?.contentEl?.querySelector('.graph-control-section.mod-filter')?.classList.contains('is-collapsed')`);
    if (collapsed) await clickGraphControl(c, 'graph', '.graph-control-section.mod-filter .tree-item-self');
    const selector = '.graph-control-section.mod-filter input[type="search"]';
    await c.wait(`!!document.querySelector(${JSON.stringify(selector)})`, 'global graph search field');
    const focused = await c.evaluate(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0], e=l?.view?.contentEl?.querySelector(${JSON.stringify(selector)}); e?.focus(); e?.select(); return !!e; })()`);
    if (!focused) throw new Error('Global graph search input not visible');
    await c.key('a', 'KeyA', { modifiers: 2 });
    await c.send('Input.insertText', { text: `path:"Graph size ${size}/"` });
    const deadline = Date.now() + 90000; let state = await globalState(c);
    while (state.count !== size && Date.now() < deadline) { await delay(250); state = await globalState(c); }
    if (state.count !== size) throw new Error(`Filtered graph ended at ${state.count}/${size} nodes on ${c.port}`);
    await delay(350);
    await clickGraphControl(c, 'graph', '.graph-controls-button.mod-close');
    return globalState(c);
  };
  const animate = async (c, size) => {
    await c.evaluate(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0], e=l?.view?.contentEl?.querySelector('canvas'); window.__graphAuditMarker={}; e.__graphAuditMarker=window.__graphAuditMarker; return true; })()`);
    const startedAt = Date.now();
    await clickGraphControl(c, 'graph', '.graph-controls-button.mod-animate');
    const samples = [];
    const sampleCount = Math.min(16, Math.max(1, Math.ceil(size / Math.max(5, Math.min(100, .5 * Math.sqrt(size))) * 4)));
    for (let i = 0; i < sampleCount; i++) { await delay(250); samples.push({ atMs: Date.now() - startedAt, ...await globalState(c), sameCanvas: await c.evaluate(`(() => { const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('graph')[0], e=l?.view?.contentEl?.querySelector('canvas'); return e?.__graphAuditMarker===window.__graphAuditMarker; })()`) }); }
    const deadline = Date.now() + 90000;
    let final = await globalState(c);
    while (final.count < size && Date.now() < deadline) { await delay(250); final = await globalState(c); }
    if (final.count !== size) throw new Error(`Timelapse ended at ${final.count}/${size} nodes on ${c.port}`);
    return { samples, final, elapsedMs: Date.now() - startedAt };
  };
  await both(c => c.evaluate(`(() => { for (const leaf of (window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph')) leaf.detach(); return true; })()`));
  const opened = await both(openGlobal); steps['global graph opened'] = opened;
  assert.ok(opened.obsen.total > 0 && opened.reference.total > 0, 'Both global graphs must load nodes before filtering');
  for (const size of [12, 100, 400]) {
    const baseline = await both(c => filterGraph(c, size));
    steps[`filtered graph size ${size}`] = baseline;
    assert.equal(baseline.obsen.count, size, `Obsen filtered graph should contain ${size} nodes`);
    assert.equal(baseline.reference.count, size, `Reference filtered graph should contain ${size} nodes`);
    const timeline = await both(c => animate(c, size)); steps[`timelapse size ${size}`] = timeline;
    for (const name of ['obsen', 'reference']) {
      const samples = timeline[name].samples, rate = size / (timeline[name].elapsedMs / 1000);
      const expected = Math.max(5, Math.min(100, .5 * Math.sqrt(size)));
      steps[`timelapse size ${size}`][name].observedNodesPerSecond = rate;
      steps[`timelapse size ${size}`][name].formulaNodesPerSecond = expected;
      const expectedElapsedMs = size / expected * 1000;
      // Node reveal can stop only on an integer count, and this audit samples
      // every 250 ms. Compare duration to the reference curve with those
      // explicit endpoint/polling bounds instead of a broad percentage band.
      const quantizationBoundMs = 1000 / expected + 250;
      steps[`timelapse size ${size}`][name].expectedElapsedMs = expectedElapsedMs;
      steps[`timelapse size ${size}`][name].quantizationBoundMs = quantizationBoundMs;
      assert.ok(samples.some((value, index) => index > 0 && value.count > samples[index - 1].count), `${name} size-${size} timelapse must add nodes incrementally`);
      assert.ok(Math.abs(timeline[name].elapsedMs - expectedElapsedMs) <= quantizationBoundMs, `${name} size-${size} elapsed ${timeline[name].elapsedMs}ms differs from reference ${expectedElapsedMs.toFixed(0)}ms by more than one-node + 250ms sampling bound (${quantizationBoundMs.toFixed(0)}ms)`);
      if (name === 'obsen') assert.ok(samples.every(x => x.sameCanvas), `Obsen size-${size} timelapse must preserve its canvas`);
      assert.equal(timeline[name].final.count, size, `${name} size-${size} timelapse must reach its full graph`);
    }
  }
  for (const [name, c] of clients) errors[name] = c.errors;
  assert.deepEqual(errors.obsen, [], 'Obsen fixture must have no renderer errors');
  await fs.writeFile(`${out}/report.json`, JSON.stringify({ steps, errors }, null, 2));
  console.log(`Local graph and timelapse checks passed. Report: ${out}/report.json`);
} catch (error) {
  for (const [name, c] of clients) errors[name] = c.errors;
  await fs.writeFile(`${out}/report.json`, JSON.stringify({ steps, errors, failure: String(error?.stack ?? error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally { for (const [, c] of clients) c.socket.close(); }
