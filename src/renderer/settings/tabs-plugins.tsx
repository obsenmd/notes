import { path, originalFs as fs, ipcRenderer, shell, process } from "../../../platforms/platform";
import { useEffect, useMemo, useState, type ReactNode } from "react";


import moment from "moment";

import { Scope, type Hotkey, type Modifier } from "../../compat/commands";
import { AccountClient } from "../../compat/account";
import { Menu, Modal, Notice } from "../../compat/ui";
import { chooseItem, confirmDialog, requestText } from "../../controllers/dialogs";
import { COMMAND_INVENTORY } from "../../controllers/command-inventory";
import { flatResources, t } from "../../i18n";
import { useT } from "../../i18n/react";
import { useConfig, writeJson } from "../config";
import { CORE_PLUGINS, useCorePlugins } from "../core-plugins";
import { formatHotkey } from "../hotkeys";
import { openCommunityModal } from "../CommunityModal";
import type { PluginManifest } from "../../compat/plugin";

interface InstalledPlugin extends PluginManifest { enabled: boolean }
import { SyncVaultManager } from "../SyncVaultManager";
import { ClickableIcon, IconEl, SearchInput, SettingItem, cx } from "../ui";
import { Dropdown, Group, SliderRow, TextInput, ToggleRow, describe, helpUrl, siteUrl, usePluginData, type SettingsEnvironment } from "./controls";
import { TemplateFile, openLoginModal } from "./tabs-core";

/** A resource string exactly as written, for copy that shows template variables such as {{date}} literally. */
const literal = (key: string) => flatResources()[key] ?? t(key);
/** Key names as the reference's hotkey list spells them. */
const hotkeyLabel = (hotkey: Hotkey) => formatHotkey(hotkey).replace(/\bPageDown\b/, "Page Down").replace(/\bPageUp\b/, "Page Up");

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const EmptyState = ({ text }: { text: string }) => <div className="setting-item mod-empty-state"><div className="setting-item-info"><div className="setting-item-name">{text}</div><div className="setting-item-description" /></div><div className="setting-item-control" /></div>;

// ---------------------------------------------------------------- Hotkeys

type HotkeyFilter = "all" | "assigned" | "user" | "unassigned" | "conflicts";
const signature = (hotkey: Hotkey) => `${[...hotkey.modifiers].sort().join("+")}+${hotkey.key.toLowerCase()}`;

