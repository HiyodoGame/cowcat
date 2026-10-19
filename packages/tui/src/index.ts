// The renderer (ADR-056) and, from T7, the interface: `project()` derives a screen from the
// protocol's updates, `components/` turns it into lines, `ui/` draws them.
//
// The kernel is not reachable from here and cannot be: the session arrives as a
// `ProtocolClient`, which is what makes `cowcat tui` an in-process client rather than a
// second frontend bolted onto the kernel (ADR-059 ③, ADR-066 ①).
//
// T8 fills in the cards (`message`, `tool-card`, `approval-card`, `todo-panel`,
// `diff-card`, `command-palette`); T9 adds `image/`.
export { runTui, type RunTuiOptions } from './run.js';
export { project, streamText, closeView, addNotice } from './app/project.js';
export { initialView, withLangFrom, type Entry, type TuiView } from './app/view.js';
export { COPY, copyFor, detectLang, type Copy, type Lang } from './app/copy.js';
export { frameOf, titleOf } from './components/session-frame.js';
export { statusLine } from './components/status-bar.js';
export { transcriptLines, TOOL_OUTPUT_TAIL } from './components/transcript.js';
export { createScreen, type Screen, type ScreenSpec } from './ui/screen.js';
export { block, line, marked, tail, type Line } from './ui/line.js';
export { BRAND, THEME, colorOf, type Theme, type TokenColor, type TokenName } from './theme/tokens.js';
export { renderSmokeFrame, type SmokeFrame } from './smoke.js';
