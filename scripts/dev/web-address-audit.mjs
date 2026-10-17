import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fixtureClient, delay } from './fixture-client.mjs';
const output = process.argv[2] ?? 'dist/todo-backup/web-address-comparison';
await fs.mkdir(output, { recursive: true });
const history = [
  { url: 'https://alpha.example/a', title: 'Alpha recent', time: 3 },
  { url: 'https://repeat.example/aa', title: 'aaaa aa repeated', time: 2 },
  { url: 'https://alpha.example/a', title: 'Older duplicate', time: 1 },
];
const bookmarks = [{ type: 'group', title: 'Sites', items: [{ type: 'url', url: 'https://alpha.example/a', title: 'Alpha bookmark' }, { type: 'url', url: 'https://book.example/', title: 'Bookmark only' }] }];
const report = {};
for (const [name, port, prefix] of [['reference', 9352, 'obsen-reference-audit-'], ['obsen', 9342, 'obsen-electron-smoke-']]) {
  const c = await fixtureClient(port, prefix, { separateHistoricalErrors: true });
  const toggle = async (label, enabled) => {
    await c.evaluate(`(() => { app.vault.setConfig('settingsPopoutWindow', false); app.commands.executeCommandById('app:open-settings'); })()`);
    await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=plugins]')`, 'plugin settings');
    await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=plugins]').click()`);
    const row = `[...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === ${JSON.stringify(label)})`;
    await c.wait(`!!${row}`, label + ' setting');
    await c.evaluate(`(() => { const el = ${row}.querySelector('.checkbox-container'); if (el.classList.contains('is-enabled') !== ${enabled}) el.click(); })()`);
    await delay(350);
    await c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button').click()`);
  };
  try {
    await c.evaluate(`(async () => { await app.vault.adapter.write('.obsidian/bookmarks.json', ${JSON.stringify(JSON.stringify({ items: bookmarks }))}); app.saveLocalStorage('webviewer-history', ${JSON.stringify(history)}); })()`);
    await c.send('Page.reload'); await delay(400);
    await c.wait(`!!window.app?.workspace?.layoutReady`, 'reloaded fixture');
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await toggle('Bookmarks', true); await toggle('Web viewer', true);
    await c.evaluate(`(() => { app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); })()`);
    await c.evaluate(`app.commands.executeCommandById('webviewer:open')`);
    await c.wait(`!!document.querySelector('.workspace-leaf.mod-active .webviewer-address input')`, 'web address');
    await c.evaluate(`(() => {
      window.__webAddressView = app.workspace.activeLeaf.view;
      window.__webAddressNavigate = window.__webAddressView.navigate;
      window.__webAddressView.navigate = (url, navigate) => window.__webAddressNavigation = { url, navigate };
      const db = window.__webAddressView.plugin?.db;
      if (db) { window.__webAddressHistory = db.getHistoryItems; db.getHistoryItems = async () => ${JSON.stringify(history)}; }
    })()`);
    const data = report[name] = { historicalErrors: c.historicalErrors, cases: {} };
    const query = async value => {
      await c.evaluate(`(() => { const input = document.querySelector('.workspace-leaf.mod-active .webviewer-address input'); input.focus(); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await c.wait(`!!document.querySelector('.suggestion-container .webviewer-addressbar-suggestion')`, 'address suggestions');
      await delay(180);
      return c.evaluate(`[...document.querySelectorAll('.suggestion-container .webviewer-addressbar-suggestion')].map(el => ({ title: el.querySelector('.suggestion-title')?.textContent, url: el.querySelector('.suggestion-url')?.textContent ?? null, bookmark: !!el.querySelector('.suggestion-aux .suggestion-flair'), highlights: [...el.querySelectorAll('.suggestion-highlight')].map(el => el.textContent), selected: el.classList.contains('is-selected') }))`);
    };
    for (const [label, value] of [['empty', ''], ['alpha', 'Alpha'], ['exact', 'https://alpha.example/a'], ['typed', 'other.example'], ['search', 'missing search'], ['repeat', 'aa'], ['spaces', ' other.example ']]) {
      data.cases[label] = await query(value);
      await c.capture(output, name + '-' + label, '.suggestion-container');
    }
    await query('Alpha'); await c.key('ArrowUp');
    data.up = await c.evaluate(`[...document.querySelectorAll('.webviewer-addressbar-suggestion')].findIndex(el => el.classList.contains('is-selected'))`);
    await c.key('ArrowDown'); await c.key('ArrowDown');
    data.down = await c.evaluate(`[...document.querySelectorAll('.webviewer-addressbar-suggestion')].findIndex(el => el.classList.contains('is-selected'))`);
    await c.key('Enter');
    data.enter = await c.evaluate(`window.__webAddressNavigation`);
    await query('missing search'); await c.key('Escape');
    data.escape = await c.evaluate(`({ open: !!document.querySelector('.suggestion-container'), focused: document.activeElement.matches('.webviewer-address input') })`);
    await c.key('Escape');
    data.secondEscape = await c.evaluate(`({ focused: document.activeElement.matches('.webviewer-address input'), value: document.querySelector('.workspace-leaf.mod-active .webviewer-address input').value })`);
    await c.evaluate(`(() => { const input = document.querySelector('.workspace-leaf.mod-active .webviewer-address input'); window.__webAddressInputStyle = input.style.cssText; Object.assign(input.style, { position: 'fixed', top: (innerHeight - 50) + 'px', left: '12px', width: '600px' }); })()`);
    await query('');
    const position = `(() => { const root = document.querySelector('.suggestion-container').getBoundingClientRect(), anchor = document.querySelector('.workspace-leaf.mod-active .webviewer-address input').getBoundingClientRect(); return { above: root.bottom <= anchor.top, gap: Math.round((root.bottom <= anchor.top ? anchor.top-root.bottom : root.top-anchor.bottom)*100)/100, width: Math.round(root.width), left: Math.round(root.left) }; })()`;
    data.nearBottom = await c.evaluate(position);
    await c.capture(output, name + '-near-bottom', '.suggestion-container');
    await c.evaluate(`(() => { document.querySelector('.workspace-leaf.mod-active .webviewer-address input').style.top = '200px'; document.dispatchEvent(new Event('scroll')); })()`);
    await delay(100);
    data.afterScroll = await c.evaluate(position);
    const anchorLeft = await c.evaluate(`Math.round(document.querySelector('.workspace-leaf.mod-active .webviewer-address input').getBoundingClientRect().left)`);
    assert.deepEqual(data.nearBottom, { above: true, gap: 5, width: 600, left: anchorLeft });
    assert.deepEqual(data.afterScroll, { above: false, gap: 5, width: 600, left: anchorLeft });
    await c.evaluate(`document.querySelector('.workspace-leaf.mod-active .webviewer-address input').style.cssText = window.__webAddressInputStyle`);
    await toggle('Bookmarks', false);
    data.cases.disabledBookmarks = await query('bookmark');
    await toggle('Bookmarks', true);
    data.errors = c.errors;
    assert.deepEqual(c.errors, []);
  } finally {
    await c.evaluate(`(() => { const view = window.__webAddressView; if (view) { view.navigate = window.__webAddressNavigate; if (window.__webAddressHistory) view.plugin.db.getHistoryItems = window.__webAddressHistory; } const input = document.querySelector('.workspace-leaf.mod-active .webviewer-address input'); if (input) { if (typeof window.__webAddressInputStyle === 'string') input.style.cssText = window.__webAddressInputStyle; input.blur(); } })()`).catch(() => undefined);
    c.socket.close();
  }
}
const differences = [];
for (const key of ['cases', 'up', 'down', 'enter', 'escape', 'secondEscape', 'nearBottom', 'afterScroll']) if (JSON.stringify(report.reference[key]) !== JSON.stringify(report.obsen[key])) differences.push(key);
report.differences = differences;
await fs.writeFile(output + '/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ differences, errors: { reference: report.reference.errors, obsen: report.obsen.errors } }, null, 2));
assert.deepEqual(differences, []);
