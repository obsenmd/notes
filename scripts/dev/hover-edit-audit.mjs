import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixtureClient, delay } from './fixture-client.mjs';

const c = await fixtureClient(Number(process.env.OBSEN_SMOKE_PORT ?? 9342), 'obsen-electron-smoke-', { separateHistoricalErrors: true });
const report = { historicalErrors: c.historicalErrors };
const originalUseTab = await c.evaluate(`app.vault.getConfig('useTab')`);
try {
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.evaluate(`(async () => {
    if (!app.vault.getFolderByPath('Hover edit audit')) await app.vault.createFolder('Hover edit audit');
    for (const [name, text] of Object.entries(${JSON.stringify({
      'Whole.md': '---\r\nstatus: draft\r\n---\r\nOriginal body.\r\n',
      'Heading.md': 'Intro remains.\n\n## Section\n\nOriginal section.\n\n## Later\n\nLater remains.\n',
      'Blocks.md': 'Intro remains.\n\nOriginal paragraph. ^paragraph\n\n- Parent\n    - Nested item. ^nested\n        continuation\n    - Sibling remains.\n\n```js\nconst original = 1;\n```\n^code\n\nTail remains.\n',
      'Footnotes.md': 'Intro remains.[^note]\n\n[^note]: Original footnote.\n    Continuation.\n\nTail remains.\n',
      'Parent.md': 'Parent text remains.\n',
      'Commands.md': 'Command selection.\n',
    })})) {
      const path = 'Hover edit audit/' + name, file = app.vault.getFileByPath(path);
      if (file) await app.vault.modify(file, text); else await app.vault.create(path, text);
    }
    getSelection()?.removeAllRanges();
    window.__hoverEditTarget = document.createElement('a');
    window.__hoverEditTarget.textContent = 'Hover test target';
    window.__hoverEditTarget.style.cssText = 'position:absolute;top:250px;left:500px';
    document.body.append(window.__hoverEditTarget);
  })()`);
  const open = async (link, state) => {
    await c.evaluate(`(() => {
      window.__hoverEditParent = { hoverPopover: null };
      app.workspace.trigger('hover-link', { event: new MouseEvent('mouseover', { view: window, clientX: 510, clientY: 260 }), source: 'preview', hoverParent: window.__hoverEditParent, targetEl: window.__hoverEditTarget, linktext: ${JSON.stringify(link)}, sourcePath: '', state: ${JSON.stringify(state)} });
    })()`);
    await c.wait(`!!document.querySelector('.hover-popover .markdown-preview-view')`, 'hover preview');
  };
  const replace = async (text, dismiss = true) => {
    await c.wait(`!!document.querySelector('.hover-popover .cm-content')`, 'hover editor');
    await c.key('a', 'KeyA', { modifiers: 2, windowsVirtualKeyCode: 65 });
    await c.send('Input.insertText', { text });
    await delay(100);
    assert.equal(await c.evaluate(`window.__hoverEditParent.hoverPopover.isFocused`), true);
    if (dismiss) {
      await c.key('Escape');
      await c.wait(`!document.querySelector('.hover-popover')`, 'hover dismissed');
    }
  };
  await open('Hover edit audit/Whole.md');
  await c.evaluate(`(() => { const p = document.querySelector('.hover-popover .el-p p'); const r = p.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, button: 0, clientX: r.x + 10, clientY: r.y + 5 })); })()`);
  await replace('---\nstatus: done\n---\nChanged body.\n', false);
  const whole = '---\r\nstatus: done\r\n---\r\nChanged body.\r\n';
  await c.wait(`app.vault.read(app.vault.getFileByPath('Hover edit audit/Whole.md')).then(text => text === ${JSON.stringify(whole)})`, 'whole-note disk save');
  report.whole = await c.evaluate(`app.vault.read(app.vault.getFileByPath('Hover edit audit/Whole.md'))`);
  assert.equal(await c.evaluate(`!!document.querySelector('.hover-popover.is-editing')`), true, 'autosave keeps the editor open');
  await c.key('Escape');
  await c.wait(`!document.querySelector('.hover-popover')`, 'whole hover dismissed');
  await open('Hover edit audit/Heading.md#Section', { mode: 'source' });
  await c.wait(`!!document.querySelector('.hover-popover .cm-content')`, 'heading editor opened');
  await c.evaluate(`app.vault.process(app.vault.getFileByPath('Hover edit audit/Heading.md'), text => text.replace('Intro remains.', ${JSON.stringify('Intro remains.\nExternal intro.')}))`);
  await replace('\nChanged section.\n\n');
  const heading = 'Intro remains.\nExternal intro.\n\n## Section\n\nChanged section.\n\n## Later\n\nLater remains.\n';
  await c.wait(`app.vault.read(app.vault.getFileByPath('Hover edit audit/Heading.md')).then(text => text === ${JSON.stringify(heading)})`, 'heading disk save');
  report.heading = await c.evaluate(`app.vault.read(app.vault.getFileByPath('Hover edit audit/Heading.md'))`);
  const editExcerpt = async (file, subpath, initial, replacement, expected) => {
    await open('Hover edit audit/' + file + subpath, { mode: 'source' });
    await c.wait(`!!document.querySelector('.hover-popover .cm-content')`, 'excerpt editor opened');
    const value = await c.evaluate(`document.querySelector('.hover-popover .cm-content').textContent`);
    assert.equal(value, initial.replaceAll('\n', ''), 'editable excerpt keeps the reference source, including inline block IDs');
    await replace(replacement);
    const path = 'Hover edit audit/' + file;
    await c.wait(`app.vault.read(app.vault.getFileByPath(${JSON.stringify(path)})).then(text => text === ${JSON.stringify(expected)})`, 'excerpt disk save');
    report[subpath] = await c.evaluate(`app.vault.read(app.vault.getFileByPath(${JSON.stringify(path)}))`);
  };
  let blocks = 'Intro remains.\n\nChanged paragraph. ^paragraph\n\n- Parent\n    - Nested item. ^nested\n        continuation\n    - Sibling remains.\n\n```js\nconst original = 1;\n```\n^code\n\nTail remains.\n';
  await editExcerpt('Blocks.md', '#^paragraph', 'Original paragraph. ^paragraph', 'Changed paragraph. ^paragraph', blocks);
  blocks = blocks.replace('    - Nested item. ^nested\n        continuation', '    - Changed nested. ^nested\n        changed continuation');
  await editExcerpt('Blocks.md', '#^nested', '- Nested item. ^nested\n    continuation', '- Changed nested. ^nested\n    changed continuation', blocks);
  blocks = blocks.replace('const original = 1;', 'const changed = 2;');
  await editExcerpt('Blocks.md', '#^code', '```js\nconst original = 1;\n```', '```js\nconst changed = 2;\n```', blocks);
  await c.evaluate(`app.vault.setConfig('useTab', false)`);
  await editExcerpt('Footnotes.md', '#[^note]', 'Original footnote.\nContinuation.', 'Changed footnote.\nChanged continuation.', 'Intro remains.[^note]\n\n[^note]: Changed footnote.\n    Changed continuation.\n\nTail remains.\n');
  await c.evaluate(`app.vault.setConfig('useTab', true)`);
  await editExcerpt('Footnotes.md', '#[^note]', 'Changed footnote.\nChanged continuation.', 'Tab footnote.\nTab continuation.', 'Intro remains.[^note]\n\n[^note]: Tab footnote.\n\tTab continuation.\n\nTail remains.\n');
  await c.evaluate(`(async () => {
    const parent = app.workspace.getLeaf('tab');
    await parent.openFile(app.vault.getFileByPath('Hover edit audit/Parent.md'), { active: true, state: { mode: 'source' } });
    window.__hoverParentLeaf = parent;
    window.__hoverEditorChanges = [];
    window.__hoverChangeRef = app.workspace.on('editor-change', (editor, info) => window.__hoverEditorChanges.push({ file: info.file?.path, text: editor.getValue() }));
    window.__hoverMenuRef = app.workspace.on('editor-menu', (menu, editor, info) => { window.__hoverMenuInfo = { file: info.file?.path, sameEditor: info.editor === editor }; });
    app.commands.add({ id: 'hover-edit-audit:plugin', name: 'Hover edit audit', editorCallback: (editor, info) => { window.__hoverCommandInfo = { file: info.file.path, sameEditor: info.editor === editor }; editor.replaceSelection('Plugin edit.'); } });
  })()`);
  await open('Hover edit audit/Commands.md', { mode: 'source' });
  await c.wait(`!!document.querySelector('.hover-popover .cm-content')`, 'command hover editor');
  report.commandContext = await c.evaluate(`(() => {
    const info = app.workspace.activeEditor;
    info.editor.setSelection({line: 0, ch: 0}, {line: 0, ch: 7});
    const ran = app.commands.executeCommandById('editor:toggle-bold');
    return { file: app.workspace.getActiveFile().path, ran, text: info.editor.getValue(), parentText: window.__hoverParentLeaf.view.editor.getValue() };
  })()`);
  assert.deepEqual(report.commandContext, { file: 'Hover edit audit/Commands.md', ran: true, text: '**Command** selection.\n', parentText: 'Parent text remains.\n' });
  report.editorFields = await c.evaluate(`(() => {
    const api = window.__obsenSmokeApi, info = app.workspace.activeEditor, state = info.editor.cm.state;
    return { info: state.field(api.editorInfoField) === info, alias: state.field(api.editorViewField) === info, view: state.field(api.editorEditorField) === info.editor.cm, livePreview: state.field(api.editorLivePreviewField), pluginExtension: state.field(window.__obsenSmokeEditorField) };
  })()`);
  assert.deepEqual(report.editorFields, { info: true, alias: true, view: true, livePreview: true, pluginExtension: true });
  assert.deepEqual(await c.evaluate(`(() => {
    const api = window.__obsenSmokeApi, field = window.__obsenSmokeEditorField.constructor.define({ create: () => 'added', update: value => value });
    const plugin = new api.Plugin(app, { id: 'hover-edit-extension', name: 'Hover extension audit', version: '1', author: 'Test', minAppVersion: '0' });
    plugin.load(); plugin.registerEditorExtension(field);
    const added = app.workspace.activeEditor.editor.cm.state.field(field, false);
    plugin.unload();
    return { added, removed: app.workspace.activeEditor.editor.cm.state.field(field, false) === undefined };
  })()`), { added: 'added', removed: true }, 'plugin extensions update and unload inside an open hover');
  await c.key('b', 'KeyB', { modifiers: 2, windowsVirtualKeyCode: 66 });
  assert.equal(await c.evaluate(`app.workspace.activeEditor.editor.getValue()`), '**Command** selection.\n', 'format hotkey targets hover');
  assert.equal(await c.evaluate(`app.commands.executeCommandById('editor:toggle-bold')`), true);
  assert.equal(await c.evaluate(`app.commands.executeCommandById('hover-edit-audit:plugin')`), true);
  assert.deepEqual(await c.evaluate(`window.__hoverCommandInfo`), { file: 'Hover edit audit/Commands.md', sameEditor: true });
  assert.equal(await c.evaluate(`app.commands.executeCommandById('editor:save-file')`), true);
  await c.wait(`app.vault.read(app.vault.getFileByPath('Hover edit audit/Commands.md')).then(text => text === 'Plugin edit. selection.\\n')`, 'save command writes hover while open');
  assert.equal(await c.evaluate(`app.commands.executeCommandById('editor:context-menu')`), true);
  await c.wait(`!!document.querySelector('.menu')`, 'hover editor menu');
  assert.deepEqual(await c.evaluate(`window.__hoverMenuInfo`), { file: 'Hover edit audit/Commands.md', sameEditor: true });
  await c.key('Escape');
  assert.equal(await c.evaluate(`!!document.querySelector('.hover-popover')`), true, 'menu Escape preserves hover');
  assert.equal(await c.evaluate(`app.commands.executeCommandById('editor:open-search')`), true);
  await c.wait(`!!document.querySelector('.hover-popover .document-search-input')`, 'hover document search');
  await c.key('Escape');
  assert.equal(await c.evaluate(`!!document.querySelector('.hover-popover')`), true, 'search Escape preserves hover');
  await c.key('Escape');
  await c.wait(`!document.querySelector('.hover-popover')`, 'command hover dismissed');
  await c.wait(`app.vault.read(app.vault.getFileByPath('Hover edit audit/Commands.md')).then(text => text === 'Plugin edit. selection.\\n')`, 'plugin edit disk save');
  assert.equal(await c.evaluate(`app.getCommandContext().editor === window.__hoverParentLeaf.view.editor`), true, 'closing hover restores parent commands');
  assert.equal(await c.evaluate(`window.__hoverEditorChanges.some(change => change.file === 'Hover edit audit/Commands.md' && change.text.includes('Plugin edit.'))`), true, 'plugin editor-change context');
  await open('Hover edit audit/Commands.md', { mode: 'source' });
  await c.wait(`!!document.querySelector('.hover-popover .cm-content')`, 'hover reopened');
  assert.equal(await c.evaluate(`(() => { app.workspace.setActiveLeaf(window.__hoverParentLeaf); window.__hoverParentLeaf.view.editor.focus(); return app.getCommandContext().editor === window.__hoverParentLeaf.view.editor; })()`), true, 'leaf activation clears hover command context');
  await c.evaluate(`document.querySelector('.hover-popover .cm-content').focus()`);
  await c.wait(`app.getCommandContext().view?.hoverPopover === window.__hoverEditParent.hoverPopover`, 'hover focus reactivates editor context');
  await c.key('Escape');
  await c.wait(`!document.querySelector('.hover-popover')`, 'reopened hover dismissed');
  assert.deepEqual(c.errors, []);
  await fs.writeFile('dist/todo-backup/hover-edit-report.json', JSON.stringify(report, null, 2));
  console.log('Hover edit audit passed: excerpt saves, CRLF/autosave, core/plugin commands, hotkey/save routing, editor fields/events, menu/search Escape and context restoration.');
} finally {
  await c.evaluate(`(() => { app.commands.remove('hover-edit-audit:plugin'); if (window.__hoverChangeRef) app.workspace.offref(window.__hoverChangeRef); if (window.__hoverMenuRef) app.workspace.offref(window.__hoverMenuRef); })()`).catch(() => undefined);
  await c.evaluate(`app.vault.setConfig('useTab', ${JSON.stringify(originalUseTab) ?? 'undefined'})`).catch(() => undefined);
  await c.evaluate(`(() => { window.__hoverEditParent?.hoverPopover?.hide(); window.__hoverEditTarget?.remove(); })()`).catch(() => undefined);
  c.socket.close();
}
