import type { WireDelta, WireEvent } from '@corescense/cowcat-protocol';
import { copyFor } from './copy.js';
import { flag, number, read, record, records, text, updateSeq, updateType } from './fields.js';
import { withLangFrom, withAttachment, type ApprovalView, type Entry, type TodoView, type ToolCallView, type TuiView } from './view.js';

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
      const opened = add(withLangFrom(base, input), { kind: 'user', seq, text: input });
      return {
        ...opened,
        streaming: '',
        turn: { id: text(event, 'turnId') ?? '', state: 'opened', reason: null },
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
        },
        // A question cannot outlive the turn that asked it, and neither can a half-sent
        // answer: both are cleared by the terminal transition that makes them stale.
        approval: done ? null : base.approval,
        streaming: done ? '' : base.streaming,
      };
    }

    case 'turn.noted': {
      // The fact is durable (ADR-093) but it reads as a notice: it is not part of the
      // assistant's answer, and putting it in the transcript's message half would make a
      // replay look like the model said it.
      const message = text(event, 'message') ?? '';
      return message === '' ? base : add(base, notice(base, seq, 'warn', message));
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
      const next: TuiView = { ...base, streaming: '', calls: withCalls(base.calls, toolCalls) };
      if (content !== '') {
        return add(next, {
          kind: 'assistant',
          seq,
          text: content,
          calls: toolCalls.length,
          reasoning: thinking,
          redactedThinking: redacted,
        });
      }
      // An empty answer with calls is normal — the calls ARE the answer. An empty answer
      // with nothing at all is worth a line, or the turn looks like it did nothing.
      if (toolCalls.length === 0) return add(next, notice(next, seq, 'info', copyFor(next.lang).empty));
      return next;
    }

    case 'model.usage': {
      const usage = record(event, 'usage');
      if (usage === null) return base;
      return {
        ...base,
        usage: { input: number(usage, 'input') ?? 0, output: number(usage, 'output') ?? 0 },
      };
    }

    case 'tool.finished': {
      // The reference, not the bytes (ADR-057): record what the card will need to ask for.
      const attachments = records(event, 'attachments');
      const withImages =
        attachments.length === 0 ? base : attachments.reduce(upsertAttachment, base);
      return add(withImages, {
        kind: 'tool',
        seq,
        callId: text(event, 'callId') ?? '',
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
      });
    }

    case 'approval.requested': {
      const approval: ApprovalView = {
        callId: text(event, 'callId') ?? '',
        name: text(event, 'name') ?? '(unnamed)',
        rule: text(event, 'rule') ?? '(unnamed rule)',
        reason: text(event, 'reason'),
        warning: text(event, 'warning'),
        askedAt: number(event, 'ts') ?? 0,
        verdict: null,
        by: null,
      };
      return { ...base, approval };
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
      return add(base, notice(base, seq, 'info', copyFor(base.lang).compacted.replace('{n}', String(dropped))));
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

    case 'policy.decided':
      // Deliberately silent: the verdict reaches the transcript through the result it
      // produced ("denied by <rule>: <reason>"), and repeating it would print every
      // allowed read twice.
      return base;

    case 'subagent.started':
      // One line, and it arrives when the delegation ENDS: a row that appears and never
      // resolves reads worse than one that shows up with its result (ADR-079 ①). The
      // started fact is still in the log for an audit that wants the timing.
      return base;

    case 'subagent.finished': {
      const done = flag(event, 'ok') === true;
      const template = done ? copyFor(base.lang).subagentDone : copyFor(base.lang).subagentFailed;
      const line = template
        .replace('{session}', text(event, 'childSessionId') ?? '?')
        .replace('{role}', text(event, 'role') ?? '?')
        .replace('{n}', String(number(event, 'turns') ?? 0));
      return add(base, notice(base, seq, done ? 'info' : 'warn', line));
    }

    default:
      return unsupported(base, updateType(event) ?? 'unknown');
  }
}

/** A streamed token, applied to the ephemeral half of the view. */
export function streamText(view: TuiView, delta: WireDelta): TuiView {
  return { ...view, streaming: view.streaming + delta.text };
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
  return { ...view, closed: true };
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
