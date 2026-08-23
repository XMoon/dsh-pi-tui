#!/usr/bin/env bash
# Real two-process E2E for the session lease lifecycle (PR #13).
#
# Covers the merge-gate regressions that headless suites cannot:
#
#   Case 4 (merge blocker) — same-process reopen during COOLING:
#     P1 open A → switch A→B (A enters COOLING) → switch B→A BEFORE the
#     cooling release (~2s window) → wait past the old release time →
#     P2 open A must be REFUSED (A is active again and still owned by P1).
#     PROOF of the reactivation window: A's owner.lock INODE must stay
#     unchanged across the B→A switch. A physical release would unlink the
#     lock and a RELEASED re-acquire would create a NEW file (new inode);
#     an unchanged inode proves the same held lock was never released, so
#     reserveForActivation really took the held-COOLING reactivation path.
#
#   ABA (recommended) — cooling#1 → reactivate → cooling#2:
#     A→B (cooling#1) → B→A (reactivation) → A→B (cooling#2). The old
#     verifier #1 must be epoch-stale: the lock must NOT disappear early
#     (the current cooling#2 cannot settle before ~1.5s), and only the
#     CURRENT (epoch2) release may hand A back (then P2 opens it).
#
# The E2E runs the REAL bundle (this repo's dist/) in TWO real dsh
# processes under an isolated DSH_HOME with a dedicated profile, driven
# through tmux. It does NOT need a model connection: the sessions are
# pre-seeded as minimal durable artifacts, and /resume switches them.
#
# Usage:
#   scripts/e2e-session-lease.sh [--keep] [--no-aba]
#
#   --keep    keep the tmux session and DSH_HOME on failure for inspection
#   --no-aba  skip the ABA lifecycle case
#
# This script is intentionally NOT part of `pnpm test:bundle` (it needs a
# real TTY via tmux, a pnpm-installable profile, and ~40s of wall time).
# Run it on demand:  scripts/e2e-session-lease.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_NAME="e2e-lease"
KEEP=0
RUN_ABA=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-aba) RUN_ABA=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

E2E_HOME="$(mktemp -d /tmp/dsh-e2e-lease-XXXXXX)"
TMUX_SESSION="dsh-e2e-lease-$$"
WORK_DIR="$E2E_HOME/work"
PROFILE_DIR="$E2E_HOME/profiles/$PROFILE_NAME"

# The session project key for WORK_DIR (see projectKey in
# session-persistence-jsonl: slashes become "-", unsafe units escape as
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

PASS=0
FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "== kept for inspection: tmux session $TMUX_SESSION, DSH_HOME $E2E_HOME =="
  else
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    rm -rf "$E2E_HOME"
  fi
}
trap cleanup EXIT

# ── 1. profile + isolated DSH_HOME ───────────────────────────────────────
echo "== setup: isolated DSH_HOME at $E2E_HOME =="
mkdir -p "$PROFILE_DIR" "$WORK_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-e2e-rewind",
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
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
if ! (cd "$PROFILE_DIR" && CI=true pnpm install --silent 2>/dev/null); then
  echo "FAIL: pnpm install for the E2E profile failed" >&2
  exit 1
fi

# ── 2. seed two durable session artifacts ───────────────────────────────
# Hand-seeded minimal artifacts: header frame + one event frame (the JSONL
# backend's per-frame container). The owner.lock lives next to the log.
seed_session() {
  local id="$1"
  local dir="$E2E_HOME/sessions/$PROJECT_KEY/$id"
  mkdir -p "$dir"
  printf '%s\n' "{\"type\":\"session\",\"version\":0,\"id\":\"$id\",\"createdAt\":1787409012905,\"cwd\":\"$WORK_DIR\",\"delegationDepth\":0,\"agentPreset\":\"standard\"}" \
    | zstd -q -c > "$dir/f1"
  printf '%s\n' \
    "{\"type\":\"permission/preset\",\"seq\":0,\"time\":1787409012921,\"data\":{\"preset\":\"danger-full-access\"}}" \
    "{\"type\":\"sandbox/mode\",\"seq\":1,\"time\":1787409012925,\"data\":{\"mode\":\"danger-full-access\"}}" \
    | zstd -q -c > "$dir/f2"
  cat "$dir/f1" "$dir/f2" > "$dir/session.jsonl.zstd"
  rm -f "$dir/f1" "$dir/f2"
}
SESSION_A="session-e2e-a"
SESSION_B="session-e2e-b"
seed_session "$SESSION_A"
seed_session "$SESSION_B"

lock_path() { echo "$E2E_HOME/sessions/$PROJECT_KEY/$1/session.jsonl.zstd.owner.lock"; }
lock_inode() { stat -c %i "$(lock_path "$1")" 2>/dev/null || echo "MISSING"; }

