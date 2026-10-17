import { path, ipcRenderer, process } from "../../platforms/platform";
import { useEffect, useState, type FormEvent } from "react";


import { Menu } from "../compat/ui";
import { brandName, getLanguage, setLanguage } from "../i18n";
import { useT } from "../i18n/react";
import languages from "../../assets/obsidian/locales/languages.json";
import { Login } from "./Login";
import { Titlebar } from "./WorkspaceShell";
import { Dropdown, IconEl, SettingItem } from "./ui";
import { logoSvg } from "./logo";
import { FRAME_CLASSES } from "./WorkspaceShell";

const LOGO = logoSvg(90);

interface VaultEntry { id: string; name: string; path: string; lastOpenedAt: number; available?: boolean }
interface Registry { vaults: VaultEntry[]; lastVaultId?: string }
type Screen = "open" | "create" | "login";

/** Vault chooser shown when no vault is open. */
export function Starter({ version }: { version: string }) {
  const t = useT();
  const [registry, setRegistry] = useState<Registry>({ vaults: [] });
  const [screen, setScreen] = useState<Screen>("open");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [language, setCurrentLanguage] = useState(getLanguage());
  const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args).catch((error: Error) => {
    // Electron prefixes handler errors with the channel; only the message itself is copy.
    setMessage((error.message || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || t("interface.start-screen.msg-error-failed-to-open-vault")); return null;
  });
  const applyRegistry = (result: unknown) => { if (result) setRegistry(result as Registry); };
  useEffect(() => {
    document.body.classList.add("starter", "theme-dark", ...FRAME_CLASSES, process.platform === "darwin" ? "mod-macos" : process.platform === "win32" ? "mod-windows" : "mod-linux");
    void invoke("vault:list").then(applyRegistry);
    return () => document.body.classList.remove("starter");
  }, []);
  const show = (next: Screen) => { setScreen(next); setMessage(""); };

  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setMessage(t("interface.start-screen.msg-empty-vault-name")); return; }
    if (name.trim().endsWith(".")) { setMessage(t("interface.start-screen.msg-trailing-dot-vault-name")); return; }
    if (!location) { setMessage(t("interface.start-screen.msg-invalid-folder")); return; }
    void invoke("vault:create", name.trim(), location);
  };
  const rename = (vault: VaultEntry, next: string) => {
    setRenaming(null);
    if (!next.trim() || next.trim() === vault.name) return;
    void invoke("vault:rename", vault.id, next.trim()).then(applyRegistry);
  };
  const openMenu = (event: React.MouseEvent, vault: VaultEntry) => {
    event.stopPropagation(); event.preventDefault();
    const menu = new Menu();
    menu.addItem(item => item.setTitle(t(process.platform === "darwin" ? "interface.start-screen.option-reveal-vault-in-explorer-mac" : "interface.start-screen.option-reveal-vault-in-explorer")).setIcon("lucide-folder-open").onClick(() => void invoke("vault:reveal", vault.id)));
    menu.addItem(item => item.setTitle(t("interface.start-screen.option-rename-vault")).setIcon("lucide-edit-3").onClick(() => setRenaming(vault.id)));
    menu.addItem(item => item.setTitle(t("interface.start-screen.option-move-vault")).setIcon("lucide-folder-tree").onClick(() => void invoke("vault:move", vault.id).then(applyRegistry)));
    menu.addItem(item => item.setTitle(t("interface.start-screen.option-copy-vault-i-d")).setIcon("lucide-copy").onClick(() => void navigator.clipboard.writeText(vault.id)));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(t("interface.start-screen.option-remove")).setIcon("lucide-x").onClick(() => void invoke("vault:remove-from-list", vault.id).then(applyRegistry)));
    menu.showAtMouseEvent(event.nativeEvent);
  };
  const changeLanguage = (next: string) => {
    setCurrentLanguage(next);
    void setLanguage(next).then(() => { document.documentElement.lang = next; window.dispatchEvent(new Event("language-changed")); });
  };

  return <>
    <Titlebar title={brandName()} maximizable={false} />
    <div className="starter-screen">
      <div className="starter-screen-inner">
        <div className="recent-vaults">
          <div className="recent-vaults-list">
            {registry.vaults.map(vault => <div className="recent-vaults-list-item" key={vault.id} aria-label={vault.path} data-tooltip-position="right"
              onClick={() => { if (renaming !== vault.id) void invoke(vault.available === false ? "vault:locate" : "vault:open", vault.id); }} onContextMenu={event => openMenu(event, vault)}>
              {renaming === vault.id
                ? <div className="recent-vaults-list-item-name" contentEditable suppressContentEditableWarning spellCheck={false} ref={el => { if (el && document.activeElement !== el) { el.focus(); document.getSelection()?.selectAllChildren(el); } }}
                    onClick={event => event.stopPropagation()} onBlur={event => rename(vault, event.currentTarget.textContent ?? "")}
                    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") { event.currentTarget.textContent = vault.name; event.currentTarget.blur(); } }}>{vault.name}</div>
                : <div className="recent-vaults-list-item-name">{vault.name}</div>}
              <div className="recent-vaults-list-item-path">{path.dirname(vault.path)}</div>
              <IconEl className="recent-vaults-list-item-option-button" icon="lucide-more-vertical" aria-label={t("interface.menu.more-options")} onClick={event => openMenu(event, vault)} />
            </div>)}
          </div>
        </div>
        <div className="splash">
          <div className="splash-brand">
            <div className="splash-brand-logo" dangerouslySetInnerHTML={{ __html: LOGO }} />
            <div className="splash-brand-logo-text">{brandName()}</div>
            <div className="splash-brand-version">{t("interface.start-screen.label-version")} {version}</div>
          </div>
          <div className="open-vault-options-container">
            {screen === "open" && <div className="open-vault-options mod-open-vault">
              <div className="setting-group"><div className="setting-items">
                <SettingItem name={t("interface.start-screen.option-create-vault")} description={t("interface.start-screen.option-create-vault-description")}>
                  <button className="mod-cta" onClick={() => show("create")}>{t("interface.start-screen.button-create-vault")}</button>
                </SettingItem>
                <SettingItem name={t("interface.start-screen.option-open-folder-as-vault")} description={t("interface.start-screen.option-open-folder-as-vault-description")}>
                  <button onClick={() => void invoke("vault:choose")}>{t("interface.start-screen.button-open")}</button>
                </SettingItem>
                <SettingItem name={t("interface.start-screen.option-connect-obsidian-sync")} description={t("interface.start-screen.option-connect-obsidian-sync-description")}>
                  <button onClick={() => show("login")}>{t("interface.start-screen.button-sign-in")}</button>
                </SettingItem>
                <div className="setting-item mod-change-language">
                  <div className="setting-item-info">
                    <div className="setting-item-name" aria-label={t("interface.start-screen.option-get-help")} onClick={() => window.open("https://help.obsidian.md/")}><IconEl tag="span" icon="help" /></div>
                    <div className="setting-item-description" />
                  </div>
                  <div className="setting-item-control">
                    <Dropdown value={language} options={Object.entries(languages as Record<string, string>).map(([value, label]) => ({ value, label }))} onChange={changeLanguage} />
                  </div>
                </div>
              </div></div>
            </div>}
            {screen === "create" && <form className="open-vault-options mod-create-vault" onSubmit={create}>
              <div className="back-button" onClick={() => show("open")}><IconEl tag="span" icon="lucide-arrow-left" />{t("interface.start-screen.button-back")}</div>
              <div className="setting-group">
                <div className="setting-item setting-item-heading"><div className="setting-item-name">{t("interface.start-screen.label-create-local-vault")}</div></div>
                <div className="setting-items">
                  <SettingItem name={t("interface.start-screen.option-new-vault-name")} description={t("interface.start-screen.option-new-vault-name-description")}>
                    <input type="text" spellCheck={false} autoFocus placeholder={t("interface.start-screen.option-new-vault-name")} value={name} onChange={event => setName(event.target.value)} />
                  </SettingItem>
                  <SettingItem name={t("interface.start-screen.option-new-vault-location")}
                    description={location ? <>{t("interface.start-screen.label-new-vault-location-preview")}<span className="u-pop">{path.join(location, name.trim())}</span></> : t("interface.start-screen.option-new-vault-location-description")}>
                    <button type="button" onClick={() => void invoke("vault:pick-folder").then(result => { if (typeof result === "string") { setLocation(result); setMessage(""); } })}>{t("interface.start-screen.button-browse")}</button>
                  </SettingItem>
                </div>
              </div>
              <div className="button-container"><button className="mod-cta" type="submit">{t("interface.start-screen.button-create-vault")}</button></div>
            </form>}
            {screen === "login" && <div className="open-vault-options mod-login">
              <div className="back-button" onClick={() => show("open")}><IconEl tag="span" icon="lucide-arrow-left" />{t("interface.start-screen.button-back")}</div>
              <Login onLogin={() => show("open")} />
            </div>}
            {message && <div className="message mod-error" role="alert">{message}</div>}
          </div>
        </div>
      </div>
    </div>
  </>;
}
