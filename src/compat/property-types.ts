import type { App } from "./plugin";

const pending = new WeakMap<App, Promise<void>>();
const file = (app: App) => `${app.vault.configDir}/types.json`;
async function readData(app: App): Promise<Record<string, unknown>> {
  try { const data = JSON.parse(await app.vault.adapter.read(file(app))) as unknown; return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {}; }
  catch { return {}; }
}
function typesOf(data: Record<string, unknown>): Record<string, string> {
  const types = data.types;
  return types && typeof types === "object" && !Array.isArray(types) ? Object.fromEntries(Object.entries(types).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
}
export async function readPropertyTypes(app: App): Promise<Record<string, string>> { return typesOf(await readData(app)); }
function enqueue(app: App, update: (types: Record<string, string>) => Record<string, string>): Promise<void> {
  const task = (pending.get(app) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const data = await readData(app), next = update(typesOf(data));
    await app.vault.adapter.write(file(app), JSON.stringify({ ...data, types: next }, null, 2));
    app.workspace.trigger("property-types-change", next);
  });
  pending.set(app, task); return task;
}
export function writePropertyTypes(app: App, types: Record<string, string>): Promise<void> { return enqueue(app, () => ({ ...types })); }
export function assignPropertyType(app: App, key: string, type: string): Promise<void> {
  return enqueue(app, types => { const existing = Object.keys(types).find(name => name.toLowerCase() === key.toLowerCase()); return { ...types, [existing ?? key]: type }; });
}
