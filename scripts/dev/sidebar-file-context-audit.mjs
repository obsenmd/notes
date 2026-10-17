import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/sidebar-file-context-comparison',report={},containers={},types=['backlink','outgoing-link','outline','file-properties'];
const notes=[['Sidebar context A.md','---\nstatus: active\n---\n# Alpha heading\n\n[[Sidebar context B]]\n'],['Sidebar context B.md','---\nstatus: archived\n---\n# Beta heading\n\n[[Sidebar context A]]\n']];
await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
 const record=async action=>{await delay(350);steps.push({action,...await ev(`(()=>{const s=window.__sidebarContext;return{activeFile:app.workspace.getActiveFile()?.path??null,panes:s.panes.map(l=>{const type=l.view.getViewType(),root=[...document.querySelectorAll('.workspace-leaf-content[data-type='+type+']')].at(-1);return{type,file:l.view.getState().file??null,pinned:l.pinned,text:root?.querySelector('.view-content')?.innerText.replace(/\\s+/g,' ').trim()??''};})};})()`)});};
 try{
  await ev(`(async()=>{window.__sidebarContext={panes:[],previous:app.workspace.activeLeaf};for(const [path,text]of ${JSON.stringify(notes)}){const old=app.vault.getFileByPath(path);if(old)await app.vault.modify(old,text);else await app.vault.create(path,text);}const s=window.__sidebarContext;s.main=app.workspace.getLeaf('tab');await s.main.openFile(app.vault.getFileByPath('Sidebar context A.md'));app.workspace.setActiveLeaf(s.main);app.workspace.rightSplit.expand();for(const type of ${JSON.stringify(types)}){const leaf=app.workspace.getRightLeaf(true);s.panes.push(leaf);await leaf.setViewState({type,state:{file:'Sidebar context A.md'}});}})()`);
  await c.wait(`!!app.metadataCache.getFileCache(app.vault.getFileByPath('Sidebar context A.md'))?.headings?.length`,'context metadata');await record('note A active');
  containers[name]=await ev(`window.__sidebarContext.panes.map(l=>({type:l.view.getViewType(),leafContainerAttached:l.containerEl.isConnected,viewContainerAttached:l.view.containerEl.isConnected}))`);
  await ev(`(async()=>{const s=window.__sidebarContext;await s.main.setViewState({type:'graph',state:{},active:true});app.workspace.setActiveLeaf(s.main);})()`);await record('graph active');
  await ev(`(async()=>{const s=window.__sidebarContext;await s.main.setViewState({type:'empty',state:{},active:true});app.workspace.setActiveLeaf(s.main);})()`);await record('empty active');
  await ev(`(async()=>{const s=window.__sidebarContext;await s.main.openFile(app.vault.getFileByPath('Sidebar context B.md'));app.workspace.setActiveLeaf(s.main);})()`);await record('note B active');
  await ev(`(()=>{const s=window.__sidebarContext;for(const l of s.panes)l.setPinned(true);})()`);await record('panes pinned to B');
  await ev(`(async()=>{const s=window.__sidebarContext;await s.main.openFile(app.vault.getFileByPath('Sidebar context A.md'));app.workspace.setActiveLeaf(s.main);})()`);await record('note A with pinned B panes');
  await ev(`(()=>{const s=window.__sidebarContext;for(const l of s.panes)l.setPinned(false);})()`);await record('panes unpinned');
  await ev(`(async()=>{const s=window.__sidebarContext;await s.main.openFile(app.vault.getFileByPath('Sidebar context B.md'));app.workspace.setActiveLeaf(s.main);})()`);await record('unpinned panes follow next file change');
  await ev(`(async()=>{const s=window.__sidebarContext;for(const l of s.panes)l.setPinned(true);const old=app.vault.getFileByPath('Sidebar context renamed.md');if(old)await app.vault.delete(old);await app.vault.rename(app.vault.getFileByPath('Sidebar context B.md'),'Sidebar context renamed.md');})()`);await record('pinned followed file renamed');
  await ev(`(async()=>{await app.vault.delete(app.vault.getFileByPath('Sidebar context renamed.md'));})()`);await record('pinned followed file deleted');
  await ev(`(()=>{for(const l of window.__sidebarContext.panes)l.setPinned(false);})()`);await record('deleted-file panes unpinned');
  await ev(`(async()=>{const s=window.__sidebarContext;await s.main.setViewState({type:'graph',state:{},active:true});app.workspace.setActiveLeaf(s.main);})()`);await record('graph after deletion and unpin');
  await ev(`(async()=>{const s=window.__sidebarContext;await s.main.openFile(app.vault.getFileByPath('Sidebar context A.md'));app.workspace.setActiveLeaf(s.main);})()`);await record('note A after deleted-file panes');
  report[name]={steps,errors:c.errors};
 }finally{await ev(`(()=>{const s=window.__sidebarContext;if(!s)return;for(const l of s.panes)l.detach();s.main?.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__sidebarContext;})()`).catch(()=>{});c.socket.close();}
}
report.differences=report.reference.steps.flatMap((step,i)=>JSON.stringify(step)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:step,obsen:report.obsen.steps[i]}]);await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));await fs.writeFile(output+'/container-api-difference.json',JSON.stringify(containers,null,2));console.log(JSON.stringify({steps:report.reference.steps.length,differences:report.differences.map(({reference,obsen})=>({action:reference.action,reference:reference.panes,obsen:obsen.panes})),errors:{reference:report.reference.errors,obsen:report.obsen.errors}},null,2));assert.equal(report.differences.length,0,'See paired report');assert.deepEqual(report.reference.errors,[]);assert.deepEqual(report.obsen.errors,[]);
