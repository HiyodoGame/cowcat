import { PROTOCOL_VERSION } from '../protocol/index.js';
import { COMMANDS, type CommandContext } from './spec.js';
import { readVersion } from './version.js';

/** opentui's floor (ADR-056), which is the only Node version this package supports. */
const MIN_NODE = { major: 26, minor: 4 } as const;

/**
 * `cowcat doctor`, the minimal version T4 promises.
 *
 * It reports what this build can actually check about itself: the runtime, whether the
 * platform native core resolved, the protocol generation, and which verbs are still
 * unwired. It deliberately does **not** claim to check configuration or sandbox
 * backends — those need the kernel, which is T4a. The last line says so instead of
 * leaving the absence to be discovered.
 */
export function runDoctor(context: CommandContext): number {
  let failed = 0;
  const row = (label: string, value: string, ok: boolean): void => {
    context.stdout(`  ${label.padEnd(10)}${value.padEnd(52)}${ok ? 'ok' : 'FAIL'}`);
    if (!ok) failed += 1;
  };

  context.stdout(`cowcat ${readVersion()} doctor`);

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  row('node', `v${process.versions.node}（需要 >=${String(MIN_NODE.major)}.${String(MIN_NODE.minor)}）`, nodeOk);

  const candidates = nativeCandidates();
  const nativeCore = candidates.find(resolves);
  row('原生核心', nativeCore ?? `未解析到：${candidates.join(', ')}`, nativeCore !== undefined);

  row('protocol', `version ${String(PROTOCOL_VERSION)}`, true);

  for (const command of COMMANDS) {
    if (command.status === 'blocked') context.stdout(`  ${command.name.padEnd(10)}尚未接线：${command.blockedBy}`);
  }
  context.stdout('  （配置与沙箱后端不在这一版 doctor 里：它们需要内核，见 T4a）');

  context.stdout(failed === 0 ? 'doctor: 通过' : `doctor: ${String(failed)} 项失败`);
  return failed === 0 ? 0 : 1;
}

/** The per-platform native core opentui resolves at runtime (ADR-056). */
function nativeCandidates(): readonly string[] {
  const base = `@opentui/core-${process.platform}-${process.arch}`;
  return process.platform === 'linux' ? [base, `${base}-musl`] : [base];
}

function resolves(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
