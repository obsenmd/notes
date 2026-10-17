// Own-fixture robustness gate. The reference's unfiltered global-property
// dictionary crashes on these names; its failed paired run remains evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const c=await fixtureClient(9342,'obsen-electron-smoke-',{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
const keySelector='#property-prototype-pane .metadata-property-key-input';
const record=async action=>{await delay(350);steps.push({action,...await ev(`(async()=>{const s=window.__propertyPrototype;return{source:await app.vault.read(s.file),rows:[...s.pane.view.containerEl.querySelectorAll('.metadata-property')].map(r=>({key:r.dataset.propertyKey,type:r.querySelector('.metadata-property-value')?.dataset.propertyType,text:r.querySelector('.metadata-property-value')?.textContent,warning:getComputedStyle(r.querySelector('.metadata-property-warning-icon')).display!=='none'}))};})()`)});};
try{
 await ev(`(async()=>{const path='Property prototype fixture.md',text=${JSON.stringify('---\noriginal: first\n---\n# Fixture\n')};const file=app.vault.getFileByPath(path);if(file)await app.vault.modify(file,text);else await app.vault.create(path,text);const s=window.__propertyPrototype={previous:app.workspace.activeLeaf,file:app.vault.getFileByPath(path),leaf:app.workspace.getLeaf('tab')};await s.leaf.openFile(s.file);s.pane=app.workspace.getRightLeaf(true);await s.pane.setViewState({type:'file-properties',state:{file:path}});await app.workspace.revealLeaf(s.pane);s.pane.view.containerEl.id='property-prototype-pane';})()`);
 await Promise.race([c.send('Page.captureScreenshot',{format:'png'}),delay(3000)]);await c.wait(`document.querySelector(${JSON.stringify(keySelector)})?.value==='original'`,'initial prototype-name field');
 for(const name of ['constructor','__proto__']){
  await c.click(keySelector);await c.key('a','KeyA',{modifiers:2,windowsVirtualKeyCode:65});await c.send('Input.insertText',{text:name});await c.key('Enter');await c.wait(`document.querySelector(${JSON.stringify(keySelector)})?.value===${JSON.stringify(name)}`,'renamed ordinary property '+name);await record('rename to '+name);
  await c.click('#property-prototype-pane .metadata-property-icon');await delay(100);steps.push({action:'type menu for '+name,titles:await ev(`[...document.querySelectorAll('.menu .menu-item-title')].map(e=>e.textContent)`)});await c.key('Escape');
 }
 await ev(`(async()=>{const s=window.__propertyPrototype;s.global=app.workspace.getRightLeaf(true);await s.global.setViewState({type:'all-properties',state:{sortOrder:'alphabetical',showSearch:false,searchQuery:''}});await app.workspace.revealLeaf(s.global);s.global.view.containerEl.id='property-prototype-global';})()`);await delay(500);
 const global=await ev(`[...document.querySelectorAll('#property-prototype-global .tree-item-self')].map(r=>({key:r.querySelector('.tree-item-inner-text')?.textContent,icon:r.querySelector('.tree-item-icon svg')?.getAttribute('class')})).filter(r=>r.key==='__proto__')`);
 steps.push({action:'unfiltered global property list',rows:global});
 await ev(`(()=>{const s=window.__propertyPrototype;const rows=[...s.global.view.containerEl.querySelectorAll('.tree-item-self')];rows.find(r=>r.querySelector('.tree-item-inner-text')?.textContent==='__proto__').id='prototype-global-row';})()`);await c.capture('dist/todo-backup/property-prototype-comparison','obsen-only-global-prototype-row','#prototype-global-row');
}finally{await ev(`(()=>{const s=window.__propertyPrototype;if(!s)return;if(s.global?.parent)s.global.detach();if(s.pane?.parent)s.pane.detach();if(s.leaf.parent)s.leaf.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__propertyPrototype;})()`).catch(()=>{});await delay(300);c.socket.close();}
await fs.mkdir('dist/todo-backup/property-prototype-comparison',{recursive:true});await fs.writeFile('dist/todo-backup/property-prototype-comparison/report.json',JSON.stringify({steps,errors:c.errors},null,2));
console.log(JSON.stringify({steps,errors:c.errors},null,2));
assert.deepEqual(c.errors,[]);assert.equal(steps.length,5);
for(const step of steps){if(step.action.startsWith('rename')){const key=step.action.slice('rename to '.length);assert.deepEqual(step.rows,[{key,type:'text',text:'first',warning:false}]);assert.ok(step.source.includes(key+': first'));}if(step.titles)assert.ok(step.titles.includes('Property type'));}
assert.deepEqual(steps.at(-1).rows,[{key:'__proto__',icon:'svg-icon lucide-text'}]);
