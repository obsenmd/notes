// Compare the canvas editor in the two running offscreen fixtures (see scripts/dev/README.md).
// Usage: node scripts/dev/canvas-audit.mjs [output dir]   (ports: CANVAS_REFERENCE_PORT=9354, CANVAS_OBSEN_PORT=9344;
// CANVAS_STEPS=a,b runs a subset of the steps; CANVAS_ONLY=reference|obsen drives one app.)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fixtureClient, delay } from './fixture-client.mjs';

const output = process.argv[2] ?? 'dist/todo-backup/canvas-comparison';
const referencePort = Number(process.env.CANVAS_REFERENCE_PORT ?? process.argv[3] ?? 9354), obsenPort = Number(process.env.CANVAS_OBSEN_PORT ?? process.argv[4] ?? 9344);
if ([9229, 9340, 9341, 9351].includes(referencePort) || [9229, 9340, 9341, 9351].includes(obsenPort)) throw new Error('Those ports belong to someone else.');
await fs.mkdir(output, { recursive: true });
const only = process.env.CANVAS_ONLY, wanted = process.env.CANVAS_STEPS?.split(',');
const clients = [];
if (only !== 'obsen') clients.push(['reference', await fixtureClient(referencePort, 'obsen-reference-audit-', { waitForApp: true })]);
if (only !== 'reference') clients.push(['obsen', await fixtureClient(obsenPort, 'obsen-electron-smoke-', { waitForApp: true })]);

// ---- Fixture files (identical in both vaults) ----

