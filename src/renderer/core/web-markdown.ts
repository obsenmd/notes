import TurndownService from "turndown";

const converter = new TurndownService({ headingStyle: "atx", hr: "---", bulletListMarker: "-", codeBlockStyle: "fenced", fence: "```", linkStyle: "inlined" });
converter.remove(["script", "style", "title"]);
converter.escape = text => text;
const attribute = (value: string | null) => value ? value.replace(/(\n+\s*)+/g, "\n") : "";
const destination = (value: string) => value.replace(/ /g, "%20").replace(/[()]/g, "\\$&");
const titleAttribute = (node: HTMLElement) => { const value = attribute(node.getAttribute("title")); return value ? ' "' + value.replace(/"/g, '\\"') + '"' : ""; };
converter.addRule("strikethrough", { filter: ["del", "s"], replacement: content => "~~" + content + "~~" });
converter.addRule("highlight", { filter: "mark", replacement: content => "==" + content + "==" });
converter.addRule("inlineLink", {
  filter: node => node.nodeName === "A" && node.hasAttribute("href"),
  replacement: (content, node) => `[${content}](${destination(attribute(node.getAttribute("href")))}${titleAttribute(node)})`,
});
converter.addRule("image", {
  filter: "img",
  replacement: (_content, node) => { const src = attribute(node.getAttribute("src")); return src ? `![${attribute(node.getAttribute("alt"))}](${destination(src)}${titleAttribute(node)})` : ""; },
});
converter.addRule("highlightedCodeBlock", {
  filter: node => node.nodeName === "DIV" && /highlight-(?:text|source)-([a-z0-9]+)/.test(node.className) && node.firstChild?.nodeName === "PRE",
  replacement: (_content, node, options) => `\n\n${options.fence}${/highlight-(?:text|source)-([a-z0-9]+)/.exec(node.className)?.[1] ?? ""}\n${node.firstChild?.textContent ?? ""}\n${options.fence}\n\n`,
});
converter.addRule("listItem", {
  filter: "li",
  replacement: (content, node, options) => {
    content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/g, "\n    ");
    let prefix = options.bulletListMarker + " ";
    const parent = node.parentNode as HTMLElement;
    if (parent.nodeName === "OL") { const start = parent.getAttribute("start"), index = Array.prototype.indexOf.call(parent.children, node); prefix = (start ? Number(start) + index : index + 1) + ". "; }
    return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
  },
});
converter.addRule("taskListItem", {
  filter: node => node.nodeName === "INPUT" && node.getAttribute("type") === "checkbox" && node.parentNode?.nodeName === "LI",
  replacement: (_content, node) => (node as HTMLInputElement).checked ? "[x] " : "[ ] ",
});
const extraColumns = (node: HTMLElement) => Math.max(0, parseInt(node.getAttribute("colspan") ?? "", 10) - 1) || 0;
function headingRow(row: Node): boolean {
  const parent = row.parentNode;
  if (!parent) return false;
  if (parent.nodeName === "THEAD") return true;
  return parent.firstChild === row && (parent.nodeName === "TABLE" || parent.nodeName === "TBODY" && (!parent.previousSibling || parent.previousSibling.nodeName === "THEAD" && !parent.previousSibling.textContent?.trim())) && Array.from(row.childNodes).every(cell => cell.nodeName === "TH");
}
converter.addRule("tableCell", {
  filter: ["th", "td"],
  replacement: (content, node) => (node.parentNode?.firstChild === node ? "|" : "") + content.trim().replace(/\|+/g, "\\|").replace(/\n\r?/g, "<br>") + "|" + "   |".repeat(extraColumns(node)),
});
converter.addRule("tableRow", {
  filter: "tr",
  replacement: (content, node) => {
    let border = "";
    if (headingRow(node)) Array.from(node.children).forEach((cell, index) => {
      const align = cell.getAttribute("align")?.toLowerCase(), separator = align === "left" ? ":--" : align === "right" ? "--:" : align === "center" ? ":-:" : "---";
      border += (index === 0 ? "|" : "") + (separator + "|").repeat(1 + extraColumns(cell as HTMLElement));
    });
    return "\n" + content + (border ? "\n" + border : "");
  },
});
converter.addRule("table", {
  filter: "table",
  replacement: (content, node) => {
    const first = node.querySelector("tr");
    if (first && !headingRow(first)) {
      const width = Array.from(first.children).reduce((sum, cell) => sum + 1 + extraColumns(cell as HTMLElement), 0);
      content = "|" + "   |".repeat(width) + "\n|" + "---|".repeat(width) + "\n" + content.replace(/^[\r\n]+/, "");
    }
    return "\n\n" + content.replace(/[\r\n]+/g, "\n") + "\n\n";
  },
});
converter.addRule("tableSections", { filter: ["thead", "tbody", "tfoot"], replacement: content => content });

/** Shared by reader mode and the plugin API, using the pinned reference's conversion rules. */
export function htmlToMarkdown(html: string | TurndownService.Node): string { return converter.turndown(html); }
