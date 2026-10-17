import { createRequire, compileFunction, fs, path, process, assetDirectory } from "../../platforms/platform";
/**
 * Optional CommonJS bridge for community plugins that import `obsidian` at
 * runtime. Importing this module is inert; call installObsidianModuleHook()
 * explicitly from the desktop plugin host when plugin loading is ready.
 */



import {
  Annotation as CodeMirrorState_Annotation, AnnotationType as CodeMirrorState_AnnotationType, ChangeDesc as CodeMirrorState_ChangeDesc,
  ChangeSet as CodeMirrorState_ChangeSet, CharCategory as CodeMirrorState_CharCategory, Compartment as CodeMirrorState_Compartment,
  EditorSelection as CodeMirrorState_EditorSelection, EditorState as CodeMirrorState_EditorState, Facet as CodeMirrorState_Facet,
  Line as CodeMirrorState_Line, MapMode as CodeMirrorState_MapMode, Prec as CodeMirrorState_Prec,
  Range as CodeMirrorState_Range, RangeSet as CodeMirrorState_RangeSet, RangeSetBuilder as CodeMirrorState_RangeSetBuilder,
  RangeValue as CodeMirrorState_RangeValue, SelectionRange as CodeMirrorState_SelectionRange, StateEffect as CodeMirrorState_StateEffect,
  StateEffectType as CodeMirrorState_StateEffectType, StateField as CodeMirrorState_StateField, Text as CodeMirrorState_Text,
  Transaction as CodeMirrorState_Transaction, codePointAt as CodeMirrorState_codePointAt, codePointSize as CodeMirrorState_codePointSize,
  combineConfig as CodeMirrorState_combineConfig, countColumn as CodeMirrorState_countColumn, findClusterBreak as CodeMirrorState_findClusterBreak,
  findColumn as CodeMirrorState_findColumn, fromCodePoint as CodeMirrorState_fromCodePoint
} from "@codemirror/state";
const CodeMirrorState = {
  Annotation: CodeMirrorState_Annotation,
  AnnotationType: CodeMirrorState_AnnotationType,
  ChangeDesc: CodeMirrorState_ChangeDesc,
  ChangeSet: CodeMirrorState_ChangeSet,
  CharCategory: CodeMirrorState_CharCategory,
  Compartment: CodeMirrorState_Compartment,
  EditorSelection: CodeMirrorState_EditorSelection,
  EditorState: CodeMirrorState_EditorState,
  Facet: CodeMirrorState_Facet,
  Line: CodeMirrorState_Line,
  MapMode: CodeMirrorState_MapMode,
  Prec: CodeMirrorState_Prec,
  Range: CodeMirrorState_Range,
  RangeSet: CodeMirrorState_RangeSet,
  RangeSetBuilder: CodeMirrorState_RangeSetBuilder,
  RangeValue: CodeMirrorState_RangeValue,
  SelectionRange: CodeMirrorState_SelectionRange,
  StateEffect: CodeMirrorState_StateEffect,
  StateEffectType: CodeMirrorState_StateEffectType,
  StateField: CodeMirrorState_StateField,
  Text: CodeMirrorState_Text,
  Transaction: CodeMirrorState_Transaction,
  codePointAt: CodeMirrorState_codePointAt,
  codePointSize: CodeMirrorState_codePointSize,
  combineConfig: CodeMirrorState_combineConfig,
  countColumn: CodeMirrorState_countColumn,
  findClusterBreak: CodeMirrorState_findClusterBreak,
  findColumn: CodeMirrorState_findColumn,
  fromCodePoint: CodeMirrorState_fromCodePoint
};
import {
  BidiSpan as CodeMirrorView_BidiSpan, BlockInfo as CodeMirrorView_BlockInfo, BlockType as CodeMirrorView_BlockType,
  Decoration as CodeMirrorView_Decoration, Direction as CodeMirrorView_Direction, EditorView as CodeMirrorView_EditorView,
  GutterMarker as CodeMirrorView_GutterMarker, MatchDecorator as CodeMirrorView_MatchDecorator, RectangleMarker as CodeMirrorView_RectangleMarker,
  ViewPlugin as CodeMirrorView_ViewPlugin, ViewUpdate as CodeMirrorView_ViewUpdate, WidgetType as CodeMirrorView_WidgetType,
  closeHoverTooltips as CodeMirrorView_closeHoverTooltips, crosshairCursor as CodeMirrorView_crosshairCursor, drawSelection as CodeMirrorView_drawSelection,
  dropCursor as CodeMirrorView_dropCursor, getDialog as CodeMirrorView_getDialog, getDrawSelectionConfig as CodeMirrorView_getDrawSelectionConfig,
  getPanel as CodeMirrorView_getPanel, getTooltip as CodeMirrorView_getTooltip, gutter as CodeMirrorView_gutter,
  gutterLineClass as CodeMirrorView_gutterLineClass, gutterWidgetClass as CodeMirrorView_gutterWidgetClass, gutters as CodeMirrorView_gutters,
  hasHoverTooltips as CodeMirrorView_hasHoverTooltips, highlightActiveLine as CodeMirrorView_highlightActiveLine, highlightActiveLineGutter as CodeMirrorView_highlightActiveLineGutter,
  highlightSpecialChars as CodeMirrorView_highlightSpecialChars, highlightTrailingWhitespace as CodeMirrorView_highlightTrailingWhitespace, highlightWhitespace as CodeMirrorView_highlightWhitespace,
  hoverTooltip as CodeMirrorView_hoverTooltip, keymap as CodeMirrorView_keymap, layer as CodeMirrorView_layer,
  lineNumberMarkers as CodeMirrorView_lineNumberMarkers, lineNumberWidgetMarker as CodeMirrorView_lineNumberWidgetMarker, lineNumbers as CodeMirrorView_lineNumbers,
  logException as CodeMirrorView_logException, panels as CodeMirrorView_panels, placeholder as CodeMirrorView_placeholder,
  rectangularSelection as CodeMirrorView_rectangularSelection, repositionTooltips as CodeMirrorView_repositionTooltips, runScopeHandlers as CodeMirrorView_runScopeHandlers,
  scrollPastEnd as CodeMirrorView_scrollPastEnd, showDialog as CodeMirrorView_showDialog, showPanel as CodeMirrorView_showPanel,
  showTooltip as CodeMirrorView_showTooltip, tooltips as CodeMirrorView_tooltips
} from "@codemirror/view";
const CodeMirrorView = {
  BidiSpan: CodeMirrorView_BidiSpan,
  BlockInfo: CodeMirrorView_BlockInfo,
  BlockType: CodeMirrorView_BlockType,
  Decoration: CodeMirrorView_Decoration,
  Direction: CodeMirrorView_Direction,
  EditorView: CodeMirrorView_EditorView,
  GutterMarker: CodeMirrorView_GutterMarker,
  MatchDecorator: CodeMirrorView_MatchDecorator,
  RectangleMarker: CodeMirrorView_RectangleMarker,
  ViewPlugin: CodeMirrorView_ViewPlugin,
  ViewUpdate: CodeMirrorView_ViewUpdate,
  WidgetType: CodeMirrorView_WidgetType,
  closeHoverTooltips: CodeMirrorView_closeHoverTooltips,
  crosshairCursor: CodeMirrorView_crosshairCursor,
  drawSelection: CodeMirrorView_drawSelection,
  dropCursor: CodeMirrorView_dropCursor,
  getDialog: CodeMirrorView_getDialog,
  getDrawSelectionConfig: CodeMirrorView_getDrawSelectionConfig,
  getPanel: CodeMirrorView_getPanel,
  getTooltip: CodeMirrorView_getTooltip,
  gutter: CodeMirrorView_gutter,
  gutterLineClass: CodeMirrorView_gutterLineClass,
  gutterWidgetClass: CodeMirrorView_gutterWidgetClass,
  gutters: CodeMirrorView_gutters,
  hasHoverTooltips: CodeMirrorView_hasHoverTooltips,
  highlightActiveLine: CodeMirrorView_highlightActiveLine,
  highlightActiveLineGutter: CodeMirrorView_highlightActiveLineGutter,
  highlightSpecialChars: CodeMirrorView_highlightSpecialChars,
  highlightTrailingWhitespace: CodeMirrorView_highlightTrailingWhitespace,
  highlightWhitespace: CodeMirrorView_highlightWhitespace,
  hoverTooltip: CodeMirrorView_hoverTooltip,
  keymap: CodeMirrorView_keymap,
  layer: CodeMirrorView_layer,
  lineNumberMarkers: CodeMirrorView_lineNumberMarkers,
  lineNumberWidgetMarker: CodeMirrorView_lineNumberWidgetMarker,
  lineNumbers: CodeMirrorView_lineNumbers,
  logException: CodeMirrorView_logException,
  panels: CodeMirrorView_panels,
  placeholder: CodeMirrorView_placeholder,
  rectangularSelection: CodeMirrorView_rectangularSelection,
  repositionTooltips: CodeMirrorView_repositionTooltips,
  runScopeHandlers: CodeMirrorView_runScopeHandlers,
  scrollPastEnd: CodeMirrorView_scrollPastEnd,
  showDialog: CodeMirrorView_showDialog,
  showPanel: CodeMirrorView_showPanel,
  showTooltip: CodeMirrorView_showTooltip,
  tooltips: CodeMirrorView_tooltips
};
import {
  DocInput as CodeMirrorLanguage_DocInput, HighlightStyle as CodeMirrorLanguage_HighlightStyle, IndentContext as CodeMirrorLanguage_IndentContext,
  LRLanguage as CodeMirrorLanguage_LRLanguage, Language as CodeMirrorLanguage_Language, LanguageDescription as CodeMirrorLanguage_LanguageDescription,
  LanguageSupport as CodeMirrorLanguage_LanguageSupport, ParseContext as CodeMirrorLanguage_ParseContext, StreamLanguage as CodeMirrorLanguage_StreamLanguage,
  StringStream as CodeMirrorLanguage_StringStream, TreeIndentContext as CodeMirrorLanguage_TreeIndentContext, bidiIsolates as CodeMirrorLanguage_bidiIsolates,
  bracketMatching as CodeMirrorLanguage_bracketMatching, bracketMatchingHandle as CodeMirrorLanguage_bracketMatchingHandle, codeFolding as CodeMirrorLanguage_codeFolding,
  continuedIndent as CodeMirrorLanguage_continuedIndent, defaultHighlightStyle as CodeMirrorLanguage_defaultHighlightStyle, defineLanguageFacet as CodeMirrorLanguage_defineLanguageFacet,
  delimitedIndent as CodeMirrorLanguage_delimitedIndent, ensureSyntaxTree as CodeMirrorLanguage_ensureSyntaxTree, flatIndent as CodeMirrorLanguage_flatIndent,
  foldAll as CodeMirrorLanguage_foldAll, foldCode as CodeMirrorLanguage_foldCode, foldEffect as CodeMirrorLanguage_foldEffect,
  foldGutter as CodeMirrorLanguage_foldGutter, foldInside as CodeMirrorLanguage_foldInside, foldKeymap as CodeMirrorLanguage_foldKeymap,
  foldNodeProp as CodeMirrorLanguage_foldNodeProp, foldService as CodeMirrorLanguage_foldService, foldState as CodeMirrorLanguage_foldState,
  foldable as CodeMirrorLanguage_foldable, foldedRanges as CodeMirrorLanguage_foldedRanges, forceParsing as CodeMirrorLanguage_forceParsing,
  getIndentUnit as CodeMirrorLanguage_getIndentUnit, getIndentation as CodeMirrorLanguage_getIndentation, highlightingFor as CodeMirrorLanguage_highlightingFor,
  indentNodeProp as CodeMirrorLanguage_indentNodeProp, indentOnInput as CodeMirrorLanguage_indentOnInput, indentRange as CodeMirrorLanguage_indentRange,
  indentService as CodeMirrorLanguage_indentService, indentString as CodeMirrorLanguage_indentString, indentUnit as CodeMirrorLanguage_indentUnit,
  language as CodeMirrorLanguage_language, languageDataProp as CodeMirrorLanguage_languageDataProp, matchBrackets as CodeMirrorLanguage_matchBrackets,
  sublanguageProp as CodeMirrorLanguage_sublanguageProp, syntaxHighlighting as CodeMirrorLanguage_syntaxHighlighting, syntaxParserRunning as CodeMirrorLanguage_syntaxParserRunning,
  syntaxTree as CodeMirrorLanguage_syntaxTree, syntaxTreeAvailable as CodeMirrorLanguage_syntaxTreeAvailable, toggleFold as CodeMirrorLanguage_toggleFold,
  unfoldAll as CodeMirrorLanguage_unfoldAll, unfoldCode as CodeMirrorLanguage_unfoldCode, unfoldEffect as CodeMirrorLanguage_unfoldEffect
} from "@codemirror/language";
const CodeMirrorLanguage = {
  DocInput: CodeMirrorLanguage_DocInput,
  HighlightStyle: CodeMirrorLanguage_HighlightStyle,
  IndentContext: CodeMirrorLanguage_IndentContext,
  LRLanguage: CodeMirrorLanguage_LRLanguage,
  Language: CodeMirrorLanguage_Language,
  LanguageDescription: CodeMirrorLanguage_LanguageDescription,
  LanguageSupport: CodeMirrorLanguage_LanguageSupport,
  ParseContext: CodeMirrorLanguage_ParseContext,
  StreamLanguage: CodeMirrorLanguage_StreamLanguage,
  StringStream: CodeMirrorLanguage_StringStream,
  TreeIndentContext: CodeMirrorLanguage_TreeIndentContext,
  bidiIsolates: CodeMirrorLanguage_bidiIsolates,
  bracketMatching: CodeMirrorLanguage_bracketMatching,
  bracketMatchingHandle: CodeMirrorLanguage_bracketMatchingHandle,
  codeFolding: CodeMirrorLanguage_codeFolding,
  continuedIndent: CodeMirrorLanguage_continuedIndent,
  defaultHighlightStyle: CodeMirrorLanguage_defaultHighlightStyle,
  defineLanguageFacet: CodeMirrorLanguage_defineLanguageFacet,
  delimitedIndent: CodeMirrorLanguage_delimitedIndent,
  ensureSyntaxTree: CodeMirrorLanguage_ensureSyntaxTree,
  flatIndent: CodeMirrorLanguage_flatIndent,
  foldAll: CodeMirrorLanguage_foldAll,
  foldCode: CodeMirrorLanguage_foldCode,
  foldEffect: CodeMirrorLanguage_foldEffect,
  foldGutter: CodeMirrorLanguage_foldGutter,
  foldInside: CodeMirrorLanguage_foldInside,
  foldKeymap: CodeMirrorLanguage_foldKeymap,
  foldNodeProp: CodeMirrorLanguage_foldNodeProp,
  foldService: CodeMirrorLanguage_foldService,
  foldState: CodeMirrorLanguage_foldState,
  foldable: CodeMirrorLanguage_foldable,
  foldedRanges: CodeMirrorLanguage_foldedRanges,
  forceParsing: CodeMirrorLanguage_forceParsing,
  getIndentUnit: CodeMirrorLanguage_getIndentUnit,
  getIndentation: CodeMirrorLanguage_getIndentation,
  highlightingFor: CodeMirrorLanguage_highlightingFor,
  indentNodeProp: CodeMirrorLanguage_indentNodeProp,
  indentOnInput: CodeMirrorLanguage_indentOnInput,
  indentRange: CodeMirrorLanguage_indentRange,
  indentService: CodeMirrorLanguage_indentService,
  indentString: CodeMirrorLanguage_indentString,
  indentUnit: CodeMirrorLanguage_indentUnit,
  language: CodeMirrorLanguage_language,
  languageDataProp: CodeMirrorLanguage_languageDataProp,
  matchBrackets: CodeMirrorLanguage_matchBrackets,
  sublanguageProp: CodeMirrorLanguage_sublanguageProp,
  syntaxHighlighting: CodeMirrorLanguage_syntaxHighlighting,
  syntaxParserRunning: CodeMirrorLanguage_syntaxParserRunning,
  syntaxTree: CodeMirrorLanguage_syntaxTree,
  syntaxTreeAvailable: CodeMirrorLanguage_syntaxTreeAvailable,
  toggleFold: CodeMirrorLanguage_toggleFold,
  unfoldAll: CodeMirrorLanguage_unfoldAll,
  unfoldCode: CodeMirrorLanguage_unfoldCode,
  unfoldEffect: CodeMirrorLanguage_unfoldEffect
};
import {
  blockComment as CodeMirrorCommands_blockComment, blockUncomment as CodeMirrorCommands_blockUncomment, copyLineDown as CodeMirrorCommands_copyLineDown,
  copyLineUp as CodeMirrorCommands_copyLineUp, cursorCharBackward as CodeMirrorCommands_cursorCharBackward, cursorCharBackwardLogical as CodeMirrorCommands_cursorCharBackwardLogical,
  cursorCharForward as CodeMirrorCommands_cursorCharForward, cursorCharForwardLogical as CodeMirrorCommands_cursorCharForwardLogical, cursorCharLeft as CodeMirrorCommands_cursorCharLeft,
  cursorCharRight as CodeMirrorCommands_cursorCharRight, cursorDocEnd as CodeMirrorCommands_cursorDocEnd, cursorDocStart as CodeMirrorCommands_cursorDocStart,
  cursorGroupBackward as CodeMirrorCommands_cursorGroupBackward, cursorGroupForward as CodeMirrorCommands_cursorGroupForward, cursorGroupForwardWin as CodeMirrorCommands_cursorGroupForwardWin,
  cursorGroupLeft as CodeMirrorCommands_cursorGroupLeft, cursorGroupRight as CodeMirrorCommands_cursorGroupRight, cursorLineBoundaryBackward as CodeMirrorCommands_cursorLineBoundaryBackward,
  cursorLineBoundaryForward as CodeMirrorCommands_cursorLineBoundaryForward, cursorLineBoundaryLeft as CodeMirrorCommands_cursorLineBoundaryLeft, cursorLineBoundaryRight as CodeMirrorCommands_cursorLineBoundaryRight,
  cursorLineDown as CodeMirrorCommands_cursorLineDown, cursorLineEnd as CodeMirrorCommands_cursorLineEnd, cursorLineStart as CodeMirrorCommands_cursorLineStart,
  cursorLineUp as CodeMirrorCommands_cursorLineUp, cursorMatchingBracket as CodeMirrorCommands_cursorMatchingBracket, cursorPageDown as CodeMirrorCommands_cursorPageDown,
  cursorPageUp as CodeMirrorCommands_cursorPageUp, cursorSubwordBackward as CodeMirrorCommands_cursorSubwordBackward, cursorSubwordForward as CodeMirrorCommands_cursorSubwordForward,
  cursorSyntaxLeft as CodeMirrorCommands_cursorSyntaxLeft, cursorSyntaxRight as CodeMirrorCommands_cursorSyntaxRight, defaultKeymap as CodeMirrorCommands_defaultKeymap,
  deleteCharBackward as CodeMirrorCommands_deleteCharBackward, deleteCharBackwardStrict as CodeMirrorCommands_deleteCharBackwardStrict, deleteCharForward as CodeMirrorCommands_deleteCharForward,
  deleteGroupBackward as CodeMirrorCommands_deleteGroupBackward, deleteGroupForward as CodeMirrorCommands_deleteGroupForward, deleteLine as CodeMirrorCommands_deleteLine,
  deleteLineBoundaryBackward as CodeMirrorCommands_deleteLineBoundaryBackward, deleteLineBoundaryForward as CodeMirrorCommands_deleteLineBoundaryForward, deleteToLineEnd as CodeMirrorCommands_deleteToLineEnd,
  deleteToLineStart as CodeMirrorCommands_deleteToLineStart, deleteTrailingWhitespace as CodeMirrorCommands_deleteTrailingWhitespace, emacsStyleKeymap as CodeMirrorCommands_emacsStyleKeymap,
  history as CodeMirrorCommands_history, historyField as CodeMirrorCommands_historyField, historyKeymap as CodeMirrorCommands_historyKeymap,
  indentLess as CodeMirrorCommands_indentLess, indentMore as CodeMirrorCommands_indentMore, indentSelection as CodeMirrorCommands_indentSelection,
  indentWithTab as CodeMirrorCommands_indentWithTab, insertBlankLine as CodeMirrorCommands_insertBlankLine, insertNewline as CodeMirrorCommands_insertNewline,
  insertNewlineAndIndent as CodeMirrorCommands_insertNewlineAndIndent, insertNewlineKeepIndent as CodeMirrorCommands_insertNewlineKeepIndent, insertTab as CodeMirrorCommands_insertTab,
  invertedEffects as CodeMirrorCommands_invertedEffects, isolateHistory as CodeMirrorCommands_isolateHistory, lineComment as CodeMirrorCommands_lineComment,
  lineUncomment as CodeMirrorCommands_lineUncomment, moveLineDown as CodeMirrorCommands_moveLineDown, moveLineUp as CodeMirrorCommands_moveLineUp,
  redo as CodeMirrorCommands_redo, redoDepth as CodeMirrorCommands_redoDepth, redoSelection as CodeMirrorCommands_redoSelection,
  selectAll as CodeMirrorCommands_selectAll, selectCharBackward as CodeMirrorCommands_selectCharBackward, selectCharBackwardLogical as CodeMirrorCommands_selectCharBackwardLogical,
  selectCharForward as CodeMirrorCommands_selectCharForward, selectCharForwardLogical as CodeMirrorCommands_selectCharForwardLogical, selectCharLeft as CodeMirrorCommands_selectCharLeft,
  selectCharRight as CodeMirrorCommands_selectCharRight, selectDocEnd as CodeMirrorCommands_selectDocEnd, selectDocStart as CodeMirrorCommands_selectDocStart,
  selectGroupBackward as CodeMirrorCommands_selectGroupBackward, selectGroupForward as CodeMirrorCommands_selectGroupForward, selectGroupForwardWin as CodeMirrorCommands_selectGroupForwardWin,
  selectGroupLeft as CodeMirrorCommands_selectGroupLeft, selectGroupRight as CodeMirrorCommands_selectGroupRight, selectLine as CodeMirrorCommands_selectLine,
  selectLineBoundaryBackward as CodeMirrorCommands_selectLineBoundaryBackward, selectLineBoundaryForward as CodeMirrorCommands_selectLineBoundaryForward, selectLineBoundaryLeft as CodeMirrorCommands_selectLineBoundaryLeft,
  selectLineBoundaryRight as CodeMirrorCommands_selectLineBoundaryRight, selectLineDown as CodeMirrorCommands_selectLineDown, selectLineEnd as CodeMirrorCommands_selectLineEnd,
  selectLineStart as CodeMirrorCommands_selectLineStart, selectLineUp as CodeMirrorCommands_selectLineUp, selectMatchingBracket as CodeMirrorCommands_selectMatchingBracket,
  selectPageDown as CodeMirrorCommands_selectPageDown, selectPageUp as CodeMirrorCommands_selectPageUp, selectParentSyntax as CodeMirrorCommands_selectParentSyntax,
  selectSubwordBackward as CodeMirrorCommands_selectSubwordBackward, selectSubwordForward as CodeMirrorCommands_selectSubwordForward, selectSyntaxLeft as CodeMirrorCommands_selectSyntaxLeft,
  selectSyntaxRight as CodeMirrorCommands_selectSyntaxRight, simplifySelection as CodeMirrorCommands_simplifySelection, splitLine as CodeMirrorCommands_splitLine,
  standardKeymap as CodeMirrorCommands_standardKeymap, temporarilySetTabFocusMode as CodeMirrorCommands_temporarilySetTabFocusMode, toggleBlockComment as CodeMirrorCommands_toggleBlockComment,
  toggleBlockCommentByLine as CodeMirrorCommands_toggleBlockCommentByLine, toggleComment as CodeMirrorCommands_toggleComment, toggleLineComment as CodeMirrorCommands_toggleLineComment,
  toggleTabFocusMode as CodeMirrorCommands_toggleTabFocusMode, transposeChars as CodeMirrorCommands_transposeChars, undo as CodeMirrorCommands_undo,
  undoDepth as CodeMirrorCommands_undoDepth, undoSelection as CodeMirrorCommands_undoSelection
} from "@codemirror/commands";
const CodeMirrorCommands = {
  blockComment: CodeMirrorCommands_blockComment,
  blockUncomment: CodeMirrorCommands_blockUncomment,
  copyLineDown: CodeMirrorCommands_copyLineDown,
  copyLineUp: CodeMirrorCommands_copyLineUp,
  cursorCharBackward: CodeMirrorCommands_cursorCharBackward,
  cursorCharBackwardLogical: CodeMirrorCommands_cursorCharBackwardLogical,
  cursorCharForward: CodeMirrorCommands_cursorCharForward,
  cursorCharForwardLogical: CodeMirrorCommands_cursorCharForwardLogical,
  cursorCharLeft: CodeMirrorCommands_cursorCharLeft,
  cursorCharRight: CodeMirrorCommands_cursorCharRight,
  cursorDocEnd: CodeMirrorCommands_cursorDocEnd,
  cursorDocStart: CodeMirrorCommands_cursorDocStart,
  cursorGroupBackward: CodeMirrorCommands_cursorGroupBackward,
  cursorGroupForward: CodeMirrorCommands_cursorGroupForward,
  cursorGroupForwardWin: CodeMirrorCommands_cursorGroupForwardWin,
  cursorGroupLeft: CodeMirrorCommands_cursorGroupLeft,
  cursorGroupRight: CodeMirrorCommands_cursorGroupRight,
  cursorLineBoundaryBackward: CodeMirrorCommands_cursorLineBoundaryBackward,
  cursorLineBoundaryForward: CodeMirrorCommands_cursorLineBoundaryForward,
  cursorLineBoundaryLeft: CodeMirrorCommands_cursorLineBoundaryLeft,
  cursorLineBoundaryRight: CodeMirrorCommands_cursorLineBoundaryRight,
  cursorLineDown: CodeMirrorCommands_cursorLineDown,
  cursorLineEnd: CodeMirrorCommands_cursorLineEnd,
  cursorLineStart: CodeMirrorCommands_cursorLineStart,
  cursorLineUp: CodeMirrorCommands_cursorLineUp,
  cursorMatchingBracket: CodeMirrorCommands_cursorMatchingBracket,
  cursorPageDown: CodeMirrorCommands_cursorPageDown,
  cursorPageUp: CodeMirrorCommands_cursorPageUp,
  cursorSubwordBackward: CodeMirrorCommands_cursorSubwordBackward,
  cursorSubwordForward: CodeMirrorCommands_cursorSubwordForward,
  cursorSyntaxLeft: CodeMirrorCommands_cursorSyntaxLeft,
  cursorSyntaxRight: CodeMirrorCommands_cursorSyntaxRight,
  defaultKeymap: CodeMirrorCommands_defaultKeymap,
  deleteCharBackward: CodeMirrorCommands_deleteCharBackward,
  deleteCharBackwardStrict: CodeMirrorCommands_deleteCharBackwardStrict,
  deleteCharForward: CodeMirrorCommands_deleteCharForward,
  deleteGroupBackward: CodeMirrorCommands_deleteGroupBackward,
  deleteGroupForward: CodeMirrorCommands_deleteGroupForward,
  deleteLine: CodeMirrorCommands_deleteLine,
  deleteLineBoundaryBackward: CodeMirrorCommands_deleteLineBoundaryBackward,
  deleteLineBoundaryForward: CodeMirrorCommands_deleteLineBoundaryForward,
  deleteToLineEnd: CodeMirrorCommands_deleteToLineEnd,
  deleteToLineStart: CodeMirrorCommands_deleteToLineStart,
  deleteTrailingWhitespace: CodeMirrorCommands_deleteTrailingWhitespace,
  emacsStyleKeymap: CodeMirrorCommands_emacsStyleKeymap,
  history: CodeMirrorCommands_history,
  historyField: CodeMirrorCommands_historyField,
  historyKeymap: CodeMirrorCommands_historyKeymap,
  indentLess: CodeMirrorCommands_indentLess,
  indentMore: CodeMirrorCommands_indentMore,
  indentSelection: CodeMirrorCommands_indentSelection,
  indentWithTab: CodeMirrorCommands_indentWithTab,
  insertBlankLine: CodeMirrorCommands_insertBlankLine,
  insertNewline: CodeMirrorCommands_insertNewline,
  insertNewlineAndIndent: CodeMirrorCommands_insertNewlineAndIndent,
  insertNewlineKeepIndent: CodeMirrorCommands_insertNewlineKeepIndent,
  insertTab: CodeMirrorCommands_insertTab,
  invertedEffects: CodeMirrorCommands_invertedEffects,
  isolateHistory: CodeMirrorCommands_isolateHistory,
  lineComment: CodeMirrorCommands_lineComment,
  lineUncomment: CodeMirrorCommands_lineUncomment,
  moveLineDown: CodeMirrorCommands_moveLineDown,
  moveLineUp: CodeMirrorCommands_moveLineUp,
  redo: CodeMirrorCommands_redo,
  redoDepth: CodeMirrorCommands_redoDepth,
  redoSelection: CodeMirrorCommands_redoSelection,
  selectAll: CodeMirrorCommands_selectAll,
  selectCharBackward: CodeMirrorCommands_selectCharBackward,
  selectCharBackwardLogical: CodeMirrorCommands_selectCharBackwardLogical,
  selectCharForward: CodeMirrorCommands_selectCharForward,
  selectCharForwardLogical: CodeMirrorCommands_selectCharForwardLogical,
  selectCharLeft: CodeMirrorCommands_selectCharLeft,
  selectCharRight: CodeMirrorCommands_selectCharRight,
  selectDocEnd: CodeMirrorCommands_selectDocEnd,
  selectDocStart: CodeMirrorCommands_selectDocStart,
  selectGroupBackward: CodeMirrorCommands_selectGroupBackward,
  selectGroupForward: CodeMirrorCommands_selectGroupForward,
  selectGroupForwardWin: CodeMirrorCommands_selectGroupForwardWin,
  selectGroupLeft: CodeMirrorCommands_selectGroupLeft,
  selectGroupRight: CodeMirrorCommands_selectGroupRight,
  selectLine: CodeMirrorCommands_selectLine,
  selectLineBoundaryBackward: CodeMirrorCommands_selectLineBoundaryBackward,
  selectLineBoundaryForward: CodeMirrorCommands_selectLineBoundaryForward,
  selectLineBoundaryLeft: CodeMirrorCommands_selectLineBoundaryLeft,
  selectLineBoundaryRight: CodeMirrorCommands_selectLineBoundaryRight,
  selectLineDown: CodeMirrorCommands_selectLineDown,
  selectLineEnd: CodeMirrorCommands_selectLineEnd,
  selectLineStart: CodeMirrorCommands_selectLineStart,
  selectLineUp: CodeMirrorCommands_selectLineUp,
  selectMatchingBracket: CodeMirrorCommands_selectMatchingBracket,
  selectPageDown: CodeMirrorCommands_selectPageDown,
  selectPageUp: CodeMirrorCommands_selectPageUp,
  selectParentSyntax: CodeMirrorCommands_selectParentSyntax,
  selectSubwordBackward: CodeMirrorCommands_selectSubwordBackward,
  selectSubwordForward: CodeMirrorCommands_selectSubwordForward,
  selectSyntaxLeft: CodeMirrorCommands_selectSyntaxLeft,
  selectSyntaxRight: CodeMirrorCommands_selectSyntaxRight,
  simplifySelection: CodeMirrorCommands_simplifySelection,
  splitLine: CodeMirrorCommands_splitLine,
  standardKeymap: CodeMirrorCommands_standardKeymap,
  temporarilySetTabFocusMode: CodeMirrorCommands_temporarilySetTabFocusMode,
  toggleBlockComment: CodeMirrorCommands_toggleBlockComment,
  toggleBlockCommentByLine: CodeMirrorCommands_toggleBlockCommentByLine,
  toggleComment: CodeMirrorCommands_toggleComment,
  toggleLineComment: CodeMirrorCommands_toggleLineComment,
  toggleTabFocusMode: CodeMirrorCommands_toggleTabFocusMode,
  transposeChars: CodeMirrorCommands_transposeChars,
  undo: CodeMirrorCommands_undo,
  undoDepth: CodeMirrorCommands_undoDepth,
  undoSelection: CodeMirrorCommands_undoSelection
};
import moment from "moment";

