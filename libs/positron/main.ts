import { EventEmitter } from "node:events";
import { proxy } from "comlink";
import { Buffer } from "node:buffer";
import type { BrowserMenuItem, Electron, PositronHost, PositronMainOptions } from "./types";
import { session } from "./session";
export { session };

type MainEvent = { sender: VirtualContents; returnValue?: unknown };
type Handler = (event: MainEvent, ...args: any[]) => unknown;
export const handlers = new Map<string, Handler>();
export const events = new Map<string, Handler[]>();
export let host: PositronHost;
export let activeWindowId = 0;
export let notifyChange = () => {};
let configuration: PositronMainOptions = { version: "0.0.0", appPath: "/", paths: {} };
export function configureMain(options: PositronMainOptions): void { configuration = options; }
export function connectHost(value: PositronHost, notify: () => void): void { host = value; notifyChange = notify; }
export const ipcMain = {
  handle(channel: string, handler: Handler) { if (handlers.has(channel)) throw new Error(`Duplicate worker handler: ${channel}`); handlers.set(channel, handler); },
  on(channel: string, handler: Handler) { events.set(channel, [...(events.get(channel) ?? []), handler]); return this; },
};
ipcMain.handle("positron:request-allowed", (_event, partition: string, url: string) => session.fromPartition(partition).allows(url));
class VirtualContents extends EventEmitter {
  constructor(readonly id: number) { super(); }
  send(channel: string, ...args: unknown[]) { void host.emit(channel, args); }
  setWindowOpenHandler(_handler: unknown) {}
  isDestroyed() { return !VirtualWindow.windows.has(this.id); }
  focus() {}
  executeJavaScript(code: string): Promise<unknown> { return host.executeJavaScript(code); }
  async capturePage(rect?: Electron.Rectangle) { const bytes = await host.capturePage(rect); return { toPNG: () => Buffer.from(bytes) }; }
  printToPDF(): Promise<Uint8Array> { return host.printToPDF(); }
  cut() { void host.executeJavaScript("document.execCommand('cut')"); }
  copy() { void host.executeJavaScript("document.execCommand('copy')"); }
  paste() { void host.executeJavaScript("document.execCommand('paste')"); }
  redo() { void host.executeJavaScript("document.execCommand('redo')"); }
  pasteAndMatchStyle() { this.paste(); }
  toggleDevTools() { this.send("platform:inspect"); }
}
class VirtualWindow extends EventEmitter {
  static windows = new Map<number, VirtualWindow>();
  static sequence = 0;
  static getAllWindows() { return [...this.windows.values()]; }
  static getFocusedWindow() { return this.windows.get(activeWindowId) ?? null; }
  static fromWebContents(contents: VirtualContents) { return this.windows.get(contents.id) ?? null; }
  readonly id = ++VirtualWindow.sequence;
  readonly webContents = new VirtualContents(this.id);
  private minimized = false;
  private maximized = false;
  private onTop = false;
  constructor(readonly options: Electron.BrowserWindowConstructorOptions = {}) { super(); VirtualWindow.windows.set(this.id, this); }
  async loadFile() { activeWindowId = this.id; notifyChange(); }
  getChildWindows() { return []; }
  getTitle() { return this.options.title ?? ""; }
  close() { this.emit("close"); VirtualWindow.windows.delete(this.id); this.emit("closed"); }
  show() { activeWindowId = this.id; notifyChange(); }
  focus() { activeWindowId = this.id; }
  restore() { this.minimized = false; void host.windowControl("restore"); }
  isMinimized() { return this.minimized; }
  isDestroyed() { return !VirtualWindow.windows.has(this.id); }
  isFullScreen() { return this.maximized; }
  isFocused() { return this.id === activeWindowId; }
  isMaximized() { return this.maximized; }
  minimize() { this.minimized = true; void host.windowControl("minimize"); }
  maximize() { this.maximized = true; void host.windowControl("maximize"); }
  unmaximize() { this.maximized = false; void host.windowControl("restore"); }
  setAlwaysOnTop(value: boolean) { this.onTop = value; void host.windowControl("always-on-top", value); }
  isAlwaysOnTop() { return this.onTop; }
  getNormalBounds() { return { x: 0, y: 0, width: 1280, height: 820 }; }
  setMenu(_menu: unknown) {}
  setMenuBarVisibility(_visible: boolean) {}
}
export const BrowserWindow = VirtualWindow as unknown as typeof Electron.BrowserWindow;
export function currentContents(): VirtualContents {
  const window = VirtualWindow.windows.get(activeWindowId);
  if (!window) throw new Error("No active browser workspace");
  return window.webContents;
}
export function eventFor(id: number): MainEvent {
  const window = VirtualWindow.windows.get(id);
  if (!window) throw new Error(`Unknown browser window: ${id}`);
  return { sender: window.webContents };
}
const lifecycle = new EventEmitter();
export const app = Object.assign(lifecycle, {
  getPath(name: string) { return configuration.paths[name] ?? configuration.paths.userData ?? "/"; },
  getAppPath: () => configuration.appPath,
  getVersion: () => configuration.version,
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  addRecentDocument(_path: string) {},
  quit() { void host.emit("platform:close", []); },
});
export const net = { fetch: (input: string, init?: RequestInit) => fetch(input, init) } satisfies Pick<Electron.Net, "fetch">;
export const dialog = {
  showOpenDialog: (_window: unknown, options: Electron.OpenDialogOptions) => host.openDialog(options),
  showSaveDialog: (_window: unknown, options: Electron.SaveDialogOptions) => host.saveDialog(options),
};
export const shell = {
  openExternal: (url: string) => host.openExternal(url),
  showItemInFolder: (filename: string) => host.revealPath(filename),
};
export const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1280, height: 820 } }] };
class WorkerMenu {
  static buildFromTemplate(template: Electron.MenuItemConstructorOptions[]) { return new WorkerMenu(template); }
  static setApplicationMenu(_menu: WorkerMenu) {}
  constructor(readonly items: Electron.MenuItemConstructorOptions[]) {}
  getMenuItemById(id: string): Electron.MenuItemConstructorOptions | undefined {
    const visit = (items: Electron.MenuItemConstructorOptions[]): Electron.MenuItemConstructorOptions | undefined => {
      for (const item of items) { if (item.id === id) return item; if (Array.isArray(item.submenu)) { const found = visit(item.submenu); if (found) return found; } }
    };
    return visit(this.items);
  }
  popup() {
    const actions: Array<() => void> = [];
    const serialize = (items: Electron.MenuItemConstructorOptions[]): BrowserMenuItem[] => items.map(item => {
      const action = item.click ? actions.push(() => item.click!({} as Electron.MenuItem, BrowserWindow.getFocusedWindow() ?? undefined, { triggeredByAccelerator: false } as Electron.KeyboardEvent)) - 1 : undefined;
      return { label: item.label, role: item.role, type: item.type, checked: item.checked, enabled: item.enabled, visible: item.visible, action, submenu: Array.isArray(item.submenu) ? serialize(item.submenu) : undefined };
    });
    void host.popupMenu(serialize(this.items), proxy((action: number) => actions[action]?.()));
  }
}
export const Menu = WorkerMenu as unknown as typeof Electron.Menu;
export const getRemoteMain = () => ({ initialize() {}, enable(_contents: unknown) {} });

