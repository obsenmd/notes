// Compare core plugin behavior in the two running offscreen fixture vaults.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const output = process.argv[2] ?? 'dist/todo-backup/core-comparison';
await fs.mkdir(output, { recursive: true });
const clients = [['reference', await fixtureClient(9351, 'obsen-reference-audit-')], ['obsen', await fixtureClient(9341, 'obsen-electron-smoke-')]];
const ids = ['slides', 'audio-recorder', 'workspaces', 'zk-prefixer', 'random-note', 'slash-command', 'footnotes'];
const samples = {
  'Core audit.md': '# First slide\n\nA **bold** sentence.\n\n---\n\n# Second slide\n\n- One\n- Two\n',
  'Footnote audit.md': '# Footnotes\n\nSecond[^b], then first[^a].\n\n[^a]: Alpha **bold**.\n[^b]: Beta paragraph.\n\n    Continued paragraph.\n[^unused]: Unreferenced.\n',
  'Core template.md': '# {{title}}\n\n{{date:YYYY}}\n',
};
const report = {};
try {
  for (const [name, c] of clients) {
    console.log(`Preparing ${name} core fixture`);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.key('Escape');
    await c.evaluate(`(async () => {
      const ids=${JSON.stringify(ids)};
      if (app.internalPlugins) for (const id of ids) await app.internalPlugins.plugins[id].enable(false);
      else {
        let data={}; try { data=JSON.parse(await app.vault.adapter.read('.obsidian/core-plugins.json')); } catch {}
        for (const id of ids) data[id]=true;
        await app.vault.adapter.write('.obsidian/core-plugins.json',JSON.stringify(data));
      }
      for (const [p,text] of Object.entries(${JSON.stringify(samples)})) {
        const f=app.vault.getFileByPath(p); if (f) await app.vault.modify(f,text); else await app.vault.create(p,text);
      }
    })()`);
    if (name === 'obsen') {
      await c.send('Page.reload');
      await c.wait(`!!window.__obsenSmokeApp?.commands.findCommand('footnotes:open')`, 'core plugins enabled after reload');
    }
    // A compositor capture activates frames without showing or focusing a native window.
    await c.send('Page.captureScreenshot', { format: 'png' });
    await c.evaluate(`(async () => { for (const leaf of app.workspace.getLeavesOfType('footnotes')) leaf.detach(); await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Core audit.md')); })()`);
    await c.wait(`!!document.querySelector('.cm-content')?.textContent.includes('First slide')`, 'main editor mounted');
    await delay(150);
    report[name] = {};
    const capture = async (scenario, selector) => { report[name][scenario] = await c.capture(output, `${name}-${scenario}`, selector); };

    // Manage, save, mutate and restore the real persisted workspace layout.
    await c.evaluate(`app.commands.executeCommandById('workspaces:open-modal')`);
    await c.wait(`!!document.querySelector('.mod-manage-workspaces')`, 'workspace manager');
    await c.evaluate(`(() => { for (const row of document.querySelectorAll('.mod-manage-workspaces .list-item')) if (row.querySelector('span')?.textContent==='Audit layout') row.querySelector('.clickable-icon').click(); })()`);
    await c.wait(`!document.querySelector('.mod-manage-workspaces')?.textContent.includes('Audit layout')`, 'old fixture layout deleted');
    await capture('workspaces-empty', '.modal');
    await c.evaluate(`(() => { const input=document.querySelector('.modal-content .list-item input'); input.value='Audit layout'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.modal-content .list-item button').click(); })()`);
    await c.wait(`document.querySelector('.mod-manage-workspaces')?.textContent.includes('Audit layout')`, 'saved layout row');
    await capture('workspaces-saved', '.modal');
    await c.key('Escape');
    await c.evaluate(`(async () => { await app.workspace.activeLeaf.openFile(app.vault.getFileByPath('Footnote audit.md')); app.commands.executeCommandById('workspaces:load'); })()`);
    await c.wait(`!!document.querySelector('.prompt-input')`, 'workspace load prompt');
    await capture('workspaces-load', '.prompt');
    await c.click('.suggestion-item');
    await c.wait(`app.workspace.getActiveFile()?.path==='Core audit.md'`, 'workspace layout restores file');
    const saved = await c.evaluate(`JSON.parse(await app.vault.adapter.read('.obsidian/workspaces.json'))`);
    assert.equal(saved.active, 'Audit layout');
    assert.ok(saved.workspaces['Audit layout'].mtime);
    await c.evaluate(`document.querySelector('.notice-container')?.replaceChildren()`);

    // Slide DOM, next/previous navigation and Escape lifecycle.
    await c.evaluate(`app.commands.executeCommandById('slides:start')`);
    await c.wait(`document.querySelectorAll('.slides-container section').length===2 && !!document.querySelector('.slides-container .reveal.ready')`, 'slides ready');
    await delay(1200);
    await capture('slides-first', '.slides-container');
    await c.click('.slides-container section.present');
    await c.key('ArrowRight');
    await c.wait(`document.querySelector('.slides-container section:nth-child(2)')?.classList.contains('present')`, 'next slide');
    await delay(900);
    await capture('slides-second', '.slides-container');
    await c.key('ArrowLeft');
    await c.wait(`document.querySelector('.slides-container section:first-child')?.classList.contains('present')`, 'previous slide');
    await c.key('Escape');
    await c.wait(`!document.querySelector('.slides-container')`, 'presentation closes');

    // The footnotes pane follows the active file and writes edits back to its note.
    await c.evaluate(`(async () => { await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Footnote audit.md')); app.commands.executeCommandById('footnotes:open'); })()`);
    await c.wait(`document.querySelectorAll('.footnote-list-item').length===3`, 'footnotes loaded');
    await capture('footnotes', '.footnotes-view');
    await c.click('.footnote-list-item .footnote-content');
    await c.wait(`!!document.querySelector('.footnote-list-item.is-editing .cm-content')`, 'footnote editor');
    await delay(250);
    await c.evaluate(`(() => { const e=document.querySelector('.footnote-list-item.is-editing .cm-content'); e.focus(); })()`);
    await c.evaluate(`(() => { const v=app.workspace.getLeavesOfType('footnotes')[0].view; const e=v.cache ? v.cache.get('b').embed.editMode.editor : v.items.get('b').editing.editor; e.setCursor(e.offsetToPos(e.getValue().length)); e.focus(); })()`);
    await capture('footnote-editor', '.footnotes-view');
    await c.send('Input.insertText', { text: ' Edited.' });
    await c.key('Escape');
    await c.wait(`!document.querySelector('.footnote-list-item.is-editing')`, 'footnote edit ends');
    await c.wait(`(await app.vault.adapter.read('Footnote audit.md')).includes('Edited.')`, 'footnote saved to disk');
    const text=await c.evaluate(`await app.vault.adapter.read('Footnote audit.md')`);
    assert.ok(text.includes('[^a]: Alpha **bold**.'));
    assert.ok(text.includes('[^unused]: Unreferenced.'));
    report[name].footnoteText=text;
    console.log(`${name}: workspace, slides and footnotes passed`);

    // Unique names, collision increments, template expansion and selected links.
    const year=new Date().getFullYear();
    await c.evaluate(`(async()=>{
      if (!app.vault.getFolderByPath('Unique audit')) await app.vault.createFolder('Unique audit');
      for (const y of [${year},${year+1}]) { const f=app.vault.getFileByPath('Unique audit/Audit unique '+y+'.md'); if (f) await app.vault.delete(f); }
      const options={folder:'Unique audit',template:'Core template',format:'[Audit unique ]YYYY'};
      await app.vault.adapter.write('.obsidian/zk-prefixer.json',JSON.stringify(options));
      if (app.internalPlugins) app.internalPlugins.plugins['zk-prefixer'].instance.options=options;
      app.commands.executeCommandById('zk-prefixer');
    })()`);
    await c.wait(`app.workspace.getActiveFile()?.path==='Unique audit/Audit unique ${year}.md'`, 'unique note creation');
    assert.equal(await c.evaluate(`await app.vault.adapter.read('Unique audit/Audit unique ${year}.md')`), `# Audit unique ${year}\n\n${year}\n`);
    await c.evaluate(`app.commands.executeCommandById('zk-prefixer')`);
    await c.wait(`app.workspace.getActiveFile()?.path==='Unique audit/Audit unique ${year+1}.md'`, 'unique collision advances year');
    await c.evaluate(`(() => { const e=app.workspace.activeLeaf.view.editor; e.focus(); e.setValue('Selected words'); e.setSelection({line:0,ch:0},{line:0,ch:14}); app.commands.executeCommandById('insert-unique-link'); })()`);
    await c.wait(`app.workspace.activeLeaf.view.editor.getValue()==='[[Audit unique ${year} Selected words]]'`, 'unique selection link');

    // The current note is a candidate, and a normal command reuses its tab.
    const random=await c.evaluate(`(async()=>{
      const files=app.vault.getMarkdownFiles(), leaf=app.workspace.getLeaf(); await leaf.openFile(files[0]);
      const count=app.workspace.getLeavesOfType('markdown').length, original=Math.random;
      try { Math.random=()=>0; app.commands.executeCommandById('random-note'); await new Promise(r=>setTimeout(r,150)); }
      finally { Math.random=original; }
      return {sameFile:app.workspace.getActiveFile()===files[0],sameLeaf:app.workspace.activeLeaf===leaf,count,after:app.workspace.getLeavesOfType('markdown').length};
    })()`);
    assert.equal(random.sameFile,true); assert.equal(random.sameLeaf,true); assert.equal(random.count,random.after);
    report[name].random=random;

    // Slash suggestions must be triggered by typing and remove their trigger on selection.
    await c.evaluate(`(async()=>{await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Core audit.md')); const e=app.workspace.activeLeaf.view.editor; window.__coreAuditEditor=e; e.setValue(''); e.setCursor({line:0,ch:0}); e.focus();})()`);
    await delay(150);
    await c.send('Input.insertText',{text:'/random'});
    await c.wait(`!!document.querySelector('.suggestion-container .suggestion-item')`, 'slash command suggestion');
    await capture('slash-command','.suggestion-container');
    await c.click('.suggestion-container .suggestion-item');
    await c.wait(`!window.__coreAuditEditor.getValue().includes('/random')`, 'slash trigger removed');

    // Record a generated tone through the real MediaRecorder, without microphone access.
    await c.evaluate(`(async()=>{
      await app.workspace.getLeaf().openFile(app.vault.getFileByPath('Core audit.md'));
      window.__coreAuditRecordings=app.vault.getFiles().filter(f=>/^Recording /.test(f.name)).map(f=>f.path);
      const context=new AudioContext(), oscillator=context.createOscillator(), output=context.createMediaStreamDestination();
      oscillator.connect(output); oscillator.start(); await context.resume();
      window.__coreAuditAudio={context,oscillator,original:navigator.mediaDevices.getUserMedia};
      navigator.mediaDevices.getUserMedia=async()=>output.stream;
      app.commands.executeCommandById('audio-recorder:start');
    })()`);
    await c.wait(`!![...document.querySelectorAll('.side-dock-ribbon-action.is-active')].find(e=>e.getAttribute('aria-label')?.includes('recording'))`, 'recording ribbon state');
    await capture('audio-recording','.workspace-ribbon.side-dock-ribbon');
    await delay(600);
    await c.evaluate(`app.commands.executeCommandById('audio-recorder:stop')`);
    await c.wait(`app.vault.getFiles().some(f=>/^Recording /.test(f.name)&&!window.__coreAuditRecordings.includes(f.path))`, 'recording file saved');
    const recording=await c.evaluate(`(async()=>{
      const file=app.vault.getFiles().find(f=>/^Recording /.test(f.name)&&!window.__coreAuditRecordings.includes(f.path));
      const result={extension:file.extension,bytes:(await app.vault.readBinary(file)).byteLength,embedded:app.workspace.activeLeaf.view.editor.getValue().includes(file.basename)};
      navigator.mediaDevices.getUserMedia=window.__coreAuditAudio.original;
      window.__coreAuditAudio.oscillator.stop(); await window.__coreAuditAudio.context.close();
      return result;
    })()`);
    assert.ok(recording.bytes>0); assert.equal(recording.embedded,true);
    report[name].recording=recording;
    assert.deepEqual(c.errors,[],`${name} renderer errors`);
    console.log(`${name}: unique/random notes, slash selection and synthetic recording passed`);
  }
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.reference.footnoteText, report.obsen.footnoteText, 'same footnote edit serialization');
} finally { for (const [, c] of clients) c.socket.close(); }
