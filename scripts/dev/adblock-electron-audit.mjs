import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';
const requests = [];
const server = http.createServer((request, response) => {
  const url = request.url.split('?')[0]; requests.push(url);
  response.setHeader('Cache-Control', 'no-store');
  if (url === '/rules.txt') { response.end('/ads.js\n/ads.png'); return; }
  if (url === '/ads.js') { response.end('window.adLoaded = true;'); return; }
  if (url === '/allowed.js') { response.end('window.allowedLoaded = true;'); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end('<html><body><script src="/ads.js"></script><script src="/allowed.js"></script><img src="/ads.png"></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const isReference = process.argv.includes('--reference');
const c = await fixtureClient(Number(isReference ? process.env.OBSEN_REFERENCE_PORT ?? 9352 : process.env.OBSEN_SMOKE_PORT ?? 9342), isReference ? 'obsen-reference-audit-' : 'obsen-electron-smoke-', { separateHistoricalErrors: true });
const original = await c.evaluate(`({ lists: require('electron').ipcRenderer.sendSync('adblock-lists'), frequency: require('electron').ipcRenderer.sendSync('adblock-frequency') })`);
const report = {};
const closeSettings = () => c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`);
const ready = async () => { if (isReference) await delay(300); else await c.evaluate(`require('electron').ipcRenderer.invoke('browser-session:ready', app.getWebviewPartition())`); };
try {
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.evaluate(`(() => { const ipc = require('electron').ipcRenderer; ipc.sendSync('adblock-lists', [${JSON.stringify(base + '/rules.txt')}]); ipc.sendSync('adblock-frequency', 0); app.vault.setConfig('settingsPopoutWindow', false); app.commands.executeCommandById('app:open-settings'); })()`);
  await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=plugins]')`, 'plugin settings');
  await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=plugins]').click()`);
  await c.evaluate(`(() => { const row = [...document.querySelectorAll('.setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === 'Web viewer'); const el = row.querySelector('.checkbox-container'); if (!el.classList.contains('is-enabled')) el.click(); })()`);
  await delay(400); await closeSettings();
  await ready();
  report.partition = await c.evaluate(`app.getWebviewPartition()`);
  assert.notEqual(report.partition, 'persist:vault-app.obsidian', 'vault has its own persistent browser session');
  if (!isReference) {
    const vaultPath = await c.evaluate(`typeof app.vault.adapter.getBasePath === 'function' ? app.vault.adapter.getBasePath() : app.vault.adapter.basePath`);
    const stored = JSON.parse(await fs.readFile(path.join(path.dirname(vaultPath), 'profile', 'webviewer-options.json'), 'utf8'));
    assert.deepEqual(stored, { adblock: [base + '/rules.txt'], adblockFrequency: 0 }, 'global settings persist independently of renderer storage');
    report.preferencesPersisted = true;
  }
  const secondaryPartition = report.partition + '-audit-secondary';
  await c.evaluate(`require('electron').ipcRenderer.send('create-browser-session', ${JSON.stringify(secondaryPartition)}, true)`);
  if (isReference) await delay(300); else await c.evaluate(`require('electron').ipcRenderer.invoke('browser-session:ready', ${JSON.stringify(secondaryPartition)})`);
  const load = async (label, partition = report.partition) => {
    const before = requests.length;
    await c.evaluate(`(() => { window.__adblockAuditView?.remove(); const view = window.__adblockAuditView = document.createElement('webview'); view.setAttribute('partition', ${JSON.stringify(partition)}); view.style.cssText = 'position:fixed;width:10px;height:10px;left:0;top:0;opacity:0;pointer-events:none'; window.__adblockAuditLoaded = false; view.addEventListener('did-finish-load', () => window.__adblockAuditLoaded = true); view.src = ${JSON.stringify(base + '/page?case=' + label)}; document.body.append(view); })()`);
    await c.wait(`window.__adblockAuditLoaded`, 'hidden page loaded');
    const flags = await c.evaluate(`window.__adblockAuditView.executeJavaScript('({ad: !!window.adLoaded, allowed: !!window.allowedLoaded})')`);
    report[label] = { flags, requests: requests.slice(before) };
    assert.equal(flags.allowed, true);
    return flags.ad;
  };
  assert.equal(await load('enabled'), false);
  assert.equal(report.enabled.requests.includes('/ads.js'), false, 'blocked request never reaches server');
  assert.equal(report.enabled.requests.includes('/ads.png'), false);
  const toggle = async enabled => {
    await c.evaluate(`app.commands.executeCommandById('app:open-settings')`);
    await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=webviewer]')`, 'Web viewer settings');
    await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=webviewer]').click()`);
    await c.wait(`!![...document.querySelectorAll('.setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === 'Enable ad blocker')`, 'adblock toggle');
    await c.evaluate(`(() => { const row = [...document.querySelectorAll('.setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === 'Enable ad blocker'); const el = row.querySelector('.checkbox-container'); if (el.classList.contains('is-enabled') !== ${enabled}) el.click(); })()`);
    await delay(400); await closeSettings();
    await ready();
  };
  await toggle(false); assert.equal(await load('disabled'), true);
  assert.equal(await load('secondaryStillEnabled', secondaryPartition), false, 'disabling one vault session does not disable another');
  await toggle(true); assert.equal(await load('reenabled'), false);
  assert.deepEqual(c.errors, []);
  await fs.writeFile('dist/todo-backup/adblock-electron-' + (isReference ? 'reference' : 'obsen') + '-report.json', JSON.stringify({ ...report, listRequests: requests.filter(url => url === '/rules.txt').length, errors: c.errors }, null, 2));
  console.log('Adblock Electron audit passed: real script/image cancellation, allowed resource loading and live settings toggle.');
} finally {
  await c.evaluate(`(() => { window.__adblockAuditView?.remove(); const ipc = require('electron').ipcRenderer; ipc.sendSync('adblock-lists', ${JSON.stringify(original.lists)}); ipc.sendSync('adblock-frequency', ${original.frequency}); })()`).catch(() => undefined);
  c.socket.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
