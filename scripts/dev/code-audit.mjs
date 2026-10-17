// Compare fenced code highlighting (reading view, Live Preview, source mode) and Mermaid diagrams
// in the two running offscreen fixture vaults (see README.md in this folder for how they are started).
// One small note per block, so that neither app's lazy section rendering hides a block.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const output = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ?? 'dist/todo-backup/code-comparison';
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
const referencePort = Number(process.env.OBSEN_REFERENCE_PORT ?? 9357), ownPort = Number(process.env.OBSEN_SMOKE_PORT ?? 9347);
await fs.mkdir(output, { recursive: true });
const clients = [['reference', await fixtureClient(referencePort, 'obsen-reference-audit-')], ['obsen', await fixtureClient(ownPort, 'obsen-electron-smoke-')]];
const F = '```';
// [note name, info string, code]
const blocks = [
  ['js', 'js', 'import { readFile } from "node:fs/promises";\n// Line comment\nconst answer = 42, pattern = /ab+c/gi;\nexport async function load(path, { retries = 3 } = {}) {\n  const text = await readFile(path, "utf8");\n  if (text === null || retries > 1e3) return undefined;\n  return `${text.trim()}: ${answer}`;\n}\nclass Shape extends Base { static count = 0; get area() { return this.w * this.h; } }'],
  ['ts', 'ts', 'interface Point<T extends number = number> { readonly x: T; y?: T }\ntype Shape = "circle" | "square";\nenum Color { Red, Green = 2 }\nexport abstract class Store<K, V> implements Iterable<V> {\n  private items = new Map<K, V>();\n  constructor(public name: string) {}\n  get<T>(key: K): V | undefined { return this.items.get(key) as V; }\n}\nconst n: number = 0x1f; // hex\ndeclare function assert(value: unknown): asserts value;'],
  ['python', 'python', 'import os\nfrom typing import Optional\n\n@dataclass\nclass Point:\n    """A point."""\n    x: float = 0.0\n\n    def norm(self, p: int = 2) -> float:\n        # comment\n        return abs(self.x) ** p if self.x is not None else 0\n\nasync def main(*args, **kwargs):\n    async with open(f"{os.getcwd()}/a.txt", "rb") as fh:\n        print(len(await fh.read()), True, None, 0b101, 3.14e-2)\nlambda x: x + 1'],
  ['bash', 'bash', '#!/usr/bin/env bash\nset -euo pipefail\nNAME="world"\nfor f in *.txt; do\n  echo "Hello, ${NAME}: $f" | tr a-z A-Z >> out.log\ndone\nif [[ -n "$1" && $# -gt 1 ]]; then exit 1; fi\nfunction greet() { local who=$1; printf \'%s\\n\' "$who"; }\ncount=$(ls -la | wc -l) # trailing comment'],
  ['json', 'json', '{\n  "name": "obsen",\n  "version": 1.5,\n  "private": true,\n  "nothing": null,\n  "list": [1, -2, 3e4, "four"],\n  "nested": { "key": "value \\"quoted\\"" }\n}'],
  ['yaml', 'yaml', '# comment\nname: Example\nversion: 1.2\nenabled: true\nempty: null\nlist:\n  - one\n  - "two"\n  - 3\nanchors: &base\n  key: value\nmerged:\n  <<: *base\n  text: |\n    multi\n    line\n---\nsecond: doc'],
  ['html', 'html', '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <style>body { color: red; }</style>\n  <script>const x = 1 < 2;</script>\n</head>\n<body>\n  <!-- comment -->\n  <a href="https://example.com" class=\'link\' disabled>Text &amp; more</a>\n  <br/>\n</body>\n</html>'],
  ['css', 'css', '@import url("base.css");\n:root { --accent: #ff8800; }\n/* comment */\n.card > a:hover, #main::before {\n  color: var(--accent) !important;\n  margin: 0 auto 1.5em -2px;\n  background: url(img.png) no-repeat, rgba(0, 0, 0, .5);\n}\n@media (max-width: 600px) { .card { display: none; } }'],
  ['c', 'c', '#include <stdio.h>\n#define MAX(a, b) ((a) > (b) ? (a) : (b))\n/* block comment */\nstruct point { int x; double y; };\nstatic const char *name = "c\\n";\nint main(int argc, char **argv) {\n  unsigned long n = 10UL;\n  for (int i = 0; i < n; i++) printf("%d %c\\n", i, \'a\');\n  return 0; // done\n}'],
  ['cpp', 'cpp', '#include <vector>\nnamespace geo {\ntemplate <typename T>\nclass Box : public Shape {\npublic:\n  explicit Box(T w) : w_(w) {}\n  virtual ~Box() = default;\n  auto area() const noexcept -> T { return w_ * w_; }\nprivate:\n  T w_{};\n};\n}\nint main() { std::vector<int> v{1, 2, 3}; auto p = std::make_unique<geo::Box<double>>(2.5); return nullptr == p.get(); }'],
  ['java', 'java', 'package com.example;\n\nimport java.util.List;\n\n/** Javadoc. */\n@SuppressWarnings("unchecked")\npublic final class Main<T extends Comparable<T>> implements Runnable {\n    private static final int MAX = 0x10;\n    public static void main(String[] args) throws Exception {\n        List<String> items = new ArrayList<>();\n        for (String s : args) { if (s != null && s.length() > 2L) items.add(s + \'c\'); }\n        System.out.println(items.size() + " items"); // comment\n    }\n}'],
  ['go', 'go', 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\ntype Point struct {\n\tX, Y float64 `json:"x"`\n}\n\nfunc (p *Point) Norm() float64 { return p.X*p.X + p.Y*p.Y }\n\nfunc main() {\n\tch := make(chan int, 3)\n\tdefer close(ch)\n\tfor i, v := range []string{"a", "b"} {\n\t\tif v != "" || i > 0x1F { fmt.Println(i, v, nil, true) } // comment\n\t}\n\tgo func() { ch <- 1 }()\n\tos.Exit(0)\n}'],
  ['rust', 'rust', 'use std::collections::HashMap;\n\n#[derive(Debug, Clone)]\npub struct Point<T> { x: T, y: T }\n\nimpl<T: Copy + std::ops::Add<Output = T>> Point<T> {\n    /// Doc comment\n    pub fn sum(&self) -> T { self.x + self.y }\n}\n\nfn main() -> Result<(), Box<dyn std::error::Error>> {\n    let mut map: HashMap<&str, u32> = HashMap::new();\n    map.insert("a", 1_000u32);\n    let c = \'x\'; // char\n    if let Some(v) = map.get("a") { println!("{} {:?}", v, c); }\n    match 3 { 0..=9 => {}, _ => unreachable!() }\n    Ok(())\n}'],
  ['sql', 'sql', '-- comment\nCREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name VARCHAR(40) NOT NULL DEFAULT \'anon\',\n  score DECIMAL(5, 2)\n);\nSELECT u.name, COUNT(*) AS total\nFROM users u LEFT JOIN posts p ON p.user_id = u.id\nWHERE u.score >= 1.5 AND u.name LIKE \'A%\' OR p.id IS NULL\nGROUP BY u.name HAVING COUNT(*) > 2\nORDER BY total DESC LIMIT 10; /* block */'],
  ['markdown', 'markdown', '# Heading\n\nSome *emphasis*, **strong** and `code` with a [link](https://example.com "title").\n\n- item one\n- item two\n\n> quote\n\n1. first\n2. second\n\n---\n\n![image](a.png)'],
  ['diff', 'diff', 'diff --git a/file.txt b/file.txt\nindex 83db48f..bf269f4 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1,4 +1,4 @@\n unchanged line\n-removed line\n+added line\n unchanged again'],
  ['unknown', 'notalanguage', 'some text here = 42;\n"quoted" // not highlighted\nif (x) { return y; }'],
  ['nolang', '', 'plain block\n  with indentation and = signs\n"quotes" and // slashes'],
  // Aliases, checked for token output only.
  ['alias-py', 'py', 'def f(x):\n    return x + 1  # comment'],
  ['alias-sh', 'sh', 'echo "hi $USER" && exit 0'],
  ['alias-yml', 'yml', 'key: value\nlist: [1, 2]'],
  ['alias-md', 'md', '## Title\n\n**bold** text'],
  ['alias-javascript', 'javascript', 'let a = [1, "two", null];'],
  ['alias-typescript', 'typescript', 'let a: Array<string> = [];'],
  ['alias-cplusplus', 'c++', 'int main() { return 0; }'],
  ['alias-cs', 'cs', 'public class A { private readonly int x = 1; string S => $"v{x}"; }'],
  ['alias-xml', 'xml', '<?xml version="1.0"?>\n<root attr="1"><!-- c --><child/></root>'],
  ['alias-shell', 'shell', 'ls -la | grep "x"'],
  ['upper-JS', 'JS', 'const a = 1;'],
];
const diagrams = [
  ['mermaid-flowchart', 'flowchart TD\n  A[Start] --> B{Is it working?}\n  B -- Yes --> C[Great]\n  B -- No --> D[Fix it]\n  D --> B\n  C --> E((Done))'],
  ['mermaid-sequence', 'sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: Hello Bob, how are you?\n  B-->>A: Great!\n  Note right of B: Bob thinks\n  A-)B: See you later'],
  ['mermaid-invalid', 'flowchart TD\n  A -->\n  ??? [['],
  ['mermaid-link', 'flowchart LR\n  A[Audit target note] --> B[Other]\n  class A internal-link;'],
];
const folder = 'Code audit';
const notes = Object.fromEntries([
  ...blocks.map(([name, info, code]) => [`${folder}/${name}.md`, `Before ${name}\n\n${F}${info}\n${code}\n${F}\n\nAfter\n`]),
  ...diagrams.map(([name, code]) => [`${folder}/${name}.md`, `Before ${name}\n\n${F}mermaid\n${code}\n${F}\n\nAfter\n`]),
]);
const selected = entry => !only || only.includes(entry[0]);
const warm = c => Promise.race([c.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined), delay(3000)]);
const leaf = `document.querySelector('.workspace-leaf.mod-active')`;
// Text nodes in document order, each with the classes of the elements between it and the root, merged when equal.
const walker = `const pieces = (root, skip) => { const out = []; const visit = (node, chain) => { for (const child of node.childNodes) {
  if (child.nodeType === 3) { if (!child.data) continue; const key = chain.join(' > '); const last = out[out.length - 1]; if (last && last[0] === key) last[1] += child.data; else out.push([key, child.data]); }
  else if (child.nodeType === 1) { if (skip && child.matches(skip)) { out.push(['widget:' + child.className, child.textContent]); continue; } if (child.tagName === 'BR' || child.tagName === 'IMG') continue; visit(child, [...chain, [...child.classList].sort().join(' ')]); } } }; visit(root, []); return out; };`;
const readingProbe = `(() => { ${walker}
  const root = ${leaf}.querySelector('.markdown-reading-view'); const pre = root?.querySelector('pre'); if (!pre) return { missing: true, html: root?.querySelector('.markdown-preview-sizer, .markdown-preview-view')?.innerHTML.slice(0, 400) };
  const code = pre.querySelector('code');
  return { preClass: [...pre.classList].sort().join(' '), preTabindex: pre.getAttribute('tabindex'), codeClass: [...code.classList].sort().join(' '), children: [...pre.children].map(e => e.tagName.toLowerCase() + '.' + [...e.classList].sort().join('.')), tokens: pieces(code) };
})()`;
// Code lines of the editor: line classes and [span classes, text] pairs (classes of nested spans are united).
const editorProbe = `(() => { const out = []; const content = ${leaf}.querySelector('.markdown-source-view .cm-content'); if (!content) return { missing: true };
  for (const line of content.children) { if (!line.classList.contains('HyperMD-codeblock')) continue;
    const spans = []; const visit = (node, classes) => { for (const child of node.childNodes) {
      if (child.nodeType === 3) { if (!child.data) continue; const key = [...new Set(classes)].sort().join(' '); const last = spans[spans.length - 1]; if (last && last[0] === key) last[1] += child.data; else spans.push([key, child.data]); }
      else if (child.nodeType === 1) { if (child.classList.contains('code-block-flair') || child.classList.contains('cm-widgetBuffer') || child.tagName === 'BR' || child.tagName === 'IMG') { if (child.classList.contains('code-block-flair')) spans.push(['widget:code-block-flair', child.textContent]); continue; } visit(child, [...classes, ...child.classList]); } } };
    visit(line, []);
    out.push({ line: [...line.classList].filter(name => name !== 'cm-active').sort().join(' '), spans }); }
  return out; })()`;
const outline = `const outline = e => ({ tag: e.tagName.toLowerCase(), class: [...e.classList].sort().join(' '), ...(e.children.length && e.tagName.toLowerCase() !== 'svg' ? { children: [...e.children].map(outline) } : e.tagName.toLowerCase() === 'svg' ? {} : { text: e.textContent }) });`;
const svgInfo = `const svgInfo = svg => { if (!svg) return null; const r = svg.getBoundingClientRect(); const count = {}; for (const e of svg.querySelectorAll('*')) count[e.tagName.toLowerCase()] = (count[e.tagName.toLowerCase()] ?? 0) + 1;
  return { width: Math.round(r.width), height: Math.round(r.height), attrWidth: svg.getAttribute('width'), attrHeight: svg.getAttribute('height'), viewBox: svg.getAttribute('viewBox'), style: svg.getAttribute('style'), class: svg.getAttribute('class'), role: svg.getAttribute('aria-roledescription'), idShape: (svg.id || '').replace(/[0-9a-f]{16}/, '<hex16>'), counts: count,
    labels: [...svg.querySelectorAll('.nodeLabel, .edgeLabel, text')].map(e => e.textContent.trim()).filter(Boolean), links: [...svg.querySelectorAll('a')].map(a => a.getAttribute('class') + '|' + a.getAttribute('href') + '|' + a.textContent) }; };`;
const mermaidReading = `(() => { ${outline} ${svgInfo}
  const root = ${leaf}.querySelector('.markdown-reading-view'); const el = root?.querySelector('.mermaid, .mermaid-wrapper, pre');
  if (!el) return { missing: true };
  const section = el.closest('.markdown-preview-sizer > div, .markdown-preview-section > div') ?? el.parentElement;
  return { outline: outline(el), parentClass: [...el.parentElement.classList].sort().join(' '), svg: svgInfo(el.querySelector('svg')), text: el.querySelector('svg') ? null : el.textContent, strayBody: document.querySelectorAll('body > .mermaid, body > [id^="dm"]').length };
})()`;
const mermaidEditor = `(() => { ${outline} ${svgInfo}
  const content = ${leaf}.querySelector('.markdown-source-view .cm-content'); const el = content?.querySelector('.cm-embed-block');
  if (!el) return { missing: true, lines: [...(content?.children ?? [])].map(e => e.className) };
  return { outline: outline(el), tabindex: el.getAttribute('tabindex'), contenteditable: el.getAttribute('contenteditable'), svg: svgInfo(el.querySelector('svg')), text: el.querySelector('svg') ? null : el.textContent };
})()`;
const report = {};
const setMode = (mode, source) => `(async () => { const view = app.workspace.activeLeaf.view; await view.setState({ ...view.getState(), mode: ${JSON.stringify(mode)}, source: ${source} }, { history: false }); })()`;
try {
  for (const [name, c] of clients) {
    console.log(`Preparing ${name} code fixture`);
    const result = report[name] = {};
    const capture = async (scenario, selector) => { try { result[scenario + ':rect'] = await c.capture(output, `${name}-${scenario}`, selector); } catch (error) { result[scenario + ':rect'] = { error: String(error.message) }; } };
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.key('Escape');
    await c.evaluate(`(async () => {
      if (!app.vault.getFolderByPath(${JSON.stringify(folder)})) await app.vault.createFolder(${JSON.stringify(folder)});
      for (const [p, text] of Object.entries(${JSON.stringify(notes)})) { const f = app.vault.getFileByPath(p); if (f) { if (await app.vault.read(f) !== text) await app.vault.modify(f, text); } else await app.vault.create(p, text); }
      if (!app.vault.getFileByPath('Audit target note.md')) await app.vault.create('Audit target note.md', 'Target\\n');
    })()`);
    // The same pane layout in both apps, so positions are comparable.
    await c.evaluate(`(() => { if (!app.workspace.rightSplit.collapsed) app.commands.executeCommandById('app:toggle-right-sidebar'); if (!app.workspace.leftSplit.collapsed) app.commands.executeCommandById('app:toggle-left-sidebar'); })()`);
    const trust = value => c.evaluate(`(() => { app.saveLocalStorage('mermaid-vault-trust', ${value}); app.workspace.trigger('post-processor-change'); })()`);
    await trust('true');
    await delay(800);
    const open = async (noteName, mode, source) => {
      await c.evaluate(`(async () => { const leaf = app.workspace.getLeaf(); await leaf.openFile(app.vault.getFileByPath(${JSON.stringify(`${folder}/${noteName}.md`)})); })()`);
      await c.evaluate(setMode(mode, source));
      if (mode === 'source') await c.evaluate(`(() => { const e = app.workspace.activeLeaf.view.editor; e.setCursor({ line: 0, ch: 0 }); })()`);
      await delay(250);
    };
    await open(blocks[0][0], 'preview', false);
    await warm(c);

    for (const entry of blocks.filter(selected)) {
      const [block] = entry;
      try {
      await open(block, 'preview', false);
      try { await c.wait(`!!${leaf}.querySelector('.markdown-reading-view pre code.is-loaded, .markdown-reading-view pre code:not([class*="language-"])')`, `${block} reading view`); } catch { /* recorded as it is */ }
      await delay(150);
      result[`${block}:reading`] = await c.evaluate(readingProbe);
      await capture(`${block}-reading`, '.workspace-leaf.mod-active .markdown-reading-view pre');
      await open(block, 'source', false);
      try { await c.wait(`!!${leaf}.querySelector('.markdown-source-view.is-live-preview .cm-content .HyperMD-codeblock')`, `${block} live preview`); } catch { /* recorded as it is */ }
      await delay(500);
      result[`${block}:live`] = await c.evaluate(editorProbe);
      await capture(`${block}-live`, '.workspace-leaf.mod-active .markdown-source-view .cm-content');
      await open(block, 'source', true);
      try { await c.wait(`!!${leaf}.querySelector('.markdown-source-view:not(.is-live-preview) .cm-content .HyperMD-codeblock')`, `${block} source mode`); } catch { /* recorded as it is */ }
      await delay(300);
      result[`${block}:source`] = await c.evaluate(editorProbe);
      await capture(`${block}-source`, '.workspace-leaf.mod-active .markdown-source-view .cm-content');
      } catch (error) { result[`${block}:failure`] = String(error.message).split('\n')[0]; console.log(`${name} ${block}: ${result[`${block}:failure`]}`); }
    }

    for (const entry of diagrams.filter(selected)) {
      const [diagram] = entry;
      try {
      await open(diagram, 'preview', false);
      try { await c.wait(`!!${leaf}.querySelector('.markdown-reading-view .mermaid svg') || (${leaf}.querySelector('.markdown-reading-view pre code')?.textContent ?? '').startsWith('Error')`, `${diagram} reading view`); } catch { /* recorded as it is */ }
      await delay(600);
      result[`${diagram}:reading`] = await c.evaluate(mermaidReading);
      await capture(`${diagram}-reading`, '.workspace-leaf.mod-active .markdown-reading-view :is(.mermaid, .mermaid-wrapper, pre)');
      await open(diagram, 'source', false);
      try { await c.wait(`!!${leaf}.querySelector('.markdown-source-view .cm-content .cm-embed-block :is(svg, pre)')`, `${diagram} live preview`); } catch { /* recorded as it is */ }
      await delay(800);
      result[`${diagram}:live`] = await c.evaluate(mermaidEditor);
      await capture(`${diagram}-live`, '.workspace-leaf.mod-active .markdown-source-view .cm-content .cm-embed-block');
      // Cursor inside the fence: the source is shown again.
      await c.evaluate(`(() => { const e = app.workspace.activeLeaf.view.editor; e.focus(); e.setCursor({ line: 3, ch: 0 }); })()`);
      await delay(400);
      result[`${diagram}:live-editing`] = await c.evaluate(`(() => { const content = ${leaf}.querySelector('.markdown-source-view .cm-content'); return { widget: !!content.querySelector('.cm-embed-block'), codeLines: content.querySelectorAll('.HyperMD-codeblock').length }; })()`);
      await open(diagram, 'source', true);
      await delay(300);
      result[`${diagram}:source`] = await c.evaluate(editorProbe);
      } catch (error) { result[`${diagram}:failure`] = String(error.message).split('\n')[0]; console.log(`${name} ${diagram}: ${result[`${diagram}:failure`]}`); }
    }

    // Before the vault allows diagrams: the guard, in reading view and Live Preview.
    if (!only || only.includes('mermaid-guard')) try {
      await trust('null');
      await delay(500);
      await open('mermaid-flowchart', 'preview', false);
      try { await c.wait(`!!${leaf}.querySelector('.markdown-reading-view .mermaid-wrapper.is-guarded code.is-loaded')`, 'guard in reading view'); } catch { /* recorded as it is */ }
      await delay(300);
      result['mermaid-guard:reading'] = await c.evaluate(mermaidReading);
      await capture('mermaid-guard-reading', '.workspace-leaf.mod-active .markdown-reading-view :is(.mermaid, .mermaid-wrapper, pre)');
      await open('mermaid-flowchart', 'source', false);
      try { await c.wait(`!!${leaf}.querySelector('.markdown-source-view .cm-content .cm-embed-block .mermaid-wrapper')`, 'guard in live preview'); } catch { /* recorded as it is */ }
      await delay(500);
      result['mermaid-guard:live'] = await c.evaluate(mermaidEditor);
      await capture('mermaid-guard-live', '.workspace-leaf.mod-active .markdown-source-view .cm-content .cm-embed-block');
      // The Allow button stores the choice and renders the diagram.
      await open('mermaid-flowchart', 'preview', false);
      await delay(300);
      result['mermaid-guard:allow'] = await c.evaluate(`(async () => { const button = ${leaf}.querySelector('.markdown-reading-view .mermaid-guard-actions button'); if (!button) return { missing: true }; button.click(); for (let i = 0; i < 60 && !${leaf}.querySelector('.markdown-reading-view .mermaid svg'); i++) await new Promise(r => setTimeout(r, 100)); return { stored: app.loadLocalStorage('mermaid-vault-trust'), rendered: !!${leaf}.querySelector('.markdown-reading-view .mermaid svg'), guard: !!${leaf}.querySelector('.markdown-reading-view .mermaid-wrapper') }; })()`);
      await trust('true');
    } catch (error) { result['mermaid-guard:failure'] = String(error.message).split('\n')[0]; console.log(`${name} mermaid-guard: ${result['mermaid-guard:failure']}`); await trust('true').catch(() => {}); }

    // Plugin API (the re-creation only exposes it through the module table; the reference has the globals after rendering).
    result.api = await c.evaluate(`(() => ({ prism: typeof window.Prism?.highlightElement, prismLanguages: window.Prism?.languages ? Object.keys(window.Prism.languages).filter(k => typeof window.Prism.languages[k] !== 'function').length : null, mermaid: typeof window.mermaid?.render }))()`);
    await c.evaluate(setMode('source', false)).catch(() => {});
    result.errors = c.errors.slice();
    console.log(`${name}: ${JSON.stringify({ blocks: blocks.filter(selected).length, diagrams: diagrams.filter(selected).length, api: result.api, errors: result.errors.length })}`);
  }
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2));
  const differences = [], summary = {};
  const equal = (a, b) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
  for (const key of Object.keys(report.reference)) {
    if (key === 'errors') continue;
    if (key.endsWith(':rect')) {
      const a = report.reference[key], b = report.obsen[key];
      if (!b || a.width !== b.width || a.height !== b.height || a.x !== b.x || a.y !== b.y) differences.push(key);
      continue;
    }
    if (!equal(report.obsen[key], report.reference[key])) differences.push(key);
  }
  // Per block: do the token lists match, whatever else differs?
  const tokensOf = (value, mode) => mode === 'reading' ? value?.tokens : Array.isArray(value) ? value.map(line => line.spans) : value;
  for (const [block] of blocks.filter(selected)) {
    summary[block] = {};
    for (const mode of ['reading', 'live', 'source']) {
      const a = report.reference[`${block}:${mode}`], b = report.obsen[`${block}:${mode}`];
      summary[block][mode] = equal(a, b) ? 'same' : equal(tokensOf(a, mode), tokensOf(b, mode)) ? 'tokens same, container differs' : 'DIFFERENT';
    }
  }
  for (const key of Object.keys(report.reference).filter(k => k.startsWith('mermaid') && !k.endsWith(':rect'))) summary[key] = equal(report.obsen[key], report.reference[key]) ? 'same' : 'DIFFERENT';
  await fs.writeFile(path.join(output, 'differences.json'), JSON.stringify(Object.fromEntries(differences.map(key => [key, { reference: report.reference[key], obsen: report.obsen[key] }])), null, 2));
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  for (const [key, value] of Object.entries(summary)) console.log(`${key}: ${typeof value === 'string' ? value : Object.entries(value).map(([mode, state]) => `${mode}=${state}`).join(', ')}`);
  console.log(differences.length ? `Differences (${differences.length}): ${differences.join(', ')}` : 'No structural or geometry differences.');
  console.log(`Renderer errors: reference ${report.reference.errors.length}, obsen ${report.obsen.errors.length}`);
} finally { for (const [, c] of clients) c.socket.close(); }
