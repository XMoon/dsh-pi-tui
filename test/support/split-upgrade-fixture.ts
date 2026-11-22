/**
 * The ONE Upgrade Scene used by Vitest tests and by the external OS probe.
 *
 * This module deliberately does not import Vitest's `test` global: it is a
 * plain TypeScript module so `test/support/split-upgrade-probe-worker.mjs` can
 * execute the same Scene outside a Vitest worker. The Supervisor owns the
 * scene root, profile/side installs and every Host generation; a worker owns
 * only real tui-test Clients and their exact native TUI sessions.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/split-upgrade-fixture
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { TuiTest, sessions as openTuiSessions } from '@microsoft/tui-test'

import { SupervisorClient } from './split-supervisor-client.ts'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(SUPPORT_DIR, '..', '..'))

interface SplitUpgradePairModule {
  inspectSplitUpgradePair(
    oldTgz: string,
    newTgz: string,
    options?: { policy?: 'default' | 'native' },
  ): UpgradePairFacts
  readSplitUpgradePairEnvironment(): { oldTgz: string; newTgz: string }
}

const splitUpgradePair = await import(
  pathToFileURL(join(REPO_ROOT, 'test', 'support', 'split-upgrade-pair.mjs')).href
) as SplitUpgradePairModule

export interface UpgradePackageFacts {
  path: string
  version: string
  sha256: string
  manifestPin: string
}

export interface UpgradePairFacts {
  old: UpgradePackageFacts
  new: UpgradePackageFacts
  targetDshVersion: string
  policy: 'default' | 'native'
}

export interface InstallationFacts {
  workDir: string
  dshHome: string
  profileDir: string
  entries: { host: string; client: string }
  anchor: string
  base: { cwd: string; env: Record<string, string> }
  scratch: string
}

interface SceneBootstrapFacts {
  workDir: string
  pair: UpgradePairFacts
  installation: InstallationFacts
  c1Work: { patchPath: string }
  oldProfile: InstalledPackageFacts
}

export interface InstalledPackageFacts {
  packageRoot: string
  version: string
  buildId: string
  payloadHash: string
  entries: { host: string; client: string }
}

export interface OpaqueHostHandle {
  readonly hostId: string
  readonly generation: number
  readonly source: 'profile' | 'side-old'
  readonly ready: Record<string, any>
  readonly workRoot: string
  readonly buildId?: string
  readonly pgid?: number
  exited: boolean
  exitResult?: HostExitFacts
}

export interface HostExitFacts {
  code: number | null
  signal: NodeJS.Signals | null
  generation: number
}

export interface UpgradeClientHandle {
  readonly label: string
  /** The exact tui-test native session id owned by this Client. */
  readonly sessionId: string
  readonly recordFile: string
  readonly terminal: TuiTest
  readonly qualificationProbe?: boolean
  /** The Scene-owned side-new target this Client was started with before it existed. */
  readonly plannedSideNewReexecTarget?: string
  closed?: boolean
  readRecords(): Record<string, any>[]
  waitForRecord(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
  businessPid(): Promise<number | undefined>
  businessPids(): number[]
  press(...keys: string[]): Promise<void>
  submit(text: string): Promise<void>
  type(text: string): Promise<void>
  text(full?: boolean): Promise<string>
  isAlive(): Promise<boolean>
  /**
   * Wait for the real tui-test shell exit fact of this Client. A JSONL record
   * never substitutes for the native process outcome.
   */
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: string | null }>
  /**
   * Reclaim a Client whose nonzero exit was itself the assertion: only a
   * Client started with `startupExpectation: 'expected-failure'` or with a
   * replacement-child fault may call it.
   */
  closeExpectedFailure(expectedCode: number): Promise<void>
  close(): Promise<void>
}

/** The qualification-only proof a real new-build Client process produced. */
export interface SideNewClientHostFoundationProof {
  readonly clientPid: number
  readonly hostPid: number
  readonly hostInstanceId: string
  readonly officialSessionList: true
  readonly privateFileRpc: true
  readonly terminalSnapshot: true
  readonly cleaned: true
  readonly exitCode: 0
}

