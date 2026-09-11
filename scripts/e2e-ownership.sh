#!/usr/bin/env bash
# Real two-process E2E for the master-baseline session ownership seam (A8).
#
# Proves the TUI does NOT bypass the official cross-process writer seam —
# DSH's SessionWriteLease (kernel flock on session.lock) — on the master
# baseline (0.1.3-alpha.1). The TUI's own owner.lock / lease / cooling /
# PINNED stack is removed legacy; the ONLY cross-process authority is the
# Host's SessionWriteLease.
#
#   Case 1 — TUI↔TUI contention: process A resumes session X (holds the
#     writer); process B resumes the same X → B is refused with the
#     SessionAlreadyOwnedError notice ("already owned by another DSH
#     writer/process"), X stays intact (official read + A still live).
#   Case 2 — clean dispose releases ownership: A resumes X → A exits
#     cleanly (/exit) → B resumes X → success.
#   Case 3 — crash releases kernel ownership: A resumes X → kill -9 A →
#     B resumes X → success. No stale-TTL wait, no PID lock record read:
#     the kernel released the flock on process death.
#   Case 4 — TUI↔Host (non-TUI writer): a plain node script in the master
#     environment holds X through the official persistence write-open
#     (SessionWriteLease.acquire) → TUI resume refused; reverse: TUI holds
#     X → the Host writer's write-open refused. Authority is not
#     TUI↔TUI-only.
#   A8.3 — no-owner.lock assertion: after every case the session directory
#     must contain NO owner.lock; session.lock is allowed (never mistaken
#     for residue).
#   A8.4 — native lease really executes: the fs-ext native binding is
#     loaded (not a stub) and a second process is refused while the first
#     holds the lease, then acquires immediately after release.
#
# The E2E runs the REAL bundle (this repo's dist/) in REAL dsh processes
# under an isolated DSH_HOME with a dedicated profile (link to this
# worktree), driven through tmux. It does NOT need a model connection: the
# session is seeded through the OFFICIAL master JSONL persistence API
# (create + flush + close), and /resume switches it.
#
# Usage:
#   scripts/e2e-ownership.sh [--keep]
#
#   --keep    keep the tmux session and DSH_HOME on failure for inspection
#
# Environment:
#   MASTER_ENV   path to the master DSH environment (default
#                /tmp/dsh-pi-tui-audit-bnktVF); its node_modules must hold
#                the master @deepseek-ai packages and its .bin/dsh CLI.
#
# This script is intentionally NOT part of `pnpm test:bundle` (it needs a
# real TTY via tmux, the master environment, and ~2min of wall time). Run
# it on demand:  scripts/e2e-ownership.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MASTER_ENV="${MASTER_ENV:-/tmp/dsh-pi-tui-audit-bnktVF}"
PROFILE_NAME="e2e-ownership"
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
if ! command -v tmux >/dev/null 2>&1; then
  echo "FAIL: tmux is required" >&2
  exit 1
fi

E2E_HOME="$(mktemp -d /tmp/dsh-e2e-ownership-XXXXXX)"
TMUX_SESSION="dsh-e2e-ownership-$$"
WORK_DIR="$E2E_HOME/work"
PROFILE_DIR="$E2E_HOME/profiles/$PROFILE_NAME"
SESSION_X="session-e2e-ownership-x"

# The session project key for WORK_DIR (see projectKey in
# dsh-session-persistence-jsonl: slashes become "-", unsafe units escape as
# ~XXXX, leading dashes stripped, wrapped in --...--).
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
" "$WORK_DIR")"
SESSION_DIR="$E2E_HOME/sessions/$PROJECT_KEY/$SESSION_X"

# Only this script's own dsh processes: the master CLI's real process
# command line is `node .../@deepseek-ai/dsh/lib/bin.js --profile
# e2e-ownership ...`. The unique profile name makes the match precise; we
# kill by PID, never with a broad pkill.
dsh_pids() { pgrep -f "^node .*dsh/lib/bin\.js --profile $PROFILE_NAME" || true; }

cleanup() {
  for pid in $(dsh_pids); do kill "$pid" 2>/dev/null || true; done
  if [ "$KEEP" -eq 1 ]; then
    echo "== kept for inspection: tmux session $TMUX_SESSION, DSH_HOME $E2E_HOME =="
  else
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    rm -rf "$E2E_HOME"
  fi
}
trap cleanup EXIT

