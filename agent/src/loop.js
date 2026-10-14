// Main agent loop: request -> stream -> execute tools -> feed results back -> repeat.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { estimateTokens, compactConversation as doCompact } from './prompts/compact.js';
import { todoReminder, dateReminder } from './prompts/reminders.js';
import { isDangerousCommand } from './permissions.js';
import { unifiedDiff } from './diffcard.js';
import { bashCardModel } from './outputcard.js';
import { createCheckpoint, persistCheckpointRecord } from './checkpoint.js';
import { fireHooks, hookPayload } from './hooks.js';

export const MAX_ITERATIONS = 200;

// Prospective diff for Edit/Write approvals: replay the edit against the file
// on disk to show the user exactly what would change before approving.
export function buildWritePreview(toolName, input, ctx) {
  try {
    const filePath = resolve(ctx.cwd, input.file_path);
    const oldText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
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

// Build the tool_result blocks for one assistant message by executing its tool_use blocks in order.
async function executeToolUses(assistantMsg, { registry, ctx, ui, permissions, events, sessionArtifacts }) {
  const results = [];
  const pushResult = (block, r) => {
    results.push(r);
    events?.onToolResult?.(block.name, r);
  };
  // Batch previews for Edit/Write in this assistant message: grouped diff cards,
  // collapsing to a file list when more than 3 files change at once.
  const writeOps = (assistantMsg.content || []).filter(
    (b) => b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write'),
  );
  const previews = new Map();
  for (const b of writeOps) previews.set(b.id, buildWritePreview(b.name, b.input, ctx));
  const group = writeOps.length
    ? { total: writeOps.length, previews: writeOps.map((b) => previews.get(b.id)).filter(Boolean) }
    : null;

  for (const block of assistantMsg.content || []) {
    if (block.type !== 'tool_use') continue;
    const tool = registry.get(block.name);
    if (!tool) {
      results.push({ type: 'tool_result', tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true });
      continue;
    }
    const check = registry.validate(block.name, block.input);
    if (!check.ok) {
      results.push({ type: 'tool_result', tool_use_id: block.id, content: `Invalid input: ${check.error}`, is_error: true });
      continue;
    }

    // Plan mode gate: read-only whitelist; rejections feed back as tool_result
    // so the model can adjust instead of the turn aborting.
    const planReason = permissions.planReject?.(block.name, block.input) ?? null;
    if (planReason) {
      ui.planDenied?.(block.name, planReason);
      results.push({
        type: 'tool_result', tool_use_id: block.id, is_error: true,
        content: `Denied in plan mode: ${planReason} Ask the user to switch to act mode, or continue exploring read-only.`,
      });
      continue;
    }

    const preview = previews.get(block.id) ?? null;
    const groupInfo = preview && group
      ? { ...group, index: writeOps.findIndex((b) => b.id === block.id) + 1 }
      : null;

    // Permission rules engine: deny > ask > allow (never applies in yolo).
    if (permissions.mode !== 'plan') {
      const pre = permissions.decide(block.name, block.input);
      if (pre === 'deny') {
        const rule = permissions.deniedBy(block.name, block.input);
        sessionArtifacts.denials++;
        ui.toolCall(block.name, summarizeCall(block.name, block.input) + ' [denied by rule]');
        results.push({
          type: 'tool_result', tool_use_id: block.id, is_error: true,
          content: `Denied by permission rule "${rule?.raw ?? ''}" (deny). Remove it with /permissions if this should be allowed.`,
        });
        continue;
      }
      if (pre === 'allow') {
        ui.toolCall(block.name, summarizeCall(block.name, block.input));
      } else {
        // ask — approval flow below
      }
    }

    // Permission gate (writes / commands). Read-only tools pass without asking.
    const dangerous = block.name === 'Bash' && isDangerousCommand(block.input.command || '');
    const needsApproval = permissions.mode === 'plan'
      ? false
      : permissions.decide(block.name, block.input) === 'ask';
    if (needsApproval) {
      const summary = summarizeCall(block.name, block.input);
      ui.toolCall(block.name, summary + (dangerous ? ' [dangerous]' : ''));
      const decision = await ui.approve(block.name, summary, { dangerous, preview, group: groupInfo });
      if (decision === 'n') {
        sessionArtifacts.denials++;
        if (ui.interactive === false) {
          // Non-interactive denial: tell the model exactly why and how to proceed.
          results.push({
            type: 'tool_result', tool_use_id: block.id, is_error: true,
            content: `Non-interactive mode: ${block.name} was auto-denied. Rerun with -y to auto-approve, or continue with a read-only approach.`,
          });
        } else {
          ui.denied?.();
          events?.onToolFailure?.(block.name, 'denied by user');
          results.push({ type: 'tool_result', tool_use_id: block.id, content: `User denied ${block.name}: ${summary}`, is_error: true });
        }
        continue;
      }
      if (decision === 'always') permissions.approveAlways(block.name, block.input);
    } else if (permissions.mode === 'plan') {
      ui.toolCall(block.name, summarizeCall(block.name, block.input));
    }

    // PreToolUse hooks can veto the call (deny reason feeds back to the model).
    if (ctx.hooks) {
      const pre = await fireHooks(ctx.hooks, 'PreToolUse',
        hookPayload('PreToolUse', { tool: block.name, input: block.input }, ctx.hooks),
        { blocking: true, log: (m) => ui.print(m) });
      if (pre.denied) {
        sessionArtifacts.denials++;
        results.push({
          type: 'tool_result', tool_use_id: block.id, is_error: true,
          content: `Denied by PreToolUse hook: ${pre.reason}`,
        });
        continue;
      }
    }

    // Checkpoint the pre-edit state of every file this write batch touches.
    if (block.name === 'Edit' || block.name === 'Write') {
      const cp = createCheckpoint(ctx, [{ file_path: block.input.file_path, tool: block.name }], null);
      persistCheckpointRecord(ctx, cp);
    }
    sessionArtifacts.toolCalls++;
    events?.onToolStart?.(block.name, block.input);
    let res;
    try {
      res = await tool.execute(block.input, ctx);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (res.ok) {
      if (ctx.hooks) fireHooks(ctx.hooks, 'PostToolUse', hookPayload('PostToolUse', { tool: block.name, input: block.input, output: res.output ?? '' }, ctx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
      ui.toolSuccess?.();
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
          model, command: block.input.command || '', exitCode: res.exitCode ?? 0, file,
        });
      }
      pushResult(block, { type: 'tool_result', tool_use_id: block.id, content: res.output ?? '' });
    } else {
      if (ctx.hooks) fireHooks(ctx.hooks, 'PostToolUseFailure', hookPayload('PostToolUseFailure', { tool: block.name, input: block.input, error: res.error }, ctx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
      ui.toolError(res.error);
      events?.onToolFailure?.(block.name, res.error);
      pushResult(block, { type: 'tool_result', tool_use_id: block.id, content: `Error: ${res.error}`, is_error: true });
    }
  }
  return results;
}

function summarizeCall(name, input) {
  if (name === 'Bash') return input.command || '';
  if (name === 'Read') return input.file_path || '';
  if (name === 'Write' || name === 'Edit') return input.file_path || '';
  if (name === 'Glob') return input.pattern || '';
  if (name === 'Grep') return input.pattern || '';
  if (name === 'Agent') return input.description || '';
  return JSON.stringify(input).slice(0, 80);
}

// Run the loop until the model stops requesting tools. Returns { messages, finalText, iterations, compacted }.
export async function runLoop({
  provider, registry, system, messages, ctx, ui, permissions, config,
  onText = null, maxIterations = MAX_ITERATIONS, toolFilter = null, events = null,
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
        && m.content.some((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 8000));
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
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        return { messages, finalText: '[interrupted]', iterations, compacted, interrupted: true };
      }
      throw e;
    }
    if (streamed.length) ui.endStream?.();
    // aggregate usage for /cost
    const u = res.usage;
    if (u) {
      sessionArtifacts.usage.input += u.input_tokens || 0;
      sessionArtifacts.usage.output += u.output_tokens || 0;
      sessionArtifacts.usage.cache_read += u.cache_read_input_tokens || 0;
      sessionArtifacts.usage.cache_creation += u.cache_creation_input_tokens || 0;
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

    const results = await executeToolUses(assistantMsg, { registry, ctx, ui, permissions, events, sessionArtifacts });
    const toolMsg = { role: 'user', content: results };
    messages.push(toolMsg);
    ctx.session?.append({ type: 'user', message: toolMsg });
  }
  return { messages, finalText: '[stopped: iteration limit reached]', iterations, compacted, ...sessionArtifacts };
}
