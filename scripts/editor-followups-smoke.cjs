const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const menuTitles = `[...document.querySelectorAll('.menu-item-title')].map(el => el.textContent)`;
const closeMenu = `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`;
const contextMenu = `(() => {
  const editor = window.app.workspace.activeLeaf.view.editor;
  editor.focus();
  editor.cm.contentDOM.querySelector('.cm-line').dispatchEvent(new MouseEvent('contextmenu', {view:window, bubbles:true, cancelable:true, clientX:400, clientY:180}));
  return ${menuTitles};
})()`;

exports.checkEditorFollowups = async ({ evaluate, waitFor, capture }) => {
  await evaluate(`window.app.workspace.activeLeaf.view.editor.setSelection({line:2,ch:0}, {line:2,ch:12})`);
  let titles = await evaluate(contextMenu);
  console.log("Electron smoke: editor menu opened.");
  assert.ok(titles.includes("Extract current selection..."), "selection extract appears in editor menu");
  assert.ok(!titles.includes("Extract this heading..."), "body text does not offer heading extraction");
  assert.ok(titles.includes("Fixture editor action") && titles.includes("Copy"), "community plugin and clipboard entries share the menu");
  assert.deepEqual(await evaluate(`window.__obsenSmokeEditorMenu`), { file: "Welcome.md", selection: "A local note", sameEditor: true }, "editor-menu receives the visible editor and its file owner");
  await capture("editor-selection-menu.png");
  console.log("Electron smoke: selection menu checks passed.");
  await evaluate(`[...document.querySelectorAll('.menu-item')].find(el => el.textContent.includes('Extract current selection...')).click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.prompt-input'))`), "selection extract prompt");
  await evaluate(closeMenu);
  await waitFor(() => evaluate(`!document.querySelector('.prompt-input')`), "extract prompt dismissed");
  await evaluate(`window.app.workspace.activeLeaf.view.editor.setCursor({line:0,ch:2})`);
  titles = await evaluate(contextMenu);
  assert.ok(titles.includes("Extract this heading...") && !titles.includes("Extract current selection..."), "heading extract follows caret with no selection");
  await evaluate(`[...document.querySelectorAll('.menu-item')].find(el => el.textContent.includes('Extract this heading...')).click()`);
  await waitFor(() => evaluate(`document.querySelector('.prompt-input')?.value === 'Welcome'`), "heading extract prompt names the heading");
  await evaluate(closeMenu);
  await evaluate(`window.app.workspace.activeLeaf.view.setSourceMode(true)`);
  await evaluate(`window.app.workspace.activeLeaf.view.editor.setCursor({line:0,ch:2})`);
  assert.ok((await evaluate(contextMenu)).includes("Fixture editor action"), "source mode emits editor-menu too");
  await evaluate(`[...document.querySelectorAll('.menu-item')].find(el => el.textContent.includes('Fixture editor action')).click()`);
  assert.equal(await evaluate(`window.__obsenSmokeEditorAction`), true, "community menu callback runs");
  await evaluate(`window.app.workspace.activeLeaf.view.setSourceMode(false)`);

  // Global search, backlinks, and outgoing links share these result rows. Source lines include frontmatter.
  const search = async (query, filename, line) => {
    await evaluate(`(async () => { const w = window.app.workspace, leaf = w.getLeavesOfType('search')[0]; await leaf.view.setState({query:${JSON.stringify(query)}}); await w.revealLeaf(leaf); })()`);
    await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('.search-result-file-match')].find(el => el.dataset.id.startsWith(${JSON.stringify(filename + "\n")})))`), "search match row");
    const data = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.search-result-file-match')].find(el => el.dataset.id.startsWith(${JSON.stringify(filename + "\n")}));
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('mouseover', {view:window, bubbles:true, ctrlKey:true, clientX:rect.left+10, clientY:rect.top+10}));
      return row.dataset.line;
    })()`);
    assert.equal(data, String(line), "search row carries the matching zero-based source line");
    await waitFor(() => evaluate(`Boolean(document.querySelector('.hover-popover .is-flashing')?.textContent.includes(${JSON.stringify(query)}))`), "hover preview flashes matching source section");
    if (line > 0) assert.equal(await evaluate(`document.querySelector('.hover-popover .markdown-preview-view').scrollTop > 0`), true, "hover preview scrolls down to the match");
    await capture(`search-hover-${line}.png`);
    await evaluate(`document.body.dispatchEvent(new MouseEvent('click', {view:window, bubbles:true}))`);
    await waitFor(() => evaluate(`!document.querySelector('.hover-popover')`), "hover closes");
  };
  await search("needle-later", "Hover.md", 124);
  console.log("Electron smoke: later-line hover passed.");
  await search("Welcome", "Welcome.md", 0);
  console.log("Electron smoke: first-line hover passed.");
  await evaluate(`(async () => { const w = window.app.workspace; await w.getLeaf().openFile(window.app.vault.getFileByPath('Welcome.md')); })()`);
};

