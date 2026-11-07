/**
 * The authenticated Host/Client lifecycle chain (T08, T01/T21, T09Q, T02-T27,
 * T05, T10-T17, T07, T15, T19, T20).
 *
 * ONE case because every step consumes the real launch/registry/Host restart
 * state the previous step produced: sixteen concurrent Host launches must leave
 * exactly one seat owner, that winner's published material is authenticated
 * against the real HTTP/WebSocket/Workspace owners, the Client lifecycle
 * mutations prove the Host survives them, and the stale-registry/zombie and
 * signal-admission controls reuse the same isolated kernel seats. Splitting it
 * would turn one causal chain into unrelated mocks.
 *
 * @module split-process/authenticated-lifecycle
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  alive,
  assertClientHostFacts,
  assertIdentityFields,
  chunk,
  clientStatus,
  connectCookie,
  expectFailureRecord,
  fetchStatus,
  hostStatus,
  killTracked,
  modeOf,
  productionBuildId,
  readJson,
  readProcState,
  readStartIdentity,
  restoreFile,
  saveFile,
  seatFree,
  seatIsFree,
  waitForAnyReady,
  waitForOutcome,
  waitGone,
} from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError, SplitSmokeWaitError } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Every bounded log file this lane tolerates for one spawned Host. */
const HOST_LOG_LIMIT = 2 * 1024 * 1024

/** One raw HTTP GET that keeps a forged Host/Origin header exactly as given. */
function rawGet(origin, path, headers = {}) {
  const url = new URL(path, origin)
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { connection: 'close', ...headers },
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body,
      }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error('raw HTTP timeout')))
    request.on('error', reject)
    request.end()
  })
}

/** Open or refuse one raw mux WebSocket with the Cookie header. */
function muxAttempt(url, cookie, WebSocket) {
  return new Promise((resolveAttempt, reject) => {
    const socket = new WebSocket(url, { headers: { Cookie: cookie } })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveAttempt({ socket, ...value })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.terminate() } catch { /* already closed */ }
      reject(new Error('mux attempt timed out'))
    }, 10_000)
    socket.once('open', () => finish({ opened: true }))
    socket.once('unexpected-response', (request, response) => {
      request.destroy()
      try { socket.terminate() } catch { /* already closed */ }
      finish({ opened: false, status: response.statusCode })
    })
    socket.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

function closeMux(socket, WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise(resolveClose => {
    socket.once('close', () => resolveClose())
    try { socket.close(1000) } catch { resolveClose() }
  })
}

function assertNoSecret(label, text, secrets) {
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    assert(!text.includes(secret), `${label} leaked an authenticated-link secret`)
  }
}

