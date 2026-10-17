import { BrowserImage } from "./native-image";
import type { Electron } from "./types";

export async function capturePage(rect?: Electron.Rectangle): Promise<BrowserImage> {
  const { toCanvas } = await import("html-to-image");
  const rendered = await toCanvas(document.body, { pixelRatio: devicePixelRatio, cacheBust: true });
  if (!rect) return new BrowserImage(new Uint8Array(await (await fetch(rendered.toDataURL("image/png"))).arrayBuffer()));
  const crop = document.createElement("canvas"); crop.width = Math.max(1, Math.round(rect.width * devicePixelRatio)); crop.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
  crop.getContext("2d")!.drawImage(rendered, Math.round(rect.x * devicePixelRatio), Math.round(rect.y * devicePixelRatio), crop.width, crop.height, 0, 0, crop.width, crop.height);
  return new BrowserImage(new Uint8Array(await (await fetch(crop.toDataURL("image/png"))).arrayBuffer()));
}
export async function printToPDF(): Promise<Uint8Array> {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
  const content = document.querySelector<HTMLElement>(".workspace-leaf.mod-active .markdown-preview-view, .workspace-leaf.mod-active .view-content") ?? document.body;
  const rendered = await toCanvas(content, { pixelRatio: 2, width: content.scrollWidth, height: content.scrollHeight, backgroundColor: "#ffffff", style: { height: `${content.scrollHeight}px`, overflow: "visible" } });
  const pdf = new jsPDF({ unit: "mm", format: "a4" }), margin = 12, width = 210 - margin * 2, pageHeight = 297 - margin * 2;
  const pixelsPerPage = Math.floor(pageHeight * rendered.width / width);
  for (let y = 0, index = 0; y < rendered.height; y += pixelsPerPage, index++) {
    if (index) pdf.addPage();
    const canvas = document.createElement("canvas"); canvas.width = rendered.width; canvas.height = Math.min(pixelsPerPage, rendered.height - y);
    canvas.getContext("2d")!.drawImage(rendered, 0, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin, margin, width, canvas.height * width / rendered.width);
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}
