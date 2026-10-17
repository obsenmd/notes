import { createRoot } from "react-dom/client";
import { MarkdownPreviewRenderer, MarkdownRenderChild } from "../../compat/markdown";
import { setIcon } from "../../compat/utilities";
import { EmbeddedQueryResults } from "../SidebarPanes";
import type { CorePluginModule } from "./types";

export const searchModule: CorePluginModule = {
  id: "global-search",
  install({ app, actions }) {
    const processor = MarkdownPreviewRenderer.createCodeBlockPostProcessor("query", (source, pre, context) => {
      const doc = pre.ownerDocument, container = doc.createElement("div");
      container.className = "internal-query";
      const header = doc.createElement("div"); header.className = "internal-query-header";
      const icon = doc.createElement("span"); icon.className = "internal-query-header-icon"; setIcon(icon, "lucide-search");
      const title = doc.createElement("span"); title.className = "internal-query-header-title"; title.textContent = source.trim();
      header.append(icon, title);
      const results = doc.createElement("div"); results.className = "search-result-container node-insert-event"; results.style.position = "relative";
      container.append(header, results); pre.replaceWith(container);
      const root = createRoot(results);
      const child = new MarkdownRenderChild(container);
      child.register(() => queueMicrotask(() => root.unmount()));
      context.addChild(child);
      root.render(<EmbeddedQueryResults actions={actions} query={source.trim()} sourcePath={context.sourcePath} />);
    });
    MarkdownPreviewRenderer.registerPostProcessor(processor);
    app.workspace.trigger("post-processor-change");
    return () => { MarkdownPreviewRenderer.unregisterPostProcessor(processor); app.workspace.trigger("post-processor-change"); };
  },
};
