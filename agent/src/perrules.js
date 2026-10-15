// Permission rules engine (simplified). Rules live in ~/.cowcat/state.json
// under permissions: { allow: [], deny: [], ask: [] }. Syntax: "Tool" matches
// the whole tool; "Tool(pattern)" matches an exact subject; a trailing ":*"
// makes it a prefix match ("Bash(npm run test:*)"). Priority: deny > ask >
// allow > default behavior. Rules never apply in yolo mode.
import { writeState } from './config.js';
import { globToRegExp } from './tools/glob.js';

const RULE_RE = /^([A-Za-z][\w.-]*)\s*(?:\((.*)\))?$/s;

// MCP tools are registered as `mcp__<server>__<tool>` only after the server
// connects — long after the permission rules were validated at startup. Their
// names are dynamic, so they bypass the knownTools check (and may contain
// '-' or '.', which plain builtin names never do).
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;

// Parse + validate one rule string. Returns { rule } or { error } (Chinese).
export function validateRule(str, knownTools) {
  const s = String(str || '').trim();
  if (!s) return { error: '规则为空' };
  if ((s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) {
    return { error: `括号不配对：${s}` };
  }
  const m = s.match(RULE_RE);
  if (!m) return { error: `格式无法解析（应为 Tool 或 Tool(pattern)）：${s}` };
  const [, tool, rawPattern] = m;
  const isMcpTool = MCP_TOOL_RE.test(tool);
  if (!isMcpTool && !knownTools.includes(tool)) {
    return { error: `工具名 "${tool}" 未注册（可用：${knownTools.join(', ')}）` };
  }
  if (rawPattern === undefined) return { rule: { tool, pattern: null, prefix: false, raw: s } };
  const pattern = rawPattern.trim();
  if (!pattern) return { error: `模式为空：${s}` };
  const isPathTool = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep'].includes(tool);
  if (pattern.includes('*') && !pattern.endsWith(':*') && !(isPathTool && /^[\w./{}*-]+$/.test(pattern))) {
    return { error: `* 只能以 ":*" 结尾（前缀匹配），路径工具可用 glob（如 src/**）：${s}` };
  }
  const prefix = pattern.endsWith(':*');
  return { rule: { tool, pattern: prefix ? pattern.slice(0, -2) : pattern, prefix, raw: s } };
}

// Load permissions.<column> arrays from cfg, validating each rule. Bad rules
// are skipped with a warning — startup never fails because of a bad rule.
export function loadRules(cfg, knownTools) {
  const perms = (cfg && cfg.permissions) || {};
  const out = { allow: [], deny: [], ask: [], warnings: [] };
  for (const col of ['deny', 'ask', 'allow']) {
    const list = Array.isArray(perms[col]) ? perms[col] : [];
    list.forEach((str, i) => {
      const { rule, error } = validateRule(str, knownTools);
      if (rule) out[col].push(rule);
      else out.warnings.push(`permissions.${col} 第 ${i + 1} 条被跳过：${error}`);
    });
  }
  return out;
}

// What a rule matches against: Bash -> the full command string; Edit/Write ->
// the file path (glob when the pattern contains glob chars, else exact).
function subjectFor(toolName, input = {}) {
  if (toolName === 'Bash') return String(input.command || '').trim();
  if (toolName === 'Write' || toolName === 'Edit') return String(input.file_path || '');
  if (toolName === 'NotebookEdit') return String(input.notebook_path || '');
  return String(input.file_path || input.pattern || input.command || JSON.stringify(input));
}

export function matchRule(rule, toolName, input) {
  if (rule.tool !== toolName) return false;
  if (rule.pattern === null) return true;
  const subject = subjectFor(toolName, input);
  if (toolName === 'Bash') {
    if (!rule.prefix) return subject === rule.pattern;
    // "cmd:*" matches the bare command and continuations after a boundary
    // (space / colon / slash), so "npm run test" and "npm run test:unit" hit
    // while "npm run testing" does not.
    const p = rule.pattern;
    return subject === p || (subject.startsWith(p) && [' ', ':', '/'].includes(subject[p.length]));
  }
  if (/[*?{}[\]]/.test(rule.pattern)) {
    const re = globToRegExp(rule.pattern.replace(/\\/g, '/'));
    const subj = subject.replace(/\\/g, '/');
    return re.test(subj) || re.test(subj.replace(/^\w:[/]/, ''));
  }
  return subject === rule.pattern;
}

export function findMatch(rules, toolName, input) {
  return rules.find((r) => matchRule(r, toolName, input)) || null;
}

// Persist one column back into state.json (merged — other fields survive).
export function saveRuleColumn(column, rulesRaw) {
  return writeState((state) => {
    const perms = { ...(state.permissions || {}) };
    perms[column] = rulesRaw;
    state.permissions = perms;
    return state;
  });
}
