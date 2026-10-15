// Multiline composer editor for the TUI (the line-mode UI keeps using the
// original single-line LineEditor). Flat-buffer cursor model like LineEditor —
// so home/end/kill stay line-wise — plus word movement, bracketed-paste-safe
// multi-line inserts, and normalized-chord input from the keybind layer.
// Pure logic: the UI feeds keys in and redraws from text/render().
import { normalizeKey } from './keybind.js';
import { stringWidth } from './wcwidth.js';

export class ComposerEditor {
  constructor({ completions = null, fileCompletions = null, externalHistory = null } = {}) {
    this.completions = completions; // () => string[] of "/name" entries
    this.fileCompletions = fileCompletions; // (prefix) => string[] of "@path" entries
    this.externalHistory = externalHistory; // () => string[] persisted prompts, oldest first
    this.history = [];
    this.rev = 0; // bumped on every text mutation; UI watches it to re-open dismissed menus
    this.reset();
  }

  reset() {
    this.rev++;
    this.text = '';
    this._cursor = 0;      // code-unit offset into text
    this.hIdx = null;      // index into history while browsing
    this.stash = '';       // in-progress line saved while browsing history
    this.tabBase = null;   // line before tab cycling
    this.tabIdx = -1;
    this.tabCandidates = []; // candidates of the active tab cycle (for display)
  }

  get cursor() { return this._cursor; }

  cancelCompletion() {
    this.tabBase = null;
    this.tabIdx = -1;
    this.tabCandidates = [];
  }

  // Whole-line replacement used by completion menus; any active tab cycle is
  // cancelled first.
  setText(s) {
    this.cancelCompletion();
    this._setText(s);
  }

  _browsing() { return this.hIdx !== null; }

  _setText(s) { this.rev++; this.text = s; this._cursor = s.length; }

  _historyItems() {
    // in-memory session history wins; persisted prompt history is the fallback
    return this.history.length || !this.externalHistory
      ? this.history
      : this.externalHistory();
  }

  _historyPrev() {
    const items = this._historyItems();
    if (!items.length) return;
    if (this.hIdx === null) {
      this.stash = this.text;
      this.hIdx = items.length - 1;
    } else if (this.hIdx > 0) {
      this.hIdx--;
    }
    this._setText(items[this.hIdx]);
  }

