// Compare every settings tab of the two running offscreen fixtures (see README.md for how they are started).
// Usage: node scripts/dev/settings-audit.mjs [output dir] [--ref=9356] [--obsen=9346] [--only=tab,tab] [--no-capture] [--popout] [--persist]
// --persist flips every toggle and dropdown of every tab through the UI in both apps, compares the JSON files the two vaults end up with
// (persistence.json), and flips them back.
// For each tab (taken from the reference's own sidebar) it extracts an ordered row list from both apps, diffs them,
// captures the tab content, and writes row-diff.json / row-diff.md. Sub-pages behind navigable rows are audited too.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const args = process.argv.slice(2), flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const output = args.find(a => !a.startsWith('--')) ?? 'dist/todo-backup/settings-comparison';
const REF_PORT = Number(flag('ref') ?? process.env.OBSEN_REFERENCE_PORT ?? 9356), OBSEN_PORT = Number(flag('obsen') ?? process.env.OBSEN_SMOKE_PORT ?? 9346);
if ([9229, 9340, 9341, 9351].includes(REF_PORT) || [9229, 9340, 9341, 9351].includes(OBSEN_PORT)) throw new Error('Those ports belong to someone else.');
const only = flag('only')?.split(','), noCapture = args.includes('--no-capture'), withPopout = args.includes('--popout'), withPersist = args.includes('--persist');
const brand = await readBrand();
await fs.mkdir(output, { recursive: true });

async function readBrand() {
  const text = await fs.readFile('brand.txt', 'utf8').catch(() => '');
  return { original: /^original=(.*)$/m.exec(text)?.[1]?.trim() ?? 'Obsidian', name: /^translation=(.*)$/m.exec(text)?.[1]?.trim() ?? 'Obsidian' };
}
const CORE_IDS = ['file-explorer', 'global-search', 'switcher', 'graph', 'backlink', 'canvas', 'outgoing-link', 'tag-pane', 'footnotes', 'properties', 'page-preview', 'daily-notes', 'templates', 'note-composer', 'command-palette', 'slash-command', 'editor-status', 'bookmarks', 'zk-prefixer', 'random-note', 'outline', 'word-count', 'slides', 'audio-recorder', 'workspaces', 'file-recovery', 'publish', 'sync', 'bases', 'webviewer'];

