#!/usr/bin/env bash
# Real two-process E2E for historical-generation (v0/v1) session migration
# (Stage A, A10.2).
#
# Starts from a DSH_HOME whose disk holds ONLY a historical session
# generation (released v0 or released v1) and proves the full official
# migration chain through the REAL TUI:
#
#   1. the old-generation artifact is placed on disk (official physical
#      encoding: zstd frames [header][body], exactly what the official
#      JSONL persistence writes);
#   2. the official persistence API (list/stat) discovers it — and does NOT
#      migrate it (read-only header observation);
#   3. the TUI session picker displays it (official sessionQuery listing +
#      observation);
#   4. the old generation's file hash is recorded;
#   5. the TUI resume action opens it through the official Direct runtime /
#      SessionHandle (agents.resume → sessionPersistence.open);
#   6. NO TUI raw parser / repair / manual migration is ever invoked — the
#      only readers are the official persistence API and the TUI itself;
#   7. the official migration publishes the current v2 successor beside the
#      unchanged source (the first official full-log read — the picker's
#      observeSession or the resume's open — publishes it; never a manual
#      step);
#   8. the resumed transcript renders the migrated historical content
#      (user messages, assistant reply, compaction summary);
#   9. a new user turn + completed assistant turn is appended through the
#      OFFICIAL persistence API (TUI input needs a live model, so the
#      sanctioned fallback is used: official append, then TUI reopen);
#  10. the TUI is disposed (/exit);
#  11. the TUI reopens the session;
#  12. historical content AND the new turn both render;
#  13. the old generation's hash is unchanged (source immutability);
#  14. the current generation is readable through the official persistence.
#
# Both chains (v0 and v1) run in SEPARATE fresh DSH_HOMEs: the v1 fixture is
# the official identity migration of the v0 fixture, so both carry the same
# session id and cannot share one root.
#
# Usage:
#   scripts/e2e-historical-migration.sh [--keep]
#
#   --keep    keep the tmux session and DSH_HOMEs on failure for inspection
#
# Environment:
#   MASTER_ENV   path to the master DSH environment (default
#                /tmp/dsh-pi-tui-audit-bnktVF); its node_modules must hold
#                the master @deepseek-ai packages and its .bin/dsh CLI.
#
# This script is intentionally NOT part of `pnpm test:bundle` (it needs a
# real TTY via tmux, the master environment, and ~2min of wall time). Run
# it on demand:  scripts/e2e-historical-migration.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MASTER_ENV="${MASTER_ENV:-/tmp/dsh-pi-tui-audit-bnktVF}"
PROFILE_NAME="e2e-historical-migration"
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
say() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mok\033[0m  %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

# ── 0. environment validation ──────────────────────────────────────────
if [ ! -x "$MASTER_ENV/node_modules/.bin/dsh" ]; then
  echo "FAIL: master dsh CLI not found at $MASTER_ENV/node_modules/.bin/dsh" >&2
  echo "      set MASTER_ENV to the master DSH environment" >&2
  exit 1
fi
if [ ! -d "$MASTER_ENV/node_modules/@deepseek-ai/dsh-session-persistence-jsonl" ]; then
  echo "FAIL: master JSONL persistence backend not found in $MASTER_ENV" >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/dist/index.mjs" ]; then
  echo "FAIL: $REPO_ROOT/dist/index.mjs missing — run 'pnpm build' first" >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/test/fixtures/session-format/released-v0-real-shapes.jsonl" ] \
  || [ ! -f "$REPO_ROOT/test/fixtures/session-format/released-v1-real-shapes.jsonl" ]; then
  echo "FAIL: session-format fixtures missing under test/fixtures/session-format/" >&2
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "FAIL: tmux is required" >&2
  exit 1
fi

TMUX_SESSION="dsh-e2e-historical-migration-$$"
E2E_HOMES=()

# Only this script's own dsh processes: the master CLI's real process
# command line is `node .../@deepseek-ai/dsh/lib/bin.js --profile
# e2e-historical-migration ...`. The unique profile name makes the match
# precise; we kill by PID, never with a broad pkill.
dsh_pids() { pgrep -f "^node .*dsh/lib/bin\.js --profile $PROFILE_NAME" || true; }

cleanup() {
  for pid in $(dsh_pids); do kill "$pid" 2>/dev/null || true; done
  if [ "$KEEP" -eq 1 ]; then
    echo "== kept for inspection: tmux session $TMUX_SESSION, DSH_HOMEs: ${E2E_HOMES[*]:-none} =="
  else
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    for home in "${E2E_HOMES[@]:-}"; do
      [ -n "$home" ] && rm -rf "$home"
    done
  fi
}
trap cleanup EXIT

# ── tmux harness (one pane, reused across both chains) ──────────────────
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 34
PANE="$TMUX_SESSION:0.0"

pane_text() { tmux capture-pane -t "$1" -p 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tr '\n' ' '; }
# The launch command echo also contains "--session <id>", so a bare
# "session <id>" match would false-positive on the echoed command line.
# The mounted TUI header ("🐋  session <id>") is the only state that
# contains "session <id>" WITHOUT the "--session" launcher flag.
pane_mounted() { # pane_mounted <pane> <sessionId> — 0 when the TUI shows the session mounted
  local text="$(pane_text "$1")"
  echo "$text" | grep -q "session $2" \
    && ! echo "$text" | grep -q -- "--session $2"
}
wait_pane_mounted() { # wait_pane_mounted <pane> <sessionId> <timeout_s> — 0 on mount, 1 on timeout
  local pane="$1" id="$2" timeout="$3" elapsed=0
  while ! pane_mounted "$pane" "$id"; do
    sleep 0.5
    elapsed=$((elapsed+1))
    if [ "$elapsed" -ge $((timeout*2)) ]; then return 1; fi
  done
  return 0
}
wait_pane_text() { # wait_pane_text <pane> <needle> <timeout_s> — 0 when the pane shows the needle
  local pane="$1" needle="$2" timeout="$3" elapsed=0
  while ! echo "$(pane_text "$pane")" | grep -q "$needle"; do
    sleep 0.5
    elapsed=$((elapsed+1))
    if [ "$elapsed" -ge $((timeout*2)) ]; then return 1; fi
  done
  return 0
}
launch_tui() { # launch_tui <workDir> [--session <id>] — a real dsh process
  local work="$1"; shift
  tmux send-keys -t "$PANE" -l "cd $work"
  tmux send-keys -t "$PANE" Enter
  sleep 0.6
  tmux send-keys -t "$PANE" -l "env -u NO_COLOR DSH_TELEMETRY_DISABLED=1 DSH_HOME=$E2E_HOME $MASTER_ENV/node_modules/.bin/dsh --profile $PROFILE_NAME $*"
  sleep 0.4
  tmux send-keys -t "$PANE" Enter
}
# The dsh PID running inside the pane: the pane's shell PID (from tmux)
# must appear in the dsh process's ancestor chain. This keeps every kill
# and every quit-wait scoped to the exact pane's process — never a broad
# match across panes or user sessions.
pane_dsh_pid() { # pane_dsh_pid — the dsh PID in this pane, or empty
  local shell_pid
  shell_pid="$(tmux display-message -t "$PANE" -p '#{pane_pid}' 2>/dev/null || true)"
  [ -n "$shell_pid" ] || return 0
  local pid cur
  for pid in $(dsh_pids); do
    cur="$pid"
    while [ -n "$cur" ] && [ "$cur" != "1" ]; do
      if [ "$cur" = "$shell_pid" ]; then
        echo "$pid"
        return 0
      fi
      cur="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')"
    done
  done
  return 0
}
quit_pane() { # quit_pane — clean /exit if a TUI is up, then wait for ITS process to exit
  tmux send-keys -t "$PANE" -l "/exit"
  sleep 0.4
  tmux send-keys -t "$PANE" Enter
  local elapsed=0
  while [ -n "$(pane_dsh_pid)" ]; do
    sleep 0.5
    elapsed=$((elapsed+1))
    if [ "$elapsed" -ge 30 ]; then
      bad "dsh process did not exit after /exit"
      return 0
    fi
  done
  return 0
}

# ── one full chain: disk-only historical generation → migrated + new turn ──
# run_chain <generation> <fixture> <sourceName> <label>
#   generation  v0 | v1
#   fixture     repo fixture path (plain JSONL)
#   sourceName  on-disk source generation filename (session.jsonl.zstd |
#               session.v1.jsonl.zstd)
#   label       assertion label prefix
run_chain() {
  local generation="$1" fixture="$2" source_name="$3" label="$4"
  local WORK_DIR PROFILE_DIR SESSION_ID SESSION_DIR PROJECT_KEY
  # E2E_HOME is intentionally global: launch_tui / quit_pane read it.
  E2E_HOME="$(mktemp -d "/tmp/dsh-e2e-hist-${generation}-XXXXXX")"
  E2E_HOMES+=("$E2E_HOME")
  WORK_DIR="$E2E_HOME/work"
  PROFILE_DIR="$E2E_HOME/profiles/$PROFILE_NAME"

  echo
  echo "== chain $generation: fresh DSH_HOME at $E2E_HOME =="

  # ── 1. E2E home layout ────────────────────────────────────────────────
  mkdir -p "$WORK_DIR" "$PROFILE_DIR/node_modules/@xmoon76"
  # The helper scripts (probe/append/place) resolve @deepseek-ai from the
  # master environment through this node_modules link.
  ln -s "$MASTER_ENV/node_modules" "$E2E_HOME/node_modules"
  # The dedicated profile links THIS worktree's bundle (the fresh dist).
  ln -s "$REPO_ROOT" "$PROFILE_DIR/node_modules/@xmoon76/dsh-pi-tui"
  cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-e2e-historical-migration",
  "private": true,
  "dependencies": {
    "@xmoon76/dsh-pi-tui": "link:$REPO_ROOT"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@xmoon76/dsh-pi-tui"]
    }
  }
}
EOF
  echo '[]' > "$PROFILE_DIR/cordis.patch.yml"

  # ── 2. helper scripts (official master API only) ──────────────────────
  cat > "$E2E_HOME/place-fixture.mjs" <<'EOF'
