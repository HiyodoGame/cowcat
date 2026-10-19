// The renderer (ADR-056). The protocol lives in `@corescense/cowcat-protocol` and the
// CLI in `@corescense/cowcat-cli` (ADR-062): T4a 3/3 moved every verb out of this
// package, and T7 fills in `app/`, `ui/`, `components/`, `theme/` and `image/` here.
//
// `@corescense/cowcat-protocol` stays a dependency on purpose: the protocol CLIENT is what
// this package becomes next, and the renderer is the only part that needs opentui.
export { renderSmokeFrame, type SmokeFrame } from './smoke.js';
