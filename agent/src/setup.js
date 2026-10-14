// Interactive setup wizard, shared by the `cowcat setup` subcommand and the
// REPL's /setup slash command. Writes ~/.cowcat/config.json (preserving
// existing fields) and returns the merged config so callers can hot-reload.
import { saveSetupConfig } from './doctor.js';

export async function runSetupWizard(ui) {
  const zh = ui.lang === 'zh';
  ui.print(zh ? 'CowCat setup —— 回车使用默认值。' : 'CowCat setup — press Enter for defaults.');
  const ask = async (q, def) => {
    ui.output.write(`${q} [${def}]: `);
    const a = ((await ui.readLine()) ?? '').trim();
    return a || def;
  };
  const provider = await ask(zh ? 'provider (anthropic|openai)' : 'provider (anthropic|openai)', 'anthropic');
  const baseURL = await ask('base URL', 'https://api.kimi.com/coding');
  ui.output.write(zh ? 'API key (输入不回显): ' : 'API key (not echoed): ');
  const apiKey = await ui.readSecret();
  const model = await ask('model', 'kimi-for-coding');
  const { file, config } = saveSetupConfig({ provider, baseURL, apiKey, model });
  ui.print(`${zh ? '✓ 已写入' : '✓ saved to'} ${file}`);
  return config;
}
