import MarkdownIt from "markdown-it";
import { sanitizeHTMLToDom } from "./dom";
import { setIcon } from "./utilities";
import { highlightColor } from "./highlight";
import { renderMathInto } from "./math";
import { finishReadingView, type MermaidHost } from "./mermaid";
import type { MarkdownSectionInformation } from "./markdown";
import { attachHeadingFold, attachListFold } from "./markdown-folding";
import { t } from "../i18n";

const parser = new MarkdownIt({ html: true, linkify: true, breaks: false });
// Markdown-it's fence renderer ignores token attributes. Keep the source range on
// the pre element so processors can write edits back to the original Markdown.
const renderFence = parser.renderer.rules.fence!;
parser.renderer.rules.fence = (tokens, index, options, env, renderer) =>
  renderFence(tokens, index, options, env, renderer).replace("<pre>", `<pre${renderer.renderAttrs(tokens[index])}>`);
parser.inline.ruler.before("link", "vault-link", (state, silent) => {
  const match = state.src.slice(state.pos).match(/^(!?)\[\[([^\]\n]+)\]\]/);
  if (!match) return false;
  if (!silent) {
    const token = state.push("vault-link", "", 0);
    const separator = match[2].indexOf("|");
    token.meta = { embed: Boolean(match[1]), target: separator < 0 ? match[2] : match[2].slice(0, separator), label: separator < 0 ? match[2].split("#").filter(Boolean).join(" > ") : match[2].slice(separator + 1) };
  }
  state.pos += match[0].length; return true;
});
parser.renderer.rules["vault-link"] = (tokens, index) => {
  const { embed, target, label } = tokens[index].meta as { embed: boolean; target: string; label: string };
  return `<a data-internal-link="${parser.utils.escapeHtml(target)}"${embed ? ' data-embed="true"' : ""}>${parser.utils.escapeHtml(label)}</a>`;
};
parser.inline.ruler.before("emphasis", "highlight", (state, silent) => {
  if (state.src.slice(state.pos, state.pos + 2) !== "==") return false;
  const end = state.src.indexOf("==", state.pos + 2);
  if (end < 0) return false;
  if (!silent) {
    // A leading colour emoji selects the highlight colour and is not part of the text.
    const content = state.src.slice(state.pos + 2, end), { color, length } = highlightColor(content);
    state.push("mark_open", "mark", 1).attrSet("data-highlight", color);
    const text = state.push("text", "", 0); text.content = content.slice(length);
    state.push("mark_close", "mark", -1);
  }
  state.pos = end + 2; return true;
});
parser.inline.ruler.before("text", "hashtag", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 35 || (state.pos > 0 && !/\s/.test(state.src[state.pos - 1]))) return false;
  const match = /^#[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/.exec(state.src.slice(state.pos));
  if (!match || /^#\d+$/.test(match[0])) return false;
  if (!silent) { const token = state.push("hashtag", "a", 0); token.content = match[0]; }
  state.pos += match[0].length; return true;
});
parser.renderer.rules.hashtag = (tokens, index) => {
  const tag = parser.utils.escapeHtml(tokens[index].content);
  return `<a href="${tag}" class="tag" target="_blank" rel="noopener nofollow">${tag}</a>`;
};
// Text is tokenized up to the next special character; make "#" one so tags are found mid-paragraph.
const defaultText = parser.inline.ruler.getRules("").find(rule => rule.name === "text");
parser.inline.ruler.at("text", (state, silent) => {
  let pos = state.pos;
  const isTerminator = (code: number) => code === 35 || [10, 33, 36, 37, 38, 42, 43, 45, 58, 60, 61, 62, 64, 91, 92, 93, 94, 95, 96, 123, 125, 126].includes(code);
  while (pos < state.posMax && !isTerminator(state.src.charCodeAt(pos))) pos++;
  if (pos === state.pos) return false;
  if (!silent) state.pending += state.src.slice(state.pos, pos);
  state.pos = pos; return true;
});
void defaultText;
parser.inline.ruler.before("text", "comment", (state) => {
  if (state.src.slice(state.pos, state.pos + 2) !== "%%") return false;
  const end = state.src.indexOf("%%", state.pos + 2);
  if (end < 0) return false;
  state.pos = end + 2; return true;
});
const isBlank = (code: number) => code === 32 || code === 9;
// Inline TeX: `$…$`, and `$$…$$` for display style inside a paragraph.
parser.inline.ruler.after("escape", "math", (state, silent) => {
  const { src, posMax } = state;
  if (src.charCodeAt(state.pos) !== 36) return false;
  const display = src.charCodeAt(state.pos + 1) === 36, start = state.pos + (display ? 2 : 1);
  if (!display && isBlank(src.charCodeAt(start))) return false;
  for (let pos = start; pos < posMax; pos++) {
    const code = src.charCodeAt(pos);
    if (code === 92) { pos++; continue; }
    if (code !== 36) continue;
    const next = pos + 1 < posMax ? src.charCodeAt(pos + 1) : NaN;
    if (display ? next !== 36 : pos === start || isBlank(src.charCodeAt(pos - 1)) || (next >= 48 && next <= 57)) continue;
    if (!silent) { const token = state.push("math_inline", "span", 0); token.content = src.slice(start, pos); token.meta = { display }; }
    state.pos = pos + (display ? 2 : 1); return true;
  }
  return false;
});
parser.renderer.rules.math_inline = (tokens, index) => `<span class="math ${tokens[index].meta.display ? "math-block" : "math-inline"}">${parser.utils.escapeHtml(tokens[index].content)}</span>`;
// Display TeX fenced by lines that open and close with `$$`.
parser.block.ruler.before("fence", "math", (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4 || startLine + 1 >= endLine) return false;
  const text = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const open = /^(\${2,}) *([^$]*)$/.exec(text(startLine));
  if (!open) return false;
  if (silent) return true;
  const lines = open[2].trim() ? [open[2]] : [];
  let next = startLine + 1;
  for (; next < endLine; next++) {
    const current = text(next);
    if (current && state.sCount[next] < state.blkIndent) break;
    const close = /^([^$]*?) *(\${2,}) *$/.exec(current);
    if (close && close[2].length >= open[1].length) { if (close[1].trim()) lines.push(close[1]); next++; break; }
    lines.push(current);
  }
  const token = state.push("math_block", "div", 0);
  token.block = true; token.content = lines.join("\n"); token.map = [startLine, next];
  state.line = next; return true;
}, { alt: ["paragraph", "reference", "blockquote", "list"] });
parser.renderer.rules.math_block = (tokens, index) => `<div class="math math-block"${parser.renderer.renderAttrs(tokens[index])}>${parser.utils.escapeHtml(tokens[index].content)}</div>\n`;

