import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/sidebar-linked-pane-comparison',report={},types=['backlink','outgoing-link','outline','file-properties'];
await fs.mkdir(output,{recursive:true});
const notes=['A','B','C'].map(label=>['Linked pane '+label+'.md',`---\nstatus: ${label.toLowerCase()}\n---\n# Heading ${label}\n\n[[Linked pane ${label==='C'?'A':'C'}]]\n`]);
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
 const record=async action=>{await delay(350);steps.push({action,...await ev(`(()=>{const s=window.__linkedPaneAudit,w=app.workspace,label=l=>l===s.A?'A':l===s.B?'B':l.__linkedPaneType??'other';return{activeFile:w.getActiveFile()?.path??null,A:{file:s.A.view.getState().file??null,mode:s.A.view.getState().mode??null,pinned:s.A.pinned,grouped:!!s.A.group},B:{file:s.B.view.getState().file??null,mode:s.B.view.getState().mode??null,pinned:s.B.pinned,grouped:!!s.B.group},members:w.getGroupLeaves(s.A.group).map(label),panes:s.panes.map(l=>({type:l.view.getViewType(),file:l.view.getState().file??null,pinned:l.pinned,linkedToA:!!l.group&&l.group===s.A.group,title:l.view.getDisplayText(),text:l.view.containerEl.querySelector('.view-content')?.innerText.replace(/\\s+/g,' ').trim()??''}))};})()`)});};
 try{
  await ev(`(async()=>{window.__linkedPaneAudit={previous:app.workspace.activeLeaf,panes:[],created:[]};const s=window.__linkedPaneAudit;for(const [path,text]of ${JSON.stringify(notes)}){const f=app.vault.getFileByPath(path);if(f)await app.vault.modify(f,text);else await app.vault.create(path,text);}for(const label of ['A','B']){const l=app.workspace.getLeaf('tab');s[label]=l;s.created.push(l);await l.openFile(app.vault.getFileByPath('Linked pane '+label+'.md'));}app.workspace.setActiveLeaf(s.B);app.workspace.rightSplit.expand();for(const type of ${JSON.stringify(types)}){const l=app.workspace.getRightLeaf(true);l.__linkedPaneType=type;s.panes.push(l);s.created.push(l);await l.setViewState({type,state:{file:'Linked pane B.md'}});}app.workspace.setActiveLeaf(s.B);})()`);
  await c.wait(`!!app.metadataCache.getFileCache(app.vault.getFileByPath('Linked pane A.md'))?.headings?.length`,'linked note metadata');await record('unlinked panes follow B');
  await ev(`(()=>{const s=window.__linkedPaneAudit;for(const l of s.panes)l.setGroupMember(s.A);})()`);await record('link panes to A while B active');
  await ev(`app.workspace.setActiveLeaf(window.__linkedPaneAudit.A)`);await record('linked A active');
  await ev(`app.workspace.setActiveLeaf(window.__linkedPaneAudit.B)`);await record('unlinked B active');
  await ev(`(async()=>{const s=window.__linkedPaneAudit;await s.A.openFile(app.vault.getFileByPath('Linked pane C.md'),{active:false});app.workspace.setActiveLeaf(s.B);})()`);await record('linked A changes to C while B active');
  await ev(`(()=>{const s=window.__linkedPaneAudit;s.A.setPinned(true);})()`);await record('A pinned after grouping');
  await ev(`(()=>{const s=window.__linkedPaneAudit;s.B.setGroupMember(s.A);})()`);await record('B joins pinned A group');
  await ev(`(()=>{const s=window.__linkedPaneAudit;for(const l of s.panes)l.setGroupMember(null);s.B.setGroupMember(null);})()`);await record('unlink panes and B');
  await ev(`(async()=>{const s=window.__linkedPaneAudit;await s.B.openFile(app.vault.getFileByPath('Linked pane A.md'));app.workspace.setActiveLeaf(s.B);})()`);await record('unlinked panes follow next file');
  await ev(`(()=>{const s=window.__linkedPaneAudit;s.A.setPinned(false);s.B.setPinned(false);for(const l of s.panes)l.setPinned(false);s.B.setGroupMember(s.A);})()`);await record('unpin and link document panes');
  await ev(`(async()=>{const s=window.__linkedPaneAudit;await s.B.openFile(app.vault.getFileByPath('Linked pane B.md'));app.workspace.setActiveLeaf(s.B);})()`);await record('navigate linked document B');
  await ev(`(()=>{const s=window.__linkedPaneAudit;s.B.setPinned(true);})()`);await record('pin linked documents from B');
  await ev(`(()=>{const s=window.__linkedPaneAudit;s.B.setGroupMember(s.B);})()`);await record('self-link is unchanged');
  await ev(`(()=>{const s=window.__linkedPaneAudit;s.B.setGroupMember(null);})()`);await record('unlink last document pair');
  await ev(`(async()=>{const s=window.__linkedPaneAudit;s.defaultMode=app.vault.getConfig('defaultViewMode');await s.A.setViewState({type:'markdown',state:{file:'Linked pane B.md',mode:'preview'}});await s.B.setViewState({type:'markdown',state:{file:'Linked pane B.md',mode:'source'}});s.B.setGroupMember(s.A);})()`);await record('link reading and source document panes');
  await ev(`app.vault.setConfig('defaultViewMode','preview')`);await delay(150);await ev(`window.__linkedPaneAudit.B.openFile(app.vault.getFileByPath('Linked pane C.md'))`);await record('linked navigation retains each mode with reading default');
  await ev(`window.__linkedPaneAudit.B.setViewState({type:'markdown',state:{file:'Linked pane C.md'},group:null})`);await record('view state null group unlinks document pair');
  report[name]={steps,errors:c.errors};
 }catch(error){report[name]={steps,error:error.message,errors:c.errors};}
 finally{await ev(`(()=>{const s=window.__linkedPaneAudit;if(!s)return;if(s.defaultMode!==undefined)app.vault.setConfig('defaultViewMode',s.defaultMode);for(const l of s.created)if(l.parent)l.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__linkedPaneAudit;})()`).catch(()=>{});c.socket.close();}
}
report.differences=report.reference.steps.flatMap((s,i)=>JSON.stringify(s)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:s,obsen:report.obsen.steps[i]}]);
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:{reference:report.reference.steps.length,obsen:report.obsen.steps.length},differences:report.differences.map(x=>({action:x.reference.action,reference:{A:x.reference.A,B:x.reference.B,members:x.reference.members,panes:x.reference.panes.map(p=>({type:p.type,file:p.file,pinned:p.pinned,linkedToA:p.linkedToA}))},obsen:x.obsen&&{A:x.obsen.A,B:x.obsen.B,members:x.obsen.members,panes:x.obsen.panes.map(p=>({type:p.type,file:p.file,pinned:p.pinned,linkedToA:p.linkedToA}))}})),errors:{reference:report.reference.error??report.reference.errors,obsen:report.obsen.error??report.obsen.errors}},null,2));
assert.equal(report.reference.error,undefined);assert.equal(report.obsen.error,undefined);assert.deepEqual(report.differences,[]);assert.deepEqual(report.reference.errors,[]);assert.deepEqual(report.obsen.errors,[]);
