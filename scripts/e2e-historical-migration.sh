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
#   9. the session is CONTINUED through the REAL Agent loop (P1-3): the TUI
#      editor submits the user turn "continue", the resumed Agent runs a
#      real llm.stream against a DETERMINISTIC MOCK LLM (an in-script
#      OpenAI-compatible SSE server behind the official deepseek-official
#      route via the `llm-deepseek` settings section), the assistant reply
#      settles, and the turn/end event lands in the official log — no
#      manual append through the persistence API is involved;
#  10. the TUI is disposed (/exit) — a clean process exit that flushes the
#      live log;
#  11. the TUI reopens the session;
#  12. historical content AND the real new turn (user "continue" + mock
#      assistant reply) both render;
#  13. the old generation's hash is unchanged (source immutability);
#  14. the current generation is readable through the official persistence.
#
# The mock LLM is a self-contained node script (no dependencies) started by
# this script on a random port and killed by PID at teardown. It answers
# every POST /v1/chat/completions with one fixed plain-text reply and no
# tool_calls, so the Agent completes exactly one assistant turn per user
# turn. The E2E profile never needs a real model credential: the official
# DeepSeek adapter (route `deepseek-official`, model `deepseek-v4-flash`)
# resolves its base URL from the profile's `$DSH_HOME/settings.yaml`
# `llm-deepseek:` section and its key from `$DSH_HOME/.credentials.yaml` /
# the environment.
#
# Both chains (v0 and v1) run in SEPARATE fresh DSH_HOMEs: the v1 fixture is
# the official identity migration of the v0 fixture, so both carry the same
# session id and cannot share one root.
#
# Usage:
#   scripts/e2e-historical-migration.sh [--keep]
#
#   --keep    keep the tmux session, DSH_HOMEs, and the mock LLM process on
#             failure for inspection
#
# Environment:
#   MASTER_ENV   path to the master DSH environment (default
#                /tmp/dsh-pi-tui-master-env); its node_modules must hold
#                the master @deepseek-ai packages and its .bin/dsh CLI.
#                Regenerate it with scripts/dsh-source-pack.mjs +
#                scripts/prepare-dsh-test-environment.mjs (source mode)
#                against the pinned deepseek-harness checkout.
#
# This script is intentionally NOT part of `pnpm test:bundle` (it needs a
# real TTY via tmux, the master environment, and ~3min of wall time). Run
# it on demand:  scripts/e2e-historical-migration.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MASTER_ENV="${MASTER_ENV:-/tmp/dsh-pi-tui-master-env}"
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

# Deterministic mock LLM vocabulary (P1-3). The typed user turn is exactly
# "continue" (the review's required gesture); the mock's fixed reply is the
# marker every render/settle assertion searches for.
USER_CONTINUE_TEXT="continue"
MOCK_REPLY_TEXT="deterministic mock reply: continuing the old session"

# ── 0. environment validation ──────────────────────────────────────────
if [ ! -x "$MASTER_ENV/node_modules/.bin/dsh" ]; then
  echo "FAIL: master dsh CLI not found at $MASTER_ENV/node_modules/.bin/dsh" >&2
  echo "      set MASTER_ENV to the master DSH environment" >&2
  echo "      (regenerate: scripts/dsh-source-pack.mjs + scripts/prepare-dsh-test-environment.mjs --mode source)" >&2
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
# Mock LLM server PIDs started by THIS script (one per chain), killed by PID
# in cleanup — never a broad pkill.
MOCK_PIDS=()

# Only this script's own dsh processes: the master CLI's real process
# command line is `node .../@deepseek-ai/dsh/lib/bin.js --profile
# e2e-historical-migration ...`. The unique profile name makes the match
# precise; we kill by PID, never with a broad pkill.
dsh_pids() { pgrep -f "^node .*dsh/lib/bin\.js --profile $PROFILE_NAME" || true; }

cleanup() {
  for pid in $(dsh_pids); do kill "$pid" 2>/dev/null || true; done
  if [ "$KEEP" -eq 1 ]; then
    echo "== kept for inspection: tmux session $TMUX_SESSION, DSH_HOMEs: ${E2E_HOMES[*]:-none}, mock pids: ${MOCK_PIDS[*]:-none} =="
  else
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    for pid in "${MOCK_PIDS[@]:-}"; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    for home in "${E2E_HOMES[@]:-}"; do
      [ -n "$home" ] && rm -rf "$home"
    done
  fi
}
trap cleanup EXIT

