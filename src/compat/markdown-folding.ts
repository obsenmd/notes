const hiddenBlocks = new WeakMap<Element, Element[]>();

export function setHeadingFold(indicator: HTMLElement, collapsed: boolean): void {
    const heading = indicator.parentElement;
    const block = heading?.parentElement;
    if (!heading || !block || block.classList.contains("is-collapsed") === collapsed) return;
    if (collapsed) {
      const folded: Element[] = [];
      const level = Number(heading.tagName.slice(1));
      let next = block.nextElementSibling;
      while (next && !next.classList.contains("mod-ui")) {
        const other = next.querySelector(":scope > :is(h1,h2,h3,h4,h5,h6)");
        if (other && Number(other.tagName.slice(1)) <= level) break;
        const following = next.nextElementSibling;
        folded.push(next); next.remove(); next = following;
      }
      hiddenBlocks.set(block, folded);
    } else {
      block.after(...(hiddenBlocks.get(block) ?? [])); hiddenBlocks.delete(block);
    }
    block.classList.toggle("is-collapsed", collapsed);
    indicator.classList.toggle("is-collapsed", collapsed);
}

/** Fold controls stay attached to their blocks when a rendered fragment is adopted. */
export function attachHeadingFold(indicator: HTMLElement): void {
  indicator.addEventListener("click", event => {
    const view = indicator.closest(".markdown-preview-view");
    if (!view?.classList.contains("allow-fold-headings")) return;
    event.preventDefault(); event.stopPropagation();
    setHeadingFold(indicator, !indicator.parentElement?.parentElement?.classList.contains("is-collapsed"));
    indicator.dispatchEvent(new (indicator.ownerDocument.defaultView!.Event)("markdown-fold-change", {bubbles: true}));
  });
}

export function setListFold(indicator: HTMLElement, collapsed: boolean): void {
  indicator.parentElement?.classList.toggle("is-collapsed", collapsed);
  indicator.classList.toggle("is-collapsed", collapsed);
}

export function attachListFold(indicator: HTMLElement): void {
  indicator.addEventListener("click", event => {
    const view = indicator.closest(".markdown-preview-view");
    const item = indicator.parentElement;
    if (!view?.classList.contains("allow-fold-lists") || !item) return;
    event.preventDefault(); event.stopPropagation();
    const collapsed = !item.classList.contains("is-collapsed");
    setListFold(indicator, collapsed);
    indicator.dispatchEvent(new (indicator.ownerDocument.defaultView!.Event)("markdown-fold-change", {bubbles: true}));
  });
}
