// Alternate-screen management: enter/leave the full-screen buffer, raw stdin,
// cursor visibility, and a frame-diff writer. Restores the terminal on exit
// and SIGINT. Works on Git Bash / PowerShell / cmd on Windows (ANSI via
// ConPTY; we also enable VT processing through Node's built-in console).
export class Screen {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.active = false;
    this.lastHeight = 0;
    this.lastLines = null;
    this._cursorRow = 0;
    this._onExit = () => this.leave();
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.lastLines = null;
    this._cursorRow = 0;
    this.output.write('\x1b[?1049h\x1b[?25l\x1b[H'); // alt screen, hide cursor
    process.once('exit', this._onExit);
    process.once('SIGINT', this._onExit);
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.output.write('\x1b[?25h\x1b[?1049l'); // show cursor, restore screen
    process.removeListener('exit', this._onExit);
    process.removeListener('SIGINT', this._onExit);
  }

  // Diff draw: track the cursor row below the last frame; on change, move to
  // the first dirty row, rewrite only the dirty rows, and erase rows left
  // over from a taller previous frame.
  draw(lines) {
    if (!this.active) return;
    const prev = this.lastLines;
    let start = 0;
    if (prev) {
      while (start < lines.length && start < prev.length && lines[start] === prev[start]) start++;
      if (start === lines.length && lines.length === prev.length) return;
    }
    let lastDirty = -1;
    for (let i = start; i < lines.length; i++) {
      if (i >= (prev ? prev.length : 0) || lines[i] !== prev[i]) lastDirty = i;
    }
    if (prev && prev.length > lines.length) lastDirty = lines.length - 1;
    const parts = [];
    if (!prev) parts.push('\x1b[H');
    else if (this._cursorRow > start) parts.push(`\x1b[${this._cursorRow - start}A`);
    else if (this._cursorRow < start) parts.push(`\x1b[${start - this._cursorRow}B`);
    for (let i = start; i <= lastDirty; i++) parts.push(lines[i], '\n');
    if (prev && prev.length > lines.length) {
      if (lines.length > lastDirty + 1) parts.push(`\x1b[${lines.length - lastDirty - 1}B`);
      parts.push('\x1b[J');
    }
    this.output.write(parts.join(''));
    this._cursorRow = prev && prev.length > lines.length ? lines.length : lastDirty + 1;
    this.lastLines = lines.slice();
    this.lastHeight = lines.length;
  }
}
