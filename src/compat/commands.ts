import type { Command as BaseCommand, Plugin } from "./plugin";

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

export interface Hotkey {
  modifiers: Modifier[];
  key: string;
}

export interface CommandContext {
  editor?: unknown;
  view?: unknown;
}

/** Full command shape, including editor-aware callback variants. */
export interface Command extends BaseCommand {
  hotkeys?: Hotkey[];
  editorCallback?: (editor: unknown, ctx: unknown) => unknown;
  editorCheckCallback?: (checking: boolean, editor: unknown, ctx: unknown) => boolean | void;
}

export interface KeymapInfo {
  modifiers: string | null;
  key: string | null;
}

export interface KeymapContext extends KeymapInfo {
  vkey: string;
}

export interface KeymapEventHandler extends KeymapInfo {
  scope: Scope;
  callback: (event: KeyboardEvent, context: KeymapContext) => false | unknown;
}

export type KeymapEventListener = (event: KeyboardEvent, context: KeymapContext) => false | unknown;

/** Hierarchical keyboard scope with active-child dispatch and parent fallback. */
export class Scope {
  readonly handlers = new Set<KeymapEventHandler>();
  constructor(readonly parent?: Scope) {}

  register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
    const handler: KeymapEventHandler = {
      scope: this,
      modifiers: modifiers === null ? null : normalizeModifiers(modifiers),
      key: key === null ? null : normalizeKey(key),
      callback: func,
    };
    this.handlers.add(handler);
    return handler;
  }

  unregister(handler: KeymapEventHandler): void { this.handlers.delete(handler); }

  /** Returns true when a handler consumed the event. */
  handleKey(event: KeyboardEvent): boolean {
    const context = contextForEvent(event);
    // Later registrations have priority, matching the active-scope override
    // behavior expected for user and plugin hotkeys.
    for (const handler of [...this.handlers].reverse()) {
      if (handler.key !== null && handler.key !== context.key) continue;
      if (handler.modifiers !== null && handler.modifiers !== context.modifiers) continue;
      if (handler.callback(event, context) === false) {
        event.preventDefault();
        return true;
      }
    }
    return this.parent?.handleKey(event) ?? false;
  }
}

/** Stack of scopes and platform-aware modifier helpers. */
export class Keymap {
  private readonly stack: Scope[] = [];
  readonly rootScope = new Scope();
  private listeningWindow?: Window;
  private readonly listener = (event: KeyboardEvent) => { this.handleKey(event); };
  constructor() { this.pushScope(this.rootScope); }
  listen(win?: Window): this {
    const target = win ?? (typeof window === "undefined" ? undefined : window);
    if (!target) return this;
    if (this.listeningWindow !== target) {
      this.stopListening();
      target.addEventListener("keydown", this.listener, true);
      this.listeningWindow = target;
    }
    return this;
  }
  stopListening(): this {
    this.listeningWindow?.removeEventListener("keydown", this.listener, true);
    this.listeningWindow = undefined;
    return this;
  }
  pushScope(scope: Scope): void {
    const existing = this.stack.indexOf(scope);
    if (existing >= 0) this.stack.splice(existing, 1);
    this.stack.push(scope);
  }
  popScope(scope: Scope): void {
    const index = this.stack.lastIndexOf(scope);
    if (index >= 0) this.stack.splice(index, 1);
  }
  handleKey(event: KeyboardEvent): boolean { return this.stack[this.stack.length - 1]?.handleKey(event) ?? false; }
  get activeScope(): Scope | undefined { return this.stack[this.stack.length - 1]; }

  static isModifier(event: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    switch (modifier) {
      case "Mod": return isMac() ? event.metaKey : event.ctrlKey;
      case "Ctrl": return event.ctrlKey;
      case "Meta": return event.metaKey;
      case "Shift": return event.shiftKey;
      case "Alt": return event.altKey;
    }
  }

  static isModEvent(event?: MouseEvent | TouchEvent | KeyboardEvent | null): "tab" | "split" | "window" | false {
    if (!event) return false;
    if ("button" in event && event.button === 1) return "tab";
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    if (!mod) return false;
    if (event.altKey && event.shiftKey) return "window";
    if (event.altKey) return "split";
    return "tab";
  }
}

/** Command store suitable for App.command registry and keyboard dispatch. */
export class CommandRegistry {
  readonly commands = new Map<string, Command>();
  readonly keymap = new Keymap();
  private readonly hotkeyHandlers = new Map<string, KeymapEventHandler[]>();
  constructor(readonly rootScope = new Scope()) { this.keymap.pushScope(rootScope); }

  setContextProvider(provider: () => CommandContext): void {
    this.contextProvider = provider;
  }

  private contextProvider: () => CommandContext = () => ({});

  add(command: Command): Command {
    if (!command.id?.trim() || !command.name?.trim()) throw new Error("A command needs an id and name.");
    this.remove(command.id);
    this.commands.set(command.id, command);
    const handlers = (command.hotkeys ?? []).map((hotkey) => this.rootScope.register(hotkey.modifiers, hotkey.key, (event) => {
      const context = this.contextProvider();
      if (!this.isAvailable(command.id, context)) return undefined;
      const result = this.execute(command.id, context, true);
      return result ? false : undefined;
    }));
    if (handlers.length) this.hotkeyHandlers.set(command.id, handlers);
    return command;
  }

