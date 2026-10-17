// Paired hidden local-graph hover check on the owned 9447/9457 fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const ports=[['reference',Number(process.env.OBSEN_REFERENCE_PORT??9457)],['obsen',Number(process.env.OBSEN_SMOKE_PORT??9447)]];
if(ports.some(([,p])=>[9229,9342,9352,9444,9454].includes(p))) throw new Error('Refusing non-owned fixture port');
const clients=await Promise.all(ports.map(async([n,p])=>[n,await fixtureClient(p,n==='reference'?'obsen-reference-audit-':'obsen-electron-smoke-',{waitForApp:true})]));
const out='dist/todo-backup/luna-graph-hover';await fs.mkdir(out,{recursive:true});
const result={};
for(const [name,c] of clients){
  result[name]={opened:await c.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp, folder='Preview proof';for(const l of a.workspace.getLeavesOfType('localgraph'))l.detach();if(!a.vault.getFolderByPath(folder))await a.vault.createFolder(folder);const put=async(p,t)=>{const f=a.vault.getFileByPath(p);if(f)await a.vault.modify(f,t);else await a.vault.create(p,t)};await put(folder+'/Graph hover source.md','# Graph hover source\\n\\n[[Graph hover target]]\\n');await put(folder+'/Graph hover target.md','# Graph hover target\\n\\nGraph hover target body.\\n');await put(folder+'/Graph hover other.md','# Other\\n');await new Promise(r=>setTimeout(r,400));const leaf=a.workspace.getLeaf();await leaf.openFile(a.vault.getFileByPath(folder+'/Graph hover source.md'));await new Promise(r=>setTimeout(r,300));if(a.commands.findCommand?.('graph:open-local')||a.commands.commands?.['graph:open-local'])await a.commands.executeCommandById('graph:open-local');else await a.workspace.createLeafBySplit(a.workspace.activeLeaf,'vertical').setViewState({type:'localgraph',active:true,group:a.workspace.activeLeaf,state:{file:folder+'/Graph hover source.md'}});return true})()`) };
  await c.wait(`!!(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph').find(l=>{const r=l.view.contentEl?.querySelector('canvas')?.getBoundingClientRect();return r?.width>100&&r?.height>100})`,'local graph');
  await c.wait(`(()=>{const l=(window.app??window.__obsenSmokeApp).workspace.getLeavesOfType('localgraph').find(l=>{const r=l.view.contentEl?.querySelector('canvas')?.getBoundingClientRect();return r?.width>100&&r?.height>100}),e=l?.view?.engine??l?.view?.dataEngine;return (e?.renderer?.nodes?.length??0)>0 || Number(l?.view?.contentEl?.querySelector('canvas')?.dataset.graphNodes??0)>0 || !!l?.view?.contentEl?.querySelector('.publish-graph-accessible li')})()`,'graph nodes');
  await delay(1500);
  result[name].scan=await c.evaluate(`(()=>{const a=window.app??window.__obsenSmokeApp,l=a.workspace.getLeavesOfType('localgraph').find(l=>{const r=l.view.contentEl?.querySelector('canvas')?.getBoundingClientRect();return r?.width>100&&r?.height>100}),canvas=l.view.contentEl.querySelector('canvas'),r=canvas.getBoundingClientRect(),events=[];a.workspace.on('hover-link',e=>events.push({source:e.source,linktext:e.linktext}));for(let y=Math.max(r.top+3,40);y<Math.min(r.bottom-3,850);y+=8)for(let x=Math.max(r.left+3,40);x<Math.min(r.right-3,1200);x+=8){canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:x,clientY:y,pointerId:1,pointerType:'mouse',isPrimary:true,ctrlKey:true}));if(canvas.dataset.graphHover==='Preview proof/Graph hover target.md')return {target:true,x,y,hover:canvas.dataset.graphHover,events,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};}return {target:false,hover:canvas.dataset.graphHover??null,events,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()`);
  await delay(1400);
  result[name].popover=await c.evaluate(`(()=>{const p=[...document.querySelectorAll('.hover-popover')].find(x=>x.innerText.includes('Graph hover target body'));return {count:document.querySelectorAll('.hover-popover').length,matched:!!p,text:p?.innerText?.slice(0,160)??null}})()`);
  result[name].errors=[...c.errors];
}
await fs.writeFile(`${out}/report.json`,JSON.stringify(result,null,2));
assert.equal(result.obsen.scan.target,true,'Own Pixi graph must hit-test the target note node');
assert.ok(result.obsen.scan.events.some(e=>e.source==='graph'&&e.linktext==='Preview proof/Graph hover target.md'),'Own hover callback must emit the graph hover-link event');
assert.ok(result.obsen.popover.matched,'Own graph hover must render the matching note preview');
console.log(`Paired graph hover passed: ${out}/report.json`);
