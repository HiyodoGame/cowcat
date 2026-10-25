import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolRunContext } from '../ports/index.js';

export interface FileCheckpoint {
  readonly path: string;
  readonly beforePath: string;
  readonly created: boolean;
  readonly beforeHash: string | null;
  readonly afterHash?: string | null;
}

export interface CheckpointOptions {
  readonly rootDir: string;
}

export function captureCheckpoint(options: CheckpointOptions, context: ToolRunContext | undefined, path: string): FileCheckpoint | undefined {
  if (context === undefined) return undefined;
  const created = !existsSync(path);
  const beforePath = join(options.rootDir, context.sessionId, 'changes', `${safe(context.callId)}.before`);
  mkdirSync(dirname(beforePath), { recursive: true });
  const temporary = `${beforePath}.tmp`;
  if (created) writeFileSync(temporary, '');
  else copyFileSync(path, temporary);
  renameSync(temporary, beforePath);
  return { path, beforePath, created, beforeHash: created ? null : hashFile(beforePath) };
}

export function checkpointAfter(checkpoint: FileCheckpoint, path: string): FileCheckpoint {
  return { ...checkpoint, afterHash: hashFile(path) };
}

export function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function captureCurrent(options: CheckpointOptions, sessionId: string, callId: string, path: string): string {
  const redoPath = join(options.rootDir, sessionId, 'changes', `${safe(callId)}.redo`);
  mkdirSync(dirname(redoPath), { recursive: true });
  const temporary = `${redoPath}.tmp`;
  if (existsSync(path)) copyFileSync(path, temporary);
  else writeFileSync(temporary, '');
  renameSync(temporary, redoPath);
  return redoPath;
}

export function restoreBefore(options: CheckpointOptions, sessionId: string, callId: string, path: string, beforePath: string, created: boolean): string {
  const redoPath = captureCurrent(options, sessionId, callId, path);
  if (created && existsSync(path)) unlinkSync(path);
  else copyFileSync(beforePath, path);
  return redoPath;
}

export function restoreAfter(path: string, redoPath: string): void {
  copyFileSync(redoPath, path);
}

function safe(callId: string): string {
  return createHash('sha256').update(callId).digest('hex');
}
