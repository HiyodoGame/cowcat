// Bash result card (brand guide §5.2 "终端输出"): folded by default —
// exit code (alert when non-zero) + last 3 lines + a pointer to the persisted
// full output. Short outputs (<=5 lines) show in full. Pure model + renderer.

export const SHORT_THRESHOLD = 5;
export const TAIL_LINES = 3;

export function bashCardModel(output, { threshold = SHORT_THRESHOLD, tail = TAIL_LINES } = {}) {
  const lines = String(output ?? '').split('\n');
  const folded = lines.length > threshold;
  return {
    folded,
    totalLines: lines.length,
    headLines: folded ? [] : lines,
    tailLines: folded ? lines.slice(-tail) : [],
    exitCode: null, // filled by caller when known
  };
}

export function renderBashCard(model, { colors = true, command = '', exitCode = null, file = null, tooLongLine = null } = {}) {
  const C = {
    alert: '\x1b[38;5;167m', gray: '\x1b[90m', reset: '\x1b[0m',
  };
  const pad = '  ';
  const code = exitCode ?? model.exitCode ?? 0;
  const codeStr = `exit ${code}`;
  const head = `${pad}┌─ Bash${command ? ` ${command}` : ''}  ${codeStr}${code !== 0 ? ' !' : ''}`;
  const lines = [colors && code !== 0 ? `${C.alert}${head}${C.reset}` : head];
  const body = model.folded ? model.tailLines : model.headLines;
  for (const l of body) lines.push(`${pad}│ ${l}`);
  if (model.folded) {
    const n = `${model.totalLines} lines total`;
    lines.push(colors ? `${pad}│ ${C.gray}··· ${n} ···${C.reset}` : `${pad}··· ${n} ···`);
    if (tooLongLine) lines.push(`${pad}│ ${tooLongLine}`);
  }
  if (file) lines.push(`${pad}│ full output: ${file}`);
  lines.push(`${pad}└─`);
  return lines;
}
