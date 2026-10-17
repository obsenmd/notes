// Usage: node drive.mjs <port> <steps.json|-> — runs trusted input steps over CDP: {key}, {click:[x,y],button}, {type}, {wait}, {eval}, {shot}.
import fs from 'node:fs';
const [port, file] = process.argv.slice(2);
const steps = JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'));
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 600));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500)); };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Delete: 46, F2: 113 };
for (const step of steps) {
  if (step.wait) await new Promise(r => setTimeout(r, step.wait));
  if (step.key) { const mods = (step.ctrl ? 2 : 0) | (step.shift ? 8 : 0) | (step.alt ? 1 : 0); const code = KEYS[step.key] ?? step.key.toUpperCase().charCodeAt(0);
    const base = { key: step.key, code: KEYS[step.key] ? step.key : 'Key' + step.key.toUpperCase(), windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }); if (step.key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }); }
  if (step.type) await send('Input.insertText', { text: step.type });
  if (step.click) { const [x, y] = step.click, button = step.button ?? 'left', mods = (step.ctrl ? 2 : 0);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, modifiers: mods }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, modifiers: mods }); }
  if (step.move) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.move[0], y: step.move[1] });
  if (step.eval) { const r = await send('Runtime.evaluate', { expression: `(async()=>(${step.eval}))()`, awaitPromise: true, returnByValue: true }); const v = r.result?.result?.value; console.log(r.result?.exceptionDetails ? 'EVAL ERROR ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text) : (typeof v === 'string' ? v : JSON.stringify(v))); }
  if (step.shot) { await new Promise(r => setTimeout(r, 250)); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(step.shot, Buffer.from(r.result.data, 'base64')); console.log('saved', step.shot); }
}
if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
ws.close();
