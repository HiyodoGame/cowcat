import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT } from './exit.js';
import { flagOn, flagValue } from './flags.js';
import { statePaths } from './host.js';
import type { CommandContext } from './spec.js';

/**
 * `cowcat setup`: write the v2 user config, or translate a v1 one.
 *
 * Two rules shape this verb:
 *   * **No key is ever read from input or written.** Setup records a variable NAME
 *     (`apiKeyEnv`); the value stays in the shell (ADR-063/089).
 *   * **A v1 file is backed up, never edited in place.** Migration writes a new v2
 *     document next to it; the old bytes remain recoverable.
 *
 * There is no interactive prompt on purpose: a wizard would need a TTY abstraction the
 * rest of the CLI does not have, and every question it could ask is already a flag.
 */
export async function runSetup(context: CommandContext): Promise<number> {
  const migrate = flagOn(context.flags, 'migrate');
  const print = flagOn(context.flags, 'print');
  const force = flagOn(context.flags, 'force');
  const presetFlag = flagValue(context.flags, 'preset');
  const apiKeyEnvFlag = flagValue(context.flags, 'api-key-env');
  const baseUrlFlag = flagValue(context.flags, 'base-url');

  const core = await import('@corescense/cowcat-core');
  const paths = await statePaths();
  const target = paths.userConfig;

  if (migrate && presetFlag !== null) {
    context.stderr('cowcat setup: --migrate 和 --preset 只能选一个');
    return EXIT.usage;
  }
  if (!migrate && presetFlag === null) {
    context.stderr('cowcat setup: 需要 --migrate（迁移现有 v1 配置）或 --preset <provider/model>（新建）');
    context.stderr(`内置 preset：${Object.keys(core.BUILTIN_PRESETS).sort().join(', ')}`);
    context.stderr('例：cowcat setup --preset anthropic/claude-sonnet-5-5');
    return EXIT.usage;
  }

  const existing = readExisting(target, context);
  if (existing === 'unreadable') return EXIT.failed;

  let document: Record<string, unknown>;
  let summary: string;

  if (migrate) {
    if (existing === null) {
      context.stderr(`cowcat setup: 没有找到 v1 配置：${target}`);
      return EXIT.failed;
    }
    if (!isV1(existing.value)) {
      context.stderr(`cowcat setup: ${target} 不是 v1 形状；用 --preset 新建，或直接编辑它`);
      return EXIT.failed;
    }
    const migrated = translateV1(existing.value, core);
    if (migrated.errors.length > 0) {
      for (const problem of migrated.errors) context.stderr(`  ${problem}`);
      return EXIT.failed;
    }
    for (const warning of migrated.warnings) context.stderr(`注意：${warning}`);
    document = migrated.document;
    summary = `已从 v1 迁移到 ${target}`;
  } else {
    if (presetFlag === null) {
      // Unreachable: the guard above returns when both flags are absent.
      return EXIT.usage;
    }
    const fresh = freshDocument(presetFlag, apiKeyEnvFlag, baseUrlFlag, core);
    if (typeof fresh === 'string') {
      context.stderr(`cowcat setup: ${fresh}`);
      return EXIT.failed;
    }
    document = fresh;
    summary = `已写入 ${target}`;
  }

  const mcp: { readonly servers?: Record<string, unknown>; readonly warnings: readonly string[] } = migrate
    ? readV1Mcp(join(paths.dir, 'mcp.json'), context)
    : { warnings: [] };
  if (mcp.servers !== undefined) {
    document['mcp'] = { servers: mcp.servers };
  }

  if (print) {
    context.stdout(JSON.stringify(document, null, 2));
    context.stderr('（--print：没有写文件）');
    return EXIT.ok;
  }

  if (existing !== null) {
    if (!force && !migrate) {
      context.stderr(`cowcat setup: ${target} 已存在；加 --force 覆盖（会先备份）`);
      return EXIT.failed;
    }
    const backup = backupPath(target);
    copyFileSync(target, backup);
    // The v1 file may contain inline keys; the backup must not be world-readable.
    try {
      chmodSync(backup, 0o600);
    } catch {
      // Windows ACLs decide this; the content is still recoverable.
    }
    context.stderr(`已备份原配置：${backup}`);
  }

  if (!writeAtomic(target, document)) {
    context.stderr(`cowcat setup: 无法写入 ${target}`);
    return EXIT.failed;
  }
  context.stdout(summary);

  const envs = environmentNames(document);
  if (envs.length > 0) {
    context.stdout('需要设置的环境变量（值不要写进配置文件）：');
    for (const entry of envs) context.stdout(`  ${entry.env}    # ${entry.provider}`);
  }
  if (mcp.warnings.length > 0) {
    for (const warning of mcp.warnings) context.stderr(`注意：${warning}`);
  }
  context.stdout('下一步：cowcat doctor');
  return EXIT.ok;
}

type CoreModule = typeof import('@corescense/cowcat-core');

interface Existing {
  readonly value: Record<string, unknown>;
}

function readExisting(path: string, context: CommandContext): Existing | null | 'unreadable' {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      context.stderr(`cowcat setup: ${path} 不是 JSON 对象`);
      return 'unreadable';
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    context.stderr(`cowcat setup: 读不了 ${path}：${error instanceof Error ? error.message : String(error)}`);
    return 'unreadable';
  }
}

