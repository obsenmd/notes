import { path, originalFs as fs, ipcRenderer, shell, getRemote, process } from "../../../platforms/platform";
import { apiVersion } from "../../compat/utilities";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot } from "react-dom/client";


import moment from "moment";

import { AccountClient, type AccountSession } from "../../compat/account";
import { Menu, Modal, Notice } from "../../compat/ui";
import { requestText } from "../../controllers/dialogs";
import { brandName, getLanguage, setLanguage, t } from "../../i18n";
import { useT } from "../../i18n/react";
import languages from "../../../assets/obsidian/locales/languages.json";
import { applySpellcheckLanguages, getSpellcheckLanguages, setSpellcheckLanguages } from "../appearance";
import { Combobox } from "../bases/ui";
import { DEFAULT_APPEARANCE_CONFIG, DEFAULT_APP_CONFIG, appOptions, getRibbonLayout, relaunchApp, useAnyConfig, useConfig, type VaultConfig } from "../config";
import { listSnippets, listThemes } from "../custom-css";
import { Login } from "../Login";
import { openCommunityModal } from "../CommunityModal";
import { IconEl, cx } from "../ui";
import { ConfigDropdown, ConfigToggle, Dropdown, EmptyState, ExternalLink, ExtraButton, Group, GroupSearch, PageRow, RestoreButton, SettingItem, SliderRow, TextInput, ToggleRow, describe, helpUrl, siteUrl, type SettingsEnvironment } from "./controls";

const reload = () => window.location.reload();
const RelaunchButton = ({ onClick = relaunchApp, hidden }: { onClick?: () => void; hidden?: boolean }) => <button className="mod-cta" style={hidden ? { display: "none" } : undefined} onClick={onClick}>{t("setting.about.button-relaunch")}</button>;
const accountOrigin = (): string => ipcRenderer.sendSync("obsen-server-url") || "https://api.obsidian.md";
const LearnMore = ({ page, rel }: { page: string; rel?: boolean }) => <ExternalLink href={helpUrl(page)} rel={rel}>{t("interface.button-learn-more")}</ExternalLink>;
const useRerender = () => useReducer((tick: number) => tick + 1, 0)[1];

function useAccount(): [AccountSession | null, () => void] {
  const read = () => new AccountClient({ origin: accountOrigin(), storage: localStorage }).session;
  const [session, setSession] = useState<AccountSession | null>(read);
  return [session, () => setSession(read())];
}

/** Drag a row by its handle to another position within the same list. */
function startRowDrag(event: ReactMouseEvent, onReorder: (from: number, to: number) => void): void {
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>(".setting-item"), list = row?.parentElement;
  if (!row || !list || event.button !== 0) return;
  event.preventDefault();
  const rows = [...list.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(".setting-item:not(.mod-add-item)") && child.offsetParent !== null);
  const from = rows.indexOf(row), doc = row.ownerDocument;
  let target = from;
  const at = (y: number) => { let index = rows.length - 1; for (let i = 0; i < rows.length; i++) { const box = rows[i].getBoundingClientRect(); if (y < box.top + box.height / 2) { index = i; break; } } return index; };
  const move = (moved: MouseEvent) => {
    target = at(moved.clientY);
    for (const [index, item] of rows.entries()) item.style.boxShadow = index === target && index !== from ? `0 ${target > from ? "" : "-"}2px 0 0 var(--interactive-accent)` : "";
  };
  const up = () => {
    doc.removeEventListener("mousemove", move); doc.removeEventListener("mouseup", up);
    row.classList.remove("is-being-dragged"); for (const item of rows) item.style.boxShadow = "";
    if (target !== from) onReorder(from, target);
  };
  row.classList.add("is-being-dragged");
  doc.addEventListener("mousemove", move); doc.addEventListener("mouseup", up);
}
const DragHandle = ({ onReorder }: { onReorder(from: number, to: number): void }) => <IconEl icon="lucide-menu" className="clickable-icon extra-setting-button mod-drag-handle" tabIndex={-1} aria-label={t("interface.drag-to-rearrange")} onMouseDown={event => startRowDrag(event, onReorder)} />;
const DeleteButton = ({ onClick }: { onClick(): void }) => <ExtraButton icon="lucide-x" label={t("interface.delete-action-short-name")} onClick={onClick} />;

// ---------------------------------------------------------------- General

interface CommercialLicense { key: string; company?: string; seats?: number; expiry?: number }
const LICENSE_KEY = "obsen:commercial-license";
const readLicense = (): CommercialLicense | null => { try { const value = JSON.parse(localStorage.getItem(LICENSE_KEY) ?? "null") as CommercialLicense | null; return value?.key ? value : null; } catch { return null; } };

/** "Commercial license" dialog: the key is checked with the account service before it is kept. */
function openLicenseModal(environment: SettingsEnvironment, onDone: () => void): void {
  const modal = new Modal(environment.host.app);
  modal.modalEl.classList.add("mod-lg", "mod-form");
  modal.setTitle(t("setting.about.label-commercial-license"));
  const container = modal.contentEl.createDiv("message-container"), error = container.createDiv("message mod-error");
  error.style.display = "none";
  const field = container.createEl("p", { cls: "form-field" });
  field.createEl("label", { cls: "input-label", text: t("setting.about.label-license-key") });
  const input = field.createEl("input", { type: "text", attr: { placeholder: t("setting.about.license-key-placeholder") } });
  const buttons = modal.modalEl.createDiv("modal-button-container");
  const more = buttons.createEl("a", { cls: "mod-secondary", text: t("interface.button-learn-more"), attr: { href: helpUrl("teams/license"), target: "_blank", rel: "noopener" } });
  more.addEventListener("click", event => { event.preventDefault(); void shell.openExternal(helpUrl("teams/license")); });
  const activate = buttons.createEl("button", { cls: "mod-cta", text: t("setting.about.button-activate") });
  buttons.createEl("button", { cls: "mod-cancel", text: t("dialogue.button-cancel") }).addEventListener("click", () => modal.close());
  const submit = async () => {
    const key = input.value.trim();
    if (!key) return;
    activate.classList.add("mod-loading");
    try {
      const reply = await ipcRenderer.invoke("obsen-account-request", accountOrigin(), "/subscription/business", { key }) as { error?: string; company?: string; seats?: number; expiry?: number } | null;
      if (!reply || reply.error) throw new Error(reply?.error ?? "");
      localStorage.setItem(LICENSE_KEY, JSON.stringify({ key, company: reply.company, seats: reply.seats, expiry: reply.expiry }));
      modal.close();
    } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); error.style.display = ""; }
    finally { activate.classList.remove("mod-loading"); }
  };
  activate.addEventListener("click", () => void submit());
  input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) void submit(); });
  modal.setCloseCallback(onDone);
  modal.open();
  input.focus();
}

