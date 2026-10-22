import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { HookEventInput, HookEventName, HookOutcome, HookRunReport, HooksPort } from '../ports/hooks.js';
import type { PlatformPort, ProcessPort, SandboxProfile } from '../ports/index.js';

/**
 * Hooks configuration and execution (ADR-121/122/123), Claude Code `settings.json`
 * compatible.
 *
 * Only `type: "command"` handlers execute. Everything else — http/mcp_tool/prompt/agent
 * handlers, the `if`/`async`/`once`/`shell`/`onFailure` fields, unknown hook event names —
 * is parsed and reported through {@link HookParseResult.inert} so `doctor` can say what
 * is being ignored (the same rule skills follows, ADR-115).
 */

export const HOOK_MIN_TIMEOUT_MS = 1_000;
export const HOOK_DEFAULT_TIMEOUT_MS = 60_000;
/** The bash v1 ceiling (bash.ts): a hook is a short script, not a build. */
export const HOOK_MAX_TIMEOUT_MS = 600_000;

const EVENT_NAMES: Readonly<Record<string, HookEventName>> = {
  PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use',
  UserPromptSubmit: 'user-prompt-submit',
  Stop: 'stop',
  SessionStart: 'session-start',
  PreCompact: 'pre-compact',
};

/** Events CC defines matchers for, inside our v1 subset. */
const MATCHED_EVENTS: Readonly<Set<HookEventName>> = new Set(['pre-tool-use', 'post-tool-use', 'pre-compact', 'session-start']);

const INERT_HANDLER_FIELDS = ['if', 'async', 'asyncRewake', 'once', 'shell', 'onFailure', 'statusMessage'] as const;

export interface ConfiguredHook {
  readonly event: HookEventName;
  /** `null` = match every occurrence of the event. */
  readonly matcher: HookMatcher | null;
  readonly command: string;
  readonly args: readonly string[] | null;
  readonly timeoutMs: number;
  /** Which file it came from, for doctor and failure lines. */
  readonly source: string;
}

export type HookMatcher =
  | { readonly kind: 'all' }
  | { readonly kind: 'exact'; readonly names: readonly string[] }
  | { readonly kind: 'regex'; readonly pattern: string };

export interface HookParseResult {
  readonly hooks: readonly ConfiguredHook[];
  /** Human-readable "parsed but inert" items for doctor (ADR-122 ②). */
  readonly inert: readonly string[];
}

// ---------------------------------------------------------------------------
// Parsing

const handlerShape = z.looseObject({
  type: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  timeout: z.number().int().positive().optional(),
});

const groupShape = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(z.unknown()),
});

/**
 * Parses one settings file's `hooks` section. `source` is the file path, reused in
 * every inert line so doctor output names the file. Never throws: a malformed entry
 * becomes an inert line, never a dead settings file.
 */
export function parseHookSection(raw: unknown, source: string): HookParseResult {
  if (raw === undefined || raw === null) return { hooks: [], inert: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { hooks: [], inert: [`${source}: "hooks" 不是对象，整段忽略`] };
  }
  const hooks: ConfiguredHook[] = [];
  const inert: string[] = [];
  for (const [eventName, groupsRaw] of Object.entries(raw)) {
    const event = EVENT_NAMES[eventName];
    if (event === undefined) {
      inert.push(`${source}: 不支持的 hook 事件 ${eventName}（v1 只接 PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart/PreCompact）`);
      continue;
    }
    const groupsParsed = z.array(groupShape).safeParse(groupsRaw);
    if (!groupsParsed.success) {
      inert.push(`${source}: ${eventName} 的 matcher 组形状不对，该事件忽略`);
      continue;
    }
    for (const group of groupsParsed.data) {
      let matcher: HookMatcher | null = null;
      if (group.matcher !== undefined && MATCHED_EVENTS.has(event)) {
        const compiled = compileMatcher(group.matcher);
        if ('error' in compiled) {
          inert.push(`${source}: ${eventName} 的 matcher "${group.matcher}" ${compiled.error}`);
          continue;
        }
        matcher = compiled;
      }
      for (const handlerRaw of group.hooks) {
        const parsed = handlerShape.safeParse(handlerRaw);
        if (!parsed.success) {
          inert.push(`${source}: ${eventName} 有一个 handler 不是对象，忽略`);
          continue;
        }
        const handler = parsed.data;
        if (handler.type !== 'command') {
          inert.push(`${source}: ${eventName} 的 ${handler.type} 类型 handler v1 不执行（只执行 command）`);
          continue;
        }
        if (handler.command === undefined || handler.command === '') {
          inert.push(`${source}: ${eventName} 有一个 command handler 缺 command，忽略`);
          continue;
        }
        for (const field of INERT_HANDLER_FIELDS) {
          if (field in handler) inert.push(`${source}: ${eventName} 的 "${field}" 字段解析但不生效`);
        }
        const timeoutMs = clampTimeout(handler.timeout);
        hooks.push({
          event,
          matcher,
          command: handler.command,
          args: handler.args ?? null,
          timeoutMs,
          source,
        });
      }
    }
  }
  return { hooks, inert };
}

