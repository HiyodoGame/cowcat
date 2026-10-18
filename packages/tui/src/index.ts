// T1 published the premise check; T2 added the headless protocol; T3 adds `serve`
// (stdio transport + process lifecycle). T7 replaces the rest of this entry with the
// protocol *client* wiring, `app/` and `ui/` (see docs/architecture/06-frontend.md).
export * from './protocol/index.js';
export { NOT_WIRED, refusingHost } from './serve/refusing-host.js';
export { SERVE_SIGNALS, serve, type ServeOptions, type SignalSource } from './serve/serve.js';
export { renderSmokeFrame, type SmokeFrame } from './smoke.js';
