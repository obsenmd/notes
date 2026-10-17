import { readAsset, ipcRenderer } from "../../platforms/platform";
import { trackActiveWindow } from "../compat/ui";



import { createRoot } from "react-dom/client";
import { getStoredLanguage, initI18n } from "../i18n";
import { App } from "./App";
import { installTooltips } from "./tooltip";
import { beginStartupLoading } from "./loading";

beginStartupLoading();

// Locale files ship beside the bundle; English is compiled in as the fallback.
initI18n({
  brand: ipcRenderer.sendSync("obsen-brand") as string,
  language: getStoredLanguage(),
  loadLanguage: async language => {
    if (!/^[A-Za-z-]+$/.test(language)) return null;
    try { return JSON.parse(await readAsset(`locales/${language}.json`)); }
    catch { return null; }
  },
});
document.documentElement.lang = getStoredLanguage();
// Keep main-process copy (dialogs, error messages) in the same language.
ipcRenderer.send("language", getStoredLanguage());
window.addEventListener("language-changed", () => ipcRenderer.send("language", getStoredLanguage()));
installTooltips(document);
trackActiveWindow(window);
createRoot(document.getElementById("root")!).render(<App />);
