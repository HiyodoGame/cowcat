// Interactive line editor for the REPL (P1-9): history recall (↑/↓), slash
// command completion (Tab cycles), shift-tab mode switch signal; cursor model
// (W3): left/right/home/end, backspace/delete, Ctrl+W/U/K kill keys. Pure logic
// — the UI feeds raw chunks in and redraws from `text`/`render()`. Non-TTY
// callers use the buffered path and get none of this.
export class LineEditor {
  constructor({ completions = null, fileCompletions = null } = {}) {
    this.completions = completions; // () => string[] of "/name" entries
    this.fileCompletions = fileCompletions; // (prefix) => string[] of "@path" entries
    this.history = [];
    this.reset();
  }

  reset() {
    this.text = '';
    this.cursor = 0;        // code-unit offset into text
    this.hIdx = null;      // index into history while browsing
    this.stash = '';       // in-progress line saved while browsing history
    this.tabBase = null;   // line before tab cycling
    this.tabIdx = -1;
    this.tabCandidates = []; // candidates of the active tab cycle (for display)
  }

  cancelCompletion() {
    this.tabBase = null;
    this.tabIdx = -1;
    this.tabCandidates = [];
  }

  _browsing() { return this.hIdx !== null; }

  _setText(s) { this.text = s; this.cursor = s.length; }

  _historyPrev() {
    if (!this.history.length) return;
    if (this.hIdx === null) {
      this.stash = this.text;
      this.hIdx = this.history.length - 1;
    } else if (this.hIdx > 0) {
      this.hIdx--;
    }
    this._setText(this.history[this.hIdx]);
  }

  _historyNext() {
    if (this.hIdx === null) return;
    if (this.hIdx < this.history.length - 1) {
      this.hIdx++;
      this._setText(this.history[this.hIdx]);
    } else {
      this.hIdx = null;
      this._setText(this.stash);
    }
  }

  _tab() {
    // @-mention file completion takes precedence: @<prefix> + Tab
    const at = this.text.match(/@([\w./-]*)$/);
    if (at) {
      this.tabCandidates = [];
      if (!this.fileCompletions) return;
      if (this.tabBase === null) this.tabBase = this.text;
      const m = this.tabBase.match(/@([\w./-]*)$/);
      if (!m) return;
      const candidates = this.fileCompletions(m[1]).slice(0, 20);
      if (!candidates.length) return;
      this.tabCandidates = candidates;
      this.tabIdx = (this.tabIdx + 1) % (candidates.length + 1); // last slot restores the raw prefix
      const pre = this.tabBase.slice(0, this.tabBase.length - m[0].length);
      this._setText(this.tabIdx === candidates.length ? this.tabBase : pre + candidates[this.tabIdx]);
      return;
    }
    if (!this.text.startsWith('/')) {
      this.insert('  '); // shell-style: two spaces off-command
      return;
    }
    if (this.tabBase === null) this.tabBase = this.text;
    // candidates always filtered from the pre-tab prefix so cycling works
    const candidates = (this.completions ? this.completions() : [])
      .filter((c) => c.startsWith(this.tabBase) && c !== this.tabBase)
      .sort();
    this.tabCandidates = candidates;
    if (!candidates.length) return;
    this.tabIdx = (this.tabIdx + 1) % (candidates.length + 1);
    this._setText(this.tabIdx === candidates.length ? this.tabBase : candidates[this.tabIdx]);
  }

  // --- cursor model (W3) -------------------------------------------------------

  insert(ch) {
    const s = String(ch);
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
    this.tabBase = null; // typing invalidates tab cycling
    this.tabCandidates = [];
  }

  moveLeft() { if (this.cursor > 0) this.cursor--; }

  moveRight() { if (this.cursor < this.text.length) this.cursor++; }

  home() { this.cursor = this.text.lastIndexOf('\n', this.cursor - 1) + 1; }

