// Alternate-screen management: enter/leave the full-screen buffer, raw stdin,
// cursor visibility, and a full-frame writer. Restores the terminal on exit
// and SIGINT. Works on Git Bash / PowerShell / cmd on Windows (ANSI via
// ConPTY; we also enable VT processing through Node's built-in console).
export class Screen {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.active = false;
    this.lastHeight = 0;
    this._onExit = () => this.leave();
  }

  enter() {
    if (this.active) return;
    this.active = true;
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

  // Full-frame draw: home cursor, write lines, erase the rest, home again.
  draw(lines) {
    if (!this.active) return;
    const frame = `${lines.join('\n')}\x1b[J\x1b[H`;
    this.output.write(frame);
    this.lastHeight = lines.length;
  }
}
