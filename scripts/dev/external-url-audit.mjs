import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';
const report = {};
for (const [name, port, prefix] of [['reference', 9352, 'obsen-reference-audit-'], ['obsen', 9342, 'obsen-electron-smoke-']]) {
  const c = await fixtureClient(port, prefix, { separateHistoricalErrors: true });
  const openSettings = async id => {
    await c.evaluate(`(() => { app.vault.setConfig('settingsPopoutWindow', false); app.commands.executeCommandById('app:open-settings'); })()`);
    await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=${id}]')`, 'settings tab');
    await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=${id}]').click()`);
  };
  const toggleRow = async (label, enabled) => {
    const row = `[...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === ${JSON.stringify(label)})`;
    await c.wait(`!!${row}`, label);
    await c.evaluate(`(() => { const el = ${row}.querySelector('.checkbox-container'); if (el.classList.contains('is-enabled') !== ${enabled}) el.click(); })()`);
    await delay(300);
  };
  const closeSettings = () => c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`);
  try {
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await openSettings('plugins'); await toggleRow('Web viewer', true); await closeSettings();
    await openSettings('webviewer'); await toggleRow('Open external links', true); await closeSettings();
    await c.evaluate(`(() => {
      window.__urlAuditGetLeaf = app.workspace.getLeaf;
      app.workspace.getLeaf = target => ({ setViewState: state => { window.__urlAuditDestination = { target, state }; return Promise.resolve(); } });
      window.__urlAuditListener = event => { window.__urlAuditEvent = { ...event.detail, prevented: event.defaultPrevented }; };
      window.addEventListener('open-url', window.__urlAuditListener);
      const link = window.__urlAuditLink = document.createElement('a'); link.id = 'url-audit-link'; link.textContent = 'External URL audit'; link.rel = 'noopener nofollow'; link.style.cssText = 'position:fixed;left:500px;top:200px;z-index:10000'; document.body.append(link);
    })()`);
    const cases = report[name] = {};
    const run = async (label, target, modifiers = 0, script = false) => {
      const url = 'https://example.invalid/' + label;
      await c.evaluate(`(async () => { window.__urlAuditDestination = null; window.__urlAuditEvent = null; await require('electron').ipcRenderer.invoke('fixture:external-urls', true); await require('electron').ipcRenderer.invoke('fixture:window-opens', true); window.__urlAuditLink.href = ${JSON.stringify(url)}; window.__urlAuditLink.target = ${JSON.stringify(target)}; })()`);
      if (script) await c.evaluate(`window.open(${JSON.stringify(url)}, ${JSON.stringify(target)}) === null`);
      else {
        const point = await c.evaluate(`(() => { const r = window.__urlAuditLink.getBoundingClientRect(); return { x: r.x+10, y: r.y+10 }; })()`);
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1, modifiers });
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1, modifiers });
      }
      await c.wait(`window.__urlAuditDestination || require('electron').ipcRenderer.invoke('fixture:external-urls').then(urls => urls.length > 0)`, 'native URL routed');
      cases[label] = await c.evaluate(`(async () => ({ destination: window.__urlAuditDestination, event: window.__urlAuditEvent, external: await require('electron').ipcRenderer.invoke('fixture:external-urls'), native: (await require('electron').ipcRenderer.invoke('fixture:window-opens')).filter(item => item.url === ${JSON.stringify(url)}) }))()`);
    };
    await run('plain', '_blank'); await run('control', '_blank', 2); await run('shift', '_blank', 8);
    await run('split', 'split'); await run('self', '_self'); await run('script', '_blank', 0, true);
    await run('explicit-external', '_external', 0, true);
    await c.evaluate(`(() => { window.__urlAuditModal = document.createElement('div'); window.__urlAuditModal.className = 'modal-container'; document.body.append(window.__urlAuditModal); })()`);
    await run('modal', '_blank'); await c.evaluate(`window.__urlAuditModal.remove()`);
    await c.evaluate(`(async () => {
      const intercepted = app.workspace.getLeaf; app.workspace.getLeaf = window.__urlAuditGetLeaf;
      try { window.__urlAuditPopoutLeaf = await app.workspace.openPopoutLeaf(); window.__urlAuditPopout = window.__urlAuditPopoutLeaf.getContainer().win; }
      finally { app.workspace.getLeaf = intercepted; }
      window.__urlAuditPopout.addEventListener('open-url', window.__urlAuditListener);
    })()`);
    await c.evaluate(`(async () => { window.__urlAuditDestination = null; window.__urlAuditEvent = null; await require('electron').ipcRenderer.invoke('fixture:external-urls', true); window.__urlAuditPopout.open('https://example.invalid/popout', '_blank'); })()`);
    await c.wait(`window.__urlAuditDestination || require('electron').ipcRenderer.invoke('fixture:external-urls').then(urls => urls.length > 0)`, 'popout URL routed');
    cases.popout = await c.evaluate(`(async () => ({ destination: window.__urlAuditDestination, external: await require('electron').ipcRenderer.invoke('fixture:external-urls') }))()`);
    await c.evaluate(`(() => { const guest = window.__urlAuditPopoutGuest = window.__urlAuditPopout.document.createElement('webview'); guest.setAttribute('allowpopups', 'true'); guest.setAttribute('partition', app.getWebviewPartition()); guest.style.cssText = 'position:fixed;width:10px;height:10px;opacity:0'; window.__urlAuditPopoutGuestReady = false; guest.addEventListener('dom-ready', () => window.__urlAuditPopoutGuestReady = true); guest.src = 'data:text/html,<html><body>Guest</body></html>'; window.__urlAuditPopout.document.body.append(guest); })()`);
    await c.wait(`window.__urlAuditPopoutGuestReady`, 'popout guest ready');
    await c.evaluate(`(async () => { window.__urlAuditDestination = null; await require('electron').ipcRenderer.invoke('fixture:external-urls', true); await window.__urlAuditPopoutGuest.executeJavaScript("window.open('https://example.invalid/popout-guest', '_blank') === null", true); })()`);
    await c.wait(`window.__urlAuditDestination || require('electron').ipcRenderer.invoke('fixture:external-urls').then(urls => urls.length > 0)`, 'popout guest URL routed');
    cases.popoutGuest = await c.evaluate(`(async () => ({ destination: window.__urlAuditDestination, external: await require('electron').ipcRenderer.invoke('fixture:external-urls') }))()`);
    await c.evaluate(`window.__urlAuditPopout.close()`);
    await c.evaluate(`(() => { window.__urlAuditGuest = document.createElement('webview'); window.__urlAuditGuest.setAttribute('allowpopups', 'true'); window.__urlAuditGuest.setAttribute('partition', app.getWebviewPartition()); window.__urlAuditGuest.style.cssText = 'position:fixed;width:10px;height:10px;opacity:0;pointer-events:none'; window.__urlAuditGuestReady = false; window.__urlAuditGuest.addEventListener('dom-ready', () => window.__urlAuditGuestReady = true); window.__urlAuditGuest.src = 'data:text/html,<html><body>Guest</body></html>'; document.body.append(window.__urlAuditGuest); })()`);
    await c.wait(`window.__urlAuditGuestReady`, 'guest browser ready');
    await c.evaluate(`(async () => { window.__urlAuditDestination = null; window.__urlAuditEvent = null; await require('electron').ipcRenderer.invoke('fixture:external-urls', true); await window.__urlAuditGuest.executeJavaScript("window.open('https://example.invalid/guest', '_blank') === null", true); })()`);
    await c.wait(`window.__urlAuditDestination || require('electron').ipcRenderer.invoke('fixture:external-urls').then(urls => urls.length > 0)`, 'guest URL routed');
    cases.guest = await c.evaluate(`(async () => ({ destination: window.__urlAuditDestination, external: await require('electron').ipcRenderer.invoke('fixture:external-urls') }))()`);
    await c.evaluate(`window.__urlAuditGuest.remove()`);
    await openSettings('webviewer'); await toggleRow('Open external links', false); await closeSettings();
    await run('preference-disabled', '_blank');
    await openSettings('plugins'); await toggleRow('Web viewer', false); await closeSettings();
    await run('plugin-disabled', '_blank');
    assert.deepEqual(c.errors, []);
  } finally {
    await c.evaluate(`(() => { if (window.__urlAuditGetLeaf) app.workspace.getLeaf = window.__urlAuditGetLeaf; window.removeEventListener('open-url', window.__urlAuditListener); window.__urlAuditLink?.remove(); window.__urlAuditModal?.remove(); window.__urlAuditGuest?.remove(); if (window.__urlAuditPopout && !window.__urlAuditPopout.closed) window.__urlAuditPopout.close(); })()`).catch(() => undefined);
    c.socket.close();
  }
}
await fs.writeFile('dist/todo-backup/external-url-report.json', JSON.stringify(report, null, 2));
const differences = Object.keys(report.reference).filter(key => JSON.stringify(report.reference[key]) !== JSON.stringify(report.obsen[key]));
console.log(JSON.stringify({ cases: Object.keys(report.reference).length, differences }, null, 2));
assert.deepEqual(differences, []);