// Footnotes: `[^id]` references, `[^id]: …` definitions and inline `^[…]` notes. References are
// numbered in document order; the notes that are referenced are listed in a trailing section.
type Token = ReturnType<typeof parser.parse>[number];
interface FootnoteEnv { footnotes?: Set<string> }
parser.block.ruler.before("reference", "footnote-def", (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine], max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const match = /^\[\^([^\]\s]+)\]:/.exec(state.src.slice(start, max));
  if (!match) return false;
  if (silent) return true;
  const id = match[1].toLowerCase();
  ((state.env as FootnoteEnv).footnotes ??= new Set()).add(id);
  const opening = state.push("footnote_def_open", "", 1); opening.meta = { id };
  // The note's body is the rest of the line plus any following lines indented under it.
  const saved = [state.bMarks[startLine], state.tShift[startLine], state.sCount[startLine]], parentType = state.parentType;
  let pos = start + match[0].length, indent = 0;
  const bodyStart = pos;
  while (pos < max && isBlank(state.src.charCodeAt(pos))) { indent++; pos++; }
  state.bMarks[startLine] = bodyStart; state.tShift[startLine] = pos - bodyStart;
  state.blkIndent += 4; state.sCount[startLine] = state.blkIndent + indent;
  state.md.block.tokenize(state, startLine, endLine);
  state.parentType = parentType; state.blkIndent -= 4;
  [state.bMarks[startLine], state.tShift[startLine], state.sCount[startLine]] = saved;
  state.push("footnote_def_close", "", -1);
  return true;
}, { alt: ["paragraph", "reference"] });
parser.inline.ruler.before("link", "footnote-ref", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 91 || state.src.charCodeAt(state.pos + 1) !== 94) return false;
  const match = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos, state.posMax));
  if (!match) return false;
  if (!silent) {
    const id = match[1].toLowerCase();
    if ((state.env as FootnoteEnv).footnotes?.has(id)) { const token = state.push("footnote_ref", "sup", 0); token.content = match[0]; token.meta = { id }; }
    else state.pending += id;
  }
  state.pos += match[0].length; return true;
});
parser.inline.ruler.before("link", "footnote-inline", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 94 || state.src.charCodeAt(state.pos + 1) !== 91) return false;
  const end = state.md.helpers.parseLinkLabel(state, state.pos + 1);
  if (end < 0) return false;
  if (!silent) {
    const token = state.push("footnote_ref", "sup", 0), children: Token[] = [];
    token.content = state.src.slice(state.pos, end + 1);
    state.md.inline.parse(state.src.slice(state.pos + 2, end), state.md, state.env, children);
    token.meta = { children };
  }
  state.pos = end + 1; return true;
});
parser.renderer.rules.footnote_ref = (tokens, index) => {
  const { label, number, ref } = tokens[index].meta as { label?: string; number?: number; ref?: string };
  if (!label) return parser.utils.escapeHtml(tokens[index].content);
  return `<sup class="footnote-ref" data-footnote-id="fnref-${label}"><a class="footnote-link" href="#fn-${number}" data-footref="${parser.utils.escapeHtml(ref ?? "")}">[${label}]</a></sup>`;
};
parser.renderer.rules.footnote_def_open = parser.renderer.rules.footnote_def_close = () => "";
// Runs last so that content re-parsed by the block pass above is numbered exactly once.
parser.core.ruler.push("footnotes", state => {
  const notes: Array<{ id?: string; count: number; children?: Token[] }> = [], numbers = new Map<string, number>();
  const number = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "footnote_ref") {
        const { id, children } = token.meta as { id?: string; children?: Token[] };
        let at = id === undefined ? -1 : numbers.get(id) ?? -1;
        if (at < 0) { at = notes.length; notes.push({ id, count: 0, children }); if (id !== undefined) numbers.set(id, at); }
        const repeat = notes[at].count++;
        token.meta = { number: at + 1, label: `${at + 1}${repeat ? `-${repeat}` : ""}`, ref: id ?? `[inline${at}` };
        if (children) number(children);
      } else if (token.children) number(token.children);
    }
  };
  number(state.tokens);
  // Lift the definitions out of the flow; the last definition of an id wins.
  const definitions = new Map<string, Token[]>();
  for (let index = 0; index < state.tokens.length; index++) {
    if (state.tokens[index].type !== "footnote_def_open") continue;
    let end = index + 1;
    for (let depth = 1; end < state.tokens.length; end++) {
      if (state.tokens[end].type === "footnote_def_open") depth++;
      else if (state.tokens[end].type === "footnote_def_close" && --depth === 0) break;
    }
    const removed = state.tokens.splice(index, end - index + 1);
    definitions.set(removed[0].meta.id, removed.slice(1, -1)); index--;
  }
  const html = (type: string, content: string) => { const token = new state.Token(type, "", 0); token.content = content; return token; };
  const items: Token[] = [];
  notes.forEach((note, at) => {
    const body = note.id === undefined ? note.children : definitions.get(note.id);
    if (!body) return;
    const backrefs = Array.from({ length: note.count }, (_, repeat) => html("html_inline", `<a class="footnote-backref footnote-link" href="#fnref-${at + 1}${repeat ? `-${repeat}` : ""}">↩︎</a>`));
    items.push(html("html_block", `<li data-footnote-id="fn-${at + 1}">`));
    if (note.id === undefined) { const inline = new state.Token("inline", "", 0); inline.children = [...body, ...backrefs]; inline.content = ""; items.push(inline); }
    else {
      const last = body[body.length - 1], text = body[body.length - 2];
      if (last?.type === "paragraph_close" && text?.type === "inline") { text.children = [...text.children ?? [], ...backrefs]; items.push(...body); }
      else items.push(...body, ...backrefs.map(backref => html("html_block", backref.content)));
    }
    items.push(html("html_block", "</li>\n"));
  });
  if (items.length) state.tokens.push(html("html_block", '<section class="footnotes"><hr>\n<ol>\n'), ...items, html("html_block", "</ol>\n</section>\n"));
});