export interface UpgradeScene {
  readonly sceneId: string
  readonly workRoot: string
  readonly pair: UpgradePairFacts
  readonly installation: InstallationFacts
  installOldProfile(): Promise<InstalledPackageFacts>
  installOldSideBySide(): Promise<InstalledPackageFacts>
  installNewSideBySide(): Promise<InstalledPackageFacts>
  startHost(options: { source: 'profile' | 'side-old'; scenario: string }): Promise<OpaqueHostHandle>
  stopHost(host: OpaqueHostHandle): Promise<HostExitFacts>
  startClient(options: {
    source: 'profile' | 'side-old' | 'side-new'
    label: string
    sessionId?: string
    reexecTargetPackageRoot?: string
    /**
     * Reserve the Scene-owned side-new reexec target for an old Client that
     * starts BEFORE the side-by-side install exists. The target is written into
     * the Client environment only; nothing is created or installed here.
     */
    plannedSideNewReexecTarget?: true
    /** Inject the existing replacement-child bootstrap fault into the child only. */
    reexecChildFailure?: 'client-bootstrap'
    /** The official Host instance this Client must authenticate. */
    expectedHostInstanceId?: string
    /**
     * `expected-failure` registers the real Client process and returns without
     * waiting for ready: the negative control owns the nonzero outcome.
     */
    startupExpectation?: 'ready' | 'expected-failure'
  }): Promise<UpgradeClientHandle>
  installNewProfileForReload(): Promise<InstalledPackageFacts>
  activateNewProfileAfterOldStopped(): Promise<InstalledPackageFacts>
  /**
   * Run ONE real new-build qualification Client process against the live old
   * Host generation. The Supervisor owns the subprocess and its cleanup.
   */
  probeSideNewClientHostFoundation(host: OpaqueHostHandle): Promise<SideNewClientHostFoundationProof>
  /** Read the live official Host identity from the Supervisor-owned generation. */
  hostStatus(host: OpaqueHostHandle): Promise<Record<string, any>>
  /** Ask the Supervisor that owns this Host generation to release its C1 barrier. */
  releaseHeldTurn(host: OpaqueHostHandle): Promise<void>
  /** Run the official profile remove transaction for the target-invalid negative. */
  removeProfilePackageForReloadRefusal(host: OpaqueHostHandle): Promise<void>
  /** Send SIGUSR2 only to this Scene's live qualification-probe business PID. */
  signalClientForQualification(client: UpgradeClientHandle): Promise<number>
  /** Merge the official JSONL business-PID ledger into the Supervisor receipt. */
  refreshClientBusinessPids(client?: UpgradeClientHandle): Promise<void>
  /** Probe-only barrier reporting into the Supervisor receipt. */
  report(event: string, detail?: Record<string, unknown>): Promise<void>
  finish(): Promise<void>
  dispose(): Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

function processEnvironmentHas(pid: number, entry: string): boolean {
  const procEnviron = `/proc/${String(pid)}/environ`
  let environment: string
  if (existsSync(procEnviron)) {
    environment = readFileSync(procEnviron, 'utf8').split('\0').join('\n')
  } else {
    try {
      environment = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    } catch (error) {
      throw new Error(`could not read the environment of business PID ${String(pid)}: ${asError(error).message}`)
    }
  }
  return environment.split(/\s+/u).includes(entry)
}

function messageText(message: Record<string, any> | undefined): string {
  return (message?.content ?? [])
    .map((part: Record<string, any>) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/** The product's Host instance UUID shape; an invalid expectation must not start. */
const HOST_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/**
 * The exact package path `installSideBuild()` materializes for the side-new
 * install. A pre-install old Client receives this Scene-owned path as its
 * qualification target; the Scene never creates it early.
 */
function reservedSideNewTarget(workRoot: string): string {
  return join(workRoot, 'side-new', 'node_modules', '@xmoon76', 'dsh-pi-tui')
}

function reexecTargetPresent(env: Record<string, string>): boolean {
  return typeof env.SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT === 'string'
}

interface UpgradeClientOptions {
  readonly qualificationProbe: boolean
  readonly plannedSideNewReexecTarget?: string
  /** The Client was started to observe a deterministic nonzero startup. */
  readonly expectedFailure: boolean
  /** The Client carries the replacement-child bootstrap fault. */
  readonly replacementChildFault: boolean
  /** Merge this Client's official JSONL business-PID ledger into the Supervisor. */
  readonly refreshBusinessPids: () => Promise<void>
}

class UpgradeClient implements UpgradeClientHandle {
  readonly label: string
  readonly sessionId: string
  readonly recordFile: string
  readonly terminal: TuiTest
  readonly qualificationProbe: boolean
  readonly plannedSideNewReexecTarget: string | undefined
  closed = false
  readonly #expectedFailure: boolean
  readonly #replacementChildFault: boolean
  readonly #refreshBusinessPids: () => Promise<void>

  constructor(label: string, terminal: TuiTest, recordFile: string, options: UpgradeClientOptions) {
    this.label = label
    this.terminal = terminal
    this.sessionId = terminal.session
    this.recordFile = recordFile
    this.qualificationProbe = options.qualificationProbe
    this.plannedSideNewReexecTarget = options.plannedSideNewReexecTarget
    this.#expectedFailure = options.expectedFailure
    this.#replacementChildFault = options.replacementChildFault
    this.#refreshBusinessPids = options.refreshBusinessPids
  }

  readRecords(): Record<string, any>[] {
    if (!existsSync(this.recordFile)) return []
    const text = readFileSync(this.recordFile, 'utf8')
    if (text === '') return []
    if (!text.endsWith('\n')) {
      throw new Error(`${this.label}: the official client record file has an incomplete trailing line`)
    }
    const lines = text.slice(0, -1).split('\n')
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, any>
      } catch (error) {
        throw new Error(`${this.label}: client record line ${String(index + 1)} is invalid JSON: ${asError(error).message}`)
      }
    })
  }

