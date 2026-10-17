import { createFsFromVolume, Volume } from "memfs";
import { Buffer } from "node:buffer";
import path from "node:path";

export interface FileEntry { data: string | null; mtime: number }
export type FileSnapshot = Record<string, FileEntry>;
export interface FileChange { path: string; entry?: FileEntry }
const volume = new Volume();
const memory = createFsFromVolume(volume);
let changed: () => void | Promise<unknown> = () => {};
let restoring = false;
export function onFilesystemChange(listener: () => void | Promise<unknown>): void { changed = listener; }
const mutations = new Set(["writeFile", "appendFile", "mkdir", "rmdir", "rm", "rename", "unlink", "copyFile", "cp", "utimes", "chmod", "truncate", "symlink", "link"]);

// Keep Node's synchronous and asynchronous filesystem APIs for existing plugins.
// Persistence happens in the worker after a successful mutation.
function observe<T extends object>(api: T, synchronous: boolean): T {
  return new Proxy(api, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      const operation = synchronous ? property.replace(/Sync$/, "") : property;
      if (!mutations.has(operation)) return value.bind(object);
      return (...args: unknown[]) => {
        const callback = args[args.length - 1];
        if (synchronous && !property.endsWith("Sync") && typeof callback === "function") {
          args[args.length - 1] = (error: unknown, ...result: unknown[]) => {
            if (error || restoring) callback(error, ...result);
            else Promise.resolve(changed()).then(() => callback(null, ...result), cause => callback(cause));
          };
        }
        const result = value.apply(object, args);
        if (result instanceof Promise) return result.then(async value => { if (!restoring) await changed(); return value; });
        if (!restoring && property.endsWith("Sync")) void changed();
        return result;
      };
    },
  });
}
const promises = observe(memory.promises, false);
export const fs = observe(new Proxy(memory, { get(object, key) { return key === "promises" ? promises : Reflect.get(object, key); } }), true) as unknown as typeof import("node:fs");
export const fsp = promises as unknown as typeof import("node:fs/promises");

export function snapshotFiles(): FileSnapshot {
  const result: FileSnapshot = {};
  const walk = (directory: string) => {
    for (const name of memory.readdirSync(directory) as string[]) {
      const filename = path.join(directory, name), stat = memory.statSync(filename);
      if (filename === "/app") continue;
      if (stat.isDirectory()) { result[filename] = { data: null, mtime: stat.mtimeMs as number }; walk(filename); }
      else if (stat.isFile()) result[filename] = { data: Buffer.from(memory.readFileSync(filename) as Uint8Array).toString("base64"), mtime: stat.mtimeMs as number };
    }
  };
  walk("/");
  return result;
}
export function sameEntry(a?: FileEntry, b?: FileEntry): boolean { return a?.data === b?.data && a?.mtime === b?.mtime; }
export function diffFiles(before: FileSnapshot, after: FileSnapshot): FileChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !sameEntry(before[key], after[key])).map(key => ({ path: key, entry: after[key] }));
}
export function applyFiles(changes: FileChange[]): void {
  restoring = true;
  try {
    // External changes can replace a file with a directory, or vice versa.
    // Remove the old node before installing the new entry and its children.
    for (const change of changes.filter(change => change.entry)) {
      if (memory.existsSync(change.path) && memory.statSync(change.path).isDirectory() !== (change.entry!.data === null)) {
        memory.rmSync(change.path, { recursive: true, force: true });
      }
    }
    for (const change of changes.filter(change => !change.entry).sort((a, b) => b.path.length - a.path.length)) {
      if (memory.existsSync(change.path)) memory.rmSync(change.path, { recursive: true, force: true });
    }
    for (const { path: filename, entry } of changes.filter(change => change.entry).sort((a, b) => a.path.length - b.path.length)) {
      if (!filename.startsWith("/") || filename.includes("\0")) throw new Error("Invalid browser filesystem path");
      if (entry!.data === null) memory.mkdirSync(filename, { recursive: true });
      else {
        memory.mkdirSync(path.dirname(filename), { recursive: true });
        memory.writeFileSync(filename, Buffer.from(entry!.data, "base64"));
      }
      if (entry!.data !== null) memory.utimesSync(filename, new Date(entry!.mtime), new Date(entry!.mtime));
    }
    // Creating children changes their parent's mtime in memfs. Restore folder
    // times last so the next flush does not mistake a disk scan for an edit.
    for (const { path: filename, entry } of changes.filter(change => change.entry?.data === null).sort((a, b) => b.path.length - a.path.length)) {
      memory.utimesSync(filename, new Date(entry!.mtime), new Date(entry!.mtime));
    }
  } finally { restoring = false; }
}
