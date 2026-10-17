import { path, originalFs as fs, ipcRenderer } from "../../platforms/platform";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";



import moment from "moment";
import { Keymap } from "../compat/commands";
import { getDailyNote } from "./core/daily-notes";
import { migrateStartupPreference, runStartupBehavior } from "./startup";
import type { Hotkey } from "../compat/commands";
import { CoreDockView, isCoreDockType } from "../compat/core-view";
import { FileView } from "../compat/file-views";
import { RuntimeHost } from "../compat/runtime-host";
import { Menu, Notice } from "../compat/ui";
import type { WorkspaceLeaf } from "../compat/workspace";
import { brandName, t } from "../i18n";
import { useT } from "../i18n/react";
import { AppActions } from "./actions";
import { watchAppearance, watchPopoutAppearance } from "./appearance";
import { BookmarkStore } from "./bookmarks";
import { registerCoreCommands } from "./commands";
import { VaultConfig } from "./config";
import { CorePluginStore, useCorePlugins, watchCoreHoverLinkSources } from "./core-plugins";
import { FileExplorer, addFileMenuItems, hasFileMenuItems, renameInExplorer } from "./FileExplorer";
import { TFile, TFolder } from "../compat/vault";
import { SettingsModal } from "./Settings";
import { openPublishModal } from "./PublishModal";
import { isRestrictedMode, trustVaultIfAsked } from "./settings/tabs-plugins";
import { BacklinksPane, BookmarksPane, OutgoingLinksPane, OutlinePane, PropertiesPane, SearchPane, TagPane } from "./SidebarPanes";
import { Starter } from "./Starter";
import { StatusBarItems } from "./StatusBar";
import { watchCustomCss } from "./custom-css";
import { CORE_PLUGIN_MODULES, type CorePluginContext } from "./core";
import { chooseButton } from "../controllers/dialogs";
import { installHoverPreview } from "./hover-preview";
import { installUriHandler } from "./uri";
import { installAppMenu, requestAppMenuRender } from "./app-menu";
import { watchEmbeddedBacklinks } from "./embedded-backlinks";
import { MarkdownView } from "../compat/markdown-view";
import { getActiveVault, type ActiveVault } from "./vault-fs";
import { Titlebar, WorkspaceShell, type RibbonAction } from "./WorkspaceShell";
import { WorkspaceLeaves, WorkspaceHostProvider, leafTitle, type EmptyStateAction, type WorkspaceHost } from "./WorkspaceTree";
import { LoadingSurface } from "./LoadingSurface";
import { finishStartupLoading } from "./loading";

const APP_VERSION: string = ipcRenderer.sendSync("version");

export function App() {
  const [vault, setVault] = useState(getActiveVault);
  useLayoutEffect(finishStartupLoading, []);
  useEffect(() => {
    const refresh = () => setVault(getActiveVault());
    window.addEventListener("platform-vault-changed", refresh);
    return () => window.removeEventListener("platform-vault-changed", refresh);
  }, []);
  return vault ? <VaultWindow key={vault.id} vault={vault} /> : <Starter version={APP_VERSION} />;
}

interface Environment { host: RuntimeHost; config: VaultConfig; corePlugins: CorePluginStore; bookmarks: BookmarkStore; actions: AppActions }

const LEFT_DOCK = ["file-explorer", "search", "bookmarks"] as const;
const RIGHT_DOCK = ["backlink", "outgoing-link", "tag", "all-properties", "outline"] as const;
const DOCK_PLUGIN: Record<string, string> = { "file-explorer": "file-explorer", search: "global-search", bookmarks: "bookmarks", backlink: "backlink", "outgoing-link": "outgoing-link", tag: "tag-pane", "all-properties": "properties", outline: "outline" };

