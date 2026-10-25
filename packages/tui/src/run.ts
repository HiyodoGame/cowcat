import { writeFileSync } from 'node:fs';
import { createCliRenderer, type CliRenderer } from '@opentui/core';
import type { ProtocolClient } from '@corescense/cowcat-protocol';
import { parseAtRefs } from './app/atrefs.js';
import { atCandidates } from './app/atcomplete.js';
import { lastToolCallId, paletteCommandAt, paletteMatches, parseCommand, slashMatches, type CommandEffect } from './app/commands.js';
import { intentFor } from './app/keymap.js';
import { animationsEnabled, mouseEnabled, scrollStep } from './app/preferences.js';
import { costOf, formatCost } from './app/meter.js';
import { addNotice, closeView, project, streamReasoning, streamText, streamToolOutput } from './app/project.js';
import { latestAssistantText, osc52, sessionMarkdown } from './app/workflow.js';
import {
  advanceReasoning,
  APPROVAL_CHOICES,
  approvalChoiceAt,
  closeCronPanel,
  closePalette,
  closeSlashMenu,
  closeTaskPanel,
  initialView,
  markReplayedTasks,
  moveApprovalCursor,
  moveCronPanel,
  movePalette,
  movePlanCursor,
  planAnswerAt,
  moveSlash,
  moveTaskPanel,
  openCronPanel,
  openPalette,
  openTaskPanel,
  pendingAttachments,
  resetScroll,
  selectedCronJob,
  selectedTask,
  setCronJobs,
  setPermissions,
  toggleExpanded,
  toggleThinking,
  closeHistorySearch,
  historyMatches,
  moveHistorySearch,
  openHistorySearch,
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
  readonly reconnect?: () => Promise<ProtocolClient>;
}

/** How long after a question the status bar nudges (§2.2). */
const NUDGE_AFTER_MS = 10_000;

