import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const report={},output='dist/todo-backup/popout-appearance-comparison';await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix]of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}),steps=[];
 const saved=await c.evaluate(`(()=>{const data={};for(const key of ['theme','showInlineTitle'])data[key]=app.vault.getConfig(key);data.font={defined:app.vault.getConfig('baseFontSize')!==undefined,value:app.vault.getConfig('baseFontSize')};data.deviceFont=${name==='reference'?`app.getBaseFontSize()`:`app.vault.configStore.get('baseFontSize')`};return data;})()`);
 try{
  await c.evaluate(`${name==='reference'?`app.setBaseFontSize(18)`:`app.vault.configStore.set('baseFontSize',18)`}`);
  await c.evaluate(`(async()=>{const previous=app.workspace.activeLeaf,path='Popout appearance audit.md';if(!app.vault.getFileByPath(path))await app.vault.create(path,${JSON.stringify('First line\nSecond line\n')});const leaf=await app.workspace.openPopoutLeaf();window.__appearanceAudit={previous,leaf,win:leaf.getContainer().win};await leaf.setViewState({type:'markdown',state:{file:path,mode:'source',source:true}});})()`);await c.wait(`!!window.__appearanceAudit.leaf.view.editor.cm`,'popout editor');
  for(const [label,values]of [['dark title', {theme:'obsidian',baseFontSize:18,showInlineTitle:true}],['hidden title',{showInlineTitle:false}],['light raw font write retains device size',{theme:'moonstone',baseFontSize:20,showInlineTitle:true}]]){
   await c.evaluate(`(()=>{for(const [key,value]of Object.entries(${JSON.stringify(values)}))app.vault.setConfig(key,value);})()`);await delay(500);
   steps.push({action:label,...await c.evaluate(`(()=>{const s=window.__appearanceAudit,doc=s.win.document,body=doc.body,title=s.leaf.containerEl.querySelector('.markdown-source-view .inline-title'),cm=s.leaf.view.editor.cm;return {popout:body.classList.contains('is-popout-window'),dark:body.classList.contains('theme-dark'),light:body.classList.contains('theme-light'),titleVisible:getComputedStyle(title).display!=='none',fontSize:getComputedStyle(cm.contentDOM).fontSize,zoom:body.style.getPropertyValue('--zoom-factor')};})()`)});
  }
  report[name]={steps,errors:c.errors};
 }finally{await c.evaluate(`(()=>{const saved=${JSON.stringify(saved)};for(const key of ['theme','showInlineTitle'])app.vault.setConfig(key,saved[key]);app.vault.setConfig('baseFontSize',saved.font.defined?saved.font.value:undefined);${name==='reference'?`app.setBaseFontSize(saved.deviceFont)`:`app.vault.configStore.set('baseFontSize',saved.deviceFont)`};const s=window.__appearanceAudit;if(s){s.leaf.detach();if(!s.win.closed)s.win.close();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);}delete window.__appearanceAudit;})()`);c.socket.close();}
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));assert.deepEqual(report.obsen,report.reference);assert.deepEqual(report.obsen.errors,[]);console.log('Three paired live popout appearance checks passed.');
