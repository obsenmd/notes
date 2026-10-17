import type { Menu } from "../../compat/ui";
import { TFile } from "../../compat/vault";
import { t } from "../../i18n";
import { getPublishService, openPublishModal } from "../PublishModal";
import { PUBLISH_ORIGIN, livePath, openExternal } from "../PublishWorkflow";
import type { CorePluginContext, CorePluginModule } from "./types";

function createController(context: CorePluginContext) {
  const { app, config } = context, service = getPublishService(app, config.configDir);
  const activeFile = () => { const file = app.workspace.getActiveFile(); return file instanceof TFile ? file : null; };
  /** A file the connected site can take: a supported type that is not opted out with `publish: false`. */
  const publishable = (file: TFile | null): file is TFile => Boolean(service.siteId) && file !== null && service.isFileSupported(file) && service.getPublishFlag(file) !== false;
  /** Opens the dialog on the upload of this one file, as the reference does. */
  const uploadFile = (file: TFile) => openPublishModal(context, [{ path: file.path, ctime: 0, mtime: 0, size: 0, type: "new", checked: true }]);
  const openLive = async (file: TFile) => openExternal(`${PUBLISH_ORIGIN}/${await service.getCurrentSlug()}/${livePath(file.path)}`);
  return { service, activeFile, publishable, uploadFile, openLive };
}

export const publishPlugin: CorePluginModule = {
  id: "publish",
  commands: context => {
    const controller = createController(context), { service } = controller;
    return [
      { id: "publish:view-changes", run: () => context.app.workspace.trigger("publish:open") },
      { id: "publish:publish-file", check: () => controller.publishable(controller.activeFile()), run: () => { const file = controller.activeFile(); if (controller.publishable(file)) controller.uploadFile(file); } },
      {
        id: "publish:open-in-live-site",
        // Unavailable without a site, and for files a loaded site listing shows as unpublished.
        check: () => { const file = controller.activeFile(); return controller.publishable(file) && (service.publishedPaths === null || service.publishedPaths.has(file.path)); },
        run: () => { const file = controller.activeFile(); if (controller.publishable(file)) return controller.openLive(file); },
      },
    ];
  },
  install(context) {
    const controller = createController(context), { workspace } = context.app;
    const ref = workspace.on("file-menu", (menu: unknown, file: unknown, source: unknown) => {
      if (!(file instanceof TFile) || !["tab-header", "more-options", "file-explorer-context-menu"].includes(String(source)) || !controller.publishable(file)) return;
      (menu as Menu).addItem(item => item.setSection("action").setTitle(t("plugins.publish.action-publish-file")).setIcon("lucide-send").onClick(() => controller.uploadFile(file)));
    });
    return () => workspace.offref(ref);
  },
};
