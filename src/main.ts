import { app, BrowserWindow, Menu, dialog, ipcMain, net, screen, shell, fsp as fs, readFileSync, realpathSync, path, randomUUID, getRemoteMain, process, assetDirectory } from "../platforms/platform";
import { installAccountServer } from "./runtime/account-server";
import { installBranding, installMainI18n } from "./runtime/branding";
import { brandName, t } from "./i18n";
import { VersionController } from "./runtime/version";
import { installBrowserSessions } from "./runtime/browser-sessions";
import { installGuestURLRouting, routeExternalURL } from "./runtime/external-urls";

interface VaultRecord {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
  /** Where the vault's window was when it was last closed. */
  window?: { x: number; y: number; width: number; height: number; maximized?: boolean };
}

interface VaultRegistry {
  vaults: VaultRecord[];
  lastVaultId?: string;
}

const registryPath = path.join(app.getPath("userData"), "vaults.json");
/** The window frame chosen in Appearance settings: "hidden" (tabs in the title bar), "custom" (own title bar) or "native". */
function frameStyle(): string {
  try { const frame = (JSON.parse(readFileSync(path.join(app.getPath("userData"), "options.json"), "utf8")) as { frame?: unknown }).frame; return typeof frame === "string" && frame ? frame : "hidden"; }
  catch { return "hidden"; }
}
ipcMain.on("frame", (event) => { event.returnValue = frameStyle(); });
let registry: VaultRegistry = { vaults: [] };
const windowVaults = new Map<number, VaultRecord>();
const versionController = new VersionController();

