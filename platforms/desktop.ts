/** Native dependencies live here. Application code imports platform.ts. */
import { app, BrowserWindow, Menu, dialog, ipcMain, net, screen, shell, session,
  ipcRenderer, clipboard, webFrame, webUtils } from "electron";
import nativeProcess from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export { default as fs } from "node:fs";
export { readFileSync, writeFileSync, realpathSync } from "node:fs";
export type { WebContents } from "electron";
export { default as originalFs } from "original-fs";
export { default as fsp } from "node:fs/promises";
export { default as path } from "node:path";
export { fileURLToPath, pathToFileURL } from "node:url";
export { randomUUID, scrypt as nodeScrypt } from "node:crypto";
export { EventEmitter } from "node:events";
export { createRequire } from "node:module";
export { compileFunction } from "node:vm";
export { default as http } from "node:http";
export { default as https } from "node:https";
export { Buffer } from "node:buffer";
export const process = nativeProcess;
export const assetDirectory = __dirname;
export const readAsset = (relative: string): Promise<string> => readFile(join(assetDirectory, relative), "utf8");
export const target = "desktop" as const;
export { app, BrowserWindow, Menu, dialog, ipcMain, net, screen, shell, session,
  ipcRenderer, clipboard, webFrame, webUtils };
export const getElectron = () => ({ ipcRenderer, clipboard, shell, webFrame, webUtils, remote: getRemote() });
export const getRemote = (): typeof import("@electron/remote") => require("@electron/remote");
export const getRemoteMain = (): typeof import("@electron/remote/main") => require("@electron/remote/main");
export function initializePreload(): void {
  const electron = require("electron") as { remote?: ReturnType<typeof getRemote> };
  Object.defineProperty(electron, "remote", { configurable: true, enumerable: true, value: getRemote() });
}
export async function initializePlatform(): Promise<void> {}
export const resourcePath = (filename: string): string => pathToFileURL(filename).toString();
export const resourceFilePath = (value: string): string => value.startsWith("file:") ? fileURLToPath(value) : value;
export const createGraphWorker = (): Worker => new Worker(new URL("./sim.js", window.location.href), { name: "Graph Worker", type: "module" });
export const createWebview = (document: Document): Electron.WebviewTag => document.createElement("webview");
