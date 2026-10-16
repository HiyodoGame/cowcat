// Main agent loop: request -> stream -> execute tools -> feed results back -> repeat.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { estimateTokens, compactConversation as doCompact } from './prompts/compact.js';
import { todoReminder, dateReminder } from './prompts/reminders.js';
import { isDangerousCommand } from './permissions.js';
import { classifyCommand } from './sandbox.js';
import { networkAskFor } from './sandbox/exec.js';
import { unifiedDiff } from './diffcard.js';
import { bashCardModel } from './outputcard.js';
import { createCheckpoint, persistCheckpointRecord } from './checkpoint.js';
import { fireHooks, hookPayload } from './hooks.js';
import { editNotebook, parseNotebook, renderNotebook } from './notebook.js';

export const MAX_ITERATIONS = 200;

// Tools that mutate a file on disk: they get a checkpoint before running, a diff
// preview while awaiting approval, and the auto-accept treatment in acceptEdits.
export const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Prospective diff for Edit/Write approvals: replay the edit against the file
// on disk to show the user exactly what would change before approving.
export function buildWritePreview(toolName, input, ctx) {
  try {
    const filePath = resolve(ctx.cwd, input.file_path ?? input.notebook_path);
    const oldText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    if (toolName === 'NotebookEdit') {
      // Diff the RENDERED notebooks so the card talks in cells, not JSON, and
      // refuse to preview an edit that would not apply (the tool reports that).
      if (oldText == null) return null;
      const edited = editNotebook(oldText, {
        cell_index: input.cell_index,
        edit_mode: input.edit_mode,
        new_source: input.new_source,
        cell_type: input.cell_type,
      });
      if (!edited.ok) return null;
      const before = parseNotebook(oldText);
      if (!before.ok) return null;
      const { items, added, removed } = unifiedDiff(
        renderNotebook(before.nb, { path: filePath }),
        renderNotebook(edited.nb, { path: filePath }),
      );
      return { path: filePath, isNew: false, items, added, removed };
    }
    let newText;
    if (toolName === 'Write') {
      newText = input.content;
    } else {
      if (oldText == null || !input.old_string) return null;
      const occ = oldText.split(input.old_string).length - 1;
      if (occ === 0) return null;
      newText = input.replace_all
        ? oldText.split(input.old_string).join(input.new_string)
        : oldText.replace(input.old_string, input.new_string);
    }
    const { items, added, removed } = unifiedDiff(oldText ?? '', newText);
    return { path: filePath, isNew: oldText == null, items, added, removed };
  } catch {
    return null;
  }
}

