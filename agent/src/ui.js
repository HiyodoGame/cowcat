// Minimal terminal UI: streaming output, tool-call display, approval prompts, slash commands.
// User-facing copy keeps a light CowCat voice: quips wrap, never replace, real output.
import { isDangerousCommand } from './permissions.js';
import { renderGroup, renderFileCard } from './diffcard.js';
import { renderBashCard } from './outputcard.js';
import { THEMES } from './slashcmds.js';
import { LineEditor } from './lineeditor.js';
import { getTheme } from './tui/theme.js';

// Shared palette derived from the semantic theme tokens; setTheme() re-parses
// in place so every card/status line follows without re-rendering.
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  ...getTheme('dark', '256'),
};

// Voice: terse, high-energy. Errors are always printed verbatim alongside the quip.
export const COPY = {
  zh: {
    approveQuip: '我要跑这个了，盯着它看三秒。',
    approvePrompt: '——允许？[y/n/always]',
    dangerousWarn: '⚠ 这条命令有风险，确认过再跑。',
    denied: '行吧，这条不干。',
    success: '搞定，任务完成。',
    failure: '刚才那步失败了，我重试一次。',
    compacting: '压缩中，马上回来。',
    waiting: '盯着编译器出神中',
    planDenied: 'Plan 模式只读。先 /act 再动手。',
    planBashDenied: 'Plan 模式下这条命令不许跑（只读命令可以）。先 /act。',
    outputTooLong: '输出太长已截断——用 /output 查看完整内容。',
    noDiff: '这回合没有改动，没有 diff。',
    noOutput: '最近没有终端输出。',
  },
  en: {
    approveQuip: "Running this. Stare at it for three seconds.",
    approvePrompt: '-- allow? [y/n/always]',
    dangerousWarn: '⚠ this command looks risky, confirm before running.',
    denied: 'Fine, skipping this one.',
    success: 'Done.',
    failure: 'That step failed — retrying once.',
    compacting: 'Compacting, back in a moment.',
    waiting: 'staring blankly at the compiler',
    planDenied: 'Plan mode is read-only. Switch with /act first.',
    planBashDenied: 'That command is not allowed in plan mode (read-only only). /act first.',
    outputTooLong: 'Output too long, truncated — use /output to see it all.',
    noDiff: 'Nothing changed this turn — no diff yet.',
    noOutput: 'No terminal output yet.',
  },
};

// brand accents mapped onto semantic tokens: act -> permission, plan -> warning, alert -> error
export const BRAND = { act: C.permission, plan: C.warning, alert: C.error };
// First-message language sniff: CJK chars -> zh, otherwise en.
export function detectLang(text) {
  return /[\u4e00-\u9fff]/.test(text || '') ? 'zh' : 'en';
}

export class UI {
  constructor({ input = process.stdin, output = process.stdout, colors = null, lang = 'zh', interactive = true } = {}) {
    this.input = input;
    this.output = output;
    this.colors = colors ?? (!process.env.NO_COLOR && output.isTTY !== false);
    this.lang = lang;
    this.t = COPY[lang] || COPY.zh;
    // Non-interactive mode (e.g. --print) never waits on stdin: approvals are
    // auto-denied so the caller can fall back to read-only work.
    this.interactive = interactive;
    this._lineBuf = '';
    this._lineWaiters = [];
    this._lineListening = false;
    this._eof = false;
    this._onData = null;
    this._onEnd = null;
    this.editor = null;          // lazy LineEditor for interactive TTY input
    this.completions = null;     // () => string[] of "/name" for Tab
    this.fileCompletions = null; // (prefix) => string[] of "@path" for @-mention Tab
    this.onShiftTab = null;      // mode-switch hook
    this._promptText = '';
  }

  // Print a prompt and read one line; on TTY the LineEditor provides history
  // recall, slash-command completion, and shift-tab mode switching.
  ask(promptText) {
    this._promptText = promptText;
    this.output.write(promptText);
    return this.readLine();
  }

  // Swap the ANSI palette (dark/light). Mutates the shared palette objects so
  // every card/status line follows immediately.
  setTheme(name) {
    if (!THEMES[name]) return false;
    Object.assign(C, getTheme(name, '256'));
    Object.assign(BRAND, { act: C.permission, plan: C.warning, alert: C.error });
    this.themeName = name;
    return true;
  }

  setLang(lang) { this.lang = lang; this.t = COPY[lang] || COPY.zh; }

  color(code, s) { return this.colors ? `${code}${s}${C.reset}` : s; }

  print(s = '') { this.output.write(`${s}\n`); }
  streamChunk(s) { this.output.write(s); }
  endStream() { this.output.write('\n'); }

