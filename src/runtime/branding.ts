import { ipcMain, app, fs, path, readAsset, assetDirectory } from "../../platforms/platform";
import { initI18n, setLanguage } from "../i18n";

function readBrand(): string {
  const editable = path.join(app.getAppPath(), "brand.txt");
  return fs.readFileSync(fs.existsSync(editable) ? editable : path.join(assetDirectory, "brand.txt"), "utf8");
}

export function installBranding(): void {
  ipcMain.on("obsen-brand", event => { event.returnValue = readBrand(); });
}

/**
 * Localizes main-process copy (dialog titles, error messages). The renderer owns the
 * language choice and reports it here; it is remembered for the next launch.
 */
export function installMainI18n(): void {
  const stateFile = path.join(app.getPath("userData"), "language.json");
  let language = "en";
  try { const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { language?: unknown }; if (typeof saved.language === "string" && /^[A-Za-z-]+$/.test(saved.language)) language = saved.language; }
  catch { /* First launch: English. */ }
  initI18n({
    brand: readBrand(), language,
    loadLanguage: async name => { try { return JSON.parse(await readAsset(`locales/${name}.json`)); } catch { return null; } },
  });
  ipcMain.on("language", (_event, next: unknown) => {
    if (typeof next !== "string" || !/^[A-Za-z-]+$/.test(next)) return;
    void setLanguage(next, false);
    try { fs.writeFileSync(stateFile, JSON.stringify({ language: next })); } catch (error) { console.warn("Could not remember the language:", error); }
  });
}
