import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/line-break-comparison',report={};await fs.mkdir(output,{recursive:true});
const cases=[['paragraph','First line\nSecond line'],['hard break','First line  \nSecond line'],['quote','> First line\n> Second line'],['list','- First line\n  Second line']];
for(const [name,port,prefix]of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),steps=[];
 const saved=await c.evaluate(`app.vault.getConfig('strictLineBreaks')`);
 try{
  await c.evaluate(`(()=>{window.__breakAudit={previous:app.workspace.activeLeaf,leaf:app.workspace.getLeaf('tab')};})()`);
  for(const strict of [false,true])for(const [label,source]of cases){
   await c.evaluate(`(async()=>{app.vault.setConfig('strictLineBreaks',${strict});const p='Line break audit.md',f=app.vault.getFileByPath(p);if(f)await app.vault.modify(f,${JSON.stringify(source)});else await app.vault.create(p,${JSON.stringify(source)});})()`);await delay(250);
   await c.evaluate(`(async()=>{const l=window.__breakAudit.leaf;await l.setViewState({type:'markdown',state:{file:'Line break audit.md',mode:'preview'},active:true});await l.view.previewMode.rerender(true);})()`);await delay(250);
   steps.push({label,strict,...await c.evaluate(`(async()=>{const l=window.__breakAudit.leaf;return {source:await app.vault.read(l.view.file),paragraphs:[...l.containerEl.querySelectorAll('.markdown-preview-section p')].map(p=>({text:p.textContent,breaks:p.querySelectorAll('br').length}))};})()`)});
  }
  report[name]={steps,errors:c.errors};
 }finally{await c.evaluate(`(()=>{app.vault.setConfig('strictLineBreaks',${JSON.stringify(saved)});const s=window.__breakAudit;s.leaf.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__breakAudit;})()`);c.socket.close();}
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));assert.deepEqual(report.obsen,report.reference);assert.deepEqual(report.obsen.errors,[]);assert.equal(report.obsen.steps.length,8);console.log('Eight paired soft/hard line-break preference checks passed.');
