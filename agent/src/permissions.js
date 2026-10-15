// Permission modes: 'default' (ask for writes/commands) | 'yolo' (allow all)
// | 'plan' (read-only exploration; writes and mutating commands are rejected)
// | 'acceptEdits' (plan approved: file writes auto-accepted, Bash still asks).
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']);
const AUTO_EDIT_TOOLS = new Set(['Write', 'Edit']);
const MODES = new Set(['default', 'yolo', 'plan', 'acceptEdits']);

// Bash subcommands allowed while in plan mode — pure inspection, no mutation.
const PLAN_BASH_ALLOW = [
  /^\s*ls(\s|$)/, /^\s*pwd(\s|$)/, /^\s*cat(\s|$)/, /^\s*head(\s|$)/, /^\s*tail(\s|$)/,
  /^\s*echo(\s|$)/, /^\s*which(\s|$)/, /^\s*wc(\s|$)/, /^\s*file(\s|$)/,
  /^\s*node\s+--version(\s|$)/, /^\s*npm\s+(view|ls|outdated|root)(\s|$)/,
  /^\s*git\s+(status|diff|log|show|branch|remote|ls-files|stash list|describe|tag -l|rev-parse)(\s|$)/,
];

// Permission rules engine (simplified). Rules live in ~/.cowcat/config.json
// under permissions: { allow: [], deny: [], ask: [] }. Syntax: "Tool" matches
// the whole tool; "Tool(pattern)" matches an exact subject; a trailing ":*"
// makes it a prefix match ("Bash(npm run test:*)"). Priority: deny > ask >
// allow > default behavior. Rules never apply in yolo mode.
import { matchRule } from './perrules.js';

// shift+tab toggles act <-> plan. Plan is a detour rather than a tier, so the
// mode we left is handed back to the caller (and cleared on the way back):
// 'yolo' has no other runtime entry point, so a session started with -y must not
// be stranded in ask-on-write after a peek at plan mode. Coming back with no
// remembered mode falls back to 'default' — e.g. plan was entered via /plan,
// which has nothing to restore.
export function shiftTabModes(mode, remembered = null) {
  return mode === 'plan'
    ? { mode: remembered ?? 'default', remembered: null }
    : { mode: 'plan', remembered: mode };
}

export class Permissions {
  constructor(mode = 'default') {
    this.mode = MODES.has(mode) ? mode : 'default';
    this.alwaysAllowed = new Set(); // `Name:JSON.stringify(key input)` approved with "always"
    this.rules = { allow: [], deny: [], ask: [] }; // from config.json; see src/perrules.js
  }

  // Install validated permission rules (startup + after /permissions edits).
  setRules({ allow = [], deny = [], ask = [] } = {}) {
    this.rules = { allow, deny, ask };
  }

  setMode(mode) {
    this.mode = MODES.has(mode) ? mode : 'default';
  }

  isReadOnly(toolName) {
    return READ_ONLY.has(toolName);
  }

  // Three-state decision: 'allow' | 'ask' | 'deny'. Rules from config.json,
  // priority deny > ask > allow > default; they never apply in yolo mode.
  decide(toolName, input = {}) {
    if (this.mode === 'yolo') return 'allow';
    const denied = this.rules.deny.find((r) => matchRuleRef(r, toolName, input));
    if (denied) return 'deny';
    if (this.rules.ask.some((r) => matchRuleRef(r, toolName, input))) return 'ask';
    if (this.rules.allow.some((r) => matchRuleRef(r, toolName, input))) return 'allow';
    if (this.mode === 'acceptEdits' && AUTO_EDIT_TOOLS.has(toolName)) return 'allow';
    if (this.isReadOnly(toolName)) return 'allow';
    const key = `${toolName}:${JSON.stringify(pickKeyInput(toolName, input))}`;
    return this.alwaysAllowed.has(key) ? 'allow' : 'ask';
  }

  deniedBy(toolName, input = {}) {
    return this.rules.deny.find((r) => matchRuleRef(r, toolName, input)) || null;
  }

  // Returns true when the tool may run without asking.
  check(toolName, input = {}) {
    if (this.mode === 'plan') return this.planReject(toolName, input) === null;
    return this.decide(toolName, input) === 'allow';
  }

  approveAlways(toolName, input = {}) {
    this.alwaysAllowed.add(`${toolName}:${JSON.stringify(pickKeyInput(toolName, input))}`);
  }

  // Plan mode gate: null = allowed, string = rejection reason for the model.
  planReject(toolName, input = {}) {
    if (this.mode !== 'plan') return null;
    if (READ_ONLY.has(toolName)) return null;
    if (toolName === 'Bash') {
      const cmd = (input.command || '').trim();
      if (PLAN_BASH_ALLOW.some((p) => p.test(cmd))) return null;
      return 'Plan mode limits Bash to read-only inspection commands (ls/pwd/cat/git status|diff|log|...).';
    }
    if (toolName === 'Agent') return 'Plan mode cannot delegate to sub agents; switch to act mode first.';
    return 'Plan mode is read-only: file modifications are rejected until the user switches to act mode.';
  }
}

function pickKeyInput(toolName, input) {
  if (toolName === 'Write' || toolName === 'Edit') return { file_path: input.file_path };
  if (toolName === 'Bash') return { command: input.command };
  return input;
}

function matchRuleRef(rule, toolName, input) {
  return matchRule(rule, toolName, input);
}

// Heuristics for commands that warrant an explicit warning even when auto-approved.
export function isDangerousCommand(command) {
  const c = command.trim();
  const patterns = [
    /\brm\s+(-[a-zA-Z]*\s+)*(-rf?|--recursive)\s+(\/(\s|$)|["']?\/["']?\s|~(\s|$))/,
    /\bgit\s+push\b.*(--force|-f)\b/,
    /\bgit\s+push\b.*\b(main|master)\b.*(--force|-f)\b/,
    /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:/, // fork bomb
    /\bmkfs\b/,
    /\bdd\s+.*of=\/dev\//,
    /\b(shutdown|reboot|poweroff|halt)\b/,
    /\bformat\s+[a-zA-Z]:/i,
    />\s*\/dev\/sd[a-z]/,
    /\b(chmod|chown)\s+-R\s+.*\s\/(\s|$)/,
  ];
  return patterns.some((p) => p.test(c));
}