exports.checkSettingsFollowups = async ({ evaluate, settings, waitFor, vault, capture }) => {
  const ev = code => settings.webContents.executeJavaScript(code);
  const tab = async id => {
    await ev(`document.querySelector('[data-setting-id="${id}"]').click()`);
    await waitFor(() => ev(`Boolean(document.querySelector('[data-setting-id="${id}"].is-active'))`), `${id} options`);
  };
  const names = `[...document.querySelectorAll('.vertical-tab-content .setting-item-name')].map(el => el.textContent)`;
  const toggle = name => ev(`(() => { const row = [...document.querySelectorAll('.vertical-tab-content .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(name)}); row.querySelector('.checkbox-container').click(); })()`);
  const type = (selector, value) => ev(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const format = value => ev(`(() => { const select = document.querySelector('.vertical-tab-content select'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const saved = async (id, key, value) => waitFor(() => fs.readFile(path.join(vault, '.obsidian', `${id}.json`), 'utf8').then(raw => JSON.parse(raw)[key] === value).catch(() => false), `${id} saves ${key}`);

  await tab("switcher");
  assert.equal((await ev(names)).includes("Show all file types"), false, "switcher hides unsupported-file row by default");
  await tab("file"); await toggle("Show all file types");
  await tab("switcher");
  assert.equal((await ev(names)).includes("Show all file types"), true, "vault preference reveals switcher row");
  await toggle("Show all file types"); await saved("switcher", "showAllFileTypes", true);
  await capture("settings-switcher.png");
  await tab("file"); await toggle("Show all file types");
  await tab("switcher");
  assert.equal((await ev(names)).includes("Show all file types"), false, "row hides again without discarding its saved choice");
  console.log("Electron smoke: switcher settings passed.");

  await tab("daily-notes");
  assert.deepEqual(await ev(`[...document.querySelector('.vertical-tab-content select').options].map(el => el.value)`), ["YYYY-MM-DD", "YYYY.MM.DD", "YYYY/MM/DD", "YYYY/MM/YYYY-MM-DD", "custom"], "daily notes offers reference presets and Custom");
  await format("YYYY.MM.DD"); await saved("daily-notes", "format", "YYYY.MM.DD");
  await format("custom");
  await type(".vertical-tab-content input[placeholder='YYYY-MM-DD']", "YYYY-[day]-MM-DD");
  await saved("daily-notes", "format", "YYYY-[day]-MM-DD");
  await type(".vertical-tab-content input[placeholder='YYYY-MM-DD']", "/YYYY");
  assert.equal(await ev(`document.querySelector('.vertical-tab-content .setting-item-error').textContent`), "Invalid date format", "invalid custom format is explained");
  assert.equal(JSON.parse(await fs.readFile(path.join(vault, '.obsidian/daily-notes.json'), 'utf8')).format, "YYYY-[day]-MM-DD", "invalid input preserves last valid format");
  await type(".vertical-tab-content input[placeholder='YYYY-MM-DD']", "YYYY-[day]-MM-DD");
  await capture("settings-daily-notes.png");
  await tab("switcher"); await tab("daily-notes");
  await waitFor(() => ev(`document.querySelector('.vertical-tab-content select').value === 'custom'`), "saved daily-note format loads");
  assert.equal(await ev(`document.querySelector('.vertical-tab-content select').value`), "custom", "saved custom format reopens as Custom");
  console.log("Electron smoke: daily-note settings passed.");

  await tab("page-preview");
  await waitFor(() => ev(`(${names}).includes('Fixture preview')`), "community hover source appears");
  assert.equal(await ev(`(() => { const row = [...document.querySelectorAll('.vertical-tab-content .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent === 'Reading view'); return row.querySelector('input').checked; })()`), false, "reading view respects registered defaultMod=false");
  await type(".vertical-tab-content input[type=search]", "fixture");
  assert.deepEqual(await ev(`[...document.querySelectorAll('.vertical-tab-content .mod-toggle .setting-item-name')].map(el => el.textContent)`), ["Fixture preview"], "hover sources can be filtered");
  await toggle("Fixture preview"); await saved("page-preview", "smoke-fixture", true);
  await type(".vertical-tab-content input[type=search]", "");
  await evaluate(`window.app.workspace.registerHoverLinkSource('dynamic-fixture', {display:'Dynamic preview', defaultMod:false})`);
  await waitFor(() => ev(`(${names}).includes('Dynamic preview')`), "source registered while settings is open appears");
  await evaluate(`window.app.workspace.unregisterHoverLinkSource('dynamic-fixture')`);
  await waitFor(() => ev(`!(${names}).includes('Dynamic preview')`), "unregistered source disappears");
  await capture("settings-page-preview.png");
  await tab("plugins"); await toggle("Graph view");
  await tab("page-preview");
  assert.equal((await ev(names)).includes("Graph view"), false, "disabled core plugin unregisters its hover source");
  await tab("plugins"); await toggle("Graph view");
  await tab("page-preview");
  assert.equal((await ev(names)).includes("Graph view"), true, "re-enabled core plugin restores its hover source");
};
