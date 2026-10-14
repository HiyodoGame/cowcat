// Background run + system notification (P2-8): `cowcat -p --background "task"`
// detaches a child process (log + meta under ~/.cowcat/background/<id>/), and
// the child toasts on completion. Windows: PowerShell NotifyIcon balloon;
// anything headless or non-Windows degrades to silent (returns false).
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cowcatHome } from './config.js';

export function makeRunId() {
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function backgroundDir(id) {
  return join(cowcatHome(), 'background', id);
}

// Pure preparation: where the child's log/meta live. Spawned by the CLI.
export function prepareBackgroundRun(id, prompt) {
  const dir = backgroundDir(id);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id, prompt,
    startedAt: new Date().toISOString(),
    logFile: join(dir, 'output.log'),
    resultFile: join(dir, 'result.json'),
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function finishBackgroundRun(id, { finalText, exitCode, usage }) {
  const dir = backgroundDir(id);
  if (!existsSync(dir)) return null;
  const result = { id, finishedAt: new Date().toISOString(), exitCode, usage: usage ?? null, finalText: String(finalText ?? '').slice(0, 5000) };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const PS_BALLOON = `
[void] [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");
$n = New-Object System.Windows.Forms.NotifyIcon;
$n.Icon = [System.Drawing.SystemIcons]::Information;
$n.Visible = $true;
$n.ShowBalloonTip(5000, $env:COWCAT_NOTIFY_TITLE, $env:COWCAT_NOTIFY_MSG, "Info");
Start-Sleep -Milliseconds 6000;
$n.Dispose();
`;

export function notify(title, message) {
  if (process.platform !== 'win32') return Promise.resolve(false); // silent degrade off Windows
  return new Promise((resolve) => {
    const env = { ...process.env, COWCAT_NOTIFY_TITLE: String(title).slice(0, 60), COWCAT_NOTIFY_MSG: String(message).slice(0, 240) };
    try {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_BALLOON], { env, timeout: 9000, windowsHide: true }, (err) => {
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}
