// Hooks core subset (agent-loop §6, original implementation). Config lives in
// ~/.cowcat/config.json: hooks: { <Event>: [ {type:"command", command, timeout?,
// once?, async?}, {type:"http", url, headers?, timeout?} ] }. PreToolUse stdout
// or non-zero exit = deny (first stdout line is the reason fed back to the
// model). Hooks never prompt for approval. COWCAT_DISABLE_HOOKS=1 disables all.
import { exec } from 'node:child_process';
import { writeState } from './config.js';

export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit',
  'Stop', 'SessionStart', 'SessionEnd', 'PreCompact',
];

export function hooksDisabled(env = process.env) {
  return env.COWCAT_DISABLE_HOOKS === '1' || env.COWCAT_DISABLE_HOOKS === 'true';
}

export function loadHooks(cfg, env = process.env) {
  if (hooksDisabled(env)) {
    const events = {};
    for (const ev of HOOK_EVENTS) events[ev] = [];
    return { events, count: 0, disabled: true };
  }
  const raw = (cfg && cfg.hooks) || {};
  const events = {};
  let count = 0;
  for (const ev of HOOK_EVENTS) {
    const list = Array.isArray(raw[ev]) ? raw[ev] : [];
    events[ev] = list.filter((h) => h && (h.type === 'command' || h.type === 'http') && (h.command || h.url));
    count += events[ev].length;
  }
  return { events, count, disabled: false };
}

// Persist state.json mutations (once-removal, enable/disable) preserving fields.
export function updateHooksConfig(mutate) {
  return writeState((state) => mutate(state) ?? state);
}

function runCommandHook(hook, payload, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(grace); resolve(r); } };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* noop */ }
      // orphaned grandchildren can hold the pipes open — resolve anyway
      grace = setTimeout(() => done({ ok: false, code: -1, stdout: '', stderr: 'killed', timedOut: true }), 2500);
    }, timeoutMs);
    let grace = null;
    try {
      child = exec(hook.command, { cwd: payload.cwd, timeout: timeoutMs + 10_000, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
        done({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', timedOut: !!err?.killed });
      });
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch (e) {
      done({ ok: false, code: -1, stdout: '', stderr: e.message, timedOut: false });
    }
  });
}

async function runHttpHook(hook, payload, timeoutMs, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(hook.headers || {}) },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { ok: res.ok, code: res.status, stdout: body, stderr: '', timedOut: false };
  } catch (e) {
    return { ok: false, code: 0, stdout: '', stderr: e.name === 'AbortError' ? 'timeout' : e.message, timedOut: e.name === 'AbortError', networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

// Fire one event. For PreToolUse (blocking=true) a hook "deny" short-circuits
// the rest. Returns { denied, reason, results }.
export async function fireHooks(hooks, event, payload, { blocking = false, log = () => {}, fetchImpl } = {}) {
  if (!hooks || hooks.disabled) return { denied: false, results: [] };
  const list = hooks.events[event] || [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const hook = list[i];
    if (hook.enabled === false) continue;
    const timeoutMs = hook.timeout ? hook.timeout * 1000 : (hook.type === 'http' ? 30_000 : 60_000);
    const run = hook.type === 'command'
      ? runCommandHook(hook, payload, timeoutMs)
      : runHttpHook(hook, payload, timeoutMs, fetchImpl);

    let r;
    if (hook.async && !blocking) {
      run.then((res) => log(`[hook:${event}] async ${hook.type} -> code ${res.code}`)).catch(() => {});
      results.push({ async: true });
      continue;
    }
    r = await run;
    results.push(r);

    if (hook.once) {
      hooks.events[event].splice(i, 1);
      i--;
      updateHooksConfig((cfg) => {
        if (cfg.hooks?.[event]) cfg.hooks[event] = cfg.hooks[event].filter((x) => JSON.stringify(x) !== JSON.stringify(hook));
        return cfg;
      });
      hooks.count = Math.max(0, hooks.count - 1);
    }

    if (blocking) {
      const denyByExit = hook.type === 'command' && (r.code !== 0 || r.stdout.trim() !== '' || r.timedOut);
      const denyByBody = hook.type === 'http' && !r.ok && !r.networkError;
      if (denyByExit || denyByBody) {
        const reason = (r.timedOut ? 'hook timed out' : (r.stdout || r.stderr || 'hook denied')).split('\n')[0].trim()
          || 'hook denied';
        return { denied: true, reason, results };
      }
      if (r.networkError) log(`⚠ [hook:${event}] http hook unreachable (${r.stderr}) — allowing`);
    }
  }
  return { denied: false, results };
}

// Build the standard event payload.
export function hookPayload(event, extra, { sessionFile, cwd }) {
  return {
    event,
    sessionFile,
    cwd,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}
