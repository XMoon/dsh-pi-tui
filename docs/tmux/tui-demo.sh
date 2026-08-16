#!/usr/bin/env bash
# tmux functional demo of dsh-pi-tui with theme-color snapshots.
# Phases: dark boot + shell card + dark panel; COLORFGBG light auto-detect;
# UI-driven theme switch; persisted-theme relaunch. Plain-text + ANSI
# captures under a private /tmp/tui-demo.XXXXXX/ directory, ANSI rendered to
# HTML via ansi2html.mjs.
#
# SAFETY: the demo temporarily sets the persisted theme (it must, to make
# the phases deterministic). The ORIGINAL settings file (bytes + mode) is
# backed up and VERIFIED before the first write; the demo refuses to run if
# the backup fails. Cleanup lives on the EXIT trap ONLY (idempotent); the
# INT/TERM handlers just `exit 130/143`, so cleanup runs exactly once no
# matter how the script ends — a Ctrl+C can never leave the user's theme
# changed or a tmux session alive. Each run owns a private output/backup
# directory, and an advisory lock prevents concurrent runs from racing while
# rewriting the one real settings file. The tmux session name is unique per
# run (PID + random), so the demo only ever kills a session it created itself.
# Never replace the restore with a bare "write auto at the end".
set -u
S="tui-demo-$$-$RANDOM"
OUT=$(mktemp -d /tmp/tui-demo.XXXXXX) || {
  echo 'error: cannot create a private output directory' >&2
  exit 1
}
SETTINGS="$HOME/.dsh/settings.yaml"
BACKUP="$OUT/settings.yaml.bak"

# The output and backup are private, but settings.yaml is not. Hold this lock
# from BEFORE backup until the EXIT trap restores the file; a second demo
# fails closed instead of backing up another run's temporary theme.
LOCK=/tmp/dsh-pi-tui-demo.settings.lock
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "error: another tui-demo is modifying $SETTINGS; try again after it exits" >&2
  exit 1
fi

# Byte-exact backup of the REAL user settings (mode preserved by cp -p).
# FAIL CLOSED: without a verified backup the demo must never touch the real
# settings file (settheme below would rewrite it with sed -i).
if ! cp -p "$SETTINGS" "$BACKUP" 2>/dev/null || ! cmp -s "$SETTINGS" "$BACKUP"; then
  echo "error: cannot back up $SETTINGS (does it exist?); refusing to modify it" >&2
  exit 1
fi
cleanup() {
  # Only ever touch the session this run created (unique name).
  tmux kill-session -t "$S" 2>/dev/null
  if [ -f "$BACKUP" ]; then
    if cp -p "$BACKUP" "$SETTINGS" 2>/dev/null; then
      rm -f "$BACKUP"
    else
      echo "warning: could not restore $SETTINGS from $BACKUP (kept for manual restore)" >&2
    fi
  fi
}
on_int() { exit 130; }
on_term() { exit 143; }
trap cleanup EXIT
trap on_int INT
trap on_term TERM

send() { tmux send-keys -t "$S" -l "$1"; sleep "${2:-0.3}"; }
enter() { tmux send-keys -t "$S" Enter; sleep "${1:-1.5}"; }
snap() { tmux capture-pane -t "$S" -p > "$OUT/$1.txt"; tmux capture-pane -t "$S" -e -p > "$OUT/$1.ansi"; }
settheme() { sed -i "s/^\(  theme:\).*/\1 $1/" "$SETTINGS"; }

settheme auto   # TEMPORARY: the trap restores the original file on exit

echo "== phase 1: dark boot =="
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

echo "== rendering HTML =="
for ansi in "$OUT"/*.ansi; do
  base=$(basename "$ansi" .ansi)
  node "$(dirname "$0")/ansi2html.mjs" "$ansi" "$OUT/$base.html" "$base" >/dev/null
done
echo "captures: $OUT"
ls "$OUT" | sed 's/^/  /'
