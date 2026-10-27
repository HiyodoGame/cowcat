import type { WireDelta, WireEvent } from '@corescense/cowcat-protocol';
import { graphemes } from '../text/width.js';
import { copyFor } from './copy.js';
import { flag, number, read, record, records, text, texts, updateSeq, updateType } from './fields.js';
import { rememberInput, withLangFrom, withAttachment, type AgentView, type ApprovalView, type BackgroundTaskState, type BackgroundTaskView, type CronJobView, type Entry, type PlanCardOption, type PlanView, type TodoView, type ToolCallView, type TuiView } from './view.js';
import { noteBelow } from './view.js';

/**
 * The pure function the whole frontend is built on (ADR-059 ②, ADR-066 ②).
 *
 * `project(view, event)` derives the screen from the log, and from nothing else: no clock,
 * no randomness, no transport. Feed it the same log twice and you get the same view, which
 * is why a frame snapshot can be a test — and why "the log is the truth" survives the trip
 * to a renderer (the v1 TUI read kernel state directly, and the screen, the log and what
 * the model saw could disagree).
 *
 * Two rules it follows from the protocol's own contract:
 *
 *   * **an event this build does not know is displayed as unsupported, once.** The
 *     envelope is validated and the body is passed through (ADR-055), so a newer kernel is
 *     not an error — but silently dropping a fact is how a user concludes the tool never
 *     ran.
 *   * **deltas never reach it.** `model.delta` is ephemeral display, not state: it goes
 *     through `streamText` and is dropped by the event that replaces it (`model.message`),
 *     so a replay from the log cannot depend on having seen a token arrive.
 */
