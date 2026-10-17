import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fixtureClient, delay } from './fixture-client.mjs';
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>URL audit</title><body>Live URL audit page</body>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port, report = {};
try {
for (const [name, port, prefix] of [['reference', 9352, 'obsen-reference-audit-'], ['obsen', 9342, 'obsen-electron-smoke-']]) {
  const c = await fixtureClient(port, prefix, { separateHistoricalErrors: true });
  const toggle = async (id, label, enabled) => {
    await c.evaluate(`(() => { app.vault.setConfig('settingsPopoutWindow', false); app.commands.executeCommandById('app:open-settings'); })()`);
    await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=${id}]')`, 'settings tab');
    await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=${id}]').click()`);
    const row = `[...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === ${JSON.stringify(label)})`;
    await c.wait(`!!${row}`, label);
    await c.evaluate(`(() => { const el = ${row}.querySelector('.checkbox-container'); if (el.classList.contains('is-enabled') !== ${enabled}) el.click(); })()`);
    await delay(300); await c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`);
  };
  try {
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await toggle('plugins', 'Web viewer', true); await toggle('webviewer', 'Open external links', true);
    await c.evaluate(`(async () => { const path = 'Native URL audit.md'; const file = app.vault.getFileByPath(path) ?? await app.vault.create(path, 'Native link test.'); const leaf = app.workspace.getLeaf('tab'); await leaf.openFile(file, { active: true }); window.__liveURLSource = leaf; const link = window.__liveURLLink = document.createElement('a'); link.target = '_blank'; link.rel = 'noopener nofollow'; link.style.cssText = 'position:fixed;left:500px;top:200px;z-index:10000'; link.textContent = 'Live link'; document.body.append(link); })()`);
    const click = async (url, modifiers) => {
      await c.evaluate(`window.__liveURLLink.href = ${JSON.stringify(url)}`);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 510, y: 210, button: 'left', clickCount: 1, modifiers });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 510, y: 210, button: 'left', clickCount: 1, modifiers });
    };
    await c.evaluate(`app.workspace.setActiveLeaf(window.__liveURLSource)`);
    assert.equal(await c.evaluate(`app.workspace.activeLeaf === window.__liveURLSource`), true, 'source active before native click');
    const background = base + '/background'; await click(background, 2);
    await c.wait(`app.workspace.getLeavesOfType('webviewer').some(leaf => leaf.getViewState().state?.url === ${JSON.stringify(background)})`, 'background viewer created');
    report[name] = { backgroundKeepsSource: await c.evaluate(`app.workspace.activeLeaf === window.__liveURLSource`) };
    await c.evaluate(`(() => { window.__liveURLBackground = app.workspace.getLeavesOfType('webviewer').find(leaf => leaf.getViewState().state?.url === ${JSON.stringify(background)}); app.workspace.setActiveLeaf(window.__liveURLBackground); })()`);
    await c.wait(`window.__liveURLBackground.view.webview?.getURL() === ${JSON.stringify(background)} && !window.__liveURLBackground.view.webview.isLoading()`, 'background page loaded on activation');
    assert.equal(await c.evaluate(`window.__liveURLBackground.view.webview.executeJavaScript('document.body.textContent')`), 'Live URL audit page');
    await c.evaluate(`app.workspace.setActiveLeaf(window.__liveURLSource)`);
    const popout = base + '/popout'; await click(popout, 8);
    await c.wait(`app.workspace.getLeavesOfType('webviewer').some(leaf => leaf.getViewState().state?.url === ${JSON.stringify(popout)})`, 'popout viewer created');
    await c.evaluate(`(() => { window.__liveURLPopout = app.workspace.getLeavesOfType('webviewer').find(leaf => leaf.getViewState().state?.url === ${JSON.stringify(popout)}); })()`);
    report[name].popoutWindow = await c.evaluate(`window.__liveURLPopout.getContainer().win !== app.workspace.rootSplit.win`);
    await c.wait(`window.__liveURLPopout.view.webview?.getURL() === ${JSON.stringify(popout)} && !window.__liveURLPopout.view.webview.isLoading()`, 'popout browser page loaded');
    assert.equal(await c.evaluate(`window.__liveURLPopout.view.webview.executeJavaScript('document.body.textContent')`), 'Live URL audit page');
    assert.deepEqual(c.errors, []);
  } finally {
    await c.evaluate(`(() => { window.__liveURLLink?.remove(); if (window.__liveURLPopout) { const win = window.__liveURLPopout.getContainer().win; if (win !== app.workspace.rootSplit.win && !win.closed) win.close(); } window.__liveURLBackground?.detach(); })()`).catch(() => undefined);
    c.socket.close();
  }
}
await fs.writeFile('dist/todo-backup/external-url-live-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(report.obsen, report.reference);
assert.equal(report.obsen.popoutWindow, true);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
