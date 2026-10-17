import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {fixtureClient, delay} from './fixture-client.mjs';

const paragraph = 'This article contains meaningful text and two illustrations for a reader gallery. Touch interaction should preserve the article while allowing the reader to inspect the images, move between them, zoom and return to the page. '.repeat(6);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300"><rect width="500" height="300" fill="#587da8"/></svg>';
const server = http.createServer((request,response)=>{
  response.setHeader('Content-Type',request.url.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
  response.end(request.url.endsWith('.svg') ? svg : `<title>Touch gallery</title><article><h1>Touch gallery</h1><p>${paragraph}</p><p><img src="/one.svg" alt="First image"></p><p><img src="/two.svg" alt="Second image"></p><p>${paragraph}</p></article>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url = 'http://127.0.0.1:'+server.address().port+'/article', output = 'dist/todo-backup/lightbox-touch-comparison', report={};
await fs.mkdir(output,{recursive:true});
const state = `(() => { const root=document.querySelector('.lightbox'),image=root?.querySelector('img'); return root ? {title:root.querySelector('.lightbox-titlebar-text').textContent,class:root.className,transform:image.style.transform,wrapper:image.parentElement.style.transform,background:root.querySelector('.lightbox-bg').style.opacity,close:root.querySelector('.modal-close-button').style.opacity} : {closed:true}; })()`;
try {
for(const [name,port,prefix] of [['reference',9352,'obsen-reference-audit-'],['obsen',9342,'obsen-electron-smoke-']]){
  const c=await fixtureClient(port,prefix,{separateHistoricalErrors:true}); report[name]={};
  const touch=async(type,points=[])=>c.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:1,radiusY:1,force:1}))});
  try {
    await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    if(await c.evaluate(`!!document.querySelector('.lightbox')`)){await c.evaluate(`document.querySelector('.lightbox').focus()`);await c.key('Escape');await c.wait(`!document.querySelector('.lightbox')`,'old lightbox closed');}
    await c.evaluate(`(() => { app.vault.setConfig('settingsPopoutWindow',false);app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();app.commands.executeCommandById('app:open-settings'); })()`);
    await c.wait(`!!document.querySelector('.modal.mod-settings [data-setting-id=plugins]')`,'settings');
    await c.evaluate(`document.querySelector('.modal.mod-settings [data-setting-id=plugins]').click()`);
    await c.evaluate(`(() => {const row=[...document.querySelectorAll('.modal.mod-settings .setting-item')].find(el=>el.querySelector('.setting-item-name')?.textContent.trim()==='Web viewer');const checkbox=row.querySelector('.checkbox-container');if(!checkbox.classList.contains('is-enabled'))checkbox.click();})()`);
    await delay(200);await c.evaluate(`document.querySelector('.modal.mod-settings .modal-header-button')?.click()`);
    await c.evaluate(`(async()=>{window.__touchAuditLeaf=app.workspace.getLeaf('tab');await window.__touchAuditLeaf.setViewState({type:'webviewer',state:{url:${JSON.stringify(url)}},active:true});app.workspace.setActiveLeaf(window.__touchAuditLeaf);})()`);
    await c.wait(`window.__touchAuditLeaf.view.webview?.getURL()===${JSON.stringify(url)}&&!window.__touchAuditLeaf.view.webview.isLoading()`,'article loaded');
    await c.evaluate(`window.__touchAuditLeaf.view.displayReaderView()`);
    await c.wait(`window.__touchAuditLeaf.containerEl.querySelectorAll('.reader-mode-content img').length===2`,'reader images');
    const open=async()=>{
      await c.evaluate(`(()=>{const image=window.__touchAuditLeaf.containerEl.querySelector('.reader-mode-content img');image.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0}));})()`);
      await c.wait(`!!document.querySelector('.lightbox img')`,'lightbox');await delay(350);await c.capture(output,name+'-open','.lightbox');
    };
    await open();await c.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
    await touch('touchStart',[[1,640,450]]);
    for(const x of [540,440,340,240,140]){await delay(30);await touch('touchMove',[[1,x,450]]);}
    await touch('touchEnd');report[name].swipeTransition=await c.evaluate(`({images:document.querySelectorAll('.lightbox img').length,sliding:document.querySelectorAll('.lightbox .is-sliding').length})`);await delay(400);await c.capture(output,name+'-swipe','.lightbox');report[name].swipe=await c.evaluate(state);
    await touch('touchStart',[[1,540,450],[2,740,450]]);
    await touch('touchMove',[[1,440,450],[2,840,450]]);await delay(100);await c.capture(output,name+'-pinch','.lightbox');report[name].pinch=await c.evaluate(state);
    await touch('touchCancel');await delay(300);report[name].cancel=await c.evaluate(state);
    await c.evaluate(`document.querySelector('.lightbox').focus()`);await c.key('Escape');await c.wait(`!document.querySelector('.lightbox')`,'zoomed gallery closed');
    await open();
    await touch('touchStart',[[1,540,450],[2,740,450]]);await touch('touchMove',[[1,560,450],[2,720,450]]);await touch('touchEnd');await delay(350);
    report[name].pinchRebound=await c.evaluate(state);await c.capture(output,name+'-rebound','.lightbox');
    await touch('touchStart',[[1,640,450]]);await touch('touchEnd');await delay(80);await touch('touchStart',[[1,640,450]]);await touch('touchEnd');await delay(350);
    report[name].doubleTap=await c.evaluate(state);
    await c.evaluate(`document.querySelector('.lightbox').focus()`);await c.key('Escape');await c.wait(`!document.querySelector('.lightbox')`,'double tap gallery closed');await open();
    await touch('touchStart',[[1,540,450],[2,740,450]]);
    await touch('touchMove',[[1,590,450],[2,690,450]]);await delay(100);await c.capture(output,name+'-shrink','.lightbox');report[name].shrink=await c.evaluate(state);
    await touch('touchEnd');await c.wait(`!document.querySelector('.lightbox')`,'pinch dismissal');report[name].pinchDismissed=true;
    await open();await touch('touchStart',[[1,640,450]]);
    for(const y of [530,610,690,770]){await delay(30);await touch('touchMove',[[1,640,y]]);}
    await touch('touchEnd');await c.wait(`!document.querySelector('.lightbox')`,'vertical dismissal');report[name].verticalDismissed=true;
    await open();await touch('touchStart',[[1,640,450]]);await touch('touchMove',[[1,590,450]]);await touch('touchCancel');await delay(300);
    report[name].swipeCancel=await c.evaluate(state);await c.capture(output,name+'-cancel','.lightbox');
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:30,y:450,button:'left',clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:30,y:450,button:'left',clickCount:1});await delay(350);
    report[name].clickAfterCancelClosed=await c.evaluate(`!document.querySelector('.lightbox')`);
    if(!report[name].clickAfterCancelClosed){await c.evaluate(`document.querySelector('.lightbox').focus()`);await c.key('Escape');await c.wait(`!document.querySelector('.lightbox')`,'cancelled gallery closed');}
    assert.deepEqual(c.errors,[]);report[name].errors=c.errors;
  }finally{
    await touch('touchCancel').catch(()=>{});await c.send('Emulation.setTouchEmulationEnabled',{enabled:false}).catch(()=>{});
    await c.evaluate(`window.__touchAuditLeaf?.detach()`).catch(()=>{});c.socket.close();
  }
}
await fs.writeFile(output+'/report.json',JSON.stringify(report,null,2));assert.deepEqual(report.obsen,report.reference);
for(const key of ['open','swipe','pinch','shrink','cancel','rebound']){
  const reference=JSON.parse(await fs.readFile(output+'/reference-'+key+'.json','utf8'));
  const obsen=JSON.parse(await fs.readFile(output+'/obsen-'+key+'.json','utf8'));
  assert.deepEqual(obsen.outline,reference.outline,key+' touch DOM');assert.deepEqual(obsen.rect,reference.rect,key+' touch bounds');
}
console.log('Touch gallery audit passed: native swipe, pinch zoom/cancel, pinch and vertical dismissal, swipe cancellation.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
