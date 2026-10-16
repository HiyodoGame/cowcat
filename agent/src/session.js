// Session persistence: JSONL transcript under ~/.cowcat/projects/<cwd-slug>/<timestamp>.jsonl
// (legacy ~/.ccagent/projects is still read for --resume compatibility).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cowcatHome, legacyHome } from './config.js';
import { canonicalPath } from './canonical.js';

export function cwdSlug(cwd) {
  return cwd.replace(/^[a-zA-Z]:/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

// Canonicalized because the slug IS the session's identity: on macOS the same
// project reached as `/var/folders/…` and as `/private/var/folders/…` produced
// two slugs and therefore two unresumable, unlistable sessions. See
// src/canonical.js and docs/fix-plan-2026-10-15.md 第十九轮.
function sessionDir(base, cwd) {
  return resolve(base, 'projects', cwdSlug(canonicalPath(cwd)));
}

export class Session {
  constructor(cwd, id = null) {
    this.cwd = cwd;
    this.id = id || new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = sessionDir(cowcatHome(), cwd);
    this.file = join(this.dir, `${this.id}.jsonl`);
  }

  ensure() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (!this._headerWritten) {
      this._headerWritten = true;
      appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), type: 'meta', cwd: this.cwd })}\n`);
    }
    return this;
  }

  append(record) {
    this.ensure();
    appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  }

  // Persist a full Bash output next to the session transcript; returns the path.
  writeOutput(text) {
    this.ensure();
    const dir = join(this.dir, 'outputs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${this.id}-${Date.now()}.log`);
    appendFileSync(file, text);
    return file;
  }

  // Load transcript messages from a JSONL file (records with a `message` field).
  // Non-message records are interpreted structurally:
  //  - {type:"checkpoint"}           -> skipped (state, not conversation)
  //  - {type:"compacted"}            -> skipped (folded-away history marker)
  //  - {type:"compact_boundary"}     -> a user message carrying the summary
  static load(file, { upToCheckpointId = null } = {}) {
    if (!existsSync(file)) throw new Error(`Session file not found: ${file}`);
    const messages = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (upToCheckpointId != null && rec.type === 'checkpoint' && rec.id === upToCheckpointId) break;
      if (rec.type === 'checkpoint' || rec.type === 'compacted') continue;
      if (rec.type === 'compact_boundary') {
        messages.push({ role: 'user', content: rec.summary, __compact: true });
        continue;
      }
      if (rec.message) messages.push(rec.message);
    }
    return messages;
  }

  // List available sessions, newest first, including legacy ones.
  static list(cwd) {
    const seen = new Map();
    for (const base of [cowcatHome(), legacyHome()]) {
      const dir = sessionDir(base, cwd);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(dir, f);
        try {
          seen.set(p, statSync(p).mtimeMs);
        } catch { /* unreadable entry */ }
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }
}
