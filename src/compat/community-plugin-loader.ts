import { fsp as fs, path, createRequire } from "../../platforms/platform";
import { createPluginRequire } from "./module-hook";
import type { Plugin, PluginManager, PluginManifest, PluginConstructor } from "./plugin";

export interface CommunityPluginFailure {
  id: string;
  error: Error;
}

export interface CommunityPluginLoadResult {
  loaded: Plugin[];
  failures: CommunityPluginFailure[];
}

export interface CommunityPluginLoaderOptions {
  /** Called for each plugin that cannot be read, validated, or started. */
  onError?: (id: string, error: Error) => void;
}

interface CommunityManifest extends PluginManifest {
  main: string;
}

/** Loads the enabled desktop community plugins installed in a vault. */
export class CommunityPluginLoader {
  private readonly styles = new Map<string, HTMLStyleElement>();
  private readonly loadedIds = new Set<string>();
  private readonly entries = new Map<string, string>();
  private readonly pluginRoots = new Map<string, string>();
  private fingerprints = new Map<string, string>();
  private reloadTail: Promise<CommunityPluginLoadResult> = Promise.resolve({ loaded: [], failures: [] });

  constructor(
    private readonly plugins: PluginManager,
    private readonly options: CommunityPluginLoaderOptions = {},
  ) {}

  /** Read .obsidian/community-plugins.json and start each enabled plugin independently. */
  loadVault(vaultPath: string): Promise<CommunityPluginLoadResult> {
    return this.enqueue(() => this.loadVaultNow(vaultPath));
  }

  /** Install already-fetched release assets without losing plugin data on updates. */
  install(vaultPath: string, id: string, assets: { manifest: unknown; main: string; styles?: string }, enable = true): Promise<CommunityPluginLoadResult> {
    return this.enqueue(async () => {
      if (!isSafePluginId(id)) throw new Error(`Invalid community plugin id: ${id}`);
      const manifest = validateManifest(assets.manifest, id, "release manifest");
      if (manifest.main !== "main.js") throw new Error("Release installation requires a main.js entry point.");
      if (!assets.main.trim()) throw new Error("Plugin release contains no executable entry point.");
      const directory = path.resolve(vaultPath, ".obsidian", "plugins", id);
      await fs.mkdir(directory, { recursive: true });
      this.unload(id);
      // Stage each asset then atomically replace it; data.json is never touched.
      const files = { "manifest.json": JSON.stringify(assets.manifest, null, 2), "main.js": assets.main, "styles.css": assets.styles ?? "" };
      for (const [name, content] of Object.entries(files)) { const temporary = path.join(directory, `${name}.installing`); await fs.writeFile(temporary, content); await fs.rename(temporary, path.join(directory, name)); }
      if (enable) await this.writeEnabled(vaultPath, id, true);
      return this.reloadVaultNow(vaultPath);
    });
  }

  setEnabled(vaultPath: string, id: string, enabled: boolean): Promise<CommunityPluginLoadResult> {
    return this.enqueue(async () => {
      if (!isSafePluginId(id)) throw new Error(`Invalid community plugin id: ${id}`);
      const wasEnabled = await this.writeEnabled(vaultPath, id, enabled);
      const result = await this.reloadVaultNow(vaultPath);
      if (enabled && !wasEnabled) this.plugins.getPlugin(id)?.onUserEnable();
      return result;
    });
  }

