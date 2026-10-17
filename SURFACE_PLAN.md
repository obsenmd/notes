# Desktop surface plan

The installed Obsidian 1.14.4 app and the supplied private reference tree are the behavior and appearance sources. The official plugin contract is the pinned `obsidian.d.ts` at `cc1744324150c632416857c98964f87b1574a5fc`. This plan treats a surface as complete only when its visible behavior, persisted state, events, and failure behavior have been implemented and compared with the reference.

Implementation and verification status are maintained in [TODO.md](TODO.md), with scoped evidence in [HANDOFF.md](HANDOFF.md) and [COMPATIBILITY.md](COMPATIBILITY.md). This plan defines the acceptance scope; it is not a completion claim. Earlier Node/build/hidden Electron checkpoints passed; final-tree checks and remaining surface, lifecycle, and API comparisons are tracked in the checklist.

## 1. Desktop shell and vault lifecycle

- Starter/vault chooser: recent vaults, open folder, create vault, remove from recents, missing-vault recovery, startup restore, and command-line/deep-link opening.
- Window model: main workspace, settings, pop-outs, prompts, dialogs, menus, drag/drop, multi-window focus, close/reopen behavior, and platform-specific title bar and menu integration.
- Vault data: local folder selection, `.obsidian` configuration, vault identity and migration, safe path handling, file watching, file events, trash behavior, and adapter abstraction.
- Main-process bridge: every observed IPC channel with its exact arguments, sync/async contract, return values, errors, side effects, and caller restrictions.
- Node/Electron surface: match the pinned app's renderer module resolution, `electron`, `original-fs`, Node built-ins, worker integration, and `@electron/remote`; preserve the reference's restricted webview guest behavior.

## 2. Workspace and editing surfaces

- Workspace frame: ribbon, left/right sidebars, tabs, split panes, status bar, view headers, empty state, command palette, quick switcher, global search, and keyboard navigation.
- Files and links: file explorer, create/rename/move/delete, attachments, internal links, embeds, backlinks, outgoing links, aliases, tags, properties, metadata cache, and file recovery.
- Editor: Markdown source and rendered modes, tabs, selection and cursor behavior, commands, hotkeys, autocomplete/suggestions, callouts, embeds, properties, folding, vim mode, and editor extensions.
- View system: workspace leaves, registered view types, state serialization, activation, detach/close, pop-out windows, and view lifecycle events.
- Content/rendering: Markdown renderer, code blocks, post-processors, resource URLs, SVG/icons, themes/CSS variables, snippets, localization, and print/export.

## 3. Settings and extensibility

- Settings pages: General, Appearance, Interface, Editor, Files and links, Hotkeys, Keychain, Core plugins, Community plugins, plus every page registered by plugins.
- Core plugins (exact internal-plugin registry in the pinned desktop bundle): `file-explorer`, `global-search`, `switcher`, `graph`, `backlink`, `outgoing-link`, `tag-pane`, `page-preview`, `daily-notes`, `templates`, `note-composer`, `command-palette`, `slash-command`, `editor-status`, `starred`, `markdown-importer`, `zk-prefixer`, `random-note`, `outline`, `word-count`, `slides`, `audio-recorder`, `workspaces`, `file-recovery`, `publish`, and `sync`. Implement enablement, defaults, saved settings, commands, views, events, and migrations for each. Canvas and Bases are also workspace surfaces and API families; the pinned app bundles them outside this internal plugin registry.
- Community plugins: browse/search, install/update/uninstall, enable/disable, version compatibility, manifest validation, settings tabs, permissions/Node access, error reporting, and safe startup recovery.
- Themes and snippets: browse/install/update/remove, theme activation, CSS snippets, asset/resource loading, and per-vault settings persistence.
- Icons and resources: built-in icon set, icon registration, SVG helpers, resource resolution, external links, localization strings, and appearance assets.

## 4. Official plugin API runtime

Use the generated 299-export inventory as the acceptance ledger. Implement runtime value exports and type-only contracts across:

- App, Plugin, PluginManifest, Component, Events, event references, cleanup registration, Platform, and lifecycle.
- Vault, abstract files, files/folders, adapters, file manager, attachments, trash, and configuration.
- MetadataCache, cached metadata, frontmatter, links, MarkdownRenderer, render contexts, and post-processors.
- Workspace, leaves, views, pop-outs, view state, and workspace events.
- Editor, positions/ranges/selections, commands, CodeMirror extensions, and editor suggestions.
- Modal, Notice, Menu, Setting, SettingTab, all input and suggestion controls, and searchable settings definitions.
- Commands, hotkeys, key scopes, callbacks, icons, DOM helpers, CSS classes/properties, paths, URLs, YAML, and utilities.
- Bases, formulas, custom views, rendering contexts, and SecretStorage.

Every export must point to an implementation module and have behavior evidence. Type-only declarations are compile-time obligations; classes, functions, enums, constants, and globals also require runtime behavior with compatible signatures and lifecycle semantics.

## 5. Sync, account, and Publish

- Account lifecycle: sign-in/out, sessions, device identity, subscription gates, network errors, and account settings.
- Sync: remote vault list/create/delete, initial download, upload/download, conflict resolution, file history, selective sync, exclusions, encryption/key management, pause/resume, status UI, retries, and WebSocket reconnect behavior.
- Publish: site setup, content selection, publish/unpublish, frontmatter and navigation, theme/domain settings, revision handling, and service error states.
- Use `private/docs` and the existing 37 desktop POST routes and 10 Sync WebSocket operations as protocol sources; map each operation to a real UI workflow before declaring it covered.

## 6. Implementation sequence and gates

1. Freeze the versioned reference inventory and capture named screens/workflows, complete IPC payload contracts, exact core-plugin list, and the API export ledger.
2. Finish the local vault lifecycle and Electron compatibility shell.
3. Build the filesystem, events, metadata, workspace/view, and editor foundations.
4. Implement settings and the plugin runtime, closing API exports by module family.
5. Port core plugins, then community plugin and theme/resource management.
6. Integrate account, Sync, and Publish against the private service contracts.
7. Compare each named workflow with reference evidence, record remaining gaps, and close API, IPC, UI, storage, plugin, and multi-window acceptance records.

## Current implementation checkpoint

The desktop app now implements the shell, vault lifecycle, Markdown editor and reading view, sidebar panes, settings, core plugins, Canvas, Bases, a Web viewer, PDF handling, a plugin API runtime, and Account/Sync/Publish workflows. `TODO.md` records which of these have passed comparison and which still need behavior, lifecycle, API, or pixel verification. The historical implementation sequence above describes the work's scope; it is not a claim that every acceptance gate is complete.
