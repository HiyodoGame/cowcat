#!/usr/bin/env node
/**
 * The process entry for `serve` (T3). It is deliberately the thinnest possible thing:
 * the wiring lives in `serve.ts`, and the host it passes is the refusing placeholder.
 *
 * T4 replaces this file with the subcommand table (`cowcat serve` and the rest) and
 * passes the real composition root; nothing else about the lifecycle changes.
 */
import { refusingHost } from './refusing-host.js';
import { serve } from './serve.js';

process.exitCode = await serve({ host: refusingHost() });