export function HotkeysTab({ environment, initialQuery = "" }: { environment: SettingsEnvironment; initialQuery?: string }) {
  const t = useT();
  const { host, config } = environment;
  const file = path.join(config.configDir, "hotkeys.json");
  const [custom, setCustom] = useState<Record<string, Hotkey[]>>({});
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<HotkeyFilter>("all");
  const [recording, setRecording] = useState<string | null>(null);
  useEffect(() => { void fs.promises.readFile(file, "utf8").then(raw => setCustom(JSON.parse(raw) as Record<string, Hotkey[]>)).catch(() => setCustom({})); }, [file]);

  const defaults = useMemo(() => new Map(COMMAND_INVENTORY.map(definition => [definition.id, definition.hotkeys ?? []])), []);
  const commands = [...host.app.commands.commands.values()].sort((a, b) => collator.compare(a.name, b.name));
  const keysOf = (id: string) => custom[id] ?? defaults.get(id) ?? host.app.commands.commands.get(id)?.hotkeys ?? [];
  const owners = new Map<string, string[]>();
  for (const command of commands) for (const hotkey of keysOf(command.id)) owners.set(signature(hotkey), [...(owners.get(signature(hotkey)) ?? []), command.name]);
  const conflicting = (id: string) => keysOf(id).some(hotkey => (owners.get(signature(hotkey))?.length ?? 0) > 1);
  const conflicts = commands.filter(command => conflicting(command.id)).length;

  const save = (id: string, hotkeys: Hotkey[] | null) => {
    const next = { ...custom };
    if (hotkeys === null) delete next[id]; else next[id] = hotkeys;
    setCustom(next); setRecording(null);
    void writeJson(file, next).then(() => window.dispatchEvent(new Event("hotkeys-changed"))).catch(() => new Notice(t("obsen.settings.error-save-hotkeys")));
  };
  // While recording, the next non-modifier key press becomes the new hotkey; Escape cancels.
  useEffect(() => {
    if (!recording) return;
    const scope = new Scope();
    scope.register(null, null, event => {
      if (event.key === "Escape") { setRecording(null); return false; }
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return false;
      const modifiers: Modifier[] = [];
      if (event.ctrlKey) modifiers.push("Mod"); if (event.metaKey) modifiers.push("Meta"); if (event.altKey) modifiers.push("Alt"); if (event.shiftKey) modifiers.push("Shift");
      const hotkey = { modifiers, key: event.key.length === 1 ? event.key.toUpperCase() : event.key };
      const current = keysOf(recording);
      if (!current.some(existing => signature(existing) === signature(hotkey))) save(recording, [...current, hotkey]); else setRecording(null);
      return false;
    });
    host.app.keymap.pushScope(scope);
    return () => host.app.keymap.popScope(scope);
  }, [recording, custom]);

  const needle = query.trim().toLowerCase();
  const visible = commands.filter(command => {
    const keys = keysOf(command.id);
    if (needle && !command.name.toLowerCase().includes(needle) && !keys.some(hotkey => hotkeyLabel(hotkey).toLowerCase().includes(needle))) return false;
    return filter === "all" || (filter === "assigned" && keys.length > 0) || (filter === "unassigned" && !keys.length) || (filter === "user" && command.id in custom) || (filter === "conflicts" && conflicting(command.id));
  });
  const filterButton = (id: HotkeyFilter, label: string, extra?: ReactNode, hidden?: boolean) =>
    <div className={cx("setting-group-filter", id === "conflicts" && "mod-error", filter === id && "is-active")} tabIndex={0} style={hidden ? { display: "none" } : undefined} onClick={() => setFilter(id)}>{extra ? <span>{label}</span> : label}{extra}</div>;

  return <div className="setting-group mod-list mod-hotkeys">
    <div className="setting-group-search" tabIndex={-1}>
      <SearchInput className="mod-hotkey" value={query} onChange={setQuery} placeholder={t("setting.hotkeys.prompt-filter")}>
        <IconEl className="input-right-decorator clickable-icon" icon="lucide-keyboard" />
      </SearchInput>
      <div className="setting-group-search-control">
        <div className="setting-group-filters">
          {filterButton("conflicts", t("setting.hotkeys.label-show-conflicts"), <span className="setting-group-filter-badge">{conflicts}</span>, conflicts === 0)}
          {filterButton("all", t("setting.hotkeys.label-show-all"))}
          {filterButton("assigned", t("setting.hotkeys.label-show-assigned"))}
          {filterButton("user", t("setting.hotkeys.label-show-user-assigned"))}
          {filterButton("unassigned", t("setting.hotkeys.label-show-unassigned"))}
        </div>
      </div>
    </div>
    <div className="setting-items">
      {visible.map(command => {
        const keys = keysOf(command.id);
        return <div className="setting-item" tabIndex={-1} key={command.id}>
          <div className="setting-item-info"><div className="setting-item-name">{command.name}</div><div className="setting-item-description" /></div>
          <div className="setting-item-control">
            <div className="setting-command-hotkeys">
              {keys.map((hotkey, index) => {
                const others = (owners.get(signature(hotkey)) ?? []).filter(name => name !== command.name);
                return <span key={index} className={cx("setting-hotkey", others.length > 0 && "has-conflict")} aria-label={others.length === 1 ? t("setting.hotkeys.tooltip-hotkey-single-conflict", { command: others[0] }) : others.length > 1 ? t("setting.hotkeys.tooltip-hotkey-multiple-conflicts", { count: others.length }) : undefined}>
                  {hotkeyLabel(hotkey)}
                  <IconEl tag="span" className="setting-hotkey-icon setting-delete-hotkey" icon="lucide-x" aria-label={t("setting.hotkeys.tooltip-delete-hotkey")} onClick={() => save(command.id, keys.filter((_item, position) => position !== index))} />
                </span>;
              })}
              {recording === command.id ? <span className="setting-hotkey mod-active">{t("setting.hotkeys.label-waiting-for-hotkey-press")}</span>
                : !keys.length && <span className="setting-hotkey mod-empty">{t("setting.hotkeys.label-blank-hotkey")}</span>}
            </div>
            {command.id in custom && <ClickableIcon tag="span" icon="lucide-rotate-ccw" className="setting-restore-hotkey-button" label={t("setting.hotkeys.tooltip-restore-default")} onClick={() => save(command.id, null)} />}
            <ClickableIcon tag="span" icon="lucide-plus-circle" className={cx("setting-add-hotkey-button", recording === command.id && "mod-active")} label={t("setting.hotkeys.tooltip-customize-command")} onClick={() => setRecording(recording === command.id ? null : command.id)} />
          </div>
        </div>;
      })}
      {!visible.length && <EmptyState text={t("setting.hotkeys.label-no-results-found")} />}
    </div>
  </div>;
}

// ---------------------------------------------------------------- Keychain

