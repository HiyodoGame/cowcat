import { ContextOverflowError } from '../ports/model.js';

const OVERFLOW_MESSAGE = /context[_ ](?:length|window)|prompt (?:is )?too long|prompt.*too many tokens|input.*too long|too many tokens|token limit|request.*too large/i;

export function contextOverflow(error: unknown, status: unknown): ContextOverflowError | null {
  if (status !== 400 && status !== 413) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (status !== 413 && !OVERFLOW_MESSAGE.test(message)) return null;
  return new ContextOverflowError(message, { cause: error });
}
