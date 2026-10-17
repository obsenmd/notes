import fs from 'node:fs';
const b=fs.readFileSync(process.env.APPDATA+'/obsidian/obsidian-1.14.4.asar');
const h=JSON.parse(b.subarray(16,16+b.readUInt32LE(12)).toString());
const e=h.files['app.js'];const base=8+b.readUInt32LE(4);
const s=b.subarray(base+Number(e.offset),base+Number(e.offset)+e.size).toString();
const match=s.match(/WI=\/([^/]+)\/,jI=\/([^/]+)\//);
if(!match)throw Error('Version matched Unicode ranges missing');
const pattern="(?:[0-9]+(?:(?:,|\\.)[0-9]+)*|[\\-'’"+match[1]+"஀-௿가-힣ꥠ-ꥼힰ-ퟆ])+|["+match[2]+"]";
const module=`import { getFrontMatterInfo } from "./metadata-cache";
// Unicode word boundaries from the inspected Obsidian 1.14.4 word-count worker.
const pattern = new RegExp(${JSON.stringify(pattern)}, "g");
export function getWordCount(markdown: string): {words: number; characters: number} {
  const info = getFrontMatterInfo(markdown);
  const body = info.exists ? markdown.slice(info.contentStart) : markdown;
  pattern.lastIndex = 0;
  return { words: body.match(pattern)?.length ?? 0, characters: body.length };
}
`;
fs.writeFileSync('src/compat/word-count.ts',module);
console.log('Wrote version matched word-count Unicode ranges.');