export function KeychainTab({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const storage = environment.host.app.secretStorage;
  const [names, setNames] = useState<string[]>(() => storage.listSecrets().sort());
  const refresh = () => setNames(storage.listSecrets().sort());
  const edit = async (existing?: string) => {
    const id = existing ?? await requestText(environment.host.app, t("setting.keychain.label-secret-id"), "", { placeholder: t("setting.keychain.placeholder-secret-id"), cta: t("dialogue.button-continue") });
    if (id === null) return;
    if (!storage.validateId(id.trim())) { new Notice(t("setting.keychain.msg-error-secret-id-invalid")); return; }
    if (!existing && names.includes(id.trim())) { new Notice(t("setting.keychain.msg-error-secret-id-exists")); return; }
    const value = await requestText(environment.host.app, t("setting.keychain.label-secret-value"), "", { placeholder: t("setting.keychain.option-secret-value-description") });
    if (value === null) return;
    if (!value) { new Notice(t("setting.keychain.msg-error-secret-value-empty")); return; }
    try { storage.setSecret(id.trim(), value); refresh(); }
    catch { new Notice(t(existing ? "setting.keychain.msg-error-update-secret" : "setting.keychain.msg-error-add-secret")); }
  };
  return <Group className="mod-list mod-no-icon" heading={t("setting.keychain.secrets")} headingControls={<ClickableIcon icon="lucide-plus" className="extra-setting-button" label={t("setting.keychain.action-add-secret")} tabIndex={0} onClick={() => void edit()} />}>
    {names.map(name => <SettingItem key={name} name={name}>
      <ClickableIcon icon="lucide-pencil" className="extra-setting-button" label={t("setting.keychain.action-edit-secret")} tabIndex={0} onClick={() => void edit(name)} />
      <ClickableIcon icon="lucide-trash-2" className="extra-setting-button" label={t("interface.menu.delete")} tabIndex={0} onClick={() => { storage.deleteSecret(name); refresh(); }} />
    </SettingItem>)}
    {!names.length && <EmptyState text={t("setting.keychain.keychain-empty-state")} />}
  </Group>;
}

// ---------------------------------------------------------------- Core plugins

/** Plugins the reference keeps out of the list (`hiddenFromList`): the editing-mode status item is switched from the Editor tab. */
const HIDDEN_CORE_PLUGINS = new Set(["editor-status"]);

export function CorePluginsTab({ environment, onOpenTab }: { environment: SettingsEnvironment; onOpenTab(id: string, query?: string): void }) {
  const t = useT();
  const enabled = useCorePlugins(environment.corePlugins);
  const [query, setQuery] = useState("");
  const [, setRevision] = useState(0);
  const { app } = environment.host;
  // Commands and option tabs appear a moment after a plugin is switched on.
  useEffect(() => { const timer = setTimeout(() => setRevision(revision => revision + 1), 150); return () => clearTimeout(timer); }, [enabled]);
  const words = query.trim().toLowerCase().split(" ");
  const matches = (text: string) => words.every(word => !word || text.toLowerCase().includes(word));
  const plugins = CORE_PLUGINS.filter(plugin => !HIDDEN_CORE_PLUGINS.has(plugin.id)).map(plugin => ({ ...plugin, name: t(`plugins.${plugin.group}.name`), description: t(`plugins.${plugin.group}.desc`) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  const commandIds = [...app.commands.commands.keys()];
  return <div className="setting-group mod-list mod-no-icon">
    <div className="setting-group-search" tabIndex={-1}><SearchInput value={query} onChange={setQuery} placeholder={t("setting.core-plugin.placeholder-search-plugin")} /></div>
    <div className="setting-items">
      {plugins.map(plugin => <div className="setting-item mod-toggle" tabIndex={-1} key={plugin.id} style={!query.trim() || matches(plugin.name) || matches(plugin.description) ? undefined : { display: "none" }}>
        <div className="setting-item-icon" />
        <div className="setting-item-info"><div className="setting-item-name">{plugin.name}</div><div className="setting-item-description">{plugin.description}</div></div>
        <div className="setting-item-control">
          <ClickableIcon icon="lucide-settings" className="extra-setting-button" label={t("setting.options")} tabIndex={0} style={enabled[plugin.id] && plugin.hasSettings ? undefined : { display: "none" }} onClick={() => onOpenTab(plugin.id)} />
          <ClickableIcon icon="lucide-plus-circle" className="extra-setting-button mod-hotkeys" label={t("setting.hotkeys.name")} tabIndex={0} style={enabled[plugin.id] && commandIds.some(id => id.startsWith(`${plugin.id}:`)) ? undefined : { display: "none" }} onClick={() => onOpenTab("hotkeys", plugin.name)} />
          <label className={cx("checkbox-container", enabled[plugin.id] && "is-enabled")} tabIndex={0} onClick={event => { event.preventDefault(); void environment.corePlugins.setEnabled(plugin.id, !enabled[plugin.id]); }}><input type="checkbox" tabIndex={-1} checked={!!enabled[plugin.id]} readOnly /></label>
        </div>
      </div>)}
    </div>
  </div>;
}

// ---------------------------------------------------------------- Community plugins

const restrictedKey = (vaultPath: string) => `obsen:restricted-mode:${path.resolve(vaultPath)}`;
/** Restricted mode keeps community plugins from loading; it is on until the user allows plugins for the vault. */
export const isRestrictedMode = (vaultPath: string) => localStorage.getItem(restrictedKey(vaultPath)) !== "false";

/** The first time a vault that ships with enabled plugins is opened, ask whether its author is trusted. */
export async function trustVaultIfAsked(app: import("../../compat/plugin").App, vaultPath: string, configDir: string): Promise<void> {
  if (localStorage.getItem(restrictedKey(vaultPath)) !== null) return;
  const enabled = await fs.promises.readFile(path.join(configDir, "community-plugins.json"), "utf8").then(raw => JSON.parse(raw) as unknown).catch(() => []);
  if (!Array.isArray(enabled) || !enabled.length) return;
  const result = await confirmDialog(app, {
    title: t("setting.third-party-plugin.label-trust-author"),
    message: [t("setting.third-party-plugin.label-trust-author-description-1"), t("setting.third-party-plugin.label-trust-author-description-2"), t("setting.third-party-plugin.label-trust-author-description-3")],
    cta: t("setting.third-party-plugin.button-enable-plugins"),
  });
  localStorage.setItem(restrictedKey(vaultPath), String(!result.confirmed));
  if (result.confirmed) window.location.reload();
}

async function readInstalled(configDir: string): Promise<InstalledPlugin[]> {
  const root = path.join(configDir, "plugins");
  const enabledRaw = await fs.promises.readFile(path.join(configDir, "community-plugins.json"), "utf8").then(raw => JSON.parse(raw) as unknown).catch(() => []);
  const enabled = new Set(Array.isArray(enabledRaw) ? enabledRaw.filter((id): id is string => typeof id === "string") : []);
  const plugins: InstalledPlugin[] = [];
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(root, entry.name, "manifest.json"), "utf8")) as InstalledPlugin;
      if (typeof manifest.id === "string" && typeof manifest.name === "string" && typeof manifest.version === "string") plugins.push({ ...manifest, enabled: enabled.has(manifest.id) });
    } catch { /* Folders without a readable manifest are not plugins. */ }
  }
  return plugins.sort((a, b) => collator.compare(a.name, b.name));
}
const FEATURES: Array<[string, string]> = [["lucide-inspect", "code-review"], ["lucide-github", "open-source"], ["lucide-users", "peer-audit"], ["lucide-bug", "report-mechanism"]];

