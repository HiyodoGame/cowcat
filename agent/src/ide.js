// IDE integration (P2-2, minimal): detect the hosting IDE from the terminal
// environment, and emit file_edited events (Edit/Write successes) as JSONL on a
// channel the IDE extension can tail. Channel resolution: COWCAT_IDE_PIPE env
// (a file path); without it, events are counted but not written. /ide reports
// the state. NOTE: the `diagnostic` event type promised in early docs was never
// wired up — only file_edited is emitted today.
import { appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function detectIde(env = process.env) {
  const tp = (env.TERM_PROGRAM || '').toLowerCase();
  if (tp === 'vscode') {
    return { name: env.CURSOR_TRACE_ID || env.VSCODE_CWD?.includes('cursor') ? 'Cursor' : 'VS Code', terminal: true };
  }
  if (tp === 'cursor') return { name: 'Cursor', terminal: true };
  if (tp.includes('jetbrains')) return { name: 'JetBrains', terminal: true };
  if (env.IDEA_INITIAL_DIRECTORY || env.JETBRAINS_IDE) return { name: 'JetBrains', terminal: false };
  return null;
}

export function ideChannel(env = process.env) {
  return env.COWCAT_IDE_PIPE || null;
}

// Event sink: returns the number of events emitted; writes JSONL when a
// channel path is configured.
export function makeIdeSink(env = process.env) {
  const channel = ideChannel(env);
  let count = 0;
  return {
    get channel() { return channel; },
    get count() { return count; },
    emit(event) {
      count++;
      if (channel) {
        try {
          appendFileSync(channel, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
        } catch { /* channel gone — events still counted */ }
      }
      return count;
    },
  };
}

export function defaultChannelHint() {
  return join(tmpdir(), 'cowcat-ide.jsonl');
}

export function ideStatus(sink, env = process.env) {
  const ide = detectIde(env);
  const lines = [];
  lines.push(ide ? `IDE: ${ide.name} (${ide.terminal ? 'integrated terminal' : 'external'})` : 'IDE: none detected');
  lines.push(`channel: ${sink.channel || '(not set — export COWCAT_IDE_PIPE=' + defaultChannelHint() + ')'}`);
  lines.push(`events emitted this session: ${sink.count}`);
  if (sink.channel && !existsSync(sink.channel)) lines.push('(channel file will be created on first event)');
  return lines;
}
