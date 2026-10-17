import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const report={},file='Fold search '+Date.now()+'.md',text='# First\n\nHidden needle body.\n\n# Second\n\nVisible body.\n';
for(const[name,port,prefix]of[['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true});
 try{
  await c.evaluate(`(async()=>{const s=window.__foldSearch={previous:app.workspace.activeLeaf,leaf:app.workspace.getLeaf('tab')};await app.vault.create(${JSON.stringify(file)},${JSON.stringify(text)});await s.leaf.setViewState({type:'markdown',state:{file:${JSON.stringify(file)},mode:'preview'},active:true});s.leaf.containerEl.dataset.foldSearch='true';app.workspace.setActiveLeaf(s.leaf);})()`);
  await delay(500);await c.click('[data-fold-search] .heading-collapse-indicator');
  await c.evaluate(`(()=>{app.workspace.setActiveLeaf(window.__foldSearch.leaf);return app.commands.executeCommandById('editor:open-search');})()`);
  await c.wait(`!!document.querySelector('[data-fold-search] .document-search-container input')`,'search');
  await c.evaluate(`(()=>{const i=document.querySelector('[data-fold-search] .document-search-container input');i.value='needle';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(500);
  report[name]=await c.evaluate(`(()=>{const root=document.querySelector('[data-fold-search]');return {collapsed:root.querySelector('.el-h1').className,preview:root.querySelector('.markdown-preview-section').textContent,count:root.querySelector('.document-search-count')?.textContent,inputClass:root.querySelector('.document-search-container input').className};})()`);report[name].errors=c.errors;
 }finally{await c.evaluate(`(()=>{const s=window.__foldSearch;if(s.previous?.parent){s.leaf.detach();app.workspace.setActiveLeaf(s.previous);}else void s.leaf.setViewState({type:'empty'});delete window.__foldSearch;})()`).catch(()=>{});c.socket.close();}
}
await fs.writeFile('dist/todo-backup/fold-search-probe.json',JSON.stringify(report,null,2));console.log(report);