# ── deterministic mock LLM (in-script, dependency-free) ─────────────────
# start_mock <home> — starts <home>/mock-llm.mjs, waits for its
# MOCK-READY <port> line, echoes the port ("" on failure).
start_mock() {
  local home="$1"
  local pid log="$home/mock-llm.log"
  local port="" elapsed=0
  node "$home/mock-llm.mjs" >"$log" 2>&1 &
  pid=$!
  MOCK_PIDS+=("$pid")
  while [ "$elapsed" -lt 40 ]; do
    port="$(sed -n 's/^MOCK-READY \([0-9][0-9]*\)$/\1/p' "$log" | head -1)"
    [ -n "$port" ] && break
    sleep 0.5
    elapsed=$((elapsed+1))
  done
  if [ -z "$port" ]; then
    echo "mock llm failed to start:" >&2
    sed 's/^/  /' "$log" >&2 || true
  fi
  echo "$port"
}
# wait_mock_requests <home> <need> <timeout_s> — 0 once the mock served at
# least <need> POST /chat/completions requests (a real llm.stream hit it).
wait_mock_requests() {
  local home="$1" need="$2" timeout="$3" elapsed=0
  while [ "$(grep -c '^REQUEST ' "$home/mock-llm.log" 2>/dev/null || true)" -lt "$need" ]; do
    sleep 0.5
    elapsed=$((elapsed+1))
    if [ "$elapsed" -ge $((timeout*2)) ]; then return 1; fi
  done
  return 0
}

# ── tmux harness (one pane, reused across both chains) ──────────────────
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 50
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
  # The deterministic-mock environment rides on every launch: the
  # e2e-mock-provider profile bundle registers an LlmAdapter for the
  # fixture's durable provider route "mock" and streams REAL HTTP chat
  # completions against the in-script mock server (E2E_MOCK_BASE_URL).
  # DEEPSEEK_API_KEY satisfies the credential plane of the base layer.
  tmux send-keys -t "$PANE" -l "cd $work"
  tmux send-keys -t "$PANE" Enter
  sleep 0.6
  tmux send-keys -t "$PANE" -l "env -u NO_COLOR DSH_TELEMETRY_DISABLED=1 DEEPSEEK_API_KEY=e2e-mock-key E2E_MOCK_BASE_URL=http://127.0.0.1:$MOCK_PORT/v1 E2E_MOCK_REPLY_TEXT="$MOCK_REPLY_TEXT" DSH_HOME=$E2E_HOME $MASTER_ENV/node_modules/.bin/dsh --profile $PROFILE_NAME $*"
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

