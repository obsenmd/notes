import { fs, path, process } from "./web-node";
import { configureMain } from "../libs/positron/main";
import { version } from "../package.json";

configureMain({ version, appPath: "/app", paths: { userData: "/data", documents: "/vaults", downloads: "/downloads", temp: "/tmp" } });

export { fs, originalFs, fsp, readFileSync, writeFileSync, realpathSync, path,
  fileURLToPath, pathToFileURL, randomUUID, nodeScrypt, EventEmitter, createRequire,
  compileFunction, http, https, Buffer, process, assetDirectory, target } from "./web-node";
export { app, BrowserWindow, Menu, dialog, ipcMain, net, screen, shell, session,
  getRemoteMain, activeWindowId, connectHost, currentContents, events, handlers,
  eventFor } from "../libs/positron/main";
export type { WebContents } from "electron";
export { readAsset } from "./web-assets";

export function prepareWorkerFiles(assets: Record<string, string>): void {
  for (const directory of ["/app", "/data", "/vaults"]) fs.mkdirSync(directory, { recursive: true });
  for (const [filename, content] of Object.entries(assets)) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); }
  // Web pages use browser window chrome; the native frame preference is separate.
  fs.writeFileSync("/data/options.json", JSON.stringify({ ...readOptions(), frame: "native" }));
  process.platform = "linux";
}
function readOptions() { try { return JSON.parse(fs.readFileSync("/data/options.json", "utf8")); } catch { return {}; } }
