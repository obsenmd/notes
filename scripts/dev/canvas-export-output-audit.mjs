// Paired output-level canvas export audit for the guarded hidden fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const appPort = Number(process.env.CANVAS_OBSEN_PORT ?? 9444);
const referencePort = Number(process.env.CANVAS_REFERENCE_PORT ?? 9454);
if ([9229, 9342, 9347, 9352, 9357, 9447, 9457].includes(appPort) || [9229, 9342, 9347, 9352, 9357, 9447, 9457].includes(referencePort)) throw new Error('Refusing to use a fixture port owned by another task.');
const out = process.argv[2] ?? 'dist/luna-canvas/canvas-export-output';
await fs.mkdir(out, { recursive: true });
const clients = [
  ['reference', await fixtureClient(referencePort, 'obsen-reference-audit-', { waitForApp: true })],
  ['obsen', await fixtureClient(appPort, 'obsen-electron-smoke-', { waitForApp: true })],
];
const file = 'Canvas audit/Audit.canvas';
const note = '# First\n\nIntro paragraph of the note.\n\n## Second\n\nBody of the second section.\n';
const nodes = [
  { id: 'text', type: 'text', x: -320, y: -180, width: 300, height: 150, text: '# Export sample\n\nPrivate phrase: amber cedar **quality**.' },
  { id: 'file', type: 'file', x: 160, y: -180, width: 320, height: 240, file: 'Canvas audit/Note.md' },
];
const canvas = JSON.stringify({ nodes, edges: [] }, null, 2);
const report = { fixtures: {}, variants: {} };

const prepare = async (name, c) => {
  await c.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp,p=${JSON.stringify(file)},np='Canvas audit/Note.md';if(!a.vault.getFolderByPath('Canvas audit'))await a.vault.createFolder('Canvas audit');const old=a.vault.getFileByPath(p);if(old)await a.vault.modify(old,${JSON.stringify(canvas)});else await a.vault.create(p,${JSON.stringify(canvas)});const note=a.vault.getFileByPath(np);if(note)await a.vault.modify(note,${JSON.stringify(note)});else await a.vault.create(np,${JSON.stringify(note)});await a.workspace.getLeaf().openFile(a.vault.getFileByPath(p));const leaf=a.workspace.getLeavesOfType('canvas').find(x=>x.view.file?.path===p);if(!leaf)throw Error('Canvas view did not open');window.__canvasExportAudit={calls:0,original:require('electron').remote.dialog.showSaveDialog};require('electron').remote.dialog.showSaveDialog=async()=>{window.__canvasExportAudit.calls++;return{canceled:false,filePath:window.__canvasExportAudit.path}};return {path:a.vault.adapter.getBasePath?.()??a.vault.adapter.basePath}})()`);
  report.fixtures[name] = { port: c.port, vault: await c.evaluate(`(window.app??window.__obsenSmokeApp).vault.adapter.getBasePath?.()??(window.app??window.__obsenSmokeApp).vault.adapter.basePath`) };
};

const renderedNote = async (c, name) => {
  const text = await c.evaluate(`(()=>{const nodes=[...document.querySelectorAll('.canvas-node')];const n=nodes.find(x=>x.innerText?.includes('Intro paragraph of the note.'));if(!n)return nodes.map(x=>x.innerText).join(' | ');const parts=[n.innerText??'',...Array.from(n.querySelectorAll('iframe')).map(f=>{try{return f.contentDocument?.body?.innerText??''}catch{return ''}})];return parts.join(' ').replace(/\\s+/g,' ').trim()})()`);
  assert.ok(text?.includes('Intro paragraph of the note.') && text.includes('Body of the second section.'), `${name}: seeded note content is not rendered: ${text}`);
  return text;
};

const exportVariant = async (name, c, variant) => {
  const rel = `Canvas audit/output-${variant}.png`;
  // A Page capture activates Chromium's compositor for the hidden/offscreen
  // fixture before Save starts moving and resizing the canvas viewport.
  await c.send('Page.captureScreenshot', { format: 'png' });
  await c.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp,p=${JSON.stringify(rel)};if(await a.vault.adapter.exists(p))await a.vault.adapter.remove(p);const base=a.vault.adapter.getBasePath?.()??a.vault.adapter.basePath;window.__canvasExportAudit.path=window.require('path').join(base,p);window.__canvasExportAudit.calls=0;await a.commands.executeCommandById('canvas:export-as-image')})()`);
  await c.wait(`!!document.querySelector('.modal.mod-narrow')`, `${name} ${variant} export dialog`);
  if (variant === 'viewport') await c.evaluate(`(()=>{const s=document.querySelector('.modal select');s.value='viewport';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  if (variant === 'half') await c.evaluate(`(()=>{const s=document.querySelector('.modal input[type=range]');s.value='-1';s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  if (variant === 'plain' || variant === 'half' || variant === 'privacy') await c.evaluate(`document.querySelector('.modal .setting-item.mod-toggle .checkbox-container').click()`);
  if (variant === 'privacy') await c.evaluate(`document.querySelectorAll('.modal .setting-item.mod-toggle .checkbox-container')[1].click()`);
  const options = await c.evaluate(`(()=>({rows:[...document.querySelectorAll('.modal .setting-item')].map(r=>({name:r.querySelector('.setting-item-name')?.textContent,hidden:getComputedStyle(r).display==='none',desc:r.querySelector('.setting-item-description')?.textContent,control:r.querySelector('select')?.value??r.querySelector('input[type=range]')?.value??r.querySelector('.checkbox-container')?.className??null}))}))()`);
  await c.evaluate(`document.querySelector('.modal button.mod-cta').click()`);
  const deadline = Date.now() + 30000;
  let size = 0;
  while (Date.now() < deadline) {
    size = await c.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp,p=${JSON.stringify(rel)};return await a.vault.adapter.exists(p)?(await a.vault.adapter.stat(p)).size:0})()`);
    if (size > 0) break;
    await delay(200);
  }
  assert.ok(size > 0, `${name} ${variant}: save dialog called but PNG was not written`);
  const png = await c.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp,b=new Uint8Array(await a.vault.adapter.readBinary(${JSON.stringify(rel)}));let s='';for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(s)})()`);
  const bytes = Buffer.from(png, 'base64');
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const destination = path.join(out, `${name}-${variant}.png`);
  await fs.writeFile(destination, bytes);
  const result = { path: destination, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, saveDialogCalls: await c.evaluate('window.__canvasExportAudit.calls'), options, errors: [...c.errors] };
  assert.equal(result.saveDialogCalls, 1, `${name} ${variant}: expected one real Save callback`);
  assert.deepEqual(result.errors, [], `${name} ${variant}: renderer errors`);
  report.variants[`${name}-${variant}`] = result;
  await c.evaluate(`document.querySelector('.notice-container')?.replaceChildren()`);
  return result;
};

