import type { FsPort } from '../../ports/index.js';
import type { SandboxFsProbe } from './backends/bwrap.js';

/**
 * The filesystem questions the sandbox builders ask, answered from `FsPort`.
 *
 * The builders only need "is this a directory / a file" and "what is the canonical
 * spelling", and `FsPort` already owns all three (ADR-017) — including the reason the
 * canonical spelling is here at all: on macOS `/var` is a symlink to `/private/var`, and
 * a profile that says `(subpath /var/…)` matches nothing (measured, see `SandboxFsProbe`).
 *
 * A separate function rather than a second `FsPort`: the builders are pure argv
 * generators and must not learn about the wider port.
 */
export function fsProbeFrom(fs: FsPort): SandboxFsProbe {
  return {
    isDir: (path) => fs.kindOf(path) === 'directory',
    isFile: (path) => fs.kindOf(path) === 'file',
    canonical: (path) => fs.canonical(path),
  };
}
