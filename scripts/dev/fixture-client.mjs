// Renderer-only diagnostics for the isolated offscreen audit vaults.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function fixtureClient(port, expectedPrefix, { separateHistoricalErrors = false, waitForApp = false, allowPopoutPages = false } = {}) {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(page => page.type === 'page');
  const appPages = allowPopoutPages ? pages.filter(page => page.url !== 'about:blank') : pages;
  if (appPages.length !== 1 || (!allowPopoutPages && pages.length !== 1)) throw new Error(`Expected one fixture page on ${port}`);
  const socket = new WebSocket(appPages[0].webSocketDebuggerUrl), pending = new Map(), errors = [];
  let serial = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out on fixture ${port}`)); }, 25000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await send('Runtime.enable');
  let basePath;
  if (waitForApp) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try { basePath = await evaluate(`typeof app.vault.adapter.getBasePath === 'function' ? app.vault.adapter.getBasePath() : app.vault.adapter.basePath`); break; }
      catch { await delay(100); }
    }
    if (basePath === undefined) { socket.close(); throw new Error(`App did not become ready on fixture ${port}`); }
  } else basePath = await evaluate(`typeof app.vault.adapter.getBasePath === 'function' ? app.vault.adapter.getBasePath() : app.vault.adapter.basePath`);
  const resolved = await fs.realpath(basePath), tempRoot = await fs.realpath(os.tmpdir());
  const fixtureRoot = path.dirname(resolved);
  if (path.basename(resolved) !== 'vault' || !path.basename(fixtureRoot).startsWith(expectedPrefix) || path.dirname(fixtureRoot).toLowerCase() !== tempRoot.toLowerCase()) {
    socket.close(); throw new Error(`Port ${port} is not an isolated temporary fixture`);
  }
  // Runtime.enable replays stored console entries. Reused workflow fixtures
  // retain deliberately triggered errors from earlier audits; preserve those
  // separately when a caller requests a fresh run epoch.
  const historicalErrors = separateHistoricalErrors ? errors.splice(0) : [];
  if (separateHistoricalErrors) await send('Runtime.discardConsoleEntries');
  const wait = async (expression, label) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return; } catch { /* Navigation can replace the execution context. */ }
      await delay(100);
    }
    throw new Error(`Timed out on fixture ${port}: ${label}`);
  };
  const click = async selector => {
    const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Missing click target'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const key = async (key, code = key, options = {}) => {
    const windowsVirtualKeyCode = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Home: 36, End: 35 }[key] ?? 0;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...options });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, ...options });
  };
  const capture = async (directory, name, selector) => {
    await delay(100);
    const metrics = await evaluate(`(() => {
      const root=document.querySelector(${JSON.stringify(selector)}); if (!root) throw new Error('Missing capture target');
      const r=root.getBoundingClientRect(), outline=e=>({tag:e.tagName.toLowerCase(),class:e.getAttribute('class')??'',...(e.children.length?{children:[...e.children].filter(x=>!['svg','path'].includes(x.tagName)).map(outline)}:{text:e.textContent}),...(e.getAttribute('placeholder')?{placeholder:e.getAttribute('placeholder')}:{})});
      return {rect:{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)},outline:outline(root)};
    })()`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...metrics.rect, scale: 1 } });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${name}.png`), Buffer.from(data, 'base64'));
    await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(metrics, null, 2));
    return metrics.rect;
  };
  return { port, socket, errors, historicalErrors, send, evaluate, wait, click, key, capture };
}
