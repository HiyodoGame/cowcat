// TuiUI: full-screen duck-typed replacement for the line-mode UI. Implements
// the exact interface bin/cowcat.mjs consumes (print/streamChunk/toolCall/
// approve/askQuestions/readLine/...) so the REPL and loop need no changes.
// Degrades out of the picture entirely unless the caller opts in.
import { Screen } from './screen.js';
import {
  renderHeader, renderStatus, renderCard, createCard, buildScreen,
  wrapText, truncateAnsi, visibleLen, padLine, SPINNER, renderUserBubble,
  buildInputBox,
} from './render.js';
import { renderFileCard, renderGroup } from '../diffcard.js';
import { LineEditor } from '../lineeditor.js';
import { analyzeContext } from '../contextviz.js';
import { getTheme } from './theme.js';
import { detectCapabilities } from './capabilities.js';
import { createMarkdownRenderer } from './markdown.js';
import { highlightCode } from './highlight.js';

const SPINNER_MS = 150;

// Approval card frame: permission-tinted mark/border column. Body folds to
// the quip; ctrl+o expands to the fullLines (quip + diff preview rows).
function renderApprovalCard(card, { width, colors = true, theme = null } = {}) {
  const perm = theme?.permission ?? '\x1b[36m';
  const p = (s) => (colors ? `${perm}${s}\x1b[0m` : s);
  const lines = [padLine(`${p('✓')} ${card.title}`, width)];
  const shown = card.expanded ? card.fullLines : card.summaryLines;
  for (const l of shown.slice(0, card.expanded ? 30 : 3)) {
    lines.push(padLine(`  ${p('│')} ${truncateAnsi(l, width - 4)}`, width));
  }
  if (!card.expanded && card.fullLines.length > 3) {
    lines.push(padLine(`  ${p('│')} ··· (${card.fullLines.length} lines) ···`, width));
  }
  if (card.expanded || card.fullLines.length > 3) {
    lines.push(padLine(`  ${p('· ctrl+o to expand/collapse')}`, width));
  }
  return lines;
}

export class TuiUI {
  constructor({
    input = process.stdin, output = process.stdout, colors = true, lang = 'zh',
    version = '0.8.0', cwd = process.cwd(),
    getModel = () => '', getMode = () => 'default', getCost = () => '', getConfig = () => ({}), getMessages = () => [],
    completions = null, fileCompletions = null,
    capabilities = null,
  } = {}) {
    this.input = input;
    this.output = output;
    this.colors = colors;
    this.lang = lang;
    this.t = { noDiff: '这回合还没有 diff。' };
    this.interactive = true;
    this.screen = new Screen({ input, output });
    this.entries = [];          // {kind:'user',text,_rendered} | {kind:'assistant',raw,rows,prevLen,done,renderer,_rendered} | {kind:'text',lines,_rendered} | {kind:'card',card,_rendered}
    this.scroll = 0;
    this.spinFrame = 0;
    this._timer = null;         // spinner interval, only while a card is running
    this._turnStart = null;     // userMessage timestamp, consumed by endStream footer
    this.completions = completions;         // (prefix) => string[] of "/name"
    this.fileCompletions = fileCompletions; // (prefix) => string[] of "@path"
    this.editor = new LineEditor({
      completions: () => (this.completions ? this.completions(this.editor.text) : []),
      fileCompletions: (prefix) => (this.fileCompletions ? this.fileCompletions(prefix) : []),
    });
    this.onShiftTab = null;
    this.onInterrupt = null;
    this.multiline = false;
    this._reading = null;
    this._menuDismissed = false;  // slash menu dismissed via Esc until the text changes
    this._lastRev = 0;
    this._promptText = '';
    this._pendingApproval = null;
    this._meta = { version, cwd, getModel, getMode, getCost, getConfig, getMessages };
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
  }

  // --- lifecycle ---------------------------------------------------------------

  start() {
    this.screen.enter();
    this.input.setRawMode?.(true);
    this._dispatch = (chunk) => this._onKeys(chunk);
    this.input.on('data', this._dispatch);
    this._onResize = () => this._draw();
    this.output.on?.('resize', this._onResize);
    this._draw();
    this._syncSpinner();
  }

