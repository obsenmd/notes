import { ipcRenderer, process } from "../../platforms/platform";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { App } from "../compat/plugin";
import type { Hotkey } from "../compat/commands";
import { brandName, t } from "../i18n";

/** One entry the main process merges into the application menu; `before` names the base item it goes in front of. */
interface MenuEntry {
  label?: string; type?: "separator" | "checkbox" | "radio"; id?: string; visible?: boolean; enabled?: boolean;
  accelerator?: string; registerAccelerator?: boolean; appCommand?: string; before?: string[]; submenu?: MenuEntry[];
}
interface MenuItemState { itemId: string; eState: { checked?: boolean; enabled?: boolean } }

const isMac = process.platform === "darwin";
const ACCELERATOR_MODIFIERS: Array<[string, string]> = [["Mod", "CommandOrControl"], ["Ctrl", "Ctrl"], ["Meta", "Command"], ["Alt", "Alt"], ["Shift", "Shift"]];
function accelerator(hotkey: Hotkey | undefined): string {
  if (!hotkey) return "";
  const parts = ACCELERATOR_MODIFIERS.filter(([modifier]) => (hotkey.modifiers as string[]).includes(modifier)).map(([, name]) => name);
  if (hotkey.key) parts.push(hotkey.key.replace("Arrow", ""));
  return parts.join("+");
}

