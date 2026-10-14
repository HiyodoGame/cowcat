// Sub agent runner (P1-7): builtin roles + custom agent defs + skill injection
// + Task resume. Fresh isolated context per run; role decides the tool subset.
import { Permissions } from './permissions.js';
import { runLoop } from './loop.js';
import { Session } from './session.js';
import { BUILTIN_ROLES, DEFAULT_ROLE } from './prompts/subagents.js';

export const SUBAGENT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Wrap the provider so every chat() carries `effort` through to the wire
// request without touching runLoop: providers translate it into a thinking
// budget (Anthropic) or reasoning_effort (OpenAI-compatible). `low` disables
// thinking outright; invalid values are ignored.
function withEffort(provider, effort) {
  if (!effort || effort === 'high' || typeof provider.chat !== 'function') return provider;
  return Object.create(provider, {
    chat: { value: (req) => provider.chat({ ...req, effort }) },
  });
}

// Resolve which definition drives a spawn: custom agents win over builtins.
export function resolveSubagentSpec({ subagent_type = null, customAgents = {}, skill = null, skillBody = null } = {}) {
  let system;
  let tools;
  let model = null;
  if (subagent_type && customAgents[subagent_type]) {
    const def = customAgents[subagent_type];
    system = def.body;
    tools = def.tools ? def.tools.split(',').map((s) => s.trim()).filter(Boolean) : null;
    model = def.model || null;
  } else {
    const role = BUILTIN_ROLES[subagent_type] ? subagent_type : DEFAULT_ROLE;
    const def = BUILTIN_ROLES[role];
    system = def.system;
    tools = def.tools;
  }
  if (skillBody) system = `${system}\n\n# Skill instructions\n\n${skillBody}`;
  return { system, tools, model };
}

export function createSubagentRunner({ provider, registry, config, ui, cwd, customAgents = {}, getSkillBody = null } = {}) {
  return async function spawnAgent({
    prompt, maxTurns = 10, model = null, subagent_type = null, skill = null, resume = null,
    isolation = null, depth = 0, effort = null,
  } = {}) {
    const skillBody = skill && getSkillBody ? getSkillBody(skill) : null;
    const spec = resolveSubagentSpec({ subagent_type, customAgents, skill, skillBody });
    let messages;
    if (resume) {
      // Task resume: continue from the original transcript, then the new prompt.
      messages = Session.load(resume);
      messages.push({ role: 'user', content: prompt });
    } else {
      messages = [{ role: 'user', content: prompt }];
    }
    const perms = new Permissions(spec.tools ? 'plan' : 'yolo'); // restricted roles stay read-only; general may write
    let runCwd = cwd || config.cwd || process.cwd();
    let isolationNote = '';
    if (isolation === 'worktree') {
      const { createWorktree } = await import('./worktree.js');
      const wt = createWorktree(runCwd);
      runCwd = wt.path;
      isolationNote = `

(isolation: git worktree at ${wt.path}, branch ${wt.branch})`;
    }
    const ctx = {
      cwd: runCwd,
      readSet: new Set(),
      state: {},
      ui,
      permissions: perms,
      config,
    };
    const isLead = subagent_type === 'lead';
    // lead may delegate one level deeper; everyone else cannot nest
    if (isLead && depth < 1) {
      ctx.spawnAgent = (input) => spawnAgent({ ...input, depth: depth + 1 });
    }
    const toolFilter = spec.tools
      ? (name) => spec.tools.includes(name)
      : (name) => (isLead ? name !== 'AskUserQuestion' : name !== 'Agent' && name !== 'AskUserQuestion'); // lead may nest (depth-capped)
    const res = await runLoop({
      provider: withEffort(provider, effort),
      registry,
      system: spec.system,
      messages,
      ctx,
      ui,
      permissions: perms,
      config,
      maxIterations: maxTurns,
      model: model ?? spec.model, // explicit param wins over role default
      toolFilter,
    });
    return res.finalText + isolationNote;
  };
}
