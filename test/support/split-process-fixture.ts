/**
 * The typed Worker-side Scene facade for the Split-process business Project.
 *
 * The Supervisor process owns the Scene root, the immutable single-package
 * install and every real Host and tui-test Client. This module only speaks the
 * existing Supervisor IPC protocol and exposes bounded operations; it never
 * runs a native terminal call, starts a Host itself or decides that a resource
 * is clean.
 *
 * It is plain TypeScript with erasable syntax only (no Vitest import), so the
 * same module stays loadable through the pinned Node type-stripping loader.
 *
 * @module split-process-fixture
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readKernelProcess } from '../../src/runtime/native-process/identity.ts'
import { readOfficialClientRecords } from './split-process-client.ts'
import { SupervisorClient } from './split-supervisor-client.ts'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(SUPPORT_DIR, '..', '..'))

export const PARALLEL_AUDIT_ENV = 'SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID'

interface CandidateFacts {
  tarball: string
  candidateSha256: string
  version: string
  manifestPin: string
  targetDshVersion: string
}

interface SplitProcessProfileModule {
  inspectImmutableSplitCandidate(path: string): CandidateFacts
}

interface SessionEvent {
  type?: string
  data?: Record<string, any>
}

interface SplitUpgradeNativeContractModule {
  serializeKernelIdentity(identity: unknown): string
  classifyKernelLiveness(kernel: unknown): { state: 'alive' | 'gone' | 'unknown' }
}

interface SplitSmokeSessionsModule {
  hostSessionEvents(dshHome: string, sessionId: string): SessionEvent[] | undefined
  hostSessionHeader(dshHome: string, sessionId: string): SessionEvent | undefined
  hostSessionLogCount(dshHome: string): number
  waitForHostSessionHeader(dshHome: string, sessionId: string, label: string, timeoutMs?: number): Promise<SessionEvent>
  waitForHostSessionEventAfter(
    dshHome: string,
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
}

const profileModule = await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'split-smoke-profile.mjs')).href
) as SplitProcessProfileModule
const sessionsModule = await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'split-smoke-sessions.mjs')).href
) as SplitSmokeSessionsModule
const nativeContract = await import(
  pathToFileURL(join(REPO_ROOT, 'test', 'support', 'split-upgrade-native-contract.mjs')).href
) as SplitUpgradeNativeContractModule

export interface SplitProcessInstallation {
  workDir: string
  dshHome: string
  profileDir: string
  entries: { host: string; client: string }
  anchor: string
  base: { cwd: string; env: Record<string, string> }
  scratch: string
}

export interface SplitProcessScopeFacts {
  scopeId: string
  buildId: string
  bundleVersion: string
  dshVersion: string
  hostSeat: { kind: string; name?: string; path?: string }
}

export interface SplitProcessHostHandle {
  readonly hostId: string
  readonly generation: number
  readonly ready: Record<string, any>
  readonly workRoot: string
  readonly scopeId: string
  readonly pgid: number | null
  readonly entryRealpath: string
  exited: boolean
  exitResult?: { code: number | null; signal: NodeJS.Signals | null }
}

export interface SplitProcessClientReady {
  hostPid: number
  instanceId: string
  scopeId: string
  buildId: string
  transport: string
  surfaceMounted: boolean
  sessionOpen: boolean
  openSessionId?: string
  generationId?: number
  shellPid: number
  businessPid: number
}

export interface SplitProcessClientState {
  clientId: string
  label: string
  sessionId: string
  shellPid: number | null
  businessPids: number[]
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  sessionListed: boolean
  shellState: string
  businessStates: Array<{ pid: number; state: string }>
  /** Present only while the native terminal handle still exists. */
  cols?: number
  rows?: number
}

export interface SplitProcessClientExitFacts {
  code: number | null
  signal: string | null
}