// ---------------------------------------------------------------- in-page helpers (identical in both apps)
const PAGE = `(() => {
  const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) || getComputedStyle(e).display === 'contents';
  const text = e => (e ? (e.innerText ?? e.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  const icon = e => { const s = e.querySelector('svg'); return s ? [...s.classList].filter(c => c !== 'svg-icon').join(' ') : ''; };
  const mods = e => [...e.classList].filter(c => /^(mod-|is-)/.test(c) && c !== 'is-focused').sort().join(' ');
  const control = e => {
    if (e.matches('.checkbox-container')) return { type: 'toggle', value: e.classList.contains('is-enabled'), ...(e.classList.contains('is-disabled') ? { disabled: true } : {}) };
    if (e.matches('select.is-measuring')) return null;
    if (e.matches('select')) return { type: 'dropdown', fitted: !!e.nextElementSibling?.matches?.('select.is-measuring'), value: e.value, options: [...e.options].map(o => o.value + '=' + o.textContent.trim()), ...(e.disabled ? { disabled: true } : {}) };
    if (e.matches('input[type=range]')) return { type: 'slider', value: e.value, min: e.min, max: e.max, step: e.step };
    if (e.matches('input')) return { type: 'input:' + (e.getAttribute('type') ?? 'text'), value: e.value, ...(e.placeholder ? { placeholder: e.placeholder } : {}), ...(e.disabled ? { disabled: true } : {}) };
    if (e.matches('textarea')) return { type: 'textarea', value: e.value, ...(e.placeholder ? { placeholder: e.placeholder } : {}), ...(e.disabled ? { disabled: true } : {}) };
    if (e.matches('.combobox-button')) return { type: 'combobox', cls: mods(e), text: text(e.querySelector('.combobox-button-label')), placeholder: e.querySelector('.combobox-button-label')?.getAttribute('placeholder') ?? '' };
    if (e.matches('button')) return { type: 'button', text: text(e), ...(icon(e) ? { icon: icon(e) } : {}), ...(mods(e) ? { cls: mods(e) } : {}), ...(e.disabled ? { disabled: true } : {}), ...(e.getAttribute('aria-label') ? { label: e.getAttribute('aria-label') } : {}) };
    if (e.matches('.setting-item-chevron')) return { type: 'chevron' };
    if (e.matches('.clickable-icon, .extra-setting-button')) return { type: 'icon', icon: icon(e), label: e.getAttribute('aria-label') ?? '', ...(e.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}) };
    if (e.matches('.setting-item-value')) return { type: 'value', text: text(e) };
    if (e.matches('.setting-hotkey')) return { type: 'hotkey', text: text(e) };
    if (e.matches('a')) return { type: 'link', text: text(e), href: e.getAttribute('href') ?? '' };
    if (e.matches('svg')) return null;
    if (!e.children.length && text(e)) return { type: 'text', cls: e.className, text: text(e) };
    return undefined;
  };
  const controls = root => {
    const out = [];
    const walk = e => { for (const child of e.children) { if (!visible(child)) continue; const c = control(child); if (c === undefined) walk(child); else if (c) out.push(c); } };
    if (root) walk(root);
    return out;
  };
  const root = () => document.querySelector('.modal.mod-settings .vertical-tab-content');
  const extract = () => {
    const r = root(); if (!r) throw new Error('No settings content');
    const groups = [...r.querySelectorAll('.setting-group')];
    const rows = [];
    const walk = e => {
      for (const child of e.children) {
        if (!visible(child)) continue;
        if (child.matches('.setting-item')) {
          const group = child.closest('.setting-group');
          const desc = child.querySelector(':scope > .setting-item-info > .setting-item-description');
          rows.push({ kind: 'row', heading: child.classList.contains('setting-item-heading'), name: text(child.querySelector(':scope > .setting-item-info > .setting-item-name, :scope > .setting-item-name')),
            desc: text(desc), descLinks: desc ? [...desc.querySelectorAll('a')].map(a => text(a) + ' -> ' + (a.getAttribute('href') ?? '')) : [],
            cls: mods(child), icon: child.querySelector(':scope > .setting-item-icon') ? icon(child.querySelector(':scope > .setting-item-icon')) : null, group: group ? groups.indexOf(group) : -1, groupCls: group ? mods(group) : '', controls: controls(child.querySelector(':scope > .setting-item-control')) });
          continue;
        }
        const c = control(child);
        if (c === undefined) walk(child);
        else if (c) rows.push({ kind: 'other', name: (child.tagName.toLowerCase() + '.' + child.className.replace(/\\s+/g, '.')).replace(/\\.$/, ''), text: c.text ?? '', control: c });
      }
    };
    walk(r);
    return { title: text(document.querySelector('.modal.mod-settings .modal-title')), contentCls: r.className, pageTitle: text(r.querySelector('.setting-page-title')), rows };
  };
  const sidebar = () => [...document.querySelectorAll('.modal.mod-settings .vertical-tab-header-group')].map(g => {
    const title = g.querySelector('.vertical-tab-header-group-title');
    return { title: title && visible(title) ? text(title) : '', items: [...g.querySelectorAll('.vertical-tab-nav-item')].map(e => ({ id: e.dataset.settingId ?? '', name: text(e.querySelector('.vertical-tab-nav-item-title')), icon: icon(e.querySelector('.vertical-tab-nav-item-icon') ?? e) })) };
  });
  const search = async query => {
    const input = document.querySelector('.modal.mod-settings .setting-search-container input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, query); input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const box = document.querySelector('.modal.mod-settings .setting-search-results');
    const out = [];
    for (const child of box?.children ?? []) {
      if (!visible(child)) continue;
      if (child.matches('.setting-search-result-group')) out.push({ tab: text(child.querySelector('.setting-search-result-tab-label')), sublabel: text(child.querySelector('.setting-search-result-tab-sublabel')), icon: icon(child.querySelector('.vertical-tab-nav-item-icon') ?? child), items: [...child.querySelectorAll('.setting-search-result-item')].map(e => text(e.querySelector('.vertical-tab-nav-item-title'))), highlights: [...child.querySelectorAll('.suggestion-highlight')].map(text) });
      else out.push({ other: child.className, text: text(child) });
    }
    return out;
  };
  const clearSearch = async () => { await search(''); };
  window.__settingsAudit = { extract, sidebar, search, clearSearch, visible };
  return true;
})()`;

const openSettings = (name, c) => name === 'reference'
  ? c.evaluate(`(async () => { if (!document.querySelector('.modal.mod-settings')) app.setting.open(); return true; })()`)
  : c.evaluate(`(async () => { if (!document.querySelector('.modal.mod-settings')) (window.app ?? window.__obsenSmokeApp).commands.executeCommandById('app:open-settings'); return true; })()`);