  close() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._dispatch) this.input.off?.('data', this._dispatch);
    if (this._onResize) this.output.off?.('resize', this._onResize);
    this.input.setRawMode?.(false);
    this.screen.leave();
  }

  attachAnimator() {}
  setLang(lang) { this.lang = lang; }

  color(code, s) { return this.colors ? `${code}${s}\x1b[0m` : s; }

  // --- transcript API (same shapes as the line-mode UI) --------------------------

  print(s = '') {
    const lines = String(s).split('\n');
    this.entries.push({ kind: 'text', lines, _rendered: null });
    this._follow();
    this._draw();
  }

  // User turn marker: starts the turn clock and appends a bubble entry.
  userMessage(text) {
    this._turnStart = Date.now();
    this.entries.push({ kind: 'user', text: String(text), _rendered: null });
    this._follow();
    this._draw();
  }

  // The renderer returns newly closed rows (emitted once, kept forever) plus a
  // full re-render of the open tail (replaced wholesale on every push); the
  // array's splitIndex marks the boundary between the two sections. A push
  // flagged `supersedes` (the fast→full markdown transition) re-renders the
  // previously emitted rows, so the closed section replaces the accumulated
  // rows instead of appending to them.
  streamChunk(s) {
    let e = this.entries[this.entries.length - 1];
    if (!e || e.kind !== 'assistant' || e.done) {
      const width = this._size().width;
      e = this._newAssistantEntry(width);
      this.entries.push(e);
    }
    const chunk = String(s);
    e.raw += chunk;
    const rows = e.renderer.push(chunk);
    if (rows.supersedes) e.closedRows = rows.slice(0, rows.splitIndex);
    else e.closedRows.push(...rows.slice(0, rows.splitIndex));
    e.tailRows = rows.slice(rows.splitIndex);
    e._rendered = null;
    this._follow();
    this._draw();
  }

  endStream() {
    const e = this.entries[this.entries.length - 1];
    if (e && e.kind === 'assistant' && !e.done) {
      const rows = e.renderer.push('');
      if (rows.supersedes) e.closedRows = rows.slice(0, rows.splitIndex);
      else e.closedRows.push(...rows.slice(0, rows.splitIndex));
      e.tailRows = rows.slice(rows.splitIndex);
      e.done = true;
      e._rendered = null;
    }
    const s = this.turnSeconds();
    this._turnStart = null;
    this.print(this.color(this.theme.inactive, `✻ for ${s < 60 ? `${s}s` : `${Math.round(s / 60)}m`}`));
  }

  turnSeconds() {
    if (!this._turnStart) return 0;
    return Math.max(0, Math.round((Date.now() - this._turnStart) / 1000));
  }

  waitingModel() {}
  compacting() { this.print(this.color('\x1b[90m', this.lang === 'zh' ? '压缩中，马上回来。' : 'Compacting, back in a moment.')); }
  showTodos(todos) {
    if (!todos?.length) return;
    this.print(this.color('\x1b[32m', 'Todos:'));
    for (const t of todos) this.print(`  ${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`);
  }

  toolCall(name, summary) {
    const card = createCard('tool', `⏺ ${name}${summary ? `(${truncateAnsi(String(summary), 60)})` : ''}`);
    const entry = { kind: 'card', card, _rendered: null };
    this.entries.push(entry);
    this._follow();
    this._activeCard = card;
    this._activeEntry = entry;
    this._syncSpinner();
    this._draw();
  }

  toolSuccess() {
    const c = this._activeCard;
    if (c) { c.status = 'done'; c.summaryLines = ['']; c.fullLines = []; this._invalidateEntry(this._activeEntry); }
    this._activeCard = null;
    this._activeEntry = null;
    this._syncSpinner();
    this._draw();
  }

  toolError(err) {
    const c = this._activeCard;
    if (c) {
      c.status = 'error';
      c.summaryLines = [String(err).slice(0, 120)];
      c.fullLines = [String(err)];
      this._invalidateEntry(this._activeEntry);
    }
    this._activeCard = null;
    this._activeEntry = null;
    this._syncSpinner();
    this._draw();
  }

  denied() { this.print(this.color('\x1b[90m', this.lang === 'zh' ? '行吧。（把爪子缩回来，但眼睛还盯着那面墙）' : 'Fine. (retracts paw)')); }
  planDenied(name) { this.print(this.color('\x1b[38;5;179m', this.lang === 'zh' ? `Plan 模式只看不拆。先 /act 再动手。（${name}）` : `Plan mode is look-only. /act first. (${name})`)); }

  bashResultCard({ model, command = '', exitCode = 0, file = null }) {
    const c = this._activeCard;
    const body = model.folded ? model.tailLines : model.headLines;
    const lines = body.map((l) => String(l));
    if (model.folded) {
      lines.push(`··· ${model.totalLines} lines total ···`);
      lines.push(this.lang === 'zh' ? '输出太长，我帮你叼回窝里了—— /output 翻出来。' : 'Output in the den — /output to dig it up.');
      if (file) lines.push(`full output: ${file}`);
    }
    if (c) {
      c.status = exitCode !== 0 ? 'error' : 'done';
      c.summaryLines = lines.slice(0, 3);
      c.fullLines = lines;
      this._invalidateEntry(this._activeEntry);
      this._syncSpinner();
      this._draw();
    } else {
      for (const l of lines) this.print(l);
    }
  }

  // --- approvals / questions -------------------------------------------------------

  // Inline approval card; y/n/a keys resolve it. The prospective diff from the
  // loop (preview/group) folds into the expandable body — same grouping rules
  // as the line-mode UI, rendered by diffcard.js.
  approve(toolName, summary, { dangerous = false, preview = null, group = null } = {}) {
    return new Promise((resolve) => {
      const card = createCard('approval', `${this.color('\x1b[33m', '批准请求')} ${toolName} ${truncateAnsi(String(summary || ''), 50)}`);
      card.status = 'done';
      const quip = (this.lang === 'zh' ? '我要跑这个了，盯着它看三秒。' : 'Running this. Stare for three seconds.') + (dangerous ? ' ⚠' : '');
      const previewLines = this._approvalPreviewLines(preview, group);
      card.summaryLines = [quip];
      card.fullLines = previewLines.length ? [quip, ...previewLines] : [summary || ''];
      const entry = { kind: 'card', card, _rendered: null };
      this.entries.push(entry);
      this._follow();
      this._pendingApproval = { card, entry, resolve };
      this._draw();
    });
  }

  _approvalPreviewLines(preview, group) {
    if (!preview) return [];
    const lines = [];
    const total = group?.total ?? 1;
    if (total > 1) lines.push(`  ┌─ change ${group.index}/${total}`);
    lines.push(...(total > 3 && group
      ? renderGroup(group.previews, { colors: this.colors })
      : renderFileCard(preview, { colors: this.colors })));
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

  _readLineRaw() {
    // the session dispatcher feeds the editor; resolves on submit (null on EOF)
    if (this._reading) return this._reading;
    this.editor.reset();
    this.multiline = false;
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
    this._keyBuf = (this._keyBuf || '') + String(chunk);
    // a lone ESC: give split sequences one tick to complete, then treat as Esc
    if (this._keyBuf === '\x1b') {
      clearImmediate(this._escTimer);
      this._escTimer = setImmediate(() => {
        if (this._keyBuf === '\x1b') { this._keyBuf = ''; this._handleKey('\x1b'); this._draw(); }
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
    // any text change re-opens an Esc-dismissed slash menu
    if (this.editor.rev !== this._lastRev) {
      this._menuDismissed = false;
      this._lastRev = this.editor.rev;
    }
    this._draw();
  }

  _handleKey(key) {
    // inline approvals get priority
    if (this._pendingApproval && !this.multiline) {
      const k = key.toLowerCase();
      const p = this._pendingApproval;
      if (k === 'y') { p.card.title += ' → y'; this._invalidateEntry(p.entry); this._pendingApproval = null; p.resolve('y'); return; }
      if (k === 'n' || key === '\r') { p.card.title += ' → n'; this._invalidateEntry(p.entry); this._pendingApproval = null; p.resolve('n'); return; }
      if (k === 'a') { p.card.title += ' → always'; this._invalidateEntry(p.entry); this._pendingApproval = null; p.resolve('always'); return; }
      // other keys fall through to global handling
    }
    switch (key) {
      case '\x1b[A': case '\x1b[B': case '\t': case '\x7f':   // history / completion / backspace
      case '\x1b[D': case '\x1b[C':                            // ← →
      case '\x1b[H': case '\x1b[F': case '\x1b[1~': case '\x1b[4~': // Home / End
      case '\x1b[3~':                                          // Delete
      case '\x17': case '\x15': case '\x0b':                   // ctrl+w / ctrl+u / ctrl+k
      case '\x01': case '\x05':                                // ctrl+a / ctrl+e (readline home/end)
        if (this._reading) this.editor.handle(key);
        break;
      case '\x1b[1;2A': this.scroll += 5; break;                // shift+up
      case '\x1b[1;2B': this.scroll = Math.max(0, this.scroll - 5); break;
      case '\x1b[5~': this.scroll += 20; break;                 // PgUp
      case '\x1b[6~': this.scroll = Math.max(0, this.scroll - 20); break; // PgDn
      case '\x1b[Z': this.onShiftTab?.(); break;                // shift+tab
      case '\x0f': case '\x1b[15;5~': case '\x1bOj':            // ctrl+o: toggle latest card
        for (let i = this.entries.length - 1; i >= 0; i--) {
          const e = this.entries[i];
          if (e.kind === 'card') { e.card.expanded = !e.card.expanded; this._invalidateEntry(e); break; }
        }
        break;
      case '\x0a': // Ctrl+J: enter multiline, then insert newlines
        if (!this.multiline) this.multiline = true;
        else this.editor.insert('\n');
        break;
      case '\x1b': // Esc: cancel tab completion, dismiss the slash menu, else interrupt, else clear
        if (this.editor.tabBase !== null) this.editor.cancelCompletion();
        else if (this._slashCandidates().length) this._menuDismissed = true;
        else if (this.onInterrupt) { this.onInterrupt(); }
        else this.editor.reset();
        break;
      case '\r':
        if (this._reading) {
          const line = this.editor.text;
          if (line.trim() && !this.multiline) this.editor.history.push(line);
          this.multiline = false;
          this._finishRead(line);
        }
        break;
      default:
        if (key >= ' ' && this._reading) this.editor.handle(this._secret ? key : key);
        break;
    }
  }

  // --- rendering ------------------------------------------------------------------

  _follow() {
    // auto-scroll only when the user is already at the bottom
    const { height } = this._size();
    const transH = Math.max(1, height - this._header().length - this._inputBox().length - 1);
    const maxScroll = Math.max(0, this._flat().length - transH);
    if (this.scroll >= maxScroll - 2) this.scroll = maxScroll;
  }

  _size() {
    const width = this.output.columns || 80;
    const height = Math.max(10, (this.output.rows || 24) - 1);
    return { width, height };
  }

  _header() {
    const cfg = this._meta.getConfig();
    const analysis = analyzeContext(this._meta.getMessages(), cfg.maxContextTokens || 100000, {});
    return renderHeader({
      pct: analysis.pct,
      model: this._meta.getModel(),
      mode: this._meta.getMode(),
      width: this._size().width,
      theme: this.theme,
    });
  }

  // Auto slash menu: while the draft is a bare command word ("/th", no args)
  // and no Tab cycle is active, offer the completions that extend it. Esc
  // dismisses until the text changes (see _onKeys).
  _slashCandidates() {
    const ed = this.editor;
    if (ed.tabBase !== null || this._menuDismissed === true) return [];
    if (!this.completions || !/^\/[^\s]*$/.test(ed.text)) return [];
    return this.completions(ed.text).filter((c) => c.startsWith(ed.text) && c !== ed.text).sort();
  }

  _inputBox() {
    const w = this._size().width;
    const placeholder = this._promptText || (this.lang === 'zh'
      ? '输入消息，/ 命令，@ 文件'
      : 'Type a message, / for commands, @ for files');
    const { cursorCol } = this.editor.render(w);
    const box = buildInputBox({
      text: this.editor.text, width: w, theme: this.theme, placeholder,
      multiline: this.multiline, cursor: cursorCol,
    });
    const lines = ['', ...box, ''];
    const ed = this.editor;
    if (ed.tabBase !== null && ed.tabCandidates.length) {
      // completion candidate row: current pick highlighted, rest dim, n/m counter
      const idx = ed.tabIdx;
      const shown = ed.tabCandidates.map((c, i) => (i === idx ? this.color(this.theme.brand, c) : this.color('\x1b[90m', c)));
      let row = ' ' + shown.join(this.color('\x1b[90m', '  '));
      if (idx < ed.tabCandidates.length) row += this.color('\x1b[90m', `  ${idx + 1}/${ed.tabCandidates.length}`);
      lines.push(truncateAnsi(row, w));
    } else {
      // auto slash menu: same row, no highlight, no counter
      const cands = this._slashCandidates();
      if (cands.length) {
        const row = ' ' + cands.map((c) => this.color('\x1b[90m', c)).join(this.color('\x1b[90m', '  '));
        lines.push(truncateAnsi(row, w));
      }
    }
    if (this.multiline) lines.push(` ${this.color('\x1b[90m', this.lang === 'zh' ? '[多行模式 Ctrl+J 退出]' : '[multiline Ctrl+J to exit]')}`);
    return lines;
  }

  _status() {
    const m = this._meta;
    const hint = this._pendingApproval
      ? ''
      : this.lang === 'zh' ? '? 快捷键 · shift+tab 切换模式' : '? for shortcuts · shift+tab to switch mode';
    return renderStatus({
      cost: m.getCost(), version: m.version, cwd: m.cwd, mode: m.getMode(), hint,
    }, this._size().width, this.theme);
  }

  _invalidateEntry(entry) {
    if (entry) entry._rendered = null;
  }

  _newAssistantEntry(width) {
    return {
      kind: 'assistant', raw: '', closedRows: [], tailRows: [], done: false,
      rendererWidth: width,
      renderer: createMarkdownRenderer({
        theme: this.theme, width,
        highlight: (code, lang) => highlightCode(code, lang, this.theme),
        osc8: this._osc8,
      }),
      _rendered: null,
    };
  }

  // Rebuild an assistant entry's renderer (theme swap or width change) by
  // replaying the raw stream into a fresh renderer.
  _replayAssistant(entry, width) {
    entry.renderer = createMarkdownRenderer({
      theme: this.theme, width,
      highlight: (code, lang) => highlightCode(code, lang, this.theme),
      osc8: this._osc8,
    });
    entry.rendererWidth = width;
    const rows = entry.renderer.push(entry.raw);
    entry.closedRows = rows.slice(0, rows.splitIndex);
    entry.tailRows = rows.slice(rows.splitIndex);
    entry._rendered = null;
  }

  // Per-entry render cache: same entry + same width returns the same lines
  // array; mutating callers null `_rendered` to force a recompute.
  _materialize(entry, width) {
    if (entry._rendered && entry._rendered.width === width) return entry._rendered.lines;
    let lines;
    if (entry.kind === 'card') {
      lines = entry.card.kind === 'approval'
        ? renderApprovalCard(entry.card, { width, colors: this.colors, theme: this.theme })
        : renderCard(entry.card, { width, spinFrame: this.spinFrame, colors: this.colors, theme: this.theme });
    } else if (entry.kind === 'user') {
      lines = renderUserBubble(entry.text, width, this.theme, this.colors);
    } else if (entry.kind === 'assistant') {
      if (entry.rendererWidth !== width) this._replayAssistant(entry, width);
      lines = [...entry.closedRows, ...entry.tailRows].map((r) => r.text);
    } else {
      lines = [];
      for (const l of entry.lines) lines.push(...wrapText(l, width));
    }
    entry._rendered = { width, lines };
    return lines;
  }

  _flat() {
    const { width } = this._size();
    const lines = [];
    for (const e of this.entries) lines.push(...this._materialize(e, width));
    return lines;
  }

  _draw() {
    if (!this.screen.active) return;
    const { width, height } = this._size();
    const input = this._inputBox();
    const screen = buildScreen({
      header: this._header(),
      transcript: this._flat(),
      input,
      status: this._status(),
      width, height,
      scroll: this.scroll,
    });
    // While editing, place the hardware cursor at the editor's caret inside
    // the input box; otherwise leave it hidden (streaming output needs none).
    let cursor = null;
    if (this._reading) {
      const { cursorRow, cursorCol } = this.editor.render(width);
      const bodyW = width - 4; // '│ ' + body + ' │'
      // buildInputBox left-scrolls the last row when the caret overflows it
      const visibleCursorCol = cursorCol - Math.max(0, cursorCol - bodyW + 1);
      const inputStart = height - input.length - 1;
      cursor = { row: inputStart + 2 + cursorRow, col: 2 + visibleCursorCol };
    }
    this.screen.draw(screen, cursor);
  }

  _tick() {
    this.spinFrame++;
    for (const e of this.entries) {
      if (e.kind === 'card' && e.card.status === 'running') e._rendered = null;
    }
    this._draw();
    this._syncSpinner();
  }

  // The 150ms spinner interval only runs while a card is in running state;
  // with no running card there is nothing animated, so no periodic redraw.
  _syncSpinner() {
    const want = this.screen.active && this.entries.some((e) => e.kind === 'card' && e.card.status === 'running');
    if (want && !this._timer) {
      this._timer = setInterval(() => this._tick(), SPINNER_MS);
      if (this._timer.unref) this._timer.unref();
    } else if (!want && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // hooks the loop/bin sometimes touch
  // Swap the palette (dark/light): re-parse tokens, mark every cached entry
  // dirty so the next draw re-renders the whole transcript in the new theme.
  setTheme(name) {
    if (name !== 'dark' && name !== 'light') return false;
    this.theme = getTheme(name, this._colorLevel);
    this.themeName = name;
    for (const e of this.entries) {
      e._rendered = null;
      if (e.kind === 'assistant') this._replayAssistant(e, e.rendererWidth);
    }
    this._draw();
    return true;
  }
}
