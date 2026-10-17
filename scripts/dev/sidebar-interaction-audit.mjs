// Renderer inputs only: never shows or focuses a native window.
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/sidebar-interaction-comparison';
await fs.mkdir(output,{recursive:true});
const report={};
const items=[1,2,3].map(n=>({type:'file',path:`Keyboard audit/Note ${n}.md`,title:`B${n}`,ctime:n}));
items.push({type:'group',title:'Group',ctime:4,items:[{type:'file',path:'Keyboard audit/Note 1.md',title:'Child',ctime:5}]});
items.push({type:'url',title:'Example',url:'https://example.org/keyboard-audit#section',ctime:6});
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix),ev=c.evaluate,steps=[];
 const row=(pane,title)=>`[...document.querySelectorAll('.workspace-leaf-content[data-type=${pane}] .tree-item-self')].find(e=>e.querySelector('.tree-item-inner,.nav-file-title-content,.nav-folder-title-content')?.textContent===${JSON.stringify(title)})`;
 const click=async(target,modifiers=0)=>{
  const p=await ev(`(()=>{const e=${target};if(!e)throw Error('Missing row');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1,modifiers});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1,modifiers});await delay(150);
 };
 const focus=async pane=>ev(`(()=>{app.workspace.setActiveLeaf(app.workspace.getLeavesOfType('${pane}')[0],{focus:true});document.querySelector('.workspace-leaf-content[data-type=${pane}] ${pane==='file-explorer'?'.nav-files-container':'.view-content'}').focus();})()`);
 const record=async(pane,action)=>steps.push({pane,action,...await ev(`(()=>{const p=document.querySelector('.workspace-leaf-content[data-type=${pane}]'),title=e=>e.querySelector('.tree-item-inner,.nav-file-title-content,.nav-folder-title-content')?.textContent;return{selected:[...p.querySelectorAll('.tree-item-self.is-selected')].map(title),focused:title(p.querySelector('.tree-item-self.has-focus')??document.createElement('div'))??null,active:app.workspace.getActiveFile()?.path??null};})()`)});
 try{
  await ev(`(async()=>{if(!app.vault.getFolderByPath('Keyboard audit'))await app.vault.createFolder('Keyboard audit');if(!app.vault.getFolderByPath('Keyboard target'))await app.vault.createFolder('Keyboard target');const moved=app.vault.getFileByPath('Keyboard target/Note 2.md');if(moved)await app.fileManager.renameFile(moved,'Keyboard audit/Note 2.md');for(let i=1;i<=3;i++){const p='Keyboard audit/Note '+i+'.md';if(!app.vault.getFileByPath(p))await app.vault.create(p,'# Note '+i+String.fromCharCode(10));}})()`);
  // Restoring the moved file also saves the old bookmark list asynchronously.
  // Let that finish before replacing the test list and reloading the fixture.
  await delay(1500);
  await ev(`(async()=>{await app.vault.adapter.write('.obsidian/bookmarks.json',JSON.stringify({items:${JSON.stringify(items)}}));app.saveLocalStorage('bookmarks-folds',null);})()`);
  await c.send('Page.reload');await c.wait(`!!app.workspace.layoutReady`,'layout restored');await delay(1200);
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await ev(`(async()=>{await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath('Keyboard audit/Note 3.md'));app.workspace.leftSplit.expand();await app.workspace.revealLeaf(app.workspace.getLeavesOfType('bookmarks')[0]);})()`);
  await c.wait(`!!${row('bookmarks','B1')}`,'bookmarks loaded');
  const seeded=await ev(`([...document.querySelectorAll('.workspace-leaf-content[data-type=bookmarks] .tree-item-self')].map(e=>e.querySelector('.tree-item-inner')?.textContent))`);
  if(JSON.stringify(seeded)!==JSON.stringify(['B1','B2','B3','Group','Child','Example']))throw Error(`${name}: bookmark setup was overwritten: ${JSON.stringify(seeded)}`);
  await click(row('bookmarks','B1'));await focus('bookmarks');await record('bookmarks','click B1');
  for(const [key,modifiers] of [['ArrowDown',0],['ArrowDown',8],['Escape',0]]){await c.key(key,key,{modifiers});await delay(100);await record('bookmarks',`${key}:${modifiers}`);}
  await click(row('bookmarks','B1'),1);await click(row('bookmarks','B3'),1);await record('bookmarks','Alt B1+B3');
  await click(row('bookmarks','B2'),8);await record('bookmarks','Shift B2');
  await click(row('bookmarks','B1'));await focus('bookmarks');await c.key('ArrowDown');await c.key('Enter');await delay(200);await record('bookmarks','keyboard open B2');
  await focus('bookmarks');await c.key('ArrowDown','ArrowDown',{modifiers:2});await delay(250);await record('bookmarks','Ctrl ArrowDown opens B3');
  await ev(`(()=>{window.__auditOriginalOpen=window.open;window.__auditOpened=[];window.open=(url,target)=>{window.__auditOpened.push({url,target});return null;};})()`);
  try{await click(row('bookmarks','Example'));steps.push({pane:'bookmarks',action:'URL navigation request',opened:await ev('window.__auditOpened')});}
  finally{await ev(`(()=>{window.open=window.__auditOriginalOpen;delete window.__auditOriginalOpen;delete window.__auditOpened;})()`);}
  await focus('bookmarks');await c.key('Escape');
  await click(row('bookmarks','Group'),1);await focus('bookmarks');await c.key('Escape');
  let groupStep=0;
  for(const key of ['ArrowLeft','ArrowRight','ArrowRight']){await c.key(key);await delay(250);await c.capture(output,`${name}-bookmark-group-${groupStep++}`,'.workspace-leaf-content[data-type=bookmarks]');await record('bookmarks',`group ${key}`);steps.at(-1).collapsed=await ev(`${row('bookmarks','Group')}.parentElement.classList.contains('is-collapsed')`);}
  // Dispatch standard DOM DragEvents through each application's actual handlers.
  // This verifies renderer drag contracts; OS-native drag initiation remains a separate check.
  await ev(`(()=>{const source=${row('bookmarks','B3')},target=${row('bookmarks','Group')},dt=new DataTransfer(),a=source.getBoundingClientRect(),b=target.getBoundingClientRect();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:a.x+50,clientY:a.y+a.height/2}));window.__auditDrag={source,target,dt,x:b.x+50,y:b.y+b.height/2};target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:b.x+50,clientY:b.y+b.height/2}));})()`);
  await delay(150);
  await ev(`(()=>{const{source,target,dt,x,y}=window.__auditDrag;target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:x,clientY:y}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));delete window.__auditDrag;})()`);
  await delay(700);
  steps.push({pane:'bookmarks',action:'drag B3 into Group',items:await ev(`(async()=>{const clean=items=>items.map(({ctime,...item})=>({...item,...(item.items?{items:clean(item.items)}:{})}));return clean(JSON.parse(await app.vault.adapter.read('.obsidian/bookmarks.json')).items);})()`)});
  await ev(`(async()=>{await app.workspace.revealLeaf(app.workspace.getLeavesOfType('file-explorer')[0]);})()`);
  await c.wait(`document.querySelector('.workspace-leaf-content[data-type=file-explorer]')?.offsetWidth>0`,'explorer visible');await delay(250);
  if(await ev(`${row('file-explorer','Keyboard audit')}.parentElement.classList.contains('is-collapsed')`))await click(`${row('file-explorer','Keyboard audit')}.querySelector('.collapse-icon')`);
  await c.wait(`!!${row('file-explorer','Note 1')}`,'folder expanded');
  await click(row('file-explorer','Note 1'));await focus('file-explorer');await record('file-explorer','click Note 1');
  for(const [key,modifiers] of [['ArrowDown',0],['ArrowDown',8],['Escape',0]]){await c.key(key,key,{modifiers});await delay(100);await record('file-explorer',`${key}:${modifiers}`);}
  await click(row('file-explorer','Note 1'),1);await click(row('file-explorer','Note 3'),1);await record('file-explorer','Alt Note 1+3');
  await click(row('file-explorer','Note 2'),8);await record('file-explorer','Shift Note 2');
  await focus('file-explorer');await c.key('Escape');
  await ev(`(()=>{const source=${row('file-explorer','Note 2')},target=${row('file-explorer','Keyboard target')},dt=new DataTransfer(),a=source.getBoundingClientRect(),b=target.getBoundingClientRect();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:a.x+50,clientY:a.y+a.height/2}));window.__auditDrag={source,target,dt,x:b.x+50,y:b.y+b.height/2};target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:b.x+50,clientY:b.y+b.height/2}));})()`);
  await delay(150);
  await ev(`(()=>{const{source,target,dt,x,y}=window.__auditDrag;target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:x,clientY:y}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));delete window.__auditDrag;})()`);
  await delay(800);
  steps.push({pane:'file-explorer',action:'drag Note 2 into folder',moved:await ev(`!!app.vault.getFileByPath('Keyboard target/Note 2.md') && !app.vault.getFileByPath('Keyboard audit/Note 2.md')`)});
  steps.push({pane:'bookmarks',action:'bookmark follows moved file',path:await ev(`(async()=>JSON.parse(await app.vault.adapter.read('.obsidian/bookmarks.json')).items.find(i=>i.title==='B2')?.path)()`)});
  report[name]={steps,errors:c.errors};
 }finally{c.socket.close();}
}
report.differences=report.reference.steps.flatMap((s,i)=>JSON.stringify(s)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:s,obsen:report.obsen.steps[i]}]);
await fs.writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:report.reference.steps.length,differences:report.differences,errors:{reference:report.reference.errors,obsen:report.obsen.errors}},null,2));
if(report.differences.length||Object.values(report).some(x=>x?.errors?.length))process.exitCode=1;