function writeRawPrivate(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** One qualification request id sequence for this case's own probe waits. */
let statusSequence = 0

/** Leave one real killed child unreaped by its shell parent; return its PID. */
async function makeZombie(trackDetached) {
  const holder = spawn('sh', ['-c', 'sleep 60 & echo $!; exec sleep 60'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  holder.unref()
  const pid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the zombie holder did not print a child pid')), 5_000)
    holder.stdout.once('data', chunk => {
      clearTimeout(timer)
      const value = Number(chunk.toString('utf8').split('\n')[0].trim())
      if (!Number.isInteger(value) || value <= 0) reject(new Error(`bad zombie child pid: ${String(value)}`))
      else resolve(value)
    })
  })
  const starttime = readStartIdentity(pid)
  assert(starttime !== undefined, 'the zombie child has no starttime')
  const holderStarttime = readStartIdentity(holder.pid)
  if (holderStarttime !== undefined) trackDetached(holder.pid, holderStarttime)
  process.kill(pid, 'SIGKILL')
  let state
  for (let attempt = 0; attempt < 250; attempt += 1) {
    state = readProcState(pid)
    if (state === 'Z') break
    await sleep(20)
  }
  assert(state === 'Z', 'the killed child did not become a real OS zombie')
  return { pid, starttime }
}

/**
 * The whole authenticated-link chain on ONE isolated installation.
 *
 * The case owns every Host/Client it starts; the last section reports the
 * detached PIDs it created to the runner's abort backstop, and its own
 * `finally` kills whatever is still tracked even when an assertion throws.
 */
export async function runAuthenticatedLifecycle(context) {
  const { installation, EntryProcess, entries, base, workDir, dshHome, profilePackage, trace, failpoint, trackDetachedPid } = context
  const { home, profileDir } = installation
  const WebSocket = createRequire(join(profilePackage, 'package.json'))('ws')
  const hostFoundationBarrier = join(workDir, 'host-foundation-watch-barrier')
  const probeClientBase = {
    ...base,
    env: { ...base.env, SPLIT_PROCESS_HOST_FOUNDATION_BARRIER: hostFoundationBarrier },
  }
  /** Detached processes THIS case spawned; the runner gets the same facts. */
  const detachedProcesses = new Map()
  const trackDetached = (pid, starttime) => {
    detachedProcesses.set(pid, starttime)
    trackDetachedPid(pid, starttime)
  }
  try {

    // T08: sixteen concurrent Host launch/ensure candidates. The kernel seat is
    // the ONLY winner; every loser exits before creating a Host Context.
    const race = Array.from({ length: 16 }, () => new EntryProcess('host', entries.host, base))
    trace('race', { contenders: race.length })
    const winner = await waitForAnyReady(race, 'T08 16-host race', 180_000)
    const losers = race.filter(candidate => candidate !== winner.process)
    await Promise.all(losers.map(candidate => candidate.waitForExit(60_000)))
    for (const loser of losers) {
      const conflict = loser.records.find(record => record.m4a0 === 'host-seat-conflict')
      assert(conflict?.error === 'HOST_ALREADY_OWNED', `T08 loser did not report HOST_ALREADY_OWNED: ${JSON.stringify(loser.records.slice(-2))}`)
      assert(loser.exitResult?.code === 0, `T08 loser exit was ${JSON.stringify(loser.exitResult)}`)
    }
    assert(race.filter(candidate => candidate.records.some(record => record.m4a0 === 'ready')).length === 1, 'T08 produced more than one ready Host')
    const mainHost = winner.process
    const hostReady = winner.record
    trace('race-winner', {
      contenders: race.length,
      winnerPid: hostReady.pid,
      winnerInstanceId: hostReady.localHost?.instanceId,
      loserConflicts: losers.length,
    })

    // T01: Host-only composition and the official Connection owners.
    assert(hostReady.processRole === 'host', 'T01 host role mismatch')
    assert(typeof hostReady.pid === 'number' && hostReady.pid > 0, 'T01 host PID missing')
    assert(/^\d+$/u.test(hostReady.processStartIdentity ?? ''), 'T01 host starttime missing')
    assert(typeof hostReady.rootFiberUid === 'number', 'T01 host root fiber identity missing')
    assert(hostReady.transport === 'listening', 'T01 host transport is not listening')
    assert(hostReady.sessionOpen === false, 'T01 host must not claim an open Session')
    assert(hostReady.ownerEntries?.connection?.length === 1 && hostReady.ownerEntries.connection[0] === 'split-host-connection', 'T01 connection owner mismatch')
    assert(hostReady.ownerEntries?.apiRemotes?.length === 1 && hostReady.ownerEntries.apiRemotes[0] === 'split-host-api-remotes', 'T01 api-remotes owner mismatch')
    assert(hostReady.ownerEntries?.typertGateway?.length === 1 && hostReady.ownerEntries.typertGateway[0] === 'typert-gateway', 'T01 gateway owner mismatch')
    for (const owner of ['agents', 'sessions', 'jobController']) {
      assert(hostReady.ownerEntries[owner]?.length === 1, `T01 expected exactly one ${owner} owner`)
    }
    assert(hostReady.forbiddenActive?.length === 0, 'T01 forbidden TUI/Client rows are active')
    for (const id of ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins']) {
      assert(hostReady.entries?.find(entry => entry.id === id)?.state === 'absent', `T01 ${id} is not absent`)
    }
    assert(Object.values(hostReady.services ?? {}).every(Boolean), 'T01 not all Host prerequisites reported present')
    // Host liveness: the ready record and every later status carry one fresh
    // read-only snapshot. The Host-only profile mounts the ONE official
    // Schedule row (S5-PR4), so a healthy idle Host reports it as IDLE — never
    // ABSENT — and must not claim quiescence while rc.4's pending-interaction
    // and in-flight-write gaps remain unobservable.
    const startupLiveness = hostReady.liveness
    assert(startupLiveness !== undefined, 'T01 the Host ready record carries no liveness snapshot')
    assert(['BLOCKED', 'UNKNOWN', 'OBSERVED_QUIESCENT'].includes(startupLiveness.verdict), `T01 invalid liveness verdict ${JSON.stringify(startupLiveness.verdict)}`)
    for (const source of ['agent', 'jobs', 'goal', 'schedule', 'pending', 'write', 'other']) {
      assert(['ACTIVE', 'IDLE', 'ABSENT', 'UNKNOWN'].includes(startupLiveness.sourceStates?.[source]), `T01 liveness source ${source} missing or invalid: ${JSON.stringify(startupLiveness.sourceStates)}`)
    }
    assert(startupLiveness.sourceStates.schedule === 'IDLE', 'T01 the Host-only profile mounts the Schedule row, so an idle Host reports IDLE')
    assert(startupLiveness.verdict !== 'OBSERVED_QUIESCENT', 'T01 the stock Host cannot prove quiescence with rc.4 pending/write gaps')
    assert(startupLiveness.reasons.includes('pending-interaction-unobservable'), 'T01 the pending-interaction gap is not reported')
    assert(startupLiveness.reasons.includes('inflight-write-unproven'), 'T01 the in-flight-write gap is not reported')
    const startupStatus = await hostStatus(mainHost)
    assert(startupStatus.liveness !== undefined, 'T01 a Host status request carries no liveness snapshot')
    assert(startupStatus.liveness.epoch >= startupLiveness.epoch, 'T01 the liveness epoch moved backwards')
    for (const service of [
      'sessionController',
      'fileUploads',
      'settingsController',
      // M5-WS1: the Host Workspace Remote owner and the durable registry must
      // both be live services. The `ready` record is only produced after the
      // collector asserted the `workspaceController/workspace` Typert binding,
      // so a readable service can never stand in for that binding.
      'workspaceController',
      'workspaceRegistry',
      'piTuiFileReferences',
      'piTuiTerminalProgress',
      'piTuiHostReady',
      'piTuiPerformanceReady',
    ]) {
      assert(hostReady.services?.[service] === true, `T21 ${service} is not reported live`)
    }
    assert(hostReady.terminalProgressWatches === 0, 'T21 the Host must start with no terminal-progress watchers')
    assert(hostReady.webServer?.host === '127.0.0.1' && hostReady.webServer.port > 0, 'T01 loopback webserver not ready')
    assert(hostReady.entries.filter(entry => entry.name === '@deepseek-ai/dsh-client-connection').length === 1, 'T01 duplicate Connection row')
    assert(hostReady.entries.filter(entry => entry.name === '@deepseek-ai/dsh-api-remotes').length === 1, 'T01 duplicate api-remotes row')
    assert(hostReady.entries.filter(entry => entry.id === 'typert-gateway').length === 1, 'T01 duplicate gateway row')

    // T21: the six official Session-serving rows and the ONE built-in PiTui
    // Host Runtime row are all ACTIVE; pre-existing owners stay exactly one.
    const t21Rows = {
      fileUpload: 'split-host-file-upload',
      sessionStats: 'split-host-session-stats',
      turnOutline: 'split-host-turn-outline',
      sessionController: 'split-host-session-controller',
      settingsController: 'split-host-settings-controller',
      sessionLogExport: 'split-host-session-log-download',
      piTuiHostRuntime: 'split-host-pi-tui-runtime',
    }
    for (const [owner, id] of Object.entries(t21Rows)) {
      const owners = hostReady.ownerEntries?.[owner]
      assert(Array.isArray(owners) && owners.length === 1 && owners[0] === id,
        `T21 ${owner} owner mismatch: ${JSON.stringify(owners)}`)
      assert(
        hostReady.entries.filter(entry => entry.id === id && entry.state === 'active').length === 1,
        `T21 ${id} is not exactly one active row`,
      )
    }
    assert(
      hostReady.entries.filter(entry => entry.name === '@xmoon76/dsh-pi-tui/host-runtime').length === 1,
      'T21 duplicate built-in Host Runtime row',
    )
    assert(
      hostReady.entries.filter(entry => entry.name === '@xmoon76/dsh-pi-tui/performance-host').length === 1,
      'T21 Performance row missing or duplicated',
    )
    assert(
      hostReady.entries.filter(entry => entry.name === '@xmoon76/dsh-pi-tui/visual-tools').length === 1,
      'T21 Visual Tools row missing or duplicated',
    )
    assert(
      JSON.stringify(hostReady.ownerEntries?.performance) === JSON.stringify(['pi-tui-performance-host']),
      'T21 Performance owner mismatch',
    )
    assert(
      JSON.stringify(hostReady.ownerEntries?.visualTools) === JSON.stringify(['pi-tui-visual-tools']),
      'T21 Visual Tools owner mismatch',
    )
    // T21/M5-WS1: the ONE official Workspace registry row and the ONE official
    // Workspace Controller row, each ACTIVE exactly once under its stable id,
    // with no `split-host-workspace-controller` competitor.
    assert(
      JSON.stringify(hostReady.ownerEntries?.workspaceRegistry) === JSON.stringify(['workspace']),
      `T21 Workspace registry owner mismatch: ${JSON.stringify(hostReady.ownerEntries?.workspaceRegistry)}`,
    )
    assert(
      JSON.stringify(hostReady.ownerEntries?.workspaceController) === JSON.stringify(['workspace-controller']),
      `T21 Workspace Controller owner mismatch: ${JSON.stringify(hostReady.ownerEntries?.workspaceController)}`,
    )
    for (const [id, name] of [
      ['workspace', '@deepseek-ai/dsh-workspace'],
      ['workspace-controller', '@deepseek-ai/dsh-api-workspace-controller'],
    ]) {
      const activeRows = hostReady.entries.filter(entry => entry.name === name && entry.state === 'active')
      assert(activeRows.length === 1 && activeRows[0].id === id,
        `T21 expected exactly one ACTIVE ${name} row named "${id}": ${JSON.stringify(activeRows)}`)
    }
    assert(
      hostReady.entries.filter(entry => String(entry.id).startsWith('split-host-workspace')).length === 0,
      'T21 a split-host Workspace Controller row exists beside the official one',
    )
    trace('t21', {
      officialSessionServingRows: 6,
      builtInHostRuntimeRows: 1,
      performanceOwners: hostReady.ownerEntries.performance,
      visualToolOwners: hostReady.ownerEntries.visualTools,
      workspaceOwners: hostReady.ownerEntries.workspaceController,
      terminalProgressWatches: hostReady.terminalProgressWatches,
    })
    const origin = hostReady.localHost.origin
    const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', hostReady.localHost.scopeId)
    const registryPath = join(scopeDir, 'instance.json')
    const launchPath = join(scopeDir, 'launch.json')
    assert(modeOf(scopeDir) === 0o700, 'T01 scope directory is not 0700')
    assert(modeOf(registryPath) === 0o600, 'T01 registry is not 0600')
    assert(modeOf(launchPath) === 0o600, 'T01 launch material is not 0600')
    const registry = readJson(registryPath)
    const launch = readJson(launchPath)
    assertIdentityFields(registry, hostReady.localHost, 'T01 registry')
    assert(registry.profileRealpath === realpathSync(profileDir), 'T01 registry profile path is not canonical')
    assert(launch.schema === 1 && launch.instanceId === registry.instanceId, 'T01 launch material does not name the Host instance')
    const launchUrl = new URL(launch.connectUrl)
    const hostToken = launchUrl.searchParams.get('token')
    assert(hostToken !== null && hostToken !== '', 'T01 launch URL has no Host token')
    assert(launchUrl.origin === origin && launchUrl.pathname === '/connect', 'T01 launch URL is not the Host /connect authority')
    assert(!JSON.stringify(registry).includes(hostToken), 'T01 registry leaked the launch token')
    assert(!('connectUrl' in registry) && !('cookie' in registry) && !('token' in registry), 'T01 registry carries secret material')
    trace('host-ready', {
      pid: hostReady.pid,
      starttime: hostReady.processStartIdentity,
      instanceId: hostReady.localHost.instanceId,
      origin,
      scopeId: hostReady.localHost.scopeId,
      buildId: hostReady.localHost.buildId,
      connectionOwners: hostReady.ownerEntries.connection,
      apiRemotesOwners: hostReady.ownerEntries.apiRemotes,
      gatewayOwners: hostReady.ownerEntries.typertGateway,
    })

    // The Host must never treat SPLIT_PROCESS_SCRATCH as deletion
    // authority. A second Host whose env names the live Host's own scratch or
    // a scope-outside host-scratch-* directory must exit on the seat conflict
    // without deleting either.
    const scopeScratchDirs = () => readdirSync(scopeDir).filter(name => name.startsWith('host-scratch-'))
    assert(scopeScratchDirs().length === 1, `the 16-host winner must own exactly one scope scratch, found ${String(scopeScratchDirs().length)}`)
    const mainScratch = join(scopeDir, scopeScratchDirs()[0])
    const outsideScratch = join(workDir, 'host-scratch-outside')
    mkdirSync(outsideScratch, { mode: 0o700 })
    for (const target of [mainScratch, outsideScratch]) {
      const foreign = new EntryProcess('host', entries.host, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_SCRATCH: target },
      })
      const conflict = await foreign.waitFor(record => record.m4a0 === 'host-seat-conflict', 'foreign scratch Host seat conflict', 60_000)
      assert(foreign.effectiveScratch === target, `the foreign Host did not receive the scratch it was launched with: ${target} != ${foreign.effectiveScratch}`)
      assert(conflict.error === 'HOST_ALREADY_OWNED', `the foreign scratch conflict code was ${JSON.stringify(conflict.error)}`)
      const foreignExit = await foreign.waitForExit(30_000)
      assert(foreignExit.code === 0, `the foreign scratch Host exit was ${JSON.stringify(foreignExit)}`)
    }
    assert(existsSync(mainScratch), 'a live Host scratch was deleted through SPLIT_PROCESS_SCRATCH')
    assert(existsSync(outsideScratch), 'a scope-outside directory was deleted through SPLIT_PROCESS_SCRATCH')
    trace('t08-scratch', { winnerScratch: 1, liveHostScratchKept: true, outsideKept: true, foreignScratchTargets: 2 })

    // T09Q: two QUALIFICATION Clients race for the one qualification-only
    // kernel Client seat. Only the winner may create a Client Context or reach
    // the Host. This is the frozen qualification negative control; the real
    // `surface` mode holds no such seat (its concurrent positive is T09).
    const clients = [
      new EntryProcess('client', entries.client, probeClientBase),
      new EntryProcess('client', entries.client, probeClientBase),
    ]
    const clientOutcomes = await Promise.all(clients.map((client, index) => waitForOutcome(client, `T09Q client ${String(index)}`)))
    const clientWinners = clients.filter(client => client.records.some(record => record.m4a0 === 'ready'))
    assert(clientWinners.length === 1,
      `T09Q expected one active qualification Client, got ${String(clientWinners.length)};`
      + ` outcomes=${JSON.stringify(clientOutcomes)};`
      + ` records=${JSON.stringify(clients.map(client => client.records.slice(-4)))};`
      + ` stderr=${JSON.stringify(clients.map(client => client.stderr.slice(-1200)))}`)
    const c1 = clientWinners[0]
    const c1Ready = clientOutcomes[clients.indexOf(c1)]
    assert(c1Ready.m4a0 === 'ready', 'T09Q winning qualification Client did not become ready')
    const clientLoser = clients.find(client => client !== c1)
    expectFailureRecord(clientLoser, 'T09Q loser', 'CLIENT_ALREADY_ACTIVE')
    const loserExit = await clientLoser.waitForExit(30_000)
    assert(loserExit.code === 1, `T09Q losing qualification Client exit was ${JSON.stringify(loserExit)}`)
    trace('t09-qualification', {
      activeQualificationClientPid: c1Ready.pid,
      refusedQualificationClientPid: clientLoser.child.pid,
      refusalCode: 'CLIENT_ALREADY_ACTIVE',
    })

    // T02: real authenticated HTTP + one real WebSocket generation.
    assert(c1Ready.processRole === 'client', 'T02 client role mismatch')
    assert(c1Ready.pid !== hostReady.pid, 'T02 Host and Client must be distinct PIDs')
    assert(c1Ready.transport === 'connected', `T02 client transport is ${JSON.stringify(c1Ready.transport)}`)
    assert(c1Ready.sessionOpen === false, 'T02 client must not claim a Session')
    assert(Number.isSafeInteger(c1Ready.generationId) && c1Ready.generationId > 0, 'T02 client has no real generation')
    assert(c1Ready.hostHome === home, `T02 client host home is ${JSON.stringify(c1Ready.hostHome)}`)
    assert(c1Ready.rootFiberUid !== undefined, 'T02 client root fiber identity missing')
    assert(c1Ready.activeWrappers === 1, `T02 client active wrapper baseline is ${String(c1Ready.activeWrappers)}`)
    assert(c1Ready.liveSockets === 1, `T02 client live socket baseline is ${String(c1Ready.liveSockets)}`)
    assertClientHostFacts(c1Ready.host, hostReady.localHost, 'T02')
    assert(!Object.hasOwn(c1Ready.host, 'profileRealpath'), 'T02 client status leaked the profile path')
    trace('client-ready', {
      pid: c1Ready.pid,
      generationId: c1Ready.generationId,
      hostPid: c1Ready.host.hostPid,
      hostInstanceId: c1Ready.host.instanceId,
      hostHome: c1Ready.hostHome,
    })

    // T03/T04/T06: the official admission/authentication fence.
    const noToken = await rawGet(origin, '/connect')
    assert(noToken.status === 401, `T03 no-token /connect returned ${String(noToken.status)}`)
    assert((noToken.headers['set-cookie'] ?? []).length === 0, 'T03 no-token /connect minted a Cookie')
    const wrongToken = await rawGet(origin, '/connect?token=deadbeef&interactions=answer')
    assert(wrongToken.status === 401, `T04 wrong-token /connect returned ${String(wrongToken.status)}`)
    const fakeCookie = await fetchStatus(`${origin}/api/pi-tui.local-host`, { headers: { cookie: 'dsh_session=deadbeef' } })
    assert(fakeCookie.status === 401, `T04 fake Cookie returned ${String(fakeCookie.status)}`)
    const wrongHost = await rawGet(origin, '/api/pi-tui.local-host', { host: 'evil.example' })
    assert(wrongHost.status === 403, `T04 wrong Host authority returned ${String(wrongHost.status)}`)
    const wrongOrigin = await fetchStatus(`${origin}/api/pi-tui.local-host`, { headers: { origin: 'http://evil.example' } })
    assert(wrongOrigin.status === 403, `T04 wrong Origin returned ${String(wrongOrigin.status)}`)
    const unauthenticatedIdentity = await fetchStatus(`${origin}/api/pi-tui.local-host`)
    assert([401, 403].includes(unauthenticatedIdentity.status), `T06 unauthenticated identity returned ${String(unauthenticatedIdentity.status)}`)
    assert(!unauthenticatedIdentity.body.includes(hostReady.localHost.instanceId), 'T06 unauthenticated identity leaked the instance id')
    const validCookie = await connectCookie(origin, launch)
    const identityResponse = await fetchStatus(`${origin}/api/pi-tui.local-host`, { headers: { cookie: validCookie } })
    assert(identityResponse.status === 200, `T02 authenticated identity returned ${String(identityResponse.status)}`)
    assert(/application\/json\b/iu.test(String(identityResponse.headers.get('content-type'))), 'T02 identity response is not JSON')
    assert(/\bno-store\b/iu.test(String(identityResponse.headers.get('cache-control'))), 'T02 identity response is not no-store')
    const authenticatedIdentity = JSON.parse(identityResponse.body)
    assertIdentityFields(authenticatedIdentity, registry, 'T02 authenticated identity')
    trace('auth-audit', {
      noToken: noToken.status,
      wrongToken: wrongToken.status,
      fakeCookie: fakeCookie.status,
      wrongHost: wrongHost.status,
      wrongOrigin: wrongOrigin.status,
      unauthenticatedIdentity: unauthenticatedIdentity.status,
      authenticatedIdentity: identityResponse.status,
      generationId: c1Ready.generationId,
    })

    // T06/WS1-06: the SAME admission fence must cover the Workspace Remote
    // namespace, not just the identity route. Each refusal below is decided by
    // the Connection/Gateway admission BEFORE any business dispatch, and the
    // authenticated owner request to that exact route must reach the `workspace`
    // namespace — proven by the namespace's OWN refusal of a relative path
    // (which also means this control mutates no Host Workspace).
    const workspaceRemoteRequest = headers => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'ws1-workspace-admission',
        method: 'workspace/create',
        payload: { args: { request: { path: 'ws1/relative-not-absolute' } } },
      }),
    })
    const workspaceRoute = `${origin}/api/workspace/create`
    const unauthenticatedWorkspace = await fetchStatus(workspaceRoute, workspaceRemoteRequest({}))
    assert([401, 403].includes(unauthenticatedWorkspace.status),
      `T06 unauthenticated workspace/create returned ${String(unauthenticatedWorkspace.status)}`)
    const fakeCookieWorkspace = await fetchStatus(workspaceRoute, workspaceRemoteRequest({ cookie: 'dsh_session=deadbeef' }))
    assert(fakeCookieWorkspace.status === 401, `T06 fake-Cookie workspace/create returned ${String(fakeCookieWorkspace.status)}`)
    const wrongOriginWorkspace = await fetchStatus(workspaceRoute, workspaceRemoteRequest({ origin: 'http://evil.example' }))
    assert(wrongOriginWorkspace.status === 403, `T06 wrong-Origin workspace/create returned ${String(wrongOriginWorkspace.status)}`)
    assert(!unauthenticatedWorkspace.body.includes('workspace/invalid-path')
      && !fakeCookieWorkspace.body.includes('workspace/invalid-path')
      && !wrongOriginWorkspace.body.includes('workspace/invalid-path'),
    'T06 a refused workspace/create reached the Workspace namespace instead of the admission fence')
    const ownerWorkspace = await fetchStatus(workspaceRoute, workspaceRemoteRequest({ cookie: validCookie }))
    assert(ownerWorkspace.status === 200, `T06 owner workspace/create returned ${String(ownerWorkspace.status)}`)
    const ownerWorkspaceEnvelope = JSON.parse(ownerWorkspace.body)
    assert(ownerWorkspaceEnvelope.result?.ok === false,
      `T06 the owner workspace/create did not reach the Workspace namespace: ${ownerWorkspace.body.slice(0, 300)}`)
    assert(ownerWorkspaceEnvelope.result?.error?.code === 'workspace/invalid-path',
      `T06 the Workspace namespace did not report its own refusal: ${ownerWorkspace.body.slice(0, 300)}`)
    trace('workspace-admission', {
      unauthenticated: unauthenticatedWorkspace.status,
      fakeCookie: fakeCookieWorkspace.status,
      wrongOrigin: wrongOriginWorkspace.status,
      ownerReachedNamespace: ownerWorkspaceEnvelope.result.error.code,
    })
    assertNoSecret('Host stdout records', JSON.stringify(mainHost.records), [hostToken, validCookie])
    assertNoSecret('Host stderr', mainHost.stderr, [hostToken, validCookie])
    assertNoSecret('Client stdout records', JSON.stringify(c1.records), [hostToken, validCookie])
    assertNoSecret('Client stderr', c1.stderr, [hostToken, validCookie])

    // T22/T23/T24: run the real Host RPC proof on the SAME authenticated
    // Client Context. The probe mounts its three contributions temporarily and
    // unmounts them; no second Client/Connection/Gateway/Context is created.
    // Running it twice is also the T25 duplicate-registration check.
    //
    // T27: the probe also drives the official `workspace` Remote namespace. The
    // directory it registers is a real directory this harness creates inside
    // its OWN isolated work dir, and the Host — not the Client — canonicalizes
    // and records it.
    const probeWorkspacePath = join(workDir, 'workspace-probe-target')
    mkdirSync(probeWorkspacePath, { mode: 0o700 })
    const canonicalProbeWorkspacePath = realpathSync(probeWorkspacePath)

    /** Wait for the Host to report exactly `expected` live progress watchers. */
    const waitForHostWatchCount = async (expected, label, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs
      let status = await hostStatus(mainHost)
      while (status.terminalProgressWatches !== expected && Date.now() < deadline) {
        await sleep(25)
        status = await hostStatus(mainHost)
      }
      assert(
        status.terminalProgressWatches === expected,
        `${label}: expected ${String(expected)} Host terminal-progress watcher(s), got ${JSON.stringify(status.terminalProgressWatches)}`,
      )
      return status
    }
    const runHostFoundationProbe = async (client, label, probeOptions = {}) => {
      const requestId = `m4b2hf-${label}-${++statusSequence}`
      rmSync(hostFoundationBarrier, { force: true })
      // `workspaceResume` makes the probe hold its live Workspace stream and
      // drop the Client's physical carrier itself. The probe owns that window:
      // the entry's control channel is serialized, so no client status request
      // may be issued while the stream is held.
      client.send({
        op: 'qualification-host-foundation',
        requestId,
        workspacePath: probeWorkspacePath,
        ...probeOptions.resume === true ? { workspaceResume: true } : {},
      })
      // The probe holds the real Host watch open after its opening snapshot and
      // waits for the private barrier file, so the harness can observe the live
      // Host subscription (1) before releasing it and then observe 0.
      await client.waitFor(
        record => record.m4b2hf === 'host-rpc-watch-open' && record.requestId === requestId,
        `${label} watch open`,
        180_000,
      )
      const during = await waitForHostWatchCount(1, `${label} live watch`)
      trace('host-rpc-watch-open', {
        requestId,
        hostTerminalProgressWatches: during.terminalProgressWatches,
      })
      writeFileSync(hostFoundationBarrier, 'release\n', { mode: 0o600 })
      if (probeOptions.resume === true) {
        // WS1-05: the probe holds the LIVE Workspace stream, drops the Client's
        // physical carrier and waits for the replacement generation itself; the
        // harness only observes the hold record and then the finished proof.
        await client.waitFor(
          record => record.m4b2hf === 'workspace-hold-open' && record.requestId === requestId,
          `${label} workspace hold`,
          180_000,
        )
        trace('workspace-hold-open', { requestId })
      }
      // ONE waiter for both outcomes. A rejecting probe is reported on the
      // control channel as a single `control-failure`; racing two waiters would
      // keep the losing 20 ms poll interval and its deadline alive after the
      // proof had already arrived.
      const outcome = await client.waitFor(
        record => (record.m4b2hf === 'host-rpc-proof' && record.requestId === requestId)
          || record.m4a0 === 'control-failure',
        label,
        180_000,
      )
      if (outcome.m4a0 === 'control-failure') {
        trace('probe-control-failure', { label, error: String(outcome.error).slice(0, 400) })
        throw new Error(`${label}: the qualification probe failed: ${String(outcome.error)}`)
      }
      const proof = outcome
      const after = await waitForHostWatchCount(0, `${label} watch release`)
      return { proof, during, after }
    }
    const firstProbe = await runHostFoundationProbe(c1, 't22-24', { resume: true })
    const hostRpcProof = firstProbe.proof
    assert(hostRpcProof.hostPid === hostReady.pid, 'T22 probe Host PID mismatch')
    assert(hostRpcProof.hostInstanceId === hostReady.localHost.instanceId, 'T22 probe Host instance mismatch')
    assert(hostRpcProof.clientPid === c1Ready.pid, 'T22 probe Client PID mismatch')
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
      assert(hostRpcProof[field] === true, `T22/T23/T24/T25 ${field} is not proven`)
    }
    // T27: the official `workspace` namespace created a REAL Host Workspace.
    for (const field of ['workspaceRemote', 'workspaceBaseline', 'workspaceIdempotent']) {
      assert(hostRpcProof[field] === true, `T27 ${field} is not proven`)
    }
    assert(hostRpcProof.workspaceCreated === true, 'T27 the first probe must CREATE the Host Workspace')
    assert(hostRpcProof.workspaceInBaseline === false,
      'T27 a Workspace created after the baseline cannot already be in that baseline')
    assert(hostRpcProof.workspaceUpsert === true,
      'T27 the Host feed must publish the new Workspace as an upsert frame')
    assert(typeof hostRpcProof.workspaceId === 'string' && hostRpcProof.workspaceId !== '',
      'T27 the Host did not assign a Workspace identity')
    assert(hostRpcProof.workspacePath === canonicalProbeWorkspacePath,
      `T27 workspace/create returned a non-canonical Host path: ${JSON.stringify(hostRpcProof.workspacePath)} != ${canonicalProbeWorkspacePath}`)
    // WS1-05 generation currentness: a LIVE iterator held across a physical
    // carrier replacement observed the new generation, terminated WITHOUT
    // writing a stale frame into it, and a NEW stream on the same Client then
    // recovered the authoritative Host baseline.
    assert(hostRpcProof.workspaceGenerationAdvanced === true,
      'WS1-05 the held Workspace stream did not observe a replacement Connection generation')
    assert(hostRpcProof.workspaceHeldStreamClosed === true,
      'WS1-05 the held Workspace stream neither ended nor failed after its generation was replaced')
    assert(hostRpcProof.workspaceRestoredBaseline === true,
      'WS1-05 a NEW stream did not recover the authoritative Host baseline after the replacement')
    const workspaceId = hostRpcProof.workspaceId
    const repeatedProbe = await runHostFoundationProbe(c1, 't25-repeat')
    const repeatedProof = repeatedProbe.proof
    assert(repeatedProof.hostPid === hostReady.pid, 'T25 repeat probe Host PID mismatch')
    assert(repeatedProof.hostInstanceId === hostReady.localHost.instanceId, 'T25 repeat probe Host instance mismatch')
    assert(repeatedProof.clientPid === c1Ready.pid, 'T25 repeat probe Client PID mismatch')
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
      assert(repeatedProof[field] === true, `T25 repeat ${field} is not proven`)
    }
    // T25/T27: the repeat resolves the SAME Workspace through a fresh baseline
    // instead of minting a second one. (`workspaceUpsert` is deliberately NOT
    // asserted false here: the probe only observes an upsert on the creating
    // branch, so it would be false by construction. The authoritative proof is
    // that the fresh baseline already carried the identity.)
    for (const field of ['workspaceRemote', 'workspaceBaseline', 'workspaceIdempotent']) {
      assert(repeatedProof[field] === true, `T25 repeat ${field} is not proven`)
    }
    assert(repeatedProof.workspaceCreated === false, 'T25 the repeat probe must resolve, not create')
    assert(repeatedProof.workspaceInBaseline === true,
      'T25 the repeat probe baseline must already carry the Host Workspace')
    assert(repeatedProof.workspaceId === workspaceId, 'T25 the repeat probe minted a second Workspace identity')
    assert(repeatedProof.workspacePath === canonicalProbeWorkspacePath, 'T25 the repeat probe path is not the Host canonical path')
    trace('t22-t24-host-rpc-proof', {
      hostPid: hostRpcProof.hostPid,
      hostInstanceId: hostRpcProof.hostInstanceId,
      clientPid: hostRpcProof.clientPid,
      officialSessionList: true,
      privateFileRpc: 'ok/unavailable',
      terminalSnapshot: 'snapshot:false:idle',
      workspaceRemote: true,
      workspaceCreated: hostRpcProof.workspaceCreated,
      workspacePath: hostRpcProof.workspacePath,
      workspaceGenerationAdvanced: hostRpcProof.workspaceGenerationAdvanced,
      workspaceHeldStreamClosed: hostRpcProof.workspaceHeldStreamClosed,
      workspaceRestoredBaseline: hostRpcProof.workspaceRestoredBaseline,
      workspaceIdDigest: createHash('sha256').update(workspaceId).digest('hex').slice(0, 16),
      cleaned: true,
      hostTerminalProgressWatchesBefore: hostReady.terminalProgressWatches,
      hostTerminalProgressWatchesDuring: firstProbe.during.terminalProgressWatches,
      hostTerminalProgressWatchesAfter: firstProbe.after.terminalProgressWatches,
    })
    trace('t25-repeat-probe', {
      hostPid: repeatedProof.hostPid,
      hostInstanceId: repeatedProof.hostInstanceId,
      clientPid: repeatedProof.clientPid,
      duplicateRegistration: false,
      workspaceCreated: repeatedProof.workspaceCreated,
      workspaceInBaseline: repeatedProof.workspaceInBaseline,
      sameWorkspaceId: repeatedProof.workspaceId === workspaceId,
      hostTerminalProgressWatchesDuring: repeatedProbe.during.terminalProgressWatches,
      hostTerminalProgressWatchesAfter: repeatedProbe.after.terminalProgressWatches,
    })

    // T05: one mux socket per authenticated peer; release invalidates the Peer.
    const muxUrl = new URL('/api/remote.mux', origin)
    muxUrl.protocol = 'ws:'
    const firstMux = await muxAttempt(muxUrl.href, validCookie, WebSocket)
    assert(firstMux.opened === true, 'T05 first mux socket did not open')
    const secondMux = await muxAttempt(muxUrl.href, validCookie, WebSocket)
    assert(secondMux.opened === false && secondMux.status === 409, `T05 second mux returned ${JSON.stringify(secondMux.status)}`)
    assert(firstMux.socket.readyState === WebSocket.OPEN, 'T05 first mux socket did not survive the 409')
    await closeMux(firstMux.socket, WebSocket)
    let thirdMux
    const releaseDeadline = Date.now() + 5_000
    while (Date.now() < releaseDeadline) {
      thirdMux = await muxAttempt(muxUrl.href, validCookie, WebSocket)
      if (thirdMux.opened === false && thirdMux.status === 401) break
      if (thirdMux.opened === true) {
        await closeMux(thirdMux.socket, WebSocket)
        assert(false, 'T05 the released Peer opened the mux again')
      }
      await sleep(100)
    }
    assert(thirdMux?.opened === false && thirdMux.status === 401, `T05 released Peer returned ${JSON.stringify(thirdMux?.status)}`)
    trace('mux-audit', { first: 'open', second: 409, released: 401 })

    // T10: C1 normal exit keeps the Host; C2 re-authenticates to the same root.
    const c1Exit = await c1.shutdown()
    assert(c1Exit.code === 0 && c1Exit.signal === null, `T10 normal Client exit was ${JSON.stringify(c1Exit)}`)
    const hostAfterC1 = await hostStatus(mainHost)
    assertIdentityFields(hostAfterC1.localHost, hostReady.localHost, 'T10 Host after normal Client exit')
    assert(hostAfterC1.rootFiberUid === hostReady.rootFiberUid, 'T10 Host root fiber identity changed')
    // T25: the Client that ran the probe exited; the same Host PID/instance and
    // the one built-in Host Runtime owner remain, and later Clients still attach.
    const t25RuntimeOwners = hostAfterC1.ownerEntries?.piTuiHostRuntime
    assert(Array.isArray(t25RuntimeOwners) && t25RuntimeOwners.length === 1
      && t25RuntimeOwners[0] === 'split-host-pi-tui-runtime',
    `T25 the built-in Host Runtime owner changed after Client exit: ${JSON.stringify(t25RuntimeOwners)}`)
    assert(hostAfterC1.localHost.instanceId === hostReady.localHost.instanceId,
      'T25 the Host instance changed after Client exit')
    trace('t25-client-detach', {
      hostPid: hostAfterC1.localHost.hostPid,
      instanceId: hostAfterC1.localHost.instanceId,
      hostRuntimeOwner: hostAfterC1.ownerEntries.piTuiHostRuntime,
      hostAlive: alive(hostReady.pid),
    })

    // T02 negative mutation: the Client still authenticates during discovery,
    // then omits its Cookie from the official transport carrier. The Host must
    // refuse the mux; the Client must fail after its bounded generation wait.
    const noCookie = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_OMIT_COOKIE: '1' },
    })
    const noCookieFailure = await noCookie.waitFor(record => record.m4a0 === 'failure', 'T02 cookie omission mutation', 90_000)
    const noCookieExit = await noCookie.waitForExit(30_000)
    assert(noCookieExit.code === 1, `T02 cookie omission exit was ${JSON.stringify(noCookieExit)}`)
    assert(noCookieFailure.code === 'HOST_UNRESPONSIVE', `T02 cookie omission code was ${JSON.stringify(noCookieFailure.code ?? noCookieFailure.error)}`)
    const noCookieCleanup = noCookie.records.find(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure')
    assert(noCookieCleanup !== undefined, 'T02 cookie omission emitted no cleanup outcome')
    const noCookieReady = noCookie.records.some(record => record.m4a0 === 'ready')
    assert(!noCookieReady, 'T26 the no-Cookie Client must never emit ready')
    assert(alive(hostReady.pid), 'T02 cookie omission killed the Host')
    trace('t02-cookie-mutation', { code: 'HOST_UNRESPONSIVE', cleanup: noCookieCleanup.m4a0, hostAlive: true })
    trace('t26-no-cookie', { code: 'HOST_UNRESPONSIVE', readyEmitted: noCookieReady, hostAlive: true })

    // T14 startup fatal probe: a fatal that arrives before startLocalTransport
    // returns must reject the startup exactly once, emit no ready, and release
    // the Client seat while the Host stays alive.
    const startupFatal = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL: '1' },
    })
    const startupFailure = await startupFatal.waitFor(record => record.m4a0 === 'failure', 'T14 startup fatal', 60_000)
    const startupExit = await startupFatal.waitForExit(30_000)
    assert(startupExit.code === 1, `T14 startup fatal exit was ${JSON.stringify(startupExit)}`)
    assert(startupFailure.code === 'HOST_IDENTITY_MISMATCH', `T14 startup fatal code was ${JSON.stringify(startupFailure.code ?? startupFailure.error)}`)
    assert(!startupFatal.records.some(record => record.m4a0 === 'ready'), 'T14 startup fatal emitted ready')
    assert(startupFatal.records.filter(record => record.m4a0 === 'failure').length === 1, 'T14 startup fatal duplicated the failure record')
    const startupCleanup = startupFatal.records.filter(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure')
    assert(startupCleanup.length === 1, `T14 startup fatal emitted ${String(startupCleanup.length)} cleanup outcomes`)
    assert(alive(hostReady.pid), 'T14 startup fatal killed the Host')
    trace('t14-startup-fatal', { code: 'HOST_IDENTITY_MISMATCH', readyEmitted: false, cleanup: startupCleanup[0].m4a0, hostAlive: true })

    const c2 = new EntryProcess('client', entries.client, probeClientBase)
    const c2Outcome = await waitForOutcome(c2, 'T10 C2')
    assert(c2Outcome.m4a0 === 'ready' && c2Outcome.transport === 'connected', `T10 C2 did not connect: ${JSON.stringify(c2Outcome)}`)
    assert(c2Outcome.pid !== c1Ready.pid, 'T10 C2 did not mint a new Client process')
    assertClientHostFacts(c2Outcome.host, hostReady.localHost, 'T10 C2')
    const beforeDropGeneration = c2Outcome.generationId
    trace('t10', {
      firstClientPid: c1Ready.pid,
      secondClientPid: c2Outcome.pid,
      generationId: c2Outcome.generationId,
      hostInstanceId: c2Outcome.host.instanceId,
    })
    trace('reconnect-baseline', { clientPid: c2Outcome.pid, generationId: beforeDropGeneration })

    // T13/F2: physically drop the actual mux socket repeatedly. Each cycle
    // must clear the generation, form a replacement on the same Host, and
    // return the active wrapper/socket ownership to its one-connection
    // baseline. Thirty-six cycles expose cumulative wrapper retention.
    const RECONNECT_CYCLES = 36
    assert(c2Outcome.activeWrappers === 1, `T13 wrapper baseline is ${String(c2Outcome.activeWrappers)}`)
    assert(c2Outcome.liveSockets === 1, `T13 socket baseline is ${String(c2Outcome.liveSockets)}`)
    let beforeGeneration = beforeDropGeneration
    let lastReconnected
    for (let cycle = 1; cycle <= RECONNECT_CYCLES; cycle += 1) {
      const requestId = `drop-${cycle}`
      c2.send({ op: 'qualification-drop-websocket', requestId })
      await c2.waitFor(record => record.m4a0 === 'qualification' && record.requestId === requestId, `T13 qualification drop ${cycle}`, 30_000)
      let sawInterruption = false
      let reconnected
      const reconnectDeadline = Date.now() + 20_000
      while (Date.now() < reconnectDeadline) {
        const status = await clientStatus(c2)
        if (!sawInterruption && status.transport !== 'connected') {
          sawInterruption = true
          assert(status.generationId === undefined, `T13 cycle ${cycle} interrupted status kept a stale generation`)
          if (cycle === 1) trace('reconnect-interruption', { transport: status.transport })
        }
        if (sawInterruption && status.transport === 'connected' && status.generationId > beforeGeneration) {
          reconnected = status
          break
        }
        await sleep(25)
      }
      assert(sawInterruption, `T13 cycle ${cycle} never observed a disconnected/connecting state`)
      assert(reconnected !== undefined, `T13 cycle ${cycle} never formed a replacement generation`)
      assert(reconnected.activeWrappers === 1, `T13 cycle ${cycle} retained ${String(reconnected.activeWrappers)} wrapper(s)`)
      assert(reconnected.liveSockets === 1, `T13 cycle ${cycle} retained ${String(reconnected.liveSockets)} socket(s)`)
      beforeGeneration = reconnected.generationId
      lastReconnected = reconnected
    }
    assertClientHostFacts(lastReconnected.host, hostReady.localHost, 'T13 reconnected')
    trace('reconnect', {
      cycles: RECONNECT_CYCLES,
      beforeGenerationId: beforeDropGeneration,
      afterGenerationId: lastReconnected.generationId,
      activeWrappers: lastReconnected.activeWrappers,
      liveSockets: lastReconnected.liveSockets,
      hostInstanceId: lastReconnected.host.instanceId,
    })

    // T27 (M5-WS1): a DIFFERENT Client PID — after thirty-six real generation
    // replacements — still reaches the ONE Host Workspace authority: its fresh
    // `follow` baseline already carries the Workspace the first Client created,
    // and a repeated `create` resolves that identity instead of minting a
    // second one. This is the disconnect/rollover currency proof for the
    // Workspace stream; no Client-side Workspace store exists in between.
    const restoredProbe = await runHostFoundationProbe(c2, 't27-workspace-restore')
    const restoredProof = restoredProbe.proof
    assert(restoredProof.hostPid === hostReady.pid, 'T27 restored probe Host PID mismatch')
    assert(restoredProof.hostInstanceId === hostReady.localHost.instanceId, 'T27 restored probe Host instance mismatch')
    assert(restoredProof.clientPid === c2Outcome.pid, 'T27 restored probe Client PID mismatch')
    assert(restoredProof.cleaned === true, 'T27 restored probe did not clean up')
    for (const field of ['workspaceRemote', 'workspaceBaseline', 'workspaceIdempotent']) {
      assert(restoredProof[field] === true, `T27 restored ${field} is not proven`)
    }
    assert(restoredProof.workspaceCreated === false,
      'T27 the later Client must RESOLVE the existing Workspace, not create a second one')
    assert(restoredProof.workspaceInBaseline === true,
      'T27 the later Client baseline does not carry the Host Workspace')
    assert(restoredProof.workspaceId === workspaceId,
      'T27 the later Client observed a different Workspace identity')
    assert(restoredProof.workspacePath === canonicalProbeWorkspacePath,
      'T27 the later Client observed a different canonical Workspace path')
    const t27Status = await hostStatus(mainHost)
    const t27Owners = t27Status.ownerEntries
    assert(JSON.stringify(t27Owners.workspaceController) === JSON.stringify(['workspace-controller']),
      `T27 the Workspace Controller owner changed after Client rollover: ${JSON.stringify(t27Owners.workspaceController)}`)
    // The Client exit/reload and the generation replacements may only drop the
    // Client's own descriptors: the Host Workspace loader rows keep their LIVE
    // fiber identity (an HMR remount would mint a new UID).
    for (const id of ['workspace', 'workspace-controller']) {
      const before = hostReady.entries.find(entry => entry.id === id)?.fiberUid
      const after = t27Status.entries.find(entry => entry.id === id)
      assert(typeof before === 'number', `T21/T27 the Host ready record carries no live fiberUid for "${id}"`)
      assert(after?.state === 'active' && after.fiberUid === before,
        `T27 the "${id}" Host row was re-mounted across Client exit/rollover: ${JSON.stringify(after)}`)
    }
    trace('t27-workspace-restore', {
      clientPid: restoredProof.clientPid,
      hostInstanceId: restoredProof.hostInstanceId,
      generationId: lastReconnected.generationId,
      workspaceCreated: restoredProof.workspaceCreated,
      workspaceInBaseline: restoredProof.workspaceInBaseline,
      sameWorkspaceId: restoredProof.workspaceId === workspaceId,
      workspaceControllerOwners: t27Owners.workspaceController,
      workspaceFiberStable: true,
    })

    const c2Exit = await c2.shutdown()
    assert(c2Exit.code === 0, `T13 C2 normal exit was ${JSON.stringify(c2Exit)}`)
    assert(alive(hostReady.pid), 'T13 Host died on C2 exit')

    // T14 lifetime: a CONNECTED Client whose replacement launch names another
    // Host instance must terminate with HOST_IDENTITY_MISMATCH; the official
    // Connection loop must not retry it as an ordinary carrier loss.
    const lifetimeClient = new EntryProcess('client', entries.client, base)
    const lifetimeReady = await waitForOutcome(lifetimeClient, 'T14 lifetime client', 120_000)
    assert(lifetimeReady.m4a0 === 'ready' && lifetimeReady.transport === 'connected', `T14 lifetime Client did not connect: ${JSON.stringify(lifetimeReady)}`)
    const lifetimeLaunchSaved = saveFile(launchPath)
    writeRawPrivate(launchPath, { ...launch, instanceId: randomUUID() })
    try {
      lifetimeClient.send({ op: 'qualification-drop-websocket', requestId: 'lifetime-drop' })
      await lifetimeClient.waitFor(record => record.m4a0 === 'qualification' && record.requestId === 'lifetime-drop', 'T14 lifetime drop', 30_000)
      const lifetimeFailure = await lifetimeClient.waitFor(record => record.m4a0 === 'failure', 'T14 lifetime identity', 60_000)
      const lifetimeExit = await lifetimeClient.waitForExit(30_000)
      assert(lifetimeExit.code === 1, `T14 lifetime exit was ${JSON.stringify(lifetimeExit)}`)
      assert(lifetimeFailure.code === 'HOST_IDENTITY_MISMATCH', `T14 lifetime code was ${JSON.stringify(lifetimeFailure.code ?? lifetimeFailure.error)}`)
      assert(lifetimeClient.records.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'T14 lifetime did not emit completed cleanup')
      assert(alive(hostReady.pid), 'T14 lifetime killed the Host')
      trace('t14-lifetime', { code: 'HOST_IDENTITY_MISMATCH', hostAlive: true })
    } finally {
      restoreFile(launchPath, lifetimeLaunchSaved)
      if (!lifetimeClient.exited) lifetimeClient.kill('SIGKILL')
    }

    // T13 retryable refresh: a transient HOST_UNRESPONSIVE during Cookie
    // refresh must stay an official same-Host retry, not a fatal Client exit.
    const retryable = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE: '1' },
    })
    const retryableReady = await waitForOutcome(retryable, 'T13 retryable refresh Client', 120_000)
    assert(retryableReady.m4a0 === 'ready' && retryableReady.transport === 'connected', `T13 retryable Client did not connect: ${JSON.stringify(retryableReady)}`)
    const retryableBefore = retryableReady.generationId
    retryable.send({ op: 'qualification-drop-websocket', requestId: 'retryable-drop' })
    await retryable.waitFor(record => record.m4a0 === 'qualification' && record.requestId === 'retryable-drop', 'T13 retryable drop', 30_000)
    let retryableInterrupted = false
    let retryableAfter
    const retryableDeadline = Date.now() + 20_000
    while (Date.now() < retryableDeadline && !retryable.exited) {
      const status = await clientStatus(retryable)
      if (status.transport !== 'connected') retryableInterrupted = true
      if (status.transport === 'connected' && status.generationId > retryableBefore) {
        retryableAfter = status
        break
      }
      await sleep(50)
    }
    assert(!retryable.exited, 'T13 retryable refresh became a fatal Client exit')
    assert(retryableInterrupted, 'T13 retryable refresh never observed an interrupted state')
    assert(retryableAfter !== undefined, 'T13 retryable refresh never formed a replacement generation')
    assertClientHostFacts(retryableAfter.host, hostReady.localHost, 'T13 retryable')
    const retryableExit = await retryable.shutdown()
    assert(retryableExit.code === 0, `T13 retryable Client exit was ${JSON.stringify(retryableExit)}`)
    assert(alive(hostReady.pid), 'T13 retryable refresh killed the Host')
    trace('t13-retryable-refresh', {
      beforeGenerationId: retryableBefore,
      afterGenerationId: retryableAfter.generationId,
      hostAlive: true,
    })

    // T11: SIGKILL releases the Client seat; C2 reconnects to the same Host.
    const c3 = new EntryProcess('client', entries.client, base)
    const c3Outcome = await waitForOutcome(c3, 'T11 C3')
    assert(c3Outcome.m4a0 === 'ready' && c3Outcome.transport === 'connected', 'T11 C3 did not connect')
    c3.kill('SIGKILL')
    const c3Exit = await c3.waitForExit(30_000)
    assert(c3Exit.signal === 'SIGKILL', `T11 C3 exit was ${JSON.stringify(c3Exit)}`)
    assert(alive(hostReady.pid), 'T11 Host died on Client SIGKILL')
    const c4 = new EntryProcess('client', entries.client, base)
    const c4Outcome = await waitForOutcome(c4, 'T11 C4')
    assert(c4Outcome.m4a0 === 'ready' && c4Outcome.transport === 'connected', 'T11 C4 did not reconnect to the same Host')
    assert(c4Outcome.pid !== c3.pid, 'T11 C4 reused the killed Client PID')
    assertClientHostFacts(c4Outcome.host, hostReady.localHost, 'T11 C4')
    const c4Exit = await c4.shutdown()
    assert(c4Exit.code === 0, `T11 C4 exit was ${JSON.stringify(c4Exit)}`)
    assert(alive(hostReady.pid), 'T11 Host died on C4 exit')
    trace('t11', {
      killedClientPid: c3.pid,
      reconnectedClientPid: c4Outcome.pid,
      hostInstanceId: c4Outcome.host.instanceId,
    })

    // T12: SIGTERM disposes the Client only. PTY HUP is a declared Linux L1
    // limitation in this qualification lane (no PTY harness is installed).
    const c5 = new EntryProcess('client', entries.client, base)
    const c5Outcome = await waitForOutcome(c5, 'T12 C5')
    assert(c5Outcome.m4a0 === 'ready' && c5Outcome.transport === 'connected', 'T12 C5 did not connect')
    c5.kill('SIGTERM')
    const c5Exit = await c5.waitForExit(30_000)
    assert(c5Exit.code === 0, `T12 C5 SIGTERM exit was ${JSON.stringify(c5Exit)}`)
    assert(alive(hostReady.pid), 'T12 Host died on Client SIGTERM')
    // This record covers ONLY the SIGTERM half. The real PTY master-close
    // (HUP-class) positive is the separate `t12-pty-hup` record later in this
    // lane; it must never be inferred from here.
    trace('t12', { sigterm: 'pass', ptyHup: 'separate t12-pty-hup case' })

    // T17a: non-destructive installed-payload drift. Appending a harmless
    // comment changes the Client's recomputed build fingerprint while the
    // module stays loadable and the local wire contract is unchanged. The new
    // Client must authenticate to the SAME live Host; the Host identity,
    // Registry/Launch bytes and its running work stay untouched. The chunk is
    // restored byte-for-byte before T17b and every later gate runs.
    const clientChunk = chunk(profilePackage, 'client-bootstrap-')
    const clientChunkBytes = readFileSync(clientChunk)
    const undisturbedBuildId = productionBuildId(profilePackage, hostReady.localHost.dshVersion)
    const driftRegistryBytes = readFileSync(registryPath)
    const driftLaunchBytes = readFileSync(launchPath)
    let driftClient
    try {
      appendFileSync(clientChunk, '\n// harmless client build drift: protocol unchanged\n')
      const driftedBuildId = productionBuildId(profilePackage, hostReady.localHost.dshVersion)
      assert(driftedBuildId !== undisturbedBuildId, 'T17 payload drift did not change the production build fingerprint')
      assert(driftedBuildId !== hostReady.localHost.buildId, 'T17 payload drift did not differ from the live Host buildId')
      driftClient = new EntryProcess('client', entries.client, base)
      const driftedAuth = await driftClient.waitFor(
        record => record.m4a0 === 'host-authenticated',
        'T17 drift Client authenticated the live Host',
        120_000,
      )
      assertClientHostFacts(driftedAuth.host, hostReady.localHost, 'T17 drift authenticated Host')
      const driftReady = await driftClient.waitFor(record => record.m4a0 === 'ready', 'T17 drift Client ready', 240_000)
      assert(driftReady.transport === 'connected', `T17 drift transport was ${JSON.stringify(driftReady.transport)}`)
      const driftExit = await driftClient.shutdown()
      assert(driftExit.code === 0 && driftExit.signal === null, `T17 drift Client exit was ${JSON.stringify(driftExit)}`)
      assert(!driftClient.records.some(record => record.m4a0 === 'cleanup-failure'),
        'T17 drift Client reported a cleanup failure')
      assert(await seatIsFree(`\0dsh-pi-tui-c-${hostReady.localHost.scopeId.slice(0, 40)}`),
        'T17 drift Client did not release the Client seat')
      assert(alive(hostReady.pid), 'T17 payload drift killed the Host')
      assert(readFileSync(registryPath).equals(driftRegistryBytes), 'T17 drift Client mutated the Host registry')
      assert(readFileSync(launchPath).equals(driftLaunchBytes), 'T17 drift Client mutated the Host launch material')
      trace('t17-payload-drift', {
        buildIdChanged: true,
        transport: 'connected',
        hostInstanceId: driftedAuth.host.instanceId,
        hostAlive: true,
      })
    } finally {
      writeFileSync(clientChunk, clientChunkBytes)
      assert(readFileSync(clientChunk).equals(clientChunkBytes), 'T17 payload drift did not restore the installed client chunk')
      if (driftClient !== undefined && !driftClient.exited) driftClient.kill('SIGKILL')
    }

    // T17b: forced startup failure with an unchanged install. The internal
    // qualification flag exercises the same after-context reverse cleanup that
    // a real Client chunk-load failure takes, without changing the build id.
    const forcedClient = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_FORCE_FAILURE: 'client-bootstrap' },
    })
    await forcedClient.waitFor(record => record.m4a0 === 'failure', 'T17 forced bootstrap failure', 60_000)
    const forcedExit = await forcedClient.waitForExit(30_000)
    assert(forcedExit.code === 1, `T17 forced bootstrap failure exit was ${JSON.stringify(forcedExit)}`)
    const forcedFailure = forcedClient.records.find(record => record.m4a0 === 'failure')
    assert(forcedFailure !== undefined && forcedFailure.phase === 'after-context', 'T17 forced bootstrap failure did not report after-context failure')
    assert(forcedFailure.activeWrappers === 0, `T17 forced bootstrap retained ${String(forcedFailure.activeWrappers)} wrapper(s)`)
    assert(forcedFailure.liveSockets === 0, `T17 forced bootstrap retained ${String(forcedFailure.liveSockets)} socket(s)`)
    assert(forcedClient.records.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'T17 forced bootstrap failure did not emit completed cleanup')
    assert(!forcedClient.records.some(record => record.m4a0 === 'cleanup-failure'), 'T17 forced bootstrap failure falsely reported cleanup failure')
    assert(alive(hostReady.pid), 'T17 forced bootstrap failure killed the Host')
    trace('t17-forced-bootstrap', { phase: 'after-context', cleanup: 'completed', hostAlive: true })

    // T07: unsafe private files/directories fail before any Host spawn.
    const expectClientFailure = async (label, expectedCode, mutate, restore, timeoutMs = 60_000) => {
      mutate()
      let failure
      let exit
      try {
        const client = new EntryProcess('client', entries.client, base)
        failure = await client.waitFor(record => record.m4a0 === 'failure', label, timeoutMs)
        exit = await client.waitForExit(30_000)
        assert(exit.code === 1, `${label}: exit was ${JSON.stringify(exit)}`)
        assert(failure.code === expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(failure.code ?? failure.error)}`)
        assert(
          !client.records.some(record => record.m4a0 === 'ready' || record.m4a0 === 'host-authenticated' || record.m4a0 === 'transport-ready'),
          `${label}: a refused Client reached a business-ready record`,
        )
      } finally {
        restore()
      }
      assert(alive(hostReady.pid), `${label}: Host died`)
      return failure
    }
    const registrySaved = saveFile(registryPath)
    await expectClientFailure('T07 registry mode', 'LOCAL_FILE_UNSAFE', () => {
      chmodSync(registryPath, 0o644)
    }, () => restoreFile(registryPath, registrySaved))
    const decoyPath = join(scopeDir, 'decoy.json')
    writeRawPrivate(decoyPath, registry)
    await expectClientFailure('T07 registry symlink', 'LOCAL_FILE_UNSAFE', () => {
      unlinkSync(registryPath)
      symlinkSync(decoyPath, registryPath)
    }, () => restoreFile(registryPath, registrySaved))
    unlinkSync(decoyPath)
    const scopeMode = modeOf(scopeDir)
    await expectClientFailure('T07 scope directory mode', 'SCOPE_DIRECTORY_UNSAFE', () => {
      chmodSync(scopeDir, 0o755)
    }, () => chmodSync(scopeDir, scopeMode))
    const launchSaved = saveFile(launchPath)
    await expectClientFailure('T07 launch mode', 'LOCAL_FILE_UNSAFE', () => {
      chmodSync(launchPath, 0o644)
    }, () => restoreFile(launchPath, launchSaved))
    trace('rejections', { registryMode: 'LOCAL_FILE_UNSAFE', registrySymlink: 'LOCAL_FILE_UNSAFE', scopeMode: 'SCOPE_DIRECTORY_UNSAFE', launchMode: 'LOCAL_FILE_UNSAFE' })

    // T14: a forged registry/launch pair cannot fabricate a Host; the real
    // authenticated identity wins and reports HOST_IDENTITY_MISMATCH.
    const forgedRegistry = { ...registry, instanceId: randomUUID() }
    const forgedLaunch = { ...launch, instanceId: forgedRegistry.instanceId }
    writeRawPrivate(registryPath, forgedRegistry)
    writeRawPrivate(launchPath, forgedLaunch)
    const forgedRegistryBytes = readFileSync(registryPath)
    const forgedLaunchBytes = readFileSync(launchPath)
    try {
      await expectClientFailure('T14 forged identity', 'HOST_IDENTITY_MISMATCH', () => {}, () => {}, 60_000)
      assert(readFileSync(registryPath).equals(forgedRegistryBytes), 'T14 Client mutated the registry')
      assert(readFileSync(launchPath).equals(forgedLaunchBytes), 'T14 Client mutated the launch material')
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    trace('rejections-identity', { forgedInstanceId: 'HOST_IDENTITY_MISMATCH' })

    // T16/T17: an alive-but-unresponsive PID, a protocol mismatch, a forged
    // registry build identity and a bad token are terminal refusals that never
    // kill or replace the live Host.
    const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    dummy.unref()
    trackDetached(dummy.pid, undefined)
    let dummyStarttime
    for (let attempt = 0; attempt < 100 && dummyStarttime === undefined; attempt += 1) {
      dummyStarttime = readStartIdentity(dummy.pid)
      if (dummyStarttime === undefined) await sleep(20)
    }
    assert(dummyStarttime !== undefined, 'T16 dummy PID has no starttime')
    trackDetached(dummy.pid, dummyStarttime)
    failpoint('dummy')
    let closedPort
    {
      const server = createNetServer()
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', () => resolveListen())
      })
      closedPort = server.address().port
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
    // T14 forged PID: the registry claims a live non-Host PID but keeps the
    // real authenticated Host endpoint. The authenticated identity echo differs
    // from the registry and must be HOST_IDENTITY_MISMATCH, not readiness.
    writeRawPrivate(registryPath, {
      ...registry,
      hostPid: dummy.pid,
      hostStarttime: dummyStarttime,
    })
    writeRawPrivate(launchPath, launch)
    try {
      await expectClientFailure('T14 forged PID', 'HOST_IDENTITY_MISMATCH', () => {}, () => {})
      assert(alive(dummy.pid), 'T14 forged PID killed the live non-Host PID')
      assert(alive(hostReady.pid), 'T14 forged PID killed the live Host')
      trace('t14-forged-pid', { code: 'HOST_IDENTITY_MISMATCH', hostAlive: true, dummyAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }

    // T14 forged origin: a real live Host PID with an unresponsive forged
    // loopback origin must fail closed as HOST_UNRESPONSIVE, never spawn.
    writeRawPrivate(registryPath, {
      ...registry,
      origin: `http://127.0.0.1:${String(closedPort)}`,
    })
    writeRawPrivate(launchPath, {
      schema: 1,
      instanceId: registry.instanceId,
      connectUrl: `http://127.0.0.1:${String(closedPort)}/connect?token=deadbeef`,
    })
    try {
      await expectClientFailure('T14 forged origin', 'HOST_UNRESPONSIVE', () => {}, () => {})
      assert(alive(hostReady.pid), 'T14 forged origin killed the live Host')
      trace('t14-forged-origin', { code: 'HOST_UNRESPONSIVE', hostAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }

    const unresponsiveRegistry = {
      ...registry,
      instanceId: randomUUID(),
      hostPid: dummy.pid,
      hostStarttime: dummyStarttime,
      origin: `http://127.0.0.1:${String(closedPort)}`,
    }
    writeRawPrivate(registryPath, unresponsiveRegistry)
    writeRawPrivate(launchPath, {
      schema: 1,
      instanceId: unresponsiveRegistry.instanceId,
      connectUrl: `${unresponsiveRegistry.origin}/connect?token=deadbeef`,
    })
    const unresponsiveBytes = readFileSync(registryPath)
    try {
      await expectClientFailure('T16 unresponsive Host', 'HOST_UNRESPONSIVE', () => {}, () => {})
      assert(alive(dummy.pid), 'T16 unresponsive Host test killed the dummy PID')
      assert(alive(hostReady.pid), 'T16 unresponsive Host test killed the live Host')
      assert(readFileSync(registryPath).equals(unresponsiveBytes), 'T16 unresponsive Host test mutated the registry')
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    const protocolIncompatibleRegistry = { ...registry, protocol: 'dsh-pi-tui/local/2' }
    writeRawPrivate(registryPath, protocolIncompatibleRegistry)
    writeRawPrivate(launchPath, launch)
    const protocolIncompatibleRegistryBytes = readFileSync(registryPath)
    const protocolIncompatibleLaunchBytes = readFileSync(launchPath)
    try {
      await expectClientFailure('T16 protocol incompatible', 'HOST_PROTOCOL_INCOMPATIBLE', () => {}, () => {})
      assert(alive(hostReady.pid), 'T16 protocol mismatch killed the live Host')
      assert(readFileSync(registryPath).equals(protocolIncompatibleRegistryBytes),
        'T16 protocol mismatch mutated the registry')
      assert(readFileSync(launchPath).equals(protocolIncompatibleLaunchBytes),
        'T16 protocol mismatch mutated the launch material')
      trace('t16-protocol-incompatible', { code: 'HOST_PROTOCOL_INCOMPATIBLE', hostAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    // A forged registry buildId is no longer a Client admission gate: this
    // candidate reaches the authenticated identity comparison, where the live
    // Host's real echo differs from the registry and is a hard identity
    // mismatch. That keeps buildId strict where it belongs (Host identity),
    // not as a cross-build admission key.
    const buildDriftRegistry = { ...registry, buildId: 'a'.repeat(64) }
    writeRawPrivate(registryPath, buildDriftRegistry)
    writeRawPrivate(launchPath, launch)
    try {
      await expectClientFailure('T16 registry build drift', 'HOST_IDENTITY_MISMATCH', () => {}, () => {})
      assert(alive(hostReady.pid), 'T16 registry build drift killed the live Host')
      trace('t16-registry-build-drift', { code: 'HOST_IDENTITY_MISMATCH', hostAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    writeRawPrivate(launchPath, {
      schema: 1,
      instanceId: registry.instanceId,
      connectUrl: `${origin}/connect?token=deadbeef`,
    })
    try {
      await expectClientFailure('T17 auth failure', 'HOST_AUTH_FAILED', () => {}, () => {})
      assert(alive(hostReady.pid), 'T17 auth failure killed the live Host')
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    killTracked(dummy.pid, dummyStarttime, 'SIGKILL')
    trace('rejections-host', {
      unresponsive: 'HOST_UNRESPONSIVE',
      protocolIncompatible: 'HOST_PROTOCOL_INCOMPATIBLE',
      registryBuildDrift: 'HOST_IDENTITY_MISMATCH',
      authFailure: 'HOST_AUTH_FAILED',
    })

    // T15: a killed Host leaves a stale registry. The next Client may start a
    // new Host only through the kernel seat; the old token/Cookie do not carry.
    mainHost.kill('SIGKILL')
    const mainHostExit = await mainHost.waitForExit(30_000)
    assert(mainHostExit.signal === 'SIGKILL', `T15 main Host exit was ${JSON.stringify(mainHostExit)}`)
    assert(!alive(hostReady.pid), 'T15 main Host survived SIGKILL')
    assert(existsSync(registryPath), 'T15 stale registry disappeared on SIGKILL')
    const hostChunk = chunk(profilePackage, 'host-bootstrap-')
    renameSync(hostChunk, `${hostChunk}.missing`)
    let missingHostExit
    let missingHostRecords
    let missingHostFailure
    let missingHostFailureAt
    let missingHostExitAt
    try {
      const missingHost = new EntryProcess('host', entries.host, base)
      missingHostFailure = await missingHost.waitFor(record => record.m4a0 === 'failure', 'T17 missing host chunk', 120_000)
      missingHostFailureAt = Date.now()
      missingHostExit = await missingHost.waitForExit(60_000)
      missingHostExitAt = Date.now()
      missingHostRecords = missingHost.records
    } finally {
      renameSync(`${hostChunk}.missing`, hostChunk)
    }
    assert(missingHostExit.code === 1, `T17 missing host chunk exit was ${JSON.stringify(missingHostExit)}`)
    assert(missingHostRecords.some(record => record.m4a0 === 'failure' && record.phase === 'after-boot'), 'T17 missing host chunk did not report after-boot failure')
    // Diagnostic only: print the cleanup records the Host really emitted when the
    // completed-cleanup claim is missing. Only the fixed record vocabulary is
    // copied; a record's `error` text could carry a path and stays out.
    const cleanupRecords = missingHostRecords
      .filter(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure')
      .map(record => ({ m4a0: record.m4a0, phase: record.phase, status: record.status, step: record.step }))
    if (!cleanupRecords.some(record => record.m4a0 === 'cleanup' && record.status === 'completed')) {
      console.error(`[T17 cleanup diagnostic] exit=${JSON.stringify(missingHostExit)} failureToExitMs=${missingHostExitAt - missingHostFailureAt} failurePhase=${JSON.stringify(missingHostFailure?.phase)} cleanup=${JSON.stringify(cleanupRecords)} recordKinds=${JSON.stringify([...new Set(missingHostRecords.map(record => record.m4a0))])}`)
    }
    assert(missingHostRecords.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'T17 missing host chunk did not emit completed cleanup')
    assert(!missingHostRecords.some(record => record.m4a0 === 'cleanup-failure'), 'T17 missing host chunk falsely reported cleanup failure')
    trace('t17-host-chunk', { phase: 'after-boot', cleanup: 'completed' })

    // A real Client spawn whose Host fails before runProfile must
    // remove only its own launcher-created scratch. The main Host is already
    // dead, so ensureLocalHost actually spawns a candidate.
    const removalFailure = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_SCRATCH_REMOVE_FAILURE: '1' },
    })
    const removalReady = await waitForOutcome(removalFailure, 'scratch-removal-failure Host', 120_000)
    assert(removalReady.m4a0 === 'ready', `the scratch-removal Host did not become ready: ${JSON.stringify(removalReady)}`)
    removalFailure.send({ op: 'shutdown' })
    const removalCleanup = await removalFailure.waitFor(record => record.m4a0 === 'cleanup-failure', 'scratch removal cleanup failure', 60_000)
    assert(removalCleanup.step === 'scratch-remove', `the scratch removal reported cleanup step ${JSON.stringify(removalCleanup.step)}`)
    const removalExit = await removalFailure.waitForExit(30_000)
    assert(removalExit.code === 1, `the scratch removal Host exit was ${JSON.stringify(removalExit)}`)
    trace('t15-removal-failure', { step: removalCleanup.step, exit: removalExit.code })

    const preProfileScratch = scopeScratchDirs().length
    const preProfile = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_BOOT_FAILURE: 'before-profile' },
    })
    const preProfileFailure = await preProfile.waitFor(record => record.m4a0 === 'failure', 'pre-profile Host failure', 120_000)
    const preProfileExit = await preProfile.waitForExit(30_000)
    assert(preProfileExit.code === 1, `the pre-profile Client exit was ${JSON.stringify(preProfileExit)}`)
    assert(preProfileFailure.code === 'HOST_START_TIMEOUT', `the pre-profile failure code was ${JSON.stringify(preProfileFailure.code ?? preProfileFailure.error)}`)
    assert(scopeScratchDirs().length === preProfileScratch, 'an early Host failure left its private scratch behind')
    assert(
      readFileSync(join(scopeDir, 'host.log'), 'utf8').includes('qualification forced pre-profile failure'),
      'the Host did not fail before runProfile as requested',
    )
    trace('t15-preprofile-scratch', { before: preProfileScratch, after: scopeScratchDirs().length })

    // F1: the stale registry names a real killed-but-unreaped zombie. The
    // Client must classify it dead from /proc state Z + matching starttime and
    // start a replacement through the free kernel seat.
    const zombie = await makeZombie(trackDetached)
    writeRawPrivate(registryPath, { ...registry, hostPid: zombie.pid, hostStarttime: zombie.starttime })
    trace('t15-zombie', { pid: zombie.pid, state: 'Z', starttime: zombie.starttime })

    const c6 = new EntryProcess('client', entries.client, base)
    const c6Outcome = await waitForOutcome(c6, 'T15 restarted Host', 240_000)
    assert(c6Outcome.m4a0 === 'ready' && c6Outcome.transport === 'connected', `T15 Client did not connect to a new Host: ${JSON.stringify(c6Outcome)}`)
    assert(c6Outcome.host.instanceId !== hostReady.localHost.instanceId, 'T15 new Host reused the dead instance id')
    assert(c6Outcome.host.hostPid !== hostReady.localHost.hostPid, 'T15 new Host reused the dead PID')
    assert(c6Outcome.host.hostPid !== zombie.pid, 'T15 new Host reused the zombie PID')
    assert(c6Outcome.host.hostStarttime !== hostReady.localHost.hostStarttime, 'T15 new Host reused the dead starttime')
    assert(c6Outcome.host.hostStarttime !== zombie.starttime, 'T15 new Host reused the zombie starttime')
    assert(scopeScratchDirs().length === 2, 'T15 spawned Host scratch plus the stale SIGKILL scratch is not two directories')
    trace('t15-scratch-spawn', { afterSpawn: scopeScratchDirs().length })
    assertClientHostFacts(c6Outcome.host, readJson(registryPath), 'T15 new Client/registry')
    trackDetached(c6Outcome.host.hostPid, c6Outcome.host.hostStarttime)
    failpoint('spawned-host')
    const newOrigin = c6Outcome.host.origin
    const newLaunch = readJson(launchPath)
    const newToken = new URL(newLaunch.connectUrl).searchParams.get('token')
    assert(newToken !== null && newToken !== hostToken, 'T15 new Host reused the old launch token')
    const oldTokenConnect = await rawGet(newOrigin, `/connect?token=${encodeURIComponent(hostToken)}&interactions=answer`)
    assert(oldTokenConnect.status === 401, `T15 old token returned ${String(oldTokenConnect.status)}`)
    const oldCookieIdentity = await fetchStatus(`${newOrigin}/api/pi-tui.local-host`, { headers: { cookie: validCookie } })
    assert(oldCookieIdentity.status === 401, `T15 old Cookie returned ${String(oldCookieIdentity.status)}`)
    const hostLogPath = join(scopeDir, 'host.log')
    assert(existsSync(hostLogPath), 'T15 spawned Host did not write a private log')
    assert(modeOf(hostLogPath) === 0o600, 'T15 spawned Host log is not 0600')
    const hostLog = readFileSync(hostLogPath, 'utf8')
    assert(Buffer.byteLength(hostLog, 'utf8') <= HOST_LOG_LIMIT, 'T15 spawned Host log is unexpectedly large')
    assertNoSecret('T15 spawned Host log', hostLog, [hostToken, validCookie, newToken])
    const c6Exit = await c6.shutdown()
    assert(c6Exit.code === 0, `T15 new Client exit was ${JSON.stringify(c6Exit)}`)
    assert(alive(c6Outcome.host.hostPid), 'T15 new Host died on Client exit')
    const c7 = new EntryProcess('client', entries.client, base)
    const c7Outcome = await waitForOutcome(c7, 'T15 attach to active Host', 120_000)
    assert(c7Outcome.m4a0 === 'ready' && c7Outcome.transport === 'connected', `T15 attach did not connect: ${JSON.stringify(c7Outcome)}`)
    assertClientHostFacts(c7Outcome.host, c6Outcome.host, 'T15 attach')
    assert(scopeScratchDirs().length === 2, 'a new Client erased an active Host overlay scratch')
    trace('t15-scratch-attach', { afterAttach: scopeScratchDirs().length })
    const c7Exit = await c7.shutdown()
    assert(c7Exit.code === 0, `T15 attach exit was ${JSON.stringify(c7Exit)}`)
    assert(alive(c6Outcome.host.hostPid), 'T15 attach killed the new Host')
    trace('reconnect-new-host', {
      oldInstanceId: hostReady.localHost.instanceId,
      newInstanceId: c6Outcome.host.instanceId,
      oldPid: hostReady.localHost.hostPid,
      newPid: c6Outcome.host.hostPid,
      oldTokenRejected: oldTokenConnect.status,
      oldCookieRejected: oldCookieIdentity.status,
    })

    // Stop the spawned Host and prove no kernel seat or stale writer remains.
    killTracked(c6Outcome.host.hostPid, c6Outcome.host.hostStarttime, 'SIGTERM')
    if (!await waitGone(c6Outcome.host.hostPid, 20_000)) {
      killTracked(c6Outcome.host.hostPid, c6Outcome.host.hostStarttime, 'SIGKILL')
      await waitGone(c6Outcome.host.hostPid, 5_000)
    }
    assert(!alive(c6Outcome.host.hostPid), 'T17 spawned Host did not exit')
    assert(scopeScratchDirs().length === 1, 'the clean Host shutdown did not remove only its own scratch')
    trace('t15-scratch-clean', { afterCleanExit: scopeScratchDirs().length })

    // T19/R1: signal admission precedes discoverable publication. The Host is
    // held AFTER `instance.json` is committed but BEFORE it can report ready;
    // SIGTERM/SIGINT in that window must take the ordinary owner-governed
    // shutdown (official disposal + identity/scratch cleanup), never the
    // default signal exit, and never emit ready afterwards. The same signal is
    // repeated while still at the publication barrier AND while the completed
    // shutdown is held before admission release: both repeats must be observed
    // and ignored by the single stop intent, never default-terminate.
    const scopeSuffix = hostReady.localHost.scopeId.slice(0, 40)
    const r1BaselineScratch = new Set(scopeScratchDirs())
    for (const [signal, expectedCode] of [['SIGTERM', 0], ['SIGINT', 130]]) {
      const barrierPath = join(workDir, `r1-publish-barrier-${signal}`)
      const stopBarrierPath = join(workDir, `r1-stop-barrier-${signal}`)
      const r1Host = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_HOST_PUBLISH_BARRIER: barrierPath,
          SPLIT_PROCESS_HOST_STOP_BARRIER: stopBarrierPath,
        },
      })
      let r1Registry
      const barrierDeadline = Date.now() + 180_000
      while (Date.now() < barrierDeadline) {
        try {
          const candidate = readJson(registryPath)
          if (candidate.hostPid === r1Host.child.pid) {
            r1Registry = candidate
            break
          }
        } catch { /* the registry is not committed yet */ }
        if (r1Host.exited) {
          throw new SplitSmokeWaitError('PROCESS_EXITED', {
            code: 'REGISTRY_COMMIT_EXITED',
            waitLabel: `T19 ${signal}: the Host must stay alive until its registry commit`,
            processRole: r1Host.role,
            process: r1Host,
          })
        }
        await sleep(20)
      }
      assert(r1Registry !== undefined, `T19 ${signal}: the Host never committed a discoverable registry`)
      assert(existsSync(launchPath), `T19 ${signal}: launch material is missing at the registry commit`)
      assert(!r1Host.records.some(record => record.m4a0 === 'ready'), `T19 ${signal}: the Host reported ready while still held at the publication barrier`)
      r1Host.kill(signal)
      const stopRequested = await r1Host.waitFor(record => record.m4a0 === 'stop-requested', `T19 ${signal} admission`, 60_000)
      assert(
        stopRequested.signal === signal && stopRequested.phase === 'publication',
        `T19 ${signal}: unexpected admission record ${JSON.stringify(stopRequested)}`,
      )
      // Repeat the SAME signal while the Host is still paused after the
      // registry commit. A once-only handler would already be gone here and
      // this signal would default-terminate the process.
      r1Host.kill(signal)
      const publicationRepeat = await r1Host.waitFor(record => record.m4a0 === 'stop-repeat-ignored', `T19 ${signal} publication repeat`, 60_000)
      assert(
        publicationRepeat.signal === signal && publicationRepeat.phase === 'publication',
        `T19 ${signal}: unexpected publication repeat record ${JSON.stringify(publicationRepeat)}`,
      )
      assert(r1Host.records.filter(record => record.m4a0 === 'stop-requested').length === 1, `T19 ${signal}: more than one pending stop intent`)
      writeFileSync(barrierPath, 'release\n', { mode: 0o600 })
      const cleanup = await r1Host.waitFor(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure', `T19 ${signal} cleanup`, 60_000)
      assert(
        cleanup.m4a0 === 'cleanup' && cleanup.status === 'completed' && cleanup.phase === 'shutdown',
        `T19 ${signal}: cleanup was ${JSON.stringify(cleanup)}`,
      )
      assert(r1Host.records.filter(record => record.m4a0 === 'cleanup').length === 1, `T19 ${signal}: cleanup was not exactly once`)
      // Repeat the SAME signal once more while the completed shutdown is held
      // before admission release. It must still be observed and ignored.
      r1Host.kill(signal)
      const shutdownRepeat = await r1Host.waitFor(record => record.m4a0 === 'stop-repeat-ignored' && record.phase === 'shutdown', `T19 ${signal} shutdown repeat`, 60_000)
      assert(shutdownRepeat.signal === signal, `T19 ${signal}: unexpected shutdown repeat record ${JSON.stringify(shutdownRepeat)}`)
      assert(r1Host.records.filter(record => record.m4a0 === 'cleanup').length === 1, `T19 ${signal}: a repeat started a second cleanup`)
      writeFileSync(stopBarrierPath, 'release\n', { mode: 0o600 })
      const exit = await r1Host.waitForExit(60_000)
      assert(exit.code === expectedCode && exit.signal === null, `T19 ${signal} exit was ${JSON.stringify(exit)}`)
      assert(!r1Host.records.some(record => record.m4a0 === 'ready'), `T19 ${signal}: the Host emitted ready after a stop request`)
      assert(!r1Host.records.some(record => record.m4a0 === 'failure'), `T19 ${signal}: the Host reported a boot failure`)
      assert(!existsSync(registryPath), `T19 ${signal}: the registry survived the owner-governed shutdown`)
      assert(!existsSync(launchPath), `T19 ${signal}: launch material survived the owner-governed shutdown`)
      const remainingScratch = scopeScratchDirs()
      assert(
        remainingScratch.length === r1BaselineScratch.size
          && remainingScratch.every(name => r1BaselineScratch.has(name)),
        `T19 ${signal}: the Host's own scratch was not removed: ${JSON.stringify(remainingScratch)}`,
      )
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
      trace(`t19-${signal.toLowerCase()}`, {
        signal,
        exit: exit.code,
        cleanup: cleanup.status,
        readyEmitted: false,
        publicationRepeatIgnored: true,
        shutdownRepeatIgnored: true,
        stopIntents: 1,
        cleanupRecords: 1,
        registryRemoved: true,
        launchRemoved: true,
        scratchRemoved: true,
        hostSeatFree: true,
      })
    }

    // T19/R1b: the SAME stop-admission guarantee across the new asynchronous
    // first-liveness observation. The Host is held after publication while the
    // initial snapshot is in flight; a signal here must still own the process
    // and must never emit Ready after the observation returns.
    for (const [signal, expectedCode] of [['SIGTERM', 0], ['SIGINT', 130]]) {
      const livenessBarrierPath = join(workDir, `r1-liveness-barrier-${signal}`)
      const r1bHost = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_HOST_LIVENESS_BARRIER: livenessBarrierPath,
        },
      })
      const held = await r1bHost.waitFor(
        record => record.m4a0 === 'qualification' && record.op === 'liveness-barrier',
        `T19b ${signal} liveness barrier`,
        120_000,
      )
      assert(typeof held.pid === 'number' && held.pid > 0, `T19b ${signal}: the liveness barrier record has no PID`)
      assert(!r1bHost.records.some(record => record.m4a0 === 'ready'), `T19b ${signal}: Ready was published before the stop`)
      r1bHost.kill(signal)
      const stopRequested = await r1bHost.waitFor(record => record.m4a0 === 'stop-requested', `T19b ${signal} admission`, 60_000)
      assert(
        stopRequested.signal === signal && stopRequested.phase === 'running',
        `T19b ${signal}: unexpected admission record ${JSON.stringify(stopRequested)}`,
      )
      writeFileSync(livenessBarrierPath, 'release\n', { mode: 0o600 })
      const cleanup = await r1bHost.waitFor(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure', `T19b ${signal} cleanup`, 60_000)
      assert(
        cleanup.m4a0 === 'cleanup' && cleanup.status === 'completed' && cleanup.phase === 'shutdown',
        `T19b ${signal}: cleanup was ${JSON.stringify(cleanup)}`,
      )
      const exit = await r1bHost.waitForExit(60_000)
      assert(exit.code === expectedCode && exit.signal === null, `T19b ${signal} exit was ${JSON.stringify(exit)}`)
      assert(!r1bHost.records.some(record => record.m4a0 === 'ready'), `T19b ${signal}: the Host emitted Ready after a stop request`)
      assert(!r1bHost.records.some(record => record.m4a0 === 'failure'), `T19b ${signal}: the Host reported a boot failure`)
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
      trace(`t19b-${signal.toLowerCase()}`, { signal, exit: exit.code, cleanup: cleanup.status, readyEmitted: false, livenessBarrier: true })
    }

    // T20: a forced exit after this Host created its scratch and BEFORE
    // runProfile installs the launcher's signal handlers bypasses the async
    // finally. The synchronous exit mirror must remove only this process's
    // own scratch; the Host seat is released by the OS and no profile boots.
    {
      const earlyBaselineScratch = new Set(scopeScratchDirs())
      const earlyExit = new EntryProcess('host', entries.host, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_EARLY_EXIT: '1' },
      })
      const earlyExitResult = await earlyExit.waitForExit(30_000)
      assert(
        earlyExitResult.code === 1 && earlyExitResult.signal === null,
        `T20 early forced exit was ${JSON.stringify(earlyExitResult)}`,
      )
      assert(!earlyExit.records.some(record => record.m4a0 === 'profile-booted'), 'T20 exited after profile boot')
      const earlyRemaining = scopeScratchDirs()
      assert(
        earlyRemaining.length === earlyBaselineScratch.size
          && earlyRemaining.every(name => earlyBaselineScratch.has(name)),
        `T20 early forced exit leaked its own scratch: ${JSON.stringify(earlyRemaining)}`,
      )
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
      trace('t20-early-exit-scratch', {
        exit: earlyExitResult.code,
        profileBooted: false,
        scratchRemoved: true,
        hostSeatFree: true,
      })
    }

    await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
    // Only the qualification Client seat is verified free here: every client
    // above in this block is an `EntryProcess` qualification Client. A real
    // `surface` Client holds no profile-global Client seat.
    await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 10_000)
    trace('seats-free', { hostSeat: 'free', qualificationClientSeat: 'free' })
  } finally {
    for (const [pid, starttime] of detachedProcesses) killTracked(pid, starttime, 'SIGKILL')
  }
}
