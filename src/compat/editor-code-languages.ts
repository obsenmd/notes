/*
 * Language-aware tokens for fenced code in the editor. The reference tokenises a fence with the
 * CodeMirror 5 mode named by its info string (resolved through the mode table, so names and aliases
 * such as "js", "ts", "c++" or "yml" work) and gives every token `cm-<style>` classes. The same
 * modes, at the reference's version (5.64.0), are run here over the fence's lines. They are only
 * evaluated when the first fence with a language is drawn.
 */

interface StringStream { pos: number; start: number; string: string; eol(): boolean }
interface Mode { name?: string; token(stream: StringStream, state: unknown): string | null }
interface ModeInfo { name: string; mode: string; mime?: string; mimes?: string[]; alias?: string[] }
export interface CodeMirror5 {
  version: string;
  modeInfo: ModeInfo[];
  findModeByName(name: string): ModeInfo | undefined;
  getMode(config: object, spec: unknown): Mode;
  startState(mode: Mode): unknown;
  StringStream: new (text: string, tabSize: number, oracle: { lookAhead(n: number): string | undefined; baseToken(): null }) => StringStream;
}

let library: CodeMirror5 | null | undefined;

function load(): CodeMirror5 | null {
  // CodeMirror 5 needs a document; without one fences stay untokenised.
  if (typeof document === "undefined") return null;
  const lib = require("codemirror/lib/codemirror.js") as CodeMirror5;
  require("codemirror/mode/meta.js");
  require("codemirror/mode/apl/apl.js");
  require("codemirror/mode/asciiarmor/asciiarmor.js");
  require("codemirror/mode/asn.1/asn.1.js");
  require("codemirror/mode/asterisk/asterisk.js");
  require("codemirror/mode/brainfuck/brainfuck.js");
  require("codemirror/mode/clike/clike.js");
  require("codemirror/mode/clojure/clojure.js");
  require("codemirror/mode/cmake/cmake.js");
  require("codemirror/mode/cobol/cobol.js");
  require("codemirror/mode/coffeescript/coffeescript.js");
  require("codemirror/mode/commonlisp/commonlisp.js");
  require("codemirror/mode/crystal/crystal.js");
  require("codemirror/mode/css/css.js");
  require("codemirror/mode/cypher/cypher.js");
  require("codemirror/mode/d/d.js");
  require("codemirror/mode/dart/dart.js");
  require("codemirror/mode/diff/diff.js");
  require("codemirror/mode/django/django.js");
  require("codemirror/mode/dockerfile/dockerfile.js");
  require("codemirror/mode/dtd/dtd.js");
  require("codemirror/mode/dylan/dylan.js");
  require("codemirror/mode/ebnf/ebnf.js");
  require("codemirror/mode/ecl/ecl.js");
  require("codemirror/mode/eiffel/eiffel.js");
  require("codemirror/mode/elm/elm.js");
  require("codemirror/mode/erlang/erlang.js");
  require("codemirror/mode/factor/factor.js");
  require("codemirror/mode/fcl/fcl.js");
  require("codemirror/mode/forth/forth.js");
  require("codemirror/mode/fortran/fortran.js");
  require("codemirror/mode/gas/gas.js");
  require("codemirror/mode/gfm/gfm.js");
  require("codemirror/mode/gherkin/gherkin.js");
  require("codemirror/mode/go/go.js");
  require("codemirror/mode/groovy/groovy.js");
  require("codemirror/mode/haml/haml.js");
  require("codemirror/mode/handlebars/handlebars.js");
  require("codemirror/mode/haskell/haskell.js");
  require("codemirror/mode/haskell-literate/haskell-literate.js");
  require("codemirror/mode/haxe/haxe.js");
  require("codemirror/mode/htmlembedded/htmlembedded.js");
  require("codemirror/mode/htmlmixed/htmlmixed.js");
  require("codemirror/mode/http/http.js");
  require("codemirror/mode/idl/idl.js");
  require("codemirror/mode/javascript/javascript.js");
  require("codemirror/mode/jinja2/jinja2.js");
  require("codemirror/mode/jsx/jsx.js");
  require("codemirror/mode/julia/julia.js");
  require("codemirror/mode/livescript/livescript.js");
  require("codemirror/mode/lua/lua.js");
  require("codemirror/mode/markdown/markdown.js");
  require("codemirror/mode/mathematica/mathematica.js");
  require("codemirror/mode/mbox/mbox.js");
  require("codemirror/mode/mirc/mirc.js");
  require("codemirror/mode/mllike/mllike.js");
  require("codemirror/mode/modelica/modelica.js");
  require("codemirror/mode/mscgen/mscgen.js");
  require("codemirror/mode/mumps/mumps.js");
  require("codemirror/mode/nginx/nginx.js");
  require("codemirror/mode/nsis/nsis.js");
  require("codemirror/mode/ntriples/ntriples.js");
  require("codemirror/mode/octave/octave.js");
  require("codemirror/mode/oz/oz.js");
  require("codemirror/mode/pascal/pascal.js");
  require("codemirror/mode/pegjs/pegjs.js");
  require("codemirror/mode/perl/perl.js");
  require("codemirror/mode/php/php.js");
  require("codemirror/mode/pig/pig.js");
  require("codemirror/mode/powershell/powershell.js");
  require("codemirror/mode/properties/properties.js");
  require("codemirror/mode/protobuf/protobuf.js");
  require("codemirror/mode/pug/pug.js");
  require("codemirror/mode/puppet/puppet.js");
  require("codemirror/mode/python/python.js");
  require("codemirror/mode/q/q.js");
  require("codemirror/mode/r/r.js");
  require("codemirror/mode/rpm/rpm.js");
  require("codemirror/mode/rst/rst.js");
  require("codemirror/mode/ruby/ruby.js");
  require("codemirror/mode/rust/rust.js");
  require("codemirror/mode/sas/sas.js");
  require("codemirror/mode/sass/sass.js");
  require("codemirror/mode/scheme/scheme.js");
  require("codemirror/mode/shell/shell.js");
  require("codemirror/mode/sieve/sieve.js");
  require("codemirror/mode/slim/slim.js");
  require("codemirror/mode/smalltalk/smalltalk.js");
  require("codemirror/mode/smarty/smarty.js");
  require("codemirror/mode/solr/solr.js");
  require("codemirror/mode/soy/soy.js");
  require("codemirror/mode/sparql/sparql.js");
  require("codemirror/mode/spreadsheet/spreadsheet.js");
  require("codemirror/mode/sql/sql.js");
  require("codemirror/mode/stex/stex.js");
  require("codemirror/mode/stylus/stylus.js");
  require("codemirror/mode/swift/swift.js");
  require("codemirror/mode/tcl/tcl.js");
  require("codemirror/mode/textile/textile.js");
  require("codemirror/mode/tiddlywiki/tiddlywiki.js");
  require("codemirror/mode/tiki/tiki.js");
  require("codemirror/mode/toml/toml.js");
  require("codemirror/mode/tornado/tornado.js");
  require("codemirror/mode/troff/troff.js");
  require("codemirror/mode/ttcn/ttcn.js");
  require("codemirror/mode/ttcn-cfg/ttcn-cfg.js");
  require("codemirror/mode/turtle/turtle.js");
  require("codemirror/mode/twig/twig.js");
  require("codemirror/mode/vb/vb.js");
  require("codemirror/mode/vbscript/vbscript.js");
  require("codemirror/mode/velocity/velocity.js");
  require("codemirror/mode/verilog/verilog.js");
  require("codemirror/mode/vhdl/vhdl.js");
  require("codemirror/mode/vue/vue.js");
  require("codemirror/mode/wast/wast.js");
  require("codemirror/mode/webidl/webidl.js");
  require("codemirror/mode/xml/xml.js");
  require("codemirror/mode/xquery/xquery.js");
  require("codemirror/mode/yacas/yacas.js");
  require("codemirror/mode/yaml/yaml.js");
  require("codemirror/mode/yaml-frontmatter/yaml-frontmatter.js");
  require("codemirror/mode/z80/z80.js");
  return lib;
}

