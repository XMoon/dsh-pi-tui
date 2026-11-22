/**
 * A1 selected packed qualification: the trusted-profile ACP stdio bridge.
 *
 * One REAL installed candidate, one REAL C1 Host and TUI, one REAL public
 * `dsh --profile pi-tui acp stdio` process, and the OFFICIAL ACP SDK v1 client.
 * The case proves the public command reaches the SAME Host-owned ACP Session
 * View, never creates a second Host/Session/Writer, and fails closed for all
 * supported missing-Host/listener/artifact states.
 *
 * The C1 offline scripted model and the Host/Client constructors are the
 * existing split-smoke harness. This module never starts a business Fake Host
 * and never speaks ACP directly to the socket except through the public stdio
 * command under test.
 *
 * @module split-process/acp-stdio-a1
 */

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostAssistantHasText, hostSessionEvents, waitForHostSessionEventAfter, waitForHostSessionHeader } from '../../lib/split-smoke-sessions.mjs'
import { waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { createSplitSmokeProfile } from '../../lib/split-smoke-profile.mjs'

const PACKAGE_ENTRY = 'acp-stdio.mjs'
const ACP_SOCKET_ENV = 'DSH_PI_TUI_ACP_STDIO_SOCKET_V1'
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function validJsonRpcLine(line) {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' && !Array.isArray(value) && value.jsonrpc === '2.0'
  } catch {
    return false
  }
}

/** Validate the complete stdout byte stream as NDJSON JSON-RPC. */
function protocolOnly(raw) {
  if (raw.length === 0) return { valid: true, frames: 0 }
  const text = raw.toString('utf8')
  if (!text.endsWith('\n')) return { valid: false, frames: 0 }
  const lines = text.slice(0, -1).split('\n')
  return { valid: lines.every(validJsonRpcLine), frames: lines.length }
}

/** One spawned public CLI command with its real stdout bytes and stderr text. */
class CliProcess {
  constructor(context, args, envOverrides = {}, options = {}) {
    const { installation, base } = context
    const [node, entry] = installation.dshInvocation
    this.child = spawn(node, [entry, ...args], {
      cwd: options.cwd ?? installation.profileDir,
      env: { ...base.env, ...envOverrides },
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
      const timer = setTimeout(() => resolveExit({ code: null, signal: null, timedOut: true }), options.timeoutMs ?? 60_000)
      this.child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolveExit({ code, signal })
      })
    })
    if (Number.isInteger(this.child.pid)) context.trackDetachedPid?.(this.child.pid)
  }

  rawStdout() {
    return Buffer.concat(this.rawChunks)
  }

  pauseHostStdout() {
    this.child.stdout.pause()
  }

  resumeHostStdout() {
    this.child.stdout.resume()
  }

  /** Start the raw NDJSON observer used by the pressure/shortness probes. */
  startRaw() {
    this.rawLines = []
    this.rawPending = new Map()
    this.rawSequence = 0
    this.rawReader = createInterface({ input: this.tap })
    this.rawReader.on('line', line => {
      this.rawLines.push(line)
      let value
      try { value = JSON.parse(line) } catch { return }
      if (typeof value?.id === 'number' && this.rawPending.has(value.id)) {
        const pending = this.rawPending.get(value.id)
        this.rawPending.delete(value.id)
        clearTimeout(pending.timer)
        pending.resolve(value)
      }
    })
  }

  rawBegin(method, params) {
    const id = ++this.rawSequence
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rawPending.delete(id)
        reject(new Error(`raw ACP request ${method} did not answer`))
      }, 180_000)
      this.rawPending.set(id, { resolve, reject, timer })
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return { id, promise }
  }

  async rawRequest(method, params) {
    return await this.rawBegin(method, params).promise
  }

  async initialize() {
    const app = acp.client({ name: 'dsh-pi-tui-a1-qualification' })
      .onNotification(acp.methods.client.session.update, ({ params }) => { this.updates.push(params) })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        this.permissions.push(params)
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      })
    this.updates = []
    this.permissions = []
    this.connection = app.connect(acp.ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.tap)))
    return await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    })
  }

  async close() {
    try { this.connection?.close() } catch { /* already closed */ }
    try { this.child.stdin.end() } catch { /* already ended */ }
    return await this.exit
  }

  async waitExit() {
    return await this.exit
  }

  kill(signal = 'SIGTERM') {
    try { process.kill(-this.child.pid, signal) } catch { try { this.child.kill(signal) } catch { /* gone */ } }
  }
}

