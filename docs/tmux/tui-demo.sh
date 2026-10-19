#!/usr/bin/env bash
# tmux functional demo of dsh-pi-tui with theme-color snapshots.
# Runs in a fresh disposable DSH_HOME, links the current worktree, and changes
# theme only through the UI. Plain/ANSI captures and the isolated home stay in
# a private /tmp/tui-demo.XXXXXX directory.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORKSPACE=$PWD
S="tui-demo-$$-$RANDOM"
OUT=$(mktemp -d /tmp/tui-demo.XXXXXX)
DSH_HOME="$OUT/dsh-home"
DSH=$(command -v dsh) || {
  printf 'error: dsh CLI is not available on PATH\n' >&2
  exit 1
}
PROFILE=pi-tui-dev
mkdir -p "$DSH_HOME"

# Create a disposable profile linked to this worktree; no real profile or
# persistent runtime state is read or changed.
cd "$ROOT"
env DSH_HOME="$DSH_HOME" "$DSH" plugin --profile "$PROFILE" -- add 'link:.'
cd "$WORKSPACE"

cleanup() {
  tmux kill-session -t "$S" 2>/dev/null || true
}
on_int() { exit 130; }
on_term() { exit 143; }
trap cleanup EXIT
trap on_int INT
trap on_term TERM

send() { tmux send-keys -t "$S" -l "$1"; sleep "${2:-0.3}"; }
enter() { tmux send-keys -t "$S" Enter; sleep "${1:-1.5}"; }
snap() {
  tmux capture-pane -t "$S" -p > "$OUT/$1.txt"
  tmux capture-pane -t "$S" -e -p > "$OUT/$1.ansi"
}
dsh_command() {
  printf 'env -u NO_COLOR DSH_HOME=%q COLORFGBG=%q %q --profile %q' \
    "$DSH_HOME" "$1" "$DSH" "$PROFILE"
}

printf '== phase 1: dark boot ==\n'
tmux new-session -d -s "$S" -x 110 -y 34
send "$(dsh_command '15;0')" 0.3
enter 5
snap dark-1-boot

printf '== phase 2: local shell card ==\n'
send '! ls -la' 0.4
enter 2
snap dark-2-shell

printf '== phase 3: dark settings panel ==\n'
send '/settings' 0.4
enter 2
snap dark-3-settings
tmux send-keys -t "$S" Escape
sleep 1

printf '== phase 4: COLORFGBG light auto-detect ==\n'
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 110 -y 34
send "$(dsh_command '0;15')" 0.3
enter 5
snap light-1-boot

printf '== phase 5: light settings panel + UI theme switch ==\n'
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

printf '== phase 6: persisted light theme relaunches light (dark env) ==\n'
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 110 -y 34
send "$(dsh_command '15;0')" 0.3
enter 5
snap persisted-light-boot

tmux kill-session -t "$S" 2>/dev/null || true
printf '== rendering HTML ==\n'
for ansi in "$OUT"/*.ansi; do
  base=$(basename "$ansi" .ansi)
  node "$(dirname "$0")/ansi2html.mjs" "$ansi" "$OUT/$base.html" "$base" >/dev/null
done
printf 'captures: %s\n' "$OUT"
ls "$OUT" | sed 's/^/  /'
