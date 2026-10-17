/*
 * Prism 1.30.0 (npm `prismjs`), with the component set of the reference's build loaded in the same
 * order, so reading view gets the same token spans. Nothing is evaluated until the first code block
 * is highlighted or `loadPrism` is called.
 */

import type { Token } from "prismjs";
export type PrismApi = typeof import("prismjs");

let prism: PrismApi | null = null;

/*
 * The reference's language list with each component's hard requirements (`require`, `modify`)
 * hoisted, as Prism's download builder orders them. Optional dependencies are deliberately not
 * hoisted: JavaScript, for one, is defined before `regex`, so regex sources stay one token.
 * Regenerate with the scratch generator if the list changes; do not sort it.
 */
function loadAll(): PrismApi {
  const root = globalThis as { Prism?: unknown };
  // Prism highlights the whole page on load unless this is set first.
  root.Prism = Object.assign((root.Prism as object | undefined) ?? {}, { manual: true });
  const core = require("prismjs/components/prism-core.js") as PrismApi;
  root.Prism = core;
  require("prismjs/components/prism-markup.js");
  require("prismjs/components/prism-css.js");
  require("prismjs/components/prism-clike.js");
  require("prismjs/components/prism-javascript.js");
  require("prismjs/components/prism-abap.js");
  require("prismjs/components/prism-abnf.js");
  require("prismjs/components/prism-actionscript.js");
  require("prismjs/components/prism-ada.js");
  require("prismjs/components/prism-agda.js");
  require("prismjs/components/prism-al.js");
  require("prismjs/components/prism-antlr4.js");
  require("prismjs/components/prism-apacheconf.js");
  require("prismjs/components/prism-sql.js");
  require("prismjs/components/prism-apex.js");
  require("prismjs/components/prism-apl.js");
  require("prismjs/components/prism-applescript.js");
  require("prismjs/components/prism-aql.js");
  require("prismjs/components/prism-c.js");
  require("prismjs/components/prism-cpp.js");
  require("prismjs/components/prism-arduino.js");
  require("prismjs/components/prism-arff.js");
  require("prismjs/components/prism-armasm.js");
  require("prismjs/components/prism-arturo.js");
  require("prismjs/components/prism-asciidoc.js");
  require("prismjs/components/prism-csharp.js");
  require("prismjs/components/prism-aspnet.js");
  require("prismjs/components/prism-asm6502.js");
  require("prismjs/components/prism-asmatmel.js");
  require("prismjs/components/prism-autohotkey.js");
  require("prismjs/components/prism-autoit.js");
  require("prismjs/components/prism-avisynth.js");
  require("prismjs/components/prism-avro-idl.js");
  require("prismjs/components/prism-awk.js");
  require("prismjs/components/prism-bash.js");
  require("prismjs/components/prism-basic.js");
  require("prismjs/components/prism-batch.js");
  require("prismjs/components/prism-bbcode.js");
  require("prismjs/components/prism-bbj.js");
  require("prismjs/components/prism-bicep.js");
  require("prismjs/components/prism-birb.js");
  require("prismjs/components/prism-bison.js");
  require("prismjs/components/prism-bnf.js");
  require("prismjs/components/prism-bqn.js");
  require("prismjs/components/prism-brainfuck.js");
  require("prismjs/components/prism-brightscript.js");
  require("prismjs/components/prism-bro.js");
  require("prismjs/components/prism-bsl.js");
  require("prismjs/components/prism-cfscript.js");
  require("prismjs/components/prism-chaiscript.js");
  require("prismjs/components/prism-cil.js");
  require("prismjs/components/prism-cilkc.js");
  require("prismjs/components/prism-cilkcpp.js");
  require("prismjs/components/prism-clojure.js");
  require("prismjs/components/prism-cmake.js");
  require("prismjs/components/prism-cobol.js");
  require("prismjs/components/prism-coffeescript.js");
  require("prismjs/components/prism-concurnas.js");
  require("prismjs/components/prism-csp.js");
  require("prismjs/components/prism-cooklang.js");
  require("prismjs/components/prism-coq.js");
  require("prismjs/components/prism-ruby.js");
  require("prismjs/components/prism-crystal.js");
  require("prismjs/components/prism-css-extras.js");
  require("prismjs/components/prism-csv.js");
  require("prismjs/components/prism-cue.js");
  require("prismjs/components/prism-cypher.js");
  require("prismjs/components/prism-d.js");
  require("prismjs/components/prism-dart.js");
  require("prismjs/components/prism-dataweave.js");
  require("prismjs/components/prism-dax.js");
  require("prismjs/components/prism-dhall.js");
  require("prismjs/components/prism-diff.js");
  require("prismjs/components/prism-markup-templating.js");
  require("prismjs/components/prism-django.js");
  require("prismjs/components/prism-dns-zone-file.js");
  require("prismjs/components/prism-docker.js");
  require("prismjs/components/prism-dot.js");
  require("prismjs/components/prism-ebnf.js");
  require("prismjs/components/prism-editorconfig.js");
  require("prismjs/components/prism-eiffel.js");
  require("prismjs/components/prism-ejs.js");
  require("prismjs/components/prism-elixir.js");
  require("prismjs/components/prism-elm.js");
  require("prismjs/components/prism-lua.js");
  require("prismjs/components/prism-etlua.js");
  require("prismjs/components/prism-erb.js");
  require("prismjs/components/prism-erlang.js");
  require("prismjs/components/prism-excel-formula.js");
  require("prismjs/components/prism-fsharp.js");
  require("prismjs/components/prism-factor.js");
  require("prismjs/components/prism-false.js");
  require("prismjs/components/prism-firestore-security-rules.js");
  require("prismjs/components/prism-flow.js");
  require("prismjs/components/prism-fortran.js");
  require("prismjs/components/prism-ftl.js");
  require("prismjs/components/prism-gml.js");
  require("prismjs/components/prism-gap.js");
  require("prismjs/components/prism-gcode.js");
  require("prismjs/components/prism-gdscript.js");
  require("prismjs/components/prism-gedcom.js");
  require("prismjs/components/prism-gettext.js");
  require("prismjs/components/prism-gherkin.js");
  require("prismjs/components/prism-git.js");
  require("prismjs/components/prism-glsl.js");
  require("prismjs/components/prism-gn.js");
  require("prismjs/components/prism-linker-script.js");
  require("prismjs/components/prism-go.js");
  require("prismjs/components/prism-go-module.js");
  require("prismjs/components/prism-gradle.js");
  require("prismjs/components/prism-graphql.js");
  require("prismjs/components/prism-groovy.js");
  require("prismjs/components/prism-haml.js");
  require("prismjs/components/prism-handlebars.js");
  require("prismjs/components/prism-haskell.js");
  require("prismjs/components/prism-haxe.js");
  require("prismjs/components/prism-hcl.js");
  require("prismjs/components/prism-hlsl.js");
  require("prismjs/components/prism-hoon.js");
  require("prismjs/components/prism-http.js");
  require("prismjs/components/prism-hpkp.js");
  require("prismjs/components/prism-hsts.js");
  require("prismjs/components/prism-ichigojam.js");
  require("prismjs/components/prism-icon.js");
  require("prismjs/components/prism-icu-message-format.js");
  require("prismjs/components/prism-idris.js");
  require("prismjs/components/prism-ignore.js");
  require("prismjs/components/prism-inform7.js");
  require("prismjs/components/prism-ini.js");
  require("prismjs/components/prism-io.js");
  require("prismjs/components/prism-j.js");
  require("prismjs/components/prism-java.js");
  require("prismjs/components/prism-php.js");
  require("prismjs/components/prism-javadoclike.js");
  require("prismjs/components/prism-javadoc.js");
  require("prismjs/components/prism-javastacktrace.js");
  require("prismjs/components/prism-jexl.js");
  require("prismjs/components/prism-jolie.js");
  require("prismjs/components/prism-jq.js");
  require("prismjs/components/prism-typescript.js");
  require("prismjs/components/prism-jsdoc.js");
  require("prismjs/components/prism-js-extras.js");
  require("prismjs/components/prism-json.js");
  require("prismjs/components/prism-json5.js");
  require("prismjs/components/prism-jsonp.js");
  require("prismjs/components/prism-jsstacktrace.js");
  require("prismjs/components/prism-js-templates.js");
  require("prismjs/components/prism-julia.js");
  require("prismjs/components/prism-keepalived.js");
  require("prismjs/components/prism-keyman.js");
  require("prismjs/components/prism-kotlin.js");
  require("prismjs/components/prism-kumir.js");
  require("prismjs/components/prism-kusto.js");
  require("prismjs/components/prism-latex.js");
  require("prismjs/components/prism-latte.js");
  require("prismjs/components/prism-less.js");
  require("prismjs/components/prism-scheme.js");
  require("prismjs/components/prism-lilypond.js");
  require("prismjs/components/prism-liquid.js");
  require("prismjs/components/prism-lisp.js");
  require("prismjs/components/prism-livescript.js");
  require("prismjs/components/prism-llvm.js");
  require("prismjs/components/prism-log.js");
  require("prismjs/components/prism-lolcode.js");
  require("prismjs/components/prism-magma.js");
  require("prismjs/components/prism-makefile.js");
  require("prismjs/components/prism-markdown.js");
  require("prismjs/components/prism-mata.js");
  require("prismjs/components/prism-matlab.js");
  require("prismjs/components/prism-maxscript.js");
  require("prismjs/components/prism-mel.js");
  require("prismjs/components/prism-mermaid.js");
  require("prismjs/components/prism-metafont.js");
  require("prismjs/components/prism-mizar.js");
  require("prismjs/components/prism-mongodb.js");
  require("prismjs/components/prism-monkey.js");
  require("prismjs/components/prism-moonscript.js");
  require("prismjs/components/prism-n1ql.js");
  require("prismjs/components/prism-n4js.js");
  require("prismjs/components/prism-nand2tetris-hdl.js");
  require("prismjs/components/prism-naniscript.js");
  require("prismjs/components/prism-nasm.js");
  require("prismjs/components/prism-neon.js");
  require("prismjs/components/prism-nevod.js");
  require("prismjs/components/prism-nginx.js");
  require("prismjs/components/prism-nim.js");
  require("prismjs/components/prism-nix.js");
  require("prismjs/components/prism-nsis.js");
  require("prismjs/components/prism-objectivec.js");
  require("prismjs/components/prism-ocaml.js");
  require("prismjs/components/prism-odin.js");
  require("prismjs/components/prism-opencl.js");
  require("prismjs/components/prism-openqasm.js");
  require("prismjs/components/prism-oz.js");
  require("prismjs/components/prism-parigp.js");
  require("prismjs/components/prism-parser.js");
  require("prismjs/components/prism-pascal.js");
  require("prismjs/components/prism-pascaligo.js");
  require("prismjs/components/prism-psl.js");
  require("prismjs/components/prism-pcaxis.js");
  require("prismjs/components/prism-peoplecode.js");
  require("prismjs/components/prism-perl.js");
  require("prismjs/components/prism-phpdoc.js");
  require("prismjs/components/prism-php-extras.js");
  require("prismjs/components/prism-plant-uml.js");
  require("prismjs/components/prism-plsql.js");
  require("prismjs/components/prism-powerquery.js");
  require("prismjs/components/prism-powershell.js");
  require("prismjs/components/prism-processing.js");
  require("prismjs/components/prism-prolog.js");
  require("prismjs/components/prism-promql.js");
  require("prismjs/components/prism-properties.js");
  require("prismjs/components/prism-protobuf.js");
  require("prismjs/components/prism-pug.js");
  require("prismjs/components/prism-puppet.js");
  require("prismjs/components/prism-pure.js");
  require("prismjs/components/prism-purebasic.js");
  require("prismjs/components/prism-purescript.js");
  require("prismjs/components/prism-python.js");
  require("prismjs/components/prism-qsharp.js");
  require("prismjs/components/prism-q.js");
  require("prismjs/components/prism-qml.js");
  require("prismjs/components/prism-qore.js");
  require("prismjs/components/prism-r.js");
  require("prismjs/components/prism-racket.js");
  require("prismjs/components/prism-cshtml.js");
  require("prismjs/components/prism-jsx.js");
  require("prismjs/components/prism-tsx.js");
  require("prismjs/components/prism-reason.js");
  require("prismjs/components/prism-regex.js");
  require("prismjs/components/prism-rego.js");
  require("prismjs/components/prism-renpy.js");
  require("prismjs/components/prism-rescript.js");
  require("prismjs/components/prism-rest.js");
  require("prismjs/components/prism-rip.js");
  require("prismjs/components/prism-roboconf.js");
  require("prismjs/components/prism-robotframework.js");
  require("prismjs/components/prism-rust.js");
  require("prismjs/components/prism-sas.js");
  require("prismjs/components/prism-sass.js");
  require("prismjs/components/prism-scss.js");
  require("prismjs/components/prism-scala.js");
  require("prismjs/components/prism-shell-session.js");
  require("prismjs/components/prism-smali.js");
  require("prismjs/components/prism-smalltalk.js");
  require("prismjs/components/prism-smarty.js");
  require("prismjs/components/prism-sml.js");
  require("prismjs/components/prism-solidity.js");
  require("prismjs/components/prism-solution-file.js");
  require("prismjs/components/prism-soy.js");
  require("prismjs/components/prism-turtle.js");
  require("prismjs/components/prism-sparql.js");
  require("prismjs/components/prism-splunk-spl.js");
  require("prismjs/components/prism-sqf.js");
  require("prismjs/components/prism-squirrel.js");
  require("prismjs/components/prism-stan.js");
  require("prismjs/components/prism-stata.js");
  require("prismjs/components/prism-iecst.js");
  require("prismjs/components/prism-stylus.js");
  require("prismjs/components/prism-supercollider.js");
  require("prismjs/components/prism-swift.js");
  require("prismjs/components/prism-systemd.js");
  require("prismjs/components/prism-t4-templating.js");
  require("prismjs/components/prism-t4-cs.js");
  require("prismjs/components/prism-vbnet.js");
  require("prismjs/components/prism-t4-vb.js");
  require("prismjs/components/prism-yaml.js");
  require("prismjs/components/prism-tap.js");
  require("prismjs/components/prism-tcl.js");
  require("prismjs/components/prism-tt2.js");
  require("prismjs/components/prism-textile.js");
  require("prismjs/components/prism-toml.js");
  require("prismjs/components/prism-tremor.js");
  require("prismjs/components/prism-twig.js");
  require("prismjs/components/prism-typoscript.js");
  require("prismjs/components/prism-unrealscript.js");
  require("prismjs/components/prism-uorazor.js");
  require("prismjs/components/prism-uri.js");
  require("prismjs/components/prism-v.js");
  require("prismjs/components/prism-vala.js");
  require("prismjs/components/prism-velocity.js");
  require("prismjs/components/prism-verilog.js");
  require("prismjs/components/prism-vhdl.js");
  require("prismjs/components/prism-vim.js");
  require("prismjs/components/prism-visual-basic.js");
  require("prismjs/components/prism-warpscript.js");
  require("prismjs/components/prism-wasm.js");
  require("prismjs/components/prism-web-idl.js");
  require("prismjs/components/prism-wgsl.js");
  require("prismjs/components/prism-wiki.js");
  require("prismjs/components/prism-wolfram.js");
  require("prismjs/components/prism-wren.js");
  require("prismjs/components/prism-xeora.js");
  require("prismjs/components/prism-xml-doc.js");
  require("prismjs/components/prism-xojo.js");
  require("prismjs/components/prism-xquery.js");
  require("prismjs/components/prism-yang.js");
  require("prismjs/components/prism-zig.js");
  return core;
}

