// TEMPORARY diagnostic — delete before merge.
// Answers one question with measurements instead of an argument: which spellings of a
// granted path actually reach their data inside a Seatbelt sandbox?
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSandboxExecutor,
  defaultSandboxProfile,
  NodeFs,
  NodePlatform,
  NodeProcess,
  resolveEntries,
} from '../src/index.js';

const platform = new NodePlatform();
const verdict = platform.sandboxBackends()[0];
const skip =
  verdict === undefined
    ? `no backend on ${platform.platform}`
    : verdict.usable
      ? false
      : `${verdict.name} unusable: ${verdict.reason} ${verdict.detail ?? ''}`;

test('diag: which path spellings reach the data', { skip }, async (t) => {
  const fs = new NodeFs();
  const root = mkdtempSync(join(tmpdir(), 'cowcat-diag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const project = join(root, 'proj');
  const home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(join(project, 'r.txt'), 'PROJECT\n');
  writeFileSync(join(home, 'n.txt'), 'HOME\n');

  // The canonical spelling is what the policy grants. The "friendly" spelling strips the
  // /private prefix — on macOS that is exactly what a user or a model types.
  const stripPrivate = (path: string): string => (path.startsWith('/private/') ? path.slice('/private'.length) : path);

  const paths = {
    homeCanonical: fs.canonical(home),
    homeFriendly: stripPrivate(fs.canonical(home)),
    projectCanonical: fs.canonical(project),
    projectFriendly: stripPrivate(fs.canonical(project)),
  };

  const read = resolveEntries({ entries: [project, home], cwd: project, home, fs });
  const write = resolveEntries({ entries: [project], cwd: project, home, fs });

  const probe = `
    const fs = require("fs");
    const P = ${JSON.stringify(paths)};
    const attempt = (label, fn) => { try { console.log(label + "=OK:" + fn()); } catch (e) { console.log(label + "=" + e.code); } };
    attempt("read-canonical-home", () => fs.readFileSync(P.homeCanonical + "/n.txt", "utf8").trim());
    attempt("read-friendly-home", () => fs.readFileSync(P.homeFriendly + "/n.txt", "utf8").trim());
    attempt("read-canonical-project", () => fs.readFileSync(P.projectCanonical + "/r.txt", "utf8").trim());
    attempt("read-friendly-project", () => fs.readFileSync(P.projectFriendly + "/r.txt", "utf8").trim());
    attempt("read-relative", () => fs.readFileSync("r.txt", "utf8").trim());
    attempt("stat-canonical-home", () => String(fs.statSync(P.homeCanonical).isDirectory()));
    attempt("stat-friendly-home", () => String(fs.statSync(P.homeFriendly).isDirectory()));
    attempt("readdir-canonical-home", () => fs.readdirSync(P.homeCanonical).join(","));
    attempt("readdir-friendly-home", () => fs.readdirSync(P.homeFriendly).join(","));
  `;

  const port = new NodeProcess({
    platform,
    sandboxCommand: createSandboxExecutor({
      platform,
      fsProbe: {
        isDir: (p) => fs.kindOf(p) === 'directory',
        isFile: (p) => fs.kindOf(p) === 'file',
        canonical: (p) => fs.canonical(p),
      },
    }),
  });

  const result = await port.run(
    {
      argv: [process.execPath, '-e', probe],
      cwd: project,
      env: {},
      sandbox: defaultSandboxProfile({
        mode: 'system' as const,
        read: { profile: 'workspace' as const, allow: read.resolved, deny: [] },
        write: { allow: write.resolved, deny: [] },
      }),
    },
    new AbortController().signal,
  );

  console.log('DIAG-PATHS %s', JSON.stringify(paths));
  console.log('DIAG-OUT\n%s', result.stdout.trim());
  console.log('DIAG-ERR %s', result.stderr.trim().replace(/\n/g, ' | ').slice(0, 600));
});