parser.core.ruler.after("inline", "vault-blocks", state => {
  const quotes: number[] = [];
  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index];
    if (token.map && token.nesting !== -1 && token.type !== "inline") {
      token.attrSet("data-source-line", String(token.map[0])); token.attrSet("data-source-end", String(token.map[1]));
    }
    if (token.type === "blockquote_open") {
      quotes.push(index);
      const inline = state.tokens[index + 2];
      if (inline?.type === "inline") {
        const match = inline.content.match(/^\[!([^\]]+)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)/);
        if (match) {
          token.meta = { type: match[1].trim().toLowerCase(), fold: match[2], title: match[3] || match[1].trim().replace(/-/g, " ").replace(/^./, letter => letter.toUpperCase()) };
          inline.content = inline.content.slice(match[0].length);
          inline.children = []; state.md.inline.parse(inline.content, state.md, state.env, inline.children);
        }
      }
    } else if (token.type === "blockquote_close") {
      const opening = quotes.pop(); if (opening !== undefined) token.meta = state.tokens[opening].meta;
    }
    if (token.type === "inline" && state.tokens[index - 2]?.type === "list_item_open") {
      const match = token.content.match(/^\[([^\]])\] /);
      if (match) {
        state.tokens[index - 2].attrSet("class", `task-list-item${match[1].toLowerCase() === "x" ? " is-checked" : ""}`);
        state.tokens[index - 2].attrSet("data-task", match[1] === " " ? "" : match[1]);
        token.content = token.content.slice(match[0].length);
        token.children = []; state.md.inline.parse(token.content, state.md, state.env, token.children);
        const checkbox = new state.Token("html_inline", "", 0);
        checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" data-task-line="${token.map?.[0] ?? -1}"${match[1] === " " ? "" : " checked"}> `;
        token.children.unshift(checkbox);
      }
    }
    // A block's `^id` marker identifies it for links and is not part of the rendered text.
    if (token.type === "inline" && token.children?.length) {
      const last = token.children[token.children.length - 1];
      const marker = last.type === "text" ? /(^|\s)\^[a-zA-Z0-9-]+$/.exec(last.content) : null;
      if (marker) last.content = last.content.slice(0, marker.index + marker[1].length);
    }
  }
});
parser.renderer.rules.blockquote_open = (tokens, index, options, env, renderer) => {
  const callout = tokens[index].meta as { type: string; title: string; fold: string } | null;
  if (!callout) return renderer.renderToken(tokens, index, options);
  const attrs = tokens[index].attrs?.map(([key, value]) => ` ${key}="${parser.utils.escapeHtml(value)}"`).join("") ?? "";
  return `<div class="callout" data-callout="${parser.utils.escapeHtml(callout.type)}" data-callout-fold="${callout.fold}"${attrs}><div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner">${parser.renderInline(callout.title, env)}</div></div><div class="callout-content">`;
};
parser.renderer.rules.blockquote_close = (tokens, index) => tokens[index].meta ? "</div></div>\n" : "</blockquote>\n";

