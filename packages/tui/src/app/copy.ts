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
  readonly attachment: string;
  readonly truncated: string;
  readonly inputPlaceholder: string;
  readonly approveKeys: string;
  /** The nudge on a question nobody has answered (§2.2). */
  readonly approvalWaiting: string;
  /** The input line's hint while a turn is running (the status bar already says the state). */
  readonly busy: string;
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
    attachment: '附件',
    truncated: '（输出被截断）',
    inputPlaceholder: '说正事吧，回车发送，Ctrl-C 退出',
    approveKeys: 'y = 允许 / n = 拒绝 / always = 以后都允许（回车确认）',
    approvalWaiting: '......你还在吗。',
    busy: '（这一回合还在跑）',
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
    attachment: 'attachment',
    truncated: '(output was truncated)',
    inputPlaceholder: 'say the real thing; Enter sends, Ctrl-C quits',
    approveKeys: 'y = allow / n = reject / always = allow from now on (Enter to confirm)',
    approvalWaiting: '......you still there.',
    busy: '(a turn is still running)',
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
