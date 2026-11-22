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
  close(): Promise<void>
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
  }): Promise<UpgradeClientHandle>
  installNewProfileForReload(): Promise<InstalledPackageFacts>
  activateNewProfileAfterOldStopped(): Promise<InstalledPackageFacts>
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

function messageText(message: Record<string, any> | undefined): string {
  return (message?.content ?? [])
    .map((part: Record<string, any>) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

class UpgradeClient implements UpgradeClientHandle {
  readonly label: string
  readonly sessionId: string
  readonly recordFile: string
  readonly terminal: TuiTest
  closed = false

  constructor(label: string, terminal: TuiTest, recordFile: string) {
    this.label = label
    this.terminal = terminal
    this.sessionId = terminal.session
    this.recordFile = recordFile
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
            const frame = await this.terminal.text().catch(() => '')
            if (frame.includes('Disconnect from dsh-pi-tui')) {
              await this.#waitForText('Keep working and disconnect', `${this.label} busy exit choice`, 15_000, false)
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
      this.closed = true
      // Native terminal teardown is unconditional: a failed /exit or a
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
    if (errors.length > 0) throw new AggregateError(errors, `${this.label} close failed`)
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
    let reexecEnv: Record<string, string> = {}
    if (options.reexecTargetPackageRoot !== undefined) {
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
    const client = new UpgradeClient(options.label, terminal, recordFile)
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
    }
    try {
      const opened = await terminal.run(process.execPath, [entry], {
        cwd: this.installation.profileDir,
        cols: 100,
        rows: 30,
        waitReady: false,
        env,
      })
      await client.waitForRecord(record => record.m4a0 === 'ready', `${options.label} official ready record`, 120_000)
      // U0 records the initial Client lifetime. A reexec/U1 driver must re-read
      // and report replacement business PIDs after its handoff; this snapshot
      // alone is not future-reexec coverage.
      const businessPids = client.businessPids()
      assert(businessPids.length > 0, `${options.label}: the official record sink carried no business PID`)
      await this.#supervisor.request('REPORT', {
        event: 'client-started',
        detail: {
          label: options.label,
          session: terminal.session,
          shellPid: opened.shell_pid ?? null,
          recordFile,
          businessPids,
        },
      }, { timeoutMs: 10_000 })
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

  async report(event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.#supervisor.request('REPORT', { event, detail }, { timeoutMs: 10_000 })
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
