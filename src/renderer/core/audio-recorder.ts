import { getElectron, process } from "../../../platforms/platform";
import moment from "moment";
import { MarkdownView } from "../../compat/markdown-view";
import type { App } from "../../compat/plugin";
import { Notice } from "../../compat/ui";
import { t } from "../../i18n";
import { displayTooltip } from "../tooltip";
import type { CorePluginModule } from "./types";

type MediaAccess = { getMediaAccessStatus(media: "microphone"): string; askForMediaAccess(media: "microphone"): Promise<boolean> };

const MP4 = "audio/mp4";
/** The reference names recordings in English in every language. */
const FILE_PREFIX = "Recording ";

let recording = false;
let recorder: MediaRecorder | null = null;

const toggleTitle = () => t("plugins.audio-recorder.action-toggle");
/** The plugin's ribbon buttons, in the main window and in pop-outs. */
function ribbonButtons(app: App): HTMLElement[] {
  const docs = new Set<Document>([document]);
  app.workspace.iterateAllLeaves(leaf => { const doc = leaf.view.containerEl?.ownerDocument; if (doc) docs.add(doc); });
  const title = toggleTitle();
  return [...docs].flatMap(doc => [...doc.querySelectorAll<HTMLElement>(".side-dock-ribbon-action")]).filter(el => el.getAttribute("aria-label") === title);
}
const markButtons = (app: App) => { for (const el of ribbonButtons(app)) el.classList.toggle("is-active", recording); };

/** Messages appear as a tooltip on the ribbon button, and not at all while the ribbon is hidden. */
function showMessage(app: App, message: string, error: boolean): void {
  const button = ribbonButtons(app)[0];
  if (button) displayTooltip(button, message, { placement: "right", classes: error ? ["mod-error"] : [] });
}

/** macOS gates the microphone behind a system permission; other platforms always pass. */
async function checkPermission(app: App): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  let access: MediaAccess | undefined;
  try { access = (getElectron() as { remote?: { systemPreferences?: MediaAccess } }).remote?.systemPreferences; } catch { /* reported below */ }
  const status = access?.getMediaAccessStatus("microphone");
  if (!access || !status || ["denied", "restricted", "unknown"].includes(status)) { showMessage(app, t("plugins.audio-recorder.msg-access-denied"), true); return false; }
  if (status === "not-determined") { showMessage(app, t("plugins.audio-recorder.msg-pending-grant"), false); return access.askForMediaAccess("microphone"); }
  return status === "granted";
}

async function saveRecording(app: App, data: ArrayBuffer, extension: string): Promise<void> {
  const { workspace } = app;
  const active = workspace.activeFile ?? null, view = workspace.getActiveViewOfType(MarkdownView);
  const path = await app.fileManager.getAvailablePathForAttachment(`${FILE_PREFIX}${moment().format("YYYYMMDDHHmmss")}.${extension}`, active?.path);
  const file = await app.vault.createBinary(path, data);
  if (view) view.editor.replaceSelection(`\n!${app.fileManager.generateMarkdownLink(file, view.file?.path ?? "").replace(/^!/, "")}\n`);
  else await workspace.getUnpinnedLeaf().openFile(file, { active: true });
}

function record(app: App, stream: MediaStream): void {
  const chunks: Blob[] = [];
  const mp4 = MediaRecorder.isTypeSupported(MP4), mimeType = mp4 ? MP4 : 'audio/webm;codecs="opus"', extension = mp4 ? "m4a" : "webm";
  const instance = recorder = new MediaRecorder(stream, { mimeType });
  instance.addEventListener("dataavailable", event => { if (event.data.size > 0) chunks.push(event.data); });
  instance.addEventListener("stop", () => {
    if (recorder === instance) recorder = null;
    for (const track of stream.getTracks()) track.stop();
    void new Blob(chunks, { type: mimeType }).arrayBuffer().then(data => saveRecording(app, data, extension)).catch(error => { console.error(error); new Notice(t("obsen.audio.error-save")); });
  });
  instance.start();
}

async function start(app: App): Promise<void> {
  if (recording) return;
  try {
    record(app, await navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Requested device not found") && ribbonButtons(app).length) showMessage(app, t("plugins.audio-recorder.msg-no-microphone"), true);
    else { if (message.includes("denied")) new Notice(t("plugins.audio-recorder.msg-access-denied")); console.error(error); }
    return;
  }
  recording = true;
  markButtons(app);
}

function stop(app: App): void {
  recording = false;
  recorder?.stop();
  markButtons(app);
}

export const audioRecorderPlugin: CorePluginModule = {
  id: "audio-recorder",
  commands: ({ app }) => [
    { id: "audio-recorder:start", check: () => !recording, run: () => start(app) },
    { id: "audio-recorder:stop", check: () => recording, run: () => stop(app) },
  ],
  ribbon: ({ app }) => [{
    id: "audio-recorder", icon: "lucide-mic", title: toggleTitle(),
    onClick: () => { void checkPermission(app).then(allowed => { if (allowed) return recording ? stop(app) : start(app); }).catch(console.error); },
  }],
  install({ app }) {
    // The ribbon is rendered by the shell, so the pressed state is re-applied when it redraws.
    const ref = app.workspace.on("layout-change", () => { if (recording) markButtons(app); });
    return () => { app.workspace.offref(ref); if (recording) stop(app); };
  },
};
