// TuiUI: full-screen duck-typed replacement for the line-mode UI. Implements
// the exact interface bin/cowcat.mjs consumes (print/streamChunk/toolCall/
// approve/askQuestions/readLine/...) so the REPL and loop need no changes.
// Degrades out of the picture entirely unless the caller opts in.
import { Screen } from './screen.js';
import {
  renderHeader, renderStatus, renderCard, createCard, buildScreen,
  wrapText, truncateAnsi, visibleLen, SPINNER,
} from './render.js';
import { LineEditor } from '../lineeditor.js';
import { analyzeContext } from '../contextviz.js';

const DRAW_MS = 100;

export class TuiUI {
  constructor({
    input = process.stdin, output = process.stdout, colors = true, lang = 'zh',
    version = '0.8.0', cwd = process.cwd(),
    getModel = () => '', getMode = () => 'default', getCost = () => '', getConfig = () => ({}), getMessages = () => [],
  } = {}) {
    this.input = input;
    this.output = output;
    this.colors = colors;
    this.lang = lang;
    this.t = { noDiff: '这回合还没有 diff。' };
    this.interactive = true;
    this.screen = new Screen({ input, output });
    this.entries = [];          // {kind:'text',lines} | {kind:'card',card} | {kind:'stream',lines}
    this.scroll = 0;
    this.spinFrame = 0;
    this.editor = new LineEditor({});
    this.completions = null;
    this.fileCompletions = null;
    this.onShiftTab = null;
    this.onInterrupt = null;
    this.multiline = false;
    this._reading = null;
    this._promptText = '';
    this._pendingApproval = null;
    this._meta = { version, cwd, getModel, getMode, getCost, getConfig, getMessages };
    this._timer = setInterval(() => this._tick(), DRAW_MS);
    if (this._timer.unref) this._timer.unref();
  }

  // --- lifecycle ---------------------------------------------------------------

  start() {
    this.screen.enter();
    this.input.setRawMode?.(true);
    this._dispatch = (chunk) => this._onKeys(chunk);
    this.input.on('data', this._dispatch);
    this._draw();
  }

  close() {
    clearInterval(this._timer);
    if (this._dispatch) this.input.off?.('data', this._dispatch);
    this.input.setRawMode?.(false);
    this.screen.leave();
  }

  attachAnimator() {}
  setLang(lang) { this.lang = lang; }

  color(code, s) { return this.colors ? `${code}${s}\x1b[0m` : s; }

  // --- transcript API (same shapes as the line-mode UI) --------------------------

  print(s = '') {
    const lines = String(s).split('\n');
    this.entries.push({ kind: 'text', lines });
    this._follow();
  }

  streamChunk(s) {
    let e = this.entries[this.entries.length - 1];
    if (!e || e.kind !== 'stream') {
      e = { kind: 'stream', lines: [''] };
      this.entries.push(e);
    }
    const parts = String(s).split('\n');
    e.lines[e.lines.length - 1] += parts[0];
    for (let i = 1; i < parts.length; i++) e.lines.push(parts[i]);
    this._follow();
  }

  endStream() { /* stream entry stays as-is */ }

  waitingModel() {}
  compacting() { this.print(this.color('\x1b[90m', this.lang === 'zh' ? '压缩中，马上回来。' : 'Compacting, back in a moment.')); }
  showTodos(todos) {
    if (!todos?.length) return;
    this.print(this.color('\x1b[32m', 'Todos:'));
    for (const t of todos) this.print(`  ${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`);
  }

  toolCall(name, summary) {
    const card = createCard('tool', `⏺ ${name}${summary ? `(${truncateAnsi(String(summary), 60)})` : ''}`);
    this.entries.push({ kind: 'card', card });
    this._follow();
    this._activeCard = card;
  }

  toolSuccess() {
    const c = this._activeCard;
    if (c) { c.status = 'done'; c.summaryLines = ['']; c.fullLines = []; }
    this._activeCard = null;
  }