# ── 1. E2E home layout ──────────────────────────────────────────────────
echo "== setup: isolated DSH_HOME at $E2E_HOME =="
mkdir -p "$WORK_DIR" "$PROFILE_DIR/node_modules/@xmoon76"
# The helper scripts (seed/writer/native-lease) resolve @deepseek-ai from
# the master environment through this node_modules link.
ln -s "$MASTER_ENV/node_modules" "$E2E_HOME/node_modules"
# The dedicated profile links THIS worktree's bundle (the fresh dist).
ln -s "$REPO_ROOT" "$PROFILE_DIR/node_modules/@xmoon76/dsh-pi-tui"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-e2e-ownership",
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

# ── 2. helper scripts (official master API only) ────────────────────────
cat > "$E2E_HOME/seed.mjs" <<'EOF'
#!/usr/bin/env node
// Seed one session artifact through the OFFICIAL master JSONL persistence
// API (create + flush + close). The TUI later resumes it through the same
// official path — never a raw parser.
// Usage: node seed.mjs <sessionsRoot> <sessionId> [cwd]
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = process.argv[2]
const id = process.argv[3]
const cwd = process.argv[4] ?? process.cwd()

const ctx = new Context()
const persistence = new JsonlSessionPersistence(ctx, { root })
const handle = await persistence.create({
  type: 'session',
  version: 2,
  id,
  createdAt: Date.now(),
  isSeeded: false,
  delegationDepth: 0,
  cwd,
  agentPreset: 'standard',
})
await handle.flush()
await handle.close()
console.log(`seeded ${id}`)
EOF

cat > "$E2E_HOME/writer.mjs" <<'EOF'
#!/usr/bin/env node
// Non-TUI Host writer / reader for the ownership E2E (Case 4 + integrity).
// Runs against the master packages (resolved through the E2E home's
// node_modules link). Modes:
//   hold <root> <id> [holdMs]  — open write (acquire the SessionWriteLease
//                                / kernel flock) and HOLD it; prints
//                                HOLDING <id>, then RELEASED <id>.
//   tryopen <root> <id>        — attempt a write open; prints
//                                ACQUIRED <id> or REFUSED <id>: <message>.
//   read <root> <id>           — open read + read(0); prints
//                                READ-OK <id>: <n> events or
//                                READ-FAILED <id>: <message>.
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [mode, root, id, holdMsRaw] = process.argv.slice(2)
const holdMs = holdMsRaw === undefined ? 30000 : Number(holdMsRaw)
const ctx = new Context()
const persistence = new JsonlSessionPersistence(ctx, { root })

if (mode === 'hold') {
  const handle = await persistence.open(id, 'write')
  console.log(`HOLDING ${id}`)
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  await handle.close()
  console.log(`RELEASED ${id}`)
} else if (mode === 'tryopen') {
  try {
    const handle = await persistence.open(id, 'write')
    console.log(`ACQUIRED ${id}`)
    await handle.close()
  } catch (error) {
    console.log(`REFUSED ${id}: ${error?.message ?? String(error)}`)
  }
} else if (mode === 'read') {
  try {
    const handle = await persistence.open(id, 'read')
    const events = await handle.read(0)
    console.log(`READ-OK ${id}: ${events.length} events`)
    await handle.close()
  } catch (error) {
    console.log(`READ-FAILED ${id}: ${error?.message ?? String(error)}`)
  }
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
EOF

cat > "$E2E_HOME/native-lease.mjs" <<'EOF'
#!/usr/bin/env node
// A8.4 — prove the master JSONL backend REALLY executes the native lease
// path (fs-ext flock on Linux), not a stub or a dependency-closure text
// match.
//
//  1. The fs-ext native binding is genuinely loaded (the .node addon file
//     exists and flock is a real function — not the browser-worker stub).
//  2. persistence.open(id, "write") — the official seam that internally
//     calls SessionWriteLease.acquire — succeeds and holds the kernel
//     flock on session.lock.
//  3. A SECOND process calling the same open is refused with
//     SessionAlreadyOwnedError — only possible if the kernel flock is
//     genuinely held (a stubbed fs-ext would succeed).
//  4. After close, the second process acquires immediately (kernel
//     released the lock on descriptor close).
//
// Usage: node native-lease.mjs <sessionsRoot> [sessionId]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = process.argv[2]
const id = process.argv[3] ?? 'session-native-lease-probe'
const here = dirname(fileURLToPath(import.meta.url))

// 0. Native binding probe: fs-ext must be the real addon, not a stub.
// fs-ext is a transitive dependency of the JSONL backend, so resolve it
// from the backend package's own context (the same instance the backend
// loads at runtime).
const require = createRequire(import.meta.url)
const persistenceEntry = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')
const backendRequire = createRequire(persistenceEntry)
const fsExtEntry = backendRequire.resolve('fs-ext')
const fsExt = backendRequire('fs-ext')
const bindingFile = join(dirname(fsExtEntry), 'build', 'Release', 'fs_ext.node')
if (typeof fsExt.flock !== 'function' || !existsSync(bindingFile)) {
  console.log(`NATIVE-BINDING-MISSING: flock=${typeof fsExt.flock} binding=${bindingFile}`)
  process.exit(1)
}
console.log(`NATIVE-BINDING-OK: ${bindingFile}`)

// Seed the probe session through the official API (create + flush + close).
const ctx = new Context()
const persistence = new JsonlSessionPersistence(ctx, { root })
{
  const handle = await persistence.create({
    type: 'session',
    version: 2,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    delegationDepth: 0,
    cwd: here,
    agentPreset: 'standard',
  })
  await handle.flush()
  await handle.close()
}

// Child: try the same write open; print ACQUIRED or REFUSED.
const childScript = `
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
const root = process.argv[1]
const id = process.argv[2]
const { join } = await import('node:path')
const ctx = new Context()
const persistence = new JsonlSessionPersistence(ctx, { root })
try {
  const handle = await persistence.open(id, 'write')
  console.log('ACQUIRED')
  await handle.close()
} catch (error) {
  console.log('REFUSED: ' + (error?.message ?? String(error)))
}
`
const runChild = () => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, root, id], {
    cwd: here,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.on('close', (code) => resolve({ code, out: out.trim() }))
})

