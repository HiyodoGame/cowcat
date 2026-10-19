import { COMMANDS } from './spec.js';

const TAGLINE = 'headless 协议服务（`cowcat serve`）、一次性回合（`cowcat run`）与 TUI（T7 起）';

/**
 * Generated from the table, never hand-written (ADR-060): a help screen that drifts
 * from the commands it documents is worse than no help screen. Each verb's options come
 * from the same declaration the parser uses, for the same reason.
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
    for (const flag of command.flags ?? []) {
      const name = flag.value === undefined ? flag.name : `${flag.name} ${flag.value}`;
      lines.push(`      ${name.padEnd(width)}  ${flag.summary}`);
    }
  }
  lines.push(
    '',
    '选项：',
    '  -h, --help      显示这段帮助',
    '  -v, --version   显示版本',
    '  --              它之后的都当参数，不再当选项（提示词以 - 开头时用得到）',
    '',
    '环境：COWCAT_HOME 重定位状态目录（默认 ~/.cowcat；只移动文件，不改变任何策略值）',
  );
  lines.push('', '每个命令都是平的，没有嵌套子命令（ADR-060）。');
  return lines.join('\n');
}