/** CodeMirror 5 with every mode registered, or null where it cannot run. */
export function codeMirror5(): CodeMirror5 | null {
  if (library === undefined) {
    try { library = load(); } catch (error) { console.error(error); library = null; }
  }
  return library;
}

// Plugins register their own fence languages with `CodeMirror.defineMode` on this global, as in the reference.
if (typeof window !== "undefined" && !("CodeMirror" in window)) {
  const publish = (value: unknown) => Object.defineProperty(window, "CodeMirror", { value, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(window, "CodeMirror", { configurable: true, enumerable: true, get() { const value = codeMirror5(); publish(value); return value; }, set: publish });
}

/** The fence's opening line: marker, then the language name. */
export const FENCE_OPEN = /^\s*(~~~+|```+)[ \t]*([\w\/+#-]*)[^\n`]*$/;

/** Name shown in the fence's corner in Live Preview: the mode table's display name when it knows the language. */
export function codeLanguageName(info: string): string {
  if (!info) return info;
  try { return codeMirror5()?.findModeByName(info)?.name ?? info; } catch { return info; }
}

function resolveMode(lib: CodeMirror5, info: string): Mode | null {
  const found = lib.findModeByName(info);
  const mode = lib.getMode({}, found ? found.mime || found.mimes![0] : info);
  return mode.name === "null" ? null : mode;
}

export interface CodeToken { from: number; to: number; cls: string }

const cache = new Map<string, CodeToken[][] | null>();

/**
 * Tokens of each line of a fence body (offsets within the line), or null when the language has no mode.
 * Each line goes to the mode whole. Empty lines are not forwarded to it.
 */
export function codeLineTokens(info: string, lines: string[]): CodeToken[][] | null {
  if (!info) return null;
  const key = info + "\n" + lines.join("\n");
  if (key.length > 400_000) return null;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let result: CodeToken[][] | null = null;
  const lib = codeMirror5();
  try {
    const mode = lib && resolveMode(lib, info);
    if (lib && mode) {
      const state = lib.startState(mode);
      result = lines.map((text, index) => {
        const tokens: CodeToken[] = [];
        if (!text) return tokens;
        const stream = new lib.StringStream(text, 4, { lookAhead: n => lines[index + n], baseToken: () => null });
        while (!stream.eol()) {
          // A mode may return without consuming anything while it switches state; CodeMirror allows ten tries.
          let style = mode.token(stream, state);
          for (let attempt = 1; stream.pos <= stream.start; attempt++) {
            if (attempt === 10) throw new Error(`Mode ${mode.name} failed to advance stream.`);
            style = mode.token(stream, state);
          }
          const cls = style ? style.split(/\s+/).filter(name => name && !name.startsWith("line-")).map(name => "cm-" + name).join(" ") : "";
          if (cls) tokens.push({ from: stream.start, to: stream.pos, cls });
          stream.start = stream.pos;
        }
        return tokens;
      });
    }
  } catch (error) { console.error(error); result = null; }
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
