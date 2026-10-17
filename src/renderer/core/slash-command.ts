import type { Command } from "../../compat/commands";
import type { Editor, EditorPosition } from "../../compat/editor";
import type { App } from "../../compat/plugin";
import { EditorSuggest, prepareFuzzySearch, renderMatches, type EditorSuggestContext, type EditorSuggestTriggerInfo, type FuzzyMatch } from "../../compat/suggest";
import type { TFile } from "../../compat/vault";
import { readCorePluginData } from "../core-plugins";
import { formatHotkey } from "../hotkeys";
import type { CorePluginModule } from "./types";

const TRIGGER = /(^|\s)\/([^\s/]*)$/;
/** How long after a keystroke an update still counts as caused by typing. */
const TYPING_WINDOW = 500;

/** Lists commands while the text before the cursor is `/query`; choosing one removes that text and runs it. */
class SlashCommandSuggest extends EditorSuggest<FuzzyMatch<Command>> {
  pinned: string[] = [];
  private typedAt = -Infinity;

  constructor(app: App) { super(app); }

  /** Navigation keys must reach the list before the editor acts on them. */
  readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.rootEl || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === "ArrowDown") this.setActive(this.activeIndex + 1);
    else if (event.key === "ArrowUp") this.setActive(this.activeIndex - 1);
    else if (event.key === "Enter" && this.activeIndex >= 0) this.selectSuggestion(this.values[this.activeIndex], event);
    else if (event.key === "Escape") this.close();
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  readonly onBeforeInput = (event: Event): void => {
    if ((event as InputEvent).inputType?.startsWith("insert") && (event.target as HTMLElement | null)?.closest?.(".cm-content")) this.typedAt = performance.now();
  };
  readonly reposition = (): void => {
    const { rootEl, context } = this, view = context?.editor.cm;
    if (!rootEl || !context || !view) return;
    const start = view.coordsAtPos(context.editor.posToOffset(context.start)), end = view.coordsAtPos(context.editor.posToOffset(context.end));
    if (!start || !end) return;
    const win = rootEl.ownerDocument.defaultView ?? window, gap = 5;
    const { offsetWidth: width, offsetHeight: height } = rootEl;
    const below = end.bottom + gap, above = start.top - gap - height;
    const top = below + height > win.innerHeight && above >= 0 ? above : below;
    const left = Math.max(0, Math.min(Math.min(start.left, end.left), win.innerWidth - width));
    Object.assign(rootEl.style, { left: `${left}px`, top: `${top}px` });
  };

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file || editor.somethingSelected()) return null;
    // The list opens in response to typing and then follows the cursor for as long as it stays open.
    if (!this.rootEl && performance.now() - this.typedAt > TYPING_WINDOW) return null;
    const match = TRIGGER.exec(editor.getLine(cursor.line).slice(0, cursor.ch));
    if (!match) return null;
    return { start: { line: cursor.line, ch: match.index + match[1].length }, end: { line: cursor.line, ch: cursor.ch }, query: match[2] };
  }

  /** Pinned commands in their pinned order, then the rest by name with recently used ones first. */
  private commands(): Command[] {
    const context = this.app.getCommandContext();
    const all = this.app.commands.listCommands().filter(command => this.app.commands.isAvailable(command.id, context));
    const order = (ids: string[]) => { const rank = new Map(ids.map((id, index) => [id, index])); return (a: Command, b: Command) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || 0; };
    const stored = this.app.loadLocalStorage("recent-commands"), recent = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    const pinned = new Set(this.pinned);
    return [
      ...all.filter(command => pinned.has(command.id)).sort(order(this.pinned)),
      ...all.filter(command => !pinned.has(command.id)).sort((a, b) => a.name.localeCompare(b.name)).sort(order(recent)),
    ];
  }

  getSuggestions(context: EditorSuggestContext): FuzzyMatch<Command>[] {
    const search = prepareFuzzySearch(context.query);
    return this.commands().flatMap(item => { const match = search(item.name); return match ? [{ item, match }] : []; }).sort((a, b) => b.match.score - a.match.score);
  }

  renderSuggestion(value: FuzzyMatch<Command>, el: HTMLElement): void {
    el.classList.add("mod-complex");
    const content = el.createSpan("suggestion-content"), aux = el.createSpan("suggestion-aux"), title = content.createDiv("suggestion-title");
    const { item, match } = value, name = item.name, colon = name.indexOf(": ");
    if (colon !== -1) {
      renderMatches(title.createSpan("suggestion-prefix"), name.slice(0, colon), match.matches);
      renderMatches(title.createSpan(), name.slice(colon + 2), match.matches, -(colon + 2));
    } else renderMatches(title.createSpan(), name, match.matches);
    for (const hotkey of item.hotkeys ?? []) aux.createEl("kbd", { cls: "suggestion-hotkey", text: formatHotkey(hotkey) });
    if (this.pinned.includes(item.id)) aux.createSpan({ cls: "suggestion-flair" }, flair => this.app.setIcon(flair, "lucide-pin"));
  }

  protected override render(values: FuzzyMatch<Command>[]): void {
    super.render(values);
    this.reposition();
  }

  selectSuggestion(value: FuzzyMatch<Command>, event: MouseEvent | KeyboardEvent): void {
    const context = this.context;
    this.close();
    if (!context) return;
    this.app.lastEvent = event;
    context.editor.replaceRange("", context.start, context.end);
    try { this.app.executeCommandById(value.item.id); }
    finally { this.app.lastEvent = null; }
  }
}

export const slashCommandPlugin: CorePluginModule = {
  id: "slash-command",
  install({ app, configDir }) {
    const suggest = new SlashCommandSuggest(app);
    const loadPinned = () => void readCorePluginData(configDir, "command-palette").then(data => {
      suggest.pinned = Array.isArray(data.pinned) ? data.pinned.filter((id): id is string => typeof id === "string") : [];
    }).catch(() => undefined);
    loadPinned();
    const changed = app.workspace.on("core-plugin-settings-change", (id: unknown) => { if (id === "command-palette") loadPinned(); });
    document.addEventListener("keydown", suggest.onKeyDown, true);
    document.addEventListener("beforeinput", suggest.onBeforeInput, true);
    document.addEventListener("scroll", suggest.reposition, { capture: true, passive: true });
    window.addEventListener("resize", suggest.reposition);
    suggest.attach();
    return () => {
      suggest.detach();
      app.workspace.offref(changed);
      document.removeEventListener("keydown", suggest.onKeyDown, true);
      document.removeEventListener("beforeinput", suggest.onBeforeInput, true);
      document.removeEventListener("scroll", suggest.reposition, { capture: true });
      window.removeEventListener("resize", suggest.reposition);
    };
  },
};
