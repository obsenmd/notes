import type { Electron } from "./generated/electron";

export type { Electron } from "./generated/electron";
export interface BrowserMenuItem {
  label?: string;
  role?: string;
  type?: string;
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  action?: number;
  submenu?: BrowserMenuItem[];
}
/** Services supplied by the browser application to a worker's Electron shim. */
export interface PositronHost {
  emit(channel: string, args: unknown[]): void;
  openDialog(options: Electron.OpenDialogOptions): Promise<Pick<Electron.OpenDialogReturnValue, "canceled" | "filePaths">>;
  saveDialog(options: Electron.SaveDialogOptions): Promise<Pick<Electron.SaveDialogReturnValue, "canceled"> & Partial<Pick<Electron.SaveDialogReturnValue, "filePath">>>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  capturePage(rect?: Electron.Rectangle): Promise<Uint8Array>;
  printToPDF(): Promise<Uint8Array>;
  executeJavaScript(code: string): Promise<unknown>;
  popupMenu(items: BrowserMenuItem[], activate: (action: number) => void): Promise<void>;
  windowControl(action: string, value?: boolean): Promise<void>;
}
export interface PositronTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  send(channel: string, ...args: unknown[]): void;
  sendSync(channel: string, ...args: unknown[]): unknown;
}
export interface PositronFiles {
  isDirectory(filename: string): boolean;
  resourcePath(filename: string): string;
  basename(filename: string): string;
  trashItem(filename: string): Promise<void>;
  pathForFile?(file: File): string;
}
export interface PositronRendererOptions {
  transport: PositronTransport;
  files: PositronFiles;
  dialogs: Pick<PositronHost, "openDialog" | "saveDialog">;
  revealPath(filename: string): void;
  popupMenu: PositronHost["popupMenu"];
  app: { name: string; version: string; paths: Record<string, string> };
}
export interface PositronMainOptions {
  version: string;
  appPath: string;
  paths: Record<string, string>;
}
