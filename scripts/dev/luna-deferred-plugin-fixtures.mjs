import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=process.cwd(),stamp='20261014-'+Date.now();
for(const x of [{name:'reference',prefix:'obsen-reference-audit-luna-deferred-plugin-',port:9686,script:'scripts/dev/reference-fixture.cjs'},{name:'obsen',prefix:'obsen-electron-smoke-luna-deferred-plugin-',port:9786,script:'scripts/dev/startup-fixture.cjs'}]){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),x.prefix+stamp+'-')),vault=path.join(dir,'vault'),cfg=path.join(vault,'.obsidian'),plugin=path.join(cfg,'plugins','luna-deferred');
 await fs.mkdir(path.join(dir,'profile'),{recursive:true});await fs.mkdir(plugin,{recursive:true});
 await fs.writeFile(path.join(vault,'Source.md'),'# Active source\nActive leaf.\n');await fs.writeFile(path.join(vault,'Background.md'),'# Background source\nInactive leaf.\n');
 await fs.writeFile(path.join(cfg,'community-plugins.json'),'["luna-deferred"]');await fs.writeFile(path.join(cfg,'core-plugins.json'),'{}');
 await fs.writeFile(path.join(plugin,'manifest.json'),JSON.stringify({id:'luna-deferred',name:'Luna Deferred Probe',version:'1.0.0',minAppVersion:'1.0.0',author:'Luna test fixture',description:'Temporary lifecycle probe'}));
 await fs.writeFile(path.join(plugin,'main.js'),`const {Plugin,ItemView}=require('obsidian');module.exports=class extends Plugin{onload(){const plugin=this;this.registerView('luna-deferred-probe',leaf=>new class extends ItemView{getViewType(){return 'luna-deferred-probe'}getDisplayText(){return 'Deferred Probe'}async onOpen(){window.__lunaDeferredEvents=(window.__lunaDeferredEvents||[]).concat('open');}async onClose(){window.__lunaDeferredEvents=(window.__lunaDeferredEvents||[]).concat('close');}getState(){return {marker:'saved'};}async setState(state){this.marker=state.marker;window.__lunaDeferredEvents=(window.__lunaDeferredEvents||[]).concat('set:'+state.marker);}}(leaf));}};`);
 await fs.writeFile(path.join(cfg,'workspace.json'),JSON.stringify({main:{id:'deferred-root',type:'split',direction:'vertical',children:[{id:'deferred-tabs',type:'tabs',children:[{id:'active-leaf',type:'leaf',state:{type:'markdown',state:{file:'Source.md',mode:'source',source:true}}},{id:'inactive-leaf',type:'leaf',state:{type:'luna-deferred-probe',state:{marker:'saved'}}}]}]},active:'active-leaf',lastOpenFiles:[]}));
 const env={...process.env,...(x.name==='reference'?{OBSEN_REFERENCE_FIXTURE:dir,OBSEN_REFERENCE_PORT:String(x.port)}:{OBSEN_STARTUP_FIXTURE:dir,OBSEN_STARTUP_PORT:String(x.port),OBSEN_DIST:path.resolve('dist/luna-services'),ELECTRON_OVERRIDE_DIST_PATH:path.join(os.tmpdir(),'obsen-followups-electron')})};delete env.ELECTRON_RUN_AS_NODE;
 const log=await fs.open(path.join(dir,'fixture.log'),'a'),child=spawn(require('electron'),[path.resolve(x.script)],{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
 const m={directory:dir,pid:child.pid,port:x.port,archive:x.name==='obsen'?path.resolve('dist/luna-services/app.asar'):undefined};await fs.writeFile(path.join(root,'dist/todo-backup',`luna-deferred-${x.name}-${x.port}.json`),JSON.stringify(m,null,2));console.log(x.name,child.pid,dir);
}
