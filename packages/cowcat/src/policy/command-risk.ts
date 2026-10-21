/**
 * What a command would cost if it went wrong (ADR-095).
 *
 * This is a **warning**, not a verdict: `decide` still says allow/ask/deny, and this
 * function never changes that. It exists because the approval card for
 * `pwd && ls -la` and for `wrangler pages project delete … --yes` was the same card —
 * same title, same `no-rule-matched`, same reason — so the only thing distinguishing an
 * irreversible remote deletion from a directory listing was the model's own prose.
 *
 * False positives are acceptable here and false negatives are not: a warning on a
 * harmless command costs a line, and a missing warning on a destructive one costs the
 * thing the user was protecting. Every pattern is therefore written to over-match
 * rather than to parse shell syntax (there is no shell parser in `policy/`, and a
 * half-parser that silently misses `rm  -rf` is worse than a regex that sometimes
 * cries wolf).
 */
export type CommandRisk = 'destructive' | 'remote-write' | 'privilege';

export interface CommandWarning {
  readonly risk: CommandRisk;
  /** One line, already in the user's language: the card shows it verbatim. */
  readonly message: string;
}

interface Rule {
  readonly risk: CommandRisk;
  readonly pattern: RegExp;
  readonly message: string;
}

const RULES: readonly Rule[] = [
  {
    risk: 'destructive',
    pattern: /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+/i,
    message: '删除文件且不可恢复（rm -r/-f）',
  },
  {
    risk: 'destructive',
    pattern: /git\s+reset\s+--hard/i,
    message: '丢弃工作区改动（git reset --hard）',
  },
  {
    risk: 'destructive',
    pattern: /git\s+clean\s+-[a-z]*f/i,
    message: '删除未跟踪文件（git clean -f）',
  },
  {
    risk: 'destructive',
    pattern: /\bproject[s]?\s+delete\b/i,
    message: '删除远端项目（不可逆，域名与部署历史随之消失）',
  },
  {
    risk: 'destructive',
    pattern: /\bdelete\b[^\n]*--yes\b/i,
    message: '删除远端资源且跳过确认（--yes）',
  },
  {
    risk: 'destructive',
    pattern: /\bdrop\s+(?:table|database|schema)\b/i,
    message: '删除数据库对象（DROP）',
  },
  {
    risk: 'remote-write',
    pattern: /git\s+push\b[^\n]*--force/i,
    message: '用远端分支覆盖历史（git push --force）',
  },
  {
    risk: 'remote-write',
    pattern: /\bnpm\s+publish\b/i,
    message: '发布到公共 registry（发布后不可撤回）',
  },
  {
    risk: 'remote-write',
    pattern: /\bwrangler\b[^\n]*\b(?:deploy|delete|publish)\b/i,
    message: '改动线上部署（wrangler deploy/delete/publish）',
  },
  {
    risk: 'remote-write',
    pattern: /\bcurl\b[^\n]*-X\s*(?:POST|PUT|PATCH|DELETE)\b/i,
    message: '向远端发送写请求（curl -X POST/PUT/PATCH/DELETE）',
  },
  {
    risk: 'privilege',
    pattern: /\bsudo\b/i,
    message: '以提权身份执行（sudo）',
  },
  {
    risk: 'privilege',
    pattern: /\bch(?:mod|own)\s+-R\b/i,
    message: '递归修改权限/属主（chmod/chown -R）',
  },
];

/**
 * The first rule that matches, or `null` for a command nothing recognises.
 *
 * Only commands are assessed. A file tool's path already arrives canonical through
 * `FsPort` and has its own read-before-write gate (ADR-049); this is about the one tool
 * whose input is an arbitrary program.
 */
export function assessCommand(command: string | undefined): CommandWarning | null {
  if (command === undefined) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return { risk: rule.risk, message: rule.message };
  }
  return null;
}
