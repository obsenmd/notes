import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fixtureClient,delay} from './fixture-client.mjs';

const require=createRequire(import.meta.url),report={};
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
for(const[name,script,prefix]of [['reference','scripts/dev/reference-fixture.cjs','obsen-reference-audit-app-vault-api-'],['obsen','scripts/dev/startup-fixture.cjs','obsen-electron-smoke-app-vault-api-']]){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),prefix)),vault=path.join(dir,'vault'),cfg=path.join(vault,'.obsidian'),port=await freePort();
 await fs.mkdir(cfg,{recursive:true});await fs.mkdir(path.join(dir,'profile'),{recursive:true});await fs.writeFile(path.join(vault,'Source.md'),'API probe\n');
 const workspace={main:{id:'root',type:'split',direction:'vertical',children:[{id:'tabs',type:'tabs',children:[{id:'source',type:'leaf',state:{type:'markdown',state:{file:'Source.md',mode:'preview',source:false}}}]}]},active:'source',lastOpenFiles:[]};
 for(const[file,value]of Object.entries({'app.json':{},'appearance.json':{},'bookmarks.json':{items:[]},'core-plugins.json':{},'community-plugins.json':[],'daily-notes.json':{},'types.json':{types:{}},'workspace.json':workspace}))await fs.writeFile(path.join(cfg,file),JSON.stringify(value));
 const env={...process.env,OBSEN_STARTUP_FIXTURE:dir,OBSEN_STARTUP_PORT:String(port),OBSEN_REFERENCE_FIXTURE:dir,OBSEN_REFERENCE_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[path.resolve(script)],{env,windowsHide:true,stdio:['ignore','ignore','ignore']});let c;
 try{const end=Date.now()+30000;while(Date.now()<end){if(child.exitCode!==null)throw Error(name+' fixture exited');try{c=await fixtureClient(port,prefix,{waitForApp:true});break;}catch{await delay(150);}}if(!c)throw Error(name+' fixture timeout');await c.wait('!!app.workspace.layoutReady','ready');
  report[name]=await c.evaluate(`(()=>{const describe=o=>{const p=Object.getPrototypeOf(o);return{own:Object.keys(o).sort(),methods:Object.getOwnPropertyNames(p).filter(k=>k!=='constructor'&&typeof o[k]==='function').sort()}};return{app:describe(app),vault:{...describe(app.vault),staticMethods:Object.getOwnPropertyNames(app.vault.constructor).filter(k=>k!=='length'&&k!=='name'&&k!=='prototype'&&typeof app.vault.constructor[k]==='function').sort()},vaultProperties:{configDir:app.vault.configDir,adapter:typeof app.vault.adapter,getName:app.vault.getName()}}})()`);report[name].errors=c.errors;
 }finally{c?.socket.close();child.kill();}
}
const compare=(k)=>({reference:report.reference[k].methods,obsen:report.obsen[k].methods});
report.methodComparisons={app:compare('app'),vault:compare('vault')};
const declared={app:{properties:['keymap','scope','workspace','vault','metadataCache','fileManager','lastEvent','renderContext','secretStorage'],methods:['isDarkMode','loadLocalStorage','saveLocalStorage']},vault:{properties:['adapter','configDir'],methods:['getName','getFileByPath','getFolderByPath','getAbstractFileByPath','getRoot','create','createBinary','createFolder','read','cachedRead','readBinary','getResourcePath','delete','trash','rename','modify','modifyBinary','append','appendBinary','process','copy','getAllLoadedFiles','getAllFolders','getMarkdownFiles','getFiles','on'],staticMethods:['recurseChildren']}};
report.declarationCoverage={};for(const area of ['app','vault']){const d=declared[area];report.declarationCoverage[area]={properties:d.properties.map(name=>({name,reference:report.reference[area].own.includes(name),obsen:report.obsen[area].own.includes(name)})),methods:d.methods.map(name=>({name,reference:report.reference[area].methods.includes(name),obsen:report.obsen[area].methods.includes(name)}))};if(d.staticMethods)report.declarationCoverage[area].staticMethods=d.staticMethods.map(name=>({name,reference:report.reference[area].staticMethods.includes(name),obsen:report.obsen[area].staticMethods.includes(name)}));}
const compact={scope:'pinned App and Vault declarations only',declarationCoverage:report.declarationCoverage,referenceErrors:report.reference.errors,obsenErrors:report.obsen.errors};
await fs.mkdir('dist/todo-backup/plugin-api-inventory',{recursive:true});await fs.writeFile('dist/todo-backup/plugin-api-inventory/app-vault.json',JSON.stringify(compact,null,2));console.log(JSON.stringify(compact,null,2));
