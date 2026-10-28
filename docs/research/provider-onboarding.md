# 服务商配置与首次启用调研

日期：2026-10-28。目标：解决未配置模型时只有错误，以及新增服务商只保存名称的问题。

## 官方做法

| Agent | 【上游】配置方式 | 对本批的约束 |
|---|---|---|
| OpenCode | [Providers](https://opencode.ai/docs/providers/)：`/connect` 管理凭据；自定义 provider 要声明协议实现、`baseURL` 和模型表，模型可带 context/output limit | 模板与自定义分开；模型是配置的一部分，不是保存名称后再猜 |
| Codex | [高级配置](https://developers.openai.com/codex/config-file/config-advanced)：provider 由 `base_url`、wire API、认证和可选请求头组成；`model` / `model_provider` 选择连接目标。[配置参考](https://developers.openai.com/codex/config-reference) 另有 context window | 协议、端点、环境变量引用与模型一起确认 |
| Claude Code | [设置](https://code.claude.com/docs/en/settings)：`/model` 可保存默认模型，部分配置可在运行会话中生效。[模型配置](https://code.claude.com/docs/en/model-config)：别名与完整模型 ID 分开 | 保存后应应用选择；缺 key 仍须明确提示，不能假装已可用 |

Exa 接口在本次会话不可用，因此直接读取官方页面；未以第三方博客作为实现依据。

## 本仓缺口【源码】

- `packages/tui/src/run.ts:1525` 的发送失败分支只调用 `addNotice`，没有读取结构化 `data.problem`，也没有保存待恢复草稿。
- `packages/tui/src/app/view.ts:453` 的 `providerEdit` 只有 `name/baseUrl/apiKeyEnv` 三个字段；`beginProviderAdd` 只创建名称输入。
- `packages/protocol/src/methods.ts:122` 的 `provider.set` 仅接受 `baseUrl/apiKeyEnv`，没有 preset、模型定义或激活选择。
- `packages/cowcat/src/adapters/providers.ts:52` 只写 `model.providers`，不写 `model.presets` 或 `model.preset`。
- `packages/cowcat/src/host/model.ts:73` 已支持 OpenAI / Anthropic 自定义 preset、limits 和 toolCalls；已有内核能力无需改写。
- `packages/cowcat/src/host/host.ts:738` 的模型配置在构造时读取，普通 provider 编辑不更新运行中的选择。

## 决定与实现

1. 用 `provider.configure` 原子写 provider、preset 和可选默认选择，保留 `provider.set` 的低级字段补丁兼容；TUI 不再走名称-only 流程。
2. 内置模板使用已有 `BUILTIN_PROVIDERS/PRESETS`；自定义向导必须填写协议、端点、key 引用、模型 ID 和必要限额。未知 context 不虚构，Anthropic output 必填。
3. 只保存 `apiKeyEnv` 名称，不接收密钥值。缺 key 可保存完整配置，但结果必须提示需要重开进程，不能称为 ready。
4. 未配置模型的发送保留 `{input, files}` 并打开向导；保存后恢复草稿，由用户再次按 Enter，不自动消费。
5. 配置写入沿用单文档读改写、临时文件 + rename、0600；损坏 JSON 拒绝覆盖，保留其它配置与未知字段。
6. 编辑 preset 时合并已知字段并保留 effort、价格与厂商扩展项；非法配置以 `hostRefused` 拒绝，不落半截配置。

## 验证边界

本批不调用真实付费端点。已用真实协议和假 transport 验证保存/应用，并补充真实键盘流程；不将这些结果写成真实终端观感或远端 CI 证据。