const closeExtraModals = c => c.evaluate(`(() => { for (const m of document.querySelectorAll('.modal-container')) if (!m.querySelector('.mod-settings')) m.querySelector('.modal-close-button, .modal-bg')?.click(); for (const m of document.querySelectorAll('.menu')) m.remove(); return true; })()`);
const openTab = async (name, c, id) => {
  await closeExtraModals(c);
  if (name === 'reference') await c.evaluate(`(app.setting.openTabById(${JSON.stringify(id)}), true)`);
  else await c.evaluate(`(async () => { const tab = s => document.querySelector('.modal.mod-settings .vertical-tab-nav-item[data-setting-id="' + s + '"]'); const other = tab(${JSON.stringify(id)} === 'about' ? 'appearance' : 'about'); other?.click(); await new Promise(r => setTimeout(r, 60)); const e = tab(${JSON.stringify(id)}); if (!e) throw new Error('No tab ' + ${JSON.stringify(id)}); e.click(); return true; })()`);
  await delay(350);
  await c.evaluate(PAGE);
};
const normalize = (value, name) => name !== 'reference' || brand.original === brand.name ? value : JSON.parse(JSON.stringify(value).split(brand.original).join(brand.name));
const capture = async (c, file, selector) => {
  if (noCapture) return null;
  // An idle offscreen window produces no frame; nudge it and do not wait forever.
  const attempt = () => Promise.race([c.capture(output, file, selector), delay(6000).then(() => null)]);
  let rect = await attempt();
  if (!rect) { await c.evaluate(`(document.body.style.opacity = '0.999', requestAnimationFrame(() => { document.body.style.opacity = ''; }), true)`); rect = await attempt(); }
  return rect;
};

// ---------------------------------------------------------------- diff
const rowKey = row => row.kind === 'other' ? `other|${row.name}|${row.text}` : `${row.heading ? 'heading' : 'row'}|${row.name}`;
function diffRows(reference, obsen) {
  const a = reference.map(rowKey), b = obsen.map(rowKey), n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      const fields = {};
      for (const field of ['desc', 'descLinks', 'cls', 'icon', 'group', 'groupCls', 'controls', 'control']) if (JSON.stringify(reference[i][field]) !== JSON.stringify(obsen[j][field])) fields[field] = { reference: reference[i][field], obsen: obsen[j][field] };
      if (Object.keys(fields).length) out.push({ type: 'different', key: a[i], index: { reference: i, obsen: j }, fields });
      i++; j++;
    } else if (j >= m || (i < n && table[i + 1][j] >= table[i][j + 1])) { out.push({ type: 'missing-in-obsen', key: a[i], index: { reference: i }, row: reference[i] }); i++; }
    else { out.push({ type: 'extra-in-obsen', key: b[j], index: { obsen: j }, row: obsen[j] }); j++; }
  }
  // A row present in both but at another position shows up as one missing plus one extra: label it.
  for (const entry of out) if (entry.type === 'missing-in-obsen' && out.some(other => other.type === 'extra-in-obsen' && other.key === entry.key)) entry.moved = true;
  for (const entry of out) if (entry.type === 'extra-in-obsen' && out.some(other => other.type === 'missing-in-obsen' && other.key === entry.key)) entry.moved = true;
  return out;
}
/** Differences that are expected and why; everything else counts as unexplained. */
function explain(tab, entry) {
  const text = JSON.stringify(entry);
  if (tab === 'hotkeys' && entry.key === 'row|Configure mobile Quick Action') return 'mobile:quick-action is a mobile-only command, out of the desktop scope (HANDOFF.md)';
  if (tab === 'about' && entry.key === 'row|Version N' && Object.keys(entry.fields ?? {}).join() === 'desc' && entry.fields.desc.reference.replace('Installer version', 'API version') === entry.fields.desc.obsen) return 'brand.txt renames "Installer version" to "API version"';
  if (tab === 'about' && entry.key === 'row|Automatic updates' && Object.keys(entry.fields ?? {}).join() === 'controls') return 'the reference fixture starts with updates disabled (updateDisabled in its profile); the re-creation default is on, like a normal install';
  return null;
}

