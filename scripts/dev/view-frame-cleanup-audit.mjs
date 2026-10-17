import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixtureClient,delay} from './fixture-client.mjs';
const c=await fixtureClient(9342,'obsen-electron-smoke-',{separateHistoricalErrors:true}),ev=c.evaluate,steps=[];
try{
 await ev(`(()=>{window.__frameCleanup={previous:app.workspace.activeLeaf,closed:0};let p=Object.getPrototypeOf(app.workspace.getMostRecentLeaf().view);while(!Object.hasOwn(p,'addAction'))p=Object.getPrototypeOf(p);const ItemView=p.constructor;app.workspace.registerView('frame-cleanup-probe',leaf=>new class extends ItemView{getViewType(){return 'frame-cleanup-probe';}getDisplayText(){return 'Fixture';}onOpen(){this.contentEl.textContent='fixture content';}onClose(){window.__frameCleanup.closed++;this.containerEl.replaceChildren();}}(leaf));window.__frameCleanup.leaf=app.workspace.getLeaf('tab');})()`);
 for(const [from,to]of [['unavailable-frame-probe','empty'],['frame-cleanup-probe','empty'],['frame-cleanup-probe','graph'],['unavailable-frame-probe','graph'],['frame-cleanup-probe','backlink']]){
  await ev(`window.__frameCleanup.leaf.setViewState({type:${JSON.stringify(from)},active:true})`);await delay(200);
  await ev(`window.__frameCleanup.leaf.setViewState({type:${JSON.stringify(to)},active:true})`);await delay(200);
  steps.push({from,to,...await ev(`(()=>{const l=window.__frameCleanup.leaf;return{type:l.view.getViewType(),rootConnected:l.containerEl.isConnected,frameConnected:l.view.containerEl.isConnected,workspaceMounted:!!document.querySelector('.workspace'),settingsCommandRegistered:!!app.commands.commands.get('app:open-settings')};})()`)});
 }
 await ev(`window.__frameCleanup.leaf.setViewState({type:'frame-cleanup-probe',active:true})`);await delay(200);await ev(`window.__frameCleanup.leaf.detach()`);await delay(200);
 const closed=await ev(`window.__frameCleanup.closed`);
 // CDP normally bypasses CSP for debugger evaluations; disable that exemption.
 const probe=await c.send('Runtime.evaluate',{expression:`(()=>{const csp=document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content??'';let evalBlocked=false;try{new Function('return 1')();}catch(error){evalBlocked=error instanceof EvalError;}return{hasCsp:!!csp,hasUnsafeEval:csp.split(/\\s+/).includes("'unsafe-eval'"),evalBlocked};})()`,allowUnsafeEvalBlockedByCSP:false,returnByValue:true});
 const security=probe.result.value;
 const consoleMessages=[];
 const listen=event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.consoleAPICalled')consoleMessages.push(m.params.args.map(a=>a.value??a.description??'').join(' '));};
 c.socket.addEventListener('message',listen);await c.send('Runtime.disable');await c.send('Runtime.enable');await delay(100);c.socket.removeEventListener('message',listen);
 const reportedWarnings=consoleMessages.filter(message=>/Download the React DevTools|Insecure Content-Security-Policy/.test(message));
 const report={steps,closed,security,reportedWarnings,errors:c.errors};await fs.mkdir('dist/todo-backup/view-frame-cleanup',{recursive:true});await fs.writeFile('dist/todo-backup/view-frame-cleanup/report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));assert.deepEqual(c.errors,[]);assert.deepEqual(reportedWarnings,[]);assert.equal(closed,4);assert.equal(steps.length,5);for(const s of steps){assert.equal(s.type,s.to);assert.equal(s.rootConnected,true);assert.equal(s.frameConnected,true);assert.equal(s.workspaceMounted,true);assert.equal(s.settingsCommandRegistered,true);}assert.deepEqual(security,{hasCsp:true,hasUnsafeEval:false,evalBlocked:true});
}finally{await ev(`(()=>{const s=window.__frameCleanup;if(!s)return;if(s.leaf?.parent)s.leaf.detach();app.workspace.unregisterView('frame-cleanup-probe');if(s.previous?.parent)app.workspace.setActiveLeaf(s.previous);delete window.__frameCleanup;})()`).catch(()=>{});c.socket.close();}
