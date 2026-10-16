// TuiUI: full-screen duck-typed replacement for the line-mode UI. Implements
// the exact interface bin/cowcat.mjs consumes (print/streamChunk/toolCall/
// approve/askQuestions/readLine/...) so the REPL and loop need no changes.
// Degrades out of the picture entirely unless the caller opts in.
import { Screen } from './screen.js';
import { execFile } from 'node:child_process';
import {
  createCard, buildScreen,
  truncateAnsi, visibleLen, scrollClamp, padLine,
  wrapText, renderCard, renderUserBubble, SPINNER,
  buildInputBox,
} from './render.js';
import { renderFileCard, renderGroup } from '../diffcard.js';
import { analyzeContext } from '../contextviz.js';
import { getTheme } from './theme.js';
import { detectCapabilities } from './capabilities.js';
import { sandboxBadgeLabel } from '../sandbox/exec.js';
import { createMarkdownRenderer } from './markdown.js';
import { highlightCode } from './highlight.js';
import {
  TextRegion, UserRegion, AssistantRegion, CardRegion,
  materializeWindow, renderApprovalCard,
} from './region.js';
import { DialogStack, dialogWidth, pickDialogSize } from './dialog.js';
import { DialogSelect } from './dialog-select.js';
import { configuredProviders, contextLimit } from '../config.js';
import { ToastQueue, renderToast } from './toast.js';
import { Session } from '../session.js';
import { basename } from 'node:path';
import { ComposerEditor } from './editor.js';
import { createKeymap, normalizeKey } from './keybind.js';
import { FrecencyStore } from './frecency.js';
import { triggerOf, rankCandidates } from './complete.js';
import { metadataLine } from './metadata.js';
import { collapseToolOutput } from './collapse.js';
import { sidebarWidth, renderSidebar, stitchSidebar } from './sidebar.js';
import { parseApiError, formatApiErrorLines, ERR_HINTS } from '../errfmt.js';
import { findMatch } from '../perrules.js';
import { footerLine, retryLine, errorLine } from './footer.js';
import { abbreviateDir, formatCost, formatTokenCount, footerLine as footerBarLine } from './footerbar.js';
import { estimateTokens } from '../prompts/compact.js';
import { decodeOutput } from '../textdecode.js';
import { resolveStateFile } from '../config.js';

const SPINNER_MS = 150;

// Best-effort partial `command` value out of an in-flight tool-arguments JSON
// string (the wire streams it token by token and the closing quote may never
// arrive). Only used for the live forming-card title.
function bashPartialCommand(args) {
  const m = /"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(String(args || ''));
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}

// Idle-composer placeholder rotation (zh/en pools; index 0 stays the
// functional hint so first-render output is deterministic).
const PLACEHOLDERS = {
  zh: [
    '输入消息，/ 命令，@ 文件，! shell',
    '描述你要做的改动…',
    '有问题尽管问',
    '贴一大段代码也可以',
    '按 ? 查看全部键位',
    'ctrl+p 打开命令面板',
  ],
  en: [
    'Type a message, / for commands, @ for files, ! shell',
    'Describe the change you want…',
    'Ask anything…',
    'Paste a big blob of code',
    'Press ? for all keybindings',
    'ctrl+p opens the command palette',
  ],
};
const PLACEHOLDER_ROTATE_MS = 10_000;

export class TuiUI {
  constructor({
    input = process.stdin, output = process.stdout, colors = true, lang = 'zh',
    version = '0.8.0', cwd = process.cwd(),
    getModel = () => '', getMode = () => 'default', getCost = () => '', getConfig = () => ({}), getMessages = () => [],
    completions = null, fileCompletions = null, commandDocs = null,
    capabilities = null, home = null, onModelPick = null,
    getPermissions = null, getTodos = null, getMcp = null,
  } = {}) {
    this.input = input;
    this.output = output;
    this.colors = colors;
    this.lang = lang;
    this.t = { noDiff: '这回合还没有 diff。' };
    this.interactive = true;
    this.screen = new Screen({ input, output });
    this.entries = [];          // Region objects (TextRegion/UserRegion/AssistantRegion/CardRegion), kept duck-typed: kind/_rendered/card
    this.scroll = 0;
    this.spinFrame = 0;
    this._drawTimer = null;     // pending deferred frame (setImmediate), see _requestDraw
    this._timer = null;         // spinner interval, only while a card is running
    this._turnStart = null;     // userMessage timestamp, consumed by endStream footer
    this.completions = completions;         // (prefix) => string[] of "/name"
    this.fileCompletions = fileCompletions; // (prefix) => string[] of "@path"
    this.commandDocs = commandDocs;         // [{name, zh, en}] popup menu descriptions
    this.editor = new ComposerEditor({
      completions: () => (this.completions ? this.completions(this.editor.text) : []),
      fileCompletions: (prefix) => (this.fileCompletions ? this.fileCompletions(prefix) : []),
    });
    this.onShiftTab = null;
    this.onInterrupt = null;
    this.onModelPick = onModelPick;   // (ref: "provider/model") — host applies the switch
    this.multiline = false;
    this._reading = null;
    this._menuDismissed = false;  // slash menu dismissed via Esc until the text changes
    this._menuSel = 0;            // selected row of the popup slash menu
    this._lastRev = 0;
    this._promptText = '';
    this._pendingApproval = null;
    // P5 parallel tool execution: one active card slot per in-flight tool_use
    // id; calls without an id keep the legacy single _activeCard behavior.
    this._activeCards = new Map();
    // P2 live tool-call formation: stream index -> {card, entry, name, args, done}
    this._pendingToolCards = new Map();
    this._branch = '-';           // git branch for the context line; '-' until resolved
    this._branchTimer = null;
    this._meta = { version, cwd, getModel, getMode, getCost, getConfig, getMessages, getPermissions, getTodos, getMcp };
    // Right sidebar panel (P3): toggle with ctrl+b or /panel; auto-hides on
    // narrow terminals (< ~100 cols). The toggle itself lives on the UI so the
    // keybind works without host wiring; bin mirrors it into session state.
    this.panelVisible = false;
    this.onTogglePanel = null;
    // home directory for ~/dir abbreviation (injectable for tests)
    this._home = home ?? process.env.HOME ?? process.env.USERPROFILE ?? null;
    // TuiUI is only constructed on a dual-TTY stdout; capabilities decide the
    // palette depth and OSC8 hyperlink support. `none` maps to '16' as a
    // defensive floor (should not happen on the TTY path).
    const caps = capabilities ?? detectCapabilities({
      env: process.env,
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
    });
    this._colorLevel = { '24bit': '24bit', '256': '256', '16': '16', none: '16' }[caps.colors];
    this._osc8 = caps.osc8 === true;
    this.themeName = this._meta.getConfig().theme === 'light' ? 'light' : 'dark';
    this.theme = getTheme(this.themeName, this._colorLevel);
    // Shared mutable style context handed to every region; setTheme/_tick
    // update it in place so regions always render with the live palette and
    // spinner frame without being rebuilt.
    this._style = { theme: this.theme, colors: this.colors, spinFrame: this.spinFrame };
    // Declarative keybind table (config.keybinds may override defaults; bad
    // overrides fall back to the shipped table rather than crashing the UI).
    let binds = {};
    try { binds = this._meta.getConfig().keybinds ?? {}; } catch { binds = {}; }
    try { this._keymap = createKeymap(binds); } catch { this._keymap = createKeymap(); }
    // Prompt history / draft persistence. Only on a real TTY: headless test
    // harnesses must never touch the on-disk store.
    this._store = input.isTTY === true
      ? new FrecencyStore(resolveStateFile('prompt-history.jsonl'))
      : new FrecencyStore(null);
    this.editor.externalHistory = () => this._store.recent(100);
    this._draftRestored = false;
    this._shellMode = false;      // '!' at line start: submit runs locally via the shell
    this._pasteBuf = null;        // bracketed-paste accumulator
    this._streaming = false;      // model streaming in flight (drives the footer spinner)
    this._animations = process.env.COWCAT_ANIMATIONS !== 'off'; // static spinner + no blink when off
    this._escArmed = false;       // esc-double-press interrupt: first press arms, second fires
    this._escArmMs = 5000;
    this._escArmTimer = null;
    // Dialog stack (command palette / sessions / theme / help). Modal: while a
    // dialog is open every key routes to it; esc closes the top and focus
    // falls back to whatever was focused before.
    this._dialogs = new DialogStack({ onFocusChange: () => this._requestDraw() });
    this.onPickSession = null;    // optional (file) => void hook for session picks
    // Toast notifications (top-right overlay, 5s, queue with +N more).
    this._toasts = new ToastQueue({ onChange: () => this._requestDraw() });
    // Idle-composer placeholder rotation state.
    this._placeholderIdx = 0;
    this._placeholderAt = Date.now(); // first focus must not rotate immediately
    this._placeholderTimer = null;
  }

  // --- lifecycle ---------------------------------------------------------------

  start() {
    this.screen.enter();
    this.input.setRawMode?.(true);
    this._dispatch = (chunk) => this._onKeys(chunk);
    this.input.on('data', this._dispatch);
    // Resize: repaint the whole frame from the new dimensions. Both the
    // stream 'resize' event and SIGWINCH are wired — Windows terminals emit
    // one or the other depending on the console host.
    this._onResize = () => {
      this.screen.lastLines = null; // force a full rewrite, no stale-height diffs
      this._draw();
    };
    this.output.on?.('resize', this._onResize);
    if (typeof process !== 'undefined') process.on?.('SIGWINCH', this._onResize);
    this.output.write('\x1b[?2004h'); // bracketed paste: multi-line inserts stay literal
    this._refreshBranch();
    this._branchTimer = setInterval(() => { if (this.screen.active) this._refreshBranch(); }, 30000);
    if (this._branchTimer.unref) this._branchTimer.unref();
    // placeholder rotation while the idle composer waits for input
    this._placeholderTimer = setInterval(() => {
      if (this.screen.active && this._reading && !this.editor.text
        && !this._promptText && !this._pendingApproval?.pills) {
        this._rotatePlaceholder(true);
        this._requestDraw();
      }
    }, PLACEHOLDER_ROTATE_MS);
    if (this._placeholderTimer.unref) this._placeholderTimer.unref();
    // startup line: version + vitals, hidden on narrow terminals
    if (this.input.isTTY === true) {
      const banner = this._startupInfo();
      if (banner) this.print(banner);
    }
    this._draw();
    this._syncSpinner();
  }

