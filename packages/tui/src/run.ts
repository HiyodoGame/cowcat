import { createCliRenderer, type CliRenderer } from '@opentui/core';
import type { ProtocolClient } from '@corescense/cowcat-protocol';
import { COMMANDS, lastToolCallId, parseCommand, slashMatches, type CommandEffect } from './app/commands.js';
import { intentFor } from './app/keymap.js';
import { animationsEnabled, mouseEnabled, scrollStep } from './app/preferences.js';
import { addNotice, closeView, project, streamReasoning, streamText, streamToolOutput } from './app/project.js';
import {
  advanceReasoning,
  APPROVAL_CHOICES,
  approvalChoiceAt,
  closePalette,
  initialView,
  moveApprovalCursor,
  movePalette,
  moveSlash,
  openPalette,
  pendingAttachments,
  rememberInput,
  resetScroll,
  toggleExpanded,
  toggleThinking,
  withAttachment,
  withHistory,
  withInput,
  withLangFrom,
  withScroll,
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
    screen.update(
      frameOf(view.current, { width: screen.contentWidth(), height: screen.contentHeight(), now: Date.now() }),
    );
    syncActivity();
  };

  /**
   * The spinner tick, and its off switch.
   *
   * Only while a turn is running: an idle terminal must not be repainted ten times a second,
   * and a snapshot with a fixed clock stays deterministic. `COWCAT_ANIMATIONS=off` keeps the
   * status word but freezes the cell, which is the CI- and screenshot-friendly mode.
   */
  const activity: { timer: ReturnType<typeof setInterval> | null } = { timer: null };
  const animationsOff = !animationsEnabled(process.env);
  const wheelStep = scrollStep(process.env);
  const syncActivity = (): void => {
    const state = view.current.turn?.state;
    const running = state !== undefined && !TERMINAL.has(state);
    const want = running && !animationsOff && !disposed;
    if (want && activity.timer === null) {
      // 20fps: fast enough that a spinner reads as motion and a chunk of reasoning can be
      // revealed a few characters at a time, slow enough that a long transcript is not
      // rebuilt 60 times a second.
      activity.timer = setInterval(() => {
        const total = Array.from(view.current.reasoningStream).length;
        const remaining = total - view.current.reasoningShown;
        if (remaining > 0) {
          view.current = advanceReasoning(view.current, Math.max(2, Math.ceil(remaining / 6)));
        }
        draw();
      }, 50);
    } else if (!want && activity.timer !== null) {
      clearInterval(activity.timer);
      activity.timer = null;
    }
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
        // Three ephemeral channels now (ADR-098/109); the loop routes by type rather than
        // feeding everything to one stream.
        view.current =
          delta.type === 'reasoning.delta'
            ? streamReasoning(view.current, delta)
            : delta.type === 'tool.output.delta'
              ? streamToolOutput(view.current, delta)
              : streamText(view.current, delta);
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
        queueMicrotask(syncInput);
      }),
      screen.onKey((key) => {
        const intent = intentFor({ name: key.name, ctrl: key.ctrl }, view.current);
        // ↑/↓ belong to the composer's cursor until there is nowhere left to move (ADR-106).
        // `intent` is checked first so an open menu or question keeps the keys, and Shift is
        // excluded because it extends a selection (`select-up`/`select-down`) — taking it would
        // swap the selection for a recalled line. Consuming a plain arrow means `preventDefault`:
        // global keypress listeners run before the focused renderable, and opentui skips the
        // renderable when the event is already handled — without it the textarea would move
        // anyway and the recalled line would be edited in the wrong place.
        if (
          intent === null &&
          !key.ctrl &&
          !key.meta &&
          !key.shift &&
          (key.name === 'up' || key.name === 'down')
        ) {
          const older = key.name === 'up';
          const atEdge = older ? screen.cursorRow() === 0 : screen.cursorRow() >= screen.inputLineCount() - 1;
          if (atEdge) {
            const next = withHistory(view.current, older ? 'older' : 'newer');
            if (next !== view.current) {
              key.preventDefault();
              view.current = next;
              screen.setInput(next.input);
              draw();
            }
          }
        }
        handle(intent);
        // The input widget swallows the printable keys, so its value is read back rather
        // than reconstructed: one source of truth for both hinting and what is sent.
        queueMicrotask(syncInput);
      }),
      screen.onHit(handleHit),
      screen.onScroll((delta) => {
        view.current = withScroll(view.current, delta * wheelStep);
        draw();
      }),
    );

    draw();
    render.start();
    // The frame is laid out from `renderer.width/height`, so a resize has to produce a new
    // frame: without this the old frame is reused until the next unrelated event, and the
    // first redraw after a resize reflows everything at once — which reads as the picture
    // being squeezed rather than scrolled.
    const onResize = (): void => {
      draw();
    };
    render.on('resize', onResize);
    detach.push(() => {
      render.off('resize', onResize);
    });
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
        case 'toggleThinking':
          view.current = toggleThinking(view.current);
          draw();
          return;
        case 'approvalMove':
          view.current = moveApprovalCursor(view.current, intent.delta);
          draw();
          return;
        case 'scroll':
          view.current = withScroll(view.current, intent.delta);
          draw();
          return;
        case 'scrollBottom':
          view.current = resetScroll(view.current);
          draw();
          return;
        case 'slashMove': {
          const count = slashMatches(view.current.input).length;
          view.current = moveSlash(view.current, intent.delta, count);
          draw();
          return;
        }
        case 'slashAccept': {
          const matches = slashMatches(view.current.input);
          const command = matches[view.current.slashIndex % Math.max(1, matches.length)];
          if (command !== undefined) {
            screen.setInput(`/${command.name} `);
            view.current = withInput(view.current, `/${command.name} `);
          }
          draw();
          return;
        }
        case 'slashClose':
          screen.clearInput();
          view.current = withInput(view.current, '');
          draw();
          return;
      }
    }

    /**
     * A click, decoded. The UI layer only carries the id (`tool:<callId>`,
     * `thinking`, `approval:<n>`, `scroll:bottom`); what each means is a decision for this loop.
     */
    function handleHit(id: string): void {
      if (id.startsWith('tool:')) {
        view.current = toggleExpanded(view.current, id.slice('tool:'.length));
        draw();
        return;
      }
      if (id === 'thinking') {
        view.current = toggleThinking(view.current);
        draw();
        return;
      }
      if (id.startsWith('slash:')) {
        const row = Number(id.slice('slash:'.length));
        const matches = slashMatches(view.current.input);
        const command = matches[row];
        if (command !== undefined) {
          screen.clearInput();
          view.current = withInput(view.current, '');
          apply(command.run(view.current));
        }
        return;
      }
      if (id === 'scroll:bottom') {
        view.current = resetScroll(view.current);
        draw();
        return;
      }
      if (id.startsWith('approval:')) {
        chooseApproval(Number(id.slice('approval:'.length)));
      }
    }

    /** Clicking an approval row answers it; a click is not a mode switch. */
    function chooseApproval(index: number): void {
      const approval = view.current.approval;
      const choice = APPROVAL_CHOICES[index];
      if (approval === null || approval.verdict !== null || choice === undefined) return;
      view.current = { ...view.current, approvalCursor: index };
      draw();
      options.client.respondApproval(sessionId, approval.callId, choice).catch((error: unknown) => {
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      });
    }

    /** Mirror the input widget's value into the view; the frame hints at `/` from it. */
    function syncInput(): void {
      if (disposed) return;
      screen.syncInputSize();
      const value = screen.inputValue();
      if (value === view.current.input) return;
      view.current = withInput(view.current, value);
      draw();
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
        case 'sessions':
          void showSessions();
          return;
        case 'quit':
          quit(0);
          return;
      }
    }

    /**
     * `/sessions`: the ids and the command that reopens one.
     *
     * Listing only. Switching in place would need the event stream filtered by session id
     * (every replay event currently lands in one view), and a half-done switch is worse than
     * a command the user can copy.
     */
    async function showSessions(): Promise<void> {
      try {
        const sessions = await options.client.listSessions();
        if (disposed) return;
        if (sessions.length === 0) {
          view.current = addNotice(view.current, 'info', '还没有会话。');
          draw();
          return;
        }
        for (const session of sessions.slice(0, 10)) {
          const current = session.sessionId === sessionId ? '（当前）' : '';
          view.current = addNotice(
            view.current,
            'info',
            `${session.sessionId}${current} · ${String(session.lastSeq)} 条事件 · cowcat sessions resume ${session.sessionId}`,
          );
        }
        draw();
      } catch (error) {
        if (disposed) return;
        view.current = addNotice(view.current, 'error', message(error));
        draw();
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

      // The `/` menu owns Enter while it is open: the highlighted row is what runs. A space
      // in the input closes the menu (slashMatches returns []), so Enter then sends text.
      const slash = slashMatches(trimmed);
      const slashCommand = slash[view.current.slashIndex % Math.max(1, slash.length)];
      if (slashCommand !== undefined) {
        screen.clearInput();
        view.current = withInput(view.current, '');
        apply(slashCommand.run(view.current));
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
        // Empty input + Enter is the highlighted row; a typed letter is the old habit.
        const verdict =
          trimmed === ''
            ? approvalChoiceAt(view.current)
            : trimmed === 'y'
              ? 'once'
              : trimmed === 'always'
                ? 'always'
                : trimmed === 's'
                  ? 'session'
                  : trimmed === 'n'
                    ? 'reject'
                    : null;
        if (verdict === null) {
          view.current = addNotice(view.current, 'info', '↑↓ 选择 + 回车，或输入 y / n / always / s。');
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
      view.current = rememberInput(resetScroll(withLangFrom(view.current, trimmed)), trimmed);
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
    if (activity.timer !== null) clearInterval(activity.timer);
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
    // Without this the renderer never asks the terminal for mouse events, so every
    // `onMouseDown`/`onMouseScroll` handler in `ui/screen.ts` is dead code. It also takes
    // over native selection; `COWCAT_MOUSE=off` is the documented way back.
    useMouse: mouseEnabled(process.env),
    targetFps: 60,
    maxFps: 60,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
