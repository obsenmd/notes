import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureClient, delay } from './fixture-client.mjs';

const refPort = Number(process.env.OBSEN_REFERENCE_PORT ?? 9476), ownPort = Number(process.env.OBSEN_SMOKE_PORT ?? 9586);
const manifests = {
  reference: JSON.parse(await fs.readFile(`dist/todo-backup/reference-fixture-${refPort}.json`, 'utf8')),
  obsen: JSON.parse(await fs.readFile(`dist/todo-backup/obsen-luna-settings-recheck-${ownPort}.json`, 'utf8')),
};
const clients = {
  reference: await fixtureClient(refPort, 'obsen-reference-audit-'),
  obsen: await fixtureClient(ownPort, 'obsen-electron-smoke-'),
};
const notePath = 'Luna rapid-close layout probe.md';
const report = { ports: { reference: refPort, obsen: ownPort }, fixtures: {}, notePath, delayBeforeCloseMs: 180 };
for (const name of ['reference', 'obsen']) {
  const client = clients[name], vault = path.join(manifests[name].directory, 'vault'), layoutPath = path.join(vault, '.obsidian', 'workspace.json');
  const baseline = await fs.readFile(layoutPath, 'utf8').catch(() => '');
  const prepared = await client.evaluate(`(async()=>{const a=window.app??window.__obsenSmokeApp,w=a.workspace; let file=a.vault.getFileByPath(${JSON.stringify(notePath)}); if(!file)file=await a.vault.create(${JSON.stringify(notePath)},'Rapid-close layout probe.'); const source=w.activeLeaf; const old=w.getLeavesOfType('markdown').map(l=>l.view.file?.path).filter(Boolean); await source.openFile(a.vault.getFileByPath('Source.md')); const split=w.createLeafBySplit(source,'vertical'); await split.openFile(file); split.setPinned(true); const leaves=[]; w.iterateRootLeaves(l=>{leaves.push({type:l.view.getViewType(),file:l.view.file?.path??null,pinned:l.pinned}); return false}); return {path:file.path,old,leaves}})()`);
  await delay(report.delayBeforeCloseMs);
  await client.send('Page.close').catch(() => undefined);
  client.socket.close();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${name === 'reference' ? refPort : ownPort}/json/list`)).json()).filter(page => page.type === 'page');
      if (!pages.length) break;
      await delay(100);
    }
    catch { break; }
  }
  const saved = await fs.readFile(layoutPath, 'utf8').catch(() => '');
  report.fixtures[name] = { directory: manifests[name].directory, prepared, workspaceFileExisted: !!saved, changedFromBaseline: saved !== baseline, containsProbePath: saved.includes(notePath), baselineBytes: baseline.length, savedBytes: saved.length };
}
const output = 'dist/luna-services/rapid-layout-close-audit.json';
report.pairedResultEqual = report.fixtures.reference.containsProbePath === report.fixtures.obsen.containsProbePath;
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.ok(report.fixtures.reference.prepared.leaves.length >= 2 && report.fixtures.obsen.prepared.leaves.length >= 2, 'both fixtures created a second leaf before closing');
assert.equal(report.pairedResultEqual, true, 'rapid close persisted the same workspace result in both fixtures');
