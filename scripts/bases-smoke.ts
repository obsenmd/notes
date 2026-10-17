import assert from "node:assert/strict";
import { Formula, defaultSummaries } from "../src/renderer/bases/formula";
import { BasesQuery, Entry, QueryContext, ViewData, applySearch, newItemDefaults, summaryContext } from "../src/renderer/bases/query";
import { BooleanValue, ErrorValue, NullValue, NumberValue, ObjectValue, StringValue, wrapValue } from "../src/compat/bases";
import { TFile } from "../src/compat/vault";
import type { App } from "../src/compat/plugin";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeDataAdapter } from "../src/compat/node-adapter";
import { Vault } from "../src/compat/vault";

const ctx = { app: null, getByIdentifier: (name: string) => name === "score" ? new NumberValue(4) : NullValue.value };
const result = (source: string) => new Formula(source).getValue(ctx);
for (const [expression, expected] of [
  ["1 + 2 * 3", "7"], ["(1 + 2) * 3", "9"], ["-score + 10", "6"],
  ['if(score > 3, "pass", badFunction())', "pass"],
  ['[1, 2, 3].map(value * 2).filter(value > 2).join(",")', "4,6"],
  ["[1, 2, 3].reduce(acc + value, 0)", "6"],
  ["[1, 2, 3][-1]", "3"], ['"Hello".lower().slice(0, 2)', "he"],
  ['["x", "x", "y"].unique().length', "2"], ["null == null", "true"],
  ['date("2026-10-10") + "1d"', "2026-10-11"],
] as const) assert.equal(result(expression).toString(), expected, expression);
assert.ok(result('number("nope")') instanceof ErrorValue);
assert.ok(result("missingFunction(1)") instanceof ErrorValue);
assert.ok(result("[1].map(value, value)") instanceof ErrorValue);
assert.ok(new Formula("(").isInvalid);
assert.equal(new Formula("false && missingFunction()").test(ctx), false);
assert.equal(new Formula("true || missingFunction()").test(ctx), true);
const objectContext = { app: null, getByIdentifier: () => new ObjectValue({ one: 1, two: 2 }) };
assert.equal(new Formula('obj.map(value + 1).sum()').getValue(objectContext).toString(), "5");

const files = ["Alpha.md", "Beta.md", "Gamma.md"].map(name => new TFile({} as never, name));
const frontmatter = new Map(files.map((file, i) => [file, { Status: i === 1 ? "done" : "todo", score: [2, 8, 4][i], done: i === 1 }]));
const app = { metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file) }) } } as unknown as App;
const query = BasesQuery.fromString(`filters:\n  and:\n    - 'status == "todo"'\n    - 'score >= 2'\nformulas:\n  doubled: score * 2\nproperties:\n  score:\n    displayName: Points\n    custom: retained\nviews:\n  - type: table\n    name: Table\n    order: [file.name, score, formula.doubled]\n    sort:\n      - property: score\n        direction: DESC\n    groupBy:\n      property: Status\n      direction: ASC\n    summaries:\n      score: Sum\n    columnSize:\n      score: 150\n  - type: cards\n    name: Cards\ncustom: retained\n`);
const context = new QueryContext(app, query.filters ?? null, query.formulas, null);
const formulaView = { controller: { app, getCurrentFile: () => null } };
query.views[0]!.data.expression = "1 + 2";
assert.equal(query.views[0]!.getEvaluatedFormula(formulaView, "expression").toString(), "3", "literal view formulas evaluate without a current file");
query.views[0]!.data.expression = "this.name";
assert.equal(query.views[0]!.getEvaluatedFormula(formulaView, "expression"), NullValue.value, "view formulas do not read another active file when their local file is absent");
delete query.views[0]!.data.expression;
const entries = files.map(file => new Entry(context, file)).filter(entry => query.filters!.test(entry));
assert.equal(entries.length, 2);
const data = new ViewData(app, query.views[0]!, ["file.name", "note.score", "formula.doubled"], entries);
assert.deepEqual(data.data.map(entry => entry.file.path), ["Gamma.md", "Alpha.md"]);
assert.equal(data.data[0]!.getValue("formula.doubled")?.toString(), "8");
assert.equal(data.groupedData.length, 1);
assert.equal(data.getSummaryValue(query, entries, "note.score", "Sum").toString(), "6");
query.views[0]!.groupOrder = ["todo", "empty group"];
const manualData = new ViewData(app, query.views[0]!, ["file.name", "note.score"], [...entries]);
assert.deepEqual(manualData.groupedData.map(group => [group.key?.toString(), group.entries.length]), [["todo", 2], ["empty group", 0]], "manual groups retain order and empty values");
query.views[0]!.groupOrder = [];
assert.equal(new ViewData(app, query.views[0]!, ["file.name"], [...entries]).groupedData.length, 0, "manual grouping can hide every group");
query.views[0]!.groupOrder = null;
assert.equal(applySearch(entries, "alpha", ["file.name"]).length, 1);
assert.equal(query.getPropertyConfig("note.score").getDisplayName(), "Points");
const roundtrip = BasesQuery.fromString(query.toString());
assert.equal(roundtrip.extra.custom, "retained");
assert.equal(roundtrip.views[0]!.get("columnSize") && (roundtrip.views[0]!.get("columnSize") as Record<string, number>).score, 150);
assert.equal(roundtrip.getPropertyConfig("note.score").extra.custom, "retained");
assert.deepEqual(BasesQuery.fromString("").views.map(view => view.type), ["table"]);
assert.throws(() => BasesQuery.fromString("views: not-an-array"));
assert.throws(() => BasesQuery.fromString("filters: []"));
query.renameFormula("doubled", "twice");
assert.ok(query.views[0]!.getOrder().includes("formula.twice"));
query.removeFormula("twice");
assert.ok(!query.views[0]!.getOrder().includes("formula.twice"));
query.setSummaryFormula("Half", new Formula("values.sum() / 2"));
query.views[0]!.setSummaryKey("note.score", "Half");
query.views[1]!.setSummaryKey("note.score", "Half");
query.renameSummaryFormula("Half", "Renamed");
assert.ok(query.summaryFormulas?.Renamed);
assert.equal(query.views[1]!.getSummaryKey("note.score"), "Renamed", "summary rename updates references in every view");
query.deleteSummaryFormula("Renamed");
assert.equal(query.views[0]!.getSummaryKey("note.score"), null);
assert.equal(query.views[1]!.getSummaryKey("note.score"), null);

