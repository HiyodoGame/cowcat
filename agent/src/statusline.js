// Custom statusline: config.json statusLine.command is run through a shell,
// fed one JSON line on stdin, and its first stdout line is appended to the
// status bar. Hard 2s timeout — a slow statusline must never stall the UI.
import { exec } from 'node:child_process';

const TIMEOUT_MS = 2000;

export function statuslinePayload({ model, mode, ctxPct, cwd }) {
  return JSON.stringify({ model, mode, ctx_pct: ctxPct, cwd });
}

export function runStatusLine(command, payload) {
  return new Promise((resolve) => {
    let child;
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* noop */ }
      setTimeout(() => resolve(null), 300); // pipes may outlive the kill
    }, TIMEOUT_MS);
    try {
      child = exec(command, { timeout: TIMEOUT_MS + 1500, maxBuffer: 64 * 1024, env: process.env }, (err, stdout) => {
        clearTimeout(timer);
        if (err) return resolve(null);
        const first = (stdout || '').split('\n')[0].trim();
        resolve(first || null);
      });
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// Persist (or clear, command=null) the statusLine state, preserving fields.
import { writeState } from './config.js';

export function saveStatusLine(command) {
  return writeState((state) => {
    if (command) state.statusLine = { command };
    else delete state.statusLine;
    return state;
  });
}
