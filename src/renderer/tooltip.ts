const DEFAULT_GAP = 8;
const ARROW_SIZE = 5;
const DEFAULT_DELAY = 1000;
/** A tooltip shown shortly after another one closes appears without delay. */
const GRACE = 100;

let tooltip: HTMLElement | null = null;
let owner: HTMLElement | null = null;
let showTimer: number | null = null;
let hideTimer: number | null = null;
let lastHidden = 0;

function clearShowTimer() { if (showTimer !== null) { window.clearTimeout(showTimer); showTimer = null; } }
function clearHideTimer() { if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; } }

export function hideTooltip(): void {
  clearShowTimer(); clearHideTimer();
  if (!tooltip) return;
  lastHidden = Date.now();
  tooltip.remove(); tooltip = null; owner = null;
}

function scheduleHide() {
  clearShowTimer();
  if (tooltip && hideTimer === null) { owner = null; hideTimer = window.setTimeout(hideTooltip, GRACE); }
}

export interface TooltipPlacement { placement?: string; classes?: string[]; delay?: number; gap?: number }

export function displayTooltip(element: HTMLElement, text: string, options: TooltipPlacement = {}): void {
  if (!text) return;
  const { placement = "bottom", gap = DEFAULT_GAP, delay = 0 } = options;
  const classes = [...(options.classes ?? [])];
  if (delay > 0 && !tooltip && Date.now() > lastHidden + GRACE) {
    clearShowTimer();
    showTimer = window.setTimeout(() => displayTooltip(element, text, { ...options, delay: 0 }), delay);
    return;
  }
  if (!element.isConnected || !element.getClientRects().length) return;
  const doc = element.ownerDocument;
  const { top, left, width, height } = element.getBoundingClientRect();
  clearHideTimer();
  if (tooltip && owner === element) tooltip.textContent = text;
  else { hideTooltip(); tooltip = doc.createElement("div"); tooltip.className = "tooltip"; tooltip.textContent = text; }
  const arrow = doc.createElement("div"); arrow.className = "tooltip-arrow"; tooltip.append(arrow);
  let y = 0, x = 0;
  if (placement === "bottom") { y = top + height + gap; x = left + width / 2; }
  else if (placement === "right") { y = top + height / 2; x = left + width + gap; classes.push("mod-right"); }
  else if (placement === "left") { y = top + height / 2; x = left - gap; classes.push("mod-left"); }
  else if (placement === "top") { y = top - gap - ARROW_SIZE; x = left + width / 2; classes.push("mod-top"); }
  tooltip.classList.add(...classes.filter(Boolean));
  Object.assign(tooltip.style, { top: "0px", left: "0px", width: "", height: "" });
  if (!tooltip.parentNode) doc.body.append(tooltip);
  const box = tooltip.getBoundingClientRect();
  const vertical = placement === "top" || placement === "bottom";
  const halfWidth = vertical ? box.width / 2 : box.width;
  const halfHeight = vertical ? box.height : box.height / 2;
  if (placement === "left") x -= halfWidth; else if (placement === "top") y -= halfHeight;
  const viewportHeight = doc.body.clientHeight, viewportWidth = doc.body.clientWidth;
  if (y + halfHeight > viewportHeight) y = viewportHeight - halfHeight - gap;
  y = Math.max(y, gap);
  if (vertical) {
    if (x + halfWidth > viewportWidth) {
      const shift = x + halfWidth + gap - viewportWidth; x -= shift;
      arrow.style.left = "initial"; arrow.style.right = `${halfWidth - shift - gap / 2}px`;
    } else if (x - gap - halfWidth < 0) {
      const shift = -(x - gap - halfWidth); x += shift;
      arrow.style.right = "initial"; arrow.style.left = `${halfWidth - shift - gap / 2}px`;
    }
    x = Math.max(x, gap);
  }
  Object.assign(tooltip.style, { top: `${y}px`, left: `${x}px`, width: `${box.width}px`, height: `${box.height}px` });
  owner = element;
}

function showFor(element: HTMLElement) {
  clearShowTimer();
  const text = element.getAttribute("aria-label") || "";
  const parsedDelay = parseInt(element.getAttribute("data-tooltip-delay") || "", 10);
  const parsedGap = parseFloat(element.getAttribute("data-tooltip-gap") || "");
  displayTooltip(element, text, {
    placement: element.getAttribute("data-tooltip-position") || "bottom",
    classes: (element.getAttribute("data-tooltip-classes") || "").split(" "),
    delay: Number.isNaN(parsedDelay) ? DEFAULT_DELAY : parsedDelay,
    gap: Number.isNaN(parsedGap) ? undefined : parsedGap,
  });
}

/** Shows a tooltip for any hovered element carrying a non-empty `aria-label`. */
export function installTooltips(doc: Document = document): () => void {
  const labelled = (event: Event) => (event.target as Element | null)?.closest?.<HTMLElement>("[aria-label]") ?? null;
  const over = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const element = labelled(event);
    if (!element || element.contains(event.relatedTarget as Node | null)) return;
    if (getComputedStyle(element).getPropertyValue("--no-tooltip").trim() !== "true") showFor(element);
  };
  const out = (event: PointerEvent) => {
    const element = labelled(event);
    if (element && !element.contains(event.relatedTarget as Node | null)) scheduleHide();
  };
  doc.body.addEventListener("pointerover", over);
  doc.body.addEventListener("pointerout", out);
  doc.body.addEventListener("pointerup", hideTooltip);
  return () => {
    doc.body.removeEventListener("pointerover", over);
    doc.body.removeEventListener("pointerout", out);
    doc.body.removeEventListener("pointerup", hideTooltip);
    hideTooltip();
  };
}
