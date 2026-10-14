#!/usr/bin/env bash
# Phase 3 scenario-matrix sampler.
# Routes Claude Code -> local logging proxy -> Kimi Anthropic-compatible endpoint,
# neutralizing ~/.claude/settings.json env overrides for the duration of the run.
# Prereq: .keys.env in project root containing: MOONSHOT_API_KEY=sk-...
# Usage: bash tools/run-scenarios.sh [scenario ...]   (default: all)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source .keys.env

# Claude Code on Windows needs an explicit pointer to git-bash (not on default PATH)
export CLAUDE_CODE_GIT_BASH_PATH='E:\WorkSoftwares\Git\bin\bash.exe'

UPSTREAM="https://api.kimi.com/coding"
PORT=8787
MODEL_MAIN="kimi-for-coding"
MODEL_SMALL="kimi-for-coding"   # Kimi Code 会员端点单一模型，所有档位同模型

# --- 0. sandbox demo repo -----------------------------------------------------
SB=sandbox/demo-repo
mkdir -p "$SB/src"
cat > "$SB/package.json" <<'EOF'
{"name":"demo-repo","version":"0.1.0","description":"sandbox for capture scenarios"}
EOF
cat > "$SB/src/index.js" <<'EOF'
// Adds two numbers. TODO: support string coercion safely
function add(a, b) {
  return a - b; // BUG: should be a + b
}
const [,, x, y] = process.argv;
console.log(`result: ${add(Number(x), Number(y))}`);
EOF
cat > "$SB/README.md" <<'EOF'
# demo-repo
A tiny sandbox repo used for Claude Code reverse-engineering capture scenarios.
TODO: write real docs
EOF
node -e "
let s='// generated filler for compact-scenario context pressure\n';
for(let i=0;i<1200;i++) s+='export const var'+i+' = '+i+'; // padding line '+i+'\n';
require('fs').writeFileSync('$SB/src/big.js', s);
"

# --- 1. neutralize settings.json env overrides (with guaranteed restore) ------
SETTINGS_BACKUP=""
if node -e "
const fs=require('fs'),os=require('os'),path=require('path');
const p=path.join(os.homedir(),'.claude','settings.json');
const c=JSON.parse(fs.readFileSync(p,'utf8'));
process.exit(c.env && Object.keys(c.env).some(k=>k.startsWith('ANTHROPIC')) ? 0 : 1);
" 2>/dev/null; then
  SETTINGS_FILE="$HOME/.claude/settings.json"
  [ -f "$SETTINGS_FILE" ] || SETTINGS_FILE="$(node -e 'console.log(require("os").homedir().replace(/\\/g,"/")+"/.claude/settings.json")')"
  SETTINGS_BACKUP="$SETTINGS_FILE.ccbak"
  cp "$SETTINGS_FILE" "$SETTINGS_BACKUP"
  node -e "
const fs=require('fs');
const p=process.argv[1];
const c=JSON.parse(fs.readFileSync(p,'utf8'));
for(const k of Object.keys(c.env||{})) if(k.startsWith('ANTHROPIC')) delete c.env[k];
fs.writeFileSync(p,JSON.stringify(c,null,2));
" "$SETTINGS_FILE"
  echo "[setup] settings.json ANTHROPIC_* env neutralized (backup: $SETTINGS_BACKUP)"
fi
restore_settings() {
  if [ -n "$SETTINGS_BACKUP" ] && [ -f "$SETTINGS_BACKUP" ]; then
    cp "$SETTINGS_BACKUP" "${SETTINGS_BACKUP%.ccbak}"
    echo "[cleanup] settings.json restored"
  fi
}
trap restore_settings EXIT

