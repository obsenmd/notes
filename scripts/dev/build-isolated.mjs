// Usage: node scripts/dev/build-isolated.mjs <dist directory> — builds the app into its own directory (no type check),
// so a worker can rebuild and reload its fixture without touching dist/ or another worker's bundle.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const dist = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('A dist directory is required.');
fs.mkdirSync(dist, { recursive: true });
const env = { ...process.env, OBSEN_DIST: dist };
const bin = path.resolve('node_modules/.bin', process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss');
execFileSync(bin, ['-i', 'src/renderer/styles.css', '-o', path.join(dist, 'styles.css')], { stdio: ['ignore', 'ignore', 'inherit'], env, shell: process.platform === 'win32' });
execFileSync(process.execPath, ['scripts/build-runtime.mjs'], { stdio: 'inherit', env });
