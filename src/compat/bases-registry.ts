import type { App } from "./plugin";
import type { ViewRegistration } from "../renderer/bases/controller";
import { Notice } from "./ui";
import { t } from "../i18n";

export type BasesViewRegistration = Omit<ViewRegistration, "name"> & { name: string };
const registrations = new WeakMap<App, Map<string, ViewRegistration>>();
const disabled = new WeakSet<App>();
const BUILTIN_TYPES = new Set(["table", "cards", "list"]);

export function setBasesEnabled(app: App, enabled: boolean): void {
  if (enabled) disabled.delete(app); else disabled.add(app);
}
export function getBasesViewRegistrations(app: App): Record<string, ViewRegistration> {
  return Object.fromEntries(registrations.get(app) ?? []);
}
/** Returns a disposer only when this vault accepted the view registration. */
export function registerBasesView(app: App, id: string, registration: BasesViewRegistration): (() => void) | null {
  if (disabled.has(app)) return null;
  let views = registrations.get(app);
  if (!views) registrations.set(app, views = new Map());
  if (BUILTIN_TYPES.has(id) || views.has(id)) {
    new Notice(t("plugins.bases.msg-error-register-view", { viewId: id }));
    return null;
  }
  const entry = { ...registration, name: () => registration.name };
  views.set(id, entry);
  app.workspace.trigger("bases-view-registered", id);
  return () => {
    if (views.get(id) !== entry) return;
    views.delete(id); app.workspace.trigger("bases-view-unregistered", id);
  };
}
