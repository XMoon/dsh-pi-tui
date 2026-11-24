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
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { seatFree, waitForCondition, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
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

/** The C1 offline fixture provider and its two advertised routes. */
const MODEL_PROVIDER = 'c1-qualification'
const MODEL_A = 'c1'
const MODEL_B = 'c1-model-b'

/** The opaque ACP model select value of one exact route. */
function modelValue(modelId) {
  return JSON.stringify([MODEL_PROVIDER, modelId])
}

async function waitForScreenText(client, text, label, timeoutMs = 120_000) {
  try {
    await waitForCondition(async () => (await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the ${JSON.stringify(text)} surface never appeared`, { cause: error })
  }
}

async function waitForScreenGone(client, text, label, timeoutMs = 120_000) {
  try {
    await waitForCondition(async () => !(await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the ${JSON.stringify(text)} surface never closed`, { cause: error })
  }
}

/** Choose one model for the CURRENT live Session through the real `/model` panel. */
async function selectModelInTui(client, modelId, label, effortConfirm = false) {
  client.send('\x15')
  await sleep(150)
  client.send('/model\r')
  await waitForScreenText(client, 'Models', `${label} model panel`)
  await waitForCondition(async () => {
    const frame = (await client.viewport()).join('\n')
    return frame.includes('Models') && !frame.includes('Loading models')
  }, `${label} model directory`, 120_000)
  client.send(modelId)
  // The picker marks the selected row with `> `. Wait for the exact target row
  // to carry that marker, not merely for its text to appear somewhere (the
  // other model id may contain this id as a prefix).
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const selectedRow = new RegExp(`(?:^|\\s)>\\s+${escaped}(?![\\w-])`, 'u')
  await waitForCondition(async () => {
    const frame = await client.viewport()
    return frame.some(line => selectedRow.test(line))
  }, `${label} selected model`, 120_000)
  client.send('\r')
  if (effortConfirm) {
    await waitForScreenText(client, 'Reasoning Effort', `${label} effort strip`)
    client.send('\r')
  }
  await waitForScreenGone(client, 'Models', `${label} picker commit`)
}

/** The current `model` config option of one ACP configOptions array. */
function modelConfigOption(configOptions) {
  const option = configOptions?.find(candidate => candidate.id === 'model')
  assert(option !== undefined, 'the ACP response must carry the standard model config option')
  return option
}

/** The optional `thought_level` config option of one ACP configOptions array. */
function thoughtLevelOption(configOptions) {
  return configOptions?.find(candidate => candidate.id === 'thought_level')
}

/** One raw NDJSON JSON-RPC client over a real UDS connection. */
class AcpRawClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.queue = []
    this.notifications = []
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

  /** Send one request and return ITS response, retaining interleaved notifications in order. */
  async request(id, method, params, timeoutMs = 30_000) {
    this.send({ jsonrpc: '2.0', id, method, params })
    for (;;) {
      const message = await this.next(timeoutMs)
      if (message?.id === id) return message
      this.notifications.push(message)
    }
  }

  /** The next non-catalog notification already retained, or a fresh inbound message. */
  async nextNotification(timeoutMs = 30_000) {
    while (this.notifications.length > 0) {
      const notification = this.notifications.shift()
      if (notification?.params?.update?.sessionUpdate !== 'available_commands_update') return notification
    }
    while (true) {
      const notification = await this.next(timeoutMs)
      if (notification?.params?.update?.sessionUpdate !== 'available_commands_update') return notification
    }
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
  return client.request(id, method, params)
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

/** A session/resume success may carry the optional `configOptions` payload. */
function isAttachResult(message) {
  if (message === undefined || message.error !== undefined) return false
  const result = message.result
  if (result === undefined || typeof result !== 'object' || result === null) return false
  const keys = Object.keys(result)
  if (keys.some(key => key !== 'configOptions')) return false
  return result.configOptions === undefined || Array.isArray(result.configOptions)
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
      if (isAttachResult(result)) return { client, result }
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
      C1_EXTRA_MODEL: MODEL_B,
      C1_MODEL_S1_ROUTE: MODEL_B,
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
    // G-ACP2-PR2: canonical history/roster reads are advertised when bound.
    assert(initA?.result?.agentCapabilities?.loadSession === true, 'B: a read-seam-ready Host advertises session/load')
    assert(initA?.result?.agentCapabilities?.sessionCapabilities?.list !== undefined, 'B: and session/list')
    assert(initA?.result?.agentCapabilities?.sessionCapabilities?.resume !== undefined,
      'B: sessionCapabilities.resume must be advertised when the Session View is installed')
    assert(initA?.result?.agentCapabilities?.sessionCapabilities?.close !== undefined,
      'B: sessionCapabilities.close must be advertised when the Session View is installed')

    // ── C) `session/resume(A)` attaches the live Session to the ACP View while
    //      the REAL TUI still references it; Host identity + protected rows stand.
    const identityBeforeC = await identityFacts()
    const rowsBeforeC = await hostRowFiberUids(host)
    const resumeC = await sendRequest(conn1, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(isAttachResult(resumeC), `C: session/resume(A) must return an attach result (got ${JSON.stringify(resumeC?.error ?? resumeC?.result)})`)
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
    assert(isAttachResult(resumeE), `E: a new connection must resume A again (got ${JSON.stringify(resumeE?.error ?? resumeE?.result)})`)

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
    assert(isAttachResult(resumeB),
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
    assert(isAttachResult(resumeH),
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
      C1_EXTRA_MODEL: MODEL_B,
      C1_MODEL_S1_ROUTE: MODEL_B,
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
    assert(isAttachResult(coldResumeA),
      `H2: a cold Host must resume Session A (got ${JSON.stringify(coldResumeA?.error ?? coldResumeA?.result)})`)
    const coldEvents = hostSessionEvents(dshHome, sessionA) ?? []
    assert(hostAssistantHasText(coldEvents, expectedAnswer),
      'H2: the persisted Session A history must still carry the earlier controlled answer')
    connColdA.close()
    await connColdA.closed

    const { client: connColdB } = await openInitialized(scopeDir, 'H2 cold resume B')
    const coldResumeB = await sendRequest(connColdB, 2, 'session/resume', { sessionId: sessionB, cwd: hostCwdNew })
    assert(isAttachResult(coldResumeB),
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

    // ── Model-S1) ACP-only Session model configuration over the SAME cold Host.
    //    The C1 fixture advertises its base route `c1` plus the extra
    //    `c1-model-b`; the real Profile default remains `c1`.
    const { client: tuiModelA } = await startC1Client('po2 Model-S1 tuiA', { SPLIT_PROCESS_CLIENT_SESSION: sessionA })
    if (Number.isInteger(tuiModelA.child?.pid)) tuiPids.push({ role: 'tui-model-A', pid: tuiModelA.child.pid })
    await waitForSurfaceStatus(tuiModelA, record => record.sessionOpen === true
      && record.openSessionId === sessionA && record.surfaceMounted === true && record.transport === 'connected',
      'Model-S1: a real TUI opened Session A')

    const { client: connModel } = await openInitialized(scopeDir, 'Model-S1 resume A')
    const resumeModel = await sendRequest(connModel, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(isAttachResult(resumeModel),
      `Model-S1: session/resume(A) must return an attach result (got ${JSON.stringify(resumeModel?.error ?? resumeModel?.result)})`)
    const initialModelOption = modelConfigOption(resumeModel.result?.configOptions)
    assert(initialModelOption.currentValue === modelValue(MODEL_A),
      `Model-S1: current model must be the Session route A (got ${String(initialModelOption.currentValue)})`)
    const initialModels = (initialModelOption.options ?? []).flatMap(group => group.options ?? [])
    assert(initialModels.some(option => option.value === modelValue(MODEL_B)),
      'Model-S1: the catalog must advertise the extra fixture route B')

    // The standard SDK v1 set request writes only the Session selection; the
    // durable `model/selection` record is the Session commit fact.
    const beforeModelSet = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const setB = await sendRequest(connModel, 3, 'session/set_config_option', {
      sessionId: sessionA, configId: 'model', value: modelValue(MODEL_B),
    })
    assert(setB?.error === undefined,
      `Model-S1: set_config_option(model B) failed: ${JSON.stringify(setB?.error ?? setB?.result)}`)
    assert(modelConfigOption(setB.result?.configOptions).currentValue === modelValue(MODEL_B),
      'Model-S1: the success response must carry the complete new option state')
    assert(thoughtLevelOption(setB.result?.configOptions)?.currentValue === JSON.stringify(['default']),
      'Model-S1: model B must advertise the default thought_level option')
    // The committed model/selection event is also delivered as the standard
    // full-option update on this same attached View.
    const selfUpdate = await connModel.nextNotification(30_000)
    assert(selfUpdate?.method === 'session/update'
      && selfUpdate?.params?.update?.sessionUpdate === 'config_option_update',
      'Model-S1: the committed ACP write must produce the standard config update')
    assert(modelConfigOption(selfUpdate.params.update.configOptions).currentValue === modelValue(MODEL_B),
      'Model-S1: the self config update must carry B')
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeModelSet,
      event => event.type === 'model/selection' && event.data?.provider === MODEL_PROVIDER && event.data?.model === MODEL_B,
      'Model-S1: durable model/selection B')

    // ACP effort selection on the SAME route must persist the explicit effort
    // through the real Host Agent, not just a fake selector.
    const beforeEffortSet = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const setEffort = await sendRequest(connModel, 4, 'session/set_config_option', {
      sessionId: sessionA, configId: 'thought_level', value: JSON.stringify(['effort', 'high']),
    })
    assert(setEffort?.error === undefined,
      `Model-S1: set thought_level(high) failed: ${JSON.stringify(setEffort?.error ?? setEffort?.result)}`)
    assert(thoughtLevelOption(setEffort.result?.configOptions)?.currentValue === JSON.stringify(['effort', 'high']),
      'Model-S1: the effort response must carry the explicit high effort')
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeEffortSet,
      event => event.type === 'model/selection' && event.data?.provider === MODEL_PROVIDER
        && event.data?.model === MODEL_B && event.data?.reasoningEffort === 'high',
      'Model-S1: durable model/selection B with effort high')

    // A real TUI turn on the SAME Session must route to B (durable header).
    const beforeModelTurn = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiModelA.send('model-s1 turn on model B\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeModelTurn, event => event.type === 'turn/end',
      'Model-S1: TUI turn/end on B', 120_000)
    const modelTurnEvents = hostSessionEvents(dshHome, sessionA) ?? []
    const modelTurnHeader = modelTurnEvents.slice(beforeModelTurn).find(event => event.type === 'request/header')
    assert(modelTurnHeader?.data?.header?.config?.provider === MODEL_PROVIDER
      && modelTurnHeader?.data?.header?.config?.model === MODEL_B,
      `Model-S1: the real TUI turn must route to B (got ${JSON.stringify(modelTurnHeader?.data?.header?.config ?? null)})`)

    // A repeated resume on a NEW connection reads the same durable Session value.
    const closeModel = await sendRequest(connModel, 5, 'session/close', { sessionId: sessionA })
    assert(isObjectResult(closeModel), 'Model-S1: closing the ACP View must return {}')
    connModel.close()
    await connModel.closed
    const { client: connModelResume } = await openInitialized(scopeDir, 'Model-S1 repeat resume A')
    const repeated = await sendRequest(connModelResume, 2, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    assert(isAttachResult(repeated), 'Model-S1: second resume must attach')
    assert(modelConfigOption(repeated.result?.configOptions).currentValue === modelValue(MODEL_B),
      'Model-S1: a new resume must read B from the durable Session, not the Profile default')
    assert(thoughtLevelOption(repeated.result?.configOptions)?.currentValue === JSON.stringify(['effort', 'high']),
      'Model-S1: a new resume must read the durable explicit effort high')

    // A brand-new Session C must still be created from the untouched Profile
    // default A; it also runs one real TUI turn so the route is durable.
    const { client: connC } = await openInitialized(scopeDir, 'Model-S1 new Session C')
    const createdC = await sendRequest(connC, 2, 'session/new', { cwd: hostCwdNew, mcpServers: [] })
    assert(createdC?.error === undefined && typeof createdC?.result?.sessionId === 'string',
      `Model-S1: session/new C failed: ${JSON.stringify(createdC?.error ?? createdC?.result)}`)
    const sessionC = createdC.result.sessionId
    assert(sessionC !== sessionA && sessionC !== sessionB, 'Model-S1: Session C must be distinct')
    assert(modelConfigOption(createdC.result?.configOptions).currentValue === modelValue(MODEL_A),
      'Model-S1: Session C must start from the original Profile default A')
    assert(thoughtLevelOption(createdC.result?.configOptions) === undefined,
      'Model-S1: the no-effort default route must not advertise thought_level')
    connC.close()
    await connC.closed

    const { client: tuiC } = await startC1Client('po2 Model-S1 tuiC', { SPLIT_PROCESS_CLIENT_SESSION: sessionC })
    if (Number.isInteger(tuiC.child?.pid)) tuiPids.push({ role: 'tui-model-C', pid: tuiC.child.pid })
    await waitForSurfaceStatus(tuiC, record => record.sessionOpen === true
      && record.openSessionId === sessionC && record.surfaceMounted === true && record.transport === 'connected',
      'Model-S1: a real TUI opened Session C')
    const beforeCTurn = (hostSessionEvents(dshHome, sessionC) ?? []).length
    tuiC.send('model-s1 default A turn\r')
    await waitForHostSessionEventAfter(dshHome, sessionC, beforeCTurn, event => event.type === 'turn/end',
      'Model-S1: TUI turn/end on C', 120_000)
    const cTurnEvents = hostSessionEvents(dshHome, sessionC) ?? []
    const cTurnHeader = cTurnEvents.slice(beforeCTurn).find(event => event.type === 'request/header')
    assert(cTurnHeader?.data?.header?.config?.model === MODEL_A,
      `Model-S1: Session C must run on the Profile default A (got ${JSON.stringify(cTurnHeader?.data?.header?.config ?? null)})`)
    await exitC1Client(tuiC, 'Model-S1 tuiC')

    // While a REAL TUI turn owns the Agent, an ACP model write must fail BUSY
    // without cancelling the turn. This runs while the current session route is
    // still MODEL_B, so the fixture's Model-S1-only context capacity covers the
    // real turn; the later TUI route change to MODEL_A has no turn.
    unlinkSync(longTurnBarrier)
    const beforeBusyTurn = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiModelA.send('model-s1 held busy turn\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeBusyTurn,
      event => event.type === 'user/message' && JSON.stringify(event).includes('model-s1 held busy turn'),
      'Model-S1: the held TUI prompt is durable')
    const beforeBusySet = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const busySet = await sendRequest(connModelResume, 30, 'session/set_config_option', {
      sessionId: sessionA, configId: 'model', value: modelValue(MODEL_B),
    })
    assert(busySet?.error?.code === -32046,
      `Model-S1: an active Agent must reject with -32046 (got ${JSON.stringify(busySet?.error ?? busySet?.result)})`)
    assert(busySet?.error?.data?.code === 'LOCAL_ACP_MODEL_AGENT_BUSY',
      `Model-S1: the busy rejection must name LOCAL_ACP_MODEL_AGENT_BUSY (got ${JSON.stringify(busySet?.error?.data)})`)
    const busyEvents = hostSessionEvents(dshHome, sessionA) ?? []
    assert(busyEvents.slice(beforeBusySet).every(event => event.type !== 'model/selection'),
      'Model-S1: the busy rejection must not append a model/selection event')
    writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeBusyTurn, event => event.type === 'turn/end',
      'Model-S1: the held turn must complete after release', 120_000)
    const busyTurnEvents = hostSessionEvents(dshHome, sessionA) ?? []
    assert(hostAssistantHasText(busyTurnEvents.slice(beforeBusyTurn), 'long-turn answer'),
      'Model-S1: the held TUI turn must complete with its real answer')

    // Switching to the no-effort model A must remove thought_level from the
    // complete option state and persist the model change.
    const beforeNoEffort = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const setNoEffort = await sendRequest(connModelResume, 31, 'session/set_config_option', {
      sessionId: sessionA, configId: 'model', value: modelValue(MODEL_A),
    })
    assert(setNoEffort?.error === undefined,
      `Model-S1: set model A failed: ${JSON.stringify(setNoEffort?.error ?? setNoEffort?.result)}`)
    assert(thoughtLevelOption(setNoEffort.result?.configOptions) === undefined,
      'Model-S1: the no-effort model A must remove thought_level')
    const noEffortSelfUpdate = await connModelResume.nextNotification(30_000)
    assert(modelConfigOption(noEffortSelfUpdate?.params?.update?.configOptions).currentValue === modelValue(MODEL_A),
      'Model-S1: model A change must produce a full config update')
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeNoEffort,
      event => event.type === 'model/selection' && event.data?.provider === MODEL_PROVIDER && event.data?.model === MODEL_A,
      'Model-S1: durable model/selection A')

    // A real TUI `/model` change on Session A must reach the attached ACP View
    // as one full `config_option_update`.
    await selectModelInTui(tuiModelA, MODEL_B, 'Model-S1 TUI model change B', true)
    const configUpdate = (await connModelResume.nextNotification(30_000))
    assert(configUpdate?.method === 'session/update', 'Model-S1: the ACP connection must receive a config notification')
    assert(configUpdate?.params?.sessionId === sessionA, 'Model-S1: the config notification must be for Session A')
    assert(configUpdate?.params?.update?.sessionUpdate === 'config_option_update',
      'Model-S1: the notification must be config_option_update')
    assert(modelConfigOption(configUpdate.params.update.configOptions).currentValue === modelValue(MODEL_B),
      'Model-S1: the TUI change must be reflected as B')
    tuiModelA.send('\x15')
    await exitC1Client(tuiModelA, 'Model-S1 tuiA')
    connModelResume.close()
    await connModelResume.closed

    // ── I-M) Every negative is isolated on its own connection.
    // I) uninitialized session/resume.
    const rawI = track(await openAcpClient(scopeDir))
    const uninit = await sendRequest(rawI, 5, 'session/resume', { sessionId: sessionA, cwd: hostCwd })
    // A Session call before the handshake completes is a JSON-RPC invalid
    // request refused by the SDK's OWN connection gate before any product
    // handler runs: no Session is created and no LOCAL_ACP_* data exists there.
    assert(uninit?.error?.code === -32600,
      `I: an uninitialized resume must be a JSON-RPC invalid request (got ${JSON.stringify(uninit?.error ?? uninit?.result)})`)
    assert(typeof uninit?.error?.message === 'string' && uninit.error.message.includes('must be initialized before'),
      `I: the refusal must come from the connection initialization gate (got ${JSON.stringify(uninit?.error?.message)})`)
    assert(uninit?.error?.data === undefined,
      `I: the pre-handshake refusal carries no product data code (got ${JSON.stringify(uninit?.error?.data)})`)
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
    // The current contract MOUNTS an ACP mcpServers declaration through the
    // official Agent-scoped MCP client, so a declaration that cannot start is a
    // real scoped-MCP failure (a stable code), never a silent success.
    assert(mcpReject?.error?.code === -32603,
      `L: a non-startable mcpServers declaration must fail closed (got ${JSON.stringify(mcpReject?.error ?? mcpReject?.result)})`)
    assert(mcpReject?.error?.data?.code === 'LOCAL_ACP_MCP_START_FAILED',
      `L: a non-startable mcpServers declaration must name LOCAL_ACP_MCP_START_FAILED (got ${JSON.stringify(mcpReject?.error?.data)})`)
    connL.close()
    await connL.closed

    // M) PO-3A admits prompts only on an ATTACHED View: a prompt from a
    //    connection that holds no View for that Session stays fail-closed.
    //    session/list reads the authorized roster without owning any View.
    const { client: connM } = await openInitialized(scopeDir, 'M unsupported methods')
    const promptReject = await sendRequest(connM, 2, 'session/prompt', { sessionId: sessionA, prompt: [{ type: 'text', text: 'hi' }] })
    assert(promptReject?.error?.code === -32602,
      `M: an unattached session/prompt must be -32602 (got ${JSON.stringify(promptReject?.error ?? promptReject?.result)})`)
    assert(promptReject?.error?.data?.code === 'LOCAL_ACP_VIEW_NOT_OWNED',
      `M: an unattached session/prompt must name LOCAL_ACP_VIEW_NOT_OWNED (got ${JSON.stringify(promptReject?.error?.data)})`)
    const listed = await sendRequest(connM, 3, 'session/list', {})
    const listedIds = (listed?.result?.sessions ?? []).map(session => session.sessionId)
    assert(Array.isArray(listed?.result?.sessions),
      `M: session/list must serve the authorized roster (got ${JSON.stringify(listed?.error ?? listed?.result)})`)
    assert(listedIds.includes(sessionA),
      `M: the authorized roster must carry this Host's root Session (got ${JSON.stringify(listedIds)})`)
    assert((listed?.result?.sessions ?? []).every(session => typeof session.cwd === 'string' && session.cwd.startsWith('/')),
      'M: every listed row carries a standard absolute cwd')
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
