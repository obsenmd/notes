import { app, ipcMain, net, session, readFileSync, writeFileSync, path } from "../../platforms/platform";
import { AdblockLists, DEFAULT_ADBLOCK_LISTS } from "./adblock";

export function installBrowserSessions(): void {
  const filename = path.join(app.getPath("userData"), "webviewer-options.json");
  let options: { adblock?: string[]; adblockFrequency?: number } = {};
  try { const stored = JSON.parse(readFileSync(filename, "utf8")); if (stored && typeof stored === "object") options = stored; } catch { /* First launch. */ }
  const lists = new AdblockLists(path.join(app.getPath("userData"), "adblock"), async url => (await net.fetch(url, { signal: AbortSignal.timeout(30000) })).text());
  const sessions = new Map<string, { adblock: boolean }>();
  let timer: ReturnType<typeof setTimeout> | undefined, refreshing: Promise<void> = Promise.resolve();
  let generation = 0;
  const refresh = () => {
    const currentGeneration = ++generation;
    if (timer) clearTimeout(timer);
    const days = options.adblockFrequency ?? 4;
    refreshing = lists.update(options.adblock ?? DEFAULT_ADBLOCK_LISTS, days);
    void refreshing.then(() => { if (currentGeneration === generation && days !== 0) { timer = setTimeout(refresh, Math.min(days, 24) * 86400000); timer.unref?.(); } }).catch(error => console.error(error));
  };
  const save = () => { try { writeFileSync(filename, JSON.stringify(options)); } catch (error) { console.error(error); } };
  ipcMain.on("adblock-lists", (event, value: unknown) => {
    if (Array.isArray(value) && value.every(url => typeof url === "string")) { options.adblock = value; save(); refresh(); }
    event.returnValue = options.adblock ?? DEFAULT_ADBLOCK_LISTS;
  });
  ipcMain.on("adblock-frequency", (event, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 24) { options.adblockFrequency = value; save(); refresh(); }
    event.returnValue = options.adblockFrequency || 4;
  });
  const configure = (partition: string, enabled?: boolean) => {
    if (typeof partition !== "string" || !partition.startsWith("persist:vault-")) return;
    let state = sessions.get(partition);
    if (!state) {
      state = { adblock: enabled === true }; sessions.set(partition, state);
      const browser = session.fromPartition(partition), current = state;
      browser.setUserAgent(browser.getUserAgent().split(" ").filter(part => !/^(obsen|obsidian|electron)/i.test(part)).join(" "));
      browser.webRequest.onBeforeRequest({ urls: ["https://*/*", "http://*/*"] }, (details, callback) => callback({ cancel: current.adblock && lists.rules.matches(details.url) }));
      if (enabled === true) refresh();
    }
    if (typeof enabled === "boolean") state.adblock = enabled;
  };
  ipcMain.on("create-browser-session", (_event, partition: string, enabled?: boolean) => configure(partition, enabled));
  ipcMain.handle("browser-session:ready", async (_event, partition: string, enabled?: boolean) => { configure(partition, enabled); await refreshing; return sessions.has(partition); });
  app.on("will-quit", () => { if (timer) clearTimeout(timer); });
}