ipcMain.handle("version:check", () => versionController.check());
ipcMain.handle("window:control", (event, action: string, childTitle?: string) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const window = typeof childTitle === "string" ? owner?.getChildWindows().find(child => child.getTitle() === childTitle) ?? BrowserWindow.getAllWindows().find(item => item !== owner && item.getTitle() === childTitle) ?? null : owner;
  if (!window) return;
  if (action === "minimize") window.minimize();
  else if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
  else if (action === "close") window.close();
  else if (action === "always-on-top") window.setAlwaysOnTop(!window.isAlwaysOnTop());
  else if (action === "state") return { maximized: window.isMaximized(), focused: window.isFocused() };
});
ipcMain.handle("capture-region", async (event, rect: Electron.Rectangle, defaultName: string) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return null;
  const image = await event.sender.capturePage(rect);
  const result = await dialog.showSaveDialog(window, { defaultPath: String(defaultName || "Untitled").replace(/[<>:"/\\|?*]/g, "") + ".png", filters: [{ name: "PNG", extensions: ["png"] }] });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, image.toPNG());
  return result.filePath;
});
ipcMain.handle("pick-file", async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ["openFile"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
ipcMain.handle("export-pdf", async (event, defaultName: string) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return null;
  const result = await dialog.showSaveDialog(window, { defaultPath: String(defaultName || "Untitled").replace(/[<>:"/\\|?*]/g, "") + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, await event.sender.printToPDF({ printBackground: true, pageSize: "A4" }));
  return result.filePath;
});
ipcMain.on("settings:updated", () => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("settings:changed");
});
ipcMain.handle("community:fetch", async (_event, address: string) => {
  const url = new URL(address);
  if (url.protocol !== "https:" || !["raw.githubusercontent.com", "github.com"].includes(url.hostname)) throw new Error(t("setting.third-party-plugin.msg-failed-load-plugins"));
  const response = await net.fetch(url.href, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) return { status: response.status, text: "" };
  return { status: response.status, text: await response.text() };
});

interface VaultLaunchRequest {
  folderPath: string;
  workingDirectory: string;
}

function vaultPathFromArgs(argv: string[]): string | undefined {
  // `electron . <vault>` has an app argument that packaged executables omit.
  const args = argv.slice(process.defaultApp ? 2 : 1);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") return args[index + 1];
    if (/^obsidian:\/\//i.test(argument)) continue;
    if (argument === "--vault" || argument === "--open-path") {
      const value = args[index + 1];
      return value && !value.startsWith("-") ? value : "";
    }
    if (argument.startsWith("--vault=") || argument.startsWith("--open-path=")) {
      return argument.slice(argument.indexOf("=") + 1);
    }
    if (!argument.startsWith("-")) return argument;
  }
  return undefined;
}

const uriFromArgs = (argv: string[]) => argv.find(argument => /^obsidian:\/\//i.test(argument));

const initialVaultPath = vaultPathFromArgs(process.argv);
// `obsidian://` links given on the command line, by a second launch, or (macOS) by the system.
const pendingUris: string[] = [];
const initialUri = uriFromArgs(process.argv);
if (initialUri) pendingUris.push(initialUri);
/** Requests waiting for their vault window to finish loading, by web contents id. */
const queuedUriRequests = new Map<number, Array<{ action: string; params: Record<string, string> }>>();
const readyUriWindows = new Set<number>();
const pendingVaultLaunches: VaultLaunchRequest[] = initialVaultPath === undefined
  ? []
  : [{ folderPath: initialVaultPath, workingDirectory: process.cwd() }];
let vaultLaunchesReady = false;
let processingVaultLaunches = false;

// Pass the original path separately: Chromium may reorder second-instance argv.
const isPrimaryInstance = app.requestSingleInstanceLock({
  vaultPath: initialVaultPath ?? null,
  workingDirectory: process.cwd(),
});
if (!isPrimaryInstance) app.quit();

if (isPrimaryInstance) {
  app.on("second-instance", (_event, argv, workingDirectory, additionalData) => {
    const launch = additionalData && typeof additionalData === "object"
      ? additionalData as { vaultPath?: unknown; workingDirectory?: unknown }
      : undefined;
    const folderPath = typeof launch?.vaultPath === "string"
      ? launch.vaultPath
      : launch?.vaultPath === null ? undefined : vaultPathFromArgs(argv);
    const uri = uriFromArgs(argv);
    if (uri) { pendingUris.push(uri); if (vaultLaunchesReady) void processUris(); return; }
    if (folderPath !== undefined) {
      queueVaultLaunch({
        folderPath,
        workingDirectory: typeof launch?.workingDirectory === "string"
          ? launch.workingDirectory : workingDirectory,
      });
    } else {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (window) focusWindow(window);
      else if (vaultLaunchesReady) showStarterWindow();
    }
  });

  app.on("open-url", (event, uri) => { event.preventDefault(); pendingUris.push(uri); if (vaultLaunchesReady) void processUris(); });

  // macOS delivers Finder/open-path requests here, including before ready.
  app.on("open-file", (event, folderPath) => {
    event.preventDefault();
    queueVaultLaunch({ folderPath, workingDirectory: process.cwd() });
  });
}

/**
 * Routes an `obsidian://action?vault=…` link to its vault's window, opening the vault when needed.
 * The vault is named by `vault` (name or id), or found from an absolute `path`; otherwise the
 * focused or most recently used vault takes it.
 */
async function processUris() {
  while (pendingUris.length > 0) {
    const raw = pendingUris.shift()!;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    const params: Record<string, string> = {};
    // Obsidian URIs preserve literal plus signs instead of applying form decoding.
    new URLSearchParams(url.search.replace(/\+/g, "%2B")).forEach((value, key) => { params[key] = value; });
    const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
    if (!action) continue;
    const windowFor = (vault: VaultRecord) => BrowserWindow.getAllWindows().find(window => windowVaults.get(window.webContents.id)?.id === vault.id);
    let vault = params.vault ? registry.vaults.find(item => item.id === params.vault) ?? registry.vaults.find(item => item.name === params.vault) : undefined;
    if (!vault && params.path && path.isAbsolute(params.path)) {
      const target = path.resolve(params.path).toLowerCase() + path.sep;
      vault = registry.vaults.filter(item => target.startsWith(path.resolve(item.path).toLowerCase() + path.sep)).sort((a, b) => b.path.length - a.path.length)[0];
    }
    if (!vault && !params.vault) {
      const focused = BrowserWindow.getFocusedWindow();
      vault = (focused && windowVaults.get(focused.webContents.id)) ?? registry.vaults.find(item => item.id === registry.lastVaultId);
    }
    if (!vault) { showStarterWindow(); continue; }
    try { await fs.access(vault.path); } catch { showStarterWindow(); continue; }
    const window = windowFor(vault) ?? createWindow(vault);
    focusWindow(window);
    const request = { action, params }, id = window.webContents.id;
    if (readyUriWindows.has(id)) window.webContents.send("open-url", request);
    else queuedUriRequests.set(id, [...(queuedUriRequests.get(id) ?? []), request]);
  }
}

ipcMain.handle("open-url:ready", (event) => {
  const id = event.sender.id;
  readyUriWindows.add(id);
  event.sender.once("destroyed", () => { readyUriWindows.delete(id); queuedUriRequests.delete(id); });
  // A reload starts a new page in the same web contents; it announces itself again.
  event.sender.once("did-start-navigation", () => readyUriWindows.delete(id));
  const queued = queuedUriRequests.get(id) ?? [];
  queuedUriRequests.delete(id);
  return queued;
});

function queueVaultLaunch(request: VaultLaunchRequest) {
  pendingVaultLaunches.push(request);
  if (vaultLaunchesReady) void processVaultLaunches();
}

function focusWindow(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function showStarterWindow() {
  const starter = BrowserWindow.getAllWindows().find((window) => !windowVaults.has(window.webContents.id));
  focusWindow(starter ?? createWindow());
}

async function registerVaultPath(folderPath: unknown, workingDirectory = process.cwd()) {
  if (typeof folderPath !== "string" || !folderPath.trim()) {
    throw new Error(t("interface.start-screen.msg-invalid-folder"));
  }
  return registerVault(path.resolve(workingDirectory, folderPath));
}

async function processVaultLaunches() {
  if (processingVaultLaunches) return;
  processingVaultLaunches = true;
  try {
    // Serialize registration so launch requests cannot race registry writes.
    while (pendingVaultLaunches.length > 0) {
      const request = pendingVaultLaunches.shift()!;
      try {
        const vault = await registerVaultPath(request.folderPath, request.workingDirectory);
        const existingWindow = BrowserWindow.getAllWindows().find((window) =>
          windowVaults.get(window.webContents.id)?.id === vault.id);
        focusWindow(existingWindow ?? createWindow(vault));
      } catch (error) {
        console.warn("Unable to open vault path:", request.folderPath, error);
        showStarterWindow();
      }
    }
  } finally {
    processingVaultLaunches = false;
  }
}

async function persistRegistry() {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = registryPath + ".tmp";
  await fs.writeFile(temporaryPath, JSON.stringify(registry, null, 2), "utf8");
  await fs.rename(temporaryPath, registryPath);
}

async function loadRegistry() {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as VaultRegistry;
    registry = {
      vaults: Array.isArray(parsed.vaults) ? parsed.vaults : [],
      lastVaultId: parsed.lastVaultId,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function registerVault(folderPath: string) {
  const realPath = await fs.realpath(folderPath);
  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) throw new Error(t("interface.start-screen.msg-invalid-folder"));

  let record = registry.vaults.find((vault) => path.resolve(vault.path) === realPath);
  if (!record) {
    record = {
      id: randomUUID(),
      name: path.basename(realPath) || realPath,
      path: realPath,
      lastOpenedAt: Date.now(),
    };
    registry.vaults.unshift(record);
  } else {
    record.lastOpenedAt = Date.now();
  }

  registry.lastVaultId = record.id;
  await persistRegistry();
  return record;
}

/** The saved window bounds of a vault, when they still fall on a connected display. */
function savedWindowBounds(vault: VaultRecord): Partial<Electron.Rectangle> {
  const saved = vault.window;
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return {};
  const visible = screen.getAllDisplays().some(display => {
    const area = display.workArea;
    return saved.x < area.x + area.width - 80 && saved.x + saved.width > area.x + 80 && saved.y < area.y + area.height - 40 && saved.y >= area.y - 10;
  });
  return visible ? { x: saved.x, y: saved.y, width: Math.max(820, saved.width), height: Math.max(560, saved.height) } : { width: Math.max(820, saved.width), height: Math.max(560, saved.height) };
}

function createWindow(vault?: VaultRecord) {
  const window = new BrowserWindow({
    // The vault chooser is a fixed-size window, like the reference.
    ...(vault ? { width: 1280, height: 820, ...savedWindowBounds(vault), minWidth: 820, minHeight: 560 } : { width: 800, height: 650, resizable: false, maximizable: false, fullscreenable: false }),
    backgroundColor: vault ? "#00000000" : "#1e1e1e",
    frame: frameStyle() === "native",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      webviewTag: true,
      spellcheck: true,
      preload: path.join(assetDirectory, "preload.cjs"),
    },
  });

  const webContentsId = window.webContents.id;
  window.webContents.on("did-create-window", (child, details) => {
    if (!details.frameName.startsWith("obsen-popout-")) return;
    child.on("closed", () => {
      if (window.isDestroyed()) return;
      window.focus(); window.webContents.focus();
    });
  });
  window.webContents.setWindowOpenHandler(({ url, frameName, disposition }) => {
    if (url === "about:blank" && frameName.startsWith("obsen-popout-")) return { action: "allow", overrideBrowserWindowOptions: {
      title: brandName(), width: 800, height: 600, backgroundColor: "#202020", frame: frameStyle() === "native", autoHideMenuBar: true,
      webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true, preload: path.join(assetDirectory, "preload.cjs") },
    } };
    if (url === "about:blank" && frameName === "obsen-settings") return { action: "allow", overrideBrowserWindowOptions: {
      parent: window, title: `${t("interface.settings")} - ${brandName()}`, width: 900, height: 700, minWidth: 720, minHeight: 500, frame: frameStyle() === "native", autoHideMenuBar: true,
      backgroundColor: "#202020",
    } };
    void routeExternalURL(window.webContents, url, disposition, frameName).catch(error => console.warn(error));
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!/^https?:\/\//i.test(url)) return;
    event.preventDefault(); void routeExternalURL(window.webContents, url).catch(error => console.warn(error));
  });
  installGuestURLRouting(window.webContents);
  window.webContents.on("did-create-window", child => {
    installGuestURLRouting(child.webContents);
    child.webContents.setWindowOpenHandler(({ url, frameName, disposition }) => {
      void routeExternalURL(child.webContents, url, disposition, frameName).catch(error => console.warn(error));
      return { action: "deny" };
    });
    child.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) return;
      event.preventDefault(); void routeExternalURL(child.webContents, url).catch(error => console.warn(error));
    });
  });
  if (vault) windowVaults.set(webContentsId, vault);
  void window.loadFile(path.join(assetDirectory, "index.html"), {
    query: vault ? { window: "workspace", vaultId: vault.id } : { window: "starter" },
  });
  if (vault) {
    if (vault.window?.maximized) window.maximize();
    // Remember the window's place for the next launch (the normal bounds, also while maximized).
    let saving: ReturnType<typeof setTimeout> | undefined;
    const remember = () => {
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
      const record = registry.vaults.find(item => item.id === vault.id);
      if (!record) return;
      record.window = { ...window.getNormalBounds(), maximized: window.isMaximized() };
      clearTimeout(saving);
      saving = setTimeout(() => void persistRegistry().catch(error => console.warn("Could not save the window position:", error)), 500);
    };
    for (const event of ["resize", "move", "maximize", "unmaximize"] as const) window.on(event as "resize", remember);
    window.on("close", () => { remember(); clearTimeout(saving); void persistRegistry().catch(() => undefined); });
  }
  window.on("closed", () => { windowVaults.delete(webContentsId); appMenus.delete(webContentsId); });
  // Until the page supplies its commands, the window has the base menu (the chooser keeps it).
  if (isMac) window.on("focus", () => showAppMenuFor(window)); else window.setMenu(appMenuFor(null));
  window.setMenuBarVisibility(false);
  return window;
}

function closeCallerWindow(event: Electron.IpcMainInvokeEvent) {
  BrowserWindow.fromWebContents(event.sender)?.close();
}

async function openVault(event: Electron.IpcMainInvokeEvent, vault: VaultRecord) {
  const record = await registerVault(vault.path);
  createWindow(record);
  closeCallerWindow(event);
  return record;
}

ipcMain.handle("vault:list", async () => ({
  ...registry,
  vaults: await Promise.all(registry.vaults.map(async (vault) => {
    try {
      const stat = await fs.stat(vault.path);
      return { ...vault, available: stat.isDirectory() };
    } catch {
      return { ...vault, available: false };
    }
  })),
}));

ipcMain.handle("vault:choose", async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
    title: t("interface.start-screen.option-open-folder-as-vault"),
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return openVault(event, await registerVault(result.filePaths[0]));
});

function validVaultName(rawName: unknown): string {
  const name = String(rawName ?? "").trim();
  if (!name || /[<>:"/\\|?*]/.test(name) || name === "." || name === "..") throw new Error(t("interface.start-screen.msg-empty-vault-name"));
  if (name.endsWith(".")) throw new Error(t("interface.start-screen.msg-trailing-dot-vault-name"));
  return name;
}

function isVaultOpen(id: string): boolean {
  return [...windowVaults.values()].some((vault) => vault.id === id);
}

ipcMain.handle("vault:pick-folder", async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("vault:create", async (event, rawName: string, rawParent?: unknown) => {
  const name = validVaultName(rawName);
  const parent = typeof rawParent === "string" && path.isAbsolute(rawParent) ? rawParent : path.join(app.getPath("documents"), `${brandName()} Vaults`);
  const folderPath = path.join(parent, name);
  try {
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(folderPath);
    await fs.mkdir(path.join(folderPath, ".obsidian"));
  } catch { throw new Error(t("interface.start-screen.msg-failed-to-create-vault-at-location")); }
  return openVault(event, await registerVault(folderPath));
});

ipcMain.handle("vault:reveal", (_event, id: string) => {
  const vault = registry.vaults.find((item) => item.id === id);
  if (vault) shell.showItemInFolder(vault.path);
});

async function relocateVault(vault: VaultRecord, target: string, existsKey: string, failedKey: string) {
  if (await fs.stat(target).then(() => true, () => false)) throw new Error(t(existsKey));
  try { await fs.rename(vault.path, target); } catch { throw new Error(t(failedKey)); }
  vault.path = target;
  vault.name = path.basename(target);
  await persistRegistry();
  return registry;
}

ipcMain.handle("vault:rename", async (_event, id: string, rawName: string) => {
  const vault = registry.vaults.find((item) => item.id === id);
  if (!vault) throw new Error(t("interface.start-screen.msg-rename-failed"));
  if (isVaultOpen(id)) throw new Error(t("interface.start-screen.msg-error-rename-open"));
  return relocateVault(vault, path.join(path.dirname(vault.path), validVaultName(rawName)), "interface.start-screen.msg-error-rename-exists", "interface.start-screen.msg-rename-failed");
});

ipcMain.handle("vault:move", async (event, id: string) => {
  const vault = registry.vaults.find((item) => item.id === id);
  if (!vault) throw new Error(t("interface.start-screen.msg-move-failed"));
  if (isVaultOpen(id)) throw new Error(t("interface.start-screen.msg-error-move-open"));
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title: t("interface.start-screen.msg-move-select-dest"), properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  const destination = path.resolve(result.filePaths[0]);
  if ((destination + path.sep).startsWith(path.resolve(vault.path) + path.sep)) throw new Error(t("interface.start-screen.msg-error-nested"));
  return relocateVault(vault, path.join(destination, path.basename(vault.path)), "interface.start-screen.msg-error-move-exists", "interface.start-screen.msg-move-failed");
});

ipcMain.handle("vault:open", async (event, id: string) => {
  const vault = registry.vaults.find((item) => item.id === id);
  if (!vault) throw new Error(t("interface.start-screen.msg-error-failed-to-open-vault"));
  try {
    return await openVault(event, vault);
  } catch {
    throw new Error(t("interface.start-screen.msg-error-failed-to-open-vault"));
  }
});

ipcMain.handle("vault:locate", async (event, id: string) => {
  const previous = registry.vaults.find((item) => item.id === id);
  if (!previous) throw new Error(t("interface.start-screen.msg-error-failed-to-open-vault"));
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
    title: t("interface.start-screen.option-open-folder-as-vault"),
    defaultPath: path.dirname(previous.path),
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const realPath = await fs.realpath(result.filePaths[0]);
  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) throw new Error(t("interface.start-screen.msg-invalid-folder"));
  const existing = registry.vaults.find((item) => item.id !== id && path.resolve(item.path) === realPath);
  let vault: VaultRecord;
  if (existing) {
    registry.vaults = registry.vaults.filter((item) => item.id !== id);
    existing.lastOpenedAt = Date.now();
    vault = existing;
  } else {
    previous.path = realPath;
    previous.name = path.basename(realPath) || realPath;
    previous.lastOpenedAt = Date.now();
    vault = previous;
  }
  registry.lastVaultId = vault.id;
  await persistRegistry();
  createWindow(vault);
  closeCallerWindow(event);
  return vault;
});

ipcMain.handle("vault:open-path", async (event, folderPath: unknown) => {
  const vault = await registerVaultPath(folderPath);
  createWindow(vault);
  closeCallerWindow(event);
  return vault;
});

ipcMain.handle("vault:remove-from-list", async (_event, id: string) => {
  if (isVaultOpen(id)) throw new Error(t("interface.start-screen.msg-error-remove-current-open-vault"));
  registry.vaults = registry.vaults.filter((vault) => vault.id !== id);
  if (registry.lastVaultId === id) registry.lastVaultId = registry.vaults[0]?.id;
  await persistRegistry();
  return registry;
});

const sandboxPath = () => path.join(app.getPath("userData"), `${brandName()} Sandbox`);
// Registered vaults store their real path, which can differ in form from the profile path (short names, links).
const samePath = (left: string, right: string) => { const real = (value: string) => { try { return realpathSync.native(value); } catch { return path.resolve(value); } }; return real(left).toLowerCase() === real(right).toLowerCase(); };

ipcMain.on("vault", (event) => {
  const vault = windowVaults.get(event.sender.id);
  event.returnValue = vault ? { id: vault.id, path: vault.path, sandbox: samePath(vault.path, sandboxPath()) } : {};
});

// The sandbox is a scratch vault that starts empty every time it is opened.
ipcMain.on("sandbox", (event) => {
  event.returnValue = null;
  void (async () => {
    const folder = sandboxPath();
    const open = BrowserWindow.getAllWindows().find(window => { const vault = windowVaults.get(window.webContents.id); return vault && samePath(vault.path, folder); });
    if (open) { open.focus(); return; }
    await fs.rm(folder, { recursive: true, force: true });
    await fs.mkdir(path.join(folder, ".obsidian"), { recursive: true });
    createWindow(await registerVault(folder));
  })().catch(error => console.error("Could not open the sandbox vault:", error));
});

// ---------------------------------------------------------------------------------------------
// Application menu. The renderer supplies the command entries (labels, hotkeys, visibility);
// the entries that act on the window itself live here. On Windows and Linux the menu has no
// bar: it pops up from the logo button in the title bar.
// ---------------------------------------------------------------------------------------------

type MenuEntry = Omit<Electron.MenuItemConstructorOptions, "submenu"> & { appCommand?: string; before?: string[]; submenu?: MenuEntry[] };
const isMac = process.platform === "darwin";
const appMenus = new Map<number, Menu>();
/** A shortcut already handled in the page (typing in an input) must not run the command twice. */
const fromMenuOrPlainKey = (event: Electron.KeyboardEvent) => !event.triggeredByAccelerator || (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey);

function buildAppMenu(additions: MenuEntry[], owner: BrowserWindow | null): Menu {
  const runCommand = (id: string) => (_item: Electron.MenuItem, _window: Electron.BaseWindow | undefined, event: Electron.KeyboardEvent) => {
    if (!owner || owner.isDestroyed() || !fromMenuOrPlainKey(event)) return;
    owner.webContents.send("menu-command", id);
  };
  const command = (id: string, label: string, accelerator: string): MenuEntry => ({ id, label, accelerator, registerAccelerator: false, enabled: !!owner, click: runCommand(id) });
  const base: MenuEntry[] = [
    ...(isMac ? [{ label: brandName(), submenu: [
      { role: "about" }, { type: "separator" }, { id: "preferences-section", visible: false, label: "" }, { type: "separator" },
      { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
    ] as MenuEntry[] }] : []),
    { label: t("obsen.menu.file"), submenu: [
      { id: "open-section", type: "separator" },
      { id: "open-vault", label: t("menu-items.open-vault"), click: () => showStarterWindow() },
      ...(isMac || process.platform === "win32" ? [{ role: "recentDocuments", submenu: [{ label: t("obsen.menu.clear-recent"), role: "clearRecentDocuments" }] } as MenuEntry] : []),
      { type: "separator" },
      ...(owner ? [] : [{ id: "close-window", role: "close" } as MenuEntry]),
      ...(isMac ? [] : [{ type: "separator" } as MenuEntry, { id: "quit", role: "quit" } as MenuEntry]),
    ] },
    { label: t("obsen.menu.edit"), submenu: [
      { type: "separator", id: "undo-section" }, { role: "undo" },
      { label: t("obsen.menu.redo"), accelerator: "CmdOrCtrl+Shift+Z", click: (_item, window) => { if (window instanceof BrowserWindow) window.webContents.redo(); } },
      { type: "separator", id: "copy-section" }, { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "pasteAndMatchStyle", accelerator: isMac ? "Cmd+Shift+V" : "Shift+CommandOrControl+V" },
      { label: t("obsen.menu.paste-and-match-style"), accelerator: isMac ? "Cmd+Option+Shift+V" : "Shift+CommandOrControl+Alt+V", visible: false, click: (_item, window) => { if (window instanceof BrowserWindow) window.webContents.pasteAndMatchStyle(); } },
      { role: "delete" }, { role: "selectAll" },
      ...(isMac ? [{ type: "separator", id: "speech-section" } as MenuEntry, { role: "startSpeaking" } as MenuEntry, { role: "stopSpeaking" } as MenuEntry] : []),
    ] },
    { label: t("obsen.menu.view"), submenu: [
      // Zoom is a vault setting here, so these run the same commands as their hotkeys.
      command("window:reset-zoom", t("obsen.menu.actual-size"), "CommandOrControl+0"),
      command("window:zoom-in", t("obsen.menu.zoom-in"), "CommandOrControl+="),
      command("window:zoom-out", t("obsen.menu.zoom-out"), "CommandOrControl+-"),
      { id: "developer-section", type: "separator" },
      { role: "forceReload", accelerator: "" },
      { label: t("obsen.menu.toggle-developer-tools"), accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I", click: (_item, window) => { if (window instanceof BrowserWindow) window.webContents.toggleDevTools(); } },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { label: t("obsen.menu.window"), role: "window", submenu: [
      { role: "minimize", accelerator: isMac ? "CommandOrControl+M" : "" }, ...(isMac ? [{ role: "zoom" } as MenuEntry] : []),
      { type: "separator" }, { type: "separator", id: "tab-management" },
      // Only pop-out windows can be kept on top; the item is enabled when the menu opens in one.
      { id: "window-always-on-top", type: "checkbox", checked: false, enabled: false, label: t("obsen.menu.always-on-top"), click: (_item, window) => { if (window instanceof BrowserWindow) window.setAlwaysOnTop(!window.isAlwaysOnTop()); } },
      { role: "front" },
    ] },
    { label: t("obsen.menu.help"), role: "help", submenu: [
      { label: t("obsen.menu.open-help"), click: () => void shell.openExternal("https://help.obsidian.md/") },
      { type: "separator", id: "help-links" },
      { label: t("obsen.menu.homepage"), click: () => void shell.openExternal("https://obsidian.md/") },
      { label: t("obsen.menu.community"), click: () => void shell.openExternal("https://obsidian.md/community") },
      { label: t("obsen.menu.help-center"), click: () => void shell.openExternal("https://help.obsidian.md/") },
      { type: "separator" },
    ] },
  ];
  // Merged the way the reference does it, which decides the order: the page's Window and Help
  // menus are appended after the base ones, its other menus sit between Edit and View, and
  // menus with the same label are folded into the first one. An entry goes in front of the
  // item its `before` names; when that item is absent it lands before the last entry.
  const windowLabel = t("obsen.menu.window"), helpLabel = t("obsen.menu.help");
  const trailing = additions.filter(menu => menu.label === windowLabel || menu.label === helpLabel);
  const leading = additions.filter(menu => !trailing.includes(menu));
  const viewAt = base.findIndex(menu => menu.label === t("obsen.menu.view"));
  const merged: MenuEntry[] = [];
  for (const menu of [...base.slice(0, viewAt), ...leading, ...base.slice(viewAt), ...trailing]) {
    const target = merged.find(item => item.label === menu.label);
    if (!target) { merged.push({ ...menu, submenu: [...(menu.submenu ?? [])] }); continue; }
    if (menu.role && !target.role) target.role = menu.role;
    for (const entry of menu.submenu ?? []) {
      if (entry.before) target.submenu!.splice(target.submenu!.findIndex(item => item.id === entry.before![0]), 0, entry);
      else target.submenu!.push(entry);
    }
  }
  const finish = (entries: MenuEntry[]) => {
    for (const entry of entries) {
      if (entry.appCommand) { entry.id = entry.appCommand; entry.click = runCommand(entry.appCommand); entry.registerAccelerator = false; delete entry.appCommand; }
      delete entry.before;
      if (entry.submenu) finish(entry.submenu);
    }
  };
  finish(merged);
  return Menu.buildFromTemplate(merged as Electron.MenuItemConstructorOptions[]);
}

let defaultAppMenu: Menu | undefined;
function appMenuFor(window: BrowserWindow | null): Menu {
  return (window && appMenus.get(window.webContents.id)) || (defaultAppMenu ??= buildAppMenu([], null));
}
function showAppMenuFor(window: BrowserWindow | null) { if (isMac) Menu.setApplicationMenu(appMenuFor(window)); }

ipcMain.on("set-menu", (event, payload: { template: MenuEntry[] }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  const menu = buildAppMenu(payload.template, window);
  appMenus.set(event.sender.id, menu);
  // Also kept on the window, as the reference does, so tooling can read it.
  (window as BrowserWindow & { appMenu?: Menu }).appMenu = menu;
  // No menu bar is shown; setting the menu keeps the window-level shortcuts (developer tools, full screen) working.
  if (isMac) showAppMenuFor(BrowserWindow.getFocusedWindow()); else window.setMenu(menu);
});
ipcMain.on("update-menu-items", (event, items: Array<{ itemId: string; eState: { checked?: boolean; enabled?: boolean } }>) => {
  const menu = appMenus.get(event.sender.id);
  if (!menu) return;
  for (const { itemId, eState } of items) {
    const item = menu.getMenuItemById(itemId);
    if (!item) continue;
    if (typeof eState.checked === "boolean") item.checked = eState.checked;
    if (typeof eState.enabled === "boolean") item.enabled = eState.enabled;
  }
});
ipcMain.on("render-menu", (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const menu = appMenuFor(owner);
  // A pop-out window shares its opener's page, so the menu opens in whichever of them has focus.
  const focused = BrowserWindow.getFocusedWindow();
  const target = focused && !appMenus.has(focused.webContents.id) ? focused : owner;
  const onTop = menu.getMenuItemById("window-always-on-top");
  if (onTop && target) { onTop.checked = target.isAlwaysOnTop(); onTop.enabled = target !== owner; }
  if (target) menu.popup({ window: target });
});

ipcMain.on("vault-list", (event) => {
  event.returnValue = registry.vaults;
});

ipcMain.on("version", (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on("starter", () => {
  createWindow();
});

export const ready = isPrimaryInstance ? app.whenReady().then(async () => {
  installBrowserSessions();
  installAccountServer(app.getPath("userData"));
  installBranding();
  installMainI18n();
  const remoteMain = getRemoteMain();
  remoteMain.initialize();
  app.on("browser-window-created", (_event, window) => remoteMain.enable(window.webContents));

  await loadRegistry();
  if (pendingVaultLaunches.length === 0 && pendingUris.length === 0) {
    const lastVault = registry.vaults.find((vault) => vault.id === registry.lastVaultId);
    let restoredVault: VaultRecord | undefined;
    if (lastVault) {
      try {
        await fs.access(lastVault.path);
        restoredVault = lastVault;
      } catch {
        // Keep the chooser fallback for a missing previously opened vault.
      }
    }
    // An open-file/second-instance request can arrive while access is pending.
    if (pendingVaultLaunches.length === 0) createWindow(restoredVault);
  }
  vaultLaunchesReady = true;
  await processVaultLaunches();
  await processUris();
  if (BrowserWindow.getAllWindows().length === 0) showStarterWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}) : Promise.resolve();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
