// Minimal SSE (text/event-stream) parser shared by the MCP transports.
//
// Fed decoded text chunks, it emits one event per blank-line-terminated frame.
// The spec allows a frame's data to span several `data:` lines (joined with
// \n), and a frame may carry `id:` (resumption token) and `retry:` (server's
// preferred reconnect delay). Comment frames (`: keepalive`) exist only to hold
// the connection open and are dropped.
//
// The transport code used to scan for single `data:` lines by hand: multiline
// data would be read as truncated JSON, and the ids needed to resume a dropped
// stream were thrown away.
export class SseParser {
  constructor() {
    this.buf = '';
    this._data = [];
    this._id = null;
    this._retry = null;
    this._has = false; // a frame has started (any field seen)
  }
  // Returns the events completed by this chunk. Events are
  // { data, id, retry } — id/retry are null when the frame did not carry them.
  feed(chunk) {
    this.buf += chunk;
    const events = [];
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const ev = this._consume(line);
      if (ev) events.push(ev);
    }
    return events;
  }
  // A stream that ends without a trailing blank line still carries a usable
  // frame in the wild (and when the connection drops mid-frame). The last
  // partial line is treated as a line: if it is truncated JSON the frame is
  // simply unusable downstream.
  flush() {
    if (this.buf) {
      const line = this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf;
      this.buf = '';
      const ev = this._consume(line);
      if (ev) return [ev];
    }
    const ev = this._take();
    return ev ? [ev] : [];
  }
  // Returns the event completed by this line (blank line), else null.
  _consume(line) {
    if (line === '') return this._take();
    // comments (": ...") are keep-alive/padding
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // one optional space
    if (field === 'data') {
      this._data.push(value);
      this._has = true;
    } else if (field === 'id') {
      this._id = value;
      this._has = true;
    } else if (field === 'retry') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) this._retry = n;
      this._has = true;
    }
    // `event:` and unknown fields are ignored: MCP does not use event names
    return null;
  }
  _take() {
    if (!this._has) return null;
    const ev = {
      data: this._data.join('\n'),
      id: this._id,
      retry: this._retry,
    };
    this._data = [];
    this._id = null;
    this._retry = null;
    this._has = false;
    return ev;
  }
}
