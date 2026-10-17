import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const clients = await Promise.all([
  ['reference', Number(process.env.OBSEN_REFERENCE_PORT ?? 9457), 'obsen-reference-audit-'],
  ['obsen', Number(process.env.OBSEN_SMOKE_PORT ?? 9447), 'obsen-electron-smoke-'],
].map(async ([name, port, prefix]) => [name, await fixtureClient(port, prefix, { waitForApp: true, separateHistoricalErrors: true, allowPopoutPages: true })]));
const report = {};
try {
  for (const [name, c] of clients) {
    report[name] = await c.evaluate(`(async()=>{
      const old=window.__popoutPromptAudit;if(old){old.win.document.querySelector('.modal-container')?.querySelector('.modal-header-button')?.click();old.leaf.detach();if(!old.win.closed)old.win.close();}
      const a=window.app??window.__obsenSmokeApp??(typeof app!=='undefined'?app:null),path='Popout prompt audit.md';
      let file=a.vault.getFileByPath(path);if(file)await a.vault.modify(file,'Prompt fixture.\\n');else file=await a.vault.create(path,'Prompt fixture.\\n');
      const mainLeaf=a.workspace.getLeaf('tab');await mainLeaf.openFile(file);
      const leaf=await a.workspace.openPopoutLeaf({size:{width:1024,height:800},x:-30000,y:-30000});
      const win=leaf.getContainer().win;window.__popoutPromptAudit={leaf,win};await leaf.openFile(file);
      if(Array.isArray(a.workspace.recentFiles))a.workspace.recentFiles.splice(0,a.workspace.recentFiles.length,path);else if(a.workspace.recentFileTracker)a.workspace.recentFileTracker.lastOpenFiles=[path];
      win.resizeTo(1024,800);win.dispatchEvent(new win.Event('focus'));a.workspace.setActiveLeaf(leaf);
      return {activeDocumentIsPopout:activeDocument===win.document,window:{innerWidth:win.innerWidth,innerHeight:win.innerHeight,outerWidth:win.outerWidth,outerHeight:win.outerHeight}};
    })()`);
    assert.equal(report[name].activeDocumentIsPopout, true, `${name} focused popout should own activeDocument`);
    report[name].commandResult = await c.evaluate(`(window.app??window.__obsenSmokeApp??(typeof app!=='undefined'?app:null)).commands.executeCommandById('switcher:open')`);
    await c.evaluate(`(window.app??window.__obsenSmokeApp??(typeof app!=='undefined'?app:null)).commands.executeCommandById('switcher:open')`);
    await delay(500);
    report[name].prompt = await c.evaluate(`(()=>{const s=window.__popoutPromptAudit,doc=s.win.document,container=doc.querySelector('.modal-container'),modal=container?.querySelector('.prompt'),input=container?.querySelector('input'),r=modal?.getBoundingClientRect(),v=doc.documentElement;return{promptInPopout:!!container,promptCount:doc.querySelectorAll('.modal-container').length,promptInMain:!!document.querySelector('.modal-container'),sameOwnerDocument:container?.ownerDocument===doc,modalRect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,viewport:{width:v.clientWidth,height:v.clientHeight},inputRect:input?(()=>{const b=input.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}})():null,selectedText:container?.querySelector('.suggestion-item.is-selected')?.textContent?.trim()??null}})()`);
    report[name].errors = c.errors;
    report[name].closedPrompt = await c.evaluate(`(()=>{const s=window.__popoutPromptAudit;if(!s)return false;const doc=s.win.document;doc.dispatchEvent(new s.win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));doc.querySelector('.modal-container .modal-header-button')?.click();const closed=!doc.querySelector('.modal-container');s.leaf.detach();if(!s.win.closed)s.win.close();delete window.__popoutPromptAudit;return closed})()`);
    console.log(name, 'closed popout prompt:', report[name].closedPrompt);
    await c.wait(`activeDocument===document`, `${name} main document restored after popout close`);
    report[name].mainCommandResult = await c.evaluate(`(window.app??window.__obsenSmokeApp??(typeof app!=='undefined'?app:null)).commands.executeCommandById('switcher:open')`);
    await c.wait(`!!document.querySelector('.prompt input')`, `${name} main prompt after closing popout`);
    report[name].mainPromptCount = await c.evaluate(`document.querySelectorAll('.modal-container').length`);
    assert.equal(report[name].mainPromptCount, 1, `${name} should reopen one main prompt after closing the popout`);
    await c.key('Escape');
    await c.wait(`!document.querySelector('.prompt')`, `${name} dismiss main prompt`);
    await delay(100);
  }
  await fs.mkdir('dist/todo-backup/luna-popout-prompt', { recursive: true });
  await fs.writeFile('dist/todo-backup/luna-popout-prompt/report.json', JSON.stringify(report, null, 2));
  assert.deepEqual(report.obsen.prompt, report.reference.prompt);
  assert.deepEqual(report.obsen.errors, []);
  assert.deepEqual(report.reference.errors, []);
  console.log('Paired hidden popout prompt owner-document and geometry check passed.');
} finally { for (const [, c] of clients) c.socket.close(); }