import {
  Component as ComponentExports_Component
} from "./component";
const ComponentExports = () => ({
  Component: ComponentExports_Component
});
import {
  CommandRegistry as CommandExports_CommandRegistry, Keymap as CommandExports_Keymap, Scope as CommandExports_Scope,
  installPluginCommandApi as CommandExports_installPluginCommandApi, makeHotkey as CommandExports_makeHotkey
} from "./commands";
const CommandExports = () => ({
  CommandRegistry: CommandExports_CommandRegistry,
  Keymap: CommandExports_Keymap,
  Scope: CommandExports_Scope,
  installPluginCommandApi: CommandExports_installPluginCommandApi,
  makeHotkey: CommandExports_makeHotkey
});
import {
  ACCOUNT_SESSION_KEY as AccountExports_ACCOUNT_SESSION_KEY, AccountClient as AccountExports_AccountClient, AccountRequestError as AccountExports_AccountRequestError
} from "./account";
const AccountExports = () => ({
  ACCOUNT_SESSION_KEY: AccountExports_ACCOUNT_SESSION_KEY,
  AccountClient: AccountExports_AccountClient,
  AccountRequestError: AccountExports_AccountRequestError
});
import {
  FileManager as FileManagerExports_FileManager
} from "./file-manager";
const FileManagerExports = () => ({
  FileManager: FileManagerExports_FileManager
});
import {
  Editor as EditorExports_Editor
} from "./editor";
const EditorExports = () => ({
  Editor: EditorExports_Editor
});
import {
  createDiv as DomExports_createDiv, createEl as DomExports_createEl, createSpan as DomExports_createSpan,
  empty as DomExports_empty, installDomExtensions as DomExports_installDomExtensions, sanitizeHTMLToDom as DomExports_sanitizeHTMLToDom,
  setAttr as DomExports_setAttr, setAttrs as DomExports_setAttrs, setCssProps as DomExports_setCssProps
} from "./dom";
const DomExports = () => ({
  createDiv: DomExports_createDiv,
  createEl: DomExports_createEl,
  createSpan: DomExports_createSpan,
  empty: DomExports_empty,
  installDomExtensions: DomExports_installDomExtensions,
  sanitizeHTMLToDom: DomExports_sanitizeHTMLToDom,
  setAttr: DomExports_setAttr,
  setAttrs: DomExports_setAttrs,
  setCssProps: DomExports_setCssProps
});
import {
  Events as EventExports_Events, detachEventRef as EventExports_detachEventRef
} from "./events";
const EventExports = () => ({
  Events: EventExports_Events,
  detachEventRef: EventExports_detachEventRef
});
import {
  MarkdownPreviewRenderer as MarkdownExports_MarkdownPreviewRenderer, MarkdownRenderChild as MarkdownExports_MarkdownRenderChild, MarkdownRenderer as MarkdownExports_MarkdownRenderer,
  getRenderedSectionInformation as MarkdownExports_getRenderedSectionInformation, registerFileEmbedRenderer as MarkdownExports_registerFileEmbedRenderer, toggleTaskLine as MarkdownExports_toggleTaskLine
} from "./markdown";
const MarkdownExports = () => ({
  MarkdownPreviewRenderer: MarkdownExports_MarkdownPreviewRenderer,
  MarkdownRenderChild: MarkdownExports_MarkdownRenderChild,
  MarkdownRenderer: MarkdownExports_MarkdownRenderer,
  getRenderedSectionInformation: MarkdownExports_getRenderedSectionInformation,
  registerFileEmbedRenderer: MarkdownExports_registerFileEmbedRenderer,
  toggleTaskLine: MarkdownExports_toggleTaskLine
});
import {
  MetadataCache as MetadataExports_MetadataCache, getAllTags as MetadataExports_getAllTags, getFrontMatterInfo as MetadataExports_getFrontMatterInfo,
  parseCanvasReferences as MetadataExports_parseCanvasReferences, parseMarkdownMetadata as MetadataExports_parseMarkdownMetadata
} from "./metadata-cache";
const MetadataExports = () => ({
  MetadataCache: MetadataExports_MetadataCache,
  getAllTags: MetadataExports_getAllTags,
  getFrontMatterInfo: MetadataExports_getFrontMatterInfo,
  parseCanvasReferences: MetadataExports_parseCanvasReferences,
  parseMarkdownMetadata: MetadataExports_parseMarkdownMetadata
});
import {
  ACCOUNT_SESSION_KEY as ObsidianExports_ACCOUNT_SESSION_KEY, AbstractInputSuggest as ObsidianExports_AbstractInputSuggest, AbstractTextComponent as ObsidianExports_AbstractTextComponent,
  AccountClient as ObsidianExports_AccountClient, AccountRequestError as ObsidianExports_AccountRequestError, App as ObsidianExports_App,
  BaseComponent as ObsidianExports_BaseComponent, BasesEntry as ObsidianExports_BasesEntry, BasesEntryGroup as ObsidianExports_BasesEntryGroup,
  BasesQueryResult as ObsidianExports_BasesQueryResult, BasesView as ObsidianExports_BasesView, BasesViewConfig as ObsidianExports_BasesViewConfig,
  BooleanValue as ObsidianExports_BooleanValue, ButtonComponent as ObsidianExports_ButtonComponent, CapacitorAdapter as ObsidianExports_CapacitorAdapter,
  ColorComponent as ObsidianExports_ColorComponent, CommandRegistry as ObsidianExports_CommandRegistry, Component as ObsidianExports_Component,
  ConfirmationButton as ObsidianExports_ConfirmationButton, ConfirmationModal as ObsidianExports_ConfirmationModal, DateValue as ObsidianExports_DateValue,
  DisplayValueComponent as ObsidianExports_DisplayValueComponent, DropdownComponent as ObsidianExports_DropdownComponent, DurationValue as ObsidianExports_DurationValue,
  EditableFileView as ObsidianExports_EditableFileView, Editor as ObsidianExports_Editor, EditorSuggest as ObsidianExports_EditorSuggest,
  Events as ObsidianExports_Events, ExtraButtonComponent as ObsidianExports_ExtraButtonComponent, FileManager as ObsidianExports_FileManager,
  FileSystemAdapter as ObsidianExports_FileSystemAdapter, FileValue as ObsidianExports_FileValue, FileView as ObsidianExports_FileView,
  FuzzySuggestModal as ObsidianExports_FuzzySuggestModal, HTMLValue as ObsidianExports_HTMLValue, HoverPopover as ObsidianExports_HoverPopover,
  IconValue as ObsidianExports_IconValue, ImageValue as ObsidianExports_ImageValue, ItemView as ObsidianExports_ItemView,
  Keymap as ObsidianExports_Keymap, LinkValue as ObsidianExports_LinkValue, ListValue as ObsidianExports_ListValue,
  MarkdownEditView as ObsidianExports_MarkdownEditView, MarkdownPreviewRenderer as ObsidianExports_MarkdownPreviewRenderer, MarkdownPreviewView as ObsidianExports_MarkdownPreviewView,
  MarkdownRenderChild as ObsidianExports_MarkdownRenderChild, MarkdownRenderer as ObsidianExports_MarkdownRenderer, MarkdownView as ObsidianExports_MarkdownView,
  Menu as ObsidianExports_Menu, MenuItem as ObsidianExports_MenuItem, MenuSeparator as ObsidianExports_MenuSeparator,
  MetadataCache as ObsidianExports_MetadataCache, Modal as ObsidianExports_Modal, MomentFormatComponent as ObsidianExports_MomentFormatComponent,
  NodeDataAdapter as ObsidianExports_NodeDataAdapter, NotNullValue as ObsidianExports_NotNullValue, Notice as ObsidianExports_Notice,
  NullValue as ObsidianExports_NullValue, NumberValue as ObsidianExports_NumberValue, ObjectValue as ObsidianExports_ObjectValue,
  Platform as ObsidianExports_Platform, Plugin as ObsidianExports_Plugin, PluginManager as ObsidianExports_PluginManager,
  PluginSettingTab as ObsidianExports_PluginSettingTab, PopoverState as ObsidianExports_PopoverState, PopoverSuggest as ObsidianExports_PopoverSuggest,
  PrimitiveValue as ObsidianExports_PrimitiveValue, ProgressBarComponent as ObsidianExports_ProgressBarComponent, PublishClient as ObsidianExports_PublishClient,
  QueryController as ObsidianExports_QueryController, RegExpValue as ObsidianExports_RegExpValue, RelativeDateValue as ObsidianExports_RelativeDateValue,
  RenderContext as ObsidianExports_RenderContext, RuntimeHost as ObsidianExports_RuntimeHost, Scope as ObsidianExports_Scope,
  SearchComponent as ObsidianExports_SearchComponent, SecretComponent as ObsidianExports_SecretComponent, SecretStorage as ObsidianExports_SecretStorage,
  Setting as ObsidianExports_Setting, SettingGroup as ObsidianExports_SettingGroup, SettingPage as ObsidianExports_SettingPage,
  SettingTab as ObsidianExports_SettingTab, SliderComponent as ObsidianExports_SliderComponent, StringValue as ObsidianExports_StringValue,
  SuggestComponent as ObsidianExports_SuggestComponent, SuggestModal as ObsidianExports_SuggestModal, SyncHistoryApi as ObsidianExports_SyncHistoryApi,
  SyncHttpClient as ObsidianExports_SyncHttpClient, SyncInitialTransferEngine as ObsidianExports_SyncInitialTransferEngine, SyncSocketClient as ObsidianExports_SyncSocketClient,
  SyncTransportError as ObsidianExports_SyncTransportError, TAbstractFile as ObsidianExports_TAbstractFile, TFile as ObsidianExports_TFile,
  TFolder as ObsidianExports_TFolder, TagValue as ObsidianExports_TagValue, Tasks as ObsidianExports_Tasks,
  TextAreaComponent as ObsidianExports_TextAreaComponent, TextComponent as ObsidianExports_TextComponent, TextFileView as ObsidianExports_TextFileView,
  ToggleComponent as ObsidianExports_ToggleComponent, UrlValue as ObsidianExports_UrlValue, Value as ObsidianExports_Value,
  ValueComponent as ObsidianExports_ValueComponent, Vault as ObsidianExports_Vault, VaultFileWatcher as ObsidianExports_VaultFileWatcher,
  View as ObsidianExports_View, Workspace as ObsidianExports_Workspace, WorkspaceContainer as ObsidianExports_WorkspaceContainer,
  WorkspaceFloating as ObsidianExports_WorkspaceFloating, WorkspaceItem as ObsidianExports_WorkspaceItem, WorkspaceLeaf as ObsidianExports_WorkspaceLeaf,
  WorkspaceMobileDrawer as ObsidianExports_WorkspaceMobileDrawer, WorkspaceParent as ObsidianExports_WorkspaceParent, WorkspaceRibbon as ObsidianExports_WorkspaceRibbon,
  WorkspaceRoot as ObsidianExports_WorkspaceRoot, WorkspaceSidedock as ObsidianExports_WorkspaceSidedock, WorkspaceSplit as ObsidianExports_WorkspaceSplit,
  WorkspaceTabs as ObsidianExports_WorkspaceTabs, WorkspaceWindow as ObsidianExports_WorkspaceWindow, addIcon as ObsidianExports_addIcon,
  apiVersion as ObsidianExports_apiVersion, arrayBufferToBase64 as ObsidianExports_arrayBufferToBase64, arrayBufferToHex as ObsidianExports_arrayBufferToHex,
  base64ToArrayBuffer as ObsidianExports_base64ToArrayBuffer, createDiv as ObsidianExports_createDiv, createEl as ObsidianExports_createEl,
  createSpan as ObsidianExports_createSpan, createSyncEncryptionProvider as ObsidianExports_createSyncEncryptionProvider, debounce as ObsidianExports_debounce,
  deriveSyncKeyHash as ObsidianExports_deriveSyncKeyHash, deriveSyncPasswordKey as ObsidianExports_deriveSyncPasswordKey, displayTooltip as ObsidianExports_displayTooltip,
  editorEditorField as ObsidianExports_editorEditorField, editorInfoField as ObsidianExports_editorInfoField, editorLivePreviewField as ObsidianExports_editorLivePreviewField,
  editorViewField as ObsidianExports_editorViewField, empty as ObsidianExports_empty, finishRenderMath as ObsidianExports_finishRenderMath,
  getAllTags as ObsidianExports_getAllTags, getBlobArrayBuffer as ObsidianExports_getBlobArrayBuffer, getFrontMatterInfo as ObsidianExports_getFrontMatterInfo,
  getIcon as ObsidianExports_getIcon, getIconIds as ObsidianExports_getIconIds, getLanguage as ObsidianExports_getLanguage,
  getLinkpath as ObsidianExports_getLinkpath, hexToArrayBuffer as ObsidianExports_hexToArrayBuffer, htmlToMarkdown as ObsidianExports_htmlToMarkdown,
  installDomExtensions as ObsidianExports_installDomExtensions, iterateCacheRefs as ObsidianExports_iterateCacheRefs, iterateRefs as ObsidianExports_iterateRefs,
  livePreviewState as ObsidianExports_livePreviewState, loadMathJax as ObsidianExports_loadMathJax, loadMermaid as ObsidianExports_loadMermaid,
  loadPdfJs as ObsidianExports_loadPdfJs, loadPrism as ObsidianExports_loadPrism, makeHotkey as ObsidianExports_makeHotkey, moment as ObsidianExports_moment,
  normalizePath as ObsidianExports_normalizePath, parseFrontMatterAliases as ObsidianExports_parseFrontMatterAliases, parseFrontMatterEntry as ObsidianExports_parseFrontMatterEntry,
  parseFrontMatterStringArray as ObsidianExports_parseFrontMatterStringArray, parseFrontMatterTags as ObsidianExports_parseFrontMatterTags, parseLinktext as ObsidianExports_parseLinktext,
  parseMarkdownMetadata as ObsidianExports_parseMarkdownMetadata, parsePropertyId as ObsidianExports_parsePropertyId, parseYaml as ObsidianExports_parseYaml,
  prepareFuzzySearch as ObsidianExports_prepareFuzzySearch, prepareSimpleSearch as ObsidianExports_prepareSimpleSearch, removeIcon as ObsidianExports_removeIcon,
  renderMatches as ObsidianExports_renderMatches, renderMath as ObsidianExports_renderMath, renderResults as ObsidianExports_renderResults,
  request as ObsidianExports_request, requestUrl as ObsidianExports_requestUrl, requireApiVersion as ObsidianExports_requireApiVersion,
  resolveSubpath as ObsidianExports_resolveSubpath, sanitizeHTMLToDom as ObsidianExports_sanitizeHTMLToDom, setAttr as ObsidianExports_setAttr,
  setAttrs as ObsidianExports_setAttrs, setCssProps as ObsidianExports_setCssProps, setIcon as ObsidianExports_setIcon,
  setTooltip as ObsidianExports_setTooltip, sortSearchResults as ObsidianExports_sortSearchResults, stringifyYaml as ObsidianExports_stringifyYaml,
  stripHeading as ObsidianExports_stripHeading, stripHeadingForLink as ObsidianExports_stripHeadingForLink, wrapValue as ObsidianExports_wrapValue
} from "./obsidian";
const ObsidianExports = () => ({
  ACCOUNT_SESSION_KEY: ObsidianExports_ACCOUNT_SESSION_KEY,
  AbstractInputSuggest: ObsidianExports_AbstractInputSuggest,
  AbstractTextComponent: ObsidianExports_AbstractTextComponent,
  AccountClient: ObsidianExports_AccountClient,
  AccountRequestError: ObsidianExports_AccountRequestError,
  App: ObsidianExports_App,
  BaseComponent: ObsidianExports_BaseComponent,
  BasesEntry: ObsidianExports_BasesEntry,
  BasesEntryGroup: ObsidianExports_BasesEntryGroup,
  BasesQueryResult: ObsidianExports_BasesQueryResult,
  BasesView: ObsidianExports_BasesView,
  BasesViewConfig: ObsidianExports_BasesViewConfig,
  BooleanValue: ObsidianExports_BooleanValue,
  ButtonComponent: ObsidianExports_ButtonComponent,
  CapacitorAdapter: ObsidianExports_CapacitorAdapter,
  ColorComponent: ObsidianExports_ColorComponent,
  CommandRegistry: ObsidianExports_CommandRegistry,
  Component: ObsidianExports_Component,
  ConfirmationButton: ObsidianExports_ConfirmationButton,
  ConfirmationModal: ObsidianExports_ConfirmationModal,
  DateValue: ObsidianExports_DateValue,
  DisplayValueComponent: ObsidianExports_DisplayValueComponent,
  DropdownComponent: ObsidianExports_DropdownComponent,
  DurationValue: ObsidianExports_DurationValue,
  EditableFileView: ObsidianExports_EditableFileView,
  Editor: ObsidianExports_Editor,
  EditorSuggest: ObsidianExports_EditorSuggest,
  Events: ObsidianExports_Events,
  ExtraButtonComponent: ObsidianExports_ExtraButtonComponent,
  FileManager: ObsidianExports_FileManager,
  FileSystemAdapter: ObsidianExports_FileSystemAdapter,
  FileValue: ObsidianExports_FileValue,
  FileView: ObsidianExports_FileView,
  FuzzySuggestModal: ObsidianExports_FuzzySuggestModal,
  HTMLValue: ObsidianExports_HTMLValue,
  HoverPopover: ObsidianExports_HoverPopover,
  IconValue: ObsidianExports_IconValue,
  ImageValue: ObsidianExports_ImageValue,
  ItemView: ObsidianExports_ItemView,
  Keymap: ObsidianExports_Keymap,
  LinkValue: ObsidianExports_LinkValue,
  ListValue: ObsidianExports_ListValue,
  MarkdownEditView: ObsidianExports_MarkdownEditView,
  MarkdownPreviewRenderer: ObsidianExports_MarkdownPreviewRenderer,
  MarkdownPreviewView: ObsidianExports_MarkdownPreviewView,
  MarkdownRenderChild: ObsidianExports_MarkdownRenderChild,
  MarkdownRenderer: ObsidianExports_MarkdownRenderer,
  MarkdownView: ObsidianExports_MarkdownView,
  Menu: ObsidianExports_Menu,
  MenuItem: ObsidianExports_MenuItem,
  MenuSeparator: ObsidianExports_MenuSeparator,
  MetadataCache: ObsidianExports_MetadataCache,
  Modal: ObsidianExports_Modal,
  MomentFormatComponent: ObsidianExports_MomentFormatComponent,
  NodeDataAdapter: ObsidianExports_NodeDataAdapter,
  NotNullValue: ObsidianExports_NotNullValue,
  Notice: ObsidianExports_Notice,
  NullValue: ObsidianExports_NullValue,
  NumberValue: ObsidianExports_NumberValue,
  ObjectValue: ObsidianExports_ObjectValue,
  Platform: ObsidianExports_Platform,
  Plugin: ObsidianExports_Plugin,
  PluginManager: ObsidianExports_PluginManager,
  PluginSettingTab: ObsidianExports_PluginSettingTab,
  PopoverState: ObsidianExports_PopoverState,
  PopoverSuggest: ObsidianExports_PopoverSuggest,
  PrimitiveValue: ObsidianExports_PrimitiveValue,
  ProgressBarComponent: ObsidianExports_ProgressBarComponent,
  PublishClient: ObsidianExports_PublishClient,
  QueryController: ObsidianExports_QueryController,
  RegExpValue: ObsidianExports_RegExpValue,
  RelativeDateValue: ObsidianExports_RelativeDateValue,
  RenderContext: ObsidianExports_RenderContext,
  RuntimeHost: ObsidianExports_RuntimeHost,
  Scope: ObsidianExports_Scope,
  SearchComponent: ObsidianExports_SearchComponent,
  SecretComponent: ObsidianExports_SecretComponent,
  SecretStorage: ObsidianExports_SecretStorage,
  Setting: ObsidianExports_Setting,
  SettingGroup: ObsidianExports_SettingGroup,
  SettingPage: ObsidianExports_SettingPage,
  SettingTab: ObsidianExports_SettingTab,
  SliderComponent: ObsidianExports_SliderComponent,
  StringValue: ObsidianExports_StringValue,
  SuggestComponent: ObsidianExports_SuggestComponent,
  SuggestModal: ObsidianExports_SuggestModal,
  SyncHistoryApi: ObsidianExports_SyncHistoryApi,
  SyncHttpClient: ObsidianExports_SyncHttpClient,
  SyncInitialTransferEngine: ObsidianExports_SyncInitialTransferEngine,
  SyncSocketClient: ObsidianExports_SyncSocketClient,
  SyncTransportError: ObsidianExports_SyncTransportError,
  TAbstractFile: ObsidianExports_TAbstractFile,
  TFile: ObsidianExports_TFile,
  TFolder: ObsidianExports_TFolder,
  TagValue: ObsidianExports_TagValue,
  Tasks: ObsidianExports_Tasks,
  TextAreaComponent: ObsidianExports_TextAreaComponent,
  TextComponent: ObsidianExports_TextComponent,
  TextFileView: ObsidianExports_TextFileView,
  ToggleComponent: ObsidianExports_ToggleComponent,
  UrlValue: ObsidianExports_UrlValue,
  Value: ObsidianExports_Value,
  ValueComponent: ObsidianExports_ValueComponent,
  Vault: ObsidianExports_Vault,
  VaultFileWatcher: ObsidianExports_VaultFileWatcher,
  View: ObsidianExports_View,
  Workspace: ObsidianExports_Workspace,
  WorkspaceContainer: ObsidianExports_WorkspaceContainer,
  WorkspaceFloating: ObsidianExports_WorkspaceFloating,
  WorkspaceItem: ObsidianExports_WorkspaceItem,
  WorkspaceLeaf: ObsidianExports_WorkspaceLeaf,
  WorkspaceMobileDrawer: ObsidianExports_WorkspaceMobileDrawer,
  WorkspaceParent: ObsidianExports_WorkspaceParent,
  WorkspaceRibbon: ObsidianExports_WorkspaceRibbon,
  WorkspaceRoot: ObsidianExports_WorkspaceRoot,
  WorkspaceSidedock: ObsidianExports_WorkspaceSidedock,
  WorkspaceSplit: ObsidianExports_WorkspaceSplit,
  WorkspaceTabs: ObsidianExports_WorkspaceTabs,
  WorkspaceWindow: ObsidianExports_WorkspaceWindow,
  addIcon: ObsidianExports_addIcon,
  apiVersion: ObsidianExports_apiVersion,
  arrayBufferToBase64: ObsidianExports_arrayBufferToBase64,
  arrayBufferToHex: ObsidianExports_arrayBufferToHex,
  base64ToArrayBuffer: ObsidianExports_base64ToArrayBuffer,
  createDiv: ObsidianExports_createDiv,
  createEl: ObsidianExports_createEl,
  createSpan: ObsidianExports_createSpan,
  createSyncEncryptionProvider: ObsidianExports_createSyncEncryptionProvider,
  debounce: ObsidianExports_debounce,
  deriveSyncKeyHash: ObsidianExports_deriveSyncKeyHash,
  deriveSyncPasswordKey: ObsidianExports_deriveSyncPasswordKey,
  displayTooltip: ObsidianExports_displayTooltip,
  editorEditorField: ObsidianExports_editorEditorField,
  editorInfoField: ObsidianExports_editorInfoField,
  editorLivePreviewField: ObsidianExports_editorLivePreviewField,
  editorViewField: ObsidianExports_editorViewField,
  empty: ObsidianExports_empty,
  finishRenderMath: ObsidianExports_finishRenderMath,
  getAllTags: ObsidianExports_getAllTags,
  getBlobArrayBuffer: ObsidianExports_getBlobArrayBuffer,
  getFrontMatterInfo: ObsidianExports_getFrontMatterInfo,
  getIcon: ObsidianExports_getIcon,
  getIconIds: ObsidianExports_getIconIds,
  getLanguage: ObsidianExports_getLanguage,
  getLinkpath: ObsidianExports_getLinkpath,
  hexToArrayBuffer: ObsidianExports_hexToArrayBuffer,
  htmlToMarkdown: ObsidianExports_htmlToMarkdown,
  installDomExtensions: ObsidianExports_installDomExtensions,
  iterateCacheRefs: ObsidianExports_iterateCacheRefs,
  iterateRefs: ObsidianExports_iterateRefs,
  livePreviewState: ObsidianExports_livePreviewState,
  loadMathJax: ObsidianExports_loadMathJax,
  loadMermaid: ObsidianExports_loadMermaid,
  loadPdfJs: ObsidianExports_loadPdfJs,
  loadPrism: ObsidianExports_loadPrism,
  makeHotkey: ObsidianExports_makeHotkey,
  moment: ObsidianExports_moment,
  normalizePath: ObsidianExports_normalizePath,
  parseFrontMatterAliases: ObsidianExports_parseFrontMatterAliases,
  parseFrontMatterEntry: ObsidianExports_parseFrontMatterEntry,
  parseFrontMatterStringArray: ObsidianExports_parseFrontMatterStringArray,
  parseFrontMatterTags: ObsidianExports_parseFrontMatterTags,
  parseLinktext: ObsidianExports_parseLinktext,
  parseMarkdownMetadata: ObsidianExports_parseMarkdownMetadata,
  parsePropertyId: ObsidianExports_parsePropertyId,
  parseYaml: ObsidianExports_parseYaml,
  prepareFuzzySearch: ObsidianExports_prepareFuzzySearch,
  prepareSimpleSearch: ObsidianExports_prepareSimpleSearch,
  removeIcon: ObsidianExports_removeIcon,
  renderMatches: ObsidianExports_renderMatches,
  renderMath: ObsidianExports_renderMath,
  renderResults: ObsidianExports_renderResults,
  request: ObsidianExports_request,
  requestUrl: ObsidianExports_requestUrl,
  requireApiVersion: ObsidianExports_requireApiVersion,
  resolveSubpath: ObsidianExports_resolveSubpath,
  sanitizeHTMLToDom: ObsidianExports_sanitizeHTMLToDom,
  setAttr: ObsidianExports_setAttr,
  setAttrs: ObsidianExports_setAttrs,
  setCssProps: ObsidianExports_setCssProps,
  setIcon: ObsidianExports_setIcon,
  setTooltip: ObsidianExports_setTooltip,
  sortSearchResults: ObsidianExports_sortSearchResults,
  stringifyYaml: ObsidianExports_stringifyYaml,
  stripHeading: ObsidianExports_stripHeading,
  stripHeadingForLink: ObsidianExports_stripHeadingForLink,
  wrapValue: ObsidianExports_wrapValue
});
import {
  FileSystemAdapter as NodeAdapterExports_FileSystemAdapter, NodeDataAdapter as NodeAdapterExports_NodeDataAdapter
} from "./node-adapter";
const NodeAdapterExports = () => ({
  FileSystemAdapter: NodeAdapterExports_FileSystemAdapter,
  NodeDataAdapter: NodeAdapterExports_NodeDataAdapter
});
import {
  App as PluginExports_App, Platform as PluginExports_Platform, Plugin as PluginExports_Plugin,
  PluginManager as PluginExports_PluginManager, PluginSettingTab as PluginExports_PluginSettingTab
} from "./plugin";
const PluginExports = () => ({
  App: PluginExports_App,
  Platform: PluginExports_Platform,
  Plugin: PluginExports_Plugin,
  PluginManager: PluginExports_PluginManager,
  PluginSettingTab: PluginExports_PluginSettingTab
});
import {
  PublishClient as PublishExports_PublishClient, PublishRequestError as PublishExports_PublishRequestError
} from "./publish-client";
const PublishExports = () => ({
  PublishClient: PublishExports_PublishClient,
  PublishRequestError: PublishExports_PublishRequestError
});
import {
  AbstractTextComponent as SettingExports_AbstractTextComponent, BaseComponent as SettingExports_BaseComponent, ButtonComponent as SettingExports_ButtonComponent,
  ColorComponent as SettingExports_ColorComponent, DisplayValueComponent as SettingExports_DisplayValueComponent, DropdownComponent as SettingExports_DropdownComponent,
  ExtraButtonComponent as SettingExports_ExtraButtonComponent, ProgressBarComponent as SettingExports_ProgressBarComponent, SearchComponent as SettingExports_SearchComponent,
  Setting as SettingExports_Setting, SettingGroup as SettingExports_SettingGroup, SettingPage as SettingExports_SettingPage,
  SettingTab as SettingExports_SettingTab, SliderComponent as SettingExports_SliderComponent, TextAreaComponent as SettingExports_TextAreaComponent,
  TextComponent as SettingExports_TextComponent, ToggleComponent as SettingExports_ToggleComponent, ValueComponent as SettingExports_ValueComponent
} from "./setting-controls";
const SettingExports = () => ({
  AbstractTextComponent: SettingExports_AbstractTextComponent,
  BaseComponent: SettingExports_BaseComponent,
  ButtonComponent: SettingExports_ButtonComponent,
  ColorComponent: SettingExports_ColorComponent,
  DisplayValueComponent: SettingExports_DisplayValueComponent,
  DropdownComponent: SettingExports_DropdownComponent,
  ExtraButtonComponent: SettingExports_ExtraButtonComponent,
  ProgressBarComponent: SettingExports_ProgressBarComponent,
  SearchComponent: SettingExports_SearchComponent,
  Setting: SettingExports_Setting,
  SettingGroup: SettingExports_SettingGroup,
  SettingPage: SettingExports_SettingPage,
  SettingTab: SettingExports_SettingTab,
  SliderComponent: SettingExports_SliderComponent,
  TextAreaComponent: SettingExports_TextAreaComponent,
  TextComponent: SettingExports_TextComponent,
  ToggleComponent: SettingExports_ToggleComponent,
  ValueComponent: SettingExports_ValueComponent
});
import {
  RuntimeHost as RuntimeExports_RuntimeHost
} from "./runtime-host";
const RuntimeExports = () => ({
  RuntimeHost: RuntimeExports_RuntimeHost
});
import {
  SyncHttpClient as SyncExports_SyncHttpClient, SyncSocketClient as SyncExports_SyncSocketClient, SyncTransportError as SyncExports_SyncTransportError
} from "./sync-client";
const SyncExports = () => ({
  SyncHttpClient: SyncExports_SyncHttpClient,
  SyncSocketClient: SyncExports_SyncSocketClient,
  SyncTransportError: SyncExports_SyncTransportError
});
import {
  VaultFileWatcher as VaultWatchExports_VaultFileWatcher
} from "./vault-watch";
const VaultWatchExports = () => ({
  VaultFileWatcher: VaultWatchExports_VaultFileWatcher
});
import {
  Menu as UIExports_Menu, MenuItem as UIExports_MenuItem, Modal as UIExports_Modal,
  Notice as UIExports_Notice, currentDocument as UIExports_currentDocument, trackActiveWindow as UIExports_trackActiveWindow
} from "./ui";
const UIExports = () => ({
  Menu: UIExports_Menu,
  MenuItem: UIExports_MenuItem,
  Modal: UIExports_Modal,
  Notice: UIExports_Notice,
  currentDocument: UIExports_currentDocument,
  trackActiveWindow: UIExports_trackActiveWindow
});
import {
  addIcon as UtilityExports_addIcon, apiVersion as UtilityExports_apiVersion, arrayBufferToBase64 as UtilityExports_arrayBufferToBase64,
  arrayBufferToHex as UtilityExports_arrayBufferToHex, base64ToArrayBuffer as UtilityExports_base64ToArrayBuffer, debounce as UtilityExports_debounce,
  displayTooltip as UtilityExports_displayTooltip, getIcon as UtilityExports_getIcon, getIconIds as UtilityExports_getIconIds,
  getLinkpath as UtilityExports_getLinkpath, hexToArrayBuffer as UtilityExports_hexToArrayBuffer, normalizePath as UtilityExports_normalizePath,
  parseFrontMatterAliases as UtilityExports_parseFrontMatterAliases, parseFrontMatterEntry as UtilityExports_parseFrontMatterEntry, parseFrontMatterStringArray as UtilityExports_parseFrontMatterStringArray,
  parseFrontMatterTags as UtilityExports_parseFrontMatterTags, parseLinktext as UtilityExports_parseLinktext, parseYaml as UtilityExports_parseYaml,
  removeIcon as UtilityExports_removeIcon, requireApiVersion as UtilityExports_requireApiVersion, setIcon as UtilityExports_setIcon,
  setTooltip as UtilityExports_setTooltip, stringifyYaml as UtilityExports_stringifyYaml, stripHeading as UtilityExports_stripHeading,
  stripHeadingForLink as UtilityExports_stripHeadingForLink
} from "./utilities";
const UtilityExports = () => ({
  addIcon: UtilityExports_addIcon,
  apiVersion: UtilityExports_apiVersion,
  arrayBufferToBase64: UtilityExports_arrayBufferToBase64,
  arrayBufferToHex: UtilityExports_arrayBufferToHex,
  base64ToArrayBuffer: UtilityExports_base64ToArrayBuffer,
  debounce: UtilityExports_debounce,
  displayTooltip: UtilityExports_displayTooltip,
  getIcon: UtilityExports_getIcon,
  getIconIds: UtilityExports_getIconIds,
  getLinkpath: UtilityExports_getLinkpath,
  hexToArrayBuffer: UtilityExports_hexToArrayBuffer,
  normalizePath: UtilityExports_normalizePath,
  parseFrontMatterAliases: UtilityExports_parseFrontMatterAliases,
  parseFrontMatterEntry: UtilityExports_parseFrontMatterEntry,
  parseFrontMatterStringArray: UtilityExports_parseFrontMatterStringArray,
  parseFrontMatterTags: UtilityExports_parseFrontMatterTags,
  parseLinktext: UtilityExports_parseLinktext,
  parseYaml: UtilityExports_parseYaml,
  removeIcon: UtilityExports_removeIcon,
  requireApiVersion: UtilityExports_requireApiVersion,
  setIcon: UtilityExports_setIcon,
  setTooltip: UtilityExports_setTooltip,
  stringifyYaml: UtilityExports_stringifyYaml,
  stripHeading: UtilityExports_stripHeading,
  stripHeadingForLink: UtilityExports_stripHeadingForLink
});
import {
  TAbstractFile as VaultExports_TAbstractFile, TFile as VaultExports_TFile, TFolder as VaultExports_TFolder,
  Vault as VaultExports_Vault
} from "./vault";
const VaultExports = () => ({
  TAbstractFile: VaultExports_TAbstractFile,
  TFile: VaultExports_TFile,
  TFolder: VaultExports_TFolder,
  Vault: VaultExports_Vault
});
import {
  ItemView as WorkspaceExports_ItemView, View as WorkspaceExports_View, Workspace as WorkspaceExports_Workspace,
  WorkspaceContainer as WorkspaceExports_WorkspaceContainer, WorkspaceItem as WorkspaceExports_WorkspaceItem, WorkspaceLeaf as WorkspaceExports_WorkspaceLeaf,
  WorkspaceParent as WorkspaceExports_WorkspaceParent, WorkspaceRoot as WorkspaceExports_WorkspaceRoot, WorkspaceSidedock as WorkspaceExports_WorkspaceSidedock,
  WorkspaceSplit as WorkspaceExports_WorkspaceSplit, WorkspaceTabs as WorkspaceExports_WorkspaceTabs, WorkspaceWindow as WorkspaceExports_WorkspaceWindow
} from "./workspace";
const WorkspaceExports = () => ({
  ItemView: WorkspaceExports_ItemView,
  View: WorkspaceExports_View,
  Workspace: WorkspaceExports_Workspace,
  WorkspaceContainer: WorkspaceExports_WorkspaceContainer,
  WorkspaceItem: WorkspaceExports_WorkspaceItem,
  WorkspaceLeaf: WorkspaceExports_WorkspaceLeaf,
  WorkspaceParent: WorkspaceExports_WorkspaceParent,
  WorkspaceRoot: WorkspaceExports_WorkspaceRoot,
  WorkspaceSidedock: WorkspaceExports_WorkspaceSidedock,
  WorkspaceSplit: WorkspaceExports_WorkspaceSplit,
  WorkspaceTabs: WorkspaceExports_WorkspaceTabs,
  WorkspaceWindow: WorkspaceExports_WorkspaceWindow
});
import {
  AbstractInputSuggest as SuggestExports_AbstractInputSuggest, EditorSuggest as SuggestExports_EditorSuggest, FuzzySuggestModal as SuggestExports_FuzzySuggestModal,
  PopoverSuggest as SuggestExports_PopoverSuggest, SuggestChooser as SuggestExports_SuggestChooser, SuggestComponent as SuggestExports_SuggestComponent,
  SuggestModal as SuggestExports_SuggestModal, fuzzySearch as SuggestExports_fuzzySearch, prepareFuzzySearch as SuggestExports_prepareFuzzySearch,
  prepareQuery as SuggestExports_prepareQuery, prepareSimpleSearch as SuggestExports_prepareSimpleSearch, renderMatches as SuggestExports_renderMatches,
  renderResults as SuggestExports_renderResults, sortSearchResults as SuggestExports_sortSearchResults
} from "./suggest";
const SuggestExports = () => ({
  AbstractInputSuggest: SuggestExports_AbstractInputSuggest,
  EditorSuggest: SuggestExports_EditorSuggest,
  FuzzySuggestModal: SuggestExports_FuzzySuggestModal,
  PopoverSuggest: SuggestExports_PopoverSuggest,
  SuggestChooser: SuggestExports_SuggestChooser,
  SuggestComponent: SuggestExports_SuggestComponent,
  SuggestModal: SuggestExports_SuggestModal,
  fuzzySearch: SuggestExports_fuzzySearch,
  prepareFuzzySearch: SuggestExports_prepareFuzzySearch,
  prepareQuery: SuggestExports_prepareQuery,
  prepareSimpleSearch: SuggestExports_prepareSimpleSearch,
  renderMatches: SuggestExports_renderMatches,
  renderResults: SuggestExports_renderResults,
  sortSearchResults: SuggestExports_sortSearchResults
});