/** The command entries of the application menu, in the reference's order. */
function buildTemplate(): MenuEntry[] {
  const item = (appCommand: string, key: string, extra: Partial<MenuEntry> = {}): MenuEntry => ({ appCommand, label: t(key), ...extra });
  const open = { before: ["open-section"] }, quit = { before: ["quit"] }, developer = { before: ["developer-section"] };
  const separator: MenuEntry = { type: "separator" };
  const checkbox = { type: "checkbox" as const }, radio = { type: "radio" as const };
  const heading = (level: number): MenuEntry => ({ appCommand: `editor:set-heading-${level}`, label: t("menu-items.set-heading", { level }), ...radio });
  return [
    ...(isMac ? [{ label: brandName(), submenu: [item("app:open-settings", "obsen.menu.preferences", { before: ["preferences-section"] }), separator] }] : []),
    { label: t("obsen.menu.file"), submenu: [
      item("file-explorer:new-file", "menu-items.new-file", open),
      item("file-explorer:new-file-in-new-pane", "menu-items.new-file-to-the-right", open),
      item("workspace:new-tab", "menu-items.new-tab", open),
      item("workspace:new-window", "menu-items.new-window", open),
      { ...open, ...separator },
      item("switcher:open", "menu-items.open-switcher", open),
      item("app:open-file", "menu-items.open-file", open),
      { ...quit, ...separator },
      item("workspace:close", "menu-items.close-tab", quit),
      item("workspace:close-window", "menu-items.close-window", quit),
      item("workspace:export-pdf", "menu-items.export-pdf", quit),
    ] },
    { label: t("obsen.menu.edit"), submenu: [
      { id: "find-section", before: ["speech-section"], type: "separator" },
      item("editor:open-search", "menu-items.find", { before: ["speech-section"] }),
      item("editor:open-search-replace", "menu-items.replace", { before: ["speech-section"] }),
      separator,
    ] },
    { label: t("obsen.menu.insert"), submenu: [
      item("editor:insert-wikilink", "menu-items.insert-wikilink"),
      item("editor:insert-link", "menu-items.insert-markdown-link"),
      item("editor:insert-callout", "menu-items.insert-callout"),
      item("editor:insert-blockquote", "menu-items.insert-quote"),
      separator,
      item("editor:insert-codeblock", "menu-items.insert-codeblock"),
      item("editor:insert-mathblock", "menu-items.insert-math-block"),
      item("editor:insert-table", "menu-items.insert-table"),
      item("editor:insert-footnote", "menu-items.insert-footnote"),
      separator, separator,
      item("editor:toggle-bullet-list", "menu-items.toggle-bullet-list"),
      item("editor:toggle-numbered-list", "menu-items.toggle-numbered-list"),
      item("editor:toggle-checklist-status", "menu-items.toggle-checklist"),
      separator,
      item("editor:attach-file", "menu-items.insert-attachment"),
      separator,
      { label: t("menu-items.folding-menu"), submenu: [
        item("editor:fold-all", "menu-items.fold-all"), item("editor:unfold-all", "menu-items.unfold-all"), separator,
        item("editor:fold-more", "menu-items.fold-more"), item("editor:fold-less", "menu-items.fold-less"),
      ] },
    ] },
    { label: t("obsen.menu.format"), submenu: [
      // Checked while the selection spans several heading levels, so no level shows as chosen.
      { id: "heading-indeterminate", label: t("obsen.menu.heading-indeterminate"), type: "radio", visible: false },
      heading(1), heading(2), heading(3), heading(4), heading(5), heading(6),
      item("editor:set-heading-0", "menu-items.no-heading", radio),
      separator,
      item("editor:toggle-bold", "menu-items.toggle-bold", checkbox),
      item("editor:toggle-italics", "menu-items.toggle-italics", checkbox),
      item("editor:toggle-code", "menu-items.toggle-code", checkbox),
      item("editor:toggle-highlight", "menu-items.toggle-highlight", checkbox),
      separator,
      item("editor:toggle-strikethrough", "menu-items.toggle-strikethrough", checkbox),
      item("editor:toggle-inline-math", "menu-items.toggle-inline-math", checkbox),
      item("editor:toggle-comments", "menu-items.toggle-comment", checkbox),
      separator,
    ] },
    { label: t("obsen.menu.view"), submenu: [
      item("markdown:toggle-preview", "menu-items.reading-view", checkbox),
      item("editor:toggle-source", "menu-items.source-mode", checkbox),
      separator,
      item("app:toggle-left-sidebar", "menu-items.toggle-left-sidebar", checkbox),
      item("app:toggle-right-sidebar", "menu-items.toggle-right-sidebar", checkbox),
      separator,
      item("app:toggle-ribbon", "menu-items.toggle-ribbon", checkbox),
      separator,
      item("workspace:split-vertical", "menu-items.split-right"),
      item("workspace:split-horizontal", "menu-items.split-down"),
      separator,
      item("app:go-back", "menu-items.navigate-back", developer),
      item("app:go-forward", "menu-items.navigate-forward", developer),
      { ...developer, ...separator },
    ] },
    { label: t("obsen.menu.window"), submenu: [item("workspace:move-to-new-window", "menu-items.move-to-new-window", { before: ["tab-management"] })] },
    { label: t("obsen.menu.help"), submenu: [
      item("app:show-release-notes", "menu-items.release-notes", { before: ["help-links"] }),
      item("app:show-debug-info", "menu-items.show-debug-info"),
      item("app:open-sandbox-vault", "menu-items.open-sandbox"),
    ] },
  ];
}

interface MarkdownLike { getMode?: () => string; sourceMode?: boolean; editor?: { cm?: EditorView | null } }

