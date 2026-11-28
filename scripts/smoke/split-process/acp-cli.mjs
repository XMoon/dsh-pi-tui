/**
 * PR-C headless ACP CLI: the REAL installed `dsh --profile pi-tui acp ...`
 * commands against one isolated packed Host.
 *
 * The case drives the public CLI entry (never an internal process harness):
 * the Host-absent refusal of all three management verbs, one real
 * `daemon start`, the default-off read, the enable/disable round trip on the
 * SAME Host identity, a REAL external ACP client over the public `acp stdio`
 * byte relay, the peer disconnect caused by `acp disable`, the authenticated
 * Owner-only route's unauthenticated/foreign-instance/strict-shape refusals,
 * a REAL second canonical Profile whose own Host only answers its own
 * commands, and the clean missing-Host refusal after `daemon stop`.
 *
 * Every management verb is the installed public binary. The ACP client is the
 * official SDK over the real stdout/stdin relay; the driver never imports a
 * Host service and never creates a second Host (the second Profile's Host is
 * created by its own public `daemon start`, exactly like a user's).
 *
 * S12 (a lost/replaced write reply) is deliberately NOT reproduced here: it
 * would require killing the shared Host mid-write, so the real case records
 * that boundary and the exact same decision is proven by the CLI unit lane
 * (`test/app/local-acp-control.test.ts`) with a real loopback server.
 *
 * @module split-process/acp-cli
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import { seedProfileBuildPolicy } from '../../lib/dsh-profile-build-policy.mjs'
import { protocolOnly } from '../../lib/split-smoke-acp-wire.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readKernelProcess, sameKernelProcess } from '../../../src/runtime/native-process/identity.ts'
import { requestFresh } from './web-cli-m6.mjs'

const PROFILE = 'pi-tui'
/** The real second canonical Profile the cross-Profile isolation scene installs. */
const PEER_PROFILE = 'acp-cli-peer'
const CONTROL_ROUTE = '/api/pi-tui.acp-control'
const STATUS_ROUTE = '/api/pi-tui.acp-status'
/** Bound on one public management CLI invocation. */
const CLI_TIMEOUT_MS = 180_000
/** Bound on one bounded smoke-driver HTTP request. */
const HTTP_TIMEOUT_MS = 30_000
/** Bound on one real external ACP `initialize`. */
const ACP_INITIALIZE_TIMEOUT_MS = 120_000

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function spawnCli(installation, args, extraEnv = {}, cwd = installation.profileDir) {
  const [executable, ...prefix] = installation.dshInvocation
  return new Promise(resolve => {
    const child = spawn(executable, [...prefix, ...args], {
      cwd,
      env: { ...installation.env, ...extraEnv },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => { stdout.push(chunk) })
    child.stderr.on('data', chunk => { stderr.push(chunk) })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, CLI_TIMEOUT_MS)
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function runCli(installation, args, extraEnv = {}, profileName = PROFILE) {
  return spawnCli(installation, ['--profile', profileName, ...args], extraEnv)
}

/** One official CLI command that carries its own profile selection. */
function runRawCli(installation, args, cwd = installation.harnessDir) {
  return spawnCli(installation, args, {}, cwd)
}

/** The stable key=value block of `daemon status`. */
function statusFields(result) {
  const lines = (result.stdout ?? '').split('\n')
  const start = lines.findLastIndex(line => line.startsWith('profile='))
  const fields = {}
  if (start >= 0) {
    for (const line of lines.slice(start)) {
      const at = line.indexOf('=')
      if (at > 0 && !line.includes(' ')) fields[line.slice(0, at)] = line.slice(at + 1)
    }
  }
  return fields
}

function assertExit(result, code, label) {
  assert(result.status === code,
    `${label}: exit ${String(result.status)} != ${String(code)}; stderr tail: ${String(result.stderr ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-800)}`)
}

function assertExactLine(result, line, label) {
  assertExit(result, 0, label)
  assert(result.stdout === `${line}\n`, `${label}: stdout was ${JSON.stringify(result.stdout)}, expected exactly ${JSON.stringify(`${line}\n`)}`)
  assert(result.stderr === '', `${label}: expected empty stderr, got ${JSON.stringify(result.stderr)}`)
}

function recordPaths(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return []
  const paths = []
  for (const scope of readdirSync(root, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue
    const dir = join(root, scope.name)
    if (existsSync(join(dir, 'instance.json'))) {
      paths.push({
        instancePath: join(dir, 'instance.json'),
        launchPath: join(dir, 'launch.json'),
      })
    }
  }
  return paths
}

function publishedRecords(dshHome) {
  return recordPaths(dshHome).map(path => JSON.parse(readFileSync(path.instancePath, 'utf8')))
}

/** The ONE published record of the named canonical Profile. */
function recordForProfile(dshHome, profileName) {
  const matches = publishedRecords(dshHome).filter(record => String(record.profileRealpath).endsWith(`/profiles/${profileName}`))
  assert(matches.length === 1, `expected exactly one published Host record for ${profileName}, found ${matches.length}`)
  return matches[0]
}

function readRecord(dshHome) {
  const paths = recordPaths(dshHome)
  assert(paths.length === 1, `expected exactly one published Host instance record, found ${paths.length}`)
  return JSON.parse(readFileSync(paths[0].instancePath, 'utf8'))
}

/**
 * Report one public-CLI-created Host's authoritative identity to the selected
 * lane, so its machine-readable FACTS line and its quiescence check cover the
 * real Host process (the lane never created it through its own constructors).
 * The identity comes from the Host's own published record, never a guess.
 */
function recordHostIdentity(context, record) {
  if (typeof context.recordProcessIdentity !== 'function') return
  context.recordProcessIdentity({
    role: 'host',
    pid: record.hostPid,
    instanceId: record.instanceId,
    scopeId: record.scopeId,
    kernelUniqueId: record.schema === 2 ? record.hostKernelIdentity.uniqueId : record.hostStarttime,
  })
}

function readLaunch(dshHome, instanceId) {
  const paths = recordPaths(dshHome)
  const path = paths.find(candidate => JSON.parse(readFileSync(candidate.instancePath, 'utf8')).instanceId === instanceId)
  assert(path !== undefined, 'the authenticated Host launch material is missing')
  return JSON.parse(readFileSync(path.launchPath, 'utf8'))
}

/** The public logical ACP endpoint of one profile scope (the documented contract). */
function publicAcpSocketPath(dshHome, scopeId) {
  if (process.platform === 'darwin') {
    const uid = process.getuid?.()
    assert(typeof uid === 'number', 'the Darwin ACP endpoint needs a POSIX uid')
    return join('/private/tmp', `dpt-${String(uid)}-${scopeId.slice(0, 40)}`, 'acp.sock')
  }
  return join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'acp.sock')
}

/** Every published scope directory (the cross-Profile isolation fact). */
function scopeDirectories(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/**
 * One real external ACP client over the public `acp stdio` byte relay. The
 * driver is the official SDK, exactly like an IDE client: it never imports a
 * Host service and never talks to the private socket itself.
 */
class AcpStdioClient {
  constructor(context) {
    this.context = context
    const { installation, base } = context
    const [node, entry] = installation.dshInvocation
    this.child = spawn(node, [entry, '--profile', PROFILE, 'acp', 'stdio'], {
      cwd: installation.profileDir,
      env: base.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.rawChunks = []
    this.stderr = ''
    this.tap = new Transform({
      transform: (chunk, _encoding, callback) => {
        this.rawChunks.push(Buffer.from(chunk))
        callback(null, chunk)
      },
    })
    this.child.stdout.pipe(this.tap)
    this.child.stderr.on('data', chunk => { this.stderr += String(chunk) })
    this.exit = new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit({ code: null, signal: null, timedOut: true }), ACP_INITIALIZE_TIMEOUT_MS)
      this.child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolveExit({ code, signal })
      })
    })
    if (Number.isInteger(this.child.pid)) {
      const observation = readKernelProcess(this.child.pid)
      this.identity = observation.kind === 'alive' ? observation.identity : undefined
      if (this.identity !== undefined) context.trackDetachedPid?.(this.child.pid, this.identity)
    }
  }

  rawStdout() {
    return Buffer.concat(this.rawChunks)
  }

  async initialize() {
    const app = acp.client({ name: 'dsh-pi-tui-acp-cli-qualification' })
    this.connection = app.connect(acp.ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.tap)))
    let timer
    try {
      return await Promise.race([
        this.connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('the public acp stdio client did not initialize')), ACP_INITIALIZE_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async waitExit() {
    return await this.exit
  }

  /** Bounded wait for a command that must refuse before spawning the Adapter. */
  async waitExitSoon(timeoutMs = 60_000) {
    let timer
    try {
      return await Promise.race([
        this.exit,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new SplitSmokeAssertionError('the public acp stdio command did not exit')), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async close() {
    try { this.connection?.close() } catch { /* already closed */ }
    try { this.child.stdin.end() } catch { /* already ended */ }
    const exit = await this.exit
    if (this.child.pid !== undefined) this.context?.untrackDetachedPid?.(this.child.pid)
    return exit
  }

  kill(signal = 'SIGKILL') {
    if (this.identity === undefined || this.child.pid === undefined) return
    const observed = readKernelProcess(this.child.pid)
    if (observed.kind !== 'alive' || sameKernelProcess(this.identity, observed) !== 'same') return
    try { process.kill(-this.child.pid, signal) } catch { /* group already gone */ }
  }
}

function setCookiePair(response) {
  const raw = response.headers.getSetCookie?.() ?? (response.headers.get('set-cookie') === null ? [] : [response.headers.get('set-cookie')])
  return raw[0]?.split(';', 1)[0] ?? ''
}

/** Exchange the launch token for one signed Owner Cookie (the official handshake). */
async function ownerCookieOf(dshHome, instanceId) {
  const launch = readLaunch(dshHome, instanceId)
  const url = new URL(launch.connectUrl)
  url.searchParams.set('interactions', 'answer')
  const response = await requestFresh(url.href, { method: 'GET', redirect: 'manual', cache: 'no-store' }, 'ACP CLI')
  assert(response.status === 302, `the official /connect token exchange returned HTTP ${String(response.status)}`)
  assert(/\bno-store\b/iu.test(response.headers.get('cache-control') ?? ''), 'the official /connect exchange is not no-store')
  const location = response.headers.get('location')
  assert(location !== null && new URL(location, url).pathname === '/api/remote.mux',
    'the official /connect exchange did not redirect into the authenticated mux')
  const cookie = setCookiePair(response)
  assert(cookie !== '', 'the official /connect token exchange minted no signed Cookie')
  return cookie
}

/** Assert one response body carries no private path, exception text or token. */
async function assertSanitized(response, label) {
  const text = await response.text()
  assert(!/\/private\/|\/run\/|\/home\/|\/Users\/|socket/iu.test(text), `${label}: the reply leaked a private path/socket: ${text}`)
  assert(!/token=|\bcookie\b/iu.test(text), `${label}: the reply leaked credential material: ${text}`)
  assert(!/\bat\s+\w+\s*\(/u.test(text), `${label}: the reply leaked an exception stack: ${text}`)
  return text
}

async function waitForClosed(connection, label) {
  let timer
  try {
    await Promise.race([
      connection.closed,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new SplitSmokeAssertionError(`${label}: the ACP peer connection did not close`)), ACP_INITIALIZE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Drive the REAL public ACP CLI against one isolated installed profile.
 * @param context - the selected split-process case context.
 * @returns the case verdict facts.
 */
export async function runAcpCli(context) {
  const { installation, dshHome, trace, tarball } = context
  const result = {
    status: 'PASS',
    headlessCli: 'PASS',
    noHostRefusal: true,
    statusPureRead: true,
    enableDisableRoundTrip: true,
    sameHostIdentity: true,
    stdioProtocolClean: true,
    disableClosesPeer: true,
    anonymousPostRefused: true,
    authenticatedStrictRefusals: true,
    crossProfileIsolated: true,
  }
  let hostStarted = false
  let peerStarted = false
  let peer
  try {
    // ── S01: Host absent — every verb refuses without starting a Host ──────
    const before = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(before.host === 'stopped', `acp-cli: the isolated Profile began with host=${String(before.host)}`)
    for (const verb of ['status', 'enable', 'disable']) {
      const absent = await runCli(installation, ['acp', verb])
      assertExit(absent, 3, `acp ${verb} with no Host`)
      assert(absent.stdout === '', `acp ${verb} with no Host must print nothing on stdout`)
      assert(/^dsh-pi-tui acp: HOST_NOT_RUNNING: /u.test(absent.stderr),
        `acp ${verb} with no Host did not report HOST_NOT_RUNNING: ${absent.stderr}`)
      assert(absent.stderr.includes('daemon start'), `acp ${verb} with no Host must suggest daemon start`)
    }
    const stillStopped = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(stillStopped.host === 'stopped', 'a no-Host acp management verb started a Host')
    assert(recordPaths(dshHome).length === 0, 'an acp management verb published an instance record without a Host')
    trace('acp-cli-absent', { host: 'stopped', verbs: 'status,enable,disable' })

    // ── S02: one real Host; the default-off pure read ──────────────────────
    const started = await runCli(installation, ['daemon', 'start'])
    assertExit(started, 0, 'daemon start')
    hostStarted = true
    const startFields = statusFields(started)
    assert(startFields.host === 'ready', `daemon start did not reach host=ready: ${JSON.stringify(startFields)}`)
    const record = readRecord(dshHome)
    recordHostIdentity(context, record)
    const hostPid = record.hostPid
    const instanceId = record.instanceId
    const scopeId = record.scopeId
    assert(typeof hostPid === 'number' && hostPid > 0, 'the published Host record has no PID')
    assert(typeof instanceId === 'string' && instanceId !== '', 'the published Host record has no instance id')
    assert(typeof scopeId === 'string' && scopeId !== '', 'the published Host record has no scope id')
    const socketPath = publicAcpSocketPath(dshHome, scopeId)
    assert(!existsSync(socketPath), 'the default-off Host bound an ACP socket')
    const disabledStatus = await runCli(installation, ['acp', 'status'])
    assertExactLine(disabledStatus, 'acp=disabled', 'acp status default-off')
    const disabledSummary = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(disabledSummary.host === 'ready' && disabledSummary.pid === String(hostPid) && disabledSummary.instance === instanceId.slice(0, 8),
      `acp status changed the Host identity: ${JSON.stringify(disabledSummary)}`)
    assert(disabledSummary.acp === 'disabled', `daemon status did not cross-check acp=disabled: ${JSON.stringify(disabledSummary)}`)
    trace('acp-cli-status-disabled', { hostPid, instance: instanceId.slice(0, 8), state: 'disabled' })

    // DS-05: while the listener is really disabled, an anonymous or forged
    // request carrying the SAME legal enable body must be refused at admission
    // and must leave the authoritative listener state disabled. A GET status
    // probe must not project any business state either.
    const ownerCookie = await ownerCookieOf(dshHome, instanceId)
    const authenticatedStatusProbe = await requestFresh(`${record.origin}${STATUS_ROUTE}`, {
      headers: { cookie: ownerCookie },
    }, 'ACP CLI')
    assert(authenticatedStatusProbe.status === 200,
      `DS-05 authenticated ACP status GET returned HTTP ${String(authenticatedStatusProbe.status)}`)
    const disabledStatusPayload = JSON.parse(await assertSanitized(authenticatedStatusProbe, 'DS-05 authenticated ACP status GET'))
    assert(disabledStatusPayload.schema === 1 && disabledStatusPayload.instanceId === instanceId,
      'DS-05 authenticated ACP status did not echo the current instance')
    assert(disabledStatusPayload.status?.state === 'disabled',
      'DS-05 authenticated ACP status did not prove the disabled listener')
    const legalEnableBody = JSON.stringify({ schema: 1, instanceId, op: 'enable' })
    const anonymousEnable = await requestFresh(`${record.origin}${CONTROL_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: legalEnableBody,
    }, 'ACP CLI')
    assert([401, 403].includes(anonymousEnable.status),
      `DS-05 anonymous ACP enable returned HTTP ${String(anonymousEnable.status)}`)
    await assertSanitized(anonymousEnable, 'DS-05 anonymous ACP enable')
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=disabled',
      'DS-05 ACP status after anonymous enable')
    assert(!existsSync(socketPath), 'DS-05 anonymous enable bound the ACP socket')

    const forgedEnable = await requestFresh(`${record.origin}${CONTROL_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'dsh_session=deadbeef' },
      body: legalEnableBody,
    }, 'ACP CLI')
    assert([401, 403].includes(forgedEnable.status),
      `DS-05 forged-Cookie ACP enable returned HTTP ${String(forgedEnable.status)}`)
    await assertSanitized(forgedEnable, 'DS-05 forged-Cookie ACP enable')
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=disabled',
      'DS-05 ACP status after forged enable')
    assert(!existsSync(socketPath), 'DS-05 forged enable bound the ACP socket')

    for (const [label, headers] of [
      ['anonymous', {}],
      ['forged', { cookie: 'dsh_session=deadbeef' }],
    ]) {
      const statusProbe = await requestFresh(`${record.origin}${STATUS_ROUTE}`, { headers }, 'ACP CLI')
      assert([401, 403].includes(statusProbe.status),
        `DS-05 ${label} ACP status GET returned HTTP ${String(statusProbe.status)}`)
      const text = await assertSanitized(statusProbe, `DS-05 ${label} ACP status GET`)
      assert(!/\b(?:enabled|disabled|changing|acp-socket)\b/u.test(text),
        `DS-05 ${label} ACP status GET projected listener state`)
    }
    trace('ds05-acp-disabled-admission', { anonymousEnable: anonymousEnable.status, forgedEnable: forgedEnable.status, state: 'disabled' })

    // ── S03/S04: enable through the Owner-only route; status is a pure read ─
    assertExactLine(await runCli(installation, ['acp', 'enable']), 'acp=enabled', 'acp enable')
    assert(existsSync(socketPath), 'acp enable did not bind the profile ACP socket')
    assert(statSync(socketPath).isSocket(), 'the profile ACP endpoint is not a Unix socket')
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=enabled', 'acp status enabled')
    const enabledSummary = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(enabledSummary.host === 'ready' && enabledSummary.pid === String(hostPid) && enabledSummary.instance === instanceId.slice(0, 8),
      `acp enable changed the Host identity: ${JSON.stringify(enabledSummary)}`)
    assert(enabledSummary.acp === 'enabled', `daemon status did not cross-check acp=enabled: ${JSON.stringify(enabledSummary)}`)
    assert(enabledSummary['acp-socket'] === socketPath, `daemon status printed the wrong ACP endpoint: ${String(enabledSummary['acp-socket'])}`)
    trace('acp-cli-enabled', { hostPid, instance: instanceId.slice(0, 8), state: 'enabled' })

    // ── S05: a REAL external ACP client through the public stdio relay ─────
    peer = new AcpStdioClient(context)
    const init = await peer.initialize()
    assert(init?.protocolVersion === 1, `the external ACP client did not negotiate ACP v1: ${JSON.stringify(init)}`)
    const afterInit = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(afterInit.host === 'ready' && afterInit.pid === String(hostPid) && afterInit.instance === instanceId.slice(0, 8),
      `the public acp stdio client started/replaced a Host: ${JSON.stringify(afterInit)}`)
    trace('acp-cli-stdio-initialized', { hostPid, instance: instanceId.slice(0, 8), protocolVersion: init.protocolVersion })

    // ── S06: disable disconnects the live peer and refuses new clients ─────
    assertExactLine(await runCli(installation, ['acp', 'disable']), 'acp=disabled', 'acp disable')
    await waitForClosed(peer.connection, 'S06 live peer')
    const peerExit = await peer.waitExit()
    assert(peerExit.code === 4, `a disabled listener must make the Adapter exit 4 (got ${JSON.stringify(peerExit)})`)
    assert(/ACP_STDIO_HOST_DISCONNECTED|ACP_STDIO_SOCKET_ERROR/u.test(peer.stderr),
      `the Adapter must report a fixed transport code: ${peer.stderr}`)
    const peerWire = protocolOnly(peer.rawStdout())
    assert(peerWire.valid, 'the public acp stdio stdout carried non-JSON-RPC bytes')
    assert(!peer.rawStdout().toString('utf8').includes('acp='), 'human CLI status text leaked into the ACP bridge stdout')
    const afterDisable = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(afterDisable.host === 'ready' && afterDisable.pid === String(hostPid) && afterDisable.instance === instanceId.slice(0, 8),
      `acp disable changed the Host identity: ${JSON.stringify(afterDisable)}`)
    assert(afterDisable.acp === 'disabled', `daemon status did not report the disabled listener: ${JSON.stringify(afterDisable)}`)
    assert(!existsSync(socketPath), 'acp disable left the ACP socket inode behind')
    const refusedPeer = new AcpStdioClient(context)
    try {
      const refused = await refusedPeer.waitExitSoon()
      assert(refused.code === 3, `a disabled listener must refuse a new Adapter with exit 3 (got ${JSON.stringify(refused)})`)
      assert(/ACP_STDIO_LISTENER_DISABLED/u.test(refusedPeer.stderr),
        `a new client while disabled must report ACP_STDIO_LISTENER_DISABLED: ${refusedPeer.stderr}`)
      assert(refusedPeer.rawStdout().length === 0, 'a refused ACP client wrote human text on stdout')
    } finally {
      refusedPeer.kill()
    }
    trace('acp-cli-disabled', { hostPid, instance: instanceId.slice(0, 8), peerExit: peerExit.code, socket: 'retired' })

    // ── S07: status is the truthful read; no private material is printed ──
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=disabled', 'acp status after disable')
    for (const output of [
      disabledStatus.stdout, disabledStatus.stderr,
      (await runCli(installation, ['acp', 'status'])).stderr,
    ]) {
      assert(!output.includes(socketPath), 'acp status leaked the private ACP socket path')
      assert(!/https?:\/\//u.test(output), 'acp status leaked a Host URL')
      assert(!/token=|cookie/iu.test(output), 'acp status leaked credential material')
    }

    // ── S08: re-enable; the SAME Host serves a fresh real client ───────────
    assertExactLine(await runCli(installation, ['acp', 'enable']), 'acp=enabled', 'acp re-enable')
    assert(existsSync(socketPath), 'acp re-enable did not rebind the ACP socket')
    const freshPeer = new AcpStdioClient(context)
    const freshInit = await freshPeer.initialize()
    assert(freshInit?.protocolVersion === 1, 'the fresh public acp stdio client did not initialize')
    const freshExit = await freshPeer.close()
    assert(freshExit.code === 0, `a clean fresh connection must exit 0 (got ${JSON.stringify(freshExit)})`)
    const afterReenable = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(afterReenable.host === 'ready' && afterReenable.pid === String(hostPid) && afterReenable.instance === instanceId.slice(0, 8),
      `acp re-enable changed the Host identity: ${JSON.stringify(afterReenable)}`)
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=enabled', 'acp status after re-enable')

    // ── S09/S10: the Owner-only route's real admission/shape negatives ─────
    const anonymous = await requestFresh(`${record.origin}${CONTROL_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 1, instanceId, op: 'disable' }),
    }, 'ACP CLI')
    assert([401, 403].includes(anonymous.status), `an anonymous ACP control POST was not refused: HTTP ${String(anonymous.status)}`)
    await assertSanitized(anonymous, 'anonymous ACP control POST')
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=enabled', 'acp status after anonymous POST')

    const cookie = ownerCookie
    const authenticated = async (body, method = 'POST', label = 'authenticated ACP control') => {
      const response = await requestFresh(`${record.origin}${CONTROL_ROUTE}`, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        ...(method === 'POST' ? { body } : {}),
      }, 'ACP CLI')
      await assertSanitized(response, label)
      return response
    }
    const wrongInstance = await authenticated(JSON.stringify({ schema: 1, instanceId: '22222222-2222-4222-8222-222222222222', op: 'disable' }), 'POST', 'wrong-instance POST')
    assert(wrongInstance.status === 409, `a foreign-instance POST returned HTTP ${String(wrongInstance.status)}`)
    const unknownOp = await authenticated(JSON.stringify({ schema: 1, instanceId, op: 'destroy' }), 'POST', 'unknown-op POST')
    assert(unknownOp.status === 400, `an unknown-op POST returned HTTP ${String(unknownOp.status)}`)
    const extraField = await authenticated(JSON.stringify({ schema: 1, instanceId, op: 'disable', extra: true }), 'POST', 'extra-field POST')
    assert(extraField.status === 400, `an extra-field POST returned HTTP ${String(extraField.status)}`)
    const oversize = await authenticated(JSON.stringify({ schema: 1, instanceId, op: 'disable', padding: 'x'.repeat(600) }), 'POST', 'oversize POST')
    assert(oversize.status === 400, `an oversize POST returned HTTP ${String(oversize.status)}`)
    // The route owns exactly POST (`methods: ['POST']`). The official
    // Connection contract says a method the route does not own "continue[s]
    // through normal shared-channel dispatch", so an authenticated GET is the
    // deterministic 404 here; the handler's own fixed 405 branch is covered by
    // the route unit lane (the official registry cannot express PUT/DELETE).
    const wrongMethod = await authenticated(undefined, 'GET', 'GET ACP control')
    assert(wrongMethod.status === 404, `a GET on the ACP control route returned HTTP ${String(wrongMethod.status)}, expected the official dispatcher's 404`)
    // The strict refusals provably dispatched no Controller write.
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=enabled', 'acp status after strict refusals')
    assert(scopeDirectories(dshHome).length === 1, `the Host published ${String(scopeDirectories(dshHome).length)} ACP scopes`)
    trace('acp-cli-route-negatives', { anonymous: anonymous.status, wrongInstance: wrongInstance.status, unknownOp: unknownOp.status, extraField: extraField.status, oversize: oversize.status, wrongMethod: wrongMethod.status })

    // ── S11: a REAL second canonical Profile stays independent ────────────
    // A management command for one Profile must only reach its own Host. B
    // gets its own installed package, Host and ACP scope; B enables/disables
    // only its own listener while THIS Host keeps its identity and enabled
    // state. (An uninstalled profile name cannot be exercised: official DSH
    // refuses to boot a profile that does not exist.)
    seedProfileBuildPolicy(dshHome, PEER_PROFILE)
    const peerInstall = await runRawCli(installation, ['plugin', '--profile', PEER_PROFILE, 'add', tarball])
    assert(peerInstall.status === 0,
      `installing the second Profile failed: ${String(peerInstall.stderr ?? '').slice(-800)}`)
    const peerStart = await runCli(installation, ['daemon', 'start'], {}, PEER_PROFILE)
    assertExit(peerStart, 0, 'peer Profile daemon start')
    peerStarted = true
    const peerFields = statusFields(peerStart)
    assert(peerFields.host === 'ready', `the second Profile Host is not ready: ${JSON.stringify(peerFields)}`)
    const peerRecord = recordForProfile(dshHome, PEER_PROFILE)
    recordHostIdentity(context, peerRecord)
    const peerInstance = peerRecord.instanceId
    const peerPid = peerRecord.hostPid
    const peerSocketPath = publicAcpSocketPath(dshHome, peerRecord.scopeId)
    assert(peerSocketPath !== socketPath, 'both Profiles resolved the SAME ACP endpoint')
    assertExactLine(await runCli(installation, ['acp', 'status'], {}, PEER_PROFILE), 'acp=disabled', 'peer Profile acp status')
    assertExactLine(await runCli(installation, ['acp', 'enable'], {}, PEER_PROFILE), 'acp=enabled', 'peer Profile acp enable')
    assert(existsSync(peerSocketPath), 'the peer Profile enable did not bind its own ACP socket')
    assert(existsSync(socketPath), 'enabling the peer Profile retired THIS Profile socket')
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=enabled', 'THIS Profile acp status after peer enable')
    assertExactLine(await runCli(installation, ['acp', 'disable'], {}, PEER_PROFILE), 'acp=disabled', 'peer Profile acp disable')
    assert(!existsSync(peerSocketPath), 'the peer Profile disable left its ACP socket behind')
    assertExactLine(await runCli(installation, ['acp', 'status']), 'acp=enabled', 'THIS Profile acp status after peer disable')
    const peerStatusBeforeStop = statusFields(await runCli(installation, ['daemon', 'status'], {}, PEER_PROFILE))
    assert(peerStatusBeforeStop.host === 'ready' && peerStatusBeforeStop.pid === String(peerPid) && peerStatusBeforeStop.instance === peerInstance.slice(0, 8),
      `the peer Profile Host identity was replaced: ${JSON.stringify(peerStatusBeforeStop)}`)
    assertExit(await runCli(installation, ['daemon', 'stop'], {}, PEER_PROFILE), 0, 'peer Profile daemon stop')
    peerStarted = false
    const afterPeerStop = statusFields(await runCli(installation, ['daemon', 'status']))
    assert(afterPeerStop.host === 'ready' && afterPeerStop.pid === String(hostPid) && afterPeerStop.instance === instanceId.slice(0, 8)
      && afterPeerStop.acp === 'enabled',
    `stopping the peer Profile changed THIS Host: ${JSON.stringify(afterPeerStop)}`)
    assert(publishedRecords(dshHome).length === 1, 'the peer Profile Host record survived its own stop')
    trace('acp-cli-cross-profile', { peerInstance: peerInstance.slice(0, 8), peerPid, peerProfile: PEER_PROFILE, thisHostUnchanged: true })

    // ── S12 boundary + stop: the same clean missing-Host refusal ──────────
    // A lost/replaced write reply is deliberately NOT reproduced against this
    // shared Host: the exact ACP_OUTCOME_UNCONFIRMED decision is proven by the
    // CLI unit lane (test/app/local-acp-control.test.ts) with a real loopback
    // server, never by guessing from this real run.
    trace('acp-cli-s12-boundary', { scene: 'S12', source: 'test/app/local-acp-control.test.ts', hostKilled: false })
    const stopped = await runCli(installation, ['daemon', 'stop'])
    assertExit(stopped, 0, 'daemon stop')
    hostStarted = false
    const afterStopStatus = await runCli(installation, ['acp', 'status'])
    assertExit(afterStopStatus, 3, 'acp status after Host stop')
    assert(afterStopStatus.stdout === '', 'acp status after Host stop must print nothing on stdout')
    assert(/^dsh-pi-tui acp: HOST_NOT_RUNNING: /u.test(afterStopStatus.stderr), 'acp status after Host stop did not report HOST_NOT_RUNNING')
    const afterStopEnable = await runCli(installation, ['acp', 'enable'])
    assertExit(afterStopEnable, 3, 'acp enable after Host stop')
    assert(afterStopEnable.stdout === '', 'acp enable after Host stop must print nothing on stdout')

    // The authenticated Cookie never appears in any public CLI output.
    const publicOutputs = [
      disabledStatus.stdout, disabledStatus.stderr, started.stdout, started.stderr,
      stopped.stdout, stopped.stderr, afterStopStatus.stderr, afterStopEnable.stderr,
    ]
    for (const output of publicOutputs) {
      assert(!output.includes(cookie), 'the Owner Cookie leaked into a public CLI output')
    }
  } catch (error) {
    result.status = 'FAILED'
    result.headlessCli = 'FAILED'
    throw error
  } finally {
    try { peer?.kill() } catch { /* already gone */ }
    if (peerStarted) {
      try { await runCli(installation, ['daemon', 'stop'], {}, PEER_PROFILE) } catch { /* global cleanup owns the isolated home */ }
    }
    if (hostStarted) {
      try { await runCli(installation, ['daemon', 'stop']) } catch { /* global cleanup owns the isolated home */ }
    }
  }
  return result
}