export function CommunityPluginsTab({ environment, onOpenTab }: { environment: SettingsEnvironment; onOpenTab(id: string, query?: string): void }) {
  const t = useT();
  const { config, host, vault } = environment;
  const restricted = isRestrictedMode(vault.path);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [query, setQuery] = useState("");
  const [reenable, setReenable] = useState(true);
  const [autoCheck, setAutoCheck] = useState(() => host.app.loadLocalStorage("plugin-automatically-check-for-updates") === true);
  const reload = () => void readInstalled(config.configDir).then(setPlugins);
  useEffect(reload, [config.configDir]);
  const folder = path.join(config.configDir, "plugins");
  const setRestricted = (value: boolean) => { localStorage.setItem(restrictedKey(vault.path), String(value)); window.location.reload(); };
  const toggle = (plugin: InstalledPlugin) => void (async () => {
    await host.pluginLoader.setEnabled(vault.path, plugin.id, !plugin.enabled);
    reload();
  })().catch(() => new Notice(plugin.enabled
    ? t("setting.third-party-plugin.msg-failed-to-disable-plugin", { id: plugin.id })
    : t("interface.msg-failed-to-load-plugin", { plugin: plugin.name })));
  const browse = () => openCommunityModal("plugin", environment, reload);
  const remove = async (plugin: InstalledPlugin) => {
    const result = await confirmDialog(host.app, { title: t("setting.third-party-plugin.label-uninstall-plugin"), message: [t("setting.third-party-plugin.label-uninstall-plugin-confirmation")], cta: t("setting.third-party-plugin.label-uninstall"), warning: true });
    if (!result.confirmed) return;
    await host.pluginLoader.setEnabled(vault.path, plugin.id, false);
    await fs.promises.rm(path.join(folder, plugin.id), { recursive: true, force: true });
    reload();
  };
  const buildMenu = (plugin: InstalledPlugin) => {
    const menu = new Menu();
    const loaded = plugin.enabled;
    if (loaded && host.app.settingTabs.has(plugin.id)) menu.addItem(item => item.setSection("info").setTitle(t("setting.third-party-plugin.action-settings")).setIcon("lucide-settings").onClick(() => onOpenTab(`plugin:${plugin.id}`)));
    if (loaded && [...host.app.commands.commands.keys()].some(id => id.startsWith(`${plugin.id}:`))) menu.addItem(item => item.setSection("info").setTitle(t("setting.hotkeys.name")).setIcon("lucide-keyboard").onClick(() => onOpenTab("hotkeys", plugin.id)));
    menu.addItem(item => item.setSection("view").setTitle(t("setting.third-party-plugin.action-view-details")).setIcon("lucide-info").onClick(browse));
    menu.addItem(item => item.setSection("view").setTitle(t("setting.third-party-plugin.action-open-community-page")).setIcon("lucide-globe").onClick(() => void shell.openExternal(`https://community.obsidian.md/plugins/${plugin.id}`)));
    menu.addItem(item => item.setSection("system").setTitle(t(process.platform === "darwin" ? "plugins.open-with-default-app.action-show-in-folder-mac" : "plugins.open-with-default-app.action-show-in-folder")).setIcon("lucide-folder-open").onClick(() => shell.showItemInFolder(path.join(folder, plugin.id))));
    menu.addItem(item => item.setSection("danger").setTitle(t("setting.third-party-plugin.label-uninstall")).setIcon("lucide-trash-2").setWarning(true).onClick(() => void remove(plugin)));
    return menu;
  };
  if (restricted) {
    const previouslyEnabled = plugins.filter(plugin => plugin.enabled);
    const showEnabled = () => {
      const modal = new Modal(host.app);
      modal.modalEl.classList.add("mod-lg");
      modal.setTitle(t("setting.third-party-plugin.title-enabled-plugins-debug"));
      modal.contentEl.createEl("p", { text: t("setting.third-party-plugin.desc-enabled-plugins-debug") });
      const list = modal.contentEl.createEl("ul", { cls: "community-plugins-debug-list" });
      for (const plugin of previouslyEnabled) list.createEl("li", { text: `${plugin.name} (v${plugin.version})` });
      const buttons = modal.modalEl.createDiv("modal-button-container");
      buttons.createEl("button", { cls: "mod-secondary", text: t("interface.label-copy") }).addEventListener("click", () => void navigator.clipboard.writeText(previouslyEnabled.map(plugin => `- ${plugin.name} (${plugin.id}) v${plugin.version}`).join("\n")).then(() => new Notice(t("interface.copied_generic"))));
      buttons.createEl("button", { cls: "mod-cancel", text: t("dialogue.button-done") }).addEventListener("click", () => modal.close());
      modal.open();
    };
    const exit = async () => { if (!reenable) await writeJson(path.join(config.configDir, "community-plugins.json"), []); setRestricted(false); };
    return <Group className="community-plugins-banner">
      <div className="setting-item community-plugins-intro" tabIndex={-1}>
        <div className="setting-item-info">
          <div className="setting-item-name">{t("setting.third-party-plugin.label-exit-restricted-mode-description-1")} {t("setting.third-party-plugin.label-exit-restricted-mode-description-2")}</div>
          <div className="setting-item-description"><div className="community-plugins-features">
            {FEATURES.map(([icon, key]) => <div className="community-plugins-feature" key={key}>
              <IconEl className="community-plugins-feature-icon" icon={icon} />
              <div className="community-plugins-feature-text">
                <div className="community-plugins-feature-name">{t(`setting.third-party-plugin.label-${key}`)}</div>
                <div className="community-plugins-feature-desc">{t(`setting.third-party-plugin.label-${key}-desc`)}</div>
              </div>
            </div>)}
          </div></div>
        </div>
        <div className="setting-item-control" />
      </div>
      <SettingItem name={t("setting.third-party-plugin.label-allow-community-plugins")} description={t("setting.third-party-plugin.label-enable-community-plugins-desc")}>
        <button className="mod-cta" onClick={() => void exit()}>{t("setting.third-party-plugin.label-exit-restricted-mode")}</button>
      </SettingItem>
      {previouslyEnabled.length > 0 && <SettingItem className="mod-toggle" name={t("setting.third-party-plugin.label-reenable-plugins")} description={t("setting.third-party-plugin.label-reenable-plugins-desc", { count: previouslyEnabled.length })}>
        <ClickableIcon icon="lucide-info" className="extra-setting-button" label={t("setting.third-party-plugin.tooltip-debug-installed-plugins")} tabIndex={0} onClick={showEnabled} />
        <label className={cx("checkbox-container", reenable && "is-enabled")} tabIndex={0} onClick={event => { event.preventDefault(); setReenable(!reenable); }}><input type="checkbox" tabIndex={-1} checked={reenable} readOnly /></label>
      </SettingItem>}
      <div className="setting-item community-plugins-learn-more-row" tabIndex={-1}>
        <div className="setting-item-info"><div className="setting-item-name"><a className="external-link" target="_blank" rel="noopener" href={helpUrl("plugin-security")} onClick={event => { event.preventDefault(); void shell.openExternal(helpUrl("plugin-security")); }}>{t("setting.third-party-plugin.label-learn-more")}</a></div><div className="setting-item-description" /></div>
        <div className="setting-item-control" />
      </div>
    </Group>;
  }
  const words = query.trim().toLowerCase().split(" ");
  const matches = (text: string | undefined) => !!text && words.every(word => !word || text.toLowerCase().includes(word));
  return <>
    <Group>
      <SettingItem name={t("setting.third-party-plugin.option-restricted-mode")} description={describe("setting.third-party-plugin.option-restricted-mode")}>
        <button onClick={() => setRestricted(true)}>{t("setting.third-party-plugin.button-turn-on")}</button>
      </SettingItem>
      <SettingItem name={t("setting.third-party-plugin.option-browse-community-plugins")} description={t("setting.third-party-plugin.option-browse-community-plugins-description")}>
        <button onClick={browse}>{t("setting.third-party-plugin.button-browse")}</button>
      </SettingItem>
      <SettingItem name={t("setting.third-party-plugin.label-current-plugins")} description={`${t("setting.third-party-plugin.label-currently-installed", { count: plugins.length })} `}>
        {plugins.length > 0 && <button onClick={browse}>{t("setting.third-party-plugin.button-check-for-updates")}</button>}
      </SettingItem>
      <ToggleRow name={t("setting.third-party-plugin.option-automatic-update-check")} description={t("setting.third-party-plugin.option-automatic-update-check-desc")} value={autoCheck} onChange={value => { setAutoCheck(value); host.app.saveLocalStorage("plugin-automatically-check-for-updates", value); }} />
    </Group>
    <Group className="mod-list mod-no-icon" heading={t("setting.third-party-plugin.label-installed-plugins")} search={plugins.length ? <SearchInput value={query} onChange={setQuery} placeholder={t("setting.third-party-plugin.placeholder-search-installed-plugin")} /> : undefined} headingControls={<>
      <ClickableIcon icon="lucide-refresh-cw" className="extra-setting-button" label={t("setting.third-party-plugin.button-reload-plugins")} tabIndex={0} onClick={() => { reload(); new Notice(t("setting.third-party-plugin.msg-reloaded-third-party-plugins")); }} />
      <ClickableIcon icon="lucide-folder-open" className="extra-setting-button" label={t("setting.third-party-plugin.button-open-plugins-folder")} tabIndex={0} onClick={() => void fs.promises.mkdir(folder, { recursive: true }).then(() => shell.openPath(folder))} />
    </>}>
      {plugins.map(plugin => <div className="setting-item mod-toggle" tabIndex={-1} key={plugin.id} data-plugin-id={plugin.id} style={!query.trim() || matches(plugin.name) || matches(plugin.description) || matches(plugin.author) ? undefined : { display: "none" }}
        onContextMenu={event => { event.preventDefault(); buildMenu(plugin).showAtMouseEvent(event.nativeEvent); }}>
        <div className="setting-item-icon" />
        <div className="setting-item-info" style={{ cursor: "pointer" }} onClick={browse}>
          <div className="setting-item-name">{plugin.name}{plugin.version && <> <span className="u-muted u-small u-numeric">v{plugin.version}</span></>}{plugin.author && <> <span className="u-muted u-small">{t("setting.third-party-plugin.label-by-author")}{plugin.author}</span></>}</div>
          <div className="setting-item-description">{plugin.description}</div>
        </div>
        <div className="setting-item-control">
          <ClickableIcon icon="lucide-more-vertical" className="extra-setting-button" label={t("interface.menu.more-options")} tabIndex={0} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); buildMenu(plugin).showAtPosition({ x: box.x, y: box.bottom }); }} />
          <label className={cx("checkbox-container", plugin.enabled && "is-enabled")} tabIndex={0} onClick={event => { event.preventDefault(); toggle(plugin); }}><input type="checkbox" tabIndex={-1} /></label>
        </div>
      </div>)}
      {!plugins.length && <EmptyState text={t("setting.third-party-plugin.label-no-installed-plugins")} />}
    </Group>
  </>;
}

