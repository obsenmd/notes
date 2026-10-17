import type { FileChange, FileSnapshot } from "./web-filesystem";
import type { FileMount } from "./file-access";
import type { PositronHost } from "../libs/positron";

export interface WorkerState {
  files: FileSnapshot;
  values: Record<string, unknown>;
  windowId: number;
  mounts: FileMount[];
}
export interface BrowserHost extends PositronHost {
  update(state: WorkerState): void;
}
export interface PlatformWorker {
  initialize(host: BrowserHost, assets: Record<string, string>): Promise<WorkerState>;
  dispatch(windowId: number, kind: "invoke" | "send" | "flush", channel: string, args: unknown[], changes: FileChange[]): Promise<{ result: unknown; state: WorkerState }>;
  mount(handle: FileMount["handle"], path?: string): Promise<{ path: string; state: WorkerState }>;
  refresh(): Promise<WorkerState>;
  synchronize(changes: FileChange[]): Promise<WorkerState>;
}