/**
 * CC matcher semantics 【上游】: `*`/空/省略 matches all; a string made only of
 * `[A-Za-z0-9 _,-]` is an exact match or an alternatives list (`|` or `,`); anything
 * else is a JavaScript regex tested unanchored.
 */
export function compileMatcher(matcher: string): HookMatcher | { readonly error: string } {
  if (matcher === '' || matcher === '*') return { kind: 'all' };
  if (/^[A-Za-z0-9 _,-|]+$/.test(matcher)) {
    const names = matcher.split(/[|,]/).map((part) => part.trim()).filter((part) => part !== '');
    return names.length === 0 ? { kind: 'all' } : { kind: 'exact', names };
  }
  try {
    new RegExp(matcher);
  } catch {
    return { error: '不是合法正则，永不匹配' };
  }
  return { kind: 'regex', pattern: matcher };
}

export function matcherMatches(matcher: HookMatcher | null, value: string): boolean {
  if (matcher === null || matcher.kind === 'all') return true;
  if (matcher.kind === 'exact') return matcher.names.includes(value);
  return new RegExp(matcher.pattern).test(value);
}

function clampTimeout(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined) return HOOK_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(timeoutSeconds * 1_000, HOOK_MIN_TIMEOUT_MS), HOOK_MAX_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Execution

export interface HookRunnerOptions {
  /** Merged handlers in execution order (user sources before project sources). */
  readonly parsed: HookParseResult;
  readonly process: ProcessPort;
  readonly platform: PlatformPort;
  readonly sandbox: SandboxProfile;
  /** `${CLAUDE_PROJECT_DIR}`: the project root where the session started. */
  readonly projectDir: string;
  /** Where session logs live; the hook input's `transcript_path` is derived from it. */
  readonly sessionsDir: string;
  /** Extra env beyond the host environment. `CLAUDE_PROJECT_DIR` is added here. */
  readonly env?: Readonly<Record<string, string>>;
}

export function createHooksPort(options: HookRunnerOptions): HooksPort {
  const { parsed } = options;
  return {
    run: async (input: HookEventInput, signal: AbortSignal): Promise<HookRunReport> => {
      const matched = parsed.hooks.filter((hook) => {
        if (hook.event !== input.event) return false;
        if (!MATCHED_EVENTS.has(hook.event)) return true;
        return matcherMatches(hook.matcher, matchValue(input));
      });
      if (matched.length === 0) return { outcome: { effect: 'none' }, failures: [] };

      const failures: string[] = [];
      let contexts: string[] = [];
      let rewrite: { output: string; note: string | null } | null = null;

      for (const hook of matched) {
        const result = await runHandler(options, hook, input, signal, failures);
        if (result.deny !== null) {
          return { outcome: { effect: 'deny', reason: result.deny }, failures };
        }
        if (result.context !== null) contexts = [...contexts, result.context];
        if (result.rewrite !== null) rewrite = result.rewrite;
        if (signal.aborted) break;
      }

      // Observation events stay observation (ADR-122 ①): their JSON output is validated
      // but no effect is applied, so a Stop hook can never rewrite a finished turn.
      const observable = input.event === 'stop' || input.event === 'session-start' || input.event === 'pre-compact';
      const outcome: HookOutcome = contexts.length > 0 && !observable
        ? { effect: 'context', text: contexts.join('\n\n') }
        : rewrite !== null
          ? { effect: 'rewrite', output: rewrite.output, note: rewrite.note }
          : { effect: 'none' };
      return { outcome, failures };
    },
  };
}

