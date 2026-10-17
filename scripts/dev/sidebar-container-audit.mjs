import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/sidebar-container-comparison',report={};
await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
 const record=async action=>{await delay(250);steps.push({action,...await ev(`(()=>{const s=window.__containerAudit,l=s.leaf,v=l.view;return{type:v.getViewType(),leafConnected:l.containerEl.isConnected,viewConnected:v.containerEl.isConnected,contentConnected:v.contentEl?.isConnected??null,leafDistinct:l.containerEl!==v.containerEl,viewParentIsLeaf:v.containerEl.parentElement===l.containerEl,contentParentIsView:v.contentEl?.parentElement===v.containerEl,leafIdentity:s.root===l.containerEl,frameIdentity:s.frame===v.containerEl,contentIdentity:s.content===v.contentEl,markerConnected:s.marker?.isConnected??null,markerParentIsView:s.marker?.parentElement===v.containerEl,clicks:s.clicks??0};})()`)});};
 try{
  await ev(`(async()=>{const originals=[];app.workspace.iterateRootLeaves(l=>{originals.push(l);});for(const l of originals.slice(1))l.detach();app.workspace.setActiveLeaf(originals[0]);window.__containerAudit={previous:originals[0],created:[],windows:[]};const s=window.__containerAudit;if(!app.vault.getFileByPath('Container API.md'))await app.vault.create('Container API.md',${JSON.stringify('# Container heading\n')});s.main=app.workspace.getLeaf('tab');s.created.push(s.main);await s.main.openFile(app.vault.getFileByPath('Container API.md'));app.workspace.setActiveLeaf(s.main);app.workspace.rightSplit.expand();})()`);
  for(const type of ['file-explorer','search','bookmarks','backlink','outgoing-link','tag','outline','all-properties','file-properties']){
   await ev(`(async()=>{const s=window.__containerAudit;s.leaf=app.workspace.getRightLeaf(true);s.created.push(s.leaf);await s.leaf.setViewState({type:${JSON.stringify(type)}});app.workspace.revealLeaf(s.leaf);app.workspace.setActiveLeaf(s.main);})()`);await delay(200);
   await ev(`(()=>{const s=window.__containerAudit;s.root=s.leaf.containerEl;s.frame=s.leaf.view.containerEl;s.content=s.leaf.view.contentEl;s.marker=s.frame.ownerDocument.createElement('button');s.marker.textContent='fixture';s.clicks=0;s.marker.addEventListener('click',()=>s.clicks++);s.frame.append(s.marker);s.marker.click();})()`);
   await record(type+' attached elements');
   await ev(`(()=>{const s=window.__containerAudit;app.workspace.revealLeaf(s.main);app.workspace.revealLeaf(s.leaf);app.workspace.setActiveLeaf(s.main);s.marker.click();})()`);await record(type+' tab switches preserve elements');
   if(['backlink','outgoing-link','outline','file-properties'].includes(type)){
    await ev(`(()=>{const s=window.__containerAudit;s.sourceTabs=s.leaf.parent;s.pop=app.workspace.moveLeafToPopout(s.leaf,{size:{width:800,height:600}});s.windows.push(s.pop.win);})()`);
    await c.wait(`window.__containerAudit.leaf.view.containerEl.ownerDocument===window.__containerAudit.pop.win.document`,'view adopted by hidden popout');
    await ev(`window.__containerAudit.marker.click()`);await record(type+' popout preserves elements and listener');
    steps.push({action:type+' popout removes empty source group',...await ev(`(()=>{const s=window.__containerAudit;return{sourceEmpty:s.sourceTabs.children.length===0,sourceAttached:s.sourceTabs.parent?.children.includes(s.sourceTabs)??false};})()`)});
    await ev(`window.__containerAudit.pop.win.close()`);await delay(200);
    steps.push({action:type+' closed popout',...await ev(`(()=>{const s=window.__containerAudit;return{leafConnected:s.root.isConnected,frameConnected:s.frame.isConnected,markerConnected:s.marker.isConnected};})()`)});
   }else await ev(`(()=>{const s=window.__containerAudit;s.marker.remove();s.leaf.detach();})()`);
  }
  // Reuse one main leaf across independently owned native and hosted views.
  await ev(`(()=>{const s=window.__containerAudit;s.leaf=s.main;s.root=s.main.containerEl;})()`);
  for(const type of ['markdown','graph','empty','backlink','markdown']){
   await ev(`(async()=>{const s=window.__containerAudit;s.oldFrame=s.leaf.view.containerEl;await s.leaf.setViewState({type:${JSON.stringify(type)},state:{file:'Container API.md'},active:true});})()`);await delay(250);
   steps.push({action:'replacement '+type,...await ev(`(()=>{const s=window.__containerAudit,l=s.leaf,v=l.view;return{leafIdentity:s.root===l.containerEl,leafConnected:l.containerEl.isConnected,frameConnected:v.containerEl.isConnected,viewParentIsLeaf:v.containerEl.parentElement===l.containerEl,leafDistinct:l.containerEl!==v.containerEl,oldFrameConnected:s.oldFrame===v.containerEl?null:s.oldFrame.isConnected};})()`)});
  }
  await ev(`(async()=>{const s=window.__containerAudit;s.neighbor=app.workspace.getLeaf('tab');s.created.push(s.neighbor);await s.neighbor.openFile(app.vault.getFileByPath('Container API.md'));s.leaf=s.main;s.frame=s.main.view.containerEl;s.content=s.main.view.contentEl;s.marker=null;s.clicks=0;app.workspace.setActiveLeaf(s.main);})()`);
  await record('main view before reordering');
  await ev(`(()=>{const s=window.__containerAudit,tabs=s.main.parent;if(typeof tabs.insertChild==='function'){tabs.removeChild(s.main);tabs.insertChild(tabs.children.length,s.main);}else app.workspace.moveLeafToTabs(s.main,tabs,tabs.children.length);app.workspace.onLayoutChange?.();})()`);await record('main view reordered without remounting');
  for(const phase of ['stacked','unstacked']){
   await ev(`(()=>{const s=window.__containerAudit;app.workspace.setActiveLeaf(s.main);app.commands.executeCommandById('workspace:toggle-stacked-tabs');})()`);await delay(250);
   await record(phase+' tabs preserve view elements');
   steps.push({action:phase+' tab DOM order',...await ev(`(()=>{const s=window.__containerAudit,parent=s.main.containerEl.parentElement;return{order:[...parent.children].filter(e=>e===s.main.containerEl||e===s.neighbor.containerEl).map(e=>e===s.main.containerEl?'main':'neighbor'),mainLeft:s.main.containerEl.style.left,mainMinWidth:s.main.containerEl.style.minWidth,mainMaxWidth:s.main.containerEl.style.maxWidth};})()`)});
  }
  report[name]={steps,errors:c.errors};
 }finally{await ev(`(()=>{const s=window.__containerAudit;if(!s)return;for(const w of s.windows)if(!w.closed)w.close();for(const l of s.created)if(l.parent)l.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__containerAudit;})()`).catch(()=>{});c.socket.close();}
}
report.differences=report.reference.steps.flatMap((s,i)=>JSON.stringify(s)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:s,obsen:report.obsen.steps[i]}]);
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:report.reference.steps.length,differences:report.differences,errors:{reference:report.reference.errors,obsen:report.obsen.errors}},null,2));
assert.deepEqual(report.differences,[]);assert.deepEqual(report.reference.errors,[]);assert.deepEqual(report.obsen.errors,[]);
