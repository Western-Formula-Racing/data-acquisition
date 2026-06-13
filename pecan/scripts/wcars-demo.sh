#!/usr/bin/env bash
# WCARS demo launcher.
# Runs the fake WCARS WebSocket feed alongside the Pecan dev server so the
# /wcars page can be previewed end-to-end with no car / base UTS attached.
#
#   ./scripts/wcars-demo.sh            # defaults: WS :9081, vite :5199
#   WS_PORT=9090 UI_PORT=3001 ./scripts/wcars-demo.sh
#
# Ctrl-C stops both processes.
set -euo pipefail

WS_PORT="${WS_PORT:-9081}"
UI_PORT="${UI_PORT:-5199}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

cleanup() {
  echo ""
  echo "[wcars-demo] stopping…"
  [[ -n "${FAKE_PID:-}" ]] && kill "$FAKE_PID" 2>/dev/null || true
  [[ -n "${VITE_PID:-}" ]] && kill "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[wcars-demo] starting fake WCARS feed on ws://localhost:${WS_PORT}"
node scripts/wcars-fake-server.mjs &
FAKE_PID=$!

echo "[wcars-demo] starting Pecan dev server on http://localhost:${UI_PORT}"
VITE_WS_URL="ws://localhost:${WS_PORT}" npx vite --port "${UI_PORT}" --strictPort &
VITE_PID=$!

sleep 2
echo ""
echo "  ┌──────────────────────────────────────────────┐"
echo "  │  WCARS demo ready                            │"
echo "  │  Open:  http://localhost:${UI_PORT}/wcars          │"
echo "  │  Feed:  5 backlog + 2 live alerts on connect │"
echo "  │  Stop:  Ctrl-C                               │"
echo "  └──────────────────────────────────────────────┘"
echo ""

wait
