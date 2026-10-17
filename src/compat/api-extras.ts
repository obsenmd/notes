import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { t } from "../i18n";
import type { CachedMetadata, Loc, Reference, ReferenceCache } from "./metadata-cache";
import type { App } from "./plugin";
import { BaseComponent, ButtonComponent } from "./setting-controls";
import { Modal } from "./ui";
export { MomentFormatComponent } from "./setting-controls";
import { WorkspaceParent, type WorkspaceItem } from "./workspace";

// ---------------------------------------------------------------------------------------------
// Small helpers from the plugin API
// ---------------------------------------------------------------------------------------------

export function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> { return blob.arrayBuffer(); }

/** Calls `cb` for each reference until it returns true; reports whether one did. */
export function iterateRefs(refs: Reference[], cb: (ref: Reference) => boolean | void): boolean {
  for (const ref of refs) if (cb(ref)) return true;
  return false;
}
export function iterateCacheRefs(cache: CachedMetadata, cb: (ref: ReferenceCache) => boolean | void): boolean {
  return (!!cache.links && iterateRefs(cache.links, cb as (ref: Reference) => boolean | void)) || (!!cache.embeds && iterateRefs(cache.embeds, cb as (ref: Reference) => boolean | void));
}

export interface SubpathResult { start: Loc; end: Loc | null }
type CacheHeading = NonNullable<CachedMetadata["headings"]>[number];
type CacheBlock = NonNullable<CachedMetadata["blocks"]>[string];
export interface HeadingSubpathResult extends SubpathResult { type: "heading"; current: CacheHeading; next: CacheHeading | null }
export interface BlockSubpathResult extends SubpathResult { type: "block"; block: CacheBlock }
const plainHeading = (text: string) => text.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** Locates the heading section or block a link subpath (`#Heading`, `#A#B`, `#^block`) points at. */
export function resolveSubpath(cache: CachedMetadata, subpath: string): HeadingSubpathResult | BlockSubpathResult | null {
  const parts = subpath.split("#").filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1 && parts[0].startsWith("^")) {
    const id = parts[0].slice(1).toLowerCase();
    const block = Object.entries(cache.blocks ?? {}).find(([key]) => key.toLowerCase() === id)?.[1];
    return block ? { type: "block", block, start: block.position.start, end: block.position.end } : null;
  }
  const headings = cache.headings ?? [];
  // Each part must match a heading nested under the previous match.
  let index = -1, level = 0;
  for (const part of parts) {
    const wanted = plainHeading(part);
    let found = -1;
    for (let i = index + 1; i < headings.length; i++) {
      if (index >= 0 && headings[i].level <= level) break;
      if (plainHeading(headings[i].heading) === wanted) { found = i; break; }
    }
    if (found < 0) return null;
    index = found; level = headings[found].level;
  }
  const current = headings[index];
  const next = headings.slice(index + 1).find(heading => heading.level <= current.level) ?? null;
  return { type: "heading", current, next, start: current.position.start, end: next ? next.position.start : null };
}

/** Collects asynchronous work so a caller can wait for all of it. */
export class Tasks {
  private readonly pending: Promise<unknown>[] = [];
  add(callback: () => Promise<unknown>): void { this.pending.push(callback()); }
  addPromise(promise: Promise<unknown>): void { this.pending.push(promise); }
  isEmpty(): boolean { return this.pending.length === 0; }
  promise(): Promise<unknown> { return Promise.all(this.pending); }
}

// ---------------------------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------------------------

export class MenuSeparator {}

/** A masked field for a secret; the value is reported as null when cleared. */
export class SecretComponent extends BaseComponent {
  readonly inputEl: HTMLInputElement;
  private callbacks: Array<(value: string | null) => unknown> = [];
  constructor(readonly app: App, containerEl: HTMLElement) {
    super();
    this.inputEl = containerEl.ownerDocument.createElement("input");
    this.inputEl.type = "password"; this.inputEl.spellcheck = false; this.inputEl.autocomplete = "off";
    this.inputEl.addEventListener("input", () => { for (const callback of this.callbacks) callback(this.inputEl.value || null); });
    containerEl.appendChild(this.inputEl);
  }
  setValue(value: string): this { this.inputEl.value = value ?? ""; return this; }
  onChange(cb: (value: string | null) => unknown): this { this.callbacks.push(cb); return this; }
  override setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.inputEl.disabled = disabled; return this; }
}