let obsidianExports: Record<string, unknown> | undefined;
function getObsidianExports() { return obsidianExports ??= Object.freeze({
  ...ObsidianExports(),
  ...NodeAdapterExports(),
  ...ComponentExports(),
  ...CommandExports(),
  ...AccountExports(),
  ...FileManagerExports(),
  ...EditorExports(),
  ...DomExports(),
  ...EventExports(),
  ...MarkdownExports(),
  ...MetadataExports(),
  ...PluginExports(),
  ...RuntimeExports(),
  ...PublishExports(),
  ...SettingExports(),
  ...SyncExports(),
  ...SuggestExports(),
  ...UIExports(),
  ...UtilityExports(),
  ...VaultExports(),
  ...VaultWatchExports(),
  ...WorkspaceExports(),
}); }


/** A CommonJS scope owned by one plugin; the process module loader is untouched. */
export function createPluginRequire(entry: string, pluginRoot: string): NodeRequire {
  const modules = new Map<string, { exports: unknown }>();
  const root = path.resolve(pluginRoot);
  function scopedRequire(filename: string): NodeRequire {
    const native = createRequire(filename);
    const load = ((request: string): unknown => {
      if (request === "obsidian") return getObsidianExports();
      if (request === "@codemirror/state") return CodeMirrorState;
      if (request === "@codemirror/view") return CodeMirrorView;
      if (request === "@codemirror/language") return CodeMirrorLanguage;
      if (request === "@codemirror/commands") return CodeMirrorCommands;
      if (request === "moment") return moment;
      const resolved = native.resolve(request);
      const relative = path.relative(root, resolved);
      if (path.isAbsolute(relative) || relative.startsWith("..") || ![".js", ".cjs", ".json"].includes(path.extname(resolved))) return native(request);
      const cached = modules.get(resolved);
      if (cached) return cached.exports;
      const module = { exports: {} as unknown };
      modules.set(resolved, module);
      try {
        const source = fs.readFileSync(resolved, "utf8");
        if (resolved.endsWith(".json")) module.exports = JSON.parse(source);
        else {
          // Community plugins are trusted local Node modules. Compile them with
          // Node's CommonJS scope instead of browser eval, so renderer CSP can
          // reject JavaScript strings originating in rendered content.
          const execute = compileFunction(source, ["require", "module", "exports", "__filename", "__dirname"], { filename: resolved });
          execute(scopedRequire(resolved), module, module.exports, resolved, path.dirname(resolved));
        }
        return module.exports;
      } catch (error) { modules.delete(resolved); throw error; }
    }) as NodeRequire;
    load.resolve = native.resolve; load.cache = native.cache; load.extensions = native.extensions; load.main = native.main;
    return load;
  }
  return scopedRequire(entry);
}
