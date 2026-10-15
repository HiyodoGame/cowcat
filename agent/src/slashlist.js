// Slash command registry for TUI tab completion: the built-in command names
// the REPL dispatch chain in bin/cowcat.mjs understands (kept in sync with the
// /help listing). Static list — no dynamic availability gates exist yet.
export function slashCommandList() {
  return [
    '/act', '/agents', '/clear', '/compact', '/context', '/cost', '/diff', '/exit',
    '/export', '/fork', '/help', '/hooks', '/ide', '/init', '/mcp', '/memory',
    '/model', '/output', '/output-style', '/permissions', '/plan', '/quit',
    '/rewind', '/setup', '/skills', '/status', '/statusline', '/tasks', '/theme',
    '/thinking', '/todos', '/worktree',
  ];
}

// One-line descriptions for the popup slash menu: { name, zh, en } per command,
// covering exactly slashCommandList(). Descriptions are short enough to sit in
// an 80-column menu row next to the command name.
export function slashCommandDocs() {
  return [
    { name: '/act', zh: '切换到执行模式，批准写操作', en: 'Switch to act mode (approve writes)' },
    { name: '/agents', zh: '查看内建与自定义子代理角色', en: 'List builtin and custom subagent roles' },
    { name: '/clear', zh: '清空当前对话上下文', en: 'Clear the conversation context' },
    { name: '/compact', zh: '压缩对话，可选自定义指令', en: 'Compact the conversation (optional instructions)' },
    { name: '/context', zh: '查看上下文占用明细报告', en: 'Show context usage report' },
    { name: '/cost', zh: '查看本次会话用量与花费', en: 'Show session usage and cost' },
    { name: '/diff', zh: '查看本回合的文件改动', en: 'Show this turn\'s file changes' },
    { name: '/exit', zh: '退出 CowCat', en: 'Exit CowCat' },
    { name: '/export', zh: '导出会话为 Markdown 文件', en: 'Export the session to Markdown' },
    { name: '/fork', zh: '分叉当前会话到新文件', en: 'Fork the session into a new file' },
    { name: '/help', zh: '列出全部斜杠命令', en: 'List all slash commands' },
    { name: '/hooks', zh: '查看或测试钩子配置', en: 'View or test hook configuration' },
    { name: '/ide', zh: '查看 IDE 连接状态', en: 'Show IDE connection status' },
    { name: '/init', zh: '起草并写入 COWCAT.md 项目说明', en: 'Draft and write COWCAT.md project guide' },
    { name: '/mcp', zh: '查看或重连 MCP 服务器', en: 'List or reconnect MCP servers' },
    { name: '/memory', zh: '查看或追加记忆文件', en: 'View or append memory files' },
    { name: '/model', zh: '查看或切换当前模型', en: 'Show or switch the current model' },
    { name: '/output', zh: '查看最近一条命令输出', en: 'Show the last command output' },
    { name: '/output-style', zh: '切换输出风格', en: 'Switch the output style' },
    { name: '/permissions', zh: '管理 allow/deny/ask 权限规则', en: 'Manage allow/deny/ask permission rules' },
    { name: '/plan', zh: '切换到只读计划模式', en: 'Switch to read-only plan mode' },
    { name: '/quit', zh: '退出 CowCat', en: 'Quit CowCat' },
    { name: '/rewind', zh: '回滚到之前的检查点', en: 'Rewind to a previous checkpoint' },
    { name: '/setup', zh: '运行配置向导并体检', en: 'Run the setup wizard and doctor' },
    { name: '/skills', zh: '列出已加载的 skills', en: 'List loaded skills' },
    { name: '/status', zh: '查看版本/模型/权限/上下文状态', en: 'Show version/model/permissions/context status' },
    { name: '/statusline', zh: '设置或清除自定义状态栏', en: 'Set or clear the custom statusline' },
    { name: '/tasks', zh: '查看或结束后台任务', en: 'List or kill background tasks' },
    { name: '/theme', zh: '切换暗色/亮色主题', en: 'Switch dark/light theme' },
    { name: '/thinking', zh: '查看最近的思考链', en: 'Show recent thinking blocks' },
    { name: '/todos', zh: '查看当前 todo 列表', en: 'Show the todo list' },
    { name: '/worktree', zh: '创建或列出 git worktree', en: 'Create or list git worktrees' },
  ];
}