// ---------------------------------------------------------------- run
const clients = [['reference', await fixtureClient(REF_PORT, 'obsen-reference-audit-')], ['obsen', await fixtureClient(OBSEN_PORT, 'obsen-electron-smoke-')]];
const [reference, obsen] = clients.map(([, c]) => c);
const report = { generated: new Date().toISOString(), ports: { reference: REF_PORT, obsen: OBSEN_PORT }, sidebar: {}, tabs: {}, search: {}, errors: {} };
try {
  // Same enabled core plugins and the modal (not pop-out) settings form in both.
  await reference.evaluate(`(async () => { for (const id of ${JSON.stringify(CORE_IDS)}) { const p = app.internalPlugins.plugins[id]; if (p && !p.enabled) await p.enable(true); } if (app.vault.getConfig('settingsPopoutWindow') !== false) app.vault.setConfig('settingsPopoutWindow', false); return true; })()`);
  const needsReload = await obsen.evaluate(`(async () => {
    const a = window.app ?? window.__obsenSmokeApp, read = async f => { try { return JSON.parse(await a.vault.adapter.read(f)); } catch { return {}; } };
    const core = await read('.obsidian/core-plugins.json'), appJson = await read('.obsidian/app.json'); let changed = false;
    for (const id of ${JSON.stringify(CORE_IDS)}) if (core[id] !== true) { core[id] = true; changed = true; }
    if (changed) await a.vault.adapter.write('.obsidian/core-plugins.json', JSON.stringify(core, null, 2));
    if (appJson.settingsPopoutWindow !== false) { appJson.settingsPopoutWindow = false; delete appJson.settingsInNewWindow; await a.vault.adapter.write('.obsidian/app.json', JSON.stringify(appJson, null, 2)); changed = true; }
    return changed;
  })()`);
  // The same community plugin in both vaults (the re-creation fixture's own), enabled, so the plugin tabs can be compared.
  await installFixturePlugin();
  if (needsReload) { await obsen.send('Page.reload'); await obsen.wait(`!!(window.app ?? window.__obsenSmokeApp)?.commands.findCommand('app:open-settings')`, 're-creation after reload'); await delay(1500); }
  for (const [name, c] of clients) {
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await openSettings(name, c);
    await c.wait(`!!document.querySelector('.modal.mod-settings .vertical-tab-content')`, `${name} settings open`);
    await c.evaluate(PAGE);
    await c.evaluate(`window.__settingsAudit.clearSearch()`);
    report.sidebar[name] = normalize(await c.evaluate(`window.__settingsAudit.sidebar()`), name);
  }
  report.sidebar.equal = JSON.stringify(report.sidebar.reference) === JSON.stringify(report.sidebar.obsen);
  await capture(reference, 'reference-sidebar', '.modal.mod-settings .vertical-tab-header'); await capture(obsen, 'obsen-sidebar', '.modal.mod-settings .vertical-tab-header');

  const tabIds = report.sidebar.reference.flatMap(group => group.items.map(item => item.id)).filter(id => !only || only.includes(id));
  for (const id of tabIds) {
    const tab = report.tabs[id] = { pages: {} };
    const audit = async (label, file) => {
      const data = {};
      for (const [name, c] of clients) {
        await c.evaluate(PAGE);
        data[name] = normalize(await c.evaluate(`window.__settingsAudit.extract()`), name);
        // Product version numbers differ by design.
        if (id === 'about') data[name] = JSON.parse(JSON.stringify(data[name]).replace(/\d+\.\d+\.\d+(\.\d+)?/g, 'N'));
        await c.evaluate(`(document.querySelector('.modal.mod-settings .vertical-tab-content-container').scrollTop = 0, true)`);
        await capture(c, `${name}-${file}`, '.modal.mod-settings .vertical-tab-content-container');
      }
      const differences = diffRows(data.reference.rows, data.obsen.rows);
      if (data.reference.title !== data.obsen.title) differences.unshift({ type: 'different', key: 'modal title', fields: { title: { reference: data.reference.title, obsen: data.obsen.title } } });
      if (data.reference.pageTitle !== data.obsen.pageTitle) differences.unshift({ type: 'different', key: 'page title', fields: { pageTitle: { reference: data.reference.pageTitle, obsen: data.obsen.pageTitle } } });
      for (const entry of differences) { const why = explain(id, entry); if (why) entry.explained = why; }
      tab.pages[label] = { rows: { reference: data.reference.rows.length, obsen: data.obsen.rows.length }, differences, reference: data.reference, obsen: data.obsen };
      console.log(`${id}${label === 'main' ? '' : ' > ' + label}: reference ${data.reference.rows.length} rows, obsen ${data.obsen.rows.length} rows, ${differences.filter(d => !d.explained).length} unexplained differences`);
      return data;
    };
    for (const [name, c] of clients) {
      const present = name === 'reference' || await c.evaluate(`!!document.querySelector('.modal.mod-settings .vertical-tab-nav-item[data-setting-id=${JSON.stringify(id)}]')`);
      if (!present) { tab.missingInObsen = true; continue; }
      await openTab(name, c, id);
    }
    if (tab.missingInObsen) { console.log(`${id}: tab missing in the re-creation`); continue; }
    const main = await audit('main', id);
    // Sub-pages behind navigable rows, addressed by name so both apps open the same one.
    const navigable = main.reference.rows.filter(row => row.kind === 'row' && /\bmod-navigable\b/.test(row.cls)).map(row => row.name);
    for (const rowName of navigable) {
      const open = `(async () => { const row = [...document.querySelectorAll('.modal.mod-settings .vertical-tab-content .setting-item')].find(e => window.__settingsAudit.visible(e) && (e.querySelector('.setting-item-name')?.textContent ?? '').trim() === ${JSON.stringify(rowName)}); if (!row) return false; row.click(); await new Promise(r => setTimeout(r, 500)); return true; })()`;
      const opened = {};
      for (const [name, c] of clients) { await openTab(name, c, id); opened[name] = await c.evaluate(name === 'reference' ? open.split(brand.name).join(brand.original) : open); }
      const slug = rowName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!opened.obsen) { tab.pages[rowName] = { missingRowInObsen: true, differences: [{ type: 'missing-in-obsen', key: `navigable row ${rowName}` }] }; continue; }
      await audit(rowName, `${id}--${slug}`);
    }
    if (id === 'community-plugins') {
      // Restricted mode: the reference switches it in place; the re-creation's tab reads its flag when it is drawn.
      await reference.evaluate(`(async () => { await app.plugins.setEnable(false); return true; })()`);
      await obsen.evaluate(`(() => { const key = Object.keys(localStorage).find(k => k.startsWith('obsen:restricted-mode:')); window.__auditRestrictedKey = key; if (key) localStorage.setItem(key, 'true'); return !!key; })()`);
      await delay(400);
      for (const [name, c] of clients) await openTab(name, c, id);
      await audit('restricted mode', `${id}--restricted`);
      await reference.evaluate(`(async () => { await app.plugins.setEnable(true); return true; })()`);
      await obsen.evaluate(`(window.__auditRestrictedKey && localStorage.setItem(window.__auditRestrictedKey, 'false'), true)`);
      await delay(600);
    }
    for (const [name, c] of clients) await openTab(name, c, id);
  }

  // Settings search.
  if (!only) for (const query of ['font', 'link', 'folder', 'delete', 'zzzqqq']) {
    const result = {};
    for (const [name, c] of clients) { await openTab(name, c, 'about'); result[name] = normalize(await c.evaluate(`window.__settingsAudit.search(${JSON.stringify(query)})`), name); await capture(c, `${name}-search-${query}`, '.modal.mod-settings .vertical-tab-header'); }
    result.equal = JSON.stringify(result.reference) === JSON.stringify(result.obsen);
    report.search[query] = result;
    console.log(`search "${query}": reference ${result.reference.length} groups, obsen ${result.obsen.length} groups, ${result.equal ? 'equal' : 'DIFFERENT'}`);
  }
  for (const [name, c] of clients) { await c.evaluate(`window.__settingsAudit.clearSearch()`); report.errors[name] = c.errors.slice(); }

  if (withPersist) report.persistence = await persistence(report.sidebar.reference.flatMap(group => group.items.map(item => item.id)));

  // The pop-out form: frame only (title, size, body classes, title bar).
  if (withPopout) report.popout = await popoutFrame();
} catch (error) {
  console.error('Settings audit failed:', error instanceof Error ? error.stack : error);
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'row-diff.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(output, 'row-diff.md'), markdown(report));
  for (const [, c] of clients) c.socket.close();
}
const unexplained = Object.values(report.tabs).flatMap(tab => tab.missingInObsen ? [1] : Object.values(tab.pages).flatMap(page => page.differences.filter(d => !d.explained))).length
  + (report.sidebar.equal ? 0 : 1) + Object.values(report.search).filter(s => !s.equal).length + (report.popout && !report.popout.equal ? 1 : 0);
