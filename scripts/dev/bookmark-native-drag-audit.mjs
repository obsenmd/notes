// Native Chromium drags are intercepted; no native window or OS drag is shown.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/bookmark-native-drag-comparison',report={},root='Bookmark drag audit';
const file=(title,ctime)=>({type:'file',path:root+'/'+title+'.md',title,ctime});
const seed=[file('A',1),file('B',2),file('C',3),{type:'group',title:'Outer',ctime:4,items:[{type:'group',title:'Nested',ctime:5,items:[file('Child',6)]}]},{type:'group',title:'Target',ctime:7,items:[]},file('Tail',8)];
await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
 let intercepted;
 const listener=event=>{const message=JSON.parse(event.data);if(message.method==='Input.dragIntercepted')intercepted=message.params.data;};c.socket.addEventListener('message',listener);
 const row=title=>`[...document.querySelectorAll('.workspace-leaf-content[data-type=bookmarks] .tree-item-self')].find(e=>e.querySelector('.tree-item-inner')?.textContent===${JSON.stringify(title)})`;
 const point=async(title,fraction=.5)=>{
  await ev(`${row(title)}?.scrollIntoView({block:'nearest'})`);await delay(100);
  return ev(`(()=>{const e=${row(title)};if(!e)throw Error('Missing bookmark row');const r=e.getBoundingClientRect(),x=r.x+Math.min(100,r.width/2),y=r.y+r.height*${fraction};if(document.elementFromPoint(x,y)?.closest('.tree-item-self')!==e)throw Error('Bookmark row occluded');return{x,y};})()`);
 };
 const click=async(title,modifiers=0)=>{const xy=await point(title);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...xy});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...xy,button:'left',clickCount:1,modifiers});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...xy,button:'left',clickCount:1,modifiers});await delay(120);};
 const select=async titles=>{await ev(`(()=>{app.workspace.setActiveLeaf(app.workspace.getLeavesOfType('bookmarks')[0]);document.querySelector('.workspace-leaf-content[data-type=bookmarks] .view-content').focus();})()`);await c.key('Escape');for(const title of titles)await click(title,1);assert.deepEqual(await ev(`([...document.querySelectorAll('.workspace-leaf-content[data-type=bookmarks] .tree-item-self.is-selected')].map(e=>e.querySelector('.tree-item-inner').textContent).sort())`),[...titles].sort());};
 const drag=async(sourceTitle,targetTitle,fraction=.5,hold=150,cancel=false)=>{
  intercepted=undefined;const source=await point(sourceTitle),target=await point(targetTitle,fraction);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...source});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...source,button:'left',buttons:1,clickCount:1});
  for(let i=1;i<=5&&!intercepted;i++){await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:source.x+10*i,y:source.y+2*i,button:'left',buttons:1});await delay(100);}
  const deadline=Date.now()+3000;while(!intercepted&&Date.now()<deadline)await delay(100);assert.ok(intercepted,name+': native bookmark drag required');
  await c.send('Input.dispatchDragEvent',{type:'dragEnter',...target,data:intercepted});await c.send('Input.dispatchDragEvent',{type:'dragOver',...target,data:intercepted});await delay(hold);
  if(cancel){await c.send('Input.dispatchDragEvent',{type:'dragCancel',...target,data:intercepted});await c.send('Input.cancelDragging');await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...source,button:'left',clickCount:1});await delay(1000);steps.push({action:'cancelled native drag preserves pending expansion',collapsed:await ev(`${row(targetTitle)}.parentElement.classList.contains('is-collapsed')`)});return;}
  if(hold>750)steps.push({action:'collapsed group opens during native drag',expanded:await ev(`!${row(targetTitle)}.parentElement.classList.contains('is-collapsed')`)});
  await c.send('Input.dispatchDragEvent',{type:'drop',...target,data:intercepted});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...target,button:'left',clickCount:1});await delay(700);
 };
 const record=async action=>steps.push({action,...await ev(`(async()=>{const clean=items=>items.map(({ctime,...item})=>({...item,...(item.items?{items:clean(item.items)}:{})}));const pane=document.querySelector('.workspace-leaf-content[data-type=bookmarks]');return{selected:[...pane.querySelectorAll('.tree-item-self.is-selected')].map(e=>e.querySelector('.tree-item-inner').textContent).sort(),focused:pane.querySelector('.tree-item-self.has-focus .tree-item-inner')?.textContent??null,items:clean(JSON.parse(await app.vault.adapter.read('.obsidian/bookmarks.json')).items),indicators:document.querySelectorAll('.workspace-leaf-content[data-type=bookmarks] .drop-indicator.is-active,.workspace-leaf-content[data-type=bookmarks] .is-being-dragged-over').length};})()`)});
 try{
  await ev(`(async()=>{if(!app.vault.getFolderByPath(${JSON.stringify(root)}))await app.vault.createFolder(${JSON.stringify(root)});for(const title of ['A','B','C','Child','Tail']){const p=${JSON.stringify(root+'/')}+title+'.md';if(!app.vault.getFileByPath(p))await app.vault.create(p,'Bookmark drag fixture');}})()`);await delay(1500);
  await ev(`(async()=>{await app.vault.adapter.write('.obsidian/bookmarks.json',JSON.stringify({items:${JSON.stringify(seed)}}));app.saveLocalStorage('bookmarks-folds',null);})()`);await c.send('Page.reload');await c.wait('!!app.workspace.layoutReady','layout restored');await delay(1200);
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Input.setInterceptDrags',{enabled:true});await ev(`(async()=>{window.dispatchEvent(new Event('focus'));app.workspace.leftSplit.expand();await app.workspace.revealLeaf(app.workspace.getLeavesOfType('bookmarks')[0]);window.__bookmarkNativeEvents=[];window.__bookmarkNativeListener=e=>window.__bookmarkNativeEvents.push({type:e.type,trusted:e.isTrusted});document.addEventListener('dragstart',window.__bookmarkNativeListener,true);})()`);
  await c.wait(`!!${row('Child')}`,'nested bookmarks seeded');
  await select(['B','A']);await drag('A','Nested');await record('two root items into nested group');
  await select(['A','B']);await drag('A','Child',.95);await record('two items after sibling in same group');
  await select(['Outer','Child']);await drag('Outer','Nested');await record('selected subtree changes descendant drop target');
  await ev(`${row('Target')}.querySelector('.collapse-icon').click()`);assert.equal(await ev(`${row('Target')}.parentElement.classList.contains('is-collapsed')`),true);
  await drag('Outer','Target',.5,1000);await record('parent and selected descendant into another group');
  await select(['Tail']);await drag('Tail','C',.05);await record('last root item before first root item');
  await select(['Target']);await drag('Tail','Target');await record('unselected source replaces old selection before drop');
  await select(['C']);await ev(`${row('Target')}.querySelector('.collapse-icon').click()`);assert.equal(await ev(`${row('Target')}.parentElement.classList.contains('is-collapsed')`),true);await drag('C','Target',.5,100,true);
  report[name]={steps,events:await ev('window.__bookmarkNativeEvents'),errors:c.errors};
 }finally{
  await c.send('Input.cancelDragging').catch(()=>{});await c.send('Input.setInterceptDrags',{enabled:false}).catch(()=>{});await ev(`(()=>{document.removeEventListener('dragstart',window.__bookmarkNativeListener,true);delete window.__bookmarkNativeListener;delete window.__bookmarkNativeEvents;})()`).catch(()=>{});c.socket.removeEventListener('message',listener);c.socket.close();
 }
}
report.differences=report.reference.steps.flatMap((step,i)=>JSON.stringify(step)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:step,obsen:report.obsen.steps[i]}]);await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({steps:report.reference.steps.length,differences:report.differences,events:{reference:report.reference.events,obsen:report.obsen.events},errors:{reference:report.reference.errors,obsen:report.obsen.errors}},null,2));assert.deepEqual(report.differences,[]);for(const value of [report.reference,report.obsen]){assert.equal(value.events.length,7);assert.ok(value.events.every(event=>event.trusted));assert.equal(value.steps.find(step=>step.action==='collapsed group opens during native drag')?.expanded,true);assert.equal(value.steps.at(-1).collapsed,false);assert.deepEqual(value.errors,[]);}