/** What the selection's first range is formatted as, for the Format menu's marks. */
function formattingState(view: EditorView): MenuItemState[] {
  const { state } = view, range = state.selection.main;
  const levels = new Set<number>();
  for (let line = state.doc.lineAt(range.from); ; line = state.doc.line(line.number + 1)) {
    levels.add(/^(#{1,6})\s/.exec(line.text)?.[1].length ?? 0);
    if (line.to >= range.to || line.number >= state.doc.lines) break;
  }
  const names = new Set<string>();
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(range.head, -1); node; node = node.parent) names.add(node.name);
  const has = (...wanted: string[]) => wanted.some(name => names.has(name));
  return [
    levels.size === 1 ? { itemId: `editor:set-heading-${[...levels][0]}`, eState: { checked: true } } : { itemId: "heading-indeterminate", eState: { checked: true } },
    { itemId: "editor:toggle-italics", eState: { checked: has("Emphasis") } },
    { itemId: "editor:toggle-bold", eState: { checked: has("StrongEmphasis") } },
    { itemId: "editor:toggle-code", eState: { checked: has("InlineCode") } },
    { itemId: "editor:toggle-highlight", eState: { checked: has("Highlight") } },
    { itemId: "editor:toggle-comments", eState: { checked: has("Comment", "CommentBlock") } },
    { itemId: "editor:toggle-strikethrough", eState: { checked: has("Strikethrough") } },
  ];
}

let requestRender: () => void = () => undefined;
/** Rebuilds the application menu soon; call after commands, hotkeys or the language change. */
export function requestAppMenuRender(): void { requestRender(); }
let refreshState: () => void = () => undefined;
/** Opens the application menu at the pointer, as the title bar's logo button does. */
export function showAppMenu(): void { refreshState(); ipcRenderer.send("render-menu"); }

/** Supplies the application menu with this vault's commands and keeps its marks current. */
export function installAppMenu(app: App): () => void {
  const { workspace } = app;
  const render = () => {
    const template = buildTemplate();
    const prepare = (entries: MenuEntry[]) => {
      for (const entry of entries) {
        if (entry.appCommand) {
          const command = app.commands.findCommand(entry.appCommand);
          if (!command) entry.visible = false;
          entry.accelerator = accelerator(command?.hotkeys?.[0]);
          entry.registerAccelerator = false;
        }
        if (entry.submenu) prepare(entry.submenu);
      }
    };
    prepare(template);
    ipcRenderer.send("set-menu", { template });
    update();
  };
  const update = () => {
    const view = workspace.activeMarkdownView as MarkdownLike | null;
    const markdown = !!view && typeof view.getMode === "function";
    const preview = markdown && view!.getMode!() === "preview";
    const inMainWindow = ((globalThis as { activeWindow?: Window }).activeWindow ?? window) === window;
    const items: MenuItemState[] = [
      { itemId: "markdown:toggle-preview", eState: { checked: preview, enabled: markdown } },
      { itemId: "editor:toggle-source", eState: { checked: markdown && !preview && !!view!.sourceMode, enabled: markdown && !preview } },
      { itemId: "app:toggle-left-sidebar", eState: { checked: !!workspace.leftSplit && !workspace.leftSplit.collapsed, enabled: inMainWindow } },
      { itemId: "app:toggle-right-sidebar", eState: { checked: !!workspace.rightSplit && !workspace.rightSplit.collapsed, enabled: inMainWindow } },
      { itemId: "app:toggle-ribbon", eState: { checked: document.body.classList.contains("show-ribbon"), enabled: inMainWindow } },
      { itemId: "workspace:move-to-new-window", eState: { enabled: !!workspace.activeLeaf && workspace.activeLeaf.view.getViewType() !== "empty" } },
    ];
    const cm = markdown && !preview ? view!.editor?.cm : null;
    if (cm) items.push(...formattingState(cm));
    ipcRenderer.send("update-menu-items", items);
  };
  let renderTimer: ReturnType<typeof setTimeout> | undefined, updateTimer: ReturnType<typeof setTimeout> | undefined;
  requestRender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 200); };
  refreshState = update;
  const requestUpdate = () => { clearTimeout(updateTimer); updateTimer = setTimeout(update, 250); };
  const refs = [workspace.on("file-open", requestUpdate), workspace.on("active-leaf-change", requestUpdate), workspace.on("layout-change", requestUpdate)];
  const onCommand = (_event: unknown, id: string) => { app.executeCommandById(id); };
  ipcRenderer.on("menu-command", onCommand);
  window.addEventListener("language-changed", requestRender);
  workspace.onLayoutReady(render);
  return () => {
    clearTimeout(renderTimer); clearTimeout(updateTimer);
    for (const ref of refs) workspace.offref(ref);
    ipcRenderer.removeListener("menu-command", onCommand);
    window.removeEventListener("language-changed", requestRender);
    requestRender = () => undefined; refreshState = () => undefined;
  };
}