// ---------------------------------------------------------------- Core plugin option tabs

const folderPlaceholder = () => t("setting.folder-path-example-placeholder");
function DateFormatHint({ format, fallback }: { format: string; fallback: string }) {
  return <>{t("plugins.daily-notes.label-refer-to-syntax")}<a href="https://momentjs.com/docs/#/displaying/format/" target="_blank" rel="noopener nofollow">{t("plugins.daily-notes.label-syntax-link")}</a><br />{t("plugins.daily-notes.label-syntax-live-preview")}<b className="u-pop">{moment().format(format || fallback)}</b></>;
}

export function SwitcherOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "switcher", { showExistingOnly: false, showAttachments: true, showAllFileTypes: false });
  const showUnsupportedFiles = useConfig(environment.config, "showUnsupportedFiles");
  return <Group>
    <ToggleRow name={t("plugins.quick-switcher.option-show-existing-only")} description={describe("plugins.quick-switcher.option-show-existing-only")} value={data.showExistingOnly} onChange={value => set({ showExistingOnly: value })} />
    <ToggleRow name={t("plugins.quick-switcher.option-show-attachments")} description={describe("plugins.quick-switcher.option-show-attachments")} value={data.showAttachments} onChange={value => set({ showAttachments: value })} />
    {showUnsupportedFiles && <ToggleRow name={t("plugins.quick-switcher.option-show-all-file-types")} description={describe("plugins.quick-switcher.option-show-all-file-types")} value={data.showAllFileTypes} onChange={value => set({ showAllFileTypes: value })} />}
  </Group>;
}

