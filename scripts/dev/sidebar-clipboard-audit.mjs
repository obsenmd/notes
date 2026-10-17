// Clipboard payloads stay in renderer-local DataTransfer objects; never write the OS clipboard.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/sidebar-clipboard-comparison',report={},root='Clipboard audit';
await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
 const row=p=>`.workspace-leaf-content[data-type=file-explorer] .tree-item-self[data-path=${JSON.stringify(p)}]`;
 const click=async(p,modifiers=0)=>{
  await ev(`document.querySelector(${JSON.stringify(row(p))})?.scrollIntoView({block:'nearest'})`);await delay(100);
  const point=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(row(p))});if(!e)throw Error('Missing row '+${JSON.stringify(p)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const hit=await ev(`document.elementFromPoint(${point.x},${point.y})?.closest('.tree-item-self')?.dataset.path`);
  assert.equal(hit,p,'native mouse input must target the requested visible row');
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1,modifiers});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1,modifiers});await delay(120);
 };
 const expand=async p=>{await c.wait(`!!document.querySelector(${JSON.stringify(row(p))})`,'folder row');if(await ev(`document.querySelector(${JSON.stringify(row(p))}).parentElement.classList.contains('is-collapsed')`)){await ev(`document.querySelector(${JSON.stringify(row(p)+' .collapse-icon')}).click()`);await delay(150);}};
 const focus=async()=>ev(`(()=>{app.workspace.setActiveLeaf(app.workspace.getLeavesOfType('file-explorer')[0]);document.querySelector('.workspace-leaf-content[data-type=file-explorer] .nav-files-container').focus();})()`);
 // The pinned workspace routes copy only for trusted or relayed events; cut/paste have no such gate.
 const clipboard=async type=>ev(`(()=>{const dt=new DataTransfer(),event=new ClipboardEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,clipboardData:dt});event.isRelayed=true;document.querySelector('.workspace-leaf-content[data-type=file-explorer] .nav-files-container').dispatchEvent(event);window.__clipboardAuditData=dt;return{prevented:event.defaultPrevented,types:[...dt.types],payload:dt.getData('obsidian/files')?JSON.parse(dt.getData('obsidian/files')):null};})()`);
 const state=async()=>ev(`(()=>{const pane=document.querySelector('.workspace-leaf-content[data-type=file-explorer]');return{files:app.vault.getFiles().map(f=>f.path).filter(p=>p.startsWith(${JSON.stringify(root+'/')})).sort(),selected:[...pane.querySelectorAll('.tree-item-self.is-selected')].map(e=>e.dataset.path).sort(),cut:[...pane.querySelectorAll('.tree-item-self.is-cut')].map(e=>e.dataset.path).sort(),focused:pane.querySelector('.tree-item-self.has-focus')?.dataset.path??null};})()`);
 const paste=async()=>{await focus();await ev(`(()=>{document.querySelector('.workspace-leaf-content[data-type=file-explorer] .nav-files-container').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:window.__clipboardAuditData}));})()`);await delay(700);};
 try{
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await ev(`window.dispatchEvent(new Event('focus'))`);
  await ev(`(async()=>{const old=app.vault.getFolderByPath(${JSON.stringify(root)});if(old)await app.vault.delete(old,true);for(const p of ${JSON.stringify([root,root+'/Source',root+'/Source/Nested',root+'/Target'])})await app.vault.createFolder(p);for(const p of ${JSON.stringify([root+'/Source/A.md',root+'/Source/B.md',root+'/Source/Nested/C.md'])})await app.vault.create(p,'Clipboard fixture '+p);app.workspace.leftSplit.expand();await app.workspace.revealLeaf(app.workspace.getLeavesOfType('file-explorer')[0]);})()`);
  await delay(500);await expand(root);await expand(root+'/Source');await expand(root+'/Source/Nested');
  await focus();await c.key('Escape');await click(root+'/Source/A.md',1);await click(root+'/Source/B.md',1);await focus();
  steps.push({action:'copy two files',clipboard:await clipboard('copy')});
  assert.deepEqual(steps.at(-1).clipboard.payload,{operation:'copy',paths:[root+'/Source/A.md',root+'/Source/B.md']});
  await c.key('Escape');await click(root+'/Target',1);await paste();steps.push({action:'paste two files',state:await state()});
  await c.key('Escape');await click(root+'/Source/A.md',1);await focus();steps.push({action:'cut source file',clipboard:await clipboard('cut'),state:await state()});
  await c.key('Escape');await click(root+'/Target',1);await paste();steps.push({action:'cut paste conflict',state:await state()});
  await expand(root+'/Source');await expand(root+'/Source/Nested');
  await focus();await c.key('Escape');
  await click(root+'/Source/Nested',1);await click(root+'/Source/Nested/C.md',1);await focus();
  steps.push({action:'copy parent and child selection',clipboard:await clipboard('copy')});
  assert.deepEqual(steps.at(-1).clipboard.payload,{operation:'copy',paths:[root+'/Source/Nested']});
  await c.key('Escape');await click(root+'/Target',1);await paste();steps.push({action:'paste nested folder',state:await state()});
  steps.push({action:'copied file contents',contents:await ev(`(async()=>{const paths=${JSON.stringify([root+'/Target/A.md',root+'/Target/A 1.md',root+'/Target/B.md',root+'/Target/Nested/C.md'])};return await Promise.all(paths.map(async path=>({path,text:await app.vault.read(app.vault.getFileByPath(path))})));})()`)});
  report[name]={steps,errors:c.errors};
 }finally{await ev(`(()=>{delete window.__clipboardAuditData;})()`).catch(()=>{});c.socket.close();}
}
report.differences=report.reference.steps.flatMap((step,i)=>JSON.stringify(step)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:step,obsen:report.obsen.steps[i]}]);
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:report.reference.steps.length,differences:report.differences,errors:{reference:report.reference.errors,obsen:report.obsen.errors}},null,2));
assert.deepEqual(report.differences,[]);assert.deepEqual(report.reference.errors,[]);assert.deepEqual(report.obsen.errors,[]);