function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Build the tool_result blocks for one assistant message. Tool calls are
// executed concurrently (cap: maxParallel), but the tool_result blocks MUST
// stay in the exact order of the tool_use blocks (the API pairs by position),
// so results are collected per index and assembled in order at the end.
// Interactive approvals are the exception: they are asked one at a time, in
// original order, after the non-interactive batch has been kicked off.
async function executeToolUses(assistantMsg, { registry, ctx, ui, permissions, events, sessionArtifacts, maxParallel = 4 }) {
  const pushResult = (block, r) => {
    events?.onToolResult?.(block.name, r);
  };
  const blocks = (assistantMsg.content || []).filter((b) => b.type === 'tool_use');
  const results = new Array(blocks.length);

  // Batch previews for Edit/Write in this assistant message: grouped diff cards,
  // collapsing to a file list when more than 3 files change at once.
  const writeOps = blocks.filter((b) => FILE_WRITE_TOOLS.has(b.name));
  const previews = new Map();
  for (const b of writeOps) previews.set(b.id, buildWritePreview(b.name, b.input, ctx));
  const group = writeOps.length
    ? { total: writeOps.length, previews: writeOps.map((b) => previews.get(b.id)).filter(Boolean) }
    : null;

  // --- sync gate (original order): classify each block -------------------------
  // immediate: a tool_result produced without executing (error/denial), or
  // approval: the call must prompt the user before it may run, or
  // run: safe to execute without asking.
  //
  // Resolved once per turn: does this configuration want per-command network
  // approval at all (system mode + network: 'ask' + a backend that will enforce)?
  const netAsk = ctx.config ? networkAskFor(ctx.config, { cwd: ctx.cwd }) : null;
  const runnable = [];
  const approval = [];
  blocks.forEach((block, i) => {
    const set = (r) => { results[i] = r; };
    const tool = registry.get(block.name);
    if (!tool) {
      set({ type: 'tool_result', tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
      return;
    }
    const check = registry.validate(block.name, block.input);
    if (!check.ok) {
      set({ type: 'tool_result', tool_use_id: block.id, content: `Invalid input: ${check.error}`, is_error: true });
      return;
    }

    // Plan mode gate: read-only whitelist; rejections feed back as tool_result
    // so the model can adjust instead of the turn aborting.
    const planReason = permissions.planReject?.(block.name, block.input) ?? null;
    if (planReason) {
      ui.planDenied?.(block.name, planReason);
      set({
        type: 'tool_result', tool_use_id: block.id, is_error: true,
        content: `Denied in plan mode: ${planReason} Ask the user to switch to act mode, or continue exploring read-only.`,
      });
      return;
    }

    // Permission rules engine: deny > ask > allow (never applies in yolo).
    if (permissions.mode !== 'plan' && permissions.decide(block.name, block.input) === 'deny') {
      const rule = permissions.deniedBy(block.name, block.input);
      sessionArtifacts.denials++;
      ui.toolCall(block.name, summarizeCall(block.name, block.input) + ' [denied by rule]');
      set({
        type: 'tool_result', tool_use_id: block.id, is_error: true,
        content: `Denied by permission rule "${rule?.raw ?? ''}" (deny). Remove it with /permissions if this should be allowed.`,
      });
      return;
    }

    const entry = {
      block, i,
      preview: previews.get(block.id) ?? null,
      groupInfo: null,
      // System-mode `network: 'ask'`: does THIS call need a network decision from
      // the user? Known before running because the classifier flags the commands
      // that normally reach the network (curl/wget/ssh/npm install/git push).
      networkAsk: Boolean(netAsk) && block.name === 'Bash' && classifyCommand(block.input.command || '').network,
    };
    entry.groupInfo = entry.preview && group
      ? { ...group, index: writeOps.findIndex((b) => b.id === block.id) + 1 }
      : null;
    if (permissions.mode !== 'plan' && permissions.decide(block.name, block.input) === 'ask') approval.push(entry);
    // A network-ask call needs a dialog even when the permission layer would
    // allow it (a rule or an earlier "always") — unless we are in yolo mode,
    // where asking is off by definition and the network simply stays off.
    else if (entry.networkAsk && permissions.mode !== 'yolo' && !permissions.isAlwaysAllowed(block.name, block.input)) approval.push(entry);
    else runnable.push(entry);
  });

  // --- shared execution tail: hooks veto, checkpoint, run, result --------------
  const runBlock = async ({ block, i, preview, groupInfo, networkAsk = false }, { networkGranted = false } = {}) => {
    const tool = registry.get(block.name);
    // PreToolUse hooks can veto the call (deny reason feeds back to the model).
    if (ctx.hooks) {
      const pre = await fireHooks(ctx.hooks, 'PreToolUse',
        hookPayload('PreToolUse', { tool: block.name, input: block.input }, ctx.hooks),
        { blocking: true, log: (m) => ui.print(m) });
      if (pre.denied) {
        sessionArtifacts.denials++;
        results[i] = {
          type: 'tool_result', tool_use_id: block.id, is_error: true,
          content: `Denied by PreToolUse hook: ${pre.reason}`,
        };
        return;
      }
    }

    // Checkpoint the pre-edit state of every file this write batch touches.
    if (FILE_WRITE_TOOLS.has(block.name)) {
      const cp = createCheckpoint(ctx, [{ file_path: block.input.file_path ?? block.input.notebook_path, tool: block.name }], null);
      persistCheckpointRecord(ctx, cp);
    }
    sessionArtifacts.toolCalls++;
    events?.onToolStart?.(block.name, block.input);
    let res;
    try {
      // `networkApproved` is per call and never sticky: the system sandbox reads
      // it to drop --unshare-net for exactly this invocation (plan §5.7).
      const callCtx = networkGranted ? { ...ctx, networkApproved: true } : ctx;
      res = await tool.execute(block.input, callCtx);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (res.ok) {
      if (ctx.hooks) fireHooks(ctx.hooks, 'PostToolUse', hookPayload('PostToolUse', { tool: block.name, input: block.input, output: res.output ?? '' }, ctx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
      ui.toolSuccess?.(block.id);
      events?.onToolSuccess?.(block.name);
      if (preview) sessionArtifacts.diffs.push(preview);
      if (block.name === 'Bash') {
        const model = bashCardModel(res.output);
        let file = null;
        if (model.folded && typeof ctx.session?.writeOutput === 'function') {
          try { file = ctx.session.writeOutput(res.output); } catch { file = null; }
        }
        sessionArtifacts.lastBash = { command: block.input.command || '', output: res.output, exitCode: res.exitCode ?? 0 };
        ui.bashResultCard?.({
          model, command: block.input.command || '', exitCode: res.exitCode ?? 0, file, id: block.id,
        });
      }
      const r = { type: 'tool_result', tool_use_id: block.id, content: res.output ?? '' };
      // Binary payloads (images/PDFs) travel as references on the result; the
      // bytes are materialized per request by the provider (src/attach.js).
      if (Array.isArray(res.attachments) && res.attachments.length) r.attachments = res.attachments;
      results[i] = r;
      pushResult(block, r);
    } else {
      if (ctx.hooks) fireHooks(ctx.hooks, 'PostToolUseFailure', hookPayload('PostToolUseFailure', { tool: block.name, input: block.input, error: res.error }, ctx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
      ui.toolError(res.error, block.id);
      events?.onToolFailure?.(block.name, res.error);
      const r = { type: 'tool_result', tool_use_id: block.id, content: `Error: ${res.error}`, is_error: true };
      results[i] = r;
      pushResult(block, r);
    }
  };

  // --- phase 1: everything that does not need a prompt, capped concurrency ----
  const cap = Math.max(1, Number.isFinite(Number(maxParallel)) ? Math.floor(Number(maxParallel)) : 4);
  const queue = [...runnable];
  const worker = async () => {
    while (queue.length) {
      const g = queue.shift();
      // allow-listed (or plan-mode read-only) calls announce their card here;
      // the ask flow announces inside runApproval below.
      ui.toolCall(g.block.name, summarizeCall(g.block.name, g.block.input), g.block.id);
      // Reaching phase 1 in a non-yolo mode means a rule (or an earlier
      // "always") allowed this call, so an approved network ask is granted here
      // too. yolo asks nothing and therefore grants nothing: `ask` must not
      // degrade into `on` just because prompts are disabled.
      await runBlock(g, { networkGranted: g.networkAsk && permissions.mode !== 'yolo' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, queue.length) }, worker));

  // --- phase 2: approval-requiring calls, one dialog at a time, in order ------
  // Re-decide lazily: an "always" from an earlier approval in this phase (or
  // any side effect that changed the rules) upgrades a pending ask to allow.
  for (const g of approval) {
    const { block } = g;
    const decisionNow = permissions.mode !== 'plan' ? permissions.decide(block.name, block.input) : 'allow';
    if (decisionNow === 'deny') {
      const rule = permissions.deniedBy(block.name, block.input);
      sessionArtifacts.denials++;
      ui.toolCall(block.name, summarizeCall(block.name, block.input) + ' [denied by rule]', block.id);
      results[g.i] = {
        type: 'tool_result', tool_use_id: block.id, is_error: true,
        content: `Denied by permission rule "${rule?.raw ?? ''}" (deny). Remove it with /permissions if this should be allowed.`,
      };
      continue;
    }
    if (decisionNow === 'allow') {
      ui.toolCall(block.name, summarizeCall(block.name, block.input), block.id);
      await runBlock(g, { networkGranted: Boolean(g.networkAsk) && permissions.mode !== 'yolo' });
      continue;
    }
    const dangerous = block.name === 'Bash' && isDangerousCommand(block.input.command || '');
    const summary = summarizeCall(block.name, block.input);
    // Tell the user WHAT they are approving: a system-mode Bash command that
    // needs the network gets the namespace only if they say yes here.
    const netTag = g.networkAsk ? ' [needs network: sandbox]' : '';
    ui.toolCall(block.name, summary + (dangerous ? ' [dangerous]' : '') + netTag, block.id);
    const decision = await ui.approve(block.name, summary, { dangerous, preview: g.preview, group: g.groupInfo, input: block.input });
    if (decision === 'n') {
      sessionArtifacts.denials++;
      if (ui.interactive === false) {
        // Non-interactive denial: tell the model exactly why and how to proceed.
        results[g.i] = {
          type: 'tool_result', tool_use_id: block.id, is_error: true,
          content: `Non-interactive mode: ${block.name} was auto-denied. Rerun with -y to auto-approve, or continue with a read-only approach.`,
        };
      } else {
        ui.denied?.(block.id);
        events?.onToolFailure?.(block.name, 'denied by user');
        results[g.i] = { type: 'tool_result', tool_use_id: block.id, content: `User denied ${block.name}: ${summary}`, is_error: true };
      }
      continue;
    }
    if (decision === 'always') permissions.approveAlways(block.name, block.input);
    await runBlock(g, { networkGranted: Boolean(g.networkAsk) && permissions.mode !== 'yolo' });
  }

  return results;
}

function summarizeCall(name, input) {
  if (name === 'Bash') return input.command || '';
  if (name === 'Read') return input.file_path || '';
  if (name === 'Write' || name === 'Edit') return input.file_path || '';
  if (name === 'NotebookEdit') return `${input.notebook_path || ''} [cell ${input.cell_index ?? '?'} ${input.edit_mode || 'replace'}]`;
  if (name === 'Glob') return input.pattern || '';
  if (name === 'Grep') return input.pattern || '';
  if (name === 'Agent') return input.description || '';
  return JSON.stringify(input).slice(0, 80);
}

// Run the loop until the model stops requesting tools. Returns { messages, finalText, iterations, compacted }.
export async function runLoop({
  provider, registry, system, messages, ctx, ui, permissions, config,
  onText = null, onThinking = null, onToolDelta = null, maxIterations = MAX_ITERATIONS, toolFilter = null, events = null,
  model = null, signal = null,
}) {
  let iterations = 0;
  let compacted = 0;
  const sessionArtifacts = { diffs: [], lastBash: null, denials: 0, toolCalls: 0, usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 } };
  const tools = toolFilter ? registry.list().filter((t) => toolFilter(t.name)) : registry.list();

  while (iterations < maxIterations) {
    iterations++;
    // Auto-compact (P1-5): consult the real count_tokens when the estimate
    // crosses 70% of the threshold or a single tool_result is huge; decide on
    // the real count, silently falling back to the local estimate.
    const est = estimateTokens(messages);
    const threshold = config.maxContextTokens;
    let probe = est > threshold * 0.7;
    if (!probe) {
      probe = messages.some((m) => Array.isArray(m.content)
        && m.content.some((b) => b.type === 'tool_result'
          && ((typeof b.content === 'string' && b.content.length > 8000)
            || (Array.isArray(b.attachments) && b.attachments.length > 0))));
    }
    if (probe) {
      let real = null;
      try {
        real = await provider.countTokens?.({
          system: typeof system === 'function' ? system() : system,
          messages,
        });
      } catch { /* endpoint unsupported -> local estimate decides */ }
      const size = real ?? est;
      if (size > threshold) {
        ui.compacting?.();
        events?.onCompact?.();
        if (ctx.hooks) await fireHooks(ctx.hooks, 'PreCompact', hookPayload('PreCompact', { trigger: 'auto' }, ctx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
        const result = await doCompact({
          provider, messages, sessionFile: ctx.session?.file, countTokens: provider.countTokens?.bind(provider),
          model: config.smallModel || null,
        });
        messages.splice(0, messages.length, ...result.messages);
        ctx.session?.append?.({ type: 'compact_boundary', summary: result.boundarySummary });
        ctx.session?.append?.({ type: 'compacted', count: result.compactedCount });
        compacted++;
      }
    }

    const reminderBits = [dateReminder(), ctx.state.todos?.length ? todoReminder(ctx.state.todos) : '']
      .filter(Boolean).join('\n');
    const reqMessages = [...messages];
    if (reminderBits) {
      // Plain user text: reminder rides BEFORE the text as its own block (P1-6),
      // keeping the user's words as the message tail with the cache breakpoint.
      // tool_result messages: reminder goes AFTER the results — Kimi's converter
      // requires the user message to lead with tool_result blocks to pair them.
      const remBlock = { type: 'text', text: reminderBits };
      const lastIdx = reqMessages.length - 1;
      const last = reqMessages[lastIdx];
      if (last && last.role === 'user' && Array.isArray(last.content)
          && last.content.some((b) => b.type === 'tool_result')) {
        reqMessages[lastIdx] = { ...last, content: [...last.content, remBlock] };
      } else if (last && last.role === 'user' && Array.isArray(last.content)) {
        reqMessages[lastIdx] = { ...last, content: [remBlock, ...last.content] };
      } else if (last && last.role === 'user' && typeof last.content === 'string') {
        reqMessages[lastIdx] = { ...last, content: [remBlock, { type: 'text', text: last.content }] };
      } else {
        reqMessages.push({ role: 'user', content: [remBlock] });
      }
    }

    ui.waitingModel?.();
    events?.onWaiting?.();
    let firstDelta = true;
    const streamed = [];
    const sys = typeof system === 'function' ? system() : system;
    let res;
    try {
      res = await provider.chat({
      system: sys,
      model,
      signal,
      messages: reqMessages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      maxTokens: config.maxTokens,
      onText: (d) => {
        if (firstDelta) { firstDelta = false; events?.onFirstDelta?.(); }
        streamed.push(d);
        onText?.(d);
      },
      onThinking: onThinking
        ? (d) => {
            if (firstDelta) { firstDelta = false; events?.onFirstDelta?.(); }
            onThinking(d);
          }
        : undefined,
      // tool-call formation deltas (P2): streamed args surface live in the UI
      onToolDelta: onToolDelta
        ? (d) => {
            if (firstDelta) { firstDelta = false; events?.onFirstDelta?.(); }
            onToolDelta(d);
          }
        : undefined,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        return { messages, finalText: '[interrupted]', iterations, compacted, interrupted: true };
      }
      throw e;
    }
    if (streamed.length) ui.endStream?.();
    // aggregate usage for /cost — normalize both the Anthropic
    // (input_tokens/output_tokens) and OpenAI (prompt_tokens/completion_tokens)
    // field names so non-Anthropic providers report real numbers.
    const u = res.usage;
    if (u) {
      sessionArtifacts.usage.input += u.input_tokens ?? u.prompt_tokens ?? 0;
      sessionArtifacts.usage.output += u.output_tokens ?? u.completion_tokens ?? 0;
      sessionArtifacts.usage.cache_read += u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens ?? 0;
      sessionArtifacts.usage.cache_creation += u.cache_creation_input_tokens ?? 0;
    }

    const assistantMsg = { role: 'assistant', content: res.content };
    messages.push(assistantMsg);
    ctx.session?.append({ type: 'assistant', message: assistantMsg });

    const toolUses = (res.content || []).filter((b) => b.type === 'tool_use');
    const stopReason = res.stopReason;

    if (stopReason === 'max_tokens') {
      ui.print('[stop reason: max_tokens — continuing]');
    }

    if (toolUses.length === 0) {
      return { messages, finalText: textOf(assistantMsg), iterations, compacted, ...sessionArtifacts };
    }

    const results = await executeToolUses(assistantMsg, { registry, ctx, ui, permissions, events, sessionArtifacts, maxParallel: config.maxParallelTools });
    const toolMsg = { role: 'user', content: results };
    messages.push(toolMsg);
    ctx.session?.append({ type: 'user', message: toolMsg });
  }
  return { messages, finalText: '[stopped: iteration limit reached]', iterations, compacted, ...sessionArtifacts };
}