  async waitForRecord(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<Record<string, any>> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const record = this.readRecords().find(predicate)
      if (record !== undefined) return record
      await sleep(25)
    }
    throw new Error(`${label}: no matching official client record within ${String(timeoutMs)}ms`)
  }

  businessPids(): number[] {
    const pids = new Set<number>()
    for (const record of this.readRecords()) {
      if (record?.m4a0 === 'ready' || record?.m4a0 === 'client-started') {
        if (Number.isInteger(record.pid) && record.pid > 0) pids.add(record.pid)
      }
    }
    return [...pids]
  }

  async businessPid(): Promise<number | undefined> {
    const pids = this.businessPids()
    return pids.at(-1)
  }

  async press(...keys: string[]): Promise<void> {
    await this.terminal.press(...keys)
  }

  async submit(text: string): Promise<void> {
    await this.terminal.submit(text)
  }

  async type(text: string): Promise<void> {
    await this.terminal.type(text)
  }

  async text(full = false): Promise<string> {
    return await this.terminal.text({ full })
  }

  async isAlive(): Promise<boolean> {
    const state = await this.terminal.state().catch(() => undefined)
    return state !== undefined && state.exited === null
  }

  async close(): Promise<void> {
    if (this.closed) return
    const errors: Error[] = []
    try {
      const state = await this.terminal.state().catch(() => undefined)
      if (state !== undefined && state.exited !== null) {
        if (state.exited !== 0) errors.push(new Error(`${this.label} was already exited with code ${String(state.exited)}`))
      } else {
        await this.terminal.submit('/exit')
        const deadline = Date.now() + 60_000
        let choiceTaken = false
        let exited = false
        while (Date.now() < deadline) {
          const current = await this.terminal.state().catch(() => undefined)
          if (current !== undefined && current.exited !== null) {
            if (current.exited !== 0) errors.push(new Error(`${this.label} exit code was ${String(current.exited)}`))
            exited = true
            break
          }
          if (!choiceTaken) {
            const frame = await this.terminal.text({ full: true }).catch(() => '')
            if (frame.includes('Disconnect from dsh-pi-tui')) {
              await this.#waitForText('Keep working and disconnect', `${this.label} busy exit choice`, 60_000, true)
              await this.terminal.press('Enter')
              choiceTaken = true
            }
          }
          await sleep(100)
        }
        if (!exited) errors.push(new Error(`${this.label} did not exit after /exit`))
      }
    } catch (error) {
      errors.push(asError(error))
    } finally {
      await this.#teardownNative(errors)
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.label} close failed`)
  }

  async waitForExit(timeoutMs = 120_000): Promise<{ code: number | null; signal: string | null }> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const state = await this.terminal.state().catch(() => undefined)
      if (state !== undefined && state.exited !== null) {
        return { code: state.exited, signal: state.exit_signal ?? null }
      }
      await sleep(50)
    }
    throw new Error(`${this.label}: the real tui-test shell did not exit within ${String(timeoutMs)}ms`)
  }

  async closeExpectedFailure(expectedCode: number): Promise<void> {
    assert(Number.isInteger(expectedCode) && expectedCode !== 0,
      `closeExpectedFailure: ${this.label} requires a nonzero expected exit code`)
    assert(this.#expectedFailure || this.#replacementChildFault,
      `closeExpectedFailure: ${this.label} was not started with an expected-failure expectation or a replacement-child fault`)
    assert(!this.closed, `closeExpectedFailure: ${this.label} is already closed`)
    const errors: Error[] = []
    try {
      const exit = await this.waitForExit()
      if (exit.code !== expectedCode || exit.signal !== null) {
        errors.push(new Error(`${this.label} exited ${JSON.stringify(exit)}; expected code ${String(expectedCode)} with no signal`))
      }
    } catch (error) {
      errors.push(asError(error))
    }
    await this.#teardownNative(errors)
    try {
      await this.#refreshBusinessPids()
    } catch (error) {
      errors.push(asError(error))
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.label} expected-failure reclaim failed`)
  }

  async #teardownNative(errors: Error[]): Promise<void> {
    this.closed = true
    // Native terminal teardown is unconditional: a failed exit wait or a
    // thrown busy-choice wait must never strand the real PTY session.
    try {
      await this.terminal.closeQuiet()
    } catch (error) {
      errors.push(asError(error))
    }
    try {
      const openSessions = new Set(await openTuiSessions())
      if (openSessions.has(this.sessionId)) {
        errors.push(new Error(`${this.label} left its native TUI session open after close`))
      }
    } catch (error) {
      errors.push(asError(error))
    }
  }

  async #waitForText(text: string, label: string, timeoutMs: number, full: boolean): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const frame = await this.terminal.text({ full }).catch(() => '')
      if (frame.includes(text)) return
      await sleep(50)
    }
    throw new Error(`${label}: the terminal never showed ${JSON.stringify(text)} within ${String(timeoutMs)}ms`)
  }
}