export interface SplitProcessClient {
  readonly clientId: string
  readonly label: string
  readonly sessionId: string
  readonly recordFile: string
  readonly ready: SplitProcessClientReady
  /** Whether this Worker already observed the normal terminal close. */
  readonly closed: boolean
  type(text: string): Promise<void>
  press(...keys: string[]): Promise<void>
  submit(text?: string): Promise<void>
  text(): Promise<string>
  state(): Promise<SplitProcessClientState>
  readRecords(): Record<string, any>[]
  waitForSurfaceStatus(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
  waitForExit(timeoutMs?: number): Promise<SplitProcessClientExitFacts>
  close(): Promise<SplitProcessClientExitFacts>
}

export interface StartProcessClientOptions {
  label: string
  cwd: string
  home: string
  sessionId?: string
  cols?: number
  rows?: number
}

export interface SplitProcessScene {
  /** The Scenario's unique Supervisor receipt/run identity. */
  readonly runId: string
  readonly workDir: string
  readonly candidate: CandidateFacts
  readonly installation: SplitProcessInstallation
  readonly scope: SplitProcessScopeFacts
  /** Bounded typed Supervisor IPC, for boundary negatives on a real Scene. */
  request(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, any>>
  startHost(): Promise<SplitProcessHostHandle>
  hostStatus(host: SplitProcessHostHandle): Promise<Record<string, any>>
  stopHost(host: SplitProcessHostHandle): Promise<SplitProcessClientExitFacts>
  startClient(options: StartProcessClientOptions): Promise<SplitProcessClient>
  sessionIds(): Promise<string[]>
  sessionEvents(sessionId: string): SessionEvent[] | undefined
  hostSessionLogCount(): number
  waitForNewSessionId(before: ReadonlySet<string>, label: string, timeoutMs?: number): Promise<string>
  waitForHostSessionHeader(sessionId: string, label: string, timeoutMs?: number): Promise<SessionEvent>
  waitForSessionEvent(
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
  report(event: string, detail?: Record<string, unknown>): Promise<void>
  /** Report one real parallel-ready checkpoint and prove the other Scene is live. */
  parallelReady(
    label: 'host-file-completion' | 'preset-defaults',
    host: SplitProcessHostHandle,
    client: SplitProcessClient,
  ): Promise<void>
  /** Close this Scene's parallel-audit active interval. */
  parallelRelease(label: 'host-file-completion' | 'preset-defaults'): Promise<void>
  dispose(): Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function requireAbsoluteDirectory(name: string): string {
  const raw = process.env[name]
  assert(typeof raw === 'string' && raw !== '' && isAbsolute(raw),
    `INPUT_UNQUALIFIED: ${name} must be an absolute path`)
  let real: string
  let stats
  try {
    real = realpathSync(raw)
    stats = statSync(real)
  } catch (error) {
    throw new Error(`INPUT_UNQUALIFIED: ${name} is not a readable existing directory: ${asError(error).message}`)
  }
  assert(real === raw,
    `INPUT_UNQUALIFIED: ${name} must be a canonical path, not a symlink alias: ${raw} -> ${real}`)
  assert(stats.isDirectory(), `INPUT_UNQUALIFIED: ${name} is not a directory: ${real}`)
  if (typeof process.getuid === 'function') {
    assert(stats.uid === process.getuid(), `INPUT_UNQUALIFIED: ${name} is not owned by this user: ${real}`)
  }
  assert((stats.mode & 0o777) === 0o700, `INPUT_UNQUALIFIED: ${name} must have mode 0700: ${real}`)
  const rel = relative(REPO_ROOT, real)
  assert(rel === '..' || rel.startsWith(`..${sep}`),
    `INPUT_UNQUALIFIED: ${name} must be outside the checkout: ${real}`)
  return real
}

function requireCandidateTarball(): string {
  const raw = process.env.SPLIT_VITEST_CANDIDATE_TGZ
  assert(typeof raw === 'string' && raw !== '' && isAbsolute(raw),
    'INPUT_UNQUALIFIED: SPLIT_VITEST_CANDIDATE_TGZ must be an absolute path to the built candidate .tgz')
  return raw
}

/** Poll the real Host Session store for its Session directory identities. */
function listSessionIds(dshHome: string): string[] {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  const ids: string[] = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of readdirSync(join(root, project.name), { withFileTypes: true })) {
      if (session.isDirectory()) ids.push(session.name)
    }
  }
  return ids
}

/** One serialized kernel birth for a live PID, or undefined when unreadable. */
function kernelBirthOf(pid: number | null | undefined): string | undefined {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const observation = readKernelProcess(pid)
    if (observation.kind !== 'alive') return undefined
    // A same-birth Linux Z/X/x is not a live process; the product classifier
    // is the ONE authority for that distinction.
    if (nativeContract.classifyKernelLiveness(observation).state !== 'alive') return undefined
    return nativeContract.serializeKernelIdentity(observation.identity)
  } catch {
    return undefined
  }
}

interface SupervisorReceipt {
  runId?: string
  parentRunId?: string
  kind?: string
  phase?: string
  sceneRoot?: string
  candidate?: { sha256?: string }
  installation?: { dshHome?: string; profileDir?: string; workDir?: string }
  scope?: { scopeId?: string; hostSeat?: { path?: string; name?: string } }
  worker?: { pid?: number; ppid?: number; birth?: string }
  host?: { pid?: number; birth?: string; pgid?: number }
  processClients?: Array<{
    clientId?: string
    label?: string
    sessionId?: string
    scratch?: string
    shellPid?: number
    shellBirth?: string
    businessIdentities?: Array<{ pid?: number; birth?: string }>
  }>
  notes?: Array<{ event?: string; detail?: Record<string, any>; at?: string }>
}

class ProcessClient implements SplitProcessClient {
  readonly clientId: string
  readonly label: string
  readonly sessionId: string
  readonly recordFile: string
  readonly ready: SplitProcessClientReady
  readonly #scene: ProcessScene
  #closed = false
  #exitFacts: SplitProcessClientExitFacts | undefined

