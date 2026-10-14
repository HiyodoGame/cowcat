// File checkpoints + /rewind (persistence.md §6, session-scoped edition).
// Before an Edit/Write lands, the file's current content is snapshotted under
// ~/.cowcat/checkpoints/<sessionId>/<checkpointN>/ and a {type:"checkpoint"}
// record is appended to the session JSONL. /rewind restores file contents and
// truncates the conversation back to the checkpoint.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { cowcatHome } from './config.js';

export function checkpointsRoot(sessionId) {
  return join(cowcatHome(), 'checkpoints', sessionId);
}

// Snapshot the pre-edit contents of every file an Edit/Write batch will touch.
// Returns the checkpoint descriptor, or null when there is nothing to snapshot.
export function createCheckpoint(ctx, operations, label) {
  const sessionId = ctx.sessionId;
  if (!sessionId || !operations.length) return null;
  const root = checkpointsRoot(sessionId);
  const dirs = existsSync(root) ? readdirSync(root) : [];
  const id = dirs.length + 1; // monotonically increasing within the session
  const dir = join(root, String(id));
  const files = [];
  for (const op of operations) {
    const abs = resolve(ctx.cwd, op.file_path);
    if (!existsSync(abs)) continue; // Write creating a new file: nothing to restore
    const rel = op.file_path.replace(/[\\/:*?"<>|]/g, '_');
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(abs));
    files.push({ path: abs, snap: dest, tool: op.tool });
  }
  if (!files.length) return null;
  const record = { id, files: files.map((f) => ({ path: f.path, tool: f.tool })), label };
  ctx.session?.append?.({ type: 'checkpoint', ...record });
  return { id, dir, files, record };
}

export function listCheckpoints(ctx) {
  const sessionId = ctx.sessionId;
  if (!sessionId) return [];
  const root = checkpointsRoot(sessionId);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .sort((a, b) => b - a) // newest first
    .map((id) => {
      let record = null;
      try {
        const line = readFileSync(join(root, String(id), 'record.json'), 'utf8');
        record = JSON.parse(line);
      } catch { /* legacy checkpoint without a record */ }
      return { id, record };
    });
}

// Keep the record.json next to the snapshots so /rewind works without the JSONL.
export function persistCheckpointRecord(ctx, checkpoint) {
  if (!checkpoint) return;
  writeFileSync(join(checkpoint.dir, 'record.json'), JSON.stringify(checkpoint.record));
}

// Restore file contents from a checkpoint. Returns the restored file paths.
export function restoreCheckpoint(ctx, id) {
  const dir = join(checkpointsRoot(ctx.sessionId), String(id));
  if (!existsSync(dir)) return null;
  let record;
  try { record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')); } catch { return null; }
  for (const f of record.files) {
    const rel = f.path.replace(/[\\/:*?"<>|]/g, '_');
    const snap = join(dir, rel);
    if (existsSync(snap)) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, readFileSync(snap));
    }
  }
  return record.files.map((f) => f.path);
}

export function checkpointSummaryLine(cp) {
  const r = cp.record;
  if (!r) return `#${cp.id}`;
  const tools = [...new Set(r.files.map((f) => f.tool))].join('/');
  return `#${cp.id}  ${r.files.length} file(s) via ${tools}${r.label ? `  (${r.label})` : ''}`;
}