export function BacklinkOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "backlink", { backlinkInDocument: false });
  return <Group><ToggleRow name={t("plugins.backlinks.option-backlink-in-document")} description={describe("plugins.backlinks.option-backlink-in-document")} value={data.backlinkInDocument} onChange={value => set({ backlinkInDocument: value })} /></Group>;
}

export function CanvasOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "canvas", { newFileLocation: "root", newFileFolderPath: "", defaultWheelBehavior: "pan", defaultModDragBehavior: "menu", cardLabelVisibility: "always", snapToGrid: true, snapToObjects: true, zoomBreakpoint: 1 });
  return <Group>
    <SettingItem name={t("plugins.canvas.option-new-canvas-location")}>
      <Dropdown value={data.newFileLocation} options={[{ value: "root", label: t("setting.file.option-choice-vault-root") }, { value: "current", label: t("setting.file.option-choice-current-folder") }, { value: "folder", label: t("setting.file.option-choice-specified-folder") }]} onChange={value => set({ newFileLocation: value })} />
    </SettingItem>
    {data.newFileLocation === "folder" && <SettingItem name={t("plugins.canvas.option-new-canvas-folder-path")} description={describe("plugins.canvas.option-new-canvas-folder-path")}><TextInput value={data.newFileFolderPath} placeholder={folderPlaceholder()} onChange={value => set({ newFileFolderPath: value })} /></SettingItem>}
    <SettingItem name={t("plugins.canvas.option-wheel-behavior")}>
      <Dropdown value={data.defaultWheelBehavior} options={[{ value: "pan", label: t("plugins.canvas.label-pan") }, { value: "zoom", label: t("plugins.canvas.label-zoom") }]} onChange={value => set({ defaultWheelBehavior: value })} />
    </SettingItem>
    <SettingItem name={t("plugins.canvas.option-node-label")}>
      <Dropdown value={data.cardLabelVisibility} options={[{ value: "always", label: t("plugins.canvas.label-always") }, { value: "hover", label: t("plugins.canvas.label-hover") }, { value: "never", label: t("plugins.canvas.label-never") }]} onChange={value => set({ cardLabelVisibility: value })} />
    </SettingItem>
    <ToggleRow name={t("plugins.canvas.option-snap-to-grid")} description={describe("plugins.canvas.option-snap-to-grid")} value={data.snapToGrid} onChange={value => set({ snapToGrid: value })} />
    <ToggleRow name={t("plugins.canvas.option-snap-to-objects")} description={describe("plugins.canvas.option-snap-to-objects")} value={data.snapToObjects} onChange={value => set({ snapToObjects: value })} />
    <SliderRow name={t("plugins.canvas.option-zoom-breakpoint")} description={describe("plugins.canvas.option-zoom-breakpoint")} value={data.zoomBreakpoint} defaultValue={1} min={0.2} max={2} step={0.05} format={value => `${Math.round(value * 100)}%`} onChange={value => set({ zoomBreakpoint: value })} />
  </Group>;
}