export function project(view: TuiView, event: WireEvent): TuiView {
  const seq = updateSeq(event) ?? view.lastSeq;
  const base: TuiView = seq > view.lastSeq ? { ...view, lastSeq: seq } : view;

  switch (updateType(event)) {
    case 'session.opened': {
      return { ...base, sessionId: text(event, 'sessionId') ?? base.sessionId };
    }

    case 'turn.opened': {
      const input = text(event, 'input') ?? '';
      const turnId = text(event, 'turnId') ?? '';
      // A turn a cron fire opened carries the marker (ADR-142 ④): the fired event named
      // this id first. The pending entry is consumed; the id stays for the session.
      const cronSourced = base.cronPendingTurns.includes(turnId);
      const opened = rememberInput(add(withLangFrom(base, input), { kind: 'user', seq, text: input, ...(cronSourced ? { cron: true as const } : {}) }), input);
      return {
        ...opened,
        streaming: '',
        turn: { id: turnId, state: 'opened', reason: null, cronSourced },
        cronPendingTurns: cronSourced ? base.cronPendingTurns.filter((id) => id !== turnId) : base.cronPendingTurns,
        cronTurnIds: cronSourced && !base.cronTurnIds.includes(turnId) ? [...base.cronTurnIds, turnId] : base.cronTurnIds,
        model: text(event, 'model') ?? base.model,
        // The fallback is for a log that says nothing (an older kernel, or a preset with no
        // window). A live host builds its preset once, so a session cannot change windows
        // mid-flight; if that ever changes, this line has to stop inheriting.
        contextWindow: number(event, 'contextWindow') ?? base.contextWindow,
        // The meter's price source (ADR-131 2): absent on older logs and unpriced
        // presets, and then the bar shows tokens without a cost line.
        price: ((): TuiView['price'] => {
          const price = record(event, 'price');
          if (price === null) return base.price;
          const cacheRead = number(price, 'cacheRead');
          const cacheCreation = number(price, 'cacheCreation');
          const table: TuiView['price'] = {
            input: number(price, 'input') ?? 0,
            output: number(price, 'output') ?? 0,
            ...(cacheRead === null ? {} : { cacheRead }),
            ...(cacheCreation === null ? {} : { cacheCreation }),
          };
          return table;
        })(),
        turnStartedAt: number(event, 'ts') ?? base.turnStartedAt,
        slashIndex: 0,
        // A new turn cannot have output from the previous one attached to it.
        toolOutput: {},
      };
    }

    case 'turn.transitioned': {
      const to = text(event, 'to') ?? 'unknown';
      const done = TERMINAL.has(to);
      return {
        ...base,
        turn: {
          id: text(event, 'turnId') ?? base.turn?.id ?? '',
          state: to,
          reason: text(event, 'reason'),
          cronSourced: base.turn?.cronSourced ?? base.cronTurnIds.includes(text(event, 'turnId') ?? ''),
        },
        // A question cannot outlive the turn that asked it, and neither can a half-sent
        // answer: both are cleared by the terminal transition that makes them stale.
        approval: done ? null : base.approval,
        plan: done ? null : base.plan,
        streaming: done ? '' : base.streaming,
        // No tool of a finished turn is still running, whatever the log's last word was.
        pendingTools: done ? [] : base.pendingTools,
        // Its live tail is a view of a call that no longer exists; the durable output is in
        // the transcript already.
        toolOutput: done ? {} : base.toolOutput,
      };
    }

    case 'turn.noted': {
      // The fact is durable (ADR-093) but it reads as a notice: it is not part of the
      // assistant's answer, and putting it in the transcript's message half would make a
      // replay look like the model said it.
      const message = text(event, 'message') ?? '';
      return message === '' ? base : noteBelow(add(base, notice(base, seq, 'warn', message)));
    }

    case 'model.message': {
      const content = text(event, 'text') ?? '';
      const toolCalls = records(event, 'toolCalls');
      const reasoning = records(event, 'reasoning');
      const thinking: string[] = [];
      let redacted = 0;
      for (const block of reasoning) {
        if (text(block, 'type') === 'thinking') {
          const value = text(block, 'text');
          if (value !== null && value.trim() !== '') thinking.push(value);
        } else if (text(block, 'type') === 'redacted') {
          redacted += 1;
        }
      }
      const next: TuiView = {
        ...base,
        streaming: '',
        // The live reasoning is replaced by the blocks on the entry, and a finished turn
        // starts collapsed: "watch it think" is the streaming state, not the result.
        reasoningStream: '',
        reasoningShown: 0,
        thinkingExpanded: false,
        calls: withCalls(base.calls, toolCalls),
        // The calls this message asked for are now in flight; the status line names them
        // until each result arrives. Without this, "Bash is running" had nothing to show.
        pendingTools: toolCalls
          .map((call) => ({ callId: text(call, 'callId') ?? '', name: text(call, 'name') ?? '(unnamed)' }))
          .filter((tool) => tool.callId !== ''),
      };
      if (content !== '') {
        return noteBelow(
          add(next, {
            kind: 'assistant',
            seq,
            text: content,
            calls: toolCalls.length,
            reasoning: thinking,
            redactedThinking: redacted,
          }),
        );
      }
      // An empty answer with calls is normal — the calls ARE the answer. An empty answer
      // with nothing at all is worth a line, or the turn looks like it did nothing.
      if (toolCalls.length === 0) return add(next, notice(next, seq, 'info', copyFor(next.lang).empty));
      return next;
    }

    case 'model.usage': {
      const usage = record(event, 'usage');
      if (usage === null) return base;
      const round = {
        input: number(usage, 'input') ?? 0,
        output: number(usage, 'output') ?? 0,
        cacheRead: number(usage, 'cacheRead') ?? 0,
        cacheCreation: number(usage, 'cacheCreation') ?? 0,
      };
      const invocation = text(event, 'invocation');
      const previous =
        invocation !== null && base.usageInvocation === invocation && base.usage !== null
          ? base.usage
          : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      return {
        ...base,
        usage: round,
        usageInvocation: invocation,
        // Cumulative reports from one call replace; a different invocation accumulates (ADR-169).
        usageTotals: {
          input: base.usageTotals.input - previous.input + round.input,
          output: base.usageTotals.output - previous.output + round.output,
          cacheRead: base.usageTotals.cacheRead - previous.cacheRead + round.cacheRead,
          cacheCreation: base.usageTotals.cacheCreation - previous.cacheCreation + round.cacheCreation,
        },
      };
    }

    case 'tool.finished': {
      // The reference, not the bytes (ADR-057): record what the card will need to ask for.
      const attachments = records(event, 'attachments');
      const callId = text(event, 'callId') ?? '';
      const withImages = attachments.length === 0 ? base : attachments.reduce(upsertAttachment, base);
      const cleared: TuiView = {
        ...withImages,
        pendingTools: withImages.pendingTools.filter((tool) => tool.callId !== callId),
        // The durable output below replaces the live tail; keeping both would print it twice.
        toolOutput: withoutToolOutput(withImages.toolOutput, callId),
      };
      return noteBelow(
        add(cleared, {
          kind: 'tool',
          seq,
          callId,
        name: text(event, 'name') ?? '(unnamed)',
        ok: flag(event, 'ok') === true,
        output: text(event, 'output') ?? '',
        truncation: truncationOf(event),
        // References only; the bytes stay on disk and are fetched with `attachment.read`
        // when a renderer actually wants to show them (ADR-057).
        attachments: attachments
          .map((attachment) => text(attachment, 'path'))
          .filter((path): path is string => path !== null && path !== ''),
        path: text(event, 'path'),
        }),
      );
    }

    case 'approval.requested': {
      const approval: ApprovalView = {
        callId: text(event, 'callId') ?? '',
        name: text(event, 'name') ?? '(unnamed)',
        rule: text(event, 'rule') ?? '(unnamed rule)',
        reason: text(event, 'reason'),
        warning: text(event, 'warning'),
        // The exact subject under review (ADR-129 7): what an answer grants, in the
        // same words the grant key is computed from. Older logs asked without it.
        command: text(event, 'command'),
        path: text(event, 'path'),
        dimensions: texts(event, 'dimensions'),
        askedAt: number(event, 'ts') ?? 0,
        verdict: null,
        by: null,
      };
      // A question owns the keyboard: the task panel (and the `/` menu) close rather than
      // leaving arrows with two possible meanings (ADR-113). Cards are mutually exclusive
      // in the kernel (serial calls); the symmetric clearing keeps a replay honest if a
      // log ever interleaves them anyway (review of #167, P2-8).
      return { ...base, approval, approvalCursor: 0, taskPanel: null, plan: null };
    }

    case 'approval.answered': {
      const callId = text(event, 'callId') ?? '';
      if (base.approval === null || base.approval.callId !== callId) return base;
      return {
        ...base,
        approval: {
          ...base.approval,
          verdict: text(event, 'verdict') ?? 'unknown',
          by: text(event, 'by') ?? 'unknown',
        },
      };
    }

    case 'todo.updated': {
      // Wholesale replacement, which is the kernel's semantics too (ADR-054): what the
      // model sent is the complete new list, not a delta to merge.
      return { ...base, todos: records(event, 'todos').map(todoOf) };
    }

    case 'context.compacted': {
      // One line, no summary body: the summary is what the *model* reads, and it is
      // already in the history. Collapsed by default matches §4.2 of the brand guide
      // (ADR-074); there is no "open it" affordance yet.
      const dropped = number(event, 'dropped') ?? 0;
      const shown = add(base, notice(base, seq, 'info', copyFor(base.lang).compacted.replace('{n}', String(dropped))));
      // The old count described the history that was just replaced: keeping it would say
      // "94%" about a context that is now much smaller. Nothing is known again until the
      // next `model.usage` reports on the new prompt (ADR-105 ②).
      return { ...shown, usage: null, usageInvocation: null };
    }

    case 'context.compaction.started':
    case 'context.compaction.finished':
      // The lock's edges are plumbing, not transcript material.
      return base;

    case 'instructions.loaded':
      // Project instructions are context, not conversation: the transcript does not
      // reprint AGENTS.md. The event exists so a replay shows what the model was told
      // (ADR-078), not so the terminal repeats it.
      return base;

    case 'hooks.context-added':
      // Same silence for the same reason: hook context is what the model was told, not
      // something it said (ADR-122 ④).
      return base;

    case 'plan.mode-changed': {
      const on = flag(event, 'enabled') === true;
      const line = on ? copyFor(base.lang).planModeOn : copyFor(base.lang).planModeOff;
      return add({ ...base, planMode: on }, notice(base, seq, 'info', line));
    }

    case 'accept-edits.mode-changed': {
      // ADR-159: a user act folded from the log, same shape as plan mode's toggle. The
      // notice states the exact scope — Write/Edit only — because "auto-accept" that
      // silently covers Bash would be a lie with teeth.
      const on = flag(event, 'enabled') === true;
      const line = on ? copyFor(base.lang).acceptEditsOn : copyFor(base.lang).acceptEditsOff;
      return add({ ...base, acceptEdits: on }, notice(base, seq, 'info', line));
    }

    case 'plan.proposed': {
      const plans: PlanCardOption[] = records(event, 'plans').map((raw) => ({
        title: text(raw, 'title') ?? '?',
        summary: text(raw, 'summary') ?? '',
      }));
      const plan: PlanView = {
        callId: text(event, 'callId') ?? '',
        plans,
      };
      // A review owns the keyboard exactly like an approval question (ADR-125 ③).
      return { ...base, plan, planCursor: 0, approval: null, taskPanel: null };
    }

    case 'plan.decided': {
      const callId = text(event, 'callId') ?? '';
      if (base.plan === null || base.plan.callId !== callId) return base;
      const choice = number(event, 'choice');
      const line =
        choice === null
          ? copyFor(base.lang).planRejected
          : copyFor(base.lang).planChosen.replace('{n}', String(choice + 1));
      return add({ ...base, plan: null }, notice(base, seq, 'info', line));
    }

    case 'skills.loaded': {
      // Same silence in the transcript, but the list is kept for `/skills`: which skills
      // the model was offered is the one question a user asks when it ignores theirs.
      const skills = records(event, 'skills').map((entry) => ({
        name: text(entry, 'name') ?? '?',
        layer: text(entry, 'layer') === 'project' ? ('project' as const) : ('user' as const),
        origin: text(entry, 'origin') === 'claude' ? ('claude' as const) : ('cowcat' as const),
      }));
      return { ...base, skills };
    }

    case 'policy.decided':
      // Deliberately silent: the verdict reaches the transcript through the result it
      // produced ("denied by <rule>: <reason>"), and repeating it would print every
      // allowed read twice.
      return base;

    case 'tool.repeat-detected': {
      // The model-visible nudge, shown to the user too: a repeat loop is exactly the
      // moment they want to glance over (ADR-120).
      const line = copyFor(base.lang)
        .repeatReminder.replace('{name}', text(event, 'name') ?? '?')
        .replace('{n}', String(number(event, 'count') ?? 2));
      return add(base, notice(base, seq, 'warn', line));
    }

    case 'subagent.started': {
      const childSessionId = text(event, 'childSessionId') ?? '';
      if (childSessionId === '') return base;
      return {
        ...base,
        agents: [
          ...base.agents,
          {
            childSessionId,
            role: text(event, 'role') ?? '?',
            description: text(event, 'description') ?? '',
            state: 'running',
            turns: 0,
            startedAt: number(event, 'ts') ?? 0,
          },
        ],
      };
    }

    case 'subagent.finished': {
      const done = flag(event, 'ok') === true;
      const childSessionId = text(event, 'childSessionId') ?? '?';
      const ended = text(event, 'state');
      const state: AgentView['state'] =
        ended === 'completed' || ended === 'failed' || ended === 'cancelled' ? ended : done ? 'completed' : 'failed';
      const agents = base.agents.map((agent) =>
        agent.childSessionId === childSessionId
          ? {
              ...agent,
              state,
              turns: number(event, 'turns') ?? agent.turns,
            }
          : agent,
      );
      const template = done ? copyFor(base.lang).subagentDone : copyFor(base.lang).subagentFailed;
      const line = template
        .replace('{session}', childSessionId)
        .replace('{role}', text(event, 'role') ?? '?')
        .replace('{n}', String(number(event, 'turns') ?? 0));
      return add({ ...base, agents }, notice(base, seq, done ? 'info' : 'warn', line));
    }

    case 'tool.background.started': {
      const taskId = text(event, 'taskId');
      const callId = text(event, 'callId');
      if (taskId === null || callId === null) return base;
      // A replayed start has no end after it: the host that knew is not necessarily this
      // one, so the honest word is `unknown`, not "still running" (ADR-113).
      const state: BackgroundTaskState = seq <= base.replayedThrough ? 'unknown' : 'running';
      const task: BackgroundTaskView = {
        taskId,
        callId,
        command: text(event, 'command') ?? '',
        startedAt: number(event, 'ts') ?? 0,
        startedSeq: seq,
        state,
        endedAt: null,
        exitCode: null,
      };
      return { ...base, tasks: [task, ...base.tasks.filter((entry) => entry.taskId !== taskId)] };
    }

    case 'tool.background.finished': {
      const taskId = text(event, 'taskId');
      if (taskId === null) return base;
      const reported = text(event, 'state');
      const state: BackgroundTaskState =
        reported === 'exited' || reported === 'stopped' || reported === 'lost' ? reported : 'unknown';
      const endedAt = number(event, 'ts');
      const exitCode = number(event, 'exitCode');
      const existing = base.tasks.find((entry) => entry.taskId === taskId);
      if (existing === undefined) {
        // No start in this log (replay began mid-history, or a start this build never saw):
        // record the end rather than dropping a fact the host did write.
        return {
          ...base,
          tasks: [
            {
              taskId,
              callId: text(event, 'callId') ?? '',
              command: '',
              startedAt: endedAt ?? 0,
              startedSeq: seq,
              state,
              endedAt,
              exitCode,
            },
            ...base.tasks,
          ],
        };
      }
      return {
        ...base,
        tasks: base.tasks.map((entry) => (entry.taskId === taskId ? { ...entry, state, endedAt, exitCode } : entry)),
      };
    }

    case 'cron.created': {
      const jobId = text(event, 'jobId');
      if (jobId === null) return base;
      const job: CronJobView = {
        jobId,
        schedule: text(event, 'schedule') ?? '',
        prompt: text(event, 'prompt') ?? '',
        recurring: flag(event, 'recurring') ?? false,
        createdAt: number(event, 'createdAt') ?? 0,
        nextRun: null,
        lastFiredAt: null,
      };
      return { ...base, cronJobs: [job, ...base.cronJobs.filter((entry) => entry.jobId !== jobId)] };
    }

    case 'cron.deleted': {
      const jobId = text(event, 'jobId');
      if (jobId === null) return base;
      return { ...base, cronJobs: base.cronJobs.filter((entry) => entry.jobId !== jobId) };
    }

    case 'cron.fired': {
      const jobId = text(event, 'jobId');
      const turnId = text(event, 'turnId');
      const firedAt = number(event, 'firedAt');
      // The fired event names the turn before it opens (ADR-140 ②); the pending id is
      // consumed by that turn's `turn.opened`. A one-shot's terminal state is the fire
      // itself — the fold drops it without a deleted event (ADR-141 ④).
      const pending = turnId === null ? base.cronPendingTurns : [...base.cronPendingTurns, turnId];
      if (jobId === null) return { ...base, cronPendingTurns: pending };
      const existing = base.cronJobs.find((entry) => entry.jobId === jobId);
      if (existing === undefined) return { ...base, cronPendingTurns: pending };
      if (!existing.recurring) {
        return { ...base, cronPendingTurns: pending, cronJobs: base.cronJobs.filter((entry) => entry.jobId !== jobId) };
      }
      return {
        ...base,
        cronPendingTurns: pending,
        cronJobs: base.cronJobs.map((entry) => (entry.jobId === jobId ? { ...entry, lastFiredAt: firedAt } : entry)),
      };
    }

    case 'file.changed':
    case 'file.reverted':
    case 'file.restored':
    case 'approval.revoked':
      return base;

    default:
      return unsupported(base, updateType(event) ?? 'unknown');
  }
}

