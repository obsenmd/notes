// Usage: node cdp.mjs <port> eval '<expr>|@file' [targetIndex] | node cdp.mjs <port> shot out.png [targetIndex] | node cdp.mjs <port> list
// Drives the recreation's renderer through Chromium's remote debugging port.
import fs from 'node:fs';
const [port, cmd, arg, idx = '0'] = process.argv.slice(2);
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');
if (cmd === 'list') { console.log(targets.map(t => `${t.title} ${t.url}`).join('\n')); process.exit(0); }
const ws = new WebSocket(targets[Number(idx)].webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
if (cmd === 'shot') {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg, Buffer.from(res.result.data, 'base64')); console.log('saved', arg);
} else {
  const expr = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;
  const res = await send('Runtime.evaluate', { expression: `(async()=>(${expr}))()`, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) { console.error(JSON.stringify(res.result.exceptionDetails.exception ?? res.result.exceptionDetails, null, 1).slice(0, 3000)); process.exit(1); }
  const v = res.result?.result?.value; console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
}
ws.close();