console.log(`${unexplained} unexplained differences. Report: ${path.join(output, 'row-diff.md')}`);
process.exitCode = unexplained ? 1 : 0;

// The re-creation has no vault.setConfig; its preference file is rewritten and the page reloaded.
async function setObsenPopout(c, value) {
  await c.evaluate(`(async () => { const a = window.app ?? window.__obsenSmokeApp; let data = {}; try { data = JSON.parse(await a.vault.adapter.read('.obsidian/app.json')); } catch {} data.settingsPopoutWindow = ${value}; await a.vault.adapter.write('.obsidian/app.json', JSON.stringify(data, null, 2)); return true; })()`);
  await c.send('Page.reload'); await delay(500);
  await c.wait(`!!(window.app ?? window.__obsenSmokeApp)?.commands.findCommand('app:open-settings')`, 're-creation after reload'); await delay(1500);
}
// Rows whose control does something other than store a vault preference (opens a dialog, reloads, toggles a plugin, lives in the profile).
function persistSkip() { return new Set(['Open settings in new window', 'Show editing mode in status bar', 'Vim key bindings', 'Show Mermaid diagrams in notes', 'Hardware acceleration', 'Command line interface', 'Automatic updates',
  'Notify if startup takes longer than expected', 'Language', 'Themes', 'Window frame style', 'Spellcheck languages', 'Date format', 'Automatically check for plugin updates']); }