#!/usr/bin/env node
// Place one plain-JSONL session fixture on disk as the OFFICIAL physical
// artifact: zstd frames [header line][body], exactly the encoding the
// official JSONL persistence writes (encodePhysicalJsonl). The source
// generation file is immutable from here on.
// Usage: node place-fixture.mjs <fixtureJsonl> <targetPath>
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
const [fixture, target] = process.argv.slice(2)
const text = readFileSync(fixture, 'utf8')
const nl = text.indexOf('\n')
if (nl === -1) throw new Error('fixture has no header line')
writeFileSync(target, Buffer.concat([
  zstdCompressSync(Buffer.from(text.slice(0, nl + 1))),
  zstdCompressSync(Buffer.from(text.slice(nl + 1))),
]))
console.log(`placed ${target}`)
EOF

  cat > "$E2E_HOME/probe.mjs" <<'EOF'
#!/usr/bin/env node
// Official master persistence API probe. Modes:
//   list <root> <id>  — list() + stat(); prints LIST FOUND/MISSING and
//                       STAT FOUND/MISSING (read-only header observation,
//                       never migrates).
//   read <root> <id>  — open(id, 'read') + read(0); prints
//                       READ-OK <id>: <n> events or
//                       READ-FAILED <id>: <message>.
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [mode, root, id] = process.argv.slice(2)
const ctx = new Context()
const persistence = new JsonlSessionPersistence(ctx, { root })