# --- 2. shared run helper ------------------------------------------------------
run_scenario() {
  local name="$1"; shift
  local compact_window="$1"; shift
  local prompt="$1"
  echo "=== scenario: $name ==="
  rm -rf logs/capture && mkdir -p logs/capture
  (
    cd "$SB"
    env ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
        ANTHROPIC_AUTH_TOKEN="$MOONSHOT_API_KEY" \
        ANTHROPIC_MODEL="$MODEL_MAIN" \
        ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL_MAIN" \
        ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL_MAIN" \
        ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL_SMALL" \
        ANTHROPIC_DEFAULT_FABLE_MODEL="$MODEL_MAIN" \
        CLAUDE_CODE_SUBAGENT_MODEL="$MODEL_MAIN" \
        ${compact_window:+CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="$compact_window"} \
        claude -p "$prompt" --permission-mode bypassPermissions --model "$MODEL_MAIN" \
        > "../../logs/scenarios/$name/cli-output.txt" 2>&1
  ) || echo "[warn] scenario $name exited non-zero (captured anyway)"
  rm -rf "logs/scenarios/$name/capture"
  cp -r logs/capture "logs/scenarios/$name/capture"
  node tools/parser/parse-capture.mjs --dir "logs/scenarios/$name/capture" \
      --out "logs/scenarios/$name/report.md" || true
  echo "--- done: $name"
}

mkdir -p logs/scenarios

# --- 3. start proxy ------------------------------------------------------------
node tools/proxy/server.mjs --port $PORT --upstream "$UPSTREAM" \
    --upstream-key "$MOONSHOT_API_KEY" --log-dir logs/capture > logs/proxy-run.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null; restore_settings' EXIT
sleep 1.5

# --- 4. scenario matrix ---------------------------------------------------------
declare -A SCENARIOS=(
  [cold-hello]="|你好，用一句话介绍你自己"
  [read-file]="|阅读 src/index.js 并说明它做了什么"
  [edit-bash]="|修复 src/index.js 里的 bug，然后运行 node src/index.js 3 4 验证结果"
  [todo-task]="|请分步骤完成：给 src/index.js 添加 --version 参数支持，每完成一步更新进度"
  [subagent-explore]="|在这个仓库里找出所有 TODO 注释的位置并汇总成清单"
  [compact-pressure]="3|先阅读 src/big.js 的所有内容，然后给我讲一个笑话"
  [compact-force]="3|阅读 src/big.js 的前 400 行，然后简述这个文件的结构"
  [subagent-force]="|请使用 Task 工具启动一个子代理，让它找出仓库中所有 TODO 注释，你把子代理的结果汇总给我"
)

SCENARIO_ORDER=(cold-hello read-file edit-bash todo-task subagent-explore compact-pressure compact-force subagent-force)

PICKED=("$@")
[ ${#PICKED[@]} -eq 0 ] && PICKED=("${SCENARIO_ORDER[@]}")

for name in "${PICKED[@]}"; do
  if [ -z "${SCENARIOS[$name]:-}" ]; then echo "[skip] unknown scenario: $name"; continue; fi
  IFS='|' read -r window prompt <<< "${SCENARIOS[$name]}"
  mkdir -p "logs/scenarios/$name"
  run_scenario "$name" "$window" "$prompt"
done

# multi-turn memory scenario (--continue keeps one conversation across runs)
if [ ${#PICKED[@]} -eq ${#SCENARIOS[@]} ] || printf '%s\n' "${PICKED[@]}" | grep -qx multi-turn; then
  name=multi-turn
  mkdir -p "logs/scenarios/$name"
  echo "=== scenario: $name ==="
  rm -rf logs/capture && mkdir -p logs/capture
  (
    cd "$SB"
    for turn in "请记住数字 42816，只回复收到" "我刚才让你记住的数字是多少？只回答数字"; do
      env ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
          ANTHROPIC_AUTH_TOKEN="$MOONSHOT_API_KEY" \
          ANTHROPIC_MODEL="$MODEL_MAIN" \
          ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL_SMALL" \
          ANTHROPIC_DEFAULT_FABLE_MODEL="$MODEL_MAIN" \
          CLAUDE_CODE_SUBAGENT_MODEL="$MODEL_MAIN" \
          claude -p "$turn" --continue --permission-mode bypassPermissions --model "$MODEL_MAIN" \
          >> "../../logs/scenarios/$name/cli-output.txt" 2>&1
    done
  ) || echo "[warn] multi-turn exited non-zero (captured anyway)"
  rm -rf "logs/scenarios/$name/capture"
  cp -r logs/capture "logs/scenarios/$name/capture"
  node tools/parser/parse-capture.mjs --dir "logs/scenarios/$name/capture" \
      --out "logs/scenarios/$name/report.md" || true
  echo "--- done: $name"
fi

echo "All scenarios finished. Output: logs/scenarios/<name>/{cli-output.txt,capture/,report.md}"