/** A streamed token, applied to the ephemeral half of the view. */
export function streamText(view: TuiView, delta: WireDelta): TuiView {
  if (delta.type !== 'model.delta') return view;
  return { ...view, streaming: view.streaming + delta.text };
}

/** A streamed reasoning fragment: shown while it happens, replaced by the final blocks. */
export function streamReasoning(view: TuiView, delta: WireDelta): TuiView {
  if (delta.type !== 'reasoning.delta') return view;
  return { ...view, reasoningStream: view.reasoningStream + delta.text };
}

/** How much live output a running card keeps. Display only: the log has the real tail (ADR-109). */
const LIVE_TOOL_TAIL_CHARS = 4_000;

/**
 * A live fragment of a running tool's output (ADR-109).
 *
 * Two filters, both about not lying on screen: the fragment must belong to a call this view
 * is still showing (a late delta after `tool.finished` must not resurrect a card), and the
 * kept tail is capped — the screen shows the last few KB while the durable output keeps its
 * own cap in the kernel.
 */
export function streamToolOutput(view: TuiView, delta: WireDelta): TuiView {
  if (delta.type !== 'tool.output.delta') return view;
  const callId = text(delta, 'callId');
  const chunk = text(delta, 'text') ?? '';
  if (callId === null || chunk === '') return view;
  if (!view.pendingTools.some((tool) => tool.callId === callId)) return view;

  const previous = view.toolOutput[callId];
  const joined = (previous?.text ?? '') + chunk;
  // Fast path: a UTF-16 length under the cap implies a grapheme count under it too.
  const kept =
    joined.length <= LIVE_TOOL_TAIL_CHARS
      ? { text: joined, truncated: previous?.truncated ?? false }
      : // Whole grapheme clusters, not code units: cutting a ZWJ emoji or a combining mark in
        // half paints a replacement character at the top of the card (ADR-109).
        { text: graphemes(joined).slice(-LIVE_TOOL_TAIL_CHARS).join(''), truncated: true };
  return { ...view, toolOutput: { ...view.toolOutput, [callId]: kept } };
}

