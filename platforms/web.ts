import { proxy, wrap, type Remote } from "comlink";
import { Buffer } from "node:buffer";
import { createPositronRenderer } from "../libs/positron";
import { fs, path, registerWebModule, assetDirectory } from "./web-node";
import { applyFiles, diffFiles, sameEntry, snapshotFiles, onFilesystemChange, type FileSnapshot } from "./web-filesystem";
import type { BrowserHost, PlatformWorker, WorkerState } from "./worker-contract";
import type { FileMount } from "./file-access";
import { capturePage, printToPDF, popupMenu, revealPath } from "./browser-ui";

export { fs, originalFs, fsp, readFileSync, writeFileSync, realpathSync, path,
  fileURLToPath, pathToFileURL, randomUUID, nodeScrypt, EventEmitter, createRequire,
  compileFunction, http, https, Buffer, process, assetDirectory, target } from "./web-node";
export type { WebContents } from "electron";
export { readAsset } from "./web-assets";
let worker: Remote<PlatformWorker>;
let baseline: FileSnapshot = {};
let values: Record<string, unknown> = {};
let windowId = 0;
let sequence: Promise<unknown> = Promise.resolve();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let initialized: Promise<void> | undefined;
let mounts: FileMount[] = [];
let preparedOpen: Promise<{ canceled: boolean; filePaths: string[] }> | undefined;
let preparedSave: Promise<{ canceled: boolean; filePath?: string }> | undefined;

function acceptState(next: WorkerState, expected = baseline) {
  // Preserve edits made while an asynchronous worker call was in flight.
  const current = snapshotFiles();
  const downloads = diffFiles(baseline, next.files).filter(change => change.path.startsWith("/downloads/") && change.entry?.data !== null && change.entry?.data !== undefined && change.entry.data !== baseline[change.path]?.data);
  applyFiles(diffFiles(baseline, next.files).filter(change => sameEntry(current[change.path], expected[change.path]) && (change.entry || !Object.keys(current).some(filename => filename.startsWith(change.path + "/") && !sameEntry(current[filename], expected[filename])))));
  baseline = next.files;
  values = next.values;
  mounts = next.mounts;
  const navigated = windowId !== 0 && windowId !== next.windowId;
  windowId = next.windowId;
  if (navigated) window.dispatchEvent(new Event("platform-vault-changed"));
  for (const download of downloads) {
    const link = document.createElement("a"); link.download = path.basename(download.path); link.href = URL.createObjectURL(new Blob([new Uint8Array(Buffer.from(download.entry!.data!, "base64"))])); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
}
function dispatch(kind: "invoke" | "send" | "flush", channel: string, args: unknown[] = []): Promise<any> {
  const task = sequence.then(async () => {
    const expected = snapshotFiles();
    const reply = await worker.dispatch(windowId, kind, channel, args, diffFiles(baseline, expected));
    acceptState(reply.state, expected);
    return reply.result;
  });
  sequence = task.catch(error => { console.error(`Platform ${channel || "filesystem"}:`, error); window.dispatchEvent(new CustomEvent("platform-error", { detail: error })); });
  return task;
}
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void dispatch("flush", ""); }, 20);
}
async function invokeWithPermission(channel: string, args: unknown[]): Promise<unknown> {
  if (channel === "vault:rename" || channel === "vault:move") {
    if (preparedOpen) await preparedOpen;
    const record = (values["vault-list"] as Array<{ id: string; path: string }> | undefined)?.find(vault => vault.id === args[0]);
    const root = mounts.find(mount => mount.path === record?.path && mount.handle.kind === "directory");
    if (root && !await authorizeParent(root)) return null;
  }
  if (channel === "vault:open" || channel === "vault:open-path") {
    const record = (values["vault-list"] as Array<{ id: string; path: string }> | undefined)?.find(vault => vault.id === args[0]);
    const filename = record?.path ?? String(args[0]);
    const mount = mounts.filter(item => filename === item.path || filename.startsWith(item.path + "/")).sort((a, b) => b.path.length - a.path.length)[0];
    if (mount && await mount.handle.requestPermission({ mode: "readwrite" }) === "granted") await mountHandle(mount.handle);
  }
  return dispatch("invoke", channel, args);
}
function authorizeParent(mount: FileMount): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog"); dialog.className = "modal";
    const message = document.createElement("p"); message.textContent = `Select the folder containing ${mount.handle.name} to rename or move it.`;
    const choose = document.createElement("button"), cancel = document.createElement("button"); choose.textContent = "Choose parent folder"; cancel.textContent = "Cancel";
    cancel.onclick = () => dialog.close();
    choose.onclick = () => {
      void window.showDirectoryPicker({ mode: "readwrite", startIn: mount.handle as FileSystemDirectoryHandle, id: "obsen-vault-parent" }).then(async parent => {
        const relative = await parent.resolve(mount.handle);
        if (!relative?.length) { message.textContent = `Choose a folder that contains ${mount.handle.name}.`; return; }
        let parentPath = mount.path;
        for (const _part of relative) parentPath = path.dirname(parentPath);
        if (path.join(parentPath, ...relative) !== mount.path || parentPath === "/") { message.textContent = "Choose the immediate parent folder."; return; }
        const mounted = await worker.mount(parent, parentPath); acceptState(mounted.state); resolve(true); dialog.close();
      }).catch(error => { if (error.name !== "AbortError") message.textContent = String(error.message); });
    };
    dialog.addEventListener("close", () => { resolve(false); dialog.remove(); }, { once: true });
    dialog.append(message, choose, cancel); document.body.append(dialog); dialog.showModal();
  });
}
const positron = createPositronRenderer({
  transport: {
    invoke(channel, ...args) {
      if (["vault:choose", "vault:locate", "vault:move", "vault:pick-folder", "pick-file"].includes(channel)) preparedOpen = openDialog({ properties: [channel === "pick-file" ? "openFile" : "openDirectory"] });
      if (channel === "export-pdf" || channel === "capture-region") preparedSave = saveDialog({ defaultPath: String(channel === "export-pdf" ? args[0] : args[1]) + (channel === "export-pdf" ? ".pdf" : ".png") });
      return invokeWithPermission(channel, args);
    },
    send(channel, ...args) { void dispatch("send", channel, args); },
    sendSync(channel, ...args) {
      if (args.length || channel === "sandbox") {
        void dispatch("send", channel, args);
        if (args.length) values[channel] = args[0];
      }
      if (!(channel in values) && channel !== "sandbox") throw new Error(`Worker has no synchronous value for ${channel}`);
      return values[channel];
    },
  },
  files: {
    isDirectory: filename => fs.statSync(filename).isDirectory(),
    resourcePath,
    basename: filename => path.basename(filename),
    trashItem: filename => fs.promises.rm(filename, { recursive: true }),
  },
  dialogs: { openDialog, saveDialog },
  revealPath,
  popupMenu,
  app: { name: "Obsen", version: "0.1.0", paths: { userData: "/data", documents: "/vaults", downloads: "/downloads", temp: "/tmp" } },
});
export const ipcRenderer = positron.ipcRenderer;
export const clipboard = positron.clipboard;
export const webFrame = positron.webFrame;
export const webUtils = positron.webUtils;
export const shell = positron.shell;
export const getRemote = positron.getRemote;
export const getElectron = positron.getElectron;
export const createWebview = positron.createWebview;
export function initializePreload(): void {}
export const createGraphWorker = (): Worker => new Worker(new URL("../src/graph/sim.ts", import.meta.url), { name: "Graph Worker", type: "module" });