if (mode === 'list') {
  const listed = await persistence.list()
  const found = listed.some((s) => s.header.id === id)
  console.log(`LIST ${found ? 'FOUND' : 'MISSING'} ${id} (${listed.length} total)`)
  const stat = await persistence.stat(id)
  console.log(`STAT ${stat === undefined ? 'MISSING' : `FOUND ${stat.header.id} v${stat.header.version}`}`)
} else if (mode === 'read') {
  try {
    const handle = await persistence.open(id, 'read')
    const events = await handle.read(0)
    await handle.close()
    console.log(`READ-OK ${id}: ${events.length} events`)
  } catch (error) {
    console.log(`READ-FAILED ${id}: ${error?.message ?? String(error)}`)
  }
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
EOF

  cat > "$E2E_HOME/append-turn.mjs" <<'EOF'
#!/usr/bin/env node
// Append one complete new turn (user + assistant) through the OFFICIAL
// master JSONL persistence API (write open + append + flush + close).
// The assistant/message carries the v2 embedded stream (chunk events),
// matching the shape the official v1→v2 migration produces.
// Usage: node append-turn.mjs <sessionsRoot> <sessionId> <userText> <assistantText>
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, id, userText, assistantText] = process.argv.slice(2)
const ctx = new Context()
const persistence = new JsonlSessionPersistence(ctx, { root })
const handle = await persistence.open(id, 'write')
const events = await handle.read(0)
const next = events.length
const turn = 2
const now = Date.now()
const batch = [
  { type: 'turn/start', seq: next, time: now, data: { turn } },
  { type: 'step/start', seq: next + 1, time: now, data: { turn, step: 1 } },
  { type: 'user/message', seq: next + 2, time: now, data: { id: `e2e-user-${next}`, role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: next + 3, time: now, data: {
      turn, step: 1,
      message: { id: `e2e-assistant-${next}`, role: 'assistant', content: [{ type: 'text', text: assistantText }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
      usage: { inputTokens: 1, outputTokens: 1 },
      stream: [
        { type: 'chunk', time: now, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: now, index: 0, dt: [], texts: [assistantText] },
        { type: 'chunk', time: now, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: assistantText } } },
        { type: 'chunk', time: now, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
        { type: 'chunk', time: now, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, surfaceOp: 'append' },
  { type: 'step/end', seq: next + 4, time: now, data: { turn, step: 1 } },
  { type: 'turn/end', seq: next + 5, time: now, data: { turn, reason: { kind: 'completed' } } },
]
await handle.append(batch)
await handle.flush()
await handle.close()
console.log(`appended turn 2 at seq ${next}: ${userText} / ${assistantText}`)
EOF

  # ── 3. fs-ext native binding (write-lease prerequisite) ────────────────
  # The master env's pnpm allowBuilds excludes fs-ext, so the native addon
  # may be absent; build it in place so the official write-open really runs.
  FS_EXT_DIR="$(cd "$E2E_HOME" && node -e "
const { createRequire } = require('node:module');
const { dirname } = require('node:path');
const req = createRequire(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
console.log(dirname(req.resolve('fs-ext')));
")"
  if [ ! -f "$FS_EXT_DIR/build/Release/fs_ext.node" ]; then
    echo "== fs-ext native binding missing; building it in $FS_EXT_DIR =="
    NODE_GYP="$(npm root -g 2>/dev/null)/npm/node_modules/node-gyp/bin/node-gyp.js"
    if [ ! -f "$NODE_GYP" ]; then NODE_GYP="$(command -v node-gyp || true)"; fi
    if [ -z "$NODE_GYP" ]; then
      echo "FAIL: node-gyp not found; build fs-ext manually in $FS_EXT_DIR" >&2
      exit 1
    fi
    (cd "$FS_EXT_DIR" && node "$NODE_GYP" configure build) || {
      echo "FAIL: fs-ext native build failed" >&2
      exit 1
    }
  fi

  # ── 4. place the historical generation on disk (step 1) ───────────────
  # The fixture header names the session id and cwd; derive the on-disk
  # project/session layout from them (official projectKey + encodeSegment).
  SESSION_ID="$(node -e "
const { readFileSync } = require('node:fs');
const line = readFileSync(process.argv[1], 'utf8').split('\n')[0];
console.log(JSON.parse(line).id);
" "$fixture")"
  FIXTURE_CWD="$(node -e "
const { readFileSync } = require('node:fs');
const line = readFileSync(process.argv[1], 'utf8').split('\n')[0];
console.log(JSON.parse(line).cwd ?? '');
" "$fixture")"
  PROJECT_KEY="$(node -e "
const cwd = process.argv[1];
let readable = ''; let sep = false;
for (const ch of cwd) {
  if (ch === '/' || ch === '\\\\' || ch === ':') { if (!sep) readable += '-'; sep = true; }
  else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; sep = false; }
  else { readable += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'); sep = false; }
}
const slug = readable.replace(/^-+/, '') || 'root';
console.log('--' + slug.slice(0, 251) + '--');
" "$FIXTURE_CWD")"
  SESSION_DIR="$E2E_HOME/sessions/$PROJECT_KEY/$SESSION_ID"
  mkdir -p "$SESSION_DIR"
  node "$E2E_HOME/place-fixture.mjs" "$fixture" "$SESSION_DIR/$source_name"
  if [ ! -f "$SESSION_DIR/$source_name" ]; then
    bad "$label: source generation not placed at $SESSION_DIR/$source_name"
    return 0
  fi
  ok "$label: historical generation placed on disk ($source_name)"

  # ── 5. official list/stat discovers it, WITHOUT migrating (step 2) ─────
  PROBE_OUT="$(node "$E2E_HOME/probe.mjs" list "$E2E_HOME/sessions" "$SESSION_ID")"
  echo "$PROBE_OUT" | sed 's/^/  /'
  if echo "$PROBE_OUT" | grep -q "LIST FOUND" && echo "$PROBE_OUT" | grep -q "STAT FOUND"; then
    ok "$label: official list/stat discovers the session"
  else
    bad "$label: official list/stat did not discover the session: $PROBE_OUT"
  fi
  # Read-only header observation must NOT publish the successor: the disk
  # still holds ONLY the historical generation before any TUI open.
  if [ -e "$SESSION_DIR/session.v2.jsonl.zstd" ]; then
    bad "$label: v2 successor already published by read-only list/stat"
  else
    ok "$label: disk still holds only the historical generation after list/stat"
  fi

  # ── 6. record the old generation hash (step 4) ────────────────────────
  HASH_BEFORE="$(sha256sum "$SESSION_DIR/$source_name" | cut -d' ' -f1)"
  ok "$label: recorded source hash $HASH_BEFORE"

  # ── 7. TUI picker displays the session (step 3) ───────────────────────
  launch_tui "$WORK_DIR"
  if wait_pane_text "$PANE" "type a message to start a session" 40; then
    ok "$label: TUI home up"
  else
    bad "$label: TUI home did not come up: $(pane_text "$PANE")"
  fi
  tmux send-keys -t "$PANE" -l "/sessions"
  sleep 0.4
  tmux send-keys -t "$PANE" Enter
  if wait_pane_text "$PANE" "sessions ·" 20; then
    ok "$label: session picker opened"
  else
    bad "$label: session picker did not open: $(pane_text "$PANE")"
  fi
  # Tab cycles Current directory → All directories (the fixture cwd /work
  # is not the TUI's cwd, so the row lives in the All-directories scope).
  tmux send-keys -t "$PANE" Tab
  if wait_pane_text "$PANE" "released" 20; then
    ok "$label: picker displays the session row"
  else
    bad "$label: picker row missing: $(pane_text "$PANE")"
  fi
  # Close the picker (Esc) before /exit — /exit typed into the picker's
  # search box would filter sessions instead of quitting.
  tmux send-keys -t "$PANE" Escape
  sleep 0.5
  quit_pane

  # ── 8. TUI resume → official migration publishes the successor (5/6/7) ─
  launch_tui "$WORK_DIR" --session "$SESSION_ID"
  if wait_pane_mounted "$PANE" "$SESSION_ID" 40; then
    ok "$label: TUI resumed the session (official Direct open)"
  else
    bad "$label: TUI did not resume: $(pane_text "$PANE")"
  fi
  if [ -e "$SESSION_DIR/session.v2.jsonl.zstd" ]; then
    ok "$label: official migration published session.v2.jsonl.zstd"
  else
    bad "$label: v2 successor NOT published after the TUI open"
  fi
  HASH_AFTER_OPEN="$(sha256sum "$SESSION_DIR/$source_name" | cut -d' ' -f1)"
  if [ "$HASH_AFTER_OPEN" = "$HASH_BEFORE" ]; then
    ok "$label: source hash unchanged after the TUI open (immutable source)"
  else
    bad "$label: source hash CHANGED after the TUI open ($HASH_BEFORE → $HASH_AFTER_OPEN)"
  fi

  # ── 9. resumed transcript renders the migrated history (step 8) ────────
  PANE_NOW="$(pane_text "$PANE")"
  if echo "$PANE_NOW" | grep -q "hello" && echo "$PANE_NOW" | grep -q "late" \
    && echo "$PANE_NOW" | grep -q "Compacted 4 history items"; then
    ok "$label: transcript renders migrated history (assistant reply + last user message + compaction summary)"
  else
    bad "$label: transcript missing migrated content: $PANE_NOW"
  fi

  # ── 10. dispose/close, then append a new turn officially (steps 9/10) ──
  quit_pane
  APPEND_OUT="$(node "$E2E_HOME/append-turn.mjs" "$E2E_HOME/sessions" "$SESSION_ID" \
    "new user turn from e2e" "new assistant turn from e2e")"
  echo "$APPEND_OUT" | sed 's/^/  /'
  if echo "$APPEND_OUT" | grep -q "appended turn 2"; then
    ok "$label: new turn appended through the official persistence API"
  else
    bad "$label: official append failed: $APPEND_OUT"
  fi

  # ── 11. reopen: history + new turn both render (steps 11/12) ───────────
  launch_tui "$WORK_DIR" --session "$SESSION_ID"
  if wait_pane_mounted "$PANE" "$SESSION_ID" 40; then
    ok "$label: TUI reopened the session"
  else
    bad "$label: TUI did not reopen: $(pane_text "$PANE")"
  fi
  PANE_NOW="$(pane_text "$PANE")"
  if echo "$PANE_NOW" | grep -q "hello" && echo "$PANE_NOW" | grep -q "late" \
    && echo "$PANE_NOW" | grep -q "new user turn from e2e" \
    && echo "$PANE_NOW" | grep -q "new assistant turn from e2e"; then
    ok "$label: reopened transcript renders history AND the new turn"
  else
    bad "$label: reopened transcript incomplete: $PANE_NOW"
  fi
  quit_pane

  # ── 12. source immutability + official read of the current gen (13/14) ─
  HASH_AFTER="$(sha256sum "$SESSION_DIR/$source_name" | cut -d' ' -f1)"
  if [ "$HASH_AFTER" = "$HASH_BEFORE" ]; then
    ok "$label: source hash unchanged after the full chain (immutable source)"
  else
    bad "$label: source hash CHANGED after the full chain ($HASH_BEFORE → $HASH_AFTER)"
  fi
  READ_OUT="$(node "$E2E_HOME/probe.mjs" read "$E2E_HOME/sessions" "$SESSION_ID")"
  echo "$READ_OUT" | sed 's/^/  /'
  case "$READ_OUT" in
    READ-OK*) ok "$label: current generation readable through the official persistence ($READ_OUT)" ;;
    *) bad "$label: current generation NOT readable: $READ_OUT" ;;
  esac
}

# ── run both chains ────────────────────────────────────────────────────
run_chain v0 \
  "$REPO_ROOT/test/fixtures/session-format/released-v0-real-shapes.jsonl" \
  "session.jsonl.zstd" \
  "v0"

run_chain v1 \
  "$REPO_ROOT/test/fixtures/session-format/released-v1-real-shapes.jsonl" \
  "session.v1.jsonl.zstd" \
  "v1"

# ── summary ─────────────────────────────────────────────────────────────
echo
echo "== e2e-historical-migration: $PASS passed, $FAIL failed =="
if [ "$FAIL" -ne 0 ]; then
  echo "== FAILURES: keep with --keep for inspection =="
  exit 1
fi
exit 0