/** The log-in form in its own dialog, as the reference shows it. */
export function openLoginModal(environment: SettingsEnvironment, onDone: () => void): void {
  const modal = new Modal(environment.host.app);
  modal.modalEl.classList.add("mod-lg", "mod-form");
  const root = createRoot(modal.contentEl);
  root.render(<Login onLogin={() => modal.close()} />);
  modal.setCloseCallback(() => { root.unmount(); onDone(); });
  modal.open();
}

export function GeneralTab({ environment, version }: { environment: SettingsEnvironment; version: string }) {
  const t = useT();
  const { host } = environment;
  const rerender = useRerender();
  const current = useMemo(() => getLanguage(), []);
  const [language, setChosenLanguage] = useState(current);
  const [checking, setChecking] = useState(false);
  const [account, refreshAccount] = useAccount();
  const [autoUpdate, setAutoUpdate] = useState(() => appOptions.get<boolean>("updateDisabled", false) !== true);
  const [slowStartup, setSlowStartup] = useState(() => !!host.app.loadLocalStorage("slow-startup-check"));
  const [cli, setCli] = useState(() => appOptions.get<boolean>("cli", false) === true);
  const initialGpu = useMemo(() => appOptions.get<boolean>("disableGpu", false) === true, []);
  const [gpuDisabled, setGpuDisabled] = useState(initialGpu);
  const license = readLicense();
  const check = () => { setChecking(true); void ipcRenderer.invoke("version:check").then((result: { upToDate: boolean }) => new Notice(result.upToDate ? t("obsen.settings.up-to-date") : t("interface.label-update-available"))).finally(() => setChecking(false)); };
  const open = (url: string) => void shell.openExternal(url);
  const signOut = (button: HTMLElement) => { button.classList.add("mod-loading"); void new AccountClient({ origin: accountOrigin(), storage: localStorage }).signOut().catch(error => { console.error(error); new Notice(t("obsen.account.error-sign-out")); }).finally(() => { button.classList.remove("mod-loading"); refreshAccount(); }); };
  return <>
    <Group>
      <SettingItem name={t("setting.about.label-version", { version })} searchName={t("setting.about.label-version", { version: "" })} description={<>{t("setting.about.label-install-version", { version: apiVersion })}<br /><ExternalLink href={siteUrl("changelog")}>{t("setting.about.label-read-changelog")}</ExternalLink></>}>
        <button className={checking ? "mod-loading" : undefined} onClick={checking ? undefined : check}>{t("setting.about.button-check-for-updates")}</button>
      </SettingItem>
      <ToggleRow name={t("setting.about.option-auto-update")} description={describe("setting.about.option-auto-update")} value={autoUpdate} onChange={value => { setAutoUpdate(value); appOptions.set("updateDisabled", value ? null : true); }} />
      <SettingItem name={t("setting.about.option-language")} description={<>{t("setting.about.option-language-description")}<br /><ExternalLink href={helpUrl("translations")}>{t("setting.about.label-add-own-language")}</ExternalLink></>}>
        <RelaunchButton hidden={language === current} onClick={() => void setLanguage(language).then(reload)} />
        <Dropdown value={language} options={Object.entries(languages as Record<string, string>).map(([value, label]) => ({ value, label }))} onChange={setChosenLanguage} />
      </SettingItem>
      <SettingItem name={t("setting.about.option-get-help")} description={describe("setting.about.option-get-help")}>
        <button onClick={() => environment.actions.openHelp()}>{t("setting.about.button-open")}</button>
      </SettingItem>
    </Group>
    <Group heading={t("setting.account.name")}>
      {account
        ? <SettingItem name={t("setting.account.option-your-account")} description={t("setting.account.option-your-account-desc", { name: account.name || account.email, email: account.email })}>
            <button onClick={() => open(siteUrl("account"))}>{t("interface.button-manage")}</button>
            <button className="mod-destructive" onClick={event => signOut(event.currentTarget)}>{t("setting.account.button-log-out")}</button>
          </SettingItem>
        : <SettingItem name={t("setting.account.option-your-account")} description={t("setting.account.option-your-account-desc-no-login")}>
            <button onClick={() => openLoginModal(environment, refreshAccount)}>{t("setting.account.label-log-in")}</button>
            <button onClick={() => open(siteUrl("auth#signup"))}>{t("setting.account.label-sign-up")}</button>
          </SettingItem>}
      {account && (account.license
        ? <SettingItem name={t("setting.about.option-catalyst")} description={t("setting.about.option-catalyst-desc", { tier: account.license })}>
            {account.license !== "vip" && <button onClick={() => open(siteUrl("account"))}>{t("setting.account.button-upgrade-catalyst")}</button>}
          </SettingItem>
        : <SettingItem name={t("setting.about.option-catalyst")} description={<>{t("setting.about.option-catalyst-desc-no-license")}<br /><LearnMore page="catalyst" /></>}>
            <button onClick={() => open(siteUrl("account"))}>{t("setting.account.button-purchase")}</button>
          </SettingItem>)}
      {license
        ? <SettingItem name={t("setting.about.label-commercial-license")} description={`${t("setting.about.label-your-commercial-license-key", { key: license.key })}${license.company ? " " + t("setting.about.label-commercial-license-info", { company: license.company, seats: license.seats ?? "", expiry: license.expiry ? moment(license.expiry).format("MMMM D, YYYY") : "" }) : ""}`}>
            <button onClick={() => { localStorage.removeItem(LICENSE_KEY); rerender(); }}>{t("setting.about.button-remove-commercial-license")}</button>
          </SettingItem>
        : <SettingItem name={t("setting.account.option-commercial-license")} description={<>{t("setting.account.option-commercial-license-desc")}<br /><LearnMore page="teams/license" /></>}>
            <button onClick={() => openLicenseModal(environment, rerender)}>{t("setting.about.button-activate")}</button>
            <button onClick={() => open(siteUrl("account"))}>{t("setting.account.button-purchase")}</button>
          </SettingItem>}
    </Group>
    <Group heading={t("setting.about.option-advanced")}>
      <SettingItem className="mod-toggle" name={t("setting.about.option-check-slow-startup")} description={describe("setting.about.option-check-slow-startup")}>
        <ExtraButton icon="lucide-timer" label={t("setting.about.button-check-startup")} />
        <ToggleControl value={slowStartup} onChange={value => { setSlowStartup(value); host.app.saveLocalStorage("slow-startup-check", value ? "1" : null); }} />
      </SettingItem>
      <ToggleRow name={t("setting.about.option-cli")} description={describe("setting.about.option-cli")} value={cli} onChange={value => { setCli(value); appOptions.set("cli", value ? true : null); }} />
      <SettingItem className="mod-toggle" name={t("setting.about.option-hw-acceleration")} description={<div>{t("setting.about.option-hw-acceleration-description")} <span className="mod-warning">{t("setting.about.option-hw-acceleration-warning")}</span></div>}>
        <RelaunchButton hidden={gpuDisabled === initialGpu} />
        <ToggleControl value={!gpuDisabled} onChange={value => { setGpuDisabled(!value); appOptions.set("disableGpu", value ? null : true); }} />
      </SettingItem>
    </Group>
  </>;
}