class Scene implements UpgradeScene {
  readonly sceneId: string
  readonly workRoot: string
  readonly pair: UpgradePairFacts
  readonly installation: InstallationFacts
  readonly #supervisor: SupervisorClient
  readonly #c1Work: { patchPath: string }
  readonly #hosts: OpaqueHostHandle[] = []
  readonly #clients = new Map<string, UpgradeClient>()
  readonly #ownedTuiSessions = new Set<string>()
  #clientSequence = 0
  #sideOld: InstalledPackageFacts | undefined
  #sideNew: InstalledPackageFacts | undefined
  #finished = false

  constructor(facts: SceneBootstrapFacts, supervisor: SupervisorClient, sceneId: string) {
    this.sceneId = sceneId
    this.workRoot = facts.workDir
    this.pair = facts.pair
    this.installation = facts.installation
    this.#c1Work = facts.c1Work
    this.#supervisor = supervisor
    mkdirSync(join(this.workRoot, 'trace'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.workRoot, 'artifacts'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.workRoot, 'clients'), { recursive: true, mode: 0o700 })
  }

  get supervisorPids(): { worker: number; supervisor: number | undefined } {
    return this.#supervisor.pids
  }

  async installOldProfile(): Promise<InstalledPackageFacts> {
    return await this.#supervisor.request('UPGRADE_INSTALL_OLD_PROFILE', {}, { timeoutMs: 30_000 })
  }

  async installOldSideBySide(): Promise<InstalledPackageFacts> {
    const facts = await this.#supervisor.request('UPGRADE_INSTALL_SIDE_OLD', {}, { timeoutMs: 600_000 })
    this.#sideOld = facts
    return facts
  }

  async installNewSideBySide(): Promise<InstalledPackageFacts> {
    const facts = await this.#supervisor.request('UPGRADE_INSTALL_SIDE_NEW', {}, { timeoutMs: 600_000 })
    this.#sideNew = facts
    // A Client may already hold the reserved reexec target. Once the real
    // side-by-side install exists, that exact Scene-owned path must resolve to
    // the installed new package; a wrong target must fail before any SIGUSR2.
    for (const client of this.#clients.values()) {
      if (client.plannedSideNewReexecTarget !== undefined) this.#assertPlannedSideNewTarget(client)
    }
    return facts
  }