# ── 3. tmux harness ─────────────────────────────────────────────────────
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 34
tmux split-window -t "$TMUX_SESSION" -h
PANE1="$TMUX_SESSION:0.0"
PANE2="$TMUX_SESSION:0.1"

title_of() { tmux display-message -t "$1" -p '#{pane_title}' 2>/dev/null || true; }
now_ms() { date +%s%3N; }
LAST_ENTER_MS=0
send_cmd() { # send_cmd <pane> <text> — paced to dodge the PasteBurst trap
  tmux send-keys -t "$1" -l "$2"
  sleep 0.2
  tmux send-keys -t "$1" Enter
  LAST_ENTER_MS="$(now_ms)" # the Enter that triggers the command
}
wait_title() { # wait_title <pane> <substr> <timeout_s> — 0 on match, 1 on timeout
  local pane="$1" want="$2" timeout="$3" elapsed=0
  while [[ "$(title_of "$pane")" != *"$want"* ]]; do
    sleep 0.2
    elapsed=$((elapsed+1))
    if [ "$elapsed" -ge $((timeout*5)) ]; then return 1; fi
  done
  return 0
}
launch_p2() { # launch_p2  — a fresh dsh attempt on session A in pane 2
  tmux send-keys -t "$PANE2" -l "env -u NO_COLOR DSH_HOME=$E2E_HOME dsh --profile $PROFILE_NAME --session $SESSION_A"
  sleep 0.4
  tmux send-keys -t "$PANE2" Enter
}
p2_out() {
  tmux capture-pane -t "$PANE2" -p 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tr '\n' ' ' || true
}

# ── 4. Case 4: same-process reopen during COOLING ───────────────────────
echo "== Case 4: A → B (cooling) → A (reactivation) → P2 refused =="
tmux send-keys -t "$PANE1" -l "env -u NO_COLOR DSH_HOME=$E2E_HOME dsh --profile $PROFILE_NAME --session $SESSION_A"
sleep 0.4
tmux send-keys -t "$PANE1" Enter
if ! wait_title "$PANE1" "$SESSION_A" 20; then bad "P1 did not open $SESSION_A"; else ok "P1 opened $SESSION_A"; fi

# Switch A → B: A must enter COOLING with its lock still held. Record the
# authoritative cooling-start LOWER BOUND: the Enter of the A→B command
# (LAST_ENTER_MS right after this send_cmd). beginCooling cannot happen
# before that Enter, so the old verifier's earliest release (quiet 1s + 2
# interval sleeps ≈ 2000ms after ITS beginCooling) is AT OR AFTER that
# Enter + 2000.
send_cmd "$PANE1" "/resume $SESSION_B"
T_A2B_ENTER="$LAST_ENTER_MS" # the A→B Enter (cooling#1 lower bound)
if ! wait_title "$PANE1" "$SESSION_B" 120; then bad "P1 did not switch to $SESSION_B"; else ok "P1 switched to $SESSION_B"; fi
A_LOCK="$(lock_path "$SESSION_A")"
if [ -f "$A_LOCK" ]; then ok "A lock still held during cooling"; else bad "A lock lost during cooling"; fi
INODE_COOLING="$(lock_inode "$SESSION_A")"

# Switch B → A INSIDE the cooling window. The OLD verifier's earliest
# possible release: quiet 1s, then sampling starts immediately — the 3rd
# stable sample (release point) is 1000 + 2×500 = 2000ms after ITS
# beginCooling, which cannot precede the A→B Enter (T_A2B_ENTER). So
# earliest release >= T_A2B_ENTER + 2000ms. The reactivation COMPLETES
# no later than the moment wait_title(A) returns (T_REACT_DONE). If
# T_REACT_DONE is before T_A2B_ENTER + 2000ms, the reactivation finished
# before the old verifier could possibly release — overlap is GUARANTEED
# regardless of title-update latency. The unchanged inode is a secondary
# witness.
send_cmd "$PANE1" "/resume $SESSION_A"
if ! wait_title "$PANE1" "$SESSION_A" 120; then bad "P1 did not switch back to $SESSION_A"; else ok "P1 reactivated $SESSION_A during cooling"; fi
T_REACT_DONE="$(now_ms)"
REACT_MS=$((T_REACT_DONE - T_A2B_ENTER))
INODE_REACTIVATED="$(lock_inode "$SESSION_A")"
if [ "$REACT_MS" -lt 2000 ] && [ "$INODE_COOLING" = "$INODE_REACTIVATED" ] && [ "$INODE_COOLING" != "MISSING" ]; then
  ok "reactivation completed ${REACT_MS}ms after the A→B Enter (<2.0s earliest-release bound), same held lock (inode $INODE_COOLING)"
