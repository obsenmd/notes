import fs from 'node:fs/promises';
import { fixtureClient } from './fixture-client.mjs';
const c=await fixtureClient(9351,'obsen-reference-audit-');
try {
  for (const file of ['black.css','white.css','reveal.css']) {
    const text=await c.evaluate(`(await fetch('/lib/reveal/${file}')).text()`);
    await fs.writeFile(`dist/todo-backup/reference-${file}`,text);
    console.log(`${file}: ${text.length} bytes`);
  }
} finally { c.socket.close(); }