try {
  for (const [name, c] of clients) await prepare(name, c);
  const rendered = {};
  for (const [name, c] of clients) {
    const deadline = Date.now() + 15000;
    let content = '';
    while (Date.now() < deadline) {
      try { content = await renderedNote(c, name); break; } catch { await delay(250); }
    }
    rendered[name] = content;
  }
  assert.equal(rendered.reference, rendered.obsen, 'rendered note content must match before any export');
  report.renderedContent = rendered;
  const variants = ['logo', 'plain', 'half', 'privacy', 'viewport'];
  for (const variant of variants) {
    const values = await Promise.all(clients.map(([name, c]) => exportVariant(name, c, variant).then(value => [name, value])));
    const paired = Object.fromEntries(values);
    if (variant === 'logo') assert.equal(paired.reference.width, paired.obsen.width, 'logo export widths');
    if (variant === 'logo') assert.equal(paired.reference.height, paired.obsen.height, 'logo export heights');
    if (variant === 'plain') assert.equal(paired.reference.height, paired.obsen.height, 'plain full export heights');
    if (variant === 'half') assert.equal(paired.obsen.width * 2, report.variants['obsen-plain'].width, 'half-scale export width');
    if (variant === 'half') assert.equal(paired.obsen.height * 2, report.variants['obsen-plain'].height, 'half-scale export height');
    if (variant === 'viewport') assert.ok(paired.reference.width > 0 && paired.obsen.width > 0 && paired.reference.height > 0 && paired.obsen.height > 0, 'viewport output dimensions');
  }
  for (const [name, c] of clients) {
    await c.evaluate(`(()=>{const a=window.app??window.__obsenSmokeApp,r=require('electron').remote.dialog; if(window.__canvasExportAudit?.original)r.showSaveDialog=window.__canvasExportAudit.original;})()`);
    report.fixtures[name].rendererErrors = [...c.errors];
  }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Paired canvas PNG output audit passed: ${path.join(out, 'report.json')}`);
} catch (error) {
  report.failure = String(error?.stack ?? error);
  for (const [name, c] of clients) report.fixtures[name] = { ...(report.fixtures[name] ?? {}), rendererErrors: [...c.errors] };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally { for (const [, c] of clients) c.socket.close(); }
