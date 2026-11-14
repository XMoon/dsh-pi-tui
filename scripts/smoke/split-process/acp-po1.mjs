/**
 * PO-1 real-OS split-process qualification: the Host-owned local ACP v1 UDS.
 *
 * One REAL installed Host process binds `acp.sock` inside its canonical 0700
 * scope, serves the ACP v1 `initialize` handshake over that pathname socket,
 * fails every Session request closed, enforces the connection/frame bounds, and
 * only THEN commits `instance.json` Ready. The case also proves a SIGTERM stop
 * retires the socket, a SIGKILL leaves a stale inode that a new Host safely
 * reclaims, and the existing authenticated Split Client transport still works on
 * the same Host while the ACP front door is open.
 *
 * Every fact comes from a REAL process and a REAL socket: no standalone
 * `net.createServer` fixture stands in for the Host, and a NOT_RUN/partial
 * sub-scenario returns a non-PASS verdict that fails the selected case.
 *
 * @module split-process/acp-po1
 */

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { connectCookie, fetchStatus, seatFree } from '../../lib/split-smoke-processes.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** One raw NDJSON JSON-RPC client over a real UDS connection. */
class AcpRawClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.queue = []
    this.waiter = undefined
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const message = JSON.parse(line)
        if (this.waiter !== undefined) {
          const waiter = this.waiter
          this.waiter = undefined
          waiter(message)
        } else {
          this.queue.push(message)
        }
      }
    })
    this.closed = new Promise(resolveClose => socket.on('close', () => resolveClose()))
    socket.on('error', () => {})
  }

  static open(path) {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = connect(path)
      socket.once('connect', () => {
        socket.off('error', rejectOpen)
        resolveOpen(new AcpRawClient(socket))
      })
      socket.once('error', rejectOpen)
    })
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  sendRaw(text) {
    this.socket.write(text)
  }

  next(timeoutMs = 8_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        rejectNext(new Error(`acp raw client: no message within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = value => { clearTimeout(timer); resolveNext(value) }
    })
  }

  async initialize(id) {
    this.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    return await this.next()
  }

  close() {
    this.socket.destroy()
  }
}

/** The scope directory that currently holds a bound `acp.sock` under this DSH home. */
function findScopeDirBySocket(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return undefined
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (existsSync(join(dir, 'acp.sock'))) return dir
  }
  return undefined
}

function socketPathOf(dshHome, scopeId) {
  return join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'acp.sock')
}

/** The Linux abstract seat name one Host scope claims for this profile. */
function socketSeatName(scopeId) {
  return `\0dsh-pi-tui-h-${String(scopeId).slice(0, 40)}`
}

/**
 * Connect one raw ACP client through this process's OWN scope directory fd.
 *
 * A real `DSH_HOME`/scope pathname commonly exceeds the Linux `sun_path` byte
 * limit, so a full-length `net.connect(<logical path>)` is `EINVAL`. The client
 * side has the same limit as the Host side: open the scope directory, connect
 * through `/proc/self/fd/<fd>/acp.sock`, then release the fd (the connected
 * socket no longer needs it).
 */
async function openAcpClient(scopeDir) {
  const dirFd = openSync(scopeDir, 'r')
  try {
    return await AcpRawClient.open(`/proc/self/fd/${String(dirFd)}/acp.sock`)
  } finally {
    closeSync(dirFd)
  }
}

function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new SplitSmokeAssertionError(`acp smoke: timed out waiting for ${label}`)
}

/**
 * Run the PO-1 real split-process qualification and return its named PASS
 * verdict. Every field is a proof gathered from a REAL process/socket.
 */
export async function runAcpPo1(context) {
  const { EntryProcess, SurfaceEntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const installedVersion = installation.manifest.version
  const startedHosts = []
  const startedClients = []
  const startedPeers = []
  let preferenceSequence = 0
  let prepScopeId
  let originalError

  const startHost = (extraEnv, label) => {
    const host = new EntryProcess('host', entries.host, { ...base, env: { ...base.env, ...extraEnv } })
    host.qualificationLabel = label
    startedHosts.push(host)
    return host
  }
  const waitReady = async (host, label, timeoutMs = 180_000) => {
    const record = await host.waitFor(candidate => candidate.m4a0 === 'ready' || candidate.m4a0 === 'failure', label, timeoutMs)
    assert(record.m4a0 === 'ready', `${label} did not reach Ready: ${JSON.stringify({ code: record.code, error: record.error, phase: record.phase })}`)
    return record
  }
  const startPeer = async (label) => {
    const peer = new EntryProcess('peer', entries.client, { ...base, env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' } })
    peer.qualificationLabel = label
    startedPeers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  const acpPreference = async (peer, label, value) => {
    const requestId = `acp-pref-${String(++preferenceSequence)}-${String(process.pid)}`
    peer.send({
      op: 'qualification-acp-autostart',
      requestId,
      ...(value === undefined ? {} : { acpAutoStart: value }),
    })
    return peer.waitFor(entry => entry.op === 'acp-autostart' && entry.requestId === requestId,
      `${label} acp-autostart`, 120_000)
  }

  try {
    // ── Preparation: the listener is default-OFF, so persist the profile-owned
    // `pi-tui-acp-preferences.autoStart` preference TRUE before the Phase 0/1/2
    // Hosts boot. A normal base-env Host reaches Ready with NO socket; a `peer`
    // on the SAME profile reads the default (Off) and writes On through the real
    // Settings wire. The prep Host never receives the acp-bound barrier env. ────
    const prepHost = startHost({}, 'acp preference prep host')
    const prepReady = await waitReady(prepHost, 'acp preference prep host ready')
    prepScopeId = prepReady.localHost.scopeId
    assert(findScopeDirBySocket(dshHome) === undefined, 'acp default-off: the base-env prep Host bound an acp.sock')
    assert(!exists(socketPathOf(dshHome, prepScopeId)), 'acp default-off: no acp.sock may exist before autoStart is set')
    const prepPeer = await startPeer('acp preference prep peer')
    const defaultPreference = await acpPreference(prepPeer, 'acp preference default read', undefined)
    assert(defaultPreference.ok === true && defaultPreference.autoStart === false && defaultPreference.userOverridden === false,
      `acp preference prep: the default preference is ${JSON.stringify(defaultPreference)}`)
    const savedOn = await acpPreference(prepPeer, 'acp preference write On', true)
    assert(savedOn.ok === true && savedOn.autoStart === true && savedOn.userOverridden === true && savedOn.readBack === true,
      `acp preference prep: the On write did not read back On: ${JSON.stringify(savedOn)}`)
    assert((await prepPeer.shutdown()).code === 0, 'acp preference prep: the peer did not stop')
    assert((await prepHost.shutdown()).code === 0, 'acp preference prep: the Host did not stop')
    await seatFree(socketSeatName(prepScopeId), 20_000)
    trace('acp/preference-prep', { defaultAutoStart: false, readBack: true, hostPid: prepReady.pid })

    // ── Phase 0: a stop admitted while the listener is bound but before the
    // registry commits must never publish Ready (P1-09). ─────────────────────
    const stopBarrier = join(workDir, `acp-stop-barrier-${String(process.pid)}`)
    const earlyHost = startHost({ SPLIT_PROCESS_HOST_ACP_BOUND_BARRIER: stopBarrier }, 'acp stop-during-bind host')
    await earlyHost.waitFor(record => record.m4a0 === 'qualification' && record.op === 'acp-bound-barrier', 'acp stop-during-bind barrier', 180_000)
    const earlyScopeDir = findScopeDirBySocket(dshHome)
    assert(earlyScopeDir !== undefined, 'the pre-Ready Host bound no acp.sock')
    const earlySocket = join(earlyScopeDir, 'acp.sock')
    const earlyScopeId = earlyScopeDir.split('/').pop()
    assert(exists(earlySocket), 'the pre-Ready Host must have bound acp.sock')
    assert(!exists(join(earlyScopeDir, 'instance.json')), 'no instance.json may exist while paused at the barrier')
    // Deliver SIGTERM while the Host is paused at the barrier, confirm the
    // admission recorded it (pendingStop is set by then), only then release.
    earlyHost.kill('SIGTERM')
    earlyHost.child.stdin.end()
    await earlyHost.waitFor(record => record.m4a0 === 'stop-requested', 'acp stop-during-bind stop-requested', 30_000)
    writeFileSync(stopBarrier, '')
    const earlyExit = await earlyHost.waitForExit(90_000)
    assert(earlyExit.code === 0 && earlyExit.signal === null, `stop-during-bind exit ${JSON.stringify(earlyExit)}`)
    assert(earlyHost.records.every(record => record.m4a0 !== 'ready'), 'stop-during-bind must never emit Ready')
    assert(!exists(join(earlyScopeDir, 'instance.json')), 'stop-during-bind must not commit instance.json')
    await waitUntil(() => !exists(earlySocket), 'acp.sock to retire after stop-during-bind')
    await seatFree(`\0dsh-pi-tui-h-${String(earlyScopeId).slice(0, 40)}`, 20_000)
    trace('acp/stop-during-bind', { ready: false, registryCommitted: false, socketRetired: true })

    // ── Phase 1: listen-before-registry + ACP semantics on ONE real Host ──────
    const barrier = join(workDir, `acp-bound-barrier-${String(process.pid)}`)
    const host1 = startHost({ SPLIT_PROCESS_HOST_ACP_BOUND_BARRIER: barrier, DSH_PI_TUI_ACP_MAX_CONNECTIONS: '4' }, 'acp barrier host')
    await host1.waitFor(record => record.m4a0 === 'qualification' && record.op === 'acp-bound-barrier', 'acp-bound barrier', 180_000)
    trace('acp/bound-barrier', { phase: 'bound', registryCommitted: false })

    const scopeDir = findScopeDirBySocket(dshHome)
    assert(scopeDir !== undefined, 'listenBeforeRegistry: the Host bound no acp.sock under its scope')
    const socketPath = join(scopeDir, 'acp.sock')
    const scopeId = scopeDir.split('/').pop()
    const listenerInfo = lstatSync(socketPath)
    assert(listenerInfo.isSocket(), 'the acp.sock path must be a socket')
    assert(listenerInfo.uid === process.getuid(), 'the acp socket must be owned by this uid')
    assert((listenerInfo.mode & 0o777) === 0o600, `the acp socket must be 0600, got ${(listenerInfo.mode & 0o777).toString(8)}`)
    assert((lstatSync(scopeDir).mode & 0o777) === 0o700, 'the scope directory must be 0700')
    assert(!exists(join(scopeDir, 'instance.json')), 'listenBeforeRegistry: instance.json must NOT exist before the barrier releases')
    assert(host1.records.every(record => record.m4a0 !== 'ready'), 'listenBeforeRegistry: no Ready before the barrier releases')

    // The socket answers a real ACP v1 initialize while the registry is absent.
    const c1 = await openAcpClient(scopeDir)
    const c2 = await openAcpClient(scopeDir)
    const c3 = await openAcpClient(scopeDir)
    const c4 = await openAcpClient(scopeDir)
    try {
      const init1 = await c1.initialize(1)
      assert(init1?.result?.protocolVersion === 1, 'initialize must answer protocolVersion 1')
      assert(init1?.result?.agentInfo?.name === 'dsh-pi-tui', 'agentInfo.name must be dsh-pi-tui')
      assert(init1?.result?.agentInfo?.version === installedVersion, `agentInfo.version must be the installed bundle version ${installedVersion}`)
      assert(Array.isArray(init1?.result?.authMethods) && init1.result.authMethods.length === 0, 'authMethods must be empty')
      assert(init1?.result?.agentCapabilities?.loadSession === false, 'loadSession must be false')

      // Independent connections reuse id 1 without cross-talk.
      const init2 = await c2.initialize(1)
      assert(init2?.result?.protocolVersion === 1, 'the second connection must answer its own id 1 initialize')
      await c3.initialize(1)
      await c4.initialize(1)

      // A fifth connection exceeds maxConnections=4 and receives the bounded capacity error.
      const c5 = await openAcpClient(scopeDir)
      const capacity = await c5.next()
      assert(capacity?.id === null, 'the capacity rejection must carry a null id')
      assert(capacity?.error?.code === -32041, 'the capacity rejection must use -32041')
      assert(capacity?.error?.data?.code === 'LOCAL_ACP_CAPACITY_EXCEEDED', 'the capacity rejection must name LOCAL_ACP_CAPACITY_EXCEEDED')
      await c5.closed

      // The STILL-unsupported Session methods fail closed; PO-2 now implements
      // `session/new|resume|close` on a real Host, so this raw socket contract
      // checks the methods that remain unimplemented. An oversized frame closes
      // only its own connection.
      c1.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 'unused', prompt: [] } })
      const promptReject = await c1.next()
      assert(promptReject?.error?.code === -32042, 'session/prompt must fail closed with -32042')
      assert(promptReject?.error?.data?.code === 'LOCAL_ACP_SESSION_NOT_READY', 'session/prompt must name LOCAL_ACP_SESSION_NOT_READY')
      c1.send({ jsonrpc: '2.0', id: 6, method: 'session/list', params: {} })
      const listReject = await c1.next()
      assert(listReject?.error?.code === -32042, 'session/list must fail closed with -32042')
      assert(listReject?.error?.data?.code === 'LOCAL_ACP_SESSION_NOT_READY', 'session/list must name LOCAL_ACP_SESSION_NOT_READY')

      c3.sendRaw('{"jsonrpc":"2.0","id":9,"method":"initialize","params":{"x":"')
      c3.sendRaw('a'.repeat(1024 * 1024 + 16))
      await c3.closed
      const afterOversize = await c2.initialize(2).catch(() => undefined)
      assert(afterOversize?.error?.code === -32043 || afterOversize?.result !== undefined,
        'a sibling connection must survive an oversized frame on another connection')

      // The Host stdout records never carry ACP wire bytes.
      assert(host1.records.every(record => record === null || typeof record !== 'object'
        || (!('jsonrpc' in record) && typeof record.method !== 'string')),
      'noTcpOrStdoutPollution: the Host stdout records must never carry ACP JSON-RPC')
      trace('acp/semantics', { protocolVersion: 1, capacity: 'enforced', sessionReject: 'fail-closed', oversize: 'isolated' })

      // Release the barrier: the Host commits the registry Ready AFTER the socket.
      writeFileSync(barrier, '')
      const ready = await waitReady(host1, 'acp barrier host ready')
      assert(ready.localHost?.scopeId === scopeId, 'the Ready registry must name the scope that owns acp.sock')
      assert(exists(join(scopeDir, 'instance.json')), 'hostReadyAfterAcp: instance.json must exist after Ready')
      const readyInit = await c2.initialize(3).catch(() => undefined)
      assert(readyInit?.error?.code === -32043, 'the still-open connection stays initialized after Ready (duplicate initialize is rejected)')
      trace('acp/ready', { readyAfterListen: true })

      // The original authenticated Split transport still works on this same Host.
      const registry = JSON.parse(readFileSync(join(scopeDir, 'instance.json'), 'utf8'))
      const launch = JSON.parse(readFileSync(join(scopeDir, 'launch.json'), 'utf8'))
      const cookie = await connectCookie(registry.origin, launch)
      const identityResponse = await fetchStatus(`${registry.origin}/api/pi-tui.local-host`, { headers: { cookie } })
      assert(identityResponse.status === 200, `the original identity route answered HTTP ${String(identityResponse.status)}`)
      const identity = JSON.parse(identityResponse.body)
      assert(identity.instanceId === registry.instanceId && identity.hostPid === registry.hostPid,
        'originalSplitClientIntact: the authenticated identity route must echo the same Host instance')

      // A REAL Split surface Client authenticates to this same Host while ACP is open.
      const client = new SurfaceEntryProcess(entries.client, { ...base, workDir })
      startedClients.push(client)
      const clientReady = await client.waitFor(record => record.m4a0 === 'ready', 'acp original split client ready', 180_000)
      assert(Number.isInteger(clientReady.pid), 'the original Split Client must publish a business PID on Ready')
      client.send('/exit\r')
      try { await client.waitForExit(60_000) } catch { await client.dispose() }
      trace('acp/original-client', { connected: true })
    } finally {
      c1.close()
      c2.close()
      c3.close()
      c4.close()
    }

    // SIGTERM stops accepting, retires the socket and keeps the official cleanup.
    // The smoke harness keeps the child's stdin pipe open (a real launcher's Host
    // stdin is /dev/null); close it so the SIGTERM-admitted Host can drain to exit.
    host1.kill('SIGTERM')
    host1.child.stdin.end()
    const stopExit = await host1.waitForExit(90_000)
    assert(stopExit.code === 0 && stopExit.signal === null, `SIGTERM stop ended as ${JSON.stringify(stopExit)}`)
    await waitUntil(() => !exists(socketPath), 'acp.sock to retire after SIGTERM')
    assert(!exists(join(scopeDir, 'instance.json')), 'stoppedAndUnlinked: instance.json must be removed after stop')
    await seatFree(`\0dsh-pi-tui-h-${scopeId.slice(0, 40)}`, 20_000)
    trace('acp/stop', { exit: stopExit.code, socketRetired: true })

    // ── Phase 2: SIGKILL leaves a stale inode that a new Host safely reclaims ──
    const hostA = startHost({}, 'acp stale host A')
    const readyA = await waitReady(hostA, 'acp stale host A ready')
    const scopeA = readyA.localHost.scopeId
    const socketA = socketPathOf(dshHome, scopeA)
    assert(exists(socketA), 'the first Host must have bound acp.sock')
    const pidA = readyA.localHost.hostPid
    hostA.kill('SIGKILL')
    await hostA.waitForExit(60_000)
    assert(exists(socketA), 'staleReclaimedSafely: SIGKILL must leave the socket inode behind')
    await seatFree(`\0dsh-pi-tui-h-${scopeA.slice(0, 40)}`, 20_000)

    const hostB = startHost({}, 'acp stale host B')
    const readyB = await waitReady(hostB, 'acp stale host B ready')
    assert(readyB.localHost.scopeId === scopeA, 'the reclaiming Host must own the same scope')
    assert(readyB.localHost.hostPid !== pidA, 'the reclaiming Host must be a new process')
    const staleClient = await openAcpClient(join(dshHome, 'run', 'dsh-pi-tui', scopeA))
    try {
      const init = await staleClient.initialize(1)
      assert(init?.result?.protocolVersion === 1, 'the reclaimed socket must serve initialize')
    } finally {
      staleClient.close()
    }
    hostB.kill('SIGTERM')
    hostB.child.stdin.end()
    const stopB = await hostB.waitForExit(90_000)
    assert(stopB.code === 0, `the reclaiming Host SIGTERM stop ended as ${JSON.stringify(stopB)}`)
    trace('acp/stale', { reclaimed: true })

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      acpVersionFromInstalledDsh: true,
      listenBeforeRegistry: true,
      permissions0700And0600: true,
      hostReadyAfterAcp: true,
      independentConnections: true,
      capacityAndBackpressure: true,
      unsupportedSessionMethodsFailClosed: true,
      stoppedAndUnlinked: true,
      staleReclaimedSafely: true,
      noTcpOrStdoutPollution: true,
      originalSplitClientIntact: true,
    }
  } catch (error) {
    originalError = error
    throw error
  } finally {
    for (const client of startedClients) {
      try { await client.dispose() } catch { /* the runner backstop owns leftovers */ }
    }
    for (const peer of startedPeers) {
      if (peer.exited) continue
      try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    for (const host of startedHosts) {
      if (host.exited) continue
      try { host.kill('SIGKILL') } catch { /* already gone */ }
      try { await host.waitForExit(30_000) } catch { /* the runner backstop owns leftovers */ }
    }
    // The profile-owned ACP startup preference is persistent state. Restore it to
    // Off through the REAL Settings wire on a fresh Host/Peer even when the case
    // failed after setting it, so a later case sees the documented default. Never
    // rewrite the preference file directly. Best effort: if the original error is
    // preserved, expose only the fixed recovery-failure category.
    let recoveryError
    if (prepScopeId !== undefined) {
      const hostBoundary = startedHosts.length
      const peerBoundary = startedPeers.length
      try {
        const resetHost = startHost({}, 'acp preference reset host')
        await waitReady(resetHost, 'acp preference reset host ready')
        const resetPeer = await startPeer('acp preference reset peer')
        const reset = await acpPreference(resetPeer, 'acp preference reset', false)
        assert(reset.ok === true && reset.autoStart === false && reset.readBack === true,
          `acp preference reset did not read back Off: ${JSON.stringify(reset)}`)
        trace('acp/preference-restored', { autoStart: false, readBack: true })
      } catch (error) {
        recoveryError = error
      } finally {
        for (const peer of startedPeers.slice(peerBoundary)) {
          if (peer.exited) continue
          try { await peer.shutdown() } catch { /* best effort */ }
        }
        for (const host of startedHosts.slice(hostBoundary)) {
          if (host.exited) continue
          try {
            host.kill('SIGTERM')
            host.child.stdin.end()
            await host.waitForExit(60_000)
          } catch {
            try { host.kill('SIGKILL') } catch { /* already gone */ }
          }
        }
      }
    }
    if (recoveryError !== undefined) {
      if (originalError === undefined) throw recoveryError
      trace('acp/preference-restore-failed', { result: 'recovery-failed-after-case-failure' })
    }
  }
}
