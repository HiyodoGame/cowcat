// T1 published only the premise check; T2 adds the headless protocol. T7 replaces the
// rest of this entry with the protocol *client* wiring, `app/` and `ui/`
// (see docs/architecture/06-frontend.md).
export * from './protocol/index.js';
export { renderSmokeFrame, type SmokeFrame } from './smoke.js';
