import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const report={};
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true});
 try{
  await c.evaluate(`(async()=>{window.__containerProbe={previous:app.workspace.activeLeaf,leaves:[]};for(const type of ['file-explorer','search','bookmarks','backlink','outgoing-link','tag','outline','all-properties','file-properties']){const l=app.workspace.getRightLeaf(true);window.__containerProbe.leaves.push(l);await l.setViewState({type});}app.workspace.rightSplit.expand();})()`);
  await delay(350);
  report[name]=await c.evaluate(`(()=>{return window.__containerProbe.leaves.map(l=>{const v=l.view;return {type:v.getViewType(),leafClass:l.containerEl.className,viewClass:v.containerEl.className,contentClass:v.contentEl?.className??null,leafConnected:l.containerEl.isConnected,viewConnected:v.containerEl.isConnected,contentConnected:v.contentEl?.isConnected??null,viewParentIsLeaf:v.containerEl.parentElement===l.containerEl,contentParentIsView:v.contentEl?.parentElement===v.containerEl,leafIsView:l.containerEl===v.containerEl,viewIsContent:v.containerEl===v.contentEl};});})()`);
 }finally{await c.evaluate(`(()=>{const s=window.__containerProbe;for(const l of s.leaves)l.detach();if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__containerProbe;})()`);c.socket.close();}
}
await fs.writeFile('dist/todo-backup/sidebar-container-probe.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
