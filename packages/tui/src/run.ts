import { createCliRenderer, type CliRenderer } from '@opentui/core';
import type { ProtocolClient } from '@corescense/cowcat-protocol';
import { addNotice, closeView, project, streamText } from './app/project.js';
import { initialView, withLangFrom } from './app/view.js';
import { frameOf, titleOf } from './components/session-frame.js';
import { THEME } from './theme/tokens.js';
import { createScreen } from './ui/screen.js';

/**
 * `runTui` — the loop that turns a protocol client into a screen (ADR-066 ①).
 *
 * It is the composition of the four layers and nothing else: it owns the view (`app/`),
 * hands it to the frame (`components/`), the frame to the screen (`ui/`), and the screen to
 * a renderer. The kernel is not here, and cannot be: it arrives as a `ProtocolClient` —
 * the same port an IDE plugin or a script would use.
 *
 * Two ordering facts are load-bearing:
 *
 *   * **subscribe before `session.open`.** The server answers the request and *then* replays
 *     the log as `event` notifications; a subscription installed after the reply can miss
 *     the beginning of the session, and nothing in the protocol would say so.
 *   * **the renderer is started before the handshake**, so a slow handshake (reading config,
 *     resolving a shell, loading a model) shows an empty frame with a status line instead of
 *     a blank terminal that looks like a hang.
 */
export interface RunTuiOptions {
  readonly client: ProtocolClient;
  /** `null` starts a new session; the id comes back from the host. */
  readonly sessionId: string | null;
  readonly version: string;
  /** Injected so tests can drive the loop without a real terminal. */
  readonly createRenderer?: () => Promise<CliRenderer>;
}

export async function runTui(options: RunTuiOptions): Promise<number> {
  const view = { current: initialView() };
  const render = await (options.createRenderer ?? defaultRenderer)();
  const screen = createScreen(render, THEME, { title: titleOf(options.version) });
  const detach: (() => void)[] = [];
  /**
   * Set before the renderer is destroyed, checked by every draw.
   *
   * Measured, not defensive: a `client.closed` handler installed below fires *after*
   * `runTui` has torn the screen down (closing the client is what resolves it), and drawing
   * then hits a destroyed native scene — which throws, exits non-zero, and skips the host's
   * `close()`, leaving a session lock behind. One flag is what stands between a clean exit
   * and that.
   */
  let disposed = false;

  const draw = (): void => {
    if (disposed) return;
    screen.update(frameOf(view.current));
  };

  let quit: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    quit = resolve;
  });

  try {
    // Subscriptions first: the replay of an existing session arrives as notifications the
    // moment `session.open` is answered.
    detach.push(
      options.client.on('event', (event) => {
        view.current = project(view.current, event);
        draw();
      }),
      options.client.on('delta', (delta) => {
        view.current = streamText(view.current, delta);
        draw();
      }),
      options.client.on('log', (line) => {
        // The server's own diagnostics are not session facts (ADR-055), so they are shown as
        // a notice and never merged into the transcript's durable half.
        view.current = addNotice(view.current, line.level === 'error' ? 'error' : line.level === 'warn' ? 'warn' : 'info', line.message);
        draw();
      }),
    );
    void options.client.closed.then(() => {
      view.current = closeView(view.current);
      draw();
    });

    detach.push(
      screen.onSubmit((value) => {
        submit(value);
      }),
      screen.onKey((key) => {
        // Ctrl-C is ours: the renderer is created with `exitOnCtrlC: false` so the screen can
        // be torn down (and the host closed) instead of the process vanishing mid-frame.
        if (key.ctrl && key.name === 'c') quit(0);
      }),
    );

    draw();
    render.start();
    screen.focus();

    await options.client.initialize();
    const sessionId = options.sessionId ?? (await options.client.createSession()).sessionId;
    await options.client.openSession(sessionId);

    function submit(value: string): void {
      const trimmed = value.trim();
      const approval = view.current.approval;
      if (approval !== null && approval.verdict === null) {
        const verdict = trimmed === 'y' ? 'once' : trimmed === 'always' ? 'always' : trimmed === 'n' ? 'reject' : null;
        if (verdict === null) {
          view.current = addNotice(view.current, 'info', 'y / n / always 三选一，再回车。');
          draw();
          return;
        }
        screen.clearInput();
        options.client.respondApproval(sessionId, approval.callId, verdict).catch((error: unknown) => {
          view.current = addNotice(view.current, 'error', message(error));
          draw();
        });
        return;
      }

      if (trimmed === '') return;
      screen.clearInput();
      view.current = withLangFrom(view.current, trimmed);
      draw();
      options.client.sendTurn(sessionId, trimmed).catch((error: unknown) => {
        // The host refuses with a sentence a user can act on ("no model is configured …",
        // "already has a turn running"); showing it verbatim is the point of that work.
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      });
    }

    return await finished;
  } finally {
    // Order matters and so does the flag: stop drawing, drop the listeners, then destroy.
    disposed = true;
    for (const off of detach) off();
    screen.destroy();
    render.destroy();
    // Not `await render.closed`: a renderer that never started tearing down would hang the
    // exit path, and the frame is already gone by now.
  }
}

async function defaultRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    // Ctrl-C is handled by this loop (see above), so the renderer must not race it.
    exitOnCtrlC: false,
    // The default puts console output in an overlay above the UI; diagnostics arrive as
    // protocol `log` notifications instead, which belong in the frame.
    consoleMode: 'disabled',
    targetFps: 30,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
