/**
 * Shared Web qualification helpers for the four PR2-D Web cases.
 *
 * This is the ONE owner of the official 60-row oracle, the authenticated
 * launch-token -> cookie -> index -> graph chain, the bounded SSE probes, the
 * credential redactor and the abortable Browser-driver waits. The host cases
 * import these helpers; no copy remains in the lane entry.
 *
 * @module split-process/web-helpers
 */

import { request as httpRequest } from 'node:http'
import { setTimeout as sleepTimer } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { fetchStatus } from '../../lib/split-smoke-processes.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * M5-W PR-A: the 60 official Web rows the Host-only overlay declares, in order.
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
  { id: 'ui-context-menu', name: '@deepseek-ai/dsh-client-ui-context-menu' },
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
  { id: 'ui-file-drag', name: '@deepseek-ai/dsh-client-ui-file-drag' },
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
export const PR_A_WELCOME_NOTICE_VERSION = '2026-09-28.1'

export const PR_A_WEB_RUNTIME_ID = 'web-runtime'
export const PR_A_CLIENT_MODULES_PACKAGE = '@deepseek-ai/dsh-client-modules'
/** The core official Web rows whose OWNER count must stay exactly one. */
export const PR_A_SINGLETON_PACKAGES = [
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
export async function sseProbe (origin, path, timeoutMs = 5_000) {
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
export function openSseFrames (origin, path, headers = {}) {
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

/**
 * The official authenticated index chain: launch token -> 303 + signed cookie
 * -> 200 DSH index carrying the composed browser graph. Returns every fact so a
 * caller's predicate can assert them and a negative control can prove the same
 * predicate rejects a mutation. Shared by the PR-A static composition and the
 * PR-B runtime-toggle lanes.
 */
export async function readHostWebIndex(origin, launch, label) {
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
export function assertWebIndexQualified(facts, label, dshVersion) {
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
