export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export type Message =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text: string; readonly toolCalls: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly callId: string; readonly ok: boolean; readonly output: string };
