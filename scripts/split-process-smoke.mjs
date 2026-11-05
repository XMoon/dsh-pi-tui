#!/usr/bin/env node
/**
 * Real-OS split-process authenticated-link smoke.
 *
 * Installs the candidate tarball into an isolated `pi-tui` profile using the
 * published exact DSH family, then drives the two internal process entries
 * from the installed package directory. The lane proves the lifecycle
 * assertions that still hold plus the first-launch gates:
 *
 *   T01 Host-only composition + official Connection/API-remotes owners
 *   T02 authenticated loopback HTTP + one real WebSocket `$events` generation
 *   T03/T04/T06 unauthenticated, wrong-token, wrong-identity refusals
 *   T05 one mux socket per authenticated peer; old Peer is dead after release
 *   T07 private-file permissions/symlinks fail closed
 *   T08 sixteen concurrent Host launches produce exactly one Host
 *   T09 two REAL Surface Clients (distinct PTYs/PIDs) admit to the SAME Host
 *   T09Q two qualification Clients race the ONE qualification-only Client seat
 *   M5B-01 two REAL Surface Clients retain the SAME Session X: shared history
 *                and Host stream, shared pending inbox plus the official
 *                empty-draft Ctrl+S steer of the other Client's occurrence,
 *                two independent same-text submits (never merged), A -> Y
 *                navigation while B keeps writing X, B-only exit
 *   T10/T11/T12 Client normal exit, SIGKILL and SIGTERM leave the Host alive
 *   T13 a physical mux drop clears the generation and the same Host replaces it
 *   T14/T16/T17 forged registry, unresponsive Host, protocol/identity/auth failures
 *                and non-destructive installed-payload drift
 *   T15 a dead Host leaves only a stale candidate; a Client safely starts a new one
 *   T75 the PRODUCT Browser x real Split TUI qualification (WP-01..WP-10):
 *                token->Cookie->official Web shell, two-way Session/Turn,
 *                Question/Approval first settlement, TUI reload/exit/SIGKILL,
 *                `/web` toggle + recomposition, locality and the feature matrix
 *   T73 the official Web frontend runtime toggle on ONE Host: default-off
 *                serving, setEnabled(true) mounting the 59 declared rows,
 *                setEnabled(false) while a real TUI holds an accepted Turn (the
 *                Turn settles, the TUI keeps its Session and keeps prompting),
 *                a second enable on the SAME process with a real Chromium run,
 *                a second disable, and the refusing negative lanes
 *   T18 installed package shape and Direct `--help` remain unchanged
 *   T19 signal admission precedes publication; repeated same signals stay idempotent (no ready)
 *   T20 an early forced exit removes the Host-created scratch before profile boot
 *   T21 the official Session-serving rows, the ONE official Workspace registry /
 *                controller pair, and ONE built-in Host Runtime row are ACTIVE
 *   T22/T23/T24 a real Client PID proves official session/list, private PiFile RPC
 *                and the private terminal-progress snapshot over the authenticated link
 *   T25 repeated probes register no duplicate descriptor; Client exit keeps the same Host
 *   T26 Host Runtime row/artifact absence / required official row / Workspace
 *                Controller row disabled / Cookie fail closed, no Ready
 *   T27 a real `workspace` Remote creates a Host Workspace, is idempotent, and
 *                restores its baseline for a later Client PID after generation
 *                replacements
 *
 * Usage: node scripts/split-process-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:split-process -- [path-to-candidate.tgz]
 *
 * Set SPLIT_PROCESS_SMOKE_KEEP=1 to preserve the isolated work directory and
 * SPLIT_PROCESS_TRACE=<path> to append sanitized qualification events (never a
 * token, Cookie or connect URL).
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { setTimeout as sleepTimer } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { PACKAGE_ROOT } from './lib/dsh-distribution.mjs'
import {
  boundedName,
  createSmokeDiagnostics,
  emitInputFailure,
  forensicErrorText,
  safeFailureSummary,
  smokeArtifactIdentity,
  SplitSmokeAssertionError,
  SplitSmokeInputError,
  SplitSmokeWaitError,
} from './lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent, writeC1WorkFixture } from './lib/split-smoke-fixtures.mjs'
import {
  createSplitSmokeProfile,
  inspectSplitCandidate,
} from './lib/split-smoke-profile.mjs'
import {
  alive,
  assertClientHostFacts,
  assertIdentityFields,
  chunk,
  connectCookie,
  createSplitProcessScope,
  fetchStatus,
  findIsolatedProcesses,
  hostStatus,
  killIsolatedProcesses,
  killTracked,
  lastSurfaceStatus,
  productionBuildId,
  readJson,
  readStartIdentity,
  saveFile,
  seatFree,
  waitForAnyReady,
  waitForCondition,
  waitForOutcome,
  waitForSurfaceStatus,
  waitGone,
} from './lib/split-smoke-processes.mjs'
import {
  listSelectableCases,
  parseSelectionArgs,
  resolveSelection,
  selectedPassLine,
} from './lib/split-smoke-selection.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  sha16,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from './lib/split-smoke-sessions.mjs'
import { ENTRY_ADMISSION_MUTATIONS } from './smoke/split-process/entry-admission.mjs'

// Re-exported for the tooling guards that drive the bounded condition wait.
export { waitForCondition }


const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const TRACE_PATH = process.env.SPLIT_PROCESS_TRACE
const KEEP = process.env.SPLIT_PROCESS_SMOKE_KEEP === '1'
/** Qualification-only failure point for the smoke's own finally cleanup proof. */
const FAILPOINT = process.env.SPLIT_PROCESS_SMOKE_FAIL_AFTER
/**
 * Whether THIS run must prove the real Browser case. The CI release-tag lane
 * has no pinned Playwright install, so it legitimately reports the Browser
 * case as NOT_RUN and never claims it; a PR-A qualification run sets this to
 * turn a missing Browser into a hard failure.
 */
const REQUIRE_WEB_BROWSER = process.env.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1'
/**
 * M5-W PR-D: whether THIS run must prove the full product Browser x real-TUI
 * qualification (WP-01..WP-10). It defaults OFF and reports `NOT_RUN`; the npm
 * release-tag CI job and a manual PR-D qualification set it to require the
 * whole product matrix. A missing Playwright install, a failed case or a
 * partial matrix is a hard failure only in this required mode.
 */
const REQUIRE_WEB_PRODUCT = process.env.SPLIT_PROCESS_REQUIRE_WEB_PRODUCT === '1'

/**
 * M5-W PR-A: the 59 official Web rows the Host-only overlay declares, in order.
 *
 * The isolated qualification re-reads the LIVE overlay patch the running Host
 * wrote and compares it against this FROZEN list, so a dropped, renamed,
 * reordered or re-enabled row cannot be auto-copied into a green result. Kept
 * as data (not derived from the source) on purpose: generating it would only
 * mirror whatever the implementation currently says.
 */
