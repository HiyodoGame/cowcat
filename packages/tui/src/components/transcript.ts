import type { Entry } from '../app/view.js';
import type { TuiView } from '../app/view.js';
import { copyFor } from '../app/copy.js';
import { block, line, marked, tail, type Line } from '../ui/line.js';

/**
 * The transcript: the entries of the view model as lines (T7's version of the cards T8
 * builds).
 *
 * What it is NOT is a layout engine. Every line it emits is text plus a token, and the
 * renderer wraps whatever is too wide — which is why this file has no width table in it.
 * Where a width table IS needed is alignment the model and the tools produce (columns that
 * must line up), and that is the brand guide's "模型侧与工具输出侧的对齐不归 opentui 管"
 * (ADR-056) — T8's problem, with the tool cards.
 *
 * The markers are deliberately plain and few, because T8 replaces them with the guide's
 * cards (`❯`/`⏺` are placeholders that survive a snapshot, not a visual language):
 *
 *   `❯` the user speaking      `⏺` a tool call          `·`/`!` a notice
 *   (none) the agent speaking — the body of the conversation, in the brand green
 */
export function transcriptLines(view: TuiView): readonly Line[] {
  const lines: Line[] = [];
  for (const entry of view.entries) lines.push(...entryLines(entry));
  // The live half: streamed text that no event has replaced yet. Rendered like the
  // assistant's own words, because that is what it is about to become.
  if (view.streaming !== '') lines.push(...marked(view.streaming, '', 'assistant'));
  return lines;
}

function entryLines(entry: Entry): readonly Line[] {
  switch (entry.kind) {
    case 'user':
      return marked(entry.text, '❯ ', 'user', '  ', true);

    case 'assistant': {
      const lines = marked(entry.text, '', 'assistant');
      // "this answer came with N tool calls" — a fact the log has and the screen would
      // otherwise lose, since the calls are drawn as their own entries below.
      return entry.calls === 0
        ? lines
        : [...lines, line(`  （这一轮还带了 ${String(entry.calls)} 个工具调用）`, 'textDim')];
    }

    case 'tool': {
      const status = entry.ok ? 'ok' : '失败';
      const where = entry.path === null ? '' : ` — ${entry.path}`;
      const lines: Line[] = [line(`⏺ ${entry.name} ${status}${where}`, entry.ok ? 'tool' : 'alert', true)];
      if (entry.attachments.length > 0) {
        lines.push(line(`  ${copyFor('zh').attachment} ×${String(entry.attachments.length)}：${entry.attachments.join(' ')}`, 'textDim'));
      }
      if (entry.truncation !== null) lines.push(line(`  ${entry.truncation}`, 'textDim'));
      if (entry.output !== '') lines.push(...tail(entry.output, 'tool', 4, TOOL_OUTPUT_TAIL));
      return lines;
    }

    case 'notice':
      return block(entry.text, entry.level === 'error' ? 'alert' : entry.level === 'warn' ? 'notice' : 'textDim', 0, false).map(
        (row, index) => (index === 0 ? line(`${entry.level === 'info' ? '·' : '!'} ${row.text}`, row.token) : row),
      );
  }
}

/** The brand guide's terminal-output rule: the exit status plus the last three lines. */
export const TOOL_OUTPUT_TAIL = 3;
