import { expose } from "comlink";
import { applyFiles, snapshotFiles, onFilesystemChange } from "./web-filesystem";
import { initializeFileAccess, flushFileAccess, mountedHandles, mountFileAccess, refreshFileAccess } from "./file-access";
import { activeWindowId, connectHost, currentContents, events, handlers, eventFor, prepareWorkerFiles } from "./web-main";
import type { BrowserHost, PlatformWorker, WorkerState } from "./worker-contract";

let client: BrowserHost;
let pending: ReturnType<typeof setTimeout> | undefined;
let initialized = false;
let serial: Promise<unknown> = Promise.resolve();
const syncChannels = ["vault", "vault-list", "version", "frame", "obsen-brand", "obsen-server-url", "adblock-lists", "adblock-frequency"];
function state(): WorkerState {
  const values: Record<string, unknown> = {};
  for (const channel of syncChannels) {
    const event = { sender: currentContents(), returnValue: undefined as unknown };
    for (const listener of events.get(channel) ?? []) listener(event);
    values[channel] = event.returnValue;
  }
  return { values, files: snapshotFiles(), windowId: activeWindowId, mounts: mountedHandles() };
}
async function persist(): Promise<WorkerState> { await flushFileAccess(); return state(); }
function scheduleUpdate() {
  if (!initialized) return;
  clearTimeout(pending);
  pending = setTimeout(() => {
    serial = serial.then(async () => { const next = await persist(); await client.update(next); }).catch(error => client.emit("platform:error", [String(error)]));
  }, 25);
}
const api: PlatformWorker = {
  async initialize(host, assets) {
    if (initialized) throw new Error("Worker already initialized");
    client = host;
    connectHost(host, scheduleUpdate);
    await initializeFileAccess();
    prepareWorkerFiles(assets);
    onFilesystemChange(scheduleUpdate);
    const { ready } = await import("../src/main.ts?platform-worker");
    await ready;
    initialized = true;
    return persist();
  },
  async mount(handle, requestedPath) {
    // A picker can run while a main handler awaits the host. Mounting must be
    // available independently of the handler queue to avoid a nested RPC wait.
    const path = await mountFileAccess(handle, requestedPath);
    return { path, state: state() };
  },
  async synchronize(changes) { applyFiles(changes); return persist(); },
  async refresh() {
    const operation = serial.then(async () => { await refreshFileAccess(); return state(); });
    serial = operation.catch(() => undefined);
    return operation;
  },
  dispatch(id, kind, channel, args, changes) {
    const operation = serial.then(async () => {
      applyFiles(changes);
      let result: unknown;
      if (kind !== "flush") {
        const event = eventFor(id);
        if (kind === "invoke") {
          const handler = handlers.get(channel);
          if (!handler) throw new Error(`No worker handler registered for ${channel}`);
          result = await handler(event, ...args);
        } else {
          for (const listener of events.get(channel) ?? []) await listener(event, ...args);
          result = event.returnValue;
        }
      }
      return { result, state: await persist() };
    });
    serial = operation.catch(() => undefined);
    return operation;
  },
};
expose(api);