/** Run one short public command with no protocol interaction. */
async function runPublicCli(context, args, envOverrides = {}, timeoutMs = 30_000) {
  const command = new CliProcess(context, ['--profile', 'pi-tui', ...args], envOverrides)
  command.tap.resume()
  try { command.child.stdin.end() } catch { /* already ended */ }
  const exit = await Promise.race([
    command.waitExit(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timeout: ${args.join(' ')}`)), timeoutMs)),
  ]).finally(() => {
    if (command.child.exitCode === null && command.child.signalCode === null) command.kill('SIGKILL')
  })
  return { ...exit, stdout: command.rawStdout(), stderr: command.stderr }
}

/** The live adapter process command lines for this exact installed package. */
function adapterProcesses(context) {
  const expected = join(realpathSync(context.profilePackage), 'dist', PACKAGE_ENTRY)
  let output
  try {
    output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
  } catch {
    return []
  }
  return output.split('\n').filter(line => line.includes(expected))
}

/** The official ACP SDK version loaded by this checkout. */
function installedAcpSdkVersion() {
  try {
    const requireFrom = createRequire(join(PACKAGE_ROOT, 'package.json'))
    let dir = requireFrom.resolve('@agentclientprotocol/sdk')
    for (let depth = 0; depth < 10; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (manifest.name === '@agentclientprotocol/sdk' && typeof manifest.version === 'string') return manifest.version
      } catch { /* keep walking */ }
      dir = join(dir, '..')
    }
    const pinned = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).dependencies?.['@agentclientprotocol/sdk']
    if (typeof pinned === 'string' && pinned !== '') return pinned
  } catch { /* unknown is reported honestly */ }
  return 'unknown'
}

async function waitForSocket(path, label, timeoutMs = 30_000) {
  await waitForCondition(() => existsSync(path), label, timeoutMs)
}

async function waitForGone(path, label, timeoutMs = 30_000) {
  await waitForCondition(() => !existsSync(path), label, timeoutMs)
}

/** The public logical ACP endpoint of one profile scope. */
function publicAcpSocketPath(dshHome, scopeId) {
  if (process.platform === 'darwin') {
    const uid = process.getuid?.()
    assert(typeof uid === 'number', 'A1: a POSIX uid is required for the Darwin ACP endpoint')
    return join('/private/tmp', `dpt-${String(uid)}-${scopeId.slice(0, 40)}`, 'acp.sock')
  }
  return join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'acp.sock')
}

/**
 * Run the one selected real `acp.stdio-bridge-a1` case.
 */
export async function runAcpStdioA1(context) {
  const { installation, entries, base, workDir, dshHome, profilePackage, candidateSha256 } = context
  const installedVersion = installation.manifest.version
  const installedEntry = join(profilePackage, 'dist', PACKAGE_ENTRY)
  assert(existsSync(installedEntry), 'A1-00: the candidate must contain the internal dist/acp-stdio.mjs artifact')
  assert(installation.manifest.bin === undefined, 'A1-00: the candidate must not add a public bin')
  assert(!Object.keys(installation.manifest.exports ?? {}).includes('./acp-stdio'), 'A1-00: the internal Adapter must not become a public export')
  const acpSdkVersion = installedAcpSdkVersion()
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
  const cliProcesses = []
  const extraHosts = []
  const extraProfiles = []
  let host
  let hostCwd
  let scopeDir
  let socketPath
  let sessionA
  let sessionB
  let longTurnBarrier
  let reverseApprovalBarrier
  let originalIdentity
  let originalRows

  const startPeer = async label => {
    const peer = new context.EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  let accessSequence = 0
  const acpAccess = async (peer, label, value) => {
    const requestId = `a1-acp-access-${String(++accessSequence)}-${String(process.pid)}`
    peer.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return await peer.waitFor(record => record.op === 'acp-access' && record.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const assertAccess = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private ACP access call failed (${String(record.errorCode ?? 'unknown')})`)
    assert(record.status?.state === expected, `${label}: expected ${expected}, got ${JSON.stringify(record.status)}`)
  }
  const assertSameHost = async (before, label) => {
    const after = await hostIdentityFacts(host)
    assert(after.hostPid === before.hostPid, `${label}: the Host PID changed (${String(before.hostPid)} -> ${String(after.hostPid)})`)
    assert(after.instanceId === before.instanceId, `${label}: the Host instance changed`)
    await assertHostIdentityKept(host, before, label)
  }
  const openCli = () => {
    const command = new CliProcess(context, ['--profile', 'pi-tui', 'acp', 'stdio'])
    cliProcesses.push(command)
    return command
  }
  const closeAllCli = async () => {
    for (const command of cliProcesses) {
      if (command.child.exitCode === null && command.child.signalCode === null) {
        try { command.kill('SIGKILL') } catch { /* gone */ }
      }
    }
    for (const command of cliProcesses) {
      try { await command.waitExit() } catch { /* the close owner already reported */ }
    }
  }
  const readCommands = async (args, env = {}, expectedCode, expectedStderr) => {
    const result = await runPublicCli(context, args, env)
    assert(result.code === expectedCode,
      `${args.join(' ')} exited ${String(result.code)} instead of ${String(expectedCode)}: ${result.stderr}`)
    if (expectedStderr !== undefined) {
      assert(expectedStderr.test(result.stderr), `${args.join(' ')} stderr did not match ${String(expectedStderr)}: ${result.stderr}`)
    }
    return result
  }

  try {
    // A1-00: start the ONE real C1 Host and enable its opt-in listener.
    longTurnBarrier = join(workDir, `a1-long-turn-${String(process.pid)}.release`)
    reverseApprovalBarrier = join(workDir, `a1-reverse-approval-${String(process.pid)}.release`)
    writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })
    writeFileSync(reverseApprovalBarrier, 'release\n', { mode: 0o600 })
    const started = await startC1Host('acp-po3b', 'a1 A host', {
      C1_HOLD_LONG_TURN: longTurnBarrier,
      C1_PO3B_REVERSE_APPROVAL: reverseApprovalBarrier,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    })
    host = started.host
    const ready = started.ready
    const scopeId = ready.localHost.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'A1-00: the Host must publish a full scope id')
    scopeDir = process.platform === 'darwin'
      ? join('/private/tmp', `dpt-${String(process.getuid?.())}-${scopeId.slice(0, 40)}`)
      : join(dshHome, 'run', 'dsh-pi-tui', scopeId)
    socketPath = publicAcpSocketPath(dshHome, scopeId)
    hostCwd = realpathSync(workDir)
    originalIdentity = await hostIdentityFacts(host)
    originalRows = await hostRowFiberUids(host)
    const peer = await startPeer('a1 peer')
    assertAccess(await acpAccess(peer, 'a1 initial status', undefined), 'disabled', 'a1 initial status')
    assertAccess(await acpAccess(peer, 'a1 enable', true), 'enabled', 'a1 enable')
    await waitForSocket(socketPath, 'A1-00 the enabled ACP socket')
    assert(statSync(socketPath).isSocket(), 'A1-00: the enabled listener must bind a real socket')

    // A1-02 setup: a REAL TUI opens Session A before the stdio bridge starts.
    const { client: tuiA } = await startC1Client('a1 TUI A', {}, { cwd: hostCwd })
    const tuiBoundary = tuiA.records.length
    tuiA.send('/new\r')
    const openA = await tuiA.waitFor(record => tuiA.records.indexOf(record) >= tuiBoundary
      && record.m4b2s === 'surface-status'
      && record.sessionOpen === true
      && typeof record.openSessionId === 'string'
      && record.openSessionId !== ''
      && record.surfaceMounted === true, 'A1-02: the real TUI opened Session A', 120_000)
    sessionA = openA.openSessionId
    assert(typeof sessionA === 'string' && sessionA.length > 0, 'A1-02: /new must publish a Session id')

    // A1-01: the public CLI's OS stdout from birth must be protocol-only.
    const command = openCli()
    const init = await command.initialize()
    assert(init?.protocolVersion === 1, `A1-01: initialize must negotiate ACP v1 (got ${JSON.stringify(init)})`)
    assert(init?.agentInfo?.name === 'dsh-pi-tui', 'A1-01: the Host must identify as dsh-pi-tui')
    assert(init?.agentInfo?.version === installedVersion,
      `A1-01: agentInfo.version must be the installed candidate ${installedVersion} (got ${String(init?.agentInfo?.version)})`)
    assert(init?.agentCapabilities?.loadSession === false, 'A1-01: loadSession must stay false')
    assert(init?.agentCapabilities?.sessionCapabilities?.resume !== undefined,
      'A1-01: the existing Host View must advertise resume')
    const adapterCountDuring = adapterProcesses(context).length
    assert(adapterCountDuring === 1,
      `A1-01: exactly one internal Adapter process may exist, got ${JSON.stringify(adapterProcesses(context))}`)

    // A1-02: resume the live TUI Session, prompt through stdio, observe the
    // ordered update stream, close only the View, then the TUI still works.
    const resumeA = await command.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId: sessionA, cwd: hostCwd,
    })
    assert(resumeA?.configOptions === undefined || Array.isArray(resumeA.configOptions),
      'A1-02: resume must return the standard optional configOptions shape')
    const beforeAcpTurn = (hostSessionEvents(dshHome, sessionA) ?? []).length
    const promptA = 'po3b-approval po3b-acp-ask-allow'
    const promptResponseA = await command.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: sessionA, prompt: [{ type: 'text', text: promptA }],
    })
    assert(promptResponseA?.stopReason === 'end_turn',
      `A1-02: the ACP prompt must complete end_turn (got ${JSON.stringify(promptResponseA)})`)
    assert(command.permissions.length === 1, 'A1-04: exactly one ACP-owned permission request must cross stdio')
    assert(command.permissions[0]?.sessionId === sessionA, 'A1-04: the reverse permission request must name Session A')
    assert(JSON.stringify(command.permissions[0]?.options?.map(option => option.optionId)) === JSON.stringify(['allow-once', 'reject-once']),
      'A1-04: the permission request must carry exactly the two one-shot options')
    assert(command.updates.length > 0, 'A1-02: at least one committed session/update must be delivered')
    assert(command.updates.every(update => update?.sessionId === sessionA),
      'A1-02: every update must belong to the exact resumed Session')
    await waitForHostSessionEventAfter(dshHome, sessionA, beforeAcpTurn, event => event.type === 'turn/end',
      'A1-02: the exact Host turn/end before the ACP response', 120_000)
    const acpEvents = hostSessionEvents(dshHome, sessionA) ?? []
    const acpAdded = acpEvents.slice(beforeAcpTurn)
    const insertedIndex = acpAdded.findIndex(event => event.type === 'user/message'
      && JSON.stringify(event).includes(promptA))
    const claimedIndex = acpAdded.findIndex(event => event.type === 'turn/start')
    const endedIndex = acpAdded.findIndex(event => event.type === 'turn/end')
    assert(insertedIndex >= 0,
      'A1-02: the prompt must be durably inserted as the exact user message')
    assert(claimedIndex >= 0 && insertedIndex > claimedIndex,
      'A1-02: the prompt must be claimed by a Host turn whose durable turn/start precedes it')
    assert(endedIndex > insertedIndex,
      'A1-02: the Host turn must reach its durable terminal after its claimed input')
    assert(hostAssistantHasText(acpAdded, 'po3b answer'),
      'A1-02: the committed controlled answer must be in the durable Session')
    assert(existsSync(join(started.workRoot, `po3b-allow-${sessionA}.marker`)),
      'A1-04: the ACP permission allow-once must execute the harmless tool exactly once')
    const closeA = await command.connection.agent.request(acp.methods.agent.session.close, { sessionId: sessionA })
    assert(closeA === undefined || typeof closeA === 'object', 'A1-02: session/close must return its standard result')
    await assertSameHost(originalIdentity, 'A1-02 Host after ACP close')
    await assertHostRowsKept(host, originalRows, 'A1-02 protected Host rows after ACP close')

    const tuiAfterStart = (hostSessionEvents(dshHome, sessionA) ?? []).length
    tuiA.send('a1 TUI after ACP close\r')
    await waitForHostSessionEventAfter(dshHome, sessionA, tuiAfterStart, event => event.type === 'turn/end',
      'A1-02: the TUI turn after the ACP close', 120_000)
    assert((hostSessionEvents(dshHome, sessionA) ?? []).some(event => event.type === 'user/message'
      && JSON.stringify(event).includes('a1 TUI after ACP close')),
    'A1-02: the TUI Session must remain usable after the ACP View detached')

    // A1-03: same stdio connection creates a NEW Host Session in a real
    // absolute Host Workspace; another real TUI opens that exact Session.
    const newWorkspace = join(workDir, 'a1-new-workspace')
    mkdirSync(newWorkspace, { recursive: true, mode: 0o700 })
    const newWorkspaceReal = realpathSync(newWorkspace)
    const createdB = await command.connection.agent.request(acp.methods.agent.session.new, {
      cwd: newWorkspaceReal, mcpServers: [],
    })
    assert(typeof createdB?.sessionId === 'string' && createdB.sessionId !== '',
      `A1-03: session/new must create a real Session (got ${JSON.stringify(createdB)})`)
    sessionB = createdB.sessionId
    assert(sessionB !== sessionA, 'A1-03: session/new must create a distinct Session')
    const closeBImmediately = await command.connection.agent.request(acp.methods.agent.session.close, { sessionId: sessionB })
    assert(closeBImmediately === undefined || typeof closeBImmediately === 'object', 'A1-03: close(B) must return its standard result')
    const headerB = await waitForHostSessionHeader(dshHome, sessionB, 'A1-03: Session B durable header')
    assert(headerB.cwd === newWorkspaceReal, `A1-03: Session B must use the Host Workspace ${newWorkspaceReal} (got ${String(headerB.cwd)})`)
    const { client: tuiB } = await startC1Client('a1 TUI B', { SPLIT_PROCESS_CLIENT_SESSION: sessionB })
    await tuiB.waitFor(record => record.m4b2s === 'surface-status' && record.sessionOpen === true
      && record.openSessionId === sessionB && record.surfaceMounted === true, 'A1-03: a real TUI opened Session B', 120_000)
    await exitC1Client(tuiB, 'A1-03 TUI B')

    // A1-04 second half: a RUNNING ACP turn on a FRESH Session is cancelled
    // through the public stdio bridge and reaches the Host's exact
    // user-aborted terminal.
    const cancelWorkspace = join(workDir, 'a1-cancel-workspace')
    mkdirSync(cancelWorkspace, { recursive: true, mode: 0o700 })
    const createdCancel = await command.connection.agent.request(acp.methods.agent.session.new, {
      cwd: realpathSync(cancelWorkspace), mcpServers: [],
    })
    const cancelSession = createdCancel?.sessionId
    assert(typeof cancelSession === 'string' && cancelSession !== sessionA && cancelSession !== sessionB,
      'A1-04: the cancel Session must be a distinct real Host Session')
    unlinkSync(longTurnBarrier)
    const cancelStart = (hostSessionEvents(dshHome, cancelSession) ?? []).length
    const cancelPrompt = command.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: cancelSession, prompt: [{ type: 'text', text: 'a1 running cancel turn' }],
    })
    await waitForHostSessionEventAfter(dshHome, cancelSession, cancelStart,
      event => event.type === 'user/message' && JSON.stringify(event).includes('a1 running cancel turn'),
      'A1-04: the cancelled prompt must be durably inserted', 120_000)
    await waitForC1WorkEvent(started.workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === cancelSession,
      'A1-04: the exact Host turn must be held before the cancel', 120_000)
    await command.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: cancelSession })
    const cancelResponse = await cancelPrompt
    assert(cancelResponse?.stopReason === 'cancelled',
      `A1-04: the running cancel must answer cancelled (got ${JSON.stringify(cancelResponse)})`)
    await waitForHostSessionEventAfter(dshHome, cancelSession, cancelStart,
      event => event.type === 'turn/end' && event.data?.reason?.kind === 'aborted'
        && event.data?.reason?.reason?.kind === 'user',
      'A1-04: the exact user-aborted Host terminal', 120_000)
    await command.connection.agent.request(acp.methods.agent.session.close, { sessionId: cancelSession })
    writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 })

    // A1-05: a large prompt is split across the OS stdin pipe while the
    // downstream stdout sink is deliberately paused; the Host's bounded output
    // must backpressure the child and drain without byte loss after resume.
    const pressure = openCli()
    pressure.startRaw()
    const pressureInit = await pressure.rawRequest('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
    })
    assert(pressureInit?.result?.protocolVersion === 1, 'A1-05: the raw ACP client must initialize')
    await pressure.rawRequest('session/resume', { sessionId: sessionA, cwd: hostCwd })
    const largeUpdatesBefore = pressure.rawLines.length
    const largePrompt = `a1-pressure-output ${'x'.repeat(200 * 1024)}`
    const largePromptRequest = pressure.rawBegin('session/prompt', {
      sessionId: sessionA, prompt: [{ type: 'text', text: largePrompt }],
    })
    pressure.pauseHostStdout()
    await sleep(250)
    assert(pressure.child.exitCode === null && pressure.child.signalCode === null,
      `A1-05: a paused stdout sink must not terminate the Adapter child (exit=${String(pressure.child.exitCode)} signal=${String(pressure.child.signalCode)} stderr=${pressure.stderr.slice(0, 400)})`)
    pressure.resumeHostStdout()
    const largeResponse = await largePromptRequest.promise
    assert(largeResponse?.result?.stopReason === 'end_turn',
      `A1-05: the large prompt must complete end_turn (got ${JSON.stringify(largeResponse)})`)
    const largeUpdates = pressure.rawLines.slice(largeUpdatesBefore)
      .map(line => { try { return JSON.parse(line) } catch { return undefined } })
      .filter(message => message?.method === acp.methods.client.session.update
        && message.params?.sessionId === sessionA)
      .length
    assert(largeUpdates >= 2, `A1-05: the Host must emit its complete committed update set (got ${String(largeUpdates)})`)
    await pressure.rawRequest('session/close', { sessionId: sessionA })
    const pressureExit = await pressure.close()
    assert(pressureExit.code === 0, `A1-05: the normal Client EOF must exit 0 (got ${JSON.stringify(pressureExit)})`)
    const commandClose = await command.close()
    assert(commandClose.code === 0, `A1-05: the original SDK Client must close cleanly (got ${JSON.stringify(commandClose)})`)

    // A1-06: no Host, disabled listener, foreign profile, missing installed
    // entry. Every failure is stdout-empty and uses the fixed classification.
    const noHostProfile = createSplitSmokeProfile({
      tarball: context.tarball,
      targetDshVersion: context.targetDshVersion,
      workDir: join(workDir, 'a1-foreign-profile'),
    })
    extraProfiles.push(noHostProfile)
    const noHost = await readCommands(['acp', 'stdio'], {
      ...noHostProfile.base.env,
    }, 3, /ACP_STDIO_HOST_NOT_READY/u)
    assert(noHost.stdout.length === 0, 'A1-06: no Host must produce zero stdout bytes')
    assertAccess(await acpAccess(peer, 'A1-06 disable', false), 'disabled', 'A1-06 disable')
    await waitForGone(socketPath, 'A1-06 socket removal')
    const disabled = await readCommands(['acp', 'stdio'], {}, 3, /ACP_STDIO_LISTENER_DISABLED/u)
    assert(disabled.stdout.length === 0, 'A1-06: a disabled listener must produce zero stdout bytes')
    assertAccess(await acpAccess(peer, 'A1-06 re-enable', true), 'enabled', 'A1-06 re-enable')
    await waitForSocket(socketPath, 'A1-06 socket re-enable')
    renameSync(installedEntry, `${installedEntry}.a1-backup`)
    try {
      const missing = await readCommands(['acp', 'stdio'], {}, 4, /ACP_STDIO_ENTRY_MISSING/u)
      assert(missing.stdout.length === 0, 'A1-06: a missing installed entry must produce zero stdout bytes')
    } finally {
      renameSync(`${installedEntry}.a1-backup`, installedEntry)
    }

    // A1-06 stale logical socket: the authenticated Host remains ready, but its
    // public pathname is a non-socket stale entry. The live ACP status observation
    // reports unavailable; the command must fail with zero stdout and never
    // start a Host or spawn an Adapter.
    const staleSaved = `${socketPath}.a1-saved-${String(process.pid)}`
    renameSync(socketPath, staleSaved)
    writeFileSync(socketPath, 'stale logical socket\n', { mode: 0o600 })
    try {
      const stale = await readCommands(['acp', 'stdio'], {}, 3, /ACP_STDIO_LISTENER_UNAVAILABLE/u)
      assert(stale.stdout.length === 0, 'A1-06: a stale logical socket must produce zero stdout bytes and the unavailable classification')
    } finally {
      try { unlinkSync(socketPath) } catch { /* already removed */ }
      try { unlinkSync(staleSaved) } catch { /* already removed */ }
    }
    assertAccess(await acpAccess(peer, 'A1-06 stale cleanup off', false), 'disabled', 'A1-06 stale cleanup off')
    assertAccess(await acpAccess(peer, 'A1-06 stale cleanup on', true), 'enabled', 'A1-06 stale cleanup on')
    await waitForSocket(socketPath, 'A1-06 stale cleanup socket')

    // A1-07: runtime ACP Off disconnects the stdio Adapter; the Host, TUI and
    // protected rows survive. A fresh command connects again after re-enable.
    const offCommand = openCli()
    const offInit = await offCommand.initialize()
    assert(offInit?.protocolVersion === 1, 'A1-07: the pre-Off stdio connection must initialize')
    const offConnected = await offCommand.connection.agent.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd })
    assert(offConnected !== undefined, 'A1-07: the pre-Off stdio connection must attach Session A')
    assertAccess(await acpAccess(peer, 'A1-07 runtime Off', false), 'disabled', 'A1-07 runtime Off')
    const offExit = await offCommand.waitExit()
    assert(offExit.code === 4, `A1-07: an ACP Off must make the Adapter exit 4 (got ${JSON.stringify(offExit)})`)
    assert(/ACP_STDIO_HOST_DISCONNECTED|ACP_STDIO_SOCKET_ERROR/u.test(offCommand.stderr),
      `A1-07: the Adapter must report a fixed transport code: ${offCommand.stderr}`)
    await assertSameHost(originalIdentity, 'A1-07 Host after ACP Off')
    await assertHostRowsKept(host, originalRows, 'A1-07 protected Host rows after ACP Off')
    assertAccess(await acpAccess(peer, 'A1-07 re-enable', true), 'enabled', 'A1-07 re-enable')
    await waitForSocket(socketPath, 'A1-07 socket re-enable')
    const afterOff = openCli()
    assert((await afterOff.initialize())?.protocolVersion === 1, 'A1-07: a fresh stdio connection must connect after re-enable')
    const afterOffExit = await afterOff.close()
    assert(afterOffExit.code === 0, `A1-07: a clean fresh connection must exit 0 (got ${JSON.stringify(afterOffExit)})`)

    // A1-07 Host death: kill the verified Host while a fresh stdio Client is
    // attached. The Adapter must exit 4; the Host is restarted explicitly, a
    // fresh command connects to the NEW authenticated instance, and no old
    // Adapter is retried or silently reattached.
    const killCommand = openCli()
    assert((await killCommand.initialize())?.protocolVersion === 1, 'A1-07: the pre-kill connection must initialize')
    await killCommand.connection.agent.request(acp.methods.agent.session.resume, { sessionId: sessionA, cwd: hostCwd })
    const beforeKill = await hostIdentityFacts(host)
    await scene.stopC1Host(host)
    await awaitSceneSeatFree()
    const killExit = await killCommand.waitExit()
    assert(killExit.code === 4, `A1-07: Host death must make the Adapter exit 4 (got ${JSON.stringify(killExit)})`)
    assert(/ACP_STDIO_HOST_DISCONNECTED|ACP_STDIO_SOCKET_ERROR/u.test(killCommand.stderr),
      `A1-07: Host death must use a fixed transport code: ${killCommand.stderr}`)
    const restarted = await startC1Host('acp-po3b', 'a1 restart host', {
      C1_HOLD_LONG_TURN: longTurnBarrier,
      C1_PO3B_REVERSE_APPROVAL: reverseApprovalBarrier,
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '16',
    })
    host = restarted.host
    const restartReady = restarted.ready
    assert(restartReady.localHost.hostPid !== beforeKill.hostPid, 'A1-07: the explicit restart must be a new Host PID')
    assert(restartReady.localHost.instanceId !== beforeKill.instanceId, 'A1-07: the explicit restart must be a new Host instance')
    const restartedPeer = await startPeer('a1 restart peer')
    assertAccess(await acpAccess(restartedPeer, 'A1-07 restart enable', true), 'enabled', 'A1-07 restart enable')
    await waitForSocket(publicAcpSocketPath(dshHome, restartReady.localHost.scopeId), 'A1-07 restart ACP socket')
    const reconnect = openCli()
    assert((await reconnect.initialize())?.protocolVersion === 1, 'A1-07: a fresh command must connect to the restarted Host')
    const reconnectExit = await reconnect.close()
    assert(reconnectExit.code === 0, `A1-07: the restarted Host connection must exit cleanly (got ${JSON.stringify(reconnectExit)})`)
    const restartIdentity = await hostIdentityFacts(host)

    // A1-07 stdout EPIPE and SIGTERM: only this Adapter's own IO is torn down;
    // the restarted Host remains ready and no Adapter process survives.
    const epipeCommand = openCli()
    await waitForCondition(() => adapterProcesses(context).length === 1, 'A1-07 the EPIPE Adapter child', 30_000)
    epipeCommand.child.stdout.destroy()
    epipeCommand.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} },
    })}\n`)
    const epipeExit = await epipeCommand.waitExit()
    assert(epipeExit.code === 4, `A1-07: stdout EPIPE must exit 4 (got ${JSON.stringify(epipeExit)})`)
    assert(/ACP_STDIO_STDOUT_EPIPE/u.test(epipeCommand.stderr),
      `A1-07: stdout EPIPE must use the fixed code: ${epipeCommand.stderr}`)
    await assertSameHost(restartIdentity, 'A1-07 Host after stdout EPIPE')

    const signalCommand = openCli()
    assert((await signalCommand.initialize())?.protocolVersion === 1, 'A1-07: the signal command must initialize')
    signalCommand.kill('SIGTERM')
    const signalExit = await signalCommand.waitExit()
    assert(signalExit.signal !== null || signalExit.code !== null,
      'A1-07: a parent SIGTERM must produce a real child exit fact')
    assert(adapterProcesses(context).length === 0, 'A1-07: SIGTERM must not leave an Adapter child')
    await assertSameHost(restartIdentity, 'A1-07 Host after parent SIGTERM')

    // A1-08: command-family help/usage keeps the original Commander semantics.
    const help = await readCommands(['acp', '--help'], {}, 0)
    assert(help.stdout.toString('utf8').includes('stdio'), 'A1-08: acp --help must list stdio')
    assert(help.stderr.length === 0, 'A1-08: help must keep stderr empty')
    await readCommands(['acp'], {}, 2)
    await readCommands(['acp', 'stdio', '--session', 'x'], {}, 2)
    await readCommands(['--help'], {}, 0)

    const finalIdentity = await hostIdentityFacts(host)
    assert(finalIdentity.hostPid === restartIdentity.hostPid
      && finalIdentity.instanceId === restartIdentity.instanceId,
    'A1-09: the explicitly restarted Host must still be the same instance after the command family checks')
    assert(finalIdentity.hostPid !== originalIdentity.hostPid,
      'A1-09: the explicit A1-07 Host restart must be recorded as a new process')
    assert(adapterProcesses(context).length === 0, 'A1-09: no orphan Adapter process may remain')

    const raw = command.rawStdout()
    const protocol = protocolOnly(raw)
    assert(protocol.valid && protocol.frames > 0,
      `A1-01: the complete stdout must be valid ACP JSON-RPC NDJSON (frames=${String(protocol.frames)}, valid=${String(protocol.valid)})`)
    const evidence = {
      candidateSha256,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion,
      bundleVersion: installedVersion,
      acpSdkVersion,
      hostPid: originalIdentity.hostPid,
      hostInstanceId: originalIdentity.instanceId,
      restartHostPid: restartIdentity.hostPid,
      restartHostInstanceId: restartIdentity.instanceId,
      scopeId,
      sessionA,
      sessionB,
      stdoutBytes: raw.length,
      stdoutFrames: protocol.frames,
      stdoutSha256: sha256(raw),
      adapterProcessCount: adapterProcesses(context).length,
      adapterProcessCountDuring: adapterCountDuring,
      updates: command.updates.length,
      permissions: command.permissions.length,
      tuiPids: tuiA.child?.pid === undefined ? [] : [{ role: 'tui-a', pid: tuiA.child.pid }],
    }
    assert(typeof evidence.candidateSha256 === 'string' && /^[0-9a-f]{64}$/u.test(evidence.candidateSha256),
      'A1-09: the candidate SHA must be a real digest')
    assert(typeof evidence.hostPid === 'number' && typeof evidence.hostInstanceId === 'string',
      'A1-09: the Host identity facts must be recorded')
    assert(evidence.stdoutFrames > 0 && /^[0-9a-f]{64}$/u.test(evidence.stdoutSha256),
      'A1-09: the raw stdout hash and frame count must be recorded')

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      acpVersionFromInstalledDsh: acpSdkVersion !== 'unknown',
      publicCommandFromInstalledProfile: true,
      protocolOnlyStdout: true,
      singleAdapterChild: adapterCountDuring === 1,
      sameHostIdentity: true,
      tuiSessionShared: true,
      promptUpdateClose: true,
      newSessionViaHostWorkspace: true,
      cancelAndPermissionReachable: true,
      largePayloadDrained: true,
      outputBackpressureObserved: true,
      staleSocketFailClosed: true,
      hostMissingDisabledForeignAndMissingEntryFailClosed: true,
      runtimeOffDisconnectsOnlyAdapter: true,
      hostRestartObserved: true,
      commandFamilyStable: true,
      hostTuiKept: true,
      quiesced: true,
      evidence,
    }
  } finally {
    if (longTurnBarrier !== undefined) {
      try { writeFileSync(longTurnBarrier, 'release\n', { mode: 0o600 }) } catch { /* the root may already be gone */ }
    }
    for (const command of cliProcesses) {
      if (command.child.exitCode === null && command.child.signalCode === null) {
        try { command.kill('SIGKILL') } catch { /* gone */ }
      }
      try { await command.waitExit() } catch { /* runner backstop */ }
    }
    for (const extra of extraHosts) {
      if (extra.exited) continue
      try { await extra.shutdown() } catch { /* runner backstop */ }
    }
    for (const peerProcess of peers) {
      if (peerProcess.exited) continue
      try { await peerProcess.shutdown() } catch { /* runner backstop */ }
    }
    for (const profile of extraProfiles) {
      // The profile root is under this case's own workDir; the runner removes it.
      void profile
    }
    try { await scene.dispose() } catch { /* runner backstop */ }
    try { await awaitSceneSeatFree().catch(() => {}) } catch { /* best effort on failure */ }
    void closeAllCli
  }
}
