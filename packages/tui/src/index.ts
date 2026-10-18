// T1 published the premise check; T2 added the headless protocol; T3 `serve`; T4 the
// CLI entry. T7 replaces the rest of this entry with the protocol *client* wiring,
// `app/` and `ui/` (see docs/architecture/06-frontend.md).
export * from './protocol/index.js';
export { EXIT, runCli, type CliOptions } from './cli/run.js';
export { COMMANDS, defaultCommand, findCommand, type CommandContext, type CommandSpec } from './cli/spec.js';
export { renderHelp } from './cli/help.js';
export { runDoctor } from './cli/doctor.js';
export { NOT_WIRED, refusingHost } from './serve/refusing-host.js';
export { SERVE_SIGNALS, serve, type ServeOptions, type SignalSource } from './serve/serve.js';
export { renderSmokeFrame, type SmokeFrame } from './smoke.js';
