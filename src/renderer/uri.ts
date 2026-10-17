import { path, clipboard, ipcRenderer, process } from "../../platforms/platform";
import type { App } from "../compat/plugin";
import { TFile } from "../compat/vault";
import type { AppActions } from "./actions";

/** An `obsidian://action?…` request, as forwarded by the main process. */
export interface UriRequest { action: string; params: Record<string, string> }

type PaneTarget = false | "tab" | "split" | "window";
const paneTarget = (params: Record<string, string>): PaneTarget => params.paneType === "tab" || params.paneType === "split" || params.paneType === "window" ? params.paneType : false;
const joinContent = (first: string, second: string): string => !first || !second ? first + second : first.replace(/\n+$/, "") + "\n\n" + second.replace(/^\n+/, "");

/** A vault-relative link text from the `file` or (absolute) `path` parameter; null when the path is outside this vault. */
function linkText(actions: AppActions, params: Record<string, string>): string | null {
  if (params.path) {
    const relative = path.relative(actions.vaultPath, params.path);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
  }
  return params.file ?? null;
}

async function openAction(app: App, actions: AppActions, params: Record<string, string>): Promise<void> {
  const target = linkText(actions, params);
  if (target) await app.workspace.openLinkText(target, "", paneTarget(params));
}

async function newAction(app: App, actions: AppActions, params: Record<string, string>): Promise<void> {
  const content = params.clipboard !== undefined && params.content === undefined ? clipboard.readText() : params.content ?? "";
  const target = linkText(actions, params) ?? params.name ?? null;
  const flag = (name: string) => params[name] !== undefined && params[name] !== "false";
  let file: TFile | null = null;
  if (target) {
    const normalized = /\.[A-Za-z0-9]+$/.test(target) ? target : target + ".md";
    // `name` goes to the default location for new notes; `file` and `path` are full vault paths.
    const location = params.name && !params.file && !params.path ? [app.fileManager.getNewFileParent("").path, normalized].filter(part => part && part !== "/").join("/") : normalized;
    const existing = app.vault.getAbstractFileByPath(location);
    if (existing instanceof TFile) {
      file = existing;
      if (flag("overwrite")) await app.vault.modify(existing, content);
      else if (flag("append")) await app.vault.process(existing, text => joinContent(text, content));
      else if (flag("prepend")) await app.vault.process(existing, text => joinContent(content, text));
      else {
        // Without a mode, an existing name gets a numbered sibling, like "New note".
        const dot = location.lastIndexOf("."), base = location.slice(0, dot), extension = location.slice(dot + 1);
        file = await app.vault.create(app.vault.getAvailablePath(base, extension), content);
      }
    } else {
      const folder = location.includes("/") ? location.slice(0, location.lastIndexOf("/")) : "";
      if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
      file = await app.vault.create(location, content);
    }
  } else {
    file = await app.fileManager.createNewMarkdownFile(app.fileManager.getNewFileParent(""), undefined, content);
  }
  if (file && !flag("silent")) await actions.openFile(file, paneTarget(params));
}

/**
 * Handles `obsidian://` requests for this vault window: the built-in actions and the ones plugins
 * register with `registerObsidianProtocolHandler`. Returns a disposer.
 */
export function installUriHandler(app: App, actions: AppActions): () => void {
  const handle = (request: UriRequest) => {
    const { action, params } = request;
    actions.run(async () => {
      const custom = app.obsidianProtocolHandlers.get(action);
      if (custom) { custom({ action, ...params }); return; }
      if (action === "open") await openAction(app, actions, params);
      else if (action === "new") await newAction(app, actions, params);
      else if (action === "search") await actions.openSearch(params.query ?? "");
      else if (action === "choose-vault") actions.openVaultChooser();
      else if (action === "show-plugin") actions.openSettings("community-plugins");
    });
  };
  const listener = (_event: unknown, request: UriRequest) => handle(request);
  ipcRenderer.on("open-url", listener);
  // Requests that arrived before this window was ready.
  void (ipcRenderer.invoke("open-url:ready") as Promise<UriRequest[]>).then(queued => queued.forEach(handle)).catch(() => undefined);
  return () => { ipcRenderer.removeListener("open-url", listener); };
}
