import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const reference = await fixtureClient(Number(process.env.OBSEN_PDF_SOURCE_PORT ?? process.env.OBSEN_REFERENCE_PORT ?? 9352), process.env.OBSEN_PDF_SOURCE_PORT ? 'obsen-electron-smoke-' : 'obsen-reference-audit-');
const own = await fixtureClient(Number(process.env.OBSEN_SMOKE_PORT ?? 9342), 'obsen-electron-smoke-');
try {
  await own.key('Escape'); await own.key('Escape');
  const bytes = await reference.evaluate(`app.vault.readBinary(app.vault.getFileByPath('PDF audit/Audit sample.pdf')).then(b => [...new Uint8Array(b)])`);
  await own.evaluate(`(async () => {
    if (!app.vault.getFolderByPath('PDF audit')) await app.vault.createFolder('PDF audit');
    const data = new Uint8Array(${JSON.stringify(bytes)}).buffer;
    const old = app.vault.getFileByPath('PDF audit/Audit sample.pdf');
    if (old) {
      const previous = new Uint8Array(await app.vault.readBinary(old)), next = new Uint8Array(data);
      if (previous.length !== next.length || previous.some((value, index) => value !== next[index])) await app.vault.modifyBinary(old, data);
    } else await app.vault.createBinary('PDF audit/Audit sample.pdf', data);
    await app.workspace.getLeaf().openFile(app.vault.getFileByPath('PDF audit/Audit sample.pdf'));
  })()`);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await own.evaluate(`!!document.querySelector('.pdf-viewer-container > .hiddenCopyElement') && !!document.querySelector('.pdfViewer .page[data-loaded] canvas')`)) break;
    await Promise.race([own.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined), delay(300)]);
    await delay(80);
  }
  const result = await own.evaluate(`(() => {
    const helper = document.querySelector('.pdf-viewer-container > .hiddenCopyElement');
    return { helperClass: helper?.className, helperId: helper?.id, position: helper && getComputedStyle(helper).position,
      pages: app.workspace.activeLeaf.view.viewer.child.pdfViewer.pagesCount };
  })()`);
  assert.equal(result.helperClass, 'hiddenCopyElement');
  assert.equal(result.helperId, '');
  assert.equal(result.position, 'absolute');
  assert.equal(result.pages, 5);
  await own.wait(`app.workspace.activeLeaf.view.viewer.child.pdfViewer.isInitialViewSet`, 'initial PDF scale');
  await own.evaluate(`app.workspace.activeLeaf.view.viewer.child.pdfViewer.pdfViewer.currentScaleValue = 'page-height'`);
  result.fitHeight = await own.evaluate(`Math.round(app.workspace.activeLeaf.view.viewer.child.pdfViewer.pdfViewer.currentScale * 10000) / 10000`);
  assert.equal(result.fitHeight, 0.7263, 'fit-height scale matches the pinned paired reference at the fixture viewport');
  await own.evaluate(`app.workspace.activeLeaf.view.setEphemeralState({ subpath: '#page=3' })`);
  await own.wait(`app.workspace.activeLeaf.view.viewer.child.pdfViewer.page === 3 && Math.round(document.querySelector('.workspace-leaf.mod-active .page[data-page-number="3"]').getBoundingClientRect().top - document.querySelector('.workspace-leaf.mod-active .pdf-viewer-container').getBoundingClientRect().top) === 0`, 'page link aligns to outer page edge');
  result.pageLinkTop = 0;
  await own.evaluate(`app.workspace.activeLeaf.view.setEphemeralState({ subpath: '#page=2&selection=4,4,4,13' })`);
  const selectionDeadline = Date.now() + 20000;
  while (Date.now() < selectionDeadline) {
    if (await own.evaluate(`!!document.querySelector('.workspace-leaf.mod-active .page[data-page-number="2"] .textLayer .mod-focused')`)) break;
    await Promise.race([own.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined), delay(300)]);
    await delay(80);
  }
  result.selection = await own.evaluate(`(() => {
    const root = document.querySelector('.workspace-leaf.mod-active');
    return { text: root.querySelector('.textLayer .mod-focused')?.textContent, top: Math.round(root.querySelector('.page[data-page-number="2"]').getBoundingClientRect().top - root.querySelector('.pdf-viewer-container').getBoundingClientRect().top) };
  })()`);
  assert.deepEqual(result.selection, { text: 'dy asked ', top: -190 }, 'selection text and scroll position match the pinned reference');
  await own.evaluate(`(() => { window.__pdfMenuCalls = 0; window.__pdfMenuRef = app.workspace.on('file-menu', () => window.__pdfMenuCalls++); document.querySelector('.workspace-leaf.mod-active .view-actions [aria-label="More options"]').click(); })()`);
  result.popoutMenuAction = await own.evaluate(`(() => {
    const item = [...document.querySelectorAll('.menu .menu-item')].find(e => e.querySelector('.menu-item-title')?.textContent === 'Open in new window');
    return item?.querySelector('svg')?.getAttribute('class') ?? null;
  })()`);
  assert.match(result.popoutMenuAction ?? '', /lucide-picture-in-picture-2/);
  result.paneMenuTitles = await own.evaluate(`[...document.querySelectorAll('.menu .menu-item-title')].map(e => e.textContent)`);
  for (const title of ['Open in new window', 'Rename...', 'Move file to...', 'Bookmark...', 'Copy path', 'Open in default app', 'Show in system explorer', 'Reveal file in navigation']) {
    assert.equal(result.paneMenuTitles.filter(value => value === title).length, 1, 'pane action occurs once: ' + title);
  }
  assert.equal(await own.evaluate(`window.__pdfMenuCalls`), 1, 'pane file-menu callback fires once');
  assert.ok(result.paneMenuTitles.indexOf('Copy path') < result.paneMenuTitles.indexOf('Open version history'), 'pane info precedes view actions');
  assert.ok(result.paneMenuTitles.indexOf('Open in default app') < result.paneMenuTitles.indexOf('Show in system explorer'));
  assert.ok(result.paneMenuTitles.indexOf('Show in system explorer') < result.paneMenuTitles.indexOf('Reveal file in navigation'));
  const copyPoint = await own.evaluate(`(() => { const e = [...document.querySelectorAll('.menu .menu-item')].find(e => e.querySelector('.menu-item-title')?.textContent === 'Copy path'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await own.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...copyPoint });
  await own.wait(`document.querySelectorAll('.menu').length === 2`, 'section-derived copy submenu');
  result.copySubmenuTitles = await own.evaluate(`[...[...document.querySelectorAll('.menu')].at(-1).querySelectorAll('.menu-item-title')].map(e => e.textContent)`);
  assert.match(result.copySubmenuTitles[0], /^as .+ URL$/);
  assert.deepEqual(result.copySubmenuTitles.slice(1), ['from vault folder', 'from system root']);
  assert.equal(await own.evaluate(`[...document.querySelectorAll('.menu')][0].querySelector('.menu-item[data-section="info.copy"]') === null`), true, 'generated parent is not a contributed action');
  await own.evaluate(`app.workspace.offref(window.__pdfMenuRef)`);
  await own.key('Escape'); await own.key('Escape');
  await own.evaluate(`(async () => {
    const active = app.workspace.activeLeaf.view;
    active.setEphemeralState({ subpath: '#page=2' });
    window.__pdfDetachedContainer = document.createElement('div');
    window.__pdfDetachedContainer.style.cssText = 'position:absolute; width:700px; height:600px; top:0; left:0';
    window.__pdfDetachedChild = new active.viewer.child.constructor(app, window.__pdfDetachedContainer, { isEmbed: true });
    await window.__pdfDetachedChild.load();
    await window.__pdfDetachedChild.loadFile(app.vault.getFileByPath('PDF audit/Audit sample.pdf'));
  })()`);
  assert.deepEqual(await own.evaluate(`app.workspace.activeLeaf.view.getEphemeralState()`), {});
  assert.equal(await own.evaluate(`window.__pdfDetachedChild.pdfViewer.pdfDocument === null`), true, 'detached PDF waits for insertion');
  await own.evaluate(`window.__pdfDetachedChild.applySubpath('#page=3&selection=2,0,2,5')`);
  const pendingDestination = await own.evaluate(`window.__pdfDetachedChild.pdfViewer.subpath`);
  await own.evaluate(`document.body.append(window.__pdfDetachedContainer)`);
  await own.wait(`window.__pdfDetachedChild.pdfViewer.pagesCount === 5`, 'inserted PDF loaded');
  assert.equal(await own.evaluate(`window.__pdfDetachedChild.pdfViewer.subpath`), pendingDestination, 'insertion preserves queued link destination');
  assert.equal(await own.evaluate(`window.__pdfDetachedChild.subpathHighlight?.page`), 3, 'insertion preserves queued selection highlight');
  result.detachedInsertion = true;
  await own.evaluate(`(() => { window.__pdfDetachedChild.unload(); window.__pdfDetachedContainer.remove(); delete window.__pdfDetachedChild; delete window.__pdfDetachedContainer; })()`);
  await own.evaluate(`(async () => {
    const name = 'PDF audit/Initialization embeds.md';
    const text = ${JSON.stringify('![[Audit sample.pdf#page=3]]\n\n![[PDF audit/Audit sample.pdf]]')};
    let note = app.vault.getFileByPath(name);
    if (note) await app.vault.modify(note, text); else note = await app.vault.create(name, text);
    await app.workspace.getLeaf().openFile(note);
    const view = app.workspace.activeLeaf.view;
    await view.setState({ ...view.getState(), mode: 'preview' }, { history: false });
  })()`);
  await own.wait(`document.querySelectorAll('.workspace-leaf.mod-active .markdown-reading-view .pdf-embed').length === 2`, 'PDF embed markup');
  result.embedMarkup = await own.evaluate(`[...document.querySelectorAll('.workspace-leaf.mod-active .markdown-reading-view .pdf-embed')].map(e => ({ tag: e.tagName, cls: e.className, src: e.getAttribute('src'), alt: e.getAttribute('alt') }))`);
  assert.deepEqual(result.embedMarkup, [
    { tag: 'SPAN', cls: 'internal-embed pdf-embed is-loaded', src: 'Audit sample.pdf#page=3', alt: 'Audit sample.pdf > page=3' },
    { tag: 'SPAN', cls: 'internal-embed pdf-embed is-loaded', src: 'PDF audit/Audit sample.pdf', alt: 'PDF audit/Audit sample.pdf' },
  ]);
  await own.wait(`!!document.querySelector('.workspace-leaf.mod-active .pdf-embed .pdf-toolbar-right .clickable-icon')`, 'PDF embed menu button');
  await own.evaluate(`(() => { window.__pdfMenuCalls = 0; window.__pdfMenuRef = app.workspace.on('file-menu', () => window.__pdfMenuCalls++); document.querySelector('.workspace-leaf.mod-active .pdf-embed .pdf-toolbar-right .clickable-icon').click(); })()`);
  result.embedMenuTitles = await own.evaluate(`[...document.querySelectorAll('.menu .menu-item-title')].map(e => e.textContent)`);
  for (const title of ['Open in new tab', 'Open to the right', 'Open in new window', 'Rename...', 'Move file to...', 'Bookmark...', 'Copy path', 'Open in default app', 'Show in system explorer', 'Reveal file in navigation']) {
    assert.equal(result.embedMenuTitles.filter(value => value === title).length, 1, 'embed action occurs once: ' + title);
  }
  assert.equal(await own.evaluate(`window.__pdfMenuCalls`), 1, 'embed file-menu callback fires once');
  await own.evaluate(`app.workspace.offref(window.__pdfMenuRef)`);
  await own.key('Escape');
  assert.deepEqual(own.errors, []);
  await fs.writeFile('dist/todo-backup/pdf-initialization-report.json', JSON.stringify(result, null, 2));
  console.log('PDF asynchronous copy-helper initialization passed:', JSON.stringify(result));
} finally {
  await own.evaluate(`(() => {
    window.__pdfDetachedChild?.unload(); window.__pdfDetachedContainer?.remove();
    if (window.__pdfMenuRef) app.workspace.offref(window.__pdfMenuRef);
    delete window.__pdfDetachedChild; delete window.__pdfDetachedContainer;
  })()`).catch(() => undefined);
  await own.key('Escape').catch(() => undefined); await own.key('Escape').catch(() => undefined);
  reference.socket.close(); own.socket.close();
}