function VaultWindow({ vault }: { vault: ActiveVault }) {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [failure, setFailure] = useState("");
  const [settings, setSettings] = useState<{ open: boolean; tab?: string }>({ open: false });
  const settingsRef = useRef(setSettings);

  useEffect(() => {
    let cancelled = false, created: Environment | undefined, stopAppearance: (() => void) | undefined, stopCss: (() => void) | undefined, stopHover: (() => void) | undefined, stopUri: (() => void) | undefined, stopMenu: (() => void) | undefined, stopHoverSources: (() => void) | undefined;
    void (async () => {
      const config = new VaultConfig(vault.path);
      const corePlugins = new CorePluginStore(config.configDir);
      const bookmarks = new BookmarkStore(config.configDir);
      await Promise.all([config.load(), corePlugins.load(), bookmarks.load()]);
      stopAppearance = watchAppearance(config);
      stopCss = watchCustomCss(config);
      let actions: AppActions | undefined;
      const ui = { openSettings: (tab?: string) => settingsRef.current({ open: true, tab }), openVaultChooser: () => ipcRenderer.send("starter") };
      const host = await RuntimeHost.create({
        vaultPath: vault.path, vaultId: vault.id, vaultName: vault.name, storage: window.localStorage, corePlugins: corePlugins.snapshot(), restrictedMode: isRestrictedMode(vault.path),
        onPluginError: (id, error) => { console.error(`Plugin ${id} failed`, error); new Notice(t("interface.msg-plugin-error", { name: id, plugin: id })); },
        prepareVault: async host => {
          host.vault.configStore = config;
          actions = new AppActions(host, config, corePlugins, vault.path, ui);
          host.app.editorOptions = { ...host.app.editorOptions, defaultViewMode: config.get("defaultViewMode"), livePreview: config.get("livePreview") };
          await migrateStartupPreference(actions);
        },
      });
      if (cancelled) { host.dispose(); return; }
      const stopMainAppearance = stopAppearance;
      const stopPopoutAppearance = watchPopoutAppearance(config, host.workspace);
      stopAppearance = () => { stopPopoutAppearance(); stopMainAppearance?.(); };
      actions ??= new AppActions(host, config, corePlugins, vault.path, ui);
      await runStartupBehavior(actions);
      if (cancelled) { host.dispose(); return; }
      // Plugins and the developer console reach the application through the `app` global.
      (window as unknown as { app: unknown }).app = host.app;
      host.app.keymap.pushScope(host.app.commands.rootScope);
      host.app.keymap.listen();
      if (vault.sandbox) new Notice(t("interface.msg-sandbox-vault"), 10000);
      stopHoverSources = watchCoreHoverLinkSources(host.workspace, corePlugins);
      stopHover = installHoverPreview(host.app, { isEnabled: () => corePlugins.isEnabled("page-preview"), configDir: config.configDir });
      await ensureDockViews(host, corePlugins.snapshot(), null);
      void trustVaultIfAsked(host.app, vault.path, config.configDir);
      // Renames ask before rewriting links unless "Automatically update internal links" is on.
      host.app.fileManager.linkUpdateHost = {
        confirm: async (links, files) => {
          if (config.get("alwaysUpdateLinks")) return true;
          const answer = await chooseButton(host.app, {
            title: t("dialogue.label-update-links"),
            message: [t("dialogue.label-confirm-update-link-to-file"), t("dialogue.label-link-affected", { links: t("nouns.link-with-count", { count: links }), files: t("nouns.file-with-count", { count: files }) })],
            choices: [{ label: t("dialogue.button-always-update"), value: "always", cta: true }, { label: t("dialogue.button-just-once"), value: "once" }, { label: t("dialogue.button-do-not-update"), value: "no" }],
          });
          if (answer === "always") config.set("alwaysUpdateLinks", true);
          return answer === "always" || answer === "once";
        },
        done: (links, files) => new Notice(t("dialogue.msg-updated-links", { links: t("nouns.link-with-count", { count: links }), files: t("nouns.file-with-count", { count: files }) })),
      };
      host.vault.configStore = config;
      stopUri = installUriHandler(host.app, actions);
      stopMenu = installAppMenu(host.app);
      created = { host, config, corePlugins, bookmarks, actions };
      setEnvironment(created);
    })().catch((error: Error) => {
      console.error("Failed to open vault", error);
      if (!cancelled) setFailure(t("interface.start-screen.msg-error-failed-to-open-vault"));
    });
    return () => { cancelled = true; stopAppearance?.(); stopCss?.(); stopHover?.(); stopUri?.(); stopMenu?.(); stopHoverSources?.(); created?.host.app.keymap.stopListening(); created?.host.dispose(); };
  }, [vault.path, vault.name]);

  if (failure) return <><Titlebar title={vault.name} /><div className="app-container"><div className="empty-state"><div className="empty-state-container"><div className="empty-state-title">{failure}</div></div></div></div></>;
  if (!environment) return <><Titlebar title={`${vault.name} - ${brandName()} ${APP_VERSION}`} /><LoadingSurface message={t("interface.start-up.loading-vault")} /></>;
  return <Workspace vault={vault} environment={environment} settings={settings} setSettings={setSettings} />;
}