  toolError(err) {
    const c = this._activeCard;
    if (c) {
      c.status = 'error';
      c.summaryLines = [String(err).slice(0, 120)];
      c.fullLines = [String(err)];
    }
    this._activeCard = null;
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
    } else {
      for (const l of lines) this.print(l);
    }
  }

  // --- approvals / questions -------------------------------------------------------

  // Inline approval card; y/n/a keys resolve it.
  approve(toolName, summary, { dangerous = false } = {}) {
    return new Promise((resolve) => {
      const card = createCard('approval', `${this.color('\x1b[33m', '批准请求')} ${toolName} ${truncateAnsi(String(summary || ''), 50)}`);
      card.status = 'done';
      card.summaryLines = [(this.lang === 'zh' ? '我要跑这个了，盯着它看三秒。' : 'Running this. Stare for three seconds.') + (dangerous ? ' ⚠' : '')];
      card.fullLines = [summary || ''];
      this.entries.push({ kind: 'card', card });
      this._follow();
      this._pendingApproval = { card, resolve };
      this._draw();
    });
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
    this.output.write('\n');
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
    this._draw();
  }

  _handleKey(key) {
    // inline approvals get priority
    if (this._pendingApproval && !this.multiline) {
      const k = key.toLowerCase();
      const p = this._pendingApproval;
      if (k === 'y') { p.card.title += ' → y'; this._pendingApproval = null; p.resolve('y'); return; }
      if (k === 'n' || key === '\r') { p.card.title += ' → n'; this._pendingApproval = null; p.resolve('n'); return; }
      if (k === 'a') { p.card.title += ' → always'; this._pendingApproval = null; p.resolve('always'); return; }
      // other keys fall through to global handling
    }
    switch (key) {
      case '\x1b[A': case '\x1b[B': case '\t': case '\x7f':
        if (this._reading) this.editor.handle(key);
        break;
      case '\x1b[1;2A': this.scroll += 5; break;                // shift+up
      case '\x1b[1;2B': this.scroll = Math.max(0, this.scroll - 5); break;
      case '\x1b[5~': this.scroll += 20; break;                 // PgUp
      case '\x1b[6~': this.scroll = Math.max(0, this.scroll - 20); break; // PgDn
      case '\x1b[Z': this.onShiftTab?.(); break;                // shift+tab
      case '\x0a': // Ctrl+J: enter multiline, then insert newlines
        if (!this.multiline) this.multiline = true;
        else this.editor.text += '\n';
        break;
      case '\x1b': // Esc: interrupt the current task, else clear the line
        if (this.onInterrupt) { this.onInterrupt(); }
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
    });
  }

  _inputBox() {
    const textLines = this.editor.text.split('\n');
    const box = [];
    const w = this._size().width;
    const prompt = this._promptText || (this.lang === 'zh' ? 'cowcat> ' : 'cowcat> ');
    textLines.forEach((l, i) => {
      const content = i === 0 ? `${prompt}${l}` : `  ${l}`;
      box.push(` ${truncateAnsi(content, w - 2)}`);
    });
    box.push(` ${this.color('\x1b[90m', '─'.repeat(Math.max(1, w - 2)))}`);
    if (this.multiline) box.push(` ${this.color('\x1b[90m', this.lang === 'zh' ? '[多行模式 Ctrl+J 退出]' : '[multiline Ctrl+J to exit]')}`);
    return box;
  }

  _status() {
    const m = this._meta;
    return renderStatus({
      cost: m.getCost(), version: m.version, cwd: m.cwd, mode: m.getMode(),
    }, this._size().width);
  }

  _flat() {
    const { width } = this._size();
    const lines = [];
    for (const e of this.entries) {
      if (e.kind === 'card') {
        lines.push(...renderCard(e.card, { width, spinFrame: this.spinFrame, colors: this.colors }));
      } else {
        for (const l of e.lines) lines.push(...wrapText(l, width));
      }
    }
    return lines;
  }

  _draw() {
    if (!this.screen.active) return;
    const { width, height } = this._size();
    const screen = buildScreen({
      header: this._header(),
      transcript: this._flat(),
      input: this._inputBox(),
      status: this._status(),
      width, height,
      scroll: this.scroll,
    });
    this.screen.draw(screen);
  }

  _tick() {
    this.spinFrame++;
    this._draw();
  }

  // hooks the loop/bin sometimes touch
  setTheme() {}
}
