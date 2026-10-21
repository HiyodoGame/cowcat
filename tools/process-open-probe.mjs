// Probe: can `ProcessPort.open()` carry a command's stdout as an output channel?
//
// `open()` was built for MCP stdio (ADR-086): newline-framed messages, with a 1 MB
// per-line buffer that is DISCARDED when a peer never sends a newline. That is a
// reasonable rule for protocol frames and a data-loss bug for `Bash` output, which
// can contain a 1.2 MB minified line or a progress bar that only writes `\r`.
//
// This probe runs the real adapter (packages/cowcat/dist) against two fixtures:
//   1. three short lines            -> expect all three, in order
//   2. one 1.2 MB line, no newline  -> expect the line to be dropped (the point)
//
// It is a development probe: not part of lint, not shipped in a package.

const dist = new URL('../packages/cowcat/dist/src/', import.meta.url);const load = (file) => import(new URL(file, dist).href);
const { NodeProcess } = await load('adapters/process.js');
const { nodePlatform } = await load('adapters/platform.js');
const { defaultSandboxProfile } = await load('ports/process.js');

const sandbox = defaultSandboxProfile({ mode: 'off', backend: 'none', network: 'off' });
const processPort = new NodeProcess({ platform: nodePlatform() });

async function capture(argv) {
  const handle = await processPort.open(
    { argv, cwd: process.cwd(), env: process.env, sandbox },
    new AbortController().signal,
  );
  const lines = [];
  handle.onStdoutLine((line) => lines.push(line));
  const exit = await new Promise((resolve) => {
    handle.onExit(resolve);
  });
  return { lines, exit };
}

const shortLines = await capture([
  process.execPath,
  '-e',
  "process.stdout.write('alpha\\nbeta\\ngamma\\n')",
]);

const oneLongLine = await capture([
  process.execPath,
  '-e',
  // 1.2 MB, then the newline that would end the "message".
  "process.stdout.write('x'.repeat(1200000)); process.stdout.write('\\n')",
]);

const longChars = oneLongLine.lines.reduce((sum, line) => sum + line.length, 0);

console.log('short lines      :', JSON.stringify(shortLines.lines), 'exit', shortLines.exit.exitCode);
console.log('1.2 MB line      :', `received ${String(oneLongLine.lines.length)} line(s), ${String(longChars)} chars`);
console.log('1.2 MB expected  : 1200000 chars in one line; anything less means the buffer was discarded');
console.log(
  longChars >= 1_200_000
    ? 'RESULT: open() preserved the long line (reuse is viable)'
    : `RESULT: open() dropped ${String(1_200_000 - longChars)} chars (reuse is NOT viable as a Bash channel)`,
);
