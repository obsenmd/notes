import { Buffer } from "node:buffer";
import path from "node:path";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import browserProcess from "node:process";
import events from "node:events";
import util from "node:util";
import os from "node:os";
import browserCrypto from "node:crypto";
import stream from "node:stream";
import url from "node:url";
import assert from "node:assert";
import zlib from "node:zlib";
import stringDecoder from "node:string_decoder";
import querystring from "node:querystring";
import timers from "node:timers";
import timerPromises from "node:timers/promises";
import http from "node:http";
import https from "node:https";
import { fs, fsp } from "./web-filesystem";

export { Buffer, path, fs, fsp, http, https };
export { EventEmitter } from "node:events";
export const originalFs = fs;
export const readFileSync = fs.readFileSync.bind(fs);
export const writeFileSync = fs.writeFileSync.bind(fs);
export const realpathSync = Object.assign(fs.realpathSync.bind(fs), { native: fs.realpathSync.bind(fs) });
export const assetDirectory = "/app";
export const target = "web" as const;
export const randomUUID = () => crypto.randomUUID();
export const process = Object.assign(browserProcess, {
  cwd: () => "/", argv: [] as string[], pid: 1,
  platform: /Mac|iPhone|iPad/.test(navigator.userAgent) ? "darwin" : /Windows/.test(navigator.userAgent) ? "win32" : "linux",
});
export function pathToFileURL(filename: string): URL { return new URL("file://" + path.resolve(filename).split("/").map(encodeURIComponent).join("/")); }
export function fileURLToPath(value: string | URL): string {
  const url = new URL(value);
  if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) throw new TypeError("Expected a local file URL");
  return decodeURIComponent(url.pathname);
}
export const nodeScrypt: typeof import("node:crypto").scrypt = ((password: Uint8Array, salt: Uint8Array, length: number, options: { N: number; r: number; p: number; maxmem: number }, callback: (error: Error | null, key?: Buffer) => void) => {
  void scryptAsync(password, salt, { ...options, dkLen: length }).then(key => callback(null, Buffer.from(key)), error => callback(error));
}) as typeof import("node:crypto").scrypt;
export const compileFunction: typeof import("node:vm").compileFunction = ((source: string, parameters: string[] = []) => new Function(...parameters, source)) as typeof import("node:vm").compileFunction;

// These imports are implemented by vite-plugin-node-polyfills in both contexts.
// Expose the same implementations to installed CommonJS plugins.
const nativeModules = new Map<string, unknown>([
  ["fs", fs], ["original-fs", fs], ["fs/promises", fsp], ["path", path], ["path/posix", path],
  ["buffer", { Buffer }], ["process", process], ["events", events], ["util", util], ["os", os],
  ["crypto", { ...browserCrypto, randomUUID, scrypt: nodeScrypt, webcrypto: globalThis.crypto }],
  ["stream", stream], ["url", { ...url, URL, URLSearchParams, fileURLToPath, pathToFileURL }],
  ["assert", assert], ["zlib", zlib], ["string_decoder", stringDecoder], ["querystring", querystring],
  ["timers", timers], ["timers/promises", timerPromises], ["http", http], ["https", https],
]);
const moduleCache: NodeJS.Dict<NodeModule> = {};
export function registerWebModule(name: string, value: unknown): void { nativeModules.set(name, value); }
export function createRequire(entry: string): NodeRequire {
  const filename = entry.startsWith("file:") ? fileURLToPath(entry) : path.resolve(entry);
  const directories = (directory: string): string[] => {
    const result: string[] = [];
    for (;;) {
      if (path.basename(directory) !== "node_modules") result.push(path.join(directory, "node_modules"));
      const parent = path.dirname(directory);
      if (directory === parent) return result;
      directory = parent;
    }
  };
  const resolvePath = (candidate: string, visited = new Set<string>()): string | undefined => {
    if (visited.has(candidate)) return;
    visited.add(candidate);
    for (const file of [candidate, candidate + ".js", candidate + ".cjs", candidate + ".json"]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
    const manifest = path.join(candidate, "package.json");
    if (fs.existsSync(manifest)) {
      const main = JSON.parse(fs.readFileSync(manifest, "utf8")).main;
      if (typeof main === "string") {
        const resolved = resolvePath(path.resolve(candidate, main), visited);
        if (resolved) return resolved;
      }
    }
    for (const index of ["index.js", "index.cjs", "index.json"]) {
      const file = path.join(candidate, index);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  };
  const resolve = (request: string): string => {
    const name = request.replace(/^node:/, "");
    if (nativeModules.has(name)) return name;
    const candidates = request.startsWith(".") || request.startsWith("/")
      ? [path.resolve(path.dirname(filename), request)]
      : directories(path.dirname(filename)).map(directory => path.join(directory, request));
    for (const candidate of candidates) {
      const resolved = resolvePath(candidate);
      if (resolved) return resolved;
    }
    throw Object.assign(new Error(`Cannot resolve browser plugin dependency: ${request}`), { code: "MODULE_NOT_FOUND" });
  };
  const load = ((request: string) => {
    const key = resolve(request);
    if (nativeModules.has(key)) return nativeModules.get(key);
    const existing = moduleCache[key];
    if (existing) return existing.exports;
    const require = createRequire(key);
    const module = { id: key, filename: key, path: path.dirname(key), exports: {}, loaded: false, children: [], paths: directories(path.dirname(key)), require } as unknown as NodeModule;
    moduleCache[key] = module;
    try {
      const source = fs.readFileSync(key, "utf8").replace(/^\uFEFF/, "");
      if (key.endsWith(".json")) module.exports = JSON.parse(source);
      else {
        const execute = compileFunction(source.replace(/^#![^\n]*/, ""), ["require", "module", "exports", "__filename", "__dirname"], { filename: key });
        execute(require, module, module.exports, key, path.dirname(key));
      }
      module.loaded = true;
      return module.exports;
    } catch (error) { delete moduleCache[key]; throw error; }
  }) as NodeRequire;
  load.resolve = Object.assign(resolve, { paths: (request: string) => nativeModules.has(request.replace(/^node:/, "")) ? null : directories(path.dirname(filename)) });
  load.cache = moduleCache;
  load.extensions = {} as NodeJS.RequireExtensions;
  return load;
}
nativeModules.set("module", { createRequire, builtinModules: [...nativeModules.keys()] });