  constructor(scene: ProcessScene, payload: Record<string, any>) {
    this.#scene = scene
    this.clientId = String(payload.clientId)
    this.label = String(payload.label)
    this.sessionId = String(payload.sessionId)
    this.recordFile = String(payload.recordFile)
    this.ready = payload.ready as SplitProcessClientReady
  }

  async type(text: string): Promise<void> {
    await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_INPUT', { input: { type: 'type', text } })
  }

  async press(...keys: string[]): Promise<void> {
    await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_INPUT', { input: { type: 'press', keys } })
  }

  async submit(text?: string): Promise<void> {
    await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_INPUT', {
      input: text === undefined ? { type: 'submit' } : { type: 'submit', text },
    })
  }

  async text(): Promise<string> {
    const payload = await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_TEXT', {})
    return String(payload.text)
  }

  async state(): Promise<SplitProcessClientState> {
    return await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_STATE', {}) as SplitProcessClientState
  }

  readRecords(): Record<string, any>[] {
    return readOfficialClientRecords(this.recordFile, this.label)
  }

  async waitForSurfaceStatus(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<Record<string, any>> {
    const started = Date.now()
    // Streaming poll: a live JSONL append may end in a partial record, which is
    // not a malformed line. The final audit below re-reads strictly.
    const last = (allowIncompleteTail: boolean): Record<string, any> | undefined =>
      readOfficialClientRecords(this.recordFile, this.label, { allowIncompleteTail })
        .filter(record => record?.m4b2s === 'surface-status')
        .at(-1)
    let stateCheckedAt = 0
    for (;;) {
      const status = last(true)
      if (status !== undefined && predicate(status)) return status
      if (Date.now() - stateCheckedAt >= 500) {
        stateCheckedAt = Date.now()
        const state = await this.state()
        if (state.exited) {
          throw new Error(`${label}: the Client exited before a matching official surface status`)
        }
      }
      if (Date.now() - started >= timeoutMs) {
        // A status written just before the deadline must not be reported as
        // missing; a genuinely truncated final line still fails this strict read.
        const late = last(false)
        if (late !== undefined && predicate(late)) return late
        throw new Error(`${label}: no matching official surface status within ${String(timeoutMs)}ms`)
      }
      await sleep(25)
    }
  }

  async waitForExit(timeoutMs = 120_000): Promise<SplitProcessClientExitFacts> {
    const started = Date.now()
    for (;;) {
      const state = await this.state()
      if (state.exited) {
        // Observation only: the Supervisor-owned CLOSE settlement is still
        // required before this Client can be called closed.
        this.#exitFacts = { code: state.exitCode, signal: state.exitSignal }
        return this.#exitFacts
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`${this.label}: the real tui-test shell did not exit within ${String(timeoutMs)}ms`)
      }
      await sleep(50)
    }
  }

  async close(): Promise<SplitProcessClientExitFacts> {
    if (this.#closed) return this.#exitFacts ?? { code: null, signal: null }
    const payload = await this.#scene.clientRequest(this.clientId, 'CLOSE_PROCESS_CLIENT', {})
    this.#closed = true
    this.#exitFacts = {
      code: payload.exitCode ?? null,
      signal: payload.exitSignal ?? null,
    }
    return this.#exitFacts
  }

  /** Whether this Client reached its normal native close in this Scene. */
  get closed(): boolean {
    return this.#closed
  }


  /**
   * Test teardown only: ask the real surface to leave, take the busy Exit Choice
   * ONLY when the CURRENT painted frame proves the default non-destructive row
   * is selected, then close. It never guesses a hidden modal state.
   */
  async exitGracefully(): Promise<void> {
    if (this.#closed) return
    const current = await this.state().catch(() => undefined)
    if (current !== undefined && current.exited) {
      await this.close()
      return
    }
    await this.submit('/exit')
    const deadline = Date.now() + 60_000
    let choiceTaken = false
    for (;;) {
      const state = await this.state().catch(() => undefined)
      if (state !== undefined && state.exited) {
        await this.close()
        return
      }
      if (!choiceTaken) {
        const frame = await this.text().catch(() => '')
        if (frame.includes('Disconnect from dsh-pi-tui') && frame.includes('> Keep working and disconnect')) {
          await this.press('Enter')
          choiceTaken = true
        }
      }
      if (Date.now() >= deadline) {
        const frame = await this.text().catch(() => '')
        throw new Error(`${this.label} did not exit after /exit; last frame: ${JSON.stringify(frame.slice(-2000))}`)
      }
      await sleep(100)
    }
  }
}

