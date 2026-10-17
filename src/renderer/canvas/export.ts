import { originalFs as fs, getElectron, process } from "../../../platforms/platform";
import { Modal, Notice } from "../../compat/ui";
import { t } from "../../i18n";
import type { CanvasController } from "./controller";
import { button, div, dropdown, el, settingRow, slider, toggle } from "./dom";
import { bboxOf, growBBox, unionBBox } from "./geometry";

interface Remote {
  getCurrentWebContents(): { getZoomLevel(): number; capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<{ toPNG(): Uint8Array }> };
  dialog: { showSaveDialog(options: unknown): Promise<{ canceled: boolean; filePath?: string }> };
  shell?: { showItemInFolder(path: string): void };
}
const remote = () => (getElectron() as { remote?: Remote }).remote ?? null;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const nextFrame = (win: Window) => new Promise(resolve => win.requestAnimationFrame(resolve));
const isMac = typeof process !== "undefined" && process.platform === "darwin";

interface ExportChoice { frame: "full" | "viewport"; zoom: number; logo: boolean; privacy: boolean }
/** The "Export as image" dialog; resolves null when it is dismissed. */
function askOptions(ctl: CanvasController, title: string, width: number, height: number, pixelRatio: number, maxScale: number): Promise<ExportChoice | null> {
  return new Promise(resolve => {
    const choice: ExportChoice = { frame: "full", zoom: Math.min(1, maxScale), logo: true, privacy: false };
    let saved = false;
    const modal = new Modal(ctl.app);
    modal.setTitle(t("plugins.canvas.action-export-png")); modal.modalEl.classList.add("mod-narrow");
    const content = modal.contentEl;
    el("p", "u-muted", t("plugins.canvas.label-export-png-desc", { title }), content);
    const frame = settingRow(content, t("plugins.canvas.option-export-png-frame"), t("plugins.canvas.option-export-png-frame-desc"));
    const zoom = settingRow(content, t("plugins.canvas.option-export-png-zoom"));
    const describe = () => { zoom.descEl.textContent = t("plugins.canvas.label-export-png-dimensions", { dimensions: `${Math.ceil(width * choice.zoom * pixelRatio).toLocaleString()}px x ${Math.ceil(height * choice.zoom * pixelRatio).toLocaleString()}px` }); };
    const top = Math.log2(maxScale);
    slider(zoom.controlEl, Math.min(-1, top), top, "any", Math.log2(choice.zoom), value => Math.pow(2, value).toFixed(2), value => { choice.zoom = Math.pow(2, value); describe(); });
    describe();
    const logo = settingRow(content, t("plugins.canvas.option-export-png-show-logo"), t("plugins.canvas.option-export-png-show-logo-desc"), "mod-toggle");
    toggle(logo.controlEl, choice.logo, value => { choice.logo = value; });
    dropdown(frame.controlEl, [["full", t("plugins.canvas.option-export-png-frame-full")], ["viewport", t("plugins.canvas.option-export-png-frame-viewport")]], choice.frame, value => {
      choice.frame = value as ExportChoice["frame"]; zoom.setVisible(value === "full"); logo.setVisible(value === "full");
    });
    const privacy = settingRow(content, t("plugins.canvas.option-export-png-privacy-mode"), t("plugins.canvas.option-export-png-privacy-mode-desc"), "mod-toggle");
    toggle(privacy.controlEl, choice.privacy, value => { choice.privacy = value; });
    button(div("modal-button-container", content), t("dialogue.button-save"), "mod-cta", () => { saved = true; modal.close(); });
    modal.setCloseCallback(() => resolve(saved ? choice : null));
    modal.open();
  });
}

function reportSaved(path: string): void {
  new Notice(path, 10000).addButton(t(isMac ? "plugins.open-with-default-app.action-show-in-folder-mac" : "plugins.open-with-default-app.action-show-in-folder"), () => (getElectron() as { shell: { showItemInFolder(path: string): void } }).shell.showItemInFolder(path));
}

