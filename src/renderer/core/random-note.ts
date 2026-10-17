import { Keymap } from "../../compat/commands";
import { t } from "../../i18n";
import type { CorePluginContext, CorePluginModule } from "./types";

/** Opens any Markdown note of the vault (the current one included) in the leaf the last event asks for. */
async function openRandomNote({ app }: CorePluginContext): Promise<void> {
  const files = app.vault.getMarkdownFiles();
  if (!files.length) return;
  const file = files[Math.floor(Math.random() * files.length)];
  const leaf = app.workspace.getLeaf(Keymap.isModEvent(app.lastEvent as MouseEvent | KeyboardEvent | null));
  await leaf.openFile(file);
}

export const randomNotePlugin: CorePluginModule = {
  id: "random-note",
  commands: context => [{ id: "random-note", run: () => openRandomNote(context) }],
  ribbon: context => [{ id: "random-note", icon: "dice", title: t("plugins.random-note.action-open"), onClick: () => context.actions.run(() => openRandomNote(context)) }],
};
