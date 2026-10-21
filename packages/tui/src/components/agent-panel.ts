import type { AgentView } from '../app/view.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The sub-agent panel: what is running under the turn, right now.
 *
 * Before this, a delegation was invisible until it finished (`subagent.finished` produced a
 * single notice), so a parent waiting on three children looked exactly like a parent waiting
 * on nothing. Finished children are not shown here: they already have their notice line, and
 * a panel that only grows would bury the running ones.
 */
export function agentPanelLines(agents: readonly AgentView[], width: number, now: number): readonly Line[] {
  if (agents.length === 0) return [];
  const inner = Math.max(0, width - 6);
  const body: CardBodyLine[] = agents.map((agent) => {
    const seconds = Math.max(0, Math.round((now - agent.startedAt) / 1000));
    const elapsed = seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
    const turns = agent.turns > 0 ? ` · ${String(agent.turns)} 轮` : '';
    const description = agent.description === '' ? '子任务' : agent.description;
    return {
      text: truncate(`▸ ${agent.role} · ${description}${turns} · ${elapsed}`, inner),
      token: 'act' as const,
    };
  });

  return card({
    title: `子 agent ${String(agents.length)} 个运行中`,
    titleToken: 'brand',
    body,
    width,
  });
}
