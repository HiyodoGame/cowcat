# Live MCP checks (opt-in, needs network)

Real third-party MCP servers against CowCat's own `src/mcp.js`. These are **not**
part of `npm test` (that glob is `test/*.test.mjs`): they download packages and
spawn real servers, so they run on demand — after touching the MCP client, or
before a release.

```bash
# one-time: official server + SDK used by the checks
npm install --prefix agent/test/live

node agent/test/live/stdio.mjs          # official filesystem server over stdio
node agent/test/live/http.mjs           # official SDK Streamable HTTP (stateful) + pagination
node agent/test/live/everything.mjs     # official server-everything: resources / templates / prompts
node agent/test/live/keepalive.mjs      # SSE keep-alive + a server that holds the stream open
node agent/test/live/stream-channel.mjs # server->client channel: logging / subscribe / list_changed / resume
node agent/test/live/notify-negative.mjs # what the pre-fix initialized behaviour did
node agent/test/live/cli-e2e.mjs        # full CLI: config -> trust -> model calls a real MCP tool
node agent/test/live/multimodal.mjs     # real provider: image / PDF / notebook through Read (needs a key)
node agent/test/live/multimodal-cli.mjs # real provider via the CLI: read an image, then NotebookEdit
```

Each prints `PASS`/`FAIL` per check and exits non-zero on failure.

> The two `multimodal*.mjs` checks are the exception to "no credentials needed":
> they talk to **your configured provider** (same config as CowCat, i.e.
> `COWCAT_HOME/config.json` or env). Without an API key they exit with code 2
> and a message instead of failing.

What each one covers:

| script | covers |
|---|---|
| `stdio.mjs` | launch via the documented `"command": "npx"` (Windows shim fallback), full tool chain on a real server, out-of-roots rejection, adapter error mapping, `stop()` reaping |
| `http.mjs` | `mcp-session-id` capture + echo (the session-less request is rejected with 400), SSE response bodies, `notifications/initialized` as a notification, `tools/list` cursor loop against a real paginated server |
| `everything.mjs` | official `server-everything`: `resources/list` + `resources/read` against a real implementation, and measures the gaps (templates / prompts / server→client notifications) |
| `keepalive.mjs` | SSE keep-alive (web-standard transport, `keepAliveMs`) and a server that answers then holds the stream open — the case that used to stall until the timeout |
| `stream-channel.mjs` | the server->client channel against a real SDK server (with an in-memory event store): GET stream + session id, `logging/setLevel` and logging delivery, `resources/subscribe` + `resources/updated`, a tool added after connect raising `tools/list_changed`, and a killed connection being re-opened with `Last-Event-ID` (the missed notification is replayed) |
| `notify-negative.mjs` | the old behaviour measured against a real server (documents that the SDK tolerates a request-shaped `initialized` — the fix is spec correctness, not a blocker) |
| `cli-e2e.mjs` | phase 1: project `.cowcat/mcp.json` → trust from `state.json` → real tool call → the tool output reaching the model. phase 2: the user-level config runs `server-everything` and `/mcp__everything__simple-prompt` — the prompt text is read from the server first, then asserted inside the CLI's model request (covers third-party server → slash command → model). Note the pre-trust of the cwd: an untrusted dir locks `-p` to read-only plan mode, which denies MCP tool calls |
| `multimodal.mjs` | the real Read → attachment → provider path with a live key: a synthetic three-colour image (the model must name the colours in order, so it demonstrably saw the pixels), a PDF, and a notebook — plus the token estimate vs the provider's reported `prompt_tokens`. A refusal is rendered through errfmt so it stays actionable. Measured 2026-10-16 with `glm-5.3-flash`: image / notebook / simple-PDF pass; **4/4 real-world PDFs refused** (glyph-encoded or scanned — see changelog 0.13.1) |
| `multimodal-cli.mjs` | the same two features through the real CLI: (1) an untrusted cwd (read-only plan) must still read and describe an image, (2) a trusted cwd with `-y` lets the model call `NotebookEdit` on a notebook living in a temp dir — the file must change on disk, and the trusted dir itself must stay untouched |

`paged-server.mjs` is the SDK-based fixture server used by `http.mjs`.

Env overrides: `MCP_LIVE_FS_ENTRY` (filesystem server entry) and
`MCP_LIVE_SDK` are only needed when the packages live somewhere other than
`agent/test/live/node_modules`.