const resources = new Map<string, { mtime: number; url: string }>();
const resourceFiles = new Map<string, string>();
const mimeTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", gif: "image/gif", webp: "image/webp", avif: "image/avif", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf" };
export function resourcePath(filename: string): string {
  const stat = fs.statSync(filename), cached = resources.get(filename);
  if (cached?.mtime === stat.mtimeMs) return cached.url;
  if (cached) { URL.revokeObjectURL(cached.url); resourceFiles.delete(cached.url); }
  const url = URL.createObjectURL(new Blob([new Uint8Array(fs.readFileSync(filename))], { type: mimeTypes[path.extname(filename).slice(1).toLowerCase()] ?? "application/octet-stream" }));
  resources.set(filename, { mtime: stat.mtimeMs, url }); resourceFiles.set(url, filename);
  return url;
}
export function resourceFilePath(url: string): string { return resourceFiles.get(url) ?? url; }

export async function mountHandle(handle: FileMount["handle"]): Promise<string> {
  const mounted = await worker.mount(handle); acceptState(mounted.state); return mounted.path;
}
async function openDialog(options: { properties?: string[]; defaultPath?: string } = {}): Promise<{ canceled: boolean; filePaths: string[] }> {
  try {
    if (options.properties?.includes("openDirectory") && "showDirectoryPicker" in window) {
      const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "obsen-vault" });
      return { canceled: false, filePaths: [await mountHandle(handle)] };
    }
    if ("showOpenFilePicker" in window) {
      const handles = await window.showOpenFilePicker({ multiple: options.properties?.includes("multiSelections") });
      return { canceled: false, filePaths: await Promise.all(handles.map(handle => mountHandle(handle))) };
    }
    return chooseFile(options.properties?.includes("openDirectory") ?? false);
  } catch (error) { if ((error as DOMException).name === "AbortError") return { canceled: true, filePaths: [] }; throw error; }
}
async function saveDialog(options: { defaultPath?: string } = {}): Promise<{ canceled: boolean; filePath?: string }> {
  try {
    if ("showSaveFilePicker" in window) {
      const handle = await window.showSaveFilePicker({ suggestedName: path.basename(options.defaultPath ?? "Untitled") });
      return { canceled: false, filePath: await mountHandle(handle) };
    }
    const filename = path.join("/downloads", path.basename(options.defaultPath ?? "Untitled"));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    return { canceled: false, filePath: filename };
  } catch (error) { if ((error as DOMException).name === "AbortError") return { canceled: true }; throw error; }
}
function chooseFile(directory: boolean): Promise<{ canceled: boolean; filePaths: string[] }> {
  return new Promise(resolve => {
    const input = document.createElement("input"); input.type = "file";
    input.multiple = directory;
    if (directory) input.setAttribute("webkitdirectory", "");
    input.addEventListener("cancel", () => resolve({ canceled: true, filePaths: [] }), { once: true });
    input.addEventListener("change", () => {
      void (async () => {
        const files = [...(input.files ?? [])];
        if (!files.length) return resolve({ canceled: true, filePaths: [] });
        const folder = directory ? path.join("/vaults", files[0].webkitRelativePath.split("/")[0]) : "/imports";
        fs.mkdirSync(folder, { recursive: true });
        for (const file of files) {
          const filename = directory ? path.join("/vaults", file.webkitRelativePath) : path.join(folder, file.name);
          fs.mkdirSync(path.dirname(filename), { recursive: true });
          fs.writeFileSync(filename, new Uint8Array(await file.arrayBuffer()));
        }
        acceptState(await worker.synchronize(diffFiles(baseline, snapshotFiles())));
        resolve({ canceled: false, filePaths: [directory ? folder : path.join(folder, files[0].name)] });
      })().catch(error => { console.error(error); resolve({ canceled: true, filePaths: [] }); });
    }, { once: true });
    input.click();
  });
}
export function initializePlatform(): Promise<void> {
  return initialized ??= (async () => {
    const assets: Record<string, string> = { [path.join(assetDirectory, "brand.txt")]: (await import("../brand.txt?raw")).default };
    for (const [filename, content] of Object.entries(assets)) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); }
    const handle = new Worker(new URL("./web-worker.ts", import.meta.url), { type: "module", name: "obsen-platform" });
    worker = wrap<PlatformWorker>(handle);
    const failed = new Promise<never>((_resolve, reject) => {
      handle.addEventListener("error", event => reject(new Error(event.message || "Browser platform worker failed to load")));
    });
    const host: BrowserHost = {
      emit(channel, args) { positron.receive(channel, ...args); },
      update: acceptState,
      openDialog: async options => { const selected = preparedOpen; preparedOpen = undefined; return selected ?? openDialog(options); },
      saveDialog: async options => { const selected = preparedSave; preparedSave = undefined; return selected ?? saveDialog(options); },
      openExternal: shell.openExternal,
      revealPath: async filename => revealPath(filename),
      capturePage: async rect => (await capturePage(rect)).toPNG(),
      printToPDF,
      executeJavaScript: async code => new Function(`return (${code})`)(),
      popupMenu,
      windowControl: async (action, value) => {
        if (action === "maximize") { if (navigator.userActivation.isActive) await document.documentElement.requestFullscreen(); document.body.classList.add("platform-maximized"); }
        else if (action === "minimize") {
          document.getElementById("root")!.hidden = true;
          const restore = document.createElement("button"); restore.id = "platform-restore"; restore.textContent = document.title;
          restore.onclick = () => { document.getElementById("root")!.hidden = false; restore.remove(); }; document.body.append(restore);
        } else if (action === "restore") { document.getElementById("root")!.hidden = false; document.getElementById("platform-restore")?.remove(); document.body.classList.remove("platform-maximized"); if (document.fullscreenElement) await document.exitFullscreen(); }
        else if (action === "always-on-top") document.body.classList.toggle("platform-pinned", value);
      },
    };
    const next = await Promise.race([worker.initialize(proxy(host), assets), failed]);
    acceptState(next, {});
    onFilesystemChange(() => dispatch("flush", ""));
    registerWebModule("electron", getElectron());
    registerWebModule("@electron/remote", getRemote());
    ipcRenderer.on("platform:error", (_event, error) => console.error(error));
    ipcRenderer.on("platform:close", () => window.close());
    window.addEventListener("platform-open-starter", () => ipcRenderer.send("starter"));
    const refresh = () => {
      const task = sequence.then(async () => { const expected = snapshotFiles(); const next = await worker.refresh(); acceptState(next, expected); });
      sequence = task.catch(error => console.error("Filesystem refresh:", error));
    };
    setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 2500);
    window.addEventListener("focus", refresh);
  })();
}
