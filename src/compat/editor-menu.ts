import { clipboard } from "../../platforms/platform";
import type { App } from "./plugin";
import type { Editor } from "./editor";
import { Menu } from "./ui";
import { t } from "../i18n";

/** Core clipboard actions and plugin contributions for tabs and embedded editors. */
export function showEditorContextMenu(app: App, editor: Editor, info: unknown, event: MouseEvent): void {
  if (event.defaultPrevented || !editor.cm?.contentDOM.contains(event.target as Node)) return;
  const menu = new Menu();
  menu.addItem(item => item.setSection("clipboard").setTitle(t("interface.menu.cut")).setIcon("lucide-scissors").setDisabled(!editor.somethingSelected()).onClick(() => {
    clipboard.writeText(editor.getSelection()); editor.replaceSelection(""); editor.focus();
  }));
  menu.addItem(item => item.setSection("clipboard").setTitle(t("interface.menu.copy")).setIcon("lucide-copy").setDisabled(!editor.somethingSelected()).onClick(() => clipboard.writeText(editor.getSelection())));
  menu.addItem(item => item.setSection("clipboard").setTitle(t("interface.menu.paste")).setIcon("lucide-clipboard-check").onClick(() => {
    editor.focus(); editor.cm?.contentDOM.ownerDocument.execCommand("paste");
  }));
  menu.addItem(item => item.setSection("clipboard").setTitle(t("interface.menu.paste-as-plain-text")).setIcon("lucide-clipboard-type").onClick(() => {
    editor.replaceSelection(clipboard.readText()); editor.focus();
  }));
  menu.addItem(item => item.setSection("clipboard").setTitle(t("interface.menu.select-all")).setIcon("lucide-box-select").onClick(() => {
    editor.setSelection({ line: 0, ch: 0 }, editor.offsetToPos(editor.getValue().length)); editor.focus();
  }));
  app.workspace.trigger("editor-menu", menu, editor, info);
  event.preventDefault();
  menu.showAtMouseEvent(event);
}
