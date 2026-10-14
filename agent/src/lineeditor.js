// Interactive line editor for the REPL (P1-9): history recall (↑/↓), slash
// command completion (Tab cycles), shift-tab mode switch signal. Pure logic —
// the UI feeds raw chunks in and redraws from `text`. Non-TTY callers use the
// buffered path and get none of this.
export class LineEditor {
  constructor({ completions = null, fileCompletions = null } = {}) {
    this.completions = completions; // () => string[] of "/name" entries
    this.fileCompletions = fileCompletions; // (prefix) => string[] of "@path" entries
    this.history = [];
    this.reset();
  }

  reset() {
    this.text = '';
    this.hIdx = null;      // index into history while browsing
    this.stash = '';       // in-progress line saved while browsing history
    this.tabBase = null;   // line before tab cycling
    this.tabIdx = -1;
  }

  _browsing() { return this.hIdx !== null; }

  _historyPrev() {
    if (!this.history.length) return;
    if (this.hIdx === null) {
      this.stash = this.text;
      this.hIdx = this.history.length - 1;
    } else if (this.hIdx > 0) {
      this.hIdx--;
    }
    this.text = this.history[this.hIdx];
  }

  _historyNext() {
    if (this.hIdx === null) return;
    if (this.hIdx < this.history.length - 1) {
      this.hIdx++;
      this.text = this.history[this.hIdx];
    } else {
      this.hIdx = null;
      this.text = this.stash;
    }
  }

  _tab() {
    // @-mention file completion takes precedence: @<prefix> + Tab
    const at = this.text.match(/@([\w./-]*)$/);
    if (at) {
      if (!this.fileCompletions) return;
      if (this.tabBase === null) this.tabBase = this.text;
      const m = this.tabBase.match(/@([\w./-]*)$/);
      if (!m) return;
      const candidates = this.fileCompletions(m[1]).slice(0, 20);
      if (!candidates.length) return;
      this.tabIdx = (this.tabIdx + 1) % (candidates.length + 1); // last slot restores the raw prefix
      const pre = this.tabBase.slice(0, this.tabBase.length - m[0].length);
      this.text = this.tabIdx === candidates.length ? this.tabBase : pre + candidates[this.tabIdx];
      return;
    }
    if (!this.text.startsWith('/')) {
      this.text += '  '; // shell-style: two spaces off-command
      return;
    }
    if (this.tabBase === null) this.tabBase = this.text;
    // candidates always filtered from the pre-tab prefix so cycling works
    const candidates = (this.completions ? this.completions() : [])
      .filter((c) => c.startsWith(this.tabBase) && c !== this.tabBase)
      .sort();
    if (!candidates.length) return;
    this.tabIdx = (this.tabIdx + 1) % (candidates.length + 1);
    this.text = this.tabIdx === candidates.length ? this.tabBase : candidates[this.tabIdx];
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
        const code = s[i + 2];
        if (code === 'A') { this._historyPrev(); events.push({ type: 'redraw' }); }
        else if (code === 'B') { this._historyNext(); events.push({ type: 'redraw' }); }
        else if (code === 'Z') { events.push({ type: 'shift-tab' }); }
        // ignore other arrows / keys
        i += 3;
        continue;
      }
      if (ch === '\t') { this._tab(); events.push({ type: 'redraw' }); i++; continue; }
      if (ch === '\x7f' || ch === '\b') { this.text = this.text.slice(0, -1); events.push({ type: 'redraw' }); i++; continue; }
      if (ch >= ' ') {
        this.text += ch;
        this.tabBase = null; // typing invalidates tab cycling
        events.push({ type: 'redraw' });
      }
      i++;
    }
    return events;
  }
}
