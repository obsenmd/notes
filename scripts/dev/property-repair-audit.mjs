import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/property-repair-comparison',report={};await fs.mkdir(output,{recursive:true});
const cases=[['aliases-number','aliases','12'],['aliases-object','aliases','{one: 1}'],['aliases-mixed','aliases','[Alpha, 12]'],['tags-boolean','tags','true'],['tags-mixed','tags','[project/active, false]'],['cssclasses-object','cssclasses','{one: 1}']];
const apps=process.argv.includes('--only=reference')?[['reference',9352,'obsen-reference-audit-']]:[['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']];
for(const[name,port,prefix]of apps){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
 const read=async action=>{await delay(300);steps.push({action,...await ev(`(async()=>{const s=window.__propertyRepair,r=s.pane.view.containerEl.querySelector('.metadata-property'),v=r.querySelector('.metadata-property-value'),a=document.activeElement;return{paneFile:s.pane.view.getState().file,source:await app.vault.read(s.file),type:v.dataset.propertyType,warning:getComputedStyle(r.querySelector('.metadata-property-warning-icon')).display!=='none',text:v.innerText,pills:[...v.querySelectorAll('.multi-select-pill-content')].map(e=>e.textContent),focus:a===document.body?'body':a.className,focusKey:a.closest('.metadata-property')?.dataset.propertyKey??null};})()`)});};
 try{
  if(name==='reference')await ev(`app.internalPlugins.plugins.properties.enable(false)`);
  else if(!await ev(`app.workspace.viewRegistry.has('file-properties')`)){
   await ev(`(async()=>{let data={};try{data=JSON.parse(await app.vault.adapter.read('.obsidian/core-plugins.json'));}catch{}data.properties=true;await app.vault.adapter.write('.obsidian/core-plugins.json',JSON.stringify(data));window.__repairReload=true;})()`);await c.send('Page.reload');await c.wait(`!window.__repairReload&&!!window.__obsenSmokeApp?.workspace?.layoutReady`,'properties plugin ready');
  }
  await ev(`(async()=>{const path='Property repair suggestion seed.md',text=${JSON.stringify('---\ncssclasses: [wide]\ntags: [area/home, area/work, idea, project/active, project/done, review]\n---\n# Seed\n')};const file=app.vault.getFileByPath(path);if(file)await app.vault.modify(file,text);else await app.vault.create(path,text);})()`);
  await c.wait(`app.metadataCache.getFileCache(app.vault.getFileByPath('Property repair suggestion seed.md'))?.frontmatter?.cssclasses?.[0]==='wide'`,'repair suggestion seed indexed');
  await ev(`(()=>{window.__propertyRepair={previous:app.workspace.activeLeaf,leaf:app.workspace.getLeaf('tab')};})()`);
  for(const[label,key,value]of cases){
   await ev(`(async()=>{const s=window.__propertyRepair;if(s.pane?.parent)s.pane.detach();const path='Property repair fixture.md',text=${JSON.stringify('---\n'+key+': '+value+'\n---\n# Fixture\n')};s.file=app.vault.getFileByPath(path)??await app.vault.create(path,text);await app.vault.modify(s.file,text);await s.leaf.openFile(s.file);s.pane=app.workspace.getRightLeaf(true);await s.pane.setViewState({type:'file-properties',state:{file:path}});await app.workspace.revealLeaf(s.pane);s.pane.view.containerEl.id='property-repair-pane';})()`);
   await Promise.race([c.send('Page.captureScreenshot',{format:'png'}),delay(3000)]);await c.wait(`!!document.querySelector('#property-repair-pane .metadata-property-warning-icon')`,'mismatch widget');
   await c.click('#property-repair-pane .metadata-property-warning-icon');await c.wait(`!!document.querySelector('.modal')`,'repair confirmation');
   steps.push({action:label+' modal',...await ev(`({title:document.querySelector('.modal-title').textContent,body:document.querySelector('.modal-content').innerText,buttons:[...document.querySelectorAll('.modal-button-container button')].map(e=>e.textContent),source:await app.vault.read(window.__propertyRepair.file)})`)});await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:6,y:10});await c.capture(output,name+'-'+label+'-modal','.modal');
   await c.click('.modal-button-container .mod-cancel');await read(label+' cancel');
   await c.click('#property-repair-pane .metadata-property-warning-icon');await c.wait(`!!document.querySelector('.modal')`,'repair confirmation again');await c.click('.modal-button-container .mod-cta');await read(label+' update');await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:6,y:10});await c.capture(output,name+'-'+label+'-updated','#property-repair-pane .metadata-container');
   await c.send('Input.insertText',{text:'repaired'});await c.key('Enter');await read(label+' edit');
  }
  const switchText='---\naliases: 12\n---\n# Fixture\n';
  await ev(`(async()=>{const s=window.__propertyRepair;s.pane.detach();s.file=app.vault.getFileByPath('Property repair fixture.md');await app.vault.modify(s.file,${JSON.stringify(switchText)});await s.leaf.openFile(s.file);s.pane=app.workspace.getRightLeaf(true);await s.pane.setViewState({type:'file-properties',state:{file:s.file.path}});await app.workspace.revealLeaf(s.pane);s.pane.view.containerEl.id='property-repair-pane';})()`);await delay(300);
  await c.click('#property-repair-pane .metadata-property-warning-icon');await c.wait(`!!document.querySelector('.modal')`,'file-switch repair');await c.click('.modal-button-container .mod-cta');await read('repair before switching files');
  await ev(`(async()=>{const s=window.__propertyRepair,path='Property repair second.md',file=app.vault.getFileByPath(path);if(file)await app.vault.modify(file,${JSON.stringify(switchText)});else await app.vault.create(path,${JSON.stringify(switchText)});s.file=app.vault.getFileByPath(path);await s.leaf.openFile(s.file);await s.pane.setViewState({type:'file-properties',state:{file:path}});})()`);await read('switching files with identical data');
  await ev(`app.vault.modify(window.__propertyRepair.file,${JSON.stringify('---\naliases: 13\n---\n# Fixture\n')})`);await read('changing the value restores mismatch display');
  await ev(`app.vault.modify(window.__propertyRepair.file,${JSON.stringify(switchText)})`);await read('returning to prior value keeps mismatch display');
  report[name]={steps,errors:c.errors};
 }catch(error){report[name]={steps,error:error.message,errors:c.errors};}
 finally{await c.key('Escape').catch(()=>{});await ev(`(()=>{const s=window.__propertyRepair;if(!s)return;if(s.pane?.parent)s.pane.detach();if(s.leaf?.parent)s.leaf.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__propertyRepair;})()`).catch(()=>{});await delay(300);c.socket.close();}
}
report.differences=report.obsen?report.reference.steps.flatMap((s,i)=>JSON.stringify(s)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:s,obsen:report.obsen.steps[i]}]):[];await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({counts:Object.fromEntries(Object.entries(report).filter(([,v])=>v.steps).map(([k,v])=>[k,v.steps.length])),differences:report.differences,errors:Object.fromEntries(Object.entries(report).filter(([,v])=>v.steps).map(([k,v])=>[k,v.error??v.errors]))},null,2));
for(const[key,value]of Object.entries(report))if(value.steps){assert.equal(value.error,undefined,key);assert.deepEqual(value.errors,[]);assert.equal(value.steps.length,cases.length*4+4);}assert.deepEqual(report.differences,[]);