/** The v1 shape, by the same rule the loader uses (ADR-089). */
function isV1(document: Record<string, unknown>): boolean {
  if (typeof document['model'] === 'string') return true;
  if (document['model'] !== undefined) return false;
  const providers = document['providers'];
  return isRecord(providers) && Object.values(providers).some((entry) => isRecord(entry) && typeof entry['apiKey'] === 'string');
}

function translateV1(
  document: Record<string, unknown>,
  core: CoreModule,
): { readonly document: Record<string, unknown>; readonly warnings: readonly string[]; readonly errors: readonly string[] } {
  const loaded = core.loadConfig([{ kind: 'user', path: 'config.json', text: JSON.stringify(document) }]);
  if (!loaded.ok) {
    return { document: {}, warnings: [], errors: loaded.errors.map((error) => `${error.source}: ${error.problem}`) };
  }
  const config = loaded.config;
  if (config.model.preset === null) {
    return { document: {}, warnings: [], errors: ['v1 配置没有解析出 model.preset'] };
  }

  const providers: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [id, provider] of Object.entries(config.model.providers)) {
    const env = provider.apiKeyEnv ?? core.BUILTIN_PROVIDERS[id]?.apiKeyEnv ?? synthesizedEnv(id);
    if (provider.apiKey !== undefined && provider.apiKeyEnv === undefined) {
      warnings.push(`provider "${id}" 使用内联 apiKey；迁移后不写入配置文件，请把值放到环境变量 ${env}`);
    }
    providers[id] = {
      apiKeyEnv: env,
      ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
    };
  }

  const v2: Record<string, unknown> = {
    model: {
      preset: config.model.preset,
      ...(Object.keys(providers).length === 0 ? {} : { providers }),
    },
  };
  if (config.sandbox.mode !== 'light' || config.sandbox.env.deny.length > 0) {
    v2['sandbox'] = {
      mode: config.sandbox.mode,
      ...(config.sandbox.env.deny.length === 0 ? {} : { env: { deny: config.sandbox.env.deny } }),
    };
  }
  return { document: v2, warnings: [...loaded.warnings.map((warning) => warning.problem), ...warnings], errors: [] };
}

function freshDocument(preset: string, apiKeyEnv: string | null, baseUrl: string | null, core: CoreModule): Record<string, unknown> | string {
  const entry = core.BUILTIN_PRESETS[preset];
  if (entry === undefined) {
    return `未知 preset "${preset}"；可用：${Object.keys(core.BUILTIN_PRESETS).sort().join(', ')}`;
  }
  const provider = preset.slice(0, preset.indexOf('/'));
  const builtin = core.BUILTIN_PROVIDERS[provider];
  const env = apiKeyEnv ?? builtin?.apiKeyEnv;
  if (env === undefined) {
    return `provider "${provider}" 没有内置的环境变量名；请加 --api-key-env <NAME>`;
  }
  const url = baseUrl ?? builtin?.baseUrl ?? null;
  return {
    model: {
      preset,
      providers: {
        [provider]: {
          apiKeyEnv: env,
          ...(url === null ? {} : { baseUrl: url }),
        },
      },
    },
  };
}

function readV1Mcp(path: string, context: CommandContext): { readonly servers?: Record<string, unknown>; readonly warnings: readonly string[] } {
  if (!existsSync(path)) return { warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    context.stderr(`cowcat setup: mcp.json 读不了，未迁移：${error instanceof Error ? error.message : String(error)}`);
    return { warnings: [] };
  }
  if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) return { warnings: [] };
  const servers: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [name, entry] of Object.entries(parsed['mcpServers'])) {
    if (!isRecord(entry) || typeof entry['command'] !== 'string') {
      warnings.push(`mcp.json 的 "${name}" 没有 command，已跳过`);
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) {
      warnings.push(`mcp.json 的 "${name}" 不是合法服务器名，已跳过（v2 只接受字母、数字、_、-）`);
      continue;
    }
    const args = Array.isArray(entry['args']) ? entry['args'].filter((arg): arg is string => typeof arg === 'string') : undefined;
    if (entry['env'] !== undefined) {
      warnings.push(`mcp.json 的 "${name}" 含 env；未迁移（可能含密钥），请在 shell 中设置`);
    }
    servers[name] = {
      command: entry['command'],
      ...(args === undefined ? {} : { args }),
    };
  }
  return Object.keys(servers).length === 0 ? { warnings } : { servers, warnings };
}

function environmentNames(document: Record<string, unknown>): readonly { readonly provider: string; readonly env: string }[] {
  const model = isRecord(document['model']) ? document['model'] : null;
  const providers = model !== null && isRecord(model['providers']) ? model['providers'] : null;
  if (providers === null) return [];
  const seen = new Set<string>();
  const out: { provider: string; env: string }[] = [];
  for (const [provider, entry] of Object.entries(providers)) {
    if (!isRecord(entry) || typeof entry['apiKeyEnv'] !== 'string') continue;
    const key = `${provider}\u0000${entry['apiKeyEnv']}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, env: entry['apiKeyEnv'] });
  }
  return out;
}

function synthesizedEnv(provider: string): string {
  return `COWCAT_${provider.replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase()}_API_KEY`;
}

function backupPath(target: string): string {
  const base = `${target}.bak`;
  if (!existsSync(base)) return base;
  return `${base}.${String(Date.now())}`;
}

function writeAtomic(target: string, document: Record<string, unknown>): boolean {
  try {
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${String(process.pid)}`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
