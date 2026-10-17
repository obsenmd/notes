# Obsen Desktop

A re-creation of the Obsidian 1.14.4 desktop app: Electron, React 19 (TSX), Tailwind v4, CodeMirror 6, i18next, and a custom Pixi/WASM graph viewer.

## Run and verify

- `npm run dev:web` opens the Vite app at `/` with live updates. `npm run build:web` builds `dist/web/index.html`.
- `npm run preview:web` serves the optimized web build on port 4173 for performance checks. Development keeps React diagnostics and source maps.
- The browser Electron polyfill lives in [`libs/positron`](libs/positron/README.md); `platforms/` supplies filesystem, dialogs, and application services.
- `npm start` builds and opens the app. After `npm run build`, `npx electron . --vault "C:\path\to\vault"` opens a particular vault.
- `npm test` runs the type check, the locale-key check and the Node-side smoke tests (workspace, commands, community plugins, editor, sync model, Bases formulas/query/storage, and graph WASM append behavior).
- `npm run test:electron` launches the built app against a temporary vault and profile.
- `npm run test:electron:bases-audit` verifies 1,200-note sorting, scrolling, grouping, disk edits, custom summaries and community Bases views/options in offscreen windows.
- `npm run test:editor-followups` checks editor menu and hover lifecycle contracts in Node; `npm run test:electron:editor-followups` checks the menu, search previews, and plugin settings in hidden Electron windows. Electron smoke runs keep windows hidden and skip screenshots by default; screenshot capture is opt-in with `OBSEN_SMOKE_CAPTURE=1`.
- `npm run check:locales` verifies every `t("…")` key used in the source exists in the language resources. `npm run check:copy` lists string literals that look like user-facing copy but bypass them.

## How the UI is built

The renderer emits the same DOM structure and class names as the reference app, and the reference stylesheet (`assets/obsidian/app.css`) styles it. Tailwind is loaded without preflight (theme and utilities only, mapped onto the app's CSS variables) and is used for the few places that need layout glue. A change is checked by comparing DOM outlines and screenshots with the reference app.

| Area | Where |
| --- | --- |
| Main process: windows, vault registry, dialogs, IPC | `src/main.ts`, `src/runtime/` |
| Workspace shell, tabs, splits, stacked tabs, pop-outs | `src/renderer/WorkspaceShell.tsx`, `WorkspaceTree.tsx`, `src/compat/workspace.ts` |
| File explorer and sidebar panes | `src/renderer/FileExplorer.tsx`, `SidebarPanes.tsx` |
| Editor: Live Preview, source mode, reading view | `src/compat/obsidian-markdown.ts`, `codemirror-host.ts`, `markdown-view.ts`, `markdown-parser.ts`, `math.ts`, `document-search.ts` |
| Graph view and local graph | `src/renderer/GraphView.tsx` on top of `src/graph/PixiGraph.tsx` (simulation in `graph-sim-wasm/`) |
| Canvas, Bases, Web viewer | `src/renderer/CanvasView.tsx`, `BasesFileView.ts` + `bases/`, `WebViewer.ts` |
| Settings (modal or own window), community browser | `src/renderer/Settings.tsx`, `settings/`, `CommunityModal.tsx` |
| Commands, palette, quick switcher | `src/renderer/commands.ts`, `prompts.ts`, `src/compat/editor-actions.ts`, `src/controllers/command-inventory.ts` |
| Hover page preview | `src/renderer/hover-preview.ts` |
| Vault chooser | `src/renderer/Starter.tsx` |
| Plugin API runtime (`obsidian` module) | `src/compat/` |

## Copy and languages

All copy goes through i18next (`src/i18n`). The copied resources use the reference app's key namespace, one file per language in `assets/obsidian/locales/` (51 languages); copy that has no counterpart there lives under the `obsen.*` keys in `src/locales/app/en.json`. The copied stylesheet, language files, images, and Lucide table are grouped under `assets/obsidian/`. The 44 custom reference glyphs are individual `assets/icons/{name}.svg` files; `npm run build:icon-index` refreshes their runtime index. `brand.txt` renames the product in every string and can override individual keys. The main process shares the renderer's language for dialog titles and error messages.

`scripts/build-locales.mjs` and `scripts/build-icons.mjs` regenerate the language files and the icon table from a reference bundle.

## Vault data

Settings and state are stored in the same files and shapes as the reference (`.obsidian/app.json`, `appearance.json`, `core-plugins.json`, `workspace.json`, `graph.json`, `bookmarks.json`, `hotkeys.json`, per-plugin JSON files, `themes/`, `snippets/`, `plugins/`), so a vault can be opened by either app.

Completion status is tracked in [TODO.md](TODO.md); current evidence and remaining limits are in [HANDOFF.md](HANDOFF.md) and [COMPATIBILITY.md](COMPATIBILITY.md). PDF views and embeds, Canvas, Bases, Web viewer, and plugin settings are implemented, but their open checklist items still need comparison or lifecycle evidence. Passing smoke tests does not establish complete behavior or pixel parity.

## Compatibility baseline

- Visual and behavior reference: Obsidian 1.14.4.
- Plugin API: official `obsidian.d.ts` snapshot at commit `cc1744324150c632416857c98964f87b1574a5fc` (published package 1.13.2).
- Desktop API: Electron 43.7.7 and Node 24.21.0. Desktop plugins receive Node/Electron modules and the `electron.remote` compatibility surface.
- Service protocols: `protos/` contains the account/publishing schemas; the observed HTTP and Sync WebSocket contracts are documented in [`reference/protocols/`](reference/protocols/README.md).

See `COMPATIBILITY.md` for what is and is not at parity. The stylesheet, language resources and icon set are taken from the reference app; whether they can be redistributed is a licensing question to settle before shipping.

The remaining implementation and verification work is tracked in [`TODO.md`](TODO.md). `scripts/dev/launch-reference-fixture.mjs` runs the installed Obsidian in an isolated offscreen fixture (port 9351); `node scripts/electron-smoke.mjs --bases-compare` opens the matching Obsen fixture (port 9341). `scripts/dev/compare-bases.mjs` captures paired surfaces, and `compare-capture-pixels.py` measures their pixel differences. These helpers use temporary vaults and never show or focus a native window.

## Reference assets (not in this repository)

The Obsidian-derived reference material (`assets/obsidian/`, `assets/icons/`, `reference/`) is proprietary and excluded from version control. Building the full UI requires supplying it locally from a licensed Obsidian install; see `scripts/build-locales.mjs`, `scripts/build-icons.mjs` and `scripts/design-extract-css.mjs`.
