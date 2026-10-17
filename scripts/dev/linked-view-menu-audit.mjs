// Paired More-options linked-view submenu and Backlinks action check on owned hidden fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const ports = [['reference', Number(process.env.OBSEN_REFERENCE_PORT ?? 9457)], ['obsen', Number(process.env.OBSEN_SMOKE_PORT ?? 9447)]];
if (ports.some(([, port]) => [9229, 9342, 9352, 9444, 9454].includes(port))) throw new Error('Refusing non-owned fixture port');
const clients = await Promise.all(ports.map(async ([name, port]) => [name, await fixtureClient(port, name === 'reference' ? 'obsen-reference-audit-' : 'obsen-electron-smoke-', { waitForApp: true, separateHistoricalErrors: true })]));
const report = {};
const noteText = '# Linked menu\n\nMenu probe.\n';
try {
  for (const [name, c] of clients) {
    const result = report[name] = {};
    await c.wait(`!!(window.app??window.__obsenSmokeApp)`, `${name} window app binding`);
    for (let i = 0; i < 3 && await c.evaluate(`!!document.querySelector('.menu')`); i++) await c.key('Escape');
    await c.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp,ws=a.workspace,dir='Linked menu audit',p=dir+'/Linked menu.md';for(const l of [...ws.getLeavesOfType('backlink')])if(l.view.getState()?.file===p)l.detach();for(const l of [...ws.getLeavesOfType('markdown')])if(l.view.file?.path===p)l.detach();if(!a.vault.getFolderByPath(dir))await a.vault.createFolder(dir);const text=${JSON.stringify(noteText)};let f=a.vault.getFileByPath(p);if(f)await a.vault.modify(f,text);else f=await a.vault.create(p,text);const source=ws.getLeaf();await source.openFile(f);window.__linkedMenuAuditSource=source;return true})()`);
    await c.wait(`(window.app??window.__obsenSmokeApp).workspace.activeLeaf?.view?.file?.path==='Linked menu audit/Linked menu.md'`, `${name} menu note`);
    await delay(250);
    await c.click('.workspace-leaf.mod-active .view-actions [aria-label="More options"]');
    await c.wait(`!!document.querySelector('.menu .menu-item-title')`, `${name} More options menu`);
    result.menuBefore = await c.evaluate(`([...document.querySelectorAll('.menu .menu-item-title')].map(e=>e.textContent))`);
    const submenu = await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.menu .menu-item')].find(e=>e.querySelector('.menu-item-title')?.textContent==='Open linked view');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,cls:e.className}})()`);
    assert.ok(submenu, `${name} should show an Open linked view submenu`);
    result.submenuClass = submenu.cls;
    const parentPoint = await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.menu .menu-item')].find(e=>e.querySelector('.menu-item-title')?.textContent==='Open linked view');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...parentPoint });
    await c.wait(`document.querySelectorAll('.menu').length>1`, `${name} linked-view submenu`);
    result.submenuItems = await c.evaluate(`[...([...document.querySelectorAll('.menu')].at(-1)?.querySelectorAll('.menu-item-title')??[])].map(e=>e.textContent)`);
    assert.ok(result.submenuItems.includes('Open backlinks'), `${name} submenu should include Open backlinks`);
    await c.evaluate(`([...document.querySelectorAll('.menu')].at(-1).querySelectorAll('.menu-item')&&[...([...document.querySelectorAll('.menu')].at(-1)?.querySelectorAll('.menu-item')??[])].find(e=>e.querySelector('.menu-item-title')?.textContent==='Open backlinks')?.click())`);
    await c.wait(`(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('backlink').some(l=>l.view.getState()?.file==='Linked menu audit/Linked menu.md')`, `${name} linked Backlinks pane`);
    await delay(750);
    result.linkedPane = await c.evaluate(`(()=>{const ws=(window.app??window.__obsenSmokeApp).workspace,source=window.__linkedMenuAuditSource,pane=ws.getLeavesOfType('backlink').find(l=>l.view.getState()?.file==='Linked menu audit/Linked menu.md'&&l.group===source?.group);return{sourceType:source?.view.getViewType(),paneType:pane?.view.getViewType(),linked:!!source?.group&&source.group===pane?.group}})()`);
    await c.evaluate(`(()=>{const ws=(window.app??window.__obsenSmokeApp).workspace,l=ws.getLeavesOfType('backlink').find(l=>l.view.getState()?.file==='Linked menu audit/Linked menu.md');l?.detach();})()`);
    await c.key('Escape');
    result.errors = c.errors;
  }
  await fs.mkdir('dist/todo-backup/luna-linked-view-menu', { recursive: true });
  await fs.writeFile('dist/todo-backup/luna-linked-view-menu/report.json', JSON.stringify(report, null, 2));
  assert.deepEqual([...report.obsen.submenuItems].sort(), [...report.reference.submenuItems].sort());
  assert.deepEqual(report.obsen.linkedPane, { sourceType: 'markdown', paneType: 'backlink', linked: true });
  assert.deepEqual(report.reference.linkedPane, { sourceType: 'markdown', paneType: 'backlink', linked: true });
  assert.deepEqual(report.reference.errors, []);
  assert.deepEqual(report.obsen.errors, []);
  console.log('Linked-view submenu and Backlinks split match on both hidden fixtures.');
} finally { for (const [, c] of clients) c.socket.close(); }
