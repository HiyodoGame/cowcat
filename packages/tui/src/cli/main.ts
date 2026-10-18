#!/usr/bin/env node
/**
 * The `cowcat` executable (ADR-060). It does one thing: hand argv to the dispatcher and
 * let it decide the exit code.
 */
import { runCli } from './run.js';

process.exitCode = await runCli(process.argv.slice(2));
