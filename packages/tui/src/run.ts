import { createCliRenderer, type CliRenderer } from '@opentui/core';
import type { ProtocolClient } from '@corescense/cowcat-protocol';
import { COMMANDS, lastToolCallId, parseCommand, type CommandEffect } from './app/commands.js';
import { intentFor } from './app/keymap.js';
import { addNotice, closeView, project, streamText } from './app/project.js';
import {
  closePalette,
  initialView,
  movePalette,
  openPalette,
  pendingAttachments,
  toggleExpanded,
  withAttachment,
  withLangFrom,
} from './app/view.js';
import { frameOf, titleOf } from './components/session-frame.js';
import { THEME } from './theme/tokens.js';
import { createScreen } from './ui/screen.js';

/**
 * `runTui` — the loop that turns a protocol client into a screen (ADR-066 ①).
 *
 * It is the composition of the four layers and nothing else: it owns the view (`app/`), hands
 * it to the frame (`components/`), the frame to the screen (`ui/`), and the screen to a
 * renderer. The kernel is not here, and cannot be: it arrives as a `ProtocolClient` — the same
 * port an IDE plugin or a script would use.
 *
 * Three ordering facts are load-bearing:
 *
 *   * **subscribe before `session.open`.** The server answers the request and *then* replays
 *     the log as `event` notifications; a subscription installed after the reply can miss the
 *     beginning of the session, and nothing in the protocol would say so.
 *   * **the renderer is started before the handshake**, so a slow handshake (reading config,
 *     resolving a shell, loading a model) shows an empty frame with a status line instead of a
 *     blank terminal that looks like a hang.
 *   * **nothing draws after teardown.** A `client.closed` handler fires *after* the finally
 *     below has destroyed the renderer (closing the client is what resolves it), and a draw
 *     then hits a dead native scene: it throws, exits non-zero, and skips the host's `close()`
 *     — measured, and the reason for the `disposed` flag.
 */
export interface RunTuiOptions {
  readonly client: ProtocolClient;
  /** `null` starts a new session; the id comes back from the host. */
  readonly sessionId: string | null;
  readonly version: string;
  /** Injected so tests can drive the loop without a real terminal. */
  readonly createRenderer?: () => Promise<CliRenderer>;
}

/** How long after a question the status bar nudges (§2.2). */
const NUDGE_AFTER_MS = 10_000;