# ── one full chain: disk-only historical generation → migrated + REAL continuation ──
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
  # The helper scripts (probe/mock) resolve @deepseek-ai from the
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
      "bundles": ["@deepseek-ai/dsh-base", "@xmoon76/dsh-pi-tui", "e2e-mock-provider"]
    }
  }
}
EOF

  # The e2e-mock-provider bundle: registers an LlmAdapter for the fixture's
  # durable provider route "mock" (the released v0 fixture ran against a
  # harness named "mock"; no adapter for it ships in dsh-base). Its stream()
  # makes a REAL HTTP chat-completions request against the in-script mock
  # server, so the continued Agent loop exercises the true llm.stream path.
  mkdir -p "$PROFILE_DIR/node_modules/e2e-mock-provider"
  cat > "$PROFILE_DIR/node_modules/e2e-mock-provider/package.json" <<'PKG'
{
  "name": "e2e-mock-provider",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "index.mjs",
  "exports": { ".": "./index.mjs" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
PKG
  cat > "$PROFILE_DIR/node_modules/e2e-mock-provider/cordis.patch.yml" <<'PATCH'
- insert:
    - id: e2e-mock-provider
      name: 'e2e-mock-provider'
      inject: [llm]
PATCH
  cat > "$PROFILE_DIR/node_modules/e2e-mock-provider/index.mjs" <<'PLUGIN'
// Deterministic mock LLM adapter (E2E only): the fixture sessions carry a
// durable provider route "mock" (they were recorded against a harness of
// that name), which no shipped dsh-base adapter owns. This bundle registers
// a minimal LlmAdapter for "mock" that performs a REAL OpenAI-compatible
// chat-completions request against E2E_MOCK_BASE_URL (the in-script mock
// server) and emits the canonical text block (block-start -> text-deltas ->
// block-end -> usage -> finish), so the Agent loop's llm.stream really runs.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const REPLY = process.env.E2E_MOCK_REPLY_TEXT ?? 'deterministic mock reply: continuing the old session'
const BASE = process.env.E2E_MOCK_BASE_URL

export const name = 'e2e-mock-provider'
export const inject = ['llm']

export function apply(ctx) {
  const adapter = new (class extends LlmAdapter {
    async *stream(options) {
      if (BASE === undefined) throw new Error('e2e mock provider: E2E_MOCK_BASE_URL is not set')
      const messages = [
        ...(options.system === undefined || options.system === '' ? [] : [{ role: 'system', content: options.system }]),
        ...(options.messages ?? []).map(message => ({ role: message.role, content: JSON.stringify(message.content) })),
      ]
      const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-mock-key' },
        body: JSON.stringify({ model: options.model, stream: true, messages }),
        signal: options.signal,
      })
      if (!response.ok || response.body === null) {
        throw new Error(`e2e mock provider: HTTP ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let text = ''
      let index = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newline
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') {
              buffer = ''
              break
            }
            if (payload === '') continue
            let parsed
            try { parsed = JSON.parse(payload) } catch { continue }
            const delta = parsed?.choices?.[0]?.delta
            const piece = typeof delta?.content === 'string' ? delta.content : ''
            if (piece === '') continue
            if (text === '') yield { type: 'block-start', index, blockType: 'text' }
            text += piece
            yield { type: 'text-delta', index, text: piece }
          }
        }
      } finally {
        reader.releaseLock()
      }
      if (text !== '') {
        yield { type: 'block-end', index, block: { type: 'text', text } }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: REPLY.length } }
      yield { type: 'finish', reason: 'completed' }
    }
  })()
  ctx.llm.registerAdapter(['mock'], adapter)
}
PLUGIN
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
//   scan <root> <id> <userNeedle> <assistantNeedle>
//                     — committed-log scan for the real-continuation turn:
//                       prints SCAN events:<n> user-hit:<0|1>
//                       assistant-hit:<0|1> assistant-msgs:<n> turn-ends:<n>
//                       (user/message text containing userNeedle,
//                       assistant/message text containing assistantNeedle).
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [mode, root, id] = process.argv.slice(2)

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

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
} else if (mode === 'scan') {
  const [userNeedle, assistantNeedle] = process.argv.slice(5)
  try {
    const handle = await persistence.open(id, 'read')
    const events = await handle.read(0)
    await handle.close()
    let userHit = 0
    let assistantHit = 0
    let assistantMsgs = 0
    let turnEnds = 0
    for (const event of events) {
      const data = event.data ?? event
      if (event.type === 'user/message') {
        if (contentText(data.content).includes(userNeedle)) userHit = 1
      } else if (event.type === 'assistant/message') {
        assistantMsgs += 1
        if (contentText(data.message?.content ?? data.content).includes(assistantNeedle)) assistantHit = 1
      } else if (event.type === 'turn/end') {
        turnEnds += 1
      }
    }
    console.log(`SCAN events:${events.length} user-hit:${userHit} assistant-hit:${assistantHit} assistant-msgs:${assistantMsgs} turn-ends:${turnEnds}`)
  } catch (error) {
    console.log(`SCAN-FAILED ${id}: ${error?.message ?? String(error)}`)
  }
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
EOF

  # The dependency-free deterministic mock LLM (OpenAI-compatible SSE). The
  # resumed Agent's real llm.stream hits POST {base}/chat/completions; the
  # mock replies with one fixed plain-text stream and no tool_calls, so the
  # Agent settles exactly one assistant turn.
  cat > "$E2E_HOME/mock-llm.mjs" <<EOF
#!/usr/bin/env node
// Deterministic OpenAI-compatible SSE mock for the historical-migration
// E2E real-continuation chain (P1-3). No dependencies.
// Usage: node mock-llm.mjs [replyText]
import { createServer } from 'node:http'

const reply = process.argv[2] ?? '$MOCK_REPLY_TEXT'

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let model = null
    try {
      const body = raw === '' ? {} : JSON.parse(raw)
      model = body.model ?? null
    } catch {
      // request without JSON body: not a chat completion
    }
    console.log(\`REQUEST \${JSON.stringify({ method: req.method, url: req.url, model })}\`)
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock: not a chat completion' } }))
      return
    }
    const id = 'chatcmpl-e2e-mock'
    const created = Math.floor(Date.now() / 1000)
    const send = (obj) => res.write(\`data: \${JSON.stringify(obj)}\n\n\`)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // The first role-only delta is a no-op (must not open a text block).
    send({ id, object: 'chat.completion.chunk', created, model: model ?? 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    const step = Math.max(1, Math.ceil(reply.length / 8))
    for (let i = 0; i < reply.length; i += step) {
      send({ id, object: 'chat.completion.chunk', created, model: model ?? 'deepseek-v4-flash', choices: [{ index: 0, delta: { content: reply.slice(i, i + step) }, finish_reason: null }] })
    }
    send({
      id, object: 'chat.completion.chunk', created, model: model ?? 'deepseek-v4-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(0, '127.0.0.1', () => {
  console.log(\`MOCK-READY \${server.address().port}\`)
})
EOF

  # ── 3. mock LLM + official model configuration (P1-3) ─────────────────
  # The resumed Agent must be able to run a REAL llm.stream. The profile
  # mounts the official dsh-base, whose default model selection is route
  # `deepseek-official` / model `deepseek-v4-flash` (agent-default-model) —
  # the session header of a historical session carries no durable model, so
  # the resume falls back to that default. The `llm-deepseek` settings
  # section points the adapter at the local mock (per-request resolution)
  # and pins reasoning off; the key comes from the managed credentials
  # document and the inherited environment.
  MOCK_PORT="$(start_mock "$E2E_HOME")"
  if [ -z "$MOCK_PORT" ]; then
    bad "$label: mock LLM server did not start"
    return 0
  fi
  cat > "$E2E_HOME/settings.yaml" <<EOF
llm-deepseek:
  baseURL: http://127.0.0.1:$MOCK_PORT/v1
  reasoningEffort: off
EOF
  cat > "$E2E_HOME/.credentials.yaml" <<'EOF'
version: 1
refs:
  DEEPSEEK_API_KEY: e2e-mock-key
EOF
  chmod 600 "$E2E_HOME/settings.yaml" "$E2E_HOME/.credentials.yaml"
  ok "$label: deterministic mock LLM ready on 127.0.0.1:$MOCK_PORT (deepseek-official route)"

  # ── 4. fs-ext native binding (write-lease prerequisite) ────────────────
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

  # ── 5. place the historical generation on disk (step 1) ───────────────
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

  # ── 6. official list/stat discovers it, WITHOUT migrating (step 2) ─────
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

  # ── 7. record the old generation hash (step 4) ────────────────────────
  HASH_BEFORE="$(sha256sum "$SESSION_DIR/$source_name" | cut -d' ' -f1)"
  ok "$label: recorded source hash $HASH_BEFORE"

  # ── 8. TUI picker displays the session (step 3) ───────────────────────
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

  # ── 9. TUI resume → official migration publishes the successor (5/6/7) ─
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

  # ── 10. resumed transcript renders the migrated history (step 8) ───────
  PANE_NOW="$(pane_text "$PANE")"
  if echo "$PANE_NOW" | grep -q "hello" && echo "$PANE_NOW" | grep -q "late" \
    && echo "$PANE_NOW" | grep -q "Compacted 4 history items"; then
    ok "$label: transcript renders migrated history (assistant reply + last user message + compaction summary)"
  else
    bad "$label: transcript missing migrated content: $PANE_NOW"
  fi

  # ── 11. REAL continuation through the live Agent loop (steps 9/10) ─────
  # The review gap (P1-3): the old chain proved the persistence API can
  # append after migration by quit + manual append-turn. THIS chain keeps
  # the TUI mounted and submits "continue" in the editor: the real Agent
  # loop follows up, calls the deterministic mock LLM over the wire, the
  # assistant/message settles, and the official log records the turn.
  tmux send-keys -t "$PANE" -l "$USER_CONTINUE_TEXT"
  sleep 0.3
  tmux send-keys -t "$PANE" Enter
  # The mock must receive the real llm.stream request…
  if wait_mock_requests "$E2E_HOME" 1 90; then
    ok "$label: mock LLM received the Agent's llm.stream request"
  else
    bad "$label: mock LLM received no request — agent loop did not run: $(tail -20 "$E2E_HOME/mock-llm.log" | sed 's/^/  /')"
  fi
  # …and the TUI must render the assistant reply live.
  if wait_pane_text "$PANE" "continuing the old session" 90; then
    ok "$label: real agent reply rendered in the live TUI"
  else
    bad "$label: agent reply not rendered: $(pane_text "$PANE")"
  fi
  # Settle evidence while the process is still alive: the official committed
  # log must come to hold the real turn (user "continue" + the mock
  # assistant reply + a second turn/end) BEFORE /exit — recorded by the
  # Agent loop itself, never by a manual persistence append. Poll the
  # official read handle; converging on the same state across two reads
  # spaced apart means the Agent has settled (no further writes).
  SCAN_OK=0
  elapsed=0
  SCAN_STABLE=0
  SCAN_OUT=""
  while [ "$elapsed" -lt 100 ]; do
    SCAN_OUT="$(node "$E2E_HOME/probe.mjs" scan "$E2E_HOME/sessions" "$SESSION_ID" "$USER_CONTINUE_TEXT" "continuing the old session")"
    SCAN_TURNS="$(echo "$SCAN_OUT" | sed -n 's/.*turn-ends:\([0-9][0-9]*\).*/\1/p')"
    if echo "$SCAN_OUT" | grep -q "user-hit:1" \
      && echo "$SCAN_OUT" | grep -q "assistant-hit:1" \
      && [ "${SCAN_TURNS:-0}" -ge 2 ]; then
      SCAN_OK=1
      sleep 2
      SCAN_AFTER="$(node "$E2E_HOME/probe.mjs" scan "$E2E_HOME/sessions" "$SESSION_ID" "$USER_CONTINUE_TEXT" "continuing the old session")"
      if [ "$SCAN_AFTER" = "$SCAN_OUT" ]; then
        SCAN_STABLE=1
        break
      fi
    fi
    sleep 0.5
    elapsed=$((elapsed+1))
  done
  echo "$SCAN_OUT" | sed 's/^/  /'
  if [ "$SCAN_OK" -eq 1 ] && [ "$SCAN_STABLE" -eq 1 ]; then
    ok "$label: committed log settled BEFORE /exit (user + mock assistant + turn/end, stable)"
  elif [ "$SCAN_OK" -eq 1 ]; then
    ok "$label: committed log holds the real turn (settle confirmed after /exit flush)"
  else
    bad "$label: committed log missing the real turn while live: $SCAN_OUT"
  fi
  # Clean dispose flushes the live log (/exit), then the committed log must
  # still hold the REAL turn — the post-exit authoritative re-check.
  quit_pane
  SCAN_OUT="$(node "$E2E_HOME/probe.mjs" scan "$E2E_HOME/sessions" "$SESSION_ID" "$USER_CONTINUE_TEXT" "continuing the old session")"
  echo "$SCAN_OUT" | sed 's/^/  /'
  SCAN_TURNS="$(echo "$SCAN_OUT" | sed -n 's/.*turn-ends:\([0-9][0-9]*\).*/\1/p')"
  if echo "$SCAN_OUT" | grep -q "user-hit:1" \
    && echo "$SCAN_OUT" | grep -q "assistant-hit:1" \
    && [ "${SCAN_TURNS:-0}" -ge 2 ]; then
    ok "$label: committed log holds the real continue turn after /exit (user + mock assistant + turn/end)"
  else
    bad "$label: committed log missing the real turn after /exit: $SCAN_OUT"
  fi
  MOCK_REQS="$(grep -c '^REQUEST ' "$E2E_HOME/mock-llm.log" || true)"
  echo "  mock llm served $MOCK_REQS chat-completion request(s):"
  grep '^REQUEST ' "$E2E_HOME/mock-llm.log" | sed 's/^/    /'

  # ── 12. reopen: history + real continuation turn both render (11/12) ───
  launch_tui "$WORK_DIR" --session "$SESSION_ID"
  if wait_pane_mounted "$PANE" "$SESSION_ID" 40; then
    ok "$label: TUI reopened the session"
  else
    bad "$label: TUI did not reopen: $(pane_text "$PANE")"
  fi
  PANE_NOW="$(pane_text "$PANE")"
  if echo "$PANE_NOW" | grep -q "hello" && echo "$PANE_NOW" | grep -q "late" \
    && echo "$PANE_NOW" | grep -q "continuing the old session" \
    && echo "$PANE_NOW" | grep -wq "$USER_CONTINUE_TEXT"; then
    ok "$label: reopened transcript renders history AND the real continue turn"
  else
    bad "$label: reopened transcript incomplete: $PANE_NOW"
  fi
  quit_pane

  # ── 13. source immutability + official read of the current gen (13/14) ─
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

  # Chain teardown: stop THIS chain's mock (cleanup covers leftovers too).
  for pid in "${MOCK_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  MOCK_PIDS=()
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
