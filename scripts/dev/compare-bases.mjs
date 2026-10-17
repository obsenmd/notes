// Capture matching Bases surfaces from two isolated, offscreen fixture processes.
import fs from 'node:fs/promises';
import path from 'node:path';
const [output = 'dist/todo-backup/bases-comparison'] = process.argv.slice(2);
await fs.mkdir(output, { recursive: true });
async function client(port, expected) {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(page => page.type === 'page');
  if (pages.length !== 1) throw new Error(`Expected one fixture page on ${port}`);
  const socket = new WebSocket(pages[0].webSocketDebuggerUrl), pending = new Map(); let serial = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') console.error(`Fixture ${port} exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); } };
  const send = (method, params) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result)); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text); return response.result.value; };
  await send('Runtime.enable');
  const basePath = await evaluate(`typeof app.vault.adapter.getBasePath === 'function' ? app.vault.adapter.getBasePath() : app.vault.adapter.basePath`);
  if (!basePath.includes(expected)) { socket.close(); throw new Error(`Port ${port} is not an isolated fixture`); }
  return { socket, send, evaluate };
}
const reference = await client(9351, 'obsen-reference-audit-'), obsen = await client(9341, 'obsen-electron-smoke-');
const scenarios = ['table', 'sort', 'group', 'filter', 'properties', 'propertyEditor', 'summary', 'summaryEditor', 'groupManual', 'cards', 'list'];
const report = {};
try {
  for (const scenario of scenarios) {
    report[scenario] = {};
    for (const [name, browser] of [['reference', reference], ['obsen', obsen]]) {
      console.log(`Capturing ${name} ${scenario}`);
      await browser.evaluate(`(async () => {
        for (let i=0;i<6 && document.querySelector('.menu.bases-toolbar-menu');i++) document.querySelector('.menu.bases-toolbar-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        const a=app; await a.workspace.getLeaf().openFile(a.vault.getFileByPath('Audit.base'));
        for (const view of a.workspace.activeLeaf.view.controller.query.views) { view.setGroupBy(null); view.setGroupOrder(null); }
        a.workspace.activeLeaf.view.controller.selectView(${JSON.stringify(scenario === 'cards' ? 'Cards' : scenario === 'list' ? 'List' : 'Table')});
        await new Promise(resolve => setTimeout(resolve,100));
      })()`);
      if (['sort', 'group', 'filter', 'properties', 'propertyEditor'].includes(scenario)) await browser.evaluate(`document.querySelector('.bases-header .bases-toolbar-${scenario === 'properties' || scenario === 'propertyEditor' ? 'properties' : scenario}-menu .text-icon-button').click()`);
      if (scenario === 'propertyEditor') {
        const point = await browser.evaluate(`(() => { const row=[...document.querySelectorAll('.bases-properties-page .bases-toolbar-menu-item')].find(e=>e.querySelector('.bases-toolbar-menu-item-name')?.textContent==='score'); const r=row.querySelector('.bases-toolbar-menu-item-icon').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      }
      if (scenario === 'summary' || scenario === 'summaryEditor') await browser.evaluate(`document.querySelector('.bases-table-footer .bases-td:nth-child(2) .bases-table-summary-cell').click()`);
      if (scenario === 'summaryEditor') {
        const point = await browser.evaluate(`(() => { const r=document.querySelector('.bases-summary-menu-item .bases-toolbar-menu-item-icon').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      }
      if (scenario === 'groupManual') await browser.evaluate(`(() => { const c=app.workspace.activeLeaf.view.controller; c.getViewConfig().setGroupBy({property:'note.status',direction:'ASC'}); c.getViewConfig().setGroupOrder(['todo']); document.querySelector('.bases-header .bases-toolbar-group-menu .text-icon-button').click(); })()`);
      await browser.evaluate(`new Promise(resolve => setTimeout(resolve,100))`);
      const metrics = await browser.evaluate(`(() => {
        const root=document.querySelector(${JSON.stringify(['table','cards','list'].includes(scenario) ? '.bases-header' : '.menu.bases-toolbar-menu')});
        const node=${JSON.stringify(['table','cards','list'].includes(scenario))} ? root.parentElement : root;
        const r=node.getBoundingClientRect();
        const outline=e=>({tag:e.tagName.toLowerCase(),class:e.getAttribute('class')??'',...(e.children.length?{children:[...e.children].filter(x=>x.tagName!=='svg' && x.tagName!=='path').slice(0,50).map(outline)}:{text:e.textContent}),...(e.getAttribute('placeholder')?{placeholder:e.getAttribute('placeholder')}:{})});
        return {rect:{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)},outline:outline(node)};
      })()`);
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png', clip: { ...metrics.rect, scale: 1 } });
      await fs.writeFile(path.join(output, `${name}-${scenario}.png`), Buffer.from(data, 'base64'));
      await fs.writeFile(path.join(output, `${name}-${scenario}.json`), JSON.stringify(metrics, null, 2));
      report[scenario][name] = metrics.rect;
    }
  }
  await fs.writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2));
  console.log(`Captured ${scenarios.length} paired Bases surfaces in ${output}`);
} finally { reference.socket.close(); obsen.socket.close(); }
