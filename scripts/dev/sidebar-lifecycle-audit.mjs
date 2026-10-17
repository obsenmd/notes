import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const output='dist/todo-backup/sidebar-lifecycle-comparison';
await fs.mkdir(output,{recursive:true});
const plugins=[['global-search','Search','search'],['bookmarks','Bookmarks','bookmarks'],['file-explorer','Files','file-explorer'],['backlink','Backlinks','backlink'],['outgoing-link','Outgoing links','outgoing-link'],['tag-pane','Tags view','tag'],['outline','Outline','outline'],['properties','Properties view','all-properties']];
const report={};
const togglesOnly=process.argv.includes('--toggles-only');
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7);
for(const[name,port,prefix]of[['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']].filter(([name])=>!only||only===name)){
 const c=await fixtureClient(port,prefix),ev=c.evaluate,steps=[];
 try{
  await c.wait(`!!app.workspace.layoutReady`,'workspace startup complete');
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await ev(`(()=>{app.workspace.setActiveLeaf(app.workspace.getMostRecentLeaf());app.vault.setConfig('settingsPopoutWindow',false);if(!document.querySelector('.modal.mod-settings'))app.commands.executeCommandById('app:open-settings');})()`);
  await c.wait(`!!document.querySelector('.modal.mod-settings')`,'settings mounted');
  await ev(`document.querySelector('.modal.mod-settings [data-setting-id=plugins]').click()`);
  await delay(300);
  const names=await ev(`([...document.querySelectorAll('.modal.mod-settings .setting-item-name')].map(e=>e.textContent))`);
  for(const[id,label,type]of plugins){
   console.log(`${name}: ${id}`);
   const row=`[...document.querySelectorAll('.modal.mod-settings .setting-item')].find(e=>e.querySelector('.setting-item-name')?.textContent.trim()===${JSON.stringify(label)})`;
   if(!names.includes(label))throw Error(`Missing ${label}; names: ${JSON.stringify(names)}`);
   const toggle=async enabled=>{
    if(!await ev(`!!document.querySelector('.modal.mod-settings')`)){await ev(`app.commands.executeCommandById('app:open-settings')`);await c.wait(`!!document.querySelector('.modal.mod-settings')`,'settings reopened');await ev(`document.querySelector('.modal.mod-settings [data-setting-id=plugins]').click()`);await delay(150);}
    if(await ev(`${row}.querySelector('.checkbox-container').classList.contains('is-enabled')`)!==enabled){await ev(`${row}.querySelector('.checkbox-container').click()`);await delay(500);}
   };
   // A previous popout-close may have removed an enabled plugin's last pane.
   // Start each sequence with the same freshly registered default pane.
   await toggle(false);await toggle(true);
   steps.push({id,phase:'enabled',leaves:await ev(`app.workspace.getLeavesOfType(${JSON.stringify(type)}).length>0`)});
   await toggle(false);
   steps.push({id,phase:'disabled',leaves:await ev(`app.workspace.getLeavesOfType(${JSON.stringify(type)}).length>0`)});
   await toggle(true);
   steps.push({id,phase:'re-enabled',leaves:await ev(`app.workspace.getLeavesOfType(${JSON.stringify(type)}).length>0`)});
  }
  await ev(`document.querySelector('.modal.mod-settings .modal-header-button').click()`);
  // The reference only moves ItemView/FileView panes to a window; its search,
  // bookmarks, explorer, tags and all-properties panes reject this operation.
  for(const[id,,type]of togglesOnly?[]:plugins.filter(([, ,type])=>['backlink','outgoing-link','outline'].includes(type))){
   console.log(`${name}: popout ${type}`);
   await ev(`(()=>{window.__auditPopout=app.workspace.moveLeafToPopout(app.workspace.getLeavesOfType(${JSON.stringify(type)})[0],{size:{width:800,height:600}});})()`);
   await c.wait(`!!window.__auditPopout?.win?.document.querySelector('.workspace-leaf-content[data-type=${type}]')`,'popout pane mounted');
   await delay(350);
   steps.push({id,phase:'popout',mounted:await ev(`!!window.__auditPopout.win.document.querySelector('.workspace-leaf-content[data-type=${type}] .view-content, .workspace-leaf-content[data-type=${type}] .nav-files-container')`)});
   await ev(`(()=>{window.__auditPopout.win.close();delete window.__auditPopout;})()`);
   await delay(350);
   steps.push({id,phase:'popout-closed',leaves:await ev(`app.workspace.getLeavesOfType(${JSON.stringify(type)}).length`)});
  }
  report[name]={steps,errors:c.errors};
 }finally{
  await ev(`(()=>{if(window.__auditPopout?.win&&!window.__auditPopout.win.closed)window.__auditPopout.win.close();delete window.__auditPopout;})()`).catch(()=>undefined);
  c.socket.close();
 }
}
report.differences=report.reference&&report.obsen?report.reference.steps.flatMap((s,i)=>JSON.stringify(s)===JSON.stringify(report.obsen.steps[i])?[]:[{reference:s,obsen:report.obsen.steps[i]}]):[];
await fs.writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:report.reference?.steps.length??report.obsen?.steps.length,differences:report.differences,errors:{reference:report.reference?.errors,obsen:report.obsen?.errors}},null,2));
if(report.differences.length||Object.values(report).some(x=>x?.errors?.length))process.exitCode=1;