else
  bad "reactivation not inside the cooling window: ${REACT_MS}ms (inode $INODE_COOLING → $INODE_REACTIVATED)"
fi

# Wait PAST the original cooling release time: the old verifier must have
# been stale, so A stays owned by P1 (same lock, same inode).
sleep 3
if [ -f "$A_LOCK" ] && [ "$(lock_inode "$SESSION_A")" = "$INODE_REACTIVATED" ]; then
  ok "A still owned by P1 past the old release time (same lock)"
else
  bad "A lost its lock after reactivation"
fi

# P2 (second real dsh process) tries to open A: must be REFUSED.
launch_p2
sleep 3
if echo "$(p2_out)" | grep -qi "refus\|held\|locked\|stays"; then ok "P2 was refused for $SESSION_A"; else bad "P2 was NOT refused: $(p2_out)"; fi

# ── 5. ABA: cooling#1 → reactivate → cooling#2 ──────────────────────────
if [ "$RUN_ABA" -eq 1 ]; then
  echo "== ABA: A→B→A→B — old verifier must be stale =="
  # From A (just reactivated): B → A → B quickly. The OVERLAP proof: the
  # first A→B Enter (T_ABA_ENTER) is the LOWER BOUND of cooling#1's
  # beginCooling, so verifier #1's earliest release is >= that Enter +
  # 2000ms (quiet 1s + 2×0.5s interval sleeps; sampling starts right
  # after the quiet). If cooling#2's start (the third switch's
  # wait_title return, an UPPER bound for its beginCooling) happens
  # before the first Enter + 2000ms, verifier #1 is GUARANTEED to still
  # be running when cooling#2 begins — the ABA race is real. The
  # lock-disappearance timing below then distinguishes a stale-verifier
  # leak (<1.2s, impossible for the current epoch) from the current
  # epoch's normal verified release.
  send_cmd "$PANE1" "/resume $SESSION_B"
  T_ABA_ENTER="$LAST_ENTER_MS" # the first A→B Enter (cooling#1 lower bound)
  wait_title "$PANE1" "$SESSION_B" 120
  send_cmd "$PANE1" "/resume $SESSION_A"
  wait_title "$PANE1" "$SESSION_A" 120
  send_cmd "$PANE1" "/resume $SESSION_B"
  wait_title "$PANE1" "$SESSION_B" 120
  T_ABA2="$(now_ms)" # cooling#2 started (upper bound of its beginCooling)
  ABA_OVERLAP_MS=$((T_ABA2 - T_ABA_ENTER))
  if [ "$ABA_OVERLAP_MS" -lt 2000 ]; then
    ok "cooling#2 began ${ABA_OVERLAP_MS}ms after the cooling#1 Enter — old verifier #1 was still running (real ABA race)"
  else
    bad "cooling#2 began ${ABA_OVERLAP_MS}ms after the cooling#1 Enter — no overlap with the old verifier (race not exercised)"
  fi
  # The CURRENT cooling epoch cannot settle before quiet 1s + one 0.5s
  # sample ≈ 1.5s. The OLD verifier #1, if it were NOT epoch-stale, would
  # release A early (its own samples completed around the last switch).
  # Measure when the lock disappears: before 1.2s = stale-verifier leak;
  # after ~1.5s = the CURRENT epoch's release.
  start_ms=$(now_ms)
  elapsed=0
  while [ -f "$(lock_path $SESSION_A)" ] && [ "$elapsed" -lt 60 ]; do
    sleep 0.1
    elapsed=$((elapsed+1))
  done
  if [ -f "$(lock_path $SESSION_A)" ]; then
    bad "A lock never released within 6s of cooling#2"
  else
    gone_ms=$(now_ms)
    gap_ms=$((gone_ms - start_ms))
    if [ "$gap_ms" -lt 1200 ]; then
      bad "A lock released ${gap_ms}ms into cooling#2 — a stale verifier released a later lifecycle"
    else
      ok "lock held through the stale-verifier window; released at ${gap_ms}ms (current epoch)"
    fi
  fi
  # The CURRENT cooling#2 released the lock; P2 may now open A.
  launch_p2
  sleep 4
  if [[ "$(title_of "$PANE2")" == *"$SESSION_A"* ]]; then
    ok "P2 opened $SESSION_A after the epoch2 release"
  else
    bad "P2 could not open A after release: $(p2_out)"
  fi
fi

# ── summary ─────────────────────────────────────────────────────────────
echo
echo "== e2e-session-lease: $PASS passed, $FAIL failed =="
if [ "$FAIL" -ne 0 ]; then
  echo "== FAILURES: keep with --keep for inspection =="
  exit 1
fi
exit 0
