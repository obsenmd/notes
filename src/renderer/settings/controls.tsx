import { shell } from "../../../platforms/platform";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { RuntimeHost } from "../../compat/runtime-host";
import { hasTranslation, t } from "../../i18n";
import type { AppActions } from "../actions";
import { type Config, type ConfigKey, type VaultConfig, useConfig } from "../config";
import { readCorePluginData, writeCorePluginData, type CorePluginStore } from "../core-plugins";
import type { ActiveVault } from "../vault-fs";
import { ClickableIcon, Dropdown as PlainDropdown, IconEl, SearchInput, Slider, Toggle, cx } from "../ui";

export interface SettingsEnvironment { host: RuntimeHost; config: VaultConfig; corePlugins: CorePluginStore; actions: AppActions; vault: ActiveVault }

/** A page opened from a navigable row; it replaces the tab content until the user goes back. */
export interface SettingPageDefinition { id: string; title: string; render(): ReactNode }
export interface SettingsContextValue {
  openPage(page: SettingPageDefinition): void;
  closePage(): void;
  /** True while a tab is rendered off screen to build the settings search index. */
  indexing: boolean;
  /** Index only: the pages enclosing the rows being rendered, and where pages announce themselves so a search result can open them. */
  pagePath?: string[];
  registerPage?(pagePath: string[], page: SettingPageDefinition): void;
}
export const SettingsContext = createContext<SettingsContextValue>({ openPage() {}, closePage() {}, indexing: false });

/** The reference sizes every settings dropdown to its selected label. */
export function Dropdown<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label?: string }) {
  return <PlainDropdown autoWidth {...props} />;
}

export const helpUrl = (page: string) => `https://obsidian.md/help/${page}`;
export const siteUrl = (page: string) => `https://obsidian.md/${page}`;
export function ExternalLink({ href, children, rel = true }: { href: string; children: ReactNode; rel?: boolean }) {
  // Opened through the shell so it also works from the settings window, which has no window-open handler of its own.
  return <a href={href} target="_blank" rel={rel ? "noopener" : undefined} onClick={event => { event.preventDefault(); event.stopPropagation(); void shell.openExternal(href); }}>{children}</a>;
}

/**
 * A settings row. `aliases` and `searchable` feed the settings search only; `icon` is the leading icon of list rows;
 * `onAction` makes the whole row a button (`mod-action`).
 */
export function SettingItem({ name, description, children, className, noInfo, style, aliases, searchable, searchName, icon, onAction, onContextMenu, nameStyle, descriptionClass }: {
  name?: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; noInfo?: boolean; style?: CSSProperties;
  aliases?: string[]; searchable?: boolean; searchName?: string; icon?: string; onAction?: () => void; onContextMenu?: (event: ReactMouseEvent) => void; nameStyle?: CSSProperties; descriptionClass?: string;
}) {
  const { indexing } = useContext(SettingsContext);
  const index = indexing ? { "data-search-aliases": aliases?.length ? JSON.stringify(aliases) : undefined, "data-searchable": searchable === false ? "false" : undefined, "data-search-name": searchName } : {};
  return <div className={cx("setting-item", className, onAction && "mod-action tappable")} tabIndex={-1} style={style} onClick={onAction} onContextMenu={onContextMenu} {...index}>
    {icon !== undefined && (icon ? <IconEl className="setting-item-icon" icon={icon} /> : <div className="setting-item-icon" />)}
    <div className="setting-item-info" style={noInfo ? { display: "none" } : undefined}>
      <div className="setting-item-name" style={nameStyle}>{name}</div>
      <div className={cx("setting-item-description", descriptionClass)}>{description}</div>
    </div>
    <div className="setting-item-control">{children}</div>
  </div>;
}

/** Description text for a setting, following the resources' `-description` / `-desc` suffix convention. */
export function describe(key: string): string {
  for (const suffix of ["-description", "-desc"]) if (hasTranslation(key + suffix)) return t(key + suffix);
  return "";
}

/** A titled block of settings; the first group of a tab has no heading. `list` groups are the reference's list type. */
export function Group({ heading, children, className, headingControls, list, noIcon, search }: { heading?: string; children: ReactNode; className?: string; headingControls?: ReactNode; list?: boolean; noIcon?: boolean; search?: ReactNode }) {
  return <div className={cx("setting-group", list && "mod-list", list && noIcon && "mod-no-icon", className)}>
    {(heading !== undefined || headingControls !== undefined) && <div className="setting-item setting-item-heading">
      <div className="setting-item-name">{heading}</div>
      <div className="setting-item-control">{headingControls}</div>
    </div>}
    <div className="setting-group-search" tabIndex={-1} style={search ? undefined : { display: "none" }}>{search}</div>
    <div className="setting-items">{children}</div>
  </div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="setting-item mod-empty-state" tabIndex={-1}><div className="setting-item-info"><div className="setting-item-name">{children}</div><div className="setting-item-description" /></div><div className="setting-item-control" /></div>;
}

export function GroupSearch({ value, onChange, placeholder }: { value: string; onChange(value: string): void; placeholder: string }) {
  return <SearchInput value={value} onChange={onChange} placeholder={placeholder} />;
}

export function ExtraButton({ icon, label, onClick, disabled, className, tabIndex = 0 }: { icon: string; label?: string; onClick?: () => void; disabled?: boolean; className?: string; tabIndex?: number }) {
  return <ClickableIcon icon={icon} className={cx("extra-setting-button", className)} label={label} tabIndex={tabIndex} aria-disabled={disabled === undefined ? undefined : disabled} onClick={disabled ? undefined : event => { event.stopPropagation(); onClick?.(); }} />;
}

