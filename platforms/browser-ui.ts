import type { BrowserMenuItem } from "../libs/positron";
export { BrowserImage, capturePage, printToPDF } from "../libs/positron";

export async function popupMenu(items: BrowserMenuItem[], activate: (action: number) => void): Promise<void> {
  const { Menu } = await import("../src/compat/ui");
  const build = (menu: InstanceType<typeof Menu>, entries: BrowserMenuItem[]) => {
    for (const entry of entries) {
      if (entry.visible === false) continue;
      if (entry.type === "separator") { menu.addSeparator(); continue; }
      menu.addItem(item => {
        item.setTitle(entry.label || entry.role || "").setDisabled(entry.enabled === false).setChecked(entry.type === "checkbox" ? !!entry.checked : null);
        if (entry.submenu) build(item.setSubmenu(), entry.submenu);
        else item.onClick(() => { if (entry.action !== undefined) activate(entry.action); else runMenuRole(entry.role); });
      });
    }
  };
  const menu = new Menu(); build(menu, items); menu.showAtPosition({ x: 24, y: 32 });
}
export function runMenuRole(role?: string): void {
  const commands: Record<string, string> = { undo: "undo", redo: "redo", cut: "cut", copy: "copy", paste: "paste", pasteAndMatchStyle: "paste", selectAll: "selectAll", delete: "delete" };
  if (role && commands[role]) document.execCommand(commands[role]);
  else if (role === "reload" || role === "forceReload") location.reload();
  else if (role === "togglefullscreen") { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen(); }
  else if (role === "close" || role === "quit") window.dispatchEvent(new Event("platform-open-starter"));
}
export function revealPath(filename: string): void {
  void import("./BrowserFileManager").then(({ showFileManager }) => showFileManager(filename));
}