function persistTabsSkip() { return new Set(['about', 'hotkeys', 'keychain', 'plugins', 'community-plugins', 'sync']); }
async function persistence(tabIds) {
  const flip = `(async (skip) => {
    const rows = [...document.querySelectorAll('.modal.mod-settings .vertical-tab-content .setting-item:not(.setting-item-heading)')].filter(window.__settingsAudit.visible);
    const done = [];
    for (const row of rows) {
      const name = (row.querySelector(':scope > .setting-item-info > .setting-item-name')?.textContent ?? '').trim();
      if (!name || skip.includes(name) || row.classList.contains('mod-navigable')) continue;
      const control = row.querySelector(':scope > .setting-item-control');
      const toggle = control?.querySelector(':scope > .checkbox-container'), select = control?.querySelector(':scope > select.dropdown:not(.is-measuring)');
      if (toggle) { const before = toggle.classList.contains('is-enabled'); toggle.click(); await new Promise(r => setTimeout(r, 120)); done.push({ name, type: 'toggle', before, after: !before }); }
      else if (select && select.options.length > 1) {
        const before = select.value, index = select.selectedIndex === 0 ? 1 : 0;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, select.options[index].value);
        select.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 120));
        done.push({ name, type: 'dropdown', before, after: select.options[index].value });
      }
    }
    return done;
  })`;
  const restore = `(async (changes) => {
    for (const change of changes.slice().reverse()) {
      const row = [...document.querySelectorAll('.modal.mod-settings .vertical-tab-content .setting-item:not(.setting-item-heading)')].find(e => (e.querySelector(':scope > .setting-item-info > .setting-item-name')?.textContent ?? '').trim() === change.name);
      const control = row?.querySelector(':scope > .setting-item-control'); if (!control) continue;
      if (change.type === 'toggle') { const toggle = control.querySelector(':scope > .checkbox-container'); if (toggle && toggle.classList.contains('is-enabled') !== change.before) toggle.click(); }
      else { const select = control.querySelector(':scope > select.dropdown:not(.is-measuring)'); if (select) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, change.before); select.dispatchEvent(new Event('change', { bubbles: true })); } }
      await new Promise(r => setTimeout(r, 120));
    }
    return true;
  })`;
  const files = `(async () => {
    const a = window.app ?? window.__obsenSmokeApp, out = {};
    for (const file of (await a.vault.adapter.list('.obsidian')).files) {
      const name = file.split('/').pop();
      if (!name.endsWith('.json') || /^(workspace.*|core-plugins.*|community-plugins|hotkeys|types|graph|bookmarks|workspaces)\\.json$/.test(name)) continue;
      try { out[name] = JSON.parse(await a.vault.adapter.read(file)); } catch { out[name] = null; }
    }
    return out;
  })()`;
  const result = { changes: {}, files: {}, differences: [] };
  const brandName = name => name === 'reference' ? value => value.split(brand.name).join(brand.original) : value => value;
  for (const id of tabIds.filter(id => !persistTabsSkip().has(id) && (!only || only.includes(id)))) {
    result.changes[id] = {};
    for (const [name, c] of clients) {
      await openTab(name, c, id);
      result.changes[id][name] = await c.evaluate(`${flip}(${JSON.stringify([...persistSkip()].map(brandName(name)))})`);
    }
    const key = list => JSON.stringify(list.map(change => [change.name.split(brand.original).join(brand.name), change.type, change.before, change.after]));
    if (key(result.changes[id].reference) !== key(result.changes[id].obsen)) result.differences.push({ tab: id, what: 'the same controls did not change the same way', reference: result.changes[id].reference, obsen: result.changes[id].obsen });
  }
  await delay(3000);
  for (const [name, c] of clients) result.files[name] = await c.evaluate(files);
  const names = new Set([...Object.keys(result.files.reference), ...Object.keys(result.files.obsen)]);
  for (const file of names) {
    const a = result.files.reference[file], b = result.files.obsen[file];
    if (!a || !b) { result.differences.push({ file, what: !a ? 'only the re-creation wrote this file' : 'only the reference wrote this file', content: a ?? b }); continue; }
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) result.differences.push({ file, field, reference: a[field], obsen: b[field] });
  }
  for (const id of Object.keys(result.changes).reverse()) for (const [name, c] of clients) { await openTab(name, c, id); await c.evaluate(`${restore}(${JSON.stringify(result.changes[id][name])})`); }
  await delay(1500);
  await fs.writeFile(path.join(output, 'persistence.json'), JSON.stringify(result, null, 2));
  console.log(`persistence: ${Object.values(result.changes).reduce((sum, tab) => sum + tab.reference.length, 0)} controls changed in each app, ${result.differences.length} differences in the stored JSON`);
  return result;
}
async function installFixturePlugin() {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const from = path.join((await read(`dist/todo-backup/obsen-comparison-fixture-${OBSEN_PORT}.json`)).directory, 'vault', '.obsidian', 'plugins', 'smoke-fixture');
  const to = path.join((await read(`dist/todo-backup/reference-fixture-${REF_PORT}.json`)).directory, 'vault', '.obsidian', 'plugins', 'smoke-fixture');
  await fs.mkdir(to, { recursive: true });
  for (const file of await fs.readdir(from)) await fs.copyFile(path.join(from, file), path.join(to, file));
  await reference.evaluate(`(async () => { if (!app.plugins.isEnabled()) await app.plugins.setEnable(true); await app.plugins.loadManifests(); if (!app.plugins.plugins['smoke-fixture']) await app.plugins.enablePluginAndSave('smoke-fixture'); return true; })()`);
}
async function popoutFrame() {
  const result = {};
  const pagesOf = async port => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(page => page.type === 'page');
  for (const [name, c] of clients) {
    const port = name === 'reference' ? REF_PORT : OBSEN_PORT, before = (await pagesOf(port)).map(page => page.id);
    await c.evaluate(`(async () => { document.querySelector('.modal.mod-settings .modal-header-button, .modal.mod-settings .modal-close-button')?.click(); await new Promise(r => setTimeout(r, 300)); return true; })()`);
    if (name === 'reference') await c.evaluate(`(app.vault.setConfig('settingsPopoutWindow', true), app.setting.open(), true)`);
    else { await setObsenPopout(c, true); await c.evaluate(`((window.app ?? window.__obsenSmokeApp).commands.executeCommandById('app:open-settings'), true)`); }
    let target = null;
    for (let attempt = 0; attempt < 40 && !target; attempt++) { await delay(250); target = (await pagesOf(port)).find(page => !before.includes(page.id)); }
    if (!target) { result[name] = { error: 'no pop-out window appeared' }; continue; }
    await delay(1500);
    const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let serial = 0; const pending = new Map();
    socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000); pending.set(id, message => { clearTimeout(timer); resolve(message.result); }); socket.send(JSON.stringify({ id, method, params })); });
    const value = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const outline = e => ({ tag: e.tagName.toLowerCase(), class: e.getAttribute('class') ?? '', ...(e.getAttribute('aria-label') ? { label: e.getAttribute('aria-label') } : {}), ...(e.children.length ? { children: [...e.children].filter(x => !['svg', 'path'].includes(x.tagName)).map(outline) } : { text: e.textContent }) });
      const bar = document.querySelector('.titlebar'), modal = document.querySelector('.modal.mod-settings'), rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
      return { title: document.title, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], bodyClasses: [...document.body.classList].sort(), bodyChildren: [...document.body.children].map(e => e.tagName.toLowerCase() + '.' + e.className.split(/\\s+/).join('.')), titlebar: bar ? outline(bar) : null, titlebarRect: rect(bar), modalRect: rect(modal), modalParent: modal?.parentElement?.className ?? null };
    })()` });
    result[name] = normalize(value.result.value, name);
    result[name].title = result[name].title.replace(/\d+\.\d+\.\d+(?:\.\d+)?/g, 'N');
    if (result[name].titlebar?.children?.[0]?.children?.[0]) result[name].titlebar.children[0].children[0].text = result[name].title;
    // Only the foreground pop-out receives Chromium's transient focus class;
    // it does not represent a persisted settings/frame difference.
    result[name].bodyClasses = result[name].bodyClasses.filter(cls => cls !== 'is-focused');
    result[name].modalParent = result[name].modalParent?.split(/\s+/).filter(cls => cls !== 'is-focused').sort().join(' ') ?? null;
    if (!noCapture) {
      const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png' }).catch(() => null), delay(6000).then(() => null)]);
      if (shot?.data) await fs.writeFile(path.join(output, `${name}-popout.png`), Buffer.from(shot.data, 'base64'));
    }
    await send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined);
    socket.close();
    await delay(500);
    if (name === 'reference') await c.evaluate(`(app.vault.setConfig('settingsPopoutWindow', false), true)`);
    else await setObsenPopout(c, false);
  }
  const strip = value => { const copy = JSON.parse(JSON.stringify(value ?? {})); for (const key of ['title']) if (copy[key]) copy[key] = copy[key].replace(/\d+(\.\d+)+/g, 'N'); const text = JSON.stringify(copy).replace(/\d+(\.\d+){2,}/g, 'N'); return JSON.parse(text); };
  result.equal = JSON.stringify(strip(result.reference)) === JSON.stringify(strip(result.obsen));
  console.log(`pop-out frame: ${result.equal ? 'equal' : 'DIFFERENT'}`);
  return result;
}

function markdown(report) {
  const lines = ['# Settings row comparison', '', `Generated ${report.generated}. Reference on ${report.ports.reference}, re-creation on ${report.ports.obsen}. Brand name substituted before comparing.`, ''];
  const show = value => '`' + JSON.stringify(value ?? null).replace(/`/g, "'") + '`';
  lines.push('## Sidebar', '', report.sidebar.equal ? 'Identical groups, order, names and icons.' : 'DIFFERENT:', '');
  if (!report.sidebar.equal) lines.push('- reference: ' + show(report.sidebar.reference), '- obsen: ' + show(report.sidebar.obsen), '');
  lines.push('## Tabs', '', '| Tab | Page | Reference rows | Re-creation rows | Unexplained | Explained |', '| --- | --- | --- | --- | --- | --- |');
  for (const [id, tab] of Object.entries(report.tabs)) {
    if (tab.missingInObsen) { lines.push(`| ${id} | (tab missing in re-creation) | | | 1 | |`); continue; }
    for (const [label, page] of Object.entries(tab.pages)) lines.push(`| ${id} | ${label} | ${page.rows?.reference ?? ''} | ${page.rows?.obsen ?? ''} | ${page.differences.filter(d => !d.explained).length} | ${page.differences.filter(d => d.explained).length} |`);
  }
  lines.push('');
  for (const [id, tab] of Object.entries(report.tabs)) for (const [label, page] of Object.entries(tab.pages ?? {})) {
    if (!page.differences.length) continue;
    lines.push(`### ${id}${label === 'main' ? '' : ' > ' + label}`, '');
    for (const entry of page.differences) {
      const tag = entry.explained ? ` (explained: ${entry.explained})` : '';
      if (entry.type === 'different') { lines.push(`- DIFFERENT \`${entry.key}\`${tag}`); for (const [field, value] of Object.entries(entry.fields)) lines.push(`  - ${field}: reference ${show(value.reference)} / obsen ${show(value.obsen)}`); }
      else lines.push(`- ${entry.type === 'missing-in-obsen' ? 'MISSING in re-creation' : 'EXTRA in re-creation'}${entry.moved ? ' (present in both, different position)' : ''} \`${entry.key}\`${tag}${entry.row ? ': ' + show({ desc: entry.row.desc, cls: entry.row.cls, group: entry.row.group, controls: entry.row.controls ?? entry.row.control }) : ''}`);
    }
    lines.push('');
  }
  lines.push('## Search', '');
  for (const [query, result] of Object.entries(report.search)) { lines.push(`- \`${query}\`: ${result.equal ? 'equal' : 'DIFFERENT'} (reference ${result.reference.length} groups, obsen ${result.obsen.length})`); if (!result.equal) lines.push('  - reference: ' + show(result.reference), '  - obsen: ' + show(result.obsen)); }
  if (report.popout) { lines.push('', '## Pop-out frame', '', report.popout.equal ? 'Equal (version numbers in the title ignored).' : 'DIFFERENT:', ''); if (!report.popout.equal) lines.push('- reference: ' + show(report.popout.reference), '- obsen: ' + show(report.popout.obsen)); }
  if (report.persistence) { lines.push('', '## Persistence', '', `${Object.values(report.persistence.changes).reduce((sum, tab) => sum + tab.reference.length, 0)} toggles and dropdowns changed through the UI in each app; ${report.persistence.differences.length} differences in the JSON files of the two vaults (persistence.json has the full content).`, ''); for (const difference of report.persistence.differences) lines.push('- ' + show(difference)); }
  lines.push('', '## Renderer errors', '', '- reference: ' + show(report.errors.reference ?? []), '- obsen: ' + show(report.errors.obsen ?? []), '');
  return lines.join('\n');
}
