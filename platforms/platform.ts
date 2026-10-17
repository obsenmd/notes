// The native default also works with standalone Node/esbuild consumers. Vite's
// platform alias replaces this module with web.ts for browser builds.
export type { WebContents } from "./desktop";
export { fs, originalFs, fsp, readFileSync, writeFileSync, realpathSync, path, fileURLToPath, pathToFileURL,
  randomUUID, nodeScrypt, EventEmitter, createRequire, compileFunction, http, https,
  Buffer, process, assetDirectory, readAsset, target, app, BrowserWindow, Menu, dialog, ipcMain,
  net, screen, shell, session, ipcRenderer, clipboard, webFrame, webUtils, getElectron,
  getRemote, getRemoteMain, initializePreload, initializePlatform, resourcePath, resourceFilePath, createGraphWorker, createWebview } from "./desktop";