function png(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); raw.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3); }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const DIR = 'Canvas audit', CANVAS = `${DIR}/Audit.canvas`, EMPTY = `${DIR}/Empty.canvas`, EDIT = `${DIR}/Edit.canvas`;
const picture = png(200, 120, (x, y) => (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? [40, 120, 200] : [240, 200, 60]);
const line = value => JSON.stringify(value);
const canvasText = (nodes, edges) => `{\n\t"nodes":[\n${nodes.map(n => '\t\t' + line(n)).join(',\n')}\n\t],\n\t"edges":[\n${edges.map(e => '\t\t' + line(e)).join(',\n')}\n\t]\n}`;
const AUDIT_NODES = [
  { id: 'g1', x: -540, y: -380, width: 620, height: 700, color: '4', type: 'group', label: 'Group A' },
  { id: 't1', x: -500, y: -320, width: 260, height: 220, type: 'text', text: '# Heading\n\nSome **bold** text and a [[Note]] link.\n\n- one\n- two' },
  { id: 't2', x: -180, y: -40, width: 220, height: 60, color: '2', type: 'text', text: 'Second card' },
  { id: 'f1', x: 160, y: -380, width: 400, height: 300, type: 'file', file: `${DIR}/Note.md` },
  { id: 'f2', x: 160, y: 20, width: 400, height: 200, color: '#ff8800', type: 'file', file: `${DIR}/Note.md`, subpath: '#Second' },
  { id: 'i1', x: -500, y: 120, width: 240, height: 144, type: 'file', file: `${DIR}/pixel.png` },
  { id: 'l1', x: 640, y: -380, width: 300, height: 200, type: 'link', url: 'http://127.0.0.1:1/' },
];
const AUDIT_EDGES = [
  { id: 'e1', fromNode: 't1', fromSide: 'right', toNode: 'f1', toSide: 'left', color: '1', label: 'labelled' },
  { id: 'e2', fromNode: 't2', fromSide: 'bottom', toNode: 'i1', toSide: 'right', toEnd: 'none' },
  { id: 'e3', fromNode: 'f1', fromSide: 'bottom', fromEnd: 'arrow', toNode: 'f2', toSide: 'top', color: '#00aaff' },
  { id: 'e4', fromNode: 'f1', fromSide: 'right', toNode: 'l1', toSide: 'left' },
];
const EDIT_NODES = [
  { id: 'a', x: -900, y: -500, width: 240, height: 120, type: 'text', text: 'Alpha' },
  { id: 'b', x: 500, y: -500, width: 240, height: 120, type: 'text', text: 'Beta' },
  { id: 'c', x: -900, y: 300, width: 240, height: 120, type: 'text', text: 'Gamma' },
  { id: 'd', x: 500, y: 300, width: 240, height: 120, type: 'text', text: 'Delta' },
];
const FILES = {
  [`${DIR}/Note.md`]: '# First\n\nIntro paragraph of the note.\n\n## Second\n\nBody of the second section.\n\n## Third\n\nLast section.\n',
  [`${DIR}/Embed.md`]: 'Before the canvas.\n\n![[Audit.canvas]]\n\nAfter the canvas.\n',
  [CANVAS]: canvasText(AUDIT_NODES, AUDIT_EDGES),
  [EDIT]: canvasText(EDIT_NODES, []),
  [EMPTY]: '',
};

// ---- In-page adapter: one vocabulary for both implementations ----

const ADAPTER = `(() => {
  const a = window.app ?? window.__obsenSmokeApp, reference = !!a.internalPlugins;
  const view = () => a.workspace.getLeavesOfType('canvas')[0]?.view, c = () => view().canvas;
  const nodes = () => reference ? c().nodes : c().doc.nodes, edges = () => reference ? c().edges : c().doc.edges;
  const rect = () => reference ? c().canvasRect : c().rect;
  const round = n => Math.round(n * 1000) / 1000;
  const api = {
    reference, app: a, view, canvas: c,
    state() {
      const k = c();
      const selectionKey = value => {
        const id = typeof value === 'string' ? value : value.id;
        const node = nodes().get(id);
        if (node) {
          const d = reference ? node.getData() : node;
          const content = d.type === 'file' ? d.file : d.type === 'text' ? d.text : d.type === 'link' ? d.url : d.label;
          return ['node', d.type, d.x, d.y, d.width, d.height, content ?? ''].join(':');
        }
        const edge = edges().get(id);
        if (edge) {
          const d = reference ? edge.getData() : edge;
          const from = nodes().get(d.fromNode), to = nodes().get(d.toNode);
          const nodeKey = node => { if (!node) return ''; const n = reference ? node.getData() : node; const content = n.type === 'file' ? n.file : n.type === 'text' ? n.text : n.type === 'link' ? n.url : n.label; return [n.type, n.x, n.y, content ?? ''].join(':'); };
          return ['edge', nodeKey(from), d.fromSide, d.fromEnd ?? 'none', nodeKey(to), d.toSide, d.toEnd ?? 'arrow', d.label ?? ''].join(':');
        }
        return id;
      };
      return { x: round(k.x), y: round(k.y), zoom: round(k.zoom), tx: round(k.tx), ty: round(k.ty), tZoom: round(k.tZoom), readonly: !!k.readonly,
        undo: k.history.canUndo(), redo: k.history.canRedo(), focus: document.activeElement === k.wrapperEl ? 'wrapper' : k.wrapperEl.contains(document.activeElement) ? 'inside: ' + document.activeElement.tagName.toLowerCase() + '.' + String(document.activeElement.className).split(' ')[0] : 'outside: ' + document.activeElement.tagName.toLowerCase(),
        selection: [...k.selection].map(selectionKey).sort(), nodes: nodes().size, edges: edges().size,
        zoomedOut: k.wrapperEl.classList.contains('mod-zoomed-out'), wrapper: k.wrapperEl.className.split(/\\s+/).filter(x => x && x !== 'mod-animating').sort().join(' ') };
    },
    settled() { const k = c(); return k.x === k.tx && k.y === k.ty && k.zoom === k.tZoom; },
    screen(pos) { const k = c(), r = rect(); return { x: r.cx + (pos.x - k.x) * k.scale, y: r.cy + (pos.y - k.y) * k.scale }; },
    wrapperRect() { const r = c().wrapperEl.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
    node(id) { const n = nodes().get(id); if (!n) return null; const d = reference ? n.getData() : n; return { id, x: d.x, y: d.y, width: d.width, height: d.height, type: d.type }; },
    nodeEl(id) { return reference ? nodes().get(id)?.nodeEl : c().canvasEl.querySelector('.canvas-node[data-id="' + id + '"]'); },
    edgePath(id) {
      if (reference) return edges().get(id)?.path?.display ?? edges().get(id)?.lineGroupEl?.querySelector('.canvas-display-path');
      const index = [...edges().keys()].indexOf(id); return c().canvasEl.querySelectorAll('svg.canvas-edges')[0]?.querySelectorAll(':scope > g')[index]?.querySelector('.canvas-display-path');
    },
    /** Screen point on a connection, at a fraction of its length. */
    edgePoint(id, fraction = 0.5) {
      const p = api.edgePath(id); if (!p) return null;
      const at = p.getPointAtLength(p.getTotalLength() * fraction); return api.screen({ x: at.x, y: at.y });
    },
    ids() { return { nodes: [...nodes().keys()], edges: [...edges().keys()] }; },
    data() { return JSON.stringify(c().getData()); },
    /** Runtime and serialized stack state for matching the deferred first-frame card order. */
    stack() { const k = c(), list = [...nodes()].map(([id, node], index) => { const d = reference ? node.getData() : node; return { id, index, type: d.type, text: d.text, file: d.file, label: d.label, z: node.z ?? node.zIndex ?? null, unplaced: node.unplaced ?? false }; }); return { runtime: list, serialized: k.getData().nodes.map((node, index) => ({ id: node.id, index, type: node.type, text: node.text, file: node.file, label: node.label })) }; },
    async save() { const v = view(); if (reference) { await v.save(); } else { await v.save(); } return a.vault.adapter.read(v.file.path); },
    text(path) { return a.vault.adapter.read(path); },
    rectOf(selector) { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
    menu() { return [...document.querySelectorAll('.menu')].map(menu => [...menu.querySelectorAll('.menu-item, .menu-separator')].filter(e => e.closest('.menu') === menu && e.getClientRects().length).map(e => e.classList.contains('menu-separator') ? '---' : (e.querySelector('.menu-item-title')?.textContent ?? '') + (e.classList.contains('is-warning') ? ' [warning]' : '') + (e.querySelector('.mod-checked, .menu-item-icon.mod-selected') || e.classList.contains('mod-checked') ? ' [checked]' : '') + (e.classList.contains('is-disabled') ? ' [disabled]' : '') + (e.classList.contains('has-submenu') || e.querySelector('.mod-submenu') ? ' [submenu]' : ''))); },
    closeMenus() { for (let i = 0; i < 4 && document.querySelector('.menu'); i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return !document.querySelector('.menu'); },
  };
  window.__ca = api; return reference;
})()`;

// ---- Driving helpers ----

const report = {}, problems = [], passed = [];
const note = (step, message) => { problems.push(`${step}: ${message}`); console.log(`  DIFFERENCE ${step}: ${message}`); };
function wrap(name, c) {
  const record = report[name] = {};
  const ev = c.evaluate, mouse = (type, point, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'none', ...extra });
  const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const h = {
    name, c, record, ev,
    ca: expression => ev(`window.__ca.${expression}`),
    async warm() { await Promise.race([c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } }).catch(() => undefined), delay(3000)]); },
    async settle(extra = 150) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) { if (await ev(`window.__ca.settled()`)) break; await delay(50); }
      await delay(extra);
    },
    move: (point, modifiers = 0) => mouse('mouseMoved', point, { modifiers }),
    async click(point, { modifiers = 0, button = 'left', count = 1 } = {}) {
      await mouse('mouseMoved', point, { modifiers });
      for (let n = 1; n <= count; n++) {
        await mouse('mousePressed', point, { button, buttons: button === 'left' ? 1 : 2, clickCount: n, modifiers });
        await mouse('mouseReleased', point, { button, clickCount: n, modifiers });
      }
      await delay(120);
    },
    rightClick: (point, modifiers = 0) => h.click(point, { button: 'right', modifiers }),
    /** Press at `from`, travel through `via` points to `to`, release. `modifiers` may be a function of the step index. */
    async drag(from, to, { modifiers = 0, steps = 8, hold = 0, releaseModifiers } = {}) {
      await mouse('mouseMoved', from);
      await delay(60);
      await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }, { button: 'left', buttons: 1, modifiers }); await delay(25); }
      if (hold) await delay(hold);
      await mouse('mouseReleased', to, { button: 'left', clickCount: 1, modifiers: releaseModifiers ?? modifiers });
      await delay(150);
    },
    async press(from) { await mouse('mouseMoved', from); await delay(60); await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 }); },
    async travel(from, to, modifiers = 0, steps = 8) { for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }, { button: 'left', buttons: 1, modifiers }); await delay(25); } },
    async release(to, modifiers = 0) { await mouse('mouseReleased', to, { button: 'left', clickCount: 1, modifiers }); await delay(150); },
    async key(key, { code, modifiers = 0, text, vk } = {}) {
      const codes = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Delete: 46, ' ': 32, Tab: 9 };
      const windowsVirtualKeyCode = vk ?? codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const base = { key, code: code ?? (key.length === 1 ? (/[0-9]/.test(key) ? 'Digit' + key : 'Key' + key.toUpperCase()) : key), windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
      await c.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await delay(120);
    },
    type: text => c.send('Input.insertText', { text }),
    MOD,
    /** Screen point of a canvas position; of a card's centre or a point inside it given as fractions. */
    at: (x, y) => ev(`window.__ca.screen({x:${x},y:${y}})`),
    async card(id, fx = 0.5, fy = 0.5) { const n = await ev(`window.__ca.node(${JSON.stringify(id)})`); if (!n) throw new Error(`No card ${id} in ${name}`); return h.at(n.x + n.width * fx, n.y + n.height * fy); },
    edge: (id, fraction = 0.5) => ev(`window.__ca.edgePoint(${JSON.stringify(id)}, ${fraction})`),
    center: async selector => { const r = await ev(`window.__ca.rectOf(${JSON.stringify(selector)})`); if (!r) throw new Error(`Missing ${selector} in ${name}`); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
    state: () => ev(`window.__ca.state()`),
    /** Parks the pointer where nothing reacts to it. */
    async park() { await mouse('mouseMoved', { x: 640, y: 4 }); await delay(80); },
    async capture(scenario, selector = '.canvas-wrapper') {
      await delay(450);
      const box = await ev(`window.__ca.rectOf(${JSON.stringify(selector)})`);
      if (!box) throw new Error(`Missing capture target ${selector} for ${scenario} in ${name}`);
      if (box.width < 1 || box.height < 1) throw new Error(`Empty capture target ${selector} for ${scenario} in ${name}`);
      if (process.env.CANVAS_NO_CAPTURE === '1') { record.captures ??= {}; record.captures[scenario] = box; return box; }
      let rect = null;
      for (let attempt = 0; attempt < 3 && !rect; attempt++) {
        // An idle offscreen page produces no frame; a repaint is forced before each attempt.
        await ev(`(() => { document.body.style.outline = document.body.style.outline ? '' : '0px solid transparent'; })()`);
        rect = await Promise.race([c.capture(output, `${name}-${scenario}`, selector), delay(9000).then(() => null)]).catch(error => { if (/Missing capture target/.test(error.message)) throw error; return null; });
      }
      if (!rect) throw new Error(`No frame for ${scenario} in ${name}`);
      record.captures ??= {}; record.captures[scenario] = rect;
      return rect;
    },
    async open(file, fresh = true) {
      await ev(`(async () => {
        const a = window.__ca.app;
        for (const leaf of a.workspace.getLeavesOfType('canvas')) leaf.detach();
        await new Promise(resolve => setTimeout(resolve, 400));
        ${fresh ? `try { const v = localStorage; for (const k of Object.keys(v)) if (k.includes('canvas-' + ${JSON.stringify(file)})) v.removeItem(k); } catch {}` : ''}
        await a.workspace.getLeaf().openFile(a.vault.getFileByPath(${JSON.stringify(file)}));
      })()`);
      await c.wait(`!!document.querySelector('.canvas-wrapper') && window.__ca.view()?.file?.path === ${JSON.stringify(file)}`, `canvas ${file} open`);
      await delay(400); await h.settle(300); await h.park();
    },
    async menu() { await delay(150); return ev(`window.__ca.menu()`); },
    async closeMenus() { await h.key('Escape'); await ev(`window.__ca.closeMenus()`); await delay(100); },
    async saved() { await delay(350); return ev(`window.__ca.save()`); },
  };
  return h;
}

/** New cards and connections get random ids: they are replaced by the order they first appear in. */
function normalizeIds(text, known) {
  const seen = new Map();
  return text.replace(/"(id|fromNode|toNode)":"([^"]+)"/g, (_all, key, id) => {
    if (known.has(id)) return `"${key}":"${id}"`;
    if (!seen.has(id)) seen.set(id, `new${seen.size + 1}`);
    return `"${key}":"${seen.get(id)}"`;
  });
}
const KNOWN = new Set([...AUDIT_NODES, ...AUDIT_EDGES, ...EDIT_NODES].map(item => item.id));