// 1. Open with write access (the official seam → SessionWriteLease.acquire).
const handle = await persistence.open(id, 'write')
console.log(`ACQUIRED ${id}`)

// 2. Contention from a second process must be refused (real kernel flock).
const contended = await runChild()
if (contended.out.startsWith('REFUSED')) {
  console.log(`CONTENTION-REFUSED: ${contended.out}`)
} else {
  console.log(`CONTENTION-FAILED: ${contended.out || `exit ${contended.code}`}`)
  process.exitCode = 1
}

// 3. Close; the second process must now acquire immediately.
await handle.close()
const after = await runChild()
if (after.out === 'ACQUIRED') {
  console.log('RELEASED-REACQUIRED')
} else {
  console.log(`RELEASE-FAILED: ${after.out || `exit ${after.code}`}`)
  process.exitCode = 1
}
EOF

# ── 3. fs-ext native binding (A8.4 prerequisite) ────────────────────────
# The master env's pnpm allowBuilds excludes fs-ext, so the native addon
# may be absent; build it in place so the kernel-flock path really runs.
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

# ── 4. seed the session through the official API ────────────────────────
node "$E2E_HOME/seed.mjs" "$E2E_HOME/sessions" "$SESSION_X" "$WORK_DIR"
if [ ! -f "$SESSION_DIR/session.v2.jsonl.zstd" ]; then
  echo "FAIL: seeded session artifact not found at $SESSION_DIR" >&2
  exit 1
fi

# ── 5. A8.4: native lease really executes ───────────────────────────────
echo "== A8.4: native lease (fs-ext flock) really executes =="
NATIVE_OUT="$(node "$E2E_HOME/native-lease.mjs" "$E2E_HOME/sessions")"
echo "$NATIVE_OUT" | sed 's/^/  /'
if echo "$NATIVE_OUT" | grep -q "NATIVE-BINDING-OK" \
  && echo "$NATIVE_OUT" | grep -q "CONTENTION-REFUSED" \
  && echo "$NATIVE_OUT" | grep -q "RELEASED-REACQUIRED"; then
  ok "native lease path verified (binding + cross-process contention + kernel release)"
else
  bad "native lease verification failed: $NATIVE_OUT"
fi

# ── 6. tmux harness ─────────────────────────────────────────────────────
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 34
tmux split-window -t "$TMUX_SESSION" -h
PANE1="$TMUX_SESSION:0.0"
PANE2="$TMUX_SESSION:0.1"

