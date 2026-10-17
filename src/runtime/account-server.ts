import { ipcMain, net, BrowserWindow, fs, path } from "../../platforms/platform";
import { t } from "../i18n";


export const DEFAULT_SERVER = "https://api.obsidian.md";
export function normalizeServer(value: string): string {
  const url = new URL(value.includes("://") ? value.trim() : "https://" + value.trim());
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(t("obsen.account.error-invalid-server"));
  }
  return url.href.replace(/\/+$/, "");
}
export function installAccountServer(dataPath: string): void {
  const filename = path.join(dataPath, "account-server.json");
  let selected = DEFAULT_SERVER;
  try { selected = normalizeServer(JSON.parse(fs.readFileSync(filename, "utf8")).url); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Using default account server:", error); }
  ipcMain.on("obsen-server-url", event => { event.returnValue = selected; });
  ipcMain.handle("obsen-select-server", async (_event, value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(t("obsen.account.error-invalid-server"));
    const url = normalizeServer(value);
    if (url !== DEFAULT_SERVER) {
      const response = await net.fetch(url + "/health", { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) throw new Error(t("obsen.account.error-unreachable-server"));
      const text = await response.text();
      try {
        const health = JSON.parse(text);
        if (health.healthy === false || health.ok === false || health.error || ["error", "unhealthy", "down", "fail", "failed"].includes(health.status)) {
          throw new Error(t("obsen.account.error-unreachable-server"));
        }
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    if (selected !== url) {
      const temporary = filename + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({ url }, null, 2));
      fs.renameSync(temporary, filename);
      selected = url;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("obsen-server-changed", url);
    }
    return url;
  });
  ipcMain.handle("obsen-account-request", async (_event, server: string, route: string, body: unknown) => {
    if (server !== selected) throw new Error(t("obsen.account.error-server-changed"));
    if (typeof route !== "string" || !/^\/(user|subscription|vault|publish|site|share|license)\//.test(route)) throw new Error("Invalid account API route.");
    const response = await net.fetch(selected + route, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000), redirect: "error" });
    const result = await response.json() as Record<string, unknown>;
    if (result.requires_mfa || result.mfa_required || result.requires_2fa || ["MFA_REQUIRED", "2FA_REQUIRED"].includes(String(result.code))) return { ...result, error: "2FA code required" };
    if (!response.ok && !result.error) result.error = t("obsen.account.error-request", { status: response.status });
    if (route === "/user/signin" && !result.error && !result.token) result.error = t("obsen.account.error-signin-token");
    return result;
  });
}
