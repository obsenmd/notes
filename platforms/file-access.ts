/// <reference types="wicg-file-system-access" />
import { FsaNodeFs } from "@jsonjoy.com/fs-fsa-to-node";
import { get, set, createStore } from "idb-keyval";
import { Buffer } from "node:buffer";
import path from "node:path";
import { applyFiles, diffFiles, sameEntry, snapshotFiles, type FileSnapshot } from "./web-filesystem";

export interface FileMount { path: string; handle: FileSystemDirectoryHandle | FileSystemFileHandle }
const store = createStore("obsen-platform", "filesystem");
const mounts = new Map<string, FileMount>();
const adapters = new Map<string, FsaNodeFs>();
let disk: FileSnapshot = {};
let operations: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation);
  operations = result.catch(() => undefined);
  return result;
}
const contains = (root: string, filename: string) => root === "/" || filename === root || filename.startsWith(root + "/");
const owner = (filename: string) => [...mounts.values()].filter(mount => contains(mount.path, filename)).sort((a, b) => b.path.length - a.path.length)[0];
export const mountedHandles = (): FileMount[] => [...mounts.values()].filter(mount => mount.path !== "/");

function attach(mount: FileMount): void {
  mounts.set(mount.path, mount);
  if (mount.handle.kind === "directory") adapters.set(mount.path, new FsaNodeFs(mount.handle as unknown as ConstructorParameters<typeof FsaNodeFs>[0]));
}
async function scan(mount: FileMount): Promise<FileSnapshot> {
  const found: FileSnapshot = {};
  if (mount.handle.kind === "file") {
    const file = await mount.handle.getFile();
    found[mount.path] = { data: Buffer.from(await file.arrayBuffer()).toString("base64"), mtime: file.lastModified };
  } else {
    const visit = async (handle: FileSystemDirectoryHandle, relative: string) => {
      const absolute = path.join(mount.path, relative);
      if (owner(absolute)?.path !== mount.path || absolute === "/app") return;
      if (absolute !== "/") found[absolute] = { data: null, mtime: disk[absolute]?.mtime ?? 0 };
      for await (const [name, child] of handle.entries()) {
        const childRelative = path.join(relative, name), filename = path.join(mount.path, childRelative);
        if (owner(filename)?.path !== mount.path || filename === "/app") continue;
        if (child.kind === "directory") await visit(child, childRelative);
        else {
          const file = await child.getFile();
          const previous = disk[filename];
          // Reuse bytes when the disk file has not changed.
          found[filename] = previous && previous.mtime === file.lastModified ? previous : { data: Buffer.from(await file.arrayBuffer()).toString("base64"), mtime: file.lastModified };
        }
      }
    };
    await visit(mount.handle, "");
  }
  return found;
}
async function initialize(): Promise<void> {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("obsen", { create: true });
  attach({ path: "/", handle: root });
  const saved = await get<FileMount[]>("mounts", store) ?? [];
  for (const mount of saved) attach(mount);
  for (const mount of mounts.values()) {
    if (mount.path !== "/" && await mount.handle.queryPermission({ mode: "readwrite" }) !== "granted") continue;
    Object.assign(disk, await scan(mount));
  }
  // Migrate the earlier IndexedDB prototype once; selected folders subsequently
  // use their handles and settings live in the origin-private filesystem.
  const legacy = await get<FileSnapshot>("files", store);
  applyFiles(diffFiles({}, { ...legacy, ...disk }));
  await flush();
  await set("files", undefined, store);
}
async function mountHandle(handle: FileMount["handle"], requestedPath?: string): Promise<string> {
  await flush();
  const before = snapshotFiles();
  let existing: FileMount | undefined;
  for (const mount of mounts.values()) if (mount.path !== "/" && await handle.isSameEntry(mount.handle)) { existing = mount; break; }
  const filename = requestedPath ?? existing?.path ?? path.join(handle.kind === "directory" ? "/vaults" : "/exports", crypto.randomUUID(), handle.name);
  const mount = { path: filename, handle };
  if (handle.kind === "directory") {
    for (const child of mountedHandles()) {
      if (child.path === filename || !contains(filename, child.path)) continue;
      const relative = await handle.resolve(child.handle);
      if (relative?.join("/") === path.relative(filename, child.path)) { mounts.delete(child.path); adapters.delete(child.path); }
    }
  }
  attach(mount);
  const files = await scan(mount);
  const previous = Object.fromEntries(Object.entries(disk).filter(([entry]) => owner(entry)?.path === filename));
  for (let parent = path.dirname(filename); parent !== "/"; parent = path.dirname(parent)) {
    files[parent] ??= disk[parent] ?? { data: null, mtime: 0 };
    if (disk[parent]) previous[parent] = disk[parent];
  }
  acceptDiskChanges(previous, files, before);
  await set("mounts", mountedHandles(), store);
  return filename;
}
async function flush(): Promise<void> {
  const current = snapshotFiles(), changes = diffFiles(disk, current);
  const replacedDirectories = changes.filter(change => disk[change.path]?.data === null && change.entry?.data !== null && change.entry?.data !== undefined).map(change => change.path);
  for (const mount of mountedHandles()) {
    if (disk[mount.path] && !current[mount.path]) throw new DOMException("Select the parent folder before moving a mounted directory", "NotAllowedError");
  }
  // Finish file writes before removals, so a rename never discards its source
  // after an unsuccessful destination write.
  const writes = changes.filter(change => change.entry).sort((a, b) => a.path.length - b.path.length);
  for (const change of writes) {
    const mount = owner(change.path);
    if (!mount) continue;
    const entry = change.entry!;
    if (mount.handle.kind === "file") {
      if (entry.data !== null && disk[change.path]?.data !== entry.data) {
        const writable = await mount.handle.createWritable(); await writable.write(new Uint8Array(Buffer.from(entry.data, "base64"))); await writable.close();
      }
    } else {
      const relative = path.relative(mount.path, change.path);
      if (!relative) continue;
      const api = adapters.get(mount.path)!.promises;
      if (disk[change.path] && (disk[change.path].data === null) !== (entry.data === null)) await api.rm(relative, { recursive: true, force: true });
      if (entry.data === null) {
        if (disk[change.path]?.data !== null) await api.mkdir(relative, { recursive: true });
      }
      else if (disk[change.path]?.data !== entry.data) {
        if (path.dirname(relative) !== ".") await api.mkdir(path.dirname(relative), { recursive: true });
        await api.writeFile(relative, Buffer.from(entry.data, "base64"));
      }
    }
    disk[change.path] = entry;
  }
  for (const change of changes.filter(change => !change.entry).sort((a, b) => b.path.length - a.path.length)) {
    const mount = owner(change.path);
    if (mount?.handle.kind === "directory" && !replacedDirectories.some(directory => change.path.startsWith(directory + "/"))) {
      const relative = path.relative(mount.path, change.path);
      if (relative) await adapters.get(mount.path)!.promises.rm(relative, { recursive: true, force: true });
    }
    delete disk[change.path];
  }
}
function acceptDiskChanges(previous: FileSnapshot, files: FileSnapshot, before: FileSnapshot): void {
  const changes = diffFiles(previous, files), current = snapshotFiles();
  // Filesystem scans yield to other worker activity. Keep edits made during a
  // scan in memory; the next flush will save them against the new disk state.
  applyFiles(changes.filter(change => {
    if (!sameEntry(current[change.path], before[change.path])) return false;
    const removesChildren = !change.entry || previous[change.path]?.data === null && change.entry.data !== null;
    return !removesChildren || !Object.keys(current).some(filename => contains(change.path, filename) && !sameEntry(current[filename], before[filename]));
  }));
  for (const change of changes) { if (change.entry) disk[change.path] = change.entry; else delete disk[change.path]; }
}
async function refresh(): Promise<boolean> {
  const before = snapshotFiles();
  await flush();
  for (const mount of mounts.values()) {
    if (mount.path !== "/" && await mount.handle.queryPermission({ mode: "readwrite" }) !== "granted") continue;
    const files = await scan(mount);
    const previous = Object.fromEntries(Object.entries(disk).filter(([filename]) => owner(filename)?.path === mount.path));
    acceptDiskChanges(previous, files, before);
  }
  return diffFiles(before, snapshotFiles()).length > 0;
}

// Mount requests can arrive while a main handler awaits a file picker. Keep
// their disk operations ordered independently of the main-handler RPC queue.
export function initializeFileAccess(): Promise<void> { return serialize(initialize); }
export function mountFileAccess(handle: FileMount["handle"], requestedPath?: string): Promise<string> { return serialize(() => mountHandle(handle, requestedPath)); }
export function flushFileAccess(): Promise<void> { return serialize(flush); }
export function refreshFileAccess(): Promise<boolean> { return serialize(refresh); }