  _historyNext() {
    if (this.hIdx === null) return;
    const items = this._historyItems();
    if (this.hIdx < items.length - 1) {
      this.hIdx++;
      this._setText(items[this.hIdx]);
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
    if (!candidates.length) { this.tabBase = null; return; }
    this.tabIdx = (this.tabIdx + 1) % (candidates.length + 1);
    this._setText(this.tabIdx === candidates.length ? this.tabBase : candidates[this.tabIdx]);
  }

  // --- cursor model -------------------------------------------------------------

  insert(ch) {
    const s = String(ch);
    this.rev++;
    this.text = this.text.slice(0, this._cursor) + s + this.text.slice(this._cursor);
    this._cursor += s.length;
    this.tabBase = null; // typing invalidates tab cycling
    this.tabCandidates = [];
  }

  moveLeft() {
    if (this._cursor === 0) return;
    this._cursor -= this._cursor >= 2
      && /[\uD800-\uDBFF]/.test(this.text[this._cursor - 2])
      && /[\uDC00-\uDFFF]/.test(this.text[this._cursor - 1]) ? 2 : 1;
  }

  moveRight() {
    if (this._cursor >= this.text.length) return;
    this._cursor += /[\uD800-\uDBFF]/.test(this.text[this._cursor])
      && /[\uDC00-\uDFFF]/.test(this.text[this._cursor + 1]) ? 2 : 1;
  }

  home() { this._cursor = this.text.lastIndexOf('\n', this._cursor - 1) + 1; }

  end() {
    const i = this.text.indexOf('\n', this._cursor);
    this._cursor = i === -1 ? this.text.length : i;
  }

  // Word granularity: word chars are [A-Za-z0-9_]; anything else is a
  // separator run. Forward lands on the end of the next word, backward on
  // the start of the previous word (readline alt+f/alt+b semantics).
  wordForward() {
    const isWord = (c) => c !== undefined && /[\w]/.test(c);
    let i = this._cursor;
    while (i < this.text.length && !isWord(this.text[i])) i++;
    while (i < this.text.length && isWord(this.text[i])) i++;
    this._cursor = i;
  }

  wordBackward() {
    const isWord = (c) => c !== undefined && /[\w]/.test(c);
    let i = this._cursor;
    while (i > 0 && !isWord(this.text[i - 1])) i--;
    while (i > 0 && isWord(this.text[i - 1])) i--;
    this._cursor = i;
  }

  deleteBack() {
    if (this._cursor === 0) return;
    const end = this._cursor;
    this.moveLeft();
    this.rev++;
    this.text = this.text.slice(0, this._cursor) + this.text.slice(end);
  }

  deleteForward() {
    if (this._cursor >= this.text.length) return;
    const start = this._cursor;
    this.moveRight();
    this.rev++;
    this.text = this.text.slice(0, start) + this.text.slice(this._cursor);
  }

  // Delete the word right before the cursor, bounded by non-word characters;
  // when the cursor sits on a non-word run, that run is removed instead.
  killWordBack() {
    const isWord = (c) => c !== undefined && /[\w]/.test(c);
    let i = this._cursor;
    if (isWord(this.text[i - 1])) { while (i > 0 && isWord(this.text[i - 1])) i--; }
    else { while (i > 0 && !isWord(this.text[i - 1])) i--; }
    this.rev++;
    this.text = this.text.slice(0, i) + this.text.slice(this._cursor);
    this._cursor = i;
  }

  killToStart() {
    const i = this.text.lastIndexOf('\n', this._cursor - 1) + 1;
    this.rev++;
    this.text = this.text.slice(0, i) + this.text.slice(this._cursor);
    this._cursor = i;
  }

  killToEnd() {
    const i = this.text.indexOf('\n', this._cursor);
    this.rev++;
    this.text = this.text.slice(0, this._cursor) + this.text.slice(i === -1 ? this.text.length : i);
  }

  // Display mapping: split lines plus the cursor position in row/col terms.
  // cursorCol is a DISPLAY column (CJK-aware), not a code-unit offset — the
  // TUI places the hardware caret and scrolls the row by display width.
  render(width) {
    const lines = this.text.split('\n');
    const before = this.text.slice(0, this._cursor);
    const rowText = before.slice(before.lastIndexOf('\n') + 1);
    return {
      lines,
      cursorRow: lines.length - this.text.slice(this._cursor).split('\n').length,
      cursorCol: stringWidth(rowText),
    };
  }

  // Feed one chunk (a single key or several). Accepts raw stdin sequences and
  // normalized chords ('alt+f', 'ctrl+left', ...). Returns events:
  // [{type:'redraw'}...] plus at most one {type:'submit', line} or {type:'shift-tab'}.
  handle(chunk) {
    const events = [];
    let i = 0;
    const s = String(chunk);
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\r') {
        const line = this.text;
        if (line.trim()) { this.history.push(line); if (this.history.length > 500) this.history.shift(); }
        this.reset();
        events.push({ type: 'submit', line });
        i++;
        continue;
      }
      if (ch === '\n') { this._applyKey('\x0a', events); i++; continue; } // ctrl+j: newline
      if (ch === '\x1b' && s[i + 1] === '[') {
        const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z~]/);
        if (!m) { i++; continue; }
        this._applyKey(m[0], events);
        i += m[0].length;
        continue;
      }
      if (ch === '\x1b' && s[i + 1] === 'O') {
        const m = s.slice(i).match(/^\x1bO[A-Za-z]/);
        if (!m) { i++; continue; }
        this._applyKey(m[0], events);
        i += m[0].length;
        continue;
      }
      if (ch === '\x1b') {
        // alt+char arrives as ESC+char
        const m = s.slice(i).match(/^\x1b./s);
        if (!m) { i++; continue; }
        this._applyKey(m[0], events);
        i += m[0].length;
        continue;
      }
      this._applyKey(ch, events);
      i++;
    }
    return events;
  }

  _applyKey(raw, events) {
    const key = normalizeKey(raw);
    switch (key) {
      case 'up': this._historyPrev(); events.push({ type: 'redraw' }); break;
      case 'down': this._historyNext(); events.push({ type: 'redraw' }); break;
      case 'left': this.moveLeft(); events.push({ type: 'redraw' }); break;
      case 'right': this.moveRight(); events.push({ type: 'redraw' }); break;
      case 'home': case 'ctrl+a': this.home(); events.push({ type: 'redraw' }); break;
      case 'end': case 'ctrl+e': this.end(); events.push({ type: 'redraw' }); break;
      case 'delete': this.deleteForward(); events.push({ type: 'redraw' }); break;
      case 'shift+tab': events.push({ type: 'shift-tab' }); break;
      case 'tab': this._tab(); events.push({ type: 'redraw' }); break;
      case 'backspace': this.deleteBack(); events.push({ type: 'redraw' }); break;
      case 'ctrl+w': this.killWordBack(); events.push({ type: 'redraw' }); break;
      case 'ctrl+u': this.killToStart(); events.push({ type: 'redraw' }); break;
      case 'ctrl+k': this.killToEnd(); events.push({ type: 'redraw' }); break;
      case 'ctrl+j': case 'shift+enter': this.insert('\n'); events.push({ type: 'redraw' }); break;
      case 'alt+f': case 'ctrl+right': this.wordForward(); events.push({ type: 'redraw' }); break;
      case 'alt+b': case 'ctrl+left': this.wordBackward(); events.push({ type: 'redraw' }); break;
      default:
        if (key.length === 1 && key >= ' ') {
          this.insert(key);
          events.push({ type: 'redraw' });
        }
    }
  }
}
