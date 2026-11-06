/**
 * Shared support for the split-upgrade smoke cases.
 *
 * This module owns the ONE implementation of every helper the three extracted
 * Upgrade cases share with the Upgrade runner: real-process/PTY waits, installed
 * payload identity, Host status/identity probes, profile peer ownership, the
 * side-by-side build install, cleanup and the two `/reload-client` waiters.
 *
 * Importing this module performs no I/O, creates no directory and starts no
 * process. It never imports the Upgrade runner or its selection registry, so the
 * dependency direction stays `Runner -> Selection -> Case -> Support`.
 *
 * @module split-upgrade-support
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { run } from './dsh-smoke-harness.mjs'
import {
  classifyHandoffRejection,
  classifyReloadNotices,
  reloadNoticeTypeForText,
  SplitSmokeAssertionError,
  SplitSmokeWaitError,
} from './split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from './split-smoke-fixtures.mjs'
import {
  alive,
  productionBuildId,
  readJson,
  readStartIdentity,
  seatIsFree,
  waitGone,
} from './split-smoke-processes.mjs'

/** The only package name a split-upgrade artifact may carry. */
export const EXPECTED_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'

/** The two `/reload-client` waits share one bounded budget. */
const RELOAD_WAIT_MS = 120_000

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** One lane assertion: the case file's own line becomes the published site. */
export function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

export function canonicalAssertValue(value) {
  if (Array.isArray(value)) return value.map(canonicalAssertValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalAssertValue(value[key])]))
  }
  return value
}

export function assertEqual(actual, expected, message) {
  assert(actual === expected, message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

export function assertNotEqual(actual, unexpected, message) {
  assert(actual !== unexpected, message ?? `did not expect ${JSON.stringify(unexpected)}`)
}

export function assertDeepEqual(actual, expected, message) {
  const left = JSON.stringify(canonicalAssertValue(actual))
  const right = JSON.stringify(canonicalAssertValue(expected))
  assert(left === right, message ?? `expected ${right}, got ${left}`)
}

export function assertMatch(actual, pattern, message) {
  assert(typeof actual === 'string' && pattern.test(actual),
    message ?? `${JSON.stringify(actual)} does not match ${String(pattern)}`)
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * sha256 over every regular file in one installed package tree. This proves
 * byte identity of the old installation across the side-by-side install, not
 * only that the profile still resolves the same directory path.
 */
export function installedPayloadHash(packageRoot) {
  const hash = createHash('sha256')
  const files = readdirSync(packageRoot, { recursive: true })
    .filter(name => {
      try {
        return statSync(join(packageRoot, name)).isFile()
      } catch {
        return false
      }
    })
    .map(name => relative(packageRoot, join(packageRoot, name)).split(sep).join('/'))
    .sort()
  for (const name of files) {
    hash.update(name)
    hash.update('\0')
    hash.update(sha256(join(packageRoot, ...name.split('/'))))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** The kernel starttime of one live process, under the historical lane name. */
export { productionBuildId, readJson, waitGone, alive, seatIsFree }
export { readStartIdentity as readProcessStarttime }

/** One Upgrade Host status request id sequence, private to this module. */
let statusSequence = 0

export async function hostStatus(host) {
  const requestId = `upgrade-status-${String(++statusSequence)}`
  host.send({ op: 'status', requestId })
  return await host.waitFor(
    record => record.m4a0 === 'status' && record.requestId === requestId,
    `Host status ${requestId}`,
    30_000,
  )
}

export function safeIdentity(record) {
  return {
    schema: record.schema,
    scopeId: record.scopeId,
    instanceId: record.instanceId,
    hostPid: record.hostPid,
    hostStarttime: record.hostStarttime,
    origin: record.origin,
    protocol: record.protocol,
    bundleVersion: record.bundleVersion,
    dshVersion: record.dshVersion,
    buildId: record.buildId,
  }
}

export function assertIdentityKept(actual, expected, label) {
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'hostStarttime', 'protocol', 'bundleVersion', 'dshVersion', 'buildId']) {
    assert(actual?.[key] === expected?.[key], `${label}: identity ${key} changed`)
  }
}

/**
 * One bounded wait for the shared C1 workload fixture. The shared default is
 * 60s; the Upgrade lane historically waits 120s, so this wrapper fixes that
 * explicit default WITHOUT copying the shared parser or polling loop.
 */
export async function waitForUpgradeC1WorkEvent(workRoot, predicate, label, timeoutMs = 120_000) {
  return await waitForC1WorkEvent(workRoot, predicate, label, timeoutMs)
}

export { readC1WorkEvents }

export function c1WorkHadRelease(workRoot) {
  return readC1WorkEvents(workRoot).some(event => event.kind === 'long-turn-released')
}

export function scopeDirOf(dshHome, scopeId) {
  return join(dshHome, 'run', 'dsh-pi-tui', scopeId)
}

export function scopeScratchDirs(scopeDir) {
  if (!existsSync(scopeDir)) return []
  return readdirSync(scopeDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('host-scratch-'))
    .map(entry => entry.name)
}

/** Every durable Host Session log under the isolated DSH home (sorted). */
export function sessionLogFiles(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true })
    .map(name => String(name))
    .filter(name => name.endsWith('.jsonl.zstd'))
    .sort()
}

export function readHostLogRecords(scopeDir, pid) {
  const path = join(scopeDir, 'host.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const record = JSON.parse(line)
      return record?.pid === pid ? [record] : []
    } catch {
      return []
    }
  })
}

