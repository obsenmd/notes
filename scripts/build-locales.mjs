// Converts the reference app's line-oriented locale files into i18next JSON resources.
// Usage: node scripts/build-locales.mjs <raw-i18n-dir> <en.json> [en-GB.json]
// <raw-i18n-dir> holds mapping.txt (one key per line) and <lang>.txt (one value per line).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [rawDir, enFile, enGbFile] = process.argv.slice(2);
if (!rawDir || !enFile) throw new Error('Usage: node scripts/build-locales.mjs <raw-i18n-dir> <en.json> [en-GB.json]');
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'obsidian', 'locales');
await fs.mkdir(output, { recursive: true });

function assign(target, key, value) {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) node = node[part] && typeof node[part] === 'object' ? node[part] : (node[part] = {});
  node[parts.at(-1)] = value;
}
const write = (language, data) => fs.writeFile(path.join(output, `${language}.json`), JSON.stringify(data, null, 1) + '\n');

await write('en', JSON.parse(await fs.readFile(enFile, 'utf8')));
const languages = ['en'];
if (enGbFile) { await write('en-GB', JSON.parse(await fs.readFile(enGbFile, 'utf8'))); languages.push('en-GB'); }

const keys = (await fs.readFile(path.join(rawDir, 'mapping.txt'), 'utf8')).split('\n');
for (const file of (await fs.readdir(rawDir)).sort()) {
  const language = path.basename(file, '.txt');
  if (!file.endsWith('.txt') || language === 'mapping' || languages.includes(language)) continue;
  const values = (await fs.readFile(path.join(rawDir, file), 'utf8')).split('\n');
  const data = {};
  // Untranslated entries are blank lines; i18next falls back to English for them.
  keys.forEach((key, index) => { if (key && values[index]) assign(data, key, values[index].replace(/\n/g, '\n')); });
  await write(language, data);
  languages.push(language);
}
await fs.writeFile(path.join(output, 'index.json'), JSON.stringify(languages.sort(), null, 1) + '\n');
console.log(`Wrote ${languages.length} locales to ${output}`);
