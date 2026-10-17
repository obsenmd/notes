import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/property-list-comparison',report={};await fs.mkdir(output,{recursive:true});
for(const[name,port,prefix]of[['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[],geometry={};
 const row=key=>`#property-list-pane .metadata-property[data-property-key=${JSON.stringify(key)}]`;
 const input=key=>row(key)+' .multi-select-input';
 const type=text=>c.send('Input.insertText',{text});
 const clear=async()=>{await c.key('a','KeyA',{modifiers:2,windowsVirtualKeyCode:65});await c.key('Backspace');};
 const rightClick=async selector=>{const point=await ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...point,button:type==='mouseMoved'?'none':'right',clickCount:1});await delay(150);};
 const record=async action=>{await delay(400);steps.push({action,...await ev(`(async()=>{const s=window.__propertyList,el=s.pane.view.containerEl,active=document.activeElement;return{source:await app.vault.read(s.file),focus:{key:active?.closest('.metadata-property')?.dataset.propertyKey??null,class:active===document.body?'body':active?.className??'',text:active?.matches('.multi-select-input,.multi-select-pill')?active.textContent:null},rows:[...el.querySelectorAll('.metadata-property')].map(r=>({key:r.dataset.propertyKey,pills:[...r.querySelectorAll('.multi-select-pill')].map(p=>({text:p.querySelector('.multi-select-pill-content')?.textContent,selected:p.classList.contains('is-selected')})),input:r.querySelector('.multi-select-input')?.textContent})),suggestions:[...document.querySelectorAll('.suggestion-container .suggestion-item')].filter(e=>e.offsetParent).map(e=>e.textContent)};})()`)});};
 try{
  if(name==='reference') await ev(`app.internalPlugins.plugins.properties.enable(false)`);
  else if(!await ev(`app.workspace.viewRegistry.has('file-properties')`)){
   await ev(`(async()=>{let data={};try{data=JSON.parse(await app.vault.adapter.read('.obsidian/core-plugins.json'));}catch{}data.properties=true;await app.vault.adapter.write('.obsidian/core-plugins.json',JSON.stringify(data));window.__propertyListReload=true;})()`);
   await c.send('Page.reload');await c.wait(`!window.__propertyListReload&&!!window.__obsenSmokeApp?.workspace?.layoutReady`,'properties plugin loaded');
  }
  await ev(`(async()=>{const seed='Property list tag seed.md',seedText='#area/home #area/work #idea #project/active #project/done #review';const seedFile=app.vault.getFileByPath(seed);if(seedFile)await app.vault.modify(seedFile,seedText);else await app.vault.create(seed,seedText);const path='Property list fixture.md',text=${JSON.stringify('---\nlist: [one, two]\naliases: [Old]\ntags: [base]\n---\n# Fixture\n')};const file=app.vault.getFileByPath(path);if(file)await app.vault.modify(file,text);else await app.vault.create(path,text);window.__propertyList={file:app.vault.getFileByPath(path),previous:app.workspace.activeLeaf,leaf:app.workspace.getLeaf('tab')};await window.__propertyList.leaf.openFile(window.__propertyList.file);app.workspace.rightSplit.expand();window.__propertyList.pane=app.workspace.getRightLeaf(true);await window.__propertyList.pane.setViewState({type:'file-properties',state:{file:path}});await app.workspace.revealLeaf(window.__propertyList.pane);window.__propertyList.pane.view.containerEl.id='property-list-pane';})()`);
  await c.wait(`app.metadataCache.getFileCache(app.vault.getFileByPath('Property list tag seed.md'))?.tags?.length===6`,'suggestion tag seed indexed');

  await Promise.race([c.send('Page.captureScreenshot',{format:'png'}),delay(3000)]);await c.wait(`!!document.querySelector(${JSON.stringify(input('list'))})`,'list widget');
  await c.click(input('list'));await type('three');await record('list text before Enter');await c.key('Enter');await record('list Enter commits and retains focus');
  await c.key('Backspace');await record('list empty Backspace');await c.key('Backspace');await record('list second Backspace');
  await c.click(input('list'));await type('four');await c.key(',', 'Comma');await record('list comma');await type('five');await c.click('#property-list-pane .metadata-properties-title');await record('list blur');
  await c.click(input('aliases'));await type('New alias');await c.key('Enter');await record('alias Enter');
  await c.click(input('tags'));await type('#new/tag');await c.key('Enter');await record('tag Enter strips leading hash');
  await c.click(input('tags'));await type('bad tag');await c.key('Enter');await record('tag with spaces');
  await c.click(row('list')+' .multi-select-pill-remove-button');await record('remove first list pill');
  await c.click(row('list')+' .multi-select-pill');await c.key('Enter');await type('Two edited');await record('edit focused list pill');await c.key('Enter');await record('commit pill edit retains pill focus');
  await c.key('ArrowRight');await record('move focus to next pill');await c.key('Escape');await record('Escape returns to list input');
  await type('fourfive');await c.key('Enter');await record('duplicate list value is retained');await clear();await record('clear duplicate input');
  await c.click(input('tags'));await clear();await type('pro');await c.key('ArrowDown');await record('tag suggestion arrow selection');Object.assign(geometry,await ev(`(()=>{const input=document.activeElement,popup=document.querySelector('.suggestion-container');return{input:input.getBoundingClientRect().toJSON(),popup:popup.getBoundingClientRect().toJSON(),leaf:window.__propertyList.pane.containerEl.getBoundingClientRect().toJSON(),inputFont:getComputedStyle(input).font,popupFont:getComputedStyle(popup).font};})()`));await c.capture(output,name+'-tag-suggestions','.suggestion-container');await c.key('Enter');await record('tag suggestion Enter selection');
  await ev(`(()=>{const s=window.__propertyList;s.clipboardWrite=Object.getOwnPropertyDescriptor(navigator.clipboard,'writeText');s.copied=[];navigator.clipboard.writeText=async text=>{s.copied.push(text);};})()`);
  await c.key('Escape');await c.click(row('list')+' .multi-select-pill');
  await rightClick(row('list')+' .multi-select-pill');steps.push({action:'pill context menu',titles:await ev(`[...document.querySelectorAll('.menu .menu-item-title')].map(e=>e.textContent)`)});
  await ev(`[...document.querySelectorAll('.menu .menu-item-title')].find(e=>e.textContent==='Copy').click()`);await delay(100);steps.push({action:'pill context Copy',copied:await ev(`window.__propertyList.copied`)});
  report[name]={steps,geometry,errors:c.errors};
 }catch(error){report[name]={steps,error:error.message,errors:c.errors};}
 finally{await ev(`(()=>{const s=window.__propertyList;if(!s)return;if(s.copied){if(s.clipboardWrite)Object.defineProperty(navigator.clipboard,'writeText',s.clipboardWrite);else delete navigator.clipboard.writeText;}if(s.pane?.parent)s.pane.detach();if(s.leaf.parent)s.leaf.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__propertyList;})()`).catch(()=>{});await delay(300);c.socket.close();}
}
report.differences=report.reference.steps.flatMap((s,i)=>JSON.stringify(s)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:s,obsen:report.obsen.steps[i]}]);await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:{reference:report.reference.steps.length,obsen:report.obsen.steps.length},differences:report.differences.map(d=>({action:d.reference.action,reference:d.reference,obsen:d.obsen})),errors:{reference:report.reference.error??report.reference.errors,obsen:report.obsen.error??report.obsen.errors}},null,2));
assert.equal(report.reference.error,undefined);assert.equal(report.obsen.error,undefined);assert.deepEqual(report.differences,[]);assert.deepEqual(report.reference.errors,[]);assert.deepEqual(report.obsen.errors,[]);
