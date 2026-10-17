import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fixtureClient, delay } from './fixture-client.mjs';

const paragraph = 'An article should keep its useful paragraphs when opened in reader mode. The example explains a practical observation, with enough detail to distinguish the article from surrounding navigation and advertising. Readers can follow the evidence, compare the results, and preserve the original page while exploring its content. ';
const examples = {
  images: `<title>Reader images</title><article><h1>Reader images</h1><p>${paragraph.repeat(4)}</p><figure><img src="/illustration.svg" alt="Reader illustration"><figcaption>An article illustration.</figcaption></figure><p><img src="/large.svg" alt="Large illustration"></p><p>${paragraph.repeat(4)}</p></article>`,
  semantic: `<title>Reader audit | Example</title><meta property="og:title" content="Reader audit"><meta property="og:site_name" content="Example"><nav>Navigation <a href="/home">Home</a></nav><article><h1>Reader audit</h1><p>${paragraph.repeat(3)}</p><h2>Formatting</h2><p><b>Bold</b>, <i>emphasis</i>, <del>removed</del> and <mark>highlighted</mark>. <a href="/story?q=(value)" title="A story">A related story</a>.</p><ul><li>First item<ul><li>Nested item</li></ul></li><li>Second item</li></ul><pre><code class="language-js">const example = 42;\nconsole.log(example);</code></pre><table><thead><tr><th align="left">Name</th><th align="right">Value</th></tr></thead><tbody><tr><td>Entry</td><td>42</td></tr></tbody></table><p>${paragraph.repeat(3)}</p></article><aside>Unrelated promotional content</aside>`,
  fallback: `<title>Another reader article</title><div class="menu">About | Contact | Advertising</div><div class="entry-content"><h1>Another reader article</h1><p>${paragraph.repeat(4)}</p><blockquote>A useful quotation.</blockquote><ol start="3"><li>Third item</li><li>Fourth item</li></ol><p>${paragraph.repeat(4)}</p></div>`,
};
const fragments = [
  '<h2>Heading</h2><p>Text *with* [literal] _punctuation_. <b>Bold</b> <i>Italic</i> <s>Old</s> <mark>New</mark><br>Next line</p>',
  '<p><a href="/space path(foo)" title="A &quot;title&quot;">Link</a><img src="image (one).png" alt="An [image]" title="Caption"></p>',
  '<ol start="3"><li>Third<ul><li>Nested</li></ul></li><li>Fourth</li></ol><ul><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Open</li></ul>',
  '<table><tr><th align="center" colspan="2">Heading</th><th>Last</th></tr><tr><td>A|B<br>C</td><td>D</td><td>E</td></tr></table>',
  '<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>',
  '<div class="highlight-source-js"><pre>const n = 1;\n</pre></div><pre><code class="language-js">const x = 2;\n</code></pre>',
];
const titles = ['Path / segment: detail?', 'Quote "title"', 'Heading # [note]', 'CON', 'Trailing.', 'Cafe\u0301', 'Title  with   spaces'];
const output = 'dist/todo-backup/reader-comparison';
await fs.mkdir(output, { recursive: true });
const illustration = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#587da8"/></svg>';
const largeIllustration = illustration.replaceAll('width="32" height="24"', 'width="2200" height="1100"');
const server = http.createServer((request, response) => { if (request.url === '/large.svg' || request.url === '/illustration.svg') { response.setHeader('Content-Type','image/svg+xml'); response.end(request.url === '/large.svg' ? largeIllustration : illustration); return; } response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(examples[request.url.slice(1)] ?? 'Missing'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port, report = {};
try {
  for (const [name, port, prefix] of [['reference', 9352, 'obsen-reference-audit-'], ['obsen', 9342, 'obsen-electron-smoke-']]) {
    const c = await fixtureClient(port, prefix, { separateHistoricalErrors: true });
    report[name] = { fragments: [], articles: {}, errors: [] };
    try {
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      if (await c.evaluate(`!!document.querySelector('.lightbox')`)) { await c.evaluate(`document.querySelector('.lightbox').focus()`); await c.key('Escape'); await c.wait(`!document.querySelector('.lightbox')`, 'previous fixture lightbox closed'); }
      await c.evaluate(`(() => { app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); })()`);
      if (name === 'reference') {
        const vault = await c.evaluate(`app.vault.adapter.getBasePath()`), directory = vault + '/.obsidian/plugins/reader-audit';
        await fs.mkdir(directory, { recursive: true });
        const manifest = { id: 'reader-audit', name: 'Reader audit fixture', version: '1.0.0', minAppVersion: '1.0.0', author: 'Fixture', isDesktopOnly: true };
        await fs.writeFile(directory + '/manifest.json', JSON.stringify(manifest));
        await fs.writeFile(directory + '/main.js', `const api = require('obsidian'); module.exports = class extends api.Plugin { onload() { window.__readerAuditApi = api; } onunload() { delete window.__readerAuditApi; } };`);
        await c.evaluate(`(async () => { window.__readerAuditPluginsEnabled = app.plugins.isEnabled(); app.plugins.setEnable(true); app.plugins.manifests['reader-audit'] = {...${JSON.stringify(manifest)}, dir:'.obsidian/plugins/reader-audit'}; await app.plugins.loadPlugin('reader-audit'); })()`);
      }
      const api = name === 'reference' ? 'window.__readerAuditApi' : 'window.__obsenSmokeApi';
      for (const fragment of fragments) report[name].fragments.push(await c.evaluate(`${api}.htmlToMarkdown(${JSON.stringify(fragment)})`));
      await c.evaluate(`(() => { app.vault.setConfig('settingsPopoutWindow', false); app.commands.executeCommandById('app:open-settings'); })()`);
      await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=plugins]')`, 'settings');
      await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=plugins]').click()`);
      await c.evaluate(`(() => { const row = [...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === 'Web viewer'); const checkbox = row?.querySelector('.checkbox-container'); if (!checkbox) throw new Error('Missing plugin'); if (!checkbox.classList.contains('is-enabled')) checkbox.click(); })()`);
      await delay(250); await c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`);
      await c.evaluate(`(() => { app.commands.executeCommandById('app:open-settings'); })()`);
      await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=webviewer]')`, 'web settings');
      await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=webviewer]').click()`);
      await c.evaluate(`(() => { const row = [...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === 'Open external links'); const checkbox = row.querySelector('.checkbox-container'); if (checkbox.classList.contains('is-enabled')) checkbox.click(); })()`);
      await delay(250); await c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`);
      for (const key of Object.keys(examples)) {
        const url = base + '/' + key;
        await c.evaluate(`(async () => { window.__readerAuditLeaf = app.workspace.getLeaf('tab'); await window.__readerAuditLeaf.setViewState({type:'webviewer', state:{url:${JSON.stringify(url)}}, active:true}); app.workspace.setActiveLeaf(window.__readerAuditLeaf); })()`);
        await c.wait(`window.__readerAuditLeaf.view.webview?.getURL() === ${JSON.stringify(url)} && !window.__readerAuditLeaf.view.webview.isLoading()`, 'article loaded');
        const before = await c.evaluate(`window.__readerAuditLeaf.view.webview.executeJavaScript('document.documentElement.outerHTML')`);
        const content = await c.evaluate(`window.__readerAuditLeaf.view.getReaderModeContent()`);
        assert.ok(content?.md.length > 500, name + ' extracted article');
        const after = await c.evaluate(`window.__readerAuditLeaf.view.webview.executeJavaScript('document.documentElement.outerHTML')`);
        assert.equal(after, before, name + ' extraction preserved page');
        report[name].articles[key] = content;
        await c.evaluate(`window.__readerAuditLeaf.view.displayReaderView()`);
        await c.wait(`window.__readerAuditLeaf.view.mode === 'reader' && !!window.__readerAuditLeaf.containerEl.querySelector('.reader-mode-content p')`, 'reader rendered');
        await c.evaluate(`document.fonts.ready`); await delay(300);
        if (key === 'images') await c.wait(`[...window.__readerAuditLeaf.containerEl.querySelectorAll('.reader-mode-content img')].some(image=>image.complete && image.naturalWidth === 32)`, 'reader illustration loaded');
        await c.capture(output, name + '-' + key, '.workspace-leaf.mod-active .reader-mode-content');
        if (key === 'images') {
          report[name].imageMenu = await c.evaluate(`(() => {
            window.__readerAuditAttachmentPath = app.vault.getConfig('attachmentFolderPath'); app.vault.setConfig('attachmentFolderPath','');
            window.__readerAuditFilesBefore = new Set(app.vault.getFiles().map(file=>file.path));
            const remote = require('electron').remote, original = remote.Menu.buildFromTemplate; let captured;
            remote.Menu.buildFromTemplate = items => ({popup() { captured = items.map(item=>({label:item.label})); window.__readerAuditSaveImage = items.find(item=>item.label === 'Save image to vault').click; }});
            try { const image = window.__readerAuditLeaf.containerEl.querySelector('.reader-mode-content img'); image.dispatchEvent(new image.ownerDocument.defaultView.MouseEvent('contextmenu',{bubbles:true,button:2})); return captured; }
            finally { remote.Menu.buildFromTemplate = original; }
          })()`);
          await c.evaluate(`window.__readerAuditSaveImage()`);
          await c.wait(`app.vault.getFiles().some(file=>!window.__readerAuditFilesBefore.has(file.path))`, 'reader image saved');
          report[name].imageSave = await c.evaluate(`(async () => { const file = app.vault.getFiles().find(file=>!window.__readerAuditFilesBefore.has(file.path)); const result = {path:file.path,text:new TextDecoder().decode(await app.vault.readBinary(file))}; await app.vault.delete(file); app.vault.setConfig('attachmentFolderPath',window.__readerAuditAttachmentPath); return result; })()`);
          assert.equal(report[name].imageSave.text, illustration, name + ' original image bytes saved');
          await c.evaluate(`document.querySelectorAll('.notice').forEach(notice=>notice.remove())`);
          await c.wait(`!!document.querySelector('.lightbox img')`, 'image context click opens lightbox');
          await c.evaluate(`document.querySelector('.lightbox').focus()`);
          await delay(300); await c.capture(output, name + '-lightbox', '.lightbox');
          await c.key('=', 'Equal'); await delay(100); await c.capture(output, name + '-lightbox-zoom', '.lightbox');
          report[name].imageZoom = await c.evaluate(`({zoomed:document.querySelector('.lightbox').classList.contains('is-zoomed'), transform:document.querySelector('.lightbox img').style.transform})`);
          await c.key('-', 'Minus'); await delay(100);
          report[name].imageZoomOut = await c.evaluate(`({zoomed:document.querySelector('.lightbox').classList.contains('is-zoomed'), transform:document.querySelector('.lightbox img').style.transform})`);
          await c.key('ArrowRight');
          await c.wait(`document.querySelector('.lightbox img')?.naturalWidth === 2200`, 'large gallery image loaded');
          await delay(300); await c.capture(output, name + '-gallery-large', '.lightbox');
          const galleryState = `(() => { const image=document.querySelector('.lightbox img'); const rect=image.getBoundingClientRect(); return {title:document.querySelector('.lightbox-titlebar-text').textContent, image:new URL(image.src).pathname, transform:image.style.transform, zoomed:document.querySelector('.lightbox').classList.contains('is-zoomed'), width:rect.width,height:rect.height}; })()`;
          report[name].gallery = {large:await c.evaluate(galleryState)};
          await c.evaluate(`document.querySelector('.lightbox-content').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-150,clientX:900,clientY:600}))`);
          await delay(100); await c.capture(output, name + '-gallery-wheel', '.lightbox');
          report[name].gallery.wheel = await c.evaluate(galleryState);
          await c.evaluate(`document.querySelector('.lightbox-content').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:500,deltaY:500}))`);
          await delay(100); await c.capture(output, name + '-gallery-pan', '.lightbox');
          report[name].gallery.pan = await c.evaluate(galleryState);
          await c.key('ArrowRight'); await delay(300);
          report[name].gallery.wrapForward = await c.evaluate(galleryState);
          await c.key('ArrowLeft'); await delay(300);
          report[name].gallery.wrapBackward = await c.evaluate(galleryState);
          await c.evaluate(`document.querySelector('.lightbox img').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2,button:0,clientX:900,clientY:600}))`);
          await delay(300); await c.capture(output, name + '-gallery-double', '.lightbox');
          report[name].gallery.doubleClick = await c.evaluate(galleryState);
          await c.evaluate(`document.querySelector('.lightbox img').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2,button:0,clientX:900,clientY:600}))`);
          await delay(300);
          report[name].gallery.doubleReset = await c.evaluate(galleryState);
          await c.evaluate(`document.querySelector('.lightbox-content').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-150,clientX:640,clientY:450}))`);
          await delay(100); await c.capture(output, name + '-gallery-drag-start', '.lightbox');
          await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:400,y:400,button:'left',buttons:1,clickCount:1});
          for (const [x,y] of [[550,430],[725,465],[900,500]]) { await delay(20); await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'left',buttons:1}); }
          await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:900,y:500,button:'left',buttons:0,clickCount:1});
          await delay(600); await c.capture(output, name + '-gallery-drag', '.lightbox');
          report[name].gallery.drag = await c.evaluate(galleryState);
          report[name].gallery.dragGrabbingCleared = await c.evaluate(`!document.body.classList.contains('is-grabbing')`);
          await c.key('ArrowRight'); await delay(300);
          await c.key('Escape');
          report[name].gallery.closeAnimationPresent = await c.evaluate(`!!document.querySelector('.lightbox')`);
          await c.wait(`!document.querySelector('.lightbox')`, 'image lightbox dismissed');
        }
        if (key === 'semantic') {
          await c.evaluate(`(() => { const preview = window.__readerAuditLeaf.containerEl.querySelector('.reader-mode-content .markdown-preview-view'); preview.scrollTop = 150; })()`);
          await delay(100);
          report[name].toggle = { before: await c.evaluate(`window.__readerAuditLeaf.containerEl.querySelector('.reader-mode-content .markdown-preview-view').scrollTop`) };
          await c.evaluate(`app.commands.executeCommandById('webviewer:toggle-reader-mode')`);
          await c.wait(`window.__readerAuditLeaf.view.mode === 'webview'`, 'reader disabled');
          report[name].toggle.pagePreserved = before === await c.evaluate(`window.__readerAuditLeaf.view.webview.executeJavaScript('document.documentElement.outerHTML')`);
          await c.evaluate(`app.commands.executeCommandById('webviewer:toggle-reader-mode')`);
          await c.wait(`window.__readerAuditLeaf.view.mode === 'reader' && !!window.__readerAuditLeaf.containerEl.querySelector('.reader-mode-content p')`, 'reader re-enabled');
          await delay(100);
          report[name].toggle.after = await c.evaluate(`window.__readerAuditLeaf.containerEl.querySelector('.reader-mode-content .markdown-preview-view').scrollTop`);
          await c.evaluate(`require('electron').ipcRenderer.invoke('fixture:external-urls', true)`);
          await c.evaluate(`window.__readerAuditLeaf.containerEl.querySelector('.reader-mode-content a.external-link').scrollIntoView({block:'center'})`);
          await delay(150);
          await c.capture(output, name + '-toggle', '.workspace-leaf.mod-active .reader-mode-content');
          await c.evaluate(`(() => { window.__readerAuditClick = null; document.addEventListener('click', function record(event) { window.__readerAuditClick = {tag:event.target.nodeName, class:event.target.className, link:event.target.closest?.('a')?.getAttribute('href')}; document.removeEventListener('click',record,true); },true); })()`);
          await c.click('.workspace-leaf.mod-active .reader-mode-content a.external-link');
          await delay(300);
          report[name].link = await c.evaluate(`(async () => ({ retainsArticle:window.__readerAuditLeaf.view.webview.getURL() === ${JSON.stringify(url)}, external:await require('electron').ipcRenderer.invoke('fixture:external-urls', true),click:window.__readerAuditClick }))()`);
        }
        if (key === 'fallback') {
          report[name].saves = [];
          for (const folder of ['', 'Reader audit saves', 'Reader audit missing folder']) {
            if (folder === 'Reader audit saves') await c.evaluate(`(async () => { if (!app.vault.getFolderByPath(${JSON.stringify(folder)})) await app.vault.createFolder(${JSON.stringify(folder)}); })()`);
            await c.evaluate(`app.commands.executeCommandById('app:open-settings')`);
            await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=webviewer]')`, 'save settings');
            await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=webviewer]').click()`);
            await c.evaluate(`(() => { const row = [...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent.trim() === 'Saved page folder'); row.querySelector('input').dataset.readerAuditFolder = 'true'; })()`);
            await c.click('input[data-reader-audit-folder]'); await c.key('a', 'KeyA', { modifiers:2, windowsVirtualKeyCode:65 });
            if (folder) await c.send('Input.insertText', {text:folder}); else await c.key('Backspace');
            await delay(300); await c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`); await delay(200);
            report[name].saves.push(await c.evaluate(`(async () => { try { const file = await window.__readerAuditLeaf.view.saveAsMarkdown(); const text = await app.vault.read(file); const result = {saved:true, folder:file.path.slice(0, Math.max(0, file.path.lastIndexOf('/'))), matches:text === ${JSON.stringify(content.md)}}; await app.vault.delete(file); return result; } catch(error) { return {saved:false, folderExists:await app.vault.adapter.exists(${JSON.stringify(folder)})}; } })()`));
          }
          report[name].titles = [];
          for (const title of titles) {
            await c.evaluate(`window.__readerAuditLeaf.view.webview.executeJavaScript(${JSON.stringify(`document.title = ${JSON.stringify(title)}; document.querySelector('h1').textContent = ${JSON.stringify(title)};`)})`);
            report[name].titles.push((await c.evaluate(`window.__readerAuditLeaf.view.getReaderModeContent()`)).title);
          }
        }
        await c.evaluate(`window.__readerAuditLeaf.detach()`);
      }
      await c.evaluate(`(async () => { window.__readerAuditPopout = await app.workspace.openPopoutLeaf(); await window.__readerAuditPopout.setViewState({type:'webviewer',state:{url:${JSON.stringify(base + '/semantic')}},active:true}); app.workspace.setActiveLeaf(window.__readerAuditPopout); })()`);
      await c.wait(`window.__readerAuditPopout.view.webview?.getURL() === ${JSON.stringify(base + '/semantic')} && !window.__readerAuditPopout.view.webview.isLoading()`, 'popout article loaded');
      report[name].popout = { separateWindow: await c.evaluate(`window.__readerAuditPopout.getContainer().win !== app.workspace.rootSplit.win`) };
      await c.evaluate(`window.__readerAuditPopout.view.displayReaderView()`);
      await c.wait(`window.__readerAuditPopout.view.mode === 'reader' && !!window.__readerAuditPopout.containerEl.querySelector('.reader-mode-content p')`, 'popout reader rendered');
      await delay(250);
      report[name].popout.content = await c.evaluate(`window.__readerAuditPopout.view.getReaderModeContent()`);
      report[name].popout.outline = await c.evaluate(`(() => { const outline = el => ({tag:el.tagName.toLowerCase(),class:el.getAttribute('class')??'',...(el.children.length ? {children:[...el.children].filter(x=>!['svg','path'].includes(x.tagName)).map(outline)} : {text:el.textContent})}); return outline(window.__readerAuditPopout.containerEl.querySelector('.reader-mode-content')); })()`);
      report[name].popout.menu = await c.evaluate(`(() => {
        const remote = require('electron').remote, original = remote.Menu.buildFromTemplate, rootId = remote.getCurrentWindow().id;
        let captured, actions;
        remote.Menu.buildFromTemplate = items => ({popup(options) { actions = items; captured = {items:items.map(item=>Object.fromEntries(['label','type','role','accelerator','enabled'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]))), usesRootWindow:options.window.id === rootId}; }});
        try {
          const root = window.__readerAuditPopout.containerEl, target = root.querySelector('.reader-mode-content p'), win = target.ownerDocument.defaultView;
          win.getSelection()?.removeAllRanges(); target.dispatchEvent(new win.MouseEvent('contextmenu',{bubbles:true,button:2}));
          const page = captured; actions.find(item=>item.label === 'Select all').click(); page.selection = win.getSelection().toString();
          win.getSelection().removeAllRanges(); const link = root.querySelector('.reader-mode-content a.external-link'); link.dispatchEvent(new win.MouseEvent('contextmenu',{bubbles:true,button:2})); const linkMenu = captured;
          const span = win.document.createElement('span'); span.textContent = link.textContent; link.replaceChildren(span); span.dispatchEvent(new win.MouseEvent('contextmenu',{bubbles:true,button:2})); const nestedLink = captured;
          const range = win.document.createRange(); range.setStart(target.firstChild, 0); range.setEnd(target.firstChild, 32); win.getSelection().addRange(range); target.dispatchEvent(new win.MouseEvent('contextmenu',{bubbles:true,button:2})); const selection = captured;
          window.__readerAuditExtract = actions.find(item=>item.label === 'Extract selection to new note').click;
          window.__readerAuditSelection = win.getSelection().toString(); win.getSelection().removeAllRanges();
          return {page, link:linkMenu, nestedLink, selection};
        }
        finally { remote.Menu.buildFromTemplate = original; }
      })()`);
      assert.ok(report[name].popout.menu, name + ' reader context menu captured');
      await c.evaluate(`window.__readerAuditFilesBefore = new Set(app.vault.getFiles().map(file=>file.path))`);
      await c.evaluate(`window.__readerAuditExtract()`);
      await c.wait(`app.vault.getFiles().some(file=>!window.__readerAuditFilesBefore.has(file.path))`, 'selection extracted');
      report[name].popout.extract = await c.evaluate(`(async () => { const file = app.vault.getFiles().find(file=>!window.__readerAuditFilesBefore.has(file.path)); const result = {text:await app.vault.read(file), matchesSelection:(await app.vault.read(file)) === window.__readerAuditSelection}; for (const leaf of app.workspace.getLeavesOfType('markdown')) if (leaf.view.file?.path === file.path) leaf.detach(); await app.vault.delete(file); return result; })()`);
      await c.evaluate(`window.__readerAuditPopout.getContainer().win.close()`);
      await c.wait(`!app.workspace.getLeavesOfType('webviewer').includes(window.__readerAuditPopout)`, 'popout closed and detached');
      report[name].popout.closed = true;
      report[name].errors = c.errors;
    } finally { await c.evaluate(`(() => { window.__readerAuditLeaf?.detach(); if (window.__readerAuditPopout) { const win = window.__readerAuditPopout.getContainer().win; if (win && win !== app.workspace.rootSplit.win && !win.closed) win.close(); } if (window.__readerAuditApi) app.plugins.unloadPlugin('reader-audit'); if (typeof window.__readerAuditPluginsEnabled === 'boolean') app.plugins.setEnable(window.__readerAuditPluginsEnabled); })()`).catch(() => {}); c.socket.close(); }
  }
  await fs.writeFile(output + '/report.json', JSON.stringify(report, null, 2));
  assert.deepEqual(report.obsen, report.reference);
  assert.deepEqual(report.obsen.errors, []);
  for (const key of [...Object.keys(examples), 'toggle', 'lightbox', 'lightbox-zoom', 'gallery-large', 'gallery-wheel', 'gallery-pan', 'gallery-double', 'gallery-drag-start', 'gallery-drag']) {
    const reference = JSON.parse(await fs.readFile(output + '/reference-' + key + '.json', 'utf8'));
    const obsen = JSON.parse(await fs.readFile(output + '/obsen-' + key + '.json', 'utf8'));
    assert.deepEqual(obsen.outline, reference.outline, key + ' reader DOM matches');
    assert.deepEqual(obsen.rect, reference.rect, key + ' reader bounds match');
  }
  console.log('Reader audit passed: conversion, extraction, preserved pages, reader DOM/bounds, titles, saves and links; no renderer errors.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