const DAILY_NOTE_FORMATS = ["YYYY-MM-DD", "YYYY.MM.DD", "YYYY/MM/DD", "YYYY/MM/YYYY-MM-DD"];
function dailyNoteFormatError(format: string): string {
  if (!format) return "";
  const sample = moment().format(format);
  if (format.startsWith("/")) return t("plugins.daily-notes.msg-invalid-date-format");
  if (/[\\:*?"<>|]/.test(sample)) return t("plugins.file-explorer.msg-invalid-characters") + '\\ / : * ? " < > |';
  return moment(sample, format, true).isValid() ? "" : t("plugins.daily-notes.msg-invalid-date-format");
}

export function DailyNotesOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "daily-notes", { format: "", folder: "", template: "" });
  const formats = DAILY_NOTE_FORMATS;
  const format = data.format || formats[0];
  const [custom, setCustom] = useState<boolean | null>(null);
  const [draft, setDraft] = useState(format);
  useEffect(() => setDraft(format), [format]);
  const showCustom = custom ?? true;
  const error = dailyNoteFormatError(draft);
  return <Group>
    <SettingItem name={t("plugins.daily-notes.option-date-format")} description={describe("plugins.daily-notes.option-date-format")}>
      <Dropdown value={custom ?? !formats.includes(format) ? "custom" : format} options={[...formats.map(value => ({ value, label: moment().format(value) })), { value: "custom", label: t("plugins.daily-notes.option-custom") }]} onChange={value => { setCustom(value === "custom"); if (value !== "custom") set({ format: value }); }} />
    </SettingItem>
    <SettingItem name={t("plugins.daily-notes.option-custom-date-format")} description={<DateFormatHint format={draft} fallback={formats[0]} />} className={error ? "is-invalid" : undefined} style={showCustom ? undefined : { display: "none" }}>
      <input type="text" spellCheck={false} value={draft} placeholder={formats[0]} onChange={event => {
        const value = event.target.value;
        setDraft(value);
        if (!dailyNoteFormatError(value)) set({ format: value.trim() });
      }} />
      <div className="setting-item-error">{error}</div>
    </SettingItem>
    <SettingItem name={t("plugins.daily-notes.option-new-file-location")} description={describe("plugins.daily-notes.option-new-file-location")}><TextInput value={data.folder} placeholder={folderPlaceholder()} onChange={value => set({ folder: value })} /></SettingItem>
    <SettingItem name={t("plugins.daily-notes.option-template")} description={describe("plugins.daily-notes.option-template")}><TemplateFile environment={environment} value={data.template} onChange={value => set({ template: value })} /></SettingItem>
  </Group>;
}

export function TemplatesOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "templates", { folder: "", dateFormat: "", timeFormat: "" });
  return <Group>
    <SettingItem name={t("plugins.templates.option-template-folder-location")} description={describe("plugins.templates.option-template-folder-location")}><TextInput value={data.folder} placeholder={folderPlaceholder()} onChange={value => set({ folder: value })} /></SettingItem>
    <SettingItem name={t("plugins.templates.option-template-date-format")} description={<>{literal("plugins.templates.option-template-date-format-description")}<br />{literal("plugins.templates.option-template-date-format-description2")}<br /><DateFormatHint format={data.dateFormat} fallback="YYYY-MM-DD" /></>}><TextInput value={data.dateFormat} placeholder="YYYY-MM-DD" onChange={value => set({ dateFormat: value })} /></SettingItem>
    <SettingItem name={t("plugins.templates.option-template-time-format")} description={<>{literal("plugins.templates.option-template-time-format-description")}<br />{literal("plugins.templates.option-template-time-format-description2")}<br /><DateFormatHint format={data.timeFormat} fallback="HH:mm" /></>}><TextInput value={data.timeFormat} placeholder="HH:mm" onChange={value => set({ timeFormat: value })} /></SettingItem>
  </Group>;
}

export function NoteComposerOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "note-composer", { replacementText: "link", template: "", askBeforeMerging: true });
  return <Group>
    <SettingItem name={t("plugins.note-composer.option-split-replacement-text")} description={describe("plugins.note-composer.option-split-replacement-text")}>
      <Dropdown value={data.replacementText} options={["link", "embed", "none"].map(value => ({ value, label: t(`plugins.note-composer.option-choice-split-replacement-text-${value}`) }))} onChange={value => set({ replacementText: value })} />
    </SettingItem>
    <SettingItem name={t("plugins.note-composer.option-template-file")} description={literal("plugins.note-composer.option-template-file-description")}><TemplateFile environment={environment} value={data.template} placeholder={t("setting.file-path-example-placeholder")} onChange={value => set({ template: value })} /></SettingItem>
    <ToggleRow name={t("plugins.note-composer.option-confirm-file-merge")} description={describe("plugins.note-composer.option-confirm-file-merge")} value={data.askBeforeMerging} onChange={value => set({ askBeforeMerging: value })} />
  </Group>;
}

export function CommandPaletteOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "command-palette", { pinned: [] as string[] });
  const commands = environment.host.app.commands.commands;
  const add = async () => {
    const command = await chooseItem(environment.host.app, [...commands.values()].filter(item => !data.pinned.includes(item.id)), item => item.name, { placeholder: t("plugins.command-palette.prompt-add-command"), emptyText: t("plugins.command-palette.label-no-commands") });
    if (command) set({ pinned: [...data.pinned, command.id] });
  };
  return <Group className="mod-list mod-no-icon" heading={t("plugins.command-palette.label-pinned-commands")} headingControls={<ClickableIcon icon="lucide-plus" className="extra-setting-button" label={t("plugins.command-palette.action-add-command")} tabIndex={0} onClick={() => void add()} />}>
    {data.pinned.map(id => <div className="setting-item" tabIndex={-1} key={id}><div className="setting-item-icon" /><div className="setting-item-info"><div className="setting-item-name">{commands.get(id)?.name ?? id}</div><div className="setting-item-description" /></div><div className="setting-item-control">
      <ClickableIcon icon="lucide-x" className="extra-setting-button" label={t("interface.menu.remove")} tabIndex={0} onClick={() => set({ pinned: data.pinned.filter(item => item !== id) })} />
    </div></div>)}
    {!data.pinned.length && <EmptyState text={t("plugins.command-palette.label-no-commands")} />}
  </Group>;
}