export const PR_A_WEB_ROWS = [
  { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app' },
  { id: 'modules', name: '@deepseek-ai/dsh-client-modules' },
  { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
  { id: 'cordis-client-runner', name: '@deepseek-ai/dsh-cordis-client-runner' },
  { id: 'ui-open-in-app', name: '@deepseek-ai/dsh-client-ui-open-in-app' },
  { id: 'ui-settings-account', name: '@deepseek-ai/dsh-client-ui-settings-account' },
  { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme' },
  { id: 'locale', name: '@deepseek-ai/dsh-client-locale' },
  { id: 'shortcuts', name: '@deepseek-ai/dsh-client-shortcuts' },
  { id: 'ui-shortcuts', name: '@deepseek-ai/dsh-client-ui-shortcuts' },
  { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout' },
  { id: 'ui-renderer', name: '@deepseek-ai/dsh-client-ui-renderer' },
  { id: 'ui-session', name: '@deepseek-ai/dsh-client-ui-session' },
  { id: 'resources', name: '@deepseek-ai/dsh-client-resources' },
  { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
  { id: 'ui-sidebar-right', name: '@deepseek-ai/dsh-client-ui-sidebar-right' },
  { id: 'ui-sidebar-documentpreview', name: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' },
  { id: 'ui-sidebar-terminal', name: '@deepseek-ai/dsh-client-ui-sidebar-terminal' },
  { id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files' },
  { id: 'ui-settings', name: '@deepseek-ai/dsh-client-ui-settings' },
  { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general' },
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models' },
  { id: 'ui-plugin-manager', name: '@deepseek-ai/dsh-client-ui-plugin-manager' },
  { id: 'ui-settings-plugin-inventory', name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory' },
  { id: 'ui-conversation', name: '@deepseek-ai/dsh-client-ui-conversation' },
  { id: 'ui-approval', name: '@deepseek-ai/dsh-client-ui-approval' },
  { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
  { id: 'ui-brand-official', name: '@deepseek-ai/dsh-client-ui-brand-official' },
  { id: 'ui-attachment', name: '@deepseek-ai/dsh-client-ui-attachment' },
  { id: 'ui-tool', name: '@deepseek-ai/dsh-client-ui-tool' },
  { id: 'ui-cordis', name: '@deepseek-ai/dsh-client-ui-cordis' },
  { id: 'ui-deliverables', name: '@deepseek-ai/dsh-client-ui-deliverables' },
  { id: 'ui-workspace', name: '@deepseek-ai/dsh-client-ui-workspace' },
  { id: 'ui-workflow-run', name: '@deepseek-ai/dsh-client-ui-workflow-run' },
  { id: 'ui-input-trigger', name: '@deepseek-ai/dsh-client-ui-input-trigger' },
  { id: 'ui-commands', name: '@deepseek-ai/dsh-client-ui-commands' },
  { id: 'ui-skill', name: '@deepseek-ai/dsh-client-ui-skill' },
  { id: 'ui-subagent', name: '@deepseek-ai/dsh-client-ui-subagent' },
  { id: 'ui-reference', name: '@deepseek-ai/dsh-client-ui-reference' },
  { id: 'ui-secret-mask', name: '@deepseek-ai/dsh-client-ui-secret-mask' },
  { id: 'ui-jobs', name: '@deepseek-ai/dsh-client-ui-jobs' },
  { id: 'ui-schedule', name: '@deepseek-ai/dsh-client-ui-schedule' },
  { id: 'ui-goal', name: '@deepseek-ai/dsh-client-ui-goal' },
  { id: 'ui-message-feedback', name: '@deepseek-ai/dsh-client-ui-message-feedback' },
  { id: 'ui-model-selection', name: '@deepseek-ai/dsh-client-ui-model-selection' },
  { id: 'ui-deepseek-model-label-1017', name: '@deepseek-ai/dsh-client-ui-deepseek-model-label-1017' },
  { id: 'ui-permission', name: '@deepseek-ai/dsh-client-ui-permission-presets' },
  { id: 'ui-agent-preset', name: '@deepseek-ai/dsh-client-ui-agent-preset' },
  { id: 'entry-customization', name: '@deepseek-ai/dsh-client-ui-entry-customization' },
  { id: 'ui-settings-session-log', name: '@deepseek-ai/dsh-client-ui-settings-session-log' },
  { id: 'ui-settings-plugins', name: '@deepseek-ai/dsh-client-ui-settings-plugins' },
  { id: 'ui-settings-shell', name: '@deepseek-ai/dsh-client-ui-settings-shell' },
  { id: 'ui-settings-agent-loop', name: '@deepseek-ai/dsh-client-ui-settings-agent-loop' },
  { id: 'ui-settings-subagent', name: '@deepseek-ai/dsh-client-ui-settings-subagent' },
  { id: 'ui-settings-web-search', name: '@deepseek-ai/dsh-client-ui-settings-web-search' },
  { id: 'ui-plan', name: '@deepseek-ai/dsh-client-ui-plan' },
  { id: 'ui-user-questions', name: '@deepseek-ai/dsh-client-ui-user-questions' },
  { id: 'ui-trajectory', name: '@deepseek-ai/dsh-client-ui-trajectory' },
  { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' },
]

/**
 * The official Web UI's first-run preview-notice version (ownership:
 * `@deepseek-ai/dsh-client-ui-settings-models` `WELCOME_NOTICE_VERSION`). The
 * isolated qualification acknowledges it through the row's own config, so the
 * notice never blocks the real Browser. An rc.5 version bump makes the notice
 * reappear and this lane fail loudly instead of silently skipping the UI.
 */
const PR_A_WELCOME_NOTICE_VERSION = '2026-09-28.1'

const PR_A_WEB_RUNTIME_ID = 'web-runtime'
const PR_A_CLIENT_MODULES_PACKAGE = '@deepseek-ai/dsh-client-modules'
/** The core official Web rows whose OWNER count must stay exactly one. */
const PR_A_SINGLETON_PACKAGES = [
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-cordis-client-runner',
]

/**
 * One bounded raw Server-Sent-Events probe: the first response facts and the
 * first decoded chunk (or the refusal). A non-stream response is drained and
 * reported by status alone.
 */
async function sseProbe (origin, path, timeoutMs = 5_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(new URL(path, origin), { signal: controller.signal, cache: 'no-store' })
    const contentType = response.headers.get('content-type') ?? ''
    let chunk = ''
    if (contentType.startsWith('text/event-stream') && response.body !== null) {
      // Read until ONE complete SSE frame is available: the graph frame can be
      // larger than a single transport chunk.
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (value !== undefined) chunk += decoder.decode(value, { stream: true })
        if (done || chunk.includes('\n\n')) break
      }
      await reader.cancel()
    } else {
      await response.body?.cancel()
    }
    return { status: response.status, contentType, chunk }
  } catch {
    return { status: 0, contentType: '', chunk: '' }
  } finally {
    clearTimeout(timer)
  }
}

/** Keep one SSE stream open and collect its parsed `data:` frames. */
function openSseFrames (origin, path, headers = {}) {
  const url = new URL(path, origin)
  const frames = []
  let buffer = ''
  const request = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { connection: 'keep-alive', ...headers },
  }, response => {
    response.setEncoding('utf8')
    response.on('data', chunk => {
      buffer += chunk
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
        if (data === '') continue
        try {
          const parsed = JSON.parse(data)
          frames.push({ type: parsed.type, rev: parsed.graph?.rev ?? parsed.rev ?? null, id: parsed.id ?? null })
        } catch {
          frames.push({ type: 'unparsed' })
        }
      }
    })
  })
  request.on('error', () => { /* the caller owns the verdict */ })
  request.end()
  return { frames, close: () => request.destroy() }
}

/**
 * Remove every credential shape a Browser/driver diagnostic could carry before
 * it is retained in a trace, a log line or a report: the exact launch token,
 * any `token=` query value and any loopback origin. The plan forbids the
 * authenticated URL/token in the trace, stdout and PR material.
 */
export function redactWebQualificationText (text, secrets = []) {
  let value = String(text)
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue
    value = value.split(secret).join('<redacted-token>')
  }
  return value
    .replace(/([?&]token=)[^&\s"']+/gu, '$1<redacted>')
    .replace(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:<port>')
    .replace(/(^|\n)\s*(cookie|set-cookie|authorization)\s*:[^\n]*/giu, '$1$2: <redacted>')
    .replace(/\b(cookie|set-cookie|authorization)=([^\s;,]+)/giu, '$1=<redacted>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gu, '$1<redacted>')
}

/**
 * Race one promise against an ABORTABLE deadline. The deadline is cancelled in
 * `finally`: a completed race must never keep the Node process alive for the
 * rest of its timeout (an uncancelled delay does exactly that, even when the
 * child exited immediately). Exported so the tooling guard can prove it in a
 * real child process.
 */
export async function raceWithAbortableDeadline (promise, timeoutMs, onExpiry) {
  const expiry = new AbortController()
  try {
    return await Promise.race([promise, sleepTimer(timeoutMs, onExpiry, { signal: expiry.signal })])
  } finally {
    expiry.abort()
  }
}

/**
 * Race one caller-started observation against the real-Browser driver's OWN
 * exit. A driver that has already left can never produce the fact it owns, so
 * the wait fails AT ONCE with the exit facts instead of consuming its whole
 * budget, and the wait it started is cancelled through its signal so no polling
 * timer survives the early failure. Both Browser lanes use this ONE mechanism.
 *
 * @param browserExit - the driver process's own exit promise.
 * @param startWait - starts the observation; receives the cancellation signal.
 * @param prefix - the lane code the failure message names (`PA-05`).
 * @param label - what the wait was proving.
 */
export async function whileBrowserDriverRuns(browserExit, startWait, prefix, label) {
  const stopWait = new AbortController()
  try {
    const outcome = await Promise.race([
      Promise.resolve(startWait(stopWait.signal)).then(value => ({ value }), error => ({ error })),
      browserExit.then(exit => ({ exit })),
    ])
    if (outcome.exit !== undefined) {
      throw new SplitSmokeAssertionError(
        `${prefix} the real-Browser driver exited (${String(outcome.exit.code)}/${String(outcome.exit.signal)}) before ${label}`,
      )
    }
    if (outcome.error !== undefined) throw outcome.error
    return outcome.value
  } finally {
    stopWait.abort()
  }
}

/**
 * A bounded view of ONE driver exit. The losing timer is CANCELLED in the
 * helper, so an un-cancelled delay cannot keep the Node process alive for its
 * whole timeout when the child exited immediately.
 *
 * @param browserExit - the driver process's own exit promise.
 * @param timeoutMs - the bound.
 * @param tag - the diagnostic tag this lane prints on expiry.
 */
export async function browserDriverExitBounded(browserExit, timeoutMs, tag) {
  const bounded = await raceWithAbortableDeadline(browserExit, timeoutMs, { code: null, signal: 'EXIT_TIMEOUT' })
  if (bounded.signal === 'EXIT_TIMEOUT') {
    process.stderr.write(`${tag} the real-Browser driver did not exit inside its bound; the lane cleanup owns it\n`)
  }
  return bounded
}

let traceFd
let statusSequence = 0
/** This run's bounded diagnostics (checkpoints + one default failure report). */
let diagnostics
// The lane's ONE process scope: module-level qualification helpers and the
// full/selected dispatchers resolve the same constructors. A CLI run takes
// exactly one of those paths, so this active set never spans two runs.
const { EntryProcess, SurfaceEntryProcess, activeProcesses } = createSplitProcessScope()
/** Detached processes this round owns: PID -> its kernel starttime (if known). */
const trackedProcesses = new Map()

/**
 * One qualification checkpoint. The event NAME is always remembered (bounded to
 * a fixed length) and announced on stderr, so a default run is diagnosable
 * without `SPLIT_PROCESS_TRACE`; the fields stay out of the default output and
 * are written to the explicit trace file exactly as before. Never pass a secret.
 */
function trace(event, fields = {}) {
  diagnostics?.checkpoint(event)
  if (TRACE_PATH === undefined || TRACE_PATH === '') return
  if (traceFd === undefined) {
    mkdirSync(dirname(resolve(TRACE_PATH)), { recursive: true })
    traceFd = openSync(TRACE_PATH, 'a', 0o600)
  }
  writeFileSync(traceFd, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`)
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function failpoint(name) {
  if (FAILPOINT === name) throw new Error(`qualification failpoint: ${name}`)
}


function entryPaths(profilePackage) {
  return {
    host: join(profilePackage, 'dist', 'local-host.mjs'),
    client: join(profilePackage, 'dist', 'local-client.mjs'),
  }
}

/**
 * The official authenticated index chain: launch token -> 303 + signed cookie
 * -> 200 DSH index carrying the composed browser graph. Returns every fact so a
 * caller's predicate can assert them and a negative control can prove the same
 * predicate rejects a mutation. Shared by the PR-A static composition and the
 * PR-B runtime-toggle lanes.
 */
async function readHostWebIndex(origin, launch, label) {
  const token = new URL(launch.connectUrl).searchParams.get('token')
  const exchangeUrl = new URL('/', origin)
  exchangeUrl.searchParams.set('token', token)
  const exchange = await fetchStatus(exchangeUrl)
  const cookie = exchange.setCookie[0]?.split(';', 1)[0] ?? ''
  const index = cookie === ''
    ? { status: 0, body: '', headers: new Headers() }
    : await fetchStatus(`${origin}/`, { headers: { cookie } })
  const boot = /<script>\s*globalThis\["__DSH_BOOT__"\]\s*=\s*([\s\S]*?)<\/script>/u.exec(index.body)
  let graph
  if (boot !== null) {
    try {
      graph = JSON.parse(boot[1])
    } catch {
      graph = undefined
    }
  }
  return { label, token, cookie, exchange, index, graph, hasModuleLoader: index.body.includes('__ModuleLoader__') }
}

/** Assert the official Web index chain is a real authenticated DSH shell. */
function assertWebIndexQualified(facts, label, dshVersion) {
  assert(facts.exchange.status === 303, `${label}: the launch-token exchange must be 303, got ${facts.exchange.status}`)
  assert(/\bno-store\b/iu.test(facts.exchange.headers.get('cache-control') ?? ''), `${label}: the token exchange is not no-store`)
  assert(facts.cookie !== '', `${label}: the token exchange minted no browser cookie`)
  assert(facts.index.status === 200, `${label}: the authenticated index must be 200, got ${facts.index.status}`)
  assert(facts.hasModuleLoader, `${label}: the index carries no __ModuleLoader__ bootstrap`)
  assert(facts.graph !== undefined, `${label}: the index carries no readable __DSH_BOOT__ graph`)
  assert(facts.graph.release?.version === dshVersion,
    `${label}: the browser graph release ${JSON.stringify(facts.graph.release?.version)} != ${dshVersion}`)
  assert(Array.isArray(facts.graph.entries) && facts.graph.entries.length > 0, `${label}: the browser graph has no entries`)
  assert(Array.isArray(facts.graph.batches) && facts.graph.batches.length > 0, `${label}: the browser graph has no startup batches`)
}

/**
 * M5-W PR-D product evidence writer.
 *
 * The plan requires the qualification to retain ONE new evidence directory
 * (temp/ or a CI artifact) with the fixed layout: manifest, WC matrix, feature
 * surface matrix, per-case Browser results/screenshots, Host owner identity and
 * redacted durable events, PTY frames, the run ledger and a reproduction
 * README. This writer is the ONLY place that copies product evidence out of the
 * isolated work root; every copied string passes the credential redactor and
 * the durable events keep only the correlation fields the plan allows.
 *
 * `M5_WEB_PRODUCT_EVIDENCE` is optional: an ordinary run (and the wiring tests)
 * writes nothing. A directory that already holds files is REFUSED, so a new run
 * can never overwrite an earlier qualification.
 */
function createProductEvidence() {
  const requested = process.env.M5_WEB_PRODUCT_EVIDENCE
  const disabled = requested === undefined || requested === ''
  const state = {
    enabled: !disabled,
    dir: disabled ? undefined : resolve(requested),
    startedAt: new Date().toISOString(),
    playwright: undefined,
    chromium: undefined,
    candidate: undefined,
    candidateSha256: undefined,
    dshVersion: undefined,
    ledger: [],
    wc: {},
    features: undefined,
    ternGui: { status: 'NOT_RUN', reason: 'the real Tern GUI lane did not run in this qualification' },
  }
  if (disabled) {
    return {
      state,
      begin() {},
      setBrowserRuntime() {},
      setTernGui(value) { state.ternGui = value },
      caseStart() {},
      caseEnd() {},
      browserCase() {},
      hostIdentity() {},
      environment() {},
      fact() {},
      sessionEvents() {},
      ptyFrame() {},
      features() {},
      wc() {},
      finish() {},
    }
  }
  const dir = state.dir
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`the product evidence directory must be new/empty: ${dir}`)
  }
  for (const sub of ['matrix', 'browser', 'host', 'client', 'tern-gui']) {
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 })
    chmodSync(join(dir, sub), 0o700)
  }
  chmodSync(dir, 0o700)
  const write = (relative, value) => {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  const writeText = (relative, text) => {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, text, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  /** Only the correlation fields the plan permits; never prompt/answer text. */
  const eventLine = event => {
    const data = event.data ?? {}
    const kept = {}
    for (const key of ['id', 'callId', 'toolCallId', 'requestId', 'rpcId', 'turn', 'outcome', 'name', 'reason']) {
      if (data[key] !== undefined) kept[key] = data[key]
    }
    return JSON.stringify({
      type: event.type,
      ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
      ...(typeof event.time === 'number' ? { time: event.time } : {}),
      data: kept,
    })
  }
  const manifest = extra => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    return {
      schema: 1,
      createdAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      repositoryHead: head.status === 0 ? head.stdout.trim() : 'unknown',
      candidate: state.candidate,
      candidateSha256: state.candidateSha256,
      dshVersion: state.dshVersion,
      node: process.version,
      playwright: state.playwright ?? 'NOT_INSTALLED',
      chromium: state.chromium ?? 'NOT_STARTED',
      evidenceTier: 'REAL_PLAYWRIGHT_CHROMIUM + REAL_PTY_TUI + REAL_INSTALLED_CANDIDATE',
      osInputVerified: 'NOT_VERIFIED',
      realTernGui: state.ternGui,
      sourceMode: process.env.DSH_MODE === 'source' ? 'source' : 'npm',
      ...extra,
    }
  }
  return {
    state,
    begin(identity) {
      state.candidate = identity.candidate
      state.candidateSha256 = identity.candidateSha256
      state.dshVersion = identity.dshVersion
      write('manifest.json', manifest({ status: 'RUNNING' }))
    },
    setBrowserRuntime(runtime) {
      state.playwright = runtime.playwright
      state.chromium = runtime.chromium
    },
    setTernGui(value) {
      state.ternGui = value
    },
    caseStart(id) {
      state.ledger.push({ case: id, startedAt: new Date().toISOString(), status: 'RUNNING' })
    },
    caseEnd(id, status, fields = {}) {
      const entry = state.ledger.find(candidate => candidate.case === id && candidate.status === 'RUNNING')
      if (entry === undefined) state.ledger.push({ case: id, startedAt: new Date().toISOString(), ...fields, status })
      else Object.assign(entry, { endedAt: new Date().toISOString(), status, ...fields })
    },
    browserCase(id, coordDir, report, exit) {
      write(join('browser', id, 'browser-result.json'), report)
      for (const shot of report.screenshots ?? []) {
        const source = join(coordDir, shot)
        if (!existsSync(source)) continue
        const target = join('browser', id, shot)
        mkdirSync(dirname(join(dir, target)), { recursive: true, mode: 0o700 })
        writeFileSync(join(dir, target), readFileSync(source), { mode: 0o600 })
        chmodSync(join(dir, target), 0o600)
      }
      state.ledger.push({ case: id, startedAt: new Date().toISOString(), status: 'BROWSER_EXIT', exit })
    },
    environment(id, facts) {
      write(join('host', id, 'environment.json'), facts)
    },
    fact(id, name, value) {
      write(join('host', id, `${name}.json`), value)
    },
    hostIdentity(id, facts) {
      write(join('host', id, 'owner-identity.json'), {
        pid: facts.pid ?? facts.hostPid,
        starttime: facts.hostStarttime,
        profile: facts.profile,
        scopeId: facts.scopeId,
        instanceIdDigest: typeof facts.instanceId === 'string' ? sha16(facts.instanceId) : undefined,
        ownerEntries: facts.ownerEntries,
        webServer: facts.webServer,
      })
    },
    sessionEvents(id, events) {
      writeText(join('host', id, 'events-redacted.jsonl'), events.map(eventLine).join('\n') + (events.length > 0 ? '\n' : ''))
    },
    ptyFrame(id, frames) {
      writeText(join('client', id, 'pty-frames.txt'), frames.join('\n'))
    },
    features(matrix) {
      state.features = matrix
      write('matrix/feature-surface.json', { schema: 1, case: 'WP-10', features: matrix })
    },
    wc(matrix) {
      state.wc = matrix
      write('matrix/wc-01-12.json', { schema: 1, wc: matrix })
    },
    finish(extra = {}) {
      write('run-ledger.json', { schema: 1, startedAt: state.startedAt, endedAt: new Date().toISOString(), cases: state.ledger, ...extra })
      write('manifest.json', manifest(extra))
      writeText('README-qualification.md', [
        '# M5-W PR-D product qualification evidence',
        '',
        `- candidate: \`${String(state.candidate)}\``,
        `- candidate SHA256: \`${String(state.candidateSha256)}\``,
        `- DSH: \`${String(state.dshVersion)}\``,
        `- Playwright: \`${String(state.playwright)}\`, Chromium: \`${String(state.chromium)}\``,
        '- Browser: real Playwright Chromium (headless); TUI: real PTY; Host: the installed candidate\'s Split Host',
        '',
        '## Reproduce',
        '',
        '```sh',
        'pnpm pack:artifact',
        'SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1 SPLIT_PROCESS_REQUIRE_WEB_PRODUCT=1 \\',
        'SPLIT_PROCESS_PLAYWRIGHT_ROOT="$TOOLS" SPLIT_PROCESS_PLAYWRIGHT_BROWSERS="$TOOLS/browsers" \\',
        'M5_WEB_PRODUCT_EVIDENCE="$NEW_EVIDENCE_DIR" SPLIT_PROCESS_SMOKE_KEEP=1 \\',
        'pnpm smoke:split-process -- ./xmoon76-dsh-pi-tui-<version>.tgz',
        '```',
        '',
        '## Known qualifications not claimed here',
        '',
        `- real Tern GUI: ${state.ternGui.status} - ${state.ternGui.reason}`,
        '- OS physical input and an OS accessibility bridge: NOT_VERIFIED (control-injected input only).',
        '- Browser Cookie revocation after `/web Disable`: NOT a product contract and not tested.',
        '- Browser-only ACL/multi-user/remote network exposure: not claimed.',
        '',
      ].join('\n'))
    },
  }
}

/**
 * M5-W PR-D (t75): the PRODUCT Browser × real Split TUI qualification.
 *
 * This function is module-level and context-injected so a development run can
 * exercise ONLY the product cases against an already-installed preserved
 * profile; the shipped smoke calls it with the same context after T74.
 */
export const qualifyWebProduct = async context => {
  const { workDir, dshHome, scopeSuffix, base, entries, profilePackage, tarball, candidateSha256, targetDshVersion, env } = context
  const productRoot = join(workDir, 'pr-d-product')
  mkdirSync(productRoot, { recursive: true, mode: 0o700 })
  chmodSync(productRoot, 0o700)
  const browserRoot = join(productRoot, 'browser')
  mkdirSync(browserRoot, { recursive: true, mode: 0o700 })
  chmodSync(browserRoot, 0o700)
  const productNonce = `prd-${randomUUID().slice(0, 8)}`
  const evidence = createProductEvidence()
  evidence.begin({
    candidate: basename(tarball),
    candidateSha256,
    dshVersion: targetDshVersion,
  })
  const wc = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const code = `WC-${String(index + 1).padStart(2, '0')}`
    return [code, { status: 'NOT_RUN', reason: 'this qualification did not reach the case', evidence: [] }]
  }))
  const setWc = (code, status, reason, refs = []) => {
    wc[code] = { status, reason, evidence: refs }
    evidence.wc(wc)
  }
  evidence.wc(wc)
  const hosts = []
  const clients = []
  const peers = []
  const cleanup = async () => {
    for (const client of clients) {
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    for (const peer of peers) {
      if (peer.exited) continue
      try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    for (const host of hosts) {
      if (host.exited) continue
      try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
  }
  const playwrightRoot = process.env.SPLIT_PROCESS_PLAYWRIGHT_ROOT
  if (!REQUIRE_WEB_PRODUCT) {
    trace('t75-web-product', {
      status: 'NOT_RUN',
      reason: 'SPLIT_PROCESS_REQUIRE_WEB_PRODUCT is not set; this run does NOT exercise the product Browser qualification and does not claim it',
    })
    evidence.setTernGui({ status: 'NOT_RUN', reason: 'the product qualification was not required in this run' })
    evidence.finish({ status: 'NOT_RUN' })
    return { status: 'NOT_RUN', wc }
  }
  assert(playwrightRoot !== undefined && playwrightRoot !== '',
    'PR-D the product Browser qualification is REQUIRED (SPLIT_PROCESS_REQUIRE_WEB_PRODUCT=1) but SPLIT_PROCESS_PLAYWRIGHT_ROOT names no pinned Playwright install; an HTTP-only run must never be accepted as the product proof')
  assert(existsSync(join(playwrightRoot, 'node_modules', 'playwright', 'package.json')),
    `PR-D SPLIT_PROCESS_PLAYWRIGHT_ROOT has no pinned Playwright install: ${playwrightRoot}`)
  const browsers = process.env.SPLIT_PROCESS_PLAYWRIGHT_BROWSERS ?? join(playwrightRoot, 'browsers')
  assert(existsSync(browsers), `PR-D the Playwright browser install is missing: ${browsers}`)
  const chromiumLibs = process.env.SPLIT_PROCESS_CHROMIUM_LIBS ?? join(playwrightRoot, 'libs', 'usr', 'lib', 'x86_64-linux-gnu')
  const driverPath = join(SCRIPT_DIR, 'fixtures', 'm5-web-product-browser.mjs')
  assert(existsSync(driverPath), 'PR-D the product Browser driver is missing')
  const driverEnv = {
    ...env,
    M5_WEB_DSH_HOME: dshHome,
    M5_WEB_PLAYWRIGHT_ROOT: playwrightRoot,
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    LD_LIBRARY_PATH: `${chromiumLibs}${process.env.LD_LIBRARY_PATH === undefined ? '' : `:${process.env.LD_LIBRARY_PATH}`}`,
  }
  // The isolated-fixture facts the official Web UI needs on top of the C1
  // workload: the first-run notice acknowledgement and the Workspace
  // Controller's Documents override. Neither is a product default.
  const documentsDirectory = join(productRoot, 'documents')
  mkdirSync(documentsDirectory, { recursive: true, mode: 0o700 })
  chmodSync(documentsDirectory, 0o700)
  const c1Fixture = writeC1WorkFixture(join(dshHome, 'profiles', base.profile), productRoot)
  const productPatch = join(productRoot, 'pr-d-product.patch.yml')
  writeFileSync(productPatch, [
    readFileSync(c1Fixture.patchPath, 'utf8').trimEnd(),
    '- id: ui-settings-general',
    '  config:',
    `    welcomeNoticeVersion: '${PR_A_WELCOME_NOTICE_VERSION}'`,
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: '${documentsDirectory}'`,
    '',
  ].join('\n'), { mode: 0o600 })
  chmodSync(productPatch, 0o600)
  const timedRows = JSON.parse(readFileSync(c1Fixture.timedPatchPath, 'utf8'))
  timedRows.push(
    { id: 'ui-settings-general', config: { welcomeNoticeVersion: PR_A_WELCOME_NOTICE_VERSION } },
    { id: 'workspace-controller', config: { documentsDirectory } },
  )
  const timedProductPatch = join(productRoot, 'pr-d-product-timed.patch.yml')
  writeFileSync(timedProductPatch, `${JSON.stringify(timedRows, null, 2)}\n`, { mode: 0o600 })
  chmodSync(timedProductPatch, 0o600)

  /** The durable events of one Session (empty before its first write). */
  const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
  const requestIdOf = event => event.data?.source?.rpcId ?? event.data?.rpcId ?? event.data?.requestId ?? event.data?.id
  const userEvents = (sessionId, text) => durableOf(sessionId)
    .filter(event => event.type === 'user/message' && JSON.stringify(event).includes(text))
  /** Persist the redacted durable correlation events of one case Session. */
  const recordSession = (id, sessionId) => {
    const events = durableOf(sessionId)
    if (events.length > 0) evidence.sessionEvents(id, events)
  }
  const launchOf = ready => readJson(join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'launch.json'))
  const productWorkRoot = label => {
    const root = join(productRoot, `work-${label}`)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    return root
  }
  const startHost = async (scenario, label, extraEnv = {}, patch = productPatch) => {
    await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
    const workRoot = productWorkRoot(label)
    const host = new EntryProcess('host', entries.host, {
      ...base,
      env: {
        ...base.env,
        SPLIT_PROCESS_EXTRA_PATCH: patch,
        C1_SCENARIO: scenario,
        C1_WORK_ROOT: workRoot,
        ...extraEnv,
      },
    })
    hosts.push(host)
    const ready = await host.waitFor(record => record.m4a0 === 'ready', `${label} Host ready`, 240_000)
    evidence.hostIdentity(label, {
      ...ready.localHost,
      pid: ready.pid,
      ownerEntries: ready.ownerEntries,
      webServer: ready.webServer,
      hostStarttime: readStartIdentity(ready.pid),
    })
    return { host, ready, workRoot }
  }
  const startTui = async (label, extraEnv = {}, extraOptions = {}) => {
    const tui = new SurfaceEntryProcess(entries.client, {
      ...base,
      ...extraOptions,
      workDir,
      env: { ...base.env, ...extraEnv },
    })
    clients.push(tui)
    const ready = await tui.waitFor(record => record.m4a0 === 'ready', `${label} TUI ready`, 180_000)
    assert(ready.surfaceMounted === true && ready.transport === 'connected',
      `${label}: the real Split TUI did not mount and connect`)
    return { tui, ready }
  }
  const startPeer = async label => {
    const peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  /** The single official owner graph, asserted on every Product Host edge. */
  const assertSingleHostOwners = (ready, label) => {
    for (const owner of ['connection', 'apiRemotes', 'typertGateway', 'workspaceRegistry', 'workspaceController',
      'sessionController', 'fileUpload', 'settingsController', 'jobController', 'piTuiHostRuntime']) {
      assert(ready.ownerEntries?.[owner]?.length === 1,
        `${label}: the ${owner} owner count is ${JSON.stringify(ready.ownerEntries?.[owner])}, expected exactly one`)
    }
    assert(ready.webServer?.host === '127.0.0.1' && typeof ready.webServer?.port === 'number' && ready.webServer.port > 0,
      `${label}: the ONE loopback listener is not a bound 127.0.0.1 port`)
    assert(ready.services?.piTuiWebAccess === true, `${label}: the private Web access service is missing`)
  }
  /** Move the `/web` menu highlight until the requested action is selected. */
  const selectWebRow = async (tui, description, label) => {
    for (let step = 0; step < 10; step += 1) {
      if ((await tui.viewport()).join('\n').includes(description)) {
        tui.send('\r')
        return
      }
      tui.send('\u001b[B')
      await sleep(120)
    }
    throw new SplitSmokeAssertionError(`${label}: the /web menu never selected "${description}"`)
  }
  const enableWeb = async (tui, label, options = {}) => {
    tui.send('/web\r')
    await tui.waitForScreen('Status:', `${label} /web menu`, 120_000)
    const menu = (await tui.viewport()).join('\n')
    const initial = menu.includes('Status: enabled') ? 'enabled'
      : menu.includes('Status: disabled') ? 'disabled' : 'unknown'
    assert(initial !== 'unknown', `${label}: the /web menu painted no known Web status`)
    if (options.requireDisabled === true) {
      assert(initial === 'disabled', `${label}: the initial Web state was ${initial}, expected disabled`)
    }
    if (initial === 'enabled') {
      tui.send('\u001b')
      await tui.waitForScreenGone('Status:', `${label} menu closed`, 30_000)
      return initial
    }
    await selectWebRow(tui, 'Start serving the official Web frontend', `${label} Enable Web`)
    await tui.waitForScreen('Status: enabled', `${label} enabled projection`, 180_000)
    tui.send('\u001b')
    await tui.waitForScreenGone('Status: enabled', `${label} menu closed`, 30_000)
    return initial
  }
  const disableWeb = async (tui, label) => {
    tui.send('/web\r')
    await tui.waitForScreen('Status: enabled', `${label} /web enabled menu`, 120_000)
    await selectWebRow(tui, 'Stop serving the official Web frontend', `${label} Disable Web`)
    await tui.waitForScreen('Status: disabled', `${label} disabled projection`, 180_000)
    tui.send('\u001b')
    await tui.waitForScreenGone('Status: disabled', `${label} menu closed`, 30_000)
  }
  const tuiNewSession = async (tui, label) => {
    const boundary = tui.records.length
    const before = lastSurfaceStatus(tui)?.openSessionId
    tui.send('/new\r')
    const opened = await tui.waitFor(record => tui.records.indexOf(record) >= boundary
      && record.m4b2s === 'surface-status'
      && record.sessionOpen === true
      && typeof record.openSessionId === 'string'
      && record.openSessionId !== ''
      && record.openSessionId !== before
      && record.transport === 'connected', `${label} /new`, 120_000)
    return opened.openSessionId
  }
  const tuiResume = async (tui, sessionId, label) => {
    const boundary = tui.records.length
    tui.send(`/resume ${sessionId}\r`)
    const opened = await tui.waitFor(record => tui.records.indexOf(record) >= boundary
      && record.m4b2s === 'surface-status'
      && record.sessionOpen === true
      && record.openSessionId === sessionId
      && record.transport === 'connected', `${label} /resume`, 120_000)
    return opened
  }
  /** One real TUI prompt with its durable user/message and turn/end. */
  const tuiTurn = async (tui, sessionId, text, label) => {
    const boundary = durableOf(sessionId).length
    const committed = () => durableOf(sessionId).slice(boundary)
      .some(event => event.type === 'user/message' && JSON.stringify(event).includes(text))
    tui.send(`${text}\r`)
    await tui.waitForScreen(text, `${label} prompt painted`, 120_000)
    // A `/web` overlay close or a just-mounted `/new` session can swallow
    // the FIRST Enter while the draft is already painted. This is a real
    // UI race; the prompt is only submitted again after the Host's durable
    // log PROVES the first submit did not commit and the text is still the
    // live composer draft. It is never a replay of an accepted write.
    for (let attempt = 0; attempt < 2 && !committed(); attempt += 1) {
      // One full settle second: a submit that really reached the Host has
      // cleared the composer and/or become durable long before this. Only
      // a draft that is demonstrably still live is submitted again.
      await sleep(1_000)
      if (committed()) break
      const composer = await tui.composerText()
      if (composer === undefined || !composer.includes(text)) break
      tui.send('\r')
    }
    await waitForHostSessionEventAfter(dshHome, sessionId, boundary,
      event => event.type === 'user/message' && JSON.stringify(event).includes(text), `${label} user/message`, 180_000)
    await waitForHostSessionEventAfter(dshHome, sessionId, boundary,
      event => event.type === 'turn/end', `${label} turn/end`, 180_000)
    return boundary
  }
  /**
   * Submit a trigger prompt whose completion is a Host/Fixture fact rather
   * than a Session turn/end (Question/Approval/held Turn). The same
   * swallow-the-first-Enter race is handled with the SAME rule: re-Enter
   * only after the draft is still live and the authoritative fact is absent.
   */
  const tuiSubmitUntil = async (tui, text, label, committed) => {
    tui.send(`${text}\r`)
    await tui.waitForScreen(text, `${label} painted`, 120_000)
    for (let attempt = 0; attempt < 2 && !(await committed()); attempt += 1) {
      await sleep(1_000)
      if (await committed()) break
      const composer = await tui.composerText()
      if (composer === undefined || !composer.includes(text)) break
      tui.send('\r')
    }
  }
  /** One correlated `qualification-web-access` round trip. */
  const webAccess = async (peer, label, value) => {
    const requestId = `prd-${++statusSequence}`
    peer.send({
      op: 'qualification-web-access',
      requestId,
      ...(value === undefined ? {} : { webAccessEnabled: value }),
    })
    return peer.waitFor(entry => entry.op === 'web-access' && entry.requestId === requestId,
      `${label} web-access`, 300_000)
  }
  const webPreference = async (peer, label, value) => {
    const requestId = `prd-pref-${++statusSequence}`
    peer.send({
      op: 'qualification-web-autostart',
      requestId,
      ...(value === undefined ? {} : { webAutoStart: value }),
    })
    return peer.waitFor(entry => entry.op === 'web-autostart' && entry.requestId === requestId,
      `${label} web-autostart`, 120_000)
  }
  const assertToggle = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private Web access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
    assert(record.status?.state === expected,
      `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
  }
  const webFullyOff = ready => {
    const live = PR_A_WEB_ROWS
      .map(row => [row.id, (ready.entries ?? []).find(entry => entry.id === row.id)?.state])
      .filter(([, state]) => state !== 'absent' && state !== 'state-4')
    assert(live.length === 0, `the Web rows are not plainly off: ${live.map(([id, state]) => `${id}:${state ?? 'missing'}`).join(',')}`)
  }
  const webFullyOn = ready => {
    const notActive = PR_A_WEB_ROWS
      .map(row => [row.id, (ready.entries ?? []).find(entry => entry.id === row.id)?.state])
      .filter(([id, state]) => id !== 'ui-deliverables' && state !== 'active')
    assert(notActive.length === 0, `the Web rows are not active: ${notActive.map(([id, state]) => `${id}:${state ?? 'missing'}`).join(',')}`)
  }
  let browserRun = 0
  const browserCase = async (caseId, config, body) => {
    const coord = join(browserRoot, `${caseId}-${String(++browserRun)}`)
    mkdirSync(coord, { recursive: true, mode: 0o700 })
    chmodSync(coord, 0o700)
    writeFileSync(join(coord, 'case.json'), `${JSON.stringify({ caseId, nonce: productNonce, ...config }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(join(coord, 'case.json'), 0o600)
    const child = spawn(process.execPath, [driverPath, coord, caseId, productNonce], {
      cwd: workDir,
      env: driverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { out = `${out}${chunk}`.slice(-16_384) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { err = `${err}${chunk}`.slice(-16_384) })
    const exit = new Promise(resolveExit => child.on('close', (code, signal) => resolveExit({ code, signal })))
    const handle = {
      coord,
      signal: name => {
        writeFileSync(join(coord, `signal-${name}`), `${Date.now()}\n`, { mode: 0o600 })
      },
      waitFact: async (name, label, timeoutMs = 240_000) => {
        const factPath = join(coord, `browser-${name}.json`)
        try {
          await whileBrowserDriverRuns(
            exit,
            signal => waitForCondition(() => existsSync(factPath), label, timeoutMs, signal),
            `PR-D ${caseId}`,
            label,
          )
        } catch (error) {
          // A driver may write its final fact and exit in the same tick;
          // the exit race must not discard a fact that ALREADY exists.
          if (!existsSync(factPath)) throw error
        }
        return readJson(factPath)
      },
      readFact: name => readJson(join(coord, `browser-${name}.json`)),
      writeCommand: command => {
        appendFileSync(join(coord, 'commands.jsonl'), `${JSON.stringify(command)}\n`, { mode: 0o600 })
      },
      waitStep: async (seq, label, timeoutMs = 240_000) => {
        const stepPath = join(coord, `browser-step-${seq}.json`)
        try {
          await whileBrowserDriverRuns(
            exit,
            signal => waitForCondition(() => existsSync(stepPath), label, timeoutMs, signal),
            `PR-D ${caseId}`,
            label,
          )
        } catch (error) {
          if (!existsSync(stepPath)) throw error
        }
        return readJson(stepPath)
      },
      readStep: seq => readJson(join(coord, `browser-step-${seq}.json`)),
    }
    evidence.caseStart(caseId)
    let passed = false
    try {
      await body(handle)
      const finished = await browserDriverExitBounded(exit, 300_000, `PR_D_BROWSER_EXIT_TIMEOUT(${caseId})`)
      const report = readJson(join(coord, 'browser-result.json'))
      assert(finished.code === 0,
        `PR-D ${caseId}: the product Browser driver failed (exit ${JSON.stringify(finished.code)}/${String(finished.signal)}): ${redactWebQualificationText(report.error ?? 'driver-failure')}`)
      assert(report.ok === true && report.caseId === caseId && report.nonce === productNonce,
        `PR-D ${caseId}: the product Browser result is not a completed PASS (${String(report.error ?? 'no error')})`)
      // RFL-001: the Driver's observed ids are the start; the AUTHORITATIVE
      // correlations are the durable Host ids of this case's Session. Enrich
      // the retained result BEFORE it leaves the run, so the evidence copy is
      // not a Browser-only claim.
      const sessionForCorrelation = typeof config.sessionId === 'string' && config.sessionId !== ''
        ? config.sessionId
        : report.sessionId
      if (typeof sessionForCorrelation === 'string' && sessionForCorrelation !== '') {
        const durableIds = durableOf(sessionForCorrelation).flatMap(event => [
          event.data?.source?.rpcId,
          event.data?.rpcId,
          event.data?.requestId,
          event.data?.callId,
          event.data?.id,
        ]).filter(value => typeof value === 'string' && value !== '')
        report.requestIds = [...new Set([...(Array.isArray(report.requestIds) ? report.requestIds : []), ...durableIds])]
      }
      writeFileSync(join(coord, 'browser-result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      const reportText = JSON.stringify(report)
      assert(!/[?&]token=/u.test(reportText) && !/127\.0\.0\.1:\d+/u.test(reportText) && !/(?:Cookie|Authorization)\s*:/iu.test(reportText),
        `PR-D ${caseId}: the product Browser result leaked an authenticated-link secret`)
      assert(typeof report.sessionId === 'string' && report.sessionId !== '',
        `PR-D ${caseId}: the product Browser case has no Host Session identity`)
      assert(Array.isArray(report.steps) && report.steps.length > 0,
        `PR-D ${caseId}: the product Browser case recorded no real step`)
      assert(report.steps.every(entry => entry.passed === true),
        `PR-D ${caseId}: a product Browser step did not pass`)
      assert(Array.isArray(report.requestIds) && report.requestIds.length > 0,
        `PR-D ${caseId}: the product Browser case carries no Host request/rpc correlation`)
      evidence.browserCase(caseId, coord, report, finished)
      evidence.setBrowserRuntime({
        playwright: report.runtimeVersion?.playwright,
        chromium: report.runtimeVersion?.chromium,
      })
      evidence.caseEnd(caseId, 'PASS')
      passed = true
      return report
    } catch (error) {
      // A failed case still retains its driver result/screenshots: the plan
      // forbids discarding the evidence of the failure that is being fixed.
      try {
        const failedReport = join(coord, 'browser-result.json')
        if (existsSync(failedReport)) evidence.browserCase(caseId, coord, readJson(failedReport), { code: 'FAILED' })
      } catch { /* the evidence copy must not hide the real failure */ }
      evidence.caseEnd(caseId, 'FAILED')
      if (err.trim() !== '' || out.trim() !== '') {
        process.stderr.write(`PR_D_BROWSER_DIAGNOSTIC(${caseId}): ${redactWebQualificationText(`${err} ${out}`).trim().split('\n').slice(-3).map(line => line.slice(0, 300)).join(' | ')}\n`)
      }
      throw error
    } finally {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
      if (!passed) await browserDriverExitBounded(exit, 15_000, `PR_D_BROWSER_CLEANUP(${caseId})`)
    }
  }
  const ptyFrames = async (id, tui) => {
    const frames = (await tui.viewport()).map(line => line.trimEnd())
    evidence.ptyFrame(id, [`# ${id}`, ...frames])
  }

  try {
    // T74 ends with the profile-owned Auto-start preference ON (its last
    // scene proves the next cold boot auto-starts). WP-01 requires a fresh
    // default-OFF profile, so reset the preference through the OFFICIAL
    // settings wire on its own short-lived Host BEFORE the product Host
    // boots. The reset Host may itself auto-start Web; that is irrelevant.
    const fastBarrier = join(productRoot, 'long-turn.fast')
    writeFileSync(fastBarrier, 'release\n', { mode: 0o600 })
    {
      const resetHost = await startHost('long-turn', 'pref-reset', { C1_HOLD_LONG_TURN: fastBarrier })
      const resetPeer = await startPeer('PR-D preference reset')
      const reset = await webPreference(resetPeer, 'PR-D preference reset', false)
      assert(reset.ok === true && reset.readBack === true,
        `PR-D could not reset the profile Auto-start preference to Off: ${JSON.stringify(reset)}`)
      await resetPeer.shutdown()
      const resetIndex = peers.indexOf(resetPeer)
      if (resetIndex >= 0) peers.splice(resetIndex, 1)
      const resetStop = await resetHost.host.shutdown()
      assert(resetStop.code === 0, 'PR-D the preference-reset Host did not stop normally')
    }

    // ── Group A: WP-01/02/06/08/09/10 on ONE fast-answer Host ───────────
    const groupA = await startHost('long-turn', 'wp01-group', { C1_HOLD_LONG_TURN: fastBarrier })
    assertSingleHostOwners(groupA.ready, 'WP-01 Host')
    const groupAIdentity = groupA.ready.localHost
    const { tui: tuiA } = await startTui('wp01-group')
    let groupTui = tuiA
    await enableWeb(groupTui, 'WP-01', { requireDisabled: true })
    const groupAEnabled = await hostStatus(groupA.host)
    assertSingleHostOwners(groupAEnabled, 'WP-01 enabled Host')
    webFullyOn(groupAEnabled)
    assertIdentityFields(groupAEnabled.localHost, groupAIdentity, 'WP-01 enable kept the Host identity')
    const groupALaunch = launchOf(groupA.ready)
    const groupAIndex = await readHostWebIndex(groupA.ready.localHost.origin, groupALaunch, 'WP-01')
    assertWebIndexQualified(groupAIndex, 'WP-01', targetDshVersion)

    // WP-01: token -> Cookie -> index -> shell -> one real Session action.
    const wp01 = await browserCase('wp01-login', {
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      const browserSession = await handle.waitFact('session', 'WP-01 Browser Session creation', 240_000)
      // The Browser Session lives on the SAME Host the real TUI is connected
      // to; the TUI currently sits on the sessionless welcome seat, where a
      // direct `/resume` is not the product path under test (WP-02B proves
      // the picker/resume flow once the TUI owns a Session). Here the shared
      // authority is the Host identity and the durable Browser Turn.
      assertClientHostFacts(lastSurfaceStatus(groupTui)?.host, groupA.ready.localHost, 'WP-01 TUI vs Browser Host')
      const boundary = durableOf(browserSession.sessionId).length
      await waitForHostSessionEventAfter(dshHome, browserSession.sessionId, boundary,
        event => event.type === 'user/message' && JSON.stringify(event).includes(`wp01-${productNonce}`),
        'WP-01 Browser prompt committed', 180_000)
      await waitForHostSessionEventAfter(dshHome, browserSession.sessionId, boundary,
        event => event.type === 'turn/end', 'WP-01 Browser turn settled', 180_000)
      await handle.signal('runner-go')
    })
    const wp01Session = wp01.sessionId
    assert(userEvents(wp01Session, `wp01-${productNonce}`).length === 1,
      'WP-01 the Browser prompt was not committed to the Host exactly once')
    assert(wp01.indexStatus === 200, `WP-01 the Browser index was HTTP ${String(wp01.indexStatus)}`)
    const wp01Negatives = wp01.negatives ?? {}
    assert(wp01Negatives.index !== 200,
      `WP-01 the unauthenticated index was accepted (HTTP ${String(wp01Negatives.index)})`)
    assert(wp01Negatives.api === 401,
      `WP-01 the unauthenticated /api was not 401 (HTTP ${String(wp01Negatives.api)})`)
    // The unauth wrong-host/origin statuses are recorded but do NOT prove the
    // source policy; the authenticated ones below do.
    assert(wp01Negatives.wrongHost !== 200,
      `WP-01 an unauthenticated wrong Host header was accepted (HTTP ${String(wp01Negatives.wrongHost)})`)
    assert(wp01Negatives.wrongOrigin !== 200,
      `WP-01 an unauthenticated wrong Origin was accepted (HTTP ${String(wp01Negatives.wrongOrigin)})`)
    assert(wp01Negatives.wrongHostAuthenticated === 401,
      `WP-01 an AUTHENTICATED wrong Host was not 401 (HTTP ${String(wp01Negatives.wrongHostAuthenticated)})`)
    assert(wp01Negatives.wrongOriginAuthenticated === 403,
      `WP-01 an AUTHENTICATED wrong Origin was not 403 (HTTP ${String(wp01Negatives.wrongOriginAuthenticated)})`)
    // `/plugins/events` may be an official public graph stream; the plan does
    // not require every non-index resource to be 401. Record it, never use it
    // as an authentication negative.
    trace('t75-web-product-wp01-negatives', wp01Negatives)
    assert((wp01.network?.statuses ?? []).some(entry => entry.path === '/plugins/events' && entry.status === 200),
      'WP-01 the Browser never loaded the official plugin event stream')
    assert((wp01.network?.failedPaths ?? []).every(path => !/\/plugins\/.*\.js|\/api\/.* -> 5\d\d/iu.test(path)),
      `WP-01 the Browser failed a required Web resource: ${JSON.stringify(wp01.network?.failedPaths)}`)
    assertIdentityFields((await hostStatus(groupA.host)).localHost, groupAIdentity, 'WP-01 Host identity kept after the Browser Session')
    await ptyFrames('wp01', groupTui)
    setWc('WC-01', 'PASS', 'one Host owner graph; Browser and TUI share it', ['WP-01'])
    setWc('WC-02', 'PASS', 'real Browser token->Cookie->index, live plugin stream and dynamic resources', ['WP-01'])
    setWc('WC-11', 'PASS', 'the Browser loaded the installed candidate Web resources; the candidate digest is re-proved at the end', ['WP-01'])

    // WP-02A: TUI creates a Session; the Browser finds and opens it.
    const sessionA = await tuiNewSession(groupTui, 'WP-02A')
    const markerA = `T-${productNonce}-a`
    await tuiTurn(groupTui, sessionA, markerA, 'WP-02A')
    await browserCase('wp02a-open-existing', {
      sessionId: sessionA,
      marker: markerA,
      expectedAnswer: 'long-turn answer',
    }, async () => {})
    const sessionAHeader = await waitForHostSessionHeader(dshHome, sessionA, 'WP-02A Session header')
    assert(typeof sessionAHeader.cwd === 'string' && sessionAHeader.cwd !== '', 'WP-02A no durable Host workspace header')
    assert(userEvents(sessionA, markerA).length === 1, 'WP-02A the TUI marker was not committed once')
    recordSession('wp02a-open-existing', sessionA)
    await ptyFrames('wp02a-open-existing', groupTui)
    setWc('WC-03', 'PASS', 'TUI created a Session; the Browser opened the same Session through the official sidebar', ['WP-02A'])

    // WP-02B: the Browser creates a Session; the TUI resumes it.
    const markerB = `B-${productNonce}-b`
    let sessionB
    await browserCase('wp02b-browser-session', { marker: markerB }, async handle => {
      const browserSession = await handle.waitFact('session', 'WP-02B Browser Session creation', 240_000)
      sessionB = browserSession.sessionId
      await tuiResume(groupTui, sessionB, 'WP-02B')
      await groupTui.waitForScreen(markerB, 'WP-02B TUI paints the Browser prompt', 180_000)
      await groupTui.waitForScreen('long-turn answer', 'WP-02B TUI paints the Browser answer', 180_000)
      await handle.signal('runner-go')
    })
    assert(typeof sessionB === 'string' && sessionB !== '', 'WP-02B the Browser created no Host Session')
    assert(userEvents(sessionB, markerB).length === 1, 'WP-02B the Browser prompt was not committed once')
    await waitForHostSessionHeader(dshHome, sessionB, 'WP-02B Session header')
    recordSession('wp02b-browser-session', sessionB)
    await ptyFrames('wp02b-browser-session', groupTui)

    // WP-02C: both Clients write the SAME Session with different markers.
    const markerB2 = `B-${productNonce}-c`
    const markerT2 = `T-${productNonce}-c`
    await browserCase('wp02c-dual-prompts', {
      sessionId: sessionB,
      marker: markerB2,
      tuiMarker: markerT2,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('turn-done', 'WP-02C Browser turn', 240_000)
      await tuiTurn(groupTui, sessionB, markerT2, 'WP-02C')
      const after = durableOf(sessionB)
      const browserRequest = userEvents(sessionB, markerB2).map(requestIdOf).filter(id => typeof id === 'string')
      const tuiRequest = userEvents(sessionB, markerT2).map(requestIdOf).filter(id => typeof id === 'string')
      assert(browserRequest.length === 1 && tuiRequest.length === 1 && browserRequest[0] !== tuiRequest[0],
        'WP-02C the two Clients did not produce two distinct Host request identities')
      assert(after.filter(event => event.type === 'turn/end').length >= 2,
        'WP-02C the same Session did not settle two Turns')
      await handle.signal('tui-done')
    })
    recordSession('wp02c-dual-prompts', sessionB)
    await ptyFrames('wp02c-dual-prompts', groupTui)
    setWc('WC-04', 'PASS', 'two distinct request identities, two user/message writes and two turn ends on ONE Session', ['WP-02C'])

    // WP-02D: the SAME text from both Clients stays two independent Turns.
    const sameText = `S-${productNonce}-same`
    await browserCase('wp02d-same-text', {
      sessionId: sessionB,
      marker: sameText,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('turn-done', 'WP-02D Browser same-text turn', 240_000)
      // The two prompts have the SAME text: before the TUI writes its own,
      // prove the Browser's occurrence and turn are already durable. The TUI
      // boundary then cannot be satisfied by the Browser's late flush, which
      // would otherwise hide a swallowed TUI Enter.
      await waitForHostSessionEvent(dshHome, sessionB,
        event => event.type === 'user/message' && JSON.stringify(event).includes(sameText),
        'WP-02D Browser user/message durable', 120_000)
      await waitForHostSessionEvent(dshHome, sessionB,
        event => event.type === 'turn/end', 'WP-02D Browser turn/end durable', 120_000)
      await tuiTurn(groupTui, sessionB, sameText, 'WP-02D')
      const occurrences = userEvents(sessionB, sameText)
      assert(occurrences.length === 2, `WP-02D the Host committed ${String(occurrences.length)} same-text user messages, expected 2`)
      const ids = occurrences.map(requestIdOf)
      assert(ids.every(id => typeof id === 'string') && ids[0] !== ids[1],
        'WP-02D the same text was deduplicated into one Host request identity')
      await handle.signal('tui-done')
    })
    recordSession('wp02d-same-text', sessionB)
    setWc('WC-04', 'PASS', 'two distinct request identities; the same text from both Clients stays two Turns', ['WP-02C', 'WP-02D'])

    // WP-02E: independent Browser/TUI current Session references.
    const markerA2 = `T-${productNonce}-e`
    await browserCase('wp02e-independent-view', {
      sessionA,
      sessionB,
      markerA: markerA,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('on-b', 'WP-02E Browser on Session B', 240_000)
      await handle.signal('nav-to-a')
      await handle.waitFact('on-a', 'WP-02E Browser on Session A', 240_000)
      // The TUI keeps writing B while the Browser is on A.
      await tuiTurn(groupTui, sessionB, markerA2, 'WP-02E B turn')
      await tuiResume(groupTui, sessionA, 'WP-02E')
      await groupTui.waitForScreen(markerA, 'WP-02E TUI on Session A history', 180_000)
      await handle.signal('runner-done')
    })
    const tuiOnA = lastSurfaceStatus(groupTui)
    assert(tuiOnA?.openSessionId === sessionA && tuiOnA.transport === 'connected',
      'WP-02E the TUI did not keep its own Session A reference')
    assert(userEvents(sessionB, markerA2).length === 1,
      'WP-02E the TUI Turn in B was not committed while the Browser was on A')
    recordSession('wp02e-independent-view-a', sessionA)
    recordSession('wp02e-independent-view-b', sessionB)
    setWc('WC-05', 'PASS', 'Browser and TUI keep independent current Sessions; a Turn in B lands while the Browser shows A', ['WP-02E'])

    // WP-06: TUI /reload-client, normal exit and SIGKILL while the Browser
    // keeps advancing the SAME Session.
    const sessionLife = await tuiNewSession(groupTui, 'WP-06')
    const lifeSeed = `L-${productNonce}-seed`
    await tuiTurn(groupTui, sessionLife, lifeSeed, 'WP-06 seed')
    const lifeBrowser = await browserCase('wp06-tui-lifecycle', { sessionId: sessionLife }, async handle => {
      await handle.waitFact('ready', 'WP-06 Browser ready', 240_000)
      const commands = [
        { kind: 'prompt', prompt: `L-${productNonce}-after-reload`, marker: `L-${productNonce}-after-reload` },
        { kind: 'prompt', prompt: `L-${productNonce}-tui-exited`, marker: `L-${productNonce}-tui-exited` },
        { kind: 'prompt', prompt: `L-${productNonce}-new-tui`, marker: `L-${productNonce}-new-tui` },
        { kind: 'prompt', prompt: `L-${productNonce}-after-sigkill`, marker: `L-${productNonce}-after-sigkill` },
        { kind: 'finish' },
      ]
      // 1. A REAL /reload-client command; the Host PID must not move and the
      //    reexecuted Client must restore Session S. The manual command
      //    truthfully refuses `already-current` when the profile install IS
      //    the running build, so the installed Client payload is given the
      //    T17 harmless-comment drift first and restored byte-for-byte after
      //    the replacement is live. This is a REAL profile reexec, not a
      //    SIGUSR2 qualification shortcut.
      const installedClientChunk = chunk(profilePackage, 'client-bootstrap-')
      const installedClientBytes = readFileSync(installedClientChunk)
      let reloadAccepted = false
      try {
        appendFileSync(installedClientChunk, '\n// PR-D /reload-client build drift: protocol unchanged\n')
        const driftBuildId = productionBuildId(profilePackage, groupAIdentity.dshVersion)
        assert(driftBuildId !== groupAIdentity.buildId,
          'WP-06 the harmless installed-payload drift did not change the Client build fingerprint')
        const reloadBoundary = groupTui.records.length
        const oldClientPid = groupTui.records.filter(record => record.m4a0 === 'ready').at(-1)?.pid
        groupTui.send('/reload-client\r')
        const reloaded = await groupTui.waitFor(record => groupTui.records.indexOf(record) >= reloadBoundary
          && record.m4a0 === 'ready' && record.pid !== oldClientPid, 'WP-06 Client reexec', 180_000)
        assert(Number.isInteger(reloaded.pid) && reloaded.pid !== oldClientPid,
          'WP-06 /reload-client did not replace the Client business PID')
        await waitForSurfaceStatus(groupTui, record => record.sessionOpen === true
          && record.openSessionId === sessionLife && record.transport === 'connected', 'WP-06 reloaded Client resumed its Session', 120_000)
        reloadAccepted = true
      } finally {
        writeFileSync(installedClientChunk, installedClientBytes)
        assert(readFileSync(installedClientChunk).equals(installedClientBytes),
          'WP-06 the installed Client payload was not restored byte for byte')
      }
      assert(reloadAccepted, 'WP-06 the real /reload-client gesture was not accepted')
      const reloadTurn = durableOf(sessionLife).length
      handle.writeCommand({ seq: 1, ...commands[0] })
      await handle.waitStep(1, 'WP-06 Browser after /reload-client')
      await waitForHostSessionEventAfter(dshHome, sessionLife, reloadTurn,
        event => event.type === 'turn/end', 'WP-06 turn after reload', 180_000)
      assert(alive(groupA.ready.pid), 'WP-06 the /reload-client stopped the Host')
      assertIdentityFields((await hostStatus(groupA.host)).localHost, groupAIdentity, 'WP-06 Host identity after /reload-client')
      // 2. Normal TUI exit; the Browser still writes the SAME Session.
      groupTui.send('/exit\r')
      assert((await groupTui.waitForExit(60_000)).code === 0, 'WP-06 the TUI did not exit normally')
      await groupTui.dispose()
      handle.writeCommand({ seq: 2, ...commands[1] })
      await handle.waitStep(2, 'WP-06 Browser after the TUI exit')
      assert(alive(groupA.ready.pid), 'WP-06 the TUI exit stopped the Host')
      // 3. A NEW TUI attaches, then a SIGKILL of its business PID.
      const { tui: tuiB } = await startTui('WP-06 new TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionLife })
      await tuiB.waitForScreen(lifeSeed, 'WP-06 new TUI reads the durable history', 180_000)
      handle.writeCommand({ seq: 3, ...commands[2] })
      await handle.waitStep(3, 'WP-06 Browser while the new TUI is alive')
      const tuiBPid = tuiB.records.find(record => record.m4a0 === 'ready')?.pid
      assert(Number.isInteger(tuiBPid) && alive(tuiBPid), 'WP-06 the new TUI published no business PID')
      tuiB.signalBusiness('SIGKILL')
      await waitGone(tuiBPid, 15_000)
      await tuiB.dispose()
      handle.writeCommand({ seq: 4, ...commands[3] })
      await handle.waitStep(4, 'WP-06 Browser after the TUI SIGKILL')
      assert(alive(groupA.ready.pid), 'WP-06 the TUI SIGKILL stopped the Host')
      // 4. A fresh TUI reads the whole segment and keeps its own generation.
      const { tui: tuiC } = await startTui('WP-06 fresh TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionLife })
      for (const marker of [lifeSeed, `L-${productNonce}-after-reload`, `L-${productNonce}-tui-exited`,
        `L-${productNonce}-new-tui`, `L-${productNonce}-after-sigkill`]) {
        await tuiC.waitForScreen(marker, `WP-06 fresh TUI reads ${marker}`, 180_000)
      }
      const generation = lastSurfaceStatus(tuiC)?.generationId
      assert(typeof generation === 'number', 'WP-06 the fresh TUI published no transport generation')
      handle.writeCommand({ seq: 5, ...commands[4] })
      await handle.waitStep(5, 'WP-06 Browser finish')
      groupTui = tuiC
    })
    assert(userEvents(sessionLife, `L-${productNonce}-after-sigkill`).length === 1,
      'WP-06 the Browser Turn after the TUI SIGKILL was not committed once')
    recordSession('wp06-tui-lifecycle', sessionLife)
    await ptyFrames('wp06-tui-lifecycle', groupTui)
    setWc('WC-08', 'PASS', 'real /reload-client, normal TUI exit and TUI SIGKILL left the Host and the Browser-written Session advancing', ['WP-06'])

    // WP-08: `/web` runtime toggle and a settings recomposition with a live
    // Browser and a live TUI.
    const sessionToggle = await tuiNewSession(groupTui, 'WP-08')
    await tuiTurn(groupTui, sessionToggle, `W-${productNonce}-seed`, 'WP-08 seed')
    const togglePeer = await startPeer('WP-08')
    assertToggle(await webAccess(togglePeer, 'WP-08 initial', undefined), 'enabled', 'WP-08 initial')
    const toggleIdentity = (await hostStatus(groupA.host)).localHost
    await browserCase('wp08-web-toggle', { sessionId: sessionToggle }, async handle => {
      await handle.waitFact('ready', 'WP-08 Browser ready', 240_000)
      handle.writeCommand({ seq: 1, kind: 'prompt', prompt: `W-${productNonce}-before-off`, marker: `W-${productNonce}-before-off` })
      await handle.waitStep(1, 'WP-08 Browser before the disable')
      await disableWeb(groupTui, 'WP-08')
      const off = await hostStatus(groupA.host)
      webFullyOff(off)
      assertIdentityFields(off.localHost, toggleIdentity, 'WP-08 disable kept the Host identity')
      const root = await fetchStatus(`${groupA.ready.localHost.origin}/`)
      assert(root.status === 404, `WP-08 the disabled Host still serves the Web root (HTTP ${root.status})`)
      // The TUI keeps working on the SAME Host while Web is off.
      await tuiTurn(groupTui, sessionToggle, `W-${productNonce}-tui-while-off`, 'WP-08 TUI while off')
      // The old page is deliberately NOT guaranteed to stay usable: the
      // product contract stops serving the page and unloads the 59 rows;
      // the re-enable is proved by a NEW authenticated page below.
      await enableWeb(groupTui, 'WP-08 re-enable')
      assertToggle(await webAccess(togglePeer, 'WP-08 after re-enable', undefined), 'enabled', 'WP-08 after re-enable')
      handle.writeCommand({ seq: 3, kind: 'reconnect', sessionId: sessionToggle })
      await handle.waitStep(3, 'WP-08 Browser reconnected')
      handle.writeCommand({ seq: 4, kind: 'prompt', prompt: `W-${productNonce}-after-on`, marker: `W-${productNonce}-after-on` })
      await handle.waitStep(4, 'WP-08 Browser after the re-enable')
      // A settings recomposition may briefly unload the Web rows; the
      // FINAL state must still be enabled and the Host PID unchanged.
      const saved = await webPreference(togglePeer, 'WP-08 recompose save', false)
      assert(saved.ok === true && saved.readBack === true, 'WP-08 the settings write did not read back')
      const finalDeadline = Date.now() + 90_000
      let finalState = 'unknown'
      while (Date.now() < finalDeadline) {
        const record = await webAccess(togglePeer, 'WP-08 final state', undefined)
        finalState = record.status?.state
        if (finalState === 'enabled') break
        await sleep(250)
      }
      assert(finalState === 'enabled', `WP-08 the final Web state after recomposition was ${finalState}`)
      assertIdentityFields((await hostStatus(groupA.host)).localHost, toggleIdentity, 'WP-08 recomposition kept the Host identity')
      handle.writeCommand({ seq: 5, kind: 'reconnect', sessionId: sessionToggle })
      await handle.waitStep(5, 'WP-08 Browser reconnected after the recomposition')
      handle.writeCommand({ seq: 6, kind: 'prompt', prompt: `W-${productNonce}-after-recompose`, marker: `W-${productNonce}-after-recompose` })
      await handle.waitStep(6, 'WP-08 Browser after the recomposition')
      handle.writeCommand({ seq: 7, kind: 'finish' })
      await handle.waitStep(7, 'WP-08 Browser finish')
    })
    for (const marker of [`W-${productNonce}-before-off`, `W-${productNonce}-tui-while-off`,
      `W-${productNonce}-after-on`, `W-${productNonce}-after-recompose`]) {
      assert(userEvents(sessionToggle, marker).length === 1, `WP-08 the Host committed "${marker}" once`)
    }
    recordSession('wp08-web-toggle', sessionToggle)
    await ptyFrames('wp08-web-toggle', groupTui)
    setWc('WC-09', 'PASS', 'the real TUI `/web Disable` unloaded the 59 rows and stopped serving while the Host/TUI kept working; Enable and a settings recomposition restored the final enabled state', ['WP-08'])
    assert(await togglePeer.shutdown() !== undefined, 'WP-08 the qualification Peer did not stop')
    const peerIndex = peers.indexOf(togglePeer)
    if (peerIndex >= 0) peers.splice(peerIndex, 1)

    // WP-09: Browser-local upload, TUI Client-local intake/export and the
    // distinct Host/TUI/Browser environments.
    const tuiCwd = join(productRoot, 'client-local-tui')
    const tuiHome = join(productRoot, 'client-local-tui-home')
    mkdirSync(tuiCwd, { recursive: true, mode: 0o700 })
    mkdirSync(tuiHome, { recursive: true, mode: 0o700 })
    chmodSync(tuiCwd, 0o700)
    chmodSync(tuiHome, 0o700)
    mkdirSync(join(productRoot, 'client-local-scratch'), { recursive: true, mode: 0o700 })
    writeFileSync(join(tuiCwd, 'tui-private-sentinel.txt'), `prd-tui-private-${productNonce}\n`, { mode: 0o600 })
    // The Remote prompt serializer has NO generic-file upload-receipt seam
    // (`prompt-serializer-remote.ts` returns `unsupported` for a generic
    // file), so the TUI Client-local intake is qualified with an IMAGE: the
    // bytes are read by the Client, encoded into the prompt and stored by the
    // Host attachment owner. The generic-file `/attach` boundary is recorded
    // as UNAVAILABLE, never claimed as PASS.
    const tuiImageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
    const tuiImagePath = join(tuiCwd, 'tui-local-image.png')
    writeFileSync(tuiImagePath, tuiImageBytes, { mode: 0o600 })
    const tuiPath = join(tuiCwd, 'bin')
    mkdirSync(tuiPath, { recursive: true, mode: 0o700 })
    const tuiPathValue = `${tuiPath}:${base.env.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}`
    // The REAL TUI process gets its OWN cwd, HOME and PATH; the Host keeps
    // base.cwd/base home/PATH. The locality assertions must compare the real
    // process facts, not two directories that were only created.
    const { tui: tuiLocal } = await startTui('WP-09 Client-local TUI', {
      HOME: tuiHome,
      PATH: tuiPathValue,
      SPLIT_PROCESS_CLIENT_SESSION: sessionToggle,
      SPLIT_PROCESS_SCRATCH: join(productRoot, 'client-local-scratch'),
    }, { cwd: tuiCwd })
    await tuiLocal.waitForScreen(`W-${productNonce}-seed`, 'WP-09 Client-local TUI reads the Session', 180_000)
    const browserUploadMarker = `w-${productNonce}-browser-upload`
    let hostShellFact
    let hostShellFeature
    await browserCase('wp09-locality', {
      sessionId: sessionToggle,
      expectedAnswer: 'long-turn answer',
    }, async handle => {
      await handle.waitFact('upload', 'WP-09 Browser upload', 240_000)
      hostShellFact = await handle.waitFact('host-shell', 'WP-09 Host terminal command', 240_000)
    })
    await tuiLocal.waitForScreen('browser-local-sentinel.txt', 'WP-09 TUI sees the Browser attachment', 180_000)
    // The TUI Client-local intake reads the image in the TUI process; the
    // bytes are encoded into the prompt and the Host attachment owner stores
    // them. The placeholder is a Client draft, never a Host path.
    tuiLocal.send(`/image ${tuiImagePath}\r`)
    await tuiLocal.waitForScreen('[image #', 'WP-09 TUI Client-local image staged', 60_000)
    await tuiTurn(tuiLocal, sessionToggle, `w-${productNonce}-tui-image`, 'WP-09 TUI image turn')
    assert(durableOf(sessionToggle).some(event => event.type === 'user/message'
      && JSON.stringify(event).includes('"type":"image"')),
    'WP-09 the TUI Client-local image never reached the Host user message')
    // A real Client-local export: `/copy` writes the last assistant message
    // through the client clipboard policy (the OSC 52 leg is observable on
    // the PTY and never reaches the Host).
    const rawBeforeCopy = tuiLocal.raw.length
    tuiLocal.send('/copy\r')
    await waitForCondition(() => tuiLocal.raw.slice(rawBeforeCopy).includes('\u001b]52;'),
      'WP-09 Client-local clipboard export', 30_000)
    // The Host storage holds the OFFICIAL uploads of both Clients' sentinel
    // bytes, but never the TUI-private file that was never attached.
    const storageMatches = async needle => {
      const roots = [join(dshHome, 'attachments'), join(dshHome, 'storages'), join(dshHome, 'files')]
        .filter(root => existsSync(root))
      for (const root of roots) {
        const stack = [root]
        while (stack.length > 0) {
          const current = stack.pop()
          const stats = statSync(current)
          if (stats.isDirectory()) {
            for (const name of readdirSync(current)) stack.push(join(current, name))
            continue
          }
          if (stats.size > 8 * 1024 * 1024) continue
          try {
            if (readFileSync(current).includes(needle)) return current
          } catch { /* unreadable transient file */ }
        }
      }
      return undefined
    }
    const storageMatchesBytes = async needle => {
      const roots = [join(dshHome, 'attachments'), join(dshHome, 'storages'), join(dshHome, 'files')]
        .filter(root => existsSync(root))
      for (const root of roots) {
        const stack = [root]
        while (stack.length > 0) {
          const current = stack.pop()
          const stats = statSync(current)
          if (stats.isDirectory()) {
            for (const name of readdirSync(current)) stack.push(join(current, name))
            continue
          }
          if (stats.size > 8 * 1024 * 1024) continue
          try {
            if (readFileSync(current).includes(needle)) return current
          } catch { /* unreadable transient file */ }
        }
      }
      return undefined
    }
    const browserUpload = await storageMatches(`prd-browser-local-${productNonce}`)
    assert(typeof browserUpload === 'string', 'WP-09 the Browser-local uploaded bytes never reached Host storage')
    const tuiUpload = await storageMatchesBytes(tuiImageBytes)
    assert(typeof tuiUpload === 'string', 'WP-09 the TUI Client-local image bytes never reached Host storage')
    const privateLeak = await storageMatches(`prd-tui-private-${productNonce}`)
    assert(privateLeak === undefined, `WP-09 the Host read a TUI-private file that was never attached: ${String(privateLeak)}`)
    const localityHeader = await waitForHostSessionHeader(dshHome, sessionToggle, 'WP-09 Session header')
    // Read the REAL process facts from /proc: the TUI's own cwd/HOME/PATH and
    // the Host's own cwd/HOME/PATH. Creating tuiCwd/tuiHome is not isolation.
    const tuiPid = tuiLocal.records.filter(record => record.m4a0 === 'ready').at(-1)?.pid
    assert(Number.isInteger(tuiPid) && tuiPid > 0, 'WP-09 the TUI published no business PID')
    const procCwd = pid => realpathSync(readlinkSync(`/proc/${String(pid)}/cwd`))
    const procEnv = pid => Object.fromEntries(readFileSync(`/proc/${String(pid)}/environ`).toString('utf8')
      .split('\0').filter(Boolean).map(entry => {
        const equals = entry.indexOf('=')
        return [entry.slice(0, equals), entry.slice(equals + 1)]
      }))
    const tuiCwdActual = procCwd(tuiPid)
    const hostCwdActual = procCwd(groupA.ready.pid)
    const tuiEnvActual = procEnv(tuiPid)
    const hostEnvActual = procEnv(groupA.ready.pid)
    assert(tuiCwdActual === realpathSync(tuiCwd),
      `WP-09 the TUI process cwd is ${tuiCwdActual}, not the isolated tuiCwd`)
    assert(hostCwdActual !== tuiCwdActual,
      `WP-09 the Host and TUI share the same cwd (${hostCwdActual})`)
    assert(tuiEnvActual.HOME === tuiHome, `WP-09 the TUI HOME is ${String(tuiEnvActual.HOME)}, not tuiHome`)
    assert(hostEnvActual.HOME !== tuiEnvActual.HOME,
      `WP-09 the Host and TUI share HOME (${String(hostEnvActual.HOME)})`)
    assert(tuiEnvActual.PATH === tuiPathValue, 'WP-09 the TUI PATH is not the isolated path')
    assert(hostEnvActual.PATH !== tuiEnvActual.PATH,
      'WP-09 the Host and TUI share PATH')
    assert(localityHeader.cwd === hostCwdActual,
      `WP-09 the Session workspace ${localityHeader.cwd} is not the Host cwd ${hostCwdActual}`)
    evidence.environment('wp09-locality', {
      host: { cwd: hostCwdActual, home: hostEnvActual.HOME, path: hostEnvActual.PATH },
      tui: { cwd: tuiCwdActual, home: tuiEnvActual.HOME, path: tuiEnvActual.PATH },
      sessionWorkspace: localityHeader.cwd,
    })
    assert(typeof localityHeader.cwd === 'string' && !localityHeader.cwd.startsWith(tuiCwd),
      `WP-09 the Session workspace is the TUI client cwd (${String(localityHeader.cwd)}) instead of a Host workspace`)
    assert(!existsSync(join(tuiCwd, 'browser-local-sentinel.txt')),
      'WP-09 the Browser-local file was written into the TUI Client cwd')
    // Host-owned workspace shell/path: the real Web terminal (right sidebar →
    // New tab → New terminal) runs a Host PTY in the Session workspace. Its
    // commands must create Host-side files, never files in the TUI Client cwd.
    assert(hostShellFact !== undefined && typeof hostShellFact.marker === 'string',
      'WP-09 the Host terminal command produced no marker fact')
    const hostShellMarkerPath = join(localityHeader.cwd, 'host-shell-marker.txt')
    const hostShellPwdPath = join(localityHeader.cwd, 'host-shell-pwd.txt')
    assert(existsSync(hostShellMarkerPath),
      `WP-09 the Host terminal marker is absent from the Host Session workspace (${hostShellMarkerPath})`)
    assert(readFileSync(hostShellMarkerPath, 'utf8').trim() === hostShellFact.marker,
      'WP-09 the Host terminal marker content is not the command marker')
    assert(existsSync(hostShellPwdPath), `WP-09 the Host terminal pwd file is absent (${hostShellPwdPath})`)
    const hostShellPwd = readFileSync(hostShellPwdPath, 'utf8').trim()
    assert(hostShellPwd === localityHeader.cwd || realpathSync(hostShellPwd) === realpathSync(localityHeader.cwd),
      `WP-09 the Host terminal ran in ${hostShellPwd}, not the Host Session workspace ${localityHeader.cwd}`)
    assert(!existsSync(join(tuiCwd, 'host-shell-marker.txt')),
      'WP-09 the Host terminal marker landed in the TUI Client cwd')
    hostShellFeature = {
      feature: 'web terminal/PTY',
      entryVisible: true,
      actualAction: 'opened the official Web terminal (right sidebar → New tab → New terminal) and ran pwd/printf in the Host PTY',
      hostApi: 'official Web terminal/PTY, Host-owned Session workspace',
      durableOrUiResult: `Host files created at ${hostShellPwd}: host-shell-marker.txt and host-shell-pwd.txt`,
      status: 'SUPPORTED_PASS',
      reason: '',
      evidence: ['WP-09-host-shell', hostShellPwd],
      supportText: 'The official Web terminal runs in the Session workspace on the Host; commands create files on the Host, not in the TUI client cwd.',
    }
    recordSession('wp09-locality', sessionToggle)
    await ptyFrames('wp09-locality', tuiLocal)
    setWc('WC-10', 'PASS', 'Browser-local upload, TUI Client-local image intake and a real Host-owned Web terminal command were proven: Host-side files were created in the Session workspace and not in the TUI cwd; a TUI-private file never reached the Host. TUI generic-file /attach is UNAVAILABLE in the Remote composition (no upload-receipt seam) and is recorded, not claimed', ['WP-04A', 'WP-09'])

    // WP-10: the honest visible-feature inventory.
    const inventory = await browserCase('wp10-inventory', {}, async () => {})
    const featureMatrix = (inventory.features ?? []).filter(feature => feature.feature !== 'web terminal/PTY')
    if (hostShellFeature !== undefined) featureMatrix.push(hostShellFeature)
    evidence.features(featureMatrix)
    recordSession('wp10-inventory', inventory.sessionId)
    await ptyFrames('wp10-inventory', groupTui)
    assert((inventory.features ?? []).some(feature => feature.feature === 'session.create/list/open' && feature.status === 'SUPPORTED_PASS'),
      'WP-10 the core Session create/list/open surface did not PASS')
    assert((inventory.features ?? []).some(feature => feature.feature === 'conversation live Turn/history' && feature.status === 'SUPPORTED_PASS'),
      'WP-10 the core live Turn surface did not PASS')
    for (const feature of ['Questions', 'Approvals']) {
      assert((inventory.features ?? []).some(entry => entry.feature === feature && entry.status === 'SUPPORTED_PASS'),
        `WP-10 the core ${feature} surface did not PASS`)
    }
    setWc('WC-12', 'DEFERRED_WITH_OWNER', 'the Web feature inventory is recorded (core Session/Turn/Question/Approval PASS; optional panels are honestly NOT_VERIFIED). The REAL Tern GUI half is deferred by explicit OWNER decision on 2026-11-05: the TSP `/web` picker is only reachable from the Direct renderer selection while the serving `piTuiWebAccess` Host service is only composed by the Split Host-only overlay. Responsible: M5-W owner. Re-entry: when a composition change lets the TSP/Tern GUI reach the serving Host WebAccessPort. This is NOT a GUI PASS and NOT stage closure.', ['WP-10'])

    // The evidence PTY frame of the last group-A TUI state.
    const tuiAAfter = await hostStatus(groupA.host)
    assertSingleHostOwners(tuiAAfter, 'PR-D group A final')
    assertIdentityFields(tuiAAfter.localHost, groupAIdentity, 'PR-D group A Host identity')
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'PR-D the candidate artifact changed during the product qualification')
    trace('t75-web-product-group-a', {
      hostPid: groupA.ready.pid,
      sessions: { wp01: wp01Session, tui: sessionA, browser: sessionB, toggled: sessionToggle },
      hostOwners: tuiAAfter.ownerEntries,
      browserSessions: wp01.browserClientActions?.length ?? 0,
    })
    for (const client of clients.splice(0)) {
      if (client.exited) continue
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    if (!groupA.host.exited) {
      try { await groupA.host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }

    // ── Group B: WP-03 Questions ────────────────────────────────────────
    const questionGroup = await startHost('question', 'wp03')
    assertSingleHostOwners(questionGroup.ready, 'WP-03 Host')
    const { tui: tuiQ } = await startTui('wp03')
    await enableWeb(tuiQ, 'WP-03')
    const questionWork = questionGroup.workRoot

    const startQuestionSession = async (label, trigger) => {
      const sessionId = await tuiNewSession(tuiQ, `${label} new Session`)
      const boundary = durableOf(sessionId).length
      await tuiSubmitUntil(tuiQ, trigger, label, () => readC1WorkEvents(questionWork)
        .some(event => event.kind === 'question-request' && event.sessionId === sessionId))
      await tuiQ.waitForScreen('[1] Proceed', `${label} question modal`, 180_000)
      await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-request' && event.sessionId === sessionId, `${label} Host question request`, 120_000)
      return { sessionId, boundary }
    }

    // WP-03A: the Browser answers the Question.
    const qa = await startQuestionSession('WP-03A', `wp03a-${productNonce}`)
    await browserCase('wp03a-question-browser-first', { sessionId: qa.sessionId }, async handle => {
      await handle.waitFact('question-visible', 'WP-03A Browser question', 240_000)
      await handle.waitFact('answered', 'WP-03A Browser answer', 240_000)
      const settled = await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-settled' && event.sessionId === qa.sessionId, 'WP-03A Host question settled', 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
        `WP-03A the Host received ${JSON.stringify(settled.answers)} instead of Proceed`)
      await tuiQ.waitForScreen('question answered', 'WP-03A TUI converged', 180_000)
      await tuiQ.waitForScreenGone('[1] Proceed', 'WP-03A TUI pending withdrew', 120_000)
      const late = durableOf(qa.sessionId).length
      tuiQ.send('2')
      await sleep(300)
      tuiQ.send('\x15')
      await sleep(300)
      assert(durableOf(qa.sessionId).slice(late).every(event => event.type !== 'tool/call'
        && event.type !== 'tool/result' && event.type !== 'turn/end'),
      'WP-03A a late TUI option key produced Host activity')
      await handle.signal('runner-go')
    })
    const qaSettlements = readC1WorkEvents(questionWork)
      .filter(event => event.kind === 'question-settled' && event.sessionId === qa.sessionId)
    assert(qaSettlements.length === 1, `WP-03A the Host settled the question ${String(qaSettlements.length)} times`)
    recordSession('wp03a-question-browser-first', qa.sessionId)
    await ptyFrames('wp03a-question-browser-first', tuiQ)
    setWc('WC-06', 'PASS', 'Browser-first Question settled the Host once and the TUI converged', ['WP-03A'])

    // WP-03B: the TUI answers; the Browser's old location is inert.
    const qb = await startQuestionSession('WP-03B', `wp03b-${productNonce}`)
    await browserCase('wp03b-question-tui-first', { sessionId: qb.sessionId }, async handle => {
      await handle.waitFact('question-visible', 'WP-03B Browser question', 240_000)
      tuiQ.send('1')
      await tuiQ.waitForScreen('Review your answer before submit', 'WP-03B TUI review', 30_000)
      tuiQ.send('\r')
      await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-settled' && event.sessionId === qb.sessionId, 'WP-03B Host settled', 120_000)
      await tuiQ.waitForScreen('question answered', 'WP-03B TUI answer landed', 180_000)
      await handle.signal('tui-answered')
      await handle.waitFact('settled', 'WP-03B Browser converged', 180_000)
    })
    assert(readC1WorkEvents(questionWork)
      .filter(event => event.kind === 'question-settled' && event.sessionId === qb.sessionId).length === 1,
    'WP-03B the Host settled the TUI-first question more than once')
    recordSession('wp03b-question-tui-first', qb.sessionId)
    await ptyFrames('wp03b-question-tui-first', tuiQ)
    setWc('WC-06', 'PASS', 'Browser-first and TUI-first Questions both settled the Host once; the loser stayed inert', ['WP-03A', 'WP-03B'])

    // WP-03C: Browser detach while pending, TUI settles, stale Browser inert.
    const qc = await startQuestionSession('WP-03C', `wp03c-${productNonce}`)
    await browserCase('wp03c-question-detach', { sessionId: qc.sessionId }, async handle => {
      await handle.waitFact('question-visible', 'WP-03C Browser question', 240_000)
      await handle.waitFact('detached', 'WP-03C Browser detached', 120_000)
      tuiQ.send('1')
      await tuiQ.waitForScreen('Review your answer before submit', 'WP-03C TUI review', 30_000)
      tuiQ.send('\r')
      await waitForC1WorkEvent(questionWork,
        event => event.kind === 'question-settled' && event.sessionId === qc.sessionId, 'WP-03C Host settled', 120_000)
      await handle.signal('tui-answered')
      await handle.waitFact('reattached', 'WP-03C Browser reattached', 240_000)
    })
    assert(readC1WorkEvents(questionWork)
      .filter(event => event.kind === 'question-settled' && event.sessionId === qc.sessionId).length === 1,
    'WP-03C the detached Browser produced a second question settlement')
    recordSession('wp03c-question-detach', qc.sessionId)
    await ptyFrames('wp03c-question-detach', tuiQ)
    setWc('WC-06', 'PASS', 'a detached Browser could not resurrect or re-settle the Question; the TUI answer was the only settlement', ['WP-03A', 'WP-03B', 'WP-03C'])

    for (const client of clients.splice(0)) {
      if (client.exited) continue
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    if (!questionGroup.host.exited) {
      try { await questionGroup.host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }

    // WP-03D: the official timed question is a negative control, not a
    // substitute for a legal Browser responder.
    const timed = await startHost('question', 'wp03-timed', { C1_TIMED_QUESTION: '1' }, timedProductPatch)
    const { tui: tuiTimed } = await startTui('wp03-timed')
    await enableWeb(tuiTimed, 'WP-03D')
    await browserCase('wp03d-question-timed', {}, async handle => {
      await tuiSubmitUntil(tuiTimed, `wp03d-${productNonce}`, 'WP-03D', () => readC1WorkEvents(timed.workRoot)
        .some(event => event.kind === 'question-request'))
      // The official timed window is one second: the TUI modal may already
      // be gone. The Host fixture's own request record is the authority for
      // the Session id, and the 1s window is exactly the negative control.
      const request = await waitForC1WorkEvent(timed.workRoot,
        event => event.kind === 'question-request', 'WP-03D timed question request', 180_000)
      const sessionId = request.sessionId
      assert(typeof sessionId === 'string' && sessionId !== '', 'WP-03D the timed trigger created no Session')
      writeFileSync(join(handle.coord, 'session.json'), `${JSON.stringify({ sessionId }, null, 2)}\n`, { mode: 0o600 })
      await handle.waitFact('timed', 'WP-03D timed Browser observation', 240_000)
    })
    const timedSession = lastSurfaceStatus(tuiTimed)?.openSessionId
    const timedProofs = readC1WorkEvents(timed.workRoot)
    assert(timedProofs.some(event => event.kind === 'question-request' && event.timed === true),
      'WP-03D the Host question was not the official timed form')
    assert(timedProofs.some(event => event.kind === 'question-failed'),
      'WP-03D the timed question produced no official timeout failure')
    assert(!timedProofs.some(event => event.kind === 'question-settled' && event.sessionId === timedSession),
      'WP-03D the timed question was reported as an answered question')
    if (typeof timedSession === 'string') recordSession('wp03d-question-timed', timedSession)
    await ptyFrames('wp03d-question-timed', tuiTimed)
    setWc('WC-06', 'PASS', 'Browser/TUI first-winner, detach and the official timed negative are recorded', ['WP-03A', 'WP-03B', 'WP-03C', 'WP-03D'])
    for (const client of clients.splice(0)) {
      if (client.exited) continue
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    if (!timed.host.exited) {
      try { await timed.host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }

    // ── Group C/D: WP-04 Approvals ──────────────────────────────────────
    const runApprovalGroup = async (scenario, cases) => {
      const group = await startHost(scenario, `wp04-${scenario}`)
      const { tui } = await startTui(`wp04-${scenario}`)
      await enableWeb(tui, `WP-04 ${scenario}`)
      const sessionFor = async (label, trigger) => {
        const sessionId = await tuiNewSession(tui, `${label} new Session`)
        await tuiSubmitUntil(tui, trigger, label, () => readC1WorkEvents(group.workRoot)
          .some(event => event.kind === 'approval-request' && event.sessionId === sessionId))
        await tui.waitForScreen('[y] Allow once', `${label} approval sheet`, 180_000)
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-request' && event.sessionId === sessionId, `${label} Host approval request`, 120_000)
        return sessionId
      }
      try {
        await cases({ group, tui, sessionFor })
      } finally {
        for (const client of clients.splice(0)) {
          if (client.exited) continue
          try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
        }
        if (!group.host.exited) {
          try { await group.host.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
      }
      return group
    }
    const approvalAllow = await runApprovalGroup('approval-allow', async ({ group, tui, sessionFor }) => {
      // WP-04A: Browser Allow wins; the TUI late Reject is inert.
      const a1 = await sessionFor('WP-04A', `wp04a-${productNonce}`)
      await browserCase('wp04a-approval-browser-allow', { sessionId: a1 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04A Browser approval', 240_000)
        await handle.waitFact('answered', 'WP-04A Browser Allow', 240_000)
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
          'WP-04A Host allowed the approval', 120_000)
        await waitForCondition(() => existsSync(join(group.workRoot, 'approval-allow.marker')),
          'WP-04A the allowed harmless command ran', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04A TUI converged', 180_000)
        await tui.waitForScreenGone('[y] Allow once', 'WP-04A TUI sheet withdrew', 120_000)
        const late = durableOf(a1).length
        tui.send('n')
        await sleep(300)
        tui.send('\x15')
        await sleep(300)
        assert(durableOf(a1).slice(late).every(event => event.type !== 'approval/decided'
          && event.type !== 'tool/result' && event.type !== 'turn/end'),
        'WP-04A a late TUI Reject produced a second Host decision')
        await handle.signal('runner-go')
      })
      const decided = durableOf(a1).filter(event => event.type === 'approval/decided')
      assert(decided.length === 1 && decided[0].data?.outcome === 'allowed-once',
        `WP-04A the Host decided ${JSON.stringify(decided.map(event => event.data?.outcome))}`)
      assert(existsSync(join(group.workRoot, 'approval-allow.marker')),
        'WP-04A the allowed marker command did not run on the Host')
      assert(!existsSync(join(tuiCwd, 'approval-allow.marker')),
        'WP-04A the Host marker landed in the TUI client cwd')
      recordSession('wp04a-approval-browser-allow', a1)
      await ptyFrames('wp04a-approval-browser-allow', tui)

      // WP-04C: TUI Allow wins; the Browser late Allow is inert.
      const a2 = await sessionFor('WP-04C', `wp04c-${productNonce}`)
      await browserCase('wp04c-approval-tui-first', { sessionId: a2 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04C Browser approval', 240_000)
        tui.send('y')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
          'WP-04C Host allowed the approval', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04C TUI settled', 180_000)
        await handle.signal('tui-answered')
        await handle.waitFact('settled', 'WP-04C Browser converged', 180_000)
      })
      assert(durableOf(a2).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04C the TUI-first approval produced more than one Host decision')
      recordSession('wp04c-approval-tui-first', a2)
      await ptyFrames('wp04c-approval-tui-first', tui)

      // WP-04F: the Browser sees the pending Approval, detaches, the TUI
      // settles, and the reattached Browser can only read the decision.
      const a3 = await sessionFor('WP-04F', `wp04f-${productNonce}`)
      await browserCase('wp04f-approval-offline', { sessionId: a3 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04F Browser approval', 240_000)
        await handle.waitFact('detached', 'WP-04F Browser detached', 120_000)
        tui.send('y')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
          'WP-04F Host allowed the approval', 120_000)
        await handle.signal('tui-answered')
        await handle.waitFact('reattached', 'WP-04F Browser reattached', 240_000)
      })
      assert(durableOf(a3).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04F the detached Browser produced a second Host approval decision')
      recordSession('wp04f-approval-offline', a3)
      await ptyFrames('wp04f-approval-offline', tui)
    })

    const approvalReject = await runApprovalGroup('approval-reject', async ({ group, tui, sessionFor }) => {
      // WP-04B: Browser Reject; the TUI late Allow cannot execute.
      const b1 = await sessionFor('WP-04B', `wp04b-${productNonce}`)
      await browserCase('wp04b-approval-browser-reject', { sessionId: b1 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04B Browser approval', 240_000)
        await handle.waitFact('answered', 'WP-04B Browser Reject', 240_000)
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'WP-04B Host rejected the approval', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04B TUI converged', 180_000)
        await tui.waitForScreenGone('[y] Allow once', 'WP-04B TUI sheet withdrew', 120_000)
        const late = durableOf(b1).length
        tui.send('y')
        await sleep(300)
        tui.send('\x15')
        await sleep(300)
        assert(durableOf(b1).slice(late).every(event => event.type !== 'approval/decided' && event.type !== 'tool/result'),
          'WP-04B a late TUI Allow produced Host activity')
        await handle.signal('runner-go')
      })
      assert(durableOf(b1).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04B the Browser-first rejection decided more than once')
      assert(!existsSync(join(group.workRoot, 'approval-reject.marker')),
        'WP-04B the rejected command ran')
      recordSession('wp04b-approval-browser-reject', b1)
      await ptyFrames('wp04b-approval-browser-reject', tui)

      // WP-04D: TUI Reject wins; the Browser late Allow is inert.
      const b2 = await sessionFor('WP-04D', `wp04d-${productNonce}`)
      await browserCase('wp04d-approval-tui-reject', { sessionId: b2 }, async handle => {
        await handle.waitFact('approval-visible', 'WP-04D Browser approval', 240_000)
        tui.send('n')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'WP-04D Host rejected the approval', 120_000)
        await tui.waitForScreen('approval settled', 'WP-04D TUI settled', 180_000)
        await handle.signal('tui-answered')
        await handle.waitFact('settled', 'WP-04D Browser converged', 180_000)
      })
      assert(durableOf(b2).filter(event => event.type === 'approval/decided').length === 1,
        'WP-04D the TUI-first rejection decided more than once')
      assert(!existsSync(join(group.workRoot, 'approval-reject.marker')),
        'WP-04D the rejected command ran')
      recordSession('wp04d-approval-tui-reject', b2)
      await ptyFrames('wp04d-approval-tui-reject', tui)
    })

    // WP-04E: the existing qualification Peer's legal stale `$events/result`
    // frame must never produce a second decision. This is the official
    // Gateway/`$events` path, not a private approval endpoint.
    {
      const group = await startHost('approval-allow', 'wp04-stale')
      const { tui } = await startTui('wp04-stale')
      await enableWeb(tui, 'WP-04 stale')
      const stalePeer = await startPeer('WP-04E')
      try {
        const sessionId = await tuiNewSession(tui, 'WP-04E new Session')
        await tuiSubmitUntil(tui, `wp04e-${productNonce}`, 'WP-04E', () => readC1WorkEvents(group.workRoot)
          .some(event => event.kind === 'approval-request' && event.sessionId === sessionId))
        await tui.waitForScreen('[y] Allow once', 'WP-04E approval sheet', 180_000)
        const frame = await stalePeer.waitFor(record => record.m4a0 === 'peer-frame'
          && record.event === 'approval/request', 'WP-04E old Peer captured the approval frame', 180_000)
        assert(typeof frame.eventId === 'string' && typeof frame.clientId === 'string',
          'WP-04E the old Peer frame has no eventId/clientId')
        // While the Approval is STILL pending, a Peer with a FORGED identity
        // must not be able to settle the real pending event. This is the
        // pending-state wrong-Peer control the settled-only lane cannot prove.
        const pendingDecisionsBefore = durableOf(sessionId)
          .filter(event => event.type === 'approval/decided').length
        const forgedPendingClientId = `forged-pending-${productNonce}`
        stalePeer.send({
          op: 'peer-send-stale-result',
          eventId: frame.eventId,
          clientId: forgedPendingClientId,
          value: { kind: 'result', value: 'allowed-once' },
        })
        const forgedPending = await stalePeer.waitFor(record => record.m4a0 === 'peer-stale-result-sent'
          && record.eventId === frame.eventId && record.clientId === forgedPendingClientId,
        'WP-04E forged pending Peer frame submitted', 30_000)
        await sleep(800)
        assert(durableOf(sessionId).filter(event => event.type === 'approval/decided').length === pendingDecisionsBefore,
          'WP-04E a forged Peer settled a PENDING approval')
        assert(!existsSync(join(group.workRoot, 'approval-allow.marker')),
          'WP-04E a forged pending allow executed the command')
        tui.send('n')
        await waitForC1WorkEvent(group.workRoot,
          event => event.kind === 'approval-settled' && event.outcome === 'rejected',
          'WP-04E the legal reject settled', 120_000)
        const afterReject = durableOf(sessionId).filter(event => event.type === 'approval/decided').length
        stalePeer.send({
          op: 'peer-send-stale-result',
          eventId: frame.eventId,
          clientId: frame.clientId,
          value: { kind: 'result', value: 'allowed-once' },
        })
        const stale = await stalePeer.waitFor(record => record.m4a0 === 'peer-stale-result-sent'
          && record.eventId === frame.eventId && record.clientId === frame.clientId,
        'WP-04E stale frame submitted', 30_000)
        assert(stale.ok === true, 'WP-04E the Host did not receive the old legal frame')
        await sleep(800)
        assert(durableOf(sessionId).filter(event => event.type === 'approval/decided').length === afterReject,
          'WP-04E the stale Peer frame produced a second Host decision')
        assert(!existsSync(join(group.workRoot, 'approval-allow.marker')),
          'WP-04E the stale allow executed the rejected command')
        // A forged identity is recorded honestly: the RPC may acknowledge
        // receipt while the Host ignores it through the stale fence.
        stalePeer.send({
          op: 'peer-send-stale-result',
          eventId: `forged-${productNonce}`,
          clientId: `forged-client-${productNonce}`,
          value: { kind: 'result', value: 'allowed-once' },
        })
        const forged = await stalePeer.waitFor(record => record.m4a0 === 'peer-stale-result-sent'
          && record.eventId === `forged-${productNonce}`, 'WP-04E forged frame submitted', 30_000)
        await sleep(500)
        assert(durableOf(sessionId).filter(event => event.type === 'approval/decided').length === afterReject,
          'WP-04E a forged approval frame produced a second Host decision')
        evidence.fact('wp04e-stale-peer', 'peer-negative-controls', {
          pendingForged: {
            eventId: frame.eventId,
            clientId: forgedPendingClientId,
            ok: forgedPending.ok === true,
            ...(forgedPending.errorCode === undefined ? {} : { errorCode: forgedPending.errorCode }),
            decisions: pendingDecisionsBefore,
          },
          staleAfterSettle: {
            eventId: frame.eventId,
            clientId: frame.clientId,
            ok: stale.ok === true,
            ...(stale.errorCode === undefined ? {} : { errorCode: stale.errorCode }),
            decisions: afterReject,
          },
          forgedEventId: {
            eventId: `forged-${productNonce}`,
            ok: forged.ok === true,
            ...(forged.errorCode === undefined ? {} : { errorCode: forged.errorCode }),
            decisions: afterReject,
          },
        })
        recordSession('wp04e-stale-peer', sessionId)
        await ptyFrames('wp04e-stale-peer', tui)
        trace('t75-web-product-stale-peer', {
          pendingForgedRefused: true,
          pendingForgedOk: forgedPending.ok === true,
          pendingForgedErrorCode: forgedPending.errorCode,
          legalFrameIgnored: true,
          forgedFrameOk: forged.ok === true,
          forgedErrorCode: forged.errorCode,
          decisions: afterReject,
        })
      } finally {
        try { await stalePeer.shutdown() } catch { /* the global backstop owns leftovers */ }
        const index = peers.indexOf(stalePeer)
        if (index >= 0) peers.splice(index, 1)
        for (const client of clients.splice(0)) {
          if (client.exited) continue
          try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
        }
        if (!group.host.exited) {
          try { await group.host.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
      }
    }
    setWc('WC-07', 'PASS', 'Browser first Allow/Reject, TUI first Allow/Reject, Browser offline, a PENDING forged-identity Peer refusal and the official stale `$events/result` frame all produced exactly one Host decision and the matching side effect', ['WP-04A', 'WP-04B', 'WP-04C', 'WP-04D', 'WP-04E', 'WP-04F'])
    assert(approvalAllow !== undefined && approvalReject !== undefined, 'WP-04 groups did not complete')

    // ── Group F: WP-05 Browser reload during a HELD Turn ────────────────
    {
      const holdBarrier = join(productRoot, 'long-turn.hold')
      rmSync(holdBarrier, { force: true })
      const held = await startHost('long-turn', 'wp05', { C1_HOLD_LONG_TURN: holdBarrier })
      const { tui } = await startTui('wp05')
      await enableWeb(tui, 'WP-05')
      const sessionHold = await tuiNewSession(tui, 'WP-05 new Session')
      const markerHold = `H-${productNonce}`
      const holdBoundary = durableOf(sessionHold).length
      await tuiSubmitUntil(tui, markerHold, 'WP-05', () => readC1WorkEvents(held.workRoot)
        .some(event => event.kind === 'long-turn-held' && event.sessionId === sessionHold))
      await tui.waitForScreen(markerHold, 'WP-05 held prompt painted', 180_000)
      const heldProof = await waitForC1WorkEvent(held.workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionHold, 'WP-05 held Turn', 180_000)
      assert(heldProof.agentStatus === 'running', 'WP-05 the held Turn is not actually running')
      await waitForHostSessionEventAfter(dshHome, sessionHold, holdBoundary,
        event => event.type === 'turn/start', 'WP-05 turn/start', 120_000)
      const hostBefore = (await hostStatus(held.host)).localHost
      await browserCase('wp05-refresh-held', { sessionId: sessionHold, marker: markerHold }, async handle => {
        await handle.waitFact('viewing', 'WP-05 Browser viewing the held Turn', 240_000)
        await handle.waitFact('reloaded', 'WP-05 Browser reloaded', 240_000)
        assert(!existsSync(holdBarrier), 'WP-05 the Turn was released before the reload proof')
        writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEventAfter(dshHome, sessionHold, holdBoundary,
          event => event.type === 'turn/end', 'WP-05 the held Turn settled', 180_000)
        await tui.waitForScreen('long-turn answer', 'WP-05 TUI painted the settled answer', 180_000)
        await handle.signal('turn-released')
      })
      assertIdentityFields((await hostStatus(held.host)).localHost, hostBefore,
        'WP-05 the Browser reload or the Turn release replaced the Host')
      recordSession('wp05-refresh-held', sessionHold)
      await ptyFrames('wp05-refresh-held', tui)
      setWc('WC-05', 'PASS', 'a real page reload during a HELD Host Turn preserved the Session and the single Host; the released Turn settled once', ['WP-02E', 'WP-05'])
      setWc('WC-08', 'PASS', 'TUI reload/exit/SIGKILL and a real Browser reload kept ONE Host and the durable Session advancing', ['WP-05', 'WP-06'])
      for (const client of clients.splice(0)) {
        if (client.exited) continue
        try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
      }
      if (!held.host.exited) {
        try { await held.host.shutdown() } catch { /* the global backstop owns leftovers */ }
      }
    }

    // ── Group E: WP-07 graceful Host stop and SIGKILL cold resume ───────
    {
      const lifecycle = await startHost('long-turn', 'wp07', { C1_HOLD_LONG_TURN: fastBarrier })
      const { tui } = await startTui('wp07')
      await enableWeb(tui, 'WP-07')
      const sessionLife = await tuiNewSession(tui, 'WP-07 new Session')
      await tuiTurn(tui, sessionLife, `H-${productNonce}-host-life`, 'WP-07 seed')
      const lifecyclePeer = await startPeer('WP-07')
      const savedOn = await webPreference(lifecyclePeer, 'WP-07 autoStart On', true)
      assert(savedOn.ok === true && savedOn.readBack === true, 'WP-07 the autoStart On write did not read back')
      await lifecyclePeer.shutdown()
      const beforeStop = (await hostStatus(lifecycle.host)).localHost
      let wp07Final
      await browserCase('wp07-host-lifecycle', { sessionId: sessionLife }, async handle => {
        await handle.waitFact('ready', 'WP-07 Browser ready', 240_000)
        // 1. Graceful owner-governed stop. Capture the failure boundary BEFORE
        //    the stop so this generation's disconnect cannot borrow an earlier
        //    generation's network/console failure.
        handle.writeCommand({ seq: 0, kind: 'mark', name: 'graceful' })
        await handle.waitStep(0, 'WP-07 mark before the graceful stop')
        const stopped = await lifecycle.host.shutdown()
        assert(stopped.code === 0, 'WP-07 the graceful Host stop exited non-zero')
        handle.writeCommand({ seq: 1, kind: 'expect-offline', mark: 'graceful', timeoutMs: 180_000 })
        await handle.waitStep(1, 'WP-07 Browser observed the graceful stop')
        await waitForCondition(() => !alive(beforeStop.hostPid), 'WP-07 the stopped Host process is gone', 30_000)
        assert(!existsSync(join(dshHome, 'run', 'dsh-pi-tui', beforeStop.scopeId, 'instance.json')),
          'WP-07 the graceful stop left the Host registry')
        // 2. A NEW Host in the same profile scope; its autoStart preference
        //    loads the Web rows BEFORE Ready and the durable Session log.
        const next = await startHost('long-turn', 'wp07-next', { C1_HOLD_LONG_TURN: fastBarrier })
        assert(next.ready.pid !== beforeStop.hostPid, 'WP-07 the cold resume reused the stopped Host process')
        webFullyOn(next.ready)
        assertSingleHostOwners(await hostStatus(next.host), 'WP-07 cold-resumed Host')
        handle.writeCommand({ seq: 2, kind: 'reconnect', sessionId: sessionLife })
        await handle.waitStep(2, 'WP-07 Browser reconnected to the new Host')
        await waitForHostSessionEvent(dshHome, sessionLife,
          event => event.type === 'user/message' && JSON.stringify(event).includes(`H-${productNonce}-host-life`),
          'WP-07 the durable Session survived the graceful stop', 120_000)
        const { tui: nextTui } = await startTui('WP-07 resumed TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionLife })
        await nextTui.waitForScreen(`H-${productNonce}-host-life`, 'WP-07 resumed TUI reads the Session', 180_000)
        handle.writeCommand({ seq: 3, kind: 'prompt', prompt: `H-${productNonce}-after-resume`, marker: `H-${productNonce}-after-resume` })
        await handle.waitStep(3, 'WP-07 Browser turn after cold resume')
        assert(userEvents(sessionLife, `H-${productNonce}-after-resume`).length === 1,
          'WP-07 the Browser turn after cold resume was not committed once')
        // 3. SIGKILL the new Host; a pending/unknown write must not become a
        //    fake success and the old identity must be invalid. The failure
        //    boundary is captured before this generation is killed.
        handle.writeCommand({ seq: 4, kind: 'mark', name: 'sigkill' })
        await handle.waitStep(4, 'WP-07 mark before the SIGKILL')
        const oldInstance = next.ready.localHost.instanceId
        next.host.kill('SIGKILL')
        const killed = await next.host.waitForExit(60_000)
        assert(killed.signal === 'SIGKILL' || killed.code !== 0, `WP-07 the SIGKILL Host exit was ${JSON.stringify(killed)}`)
        handle.writeCommand({ seq: 5, kind: 'expect-offline', mark: 'sigkill', timeoutMs: 180_000 })
        await handle.waitStep(5, 'WP-07 Browser observed the Host SIGKILL')
        const staleInstance = readJson(join(dshHome, 'run', 'dsh-pi-tui', next.ready.localHost.scopeId, 'instance.json'))
        assert(staleInstance.instanceId === oldInstance,
          'WP-07 the SIGKILL left no stale identity for the negative control')
        const final = await startHost('long-turn', 'wp07-final', { C1_HOLD_LONG_TURN: fastBarrier })
        wp07Final = final
        assert(final.ready.localHost.instanceId !== oldInstance,
          'WP-07 a cold-started Host reused the killed instance id')
        await waitForHostSessionHeader(dshHome, sessionLife, 'WP-07 final Session header')
        handle.writeCommand({ seq: 6, kind: 'reconnect', sessionId: sessionLife })
        await handle.waitStep(6, 'WP-07 Browser reconnected after the SIGKILL')
        handle.writeCommand({ seq: 7, kind: 'finish' })
        await handle.waitStep(7, 'WP-07 Browser finish')
      })
      recordSession('wp07-host-lifecycle', sessionLife)
      setWc('WC-08', 'PASS', 'graceful stop and SIGKILL each left a stale/absent old identity, no fabricated settlement, and ONE fresh Host with the durable Session and autoStart preference', ['WP-05', 'WP-06', 'WP-07'])
      if (wp07Final !== undefined && !wp07Final.host.exited) {
        const stop = await wp07Final.host.shutdown()
        assert(stop.code === 0, 'WP-07 the final Host did not stop before the pending case')
      }

      // WP-07 pending/unknown Browser write across a Host SIGKILL.
      {
        const pendingBarrier = join(productRoot, 'long-turn.pending')
        rmSync(pendingBarrier, { force: true })
        const pending = await startHost('long-turn', 'wp07-pending', { C1_HOLD_LONG_TURN: pendingBarrier })
        const { tui: pendingTui } = await startTui('wp07-pending')
        await enableWeb(pendingTui, 'WP-07 pending')
        const pendingMarker = `H-${productNonce}-pending`
        let pendingSession
        let pendingNext
        try {
          await browserCase('wp07-pending-write', {}, async handle => {
            const session = await handle.waitFact('session', 'WP-07 pending Session', 240_000)
            pendingSession = session.sessionId
            handle.writeCommand({ seq: 1, kind: 'send', prompt: pendingMarker })
            await handle.waitStep(1, 'WP-07 pending Browser send')
            await waitForC1WorkEvent(pending.workRoot,
              event => event.kind === 'long-turn-held' && event.sessionId === pendingSession,
              'WP-07 pending Host held the Turn', 180_000)
            const beforeKill = durableOf(pendingSession)
            assert(beforeKill.filter(event => event.type === 'user/message'
              && JSON.stringify(event).includes(pendingMarker)).length === 1,
            'WP-07 pending: the Browser prompt was not committed once before the kill')
            assert(!beforeKill.some(event => event.type === 'assistant/message'),
              'WP-07 pending: an assistant message settled before the kill')
            assert(!beforeKill.some(event => event.type === 'turn/end'),
              'WP-07 pending: the Turn settled before the kill')
            handle.writeCommand({ seq: 2, kind: 'mark', name: 'pending' })
            await handle.waitStep(2, 'WP-07 pending mark before the SIGKILL')
            pending.host.kill('SIGKILL')
            const killed = await pending.host.waitForExit(60_000)
            assert(killed.signal === 'SIGKILL' || killed.code !== 0,
              `WP-07 pending Host exit was ${JSON.stringify(killed)}`)
            handle.writeCommand({ seq: 3, kind: 'expect-offline', mark: 'pending', timeoutMs: 180_000 })
            await handle.waitStep(3, 'WP-07 pending Browser observed the SIGKILL')
            const afterKill = durableOf(pendingSession)
            assert(afterKill.filter(event => event.type === 'user/message'
              && JSON.stringify(event).includes(pendingMarker)).length === 1,
            'WP-07 pending: the kill duplicated the pending prompt')
            assert(!afterKill.some(event => event.type === 'assistant/message'),
              'WP-07 pending: the killed Host fabricated an assistant answer')
            pendingNext = await startHost('long-turn', 'wp07-pending-next', { C1_HOLD_LONG_TURN: pendingBarrier })
            assert(pendingNext.ready.localHost.instanceId !== pending.ready.localHost.instanceId,
              'WP-07 pending: the cold Host reused the killed instance id')
            handle.writeCommand({ seq: 4, kind: 'reconnect', sessionId: pendingSession })
            await handle.waitStep(4, 'WP-07 pending Browser reconnected')
            await sleep(1_000)
            const finalEvents = durableOf(pendingSession)
            assert(finalEvents.filter(event => event.type === 'user/message'
              && JSON.stringify(event).includes(pendingMarker)).length === 1,
            'WP-07 pending: the cold Host replayed or duplicated the pending prompt')
            assert(!finalEvents.some(event => event.type === 'assistant/message'),
              'WP-07 pending: the pending prompt was answered after cold resume')
            assert(!finalEvents.some(event => event.type === 'turn/end'
              && event.data?.reason?.kind === 'completed'),
            'WP-07 pending: a fake completed settlement survived the kill')
            handle.writeCommand({ seq: 5, kind: 'finish' })
            await handle.waitStep(5, 'WP-07 pending finish')
          })
          assert(typeof pendingSession === 'string' && pendingSession !== '',
            'WP-07 pending: the Browser created no Session')
          recordSession('wp07-pending-write', pendingSession)
          setWc('WC-08', 'PASS', 'TUI reload/exit/SIGKILL, a real Browser reload and a pending Browser write across Host SIGKILL/cold resume all kept ONE Host/Writer with no fabricated settlement and no replay', ['WP-05', 'WP-06', 'WP-07'])
        } finally {
          try { await pendingTui.dispose() } catch { /* best effort */ }
          if (!pending.host.exited) { try { await pending.host.shutdown() } catch { /* best effort */ } }
          if (pendingNext !== undefined && !pendingNext.host.exited) {
            try { await pendingNext.host.shutdown() } catch { /* best effort */ }
          }
        }
      }
      for (const client of clients.splice(0)) {
        if (client.exited) continue
        try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
      }
    }

    // The evidence writer's final status is deliberately explicit: WP-11's
    // real Tern GUI half is a product-composition blocker, not a PASS.
    evidence.setTernGui({
      status: 'DEFERRED_WITH_OWNER',
      reason: 'the TSP `/web` picker is mounted only by the Direct renderer selection, while the Host WebAccessPort is composed only by the Split Host-only overlay; the current product boundary has no real Tern GUI path to the same serving Host',
      ownerApproval: 'Owner explicitly selected DEFERRED_WITH_OWNER for WP-11/WC-12 in the PR-D session on 2026-11-05',
      responsible: 'M5-W owner',
      reentry: 'when a composition change lets the TSP/Tern GUI reach the same serving Host WebAccessPort',
    })
    const browserSubsetPassed = Object.entries(wc)
      .filter(([code]) => code !== 'WC-12')
      .every(([, entry]) => entry.status === 'PASS')
    const allPassed = Object.values(wc).every(entry => entry.status === 'PASS')
    const ownerDeferredOnly = Object.entries(wc).every(([code, entry]) => entry.status === 'PASS'
      || (code === 'WC-12' && entry.status === 'DEFERRED_WITH_OWNER'))
    // Plan §15/§19: ANY MUST `BLOCKED/NOT_RUN` forbids declaring the PR-D
    // product qualification complete. WC-12 includes the real Tern GUI gate
    // (§12), now explicitly DEFERRED_WITH_OWNER; the overall status records
    // that deferral, while the Browser×TUI subset it actually ran is separate.
    const finalStatus = allPassed ? 'PASS'
      : browserSubsetPassed && ownerDeferredOnly ? 'DEFERRED_WITH_OWNER'
        : browserSubsetPassed ? 'BLOCKED' : 'INCOMPLETE'
    const browserSubset = browserSubsetPassed ? 'PASS' : 'FAIL'
    evidence.finish({ status: finalStatus, browserSubset, wc, browserCases: browserRun })
    trace('t75-web-product', {
      status: finalStatus,
      browserSubset,
      cases: browserRun,
      wc,
      hostPid: groupA.ready.pid,
      ternGui: 'DEFERRED_WITH_OWNER: no real Tern GUI path to the Split Host WebAccessPort in the current composition; Owner-approved on 2026-11-05',
    })
    return { status: finalStatus, browserSubset, wc }
  } finally {
    await cleanup()
  }
}


async function main(explicitPath) {
  // The input phase has its own failure boundary: nothing exists yet, so the
  // lane may only emit the fixed safe projection (identity when the manifest
  // was readable, processes when none exist).
  let candidate
  try {
    // Input qualification BEFORE any install: the candidate must declare this
    // checkout's exact DSH runtime pin, the same rule the production Client
    // reexec preflight applies to a replacement target.
    candidate = inspectSplitCandidate(explicitPath)
  } catch (error) {
    emitInputFailure({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', error })
    throw error
  }
  const { tarball, manifest: candidateManifest, candidateSha256, targetDshVersion } = candidate
  diagnostics = createSmokeDiagnostics({
    lane: 'split-process',
    heading: 'SPLIT_PROCESS_SMOKE',
    marker: 'T',
    runtimeDshPin: targetDshVersion,
    artifacts: [smokeArtifactIdentity('candidate', candidateManifest, candidateSha256)],
  })
  // The startup identity is announced only AFTER preflight qualified it.
  process.stderr.write(`${diagnostics.identityLine()}\n`)
  diagnostics.checkpoint('preflight/candidate-input')
  // The setup itself is inside the same failure boundary: a `mkdtemp`, `mkdir`
  // or `writeFileSync` failure must still leave the safe report AND still remove
  // whatever root was already created, instead of escaping past the cleanup.
  let workDir
  let dshHome
  // The setup itself is inside the same failure boundary: a `mkdtemp`, `mkdir`
  // or `writeFileSync` failure must still leave the safe report AND still remove
  // whatever root was already created, instead of escaping past the cleanup.
  try {
    workDir = mkdtempSync(join(tmpdir(), 'dsh-split-process-'))
    // The cleanup scans this exact DSH_HOME even when the profile installation
    // fails before returning: assign it before the install, not after.
    dshHome = join(workDir, 'dsh-home')
    const installation = createSplitSmokeProfile({ tarball, targetDshVersion, workDir })
    const {
      home,
      env,
      profileDir,
      profilePackage,
      manifest,
      entries,
      anchor,
      clientPeers,
      surfaceLlm,
      base: installedBase,
    } = installation
    trace('client-peer-install', {
      owner: 'active pi-tui profile',
      peers: clientPeers.map(([name, version]) => `${name}@${version}`),
      harnessOwnsClientPeer: false,
    })
    // The whole-lane mutation control injects ONE of the two installed-profile
    // faults the entry-admission case owns, so the patch must exist before the
    // first migrated case boots a Host with this base. The case writes the same
    // two descriptors for its own isolated negative controls.
    const mutationMode = process.env.SPLIT_PROCESS_SMOKE_MUTATION
    const mutation = mutationMode !== undefined && Object.hasOwn(ENTRY_ADMISSION_MUTATIONS, mutationMode)
      ? ENTRY_ADMISSION_MUTATIONS[mutationMode]
      : undefined
    if (mutation !== undefined) writeFileSync(join(workDir, mutation.file), mutation.body)
    // The running mutation wins when present (those cases replace the isolated
    // surface LLM overlay); otherwise the shared install's default stub-LLM
    // patch stays the ONE extra patch.
    const base = mutation === undefined
      ? installedBase
      : { ...installedBase, env: { ...installedBase.env, SPLIT_PROCESS_EXTRA_PATCH: join(workDir, mutation.file) } }
    // The ONE context every migrated case receives: the installed profile facts,
    // the scope-bound process constructors and the lane's single trace/failpoint
    // owner. A case never installs a second profile and never creates a scope.
    const context = {
      installation,
      EntryProcess,
      SurfaceEntryProcess,
      entries,
      base,
      workDir,
      dshHome,
      profilePackage,
      tarball,
      candidateSha256,
      targetDshVersion,
      trace,
      failpoint,
      mode: 'full',
      // Backstop only: the case kills its own detached processes first.
      trackDetachedPid: (pid, starttime) => trackedProcesses.set(pid, starttime),
    }
    /** Run ONE migrated case from the registry: the full lane keeps no second list. */
    const runRegisteredCase = async id => {
      const registered = listSelectableCases().find(entry => entry.id === id)
      assert(registered !== undefined, `the full lane requires the registered case ${id}`)
      return await registered.run(context)
    }

    // The four bootstrap/transport cases run in the FROZEN registry order: the
    // row-disabled pilot, the two bootstrap negatives, then the whole
    // authenticated-link chain. The remaining migrated cases run through their
    // registered functions below; only the Web block stays inline until PR2-D.
    const runtimeRowDisabled = await runRegisteredCase('bootstrap.host-runtime-disabled')
    trace('t26-runtime-row-disabled', {
      exit: runtimeRowDisabled.exitCode,
      readyEmitted: false,
      error: runtimeRowDisabled.error.slice(0, 160),
    })
    await runRegisteredCase('bootstrap.entry-admission')
    await runRegisteredCase('bootstrap.runtime-artifact-recovery')
    await runRegisteredCase('transport.authenticated-lifecycle')

    // Transitional bridge, removed together with the blocks PR2-B/C/D migrate:
    // the still-inline scenarios below address the ONE profile scope this run
    // published under. It is READ from the live run directory that profile
    // created, never carried forward from a previous scenario's derived string.
    const publishedScopeRoot = join(dshHome, 'run', 'dsh-pi-tui')
    const publishedScopeIds = existsSync(publishedScopeRoot)
      ? readdirSync(publishedScopeRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/u.test(entry.name))
        .map(entry => entry.name)
      : []
    assert(publishedScopeIds.length === 1,
      `the full lane must have published exactly one Host scope: ${JSON.stringify(publishedScopeIds)}`)
    const scopeSuffix = publishedScopeIds[0].slice(0, 40)

    // Real-surface qualification (T27-T43 + T61): ONE case owns the dedicated
    // surface Host and every real PTY Client it drives.
    await runRegisteredCase('surface.pty-session-write-recovery')

    // Multi-client and navigation: each case owns its own real C1 Host
    // scene, Client PTYs and durable Session witnesses.
    await runRegisteredCase('multi-client.shared-session-interactions')
    await runRegisteredCase('navigation.non-destructive-client-lifecycle')

    // Continuity / recovery (T44-T66): the three recovery cases own their
    // C1 Host/Client lifecycle, work fixture and durable evidence. The Full
    // lane runs the SAME registered function at the historical position.
    await runRegisteredCase('recovery.detached-turn-interactions')
    await runRegisteredCase('recovery.client-hmr-signals')
    await runRegisteredCase('recovery.unknown-write-host-death')

    // ── Official Web composition (M5-W PR-A): default-off, isolated enable ──
    // This candidate ships ONE Host-only declaration of the 59 official Web
    // rows, every row `disabled: true`. The section proves the two states of
    // that declaration on the SAME candidate tarball:
    //   PA-01  a plain Host serves NO Web surface (no fallback, no /plugins
    //          resource, no Web SSE) and keeps the real TUI fully usable;
    //   PA-02/03/06  ONE private extra patch (the existing internal
    //          extra-patch channel) activates the official rows,
    //          the authenticated index, the official browser graph and the
    //          /plugins resources, with no auto browser open, no printed
    //          token URL and no Web runtime shell variable;
    //   PA-04/05  the real Browser and the real Split TUI share ONE Host
    //          instance and ONE Session: the Browser submits the marker
    //          prompt, the Host completes the Turn, the TUI paints both;
    //   PA-07  one bundle-level client-hmr revision touches ONLY the browser
    //          graph and no Host row fiber;
    //   PA-08  the Web-created Session keeps its Host-persisted workspace when
    //          the TUI attaches (the L5/L6 WS2 lanes above remain the
    //          authoritative Workspace contract evidence);
    //   PA-09/C  a missing official frontend dist and a second client-modules
    //          owner must be REFUSED: a base Host `ready` is never Web ready.
    const qualifyOfficialWebComposition = async () => {
      const webRoot = join(workDir, 'pr-a-web')
      mkdirSync(webRoot, { recursive: true, mode: 0o700 })
      chmodSync(webRoot, 0o700)
      const webHosts = []
      const webClients = []
      const negatives = {}
      /**
       * Every Host-only overlay a live `host-scratch-*` process wrote under this
       * isolated DSH home. The scope directory is discovered (never derived from
       * the truncated seat-name suffix) so a snapshot before/after one boot can
       * tell WHICH overlay this Host wrote.
       */
      const hostScratchOverlays = () => {
        const root = join(dshHome, 'run', 'dsh-pi-tui')
        if (!existsSync(root)) return []
        const overlays = []
        for (const scope of readdirSync(root, { withFileTypes: true })) {
          if (!scope.isDirectory()) continue
          for (const entry of readdirSync(join(root, scope.name), { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith('host-scratch-')) continue
            const overlay = join(root, scope.name, entry.name, 'host-only.patch.yml')
            if (existsSync(overlay)) overlays.push(overlay)
          }
        }
        return overlays
      }
      /** Compare the LIVE overlay against the frozen roster (id, name, order, disabled). */
      const assertDeclaredWebRows = (overlayPath, label) => {
        const entries = parseYaml(readFileSync(overlayPath, 'utf8'))
        const inserts = entries.filter(entry => Array.isArray(entry.insert))
        assert(inserts.length === 2, `${label}: expected the Host execution insert and ONE Web insert, found ${inserts.length}`)
        const rows = inserts[inserts.length - 1].insert
        assert(rows.length === PR_A_WEB_ROWS.length,
          `${label}: the Web insert declares ${rows.length} rows, expected ${PR_A_WEB_ROWS.length}`)
        // The lane's `assert` is a plain predicate, not node:assert: compare the
        // two sequences through one canonical JSON projection.
        assert(JSON.stringify(rows.map(row => row.id)) === JSON.stringify(PR_A_WEB_ROWS.map(row => row.id)),
          `${label}: the Web insert ids drifted from the frozen roster`)
        assert(JSON.stringify(rows.map(row => row.name)) === JSON.stringify(PR_A_WEB_ROWS.map(row => row.name)),
          `${label}: a Web row was re-pointed at a different package`)
        assert(rows.every(row => row.disabled === true), `${label}: every Web row must be disabled by default`)
        const runtime = rows.find(row => row.id === PR_A_WEB_RUNTIME_ID)
        assert(runtime !== undefined, `${label}: the Web runtime row is missing`)
        assert(JSON.stringify(runtime.inject) === JSON.stringify(['webServer']),
          `${label}: web-runtime must inject the existing webserver only`)
        assert(JSON.stringify(runtime.config) === JSON.stringify({ openBrowser: false, printUrl: false, surfaceContext: false }),
          `${label}: web-runtime config must stay false/false/false`)
        return rows
      }
      /** The Host authorities the Web composition must not duplicate. */
      const assertHostOwnersUnchanged = (ready, label) => {
        for (const owner of ['connection', 'apiRemotes', 'workspaceRegistry', 'workspaceController', 'sessionController', 'fileUpload', 'settingsController', 'typertGateway', 'jobController', 'piTuiHostRuntime']) {
          assert(ready.ownerEntries?.[owner]?.length === 1,
            `${label}: the ${owner} owner count is ${JSON.stringify(ready.ownerEntries?.[owner])}, expected exactly one`)
        }
        assert(ready.webServer?.host === '127.0.0.1' && typeof ready.webServer?.port === 'number' && ready.webServer.port > 0,
          `${label}: the ONE loopback listener is not a bound 127.0.0.1 port (${JSON.stringify(ready.webServer)})`)
      }
      /** The ONE per-package owner count of the core official Web rows. */
      const assertSingleWebOwners = (ready, label) => {
        assertHostOwnersUnchanged(ready, label)
        for (const name of PR_A_SINGLETON_PACKAGES) {
          const rows = ready.entries.filter(entry => entry.name === name)
          assert(rows.length === 1, `${label}: expected exactly ONE "${name}" Loader row, found ${rows.length}`)
          assert(rows[0].state === 'active', `${label}: the "${name}" row is ${rows[0].state}, not active`)
        }
      }
      /** Read the Host's own launch material for the ONE browser cookie chain. */
      const launchOf = ready => readJson(join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'launch.json'))
      /** The official Web-created marker fact in the Host's OWN Session log. */
      const waitBrowserTurn = async (sessionId, marker, label) => {
        const userMessage = await waitForHostSessionEventAfter(
          dshHome, sessionId, 0,
          event => event.type === 'user/message' && JSON.stringify(event).includes(marker),
          `${label} Host user/message`, 120_000,
        )
        assert(userMessage !== undefined, `${label}: the Host never persisted the Browser prompt`)
        await waitForHostSessionEventAfter(
          dshHome, sessionId, 0,
          event => event.type === 'turn/end', `${label} Host turn/end`, 120_000,
        )
        const events = hostSessionEvents(dshHome, sessionId) ?? []
        const users = hostUserTexts(events).filter(text => text === marker).length
        assert(users === 1, `${label}: the Host committed the Browser prompt ${users} times, expected exactly 1`)
        assert(hostAssistantHasText(events, 'stub answer'), `${label}: the Host persisted no assistant answer`)
      }
      // The real-Browser case verdict this qualification reports to the caller;
      // it is function-scoped because the final inventory reads it.
      let browserCase = 'NOT_RUN'
      let browserFacts
      try {
        // ── A. The plain candidate: no Web surface, real TUI still works ────
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const scratchBefore = new Set(hostScratchOverlays())
        const plainHost = new EntryProcess('host', entries.host, base)
        webHosts.push(plainHost)
        const plainReady = await plainHost.waitFor(record => record.m4a0 === 'ready', 'PR-A default Host ready', 180_000)
        const plainOrigin = plainReady.localHost.origin
        const declared = hostScratchOverlays().filter(path => !scratchBefore.has(path))
        assert(declared.length === 1, `PA-01 expected ONE overlay written by this Host, found ${declared.length}`)
        const declaredRows = assertDeclaredWebRows(declared[0], 'PA-01')
        assertHostOwnersUnchanged(plainReady, 'PA-01')
        const declaredById = new Map(plainReady.entries.map(entry => [entry.id, entry]))
        const notAbsent = PR_A_WEB_ROWS.map(row => row.id)
          .filter(id => declaredById.get(id)?.state !== 'absent')
        assert(notAbsent.length === 0, `PA-01 these Web rows are not plainly disabled: ${notAbsent.join(',')}`)
        // The ONE loopback listener and the existing authenticated routes stay
        // the only Host network surface.
        const plainRoot = await fetchStatus(`${plainOrigin}/`)
        assert(plainRoot.status === 404, `PA-01 GET / must be 404 without a Web composition, got ${plainRoot.status}`)
        const plainPlugin = await fetchStatus(`${plainOrigin}/plugins/@deepseek-ai/dsh-client-ui-theme/client.js`)
        assert(plainPlugin.status !== 200, `PA-01 the plain Host served an official Browser bundle (HTTP ${plainPlugin.status})`)
        const plainSse = await sseProbe(plainOrigin, '/plugins/events')
        assert(!(plainSse.status === 200 && plainSse.contentType.startsWith('text/event-stream')),
          `PA-01 the plain Host serves a usable Web SSE channel (${plainSse.status} ${plainSse.contentType})`)
        assert(!plainSse.chunk.includes('"graph"'), 'PA-01 the plain Host pushed a browser graph frame')
        const plainApi = await fetchStatus(`${plainOrigin}/api`)
        assert(plainApi.status === 401, `PA-01 the unauthenticated /api route must stay 401, got ${plainApi.status}`)
        const plainConnect = await fetchStatus(`${plainOrigin}/connect`)
        assert(plainConnect.status === 401, `PA-01 the unfunded /connect route must stay 401, got ${plainConnect.status}`)
        // A real TUI Session still works on this plain Host.
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        const plainClient = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        webClients.push(plainClient)
        const plainClientReady = await plainClient.waitFor(record => record.m4a0 === 'ready', 'PR-A default TUI ready', 180_000)
        assert(plainClientReady.surfaceMounted === true && plainClientReady.transport === 'connected',
          'PA-01 the plain Host no longer serves a real TUI Client')
        const plainPrompt = `pr-a plain tui ${randomUUID().slice(0, 8)}`
        plainClient.send(`${plainPrompt}\r`)
        await plainClient.waitForScreen(plainPrompt, 'PA-01 plain TUI prompt painted', 120_000)
        await waitForSurfaceStatus(plainClient, record => record.sessionOpen === true && typeof record.openSessionId === 'string', 'PA-01 plain TUI session')
        await plainClient.waitForScreen('stub answer', 'PA-01 plain TUI answer painted', 120_000)
        plainClient.send('/exit\r')
        const plainExit = await plainClient.waitForExit(60_000)
        assert(plainExit.code === 0 && plainExit.signal === null, `PA-01 plain TUI exit was ${JSON.stringify(plainExit)}`)
        const plainShutdown = await plainHost.shutdown()
        assert(plainShutdown.code === 0, `PA-01 plain Host shutdown exit was ${JSON.stringify(plainShutdown)}`)
        trace('t67-web-default-off', {
          webRowsDeclared: declaredRows.length,
          webRowsDisabled: declaredRows.filter(row => row.disabled === true).length,
          rootStatus: plainRoot.status,
          pluginBundleStatus: plainPlugin.status,
          webSseStatus: plainSse.status,
          apiStatus: plainApi.status,
          connectStatus: plainConnect.status,
          tuiSession: 'painted',
          tuiAnswer: 'painted',
        })

        // ── B. Isolated qualification: the 59 rows enabled by ONE patch ─────
        // The override rows are appended to the SAME single extra patch this
        // lane already uses for its offline Host LLM. The entry accepts exactly
        // ONE extra patch file, so splitting them would silently drop one.
        const webPatch = join(webRoot, 'pr-a-web-enabled.patch.yml')
        // Two ISOLATED-FIXTURE facts ride this private patch and never the
        // product: the official Web UI's first-run preview notice cannot
        // persist its acknowledgement while the whole roster rides a
        // command-line overlay (the config editor refuses an overlay-owned
        // row), so the acknowledgement is written as the row's own config; and
        // the official Workspace Controller needs its deployment Documents
        // override because an isolated HOME has no usable Documents directory.
        const documentsDirectory = join(webRoot, 'documents')
        mkdirSync(documentsDirectory, { recursive: true, mode: 0o700 })
        chmodSync(documentsDirectory, 0o700)
        const llmOperations = readFileSync(surfaceLlm.patchPath, 'utf8').trimEnd()
        const webOverrides = PR_A_WEB_ROWS.map(row => row.id === 'ui-settings-general'
          ? [
            `- id: ${row.id}`,
            '  disabled: false',
            '  config:',
            `    welcomeNoticeVersion: '${PR_A_WELCOME_NOTICE_VERSION}'`,
          ].join('\n')
          : `- id: ${row.id}\n  disabled: false`)
        writeFileSync(webPatch, `${llmOperations}\n${webOverrides.join('\n')}\n- id: workspace-controller\n  config:\n    documentsDirectory: '${documentsDirectory}'\n`, { mode: 0o600 })
        chmodSync(webPatch, 0o600)
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const webHost = new EntryProcess('host', entries.host, {
          ...base,
          env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: webPatch },
        })
        webHosts.push(webHost)
        const webReady = await webHost.waitFor(record => record.m4a0 === 'ready', 'PR-A Web Host ready', 240_000)
        assertSingleWebOwners(webReady, 'PA-04')
        const webEntriesById = new Map(webReady.entries.map(entry => [entry.id, entry]))
        for (const id of [PR_A_WEB_RUNTIME_ID, 'modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller']) {
          assert(webEntriesById.get(id)?.state === 'active', `PA-02 the qualified Host did not activate "${id}"`)
        }
        // `ui-deliverables` may legitimately stay PENDING (state 0) until the
        // Host-side workspaceChanges projection exists. This stage does not add
        // it and does not claim Deliverables support; the fact is recorded.
        const deliverablesState = webEntriesById.get('ui-deliverables')?.state
        const launch = launchOf(webReady)
        const facts = await readHostWebIndex(webReady.localHost.origin, launch, 'PA-02')
        assertWebIndexQualified(facts, 'PA-02', targetDshVersion)
        const graph = facts.graph
        for (const id of [
          '@deepseek-ai/dsh-client-ui-theme',
          '@deepseek-ai/dsh-client-ui-chat',
          '@deepseek-ai/dsh-client-ui-conversation',
          '@deepseek-ai/dsh-client-ui-session',
        ]) {
          assert(graph.entries.some(entry => entry.id === id), `PA-03 the browser graph is missing the official "${id}" component`)
        }
        // The Web graph reuses the Host authorities this composition already
        // owns: their `dsh.client` faces ride along without a second row.
        assert(graph.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-connection'),
          'PA-03 the graph is missing the existing official Connection client face')
        assert(graph.entries.some(entry => entry.id === '@deepseek-ai/dsh-api-workspace-controller'),
          'PA-03 the graph is missing the WS-1 Workspace Controller client face')
        // Browser resources are fetched from the URLs the SERVED index
        // advertises, never from a path this script invented.
        const pluginStatuses = []
        for (const batch of graph.batches) {
          const response = await fetchStatus(new URL(batch.url, `${webReady.localHost.origin}/`).href)
          pluginStatuses.push({ phase: batch.phase, status: response.status, bytes: response.body.length })
          assert(response.status === 200, `PA-03 the ${batch.phase} startup bundle returned HTTP ${response.status}`)
          assert(response.body.length > 1024, `PA-03 the ${batch.phase} startup bundle is empty`)
        }
        const single = graph.entries.find(entry => entry.url !== undefined)
        assert(single !== undefined, 'PA-03 the graph advertises no package-local client bundle')
        const singleResponse = await fetchStatus(new URL(single.url, `${webReady.localHost.origin}/`).href)
        assert(singleResponse.status === 200 && singleResponse.body.length > 1024,
          `PA-03 a package-local client bundle returned ${singleResponse.status}/${singleResponse.body.length} bytes`)
        const unknownPlugin = await fetchStatus(`${webReady.localHost.origin}/plugins/@deepseek-ai/dsh-client-does-not-exist/client.js`)
        assert(unknownPlugin.status === 404, `PA-03 an unknown plugin id returned HTTP ${unknownPlugin.status}`)
        // The Web SSE channel carries the SAME composed graph generation.
        const webSse = await sseProbe(webReady.localHost.origin, '/plugins/events')
        assert(webSse.status === 200 && webSse.contentType.startsWith('text/event-stream'),
          `PA-03 /plugins/events is not a live event stream (${webSse.status} ${webSse.contentType})`)
        // The FIRST complete SSE frame must describe the SAME generation the
        // served index bootstrapped: one composition, two projections.
        const sseDataFrames = webSse.chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
        assert(sseDataFrames.length > 0, 'PA-03 /plugins/events pushed no data frame')
        const sseFirst = JSON.parse(sseDataFrames[0])
        assert(sseFirst.type === 'graph', `PA-03 the first /plugins/events frame is "${String(sseFirst.type)}", not "graph"`)
        assert(sseFirst.graph?.rev === graph.rev,
          'PA-03 the SSE graph generation differs from the served index graph')
        // The official /connect Cookie chain and the v2 API Peer stay intact.
        const webConnect = await fetchStatus(`${webReady.localHost.origin}/connect`)
        assert(webConnect.status === 401, `PA-04 the unauthenticated /connect must stay 401, got ${webConnect.status}`)
        const peerCookie = await connectCookie(webReady.localHost.origin, launch)
        assert(peerCookie !== '', 'PA-04 the authenticated /connect minted no peer cookie')
        // PA-06: the runtime values stay silent — no printed token URL, no
        // auto-opened browser line and no Web shell variable in this process.
        const hostOutput = `${webHost.records.map(record => JSON.stringify(record)).join('\n')}\n${webHost.stderr}`
        assert(facts.token !== null && !hostOutput.includes(facts.token),
          'PA-06 the qualified Host leaked the launch token into its records/stderr')
        assert(!/dsh web:\s*http/iu.test(hostOutput), 'PA-06 the qualified Host printed an authenticated URL line')
        assert(!hostOutput.includes('DSH_WEB_URL'), 'PA-06 the qualified Host exposed the Web shell variable')
        const activatedWebRows = PR_A_WEB_ROWS.filter(row => webEntriesById.get(row.id)?.state === 'active')
        trace('t68-web-qualified', {
          dshVersion: targetDshVersion,
          rowsActivated: activatedWebRows.length,
          rowsNotActivated: PR_A_WEB_ROWS
            .filter(row => webEntriesById.get(row.id)?.state !== 'active')
            .map(row => `${row.id}:${webEntriesById.get(row.id)?.state ?? 'missing'}`),
          indexStatus: facts.index.status,
          tokenExchange: facts.exchange.status,
          graphRelease: graph.release,
          graphEntries: graph.entries.length,
          // `pluginStatuses` is pushed in `graph.batches` order: report it as is,
          // so two application phases cannot both resolve to the first one.
          graphBatches: pluginStatuses,
          singleBundleBytes: singleResponse.body.length,
          unknownPluginStatus: unknownPlugin.status,
          webSseStatus: webSse.status,
          uiDeliverablesState: deliverablesState,
          agentShellVar: 'DSH_WEB_URL stays unregistered by design (surfaceContext:false); asserted structurally and by the absent stdout/records evidence — no private probe row exists in this lane',
        })

        // ── B1. Real Browser x real TUI on ONE Host and ONE Session ─────────
        // Playwright lives OUTSIDE the checkout and is not a dependency of the
        // candidate; without it this case reports NOT_RUN, never PASS.
        const coordination = join(webRoot, 'browser')
        mkdirSync(coordination, { recursive: true, mode: 0o700 })
        chmodSync(coordination, 0o700)
        const marker = `pr-a browser ${randomUUID().slice(0, 8)}`
        const playwrightRoot = process.env.SPLIT_PROCESS_PLAYWRIGHT_ROOT
        if (playwrightRoot === undefined || playwrightRoot === '') {
          assert(!REQUIRE_WEB_BROWSER,
            'PA-05 the real-Browser case is REQUIRED (SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1) but SPLIT_PROCESS_PLAYWRIGHT_ROOT names no pinned Playwright install; an HTTP-only run must never be accepted as the Browser proof')
          trace('t69-web-browser', { status: 'NOT_RUN', reason: 'SPLIT_PROCESS_PLAYWRIGHT_ROOT is not set; this run does NOT exercise the real Browser and does not claim it' })
        } else {
          const chromiumLibs = process.env.SPLIT_PROCESS_CHROMIUM_LIBS ?? join(playwrightRoot, 'libs', 'usr', 'lib', 'x86_64-linux-gnu')
          const browsers = process.env.SPLIT_PROCESS_PLAYWRIGHT_BROWSERS ?? join(playwrightRoot, 'browsers')
          const browserProcess = spawn(process.execPath, [
            join(SCRIPT_DIR, 'fixtures', 'pr-a-web-browser.mjs'),
            coordination,
            marker,
          ], {
            cwd: workDir,
            env: {
              ...env,
              PR_A_DSH_HOME: dshHome,
              PR_A_PLAYWRIGHT_ROOT: playwrightRoot,
              PLAYWRIGHT_BROWSERS_PATH: browsers,
              LD_LIBRARY_PATH: `${chromiumLibs}${process.env.LD_LIBRARY_PATH === undefined ? '' : `:${process.env.LD_LIBRARY_PATH}`}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          })
          let browserOut = ''
          let browserErr = ''
          browserProcess.stdout.setEncoding('utf8')
          browserProcess.stdout.on('data', chunk => { browserOut += chunk })
          browserProcess.stderr.setEncoding('utf8')
          browserProcess.stderr.on('data', chunk => { browserErr += chunk })
          const browserExit = new Promise(resolveExit => browserProcess.on('close', (code, signal) => resolveExit({ code, signal })))
          const browserExitBounded = timeoutMs => browserDriverExitBounded(browserExit, timeoutMs, 'PR_A_BROWSER_EXIT_TIMEOUT')
          /**
           * Only facts the DRIVER owns belong here. A TUI paint is not one of
           * them: the driver may exit normally while the renderer paints the
           * same Host message a moment later.
           */
          const whileBrowserRuns = (startWait, label) => whileBrowserDriverRuns(browserExit, startWait, 'PA-05', label)
          try {
            await whileBrowserRuns(
              signal => waitForCondition(
                () => existsSync(join(coordination, 'browser-session.json')),
                'PR-A Browser Session creation', 240_000, signal,
              ),
              'the Browser Session file appeared',
            )
            const browserSession = readJson(join(coordination, 'browser-session.json')).sessionId
            assert(typeof browserSession === 'string' && browserSession !== '', 'PA-05 the Browser created no Host Session')
            const headerBefore = await waitForHostSessionHeader(dshHome, browserSession, 'PA-08 Browser Session header')
            assert(typeof headerBefore.cwd === 'string' && headerBefore.cwd !== '',
              'PA-08 the Web-created Session has no Host-persisted workspace header')
            // The real Split TUI attaches to the SAME Host and SAME Session.
            await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
            const tui = new SurfaceEntryProcess(entries.client, {
              ...base,
              workDir,
              env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: browserSession },
            })
            webClients.push(tui)
            const tuiReady = await tui.waitFor(record => record.m4a0 === 'ready', 'PA-05 TUI ready on the Web Host', 180_000)
            assertClientHostFacts(tuiReady.host, webReady.localHost, 'PA-05 TUI vs Web Host')
            assert(tuiReady.transport === 'connected', 'PA-05 the TUI did not connect to the Web Host')
            await waitForSurfaceStatus(tui, record => record.sessionOpen === true && record.openSessionId === browserSession,
              'PA-05 TUI attached to the Browser Session')
            // Release the Browser prompt only now: both Clients observe ONE Turn.
            writeFileSync(join(coordination, 'browser-go'), `${Date.now()}\n`, { mode: 0o600 })
            // The TUI paint is NOT gated on Browser liveness: the Host committed
            // the prompt (asserted from the durable log below), and the renderer
            // may paint it after an otherwise successful Browser exit.
            await tui.waitForScreen(marker, 'PA-05 TUI paints the Browser prompt', 180_000)
            await tui.waitForScreen('stub answer', 'PA-05 TUI paints the Host answer', 180_000)
            await waitBrowserTurn(browserSession, marker, 'PA-05')
            const headerAfter = await waitForHostSessionHeader(dshHome, browserSession, 'PA-08 Browser Session header after TUI attach')
            assert(headerAfter.cwd === headerBefore.cwd,
              'PA-08 the TUI attach rewrote the Web-created Session workspace')
            const browserResult = await browserExitBounded(120_000)
            const browserReport = readJson(join(coordination, 'browser-result.json'))
            assert(browserResult.code === 0,
              `PA-05 the real Chromium driver failed (exit ${JSON.stringify(browserResult.code)}/${String(browserResult.signal)}): ${redactWebQualificationText(browserReport.error ?? 'driver-failure', [facts.token])}`)
            assert(browserReport.indexStatus === 200, `PA-05 the real Browser loaded no authenticated index (${browserReport.indexStatus})`)
            assert(browserReport.sessionId === browserSession, 'PA-05 the Browser reported a different Session')
            assert(browserReport.answerSeen === true, 'PA-05 the Browser never painted the Host answer')
            browserFacts = {
              indexStatus: browserReport.indexStatus,
              sessionId: browserSession,
              tuiAttached: true,
              tuiPainted: [marker, 'stub answer'],
              hostTurn: 'complete',
              consoleErrors: browserReport.consoleErrors.length,
              screenshot: browserReport.screenshot,
            }
            browserCase = 'PASS'
            tui.send('/exit\r')
            const tuiExit = await tui.waitForExit(60_000)
            assert(tuiExit.code === 0 && tuiExit.signal === null, `PA-05 TUI exit was ${JSON.stringify(tuiExit)}`)
          } finally {
            try { process.kill(-browserProcess.pid, 'SIGKILL') } catch { /* already exited */ }
            const cleanupExit = await browserExitBounded(15_000)
            if (browserCase !== 'PASS') {
              // The case never reached its PASS marker: record the HONEST verdict
              // (a driver that died before writing its result is INCOMPLETE, not
              // "not run").
              browserCase = existsSync(join(coordination, 'browser-result.json')) ? 'FAILED' : 'INCOMPLETE'
            }
            if (browserCase !== 'PASS') {
              // Only the FIXED category leaves this process by default; the raw
              // driver text is redacted and bounded, never traced.
              process.stderr.write(`PR_A_BROWSER_DIAGNOSTIC: ${redactWebQualificationText(
                `${browserErr} ${browserOut}`, [facts.token],
              ).trim().split('\n').slice(-3).map(line => line.slice(0, 300)).join(' | ')}\n`)
            }
            trace('t69-web-browser-result', {
              status: browserCase,
              ...(browserFacts ?? {}),
              driverExit: cleanupExit.code,
              driverSignal: cleanupExit.signal,
              diagnosticRetained: browserFacts === undefined ? 'redacted-terminal-only' : 'none',
            })
          }
        }

        // ── B2. Bundle-level client-hmr: graph only, no Host row reload ─────
        const beforeStatus = await hostStatus(webHost)
        const beforeUids = new Map(beforeStatus.entries.map(entry => [entry.id, entry.fiberUid]))
        const webAppAnchor = createRequire(anchor).resolve('@deepseek-ai/dsh-web-app/package.json')
        const themeBundle = createRequire(webAppAnchor).resolve('@deepseek-ai/dsh-client-ui-theme/client')
        const stream = openSseFrames(webReady.localHost.origin, '/plugins/events')
        const stamp = new Date(Date.now() + 3_600_000)
        utimesSync(themeBundle, stamp, stamp)
        await waitForCondition(
          () => stream.frames.some(frame => frame.type === 'rebuilt' && frame.id === '@deepseek-ai/dsh-client-ui-theme'),
          'PR-A client-hmr rebuilt frame', 30_000,
        )
        await waitForCondition(
          () => stream.frames.some(frame => frame.type === 'graph' && frame.rev !== graph.rev),
          'PR-A client-hmr graph revision', 30_000,
        )
        stream.close()
        const afterStatus = await hostStatus(webHost)
        const afterUids = new Map(afterStatus.entries.map(entry => [entry.id, entry.fiberUid]))
        const remounted = [...beforeUids.keys()].filter(id => beforeUids.get(id) !== afterUids.get(id))
        assert(remounted.length === 0, `PA-07 the browser bundle rebuild re-mounted these Host rows: ${remounted.join(',')}`)
        assert(afterStatus.localHost.instanceId === webReady.localHost.instanceId,
          'PA-07 the browser bundle rebuild replaced the Host instance')
        assert(afterStatus.pid === webReady.pid, 'PA-07 the browser bundle rebuild replaced the Host PID')
        const hmrFrame = stream.frames.find(frame => frame.type === 'graph' && frame.rev !== graph.rev)
        trace('t70-web-hmr', {
          touched: '@deepseek-ai/dsh-client-ui-theme',
          rebuiltFrame: true,
          graphRevBefore: graph.rev,
          graphRevAfter: hmrFrame.rev,
          hostRowsRemounted: 0,
          hostInstanceKept: true,
          scope: 'bundle-level module graph; real Browser HMR UI remains a later product qualification',
        })

        // The Web Host's own owner-governed shutdown happens BEFORE the negative
        // controls: both need the ONE Host seat this profile owns.
        const webShutdown = await webHost.shutdown()
        assert(webShutdown.code === 0, `PA-04 the Web Host shutdown exit was ${JSON.stringify(webShutdown)}`)
        assert(!existsSync(join(dshHome, 'run', 'dsh-pi-tui', webReady.localHost.scopeId, 'instance.json')),
          'PA-04 the Web Host registry survived its owner-governed shutdown')
        trace('t71-web-shutdown', { exit: webShutdown.code, registryRemoved: true })

        // ── B3. Negative controls: base ready is never Web ready ────────────
        // (1) The official frontend dist is absent from the isolated install.
        const distIndex = join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
        const savedDist = saveFile(distIndex)
        const missingDist = `${distIndex}.missing-pr-a`
        try {
          renameSync(distIndex, missingDist)
          await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
          const absentHost = new EntryProcess('host', entries.host, {
            ...base,
            env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: webPatch },
          })
          webHosts.push(absentHost)
          const outcome = await waitForOutcome(absentHost, 'PR-A dist-absent Host', 240_000)
          let refusedBy = outcome.m4a0 === 'failure' ? 'host-startup' : undefined
          if (refusedBy === undefined) {
            const absentFacts = await readHostWebIndex(outcome.localHost.origin, launchOf(outcome), 'PA-09')
            try {
              assertWebIndexQualified(absentFacts, 'PA-09', targetDshVersion)
            } catch {
              refusedBy = `http-${absentFacts.index.status}`
            }
          }
          assert(refusedBy !== undefined,
            'PA-09 a Host with NO official frontend dist was reported as Web ready')
          negatives.distAbsent = { refusedBy, hostPhase: outcome.phase ?? outcome.m4a0 }
          try { await absentHost.shutdown() } catch { /* the outcome owns it */ }
        } finally {
          renameSync(missingDist, distIndex)
          assert(existsSync(distIndex) && readFileSync(distIndex).equals(savedDist.bytes),
            'PA-09 the official frontend dist was not restored byte for byte')
        }
        // (2) A second client-modules owner: the singleton must be refused.
        const duplicatePatch = join(webRoot, 'pr-a-duplicate-modules.patch.yml')
        writeFileSync(duplicatePatch, `${readFileSync(webPatch, 'utf8')}\n- insert:\n    - id: modules-duplicate\n      name: '${PR_A_CLIENT_MODULES_PACKAGE}'\n`, { mode: 0o600 })
        chmodSync(duplicatePatch, 0o600)
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const duplicateHost = new EntryProcess('host', entries.host, {
          ...base,
          env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: duplicatePatch },
        })
        webHosts.push(duplicateHost)
        const duplicateOutcome = await waitForOutcome(duplicateHost, 'PR-A duplicate modules Host', 240_000)
        let duplicateRefusedBy = duplicateOutcome.m4a0 === 'failure' ? 'host-startup' : undefined
        if (duplicateRefusedBy === undefined) {
          const moduleRows = duplicateOutcome.entries.filter(entry => entry.name === PR_A_CLIENT_MODULES_PACKAGE)
          try {
            assertSingleWebOwners(duplicateOutcome, 'PA-09')
          } catch {
            duplicateRefusedBy = `singleton-rows(${moduleRows.map(row => `${row.id}:${row.state}`).join('|')})`
          }
        }
        assert(duplicateRefusedBy !== undefined,
          'PA-09 a second client-modules owner was accepted as a qualified Web composition')
        negatives.duplicateModules = { refusedBy: duplicateRefusedBy }
        try { await duplicateHost.shutdown() } catch { /* the outcome owns it */ }
        rmSync(duplicatePatch, { force: true })

        assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
          'PA-09 the candidate artifact changed during the Web qualification')
        trace('t72-web-negative-controls', negatives)
      } finally {
        for (const client of webClients) {
          try { await client.dispose() } catch { /* best effort */ }
        }
        for (const host of webHosts) {
          if (host.exited) continue
          try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
      }
      return { browser: browserCase }
    }
    const webQualification = await qualifyOfficialWebComposition()
    // A required Browser proof is met by the PASS verdict and nothing else: an
    // INCOMPLETE/FAILED qualification can never finish this lane successfully.
    assert(!REQUIRE_WEB_BROWSER || webQualification.browser === 'PASS',
      `PA-05 the required real-Browser qualification ended as ${String(webQualification.browser)}; only PASS qualifies this lane`)

    /**
     * M5-W PR-C (t74): the profile-owned Web startup preference and the `/web`
     * entry on REAL processes.
     *
     * PC-07  a default-Off Host serves no Web; the PREFERENCE is saved On through
     *        the REAL generated Client `settings` wire (a read-back proves the
     *        profile patch), the RUNNING Host is not changed, and a NEW Host
     *        process over the same profile auto-enables the roster before Ready;
     * PC-04/PC-06  a real Split TUI drives `/web → Enable Web` and the Host then
     *        serves the authenticated index while the TUI keeps working;
     * PC-05  the official authenticated URL is obtained through the real Client,
     *        exchanged for a cookie and followed to the served page — the URL and
     *        token are never emitted;
     * PC-08  a manual `/web Disable` keeps the TUI working, saving Off does not
     *        change the running Host, and the NEXT cold boot is default-off.
     */
    const qualifyWebAutostart = async () => {
      const autostartRoot = join(workDir, 'pr-c-autostart')
      mkdirSync(autostartRoot, { recursive: true, mode: 0o700 })
      chmodSync(autostartRoot, 0o700)
      const hosts = []
      const clients = []
      const peers = []
      const rowStates = ready => new Map(PR_A_WEB_ROWS.map(row => [row.id,
        (ready.entries ?? []).find(entry => entry.id === row.id)?.state]))
      /** No declared Web row is live (absent/state-4 are plainly off). */
      const assertFullyOff = (ready, label) => {
        const live = [...rowStates(ready)]
          .filter(([, state]) => state !== 'absent' && state !== 'state-4')
          .map(([id, state]) => `${id}:${state ?? 'missing'}`)
        assert(live.length === 0, `${label}: these Web rows are not plainly off: ${live.join(',')}`)
      }
      /** Every declared Web row is ACTIVE except the ONE allowed pending row. */
      const assertFullyOn = (ready, label) => {
        const notActive = [...rowStates(ready)]
          .filter(([id, state]) => id !== 'ui-deliverables' && state !== 'active')
          .map(([id, state]) => `${id}:${state ?? 'missing'}`)
        assert(notActive.length === 0, `${label}: these Web rows are not active: ${notActive.join(',')}`)
      }
      /** The ordinary HTTP facts of a Host with no served frontend. */
      const assertHttpOff = async (origin, label) => {
        const root = await fetchStatus(`${origin}/`)
        assert(root.status === 404, `${label}: GET / must be 404 with Web off, got ${root.status}`)
        const api = await fetchStatus(`${origin}/api`)
        assert(api.status === 401, `${label}: unauthenticated /api must stay 401, got ${api.status}`)
        return { root: root.status, api: api.status }
      }
      const assertServing = async (origin, launch, label) => {
        const facts = await readHostWebIndex(origin, launch, label)
        assertWebIndexQualified(facts, label, targetDshVersion)
        assert(facts.index.status === 200 && facts.graph !== undefined,
          `${label}: the authenticated Web index is not served (HTTP ${facts.index.status})`)
        const sse = await sseProbe(origin, '/plugins/events')
        assert(sse.status === 200 && sse.contentType.startsWith('text/event-stream'),
          `${label}: /plugins/events is not a live stream (${sse.status})`)
        return { index: facts.index.status, graphEntries: facts.graph.entries.length, sse: sse.status }
      }
      const startHost = async label => {
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const host = new EntryProcess('host', entries.host, { ...base })
        hosts.push(host)
        const ready = await host.waitFor(record => record.m4a0 === 'ready', `${label} Host ready`, 240_000)
        return { host, ready }
      }
      const startPeer = async label => {
        const peer = new EntryProcess('peer', entries.client, {
          ...base,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
        })
        peers.push(peer)
        await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
        return peer
      }
      const startTui = async label => {
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        const tui = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        clients.push(tui)
        const ready = await tui.waitFor(record => record.m4a0 === 'ready', `${label} TUI ready`, 180_000)
        assert(ready.surfaceMounted === true && ready.transport === 'connected',
          `${label}: the real Split TUI did not mount its surface`)
        return tui
      }
      const webAccess = async (peer, label, value) => {
        const requestId = `prc-${++statusSequence}`
        peer.send({
          op: 'qualification-web-access',
          requestId,
          ...(value === undefined ? {} : { webAccessEnabled: value }),
        })
        return peer.waitFor(entry => entry.op === 'web-access' && entry.requestId === requestId,
          `${label} web-access`, 300_000)
      }
      const assertToggle = (record, expected, label) => {
        assert(record.ok === true, `${label}: the private Web access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
        assert(record.status?.state === expected,
          `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
      }
      const webPreference = async (peer, label, value) => {
        const requestId = `prc-pref-${++statusSequence}`
        peer.send({
          op: 'qualification-web-autostart',
          requestId,
          ...(value === undefined ? {} : { webAutoStart: value }),
        })
        return peer.waitFor(entry => entry.op === 'web-autostart' && entry.requestId === requestId,
          `${label} web-autostart`, 120_000)
      }
      const webAccessUrl = async (peer, label) => {
        const requestId = `prc-url-${++statusSequence}`
        peer.send({ op: 'qualification-web-access-url', requestId })
        return peer.waitFor(entry => entry.op === 'web-access-url' && entry.requestId === requestId,
          `${label} web-access-url`, 120_000)
      }
      try {
        // ── A. Default-Off Host + save On through the real Remote settings ───
        const first = await startHost('PC-07 default-off')
        const origin = first.ready.localHost.origin
        assertFullyOff(first.ready, 'PC-07a')
        const offHttp = await assertHttpOff(origin, 'PC-07a')
        const firstPid = first.ready.pid
        const peer = await startPeer('PC-07')
        assertToggle(await webAccess(peer, 'PC-07a status', undefined), 'disabled', 'PC-07a getStatus')

        const beforeSave = await webPreference(peer, 'PC-07a read', undefined)
        assert(beforeSave.ok === true && beforeSave.autoStart === false && beforeSave.userOverridden === false,
          `PC-07 the default preference is ${JSON.stringify(beforeSave)}`)
        const savedOn = await webPreference(peer, 'PC-07 write On', true)
        assert(savedOn.ok === true && savedOn.autoStart === true && savedOn.userOverridden === true && savedOn.readBack === true,
          `PC-07 the preference write did not read back On: ${JSON.stringify(savedOn)}`)
        // Saving the preference must NOT change the running Host.
        assertToggle(await webAccess(peer, 'PC-07a after-save', undefined), 'disabled', 'PC-07a after-save')
        const stillOff = await assertHttpOff(origin, 'PC-07a after-save')
        trace('t74-web-preference-saved', {
          readBack: savedOn.autoStart,
          userOverridden: savedOn.userOverridden,
          runningHostStillOff: stillOff.root === 404,
          hostPid: firstPid,
        })

        // ── B. The real TUI `/web → Enable Web` serves the frontend (PC-04/06) ──
        const tui = await startTui('PC-06 TUI')
        tui.send('/web\r')
        await tui.waitForScreen('Status: disabled', 'PC-06 menu')
        // The overlay owns the keyboard: ONE arrow per chunk, and the selected
        // row's own description is the authoritative "the move landed" signal.
        tui.send('\u001b[B')
        await tui.waitForScreen('Start serving the official Web frontend', 'PC-06 Enable row')
        tui.send('\r')
        await tui.waitForScreen('Status: enabled', 'PC-06 enabled projection')
        const enabledStatus = await hostStatus(first.host)
        assertFullyOn(enabledStatus, 'PC-06 enabled')
        assert(enabledStatus.pid === firstPid, 'PC-06 the enable changed the Host process')
        const launch = readJson(join(dshHome, 'run', 'dsh-pi-tui', first.ready.localHost.scopeId, 'launch.json'))
        const serving = await assertServing(origin, launch, 'PC-06')
        // Close the menu (Esc) before the TUI receives ordinary input: the open
        // overlay owns the keyboard, so a prompt typed into it would only edit
        // the list's own search box.
        tui.send('\u001b')
        await tui.waitForScreenGone('Status: enabled', 'PC-06 menu closed')
        // The TUI keeps working on the serving Host.
        tui.send('pc-06 tui works\r')
        await tui.waitForScreen('pc-06 tui works', 'PC-06 TUI prompt')
        trace('t74-web-tui-enable', {
          index: serving.index,
          graphEntries: serving.graphEntries,
          sse: serving.sse,
          tuiPromptAccepted: true,
          sameHostProcess: true,
        })

        // ── C. The official authenticated URL (PC-05) ───────────────────────
        const link = await webAccessUrl(peer, 'PC-05')
        assert(link.ok === true, `PC-05 the authenticated URL call failed: ${JSON.stringify(link.errorCode ?? null)}`)
        assert(link.loopback === true && link.protocol === 'http:' && link.pathname === '/',
          `PC-05 the launch URL is not the loopback Web root: ${JSON.stringify(link)}`)
        assert(link.tokenParams === 1 && link.paramNames?.length === 1 && link.paramNames[0] === 'token',
          `PC-05 the launch URL does not carry exactly the official token parameter: ${JSON.stringify(link)}`)
        assert(link.exchangeStatus >= 300 && link.exchangeStatus < 400,
          `PC-05 the launch URL was not exchanged for a cookie (HTTP ${String(link.exchangeStatus)})`)
        assert(link.pageStatus === 200 && link.pageBytes > 1024,
          `PC-05 the cookie did not reach the served page (HTTP ${String(link.pageStatus)}, ${String(link.pageBytes)} bytes)`)
        assert(!('url' in link) && !('token' in link), 'PC-05 the URL/token leaked into a record')
        // Copy Link through the SAME real TUI menu (enabled projection): rows are
        // status -> Open Browser -> Copy Link, so two Downs then Enter. Only the
        // clipboard acknowledgement may be painted.
        tui.send('/web\r')
        await tui.waitForScreen('Status: enabled', 'PC-05 menu')
        tui.send('\u001b[B')
        await tui.waitForScreen('Request the OS to open the official Web home page', 'PC-05 Open Browser row')
        tui.send('\u001b[B')
        await tui.waitForScreen('Copy the authenticated Web home link to the clipboard', 'PC-05 Copy Link row')
        tui.send('\r')
        // The copy result is painted INSIDE the open menu (the overlay covers the
        // base notice line at the smoke's PTY height).
        await tui.waitForScreen('Link copied', 'PC-05 copy acknowledgement')
        const copyScreen = (await tui.viewport()).join('\n')
        assert(!copyScreen.includes('token='), 'PC-05 the launch URL/token was painted by Copy Link')
        assert(copyScreen.includes('Link copied'), 'PC-05 the copy acknowledgement disappeared')
        trace('t74-web-authenticated-url', {
          exchangeStatus: link.exchangeStatus,
          pageStatus: link.pageStatus,
          pageBytes: link.pageBytes,
          tokenParameter: link.tokenParams,
          urlEmitted: false,
          copyAcknowledged: true,
        })

        // ── D. Manual `/web Disable` keeps the TUI working (PC-08) ──────────
        // Continue in the SAME menu the copy settled on: rows are status ->
        // copy result -> Open -> Copy -> Disable (the notice row is a disabled
        // fact but still a cursor stop). One arrow per chunk, each move proven
        // by the row's own selected description.
        tui.send('\u001b[B')
        await tui.waitForScreen('Action result.', 'PC-08 copy result row')
        tui.send('\u001b[B')
        await tui.waitForScreen('Request the OS to open the official Web home page', 'PC-08 Open Browser row')
        tui.send('\u001b[B')
        await tui.waitForScreen('Copy the authenticated Web home link to the clipboard', 'PC-08 Copy Link row')
        tui.send('\u001b[B')
        await tui.waitForScreen('Stop serving the official Web frontend', 'PC-08 Disable row')
        tui.send('\r')
        await tui.waitForScreen('Status: disabled', 'PC-08 disable')
        const disabledStatus = await hostStatus(first.host)
        assertFullyOff(disabledStatus, 'PC-08 manual disable')
        assert(disabledStatus.pid === firstPid, 'PC-08 the disable changed the Host process')
        await assertHttpOff(origin, 'PC-08 manual disable')
        tui.send('\u001b')
        await tui.waitForScreenGone('Status: disabled', 'PC-08 menu closed')
        tui.send('pc-08 after disable\r')
        await tui.waitForScreen('pc-08 after disable', 'PC-08 TUI prompt after disable')
        // Saving Off does not change the running Host's FINAL Web state. The
        // official Settings write reconciles/recomposes the profile and briefly
        // re-applies the overlay's disabled rows; the Host service restores its
        // live target after the official `app-boot/config-reload`. Owner-agreed
        // semantics: the FINAL state is preserved, a brief browser disconnect is
        // allowed. Wait for the final state, never poll-as-success without a bound.
        const savedOff = await webPreference(peer, 'PC-08 write Off', false)
        assert(savedOff.ok === true && savedOff.autoStart === false && savedOff.readBack === true,
          `PC-08 the Off write did not read back: ${JSON.stringify(savedOff)}`)
        assertToggle(await webAccess(peer, 'PC-08 re-enable', true), 'enabled', 'PC-08 re-enable')
        const enabledBeforeSaves = await hostStatus(first.host)
        assert(enabledBeforeSaves.pid === firstPid, 'PC-08 the re-enable changed the Host process')

        /** Wait for the post-recomposition repair to reach the FINAL target. */
        const awaitFinalWebState = async (label, expected) => {
          const deadline = Date.now() + 60_000
          let state = 'unknown'
          while (Date.now() < deadline) {
            const record = await webAccess(peer, `${label} status`, undefined)
            assert(record.ok === true, `${label}: the Web status call failed: ${JSON.stringify(record.errorCode ?? null)}`)
            state = record.status?.state
            if (state === expected) return record.status
            // A recomposition window legitimately shows disabled/changing; any
            // other state (`unavailable`) is a real failure, not a wait.
            if (state !== 'disabled' && state !== 'changing') break
            await sleep(250)
          }
          assert(false, `${label}: the running Host never returned to ${expected} (last ${JSON.stringify(state)})`)
        }
        // 1) Saving the SAME value (no value change) must preserve the final state.
        const sameValueOff = await webPreference(peer, 'PC-08 same-value Off save', false)
        assert(sameValueOff.ok === true && sameValueOff.autoStart === false && sameValueOff.readBack === true,
          `PC-08 the same-value Off save did not read back: ${JSON.stringify(sameValueOff)}`)
        await awaitFinalWebState('PC-08 same-value Off save', 'enabled')
        // 2) Saving a CHANGED value (On) must preserve it too.
        const changedOn = await webPreference(peer, 'PC-08 changed On save', true)
        assert(changedOn.ok === true && changedOn.autoStart === true && changedOn.readBack === true,
          `PC-08 the changed On save did not read back: ${JSON.stringify(changedOn)}`)
        await awaitFinalWebState('PC-08 changed On save', 'enabled')
        // 3) The FINAL save returns the preference to Off for the next cold boot,
        //    and the running Host still ends enabled.
        const finalOff = await webPreference(peer, 'PC-08 final Off save', false)
        assert(finalOff.ok === true && finalOff.autoStart === false && finalOff.readBack === true,
          `PC-08 the final Off save did not read back: ${JSON.stringify(finalOff)}`)
        await awaitFinalWebState('PC-08 final Off save', 'enabled')
        const afterSaves = await hostStatus(first.host)
        assert(afterSaves.pid === firstPid, 'PC-08 a settings save replaced the Host process')
        assertFullyOn(afterSaves, 'PC-08 after preference saves')
        const savedLaunch = readJson(join(dshHome, 'run', 'dsh-pi-tui', first.ready.localHost.scopeId, 'launch.json'))
        const stillServing = await assertServing(origin, savedLaunch, 'PC-08 after preference saves')
        trace('t74-web-recompose-repair', {
          sameValueSave: 'final enabled',
          changedValueSave: 'final enabled',
          finalOffSave: 'final enabled',
          index: stillServing.index,
          graphEntries: stillServing.graphEntries,
          sameHostProcess: true,
          transientRecomposeAccepted: true,
        })
        tui.send('/exit\r')
        assert((await tui.waitForExit(60_000)).code === 0, 'PC-08 the TUI did not exit normally')
        assert((await peer.shutdown()).code === 0, 'PC-08 the peer did not stop')
        assert((await first.host.shutdown()).code === 0, 'PC-08 the first Host did not stop')

        // ── E. The NEXT cold boot applies the (now Off) preference ──────────
        const second = await startHost('PC-08 next cold boot')
        assertFullyOff(second.ready, 'PC-08 next cold boot')
        assert(second.ready.pid !== firstPid, 'PC-08 the next Host must be a NEW process')
        await assertHttpOff(second.ready.localHost.origin, 'PC-08 next cold boot')
        trace('t74-web-autostart-next-boot-off', {
          hostPid: second.ready.pid,
          previousHostPid: firstPid,
          webRowsLive: 0,
          preferenceApplied: 'off',
        })
        assert((await second.host.shutdown()).code === 0, 'PC-08 the second Host did not stop')

        // ── F. Save On, stop, and prove the NEXT Host auto-starts (PC-07) ───
        const third = await startHost('PC-07 preference-off')
        assertFullyOff(third.ready, 'PC-07b')
        const thirdPid = third.ready.pid
        const peer2 = await startPeer('PC-07b')
        const onAgain = await webPreference(peer2, 'PC-07b write On', true)
        assert(onAgain.ok === true && onAgain.autoStart === true, 'PC-07 the second On write did not settle')
        assertToggle(await webAccess(peer2, 'PC-07b after-save', undefined), 'disabled',
          'PC-07 saving On enabled the running Host')
        await peer2.shutdown()
        assert((await third.host.shutdown()).code === 0, 'PC-07 the third Host did not stop')

        const autostarted = await startHost('PC-07 auto-start')
        assert(autostarted.ready.pid !== thirdPid, 'PC-07 the auto-start Host must be a NEW process')
        assertFullyOn(autostarted.ready, 'PC-07 auto-start')
        assert(autostarted.host.records.some(record => record.m4a0 === 'web-autostart' && record.status === 'enabled'),
          'PC-07 the Host did not record the applied auto-start')
        const autoLaunch = readJson(join(dshHome, 'run', 'dsh-pi-tui', autostarted.ready.localHost.scopeId, 'launch.json'))
        const autoServing = await assertServing(autostarted.ready.localHost.origin, autoLaunch, 'PC-07 auto-start')
        // A real TUI + Agent turn on the auto-started Host.
        const tui2 = await startTui('PC-07 TUI')
        tui2.send('pc-07 autostart turn\r')
        await tui2.waitForScreen('pc-07 autostart turn', 'PC-07 TUI prompt')
        await tui2.waitForScreen('stub answer', 'PC-07 Agent answer')
        tui2.send('/exit\r')
        assert((await tui2.waitForExit(60_000)).code === 0, 'PC-07 the TUI did not exit normally')
        assert((await autostarted.host.shutdown()).code === 0, 'PC-07 the auto-start Host did not stop')
        trace('t74-web-autostart', {
          previousHostPid: thirdPid,
          hostPid: autostarted.ready.pid,
          rowsActiveBeforeReady: [...rowStates(autostarted.ready)]
            .filter(([, state]) => state === 'active').length,
          autostartRecord: 'web-autostart enabled before ready',
          index: autoServing.index,
          graphEntries: autoServing.graphEntries,
          sse: autoServing.sse,
          tuiAgentTurn: 'accepted and answered',
          hiddenSameProcessRemount: false,
        })
        return { verified: true }
      } finally {
        for (const client of clients) {
          try { await client.dispose() } catch { /* best effort */ }
        }
        for (const peer of peers) {
          if (peer.exited) continue
          try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
        for (const host of hosts) {
          if (host.exited) continue
          try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
      }
    }

    /**
     * M5-W PR-B (t73): the official Web frontend runtime toggle on ONE Host.
     *
     * PB-01  an ordinary default-off Host serves no SPA root and no `/plugins`
     *        graph while the real TUI and the authenticated Peer work;
     * PB-02  `setEnabled(true)` mounts exactly the 59 declared rows (the one
     *        allowed PENDING row recorded) and serves the authenticated index;
     * PB-04/06  `setEnabled(false)` withdraws the SPA fallback and unloads the
     *        whole Web roster while the attached TUI keeps its Session, finishes
     *        an ALREADY ACCEPTED held Turn and accepts a new Prompt;
     * PB-07  a second `setEnabled(true)` on the SAME Host serves the graph again
     *        and a real Chromium run starts, authenticates and completes a Turn;
     * PB-10  the toggle never persisted: the same Host's next state is the
     *        second `setEnabled(false)`, and the installed profile patch is
     *        byte-identical before and after;
     * PB-08/09  the negative lanes (missing official Web asset, duplicate module
     *        owner, malformed wire argument) refuse instead of serving a partial
     *        Web surface.
     */
    const qualifyWebRuntimeToggle = async () => {
      const toggleRoot = join(workDir, 'pr-b-toggle')
      mkdirSync(toggleRoot, { recursive: true, mode: 0o700 })
      chmodSync(toggleRoot, 0o700)
      const hosts = []
      const clients = []
      const peers = []
      /** The durable Host owners whose fiber identity must never change. */
      const PROTECTED_OWNER_KEYS = [
        'connection', 'apiRemotes', 'typertGateway', 'workspaceRegistry', 'workspaceController',
        'sessionController', 'fileUpload', 'settingsController', 'jobController', 'piTuiHostRuntime',
      ]
      /** `id -> live Loader fiber UID` for EVERY row the Host status reports. */
      const rowUids = ready => Object.fromEntries((ready.entries ?? [])
        .filter(entry => typeof entry.fiberUid === 'number')
        .map(entry => [entry.id, entry.fiberUid]))
      /** `id -> Loader state label` for the frozen Web roster. */
      const webStates = ready => new Map(PR_A_WEB_ROWS.map(row => [row.id, {
        state: (ready.entries ?? []).find(entry => entry.id === row.id)?.state,
        present: (ready.entries ?? []).some(entry => entry.id === row.id),
      }.state]))
      const assertProtectedOwners = (ready, label) => {
        for (const owner of PROTECTED_OWNER_KEYS) {
          assert(ready.ownerEntries?.[owner]?.length === 1,
            `${label}: the ${owner} owner count is ${JSON.stringify(ready.ownerEntries?.[owner])}, expected exactly one`)
        }
        assert(ready.webServer?.host === '127.0.0.1' && typeof ready.webServer?.port === 'number' && ready.webServer.port > 0,
          `${label}: the ONE loopback listener is not a bound 127.0.0.1 port (${JSON.stringify(ready.webServer)})`)
        assert(ready.services?.piTuiWebAccess === true,
          `${label}: the private Web access service is not part of the Host readiness record`)
      }
      /**
       * Every declared Web row is plainly OFF. `absent` is a row that never
       * mounted on this cold boot; `state-4` is the DISPOSED fiber a row keeps
       * after a toggle unloaded it. Anything else is a live Web graph.
       */
      const assertWebFullyOff = (ready, label) => {
        const live = [...webStates(ready)]
          .filter(([, state]) => state !== 'absent' && state !== 'state-4')
          .map(([id, state]) => `${id}:${state ?? 'missing'}`)
        assert(live.length === 0, `${label}: these Web rows are not plainly disabled: ${live.join(',')}`)
        assert((ready.entries ?? []).filter(entry => entry.name === PR_A_CLIENT_MODULES_PACKAGE && entry.state === 'active').length === 0,
          `${label}: an official Web module graph owner is active with Web off`)
      }
      /** Every Web row is ACTIVE except the ONE allowed PENDING row. */
      const assertWebFullyOn = (ready, label) => {
        const states = webStates(ready)
        const missing = [...states].filter(([, state]) => state === undefined).map(([id]) => id)
        assert(missing.length === 0, `${label}: the Web roster is not declared: ${missing.join(',')}`)
        const notActive = [...states]
          .filter(([id, state]) => id !== 'ui-deliverables' && state !== 'active')
          .map(([id, state]) => `${id}:${state}`)
        assert(notActive.length === 0, `${label}: these Web rows are not active: ${notActive.join(',')}`)
        return states
      }
      /** The Host's own HTTP surface in the OFF state. */
      const assertWebOffHttp = async (origin, label) => {
        const root = await fetchStatus(`${origin}/`)
        const plugin = await fetchStatus(`${origin}/plugins/@deepseek-ai/dsh-client-ui-theme/client.js`)
        const sse = await sseProbe(origin, '/plugins/events')
        const api = await fetchStatus(`${origin}/api`)
        const connect = await fetchStatus(`${origin}/connect`)
        assert(root.status === 404, `${label}: GET / must be 404 with Web off, got ${root.status}`)
        assert(plugin.status === 404, `${label}: a Web browser bundle must be 404 with Web off, got ${plugin.status}`)
        assert(!(sse.status === 200 && sse.contentType.startsWith('text/event-stream')),
          `${label}: the Web SSE channel is still live (${sse.status} ${sse.contentType})`)
        assert(api.status === 401, `${label}: unauthenticated /api must stay 401, got ${api.status}`)
        assert(connect.status === 401, `${label}: unfunded /connect must stay 401, got ${connect.status}`)
        return { root: root.status, plugin: plugin.status, sse: sse.status, api: api.status, connect: connect.status }
      }
      /** The authenticated Web index + module graph + SSE on a serving Host. */
      const assertWebServing = async (origin, launch, label) => {
        const facts = await readHostWebIndex(origin, launch, label)
        assertWebIndexQualified(facts, label, targetDshVersion)
        const graph = facts.graph
        const batches = []
        for (const batch of graph.batches) {
          const response = await fetchStatus(new URL(batch.url, `${origin}/`).href)
          batches.push({ phase: batch.phase, status: response.status, bytes: response.body.length })
          assert(response.status === 200, `${label}: the ${batch.phase} startup bundle returned HTTP ${response.status}`)
          assert(response.body.length > 1024, `${label}: the ${batch.phase} startup bundle is empty`)
        }
        const unknown = await fetchStatus(`${origin}/plugins/@deepseek-ai/dsh-client-does-not-exist/client.js`)
        assert(unknown.status === 404, `${label}: an unknown plugin id returned HTTP ${unknown.status}`)
        const sse = await sseProbe(origin, '/plugins/events')
        assert(sse.status === 200 && sse.contentType.startsWith('text/event-stream'),
          `${label}: /plugins/events is not a live event stream (${sse.status} ${sse.contentType})`)
        const frames = sse.chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
        assert(frames.length > 0, `${label}: /plugins/events pushed no data frame`)
        const first = JSON.parse(frames[0])
        assert(first.type === 'graph' && first.graph?.rev === graph.rev,
          `${label}: the SSE graph generation differs from the served index graph`)
        const cookie = await connectCookie(origin, launch)
        assert(cookie !== '', `${label}: the authenticated /connect minted no peer cookie`)
        return {
          exchange: facts.exchange.status,
          index: facts.index.status,
          graphEntries: graph.entries.length,
          graphBatches: batches,
          sse: sse.status,
          unknownPlugin: unknown.status,
          token: facts.token,
        }
      }
      const startPeer = async label => {
        const peer = new EntryProcess('peer', entries.client, {
          ...base,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
        })
        peers.push(peer)
        const peerReady = await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
        return { peer, peerReady }
      }
      /** One correlated `qualification-web-access` round trip on the live Peer. */
      const webAccess = async (peer, label, value) => {
        const requestId = `prb-${++statusSequence}`
        peer.send({
          op: 'qualification-web-access',
          requestId,
          ...(value === undefined ? {} : { webAccessEnabled: value }),
        })
        const record = await peer.waitFor(entry => entry.op === 'web-access' && entry.requestId === requestId,
          `${label} web-access`, 300_000)
        return record
      }
      /** Assert one toggle result is the reached state, never the requested one. */
      const assertToggle = (record, expected, label) => {
        assert(record.ok === true, `${label}: the private Web access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
        assert(record.status?.state === expected,
          `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
        return record.status
      }
      /** The durable Host prompt/answer of one Session, counted exactly once. */
      const waitDurableTurn = async (sessionId, marker, label) => {
        await waitForHostSessionEventAfter(dshHome, sessionId, 0,
          event => event.type === 'user/message' && JSON.stringify(event).includes(marker), `${label} user/message`, 180_000)
        await waitForHostSessionEventAfter(dshHome, sessionId, 0,
          event => event.type === 'turn/end', `${label} turn/end`, 180_000)
        const events = hostSessionEvents(dshHome, sessionId) ?? []
        const users = hostUserTexts(events).filter(text => text === marker).length
        assert(users === 1, `${label}: the Host committed the prompt ${users} times, expected exactly 1`)
        return events
      }
      // The isolated Host patch: the C1 long-turn model (so a real Turn can be
      // HELD across the toggle) plus the two isolated-fixture facts the official
      // Web UI needs. Both are row CONFIG on rows that stay disabled until the
      // toggle enables them — the patch never enables a Web row.
      const documentsDirectory = join(toggleRoot, 'documents')
      mkdirSync(documentsDirectory, { recursive: true, mode: 0o700 })
      chmodSync(documentsDirectory, 0o700)
      // The C1 fixture is written into the INSTALLED profile so its own
      // `@deepseek-ai/*` imports resolve exactly like a Host row's; the outer
      // C1 section's bindings are block-scoped there, so this lane builds the
      // fixture it owns from the launcher facts it can see.
      const c1Fixture = writeC1WorkFixture(join(dshHome, 'profiles', base.profile), toggleRoot)
      const hostPatch = join(toggleRoot, 'pr-b-host.patch.yml')
      writeFileSync(hostPatch, [
        readFileSync(c1Fixture.patchPath, 'utf8').trimEnd(),
        '- id: ui-settings-general',
        '  config:',
        `    welcomeNoticeVersion: '${PR_A_WELCOME_NOTICE_VERSION}'`,
        '- id: workspace-controller',
        '  config:',
        `    documentsDirectory: '${documentsDirectory}'`,
        '',
      ].join('\n'), { mode: 0o600 })
      chmodSync(hostPatch, 0o600)
      const longTurnBarrier = join(toggleRoot, 'long-turn.release')
      const workRoot = join(toggleRoot, 'work')
      mkdirSync(workRoot, { recursive: true, mode: 0o700 })
      chmodSync(workRoot, 0o700)
      // The installed profile's own patch: the file a persisted toggle would
      // have to write, and the one this lane proves byte-identical.
      const hostProfiles = { profilePath: join(dshHome, 'profiles', base.profile, 'cordis.patch.yml') }
      const profilePatchBefore = existsSync(hostProfiles.profilePath)
        ? readFileSync(hostProfiles.profilePath)
        : undefined
      const playwrightRoot = process.env.SPLIT_PROCESS_PLAYWRIGHT_ROOT
      /** The real Chromium verdict: only a completed driver run is a PASS. */
      let browserCase = 'NOT_RUN'
      const verdict = {}
      try {
        // ── A. Default-off Host (PB-01) ─────────────────────────────────────
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const host = new EntryProcess('host', entries.host, {
          ...base,
          env: {
            ...base.env,
            SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
            C1_SCENARIO: 'long-turn',
            C1_WORK_ROOT: workRoot,
            C1_HOLD_LONG_TURN: longTurnBarrier,
          },
        })
        hosts.push(host)
        const ready = await host.waitFor(record => record.m4a0 === 'ready', 'PR-B default-off Host ready', 240_000)
        const origin = ready.localHost.origin
        const launch = readJson(join(dshHome, 'run', 'dsh-pi-tui', ready.localHost.scopeId, 'launch.json'))
        assertWebFullyOff(ready, 'PB-01')
        assertProtectedOwners(ready, 'PB-01')
        const offHttp = await assertWebOffHttp(origin, 'PB-01')
        const protectedUids = rowUids(ready)
        const { peer } = await startPeer('PB-01')
        assertToggle(await webAccess(peer, 'PB-01', undefined), 'disabled', 'PB-01 getStatus')
        // A real Split TUI works on the default-off Host and owns Session T.
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        const tui = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        clients.push(tui)
        const tuiReady = await tui.waitFor(record => record.m4a0 === 'ready', 'PB-01 TUI ready', 180_000)
        assertClientHostFacts(tuiReady.host, ready.localHost, 'PB-01 TUI vs Host')
        assert(tuiReady.surfaceMounted === true && tuiReady.transport === 'connected',
          'PB-01 the default-off Host does not serve a real TUI surface')
        // The first real Turn is HELD and stays held across BOTH toggles: the
        // default-off HTTP surface, the Web enable and the Web disable are all
        // asserted while the Host is genuinely mid-Turn, and the barrier is
        // created exactly once, after the disable. Re-holding a second time
        // would race the agent's own follow-up step.
        // Session T is CREATED by this first prompt, so its durable log starts
        // empty; every witness below is counted from that empty baseline.
        const heldStart = 0
        tui.send('pr-b plain tui\r')
        await tui.waitForScreen('pr-b plain tui', 'PB-01 TUI prompt painted', 120_000)
        const plainHeld = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.userText.includes('pr-b plain tui'),
          'PB-01 held Turn', 120_000)
        assert(plainHeld.agentStatus === 'running',
          `PB-01 the Host Agent was ${JSON.stringify(plainHeld.agentStatus)} while the Turn was held`)
        const sessionT = (await waitForSurfaceStatus(tui,
          record => record.sessionOpen === true && typeof record.openSessionId === 'string',
          'PB-01 TUI Session')).openSessionId
        trace('t73-web-default-off', {
          webRowsDeclared: PR_A_WEB_ROWS.length,
          webRowsLive: 0,
          rootStatus: offHttp.root,
          pluginStatus: offHttp.plugin,
          sseStatus: offHttp.sse,
          apiStatus: offHttp.api,
          connectStatus: offHttp.connect,
          tuiSession: sessionT,
          tuiTurn: 'held (accepted and still running; settled after the disable)',
          webRowStates: 'absent (no Web row has ever mounted on this cold boot)',
          hostServices: ready.services?.piTuiWebAccess === true ? 'piTuiWebAccess live' : 'missing',
        })

        // ── B. Enable the official Web frontend (PB-02/PB-03) ───────────────
        assertToggle(await webAccess(peer, 'PB-02', true), 'enabled', 'PB-02 setEnabled(true)')
        const enabledStatus = await hostStatus(host)
        const enabledStates = assertWebFullyOn(enabledStatus, 'PB-02')
        assertProtectedOwners(enabledStatus, 'PB-02')
        assertIdentityFields(enabledStatus.localHost, ready.localHost, 'PB-02 Host identity')
        for (const id of ['web-runtime', 'modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller']) {
          assert(enabledStates.get(id) === 'active', `PB-02 the "${id}" row is ${enabledStates.get(id)}, not active`)
        }
        // `ui-deliverables` is the ONE row allowed to stay PENDING on its
        // `workspaceChanges` dependency; this stage does not mount it. Either
        // verdict is allowed, but WHICH one must be recorded, never assumed.
        const deliverablesState = enabledStates.get('ui-deliverables')
        assert(deliverablesState === 'state-0' || deliverablesState === 'active',
          `PB-02 the optional deliverables row is ${deliverablesState}; an optional Web feature may be pending or active, never silently broken`)
        // The shared Host owners keep their LIVE fiber: the toggle mounted the Web
        // rows and nothing else.
        const enabledUids = rowUids(enabledStatus)
        for (const id of ['agent', 'session', 'job-controller', 'typert-gateway', 'split-host-connection',
          'split-host-api-remotes', 'split-host-session-controller', 'split-host-pi-tui-runtime']) {
          assert(enabledUids[id] === protectedUids[id], `PB-05 the "${id}" Host owner was re-mounted by the Web enable`)
        }
        const serving = await assertWebServing(origin, launch, 'PB-03')
        assertProtectedOwners(await hostStatus(host), 'PB-03')
        trace('t73-web-enabled', {
          rowsActive: [...enabledStates].filter(([, state]) => state === 'active').length,
          rowsNotActive: [...enabledStates].filter(([, state]) => state !== 'active').map(([id, state]) => `${id}:${state}`),
          tokenExchange: serving.exchange,
          indexStatus: serving.index,
          graphEntries: serving.graphEntries,
          graphBatches: serving.graphBatches,
          sseStatus: serving.sse,
          unknownPluginStatus: serving.unknownPlugin,
          uiDeliverables: enabledStates.get('ui-deliverables'),
          hostOwnersRemounted: false,
        })

        // ── C. Disable while a real TUI holds an accepted Turn (PB-04/PB-05/PB-06) ──
        const tuiGeneration = lastSurfaceStatus(tui)?.generationId
        assert(typeof tuiGeneration === 'number', 'PB-05 the TUI published no transport generation to freeze')
        // The SAME accepted Turn is still in flight: it was held before the
        // enable and has not been released or cancelled since.
        const heldStillPending = readC1WorkEvents(workRoot).every(event =>
          event.kind !== 'long-turn-released' || event.sessionId !== sessionT)
        assert(heldStillPending, 'PB-05 the accepted Turn was released before the disable')
        await tui.waitForScreen('long-turn started', 'PB-06 the running Turn is painted', 120_000)
        assertToggle(await webAccess(peer, 'PB-04', false), 'disabled', 'PB-04 setEnabled(false)')
        const disabledStatus = await hostStatus(host)
        assertWebFullyOff(disabledStatus, 'PB-04')
        assertProtectedOwners(disabledStatus, 'PB-04')
        assertIdentityFields(disabledStatus.localHost, ready.localHost, 'PB-04 Host identity')
        const disabledUids = rowUids(disabledStatus)
        for (const id of ['agent', 'session', 'job-controller', 'typert-gateway', 'split-host-connection',
          'split-host-api-remotes', 'split-host-session-controller', 'split-host-pi-tui-runtime']) {
          assert(disabledUids[id] === protectedUids[id], `PB-05 the "${id}" Host owner changed identity across the disable`)
        }
        const offAfterDisable = await assertWebOffHttp(origin, 'PB-04')
        const tuiStillOn = await waitForSurfaceStatus(tui,
          record => record.sessionOpen === true && record.openSessionId === sessionT && record.transport === 'connected',
          'PB-04 the TUI kept its Session')
        assert(tuiStillOn.generationId === tuiGeneration, 'PB-05 the TUI transport generation changed across the disable')
        // The accepted Turn was NOT cancelled: release it AFTER the disable and
        // read its settlement from the durable Host log and the TUI frame.
        writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })
        const settled = await waitForHostSessionEventAfter(dshHome, sessionT, heldStart,
          event => event.type === 'turn/end', 'PB-06 the held Turn settled after the disable', 180_000)
        assert(settled !== undefined, 'PB-05 the accepted Turn produced no settlement')
        const settledEvents = hostSessionEvents(dshHome, sessionT) ?? []
        assert(hostUserTexts(settledEvents).filter(text => text === 'pr-b plain tui').length === 1,
          'PB-05 the accepted prompt was committed more than once across the toggle')
        assert(hostAssistantHasText(settledEvents, 'long-turn answer'),
          'PB-05 the Host persisted no assistant answer after the disable')
        // The answer's own attempt number comes from the durable Host log, never
        // from a guess: the frame must show the answer the Host committed.
        const answerPrefix = events => {
          const answer = events.find(event => event.type === 'assistant/message')
          const prefix = /long-turn answer \d+/u.exec(JSON.stringify(answer?.data ?? ''))?.[0]
          assert(prefix !== undefined, 'PB-06 the durable answer carries no attempt prefix')
          return prefix
        }
        const heldAnswer = answerPrefix(settledEvents.slice(heldStart))
        await tui.waitForScreen(heldAnswer, 'PB-06 the TUI painted the answer after the disable', 180_000)
        // The same TUI Session accepts a NEW prompt with Web still off.
        const afterDisableStart = (hostSessionEvents(dshHome, sessionT) ?? []).length
        tui.send('pr-b after disable\r')
        await tui.waitForScreen('pr-b after disable', 'PB-06 the TUI prompt painted with Web off', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionT, afterDisableStart,
          event => event.type === 'user/message' && JSON.stringify(event).includes('pr-b after disable'),
          'PB-06 the Host accepted a new prompt with Web off', 180_000)
        await waitForHostSessionEventAfter(dshHome, sessionT, afterDisableStart,
          event => event.type === 'turn/end', 'PB-06 the post-disable Turn settled', 180_000)
        const postDisableAnswer = answerPrefix((hostSessionEvents(dshHome, sessionT) ?? []).slice(afterDisableStart))
        await tui.waitForScreen(postDisableAnswer, 'PB-06 the TUI painted the post-disable answer', 180_000)
        trace('t73-web-disabled-live', {
          webRowsLive: 0,
          webRowStates: 'state-4 (every Web row DISPOSED by the toggle)',
          rootStatus: offAfterDisable.root,
          pluginStatus: offAfterDisable.plugin,
          sseStatus: offAfterDisable.sse,
          apiStatus: offAfterDisable.api,
          connectStatus: offAfterDisable.connect,
          tuiSessionRetained: sessionT,
          tuiGenerationUnchanged: true,
          acceptedTurnSettled: true,
          postDisablePrompt: 'answered',
          hostOwnersRemounted: false,
        })

        // ── D. Enable again on the SAME Host (PB-07) ────────────────────────
        assertToggle(await webAccess(peer, 'PB-07', true), 'enabled', 'PB-07 setEnabled(true) again')
        const reenabledStatus = await hostStatus(host)
        assertWebFullyOn(reenabledStatus, 'PB-07')
        assertProtectedOwners(reenabledStatus, 'PB-07')
        assertIdentityFields(reenabledStatus.localHost, ready.localHost, 'PB-07 Host identity')
        const reenabledUids = rowUids(reenabledStatus)
        for (const id of ['agent', 'session', 'job-controller', 'typert-gateway', 'split-host-connection',
          'split-host-api-remotes', 'split-host-session-controller', 'split-host-pi-tui-runtime']) {
          assert(reenabledUids[id] === protectedUids[id], `PB-07 the "${id}" Host owner changed identity across the re-enable`)
        }
        const servingAgain = await assertWebServing(origin, launch, 'PB-07')
        // The real Chromium run: a NEW Browser Session on the SAME Host process.
        if (playwrightRoot === undefined || playwrightRoot === '') {
          assert(!REQUIRE_WEB_BROWSER,
            'PB-07 the real-Browser case is REQUIRED (SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1) but SPLIT_PROCESS_PLAYWRIGHT_ROOT names no pinned Playwright install; an HTTP-only run must never be accepted as the Browser proof')
          trace('t73-web-browser', {
            status: 'NOT_RUN',
            reason: 'SPLIT_PROCESS_PLAYWRIGHT_ROOT is not set; this run does NOT exercise a real Browser after the re-enable and does not claim it',
          })
        } else {
          const coordination = join(toggleRoot, 'browser')
          mkdirSync(coordination, { recursive: true, mode: 0o700 })
          chmodSync(coordination, 0o700)
          const marker = `pr-b browser ${randomUUID().slice(0, 8)}`
          const chromiumLibs = process.env.SPLIT_PROCESS_CHROMIUM_LIBS ?? join(playwrightRoot, 'libs', 'usr', 'lib', 'x86_64-linux-gnu')
          const browsers = process.env.SPLIT_PROCESS_PLAYWRIGHT_BROWSERS ?? join(playwrightRoot, 'browsers')
          const browserProcess = spawn(process.execPath, [
            join(SCRIPT_DIR, 'fixtures', 'pr-a-web-browser.mjs'),
            coordination,
            marker,
          ], {
            cwd: workDir,
            env: {
              ...env,
              PR_A_DSH_HOME: dshHome,
              PR_A_PLAYWRIGHT_ROOT: playwrightRoot,
              PR_A_EXPECTED_ANSWER_PREFIX: 'long-turn answer',
              PLAYWRIGHT_BROWSERS_PATH: browsers,
              LD_LIBRARY_PATH: `${chromiumLibs}${process.env.LD_LIBRARY_PATH === undefined ? '' : `:${process.env.LD_LIBRARY_PATH}`}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          })
          let browserOut = ''
          let browserErr = ''
          browserProcess.stdout.setEncoding('utf8')
          browserProcess.stdout.on('data', chunk => { browserOut += chunk })
          browserProcess.stderr.setEncoding('utf8')
          browserProcess.stderr.on('data', chunk => { browserErr += chunk })
          const browserExit = new Promise(resolveExit => browserProcess.on('close', (code, signal) => resolveExit({ code, signal })))
          const browserExitBounded = timeoutMs => browserDriverExitBounded(browserExit, timeoutMs, 'PR_B_BROWSER_EXIT_TIMEOUT')
          try {
            // The Browser Session file is a fact the DRIVER owns: a driver that
            // exited early can never write it, so the wait must fail with the
            // exit facts instead of burning its whole budget.
            await whileBrowserDriverRuns(
              browserExit,
              signal => waitForCondition(
                () => existsSync(join(coordination, 'browser-session.json')),
                'PR-B Browser Session creation', 240_000, signal,
              ),
              'PB-07',
              'the Browser Session file appeared',
            )
            const browserSession = readJson(join(coordination, 'browser-session.json')).sessionId
            assert(typeof browserSession === 'string' && browserSession !== '', 'PB-07 the Browser created no Host Session')
            // A REAL TUI attaches to the Browser's Session on the SAME Host, so
            // "the Browser Turn is visible to the TUI" is a real frame fact of a
            // Client that never typed the marker. The other TUI keeps owning
            // Session T for the continuity witnesses.
            await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
            const browserTui = new SurfaceEntryProcess(entries.client, {
              ...base,
              workDir,
              env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: browserSession },
            })
            clients.push(browserTui)
            const browserTuiReady = await browserTui.waitFor(record => record.m4a0 === 'ready', 'PB-07 Browser-Session TUI ready', 180_000)
            assertClientHostFacts(browserTuiReady.host, ready.localHost, 'PB-07 Browser-Session TUI vs Host')
            await waitForSurfaceStatus(browserTui,
              record => record.sessionOpen === true && record.openSessionId === browserSession,
              'PB-07 the TUI attached to the Browser Session')
            // The Browser's Turn answers immediately: this case proves the
            // re-enabled graph serves a REAL Browser, not a second held Turn.
            // The barrier is already present (phase C released the held Turn with
            // it); writing it again keeps this case independent of that ordering.
            writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })
            writeFileSync(join(coordination, 'browser-go'), `${Date.now()}\n`, { mode: 0o600 })
            const browserEvents = await waitDurableTurn(browserSession, marker, 'PB-07 Browser')
            await browserTui.waitForScreen(marker, 'PB-07 the TUI painted the Browser prompt', 180_000)
            const browserAnswer = events => {
              const answer = events.find(event => event.type === 'assistant/message')
              const prefix = /long-turn answer \d+/u.exec(JSON.stringify(answer?.data ?? ''))?.[0]
              assert(prefix !== undefined, 'PB-07 the durable Browser answer carries no attempt prefix')
              return prefix
            }
            await browserTui.waitForScreen(browserAnswer(browserEvents), 'PB-07 the TUI painted the Browser answer', 180_000)
            const browserResult = await browserExitBounded(180_000)
            const browserReport = readJson(join(coordination, 'browser-result.json'))
            assert(browserResult.code === 0,
              `PB-07 the real Chromium driver failed (exit ${JSON.stringify(browserResult.code)}/${String(browserResult.signal)}): ${redactWebQualificationText(browserReport.error ?? 'driver-failure', [servingAgain.token])}`)
            assert(browserReport.indexStatus === 200,
              `PB-07 the real Browser loaded no authenticated index (${browserReport.indexStatus})`)
            assert(browserReport.sessionId === browserSession, 'PB-07 the Browser reported a different Session')
            assert(browserReport.answerSeen === true, 'PB-07 the Browser never painted the Host answer')
            browserCase = 'PASS'
            verdict.browser = {
              indexStatus: browserReport.indexStatus,
              sessionId: browserSession,
              tuiPainted: [marker, browserAnswer(browserEvents)],
              hostTurn: 'complete',
              consoleErrors: browserReport.consoleErrors.length,
              screenshot: browserReport.screenshot,
            }
          } finally {
            try { process.kill(-browserProcess.pid, 'SIGKILL') } catch { /* already exited */ }
            const cleanupExit = await browserExitBounded(15_000)
            if (browserCase !== 'PASS') {
              browserCase = existsSync(join(coordination, 'browser-result.json')) ? 'FAILED' : 'INCOMPLETE'
              process.stderr.write(`PR_B_BROWSER_DIAGNOSTIC: ${redactWebQualificationText(
                `${browserErr} ${browserOut}`, [servingAgain.token],
              ).trim().split('\n').slice(-3).map(line => line.slice(0, 300)).join(' | ')}\n`)
            }
            trace('t73-web-browser-result', {
              status: browserCase,
              ...(verdict.browser ?? {}),
              driverExit: cleanupExit.code,
              driverSignal: cleanupExit.signal,
            })
          }
        }
        trace('t73-web-reenabled', {
          rowsActive: [...webStates(reenabledStatus)].filter(([, state]) => state === 'active').length,
          tokenExchange: servingAgain.exchange,
          indexStatus: servingAgain.index,
          graphEntries: servingAgain.graphEntries,
          sseStatus: servingAgain.sse,
          sameHostProcess: true,
          hostOwnersRemounted: false,
        })

        // ── E. Disable again and finish the official Host (PB-04/PB-10) ──────
        assertToggle(await webAccess(peer, 'PB-10', false), 'disabled', 'PB-10 setEnabled(false) again')
        const finalOff = await hostStatus(host)
        assertWebFullyOff(finalOff, 'PB-10')
        assertProtectedOwners(finalOff, 'PB-10')
        assertIdentityFields(finalOff.localHost, ready.localHost, 'PB-10 Host identity')
        const finalOffHttp = await assertWebOffHttp(origin, 'PB-10')
        // The toggle never persisted anything: the profile patch the Host booted
        // with is byte-identical, so the next cold boot is default-off again.
        const profilePatchAfter = existsSync(hostProfiles.profilePath)
          ? readFileSync(hostProfiles.profilePath)
          : undefined
        assert(profilePatchBefore === undefined
          ? profilePatchAfter === undefined
          : profilePatchAfter !== undefined && profilePatchAfter.equals(profilePatchBefore),
        'PB-10 the Web toggle wrote the profile patch')
        // The TUI is still usable after the second disable.
        tui.send('/exit\r')
        const tuiExit = await tui.waitForExit(60_000)
        assert(tuiExit.code === 0 && tuiExit.signal === null, `PB-10 TUI exit was ${JSON.stringify(tuiExit)}`)
        const hostShutdown = await host.shutdown()
        assert(hostShutdown.code === 0, `PB-10 official Host shutdown exit was ${JSON.stringify(hostShutdown)}`)
        trace('t73-web-toggle-final', {
          rootStatus: finalOffHttp.root,
          pluginStatus: finalOffHttp.plugin,
          sseStatus: finalOffHttp.sse,
          apiStatus: finalOffHttp.api,
          connectStatus: finalOffHttp.connect,
          tuiUsable: true,
          profilePatchUnchanged: true,
          hostShutdownExit: hostShutdown.code,
        })

        // ── F. Negative lanes: a partial Web surface is never served (PB-08/PB-09) ──
        const negatives = {}
        // (1) The official Web ASSET is missing. The plan's PB-09 disjunction is
        // "an intentionally unavailable Web asset/core module leads to
        // `unavailable`/error AND a non-served index". The official
        // `frontend-static` owner resolves its dist at REQUEST time (its own
        // contract), so the toggle CANNOT see a missing page during enable
        // without adding the request-time HTTP probe the plan forbids — the
        // serving half below is therefore the authentic witness here; lane (2)
        // proves the `unavailable`/error half for a CORE module. The dist is
        // restored byte for byte.
        const distIndex = join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
        const savedDist = saveFile(distIndex)
        const missingDist = `${distIndex}.missing-pr-b`
        try {
          renameSync(distIndex, missingDist)
          await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
          const absentHost = new EntryProcess('host', entries.host, {
            ...base,
            env: {
              ...base.env,
              SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
              C1_SCENARIO: 'long-turn',
              C1_WORK_ROOT: workRoot,
              C1_HOLD_LONG_TURN: longTurnBarrier,
            },
          })
          hosts.push(absentHost)
          const absentReady = await absentHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 dist-absent Host ready', 240_000)
          const { peer: absentPeer } = await startPeer('PB-09')
          const absentRecord = await webAccess(absentPeer, 'PB-09', true)
          assert(absentRecord.ok === true, `PB-09 the enable call itself failed: ${JSON.stringify(absentRecord.errorCode ?? null)}`)
          assert(absentRecord.status?.state === 'enabled' || absentRecord.status?.state === 'unavailable',
            `PB-09 a Host with NO official frontend dist reported ${JSON.stringify(absentRecord.status)}`)
          // The index chain is probed the ONLY way the official Web shell admits
          // a page: launch token -> 303 -> signed index cookie -> `/`. A mux
          // credential or an unauthenticated probe would only prove the
          // admission gate, never that a missing dist serves nothing.
          const absentLaunch = readJson(join(dshHome, 'run', 'dsh-pi-tui', absentReady.localHost.scopeId, 'launch.json'))
          const absentIndex = await readHostWebIndex(absentReady.localHost.origin, absentLaunch, 'PB-09')
          assert(!(absentIndex.index.status === 200 && absentIndex.hasModuleLoader),
            `PB-09 a Host whose official frontend dist is missing SERVED a DSH Web index (HTTP ${absentIndex.index.status})`)
          assert(absentIndex.graph === undefined,
            'PB-09 a Host whose official frontend dist is missing served a browser graph')
          // The plan's `unavailable` verdict belongs to a Web surface that cannot
          // be COMPOSED; the official static owner resolves its dist per request,
          // so the enable can only be truthful about the mounted graph. Record
          // the verdict honestly and prove the serving half above.
          assert(absentRecord.status?.state === 'enabled' || absentRecord.status?.state === 'unavailable',
            `PB-09 unexpected verdict for a missing asset: ${JSON.stringify(absentRecord.status)}`)
          negatives.distAbsent = {
            reported: absentRecord.status?.state,
            tokenExchange: absentIndex.exchange.status,
            indexStatus: absentIndex.index.status,
            indexServed: absentIndex.index.status === 200 && absentIndex.hasModuleLoader,
            officialStaticOwnsRequestTimeRead: true,
          }
          try { await absentHost.shutdown() } catch { /* the outcome owns it */ }
        } finally {
          renameSync(missingDist, distIndex)
          assert(existsSync(distIndex) && readFileSync(distIndex).equals(savedDist.bytes),
            'PB-09 the official frontend dist was not restored byte for byte')
        }
        // (2) A CORE Web module cannot be imported: the enable must refuse with
        // `unavailable` and serve nothing. The installed module is restored byte
        // for byte.
        const modulesEntry = join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-client-modules/package.json')), 'lib', 'index.js')
        const savedModules = saveFile(modulesEntry)
        const missingModules = `${modulesEntry}.missing-pr-b`
        try {
          renameSync(modulesEntry, missingModules)
          await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
          const brokenModuleHost = new EntryProcess('host', entries.host, {
            ...base,
            env: {
              ...base.env,
              SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
              C1_SCENARIO: 'long-turn',
              C1_WORK_ROOT: workRoot,
              C1_HOLD_LONG_TURN: longTurnBarrier,
            },
          })
          hosts.push(brokenModuleHost)
          const brokenReady = await brokenModuleHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 broken-module Host ready', 240_000)
          const { peer: brokenPeer } = await startPeer('PB-09 broken module')
          const brokenRecord = await webAccess(brokenPeer, 'PB-09', true)
          assert(brokenRecord.ok === true && brokenRecord.status?.state === 'unavailable',
            `PB-09 a Host whose core Web module cannot be imported reported ${JSON.stringify(brokenRecord.status)}`)
          assert(/fiber|module|import/iu.test(String(brokenRecord.status.reason ?? '')),
            `PB-09 the unavailable reason does not name the failed mount: ${String(brokenRecord.status.reason ?? '')}`)
          const brokenIndex = await readHostWebIndex(brokenReady.localHost.origin,
            readJson(join(dshHome, 'run', 'dsh-pi-tui', brokenReady.localHost.scopeId, 'launch.json')), 'PB-09')
          assert(!(brokenIndex.index.status === 200 && brokenIndex.hasModuleLoader),
            `PB-09 the refused core module still served a DSH Web index (HTTP ${brokenIndex.index.status})`)
          const brokenActive = [...webStates(await hostStatus(brokenModuleHost))]
            .filter(([, state]) => state === 'active').map(([id]) => id)
          assert(brokenActive.length === 0,
            `PB-09 a refused enable left these Web rows mounted: ${brokenActive.join(',')}`)
          negatives.coreModuleUnavailable = {
            reported: brokenRecord.status?.state,
            indexStatus: brokenIndex.index.status,
            rowsLeftMounted: brokenActive.length,
          }
          try { await brokenModuleHost.shutdown() } catch { /* the outcome owns it */ }
        } finally {
          renameSync(missingModules, modulesEntry)
          assert(existsSync(modulesEntry) && readFileSync(modulesEntry).equals(savedModules.bytes),
            'PB-09 the official client-modules entry was not restored byte for byte')
        }
        // (2) A second owner of the same official Web package: the roster is
        // refused before any row is toggled.
        const duplicatePatch = join(toggleRoot, 'pr-b-duplicate-modules.patch.yml')
        writeFileSync(duplicatePatch, `${readFileSync(hostPatch, 'utf8').trimEnd()}\n- insert:\n    - id: modules-duplicate\n      name: '${PR_A_CLIENT_MODULES_PACKAGE}'\n      disabled: true\n`, { mode: 0o600 })
        chmodSync(duplicatePatch, 0o600)
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const duplicateHost = new EntryProcess('host', entries.host, {
          ...base,
          env: {
            ...base.env,
            SPLIT_PROCESS_EXTRA_PATCH: duplicatePatch,
            C1_SCENARIO: 'long-turn',
            C1_WORK_ROOT: workRoot,
            C1_HOLD_LONG_TURN: longTurnBarrier,
          },
        })
        hosts.push(duplicateHost)
        const duplicateReady = await duplicateHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 duplicate-modules Host ready', 240_000)
        const { peer: duplicatePeer } = await startPeer('PB-09 duplicate')
        const duplicateRecord = await webAccess(duplicatePeer, 'PB-09', true)
        assert(duplicateRecord.ok === true && duplicateRecord.status?.state === 'unavailable',
          `PB-09 a Host with a SECOND official module owner reported ${JSON.stringify(duplicateRecord.status)}`)
        assert(/second .*dsh-client-modules/u.test(String(duplicateRecord.status.reason ?? '')),
          `PB-09 the refusal did not name the duplicate owner: ${String(duplicateRecord.status.reason ?? '')}`)
        const duplicateRoot = await fetchStatus(`${duplicateReady.localHost.origin}/`)
        assert(duplicateRoot.status === 404, `PB-09 the refused duplicate composition served an index (HTTP ${duplicateRoot.status})`)
        negatives.duplicateModules = { reported: duplicateRecord.status?.state, rootStatus: duplicateRoot.status }
        try { await duplicateHost.shutdown() } catch { /* the outcome owns it */ }
        rmSync(duplicatePatch, { force: true })
        // (3) A malformed `enabled` is refused by the v2 Remote contract, not by
        // the control channel: the Host never runs a mutation for it.
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const contractHost = new EntryProcess('host', entries.host, {
          ...base,
          env: {
            ...base.env,
            SPLIT_PROCESS_EXTRA_PATCH: hostPatch,
            C1_SCENARIO: 'long-turn',
            C1_WORK_ROOT: workRoot,
            C1_HOLD_LONG_TURN: longTurnBarrier,
          },
        })
        hosts.push(contractHost)
        const contractReady = await contractHost.waitFor(record => record.m4a0 === 'ready', 'PB-09 contract Host ready', 240_000)
        const { peer: contractPeer } = await startPeer('PB-09 contract')
        const malformed = await webAccess(contractPeer, 'PB-09 malformed', 'yes')
        assert(malformed.ok === false, `PB-09 a malformed boolean was accepted: ${JSON.stringify(malformed)}`)
        assert(malformed.errorCode === 'gateway/input-invalid',
          `PB-09 the malformed argument was refused as ${String(malformed.errorCode)}, not by the v2 contract`)
        const contractRoot = await fetchStatus(`${contractReady.localHost.origin}/`)
        assert(contractRoot.status === 404, `PB-09 a refused mutation served an index (HTTP ${contractRoot.status})`)
        assertToggle(await webAccess(contractPeer, 'PB-09 after-refusal', undefined), 'disabled',
          'PB-09 the refused mutation must not change the Host state')
        negatives.malformedArgument = { code: malformed.errorCode, rootStatus: contractRoot.status }
        assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
          'PB-09 the candidate artifact changed during the Web toggle qualification')
        try { await contractHost.shutdown() } catch { /* the outcome owns it */ }
        trace('t73-web-negative-controls', negatives)
      } finally {
        for (const client of clients) {
          try { await client.dispose() } catch { /* best effort */ }
        }
        for (const peer of peers) {
          if (peer.exited) continue
          try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
        for (const host of hosts) {
          if (host.exited) continue
          try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
        }
        rmSync(longTurnBarrier, { force: true })
      }
      return { browser: browserCase }
    }

    const toggleQualification = await qualifyWebRuntimeToggle()
    assert(!REQUIRE_WEB_BROWSER || toggleQualification.browser === 'PASS',
      `PB-07 the required real-Browser qualification ended as ${String(toggleQualification.browser)}; only PASS qualifies this lane`)
    // M5-W PR-C (t74): the profile-owned startup preference on REAL processes.
    const autostartQualification = await qualifyWebAutostart()
    assert(autostartQualification.verified === true, 't74 the Web startup preference qualification did not complete')
    // M5-W PR-D (t75): the ONLY product Browser x real Split TUI qualification.
    // A run without the require flag reports NOT_RUN and never claims it.
    const productQualification = await qualifyWebProduct({
      workDir,
      dshHome,
      scopeSuffix,
      base,
      entries,
      profilePackage,
      tarball,
      candidateSha256,
      targetDshVersion,
      env,
    })
    assert(productQualification.status === 'NOT_RUN' || productQualification.browserSubset === 'PASS',
      `t75 the product Browser×TUI subset ended as ${String(productQualification.browserSubset ?? productQualification.status)}`)

    // T18: installed package shape is already checked above; Direct `--help`
    // and the role-only negative control ran before any Host existed.
    assert(manifest.dependencies?.ws === '8.21.3', 'T18 ws runtime dependency missing')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-host'), 'T18 public Host entry appeared')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-client'), 'T18 public Client entry appeared')
    trace('t18', { packageShape: 'internal entries only', directHelp: 'pass', roleOnlyNegative: 'pass' })

    // T60: the REAL_SPLIT_PROCESS inventory is emitted only after every smoke
    // sub-check above (including T26a restored identity and T18 package shape)
    // has completed on the SAME candidate. The cross-lane release gates are
    // NOT claimed by this script; the stage-final lane records their verdict
    // separately before the overall T60 status is final.
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'T60 the candidate artifact changed during the split-process qualification')
    // The Web qualification is part of the inventory ONLY when it actually ran:
    // a lane without the pinned Playwright install reports NOT_RUN here and
    // never claims the real-Browser proof.
    const webBrowserVerdict = webQualification.browser
    trace('t60', {
      candidate: basename(tarball),
      sha256: candidateSha256,
      dshVersion: targetDshVersion,
      webComposition: webBrowserVerdict === 'PASS'
        ? 'PASS_OFFICIAL_WEB_COMPOSITION_REAL_BROWSER'
        : `NOT_RUN_OR_INCOMPLETE(${webBrowserVerdict})`,
      webBrowser: webBrowserVerdict,
      webRuntimeToggle: toggleQualification.browser === 'PASS'
        ? 'PASS_OFFICIAL_WEB_RUNTIME_TOGGLE_REAL_BROWSER'
        : `NOT_RUN_OR_INCOMPLETE(${toggleQualification.browser})`,
      webRuntimeToggleBrowser: toggleQualification.browser,
      webStartupPreference: autostartQualification.verified === true
        ? 'PASS_PROFILE_AUTOSTART_AND_WEB_ENTRY_REAL_PROCESSES'
        : 'NOT_VERIFIED',
      webProduct: productQualification.status === 'PASS'
        ? 'PASS_PRODUCT_BROWSER_X_REAL_TUI'
        : productQualification.browserSubset === 'PASS'
          ? 'BROWSER_SUBSET_PASS_WC12_DEFERRED_WITH_OWNER'
          : 'NOT_RUN_OR_INCOMPLETE',
      webProductStatus: productQualification.status,
      webProductBrowserSubset: productQualification.browserSubset,
      webProductWc: productQualification.wc,
      m4c1: 'PASS_REAL_SPLIT_PROCESS',
      m5b: 'pass (two REAL surface Clients retained ONE Session X; shared pending inbox + official Ctrl+S steer of the other Client\'s occurrence; two independent same-text submits stayed two; A -> Y navigation kept B writing X; B-only exit kept A/Host)',
      m5n: 'pass (NON-DESTRUCTIVE navigation: /new and /resume left a held-running Host Turn alive -> completed; a RUNNING target projected without an idle wait; already-current no-op; a Host-queued occurrence stayed with X across the Client\'s departure; explicit Busy Esc still aborted the exact Turn)',
      t44t48: 'pass',
      t49t55: 'pass (T49-T55, including detached pending UNKNOWN, real Gateway owner-stream eligibility, the old-peer protocol negatives and same-PID HMR pending question/approval)',
      t56t59: 'pass',
      t60Status: 'PASS_REAL_SPLIT_PROCESS: T01-T66 split-process inventory and T26a restored identity completed; release gates pending the stage-final lane verdict',
      // T61-T65 are the M4 closure-gap cases added on top of the frozen
      // T01-T60 inventory. They are listed explicitly so a later edit cannot
      // silently drop one while T60 still claims the full inventory.
      t61StaleGeneration: 'pass (real mux rollover, one stale write not dispatched, one new-generation commit)',
      t62ClientSigint: 'pass (business PID SIGINT -> exit 130, client resources released, Host identity kept)',
      t63KeyboardExit: 'pass (real PTY double Ctrl+C and double Ctrl+D, empty draft)',
      t64HostSighup: 'pass (process failure, no fabricated settlement, new Host instance on stale discovery)',
      t65HostSigkill: 'pass (attached Client, no fake success, no cross-Host view continuity, no replayed write)',
      t66UnknownWrite: 'pass (ACK-lost write committed once, committing Host killed, cold resume reads it exactly once)',
      t57t58HostRows: 'pass (every protected Host Loader row kept its live fiber UID across Client-only HMR)',
      t26aArtifactMissing: 'pass (current main real artifact-absent + restored authenticated identity)',
      t12PtyHup: 'pass (real PTY master close, separate case)',
      releaseGates: 'not run by this smoke; stage-final lane records the separate release-gate verdict',
    })

    console.log(`split-process authenticated-link + real-surface smoke passed — ${basename(tarball)} × DSH ${targetDshVersion} (incl. M5B-01 two real surfaces on one Session, M5N-01 non-destructive Split Remote navigation, M5N-02 fork/exit siblings and M5N-03 departing from a pending Host interaction); official Web composition ${webBrowserVerdict === 'PASS' ? 'PASS (real Browser)' : `NOT_QUALIFIED (${webBrowserVerdict})`}; official Web runtime toggle ${toggleQualification.browser === 'PASS' ? 'PASS (real Browser)' : `NOT_QUALIFIED (${toggleQualification.browser})`}; product Web × real TUI ${productQualification.status === 'PASS' ? 'PASS (real Browser + real PTY TUI)' : productQualification.browserSubset === 'PASS' ? `BROWSER SUBSET PASS; WC-12 ${productQualification.status} (Owner decision recorded)` : `NOT_RUN (${productQualification.status})`}`)
  } catch (error) {
    // Report BEFORE the cleanup below: the failure projection must read the
    // still-live process handles, and the work root must still exist while the
    // report is built. The original error is rethrown so the lane still fails.
    diagnostics.reportFailure(error, { processes: [...activeProcesses] })
    throw error
  } finally {
    // A failed assertion must not leave a live Host/Client probe behind; each
    // entry is its own process group leader (`detached: true`).
    for (const run of [...activeProcesses]) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    for (const [pid, starttime] of trackedProcesses) killTracked(pid, starttime, 'SIGKILL')
    if (dshHome !== undefined) killIsolatedProcesses(dshHome)
    if (FAILPOINT !== undefined && dshHome !== undefined) {
      // The failpoint proof reads this run's isolated scene: with no scene (a
      // setup failure before the root existed) there is nothing to prove.
      await proveFailpointCleanup(dshHome)
    }
    if (traceFd !== undefined) {
      closeSync(traceFd)
      traceFd = undefined
    }
    if (workDir === undefined) {
      // Nothing was created: setup failed before the work root existed.
    } else if (!KEEP) rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved split-process environment: ${workDir}`)
  }
}

/**
 * The qualification-only cleanup proof behind `SPLIT_PROCESS_SMOKE_FAIL_AFTER`.
 *
 * Both execution paths use it, and it never reports a Seat verdict it did not
 * check: the names come from the scope directories this run's profile actually
 * published under, and an early failure that created no scope directory reports
 * the check as unchecked instead of a fabricated `free`.
 */
async function proveFailpointCleanup(dshHome) {
  let leftovers = findIsolatedProcesses(dshHome)
  for (let attempt = 0; attempt < 100 && leftovers.length > 0; attempt += 1) {
    await sleep(50)
    killIsolatedProcesses(dshHome)
    leftovers = findIsolatedProcesses(dshHome)
  }
  const scopeRoot = join(dshHome, 'run', 'dsh-pi-tui')
  const scopeIds = existsSync(scopeRoot)
    ? readdirSync(scopeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    : []
  let seatsOk = true
  for (const scopeId of scopeIds) {
    // The Host seat and the qualification-only Client seat are the two kernel
    // names one scope can own; a real `surface` Client never binds the second.
    for (const seatName of [`\0dsh-pi-tui-h-${scopeId.slice(0, 40)}`, `\0dsh-pi-tui-c-${scopeId.slice(0, 40)}`]) {
      try {
        await seatFree(seatName, 15_000)
      } catch {
        // The verdict is the fact; the thrown seat text (an abstract socket name
        // derived from this run's scope) is not default output.
        seatsOk = false
        console.error(`FAILPOINT_SEAT_FAILURE seat=${boundedName(seatName)} the Seat stayed owned; see the preserved work root under KEEP`)
        break
      }
    }
    if (!seatsOk) break
  }
  const seats = scopeIds.length === 0 ? 'unchecked' : seatsOk ? 'free' : 'busy'
  console.error(`FAILPOINT_CLEANUP leftovers=${String(leftovers.length)} seats=${seats}`)
  if (leftovers.length > 0 || !seatsOk) process.exitCode = 1
  else console.error('FAILPOINT_CLEANUP_OK')
}

/**
 * Print the ONE registry-backed selectable listing (no tarball, no setup).
 *
 * The registry order IS the execution order a suite or the full lane follows,
 * so the listing prints it verbatim: sorting here would show a bootstrap order
 * that no real run performs.
 */
function printSelectableCases() {
  process.stdout.write('SPLIT_PROCESS_SELECTABLE_CASES scope=SELECTABLE_ONLY\n')
  for (const entry of listSelectableCases()) {
    process.stdout.write(`suite=${entry.suite} case=${entry.id} title=${entry.title}\n`)
  }
}

/**
 * Run ONLY the resolved registry cases in their own isolated installation.
 *
 * This path never calls the full `main()`: no T18, T08, T75 or Browser
 * scenario runs, and the result names the selectable scope only.
 */
async function runSelectedCases(selection) {
  let candidate
  try {
    // A required Browser qualification cannot be satisfied by this selectable
    // non-Browser set, and the whole-lane mutation mode is full-only: both are
    // rejected before any work root or install.
    if (process.env.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1' || process.env.SPLIT_PROCESS_REQUIRE_WEB_PRODUCT === '1') {
      throw new SplitSmokeInputError('INPUT_SMOKE_SELECTION_INVALID',
        'INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): '
        + 'a required Browser qualification cannot be satisfied by a selectable non-Browser case')
    }
    if (process.env.SPLIT_PROCESS_SMOKE_MUTATION !== undefined) {
      throw new SplitSmokeInputError('INPUT_SMOKE_SELECTION_INVALID',
        'INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): '
        + 'SPLIT_PROCESS_SMOKE_MUTATION is a full-lane control and cannot be used with --case or --suite')
    }
    candidate = inspectSplitCandidate(selection.candidate)
  } catch (error) {
    emitInputFailure({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', error })
    throw error
  }
  const { tarball, candidateSha256, targetDshVersion } = candidate
  diagnostics = createSmokeDiagnostics({
    lane: 'split-process',
    heading: 'SPLIT_PROCESS_SMOKE',
    marker: 'T',
    runtimeDshPin: targetDshVersion,
    artifacts: [smokeArtifactIdentity('candidate', candidate.manifest, candidateSha256)],
  })
  process.stderr.write(`${diagnostics.identityLine()}\n`)
  diagnostics.checkpoint('preflight/candidate-input')

  let workDir
  let dshHome
  try {
    workDir = mkdtempSync(join(tmpdir(), 'dsh-split-process-'))
    // The cleanup scans this exact DSH_HOME even when the profile installation
    // fails before returning: assign it before the install, not after.
    dshHome = join(workDir, 'dsh-home')
    const installation = createSplitSmokeProfile({ tarball, targetDshVersion, workDir })
    diagnostics.checkpoint('setup/profile-install')
    // The SAME context shape the full lane passes to a migrated case; a selected
    // case gets the ONE installation of this run and never expands its own set.
    const context = {
      installation,
      EntryProcess,
      SurfaceEntryProcess,
      entries: installation.entries,
      base: installation.base,
      workDir,
      dshHome,
      profilePackage: installation.profilePackage,
      tarball,
      candidateSha256,
      targetDshVersion,
      trace,
      failpoint,
      mode: 'selected',
      // Backstop only: the case kills its own detached processes first.
      trackDetachedPid: (pid, starttime) => trackedProcesses.set(pid, starttime),
    }
    const selected = []
    for (const selectedCase of selection.cases) {
      diagnostics.checkpoint(`case/${selectedCase.id}`)
      await selectedCase.run(context)
      selected.push(selectedCase.id)
    }
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'the candidate artifact changed during the selected qualification')
    for (const caseId of selected) process.stdout.write(`${selectedPassLine(caseId)}\n`)
  } catch (error) {
    // Report BEFORE the cleanup below: the failure projection must read the
    // still-live process handles, and the work root must still exist while the
    // report is built. The original error is rethrown so the lane still fails.
    diagnostics.reportFailure(error, { processes: [...activeProcesses] })
    throw error
  } finally {
    for (const run of [...activeProcesses]) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    // The backstop for detached processes a case created and registered: the
    // case's own `finally` already killed them, and a stale entry is a no-op.
    for (const [pid, starttime] of trackedProcesses) killTracked(pid, starttime, 'SIGKILL')
    if (dshHome !== undefined) killIsolatedProcesses(dshHome)
    if (FAILPOINT !== undefined && dshHome !== undefined) {
      // The failpoint proof reads this run's isolated scene: with no scene (a
      // setup failure before the root existed) there is nothing to prove.
      await proveFailpointCleanup(dshHome)
    }
    if (workDir === undefined) {
      // Nothing was created: setup failed before the work root existed.
    } else if (!KEEP) rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved split-process environment: ${workDir}`)
  }
}

/** Strict CLI dispatch: `--list`, the old full run, or one selected case set. */
async function runLane() {
  let selection
  try {
    selection = resolveSelection(parseSelectionArgs(process.argv.slice(2)))
  } catch (error) {
    // A selector error exists before any reporter: it leaves the ONE fixed
    // input projection and never a work root, an install or a process.
    emitInputFailure({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', error })
    throw error
  }
  if (selection.mode === 'list') {
    printSelectableCases()
    return
  }
  if (selection.mode === 'full') {
    await main(selection.candidate)
    return
  }
  await runSelectedCases(selection)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLane().catch(error => {
    // One concise final line: the fixed category and its stable code. The
    // structured report (written BEFORE the work root was deleted) owns the
    // safe diagnosis; an `Error.message` of any origin is never copied here.
    console.error(`SPLIT_PROCESS_SMOKE_FAILURE: ${safeFailureSummary(error)}`)
    // Forensics stay explicit: `KEEP` is the operator's own preserved-scene
    // mode, and this is the only path that prints the raw error text.
    if (KEEP) console.error(`SPLIT_PROCESS_SMOKE_FORENSICS: ${forensicErrorText(error)}`)
    process.exitCode = 1
  })
}