const loop = new QueryContext(app, null, { a: new Formula("formula.b"), b: new Formula("formula.a") }, null);
assert.ok(new Entry(loop, files[0]!).getValue("formula.a") instanceof ErrorValue);
for (const sample of [new NumberValue(2), new BooleanValue(true), new StringValue("x")]) {
  const values = [sample, NullValue.value];
  const summaries = defaultSummaries(sample);
  for (const [name, source] of Object.entries(summaries)) assert.ok(!(new Formula(source).getValue(summaryContext(app, values)) instanceof ErrorValue), name);
}
console.log("Bases formulas, filters, sorting, grouping, summaries, search, YAML round trips and circular formulas passed.");

void (async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsen-bases-vault-"));
  try {
    await fs.mkdir(path.join(dir, ".obsidian"));
    await fs.mkdir(path.join(dir, ".trash"));
    await fs.writeFile(path.join(dir, "Note.md"), "");
    await fs.writeFile(path.join(dir, "View.base"), "");
    await fs.mkdir(path.join(dir, "Notes"));
    await fs.writeFile(path.join(dir, "Notes/Nested.md"), "");
    await fs.writeFile(path.join(dir, ".obsidian/app.json"), "{}");
    await fs.writeFile(path.join(dir, ".trash/Deleted.md"), "");
    const adapter = new NodeDataAdapter(dir), vault = new Vault(adapter);
    await vault.initialize();
    assert.deepEqual(vault.getFiles().map(file => file.path).sort(), ["Note.md", "Notes/Nested.md", "View.base"]);
    assert.equal(vault.getRoot().path, "/");
    assert.equal(vault.getFolderByPath("/"), vault.getRoot());
    assert.equal(vault.getFolderByPath(""), null);
    assert.equal(vault.getFolderByPath("Notes/"), null, "public vault lookup requires the exact normalized path");
    assert.deepEqual(await adapter.list("Notes"), { files: ["Notes/Nested.md"], folders: [] }, "adapter listing returns vault-relative paths");
    assert.ok((await adapter.list("/")).folders.includes("Notes"), "root slash is resolved inside the vault");
    assert.equal(vault.getAbstractFileByPath(".obsidian"), null);
    assert.equal(await adapter.read(".obsidian/app.json"), "{}", "config remains accessible to the host through the adapter");
    await vault.refresh();
    assert.equal(vault.getFiles().length, 3);
    console.log("Bases query inputs exclude configuration and trash files.");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