  /** Lookup helpers with the names community plugins call on `app.commands`. */
  listCommands(): Command[] { return [...this.commands.values()]; }
  findCommand(id: string): Command | undefined { return this.commands.get(id); }
  executeCommandById(id: string): boolean { return this.execute(id, this.contextProvider()); }

  remove(id: string): void {
    for (const handler of this.hotkeyHandlers.get(id) ?? []) this.rootScope.unregister(handler);
    this.hotkeyHandlers.delete(id);
    this.commands.delete(id);
  }

  execute(id: string, context: CommandContext = {}, alreadyChecked = false): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    const editor = context.editor;
    const view = context.view;
    if (command.editorCheckCallback) return editor !== undefined && command.editorCheckCallback(false, editor, view) !== false;
    if (command.editorCallback && editor !== undefined) { command.editorCallback(editor, view); return true; }
    if (command.checkCallback) {
      if (!alreadyChecked && command.checkCallback(true) === false) return false;
      return command.checkCallback(false) !== false;
    }
    if (command.callback) { command.callback(); return true; }
    return false;
  }

  isAvailable(id: string, context: CommandContext = {}): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    if (command.editorCheckCallback) return context.editor !== undefined && command.editorCheckCallback(true, context.editor, context.view) !== false;
    if (command.editorCallback) return context.editor !== undefined;
    if (command.checkCallback) return command.checkCallback(true) !== false;
    return Boolean(command.callback);
  }
}

export function makeHotkey(modifiers: Modifier[], key: string): Hotkey {
  return { modifiers: [...modifiers], key };
}

/** Attach the UI methods expected by plugins, tying created elements to unload. */
export function installPluginCommandApi(
  plugin: Plugin,
  registry: CommandRegistry,
  ribbonEl?: HTMLElement,
  statusBarEl?: HTMLElement,
): void {
  // App.keymap is the window listener used by the desktop host. Keep the
  // registry's hotkey scope on that dispatch stack so registered commands run.
    plugin.app.keymap.pushScope(registry.rootScope);
  const instance = plugin as Plugin & {
    addCommand(command: Command): Command;
    addRibbonIcon(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement;
    addStatusBarItem(): HTMLElement;
    removeCommand(commandId: string): void;
  };
  instance.addCommand = (command) => {
    const id = `${plugin.manifest.id}:${command.id}`;
    const scoped: Command = { ...command, id, name: `${plugin.manifest.name}: ${command.name}` };
    plugin.registerCommand(scoped);
    return scoped;
  };
  instance.removeCommand = (id) => {
    const key = id.includes(":") ? id : `${plugin.manifest.id}:${id}`;
    plugin.unregisterCommand(key);
    plugin.app.commands.remove(key);
  };
  instance.addRibbonIcon = (icon, title, callback) => {
    const element = document.createElement("div");
    element.className = "clickable-icon side-dock-ribbon-action";
    element.setAttribute("aria-label", title);
    element.setAttribute("data-ribbon-id", plugin.manifest.id);
    element.setAttribute("data-tooltip-position", "right");
    element.dataset.icon = icon;
    plugin.app.setIcon(element, icon);
    element.addEventListener("click", callback);
    (ribbonEl ?? document.querySelector<HTMLElement>(".side-dock-actions"))?.append(element);
    plugin.register(() => element.remove());
    return element;
  };
  instance.addStatusBarItem = () => {
    const element = document.createElement("div");
    element.className = `status-bar-item plugin-${plugin.manifest.id}`;
    (statusBarEl ?? document.querySelector<HTMLElement>(".status-bar"))?.append(element);
    plugin.register(() => element.remove());
    return element;
  };
}

function contextForEvent(event: KeyboardEvent): KeymapContext {
  const modifiers = normalizeModifiers([
    ...(event.ctrlKey ? ["Ctrl"] : []),
    ...(event.metaKey ? ["Meta"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    ...(event.altKey ? ["Alt"] : []),
  ] as Modifier[]);
  return { modifiers, key: normalizeKey(event.key), vkey: event.key };
}

function normalizeModifiers(modifiers: Modifier[]): string | null {
  const values = new Set(modifiers.map((modifier) => modifier === "Mod" ? (isMac() ? "Meta" : "Ctrl") : modifier));
  const order = ["Alt", "Ctrl", "Meta", "Shift"] as const;
  return order.filter((modifier) => values.has(modifier)).join("+") || null;
}
function normalizeKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  const aliases: Record<string, string> = {
    esc: "escape",
    space: " ",
    spacebar: " ",
    left: "arrowleft",
    right: "arrowright",
    up: "arrowup",
    down: "arrowdown",
    del: "delete",
  };
  return aliases[normalized] ?? normalized;
}
function isMac(): boolean { return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform); }
