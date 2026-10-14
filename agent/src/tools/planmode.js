// EnterPlanMode / ExitPlanMode tools: the plan-then-execute loop.
// EnterPlanMode flips the session into read-only plan mode; ExitPlanMode
// presents the plan for user approval and, on approval, switches the session
// into the acceptEdits execution tier (file writes auto-allowed, Bash still
// asks). Both are whitelisted as read-only meta tools in permissions.js.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EnterPlanModeTool = {
  name: 'EnterPlanMode',
  description: `Enter plan mode: a read-only exploration phase where you research the codebase and design an implementation approach for user approval, before any code is written.

Use this proactively when you are about to start a non-trivial implementation task — new features, multiple valid approaches, multi-file changes, architectural decisions, or unclear requirements. Skip it for trivial tasks (typos, one-liners) and for pure research questions.

In plan mode, Edit/Write and mutating Bash commands are rejected by the harness, so explore with Read/Glob/Grep/read-only Bash. When your plan is ready, call ExitPlanMode with the full plan text to request approval. If the user approves, the session switches to execution mode and you carry out the plan.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute(_input, ctx) {
    const { permissions, ui } = ctx;
    if (!permissions) return { ok: false, error: 'Plan mode is not available in this context' };
    if (permissions.mode === 'plan') {
      return {
        ok: true,
        output: ui.lang === 'zh'
          ? '已经在 plan 模式：只读探索中，完成后用 ExitPlanMode 提交计划。'
          : 'Already in plan mode: keep exploring read-only, then submit the plan with ExitPlanMode.',
      };
    }
    permissions.setMode('plan');
    ui.print?.(ui.lang === 'zh'
      ? '[Plan] 已进入只读规划阶段：拆墙请提交计划（ExitPlanMode）等批准。'
      : '[Plan] entered read-only planning. Submit the plan (ExitPlanMode) and wait for approval before swinging the hammer.');
    return {
      ok: true,
      output: ui.lang === 'zh'
        ? '已进入 plan 模式：写类工具将被拒绝，直到计划获批。'
        : 'Entered plan mode: write tools are rejected until a plan is approved.',
    };
  },
};

export const ExitPlanModeTool = {
  name: 'ExitPlanMode',
  description: `Request user approval of your plan and exit plan mode to begin execution.

Use this tool when you are in plan mode and have finished designing the implementation. Present the complete, unambiguous plan as the "plan" parameter (markdown): ordered steps, exact files you will change, key edits, risks, and how you will verify each step. If requirements are still ambiguous, use AskUserQuestion first — do NOT ask "is this plan okay?" via AskUserQuestion; that is exactly what this tool does.

On approval, the session switches to execution mode: Edit/Write run without further approval for this session, while Bash commands still go through the normal permission checks. On rejection you stay in plan mode — revise the plan based on the feedback and call this tool again.`,
  input_schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The complete implementation plan in markdown: ordered steps, files to change, key edits, risks, verification.',
      },
      filePath: {
        type: 'string',
        description: 'Optional path of a plan file you wrote; its contents are shown alongside the plan text when it exists.',
      },
      allowedPrompts: {
        type: 'array',
        description: 'Optional actions the plan needs, granted without asking on approval (session-only).',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name, e.g. "Bash"' },
            prompt: { type: 'string', description: 'Command prefix the plan needs, e.g. "npm run test"' },
          },
          required: ['tool', 'prompt'],
        },
      },
    },
    required: ['plan'],
  },
  async execute(input, ctx) {
    const { permissions, ui } = ctx;
    if (!permissions) return { ok: false, error: 'Plan mode is not available in this context' };
    if (permissions.mode !== 'plan') {
      return {
        ok: false,
        error: 'ExitPlanMode is only available in plan mode. Use EnterPlanMode first when a task needs a plan.',
      };
    }
    const zh = ui.lang === 'zh';

    // Render the plan for review; a plan file's contents ride along when given.
    ui.print?.('');
    ui.print?.(`── ${zh ? '计划审批' : 'Plan approval'}${input.filePath ? ` · ${input.filePath}` : ''} ──`);
    for (const line of String(input.plan).split('\n')) ui.print?.(`  ${line}`);
    if (input.filePath) {
      try {
        const p = resolve(ctx.cwd || '.', input.filePath);
        if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split('\n')) ui.print?.(`  ${line}`);
      } catch { /* plan file unreadable — the plan text above stands alone */ }
    }
    const prompts = (Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [])
      .filter((p) => p && typeof p.tool === 'string' && typeof p.prompt === 'string' && p.prompt.trim());
    if (prompts.length) {
      ui.print?.(`  ${zh ? '计划需要的动作' : 'Planned actions'}: ${prompts.map((p) => `${p.tool}(${p.prompt})`).join(', ')}`);
    }
    ui.print?.('');

    const decision = await ui.approve('ExitPlanMode',
      zh ? '批准以上计划并开始执行？' : 'Approve this plan and start executing?', {});

    if (decision !== 'y' && decision !== 'always') {
      ui.denied?.();
      return {
        ok: true,
        output: zh
          ? '用户拒绝了该计划。你仍处于 plan 模式：根据反馈修订计划（缩小范围、换方案、澄清假设），然后重新调用 ExitPlanMode。'
          : 'The user rejected this plan. You are still in plan mode: revise the plan based on their feedback (narrow the scope, change the approach, clarify assumptions) and call ExitPlanMode again.',
      };
    }

    // Approval: declare the plan's actions as session-only allow rules, then
    // leave plan mode for the acceptEdits execution tier. Nothing here is
    // written back to the user's config file.
    for (const p of prompts) {
      if (permissions.rules && Array.isArray(permissions.rules.allow)) {
        permissions.rules.allow.push({ tool: p.tool, pattern: p.prompt.trim(), prefix: true, raw: `${p.tool}(${p.prompt.trim()}):*` });
      }
    }
    permissions.setMode('acceptEdits');
    ui.print?.(zh
      ? '[Act] 计划已批准：进入执行档，本次会话内文件编辑免审批，Bash 仍按需询问。'
      : '[Act] plan approved: execution tier — file edits auto-accepted for this session, Bash still asks when needed.');
    return {
      ok: true,
      output: zh
        ? '计划已批准，开始执行。本次会话内 Edit/Write 免审批；Bash 命令仍按常规权限规则询问。按计划逐步实施，每步完成后做对应验证。'
        : 'Plan approved — begin execution. Edit/Write run without approval for this session; Bash commands still follow the normal permission checks. Carry out the plan step by step, verifying after each.',
    };
  },
};
