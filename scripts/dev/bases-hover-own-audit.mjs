// Own-side Bases row hover proof, isolated to the owned 9447 temp fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const port=Number(process.env.OBSEN_SMOKE_PORT??9447);
if([9229,9342,9352,9444,9454,9457].includes(port))throw new Error('Refusing non-owned fixture port');
const c=await fixtureClient(port,'obsen-electron-smoke-',{waitForApp:true,separateHistoricalErrors:true});
const out='dist/todo-backup/luna-bases-hover';await fs.mkdir(out,{recursive:true});
const seeded=await c.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp,folder='Preview proof';if(!a.vault.getFolderByPath(folder))await a.vault.createFolder(folder);const put=async(p,t)=>{const f=a.vault.getFileByPath(p);if(f)await a.vault.modify(f,t);else await a.vault.create(p,t)};await put('Dataset/Row 1199.md','# Dataset row 1199\\n\\nBases hover target body.\\n');await put(folder+'/Audit.base','filters: file.inFolder("Dataset")\\nviews:\\n  - type: table\\n    name: Table\\n    order: [file.name]\\n');await put(folder+'/Bases embed.md','# Bases preview\\n\\n![[Audit.base]]\\n');const leaf=a.workspace.getLeaf();await leaf.openFile(a.vault.getFileByPath(folder+'/Bases embed.md'));if(!a.internalPlugins)leaf.view.setMode?.('preview');return true})()`);
await c.wait(`!!document.querySelector('.bases-embed a.internal-link')`,'Bases filename anchor');
const target=await c.evaluate(`(()=>{const a=document.querySelector('.bases-embed a.internal-link');if(!a)throw new Error('Bases anchor absent');for(const l of (window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('markdown'))if(l.containerEl.contains(a))l.hoverPopover?.hide?.();const r=a.getBoundingClientRect();window.__basesHoverEvents=[];app.workspace.on('hover-link',e=>window.__basesHoverEvents.push({source:e.source,linktext:e.linktext,ctrl:e.event?.ctrlKey}));return {x:r.x+5,y:r.y+5,href:a.dataset.href,text:a.innerText}})()`);
await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y,modifiers:2});
await c.evaluate(`(()=>{const a=document.querySelector('.bases-embed a.internal-link');a.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,view:window,clientX:${target.x},clientY:${target.y},ctrlKey:true}));})()`);
await delay(700);
const expectedBody=target.href.match(/Row (\d+)\.md/)?.[1];
const result={seeded,target,expectedBody,preview:await c.evaluate(`(()=>{const p=[...document.querySelectorAll('.hover-popover')].find(x=>x.innerText.includes('Dataset row ${expectedBody}.'));return {count:document.querySelectorAll('.hover-popover').length,matched:!!p,text:p?.innerText?.slice(0,120)??null,events:window.__basesHoverEvents}})()`),historicalErrors:c.historicalErrors,currentErrors:c.errors};
await fs.writeFile(`${out}/own-hover.json`,JSON.stringify(result,null,2));
assert.ok(result.preview.matched,'Bases row hover should render the target note preview');
assert.ok(result.preview.events.some(e=>e.source==='bases'&&e.linktext===result.target.href&&e.ctrl),'Bases event has expected source/path/modifier');
assert.equal(result.currentErrors.length,0,'No current renderer errors');
console.log(`Own Bases row hover passed: ${out}/own-hover.json`);
