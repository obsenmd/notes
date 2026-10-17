import type { App } from "./plugin";

export type PropertyDailyNoteOpener = (date: string, event: MouseEvent) => void;
const openers = new WeakMap<App, PropertyDailyNoteOpener>();

/** The host registers this before restoring views, so every property host shares it. */
export function setPropertyDailyNoteOpener(app: App, opener: PropertyDailyNoteOpener | undefined): void {
  if (opener) openers.set(app, opener); else openers.delete(app);
}
export function getPropertyDailyNoteOpener(app: App): PropertyDailyNoteOpener | undefined { return openers.get(app); }
