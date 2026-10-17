import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const c=await fixtureClient(9352,'obsen-reference-audit-');
try {
  const path='Canvas-links-audit.canvas';
  const data=JSON.stringify({nodes:[{id:'text1',type:'text',text:'A canvas link to [[Projects/Alpha]]',x:0,y:0,width:300,height:100},{id:'file1',type:'file',file:'Projects/Alpha.md',x:350,y:0,width:300,height:100}],edges:[]});
  await c.evaluate(`(async()=>{const file=app.vault.getFileByPath(${JSON.stringify(path)});if(file)await app.vault.modify(file,${JSON.stringify(data)});else await app.vault.create(${JSON.stringify(path)},${JSON.stringify(data)});})()`);
  await delay(1500);
  const result=await c.evaluate(`({cache:app.metadataCache.getCache(${JSON.stringify(path)}),resolved:app.metadataCache.resolvedLinks[${JSON.stringify(path)}],unresolved:app.metadataCache.unresolvedLinks[${JSON.stringify(path)}]})`);
  await c.evaluate(`(async()=>{await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Projects/Alpha.md'));const leaf=app.workspace.getLeavesOfType('backlink')[0];await leaf.setViewState({type:'backlink',state:{file:'Projects/Alpha.md',unlinkedCollapsed:true,backlinkCollapsed:false,showSearch:false,searchQuery:''}});await app.workspace.revealLeaf(leaf)})()`);
  await delay(800);
  result.backlinks=await c.evaluate(`[...document.querySelectorAll('.workspace-leaf-content[data-type=backlink] .search-result')].map(e=>e.outerHTML)`);
  const onlyFile=JSON.parse(data);onlyFile.nodes[0].text='Unlinked canvas card';
  await c.evaluate(`app.vault.modify(app.vault.getFileByPath(${JSON.stringify(path)}),${JSON.stringify(JSON.stringify(onlyFile))})`);
  await delay(1200);
  result.fileCardOnly=await c.evaluate(`({resolved:app.metadataCache.resolvedLinks[${JSON.stringify(path)}],backlink:[...document.querySelectorAll('.workspace-leaf-content[data-type=backlink] .search-result')].find(e=>e.querySelector('.tree-item-inner')?.textContent===${JSON.stringify(path)})?.outerHTML})`);
  await c.evaluate(`app.vault.modify(app.vault.getFileByPath(${JSON.stringify(path)}),${JSON.stringify(data)})`);await delay(1200);
  await fs.writeFile('dist/todo-backup/sidebar-canvas-reference.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({cache:result.cache,resolved:result.resolved,fileCardOnly:result.fileCardOnly},null,2));
}finally{c.socket.close()}
