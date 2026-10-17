// Reading-mode outline behavior in the isolated, hidden comparison vaults.
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';
const output='dist/todo-backup/outline-scroll-comparison';
await fs.mkdir(output,{recursive:true});
const report={};
const text=Array.from({length:8},(_,i)=>`# Section ${i+1}\n\n${Array.from({length:12},(_,j)=>`Paragraph ${j+1} in section ${i+1}. This content makes the reading view scroll.`).join('\n\n')}\n\n`).join('');
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
 const c=await fixtureClient(port,prefix),ev=c.evaluate;
 try{
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await ev(`(async()=>{const p='Outline scroll audit.md',text=${JSON.stringify(text)};let f=app.vault.getFileByPath(p);if(f)await app.vault.modify(f,text);else f=await app.vault.create(p,text);const l=app.workspace.getLeaf(false);await l.openFile(f);await l.setViewState({type:'markdown',state:{file:p,mode:'preview'}});app.workspace.setActiveLeaf(l);app.workspace.rightSplit.expand();await app.workspace.revealLeaf(app.workspace.getLeavesOfType('outline')[0]);})()`);
  await c.wait(`document.querySelectorAll('.markdown-reading-view .el-h1').length>=1 && document.querySelectorAll('.workspace-leaf-content[data-type=outline] .tree-item-inner').length===8`,'long reading note mounted');
  await delay(700);
  const steps=[];
  for(const fraction of [0,0.15,0.3,0.6,0.85,0.15,0]){
   await ev(`(()=>{const v=app.workspace.getMostRecentLeaf().view,e=v.containerEl.querySelector('.markdown-reading-view .markdown-preview-view');e.scrollTop=(e.scrollHeight-e.clientHeight)*${fraction};})()`);
   await delay(300);
   steps.push({fraction,active:await ev(`document.querySelector('.workspace-leaf-content[data-type=outline] .tree-item-self.is-active .tree-item-inner')?.textContent??null`),scroll:await ev(`app.workspace.getMostRecentLeaf().view.scroll??null`)});
  }
  for(const pixel of [600,610,626,628,650]){
   await ev(`(()=>{const e=app.workspace.getMostRecentLeaf().view.containerEl.querySelector('.markdown-reading-view .markdown-preview-view');e.scrollTop=${pixel};})()`);
   await delay(250);
   steps.push({pixel,active:await ev(`document.querySelector('.workspace-leaf-content[data-type=outline] .tree-item-self.is-active .tree-item-inner')?.textContent??null`)});
  }
  await c.capture(output,`${name}-outline-reading`,'.workspace-leaf-content[data-type=outline]');
  await ev(`(async()=>{const l=app.workspace.getMostRecentLeaf();await l.setViewState({type:'markdown',state:{file:'Outline scroll audit.md',mode:'source'}});l.view.editor.setCursor({line:54,ch:0});l.view.editor.focus();})()`);
  await delay(400);
  steps.push({mode:'source',line:54,active:await ev(`document.querySelector('.workspace-leaf-content[data-type=outline] .tree-item-self.is-active .tree-item-inner')?.textContent??null`)});
  await ev(`(async()=>{const l=app.workspace.getMostRecentLeaf();await l.setViewState({type:'markdown',state:{file:'Outline scroll audit.md',mode:'preview'}});})()`);
  // The reference computes its virtual sections asynchronously after a mode switch.
  await delay(1200);
  await ev(`(()=>{const e=app.workspace.getMostRecentLeaf().view.containerEl.querySelector('.markdown-reading-view .markdown-preview-view');e.scrollTop=2199;})()`);
  await delay(300);
  await ev(`(()=>{const e=app.workspace.getMostRecentLeaf().view.containerEl.querySelector('.markdown-reading-view .markdown-preview-view');e.scrollTop=2200;})()`);
  await delay(300);
  steps.push({mode:'preview-after-source',active:await ev(`document.querySelector('.workspace-leaf-content[data-type=outline] .tree-item-self.is-active .tree-item-inner')?.textContent??null`)});
  await ev(`(async()=>{await app.vault.modify(app.vault.getFileByPath('Outline scroll audit.md'),${JSON.stringify('An introductory paragraph before the first heading.\n\n'+text)});})()`);
  await c.wait(`app.metadataCache.getCache('Outline scroll audit.md')?.headings?.[0]?.position.start.line===2`,'intro indexed');
  await delay(700);
  for(const pixel of [650,0]){await ev(`(()=>{const e=app.workspace.getMostRecentLeaf().view.containerEl.querySelector('.markdown-reading-view .markdown-preview-view');e.scrollTop=${pixel};})()`);await delay(300);}
  steps.push({mode:'preview-intro-at-top',active:await ev(`document.querySelector('.workspace-leaf-content[data-type=outline] .tree-item-self.is-active .tree-item-inner')?.textContent??null`)});
  report[name]={steps,errors:c.errors};
 }finally{c.socket.close();}
}
report.differences=report.reference.steps.flatMap((s,i)=>s.active===report.obsen.steps[i].active?[]:[{reference:s,obsen:report.obsen.steps[i]}]);
await fs.writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({steps:report.reference.steps.length,differences:report.differences,errors:{reference:report.reference.errors,obsen:report.obsen.errors}},null,2));
if(report.differences.length||Object.values(report).some(x=>x?.errors?.length))process.exitCode=1;
