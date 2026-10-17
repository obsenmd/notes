import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';

const output='dist/todo-backup/property-reserved-comparison';
await fs.mkdir(output,{recursive:true});
const cases=[
 ['typed-values','text: hello\nlist: [one, two]\naliases: [Alpha, Beta]\ntags: [project/active, idea]\nnumber: 12.5\ncheckbox: true\ndate: 2026-10-13\ndatetime: 2026-10-13T09:15:00\nempty: null'],
 ['invalid-yaml','broken: [unfinished'],
 ['recovered','text: recovered\nnumber: 7'],
 ['sequence-root','- one\n- two'],
 ['scalar-root','hello'],
 ['empty-frontmatter',''],
 ['nested-values','object: {one: 1}\nnested: [one, [two]]'],
 ['reserved-numbers','aliases: 12\ntags: 34\ncssclasses: 56'],
 ['reserved-booleans','aliases: true\ntags: false\ncssclasses: true'],
 ['reserved-objects','aliases: {one: 1}\ntags: {two: 2}\ncssclasses: {three: 3}'],
 ['reserved-mixed-lists','aliases: [Alpha, 12]\ntags: [project/active, false]\ncssclasses: [example, {one: 1}]'],
 ['numeric-lists','numbers: [1, 2]\nmixed: [one, null]\nbooleans: [true, false]'],
 ['reserved-empty','aliases: null\ntags: null\ncssclasses: null'],
 ['reserved-uppercase','Aliases: 12\nTags: {one: 1}\nCssClasses: false'],
 ['duplicate-key','text: first\ntext: second'],
 ['final-recovery','text: ready'],
];
const report={};
for(const[name,port,prefix]of[['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
 try{
  if(name==='reference') await ev(`app.internalPlugins.plugins.properties.enable(false)`);
  else {
   await ev(`(async()=>{let data={};try{data=JSON.parse(await app.vault.adapter.read('.obsidian/core-plugins.json'));}catch{}data.properties=true;await app.vault.adapter.write('.obsidian/core-plugins.json',JSON.stringify(data));window.__propertyReloadPending=true;})()`);
   await c.send('Page.reload');
   await c.wait(`!window.__propertyReloadPending&&!!window.__obsenSmokeApp?.workspace?.layoutReady`,'properties plugin loaded');
  }
  await ev(`(async()=>{const path='Property edge fixture.md',file=app.vault.getFileByPath(path)??await app.vault.create(path,'# Fixture');await app.vault.modify(file,${JSON.stringify('---\ntext: initial\n---\n# Fixture')});window.__propertyEdge={previous:app.workspace.activeLeaf,leaf:app.workspace.getLeaf('tab'),file};await window.__propertyEdge.leaf.openFile(file);app.commands.executeCommandById('properties:open-local');app.workspace.rightSplit.expand();})()`);
  await c.wait(`app.workspace.getLeavesOfType('file-properties').length>0`,'file properties pane created');
  await ev(`(async()=>{window.__propertyEdge.pane=app.workspace.getLeavesOfType('file-properties')[0];await app.workspace.revealLeaf(window.__propertyEdge.pane);})()`);
  await c.wait(`!!window.__propertyEdge.pane.view.containerEl.querySelector('.metadata-property')`,'initial property widget mounted');
  // Never-shown Electron windows need an initial compositor frame before RAF
  // subscriptions will flush subsequent metadata revisions.
  await Promise.race([c.send('Page.captureScreenshot',{format:'png'}),delay(3000)]);
  for(const[label,yaml]of cases){
   await ev(`app.vault.modify(window.__propertyEdge.file,${JSON.stringify('---\n'+yaml+'\n---\n# Fixture\n')})`);
   await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:6,y:10});
   await delay(700);
   const value=await ev(`(()=>{const el=window.__propertyEdge.pane.view.containerEl,visible=e=>!!e&&getComputedStyle(e).display!=='none';return{error:[...el.querySelectorAll('.metadata-error-container')].filter(visible).map(e=>e.innerText.replace(/\\s+/g,' ').trim()),rows:[...el.querySelectorAll('.metadata-property')].map(r=>({key:r.querySelector('.metadata-property-key-input')?.value??r.dataset.propertyKey??r.dataset.key,type:r.querySelector('.metadata-property-value')?.dataset.propertyType,warning:visible(r.querySelector('.metadata-property-warning-icon')),inputs:[...r.querySelectorAll('.metadata-property-value input')].map(i=>({type:i.type,value:i.value,checked:i.type==='checkbox'?i.checked:undefined})),text:r.querySelector('.metadata-property-value')?.innerText.replace(/\\s+/g,' ').trim()}))};})()`);
   steps.push({label,...value,sourceUnchanged:await ev(`await app.vault.read(window.__propertyEdge.file)===${JSON.stringify('---\n'+yaml+'\n---\n# Fixture\n')}`)});await c.capture(output,name+'-'+label,'.workspace-leaf-content[data-type="file-properties"] .metadata-container');
   if(label==='invalid-yaml'){
    await c.click('.workspace-leaf-content[data-type="file-properties"] .metadata-show-source-button');
    await c.wait(`app.workspace.activeLeaf?.view.getViewType()==='markdown'&&app.workspace.activeLeaf.view.getState().mode==='source'`,'invalid property Show source');
    steps.push({label:'show-source',...await ev(`(()=>{const {file,mode,source}=app.workspace.activeLeaf.view.getState();return{file,mode,source};})()`)});
   }
  }
  const globalText='---\nedge_global_object: {one: 1}\nedge_global_nested: [one, [two]]\nedge_global_numbers: [1, 2]\nedge_global_nulls: [one, null]\n---\n# Fixture';
  // Filter to the seeded properties so unrelated fixture notes do not change
  // the virtual list's scrollbar width or the capture's row geometry.
  await ev(`(async()=>{const path='Property global edge fixture.md',file=app.vault.getFileByPath(path);if(file)await app.vault.modify(file,${JSON.stringify(globalText)});else await app.vault.create(path,${JSON.stringify(globalText)});const s=window.__propertyEdge;s.globalPane=app.workspace.getRightLeaf(true);await s.globalPane.setViewState({type:'all-properties',state:{sortOrder:'alphabetical',showSearch:true,searchQuery:'edge_global_'}});await app.workspace.revealLeaf(s.globalPane);s.globalPane.view.containerEl.id='property-global-edge';})()`);
  await c.wait(`(()=>{const rows=[...document.querySelectorAll('#property-global-edge .tree-item-inner-text')];return rows.length===4&&rows.every(e=>e.textContent.startsWith('edge_global_'));})()`,'filtered global unknown property rows');
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:6,y:10});
  const globalRows=await ev(`(()=>{return [...document.querySelectorAll('#property-global-edge .tree-item-self')].map(e=>{const key=e.querySelector('.tree-item-inner-text')?.textContent;if(!key?.startsWith('edge_global_'))return null;e.id='property-global-row-'+key;return{key,icon:e.querySelector('.tree-item-icon svg')?.getAttribute('class')};}).filter(Boolean);})()`);
  steps.push({label:'global-unknown-property-icons',rows:globalRows});
  for(const row of globalRows)await c.capture(output,name+'-'+row.key,'#property-global-row-'+row.key);
  report[name]={steps,errors:c.errors};
 }finally{await ev(`(()=>{const s=window.__propertyEdge;if(!s)return;if(s.globalPane?.parent)s.globalPane.detach();if(s.leaf.parent)s.leaf.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__propertyEdge;})()`).catch(()=>{});await delay(300);c.socket.close();}
}
report.differences=report.reference.steps.flatMap((s,i)=>JSON.stringify(s)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:s,obsen:report.obsen.steps[i]}]);
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:report.reference.steps.length,differences:report.differences,errors:{reference:report.reference.errors,obsen:report.obsen.errors}},null,2));
assert.deepEqual(report.differences,[]);assert.deepEqual(report.reference.errors,[]);assert.deepEqual(report.obsen.errors,[]);
