// Conversation compaction, aligned with the reference CLI's observed structure
// (dynamic-findings §4.2): one-line summarizer identity, <analysis> instruction,
// temperature=1 / max_tokens=20000 / Read-only tools, large-file reminders, and a
// single-message resume wrapper pointing at the session transcript.
export const SUMMARIZER_IDENTITY = 'You are a helpful AI assistant tasked with summarizing conversations.';

export const COMPACT_SYSTEM = `Read the transcript below and produce a handoff summary that lets the work continue without re-reading the history.

First, walk through the transcript chronologically inside <analysis> tags: for each stage note what the user asked, what you did, the key files and code involved, any errors and how they were resolved, and any user corrections. Then produce the final summary inside <summary> tags with exactly these sections:

1. Primary Request — what the user asked for, in their own terms.
2. Key Decisions — technical choices made and why.
3. Files and Code Sections — every file touched or read that matters, with paths and the important snippets, signatures, or commands.
4. Errors and Fixes — what broke, how it was fixed, and user feedback that changed the approach.
5. Pending Tasks — what is still open, and precisely what was in progress when the transcript ends.

Be exact with file paths and code. Do not invent facts.`;

export const WRAPPER_TEMPLATE = (summaryText, sessionFile) =>
  `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${summaryText}

If you need specific details that the summary does not cover, read the full transcript at: ${sessionFile}

Please continue the conversation from where we left off without asking the user any further questions. Continue with the last task that you were asked to work on.`;

export const LARGE_FILE_REMINDER = (path) =>
  `<system-reminder>${path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.</system-reminder>`;

// Render one internal message for the compact transcript.
export function renderForCompact(m) {
  if (m.role === 'tool') return `<tool_result id="${m.tool_use_id}">${m.content}</tool_result>`;
  const parts = [];
  for (const b of m.content || []) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'thinking') parts.push(`<thinking>${b.thinking}</thinking>`);
    else if (b.type === 'tool_use') parts.push(`<tool_use name="${b.name}" id="${b.id}">${JSON.stringify(b.input)}</tool_use>`);
    else if (b.type === 'tool_result') parts.push(`<tool_result id="${b.tool_use_id}"${b.is_error ? ' error' : ''}>${b.content}</tool_result>`);
  }
  return `<${m.role}>${parts.join('\n')}</${m.role}>`;
}

// Collect files that were read in the transcript together with the text that
// is about to be dropped (the Read tool_result payload, line numbers included).
export function collectReadFiles(messages) {
  const out = [];              // [{path, text}]
  let pendingRead = null;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name === 'Read' && typeof b.input?.file_path === 'string') {
        pendingRead = b.input.file_path;
      } else if (b.type === 'tool_result' && typeof b.content === 'string' && pendingRead) {
        out.push({ path: pendingRead, text: b.content });
        pendingRead = null;
      }
    }
  }
  return out;
}

// Decide which read files are too large to carry forward. Prefers a real
// count_tokens of the dropped text; falls back to a character threshold.
export async function findLargeFiles(messages, { countTokens, largeFileChars = 20000, largeFileTokens = 4000 } = {}) {
  const out = [];
  for (const { path, text } of collectReadFiles(messages)) {
    let tooLarge = text.length >= largeFileChars;
    if (!tooLarge && countTokens) {
      try {
        const tokens = await countTokens({ messages: [{ role: 'user', content: text }] });
        tooLarge = tokens >= largeFileTokens;
      } catch { /* fall back to the char heuristic */ }
    }
    if (tooLarge) out.push(path);
  }
  return out;
}

// Run compact. Two shapes (agent-loop §2):
//  - full: the whole history is summarized; messages reset to the single
//    resume-wrapper user message.
//  - recent-portion: when history is long enough, only messages older than the
//    last KEEP_RECENT are summarized; those recent turns stay verbatim.
// In both cases the returned messages are what the loop should keep, and
// `boundarySummary` is written to the session JSONL as a compact_boundary
// record so resume replays the summary instead of the dropped history.
export const KEEP_RECENT = 6;

export async function compactConversation({
  provider, messages, sessionFile = '(transcript unavailable)', countTokens = null,
  model = null, customInstruction = null, keepRecent = KEEP_RECENT,
} = {}) {
  const useRecentSplit = messages.length > keepRecent * 2;
  const kept = useRecentSplit ? messages.slice(-keepRecent) : [];
  const toSummarize = useRecentSplit ? messages.slice(0, -keepRecent) : messages;

  const instruction = customInstruction
    ? `${COMPACT_SYSTEM}\n\nAdditional instruction from the user: ${customInstruction}`
    : COMPACT_SYSTEM;
  const transcript = toSummarize.map(renderForCompact).join('\n');
  const res = await provider.chat({
    system: SUMMARIZER_IDENTITY,
    model,
    messages: [{ role: 'user', content: `${instruction}\n\nTranscript to compress:\n${transcript}` }],
    tools: [{ name: 'Read', description: 'Read a file when you need exact contents for the summary.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    maxTokens: 20000,
    temperature: 1,
  });
  const fullText = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const summaryText = fullText.trim();

  // large-file reminders for read files that are being dropped (dynamic-findings §4.2)
  let largeFiles = [];
  try {
    largeFiles = await findLargeFiles(toSummarize, { countTokens });
  } catch { /* reminder pass is best-effort */ }

  const wrapper = WRAPPER_TEMPLATE(summaryText, sessionFile);
  const rebuilt = [];
  if (useRecentSplit) {
    rebuilt.push({ role: 'user', content: wrapper, __compact: true });
    rebuilt.push(...kept);
  } else {
    const blocks = [];
    if (largeFiles.length) for (const p of largeFiles) blocks.push(LARGE_FILE_REMINDER(p));
    blocks.push(wrapper);
    rebuilt.push({
      role: 'user',
      content: blocks.length === 1 ? blocks[0] : blocks.join('\n\n'),
      __compact: true,
    });
  }
  return { messages: rebuilt, boundarySummary: wrapper, compactedCount: toSummarize.length, keptRecent: kept.length };
}

// Rough token estimate: ~4 chars per token over the serialized message list.
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.ceil(chars / 4);
}
