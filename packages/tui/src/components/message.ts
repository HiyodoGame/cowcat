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
  // A cron-fired turn is unattended (ADR-142): the marker says who started it and what the
  // model cannot do, so a refused write later in the card never reads as the model acting up.
  const cronRow =
    entry.cron === true
      ? [{ text: '⏰ 定时任务触发（无人值守：不能询问审批，做不了会报告）', token: 'textDim' as const }]
      : [];
  return card({
    title: entry.cron === true ? '⏰' : '你',
    titleToken: 'user',
    body: [...cronRow, ...wrap(text, width - 4).map((row) => ({ text: row, token: 'user' as const }))],
    width,
  });
}

export function assistantMessageLines(
  entry: AssistantEntry,
  width: number,
  thinkingExpanded: boolean,
): readonly Line[] {
  const lines: Line[] = [];
  const blocks = entry.reasoning.length + entry.redactedThinking;
  if (blocks > 0) {
    // Collapsed by default: thinking is how the answer was reached, not the answer. The
    // count is the only thing that tells the reader whether expanding is worth a screen.
    const label = thinkingExpanded
      ? `  ▾ 思考 · ${String(blocks)} 段（Ctrl-T 折叠）`
      : `  ▸ 思考 · ${String(blocks)} 段（Ctrl-T 展开）`;
    lines.push(...wrap(label, width).map((row) => line(row, 'textDim', false, 'thinking')));
    if (thinkingExpanded) {
      for (const block of entry.reasoning) {
        lines.push(...wrap(block, width - 4).map((row) => line(`  │ ${row}`, 'textDim')));
      }
      if (entry.redactedThinking > 0) {
        lines.push(
          ...wrap(`  │ （${String(entry.redactedThinking)} 段已隐藏的思考）`, width).map((row) => line(row, 'textDim')),
        );
      }
    }
  }
  lines.push(...wrap(entry.text, width).map((row) => line(row, 'assistant')));
  if (entry.calls > 0) {
    // A fact the log has and the screen would otherwise lose: the calls below are drawn as
    // their own cards, and the answer itself arrived with them.
    lines.push(line(`  （这一轮还带了 ${String(entry.calls)} 个工具调用）`, 'textDim'));
  }
  return lines;
}
