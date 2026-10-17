import { MarkdownPreviewRenderer, registerFileEmbedRenderer } from "../../compat/markdown";
import { basesCommands, createBasesCodeBlockProcessor, renderBaseEmbed } from "../BasesFileView";
import type { CorePluginModule } from "./types";

export const basesModule: CorePluginModule = {
  id: "bases",
  commands: ({ app }) => Object.entries(basesCommands(app)).map(([id, handler]) => ({ id, ...handler })),
  install({ app }) {
    const processor = createBasesCodeBlockProcessor(app);
    MarkdownPreviewRenderer.registerPostProcessor(processor);
    const removeEmbed = registerFileEmbedRenderer(app, "base", (file, el, options) => renderBaseEmbed(app, file, el, options));
    app.workspace.trigger("post-processor-change");
    return () => { MarkdownPreviewRenderer.unregisterPostProcessor(processor); removeEmbed(); app.workspace.trigger("post-processor-change"); };
  },
};