/** The Prism object, loading it on first use. */
export function getPrism(): PrismApi {
  return prism ??= loadAll();
}

/** Loads Prism; resolves to the `Prism` object, which is also published as a global. */
export function loadPrism(): Promise<PrismApi> {
  try { return Promise.resolve(getPrism()); } catch (error) { return Promise.reject(error); }
}

/** Highlights fenced code the way the reference's post processor (sort order 100) does. */
export function highlightCodeBlocks(root: ParentNode): void {
  const blocks = root.querySelectorAll<HTMLElement>('code[class*="language-"]:not(.is-loaded)');
  if (!blocks.length) return;
  const Prism = getPrism();
  for (const code of blocks) {
    Prism.highlightElement(code);
    code.parentElement?.removeAttribute("tabindex");
    code.classList.add("is-loaded");
  }
}

/*
 * Prism tokens as CodeMirror-style classes. The editor does not use these (it tokenises with the
 * reference's CodeMirror modes, see editor-code-languages.ts); they remain for the Node-side
 * editor checks, which cannot load CodeMirror 5.
 */
const CM_CLASS: Record<string, string> = {
  comment: "cm-comment", prolog: "cm-comment", doctype: "cm-comment", cdata: "cm-comment",
  namespace: "cm-meta",
  tag: "cm-tag", constant: "cm-tag", symbol: "cm-tag", deleted: "cm-tag",
  punctuation: "cm-punctuation",
  boolean: "cm-number", number: "cm-number",
  selector: "cm-string", string: "cm-string", char: "cm-string", inserted: "cm-string", "attr-value": "cm-string",
  "attr-name": "cm-attribute",
  operator: "cm-operator",
  entity: "cm-variable", parameter: "cm-variable", url: "cm-link", variable: "cm-variable",
  property: "cm-property", "property-access": "cm-property",
  atrule: "cm-keyword", keyword: "cm-keyword", important: "cm-keyword",
  builtin: "cm-builtin", function: "cm-builtin",
  "class-name": "cm-type",
  regex: "cm-string",
};

