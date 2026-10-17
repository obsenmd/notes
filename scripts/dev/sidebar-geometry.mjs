import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';
const reports={};
for (const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]) {
  const c=await fixtureClient(port,prefix);
  const results=reports[name]={};
  try {
    await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    for(const [type,state] of [['file-explorer',null],['search',{query:'needle'}],['backlink',{file:'Projects/Alpha.md',backlinkCollapsed:false,unlinkedCollapsed:false,showSearch:false,searchQuery:''}],['tag',null]]) {
      await c.evaluate(`(async()=>{const leaf=app.workspace.getLeavesOfType(${JSON.stringify(type)})[0];${state?`await leaf.setViewState({type:${JSON.stringify(type)},state:{...leaf.view.getState(),...${JSON.stringify(state)}}});`:''}await app.workspace.revealLeaf(leaf)})()`);
      await delay(800);
      results[type]=await c.evaluate(`(() => {
        const root=document.querySelector('.workspace-leaf-content[data-type=${type}]');
        const out=[];
        function walk(e,path){if(e.tagName==='svg'||!e.offsetParent)return;const r=e.getBoundingClientRect(),s=getComputedStyle(e);out.push({path,tag:e.tagName,cls:e.className,rect:[r.x,r.y,r.width,r.height],text:e.children.length?'':e.textContent,style:Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','padding','border','transform','opacity','willChange'].map(k=>[k,s[k]]))});[...e.children].forEach((child,i)=>walk(child,path+'/'+i))}walk(root,'');return out;
      })()`);
    }
  }finally{c.socket.close()}
}
const differences=[];
for(const type of Object.keys(reports.reference)){
  const a=new Map(reports.reference[type].map(e=>[e.path,e])),b=new Map(reports.obsen[type].map(e=>[e.path,e]));
  for(const key of new Set([...a.keys(),...b.keys()]))if(JSON.stringify(a.get(key))!==JSON.stringify(b.get(key)))differences.push({type,reference:a.get(key),obsen:b.get(key)});
}
await fs.writeFile('dist/todo-backup/sidebar-geometry.json',JSON.stringify({reports,differences},null,2));
console.log(JSON.stringify(differences.slice(0,15),null,2));
console.log(`${differences.length} geometry/style differences`);
