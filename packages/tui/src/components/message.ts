import type { AssistantEntry, UserEntry } from '../app/view.js';
import { card } from '../ui/card.js';
import { line, type Line } from '../ui/line.js';
import { wrap } from '../text/wrap.js';

/**
 * What the person said, and what the agent said back.
 *
 * The user's words get a card — the brand guide's `┌─ user ─┐` bubble — because a
 * conversation with two voices and no boundary is a wall of text. The agent's words get no
 * box: they are the body of the transcript, and boxing them would double the vertical cost
 * of every answer.
 */
export function userMessageLines(entry: UserEntry, width: number): readonly Line[] {
  const text = entry.text === '' ? '（空输入）' : entry.text;
  return card({
    title: '你',
    titleToken: 'user',
    body: wrap(text, width - 4).map((row) => ({ text: row, token: 'user' as const })),
    width,
  });
}

export function assistantMessageLines(entry: AssistantEntry, width: number): readonly Line[] {
  const lines: Line[] = wrap(entry.text, width).map((row) => line(row, 'assistant'));
  if (entry.calls > 0) {
    // A fact the log has and the screen would otherwise lose: the calls below are drawn as
    // their own cards, and the answer itself arrived with them.
    lines.push(line(`  （这一轮还带了 ${String(entry.calls)} 个工具调用）`, 'textDim'));
  }
  return lines;
}
