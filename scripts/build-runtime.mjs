import { copyRuntimeAssets } from './runtime-assets.mjs';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, builtinModules } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// OBSEN_DIST builds into another directory, so parallel workers do not overwrite each other's bundle.
const dist = process.env.OBSEN_DIST ? path.resolve(process.env.OBSEN_DIST) : path.join(root, 'dist');
const output = path.join(dist, 'source-app');
const require = createRequire(import.meta.url);
// Start from an empty directory so removed sources never linger in the archive.
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
// Explicit resolution keeps builds inside the workspace in restricted environments.
const sources = { name: 'source-files', setup(builder) {
  const nodeRequire = builder.initialOptions.format === 'esm' && builder.initialOptions.platform === 'browser';
  builder.onResolve({ filter: /.*/ }, async args => {
    // CSS resources are copied intact with the versioned assets below. Preserve
    // embedded data URLs and relative public/font paths for the renderer.
    if (args.kind === 'url-token') return { path: args.path, external: true };
    if (args.path === 'electron' || args.path === 'original-fs' || args.path.startsWith('node:') || builtinModules.includes(args.path)) {
      // A browser ESM bundle cannot import these; the renderer has Node integration, so read them with require().
      return nodeRequire && args.namespace !== 'node-require' ? { path: args.path, namespace: 'node-require' } : { path: args.path, external: true };
    }
    let filename;
    if (args.path.startsWith('.') || path.isAbsolute(args.path)) {
      const candidate = path.resolve(args.resolveDir || root, args.path);
      for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.js']) {
        if (await fs.stat(candidate + suffix).then(s => s.isFile()).catch(() => false)) { filename = candidate + suffix; break; }
      }
    } else filename = require.resolve(args.path, { paths: [args.resolveDir || root] });
    if (!filename) throw new Error(`Cannot resolve ${args.path} from ${args.resolveDir}`);
    return { path: filename, namespace: 'source' };
  });
  builder.onLoad({ filter: /.*/, namespace: 'node-require' }, args => ({ contents: `module.exports = require(${JSON.stringify(args.path)});`, loader: 'js' }));
  builder.onLoad({ filter: /.*/, namespace: 'source' }, async args => {
    let contents = await fs.readFile(args.path);
    if (args.path === require.resolve('reveal.js')) {
      // The reference's Reveal 4.3.1 uses transforms on desktop. Chromium's zoom
      // now changes layout, so the upstream zoom branch changes slide sizing.
      const branch = 'h>1&&Dh&&window.devicePixelRatio<2';
      const source = contents.toString();
      if (source.split(branch).length !== 2) throw new Error('Reveal transform patch no longer matches the pinned dependency');
      contents = source.replace(branch, 'false');
    }
    return {
    contents, resolveDir: path.dirname(args.path),
    loader: ({ '.ts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx', '.json': 'json', '.css': 'css', '.wasm': 'binary' })[path.extname(args.path)] || 'js',
    };
  });
} };
const common = {
  absWorkingDir: root, plugins: [sources], tsconfigRaw: { compilerOptions: { target: 'ES2022', jsx: 'react-jsx' } },
  bundle: true, target: 'es2022', minify: true, treeShaking: true, keepNames: true,
  legalComments: 'linked', define: { 'process.env.NODE_ENV': '"production"' },
};
await Promise.all([
  build({ ...common, entryPoints: ['./src/main.ts'], platform: 'node', format: 'cjs', outfile: path.join(output, 'main.cjs') }),
  build({ ...common, entryPoints: ['./src/preload.ts'], platform: 'node', format: 'cjs', outfile: path.join(output, 'preload.cjs') }),
  // ESM with splitting turns dynamic import() (Mermaid, Reveal, Prism, ...) into chunks fetched on first use.
  build({ ...common, entryPoints: ['./src/renderer/main.tsx'], platform: 'browser', format: 'esm', splitting: true, entryNames: 'renderer', chunkNames: 'chunks/[name]-[hash]', define: { 'process.env.NODE_ENV': '"production"' }, outdir: output }),
  build({ ...common, entryPoints: ['./src/graph/sim.ts'], platform: 'browser', format: 'esm', outfile: path.join(output, 'sim.js') }),
]);
await fs.copyFile(path.join(root, 'src/renderer/index.html'), path.join(output, 'index.html'));
await fs.copyFile(path.join(root, 'brand.txt'), path.join(output, 'brand.txt'));
await copyRuntimeAssets(output, { stylesFile: path.join(dist, 'styles.css') });

// ASAR's filesystem header is a Chromium Pickle followed by file contents.
// Every entry below comes from this application's build output.
const files = {}, payload = [];
let offset = 0;
async function archiveDirectory(directory, entries) {
  for (const name of (await fs.readdir(directory)).sort()) {
    const filename = path.join(directory, name);
    if ((await fs.stat(filename)).isDirectory()) {
      entries[name] = { files: {} }; await archiveDirectory(filename, entries[name].files);
    } else {
      const bytes = await fs.readFile(filename);
      entries[name] = { size: bytes.length, offset: String(offset) };
      payload.push(bytes); offset += bytes.length;
    }
  }
}
await archiveDirectory(output, files);
// A missing entry point must fail the build instead of producing an unusable archive.
for (const name of ['main.cjs', 'preload.cjs', 'renderer.js', 'index.html', 'sim.js', 'styles.css', 'app.css', 'brand.txt', 'pixi.min.js', 'unsafe-eval.min.js']) {
  if (!files[name]?.size) throw new Error(`Incomplete application archive: missing ${name}`);
}
const json = Buffer.from(JSON.stringify({ files }));
const headerSize = 8 + Math.ceil(json.length / 4) * 4;
const header = Buffer.alloc(8 + headerSize);
header.writeUInt32LE(4, 0); header.writeUInt32LE(headerSize, 4);
header.writeUInt32LE(headerSize - 4, 8); header.writeUInt32LE(json.length, 12);
json.copy(header, 16);
await fs.writeFile(path.join(dist, 'app.asar'), Buffer.concat([header, ...payload]));
for (const name of ['obsidian.asar', 'bootstrap.cjs', 'native-main.cjs', 'main.cjs']) await fs.rm(path.join(dist, name), { force: true });
console.log(process.env.OBSEN_DIST ? `Built ${path.join(dist, 'app.asar')} from the application source.` : 'Built dist/app.asar from the application source.');