  end() {
    const i = this.text.indexOf('\n', this.cursor);
    this.cursor = i === -1 ? this.text.length : i;
  }

  deleteBack() {
    if (this.cursor === 0) return;
    this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
    this.cursor--;
  }

  deleteForward() {
    if (this.cursor >= this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
  }

  // Delete the word right before the cursor, bounded by non-word characters;
  // when the cursor sits on a non-word run, that run is removed instead.
  killWordBack() {
    const isWord = (c) => c !== undefined && /[\w]/.test(c);
    let i = this.cursor;
    if (isWord(this.text[i - 1])) { while (i > 0 && isWord(this.text[i - 1])) i--; }
    else { while (i > 0 && !isWord(this.text[i - 1])) i--; }
    this.text = this.text.slice(0, i) + this.text.slice(this.cursor);
    this.cursor = i;
  }

  killToStart() {
    const i = this.text.lastIndexOf('\n', this.cursor - 1) + 1;
    this.text = this.text.slice(0, i) + this.text.slice(this.cursor);
    this.cursor = i;
  }

  killToEnd() {
    const i = this.text.indexOf('\n', this.cursor);
    this.text = this.text.slice(0, this.cursor) + this.text.slice(i === -1 ? this.text.length : i);
  }

  // Display mapping: split lines plus the cursor position in row/col terms.
  render(width) {
    const lines = this.text.split('\n');
    const before = this.text.slice(0, this.cursor);
    return {
      lines,
      cursorRow: lines.length - this.text.slice(this.cursor).split('\n').length,
      cursorCol: before.length - (before.lastIndexOf('\n') + 1),
    };
  }

  // Feed one chunk (may contain several key sequences). Returns events:
  // [{type:'redraw'}...] plus at most one {type:'submit', line} or {type:'shift-tab'}.
  handle(chunk) {
    const events = [];
    let i = 0;
    const s = String(chunk);
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\r' || ch === '\n') {
        const line = this.text;
        if (line.trim()) { this.history.push(line); if (this.history.length > 500) this.history.shift(); }
        this.reset();
        events.push({ type: 'submit', line });
        i++;
        continue;
      }
      if (ch === '\x1b' && s[i + 1] === '[') {
        const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z~]/);
        if (!m) { i++; continue; }
        const seq = m[0];
        if (seq === '\x1b[A') { this._historyPrev(); events.push({ type: 'redraw' }); }
        else if (seq === '\x1b[B') { this._historyNext(); events.push({ type: 'redraw' }); }
        else if (seq === '\x1b[C') { this.moveRight(); events.push({ type: 'redraw' }); }
        else if (seq === '\x1b[D') { this.moveLeft(); events.push({ type: 'redraw' }); }
        else if (seq === '\x1b[H' || seq === '\x1b[1~') { this.home(); events.push({ type: 'redraw' }); }
        else if (seq === '\x1b[F' || seq === '\x1b[4~') { this.end(); events.push({ type: 'redraw' }); }
        else if (seq === '\x1b[3~') { this.deleteForward(); events.push({ type: 'redraw' }); }
        else if (seq === '\x1b[Z') { events.push({ type: 'shift-tab' }); }
        // ignore other escape sequences
        i += seq.length;
        continue;
      }
      if (ch === '\t') { this._tab(); events.push({ type: 'redraw' }); i++; continue; }
      if (ch === '\x7f' || ch === '\b') { this.deleteBack(); events.push({ type: 'redraw' }); i++; continue; }
      if (ch === '\x17') { this.killWordBack(); events.push({ type: 'redraw' }); i++; continue; }
      if (ch === '\x15') { this.killToStart(); events.push({ type: 'redraw' }); i++; continue; }
      if (ch === '\x0b') { this.killToEnd(); events.push({ type: 'redraw' }); i++; continue; }
      if (ch >= ' ') {
        this.insert(ch);
        events.push({ type: 'redraw' });
      }
      i++;
    }
    return events;
  }
}
