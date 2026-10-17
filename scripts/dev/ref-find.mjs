// Usage: node ref-find.mjs <before> <after> <needle>... — prints context around each needle's first hits in the reference bundle.
import fs from 'node:fs';
const [before, after, ...needles] = process.argv.slice(2);
const src = fs.readFileSync(process.env.OBSIDIAN_REF_APP_JS, 'utf8');
for (const needle of needles) {
  let from = 0, shown = 0;
  while (shown < 2) { const at = src.indexOf(needle, from); if (at < 0) break; console.log(`== ${needle} @${at}\n${src.slice(Math.max(0, at - Number(before)), at + Number(after))}\n`); from = at + needle.length; shown++; }
  if (!shown) console.log(`== ${needle}: not found`);
}