/** "Export as image": the visible viewport as it is, or the whole canvas rendered tile by tile at the chosen zoom. */
export async function exportCanvasImage(ctl: CanvasController, title: string): Promise<void> {
  const wrapper = ctl.wrapperEl, electron = remote();
  if (!wrapper || !electron) return;
  if (!ctl.doc.nodes.size) { new Notice(t("plugins.canvas.msg-export-failed-empty-canvas")); return; }
  const win = wrapper.ownerDocument.defaultView ?? window, doc = wrapper.ownerDocument, contents = electron.getCurrentWebContents();
  const zoomFactor = Math.pow(1.2, contents.getZoomLevel()), pixelRatio = Math.round(win.devicePixelRatio / zoomFactor * 1e5) / 1e5;
  const bounds = growBBox(unionBBox([...ctl.doc.nodes.values()].map(bboxOf)), 100);
  const width = bounds.maxX - bounds.minX;
  let height = bounds.maxY - bounds.minY;
  const choice = await askOptions(ctl, title, width, height, pixelRatio, Math.min(2, 16284 / pixelRatio / width, 16284 / pixelRatio / height));
  if (!choice) return;
  const target = await electron.dialog.showSaveDialog({ defaultPath: title + ".png", filters: [{ name: t("obsen.canvas.png-files"), extensions: ["png"] }, { name: t("obsen.canvas.all-files"), extensions: ["*"] }], properties: ["showOverwriteConfirmation"] });
  if (target.canceled || !target.filePath) return;
  const filePath = target.filePath, statusBar = doc.querySelector<HTMLElement>(".status-bar");
  ctl.deselectAll();
  if (choice.frame === "viewport") {
    try {
      ctl.screenshotting = true; ctl.garbled = choice.privacy; ctl.host.render();
      if (statusBar) statusBar.style.display = "none";
      await sleep(10); await nextFrame(win);
      const content = unionBBox([...ctl.doc.nodes.values()].map(bboxOf)), a = ctl.domFromPos({ x: content.minX, y: content.minY }), b = ctl.domFromPos({ x: content.maxX, y: content.maxY }), box = wrapper.getBoundingClientRect();
      const left = Math.max(a.x + ctl.rect.cx - 10, box.x), top = Math.max(a.y + ctl.rect.cy - 10, box.y), right = Math.min(b.x + ctl.rect.cx + 10, box.right), bottom = Math.min(b.y + ctl.rect.cy + 10, box.bottom);
      const image = await contents.capturePage({ x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) });
      await fs.promises.writeFile(filePath, image.toPNG());
      reportSaved(filePath);
    } finally {
      if (statusBar) statusBar.style.display = "";
      ctl.screenshotting = false; ctl.garbled = false; ctl.host.render();
    }
    return;
  }
  const parent = wrapper.parentElement!, before = wrapper.nextSibling, zoom = choice.zoom;
  let url = "";
  try {
    if (choice.logo) { bounds.maxY += 80; height += 80; ctl.watermark = { x: bounds.minX + 80, y: bounds.maxY - 80, scale: 4 / zoom }; }
    ctl.screenshotting = true; ctl.garbled = choice.privacy; ctl.host.render();
    const inset = `${5 / zoomFactor}px`;
    doc.body.appendChild(wrapper);
    Object.assign(wrapper.style, { top: inset, left: inset, bottom: inset, right: inset, width: "auto", height: "auto" });
    ctl.onResize();
    const box = wrapper.getBoundingClientRect();
    const tile = { x: Math.ceil(box.x * zoomFactor + 1), y: Math.ceil(box.y * zoomFactor + 1), width: Math.floor(box.width * zoomFactor) - 2, height: Math.floor(box.height * zoomFactor) - 2 };
    const stepX = tile.width / zoom, stepY = tile.height / zoom, columns = Math.ceil(width / stepX), rows = Math.ceil(height / stepY);
    const output = doc.createElement("canvas"); output.width = Math.ceil(width * zoom * pixelRatio); output.height = Math.ceil(height * zoom * pixelRatio);
    const context = output.getContext("2d")!;
    ctl.setViewport(bounds.minX + stepX / 2, bounds.minY + stepY / 2, Math.log2(zoom / zoomFactor));
    await sleep(500);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      ctl.setViewport(bounds.minX + stepX / 2 + column * stepX, bounds.minY + stepY / 2 + row * stepY, Math.log2(zoom / zoomFactor));
      await sleep(100); await nextFrame(win);
      if (win.requestIdleCallback) await new Promise(resolve => win.requestIdleCallback(resolve));
      const image = doc.createElement("img");
      url = URL.createObjectURL(new Blob([(await contents.capturePage(tile)).toPNG() as BlobPart], { type: "image/png" }));
      image.src = url;
      await new Promise((resolve, reject) => { image.addEventListener("load", resolve); image.addEventListener("error", reject); });
      context.drawImage(image, column * tile.width * pixelRatio, row * tile.height * pixelRatio);
      URL.revokeObjectURL(url); url = "";
    }
    const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, "image/png"));
    if (blob) { await fs.promises.writeFile(filePath, new Uint8Array(await blob.arrayBuffer())); reportSaved(filePath); }
  } finally {
    if (before && before.parentNode === parent) parent.insertBefore(wrapper, before); else parent.appendChild(wrapper);
    Object.assign(wrapper.style, { top: "", left: "", bottom: "", right: "", width: "", height: "" });
    ctl.watermark = null; ctl.screenshotting = false; ctl.garbled = false;
    if (url) URL.revokeObjectURL(url);
    await nextFrame(win);
    // The reference does not return to the previous framing: it fits the canvas again.
    ctl.queueZoomToFit(); ctl.host.render();
  }
}
