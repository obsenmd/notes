import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient} from './fixture-client.mjs';
const directory='Root API audit '+Date.now(),report={},output='dist/todo-backup/vault-root-comparison';await fs.mkdir(output,{recursive:true});
for(const [name,port,prefix]of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true});
 try{
  await c.evaluate(`(async()=>{window.__rootAuditFolder=await app.vault.createFolder(${JSON.stringify(directory)});window.__rootAuditChild=await app.vault.create(${JSON.stringify(directory+'/Child.md')},'Root API child.');})()`);
  report[name]=await c.evaluate(`(async()=>{
   const root=app.vault.getRoot(), folder=window.__rootAuditFolder;
   const paths=['','/','//','./','/./',${JSON.stringify(directory)},${JSON.stringify(directory+'/')},${JSON.stringify('./'+directory)},${JSON.stringify('/'+directory)}];
   const lookups=paths.map(path=>({path,result:app.vault.getAbstractFileByPath(path)?.path??null}));
   const list=async(path)=>{try{return {ok:true,...await app.vault.adapter.list(path)}}catch(error){return {ok:false}}};
   const note=await app.fileManager.createNewMarkdownFile(root,${JSON.stringify(directory+' note')},'Root API note.');window.__rootAuditNote=note;
   const rootData={path:root.path,name:root.name,parent:root.parent,isRoot:root.isRoot(),parentIsRoot:note.parent===root,includesRoot:app.vault.getAllFolders(true).includes(root),excludesRoot:!app.vault.getAllFolders(false).includes(root)};
   const settle=()=>new Promise(resolve=>setTimeout(resolve,250));await settle();
   const notePath=note.path;await app.vault.rename(note,${JSON.stringify(directory+'/Moved.md')});const movedParent=note.parent===folder;await settle();
   await app.vault.rename(note,${JSON.stringify(directory+' moved.md')});const returnedParent=note.parent===root;await settle();
   await app.vault.modify(note,'Changed root note.');const text=await app.vault.read(note);
   const folderListing=await list(${JSON.stringify(directory)}),rootSlash=await list('/');
   return {root:rootData,lookups,notePath,movedParent,returnedParent,text,folderListing,rootSlashWorks:rootSlash.ok};
  })()`);
  assert.deepEqual(c.errors,[]);
 }finally{await c.evaluate(`(async()=>{if(window.__rootAuditNote&&app.vault.getFileByPath(window.__rootAuditNote.path))await app.vault.delete(window.__rootAuditNote);if(window.__rootAuditFolder&&app.vault.getFolderByPath(window.__rootAuditFolder.path))await app.vault.delete(window.__rootAuditFolder,true);})()`).catch(()=>{});c.socket.close();}
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(report.obsen,report.reference);console.log('Vault root audit passed.');
