// Command planning for the system-level sandbox (Phase 1): given a resolved
// policy and a command, decide HOW it will run.
//
// Kept separate from the Bash tool so the decision is testable on its own and so
// the tool path stays a thin shell: plan → (wrap | fall back | refuse) → spawn.
//
// The fallback rule is the product contract from src/sandbox.js: a broken
// sandbox degrades to light mode rather than making the agent unable to run
// commands — but the degradation is REPORTED (`fellBack`) so the UI can say so
// instead of silently running unsandboxed (the failure mode measured in other
// agents, research §7.8).

import { buildBwrapCommand, bwrapLimitations } from './backends/bwrap.js';
import { normalizeSandbox } from './policy.js';
import { sandboxProbe } from './probe.js';

// POSIX single-quote escaping. Used only for the background-task path, which
// hands the command to a shell (src/background.js uses exec()), unlike the
// foreground path which spawns the backend directly with argv.
export function shellQuote(value) {
  const s = String(value);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.split("'").join("'\\''")}'`;
}

export function toShellCommand(file, args) {
  return [file, ...args].map(shellQuote).join(' ');
}

// Which backends this build can actually drive. A machine may be CAPABLE of a
// backend (probe says so) while we have not implemented it yet — the two must
// stay distinct, or macOS would silently run unsandboxed while the badge claims
// otherwise. Seatbelt is Phase 2 per docs/sandbox-system-plan-2026-10-16.md §6.
const IMPLEMENTED = new Set(['bwrap']);

/**
 * @param {object} args
 * @param {object} args.policy   from normalizeSandbox()
 * @param {object} args.probe    from sandboxProbe()
 * @param {string} args.command  the raw command string from the model
 * @param {string} args.cwd
 * @returns {{kind:'plain'}|{kind:'wrapped',file:string,args:string[],backend:string}
 *          |{kind:'unavailable',backend:string|null,reason:string,detail:string,fix:string|null,limitations:string[]}}
 */
export function planBashCommand({ policy, probe, command, cwd }) {
  if (policy.mode !== 'system') return { kind: 'plain' };

  const backend = pickBackend(policy, probe);
  if (!backend.ok) return { kind: 'unavailable', ...backend };

  const built = buildBwrapCommand(policy, { command, cwd });
  return {
    kind: 'wrapped',
    file: built.file,
    args: built.args,
    backend: backend.name,
    limitations: backend.limitations,
  };
}

function pickBackend(policy, probe) {
  const wanted = policy.backend === 'auto' ? null : policy.backend;
  const candidate = wanted || probe?.usable;
  const entry = candidate ? (probe?.backends || []).find((b) => b.name === candidate) : null;

  if (!entry) {
    const first = probe?.backends?.[0];
    return {
      ok: false,
      backend: null,
      reason: first?.reason || 'no-backend',
      detail: first?.detail || `no usable backend for ${probe?.platform || 'this platform'}`,
      fix: first?.fix || null,
      limitations: [],
    };
  }
  // Forcing a backend that exists but cannot run (e.g. userns blocked) must fail
  // loudly: silently using it would run the command unsandboxed.
  if (!entry.usable) {
    return {
      ok: false, backend: entry.name, reason: entry.reason,
      detail: entry.detail, fix: entry.fix, limitations: [],
    };
  }
  if (!IMPLEMENTED.has(entry.name)) {
    return {
      ok: false, backend: entry.name, reason: 'backend-not-implemented',
      detail: `${entry.name} is available on this machine but this build does not drive it yet`,
      fix: null, limitations: [],
    };
  }
  return {
    ok: true,
    name: entry.name,
    limitations: entry.name === 'bwrap' ? bwrapLimitations(policy) : [],
  };
}

/**
 * Cheap label for hot render paths (the Bash card). light/off need no backend
 * verdict, and probing SPAWNS PROCESSES — doing that inside a frame render would
 * block the TUI and the timers it is measuring, so the probe is only consulted
 * when the configuration actually asks for system mode (where it is memoized).
 */
export function sandboxBadgeLabel(config, { cwd = process.cwd() } = {}) {
  const raw = config?.sandbox;
  const mode = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.mode || 'light') : 'light');
  if (mode === 'off') return '';
  if (mode !== 'system') return 'sandboxed';
  const eff = effectiveSandbox(config, { cwd });
  return eff.active ? `sandboxed (${eff.label})` : 'NOT sandboxed (system unavailable)';
}

/**
 * What a Bash command would ACTUALLY run as, right now. Single source of truth
 * for `/sandbox`, the Bash card badge and the audit line, so the three cannot
 * disagree — the failure mode this guards against is a UI that says "sandboxed"
 * while the command runs bare (research §7.8).
 *
 * @returns {{policy:object,mode:string,backend:string|null,active:boolean,
 *            reason?:string,detail?:string,fix?:string,limitations?:string[],label:string}}
 */
export function effectiveSandbox(config, { cwd = process.cwd(), probe } = {}) {
  const policy = normalizeSandbox(config, { cwd });
  if (policy.mode !== 'system') {
    return { policy, mode: policy.mode, backend: null, active: policy.mode === 'light', label: policy.mode };
  }
  const p = probe || sandboxProbe();
  const plan = planBashCommand({ policy, probe: p, command: 'true', cwd });
  if (plan.kind === 'wrapped') {
    return {
      policy, mode: 'system', backend: plan.backend, active: true,
      limitations: plan.limitations, label: `system · ${plan.backend}`,
    };
  }
  return {
    policy, mode: 'system', backend: null, active: false,
    reason: plan.reason, detail: plan.detail, fix: plan.fix,
    label: `system (unavailable → ${policy.failOpen ? 'light' : 'blocked'})`,
  };
}
