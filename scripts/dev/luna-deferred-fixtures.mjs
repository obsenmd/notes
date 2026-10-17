import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), root=process.cwd(),stamp='20261014-'+Date.now();
const specs=[
 {name:'reference',prefix:'obsen-reference-audit-luna-deferred-',port:9476,script:'scripts/dev/reference-fixture.cjs'},
 {name:'obsen',prefix:'obsen-electron-smoke-luna-deferred-',port:9586,script:'scripts/dev/startup-fixture.cjs'},
];
for(const x of specs){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),x.prefix+stamp+'-')),vault=path.join(dir,'vault'),cfg=path.join(vault,'.obsidian');
 await fs.mkdir(path.join(dir,'profile'),{recursive:true}); await fs.mkdir(cfg,{recursive:true});
 await fs.writeFile(path.join(vault,'Source.md'),'# Active source\n\nActive leaf.\n');
 await fs.writeFile(path.join(vault,'Background.md'),'# Background source\n\nInactive leaf.\n');
 await fs.writeFile(path.join(cfg,'community-plugins.json'),'[]');
 await fs.writeFile(path.join(cfg,'core-plugins.json'),'{}');
 await fs.writeFile(path.join(cfg,'workspace.json'),JSON.stringify({main:{id:'deferred-root',type:'split',direction:'vertical',children:[{id:'deferred-tabs',type:'tabs',children:[{id:'active-leaf',type:'leaf',state:{type:'markdown',state:{file:'Source.md',mode:'source',source:true}}},{id:'inactive-leaf',type:'leaf',state:{type:'markdown',state:{file:'Background.md',mode:'source',source:true}}}]}]},active:'active-leaf',lastOpenFiles:[]}));
 const env={...process.env, ...(x.name==='reference'?{OBSEN_REFERENCE_FIXTURE:dir,OBSEN_REFERENCE_PORT:String(x.port)}:{OBSEN_STARTUP_FIXTURE:dir,OBSEN_STARTUP_PORT:String(x.port),OBSEN_DIST:path.resolve('dist/luna-services')})}; delete env.ELECTRON_RUN_AS_NODE;
 if(x.name==='obsen') env.ELECTRON_OVERRIDE_DIST_PATH=path.join(os.tmpdir(),'obsen-followups-electron');
 const log=await fs.open(path.join(dir,'fixture.log'),'a'); const child=spawn(require('electron'),[path.resolve(x.script)],{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]}); child.unref(); await log.close();
 const manifest={directory:dir,pid:child.pid,port:x.port,archive:x.name==='obsen'?path.resolve('dist/luna-services/app.asar'):undefined};
 await fs.writeFile(path.join(root,'dist/todo-backup',`luna-deferred-${x.name}-${x.port}.json`),JSON.stringify(manifest,null,2));
 console.log(x.name,child.pid,dir);
}
