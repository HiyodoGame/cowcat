// T1 published the premise check; T4 added the CLI. The protocol itself lives in
// `@corescense/cowcat-protocol` (ADR-062): this package is the renderer and the CLI, and
// it reaches the protocol as a dependency like any other client would.
export { EXIT, runCli, type CliOptions } from './cli/run.js';
export { COMMANDS, defaultCommand, findCommand, type CommandContext, type CommandSpec } from './cli/spec.js';
export { renderHelp } from './cli/help.js';
export { runDoctor } from './cli/doctor.js';
export { renderSmokeFrame, type SmokeFrame } from './smoke.js';