pane_text() { tmux capture-pane -t "$1" -p 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tr '\n' ' '; }
# The launch command echo also contains "--session <id>", so a bare
# "session <id>" match would false-positive on the echoed command line.
# The mounted TUI header ("🐋  session <id>") and the refusal notice are
# the only states that contain "session <id>" WITHOUT the "--session"
# launcher flag.
pane_mounted() { # pane_mounted <pane> <sessionId> — 0 when the TUI shows the session mounted
  local text="$(pane_text "$1")"
  echo "$text" | grep -q "session $2" \
    && ! echo "$text" | grep -q -- "--session $2" \
    && ! echo "$text" | grep -q "$REFUSAL"
}
pane_refused() { # pane_refused <pane> — 0 when the TUI shows the refusal notice
  echo "$(pane_text "$1")" | grep -q "$REFUSAL"
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
wait_pane_refused() { # wait_pane_refused <pane> <timeout_s> — 0 on refusal, 1 on timeout
  local pane="$1" timeout="$2" elapsed=0
  while ! pane_refused "$pane"; do
    sleep 0.5
    elapsed=$((elapsed+1))
    if [ "$elapsed" -ge $((timeout*2)) ]; then return 1; fi
  done
  return 0
}
launch_tui() { # launch_tui <pane> [--session <id>] — a real dsh process
  local pane="$1"; shift
  tmux send-keys -t "$pane" -l "cd $WORK_DIR && env -u NO_COLOR DSH_TELEMETRY_DISABLED=1 DSH_HOME=$E2E_HOME $MASTER_ENV/node_modules/.bin/dsh --profile $PROFILE_NAME $*"
  sleep 0.4
  tmux send-keys -t "$pane" Enter
}
# The dsh PID running inside one pane: the pane's shell PID (from tmux)
# must appear in the dsh process's ancestor chain. This keeps every kill
# and every quit-wait scoped to the exact pane's process — never a broad
# match across panes or user sessions.
pane_dsh_pid() { # pane_dsh_pid <pane> — the dsh PID in this pane, or empty
  local pane="$1" shell_pid
  shell_pid="$(tmux display-message -t "$pane" -p '#{pane_pid}' 2>/dev/null || true)"
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
quit_pane() { # quit_pane <pane> — clean /exit if a TUI is up, then wait for ITS process to exit
  tmux send-keys -t "$1" -l "/exit"
  sleep 0.4
  tmux send-keys -t "$1" Enter
  local elapsed=0
  while [ -n "$(pane_dsh_pid "$1")" ]; do
    sleep 0.5
    elapsed=$((elapsed+1))
    if [ "$elapsed" -ge 30 ]; then
      bad "dsh process did not exit after /exit in pane $1"
      return 0
    fi
  done
  return 0
}
# The refusal notice the TUI surfaces for the Host's SessionAlreadyOwnedError.
REFUSAL="already owned by another DSH"

# A8.3: the session directory must never contain the removed legacy
# owner.lock; master's session.lock is allowed (never residue).
assert_no_owner_lock() {
  local dir="$1" label="$2"
  if [ -e "$dir/owner.lock" ]; then
    bad "$label: owner.lock EXISTS (forbidden residue)"
  else
    ok "$label: no owner.lock in the session directory"
  fi
  if [ -e "$dir/session.lock" ]; then
    ok "$label: session.lock present (allowed)"
  else
    ok "$label: session.lock absent (fine)"
  fi
}

# ── 7. Case 1: TUI↔TUI contention ───────────────────────────────────────
echo "== Case 1: TUI↔TUI contention — B refused while A holds X =="
launch_tui "$PANE1" --session "$SESSION_X"
if wait_pane_mounted "$PANE1" "$SESSION_X" 40; then
  ok "A opened $SESSION_X"
else
  bad "A did not open $SESSION_X: $(pane_text "$PANE1")"
fi
launch_tui "$PANE2" --session "$SESSION_X"
if wait_pane_refused "$PANE2" 40; then
  ok "B was refused for $SESSION_X (SessionAlreadyOwnedError notice)"
else
  bad "B was NOT refused: $(pane_text "$PANE2")"
fi
# X must be intact: the official read path still validates the artifact,
# and A (the owner) is still live on X.
READ_OUT="$(node "$E2E_HOME/writer.mjs" read "$E2E_HOME/sessions" "$SESSION_X")"
case "$READ_OUT" in
  READ-OK*) ok "X intact after the refused resume ($READ_OUT)" ;;
  *) bad "X unreadable after the refused resume: $READ_OUT" ;;
esac
if pane_mounted "$PANE1" "$SESSION_X"; then
  ok "A still live on $SESSION_X after B's refusal"
else
  bad "A disturbed by B's refusal: $(pane_text "$PANE1")"
fi
assert_no_owner_lock "$SESSION_DIR" "case1"
# Both panes must be back at the shell before the next case: A exits
# cleanly (this is also the clean-dispose precondition of Case 2), and B's
# refused sessionless TUI must go too.
quit_pane "$PANE1"
quit_pane "$PANE2"

