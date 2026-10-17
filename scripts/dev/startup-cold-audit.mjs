import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import moment from 'moment';
import {fixtureClient,delay} from './fixture-client.mjs';
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7);
if(only&&!['obsen','reference'].includes(only))throw Error('Unknown cold startup fixture selection');
const require=createRequire(import.meta.url),output='dist/todo-backup/startup-cold-comparison'+(only?'/'+only+'-only':''),report={};await fs.mkdir(output,{recursive:true});
const freePort=async()=>{const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;};
for(const [name,prefix,script]of[['reference','obsen-reference-audit-','scripts/dev/reference-fixture.cjs'],['obsen','obsen-electron-smoke-','scripts/dev/startup-fixture.cjs']].filter(([name])=>!only||only===name)){
 const steps=[];
 for(const test of [{label:'fresh daily startup',enabled:true},{label:'existing daily startup',enabled:true,existing:true},{label:'legacy autorun cold startup',enabled:true,legacy:true},{label:'disabled daily cold startup',enabled:false}]){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),prefix+'cold-')),vault=path.join(directory,'vault'),config=path.join(vault,'.obsidian'),port=await freePort(),daily='Cold daily/'+moment().format('YYYY-MM-DD')+'.md';
  await fs.mkdir(config,{recursive:true});await fs.mkdir(path.join(vault,'Cold daily'));await fs.mkdir(path.join(directory,'profile'));
  await fs.writeFile(path.join(vault,'Startup source.md'),'Source stays.\n');await fs.writeFile(path.join(vault,'Startup template.md'),'Cold {{title}}\n');
  if(test.existing)await fs.writeFile(path.join(vault,daily),'Existing stays.');
  await fs.writeFile(path.join(config,'app.json'),JSON.stringify({openBehavior:test.legacy?'':'daily'}));
  await fs.writeFile(path.join(config,'core-plugins.json'),JSON.stringify({'daily-notes':test.enabled}));await fs.writeFile(path.join(config,'community-plugins.json'),'[]');
  await fs.writeFile(path.join(config,'daily-notes.json'),JSON.stringify({format:'YYYY-MM-DD',folder:'Cold daily',template:'Startup template',...(test.legacy?{autorun:true}:{})}));
  await fs.writeFile(path.join(config,'workspace.json'),JSON.stringify({main:{id:'cold-root',type:'split',direction:'vertical',children:[{id:'cold-tabs',type:'tabs',children:[{id:'cold-source',type:'leaf',state:{type:'markdown',state:{file:'Startup source.md',mode:'preview',source:false}}}]}]},active:'cold-source',lastOpenFiles:[]}));
  const env={...process.env,OBSEN_REFERENCE_FIXTURE:directory,OBSEN_REFERENCE_PORT:String(port),OBSEN_STARTUP_FIXTURE:directory,OBSEN_STARTUP_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),[path.resolve(script)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  let c,observation='';
  try{
   const deadline=Date.now()+30000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error('Fixture exited: '+log);try{c=await fixtureClient(port,prefix);break;}catch(error){observation=error.message;}await delay(200);}if(!c)throw Error('Cold fixture unavailable: '+observation+' '+log);
   await c.wait(`!!window.app?.workspace?.layoutReady`,'cold layout ready');await delay(1200);
   const state=await c.evaluate(`(async()=>{const root=[];app.workspace.iterateRootLeaves(l=>{root.push({file:l.getViewState().state?.file??null,mode:l.getViewState().state?.mode??null});});return{activeFile:app.workspace.getActiveFile()?.path,root,behavior:app.vault.getConfig('openBehavior'),options:JSON.parse(await app.vault.adapter.read('.obsidian/daily-notes.json')),content:await app.vault.adapter.exists(${JSON.stringify(daily)})?await app.vault.adapter.read(${JSON.stringify(daily)}):null};})()`);
   steps.push({action:test.label,...state,errors:c.errors});assert.deepEqual(c.errors,[]);console.log(name+': '+test.label);
  }finally{c?.socket.close();child.kill();await fs.writeFile(path.join(directory,'cold-run.log'),log);}
 }
 report[name]=steps;
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));if(report.reference&&report.obsen)assert.deepEqual(report.obsen,report.reference);for(const steps of Object.values(report))assert.equal(steps.length,4);console.log(only?`Four ${only}-only cold-process startup checks passed (not paired evidence).`:'Four paired cold-process startup checks passed.');
