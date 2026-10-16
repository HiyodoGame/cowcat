// Minimal static gate, deliberately two rules only.
//
// Why it exists: bin/cowcat.mjs called `writeState` in /sandbox and /panel while
// never importing it — `/sandbox off` crashed the CLI with a ReferenceError that
// no unit test could see (slash commands are only reachable through the REPL),
// and one behavioural test suite did not cover it. `no-undef` catches that
// class statically, anywhere, without needing a TTY, a REPL or a real platform.
// `no-unused-vars` is the cheap companion (dead declarations / leftover locals).
//
// Anything more opinionated would swamp the signal, so formatting/style rules
// are intentionally absent.
//
// Node globals are listed by hand instead of pulling in the `globals` package:
// the project ships zero runtime dependencies and this file stays the single
// place to add one when a new built-in shows up (a missing entry fails loudly
// as a no-undef error, which is the safe direction).
const nodeGlobals = {
  AbortController: 'readonly', AbortSignal: 'readonly', Blob: 'readonly',
  BroadcastChannel: 'readonly', Buffer: 'readonly', ByteLengthQueuingStrategy: 'readonly',
  CompressionStream: 'readonly', CountQueuingStrategy: 'readonly', Crypto: 'readonly',
  CryptoKey: 'readonly', CustomEvent: 'readonly', DecompressionStream: 'readonly',
  DOMException: 'readonly', Event: 'readonly', EventTarget: 'readonly', File: 'readonly',
  FormData: 'readonly', Headers: 'readonly', MessageChannel: 'readonly',
  MessageEvent: 'readonly', MessagePort: 'readonly', PerformanceEntry: 'readonly',
  PerformanceMark: 'readonly', PerformanceMeasure: 'readonly', PerformanceObserver: 'readonly',
  PerformanceObserverEntryList: 'readonly', PerformanceResourceTiming: 'readonly',
  ReadableByteStreamController: 'readonly', ReadableStream: 'readonly',
  ReadableStreamBYOBReader: 'readonly', ReadableStreamBYOBRequest: 'readonly',
  ReadableStreamDefaultController: 'readonly', ReadableStreamDefaultReader: 'readonly',
  Request: 'readonly', Response: 'readonly', TextDecoder: 'readonly',
  TextDecoderStream: 'readonly', TextEncoder: 'readonly', TextEncoderStream: 'readonly',
  TransformStream: 'readonly', TransformStreamDefaultController: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', WebAssembly: 'readonly',
  WebSocket: 'readonly', WritableStream: 'readonly', WritableStreamDefaultController: 'readonly',
  WritableStreamDefaultWriter: 'readonly', atob: 'readonly', btoa: 'readonly',
  clearImmediate: 'readonly', clearInterval: 'readonly', clearTimeout: 'readonly',
  console: 'readonly', crypto: 'readonly', fetch: 'readonly', navigator: 'readonly',
  performance: 'readonly', process: 'readonly', queueMicrotask: 'readonly',
  setImmediate: 'readonly', setInterval: 'readonly', setTimeout: 'readonly',
  structuredClone: 'readonly',
};

export default [
  {
    // test/live/** are opt-in checks against real third-party packages that are
    // not installed by default.
    ignores: ['node_modules/**', 'test/live/**', 'test/fixtures/**'],
  },
  {
    files: ['bin/**/*.mjs', 'src/**/*.js', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-undef': 'error',
      // args: 'none' — this codebase passes plenty of callbacks that ignore part
      // of their signature; flagging those buries the real findings.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
];
