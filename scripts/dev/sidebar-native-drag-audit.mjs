// Chromium intercepts native drags before they reach the OS. Both windows stay hidden.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/sidebar-native-drag-comparison',report={},root='Native drag audit';
await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate;
 let intercepted;
 const onMessage=event=>{const message=JSON.parse(event.data);if(message.method==='Input.dragIntercepted')intercepted=message.params.data;};
 c.socket.addEventListener('message',onMessage);
 const selector=p=>`.workspace-leaf-content[data-type=file-explorer] .tree-item-self[data-path=${JSON.stringify(p)}]`;
 const point=async p=>{
  await ev(`document.querySelector(${JSON.stringify(selector(p))})?.scrollIntoView({block:'nearest'})`);await delay(100);
  return ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector(p))});if(!e)throw Error('Missing drag row');const r=e.getBoundingClientRect(),x=r.x+Math.min(80,r.width/2),y=r.y+r.height/2;if(document.elementFromPoint(x,y)?.closest('.tree-item-self')!==e)throw Error('Drag row is occluded');return{x,y};})()`);
 };
 const click=async(p,modifiers=0)=>{const xy=await point(p);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...xy});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...xy,button:'left',clickCount:1,modifiers});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...xy,button:'left',clickCount:1,modifiers});await delay(150);};
 const drag=async(sourcePath,targetPath)=>{
  intercepted=undefined;
  const source=await point(sourcePath),target=await point(targetPath);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...source});
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...source,button:'left',buttons:1,clickCount:1});
  for(let i=1;i<=5&&!intercepted;i++){await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:source.x+10*i,y:source.y+2*i,button:'left',buttons:1});await delay(100);}
  const deadline=Date.now()+3000;while(!intercepted&&Date.now()<deadline)await delay(100);
  assert.ok(intercepted,`${name}: Chromium must intercept a native drag`);
  await c.send('Input.dispatchDragEvent',{type:'dragEnter',...target,data:intercepted});
  await c.send('Input.dispatchDragEvent',{type:'dragOver',...target,data:intercepted});await delay(150);
  await c.send('Input.dispatchDragEvent',{type:'drop',...target,data:intercepted});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...target,button:'left',clickCount:1});await delay(800);
 };
 try{
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Input.setInterceptDrags',{enabled:true});
  await ev(`(async()=>{window.dispatchEvent(new Event('focus'));const old=app.vault.getFolderByPath(${JSON.stringify(root)});if(old)await app.vault.delete(old,true);for(const p of ${JSON.stringify([root,root+'/Source',root+'/Target'])})await app.vault.createFolder(p);for(const p of ${JSON.stringify([root+'/Source/A.md',root+'/Source/B.md'])})await app.vault.create(p,'Native drag fixture');app.workspace.leftSplit.expand();await app.workspace.revealLeaf(app.workspace.getLeavesOfType('file-explorer')[0]);})()`);await delay(400);
  for(const p of [root,root+'/Source']){if(await ev(`document.querySelector(${JSON.stringify(selector(p))}).parentElement.classList.contains('is-collapsed')`))await ev(`document.querySelector(${JSON.stringify(selector(p)+' .collapse-icon')}).click()`);await delay(150);}
  await ev(`(()=>{app.workspace.setActiveLeaf(app.workspace.getLeavesOfType('file-explorer')[0]);document.querySelector('.workspace-leaf-content[data-type=file-explorer] .nav-files-container').focus();window.__nativeDragEvents=[];window.__nativeDragListener=e=>window.__nativeDragEvents.push({type:e.type,trusted:e.isTrusted,types:[...e.dataTransfer.types]});document.addEventListener('dragstart',window.__nativeDragListener,true);})()`);
  await c.key('Escape');await click(root+'/Source/A.md',1);await click(root+'/Source/B.md',1);
  assert.deepEqual(await ev(`([...document.querySelectorAll('.workspace-leaf-content[data-type=file-explorer] .tree-item-self.is-selected')].map(e=>e.dataset.path).sort())`),[root+'/Source/A.md',root+'/Source/B.md']);
  await drag(root+'/Source/A.md',root+'/Target');
  report[name]=await ev(`(()=>({events:window.__nativeDragEvents,files:app.vault.getFiles().map(f=>f.path).filter(p=>p.startsWith(${JSON.stringify(root+'/')})).sort(),dragging:document.querySelectorAll('.workspace-leaf-content[data-type=file-explorer] .is-being-dragged').length}))()`);
  await ev(`(async()=>{await app.vault.createFolder(${JSON.stringify(root+'/Source/Nested')});await app.vault.create(${JSON.stringify(root+'/Source/Nested/C.md')},'Nested native drag fixture');})()`);await delay(300);
  if(await ev(`document.querySelector(${JSON.stringify(selector(root+'/Source/Nested'))}).parentElement.classList.contains('is-collapsed')`))await ev(`document.querySelector(${JSON.stringify(selector(root+'/Source/Nested')+' .collapse-icon')}).click()`);await delay(150);
  await c.key('Escape');await click(root+'/Source',1);await click(root+'/Source/Nested/C.md',1);
  assert.deepEqual(await ev(`([...document.querySelectorAll('.workspace-leaf-content[data-type=file-explorer] .tree-item-self.is-selected')].map(e=>e.dataset.path).sort())`),[root+'/Source',root+'/Source/Nested/C.md']);
  await drag(root+'/Source',root+'/Source/Nested');
  report[name].cycleRejected=await ev(`!!app.vault.getFileByPath(${JSON.stringify(root+'/Source/Nested/C.md')})&&!app.vault.getFolderByPath(${JSON.stringify(root+'/Source/Nested/Source')})`);
  await drag(root+'/Source',root+'/Target');
  report[name].nested=await ev(`({files:app.vault.getFiles().map(f=>f.path).filter(p=>p.startsWith(${JSON.stringify(root+'/')})).sort(),sourceRemoved:!app.vault.getFolderByPath(${JSON.stringify(root+'/Source')}),dragging:document.querySelectorAll('.workspace-leaf-content[data-type=file-explorer] .is-being-dragged').length})`);
  report[name].events=await ev('window.__nativeDragEvents');
  report[name].errors=c.errors;
 }finally{
  await c.send('Input.cancelDragging').catch(()=>{});await c.send('Input.setInterceptDrags',{enabled:false}).catch(()=>{});
  await ev(`(()=>{document.removeEventListener('dragstart',window.__nativeDragListener,true);delete window.__nativeDragListener;delete window.__nativeDragEvents;})()`).catch(()=>{});
  c.socket.removeEventListener('message',onMessage);c.socket.close();
 }
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
assert.deepEqual(report.obsen,report.reference);
for(const value of Object.values(report)){assert.deepEqual(value.files,[root+'/Target/A.md',root+'/Target/B.md']);assert.equal(value.events.length,3);assert.ok(value.events.every(event=>event.trusted));assert.equal(value.cycleRejected,true);assert.deepEqual(value.nested.files,[root+'/Target/A.md',root+'/Target/B.md',root+'/Target/Source/Nested/C.md']);assert.equal(value.nested.sourceRemoved,true);assert.equal(value.nested.dragging,0);assert.deepEqual(value.errors,[]);}
