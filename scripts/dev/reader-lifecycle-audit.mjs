import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {fixtureClient,delay} from './fixture-client.mjs';
const text='A reader article keeps the original page available while displaying its useful content. This lifecycle example contains sufficient prose and an illustration to test view restoration, plugin changes, and closing a page with a gallery open. '.repeat(8);
const server=http.createServer((request,response)=>{response.setHeader('Content-Type',request.url.endsWith('.svg')?'image/svg+xml':'text/html');response.end(request.url.endsWith('.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#587da8"/></svg>':`<title>Reader lifecycle</title><article><h1>Reader lifecycle</h1><p>${text}</p><p><img src="/image.svg" alt="Lifecycle illustration"></p><p>${text}</p></article>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/article',output='dist/todo-backup/reader-lifecycle-comparison',report={};await fs.mkdir(output,{recursive:true});
try{
for(const [name,port,prefix]of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
  const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true});report[name]={};
  const toggle=async(enabled)=>{
    await c.evaluate(`(()=>{app.vault.setConfig('settingsPopoutWindow',false);app.commands.executeCommandById('app:open-settings');})()`);
    await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=plugins]')`,'core settings');await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=plugins]').click()`);
    await c.evaluate(`(()=>{const row=[...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el=>el.querySelector('.setting-item-name')?.textContent.trim()==='Web viewer');const checkbox=row.querySelector('.checkbox-container');if(checkbox.classList.contains('is-enabled')!==${enabled})checkbox.click();})()`);
    await delay(250);await c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`);
  };
  const open=async()=>{
    await c.evaluate(`(async()=>{window.__readerLifeLeaf=app.workspace.getLeaf('tab');await window.__readerLifeLeaf.setViewState({type:'webviewer',state:{url:${JSON.stringify(url)}},active:true});app.workspace.setActiveLeaf(window.__readerLifeLeaf);})()`);
    await c.wait(`window.__readerLifeLeaf.view.webview?.getURL()===${JSON.stringify(url)}&&!window.__readerLifeLeaf.view.webview.isLoading()`,'page loaded');await c.evaluate(`window.__readerLifeLeaf.view.displayReaderView()`);
    await c.wait(`!!window.__readerLifeLeaf.containerEl.querySelector('.reader-mode-content img')`,'reader illustration');
  };
  const gallery=async()=>{await c.evaluate(`window.__readerLifeLeaf.containerEl.querySelector('.reader-mode-content img').dispatchEvent(new MouseEvent('click',{bubbles:true,button:0}))`);await c.wait(`!!document.querySelector('.lightbox')`,'gallery opened');await delay(300);};
  const dismiss=async()=>{if(await c.evaluate(`!!document.querySelector('.lightbox')`)){await c.evaluate(`document.querySelector('.lightbox').focus()`);await c.key('Escape');await c.wait(`!document.querySelector('.lightbox')`,'gallery dismissed');}};
  try{
    await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await dismiss();await toggle(true);await open();
    await c.evaluate(`window.__readerLifeSaved=JSON.parse(JSON.stringify(window.__readerLifeLeaf.getViewState()))`);
    await c.evaluate(`(async()=>{window.__readerLifeRestored=app.workspace.getLeaf('tab');await window.__readerLifeRestored.setViewState(window.__readerLifeSaved);app.workspace.setActiveLeaf(window.__readerLifeRestored);})()`);
    await c.wait(`window.__readerLifeRestored.view.webview?.getURL()===${JSON.stringify(url)}&&!window.__readerLifeRestored.view.webview.isLoading()`,'restored page');
    report[name].restoration=await c.evaluate(`({savedMode:window.__readerLifeSaved.state.mode,restoredMode:window.__readerLifeRestored.view.mode,title:window.__readerLifeRestored.view.title})`);
    await c.evaluate(`(()=>{window.__readerLifeRestored.detach();app.workspace.setActiveLeaf(window.__readerLifeLeaf);})()`);
    await gallery();await c.evaluate(`window.__readerLifeLeaf.detach()`);await delay(300);
    report[name].closeWithGallery=await c.evaluate(`({galleryRemains:!!document.querySelector('.lightbox'),webviewerLeaves:app.workspace.getLeavesOfType('webviewer').length})`);
    await c.evaluate(`document.querySelector('.lightbox').focus()`);await c.key('=','Equal');await delay(200);
    report[name].galleryAfterOriginClose=await c.evaluate(`({title:document.querySelector('.lightbox-titlebar-text').textContent,transform:document.querySelector('.lightbox img').style.transform,zoomed:document.querySelector('.lightbox').classList.contains('is-zoomed')})`);await dismiss();
    await open();await gallery();await toggle(false);
    report[name].disabled=await c.evaluate(`({type:window.__readerLifeLeaf.view.getViewType(),leaves:app.workspace.getLeavesOfType('webviewer').length,guestPresent:!!window.__readerLifeLeaf.containerEl.querySelector('webview'),toggleCommand:!!app.commands.commands['webviewer:toggle-reader-mode'],galleryRemains:!!document.querySelector('.lightbox')})`);await dismiss();
    await toggle(true);await delay(300);
    report[name].reenabled=await c.evaluate(`({type:window.__readerLifeLeaf.view.getViewType(),leaves:app.workspace.getLeavesOfType('webviewer').length})`);
    await c.evaluate(`window.__readerLifeLeaf.detach()`);await open();report[name].newReaderAfterEnable=await c.evaluate(`window.__readerLifeLeaf.view.mode`);
    await c.evaluate(`(async()=>{window.__readerLifePopout=await app.workspace.openPopoutLeaf();await window.__readerLifePopout.setViewState({type:'webviewer',state:{url:${JSON.stringify(url)}},active:true});app.workspace.setActiveLeaf(window.__readerLifePopout);})()`);
    await c.wait(`window.__readerLifePopout.view.webview?.getURL()===${JSON.stringify(url)}&&!window.__readerLifePopout.view.webview.isLoading()`,'popout page');await c.evaluate(`window.__readerLifePopout.view.displayReaderView()`);
    await c.wait(`!!window.__readerLifePopout.containerEl.querySelector('.reader-mode-content img')`,'popout illustration');
    await c.evaluate(`(()=>{const image=window.__readerLifePopout.containerEl.querySelector('.reader-mode-content img');image.dispatchEvent(new image.ownerDocument.defaultView.MouseEvent('click',{bubbles:true,button:0}));})()`);await delay(350);
    report[name].popout=await c.evaluate(`(()=>{const win=window.__readerLifePopout.getContainer().win;return {galleryInPopout:!!win.document.querySelector('.lightbox'),galleryInRoot:!!document.querySelector('.lightbox')};})()`);
    await dismiss();
    report[name].popout.activation=await c.evaluate(`(()=>{const win=window.__readerLifePopout.getContainer().win;win.dispatchEvent(new win.Event('focus'));return {activeDocumentIsPopout:activeDocument===win.document};})()`);
    await c.evaluate(`(()=>{const image=window.__readerLifePopout.containerEl.querySelector('.reader-mode-content img');image.dispatchEvent(new image.ownerDocument.defaultView.MouseEvent('click',{bubbles:true,button:0}));})()`);await delay(350);
    report[name].popout.activated=await c.evaluate(`(()=>{const win=window.__readerLifePopout.getContainer().win;return {galleryInPopout:!!win.document.querySelector('.lightbox'),galleryInRoot:!!document.querySelector('.lightbox')};})()`);
    await c.evaluate(`(()=>{const win=window.__readerLifePopout.getContainer().win;window.__readerLifeGallery=win.document.querySelector('.lightbox');window.__readerLifePopoutWindow=win;win.close();})()`);
    await c.wait(`window.__readerLifePopoutWindow.closed`,'popout window closed');await delay(100);
    report[name].popout.windowClosed=true;report[name].popout.rootGalleryAfterClose=await c.evaluate(`!!document.querySelector('.lightbox')`);
    report[name].errors=c.errors;assert.deepEqual(c.errors,[]);
  }finally{await dismiss().catch(()=>{});await c.evaluate(`(()=>{if(window.__readerLifePopoutWindow&&!window.__readerLifePopoutWindow.closed)window.__readerLifePopoutWindow.close();window.__readerLifeRestored?.detach();window.__readerLifeLeaf?.detach();})()`).catch(()=>{});c.socket.close();}
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(report.obsen,report.reference);
console.log('Reader lifecycle audit passed.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
