// Custom commands / agents / skills loader (persistence §1/§5). Directory
// convention, user level ~/.cowcat/ and project level .cowcat/ (project wins
// on name clashes):
//   commands/<name>.md   frontmatter: description, allowed-tools?, model?, argument-hint?
//                        body = prompt template with $ARGUMENTS placeholder
//   agents/<name>.md     frontmatter: description, tools?, model?; body = role system prompt
//   skills/<name>/SKILL.md  frontmatter: name, description; body = instructions (lazy-loaded)
// Bad frontmatter skips the file with a warning — startup never fails.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cowcatHome } from './config.js';

function parseFrontmatter(raw, file) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { error: `缺少 frontmatter（--- 包围的元数据）：${file}` };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  if (!meta.description) return { error: `frontmatter 缺 description：${file}` };
  return { meta, body: m[2].trim() };
}

function scanMdDir(dir) {
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const file = join(dir, name);
    const parsed = parseFrontmatter(readFileSync(file, 'utf8'), file);
    if (parsed.error) { out[`__bad__${name}`] = { error: parsed.error }; continue; }
    out[name.replace(/\.md$/, '')] = { ...parsed.meta, body: parsed.body, file };
  }
  return out;
}

function scanSkillsDir(dir) {
  const root = join(dir, 'skills');
  if (!existsSync(root)) return {};
  const out = {};
  for (const name of readdirSync(root)) {
    const skillFile = join(root, name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const parsed = parseFrontmatter(readFileSync(skillFile, 'utf8'), skillFile);
    if (parsed.error) { out[`__bad__${name}`] = { error: parsed.error }; continue; }
    out[parsed.meta.name || name] = { description: parsed.meta.description, file: skillFile };
  }
  return out;
}

// Load and merge user + project levels. Returns { commands, agents, skills, warnings }.
export function loadCustom(cwd) {
  const commands = {};
  const agents = {};
  const skills = {};
  const warnings = [];
  const levels = [join(cowcatHome(), '.'), join(cwd, '.cowcat')];

  const collect = (bucket, scan) => {
    for (const level of levels) {
      for (const [name, def] of Object.entries(scan(level))) {
        if (def.error) { warnings.push(`⚠ ${def.error}`); continue; }
        bucket[name] = def; // project level overwrites user level
      }
    }
  };
  collect(commands, (d) => scanMdDir(join(d, 'commands')));
  collect(agents, (d) => scanMdDir(join(d, 'agents')));
  collect(skills, scanSkillsDir);
  return { commands, agents, skills, warnings };
}

// Custom slash command dispatch. Returns null when the name is not custom.
export function expandCommand(def, args) {
  return def.body.replace(/\$ARGUMENTS/g, args).replace(/\$1\b/g, args.split(/\s+/)[0] || '');
}

export function customHelpLines(commands) {
  return Object.entries(commands).map(([name, def]) => `  /${name} ${def['argument-hint'] || ''}  — ${def.description}`);
}
