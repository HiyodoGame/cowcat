// The executable (ADR-060, ADR-062 ③): the subcommand table, and the only package that
// sees the protocol, the composition root and the renderer at once. Everything a verb
// needs is imported dynamically inside it, so `--help` never loads a model SDK.
export { EXIT, type ExitCode } from './cli/exit.js';
export { flagOn, flagValue, parseArgv, type FlagSpec, type ParsedArgv } from './cli/flags.js';
export { runCli, type CliOptions } from './cli/run.js';
export { COMMANDS, defaultCommand, findCommand, type CommandContext, type CommandSpec } from './cli/spec.js';
export { renderHelp } from './cli/help.js';
export { runDoctor } from './cli/doctor.js';
export { runOneShot } from './cli/oneshot.js';
export { runServe } from './cli/serve.js';
export { runSessions } from './cli/sessions.js';
export { buildHost, stateDir, statePaths } from './cli/host.js';