export function WebViewerOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "webviewer", { homepage: "about:blank", searchEngine: "duckduckgo", customSearchUrl: "", markdownPath: "", openExternalURLs: false });
  const engines = ["duckduckgo", "google", "bing", "brave", "kagi", "ecosia"].map(value => ({ value, label: value === "duckduckgo" ? "DuckDuckGo" : value[0].toUpperCase() + value.slice(1) }));
  return <Group>
    <ToggleRow name={t("plugins.web-viewer.option-open-external-links")} description={describe("plugins.web-viewer.option-open-external-links")} value={data.openExternalURLs} onChange={value => set({ openExternalURLs: value })} />
    <SettingItem name={t("plugins.web-viewer.option-homepage")} description={describe("plugins.web-viewer.option-homepage")}><TextInput value={data.homepage} onChange={value => set({ homepage: value || "about:blank" })} /></SettingItem>
    <SettingItem name={t("plugins.web-viewer.option-search-engine")} description={describe("plugins.web-viewer.option-search-engine")}>
      <Dropdown value={data.searchEngine} options={[...engines, { value: "custom", label: t("plugins.web-viewer.option-search-engine-custom-drop-down") }]} onChange={value => set({ searchEngine: value })} />
    </SettingItem>
    {data.searchEngine === "custom" && <SettingItem name={t("plugins.web-viewer.option-search-engine-custom")} description={describe("plugins.web-viewer.option-search-engine-custom")}><TextInput value={data.customSearchUrl} onChange={value => set({ customSearchUrl: value })} /></SettingItem>}
    <SettingItem name={t("plugins.web-viewer.option-saved-markdown")} description={describe("plugins.web-viewer.option-saved-markdown")}><TextInput value={data.markdownPath} onChange={value => set({ markdownPath: value })} /></SettingItem>
  </Group>;
}

export function FileRecoveryOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "file-recovery", { intervalMinutes: 5, keepDays: 7 });
  return <Group>
    <SettingItem name={t("plugins.file-recovery.option-interval")} description={describe("plugins.file-recovery.option-interval")}><TextInput type="number" value={String(data.intervalMinutes)} onChange={value => set({ intervalMinutes: Math.max(1, Number(value) || 5) })} /></SettingItem>
    <SettingItem name={t("plugins.file-recovery.option-keep")} description={describe("plugins.file-recovery.option-keep")}><TextInput type="number" value={String(data.keepDays)} onChange={value => set({ keepDays: Math.max(1, Number(value) || 7) })} /></SettingItem>
  </Group>;
}

/** The reference lists the built-in preview sources in this order, then the ones plugins add. */
const HOVER_SOURCE_ORDER = ["search", "preview", "editor", "tab-header", "file-explorer", "properties", "bookmarks", "outline", "bases", "graph"];
const hoverSourceRank = (id: string, position: number) => { const index = HOVER_SOURCE_ORDER.indexOf(id); return index < 0 ? HOVER_SOURCE_ORDER.length + position : index; };

export function PagePreviewOptions({ environment }: { environment: SettingsEnvironment }) {
  const [data, set] = usePluginData(environment, "page-preview", {} as Record<string, boolean>);
  const [query, setQuery] = useState("");
  const [, setRevision] = useState(0);
  const workspace = environment.host.workspace;
  useEffect(() => {
    const ref = workspace.on("hover-link-sources-changed", () => setRevision(revision => revision + 1));
    return () => workspace.offref(ref);
  }, [workspace]);
  const needle = query.trim().toLowerCase();
  return <div className="setting-group mod-list mod-no-icon">
    <div className="setting-item setting-item-heading"><div className="setting-item-name">{t("plugins.page-preview.label-require-mod", { key: process.platform === "darwin" ? "Cmd" : "Ctrl" })}</div><div className="setting-item-control" /></div>
    <div className="setting-group-search" tabIndex={-1}><SearchInput value={query} onChange={setQuery} placeholder={t("interface.prompt-filter")} /></div>
    <div className="setting-items">{Object.entries(workspace.hoverLinkSources).map((entry, position) => ({ entry, position })).sort((a, b) => hoverSourceRank(a.entry[0], a.position) - hoverSourceRank(b.entry[0], b.position)).map(item => item.entry).filter(([, info]) => !needle || info.display.toLowerCase().includes(needle)).map(([id, info]) =>
      <ToggleRow key={id} icon="" name={info.display} value={data[id] ?? info.defaultMod} onChange={value => set({ [id]: value })} />
    )}</div>
  </div>;
}

export function SyncOptions({ environment }: { environment: SettingsEnvironment }) {
  const origin = ipcRenderer.sendSync("obsen-server-url") || "https://api.obsidian.md";
  const session = new AccountClient({ origin, storage: localStorage }).session;
  if (!session) return <>
    <p>{t("plugins.sync.label-sync-introduction")}</p>
    <p>{t("plugins.sync.label-account-required")}</p>
    <div className="modal-button-container">
      <button className="mod-cta" onClick={() => void shell.openExternal(siteUrl("auth#signup"))}>{t("plugins.sync.button-sign-up")}</button>
      <button onClick={() => openLoginModal(environment, () => environment.host.app.trigger("plugin-settings-changed"))}>{t("plugins.sync.button-log-in")}</button>
    </div>
  </>;
  return <SyncVaultManager origin={localStorage.getItem("obsen:sync-origin") || "https://sync.obsidian.md"} token={session.token} vault={environment.host.vault} app={environment.host.app} />;
}
