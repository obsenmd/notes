import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = process.argv[2] ? path.resolve(process.argv[2]) : await fs.mkdtemp(path.join(os.tmpdir(), 'obsen-reference-audit-'));
if (process.argv[2] && (!path.basename(directory).startsWith('obsen-reference-audit-') || path.dirname(directory).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase())) throw new Error('Only an existing reference fixture under the temporary directory can be reused.');
const vault = path.join(directory, 'vault');
if (!process.argv[2]) {
await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
await fs.mkdir(path.join(vault, 'Dataset'));
await Promise.all(Array.from({ length: 1200 }, (_, index) => fs.writeFile(path.join(vault, 'Dataset', `Row ${String(index).padStart(4, '0')}.md`), `---\nscore: ${index}\nstatus: ${index % 2 ? 'done' : 'todo'}\n---\nDataset row ${index}.\n`)));
await fs.writeFile(path.join(vault, 'Audit.base'), 'filters: file.inFolder("Dataset")\nviews:\n  - type: table\n    name: Table\n    order: [file.name, score, status]\n    sort:\n      - property: score\n        direction: DESC\n    summaries:\n      score: Sum\n  - type: cards\n    name: Cards\n    order: [file.name, score]\n  - type: list\n    name: List\n    order: [file.name, score]\n');
await fs.writeFile(path.join(vault, '.obsidian', 'community-plugins.json'), '[]');
}
const env = { ...process.env, OBSEN_REFERENCE_FIXTURE: directory };
delete env.ELECTRON_RUN_AS_NODE;
const log = await fs.open(path.join(directory, 'reference.log'), 'a');
const child = spawn(require('electron'), [path.resolve('scripts/dev/reference-fixture.cjs')], { detached: true, windowsHide: true, env, stdio: ['ignore', log.fd, log.fd] });
child.unref(); await log.close();
await fs.writeFile(`dist/todo-backup/reference-fixture${process.env.OBSEN_REFERENCE_PORT ? '-' + process.env.OBSEN_REFERENCE_PORT : ''}.json`, JSON.stringify({ directory, pid: child.pid }));
console.log(JSON.stringify({ directory, pid: child.pid }));
