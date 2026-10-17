import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fixtureClient,delay} from './fixture-client.mjs';
const require=createRequire(import.meta.url),output='dist/todo-backup/crlf-startup-comparison',report={};await fs.mkdir(output,{recursive:true});
const freePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
for(const [name,prefix,script]of [['reference','obsen-reference-audit-','scripts/dev/reference-fixture.cjs'],['obsen','obsen-electron-smoke-','scripts/dev/startup-fixture.cjs']]){
 const steps=[];
 for(const mode of ['preview','source']){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),prefix+'crlf-')),config=path.join(directory,'vault','.obsidian'),port=await freePort();
  await fs.mkdir(config,{recursive:true});await fs.mkdir(path.join(directory,'profile'));
  const input='First\r\nSecond\r\n';await fs.writeFile(path.join(directory,'vault','Source.md'),input);
  for(const [file,value]of Object.entries({'app.json':{},'appearance.json':{},'bookmarks.json':{items:[]},'core-plugins.json':{'daily-notes':false,sync:false},'community-plugins.json':[],'daily-notes.json':{},'types.json':{types:{}},'workspace.json':{main:{id:'root',type:'split',direction:'vertical',children:[{id:'tabs',type:'tabs',children:[{id:'source',type:'leaf',state:{type:'markdown',state:{file:'Source.md',mode,source:false}}}]}]},active:'source',lastOpenFiles:[]}}))await fs.writeFile(path.join(config,file),JSON.stringify(value));
  const env={...process.env,OBSEN_STARTUP_FIXTURE:directory,OBSEN_STARTUP_PORT:String(port),OBSEN_REFERENCE_FIXTURE:directory,OBSEN_REFERENCE_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),[path.resolve(script)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let c;
  await fs.writeFile(path.join(directory,'runner.json'),JSON.stringify({pid:child.pid,port,script:path.resolve(script)}));
  try{
   const deadline=Date.now()+30000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error('Owned startup process exited: '+log);try{c=await fixtureClient(port,prefix);break;}catch{}await delay(150);}assert.ok(c,'CRLF startup reaches application state: '+log);
   await c.wait(`!!app.workspace.layoutReady&&!!app.workspace.activeLeaf.view.editor?.cm`,'CRLF document mounted');
   const ev=c.evaluate;const initial=await ev(`(async()=>{const v=app.workspace.activeLeaf.view;return {mode:v.getMode(),editor:v.editor.getValue(),file:await app.vault.read(v.file),cursor:v.editor.getCursor()};})()`);steps.push({action:mode+' startup',...initial});
   await ev(`(async()=>{const l=app.workspace.activeLeaf;await l.setViewState({type:'markdown',state:{file:'Source.md',mode:'source',source:true}});l.view.editor.setCursor({line:1,ch:6});l.view.editor.replaceSelection('!\r\nThird');await l.view.save();})()`.replace('!\r\nThird', '!\\r\\nThird'));
   steps.push({action:mode+' edit and save',...await ev(`(async()=>{const v=app.workspace.activeLeaf.view;return {editor:v.editor.getValue(),file:await app.vault.read(v.file),cursor:v.editor.getCursor()};})()`)});
   for (const [action,code] of [
    ['setValue CRLF', "e.setValue('Alpha\\r\\nBeta\\r\\n');"],
    ['replaceRange CRLF', "e.setValue('Alpha\\nBeta\\n');e.setCursor({line:0,ch:2});e.replaceRange('X\\r\\nY',{line:0,ch:2});"],
    ['replaceRange before selection', "e.setValue('Alpha\\nBeta\\n');e.setSelection({line:1,ch:1},{line:1,ch:3});e.replaceRange('X\\r\\nY',{line:0,ch:1},{line:0,ch:4});"],
    ['replaceRange inside selection', "e.setValue('Alpha\\nBeta\\n');e.setSelection({line:0,ch:2},{line:0,ch:4});e.replaceRange('X\\r\\nY',{line:0,ch:1},{line:0,ch:4});"],
    ['transaction bare CR', "e.setValue('Alpha\\nBeta\\n');e.setCursor({line:0,ch:2});e.transaction({replaceSelection:'X\\rY'});"],
    ['transaction CRLF change', "e.setValue('Alpha\\nBeta\\n');e.setCursor({line:1,ch:2});e.transaction({changes:[{from:{line:0,ch:1},to:{line:0,ch:4},text:'X\\r\\nY'}]});"],
    ['transaction CRLF insertion', "e.setValue('Alpha\\nBeta\\n');e.setCursor({line:0,ch:2});e.transaction({replaceSelection:'X\\r\\nY'});"],
    ['transaction CRLF selection', "e.setValue('Alpha\\nBeta\\n');e.setSelection({line:0,ch:1},{line:0,ch:4});e.transaction({replaceSelection:'X\\r\\nY'});"],
   ]) { steps.push({action:mode+' '+action,...await ev(`(()=>{const e=app.workspace.activeLeaf.view.editor;${code}return {editor:e.getValue(),cursor:e.getCursor()};})()`)}); }
   assert.deepEqual(c.errors,[]);console.log(name+': '+mode+' CRLF startup/edit passed');
  }finally{c?.socket.close();child.kill();await fs.writeFile(path.join(directory,'run.log'),log);}
 }
 report[name]=steps;
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));assert.deepEqual(report.obsen,report.reference);assert.equal(report.obsen.length,20);console.log('Twenty paired fresh CRLF startup/editor/save/API checks passed.');
