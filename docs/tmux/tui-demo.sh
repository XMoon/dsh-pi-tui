#!/usr/bin/env bash
# tmux functional demo of dsh-pi-tui with theme-color snapshots.
# Phases: dark boot + shell card + dark panel; COLORFGBG light auto-detect;
# UI-driven theme switch; persisted-theme relaunch. Plain-text + ANSI
# captures under /tmp/tui-demo/, ANSI rendered to HTML via ansi2html.mjs.
set -u
S=demo
OUT=/tmp/tui-demo
mkdir -p "$OUT"
rm -f "$OUT"/*
SETTINGS="$HOME/.dsh/settings.yaml"
send() { tmux send-keys -t "$S" -l "$1"; sleep "${2:-0.3}"; }
enter() { tmux send-keys -t "$S" Enter; sleep "${1:-1.5}"; }
snap() { tmux capture-pane -t "$S" -p > "$OUT/$1.txt"; tmux capture-pane -t "$S" -e -p > "$OUT/$1.ansi"; }
settheme() { sed -i "s/^\(  theme:\).*/\1 $1/" "$SETTINGS"; }

settheme auto

echo "== phase 1: dark boot =="
tmux kill-session -t "$S" 2>/dev/null
tmux new-session -d -s "$S" -x 110 -y 34
send "env -u NO_COLOR COLORFGBG='15;0' dsh --profile pi-tui-dev" 0.3
enter 5
snap dark-1-boot

echo "== phase 2: local shell card =="
send '! ls -la' 0.4
enter 2
snap dark-2-shell

echo "== phase 3: dark /settings panel =="
send '/settings' 0.4
enter 2
snap dark-3-settings
tmux send-keys -t "$S" Escape
sleep 1

echo "== phase 4: COLORFGBG light auto-detect =="
tmux kill-session -t "$S" 2>/dev/null
tmux new-session -d -s "$S" -x 110 -y 34
send "env -u NO_COLOR COLORFGBG='0;15' dsh --profile pi-tui-dev" 0.3
enter 5
snap light-1-boot

echo "== phase 5: light /settings panel + UI theme switch =="
send '/settings' 0.4
enter 2
snap light-2-settings
tmux send-keys -t "$S" Down   # cursor -> Theme row
sleep 0.5
enter        # theme: auto -> dark
snap light-3-theme-dark
enter        # theme: dark -> light
snap light-4-theme-light
tmux send-keys -t "$S" Escape
sleep 1
snap light-5-after-light

echo "== phase 6: persisted light theme relaunches light (dark env) =="
tmux kill-session -t "$S" 2>/dev/null
tmux new-session -d -s "$S" -x 110 -y 34
send "env -u NO_COLOR COLORFGBG='15;0' dsh --profile pi-tui-dev" 0.3
enter 5
snap persisted-light-boot

tmux kill-session -t "$S" 2>/dev/null
settheme auto   # leave the dev profile clean

echo "== rendering HTML =="
for ansi in "$OUT"/*.ansi; do
  base=$(basename "$ansi" .ansi)
  node "$(dirname "$0")/ansi2html.mjs" "$ansi" "$OUT/$base.html" "$base" >/dev/null
done
echo "captures: $OUT"
ls "$OUT" | sed 's/^/  /'
