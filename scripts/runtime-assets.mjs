import { build, transform } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

/** Runtime libraries shared by the desktop archive and the web public directory. */
export async function copyRuntimeAssets(output, { stylesFile } = {}) {
  await fs.mkdir(path.join(output, 'lib'), { recursive: true });
  await fs.copyFile(require.resolve('@mozilla/readability/Readability.js'), path.join(output, 'lib/readability.js'));
  // The code editor uses Monaco's local AMD build so both the browser and the
  // Electron archive load its scripts, styles, fonts and workers without a CDN.
  // The AMD build loads its workers from assets/ (see ts.worker-*.js stubs). language/*/*.worker.js are unused
  // duplicates, and nls/lang only holds non-English Monaco strings, which this app never selects.
  const monacoRoot = path.dirname(require.resolve('monaco-editor'));
  await fs.cp(monacoRoot, path.join(output, 'monaco/vs'), { recursive: true, filter: source => {
    const relative = path.relative(monacoRoot, source).split(path.sep).join('/');
    return !/^language\/[^/]+\/[^/]+\.worker\.js$/.test(relative) && !/^nls\/lang\//.test(relative) && !relative.endsWith('.d.ts');
  } });
  await fs.cp(path.join(root, 'src/assets'), output, { recursive: true });
  await fs.copyFile(path.join(root, 'assets/obsidian/app.css'), path.join(output, 'app.css'));
  await fs.cp(path.join(root, 'assets/obsidian/public'), path.join(output, 'public'), { recursive: true });
  if (stylesFile) await fs.copyFile(stylesFile, path.join(output, 'styles.css'));
  // MathJax's loader and fonts resolve entirely inside the archive, including TeX extensions.
  {
    const mathjax = path.dirname(require.resolve('@mathjax/src/package.json')), target = path.join(output, 'lib/mathjax');
    const bundle = path.join(mathjax, 'bundle');
    // CHTML uses the separate TeX font. Other combined entry points duplicate
    // the engine; keep extension directories for dynamic package loading.
    const entryPoints = new Set(['tex-chtml-nofont.js', 'core.js', 'loader.js', 'startup.js', 'package.json']);
    await fs.cp(bundle, target, { recursive: true, filter: source => {
      const relative = path.relative(bundle, source);
      return !relative || relative.includes(path.sep) || !path.extname(relative) || entryPoints.has(relative);
    } });
    // Vite reuses public assets across config reloads. Retire old entry points.
    for (const file of await fs.readdir(target, { withFileTypes: true })) {
      if (file.isFile() && !entryPoints.has(file.name)) await fs.rm(path.join(target, file.name));
    }
    for (const [name, directory] of [['@mathjax/mathjax-tex-font', 'tex-font'], ['@mathjax/mathjax-mhchem-font-extension', 'mhchem-font-extension']]) {
      const font = path.dirname(require.resolve(name + '/package.json'));
      await fs.mkdir(path.join(target, directory), { recursive: true });
      await fs.copyFile(path.join(font, 'chtml.js'), path.join(target, directory, 'chtml.js'));
      await fs.cp(path.join(font, 'chtml'), path.join(target, directory, 'chtml'), { recursive: true });
    }
  }
  // pdf.js is not bundled: its library, viewer components and worker are ES modules loaded by URL on first use
  // (src/compat/pdf.ts), next to the character maps, standard fonts, image decoders and colour profiles they fetch.
  {
    const pdfjs = path.dirname(require.resolve('pdfjs-dist/package.json')), target = path.join(output, 'lib/pdfjs');
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(path.join(pdfjs, 'build/pdf.min.mjs'), path.join(target, 'pdf.min.mjs'));
    await fs.copyFile(path.join(pdfjs, 'build/pdf.worker.min.mjs'), path.join(target, 'pdf.worker.min.mjs'));
    // The viewer components are only published unminified.
    const viewerFile = path.join(pdfjs, 'web/pdf_viewer.mjs');
    const upstreamViewer = await fs.readFile(viewerFile, 'utf8');
    // The pinned reference's pdf.js fork retains 16px vertical fit padding.
    // Guard the patch so an upstream update cannot silently lose this behavior.
    const verticalPadding = 'const VERTICAL_PADDING = 5;';
    if (upstreamViewer.split(verticalPadding).length !== 2) throw new Error('Unexpected pdf.js vertical-padding implementation');
    let adaptedViewer = upstreamViewer.replace(verticalPadding, 'const VERTICAL_PADDING = 16;');
    // Reference scrolling starts at the page's outer edge, excluding its border.
    for (const [before, after] of [
      ['let offsetY = element.offsetTop + element.clientTop;', 'let offsetY = element.offsetTop;'],
      ['let offsetX = element.offsetLeft + element.clientLeft;', 'let offsetX = element.offsetLeft;'],
    ]) {
      if (adaptedViewer.split(before).length !== 2) throw new Error('Unexpected pdf.js page-scroll implementation');
      adaptedViewer = adaptedViewer.replace(before, after);
    }
    const viewer = await build({ stdin: { contents: adaptedViewer, resolveDir: path.dirname(viewerFile), sourcefile: viewerFile }, bundle: false, minify: true, format: 'esm', write: false, legalComments: 'inline' });
    await fs.writeFile(path.join(target, 'pdf.viewer.min.mjs'), viewer.outputFiles[0].contents);
    for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await fs.cp(path.join(pdfjs, directory), path.join(target, directory), { recursive: true });
    await fs.cp(path.join(pdfjs, 'web/images'), path.join(target, 'images'), { recursive: true, filter: source => !path.extname(source) || path.basename(source).startsWith('annotation-') });
    await fs.writeFile(path.join(target, 'version.json'), JSON.stringify({ version: JSON.parse(await fs.readFile(path.join(pdfjs, 'package.json'), 'utf8')).version }));
  }
  // English is bundled; the other locales are read on demand when the language changes.
  await fs.cp(path.join(root, 'assets/obsidian/locales'), path.join(output, 'locales'), { recursive: true, filter: source => !source.endsWith('index.json') });

  // Source assets bypass the application bundler. Minify these too, preserving
  // versioned *.min.js libraries and their license headers.
  await Promise.all([
    ...['app.css', 'lib/readability.js', ...(stylesFile ? ['styles.css'] : [])].map(async relative => {
      const filename = path.join(output, relative);
      const result = await transform(await fs.readFile(filename, 'utf8'), { loader: filename.endsWith('.css') ? 'css' : 'js', minify: true, legalComments: 'inline' });
      await fs.writeFile(filename, result.code);
    }),
    (async () => {
      for (const file of await fs.readdir(path.join(output, 'locales'), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.json')) {
          const filename = path.join(output, 'locales', file.name);
          await fs.writeFile(filename, JSON.stringify(JSON.parse(await fs.readFile(filename, 'utf8'))));
        }
      }
    })(),
  ]);
}
