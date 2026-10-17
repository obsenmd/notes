import { EventEmitter } from "node:events";
import { BrowserImage, nativeImage } from "./native-image";
import { capturePage, printToPDF } from "./capture";
import { createBrowserWebview, webContents } from "./webview";
import { session as browserSessions } from "./session";
import type { BrowserMenuItem, Electron, PositronRendererOptions } from "./types";

/** Construct a renderer shim; transport, files and application UI are injected. */
export function createPositronRenderer(options: PositronRendererOptions) {
  const ipcRenderer = Object.assign(new EventEmitter(), {
    invoke: options.transport.invoke,
    send: options.transport.send,
    sendSync: options.transport.sendSync,
  }) satisfies Pick<Electron.IpcRenderer, "invoke" | "send" | "sendSync">;
  let clipboardText = "", clipboardHTML = "";
  let clipboardImage = nativeImage.createEmpty();
  const clipboard = {
    readText: () => clipboardText,
    writeText(text: string) { clipboardText = text; void navigator.clipboard.writeText(text).catch(console.error); },
    readHTML: () => clipboardHTML,
    writeHTML(html: string) { clipboardHTML = html; void navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })]).catch(console.error); },
    readImage: () => clipboardImage,
    writeImage(image: BrowserImage | Blob) {
      const blob = image instanceof Blob ? image : new Blob([new Uint8Array(image.toPNG())], { type: "image/png" });
      if (image instanceof BrowserImage) clipboardImage = image;
      void navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]).catch(console.error);
    },
    clear() { clipboardText = ""; clipboardHTML = ""; clipboardImage = nativeImage.createEmpty(); },
    availableFormats: () => [...(clipboardText ? ["text/plain"] : []), ...(clipboardHTML ? ["text/html"] : []), ...(!clipboardImage.isEmpty() ? ["image/png"] : [])],
  };
  let zoomLevel = 0;
  const webFrame = {
    getZoomLevel: () => zoomLevel,
    setZoomLevel(level: number) { zoomLevel = level; document.documentElement.style.setProperty("zoom", String(Math.pow(1.2, level))); },
    getZoomFactor: () => Math.pow(1.2, zoomLevel),
    setZoomFactor(factor: number) { this.setZoomLevel(Math.log(factor) / Math.log(1.2)); },
  } satisfies Pick<Electron.WebFrame, "getZoomLevel" | "setZoomLevel" | "getZoomFactor" | "setZoomFactor">;
  const shell = {
    async openExternal(url: string) {
      const target = new URL(url);
      if (!["http:", "https:", "mailto:"].includes(target.protocol)) throw new TypeError(`Unsupported external URL: ${target.protocol}`);
      window.open(target.href, "_blank", "noopener,noreferrer");
    },
    showItemInFolder: options.revealPath,
    async openPath(filename: string) {
      if (options.files.isDirectory(filename)) { options.revealPath(filename); return ""; }
      const link = document.createElement("a"); link.href = options.files.resourcePath(filename); link.download = options.files.basename(filename);
      document.body.append(link); link.click(); link.remove(); return "";
    },
    trashItem: options.files.trashItem,
  };
  const webUtils = { getPathForFile: (file: File) => options.files.pathForFile?.(file) ?? "" } satisfies Pick<Electron.WebUtils, "getPathForFile">;
  const session = {
    availableSpellCheckerLanguages: [...navigator.languages],
    setSpellCheckerLanguages(languages: string[]) { if (languages[0]) document.documentElement.lang = languages[0]; },
  };
  const contents = Object.assign(new EventEmitter(), {
    session,
    getZoomLevel: webFrame.getZoomLevel,
    capturePage, printToPDF,
    cut: () => document.execCommand("cut"), copy: () => document.execCommand("copy"), paste: () => document.execCommand("paste"),
  });
  let relaunch = false;
  const remote = {
    webContents,
    session: browserSessions,
    app: {
      getPath: (name: string) => options.app.paths[name] ?? options.app.paths.userData,
      getLocale: () => navigator.language,
      getName: () => options.app.name,
      getVersion: () => options.app.version,
      relaunch() { relaunch = true; },
      quit() { if (relaunch) window.location.reload(); else window.close(); },
    },
    getCurrentWebContents: () => contents,
    clipboard, shell, nativeImage,
    dialog: { showOpenDialog: options.dialogs.openDialog, showSaveDialog: options.dialogs.saveDialog },
    getCurrentWindow: () => window,
    systemPreferences: {
      getMediaAccessStatus: () => "not-determined",
      async askForMediaAccess(kind: "microphone" | "camera") {
        try { const stream = await navigator.mediaDevices.getUserMedia(kind === "camera" ? { video: true } : { audio: true }); stream.getTracks().forEach(track => track.stop()); return true; }
        catch { return false; }
      },
    },
    Menu: {
      buildFromTemplate(template: Electron.MenuItemConstructorOptions[]) {
        return { popup() {
          const actions: Array<() => void> = [];
          const serialize = (items: Electron.MenuItemConstructorOptions[]): BrowserMenuItem[] => items.map(item => ({
            label: item.label, role: item.role, type: item.type, checked: item.checked, enabled: item.enabled, visible: item.visible,
            action: item.click ? actions.push(() => item.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)) - 1 : undefined,
            submenu: Array.isArray(item.submenu) ? serialize(item.submenu) : undefined,
          }));
          void options.popupMenu(serialize(template), action => actions[action]?.());
        } };
      },
    },
  };
  const onPaste = (event: ClipboardEvent) => { clipboardText = event.clipboardData?.getData("text/plain") ?? ""; clipboardHTML = event.clipboardData?.getData("text/html") ?? ""; };
  document.addEventListener("paste", onPaste, true);
  const getElectron = () => ({ ipcRenderer, clipboard, webFrame, webUtils, shell, remote });
  return {
    ipcRenderer, clipboard, webFrame, webUtils, shell, getElectron,
    createWebview: (document: Document) => createBrowserWebview(document, (url, partition) => options.transport.invoke("positron:request-allowed", partition, url)),
    getRemote: () => remote,
    receive(channel: string, ...args: unknown[]) { ipcRenderer.emit(channel, { sender: ipcRenderer, ports: [] }, ...args); },
    dispose() { document.removeEventListener("paste", onPaste, true); ipcRenderer.removeAllListeners(); },
  };
}
