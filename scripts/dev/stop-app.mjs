// Closes the recreation instance started with the debug port (never the reference app).
const port = process.argv[2] ?? '9340';
try {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise(r => setTimeout(r, 1500));
  console.log('closed');
} catch { console.log('not running'); }
