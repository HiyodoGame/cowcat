#!/usr/bin/env bash
# Verify CowCat end-to-end against Kimi through the logging proxy.
# Prereq: .keys.env with MOONSHOT_API_KEY. Usage: bash tools/run-ccagent-kimi.sh [prompt]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source .keys.env

PORT=8788
PROMPT="${1:-阅读 sandbox/demo-repo/src/index.js，说明它做了什么，并修复其中的 bug}"

rm -rf logs/cowcat-capture && mkdir -p logs/cowcat-capture
node tools/proxy/server.mjs --port $PORT --upstream "https://api.kimi.com/coding" \
    --upstream-key "$MOONSHOT_API_KEY" --log-dir logs/cowcat-capture > logs/proxy-cowcat.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null' EXIT
sleep 1.5

env COWCAT_PROVIDER=anthropic \
    COWCAT_BASE_URL="http://127.0.0.1:$PORT" \
    COWCAT_API_KEY="$MOONSHOT_API_KEY" \
    COWCAT_MODEL="kimi-for-coding" \
    node agent/bin/cowcat.mjs --yolo --print "$PROMPT" || true

sleep 0.5
node tools/parser/parse-capture.mjs --dir logs/cowcat-capture --out logs/cowcat-capture/report.md || true
echo "Capture: logs/cowcat-capture/ (report.md = request structure)"
