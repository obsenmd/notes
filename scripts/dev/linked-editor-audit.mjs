import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const report={},output='dist/todo-backup/linked-editor-comparison';
await fs.mkdir(output,{recursive:true});
const text=Array.from({length:180},(_,i)=>`Line ${i}: linked navigation.`).join('\n');
for(const [name,port,prefix]of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),steps=[];
 const record=async action=>{await delay(500);steps.push({action,...await c.evaluate(`(()=>{const s=window.__linkedEditorAudit;return {A:s.A.view.editor.getCursor(),B:s.B.view.editor.getCursor(),selectionA:s.A.view.editor.getSelection(),selectionB:s.B.view.editor.getSelection(),scrollA:s.A.view.currentMode.getScroll(),scrollB:s.B.view.currentMode.getScroll(),...(s.C?{C:s.C.view.editor.getCursor(),selectionC:s.C.view.editor.getSelection(),scrollC:s.C.view.currentMode.getScroll()}:{} )};})()`)});};
 try{
  await c.evaluate(`(async()=>{const path='Linked editor audit.md',f=app.vault.getFileByPath(path);if(f)await app.vault.modify(f,${JSON.stringify(text)});else await app.vault.create(path,${JSON.stringify(text)});const s=window.__linkedEditorAudit={previous:app.workspace.activeLeaf};s.A=app.workspace.getLeaf('tab');await s.A.setViewState({type:'markdown',state:{file:path,mode:'source',source:true},active:true});s.B=app.workspace.createLeafBySplit(s.A,'vertical');await s.B.setViewState({type:'markdown',state:{file:path,mode:'source',source:true},active:true});s.B.setGroupMember(s.A);app.workspace.setActiveLeaf(s.A);s.A.view.editor.focus();})()`);
  await c.wait(`!!window.__linkedEditorAudit.A.view.editor.cm&&!!window.__linkedEditorAudit.B.view.editor.cm`,'two editors');
  await c.evaluate(`(()=>{app.workspace.leftSplit?.collapse();app.workspace.rightSplit?.collapse();})()`);
  await Promise.race([c.send('Page.captureScreenshot',{format:'png'}),delay(1200)]);await delay(300);
  await c.evaluate(`window.__linkedEditorAudit.A.view.editor.setCursor({line:20,ch:5})`);await record('API cursor A');
  await c.key('ArrowRight');await record('trusted cursor A');
  await c.evaluate(`window.__linkedEditorAudit.A.view.editor.setSelection({line:21,ch:1},{line:23,ch:7})`);await record('selection A');
  await c.evaluate(`window.__linkedEditorAudit.A.view.editor.scrollTo(null,600)`);await record('scroll A');
  await c.evaluate(`(()=>{const s=window.__linkedEditorAudit;app.workspace.setActiveLeaf(s.B);s.B.view.editor.focus();s.B.view.editor.setCursor({line:40,ch:3});})()`);await record('cursor B');
  await c.evaluate(`window.__linkedEditorAudit.B.view.editor.scrollTo(null,950)`);await record('scroll B');
  await c.evaluate(`window.__linkedEditorAudit.B.setGroupMember(null)`);
  await c.evaluate(`window.__linkedEditorAudit.A.view.editor.setCursor({line:5,ch:2})`);await record('unlinked cursor A');
  await c.evaluate(`(async()=>{const s=window.__linkedEditorAudit;await s.B.setViewState({type:'markdown',state:{file:'Linked editor audit.md',mode:'preview'}});s.B.setGroupMember(s.A);})()`);
  await c.wait(`!!window.__linkedEditorAudit.B.containerEl.querySelector('.markdown-preview-section .el-p')`,'reading peer');
  await c.evaluate(`window.__linkedEditorAudit.A.view.editMode.applyScroll(40)`);await record('programmatic source scroll does not broadcast');
  await c.evaluate(`window.__linkedEditorAudit.B.view.previewMode.applyScroll(55)`);await record('programmatic reading scroll does not broadcast');
  await c.evaluate(`window.__linkedEditorAudit.A.view.editor.scrollTo(null,1100)`);await record('source scroll into reading peer');
  await c.evaluate(`window.__linkedEditorAudit.B.containerEl.querySelector('.markdown-preview-view').scrollTop+=100`);await record('reading scroll into source peer');
  await c.evaluate(`(async()=>{const s=window.__linkedEditorAudit;s.B.setGroupMember(null);s.C=await app.workspace.openPopoutLeaf();await s.C.setViewState({type:'markdown',state:{file:'Linked editor audit.md',mode:'source',source:true}});s.childWindow=s.C.getContainer().win;s.C.setGroupMember(s.A);})()`);
  await c.wait(`!!window.__linkedEditorAudit.C.view.editor.cm`,'popout editor');await delay(500);
  await c.evaluate(`(()=>{const s=window.__linkedEditorAudit;s.A.view.editor.setSelection({line:60,ch:1},{line:62,ch:4});s.A.view.editor.scrollTo(null,1400);})()`);await record('main selection scroll into popout');
  await c.evaluate(`(()=>{const s=window.__linkedEditorAudit;s.C.view.editor.setCursor({line:75,ch:3});s.C.view.editor.scrollTo(null,1700);})()`);await record('popout cursor scroll into main');
  report[name]={steps,errors:c.errors};
 }catch(error){report[name]={steps,error:error.message,errors:c.errors};}
 finally{await c.evaluate(`(()=>{const s=window.__linkedEditorAudit;if(s){s.C?.detach();if(s.childWindow&&!s.childWindow.closed)s.childWindow.close();s.B?.detach();s.A?.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);}delete window.__linkedEditorAudit;})()`).catch(()=>{});c.socket.close();}
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({checks:report.obsen.steps.length,errors:{reference:report.reference.error??report.reference.errors,obsen:report.obsen.error??report.obsen.errors}},null,2));
assert.equal(report.reference.error,undefined);assert.equal(report.obsen.error,undefined);assert.equal(report.obsen.steps.length,report.reference.steps.length);
for(let i=0;i<report.reference.steps.length;i++){
 const {scrollA:referenceA,scrollB:referenceB,scrollC:referenceC,...reference}=report.reference.steps[i],{scrollA:ownA,scrollB:ownB,scrollC:ownC,...own}=report.obsen.steps[i];
 assert.deepEqual(own,reference);
 // ScrollTop rounds to CSS pixels. Fifty thousandths of a source line is at most 1.2px in the source fixture.
 assert.ok(Math.abs(referenceA-ownA)<0.05,`${reference.action}: source scroll ${ownA} vs ${referenceA}`);
 assert.ok(Math.abs(referenceB-ownB)<0.05,`${reference.action}: peer scroll ${ownB} vs ${referenceB}`);
 if(referenceC!==undefined)assert.ok(Math.abs(referenceC-ownC)<0.05,`${reference.action}: popout scroll ${ownC} vs ${referenceC}`);
}
assert.deepEqual(report.obsen.errors,[]);assert.deepEqual(report.reference.errors,[]);
