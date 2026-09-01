#!/usr/bin/env bash
# Time the /sessions picker lifecycle on a bench DSH_HOME: open the picker,
# Tab to "All directories", time rows/enrichment, Esc latency, warm reopen.
#   usage: bench-run.sh <home-dir> <session-name>
set -u
HOME_DIR=$1
S=$2

stripped() { tmux capture-pane -t "$S" -p 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'; }
now_ms() { date +%s%3N; }

# wait_for [-v] <regex> <timeout-ms> [retry-cmd...] -> echoes elapsed ms
wait_for() {
  local invert=0
  if [ "${1:-}" = "-v" ]; then invert=1; shift; fi
  local re=$1 timeout=$2; shift 2
  local start hit
  start=$(now_ms)
  while :; do
    hit=0
    if [ "$invert" = 0 ]; then stripped | grep -qE "$re" && hit=1
    else stripped | grep -qE "$re" || hit=1; fi
    if [ "$hit" = 1 ]; then echo "$(( $(now_ms) - start ))"; return 0; fi
    if [ "$#" -gt 0 ] && [ "$(( $(now_ms) - start ))" -gt 3000 ]; then "$@"; set --; fi
    if [ "$(( $(now_ms) - start ))" -gt "$timeout" ]; then echo TIMEOUT; return 1; fi
    sleep 0.05
  done
}

PICKER='sessions . (Current directory|All directories)'
ROW_META='[0-9]+(m|h|d|mo|y) . (preset:|$|sub|fork|live)'

tmux kill-session -t "$S" 2>/dev/null
tmux new-session -d -s "$S" -x 120 -y 34 "env -u NO_COLOR DSH_HOME='$HOME_DIR' dsh --profile bench"
sleep 5

echo "-- first open (cold)"
tmux send-keys -t "$S" '/sessions' Enter
echo "picker_frame_ms=$(wait_for "$PICKER" 60000 tmux send-keys -t "$S" Enter)"
tmux send-keys -t "$S" Tab   # All directories holds the full corpus
echo "all_rows_ms=$(wait_for "$ROW_META" 120000)"
echo "first_preset_ms=$(wait_for 'preset:' 300000)"

echo "-- Esc latency while enrichment may still be running"
tmux send-keys -t "$S" Escape
echo "esc_close_ms=$(wait_for -v "$PICKER" 60000)"

sleep 2
echo "-- second open (warm)"
tmux send-keys -t "$S" '/sessions' Enter
echo "warm_picker_frame_ms=$(wait_for "$PICKER" 60000 tmux send-keys -t "$S" Enter)"
tmux send-keys -t "$S" Tab
echo "warm_all_rows_ms=$(wait_for "$ROW_META" 120000)"
echo "warm_first_preset_ms=$(wait_for 'preset:' 300000)"
tmux send-keys -t "$S" Escape
sleep 1
tmux kill-session -t "$S" 2>/dev/null
