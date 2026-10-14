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
    this._onExit = () => this.leave();
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.lastLines = null;
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

  // Diff draw with absolute addressing: every row is written at its own
  // coordinate (`\x1b[{row};1H`), never via relative moves or bare newlines,
  // so a full-width row cannot trigger a pending-wrap scroll and the frame is
  // immune to drift. `cursor` is a 0-based {row, col} frame coordinate: when
  // given, the hardware cursor is placed there and shown (editing); otherwise
  // it stays hidden (streaming output needs no cursor).
  draw(lines, cursor = null) {
    if (!this.active) return;
    const prev = this.lastLines;
    let start = 0;
    if (prev) {
      while (start < lines.length && start < prev.length && lines[start] === prev[start]) start++;
    }
    let lastDirty = -1;
    for (let i = start; i < lines.length; i++) {
      if (!prev || i >= prev.length || lines[i] !== prev[i]) lastDirty = i;
    }
    const shrink = prev !== null && prev.length > lines.length;
    if (shrink) lastDirty = Math.max(lastDirty, lines.length - 1);
    const parts = [];
    if (!prev) parts.push('\x1b[H');
    for (let i = start; i <= lastDirty; i++) parts.push(`\x1b[${i + 1};1H`, lines[i]);
    if (shrink) parts.push(`\x1b[${lines.length + 1};1H\x1b[J`);
    if (cursor) parts.push(`\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`);
    else parts.push('\x1b[?25l');
    this.output.write(parts.join(''));
    this.lastLines = lines.slice();
    this.lastHeight = lines.length;
  }
}