export class ConfirmationButton extends ButtonComponent {
  /** @internal The dialog closes after the handler has run. */
  constructor(private readonly modal: ConfirmationModal, containerEl: HTMLElement) { super(containerEl); containerEl.appendChild(this.buttonEl); }
  override onClick(handler: (evt: MouseEvent) => unknown | Promise<unknown>): this {
    return super.onClick(async event => { try { await handler(event); } finally { this.modal.close(); } });
  }
  setInitialFocus(): this { this.modal.initialFocus = this.buttonEl; return this; }
  setSecondary(): this { this.buttonEl.classList.remove("mod-cta", "mod-warning"); return this; }
  setCancel(): this { this.buttonEl.classList.remove("mod-cta", "mod-warning"); this.buttonEl.classList.add("mod-cancel"); return this; }
}

/** A dialog with a row of buttons (and optional checkbox) under its content. */
export class ConfirmationModal extends Modal {
  buttonContainerEl: HTMLElement;
  /** @internal */
  initialFocus: HTMLElement | null = null;
  constructor(app: App) {
    super(app);
    this.buttonContainerEl = this.modalEl.ownerDocument.createElement("div");
    this.buttonContainerEl.className = "modal-button-container";
    this.modalEl.appendChild(this.buttonContainerEl);
  }
  addClass(cls: string): this { this.modalEl.classList.add(...cls.split(/\s+/).filter(Boolean)); return this; }
  addCheckbox(label: string, cb: (value: boolean) => unknown | Promise<unknown>): this {
    const doc = this.modalEl.ownerDocument, wrapper = doc.createElement("label"), input = doc.createElement("input");
    wrapper.className = "mod-checkbox"; input.type = "checkbox"; input.tabIndex = -1;
    input.addEventListener("change", () => void cb(input.checked));
    wrapper.append(input, label);
    this.buttonContainerEl.prepend(wrapper);
    return this;
  }
  addButton(cb: (btn: ConfirmationButton) => unknown): this { cb(new ConfirmationButton(this, this.buttonContainerEl)); return this; }
  addCancelButton(text?: string): this { return this.addButton(button => button.setButtonText(text ?? t("dialogue.button-cancel")).setCancel().onClick(() => undefined)); }
  override open(): void { super.open(); this.initialFocus?.focus(); }
}

// ---------------------------------------------------------------------------------------------
// Workspace items that only exist on other platforms or as markers
// ---------------------------------------------------------------------------------------------

/** The container of pop-out windows. */
export class WorkspaceFloating extends WorkspaceParent { readonly children: WorkspaceItem[] = []; }
/** Mobile-only drawer; never instantiated on desktop, exported so `instanceof` checks work. */
export class WorkspaceMobileDrawer extends WorkspaceParent {
  readonly children: WorkspaceItem[] = [];
  collapsed = true;
  expand(): void { this.collapsed = false; }
  collapse(): void { this.collapsed = true; }
  toggle(): void { this.collapsed = !this.collapsed; }
}
export { WorkspaceRibbon } from "./workspace";
/** Mobile-only file system adapter; never instantiated on desktop, exported so `instanceof` checks work. */
export class CapacitorAdapter {}

// ---------------------------------------------------------------------------------------------
// Editor state fields plugins read from a CodeMirror state
// ---------------------------------------------------------------------------------------------

/** What an editor belongs to: the app, its file, the Editor wrapper and any hover popover. */
export interface EditorInfo { app?: unknown; file?: unknown; editor?: unknown; hoverPopover?: unknown }
/** @internal Sets the fields below once the editor view exists, and again when the editing mode changes. */
export const bindEditorFields = StateEffect.define<{ view?: EditorView; info?: EditorInfo; livePreview?: boolean }>();
const bound = <T>(pick: (value: { view?: EditorView; info?: EditorInfo; livePreview?: boolean }) => T | undefined, initial: T) => StateField.define<T>({
  create: () => initial,
  update(value, transaction) { for (const effect of transaction.effects) if (effect.is(bindEditorFields)) { const next = pick(effect.value); if (next !== undefined) value = next; } return value; },
});
export const editorEditorField = bound<EditorView>(value => value.view, null as unknown as EditorView);
export const editorInfoField = bound<EditorInfo>(value => value.info, {});
/** Older name of `editorInfoField`; holds the same value. */
export const editorViewField = bound<EditorInfo>(value => value.info, {});
export const editorLivePreviewField = bound<boolean>(value => value.livePreview, false);
/** Tracks whether a mouse button is held in the editor, as Live Preview widgets need to know. */
export const livePreviewState = ViewPlugin.fromClass(class { mousedown = false; }, {
  eventHandlers: { mousedown() { this.mousedown = true; }, mouseup() { this.mousedown = false; } },
});
/** @internal Extensions every Markdown editor carries so the fields above can be read from its state. */
export const editorApiFields = [editorEditorField, editorInfoField, editorViewField, editorLivePreviewField, livePreviewState];
