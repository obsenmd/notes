// Verifies that every literal key passed to t()/hasTranslation()/describe() and every
// `...Key: "..."` locale reference in src/ exists in the English resources.
import fs from 'node:fs';
import path from 'node:path';
const flat = new Set();
const walk = (node, prefix) => { for (const [key, value] of Object.entries(node)) typeof value === 'string' ? flat.add(prefix + key) : walk(value, `${prefix}${key}.`); };
walk(JSON.parse(fs.readFileSync('assets/obsidian/locales/en.json', 'utf8')), '');
walk({ obsen: JSON.parse(fs.readFileSync('src/locales/app/en.json', 'utf8')) }, '');
const files = [];
(function collect(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { if (entry.name !== 'locales' && entry.name !== 'assets') collect(full); } else if (/\.tsx?$/.test(entry.name)) files.push(full); } })('src');
const patterns = [/\b(?:t|hasTranslation|describe)\(\s*"([^"]+)"/g, /\b(?:nameKey|labelKey|prefixKey|wrapKey)[=:]\s*\{?"([^"]+)"/g, /"((?:setting|interface|plugins|commands|dialogue|nouns|editor|properties|menu-items|table|callout|obsen)\.[a-z0-9.-]+)"/g];
// Monaco uses these as editor color identifiers, not localization references.
const nonLocaleLiterals = new Set(['editor.background', 'editor.foreground']);
let missing = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
    const key = match[1];
    if (pattern === patterns[2] && file.endsWith('monaco-editor.tsx') && nonLocaleLiterals.has(key)) continue;
    if (!/^[a-z-]+\.[a-z0-9.-]+$/i.test(key) || key.endsWith('.') || key.endsWith('-') || seen.has(key)) continue;
    seen.add(key);
    if (!flat.has(key)) { console.log(`${file}: ${key}`); missing++; }
  }
}
console.log(missing ? `${missing} missing locale key(s)` : 'All locale keys resolve.');
process.exitCode = missing ? 1 : 0;
