import type { AgentView } from '../app/view.js';
import { truncate } from '../text/width.js';
import { line } from '../ui/line.js';
import { panelBlock, textBlock, type SceneNode } from '../ui/scene.js';

export function agentPanel(agents: readonly AgentView[], width: number, now: number): SceneNode {
  return panelBlock({
    key: 'agents', title: `子 agent ${String(agents.length)} 个运行中`, tone: 'brand',
    children: [textBlock('items', agents.map((agent) => {
      const seconds = Math.max(0, Math.round((now - agent.startedAt) / 1000));
      const elapsed = seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s` : `${String(seconds)}s`;
      const turns = agent.turns > 0 ? ` · ${String(agent.turns)} 轮` : '';
      const description = agent.description === '' ? '子任务' : agent.description;
      return line(truncate(`${agent.role} · ${description}${turns} · ${elapsed}`, Math.max(8, width - 6)), 'act');
    }))],
  });
}
