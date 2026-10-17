import assert from "node:assert/strict";
import { TFile, type Vault } from "../src/compat/vault";
import { View, Workspace } from "../src/compat/workspace";
import { FileView } from "../src/compat/file-views";
import { Editor } from "../src/compat/editor";
import { MetadataCache } from "../src/compat/metadata-cache";
import { assignPropertyType, readPropertyTypes } from "../src/compat/property-types";
import type { App } from "../src/compat/plugin";

const file = new TFile({} as Vault, "Notes/Target.md");
const linkFiles = ["diagram.md", "Attachments/diagram.png", "Foo.md", "Foo.bar.md"].map(path => new TFile({} as Vault, path));
const linkCache = new MetadataCache({ getFiles: () => linkFiles, getFileByPath: path => linkFiles.find(file => file.path === path) ?? null });
assert.equal(linkCache.getFirstLinkpathDest("diagram.png", "Notes/Source.md")?.path, "Attachments/diagram.png", "explicit image links keep their extension when a note shares the basename");
assert.equal(linkCache.getFirstLinkpathDest("diagram", "Notes/Source.md")?.path, "diagram.md");
assert.equal(linkCache.getFirstLinkpathDest("Foo.bar", "Notes/Source.md")?.path, "Foo.bar.md", "a dot in a note name is preserved");
const canvasFile = new TFile({} as Vault, "Links.canvas");
const canvasData = { nodes: [{ id: "text", type: "text", text: "[[diagram]] ![[Attachments/diagram.png]]" }, { id: "file", type: "file", file: "diagram.md" }] };
linkFiles.push(canvasFile);
assert.deepEqual(linkCache.setFileCache(canvasFile, JSON.stringify(canvasData)), {}, "canvas's public cache remains empty");
assert.deepEqual(linkCache.resolvedLinks[canvasFile.path], { "diagram.md": 2, "Attachments/diagram.png": 1 }, "canvas text links, embeds and file cards contribute to link counts");
canvasData.nodes[0].text = "No links";
linkCache.setFileCache(canvasFile, JSON.stringify(canvasData));
assert.deepEqual(linkCache.resolvedLinks[canvasFile.path], { "diagram.md": 1 }, "canvas edits replace the prior link counts");
linkCache.removeFile(canvasFile);
assert.equal(linkCache.resolvedLinks[canvasFile.path], undefined, "deleting a canvas removes its link counts");
const cursorCalls: unknown[] = [];
const app = {
  metadataCache: {
    getFirstLinkpathDest(link: string, source: string) {
      assert.ok(link === "Target" || link === "Target#Heading");
      assert.equal(source, "Notes/Source.md");
      return { path: file.path };
    },
    getFileCache() {
      return { headings: [{ heading: "Heading", position: { start: { offset: 42 } } }] };
    },
  },
  vault: {
    getAbstractFileByPath: (filePath: string) => filePath === file.path ? file : null,
    cachedRead: async () => "# Heading",
  },
} as unknown as App;
const workspace = new Workspace(app);
app.workspace = workspace;
class LayoutView extends View {
  navigation = false;
  value = "";
  getViewType(): string { return "layout-smoke"; }
  getDisplayText(): string { return this.value; }
  override getState(): Record<string, unknown> { return { value: this.value }; }
  override async setState(state: unknown): Promise<void> { this.value = String((state as { value?: unknown }).value ?? ""); }
}
workspace.registerView("layout-smoke", (leaf) => new LayoutView(leaf));
const opened: Array<{ file: TFile; state: unknown }> = [];
const fileEvents: Array<TFile | null> = [];
const editorEvents: Array<{ editor: Editor; info: unknown }> = [];
workspace.on("file-open", (openedFile) => fileEvents.push(openedFile));
workspace.on("editor-change", (editor, info) => editorEvents.push({ editor, info }));
const editor = new Editor();
editor.offsetToPos = (offset) => offset === 42 ? { line: 4, ch: 2 } : { line: 0, ch: offset };
editor.setCursor = (position) => { cursorCalls.push(position); };
editor.scrollIntoView = (range, center) => { cursorCalls.push({ range, center }); };
class LinkView extends FileView {
  file: TFile | null = null;
  readonly editor = editor;
  getViewType(): string { return "markdown"; }
  getDisplayText(): string { return this.file?.basename ?? "Markdown"; }
  override getState(): Record<string, unknown> { return { file: this.file?.path }; }
  override async setState(state: unknown): Promise<void> {
    const { file: filePath, ...options } = state as { file: string };
    assert.equal(filePath, file.path);
    this.file = file;
    opened.push({ file, state: { state: options } });
  }
}
workspace.registerView("markdown", leaf => new LinkView(leaf));

