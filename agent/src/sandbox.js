// Lightweight sandbox layer for the Bash tool (P4).
//
// THREAT MODEL — read this before trusting or extending this module.
// This is a guard rail, NOT a security boundary. It provides:
//   1. Secret hygiene: child processes get an env with credential-shaped
//      variables stripped, so a mistyped `env` or a poisoned install script
//      is less likely to phone home your keys.
//   2. Static pre-flight triage: commands classified 'dangerous' fail CLOSED
//      (never execute) in light mode; 'elevated' commands still run but are
//      written to the audit trail.
//   3. Audit trail: one JSON line per classified Bash execution in
//      ~/.cowcat/audit.log.
//   4. UI honesty: the TUI bash card says `· sandboxed` when light mode is on.
//
// What it deliberately does NOT do (v1):
//   - No network isolation: classified-elevated commands (curl, ssh, npm
//     install) still reach the network. The env strip removes *ambient*
//     secrets, nothing more.
//   - No filesystem jail: the child keeps the requested cwd and can write
//     anywhere the OS account can. We do NOT chdir into a temp dir because
//     that breaks relative-path project commands.
//   - No syscall filtering, no privilege drop, no container. A command that
//     genuinely wants to be malicious runs with the full rights of the
//     cowcat process. The dangerous-classifier is a regex heuristic and is
//     bypassable by construction (obfuscation, shells, downloads). Treat
//     blocked/elevated outcomes as tripwires for the audit log and the UI,
//     not as proof of safety.
//
// Failure policy: every function here is fail-open EXCEPT the
// dangerous-classification gate in the Bash tool, which fails closed. The
// sandbox must never throw into the tool execution path — a broken sandbox
// degrades to "no sandbox", not to "agent cannot run commands".

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDangerousCommand } from './permissions.js';
import { cowcatHome } from './config.js';

// --- environment sanitizing ---------------------------------------------------

// Well-known variables kept even if they ever match the sensitive pattern
// (defensive — none of them match today). Everything ELSE whose name smells
// like a credential is stripped from the child env.
// Choices, and why:
//   PATH/PATHEXT/COMSPEC — without these nothing spawns on Windows.
//   SystemRoot/WINDIR/SYSTEMROOT — Windows DLL/loader lookups; children die
//     without them.
//   HOME/USERPROFILE/HOMEDRIVE/HOMEPATH — too many tools assume a home dir.
//   TEMP/TMP — compilers and installers write scratch files there.
//   LANG/LC_ALL/LC_MESSAGES — keep tool output decodable; harmless.
//   TERM — dumb terminals without it misbehave (pagers, colors).
// Note the strip list is purely name-pattern based (below), so vars like
// NODE_OPTIONS survive; projects that need a stricter env can add them via
// sandbox.envDeny in config.
const ENV_ALWAYS_KEEP = new Set([
  'PATH', 'PATHEXT', 'COMSPEC',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'SYSTEMDRIVE', 'SystemDrive',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_MESSAGES', 'TERM',
]);

// A name matching this is treated as credential-shaped and stripped unless
// explicitly kept above. Case-insensitive: AWS_SECRET_ACCESS_KEY,
// GITHUB_TOKEN, NPM_TOKEN, ANTHROPIC_API_KEY, SSH_PRIVATE_KEY, ...
const ENV_SENSITIVE = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE)/i;

