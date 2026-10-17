import { process } from "../../platforms/platform";
import type { Hotkey, Modifier } from "../compat/commands";

const isMac = typeof process !== "undefined" && process.platform === "darwin";
const MODIFIER_ORDER: Modifier[] = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
const MODIFIER_LABELS: Record<Modifier, string> = isMac
  ? { Mod: "⌘", Ctrl: "⌃", Meta: "⌘", Alt: "⌥", Shift: "⇧" }
  : { Mod: "Ctrl", Ctrl: "Ctrl", Meta: "Win", Alt: "Alt", Shift: "Shift" };
const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", " ": "Space", Enter: isMac ? "↵" : "Enter",
  Backspace: isMac ? "⌫" : "Backspace", Delete: isMac ? "⌦" : "Delete", Escape: "Esc",
};

export function hotkeyParts(hotkey: Hotkey): string[] {
  const modifiers = MODIFIER_ORDER.filter(modifier => hotkey.modifiers.includes(modifier)).map(modifier => MODIFIER_LABELS[modifier]);
  const key = KEY_LABELS[hotkey.key] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
  return [...new Set(modifiers), key];
}

/** Formats a hotkey the way the reference displays it, for example `Ctrl + Shift + F`. */
export function formatHotkey(hotkey: Hotkey): string {
  return hotkeyParts(hotkey).join(isMac ? " " : " + ");
}

/** Name of the platform's primary modifier, for instructional copy. */
export const modKeyName = isMac ? "Cmd" : "Ctrl";
