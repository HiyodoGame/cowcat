# 用 tools/proxy/server.mjs 观察 CowCat 的真实出站请求

`tools/proxy/server.mjs` 是一个日志代理：把请求转发给上游 LLM API，同时把完整的请求/响应报文记录到 `logs/capture/`。CowCat 只需要把 `COWCAT_BASE_URL` 指向代理即可，零代码改动。

## 1. 启动代理

```bash
# Anthropic 协议（Claude / Kimi for Coding / 任何 Anthropic 兼容端点）
node tools/proxy/server.mjs --port 8787 --upstream https://api.anthropic.com

# OpenAI 兼容协议（DeepSeek、Moonshot、通义、Volcengine Ark 等）
node tools/proxy/server.mjs --port 8787 --upstream https://openai.app.msh.team/v1
# 代理会以 <upstream>/chat/completions 形式拼接路径
```

每次请求会写入 `logs/capture/<时间戳>-<序号>-req.json` / `-res.json`（响应体可能按 SSE chunk 分多条落盘）。注意代理会把 `x-api-key` 打码。

## 2. 让 CowCat 走代理

代理监听的是 `http://127.0.0.1:8787`，而 CowCat 会自己拼接 `{baseURL}/v1/messages`（anthropic）或 `{baseURL}/chat/completions`（openai）。OpenAI 模式可以直接用；anthropic 模式收到的路径天然带 `/v1`。CowCat 侧这样配：

```bash
# Anthropic 协议
export COWCAT_PROVIDER=anthropic
export COWCAT_BASE_URL=http://127.0.0.1:8787       # cowcat POST {baseURL}/v1/messages
export COWCAT_API_KEY=sk-ant-...
export COWCAT_MODEL=claude-sonnet-4-5
node agent/bin/cowcat.mjs --yolo "say hi"

# OpenAI 兼容协议
export COWCAT_PROVIDER=openai
export COWCAT_BASE_URL=http://127.0.0.1:8787       # cowcat POST {baseURL}/chat/completions
export COWCAT_API_KEY=sk-...
export COWCAT_MODEL=doubao-seed-1-6-251015
node agent/bin/cowcat.mjs --yolo "say hi"
```

> 过渡期 `CC_*` 环境变量仍然有效（`COWCAT_*` 优先）——见 `agent/src/config.js` 的 `envPick`。

## 3. 观察点

- **请求体**：`system` 字段（分层 system prompt 最终长什么样）、`tools[].input_schema`、`messages` 数组中 `tool_use` / `tool_result` 的相邻关系与 `tool_use_id` 配对。
- **流式事件**：anthropic 模式看 `message_start → content_block_start/delta/stop → message_delta → message_stop` 的完整序列；openai 模式看 `choices[].delta` 累积与 `[DONE]`。
- **重试**：制造 429/5xx（如把 `--upstream` 指向一个总是 500 的地址）可观察 cowcat 的指数退避（1s/2s/4s，最多 3 次重试）；401/403 应立即报配置错误且不重试。
- **compact**：把 `COWCAT_MAX_CONTEXT_TOKENS` 调小（如 500），多聊几轮触发自动压缩，对比 compact 前后请求体里 `messages` 的变化。
- **会话回放**：`cowcat` 打印的 `session:` 路径（`~/.cowcat/projects/<slug>/<ts>.jsonl`）与 capture 目录里的请求一一对应，可用来核对每次 API 往返。

## 4. 无 key 的 dry-run

没有真实 key 时，可用 `--upstream` 指向一个本地回显服务器（如 `nc -l` 或自写 10 行 http server 返回 401），确认 cowcat 的 URL 拼接、headers（`x-api-key`、`anthropic-version`、`authorization`）与错误提示符合预期。

## 5. 一键 live 验证

`bash tools/run-ccagent-kimi.sh`（需要 `.keys.env` 里的 `MOONSHOT_API_KEY`）会通过代理跑一条真实任务并把抓包写到 `logs/ccagent-capture/`。
