#!/usr/bin/env node
/**
 * The `cowcat` executable (ADR-060). It does one thing: hand argv to the dispatcher and
 * let it decide the exit code.
 *
 * Each verb that builds a host closes it before returning (`serve`, `run`), which is what
 * keeps a kernel session lock from being left behind (ADR-010) — the dispatcher does not
 * need to know that, and this file does not either.
 */
import { runCli } from './run.js';

process.exitCode = await runCli(process.argv.slice(2));