export function renderMarkdown(markdown: string, root: HTMLElement, lineOffset = 0, options?: { deferFinish?: boolean; mermaid?: MermaidHost | null; strictLineBreaks?: boolean }): WeakMap<HTMLElement, MarkdownSectionInformation> {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  parser.options.breaks = options?.strictLineBreaks !== true;
  root.replaceChildren(sanitizeHTMLToDom(parser.render(markdown)));
  for (const checkbox of root.querySelectorAll<HTMLInputElement>("input[data-task-line]")) {
    checkbox.dataset.taskLine = String(Number(checkbox.dataset.taskLine) + lineOffset);
  }
  const sections = new WeakMap<HTMLElement, MarkdownSectionInformation>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-source-line]")) {
    const start = Number(element.dataset.sourceLine), end = Math.max(start, Number(element.dataset.sourceEnd) - 1);
    sections.set(element, { text: lines.slice(start, end + 1).join("\n"), lineStart: start + lineOffset, lineEnd: end + lineOffset });
    element.removeAttribute("data-source-line"); element.removeAttribute("data-source-end");
  }
  for (const heading of root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
    heading.dataset.heading = heading.textContent || ""; heading.dir = "auto";
    const indicator = root.ownerDocument.createElement("span"); indicator.className = "heading-collapse-indicator collapse-indicator collapse-icon";
    setIcon(indicator, "right-triangle"); heading.prepend(indicator);
    attachHeadingFold(indicator);
  }
  for (const block of root.querySelectorAll<HTMLElement>("p, li, td, th")) block.dir = "auto";
  for (const list of root.querySelectorAll<HTMLElement>("ul")) {
    list.classList.add("has-list-bullet");
    if (list.querySelector(":scope > li.task-list-item")) list.classList.add("contains-task-list");
  }
  for (const item of root.querySelectorAll<HTMLElement>("ul > li, ol > li")) {
    let list = item.parentElement!;
    for (;;) {
      const outer = list.parentElement?.closest<HTMLElement>("ul,ol");
      if (!outer || !sections.has(outer)) break;
      list = outer;
    }
    const line = sections.get(item)?.lineStart, start = sections.get(list)?.lineStart;
    if (line !== undefined && start !== undefined) item.dataset.line = String(line - start);
    const bullet = item.parentElement?.tagName === "UL" ? root.ownerDocument.createElement("span") : null;
    if (bullet) { bullet.className = "list-bullet"; item.prepend(bullet); }
    if (item.querySelector(":scope > ul, :scope > ol")) {
      const indicator = root.ownerDocument.createElement("span"); indicator.className = "list-collapse-indicator collapse-indicator collapse-icon";
      setIcon(indicator, "right-triangle"); if (bullet) bullet.after(indicator); else item.prepend(indicator);
      attachListFold(indicator);
    }
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    if (link.classList.contains("tag") || !/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
    link.classList.add("external-link"); link.target = "_blank"; link.rel = "noopener nofollow";
  }
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    // The language class of the `pre` is Prism's to set (it normalises unknown languages to `language-none`).
    const pre = code.parentElement!;
    const text = (code.textContent ?? "").replace(/\n$/, "");
    const copy = root.ownerDocument.createElement("button"); copy.className = "copy-code-button";
    setIcon(copy, "lucide-copy");
    copy.addEventListener("click", event => {
      event.preventDefault();
      void navigator.clipboard.writeText(text).then(() => {
        setIcon(copy, "lucide-check"); copy.style.color = "var(--text-success)"; copy.style.display = "inline-flex";
        window.setTimeout(() => { setIcon(copy, "lucide-copy"); copy.style.color = ""; copy.style.display = ""; }, 1000);
      });
    });
    pre.append(copy);
  }
  for (const image of root.querySelectorAll<HTMLImageElement>("img[src]")) {
    const src = image.getAttribute("src")!;
    if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) { image.dataset.resourceLink = src; image.removeAttribute("src"); }
  }
  for (const callout of root.querySelectorAll<HTMLElement>(".callout")) {
    const title = callout.querySelector<HTMLElement>(":scope > .callout-title"), content = callout.querySelector<HTMLElement>(":scope > .callout-content");
    const icon = title?.querySelector<HTMLElement>(".callout-icon");
    if (icon) setIcon(icon, getComputedStyle(callout).getPropertyValue("--callout-icon").trim().replace(/^['"]|['"]$/g, "") || "pencil");
    if (!title || !content || !/[+-]/.test(callout.dataset.calloutFold || "")) continue;
    callout.classList.add("is-collapsible");
    const fold = root.ownerDocument.createElement("button"); fold.className = "callout-fold clickable-icon"; fold.type = "button"; fold.setAttribute("aria-label", t("obsen.markdown.toggle-callout")); setIcon(fold, "chevron-down"); title.append(fold);
    let collapsed = callout.dataset.calloutFold === "-";
    const update = () => { callout.classList.toggle("is-collapsed", collapsed); fold.classList.toggle("is-collapsed", collapsed); content.hidden = collapsed; fold.setAttribute("aria-expanded", String(!collapsed)); };
    update(); title.addEventListener("click", event => { if (!event.defaultPrevented && !(event.target as Element).closest("a")) { collapsed = !collapsed; update(); } });
  }
  // Footnote ids are made unique per rendered document so that embeds do not collide.
  const docId = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, "0")).join("");
  for (const element of root.querySelectorAll<HTMLElement>("[data-footnote-id]")) {
    element.id = element.dataset.footnoteId = `${element.dataset.footnoteId}-${docId}`;
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a.footnote-link")) {
    const target = `${link.getAttribute("href")!.slice(1)}-${docId}`;
    link.setAttribute("href", `#${target}`);
    link.addEventListener("click", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const element = root.querySelector<HTMLElement>(`[data-footnote-id="${target}"]`);
      if (!element) return;
      for (const flashing of root.querySelectorAll(".is-flashing")) flashing.classList.remove("is-flashing");
      element.classList.add("is-flashing"); setTimeout(() => element.classList.remove("is-flashing"), 3000);
      element.scrollIntoView({ block: "center" });
    });
  }
  for (const math of root.querySelectorAll<HTMLElement>(".math:not(.is-loaded)")) renderMathInto(math, math.textContent ?? "", math.classList.contains("math-block"));
  // Callers that still have to run plugin post processors finish after those.
  if (!options?.deferFinish) finishReadingView(root, options?.mermaid ?? null);
  return sections;
}
