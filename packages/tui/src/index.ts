// The renderer (ADR-056) and, from T7, the interface: `project()` derives a view from the
// protocol's updates, `components/` turns it into lines, `ui/` draws them, `text/` measures.
//
// The kernel is not reachable from here and cannot be: the session arrives as a
// `ProtocolClient`, which is what makes `cowcat tui` an in-process client rather than a
// second frontend bolted onto the kernel (ADR-059 ③, ADR-066 ①).
//
// T9 adds `image/` (ADR-058).
export { runTui, type RunTuiOptions } from './run.js';
export { project, streamText, closeView, addNotice } from './app/project.js';
export {
  initialView,
  withLangFrom,
  toggleExpanded,
  toggleTodos,
  openPalette,
  closePalette,
  movePalette,
  type Entry,
  type TuiView,
} from './app/view.js';
export { changedFiles, type ChangedFile } from './app/changes.js';
export { changesPanelLines } from './components/changes-panel.js';
export { COMMANDS, KEYS_HELP, findCommand, lastToolCallId, parseCommand, type CommandEffect, type TuiCommand } from './app/commands.js';
export { intentFor, type Intent, type KeyLike } from './app/keymap.js';
export { COPY, copyFor, detectLang, type Copy, type Lang } from './app/copy.js';
export { frameOf, titleOf, type FrameOptions } from './components/session-frame.js';
export { statusLine, type StatusOptions } from './components/status-bar.js';
export { transcriptLines, type TranscriptOptions } from './components/transcript.js';
export { userMessageLines, assistantMessageLines } from './components/message.js';
export { toolCardLines, TOOL_OUTPUT_TAIL } from './components/tool-card.js';
export { approvalCardLines, noticeLines, type ApprovalCardOptions } from './components/approval-card.js';
export { todoPanelLines } from './components/todo-panel.js';
export { paletteLines } from './components/palette.js';
export { createScreen, type Screen, type ScreenSpec } from './ui/screen.js';
export { card, type CardBodyLine, type CardSpec } from './ui/card.js';
export { block, line, marked, tail, type Line } from './ui/line.js';
export { RANGES, charWidth, graphemes, padTo, sliceWidth, stringWidth, truncate } from './text/width.js';
export { wrap } from './text/wrap.js';
export { computeLineDiff, foldItems, unifiedDiff, type UnifiedDiff, type UnifiedItem } from './text/diff.js';
export { BRAND, THEME, colorOf, type Theme, type TokenColor, type TokenName } from './theme/tokens.js';
