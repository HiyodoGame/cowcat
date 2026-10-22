/**
 * The words the interface says (migrated from v1's `agent/src/ui.js` COPY table, which the
 * brand guide's §2.2 examples are drawn from).
 *
 * The guide is explicit that all interface copy comes from its example library and that
 * the voice is "terse, high-energy, no AI-speak". Retyping these lines would be the way
 * that rule quietly stops holding, so they are copied, not paraphrased.
 *
 * `detectLang` is v1's first-message sniff: a user who writes Chinese gets Chinese
 * chrome. The protocol does not carry a locale, and neither does the kernel, so the
 * interface decides from what it can see.
 */
export interface Copy {
  readonly ready: string;
  readonly waiting: string;
  readonly approveQuip: string;
  readonly approvePrompt: string;
  readonly denied: string;
  readonly success: string;
  readonly failure: string;
  readonly cancelled: string;
  readonly empty: string;
  readonly unsupportedEvent: string;
  /** A compaction line: `{n}` is how many messages were replaced (ADR-074). */
  readonly compacted: string;
  /** A delegation that finished: `{session}`, `{role}`, `{n}` rounds (ADR-079). */
  readonly subagentDone: string;
  /** A delegation that did not: same placeholders. */
  readonly subagentFailed: string;
  /**
   * A repeat-call warning shown next to the conversation (ADR-120): `{name}` is the
   * tool, `{n}` the consecutive count.
   */
  readonly repeatReminder: string;
  readonly attachment: string;
  /** The label an image line carries: `图片 image/png 320×200`. */
  readonly image: string;
  readonly truncated: string;
  readonly inputPlaceholder: string;
  readonly approveKeys: string;
  /** The nudge on a question nobody has answered (§2.2). */
  readonly approvalWaiting: string;
  /** The input line's hint while a turn is running (the status bar already says the state). */
  readonly busy: string;
  /** The dock's clickable return to the newest row (ADR-105). */
  readonly backToBottom: string;
  /** The same line with how much arrived while paused: `{n}` is the count. */
  readonly backToBottomNew: string;
}

export const COPY: Readonly<Record<'zh' | 'en', Copy>> = {
  zh: {
    ready: '在。说正事吧。',
    waiting: '盯着编译器出神中',
    approveQuip: '我要跑这个了，盯着它看三秒。',
    approvePrompt: '——允许？[y/n]',
    denied: '行吧，这条不干。',
    success: '搞定。',
    failure: '刚才那步失败了。',
    cancelled: '停下了。',
    empty: '（这一回合没有输出）',
    unsupportedEvent: '（这个事件这一版不认识）',
    compacted: '上下文已压缩（{n} 条 → 一段摘要）',
    subagentDone: '子会话 {session}（{role}）完成：{n} 轮',
    subagentFailed: '子会话 {session}（{role}）没跑完：{n} 轮',
    repeatReminder: '⚠️ 模型在重复调用 {name}（第 {n} 次，参数相同）',
    attachment: '附件',
    image: '图片',
    truncated: '（输出被截断）',
    inputPlaceholder: '说正事吧，回车发送，Ctrl-C 退出',
    approveKeys: '↑↓ 选择 · 回车确认（y / n / always / s 也可）',
    approvalWaiting: '......你还在吗。',
    busy: '（这一回合还在跑）',
    backToBottom: '↓ 回到底部',
    backToBottomNew: '↓ 回到底部 · {n} 条新输出',
  },
  en: {
    ready: 'here. say the real thing.',
    waiting: 'staring blankly at the compiler',
    approveQuip: 'Running this. Stare at it for three seconds.',
    approvePrompt: '-- allow? [y/n]',
    denied: 'Fine, skipping this one.',
    success: 'Done.',
    failure: 'That step failed.',
    cancelled: 'Stopped.',
    empty: '(nothing came back this turn)',
    unsupportedEvent: '(an event this build does not know)',
    compacted: 'context compacted ({n} messages → one summary)',
    subagentDone: 'sub session {session} ({role}) finished: {n} rounds',
    subagentFailed: 'sub session {session} ({role}) did not finish: {n} rounds',
    repeatReminder: '⚠️ the model is repeating {name} (call #{n}, same arguments)',
    attachment: 'attachment',
    image: 'image',
    truncated: '(output was truncated)',
    inputPlaceholder: 'say the real thing; Enter sends, Ctrl-C quits',
    approveKeys: '↑↓ choose · Enter confirms (y / n / always / s also work)',
    approvalWaiting: '......you still there.',
    busy: '(a turn is still running)',
    backToBottom: '↓ back to bottom',
    backToBottomNew: '↓ back to bottom · {n} new',
  },
};

export type Lang = keyof typeof COPY;

/** First-message language sniff: CJK characters mean Chinese, anything else means English. */
export function detectLang(text: string): Lang {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en';
}

export function copyFor(lang: Lang): Copy {
  return COPY[lang];
}