  waitingModel() { this.print(this.color(C.inactive, this.t.waiting)); }

  compacting() { this.print(this.color(C.inactive, this.t.compacting)); }

  toolCall(name, summary) {
    this.print(this.color(C.permission, `  ⏺ Tool ▸ ${this.color(C.bold, name)}${summary ? `(${this.truncate(summary)})` : ''}`));
  }

  toolSuccess() {
    this.print(this.color(C.success, `  ${this.t.success}`));
  }

  toolError(err) {
    // quip first, then the real error — never swallow diagnostics
    this.print(this.color(C.warning, `  ${this.t.failure}`));
    this.print(this.color(C.error, `  ✗ ${this.truncate(String(err), 300)}`));
  }

  denied() {
    this.print(this.color(C.inactive, `  ${this.t.denied}`));
  }

  truncate(s, n = 120) {
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  // Ask y/n/always. Returns 'y' | 'n' | 'always'.
  // Approval as a compact action card (§5.2): with a prospective diff for
  // Edit/Write (grouped; >3 files collapses to a list), danger highlight,
  // then the quip and the y/n/always options.
  async approve(toolName, summary, { dangerous = false, preview = null, group = null } = {}) {
    if (!this.interactive) {
      this.print(this.color(C.inactive, `  ⊘ non-interactive: ${toolName} auto-denied (rerun with -y to auto-approve)`));
      return 'n';
    }
    if (dangerous) this.print(this.color(C.error, `  ${this.t.dangerousWarn}`));
    if (preview) {
      const idx = group?.index ?? 1;
      const total = group?.total ?? 1;
      if (total > 1) this.print(`  ┌─ change ${idx}/${total}`);
      const lines = group && group.total > 3
        ? renderGroup(group.previews, { colors: this.colors })
        : renderFileCard(preview, { colors: this.colors });
      for (const l of lines) this.print(l);
    } else {
      const width = 46;
      const title = ` ${toolName} `;
      const cmd = this.truncate(summary || '', width - 8);
      const cmdLine = dangerous ? this.color(BRAND.alert, `  │ ${cmd}`) : `  │ ${cmd}`;
      this.print(`  ┌─${title}${'─'.repeat(Math.max(width - title.length - 4, 0))}┐`);
      this.print(`${cmdLine}${' '.repeat(Math.max(width - 4 - this.visibleLen(cmd), 0))}│`);
      this.print(`  │ ${this.t.approveQuip}`);
      this.print(`  └${'─'.repeat(width - 2)}┘`);
    }
    this.output.write(`  ${this.color(C.bold, this.t.approvePrompt)} `);
    const ans = ((await this.readLine()) ?? '').trim().toLowerCase();
    if (ans === 'always') return 'always';
    return ans === 'y' || ans === 'yes' ? 'y' : 'n';
  }

  // Bash result card (§5.2 终端输出): folded by default, full via /output.
  bashResultCard({ model, command = '', exitCode = 0, file = null }) {
    if (!model.folded) {
      for (const l of model.headLines) this.print(l);
      return;
    }
    const lines = renderBashCard(model, {
      colors: this.colors, command: this.truncate(command, 24), exitCode, file,
      tooLongLine: this.t.outputTooLong,
    });
    for (const l of lines) this.print(l);
  }

  planDenied(toolName) {
    const msg = toolName === 'Bash' ? this.t.planBashDenied : this.t.planDenied;
    this.print(this.color(BRAND.plan, `  ${msg}`));
  }

  visibleLen(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, '').length; }

  // Persistent line buffering: a single chunk may contain several lines
  // (piped input), and leftover bytes after a newline must survive to the
  // next readLine() call instead of being dropped with the chunk.
  // Returns null on EOF so callers (the REPL) can shut down cleanly.
  readLine() {
    this._ensureLineListener();
    const idx = this._lineBuf.search(/[\r\n]/);
    if (idx >= 0) return Promise.resolve(this._shiftLine());
    if (this._eof) return Promise.resolve(null);
    return new Promise((resolve) => this._lineWaiters.push(resolve));
  }

  // Secret input (API keys): no echo on TTY; plain line on non-TTY.
  async readSecret() {
    if (!this.interactive || !this.input.isTTY) return ((await this.readLine()) ?? '').trim();
    this._suppressEcho = true;
    try {
      return ((await this.readLine()) ?? '').trim();
    } finally {
      this._suppressEcho = false;
      this._lineBuf = ''; // never let secret bytes leak into the next prompt
      this.output.write('\n');
    }
  }