function flatten(outline, depth = 0, out = []) {
  const cls = outline.class.split(/\s+/).filter(Boolean).sort().join('.');
  out.push(`${'  '.repeat(depth)}${outline.tag}${cls ? '.' + cls : ''}${outline.children ? '' : outline.text ? ` "${outline.text.slice(0, 60)}"` : ''}`);
  for (const child of outline.children ?? []) flatten(child, depth + 1, out);
  return out;
}
/** Line diff of two DOM outlines (longest common subsequence); returns the differing lines. */
function outlineDiff(a, b) {
  const n = a.length, m = b.length, table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { i++; j++; } else if (table[i + 1][j] >= table[i][j + 1]) out.push('- ' + a[i++].trim()); else out.push('+ ' + b[j++].trim()); }
  while (i < n) out.push('- ' + a[i++].trim()); while (j < m) out.push('+ ' + b[j++].trim());
  return out;
}

const helpers = clients.map(([name, c]) => wrap(name, c));
const both = async fn => { const results = {}; for (const h of helpers) results[h.name] = await fn(h); return results; };
/** Runs `fn` in both apps and requires equal results. */
async function same(step, label, fn, { fatal = false, normalize = value => value } = {}) {
  const results = await both(fn);
  for (const h of helpers) (h.record[step] ??= {})[label] = results[h.name];
  if (helpers.length < 2) return results[helpers[0].name];
  const anonymous = value => { if (value === undefined) return value; const seen = new Map(); return JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{16}/g, id => { if (!seen.has(id)) seen.set(id, `new${seen.size + 1}`); return seen.get(id); })); };
  const [a, b] = [anonymous(normalize(results.reference)), anonymous(normalize(results.obsen))];
  try { assert.deepEqual(b, a); passed.push(`${step}: ${label}`); }
  catch {
    // Long values are reported as the lines that differ.
    const lines = value => typeof value === 'string' ? value.split('\n') : JSON.stringify(value, null, 1).split('\n');
    const [la, lb] = [lines(a), lines(b)], diff = la.length + lb.length > 8 ? outlineDiff(la, lb).slice(0, 12).map(text => text.slice(0, 260)).join('\n        ') : null;
    note(step, diff ? `${label}\n        ${diff}` : `${label}\n      reference: ${JSON.stringify(a)}\n      obsen:     ${JSON.stringify(b)}`);
    if (fatal) throw new Error(`${step}: ${label} differs`);
  }
  return results.reference;
}
async function observe(step, label, fn) {
  const results = await both(fn);
  for (const h of helpers) (h.record[step] ??= {})[label] = results[h.name];
  return results;
}
const fileSame = (step, label) => same(step, `file text after ${label}`, h => h.saved(), { normalize: text => normalizeIds(text, KNOWN) });
const capture = (scenario, selector) => both(async h => { await h.park(); return h.capture(scenario, selector); });
const captureLive = (scenario, selector) => both(h => h.capture(scenario, selector));

// ---- Steps ----

const steps = {};

steps.setup = async () => {
  await both(async h => {
    const { c } = h;
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.key('Escape');
    await h.ev(`(async () => {
      const a = window.app ?? window.__obsenSmokeApp;
      if (!a.vault.getFolderByPath(${JSON.stringify(DIR)})) await a.vault.createFolder(${JSON.stringify(DIR)});
      for (const leaf of a.workspace.getLeavesOfType('canvas')) leaf.detach();
      for (const f of a.vault.getFiles()) if (f.path.startsWith(${JSON.stringify(DIR + '/')}) && !(f.path in ${JSON.stringify(FILES)}) && f.name !== 'pixel.png') await a.vault.delete(f);
      for (const [p, text] of Object.entries(${JSON.stringify(FILES)})) { const f = a.vault.getFileByPath(p); if (f) await a.vault.modify(f, text); else await a.vault.create(p, text); }
      const bytes = Uint8Array.from(atob(${JSON.stringify(picture.toString('base64'))}), ch => ch.charCodeAt(0)).buffer;
      const image = a.vault.getFileByPath(${JSON.stringify(DIR + '/pixel.png')});
      if (image) await a.vault.modifyBinary(image, bytes); else await a.vault.createBinary(${JSON.stringify(DIR + '/pixel.png')}, bytes);
      await a.vault.adapter.write('.obsidian/canvas.json', JSON.stringify({ snapToObjects: true, snapToGrid: true }, null, 2));
      await new Promise(resolve => setTimeout(resolve, 600));
      if (a.internalPlugins) { const p = a.internalPlugins.plugins.canvas; if (!p.enabled) await p.enable(false); Object.assign(p.instance.options, { snapToObjects: true, snapToGrid: true }); for (const k of Object.keys(p.instance.options)) if (!['snapToObjects', 'snapToGrid'].includes(k)) delete p.instance.options[k]; }
    })()`);
    if (h.name === 'obsen') { await c.send('Page.reload'); await c.wait(`!!window.__obsenSmokeApp?.commands.findCommand('canvas:new-file')`, 'canvas plugin after reload'); await delay(500); }
    await h.warm();
    await h.ev(ADAPTER);
    await delay(800);
  });
};

steps.framing = async () => {
  await both(h => h.open(CANVAS));
  await same('framing', 'viewport after opening', h => h.state());
  await capture('default');
  await both(async h => { await h.key('!', { code: 'Digit1', modifiers: h.MOD.shift, vk: 49 }); await h.settle(); });
  await same('framing', 'viewport after Shift+1', h => h.state());
  await capture('zoom-to-fit');
  await both(async h => { await h.click(await h.card('t2')); await h.key('@', { code: 'Digit2', modifiers: h.MOD.shift, vk: 50 }); await h.settle(); });
  await same('framing', 'viewport after Shift+2 on t2', h => h.state());
  await capture('zoom-to-selection');
  await both(async h => { await h.key('Escape'); await h.key('!', { code: 'Digit1', modifiers: h.MOD.shift, vk: 49 }); await h.settle(); });
  for (const [label, index] of [['zoom in button', 1], ['zoom out button', 4], ['reset zoom button', 2], ['zoom to fit button', 3]]) {
    await both(async h => { await h.click(await h.center(`.canvas-controls .canvas-control-group:nth-child(2) .canvas-control-item:nth-child(${index})`)); await h.settle(); });
    await same('framing', `viewport after ${label}`, h => h.state());
    if (index !== 3) await capture(label.replace(/ /g, '-'));
  }
  // Far enough out, card contents give way to placeholders.
  await both(async h => { for (let i = 0; i < 4; i++) await h.click(await h.center(`.canvas-controls .canvas-control-group:nth-child(2) .canvas-control-item:nth-child(4)`)); await h.settle(400); });
  await same('framing', 'viewport zoomed out', h => h.state());
  await capture('zoomed-out');
  await both(async h => { await h.click(await h.center(`.canvas-controls .canvas-control-group:nth-child(2) .canvas-control-item:nth-child(3)`)); await h.settle(); });
};

