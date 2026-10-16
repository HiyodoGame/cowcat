// Writing to a child process's stdin.
//
// The write itself looks harmless, but when the child has already exited — a hook
// that ignores its payload, a statusline command that returns immediately, a
// helper killed after a timeout, an MCP server that crashed — the pipe is gone and
// Node raises EPIPE **asynchronously on the stream**. With no 'error' listener
// that is an uncaught exception and it takes the whole CLI down, which is how the
// same bug reached CI twice from different files (hooks.js, statusline.js).
//
// Linux surfaces it readily; Windows usually does not, so local runs stay green.
// Guard every child stdin we write to, once.
const guarded = new WeakSet();

// Attach the error listener (idempotent) and return the stream, or null when the
// child has no stdin (spawn with stdio: 'ignore', already-exited child, ...).
export function guardStdin(child) {
  const stdin = child?.stdin;
  if (!stdin) return null;
  if (!guarded.has(stdin)) {
    // EPIPE here means "the child stopped listening" — expected, not an error.
    stdin.on('error', () => {});
    guarded.add(stdin);
  }
  return stdin;
}

// Write a payload once and close stdin, tolerating a child that exited first.
// -> true when the write was dispatched, false when there was nothing to write to.
export function writeStdinOnce(child, text) {
  const stdin = guardStdin(child);
  if (!stdin) return false;
  try {
    stdin.write(text);
    stdin.end();
    return true;
  } catch {
    return false; // synchronously dead pipe
  }
}
