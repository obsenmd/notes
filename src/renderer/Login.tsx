import { ipcRenderer } from "../../platforms/platform";
import { useState, type FormEvent } from "react";

import { AccountClient, type AccountSession } from "../compat/account";
import { useT } from "../i18n/react";
import { SettingItem } from "./ui";

/** Sign-in form: account server, then credentials, then a 2FA code when the account requires one. */
export function Login({ onLogin }: { onLogin(session: AccountSession, server: string): void }) {
  const t = useT();
  const [pane, setPane] = useState<"server" | "credentials" | "2fa">("server");
  const [server, setServer] = useState<string>(() => ipcRenderer.sendSync("obsen-server-url") || "https://api.obsidian.md");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (pane === "credentials" && !email.trim()) { setError(t("setting.account.message-empty-email")); return; }
    if (pane === "credentials" && !password) { setError(t("setting.account.message-empty-password")); return; }
    if (pane === "2fa" && !/^\d{6}$/.test(code)) { setError(t("setting.account.mfa-wrong-format")); return; }
    setBusy(true);
    try {
      if (pane === "server") { setServer(await ipcRenderer.invoke("obsen-select-server", server)); setPane("credentials"); }
      else {
        const session = await new AccountClient({ origin: server, storage: localStorage }).signIn({ email, password, mfa: pane === "2fa" ? code : "" });
        setPassword(""); setCode(""); onLogin(session, server);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (pane === "credentials" && /2fa|mfa|multi.?factor|verification code/i.test(message)) setPane("2fa");
      else setError(pane === "2fa" ? t("setting.account.mfa-verification-failed") : pane === "credentials" ? t("setting.account.message-login-failed") : message);
    } finally { setBusy(false); }
  }
  return <form className="setting-group" style={{ width: "100%" }} onSubmit={event => void submit(event)}>
    <div className="setting-item setting-item-heading"><div className="setting-item-name">{t("setting.account.title-log-in")}</div></div>
    <div className="setting-items">
      {pane === "server" && <SettingItem name={t("obsen.account.server")} description={t("obsen.account.server-desc")}>
        <input type="text" autoFocus spellCheck={false} placeholder="api.obsidian.md" value={server} onChange={event => setServer(event.target.value)} />
      </SettingItem>}
      {pane === "credentials" && <>
        <SettingItem name={t("setting.account.label-email")}><input type="email" autoFocus autoComplete="username" placeholder={t("setting.account.placeholder-email")} value={email} onChange={event => setEmail(event.target.value)} /></SettingItem>
        <SettingItem name={t("setting.account.label-password")}><input type="password" autoComplete="current-password" placeholder={t("setting.account.placeholder-password")} value={password} onChange={event => setPassword(event.target.value)} /></SettingItem>
      </>}
      {pane === "2fa" && <SettingItem name={t("setting.account.label-mfa-code")}>
        <input type="text" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} />
      </SettingItem>}
      {error && <div className="setting-item"><div className="setting-item-info"><div className="setting-item-description mod-warning" role="alert">{error}</div></div></div>}
      <div className="setting-item"><div className="setting-item-control">
        {pane !== "server" && <button type="button" disabled={busy} onClick={() => { setPane(pane === "2fa" ? "credentials" : "server"); setError(""); setCode(""); }}>{t("interface.start-screen.button-back")}</button>}
        <button type="submit" className="mod-cta" disabled={busy}>{pane === "server" ? t("dialogue.button-continue") : t("setting.account.button-login")}</button>
      </div></div>
    </div>
  </form>;
}