class ProcessScene implements SplitProcessScene {
  readonly runId: string
  readonly workDir: string
  readonly candidate: CandidateFacts
  readonly installation: SplitProcessInstallation
  readonly scope: SplitProcessScopeFacts
  readonly #supervisor: SupervisorClient
  readonly #tmpBase: string
  readonly #clients: ProcessClient[] = []
  readonly #hosts: SplitProcessHostHandle[] = []

  constructor(
    facts: Record<string, any>,
    supervisor: SupervisorClient,
    runId: string,
    tmpBase: string,
  ) {
    this.runId = runId
    this.workDir = String(facts.workDir)
    this.candidate = facts.candidate as CandidateFacts
    this.installation = facts.installation as SplitProcessInstallation
    this.scope = facts.scope as SplitProcessScopeFacts
    this.#supervisor = supervisor
    this.#tmpBase = tmpBase
  }

  get supervisorPids(): { worker: number; supervisor: number | undefined } {
    return this.#supervisor.pids
  }

  async request(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    return await this.#supervisor.request(type, payload, { timeoutMs }) as Record<string, any>
  }

  async clientRequest(clientId: string, type: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    return await this.request(type, { clientId, ...payload }, type === 'CLOSE_PROCESS_CLIENT' ? 240_000 : 120_000)
  }

  async startHost(): Promise<SplitProcessHostHandle> {
    const payload = await this.request('START_HOST', {}, 600_000)
    const host: SplitProcessHostHandle = {
      hostId: String(payload.hostId),
      generation: Number(payload.generation),
      ready: payload.ready as Record<string, any>,
      workRoot: String(payload.workRoot),
      scopeId: String(payload.scopeId),
      pgid: payload.pgid === null || payload.pgid === undefined ? null : Number(payload.pgid),
      entryRealpath: String(payload.entryRealpath),
      exited: false,
    }
    this.#hosts.push(host)
    return host
  }

  async hostStatus(host: SplitProcessHostHandle): Promise<Record<string, any>> {
    assert(!host.exited, `Host ${host.hostId} is not alive`)
    return await this.request('HOST_STATUS', { hostId: host.hostId }, 60_000)
  }

  async stopHost(host: SplitProcessHostHandle): Promise<SplitProcessClientExitFacts> {
    assert(!host.exited, `Host ${host.hostId} is not alive`)
    const payload = await this.request('STOP_HOST', { hostId: host.hostId }, 120_000)
    host.exited = true
    host.exitResult = { code: payload.code ?? null, signal: payload.signal ?? null }
    assert(host.exitResult.code === 0 && host.exitResult.signal === null,
      `Host ${host.hostId} shutdown was ${JSON.stringify(host.exitResult)}`)
    return host.exitResult
  }

  async startClient(options: StartProcessClientOptions): Promise<SplitProcessClient> {
    const payload = await this.request('START_PROCESS_CLIENT', {
      label: options.label,
      cwd: options.cwd,
      home: options.home,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.cols === undefined ? {} : { cols: options.cols }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
    }, 600_000)
    const client = new ProcessClient(this, payload)
    this.#clients.push(client)
    return client
  }