export async function runTui(options: RunTuiOptions): Promise<number> {
  let client = options.client;
  const view = { current: initialView() };
  const render = await (options.createRenderer ?? defaultRenderer)();
  const screen = createScreen(render, THEME, { title: titleOf(options.version) });
  const detach: (() => void)[] = [];
  let disposed = false;
  let connectionGeneration = 0;
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  let exitArmUntil = 0;

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
    let attachmentGeneration = 0;
    const fetchAttachments = (): void => {
      const generation = attachmentGeneration;
      for (const attachment of pendingAttachments(view.current)) {
        if (requested.has(attachment.path)) continue;
        requested.add(attachment.path);
        client.readAttachment(attachment.path).then(
          (bytes) => {
            if (generation !== attachmentGeneration) return;
            view.current = withAttachment(view.current, {
              ...attachment,
              status: 'ready',
              bytes: Buffer.from(bytes.data, 'base64'),
              reason: null,
            });
            draw();
          },
          (error: unknown) => {
            if (generation !== attachmentGeneration) return;
            view.current = withAttachment(view.current, { ...attachment, status: 'failed', reason: message(error) });
            draw();
          },
        );
      }
    };

    subscribeClient();
    function subscribeClient(): void {
      detach.push(
        client.on('event', (event) => {
          view.current = project(view.current, event);
          if (event.type === 'approval.requested') {
            clearTimeout(nudgeTimer);
            nudgeTimer = setTimeout(draw, NUDGE_AFTER_MS);
          }
          draw();
          fetchAttachments();
        }),
        client.on('delta', (delta) => {
          view.current =
            delta.type === 'reasoning.delta'
              ? streamReasoning(view.current, delta)
              : delta.type === 'tool.output.delta'
                ? streamToolOutput(view.current, delta)
                : streamText(view.current, delta);
          draw();
        }),
        client.on('log', (line) => {
          view.current = addNotice(view.current, line.level === 'error' ? 'error' : line.level === 'warn' ? 'warn' : 'info', line.message);
          draw();
        }),
      );
      void client.closed.then(() => {
        void handleClosed();
      });
    }

    async function handleClosed(): Promise<void> {
      view.current = closeView(view.current);
      draw();
      if (options.reconnect === undefined) return;
      const generation = ++connectionGeneration;
      // Read through a function on purpose: an inline `disposed || …` in one guard
      // narrows `disposed` to false for the rest of the block, and these re-checks are
      // load-bearing — dispose or a newer reconnect can land across any `await` below.
      const stale = (): boolean => disposed || generation !== connectionGeneration;
      try {
        client = await options.reconnect();
        if (stale()) {
          client.close();
          return;
        }
        await client.initialize();
        if (stale()) {
          client.close();
          return;
        }
        subscribeClient();
        await attachSession(sessionId);
        if (stale()) {
          client.close();
          return;
        }
        view.current = addNotice(view.current, 'info', '连接已恢复。');
        draw();
      } catch (error) {
        view.current = addNotice(view.current, 'error', `重连失败：${message(error)}`);
        draw();
      }
    }

    detach.push(
      screen.onSubmit((value) => {
        submit(value);
        queueMicrotask(syncInput);
      }),
      screen.onKey((key) => {
        const intent = intentFor({ name: key.name, ctrl: key.ctrl }, view.current, Date.now(), exitArmUntil);
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
        // The task panel owns `x` and its arrows: without this the key would also be typed
        // into the composer (the textarea gets everything the global handler does not claim).
        if (
          intent !== null &&
          (intent.kind === 'taskMove' || intent.kind === 'taskStop' || intent.kind === 'tasksClose' ||
            intent.kind === 'cronMove' || intent.kind === 'cronDelete' || intent.kind === 'cronsClose')
        ) {
          key.preventDefault();
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

    await client.initialize();
    let sessionId = options.sessionId ?? (await client.createSession()).sessionId;
    await attachSession(sessionId);

    async function attachSession(id: string): Promise<void> {
      const previous = { id: sessionId, view: view.current };
      sessionId = id;
      attachmentGeneration += 1;
      requested.clear();
      view.current = { ...initialView(), fileCandidates: atCandidates(process.cwd()) };
      try {
        const opened = await client.openSession(id);
        view.current = markReplayedTasks(view.current, opened.lastSeq);
        draw();
      } catch (error) {
        sessionId = previous.id;
        view.current = previous.view;
        draw();
        throw error;
      }
    }

    function handle(intent: ReturnType<typeof intentFor>): void {
      if (intent === null) return;
      switch (intent.kind) {
        case 'quit':
          quit(0);
          return;
        case 'cancel':
          cancel();
          return;
        case 'clearInput':
          exitArmUntil = 0;
          screen.clearInput();
          view.current = withInput(view.current, '');
          draw();
          return;
        case 'armExit':
          exitArmUntil = Date.now() + 800;
          view.current = addNotice(view.current, 'info', '再按一次 Ctrl+C 退出；也可以按 Ctrl+D 或输入 /exit。');
          draw();
          return;
        case 'historySearch':
          view.current = view.current.historySearch === null ? openHistorySearch(view.current) : closeHistorySearch(view.current);
          draw();
          return;
        case 'historyMove':
          view.current = moveHistorySearch(view.current, intent.delta);
          draw();
          return;
        case 'palette':
          view.current = view.current.palette === null ? openPalette(view.current) : closePalette(view.current);
          draw();
          return;
        case 'paletteMove':
          view.current = movePalette(view.current, intent.delta, paletteMatches(view.current).length);
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
        case 'planMove':
          view.current = movePlanCursor(view.current, intent.delta);
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
        case 'taskMove':
          view.current = moveTaskPanel(view.current, intent.delta);
          draw();
          return;
        case 'tasksClose':
          view.current = closeTaskPanel(view.current);
          draw();
          return;
        case 'taskStop':
          stopSelectedTask();
          return;
        case 'cronMove':
          view.current = moveCronPanel(view.current, intent.delta);
          draw();
          return;
        case 'cronsClose':
          view.current = closeCronPanel(view.current);
          draw();
          return;
        case 'cronDelete':
          deleteSelectedCronJob();
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
          view.current = closeSlashMenu(view.current);
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
      if (id.startsWith('palette:')) {
        executePaletteCommand(Number(id.slice('palette:'.length)));
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
      if (id.startsWith('plan:')) {
        const raw = id.slice('plan:'.length);
        choosePlan(raw === 'none' ? 'none' : Number(raw));
      }
    }

    function executePaletteCommand(row: number): void {
      const command = paletteCommandAt(view.current, row);
      if (command === undefined) return;
      screen.clearInput();
      view.current = { ...closePalette(view.current), input: '' };
      apply(command.run(view.current));
    }

    /** Clicking a plan row answers the review, like clicking an approval row. */
    function choosePlan(index: number | 'none'): void {
      const plan = view.current.plan;
      if (plan === null) return;
      const cursor = index === 'none' ? plan.plans.length : index;
      if (cursor < 0 || cursor > plan.plans.length) return;
      view.current = { ...view.current, planCursor: cursor };
      draw();
      answerPlan();
    }

    /** Answer the open review with the highlighted row (Enter, click, or submit text). */
    function answerPlan(): void {
      const plan = view.current.plan;
      if (plan === null) return;
      const answer = planAnswerAt(view.current);
      screen.clearInput();
      view.current = withInput(view.current, '');
      client
        .respondPlan(
          sessionId,
          plan.callId,
          answer.kind === 'plan' ? answer.index : null,
          null,
        )
        .catch((error: unknown) => {
          view.current = addNotice(view.current, 'error', message(error));
          draw();
        });
    }

    /** Clicking an approval row answers it; a click is not a mode switch. */
    function chooseApproval(index: number): void {
      const approval = view.current.approval;
      const choice = APPROVAL_CHOICES[index];
      if (approval === null || approval.verdict !== null || choice === undefined) return;
      view.current = { ...view.current, approvalCursor: index };
      draw();
      client.respondApproval(sessionId, approval.callId, choice).catch((error: unknown) => {
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      });
    }

    /**
     * Stop the task under the panel's cursor (ADR-113).
     *
     * The panel stays open and the row does not change here: only
     * `tool.background.finished` proves a task ended, and a `true` answer from `task.stop`
     * means "the request was accepted", not "it is gone".
     */
    function stopSelectedTask(): void {
      const task = selectedTask(view.current);
      if (task === null) return;
      if (task.state !== 'running') {
        const why =
          task.state === 'unknown'
            ? '这个任务的状态未知（宿主可能已重启），不能从这里停止。'
            : '这个任务已经结束了。';
        view.current = addNotice(view.current, 'info', why);
        draw();
        return;
      }
      client
        .stopTask(sessionId, task.taskId)
        .then((stopped) => {
          if (disposed) return;
          view.current = addNotice(
            view.current,
            stopped ? 'info' : 'warn',
            stopped ? `已请求停止 ${task.taskId}，等结束事件确认。` : `${task.taskId} 已经不在运行。`,
          );
          draw();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          view.current = addNotice(view.current, 'error', message(error));
          draw();
        });
    }

    /**
     * Delete the job under the `/cron` panel's cursor (ADR-143 ③).
     *
     * The row leaves the list only when the `cron.deleted` event arrives — the method's
     * boolean means "the request was accepted", and the event is the fact that carries
     * the audit trail (`by: 'user'`).
     */
    function deleteSelectedCronJob(): void {
      const job = selectedCronJob(view.current);
      if (job === null) return;
      client
        .removeCronJob(sessionId, job.jobId)
        .then((removed) => {
          if (disposed) return;
          view.current = addNotice(
            view.current,
            removed ? 'info' : 'warn',
            removed ? `已请求删除 ${job.jobId}，等 cron.deleted 事件确认。` : `${job.jobId} 不在本会话的活任务里。`,
          );
          draw();
        })
        .catch((error: unknown) => {
          if (disposed) return;
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
        case 'tasks':
          if (view.current.approval !== null) {
            view.current = addNotice(view.current, 'info', '先回答上面那个审批，再看后台任务。');
            draw();
            return;
          }
          view.current = openTaskPanel(withInput(closePalette(view.current), ''));
          screen.clearInput();
          if (view.current.taskPanel === null) {
            view.current = addNotice(view.current, 'info', '没有后台任务。');
          }
          draw();
          return;
        case 'cron':
          if (view.current.approval !== null) {
            view.current = addNotice(view.current, 'info', '先回答上面那个审批，再看定时任务。');
            draw();
            return;
          }
          view.current = withInput(closePalette(openCronPanel(view.current)), '');
          screen.clearInput();
          draw();
          // The list the panel shows comes from the host: the fold knows the jobs exist,
          // but only the projection can say when each fires next (ADR-143 ③).
          client
            .listCronJobs(sessionId)
            .then((jobs) => {
              if (disposed) return;
              view.current = setCronJobs(view.current, jobs);
              if (jobs.length === 0) {
                view.current = addNotice(view.current, 'info', '没有定时任务（让模型用 CronCreate 建一个）。');
              }
              draw();
            })
            .catch((error: unknown) => {
              if (disposed) return;
              view.current = addNotice(view.current, 'error', message(error));
              draw();
            });
          return;
        case 'plan':
          if (view.current.plan !== null) {
            view.current = addNotice(view.current, 'info', '先回答方案选择，再切 plan 模式');
            draw();
            return;
          }
          view.current = withInput(closePalette(view.current), '');
          screen.clearInput();
          client.setPlanMode(sessionId, effect.enabled).catch((error: unknown) => {
            view.current = addNotice(view.current, 'error', message(error));
            draw();
          });
          return;
        case 'fork':
          view.current = withInput(closePalette(view.current), '');
          screen.clearInput();
          client
            .forkSession(sessionId)
            .then((forkedId) => {
              view.current = addNotice(view.current, 'info', `已 fork 出新会话：${forkedId}（cowcat sessions resume ${forkedId}）`);
              draw();
            })
            .catch((error: unknown) => {
              view.current = addNotice(view.current, 'error', message(error));
              draw();
            });
          return;
        case 'undo':
          void client
            .undoChange(sessionId)
            .then((result) => {
              view.current = addNotice(view.current, 'info', `已撤销文件变更：${result.path}`);
              draw();
            })
            .catch((error: unknown) => {
              view.current = addNotice(view.current, 'error', message(error));
              draw();
            });
          return;
        case 'redo':
          void client
            .redoChange(sessionId)
            .then((result) => {
              view.current = addNotice(view.current, 'info', `已重做文件变更：${result.path}`);
              draw();
            })
            .catch((error: unknown) => {
              view.current = addNotice(view.current, 'error', message(error));
              draw();
            });
          return;
        case 'permissions':
          void showPermissions();
          return;
        case 'revokeGrant':
          void revokePermission(effect.grantId);
          return;
        case 'resume':
          void attachSession(effect.sessionId).catch((error: unknown) => {
            view.current = addNotice(view.current, 'error', message(error));
            draw();
          });
          return;
        case 'clear':
          void client
            .createSession()
            .then((created) => attachSession(created.sessionId))
            .catch((error: unknown) => {
              view.current = addNotice(view.current, 'error', message(error));
              draw();
            });
          return;
        case 'copy': {
          const text = latestAssistantText(view.current);
          if (text === null) {
            view.current = addNotice(view.current, 'warn', '还没有可复制的助手回答。');
          } else {
            process.stdout.write(osc52(text));
            view.current = addNotice(view.current, 'info', '已通过 OSC52 请求终端复制最近一条回答（是否生效取决于终端）。');
          }
          draw();
          return;
        }
        case 'export': {
          try {
            const path = effect.path ?? `cowcat-${sessionId}.md`;
            writeFileSync(path, sessionMarkdown(view.current), 'utf8');
            view.current = addNotice(view.current, 'info', `已导出会话：${path}`);
          } catch (error) {
            view.current = addNotice(view.current, 'error', message(error));
          }
          draw();
          return;
        }
        case 'model':
          void handleModel(effect.preset, effect.effort);
          return;
        case 'compact':
          void compactCurrentSession();
          return;
        case 'cost':
          showCost();
          return;
        case 'quit':
          quit(0);
          return;
      }
    }

    async function handleModel(preset: string | null, effort: string | null | undefined): Promise<void> {
      try {
        if (preset === null && effort === undefined) {
          const result = await client.listModels(sessionId);
          if (disposed) return;
          const choices = result.models.map((item) => `${item.id}${item.efforts.length === 0 ? '' : `（effort: ${item.efforts.join('/')}）`}`).join('、');
          view.current = addNotice(view.current, 'info', `当前模型：${result.current.id}${result.current.effort === null ? '' : ` · effort=${result.current.effort}`}。可选：${choices}`);
          draw();
          return;
        }
        const target = preset ?? (await client.listModels(sessionId)).current.id;
        const current = await client.setModel(sessionId, target, effort);
        if (disposed) return;
        view.current = addNotice(view.current, 'info', `已切换模型：${current.id}${current.effort === null ? '' : ` · effort=${current.effort}`}（下一回合生效）`);
        draw();
      } catch (error) {
        if (disposed) return;
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      }
    }

    async function compactCurrentSession(): Promise<void> {
      try {
        const result = await client.compactSession(sessionId);
        if (disposed) return;
        view.current = addNotice(
          view.current,
          result.compacted ? 'info' : 'warn',
          result.compacted ? `已压缩 ${String(result.dropped)} 条历史消息，项目指令与技能已刷新。` : `没有完成压缩：${result.reason ?? '当前没有可压缩的历史'}`,
        );
        draw();
      } catch (error) {
        if (disposed) return;
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      }
    }

    function showCost(): void {
      const totals = view.current.usageTotals;
      const price = view.current.price;
      const text = `会话累计：输入 ${String(totals.input)} · 输出 ${String(totals.output)} · 缓存读 ${String(totals.cacheRead)} · 缓存写 ${String(totals.cacheCreation)}${price === null ? '' : ` · 估算成本 ${formatCost(costOf(totals, price))}`}`;
      view.current = addNotice(view.current, 'info', text);
      draw();
    }

    async function showPermissions(): Promise<void> {
      try {
        const result = await client.listGrants(sessionId);
        if (disposed) return;
        view.current = setPermissions(view.current, result.grants);
        draw();
      } catch (error) {
        if (disposed) return;
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      }
    }

    async function revokePermission(grantId: string): Promise<void> {
      try {
        const revoked = await client.revokeGrant(sessionId, grantId);
        if (disposed) return;
        view.current = addNotice(view.current, revoked ? 'info' : 'warn', revoked ? `已撤销 ${grantId}` : `${grantId} 不存在或已撤销`);
        await showPermissions();
      } catch (error) {
        if (disposed) return;
        view.current = addNotice(view.current, 'error', message(error));
        draw();
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
        const sessions = await client.listSessions();
        if (disposed) return;
        if (sessions.length === 0) {
          view.current = addNotice(view.current, 'info', '还没有会话。');
          draw();
          return;
        }
        for (const session of sessions.slice(0, 10)) {
          const current = session.sessionId === sessionId ? '（当前）' : '';
          const fork = session.parentRole === 'fork' ? ' · fork' : '';
          const facts = [session.title, session.cwd, session.model].filter((part) => part !== undefined);
          const detail = facts.length === 0 ? '' : ` · ${facts.join(' · ')}`;
          view.current = addNotice(
            view.current,
            'info',
            `${session.sessionId}${current}${fork}${detail} · ${String(session.lastSeq)} 条事件 · cowcat sessions resume ${session.sessionId}`,
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
      client.cancelTurn(sessionId).catch((error: unknown) => {
        view.current = addNotice(view.current, 'error', message(error));
        draw();
      });
    }

    function submit(value: string): void {
      const trimmed = value.trim();

      if (view.current.historySearch !== null) {
        const selected = historyMatches(view.current)[view.current.historySearch.index];
        if (selected !== undefined) {
          screen.setInput(selected);
          view.current = { ...closeHistorySearch(view.current), input: selected };
          draw();
        }
        return;
      }

      // The palette owns Enter while it is open: the input widget has focus, so this is the
      // one place a submitted line and a chosen command can be told apart.
      if (view.current.palette !== null) {
        executePaletteCommand(view.current.palette.index);
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
        apply(parsed.command.run(view.current, parsed.rest));
        return;
      }
      if (trimmed.startsWith('/')) {
        screen.clearInput();
        view.current = addNotice(view.current, 'warn', `没有这个命令：${trimmed.split(/\s+/)[0] ?? trimmed}（Ctrl-P 看全部）`);
        draw();
        return;
      }

      if (view.current.plan !== null) {
        const plan = view.current.plan;
        if (trimmed === '') {
          // Empty input + Enter is the highlighted row, like an approval answer.
          answerPlan();
          return;
        }
        const byNumber = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
        if (byNumber !== null && byNumber >= 1 && byNumber <= plan.plans.length) {
          view.current = { ...view.current, planCursor: byNumber - 1 };
          draw();
          answerPlan();
          return;
        }
        if (trimmed === 'n' || trimmed === '0') {
          view.current = { ...view.current, planCursor: plan.plans.length };
          draw();
          answerPlan();
          return;
        }
        view.current = addNotice(view.current, 'info', '↑↓ 选择 + 回车，或输入方案序号 / n（都不选）');
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
        // Escalate appeals have no `session` answer (ADR-129 2): the kernel would
        // narrow it anyway, but the habit should be told, not silently downgraded.
        if (verdict === 'session' && approval.rule === 'escalation') {
          view.current = addNotice(view.current, 'info', '申诉没有「本会话」选项：只能一次、总是（这一条）或拒绝');
          draw();
          return;
        }
        screen.clearInput();
        client.respondApproval(sessionId, approval.callId, verdict).catch((error: unknown) => {
          view.current = addNotice(view.current, 'error', message(error));
          draw();
        });
        return;
      }

      if (trimmed === '') return;
      screen.clearInput();
      view.current = resetScroll(withLangFrom(view.current, trimmed));
      draw();
      // `@` file references (ADR-128): only tokens that resolve to existing files are
      // sent; everything else (emails, npm scopes, trailing punctuation) stays text.
      // Relative paths resolve against the TUI's cwd — resume keeps the shell's cwd,
      // so a session created elsewhere reads @refs from where you are (ADR-128 ⑤).
      const files = parseAtRefs(trimmed, process.cwd());
      // The wire params type carries a mutable array (zod inference); copy the readonly
      // parse result into it — the same widening `protocol/client.ts` does for files.
      client.request('turn.send', { sessionId, input: trimmed, ...(files.length === 0 ? {} : { files: [...files] }) }).then((result) => {
        if (result.queued === true) {
          view.current = addNotice(view.current, 'info', `已排队 ${result.turnId}：当前回合结束后自动执行。`);
          draw();
        }
      }).catch((error: unknown) => {
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