function matchValue(input: HookEventInput): string {
  if (input.event === 'pre-tool-use' || input.event === 'post-tool-use') return input.toolName ?? '';
  if (input.event === 'pre-compact') return input.trigger ?? 'auto';
  return 'startup';
}

interface HandlerEffect {
  readonly deny: string | null;
  readonly context: string | null;
  readonly rewrite: { output: string; note: string | null } | null;
}

async function runHandler(
  options: HookRunnerOptions,
  hook: ConfiguredHook,
  input: HookEventInput,
  signal: AbortSignal,
  failures: string[],
): Promise<HandlerEffect> {
  const stdin = JSON.stringify(hookInputJson(options, input));
  const command = substituteProjectDir(hook.command, options.projectDir);
  const shell = options.platform.resolveShell();
  const spec = {
    argv: hook.args === null
      ? [shell.executable, ...shell.baseArgs, shell.commandFlag, command]
      : [command, ...hook.args.map((arg) => substituteProjectDir(arg, options.projectDir))],
    cwd: input.cwd,
    env: { ...currentEnv(options.env), CLAUDE_PROJECT_DIR: options.projectDir },
    stdin,
    timeoutMs: hook.timeoutMs,
    sandbox: options.sandbox,
  };

  let result;
  try {
    result = await options.process.run(spec, signal);
  } catch (error) {
    failures.push(`${hook.source}: hook 没能启动（${error instanceof Error ? error.message : String(error)}）`);
    return { deny: null, context: null, rewrite: null };
  }

  const timedOut = result.termination.reason === 'timeout';
  if (timedOut) {
    failures.push(`${hook.source}: hook 超时（${String(Math.round(hook.timeoutMs / 1_000))}s）`);
    return { deny: null, context: null, rewrite: null };
  }
  if (result.exitCode === null || result.exitCode === 0) {
    return parseSuccessOutput(hook, result.stdout, failures);
  }
  if (result.exitCode === 2) {
    // The blocking exit code. On actions that can be refused the reason goes to the
    // model (ADR-121 ③); on observation events there is nothing to refuse, so it is a
    // failure line instead.
    const reason = firstLine(result.stderr) ?? firstLine(result.stdout) ?? 'blocked by hook';
    if (input.event === 'pre-tool-use' || input.event === 'user-prompt-submit') {
      return { deny: reason, context: null, rewrite: null };
    }
    failures.push(`${hook.source}: hook exit 2（${reason}）`);
    return { deny: null, context: null, rewrite: null };
  }
  failures.push(`${hook.source}: hook exit ${String(result.exitCode)}（${firstLine(result.stderr) ?? 'no stderr'}）`);
  return { deny: null, context: null, rewrite: null };
}

/** Builds the stdin JSON, CC input shape with only the fields that are true here. */
function hookInputJson(options: HookRunnerOptions, input: HookEventInput): Record<string, unknown> {
  const json: Record<string, unknown> = {
    session_id: input.sessionId,
    transcript_path: joinPath(options.sessionsDir, `${input.sessionId}.jsonl`),
    cwd: input.cwd,
    hook_event_name: input.event,
  };
  if (input.toolName !== undefined) json.tool_name = input.toolName;
  if (input.toolInput !== undefined) json.tool_input = input.toolInput;
  if (input.toolResponse !== undefined) json.tool_response = input.toolResponse;
  if (input.prompt !== undefined) json.prompt = input.prompt;
  if (input.trigger !== undefined) json.trigger = input.trigger;
  return json;
}

