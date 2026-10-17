import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fixtureClient,delay} from './fixture-client.mjs';
const require=createRequire(import.meta.url),output='dist/todo-backup/deep-link-comparison',report={};await fs.mkdir(output,{recursive:true});
const freePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
for(const [name,prefix,script]of [['reference','obsen-reference-audit-','scripts/dev/reference-fixture.cjs'],['obsen','obsen-electron-smoke-','scripts/dev/startup-fixture.cjs']]){
 const steps=[];
 for(const mode of ['preview']){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),prefix+'deeplink-')),config=path.join(directory,'vault','.obsidian'),port=await freePort();
  await fs.mkdir(config,{recursive:true});await fs.mkdir(path.join(directory,'profile'));
  const input='First\r\nSecond\r\n';await fs.writeFile(path.join(directory,'vault','Source.md'),input);
  for(const [file,value]of Object.entries({'app.json':{},'appearance.json':{},'bookmarks.json':{items:[]},'core-plugins.json':{'daily-notes':false,sync:false},'community-plugins.json':[],'daily-notes.json':{},'types.json':{types:{}},'workspace.json':{main:{id:'root',type:'split',direction:'vertical',children:[{id:'tabs',type:'tabs',children:[{id:'source',type:'leaf',state:{type:'markdown',state:{file:'Source.md',mode,source:false}}}]}]},active:'source',lastOpenFiles:[]}}))await fs.writeFile(path.join(config,file),JSON.stringify(value));
  if(name==='obsen') {
   const pluginDir=path.join(config,'plugins','uri-proof');await fs.mkdir(pluginDir,{recursive:true});
   await fs.writeFile(path.join(pluginDir,'manifest.json'),JSON.stringify({id:'uri-proof',name:'URI proof',version:'1.0.0',minAppVersion:'1.0.0',author:'Fixture'}));
   await fs.writeFile(path.join(pluginDir,'main.js'),"const {Plugin}=require('obsidian');module.exports=class extends Plugin{onload(){window.__uriPlugin=this;this.registerObsidianProtocolHandler('uri-proof',p=>{window.__uriParams=p;});}};");
   await fs.writeFile(path.join(config,'community-plugins.json'),'["uri-proof"]');
  }
  const env={...process.env,OBSEN_STARTUP_FIXTURE:directory,OBSEN_STARTUP_PORT:String(port),OBSEN_REFERENCE_FIXTURE:directory,OBSEN_REFERENCE_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),[path.resolve(script)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let c;
  await fs.writeFile(path.join(directory,'runner.json'),JSON.stringify({pid:child.pid,port,script:path.resolve(script)}));
  try{
   const deadline=Date.now()+30000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error('Owned startup process exited: '+log);try{c=await fixtureClient(port,prefix);break;}catch{}await delay(150);}assert.ok(c,'CRLF startup reaches application state: '+log);
   await c.wait(`!!app.workspace.layoutReady&&!!app.workspace.activeLeaf.view.editor?.cm`,'CRLF document mounted');
   const ev=c.evaluate;
   if(name==='obsen') {await c.wait(`!!document.querySelector('.modal button.mod-cta')`,'fixture plugin trust prompt');await c.click('.modal button.mod-cta');await c.wait(`!!window.__uriPlugin&&!!app.workspace.activeLeaf.view.editor?.cm`,'trusted fixture plugin startup');}
   const initial=await ev(`(async()=>{const v=app.workspace.activeLeaf.view;return {mode:v.getMode(),editor:v.editor.getValue(),file:await app.vault.read(v.file),cursor:v.editor.getCursor()};})()`);steps.push({action:mode+' startup',...initial});

   for (const [action,params,expected] of [
    ['new',{file:'URI proof',content:'Alpha + Beta'},'Alpha + Beta'],
    ['append',{file:'URI proof',content:'Gamma',append:'true'},'Alpha + Beta\n\nGamma'],
    ['prepend',{file:'URI proof',content:'First',prepend:'true'},'First\n\nAlpha + Beta\n\nGamma'],
    ['overwrite',{file:'URI proof',content:'Replacement',overwrite:'true'},'Replacement'],
    ['silent',{file:'URI silent',content:'Hidden',silent:'true'},'Hidden'],
   ]) {
    const uri='obsidian://new?'+Object.entries(params).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
    const emitted=await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url',${JSON.stringify(uri)})`);
    const file=params.file+'.md';
    await c.wait(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(file)});return !!f&&(await app.vault.read(f))===${JSON.stringify(expected)};})()`,action+' source');
    if(action!=='silent')await c.wait(`app.workspace.getActiveFile()?.path===${JSON.stringify(file)}`,action+' navigation');
    steps.push({action,emitted,...await ev(`(async()=>({file:app.workspace.getActiveFile()?.path,content:await app.vault.read(app.vault.getFileByPath(${JSON.stringify(file)}))}))()`)});
   }
   await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url','obsidian://new?file=URI+plus&content=Literal+plus')`);
   await c.wait(`app.workspace.getActiveFile()?.path==='URI+plus.md'`,'literal plus navigation');
   steps.push({action:'literal plus',content:await ev(`app.vault.read(app.vault.getFileByPath('URI+plus.md'))`)});

   let edge=0;
   for (const side of ['append','prepend']) for (const [original,content] of [['',''],['','More'],['Existing\n','More'],['Existing\n\n','More\n'],['\n\nExisting','\n\nMore'],['   ','More']]) {
    const filename='URI edge '+(++edge)+'.md';
    await ev(`(async()=>{await app.vault.create(${JSON.stringify(filename)},${JSON.stringify(original)});window.__uriModified=null;window.__uriRef=app.vault.on('modify',f=>{if(f.path===${JSON.stringify(filename)})window.__uriModified=f.path;});})()`);
    const uri='obsidian://new?'+Object.entries({file:filename,content,[side]:'true'}).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
    await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url',${JSON.stringify(uri)})`);
    await c.wait(`app.workspace.getActiveFile()?.path===${JSON.stringify(filename)}`,side+' newline edge navigation '+edge);
    steps.push({action:side+' edge '+edge,original,input:content,content:await ev(`app.vault.read(app.vault.getFileByPath(${JSON.stringify(filename)}))`)});
    await ev(`app.vault.offref(window.__uriRef)`);
   }
   const open='obsidian://open?'+'file=Source&paneType=tab';
   await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url',${JSON.stringify(open)})`);
   await c.wait(`app.workspace.getActiveFile()?.path==='Source.md'`,'open navigation');
   steps.push({action:'open tab',...await ev(`(()=>{let count=0;app.workspace.iterateAllLeaves(l=>{if(l.view.getViewType()==='markdown')count++;});return {file:app.workspace.getActiveFile()?.path,count};})()`)});

   const pathOpen='obsidian://open?'+new URLSearchParams({path:path.join(directory,'vault'),file:'Source'}).toString();
   await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url',${JSON.stringify(pathOpen)})`);
   await c.wait(`app.workspace.getActiveFile()?.path==='Source.md'`,'path-selected vault navigation');
   steps.push({action:'open using absolute vault path',file:await ev(`app.workspace.getActiveFile()?.path`)});

   const reopenLeaf=await ev(`(async()=>{const file=app.vault.getFileByPath('URI close reopen.md')??await app.vault.create('URI close reopen.md','# Close and reopen');const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);app.workspace.setActiveLeaf(leaf);return leaf.id;})()`);
   await ev(`app.workspace.activeLeaf.detach()`);
   await c.wait(`!app.workspace.getLeavesOfType('markdown').some(l=>l.id===${JSON.stringify(reopenLeaf)})`,'close URI target tab');
   await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url','obsidian://open?file=URI%20close%20reopen&paneType=tab')`);
   await c.wait(`app.workspace.getActiveFile()?.path==='URI close reopen.md'`,'reopen closed URI target tab');
   steps.push({action:'close and reopen URI target tab',reopenedInNewLeaf:await ev(`app.workspace.activeLeaf?.id!==${JSON.stringify(reopenLeaf)}`),activeFile:await ev(`app.workspace.getActiveFile()?.path`)});

   await ev(`(async()=>{const type='backlink',leaf=app.workspace.getLeavesOfType(type)[0]??app.workspace.getRightLeaf(true);await leaf.setViewState({type,state:{file:'Source.md'}});window.__uriSidebarPopout=app.workspace.moveLeafToPopout(leaf,{size:{width:800,height:600}});})()`);
   await c.wait(`!!window.__uriSidebarPopout?.win?.document.querySelector('.workspace-leaf-content[data-type="backlink"] .view-content')`,'sidebar mounted in popout');
   await ev(`window.__uriSidebarPopout.win.close()`);await delay(350);
   await ev(`(async()=>{const leaf=app.workspace.getRightLeaf(true);await leaf.setViewState({type:'backlink',state:{file:'Source.md'}});window.__uriSidebarReopened=leaf;})()`);
   await c.wait(`!!document.querySelector('.workspace-leaf-content[data-type="backlink"] .view-content')`,'sidebar reopened in dock');
   steps.push({action:'close sidebar popout and reopen in dock',popoutClosed:await ev(`!window.__uriSidebarPopout?.win||window.__uriSidebarPopout.win.closed`),reopenedInDock:await ev(`!!app.workspace.getLeavesOfType('backlink').find(l=>l===window.__uriSidebarReopened)`)});

   await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url','obsidian://search?query=URI%20proof')`);
   await c.wait(`app.workspace.getLeavesOfType('search').some(l=>l.view.getState().query==='URI proof')`,'search query');
   steps.push({action:'search',queries:await ev(`app.workspace.getLeavesOfType('search').map(l=>l.view.getState().query)`)});
   if(name==='reference') {
    const manifest={id:'uri-proof',name:'URI proof',version:'1.0.0',minAppVersion:'1.0.0',author:'Fixture'};
    const main="const {Plugin}=require('obsidian');module.exports=class extends Plugin{onload(){window.__uriPlugin=this;this.registerObsidianProtocolHandler('uri-proof',p=>{window.__uriParams=p;});}};";
    await ev(`(async()=>{const d=app.vault.configDir+'/plugins/uri-proof';await app.vault.adapter.mkdir(d);await app.vault.adapter.write(d+'/manifest.json',${JSON.stringify(JSON.stringify(manifest))});await app.vault.adapter.write(d+'/main.js',${JSON.stringify(main)});await app.plugins.loadManifests();await app.plugins.setEnable(true);await app.plugins.loadPlugin('uri-proof');})()`);
   }
   console.log(name+': plugin prepared',await ev(`({loaded:!!window.__uriPlugin,loadedIds:Object.keys(app.plugins.plugins??{})})`));
   await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url','obsidian://uri-proof?value=literal+plus&space=two%20words')`);
   await c.wait(`!!window.__uriParams`,'plugin URI callback');
   steps.push({action:'plugin URI',params:await ev(`window.__uriParams`)});
   await ev(`(()=>{window.__uriPlugin.unload();window.__uriParams=null;})()`);
   await ev(`require('electron').ipcRenderer.invoke('dev:fixture-open-url','obsidian://uri-proof?value=after-unload')`);await delay(250);
   steps.push({action:'plugin URI cleanup',params:await ev(`window.__uriParams`)});
   assert.deepEqual(c.errors,[]);console.log(name+': main-process URI actions passed');
  }finally{c?.socket.close();child.kill();await fs.writeFile(path.join(directory,'run.log'),log);}
 }
 report[name]=steps;
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));assert.deepEqual(report.obsen,report.reference);assert.equal(report.obsen.length,26);console.log('Paired main-process deep-link checks passed.');