export function ToggleRow({ name, description, value, onChange, extra, icon }: { name: string; description?: ReactNode; value: boolean; onChange(value: boolean): void; extra?: ReactNode; icon?: string }) {
  return <SettingItem className="mod-toggle" name={name} description={description} icon={icon}>{extra}<Toggle value={value} onChange={onChange} /></SettingItem>;
}

/** Toggle bound to a boolean preference; `nameKey` supplies both the label and its description. */
export function ConfigToggle({ config, id, nameKey, invert, extra }: { config: VaultConfig; id: { [K in ConfigKey]: Config[K] extends boolean | null ? K : never }[ConfigKey]; nameKey: string; invert?: boolean; extra?: ReactNode }) {
  const value = useConfig(config, id) === true;
  return <ToggleRow name={t(nameKey)} description={describe(nameKey)} value={invert ? !value : value} onChange={next => config.set(id, (invert ? !next : next) as never)} extra={extra} />;
}

export function ConfigDropdown<K extends ConfigKey>({ config, id, nameKey, options }: { config: VaultConfig; id: K; nameKey: string; options: Array<{ value: Config[K] & string; labelKey: string }> }) {
  const value = useConfig(config, id) as Config[K] & string;
  return <SettingItem name={t(nameKey)} description={describe(nameKey)}>
    <Dropdown value={value} options={options.map(option => ({ value: option.value, label: t(option.labelKey) }))} onChange={next => config.set(id, next as Config[K])} />
  </SettingItem>;
}

export function RestoreButton({ disabled, onClick }: { disabled: boolean; onClick(): void }) {
  return <ClickableIcon icon="lucide-rotate-ccw" className="extra-setting-button" label={t("setting.hotkeys.tooltip-restore-default")} aria-disabled={disabled} tabIndex={0} onClick={disabled ? undefined : onClick} />;
}

export function SliderRow({ name, description, value, defaultValue, min, max, step, format, onChange, aliases }: { name: string; description?: string; aliases?: string[]; value: number; defaultValue?: number; min: number; max: number; step: number; format?: (value: number) => string; onChange(value: number): void }) {
  return <SettingItem name={name} description={description} aliases={aliases}>
    {defaultValue !== undefined && <RestoreButton disabled={value === defaultValue} onClick={() => onChange(defaultValue)} />}
    <Slider value={value} min={min} max={max} step={step} format={format ?? String} onChange={onChange} />
  </SettingItem>;
}

/** Text field that commits on change and keeps local state while typing. */
export function TextInput({ value, onChange, placeholder, type = "text", className }: { value: string; onChange(value: string): void; placeholder?: string; type?: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input type={type} className={className} spellCheck={false} placeholder={placeholder} value={draft} onChange={event => { setDraft(event.target.value); onChange(event.target.value); }} />;
}

export function NavigableRow({ name, description, value, onClick, status, searchable }: { name: string; description?: string; value?: ReactNode; onClick(): void; status?: "warning" | null; searchable?: boolean }) {
  const { indexing } = useContext(SettingsContext);
  return <div className="setting-item mod-navigable tappable" tabIndex={-1} onClick={onClick} data-searchable={indexing && searchable === false ? "false" : undefined}>
    <div className="setting-item-info"><div className="setting-item-name">{name}</div><div className="setting-item-description">{description}</div></div>
    <div className="setting-item-control">
      {((value !== undefined && value !== "") || status) && <div className="setting-item-value">{value}</div>}
      {status === "warning" && <IconEl className="setting-item-status mod-warning" icon="lucide-alert-triangle" />}
      <IconEl className="setting-item-chevron" icon="lucide-chevron-right" />
    </div>
  </div>;
}

/** A navigable row that opens a page. While the search index is built its page content is rendered beside it. */
export function PageRow({ id, name, description, value, status, page }: { id?: string; name: string; description?: string; value?: ReactNode; status?: "warning" | null; page(): ReactNode }) {
  const context = useContext(SettingsContext);
  const definition: SettingPageDefinition = { id: id ?? name, title: name, render: page };
  const pagePath = [...(context.pagePath ?? []), definition.id];
  useEffect(() => { if (context.indexing) context.registerPage?.(pagePath, definition); });
  return <>
    <NavigableRow name={name} description={description} value={value} status={status} searchable={false} onClick={() => context.openPage(definition)} />
    {context.indexing && <div data-setting-page={definition.id} data-setting-page-name={name}><SettingsContext.Provider value={{ ...context, pagePath }}>{page()}</SettingsContext.Provider></div>}
  </>;
}

/** Loads and saves one core plugin's data file (`.obsidian/<id>.json`). */
export function usePluginData<T extends Record<string, unknown>>(environment: SettingsEnvironment, id: string, defaults: T): [T, (patch: Partial<T>) => void] {
  const [data, setData] = useState<T>(defaults);
  const latest = useRef(data);
  const persisted = useRef<Partial<T>>({});
  useEffect(() => {
    let cancelled = false;
    void readCorePluginData(environment.config.configDir, id).then(saved => { if (!cancelled) { persisted.current = saved as Partial<T>; latest.current = { ...defaults, ...saved }; setData(latest.current); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [environment.config.configDir, id]);
  return [data, patch => {
    const next = { ...latest.current, ...patch };
    latest.current = next; setData(next);
    persisted.current = { ...persisted.current, ...patch };
    void writeCorePluginData(environment.config.configDir, id, persisted.current as Record<string, unknown>).then(() => environment.host.workspace.trigger("core-plugin-settings-change", id)).catch(error => console.error(error));
  }];
}