  // Tear down stdin listeners so the process can exit cleanly (readLine keeps
  // stdin in flowing mode, which would otherwise hold the event loop open).
  close() {
    if (this._onData) this.input.off?.('data', this._onData);
    if (this._onEnd) this.input.off?.('end', this._onEnd);
    this._lineListening = false;
    this._onData = null;
    this._onEnd = null;
    this._lineWaiters = [];
    if (this.input === process.stdin) this.input.pause();
  }

  _ensureLineListener() {
    if (this._lineListening) return;
    this._lineListening = true;
    if (this.input === process.stdin) this.input.setRawMode?.(false);
    this._onData = (chunk) => {
      const s = chunk.toString();
      if (this.input.isTTY && !this._suppressEcho) this.output.write(s); // echo interactive input only
      this._lineBuf += s;
      while (this._lineBuf.search(/[\r\n]/) >= 0 && this._lineWaiters.length) {
        this._lineWaiters.shift()(this._shiftLine());
      }
    };
    this._onEnd = () => {
      this._eof = true;
      const w = this._lineWaiters.shift();
      if (w) w(null);
    };
    this.input.on('data', this._onData);
    this.input.once?.('end', this._onEnd);
  }

  _shiftLine() {
    const idx = this._lineBuf.search(/[\r\n]/);
    const line = this._lineBuf.slice(0, idx);
    let rest = this._lineBuf.slice(idx + 1);
    if (this._lineBuf[idx] === '\r' && rest[0] === '\n') rest = rest.slice(1); // CRLF
    this._lineBuf = rest;
    return line;
  }

  // AskUserQuestion tool: render questions, read numeric answers.
  async askQuestions(questions) {
    if (!this.interactive) return {}; // never block a non-interactive run on stdin
    const answers = {};
    for (const q of questions) {
      this.print(this.color(C.bold, `\n${q.question}`));
      q.options.forEach((o, i) => {
        this.print(`  ${i + 1}. ${this.color(C.bold, o.label)}${o.description ? this.color(C.inactive, ` — ${o.description}`) : ''}`);
      });
      this.output.write(`Choose${q.multiSelect ? ' (comma-separated)' : ''} [1-${q.options.length}]: `);
      const ans = ((await this.readLine()) ?? '').trim();
      const idxs = ans.split(',').map((x) => parseInt(x.trim(), 10) - 1).filter((i) => i >= 0 && i < q.options.length);
      const labels = idxs.map((i) => q.options[i].label);
      answers[q.question] = q.multiSelect ? labels.join(', ') : (labels[0] ?? ans);
    }
    this.print('');
    return answers;
  }

  showTodos(todos) {
    if (!todos?.length) return;
    this.print(this.color(C.success, '  Todos:'));
    for (const t of todos) this.print(`    ${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.content}`);
  }
}

// Silent UI for tests / non-interactive runs. Feeds scripted answers.
export class MockUI {
  constructor({ answers = [], colors = false, interactive = true } = {}) {
    this.answers = [...answers]; // consumed in order by approve()/askQuestions()
    this.interactive = interactive;
    this.approvals = [];
    this.autoDenials = 0;
    this.questionsAsked = [];
    this.streamed = '';
    this.calls = [];
    this.printed = [];
    this.lang = 'zh';
    this.t = COPY.zh;
  }
  setLang(lang) { this.lang = lang; this.t = COPY[lang] || COPY.zh; }
  print(s = '') { this.printed.push(s); }
  endStream() {}
  streamChunk(s) { this.streamed += s; }
  toolCall(name, summary) { this.calls.push({ name, summary }); }
  toolSuccess() {}
  toolError() {}
  denied() {}
  planDenied(toolName) { this.planDenials = (this.planDenials || []).concat(toolName); }
  waitingModel() {}
  compacting() {}
  showTodos() {}
  async approve(toolName, summary, opts = {}) {
    if (!this.interactive) {
      this.autoDenials++;
      this.approvals.push({ toolName, summary, autoDenied: true });
      return 'n';
    }
    this.approvals.push({
      toolName, summary,
      dangerous: !!opts.dangerous,
      hasPreview: !!opts.preview,
      preview: opts.preview,
      groupTotal: opts.group?.total ?? 1,
    });
    const next = this.answers.length ? this.answers.shift() : 'y';
    return next;
  }
  bashResultCard(card) { this.bashCards = (this.bashCards || []).concat(card); }
  close() {}
  async readSecret() { return this.answers.length ? this.answers.shift() : ''; }
  async askQuestions(questions) {
    this.questionsAsked.push(questions);
    if (!this.interactive) return {};
    const answers = {};
    for (const q of questions) answers[q.question] = this.answers.length ? this.answers.shift() : q.options[0].label;
    return answers;
  }
}

export { C as ANSI, isDangerousCommand };
