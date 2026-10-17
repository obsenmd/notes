// Evaluate a file in an explicitly selected local Electron main-process inspector.
// Keep expressions scoped to test fixtures; never print account or vault secrets.
import fs from 'node:fs/promises';
const [port, filename] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (targets.length !== 1) throw new Error(`Expected one inspector target, found ${targets.length}`);
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let serial = 0;
const requests = new Map();
socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { requests.get(message.id)?.(message); requests.delete(message.id); } };
try {
  const response = await new Promise(resolve => {
    const id = ++serial; requests.set(id, resolve);
    fs.readFile(filename, 'utf8').then(expression => socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })));
  });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  console.log(JSON.stringify(response.result?.result?.value, null, 2));
} finally { socket.close(); }