  async startHost(options: { source: 'profile' | 'side-old'; scenario: string }): Promise<OpaqueHostHandle> {
    assert(options.source === 'profile' || options.source === 'side-old', `START_HOST: unsupported source ${String(options.source)}`)
    const payload = await this.#supervisor.request('START_HOST', {
      source: options.source,
      scenario: options.scenario,
    }, { timeoutMs: 240_000 })
    const host: OpaqueHostHandle = {
      hostId: String(payload.hostId),
      generation: Number(payload.generation),
      source: options.source,
      ready: payload.ready,
      workRoot: String(payload.workRoot),
      ...(typeof payload.buildId === 'string' ? { buildId: payload.buildId } : {}),
      ...(Number.isInteger(payload.pgid) ? { pgid: payload.pgid } : {}),
      exited: false,
    }
    this.#hosts.push(host)
    return host
  }

  async stopHost(host: OpaqueHostHandle): Promise<HostExitFacts> {
    if (host.exited) {
      const result = host.exitResult
      assert(result !== undefined && result.code === 0 && result.signal === null,
        `Host ${host.hostId} had already exited abnormally: ${JSON.stringify(result)}`)
      return result
    }
    const result = await this.#supervisor.request('STOP_HOST', { hostId: host.hostId }, { timeoutMs: 90_000 })
    const exit: HostExitFacts = {
      code: result.code ?? null,
      signal: result.signal ?? null,
      generation: result.generation ?? host.generation,
    }
    host.exited = true
    host.exitResult = exit
    assert(exit.code === 0 && exit.signal === null, `Host ${host.hostId} shutdown was ${JSON.stringify(exit)}`)
    return exit
  }

  async startClient(options: {
    source: 'profile' | 'side-old' | 'side-new'
    label: string
    sessionId?: string
    reexecTargetPackageRoot?: string
    plannedSideNewReexecTarget?: true
    reexecChildFailure?: 'client-bootstrap'
    expectedHostInstanceId?: string
    startupExpectation?: 'ready' | 'expected-failure'
  }): Promise<UpgradeClientHandle> {
    let entry: string
    if (options.source === 'profile') {
      entry = this.installation.entries.client
    } else if (options.source === 'side-old') {
      assert(this.#sideOld !== undefined, 'startClient: side-old has not been installed')
      entry = this.#sideOld.entries.client
    } else {
      assert(this.#sideNew !== undefined, 'startClient: side-new has not been installed')
      entry = this.#sideNew.entries.client
    }
    const startupExpectation = options.startupExpectation ?? 'ready'
    assert(startupExpectation === 'ready' || startupExpectation === 'expected-failure',
      `startClient: unsupported startupExpectation ${String(options.startupExpectation)}`)
    let reservedTarget: string | undefined
    let reexecEnv: Record<string, string> = {}
    if (options.plannedSideNewReexecTarget === true) {
      assert(options.reexecTargetPackageRoot === undefined,
        'startClient: plannedSideNewReexecTarget and reexecTargetPackageRoot are mutually exclusive')
      assert(options.source === 'profile' || options.source === 'side-old',
        'startClient: plannedSideNewReexecTarget only applies to a profile or side-old Client')
      reservedTarget = reservedSideNewTarget(this.workRoot)
      reexecEnv = {
        SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
        SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: reservedTarget,
      }
    } else if (options.reexecTargetPackageRoot !== undefined) {
      assert(this.#sideNew !== undefined, 'startClient: a reexec target requires the side-new installation')
      const target = realpathSync(options.reexecTargetPackageRoot)
      const relativeTarget = relative(this.#sideNew.packageRoot, target)
      assert(relativeTarget === '' || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== '..'),
        'startClient: reexecTargetPackageRoot must be the Scene-owned side-new package root')
      assert(this.#sideNew.packageRoot === target,
        'startClient: reexecTargetPackageRoot must be the exact side-new package root')
      reexecEnv = {
        SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
        SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: target,
      }
    }
    if (options.reexecChildFailure !== undefined) {
      assert(options.reexecChildFailure === 'client-bootstrap',
        `startClient: unsupported reexecChildFailure ${String(options.reexecChildFailure)}`)
      assert(reexecTargetPresent(reexecEnv),
        'startClient: reexecChildFailure requires a managed reexec target')
      reexecEnv = { ...reexecEnv, SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE: options.reexecChildFailure }
    }
    let expectationEnv: Record<string, string> = {}
    if (options.expectedHostInstanceId !== undefined) {
      assert(HOST_INSTANCE_ID_PATTERN.test(options.expectedHostInstanceId),
        'startClient: expectedHostInstanceId must be a Host instance UUID')
      assert(!reexecTargetPresent(reexecEnv),
        'startClient: expectedHostInstanceId cannot combine with the reexec qualification probe')
      expectationEnv = { SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: options.expectedHostInstanceId }
    }
    if (startupExpectation === 'expected-failure') {
      assert(options.expectedHostInstanceId !== undefined,
        'startClient: startupExpectation expected-failure requires expectedHostInstanceId')
    }
    const sequence = ++this.#clientSequence
    const clientDir = join(this.workRoot, 'clients', `${options.label}-${String(sequence)}`)
    mkdirSync(clientDir, { recursive: true, mode: 0o700 })
    chmodSync(clientDir, 0o700)
    const recordFile = join(clientDir, 'records.jsonl')
    const scratch = join(clientDir, 'scratch')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const terminal = TuiTest.ephemeral('split-upgrade', {
      backend: 'xtermjs',
      trace: { mode: 'on-failure', directory: join(this.workRoot, 'trace') },
      artifacts: { dir: join(this.workRoot, 'artifacts'), onFailure: 'text' },
    })
    const client: UpgradeClient = new UpgradeClient(options.label, terminal, recordFile, {
      qualificationProbe: reexecTargetPresent(reexecEnv),
      ...(reservedTarget === undefined ? {} : { plannedSideNewReexecTarget: reservedTarget }),
      expectedFailure: startupExpectation === 'expected-failure',
      replacementChildFault: options.reexecChildFailure !== undefined,
      refreshBusinessPids: () => this.refreshClientBusinessPids(client),
    })
    this.#ownedTuiSessions.add(terminal.session)
    this.#clients.set(options.label, client)
    const env: Record<string, string> = {
      ...this.installation.base.env,
      SPLIT_PROCESS_DSH_ANCHOR: this.installation.anchor,
      SPLIT_PROCESS_PROFILE: 'pi-tui',
      SPLIT_PROCESS_CLIENT_MODE: 'surface',
      SPLIT_PROCESS_SCRATCH: scratch,
      SPLIT_PROCESS_CLIENT_RECORD_FILE: recordFile,
      ...(options.sessionId === undefined ? {} : { SPLIT_PROCESS_CLIENT_SESSION: options.sessionId }),
      ...reexecEnv,
      ...expectationEnv,
    }
    try {
      const opened = await terminal.run(process.execPath, [entry], {
        cwd: this.installation.profileDir,
        cols: 100,
        rows: 30,
        waitReady: false,
        env,
      })
      // Register the real Client process BEFORE any ready/failure outcome: a
      // fast nonzero exit must never escape the IPC-disconnect cleanup. The
      // initial lifetime is not future-reexec coverage; a reexec driver
      // reports the replacement PIDs itself.
      const started = await client.waitForRecord(
        record => record.m4a0 === 'client-started',
        `${options.label} official client-started record`,
        60_000,
      )
      assert(Number.isInteger(started.pid) && started.pid > 0,
        `${options.label}: the official client-started record carries no real business PID`)
      await this.#supervisor.request('REPORT', {
        event: 'client-started',
        detail: {
          label: options.label,
          session: terminal.session,
          shellPid: opened.shell_pid ?? null,
          recordFile,
          businessPids: [started.pid],
        },
      }, { timeoutMs: 10_000 })
      if (startupExpectation === 'expected-failure') return client
      await client.waitForRecord(record => record.m4a0 === 'ready', `${options.label} official ready record`, 120_000)
      await this.#waitForPaintedFrame(client, `${options.label} painted its first frame`, 30_000)
    } catch (error) {
      try {
        await client.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], `${options.label} start failed and its Client cleanup failed`)
      }
      throw error
    }
    return client
  }

  async installNewProfileForReload(): Promise<InstalledPackageFacts> {
    return await this.#supervisor.request('UPGRADE_INSTALL_NEW_PROFILE_FOR_RELOAD', {}, { timeoutMs: 600_000 })
  }

  async activateNewProfileAfterOldStopped(): Promise<InstalledPackageFacts> {
    return await this.#supervisor.request('UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP', {}, { timeoutMs: 600_000 })
  }

  async hostStatus(host: OpaqueHostHandle): Promise<Record<string, any>> {
    this.#assertHost(host)
    return await this.#supervisor.request('HOST_STATUS', { hostId: host.hostId }, { timeoutMs: 30_000 })
  }

  async releaseHeldTurn(host: OpaqueHostHandle): Promise<void> {
    this.#assertHost(host)
    await this.#supervisor.request('UPGRADE_RELEASE_HELD_TURN', { hostId: host.hostId }, { timeoutMs: 30_000 })
  }

  async removeProfilePackageForReloadRefusal(host: OpaqueHostHandle): Promise<void> {
    this.#assertHost(host)
    await this.#supervisor.request('UPGRADE_REMOVE_PROFILE_FOR_RELOAD_REFUSAL', { hostId: host.hostId }, { timeoutMs: 120_000 })
  }

  async signalClientForQualification(client: UpgradeClientHandle): Promise<number> {
    assert(this.#clients.get(client.label) === client, `signalClientForQualification: ${client.label} is not this Scene's Client`)
    assert(client.qualificationProbe, `signalClientForQualification: ${client.label} was not started with the reexec qualification probe`)
    assert(!client.closed, `signalClientForQualification: ${client.label} is already closed`)
    if (client.plannedSideNewReexecTarget !== undefined) this.#assertPlannedSideNewTarget(client)
    const pids = client.businessPids()
    assert(pids.length === 1, `signalClientForQualification: ${client.label} has ${String(pids.length)} business PIDs; expected exactly one initial PID`)
    const pid = pids[0]!
    assert(pidAlive(pid), `signalClientForQualification: ${client.label} business PID ${String(pid)} is not alive`)
    assert(processEnvironmentHas(pid, 'SPLIT_PROCESS_CLIENT_REEXEC_PROBE=1'),
      `signalClientForQualification: business PID ${String(pid)} does not carry the reexec qualification probe environment`)
    process.kill(pid, 'SIGUSR2')
    await this.report('qualification-signal', {
      label: client.label,
      pid,
      recordFile: client.recordFile,
      session: client.sessionId,
    })
    return pid
  }

  async probeSideNewClientHostFoundation(host: OpaqueHostHandle): Promise<SideNewClientHostFoundationProof> {
    this.#assertHost(host)
    assert(this.#sideNew !== undefined, 'probeSideNewClientHostFoundation: side-new has not been installed')
    const proof = await this.#supervisor.request(
      'UPGRADE_PROBE_SIDE_NEW_CLIENT_HOST_FOUNDATION',
      { hostId: host.hostId },
      { timeoutMs: 240_000 },
    ) as SideNewClientHostFoundationProof
    assert(Number.isInteger(proof.clientPid) && proof.clientPid > 0,
      'probeSideNewClientHostFoundation: the proof carries no real Client PID')
    assert(Number.isInteger(proof.hostPid) && proof.hostPid > 0,
      'probeSideNewClientHostFoundation: the proof carries no real Host PID')
    assert(typeof proof.hostInstanceId === 'string' && proof.hostInstanceId !== '',
      'probeSideNewClientHostFoundation: the proof carries no Host instance id')
    assert(proof.officialSessionList === true && proof.privateFileRpc === true
      && proof.terminalSnapshot === true && proof.cleaned === true && proof.exitCode === 0,
      'probeSideNewClientHostFoundation: the official/private RPC proof is incomplete')
    return proof
  }

  async refreshClientBusinessPids(client?: UpgradeClientHandle): Promise<void> {
    const targets = client === undefined ? [...this.#clients.values()] : [client]
    for (const target of targets) {
      assert(this.#clients.get(target.label) === target, `refreshClientBusinessPids: ${target.label} is not this Scene's Client`)
      await this.#supervisor.request('REPORT', {
        event: 'client-pids',
        detail: {
          label: target.label,
          session: target.sessionId,
          recordFile: target.recordFile,
          businessPids: target.businessPids(),
        },
      }, { timeoutMs: 10_000 })
    }
  }

  async report(event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.#supervisor.request('REPORT', { event, detail }, { timeoutMs: 10_000 })
  }

  #assertHost(host: OpaqueHostHandle): void {
    assert(this.#hosts.includes(host), `Host ${host.hostId} is not owned by this Scene`)
    assert(!host.exited, `Host ${host.hostId} is not alive`)
  }

  #assertPlannedSideNewTarget(client: UpgradeClientHandle): void {
    const facts = this.#sideNew
    assert(facts !== undefined,
      `signalClientForQualification: ${client.label} needs the side-new installation before its qualification target can be used`)
    const target = client.plannedSideNewReexecTarget
    assert(target !== undefined, `signalClientForQualification: ${client.label} has no planned side-new target`)
    assert(existsSync(target), `signalClientForQualification: the reserved side-new target is not installed: ${target}`)
    const resolved = realpathSync(target)
    assert(resolved === facts.packageRoot,
      `signalClientForQualification: the reserved side-new target resolves to ${resolved}, not the installed ${facts.packageRoot}`)
  }

  async finish(): Promise<void> {
    assert(!this.#finished, 'finish(): the Scene is already finished')
    const errors: Error[] = []
    for (const client of this.#clients.values()) {
      if (!client.closed) errors.push(new Error(`${client.label} is still open; finish() requires every Client closed`))
    }
    const openSessions = new Set(await openTuiSessions())
    const leftover = [...this.#ownedTuiSessions].filter(session => openSessions.has(session))
    if (leftover.length > 0) errors.push(new Error(`native TUI sessions are still open: ${JSON.stringify(leftover)}`))
    if (errors.length > 0) throw new AggregateError(errors, 'finish(): owned Clients are not closed')
    await this.refreshClientBusinessPids()
    await this.#supervisor.request('FINALIZE', { clientsClosed: true }, { timeoutMs: 180_000 })
    const exit = await this.#supervisor.waitExit(30_000)
    assert(exit.code === 0 && exit.signal === null, `Supervisor FINALIZE exit was ${JSON.stringify(exit)}`)
    assert(!existsSync(this.workRoot), `the Scene root still exists after FINALIZE: ${this.workRoot}`)
    this.#finished = true
  }

  async dispose(): Promise<void> {
    if (this.#finished) return
    const errors: Error[] = []
    for (const client of [...this.#clients.values()].reverse()) {
      try {
        await client.close()
      } catch (error) {
        errors.push(asError(error))
      }
    }
    try {
      await this.refreshClientBusinessPids()
    } catch (error) {
      errors.push(asError(error))
    }
    try {
      await this.#supervisor.close({ timeoutMs: 300_000, allowKill: false })
    } catch (error) {
      errors.push(asError(error))
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `upgrade Scene cleanup failed with ${String(errors.length)} error(s); evidence root: ${this.workRoot}`)
    }
  }

  async #waitForPaintedFrame(client: UpgradeClient, label: string, timeoutMs: number): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const frame = await client.text().catch(() => '')
      if (frame.trim() !== '') return
      await sleep(50)
    }
    throw new Error(`${label}: the terminal painted no visible frame within ${String(timeoutMs)}ms`)
  }
}

