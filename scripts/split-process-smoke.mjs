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
  hostSessionEvents,
  hostSessionLogCount,
  sha16,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from './lib/split-smoke-sessions.mjs'
import { ENTRY_ADMISSION_MUTATIONS } from './smoke/split-process/entry-admission.mjs'


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
 * Bounded wait for one qualification condition. A caller-owned `signal` stops
 * the polling loop for real: a race that only *returns* early would leave the
 * loop's own timer holding the process until the full budget.
 */
export async function waitForCondition (predicate, label, timeoutMs, signal) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted === true) {
      throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
        code: 'QUALIFICATION_CONDITION_ABORTED',
        waitLabel: label,
        elapsedMs: Date.now() - started,
      })
    }
    if (await predicate()) return true
    await sleep(100)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'QUALIFICATION_CONDITION_TIMEOUT',
    waitLabel: label,
    elapsedMs: Date.now() - started,
  })
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


/** The human-authored `user/message` texts of one persisted Host Session. */
function hostUserTexts(events) {
  return events
    .filter(event => event.type === 'user/message' && Array.isArray(event.data?.content))
    .map(event => event.data.content.map(part => typeof part?.text === 'string' ? part.text : '').join(''))
}

/** Whether the durable log carries one assistant message containing the text. */
function hostAssistantHasText(events, text) {
  return events.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes(text))
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

    // The four migrated cases run in the FROZEN registry order: the row-disabled
    // pilot, the two bootstrap negatives, then the whole authenticated-link
    // chain. The remaining inline Surface/M5/C1/Web blocks keep their historical
    // order below until PR2-B/C/D migrate them.
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
    const isolatedScopeId = publishedScopeIds[0]
    const scopeDir = join(publishedScopeRoot, isolatedScopeId)
    const scopeSuffix = isolatedScopeId.slice(0, 40)

    // ── Real-surface qualification (T27–T39) ─────────────────────────────
    // Everything above proves the authenticated control/data link. This
    // block starts a DEDICATED Host with the test-only offline LLM row and
    // drives the ONE real tty surface Client over the SAME authenticated Host:
    // create/open/switch Sessions and prove a real Host commit reaches the
    // painted transcript, then exit/kill/reconnect without touching the Host.
    // T34 (writer pre-dispatch stop), T35 post-write ACK drop and T36 (private
    // PiFile/terminal-progress business reads) run before the continuity cases.
    // WS-2: the Client launch directory (A) is a DIFFERENT real directory from
    // the Host Profile (B). The Host realpaths and registers A as the Session's
    // Workspace, so the private PiFile business reads (T36) now resolve in A:
    // `t36notes.md` is inside the official provider's search tree for that
    // Workspace, and `dist/` is a directory the OFFICIAL provider EXCLUDES while
    // the Host explicit-path scanner still serves it — that difference makes the
    // scoped witness discriminating. Both are created BEFORE the Host starts.
    const clientWorkspaceA = join(workDir, 'ws2-client-workspace-A')
    const clientWorkspaceC = join(workDir, 'ws2-client-workspace-C')
    // T09: the SECOND concurrently admitted real Surface Client gets its OWN
    // launch directory (B), so its Host Workspace is a different registered
    // path. Never reuse the WS-2 sequential Client C workspace: that would
    // change the persisted membership the later C scenario proves.
    const m5aWorkspaceB = join(workDir, 'm5a-client-workspace-B')
    mkdirSync(clientWorkspaceA, { recursive: true })
    mkdirSync(clientWorkspaceC, { recursive: true })
    mkdirSync(m5aWorkspaceB, { recursive: true })
    const canonicalClientWorkspaceA = realpathSync(clientWorkspaceA)
    const canonicalClientWorkspaceC = realpathSync(clientWorkspaceC)
    const canonicalM5aWorkspaceB = realpathSync(m5aWorkspaceB)
    // The SAME-NAMED marker in the Host Profile B carries different content: the
    // Host read must answer A's marker, never B's.
    writeFileSync(join(clientWorkspaceA, 'ws2-host-marker.txt'), 'client-workspace-A\n', { mode: 0o600 })
    writeFileSync(join(profileDir, 'ws2-host-marker.txt'), 'host-profile-B\n', { mode: 0o600 })
    writeFileSync(join(clientWorkspaceA, 't36notes.md'), 'private file reference\n', { mode: 0o600 })
    mkdirSync(join(clientWorkspaceA, 'dist'), { recursive: true })
    writeFileSync(join(clientWorkspaceA, 'dist', 't36only-scoped.js'), 'x\n', { mode: 0o600 })
    // The `~/` shorthand must expand to the HOST's home — the isolated home in
    // this lane, never the operator's. One known file there turns the absolute
    // answer into a real sink instead of a vacuous "some absolute path".
    writeFileSync(join(home, 't36home-note.md'), 'private home reference\n', { mode: 0o600 })
    const surfaceHost = new EntryProcess('host', entries.host, base)
    const surfaceHostReady = await surfaceHost.waitFor(record => record.m4a0 === 'ready', 'T27 surface Host ready', 180_000)
    const surfaceHostPid = surfaceHostReady.pid
    const surfaceHostFacts = surfaceHostReady.localHost
    assert(surfaceHostReady.entries?.some(entry => entry.id === 'm4b2s-stub-llm' && entry.state === 'active') === true,
      'T30 the test-only offline Host LLM row is not active')
    assert(surfaceHostReady.localHost?.hostPid === surfaceHostPid, 'T27 Host ready PID mismatch')
    const surfaceClients = []
    let surfaceHostClosed = false
    let sessionA
    let sessionB
    try {
      // T27/T28: ONE real surface over the SAME authenticated connection; sessionless
      // Welcome painted on the real pty, no JSON on the terminal.
      const c1 = new SurfaceEntryProcess(entries.client, {
        ...base,
        // WS-2: the REAL Client launch directory (A), distinct from the Host
        // Profile cwd (B) the Host process itself was started in.
        cwd: clientWorkspaceA,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF: '1' },
      })
      surfaceClients.push(c1)
      const c1Ready = await c1.waitFor(record => record.m4a0 === 'ready', 'T27 surface Client ready', 180_000)
      assert(c1Ready.processRole === 'client', 'T27 surface Client role mismatch')
      assert(c1Ready.pid !== surfaceHostPid, 'T27 the surface Client and the Host must be distinct OS PIDs')
      assert(c1Ready.surfaceMounted === true, 'T27 the physical surface did not mount')
      assert(c1Ready.sessionOpen === false, 'T28 a sessionless surface must not claim an open Session')
      assert(c1Ready.transport === 'connected' && c1Ready.sessionsListPhase === 'ready',
        'T27 the official Client Session list is not ready')
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(c1Ready.owners?.[owner] === 1, `T27 expected exactly one ${owner} owner`)
      }
      assert(c1Ready.privateNamespaces === 2, 'T27 expected exactly the two private pi-tui namespaces')
      assertClientHostFacts(c1Ready.host, surfaceHostFacts, 'T27 surface Client')
      await c1.waitForScreen('type a message to start a session', 'T28 sessionless Welcome')
      trace('t27-t28', {
        hostPid: c1Ready.host.hostPid,
        clientPid: c1Ready.pid,
        sessionOpen: false,
        owners: c1Ready.owners,
        privateNamespaces: c1Ready.privateNamespaces,
        welcome: 'painted',
      })

      // T29/T30: real input -> official beginSubmission -> Host commit ->
      // durable readback -> retained presentation (the stub answer is produced
      // by the Host's official LLM adapter, never by a Client fake).
      c1.send('session a\r')
      const openedA = await c1.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true,
        'T29 Session open',
        120_000,
      )
      assert(typeof openedA.openSessionId === 'string' && openedA.openSessionId.startsWith('session-'),
        'T29 no official Session id was opened')
      sessionA = openedA.openSessionId
      await c1.waitForScreen('session a', 'T29 user message')
      await c1.waitForScreen('stub answer', 'T30 assistant answer')
      // T30's durable half: the Host's authoritative session log must carry
      // exactly ONE accepted human write and the assistant message; the painted
      // echo alone is not accepted-write evidence.
      const durableA = await (async () => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const events = hostSessionEvents(dshHome, sessionA)
          if (events !== undefined) {
            const users = hostUserTexts(events).filter(message => message === 'session a').length
            const assistant = hostAssistantHasText(events, 'stub answer')
            if (users === 1 && assistant) return { users, assistant }
          }
          await sleep(100)
        }
        return undefined
      })()
      assert(durableA !== undefined,
        'T30 the Host durable log did not carry exactly one accepted "session a" write and its assistant message')
      // WS-2: the durable Host header cwd is the Host canonical form of the
      // Client launch directory — never the Host Profile the Host process runs in.
      const headerA = await waitForHostSessionHeader(dshHome, sessionA, 'T29 durable Host header')
      assert(headerA.cwd === canonicalClientWorkspaceA,
        `T29 the durable Session cwd must be the Host canonical launch directory: ${String(headerA.cwd)} != ${canonicalClientWorkspaceA}`)
      trace('t29-t30', {
        sessionId: sessionA,
        userMessage: 'painted',
        assistant: 'painted',
        hostUserMessages: durableA.users,
        hostAssistant: durableA.assistant,
        durableCwd: headerA.cwd,
        hostProfileCwd: realpathSync(profileDir),
        clientLaunchCwd: canonicalClientWorkspaceA,
      })

      // T09 (M5-A): a SECOND real Surface Client starts on its OWN PTY while A
      // is still live and connected. Both carry two different business PIDs,
      // mount their own surface and authenticate THE SAME Host Singleton
      // (same hostPid/starttime/instanceId/buildId). B opens its OWN Session in
      // its OWN Host Workspace; A's Session, durable log and painted transcript
      // stay untouched. B then exits normally and A keeps going (proved by the
      // T31 navigation below). `surface` holds no profile-global Client seat;
      // the qualification-only seat is proved separately by T09Q.
      const m5aClientB = new SurfaceEntryProcess(entries.client, {
        ...base,
        cwd: m5aWorkspaceB,
        workDir,
        env: base.env,
      })
      surfaceClients.push(m5aClientB)
      const m5aClientBReady = await m5aClientB.waitFor(
        record => record.m4a0 === 'ready',
        'T09 second surface Client ready',
        180_000,
      )
      assert(m5aClientBReady.processRole === 'client', 'T09 the second surface Client role mismatch')
      assert(m5aClientBReady.surfaceMounted === true, 'T09 Client B did not mount its own physical surface')
      assert(m5aClientBReady.transport === 'connected', `T09 Client B transport is ${JSON.stringify(m5aClientBReady.transport)}`)
      assert(m5aClientBReady.activeWrappers === 1, `T09 Client B owns ${String(m5aClientBReady.activeWrappers)} transport wrappers`)
      assert(m5aClientBReady.liveSockets === 1, `T09 Client B owns ${String(m5aClientBReady.liveSockets)} mux sockets`)
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(m5aClientBReady.owners?.[owner] === 1, `T09 Client B expected exactly one ${owner} owner`)
      }
      assertClientHostFacts(m5aClientBReady.host, surfaceHostFacts, 'T09 Client B')
      // A must still be a live process while B is admitted. A's CURRENT owner,
      // transport and identity facts are asserted from a fresh authoritative
      // `surface-status` produced below (after B has its own open Session);
      // the initial ready snapshot is never used as proof of current ownership.
      assert(typeof c1Ready.pid === 'number' && typeof m5aClientBReady.pid === 'number'
        && c1Ready.pid !== m5aClientBReady.pid,
        'T09 the two surface Clients must be two different business PIDs')
      assert(c1Ready.pid !== surfaceHostPid && m5aClientBReady.pid !== surfaceHostPid,
        'T09 a surface Client business PID collided with the Host PID')
      assert(alive(c1Ready.pid), 'T09 Client A was not alive when B became ready')
      assert(alive(m5aClientBReady.pid), 'T09 Client B was not a live business process after ready')
      await m5aClientB.waitForScreen('type a message to start a session', 'T09 Client B sessionless Welcome')
      m5aClientB.send('m5a client b\r')
      const openedM5aB = await m5aClientB.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true,
        'T09 Client B Session open',
        120_000,
      )
      const sessionM5aB = openedM5aB.openSessionId
      assert(typeof sessionM5aB === 'string' && sessionM5aB.startsWith('session-'),
        'T09 Client B opened no official Session')
      assert(sessionM5aB !== sessionA, 'T09 Client B must open its OWN Session, never A\'s')
      await m5aClientB.waitForScreen('m5a client b', 'T09 Client B user message painted')
      await m5aClientB.waitForScreen('stub answer', 'T09 Client B assistant answer painted')
      const durableM5aB = await (async () => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const events = hostSessionEvents(dshHome, sessionM5aB)
          if (events !== undefined) {
            const users = hostUserTexts(events).filter(message => message === 'm5a client b').length
            const assistant = hostAssistantHasText(events, 'stub answer')
            if (users === 1 && assistant) return { users, assistant, events }
          }
          await sleep(100)
        }
        return undefined
      })()
      assert(durableM5aB !== undefined,
        'T09 the Host durable log did not carry exactly one accepted "m5a client b" write and its assistant message')
      const headerM5aB = await waitForHostSessionHeader(dshHome, sessionM5aB, 'T09 durable Host header B')
      assert(headerM5aB.cwd === canonicalM5aWorkspaceB,
        `T09 Client B's durable Session cwd must be the Host canonical B workspace: ${String(headerM5aB.cwd)} != ${canonicalM5aWorkspaceB}`)
      // Cross-session isolation in BOTH directions, on the durable logs and on
      // the painted frames: a shared Host PID must never leak one Session's
      // human text into the other.
      const durableAAfterB = hostSessionEvents(dshHome, sessionA) ?? []
      assert(hostUserTexts(durableAAfterB).every(text => text !== 'm5a client b'),
        'T09 Client A\'s Host durable log carried B\'s private user text')
      assert(hostUserTexts(durableM5aB.events).every(text => text !== 'session a'),
        'T09 Client B\'s Host durable log carried A\'s private user text')
      assert(hostUserTexts(durableAAfterB).filter(text => text === 'session a').length === 1,
        'T09 Client A\'s accepted write changed while B was admitted')
      assert((await waitForHostSessionHeader(dshHome, sessionA, 'T09 A header after B')).cwd === canonicalClientWorkspaceA,
        'T09 Client B changed A\'s durable Session Workspace')
      await c1.waitForScreen('session a', 'T09 Client A kept its own painted transcript')
      assert(!(await c1.viewport()).join('\n').includes('m5a client b'),
        'T09 Client A painted Client B\'s private text')
      assert(!(await m5aClientB.viewport()).join('\n').includes('session a'),
        'T09 Client B painted Client A\'s private transcript')
      assert(alive(c1Ready.pid), 'T09 Client A died while B was admitted')
      assert(alive(surfaceHostPid), 'T09 the Host died while both surface Clients were admitted')

      // A's CURRENT facts (identity, one owner per official service, one
      // wrapper/socket, connected + mounted) must be proved on a record emitted
      // AFTER B was admitted, not on A's initial ready snapshot. A frozen
      // `surface` entry owns its tty and deliberately has no B1 JSON control
      // channel, so there is no on-demand status read; a status projection is
      // emitted only when an official status key changes. Drive A's own real
      // navigation (a disposable Session with no user message, in A's Host
      // Workspace) and read the next authoritative `surface-status`: first for
      // leaving Session A, then for returning to it. The assertion below is
      // "the next surface-status after B was ready while B is still alive", not
      // an atomic snapshot of B's ready instant.
      const aStaleStatus = lastSurfaceStatus(c1)
      assert(aStaleStatus?.sessionOpen === true && aStaleStatus.openSessionId === sessionA
        && aStaleStatus.transport === 'connected',
      'T09 Client A has no connected Session A status before its status refresh')
      c1.send('/new\r')
      const aTemporaryStatus = await c1.waitFor(
        record => record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.openSessionId !== sessionA,
        'T09 Client A current status via a disposable Session',
        120_000,
      )
      const temporaryASessionId = aTemporaryStatus.openSessionId
      assert(temporaryASessionId !== sessionM5aB,
        'T09 Client A must never open Client B\'s Session')
      const aStatusBoundary = c1.records.length
      c1.send(`/resume ${sessionA}\r`)
      const currentA = await c1.waitFor(
        record => c1.records.indexOf(record) >= aStatusBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && record.openSessionId === sessionA
          && record.transport === 'connected',
        'T09 Client A current status restored to Session A',
        120_000,
      )
      assertClientHostFacts(currentA.host, surfaceHostFacts, 'T09 Client A current')
      assert(currentA.transport === 'connected', `T09 Client A current transport is ${JSON.stringify(currentA.transport)}`)
      assert(currentA.surfaceMounted === true, 'T09 Client A current surface is not mounted')
      assert(currentA.activeWrappers === 1, `T09 Client A currently owns ${String(currentA.activeWrappers)} wrapper(s)`)
      assert(currentA.liveSockets === 1, `T09 Client A currently owns ${String(currentA.liveSockets)} socket(s)`)
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(currentA.owners?.[owner] === 1, `T09 Client A currently owns ${owner} ${String(currentA.owners?.[owner])}`)
      }
      assert(alive(c1Ready.pid), 'T09 Client A died during its own status refresh')
      // A's own navigation must not touch the concurrently admitted Client B.
      const currentB = lastSurfaceStatus(m5aClientB)
      assert(alive(m5aClientBReady.pid), 'T09 Client B died when A navigated Sessions')
      assert(currentB?.transport === 'connected' && currentB?.openSessionId === sessionM5aB,
        'T09 Client B lost its own Session/transport when A navigated')
      await m5aClientB.waitForScreen('m5a client b', 'T09 Client B kept its own transcript')
      await c1.waitForScreen('session a', 'T09 Client A restored its own transcript')
      // Evidence limitation: the disposable navigation leaves ONE Session in
      // A's Host Workspace that receives no user message or turn (the Host
      // persists only its creation record); A's durable Session A
      // header/content stay unchanged (re-asserted below after B exits).

      // B exits NORMALLY while A keeps running: only B's own Client resources
      // are released; A, the Host identity and the registry/launch material
      // stay. A's continued navigation is the next real T31 action.
      m5aClientB.send('/exit\r')
      const m5aClientBExit = await m5aClientB.waitForExit(60_000)
      assert(m5aClientBExit.code === 0, `T09 Client B normal exit was ${JSON.stringify(m5aClientBExit)}`)
      const m5aClientBClosed = await m5aClientB.waitFor(
        record => record.m4b2s === 'client-closed',
        'T09 Client B client-closed',
        30_000,
      )
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(m5aClientBClosed.owners?.[owner] === 0, `T09 Client B left ${owner} alive after its normal exit`)
      }
      assert(m5aClientBClosed.sessionOpen === false && m5aClientBClosed.surfaceMounted === false,
        'T09 Client B still claimed an open surface/Session after its normal exit')
      assert(m5aClientBClosed.activeWrappers === 0 && m5aClientBClosed.liveSockets === 0,
        'T09 Client B still owned transport wrappers/sockets after its normal exit')
      await m5aClientB.dispose()
      assert(alive(c1Ready.pid), 'T09 Client A died when Client B exited')
      assert(alive(surfaceHostPid), 'T09 the Host died when Client B exited')
      const registryAfterM5aB = readJson(join(scopeDir, 'instance.json'))
      assert(registryAfterM5aB.instanceId === surfaceHostFacts.instanceId,
        'T09 the Host instance changed when Client B exited')
      assert(registryAfterM5aB.buildId === surfaceHostFacts.buildId,
        'T09 the Host build changed when Client B exited')
      await c1.waitForScreen('session a', 'T09 Client A survived B\'s exit')
      assert(!(await c1.viewport()).join('\n').includes('m5a client b'),
        'T09 Client A painted Client B\'s private text after B exited')
      trace('t09', {
        hostPid: surfaceHostPid,
        hostInstanceId: surfaceHostFacts.instanceId,
        clientAPid: c1Ready.pid,
        clientBPid: m5aClientBReady.pid,
        sessionIdA: sessionA,
        sessionIdB: sessionM5aB,
        workspaceADigest: sha16(canonicalClientWorkspaceA),
        workspaceBDigest: sha16(canonicalM5aWorkspaceB),
        distinctBusinessPids: c1Ready.pid !== m5aClientBReady.pid,
        bothReadyConcurrently: true,
        clientACurrentStatusAfterB: true,
        clientACurrentOwners: currentA.owners,
        clientACurrentWrappers: currentA.activeWrappers,
        clientACurrentSockets: currentA.liveSockets,
        clientBNormalExit: m5aClientBExit.code,
        clientBClosed: true,
        clientAKept: true,
        hostIdentityKept: true,
      })

      // T31: Session switch A -> B -> A, each with retained-window hydration.
      // Each wait is bounded to the records appended AFTER its own command:
      // an earlier Session-A status must never satisfy a later switch.
      const t31NewBoundary = c1.records.length
      c1.send('/new\r')
      const openedB = await c1.waitFor(
        record => c1.records.indexOf(record) >= t31NewBoundary
          && record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && record.openSessionId !== sessionA,
        'T31 new Session',
        120_000,
      )
      sessionB = openedB.openSessionId
      assert(sessionB !== sessionA, 'T31 /new did not open a different Session')
      c1.send('session b\r')
      await c1.waitForScreen('session b', 'T31 Session B user message')
      await c1.waitForScreen('stub answer', 'T31 Session B assistant answer')
      const t31BackToABoundary = c1.records.length
      c1.send(`/resume ${sessionA}\r`)
      await c1.waitFor(
        record => c1.records.indexOf(record) >= t31BackToABoundary
          && record.m4b2s === 'surface-status'
          && record.openSessionId === sessionA,
        'T31 switch back to A',
        120_000,
      )
      await c1.waitForScreen('session a', 'T31 Session A re-hydration')
      const t31ToBBoundary = c1.records.length
      c1.send(`/resume ${sessionB}\r`)
      await c1.waitFor(
        record => c1.records.indexOf(record) >= t31ToBBoundary
          && record.m4b2s === 'surface-status'
          && record.openSessionId === sessionB,
        'T31 switch to B',
        120_000,
      )
      await c1.waitForScreen('session b', 'T31 Session B re-hydration')
      const t31FinalABoundary = c1.records.length
      c1.send(`/resume ${sessionA}\r`)
      await c1.waitFor(
        record => c1.records.indexOf(record) >= t31FinalABoundary
          && record.m4b2s === 'surface-status'
          && record.openSessionId === sessionA,
        'T31 switch A -> B -> A',
        120_000,
      )
      await c1.waitForScreen('session a', 'T31 final Session A hydration')
      // WS-2: `/new` created B in the CAPTURED Session's Host Workspace (A), not
      // in the Client launch directory of some other process.
      const headerB = await waitForHostSessionHeader(dshHome, sessionB, 'T31 durable Host header')
      assert(headerB.cwd === canonicalClientWorkspaceA,
        `T31 the /new Session cwd must be the captured Host Workspace: ${String(headerB.cwd)} != ${canonicalClientWorkspaceA}`)
      trace('t31', { first: sessionA, second: sessionB, switches: 'A->B->A', durableCwd: headerB.cwd })

      // T36: the private PiFile + terminal-progress RPCs through the ALREADY
      // mounted Domain namespaces on the SAME Client Context (no second
      // contribution, no Host service).
      c1.signalBusiness('SIGUSR2')
      const privateProof = await c1.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'private-rpc-proof',
        'T36 private RPC proof',
        60_000,
      )
      assert(privateProof.error === undefined, `T36 private RPC proof failed: ${JSON.stringify(privateProof)}`)
      assert(privateProof.fileOk === true, 'T36 the private PiFile RPC did not succeed')
      assert(typeof privateProof.fileKind === 'string', 'T36 the private PiFile RPC returned no business kind')
      assert(privateProof.terminalKind === 'snapshot', 'T36 the terminal-progress watch did not open with a snapshot')
      assert(privateProof.owners?.sessions === 1 && privateProof.privateNamespaces === 2,
        'T36 the private proof observed a duplicate/absent Domain owner')
      // Migrated from the retired built-bundle smoke: the private endpoint's
      // Host workspace semantics over the REAL authenticated split wire.
      assert(privateProof.bareOfficial === true,
        `T36 the bare query did not reach the official Host provider (observed ${String(privateProof.bareCount)} items)`)
      assert(privateProof.officialEmpty === true,
        `T36 an authoritative official [] did not stay empty (ok=${String(privateProof.emptyOk)} kind=${String(privateProof.emptyKind)})`)
      assert(privateProof.officialExcludesDist === true,
        `T36 the official bare route did not authoritatively exclude dist/ (kind ${String(privateProof.officialExcludesDistKind)})`)
      assert(privateProof.scopedOk === true && privateProof.scopedHostScanner === true,
        `T36 the explicit-path scope did not reach the Host scanner (observed ${String(privateProof.scopedCount)} items)`)
      assert(privateProof.homeAbsolute === true,
        'T36 the HOME shorthand did not answer absolute Host paths')
      // WS-2: the Host Workspace authority behind the SAME Session, read through
      // the official Client namespace and the Host's own file read.
      assert(privateProof.workspaceMatchesClientCwd === true,
        'T36 the Session Workspace path is not the Client launch directory')
      assert(privateProof.workspacePathDigest === sha16(canonicalClientWorkspaceA),
        `T36 the Session Workspace path digest is not A: ${String(privateProof.workspacePathDigest)}`)
      assert(Array.isArray(privateProof.workspaceSessionDigests)
        && privateProof.workspaceSessionDigests.includes(sha16(sessionA))
        && privateProof.workspaceSessionDigests.includes(sha16(sessionB)),
      'T36 both /new Sessions must belong to the SAME Host Workspace')
      assert(privateProof.workspaceListCwdDigest === sha16(canonicalClientWorkspaceA),
        'T36 the Host list-row cwd digest is not the Workspace path')
      // The official page read joins lines, so the expected text carries no
      // trailing newline.
      assert(privateProof.workspaceMarkerText === 'client-workspace-A',
        `T36 the Host file read did not return THIS Workspace's marker: ${JSON.stringify(privateProof.workspaceMarkerText)}`)
      trace('t36', {
        sessionId: privateProof.sessionId,
        fileOk: privateProof.fileOk,
        fileKind: privateProof.fileKind,
        bareOfficial: privateProof.bareOfficial,
        officialEmpty: privateProof.officialEmpty,
        scopedHostScanner: privateProof.scopedHostScanner,
        homeAbsolute: privateProof.homeAbsolute,
        terminalKind: privateProof.terminalKind,
        owners: privateProof.owners,
      })

      // T32/T38: normal surface exit releases every Client-owned resource and
      // leaves the Host PID/instance/build untouched.
      c1.send('/exit\r')
      const c1Exit = await c1.waitForExit(60_000)
      assert(c1Exit.code === 0, `T32 surface Client exit was ${JSON.stringify(c1Exit)}`)
      await c1.waitFor(record => record.m4b2s === 'client-closed', 'T38 client-closed record', 30_000)
      const closed = c1.records.find(record => record.m4b2s === 'client-closed')
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(closed.owners?.[owner] === 0, `T38 ${owner} survived the Client exit`)
      }
      assert(closed.sessionOpen === false && closed.surfaceMounted === false,
        'T38 the Client still claims an open surface/Session after exit')
      assert(closed.activeWrappers === 0 && closed.liveSockets === 0,
        'T38 the Client still owns transport wrappers/sockets after exit')
      assert(alive(surfaceHostPid), 'T32 the Host died on the normal surface exit')
      const registryAfterExit = readJson(join(scopeDir, 'instance.json'))
      assert(registryAfterExit.instanceId === surfaceHostFacts.instanceId, 'T32 the Host instance changed on the Client exit')
      assert(registryAfterExit.buildId === surfaceHostFacts.buildId, 'T32 the Host build changed on the Client exit')
      trace('t32-t38', {
        clientExit: c1Exit.code,
        hostPid: surfaceHostPid,
        hostInstanceId: surfaceHostFacts.instanceId,
        owners: closed.owners,
        wrappers: closed.activeWrappers,
        sockets: closed.liveSockets,
      })
      await c1.dispose()

      // WS-2: a SECOND, SEQUENTIAL real Client whose launch directory (C) is
      // separate from A selects its OWN Host Workspace under the SAME Host
      // PID/instance. This sequential Client-C scenario keeps its original
      // position after c1 exited; the concurrent same-Host positive is T09.
      const ws2ClientC = new SurfaceEntryProcess(entries.client, {
        ...base,
        cwd: clientWorkspaceC,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF: '1' },
      })
      surfaceClients.push(ws2ClientC)
      const ws2ClientCReady = await ws2ClientC.waitFor(record => record.m4a0 === 'ready', 'WS2 second Client ready', 180_000)
      assert(ws2ClientCReady.processRole === 'client', 'WS2 second Client role mismatch')
      assert(ws2ClientCReady.pid !== surfaceHostPid, 'WS2 the second Client must be its own OS process')
      assert(ws2ClientCReady.host.hostPid === surfaceHostFacts.hostPid, 'WS2 the second Client must reach the SAME Host PID')
      assert(ws2ClientCReady.host.instanceId === surfaceHostFacts.instanceId, 'WS2 the second Client must reach the SAME Host instance')
      ws2ClientC.send('ws2 session c\r')
      const ws2ClientCOpened = await ws2ClientC.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true,
        'WS2 session C open',
        120_000,
      )
      const sessionC = ws2ClientCOpened.openSessionId
      assert(typeof sessionC === 'string' && sessionC.startsWith('session-'), 'WS2 session C has no official Session id')
      await ws2ClientC.waitForScreen('ws2 session c', 'WS2 session C user message')
      const headerC = await waitForHostSessionHeader(dshHome, sessionC, 'WS2 durable C header')
      assert(headerC.cwd === canonicalClientWorkspaceC,
        `WS2 session C header cwd must be the Host canonical C path: ${String(headerC.cwd)} != ${canonicalClientWorkspaceC}`)
      ws2ClientC.signalBusiness('SIGUSR2')
      const ws2ClientCProof = await ws2ClientC.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'private-rpc-proof',
        'WS2 second Client workspace proof',
        60_000,
      )
      assert(ws2ClientCProof.workspaceMatchesClientCwd === true,
        'WS2 the C Session Workspace path is not the C Client launch directory')
      assert(ws2ClientCProof.workspacePathDigest === sha16(canonicalClientWorkspaceC),
        `WS2 the C Session Workspace path digest is not C: ${String(ws2ClientCProof.workspacePathDigest)}`)
      assert(Array.isArray(ws2ClientCProof.workspaceSessionDigests)
        && ws2ClientCProof.workspaceSessionDigests.includes(sha16(sessionC)),
      'WS2 the C Session is missing from its own Host Workspace membership')
      // A's marker is NOT readable from C's Session: the Host file authority is
      // the Session's OWN Workspace, never a global "current directory".
      assert(ws2ClientCProof.workspaceMarkerText === undefined,
        `WS2 the C Session must not read A's Workspace marker: ${JSON.stringify(ws2ClientCProof.workspaceMarkerText)}`)
      // No cross-Client reassignment: A/B keep their own durable Workspace.
      const headerAAfterC = await waitForHostSessionHeader(dshHome, sessionA, 'WS2 A header after C')
      const headerBAfterC = await waitForHostSessionHeader(dshHome, sessionB, 'WS2 B header after C')
      assert(headerAAfterC.cwd === canonicalClientWorkspaceA, 'WS2 a second Client changed A\'s durable Workspace')
      assert(headerBAfterC.cwd === canonicalClientWorkspaceA, 'WS2 a second Client changed B\'s durable Workspace')
      // WS2-02 (cross-Workspace): this Client's launch cwd is C, but after
      // resuming Session A (Workspace A) a `/new` must create the fresh Session
      // in A's Host Workspace — never in the Client launch directory C. This is
      // the real-wire witness the same-cwd case cannot provide.
      ws2ClientC.send(`/resume ${sessionA}\r`)
      await ws2ClientC.waitFor(
        record => record.m4b2s === 'surface-status' && record.openSessionId === sessionA,
        'WS2 resume A from Client C',
        120_000,
      )
      await ws2ClientC.waitForScreen('session a', 'WS2 resumed A history in Client C', 120_000)
      ws2ClientC.send('/new\r')
      const ws2CrossOpened = await ws2ClientC.waitFor(
        record => record.m4b2s === 'surface-status'
          && record.sessionOpen === true
          && record.openSessionId !== sessionA
          && record.openSessionId !== sessionC,
        'WS2 cross-Workspace /new Session',
        120_000,
      )
      const sessionD = ws2CrossOpened.openSessionId
      assert(typeof sessionD === 'string' && sessionD.startsWith('session-'), 'WS2 cross-Workspace /new has no Session id')
      const headerD = await waitForHostSessionHeader(dshHome, sessionD, 'WS2 durable D header')
      assert(headerD.cwd === canonicalClientWorkspaceA,
        `WS2 /new from Session A must create in A's Host Workspace, not the Client launch cwd: ${String(headerD.cwd)} != ${canonicalClientWorkspaceA}`)
      ws2ClientC.signalBusiness('SIGUSR2')
      const ws2CrossProof = await ws2ClientC.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'private-rpc-proof' && record.sessionId === sessionD,
        'WS2 cross-Workspace /new workspace proof',
        60_000,
      )
      assert(ws2CrossProof.workspacePathDigest === sha16(canonicalClientWorkspaceA),
        `WS2 the /new Session Workspace is not A: ${String(ws2CrossProof.workspacePathDigest)}`)
      assert(ws2CrossProof.workspaceMatchesClientCwd === false,
        'WS2 the /new Session Workspace must not be the Client launch directory C')
      assert(ws2CrossProof.workspaceListCwdDigest === sha16(canonicalClientWorkspaceA),
        'WS2 the /new Session list-row cwd digest is not A')
      assert(ws2CrossProof.workspaceMarkerText === 'client-workspace-A',
        'WS2 the /new Session Host file read must reach A\'s marker')
      const ws2Rows = Array.isArray(ws2CrossProof.workspaceRows) ? ws2CrossProof.workspaceRows : []
      const ws2RowA = ws2Rows.find(row => row.pathDigest === sha16(canonicalClientWorkspaceA))
      const ws2RowC = ws2Rows.find(row => row.pathDigest === sha16(canonicalClientWorkspaceC))
      assert(ws2RowA !== undefined && Array.isArray(ws2RowA.sessionDigests)
        && ws2RowA.sessionDigests.includes(sha16(sessionA))
        && ws2RowA.sessionDigests.includes(sha16(sessionD)),
      'WS2 the /new Session must join A\'s Host Workspace membership')
      assert(ws2RowC !== undefined && Array.isArray(ws2RowC.sessionDigests)
        && ws2RowC.sessionDigests.includes(sha16(sessionC)),
      'WS2 the earlier Client-C Session must stay in Workspace C')
      assert((await waitForHostSessionHeader(dshHome, sessionC, 'WS2 durable C header after /new')).cwd === canonicalClientWorkspaceC,
        'WS2 the cross-Workspace /new changed Session C\'s durable Workspace')
      ws2ClientC.send('/exit\r')
      const ws2ClientCExit = await ws2ClientC.waitForExit(60_000)
      assert(ws2ClientCExit.code === 0, `WS2 second Client exit was ${JSON.stringify(ws2ClientCExit)}`)
      await ws2ClientC.dispose()
      assert(alive(surfaceHostPid), 'WS2 the Host died on the second Client exit')
      trace('ws2-second-client', {
        hostPid: surfaceHostPid,
        clientPid: ws2ClientCReady.pid,
        sessionId: sessionC,
        workspacePathDigest: ws2ClientCProof.workspacePathDigest,
        clientLaunchCwd: canonicalClientWorkspaceC,
        aWorkspaceKept: headerAAfterC.cwd,
        markerIsolated: true,
        crossWorkspaceNew: true,
        crossWorkspaceSessionId: sessionD,
        crossWorkspaceCwd: canonicalClientWorkspaceA,
      })

      // WS-2 negative control: an invalid Host path proposal refuses BEFORE any
      // Session create, surfaces a meaningful failure, and leaves the Host alive.
      // The injection uses the SAME `initialWorkspaceIntent` seam (a path, never
      // a pre-validated WorkspaceId).
      const sessionLogsBefore = hostSessionLogCount(dshHome)
      const ws2InvalidClient = new SurfaceEntryProcess(entries.client, {
        ...base,
        cwd: clientWorkspaceA,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: join(workDir, 'ws2-invalid-host-path'),
        },
      })
      surfaceClients.push(ws2InvalidClient)
      const ws2InvalidClientReady = await ws2InvalidClient.waitFor(record => record.m4a0 === 'ready', 'WS2 negative Client ready', 180_000)
      assert(ws2InvalidClientReady.sessionOpen === false, 'WS2 the negative Client must start sessionless')
      ws2InvalidClient.send('ws2 invalid path probe\r')
      await ws2InvalidClient.waitForScreen('could not start a session', 'WS2 negative failure notice')
      assert(!ws2InvalidClient.records.some(record => record.m4b2s === 'surface-status' && record.sessionOpen === true),
        'WS2 the invalid Host path must never open/create a Session')
      assert(hostSessionLogCount(dshHome) === sessionLogsBefore,
        'WS2 the invalid Host path created a durable Host Session')
      assert(alive(surfaceHostPid), 'WS2 the Host died on the invalid path refusal')
      assert(readJson(join(scopeDir, 'instance.json')).instanceId === surfaceHostFacts.instanceId,
        'WS2 the Host instance changed on the invalid path refusal')
      // The failed first-session submission RESTORED the draft into the editor,
      // so a typed `/exit` would be appended to it and submitted as ordinary
      // text. Use the same admitted business stop the T41/T66 witnesses use.
      ws2InvalidClient.signalBusiness('SIGTERM')
      const ws2InvalidClientExit = await ws2InvalidClient.waitForExit(60_000)
      assert(ws2InvalidClientExit.code === 0 && ws2InvalidClientExit.signal === null,
        `WS2 negative Client stop was ${JSON.stringify(ws2InvalidClientExit)}`)
      await ws2InvalidClient.dispose()
      trace('ws2-invalid-path', {
        sessionOpen: false,
        hostSessionLogs: sessionLogsBefore,
        hostAlive: true,
      })

      // T41/T42: a SIGTERM during the assembly must be owned by ONE coordinator:
      // no ready, no duplicate cleanup, the same Host immediately usable by a
      // fresh surface Client, and the Host untouched. Two deterministic stages
      // are held: after the Domain readiness and after the runner fiber
      // mount/before surface ready.
      for (const [stage, traceName] of [['domain', 't41'], ['surface', 't42']]) {
        const barrier = join(workDir, `${traceName}-assembly-barrier`)
        rmSync(barrier, { force: true })
        const stopping = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: {
            ...base.env,
            SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY: `${stage}@${barrier}`,
          },
        })
        surfaceClients.push(stopping)
        const held = await stopping.waitFor(
          record => record.m4b2s === 'qualification' && record.op === 'assembly-hold' && record.stage === stage,
          `${traceName} ${stage} assembly hold`,
          180_000,
        )
        stopping.signalBusiness('SIGTERM')
        // Ordering, not sleep: the barrier must be released only AFTER the
        // Client ADMITTED the signal (its own `signal` record). Signalling and
        // releasing back-to-back races the OS signal delivery against the
        // hold's 20ms poll — the assembly could legally finish and publish a
        // real `ready` before the signal was ever admitted, which is a
        // different (correct) outcome than this case's claim. T59 uses the
        // same admitted-signal gate for its mid-HMR stop.
        await stopping.waitFor(
          record => record.m4a0 === 'signal' && record.signal === 'SIGTERM',
          `${traceName} ${stage} stop signal admitted`,
          30_000,
        )
        writeFileSync(barrier, 'release\n', { mode: 0o600 })
        const stopped = await stopping.waitForExit(60_000)
        assert(stopped.code === 0, `${traceName} ${stage} stop exit was ${JSON.stringify(stopped)}`)
        assert(!stopping.records.some(record => record.m4a0 === 'ready'),
          `${traceName} ${stage} stop still published a ready surface`)
        assert(!stopping.records.some(record => record.m4a0 === 'cleanup-failure'),
          `${traceName} ${stage} stop reported a duplicate/failed cleanup`)
        await stopping.dispose()
        // A NEW surface Client mounts immediately over the SAME Host: `surface`
        // holds no profile-global Client seat to release or reuse.
        const reusable = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        surfaceClients.push(reusable)
        const reusableReady = await reusable.waitFor(record => record.m4a0 === 'ready', `${traceName} reusable Client ready`, 180_000)
        assert(reusableReady.surfaceMounted === true, `${traceName} the reusable Client did not mount`)
        assert(alive(surfaceHostPid), `${traceName} the Host died on the startup stop`)
        const reusableInstance = readJson(join(scopeDir, 'instance.json'))
        assert(reusableInstance.instanceId === surfaceHostFacts.instanceId,
          `${traceName} the Host instance changed on the startup stop`)
        reusable.send('/exit\r')
        const reusableExit = await reusable.waitForExit(60_000)
        assert(reusableExit.code === 0, `${traceName} reusable Client exit was ${JSON.stringify(reusableExit)}`)
        await reusable.dispose()
        trace(traceName, {
          stage,
          heldAt: held.stage,
          readyEmitted: false,
          cleanupFailures: 0,
          clientReusable: true,
          hostAlive: true,
        })
      }

      // T41-gate: a SIGTERM while the REAL Cordis Loader gate is still pending
      // must enter the ONE stop coordinator before any Gateway start. The
      // process must exit cleanly, leave no fake ready and keep the Host alive;
      // the same Host then accepts a fresh Client.
      {
        const gateBarrier = join(workDir, 't41-gate-barrier')
        rmSync(gateBarrier, { force: true })
        const gateStopping = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE: gateBarrier },
        })
        surfaceClients.push(gateStopping)
        const gateHeld = await gateStopping.waitFor(
          record => record.m4b2s === 'qualification' && record.op === 'startup-gate-hold' && record.stage === 'loader-gate',
          'T41-gate loader gate hold',
          180_000,
        )
        gateStopping.signalBusiness('SIGTERM')
        writeFileSync(gateBarrier, 'release\n', { mode: 0o600 })
        const gateExit = await gateStopping.waitForExit(60_000)
        assert(gateExit.code === 0, `T41-gate stop exit was ${JSON.stringify(gateExit)}`)
        assert(!gateStopping.records.some(record => record.m4a0 === 'ready'),
          'T41-gate stop still published a ready surface')
        assert(!gateStopping.records.some(record => record.m4a0 === 'cleanup-failure'),
          'T41-gate stop reported a cleanup failure')
        assert(!gateStopping.records.some(record => record.m4a0 === 'transport-ready'),
          'T41-gate stop allowed transport readiness after the signal')
        await gateStopping.dispose()
        assert(alive(surfaceHostPid), 'T41-gate the Host died on the gate stop')
        const gateReusable = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        surfaceClients.push(gateReusable)
        const gateReusableReady = await gateReusable.waitFor(record => record.m4a0 === 'ready', 'T41-gate reusable Client ready', 180_000)
        assert(gateReusableReady.surfaceMounted === true, 'T41-gate the reusable Client did not mount')
        gateReusable.send('/exit\r')
        const gateReusableExit = await gateReusable.waitForExit(60_000)
        assert(gateReusableExit.code === 0, `T41-gate reusable Client exit was ${JSON.stringify(gateReusableExit)}`)
        await gateReusable.dispose()
        trace('t41-gate', {
          heldAt: gateHeld.stage,
          readyEmitted: false,
          transportReady: false,
          cleanupFailures: 0,
          clientReusable: true,
          hostAlive: true,
        })
      }

      // T43: a signal in the PRE-STARTUP assignment window (after the lazy
      // client-bootstrap import, before `startupPromise` exists) must wait for
      // the ONE startup gate and never dispose the root underneath a late
      // `startLocalClient` call.
      const preStartBarrier = join(workDir, 't43-pre-start-barrier')
      rmSync(preStartBarrier, { force: true })
      const preStart = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START: preStartBarrier,
        },
      })
      surfaceClients.push(preStart)
      await preStart.waitFor(
        record => record.m4a0 === 'qualification' && record.op === 'before-start-hold',
        'T43 pre-startup assignment hold',
        180_000,
      )
      preStart.signalBusiness('SIGTERM')
      writeFileSync(preStartBarrier, 'release\n', { mode: 0o600 })
      const preStartExit = await preStart.waitForExit(60_000)
      assert(preStartExit.code === 0, `T43 pre-startup stop exit was ${JSON.stringify(preStartExit)}`)
      assert(!preStart.records.some(record => record.m4a0 === 'ready'),
        'T43 pre-startup stop still published a ready surface')
      assert(!preStart.records.some(record => record.m4a0 === 'cleanup-failure'),
        'T43 pre-startup stop reported a duplicate/failed cleanup')
      await preStart.dispose()
      const afterPreStart = new SurfaceEntryProcess(entries.client, { ...base, workDir })
      surfaceClients.push(afterPreStart)
      const afterPreStartReady = await afterPreStart.waitFor(record => record.m4a0 === 'ready', 'T43 reusable Client ready', 180_000)
      assert(afterPreStartReady.surfaceMounted === true, 'T43 the reusable Client did not mount')
      assert(alive(surfaceHostPid), 'T43 the Host died on the pre-startup stop')
      const afterPreStartInstance = readJson(join(scopeDir, 'instance.json'))
      assert(afterPreStartInstance.instanceId === surfaceHostFacts.instanceId,
        'T43 the Host instance changed on the pre-startup stop')
      afterPreStart.send('/exit\r')
      const afterPreStartExit = await afterPreStart.waitForExit(60_000)
      assert(afterPreStartExit.code === 0, `T43 reusable Client exit was ${JSON.stringify(afterPreStartExit)}`)
      await afterPreStart.dispose()
      trace('t43', {
        stage: 'pre-startup-assignment',
        readyEmitted: false,
        cleanupFailures: 0,
        clientReusable: true,
        hostAlive: true,
      })

      // T34: close the writer's pre-dispatch admission while a REAL
      // serialization barrier holds the write. The writer must return
      // not-dispatched, the draft must return to the composer, and the Host must
      // never see the prompt. The signal only closes the SAME admission gate the
      // surface-stop path owns; the surface stays mounted so the draft is visible.
      const holdBarrier = join(workDir, 't34-serializer-barrier')
      rmSync(holdBarrier, { force: true })
      const cHold = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_SESSION: sessionA,
          SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE: holdBarrier,
        },
      })
      surfaceClients.push(cHold)
      const cHoldReady = await cHold.waitFor(record => record.m4a0 === 'ready', 'T34 hold Client ready', 180_000)
      assert(cHoldReady.sessionOpen === true && cHoldReady.openSessionId === sessionA,
        'T34 the hold Client did not open the retained Session')
      cHold.send('holdme\r')
      await cHold.waitForScreen('holdme', 'T34 pending echo', 60_000)
      cHold.signalBusiness('SIGUSR2')
      await cHold.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'stop-surface-admission',
        'T34 admission stop',
        30_000,
      )
      writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
      await cHold.waitForComposerDraft('holdme', 60_000)
      // The writer settled BEFORE dispatch (the admission record and the
      // restored composer draft are both observed). One bounded observation
      // window then proves the Host received nothing; a real dispatch would
      // persist immediately.
      await sleep(1_000)
      const holdEvents = hostSessionEvents(dshHome, sessionA)
      assert(holdEvents !== undefined, 'T34 no Host Session log is readable')
      assert(hostUserTexts(holdEvents).filter(message => message === 'holdme').length === 0,
        'T34 the refused pre-dispatch write still reached the Host')
      cHold.signalBusiness('SIGTERM')
      const holdExit = await cHold.waitForExit(60_000)
      assert(holdExit.code === 0, `T34 hold Client exit was ${JSON.stringify(holdExit)}`)
      await cHold.dispose()
      trace('t34', { preDispatch: 'not dispatched', hostWrites: 0, draft: 'restored' })

      // T35: the Host receives and commits ONE prompt, but the response ACK is
      // dropped after the write. The Client must report the write as
      // indeterminate (never committed), never replay it, and the NEXT Client
      // must reconcile from the Host's durable log.
      const c4 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_SESSION: sessionA,
          SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1',
        },
      })
      surfaceClients.push(c4)
      const c4Ready = await c4.waitFor(record => record.m4a0 === 'ready', 'T35 ACK-drop Client ready', 180_000)
      assert(c4Ready.sessionOpen === true && c4Ready.openSessionId === sessionA,
        'T35 the ACK-drop Client did not open the retained Session')
      c4.send('ackdrop\r')
      await c4.waitForScreen('indeterminate', 'T35 indeterminate notice', 120_000)
      const committedAckdrop = async (expected) => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const events = hostSessionEvents(dshHome, sessionA)
          if (events !== undefined) {
            const count = hostUserTexts(events).filter(message => message === 'ackdrop').length
            if (count >= expected) return count
          }
          await sleep(100)
        }
        return undefined
      }
      const hostCommits = await committedAckdrop(1)
      assert(hostCommits === 1,
        `T35 expected exactly ONE Host-committed ackdrop message, got ${String(hostCommits)}`)
      c4.signalBusiness('SIGTERM')
      const c4Exit = await c4.waitForExit(60_000)
      assert(c4Exit.code === 0, `T35 ACK-drop Client exit was ${JSON.stringify(c4Exit)}`)
      await c4.dispose()

      const c5 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
      })
      surfaceClients.push(c5)
      const c5Ready = await c5.waitFor(record => record.m4a0 === 'ready', 'T35 reconciliation Client ready', 180_000)
      assert(c5Ready.sessionOpen === true && c5Ready.openSessionId === sessionA,
        'T35 the reconciliation Client did not open the retained Session')
      await c5.waitForScreen('ackdrop', 'T35 reconciled Host log')
      await sleep(500)
      const reconciledEvents = hostSessionEvents(dshHome, sessionA)
      assert(reconciledEvents !== undefined, 'T35 no persisted Host Session log is readable')
      assert(hostUserTexts(reconciledEvents).filter(message => message === 'ackdrop').length === 1,
        'T35 the next Client replayed the indeterminate prompt instead of reconciling the Host log')
      c5.send('/exit\r')
      const c5Exit = await c5.waitForExit(60_000)
      assert(c5Exit.code === 0, `T35 reconciliation Client exit was ${JSON.stringify(c5Exit)}`)
      await c5.dispose()
      assert(alive(surfaceHostPid), 'T35 the Host died on the ACK-drop flow')
      trace('t35', { hostCommits: 1, indeterminate: 'painted', replayed: false, reconcile: 'Host log' })

      // T29 resume + T33 SIGKILL survival: a NEW Client reads the committed
      // Session; killing it leaves the same Host instance alive; a THIRD Client
      // reads the SAME committed data again.
      const c2 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
      })
      surfaceClients.push(c2)
      const c2Ready = await c2.waitFor(record => record.m4a0 === 'ready', 'T29 resume Client ready', 180_000)
      assert(c2Ready.sessionOpen === true && c2Ready.openSessionId === sessionA,
        'T29 the explicit --session resume did not open the exact retained Session')
      await c2.waitForScreen('session a', 'T29 retained user message')
      await c2.waitForScreen('stub answer', 'T30 retained assistant answer')
      assertClientHostFacts(c2Ready.host, surfaceHostFacts, 'T29 C2')
      const c2Pid = c2Ready.pid
      c2.signalBusiness('SIGKILL')
      for (let attempt = 0; attempt < 200 && alive(c2Pid); attempt += 1) await sleep(25)
      assert(!alive(c2Pid), 'T33 the surface Client survived SIGKILL')
      assert(alive(surfaceHostPid), 'T33 the Host died on Client SIGKILL')
      await c2.dispose()

      const c3 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
      })
      surfaceClients.push(c3)
      const c3Ready = await c3.waitFor(record => record.m4a0 === 'ready', 'T33 post-kill Client ready', 180_000)
      assert(c3Ready.sessionOpen === true && c3Ready.openSessionId === sessionA,
        'T33 the post-SIGKILL Client did not re-open the committed Session')
      await c3.waitForScreen('session a', 'T33 committed readback after SIGKILL')
      assertClientHostFacts(c3Ready.host, surfaceHostFacts, 'T33 C3')
      trace('t33', { killedClient: c2Pid, resumedClient: c3Ready.pid, hostAlive: true, sessionId: sessionA })

      // T37: one physical mux drop -> official generation rollover -> the
      // retained main view is re-adopted and the transcript re-hydrates.
      const generationBefore = c3Ready.generationId
      c3.signalBusiness('SIGUSR1')
      const rolled = await c3.waitFor(
        record => record.m4b2s === 'surface-status'
          && typeof record.generationId === 'number'
          && record.generationId !== generationBefore
          && record.sessionOpen === true,
        'T37 connection generation rollover',
        120_000,
      )
      assert(rolled.openSessionId === sessionA, 'T37 the rollover lost the retained Session')
      await c3.waitForScreen('session a', 'T37 retained transcript after reconnect')
      assert(alive(surfaceHostPid), 'T37 the Host died on the mux rollover')
      assertClientHostFacts(c3Ready.host, surfaceHostFacts, 'T37 C3')
      trace('t37', { generationBefore, generationAfter: rolled.generationId, sessionOpen: true, hostAlive: true })

      c3.send('/exit\r')
      const c3Exit = await c3.waitForExit(60_000)
      assert(c3Exit.code === 0, `T37 surface Client exit was ${JSON.stringify(c3Exit)}`)
      assert(alive(surfaceHostPid), 'T37 the Host died on the Client exit')
      await c3.dispose()

      // T61: ONE write parked in the REAL prompt serializer while the official
      // Connection generation is replaced by a physical mux drop. The stale
      // captured generation must not dispatch (Host durable log: zero
      // occurrences, no `indeterminate` notice), the draft returns exactly once,
      // and a NEW write on the rolled-over generation must commit exactly once —
      // the fence refuses the superseded write without poisoning the carrier.
      {
        const barrier = join(workDir, 't61-serializer-barrier')
        rmSync(barrier, { force: true })
        const staleToken = 't61-stale-generation'
        const liveToken = 't61-live-generation'
        const stalePriors = hostUserTexts(hostSessionEvents(dshHome, sessionA) ?? [])
          .filter(text => text === staleToken).length
        assert(stalePriors === 0, 'T61 the stale token already exists in the Host durable log')
        const parked = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: {
            ...base.env,
            SPLIT_PROCESS_CLIENT_SESSION: sessionA,
            SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE: barrier,
          },
        })
        surfaceClients.push(parked)
        const parkedReady = await parked.waitFor(record => record.m4a0 === 'ready', 'T61 parked Client ready', 180_000)
        assert(parkedReady.sessionOpen === true && parkedReady.openSessionId === sessionA,
          'T61 the parked Client did not open the retained Session')
        const generationBefore = parkedReady.generationId
        assert(typeof generationBefore === 'number', 'T61 the Client never observed an official transport generation')
        parked.send(`${staleToken}\r`)
        // The write really reached the serializer (not merely "Enter was sent").
        const heldAt = await parked.waitFor(
          record => record.m4b2s === 'qualification' && record.op === 'serialize-held',
          'T61 serializer armed',
          60_000,
        )
        assert(Number.isInteger(heldAt.revision), 'T61 the serializer hold did not name the pinned revision')
        // ONE physical mux drop: the official Connection replaces the generation
        // while the write is still parked.
        parked.signalBusiness('SIGUSR1')
        const rolledOver = await parked.waitFor(
          record => record.m4b2s === 'surface-status'
            && typeof record.generationId === 'number'
            && record.generationId !== generationBefore
            && record.sessionOpen === true
            && record.openSessionId === sessionA,
          'T61 generation rollover',
          120_000,
        )
        assert(alive(surfaceHostPid), 'T61 the Host died on the mux rollover')
        assertClientHostFacts(rolledOver.host, surfaceHostFacts, 'T61 after rollover')
        writeFileSync(barrier, 'release\n', { mode: 0o600 })
        await parked.waitForComposerDraft(staleToken, 60_000)
        // The restored draft IS the writer's own settlement: the outcome is final
        // before the composer paints it, so no observation window is needed here.
        assert(!(await parked.viewport()).join('\n').includes('indeterminate'),
          'T61 the not-dispatched write was reported as indeterminate')
        // Restored EXACTLY once: the composer holds the token once, not twice.
        const restoredComposer = await parked.composerText()
        assert(restoredComposer !== undefined, 'T61 the composer disappeared after the refusal')
        const restoredOccurrences = restoredComposer.split(staleToken).length - 1
        assert(restoredOccurrences === 1,
          `T61 the draft was restored ${String(restoredOccurrences)} times, expected exactly once`)
        // Same Client process, CURRENT generation: a fresh prompt must commit.
        await parked.clearComposerDraft(staleToken)
        // Watermark: this Session already carries earlier turns from this lane, so a
        // bare `turn/end` wait could match HISTORY. Every fact below must be a NEW
        // durable event, i.e. one with an index at or after this snapshot.
        const beforeLive = (hostSessionEvents(dshHome, sessionA) ?? []).length
        parked.send(`${liveToken}\r`)
        const liveCommit = await (async () => {
          const deadline = Date.now() + 120_000
          while (Date.now() < deadline) {
            const texts = hostUserTexts(hostSessionEvents(dshHome, sessionA) ?? [])
            const count = texts.filter(text => text === liveToken).length
            if (count >= 1) return count
            await sleep(100)
          }
          return 0
        })()
        assert(liveCommit >= 1, 'T61 the new generation never committed its write')
        // Ordering witness, not a timer: the new generation's turn ENDS after the
        // stale refusal, and the Host durable log still carries zero stale
        // writes — a dispatched superseded write would be ordered before it.
        const liveTurnEnd = await waitForHostSessionEventAfter(
          dshHome,
          sessionA,
          beforeLive,
          event => event.type === 'turn/end',
          'T61 new-generation turn/end',
          120_000,
        )
        assert(liveTurnEnd !== undefined, 'T61 the new generation wrote no turn/end at all')
        // EXACTLY-ONCE is a property of the FINAL durable state, never of the first
        // observation: a duplicate commit that lands after the first sighting would
        // otherwise pass unnoticed. The whole Session log is re-read here, after the
        // new Turn has ENDED, and every count is asserted on that read.
        const finalEvents = hostSessionEvents(dshHome, sessionA) ?? []
        const finalLive = hostUserTexts(finalEvents).filter(text => text === liveToken).length
        assert(finalLive === 1,
          `T61 the new generation committed ${String(finalLive)} times, expected exactly 1`)
        const afterLive = finalEvents.slice(beforeLive)
        const liveStarts = afterLive.filter(event => event.type === 'turn/start').length
        const liveEnds = afterLive.filter(event => event.type === 'turn/end').length
        assert(liveStarts === 1,
          `T61 the new generation started ${String(liveStarts)} Turns, expected exactly 1`)
        assert(liveEnds === 1,
          `T61 the new generation ended ${String(liveEnds)} Turns, expected exactly 1`)
        assert(hostUserTexts(finalEvents).filter(text => text === staleToken).length === 0,
          'T61 the superseded write was dispatched or replayed')
        await parked.waitForScreen('stub answer', 'T61 new-generation answer')
        assert(alive(surfaceHostPid), 'T61 the Host died on the new-generation write')
        // The surface section predates the C1 helpers, so this case uses the
        // same inline exit idiom as T29/T31/T33/T37 above.
        parked.send('/exit\r')
        const parkedExit = await parked.waitForExit(60_000)
        assert(parkedExit.code === 0 && parkedExit.signal === null,
          `T61 parked Client exit was ${JSON.stringify(parkedExit)}`)
        await parked.dispose()
        trace('t61', {
          oldGeneration: generationBefore,
          newGeneration: rolledOver.generationId,
          source: 'real-websocket-drop',
          staleWrite: 'not-dispatched',
          oldHostWrites: 0,
          newHostWrites: 1,
          draftRestoredOnce: true,
          hostIdentityKept: true,
        })
      }

      // T39: a missing official Client Domain module means NO surface ready;
      // the failure is loud and the Host stays alive. (The Host-side missing
      // Session row is T26b and still runs above.)
      const sessionControllerClient = createRequire(anchor).resolve('@deepseek-ai/dsh-api-session-controller/client')
      renameSync(sessionControllerClient, `${sessionControllerClient}.missing`)
      let missingDomain
      try {
        missingDomain = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        surfaceClients.push(missingDomain)
        const failure = await missingDomain.waitFor(record => record.m4a0 === 'failure', 'T39 missing Client Domain module', 120_000)
        assert(!missingDomain.records.some(record => record.m4a0 === 'ready'),
          'T39 a missing official Client Domain module still emitted ready')
        assert(missingDomain.records.find(record => record.m4a0 === 'ready') === undefined,
          'T39 a missing official Client Domain module published a surface')
        assert(/Cannot find module|ERR_MODULE_NOT_FOUND|ENOENT|not found/iu.test(JSON.stringify(failure)),
          `T39 unexpected missing-module error: ${JSON.stringify(failure.error ?? failure)}`)
        assert(alive(surfaceHostPid), 'T39 the missing Client Domain module killed the Host')
        trace('t39', { readyEmitted: false, failure: 'module-missing', hostAlive: true })
      } finally {
        renameSync(`${sessionControllerClient}.missing`, sessionControllerClient)
        await missingDomain?.dispose()
      }

      await surfaceHost.shutdown()
      surfaceHostClosed = true
      assert(!alive(surfaceHostPid), 'T40 the surface Host survived its owner-governed shutdown')
      assert(!existsSync(join(scopeDir, 'instance.json')), 'T40 the Host registry survived its owner-governed shutdown')
      assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
        'T40 the candidate artifact changed during qualification')
      trace('t40', {
        candidate: basename(tarball),
        sha256: candidateSha256,
        dshVersion: targetDshVersion,
        directHelp: 'pass',
        t01t26: 'pass (T26a row-disabled + real artifact-absent; T26b official row; T26 no-cookie)',
        surface: 'T27-T39 + T41/T42/T43 pass',
      })

    // ── Continuity / interactions / Client-only HMR (T44–T60) ─────────────
    // Each scenario starts its OWN Host (one `C1_SCENARIO` per Host process)
    // and records its facts through the isolated fixture. The Client processes
    // are real PTY surfaces over the official authenticated transport.
    const c1Work = writeC1WorkFixture(profileDir, workDir)
    const c1Hosts = []
    const c1Clients = []
    const c1WorkRoot = label => {
      const root = join(workDir, `c1-${label}`)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      return root
    }
    /**
     * The `job` scenarios' release barrier must be visible INSIDE the Job's
     * workspace-write sandbox. bwrap mounts an ephemeral `/tmp` there and
     * binds only the session workspace, which is the installed profile; a
     * barrier under the smoke work dir (also `/tmp`) would be invisible and
     * the Job could never settle. The profile is still inside the isolated
     * OS temp work dir, not the checkout.
     */
    const c1JobWorkRoot = label => {
      const root = join(profileDir, `c1-${label}`)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      return root
    }
    const startC1Host = async (scenario, label, extraEnv = {}, workRoot = c1WorkRoot(label)) => {
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
      const host = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_EXTRA_PATCH: c1Work.patchPath,
          C1_SCENARIO: scenario,
          C1_WORK_ROOT: workRoot,
          ...extraEnv,
        },
      })
      c1Hosts.push(host)
      const ready = await host.waitFor(record => record.m4a0 === 'ready', `${label} Host ready`, 180_000)
      return { host, ready, workRoot }
    }
    const stopC1Host = async host => {
      if (host.exited) return
      try { await host.shutdown() } catch { /* the global backstop kills leftovers */ }
    }
    const startC1Client = async (label, extraEnv = {}) => {
      // A real `surface` Client holds no profile-global Client seat, so a new
      // scenario only has to start its own process and authenticate the Host.
      const client = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, ...extraEnv },
      })
      c1Clients.push(client)
      const ready = await client.waitFor(record => record.m4a0 === 'ready', `${label} Client ready`, 180_000)
      return { client, ready }
    }
    const exitC1Client = async (client, label) => {
      client.send('/exit\r')
      const exit = await client.waitForExit(60_000)
      assert(exit.code === 0 && exit.signal === null, `${label} exit was ${JSON.stringify(exit)}`)
      await client.dispose()
      return exit
    }
    const openC1Session = async (client, prompt, label) => {
      client.send(`${prompt}\r`)
      await client.waitForScreen(prompt, `${label} prompt painted`, 120_000)
      const status = await waitForSurfaceStatus(client, record => record.sessionOpen === true && typeof record.openSessionId === 'string', `${label} session open`)
      return status.openSessionId
    }
    const hostIdentityFacts = async host => (await hostStatus(host)).localHost
    const assertHostIdentityKept = async (host, before, label) => {
      assertIdentityFields(await hostIdentityFacts(host), before, label)
    }
    /**
     * The Loader row identities that carry Host authority or a Host-only
     * business service. Their live `fiber.uid` is the fact a Client-only surface
     * revision must not change: a re-mounted row would publish a new fiber.
     */
    const PROTECTED_HOST_ROWS = [
      'agent',
      'session',
      'job-controller',
      'typert-gateway',
      'split-host-connection',
      'split-host-api-remotes',
      'split-host-file-upload',
      'split-host-session-stats',
      'split-host-turn-outline',
      'split-host-session-controller',
      'split-host-settings-controller',
      'split-host-session-log-download',
      'split-host-pi-tui-runtime',
      'pi-tui-performance-host',
      'pi-tui-visual-tools',
    ]
    /** `id -> live Loader fiber UID` for the ACTIVE protected rows only. */
    const hostRowFiberUids = async host => {
      const status = await hostStatus(host)
      const rows = new Map()
      for (const entry of status.entries ?? []) {
        if (!PROTECTED_HOST_ROWS.includes(entry.id)) continue
        rows.set(entry.id, { state: entry.state, fiberUid: entry.fiberUid })
      }
      return rows
    }
    /**
     * Every protected Host row must still be ACTIVE on the SAME fiber. The UID
     * is mandatory: a lane that only compares row ids accepts a re-mounted
     * Loader and would report a false "Host untouched".
     */
    const assertHostRowsKept = async (host, before, label) => {
      const after = await hostRowFiberUids(host)
      for (const id of PROTECTED_HOST_ROWS) {
        const expected = before.get(id)
        const actual = after.get(id)
        assert(expected !== undefined, `${label}: row "${id}" was not active before the HMR`)
        assert(Number.isInteger(expected.fiberUid), `${label}: row "${id}" reported no live Loader fiber UID`)
        assert(actual !== undefined, `${label}: row "${id}" is no longer active after the HMR`)
        assert(actual.state === 'active', `${label}: row "${id}" left the active state (${actual.state})`)
        assert(Number.isInteger(actual.fiberUid) && actual.fiberUid === expected.fiberUid,
          `${label}: row "${id}" was re-mounted (fiber ${String(expected.fiberUid)} -> ${String(actual.fiberUid)})`)
      }
    }
    /**
     * The Client root's ONE official interaction listener pair. `ready` alone
     * never proves a surface could receive a Question or Approval: the startup
     * gate is the fact that the official `$on` pair exists exactly once before
     * the first forwarded request can arrive.
     */
    const assertInteractionGate = (client, label) => {
      const gate = client.records.find(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate')
      assert(gate !== undefined && gate.phase === 'listeners-ready' && gate.agentResolver === true
        && gate.questionListeners === 1 && gate.approvalListeners === 1 && gate.loaderTasks >= 1,
      `${label} interaction startup gate was not ready before the first generation: ${JSON.stringify(gate)}`)
      assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate').length === 1,
        `${label} registered the interaction startup gate more than once`)
    }

    try {
      // M5B-01 (M5-B): TWO real Surface Clients — distinct `script(1)` PTYs and
      // distinct business PIDs — retain the SAME Host Session X at the same
      // time. A opens X and starts a real Host Turn the fixture holds; B
      // auto-opens the SAME X from its own pty, reads A's durable history and
      // the in-flight Host stream; B queues into the shared Host inbox, A
      // observes it on its own frame and steers it with the existing
      // empty-draft Ctrl+S gesture (official updateQueue over B's occurrence
      // identity); both Clients submit; the same text from two independent
      // real gestures is never merged; A navigates to Y while B keeps writing
      // X; B's normal exit leaves A, the Host and X's durable facts untouched.
      // This is one isolated Host scene so WS-2 and the T44-T66 Cases keep
      // their own Hosts and durable counts.
      {
        const releaseBarrier = join(workDir, 'm5b-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5b-same-session', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5B the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5B A')
        const sessionX = await openC1Session(clientA, 'm5b-seed-a', 'M5B A')
        assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
          'M5B Client A published no live business PID distinct from the Host')
        assert(alive(aReady.pid), 'M5B Client A is not a live business process before B is admitted')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5B held Turn')
        assert(held.agentStatus === 'running',
          `M5B the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5B turn/start')
        assert(!existsSync(releaseBarrier), 'M5B the held Turn was released before the shared-queue proof')
        /** The plain text of one durable/inbox message (bounded, never a payload dump). */
        const textOf = message => (message?.content ?? [])
          .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
          .join('')
        /** The attempt-labelled prefix the fixture paints for one settled answer. */
        const answerPrefix = event => {
          const text = textOf(event?.data?.message)
          const prefix = text.match(/^long-turn answer \d+/u)?.[0]
          assert(prefix !== undefined, `M5B unexpected Host assistant text: ${JSON.stringify(text.slice(0, 80))}`)
          return prefix
        }

        // MB-01: B is a SECOND real pty — its own `script(1)` wrapper and its
        // own business PID — whose startup intent opens the SAME Session X.
        const { client: clientB, ready: bReady } = await startC1Client('M5B B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOpen = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5B B retained the exact Session X')
        assertClientHostFacts(bOpen.host, hostBefore, 'M5B B')
        assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
          'M5B Client B published no live business PID distinct from the Host')
        assert(aReady.pid !== bReady.pid, 'M5B the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid,
          'M5B the two Clients must run under distinct script(1) wrappers')
        assert(aReady.pid !== clientA.child.pid && bReady.pid !== clientB.child.pid,
          'M5B a business PID was mistaken for its script(1) wrapper')
        assert(alive(aReady.pid) && alive(bReady.pid), 'M5B a Client was not a live business process after B was admitted')
        assert(bReady.activeWrappers === 1 && bReady.liveSockets === 1,
          `M5B Client B owns wrappers=${String(bReady.activeWrappers)} sockets=${String(bReady.liveSockets)}`)
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(bReady.owners?.[owner] === 1, `M5B Client B owns ${owner} ${String(bReady.owners?.[owner])}`)
        }
        // B never typed the seed: its painted frame is the shared Host history
        // plus the in-flight Host stream A started before B existed.
        await clientB.waitForScreen('m5b-seed-a', 'M5B B read A\'s durable history', 120_000)
        await clientB.waitForScreen('long-turn started', 'M5B B read the running Host stream', 120_000)
        await clientA.waitForScreen('long-turn started', 'M5B A still shows the running Host stream', 120_000)
        assert(alive(hostBefore.hostPid), 'M5B the Host died while both Clients retained Session X')

        // MB-02: B queues into the shared Host inbox while the Turn is held.
        // A never typed that text, so A's frame can only carry the Host
        // occurrence — never B's client-local optimistic echo.
        const bQueueIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientB.send('m5b-b-queued\r')
        const bQueue = await waitForHostSessionEventAfter(dshHome, sessionX, bQueueIndex,
          event => event.type === 'agent/inbox/spliced'
            && event.data?.target === 'next-turn'
            && (event.data.inserted ?? []).some(message => textOf(message) === 'm5b-b-queued'),
          'M5B B queued into the shared Host inbox',
          120_000)
        const bQueuedItem = (bQueue.data.inserted ?? []).find(message => textOf(message) === 'm5b-b-queued')
        assert(typeof bQueuedItem?.id === 'string' && bQueuedItem.id !== '',
          'M5B the Host queued occurrence carries no identity')
        await clientA.waitForScreen('m5b-b-queued', 'M5B A read B\'s Host pending', 120_000)
        const aOnX = lastSurfaceStatus(clientA)
        assert(aOnX?.sessionOpen === true && aOnX.openSessionId === sessionX
          && aOnX.transport === 'connected', 'M5B Client A left Session X while B was pending')

        // MB-03: the existing empty-draft Ctrl+S is the official FIFO steer-all.
        // It addresses B's Host occurrence, and the Host moves the SAME identity
        // from next-turn into next-step. It never creates an A prompt.
        const steerStart = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('\x13')
        await waitForHostSessionEventAfter(dshHome, sessionX, steerStart,
          event => event.type === 'agent/inbox/spliced'
            && event.data?.target === 'next-turn'
            && event.data?.removedCount === 1
            && (event.data.inserted ?? []).length === 0,
          'M5B Ctrl+S removed B\'s queued occurrence',
          120_000)
        const steered = await waitForHostSessionEventAfter(dshHome, sessionX, steerStart,
          event => event.type === 'agent/inbox/spliced'
            && event.data?.target === 'next-step'
            && (event.data.inserted ?? []).some(message => message?.id === bQueuedItem.id),
          'M5B Ctrl+S steered the exact Host occurrence identity',
          120_000)
        assert((steered.data.inserted ?? []).filter(message => message?.id === bQueuedItem.id).length === 1,
          'M5B the steer path duplicated the Host occurrence')
        const steerEvents = hostSessionEvents(dshHome, sessionX) ?? []
        const queueRemovalIndex = steerEvents.findIndex((event, index) => index >= steerStart
          && event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-turn'
          && event.data?.removedCount === 1
          && (event.data.inserted ?? []).length === 0)
        const steerInsertIndex = steerEvents.findIndex((event, index) => index >= steerStart
          && event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-step'
          && (event.data.inserted ?? []).some(message => message?.id === bQueuedItem.id))
        assert(queueRemovalIndex >= 0 && steerInsertIndex > queueRemovalIndex,
          'M5B Ctrl+S did not move B\'s occurrence from next-turn into next-step')
        assert(!steerEvents.some(event => event.type === 'user/message'
          && textOf(event.data) === 'm5b-b-queued'),
          'M5B the steered occurrence was committed before the running step settled')

        // MB-04: A's own submission enters the same shared queue while the
        // Turn is held; B — which never typed it — reads it on its own frame.
        const aQueueIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('m5b-a-queued\r')
        const aQueue = await waitForHostSessionEventAfter(dshHome, sessionX, aQueueIndex,
          event => event.type === 'agent/inbox/spliced'
            && event.data?.target === 'next-turn'
            && (event.data.inserted ?? []).some(message => textOf(message) === 'm5b-a-queued'),
          'M5B A queued into the shared Host inbox',
          120_000)
        const aQueuedItem = (aQueue.data.inserted ?? []).find(message => textOf(message) === 'm5b-a-queued')
        assert(typeof aQueuedItem?.id === 'string' && aQueuedItem.id !== '',
          'M5B A\'s Host queued occurrence carries no identity')
        await clientB.waitForScreen('m5b-a-queued', 'M5B B read A\'s Host pending', 120_000)
        const bOnX = lastSurfaceStatus(clientB)
        assert(bOnX?.sessionOpen === true && bOnX.openSessionId === sessionX
          && bOnX.transport === 'connected', 'M5B Client B left Session X while A was pending')

        // Release the held Turn ONCE. The steered occurrence is claimed at the
        // next step boundary of the SAME Turn; A's queued occurrence starts the
        // following Turn. Both settlements are durable Host facts.
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const claimedB = await waitForHostSessionEventAfter(dshHome, sessionX, aQueueIndex,
          event => event.type === 'user/message' && event.data?.id === bQueuedItem.id,
          'M5B the steered occurrence was claimed',
          120_000)
        assert(textOf(claimedB.data) === 'm5b-b-queued', 'M5B the steered occurrence changed content')
        const claimedA = await waitForHostSessionEventAfter(dshHome, sessionX, aQueueIndex,
          event => event.type === 'user/message' && event.data?.id === aQueuedItem.id,
          'M5B A\'s queued occurrence was claimed',
          120_000)
        assert(textOf(claimedA.data) === 'm5b-a-queued', 'M5B A\'s queued occurrence changed content')
        const claimEvents = hostSessionEvents(dshHome, sessionX) ?? []
        const bClaimIndex = claimEvents.findIndex(event => event.type === 'user/message' && event.data?.id === bQueuedItem.id)
        const aClaimIndex = claimEvents.findIndex(event => event.type === 'user/message' && event.data?.id === aQueuedItem.id)
        assert(bClaimIndex >= 0 && aClaimIndex > bClaimIndex,
          'M5B the Host did not claim the steered occurrence before the queued Turn')
        const steerAnswer = claimEvents.slice(bClaimIndex, aClaimIndex).find(event => event.type === 'assistant/message')
        assert(steerAnswer !== undefined, 'M5B the steered occurrence produced no Host answer')
        // The queued Turn's own settlement: wait for its durable end, then read
        // its answer. The claim index is the observation boundary, never a timer.
        await waitForHostSessionEventAfter(dshHome, sessionX, aClaimIndex,
          event => event.type === 'turn/end', 'M5B the queued Turn settled', 120_000)
        const settledEvents = hostSessionEvents(dshHome, sessionX) ?? []
        const aAnswer = settledEvents.slice(aClaimIndex).find(event => event.type === 'assistant/message')
        assert(aAnswer !== undefined, 'M5B A\'s queued Turn produced no Host answer')
        for (const [label, client] of [['A', clientA], ['B', clientB]]) {
          await client.waitForScreen(answerPrefix(steerAnswer), `M5B ${label} read the steered settlement`, 120_000)
          await client.waitForScreen(answerPrefix(aAnswer), `M5B ${label} read the queued settlement`, 120_000)
        }
        const queueDurable = hostUserTexts(settledEvents)
        for (const [text, expected] of [['m5b-seed-a', 1], ['m5b-b-queued', 1], ['m5b-a-queued', 1]]) {
          const count = queueDurable.filter(entry => entry === text).length
          assert(count === expected,
            `M5B the Host committed ${JSON.stringify(text)} ${String(count)} time(s), expected ${String(expected)}`)
        }
        assert(settledEvents.filter(event => event.type === 'user/message' && event.data?.id === bQueuedItem.id).length === 1,
          'M5B the steered occurrence was committed more than once')
        assert(settledEvents.filter(event => event.type === 'user/message' && event.data?.id === aQueuedItem.id).length === 1,
          'M5B A\'s queued occurrence was committed more than once')

        // MB-05: the SAME text from two independent real gestures is NOT a Host
        // identity. Sequential submits; the second wait uses the durable length
        // before its own send as the observation boundary.
        const aSameBoundary = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('m5b-same-text\r')
        await clientA.waitForScreen('m5b-same-text', 'M5B A same-text submission painted', 120_000)
        const aSame = await waitForHostSessionEventAfter(dshHome, sessionX, aSameBoundary,
          event => event.type === 'user/message' && textOf(event.data) === 'm5b-same-text',
          'M5B A same-text accepted', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionX, aSameBoundary,
          event => event.type === 'turn/end', 'M5B A same-text Turn settled', 120_000)
        const afterASame = hostSessionEvents(dshHome, sessionX) ?? []
        assert(hostUserTexts(afterASame).filter(text => text === 'm5b-same-text').length === 1,
          'M5B the first same-text submission was lost or duplicated')
        const bSameBoundary = afterASame.length
        clientB.send('m5b-same-text\r')
        const bSame = await waitForHostSessionEventAfter(dshHome, sessionX, bSameBoundary,
          event => event.type === 'user/message' && textOf(event.data) === 'm5b-same-text',
          'M5B B same-text accepted', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionX, bSameBoundary,
          event => event.type === 'turn/end', 'M5B B same-text Turn settled', 120_000)
        const afterBSame = hostSessionEvents(dshHome, sessionX) ?? []
        assert(hostUserTexts(afterBSame).filter(text => text === 'm5b-same-text').length === 2,
          'M5B the Host merged two independent same-text submissions')
        assert(aSame.data?.id !== bSame.data?.id,
          'M5B the two same-text submissions reused one Host message identity')
        const bSameAnswer = afterBSame.slice(bSameBoundary).find(event => event.type === 'assistant/message')
        assert(bSameAnswer !== undefined, 'M5B the second same-text Turn produced no Host answer')
        for (const [label, client] of [['A', clientA], ['B', clientB]]) {
          await client.waitForScreen(answerPrefix(bSameAnswer), `M5B ${label} read the second same-text settlement`, 120_000)
        }

        // MB-06: A navigates to its own new Session Y while B still owns X.
        const xHeaderBefore = await waitForHostSessionHeader(dshHome, sessionX, 'M5B X durable header')
        const aNavigationBoundary = clientA.records.length
        clientA.send('/new\r')
        const aLeft = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= aNavigationBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== sessionX,
          'M5B A navigated away from Session X',
          120_000,
        )
        const sessionY = aLeft.openSessionId
        assert(sessionY !== sessionX, 'M5B A did not leave Session X')
        // A's CURRENT facts: after B was admitted AND after A's own navigation.
        assertClientHostFacts(aLeft.host, hostBefore, 'M5B A after navigation')
        assert(aLeft.transport === 'connected' && aLeft.surfaceMounted === true,
          'M5B Client A lost its transport/surface while navigating')
        assert(aLeft.activeWrappers === 1 && aLeft.liveSockets === 1,
          `M5B Client A owns wrappers=${String(aLeft.activeWrappers)} sockets=${String(aLeft.liveSockets)}`)
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(aLeft.owners?.[owner] === 1, `M5B Client A owns ${owner} ${String(aLeft.owners?.[owner])}`)
        }
        assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
          'M5B a process died during A\'s navigation')
        // Y is A's own new Session in the same Host; A writes there so the
        // separation below is a real write, not an empty selection.
        clientA.send('m5b-y-only\r')
        await clientA.waitForScreen('m5b-y-only', 'M5B A Y prompt painted', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionY, 0,
          event => event.type === 'user/message' && textOf(event.data) === 'm5b-y-only',
          'M5B A wrote Y', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionY, 0,
          event => event.type === 'turn/end', 'M5B A Y Turn settled', 120_000)
        // B still owns X and writes there while A is on Y.
        const bAfterBoundary = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientB.send('m5b-b-after-a-left-x\r')
        await waitForHostSessionEventAfter(dshHome, sessionX, bAfterBoundary,
          event => event.type === 'user/message' && textOf(event.data) === 'm5b-b-after-a-left-x',
          'M5B B wrote X after A left', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionX, bAfterBoundary,
          event => event.type === 'turn/end', 'M5B B X Turn settled', 120_000)
        await clientB.waitForScreen('m5b-b-after-a-left-x', 'M5B B X write painted', 120_000)
        const bAfterEvents = hostSessionEvents(dshHome, sessionX) ?? []
        const bAfterAnswer = bAfterEvents.slice(bAfterBoundary).find(event => event.type === 'assistant/message')
        assert(bAfterAnswer !== undefined, 'M5B B\'s X write produced no Host answer')
        await clientB.waitForScreen(answerPrefix(bAfterAnswer), 'M5B B read its X settlement', 120_000)
        const bStillOnX = lastSurfaceStatus(clientB)
        assert(bStillOnX?.sessionOpen === true && bStillOnX.openSessionId === sessionX
          && bStillOnX.transport === 'connected', 'M5B B lost Session X when A navigated')
        const aOnY = lastSurfaceStatus(clientA)
        assert(aOnY?.sessionOpen === true && aOnY.openSessionId === sessionY,
          'M5B A is not on its own Session Y')
        // A's Y frame can never carry B's X-only text; Y's durable log neither.
        assert(!(await clientA.viewport()).join('\n').includes('m5b-b-after-a-left-x'),
          'M5B A painted B\'s X-only write on Y')
        assert(!(hostSessionEvents(dshHome, sessionY) ?? []).some(event => event.type === 'user/message'
          && textOf(event.data) === 'm5b-b-after-a-left-x'),
          'M5B B\'s X write leaked into Session Y')
        // X's immutable header (id/createdAt/cwd) never moved.
        const xHeaderAfter = await waitForHostSessionHeader(dshHome, sessionX, 'M5B X durable header after A left')
        assert(JSON.stringify(xHeaderAfter) === JSON.stringify(xHeaderBefore),
          'M5B A leaving X changed the durable Session header/workspace')
        await assertHostIdentityKept(host, hostBefore, 'M5B Host after A navigated')

        // MB-07: B's normal exit releases ONLY B while A (on Y), the Host and
        // X's durable facts stay live.
        clientB.send('/exit\r')
        const bExit = await clientB.waitForExit(60_000)
        assert(bExit.code === 0 && bExit.signal === null, `M5B Client B exit was ${JSON.stringify(bExit)}`)
        const bClosed = await clientB.waitFor(record => record.m4b2s === 'client-closed', 'M5B B client-closed', 30_000)
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(bClosed.owners?.[owner] === 0, `M5B Client B left ${owner} alive after its normal exit`)
        }
        assert(bClosed.sessionOpen === false && bClosed.surfaceMounted === false,
          'M5B Client B still claimed an open surface/Session after its normal exit')
        assert(bClosed.activeWrappers === 0 && bClosed.liveSockets === 0,
          'M5B Client B still owned transport wrappers/sockets after its normal exit')
        await clientB.dispose()
        assert(alive(aReady.pid), 'M5B Client A died when Client B exited')
        assert(alive(hostBefore.hostPid), 'M5B the Host died when Client B exited')
        await assertHostIdentityKept(host, hostBefore, 'M5B Host after B exit')
        // A can still read AND write Y after B is gone.
        assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY, 'M5B A lost Session Y when B exited')
        const yAfterBoundary = (hostSessionEvents(dshHome, sessionY) ?? []).length
        clientA.send('m5b-y-after-b-exit\r')
        await clientA.waitForScreen('m5b-y-after-b-exit', 'M5B A Y prompt after B exit painted', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionY, yAfterBoundary,
          event => event.type === 'user/message' && textOf(event.data) === 'm5b-y-after-b-exit',
          'M5B A wrote Y after B exited', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionY, yAfterBoundary,
          event => event.type === 'turn/end', 'M5B A Y Turn after B exit settled', 120_000)

        // Final durable accounting on the COMPLETE logs after every Turn
        // settled: two same-text submits stay two, nothing crossed Sessions.
        const xFinal = hostSessionEvents(dshHome, sessionX) ?? []
        const xTexts = hostUserTexts(xFinal)
        for (const [text, expected] of [
          ['m5b-seed-a', 1],
          ['m5b-b-queued', 1],
          ['m5b-a-queued', 1],
          ['m5b-same-text', 2],
          ['m5b-b-after-a-left-x', 1],
        ]) {
          const count = xTexts.filter(entry => entry === text).length
          assert(count === expected,
            `M5B Session X committed ${JSON.stringify(text)} ${String(count)} time(s), expected ${String(expected)}`)
        }
        // The Session's own runtime/time context rows are also official
        // `user/message` events: the human-write accounting below is scoped to
        // THIS case's prefixes, never a raw total that would count them.
        const xHumanTexts = xTexts.filter(entry => entry.startsWith('m5b-'))
        assert(xHumanTexts.length === 6,
          `M5B Session X carried ${String(xHumanTexts.length)} m5b-* user messages, expected 6`)
        assert(xTexts.every(entry => entry !== 'm5b-y-only' && entry !== 'm5b-y-after-b-exit'),
          'M5B a Y-only write leaked into Session X')
        const yFinal = hostUserTexts(hostSessionEvents(dshHome, sessionY) ?? [])
        assert(yFinal.filter(entry => entry === 'm5b-y-only').length === 1
          && yFinal.filter(entry => entry === 'm5b-y-after-b-exit').length === 1,
          'M5B Session Y lost one of A\'s own writes')
        assert(yFinal.every(entry => !['m5b-seed-a', 'm5b-b-queued', 'm5b-a-queued', 'm5b-same-text', 'm5b-b-after-a-left-x'].includes(entry)),
          'M5B an X-only write leaked into Session Y')

        await exitC1Client(clientA, 'M5B A')
        await stopC1Host(host)
        trace('m5b-same-session', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          sessionY,
          sameHost: true,
          distinctPtys: true,
          hostUserMessages: { seed: 1, bQueued: 1, aQueued: 1, sameText: 2, bAfterALeftX: 1 },
          queueSteer: 'B occurrence moved next-turn -> next-step; claimed once',
          sameTextCommitCount: 2,
          bWroteXAfterALeft: true,
          yOnlyWrites: 2,
          clientBNormalExit: bExit.code,
          clientBResourcesReleased: true,
          clientAKept: true,
          hostIdentityKept: true,
        })
      }

      // M5C-01 (M5-C): TWO REAL Surface Clients — distinct `script(1)` PTYs,
      // distinct business PIDs and one installed official interaction-provider
      // pair each — are admitted to the SAME Host Session X BEFORE the Host
      // asks. ONE Host Question/Approval reaches BOTH real modals, the winner's
      // ONE real keyboard decision settles the ONE Host waterfall, and the
      // loser's presentation is withdrawn by the official Gateway cancellation
      // so its later key cannot produce a second Host result.
      //
      // Three fixed scenes, each with its own Host, empty Session X and work
      // root: Question won by A (M5C-01Q), Approval-Reject won by B (M5C-01AR)
      // and Approval-Allow won by A (M5C-01AA). Both Approval scenes use the
      // same real `approval-allow` Host workload: the outcome is decided by the
      // real Client keyboards, never by a second Host scenario pretending a
      // refusal.
      {
        /**
         * Admit both real Clients onto one EMPTY Host Session X without asking
         * anything yet. A creates X with the REAL product `/new` command, which
         * creates an empty Session without submitting a model prompt; B then
         * joins the SAME X through its own startup intent. `openC1Session` is
         * forbidden here: it submits the first prompt immediately, so the Host
         * could ask before B exists and the scene would only prove a replay.
         *
         * The returned scene is not evidence by itself: the Host must carry no
         * turn/tool call/approval and the fixture no request before the caller
         * sends the ONE trigger prompt.
         */
        const admitM5cDualSurfaceScene = async (scenario, label) => {
          const { host, ready: hostReady, workRoot } = await startC1Host(scenario, label)
          const hostBefore = await hostIdentityFacts(host)
          assert(hostBefore.hostPid === hostReady.pid,
            `${label} the Host ready record does not own the Host identity`)
          const { client: clientA, ready: aReady } = await startC1Client(`${label} A`)
          const aBoundary = clientA.records.length
          clientA.send('/new\r')
          const aOpen = await clientA.waitFor(
            record => clientA.records.indexOf(record) >= aBoundary
              && record.m4b2s === 'surface-status'
              && record.sessionOpen === true
              && typeof record.openSessionId === 'string'
              && record.openSessionId !== ''
              && record.transport === 'connected'
              && record.surfaceMounted === true,
            `${label} Client A opened an empty Session`,
            120_000,
          )
          const sessionX = aOpen.openSessionId
          assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
            `${label} Client A published no live business PID distinct from the Host`)
          assert(alive(aReady.pid), `${label} Client A is not a live business process`)
          assert(aReady.activeWrappers === 1 && aReady.liveSockets === 1,
            `${label} Client A owns wrappers=${String(aReady.activeWrappers)} sockets=${String(aReady.liveSockets)}`)
          for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
            assert(aReady.owners?.[owner] === 1, `${label} Client A owns ${owner} ${String(aReady.owners?.[owner])}`)
          }
          assertInteractionGate(clientA, `${label} Client A`)
          const { client: clientB, ready: bReady } = await startC1Client(`${label} B`, {
            SPLIT_PROCESS_CLIENT_SESSION: sessionX,
          })
          const bOpen = await waitForSurfaceStatus(clientB, record => record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true, `${label} Client B retained Session X`)
          assertClientHostFacts(aOpen.host, hostBefore, `${label} Client A`)
          assertClientHostFacts(bOpen.host, hostBefore, `${label} Client B`)
          assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
            `${label} Client B published no live business PID distinct from the Host`)
          assert(aReady.pid !== bReady.pid, `${label} the two Clients must be two different business PIDs`)
          assert(clientA.child.pid !== clientB.child.pid,
            `${label} the two Clients must run under distinct script(1) wrappers`)
          assert(aReady.pid !== clientA.child.pid && bReady.pid !== clientB.child.pid,
            `${label} a business PID was mistaken for its script(1) wrapper`)
          assert(alive(aReady.pid) && alive(bReady.pid),
            `${label} a Client was not a live business process after B was admitted`)
          assert(bReady.activeWrappers === 1 && bReady.liveSockets === 1,
            `${label} Client B owns wrappers=${String(bReady.activeWrappers)} sockets=${String(bReady.liveSockets)}`)
          for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
            assert(bReady.owners?.[owner] === 1, `${label} Client B owns ${owner} ${String(bReady.owners?.[owner])}`)
          }
          assertInteractionGate(clientB, `${label} Client B`)
          const pendingBefore = hostSessionEvents(dshHome, sessionX) ?? []
          assert(!pendingBefore.some(event => event.type === 'turn/start' || event.type === 'tool/call'
            || event.type === 'approval/asked'),
          `${label} Host Session X carried Host activity before the trigger`)
          assert(readC1WorkEvents(workRoot).every(event => event.kind !== 'question-request'
            && event.kind !== 'approval-request'),
          `${label} the Host asked before both real Clients were admitted`)
          assert(alive(hostBefore.hostPid), `${label} the Host died while both Clients were admitted`)
          return { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX }
        }

        // M5C-01Q: the Host's non-timed foreground Question reaches both real
        // modals; A answers through the REAL review page; B's modal is withdrawn
        // and its later option key is inert. The durable `tool/call.callId` ties
        // the ONE question tool call to its ONE `tool/result` — a non-timed ask
        // carries no `wait.callId`, so the waterfall record cannot be the
        // correlation authority here.
        {
          const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX } =
            await admitM5cDualSurfaceScene('question', 'm5c-question')
          // The ONE trigger is A's real keyboard submission AFTER both Clients
          // are ready and nothing is pending.
          const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientA.send('m5c-question-trigger\r')
          const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
            event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
            'M5C question tool/call', 120_000)
          // Validate the DURABLE field BEFORE touching it: a missing/foreign
          // value coerced with String() would become the fabricated 'undefined'
          // and silently pass every correlation below.
          assert(typeof call.data.callId === 'string' && call.data.callId !== '',
            'M5C the question tool/call carries no callId')
          const callId = call.data.callId
          const request = await waitForC1WorkEvent(workRoot,
            event => event.kind === 'question-request' && event.sessionId === sessionX,
            'M5C Host question request', 120_000)
          assert(request.questions?.[0]?.question === 'Continue the C1 test?',
            `M5C unexpected Host question payload: ${JSON.stringify(request.questions?.[0]?.question)}`)
          assert((request.questions?.[0]?.options ?? []).map(option => option?.label).join('|') === 'Proceed|Cancel',
            'M5C the Host question options are not the fixture Proceed/Cancel pair')
          const requestsBeforeAnswer = readC1WorkEvents(workRoot)
            .filter(event => event.kind === 'question-request' && event.sessionId === sessionX)
          assert(requestsBeforeAnswer.length === 1,
            `M5C the Host asked ${String(requestsBeforeAnswer.length)} times before any answer`)
          // BOTH physically distinct PTYs must paint the same ANSWERABLE modal
          // BEFORE the winner types anything.
          await clientA.waitForScreen('[1] Proceed', 'M5C A question modal', 120_000)
          await clientB.waitForScreen('[1] Proceed', 'M5C B question modal', 120_000)
          assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
            'M5C Client A painted no question text')
          assert((await clientB.viewport()).join('\n').includes('Continue the C1 test?'),
            'M5C Client B painted no question text')
          // A answers through the REAL QuestionFlow review page, never the port.
          const answerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientA.send('1')
          await clientA.waitForScreen('Review your answer before submit', 'M5C A question review', 30_000)
          clientA.send('\r')
          const settled = await waitForC1WorkEvent(workRoot,
            event => event.kind === 'question-settled' && event.sessionId === sessionX,
            'M5C Host question settled', 120_000)
          assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
            `M5C the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
          const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
            event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
            'M5C question tool result', 120_000)
          assert(result.data?.message?.isError !== true, 'M5C the answered question failed at the Host')
          await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
            event => event.type === 'turn/end', 'M5C question turn/end', 120_000)
          for (const [side, client] of [['A', clientA], ['B', clientB]]) {
            await client.waitForScreen('question answered', `M5C ${side} read the Host settlement`, 120_000)
          }
          // B lost the SAME Host delivery: the official Gateway cancellation
          // withdrew its CURRENT modal and returned the editor seat without a
          // local Esc or decision.
          await clientB.waitForScreenGone('[1] Proceed', 'M5C B question modal withdrawn', 120_000)
          const bAfterWithdraw = (await clientB.viewport()).join('\n')
          assert(!bAfterWithdraw.includes('Review your answer before submit'),
            'M5C loser B opened the question review page')
          assert(!bAfterWithdraw.includes('○ Submit') && !bAfterWithdraw.includes('✓ Submit'),
            'M5C loser B still paints the question Submit tab')
          clientB.send('m5c-b-editor-after-question')
          await clientB.waitForComposerDraft('m5c-b-editor-after-question', 30_000)
          clientB.send('\x15')
          await clientB.waitForScreenGone('m5c-b-editor-after-question', 'M5C loser B cleared its editor draft', 30_000)
          // The old option key is ordinary editor text now: clearing it must not
          // create a second Host answer or reopen the settled modal.
          const lateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientB.send('2')
          await sleep(300)
          clientB.send('\x15')
          await sleep(300)
          assert(!(await clientB.viewport()).join('\n').includes('[1] Proceed'),
            'M5C a late loser option key reopened the settled question modal')
          assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(lateIndex)
            .every(event => event.type !== 'tool/call' && event.type !== 'tool/result'
              && event.type !== 'turn/start' && event.type !== 'turn/end'),
          'M5C a late loser key produced Host activity')
          assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
            'M5C a process died during the question first-settlement proof')
          assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
            && lastSurfaceStatus(clientB)?.openSessionId === sessionX,
          'M5C a Client left Session X after the first settlement')
          await assertHostIdentityKept(host, hostBefore, 'M5C Host after the question first settlement')
          // B exits normally; A, the Host and X's durable facts stay live, and a
          // NEW durable snapshot after the exit still carries exactly one answer.
          await exitC1Client(clientB, 'M5C question B')
          assert(alive(aReady.pid), 'M5C Client A died when Client B exited')
          assert(alive(hostBefore.hostPid), 'M5C the Host died when Client B exited')
          assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
            && lastSurfaceStatus(clientA)?.transport === 'connected',
          'M5C Client A lost Session X when Client B exited')
          const afterExitEvents = hostSessionEvents(dshHome, sessionX) ?? []
          assert(afterExitEvents.filter(event => event.type === 'tool/result'
            && String(event.data?.message?.toolCallId) === callId).length === 1,
          'M5C the question produced a second Host tool result after the loser exited')
          const afterExitProofs = readC1WorkEvents(workRoot)
          assert(afterExitProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1
            && afterExitProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
          'M5C the question request/settlement pair changed after the loser exited')
          await exitC1Client(clientA, 'M5C question A')
          const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
          const finalProofs = readC1WorkEvents(workRoot)
          assert(finalProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1
            && finalProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
          'M5C the question was not settled exactly once')
          assert(finalProofs.every(event => event.kind !== 'question-failed'),
            'M5C a legal first answer was recorded as a failed Host question')
          assert(finalEvents.filter(event => event.type === 'tool/call'
            && event.data?.name === 'ask_user_question').length === 1,
          'M5C the Host asked more than once for one question tool call')
          assert(finalEvents.filter(event => event.type === 'tool/result'
            && String(event.data?.message?.toolCallId) === callId).length === 1,
          'M5C the Host wrote more than one tool result for the question call')
          await stopC1Host(host)
          // A swallowed shutdown is NOT a normal end: the Host entry exits 0
          // only when its official owner shutdown completed without any
          // cleanup failure, so the M5-C scene must assert the real result.
          assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
            `M5C the Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
          trace('m5c-01q', {
            hostPid: hostBefore.hostPid,
            clientAPid: aReady.pid,
            clientBPid: bReady.pid,
            wrapperPids: [clientA.child.pid, clientB.child.pid],
            sessionX,
            questionCallId: callId,
            bothPtysSawQuestion: true,
            winner: 'A',
            hostSettlements: 1,
            loserWithdrawn: true,
            loserLateKeyInert: true,
            sameHostBeforeAfter: true,
            clientsExitedNormally: true,
            hostExitCode: host.exitResult.code,
          })
        }

        // M5C-01AR: the SAME ApprovalSheet is live in both real modals; B's
        // rejection wins the ONE Host waterfall, A's later `y` cannot allow the
        // command, and no marker may ever exist for this refusal.
        {
          const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX } =
            await admitM5cDualSurfaceScene('approval-allow', 'm5c-approval-reject')
          const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientA.send('m5c-approval-reject-trigger\r')
          const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
            event => event.type === 'tool/call' && event.data?.name === 'bash',
            'M5C AR bash tool/call', 120_000)
          assert(typeof call.data.callId === 'string' && call.data.callId !== '',
            'M5C AR the bash tool/call carries no callId')
          const toolCallId = call.data.callId
          const asked = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
            event => event.type === 'approval/asked', 'M5C AR approval/asked', 120_000)
          const requestId = String(asked.data.id)
          assert(typeof asked.data.id === 'string' && asked.data.id !== '',
            'M5C AR the Host approval request carries no ApprovalRequestId')
          assert(asked.data.callId === undefined || String(asked.data.callId) === toolCallId,
            'M5C AR the approval/asked call correlation does not name the bash tool call')
          const request = await waitForC1WorkEvent(workRoot,
            event => event.kind === 'approval-request' && event.sessionId === sessionX,
            'M5C AR Host approval request', 120_000)
          assert(request.toolName === 'bash', 'M5C AR the approval is not for the official bash tool')
          assert(String(request.callId) === toolCallId,
            'M5C AR the fixture approval request names another tool call')
          const askedBeforeDecision = (hostSessionEvents(dshHome, sessionX) ?? [])
            .filter(event => event.type === 'approval/asked')
          assert(askedBeforeDecision.length === 1,
            `M5C AR the Host asked ${String(askedBeforeDecision.length)} approvals before any decision`)
          // BOTH physically distinct PTYs must paint the same ANSWERABLE sheet.
          await clientA.waitForScreen('[y] Allow once', 'M5C AR A approval sheet', 120_000)
          await clientB.waitForScreen('[y] Allow once', 'M5C AR B approval sheet', 120_000)
          assert((await clientA.viewport()).join('\n').includes('[n] Reject'),
            'M5C AR Client A painted no reject action')
          assert((await clientB.viewport()).join('\n').includes('[n] Reject'),
            'M5C AR Client B painted no reject action')
          const decideIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientB.send('n')
          const decided = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
            event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
            'M5C AR approval/decided', 120_000)
          assert(decided.data.outcome === 'rejected',
            `M5C AR the first Host outcome was ${JSON.stringify(decided.data.outcome)}`)
          const settlement = await waitForC1WorkEvent(workRoot,
            event => event.kind === 'approval-settled' && event.outcome === 'rejected',
            'M5C AR rejected settlement', 60_000)
          assert(String(settlement.callId) === toolCallId,
            'M5C AR the rejected settlement names another tool call')
          assert(readC1WorkEvents(workRoot).every(event => event.kind !== 'approval-failed'),
            'M5C AR the approval failed at the Host instead of settling rejected')
          // The official denied tool result is written; the command NEVER runs.
          const denied = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
            event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
            'M5C AR denied tool result', 120_000)
          assert(denied.data?.message?.isError === true,
            'M5C AR a rejected approval still executed the bash tool')
          await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
            event => event.type === 'turn/end', 'M5C AR turn/end', 120_000)
          for (const [side, client] of [['A', clientA], ['B', clientB]]) {
            await client.waitForScreen('approval settled', `M5C AR ${side} read the Host settlement`, 120_000)
          }
          assert(!existsSync(join(workRoot, 'approval-allow.marker')),
            'M5C AR the rejected harmless command executed')
          // A lost the SAME Host delivery: its sheet is withdrawn; the later
          // `y` is ordinary editor text and must not allow or re-decide.
          await clientA.waitForScreenGone('[y] Allow once', 'M5C AR loser A sheet withdrawn', 120_000)
          assert(!(await clientA.viewport()).join('\n').includes('[n] Reject'),
            'M5C AR loser A still paints the approval actions')
          clientA.send('m5c-a-editor-after-approval')
          await clientA.waitForComposerDraft('m5c-a-editor-after-approval', 30_000)
          clientA.send('\x15')
          await clientA.waitForScreenGone('m5c-a-editor-after-approval', 'M5C AR loser A cleared its editor draft', 30_000)
          const lateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientA.send('y')
          await sleep(300)
          clientA.send('\x15')
          await sleep(300)
          assert(!(await clientA.viewport()).join('\n').includes('[y] Allow once'),
            'M5C AR a late loser key reopened the settled ApprovalSheet')
          const decisions = (hostSessionEvents(dshHome, sessionX) ?? [])
            .filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
          assert(decisions.length === 1 && decisions[0].data.outcome === 'rejected',
            'M5C AR the late loser allow produced a second/changed Host decision')
          assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(lateIndex)
            .every(event => event.type !== 'approval/decided' && event.type !== 'tool/result'),
          'M5C AR a late loser key produced Host activity')
          assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'approval-settled'
            && event.outcome === 'allowed-once')),
          'M5C AR the late loser key settled an allowed approval')
          assert(!existsSync(join(workRoot, 'approval-allow.marker')),
            'M5C AR the late loser key executed the rejected command')
          assert((hostSessionEvents(dshHome, sessionX) ?? []).filter(event => event.type === 'tool/result'
            && String(event.data?.message?.toolCallId) === toolCallId).length === 1,
          'M5C AR the rejected tool call produced a second Host result')
          assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
            'M5C AR a process died during the approval first-settlement proof')
          assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
            && lastSurfaceStatus(clientB)?.openSessionId === sessionX,
          'M5C AR a Client left Session X after the first settlement')
          await assertHostIdentityKept(host, hostBefore, 'M5C AR Host after the approval first settlement')
          await exitC1Client(clientA, 'M5C AR A')
          assert(alive(bReady.pid), 'M5C AR Client B died when the loser exited')
          assert(alive(hostBefore.hostPid), 'M5C AR the Host died when the loser exited')
          await exitC1Client(clientB, 'M5C AR B')
          const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
          const finalProofs = readC1WorkEvents(workRoot)
          assert(finalEvents.filter(event => event.type === 'approval/asked'
            && String(event.data?.id) === requestId).length === 1
            && finalEvents.filter(event => event.type === 'approval/decided'
              && String(event.data?.id) === requestId && event.data?.outcome === 'rejected').length === 1,
          'M5C AR the approval was not asked/decided exactly once as rejected')
          assert(finalProofs.filter(event => event.kind === 'approval-settled').length === 1
            && finalProofs.filter(event => event.kind === 'approval-failed').length === 0,
          'M5C AR the fixture settlement was not exactly one rejection')
          assert(!existsSync(join(workRoot, 'approval-allow.marker')),
            'M5C AR a marker appeared for the refused command')
          await stopC1Host(host)
          assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
            `M5C AR the Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
          trace('m5c-01ar', {
            hostPid: hostBefore.hostPid,
            clientAPid: aReady.pid,
            clientBPid: bReady.pid,
            wrapperPids: [clientA.child.pid, clientB.child.pid],
            sessionX,
            approvalRequestId: requestId,
            toolCallId,
            bothPtysSawApproval: true,
            winner: 'B',
            hostOutcome: 'rejected',
            decisions: 1,
            marker: false,
            loserWithdrawn: true,
            loserLateAllowInert: true,
            sameHostBeforeAfter: true,
            clientsExitedNormally: true,
            hostExitCode: host.exitResult.code,
          })
        }

        // M5C-01AA: the SAME ApprovalSheet is live in both real modals; A's
        // allow wins the ONE Host waterfall and executes the harmless command
        // exactly once; B's later `n` neither reverses the settlement nor adds
        // a decision or a second execution.
        {
          const { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX } =
            await admitM5cDualSurfaceScene('approval-allow', 'm5c-approval-allow')
          const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientA.send('m5c-approval-allow-trigger\r')
          const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
            event => event.type === 'tool/call' && event.data?.name === 'bash',
            'M5C AA bash tool/call', 120_000)
          assert(typeof call.data.callId === 'string' && call.data.callId !== '',
            'M5C AA the bash tool/call carries no callId')
          const toolCallId = call.data.callId
          const asked = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
            event => event.type === 'approval/asked', 'M5C AA approval/asked', 120_000)
          const requestId = String(asked.data.id)
          assert(typeof asked.data.id === 'string' && asked.data.id !== '',
            'M5C AA the Host approval request carries no ApprovalRequestId')
          assert(asked.data.callId === undefined || String(asked.data.callId) === toolCallId,
            'M5C AA the approval/asked call correlation does not name the bash tool call')
          const request = await waitForC1WorkEvent(workRoot,
            event => event.kind === 'approval-request' && event.sessionId === sessionX,
            'M5C AA Host approval request', 120_000)
          assert(request.toolName === 'bash', 'M5C AA the approval is not for the official bash tool')
          assert(String(request.callId) === toolCallId,
            'M5C AA the fixture approval request names another tool call')
          const askedBeforeDecision = (hostSessionEvents(dshHome, sessionX) ?? [])
            .filter(event => event.type === 'approval/asked')
          assert(askedBeforeDecision.length === 1,
            `M5C AA the Host asked ${String(askedBeforeDecision.length)} approvals before any decision`)
          await clientA.waitForScreen('[y] Allow once', 'M5C AA A approval sheet', 120_000)
          await clientB.waitForScreen('[y] Allow once', 'M5C AA B approval sheet', 120_000)
          assert((await clientA.viewport()).join('\n').includes('[n] Reject'),
            'M5C AA Client A painted no reject action')
          assert((await clientB.viewport()).join('\n').includes('[n] Reject'),
            'M5C AA Client B painted no reject action')
          const decideIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientA.send('y')
          const decided = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
            event => event.type === 'approval/decided' && String(event.data?.id) === requestId,
            'M5C AA approval/decided', 120_000)
          assert(decided.data.outcome === 'allowed-once',
            `M5C AA the first Host outcome was ${JSON.stringify(decided.data.outcome)}`)
          const settlement = await waitForC1WorkEvent(workRoot,
            event => event.kind === 'approval-settled' && event.outcome === 'allowed-once',
            'M5C AA allowed-once settlement', 60_000)
          assert(String(settlement.callId) === toolCallId,
            'M5C AA the allowed settlement names another tool call')
          assert(readC1WorkEvents(workRoot).every(event => event.kind !== 'approval-failed'),
            'M5C AA the approval failed at the Host instead of settling allowed-once')
          const executed = await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
            event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolCallId,
            'M5C AA executed tool result', 120_000)
          assert(executed.data?.message?.isError !== true,
            'M5C AA the allowed harmless command reported a failed Host result')
          const marker = join(workRoot, 'approval-allow.marker')
          assert(existsSync(marker), 'M5C AA the allowed harmless command did not execute')
          assert(readFileSync(marker, 'utf8') === 'c1-approval-allow',
            'M5C AA the executed marker does not carry the fixture payload')
          await waitForHostSessionEventAfter(dshHome, sessionX, decideIndex,
            event => event.type === 'turn/end', 'M5C AA turn/end', 120_000)
          for (const [side, client] of [['A', clientA], ['B', clientB]]) {
            await client.waitForScreen('approval settled', `M5C AA ${side} read the Host settlement`, 120_000)
          }
          // B lost the SAME Host delivery: its sheet is withdrawn; the later
          // `n` is ordinary editor text and must not reverse anything.
          await clientB.waitForScreenGone('[y] Allow once', 'M5C AA loser B sheet withdrawn', 120_000)
          assert(!(await clientB.viewport()).join('\n').includes('[n] Reject'),
            'M5C AA loser B still paints the approval actions')
          clientB.send('m5c-b-editor-after-approval')
          await clientB.waitForComposerDraft('m5c-b-editor-after-approval', 30_000)
          clientB.send('\x15')
          await clientB.waitForScreenGone('m5c-b-editor-after-approval', 'M5C AA loser B cleared its editor draft', 30_000)
          const lateIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
          clientB.send('n')
          await sleep(300)
          clientB.send('\x15')
          await sleep(300)
          assert(!(await clientB.viewport()).join('\n').includes('[y] Allow once'),
            'M5C AA a late loser key reopened the settled ApprovalSheet')
          const decisions = (hostSessionEvents(dshHome, sessionX) ?? [])
            .filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
          assert(decisions.length === 1 && decisions[0].data.outcome === 'allowed-once',
            'M5C AA the late loser reject produced a second/changed Host decision')
          assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(lateIndex)
            .every(event => event.type !== 'approval/decided' && event.type !== 'tool/result'),
          'M5C AA a late loser key produced Host activity')
          assert(readC1WorkEvents(workRoot).filter(event => event.kind === 'approval-settled'
            && event.outcome === 'allowed-once').length === 1,
          'M5C AA the late loser key settled a second allowed approval')
          assert(readFileSync(marker, 'utf8') === 'c1-approval-allow',
            'M5C AA the marker changed after the late loser key')
          assert((hostSessionEvents(dshHome, sessionX) ?? []).filter(event => event.type === 'tool/result'
            && String(event.data?.message?.toolCallId) === toolCallId).length === 1,
          'M5C AA the approved tool call produced a second Host result')
          assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
            'M5C AA a process died during the approval first-settlement proof')
          assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX
            && lastSurfaceStatus(clientB)?.openSessionId === sessionX,
          'M5C AA a Client left Session X after the first settlement')
          await assertHostIdentityKept(host, hostBefore, 'M5C AA Host after the approval first settlement')
          await exitC1Client(clientB, 'M5C AA B')
          assert(alive(aReady.pid), 'M5C AA Client A died when the loser exited')
          assert(alive(hostBefore.hostPid), 'M5C AA the Host died when the loser exited')
          await exitC1Client(clientA, 'M5C AA A')
          const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
          const finalProofs = readC1WorkEvents(workRoot)
          assert(finalEvents.filter(event => event.type === 'approval/asked'
            && String(event.data?.id) === requestId).length === 1
            && finalEvents.filter(event => event.type === 'approval/decided'
              && String(event.data?.id) === requestId && event.data?.outcome === 'allowed-once').length === 1,
          'M5C AA the approval was not asked/decided exactly once as allowed-once')
          assert(finalProofs.filter(event => event.kind === 'approval-settled').length === 1
            && finalProofs.filter(event => event.kind === 'approval-failed').length === 0,
          'M5C AA the fixture settlement was not exactly one approval')
          assert(existsSync(marker) && readFileSync(marker, 'utf8') === 'c1-approval-allow',
            'M5C AA the final marker did not survive the normal exits')
          await stopC1Host(host)
          assert(host.exited === true && host.exitResult?.code === 0 && host.exitResult?.signal === null,
            `M5C AA the Host did not shut down normally: ${JSON.stringify(host.exitResult)}`)
          trace('m5c-01aa', {
            hostPid: hostBefore.hostPid,
            clientAPid: aReady.pid,
            clientBPid: bReady.pid,
            wrapperPids: [clientA.child.pid, clientB.child.pid],
            sessionX,
            approvalRequestId: requestId,
            toolCallId,
            bothPtysSawApproval: true,
            winner: 'A',
            hostOutcome: 'allowed-once',
            decisions: 1,
            marker: true,
            loserWithdrawn: true,
            loserLateRejectInert: true,
            sameHostBeforeAfter: true,
            clientsExitedNormally: true,
            hostExitCode: host.exitResult.code,
          })
        }
      }

      // M5N-01 (M5-N): Split Remote navigation is NON-DESTRUCTIVE. ONE real
      // Host and REAL Surface Clients (`script(1)` PTYs, distinct business
      // PIDs) prove that `/new` and `/resume` never stop — and never wait for
      // — the Host Turn a Client leaves: the held X Turn keeps streaming and
      // ends with its normal `completed` reason after the navigating Client
      // moved, a RUNNING target is projected immediately instead of being
      // waited to idle, a Host-queued occurrence stays with its own Session,
      // an already-current switch is a no-op, and an explicit Busy Esc still
      // cancels the exact Host Turn (the negative control). The fixture's held
      // `long-turn` barrier is the ONLY thing that lets a held Turn continue,
      // so a replayed write or a timer cannot produce these facts.
      {
        const releaseBarrier = join(workDir, 'm5n-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5n-navigation', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5N the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5N A')
        assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
          'M5N Client A published no live business PID distinct from the Host')
        assert(aReady.pid !== clientA.child.pid, 'M5N a business PID was mistaken for its script(1) wrapper')
        /** The plain text of one durable/inbox message (bounded, never a payload dump). */
        const textOf = message => (message?.content ?? [])
          .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
          .join('')
        const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
        /** Wait for the Nth `turn/end` at or after one durable boundary. */
        const waitForTurnEnds = async (sessionId, afterIndex, count, label) => {
          await waitForCondition(
            () => durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end').length >= count,
            label,
            120_000,
          )
          return durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end')
        }

        // The seed Turn IS the running Turn every navigation below leaves: the
        // fixture holds it until the release barrier exists.
        const sessionX = await openC1Session(clientA, 'm5n-x-held', 'M5N A')
        const heldX = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5N X Turn held')
        assert(heldX.agentStatus === 'running',
          `M5N the Host Agent was ${JSON.stringify(heldX.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5N X turn/start')
        const xHeaderBefore = await waitForHostSessionHeader(dshHome, sessionX, 'M5N X durable header')
        const sessionsBeforeNew = hostSessionLogCount(dshHome)
        assert(!existsSync(releaseBarrier), 'M5N the held Turn was released before the first navigation')

        // NB-01 (N-02): `/new` while X RUNS. The new Session commits while X's
        // Turn is still held, so the switch cannot have waited for X to go
        // idle, and no `turn/end` may exist before the barrier is released.
        const newBoundary = clientA.records.length
        clientA.send('/new\r')
        const aOnY = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= newBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== sessionX,
          'M5N A opened Session Y while X was running',
          120_000,
        )
        const sessionY = aOnY.openSessionId
        assert(sessionY !== sessionX, 'M5N /new did not open a different Session')
        assert(aOnY.transport === 'connected' && aOnY.surfaceMounted === true,
          'M5N Client A lost its transport/surface while navigating')
        assertClientHostFacts(aOnY.host, hostBefore, 'M5N A on Y')
        assert(durableOf(sessionX).every(event => event.type !== 'turn/end'),
          'M5N X ended its Turn before the hold barrier was released: the /new stopped or waited for it')
        assert(!existsSync(releaseBarrier), 'M5N the hold barrier was released during /new')
        const yHeader = await waitForHostSessionHeader(dshHome, sessionY, 'M5N Y durable header')
        assert(hostSessionLogCount(dshHome) === sessionsBeforeNew + 1,
          `M5N /new created ${String(hostSessionLogCount(dshHome) - sessionsBeforeNew)} durable Sessions, expected exactly 1`)
        assert(yHeader.cwd === xHeaderBefore.cwd,
          `M5N the /new Session Workspace is not the captured Host Workspace: ${String(yHeader.cwd)} != ${String(xHeaderBefore.cwd)}`)
        const xHeaderAfterNew = await waitForHostSessionHeader(dshHome, sessionX, 'M5N X durable header after /new')
        assert(JSON.stringify(xHeaderAfterNew) === JSON.stringify(xHeaderBefore),
          'M5N /new changed the durable Session it left')

        // The RUNNING target for N-03: Y gets its own held Turn.
        clientA.send('m5n-y-held\r')
        const heldY = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionY, 'M5N Y Turn held')
        assert(heldY.agentStatus === 'running',
          `M5N the Host Agent was ${JSON.stringify(heldY.agentStatus)} while Y was held`)
        await waitForHostSessionEvent(dshHome, sessionY, event => event.type === 'turn/start', 'M5N Y turn/start')
        assert(durableOf(sessionY).every(event => event.type !== 'turn/end'),
          'M5N Y ended its Turn before the hold barrier was released')

        // NB-02 (N-03): `/resume` into a RUNNING target. A leaves running Y for
        // running X; the commit must not wait for X to go idle, and the new
        // surface projects X's in-flight stream instead of the Session it left.
        const resumeBoundary = clientA.records.length
        clientA.send(`/resume ${sessionX}\r`)
        const aOnX = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= resumeBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N A resumed the RUNNING Session X',
          120_000,
        )
        assertClientHostFacts(aOnX.host, hostBefore, 'M5N A back on X')
        await waitForCondition(async () => {
          const frame = (await clientA.viewport()).join('\n')
          return frame.includes('long-turn started') && !frame.includes('m5n-y-held')
        }, 'M5N A projected the RUNNING X surface', 120_000)
        assert(!existsSync(releaseBarrier), 'M5N the hold barrier was released during /resume')

        // NB-03: an already-current switch is a NO-OP: no re-open, no Turn end.
        // The refusal is a COMMAND ERROR, and the TUI's contract keeps a
        // refused command line in the editor for correction ("an error outcome
        // keeps the draft"). That restored line is observed here and cleared
        // through the real editor before the next ordinary submit, so the
        // queued-occurrence proof can never be built on a concatenated line.
        const alreadyBoundary = clientA.records.length
        clientA.send(`/resume ${sessionX}\r`)
        await clientA.waitForScreen('already on this session', 'M5N already-current refusal', 120_000)
        const alreadyStatus = lastSurfaceStatus(clientA)
        assert(alreadyStatus?.openSessionId === sessionX, 'M5N an already-current switch moved the Client')
        assert(durableOf(sessionX).every(event => event.type !== 'turn/end'),
          'M5N an already-current switch ended the running Turn')
        assert(clientA.records.filter(record => clientA.records.indexOf(record) >= alreadyBoundary
          && record.m4b2s === 'surface-status' && record.openSessionId === sessionY).length === 0,
          'M5N an already-current switch opened a different Session')
        const refusedLine = `/resume ${sessionX}`
        await clientA.waitForComposerDraft(refusedLine)
        clientA.send('\x15')
        await waitForCondition(async () => {
          const composer = (await clientA.composerText()) ?? ''
          return !composer.includes('/resume')
        }, 'M5N cleared the refused command line', 30_000)

        // NB-04 (N-04): a Host-queued occurrence on the running X, then A
        // leaves X. The occurrence belongs to X and must survive the release.
        // The text is typed and CONFIRMED in the composer before Enter: an
        // input that a closing overlay or an unfocused seat drops is lost for
        // good, so the readiness fact (the editor holds the line) must be
        // observed instead of guessed.
        const xQueueIndex = durableOf(sessionX).length
        clientA.send('m5n-x-queued')
        await clientA.waitForComposerDraft('m5n-x-queued')
        assert(!((await clientA.composerText()) ?? '').includes('/resume'),
          'M5N the queued line must not inherit a refused command line')
        clientA.send('\r')
        const queuedX = await waitForHostSessionEventAfter(dshHome, sessionX, xQueueIndex,
          event => event.type === 'agent/inbox/spliced'
            && event.data?.target === 'next-turn'
            && (event.data.inserted ?? []).some(message => textOf(message) === 'm5n-x-queued'),
          'M5N X queued the occurrence in the Host inbox',
          120_000)
        const queuedItem = (queuedX.data.inserted ?? []).find(message => textOf(message) === 'm5n-x-queued')
        assert(typeof queuedItem?.id === 'string' && queuedItem.id !== '',
          'M5N the Host queued occurrence carries no identity')

        // NB-05 (N-01): `/resume` away from the RUNNING X. A lands on Y while
        // X's Turn and its queued occurrence are still held.
        const leaveBoundary = clientA.records.length
        clientA.send(`/resume ${sessionY}\r`)
        const aLeftX = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= leaveBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && record.openSessionId === sessionY
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N A left the running X for Y',
          120_000,
        )
        assertClientHostFacts(aLeftX.host, hostBefore, 'M5N A after leaving X')
        assert(!existsSync(releaseBarrier), 'M5N the hold barrier was released during the navigation')
        assert(durableOf(sessionX).every(event => event.type !== 'turn/end'),
          'M5N leaving X stopped its held Turn')
        // The status record is not a painted frame: the old X transcript can
        // still be on screen when the record arrives. Wait for a Y-ONLY fact
        // (`m5n-y-held` was never sent on X) before asserting the X-only
        // absence, or the assertion races the repaint.
        await waitForCondition(async () => (await clientA.viewport()).join('\n').includes('m5n-y-held'),
          'M5N A painted the Y surface after leaving X', 120_000)
        assert(!(await clientA.viewport()).join('\n').includes('m5n-x-queued'),
          'M5N the X-only queued occurrence leaked onto the Y surface')

        // B is a SECOND real pty admitted to the SAME X while it is still
        // running: it reads X's live held stream and A's Host pending.
        const { client: clientB, ready: bReady } = await startC1Client('M5N B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N B retained the exact running Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5N B')
        assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
          'M5N Client B published no live business PID distinct from the Host')
        assert(aReady.pid !== bReady.pid, 'M5N the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5N the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5N B read the running X stream', 120_000)
        await clientB.waitForScreen('m5n-x-queued', 'M5N B read the Host-queued occurrence', 120_000)
        assert(alive(aReady.pid) && alive(bReady.pid) && alive(hostBefore.hostPid),
          'M5N a process died during the navigation')

        // Release the ONE hold. The Turn A left continues and completes
        // normally, claims the queued occurrence into the SAME Session, and B
        // sees the continuation; A sees its own target's settlement.
        const xReleaseIndex = durableOf(sessionX).length
        const yReleaseIndex = durableOf(sessionY).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const xEnds = await waitForTurnEnds(sessionX, xReleaseIndex, 1, 'M5N the held X Turn completed')
        assert(xEnds[0]?.data?.reason?.kind === 'completed',
          `M5N the held X Turn settled as ${JSON.stringify(xEnds[0]?.data?.reason)} instead of a normal completion`)
        const yEnd = await waitForHostSessionEventAfter(dshHome, sessionY, yReleaseIndex,
          event => event.type === 'turn/end', 'M5N the held Y Turn completed', 120_000)
        assert(yEnd.data?.reason?.kind === 'completed',
          `M5N the held Y Turn settled as ${JSON.stringify(yEnd.data?.reason)} instead of a normal completion`)
        await clientA.waitForScreen('long-turn answer 1', 'M5N A read its target settlement', 120_000)
        await clientB.waitForScreen('long-turn answer 1', 'M5N B read the departed Turn settlement', 120_000)
        const claimedX = await waitForHostSessionEventAfter(dshHome, sessionX, xReleaseIndex,
          event => event.type === 'user/message' && event.data?.id === queuedItem.id,
          'M5N X claimed the exact queued occurrence', 120_000)
        assert(textOf(claimedX.data) === 'm5n-x-queued', 'M5N the claimed occurrence changed content')
        const xEndsAfter = await waitForTurnEnds(sessionX, xReleaseIndex, 2, 'M5N the queued X Turn settled')
        assert(xEndsAfter.every(event => event.data?.reason?.kind === 'completed'),
          'M5N a non-aborted X Turn settled without a normal completion')
        const finalX = durableOf(sessionX)
        assert(finalX.filter(event => event.type === 'user/message' && textOf(event.data) === 'm5n-x-queued').length === 1,
          'M5N the queued occurrence committed more than once')
        assert(finalX.filter(event => event.type === 'user/message' && event.data?.id === queuedItem.id).length === 1,
          'M5N the queued occurrence identity committed more than once')
        assert(durableOf(sessionY).every(event => !(event.type === 'user/message' && textOf(event.data) === 'm5n-x-queued')),
          'M5N the X-only queued occurrence leaked into Session Y')
        await clientB.waitForScreen('m5n-x-queued', 'M5N B read the settled queued occurrence', 120_000)
        assert(lastSurfaceStatus(clientB)?.openSessionId === sessionX,
          'M5N Client B lost Session X during the continuation')

        // NB-06 (explicit Stop negative control): a fresh held Turn on a fresh
        // Session Z is stopped by the real Busy Esc. The SAME Host records an
        // ABORTED user settlement, so the detached navigation policy did not
        // disable the explicit Stop.
        rmSync(releaseBarrier)
        const stopNewBoundary = clientA.records.length
        clientA.send('/new\r')
        const aOnZ = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= stopNewBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== sessionY
            && record.openSessionId !== sessionX,
          'M5N A opened the fresh Session Z for the Stop control',
          120_000,
        )
        const sessionZ = aOnZ.openSessionId
        clientA.send('m5n-z-stop\r')
        const heldZ = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionZ, 'M5N Z Turn held')
        assert(heldZ.agentStatus === 'running',
          `M5N the Host Agent was ${JSON.stringify(heldZ.agentStatus)} while Z was held`)
        // The Z transcript is fresh and carries its OWN unique prompt, so this
        // paint is the Z Turn's live stream — the surface is busy and accepts
        // the single-Esc Stop.
        await waitForCondition(async () => {
          const frame = (await clientA.viewport()).join('\n')
          return frame.includes('m5n-z-stop') && frame.includes('long-turn started')
        }, 'M5N A painted the held Z Turn', 120_000)
        const zStopIndex = durableOf(sessionZ).length
        clientA.send('\x1b')
        const zAborted = await waitForHostSessionEventAfter(dshHome, sessionZ, zStopIndex,
          event => event.type === 'turn/end', 'M5N the Busy Esc settled the Z Turn', 120_000)
        assert(zAborted.data?.reason?.kind === 'aborted'
          && zAborted.data?.reason?.reason?.kind === 'user',
        `M5N the Busy Esc settlement was ${JSON.stringify(zAborted.data?.reason)} instead of an aborted user Turn`)

        await assertHostIdentityKept(host, hostBefore, 'M5N Host after every navigation')
        await exitC1Client(clientA, 'M5N A')
        await exitC1Client(clientB, 'M5N B')
        await stopC1Host(host)
        trace('m5n-01', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          sessionY,
          sessionZ,
          newFromRunningX: true,
          resumeRunningTarget: true,
          alreadyCurrentNoOp: true,
          queuedOccurrencePreserved: true,
          oldXTurnCompletion: 'completed',
          clientBReadContinuation: true,
          explicitStop: 'aborted/user',
        })
      }


      // M5N-02 (M5-N): the SIBLING paths of a detached navigation. `/fork`
      // adopts a Host-published child while the source Turn is still running,
      // and the Client EXIT releases only this Client's own references. Neither
      // path may cancel the Host work it leaves: the source Turn finishes with
      // its normal `completed` reason after the Client moved or exited, the
      // second Client keeps reading and writing that same Session, and an
      // explicit Busy Esc is still the ONE gesture that aborts a Turn (the
      // negative control). The Host fork boundary is the source's last
      // COMPLETED turn, so the child is adopted while the source's LATER Turn is
      // still held: a fork that waited for the source Turn could not commit
      // here, and a fork that stopped it could not continue afterwards.
      {
        const releaseBarrier = join(workDir, 'm5n2-siblings.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5n2-siblings', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5N2 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5N2 A')
        /** The plain text of one durable/inbox message (bounded, never a payload dump). */
        const textOf = message => (message?.content ?? [])
          .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
          .join('')
        const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
        /** Wait for the Nth `turn/end` at or after one durable boundary. */
        const waitForTurnEnds = async (sessionId, afterIndex, count, label) => {
          await waitForCondition(
            () => durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end').length >= count,
            label,
            120_000,
          )
          return durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end')
        }
        /** Type one prompt through the PAINTED composer, then submit it. */
        const submitPrompt = async (client, text) => {
          client.send(text)
          await client.waitForComposerDraft(text)
          client.send('\r')
        }
        /**
         * Wait for a FIXTURE event recorded at or after one boundary (the
         * fixture proof file is append-only for the whole lane, so a bare
         * `.find()` over all history can satisfy a wait with an EARLIER turn).
         */
        const waitForC1WorkEventAfter = async (afterIndex, predicate, label, timeoutMs = 120_000) => {
          const found = () => readC1WorkEvents(workRoot).slice(afterIndex).find(predicate)
          await waitForCondition(() => found() !== undefined, label, timeoutMs)
          return found()
        }

        // Turn 1 on X becomes a REAL completed product turn: it is the Host fork
        // cut the child inherits.
        const openWorkBoundary = readC1WorkEvents(workRoot).length
        const sessionX = await openC1Session(clientA, 'm5n2-x-turn1', 'M5N2 A')
        // The fixture stores only the FIRST 400 characters of a request's user
        // text, so a later turn's own prompt is beyond that window — the
        // pre-submit boundary is the freshness authority (see submitAndHold).
        const heldX1 = await waitForC1WorkEventAfter(openWorkBoundary,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX,
          'M5N2 X first Turn held')
        assert(heldX1.agentStatus === 'running',
          `M5N2 the Host Agent was ${JSON.stringify(heldX1.agentStatus)} while X was held`)
        // B joins the SAME Session X through its own startup intent: it is the
        // second real Client that must keep serving X through both departures.
        const { client: clientB, ready: bReady } = await startC1Client('M5N2 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N2 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5N2 B')
        assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
          'M5N2 Client B published no live business PID distinct from the Host')
        assert(aReady.pid !== bReady.pid, 'M5N2 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5N2 the two Clients must use distinct script(1) wrappers')
        /**
         * Submit one prompt and prove the Host started ITS OWN Turn: the
         * fixture records `long-turn-held` for the model request, and the Host
         * appends the fresh `turn/start` plus the EXACT `user/message` after the
         * boundary taken BEFORE the submit. Both proof stores are append-only
         * for the whole lane, so every wait is bounded by that boundary instead
         * of scanning all history (`attempt` is a per-session call counter, not
         * an identity, and the fixture truncates `userText` to 400 characters).
         */
        const submitAndHold = async (client, prompt, durableBoundary) => {
          const workBoundary = readC1WorkEvents(workRoot).length
          await submitPrompt(client, prompt)
          const held = await waitForC1WorkEventAfter(workBoundary,
            event => event.kind === 'long-turn-held' && event.sessionId === sessionX,
            `M5N2 the "${prompt}" Turn held`)
          await waitForHostSessionEventAfter(dshHome, sessionX, durableBoundary,
            event => event.type === 'turn/start', `M5N2 the "${prompt}" Turn started at the Host`, 120_000)
          await waitForHostSessionEventAfter(dshHome, sessionX, durableBoundary,
            event => event.type === 'user/message' && textOf(event.data) === prompt,
            `M5N2 the Host committed the "${prompt}" prompt`, 120_000)
          return held
        }
        const xTurn1Index = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const xTurn1Ends = await waitForTurnEnds(sessionX, xTurn1Index, 1, 'M5N2 the held X first Turn completed')
        assert(xTurn1Ends[0]?.data?.reason?.kind === 'completed',
          `M5N2 the X first Turn settled as ${JSON.stringify(xTurn1Ends[0]?.data?.reason)} instead of a normal completion`)

        // Turn 2 on X stays RUNNING: it is the work the fork must not stop and
        // must not wait for.
        rmSync(releaseBarrier)
        const xTurn2Index = durableOf(sessionX).length
        const heldX2 = await submitAndHold(clientA, 'm5n2-x-turn2', xTurn2Index)
        assert(heldX2.agentStatus === 'running',
          `M5N2 the Host Agent was ${JSON.stringify(heldX2.agentStatus)} while X's second Turn was held`)
        assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released before the fork')

        // NB-10 (N-05): `/fork` while X's second Turn runs. ONE Host fork, ONE
        // published child, ONE Client move, and the source keeps running.
        const sessionsBeforeFork = hostSessionLogCount(dshHome)
        const forkBoundary = clientA.records.length
        clientA.send('/fork\r')
        const aOnChild = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= forkBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N2 A adopted the forked child',
          120_000,
        )
        const childId = aOnChild.openSessionId
        assert(childId !== sessionX, 'M5N2 /fork did not move the Client onto a new Session')
        assertClientHostFacts(aOnChild.host, hostBefore, 'M5N2 A on the forked child')
        assert(durableOf(sessionX).slice(xTurn2Index).every(event => event.type !== 'turn/end'),
          'M5N2 the fork ended the source Turn: the source Host Turn was stopped')
        assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released during the fork')
        // The Client moved ONCE: from the record that adopted the child on,
        // no later status may return to the source or name a third Session.
        const movesAfterFork = clientA.records
          .slice(clientA.records.indexOf(aOnChild))
          .filter(record => record.m4b2s === 'surface-status' && record.sessionOpen === true
            && typeof record.openSessionId === 'string')
          .map(record => record.openSessionId)
        assert(movesAfterFork.every(id => id === childId),
          `M5N2 the /fork moved the Client more than once: ${JSON.stringify(movesAfterFork)}`)
        // The Host published the child from THIS source, with the source's
        // COMPLETED prefix only: never the running Turn and never the source's
        // own command settlement.
        const childHeader = await waitForHostSessionHeader(dshHome, childId, 'M5N2 the child durable header')
        assert(hostSessionLogCount(dshHome) === sessionsBeforeFork + 1,
          `M5N2 /fork published ${String(hostSessionLogCount(dshHome) - sessionsBeforeFork)} durable Sessions, expected exactly 1`)
        assert(childHeader.parentSession === sessionX,
          `M5N2 the child lineage named ${JSON.stringify(childHeader.parentSession)} instead of the source`)
        assert(childHeader.isSeeded === true, 'M5N2 the child is not a seeded fork')
        const childUserTexts = hostUserTexts(durableOf(childId))
        assert(childUserTexts.filter(text => text === 'm5n2-x-turn1').length === 1,
          `M5N2 the child lost the source's completed prefix: ${JSON.stringify(childUserTexts)}`)
        assert(childUserTexts.filter(text => text === 'm5n2-x-turn2').length === 0,
          'M5N2 the child inherited the RUNNING source Turn')
        assert(durableOf(childId).some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed'),
          'M5N2 the child inherited no completed Turn')
        // Release the ONE hold: the source Turn A left continues and completes,
        // and B reads the continuation through its own PTY.
        const xReleaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const xTurn2Ends = await waitForTurnEnds(sessionX, xReleaseIndex, 1, 'M5N2 the source Turn completed after the fork')
        assert(xTurn2Ends[0]?.data?.reason?.kind === 'completed',
          `M5N2 the source Turn settled as ${JSON.stringify(xTurn2Ends[0]?.data?.reason)} instead of a normal completion`)
        await clientB.waitForScreen('long-turn answer 2', 'M5N2 B read the source continuation', 120_000)
        assert(lastSurfaceStatus(clientB)?.openSessionId === sessionX, 'M5N2 Client B left Session X')
        // A Split Remote TUI command is executed through the CLIENT command
        // registry: the projected agent never reaches `ctx.commands.execute`,
        // so `/fork` appends NO `command/run`/`command/done` row to the Host
        // Session (the Direct in-process path does, and
        // test/domain/runner-session-navigation.test.ts pins there that the
        // source owner stays attached THROUGH that append). The deferred
        // source-retirement window the runtime uses is the SAME code path on
        // both backends; the durable rows simply do not exist for this
        // backend, so this scene must not claim them.
        // The child is an INDEPENDENT conversation: its own prompt commits on
        // the child only.
        const childTurnIndex = durableOf(childId).length
        await submitPrompt(clientA, 'm5n2-child-own')
        await waitForHostSessionEventAfter(dshHome, childId, childTurnIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5n2-child-own',
          'M5N2 the child prompt committed', 120_000)
        await waitForHostSessionEventAfter(dshHome, childId, childTurnIndex,
          event => event.type === 'turn/end', 'M5N2 the child Turn settled', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).every(text => text !== 'm5n2-child-own'),
          'M5N2 the child prompt leaked into the source Session')

        // NB-11 (N-06): the Client EXIT. A returns to the running source and
        // leaves the Client entirely: the exit releases only A's own references.
        rmSync(releaseBarrier)
        const xTurn3Index = durableOf(sessionX).length
        const heldX3 = await submitAndHold(clientB, 'm5n2-x-turn3', xTurn3Index)
        assert(heldX3.agentStatus === 'running',
          `M5N2 the Host Agent was ${JSON.stringify(heldX3.agentStatus)} while X's third Turn was held`)
        const backBoundary = clientA.records.length
        clientA.send(`/resume ${sessionX}\r`)
        const aBackOnX = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= backBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N2 A returned to the running source Session',
          120_000,
        )
        assertClientHostFacts(aBackOnX.host, hostBefore, 'M5N2 A back on X')
        const sessionsBeforeExit = hostSessionLogCount(dshHome)
        const aPid = aReady.pid
        await exitC1Client(clientA, 'M5N2 A')
        await waitGone(aPid, 15_000)
        assert(!alive(aPid), 'M5N2 Client A survived its exit')
        assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5N2 the Client exit killed the Host or the second Client')
        assert(hostSessionLogCount(dshHome) === sessionsBeforeExit,
          'M5N2 the Client exit created or removed a durable Session')
        assert(durableOf(sessionX).slice(xTurn3Index).every(event => event.type !== 'turn/end'),
          'M5N2 the Client exit ended the running Host Turn')
        assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released during the exit')
        await assertHostIdentityKept(host, hostBefore, 'M5N2 Host after the Client exit')
        // Release: the source Turn completes with its normal reason and B can
        // still write that same Session.
        const xExitReleaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const xTurn3Ends = await waitForTurnEnds(sessionX, xExitReleaseIndex, 1, 'M5N2 the source Turn completed after the exit')
        assert(xTurn3Ends[0]?.data?.reason?.kind === 'completed',
          `M5N2 the source Turn settled as ${JSON.stringify(xTurn3Ends[0]?.data?.reason)} after the exit`)
        await clientB.waitForScreen('long-turn answer 3', 'M5N2 B read the continuation after A exited', 120_000)
        assert(durableOf(sessionX).every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
          'M5N2 a Turn was aborted by something other than the explicit Stop')
        const afterExitIndex = durableOf(sessionX).length
        await submitPrompt(clientB, 'm5n2-b-after-exit')
        await waitForHostSessionEventAfter(dshHome, sessionX, afterExitIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5n2-b-after-exit',
          'M5N2 B committed after A exited', 120_000)
        await waitForHostSessionEventAfter(dshHome, sessionX, afterExitIndex,
          event => event.type === 'turn/end', 'M5N2 the post-exit Turn settled', 120_000)
        const committedAfterExit = hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5n2-b-after-exit').length
        assert(committedAfterExit === 1,
          `M5N2 the post-exit prompt committed ${String(committedAfterExit)} times, expected exactly 1`)

        // NB-12 (explicit Stop negative control): only the Busy Esc gesture may
        // abort the SAME Session's held Turn. The exit above left it running.
        rmSync(releaseBarrier)
        const stopIndex = durableOf(sessionX).length
        // `submitAndHold` proves the FRESH Turn (fixture event + durable
        // `turn/start` + exact `user/message` after the boundary). The generic
        // "long-turn started" transcript line is never a freshness fact.
        const heldStop = await submitAndHold(clientB, 'm5n2-x-stop', stopIndex)
        assert(heldStop.agentStatus === 'running',
          `M5N2 the Host Agent was ${JSON.stringify(heldStop.agentStatus)} while the Stop-control Turn was held`)
        await waitForCondition(async () => (await clientB.viewport()).join('\n').includes('m5n2-x-stop'),
          'M5N2 B echoed the held Stop-control prompt', 120_000)
        clientB.send('\x1b')
        const stopped = await waitForHostSessionEventAfter(dshHome, sessionX, stopIndex,
          event => event.type === 'turn/end', 'M5N2 the Busy Esc settled the Turn', 120_000)
        assert(stopped.data?.reason?.kind === 'aborted' && stopped.data?.reason?.reason?.kind === 'user',
          `M5N2 the Busy Esc settlement was ${JSON.stringify(stopped.data?.reason)} instead of an aborted user Turn`)

        // NB-13 (N-05, `/rewind`): the SAME detached-navigation contract for an
        // EXPLICIT completed-turn cut. X keeps RUNNING while B rewinds: the Host
        // fork boundary is the PRECEDECESSOR's end (turn 3 for the selected turn
        // 4), the adopted child carries that prefix only, and the selected
        // prompt is restored into the ADOPTED child's editor.
        // The Stop control above already removed the hold barrier, so the next
        // source Turn holds; never rm a path that is legitimately gone.
        assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier must be absent before the rewind Turn')
        const xTurn6Index = durableOf(sessionX).length
        const heldX6 = await submitAndHold(clientB, 'm5n2-x-turn6', xTurn6Index)
        assert(heldX6.agentStatus === 'running',
          `M5N2 the Host Agent was ${JSON.stringify(heldX6.agentStatus)} while X's sixth Turn was held`)
        const sessionsBeforeRewind = hostSessionLogCount(dshHome)
        const rewindBoundary = clientB.records.length
        clientB.send('/rewind\r')
        await clientB.waitForScreen('turn 4 · m5n2-b-after-exit',
          'M5N2 the rewind picker listed the completed turns', 60_000)
        /** The turn the picker's `> ` selection marker is PAINTED on. */
        const markedTurn = async () => {
          const row = (await clientB.viewport()).find(line => /> +turn \d+ ·/u.test(line))
          const match = row?.match(/> +turn (\d+) ·/u)
          return match === undefined ? undefined : Number(match[1])
        }
        const initialMarkedTurn = await markedTurn()
        assert(initialMarkedTurn !== undefined, 'M5N2 the rewind picker painted no selection marker')
        // Move the REAL picker selection by observing the painted marker move
        // (an authoritative frame fact), never by a fixed sleep between keys.
        for (let step = 0; step < 6 && (await markedTurn()) !== 4; step += 1) {
          const before = await markedTurn()
          clientB.send('\x1b[B')
          await waitForCondition(async () => {
            const now = await markedTurn()
            return now !== undefined && now !== before
          }, 'M5N2 the rewind picker moved its selection', 15_000)
        }
        assert((await markedTurn()) === 4, 'M5N2 the rewind picker never selected turn 4')
        clientB.send('\r')
        const bOnRewound = await clientB.waitFor(
          record => clientB.records.indexOf(record) >= rewindBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N2 B adopted the rewound child', 120_000)
        const rewoundChildId = bOnRewound.openSessionId
        assertClientHostFacts(bOnRewound.host, hostBefore, 'M5N2 B on the rewound child')
        assert(hostSessionLogCount(dshHome) === sessionsBeforeRewind + 1,
          `M5N2 /rewind published ${String(hostSessionLogCount(dshHome) - sessionsBeforeRewind)} durable Sessions, expected exactly 1`)
        assert(durableOf(sessionX).slice(xTurn6Index).every(event => event.type !== 'turn/end'),
          'M5N2 the rewind ended the running source Turn')
        assert(!existsSync(releaseBarrier), 'M5N2 the hold barrier was released during the rewind')
        const rewoundHeader = await waitForHostSessionHeader(dshHome, rewoundChildId, 'M5N2 the rewound child durable header')
        assert(rewoundHeader.parentSession === sessionX, 'M5N2 the rewound child does not name the source')
        assert(rewoundHeader.isSeeded === true, 'M5N2 the rewound child is not a seeded fork')
        const rewoundTexts = hostUserTexts(durableOf(rewoundChildId))
        assert(rewoundTexts.filter(text => text === 'm5n2-x-turn3').length === 1,
          `M5N2 the rewound child lost the prefix through turn 3: ${JSON.stringify(rewoundTexts)}`)
        assert(rewoundTexts.filter(text => text === 'm5n2-b-after-exit').length === 0,
          'M5N2 the rewound child inherited the selected turn it forked BEFORE')
        assert(durableOf(rewoundChildId).every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
          'M5N2 the rewound child inherited the later aborted Turn')
        // The rewind restored the SELECTED turn's prompt into the ADOPTED editor.
        await clientB.waitForComposerDraft('m5n2-b-after-exit')
        clientB.send('\x15')
        await waitForCondition(async () => !((await clientB.composerText()) ?? '').includes('m5n2-b-after-exit'),
          'M5N2 cleared the restored rewind draft', 30_000)
        // The source Turn B walked away from still completes normally.
        const xRewindReleaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const xTurn6Ends = await waitForTurnEnds(sessionX, xRewindReleaseIndex, 1, 'M5N2 the source Turn completed after the rewind')
        assert(xTurn6Ends[0]?.data?.reason?.kind === 'completed',
          `M5N2 the source Turn settled as ${JSON.stringify(xTurn6Ends[0]?.data?.reason)} after the rewind`)

        await assertHostIdentityKept(host, hostBefore, 'M5N2 Host after the fork, exit and Stop')
        await exitC1Client(clientB, 'M5N2 B')
        await stopC1Host(host)
        trace('m5n-02', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          childId,
          forkDispatches: 1,
          forkCut: 'completed-prefix (turn 1)',
          sourceTurnKeptRunningThroughFork: true,
          remoteCommandRows: 'none (client-registry route)',
          childInheritedPrefixUserTexts: childUserTexts.length,
          childOwnTurnCommitted: true,
          sourceTurnCompletionAfterFork: 'completed',
          clientExitReleasesOnlyOwnReference: true,
          sourceTurnCompletionAfterExit: 'completed',
          secondClientCommittedAfterExit: true,
          explicitStop: 'aborted/user',
          rewoundChildId,
          rewindCut: 'turn 3 end (selected turn 4)',
          rewindDraftRestored: true,
          sourceTurnCompletionAfterRewind: 'completed',
        })
      }

      // M5N-03 (M5-N): a Client leaving a Session with a PENDING Host interaction
      // withdraws only its OWN presentation. The Host question is never
      // cancelled by that departure: the second admitted Client still answers
      // the SAME `callId`, the Host settles exactly once, and the Turn ends
      // normally. The reachable leave gesture while a Question owns the editor
      // seat is the Client EXIT (the modal does not accept a slash command), so
      // the local withdrawal is the exit's own teardown — never a Host cancel.
      {
        const { host, ready: hostReady, workRoot } = await startC1Host('question', 'm5n3-interaction')
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5N3 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5N3 A')
        // A creates an EMPTY Session X with the real product `/new`; B joins the
        // SAME X before the Host is asked, so both modals are the ONE delivery.
        const aBoundary = clientA.records.length
        clientA.send('/new\r')
        const aOpen = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= aBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== ''
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N3 Client A opened an empty Session',
          120_000,
        )
        const sessionX = aOpen.openSessionId
        assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
          'M5N3 Client A published no live business PID distinct from the Host')
        const { client: clientB, ready: bReady } = await startC1Client('M5N3 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5N3 Client B retained Session X')
        assertClientHostFacts(aOpen.host, hostBefore, 'M5N3 Client A')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5N3 Client B')
        assert(aReady.pid !== bReady.pid, 'M5N3 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5N3 the two Clients must use distinct script(1) wrappers')
        assertInteractionGate(clientA, 'M5N3 Client A')
        assertInteractionGate(clientB, 'M5N3 Client B')
        const pendingBefore = hostSessionEvents(dshHome, sessionX) ?? []
        assert(!pendingBefore.some(event => event.type === 'turn/start' || event.type === 'tool/call'
          || event.type === 'approval/asked'),
        'M5N3 Host Session X carried Host activity before the trigger')

        // The ONE trigger is A's real keyboard submission AFTER both Clients
        // were admitted and nothing was pending.
        const triggerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientA.send('m5n3-interaction-trigger\r')
        const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
          event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
          'M5N3 the Host question tool/call', 120_000)
        assert(typeof call.data.callId === 'string' && call.data.callId !== '',
          'M5N3 the question tool/call carries no callId')
        const callId = call.data.callId
        await waitForC1WorkEvent(workRoot,
          event => event.kind === 'question-request' && event.sessionId === sessionX,
          'M5N3 the Host question request', 120_000)
        await clientA.waitForScreen('[1] Proceed', 'M5N3 A painted the question modal', 120_000)
        await clientB.waitForScreen('[1] Proceed', 'M5N3 B painted the question modal', 120_000)
        assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
          'M5N3 Client A painted no question text')
        assert((await clientB.viewport()).join('\n').includes('Continue the C1 test?'),
          'M5N3 Client B painted no question text')

        // A LEAVES the Session without answering. Nothing may reach the Host:
        // no answer, no cancel, no Turn end.
        const leaveIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        const aPid = aReady.pid
        clientA.signalBusiness('SIGTERM')
        const aExit = await clientA.waitForExit(60_000)
        assert(aExit.code === 0 && aExit.signal === null,
          `M5N3 Client A exit was ${JSON.stringify(aExit)}`)
        await waitGone(aPid, 15_000)
        assert(!alive(aPid), 'M5N3 Client A survived its exit')
        await clientA.dispose()
        assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5N3 A\'s departure killed the Host or Client B')
        assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(leaveIndex)
          .every(event => event.type !== 'tool/result' && event.type !== 'turn/end'),
        'M5N3 A\'s departure settled the Host question or the Turn')
        assert(readC1WorkEvents(workRoot)
          .every(event => event.kind !== 'question-settled'),
        'M5N3 A\'s departure settled the Host question')
        await assertHostIdentityKept(host, hostBefore, 'M5N3 Host after A left')
        // B is still the answerer of the SAME Host delivery.
        await clientB.waitForScreen('[1] Proceed', 'M5N3 B still paints the answerable modal', 60_000)
        const answerIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
        clientB.send('1')
        await clientB.waitForScreen('Review your answer before submit', 'M5N3 B question review', 30_000)
        clientB.send('\r')
        const settled = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'question-settled' && event.sessionId === sessionX,
          'M5N3 the Host question settled', 120_000)
        assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
          `M5N3 the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
        const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
          'M5N3 the question tool result', 120_000)
        assert(result.data?.message?.isError !== true, 'M5N3 the answered question failed at the Host')
        const questionEnd = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
          event => event.type === 'turn/end', 'M5N3 the question Turn ended', 120_000)
        assert(questionEnd.data?.reason?.kind === 'completed',
          `M5N3 the question Turn settled as ${JSON.stringify(questionEnd.data?.reason)} instead of a normal completion`)
        await clientB.waitForScreen('question answered', 'M5N3 B read the Host settlement', 120_000)
        // EXACTLY ONCE, read from the final durable state: A's departure neither
        // answered nor cancelled, and B's ONE decision is the ONE result.
        const finalEvents = hostSessionEvents(dshHome, sessionX) ?? []
        assert(finalEvents.filter(event => event.type === 'tool/result'
          && String(event.data?.message?.toolCallId) === callId).length === 1,
        'M5N3 the Host question produced more than one tool result')
        const finalProofs = readC1WorkEvents(workRoot)
        assert(finalProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1,
          'M5N3 the Host asked more than once')
        assert(finalProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
          'M5N3 the Host settled the question more than once')
        assert(finalEvents.every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
          'M5N3 the question Turn was aborted instead of settling normally')
        await assertHostIdentityKept(host, hostBefore, 'M5N3 Host after the settlement')
        await exitC1Client(clientB, 'M5N3 B')
        await stopC1Host(host)
        trace('m5n-03', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          callId,
          dualModalPainted: true,
          leavingClientExitCode: aExit.code,
          departureSettledNothing: true,
          secondClientAnswered: 'Proceed',
          hostToolResults: 1,
          hostQuestionSettlements: 1,
          turnSettlement: 'completed',
        })
      }

      // M5D-01 (M5-D): INDEPENDENT Client lifecycle on ONE real Host with TWO
      // real Surface Clients. Every D scene starts its OWN isolated Host and
      // two `script(1)` PTYs (distinct business PIDs, wrappers and PTYs) and
      // proves the same invariant from a different reachable gesture: A leaves
      // (exit / SIGKILL / SIGHUP / transport rollover / same-PID HMR /
      // navigation). The cross-build `/reload-client` sibling is the upgrade
      // lane's U08, not a D scene. In every D scene B's own Context, root
      // fiber, transport generation, surface revision, Session X and Host
      // identity stay unchanged, and the Host's ORIGINAL held Turn survives
      // A's gesture.
      // The fixture is the ONLY authority for the held Turn and the Question,
      // so a timer, a replayed write or a cached transcript cannot produce
      // these facts.
      //
      //   D-01  A `/exit`; B keeps the original running X and writes after it
      //         completes.
      //   D-02  A SIGKILL (kernel path, NO graceful inventory); B keeps X; a
      //         NEW A' cold-attaches without replaying the accepted prompt.
      //   D-03  A's physical mux drop rolls the official generation over; B is
      //         untouched and the original Turn still completes. This scene
      //         does NOT claim the T66 lost-ACK taxonomy: it has no in-flight
      //         ACK-loss input.
      //   D-04  A same-PID surface HMR: the old revision is retired before the
      //         new one is ready and B's own surface never changes.
      //   D-05  A HMR while B holds the SAME pending Host Question: A's NEW
      //         revision repaints the pending frame, B settles the same callId
      //         exactly once and A's modal is withdrawn by the settlement.
      //   D-06  Host SIGKILL disconnects BOTH Clients; a new C cold-discovers
      //         the NEXT Host and neither old Client treats it as a
      //         continuation.
      //   D-07  A SIGHUP (process failure, never the graceful inventory); B
      //         keeps the running original X.
      //   D-08  N-composite: A navigates X -> Y through the real `/new` while
      //         X's original Turn is held, then exits from Y; B keeps X and the
      //         Host completes the ORIGINAL Turn.
      /** The durable events of one Host Session (empty before its log exists). */
      const durableOf = sessionId => hostSessionEvents(dshHome, sessionId) ?? []
      /** The plain text of one durable/inbox message (bounded, never a dump). */
      const textOf = message => (message?.content ?? [])
        .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
      /** Type a prompt through the PAINTED composer, then submit it. */
      const submitPrompt = async (client, text) => {
        client.send(text)
        await client.waitForComposerDraft(text)
        client.send('\r')
      }
      /** Wait for the Nth `turn/end` at or after one durable boundary. */
      const waitForTurnEnds = async (sessionId, afterIndex, count, label) => {
        await waitForCondition(
          () => durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end').length >= count,
          label,
          120_000,
        )
        return durableOf(sessionId).slice(afterIndex).filter(event => event.type === 'turn/end')
      }
      /**
       * The B-side non-interference witness of ONE operation. From the record
       * boundary taken BEFORE A's gesture, B's own status tuple may not change
       * at all: the Host status projection dedupes an identical
       * (transport, generation, session, revision, fiber) key, so "no NEW
       * record" is the correct fact for "B did not change". B's current-PTY
       * readback and B's later Host-accepted write are the independent
       * after-liveness proof; no heartbeat is invented here.
       */
      const assertSecondClientKept = (client, before, fromIndex, label) => {
        assert(before !== undefined, `${label}: Client B has no status boundary`)
        // Read the complete record tail first: the 25ms poller must not decide
        // this witness from a stale snapshot. The scene ALSO re-runs this scan
        // against the SAME boundary after B's own Host-accepted write, so a
        // record emitted late in A's operation window is still covered.
        client.readRecords()
        for (const record of client.records.slice(fromIndex).filter(entry => entry.m4b2s === 'surface-status')) {
          assert(record.pid === before.pid, `${label}: Client B PID changed`)
          assert(record.rootFiberUid === before.rootFiberUid, `${label}: Client B root fiber changed`)
          assert(record.generationId === before.generationId, `${label}: Client B transport generation changed`)
          assert(record.surfaceRevision === before.surfaceRevision, `${label}: Client B surface revision changed`)
          assert(record.surfaceFiberUid === before.surfaceFiberUid, `${label}: Client B runner fiber changed`)
          assert(record.surfaceMounted === true, `${label}: Client B lost its mounted surface`)
          assert(record.transport === 'connected', `${label}: Client B transport became ${String(record.transport)}`)
          assert(record.sessionOpen === true, `${label}: Client B lost its open Session`)
          assert(record.openSessionId === before.openSessionId, `${label}: Client B Session changed`)
          assert(record.host?.instanceId === before.host?.instanceId, `${label}: Client B Host instance changed`)
        }
        assert(client.records.slice(fromIndex).every(record => record.m4b2s !== 'client-closed'),
          `${label}: Client B emitted a Client owner release`)
        assert(alive(before.pid), `${label}: Client B business process is not alive`)
      }
      /** The graceful `/exit` inventory: code 0 and every owned Client row 0. */
      const exitClientWithInventory = async (client, label) => {
        client.send('/exit\r')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, `${label} exit was ${JSON.stringify(exit)}`)
        const closed = await client.waitFor(record => record.m4b2s === 'client-closed', `${label} owner inventory`, 30_000)
        assert(closed.pid === client.records.find(record => record.m4a0 === 'ready')?.pid,
          `${label} owner inventory came from another process`)
        assert(closed.sessionOpen === false, `${label} still reported an open Session`)
        assert(closed.surfaceMounted === false, `${label} still reported a mounted surface`)
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(closed.owners?.[owner] === 0, `${label} left ${owner} owner alive`)
        }
        await client.dispose()
        return { exit, closed }
      }
      /**
       * Stop one D scene Host through its OWN owner path and assert the clean
       * shutdown exit. The older `stopC1Host` is a swallowing backstop for the
       * T/M5N cases; the plan's per-scene order ends with a clean Host stop, so
       * the M5-D scenes must not hide a failed owner shutdown.
       */
      const stopDHost = async (host, label) => {
        if (host.exited) {
          assert(host.exitResult?.code === 0,
            `${label} exited before its owner shutdown: ${JSON.stringify(host.exitResult)}`)
          return
        }
        const exit = await host.shutdown()
        assert(exit.code === 0, `${label} owner shutdown exited ${JSON.stringify(exit)}`)
      }

      // ── D-01: A `/exit` while the ORIGINAL Turn runs, B keeps X ──────────
      {
        const releaseBarrier = join(workDir, 'm5d1-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d1-exit', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-01 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5D-01 A')
        const sessionX = await openC1Session(clientA, 'm5d1-x-held', 'M5D-01 A')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-01 X Turn held', 120_000)
        assert(held.agentStatus === 'running',
          `M5D-01 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-01 X turn/start', 120_000)
        const { client: clientB, ready: bReady } = await startC1Client('M5D-01 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-01 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-01 B')
        // Two REAL business PIDs over two distinct `script(1)` wrappers/PTYs.
        assert(Number.isInteger(aReady.pid) && aReady.pid > 0 && aReady.pid !== hostBefore.hostPid,
          'M5D-01 Client A published no live business PID distinct from the Host')
        assert(Number.isInteger(bReady.pid) && bReady.pid > 0 && bReady.pid !== hostBefore.hostPid,
          'M5D-01 Client B published no live business PID distinct from the Host')
        assert(aReady.pid !== bReady.pid, 'M5D-01 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-01 the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5D-01 B read the running X stream', 120_000)
        const bBefore = lastSurfaceStatus(clientB)
        const bBoundary = clientB.records.length
        const durableBoundary = durableOf(sessionX).length
        // A's REAL keyboard `/exit` through the painted editor while the Host
        // Turn is held: the graceful path, so the full owner inventory exists.
        const { exit: aExit, closed: aClosed } = await exitClientWithInventory(clientA, 'M5D-01 A')
        assert(aClosed.pid === aReady.pid, 'M5D-01 the owner inventory did not come from Client A')
        await waitGone(aReady.pid, 15_000)
        assert(!alive(aReady.pid), 'M5D-01 Client A survived its exit')
        assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-01 A\'s exit killed the Host or Client B')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-01 after A exit')
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-01 A\'s exit settled or cancelled the running Host Turn')
        assert(!existsSync(releaseBarrier), 'M5D-01 the hold barrier was released before the original Turn completed')
        await assertHostIdentityKept(host, hostBefore, 'M5D-01 Host after A exit')
        // Release the ONE hold: the ORIGINAL Turn completes and B reads it.
        const releaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-01 the original X Turn completed')
        assert(ends[0]?.data?.reason?.kind === 'completed',
          `M5D-01 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
        await clientB.waitForScreen('long-turn answer 1', 'M5D-01 B read the original Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d1-x-held').length === 1,
          'M5D-01 the accepted prompt was replayed or lost across A\'s exit')
        // B's OWN Host-accepted write on the SAME Session after the lifecycle.
        const writeIndex = durableOf(sessionX).length
        await submitPrompt(clientB, 'm5d1-b-after-exit')
        await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5d1-b-after-exit',
          'M5D-01 B committed after A exited', 120_000)
        const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'turn/end', 'M5D-01 B\'s own Turn settled', 120_000)
        assert(bEnd.data?.reason?.kind === 'completed', 'M5D-01 B\'s own Turn did not complete normally')
        await clientB.waitForScreen('long-turn answer 2', 'M5D-01 B read its own Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d1-b-after-exit').length === 1,
          'M5D-01 B\'s own prompt committed more than once')
        // Final scan of the WHOLE B status tail from the pre-gesture boundary:
        // a record emitted late in A's operation window is still covered.
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-01 at the end of the scene')
        assert(durableOf(sessionX).every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
          'M5D-01 a Turn was aborted without an explicit user gesture')
        await assertHostIdentityKept(host, hostBefore, 'M5D-01 Host after the original Turn')
        await exitC1Client(clientB, 'M5D-01 B')
        await stopDHost(host, 'M5D-01 Host')
        trace('m5d-01', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          aExitCode: aExit.code,
          aOwnersReleased: true,
          originalTurnSettlement: 'completed',
          bOwnReadback: true,
          bOwnTurn: 'completed',
        })
      }

      // ── D-02: A SIGKILL (kernel path), B keeps X, A' cold-attaches ────────
      {
        const releaseBarrier = join(workDir, 'm5d2-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d2-hard-kill', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-02 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5D-02 A')
        const sessionX = await openC1Session(clientA, 'm5d2-x-held', 'M5D-02 A')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-02 X Turn held', 120_000)
        assert(held.agentStatus === 'running',
          `M5D-02 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-02 X turn/start', 120_000)
        const { client: clientB, ready: bReady } = await startC1Client('M5D-02 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-02 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-02 B')
        assert(aReady.pid !== bReady.pid, 'M5D-02 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-02 the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5D-02 B read the running X stream', 120_000)
        const bBefore = lastSurfaceStatus(clientB)
        const bBoundary = clientB.records.length
        const durableBoundary = durableOf(sessionX).length
        // A REAL SIGKILL to the BUSINESS PID (never the `script(1)` wrapper):
        // the kernel terminates it, so no graceful disposer/inventory exists.
        clientA.signalBusiness('SIGKILL')
        await waitGone(aReady.pid, 15_000)
        assert(!alive(aReady.pid), 'M5D-02 Client A survived SIGKILL')
        await clientA.waitForExit(60_000)
        clientA.readRecords()
        assert(clientA.records.every(record => record.m4b2s !== 'client-closed'),
          'M5D-02 a SIGKILL cannot produce the graceful Client owner inventory')
        await clientA.dispose()
        assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-02 A\'s SIGKILL killed the Host or Client B')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-02 after A SIGKILL')
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-02 A\'s SIGKILL settled or cancelled the running Host Turn')
        assert(!existsSync(releaseBarrier), 'M5D-02 the hold barrier was released before the original Turn completed')
        await assertHostIdentityKept(host, hostBefore, 'M5D-02 Host after A SIGKILL')
        // Release the ORIGINAL Turn; B must read the Host's own settlement.
        const releaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-02 the original X Turn completed')
        assert(ends[0]?.data?.reason?.kind === 'completed',
          `M5D-02 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
        await clientB.waitForScreen('long-turn answer 1', 'M5D-02 B read the original Turn settlement', 120_000)
        // A' is a NEW real PTY/PID that COLD-attaches the same Session and Host.
        const { client: clientAPrime, ready: aPrimeReady } = await startC1Client('M5D-02 A-prime', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const aPrimeOnX = await waitForSurfaceStatus(clientAPrime,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-02 A-prime cold-attached Session X')
        assertClientHostFacts(aPrimeOnX.host, hostBefore, 'M5D-02 A-prime')
        assert(Number.isInteger(aPrimeReady.pid) && aPrimeReady.pid > 0,
          'M5D-02 A-prime published no live business PID')
        assert(aPrimeReady.pid !== aReady.pid, 'M5D-02 the cold replacement reused the killed Client PID')
        assert(aPrimeReady.pid !== bReady.pid, 'M5D-02 the cold replacement reused Client B\'s PID')
        assert(clientAPrime.child.pid !== clientA.child.pid && clientAPrime.child.pid !== clientB.child.pid,
          'M5D-02 the cold replacement reused another Client\'s script(1) wrapper')
        await clientAPrime.waitForScreen('m5d2-x-held', 'M5D-02 A-prime cold history', 120_000)
        await clientAPrime.waitForScreen('long-turn answer 1', 'M5D-02 A-prime read the settled Turn', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d2-x-held').length === 1,
          'M5D-02 the cold attach replayed the accepted prompt')
        // B's independent Host-accepted write after the cold attach.
        const writeIndex = durableOf(sessionX).length
        await submitPrompt(clientB, 'm5d2-b-after-kill')
        await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5d2-b-after-kill',
          'M5D-02 B committed after A was killed', 120_000)
        const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'turn/end', 'M5D-02 B\'s own Turn settled', 120_000)
        assert(bEnd.data?.reason?.kind === 'completed', 'M5D-02 B\'s own Turn did not complete normally')
        await clientB.waitForScreen('long-turn answer 2', 'M5D-02 B read its own Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d2-b-after-kill').length === 1,
          'M5D-02 B\'s own prompt committed more than once')
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d2-x-held').length === 1,
          'M5D-02 the killed Client\'s accepted prompt was replayed')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-02 at the end of the scene')
        await exitC1Client(clientAPrime, 'M5D-02 A-prime')
        await exitC1Client(clientB, 'M5D-02 B')
        await stopDHost(host, 'M5D-02 Host')
        trace('m5d-02', {
          hostPid: hostBefore.hostPid,
          killedClientPid: aReady.pid,
          clientBPid: bReady.pid,
          coldClientPid: aPrimeReady.pid,
          wrapperPids: [clientA.child.pid, clientAPrime.child.pid, clientB.child.pid],
          sessionX,
          killedPath: 'SIGKILL (kernel): no graceful inventory claimed',
          originalTurnSettlement: 'completed',
          promptCommitsAfterColdAttach: 1,
          bOwnTurn: 'completed',
        })
      }

      // ── D-03: only A's official transport generation rolls over ───────────
      {
        const releaseBarrier = join(workDir, 'm5d3-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d3-rollover', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-03 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5D-03 A')
        const sessionX = await openC1Session(clientA, 'm5d3-x-held', 'M5D-03 A')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-03 X Turn held', 120_000)
        assert(held.agentStatus === 'running',
          `M5D-03 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-03 X turn/start', 120_000)
        const { client: clientB, ready: bReady } = await startC1Client('M5D-03 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-03 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-03 B')
        assert(aReady.pid !== bReady.pid, 'M5D-03 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-03 the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5D-03 B read the running X stream', 120_000)
        const aBefore = lastSurfaceStatus(clientA)
        assert(typeof aBefore?.generationId === 'number',
          'M5D-03 Client A never observed an official transport generation')
        const bBefore = lastSurfaceStatus(clientB)
        const bBoundary = clientB.records.length
        const durableBoundary = durableOf(sessionX).length
        const aBoundary = clientA.records.length
        // Qualification-only input: SIGUSR1 drops A's REAL physical mux socket.
        // The PASS authority is NOT that trace: it is the official new
        // Connection generation with the exact Session re-adopted below.
        clientA.signalBusiness('SIGUSR1')
        await clientA.waitFor(
          record => clientA.records.indexOf(record) >= aBoundary
            && record.m4b2s === 'qualification' && record.op === 'drop-websocket',
          'M5D-03 the qualification mux drop was injected',
          30_000,
        )
        // The official Node Connection loop leaves `connected` through its
        // retry state and clears the generation; the literal `disconnected`
        // label is the offline/network-unavailable branch and is not reachable
        // on a local mux drop. Bind the generation truth: the old official
        // generation is GONE before the replacement generation is accepted.
        const dropped = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= aBoundary
            && record.m4b2s === 'surface-status'
            && record.transport !== 'connected'
            && record.generationId === undefined,
          'M5D-03 A observed the official lost generation',
          60_000,
        )
        assert(dropped.surfaceRevision === aBefore.surfaceRevision,
          'M5D-03 the transport loss replaced A\'s surface revision')
        const rolled = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= aBoundary
            && record.m4b2s === 'surface-status'
            && typeof record.generationId === 'number'
            && record.generationId !== aBefore.generationId
            && record.transport === 'connected'
            && record.sessionOpen === true
            && record.openSessionId === sessionX
            && record.surfaceMounted === true,
          'M5D-03 A reconnected on a NEW official generation with X current',
          120_000,
        )
        assertClientHostFacts(rolled.host, hostBefore, 'M5D-03 A after the rollover')
        assert(rolled.pid === aBefore.pid && rolled.rootFiberUid === aBefore.rootFiberUid,
          'M5D-03 the transport rollover replaced the Client process or root Context')
        assert(rolled.surfaceRevision === aBefore.surfaceRevision,
          'M5D-03 the transport rollover replaced A\'s surface revision')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-03 during A rollover')
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-03 A\'s rollover settled or cancelled the running Host Turn')
        assert(!existsSync(releaseBarrier), 'M5D-03 the hold barrier was released during the rollover')
        await assertHostIdentityKept(host, hostBefore, 'M5D-03 Host after A rollover')
        // Release: A's CURRENT generation and B both read the ORIGINAL Turn.
        const releaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-03 the original X Turn completed')
        assert(ends[0]?.data?.reason?.kind === 'completed',
          `M5D-03 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
        await clientA.waitForScreen('long-turn answer 1', 'M5D-03 A read the settlement on the new generation', 120_000)
        await clientB.waitForScreen('long-turn answer 1', 'M5D-03 B read the original Turn settlement', 120_000)
        const writeIndex = durableOf(sessionX).length
        await submitPrompt(clientB, 'm5d3-b-after-rollover')
        await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5d3-b-after-rollover',
          'M5D-03 B committed after A rolled over', 120_000)
        const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'turn/end', 'M5D-03 B\'s own Turn settled', 120_000)
        assert(bEnd.data?.reason?.kind === 'completed', 'M5D-03 B\'s own Turn did not complete normally')
        await clientB.waitForScreen('long-turn answer 2', 'M5D-03 B read its own Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d3-b-after-rollover').length === 1,
          'M5D-03 B\'s own prompt committed more than once')
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d3-x-held').length === 1,
          'M5D-03 A\'s accepted prompt was replayed by the rollover')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-03 at the end of the scene')
        const { exit: aExit } = await exitClientWithInventory(clientA, 'M5D-03 A')
        await exitC1Client(clientB, 'M5D-03 B')
        await stopDHost(host, 'M5D-03 Host')
        trace('m5d-03', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          generationBefore: aBefore.generationId,
          generationAfter: rolled.generationId,
          rolloverInjection: 'qualification SIGUSR1 (physical mux socket)',
          lossObserved: dropped.transport,
          lostGeneration: 'undefined (old official generation invalidated)',
          officialReconnect: true,
          bGeneration: bBefore.generationId,
          originalTurnSettlement: 'completed',
          aExitCode: aExit.code,
          lostAckTaxonomyClaimed: false,
        })
      }

      // ── D-04: A same-PID HMR, B's whole lifecycle untouched ───────────────
      {
        const releaseBarrier = join(workDir, 'm5d4-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d4-hmr', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-04 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5D-04 A', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionX = await openC1Session(clientA, 'm5d4-x-held', 'M5D-04 A')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-04 X Turn held', 120_000)
        assert(held.agentStatus === 'running',
          `M5D-04 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-04 X turn/start', 120_000)
        const { client: clientB, ready: bReady } = await startC1Client('M5D-04 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-04 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-04 B')
        assert(aReady.pid !== bReady.pid, 'M5D-04 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-04 the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5D-04 B read the running X stream', 120_000)
        const aBefore = lastSurfaceStatus(clientA)
        assert(aBefore !== undefined && aBefore.surfaceMounted === true && aBefore.sessionOpen === true,
          'M5D-04 Client A has no mounted status boundary')
        const bBefore = lastSurfaceStatus(clientB)
        const bBoundary = clientB.records.length
        const durableBoundary = durableOf(sessionX).length
        const hmrFrom = clientA.records.length
        // Qualification-only same-PID HMR: SIGUSR2 retires and remounts the
        // surface on A's SAME PID/root/transport while B stays live.
        clientA.signalBusiness('SIGUSR2')
        const start = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= hmrFrom
            && record.m4b2s === 'qualification' && record.op === 'hmr-revision-start',
          'M5D-04 HMR start',
          60_000,
        )
        assert(Number.isInteger(start.revision), 'M5D-04 the HMR start named no replacement revision')
        await waitForSurfaceStatus(clientA,
          record => record.surfaceRevision === aBefore.surfaceRevision && record.surfaceMounted === false,
          'M5D-04 the old surface retired first',
          60_000,
        )
        await clientA.waitFor(
          record => clientA.records.indexOf(record) >= hmrFrom
            && record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired',
          'M5D-04 the old revision retired',
          120_000,
        )
        const ready = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= hmrFrom
            && record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
          'M5D-04 the replacement revision is ready',
          180_000,
        )
        assert(ready.revision === start.revision, 'M5D-04 the ready record named another revision')
        const after = await waitForSurfaceStatus(clientA,
          record => record.surfaceRevision === ready.revision && record.surfaceMounted === true,
          'M5D-04 the replacement surface is mounted',
          120_000,
        )
        assert(after.pid === aBefore.pid, 'M5D-04 HMR changed the Client PID')
        assert(after.rootFiberUid === aBefore.rootFiberUid, 'M5D-04 HMR changed the Client root Context fiber')
        assert(after.generationId === aBefore.generationId, 'M5D-04 HMR changed the transport generation')
        assert(after.surfaceRevision !== aBefore.surfaceRevision, 'M5D-04 the surface revision did not change')
        assert(after.surfaceFiberUid !== aBefore.surfaceFiberUid, 'M5D-04 the runner fiber did not change')
        assert(after.sessionOpen === true && after.openSessionId === sessionX,
          'M5D-04 the new revision did not re-adopt the exact Session')
        assert(after.owners?.typert === 1 && after.owners?.connection === 1 && after.owners?.remote === 1
          && after.owners?.fileUpload === 1 && after.owners?.sessions === 1 && after.owners?.jobs === 1,
        `M5D-04 duplicate/absent Domain owners after HMR: ${JSON.stringify(after.owners)}`)
        // The retired-before-mounted ORDER is read from the record stream: the
        // old revision must be unmounted before ANY new-revision mount, so the
        // two revisions never own A's PTY at the same time.
        const records = clientA.records
        const indexOfOp = op => records.findIndex(record => record.m4b2s === 'qualification' && record.op === op)
        const startIndex = indexOfOp('hmr-revision-start')
        const retiredIndex = indexOfOp('hmr-revision-retired')
        const readyIndex = indexOfOp('hmr-revision-ready')
        const oldUnmountedIndex = records.findIndex(record => record.m4b2s === 'surface-status'
          && record.surfaceRevision === aBefore.surfaceRevision && record.surfaceMounted === false)
        const newMountedIndex = records.findIndex(record => record.m4b2s === 'surface-status'
          && record.surfaceRevision === ready.revision && record.surfaceMounted === true)
        assert(startIndex >= 0 && startIndex < oldUnmountedIndex,
          'M5D-04 the replacement started before the old surface was unmounted')
        assert(oldUnmountedIndex < newMountedIndex, 'M5D-04 the replacement surface mounted over a live old surface')
        assert(oldUnmountedIndex < retiredIndex && retiredIndex < readyIndex,
          'M5D-04 the old revision was not retired before the replacement became ready')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-04 during A HMR')
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-04 A\'s HMR settled or cancelled the running Host Turn')
        assert(!existsSync(releaseBarrier), 'M5D-04 the hold barrier was released during HMR')
        await assertHostIdentityKept(host, hostBefore, 'M5D-04 Host after A HMR')
        const releaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-04 the original X Turn completed')
        assert(ends[0]?.data?.reason?.kind === 'completed',
          `M5D-04 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
        await clientA.waitForScreen('long-turn answer 1', 'M5D-04 the replacement revision read the settlement', 120_000)
        await clientB.waitForScreen('long-turn answer 1', 'M5D-04 B read the original Turn settlement', 120_000)
        const writeIndex = durableOf(sessionX).length
        await submitPrompt(clientB, 'm5d4-b-after-hmr')
        await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5d4-b-after-hmr',
          'M5D-04 B committed after A HMR', 120_000)
        const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'turn/end', 'M5D-04 B\'s own Turn settled', 120_000)
        assert(bEnd.data?.reason?.kind === 'completed', 'M5D-04 B\'s own Turn did not complete normally')
        await clientB.waitForScreen('long-turn answer 2', 'M5D-04 B read its own Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d4-b-after-hmr').length === 1,
          'M5D-04 B\'s own prompt committed more than once')
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d4-x-held').length === 1,
          'M5D-04 A\'s accepted prompt was replayed by HMR')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-04 at the end of the scene')
        const { exit: aExit } = await exitClientWithInventory(clientA, 'M5D-04 A')
        await exitC1Client(clientB, 'M5D-04 B')
        await stopDHost(host, 'M5D-04 Host')
        trace('m5d-04', {
          hostPid: hostBefore.hostPid,
          clientAPid: aBefore.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          revisionBefore: aBefore.surfaceRevision,
          revisionAfter: after.surfaceRevision,
          samePid: true,
          sameRootFiber: true,
          sameGeneration: true,
          retireBeforeReady: true,
          bIdentityKept: true,
          originalTurnSettlement: 'completed',
          aExitCode: aExit.code,
        })
      }

      // ── D-05: A HMR while B holds the SAME pending Host Question ──────────
      {
        const { host, ready: hostReady, workRoot } = await startC1Host('question', 'm5d5-interaction')
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-05 the Host ready record does not own the Host identity')
        // Deterministic observer boundary for the replacement mount: the
        // assembly hold pauses HMR BEFORE the new UI runtime is created. The
        // barrier is PRESENT for the initial mount (so it passes immediately)
        // and is removed only before the HMR gesture, so the replacement mount
        // is the one that actually blocks. Wiping the observer at that hold
        // cannot erase a new frame: none exists yet.
        const assemblyBarrier = join(workDir, 'm5d5-hmr-assembly.release')
        writeFileSync(assemblyBarrier, 'initial-mount\n', { mode: 0o600 })
        const { client: clientA, ready: aReady } = await startC1Client('M5D-05 A', {
          SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
          SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY: `domain@${assemblyBarrier}`,
        })
        // A creates the EMPTY Session X with the real product `/new`; B joins
        // the SAME X before the Host is asked, so both modals are the ONE
        // official delivery to two independent root interaction owners.
        const aBoundary = clientA.records.length
        clientA.send('/new\r')
        const aOpen = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= aBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== ''
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5D-05 A opened an empty Session X',
          120_000,
        )
        const sessionX = aOpen.openSessionId
        const { client: clientB, ready: bReady } = await startC1Client('M5D-05 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-05 B retained Session X')
        assertClientHostFacts(aOpen.host, hostBefore, 'M5D-05 A')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-05 B')
        assert(aReady.pid !== bReady.pid, 'M5D-05 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-05 the two Clients must use distinct script(1) wrappers')
        assertInteractionGate(clientA, 'M5D-05 A')
        assertInteractionGate(clientB, 'M5D-05 B')
        assert(!durableOf(sessionX).some(event => event.type === 'turn/start' || event.type === 'tool/call'
          || event.type === 'approval/asked'),
        'M5D-05 Host Session X carried Host activity before the trigger')
        const triggerIndex = durableOf(sessionX).length
        clientA.send('m5d5-interaction-trigger\r')
        const call = await waitForHostSessionEventAfter(dshHome, sessionX, triggerIndex,
          event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
          'M5D-05 the Host question tool/call', 120_000)
        assert(typeof call.data.callId === 'string' && call.data.callId !== '',
          'M5D-05 the question tool/call carries no callId')
        const callId = call.data.callId
        await waitForC1WorkEvent(workRoot,
          event => event.kind === 'question-request' && event.sessionId === sessionX,
          'M5D-05 the Host question request', 120_000)
        await clientA.waitForScreen('[1] Proceed', 'M5D-05 A painted the question modal', 120_000)
        await clientB.waitForScreen('[1] Proceed', 'M5D-05 B painted the question modal', 120_000)
        assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
          'M5D-05 Client A painted no question text')
        assert((await clientB.viewport()).join('\n').includes('Continue the C1 test?'),
          'M5D-05 Client B painted no question text')
        const aBefore = lastSurfaceStatus(clientA)
        assert(aBefore !== undefined && aBefore.surfaceMounted === true, 'M5D-05 Client A has no mounted status boundary')
        const bBefore = lastSurfaceStatus(clientB)
        const bBoundary = clientB.records.length
        const durableCheckpoint = durableOf(sessionX).length
        const hmrFrom = clientA.records.length
        // Release the initial-mount hold path: removing the barrier now makes
        // the NEXT mount (the replacement revision) pause at the domain hold.
        rmSync(assemblyBarrier, { force: true })
        // A retires and remounts its surface while the SAME Host Question is
        // pending. B is never touched and never pre-answers.
        clientA.signalBusiness('SIGUSR2')
        const start = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= hmrFrom
            && record.m4b2s === 'qualification' && record.op === 'hmr-revision-start',
          'M5D-05 HMR start',
          60_000,
        )
        await waitForSurfaceStatus(clientA,
          record => record.surfaceRevision === aBefore.surfaceRevision && record.surfaceMounted === false,
          'M5D-05 the old surface retired first',
          60_000,
        )
        await clientA.waitFor(
          record => clientA.records.indexOf(record) >= hmrFrom
            && record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired',
          'M5D-05 the old revision retired',
          120_000,
        )
        // The replacement mount is now DETERMINISTICALLY parked at the domain
        // assembly hold, after the old revision retired and BEFORE
        // createRemoteClientUiRuntime / the runner paint. Wipe this observer's
        // buffer here: no new frame can exist yet, so the reset can never
        // erase a legitimate paint (the record-poller race the old ui-mounted
        // sync had). Then release the barrier and wait for the new ready/frame.
        const assemblyHold = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= hmrFrom
            && record.m4b2s === 'qualification' && record.op === 'assembly-hold'
            && record.stage === 'domain',
          'M5D-05 the replacement paused before its UI creation',
          120_000,
        )
        assert(assemblyHold.barrier === assemblyBarrier, 'M5D-05 the replacement paused on another assembly barrier')
        await new Promise(resolveFlush => clientA.term.write('', resolveFlush))
        clientA.term.reset()
        await new Promise(resolveFlush => clientA.term.write('', resolveFlush))
        assert(!(await clientA.viewport()).join('\n').includes('[1] Proceed'),
          'M5D-05 the retired revision frame survived the observer reset')
        writeFileSync(assemblyBarrier, 'release\n', { mode: 0o600 })
        const ready = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= hmrFrom
            && record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready',
          'M5D-05 the replacement revision is ready',
          180_000,
        )
        assert(ready.revision === start.revision, 'M5D-05 the ready record named another revision')
        const after = await waitForSurfaceStatus(clientA,
          record => record.surfaceRevision === ready.revision && record.surfaceMounted === true,
          'M5D-05 the replacement surface is mounted',
          120_000,
        )
        assert(after.pid === aBefore.pid && after.rootFiberUid === aBefore.rootFiberUid
          && after.generationId === aBefore.generationId,
        'M5D-05 the HMR changed A\'s PID, root Context or transport generation')
        assert(after.sessionOpen === true && after.openSessionId === sessionX,
          'M5D-05 the replacement revision did not re-adopt Session X')
        // The NEW revision must PAINT the pending modal before B answers.
        await clientA.waitForScreen('[1] Proceed', 'M5D-05 the NEW revision repainted the pending Question', 180_000)
        assert((await clientA.viewport()).join('\n').includes('Continue the C1 test?'),
          'M5D-05 the new revision painted no question text')
        await clientB.waitForScreen('[1] Proceed', 'M5D-05 B still paints the answerable modal', 60_000)
        assert(!readC1WorkEvents(workRoot).some(event => event.kind === 'question-settled'),
          'M5D-05 A\'s HMR settled the Host question')
        assert(durableOf(sessionX).slice(durableCheckpoint).every(event => event.type !== 'tool/result'),
          'M5D-05 the pending question was settled before B answered')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-05 during A HMR')
        await assertHostIdentityKept(host, hostBefore, 'M5D-05 Host after A HMR')
        // B answers the SAME Host delivery with the real keyboard flow.
        const answerIndex = durableOf(sessionX).length
        clientB.send('1')
        await clientB.waitForScreen('Review your answer before submit', 'M5D-05 B question review', 30_000)
        clientB.send('\r')
        const settled = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'question-settled' && event.sessionId === sessionX,
          'M5D-05 the Host question settled', 120_000)
        assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
          `M5D-05 the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
        const result = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId,
          'M5D-05 the question tool result', 120_000)
        assert(result.data?.message?.isError !== true, 'M5D-05 the answered question failed at the Host')
        const questionEnd = await waitForHostSessionEventAfter(dshHome, sessionX, answerIndex,
          event => event.type === 'turn/end', 'M5D-05 the question Turn ended', 120_000)
        assert(questionEnd.data?.reason?.kind === 'completed',
          `M5D-05 the question Turn settled as ${JSON.stringify(questionEnd.data?.reason)} instead of a normal completion`)
        // The NEW revision withdraws the modal only after the official
        // settlement; A never answered and never cancelled it.
        await clientA.waitForScreenGone('[1] Proceed', 'M5D-05 A\'s new revision withdrew the settled modal', 120_000)
        await clientB.waitForScreen('question answered', 'M5D-05 B read the Host settlement', 120_000)
        const finalEvents = durableOf(sessionX)
        assert(finalEvents.filter(event => event.type === 'tool/result'
          && String(event.data?.message?.toolCallId) === callId).length === 1,
        'M5D-05 the Host question produced more than one tool result')
        const finalProofs = readC1WorkEvents(workRoot)
        assert(finalProofs.filter(event => event.kind === 'question-request' && event.sessionId === sessionX).length === 1,
          'M5D-05 the Host asked more than once')
        assert(finalProofs.filter(event => event.kind === 'question-settled' && event.sessionId === sessionX).length === 1,
          'M5D-05 the Host settled the question more than once')
        assert(finalProofs.every(event => !(event.kind === 'question-failed' && event.sessionId === sessionX)),
          'M5D-05 A\'s HMR cancelled the Host question instead of leaving it pending for B')
        assert(finalEvents.every(event => !(event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')),
          'M5D-05 the question Turn was aborted instead of settling normally')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-05 at the end of the scene')
        await assertHostIdentityKept(host, hostBefore, 'M5D-05 Host after the settlement')
        await exitC1Client(clientA, 'M5D-05 A')
        await exitC1Client(clientB, 'M5D-05 B')
        await stopDHost(host, 'M5D-05 Host')
        trace('m5d-05', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          callId,
          dualModalPainted: true,
          aRevisionBefore: aBefore.surfaceRevision,
          aRevisionAfter: after.surfaceRevision,
          newRevisionRepaintedPending: true,
          bAnsweredSameCallId: 'Proceed',
          hostToolResults: 1,
          hostQuestionSettlements: 1,
          aModalWithdrawn: true,
          turnSettlement: 'completed',
        })
      }

      // ── D-06: Host SIGKILL disconnects BOTH Clients, C is a NEW Host ──────
      {
        const releaseBarrier = join(workDir, 'm5d6-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d6-host-kill', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-06 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5D-06 A')
        const sessionX = await openC1Session(clientA, 'm5d6-x-held', 'M5D-06 A')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-06 X Turn held', 120_000)
        assert(held.agentStatus === 'running',
          `M5D-06 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-06 X turn/start', 120_000)
        const { client: clientB, ready: bReady } = await startC1Client('M5D-06 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-06 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-06 B')
        assert(aReady.pid !== bReady.pid, 'M5D-06 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-06 the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5D-06 B read the running X stream', 120_000)
        const aBoundary = clientA.records.length
        const bBoundary = clientB.records.length
        const durableBoundary = durableOf(sessionX).length
        const hostPid = hostBefore.hostPid
        const liveHostPids = () => findIsolatedProcesses(dshHome).filter(pid => {
          try {
            return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('local-host.mjs')
          } catch {
            return false
          }
        })
        // The COMMON failure: a REAL SIGKILL of the Host BUSINESS PID. This is
        // not a graceful Host stop, so no cleanup record is expected.
        process.kill(hostPid, 'SIGKILL')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), 'M5D-06 the Host survived SIGKILL')
        const aLost = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= aBoundary
            && record.m4b2s === 'surface-status'
            && record.transport !== 'connected'
            && record.generationId === undefined,
          'M5D-06 A observed the official lost generation',
          60_000,
        )
        const bLost = await clientB.waitFor(
          record => clientB.records.indexOf(record) >= bBoundary
            && record.m4b2s === 'surface-status'
            && record.transport !== 'connected'
            && record.generationId === undefined,
          'M5D-06 B observed the official lost generation',
          60_000,
        )
        for (const [lost, label] of [[aLost, 'A'], [bLost, 'B']]) {
          // The local Node Connection loop exits `connected` through its retry
          // state and clears the generation; the literal `disconnected` label
          // is the offline/network-unavailable branch and is not reachable
          // here. The generation-undefined loss record is the authoritative
          // "the old generation is gone" fact.
          assert(lost.transport !== 'connected',
            `M5D-06 Client ${label} still reported a connected transport after the Host kill`)
          assert(lost.generationId === undefined,
            `M5D-06 Client ${label} still reported a current generation after the Host kill`)
          assert(lost.host?.instanceId === hostBefore.instanceId,
            `M5D-06 Client ${label} dropped the dead Host identity before the replacement existed`)
        }
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-06 the pending Turn was reported as settled after a Host SIGKILL')
        assert(!hostAssistantHasText(durableOf(sessionX), 'long-turn answer'),
          'M5D-06 an answer was fabricated for the Turn lost in the Host SIGKILL')
        assert(!(await clientA.viewport()).join('\n').includes('long-turn answer'),
          'M5D-06 Client A painted a fabricated answer for the lost Turn')
        assert(!(await clientB.viewport()).join('\n').includes('long-turn answer'),
          'M5D-06 Client B painted a fabricated answer for the lost Turn')
        assert(!clientA.exited && !clientB.exited,
          'M5D-06 a Client treated the ordinary Host carrier loss as a fatal exit')
        // C is a genuinely NEW startup: its own cold discovery creates the
        // next Host instance, and the cold resume reads the durable history.
        const { client: clientC, ready: cReady } = await startC1Client('M5D-06 C', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const newHost = cReady.host
        assert(newHost.hostPid !== hostBefore.hostPid, 'M5D-06 stale discovery reused the killed Host PID')
        assert(newHost.instanceId !== hostBefore.instanceId, 'M5D-06 stale discovery reused the killed Host instance')
        // Host identity is the PID/starttime pair plus the authenticated
        // instance identity. Different PIDs already prove a different process;
        // a standalone cross-process `/proc` starttime inequality is tick-
        // granular and is not a contract (two fast processes may share a
        // tick). Verify the replacement Host's OWN registry facts instead.
        const newRegistry = readJson(join(dshHome, 'run', 'dsh-pi-tui', hostBefore.scopeId, 'instance.json'))
        assert(newRegistry.instanceId === newHost.instanceId
          && newRegistry.hostPid === newHost.hostPid
          && newRegistry.hostStarttime === newHost.hostStarttime,
        `M5D-06 the replacement Host registry does not match its authenticated identity: ${JSON.stringify(newRegistry)}`)
        await clientC.waitForScreen('m5d6-x-held', 'M5D-06 C cold history', 120_000)
        const recovered = await waitForHostSessionEventAfter(dshHome, sessionX, durableBoundary,
          event => event.type === 'turn/end', 'M5D-06 the new Host settled the orphaned Turn', 120_000)
        assert(recovered.data?.reason?.kind === 'interrupted',
          `M5D-06 the cold resume settled the lost Turn as ${String(recovered.data?.reason?.kind)}`)
        assert(durableOf(sessionX).filter(event => event.type === 'turn/start').length === 1,
          'M5D-06 the recovered settlement does not belong to the single lost Turn')
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d6-x-held').length === 1,
          'M5D-06 the cold resume replayed the accepted prompt')
        assert(!hostAssistantHasText(durableOf(sessionX), 'long-turn answer'),
          'M5D-06 the cold resume fabricated an answer')
        assert(!(await clientC.viewport()).join('\n').includes('long-turn answer'),
          'M5D-06 the resumed surface painted a fabricated answer')
        // AFTER C is up, the OLD Clients must NOT adopt the replacement Host.
        // The official identity fence is authoritative: the replacement Host
        // publishes new launch material, the old Client's retry reads it, sees
        // a DIFFERENT instanceId, and fails closed with
        // HOST_IDENTITY_MISMATCH instead of re-binding. That fail-closed exit
        // is the truthful no-takeover outcome for "不得将新 Host 的
        // instanceId/generation 冒充原 Host continuation"; no silent
        // continuation is possible. The deterministic causal input is the
        // replacement Host's launch material (published before its ready), and
        // every retry after that point reads it.
        const oldClientOutcomes = []
        for (const [client, ready, label] of [[clientA, aReady, 'A'], [clientB, bReady, 'B']]) {
          await waitForCondition(() => {
            client.readRecords()
            return client.records.some(record => record.m4a0 === 'failure') || client.exited
          }, `M5D-06 Client ${label} classified the replacement Host`, 60_000)
          client.readRecords()
          const failure = client.records.find(record => record.m4a0 === 'failure')
          assert(failure?.code === 'HOST_IDENTITY_MISMATCH',
            `M5D-06 Client ${label} did not take the official replacement-Host refusal: ${JSON.stringify(failure)}`)
          assert(/launch\.json names a different Host instance|Host identity changed/u.test(String(failure.error)),
            `M5D-06 Client ${label} failed for another reason: ${String(failure.error)}`)
          const exit = await client.waitForExit(60_000)
          assert(exit.code === 1 && exit.signal === null,
            `M5D-06 Client ${label} fail-closed exit was ${JSON.stringify(exit)}`)
          client.readRecords()
          assert(client.records.every(record => record.host?.instanceId !== newHost.instanceId),
            `M5D-06 Client ${label} recorded the replacement Host identity`)
          assert(client.records.every(record => !(record.m4b2s === 'surface-status' && record.transport === 'connected'
            && record.generationId !== undefined
            && record.host?.instanceId === newHost.instanceId)),
          `M5D-06 Client ${label} adopted a generation of the replacement Host`)
          oldClientOutcomes.push(`${label}:HOST_IDENTITY_MISMATCH`)
          await waitGone(ready.pid, 15_000)
          await client.dispose()
        }
        assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
          `M5D-06 expected exactly the replacement Host owner, found ${JSON.stringify(liveHostPids())}`)
        assert(!existsSync(releaseBarrier), 'M5D-06 the hold barrier was released during the Host failure')
        // C leaves normally; the replacement Host keeps running (Client
        // lifetime is independent of the Host) and is stopped through its own
        // owner path afterwards.
        await exitC1Client(clientC, 'M5D-06 C')
        assert(alive(newHost.hostPid), 'M5D-06 the replacement Host died when C exited')
        // Stop the REPLACEMENT Host through its owner path. It is a new Host,
        // never a revived original instance.
        process.kill(newHost.hostPid, 'SIGTERM')
        await waitGone(newHost.hostPid, 30_000)
        assert(!alive(newHost.hostPid), 'M5D-06 the replacement Host survived the official SIGTERM')
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        await stopC1Host(host)
        trace('m5d-06', {
          hostPid,
          signal: 'SIGKILL',
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          aObserved: aLost.transport,
          bObserved: bLost.transport,
          oldClientOutcomes,
          newHostPid: newHost.hostPid,
          newInstanceId: newHost.instanceId,
          orphanSettlement: 'interrupted',
          fabricatedSettlement: false,
          automaticTakeover: false,
        })
      }

      // ── D-07: A SIGHUP is a process failure, B keeps the running X ────────
      {
        const releaseBarrier = join(workDir, 'm5d7-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d7-client-hup', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-07 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5D-07 A')
        const sessionX = await openC1Session(clientA, 'm5d7-x-held', 'M5D-07 A')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-07 X Turn held', 120_000)
        assert(held.agentStatus === 'running',
          `M5D-07 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-07 X turn/start', 120_000)
        const { client: clientB, ready: bReady } = await startC1Client('M5D-07 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-07 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-07 B')
        assert(aReady.pid !== bReady.pid, 'M5D-07 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-07 the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5D-07 B read the running X stream', 120_000)
        const bBefore = lastSurfaceStatus(clientB)
        const bBoundary = clientB.records.length
        const durableBoundary = durableOf(sessionX).length
        // A REAL SIGHUP to the Client BUSINESS PID: the default disposition
        // terminates it, so this is NOT the graceful coordinator path and no
        // `client-closed` inventory may be expected.
        clientA.signalBusiness('SIGHUP')
        await waitGone(aReady.pid, 15_000)
        assert(!alive(aReady.pid), 'M5D-07 Client A survived SIGHUP')
        const aExit = await clientA.waitForExit(60_000)
        assert(aExit.code === 129 && aExit.signal === null,
          `M5D-07 SIGHUP wrapper exit was ${JSON.stringify(aExit)} (script -e maps SIGHUP to 128+1=129)`)
        clientA.readRecords()
        assert(clientA.records.every(record => record.m4b2s !== 'client-closed'),
          'M5D-07 the SIGHUP process-failure path fabricated a graceful owner inventory')
        await clientA.dispose()
        assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-07 A\'s SIGHUP killed the Host or Client B')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-07 after A SIGHUP')
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-07 A\'s SIGHUP settled or cancelled the running Host Turn')
        assert(!existsSync(releaseBarrier), 'M5D-07 the hold barrier was released before the original Turn completed')
        await assertHostIdentityKept(host, hostBefore, 'M5D-07 Host after A SIGHUP')
        const releaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-07 the original X Turn completed')
        assert(ends[0]?.data?.reason?.kind === 'completed',
          `M5D-07 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
        await clientB.waitForScreen('long-turn answer 1', 'M5D-07 B read the original Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d7-x-held').length === 1,
          'M5D-07 the accepted prompt was replayed or lost across A\'s SIGHUP')
        const writeIndex = durableOf(sessionX).length
        await submitPrompt(clientB, 'm5d7-b-after-hup')
        await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5d7-b-after-hup',
          'M5D-07 B committed after A was HUPed', 120_000)
        const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'turn/end', 'M5D-07 B\'s own Turn settled', 120_000)
        assert(bEnd.data?.reason?.kind === 'completed', 'M5D-07 B\'s own Turn did not complete normally')
        await clientB.waitForScreen('long-turn answer 2', 'M5D-07 B read its own Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d7-b-after-hup').length === 1,
          'M5D-07 B\'s own prompt committed more than once')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-07 at the end of the scene')
        await exitC1Client(clientB, 'M5D-07 B')
        await stopDHost(host, 'M5D-07 Host')
        trace('m5d-07', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          signal: 'SIGHUP',
          aWrapperExit: aExit,
          gracefulInventoryClaimed: false,
          originalTurnSettlement: 'completed',
          bOwnReadback: true,
        })
      }

      // ── D-08: N-composite X -> Y navigation, then A exits from Y ──────────
      {
        const releaseBarrier = join(workDir, 'm5d8-long-turn.release')
        const { host, ready: hostReady, workRoot } = await startC1Host('long-turn', 'm5d8-navigation', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const hostBefore = await hostIdentityFacts(host)
        assert(hostBefore.hostPid === hostReady.pid, 'M5D-08 the Host ready record does not own the Host identity')
        const { client: clientA, ready: aReady } = await startC1Client('M5D-08 A')
        const sessionX = await openC1Session(clientA, 'm5d8-x-held', 'M5D-08 A')
        const held = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionX, 'M5D-08 X Turn held', 120_000)
        assert(held.agentStatus === 'running',
          `M5D-08 the Host Agent was ${JSON.stringify(held.agentStatus)} while X was held`)
        await waitForHostSessionEvent(dshHome, sessionX, event => event.type === 'turn/start', 'M5D-08 X turn/start', 120_000)
        // A's own OLD X frame must carry the unique prompt before the switch.
        await waitForCondition(async () => (await clientA.viewport()).join('\n').includes('m5d8-x-held'),
          'M5D-08 A painted the original X-only prompt', 120_000)
        const { client: clientB, ready: bReady } = await startC1Client('M5D-08 B', {
          SPLIT_PROCESS_CLIENT_SESSION: sessionX,
        })
        const bOnX = await waitForSurfaceStatus(clientB,
          record => record.sessionOpen === true && record.openSessionId === sessionX
            && record.transport === 'connected' && record.surfaceMounted === true,
          'M5D-08 B retained Session X')
        assertClientHostFacts(bOnX.host, hostBefore, 'M5D-08 B')
        assert(aReady.pid !== bReady.pid, 'M5D-08 the two Clients must be two different business PIDs')
        assert(clientA.child.pid !== clientB.child.pid, 'M5D-08 the two Clients must use distinct script(1) wrappers')
        await clientB.waitForScreen('long-turn started', 'M5D-08 B read the running X stream', 120_000)
        const bBefore = lastSurfaceStatus(clientB)
        const bBoundary = clientB.records.length
        const durableBoundary = durableOf(sessionX).length
        const xHeader = await waitForHostSessionHeader(dshHome, sessionX, 'M5D-08 X durable header')
        const sessionsBeforeNew = hostSessionLogCount(dshHome)
        // The N-gesture: the real `/new` while X's original Turn is RUNNING.
        // The pending-Question/Approval modal is NOT used here (the editor
        // seat forbids a lifecycle command under a pending interaction).
        const newBoundary = clientA.records.length
        clientA.send('/new\r')
        const aOnY = await clientA.waitFor(
          record => clientA.records.indexOf(record) >= newBoundary
            && record.m4b2s === 'surface-status'
            && record.sessionOpen === true
            && typeof record.openSessionId === 'string'
            && record.openSessionId !== sessionX
            && record.transport === 'connected'
            && record.surfaceMounted === true,
          'M5D-08 A opened Session Y while X was held',
          120_000,
        )
        const sessionY = aOnY.openSessionId
        assertClientHostFacts(aOnY.host, hostBefore, 'M5D-08 A on Y')
        // A status record is NOT a painted frame. Y is empty, so its welcome
        // card names the EXACT Y id — the Y-only paint fact — and only then is
        // the X-only transcript absence asserted.
        await waitForCondition(async () => (await clientA.viewport()).join('\n').includes(sessionY),
          'M5D-08 A painted the NEW Y surface', 120_000)
        assert(!(await clientA.viewport()).join('\n').includes('m5d8-x-held'),
          'M5D-08 the X-only transcript survived the /new navigation')
        assert(!existsSync(releaseBarrier), 'M5D-08 the hold barrier was released during /new')
        const yHeader = await waitForHostSessionHeader(dshHome, sessionY, 'M5D-08 Y durable header')
        assert(hostSessionLogCount(dshHome) === sessionsBeforeNew + 1,
          `M5D-08 /new created ${String(hostSessionLogCount(dshHome) - sessionsBeforeNew)} durable Sessions, expected exactly 1`)
        assert(yHeader.cwd === xHeader.cwd,
          `M5D-08 the new Y Session Workspace is not the captured Host Workspace: ${String(yHeader.cwd)} != ${String(xHeader.cwd)}`)
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-08 the /new navigation ended or cancelled the running X Turn')
        // A exits from Y (its CURRENT Session) with the full owner inventory.
        const { exit: aExit } = await exitClientWithInventory(clientA, 'M5D-08 A')
        await waitGone(aReady.pid, 15_000)
        assert(!alive(aReady.pid), 'M5D-08 Client A survived its exit from Y')
        assert(alive(bReady.pid) && alive(hostBefore.hostPid), 'M5D-08 A\'s exit killed the Host or Client B')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-08 after A navigated and exited')
        assert(durableOf(sessionX).slice(durableBoundary).every(event => event.type !== 'turn/end'),
          'M5D-08 A\'s exit from Y ended or cancelled the original X Turn')
        await assertHostIdentityKept(host, hostBefore, 'M5D-08 Host after A exited from Y')
        // The ORIGINAL X Turn — left twice (navigation, then exit) — completes
        // and B reads/writes the SAME Session X.
        const releaseIndex = durableOf(sessionX).length
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ends = await waitForTurnEnds(sessionX, releaseIndex, 1, 'M5D-08 the original X Turn completed')
        assert(ends[0]?.data?.reason?.kind === 'completed',
          `M5D-08 the original X Turn settled as ${JSON.stringify(ends[0]?.data?.reason)}`)
        await clientB.waitForScreen('long-turn answer 1', 'M5D-08 B read the original Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d8-x-held').length === 1,
          'M5D-08 the accepted X prompt was replayed or lost')
        const writeIndex = durableOf(sessionX).length
        await submitPrompt(clientB, 'm5d8-b-after-navigation')
        await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'user/message' && textOf(event.data) === 'm5d8-b-after-navigation',
          'M5D-08 B committed after A exited from Y', 120_000)
        const bEnd = await waitForHostSessionEventAfter(dshHome, sessionX, writeIndex,
          event => event.type === 'turn/end', 'M5D-08 B\'s own Turn settled', 120_000)
        assert(bEnd.data?.reason?.kind === 'completed', 'M5D-08 B\'s own Turn did not complete normally')
        await clientB.waitForScreen('long-turn answer 2', 'M5D-08 B read its own Turn settlement', 120_000)
        assert(hostUserTexts(durableOf(sessionX)).filter(text => text === 'm5d8-b-after-navigation').length === 1,
          'M5D-08 B\'s own prompt committed more than once')
        assertSecondClientKept(clientB, bBefore, bBoundary, 'M5D-08 at the end of the scene')
        // Y was a real ONE Host-created Session and stayed EMPTY of turns: A
        // never wrote there, it only released its own Y reference on exit.
        assert(durableOf(sessionY).every(event => event.type !== 'user/message'),
          'M5D-08 the empty Y Session received a message A never sent')
        await exitC1Client(clientB, 'M5D-08 B')
        await stopDHost(host, 'M5D-08 Host')
        trace('m5d-08', {
          hostPid: hostBefore.hostPid,
          clientAPid: aReady.pid,
          clientBPid: bReady.pid,
          wrapperPids: [clientA.child.pid, clientB.child.pid],
          sessionX,
          sessionY,
          aExitCode: aExit.code,
          navigatedBeforeExit: true,
          aExitedFrom: 'Y',
          originalXTurnCompletion: 'completed',
          bOwnReadback: true,
          bOwnTurn: 'completed',
        })
      }

      // T44: a real accepted Turn survives a Client SIGKILL. The LLM stream is
      // held by the Host fixture; the Client disappears while the Host Agent is
      // running, then the SAME Host writes the final assistant message.
      {
        const releaseBarrier = join(workDir, 't44-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't44', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T44 C1')
        const sessionId = await openC1Session(c1, 't44 prompt', 'T44')
        const held = await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T44 long-turn held')
        assert(held.agentStatus === 'running', `T44 the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T44 turn/start')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        assert(!alive(c1Pid), 'T44 the surface Client survived SIGKILL')
        await c1.dispose()
        assert(alive(ready.pid), 'T44 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T44 Host after Client SIGKILL')
        const beforeRelease = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!beforeRelease.some(event => event.type === 'turn/end'),
          'T44 the Turn had already ended before the barrier was released — the case is not a running-Turn proof')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T44 turn/end without a Client')
        const events = hostSessionEvents(dshHome, sessionId) ?? []
        assert(hostUserTexts(events).filter(text => text === 't44 prompt').length === 1,
          'T44 the prompt was replayed or lost')
        assert(hostAssistantHasText(events, 'long-turn answer'), 'T44 the Host did not write the final assistant message without a Client')
        const { client: c2 } = await startC1Client('T44 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('long-turn answer', 'T44 C2 readback')
        await waitForSurfaceStatus(c2, record => record.openSessionId === sessionId, 'T44 C2 exact Session')
        await exitC1Client(c2, 'T44 C2')
        await stopC1Host(host)
        trace('t44', {
          hostPid: ready.pid,
          c1Pid,
          sessionId,
          hostAliveDuringDetach: true,
          turnEndedWithZeroClients: true,
          promptReplays: 1,
          c2Readback: true,
        })
      }

      // T45: the same running Turn survives a CLEAN Client exit (`/exit`).
      {
        const releaseBarrier = join(workDir, 't45-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't45', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T45 C1')
        const sessionId = await openC1Session(c1, 't45 prompt', 'T45')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T45 long-turn held')
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T45 turn/start')
        const hostBefore = await hostIdentityFacts(host)
        await exitC1Client(c1, 'T45 C1 clean exit')
        assert(alive(ready.pid), 'T45 the Host died on the Client clean exit')
        await assertHostIdentityKept(host, hostBefore, 'T45 Host after clean Client exit')
        const beforeRelease = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!beforeRelease.some(event => event.type === 'turn/end'),
          'T45 the Client clean exit cancelled or settled the Host Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T45 turn/end without a Client')
        const events = hostSessionEvents(dshHome, sessionId) ?? []
        assert(hostUserTexts(events).filter(text => text === 't45 prompt').length === 1, 'T45 the prompt was replayed')
        const { client: c2 } = await startC1Client('T45 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('long-turn answer', 'T45 C2 readback')
        await exitC1Client(c2, 'T45 C2')
        await stopC1Host(host)
        trace('t45', { hostPid: ready.pid, sessionId, cleanExitDidNotCancel: true, c2Readback: true })
      }

      // T46: a real foreground Host Tool call survives the Client exit and its
      // result is written exactly once by the Host Tool authority.
      {
        const releaseBarrier = join(workDir, 't46-tool.release')
        const { host, ready, workRoot } = await startC1Host('foreground-tool', 't46', {
          C1_HOLD_TOOL: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T46 C1')
        const sessionId = await openC1Session(c1, 't46 prompt', 'T46')
        const toolStarted = await waitForC1WorkEvent(workRoot, event => event.kind === 'tool-started' && event.token?.includes(sessionId), 'T46 real Host tool call')
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'c1_foreground_tool', 'T46 tool/call')
        assert(String(call.data.callId) === toolStarted.callId, 'T46 fixture proof and durable tool/call disagree on the call id')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), 'T46 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T46 Host after Client detach')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const result = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolStarted.callId, 'T46 Host tool/result')
        assert(result.data?.message?.isError !== true, 'T46 the held Host Tool failed')
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T46 turn/end')
        const results = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolStarted.callId)
        assert(results.length === 1, `T46 the Host Tool executed ${String(results.length)} times`)
        const { client: c2 } = await startC1Client('T46 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('foreground answer', 'T46 C2 readback')
        await exitC1Client(c2, 'T46 C2')
        await stopC1Host(host)
        trace('t46', { hostPid: ready.pid, sessionId, callId: toolStarted.callId, toolResults: 1, hostAlive: true })
      }

      // T47: a real background Job (official ctx.jobs registry + OS process)
      // keeps running after the Client exits and settles without one.
      {
        const releaseBarrier = join(workDir, 't47-job.release')
        const { host, ready, workRoot } = await startC1Host('job', 't47', {}, c1JobWorkRoot('t47'))
        const jobRelease = join(workRoot, 'job.release')
        rmSync(jobRelease, { force: true })
        const { client: c1 } = await startC1Client('T47 C1')
        const sessionId = await openC1Session(c1, 't47 prompt', 'T47')
        const registered = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'registered', 'T47 job registered')
        assert(typeof registered.jobId === 'string' && registered.status === 'running', 'T47 no real running Host Job')
        assert(registered.owner === sessionId, 'T47 the Job owner is not the exact Session')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), 'T47 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T47 Host after Client detach')
        await sleep(500)
        const eventsWhileDetached = readC1WorkEvents(workRoot).filter(event => event.kind === 'job-event' && event.jobId === registered.jobId)
        assert(eventsWhileDetached.every(event => event.event !== 'settled'), 'T47 the Job settled while no Client existed and the barrier was held')
        const jobLiveness = (await hostStatus(host)).liveness
        assert(jobLiveness?.verdict === 'BLOCKED', `T47 the Host status did not report BLOCKED while an owned Job ran: ${JSON.stringify(jobLiveness)}`)
        assert(jobLiveness.reasons?.includes('job-running'), 'T47 the owned Job did not contribute job-running')
        assert(jobLiveness.sourceStates?.jobs === 'ACTIVE', 'T47 the jobs source is not ACTIVE')
        writeFileSync(jobRelease, 'release\n', { mode: 0o600 })
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === registered.jobId && event.event === 'settled', 'T47 job settled without a Client', 120_000)
        assert(settled.status === 'completed', `T47 the Job settled as ${JSON.stringify(settled.status)}`)
        assert(typeof settled.output === 'string' && settled.output.includes('c1-job-done'),
          `T47 the Job output ring did not carry the real process output: ${JSON.stringify(settled.output)}`)
        const settledLiveness = (await hostStatus(host)).liveness
        assert(!settledLiveness.reasons?.includes('job-running') && !settledLiveness.reasons?.includes('job-stopping'),
          `T47 a settled Job left a ghost Job reason: ${JSON.stringify(settledLiveness)}`)
        const { client: c2 } = await startC1Client('T47 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('job accepted', 'T47 C2 job result')
        await exitC1Client(c2, 'T47 C2')
        await stopC1Host(host)
        trace('t47', { hostPid: ready.pid, sessionId, jobId: registered.jobId, jobStatus: settled.status, hostAlive: true, processOutput: true })
      }

      // Host liveness: one real DSH JobRegistry unowned Job. No Client and no
      // Agent is involved; the observer must see the registry's unowned list
      // and event lifecycle directly.
      {
        const { host, ready, workRoot } = await startC1Host('unowned-job', 'unowned-job-arm', {
          C1_UNOWNED_JOB_ARM: join(workDir, 'unowned-job-arm.arm'),
        })
        writeFileSync(join(workDir, 'unowned-job-arm.arm'), 'arm\n', { mode: 0o600 })
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'unowned-job-created', 'unowned job created', 120_000)
        const runningLiveness = (await hostStatus(host)).liveness
        assert(runningLiveness?.verdict === 'BLOCKED', `the unowned Job did not block: ${JSON.stringify(runningLiveness)}`)
        assert(runningLiveness.reasons?.includes('job-running'), 'the unowned Job did not contribute job-running')
        assert(runningLiveness.sourceStates?.jobs === 'ACTIVE', 'the unowned Job did not make the jobs source ACTIVE')
        writeFileSync(join(workRoot, 'unowned-job.release'), 'release\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'unowned-job-released' && event.jobId === created.jobId, 'unowned job released', 120_000)
        await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'settled' && event.jobId === created.jobId, 'unowned job settled', 120_000)
        const settledLiveness = (await hostStatus(host)).liveness
        assert(!settledLiveness.reasons?.includes('job-running') && !settledLiveness.reasons?.includes('job-stopping'),
          `a settled unowned Job left a ghost reason: ${JSON.stringify(settledLiveness)}`)
        assert(settledLiveness.sourceStates?.jobs === 'IDLE', `the unowned Job source did not return to IDLE: ${JSON.stringify(settledLiveness.sourceStates)}`)
        await stopC1Host(host)
        trace('unowned-job-arm', { hostPid: ready.pid, jobId: created.jobId, runningVerdict: runningLiveness.verdict, settledJobsState: settledLiveness.sourceStates.jobs })
      }

      // Host liveness: ONE real armed Goal is the only thing that keeps this
      // Host from claiming quiescence. The automatic `goal-round-driver` row is
      // disabled on this Host on purpose: it reserves a round the moment the
      // Goal is armed, and with the fixture's instant scripted answer that
      // round ends and the driver then blocks the Goal at `round-limit`. The
      // armed state would then be a transient window whose Host status depends
      // on when the read lands, so the driver's own reservation is qualified
      // separately by the goal-round case below.
      {
        const armedPatch = join(workDir, 'goal-armed.patch.yml')
        const operations = parseYaml(readFileSync(c1Work.patchPath, 'utf8'))
        operations.push({ id: 'goal-round-driver', disabled: true })
        writeFileSync(armedPatch, JSON.stringify(operations, null, 2), { mode: 0o600 })
        const { host, ready, workRoot } = await startC1Host('goal-armed', 'goal-armed', {
          SPLIT_PROCESS_EXTRA_PATCH: armedPatch,
        })
        // The readiness record's Loader rows are the authority that the
        // automatic driver really is OFF here: a disabled row stays listed with
        // the `absent` state (a failed or transitional row would report a
        // `state-N` fiber value), exactly one row may carry the id, and its
        // name must be the official driver package.
        const driverRows = ready.entries.filter(entry => entry.id === 'goal-round-driver')
        assert(driverRows.length === 1
            && driverRows[0].state === 'absent'
            && driverRows[0].name === '@deepseek-ai/dsh-goal-round-driver',
          `the armed-Goal Host did not carry exactly one never-mounted goal-round-driver row: ${JSON.stringify(driverRows)}`)
        // Only the driver is isolated: the Goal service row stays ACTIVE, so
        // this Host still reads a real official Goal source.
        assert(ready.entries.some(entry => entry.id === 'goal'
            && entry.name === '@deepseek-ai/dsh-goal'
            && entry.state === 'active'),
          'the armed-Goal Host lost the real Goal service row instead of only its round driver')
        const { client } = await startC1Client('goal-armed C1')
        const sessionId = await openC1Session(client, 'goal-armed prompt', 'goal-armed')
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-created', 'goal-armed goal created', 120_000)
        assert(created.goalPhase === 'active' && created.activation === 'armed', `goal-armed goal was not armed: ${JSON.stringify(created)}`)
        const goalLiveness = (await hostStatus(host)).liveness
        assert(goalLiveness?.verdict === 'BLOCKED', `the armed Goal did not block: ${JSON.stringify(goalLiveness)}`)
        assert(goalLiveness.reasons?.includes('goal-armed'), 'the armed Goal did not contribute goal-armed')
        assert(goalLiveness.sourceStates?.goal === 'ACTIVE', 'the goal source is not ACTIVE')
        // The Goal is the sole blocking source: the Agent itself is idle with
        // an empty inbox, so neither of its live-work reasons may appear.
        assert(goalLiveness.sourceStates?.agent !== 'ACTIVE', `the Agent was ACTIVE beside the armed Goal: ${JSON.stringify(goalLiveness.sourceStates)}`)
        assert(!goalLiveness.reasons?.includes('agent-running') && !goalLiveness.reasons?.includes('agent-inbox'),
          `the Agent contributed a blocking reason beside the armed Goal: ${JSON.stringify(goalLiveness.reasons)}`)
        // The C1 Host mounts one active test-only file-URL Loader row through
        // `c1Work.patchPath`. Reading the REAL `context.loader` must surface it
        // as an unqualified Host source; the reflect-store probe this replaced
        // silently missed every active Loader row on the real Host path.
        assert(goalLiveness.sourceStates?.other === 'UNKNOWN', 'the active test-only Loader row was not observed through the real Loader')
        assert(goalLiveness.reasons?.includes('unqualified-host-source'), 'the unqualified Host source reason is missing')
        // The create is the only Goal transition this Host could have made: no
        // automatic round, so no pause/block/disarm inside the observation.
        const armedMutations = readC1WorkEvents(workRoot).filter(event => event.kind === 'goal-changed')
        assert(armedMutations.length === 1 && armedMutations[0].goalId === created.goalId && armedMutations[0].operation === 'create',
          `the isolated armed Goal moved out of the created state: ${JSON.stringify(armedMutations)}`)
        await exitC1Client(client, 'goal-armed C1')
        await stopC1Host(host)
        trace('goal-armed', {
          hostPid: ready.pid,
          sessionId,
          goalId: created.goalId,
          verdict: goalLiveness.verdict,
          goalState: goalLiveness.sourceStates.goal,
          agentState: goalLiveness.sourceStates.agent,
        })
      }

      // The REAL `goal-round-driver` owns the automatic reservation: the
      // fixture only creates the governing Goal through the official service
      // and never queues the round itself. This case proves the reservation is
      // a real Agent inbox round and that the one-round budget then ends the
      // armed state. It reads no Host liveness, because with this driver
      // mounted the armed Goal is transient by design; the stable armed-Goal
      // liveness proof is the goal-armed case above.
      {
        const { host, ready, workRoot } = await startC1Host('goal-round', 'goal-round')
        // Positive control for the armed case's row vocabulary: the same id,
        // name and `active` state are what the real driver mounts when the
        // overlay does not disable it.
        const driverRows = ready.entries.filter(entry => entry.id === 'goal-round-driver')
        assert(driverRows.length === 1
            && driverRows[0].state === 'active'
            && driverRows[0].name === '@deepseek-ai/dsh-goal-round-driver',
          `the goal-round Host did not mount exactly one active goal-round-driver row: ${JSON.stringify(driverRows)}`)
        const { client } = await startC1Client('goal-round C1')
        const sessionId = await openC1Session(client, 'goal-round prompt', 'goal-round')
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-created', 'goal-round goal created', 120_000)
        assert(created.goalPhase === 'active' && created.activation === 'armed', `goal-round goal was not armed: ${JSON.stringify(created)}`)
        const round = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-round-observed', 'goal round reserved', 120_000)
        assert(round.goalId === created.goalId, 'the reserved goal round names a different Goal')
        assert(round.revision === created.revision, `the reserved goal round names revision ${JSON.stringify(round.revision)}`)
        assert(round.round === 1, `the first automatic goal round was ${JSON.stringify(round.round)}`)
        assert(round.agentStatus === 'idle', `the goal round was reserved while the Agent was ${JSON.stringify(round.agentStatus)}`)
        // The reservation is durable: the official loop admitted this exact
        // round as a Session `user/message`, which is what consumes the budget.
        const admitted = await waitForHostSessionEvent(dshHome, sessionId,
          event => event.type === 'user/message' && event.data?.source?.kind === 'goal', 'goal round admitted', 120_000)
        assert(String(admitted.data.source.goalId) === created.goalId
            && admitted.data.source.revision === created.revision
            && admitted.data.source.round === round.round,
          `the durable goal round disagrees with the reservation: ${JSON.stringify(admitted.data.source)}`)
        // Then the driver ends the armed state at the round limit instead of
        // reserving another round: the recorded transition names the reason.
        const blocked = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-changed' && event.operation === 'block', 'goal round-limit block', 120_000)
        assert(String(blocked.goalId) === created.goalId && blocked.blockCode === 'round-limit' && blocked.goalPhase === 'blocked' && blocked.activation === 'disarmed',
          `the Goal did not leave the armed state at its round limit: ${JSON.stringify(blocked)}`)
        await exitC1Client(client, 'goal-round C1')
        await stopC1Host(host)
        trace('goal-round', {
          hostPid: ready.pid,
          sessionId,
          goalId: created.goalId,
          round: round.round,
          agentStatus: round.agentStatus,
          blockCode: blocked.blockCode,
        })
      }

      // Host liveness: Agent.runMaintenance() is really executing while the
      // public Agent status stays idle. The observer must not claim quiescence;
      // rc.4 has no synchronous maintenance getter, so UNKNOWN is correct.
      {
        const { host, ready, workRoot } = await startC1Host('maintenance', 'maintenance-sweep')
        const { client } = await startC1Client('maintenance C1')
        const sessionId = await openC1Session(client, 'maintenance prompt', 'maintenance')
        const maintenance = await waitForC1WorkEvent(workRoot, event => event.kind === 'maintenance' && event.phase === 'running', 'maintenance running', 120_000)
        assert(maintenance.agentStatus === 'idle', `maintenance ran while the Agent was ${JSON.stringify(maintenance.agentStatus)}`)
        const maintenanceLiveness = (await hostStatus(host)).liveness
        assert(maintenanceLiveness?.verdict === 'UNKNOWN', `maintenance did not leave the Host UNKNOWN: ${JSON.stringify(maintenanceLiveness)}`)
        assert(maintenanceLiveness.verdict !== 'OBSERVED_QUIESCENT', 'maintenance was reported as quiescent')
        assert(maintenanceLiveness.reasons?.includes('agent-maintenance-unproven'), 'the maintenance gap is not reported')
        writeFileSync(join(workRoot, 'maintenance.release'), 'release\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'maintenance' && event.phase === 'settled', 'maintenance settled', 120_000)
        await exitC1Client(client, 'maintenance C1')
        await stopC1Host(host)
        trace('maintenance-sweep', { hostPid: ready.pid, sessionId, agentStatus: maintenance.agentStatus, verdict: maintenanceLiveness.verdict })
      }

      // Host liveness: the optional official Schedule row is mounted in an
      // isolated test-only overlay. An active task must block with zero
      // Clients; deleting it must clear the schedule-active contribution.
      {
        const schedulePatch = join(workDir, 'host-schedule.patch.yml')
        const operations = parseYaml(readFileSync(c1Work.patchPath, 'utf8'))
        operations.push({ insert: [{ id: 'host-schedule', name: '@deepseek-ai/dsh-schedule' }] })
        writeFileSync(schedulePatch, JSON.stringify(operations, null, 2), { mode: 0o600 })
        const { host, ready, workRoot } = await startC1Host('schedule', 'host-schedule', { SPLIT_PROCESS_EXTRA_PATCH: schedulePatch })
        const { client } = await startC1Client('schedule C1')
        const sessionId = await openC1Session(client, 'schedule prompt', 'schedule')
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'schedule-created' && event.status === 'active', 'schedule created', 120_000)
        await exitC1Client(client, 'schedule C1')
        const activeLiveness = (await hostStatus(host)).liveness
        assert(activeLiveness?.verdict === 'BLOCKED', `the active Schedule task did not block: ${JSON.stringify(activeLiveness)}`)
        assert(activeLiveness.reasons?.includes('schedule-active'), 'the active Schedule task did not contribute schedule-active')
        assert(activeLiveness.sourceStates?.schedule === 'ACTIVE', 'the schedule source is not ACTIVE')
        writeFileSync(join(workRoot, 'schedule.delete'), 'delete\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'schedule-deleted' && event.deleted === true, 'schedule deleted', 120_000)
        const deletedLiveness = (await hostStatus(host)).liveness
        assert(!deletedLiveness.reasons?.includes('schedule-active'), `a deleted Schedule task left an active reason: ${JSON.stringify(deletedLiveness)}`)
        assert(deletedLiveness.sourceStates?.schedule === 'IDLE', `the schedule source did not return to IDLE: ${JSON.stringify(deletedLiveness.sourceStates)}`)
        await stopC1Host(host)
        trace('host-schedule', { hostPid: ready.pid, sessionId, scheduleId: created.scheduleId, activeVerdict: activeLiveness.verdict, deletedScheduleState: deletedLiveness.sourceStates.schedule })
      }

      // T48: a real continuable Child survives the Client exit; the Child
      // Session's own durable log carries its final assistant message.
      {
        const releaseBarrier = join(workDir, 't48-child.release')
        const { host, ready, workRoot } = await startC1Host('child', 't48', {
          C1_HOLD_CHILD: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T48 C1')
        const sessionId = await openC1Session(c1, 't48 prompt', 'T48')
        const started = await waitForC1WorkEvent(workRoot, event => event.kind === 'subagent-start', 'T48 real subagent/start', 120_000)
        assert(typeof started.childId === 'string' && started.childId !== sessionId, 'T48 no distinct Child Agent identity')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'child-stream-held' && event.sessionId === started.childId, 'T48 Child LLM stream held')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), 'T48 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T48 Host after Client detach')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ended = await waitForC1WorkEvent(workRoot, event => event.kind === 'subagent-end' && event.childId === started.childId, 'T48 real subagent/end', 120_000)
        assert(ended.runId === started.runId, 'T48 the subagent end does not pair the start run id')
        const childEvents = await (async () => {
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            const events = hostSessionEvents(dshHome, started.childId)
            if (events !== undefined && hostAssistantHasText(events, 'child answer')) return events
            await sleep(50)
          }
          return undefined
        })()
        assert(childEvents !== undefined, 'T48 the Child Session durable log has no final assistant message')
        const { client: c2 } = await startC1Client('T48 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('child delegated', 'T48 C2 parent readback')
        await exitC1Client(c2, 'T48 C2')
        await stopC1Host(host)
        trace('t48', { hostPid: ready.pid, parentSessionId: sessionId, childId: started.childId, runId: started.runId, childDurable: true })
      }

      // rc.4 exposes no pending inventory: after a Client detaches, the Host
      // status must keep the pending source fail-closed as UNKNOWN with the
      // stable gap reason. This asserts only the absence of an inventory; it
      // never names a request id or claims an expiry outcome.
      const assertPendingUnobservable = async (host, before, label) => {
        const status = await hostStatus(host)
        assertIdentityFields(status.localHost, before, `${label} Host status identity`)
        const liveness = status.liveness
        assert(liveness?.sourceStates?.pending === 'UNKNOWN',
          `${label} the pending source is not UNKNOWN: ${JSON.stringify(liveness?.sourceStates)}`)
        assert(liveness.reasons?.includes('pending-interaction-unobservable'),
          `${label} the pending-interaction gap is not reported: ${JSON.stringify(liveness?.reasons)}`)
        assert(liveness.verdict !== 'OBSERVED_QUIESCENT',
          `${label} the Host claimed quiescence around an unobservable pending interaction`)
        return liveness
      }
      const startPeer = async (label, extraEnv = {}) => {
        const peer = new EntryProcess('peer', entries.client, {
          ...base,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer', ...extraEnv },
        })
        const ready = await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
        return { peer, ready }
      }

      // T12-surface-PTY-HUP: closing the REAL PTY master (the `script(1)`
      // wrapper dies) is a HUP, not a SIGTERM sent to the business Client. The
      // business PID must observe the terminal end and exit; the Host survives
      // for a fresh Client.
      {
        const { host, ready } = await startC1Host('job', 't12-hup')
        const { client } = await startC1Client('T12 HUP Client')
        const businessPid = client.records.find(record => record.m4a0 === 'ready')?.pid
        assert(typeof businessPid === 'number', 'T12 HUP Client had no business PID')
        const scriptPid = client.child.pid
        try { process.kill(scriptPid, 'SIGKILL') } catch { /* already gone */ }
        await waitGone(businessPid, 20_000)
        assert(!alive(businessPid), 'T12 the business Client survived a real PTY master close')
        await client.dispose().catch(() => {})
        assert(alive(ready.pid), 'T12 the Host died on a Client PTY HUP')
        const { client: recovered } = await startC1Client('T12 HUP recovery Client')
        await exitC1Client(recovered, 'T12 HUP recovery Client')
        await stopC1Host(host)
        trace('t12-pty-hup', { hostPid: ready.pid, clientPid: businessPid, scriptPid, masterClosed: true, clientReusable: true, hostAlive: true })
      }

      // T49/T50: an official pending Question survives C1 SIGKILL and a clean
      // Client exit. C2 receives the ORIGINAL callId through the Host Gateway
      // and its answer settles the same Host flow exactly once.
      for (const [mode, label] of [['kill', 't49'], ['exit', 't50']]) {
        // B-03 eligibility control: the kill case drives the full real Gateway
        // owner-event-stream lifecycle (none -> C1 -> none -> C2 -> none) and
        // one non-answering Peer negative control. The clean-exit case keeps
        // the same question recovery without duplicating the eligibility trace.
        const eligibilityProbe = mode === 'kill'
        const nonAnsweringBarrier = join(workDir, 't49-non-answering-peer.probe')
        rmSync(nonAnsweringBarrier, { force: true })
        const { host, ready, workRoot } = await startC1Host('question', label, eligibilityProbe
          ? { C1_HAS_LIVE_CLIENT_PROBE: '1', C1_NON_ANSWERING_PEER_PROBE: nonAnsweringBarrier }
          : {})
        const waitLiveClient = (value, afterSequence, probeLabel) => waitForC1WorkEvent(
          workRoot,
          event => event.kind === 'has-live-client' && event.value === value && event.sequence > afterSequence,
          probeLabel,
        )
        let liveSequence = 0
        if (eligibilityProbe) {
          const initial = await waitLiveClient(false, liveSequence, 'T49 initial Gateway eligibility')
          liveSequence = initial.sequence
          writeFileSync(nonAnsweringBarrier, 'probe\n', { mode: 0o600 })
          const negative = await waitForC1WorkEvent(workRoot, event => event.kind === 'non-answering-peer', 'T49 non-answering Peer negative control')
          assert(negative.opened === false, 'T49 a non-answering Peer opened the forwarded-event stream')
          assert(negative.code === 'gateway/interactions-forbidden', `T49 unexpected non-answering Peer refusal: ${JSON.stringify(negative)}`)
          assert(negative.liveClient === false, 'T49 the non-answering Peer made hasLiveClient() true')
        }
        const { client: c1 } = await startC1Client(`${label.toUpperCase()} C1`)
        if (eligibilityProbe) {
          const attached = await waitLiveClient(true, liveSequence, 'T49 C1 Gateway eligibility')
          liveSequence = attached.sequence
        }
        const sessionId = await openC1Session(c1, `${label} prompt`, label.toUpperCase())
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', `${label} ask_user_question tool/call`)
        const callId = String(call.data.callId)
        const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, `${label} Host question request`)
        assert(request.questions?.[0]?.question === 'Continue the C1 test?', `${label} the Host question payload is wrong`)
        // The Host ask is pending AND the real C1 modal is painted before the
        // detach: otherwise the kill would race the first forwarded delivery
        // and could legitimately observe "no answerer" instead of a held question.
        await c1.waitForScreen('[1] Proceed', `${label} C1 question modal`, 120_000)
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        if (mode === 'kill') {
          c1.signalBusiness('SIGKILL')
          await waitGone(c1Pid, 15_000)
          await c1.dispose()
        } else {
          // SIGTERM is the clean detach path while a modal owns the editor
          // seat; typing /exit into a modal would be modal input, not exit.
          c1.signalBusiness('SIGTERM')
          const cleanExit = await c1.waitForExit(60_000)
          assert(cleanExit.code === 0 && cleanExit.signal === null, `${label} C1 clean exit was ${JSON.stringify(cleanExit)}`)
          await c1.dispose()
        }
        assert(alive(ready.pid), `${label} the Host died on the Client exit`)
        await assertHostIdentityKept(host, hostBefore, `${label} Host after Client exit`)
        if (eligibilityProbe) {
          const detached = await waitLiveClient(false, liveSequence, 'T49 detached Gateway eligibility')
          liveSequence = detached.sequence
        }
        await assertPendingUnobservable(host, hostBefore, `${label} detached pending`)
        // A clean Client teardown must not settle the Host question as
        // cancelled: no question-failed proof may appear before C2 answers.
        await sleep(300)
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'question-failed' && event.callId === callId)),
          `${label} the Client teardown sent a cancellation that settled the Host pending question`)
        const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, `${label} C2`)
        if (eligibilityProbe) {
          const recovered = await waitLiveClient(true, liveSequence, 'T49 C2 Gateway eligibility')
          liveSequence = recovered.sequence
        }
        await c2.waitForScreen('Continue the C1 test?', `${label} C2 redelivered question`, 120_000)
        c2.send('1')
        await c2.waitForScreen('Review your answer before submit', `${label} C2 review page`, 30_000)
        c2.send('\r')
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, `${label} Host question settled`, 120_000)
        assert(settled.answers?.[0]?.selected?.[0] === 'Proceed', `${label} the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
        const result = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId, `${label} question tool result`)
        assert(result.data?.message?.isError !== true, `${label} the question tool failed after a legal answer`)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', `${label} turn/end after answer`)
        const requests = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-request' && event.sessionId === sessionId)
        const settlements = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)
        assert(requests.length === 1 && settlements.length === 1, `${label} duplicate question request/settlement (${String(requests.length)}/${String(settlements.length)})`)
        await exitC1Client(c2, `${label} C2`)
        if (eligibilityProbe) {
          const final = await waitLiveClient(false, liveSequence, 'T49 final Gateway eligibility')
          liveSequence = final.sequence
        }
        await stopC1Host(host)
        trace(label, {
          hostPid: ready.pid,
          sessionId,
          callId,
          mode,
          c2Answer: 'Proceed',
          hostSettlements: settlements.length,
          ...(eligibilityProbe ? { gatewayEligibility: 'none>c1>none>c2>none', nonAnsweringPeer: 'refused' } : {}),
        })
      }

      // T51: after the original Client is gone, a legal new TUI answers the
      // SAME pending Question once; a reattached Client cannot resurrect it.
      // A separate test-only non-TUI answering Peer holds the OLD legal
      // delivery and submits its stale frame AFTER C2 settled. The Host must
      // ignore it: no second request, settlement or tool result.
      {
        let peer
        try {
          const { host, ready, workRoot } = await startC1Host('question', 't51')
          const { client: c1 } = await startC1Client('T51 C1')
          const sessionId = await openC1Session(c1, 't51 prompt', 'T51')
          const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T51 question tool/call')
          const callId = String(call.data.callId)
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T51 question pending')
          await c1.waitForScreen('[1] Proceed', 'T51 C1 question modal', 120_000)
          const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
          c1.signalBusiness('SIGKILL')
          await waitGone(c1Pid, 15_000)
          await c1.dispose()
          assert(alive(ready.pid), 'T51 the Host died on the Client SIGKILL')

          const startedPeer = await startPeer('T51 old peer')
          peer = startedPeer.peer
          await peer.waitFor(record => record.m4a0 === 'peer-interaction' && record.kind === 'question', 'T51 old peer held the stale question delivery', 120_000)
          const peerFrame = await peer.waitFor(record => record.m4a0 === 'peer-frame' && record.event === 'user-questions/request', 'T51 old peer captured the official question frame', 120_000)
          assert(typeof peerFrame.eventId === 'string' && peerFrame.eventId.length > 0,
            'T51 the old question frame has no eventId')
          assert(typeof peerFrame.clientId === 'string' && peerFrame.clientId.length > 0,
            'T51 the old question frame has no clientId')

          const { client: c2 } = await startC1Client('T51 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          assertInteractionGate(c2, 'T51 C2')
          await c2.waitForScreen('Continue the C1 test?', 'T51 C2 question', 120_000)
          c2.send('1')
          await c2.waitForScreen('Review your answer before submit', 'T51 C2 review')
          c2.send('\r')
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, 'T51 answered')
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T51 turn/end')
          await exitC1Client(c2, 'T51 C2')

          // The old Peer's frame was issued BEFORE the Host settled the new
          // answer. Its `$events/result` must be ignored by the Host stale
          // delivery fence, never delegated into a second settlement.
          // The old legal frame is submitted through the official
          // `$events/result` RPC AFTER C2 settled. The Host must receive the
          // frame (RPC ok) and ignore it through the stale-delivery fence.
          peer.send({
            op: 'peer-send-stale-result',
            eventId: peerFrame.eventId,
            clientId: peerFrame.clientId,
            value: { kind: 'result', value: { answers: [{ id: 'c1-question', selected: ['Cancel'] }] } },
          })
          const staleSent = await peer.waitFor(record => record.m4a0 === 'peer-stale-result-sent' && record.eventId === peerFrame.eventId, 'T51 stale peer frame sent to Host', 30_000)
          assert(staleSent.ok === true, 'T51 the Host did not receive the old question result frame')

          const { client: c3 } = await startC1Client('T51 C3', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          await c3.waitForScreen('question answered', 'T51 C3 settled transcript')
          await sleep(500)
          const viewport = (await c3.viewport()).join('\n')
          assert(!viewport.includes('Submit'), 'T51 a settled question card was resurrected as an answerable flow')
          const settlements = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)
          const toolResults = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId)
          assert(settlements.length === 1 && toolResults.length === 1, 'T51 the settled question produced a second answer/result')
          await exitC1Client(c3, 'T51 C3')
          await stopC1Host(host)
          trace('t51', { hostPid: ready.pid, sessionId, callId, noResurrection: true, staleLegalFrameReplay: 'protocol-peer-negative', eventId: peerFrame.eventId, clientId: peerFrame.clientId })
        } finally {
          if (peer !== undefined) {
            await peer.shutdown().catch(() => {})
          }
        }
      }

      // T52: the official TIMED question becomes a durable `continued` entry.
      // C2 reopens it from the Task Quick projection, submits a late answer,
      // and the Host queues exactly one `user-question-reply` message. This is
      // the official askTimed()/continued lifetime, NOT a 30-minute orphan
      // expiry test.
      {
        const afterTimedBarrier = join(workDir, 't52-after-timed.release')
        const duplicateProbeBarrier = join(workDir, 't52-duplicate-probe.release')
        const expiredProbeBarrier = join(workDir, 't52-expired-probe.release')
        for (const barrier of [afterTimedBarrier, duplicateProbeBarrier, expiredProbeBarrier]) rmSync(barrier, { force: true })
        const { host, ready, workRoot } = await startC1Host('question', 't52', {
          C1_TIMED_QUESTION: '1',
          SPLIT_PROCESS_EXTRA_PATCH: c1Work.timedPatchPath,
          C1_HOLD_AFTER_TIMED: afterTimedBarrier,
          C1_ANSWER_PROBE_DUPLICATE: duplicateProbeBarrier,
          C1_ANSWER_PROBE_EXPIRED: expiredProbeBarrier,
        })
        const { client: c1 } = await startC1Client('T52 C1')
        const sessionId = await openC1Session(c1, 't52 prompt', 'T52')
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T52 timed question tool/call')
        const callId = String(call.data.callId)
        const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T52 timed question request')
        assert(request.timed === true, 'T52 the Host question was not the official timed form')
        // The C1 question UI owns the 1s foreground countdown; its official
        // ASK_TIMED_OUT rejection is what writes the pending tool result and
        // moves the durable projection to `continued`.
        await waitForC1WorkEvent(workRoot, event => event.kind === 'question-failed' && event.sessionId === sessionId, 'T52 timed foreground ended', 120_000)
        const projection = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-projection' && event.callId === callId
          && Array.isArray(event.active) && event.active.some(item => item?.callId === callId && item?.state === 'continued'), 'T52 official continued projection', 120_000)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId, 'T52 pending tool result', 120_000)
        await waitForC1WorkEvent(workRoot, event => event.kind === 'after-timed-held' && event.sessionId === sessionId, 'T52 Agent held after the timed question', 120_000)
        c1.signalBusiness('SIGTERM')
        const cleanExit = await c1.waitForExit(60_000)
        assert(cleanExit.code === 0 && cleanExit.signal === null, `T52 C1 clean exit was ${JSON.stringify(cleanExit)}`)
        await c1.dispose()

        const { client: c2 } = await startC1Client('T52 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, 'T52 C2')
        await c2.waitForScreen('t52 prompt', 'T52 C2 history')
        c2.send('\x1b[B')
        await c2.waitForScreen('Task Quick', 'T52 Task Quick opened', 60_000)
        await c2.waitForScreen('Continue the C1 test?', 'T52 continued row')
        c2.send('\r')
        c2.send('1')
        await c2.waitForScreen('Review your answer before submit', 'T52 continued form review', 60_000)
        // ONE final Enter from the painted review frame: the official
        // `answerContinued` result and the duplicate probe below prove the
        // queued classification, so a second Enter would only risk an
        // unrelated reply.
        c2.send('\r')
        // The C2 UI's `answerContinued` return is observable through the
        // controller's queued notice; the Host-side probe then calls the
        // official `ctx.userQuestions.answer` service while the Agent is
        // still held, proving the duplicate REPLY_QUEUED classification.
        await c2.waitFor(record => record.m4b2s === 'qualification' && record.op === 'question-answer-continued'
          && record.result === 'queued', 'T52 queued answer classification', 60_000)
        writeFileSync(duplicateProbeBarrier, 'release\n', { mode: 0o600 })
        const duplicate = await waitForC1WorkEvent(workRoot, event => event.kind === 'answer-probe' && event.phase === 'duplicate', 'T52 duplicate continued answer probe', 60_000)
        assert(duplicate.code === 'REPLY_QUEUED', `T52 duplicate continued answer classification was ${JSON.stringify(duplicate)}`)

        writeFileSync(afterTimedBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T52 queued reply turn/end', 120_000)
        const replyDeadline = Date.now() + 60_000
        let queuedMessages = []
        while (Date.now() < replyDeadline) {
          queuedMessages = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'user/message'
            && JSON.stringify(event).includes('answer_to_pending_question')
            && JSON.stringify(event).includes(callId))
          if (queuedMessages.length > 0) break
          await sleep(50)
        }
        assert(queuedMessages.length === 1, `T52 expected exactly one durable queued reply, got ${String(queuedMessages.length)}`)
        const queuedSource = queuedMessages[0].data?.source
        assert(queuedSource?.kind === 'user-question-reply' && queuedSource?.callId === callId,
          `T52 the durable inbox source does not name the continued call: ${JSON.stringify(queuedSource)}`)

        writeFileSync(expiredProbeBarrier, 'release\n', { mode: 0o600 })
        const expired = await waitForC1WorkEvent(workRoot, event => event.kind === 'answer-probe' && event.phase === 'expired', 'T52 expired continued answer probe', 60_000)
        assert(expired.value === false, `T52 expired continued answer classification was ${JSON.stringify(expired)}`)
        await exitC1Client(c2, 'T52 C2')
        await stopC1Host(host)
        trace('t52', {
          hostPid: ready.pid,
          sessionId,
          callId,
          projectedState: projection.active.find(item => item?.callId === callId)?.state,
          continuedAnswer: 'queued',
          durableReplies: queuedMessages.length,
          duplicateAnswer: 'REPLY_QUEUED',
          expiredAnswer: 'not-continued',
        })
      }

      // T53/T54: an official Approval request survives the Client exit and a
      // fresh Client settles the SAME Host request exactly once. `allowed-once`
      // executes the harmless command; `rejected` never executes it.
      for (const [scenario, decision, expected, markerName] of [
        ['approval-allow', 'y', 'allowed-once', 'approval-allow.marker'],
        ['approval-reject', 'n', 'rejected', 'approval-reject.marker'],
      ]) {
        const label = scenario === 'approval-allow' ? 't53' : 't54'
        const { host, ready, workRoot } = await startC1Host(scenario, label)
        const { client: c1 } = await startC1Client(`${label.toUpperCase()} C1`)
        const sessionId = await openC1Session(c1, `${label} prompt`, label.toUpperCase())
        const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', `${label} approval/asked`, 120_000)
        const requestId = String(asked.data.id)
        const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-request', `${label} Host approval request`)
        assert(request.toolName === 'bash', `${label} the approval is not for the official bash tool`)
        await c1.waitForScreen('[y] Allow once', `${label} C1 approval sheet`, 120_000)
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), `${label} the Host died on the Client SIGKILL`)
        await assertHostIdentityKept(host, hostBefore, `${label} Host after Client detach`)
        await assertPendingUnobservable(host, hostBefore, `${label} detached pending`)
        await sleep(300)
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'approval-settled')), `${label} the Client teardown settled the Host approval`)
        const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, `${label} C2`)
        await c2.waitForScreen(scenario === 'approval-allow' ? 'Allow once' : 'Reject', `${label} C2 approval sheet`, 120_000)
        c2.send(decision)
        const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, `${label} approval/decided`, 120_000)
        assert(decided.data.outcome === expected, `${label} approval outcome ${JSON.stringify(decided.data.outcome)} != ${expected}`)
        const decisions = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
        assert(decisions.length === 1, `${label} duplicated approval/decided`)
        const marker = join(workRoot, markerName)
        if (scenario === 'approval-allow') {
          await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-settled' && event.outcome === 'allowed-once', `${label} allowed-once`)
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === String(request.callId), `${label} bash tool result`, 120_000)
          assert(existsSync(marker), `${label} the allowed harmless command did not execute`)
        } else {
          await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-settled' && event.outcome === 'rejected', `${label} rejected`)
          assert(!existsSync(marker), `${label} the rejected harmless command executed`)
        }
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', `${label} turn/end`)
        await exitC1Client(c2, `${label} C2`)
        await stopC1Host(host)
        trace(label, { hostPid: ready.pid, sessionId, requestId, decision: expected, decisions: 1, marker: existsSync(marker) })
      }

      // T55a: an old, still-authenticated non-TUI Peer holds the original
      // approval delivery while the legal C2 rejects it. The old peer's late
      // `allowed-once` frame must not execute the tool or add a decision.
      {
        let peer
        try {
          const { host, ready, workRoot } = await startC1Host('approval-allow', 't55a')
          const { client: c1 } = await startC1Client('T55A C1')
          const sessionId = await openC1Session(c1, 't55a prompt', 'T55A')
          const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55a approval/asked', 120_000)
          const requestId = String(asked.data.id)
          await c1.waitForScreen('[y] Allow once', 'T55a C1 approval sheet', 120_000)
          const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
          c1.signalBusiness('SIGKILL')
          await waitGone(c1Pid, 15_000)
          await c1.dispose()
          const startedPeer = await startPeer('T55a old peer')
          peer = startedPeer.peer
          await peer.waitFor(record => record.m4a0 === 'peer-interaction' && record.kind === 'approval', 'T55a old peer held approval delivery', 120_000)
          const peerFrame = await peer.waitFor(record => record.m4a0 === 'peer-frame' && record.event === 'approval/request', 'T55a old peer captured the official approval frame', 120_000)
          assert(typeof peerFrame.eventId === 'string' && peerFrame.eventId.length > 0,
            'T55a the old approval frame has no eventId')
          assert(typeof peerFrame.clientId === 'string' && peerFrame.clientId.length > 0,
            'T55a the old approval frame has no clientId')
          const { client: c2 } = await startC1Client('T55A C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          assertInteractionGate(c2, 'T55A C2')
          await c2.waitForScreen('Reject', 'T55a C2 approval sheet', 120_000)
          c2.send('n')
          const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, 'T55a approval/decided', 120_000)
          assert(decided.data.outcome === 'rejected', 'T55a the legal Client did not reject the approval')
          peer.send({
            op: 'peer-send-stale-result',
            eventId: peerFrame.eventId,
            clientId: peerFrame.clientId,
            value: { kind: 'result', value: 'allowed-once' },
          })
          const staleSent = await peer.waitFor(record => record.m4a0 === 'peer-stale-result-sent' && record.eventId === peerFrame.eventId, 'T55a stale approval frame sent to Host', 30_000)
          assert(staleSent.ok === true, 'T55a the Host did not receive the old approval result frame')
          const decisions = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
          assert(decisions.length === 1 && decisions[0].data.outcome === 'rejected', 'T55a the stale old-peer allow produced a second decision')
          assert(!existsSync(join(workRoot, 'approval-allow.marker')), 'T55a the stale old-peer allow executed the tool')
          await exitC1Client(c2, 'T55A C2')
          await stopC1Host(host)
          trace('t55a', { hostPid: ready.pid, sessionId, requestId, oldPeerHeld: true, staleAllow: 'ignored', decisions: 1, marker: false, eventId: peerFrame.eventId, clientId: peerFrame.clientId })
        } finally {
          if (peer !== undefined) {
            await peer.shutdown().catch(() => {})
          }
        }
      }

      // T55b: a formal Host Agent cancel while the approval is pending must
      // settle the request as the official cancellation taxonomy; a late `y`
      // must not execute the marker.
      {
        const cancelBarrier = join(workDir, 't55b-cancel.release')
        const { host, ready, workRoot } = await startC1Host('approval-allow', 't55b', { C1_CANCEL_AGENT: cancelBarrier })
        const { client } = await startC1Client('T55B C1')
        const sessionId = await openC1Session(client, 't55b prompt', 'T55B')
        const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55b approval/asked', 120_000)
        const requestId = String(asked.data.id)
        await client.waitForScreen('[y] Allow once', 'T55b approval sheet', 120_000)
        writeFileSync(cancelBarrier, 'cancel\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'agent-cancel-requested', 'T55b Host Agent cancel', 60_000)
        const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, 'T55b approval/decided', 120_000)
        assert(decided.data.outcome !== 'allowed-once', `T55b Host abort settled as allowed-once: ${JSON.stringify(decided.data)}`)
        assert(decided.data.outcome === 'cancelled', `T55b unexpected Host abort taxonomy: ${JSON.stringify(decided.data.outcome)}`)
        client.send('y')
        await sleep(500)
        assert(!existsSync(join(workRoot, 'approval-allow.marker')), 'T55b a late y executed the command after Host abort')
        assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId).length === 1,
          'T55b the Host abort produced a duplicate approval/decided')
        // The late `y` landed in the editor after the approval sheet was
        // withdrawn; clear it so the normal `/exit` is still a command.
        client.send('\x15')
        await exitC1Client(client, 'T55B C1')
        await stopC1Host(host)
        trace('t55b', { hostPid: ready.pid, sessionId, requestId, hostAbortTaxonomy: decided.data.outcome, lateAllowExecuted: false })
      }

      // T55c: same-PID HMR while a pending Question/Approval owns the modal.
      // The root delivery survives the revision swap; the new surface shows
      // the SAME Host pending and only the new surface's answer settles it.
      for (const [kind, scenario, label, confirmText, answer, expectedCount] of [
        ['question', 'question', 't55c-question', 'Continue the C1 test?', '1', 1],
        ['approval', 'approval-allow', 't55c-approval', '[y] Allow once', 'y', 1],
      ]) {
        const { host, ready, workRoot } = await startC1Host(scenario, label)
        const { client } = await startC1Client(`${label} Client`, { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionId = await openC1Session(client, `${label} prompt`, label.toUpperCase())
        // The Host `tool/call` is the official callId authority; the question
        // witnesses below must all name THIS one invocation.
        let questionCallId
        if (kind === 'question') {
          const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T55c question tool/call')
          questionCallId = String(call.data.callId)
          await client.waitForScreen(confirmText, 'T55c C1 question modal', 120_000)
        } else {
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55c approval/asked', 120_000)
          await client.waitForScreen(confirmText, 'T55c C1 approval sheet', 120_000)
        }
        const before = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.sessionOpen === true, 'T55c initial surface')
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T55c HMR start', 60_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T55c HMR retired', 120_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T55c HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.surfaceRevision !== before.surfaceRevision, 'T55c new surface')
        assert(after.pid === before.pid && after.generationId === before.generationId, 'T55c HMR changed the Client PID or Connection generation')
        assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate').length === 1,
          'T55c HMR duplicated the root interaction startup gate')
        await client.waitForScreen(confirmText, 'T55c new surface shows the same Host pending', 120_000)
        if (kind === 'question') {
          client.send(answer)
          await client.waitForScreen('Review your answer before submit', 'T55c question review', 30_000)
          client.send('\r')
          // The official non-timed `ask()` attaches no `wait`, so its waterfall
          // request — and therefore the fixture's request/settlement records —
          // carries no callId; only a timed ask does (T52). The durable
          // `tool/call` -> `tool/result` pair below is the callId-exact
          // authority, while the settlement must carry the new surface's answer
          // exactly once with no failed alternative.
          const settled = await waitForC1WorkEvent(workRoot,
            event => event.kind === 'question-settled' && event.sessionId === sessionId,
            'T55c question settled', 120_000)
          assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
            `T55c the new surface submitted the wrong answer: ${JSON.stringify(settled.answers)}`)
          const questionEvents = readC1WorkEvents(workRoot).filter(event => event.sessionId === sessionId)
          assert(questionEvents.filter(event => event.kind === 'question-request').length === 1,
            'T55c HMR replayed the Host question request')
          assert(questionEvents.filter(event => event.kind === 'question-settled').length === 1
            && questionEvents.every(event => event.kind !== 'question-failed'),
            'T55c the Host pending was not settled exactly once for this session')
          const result = await waitForHostSessionEvent(dshHome, sessionId,
            event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === questionCallId,
            'T55c question tool result', 120_000)
          assert(result.data?.message?.isError !== true, 'T55c the answered question failed at the Host')
        } else {
          client.send(answer)
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided', 'T55c approval/decided', 120_000)
          assert(existsSync(join(workRoot, 'approval-allow.marker')), 'T55c the new surface allow did not execute once')
          assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided').length === expectedCount,
            'T55c HMR duplicated the approval decision')
        }
        await exitC1Client(client, `${label} Client`)
        await stopC1Host(host)
        trace(label, { hostPid: ready.pid, sessionId, samePid: true, sameGeneration: true, pendingReattached: true })
      }

      // T56: a new Client is a fresh Peer/binding; it reads the exact history
      // once and a new prompt appends live without duplication.
      {
        const releaseBarrier = join(workDir, 't56-long-turn.release')
        const rebuilt = await startC1Host('long-turn', 't56', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client: c1 } = await startC1Client('T56 C1b')
        const sessionId = await openC1Session(c1, 't56 first', 'T56')
        await waitForC1WorkEvent(rebuilt.workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T56 first held')
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T56 first turn end')
        const { client: c2 } = await startC1Client('T56 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('t56 first', 'T56 C2 history')
        c2.send('t56 second\r')
        await c2.waitForScreen('long-turn answer 2', 'T56 C2 live append', 120_000)
        const users = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
        assert(users.filter(text => text.startsWith('t56 first')).length === 1
          && users.filter(text => text.includes('t56 second')).length === 1,
        `T56 history duplication: ${JSON.stringify(users.map(text => text.slice(0, 80)))}`)
        await exitC1Client(c2, 'T56 C2')
        await stopC1Host(rebuilt.host)
        trace('t56', { hostPid: rebuilt.ready.pid, sessionId, historyOnce: true, liveAppend: true })
      }

      // T57: Client-only HMR happy path on the SAME Client PID/Context/transport.
      // The Session is open and its Turn has settled BEFORE the revision
      // replacement, so the new revision must re-adopt a fresh exact
      // `tuiMainView` wrapper rather than starting sessionless.
      {
        const releaseBarrier = join(workDir, 't57-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't57', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client } = await startC1Client('T57 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionId = await openC1Session(client, 't57 prompt', 'T57')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T57 initial held Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T57 initial turn/end')
        const before = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.sessionOpen === true && record.openSessionId === sessionId, 'T57 initial surface')
        const hostBefore = await hostIdentityFacts(host)
        const rowsBefore = await hostRowFiberUids(host)
        const beforePid = before.pid
        const beforeRootFiber = before.rootFiberUid
        const beforeGeneration = before.generationId
        const beforeRevision = before.surfaceRevision
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T57 HMR start', 60_000)
        await waitForSurfaceStatus(client, record => record.surfaceRevision === beforeRevision && record.surfaceMounted === false, 'T57 retired surface status', 60_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T57 HMR retired', 120_000)
        const hmrReady = await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T57 HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.surfaceRevision === hmrReady.revision && record.surfaceMounted === true, 'T57 new surface status', 120_000)
        assert(after.pid === beforePid, 'T57 the HMR changed the OS PID')
        assert(after.rootFiberUid === beforeRootFiber, 'T57 the HMR changed the Client root Context fiber')
        assert(after.generationId === beforeGeneration, 'T57 the HMR changed the transport generation')
        assert(after.surfaceRevision !== beforeRevision, 'T57 the surface revision did not change')
        assert(after.surfaceFiberUid !== before.surfaceFiberUid, 'T57 the runner fiber did not change')
        assert(after.sessionOpen === true && after.openSessionId === sessionId, 'T57 the new revision did not re-adopt the exact Session wrapper')
        assert(after.owners?.typert === 1 && after.owners?.connection === 1 && after.owners?.remote === 1
          && after.owners?.fileUpload === 1 && after.owners?.sessions === 1 && after.owners?.jobs === 1,
        `T57 duplicate/absent Domain owners after HMR: ${JSON.stringify(after.owners)}`)
        assert(after.privateNamespaces === 2, 'T57 private namespaces were not remounted exactly once')
        for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-ready']) {
          assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === operation).length === 1,
            `T57 expected exactly one ${operation} record`)
        }
        await client.waitForScreen('long-turn answer', 'T57 new TTY paint', 120_000)
        await assertHostIdentityKept(host, hostBefore, 'T57 Host identity')
        await assertHostRowsKept(host, rowsBefore, 'T57 Host Loader rows')
        await exitC1Client(client, 'T57 Client')
        await stopC1Host(host)
        trace('t57', { hostPid: ready.pid, clientPid: beforePid, sessionId, revisionBefore: beforeRevision, revisionAfter: after.surfaceRevision, sameContext: true, sameTransport: true, sessionWrapper: 're-adopted', newTty: true, hostRows: 'same loader fibers', hostRowUids: PROTECTED_HOST_ROWS.length })
      }

      // T58: HMR while a real Host Job is running. The Host Job continues
      // across the surface revision; the new surface re-attaches to the same
      // Session and reads the surviving work.
      {
        const { host, ready, workRoot } = await startC1Host('job', 't58', {}, c1JobWorkRoot('t58'))
        const { client } = await startC1Client('T58 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionId = await openC1Session(client, 't58 prompt', 'T58')
        const job = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'registered', 'T58 running Job')
        assert(typeof job.jobId === 'string' && job.status === 'running', 'T58 no real running Host Job')
        const hostBefore = await hostIdentityFacts(host)
        const rowsBefore = await hostRowFiberUids(host)
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T58 HMR start')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T58 HMR retired', 120_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T58 HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.sessionOpen === true && record.openSessionId === sessionId, 'T58 new surface Session', 120_000)
        assert(after.pid === client.records.find(record => record.m4a0 === 'ready')?.pid, 'T58 the HMR changed the Client PID')
        assert(after.owners?.sessions === 1 && after.owners?.jobs === 1 && after.privateNamespaces === 2,
          'T58 duplicate/absent owners after HMR')
        assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired').length === 1,
          'T58 duplicate HMR retirement records')
        assert(alive(ready.pid), 'T58 the Host died during HMR')
        await assertHostIdentityKept(host, hostBefore, 'T58 Host after HMR')
        await assertHostRowsKept(host, rowsBefore, 'T58 Host Loader rows')
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled')),
          'T58 the HMR settled the running Host Job')
        writeFileSync(join(workRoot, 'job.release'), 'release\n', { mode: 0o600 })
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled', 'T58 Job settled after HMR', 120_000)
        assert(settled.status === 'completed', `T58 Job settled as ${JSON.stringify(settled.status)}`)
        await client.waitForScreen('job accepted', 'T58 new surface Job readback', 120_000)
        await exitC1Client(client, 'T58 Client')
        await stopC1Host(host)
        trace('t58', { hostPid: ready.pid, sessionId, jobId: job.jobId, hmrDuringJob: true, jobContinued: true, newSurfaceReadback: true, hostRows: 'same loader fibers', hostRowUids: PROTECTED_HOST_ROWS.length })
      }

      // T59: HMR failure and stop-during-HMR both fail closed with exactly one
      // reverse disposal and no second TTY owner.
      {
        const { host, ready } = await startC1Host('job', 't59')
        const { client } = await startC1Client('T59 failure Client', {
          SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
          SPLIT_PROCESS_CLIENT_HMR_FAIL: '1',
        })
        const c1Pid = client.records.find(record => record.m4a0 === 'ready')?.pid
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 failure HMR start')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 failure HMR retired', 120_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-failure', 'T59 HMR failure', 120_000)
        const failureExit = await client.waitForExit(60_000)
        assert(failureExit.code === 1, `T59 HMR failure exit was ${JSON.stringify(failureExit)}`)
        for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-failure']) {
          assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === operation).length === 1,
            `T59 expected exactly one ${operation} record on HMR failure`)
        }
        const closed = client.records.find(record => record.m4b2s === 'client-closed')
        assert(closed !== undefined, 'T59 HMR failure did not emit the final Client owner inventory')
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(closed.owners?.[owner] === 0, `T59 HMR failure left ${owner} owner alive`)
        }
        assert(alive(ready.pid), 'T59 HMR failure killed the Host')
        await client.dispose()
        const reuse = await startC1Client('T59 reuse Client')
        await exitC1Client(reuse.client, 'T59 reuse Client')
        await stopC1Host(host)
        trace('t59-failure', { hostPid: ready.pid, clientPid: c1Pid, exit: failureExit.code, clientReusable: true, hostAlive: true })

        const barrier = join(workDir, 't59-hmr-hold')
        const { host: stopHost, ready: stopReady } = await startC1Host('job', 't59-stop')
        const { client: stopping } = await startC1Client('T59 stop Client', {
          SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
          SPLIT_PROCESS_CLIENT_HMR_HOLD: `surface@${barrier}`,
        })
        stopping.signalBusiness('SIGUSR2')
        await stopping.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 stop HMR start')
        await stopping.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 stop HMR retired', 120_000)
        stopping.signalBusiness('SIGTERM')
        await stopping.waitFor(record => record.m4a0 === 'signal' && record.signal === 'SIGTERM', 'T59 stop signal admitted', 30_000)
        writeFileSync(barrier, 'release\n', { mode: 0o600 })
        const stopExit = await stopping.waitForExit(60_000)
        assert(stopExit.code === 0, `T59 stop-during-HMR exit was ${JSON.stringify(stopExit)}`)
        assert(stopping.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start').length === 1,
          'T59 stop-during-HMR emitted a duplicate revision start')
        assert(stopping.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired').length === 1,
          'T59 stop-during-HMR emitted a duplicate revision retirement')
        assert(!stopping.records.some(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready'),
          'T59 stop-during-HMR published a fake ready revision')
        assert(!stopping.records.some(record => record.m4a0 === 'cleanup-failure'), 'T59 stop-during-HMR reported a cleanup failure')
        assert(alive(stopReady.pid), 'T59 stop-during-HMR killed the Host')
        await stopping.dispose()
        await stopC1Host(stopHost)
        trace('t59-stop', { hostPid: stopReady.pid, exit: stopExit.code, cleanupFailures: 0, hostAlive: true })
      }

      // ── Fatal Host conditions and signal dispositions (T62–T65) ──────────
      /**
       * Stop a Host this lane did not create through `startC1Host`: the one a
       * Client spawns by itself through `ensureLocalHost` after the previous
       * instance died. The official SIGTERM admission is the supported stop; the
       * kernel seat and the launch material must be gone afterwards.
       */
      const stopSpawnedHost = async (hostPid, instanceId, label) => {
        // The instance files live under the FULL 64-character scope id; ONLY the
        // Linux abstract-socket NAME is truncated to 40 characters. Asserting the
        // absence of those files under the socket suffix would silently inspect a
        // directory that never exists. Both the presence check (while the Host is
        // still running) and the absence check (after the official stop) therefore
        // use the real scope directory, and the truncated spelling is asserted to
        // be a NON-directory so this confusion cannot come back.
        assert(typeof isolatedScopeId === 'string' && isolatedScopeId.length === 64,
          `${label}: the lane never learned the full 64-character scope id`)
        const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', isolatedScopeId)
        assert(existsSync(scopeDir), `${label}: the full-scope run directory is missing`)
        assert(!existsSync(join(dshHome, 'run', 'dsh-pi-tui', isolatedScopeId.slice(0, 40))),
          `${label}: a truncated 40-character scope directory must never exist`)
        const instancePath = join(scopeDir, 'instance.json')
        const launchPath = join(scopeDir, 'launch.json')
        assert(existsSync(instancePath),
          `${label}: the running spawned Host published no instance record to reclaim`)
        assert(existsSync(launchPath),
          `${label}: the running spawned Host published no launch material to reclaim`)
        process.kill(hostPid, 'SIGTERM')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), `${label}: the spawned Host survived the official SIGTERM`)
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        assert(!existsSync(launchPath), `${label}: the stopped Host left its launch material behind`)
        if (existsSync(instancePath)) {
          assert(readJson(instancePath)?.instanceId !== instanceId,
            `${label}: the stopped Host left its own instance record behind`)
        }
      }
      /** The live `dist/local-host.mjs` PIDs of THIS isolated DSH home. */
      const liveHostPids = () => findIsolatedProcesses(dshHome).filter(pid => {
        try {
          return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('local-host.mjs')
        } catch {
          return false
        }
      })

      // T62: a real SIGINT delivered to the Client BUSINESS PID (never to the
      // `script(1)` wrapper) is the official 130 disposition: the Client's own
      // resources are released, the Host keeps its live identity, and a fresh
      // Client reads the existing Session history back. The Client never
      // signals the Host.
      {
        // The `long-turn` fixture REQUIRES its barrier; release it immediately so
        // the first Turn settles before the signal is sent.
        const releaseBarrier = join(workDir, 't62-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't62', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client } = await startC1Client('T62 Client')
        const sessionId = await openC1Session(client, 't62 prompt', 'T62')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T62 held Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T62 settled Turn')
        const hostBefore = await hostIdentityFacts(host)
        const businessPid = client.records.find(record => record.m4a0 === 'ready')?.pid
        assert(Number.isInteger(businessPid), 'T62 the Client never published its business PID')
        client.signalBusiness('SIGINT')
        const admitted = await client.waitFor(
          record => record.m4a0 === 'signal' && record.signal === 'SIGINT',
          'T62 Client SIGINT admitted',
          30_000,
        )
        assert(admitted.pid === businessPid, 'T62 the SIGINT record did not come from the business PID')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 130 && exit.signal === null,
          `T62 Client SIGINT exit was ${JSON.stringify(exit)}, expected code 130`)
        await client.dispose()
        assert(alive(ready.pid), 'T62 the Client SIGINT killed the Host')
        await assertHostIdentityKept(host, hostBefore, 'T62 Host after Client SIGINT')
        const { client: reader } = await startC1Client('T62 reader Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await reader.waitForScreen('t62 prompt', 'T62 history readback')
        await exitC1Client(reader, 'T62 reader Client')
        await stopC1Host(host)
        trace('t62', {
          hostPid: ready.pid,
          clientPid: businessPid,
          signal: 'SIGINT',
          exitCode: exit.code,
          clientResourcesReleased: true,
          hostIdentityKept: true,
          historyReadback: true,
        })
      }

      // T63: the DEFAULT keyboard exit chord driven through the REAL PTY. Both
      // Ctrl+C and Ctrl+D require the SAME key twice inside the confirmation
      // window; one press is never enough. These are typed bytes on the pty
      // master, not signals. Ctrl+D needs an EMPTY draft (a non-empty draft turns
      // it into the editor's forward-delete).
      {
        const releaseBarrier = join(workDir, 't63-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't63', { C1_HOLD_LONG_TURN: releaseBarrier })
        const hostBefore = await hostIdentityFacts(host)
        const { client: ctrlC } = await startC1Client('T63 Ctrl+C Client')
        const sessionId = await openC1Session(ctrlC, 't63 prompt', 'T63')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T63 held Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T63 settled Turn')
        // The product's OWN armed-exit cue is painted in the footer; waiting for
        // it (and then for it to expire) is what makes this a double-press proof
        // instead of "the key exits":
        //   1. ONE press arms and paints the hint, and does NOT exit;
        //   2. the hint disappears when the confirmation window closes, and the
        //      Client is still alive;
        //   3. ONE more press arms again, and the NEXT one inside that window
        //      exits through the real controller.
        ctrlC.send('\x03')
        await ctrlC.waitForScreen('again to exit', 'T63 Ctrl+C confirmation armed')
        await ctrlC.waitForScreenGone('again to exit', 'T63 Ctrl+C confirmation expired')
        assert(!ctrlC.exited, 'T63 a SINGLE Ctrl+C press already exited the Client')
        ctrlC.send('\x03')
        await ctrlC.waitForScreen('again to exit', 'T63 Ctrl+C confirmation re-armed')
        ctrlC.send('\x03')
        const ctrlCExit = await ctrlC.waitForExit(60_000)
        assert(ctrlCExit.code === 0 && ctrlCExit.signal === null,
          `T63 Ctrl+C double press exit was ${JSON.stringify(ctrlCExit)}`)
        await ctrlC.dispose()
        assert(alive(ready.pid), 'T63 the Ctrl+C exit killed the Host')
        await assertHostIdentityKept(host, hostBefore, 'T63 Host after Ctrl+C')

        const { client: ctrlD } = await startC1Client('T63 Ctrl+D Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await ctrlD.waitForScreen('t63 prompt', 'T63 history readback before Ctrl+D')
        // Ctrl+D needs an EMPTY draft (a non-empty draft turns it into the
        // editor's forward-delete) and the SAME key twice inside the window.
        ctrlD.send('\x04')
        await ctrlD.waitForScreen('again to exit', 'T63 Ctrl+D confirmation armed')
        await ctrlD.waitForScreenGone('again to exit', 'T63 Ctrl+D confirmation expired')
        assert(!ctrlD.exited, 'T63 a SINGLE Ctrl+D press already exited the Client')
        ctrlD.send('\x04')
        await ctrlD.waitForScreen('again to exit', 'T63 Ctrl+D confirmation re-armed')
        ctrlD.send('\x04')
        const ctrlDExit = await ctrlD.waitForExit(60_000)
        assert(ctrlDExit.code === 0 && ctrlDExit.signal === null,
          `T63 Ctrl+D double press exit was ${JSON.stringify(ctrlDExit)}`)
        await ctrlD.dispose()
        assert(alive(ready.pid), 'T63 the Ctrl+D exit killed the Host')
        await assertHostIdentityKept(host, hostBefore, 'T63 Host after Ctrl+D')
        const { client: recovered } = await startC1Client('T63 recovery Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await recovered.waitForScreen('t63 prompt', 'T63 history readback after both exits')
        await exitC1Client(recovered, 'T63 recovery Client')
        await stopC1Host(host)
        trace('t63', {
          hostPid: ready.pid,
          ctrlC: { presses: 2, exitCode: ctrlCExit.code, via: 'real pty typed input' },
          ctrlD: { presses: 2, exitCode: ctrlDExit.code, via: 'real pty typed input', draft: 'empty' },
          hostIdentityKept: true,
          sessionPreserved: true,
        })
      }

      // T64: a REAL SIGHUP is a process/terminal failure, NOT the official
      // graceful stop (the Host registers no SIGHUP handler by contract). The
      // attached Client must observe the official Connection loss without
      // fabricating a settlement for the lost Turn; the dead instance is never
      // revived, and stale discovery starts a NEW Host with a new identity.
      {
        const holdRelease = join(workDir, 't64-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't64', { C1_HOLD_LONG_TURN: holdRelease })
        const { client } = await startC1Client('T64 Client')
        const sessionId = await openC1Session(client, 't64 prompt', 'T64')
        const held = await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T64 held Turn')
        assert(held.agentStatus === 'running', `T64 the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T64 turn/start')
        const hostBefore = await hostIdentityFacts(host)
        const hostPid = ready.pid
        process.kill(hostPid, 'SIGHUP')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), 'T64 the Host survived a real SIGHUP')
        const lost = await client.waitFor(
          record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
          'T64 Client observed the official Connection loss',
          60_000,
        )
        assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
          `T64 unexpected Client transport state after the HUP: ${JSON.stringify(lost.transport)}`)
        // The lost Turn is never reported as settled, and no answer is invented.
        const afterHup = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!afterHup.some(event => event.type === 'turn/end'),
          'T64 the lost Turn was reported as settled after a Host SIGHUP')
        assert(!hostAssistantHasText(afterHup, 'long-turn answer'),
          'T64 an answer was fabricated for the Turn lost in a Host SIGHUP')
        assert(!(await client.viewport()).join('\n').includes('long-turn answer'),
          'T64 the Client painted a fabricated answer for the Turn lost in a Host SIGHUP')
        // An ordinary carrier loss is retryable, not fatal: the Client is alive.
        assert(!client.exited, 'T64 the Client treated an ordinary Host carrier loss as a fatal exit')
        client.signalBusiness('SIGTERM')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, `T64 Client cleanup exit was ${JSON.stringify(exit)}`)
        assert(!client.records.some(record => record.m4a0 === 'cleanup-failure'),
          'T64 the Client reported a cleanup failure after the Host SIGHUP')
        await client.dispose()
        // Stale discovery: a fresh Client must create a NEW instance, never
        // revive the dead one, and must not claim the old Session is open.
        const { client: fresh, ready: freshReady } = await startC1Client('T64 fresh Client')
        const newHost = freshReady.host
        assert(newHost.hostPid !== hostBefore.hostPid, 'T64 stale discovery reused the dead Host PID')
        assert(newHost.instanceId !== hostBefore.instanceId, 'T64 stale discovery reused the dead Host instance')
        assert(newHost.hostStarttime !== hostBefore.hostStarttime, 'T64 the new Host reuses the dead start identity')
        assert(freshReady.sessionOpen === false, 'T64 a sessionless Client claimed an open Session across a Host replacement')
        assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
          `T64 expected exactly the new Host to be live, found ${JSON.stringify(liveHostPids())}`)
        const newInstanceId = newHost.instanceId
        fresh.signalBusiness('SIGTERM')
        const freshExit = await fresh.waitForExit(60_000)
        assert(freshExit.code === 0 && freshExit.signal === null,
          `T64 fresh Client exit was ${JSON.stringify(freshExit)}`)
        await fresh.dispose()
        await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T64 spawned Host')
        trace('t64', {
          hostPid,
          signal: 'SIGHUP',
          classification: 'process failure, not the official graceful stop',
          clientObserved: lost.transport,
          fabricatedSettlement: false,
          clientExit: exit.code,
          newHostPid: newHost.hostPid,
          newInstanceId,
          clientResourcesReleased: true,
        })
      }

      // T65: a REAL SIGKILL of the Host while a Client is attached and the
      // Session is open. The official Connection goes disconnected, the pending
      // write never fakes success, the old `tuiMainView` does not survive across
      // Hosts, and a cold resume reads the durable log truthfully without
      // replaying the unknown write.
      {
        const holdRelease = join(workDir, 't65-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't65', { C1_HOLD_LONG_TURN: holdRelease })
        const { client } = await startC1Client('T65 Client')
        const sessionId = await openC1Session(client, 't65 prompt', 'T65')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T65 held Turn')
        const hostBefore = await hostIdentityFacts(host)
        const hostPid = ready.pid
        process.kill(hostPid, 'SIGKILL')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), 'T65 the Host survived SIGKILL')
        const lost = await client.waitFor(
          record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
          'T65 Client observed the official Connection loss',
          60_000,
        )
        assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
          `T65 unexpected Client transport state after the kill: ${JSON.stringify(lost.transport)}`)
        const afterKill = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!afterKill.some(event => event.type === 'turn/end'),
          'T65 the pending Turn was reported as settled after a Host SIGKILL')
        assert(hostUserTexts(afterKill).filter(text => text === 't65 prompt').length === 1,
          'T65 the accepted write was lost or duplicated by the Host SIGKILL')
        assert(!client.exited, 'T65 the Client treated an ordinary Host carrier loss as a fatal exit')
        client.signalBusiness('SIGTERM')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, `T65 Client cleanup exit was ${JSON.stringify(exit)}`)
        await client.dispose()
        // No cross-Host continuity: a sessionless Client gets a NEW Host and no
        // inherited Session; only one Host owner exists at a time.
        const { client: fresh, ready: freshReady } = await startC1Client('T65 fresh Client')
        const newHost = freshReady.host
        assert(newHost.hostPid !== hostBefore.hostPid, 'T65 stale discovery reused the killed Host PID')
        assert(newHost.instanceId !== hostBefore.instanceId, 'T65 stale discovery reused the killed Host instance')
        assert(freshReady.sessionOpen === false, 'T65 the old tuiMainView survived across a Host replacement')
        assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
          `T65 expected exactly one live Host owner, found ${JSON.stringify(liveHostPids())}`)
        const newInstanceId = newHost.instanceId
        // The sessionless Client is disposed before the cold-resume Client
        // starts; the two real surfaces could legally coexist, but this case
        // needs the cold resume to run after that Client released its state.
        fresh.signalBusiness('SIGTERM')
        const freshExit65 = await fresh.waitForExit(60_000)
        assert(freshExit65.code === 0 && freshExit65.signal === null,
          `T65 fresh Client exit was ${JSON.stringify(freshExit65)}`)
        await fresh.dispose()
        // A COLD resume of the same Session reads the durable history: the user
        // write is there exactly once and NO answer is invented for the lost Turn.
        const { client: resumed } = await startC1Client('T65 cold-resume Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await resumed.waitForScreen('t65 prompt', 'T65 cold-resume history')
        // The OFFICIAL Session open records the orphaned Turn's settlement. Waiting
        // for that durable record (not a timer) is what orders "after the resume,
        // nothing else is pending".
        const recovered = await waitForHostSessionEvent(
          dshHome,
          sessionId,
          event => event.type === 'turn/end',
          'T65 cold-resume orphan settlement',
          120_000,
        )
        // The official crash-recovery closer settles an orphaned turn with its own
        // reason. "Not completed" would also accept an absent/unknown reason, so the
        // exact taxonomy is asserted, on the Session's ONE open turn.
        assert(recovered.data?.reason?.kind === 'interrupted',
          `T65 the cold resume settled the lost Turn as ${String(recovered.data?.reason?.kind)}`)
        assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'turn/start').length === 1,
          'T65 the recovered settlement does not belong to the single lost Turn')
        const afterResume = hostSessionEvents(dshHome, sessionId) ?? []
        assert(hostUserTexts(afterResume).filter(text => text === 't65 prompt').length === 1,
          'T65 the cold resume replayed the unknown write')
        // The official Session open may record the ORPHANED Turn as a
        // fail-closed settlement (an interrupted Turn is truthful recovery and
        // is what the user must see). What it must never do is report that lost
        // work as SUCCESS or invent an answer for it.
        for (const settled of afterResume.filter(event => event.type === 'turn/end')) {
          const kind = settled.data?.reason?.kind
          assert(kind !== 'completed' && kind !== 'max-tokens',
            `T65 the cold resume settled the lost Turn as ${String(kind)}`)
        }
        assert(!hostAssistantHasText(afterResume, 'long-turn answer'),
          'T65 the cold resume fabricated an answer for the lost Turn')
        assert(!(await resumed.viewport()).join('\n').includes('long-turn answer'),
          'T65 the resumed surface painted a fabricated answer for the lost Turn')
        await exitC1Client(resumed, 'T65 cold-resume Client')
        await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T65 spawned Host')
        trace('t65', {
          hostPid,
          signal: 'SIGKILL',
          clientObserved: lost.transport,
          pendingTurnSettled: false,
          unknownWriteReplayed: false,
          crossHostViewContinuity: false,
          newHostPid: newHost.hostPid,
          newInstanceId,
          singleHostOwner: true,
        })
      }

      // T66: the UNKNOWN-WRITE half of the Host-death contract. An ACK-dropped
      // write is committed by the Host while the Client can only report
      // `indeterminate`; the committing Host then dies. A later Host must read the
      // durable log exactly once (never replay the unknown write), and no Host may
      // ever report that write as a success it did not observe.
      {
        const releaseBarrier = join(workDir, 't66-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't66', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client } = await startC1Client('T66 Client', { SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1' })
        const unknownToken = 't66 unknown-write'
        const sessionId = await openC1Session(client, unknownToken, 'T66')
        // `waitForScreen` is a verdict helper: it throws unless the painted row
        // appears, so a returned value would be a fiction. The painted
        // `indeterminate` notice IS the observation.
        await client.waitForScreen('indeterminate', 'T66 indeterminate notice', 120_000)
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T66 held Turn')
        const hostBefore = await hostIdentityFacts(host)
        const hostPid = ready.pid
        const text = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
          .filter(entry => entry === unknownToken).length
        assert(text === 1, `T66 the Host did not commit the ACK-dropped write exactly once (${String(text)})`)
        // The committing Host dies BEFORE the Turn settles: the write's outcome is
        // now permanently unknown to every Client.
        process.kill(hostPid, 'SIGKILL')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), 'T66 the Host survived SIGKILL')
        const lost = await client.waitFor(
          record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
          'T66 Client observed the official Connection loss',
          60_000,
        )
        assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
          `T66 unexpected Client transport state after the kill: ${JSON.stringify(lost.transport)}`)
        assert(!(await client.viewport()).join('\n').includes('long-turn answer'),
          'T66 the Client painted a settlement for the write whose Host died')
        client.signalBusiness('SIGTERM')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, `T66 Client cleanup exit was ${JSON.stringify(exit)}`)
        await client.dispose()
        // A NEW Host on stale discovery, then a real cold resume of the SAME
        // Session: the durable log must still carry the unknown write EXACTLY ONCE
        // and no fabricated settlement.
        const { client: fresh, ready: freshReady } = await startC1Client('T66 fresh Client')
        const newHost = freshReady.host
        assert(newHost.hostPid !== hostBefore.hostPid, 'T66 stale discovery reused the killed Host PID')
        assert(freshReady.sessionOpen === false, 'T66 the dead Host view survived across the replacement')
        const newInstanceId = newHost.instanceId
        fresh.signalBusiness('SIGTERM')
        const freshExit = await fresh.waitForExit(60_000)
        assert(freshExit.code === 0 && freshExit.signal === null, `T66 fresh Client exit was ${JSON.stringify(freshExit)}`)
        await fresh.dispose()
        const { client: resumed } = await startC1Client('T66 cold-resume Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await resumed.waitForScreen(unknownToken, 'T66 cold-resume history')
        const recovered = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T66 cold-resume orphan settlement', 120_000)
        assert(recovered.data?.reason?.kind === 'interrupted',
          `T66 the cold resume settled the unknown write's Turn as ${String(recovered.data?.reason?.kind)}`)
        assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'turn/start').length === 1,
          'T66 the recovered settlement does not belong to the single lost Turn')
        assert(!(await resumed.viewport()).join('\n').includes('long-turn answer'),
          'T66 the cold resume painted a fabricated answer')
        const afterResume = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
          .filter(entry => entry === unknownToken).length
        assert(afterResume === 1, `T66 the cold resume replayed the unknown write (${String(afterResume)} commits)`)
        await exitC1Client(resumed, 'T66 cold-resume Client')
        await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T66 spawned Host')
        trace('t66', {
          hostPid,
          signal: 'SIGKILL',
          unknownWrite: 'indeterminate',
          hostCommits: 1,
          clientObserved: lost.transport,
          replayedAfterResume: false,
          fabricatedSettlement: false,
          newHostPid: newHost.hostPid,
          newInstanceId,
        })
      }

    } finally {
      for (const client of c1Clients) await client.dispose()
      for (const host of c1Hosts) await stopC1Host(host)
    }

    } finally {
      for (const client of surfaceClients) await client.dispose()
      if (!surfaceHostClosed) {
        try { await surfaceHost.shutdown() } catch { /* already gone */ }
      }
    }

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
