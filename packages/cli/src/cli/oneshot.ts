import { EXIT } from './exit.js';
import { flagOn, flagValue } from './flags.js';
import { buildHost } from './host.js';
import type { CommandContext } from './spec.js';
import { field, updateType } from './update.js';

/** How much of a tool's output is echoed to the terminal. The log keeps all of it. */
const PRINTED_OUTPUT_LINES = 30;

/**
 * `cowcat run "<prompt>"`: one turn, no terminal UI.
 *
 * It is a frontend, in the smallest possible sense: it attaches, prints what arrives, and
 * answers approvals. Nothing here is kernel knowledge — the three channels it reads are
 * the same ones a TUI reads (`model.delta` for live text, `event` for durable facts, and
 * the `respondApproval` port for questions) — which is exactly what makes this verb a
 * usable check that the composition root works end to end.
 *
 * ## The approval policy (ADR-065 ②)
 *
 * There is nobody to ask, so every question is answered immediately: `reject` by
 * default, `once` with `--yes`. Waiting for the kernel's five-minute timeout would be
 * the worst available behaviour — a hang, and then the same refusal. The refusals are
 * printed, and the model is told, so a read-only prompt works out of the box and a
 * mutating one says exactly what it was denied.
 */
export async function runOneShot(context: CommandContext): Promise<number> {
  const prompt = context.args[0] ?? '';
  const yes = flagOn(context.flags, 'yes');
  const wanted = flagValue(context.flags, 'session');

  const host = await buildHost(context, { unattended: true });
  if (host === null) return EXIT.failed;

  let unsubscribe: () => void = () => undefined;
  try {
    const sessionId = wanted ?? (await host.createSession(null)).sessionId;
    if (wanted === null) {
      context.stderr(`cowcat run: 新会话 ${sessionId}`);
      context.stderr(`          继续它：cowcat run --session ${sessionId} "<prompt>"`);
    }

    const attached = await host.attach(sessionId);
    if (wanted !== null) {
      context.stderr(`cowcat run: 已加载 ${String(attached.replay.length)} 条历史事件（不重复打印）`);
    }

    let sawDelta = false;
    const finished = new Promise<{ readonly outcome: string; readonly reason: string | null }>((resolve) => {
      unsubscribe = attached.subscribe((update) => {
        switch (updateType(update)) {
          case 'model.delta': {
            const text = field(update, 'text');
            if (typeof text === 'string' && text !== '') {
              sawDelta = true;
              context.write(text);
            }
            return;
          }
          case 'model.message': {
            // Only when nothing streamed: an adapter that does not stream (or an answer
            // that arrives in one chunk) would otherwise print nothing at all.
            if (!sawDelta) {
              const text = field(update, 'text');
              if (typeof text === 'string' && text !== '') context.write(text);
            }
            sawDelta = false;
            return;
          }
          case 'tool.finished': {
            const name = field(update, 'name');
            const ok = field(update, 'ok') === true;
            context.write(`\n→ ${String(name)} ${ok ? 'ok' : '失败'}\n`);
            const output = field(update, 'output');
            if (typeof output === 'string' && output !== '') context.write(indent(output));
            return;
          }
          case 'approval.requested': {
            const callId = field(update, 'callId');
            if (typeof callId !== 'string') return;
            const warning = field(update, 'warning');
            if (typeof warning === 'string' && warning !== '') context.stderr(`  ! ${warning}`);
            context.stderr(
              yes
                ? '  · 审批：放行（--yes）'
                : '  · 审批：拒绝（这个动词背后没有人可以问；用 --yes 放行，或改走 cowcat serve + 一个前端）',
            );
            host.respondApproval(sessionId, callId, yes ? 'once' : 'reject').catch((error: unknown) => {
              context.stderr(`  · 审批答案没能送达：${error instanceof Error ? error.message : String(error)}`);
            });
            return;
          }
          case 'turn.noted': {
            // A note is about the run, not about the answer: stderr keeps it out of a pipe.
            const message = field(update, 'message');
            if (typeof message === 'string' && message !== '') context.stderr(`cowcat run: ${message}`);
            return;
          }
          case 'turn.transitioned': {
            const to = field(update, 'to');
            if (to !== 'completed' && to !== 'failed' && to !== 'cancelled') return;
            const why = field(update, 'reason');
            resolve({ outcome: to, reason: typeof why === 'string' ? why : null });
            return;
          }
          default:
            return;
        }
      });
    });

    const { turnId } = await host.sendTurn(sessionId, prompt);
    const result = await finished;
    context.write('\n');
    if (result.outcome !== 'completed') {
      context.stderr(`cowcat run: 回合 ${turnId} 结束于 ${result.outcome}${result.reason === null ? '' : `：${result.reason}`}`);
      return EXIT.failed;
    }
    return EXIT.ok;
  } catch (error) {
    context.stderr(`cowcat run: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  } finally {
    unsubscribe();
    await host.close();
  }
}

/**
 * Tool output, indented and capped. The cap is a reading aid, not a truncation fact:
 * the session log holds the whole thing, and the line says so.
 */
function indent(text: string): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, PRINTED_OUTPUT_LINES);
  const rest = lines.length - shown.length;
  const body = shown.map((line) => `  ${line}`).join('\n');
  return rest <= 0 ? `${body}\n` : `${body}\n  …… 还有 ${String(rest)} 行（完整结果在会话日志里）\n`;
}
