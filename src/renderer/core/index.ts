import type { CorePluginModule } from "./types";
import { canvasModule } from "./canvas";
import { graphModule } from "./graph";
import { webviewerModule } from "./webviewer";
import { searchModule } from "./search";
import { audioRecorderPlugin } from "./audio-recorder";
import { basesModule } from "./bases";
import { fileRecoveryPlugin } from "./file-recovery";
import { footnotesPlugin } from "./footnotes";
import { noteComposerPlugin } from "./note-composer";
import { publishPlugin } from "./publish";
import { randomNotePlugin } from "./random-note";
import { slashCommandPlugin } from "./slash-command";
import { slidesPlugin } from "./slides";
import { syncPlugin } from "./sync";
import { uniqueNotePlugin } from "./unique-note";
import { workspacesPlugin } from "./workspaces";
import { monacoEditorModule } from "./monaco-editor";

export type { CorePluginCommand, CorePluginContext, CorePluginModule, CorePluginRibbonAction } from "./types";

/** Core plugins implemented as self-contained modules; the rest are wired directly in the app shell. */
export const CORE_PLUGIN_MODULES: CorePluginModule[] = [basesModule, slidesPlugin, audioRecorderPlugin, workspacesPlugin, uniqueNotePlugin, randomNotePlugin, slashCommandPlugin, footnotesPlugin, fileRecoveryPlugin, syncPlugin, publishPlugin, noteComposerPlugin, canvasModule, graphModule, webviewerModule, searchModule, monacoEditorModule];
