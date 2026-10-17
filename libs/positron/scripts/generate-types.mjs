import { generateDefinitions } from '@electron/typescript-definitions';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { version } = JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8'));
const directory = path.resolve(import.meta.dirname, '../generated');
await mkdir(directory, { recursive: true });
const schemaPath = path.join(directory, 'electron-api.json');
let schema;
try {
  schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  if (!schema.some(entry => entry.version === version)) schema = undefined;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!schema) {
  const response = await fetch(`https://github.com/electron/electron/releases/download/v${version}/electron-api.json`);
  if (!response.ok) throw new Error(`Electron ${version} API download failed: ${response.status}`);
  schema = await response.json();
  await writeFile(schemaPath, JSON.stringify(schema));
}
const definitions = await generateDefinitions({ electronApi: schema });
const end = definitions.indexOf("declare module 'electron'");
if (end < 0) throw new Error('Unexpected Electron definitions format');
await writeFile(path.join(directory, 'electron.d.ts'), definitions.slice(0, end) + '\nexport { Electron };\n');
console.log(`Generated Positron types from Electron ${version}.`);
