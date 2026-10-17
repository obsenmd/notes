import { createRoot, type Root } from "react-dom/client";
import { MarkdownView } from "../compat/markdown-view";
import type { Workspace } from "../compat/workspace";
import type { AppActions } from "./actions";
import { EmbeddedBacklinks } from "./SidebarPanes";

/** Keeps the "backlinks in document" panels of open notes mounted; returns a disposer. */
export function watchEmbeddedBacklinks(workspace: Workspace, actions: AppActions): () => void {
  const roots = new Map<HTMLElement, Root>();
  const sync = () => {
    const live = new Set<HTMLElement>();
    workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      for (const el of view.containerEl.querySelectorAll<HTMLElement>(".embedded-backlinks")) {
        el.style.display = view.showBacklinks ? "" : "none";
        if (!view.showBacklinks) continue;
        live.add(el);
        let root = roots.get(el);
        if (!root) { root = createRoot(el); roots.set(el, root); }
        root.render(<EmbeddedBacklinks actions={actions} file={view.file} />);
      }
    });
    for (const [el, root] of roots) if (!live.has(el)) { root.unmount(); roots.delete(el); }
  };
  const refs = ["layout-change", "file-open", "markdown-backlinks-change"].map(name => workspace.on(name, () => queueMicrotask(sync)));
  sync();
  return () => { refs.forEach(ref => workspace.offref(ref)); for (const root of roots.values()) root.unmount(); roots.clear(); };
}
