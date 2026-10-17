import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const formulas = [
  ['inline', 'x^2 + y^2 = z^2'],
  ['fraction', '\\frac{1}{2} + \\sqrt{x}'],
  ['matrix', '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'],
  ['chemistry', '\\ce{SO4^2- + Ba^2+ -> BaSO4 v}'],
  ['color', '\\color{red}{x} + \\cancel{y}'],
  ['extensions', '\\braket{a|b} + \\bbox[2px,border:1px solid blue]{x}'],
  ['package', '\\RequirePackage{cancel}\\cancel{x}'],
];
const markdown = formulas.map(([name, source], index) => `## ${name}\n\n${index === 0 ? '$' + source + '$' : '$$\n' + source + '\n$$'}`).join('\n\n') + '\n';
const output = process.argv[2] ?? 'dist/todo-backup/mathjax-comparison';
await fs.mkdir(output, { recursive: true });
const report = {};
for (const [name, port, prefix] of [['obsen', Number(process.env.OBSEN_SMOKE_PORT ?? 9342), 'obsen-electron-smoke-'], ['reference', Number(process.env.OBSEN_REFERENCE_PORT ?? 9352), 'obsen-reference-audit-']]) {
  if (process.argv.includes('--only=obsen') && name === 'reference') continue;
  const c = await fixtureClient(port, prefix, { separateHistoricalErrors: true });
  try {
    await c.evaluate(`(async () => {
      app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
      const path = 'MathJax audit.md', existing = app.vault.getFileByPath(path);
      const file = existing ? (await app.vault.modify(existing, ${JSON.stringify(markdown)}), existing) : await app.vault.create(path, ${JSON.stringify(markdown)});
      const leaf = app.workspace.getLeaf('tab'); await leaf.openFile(file, { active: true, state: { mode: 'preview' } });
      window.__mathAuditLeaf = leaf;
    })()`);
    await c.wait(`window.__mathAuditLeaf.containerEl.querySelectorAll('.markdown-preview-view .math mjx-container').length === ${formulas.length}`, 'all math formulas rendered');
    await c.evaluate(`document.fonts.ready`);
    await delay(250);
    report[name] = await c.evaluate(`(() => {
      const normalize = el => ({ tag: el.tagName.toLowerCase(), attributes: Object.fromEntries([...el.attributes].filter(a => !['id','aria-labelledby'].includes(a.name)).map(a => [a.name, a.value]).sort()), ...(el.children.length ? { children: [...el.children].map(normalize) } : { text: el.textContent }) });
      return { version: MathJax.version, formulas: [...window.__mathAuditLeaf.containerEl.querySelectorAll('.markdown-preview-view .math mjx-container')].map(normalize), fonts: [...document.fonts].filter(font => font.family.startsWith('MJX')).map(font => ({ family: font.family, status: font.status })), stylesheet: !!document.querySelector('#MJX-CHTML-styles'), sources: performance.getEntriesByType('resource').filter(entry => /mathjax|\\.woff/.test(entry.name)).map(entry => entry.name) };
    })()`);
    report[name].errors = c.errors;
    report[name].historicalErrors = c.historicalErrors;
    await c.capture(output, name + '-mathjax', '.workspace-leaf.mod-active .markdown-preview-view');
    await c.evaluate(`[...window.__mathAuditLeaf.containerEl.querySelectorAll('.markdown-preview-view .math')].forEach((el, index) => el.dataset.mathAuditIndex = String(index))`);
    for (let index = 0; index < formulas.length; index++) {
      const selector = '.workspace-leaf.mod-active .markdown-preview-view .math[data-math-audit-index="' + index + '"] mjx-container';
      await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
      await c.capture(output, name + '-' + formulas[index][0], selector);
    }
    assert.equal(report[name].version, '4.1.3');
    assert.deepEqual(c.errors, []);
    assert.ok(report[name].fonts.some(font => font.status === 'loaded'), 'local MathJax fonts load');
    if (name === 'obsen') assert.ok(report[name].sources.every(url => !/^https?:/.test(url)), 'math resources stay offline');
    if (name === 'obsen') {
    report[name].api = await c.evaluate(`(async () => {
      const api = window.__obsenSmokeApi;
      await api.loadMathJax(); const rendered = api.renderMath('x^2', false); await api.finishRenderMath();
      return { tag: rendered.tagName.toLowerCase(), output: rendered.getAttribute('jax'), styles: !!document.querySelector('#MJX-CHTML-styles') };
    })()`);
    assert.deepEqual(report[name].api, { tag: 'mjx-container', output: 'CHTML', styles: true });
    }
    assert.deepEqual(c.errors, []);
  } finally { c.socket.close(); }
}
await fs.writeFile(output + '/report.json', JSON.stringify(report, null, 2));
if (report.reference) assert.equal(JSON.stringify(report.obsen.formulas) === JSON.stringify(report.reference.formulas), true, 'MathJax output matches pinned reference; see report.json for full trees');
console.log('MathJax audit passed: version, formulas, extensions, fonts, offline resources and output structure.');