/** Opens the built-in sidebar views when a dock is empty, or when their plugin was just enabled. */
async function ensureDockViews(host: RuntimeHost, enabled: Record<string, boolean>, previous: Record<string, boolean> | null): Promise<void> {
  const { workspace } = host;
  for (const side of ["left", "right"] as const) {
    const dock = side === "left" ? workspace.leftSplit : workspace.rightSplit;
    const initiallyEmpty = !dock?.children.length;
    let first: WorkspaceLeaf | null = null;
    for (const type of side === "left" ? LEFT_DOCK : RIGHT_DOCK) {
      const plugin = DOCK_PLUGIN[type];
      if (!enabled[plugin] || workspace.getLeavesOfType(type).length) continue;
      if (!initiallyEmpty && !(previous && previous[plugin] === false)) continue;
      const leaf = workspace.createDockLeaf(side);
      await leaf.setViewState({ type });
      first ??= leaf;
    }
    const current = side === "left" ? workspace.leftSplit : workspace.rightSplit;
    if (initiallyEmpty && first && current) {
      first.parent?.activateLeaf(first);
      if (side === "right") current.collapse(); else current.expand();
      current.dimension ??= 300;
    }
  }
  workspace.notifyLayoutChange();
}

function Workspace({ vault, environment, settings, setSettings }: { vault: ActiveVault; environment: Environment; settings: { open: boolean; tab?: string }; setSettings(value: { open: boolean; tab?: string }): void }) {
  const { host, config, corePlugins, bookmarks, actions } = environment;
  const { workspace, app } = host;
  const t = useT();
  const plugins = useCorePlugins(corePlugins);
  const [hotkeys, setHotkeys] = useState<Record<string, Hotkey[]>>({});
  const [, setTick] = useState(0);
  const previousPlugins = useRef<Record<string, boolean> | null>(null);

  useEffect(() => {
    const ref = workspace.on("file-menu", (menu: unknown, file: unknown, source: unknown) => {
      if (!(menu instanceof Menu) || !(file instanceof TFile || file instanceof TFolder) || hasFileMenuItems(menu)) return;
      menu.addItem(item => item.setSection("action").setTitle(t("plugins.file-explorer.menu-opt-rename")).setIcon("lucide-edit-3").onClick(() => actions.run(() => renameInExplorer(actions, file))));
      addFileMenuItems(menu, actions, file, typeof source === "string" ? source : "link-context-menu", null, undefined, false);
    });
    return () => workspace.offref(ref);
  }, [workspace, actions, t]);

  // Custom hotkeys live in `.obsidian/hotkeys.json`; the settings tab announces edits with an event.
  useEffect(() => {
    const load = () => void fs.promises.readFile(path.join(config.configDir, "hotkeys.json"), "utf8").then(raw => setHotkeys(JSON.parse(raw) as Record<string, Hotkey[]>)).catch(() => setHotkeys({}));
    load(); window.addEventListener("hotkeys-changed", load);
    return () => window.removeEventListener("hotkeys-changed", load);
  }, [config]);

  useEffect(() => {
    const previous = previousPlugins.current;
    previousPlugins.current = { ...plugins };
    host.setCorePlugins(plugins);
    if (previous) void ensureDockViews(host, plugins, previous).catch(error => { console.error(error); new Notice(t("obsen.startup.error-restore-view")); });
  }, [host, plugins]);

  // Editor preferences flow from the vault config into every open editor.
  useEffect(() => {
    const apply = () => {
      const keys = ["tabSize", "useTab", "spellcheck", "showLineNumber", "foldHeading", "foldIndent", "rightToLeft", "livePreview", "autoPairBrackets", "autoPairMarkdown", "smartIndentList", "showIndentGuide", "readableLineLength", "propertiesInDocument", "strictLineBreaks", "defaultViewMode"] as const;
      app.editorOptions = Object.fromEntries(keys.map(key => [key, config.get(key)]));
      workspace.trigger("editor-options-change");
    };
    apply();
    const stop = config.onChange(apply);
    const publish = workspace.on("publish:open", () => openPublishModal({ host, config, corePlugins, actions, vault }));
    const stopBacklinks = watchEmbeddedBacklinks(workspace, actions);
    const search = workspace.on("search:open", (query: unknown) => actions.run(() => actions.openSearch(String(query))));
    const dailyNote = workspace.on("daily-note:open", (date: unknown, event: unknown) => actions.run(async () => {
      const file = await getDailyNote(actions, moment(String(date)));
      if (file) await workspace.getLeaf(Keymap.isModEvent(event && typeof event === "object" ? event as MouseEvent : null)).openFile(file);
    }));
    return () => { stop(); stopBacklinks(); workspace.offref(search); workspace.offref(publish); workspace.offref(dailyNote); };
  }, [app, config, workspace, actions]);

  // Command names are resolved at registration time, so a language change re-registers them.
  const [language, setLanguage] = useState(() => app.loadLocalStorage("language"));
  useEffect(() => {
    const update = () => setLanguage(Date.now());
    window.addEventListener("language-changed", update);
    return () => window.removeEventListener("language-changed", update);
  }, []);
  // Core plugins implemented as modules: views, handlers and commands exist only while enabled.
  const moduleContext = useMemo<CorePluginContext>(() => ({ app, host, actions, config, corePlugins, configDir: config.configDir }), [app, host, actions, config, corePlugins]);
  const enabledModules = CORE_PLUGIN_MODULES.filter(module => plugins[module.id]);
  const enabledModuleIds = enabledModules.map(module => module.id).join(",");
  useEffect(() => {
    const disposers: Array<() => void> = [];
    for (const module of enabledModules) {
      try {
        for (const [type, creator] of Object.entries(module.views?.(moduleContext) ?? {})) {
          workspace.registerView(type, creator);
          const extensions = module.extensions?.[type];
          if (extensions) workspace.registerExtensions(extensions, type);
          disposers.push(() => { workspace.detachLeavesOfType(type); if (extensions) workspace.unregisterExtensions(type); workspace.unregisterView(type); });
        }
        const dispose = module.install?.(moduleContext);
        if (dispose) disposers.push(dispose);
      } catch (error) { console.error(`Core plugin "${module.id}" failed to start`, error); }
    }
    return () => { for (const dispose of disposers.reverse()) try { dispose(); } catch (error) { console.error(error); } };
  }, [moduleContext, enabledModuleIds]);
  useEffect(() => {
    const unregister = registerCoreCommands({ actions, bookmarks, customHotkeys: hotkeys, moduleCommands: enabledModules.flatMap(module => module.commands?.(moduleContext) ?? []) });
    // The application menu shows these commands with their hotkeys.
    requestAppMenuRender();
    return unregister;
  }, [actions, bookmarks, hotkeys, plugins, language, moduleContext]);

  useEffect(() => {
    const refs = ["layout-change", "active-leaf-change", "file-open"].map(name => workspace.on(name, () => setTick(tick => tick + 1)));
    const stopBookmarks = bookmarks.onChange(() => setTick(tick => tick + 1));
    const renamed = host.vault.on("rename", (file, oldPath) => bookmarks.renamePath(oldPath, file.path));
    const deleted = host.vault.on("delete", file => bookmarks.removePath(file.path));
    return () => { refs.forEach(ref => workspace.offref(ref)); stopBookmarks(); host.vault.offref(renamed); host.vault.offref(deleted); };
  }, [workspace, host, bookmarks]);

  const workspaceHost = useMemo<WorkspaceHost>(() => ({
    workspace,
    isHosted: leaf => isCoreDockType(leaf.view.getViewType()),
    bookmarkState(leaf) {
      const file = leaf.view instanceof FileView ? leaf.view.file : leaf.view instanceof CoreDockView ? leaf.view.getBoundFile() : null;
      if (!file || !corePlugins.isEnabled("bookmarks")) return null;
      const location = bookmarks.findFile(file.path);
      return { bookmarked: !!location, toggle: () => { if (location) bookmarks.remove(location); else bookmarks.add({ type: "file", path: file.path }); } };
    },
    renderLeaf(leaf): ReactNode | undefined {
      const type = leaf.view.getViewType();
      if (!isCoreDockType(type)) return undefined;
      const props = { leaf, actions };
      switch (type) {
        case "file-explorer": return <FileExplorer {...props} />;
        case "search": return <SearchPane {...props} />;
        case "bookmarks": return <BookmarksPane {...props} store={bookmarks} />;
        case "backlink": return <BacklinksPane {...props} />;
        case "outgoing-link": return <OutgoingLinksPane {...props} />;
        case "tag": return <TagPane {...props} />;
        case "outline": return <OutlinePane {...props} />;
        default: return <PropertiesPane {...props} />;
      }
    },
    emptyStateActions(leaf): EmptyStateAction[] {
      const here = () => workspace.setActiveLeaf(leaf);
      const list: EmptyStateAction[] = [{ id: "new-note", icon: "lucide-square-pen", label: t("plugins.file-explorer.action-new-note"), commandId: "file-explorer:new-file", onClick: () => { here(); actions.run(() => actions.newNote(null, false)); } }];
      if (corePlugins.isEnabled("bases")) list.push({ id: "new-base", icon: "lucide-layout-list", label: t("plugins.bases.action-new-base"), onClick: () => { here(); actions.run(() => actions.newBase(null, false)); } });
      if (corePlugins.isEnabled("canvas")) list.push({ id: "new-canvas", icon: "lucide-layout-dashboard", label: t("plugins.canvas.action-new-canvas"), onClick: () => { here(); actions.run(() => actions.newCanvas(null, false)); } });
      if (corePlugins.isEnabled("switcher")) list.push({ id: "go-to-file", icon: "lucide-search", label: t("interface.empty-state.go-to-file"), commandId: "switcher:open", onClick: () => { here(); app.executeCommandById("switcher:open"); } });
      if (workspace.getLastOpenFiles().length === 0 && (leaf.parent?.children.length ?? 0) > 1) list.push({ id: "close", icon: "lucide-x", label: t("interface.empty-state.close"), commandId: "workspace:close", onClick: () => leaf.detach() });
      return list;
    },
    extendPaneMenu(menu: Menu, leaf, source) {
      const view = leaf.view, file = view instanceof FileView ? view.file : null;
      if (corePlugins.isEnabled("bookmarks") && !file && view.getViewType() === "graph") {
        menu.addItem(item => item.setSection("view").setTitle(t("plugins.bookmarks.action-bookmark")).setIcon("lucide-bookmark").onClick(() => {
          bookmarks.add({ type: "graph" });
        }));
      }
      if (view instanceof MarkdownView && corePlugins.isEnabled("backlink")) {
        menu.addItem(item => item.setSection("pane").setTitle(t("plugins.backlinks.menu-opt-backlinks-in-document")).setIcon("links-coming-in").setChecked(view.showBacklinks).onClick(() => view.setShowBacklinks(!view.showBacklinks)));
      }
      if (file) {
        menu.addItem(item => item.setSection("action").setTitle(t("plugins.file-explorer.menu-opt-rename")).setIcon("lucide-edit-3").onClick(() => actions.run(() => renameInExplorer(actions, file))));
        if (source === "more-options") {
          menu.setSectionSubmenu("view.linked", { title: t("interface.menu.open-linked-view"), icon: "lucide-link" });
          menu.setSectionItemOrder("view.linked", [
            t("plugins.graph-view.action-open-local"),
            t("plugins.backlinks.action-open"),
            t("plugins.outgoing-links.action-open"),
            t("plugins.properties.action-open-local"),
            t("plugins.outline.action-open"),
          ]);
          if (corePlugins.isEnabled("backlink")) menu.addItem(item => item.setSection("view.linked").setTitle(t("plugins.backlinks.action-open")).setIcon("links-coming-in").onClick(async () => {
            const linked = workspace.createLeafBySplit(leaf, "horizontal");
            await linked.setViewState({ type: "backlink", active: true, state: { file: file.path } });
            linked.setGroupMember(leaf);
          }));
          if (corePlugins.isEnabled("outgoing-link")) menu.addItem(item => item.setSection("view.linked").setTitle(t("plugins.outgoing-links.action-open")).setIcon("links-going-out").onClick(async () => {
            const linked = workspace.createLeafBySplit(leaf, "horizontal");
            await linked.setViewState({ type: "outgoing-link", active: true, state: { file: file.path } });
            linked.setGroupMember(leaf);
          }));
          if (corePlugins.isEnabled("properties")) menu.addItem(item => item.setSection("view.linked").setTitle(t("plugins.properties.action-open-local")).setIcon("lucide-archive").onClick(async () => {
            const linked = workspace.createLeafBySplit(leaf, "horizontal");
            await linked.setViewState({ type: "file-properties", active: true, state: { file: file.path } });
            linked.setGroupMember(leaf);
          }));
          if (corePlugins.isEnabled("outline")) menu.addItem(item => item.setSection("view.linked").setTitle(t("plugins.outline.action-open")).setIcon("lucide-list").onClick(async () => {
            const linked = workspace.createLeafBySplit(leaf, "horizontal");
            await linked.setViewState({ type: "outline", active: true, state: { file: file.path } });
            linked.setGroupMember(leaf);
          }));
        }
        addFileMenuItems(menu, actions, file, source, leaf);
        menu.addItem(item => item.setSection("danger").setTitle(t("interface.menu.delete-file")).setIcon("lucide-trash-2").setWarning(true).onClick(() => actions.run(() => actions.delete(file))));
      }
    },
    toggleRightSidebar: () => actions.toggleSidebar("right"),
    executeCommand: id => { app.executeCommandById(id); },
  }), [workspace, actions, bookmarks, corePlugins, app, t]);

  const command = (id: string) => () => { app.executeCommandById(id); };
  const ribbon: RibbonAction[] = [
    ...(plugins.switcher ? [{ id: "switcher", icon: "lucide-file-search", title: t("plugins.quick-switcher.action-open"), onClick: command("switcher:open") }] : []),
    ...(plugins.graph ? [{ id: "graph", icon: "lucide-git-fork", title: t("plugins.graph-view.action-open"), onClick: command("graph:open") }] : []),
    ...(plugins.canvas ? [{ id: "canvas", icon: "lucide-layout-dashboard", title: t("plugins.canvas.command-create-new-canvas"), onClick: command("canvas:new-file") }] : []),
    ...(plugins["daily-notes"] ? [{ id: "daily-notes", icon: "lucide-calendar", title: t("plugins.daily-notes.action-open"), onClick: command("daily-notes") }] : []),
    ...(plugins.templates ? [{ id: "templates", icon: "lucide-files", title: t("plugins.templates.action-insert"), onClick: command("insert-template") }] : []),
    ...(plugins["command-palette"] ? [{ id: "command-palette", icon: "lucide-terminal", title: t("plugins.command-palette.action-open"), onClick: command("command-palette:open") }] : []),
    ...(plugins.bases ? [{ id: "bases", icon: "lucide-layout-list", title: t("plugins.bases.command-create-new"), onClick: command("bases:new-file") }] : []),
    ...enabledModules.flatMap(module => module.ribbon?.(moduleContext) ?? []),
    ...(plugins.publish ? [{ id: "publish", icon: "lucide-send", title: t("plugins.publish.action-publish-changes"), onClick: command("publish:view-changes") }] : []),
  ];
  const ribbonOrder = new Map(["switcher", "graph", "canvas", "daily-notes", "templates", "command-palette", "bases", "zk-prefixer", "random-note", "audio-recorder", "workspaces", "publish"].map((id, index) => [id, index]));
  ribbon.sort((left, right) => (ribbonOrder.get(left.id) ?? ribbonOrder.size) - (ribbonOrder.get(right.id) ?? ribbonOrder.size));

  const vaultMenu = (event: React.MouseEvent) => {
    const menu = new Menu();
    const vaults = ipcRenderer.sendSync("vault-list") as Array<{ id: string; name: string; path: string }>;
    for (const entry of vaults) menu.addItem(item => item.setSection("vaults").setTitle(entry.name).setChecked(entry.id === vault.id ? true : null).onClick(() => { if (entry.id !== vault.id) void ipcRenderer.invoke("vault:open", entry.id); }));
    menu.addItem(item => item.setSection("manage").setTitle(t("interface.manage-vaults")).onClick(() => actions.openVaultChooser()));
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.showAtPosition({ x: box.left, y: box.top - 4 - 33 * (vaults.length + 1) });
  };

  const active = workspace.getMostRecentLeaf(workspace.rootSplit);
  const title = [active ? leafTitle(active) : "", vault.name, `${brandName()} ${APP_VERSION}`].filter(Boolean).join(" - ");

  return <WorkspaceHostProvider value={workspaceHost}>
    <Titlebar title={title} />
    <WorkspaceShell workspace={workspace} ribbon={ribbon} vaultName={vault.name} status={<StatusBarItems actions={actions} />}
      onToggleLeft={() => actions.toggleSidebar("left")} onVaultMenu={vaultMenu} onSettings={() => actions.openSettings()} onHelp={() => actions.openHelp()} />
    <WorkspaceLeaves />
    {settings.open && <SettingsModal environment={{ host, config, corePlugins, actions, vault }} initialTab={settings.tab} onClose={() => setSettings({ open: false })} />}
  </WorkspaceHostProvider>;
}