export function createRequireFrom(anchor) {
  return createRequire(anchor)
}

/**
 * Assert the active profile owns the exact Client peer set: plain dependencies
 * (never bundle layers) that its own node_modules resolves. A harness
 * devDependency or a checkout ancestor is not a Client peer owner (issue #476).
 */
export function assertProfileClientPeers(profileDir, targetDshVersion, label) {
  const manifest = readJson(join(profileDir, 'package.json'))
  const peers = [
    ['@deepseek-ai/dsh-client-store', targetDshVersion],
    ['zustand', '4.5.7'],
    ['immer', '10.2.0'],
  ]
  for (const [name, version] of peers) {
    assert(manifest.dependencies?.[name] === version,
      `${label}: the active profile does not declare the exact Client peer ${name}@${version}`)
    assert(!(manifest.dsh?.profile?.bundles ?? []).includes(name),
      `${label}: the plain Client peer ${name} must not become a profile bundle`)
    const peerDir = realpathSync(join(profileDir, 'node_modules', name))
    assert(readJson(join(peerDir, 'package.json')).version === version,
      `${label}: the active profile installed a different ${name} version`)
    const resolvedPeer = realpathSync(createRequireFrom(join(profileDir, 'package.json')).resolve(name))
    const peerRelative = relative(peerDir, resolvedPeer)
    assert(peerRelative !== '' && peerRelative !== '..' && !peerRelative.startsWith(`..${sep}`),
      `${label}: the active profile ${name} resolves outside its own package: ${resolvedPeer}`)
  }
  assert((manifest.dsh?.profile?.bundles ?? []).includes(EXPECTED_PACKAGE_NAME),
    `${label}: the candidate bundle row disappeared from the active profile`)
  return peers
}

export function assertNoSecret(label, text, secrets) {
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    assert(!text.includes(secret), `${label} leaked a private launch credential`)
  }
}

export async function fetchStatus(url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store', ...options })
  return { status: response.status, setCookie: response.headers.get('set-cookie') ?? '' }
}