function requireAbsoluteDirectory(name: string): string {
  const raw = process.env[name]
  assert(typeof raw === 'string' && raw !== '' && isAbsolute(raw),
    `INPUT_UNQUALIFIED: ${name} must be an absolute path`)
  const real = realpathSync(raw)
  const stats = statSync(real)
  assert(stats.isDirectory(), `INPUT_UNQUALIFIED: ${name} is not a directory: ${real}`)
  if (typeof process.getuid === 'function') {
    assert(stats.uid === process.getuid(), `INPUT_UNQUALIFIED: ${name} is not owned by this user: ${real}`)
  }
  assert((stats.mode & 0o777) === 0o700, `INPUT_UNQUALIFIED: ${name} must have mode 0700: ${real}`)
  return real
}

/**
 * Create one isolated Upgrade Scene. The pair preflight runs BEFORE the
 * Supervisor is forked, so an invalid pairing creates no scene root, install
 * or Host process.
 */
export async function createUpgradeScene(): Promise<UpgradeScene> {
  const tmpBase = requireAbsoluteDirectory('SPLIT_VITEST_TMP_BASE')
  const { oldTgz, newTgz } = splitUpgradePair.readSplitUpgradePairEnvironment()
  const pair = splitUpgradePair.inspectSplitUpgradePair(oldTgz, newTgz, { policy: 'default' })
  const sceneId = randomUUID()
  const parentRunId = process.env.SPLIT_VITEST_RUN_ID
  const runId = `${parentRunId === undefined || parentRunId === '' ? 'split-upgrade' : parentRunId}-${sceneId}`
  const supervisor = new SupervisorClient({ runId })
  try {
    const facts = await supervisor.request('BOOTSTRAP_UPGRADE', {
      oldTgz: pair.old.path,
      newTgz: pair.new.path,
      expectedPairSha: { old: pair.old.sha256, new: pair.new.sha256 },
      tmpBase,
      workerPid: process.pid,
      workerPpid: process.ppid,
      sceneId,
      parentRunId,
    }, { timeoutMs: 600_000 }) as SceneBootstrapFacts
    return new Scene({ ...facts, pair }, supervisor, sceneId)
  } catch (error) {
    try {
      await supervisor.close({ timeoutMs: 300_000, allowKill: false })
    } catch (closeError) {
      throw new AggregateError([error, closeError],
        'BOOTSTRAP_UPGRADE failed and the Supervisor did not reach a bounded exit')
    }
    throw error
  }
}

export { messageText }