export interface CodeTokenRange { from: number; to: number; cls: string }

type Piece = string | Token;

/** Leaf ranges of `text` (offsets into that string) for a Prism language id. */
export function codeMirrorTokenRanges(text: string, language: string): CodeTokenRange[] {
  const Prism = getPrism(), grammar = Prism.languages[language];
  if (!grammar || !text) return [];
  const ranges: CodeTokenRange[] = [];
  let offset = 0;
  const visit = (piece: Piece, type: string | null): void => {
    if (typeof piece === "string") {
      if (type && piece.length && piece.trim()) ranges.push({ from: offset, to: offset + piece.length, cls: CM_CLASS[type] ? `${CM_CLASS[type]} token ${type}` : `token ${type}` });
      offset += piece.length;
      return;
    }
    const next = piece.type || type, content = piece.content;
    if (Array.isArray(content)) for (const child of content) visit(child, next);
    else visit(content, next);
  };
  for (const piece of Prism.tokenize(text, grammar)) visit(piece, null);
  return ranges;
}

/** Maps token ranges of a fenced body onto document positions. `lines` are the body lines, in order. */
export function codeTokenDocRanges(text: string, language: string, lines: Array<{ from: number; length: number }>): CodeTokenRange[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) { starts.push(cursor); cursor += line.length + 1; }
  const out: CodeTokenRange[] = [];
  let lineNo = 0;
  for (const piece of codeMirrorTokenRanges(text, language)) {
    let at = piece.from;
    while (at < piece.to && lineNo < lines.length) {
      const start = starts[lineNo]!, length = lines[lineNo]!.length;
      if (at >= start + length) { lineNo++; continue; }
      if (at < start) at = start;
      if (at >= piece.to) break;
      const take = Math.min(piece.to, start + length) - at;
      if (take <= 0) break;
      const docFrom = lines[lineNo]!.from + (at - start);
      out.push({ from: docFrom, to: docFrom + take, cls: piece.cls });
      at += take;
    }
  }
  return out;
}

/** Language id Prism knows, from a fence's info string. */
export function prismLanguage(info: string): string | null {
  const id = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return id && getPrism().languages[id] ? id : null;
}
