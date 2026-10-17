import { fsp as fs, path, pathToFileURL, resourcePath, resourceFilePath, process } from "../../platforms/platform";
import { t } from "../i18n";



import type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from "./vault";

/** A filesystem-backed adapter whose paths are always relative to one vault root. */
export class NodeDataAdapter implements DataAdapter {
  readonly basePath: string;
  private readonly processQueues = new Map<string, Promise<void>>();

  constructor(basePath: string, private readonly adapterName = path.basename(path.resolve(basePath))) {
    this.basePath = path.resolve(basePath);
  }

  getName(): string { return this.adapterName || this.basePath; }
  getBasePath(): string { return this.basePath; }
  getFullPath(vaultPath: string): string { return this.resolve(vaultPath); }
  getFilePath(vaultPath: string): string { return pathToFileURL(this.resolve(vaultPath)).toString(); }

  async exists(vaultPath: string, sensitive = true): Promise<boolean> {
    const absolute = this.resolve(vaultPath);
    if (sensitive) {
      try { await fs.access(absolute); return true; }
      catch (error) { if (isMissing(error)) return false; throw error; }
    }
    const parent = path.dirname(absolute);
    const name = path.basename(absolute).toLocaleLowerCase();
    try {
      const entries = await fs.readdir(parent);
      return entries.some(entry => entry.toLocaleLowerCase() === name);
    } catch (error) { if (isMissing(error)) return false; throw error; }
  }

  async stat(vaultPath: string): Promise<Stat | null> {
    try {
      const value = await fs.stat(this.resolve(vaultPath));
      if (!value.isFile() && !value.isDirectory()) return null;
      return { type: value.isDirectory() ? "folder" : "file", ctime: value.birthtimeMs, mtime: value.mtimeMs, size: value.size };
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  async list(vaultPath: string): Promise<ListedFiles> {
    const absolute = this.resolve(vaultPath);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    const files: string[] = [];
    const folders: string[] = [];
    const prefix = this.normalize(vaultPath);
    const entryPath = (name: string) => prefix ? `${prefix}/${name}` : name;
    for (const entry of entries) {
      if (entry.isDirectory()) folders.push(entryPath(entry.name));
      else if (entry.isFile()) files.push(entryPath(entry.name));
    }
    return { files, folders };
  }

  read(vaultPath: string): Promise<string> { return fs.readFile(this.resolve(vaultPath), "utf8"); }

  async readBinary(vaultPath: string): Promise<ArrayBuffer> {
    const buffer = await fs.readFile(this.resolve(vaultPath));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }

  async write(vaultPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const absolute = this.resolve(vaultPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, data, "utf8");
    await this.applyTimes(absolute, options);
  }

  async writeBinary(vaultPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const absolute = this.resolve(vaultPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, new Uint8Array(data));
    await this.applyTimes(absolute, options);
  }

  async append(vaultPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const absolute = this.resolve(vaultPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.appendFile(absolute, data, "utf8");
    await this.applyTimes(absolute, options);
  }

  async appendBinary(vaultPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const absolute = this.resolve(vaultPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.appendFile(absolute, new Uint8Array(data));
    await this.applyTimes(absolute, options);
  }

  async process(vaultPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
    const key = this.normalize(vaultPath);
    const previous = this.processQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    this.processQueues.set(key, queued);

    // A failed earlier operation must not permanently block later updates.
    await previous.catch(() => undefined);
    try {
      const result = fn(await this.read(key));
      await this.write(key, result, options);
      return result;
    } finally {
      release();
      if (this.processQueues.get(key) === queued) this.processQueues.delete(key);
    }
  }

  getResourcePath(vaultPath: string): string { return resourcePath(this.resolve(vaultPath)); }

  async mkdir(vaultPath: string): Promise<void> { await fs.mkdir(this.resolve(vaultPath)); }

  async trashSystem(_vaultPath: string): Promise<boolean> { return false; }

  async trashLocal(vaultPath: string): Promise<void> {
    const source = this.resolve(vaultPath);
    const relative = this.normalize(vaultPath);
    const trashRoot = this.resolve(".trash");
    await fs.mkdir(trashRoot, { recursive: true });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const target = path.join(trashRoot, `${relative.replace(/[\\/]/g, "_")}.${suffix}`);
    await fs.rename(source, target);
  }

  async rmdir(vaultPath: string, recursive: boolean): Promise<void> {
    await fs.rmdir(this.resolve(vaultPath), recursive ? { recursive: true } : undefined);
  }

  async remove(vaultPath: string): Promise<void> { await fs.unlink(this.resolve(vaultPath)); }

  async rename(vaultPath: string, newVaultPath: string): Promise<void> {
    await fs.rename(this.resolve(vaultPath), this.resolve(newVaultPath));
  }

  async copy(vaultPath: string, newVaultPath: string): Promise<void> {
    await fs.cp(this.resolve(vaultPath), this.resolve(newVaultPath), { recursive: true, errorOnExist: true, force: false });
  }

  /** Convert a file URL emitted by getResourcePath back to a vault-relative path. */
  getPathByResourcePath(resourcePath: string): string | null {
    let absolute: string;
    try { absolute = path.resolve(resourceFilePath(resourcePath)); }
    catch { return null; }
    const relative = path.relative(this.basePath, absolute);
    if (relative === "" || relative === ".") return "";
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
  }

  private normalize(vaultPath: string): string {
    if (typeof vaultPath !== "string" || vaultPath.includes("\0")) throw new Error(t("obsen.errors.invalid-vault-path"));
    if (vaultPath === "/") return "";
    const normalized = vaultPath.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(t("obsen.errors.relative-vault-path"));
    const parts: string[] = [];
    for (const part of normalized.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) throw new Error(t("obsen.errors.path-outside-vault"));
        parts.pop();
      } else parts.push(part);
    }
    return parts.join("/");
  }

  private resolve(vaultPath: string): string {
    const normalized = this.normalize(vaultPath);
    const absolute = path.resolve(this.basePath, ...normalized.split("/").filter(Boolean));
    const relative = path.relative(this.basePath, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(t("obsen.errors.path-outside-vault"));
    }
    return absolute;
  }

  private async applyTimes(absolute: string, options?: DataWriteOptions): Promise<void> {
    if (options?.mtime === undefined && options?.ctime === undefined) return;
    const current = await fs.stat(absolute);
    const atime = current.atime;
    const mtime = options.mtime === undefined ? current.mtime : new Date(options.mtime);
    await fs.utimes(absolute, atime, mtime);
    // Node cannot set birthtime on all supported filesystems. ctime is exposed
    // from the native stat and is therefore intentionally left to the OS.
  }
}

/** Familiar Obsidian-compatible class name for callers that use filesystem terminology. */
export class FileSystemAdapter extends NodeDataAdapter {
  static async readLocalFile(filename: string): Promise<ArrayBuffer> {
    const buffer = await fs.readFile(filename);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  static async mkdir(filename: string): Promise<void> { await fs.mkdir(filename); }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
