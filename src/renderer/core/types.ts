import type { ReactNode } from "react";
import type { App } from "../../compat/plugin";
import type { RuntimeHost } from "../../compat/runtime-host";
import type { ViewCreator } from "../../compat/workspace";
import type { AppActions } from "../actions";
import type { VaultConfig } from "../config";
import type { CorePluginStore } from "../core-plugins";
import type { SettingsEnvironment } from "../settings/controls";

/** What a core plugin module gets from the host while it is enabled. */
export interface CorePluginContext {
  app: App;
  host: RuntimeHost;
  actions: AppActions;
  config: VaultConfig;
  corePlugins: CorePluginStore;
  /** The vault's configuration folder (absolute), where `<plugin>.json` option files live. */
  configDir: string;
}

/** A command from the pinned inventory (`src/controllers/command-inventory.ts`); its name comes from there. */
export interface CorePluginCommand {
  id: string;
  /** Returns false when the command does not apply right now. */
  check?: () => boolean;
  run: () => unknown;
}

export interface CorePluginRibbonAction { id: string; icon: string; title: string; onClick: () => void }

/**
 * A core plugin implemented as a self-contained module. The host installs it while the
 * plugin is enabled in `core-plugins.json` and tears it down when it is disabled.
 */
export interface CorePluginModule {
  /** Id from `CORE_PLUGINS` (for example "slides"). */
  id: string;
  /** View types the plugin provides, registered with the workspace while it is enabled. */
  views?(context: CorePluginContext): Record<string, ViewCreator>;
  /** File extensions opened by one of the plugin's view types. */
  extensions?: Record<string, string[]>;
  /** Commands, re-evaluated whenever commands are registered (also after a language change). */
  commands?(context: CorePluginContext): CorePluginCommand[];
  /** Ribbon buttons. Titles are resolved when the ribbon renders, so they follow the language. */
  ribbon?(context: CorePluginContext): CorePluginRibbonAction[];
  /** Anything else (event handlers, editor extensions, status bar items); returns a disposer. */
  install?(context: CorePluginContext): void | (() => void);
  /** The plugin's settings tab content. */
  settings?(props: { environment: SettingsEnvironment }): ReactNode;
}