function parseSuccessOutput(
  hook: ConfiguredHook,
  stdout: string,
  failures: string[],
): HandlerEffect {
  const trimmed = stdout.trim();
  if (trimmed === '') return { deny: null, context: null, rewrite: null };
  if (!trimmed.startsWith('{')) {
    // Plain text stdout is not a failure 【上游】: a hook that just logs succeeds.
    return { deny: null, context: null, rewrite: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    failures.push(`${hook.source}: hook 输出了看似 JSON 但解析失败的内容`);
    return { deny: null, context: null, rewrite: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    failures.push(`${hook.source}: hook 的 JSON 输出不是对象`);
    return { deny: null, context: null, rewrite: null };
  }
  const record = parsed as Record<string, unknown>;
  const specific = asRecord(record.hookSpecificOutput);

  let deny: string | null = null;
  const decision = stringField(specific, 'permissionDecision') ?? stringField(specific, 'decision');
  if ((decision === 'deny' || decision === 'block') && inputCanDeny(hook.event)) {
    deny = stringField(specific, 'permissionDecisionReason') ?? stringField(specific, 'reason') ?? 'denied by hook';
  }

  let context: string | null = null;
  if (!observableEvent(hook.event)) {
    context = stringField(record, 'additionalContext');
  }

  let rewrite: { output: string; note: string | null } | null = null;
  if (hook.event === 'post-tool-use' && specific !== null) {
    const updated = specific.updatedToolOutput;
    const outputText = typeof updated === 'string' ? updated : stringField(asRecord(updated), 'output');
    if (outputText !== null) {
      rewrite = {
        output: outputText,
        note: decision === 'block' ? stringField(specific, 'reason') : null,
      };
    }
  }
  return { deny, context, rewrite };
}

function inputCanDeny(event: HookEventName): boolean {
  return event === 'pre-tool-use' || event === 'user-prompt-submit';
}

function observableEvent(event: HookEventName): boolean {
  return event === 'stop' || event === 'session-start' || event === 'pre-compact';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function substituteProjectDir(text: string, projectDir: string): string {
  return text.split('${CLAUDE_PROJECT_DIR}').join(projectDir);
}

function firstLine(text: string): string | null {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

function currentEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  if (extra !== undefined) Object.assign(env, extra);
  return env;
}

function joinPath(dir: string, file: string): string {
  // Local to this adapter: paths are joined here, not in the kernel (ADR-017 stays
  // about *identity*; a transcript path is a fact the adapter hands over).
  return `${dir.replace(/[\\/]+$/, '')}/${file}`;
}

// ---------------------------------------------------------------------------
// Source files (ADR-123 ①)

export interface HookSourceInput {
  readonly home: string;
  /** The cowcat state directory (`~/.cowcat`), where `config.json` lives. */
  readonly cowcatDir: string;
  /** Project root (`projectRootOf` walk); null means the cwd is not inside a project. */
  readonly projectRoot: string | null;
  /** The same `workspaceTrusted` value the rules/instructions/skills/MCP gates use. */
  readonly trusted: boolean;
}

export interface LoadedHookSources {
  readonly parsed: HookParseResult;
  /** How many files contributed hooks (user + trusted project). */
  readonly loaded: number;
  /** How many project files were skipped because the workspace is not trusted. */
  readonly skippedUntrusted: number;
}

/**
 * Reads the five hook sources in execution order: user first, project second (ADR-123
 * ②). Missing files are not an error — most projects have none. Unreadable or
 * unparseable files become inert lines rather than refusing the whole load, the same
 * posture skills take toward a malformed SKILL.md.
 */
export async function loadHookSources(input: HookSourceInput): Promise<LoadedHookSources> {
  const candidates: readonly { path: string; layer: 'user' | 'project' }[] = [
    { path: joinPath(input.home, '.claude/settings.json'), layer: 'user' },
    { path: joinPath(input.cowcatDir, 'config.json'), layer: 'user' },
    ...(input.projectRoot === null
      ? []
      : [
          { path: joinPath(input.projectRoot, '.claude/settings.json'), layer: 'project' as const },
          { path: joinPath(input.projectRoot, '.claude/settings.local.json'), layer: 'project' as const },
          { path: joinPath(input.projectRoot, 'cowcat.json'), layer: 'project' as const },
        ]),
  ];

  const hooks: ConfiguredHook[] = [];
  const inert: string[] = [];
  let loaded = 0;
  let skippedUntrusted = 0;
  for (const candidate of candidates) {
    if (candidate.layer === 'project' && !input.trusted) {
      skippedUntrusted += 1;
      continue;
    }
    const text = await readTextFile(candidate.path);
    if (text === null) continue;
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      inert.push(`${candidate.path}: 不是合法 JSON，hooks 段忽略`);
      continue;
    }
    const section = typeof document === 'object' && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>).hooks
      : undefined;
    if (section === undefined) continue;
    const parsed = parseHookSection(section, candidate.path);
    hooks.push(...parsed.hooks);
    inert.push(...parsed.inert);
    loaded += 1;
  }
  return { parsed: { hooks, inert }, loaded, skippedUntrusted };
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
