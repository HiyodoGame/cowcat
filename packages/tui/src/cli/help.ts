import { COMMANDS } from './spec.js';

const TAGLINE = 'headless 协议服务（`cowcat serve`）与 TUI（T7 起）';

/**
 * Generated from the table, never hand-written (ADR-060): a help screen that drifts
 * from the commands it documents is worse than no help screen.
 *
 * Blocked commands are marked. Listing them as if they worked is the same lie as a
 * host that answers an empty success.
 */
export function renderHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length));
  const lines = [`cowcat — ${TAGLINE}`, '', '用法：'];
  for (const command of COMMANDS) {
    const suffix = command.status === 'blocked' ? `  （尚未可用：${command.blockedBy}）` : '';
    lines.push(`  ${command.usage.padEnd(width)}  ${command.summary}${suffix}`);
  }
  lines.push('', '选项：', '  -h, --help      显示这段帮助', '  -v, --version   显示版本');
  lines.push('', '每个命令都是平的，没有嵌套子命令（ADR-060）。');
  return lines.join('\n');
}
