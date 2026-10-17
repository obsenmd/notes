import { defineConfig, normalizePath, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { build as bundleLibrary } from "esbuild";
// @ts-expect-error Runtime asset copier is shared with the Node build script.
import { copyRuntimeAssets } from "./scripts/runtime-assets.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
function platform(worker = false): Plugin {
  return {
    name: "obsen-platform", enforce: "pre",
    async resolveId(id, importer) {
      const inWorker = worker || !!importer?.includes("?platform-worker");
      if (/(?:^|\/)platforms\/platform(?:\.ts)?$/.test(id.replaceAll("\\", "/"))) return normalizePath(path.join(root, "platforms", inWorker ? "web-main.ts" : "web.ts"));
      if (importer?.includes("?platform-worker") && id.startsWith(".")) {
        const resolved = await this.resolve(id, importer.split("?")[0], { skipSelf: true });
        if (resolved && resolved.id.startsWith(path.join(root, "src").replaceAll("\\", "/"))) return resolved.id + "?platform-worker";
      }
    },
  };
}
const polyfills = () => nodePolyfills({ protocolImports: true, globals: { Buffer: true, global: true, process: true } });
function wasmBytes(): Plugin {
  return {
    name: "obsen-wasm-bytes", enforce: "pre",
    async load(id) {
      if (!id.endsWith("/publish_graph_bg.wasm")) return;
      const bytes = await readFile(id);
      return `export default Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), value => value.charCodeAt(0));`;
    },
  };
}
function browserLibraries(): Plugin {
  const bundles = new Map<string, { source: string; code: string }>();
  return {
    name: "obsen-browser-library-imports", enforce: "pre",
    async transform(code, id) {
      if (!/\/src\/compat\/(prism|editor-code-languages)\.ts$/.test(id.replaceAll("\\", "/"))) return;
      const cached = bundles.get(id);
      if (cached?.source === code) return { code: cached.code, map: null };
      // Preserve lazy CommonJS factories. Turning each require into an import
      // eagerly evaluated hundreds of grammars and made separate dev requests.
      const result = await bundleLibrary({
        entryPoints: [id], bundle: true, write: false, platform: "browser", format: "esm",
        target: "es2022", minify: true, treeShaking: true, legalComments: "inline",
      });
      const output = result.outputFiles[0].text;
      bundles.set(id, { source: code, code: output });
      return { code: output, map: null };
    },
  };
}
export default defineConfig(async ({ command }) => {
  const publicDirectory = path.join(root, ".handoff-work", command === "build" ? "web-public-build" : "web-public");
  await copyRuntimeAssets(publicDirectory);
  return {
  root,
  base: "./",
  publicDir: publicDirectory,
  server: { watch: { ignored: ["**/.handoff-work/**", "**/dist/**"] } },
  plugins: [platform(), polyfills(), tailwindcss(), browserLibraries(), wasmBytes()],
  worker: { format: "es", plugins: () => [platform(true), polyfills(), wasmBytes()] },
  build: {
    outDir: "dist/web", emptyOutDir: true, target: "es2022", minify: "esbuild", cssMinify: "esbuild", sourcemap: false,
    commonjsOptions: { include: [/node_modules/, /src/], extensions: [".js", ".ts", ".tsx"], transformMixedEsModules: true },
    rollupOptions: { input: "index.html", treeshake: true },
  },
};
});
