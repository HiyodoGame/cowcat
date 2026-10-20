// Guard for what `npm publish` would upload (P8).
//
// The real work lives in `pack-release.mjs`: it stages the four packages, rewrites
// the `file:` dev links to the released version, packs, and checks the file list.
// This file stays as the stable entry point CI and docs already call.
//
//   node tools/check-tarball.mjs [--out DIR] [--install]
import './pack-release.mjs';