/** A bare switch for rows that put other controls beside it. */
function ToggleControl({ value, onChange }: { value: boolean; onChange(value: boolean): void }) {
  return <label className={cx("checkbox-container", value && "is-enabled")} tabIndex={0} onClick={event => { event.preventDefault(); onChange(!value); }}
    onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); onChange(!value); } }}>
    <input type="checkbox" tabIndex={-1} checked={value} readOnly />
  </label>;
}

// ---------------------------------------------------------------- Appearance

const parseFonts = (value: string) => value.replace(/["]/g, "").split(",").map(font => font.trim()).filter(Boolean);
const FONT_PROBE = "abcdefghijklmnopqrstuvwxyz0123456789", FONT_BASES = ["monospace", "sans-serif", "serif"];
/** The reference's font detection: a font exists when it changes the width of a probe string against any generic family. */
function fontDetector(): (font: string) => boolean {
  const context = document.createElement("canvas").getContext("2d")!, baselines: Record<string, number> = {};
  for (const base of FONT_BASES) { context.font = `72px ${base}`; baselines[base] = context.measureText(FONT_PROBE).width; }
  return font => FONT_BASES.some(base => { context.font = `72px ${font}, ${base}`; return context.measureText(FONT_PROBE).width !== baselines[base]; });
}
const KNOWN_FONTS = ["Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Cambria Math", "Candara", "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Ebrima", "Franklin Gothic Medium", "Gabriola", "Gadugi", "Georgia", "HoloLens MDL2 Assets", "Impact", "Ink Free", "Javanese Text", "Leelawadee UI", "Lucida Console", "Lucida Sans Unicode", "Malgun Gothic", "Marlett", "Microsoft Himalaya", "Microsoft JhengHei", "Microsoft New Tai Lue", "Microsoft PhagsPa", "Microsoft Sans Serif", "Microsoft Tai Le", "Microsoft YaHei", "Microsoft Yi Baiti", "MingLiU-ExtB", "Mongolian Baiti", "MS Gothic", "MV Boli", "Myanmar Text", "Nirmala UI", "Palatino Linotype", "Segoe MDL2 Assets", "Segoe Print", "Segoe Script", "Segoe UI", "Segoe UI Historic", "Segoe UI Emoji", "Segoe UI Symbol", "SimSun", "Sitka", "Sylfaen", "Symbol", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings", "Yu Gothic", "American Typewriter", "Andale Mono", "Arial", "Arial Black", "Arial Narrow", "Arial Rounded MT Bold", "Arial Unicode MS", "Avenir", "Avenir Next", "Avenir Next Condensed", "Baskerville", "Big Caslon", "Bodoni 72", "Bodoni 72 Oldstyle", "Bodoni 72 Smallcaps", "Bradley Hand", "Brush Script MT", "Chalkboard", "Chalkboard SE", "Chalkduster", "Charter", "Cochin", "Comic Sans MS", "Copperplate", "Courier", "Courier New", "Didot", "DIN Alternate", "DIN Condensed", "Futura", "Geneva", "Georgia", "Gill Sans", "Helvetica", "Helvetica Neue", "Herculanum", "Hoefler Text", "Impact", "Lucida Grande", "Luminari", "Marker Felt", "Menlo", "Microsoft Sans Serif", "Monaco", "Noteworthy", "Optima", "Palatino", "Papyrus", "Phosphate", "Rockwell", "Savoye LET", "SignPainter", "Skia", "Snell Roundhand", "Tahoma", "Times", "Times New Roman", "Trattatello", "Trebuchet MS", "Verdana", "Zapfino"];
let availableFonts: string[] | null = null;
/** Bundled fonts first, then every known font detected on this system, sorted as the reference sorts them. */
function listAvailableFonts(): string[] {
  if (availableFonts) return availableFonts;
  const detect = fontDetector(), seen = new Set<string>(), fonts = ["Inter", "Source Code Pro"];
  for (const font of KNOWN_FONTS) if (!seen.has(font)) { seen.add(font); if (detect(font)) fonts.push(font); }
  return availableFonts = fonts.sort();
}
const matchesWords = (words: string[], text: string) => words.every(word => !word || text.includes(word));

function FontPage({ config, id }: { config: VaultConfig; id: "interfaceFontFamily" | "textFontFamily" | "monospaceFontFamily" }) {
  const t = useT();
  const fonts = parseFonts(useConfig(config, id));
  const [query, setQuery] = useState("");
  const detect = useMemo(fontDetector, []), available = useMemo(listAvailableFonts, []);
  const save = (next: string[]) => config.set(id, next.join(","));
  const typed = query.trim(), words = typed.toLowerCase().split(" ");
  const showTyped = !!typed && !fonts.includes(typed) && !available.some(font => font.toLowerCase() === typed.toLowerCase());
  const normal: CSSProperties = { color: "var(--text-normal)" };
  return <>
    <p className="setting-page-desc">{fonts.length ? t("setting.appearance.label-font-applied") : t("setting.appearance.label-no-custom-font-set")}</p>
    <Group list>
      {fonts.map((font, index) => <SettingItem key={font} searchable={false} name={font} nameStyle={{ fontFamily: font }} description={detect(font) ? undefined : t("setting.appearance.msg-font-not-found")} descriptionClass={detect(font) ? undefined : "mod-warning"}>
        <DeleteButton onClick={() => save(fonts.filter((_item, position) => position !== index))} />
        <DragHandle onReorder={(from, to) => { const next = fonts.slice(); const [moved] = next.splice(from, 1); next.splice(to, 0, moved); save(next); }} />
      </SettingItem>)}
    </Group>
    <Group list search={<GroupSearch value={query} onChange={setQuery} placeholder={t("setting.appearance.option-font-placeholder")} />}>
      <SettingItem searchable={false} name={showTyped ? typed : ""} nameStyle={showTyped ? { fontFamily: typed, ...normal } : normal} style={showTyped ? undefined : { display: "none" }}
        description={showTyped && !detect(typed) ? t("setting.appearance.msg-font-not-found") : undefined} descriptionClass={showTyped && !detect(typed) ? "mod-warning" : undefined}
        onAction={() => { if (typed) save([...fonts, typed]); }} />
      {available.map(font => <SettingItem key={font} searchable={false} name={font} nameStyle={{ fontFamily: font, ...normal }}
        style={fonts.includes(font) || (typed && !matchesWords(words, font.toLowerCase())) ? { display: "none" } : undefined} onAction={() => save([...fonts, font])} />)}
    </Group>
  </>;
}

function SnippetsPage({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const { config } = environment;
  const enabled = useConfig(config, "enabledCssSnippets");
  const [snippets, setSnippets] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const folder = path.join(config.configDir, "snippets");
  const load = () => listSnippets(config.configDir).then(setSnippets);
  useEffect(() => { void load(); }, [config.configDir]);
  const needle = query.trim().toLowerCase();
  const showMenu = (event: ReactMouseEvent, snippet: string) => {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem(item => item.setTitle(t(process.platform === "darwin" ? "plugins.open-with-default-app.action-show-in-folder-mac" : "plugins.open-with-default-app.action-show-in-folder")).setIcon("lucide-arrow-up-right").onClick(() => shell.showItemInFolder(path.join(folder, `${snippet}.css`))));
    menu.showAtMouseEvent(event.nativeEvent);
  };
  return <Group list noIcon
    headingControls={<>
      <ExtraButton icon="lucide-refresh-cw" label={t("setting.appearance.button-reload-snippets")} onClick={() => void load().then(() => { window.dispatchEvent(new Event("custom-css-changed")); new Notice(t("setting.appearance.msg-reloaded-snippets")); })} />
      <ExtraButton icon="lucide-folder-open" label={t("setting.appearance.button-open-snippets-folder")} onClick={() => void fs.promises.mkdir(folder, { recursive: true }).then(() => shell.openPath(folder))} />
    </>}
    search={snippets.length ? <GroupSearch value={query} onChange={setQuery} placeholder={t("setting.appearance.placeholder-search-snippet")} /> : undefined}>
    {snippets.map(snippet => <SettingItem key={snippet} icon="" className="mod-toggle" name={snippet} style={needle && !snippet.toLowerCase().includes(needle) ? { display: "none" } : undefined} onContextMenu={event => showMenu(event, snippet)}>
      <ToggleControl value={enabled.includes(snippet)} onChange={value => config.set("enabledCssSnippets", value ? [...enabled.filter(item => item !== snippet), snippet] : enabled.filter(item => item !== snippet))} />
    </SettingItem>)}
    {!snippets.length && <EmptyState>{t("setting.appearance.no-snippet-description", { path: `vault/${path.basename(config.configDir)}/snippets` })} <LearnMore page="snippets" rel={false} /></EmptyState>}
  </Group>;
}

/** "Custom app icon": the chosen image is copied into the profile; the main process uses it for its windows at the next start. */
function CustomIconRow() {
  const t = useT();
  const rerender = useRerender();
  const [changed, setChanged] = useState(false);
  const icon = appOptions.get<string | null>("icon", null), optionsFile = appOptions.file();
  const iconPath = icon && optionsFile ? path.join(path.dirname(optionsFile), icon) : null;
  const choose = async () => {
    const file = await ipcRenderer.invoke("pick-file") as string | null;
    if (!file || !optionsFile) return;
    const extension = path.extname(file).slice(1).toLowerCase();
    if (!["png", "ico", "icns"].includes(extension)) return;
    await fs.promises.copyFile(file, path.join(path.dirname(optionsFile), `icon.${extension}`));
    appOptions.set("icon", `icon.${extension}`); setChanged(true); rerender();
  };
  return <SettingItem name={t("setting.appearance.option-custom-icon")} description={iconPath ? <img width={64} height={64} src={`file:///${iconPath.replace(/\\/g, "/")}?${changed ? Date.now() : ""}`} /> : t("setting.appearance.option-custom-icon-desc")}>
    {icon && <RestoreButton disabled={false} onClick={() => { appOptions.set("icon", null); setChanged(true); rerender(); }} />}
    <button onClick={() => void choose()}>{t("dialogue.button-choose")}</button>
    <RelaunchButton hidden={!changed} />
  </SettingItem>;
}

export function AppearanceTab({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const { config } = environment;
  useAnyConfig(config);
  const [themes, setThemes] = useState<string[]>([]);
  const [snippets, setSnippets] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(0);
  useEffect(() => { void listThemes(config.configDir).then(setThemes); void listSnippets(config.configDir).then(setSnippets); }, [config.configDir, browsing]);
  const enabled = config.get("enabledCssSnippets").filter(snippet => snippets.includes(snippet));
  const accent = config.get("accentColor");
  const detect = useMemo(fontDetector, []);
  const browse = () => openCommunityModal("theme", environment, () => setBrowsing(value => value + 1));
  const themesFolder = path.join(config.configDir, "themes");
  const fontRow = (id: "interfaceFontFamily" | "textFontFamily" | "monospaceFontFamily", nameKey: string) => {
    const fonts = parseFonts(config.get(id));
    return <PageRow name={t(nameKey)} description={describe(nameKey)} value={fonts.length === 0 ? "" : fonts.length === 1 ? fonts[0] : t("setting.appearance.label-font-count", { count: fonts.length })}
      status={fonts.some(font => !detect(font)) ? "warning" : null} page={() => <FontPage config={config} id={id} />} />;
  };
  return <>
    <Group>
      <SettingItem name={t("setting.appearance.option-base-theme")} description={describe("setting.appearance.option-base-theme")} aliases={[t("setting.appearance.alias-base-theme")]}>
        <Dropdown value={config.get("theme")} options={[{ value: "obsidian", label: t("setting.appearance.dark-theme") }, { value: "moonstone", label: t("setting.appearance.light-theme") }, { value: "system", label: t("setting.appearance.system-theme") }]} onChange={value => config.set("theme", value)} />
      </SettingItem>
      <SettingItem className="mod-toggle" name={t("setting.appearance.option-accent-color")} description={describe("setting.appearance.option-accent-color")} aliases={[t("setting.appearance.alias-accent-color")]}>
        <RestoreButton disabled={!accent} onClick={() => config.set("accentColor", "")} />
        <input type="color" value={accent || "#8a5cf5"} onChange={event => config.set("accentColor", event.target.value)} />
      </SettingItem>
      <SettingItem name={t("setting.appearance.option-themes")} description={t("setting.appearance.option-manage-themes-description")} aliases={[t("setting.appearance.alias-themes")]}>
        <ExtraButton icon="lucide-folder-open" label={t("setting.appearance.button-open-themes-folder")} onClick={() => void fs.promises.mkdir(themesFolder, { recursive: true }).then(() => shell.openPath(themesFolder))} />
        <Dropdown value={themes.includes(config.get("cssTheme")) ? config.get("cssTheme") : ""} options={[{ value: "", label: t("setting.appearance.label-default-theme") }, ...themes.map(theme => ({ value: theme, label: theme }))]} onChange={value => config.set("cssTheme", value)} />
        <button onClick={browse}>{t("setting.appearance.option-theme-button-manage")}</button>
      </SettingItem>
      <SettingItem name={t("setting.appearance.label-current-themes")} description={`${t("setting.appearance.label-currently-installed", { count: themes.length })} `}>
        {themes.length > 0 && <button onClick={browse}>{t("setting.appearance.button-check-for-updates")}</button>}
      </SettingItem>
      <PageRow name={t("setting.appearance.option-css-snippets")} description={describe("setting.appearance.option-css-snippets")} value={t("setting.appearance.label-enabled-snippets-count", { count: enabled.length })} page={() => <SnippetsPage environment={environment} />} />
    </Group>
    <Group heading={t("setting.appearance.option-font")}>
      {fontRow("interfaceFontFamily", "setting.appearance.option-interface-font")}
      {fontRow("textFontFamily", "setting.appearance.option-text-font")}
      {fontRow("monospaceFontFamily", "setting.appearance.option-monospace-font")}
      <SliderRow name={t("setting.appearance.option-font-size")} description={describe("setting.appearance.option-font-size")} aliases={[t("setting.appearance.alias-font-size")]} value={config.get("baseFontSize")} defaultValue={DEFAULT_APPEARANCE_CONFIG.baseFontSize} min={10} max={30} step={1} onChange={value => config.set("baseFontSize", value)} />
      <ConfigToggle config={config} id="baseFontSizeAction" nameKey="setting.appearance.option-font-size-action" />
    </Group>
    <Group heading={t("setting.appearance.option-advanced")}>
      <CustomIconRow />
    </Group>
  </>;
}

// ---------------------------------------------------------------- Interface

function RibbonPage({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const layout = getRibbonLayout(environment.config.vaultPath);
  const rerender = useRerender();
  useEffect(() => layout.onChange(rerender), [layout]);
  const items = layout.items(), visible = items.filter(item => !item.hidden), hidden = items.filter(item => item.hidden);
  return <>
    <Group list noIcon={false}>
      {visible.map(item => <SettingItem key={item.id} searchable={false} icon={item.icon} name={item.title}>
        <DeleteButton onClick={() => layout.setHidden(item.id, true)} />
        <DragHandle onReorder={(from, to) => layout.move(from, to)} />
      </SettingItem>)}
    </Group>
    {hidden.length > 0 && <Group list heading={t("setting.appearance.label-additional-ribbon-items")}>
      {hidden.map(item => <SettingItem key={item.id} searchable={false} icon={item.icon} name={item.title} onAction={() => layout.setHidden(item.id, false)} />)}
    </Group>}
  </>;
}

export function InterfaceTab({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const { config } = environment;
  const zoom = useConfig(config, "zoomLevel");
  const showRibbon = useConfig(config, "showRibbon");
  const initialFrame = useMemo(() => appOptions.get<string>("frame", "hidden"), []);
  const [frame, setFrame] = useState(initialFrame);
  const [frameChanged, setFrameChanged] = useState(false);
  return <>
    <Group>
      <ConfigToggle config={config} id="showViewHeader" nameKey="setting.appearance.option-show-view-header" />
      <ConfigToggle config={config} id="showRibbon" nameKey="setting.appearance.option-show-ribbon" />
      {showRibbon !== false && <PageRow name={t("setting.appearance.option-configure-ribbon")} description={describe("setting.appearance.option-configure-ribbon")} page={() => <RibbonPage environment={environment} />} />}
    </Group>
    <Group heading={t("setting.interface.option-advanced")}>
      <SliderRow name={t("setting.appearance.option-zoom-level")} description={describe("setting.appearance.option-zoom-level")} value={zoom} defaultValue={0} min={-2.5} max={3} step={0.5} format={value => `${Math.round(Math.pow(1.2, value) * 100)}%`} onChange={value => config.set("zoomLevel", value)} />
      <ConfigToggle config={config} id="nativeMenus" nameKey="setting.appearance.option-native-menus" />
      <SettingItem name={t("setting.appearance.option-frame-style")} description={t("setting.appearance.option-frame-description")}>
        <RelaunchButton hidden={!frameChanged} />
        <Dropdown value={frame} options={[{ value: "hidden", label: t("setting.appearance.option-frame-hidden") }, { value: "custom", label: t("setting.appearance.option-frame-obsidian") }, { value: "native", label: t("setting.appearance.option-frame-native") }]} onChange={value => { setFrame(value); appOptions.set("frame", value === "hidden" ? null : value); setFrameChanged(true); }} />
      </SettingItem>
      <ConfigToggle config={config} id="settingsPopoutWindow" nameKey="setting.appearance.option-open-settings-in-window" />
    </Group>
  </>;
}

// ---------------------------------------------------------------- Editor

interface SpellSession { availableSpellCheckerLanguages: string[]; listWordsInSpellCheckerDictionary(): Promise<string[]>; removeWordFromSpellCheckerDictionary(word: string): boolean }
const remoteElectron = () => getRemote() as { app: { getLocale(): string }; getCurrentWebContents(): { session: SpellSession } };
/** Language names in the reference's form: "Language (Region)(extra)", with numeric regions left as codes. */
const languageName = (code: string) => {
  try {
    const [language, region, ...rest] = code.split("-");
    const name = language === "sh" ? "Serbo-Croatian" : new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
    if (!region) return name;
    const regionName = /^[A-Za-z]{2}$/.test(region) ? new Intl.DisplayNames(["en"], { type: "region" }).of(region.toUpperCase()) ?? region : region;
    return `${name} (${regionName})${rest.map(part => `(${part})`).join("")}`;
  } catch { return code; }
};
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** "Spellcheck dictionary": the words added to the custom dictionary, each removable. */
function openDictionaryModal(environment: SettingsEnvironment): void {
  const modal = new Modal(environment.host.app);
  modal.setTitle(t("setting.editor.spellcheck-dict"));
  const render = async () => {
    const session = remoteElectron().getCurrentWebContents().session;
    const words = (await session.listWordsInSpellCheckerDictionary()).sort(collator.compare);
    modal.contentEl.replaceChildren();
    const container = modal.contentEl.createDiv("spellchecker-dictionary-container");
    for (const word of words) {
      const item = container.createDiv("spellchecker-dictionary-item"), remove = item.createDiv("spellchecker-dictionary-remove-button");
      environment.host.app.setIcon(remove, "lucide-x");
      remove.addEventListener("click", () => { session.removeWordFromSpellCheckerDictionary(word); void render(); });
      item.createDiv({ cls: "spellchecker-dictionary-word", text: word });
    }
    if (!words.length) modal.contentEl.createEl("p", { text: t("setting.editor.spellcheck-dict-empty") });
  };
  void render().catch(error => console.error(error));
  modal.open();
}

function SpellcheckLanguagesRow() {
  const t = useT();
  const rerender = useRerender();
  if (process.platform === "darwin") return <SettingItem name={t("setting.editor.spellcheck-languages")} description={t("setting.editor.spellcheck-languages-mac-description")} />;
  let available: string[] = [], locale = "en-US";
  try { const remote = remoteElectron(); available = remote.getCurrentWebContents().session.availableSpellCheckerLanguages; locale = remote.app.getLocale(); } catch (error) { console.error(error); }
  const chosen = getSpellcheckLanguages();
  const list = useRef<HTMLDivElement>(null);
  // The reference fixes this dropdown's width; it only ever shows "+".
  useLayoutEffect(() => { const select = list.current?.parentElement?.querySelector<HTMLSelectElement>("select.dropdown:not(.is-measuring)"); if (select) select.style.width = "80px"; });
  const set = (next: string[] | null) => { setSpellcheckLanguages(next); rerender(); };
  const shown = chosen?.map(language => ({ language, display: languageName(language) })).sort((a, b) => collator.compare(a.display, b.display));
  const options = available.map(language => ({ value: language, label: languageName(language) })).sort((a, b) => collator.compare(a.label, b.label));
  return <SettingItem name={t("setting.editor.spellcheck-languages")} description={describe("setting.editor.spellcheck-languages")}>
    <div className="setting-command-hotkeys" ref={list}>
      {shown ? shown.map(item => <span key={item.language} className="setting-hotkey">{item.display}<IconEl tag="span" className="setting-hotkey-icon" icon="lucide-x" onClick={() => set(chosen!.filter(language => language !== item.language))} /></span>)
        : <span className="setting-hotkey">{languageName(locale)}</span>}
    </div>
    {shown && <IconEl tag="span" className="clickable-icon setting-restore-hotkey-button" icon="lucide-rotate-ccw" onClick={() => set(null)} />}
    <Dropdown value="" options={[{ value: "", label: "+" }, ...options]} onChange={value => { if (!value) return; const current = chosen ?? [locale]; if (!current.includes(value)) set([...current, value]); else rerender(); }} />
  </SettingItem>;
}

/** The reference only turns Vim mode on after the user proves they can leave it. */
function vimTest(environment: SettingsEnvironment, onPassed: () => void): void {
  const modal = new Modal(environment.host.app);
  modal.setTitle(t("setting.editor.label-confirm-enable-vim"));
  modal.contentEl.createEl("p", { cls: "mod-warning", text: t("setting.editor.label-vim-warning") });
  modal.contentEl.createEl("p", { text: t("setting.editor.label-vim-test") });
  const field = modal.contentEl.createEl("p", { cls: "form-field" });
  field.createEl("label", { cls: "input-label", text: t("setting.editor.label-vim-your-answer") });
  const input = field.createEl("input", { type: "text", attr: { placeholder: t("setting.editor.placeholder-enter-command") } });
  const check = () => {
    const answer = input.value.toLowerCase();
    if (answer === "") new Notice(t("setting.editor.msg-vim-mode-please-enter-command"));
    else if (answer.startsWith(":q")) { onPassed(); modal.close(); new Notice(t("setting.editor.msg-vim-mode-enabled")); }
    else new Notice(t("setting.editor.msg-vim-mode-not-enabled"));
  };
  input.addEventListener("keydown", event => { if (!event.isComposing && event.key === "Enter") check(); });
  const buttons = modal.modalEl.createDiv("modal-button-container");
  buttons.createEl("button", { cls: "mod-cta", text: t("setting.editor.button-confirm-enable-vim") }).addEventListener("click", check);
  buttons.createEl("button", { cls: "mod-cancel", text: t("dialogue.button-cancel") }).addEventListener("click", () => modal.close());
  modal.open();
  input.focus();
}
let passedVimTest = false;

export function EditorTab({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const { config, corePlugins, host } = environment;
  useAnyConfig(config);
  const [statusPlugin, setStatusPlugin] = useState(corePlugins.isEnabled("editor-status"));
  const [mermaid, setMermaid] = useState(() => host.app.loadLocalStorage("mermaid-vault-trust") === true);
  return <>
    <Group>
      <ConfigDropdown config={config} id="defaultViewMode" nameKey="setting.editor.option-default-new-tab-view" options={[{ value: "source", labelKey: "setting.editor.option-default-new-tab-view-editing" }, { value: "preview", labelKey: "setting.editor.option-default-new-tab-view-reading" }]} />
      <SettingItem name={t("setting.editor.option-default-editing-mode")} description={describe("setting.editor.option-default-editing-mode")} aliases={["live-preview", "source"]}>
        <Dropdown value={config.get("livePreview") ? "live-preview" : "source"} options={[{ value: "live-preview", label: t("setting.editor.option-default-editing-mode-live-preview") }, { value: "source", label: t("setting.editor.option-default-editing-mode-source") }]} onChange={value => config.set("livePreview", value === "live-preview")} />
      </SettingItem>
      <ToggleRow name={t("plugins.editor-status.name")} description={t("plugins.editor-status.desc")} value={statusPlugin} onChange={value => { setStatusPlugin(value); void corePlugins.setEnabled("editor-status", value); }} />
    </Group>
    <Group heading={t("setting.editor.section-display")}>
      <ConfigToggle config={config} id="showInlineTitle" nameKey="setting.editor.option-show-inline-title" />
      <ToggleRow name={t("setting.editor.option-readable-line-length")} description={t("setting.editor.option-readable-line-description")} value={config.get("readableLineLength")} onChange={value => config.set("readableLineLength", value)} />
      <ConfigToggle config={config} id="strictLineBreaks" nameKey="setting.editor.option-strict-line-break" />
      <ConfigDropdown config={config} id="propertiesInDocument" nameKey="setting.editor.option-properties-in-document" options={[{ value: "visible", labelKey: "setting.editor.option-properties-visible" }, { value: "hidden", labelKey: "setting.editor.option-properties-hidden" }, { value: "source", labelKey: "setting.editor.option-properties-source" }]} />
      <ConfigToggle config={config} id="foldHeading" nameKey="setting.editor.option-fold-heading" />
      <ConfigToggle config={config} id="foldIndent" nameKey="setting.editor.option-fold-indent" />
      <ConfigToggle config={config} id="showLineNumber" nameKey="setting.editor.option-show-line-number" />
      <ConfigToggle config={config} id="showIndentGuide" nameKey="setting.editor.option-indentation-guide" />
      <ConfigToggle config={config} id="rightToLeft" nameKey="setting.editor.option-rtl" />
      <ToggleRow name={t("setting.editor.option-mermaid-allow")} description={describe("setting.editor.option-mermaid-allow")} value={mermaid} onChange={value => { setMermaid(value); host.app.saveLocalStorage("mermaid-vault-trust", value || null); host.app.workspace.trigger("post-processor-change"); }} />
    </Group>
    <Group heading={t("setting.editor.section-behavior")}>
      <SettingItem className="mod-toggle" name={t("setting.editor.option-spellcheck")} description={describe("setting.editor.option-spellcheck")}>
        <ExtraButton icon="lucide-settings" onClick={() => openDictionaryModal(environment)} />
        <ToggleControl value={config.get("spellcheck")} onChange={value => config.set("spellcheck", value)} />
      </SettingItem>
      <SpellcheckLanguagesRow />
      <ConfigToggle config={config} id="autoPairBrackets" nameKey="setting.editor.option-auto-pair-brackets" />
      <ConfigToggle config={config} id="autoPairMarkdown" nameKey="setting.editor.option-auto-pair-markdown" />
      <ConfigToggle config={config} id="smartIndentList" nameKey="setting.editor.option-smart-indent-lists" />
      <ConfigToggle config={config} id="useTab" nameKey="setting.editor.option-use-tabs" />
      <SliderRow name={t("setting.editor.option-tab-size")} description={describe("setting.editor.option-tab-size")} value={config.get("tabSize")} defaultValue={DEFAULT_APP_CONFIG.tabSize} min={2} max={8} step={1} onChange={value => config.set("tabSize", value)} />
    </Group>
    <Group heading={t("setting.about.option-advanced")}>
      <ConfigToggle config={config} id="autoConvertHtml" nameKey="setting.editor.option-auto-convert-html" />
      <ToggleRow name={t("setting.editor.option-vim-key-bindings")} description={describe("setting.editor.option-vim-key-bindings")} value={config.get("vimMode")}
        onChange={value => { if (!value || passedVimTest) config.set("vimMode", value); else vimTest(environment, () => { passedVimTest = true; config.set("vimMode", true); }); }} />
    </Group>
  </>;
}

// ---------------------------------------------------------------- Files and links

/** The reference's file picker button: shows the chosen file with its folders dimmed, opens a searchable list. */
export function FileCombobox({ environment, value, onChange, filter, placeholder }: { environment: SettingsEnvironment; value: string; onChange(path: string): void; filter?: (file: { path: string; extension: string }) => boolean; placeholder?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const callback = useRef(onChange); callback.current = onChange;
  const box = useRef<Combobox | null>(null);
  const { vault } = environment.host;
  const withoutExtension = (file: string) => file.replace(/\.md$/i, "");
  const renderLabel = (combobox: Combobox) => {
    const label = combobox.labelEl, display = combobox.selected?.display;
    label.replaceChildren();
    if (!display) return;
    const parts = display.split("/"), name = parts.pop() ?? "";
    parts.forEach((part, index) => { label.createSpan({ cls: index === 0 ? "file-combobox-dir mod-first" : "file-combobox-dir", text: part }); label.createSpan({ cls: "file-combobox-sep", text: "/" }); });
    label.createSpan({ cls: "file-combobox-name", text: name });
  };
  useEffect(() => {
    const host = hostRef.current; if (!host) return;
    const combobox = box.current = new Combobox(host);
    combobox.buttonEl.classList.add("mod-file");
    combobox.setClearable(true).setPlaceholder(placeholder ?? t("setting.no-file-placeholder"));
    combobox.setItems(() => vault.getFiles().filter(file => !filter || filter(file)).map(file => ({ value: file.path, display: withoutExtension(file.path) })));
    combobox.onSelect(item => { renderLabel(combobox); callback.current(item?.value ?? ""); });
    return () => { combobox.close(); host.replaceChildren(); box.current = null; };
  }, []);
  useEffect(() => {
    const combobox = box.current; if (!combobox) return;
    combobox.setValue(value ? { value, display: withoutExtension(value), ...(vault.getFileByPath(value) ? {} : { icon: "lucide-file-question" }) } : null);
    combobox.setClearable(true);
    renderLabel(combobox);
  }, [value]);
  return <span ref={hostRef} style={{ display: "contents" }} />;
}

/** A Markdown file chosen with the reference's file picker button; a value stored without its extension is still shown. */
export function TemplateFile({ environment, value, onChange, placeholder }: { environment: SettingsEnvironment; value: string; onChange(value: string): void; placeholder?: string }) {
  const stored = value && !/\.md$/i.test(value) && environment.host.vault.getFileByPath(`${value}.md`) ? `${value}.md` : value;
  return <FileCombobox environment={environment} value={stored} onChange={onChange} filter={file => file.extension === "md"} placeholder={placeholder} />;
}

function ExcludedFilesPage({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const { config, host } = environment;
  const filters = useConfig(config, "userIgnoreFilters") ?? [];
  const save = (next: string[]) => config.set("userIgnoreFilters", next.length ? next : null);
  const add = async () => {
    const value = await requestText(host.app, t("setting.file.title-add-excluded-filter"), "", { placeholder: t("setting.file.help-excluded-filter"), cta: t("interface.button-add") });
    if (value === null) return;
    if (!value.trim()) { new Notice(t("setting.file.message-empty-filter")); return; }
    save([...filters, value.trim()]);
  };
  return <Group list noIcon headingControls={<ExtraButton icon="lucide-plus" label={t("setting.file.label-add-excluded-filter")} onClick={() => void add()} />}>
    {filters.map((filter, index) => <SettingItem key={`${filter}:${index}`} icon="" searchable={false} name={filter}>
      <DeleteButton onClick={() => save(filters.filter((_item, position) => position !== index))} />
    </SettingItem>)}
    {!filters.length && <EmptyState>{t("setting.file.label-no-excluded-filters")}</EmptyState>}
  </Group>;
}

function ConfigFolderRow({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const { app } = environment.host;
  const key = `${app.appId}-config`;
  const initial = useMemo(() => localStorage.getItem(key) ?? "", []);
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const valid = (name: string) => /^\.[^\\/:*?"<>|]+$/.test(name) && name !== "." && name !== "..";
  return <SettingItem name={t("setting.about.option-config-location")} description={describe("setting.about.option-config-location")}>
    <RelaunchButton hidden={value === initial || invalid} onClick={() => { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); reload(); }} />
    <input type="text" spellCheck={false} placeholder=".obsidian" value={value} aria-label={invalid ? t("setting.about.option-config-location-warning") : undefined} data-tooltip-position="left" data-tooltip-classes="mod-error"
      onChange={event => { const next = event.target.value; setValue(next); setInvalid(!!next && !valid(next)); }} />
  </SettingItem>;
}

export function FilesTab({ environment }: { environment: SettingsEnvironment }) {
  const t = useT();
  const { config, host, corePlugins } = environment;
  useAnyConfig(config);
  const attachment = config.get("attachmentFolderPath");
  const attachmentMode = attachment === "/" ? "root" : attachment === "." || attachment === "./" ? "current" : attachment.startsWith("./") ? "subfolder" : "folder";
  const attachmentDefault = t("setting.file.option-new-attachment-location-default");
  const filters = config.get("userIgnoreFilters") ?? [];
  const openBehavior = config.get("openBehavior");
  return <>
    <Group>
      <SettingItem name={t("setting.file.option-default-open-action")} description={describe("setting.file.option-default-open-action")}>
        <Dropdown value={openBehavior.startsWith("file:") ? "file" : openBehavior}
          options={[{ value: "", label: t("setting.file.option-choice-last-opened") }, { value: "new", label: t("setting.file.option-choice-new-note") }, { value: "file", label: t("setting.file.option-choice-specific-file") },
            ...(corePlugins.isEnabled("daily-notes") ? [{ value: "daily", label: t("setting.file.option-choice-daily-note") }] : [])]}
          onChange={value => config.set("openBehavior", value === "file" ? "file:" : value)} />
      </SettingItem>
      {openBehavior.startsWith("file:") && <SettingItem name={t("setting.file.option-default-open-file-path")} description={describe("setting.file.option-default-open-file-path")}>
        <FileCombobox environment={environment} value={openBehavior.slice(5)} onChange={file => config.set("openBehavior", `file:${file}`)} />
      </SettingItem>}
      <ToggleRow name={t("setting.editor.option-open-tab-in-foreground")} description={describe("setting.editor.option-open-tab-in-foreground")} value={config.get("focusNewTab")} onChange={value => config.set("focusNewTab", value)} />
      <ConfigDropdown config={config} id="newFileLocation" nameKey="setting.file.option-new-note-location" options={[{ value: "root", labelKey: "setting.file.option-choice-vault-root" }, { value: "current", labelKey: "setting.file.option-choice-current-folder" }, { value: "folder", labelKey: "setting.file.option-choice-specified-folder" }]} />
      {config.get("newFileLocation") === "folder" && <SettingItem name={t("setting.file.option-new-file-folder-path")} description={describe("setting.file.option-new-file-folder-path")}>
        <TextInput value={config.get("newFileFolderPath") === "/" ? "" : config.get("newFileFolderPath")} placeholder={t("setting.folder-path-example-placeholder")} onChange={value => config.set("newFileFolderPath", value)} />
      </SettingItem>}
      <SettingItem name={t("setting.file.option-new-attachment-location")} description={describe("setting.file.option-new-attachment-location")}>
        <Dropdown value={attachmentMode} options={[{ value: "root", label: t("setting.file.option-choice-vault-root") }, { value: "current", label: t("setting.file.option-choice-current-folder") }, { value: "subfolder", label: t("setting.file.option-choice-subdirectory") }, { value: "folder", label: t("setting.file.option-choice-specified-folder") }]}
          onChange={value => config.set("attachmentFolderPath", value === "root" ? "/" : value === "current" ? "./" : value === "subfolder" ? `./${attachmentDefault}` : attachmentDefault)} />
      </SettingItem>
      {attachmentMode === "folder" && <SettingItem name={t("setting.file.option-attachment-folder-path")} description={describe("setting.file.option-attachment-folder-path")}>
        <TextInput value={attachment !== attachmentDefault ? attachment : ""} placeholder={attachmentDefault} onChange={value => config.set("attachmentFolderPath", value || attachmentDefault)} />
      </SettingItem>}
      {attachmentMode === "subfolder" && <SettingItem name={t("setting.file.option-attachment-subfolder-path")} description={describe("setting.file.option-attachment-subfolder-path")}>
        <TextInput value={attachment.slice(2) !== attachmentDefault ? attachment.slice(2) : ""} placeholder={attachmentDefault} onChange={value => config.set("attachmentFolderPath", `./${value || attachmentDefault}`)} />
      </SettingItem>}
    </Group>
    <Group heading={t("setting.file.option-links")}>
      <ConfigDropdown config={config} id="newLinkFormat" nameKey="setting.file.option-link-autocompleted-format" options={[{ value: "shortest", labelKey: "setting.file.option-choice-shortest-linktext" }, { value: "relative", labelKey: "setting.file.option-choice-relative-path" }, { value: "absolute", labelKey: "setting.file.option-choice-absolute-path" }]} />
      <ConfigToggle config={config} id="alwaysUpdateLinks" nameKey="setting.file.option-always-update-links" />
      <ConfigToggle config={config} id="useMarkdownLinks" invert nameKey="setting.file.option-use-wiki-links" />
      <ConfigToggle config={config} id="showUnsupportedFiles" nameKey="setting.file.option-show-unsupported-files" />
    </Group>
    <Group heading={t("setting.file.option-trash")}>
      <ConfigToggle config={config} id="promptDelete" nameKey="setting.file.option-confirm-file-deletion" />
      <ConfigDropdown config={config} id="deleteUnlinkedAttachments" nameKey="setting.file.option-delete-unlinked-attachments" options={[{ value: "ask", labelKey: "setting.file.option-choice-ask-every-time" }, { value: "always", labelKey: "setting.file.option-choice-always" }, { value: "never", labelKey: "setting.file.option-choice-never" }]} />
      <ConfigDropdown config={config} id="trashOption" nameKey="setting.file.option-delete-destination" options={[{ value: "system", labelKey: "setting.file.option-choice-system-trash" }, { value: "local", labelKey: "setting.file.option-choice-vault-trash" }, { value: "none", labelKey: "setting.file.option-choice-permanent-delete" }]} />
    </Group>
    <Group heading={t("setting.about.option-advanced")}>
      <PageRow name={t("setting.file.option-excluded-files")} description={describe("setting.file.option-excluded-files")} value={filters.length === 0 ? "" : filters.length === 1 ? filters[0] : t("setting.file.label-excluded-files-count", { count: filters.length })} page={() => <ExcludedFilesPage environment={environment} />} />
      <ConfigFolderRow environment={environment} />
      <SettingItem className="mod-toggle" name={t("setting.file.option-uri-callbacks")} description={<>{t("setting.file.option-uri-callbacks-desc")} <LearnMore page="uri" rel={false} /></>}>
        <ToggleControl value={config.get("uriCallbacks")} onChange={value => config.set("uriCallbacks", value)} />
      </SettingItem>
      <SettingItem name={t("setting.editor.option-reindex-vault")} description={<><span className="mod-warning">{t("setting.editor.option-reindex-vault-description")}</span><br /><LearnMore page="data-storage" rel={false} /></>}>
        <button onClick={() => void host.vault.refresh().then(reload)}>{t("setting.editor.label-reindex")}</button>
      </SettingItem>
    </Group>
  </>;
}
