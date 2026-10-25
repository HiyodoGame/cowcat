import type { TuiView } from './view.js';

export function latestAssistantText(view: TuiView): string | null {
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index];
    if (entry?.kind === 'assistant' && entry.text !== '') return entry.text;
  }
  return null;
}

export function sessionMarkdown(view: TuiView): string {
  const lines = [`# CowCat 会话 ${view.sessionId ?? '未命名'}`, ''];
  for (const entry of view.entries) {
    switch (entry.kind) {
      case 'user':
        lines.push('## 你', '', entry.text, '');
        break;
      case 'assistant':
        lines.push('## CowCat', '', entry.text, '');
        break;
      case 'tool':
        lines.push(`### ${entry.name} ${entry.ok ? '成功' : '失败'}`, '', entry.path ?? '', '```text', entry.output, '```', '');
        break;
      case 'notice':
        lines.push(`> ${entry.text}`, '');
        break;
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function osc52(text: string): string {
  return `]52;c;${Buffer.from(text).toString('base64')}`;
}