  private async writeEnabled(vaultPath: string, id: string, enabled: boolean): Promise<boolean> {
    const file = path.resolve(vaultPath, ".obsidian", "community-plugins.json");
    let ids: string[] = [];
    try { ids = parseEnabledPlugins(await fs.readFile(file, "utf8"), file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = enabled ? [...new Set([...ids, id])] : ids.filter(value => value !== id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.installing`, JSON.stringify(next, null, 2)); await fs.rename(`${file}.installing`, file);
    return ids.includes(id);
  }

  private async loadVaultNow(vaultPath: string): Promise<CommunityPluginLoadResult> {
    const vault = path.resolve(vaultPath);
    const enabledPath = path.join(vault, ".obsidian", "community-plugins.json");
    let raw: string;
    try {
      raw = await fs.readFile(enabledPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: [], failures: [] };
      throw error;
    }

    const result: CommunityPluginLoadResult = { loaded: [], failures: [] };
    let enabled: string[];
    try { enabled = parseEnabledPlugins(raw, enabledPath); }
    catch (error) {
      const failure = asError(error);
      result.failures.push({ id: "<plugin-list>", error: failure });
      this.options.onError?.("<plugin-list>", failure);
      return result;
    }
    for (const id of enabled) {
      let hookInstalled = false;
      const pluginRoot = path.join(vault, ".obsidian", "plugins", id);
      let entryPath: string | undefined;
      try {
        const manifest = await this.readManifest(vault, id);
        entryPath = this.entryPath(vault, id, manifest);
        const fingerprint = `${manifest.version}:${(await fs.stat(entryPath)).mtimeMs}`;
        if (this.loadedIds.has(id) && this.fingerprints.get(id) === fingerprint) continue;
        if (this.loadedIds.has(id)) this.unload(id);
        // Each plugin gets its own compatibility scope. Its dependencies are
        // resolved by Node relative to that plugin's entry file.

        hookInstalled = true;
        // Construct/register host APIs before calling the plugin's async onload.
        const PluginType = resolvePluginType(entryPath, createPluginRequire(entryPath, pluginRoot));
        const plugin = this.plugins.createPlugin(PluginType, manifest);
        plugin.installCommandApi();
        await this.plugins.startPlugin(plugin);
        const stylesheet = await fs.readFile(path.join(pluginRoot, "styles.css"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
        if (stylesheet) {
          const style = document.createElement("style"); style.dataset.pluginId = id; style.textContent = stylesheet;
          document.head.append(style); this.styles.set(id, style);
        }
        this.loadedIds.add(id);
        this.entries.set(id, entryPath);
        this.pluginRoots.set(id, pluginRoot);
        this.fingerprints.set(id, fingerprint);
        result.loaded.push(plugin);
      } catch (cause) {
        if (!this.loadedIds.has(id)) { this.plugins.unloadPlugin(id); this.styles.get(id)?.remove(); this.styles.delete(id); }
        if (hookInstalled && !this.loadedIds.has(id)) {
          if (entryPath) clearPluginRequireCache(entryPath, pluginRoot);

        }
        const error = asError(cause);
        result.failures.push({ id, error });
        this.options.onError?.(id, error);
      }
    }
    return result;
  }

  /** Unload every plugin started by this loader, in reverse startup order. */
  unloadAll(): void {
    for (const id of [...this.loadedIds].reverse()) this.unload(id);
    this.loadedIds.clear();
    this.entries.clear();
    this.pluginRoots.clear();
    this.fingerprints.clear();
  }

  async reloadVault(vaultPath: string): Promise<CommunityPluginLoadResult> {
    return this.enqueue(() => this.reloadVaultNow(vaultPath));
  }

  private enqueue(operation: () => Promise<CommunityPluginLoadResult>): Promise<CommunityPluginLoadResult> {
    const next = this.reloadTail.then(operation);
    this.reloadTail = next.catch(() => ({ loaded: [], failures: [] }));
    return next;
  }

  private async reloadVaultNow(vaultPath: string): Promise<CommunityPluginLoadResult> {
    const raw = await fs.readFile(path.join(path.resolve(vaultPath), ".obsidian", "community-plugins.json"), "utf8").catch((error): string => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]";
      throw error;
    });
    let enabled: Set<string>;
    try { enabled = new Set(parseEnabledPlugins(raw, path.join(vaultPath, ".obsidian", "community-plugins.json"))); }
    catch (error) {
      const failure = asError(error);
      this.options.onError?.("<plugin-list>", failure);
      return { loaded: [], failures: [{ id: "<plugin-list>", error: failure }] };
    }
    const removed = [...this.loadedIds].filter(id => !enabled.has(id));
    for (const id of removed) this.unload(id);
    return this.loadVaultNow(vaultPath);
  }

  unload(id: string): boolean {
    if (!this.loadedIds.delete(id)) return false;
    this.styles.get(id)?.remove(); this.styles.delete(id);
    const entryPath = this.entries.get(id);
    const pluginRoot = this.pluginRoots.get(id);
    this.entries.delete(id);
    this.pluginRoots.delete(id);
    this.fingerprints.delete(id);
    try {
      return this.plugins.unloadPlugin(id);
    } finally {
      if (pluginRoot) {
        if (entryPath) clearPluginRequireCache(entryPath, pluginRoot);

      }
    }
  }

  private async readManifest(vaultPath: string, id: string): Promise<CommunityManifest> {
    if (!isSafePluginId(id)) throw new Error(`Invalid community plugin id: ${id}`);
    const pluginDir = path.resolve(vaultPath, ".obsidian", "plugins", id);
    const manifestPath = path.join(pluginDir, "manifest.json");
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = validateManifest(JSON.parse(raw) as unknown, id, manifestPath);
    manifest.dir = `.obsidian/plugins/${id}`;
    return manifest;
  }

  private entryPath(vaultPath: string, id: string, manifest: CommunityManifest): string {
    const pluginDir = path.resolve(vaultPath, ".obsidian", "plugins", id);
    const entryPath = path.resolve(pluginDir, manifest.main);
    if (!isInside(pluginDir, entryPath) || path.extname(entryPath).toLowerCase() !== ".js") {
      throw new Error(`Plugin ${id} must have a .js entry point inside its plugin directory.`);
    }
    return entryPath;
  }
}

function clearPluginRequireCache(entryPath: string, pluginRoot: string): void {
  const cache = createRequire(entryPath).cache;
  for (const cachedPath of Object.keys(cache)) {
    if (isInside(pluginRoot, cachedPath)) delete cache[cachedPath];
  }
}

function resolvePluginType(modulePath: string, pluginRequire: NodeRequire): PluginConstructor<Plugin> {
  const loaded = pluginRequire(modulePath) as { default?: unknown } | PluginConstructor<Plugin>;
  const candidate = typeof loaded === "function" ? loaded : loaded.default;
  if (typeof candidate !== "function") throw new Error(`Plugin module did not export a Plugin class: ${modulePath}`);
  return candidate as PluginConstructor<Plugin>;
}

function parseEnabledPlugins(raw: string, filePath: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Could not parse ${filePath}: ${asError(cause).message}`);
  }
  if (!Array.isArray(value)) throw new Error(`${filePath} must contain an array of plugin ids.`);
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

function validateManifest(value: unknown, expectedId: string, filePath: string): CommunityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a plugin manifest object.`);
  }
  const manifest = value as Record<string, unknown>;
  for (const field of ["id", "name", "author", "version", "minAppVersion"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new Error(`${filePath} is missing a valid ${field}.`);
    }
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") throw new Error(`${filePath} has an invalid description.`);
  if (manifest.id !== expectedId) {
    throw new Error(`Plugin manifest id '${String(manifest.id)}' does not match enabled id '${expectedId}'.`);
  }
  if (manifest.main === undefined) manifest.main = "main.js";
  if (typeof manifest.main !== "string" || !manifest.main.trim()) throw new Error(`${filePath} has an invalid main entry point.`);
  return manifest as unknown as CommunityManifest;
}

function isSafePluginId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== "." && id !== "..";
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