# ── 8. Case 2: clean dispose releases ownership ─────────────────────────
echo "== Case 2: clean dispose releases ownership =="
quit_pane "$PANE1"
launch_tui "$PANE2" --session "$SESSION_X"
if wait_pane_mounted "$PANE2" "$SESSION_X" 40; then
  ok "B opened $SESSION_X after A's clean exit (dispose released the lease)"
else
  bad "B did not open $SESSION_X after A's clean exit: $(pane_text "$PANE2")"
fi
assert_no_owner_lock "$SESSION_DIR" "case2"
quit_pane "$PANE2"

# ── 9. Case 3: crash releases kernel ownership ──────────────────────────
echo "== Case 3: crash (kill -9) releases kernel ownership =="
launch_tui "$PANE1" --session "$SESSION_X"
if wait_pane_mounted "$PANE1" "$SESSION_X" 40; then
  ok "A opened $SESSION_X"
else
  bad "A did not open $SESSION_X: $(pane_text "$PANE1")"
fi
# A's dsh process may take a moment to appear; poll for exactly one PID
# scoped to pane 1.
A_PID=""
elapsed=0
while [ -z "$A_PID" ] && [ "$elapsed" -lt 40 ]; do
  A_PID="$(pane_dsh_pid "$PANE1")"
  if [ -z "$A_PID" ]; then
    sleep 0.5
    elapsed=$((elapsed+1))
  fi
done
if [ -n "$A_PID" ]; then
  ok "A's dsh PID: $A_PID"
  kill -9 "$A_PID"
  sleep 2
else
  bad "no dsh PID found for A in pane 1"
fi
launch_tui "$PANE2" --session "$SESSION_X"
if wait_pane_mounted "$PANE2" "$SESSION_X" 40; then
  ok "B opened $SESSION_X after kill -9 (kernel released the flock — no stale-TTL wait)"
else
  bad "B did not open $SESSION_X after kill -9: $(pane_text "$PANE2")"
fi
assert_no_owner_lock "$SESSION_DIR" "case3"
quit_pane "$PANE2"

# ── 10. Case 4: TUI↔Host (non-TUI writer) ───────────────────────────────
echo "== Case 4: TUI↔Host — authority is not TUI↔TUI-only =="
# Forward: the Host writer holds X → the TUI resume must be refused.
node "$E2E_HOME/writer.mjs" hold "$E2E_HOME/sessions" "$SESSION_X" 60000 \
  > "$E2E_HOME/writer-hold.log" 2>&1 &
WRITER_PID=$!
elapsed=0
while ! grep -q "HOLDING" "$E2E_HOME/writer-hold.log" 2>/dev/null; do
  sleep 0.5
  elapsed=$((elapsed+1))
  if [ "$elapsed" -ge 20 ]; then break; fi
done
if grep -q "HOLDING" "$E2E_HOME/writer-hold.log"; then
  ok "Host writer holds $SESSION_X (official write-open)"
else
  bad "Host writer did not acquire: $(cat "$E2E_HOME/writer-hold.log")"
fi
launch_tui "$PANE1" --session "$SESSION_X"
if wait_pane_refused "$PANE1" 40; then
  ok "TUI resume refused while the Host writer held X"
else
  bad "TUI was NOT refused while the Host writer held X: $(pane_text "$PANE1")"
fi
assert_no_owner_lock "$SESSION_DIR" "case4-forward"
kill "$WRITER_PID" 2>/dev/null || true
wait "$WRITER_PID" 2>/dev/null || true
quit_pane "$PANE1"

# Reverse: the TUI holds X → the Host writer's write-open must be refused.
launch_tui "$PANE1" --session "$SESSION_X"
if wait_pane_mounted "$PANE1" "$SESSION_X" 40; then
  ok "TUI holds $SESSION_X"
else
  bad "TUI did not open $SESSION_X for the reverse direction: $(pane_text "$PANE1")"
fi
WRITER_OUT="$(node "$E2E_HOME/writer.mjs" tryopen "$E2E_HOME/sessions" "$SESSION_X")"
case "$WRITER_OUT" in
  REFUSED*) ok "Host writer refused while the TUI held X ($WRITER_OUT)" ;;
  *) bad "Host writer was NOT refused: $WRITER_OUT" ;;
esac
assert_no_owner_lock "$SESSION_DIR" "case4-reverse"
quit_pane "$PANE1"

# ── summary ─────────────────────────────────────────────────────────────
echo
echo "== e2e-ownership: $PASS passed, $FAIL failed =="
if [ "$FAIL" -ne 0 ]; then
  echo "== FAILURES: keep with --keep for inspection =="
  exit 1
fi
exit 0
