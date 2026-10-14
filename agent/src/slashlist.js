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
