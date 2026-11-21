/**
 * PO-2 real-OS split-process qualification: the Host-owned ACP "shared Session
 * View" over the same `<scope.dir>/acp.sock` the PO-1/PO-1B front door owns.
 *
 * One REAL installed Host installs the connection-scoped Session View on top of
 * the ACP v1 listener. This case proves, from REAL processes and a REAL socket,
 * that an ACP connection can borrow a live Host Session that a REAL TUI Client
 * also references (without replacing or re-mounting the Host), that a second
 * connection cannot attach the same Session, that `session/close` detaches only
 * the caller's View (the TUI turn still settles), that `session/new` creates a
 * real Host Workspace + Session, that a physical socket teardown and a runtime
 * ACP Off both release the View, and that every still-unsupported or invalid
 * request stays fail-closed with its stable business code.
 *
 * Every fact comes from REAL processes and a REAL socket; a partial or NOT_RUN
 * sub-scenario returns a non-PASS verdict that fails the selected case. The
 * harness (never this module) prints the SELECTED_PASS line.
 *
 * @module split-process/acp-po2-session-view
 */

import { createRequire } from 'node:module'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { seatFree, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { createSplitSmokeProfile } from '../../lib/split-smoke-profile.mjs'

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

  next(timeoutMs = 30_000) {
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

function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
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

/**
 * Connect one raw ACP client through this process's OWN scope directory fd.
 * A real `DSH_HOME`/scope pathname commonly exceeds the Linux `sun_path` byte
 * limit, so connect through `/proc/self/fd/<fd>/acp.sock` instead.
 */
async function openAcpClient(scopeDir) {
  const dirFd = openSync(scopeDir, 'r')
  try {
    return await AcpRawClient.open(`/proc/self/fd/${String(dirFd)}/acp.sock`)
  } finally {
    closeSync(dirFd)
  }
}

function sendRequest(client, id, method, params) {
  client.send({ jsonrpc: '2.0', id, method, params })
  return client.next(30_000)
}

async function waitUntil(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new SplitSmokeAssertionError(`acp-po2: timed out waiting for ${label}`)
}

/** The Linux abstract seat name one Host scope claims for this profile. */
function seatName(scopeId) {
  return `\0dsh-pi-tui-h-${String(scopeId).slice(0, 40)}`
}

/** An empty-object ACP success result (`{}`), no error. */
function isObjectResult(message) {
  return message !== undefined
    && message.error === undefined
    && message.result !== undefined
    && typeof message.result === 'object'
    && message.result !== null
    && Object.keys(message.result).length === 0
}

/**
 * Run the PO-2 shared Session View real split-process qualification.
 * Every returned boolean is a fact gathered from a REAL process/socket.
 */
export async function runAcpPo2SessionView(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const installedVersion = installation.manifest.version
  const acpSdkVersion = (() => {
    try {
      const require = createRequire(import.meta.url)
      let dir = dirname(require.resolve('@agentclientprotocol/sdk'))
      for (let depth = 0; depth < 6; depth += 1) {
        const manifest = join(dir, 'package.json')
        if (existsSync(manifest)) {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
          if (parsed.name === '@agentclientprotocol/sdk' && typeof parsed.version === 'string') return parsed.version
        }
        dir = dirname(dir)
      }
      return 'unknown'
    } catch { return 'unknown' }
  })()
  const tuiPids = []
  const scene = createC1Scene(context)
  const {
    startC1Host,
    startC1Client,
    exitC1Client,
    hostIdentityFacts,
    hostRowFiberUids,
    assertHostRowsKept,
    assertHostIdentityKept,
    awaitSceneSeatFree,
  } = scene

  const peers = []
  const acpClients = []
  const extraHosts = []
  let sequence = 0
  let originalError
  let host

  const track = client => {
    acpClients.push(client)
    return client
  }
  const startPeer = async label => {
    const peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = label
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  const acpAccess = async (peer, label, value) => {
    const requestId = `acp-access-${String(++sequence)}-${String(process.pid)}`
    peer.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const assertAccess = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private ACP access call failed (${String(record.errorCode ?? 'unknown')})`)
    assert(record.status?.state === expected,
      `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
  }
  const openInitialized = async (scopeDir, label) => {
    const client = track(await openAcpClient(scopeDir))
    const init = await client.initialize(1)
    assert(init?.result?.protocolVersion === 1, `${label}: the socket must answer protocolVersion 1`)
    return { client, init }
  }
  /**
   * Resume one Session through fresh connections until the previous owner's
   * teardown has actually released the claim (bounded, no fabricated success).
   */
  const resumeEventually = async (scopeDir, sessionId, cwd, label) => {
    let last
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const client = track(await openAcpClient(scopeDir))
      const init = await client.initialize(1)
      assert(init?.result?.protocolVersion === 1, `${label}: initialize failed`)
      const result = await sendRequest(client, 2, 'session/resume', { sessionId, cwd })
      if (isObjectResult(result)) return { client, result }
      last = result
      client.close()
      await client.closed
      if (result?.error?.data?.code !== 'LOCAL_ACP_VIEW_ALREADY_ATTACHED') {
        assert(false, `${label}: session/resume did not succeed (${JSON.stringify(result?.error ?? result?.result)})`)
      }
      await sleep(50)
    }
    assert(false, `${label}: the Session never became resumable (${JSON.stringify(last?.error?.data ?? null)})`)
  }
  const identityFacts = async () => await hostIdentityFacts(host)
  const assertSameHost = async (before, label) => {
    const after = await identityFacts()
    assert(after.hostPid === before.hostPid,
      `${label}: the Host process was replaced (${String(before.hostPid)} -> ${String(after.hostPid)})`)
    assert(after.instanceId === before.instanceId,
      `${label}: the Host instanceId changed (${String(before.instanceId)} -> ${String(after.instanceId)})`)
    assertHostIdentityKept(host, before, label)
  }

  const scopeDirOf = scopeId => join(dshHome, 'run', 'dsh-pi-tui', scopeId)

  try {
    // ── A) Boot a real C1 Host, enable ACP via the peer toggle, prove the socket.
    const longTurnBarrier = join(workDir, `po2-long-turn-${String(process.pid)}.release`)
    // Pre-create the release barrier so the ONE controlled turn in (E) settles
    // immediately with a deterministic answer instead of holding the Agent.
    writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })
    const started = await startC1Host('long-turn', 'po2 A host', {
      C1_HOLD_LONG_TURN: longTurnBarrier,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    })
    host = started.host
    const ready = started.ready
    const scopeId = ready.localHost.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'the Host Ready must publish a full 64-character scope id')
    const scopeDir = scopeDirOf(scopeId)
    const socketPath = join(scopeDir, 'acp.sock')
    const hostCwd = realpathSync(workDir)
    trace('acp-po2/evidence-start', {
      candidateSha256: context.candidateSha256 ?? null,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion ?? null,
      bundleVersion: installedVersion,
      acpSdkVersion,
      hostPid: ready.localHost.hostPid,
      hostInstanceId: ready.localHost.instanceId,
      scopeId,
    })

    const peer = await startPeer('po2 A peer')
    assertAccess(await acpAccess(peer, 'A getStatus', undefined), 'disabled', 'A getStatus')
    assertAccess(await acpAccess(peer, 'A enable', true), 'enabled', 'A enable')
    assert(findScopeDirBySocket(dshHome) !== undefined, 'A: enabling ACP must bind acp.sock under the scope')
    assert(exists(socketPath), 'A: the bound acp.sock must exist in this Host scope')
    const sockInfo = lstatSync(socketPath)
    assert(sockInfo.isSocket(), 'A: the acp.sock path must be a socket')
    assert(sockInfo.uid === process.getuid(), 'A: the acp socket must be owned by this uid')
    assert((sockInfo.mode & 0o777) === 0o600, `A: the acp socket must be 0600, got ${(sockInfo.mode & 0o777).toString(8)}`)
    assert((lstatSync(scopeDir).mode & 0o777) === 0o700,
      `A: the scope directory must be 0700, got ${(lstatSync(scopeDir).mode & 0o777).toString(8)}`)

    // ── B) Create Session A in a REAL TUI Client via `/new`, then a raw ACP
    //      initialize must advertise resume + close and keep loadSession false.
    const { client: tuiA } = await startC1Client('po2 B tui', {}, { cwd: hostCwd })
    const tuiBoundary = tuiA.records.length
    tuiA.send('/new\r')
    const openA = await tuiA.waitFor(record => tuiA.records.indexOf(record) >= tuiBoundary
      && record.m4b2s === 'surface-status'
      && record.sessionOpen === true
      && typeof record.openSessionId === 'string'
      && record.openSessionId !== ''
      && record.transport === 'connected'
      && record.surfaceMounted === true, 'B: the real TUI opened an empty Session', 120_000)
    const sessionA = openA.openSessionId
    assert(typeof sessionA === 'string' && sessionA.length > 0, 'B: `/new` must publish an openSessionId')
    if (Number.isInteger(tuiA.child?.pid)) tuiPids.push({ role: 'tui-A', pid: tuiA.child.pid })

    const conn1 = track(await openAcpClient(scopeDir))
    const initA = await conn1.initialize(1)
    assert(initA?.result?.protocolVersion === 1, 'B: initialize must answer protocolVersion 1')
    assert(initA?.result?.agentInfo?.name === 'dsh-pi-tui', 'B: agentInfo.name must be dsh-pi-tui')
    assert(initA?.result?.agentInfo?.version === installedVersion,
      `B: agentInfo.version must be the installed bundle version ${installedVersion}`)
    assert(initA?.result?.agentCapabilities?.loadSession === false, 'B: loadSession must stay false')
    assert(initA?.result?.agentCapabilities?.sessionCapabilities?.resume !== undefined,
      'B: sessionCapabilities.resume must be advertised when the Session View is installed')
    assert(initA?.result?.agentCapabilities?.sessionCapabilities?.close !== undefined,
      'B: sessionCapabilities.close must be advertised when the Session View is installed')

    // ── C) `session/resume(A)` attaches the live Session to the ACP View while
    //      the REAL TUI still references it; Host identity + protected rows stand.
    const identityBeforeC = await identityFacts()
    const rowsBeforeC = await hostRowFiberUids(host)
    const resumeC = await sendRequest(conn1, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(isObjectResult(resumeC), `C: session/resume(A) must return {} (got ${JSON.stringify(resumeC?.error ?? resumeC?.result)})`)
    assert((tuiA.records.filter(record => record.m4b2s === 'surface-status').at(-1))?.openSessionId === sessionA,
      'C: the real TUI lost its reference to Session A after the ACP resume')
    await assertSameHost(identityBeforeC, 'C Host after ACP resume')
    await assertHostRowsKept(host, rowsBeforeC, 'C protected rows after ACP resume')

    // ── D) A SECOND raw connection cannot attach the same Session; the first is
    //      unaffected (it still owns the claim and can close it later).
    const { client: conn2 } = await openInitialized(scopeDir, 'D second connection')
    const conflict = await sendRequest(conn2, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(conflict?.error?.code === -32602,
      `D: a second resume must fail with -32602 (got ${JSON.stringify(conflict?.error ?? conflict?.result)})`)
    assert(conflict?.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
      `D: the second resume must name LOCAL_ACP_VIEW_ALREADY_ATTACHED (got ${JSON.stringify(conflict?.error?.data)})`)
    conn2.close()
    await conn2.closed

    // ── E) `session/close(A)` twice on the same connection is idempotent; the
    //      REAL TUI then completes one real Turn on A with a deterministic
    //      answer; Host identity + Agent-row fiber UID are unchanged; a NEW ACP
    //      connection resumes A again.
    const close1 = await sendRequest(conn1, 3, 'session/close', { sessionId: sessionA })
    assert(isObjectResult(close1), `E: the first session/close must return {} (got ${JSON.stringify(close1?.error ?? close1?.result)})`)
    const close2 = await sendRequest(conn1, 4, 'session/close', { sessionId: sessionA })
    assert(isObjectResult(close2), `E: a repeated session/close must return {} (got ${JSON.stringify(close2?.error ?? close2?.result)})`)
    conn1.close()
    await conn1.closed

    const eventsBeforeTurn = hostSessionEvents(dshHome, sessionA) ?? []
    const beforeTurn = eventsBeforeTurn.length
    const promptText = 'po2 durable turn'
    tuiA.send(`${promptText}\r`)
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeTurn, event => event.type === 'turn/end',
      'E: the TUI turn/end after the ACP close', 120_000)
    const eventsAfterTurn = hostSessionEvents(dshHome, sessionA) ?? []
    assert(hostUserTexts(eventsAfterTurn).filter(text => text === promptText).length === 1,
      'E: the prompt was replayed or lost')
    const expectedAnswer = `long-turn answer 1 long-turn-${sessionA}`
    assert(hostAssistantHasText(eventsAfterTurn, expectedAnswer),
      `E: the Host did not write the exact controlled answer ${JSON.stringify(expectedAnswer)}`)
    await assertSameHost(identityBeforeC, 'E Host after the TUI turn')
    await assertHostRowsKept(host, rowsBeforeC, 'E protected rows after the TUI turn')
    const headerA = await waitForHostSessionHeader(dshHome, sessionA, 'E: Session A durable header')
    assert(headerA.cwd === hostCwd,
      `E: Session A cwd must be the Host canonical workspace ${hostCwd} (got ${String(headerA.cwd)})`)

    const { client: conn3 } = await openInitialized(scopeDir, 'E third connection')
    const resumeE = await sendRequest(conn3, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(isObjectResult(resumeE), `E: a new connection must resume A again (got ${JSON.stringify(resumeE?.error ?? resumeE?.result)})`)

    // ── F) `session/new` creates ONE real Host Workspace + Session B; the
    //      Workspace membership is proven by a REAL TUI opening B; close(B) is
    //      only a View detach and B stays officially resumable.
    const newWorkspaceDir = join(workDir, 'po2-f-workspace')
    mkdirSync(newWorkspaceDir, { recursive: true, mode: 0o700 })
    const hostCwdNew = realpathSync(newWorkspaceDir)
    const { client: connNew } = await openInitialized(scopeDir, 'F session/new connection')
    const created = await sendRequest(connNew, 2, 'session/new', { cwd: hostCwdNew, mcpServers: [] })
    assert(created?.error === undefined && typeof created?.result?.sessionId === 'string' && created.result.sessionId !== '',
      `F: session/new must return a real sessionId (got ${JSON.stringify(created?.error ?? created?.result)})`)
    const sessionB = created.result.sessionId
    assert(sessionB !== sessionA, 'F: session/new must create a distinct Session')

    const { client: tuiB } = await startC1Client('po2 F tuiB', { SPLIT_PROCESS_CLIENT_SESSION: sessionB })
    await waitForSurfaceStatus(tuiB, record => record.sessionOpen === true
      && record.openSessionId === sessionB
      && record.surfaceMounted === true
      && record.transport === 'connected', 'F: a real TUI opened Session B')
    await exitC1Client(tuiB, 'F tuiB')
    const headerB = await waitForHostSessionHeader(dshHome, sessionB, 'F: Session B durable header')
    assert(headerB.cwd === hostCwdNew,
      `F: Session B must belong to the Host Workspace ${hostCwdNew} (got ${String(headerB.cwd)})`)

    const closeB = await sendRequest(connNew, 3, 'session/close', { sessionId: sessionB })
    assert(isObjectResult(closeB), `F: session/close(B) must return {} (got ${JSON.stringify(closeB?.error ?? closeB?.result)})`)
    connNew.close()
    await connNew.closed
    const { client: connResumeB } = await openInitialized(scopeDir, 'F resume B connection')
    const resumeB = await sendRequest(connResumeB, 2, 'session/resume', { sessionId: sessionB, cwd: hostCwdNew })
    assert(isObjectResult(resumeB),
      `F: B must stay resumable after close (got ${JSON.stringify(resumeB?.error ?? resumeB?.result)})`)

    // ── G) Destroying the ACP socket connection releases only its View; a later
    //      connection can resume A again and the TUI/Host are unaffected.
    conn3.close()
    await conn3.closed
    const resumeG = await resumeEventually(scopeDir, sessionA, hostCwd, 'G: resume A after a physical teardown')
    await assertSameHost(identityBeforeC, 'G Host after the ACP teardown')
    assert((tuiA.records.filter(record => record.m4b2s === 'surface-status').at(-1))?.openSessionId === sessionA,
      'G: the real TUI lost Session A after the ACP teardown')

    // ── H) Runtime ACP Off disconnects every ACP peer and retires the socket;
    //      ACP On re-binds and a new connection resumes A again; the Host stays.
    assertAccess(await acpAccess(peer, 'H off', false), 'disabled', 'H off')
    await waitUntil(() => !exists(socketPath), 'H: acp.sock to retire after runtime Off')
    await resumeG.client.closed
    await connResumeB.closed
    await assertSameHost(identityBeforeC, 'H Host after runtime Off')
    assertAccess(await acpAccess(peer, 'H on', true), 'enabled', 'H on')
    await waitUntil(() => exists(socketPath), 'H: acp.sock to re-bind after runtime On')
    const { client: conn5 } = await openInitialized(scopeDir, 'H re-enabled connection')
    const resumeH = await sendRequest(conn5, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(isObjectResult(resumeH),
      `H: a new connection must resume A after re-bind (got ${JSON.stringify(resumeH?.error ?? resumeH?.result)})`)
    await assertSameHost(identityBeforeC, 'H Host after re-bind')

    // ── H2) COLD resume across a REAL Host restart: stop the Host, keep the
    //       persisted Sessions, boot a NEW Host on the SAME profile, re-enable
    //       ACP, then resume the persisted Session A (with its real turn history)
    //       and the Workspace Session B from fresh connections, and open A in a
    //       real TUI. The original Host owner is gone; the durable history
    //       survives and the new Host is the single owner.
    const originalPid = identityBeforeC.hostPid
    await scene.stopC1Host(host)
    await awaitSceneSeatFree()
    const restarted = await startC1Host('long-turn', 'po2 cold host', {
      C1_HOLD_LONG_TURN: longTurnBarrier,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    })
    host = restarted.host
    const readyCold = restarted.ready
    assert(readyCold.localHost.scopeId === scopeId, 'H2: the cold Host must own the same profile scope')
    assert(readyCold.localHost.hostPid !== originalPid, 'H2: the cold Host must be a new OS process')
    const identityCold = await identityFacts()
    const peerCold = await startPeer('po2 cold peer')
    assertAccess(await acpAccess(peerCold, 'H2 cold enable', true), 'enabled', 'H2 cold enable')
    assert(exists(socketPath), 'H2: the cold Host must re-bind acp.sock')

    const { client: connColdA } = await openInitialized(scopeDir, 'H2 cold resume A')
    const coldResumeA = await sendRequest(connColdA, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(isObjectResult(coldResumeA),
      `H2: a cold Host must resume Session A (got ${JSON.stringify(coldResumeA?.error ?? coldResumeA?.result)})`)
    const coldEvents = hostSessionEvents(dshHome, sessionA) ?? []
    assert(hostAssistantHasText(coldEvents, expectedAnswer),
      'H2: the persisted Session A history must still carry the earlier controlled answer')
    connColdA.close()
    await connColdA.closed

    const { client: connColdB } = await openInitialized(scopeDir, 'H2 cold resume B')
    const coldResumeB = await sendRequest(connColdB, 2, 'session/resume', { sessionId: sessionB, cwd: hostCwdNew })
    assert(isObjectResult(coldResumeB),
      `H2: a cold Host must resume Session B (got ${JSON.stringify(coldResumeB?.error ?? coldResumeB?.result)})`)
    connColdB.close()
    await connColdB.closed

    const { client: tuiColdA } = await startC1Client('po2 cold tuiA', { SPLIT_PROCESS_CLIENT_SESSION: sessionA })
    if (Number.isInteger(tuiColdA.child?.pid)) tuiPids.push({ role: 'tui-cold-A', pid: tuiColdA.child.pid })
    await waitForSurfaceStatus(tuiColdA, record => record.sessionOpen === true
      && record.openSessionId === sessionA && record.surfaceMounted === true && record.transport === 'connected',
      'H2: a real TUI opened persisted Session A on the cold Host')
    await exitC1Client(tuiColdA, 'H2 cold tuiA')
    await assertSameHost(identityCold, 'H2 cold Host identity')

    // ── I-M) Every negative is isolated on its own connection.
    // I) uninitialized session/resume.
    const rawI = track(await openAcpClient(scopeDir))
    const uninit = await sendRequest(rawI, 5, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(uninit?.error?.code === -32042,
      `I: an uninitialized resume must be -32042 (got ${JSON.stringify(uninit?.error ?? uninit?.result)})`)
    assert(uninit?.error?.data?.code === 'LOCAL_ACP_VIEW_NOT_INITIALIZED',
      `I: an uninitialized resume must name LOCAL_ACP_VIEW_NOT_INITIALIZED (got ${JSON.stringify(uninit?.error?.data)})`)
    rawI.close()
    await rawI.closed

    // J) invalid (relative) cwd.
    const { client: connJ } = await openInitialized(scopeDir, 'J invalid cwd')
    const badCwd = await sendRequest(connJ, 2, 'session/resume', { sessionId: sessionA, cwd: 'relative/path' })
    assert(badCwd?.error?.code === -32602,
      `J: a relative cwd must be -32602 (got ${JSON.stringify(badCwd?.error ?? badCwd?.result)})`)
    assert(badCwd?.error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
      `J: a relative cwd must name LOCAL_ACP_VIEW_INVALID_REQUEST (got ${JSON.stringify(badCwd?.error?.data)})`)
    connJ.close()
    await connJ.closed

    // K) A REAL Session id created on ANOTHER profile/Host must be rejected here:
    //    this Host resolves ids ONLY through its own persistence, so a session
    //    that genuinely exists in a DIFFERENT profile is never found and never
    //    leaks across profiles. A second, fully independent isolated profile is
    //    installed under this case's work root; one Session is created on ITS
    //    Host; the id is then presented to the MAIN Host.
    const foreignWorkDir = join(workDir, 'po2-foreign-profile')
    mkdirSync(foreignWorkDir, { recursive: true, mode: 0o700 })
    const foreign = createSplitSmokeProfile({ tarball: context.tarball, targetDshVersion: context.targetDshVersion, workDir: foreignWorkDir })
    const foreignHost = new EntryProcess('host', foreign.entries.host, { ...foreign.base })
    extraHosts.push(foreignHost)
    const foreignReady = await foreignHost.waitFor(r => r.m4a0 === 'ready' || r.m4a0 === 'failure', 'K foreign Host ready', 180_000)
    assert(foreignReady.m4a0 === 'ready', `K: the foreign Host did not become Ready: ${JSON.stringify({ code: foreignReady.code, phase: foreignReady.phase })}`)
    const foreignPeer = new EntryProcess('peer', foreign.entries.client, { ...foreign.base, env: { ...foreign.base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' } })
    peers.push(foreignPeer)
    await foreignPeer.waitFor(r => r.m4a0 === 'ready', 'K foreign peer ready', 180_000)
    assertAccess(await acpAccess(foreignPeer, 'K foreign enable', true), 'enabled', 'K foreign enable')
    const foreignScopeDir = findScopeDirBySocket(foreign.dshHome)
    assert(foreignScopeDir !== undefined, 'K: the foreign Host bound no acp.sock')
    const foreignConn = await openAcpClient(foreignScopeDir)
    const foreignInit = await foreignConn.initialize(1)
    assert(foreignInit?.result?.protocolVersion === 1, 'K: the foreign socket must answer initialize')
    const foreignCreated = await sendRequest(foreignConn, 2, 'session/new', { cwd: realpathSync(foreignWorkDir), mcpServers: [] })
    assert(typeof foreignCreated?.result?.sessionId === 'string' && foreignCreated.result.sessionId !== '',
      `K: the foreign Host must create a real Session id (got ${JSON.stringify(foreignCreated?.error ?? foreignCreated?.result)})`)
    const foreignSessionId = foreignCreated.result.sessionId
    foreignConn.close()
    await foreignConn.closed
    await foreignHost.shutdown()
    await foreignPeer.shutdown()
    await seatFree(seatName(foreignReady.localHost.scopeId), 20_000)
    trace('acp-po2/foreign-profile', { foreignSessionId, foreignScopeId: foreignReady.localHost.scopeId })
    assert(foreignSessionId !== sessionA && foreignSessionId !== sessionB,
      'K: the foreign Session id must differ from this Host sessions')

    const { client: connK } = await openInitialized(scopeDir, 'K foreign session')
    const missing = await sendRequest(connK, 2, 'session/resume', { sessionId: foreignSessionId, cwd: hostCwd })
    assert(missing?.error?.code === -32602,
      `K: an unknown session must be -32602 (got ${JSON.stringify(missing?.error ?? missing?.result)})`)
    assert(missing?.error?.data?.code === 'LOCAL_ACP_VIEW_SESSION_NOT_FOUND',
      `K: an unknown session must name LOCAL_ACP_VIEW_SESSION_NOT_FOUND (got ${JSON.stringify(missing?.error?.data)})`)
    connK.close()
    await connK.closed

    // L) non-empty valid mcpServers on session/new.
    const { client: connL } = await openInitialized(scopeDir, 'L mcp servers')
    const mcpReject = await sendRequest(connL, 2, 'session/new', {
      cwd: hostCwdNew,
      mcpServers: [{ name: 'po2-mcp', command: '/bin/true', args: [], env: [] }],
    })
    assert(mcpReject?.error?.code === -32602,
      `L: non-empty mcpServers must be -32602 (got ${JSON.stringify(mcpReject?.error ?? mcpReject?.result)})`)
    assert(mcpReject?.error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
      `L: non-empty mcpServers must name LOCAL_ACP_VIEW_INVALID_REQUEST (got ${JSON.stringify(mcpReject?.error?.data)})`)
    connL.close()
    await connL.closed

    // M) PO-3A admits prompts only on an ATTACHED View: a prompt from a
    //    connection that holds no View for that Session stays fail-closed.
    //    session/list stays unsupported.
    const { client: connM } = await openInitialized(scopeDir, 'M unsupported methods')
    const promptReject = await sendRequest(connM, 2, 'session/prompt', { sessionId: sessionA, prompt: [{ type: 'text', text: 'hi' }] })
    assert(promptReject?.error?.code === -32602,
      `M: an unattached session/prompt must be -32602 (got ${JSON.stringify(promptReject?.error ?? promptReject?.result)})`)
    assert(promptReject?.error?.data?.code === 'LOCAL_ACP_VIEW_NOT_OWNED',
      `M: an unattached session/prompt must name LOCAL_ACP_VIEW_NOT_OWNED (got ${JSON.stringify(promptReject?.error?.data)})`)
    const listReject = await sendRequest(connM, 3, 'session/list', {})
    assert(listReject?.error?.code === -32042,
      `M: session/list must be -32042 (got ${JSON.stringify(listReject?.error ?? listReject?.result)})`)
    assert(listReject?.error?.data?.code === 'LOCAL_ACP_SESSION_NOT_READY',
      `M: session/list must name LOCAL_ACP_SESSION_NOT_READY (got ${JSON.stringify(listReject?.error?.data)})`)
    connM.close()
    await connM.closed

    await assertSameHost(identityCold, 'final Host after all negatives')

    // The L6 evidence is MANDATORY, not decorative: a missing/unresolvable value
    // fails the PASS rather than reporting a hollow result.
    const evidence = {
      candidateSha256: context.candidateSha256,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion,
      bundleVersion: installedVersion,
      acpSdkVersion,
      hostPidStart: ready.localHost.hostPid,
      hostInstanceIdStart: ready.localHost.instanceId,
      hostPidCold: identityCold.hostPid,
      hostInstanceIdCold: identityCold.instanceId,
      scopeId,
      tuiPids,
      acpClientProcessPid: process.pid,
      sessionA,
      sessionB,
      foreignSessionId,
      turnEndObserved: true,
    }
    assert(typeof evidence.candidateSha256 === 'string' && /^[0-9a-f]{64}$/u.test(evidence.candidateSha256),
      'evidence: candidate SHA256 must be a real 64-hex digest')
    assert(typeof evidence.dshVersion === 'string' && evidence.dshVersion.length > 0,
      'evidence: target DSH version must be recorded')
    assert(evidence.acpSdkVersion !== 'unknown' && evidence.acpSdkVersion.length > 0,
      'evidence: ACP SDK version must be resolvable')
    assert(Number.isInteger(evidence.hostPidStart) && Number.isInteger(evidence.hostPidCold)
      && evidence.hostPidStart !== evidence.hostPidCold,
      'evidence: start/cold Host pids must be real and distinct')
    assert(tuiPids.length >= 2 && tuiPids.every(entry => Number.isInteger(entry.pid)),
      'evidence: at least two real TUI OS process pids must be recorded')
    assert(Number.isInteger(evidence.acpClientProcessPid),
      'evidence: the ACP client OS process pid must be recorded')
    assert(typeof evidence.sessionA === 'string' && typeof evidence.sessionB === 'string'
      && typeof evidence.foreignSessionId === 'string' && evidence.foreignSessionId.length > 0,
      'evidence: session ids must be recorded')

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      acpVersionFromInstalledDsh: true,
      socketPermissions0700And0600: true,
      tuiAndAcpShareSession: true,
      secondConnectionConflict: true,
      closeReleasesOnlyView: true,
      tuiTurnAfterClose: true,
      newSessionViaHostWorkspace: true,
      closeKeepsSessionResumable: true,
      coldRestartResume: true,
      disconnectReleasesView: true,
      runtimeToggleDisconnects: true,
      negativesRejected: true,
      hostIdentityKept: true,
      originalSplitClientIntact: true,
      l6EvidenceRecorded: true,
      evidence,
    }
  } catch (error) {
    originalError = error
    throw error
  } finally {
    for (const client of acpClients) {
      try { client.close() } catch { /* already gone */ }
    }
    for (const peerProcess of peers) {
      if (peerProcess.exited) continue
      try { await peerProcess.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    for (const extraHost of extraHosts) {
      if (extraHost.exited) continue
      try { await extraHost.kill('SIGKILL') } catch { /* already gone */ }
      try { await extraHost.waitForExit(30_000) } catch { /* the runner backstop owns leftovers */ }
    }
    try { await scene.dispose() } catch { /* the global backstop owns leftovers */ }
    try { await awaitSceneSeatFree().catch(() => {}) } catch { /* seat proof is best effort on failure */ }
    void originalError
  }
}
