# Positron

Electron API shims for browser applications that run their main handlers in a
web worker. This private package exports TypeScript source for the application's
bundler. Use `vite-plugin-node-polyfills` in both renderer and worker builds for
the standard Node modules used by Positron.

## Entry points

- `index.ts`: `createPositronRenderer`, native images, page capture and PDF export.
- `main.ts`: worker implementations of `app`, `BrowserWindow`, `ipcMain`, `Menu`,
  `dialog`, `net`, `screen`, `shell`, and `session`.
- `webview.ts`: browser frames, navigation events, page search, reader extraction,
  and a `webContents` registry for the renderer.
- `types.ts`: transport and host interfaces plus the generated Electron types.

`createPositronRenderer(options)` receives an IPC transport, filesystem services,
application paths, dialogs, a menu renderer, and a folder browser. It returns
named Electron APIs plus `receive(channel, ...args)` for worker events and
`dispose()` for cleanup. File `shell.openPath` downloads the original filename;
directory opens use the supplied folder browser.

In the worker, call `configureMain` with application paths and version, then
`connectHost` with the browser services and a callback for window changes.
The worker transport dispatches through `handlers`, `events`, and `eventFor`.
Neither entry point imports application code or owns vault persistence.

Web views obey the browser's frame and cross-origin policies. They expose an
"Open in browser" link for sites that require a full browser tab. Script access,
page search, and reader extraction use accessible documents or CORS-enabled
responses. Session clearing removes Positron's namespaced storage and cached
documents; it does not remove the application's vault or settings. Navigation
filters run through the worker; the browser governs third-party subresources.

## Electron types

Run `npm run generate:electron-types` from the repository root, or
`npm run generate:types` in this directory. The generator uses
`@electron/typescript-definitions` and the installed Electron version's API JSON.
Both the schema and generated declarations live in `generated/`. They are a
type module, so they do not duplicate Electron's global Node and DOM declarations.