const SHIFT1 = h => h.key('!', { code: 'Digit1', modifiers: h.MOD.shift, vk: 49 });
/** Centre of a selection toolbar button, found by the start of its tooltip. */
const tool = (h, label) => h.ev(`(() => { const b = [...document.querySelectorAll('.canvas-menu > button, .canvas-menu > .clickable-icon')].find(e => (e.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(label)})); if (!b) throw new Error('No toolbar button ' + ${JSON.stringify(label)} + ' among ' + [...document.querySelectorAll('.canvas-menu > *')].map(e => e.getAttribute('aria-label')).join(' | ')); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const toolbar = h => h.ev(`[...document.querySelectorAll('.canvas-menu > *')].map(e => (e.getAttribute('aria-label') ?? e.className).replace(/\\n/g, ' / ') + (e.classList.contains('is-active') ? ' [active]' : ''))`);
const selection = h => h.state().then(state => state.selection);
/** Compares the open menu item for item, captures it, and closes it. */
async function menuCheck(step, name, { close = true } = {}) {
  await same(step, `${name} menu items`, h => h.menu());
  await captureLive(`menu-${name}`, '.menu').catch(error => note(step, `${name} menu capture: ${error.message}`));
  if (close) await both(h => h.closeMenus());
}

steps.selection = async () => {
  const step = 'selection';
  await both(async h => { await h.open(CANVAS); await SHIFT1(h); await h.settle(); });
  await both(async h => h.click(await h.card('t1', 0.5, 0.8)));
  await same(step, 'click selects one card', selection);
  await same(step, 'toolbar for a text card', toolbar);
  await capture('select-card');
  await both(async h => h.click(await tool(h, 'Set color')));
  await same(step, 'colour submenu swatches', h => h.ev(`[...document.querySelectorAll('.canvas-submenu > *')].map(e => e.className)`));
  await captureLive('toolbar-color', '.canvas-menu');
  await capture('toolbar-color-canvas');
  await both(async h => h.click(await tool(h, 'Set color')));
  await both(async h => h.click(await h.card('f1', 0.5, 0.5), { modifiers: h.MOD.shift }));
  await same(step, 'Shift-click adds a card', selection);
  await same(step, 'toolbar for several cards', toolbar);
  await capture('select-multi');
  await both(async h => h.click(await tool(h, 'Align')));
  await menuCheck(step, 'align');
  await same(step, 'selection after closing a toolbar menu with Escape', selection);
  await both(async h => { await h.key('Escape'); await h.click(await h.card('t1', 0.5, 0.8)); await h.click(await h.card('f1', 0.5, 0.5), { modifiers: h.MOD.shift }); });
  await both(async h => h.click(await h.card('f1', 0.5, 0.5), { modifiers: h.MOD.shift }));
  await same(step, 'Shift-click removes a card', selection);
  await both(h => h.key('Escape'));
  await same(step, 'Escape clears the selection', selection);
  // Marquee: from empty background right of the group, over the second card and the picture.
  await both(async h => { const from = await h.at(110, 300), to = await h.at(-520, -60); h.dragFrom = from; h.dragTo = to; await h.press(from); await h.travel(from, to); });
  await same(step, 'marquee selects what it touches (groups only when enclosed)', selection);
  await captureLive('marquee');
  await both(h => h.release(h.dragTo));
  await same(step, 'selection after marquee', selection);
  await capture('select-marquee');
  await both(async h => { const from = await h.at(600, 300), to = await h.at(140, 0); await h.drag(from, to, { modifiers: h.MOD.shift }); });
  await same(step, 'Shift-marquee adds to the selection', selection);
  await both(async h => { await h.key('Escape'); await h.key('a', { modifiers: h.MOD.ctrl }); });
  await same(step, 'Ctrl+A selects every card', selection);
  await capture('select-all');
  await both(h => h.key('Escape'));
  // A group is selected by its label (its inside lets clicks through to the canvas).
  await both(async h => h.click(await h.center('.canvas-group-label')));
  await same(step, 'click on a group label selects the group', selection);
  await same(step, 'toolbar for a group', toolbar);
  await capture('select-group');
  await both(async h => h.click(await tool(h, 'Align')));
  await menuCheck(step, 'group-align');
  await both(h => h.key('Escape'));
  await both(async h => h.click(await h.card('g1', 0.5, 0.92)));
  await same(step, 'click inside a group (empty area)', selection);
  await both(h => h.key('Escape'));
  for (const [id, fraction] of [['e1', 0.2], ['e2', 0.5], ['e3', 0.5]]) {
    await both(async h => { await h.key('Escape'); await h.click(await h.edge(id, fraction)); });
    await same(step, `click selects connection ${id}`, selection);
    await same(step, `toolbar for connection ${id}`, toolbar);
    await capture(`select-edge-${id}`);
    await both(async h => h.click(await tool(h, 'Line direction')));
    await menuCheck(step, `direction-${id}`);
  }
  await both(async h => { await h.key('Escape'); await h.click(await h.edge('e1', 0.2)); await h.click(await h.edge('e4', 0.5), { modifiers: h.MOD.shift }); });
  await same(step, 'Shift-click adds a connection', selection);
  await same(step, 'toolbar for two connections', toolbar);
  await capture('select-edges');
  await both(async h => { await h.click(await h.card('t2'), { modifiers: h.MOD.shift }); });
  await same(step, 'toolbar for connections and a card', toolbar);
  await capture('select-mixed');
  await both(h => h.key('Escape'));
  // Hovering a card shows its resize and connection handles.
  await both(async h => { await h.move(await h.card('t2')); await delay(250); });
  await same(step, 'hover handles', h => h.ev(`[...document.querySelectorAll('.canvas-node-interaction-layer, .canvas-node-interaction-layer *')].map(e => e.className + ' ' + (e.dataset.resize ?? '') ).join('|')`), { normalize: () => 'see capture' });
  await captureLive('hover-card');
  await both(async h => { const n = await h.ca(`node('t2')`), p = await h.at(n.x + n.width, n.y + n.height / 2); await h.move(p); await delay(250); });
  await captureLive('hover-connection-point');
};

steps.context = async () => {
  const step = 'context';
  await both(async h => { await h.open(CANVAS); await SHIFT1(h); await h.settle(); });
  await same(step, 'state after opening', h => h.state());
  for (const [name, point] of [['text-card', h => h.card('t1', 0.5, 0.8)], ['note-card', h => h.card('f1', 0.5, 0.6)], ['heading-card', h => h.card('f2', 0.5, 0.7)], ['image-card', h => h.card('i1')], ['link-card', h => h.card('l1')],
    ['group', h => h.center('.canvas-group-label')], ['connection', h => h.edge('e1', 0.2)], ['connection-plain', h => h.edge('e4', 0.5)], ['background', h => h.at(300, 300)]]) {
    await both(async h => { await h.key('Escape'); await h.rightClick(await point(h)); });
    await same(step, `${name}: selection after right-click`, selection);
    await menuCheck(step, name);
    await delay(400);
    await same(step, `${name}: state after closing the menu with Escape`, h => h.state());
  }
  await both(async h => { await h.key('Escape'); await h.click(await h.card('t1', 0.5, 0.8)); await h.click(await h.card('t2'), { modifiers: h.MOD.shift }); await h.rightClick(await h.card('t2')); });
  await menuCheck(step, 'multi-selection');
  await both(async h => { await h.key('Escape'); await h.click(await h.card('f1', 0.5, 0.6)); await h.click(await h.card('i1'), { modifiers: h.MOD.shift }); await h.rightClick(await h.card('i1')); });
  await menuCheck(step, 'multi-files');
  await both(h => h.key('Escape'));
};

const menuItem = (h, title) => h.ev(`(() => { const item = [...document.querySelectorAll('.menu .menu-item')].find(e => e.querySelector('.menu-item-title')?.textContent === ${JSON.stringify(title)}); if (!item) throw new Error('No menu item ' + ${JSON.stringify(title)}); const r = item.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const CARD_BAR = index => `.canvas-card-menu .canvas-card-menu-button:nth-child(${index})`;
/** A point of bare background: the bottom-left corner of the surface. */
const background = async h => { const r = await h.ca(`wrapperRect()`); return { x: r.x + 24, y: r.y + r.height - 24 }; };
/** Ids of cards and connections that are not part of the fixture, in document order. */
const added = h => h.ca(`ids()`).then(ids => ({ nodes: ids.nodes.filter(id => !KNOWN.has(id)), edges: ids.edges.filter(id => !KNOWN.has(id)) }));
const editing = h => h.ev(`(() => { const n = document.querySelector('.canvas-node.is-editing'), frame = n?.querySelector('iframe.embed-iframe'); let inner = null; try { inner = frame?.contentDocument; } catch {} const active = inner?.activeElement; return { card: !!n, editor: !!(inner?.querySelector('.cm-editor') || n?.querySelector('.cm-editor')), focusInEditor: !!(active?.closest?.('.cm-editor') || document.activeElement?.closest?.('.cm-editor')), label: document.querySelector('.canvas-group-label[contenteditable="true"], .canvas-path-label.is-editing') ? document.activeElement?.className ?? '' : null }; })()`);

steps.edits = async () => {
  const step = 'edits';
  await both(async h => { await h.open(EDIT); await SHIFT1(h); await h.settle(); });
  await same(step, 'state after opening', h => h.state());
  await capture('edit-start');

  // Create a card by double-click and type into it.
  await both(async h => { await h.click(await h.at(-800, -100), { count: 2 }); await delay(500); });
  await same(step, 'double-click creates a card in edit mode', async h => ({ state: await h.state(), editing: await editing(h) }));
  await both(async h => { await h.type('Typed **text**'); await delay(300); });
  await captureLive('edit-card-editing');
  await both(async h => { await h.key('Escape'); await delay(200); });
  await same(step, 'Escape leaves the editor', async h => ({ state: await h.state(), editing: await editing(h) }));
  await fileSame(step, 'double-click card + typing');
  await both(async h => { await h.click(await background(h)); });
  await same(step, 'click on the background deselects', selection);

  // Card bar: text card (click), note, media, and a card dragged into place.
  await both(async h => { await h.click(await h.center(CARD_BAR(1))); await delay(500); await h.type('From the bar'); await delay(300); await h.key('Escape'); await h.click(await background(h)); });
  await fileSame(step, 'card bar: add card');
  await both(async h => { await h.click(await h.center(CARD_BAR(2))); await h.c.wait(`!!document.querySelector('.prompt')`, 'note picker'); await delay(300); });
  await same(step, 'note picker', h => h.ev(`({ placeholder: document.querySelector('.prompt input')?.placeholder, instructions: [...document.querySelectorAll('.prompt-instruction')].map(e => e.textContent) })`));
  await both(async h => { await h.type('Note'); await delay(500); });
  await same(step, 'note picker results for "Note"', h => h.ev(`[...document.querySelectorAll('.prompt .suggestion-item')].map(e => e.querySelector('.suggestion-title')?.textContent ?? e.textContent)`));
  await captureLive('picker-note', '.prompt');
  await both(async h => { await h.key('Enter'); await delay(500); });
  await same(step, 'state after adding a note', h => h.state());
  await fileSame(step, 'card bar: add note');
  await both(async h => { await h.click(await background(h)); await h.click(await h.center(CARD_BAR(3))); await h.c.wait(`!!document.querySelector('.prompt')`, 'media picker'); await delay(300); await h.type('pixel'); await delay(500); });
  await same(step, 'media picker results for "pixel"', h => h.ev(`({ placeholder: document.querySelector('.prompt input')?.placeholder, instructions: [...document.querySelectorAll('.prompt-instruction')].map(e => e.textContent), items: [...document.querySelectorAll('.prompt .suggestion-item')].map(e => e.querySelector('.suggestion-title')?.textContent ?? e.textContent) })`));
  await captureLive('picker-media', '.prompt');
  await both(async h => { await h.key('Enter'); await delay(900); });
  await fileSame(step, 'card bar: add media');
  await both(async h => { await h.click(await background(h)); const from = await h.center(CARD_BAR(1)), to = await h.at(700, -100); await h.press(from); await h.travel(from, to, 0, 10); h.dragTo = to; });
  await captureLive('drag-new-card');
  await both(async h => { await h.release(h.dragTo); await delay(500); await h.type('Dragged in'); await delay(300); await h.key('Escape'); await h.click(await background(h)); });
  await fileSame(step, 'card bar: drag a card into place');
  await capture('edit-after-adding');

  // Moving: plain, Shift axis lock, snapping to another card, and Alt (no snapping).
  const move = async (label, id, dx, dy, options = {}) => {
    await both(async h => { const from = await h.card(id, 0.5, 0.5), scale = Math.pow(2, (await h.state()).zoom); await h.drag(from, { x: from.x + dx * scale, y: from.y + dy * scale }, options); await h.click(await background(h)); });
    await same(step, `position after ${label}`, h => h.ca(`node(${JSON.stringify(id)})`));
    await fileSame(step, label);
  };
  await move('plain move', 'a', 113, 67);
  await move('Shift move (axis lock)', 'b', 131, 38, { modifiers: 8 });
  await move('move snapping to another card', 'c', 7, 9);
  await move('Alt move (no snapping)', 'c', 33, 27, { modifiers: 1 });
  await both(async h => { const from = await h.card('b'), scale = Math.pow(2, (await h.state()).zoom), to = { x: from.x - 40 * scale, y: from.y + 212 * scale }; await h.press(from); await h.travel(from, to, 0, 10); h.dragTo = to; await delay(200); });
  await captureLive('drag-snap-guides');
  await both(async h => { await h.release(h.dragTo); await h.click(await background(h)); });
  await fileSame(step, 'move with snap guides');

  // Resizing from an edge and from a corner (handles appear on hover).
  const resize = async (label, id, fx, fy, dx, dy) => {
    await both(async h => {
      const inside = await h.card(id), from = await h.card(id, fx, fy), scale = Math.pow(2, (await h.state()).zoom);
      await h.move(inside); await delay(200); await h.move(from); await delay(200);
      await h.drag(from, { x: from.x + dx * scale, y: from.y + dy * scale }); await h.click(await background(h));
    });
    await same(step, `size after ${label}`, h => h.ca(`node(${JSON.stringify(id)})`));
    await fileSame(step, label);
  };
  await resize('resize from the right edge', 'b', 1, 0.3, 63, 0);
  await resize('resize from the bottom edge', 'b', 0.3, 1, 0, 47);
  await resize('resize from the bottom-right corner', 'a', 1, 1, 52, 44);
  await resize('resize from the top-left corner', 'c', 0, 0, -36, -28);

  // Colour: a preset, then a custom value (the native colour dialog cannot be driven; the input is set and its events fired).
  await both(async h => { await h.click(await h.card('a')); await h.click(await tool(h, 'Set color')); await h.click(await h.center('.canvas-submenu .canvas-color-picker-item:nth-child(4)')); await delay(200); });
  await same(step, 'toolbar after choosing a preset colour', async h => ({ toolbar: await toolbar(h), submenu: await h.ev(`!!document.querySelector('.canvas-submenu')`) }));
  await fileSame(step, 'preset colour');
  await capture('edit-colour-preset');
  await both(async h => {
    await h.click(await h.card('b')); await h.click(await tool(h, 'Set color'));
    await h.ev(`(() => { const input = document.querySelector('.canvas-submenu input[type=color]'); input.value = '#3366cc'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await delay(300);
  });
  await fileSame(step, 'custom colour');
  await captureLive('edit-colour-custom');
  await both(async h => { await h.click(await background(h)); });

  // Group around a selection, named in place; renamed by double-click.
  await both(async h => { await h.click(await h.card('a')); await h.click(await h.card('c'), { modifiers: 8 }); await h.click(await tool(h, 'Create group')); await delay(400); });
  await same(step, 'new group is selected with its label in edit', async h => ({ selection: (await added(h)).nodes.length, editing: await editing(h), sel: (await h.state()).selection.length }));
  await captureLive('group-label-editing');
  await both(async h => { await h.type('My group'); await h.key('Enter', { text: '\r' }); await delay(300); });
  await fileSame(step, 'group around a selection + label');
  await both(async h => { await h.click(await background(h)); await h.click(await h.center('.canvas-group-label'), { count: 2 }); await delay(300); await h.type('Renamed'); await h.key('Enter', { text: '\r' }); await delay(300); await h.click(await background(h)); });
  await fileSame(step, 'group label renamed');
  await capture('edit-group');

  // Connections: drawn from a side handle, labelled, direction changed, removed.
  const connect = async (from, side, to, target) => both(async h => {
    const fx = side === 'left' ? 0 : side === 'right' ? 1 : 0.5, fy = side === 'top' ? 0 : side === 'bottom' ? 1 : 0.5;
    const inside = await h.card(from), start = await h.card(from, fx, fy), end = target ? await target(h) : await h.card(to, 0.1, 0.5);
    await h.move(inside); await delay(200); await h.move(start); await delay(250);
    await h.press(start); await h.travel(start, end, 0, 12); h.dragTo = end; await delay(150);
  });
  await connect('a', 'right', 'b');
  await captureLive('connect-dragging');
  await both(async h => { await h.release(h.dragTo); await delay(300); await h.click(await background(h)); });
  await fileSame(step, 'connection from a side handle');
  const newEdge = async h => (await added(h)).edges[0];
  await both(async h => { const id = await newEdge(h); await h.click(await h.edge(id, 0.5)); await h.click(await tool(h, 'Edit label')); await delay(300); });
  await same(step, 'connection label in edit', editing);
  await both(async h => { await h.type('link'); await delay(200); });
  await captureLive('connect-label-editing');
  await both(async h => { await h.click(await background(h)); await delay(300); });
  await fileSame(step, 'connection label');
  for (const direction of ['Bidirectional', 'Nondirectional', 'Unidirectional']) {
    await both(async h => { const id = await newEdge(h); await h.click(await h.edge(id, 0.25)); await h.click(await tool(h, 'Line direction')); await delay(200); await h.click(await menuItem(h, direction)); await delay(200); });
    await same(step, `toolbar after ${direction}`, toolbar);
    if (direction === 'Bidirectional') await capture('connect-bidirectional');
    await both(async h => { await h.click(await background(h)); });
    await fileSame(step, `direction ${direction}`);
  }
  await both(async h => { const id = await newEdge(h); await h.click(await h.edge(id, 0.25)); await h.click(await tool(h, 'Set color')); await h.click(await h.center('.canvas-submenu .canvas-color-picker-item:nth-child(6)')); await delay(200); await h.click(await background(h)); });
  await fileSame(step, 'connection colour');
  // A connection dropped on nothing offers to create its target.
  await connect('b', 'left', null, h => h.at(-60, -290));
  await both(async h => { await h.release(h.dragTo); await delay(300); });
  await same(step, 'menu after dropping a connection on nothing', h => h.menu());
  await captureLive('menu-connection-drop', '.menu').catch(error => note(step, error.message));
  await both(async h => { await h.click(await menuItem(h, 'Add card')); await delay(700); });
  await same(step, 'state after choosing Add card for a dropped connection', async h => ({ state: await h.state(), editing: (await editing(h)).card, added: await added(h).then(ids => [ids.nodes.length, ids.edges.length]) }));
  await both(async h => { await h.type('Target'); await delay(300); });
  await captureLive('connect-drop-card');
  await both(async h => { await h.key('Escape'); await delay(200); await h.click(await background(h)); });
  await same(step, 'state after finishing the dropped connection card', h => h.state());
  await both(async h => { const ids = await added(h); await h.click(await h.card(ids.nodes[ids.nodes.length - 1])); });
  await same(step, 'clicking the card created by the dropped connection selects it', h => h.state());
  await both(async h => { await h.click(await background(h)); });
  await fileSame(step, 'connection dropped on nothing -> Add card');
  await both(async h => { const id = await newEdge(h); await h.click(await h.edge(id, 0.25)); await delay(200); });
  await same(step, 'state with the connection selected before Delete', h => h.state());
  await both(async h => { await h.key('Delete'); await delay(200); });
  await fileSame(step, 'connection deleted with Delete');
  await both(async h => { const ids = await added(h); await h.click(await h.edge(ids.edges[0], 0.5)); await h.click(await tool(h, 'Remove')); await delay(200); });
  await fileSame(step, 'connection removed from the toolbar');

  // Removing a card, nudging with the arrow keys.
  await both(async h => { const ids = await added(h); await h.click(await h.card(ids.nodes[4])); await h.key('Backspace'); await delay(200); });
  await fileSame(step, 'card deleted with Backspace');
  await both(async h => { await h.click(await h.card('b')); await h.key('ArrowRight'); await delay(300); await h.key('ArrowDown', { modifiers: 8 }); await delay(300); await h.key('ArrowLeft'); await h.key('ArrowLeft'); await delay(300); });
  await same(step, 'position after arrow keys', h => h.ca(`node('b')`));
  await fileSame(step, 'arrow-key nudge');

  // Copy and paste through the canvas's own clipboard handlers (a synthetic clipboard event: the system clipboard is the owner's).
  await both(async h => {
    await h.click(await h.card('a')); await h.click(await h.card('b'), { modifiers: 8 });
    h.record.beforeCopy = await h.state();
    h.record.clipboard = await h.ev(`(() => { const data = new DataTransfer(), event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }); event.isRelayed = true; document.activeElement.dispatchEvent(event); window.__clip = data; return { types: [...data.types], text: data.getData('obsidian/canvas') }; })()`);
    await h.click(await background(h));
    await h.ev(`(() => { const event = new ClipboardEvent('paste', { clipboardData: window.__clip, bubbles: true, cancelable: true }); event.isRelayed = true; document.activeElement.dispatchEvent(event); })()`);
    await delay(400);
  });
  await same(step, 'state before copying', async h => h.record.beforeCopy);
  await same(step, 'clipboard payload', async h => ({ types: h.record.clipboard.types, text: normalizeIds(h.record.clipboard.text, KNOWN) }));
  await same(step, 'pasted cards are selected', async h => (await h.state()).selection.length);
  await fileSame(step, 'copy + paste');
  await both(async h => { await h.ev(`(() => { const data = new DataTransfer(); data.setData('text/plain', 'Pasted plain text'); const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }); event.isRelayed = true; document.activeElement.dispatchEvent(event); })()`); await delay(500); await h.key('Escape'); await h.click(await background(h)); });
  await observe(step, 'runtime and serialized stack after first frame', h => h.ca(`stack()`));
  await fileSame(step, 'paste plain text');
  await capture('edit-final');

  // Undo all the way back, then redo all the way forward.
  const data = h => h.ca(`data()`).then(text => normalizeIds(text, KNOWN).replace(/\},\{/g, '},\n{'));
  let undone = 0;
  for (; undone < 80; undone++) {
    const can = await both(async h => (await h.state()).undo);
    if (helpers.length === 2 && can.reference !== can.obsen) { note(step, `undo availability after ${undone} undos: reference ${can.reference}, obsen ${can.obsen}`); break; }
    if (!Object.values(can)[0]) break;
    await both(async h => { await h.key('z', { modifiers: 2 }); await delay(120); });
    await same(step, `document after undo ${undone + 1}`, data);
  }
  await same(step, 'undo steps available', async () => undone);
  await fileSame(step, 'undo to the beginning');
  let redone = 0;
  for (; redone < 80; redone++) {
    const can = await both(async h => (await h.state()).redo);
    if (helpers.length === 2 && can.reference !== can.obsen) { note(step, `redo availability after ${redone} redos: reference ${can.reference}, obsen ${can.obsen}`); break; }
    if (!Object.values(can)[0]) break;
    await both(async h => { await h.key(redone % 2 ? 'y' : 'z', { modifiers: redone % 2 ? 2 : 10 }); await delay(120); });
    await same(step, `document after redo ${redone + 1}`, data);
    if (redone === 36) await observe(step, 'runtime and serialized stack after final redo', h => h.ca(`stack()`));
  }
  await fileSame(step, 'redo to the end');
  // Without forcing it, an edit reaches the disk on its own.
  await both(async h => { await h.click(await h.card('a')); await h.key('ArrowUp'); });
  await delay(3500);
  await same(step, 'autosave within 3.5 s', h => h.ev(`window.__ca.text(${JSON.stringify(EDIT)})`), { normalize: text => normalizeIds(text, KNOWN) });
};

/** The export dialog as text: rows with their descriptions and controls. */
const dialogRows = h => h.ev(`(() => { const m = document.querySelector('.modal'); if (!m) return null; return { cls: m.className, title: m.querySelector('.modal-title')?.textContent, intro: m.querySelector('.modal-content > p')?.textContent,
  rows: [...m.querySelectorAll('.setting-item')].map(r => ({ cls: r.className, hidden: getComputedStyle(r).display === 'none', name: r.querySelector('.setting-item-name')?.textContent, desc: r.querySelector('.setting-item-description')?.textContent,
    control: [...r.querySelectorAll('.setting-item-control > *')].map(e => e.tagName.toLowerCase() + '.' + e.className + (e.tagName === 'SELECT' ? '=' + e.value + '[' + [...e.options].map(o => o.textContent).join('|') + ']' : e.tagName === 'INPUT' ? '=' + e.value + '[' + e.min + '..' + e.max + ' step ' + e.step + ']' : e.classList.contains('checkbox-container') ? '=' + e.classList.contains('is-enabled') : ':' + e.textContent)) })),
  buttons: [...m.querySelectorAll('button')].map(b => b.className + ':' + b.textContent) }; })()`);

steps.export = async () => {
  const step = 'export';
  await both(async h => { await h.open(CANVAS); await SHIFT1(h); await h.settle(); });
  // The native save dialog cannot be driven: it is answered with a path inside the fixture vault. The reference's progress
  // pop-up window (window.open) is given a hidden frame instead, so nothing appears on the desktop.
  await both(h => h.ev(`(() => {
    // Patch the same remote module used by canvas/export.ts; window.electron may
    // be the application IPC bridge rather than Electron's deprecated remote.
    const remote = require('electron').remote;
    remote.dialog.showSaveDialog = async () => { window.__canvasSaveDialogCalls = (window.__canvasSaveDialogCalls ?? 0) + 1; return { canceled: !window.__exportPath, filePath: window.__exportPath }; };
    if (window.__ca.reference && !window.__nativeOpen) {
      window.__nativeOpen = window.open;
      window.open = () => { const frame = document.createElement('iframe'); frame.style.display = 'none'; document.body.append(frame); const w = frame.contentWindow; w.close = () => frame.remove(); window.__progress = w; return w; };
    }
    return true;
  })()`));
  const openDialog = h => h.ev(`(async () => { window.__ca.app.commands.executeCommandById('canvas:export-as-image'); })()`).then(() => h.c.wait(`!!document.querySelector('.modal.mod-narrow')`, 'export dialog'));
  await both(async h => { await openDialog(h); await delay(300); });
  await same(step, 'export dialog rows (full canvas)', dialogRows);
  await captureLive('export-dialog', '.modal');
  await both(async h => { await h.ev(`(() => { const s = document.querySelector('.modal select'); s.value = 'viewport'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await delay(200); });
  await same(step, 'export dialog rows (viewport only)', dialogRows);
  await captureLive('export-dialog-viewport', '.modal');
  await both(async h => { await h.key('Escape'); await delay(300); });
  await same(step, 'Escape closes the export dialog without exporting', h => h.ev(`!document.querySelector('.modal')`));

  const exportOnce = async (name, { frame = 'full', logo = false, privacy = false, zoom = null } = {}) => {
    const sizes = await both(async h => {
      const file = `${DIR}/export-${h.name}-${name}.png`;
      await h.ev(`(async () => { const a = window.__ca.app; if (await a.vault.adapter.exists(${JSON.stringify(file)})) await a.vault.adapter.remove(${JSON.stringify(file)}); const base = typeof a.vault.adapter.getBasePath === 'function' ? a.vault.adapter.getBasePath() : a.vault.adapter.basePath; window.__exportPath = window.require('path').join(base, ${JSON.stringify(file)}); })()`);
      await openDialog(h); await delay(250);
      if (frame === 'viewport') await h.ev(`(() => { const s = document.querySelector('.modal select'); s.value = 'viewport'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      if (zoom !== null) await h.ev(`(() => { const s = document.querySelector('.modal input[type=range]'); s.value = ${JSON.stringify(String(zoom))}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const toggles = '.modal .setting-item.mod-toggle .checkbox-container';
      if (frame === 'full' && !logo) await h.click(await h.center(toggles));
      if (privacy) await h.click(await h.ev(`(() => { const all = document.querySelectorAll(${JSON.stringify(toggles)}), r = all[all.length - 1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
      await delay(150);
      h.record[`export-options-${name}`] = await dialogRows(h);
      // The hidden offscreen reference and our app can lay out this footer
      // differently during a canvas repaint; resolve and click the actual CTA.
      // The offscreen Electron fixtures can place the dialog footer outside
      // the native input hit-test region while the DOM remains visible. Use a
      // user-gesture-backed DOM click so this gate reaches the real Save
      // callback (the callback is still intercepted only at the file dialog).
      await h.ev(`document.querySelector('.modal button.mod-cta').click()`);
      h.record[`export-save-dialog-calls-${name}`] = await h.ev(`window.__canvasSaveDialogCalls ?? 0`);
      const deadline = Date.now() + 90000; let size = 0, stable = 0;
      while (Date.now() < deadline && stable < 3) { await delay(500); const now = await h.ev(`(async () => { const a = window.__ca.app; return (await a.vault.adapter.exists(${JSON.stringify(file)})) ? (await a.vault.adapter.stat(${JSON.stringify(file)})).size : 0; })()`); stable = now > 0 && now === size ? stable + 1 : 0; size = now; }
      if (!size) throw new Error(`No export file ${name} from ${h.name}`);
      await delay(1200); await h.settle(300);
      const base64 = await h.ev(`(async () => { const bytes = new Uint8Array(await window.__ca.app.vault.adapter.readBinary(${JSON.stringify(file)})); let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); })()`);
      const bytes = Buffer.from(base64, 'base64');
      await fs.writeFile(path.join(output, `${h.name}-export-${name}.png`), bytes);
      await h.ev(`document.querySelector('.notice-container')?.replaceChildren()`);
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    });
    for (const h of helpers) (h.record[step] ??= {})[`image ${name}`] = sizes[h.name];
    if (helpers.length === 2) { if (JSON.stringify(sizes.reference) === JSON.stringify(sizes.obsen)) passed.push(`${step}: dimensions of ${name} ${JSON.stringify(sizes.reference)}`); else note(step, `dimensions of ${name}: reference ${JSON.stringify(sizes.reference)}, obsen ${JSON.stringify(sizes.obsen)}`); }
    await same(step, `options used for ${name}`, async h => h.record[`export-options-${name}`]);
    await same(step, `state after exporting ${name}`, h => h.state());
  };
  await exportOnce('full');
  await exportOnce('full-logo', { logo: true });
  await exportOnce('full-half', { zoom: -1 });
  await exportOnce('full-privacy', { privacy: true });
  await exportOnce('viewport', { frame: 'viewport' });
  await both(async h => { await h.click(await h.center(`.canvas-controls .canvas-control-group:nth-child(2) .canvas-control-item:nth-child(1)`)); await h.settle(); });
  await exportOnce('viewport-zoomed', { frame: 'viewport' });
  await both(h => h.ev(`(() => { if (window.__nativeOpen) { window.open = window.__nativeOpen; window.__nativeOpen = null; } window.__exportPath = null; })()`));
};

const CONTROL = (group, item = 1) => `.canvas-controls .canvas-control-group:nth-child(${group}) .canvas-control-item:nth-child(${item})`;
const controls = h => h.ev(`[...document.querySelectorAll('.canvas-controls .canvas-control-group')].map(g => [...g.children].map(e => (e.getAttribute('aria-label') ?? '').replace(/\\n/g, ' / ') + (e.classList.contains('is-disabled') ? ' [disabled]' : '')))`);
const optionsFile = h => h.ev(`window.__ca.text('.obsidian/canvas.json').then(text => JSON.parse(text))`);

steps.settings = async () => {
  const step = 'settings';
  await both(async h => { await h.open(CANVAS); await SHIFT1(h); await h.settle(); });
  await same(step, 'control buttons', controls);
  await captureLive('controls', '.canvas-controls');
  await both(async h => { await h.click(await h.center(CONTROL(1))); });
  await menuCheck(step, 'settings', { close: false });
  for (const [label, title] of [['snap to grid off', 'Snap to grid'], ['snap to objects off', 'Snap to objects']]) {
    await both(async h => { if (!(await h.menu()).length) await h.click(await h.center(CONTROL(1))); await h.click(await menuItem(h, title)); await delay(700); });
    await same(step, `canvas.json after ${label}`, optionsFile);
    await both(async h => { await h.click(await h.center(CONTROL(1))); });
    await same(step, `settings menu after ${label}`, h => h.menu());
    await both(h => h.closeMenus());
  }
  // With both off, a card lands exactly where it is dropped.
  await both(async h => { const from = await h.card('t2'), scale = Math.pow(2, (await h.state()).zoom); await h.drag(from, { x: from.x + 27 * scale, y: from.y + 13 * scale }); await h.click(await background(h)); });
  await same(step, 'position after a move without snapping', h => h.ca(`node('t2')`));
  await fileSame(step, 'move without snapping');
  await both(async h => { await h.key('z', { modifiers: 2 }); await delay(300); });
  await fileSame(step, 'undo of that move');
  for (const title of ['Snap to grid', 'Snap to objects']) await both(async h => { await h.click(await h.center(CONTROL(1))); await h.click(await menuItem(h, title)); await delay(700); });
  await same(step, 'canvas.json after turning both back on', optionsFile);

  // Read-only.
  await both(async h => { await h.click(await h.center(CONTROL(1))); await h.click(await menuItem(h, 'Read-only')); await delay(400); await h.park(); });
  await same(step, 'state in read-only', h => h.state());
  await same(step, 'control buttons in read-only', controls);
  await capture('readonly');
  await both(async h => { await h.click(await h.card('t1', 0.5, 0.8)); });
  await same(step, 'toolbar in read-only', toolbar);
  await capture('readonly-selected');
  await both(async h => { await h.rightClick(await h.card('f1', 0.5, 0.6)); });
  await menuCheck(step, 'readonly-note-card');
  await both(async h => { await h.key('Escape'); await h.rightClick(await h.edge('e1', 0.2)); });
  await menuCheck(step, 'readonly-connection');
  await both(async h => { await h.key('Escape'); await h.rightClick(await background(h)); });
  await same(step, 'no background menu in read-only', h => h.menu());
  await both(async h => {
    await h.closeMenus(); await h.click(await background(h), { count: 2 }); await delay(300);
    const from = await h.card('t2'); await h.drag(from, { x: from.x + 60, y: from.y + 40 });
    await h.click(await h.card('t2')); await h.key('Delete'); await delay(200); await h.key('ArrowRight'); await delay(200);
    await h.click(await h.edge('e4', 0.5)); await delay(200);
  });
  await same(step, 'nothing changes in read-only (double-click, drag, Delete, arrow, connection click)', async h => ({ state: await h.state(), t2: await h.ca(`node('t2')`) }));
  await fileSame(step, 'read-only attempts');
  await both(async h => { await h.key('Escape'); await h.open(CANVAS, false); });
  await same(step, 'read-only survives reopening the file', async h => (await h.state()).readonly);
  await both(async h => { await h.click(await h.center(CONTROL(1))); await delay(400); });
  await same(step, 'the lock button leaves read-only', async h => ({ readonly: (await h.state()).readonly, controls: await controls(h), menu: await h.menu() }));
  await both(h => h.closeMenus());

  // Help.
  await both(async h => { await h.click(await h.center(CONTROL(4))); await h.c.wait(`!!document.querySelector('.modal')`, 'help dialog'); await delay(300); });
  await same(step, 'help dialog rows', h => h.ev(`({ cls: document.querySelector('.modal').className, title: document.querySelector('.modal-title')?.textContent, rows: [...document.querySelectorAll('.modal .canvas-instruction')].map(r => r.querySelector('.canvas-instruction-label')?.textContent + ': ' + [...r.querySelectorAll('.setting-hotkey')].map(k => k.textContent).join(' | ')) })`));
  await captureLive('help', '.modal');
  await both(async h => { await h.key('Escape'); await delay(300); });
};

steps.commands = async () => {
  const step = 'commands';
  // Convert a text card to a file.
  await both(async h => {
    await h.ev(`(async () => { const a = window.__ca.app; for (const p of ['Converted card.md', ${JSON.stringify(DIR + '/Converted card.md')}]) { const f = a.vault.getFileByPath(p); if (f) await a.vault.delete(f); } const f = a.vault.getFileByPath(${JSON.stringify(EDIT)}); await a.vault.modify(f, ${JSON.stringify(canvasText(EDIT_NODES, [{ id: 'ab', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }]))}); })()`);
    await delay(500); await h.open(EDIT); await SHIFT1(h); await h.settle();
  });
  await same(step, 'convert command unavailable without a selected text card', h => h.ev(`(() => { const c = window.__ca.app.commands; const cmd = c.findCommand?.('canvas:convert-to-file') ?? c.commands?.['canvas:convert-to-file']; return cmd?.checkCallback ? !!cmd.checkCallback(true) : 'no check'; })()`), { normalize: value => value === 'no check' ? false : value });
  await both(async h => { await h.click(await h.card('a')); await h.ev(`(async () => { window.__ca.app.commands.executeCommandById('canvas:convert-to-file'); })()`); await h.c.wait(`!!document.querySelector('.modal')`, 'convert prompt'); await delay(300); });
  await same(step, 'convert prompt', h => h.ev(`({ cls: document.querySelector('.modal').className, title: document.querySelector('.modal-title')?.textContent, value: document.querySelector('.modal textarea, .modal input')?.value, buttons: [...document.querySelectorAll('.modal button')].map(b => b.className + ':' + b.textContent) })`));
  await captureLive('convert-prompt', '.modal');
  await both(async h => { await h.ev(`(() => { const i = document.querySelector('.modal textarea, .modal input'); i.focus(); i.select(); })()`); await h.type('Converted card'); await delay(200); await h.key('Enter', { text: '\r' }); await delay(1200); });
  await same(step, 'converted file', h => h.ev(`(async () => { const a = window.__ca.app, f = a.vault.getFiles().find(x => x.name === 'Converted card.md'); return f ? { path: f.path, text: await a.vault.read(f) } : null; })()`));
  await same(step, 'state after converting', h => h.state());
  await fileSame(step, 'convert to file');
  await capture('converted');
  await both(async h => { await h.rightClick(await h.card('b')); });
  await same(step, 'text card menu still offers the conversion', async h => (await h.menu())[0]?.includes('Convert to file...'));
  await both(h => h.closeMenus());

  // Jump to group.
  await both(async h => { await h.open(CANVAS); await h.click(await h.card('t2')); await h.key('@', { code: 'Digit2', modifiers: 8, vk: 50 }); await h.settle(); await h.key('Escape'); await h.ev(`(async () => { window.__ca.app.commands.executeCommandById('canvas:jump-to-group'); })()`); await h.c.wait(`!!document.querySelector('.prompt')`, 'group prompt'); await delay(300); });
  await same(step, 'jump-to-group prompt', h => h.ev(`({ placeholder: document.querySelector('.prompt input')?.placeholder, items: [...document.querySelectorAll('.prompt .suggestion-item')].map(e => e.textContent), instructions: [...document.querySelectorAll('.prompt-instruction')].map(e => e.textContent) })`));
  await captureLive('jump-to-group', '.prompt');
  await both(async h => { await h.key('Enter'); await delay(300); await h.settle(300); });
  await same(step, 'viewport after jumping to the group', h => h.state());
  await capture('jumped-to-group');
};

steps.embed = async () => {
  const step = 'embed';
  await both(async h => {
    await h.ev(`(async () => { const a = window.__ca.app; for (const leaf of a.workspace.getLeavesOfType('canvas')) leaf.detach(); await new Promise(r => setTimeout(r, 400)); const leaf = a.workspace.getLeaf(); await leaf.openFile(a.vault.getFileByPath(${JSON.stringify(DIR + '/Embed.md')}), { state: { mode: 'preview' } }); const v = leaf.view; if (v.getMode?.() !== 'preview') await leaf.setViewState({ type: 'markdown', state: { ...v.getState(), mode: 'preview' } }); })()`);
    await h.c.wait(`!!document.querySelector('.markdown-reading-view .canvas-embed svg, .markdown-preview-view .canvas-embed svg')`, 'canvas embed in reading view');
    await delay(500); await h.park();
  });
  await same(step, 'embed element', h => h.ev(`(() => { const e = document.querySelector('.markdown-reading-view .canvas-embed') ?? document.querySelector('.markdown-preview-view .canvas-embed'); const r = e.getBoundingClientRect(), svg = e.querySelector('svg'), s = svg.getBoundingClientRect(); return { cls: e.className.split(' ').sort().join(' '), src: e.getAttribute('src'), alt: e.getAttribute('alt'), box: [Math.round(r.width), Math.round(r.height)], svgCls: svg.getAttribute('class'), svgBox: [Math.round(s.width), Math.round(s.height)], viewBox: svg.getAttribute('viewBox'), children: [...svg.children].map(c => c.tagName + '.' + (c.getAttribute('class') ?? '') + ' ' + ['x', 'y', 'width', 'height', 'rx', 'ry', 'd'].map(k => c.getAttribute(k)).filter(v => v !== null).join(' ') + ' ' + (c.getAttribute('style') ?? '')) }; })()`));
  await both(h => h.capture('embed-reading', '.workspace-leaf.mod-active .view-content').then(() => {}));
  await both(async h => { await h.click(await h.center('.markdown-reading-view .canvas-embed svg, .markdown-preview-view .canvas-embed svg')); await delay(1200); });
  await same(step, 'clicking the embed opens the canvas', h => h.ev(`({ type: window.__ca.app.workspace.activeLeaf?.view?.getViewType(), file: window.__ca.app.workspace.activeLeaf?.view?.file?.path })`));
};

// ---- Run ----

const failures = [];
try {
  for (const [id, run] of Object.entries(steps)) {
    if (wanted && id !== 'setup' && !wanted.includes(id)) continue;
    if (wanted && id === 'setup' && process.env.CANVAS_SKIP_SETUP) { await both(async h => { await h.c.send('Emulation.setFocusEmulationEnabled', { enabled: true }); await h.ev(ADAPTER); }); continue; }
    console.log(`Step ${id}`);
    try { await run(); } catch (error) { failures.push(`${id}: ${error.message}`); console.log(`  FAILED ${id}: ${error.message}`); await both(h => h.closeMenus().catch(() => {})); }
  }
  for (const h of helpers) h.record.errors = h.c.errors.slice();
  // DOM outlines of the paired captures.
  const outlines = {};
  if (helpers.length === 2 && process.env.CANVAS_NO_CAPTURE !== '1') for (const scenario of Object.keys(report.reference.captures ?? {})) {
    try {
      const [a, b] = await Promise.all(['reference', 'obsen'].map(async name => flatten(JSON.parse(await fs.readFile(path.join(output, `${name}-${scenario}.json`), 'utf8')).outline)));
      const diff = outlineDiff(a, b), ra = report.reference.captures[scenario], rb = report.obsen.captures?.[scenario];
      outlines[scenario] = { lines: [a.length, b.length], differing: diff.length, sameRect: JSON.stringify(ra) === JSON.stringify(rb), rects: [ra, rb], diff: diff.slice(0, 60) };
    } catch (error) { outlines[scenario] = { error: error.message }; }
  }
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify({ passed, problems, failures, report, outlines }, null, 2));
  await fs.writeFile(path.join(output, 'outline-report.json'), JSON.stringify(outlines, null, 2));
  console.log(`\n${passed.length} comparisons equal, ${problems.length} differences, ${failures.length} steps failed.`);
  for (const [scenario, o] of Object.entries(outlines)) if (o.error || o.differing || !o.sameRect) console.log(`  outline ${scenario}: ${o.error ?? `${o.differing} differing lines${o.sameRect ? '' : ', rect ' + JSON.stringify(o.rects)}`}`);
  for (const [name, record] of Object.entries(report)) if (record.errors?.length) console.log(`  ${name} renderer errors: ${JSON.stringify(record.errors.slice(0, 6))}`);
  if (failures.length || problems.length) process.exitCode = 1;
} finally { for (const [, c] of clients) c.socket.close(); }