  close() {
    this._cancelScheduledDraw();
    if (this._escArmTimer) { clearTimeout(this._escArmTimer); this._escArmTimer = null; }
    this._escArmed = false;
    this._toasts.clear();
    if (this._placeholderTimer) { clearInterval(this._placeholderTimer); this._placeholderTimer = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._branchTimer) { clearInterval(this._branchTimer); this._branchTimer = null; }
    if (this._dispatch) this.input.off?.('data', this._dispatch);
    if (this._onResize) {
      this.output.off?.('resize', this._onResize);
      process.off?.('SIGWINCH', this._onResize);
    }
    this._store?.clearDraft();  // clean session end: the autosaved draft must not linger
    if (this.screen.active) this.output.write('\x1b[?2004l'); // bracketed paste off
    this.input.setRawMode?.(false);
    this.screen.leave();
  }

  // git branch for the input-area context line: resolved once up front, then
  // re-polled every 30s while the alternate screen is active. Failure (not a
  // repo, git missing) keeps the '-' placeholder; never blocks rendering.
  _refreshBranch() {
    const cwd = this._meta?.cwd ?? process.cwd();
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000 }, (err, stdout) => {
      this._branch = (!err && stdout.trim()) ? stdout.trim() : '-';
    });
  }

  attachAnimator() {}
  setLang(lang) { this.lang = lang; }

  color(code, s) { return this.colors ? `${code}${s}\x1b[0m` : s; }

  // --- transcript API (same shapes as the line-mode UI) --------------------------

  print(s = '') {
    this.entries.push(new TextRegion(String(s).split('\n')));
    this._follow();
    this._requestDraw();
  }

  // User turn marker: starts the turn clock and appends a bubble entry.
  userMessage(text) {
    this._closePendingToolCards(); // last turn's leftovers can never execute now
    this._turnStart = Date.now();
    this._streaming = false;
    this.entries.push(new UserRegion(String(text), this._style));
    this._follow();
    this._requestDraw();
  }

  // The assistant region owns the incremental markdown renderer: a push emits
  // newly closed rows (kept forever) plus a re-rendered open tail; the region
  // cache is dirtied here and lazily rebuilt on the next materialize.
  streamChunk(s) {
    let e = this.entries[this.entries.length - 1];
    if (!e || e.kind !== 'assistant' || e.done) {
      e = new AssistantRegion((w) => this._createMarkdownRenderer(w), this._size().width);
      this.entries.push(e);
    }
    // Reasoning ended when the first text delta arrives: freeze the thinking
    // summary at its final duration and hand the region over to markdown.
    if (this._thinkingStart) {
      e.setThinking(this._thinkingAcc ?? '', Date.now() - this._thinkingStart);
      this._thinkingStart = null;
      this._thinkingAcc = '';
    }
    this._streaming = true;
    e.push(String(s));
    e.markDirty();
    this._follow();
    this._syncSpinner();
    this._requestDraw();
  }

  // Live reasoning deltas (OpenAI-compatible `reasoning_content` / `reasoning`,
  // Anthropic thinking): accumulate into the open assistant region's reserved
  // thinking slot so a muted `Thought · Ns` summary leads the turn. Also starts
  // the turn spinner so a pure-reasoning phase is not a silent frozen screen.
  thinkingChunk(s) {
    let e = this.entries[this.entries.length - 1];
    if (!e || e.kind !== 'assistant' || e.done) {
      e = new AssistantRegion((w) => this._createMarkdownRenderer(w), this._size().width);
      this.entries.push(e);
    }
    if (!this._thinkingStart) this._thinkingStart = Date.now();
    this._thinkingAcc = (this._thinkingAcc ?? '') + String(s);
    this._streaming = true;
    e.setThinking(this._thinkingAcc, Date.now() - this._thinkingStart);
    e.markDirty();
    this._follow();
    this._syncSpinner();
    this._requestDraw();
  }

  endStream() {
    this._thinkingStart = null;
    this._thinkingAcc = '';
    // a formation cut off mid-args (e.g. max_tokens) can never execute
    this._closePendingToolCards(true);
    const e = this.entries[this.entries.length - 1];
    if (e && e.kind === 'assistant' && !e.done) {
      e.finish();
      e.markDirty();
    }
    this._streaming = false;
    this._syncSpinner();
    const s = this.turnSeconds();
    this._turnStart = null;
    // turn footer: `✻ for 3s · model · N tok/s` (muted; tok/s only when a
    // caller supplies a token count)
    this.print(this.color(this.theme.inactive, footerLine({ model: this._meta.getModel(), seconds: s })));
  }

  turnSeconds() {
    if (!this._turnStart) return 0;
    return Math.max(0, Math.round((Date.now() - this._turnStart) / 1000));
  }

  // Toast notification API: variant-colored top-right overlay, 5s (or the
  // given duration), queue with `+N more`, esc dismisses.
  toast(variant, title, message, { duration = null } = {}) {
    this._toasts.show({ variant, title, message, ...(duration ? { duration } : {}) });
  }

  // Idle-composer placeholder: rotates through the zh/en pools on focus (when
  // the last rotation is older than the interval) and on the 10s timer.
  _currentPlaceholder() {
    const pool = PLACEHOLDERS[this.lang] ?? PLACEHOLDERS.zh;
    return pool[this._placeholderIdx % pool.length];
  }

  _rotatePlaceholder(force = false) {
    if (!force && Date.now() - this._placeholderAt < PLACEHOLDER_ROTATE_MS) return false;
    this._placeholderIdx++;
    this._placeholderAt = Date.now();
    return true;
  }

  waitingModel() {}
  compacting() { this.print(this.color('\x1b[90m', this.lang === 'zh' ? '压缩中，马上回来。' : 'Compacting, back in a moment.')); }
  showTodos(todos) {
    if (!todos?.length) return;
    this.print(this.color('\x1b[32m', 'Todos:'));
    for (const t of todos) this.print(`  ${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`);
  }

  // Card title for a tool call: `● Used {ToolName}` (bold name), Bash special
  // `● Ran a command · $ {command}` (command truncated ~60 cols, dim). The
  // leading ● is tinted by renderCard per card status (green/red/spinner).
  _toolTitle(name, summary) {
    const bold = (s) => (this.colors ? `\x1b[1m${s}\x1b[0m` : s);
    const dim = (s) => (this.colors ? `${this.theme.inactive}${s}\x1b[0m` : s);
    if (name === 'Bash') {
      const cmd = String(summary || '').trim();
      // Sandbox honesty: the tag shows the mode that is ACTUALLY in effect, not
      // the one that was requested. A system-mode session whose backend is
      // missing says so on the card instead of wearing a reassuring label —
      // that failure mode (UI claims a sandbox, commands run bare) is exactly
      // what the research report measured in other agents. Read live from
      // getConfig() so a mid-session /sandbox toggle shows up on the next card.
      // Headless/test UIs with no config source stay un-tagged. The helper is
      // deliberately probe-free for light/off: probing spawns processes, and a
      // frame render must not block on that.
      let tag = '';
      try {
        const label = sandboxBadgeLabel(this._meta.getConfig(), { cwd: process.cwd() });
        tag = label ? ` · ${label}` : '';
      } catch { tag = ''; }
      return `● Ran a command${cmd ? dim(` · $ ${truncateAnsi(cmd, 60)}`) : ''}${tag ? dim(tag) : ''}`;
    }
    return `● Used ${bold(name)}`;
  }

  // `id` (P5): the tool_use id of a parallel-executing call. When given, the
  // card registers in _activeCards so a later status call (toolSuccess/
  // toolError/bashResultCard) with the same id resolves THIS card instead of
  // whatever happens to be newest. Omitting it keeps the sequential contract.
  toolCall(name, summary, id) {
    const card = createCard('tool', this._toolTitle(name, summary));
    card.startedAt = Date.now();
    // permission-rule denial arrives as a plain toolCall with a tagged summary
    // and no follow-up status call — resolve it straight to the denied state
    if (/\[denied by rule\]\s*$/.test(String(summary))) card.status = 'denied';
    // P2: supersede the pending formation card for this tool (matched by
    // name), reusing its region slot and its start clock so the streamed
    // title hands over seamlessly to the executing card
    let entry = null;
    for (const [index, p] of this._pendingToolCards) {
      if (p.name !== name) continue;
      card.startedAt = p.card.startedAt;
      p.entry.card = card;
      this._pendingToolCards.delete(index);
      entry = p.entry;
      this._invalidateEntry(entry);
      break;
    }
    if (!entry) {
      entry = new CardRegion(card, this._style);
      this.entries.push(entry);
      this._follow();
    }
    this._activeCard = card;
    this._activeEntry = entry;
    if (id != null) this._activeCards.set(id, { card, entry });
    this._syncSpinner();
    this._requestDraw();
  }

  // P2 tool-call formation streaming: one pending card per streamed tool; the
  // title grows character by character as name/arguments arrive (the running
  // status renders the braille spinner, same as an executing card). The card
  // is superseded by toolCall() on execution or dropped by
  // _closePendingToolCards() when the turn ends without it.
  toolCallDelta(d) {
    if (!d || typeof d.index !== 'number') return;
    let p = this._pendingToolCards.get(d.index);
    if (d.done) {
      if (p) { p.done = true; this._refreshPendingToolCard(p); }
      return;
    }
    if (!p) {
      const card = createCard('tool', '● …');
      card.startedAt = Date.now();
      const entry = new CardRegion(card, this._style);
      this.entries.push(entry);
      this._follow();
      p = { card, entry, name: '', args: '', done: false };
      this._pendingToolCards.set(d.index, p);
    }
    if (d.name) p.name = d.name;
    if (d.argsDelta) p.args += d.argsDelta;
    this._refreshPendingToolCard(p);
    this._syncSpinner();
    this._requestDraw();
  }

  _refreshPendingToolCard(p) {
    p.card.title = p.name
      ? this._toolTitle(p.name, p.name === 'Bash' ? bashPartialCommand(p.args) : '')
      : '● …';
    this._invalidateEntry(p.entry);
    this._requestDraw();
  }

  // Pending formation cards whose tool never executes would spin forever.
  // onlyIncomplete drops truncated formations at endStream (a completed one
  // may still be about to execute); userMessage sweeps the rest (denied /
  // unknown-tool / hook-vetoed calls) when the next turn starts.
  _closePendingToolCards(onlyIncomplete = false) {
    if (!this._pendingToolCards.size) return;
    for (const [index, p] of [...this._pendingToolCards]) {
      if (onlyIncomplete && p.done) continue;
      const i = this.entries.indexOf(p.entry);
      if (i >= 0) this.entries.splice(i, 1);
      this._pendingToolCards.delete(index);
    }
    this._follow();
    this._syncSpinner();
    this._requestDraw();
  }

  // Dim elapsed-time tag for a finished card ('' when the start clock is unknown).
  _elapsedTag(card) {
    const start = card?.startedAt;
    if (!start) return '';
    const ms = Math.max(0, Date.now() - start);
    const s = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    return this.color(this.theme.inactive, s);
  }

  // Resolve the card a status call targets: by tool_use id when given (P5
  // parallel execution), else the legacy single active slot.
  _pickCard(id) {
    if (id != null) {
      const rec = this._activeCards.get(id);
      if (rec) { this._activeCards.delete(id); return rec; }
    }
    const rec = this._activeCard ? { card: this._activeCard, entry: this._activeEntry } : null;
    this._activeCard = null;
    this._activeEntry = null;
    return rec;
  }

  toolSuccess(id) {
    const rec = this._pickCard(id);
    if (rec?.card) {
      const c = rec.card;
      c.status = 'done';
      const el = this._elapsedTag(c);
      c.summaryLines = el ? [el] : [''];
      c.fullLines = [];
      this._invalidateEntry(rec.entry);
    }
    this._syncSpinner();
    this._requestDraw();
  }

  toolError(err, id) {
    const rec = this._pickCard(id);
    if (rec?.card) {
      const c = rec.card;
      c.status = 'error';
      c.summaryLines = [String(err).slice(0, 120), this._elapsedTag(c)].filter(Boolean);
      c.fullLines = [String(err)];
      this._invalidateEntry(rec.entry);
    }
    this._syncSpinner();
    this._requestDraw();
  }

  // User denied an approval: the pending tool card resolves to the denied
  // state (red ✗ + struck-through title), then the usual quip.
  denied(id) {
    const rec = this._pickCard(id);
    if (rec?.card) {
      rec.card.status = 'denied';
      this._invalidateEntry(rec.entry);
    }
    this._syncSpinner();
    this.print(this.color('\x1b[90m', this.lang === 'zh' ? '行吧。（把爪子缩回来，但眼睛还盯着那面墙）' : 'Fine. (retracts paw)'));
  }
  planDenied(name) { this.print(this.color('\x1b[38;5;179m', this.lang === 'zh' ? `Plan 模式只看不拆。先 /act 再动手。（${name}）` : `Plan mode is look-only. /act first. (${name})`)); }

  // Bash result card through the collapse dual-budget algorithm (Open Code
  // constants: 5 lines / 1000 chars, tail preserved). Falls back to the legacy
  // head/tail model fields when the full output is not available.
  bashResultCard({ model, command = '', exitCode = 0, file = null, id }) {
    const rec = this._pickCard(id);
    const c = rec ? rec.card : null;
    let lines;
    if (Array.isArray(model.allLines)) {
      lines = collapseToolOutput(model.allLines.join('\n')).lines.map((l) => String(l));
      if (file) lines.push(`full output: ${file}`);
    } else {
      const body = model.folded ? model.tailLines : model.headLines;
      lines = body.map((l) => String(l));
      if (model.folded) {
        lines.push(`··· ${model.totalLines} lines total ···`);
        lines.push(this.lang === 'zh' ? '输出太长，我帮你叼回窝里了—— /output 翻出来。' : 'Output in the den — /output to dig it up.');
        if (file) lines.push(`full output: ${file}`);
      }
    }
    // The most useful rows for a glance are the TAIL of the collapsed output;
    // the `(N earlier lines)` fold marker never earns a summary slot.
    const tailRows = lines.filter((l) => !/^\(\d+ earlier lines\)$/.test(String(l))).slice(-3);
    if (c) {
      const el = this._elapsedTag(c);
      c.status = exitCode !== 0 ? 'error' : 'done';
      // non-zero exit: an explicit red exit-code tag leads the card so the
      // failing command (title), exit code, and output tail read at a glance
      const codeTag = exitCode !== 0 ? this.color(this.theme.error, `✗ exit ${exitCode}`) : '';
      // error cards spend their 3 summary rows on exit code + output tail; the
      // elapsed tag only rides along on success cards
      c.summaryLines = exitCode !== 0
        ? [codeTag, ...tailRows.slice(-2)]
        : [...(el ? [el] : []), ...tailRows];
      c.fullLines = [...(codeTag ? [codeTag] : []), ...lines];
      this._invalidateEntry(rec.entry);
      this._syncSpinner();
      this._requestDraw();
    } else if (exitCode !== 0) {
      // no running card (host skipped toolCall): still an error card, never a dump
      const card = createCard('tool', `● ${truncateAnsi(command || 'command', 60)}`);
      card.status = 'error';
      card.summaryLines = [this.color(this.theme.error, `✗ exit ${exitCode}`), ...tailRows];
      card.fullLines = [this.color(this.theme.error, `✗ exit ${exitCode}`), ...lines];
      this.entries.push(new CardRegion(card, this._style));
      this._follow();
      this._requestDraw();
    } else {
      for (const l of lines) this.print(l);
    }
  }

  // Reserved provider-status entries (no producer in the current loop duck
  // interface): retry countdowns and model errors surface as toasts.
  retryingIn(seconds = 1, attempt = 1) {
    this.toast('warning', this.lang === 'zh' ? '重试' : 'Retry', retryLine({ seconds, attempt }));
  }

  modelError(message) {
    const p = parseApiError(message);
    const hint = p.hint ? (ERR_HINTS[p.hint][this.lang] ?? ERR_HINTS[p.hint].en) : null;
    this.toast('error', this.lang === 'zh' ? '模型错误' : 'Model error',
      hint ? `${p.summary} — ${hint}` : errorLine(p.summary));
  }

  // Provider/API failure as a red-tinted transcript card (ctrl+o expands to the
  // raw response body). This is the TUI surface for the REPL's runLoop catch.
  apiError(err) {
    const p = formatApiErrorLines(parseApiError(err), { lang: this.lang });
    const card = createCard('tool', this.lang === 'zh' ? '模型请求失败' : 'Model request failed');
    card.status = 'error';
    card.summaryLines = p.lines.map((l) => this.color(this.theme.error, l));
    card.fullLines = [...p.lines, '', ...String(p.raw).split('\n').slice(0, 30)];
    this.entries.push(new CardRegion(card, this._style));
    this._follow();
    this._requestDraw();
  }

  // --- approvals / questions -------------------------------------------------------

  // Which configured permission rule will match this call (deny > ask > allow),
  // or null when nothing matches and the default behavior applies. Best-effort:
  // without a permissions source the line degrades to the default note.
  _matchedRuleLine(toolName, input) {
    let perms = null;
    try { perms = this._meta.getPermissions?.() ?? null; } catch { perms = null; }
    const rules = perms?.rules;
    let matched = null;
    if (rules && input) {
      matched = findMatch(rules.deny ?? [], toolName, input)
        ?? findMatch(rules.ask ?? [], toolName, input)
        ?? findMatch(rules.allow ?? [], toolName, input);
    }
    if (matched) {
      const raw = matched.raw ?? `${matched.tool}${matched.pattern ? `(${matched.pattern}${matched.prefix ? ':*' : ''})` : ''}`;
      return { text: `${this.lang === 'zh' ? '命中规则' : 'matched rule'}: ${raw}`, matched: raw };
    }
    return { text: this.lang === 'zh' ? '无匹配规则（默认：询问）' : 'no matching rule (default: ask)', matched: null };
  }

  // Inline approval; the composer area is replaced by a PermissionPrompt
  // (header + description + matched-rule line + pill options + embedded
  // scrollable diff) while the promise is pending. y/n/a semantics for the loop
  // are unchanged — the modal additionally accepts the bare y/a/n keys. The
  // prospective diff from the loop (preview/group) folds into the expandable
  // transcript card — same grouping rules as the line-mode UI (diffcard.js).
  approve(toolName, summary, { dangerous = false, preview = null, group = null, input = null } = {}) {
    return new Promise((resolve) => {
      const card = createCard('approval', `${this.color('\x1b[33m', '批准请求')} ${toolName} ${truncateAnsi(String(summary || ''), 50)}`);
      card.status = 'done';
      const quip = (this.lang === 'zh' ? '我要跑这个了，盯着它看三秒。' : 'Running this. Stare for three seconds.') + (dangerous ? ' ⚠' : '');
      const previewLines = this._approvalPreviewLines(preview, group);
      const rule = this._matchedRuleLine(toolName, input);
      card.summaryLines = [rule.text, quip];
      card.fullLines = previewLines.length ? [rule.text, quip, ...previewLines] : [rule.text, summary || ''];
      const entry = new CardRegion(card, this._style);
      this.entries.push(entry);
      this._follow();
      const labels = this.lang === 'zh'
        ? { once: 'y 允许一次', always: 'a 总是允许', deny: 'n 拒绝' }
        : { once: 'y Allow once', always: 'a Allow always', deny: 'n Deny' };
      this._pendingApproval = {
        card, entry, resolve,
        toolName: String(toolName), summary: String(summary || ''),
        ruleLine: rule.text,
        previewLines, scroll: 0,
        pills: [
          { id: 'y', label: labels.once },
          { id: 'always', label: labels.always },
          { id: 'n', label: labels.deny },
        ],
        pillSel: 0,
      };
      this._requestDraw();
    });
  }

  // Resolve the pending approval: record the outcome on the transcript card,
  // clear the prompt and settle the loop's promise.
  _resolveApproval(result) {
    const p = this._pendingApproval;
    if (!p) return;
    p.card.title += ` → ${result === 'always' ? 'always' : result === 'y' ? 'y' : 'n'}`;
    this._invalidateEntry(p.entry);
    this._pendingApproval = null;
    p.resolve(result);
    this._requestDraw();
  }

  _approvalPreviewLines(preview, group) {
    if (!preview) return [];
    const lines = [];
    const total = group?.total ?? 1;
    if (total > 1) lines.push(`  ┌─ change ${group.index}/${total}`);
    // TUI path: line-number gutter + permission-tinted hunk headers
    const opts = { colors: this.colors, gutter: true, theme: this.theme };
    lines.push(...(total > 3 && group
      ? renderGroup(group.previews, opts)
      : renderFileCard(preview, opts)));
    return lines;
  }

  askQuestions(questions) {
    const answers = {};
    return (async () => {
      for (const q of questions) {
        this.print(this.color('\x1b[1m', q.question));
        q.options.forEach((o, i) => this.print(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
        this._promptText = `Choose${q.multiSelect ? ' (comma-separated)' : ''} [1-${q.options.length}]: `;
        const ans = ((await this._readLineRaw()) ?? '').trim();
        const idxs = ans.split(',').map((x) => parseInt(x.trim(), 10) - 1).filter((i) => i >= 0 && i < q.options.length);
        const labels = idxs.map((i) => q.options[i].label);
        answers[q.question] = q.multiSelect ? labels.join(', ') : (labels[0] ?? ans);
      }
      return answers;
    })();
  }

  // --- input -----------------------------------------------------------------------

  ask(promptText) {
    this._promptText = promptText;
    return this._readLineRaw();
  }

  readLine() { return this._readLineRaw(); }

  async readSecret() {
    this._secret = true;
    try { return ((await this._readLineRaw()) ?? '').trim(); } finally { this._secret = false; }
  }

  // Composer prompt with non-echo input (API keys etc).
  async askSecret(promptText) {
    this._promptText = promptText;
    return this.readSecret();
  }

  // Modal single-choice picker over DialogSelect. Resolves the picked item, or
  // null when the user esc-closes the dialog. No transcript writes.
  pickOne({ title, items, pageSize = 12 }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const ds = new DialogSelect({
        items,
        pageSize,
        onPick: (item) => { done(item); this._dialogs.closeTop(); },
      });
      this._dialogs.open({
        id: 'pick',
        title,
        render: (w) => ds.rows(w, { colors: this.colors, theme: this.theme }),
        onKey: (chord) => { ds.handleKey(chord); return true; },
        onClose: () => done(null),
      });
    });
  }

  _readLineRaw() {
    // the session dispatcher feeds the editor; resolves on submit (null on EOF)
    if (this._reading) return this._reading;
    this.editor.reset();
    this.multiline = false;
    this._shellMode = false;
    // crash-recovery: a persisted draft (TTY sessions only) is offered back
    // into the composer exactly once
    if (!this._draftRestored) {
      this._draftRestored = true;
      if (this._store.draft) {
        this.editor.setText(this._store.draft);
        this.toast('info', this.lang === 'zh' ? '草稿已恢复' : 'Draft restored', truncateAnsi(this._store.draft, 40));
      }
    }
    // an idle composer rotates its placeholder on each new focus
    if (this._rotatePlaceholder(false)) this._requestDraw();
    this._reading = new Promise((resolve) => { this._resolveRead = resolve; });
    this._eofHandler = () => this._finishRead(null);
    this.input.once?.('end', this._eofHandler);
    return this._reading;
  }

  _finishRead(line) {
    if (!this._reading) return;
    const r = this._resolveRead;
    this._reading = null;
    this._resolveRead = null;
    this._promptText = '';
    // inside the alternate screen a bare newline would scroll the whole frame;
    // frame drawing is the only writer there
    if (!this.screen.active) this.output.write('\n');
    r(line);
  }

  // Session-wide key dispatcher: approvals and global keys work even while the
  // model is streaming (no readLine is active then).
  _onKeys(chunk) {
    let s = String(chunk);
    // Bracketed paste (enabled in start()): buffer everything between the
    // markers and insert it literally, so a pasted newline never submits the
    // composer mid-paste.
    if (this._pasteBuf !== null) {
      this._pasteBuf += s;
      const end = this._pasteBuf.indexOf('\x1b[201~');
      if (end === -1) return; // paste still in flight
      const content = this._pasteBuf.slice(0, end);
      const rest = this._pasteBuf.slice(end + '\x1b[201~'.length);
      this._pasteBuf = null;
      if (this._reading) this.editor.insert(content.replace(/\r\n?/g, '\n'));
      this._afterKeys();
      if (!rest) return;
      s = rest;
    } else if (s.includes('\x1b[200~')) {
      const start = s.indexOf('\x1b[200~');
      const before = s.slice(0, start);
      if (before) this._onKeys(before); // keys before the marker parse normally
      this._pasteBuf = '';
      const rest = s.slice(start + '\x1b[200~'.length);
      if (rest) this._onKeys(rest);
      return;
    }
    this._keyBuf = (this._keyBuf || '') + s;
    // a lone ESC: give split sequences one tick to complete, then treat as Esc
    if (this._keyBuf === '\x1b') {
      clearImmediate(this._escTimer);
      this._escTimer = setImmediate(() => {
        if (this._keyBuf === '\x1b') { this._keyBuf = ''; this._handleKey('\x1b'); this._afterKeys(); }
      });
      return;
    }
    let buf = this._keyBuf;
    while (buf.length) {
      let key;
      if (buf[0] === '\x1b') {
        const seq = buf.match(/^\x1b\[[0-9;]*[A-Za-z~]|^\x1bO[A-Za-z]|^\x1b./s);
        if (!seq) break; // wait for the rest of the sequence
        key = seq[0];
        buf = buf.slice(key.length);
      } else {
        key = buf[0];
        buf = buf.slice(1);
      }
      this._handleKey(key);
    }
    this._keyBuf = buf;
    this._afterKeys();
  }

  // Shared tail after a key batch: menu-dismissal reset on text change, draft
  // autosave, and one deferred frame.
  _afterKeys() {
    // any text change re-opens an Esc-dismissed slash menu and resets its selection
    if (this.editor.rev !== this._lastRev) {
      this._menuDismissed = false;
      this._menuSel = 0;
      this._lastRev = this.editor.rev;
      // autosave the in-progress draft once it is substantial
      if (this.editor.text.length >= 20) this._store.saveDraft(this.editor.text);
    }
    this._requestDraw();
  }

  _handleKey(key) {
    // Dialog stack on top: modal routing — every key goes to the top dialog,
    // esc closes it (focus restore happens inside closeTop).
    if (this._dialogs.isOpen()) {
      const chord = normalizeKey(key);
      if (chord === 'escape') { this._dialogs.closeTop(); return; }
      const top = this._dialogs.top;
      if (top.onKey?.(chord)) return;
      return; // modal: unconsumed keys fall into the void, never the composer
    }
    // Permission prompt (modal layer of the keymap): ←→/h/l cycle the pills,
    // enter confirms the selected pill, esc denies (the safest option). ↑↓
    // scroll an embedded diff preview when there is one.
    if (this._pendingApproval && !this.multiline) {
      const p = this._pendingApproval;
      // bare choice keys: y allow once / a always allow / n reject (the pill
      // row shows the same letters, ←→/enter and esc keep working)
      if (key === 'y') { this._resolveApproval('y'); return; }
      if (key === 'a') { this._resolveApproval('always'); return; }
      if (key === 'n') { this._resolveApproval('n'); return; }
      const cmd = this._keymap.resolve(['modal'], key);
      switch (cmd) {
        case 'approval.left': p.pillSel = (p.pillSel - 1 + p.pills.length) % p.pills.length; return;
        case 'approval.right': p.pillSel = (p.pillSel + 1) % p.pills.length; return;
        case 'approval.confirm': this._resolveApproval(p.pills[p.pillSel].id); return;
        case 'approval.deny': this._resolveApproval('n'); return;
        case 'approval.scroll.up': p.scroll = Math.max(0, p.scroll - 1); return;
        case 'approval.scroll.down': p.scroll = Math.min(Math.max(0, p.previewLines.length - 1), p.scroll + 1); return;
        default: break; // everything else falls through to the normal layers
      }
    }
    // A visible toast absorbs esc (dismiss it) before the esc cascade runs;
    // pending approvals keep their esc-denies precedence (checked above).
    if (this._toasts.current && normalizeKey(key) === 'escape') {
      this._toasts.dismiss();
      return;
    }
    // Popup completion menu takes priority over editor keys while it is open:
    // ↑↓ move the selection (history is untouched), Enter submits the selected
    // command (or accepts a mention into the draft), Tab accepts it, Esc closes
    // it. Any other key falls through to normal editing (which re-filters).
    if (this._reading) {
      const menu = this._slashCandidates();
      if (menu.length) {
        const sel = Math.min(this._menuSel, menu.length - 1);
        if (key === '\x1b[A') { this._menuSel = (sel - 1 + menu.length) % menu.length; return; }
        if (key === '\x1b[B') { this._menuSel = (sel + 1) % menu.length; return; }
        if (key === '\r') {
          if (menu[sel].kind === 'mention') {
            this.editor.setText(menu[sel].name); // accept the mention, keep editing
            this._menuSel = 0;
            return;
          }
          const line = this._interceptSubmit(menu[sel].name);
          if (line.trim() && !this.multiline) { this.editor.history.push(line); this._store.add(line); }
          this.multiline = false;
          this._menuSel = 0;
          this._finishRead(line);
          return;
        }
        if (key === '\t') {
          // slash accepts arg-ready with a trailing space; a mention may be a
          // path mid-token, so it accepts bare
          this.editor.setText(menu[sel].name + (menu[sel].kind === 'mention' ? '' : ' '));
          this._menuSel = 0;
          return;
        }
        if (key === '\x1b') { this._menuDismissed = true; return; }
      }
    }
    // keybind layers: composer bindings only while reading, global always.
    // The modal layer was consulted above for pending approvals.
    const stack = this._reading ? ['composer', 'global'] : ['global'];
    this._runCommand(this._keymap.resolve(stack, key), key);
  }

  // Bare /theme opens the picker dialog instead of reaching the REPL (which
  // would print a usage error for the missing argument). Same for /model:
  // bare or with a prefix ("/model clau") opens the model picker prefilled.
  _interceptSubmit(line) {
    if (this.multiline) return line;
    const trimmed = String(line).trim();
    if (trimmed === '/theme') {
      this._openThemePicker();
      return '';
    }
    const m = trimmed.match(/^\/model(?:\s+(.*))?$/);
    if (m) {
      this._openModelPicker((m[1] || '').trim());
      return '';
    }
    return line;
  }

  // /model: pick from the catalog models of every configured provider (apiKey
  // set or an env var present), grouped by provider name, showing the context
  // ceiling. The host's onModelPick applies the switch (hot-reload path).
  _openModelPicker(initialQuery = '') {
    let cfg = {};
    try { cfg = this._meta.getConfig(); } catch { /* no config source */ }
    const items = [];
    for (const p of configuredProviders(cfg)) {
      if (!p.configured) continue;
      for (const [mid, model] of Object.entries(p.models || {})) {
        if (!model || model.disabled) continue;
        const ctx = model.limit && typeof model.limit.context === 'number'
          ? ` · ctx ${Math.round(model.limit.context / 1000)}k`
          : '';
        items.push({
          id: `${p.id}/${mid}`,
          ref: `${p.id}/${mid}`,
          title: model.name || mid,
          description: `${mid}${ctx}`,
          group: p.name,
        });
      }
    }
    if (!items.length) {
      items.push({
        id: null,
        title: this.lang === 'zh' ? '（没有已配置的 provider——先 /setup 或设置 API key）' : '(no configured providers — run /setup or set an API key)',
        group: '',
      });
    }
    const ds = new DialogSelect({
      items,
      pageSize: 12,
      onPick: (item) => {
        this._dialogs.closeTop();
        if (!item.id) return;
        if (typeof this.onModelPick === 'function') this.onModelPick(item.ref);
        else this.print(`model: ${item.ref}`);
      },
    });
    ds.setQuery(initialQuery);
    this._openSelectDialog({
      id: 'model',
      title: this.lang === 'zh' ? '选择模型（输入过滤 · enter 切换）' : 'Pick a model (type to filter · enter to switch)',
      ds,
    });
  }

  _runCommand(cmd, key) {
    switch (cmd) {
      case 'editor.left': case 'editor.right':
      case 'editor.history.prev': case 'editor.history.next':
      case 'editor.tab':
      case 'editor.home': case 'editor.end':
      case 'editor.line.home': case 'editor.line.end':
      case 'editor.kill.word': case 'editor.kill.start': case 'editor.kill.end':
      case 'editor.word.forward': case 'editor.word.backward':
        if (this._reading) this.editor.handle(key);
        break;
      case 'editor.backspace':
        // shell mode: backspace on the bare '!' prefix exits the mode
        if (this._reading && this._shellMode && this.editor.text === '!') {
          this._shellMode = false;
          this.editor.reset();
          break;
        }
        if (this._reading) this.editor.handle(key);
        break;
      case 'editor.delete':
        if (this._reading) this.editor.handle(key);
        break;
      case 'scroll.up': this.scroll += 5; break;
      case 'scroll.down': this.scroll = Math.max(0, this.scroll - 5); break;
      case 'scroll.page.up': this.scroll += 20; break;
      case 'scroll.page.down': this.scroll = Math.max(0, this.scroll - 20); break;
      case 'mode.switch': this.onShiftTab?.(); break;
      case 'card.toggle': // ctrl+o: cycle the foldable cards — none expanded
        // expands the newest, an expanded card collapses and the next-older
        // one opens, the oldest collapses back to all-folded (with a single
        // foldable card this is a plain toggle)
        {
          const cards = this.entries.filter((e) => e.kind === 'card');
          if (!cards.length) break;
          let lastExpanded = -1;
          cards.forEach((e, i) => { if (e.card.expanded) lastExpanded = i; });
          for (const e of cards) {
            if (e.card.expanded) { e.card.expanded = false; this._invalidateEntry(e); }
          }
          const next = lastExpanded === -1 ? cards.length - 1 : lastExpanded - 1;
          if (next >= 0 && next < cards.length) {
            cards[next].card.expanded = true;
            this._invalidateEntry(cards[next]);
          }
        }
        break;
      case 'editor.newline': // Ctrl+J / shift+enter: enter multiline, then insert newlines
        if (!this.multiline) this.multiline = true;
        else this.editor.insert('\n');
        break;
      case 'app.escape': // cancel tab completion, dismiss menu, exit shell mode, else interrupt (double-press), else clear
        if (this.editor.tabBase !== null) this.editor.cancelCompletion();
        else if (this._slashCandidates().length) this._menuDismissed = true;
        else if (this._shellMode) { this._shellMode = false; this.editor.reset(); }
        else if (this.onInterrupt) { this._escInterruptConfirm(); }
        else this.editor.reset();
        break;
      case 'prompt.submit':
        if (this._reading) {
          const line = this._interceptSubmit(this.editor.text);
          if (line !== this.editor.text) { this.editor.reset(); this.multiline = false; this._finishRead(line); break; }
          if (this._shellMode) {
            // '!' prefix: run the rest of the line through the local shell and
            // keep reading — the model never sees it
            this._shellMode = false;
            this.editor.reset();
            if (line.length > 1) this._runShell(line.slice(1));
            break;
          }
          if (line.trim() && !this.multiline) { this.editor.history.push(line); this._store.add(line); }
          this.multiline = false;
          this._finishRead(line);
        }
        break;
      case 'app.commandPalette': this._openPalette(); break;
      case 'app.panel': this.togglePanel(); break;
      case 'app.sessions': this._openSessions(); break;
      case 'app.help': this._openHelp(); break;
      default:
        if (key >= ' ' && key.length === 1 && this._reading) {
          // '!' at an empty composer enters shell mode (the '!' stays as the prefix)
          if (key === '!' && this.editor.text === '') this._shellMode = true;
          this.editor.handle(key);
        }
        break;
    }
  }

  // --- dialogs: command palette / sessions / theme / help ---------------------------

  _openSelectDialog({ id, title, ds, actions = null }) {
    this._dialogs.open({
      id,
      title,
      render: (w) => ds.rows(w, { colors: this.colors, theme: this.theme }),
      renderActions: actions ? (w) => ds.actionBar(w, { colors: this.colors }) : null,
      onKey: (chord) => { ds.handleKey(chord); return true; },
    });
  }

  // Ctrl+P: every keybind command (chord + description, grouped by mode) plus
  // the UI's own commands; enter re-dispatches the command by name.
  _paletteCommands() {
    const items = [];
    for (const def of this._keymap.defs) {
      if (def.name.startsWith('approval.') || !def.keys.length) continue;
      items.push({
        id: def.name,
        title: def.name,
        description: `${def.keys[0]} — ${def.description}`,
        group: def.mode,
      });
    }
    items.push({ id: 'palette.theme', title: 'theme', description: this.lang === 'zh' ? '打开主题选择' : 'open the theme picker', group: 'app' });
    items.push({ id: 'palette.sessions', title: 'sessions', description: this.lang === 'zh' ? '最近会话列表' : 'recent sessions of this project', group: 'app' });
    return items;
  }

  _openPalette() {
    const ds = new DialogSelect({
      items: this._paletteCommands(),
      pageSize: 10,
      onPick: (item) => {
        this._dialogs.closeTop();
        if (item.id === 'palette.theme') { this._openThemePicker(); return; }
        if (item.id === 'palette.sessions') { this._openSessions(); return; }
        const def = this._keymap.defs.find((d) => d.name === item.id);
        if (def) this._runCommand(def.name, def.keys[0]);
      },
    });
    this._openSelectDialog({
      id: 'palette',
      title: this.lang === 'zh' ? '命令面板' : 'Command palette',
      ds,
    });
  }

  // Ctrl+G: recent sessions of this project (Session.list, newest first),
  // grouped by day. The core runs a single live session — picking one prints
  // the resume command unless the host wired onPickSession.
  _openSessions() {
    let files = [];
    try { files = Session.list(this._meta.cwd); } catch { files = []; }
    const today = new Date().toDateString();
    const items = files.slice(0, 50).map((file) => {
      const id = basename(file).replace(/\.jsonl$/, '');
      // session ids are ISO timestamps with ':'/'.' replaced by '-'; restore
      // them for parsing (yyyy-mm-ddThh-mm-ss-sssZ)
      const stamp = id.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      const parsed = Date.parse(stamp);
      const group = Number.isNaN(parsed)
        ? 'other'
        : (new Date(parsed).toDateString() === today ? 'Today' : new Date(parsed).toISOString().slice(0, 10));
      return { id: file, title: id, description: '', group };
    });
    if (!items.length) items.push({ id: null, title: this.lang === 'zh' ? '（本项目还没有历史会话）' : '(no past sessions for this project)', group: '' });
    const ds = new DialogSelect({
      items,
      pageSize: 10,
      onPick: (item) => {
        this._dialogs.closeTop();
        if (!item.id) return;
        if (typeof this.onPickSession === 'function') { this.onPickSession(item.id); return; }
        this.print(this.color(this.theme.inactive, this.lang === 'zh'
          ? `恢复会话需重启：cowcat -r ${item.id}`
          : `Resume with: cowcat -r ${item.id}`));
      },
    });
    this._openSelectDialog({
      id: 'sessions',
      title: this.lang === 'zh' ? '最近会话（切换需重启）' : 'Recent sessions (resume restarts)',
      ds,
    });
  }

  // /theme (bare) + palette entry: live preview while browsing, enter applies,
  // esc rolls back to the theme at open time (setTheme's cache invalidation
  // makes the preview/rollback immediate).
  _openThemePicker() {
    let confirmed = this.themeName;
    const ds = new DialogSelect({
      items: [
        { id: 'dark', title: 'dark', description: this.lang === 'zh' ? '深色' : 'dark theme' },
        { id: 'light', title: 'light', description: this.lang === 'zh' ? '浅色' : 'light theme' },
      ],
      pageSize: 8,
      onChange: (item) => { if (item) this.setTheme(item.id); }, // live preview
      onPick: (item) => {
        confirmed = item.id;
        this.setTheme(item.id);
        this.print(`theme: ${item.id}`);
        this._dialogs.closeTop();
      },
    });
    this._dialogs.open({
      id: 'theme',
      title: this.lang === 'zh' ? '主题（enter 应用 · esc 回滚）' : 'Theme (enter to apply · esc to revert)',
      render: (w) => ds.rows(w, { colors: this.colors, theme: this.theme }),
      onKey: (chord) => { ds.handleKey(chord); return true; },
      onClose: () => { if (confirmed !== this.themeName) this.setTheme(confirmed); },
    });
  }

  // ? (or ctrl+alt+k on kitty-encoded terminals): the which-key panel — every
  // binding from the keybind table, filterable by command name, grouped by mode.
  _openHelp() {
    const items = this._keymap.defs
      .filter((d) => d.keys.length)
      .map((d) => ({
        id: d.name,
        title: d.name,
        description: d.keys.join(', '),
        group: d.mode,
      }));
    const ds = new DialogSelect({ items, pageSize: 12 });
    this._openSelectDialog({
      id: 'help',
      title: this.lang === 'zh' ? '键位一览' : 'Keybindings',
      ds,
    });
  }

  // Shell mode (composer prefix '!'): run the command locally and stream the
  // result into the transcript as plain output; the pending readLine is kept
  // alive so the user keeps typing afterwards.
  _runShell(command) {
    const cmd = String(command).trim();
    if (!cmd) return;
    this.print(this.color(this.theme.permission, `! ${cmd}`));
    const started = Date.now();
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : 'bash';
    const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    execFile(shell, args, { cwd: this._meta.cwd, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      const out = decodeOutput(stdout).replace(/\s+$/, '');
      const errOut = decodeOutput(stderr).replace(/\s+$/, '');
      const code = typeof err?.code === 'number' ? err.code : (err ? 1 : 0);
      const timedOut = err?.killed === true;
      const s = Math.max(0, Math.round((Date.now() - started) / 1000));
      if (code === 0 && !timedOut) {
        if (out) for (const l of out.split('\n').slice(0, 30)) this.print(l);
        this.print(this.color(this.theme.inactive, `exit 0 · ${s}s`));
        return;
      }
      // failure: a red-tinted error card (failing command, exit code, collapsed
      // output tail) — never a raw stderr dump into the transcript
      const combined = [out, errOut].filter(Boolean).join('\n');
      const collapsed = collapseToolOutput(combined || '(no output)').lines.map(String);
      const card = createCard('tool', `● ${truncateAnsi(cmd, 60)}`);
      card.status = 'error';
      const codeLine = this.color(this.theme.error, timedOut ? `✗ killed (30s timeout)` : `✗ exit ${code}`);
      card.summaryLines = [codeLine, ...collapsed.slice(0, 3)];
      card.fullLines = [codeLine, ...collapsed];
      this.entries.push(new CardRegion(card, this._style));
      this._follow();
      this._requestDraw();
    });
  }

  // Esc double-press interrupt (Open Code semantics): the first press inside
  // the 5s window arms the confirmation and shows a warning hint; the second
  // press fires the actual interrupt. The window re-arms after expiry.
  _escInterruptConfirm() {
    if (this._escArmed) {
      this._escArmed = false;
      if (this._escArmTimer) { clearTimeout(this._escArmTimer); this._escArmTimer = null; }
      this.onInterrupt();
      return;
    }
    this._escArmed = true;
    this._escArmTimer = setTimeout(() => {
      this._escArmed = false;
      this._escArmTimer = null;
      this._requestDraw(); // clear the warning hint
    }, this._escArmMs);
    if (this._escArmTimer.unref) this._escArmTimer.unref();
  }

  // --- rendering ------------------------------------------------------------------

  _follow() {
    // auto-scroll only when the user is already at the bottom
    const { height } = this._size();
    const transH = Math.max(1, height - this._inputBox().length - 1);
    const maxScroll = Math.max(0, this._lineTotal(this._contentWidth()) - transH);
    if (this.scroll >= maxScroll - 2) this.scroll = maxScroll;
  }

  _size() {
    const width = this.output.columns || 80;
    const height = Math.max(10, (this.output.rows || 24) - 1);
    return { width, height };
  }

  // --- right sidebar panel (P3) ---------------------------------------------------

  // Live panel width (0 = hidden, single-column). Auto-hide on narrow terminals.
  _sidebarWidth(termWidth = null) {
    try { return sidebarWidth(this.panelVisible, termWidth ?? this._size().width); } catch { return 0; }
  }

  // Width available to transcript + composer + status: the terminal width minus
  // the panel column and its separator column. This is THE place width shrinks.
  _contentWidth() {
    const { width } = this._size();
    const sbW = this._sidebarWidth(width);
    return width - sbW - (sbW ? 1 : 0);
  }

  // Flip the panel (force to an explicit state when given). The host can mirror
  // the outcome via onTogglePanel; narrow terminals get a warning toast.
  togglePanel(force = null) {
    const next = force === null ? !this.panelVisible : !!force;
    if (next === this.panelVisible) return this.panelVisible;
    this.panelVisible = next;
    this.onTogglePanel?.(next);
    if (next && this._sidebarWidth() === 0) {
      this.toast('warning', this.lang === 'zh' ? '面板' : 'Panel',
        this.lang === 'zh' ? '终端太窄（<100 列），面板已自动隐藏' : 'terminal too narrow (<100 cols), panel auto-hidden');
    } else {
      this.toast('info', this.lang === 'zh' ? '面板' : 'Panel', next ? 'on' : 'off');
    }
    this.screen.lastLines = null; // column count changed: force a full rewrite
    this._draw();
    return this.panelVisible;
  }

  // Assemble the panel data from the duck-typed getters (all optional/best-effort).
  _sidebarData() {
    const m = this._meta;
    let pct = 0, used = '0', max = '?';
    try {
      const cfg = m.getConfig();
      const limit = contextLimit(cfg) || 100000;
      max = formatTokenCount(limit);
      const messages = m.getMessages();
      if (messages.length) {
        pct = analyzeContext(messages, limit, {}).pct ?? 0;
        used = formatTokenCount(estimateTokens(messages));
      }
    } catch { /* no context source: show the unknowns */ }
    let mode = 'default';
    try { mode = m.getPermissions?.()?.mode ?? m.getMode() ?? 'default'; } catch { /* keep default */ }
    let model = '';
    try { model = m.getModel() ?? ''; } catch { /* none */ }
    let effort = null;
    try { effort = m.getConfig()?.effort ?? null; } catch { /* none */ }
    let mcp = null;
    try { mcp = m.getMcp?.() ?? null; } catch { /* none */ }
    let todos = null;
    try { todos = m.getTodos?.() ?? null; } catch { /* none */ }
    return { pct, used, max, model, effort, mode, mcp, todos };
  }

  // Auto completion popup: a trigger is '@' or '/' at line start or right
  // after whitespace, with a whitespace-free query (see complete.js). Slash
  // candidates come from the command registry and are ranked prefix-first with
  // a frecency bonus; mention candidates come from the file provider already
  // filtered. Esc dismisses until the text changes (see _afterKeys).
  _slashCandidates() {
    const ed = this.editor;
    if (ed.tabBase !== null || this._menuDismissed === true) return [];
    const trigger = triggerOf(ed.text);
    if (!trigger) return [];
    if (trigger.kind === 'slash') {
      if (!this.completions) return [];
      const names = this.completions(ed.text);
      const items = names.map((name) => {
        const doc = this.commandDocs?.find((d) => d.name === name);
        return { name, desc: doc ? (this.lang === 'zh' ? doc.zh : doc.en) : '', kind: 'slash' };
      });
      // No cap here: the legacy scroll-window contract (n/m counter over the
      // full candidate list) is pinned by existing tests; the visible window
      // stays at 8 rows inside _menuLines.
      const ranked = rankCandidates(trigger.query, items, this._store, { limit: 1000 });
      // an exact command match is not a candidate anymore
      return ranked.filter((it) => it.name !== ed.text);
    }
    if (!this.fileCompletions) return [];
    const candidates = this.fileCompletions(trigger.query).slice(0, 20);
    // the provider already filtered: rank only for order, capped at 10
    return rankCandidates('', candidates, null, { limit: 10 }).map((it) => ({ name: it.name, desc: '', kind: 'mention' }));
  }

  // Popup menu rows: selected row shows a brand `→` + brand command name,
  // other rows are space-indented; a dim description column (fixed 18-col name
  // field) and a bottom `(n/m)` counter follow. At most 8 rows are visible;
  // the window scrolls so the selection always stays in view.
  _menuLines(cands, w) {
    const MENU_MAX = 8;
    const NAME_W = 18;
    const sel = Math.min(this._menuSel, cands.length - 1);
    const start = Math.min(Math.max(0, sel - (MENU_MAX - 1)), Math.max(0, cands.length - MENU_MAX));
    const descW = Math.max(8, w - 4 - NAME_W - 1);
    const lines = [];
    for (let i = start; i < Math.min(cands.length, start + MENU_MAX); i++) {
      const c = cands[i];
      const nameCol = visibleLen(c.name) > NAME_W
        ? truncateAnsi(c.name, NAME_W)
        : c.name + ' '.repeat(NAME_W - visibleLen(c.name));
      const isSel = i === sel;
      const arrow = isSel ? this.color(this.theme.brand, '→') : ' ';
      const name = isSel ? this.color(this.theme.brand, nameCol) : nameCol;
      const desc = c.desc ? ' ' + this.color(this.theme.inactive, truncateAnsi(c.desc, descW)) : '';
      lines.push(truncateAnsi(`  ${arrow} ${name}${desc}`, w));
    }
    lines.push(this.color(this.theme.inactive, `  (${sel + 1}/${cands.length})`));
    return lines;
  }

  _inputBox() {
    return [...this._inputFixed(), ...this._inputOverlay()];
  }

  // The input block, Open Code layout: an optional metadata row (`model ·
  // mode`) above the left-border composer. No top bar, no context line — the
  // branch/cwd live in the status bar, model only in the metadata row.
  _inputFixed() {
    // A pending approval replaces the composer with the PermissionPrompt
    // (mutually exclusive input-area rendering). The guard on `pills` keeps
    // hand-built pending stubs (tests) on the normal input path.
    if (this._pendingApproval?.pills) return this._permissionPrompt(this._contentWidth());
    const w = this._contentWidth();
    const placeholder = this._promptText || (this._shellMode
      ? (this.lang === 'zh' ? '! 本地 shell 命令（esc 退出）' : '! local shell command (esc to exit)')
      : this._currentPlaceholder());
    const { cursorCol } = this.editor.render(w);
    let box = buildInputBox({
      text: this.editor.text, width: w, theme: this.theme, placeholder,
      multiline: this.multiline, cursor: cursorCol,
    });
    // composer height cap: max(6, height/3), the tail (caret row) survives
    const { height } = this._size();
    const maxRows = Math.max(6, Math.floor(height / 3));
    if (box.length > maxRows) box = box.slice(-maxRows);
    const meta = this._metadataRow(w);
    return [...(meta ? [meta] : []), ...box];
  }

  // Offset of the first composer body row inside the input block: 1 when the
  // metadata row is present, 0 otherwise (cursor math in _drawNow).
  _inputBodyOffset() {
    return this._metadataRow(this._contentWidth()) ? 1 : 0;
  }

  // PermissionPrompt: header + tool description + embedded scrollable diff
  // preview (edit-type tools) + the pill option row. Rendered in place of the
  // input box while an approval is pending.
  _permissionPrompt(w) {
    const p = this._pendingApproval;
    const warn = (s) => this.color(this.theme.warning, s);
    const dim = (s) => this.color(this.theme.inactive, s);
    const lines = [];
    lines.push(padLine(`${warn('△ Permission required')}`, w));
    lines.push(padLine(`  ${p.toolName}: ${truncateAnsi(p.summary, Math.max(10, w - p.toolName.length - 6))}`, w));
    if (p.ruleLine) lines.push(padLine(dim(`  ${p.ruleLine}`), w));
    const MAXPREV = 6;
    if (p.previewLines.length) {
      const maxScroll = Math.max(0, p.previewLines.length - MAXPREV);
      p.scroll = Math.min(p.scroll, maxScroll);
      const last = Math.min(p.previewLines.length, p.scroll + MAXPREV);
      lines.push(padLine(dim(`  ┌─ diff preview (${p.scroll + 1}-${last}/${p.previewLines.length})`), w));
      for (const l of p.previewLines.slice(p.scroll, p.scroll + MAXPREV)) {
        lines.push(padLine(truncateAnsi(`  │ ${l}`, w), w));
      }
    }
    const pills = p.pills.map((pill, i) => {
      const label = ` ${pill.label} `;
      return i === p.pillSel && this.colors ? `\x1b[7m${label}\x1b[0m` : label;
    }).join('  ');
    lines.push(padLine(`  ${pills}`, w));
    lines.push(padLine(dim(this.lang === 'zh'
      ? '  y 允许一次 · a 总是允许 · n 拒绝（←→ 选择 · enter 确认 · esc 拒绝）'
      : '  y allow once · a always allow · n reject (←→ choose · enter confirm · esc deny)'), w));
    lines.push('');
    return lines;
  }

  // Floating overlay rows, painted ABOVE the input block at their content
  // width (capped at 60) on the raised surface: the completion menu / the
  // @-mention tab-cycle row, then the multiline hint.
  _inputOverlay() {
    const w = this._contentWidth();
    const rows = [];
    const ed = this.editor;
    if (ed.tabBase !== null && ed.tabCandidates.length) {
      // @-mention Tab-cycle row: current pick highlighted, rest dim, n/m counter
      const idx = ed.tabIdx;
      const shown = ed.tabCandidates.map((c, i) => (i === idx ? this.color(this.theme.brand, c) : this.color('\x1b[90m', c)));
      let row = ' ' + shown.join(this.color('\x1b[90m', '  '));
      if (idx < ed.tabCandidates.length) row += this.color('\x1b[90m', `  ${idx + 1}/${ed.tabCandidates.length}`);
      rows.push(truncateAnsi(row, w));
    } else {
      // popup completion menu (slash commands / @-mentions)
      const cands = this._slashCandidates();
      if (cands.length) rows.push(...this._menuLines(cands, w));
    }
    if (this.multiline) rows.push(` ${this.color('\x1b[90m', this.lang === 'zh' ? '[多行模式 Ctrl+J 退出]' : '[multiline Ctrl+J to exit]')}`);
    return rows;
  }

  // Metadata row above the composer: `model · mode` — the ONLY place the
  // model appears (mode is warning+bold). An armed esc-interrupt appends its
  // warning. Degrades under 44 columns (model only).
  _metadataRow(w) {
    const mode = this._meta.getMode();
    const modeLabel = mode === 'plan' ? 'plan' : 'act';
    const line = metadataLine(
      { agent: this._meta.getConfig().agent ?? null, model: this._meta.getModel(), variant: modeLabel },
      w, this.theme, this.colors,
    );
    if (!line) return '';
    if (!this._escArmed) return line;
    const warn = this.color(this.theme.warning, this.lang === 'zh' ? '再按一次 esc 中断' : 'esc again to interrupt');
    return `${line} ${this.color(this.theme.inactive, '·')} ${warn}`;
  }

  // Status bar (the only status row, Open Code layout):
  //   left  = `~/dir:branch` (muted) — or the spinner + `esc interrupt` while
  //           the model is streaming (esc arms the double-press interrupt)
  //   right = `tokens (pct)` · `$cost` · `shift+tab act/plan · ctrl+p commands`
  //           (dropping right-to-left under width pressure; segments with no
  //           real data are omitted, never faked)
  // The model lives only in the metadata row; cwd only in the left cluster.
  _status() {
    const m = this._meta;
    const cfg = m.getConfig();
    const w = this._contentWidth();
    const dim = (s) => this.color(this.theme.inactive, s);

    const info = [];
    try {
      const messages = m.getMessages();
      if (messages.length) {
        const analysis = analyzeContext(messages, contextLimit(cfg) || 100000, {});
        info.push(dim(`${formatTokenCount(estimateTokens(messages))} (${analysis.pct}%)`));
      }
    } catch { /* no messages source: omit the usage segment */ }
    const cost = m.getCost();
    const costNum = Number(cost);
    if (cost && Number.isFinite(costNum)) info.push(dim(formatCost(costNum)));
    info.push(
      `${this.color(this.theme.brand, 'shift+tab')} ${dim('act/plan')}`
      + ` · ${this.color(this.theme.brand, 'ctrl+p')} ${dim('commands')}`,
    );

    const left = this._streaming
      ? `${this.color(this.theme.permission, SPINNER[this.spinFrame % SPINNER.length])} ${dim('esc interrupt')}`
      : this._dirCluster(dim);
    return footerBarLine({ width: w, left, chips: [], info }).line;
  }

  // `~/dir` + `:branch` — the branch only shows when git resolved a real one;
  // unresolved ('-'), detached ('HEAD') or placeholder junk never leaks.
  _dirCluster(dim) {
    const dir = dim(abbreviateDir(this._meta.cwd, this._home));
    const branch = String(this._branch || '');
    if (branch === '' || branch === '-' || branch === 'HEAD' || branch === '~') return dir;
    return `${dir}:${this.colors ? `\x1b[1m${branch}\x1b[0m` : branch}`;
  }

  // One-line startup banner: version · abbreviated cwd · model · MCP count.
  // Hidden entirely on narrow terminals (height < 14 or width < 44).
  _startupInfo() {
    const { width, height } = this._size();
    if (height < 14 || width < 44) return null;
    const parts = [`CowCat ${this._meta.version}`];
    parts.push(abbreviateDir(this._meta.cwd, this._home));
    const model = this._meta.getModel();
    if (model) parts.push(String(model));
    try {
      const mcp = Object.keys(this._meta.getConfig().mcpServers ?? {}).length;
      if (mcp > 0) parts.push(`${mcp} MCP`);
    } catch { /* MCP list unavailable: omit */ }
    return this.color(this.theme.inactive, parts.join(' · '));
  }

  // Dirty-mark a region and re-materialize it synchronously at the current
  // width (region caches make this cheap); only the screen write is deferred
  // to the frame scheduler, so callers observe fresh `entries` immediately.
  _invalidateEntry(entry) {
    if (!entry) return;
    entry.markDirty();
    entry.lines(this._contentWidth());
  }

  _createMarkdownRenderer(width) {
    return createMarkdownRenderer({
      theme: this.theme, width,
      highlight: (code, lang) => highlightCode(code, lang, this.theme),
      osc8: this._osc8,
    });
  }

  // Per-entry render cache: same entry + same width returns the same lines
  // array; mutating callers mark it dirty to force a recompute. Live entries
  // are Region objects; the kind-switch fallback keeps plain data entries
  // (legacy fixtures with {kind,lines,card,...} shapes) working too.
  _materialize(entry, width) {
    if (typeof entry.lines === 'function') return entry.lines(width);
    if (entry._rendered && entry._rendered.width === width) return entry._rendered.lines;
    let lines;
    if (entry.kind === 'card') {
      lines = entry.card.kind === 'approval'
        ? renderApprovalCard(entry.card, { width, colors: this.colors, theme: this.theme })
        : renderCard(entry.card, { width, spinFrame: this.spinFrame, colors: this.colors, theme: this.theme });
    } else if (entry.kind === 'user') {
      lines = renderUserBubble(entry.text, width, this.theme, this.colors);
    } else if (entry.kind === 'assistant') {
      if (entry.rendererWidth !== width) {
        // plain-entry replay: rebuild the renderer and re-feed the raw stream
        entry.renderer = this._createMarkdownRenderer(width);
        entry.rendererWidth = width;
        const rows = entry.renderer.push(entry.raw);
        entry.closedRows = rows.slice(0, rows.splitIndex);
        entry.tailRows = rows.slice(rows.splitIndex);
      }
      lines = [...entry.closedRows, ...entry.tailRows].map((r) => r.text);
    } else {
      lines = [];
      for (const l of entry.lines) lines.push(...wrapText(l, width));
    }
    entry._rendered = { width, lines };
    return lines;
  }

  // Full transcript materialization (test/diagnostic surface); the hot draw
  // path uses materializeWindow over the visible scroll range instead.
  _flat() {
    const width = this._contentWidth();
    const lines = [];
    for (const e of this.entries) lines.push(...e.lines(width));
    return lines;
  }

  // Exact transcript line count at a width without building the flat array;
  // regions answer from their cache or a cheap height probe.
  _lineTotal(width) {
    let total = 0;
    for (const e of this.entries) total += e.heightAt(width);
    return total;
  }

  // --- frame scheduling -----------------------------------------------------------
  // Event bursts (stream chunks, key batches) invalidate regions synchronously
  // but merge their screen writes: the first invalidation arms a setImmediate
  // and later ones in the same turn of the loop are free. _draw() stays a
  // synchronous forced frame for resize/explicit-callers.

  _requestDraw() {
    if (this._drawTimer !== null || !this.screen.active) return;
    this._drawTimer = setImmediate(() => {
      this._drawTimer = null;
      this._drawNow();
    });
  }

  _cancelScheduledDraw() {
    if (this._drawTimer !== null) { clearImmediate(this._drawTimer); this._drawTimer = null; }
  }

  // Immediate synchronous frame; also cancels any pending deferred frame.
  _draw() {
    this._cancelScheduledDraw();
    if (!this.screen.active) return;
    this._drawNow();
  }

  _drawNow() {
    if (!this.screen.active) return;
    const { width, height } = this._size();
    // Layout uses the FIXED block only (metadata + composer rows). The floating
    // overlay (completion menu / hints) paints over the transcript ABOVE the
    // composer without claiming layout rows — OC-style, the composer +
    // status bar own the frame bottom with nothing in between.
    const sbW = this._sidebarWidth(width);
    const w = width - sbW - (sbW ? 1 : 0); // content width: everything but panel + separator
    const fixedInput = this._inputFixed();
    const overlay = this._inputBox().slice(fixedInput.length);
    const transH = Math.max(1, height - fixedInput.length - 1);
    const off = scrollClamp(this._lineTotal(w), transH, this.scroll);
    // Only regions intersecting [off, off+transH) are materialized; the window
    // is handed to buildScreen with scroll=0, which pads the tail with blank
    // rows exactly like the old full-flat + scroll path. (No top header — the
    // OC session screen is chrome-free at the top.)
    const transcript = materializeWindow(this.entries, w, off, transH);
    const frame = buildScreen({
      header: [],
      transcript,
      input: fixedInput,
      status: this._status(),
      width: w, height,
      scroll: 0,
    });
    // Floating overlay: completion menu / hints render ABOVE the composer —
    // the frame rows directly over the bottom of the transcript window — via
    // absolute coordinates, at their content width (capped at 60) on the
    // raised surface.
    const inputStart = height - fixedInput.length - 1;
    let overlayPainted = 0;
    const bg = this.theme.userBubbleBg ?? '';
    for (let j = overlay.length - 1; j >= 0 && inputStart - 1 - overlayPainted >= 0; j--, overlayPainted++) {
      const rawRow = overlay[j];
      const content = String(rawRow).replace(/\s+$/, '');
      const rowW = Math.max(20, Math.min(60, visibleLen(content) + 2));
      const padded = padLine(truncateAnsi(content, rowW), rowW);
      const painted = bg && this.colors ? `${bg}${padded}\x1b[0m` : padded;
      frame[inputStart - 1 - overlayPainted] = painted + ' '.repeat(Math.max(0, w - rowW));
    }
    // Scrolled away from the bottom with no menu open: point the way back.
    if (overlayPainted === 0 && this.scroll < Math.max(0, this._lineTotal(w) - transH) && inputStart > 0) {
      const hint = this.color(this.theme.inactive, this.lang === 'zh'
        ? '  ↓ PgDn 回到最新'
        : '  ↓ PgDn to jump to latest');
      frame[inputStart - 1] = hint + ' '.repeat(Math.max(0, w - visibleLen(hint)));
    }
    // While editing, place the hardware cursor at the editor's caret inside
    // the input box; otherwise leave it hidden (streaming output needs none).
    // A dialog steals the frame: no caret, dimmed backdrop, box on top.
    let cursor = null;
    if (this._reading && !this._dialogs.isOpen()) {
      const { cursorRow, cursorCol } = this.editor.render(w);
      const pad = w < 44 ? 1 : 2;
      const bodyW = w - pad - 2; // border + '› '
      // buildInputBox left-scrolls the last row when the caret overflows it
      const visibleCursorCol = cursorCol - Math.max(0, cursorCol - bodyW + 1);
      const inputStartRow = height - fixedInput.length - 1;
      // input block: [metadata?, composer rows...] — body starts at +offset
      cursor = { row: inputStartRow + this._inputBodyOffset() + cursorRow, col: 1 + pad + 2 + visibleCursorCol };
    }
    if (this._dialogs.isOpen()) this._paintDialog(frame, w, height);
    else this._paintToasts(frame, w);
    // Right sidebar panel: stitch the dim separator + panel column onto every
    // frame row. buildScreen produced exactly `height` rows of width w.
    if (sbW) {
      const side = renderSidebar(this._sidebarData(), sbW, height, {
        theme: this.theme, colors: this.colors, lang: this.lang,
      });
      frame.splice(0, frame.length, ...stitchSidebar(frame, side, w, sbW, { theme: this.theme, colors: this.colors }));
    }
    this.screen.draw(frame, cursor);
  }

  // Toasts: top-right overlay (top=1, right=2) on the raised surface, variant
  // bars left/right, `+N more` tail for the queue. Painted below dialogs.
  _paintToasts(frame, width) {
    const { boxW, rows } = renderToast(this._toasts.current, this._toasts.pending, {
      maxWidth: Math.min(60, width - 6),
      colors: this.colors,
      theme: this.theme,
    });
    if (!boxW) return;
    const bg = this.theme.userBubbleBg ?? '';
    const left = Math.max(0, width - 2 - boxW);
    for (let i = 0; i < rows.length && 1 + i < frame.length; i++) {
      const painted = bg ? `${bg}${rows[i]}\x1b[0m` : rows[i];
      frame[1 + i] = ' '.repeat(left) + painted + ' '.repeat(Math.max(0, width - left - boxW));
    }
  }

  // Dialog overlay: dim the rows outside the dialog band, then paint the box
  // (brand title bar + content + action bar) on a solid surface, horizontally
  // centered, paddingTop = height/4 like the OC Dialog.
  _paintDialog(frame, width, height) {
    const d = this._dialogs.top;
    if (!d) return;
    const boxW = Math.min(dialogWidth(pickDialogSize(width)), width - 2);
    const padTop = Math.floor(height / 4);
    const title = ` ${d.title} `;
    const content = d.render(boxW) ?? [];
    const actions = d.renderActions?.(boxW) ?? [];
    const rule = this.colors ? `${this.theme.inactive}${'─'.repeat(boxW)}\x1b[0m` : '─'.repeat(boxW);
    const box = [
      padLine(truncateAnsi(`${this.color(this.theme.brand, '▎')}${title}`, boxW), boxW),
      ...content,
      ...(actions.length ? [rule, ...actions] : []),
    ];
    const left = Math.max(0, Math.floor((width - boxW) / 2));
    const bg = this.theme.userBubbleBg ?? '';
    for (let r = 0; r < frame.length; r++) {
      if (r < padTop || r >= padTop + box.length) frame[r] = this.colors ? `\x1b[2m${frame[r]}\x1b[0m` : frame[r];
    }
    for (let i = 0; i < box.length && padTop + i < frame.length; i++) {
      const row = padLine(truncateAnsi(box[i], boxW), boxW);
      const painted = bg ? `${bg}${row}\x1b[0m` : row;
      frame[padTop + i] = ' '.repeat(left) + painted + ' '.repeat(Math.max(0, width - left - boxW));
    }
  }

  _tick() {
    this.spinFrame++;
    this._style.spinFrame = this.spinFrame;
    for (const e of this.entries) {
      if (e.kind === 'card' && e.card.status === 'running') e.markDirty();
    }
    this._requestDraw();
    this._syncSpinner();
  }

  // The spinner interval only runs while something animated is visible (a
  // running tool card or a streaming model footer), and never when animations
  // are disabled — the spinner then renders as a static frame.
  _syncSpinner() {
    const want = this.screen.active && this._animations
      && (this._streaming || this.entries.some((e) => e.kind === 'card' && e.card.status === 'running'));
    if (want && !this._timer) {
      this._timer = setInterval(() => this._tick(), SPINNER_MS);
      if (this._timer.unref) this._timer.unref();
    } else if (!want && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // hooks the loop/bin sometimes touch
  // Swap the palette (dark/light): re-parse tokens, mark every region dirty
  // (assistant regions rebuild their markdown renderer) so the next draw
  // re-renders the whole transcript in the new theme.
  setTheme(name) {
    if (name !== 'dark' && name !== 'light') return false;
    this.theme = getTheme(name, this._colorLevel);
    this.themeName = name;
    this._style.theme = this.theme;
    this._style.colors = this.colors;
    for (const e of this.entries) {
      e.markDirty();
      e.onThemeChange();
    }
    // toast the switch — except while the theme picker is live-previewing
    if (this._dialogs.top?.id !== 'theme') {
      this.toast('info', this.lang === 'zh' ? '主题' : 'Theme', name);
    }
    this._draw();
    return true;
  }
}