export async function runTui(options: RunTuiOptions): Promise<number> {
  const view = { current: initialView() };
  const render = await (options.createRenderer ?? defaultRenderer)();
  const screen = createScreen(render, THEME, { title: titleOf(options.version) });
  const detach: (() => void)[] = [];
  let disposed = false;
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;

  const draw = (): void => {
    // The width is the renderer's to know (and it changes on resize); the clock is injected
    // because a component that read it would not be a pure function.
    if (disposed) return;
    screen.update(frameOf(view.current, { width: screen.contentWidth(), now: Date.now() }));
  };

  let quit: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    quit = resolve;
  });

  try {
    /**
     * Fetch the bytes of every attachment the log has referenced (ADR-057).
     *
     * Eagerly, because this transport is in-process: `attachment.read` is a function call, not
     * a round trip. A frontend connected to a `serve` process would fetch when a card is
     * actually on screen instead — that is a T10 question, and the state machine
     * (`loading`/`ready`/`failed`) is already the shape it would need.
     */
    const requested = new Set<string>();
    const fetchAttachments = (): void => {
      for (const attachment of pendingAttachments(view.current)) {
        if (requested.has(attachment.path)) continue;
        requested.add(attachment.path);
        options.client.readAttachment(attachment.path).then(
          (bytes) => {
            view.current = withAttachment(view.current, {
              ...attachment,
              status: 'ready',
              bytes: Buffer.from(bytes.data, 'base64'),
              reason: null,
            });
            draw();
          },
          (error: unknown) => {
            // Refused with a reason ("too big", "no such attachment", "the file is gone"):
            // the card shows it rather than pretending there was no image.
            view.current = withAttachment(view.current, { ...attachment, status: 'failed', reason: message(error) });
            draw();
          },
        );
      }
    };

    detach.push(
      options.client.on('event', (event) => {
        view.current = project(view.current, event);
        // A question nobody answers is the one thing that has to reach the screen on its own:
        // every other redraw is triggered by something arriving.
        if (event.type === 'approval.requested') {
          clearTimeout(nudgeTimer);
          nudgeTimer = setTimeout(draw, NUDGE_AFTER_MS);
        }
        draw();
        fetchAttachments();
      }),
      options.client.on('delta', (delta) => {
        view.current = streamText(view.current, delta);
        draw();
      }),
      options.client.on('log', (line) => {
        // The server's own diagnostics are not session facts (ADR-055), so they are shown as a
        // notice and never merged into the transcript's durable half.
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
        handle(intentFor({ name: key.name, ctrl: key.ctrl }, view.current));
      }),
    );

    draw();
    render.start();
    screen.focus();

    await options.client.initialize();
    const sessionId = options.sessionId ?? (await options.client.createSession()).sessionId;
    await options.client.openSession(sessionId);

    function handle(intent: ReturnType<typeof intentFor>): void {
      if (intent === null) return;
      switch (intent.kind) {
        case 'quit':
          quit(0);
          return;
        case 'cancel':
          cancel();
          return;
        case 'palette':
          view.current = view.current.palette === null ? openPalette(view.current) : closePalette(view.current);
          draw();
          return;
        case 'paletteMove':
          view.current = movePalette(view.current, intent.delta, COMMANDS.length);
          draw();
          return;
        case 'toggleLastCard': {
          const callId = lastToolCallId(view.current);
          if (callId !== null) view.current = toggleExpanded(view.current, callId);
          draw();
          return;
        }
      }
    }

    function apply(effect: CommandEffect): void {
      switch (effect.kind) {
        case 'view':
          view.current = effect.view;
          draw();
          return;
        case 'notice':
          view.current = addNotice(view.current, effect.level, effect.text);
          draw();
          return;
        case 'cancel':
          cancel();
          return;
        case 'quit':
          quit(0);
          return;
      }
    }

    function cancel(): void {
      // Only worth a round trip if something is running; the host would refuse otherwise and
      // the user would get an error for pressing Escape at the wrong moment.
      const state = view.current.turn?.state;
      if (state === undefined || TERMINAL.has(state)) return;
      options.client.cancelTurn(sessionId).catch((error: unknown) => {
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      });
    }

    function submit(value: string): void {
      const trimmed = value.trim();

      // The palette owns Enter while it is open: the input widget has focus, so this is the
      // one place a submitted line and a chosen command can be told apart.
      if (view.current.palette !== null) {
        const command = COMMANDS[view.current.palette.index];
        if (command !== undefined) {
          screen.clearInput();
          apply(command.run(view.current));
        }
        return;
      }

      // `/command`: the same table, reached by typing.
      const parsed = parseCommand(trimmed);
      if (parsed !== null) {
        screen.clearInput();
        apply(parsed.command.run(view.current));
        return;
      }
      if (trimmed.startsWith('/')) {
        screen.clearInput();
        view.current = addNotice(view.current, 'warn', `没有这个命令：${trimmed.split(/\s+/)[0] ?? trimmed}（Ctrl-P 看全部）`);
        draw();
        return;
      }

      const approval = view.current.approval;
      if (approval !== null && approval.verdict === null) {
        const verdict =
          trimmed === 'y'
            ? 'once'
            : trimmed === 'always'
              ? 'always'
              : trimmed === 's'
                ? 'session'
                : trimmed === 'n'
                  ? 'reject'
                  : null;
        if (verdict === null) {
          view.current = addNotice(view.current, 'info', 'y / n / always / s 四选一，再回车。');
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
    clearTimeout(nudgeTimer);
    for (const off of detach) off();
    screen.destroy();
    render.destroy();
    // Not `await render.closed`: a renderer that never started tearing down would hang the
    // exit path, and the frame is already gone by now.
  }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

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
