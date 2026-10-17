// Lists likely user-facing English literals that bypass the locale resources:
// JSX text nodes, and string literals in copy-bearing attributes or UI calls.
import fs from 'node:fs';
import path from 'node:path';
const files = [];
(function collect(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { if (!['locales', 'assets', 'wasm'].includes(entry.name)) collect(full); } else if (/\.tsx?$/.test(entry.name) && !/lucide-icons|command-inventory|word-count/.test(entry.name)) files.push(full); } })('src');
const patterns = [
  [/>\s*([A-Z][A-Za-z][^<>{}]*?[a-z.…:?!])\s*</g, 'jsx'],
  [/\b(?:aria-label|placeholder|title|alt)=\"([A-Z][^"]{2,})\"/g, 'attr'],
  [/\b(?:setTitle|setPlaceholder|setName|setDesc|setButtonText|setTooltip)\(\s*["'`]([A-Z][^"'`]{2,})["'`]/g, 'call'],
  [/new (?:Notice|Error|ParseError)\(\s*["'`]([A-Z][^"'`]{6,})["'`]/g, 'message'],
  [/\bsetAttribute\(\s*["'](?:aria-label|placeholder|title|alt)["']\s*,\s*["'`]([A-Z][^"'`]{2,})["'`]/g, 'attr-call'],
  [/\b(?:textContent|placeholder|title)\s*=\s*["'`]([A-Z][^"'`]{2,})["'`]/g, 'assign'],
];
let total = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n'); const hits = [];
  lines.forEach((line, index) => { if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; for (const [pattern, kind] of patterns) for (const match of line.matchAll(pattern)) { if (/^[A-Z][a-zA-Z]*$/.test(match[1]) && kind === 'jsx' && /[=(]/.test(line.slice(Math.max(0, match.index - 3), match.index))) continue; hits.push(`${index + 1}:${kind}: ${match[1].slice(0, 70)}`); } });
  if (hits.length) { total += hits.length; console.log(`${file} (${hits.length})`); if (process.argv.includes('--detail')) for (const hit of hits) console.log('   ' + hit); }
}
console.log(`${total} candidate literal(s)`);
process.exitCode = total && process.argv.includes('--strict') ? 1 : 0;
