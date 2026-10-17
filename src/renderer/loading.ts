import { startup as messages } from "../locales/app/en.json";

export interface LoadingSurfaceController {
  setMessage(message: string): void;
  dispose(): void;
}

/** The reference's indeterminate startup progress bar, without runtime dependencies. */
export function showLoadingSurface(message: string, doc: Document = document): LoadingSurfaceController {
  const container = doc.createElement("div");
  container.className = "progress-bar-container app-loading-surface";
  container.setAttribute("aria-busy", "true");
  const progress = doc.createElement("div");
  progress.className = "progress-bar";
  const label = doc.createElement("div");
  label.className = "progress-bar-message u-center-text";
  label.setAttribute("role", "status");
  label.setAttribute("aria-live", "polite");
  label.textContent = message;
  const indicator = doc.createElement("div");
  indicator.className = "progress-bar-indicator";
  indicator.setAttribute("aria-hidden", "true");
  for (const className of ["progress-bar-line", "progress-bar-subline", "progress-bar-subline mod-increase", "progress-bar-subline mod-decrease"]) {
    const segment = doc.createElement("div");
    segment.className = className;
    if (className === "progress-bar-subline") segment.hidden = true;
    indicator.append(segment);
  }
  const context = doc.createElement("div");
  context.className = "progress-bar-context";
  progress.append(label, indicator, context);
  container.append(progress);
  doc.body.prepend(container);
  doc.body.classList.add("in-progress");
  return {
    setMessage(value) { label.textContent = value; },
    dispose() {
      container.remove();
      if (!doc.querySelector(".app-loading-surface")) doc.body.classList.remove("in-progress");
    },
  };
}

let startup: LoadingSurfaceController | undefined;

/** Runs before the browser platform and renderer bundles finish loading. */
export function beginStartupLoading(): void {
  startup ??= showLoadingSurface(messages["loading-app"].replace("{{app}}", document.title));
}

export function finishStartupLoading(): void {
  startup?.dispose();
  startup = undefined;
}
