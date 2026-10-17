// Usage: node errors.mjs <port> [seconds] ['<expr to run after reload>'] — reloads the page and prints exceptions and console errors.
const [port, seconds = '5', expr] = process.argv.slice(2);
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
let id = 0; const out = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') out.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 700));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) out.push(m.params.type.toUpperCase() + ' ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500));
};
await new Promise(r => ws.onopen = r);
const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));
send('Runtime.enable'); send('Page.enable'); send('Page.reload');
await new Promise(r => setTimeout(r, Number(seconds) * 1000));
if (expr) { send('Runtime.evaluate', { expression: `(async()=>(${expr}))()`, awaitPromise: true }); await new Promise(r => setTimeout(r, 2500)); }
console.log(out.length ? [...new Set(out)].join('\n') : 'no errors'); ws.close();
