// Hidden paired Bases embed and page-preview hover proof on the owned 9447/9457 fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const ports = [['reference', Number(process.env.OBSEN_REFERENCE_PORT ?? 9457)], ['obsen', Number(process.env.OBSEN_SMOKE_PORT ?? 9447)]];
if (ports.some(([, port]) => [9229, 9342, 9352, 9444, 9454].includes(port))) throw new Error('Refusing non-owned fixture port');
const clients = await Promise.all(ports.map(async ([name, port]) => [name, await fixtureClient(port, name === 'reference' ? 'obsen-reference-audit-' : 'obsen-electron-smoke-', { waitForApp: true })]));
const out = 'dist/todo-backup/luna-bases-hover'; await fs.mkdir(out, { recursive: true });
const data = {};
for (const [name, c] of clients) {
  data[name] = await c.evaluate(`(async()=>{
    const a=window.app??window.__obsenSmokeApp;
    const base='Preview proof/Audit.base', note='Preview proof/Bases embed.md', src='Preview proof/Bases source.md', target='Preview proof/Bases target.md';
    if(!a.vault.getFolderByPath('Preview proof')) await a.vault.createFolder('Preview proof');
    const put=async(p,t)=>{const f=a.vault.getFileByPath(p); if(f) await a.vault.modify(f,t); else await a.vault.create(p,t)};
    await put(base,'views:\\n  - type: table\\n    name: Items\\n    order:\\n      - file.name\\n');
    await put('Preview proof/Bases target.md','# Bases target\\n\\nRendered target body.\\n');
    await put(note,'# Bases preview\\n\\n![[Audit.base]]\\n');
    await put(src,'# Graph hover source\\n\\n[[Bases target]]\\n');
    await new Promise(r=>setTimeout(r,500));
    const leaf=a.workspace.getLeaf(); await leaf.openFile(a.vault.getFileByPath(note));
    const v=leaf.view;if(!a.internalPlugins)v.setMode?.('preview');
    return {coreBases:a.corePlugins?.isEnabled?.('bases')??null,viewType:v.getViewType?.(),file:v.file?.path};
  })()`);
  await c.wait(`!!document.querySelector('.bases-embed')`, `${name} Bases embed`);
  await c.wait(`document.querySelector('.bases-embed')?.querySelector('table, .bases-view')`, `${name} Bases output`);
  await c.wait(`!!document.querySelector('.bases-embed .internal-link[data-href]')`, `${name} Bases filename link`);
  data[name].baseDOM = await c.evaluate(`(()=>{const e=document.querySelector('.bases-embed');return {class:e?.className,table:!!e?.querySelector('table'),rows:e?.querySelectorAll('tr').length??0,view:!!e?.querySelector('.bases-view'),text:e?.innerText?.slice(0,120)}})()`);
  const point = await c.evaluate(`(()=>{const a=document.querySelector('.bases-embed .internal-link[data-href]');if(!a)throw new Error('Bases file link missing');for(const l of (window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('markdown'))l.hoverPopover?.hide?.();const r=a.getBoundingClientRect();return {x:r.x+5,y:r.y+5,href:a.dataset.href,text:a.innerText,tag:a.tagName}})()`);
  data[name].basesLink = point;
  const row = point.href.match(/Row (\d+)\.md/)?.[1];
  assert.ok(row, `Expected a dataset row link, received ${point.href}`);
  data[name].expectedPreviewText = `Dataset row ${row}.`;
  await c.evaluate(`(()=>{window.__basesHoverEvents=[];(window.app??window.__obsenSmokeApp).workspace.on('hover-link',e=>window.__basesHoverEvents.push({source:e.source,linktext:e.linktext,ctrlKey:e.event?.ctrlKey,targetConnected:e.targetEl?.isConnected}));})()`);
  // Reset the offscreen mouse position so an earlier synthetic or native hover
  // cannot leave the page-preview plugin in its dismissed state.
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await delay(100);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, modifiers: 2 });
  await c.evaluate(`(()=>{const a=document.querySelector('.bases-embed .internal-link[data-href]');a.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,view:window,clientX:${point.x},clientY:${point.y},ctrlKey:true}));})()`);
  await c.wait(`[...document.querySelectorAll('.hover-popover')].some(e=>e.innerText.includes(${JSON.stringify(data[name].expectedPreviewText)}))`, `${name} Bases link hover`);
  data[name].hover = await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.hover-popover')].find(x=>x.innerText.includes(${JSON.stringify(data[name].expectedPreviewText)}));return {count:document.querySelectorAll('.hover-popover').length, text:e?.innerText?.slice(0,180)??null, markdown:!!e?.querySelector('.markdown-preview-view'),registeredSources:Object.keys((window.app??window.__obsenSmokeApp).workspace.hoverLinkSources??{}),events:window.__basesHoverEvents}})()`);
  assert.ok(data[name].hover.events.some(e=>e.source==='bases'&&e.linktext===point.href&&e.ctrlKey), `${name} hover-link event should carry the Bases source, target and Ctrl modifier`);
  data[name].errors = [...c.errors];
}
await fs.writeFile(`${out}/report.json`, JSON.stringify(data,null,2));
assert.ok(data.reference.baseDOM.view && data.obsen.baseDOM.view, 'Both Bases embeds must render view output');
console.log(`Paired Bases and hover preview passed: ${out}/report.json`);
