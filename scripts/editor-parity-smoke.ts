import assert from "node:assert/strict";
import { parseYaml, stringifyYaml } from "../src/compat/utilities";
import { parseMarkdownMetadata } from "../src/compat/metadata-cache";
import { Editor } from "../src/compat/editor";
import { linkAtCursor, tableAtCursor, toggleInlineFormat } from "../src/compat/editor-actions";
import { toggleTaskLine } from "../src/compat/markdown";
import { getWordCount } from "../src/compat/word-count";
import { codeMirrorTokenRanges, codeTokenDocRanges, loadPrism } from "../src/compat/prism";
import { loadMermaid } from "../src/compat/mermaid";

const yaml = 'title: "Yes: really"\naliases:\n  - first\n  - "second, alias"\nsummary: |\n  Two lines\n  with punctuation: # literal\nsettings: &defaults\n  enabled: true\n  score: 3.5\ncopy: *defaults\n';
const data = parseYaml(yaml) as Record<string, unknown>;
assert.deepEqual(data.aliases, ["first", "second, alias"]);
assert.equal(data.summary, "Two lines\nwith punctuation: # literal\n");
assert.deepEqual(data.copy, { enabled: true, score: 3.5 });
assert.deepEqual(parseYaml(stringifyYaml(data)), data);
assert.deepEqual(parseMarkdownMetadata(`---\n${yaml}---\n# Note`).frontmatter, data);
assert.throws(() => parseYaml("broken: ["));
assert.deepEqual(getWordCount("\nTest! Nice[[Untitled]]"), { words: 3, characters: 23 });
assert.deepEqual(getWordCount("---\ntitle: Ignore me\n---\n你好 hello-world 12.5"), { words: 4, characters: 19 });

const task = "---\r\ntitle: Task\r\n---\r\n> - [ ] nested task\r\n- [x] done\r\n";
assert.equal(toggleTaskLine(task, 3, true, "> - [ ] nested task"), task.replace("[ ]", "[x]"));
assert.equal(toggleTaskLine(task, 4, false), task.replace("- [x] done", "- [ ] done"));
assert.throws(() => toggleTaskLine(task, 3, true, "- [ ] stale"));
assert.throws(() => toggleTaskLine(task, 1, true));

const editor = new Editor("before selected after");
editor.setSelection({ line: 0, ch: 7 }, { line: 0, ch: 15 });
toggleInlineFormat(editor, "**");
assert.equal(editor.getValue(), "before **selected** after");
assert.equal(editor.getSelection(), "selected");
toggleInlineFormat(editor, "**");
assert.equal(editor.getValue(), "before selected after");
assert.equal(editor.getSelection(), "selected");
const multiSelection = new Editor("aa bb cc dd");
multiSelection.setSelections([
  { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 2 } },
  { anchor: { line: 0, ch: 6 }, head: { line: 0, ch: 8 } },
]);
multiSelection.transaction({ replaceSelection: "X" });
assert.equal(multiSelection.getValue(), "X bb X dd");
assert.deepEqual(multiSelection.listSelections(), [
  { anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 1 } },
  { anchor: { line: 0, ch: 6 }, head: { line: 0, ch: 6 } },
]);
editor.setCursor({ line: 0, ch: 0 });
toggleInlineFormat(editor, "[[", "]]");
assert.equal(editor.getValue(), "[[]]before selected after");
assert.deepEqual(editor.getCursor(), { line: 0, ch: 2 });
const table = new Editor("intro [[Note#Heading|alias]] and [text](My%20File.md)\n\n| a | b |\n| --- | :-: |\n| 1 | 2 |\n");
table.setCursor({ line: 0, ch: 10 });
assert.equal(linkAtCursor(table), "Note#Heading");
table.setCursor({ line: 0, ch: 40 });
assert.equal(linkAtCursor(table), "My File.md");
table.setCursor({ line: 0, ch: 2 });
assert.equal(linkAtCursor(table), null);
assert.equal(tableAtCursor(table), null);
table.setCursor({ line: 4, ch: 7 });
const context = tableAtCursor(table)!;
assert.deepEqual([context.start, context.end, context.row, context.column], [2, 4, 2, 1]);
assert.deepEqual(context.rows, [["a", "b"], ["---", ":-:"], ["1", "2"]]);
// encoded Markdown link destinations are cached decoded, without brackets or titles
const encoded = parseMarkdownMetadata('[a](My%20File.md) and [b](<Other File.md>) and ![c](img%20one.png "Title") and [web](https://example.com/a%20b)');
assert.deepEqual(encoded.links?.map(link => link.link), ["My File.md", "Other File.md"]);
assert.deepEqual(encoded.embeds?.map(link => link.link), ["img one.png"]);
const js = "const n = 1;";
const tokens = codeMirrorTokenRanges(js, "javascript");
const keyword = tokens.find(token => token.cls.includes("cm-keyword"));
assert.ok(keyword);
assert.equal(js.slice(keyword.from, keyword.to), "const");
assert.ok(tokens.some(token => token.cls.includes("cm-number")));
const mapped = codeTokenDocRanges("const a = 1;\nlet b = 2;", "javascript", [{ from: 10, length: 12 }, { from: 30, length: 10 }]);
assert.ok(mapped.some(token => token.from === 10 && token.cls.includes("cm-keyword")));
assert.ok(mapped.some(token => token.from === 30 && token.cls.includes("cm-keyword")));
void Promise.all([loadPrism(), loadMermaid()]).then(async ([prism, mermaid]) => {
  assert.equal(prism.languages.javascript, (globalThis as { Prism?: typeof prism }).Prism?.languages.javascript);
  const diagram = await mermaid.render("m1", "flowchart TD\n  A[Start] --> B[End]");
  assert.match(diagram.svg, /<svg[\s>]/);
  await assert.rejects(mermaid.render("m2", "flowchart TD\n  A -->"));
  console.log("Editor parity contracts passed (YAML/metadata, CRLF task writes/stale positions, format toggling, Prism tokens, pele diagrams).");
}).catch(error => { console.error(error); process.exitCode = 1; });
