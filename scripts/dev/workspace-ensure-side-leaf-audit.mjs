import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fixtureClient,delay} from './fixture-client.mjs';

const require=createRequire(import.meta.url), report={};
const freePort=async()=>{const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};
for(const [name,prefix,script] of [['reference','obsen-reference-audit-','scripts/dev/reference-fixture.cjs'],['obsen','obsen-electron-smoke-','scripts/dev/startup-fixture.cjs']]){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),prefix+'ensure-side-leaf-')),vault=path.join(directory,'vault'),config=path.join(vault,'.obsidian'),port=await freePort();
 await fs.mkdir(config,{recursive:true});await fs.mkdir(path.join(directory,'profile'));await fs.writeFile(path.join(vault,'Source.md'),'# Side leaf probe\n');
 const workspace={main:{id:'root',type:'split',direction:'vertical',children:[{id:'tabs',type:'tabs',children:[{id:'source',type:'leaf',state:{type:'markdown',state:{file:'Source.md',mode:'preview',source:false}}}]}]},active:'source',lastOpenFiles:[]};
 for(const [file,value]of Object.entries({'app.json':{},'appearance.json':{},'bookmarks.json':{items:[]},'core-plugins.json':{'daily-notes':false,sync:false},'community-plugins.json':[],'daily-notes.json':{},'types.json':{types:{}},'workspace.json':workspace}))await fs.writeFile(path.join(config,file),JSON.stringify(value));
 const env={...process.env,OBSEN_STARTUP_FIXTURE:directory,OBSEN_STARTUP_PORT:String(port),OBSEN_REFERENCE_FIXTURE:directory,OBSEN_REFERENCE_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[path.resolve(script)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let client;
 try{
  const deadline=Date.now()+30000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error('Fixture exited: '+log);try{client=await fixtureClient(port,prefix);break;}catch{await delay(150);}}
  assert.ok(client,'Fixture is available');await client.wait(`!!app.workspace.layoutReady`,'workspace layout ready');
  report[name]={probe:await client.evaluate(`(async()=>{const workspace=app.workspace,method=workspace.ensureSideLeaf;if(typeof method!=='function')return{available:false};const rightBefore=workspace.rightSplit?.children?.length??0;const optionLeaf=await method.call(workspace,'backlink','right',{split:true,active:true,reveal:true,state:{file:'Source.md'}});const optionProbe={onRight:optionLeaf.getRoot()===workspace.rightSplit,activeSet:workspace.activeLeaf===optionLeaf,rightLeafCountBefore:rightBefore,rightLeafCountAfter:workspace.rightSplit?.children?.length??0,isConnected:optionLeaf.containerEl?.isConnected??null,state:optionLeaf.getViewState().state};const views={};for(const [index,type] of ['search','backlink','outgoing-link','tag','outline','all-properties'].entries()){const before=workspace.activeLeaf,leaf=await method.call(workspace,type,'right',{...(index?{split:true}:{}),...(type==='backlink'?{state:{file:'Source.md'}}:{}),active:false,reveal:false});views[type]={type:leaf.getViewState().type,viewType:leaf.view.getViewType(),onRight:leaf.getRoot()===workspace.rightSplit,activeUnchanged:workspace.activeLeaf===before,state:leaf.getViewState().state};}return{available:true,optionProbe,views};})()`),errors:client.errors};
 }finally{client?.socket.close();child.kill();await fs.writeFile(path.join(directory,'probe.log'),log);}
}
await fs.mkdir('dist/todo-backup/workspace-ensure-side-leaf-comparison',{recursive:true});await fs.writeFile('dist/todo-backup/workspace-ensure-side-leaf-comparison/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
for(const name of ['reference','obsen']){assert.equal(report[name].probe.available,true,`${name} exposes ensureSideLeaf`);assert.deepEqual(report[name].errors,[]);for(const [type,view] of Object.entries(report[name].probe.views)){assert.equal(view.type,type);assert.equal(view.viewType,type);assert.equal(view.activeUnchanged,true);}}
assert.deepEqual(report.obsen.probe.views,report.reference.probe.views,'Core sidebar default states match the pinned runtime');
assert.deepEqual(report.obsen.probe.optionProbe,report.reference.probe.optionProbe,'Backlinks active/reveal/split behavior matches the pinned runtime');