export function installSideBuild(dir, tarball, env, targetDshVersion) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org\n', { mode: 0o600 })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'split-upgrade-side-build',
    private: true,
    version: '1.0.0',
    dependencies: {
      [EXPECTED_PACKAGE_NAME]: `file:${tarball}`,
      '@deepseek-ai/dsh-client-store': targetDshVersion,
      zustand: '4.5.7',
      immer: '10.2.0',
    },
  }, null, 2) + '\n', 'utf8')
  const result = run('pnpm', [
    'install',
    '--ignore-scripts',
    '--no-frozen-lockfile',
    '--config.auto-install-peers=false',
    '--config.minimum-release-age=0',
    '--reporter=append-only',
  ], { cwd: dir, env, timeout: 10 * 60_000 })
  if (result.status !== 0) {
    throw new Error(`the side-by-side new-build install failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  const packageRoot = realpathSync(join(dir, 'node_modules', EXPECTED_PACKAGE_NAME))
  if (!existsSync(join(packageRoot, 'dist', 'local-client.mjs'))) {
    throw new Error('the side-by-side new-build install has no local Client entry')
  }
  return packageRoot
}

export function killProcessGroup(process_handle) {
  if (process_handle === undefined) return
  try { process.kill(-process_handle.child.pid, 'SIGKILL') } catch {
    try { process_handle.child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

export async function stopHostForCleanup(host) {
  if (host === undefined || host.exited) return
  try { process.kill(host.records.find(record => record.m4a0 === 'ready')?.pid ?? host.child.pid, 'SIGTERM') } catch { /* already gone */ }
  try { await host.waitForExit(20_000) } catch { killProcessGroup(host) }
}

/**
 * Stop a real Host that a Client cold-started (it has no harness handle).
 * The recorded kernel starttime is the ownership fence: a PID reused by an
 * unrelated process is never signalled.
 */
export async function stopRecordedHostForCleanup(host) {
  if (host === undefined || readStartIdentity(host.pid) !== host.starttime) return
  try { process.kill(host.pid, 'SIGTERM') } catch { return }
  if (await waitGone(host.pid, 20_000)) return
  try { process.kill(-host.pid, 'SIGKILL') } catch {
    try { process.kill(host.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  await waitGone(host.pid, 5_000)
}

/** The internal `m4r` rejection classifications that still match one notice. */
function rejectionMatchesNotice(expectedNotice, observed) {
  if (observed === 'TARGET_INVALID_DSH_PIN_MISMATCH' || observed === 'TARGET_INVALID_UNCLASSIFIED') {
    return expectedNotice === 'TARGET_INVALID'
  }
  if (observed === 'ALREADY_CURRENT') return expectedNotice === 'ALREADY_CURRENT'
  return false
}

/**
 * The two `/reload-client` waits, with ONE rule each about evidence.
 *
 * PASS always requires the REAL painted PTY notice (or, for an accepted
 * request, the Client's own post-boundary telemetry). A known internal refusal
 * that CANNOT lead to the expected notice ends the wait early with the actual
 * classification — that is a fast FAIL, never a fast PASS: an `m4r` record that
 * agrees with the expectation still has to be painted.
 *
 * `fromRecordIndex` must be captured BEFORE this action's command or signal is
 * sent, so a refusal left by an earlier command can never be blamed on this one.
 */
export async function waitForReloadNotice(client, expectedText, label, fromRecordIndex, timeoutMs = RELOAD_WAIT_MS) {
  const expected = reloadNoticeTypeForText(expectedText)
  const started = Date.now()
  const fail = (category, code, observed) => new SplitSmokeWaitError(category, {
    code,
    waitLabel: label,
    processRole: client.role,
    elapsedMs: Date.now() - started,
    expected,
    observed,
    process: client,
  })
  for (;;) {
    const viewport = await client.viewport()
    // ONE painted-frame read drives both decisions, and both use the product's
    // fixed notice ROW shape: a composer line, a prompt echo or any other row
    // that merely contains the same words can neither PASS this wait nor fail
    // it — only a real `✗`/`ℹ Client reload …` notice row is evidence.
    const painted = classifyReloadNotices(viewport)
    // 1. A painted frame carrying THIS notice is the only PASS authority.
    if (painted.includes(expected)) return expected
    // 2. Any other fixed notice row is already decisive.
    const unexpected = painted.find(type => type !== expected)
    if (unexpected !== undefined) throw fail('UNEXPECTED_RELOAD_REFUSAL', 'PAINTED_NOTICE_MISMATCH', unexpected)
    // 3. A refusal of this action that can never paint the expected notice ends
    //    the wait now; an agreeing refusal still has to reach the screen.
    for (const record of client.records.slice(fromRecordIndex)) {
      if (record?.m4r !== 'handoff-request-rejected') continue
      const observed = classifyHandoffRejection(record.error)
      if (!rejectionMatchesNotice(expected, observed)) throw fail('UNEXPECTED_RELOAD_REFUSAL', 'PROCESS_REFUSED_RELOAD', observed)
    }
    // 4. A dead Client or an unreadable record file fails by its own category.
    if (client.recordError !== undefined) throw fail('INFRA_FAILURE', 'RECORD_READ_FAILED')
    if (client.exited) {
      const unread = client.finalRecordRead(label)
      if (unread !== undefined) throw unread
      const painted = classifyReloadNotices(await client.viewport()).find(type => type !== expected)
      if (painted !== undefined) throw fail('UNEXPECTED_RELOAD_REFUSAL', 'PAINTED_NOTICE_MISMATCH', painted)
      throw fail('PROCESS_EXITED', 'PROCESS_EXITED_BEFORE_NOTICE')
    }
    if (Date.now() - started >= timeoutMs) throw fail('WAIT_TIMEOUT', 'NOTICE_WAIT_TIMEOUT')
    await sleep(50)
  }
}

/**
 * The Client's own `handoff-request-ignored` reasons, projected onto the notice
 * types the product would publish for the same decision (an already-latched or
 * stopping Client refuses as `stopping`; an unready one as `not-ready`).
 */
const IGNORED_REASON_TYPES = Object.freeze({
  'already-requested': 'STOPPING',
  stopping: 'STOPPING',
  'not-ready': 'NOT_READY',
})

export async function waitForAcceptedHandoff(client, pid, label, fromRecordIndex, timeoutMs = RELOAD_WAIT_MS) {
  const started = Date.now()
  const fail = (category, code, observed) => new SplitSmokeWaitError(category, {
    code,
    waitLabel: label,
    processRole: client.role,
    elapsedMs: Date.now() - started,
    observed,
    process: client,
  })
  for (;;) {
    for (const record of client.records.slice(fromRecordIndex)) {
      // Only THIS action's accepted request for THIS PID satisfies the wait.
      if (record?.m4r === 'handoff-requested' && record.pid === pid) return record
      if (record?.m4r === 'handoff-request-rejected') {
        throw fail('UNEXPECTED_RELOAD_REFUSAL', 'PROCESS_REFUSED_RELOAD', classifyHandoffRejection(record.error))
      }
      if (record?.m4r === 'handoff-request-ignored') {
        throw fail('UNEXPECTED_RELOAD_REFUSAL', 'PROCESS_IGNORED_RELOAD', IGNORED_REASON_TYPES[record.reason])
      }
    }
    if (client.recordError !== undefined) throw fail('INFRA_FAILURE', 'RECORD_READ_FAILED')
    if (client.exited) {
      const unread = client.finalRecordRead(label)
      if (unread !== undefined) throw unread
      const late = client.records.slice(fromRecordIndex).find(record => record?.m4r === 'handoff-requested' && record.pid === pid)
      if (late !== undefined) return late
      throw fail('PROCESS_EXITED', 'PROCESS_EXITED_BEFORE_HANDOFF')
    }
    if (Date.now() - started >= timeoutMs) throw fail('WAIT_TIMEOUT', 'HANDOFF_WAIT_TIMEOUT')
    await sleep(50)
  }
}