  async sessionIds(): Promise<string[]> {
    return listSessionIds(this.installation.dshHome)
  }

  sessionEvents(sessionId: string): SessionEvent[] | undefined {
    return sessionsModule.hostSessionEvents(this.installation.dshHome, sessionId)
  }

  hostSessionLogCount(): number {
    return sessionsModule.hostSessionLogCount(this.installation.dshHome)
  }

  async waitForNewSessionId(before: ReadonlySet<string>, label: string, timeoutMs = 120_000): Promise<string> {
    const started = Date.now()
    for (;;) {
      const added = listSessionIds(this.installation.dshHome).filter(id => !before.has(id))
      if (added.length === 1) return added[0]!
      if (added.length > 1) {
        throw new Error(`${label}: ${String(added.length)} new Host Sessions appeared: ${JSON.stringify(added)}`)
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`${label}: no new Host Session appeared within ${String(timeoutMs)}ms`)
      }
      await sleep(50)
    }
  }

  async waitForHostSessionHeader(sessionId: string, label: string, timeoutMs = 120_000): Promise<SessionEvent> {
    return await sessionsModule.waitForHostSessionHeader(this.installation.dshHome, sessionId, label, timeoutMs)
  }

  async waitForSessionEvent(
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<SessionEvent> {
    return await sessionsModule.waitForHostSessionEventAfter(
      this.installation.dshHome, sessionId, afterIndex, predicate, label, timeoutMs)
  }

  async report(event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.request('REPORT', { event, detail }, 30_000)
  }

  async parallelReady(
    label: 'host-file-completion' | 'preset-defaults',
    host: SplitProcessHostHandle,
    client: SplitProcessClient,
  ): Promise<void> {
    const auditRunId = process.env[PARALLEL_AUDIT_ENV]
    if (auditRunId === undefined || auditRunId === '') return
    assert(/^[A-Za-z0-9._-]+$/u.test(auditRunId), `INPUT_UNQUALIFIED: ${PARALLEL_AUDIT_ENV} must match [A-Za-z0-9._-]+`)
    const ownHostStatus = await this.hostStatus(host)
    const ownState = await client.state()
    assert(ownState.exited === false && ownState.sessionListed === true,
      `${label}: this Scene's Client is not live at the parallel-ready checkpoint`)
    await this.report('parallel-ready', {
      label,
      runId: this.runId,
      workerPid: process.pid,
      sceneRoot: this.workDir,
      profileDir: this.installation.profileDir,
      dshHome: this.installation.dshHome,
      candidateSha256: this.candidate.candidateSha256,
      scopeId: this.scope.scopeId,
      hostId: host.hostId,
      hostPid: host.ready?.localHost?.hostPid ?? null,
      hostPidLive: ownHostStatus?.pid ?? null,
      clientId: client.clientId,
      clientSessionId: client.sessionId,
      clientBusinessPid: client.ready?.businessPid ?? null,
      clientShellPid: client.ready?.shellPid ?? null,
      activeStartedAt: new Date().toISOString(),
    })
    const otherLabel = label === 'host-file-completion' ? 'preset-defaults' : 'host-file-completion'
    const started = Date.now()
    for (;;) {
      const other = this.#findOtherParallelScene(auditRunId, otherLabel)
      if (other !== undefined) {
        this.#assertParallelSeparation(other, host, client)
        const ownReceipt = this.#ownReceipt()
        assert(ownReceipt !== undefined, `${label}: this Scene has no durable Supervisor receipt`)
        // A kernel read can be transiently unavailable under system load; the
        // STATIC missing birth still fails, while an unreadable live PID keeps
        // polling within this bounded overlap window.
        if (this.#isReceiptSceneLive(other) && this.#isReceiptSceneLive(ownReceipt)) {
          // Re-check THIS Scene after the other side was observed: both live
          // intervals genuinely intersect.
          await this.hostStatus(host)
          const after = await client.state()
          assert(after.exited === false && after.sessionListed === true,
            `${label}: this Scene's Client stopped during the overlap check`)
          await this.report('parallel-overlap', {
            label,
            otherRunId: other.runId,
            otherLabel,
            otherHostPid: other.host?.pid ?? null,
            checkedAt: new Date().toISOString(),
          })
          return
        }
      }
      if (Date.now() - started >= 120_000) {
        throw new Error(`${label}: the other split-process Scene never reported a live parallel-ready checkpoint`)
      }
      await sleep(100)
    }
  }

  async parallelRelease(label: 'host-file-completion' | 'preset-defaults'): Promise<void> {
    const auditRunId = process.env[PARALLEL_AUDIT_ENV]
    if (auditRunId === undefined || auditRunId === '') return
    await this.report('parallel-released', { label, activeEndedAt: new Date().toISOString() })
  }

  #receipts(): SupervisorReceipt[] {
    const root = join(this.#tmpBase, 'split-resources')
    if (!existsSync(root)) return []
    const receipts: SupervisorReceipt[] = []
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json')) continue
      try {
        receipts.push(JSON.parse(readFileSync(join(root, name), 'utf8')) as SupervisorReceipt)
      } catch {
        // An atomic rename means a parsed failure is a foreign/incomplete file,
        // never this run's durable receipt.
      }
    }
    return receipts
  }

  #findOtherParallelScene(auditRunId: string, otherLabel: string): SupervisorReceipt | undefined {
    return this.#receipts().find(receipt => receipt.kind === 'process'
      && receipt.parentRunId === auditRunId
      && receipt.runId !== this.runId
      && typeof receipt.sceneRoot === 'string'
      && (receipt.notes ?? []).some(note => note?.event === 'parallel-ready' && note.detail?.label === otherLabel))
  }

  #assertParallelSeparation(other: SupervisorReceipt, host: SplitProcessHostHandle, client: SplitProcessClient): void {
    const own = this.#ownReceipt()
    assert(own !== undefined, 'this parallel Scene has no durable Supervisor receipt')
    assert(other.sceneRoot !== this.workDir, 'the two parallel Scenes share a Scene root')
    assert(other.installation?.dshHome !== this.installation.dshHome, 'the two parallel Scenes share a DSH home')
    assert(other.installation?.profileDir !== this.installation.profileDir, 'the two parallel Scenes share a profile')
    assert(other.scope?.scopeId !== this.scope.scopeId, 'the two parallel Scenes share a Host scope/seat')
    const otherSeat = other.scope?.hostSeat?.path ?? other.scope?.hostSeat?.name
    const ownSeat = own.scope?.hostSeat?.path ?? own.scope?.hostSeat?.name
    assert(typeof otherSeat === 'string' && otherSeat !== ''
      && typeof ownSeat === 'string' && ownSeat !== ''
      && otherSeat !== ownSeat, 'the two parallel Scenes share the Host seat')
    assert(other.host?.pid !== host.ready?.localHost?.hostPid, 'the two parallel Scenes share a Host process')
    assert(other.worker?.pid !== own.worker?.pid, 'the two parallel Scenes share a Worker PID')
    assert(typeof other.worker?.ppid === 'number' && typeof own.worker?.ppid === 'number',
      'a parallel Scene Worker has no real PPID')
    // The serialized birth is the start timestamp; on Linux two distinct
    // processes started in the same clock tick carry the same string. The
    // live check below binds each birth to its own PID, so PID inequality plus
    // per-PID liveness is the process-identity separation.
    assert(other.candidate?.sha256 === this.candidate.candidateSha256, 'the two parallel Scenes used different candidates')
    const otherClients = other.processClients ?? []
    assert(otherClients.length > 0, 'the other parallel Scene reported no Client')
    const ownClient = own.processClients?.find(value => value.clientId === client.clientId)
    assert(ownClient !== undefined, 'this parallel Scene Client is missing from its receipt')
    for (const entry of otherClients) {
      assert(entry.clientId !== client.clientId, 'the two parallel Scenes share a Client identity')
      assert(entry.sessionId !== client.sessionId, 'the two parallel Scenes share a native session')
      assert(typeof entry.scratch === 'string' && entry.scratch !== ''
        && typeof ownClient.scratch === 'string' && ownClient.scratch !== ''
        && entry.scratch !== ownClient.scratch, 'the two parallel Scenes share a Client scratch')
      for (const business of entry.businessIdentities ?? []) {
        for (const ownEntry of own.processClients ?? []) {
          assert(business.pid !== ownEntry.shellPid, 'the two parallel Scenes share a Client shell/business PID')
          for (const ownBusiness of ownEntry.businessIdentities ?? []) {
            assert(business.pid !== ownBusiness.pid,
              'the two parallel Scenes share a business Client process')
          }
        }
      }
    }
  }

  #ownReceipt(): SupervisorReceipt | undefined {
    return this.#receipts().find(receipt => receipt.runId === this.runId)
  }

  #isSameLiveKernel(pid: number | null | undefined, birth: string | undefined, label: string): boolean {
    assert(typeof pid === 'number' && Number.isInteger(pid) && pid > 0, `${label}: no real PID`)
    assert(typeof birth === 'string' && birth !== '', `${label}: no recorded kernel birth`)
    const live = kernelBirthOf(pid)
    if (live === undefined) return false
    return live === birth
  }

  /** Re-prove the receipt names live, still-same kernel identities. */
  #isReceiptSceneLive(other: SupervisorReceipt): boolean {
    let live = this.#isSameLiveKernel(other.host?.pid, other.host?.birth,
      'the parallel Scene Host')
    for (const entry of other.processClients ?? []) {
      live = this.#isSameLiveKernel(entry.shellPid, entry.shellBirth,
        'the parallel Scene Client shell') && live
      for (const business of entry.businessIdentities ?? []) {
        live = this.#isSameLiveKernel(business.pid, business.birth,
          'the parallel Scene Client business process') && live
      }
    }
    return live
  }

  /**
   * Normal teardown: close every Client the test left open (graceful /exit only
   * with a proven current non-destructive choice), then let the Supervisor own
   * the final proof and root removal. Cleanup failures are returned, never
   * swallowed.
   */
  async dispose(): Promise<void> {
    const errors: Error[] = []
    for (const client of [...this.#clients].reverse()) {
      if (client.closed) continue
      try {
        await client.exitGracefully()
      } catch (error) {
        errors.push(asError(error))
      }
    }
    for (const host of [...this.#hosts].reverse()) {
      if (host.exited) continue
      try {
        await this.stopHost(host)
      } catch (error) {
        errors.push(asError(error))
      }
    }
    const clientsClosed = this.#clients.every(client => client.closed) && errors.length === 0
    try {
      await this.request('FINALIZE', { clientsClosed }, 240_000)
    } catch (error) {
      errors.push(new Error(`Supervisor FINALIZE failed: ${asError(error).message}`))
    }
    try {
      const exit = await this.#supervisor.waitExit(60_000)
      if (exit.code !== 0 || exit.signal !== null) {
        errors.push(new Error(`Supervisor exited abnormally: ${JSON.stringify(exit)}`))
      }
    } catch (error) {
      errors.push(asError(error))
    }
    if (errors.length > 0) {
      throw new AggregateError(errors,
        `split-process Scene cleanup failed with ${String(errors.length)} error(s); evidence root: ${this.workDir}`)
    }
  }
}

async function createScene(): Promise<ProcessScene> {
  const tmpBase = requireAbsoluteDirectory('SPLIT_VITEST_TMP_BASE')
  const tarball = requireCandidateTarball()
  const candidate = profileModule.inspectImmutableSplitCandidate(tarball)
  const parentRunId = process.env.SPLIT_VITEST_RUN_ID ?? process.env.SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID
  const runId = `split-process-${randomUUID()}`
  const supervisor = new SupervisorClient({ runId })
  try {
    const facts = await supervisor.request('BOOTSTRAP_PROCESS', {
      tarball: candidate.tarball,
      expectedSha256: candidate.candidateSha256,
      tmpBase,
      workerPid: process.pid,
      workerPpid: process.ppid,
      sceneId: runId,
      ...(parentRunId === undefined || parentRunId === '' ? {} : { parentRunId }),
    }, { timeoutMs: 1_200_000 }) as Record<string, any>
    return new ProcessScene(facts, supervisor, runId, tmpBase)
  } catch (error) {
    try {
      await supervisor.close({ timeoutMs: 300_000, allowKill: false })
    } catch (closeError) {
      throw new AggregateError([error, closeError],
        'BOOTSTRAP_PROCESS failed and the Supervisor did not reach a bounded exit')
    }
    throw error
  }
}

/**
 * Create the ONE typed Scene of a business file.
 *
 * A file owns exactly one Scene and must `dispose()` it; each worker gets a
 * unique Supervisor receipt and a unique Scene root under the run's private
 * base.
 */
export async function createSplitProcessScene(): Promise<SplitProcessScene> {
  return await createScene()
}

export type { SessionEvent }
