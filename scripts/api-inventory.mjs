import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const declarationPath = path.join(root, "reference", "obsidian.d.ts");
const outputPath = path.join(root, "reference", "obsidian-api-exports.json");
const runtimeBarrelPath = path.join(root, "src", "compat", "obsidian.ts");
const sourceText = await readFile(declarationPath, "utf8");
const source = ts.createSourceFile(declarationPath, sourceText, ts.ScriptTarget.Latest, true);
const runtimeBarrelText = await readFile(runtimeBarrelPath, "utf8");
const runtimeBarrel = ts.createSourceFile(runtimeBarrelPath, runtimeBarrelText, ts.ScriptTarget.Latest, true);
let previous = { declarations: [] };
try {
  previous = JSON.parse(await readFile(outputPath, "utf8"));
} catch {}
const previousByName = new Map(previous.declarations.map((declaration) => [declaration.name, declaration]));
// Treat the compatibility barrel as the source of truth for which official
// declarations have a runtime export. The previous hard-coded list quickly
// went stale as implementations were added across modules.
const runtimeImplementations = new Map();
const typeOnlyRuntimeExports = new Set();
for (const statement of runtimeBarrel.statements) {
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
  const modulePath = statement.moduleSpecifier.text;
  const moduleFile = path.posix.join("src/compat", `${modulePath.replace(/^\.\//, "")}.ts`);
  for (const element of statement.exportClause.elements) {
    const exportedName = element.name.text;
    runtimeImplementations.set(exportedName, moduleFile);
    if (element.isTypeOnly || statement.isTypeOnly) typeOnlyRuntimeExports.add(exportedName);
  }
}

function hasExport(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function getName(node) {
  return node.name?.getText(source).replace(/^['"]|['"]$/g, "") ?? "<anonymous>";
}

function memberInfo(member) {
  return {
    name: getName(member),
    kind: ts.SyntaxKind[member.kind],
    line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1,
  };
}

function declarationInfo(node) {
  const typeOnly = [
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
  ].includes(node.kind);
  const members = node.members?.map(memberInfo) ?? [];
  const enumMembers = node.kind === ts.SyntaxKind.EnumDeclaration
    ? node.members.map(memberInfo)
    : [];

  const name = getName(node);
  const previousEntry = previousByName.get(name);
  return {
    name,
    kind: ts.SyntaxKind[node.kind],
    typeOnly,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    implementation: runtimeImplementations.has(name)
      ? (typeOnly || typeOnlyRuntimeExports.has(name) ? "type-only" : "implemented")
      : previousEntry?.implementation ?? (typeOnly ? "type-only" : "pending"),
    module: runtimeImplementations.get(name) ?? previousEntry?.module ?? null,
    members: [...members, ...enumMembers],
  };
}

const declarations = source.statements
  .filter(hasExport)
  .flatMap((statement) => statement.kind === ts.SyntaxKind.VariableStatement
  ? statement.declarationList.declarations.map((declaration) => {
        const name = getName(declaration);
        const previousEntry = previousByName.get(name);
        return {
        name,
        kind: "VariableDeclaration",
        typeOnly: false,
        line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
        implementation: runtimeImplementations.has(name)
          ? (typeOnlyRuntimeExports.has(name) ? "type-only" : "implemented")
          : previousEntry?.implementation ?? "pending",
        module: runtimeImplementations.get(name) ?? previousEntry?.module ?? null,
        members: [],
        };
      })
    : [declarationInfo(statement)]);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify({
  source: "obsidianmd/obsidian-api",
  ref: "cc1744324150c632416857c98964f87b1574a5fc",
  declaration: "obsidian.d.ts",
  declarations,
}, null, 2) + "\n", "utf8");

process.stdout.write("Wrote " + declarations.length + " exported declarations to " + path.relative(root, outputPath) + "\n");