async function run(): Promise<void> {
  const viewStateWorkspace = new Workspace(app);
  viewStateWorkspace.registerView("layout-smoke", leaf => new LayoutView(leaf));
  const viewStateLeaf = viewStateWorkspace.getLeaf(true), viewStateView = new LayoutView(viewStateLeaf);
  viewStateView.value = "View state title";
  await viewStateLeaf.open(viewStateView);
  assert.deepEqual(viewStateLeaf.getViewState(), { type: "layout-smoke", state: { value: "View state title" }, icon: "lucide-file", title: "View state title" }, "getViewState exposes the public view metadata without runtime active/pinned flags");
  viewStateLeaf.setPinned(true);
  assert.deepEqual(viewStateLeaf.getViewState(), { type: "layout-smoke", state: { value: "View state title" }, icon: "lucide-file", title: "View state title", pinned: true }, "getViewState includes pinned only when enabled");
  viewStateLeaf.detach();
  assert.equal(await viewStateWorkspace.reopenClosedLeaf(), true);
  const reopenedViewStateLeaf = viewStateWorkspace.activeLeaf!;
  assert.deepEqual(reopenedViewStateLeaf.getViewState(), { type: "layout-smoke", state: { value: "View state title" }, icon: "lucide-file", title: "View state title", pinned: true }, "closing and reopening a view retains its pinned state");

  const apiWorkspace = new Workspace(app);
  class ApiFileView extends FileView { getViewType(): string { return "api-file"; } }
  const apiFileLeaf = apiWorkspace.getLeaf(true), apiFileView = new ApiFileView(apiFileLeaf);
  apiFileView.file = file; await apiFileLeaf.open(apiFileView);
  const apiOtherLeaf = apiWorkspace.getLeaf(true), apiOtherView = new LayoutView(apiOtherLeaf);
  apiOtherView.navigation = true;
  await apiOtherLeaf.open(apiOtherView);
  const apiLeftA = apiWorkspace.getLeftLeaf(true)!, apiLeftB = apiWorkspace.getLeftLeaf(true)!;
  const apiRightA = apiWorkspace.getRightLeaf(true)!, apiRightB = apiWorkspace.getRightLeaf(true)!;
  const apiVisited: unknown[] = [];
  apiWorkspace.iterateAllLeaves(leaf => { apiVisited.push(leaf); return true; });
  assert.deepEqual(apiVisited, [apiFileLeaf, apiLeftA, apiRightA], "truthy callbacks stop within each region, then traversal continues with the next region");
  apiVisited.length = 0;
  apiWorkspace.iterateAllLeaves(leaf => { apiVisited.push(leaf); });
  assert.deepEqual(apiVisited, [apiFileLeaf, apiOtherLeaf, apiLeftA, apiLeftB, apiRightA, apiRightB], "traversal follows workspace tree order");
  apiWorkspace.setActiveLeaf(apiFileLeaf);
  assert.equal(apiWorkspace.getActiveFileView(), apiFileView, "an active FileView is returned");
  apiWorkspace.setActiveLeaf(apiOtherLeaf);
  assert.equal(apiWorkspace.getActiveFileView(), null, "an active navigable non-FileView blocks fallback");
  apiWorkspace.iterateAllLeaves(leaf => { leaf.activeTime = 0; });
  apiFileLeaf.activeTime = 10; apiOtherLeaf.activeTime = 20;
  apiLeftA.view.navigation = false;
  apiWorkspace.setActiveLeaf(apiLeftA);
  assert.equal(apiWorkspace.getActiveFileView(), null, "the most recent navigable non-FileView also blocks sidebar fallback");
  apiOtherView.navigation = false;
  assert.equal(apiWorkspace.getActiveFileView(), apiFileView, "a non-navigable sidebar falls back to the most recently active navigation view");
  apiWorkspace.activeEditor = { editor: new Editor(), file: linkFiles[0] };
  assert.equal(apiWorkspace.getActiveFile(), linkFiles[0], "an editor owner's file takes precedence over workspace navigation fallback");
  apiWorkspace.activeEditor = null;
  assert.equal(apiWorkspace.getActiveFile(), file, "clearing editor ownership restores navigation file context");
  const apiCleanup: typeof apiFileLeaf[] = []; apiWorkspace.iterateAllLeaves(leaf => { apiCleanup.push(leaf); }); apiCleanup.forEach(leaf => leaf.detach());
  const deletedFile = new TFile({} as Vault, "Notes/Deleted.md");
  const deletionApp = { ...app, vault: { getFileByPath: (path: string) => path === file.path ? file : null } } as unknown as App;
  const deletionWorkspace = new Workspace(deletionApp);
  class DeletionView extends FileView { getViewType(): string { return "deletion-smoke"; } }
  deletionWorkspace.registerView("deletion-smoke", leaf => new DeletionView(leaf));
  const historyLeaf = deletionWorkspace.getLeaf(true), historyView = new DeletionView(historyLeaf);
  historyView.file = deletedFile; await historyLeaf.open(historyView);
  historyLeaf.history.backHistory.push({ title: "Target", icon: "file", state: { type: "deletion-smoke", state: { file: file.path } }, eState: {} });
  await historyView.onDelete(deletedFile);
  assert.equal(deletionWorkspace.getActiveFile(), file, "deleting a file returns its pane to the previous history entry");
  const noHistoryLeaf = deletionWorkspace.getLeaf("tab"), noHistoryView = new DeletionView(noHistoryLeaf);
  noHistoryView.file = deletedFile; await noHistoryLeaf.open(noHistoryView);
  await noHistoryView.onDelete(deletedFile);
  assert.equal(noHistoryLeaf.parent, null, "a deleted file with no history closes its empty tab when another tab remains");
  const allowLeaf = deletionWorkspace.getLeaf("tab"), allowView = new DeletionView(allowLeaf);
  allowView.allowNoFile = true; allowView.file = deletedFile; await allowLeaf.open(allowView);
  await allowView.onDelete(deletedFile);
  assert.ok(allowLeaf.view === allowView && allowView.file === null, "allowNoFile views stay open without their deleted file");
  allowLeaf.detach();
  const remainingView = historyLeaf.view as DeletionView;
  historyLeaf.history.backHistory.splice(0); await remainingView.onDelete(file);
  assert.ok(historyLeaf.parent && historyLeaf.view.getViewType() === "empty", "the last document pane becomes empty after deletion without history");
  let typesJson = JSON.stringify({ types: { Priority: "number" }, preserved: true });
  const typeNotifications: unknown[] = [];
  const typeApp = { vault: { configDir: ".obsidian", adapter: { read: async () => typesJson, write: async (_path: string, data: string) => { await new Promise(resolve => setTimeout(resolve, 5)); typesJson = data; } } }, workspace: { trigger: (_event: string, data: unknown) => typeNotifications.push(data) } } as unknown as App;
  await Promise.all([assignPropertyType(typeApp, "priority", "text"), assignPropertyType(typeApp, "Due", "date")]);
  assert.deepEqual(await readPropertyTypes(typeApp), { Priority: "text", Due: "date" }, "overlapping property type changes preserve both assignments and the original name's casing");
  await Promise.all([assignPropertyType(typeApp, "__proto__", "text"), assignPropertyType(typeApp, "constructor", "checkbox")]);
  const ordinaryNamedTypes = await readPropertyTypes(typeApp);
  assert.equal(Object.hasOwn(ordinaryNamedTypes, "__proto__"), true, "prototype-named property types remain own stored entries");
  assert.equal(ordinaryNamedTypes["__proto__"], "text");
  assert.equal(ordinaryNamedTypes["constructor"], "checkbox");
  assert.equal(Object.getPrototypeOf(ordinaryNamedTypes), Object.prototype, "property names do not change the dictionary prototype");
  assert.equal(JSON.parse(typesJson).preserved, true, "type writes preserve unrelated configuration fields");
  assert.equal(typeNotifications.length, 4, "each committed type change updates live editors");
  await workspace.openLinkText("Target#Heading", "Notes/Source.md", "tab", { state: { mode: "preview" } });
  const firstLeaf = workspace.activeLeaf;
  assert.ok(firstLeaf);
  assert.equal(opened[0]!.file, file);
  assert.deepEqual(opened[0]!.state, { state: { mode: "preview" } });
  assert.equal(fileEvents.length, 1);
  assert.deepEqual(cursorCalls[0], { line: 4, ch: 2 });
  assert.equal((cursorCalls[1] as { center: boolean }).center, true);

  editor.setValue("changed");
  assert.equal(editorEvents.length, 1, "editor-change is sent for document changes");
  assert.equal(editorEvents[0]!.editor, editor);
  assert.equal(editorEvents[0]!.info, firstLeaf.view, "editor-change identifies the owning view");
  assert.equal((editorEvents[0]!.info as LinkView).file, file);
  editor.setCursor({ line: 0, ch: 0 });
  assert.equal(editorEvents.length, 1, "cursor movement does not emit editor-change");

  await workspace.openLinkText("Target", "Notes/Source.md", "tab", { active: false });
  assert.equal(workspace.activeLeaf, firstLeaf, "active:false restores the previously active leaf");
  assert.equal(fileEvents.length, 1, "reopening the same file does not emit duplicate file-open events");

  const focusedDock = workspace.getLeftLeaf(false)!;
  await focusedDock.setViewState({ type: "layout-smoke", state: { value: "Focused sidebar" } });
  assert.equal(focusedDock.getRoot(), workspace.leftSplit, "sidebar leaves expose their sidedock root");
  assert.equal(focusedDock.getContainer(), workspace.rootSplit, "sidebar leaves retain their window container");
  workspace.setActiveLeaf(firstLeaf);
  workspace.leftSplit.collapse();
  await workspace.revealLeaf(focusedDock);
  assert.equal(workspace.leftSplit.collapsed, false, "revealing a sidebar leaf expands its dock");
  assert.equal(workspace.activeLeaf, firstLeaf, "revealing a sidebar leaf preserves the active document context");
  workspace.setActiveLeaf(focusedDock);
  const restoredFocus = new Workspace(app);
  restoredFocus.registerView("markdown", leaf => new LinkView(leaf));
  restoredFocus.registerView("layout-smoke", leaf => new LayoutView(leaf));
  await restoredFocus.changeLayout(workspace.getLayout());
  assert.equal(restoredFocus.activeLeaf?.id, focusedDock.id, "restoration retains sidebar focus");
  assert.equal(restoredFocus.getActiveFile(), file, "a focused sidebar retains the restored document's file context");
  const restoredDocument = restoredFocus.getMostRecentLeaf()!;
  restoredFocus.setActiveLeaf(restoredDocument);
  await restoredDocument.setViewState({ type: "empty", state: {} });
  assert.equal(restoredFocus.getActiveFile(), null, "an active empty navigation view has no file, even with other file views available");
  restoredFocus.iterateAllLeaves(leaf => leaf.detach());

  const layoutWorkspace = new Workspace(app);
  layoutWorkspace.registerView("layout-smoke", (leaf) => new LayoutView(leaf));
  const layoutLeafA = layoutWorkspace.getLeaf(true);
  const layoutViewA = new LayoutView(layoutLeafA); layoutViewA.value = "first";
  await layoutLeafA.open(layoutViewA); layoutLeafA.setPinned(true);
  const layoutLeafB = layoutWorkspace.getLeaf("tab");
  const layoutViewB = new LayoutView(layoutLeafB); layoutViewB.value = "second";
  await layoutLeafB.open(layoutViewB);
  layoutLeafA.setGroup("paired"); layoutLeafB.setGroupMember(layoutLeafA);
  let failedViewClosed = 0;
  class FailingView extends LayoutView {
    getViewType(): string { return "failing-smoke"; }
    protected override onOpen(): void { throw new Error("expected open failure"); }
    protected override onClose(): void { failedViewClosed++; }
  }
  const previousView = layoutLeafB.view;
  await assert.rejects(layoutLeafB.open(new FailingView(layoutLeafB)), /expected open failure/);
  assert.equal(layoutLeafB.view, previousView, "failed view open keeps the existing pane view");
  assert.equal(failedViewClosed, 1, "failed view is cleaned up");
  const layoutLeafC = layoutWorkspace.createLeafBySplit(layoutLeafB, "horizontal");
  const layoutViewC = new LayoutView(layoutLeafC); layoutViewC.value = "third";
  await layoutLeafC.open(layoutViewC);
  const leftLeaf = layoutWorkspace.getLeftLeaf(false)!;
  const leftView = new LayoutView(leftLeaf); leftView.value = "left dock";
  await leftLeaf.open(leftView);
  layoutWorkspace.leftSplit!.collapse();
  layoutWorkspace.setActiveLeaf(layoutLeafC);
  const savedLayout = layoutWorkspace.getLayout();
  const serializedMain = savedLayout.main as { children: Array<{ type: string; children: Array<{ children: Array<{ id: string; state: { state?: { value?: string } }; pinned?: boolean; group?: string | null }>; currentTab: number }> }> };
  assert.equal(serializedMain.children[0]!.type, "split", "nested splits remain in the saved layout");
  const serializedTabs = serializedMain.children[0]!.children[0]!;
  assert.equal(serializedTabs.currentTab, 1);
  assert.deepEqual(serializedTabs.children.map((item) => item.state.state?.value), ["first", "second"]);
  assert.equal(serializedTabs.children[0]!.pinned, true);
  assert.equal(serializedTabs.children[0]!.group, "paired");
  const restored = new Workspace(app);
  restored.registerView("layout-smoke", (leaf) => new LayoutView(leaf));
  await restored.changeLayout(savedLayout);
  assert.equal(restored.activeLeaf?.id, layoutLeafC.id);
  assert.equal(restored.getLeafById(layoutLeafA.id)?.view.getDisplayText(), "first");
  assert.equal(restored.getLeafById(layoutLeafA.id)?.pinned, true);
  assert.equal(restored.getLeafById(layoutLeafA.id)?.group, "paired");
  const restoredMainSplit = restored.rootSplit.children.find((item) => item !== restored.leftSplit) as { children: Array<{ activeLeaf?: { id: string } }> };
  assert.equal(restoredMainSplit.children[0]!.activeLeaf?.id, layoutLeafB.id);
  assert.equal(restored.leftSplit?.collapsed, true, "collapsed side dock state is restored");
  assert.equal(restored.getLeavesOfType("layout-smoke").length, 4);
  const nextLeaf = restored.getLeaf(true);
  assert.ok(![layoutLeafA.id, layoutLeafB.id, layoutLeafC.id, leftLeaf.id].includes(nextLeaf.id), "restored IDs do not collide with newly created leaves");
  const beforeInvalidRestore = restored.getLayout();
  await assert.rejects(restored.changeLayout({ main: { type: "split", direction: "diagonal", children: [] } }));
  assert.deepEqual(restored.getLayout(), beforeInvalidRestore, "invalid layout leaves the current tree intact");
  const unavailableLeaf = restored.getLeaf("tab");
  await unavailableLeaf.setViewState({ type: "disabled-plugin", state: { value: "preserved" } });
  assert.equal(unavailableLeaf.view.getViewType(), "disabled-plugin");
  assert.deepEqual(unavailableLeaf.view.getState(), { value: "preserved" }, "unavailable views preserve plugin state without a DOM");
  const unavailableLayout = restored.getLayout();
  const restoredUnavailable = new Workspace(app);
  restoredUnavailable.registerView("layout-smoke", leaf => new LayoutView(leaf));
  await restoredUnavailable.changeLayout(unavailableLayout);
  assert.deepEqual(restoredUnavailable.getLeafById(unavailableLeaf.id)?.view.getState(), { value: "preserved" }, "unavailable views survive layout restoration");
  restoredUnavailable.iterateAllLeaves(item => item.detach());

  let deferredOpens = 0;
  class DeferredPluginSmokeView extends View {
    value = "";
    getViewType(): string { return "deferred-plugin-smoke"; }
    getDisplayText(): string { return "Deferred plugin"; }
    override async onOpen(): Promise<void> { deferredOpens++; }
    override getState(): Record<string, unknown> { return { value: this.value }; }
    override async setState(state: unknown): Promise<void> { this.value = String((state as { value?: unknown }).value ?? ""); }
  }
  const deferredWorkspace = new Workspace(app);
  deferredWorkspace.registerView("layout-smoke", leaf => new LayoutView(leaf));
  deferredWorkspace.registerPluginView("deferred-plugin-smoke", leaf => new DeferredPluginSmokeView(leaf));
  const restoring = deferredWorkspace as unknown as { restoringLayout: boolean };
  restoring.restoringLayout = true;
  const deferredLayout = {
    main: { type: "split", direction: "vertical", id: "deferred-root", children: [{
      type: "tabs", id: "deferred-tabs", currentTab: 0, children: [
        { type: "leaf", id: "deferred-active", state: { type: "layout-smoke", state: { value: "active" } } },
        { type: "leaf", id: "deferred-plugin", state: { type: "deferred-plugin-smoke", state: { value: "saved" }, icon: "lucide-ghost", title: "deferred-plugin-smoke" } },
      ],
    }] }, active: "deferred-active", lastOpenFiles: [],
  };
  await deferredWorkspace.changeLayout(deferredLayout);
  restoring.restoringLayout = false;
  const deferredLeaf = deferredWorkspace.getLeafById("deferred-plugin")!;
  assert.equal(deferredLeaf.isDeferred, true, "an inactive plugin view restored at startup is deferred");
  assert.deepEqual(deferredLeaf.getViewState(), { type: "deferred-plugin-smoke", state: { value: "saved" }, icon: "lucide-ghost", title: "deferred-plugin-smoke" }, "deferred view state and placeholder metadata remain visible before loading");
  assert.equal(deferredOpens, 0, "deferred plugin onOpen waits until the pane is loaded");
  await deferredLeaf.loadIfDeferred();
  assert.equal(deferredLeaf.isDeferred, false, "loadIfDeferred replaces the deferred placeholder");
  assert.equal(deferredOpens, 1, "loadIfDeferred calls the plugin view onOpen once");
  assert.deepEqual(deferredLeaf.view.getState(), { value: "saved" }, "deferred plugin state is applied after onOpen");

  const activationWorkspace = new Workspace(app);
  activationWorkspace.registerView("layout-smoke", leaf => new LayoutView(leaf));
  activationWorkspace.registerPluginView("deferred-plugin-smoke", leaf => new DeferredPluginSmokeView(leaf));
  (activationWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = true;
  await activationWorkspace.changeLayout(deferredLayout);
  (activationWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = false;
  const activationLeaf = activationWorkspace.getLeafById("deferred-plugin")!;
  activationWorkspace.setActiveLeaf(activationLeaf);
  for (let attempt = 0; activationLeaf.isDeferred && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(activationLeaf.isDeferred, false, "selecting a deferred tab materializes the plugin view");
  assert.equal(deferredOpens, 2, "tab selection opens a deferred plugin view once");

  const warmLayout = structuredClone(deferredLayout) as typeof deferredLayout;
  warmLayout.main.children[0]!.children[1]!.state.icon = "lucide-file";
  warmLayout.main.children[0]!.children[1]!.state.title = "Deferred plugin";
  const warmWorkspace = new Workspace(app);
  warmWorkspace.registerView("layout-smoke", leaf => new LayoutView(leaf));
  warmWorkspace.registerPluginView("deferred-plugin-smoke", leaf => new DeferredPluginSmokeView(leaf));
  (warmWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = true;
  await warmWorkspace.changeLayout(warmLayout);
  (warmWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = false;
  const warmLeaf = warmWorkspace.getLeafById("deferred-plugin")!;
  assert.equal(warmLeaf.isDeferred, true, "an inactive plugin view remains deferred after warm layout restoration");
  assert.equal(deferredOpens, 2, "warm layout restoration does not open an inactive plugin view");
  await warmLeaf.loadIfDeferred();
  assert.equal(warmLeaf.isDeferred, false, "a warm deferred view can be materialized explicitly");
  assert.equal(deferredOpens, 3, "explicitly loading a warm deferred view opens the plugin once");

  const lateRegistrationWorkspace = new Workspace(app);
  lateRegistrationWorkspace.registerView("layout-smoke", leaf => new LayoutView(leaf));
  (lateRegistrationWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = true;
  await lateRegistrationWorkspace.changeLayout(deferredLayout);
  (lateRegistrationWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = false;
  lateRegistrationWorkspace.registerPluginView("deferred-plugin-smoke", leaf => new DeferredPluginSmokeView(leaf));
  const lateDeferredLeaf = lateRegistrationWorkspace.getLeafById("deferred-plugin")!;
  for (let attempt = 0; attempt < 20 && !lateDeferredLeaf.isDeferred; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(lateDeferredLeaf.isDeferred, true, "late plugin registration keeps an inactive restored pane deferred");
  assert.equal(deferredOpens, 3, "late registration does not open an inactive plugin pane");
  await lateDeferredLeaf.loadIfDeferred();
  assert.equal(deferredOpens, 4, "late-registered pane opens when explicitly loaded");

  const activeLateLayout = structuredClone(deferredLayout) as typeof deferredLayout;
  activeLateLayout.active = "deferred-plugin";
  const activeLateWorkspace = new Workspace(app);
  activeLateWorkspace.registerView("layout-smoke", leaf => new LayoutView(leaf));
  (activeLateWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = true;
  await activeLateWorkspace.changeLayout(activeLateLayout);
  (activeLateWorkspace as unknown as { restoringLayout: boolean }).restoringLayout = false;
  activeLateWorkspace.registerPluginView("deferred-plugin-smoke", leaf => new DeferredPluginSmokeView(leaf));
  const activeLateLeaf = activeLateWorkspace.getLeafById("deferred-plugin")!;
  for (let attempt = 0; attempt < 20 && deferredOpens < 5; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(activeLateLeaf.isDeferred, false, "late registration materializes an active restored plugin pane");
  assert.equal(deferredOpens, 5, "late registration opens the active pane once");

    activationWorkspace.iterateAllLeaves(item => item.detach());
    warmWorkspace.iterateAllLeaves(item => item.detach());
    deferredWorkspace.iterateAllLeaves(item => item.detach());
    lateRegistrationWorkspace.iterateAllLeaves(item => item.detach());
    activeLateWorkspace.iterateAllLeaves(item => item.detach());

  restored.iterateAllLeaves((item) => item.detach());
  layoutWorkspace.iterateAllLeaves((item) => item.detach());
  console.log("Workspace.openLinkText smoke passed");
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