/** Drop one call's live tail, leaving the others (a turn can run several tools). */
function withoutToolOutput(outputs: TuiView['toolOutput'], callId: string): TuiView['toolOutput'] {
  if (outputs[callId] === undefined) return outputs;
  return Object.fromEntries(Object.entries(outputs).filter(([key]) => key !== callId));
}

/**
 * A line the interface itself wants to say — a server diagnostic, a refusal the host
 * reported, a hint about which keys answer an approval.
 *
 * It is not a session fact, so it does not come from the log: `06-frontend.md` keeps the
 * three channels apart (`event` = durable, `delta` = ephemeral display, `log` = the server's
 * own diagnostics), and this is where the third one and the app's own hints land. Its `seq`
 * is the current head, because there is no event to inherit one from — nothing re-derives
 * these on a replay, which is exactly right for something the log never carried.
 */
export function addNotice(view: TuiView, level: 'info' | 'warn' | 'error', text: string): TuiView {
  return add(view, notice(view, view.lastSeq, level, text));
}

/** The transport went away. The view stays as it is — it just cannot grow. */
export function closeView(view: TuiView): TuiView {
  // A running background task is only known to be running while the host can still say so;
  // with the transport gone, "unknown" is the truthful label (ADR-113).
  const tasks = view.tasks.map((task) =>
    task.state === 'running' ? { ...task, state: 'unknown' as const } : task,
  );
  return { ...view, closed: true, tasks };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** `ToolResult.truncation` (ADR-048) in words, or `null` when nothing was dropped. */
function truncationOf(event: WireEvent): string | null {
  const truncation = record(event, 'truncation');
  if (truncation === null || flag(truncation, 'truncated') !== true) return null;
  return text(truncation, 'reason') ?? 'truncated';
}

function todoOf(entry: Record<string, unknown>): TodoView {
  return {
    content: text(entry, 'content') ?? '',
    status: text(entry, 'status') ?? 'pending',
    activeForm: text(entry, 'activeForm') ?? '',
  };
}

/** One attachment reference from a result becomes a record waiting for its bytes. */
function upsertAttachment(view: TuiView, entry: Record<string, unknown>): TuiView {
  const path = text(entry, 'path');
  if (path === null || path === '') return view;
  return withAttachment(view, {
    path,
    mediaType: text(entry, 'mediaType') ?? 'application/octet-stream',
    width: number(entry, 'width'),
    height: number(entry, 'height'),
    pages: number(entry, 'pages'),
    status: 'loading',
    bytes: null,
    reason: null,
  });
}

/** Fold the model's tool calls into the view's map, keeping the order they arrived in. */
function withCalls(
  known: Readonly<Record<string, ToolCallView>>,
  calls: readonly Record<string, unknown>[],
): Readonly<Record<string, ToolCallView>> {
  if (calls.length === 0) return known;
  const merged = { ...known };
  for (const call of calls) {
    const callId = text(call, 'callId');
    if (callId === null || callId === '') continue;
    merged[callId] = { name: text(call, 'name') ?? '(unnamed)', input: read(call, 'input') };
  }
  return merged;
}

function add(view: TuiView, entry: Entry): TuiView {
  return { ...view, entries: [...view.entries, entry] };
}

function notice(view: TuiView, seq: number, level: 'info' | 'warn' | 'error', line: string): Entry {
  return { kind: 'notice', seq, level, text: line };
}

/**
 * The first sighting of an unknown event type earns a line in the transcript; the rest earn
 * nothing. A new kernel event that fires per streamed chunk would otherwise turn a working
 * session into a wall of "(an event this build does not know)".
 */
function unsupported(view: TuiView, type: string): TuiView {
  if (view.unsupported.includes(type)) return view;
  return add(
    { ...view, unsupported: [...view.unsupported, type] },
    notice(view, view.lastSeq, 'warn', `${copyFor(view.lang).unsupportedEvent}: ${type}`),
  );
}
