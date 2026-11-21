/**
 * Shared Web qualification helpers for the four PR2-D Web cases.
 *
 * This is the ONE owner of the official Web-row oracle, the authenticated
 * launch-token -> cookie -> index -> graph chain, the bounded SSE probes, the
 * credential redactor and the abortable Browser-driver waits. The host cases
 * import these helpers; no copy remains in the lane entry.
 *
 * @module split-process/web-helpers
 */

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleepTimer } from 'node:timers/promises'
import { parse as parseYaml } from 'yaml'

import {
  redactWebQualificationText,
  SplitSmokeAssertionError,
} from '../../lib/split-smoke-diagnostics.mjs'
import { fetchStatus } from '../../lib/split-smoke-processes.mjs'

// Re-exported for the Web producers and their tooling guards: the
// implementation is owned by the shared diagnostics module so the same concrete
// redactor also protects the default failure output.
export { redactWebQualificationText }

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * The minimal independent id -> package facts used to spot-check the packed
 * official Web graph. This is deliberately not a second full roster: the
 * generated bundle patch and the production table own that list.
 */
export const CORE_WEB_ROW_PACKAGES = [
  { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app' },
  { id: 'modules', name: '@deepseek-ai/dsh-client-modules' },
  { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
  { id: 'cordis-client-runner', name: '@deepseek-ai/dsh-cordis-client-runner' },
  { id: 'open-in-app', name: '@deepseek-ai/dsh-host-open-in-app' },
  { id: 'session-reference', name: '@deepseek-ai/dsh-session-reference' },
  { id: 'plugin-inventory', name: '@deepseek-ai/dsh-host-plugin-inventory' },
  { id: 'message-feedback', name: '@deepseek-ai/dsh-message-feedback' },
  { id: 'workspace-changes', name: '@deepseek-ai/dsh-workspace-changes' },
  { id: 'ui-deliverables', name: '@deepseek-ai/dsh-client-ui-deliverables' },
  { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' },
  { id: 'ui-context-menu', name: '@deepseek-ai/dsh-client-ui-context-menu' },
  { id: 'ui-file-drag', name: '@deepseek-ai/dsh-client-ui-file-drag' },
]

/**
 * Read the Web Loader rows the INSTALLED candidate package declares in its
 * generated bundle patch. This answers only "what does this packed package
 * declare", never "what is currently active": callers must read the live Host
 * status separately. No checkout fallback and no caching are allowed here.
 *
 * @param profilePackage - the installed `@xmoon76/dsh-pi-tui` package root.
 */
export function readDeclaredWebRows(profilePackage) {
  const patchPath = join(profilePackage, 'generated', 'web-access', 'cordis.patch.yml')
  let entries
  try {
    entries = parseYaml(readFileSync(patchPath, 'utf8'), {
      // office-kit's official `!!js` output-directory macro stays its verbatim
      // expression text; the generated layer owns that fixed fragment.
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    })
  } catch (error) {
    throw new SplitSmokeAssertionError(`the installed candidate has no readable Web declaration at ${patchPath}: ${error.message}`)
  }
  assert(Array.isArray(entries), `${patchPath}: the Web declaration must be a YAML sequence`)
  const groups = entries.filter(entry => entry !== null && typeof entry === 'object' && Array.isArray(entry.insert))
  assert(groups.length === 1, `${patchPath}: expected exactly ONE Web insert group, found ${groups.length}`)
  const rows = groups[0].insert
  assert(rows.length > 0, `${patchPath}: the Web insert group is empty`)
  const ids = new Set()
  return rows.map(row => {
    assert(row !== null && typeof row === 'object', `${patchPath}: every Web row must be an object`)
    assert(typeof row.id === 'string' && row.id !== '', `${patchPath}: a Web row has no id`)
    assert(typeof row.name === 'string' && row.name !== '', `${patchPath}: the "${row.id}" Web row has no package name`)
    assert(typeof row.disabled === 'boolean', `${patchPath}: the "${row.id}" Web row has no boolean disabled flag`)
    assert(!ids.has(row.id), `${patchPath}: the Web row id "${row.id}" is declared twice`)
    ids.add(row.id)
    if (row.inject !== undefined) {
      assert(Array.isArray(row.inject) && row.inject.every(value => typeof value === 'string'),
        `${patchPath}: the "${row.id}" Web row has an invalid inject list`)
    }
    if (row.config !== undefined) {
      assert(row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config),
        `${patchPath}: the "${row.id}" Web row has an invalid config`)
    }
    return {
      id: row.id,
      name: row.name,
      disabled: row.disabled,
      ...(row.inject === undefined ? {} : { inject: row.inject }),
      ...(row.config === undefined ? {} : { config: row.config }),
    }
  })
}

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
 * The credential redactor now lives in `split-smoke-diagnostics.mjs` (the ONE
 * owner) and is re-exported here for the Web producers.
 */

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