// Return a copy of `env` with credential-shaped variables removed.
// `deny` (from config sandbox.envDeny) extends the strip list: each entry is
// either an exact variable name or a "/regex/" string.
export function sanitizeEnv(env, { deny = [] } = {}) {
  const out = {};
  const exact = [];
  const res = [];
  for (const entry of Array.isArray(deny) ? deny : []) {
    if (typeof entry !== 'string') continue;
    const m = entry.match(/^\/(.*)\/([a-z]*)$/);
    if (m) { try { res.push(new RegExp(m[1], m[2])); } catch { /* bad regex: ignore */ } }
    else exact.push(entry);
  }
  const exactLower = new Set(exact.map((e) => e.toLowerCase()));
  for (const [k, v] of Object.entries(env || {})) {
    if (ENV_ALWAYS_KEEP.has(k)) { out[k] = v; continue; }
    if (exactLower.has(k.toLowerCase())) continue;
    if (res.some((r) => r.test(k))) continue;
    if (ENV_SENSITIVE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// --- static command classification -------------------------------------------

const DANGEROUS_EXTRA = [
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/, why: 'pipes a download straight into a shell' },
  { re: /(^|[;&|]\s*)nc\s+/, why: 'netcat can open arbitrary outbound connections' },
  { re: /\bncat\b|\bnc\s+-[a-z]*e/, why: 'netcat can open arbitrary outbound connections' },
  { re: /\bcryptsetup\b|\bmanage-bde\b|\bbitlocker\b/i, why: 'disk encryption / volume manipulation' },
  { re: /\bformat\s+(\/|[a-zA-Z]:)/i, why: 'disk format' },
  { re: /\bcipher\.exe\b|\bcipher\s+\/[we]/i, why: 'Windows cipher wipes/encrypts directories' },
  { re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+(\/|\/etc\b|\/usr\b|\/bin\b|\/sbin\b|\/System\b|~\/?|\$HOME)/, why: 'world-writable system path' },
  { re: /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b/, why: 'system power control' },
];

const ELEVATED_RULES = [
  { re: /\b(npm|pnpm|yarn|bun|pip3?|pipx|gem|cargo|composer)\s+(install|add|i)\b/, why: 'package-manager install (runs third-party install scripts)' },
  { re: /\b(curl|wget|ssh|scp|sftp|rsync|ftp)\b/, why: 'network client' },
  { re: /\bgit\s+push\b/, why: 'publishes to a remote' },
  { re: /\brm\s+(-[a-zA-Z]+\s+)*(-r|-rf|--recursive)?\s*(\.\.?\/|\/|~\/|[a-zA-Z]:[\\/])/, why: 'delete targeting a path outside the cwd' },
];

// Cheap static triage. Returns { risk: 'low'|'elevated'|'dangerous', reasons }.
// Never throws: unparseable/empty input is 'low' — the permission system and
// the human approval flow remain the real gates.
export function classifyCommand(command, { cwd } = {}) {
  const reasons = [];
  try {
    const c = String(command || '').trim();
    if (!c) return { risk: 'low', reasons };
    if (isDangerousCommand(c)) {
      reasons.push('matches the dangerous-command heuristics (permissions.js)');
      return { risk: 'dangerous', reasons };
    }
    for (const { re, why } of DANGEROUS_EXTRA) {
      if (re.test(c)) reasons.push(why);
    }
    if (reasons.length) return { risk: 'dangerous', reasons };
    for (const { re, why } of ELEVATED_RULES) {
      if (re.test(c)) reasons.push(why);
    }
    return { risk: reasons.length ? 'elevated' : 'low', reasons };
  } catch {
    return { risk: 'low', reasons };
  }
}

// --- audit trail ----------------------------------------------------------------

// Append one JSON line describing a classified Bash execution to
// ~/.cowcat/audit.log. Never throws: audit failure must not break the tool path
// (fail-open, the run itself already happened or was blocked by the classifier,
// not by this write).
//
// Written SYNCHRONOUSLY on purpose. The async mkdir+append version could lose the
// final line when the process exited right after a blocked/run command — and it
// made the audit tests racy on a loaded Windows CI runner (they slept 300ms and
// sometimes read an unfinished file). One line appended by a tool that just ran a
// whole subprocess is not a meaningful cost.
export function auditRecord(rec = {}) {
  try {
    const { command, cwd, risk, decision, ts = new Date().toISOString() } = rec || {};
    const line = JSON.stringify({
      ts,
      tool: 'Bash',
      cwd: String(cwd ?? ''),
      risk,
      decision, // 'run' | 'elevated-run' | 'blocked'
      command: String(command ?? '').slice(0, 500),
    }) + '\n';
    const file = join(cowcatHome(), 'audit.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line);
  } catch { /* audit is best-effort, always */ }
}

// --- Bash tool wiring helpers -----------------------------------------------------

// Resolve the sandbox mode for a tool context. Reads ctx.config.sandbox
// ('off' | 'light', default 'light') plus the envDeny list. Wrapped so a
// malformed config degrades to 'off' (no behavior change) rather than ever
// throwing into execute().
export function sandboxFor(config) {
  try {
    const mode = config?.sandbox === 'off' ? 'off' : 'light';
    const envDeny = Array.isArray(config?.sandboxEnvDeny)
      ? config.sandboxEnvDeny
      : (Array.isArray(config?.sandbox?.envDeny) ? config.sandbox.envDeny : []);
    return { mode, envDeny };
  } catch {
    return { mode: 'off', envDeny: [] };
  }
}

// Build the child env for a Bash run. Light mode sanitizes; off mode (or any
// failure) returns the legacy merged env unchanged.
export function sandboxEnv(baseEnv, sb) {
  try {
    if (sb?.mode !== 'light') return baseEnv;
    return sanitizeEnv(baseEnv, { deny: sb.envDeny });
  } catch {
    return baseEnv;
  }
}

// Human-facing explanation appended to blocked runs. Kept in one place so the
// tests and the UI card agree on the wording.
export function sandboxBlockMessage(classification) {
  const why = classification?.reasons?.length ? ` (${classification.reasons.join('; ')})` : '';
  return `Blocked by sandbox (light mode)${why}. `
    + 'The command was classified dangerous and was NOT executed. '
    + 'If this is truly intended, re-run with the sandbox off (/sandbox off) — '
    + 'the run will then require the normal approval flow.';
}
