// Compare the PDF view, PDF links and PDF embeds in the two running offscreen fixture vaults
// (see README.md in this folder for how they are started). Defaults: reference on 9358, re-creation on 9348.
//
//   node scripts/dev/pdf-audit.mjs [output directory] [--only=reference|obsen]
//
// Both vaults get the same generated five-page PDF (real text, a nested outline, one highlight annotation)
// and a note that links to it and embeds it. Results go to <output>/audit-report.json, differences to
// <output>/differences.json, and captures to <output>/{reference,obsen}-<surface>.png for
// `python scripts/dev/compare-capture-pixels.py <output>`.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const args = process.argv.slice(2), only = args.find(a => a.startsWith('--only='))?.slice(7);
const output = args.find(a => !a.startsWith('--')) ?? 'dist/todo-backup/pdf-comparison';
const referencePort = Number(process.env.OBSEN_REFERENCE_PORT ?? 9358), ownPort = Number(process.env.OBSEN_SMOKE_PORT ?? 9348);
if ([referencePort, ownPort].includes(9229)) throw new Error('Port 9229 is the owner\'s own app.');
await fs.mkdir(output, { recursive: true });

/** Deterministic five-page PDF: Helvetica text, three chapters with two nested sections, a highlight with a note on page 2. */
export function makePdf() {
  const pages = [
    ['Chapter One: Arrival', 'The harbour town woke slowly under a pale morning sky.', 'Fishing boats returned with the tide, and gulls followed them in.', 'A traveller stepped onto the quay carrying a single case.'],
    ['Section 1.1: The Market', 'Stalls lined the narrow street from the quay to the square.', 'The traveller bought bread, an apple and a folded paper map.', 'Nobody asked where the traveller had come from.'],
    ['Chapter Two: The Road', 'Beyond the last house the road climbed between stone walls.', 'The map showed a river, a bridge and a mill beside the bridge.', 'By noon the harbour was only a bright line behind the hills.'],
    ['Section 2.1: The Bridge', 'The river ran clear and quick under three low arches.', 'A miller waved from the door and offered water from the well.', 'The traveller rested there and studied the map again.'],
    ['Chapter Three: Evening', 'The road ended at a farm where lamps were already lit.', 'Supper was soup and bread, and the talk was of the harvest.', 'The traveller slept soundly and dreamed of the harbour and the river.'],
  ];
  const objects = [], add = body => { objects.push(body); return objects.length; };
  const catalog = add(''), pagesId = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  pages.forEach((lines, index) => {
    let stream = 'BT\n/F2 22 Tf\n72 700 Td\n(' + lines[0] + ') Tj\n/F1 12 Tf\n';
    lines.slice(1).forEach((line, i) => { stream += `0 -${i === 0 ? 40 : 22} Td\n(${line}) Tj\n`; });
    stream += `0 -420 Td\n(Page ${index + 1} of ${pages.length}) Tj\nET\n`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    let annots = '';
    if (index === 1) annots = ` /Annots [${add('<< /Type /Annot /Subtype /Highlight /Rect [72 634 420 650] /QuadPoints [72 650 420 650 72 634 420 634] /C [1 0.82 0] /Contents (Remember the map) /T (Auditor) /M (D:20240102030405Z) /F 4 >>')} 0 R]`;
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R${annots} >>`));
  });
  const outlines = add('');
  const tree = [{ title: pages[0][0], page: 0, kids: [{ title: pages[1][0], page: 1 }] }, { title: pages[2][0], page: 2, kids: [{ title: pages[3][0], page: 3 }] }, { title: pages[4][0], page: 4, kids: [] }];
  const ids = tree.map(node => ({ id: add(''), kids: node.kids.map(() => add('')) }));
  tree.forEach((node, i) => {
    const me = ids[i];
    node.kids.forEach((kid, k) => { objects[me.kids[k] - 1] = `<< /Title (${kid.title}) /Parent ${me.id} 0 R /Dest [${pageIds[kid.page]} 0 R /XYZ 0 792 null] >>`; });
    objects[me.id - 1] = `<< /Title (${node.title}) /Parent ${outlines} 0 R /Dest [${pageIds[node.page]} 0 R /XYZ 0 792 null]` + (i > 0 ? ` /Prev ${ids[i - 1].id} 0 R` : '') + (i < tree.length - 1 ? ` /Next ${ids[i + 1].id} 0 R` : '') + (me.kids.length ? ` /First ${me.kids[0]} 0 R /Last ${me.kids[me.kids.length - 1]} 0 R /Count -${me.kids.length}` : '') + ' >>';
  });
  objects[outlines - 1] = `<< /Type /Outlines /First ${ids[0].id} 0 R /Last ${ids[ids.length - 1].id} 0 R /Count ${tree.length} >>`;
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlines} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /ID [<4f6273656e5044464175646974303031> <4f6273656e5044464175646974303031>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PDF = 'PDF audit/Audit sample.pdf', NOTE = 'PDF audit/PDF note.md';
const noteText = 'Before the embeds.\n\n![[Audit sample.pdf]]\n\nBetween.\n\n![[Audit sample.pdf#page=3]]\n\n![[Audit sample.pdf#page=2&height=300]]\n\nA link: [[Audit sample.pdf#page=3]]\n';
const pdfBase64 = makePdf().toString('base64');

// Attribute insertion order is not DOM structure. Preserve all text, nesting
// and non-style attributes; selection geometry is measured separately below.
function selectionDom(element) {
  return {
    tag: element.tagName,
    attributes: Object.fromEntries([...element.attributes].filter(a => a.name !== 'style').map(a => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b))),
    children: [...element.childNodes].map(node => node.nodeType === 1 ? selectionDom(node) : { type: node.nodeType, text: node.textContent }),
  };
}

// The viewer application of the active PDF tab; both apps expose it under the same names.
const APP = '(window.app??window.__obsenSmokeApp)';
const V = `${APP}.workspace.activeLeaf.view.viewer.child.pdfViewer`;
const LEAF = `${APP}.workspace.activeLeaf.view.containerEl.closest('.workspace-leaf')`;
// The reference's resource URLs (app://<id>/…) are cross-origin for fetch under the fixture's Electron and fail
// there, so its pdf.js is handed the file's bytes instead. Viewer behavior is unaffected; only the transport differs.
const shim = `(() => {
  if (window.__pdfAuditShim) return;
  const patch = lib => {
    const original = lib.getDocument, fs = require('fs');
    lib.getDocument = function (src) {
      if (src && typeof src.url === 'string' && src.url.startsWith('app://') && !src.url.startsWith('app://obsidian.md/')) {
        const { url, ...rest } = src;
        return original.call(this, { ...rest, data: new Uint8Array(fs.readFileSync(decodeURIComponent(new URL(url).pathname.slice(1)))) });
      }
      return original.call(this, src);
    };
  };
  window.__pdfAuditShim = true;
  if (globalThis.pdfjsLib) { patch(globalThis.pdfjsLib); return; }
  Object.defineProperty(globalThis, 'pdfjsLib', { configurable: true, enumerable: true, get() { return undefined; }, set(lib) { Object.defineProperty(globalThis, 'pdfjsLib', { configurable: true, enumerable: true, writable: true, value: lib }); patch(lib); } });
})()`;

const controls = (root, base = 'document') => `[...${base}.querySelectorAll(${JSON.stringify(root)})].flatMap(side => [...side.children].map(e => ({ side: side.className, tag: e.tagName.toLowerCase(), cls: e.className.replace(/\\b(is-active|mod-page-loading|mod-disabled|has-active-menu)\\b/g, '').replace(/\\s+/g, ' ').trim(), label: e.getAttribute('aria-label'), icon: e.querySelector('svg')?.getAttribute('class')?.replace('svg-icon ', '') ?? null, text: e.children.length ? null : e.textContent, type: e.getAttribute('type'), max: e.getAttribute('max') })))`;
const menuItems = `[...document.querySelectorAll('.menu')].at(-1) ? [...[...document.querySelectorAll('.menu')].at(-1).querySelector('.menu-scroll').children].map(g => g.classList.contains('menu-separator') ? '---' : [...g.querySelectorAll('.menu-item')].map(e => ({ section: e.dataset.section ?? null, title: e.querySelector('.menu-item-title')?.textContent, icon: e.querySelector('.menu-item-icon svg')?.getAttribute('class')?.replace('svg-icon ', '') ?? null, checked: e.classList.contains('mod-checked'), disabled: e.classList.contains('is-disabled') }))) : null`;
const outlineTree = `(function walk(root) { return [...root.children].filter(e => e.classList.contains('tree-item')).map(e => ({ cls: e.className, self: e.querySelector(':scope > .tree-item-self').className, hasIcon: !!e.querySelector(':scope > .tree-item-self > .collapse-icon'), title: e.querySelector(':scope > .tree-item-self > .tree-item-inner')?.textContent, flair: e.querySelector(':scope > .tree-item-self .tree-item-flair')?.textContent ?? null, children: e.querySelector(':scope > .tree-item-children') ? walk(e.querySelector(':scope > .tree-item-children')) : null })); })(document.querySelector('.workspace-leaf.mod-active .pdf-outline-view'))`;

const report = {};
const clients = [];
if (only !== 'obsen') clients.push(['reference', await fixtureClient(referencePort, 'obsen-reference-audit-', { separateHistoricalErrors: true })]);
if (only !== 'reference') clients.push(['obsen', await fixtureClient(ownPort, 'obsen-electron-smoke-', { separateHistoricalErrors: true })]);

try {
  for (const [name, c] of clients) {
    console.log(`Preparing ${name} PDF fixture`);
    const result = report[name] = { historicalErrors: c.historicalErrors };
    // An offscreen window only runs animation frames while frames are requested; pdf.js draws pages in them.
    const warm = () => Promise.race([c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 } }).catch(() => undefined), delay(700)]);
    const settle = async ms => { const end = Date.now() + ms; do { await warm(); await delay(60); } while (Date.now() < end); };
    const until = async (expression, label, timeout = 20000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { try { if (await c.evaluate(expression)) return true; } catch { /* The page may be reloading. */ } await warm(); await delay(80); }
      throw new Error(`Timed out on ${name}: ${label}`);
    };
    const capture = async (scenario, selector) => { await settle(350); try { result[scenario + ':rect'] = await c.capture(output, `${name}-${scenario}`, selector); } catch (error) { result[scenario + ':rect'] = `capture failed: ${error.message}`; } };
    const section = async (title, run) => { try { await run(); } catch (error) { result[`${title}:error`] = error.message.split('\n')[0]; console.log(`  ${name} ${title}: ${error.message.split('\n')[0]}`); } };
    const closeMenus = async () => { for (let i = 0; i < 3 && await c.evaluate(`!!document.querySelector('.menu')`); i++) { await c.key('Escape'); await delay(120); } };
    const center = selector => c.evaluate(`(() => { const e = typeof (${selector}) === 'string' ? document.querySelector(${selector}) : (${selector}); if (!e) throw new Error('Missing element'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const mouse = async (point, button = 'left') => {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 });
    };
    const clickEl = async expression => { await mouse(await center(expression)); };
    const menuClick = async title => { await c.evaluate(`(() => { const item = [...document.querySelectorAll('.menu .menu-item')].find(e => e.querySelector('.menu-item-title')?.textContent === ${JSON.stringify(title)}); if (!item) throw new Error('Missing menu item ' + ${JSON.stringify(title)}); item.click(); })()`); await settle(250); };
    const toolbarIcon = label => `[...${LEAF}.querySelectorAll('.pdf-toolbar .clickable-icon')].find(e => e.getAttribute('aria-label') === ${JSON.stringify(label)})`;
    const scaleInfo = `({ scale: Math.round(${V}.pdfViewer.currentScale * 10000) / 10000, value: ${V}.pdfViewer.currentScaleValue, page: ${V}.page })`;
    const clip = `(window.__pdfAuditClip ?? null)`;
    const enter = async (modifiers = 0) => { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers }); };

    await c.send('Page.enable');
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.key('Escape');
    // Start from no PDF tabs, so the reference's pdf.js can be given the data shim before it loads.
    await c.evaluate(`(async () => { for (const leaf of ${APP}.workspace.getLeavesOfType('pdf')) leaf.detach(); for (const leaf of ${APP}.workspace.getLeavesOfType('markdown')) if (leaf.view.file?.path === ${JSON.stringify(NOTE)}) leaf.detach(); })()`);
    if (name === 'reference') {
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });
      if (await c.evaluate(`!!window.pdfjsViewer && !window.__pdfAuditShim`)) {
        // pdf.js was loaded by an earlier session without the shim: start the page again once the layout is saved.
        await delay(3000);
        await c.send('Page.reload');
        await delay(1500);
        await c.wait(`!!${APP}.workspace?.layoutReady`, 'reference reload');
        await delay(1500);
      } else await c.evaluate(shim);
    }
    await c.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pdfBase64)}), ch => ch.charCodeAt(0)).buffer;
      if (!${APP}.vault.getFolderByPath('PDF audit')) await ${APP}.vault.createFolder('PDF audit');
      const pdf = ${APP}.vault.getFileByPath(${JSON.stringify(PDF)});
      if (pdf) await ${APP}.vault.modifyBinary(pdf, bytes); else await ${APP}.vault.createBinary(${JSON.stringify(PDF)}, bytes);
      const note = ${APP}.vault.getFileByPath(${JSON.stringify(NOTE)});
      if (note) await ${APP}.vault.modify(note, ${JSON.stringify(noteText)}); else await ${APP}.vault.create(${JSON.stringify(NOTE)}, ${JSON.stringify(noteText)});
      // The same starting preferences in both apps: no remembered position, sidebar closed, default find options, no theme adaption.
      for (const key of ['pdfjs.history', 'pdfjs.sidebarView', 'pdfjs.sidebarWidth']) localStorage.removeItem(key);
      ${APP}.saveLocalStorage('pdfjs-is-themed', null); ${APP}.saveLocalStorage('pdfjs-search-settings', null);
      navigator.clipboard.writeText = async text => { window.__pdfAuditClip = text; };
      if (!${APP}.workspace.rightSplit.collapsed) ${APP}.commands.executeCommandById('app:toggle-right-sidebar');
      if (${APP}.workspace.leftSplit.collapsed) ${APP}.commands.executeCommandById('app:toggle-left-sidebar');
    })()`);
    await settle(1500);
    await c.evaluate(`window.__pdfAuditSelectionDom = ${selectionDom.toString()}`);

    await section('open', async () => {
      await c.evaluate(`${APP}.workspace.getLeaf().openFile(${APP}.vault.getFileByPath(${JSON.stringify(PDF)}))`);
      await until(`${APP}.workspace.activeLeaf?.view?.getViewType?.() === 'pdf' && !!${LEAF}.querySelector('.pdfViewer .page[data-loaded] canvas') && ${V}.pagesCount > 0 && ${V}.isInitialViewSet`, 'PDF opened');
      await until(`${LEAF}.querySelectorAll('.pdf-outline-view .tree-item').length > 0`, 'outline loaded');
      await settle(800);
      result.viewType = await c.evaluate(`${APP}.workspace.activeLeaf.view.getViewType()`);
      result.viewIcon = await c.evaluate(`${APP}.workspace.activeLeaf.view.getIcon()`);
      result.displayText = await c.evaluate(`${APP}.workspace.activeLeaf.view.getDisplayText()`);
      result.toolbar = await c.evaluate(controls('.workspace-leaf.mod-active .pdf-toolbar:not(.pdf-findbar) > div'));
      result.pageCount = await c.evaluate(`({ label: ${LEAF}.querySelector('.pdf-page-numbers').textContent, input: ${LEAF}.querySelector('.pdf-page-input').value, pages: ${V}.pagesCount, pageEls: ${LEAF}.querySelectorAll('.pdfViewer .page').length })`);
      result.initial = await c.evaluate(scaleInfo);
      result.structure = await c.evaluate(`(() => { const root = ${LEAF}.querySelector('.view-content'); const walk = (e, d) => ({ tag: e.tagName.toLowerCase(), cls: e.className.replace(/\\b(node-insert-event|mod-page-loading)\\b/g, '').replace(/\\s+/g, ' ').trim(), ...(d < 4 && !e.matches('.pdfViewer, .pdf-thumbnail-view, .pdf-outline-view, .pdf-toolbar-left, .pdf-search-wrapper') ? { children: [...e.children].map(x => walk(x, d + 1)) } : {}) }); return walk(root, 0); })()`);
      result.firstPage = await c.evaluate(`(() => { const p = ${LEAF}.querySelector('.pdfViewer .page'); const canvas = p.querySelector('canvas'); const r = p.getBoundingClientRect(); return { children: [...p.children].map(e => e.tagName.toLowerCase() + '.' + e.className.replace(/\\s+/g, '.')), canvas: [canvas.width, canvas.height], rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], spans: [...p.querySelectorAll('.textLayer > span')].map(s => s.className + '|' + (s.dataset.idx ?? '') + '|' + s.textContent), viewerClass: ${LEAF}.querySelector('.pdfViewer').className, scaleFactor: ${LEAF}.querySelector('.pdfViewer').style.getPropertyValue('--scale-factor') }; })()`);
      await capture('view', '.workspace-leaf.mod-active .view-content');
      await capture('toolbar', '.workspace-leaf.mod-active .pdf-toolbar:not(.pdf-findbar)');
      await capture('page', '.workspace-leaf.mod-active .pdf-viewer-container');
    });

    await section('navigation', async () => {
      const nav = result.navigation = {};
      const page = `({ page: ${V}.page, input: ${LEAF}.querySelector('.pdf-page-input').value })`;
      await c.evaluate(`${V}.eventBus.dispatch('nextpage', {})`); await settle(400); nav.next1 = await c.evaluate(page);
      await c.evaluate(`${V}.eventBus.dispatch('nextpage', {})`); await settle(400); nav.next2 = await c.evaluate(page);
      await c.evaluate(`${V}.eventBus.dispatch('previouspage', {})`); await settle(400); nav.previous = await c.evaluate(page);
      // Typing a page number into the toolbar field.
      await clickEl(`${LEAF}.querySelector('.pdf-page-input')`); await delay(150);
      nav.selectedOnClick = await c.evaluate(`(() => { const e = document.activeElement; return e?.className === 'pdf-page-input' ? String(getSelection()) || 'focused' : 'not focused'; })()`);
      await c.send('Input.insertText', { text: '4' }); await c.evaluate(`document.activeElement.blur()`); await settle(500);
      nav.typed4 = await c.evaluate(page);
      const errorCountBeforeInvalidPage = c.errors.length;
      await c.evaluate(`(() => { const e = ${LEAF}.querySelector('.pdf-page-input'); e.value = '99'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`); await settle(400);
      nav.invalidPageDiagnostic = c.errors.slice(errorCountBeforeInvalidPage);
      assert.deepEqual(nav.invalidPageDiagnostic, ['PDFLinkService.goToPage: "99" is not a valid page.'], 'invalid page emits only the expected diagnostic');
      c.errors.splice(errorCountBeforeInvalidPage, 1);
      nav.typedOutOfRange = await c.evaluate(page);
      await c.evaluate(`(() => { const e = ${LEAF}.querySelector('.pdf-page-input'); e.value = '1'; e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); ${LEAF}.querySelector('.pdf-viewer-container').focus(); })()`); await settle(400);
      nav.typed1 = await c.evaluate(page);
      // Arrow keys turn pages while the zoom is "fit width" or "fit height".
      await mouse(await center(`${LEAF}.querySelector('.pdf-viewer-container')`)); await delay(150);
      await c.key('ArrowRight'); await settle(400); nav.arrowRight = await c.evaluate(page);
      await c.key('ArrowLeft'); await settle(400); nav.arrowLeft = await c.evaluate(page);
    });

    await section('zoom', async () => {
      const zoom = result.zoom = {};
      zoom.start = await c.evaluate(scaleInfo);
      await clickEl(toolbarIcon('Zoom in')); await settle(700); zoom.in1 = await c.evaluate(scaleInfo);
      await clickEl(toolbarIcon('Zoom in')); await settle(700); zoom.in2 = await c.evaluate(scaleInfo);
      for (const step of ['out1', 'out2', 'out3']) { await clickEl(toolbarIcon('Zoom out')); await settle(700); zoom[step] = await c.evaluate(scaleInfo); }
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      result.displayMenuAfterZoom = await c.evaluate(menuItems);
      await menuClick('Fit height'); await settle(700); zoom.fitHeight = await c.evaluate(scaleInfo);
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      result.displayMenuFitHeight = await c.evaluate(menuItems);
      await capture('display-menu-fit-height', '.menu');
      await menuClick('Fit width'); await settle(700); zoom.fitWidth = await c.evaluate(scaleInfo);
    });

    await section('display', async () => {
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      result.displayMenu = await c.evaluate(menuItems);
      result.displayMenuPlacement = await c.evaluate(`(() => { const m = document.querySelector('.menu').getBoundingClientRect(), b = (${toolbarIcon('Display options')}).getBoundingClientRect(); return { dx: Math.round(m.x - b.x), dy: Math.round(m.y - b.bottom), active: (${toolbarIcon('Display options')}).classList.contains('has-active-menu') }; })()`);
      await capture('display-menu', '.menu');
      const spread = result.spread = {};
      const info = `({ mode: ${V}.pdfViewer.spreadMode, cls: ${LEAF}.querySelector('.pdfViewer').className, spreads: [...${LEAF}.querySelectorAll('.pdfViewer > .spread')].map(s => s.children.length), scale: Math.round(${V}.pdfViewer.currentScale * 10000) / 10000 })`;
      await menuClick('Two-page (odd)'); await settle(900); spread.odd = await c.evaluate(info);
      await capture('spread-odd', '.workspace-leaf.mod-active .pdf-viewer-container');
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      result.displayMenuOdd = await c.evaluate(menuItems);
      await menuClick('Two-page (even)'); await settle(900); spread.even = await c.evaluate(info);
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      await menuClick('Single page'); await settle(900); spread.single = await c.evaluate(info);
      // Adapt to theme: on, then off again.
      const themed = `({ themed: ${LEAF}.querySelector('.pdf-container').classList.contains('mod-themed'), stored: ${APP}.loadLocalStorage('pdfjs-is-themed') })`;
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      await menuClick('Adapt to theme'); await settle(1200);
      result.themedOn = await c.evaluate(themed);
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      result.displayMenuThemed = await c.evaluate(menuItems);
      await capture('themed', '.workspace-leaf.mod-active .pdf-viewer-container');
      await closeMenus();
      await clickEl(toolbarIcon('Display options')); await until(`!!document.querySelector('.menu')`, 'display menu');
      await menuClick('Adapt to theme'); await settle(1200);
      result.themedOff = await c.evaluate(themed);
    });

    await section('sidebar', async () => {
      const sidebar = result.sidebar = {};
      const info = `({ content: ${LEAF}.querySelector('.pdf-content-container').className.replace(/\\b(node-insert-event|sidebarMoving)\\b/g, '').replace(/\\s+/g, ' ').trim(), view: ${LEAF}.querySelector('.pdf-sidebar-container').getAttribute('data-view'), toggleActive: (${toolbarIcon('Toggle sidebar')}).classList.contains('is-active'), thumbsHidden: ${LEAF}.querySelector('.pdf-thumbnail-view').classList.contains('hidden'), outlineHidden: ${LEAF}.querySelector('.pdf-outline-view').classList.contains('hidden'), width: Math.round(${LEAF}.querySelector('.pdf-sidebar-container').getBoundingClientRect().width), viewerLeft: Math.round(${LEAF}.querySelector('.pdf-viewer-container').getBoundingClientRect().x - ${LEAF}.querySelector('.pdf-content-container').getBoundingClientRect().x), stored: localStorage.getItem('pdfjs.sidebarView') })`;
      sidebar.closed = await c.evaluate(info);
      await clickEl(toolbarIcon('Toggle sidebar')); await settle(900);
      await until(`${LEAF}.querySelectorAll('.pdf-thumbnail-view .thumbnail[data-loaded]').length >= 5`, 'thumbnails drawn');
      sidebar.thumbnails = await c.evaluate(info);
      sidebar.thumbnailDom = await c.evaluate(`[...${LEAF}.querySelectorAll('.pdf-thumbnail-view > a')].map(a => ({ href: a.getAttribute('href'), l10n: a.getAttribute('data-l10n-id'), args: a.getAttribute('data-l10n-args'), thumb: a.firstElementChild.className, page: a.firstElementChild.dataset.pageNumber, label: a.firstElementChild.dataset.pageLabel, style: a.firstElementChild.getAttribute('style'), loaded: a.firstElementChild.dataset.loaded ?? null, child: [...a.firstElementChild.children].map(e => e.tagName.toLowerCase() + '.' + e.className + '|' + e.getAttribute('data-l10n-id') + '|' + e.getAttribute('data-l10n-args')), size: (r => [Math.round(r.width), Math.round(r.height)])(a.firstElementChild.getBoundingClientRect()) }))`);
      await capture('sidebar-thumbnails', '.workspace-leaf.mod-active .pdf-sidebar-container');
      await capture('view-thumbnails', '.workspace-leaf.mod-active .view-content');
      // Clicking a thumbnail goes to its page and selects it.
      await clickEl(`${LEAF}.querySelectorAll('.pdf-thumbnail-view .thumbnail')[2]`); await settle(600);
      sidebar.thumbnailClick = await c.evaluate(`({ page: ${V}.page, selected: [...${LEAF}.querySelectorAll('.pdf-thumbnail-view .thumbnail.selected')].map(e => e.dataset.pageNumber) })`);
      await clickEl(toolbarIcon('Sidebar options')); await until(`!!document.querySelector('.menu')`, 'sidebar menu');
      result.sidebarMenuThumbnails = await c.evaluate(menuItems);
      await capture('sidebar-menu', '.menu');
      await menuClick('Table of contents'); await settle(900);
      sidebar.outline = await c.evaluate(info);
      sidebar.outlineTree = await c.evaluate(outlineTree);
      await capture('sidebar-outline', '.workspace-leaf.mod-active .pdf-sidebar-container');
      await clickEl(toolbarIcon('Sidebar options')); await until(`!!document.querySelector('.menu')`, 'sidebar menu');
      result.sidebarMenuOutline = await c.evaluate(menuItems);
      await closeMenus();
      // Expand the first chapter, then follow an entry.
      await clickEl(`${LEAF}.querySelector('.pdf-outline-view .tree-item .collapse-icon')`); await settle(500);
      sidebar.outlineExpanded = await c.evaluate(outlineTree);
      await clickEl(`[...${LEAF}.querySelectorAll('.pdf-outline-view .tree-item-inner')].find(e => e.textContent === 'Section 1.1: The Market')`); await settle(700);
      sidebar.outlineClick = await c.evaluate(`({ page: ${V}.page, active: [...${LEAF}.querySelectorAll('.pdf-outline-view .tree-item-self.mod-active')].map(e => e.querySelector('.tree-item-inner').textContent) })`);
      await capture('sidebar-outline-expanded', '.workspace-leaf.mod-active .pdf-sidebar-container');
      // "Reveal page in table of contents" marks the entry of the current page.
      await c.evaluate(`${V}.page = 4`); await settle(500);
      await clickEl(toolbarIcon('Sidebar options')); await until(`!!document.querySelector('.menu')`, 'sidebar menu');
      await menuClick('Reveal page in table of contents'); await settle(700);
      sidebar.reveal = await c.evaluate(`({ page: ${V}.page, active: [...${LEAF}.querySelectorAll('.pdf-outline-view .tree-item-self.mod-active')].map(e => e.querySelector('.tree-item-inner').textContent), tree: ${outlineTree}.map(e => e.cls) })`);
      // The outline entry's context menu copies a link to the section.
      await c.evaluate(`(() => { const e = [...${LEAF}.querySelectorAll('.pdf-outline-view .tree-item-self')].find(x => x.querySelector('.tree-item-inner').textContent === 'Chapter Two: The Road'); const r = e.getBoundingClientRect(); window.__pdfAuditClip = null; e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: r.x + 20, clientY: r.y + 5, button: 2 })); })()`);
      await until(`!!document.querySelector('.menu')`, 'outline context menu');
      result.outlineContextMenu = await c.evaluate(menuItems);
      await c.evaluate(`document.querySelector('.menu .menu-item').click()`); await delay(250);
      result.outlineLink = await c.evaluate(clip);
      // The thumbnail's context menu copies a link to the page.
      await clickEl(toolbarIcon('Sidebar options')); await until(`!!document.querySelector('.menu')`, 'sidebar menu');
      await menuClick('Thumbnails'); await settle(900);
      sidebar.backToThumbnails = await c.evaluate(info);
      await c.evaluate(`(() => { const e = ${LEAF}.querySelectorAll('.pdf-thumbnail-view .thumbnail')[1]; const r = e.getBoundingClientRect(); window.__pdfAuditClip = null; e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: r.x + 20, clientY: r.y + 20, button: 2 })); })()`);
      await until(`!!document.querySelector('.menu')`, 'thumbnail context menu');
      result.thumbnailContextMenu = await c.evaluate(menuItems);
      await c.evaluate(`document.querySelector('.menu .menu-item').click()`); await delay(250);
      result.thumbnailLink = await c.evaluate(clip);
      await clickEl(toolbarIcon('Toggle sidebar')); await settle(900);
      sidebar.closedAgain = await c.evaluate(info);
    });

    await section('find', async () => {
      const find = result.find = {};
      await c.evaluate(`${V}.page = 1`); await settle(500);
      await c.evaluate(`${APP}.workspace.activeLeaf.view.showSearch()`); await settle(500);
      const info = `({ count: ${LEAF}.querySelector('.pdf-find-results-count').textContent, input: ${LEAF}.querySelector('.pdf-findbar input[type=search]').value, container: ${LEAF}.querySelector('.pdf-findbar .search-input-container').className.replace(/\\bmod-pending\\b/, '').replace(/\\s+/g, ' ').trim(), invalid: ${LEAF}.querySelector('.pdf-findbar input[type=search]').getAttribute('aria-invalid'), page: ${V}.page, highlights: ${LEAF}.querySelectorAll('.textLayer .highlight').length, selected: [...${LEAF}.querySelectorAll('.textLayer .highlight.selected')].map(e => e.textContent + '@' + e.closest('.page').dataset.pageNumber) })`;
      find.open = await c.evaluate(`({ bar: ${LEAF}.querySelector('.pdf-findbar').className, content: ${LEAF}.querySelector('.pdf-content-container').className.replace(/\\b(node-insert-event|sidebarMoving)\\b/g, '').replace(/\\s+/g, ' ').trim(), height: ${LEAF}.querySelector('.pdf-content-container').style.getPropertyValue('--findbar-height'), focused: document.activeElement === ${LEAF}.querySelector('.pdf-findbar input[type=search]'), controls: ${controls('.workspace-leaf.mod-active .pdf-findbar .pdf-search-wrapper').replace(/^\[\.\.\.document\.querySelectorAll\(([^)]*)\)\]/, '[...document.querySelectorAll($1)]')} })`);
      await capture('findbar', '.workspace-leaf.mod-active .pdf-findbar');
      await c.send('Input.insertText', { text: 'traveller' });
      await until(`${LEAF}.querySelector('.pdf-find-results-count').textContent !== ''`, 'find count');
      await settle(700); find.query = await c.evaluate(info);
      await capture('findbar-count', '.workspace-leaf.mod-active .pdf-findbar');
      await capture('find-page', '.workspace-leaf.mod-active .pdf-viewer-container');
      await enter(); await settle(700); find.next1 = await c.evaluate(info);
      await enter(); await settle(700); find.next2 = await c.evaluate(info);
      await enter(8); await settle(700); find.previous = await c.evaluate(info);
      await clickEl(`${LEAF}.querySelector('.pdf-findbar .lucide-arrow-down').closest('button')`); await settle(700); find.nextButton = await c.evaluate(info);
      await clickEl(`${LEAF}.querySelector('.pdf-findbar .lucide-arrow-up').closest('button')`); await settle(700); find.previousButton = await c.evaluate(info);
      await c.key('F3', 'F3', { windowsVirtualKeyCode: 114 }); await settle(700); find.f3 = await c.evaluate(info);
      // Options popover.
      await clickEl(`${LEAF}.querySelector('.pdf-findbar-settings-btn')`); await settle(400);
      find.settings = await c.evaluate(`(() => { const e = ${LEAF}.querySelector('.pdf-findbar-settings'); if (!e) return null; const r = e.getBoundingClientRect(), b = ${LEAF}.querySelector('.pdf-findbar-settings-btn').getBoundingClientRect(); return { parent: e.parentElement.className.replace(/\\b(node-insert-event|sidebarMoving)\\b/g, '').replace(/\\s+/g, ' ').trim(), rows: [...e.children].map(row => ({ cls: row.className, name: row.querySelector('.setting-item-name')?.textContent, desc: row.querySelector('.setting-item-description') ? row.querySelector('.setting-item-description').textContent : null, control: [...row.querySelector('.setting-item-control').children].map(x => x.tagName.toLowerCase() + '.' + x.className.replace(/\\bis-enabled\\b/, '').trim() + '>' + [...x.children].map(y => y.tagName.toLowerCase() + '[' + y.type + ']').join(',')), on: !!row.querySelector('.checkbox-container.is-enabled') })), dx: Math.round(r.right - b.right), dy: Math.round(r.y - b.bottom), size: [Math.round(r.width), Math.round(r.height)], btnActive: ${LEAF}.querySelector('.pdf-findbar-settings-btn').classList.contains('is-active') }; })()`);
      await capture('find-settings', '.workspace-leaf.mod-active .pdf-findbar-settings');
      await clickEl(`${LEAF}.querySelector('.pdf-findbar-settings .checkbox-container')`); await settle(700);
      find.highlightAll = await c.evaluate(info);
      find.highlightAllStored = await c.evaluate(`${APP}.loadLocalStorage('pdfjs-search-settings')`);
      await clickEl(`${LEAF}.querySelectorAll('.pdf-findbar-settings .checkbox-container')[2]`); await settle(700);
      find.wholeWords = await c.evaluate(info);
      await clickEl(`${LEAF}.querySelectorAll('.pdf-findbar-settings .checkbox-container')[2]`); await settle(300);
      await clickEl(`${LEAF}.querySelector('.pdf-findbar-settings .checkbox-container')`); await settle(300);
      await mouse(await center(`${LEAF}.querySelector('.pdf-find-results-count')`)); await settle(400);
      find.settingsClosedByOutsideClick = await c.evaluate(`!${LEAF}.querySelector('.pdf-findbar-settings')`);
      // Match case, then a query without matches.
      await clickEl(`${LEAF}.querySelector('.pdf-findbar .input-right-decorator')`); await settle(700);
      find.matchCase = await c.evaluate(`({ ...${info}, active: ${LEAF}.querySelector('.pdf-findbar .input-right-decorator').classList.contains('is-active') })`);
      await clickEl(`${LEAF}.querySelector('.pdf-findbar .input-right-decorator')`); await settle(500);
      await c.evaluate(`(() => { const e = ${LEAF}.querySelector('.pdf-findbar input[type=search]'); e.focus(); e.select(); })()`);
      await c.send('Input.insertText', { text: 'zzzqqq' }); await settle(1200);
      find.notFound = await c.evaluate(info);
      await capture('findbar-not-found', '.workspace-leaf.mod-active .pdf-findbar');
      await c.key('Escape'); await settle(500);
      find.closed = await c.evaluate(`({ bar: ${LEAF}.querySelector('.pdf-findbar').className, content: ${LEAF}.querySelector('.pdf-content-container').className.replace(/\\b(node-insert-event|sidebarMoving)\\b/g, '').replace(/\\s+/g, ' ').trim(), highlights: ${LEAF}.querySelectorAll('.textLayer .highlight').length })`);
      await c.evaluate(`${APP}.saveLocalStorage('pdfjs-search-settings', null)`);
    });

    await section('context', async () => {
      const context = result.context = {};
      await c.evaluate(`${V}.page = 1`); await settle(600);
      await until(`${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span').length > 2`, 'text layer');
      // Nothing selected: the reference shows no menu items for a plain page.
      const openAt = (selector, dx = 0) => c.evaluate(`(() => { const e = ${selector}; const r = e.getBoundingClientRect(); window.__pdfAuditClip = null; e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2 + ${dx}, clientY: r.y + r.height / 2, button: 2 })); })()`);
      await c.evaluate(`getSelection().removeAllRanges()`);
      await openAt(`${LEAF}.querySelector('.page[data-page-number="1"] .textLayer')`); await settle(500);
      context.plain = await c.evaluate(menuItems);
      await closeMenus();
      // A selection inside the second line of page 1: "harbour town".
      await c.evaluate(`(() => { const span = [...${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span')].find(s => s.textContent.startsWith('The harbour town')); const range = document.createRange(); range.setStart(span.firstChild, 4); range.setEnd(span.firstChild, 16); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); })()`);
      context.selectionText = await c.evaluate(`String(getSelection())`);
      await openAt(`[...${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span')].find(s => s.textContent.startsWith('The harbour town'))`);
      await until(`!!document.querySelector('.menu')`, 'selection menu');
      context.selection = await c.evaluate(menuItems);
      await capture('context-menu-selection', '.menu');
      await menuClick('Copy link to selection'); context.selectionLink = await c.evaluate(clip);
      await openAt(`[...${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span')].find(s => s.textContent.startsWith('The harbour town'))`);
      await until(`!!document.querySelector('.menu')`, 'selection menu');
      await menuClick('Copy as quote'); context.quote = await c.evaluate(clip);
      // A selection across two lines.
      await c.evaluate(`(() => { const spans = [...${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span')]; const a = spans.find(s => s.textContent.startsWith('The harbour town')), b = spans.find(s => s.textContent.startsWith('Fishing boats')); const range = document.createRange(); range.setStart(a.firstChild, 39); range.setEnd(b.firstChild, 13); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); })()`);
      await openAt(`[...${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span')].find(s => s.textContent.startsWith('Fishing boats'))`);
      await until(`!!document.querySelector('.menu')`, 'selection menu');
      await menuClick('Copy as quote'); context.quoteTwoLines = await c.evaluate(clip);
      await c.evaluate(`getSelection().removeAllRanges()`);
      // The highlight annotation on page 2.
      await c.evaluate(`${V}.page = 2`); await settle(900);
      await until(`!!${LEAF}.querySelector('.page[data-page-number="2"] .annotationLayer section[data-annotation-id]')`, 'annotation layer');
      context.annotationSection = await c.evaluate(`(() => { const e = ${LEAF}.querySelector('.page[data-page-number="2"] .annotationLayer section[data-annotation-id]'); return { cls: e.className, id: e.dataset.annotationId, style: e.getAttribute('style').replace(/(\\d+\\.\\d{2})\\d+/g, '$1'), visibleChildren: [...e.children].filter(x => x.offsetParent).length }; })()`);
      await openAt(`${LEAF}.querySelector('.page[data-page-number="2"] .annotationLayer section[data-annotation-id]')`);
      await until(`!!document.querySelector('.menu')`, 'annotation menu');
      context.annotation = await c.evaluate(menuItems);
      await capture('context-menu-annotation', '.menu');
      await menuClick('Copy annotation'); context.annotationQuote = await c.evaluate(clip);
      await openAt(`${LEAF}.querySelector('.page[data-page-number="2"] .annotationLayer section[data-annotation-id]')`);
      await until(`!!document.querySelector('.menu')`, 'annotation menu');
      await menuClick('Copy link to annotation'); context.annotationLink = await c.evaluate(clip);
      // A click on the annotation opens the reference's popup with its note.
      await mouse(await center(`${LEAF}.querySelector('.page[data-page-number="2"] .annotationLayer section[data-annotation-id]')`)); await settle(900);
      context.popup = await c.evaluate(`(() => { const e = ${LEAF}.querySelector('.popupWrapper'); if (!e) return null; const walk = x => ({ tag: x.tagName.toLowerCase(), cls: x.className?.baseVal ?? x.className, ...(x.children.length && x.tagName !== 'svg' ? { children: [...x.children].map(walk) } : { text: x.tagName === 'svg' ? null : x.textContent.replace(/\\d{1,2}[:.]\\d{2}[:.]\\d{2}.*/, '<time>').replace(/^.*<time>/, '<date>, <time>') }) }); return { parent: e.parentElement.className, id: e.dataset.annotationId, style: e.getAttribute('style').replace(/(\\d+\\.\\d{2})\\d+/g, '$1'), tree: walk(e) }; })()`);
      await capture('annotation-popup', '.workspace-leaf.mod-active .popupWrapper');
      await c.evaluate(`(() => { window.__pdfAuditClip = null; ${LEAF}.querySelector('.popupWrapper .clickable-icon')?.click(); })()`); await delay(500);
      context.popupCopy = await c.evaluate(clip);
      await mouse(await center(`${LEAF}.querySelector('.page[data-page-number="2"] .textLayer')`)); await settle(700);
      context.popupDismissed = await c.evaluate(`!${LEAF}.querySelector('.popupWrapper')`);
    });

    await section('more-options', async () => {
      const moreOptionsButton = `${LEAF}.querySelector('.view-actions [aria-label="More options"]')`;
      await c.evaluate(`(() => { const button = ${moreOptionsButton}; if (!button) throw new Error('Missing More options button'); const rect = button.getBoundingClientRect(); button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0 })); })()`);
      await until(`!!document.querySelector('.menu')`, 'more options menu');
      result.moreOptions = await c.evaluate(menuItems);
      await capture('more-options', '.menu');
      await closeMenus();
      result.header = await c.evaluate(`({ title: ${LEAF}.querySelector('.view-header-title').textContent, actions: [...${LEAF}.querySelectorAll('.view-actions > *')].map(e => e.getAttribute('aria-label')), tab: (e => e ? { title: e.querySelector('.workspace-tab-header-inner-title')?.textContent, icon: e.querySelector('.workspace-tab-header-inner-icon svg')?.getAttribute('class')?.replace('svg-icon ', '') ?? null, type: e.dataset.type } : null)(document.querySelector('.workspace-tab-header.is-active.mod-active') ?? document.querySelector('.mod-root .workspace-tab-header.is-active')) })`);
    });

    await section('state', async () => {
      await c.evaluate(`${V}.page = 3`); await settle(3500);
      const state = result.state = {};
      state.viewState = await c.evaluate(`${APP}.workspace.activeLeaf.getViewState()`);
      state.ephemeral = await c.evaluate(`${APP}.workspace.activeLeaf.getEphemeralState()`);
      state.saved = await c.evaluate(`(async () => { const text = await ${APP}.vault.adapter.read(${APP}.vault.configDir + '/workspace.json'); const found = []; (function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'leaf' && node.state?.type === 'pdf') found.push(node.state); for (const value of Object.values(node)) walk(value); })(JSON.parse(text)); return found; })()`);
      // Where the position is really kept: pdf.js's own view history, by document fingerprint.
      state.history = await c.evaluate(`(() => { const entry = JSON.parse(localStorage.getItem('pdfjs.history') ?? '{}').files?.find(f => f.fingerprint === '4f6273656e5044464175646974303031'); return entry ? { keys: Object.keys(entry).sort(), page: entry.page, zoom: entry.zoom, rotation: entry.rotation, sidebarView: entry.sidebarView, spreadMode: entry.spreadMode ?? null, scrollLeft: entry.scrollLeft, scrollTop: entry.scrollTop } : null; })()`);
      state.sidebarView = await c.evaluate(`localStorage.getItem('pdfjs.sidebarView')`);
      // Closing and reopening the file restores the page.
      await c.evaluate(`(async () => { const leaf = ${APP}.workspace.activeLeaf; leaf.detach(); })()`); await settle(600);
      await c.evaluate(`${APP}.workspace.getLeaf('tab').openFile(${APP}.vault.getFileByPath(${JSON.stringify(PDF)}))`);
      await until(`${APP}.workspace.activeLeaf?.view?.getViewType?.() === 'pdf' && !!${LEAF}.querySelector('.pdfViewer .page[data-loaded] canvas') && ${V}.isInitialViewSet`, 'PDF reopened');
      await settle(1500);
      state.reopened = await c.evaluate(scaleInfo);
    });

    await section('links', async () => {
      const links = result.links = {};
      const open = async (linktext, pane) => {
        await c.evaluate(`${APP}.workspace.openLinkText(${JSON.stringify(linktext)}, ${JSON.stringify(NOTE)}, ${JSON.stringify(pane)})`);
        await until(`${APP}.workspace.activeLeaf?.view?.getViewType?.() === 'pdf' && !!${LEAF}.querySelector('.pdfViewer .page[data-loaded] canvas') && ${V}.isInitialViewSet`, `link ${linktext}`);
        await settle(1800);
      };
      const position = `({ page: ${V}.page, value: ${V}.pdfViewer.currentScaleValue, top: Math.round(${LEAF}.querySelector('.page[data-page-number="' + ${V}.page + '"]').getBoundingClientRect().y - ${LEAF}.querySelector('.pdf-viewer-container').getBoundingClientRect().y), ephemeral: ${APP}.workspace.activeLeaf.getEphemeralState() })`;
      // In the tab that already shows the file.
      await open('Audit sample.pdf#page=5', false); links.sameTab = await c.evaluate(position);
      // In a new tab, where the remembered position is page 5 from the step above.
      await open('Audit sample.pdf#page=3', 'tab'); links.page3 = await c.evaluate(position);
      await capture('link-page3', '.workspace-leaf.mod-active .pdf-viewer-container');
      const fresh = async linktext => { await c.evaluate(`(async () => { for (const leaf of ${APP}.workspace.getLeavesOfType('pdf')) leaf.detach(); })()`); await settle(400); await open(linktext, 'tab'); };
      await fresh('Audit sample.pdf#page=2&selection=4,4,4,13');
      await until(`!!${LEAF}.querySelector('.page[data-page-number="2"] .textLayer .mod-focused')`, 'selection highlight');
      await settle(600);
      links.selection = await c.evaluate(`({ ...${position}, focused: [...${LEAF}.querySelectorAll('.textLayer .mod-focused')].map(e => e.className + '|' + e.textContent + '@' + e.closest('.page').dataset.pageNumber), span: window.__pdfAuditSelectionDom(${LEAF}.querySelector('.textLayer .mod-focused').closest('[data-idx]') ?? ${LEAF}.querySelector('.textLayer .mod-focused')) })`);
      await capture('link-selection', '.workspace-leaf.mod-active .pdf-viewer-container');
      // The same tab, a page that is already drawn: record what each app does with the highlight.
      await open('Audit sample.pdf#page=1&selection=2,4,2,16', false);
      links.sameTabHighlight = await c.evaluate(`({ page: ${V}.page, focused: [...${LEAF}.querySelectorAll('.textLayer .mod-focused')].map(e => e.className + '|' + e.textContent + '@' + e.closest('.page').dataset.pageNumber) })`);
      await fresh('Audit sample.pdf#page=1&selection=2,4,4,13');
      await until(`!!${LEAF}.querySelector('.page[data-page-number="1"] .textLayer .mod-focused')`, 'multi-line selection highlight');
      await settle(600);
      links.selectionLines = await c.evaluate(`({ page: ${V}.page, focused: [...${LEAF}.querySelectorAll('.textLayer .mod-focused')].map(e => e.className + '|' + e.textContent), spans: [...${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span')].slice(1, 4).map(e => window.__pdfAuditSelectionDom(e)) })`);
      await capture('link-selection-lines', '.workspace-leaf.mod-active .pdf-viewer-container');
      await c.key('Escape'); await settle(500);
      links.escapeClearsText = await c.evaluate(`({ text: ${LEAF}.querySelectorAll('.textLayer .mod-focused').length, spans: [...${LEAF}.querySelectorAll('.page[data-page-number="1"] .textLayer > span')].slice(1, 4).map(e => window.__pdfAuditSelectionDom(e)) })`);
      await fresh('Audit sample.pdf#page=2&annotation=8R');
      await until(`!!${LEAF}.querySelector('.annotationLayer .boundingRect')`, 'annotation highlight');
      await settle(600);
      links.annotation = await c.evaluate(`({ ...${position}, rect: (e => ({ cls: e.className, parent: e.parentElement.className, style: e.getAttribute('style').replace(/(\\d+\\.\\d{2})\\d+/g, '$1') }))(${LEAF}.querySelector('.annotationLayer .boundingRect')), textFocused: ${LEAF}.querySelectorAll('.textLayer .mod-focused').length })`);
      await capture('link-annotation', '.workspace-leaf.mod-active .pdf-viewer-container');
      await c.key('Escape'); await settle(500);
      links.escapeClears = await c.evaluate(`({ rect: ${LEAF}.querySelectorAll('.annotationLayer .boundingRect').length, text: ${LEAF}.querySelectorAll('.textLayer .mod-focused').length })`);
      await open('Audit sample.pdf#page=4&offset=0,400,0', false); links.offset = await c.evaluate(position);
    });

    await section('embeds', async () => {
      // The sidebar preference is shared with embeds through local storage; start them from "closed".
      await c.evaluate(`(async () => { for (const leaf of ${APP}.workspace.getLeavesOfType('pdf')) leaf.detach(); localStorage.setItem('pdfjs.sidebarView', '0'); })()`);
      await settle(500);
      await c.evaluate(`(async () => { const leaf = ${APP}.workspace.getLeaf(); await leaf.openFile(${APP}.vault.getFileByPath(${JSON.stringify(NOTE)})); const view = leaf.view; if (view.getMode() !== 'preview') await view.setState({ ...view.getState(), mode: 'preview' }, { history: false }); })()`);
      const READING = `${APP}.workspace.activeLeaf.view.containerEl.querySelector('.markdown-reading-view')`;
      await until(`${READING}?.querySelectorAll('.pdf-embed .pdfViewer .page[data-loaded] canvas').length >= 2`, 'embeds rendered');
      await settle(2500);
      result.embeds = await c.evaluate(`[...${READING}.querySelectorAll('.pdf-embed')].map(e => { const r = e.getBoundingClientRect(), v = e.querySelector('.pdf-viewer-container').getBoundingClientRect(), t = e.querySelector('.pdf-toolbar').getBoundingClientRect(); return { tag: e.tagName.toLowerCase(), cls: e.className, src: e.getAttribute('src'), alt: e.getAttribute('alt'), parent: e.parentElement.tagName.toLowerCase(), styleHeight: Math.round(parseFloat(e.style.height)), size: [Math.round(r.width), Math.round(r.height)], viewer: [Math.round(v.width), Math.round(v.height)], toolbarHeight: Math.round(t.height), pages: e.querySelectorAll('.page').length, current: e.querySelector('.pdf-page-input').value, label: e.querySelector('.pdf-page-numbers').textContent, viewerClass: e.querySelector('.pdfViewer').className, scaleFactor: Math.round(parseFloat(e.querySelector('.pdfViewer').style.getPropertyValue('--scale-factor')) * 1000) / 1000, sidebarView: e.querySelector('.pdf-sidebar-container').getAttribute('data-view'), content: e.querySelector('.pdf-content-container').className.replace(/\\b(node-insert-event|sidebarMoving)\\b/g, '').replace(/\\s+/g, ' ').trim(), copyHelper: !!e.querySelector('.hiddenCopyElement, #hiddenCopyElement'), children: [...e.children].map(x => x.className) }; })`);
      result.embedToolbar = await c.evaluate(controls('.pdf-toolbar:not(.pdf-findbar) > div', `${READING}.querySelector('.pdf-embed')`));
      await c.evaluate(`${READING}.querySelector('.markdown-preview-view').scrollTop = 0`); await settle(600);
      await capture('embed-first', '.workspace-leaf.mod-active .markdown-reading-view .pdf-embed');
      await capture('reading-view', '.workspace-leaf.mod-active .markdown-reading-view');
      // The embed's "Open" button offers the link's menu.
      await clickEl(`${READING}.querySelector('.pdf-embed .pdf-toolbar-right .clickable-icon')`);
      await until(`!!document.querySelector('.menu')`, 'embed menu');
      result.embedMenu = await c.evaluate(menuItems);
      await closeMenus();
      // Paging inside an embed leaves the others alone.
      await c.evaluate(`(() => { const e = ${READING}.querySelector('.pdf-embed .pdf-page-input'); e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`); await settle(700);
      result.embedPaging = await c.evaluate(`[...${READING}.querySelectorAll('.pdf-embed .pdf-page-input')].map(e => e.value)`);
      // The link in the note opens the file at its page.
      await c.evaluate(`(() => { const e = ${READING}.querySelector('.markdown-preview-view'); e.scrollTop = e.scrollHeight; })()`); await settle(900);
      await until(`!![...${READING}.querySelectorAll('a.internal-link')].find(x => x.getAttribute('data-href') === 'Audit sample.pdf#page=3')`, 'PDF link in note');
      await c.evaluate(`(() => { const a = [...${READING}.querySelectorAll('a.internal-link')].find(x => x.getAttribute('data-href') === 'Audit sample.pdf#page=3'); if (!a) throw new Error('Missing PDF link'); window.__pdfAuditLink = { text: a.textContent, cls: a.className, href: a.getAttribute('href') }; a.scrollIntoView({ block: 'center' }); })()`);
      result.noteLink = await c.evaluate(`window.__pdfAuditLink`);
      await settle(300);
      await clickEl(`[...${READING}.querySelectorAll('a.internal-link')].find(x => x.getAttribute('data-href') === 'Audit sample.pdf#page=3')`);
      await until(`${APP}.workspace.activeLeaf?.view?.getViewType?.() === 'pdf' && !!${LEAF}.querySelector('.pdfViewer .page[data-loaded] canvas') && ${V}.isInitialViewSet`, 'link click opens PDF');
      await settle(1500);
      result.noteLinkOpens = await c.evaluate(`({ page: ${V}.page, type: ${APP}.workspace.activeLeaf.view.getViewType() })`);
    });

    await section('api', async () => {
      result.api = await c.evaluate(`(async () => { const lib = typeof require === 'function' && (() => { try { return require('obsidian'); } catch { return null; } })(); const load = lib?.loadPdfJs ?? null; const pdfjs = load ? await load() : (globalThis.pdfjsLib ?? null); return { module: !!lib, exported: lib ? typeof lib.loadPdfJs : 'no module', version: pdfjs?.version ?? null, getDocument: typeof pdfjs?.getDocument, workerSrc: !!pdfjs?.GlobalWorkerOptions?.workerSrc }; })()`);
    });

    await closeMenus();
    result.errors = c.errors.filter(e => !/ResizeObserver loop/.test(String(e))).slice();
    console.log(`${name}: ${JSON.stringify({ pages: result.pageCount?.pages, initial: result.initial, find: result.find?.query?.count, embeds: result.embeds?.length, errors: result.errors.length, failed: Object.keys(result).filter(k => k.endsWith(':error')) })}`);
  }
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2));
  if (report.reference && report.obsen) {
    const differences = [];
    for (const key of new Set([...Object.keys(report.reference), ...Object.keys(report.obsen)])) {
      if (key === 'errors' || key === 'historicalErrors') continue;
      const a = report.reference[key], b = report.obsen[key];
      if (key.endsWith(':rect')) { if (!a || !b || typeof a === 'string' || typeof b === 'string' || a.width !== b.width || a.height !== b.height || a.x !== b.x || a.y !== b.y) differences.push(key); continue; }
      // Compare nested results one field at a time, so that the report names the field that differs.
      if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
        for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) { try { assert.deepEqual(b[field], a[field]); } catch { differences.push(`${key}.${field}`); } }
      } else { try { assert.deepEqual(b, a); } catch { differences.push(key); } }
    }
    const pick = (side, key) => { const [head, ...rest] = key.split('.'); return rest.length && !key.endsWith(':rect') ? report[side][head]?.[rest.join('.')] : report[side][key]; };
    await fs.writeFile(path.join(output, 'differences.json'), JSON.stringify(Object.fromEntries(differences.map(key => [key, { reference: pick('reference', key), obsen: pick('obsen', key) }])), null, 2));
    console.log(differences.length ? `Differences (${differences.length}): ${differences.join(', ')}` : 'No behavioral or geometry differences.');
    console.log(`Renderer errors: reference ${report.reference.errors.length}, obsen ${report.obsen.errors.length}`);
    if (differences.length || report.reference.errors.length || report.obsen.errors.length) process.exitCode = 1;
  }
  if (Object.values(report).some(result => result.errors.length || Object.keys(result).some(key => key.endsWith(':error')))) process.exitCode = 1;
} finally { for (const [, c] of clients) c.socket.close(); }
