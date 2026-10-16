// Violation detection and the model-facing "why was I blocked" note (Phase 1).
//
// Two honest constraints shape this module:
//
// 1. bwrap itself reports nothing. Denials surface as the SANDBOXED COMMAND's own
//    errors (the kernel returns EPERM/ENOENT to it), so detection is pattern
//    matching over the command's stderr, and the matches are labelled
//    "suspected". Real per-syscall reporting needs the kernel-side mechanisms the
//    research report describes (Landlock has no event stream either, §4.2).
// 2. A hidden path looks like a MISSING path. `cat ~/.ssh/id_rsa` under the
//    workspace read profile fails with ENOENT, which reads as "the file does not
//    exist" — a wrong conclusion the model would act on. Explaining the sandbox
//    at that moment is the whole point (research §2.1: an agent that does not
//    understand the refusal tries to defeat it), so the note names the mode, the
//    backend, and what the user has to do.
//
// Everything that leaves this module is sanitized and capped: violation text is
// attacker-influenced (it comes from a command's output) and srt's 500-character
// cap is a good precedent (research §6).

const MAX_LINE = 500;

export function sanitizeLine(input) {
  const s = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s;
}

const PATTERNS = [
  { kind: 'fs-write', re: /read-only file system/i },
  { kind: 'fs-read', re: /(permission denied|operation not permitted)/i },
  { kind: 'fs-read', re: /no such file or directory/i, note: 'denied-or-hidden' },
  { kind: 'net', re: /(network is unreachable|temporary failure in name resolution|could not resolve host|name or service not known|connect: network|connection refused)/i },
  { kind: 'unix-socket', re: /(no such file or directory|permission denied).*(\.sock|docker\.sock)/i },
];

// Best-effort target: the last path-looking token on the line, else the line.
function targetOf(line) {
  const m = line.match(/((?:[A-Za-z]:)?[~/.]?[\w./\\-]{3,})/g);
  if (!m) return null;
  const looksLikePath = m.filter((t) => /[~/]|\.\w{1,6}$/.test(t));
  return (looksLikePath.at(-1) || m.at(-1) || '').slice(0, 200) || null;
}

/**
 * @returns {{kind:string,target:string|null,line:string}[]} at most `limit` entries
 */
export function detectViolations(stderr, { limit = 5 } = {}) {
  const out = [];
  for (const raw of String(stderr || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        out.push({ kind: p.kind, target: targetOf(line), line: sanitizeLine(line).slice(0, 200) });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The one-paragraph explanation appended to a tool result. `ask` is what the user
 * must do; the model is told to surface it rather than fight it.
 */
export function sandboxNote({ policy, backend, violations = [], limitations = [] } = {}) {
  if (!policy || policy.mode !== 'system') return '';
  const kinds = [...new Set(violations.map((v) => v.kind))];
  const what = kinds.length ? kinds.join(', ') : 'a restricted operation';
  const lines = [
    `[sandbox] system mode${backend ? ` (${backend})` : ''} likely refused ${what}.`,
    `network: ${policy.network}; reads: ${policy.read.profile}; writes: allow-only (project).`,
    'This is the sandbox, not a broken command or a missing file.',
    'If the command is genuinely needed, ask the user to run /sandbox light (or grant the path/network in sandbox.* config) — do not try to work around it.',
  ];
  // The most common refusal in `ask` mode is a command that needed the network
  // and was not approved for this run: name the fix precisely so the model asks
  // for the right thing instead of retrying the same call.
  if (kinds.includes('net') && policy.network === 'ask') {
    lines.push('network was NOT granted for this run: the user approves it per command (or set sandbox.network to "on").');
  }
  if (limitations.length) lines.push(`note: ${limitations.slice(0, 2).map(sanitizeLine).join('; ')}`);
  return lines.join(' ');
}
