import fs from 'node:fs/promises';
const archive = await fs.readFile('C:/Program Files/Obsidian/resources/obsidian.asar');
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString());
let entry = header;
for (const name of ['lib', 'pdfjs', 'pdf.viewer.min.mjs']) entry = entry.files[name];
const offset = 8 + archive.readUInt32LE(4) + Number(entry.offset);
const source = archive.subarray(offset, offset + entry.size).toString();
await fs.writeFile('dist/todo-backup/reference-pdf-viewer.mjs', source);
for (const needle of ['case"page-height"', 'case"FitR"']) {
  const index = source.indexOf(needle);
  console.log(needle, source.slice(index - 1000, index + 250));
}
