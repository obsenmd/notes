import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient, delay} from './fixture-client.mjs';

const output='dist/todo-backup/property-input-comparison', report={};
await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]) {
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}), ev=c.evaluate, steps=[];
 const row=key=>`#property-input-pane .metadata-property[data-property-key=${JSON.stringify(key)}]`;
 const input=key=>row(key)+' .multi-select-input';
 const type=text=>c.send('Input.insertText',{text});
 const clear=async()=>{await c.key('a','KeyA',{modifiers:2,windowsVirtualKeyCode:65});await c.key('Backspace');};
 const reset=async yaml=>{
  await ev(`(async()=>{const s=window.__propertyInput;if(s.pane?.parent)s.pane.detach();const text=${JSON.stringify('---\n')}+${JSON.stringify(yaml)}+${JSON.stringify('\n---\n# Fixture\n')};await app.vault.modify(s.file,text);await s.leaf.openFile(s.file);s.pane=app.workspace.getRightLeaf(true);await s.pane.setViewState({type:'file-properties',state:{file:s.file.path}});await app.workspace.revealLeaf(s.pane);s.pane.view.containerEl.id='property-input-pane';})()`);
  await c.wait(`!!document.querySelector('#property-input-pane .multi-select-input')`,'property input mounted');await delay(200);
 };
 const read=async action=>{
  await delay(350);
  steps.push({action,...await ev(`(async()=>{const s=window.__propertyInput,el=s.pane.view.containerEl,active=document.activeElement;return {source:await app.vault.read(s.file),focus:{key:active?.closest('.metadata-property')?.dataset.propertyKey??null,class:active===document.body?'body':active?.className??''},rows:[...el.querySelectorAll('.metadata-property')].map(r=>({key:r.dataset.propertyKey,pills:[...r.querySelectorAll('.multi-select-pill')].map(p=>({text:p.querySelector('.multi-select-pill-content')?.textContent,invalid:p.classList.contains('is-invalid'),duplicate:p.classList.contains('multi-select-duplicate')})),inputs:[...r.querySelectorAll('.multi-select-input')].map(i=>({text:i.textContent,innerText:i.innerText}))})),errors:[...document.querySelectorAll('.tooltip.mod-error')].map(e=>e.textContent)};})()`)});
 };
 const paste=async (plain,html,uri)=>ev(`(()=>{const el=document.activeElement,data=new DataTransfer();data.setData('text/plain',${JSON.stringify(plain)});${html?`data.setData('text/html',${JSON.stringify(html)});`:''}${uri?`data.setData('text/uri-list',${JSON.stringify(uri)});`:''}const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});el.dispatchEvent(event);return{defaultPrevented:event.defaultPrevented,trusted:event.isTrusted};})()`);
 try {
  if(name==='reference')await ev(`app.internalPlugins.plugins.properties.enable(false)`);
  await ev(`(async()=>{const path='Property input fixture.md';let file=app.vault.getFileByPath(path);if(!file)file=await app.vault.create(path,${JSON.stringify('# Fixture\n')});window.__propertyInput={file,previous:app.workspace.activeLeaf,leaf:app.workspace.getLeaf('tab')};})()`);
  await reset('list: [one, two]\naliases: [Old, Other]\ntags: [base, second]');
  await Promise.race([c.send('Page.captureScreenshot',{format:'png'}),delay(3000)]);
  for(const [key,text,label] of [['list','  spaced  ','ordinary whitespace'],['list','   ','ordinary spaces only'],['aliases','  Alias  ','alias trimming'],['aliases','   ','alias spaces only'],['aliases','Old','alias duplicate'],['aliases','old','alias case variant'],['tags','#base','tag hash duplicate'],['tags','BASE','tag case variant']]){
   await reset('list: [one, two]\naliases: [Old, Other]\ntags: [base, second]');
   await c.click(input(key));await type(text);await c.key('Enter');await read(label+' Enter');
   await c.click('#property-input-pane .metadata-properties-title');await read(label+' blur');
   if(['ordinary whitespace','alias duplicate','tag hash duplicate'].includes(label)){await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:6,y:10});await c.capture(output,name+'-'+label.replaceAll(' ','-'),'#property-input-pane .metadata-container');}
  }
  await reset('list: [one, one]\naliases: [Old, Old, " "]\ntags: [base, "#base", "bad tag"]');await c.click('#property-input-pane .metadata-properties-title');await read('loaded duplicates and blank alias');await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:6,y:10});await c.capture(output,name+'-loaded-invalid-values','#property-input-pane .metadata-container');
  for(const [key,text]of [['aliases','Old'],['tags','#base']]){
   await reset('list: [one, two]\naliases: [Old, Other]\ntags: [base, second]');
   await ev(`document.querySelector(${JSON.stringify(row(key)+' .multi-select-pill:nth-child(2)')}).focus()`);await c.key('Enter');await type(text);await c.key('Enter');await read(key+' inline duplicate');await c.key('Escape');await read(key+' duplicate edit cancel');
  }
  for(const [key,plain,html,label]of [['list','first\nsecond',null,'multiline ordinary paste'],['aliases','first\nsecond',null,'multiline alias paste'],['tags','first\nsecond',null,'multiline tag paste'],['list','  pasted  ','<b>rich ignored</b>','rich clipboard plain text']]){
   await reset('list: [one, two]\naliases: [Old, Other]\ntags: [base, second]');await c.click(input(key));steps.push({action:label+' event',...await paste(plain,html)});await read(label+' pending');await c.key('Enter');await read(label+' save');
  }
  for(const [plain,html,uri,label]of [['','<b>HTML</b><script>ignored()</script><i>text</i>',null,'HTML only paste'],['',null,' https://example.test/first \nhttps://example.test/second','URI list paste']]){
   await reset('list: [one, two]\naliases: [Old, Other]\ntags: [base, second]');await c.click(input('list'));steps.push({action:label+' event',...await paste(plain,html,uri)});await read(label+' pending');await c.key('Enter');await read(label+' save');
  }
  await reset('list: [one, two]\naliases: [Old, Other]\ntags: [base, second]');await c.click(input('list'));await type('composition');
  steps.push({action:'composition Enter event',...await ev(`(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true});document.activeElement.dispatchEvent(e);return{defaultPrevented:e.defaultPrevented,trusted:e.isTrusted};})()`)});await read('composition Enter leaves pending text');await c.key('Enter');await read('Enter after composition commits');
  report[name]={steps,errors:c.errors,historicalErrors:c.historicalErrors};
 }catch(error){report[name]={steps,error:error.message,errors:c.errors};}
 finally{await c.key('Escape').catch(()=>{});await ev(`(()=>{const s=window.__propertyInput;if(!s)return;if(s.pane?.parent)s.pane.detach();if(s.leaf?.parent)s.leaf.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__propertyInput;})()`).catch(()=>{});c.socket.close();}
}
report.differences=report.reference.steps.flatMap((step,i)=>JSON.stringify(step)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:step,obsen:report.obsen.steps[i]}]);
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({counts:{reference:report.reference.steps.length,obsen:report.obsen.steps.length},differences:report.differences,errors:{reference:report.reference.error??report.reference.errors,obsen:report.obsen.error??report.obsen.errors}},null,2));
assert.equal(report.reference.error,undefined);assert.equal(report.obsen.error,undefined);assert.equal(report.reference.steps.length,42);assert.equal(report.obsen.steps.length,42);assert.deepEqual(report.differences,[]);assert.deepEqual(report.reference.errors,[]);assert.deepEqual(report.obsen.errors,[]);
