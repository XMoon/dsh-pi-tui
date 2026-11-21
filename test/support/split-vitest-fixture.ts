import { fork, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { TuiTest, sessions as openTuiSessions } from '@microsoft/tui-test'
import { test as base } from 'vitest'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(SUPPORT_DIR, '..', '..'))
const SUPERVISOR_PATH = join(SUPPORT_DIR, 'split-host-supervisor.mjs')

interface CandidateFacts {
  tarball: string
  candidateSha256: string
  targetDshVersion: string
}

interface SplitInstallation {
  workDir: string
  dshHome: string
  profileDir: string
  entries: { host: string; client: string }
  anchor: string
  base: { cwd: string; env: Record<string, string> }
  scratch: string
}

interface C1WorkFixture {
  patchPath: string
}

interface SceneFacts {
  workDir: string
  candidate: CandidateFacts
  installation: SplitInstallation
  c1Work: C1WorkFixture
}

interface SessionEvent {
  type?: string
  data?: Record<string, any>
}

interface SplitSmokeFixturesModule {
  waitForC1WorkEvent(
    workRoot: string,
    predicate: (event: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
}

interface SplitSmokeSessionsModule {
  hostSessionEvents(dshHome: string, sessionId: string): SessionEvent[] | undefined
  hostUserTexts(events: SessionEvent[]): string[]
  waitForHostSessionEventAfter(
    dshHome: string,
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
}

async function loadModule<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(join(REPO_ROOT, relativePath)).href)) as T
}

const fixturesModule = await loadModule<SplitSmokeFixturesModule>('scripts/lib/split-smoke-fixtures.mjs')
const sessionsModule = await loadModule<SplitSmokeSessionsModule>('scripts/lib/split-smoke-sessions.mjs')

/** One Host identity owned by the Supervisor; the worker has no OS kill handle. */
interface HostHandle {
  readonly hostId: string
  readonly ready: Record<string, any>
  readonly workRoot: string
  exited: boolean
  exitResult?: { code: number | null; signal: NodeJS.Signals | null }
}

/** One live real-PTY Client owned by the test worker. */
interface ClientHandle {
  readonly label: string
  readonly terminal: TuiTest
  closed: boolean
  submit(text: string): Promise<void>
  press(...keys: string[]): Promise<void>
  type(text: string): Promise<void>
  text(full?: boolean): Promise<string>
  waitForText(text: string, label: string, timeoutMs?: number): Promise<void>
  waitForVisibleText(text: string, label: string, timeoutMs?: number): Promise<void>
  waitForVisibleTextGone(text: string, label: string, timeoutMs?: number): Promise<void>
  isAlive(): Promise<boolean>
}

export interface SplitS0Scene {
  readonly workDir: string
  readonly installation: SplitInstallation
  readonly candidate: CandidateFacts
  startHost(scenario: string, extraEnv?: Record<string, string>): Promise<HostHandle>
  shutdownHost(host: HostHandle): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  hostStatus(host: HostHandle): Promise<Record<string, any>>
  startClient(label: string, options?: { sessionId?: string }): Promise<ClientHandle>
  exitClient(client: ClientHandle): Promise<void>
  sessionIds(): Promise<string[]>
  waitForNewSessionId(before: ReadonlySet<string>, label: string, timeoutMs?: number): Promise<string>
  sessionEvents(sessionId: string): Promise<SessionEvent[] | undefined>
  waitForSessionEvent(
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
  waitForC1WorkEvent(
    workRoot: string,
    predicate: (event: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
  report(event: string, detail?: Record<string, unknown>): Promise<void>
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
  const raw = process.env.S0_CANDIDATE_TGZ
  assert(typeof raw === 'string' && raw !== '' && isAbsolute(raw),
    'INPUT_UNQUALIFIED: S0_CANDIDATE_TGZ must be an absolute path to the built candidate .tgz')
  let real: string
  try {
    real = realpathSync(raw)
  } catch (error) {
    throw new Error(`INPUT_UNQUALIFIED: S0_CANDIDATE_TGZ is not readable: ${asError(error).message}`)
  }
  assert(statSync(real).isFile(), `INPUT_UNQUALIFIED: S0_CANDIDATE_TGZ is not a file: ${real}`)
  assert(real.endsWith('.tgz'), `INPUT_UNQUALIFIED: S0_CANDIDATE_TGZ must be a .tgz: ${real}`)
  return real
}

function messageText(message: Record<string, any> | undefined): string {
  return (message?.content ?? [])
    .map((part: Record<string, any>) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
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

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  onProgress?: (message: Record<string, any>) => void
}

/** Worker-side IPC client for the one detached Supervisor process. */
class SupervisorClient {
  readonly #child: ChildProcess
  readonly #pending = new Map<string, PendingRequest>()
  readonly #exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  #exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined
  #sequence = 0

  constructor() {
    this.#child = fork(SUPERVISOR_PATH, [], {
      detached: true,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env,
    })
    this.#child.unref()
    this.#exitPromise = new Promise(resolve => {
      this.#child.once('exit', (code, signal) => {
        this.#exitResult = { code, signal }
        for (const [requestId, pending] of this.#pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`Supervisor exited before response to ${requestId}: ${JSON.stringify(this.#exitResult)}`))
          this.#pending.delete(requestId)
        }
        resolve(this.#exitResult)
      })
    })
    this.#child.on('message', (message: Record<string, any>) => {
      if (message?.type === 'PROGRESS') {
        const pending = this.#pending.get(String(message.requestId))
        pending?.onProgress?.(message)
        return
      }
      const requestId = typeof message?.requestId === 'string' ? message.requestId : undefined
      if (requestId === undefined) return
      const pending = this.#pending.get(requestId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.#pending.delete(requestId)
      if (message.type === 'ERROR') {
        const error = new Error(String(message.message ?? 'Supervisor request failed'))
        Object.assign(error, { code: message.code })
        pending.reject(error)
      } else {
        pending.resolve(message.payload)
      }
    })
  }

  get pids(): { worker: number; supervisor: number | undefined } {
    return { worker: process.pid, supervisor: this.#child.pid }
  }

  async request(
    type: string,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number; onProgress?: (message: Record<string, any>) => void } = {},
  ): Promise<any> {
    const requestId = `${type}-${String(++this.#sequence)}-${String(Date.now())}`
    const timeoutMs = options.timeoutMs ?? 120_000
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new Error(`Supervisor request ${type} timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.#pending.set(requestId, { resolve, reject, timer, ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }) })
      if (this.#exitResult !== undefined) {
        clearTimeout(timer)
        this.#pending.delete(requestId)
        reject(new Error(`Supervisor already exited: ${JSON.stringify(this.#exitResult)}`))
        return
      }
      try {
        this.#child.send({ type, requestId, ...payload }, error => {
          if (error !== undefined && error !== null) {
            const pending = this.#pending.get(requestId)
            if (pending === undefined) return
            clearTimeout(pending.timer)
            this.#pending.delete(requestId)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(requestId)
        reject(asError(error))
      }
    })
  }

  async waitExit(timeoutMs = 30_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.#exitResult !== undefined) return this.#exitResult
    return await Promise.race([
      this.#exitPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Supervisor did not exit within ${String(timeoutMs)}ms`)), timeoutMs)
      }),
    ])
  }

  async close(): Promise<void> {
    if (this.#exitResult !== undefined) return
    try {
      this.#child.disconnect()
    } catch {
      // A disconnected child may already be collecting its owned resources.
    }
    try {
      await this.waitExit(15_000)
    } catch {
      try { this.#child.kill('SIGKILL') } catch { /* already gone */ }
      await this.waitExit(3_000).catch(() => undefined)
    }
  }
}

class Scene implements SplitS0Scene {
  readonly workDir: string
  readonly installation: SplitInstallation
  readonly candidate: CandidateFacts
  readonly #c1Work: C1WorkFixture
  readonly #supervisor: SupervisorClient
  readonly #hosts: HostHandle[] = []
  readonly #clients: ClientHandle[] = []
  #clientSequence = 0

  constructor(facts: SceneFacts, supervisor: SupervisorClient) {
    this.workDir = facts.workDir
    this.installation = facts.installation
    this.candidate = facts.candidate
    this.#c1Work = facts.c1Work
    this.#supervisor = supervisor
    mkdirSync(join(this.workDir, 'trace'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.workDir, 'artifacts'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.workDir, 'clients'), { recursive: true, mode: 0o700 })
  }

  get supervisorPids(): { worker: number; supervisor: number | undefined } {
    return this.#supervisor.pids
  }

  async startHost(scenario: string, extraEnv: Record<string, string> = {}): Promise<HostHandle> {
    const payload = await this.#supervisor.request('START_HOST', { scenario, extraEnv }, {
      timeoutMs: 180_000,
      onProgress: message => {
        if (message.event === 'HOST_SPAWNED' && process.env.S0_PROBE_WORKER_KILL_POINT === 'host-spawned-before-ack') {
          process.kill(process.pid, 'SIGKILL')
        }
      },
    })
    const host: HostHandle = {
      hostId: String(payload.hostId),
      ready: payload.ready,
      workRoot: String(payload.workRoot),
      exited: false,
    }
    this.#hosts.push(host)
    return host
  }

  async shutdownHost(host: HostHandle): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (host.exited) {
      const result = host.exitResult
      assert(result !== undefined && result.code === 0 && result.signal === null,
        `Host ${host.hostId} had already exited abnormally: ${JSON.stringify(result)}`)
      return result
    }
    const result = await this.#supervisor.request('STOP_HOST', { hostId: host.hostId }, { timeoutMs: 60_000 })
    host.exited = true
    host.exitResult = { code: result.code ?? null, signal: result.signal ?? null }
    assert(host.exitResult.code === 0 && host.exitResult.signal === null,
      `Host ${host.hostId} shutdown was ${JSON.stringify(host.exitResult)}`)
    return host.exitResult
  }

  async hostStatus(host: HostHandle): Promise<Record<string, any>> {
    assert(!host.exited, `Host ${host.hostId} is not alive`)
    return await this.#supervisor.request('HOST_STATUS', {
      hostId: host.hostId,
      hostRequestId: `status-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    }, { timeoutMs: 30_000 })
  }

  async startClient(label: string, options: { sessionId?: string } = {}): Promise<ClientHandle> {
    const sequence = ++this.#clientSequence
    const scratch = join(this.workDir, 'clients', `${label}-${String(sequence)}`)
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const terminal = TuiTest.ephemeral('split-s0', {
      backend: 'xtermjs',
      trace: { mode: 'on-failure', directory: join(this.workDir, 'trace') },
      artifacts: { dir: join(this.workDir, 'artifacts'), onFailure: 'text' },
    })
    const env: Record<string, string> = {
      ...this.installation.base.env,
      SPLIT_PROCESS_DSH_ANCHOR: this.installation.anchor,
      SPLIT_PROCESS_PROFILE: 'pi-tui',
      SPLIT_PROCESS_CLIENT_MODE: 'surface',
      SPLIT_PROCESS_SCRATCH: scratch,
      ...(options.sessionId === undefined ? {} : { SPLIT_PROCESS_CLIENT_SESSION: options.sessionId }),
    }
    const opened = await terminal.run(process.execPath, [this.installation.entries.client], {
      cwd: this.installation.profileDir,
      cols: 100,
      rows: 30,
      waitReady: false,
      env,
    }).catch(async error => {
      await terminal.closeQuiet()
      throw error
    })
    const client: ClientHandle = {
      label,
      terminal,
      closed: false,
      submit: async (text: string) => { await terminal.submit(text) },
      press: async (...keys: string[]) => { await terminal.press(...keys) },
      type: async (text: string) => { await terminal.type(text) },
      text: async (full = false) => await terminal.text({ full }),
      waitForText: async (text: string, waitLabel: string, timeoutMs = 120_000) => {
        await this.#waitForClientText(terminal, text, waitLabel, timeoutMs, true)
      },
      waitForVisibleText: async (text: string, waitLabel: string, timeoutMs = 120_000) => {
        await this.#waitForClientText(terminal, text, waitLabel, timeoutMs, false)
      },
      waitForVisibleTextGone: async (text: string, waitLabel: string, timeoutMs = 120_000) => {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
          const frame = await terminal.text()
          if (!frame.includes(text)) return
          await sleep(50)
        }
        throw new Error(`${waitLabel}: text ${JSON.stringify(text)} stayed visible for ${String(timeoutMs)}ms`)
      },
      isAlive: async () => {
        const state = await terminal.state().catch(() => undefined)
        return state !== undefined && state.exited === null
      },
    }
    this.#clients.push(client)
    try {
      await this.#supervisor.request('REPORT', {
        event: 'client-started',
        detail: { label, session: terminal.session, shellPid: opened.shell_pid ?? null },
      }, { timeoutMs: 10_000 })
      await this.#waitForPaintedFrame(terminal, `${label} painted its first frame`, 30_000)
    } catch (error) {
      await terminal.closeQuiet()
      throw error
    }
    return client
  }

  async exitClient(client: ClientHandle): Promise<void> {
    if (client.closed) return
    const state = await client.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      assert(state.exited === 0, `${client.label} was already exited with code ${String(state.exited)}`)
      client.closed = true
      await client.terminal.closeQuiet()
      return
    }
    await client.terminal.submit('/exit')
    const deadline = Date.now() + 60_000
    let choiceTaken = false
    while (Date.now() < deadline) {
      const current = await client.terminal.state().catch(() => undefined)
      if (current !== undefined && current.exited !== null) {
        assert(current.exited === 0, `${client.label} exit code was ${String(current.exited)}`)
        client.closed = true
        await client.terminal.closeQuiet()
        assert(!(await openTuiSessions()).includes(client.terminal.session),
          `${client.label} left its native TUI session open after exit`)
        return
      }
      if (!choiceTaken) {
        const frame = await client.terminal.text().catch(() => '')
        if (frame.includes('Disconnect from dsh-pi-tui')) {
          await this.#waitForClientText(client.terminal, 'Keep working and disconnect',
            `${client.label} busy exit choice`, 15_000, false)
          await client.terminal.press('Enter')
          choiceTaken = true
        }
      }
      await sleep(100)
    }
    throw new Error(`${client.label} did not exit after /exit; last frame: ${JSON.stringify((await client.terminal.text().catch(() => '')).slice(-2000))}`)
  }

  async sessionIds(): Promise<string[]> {
    return listSessionIds(this.installation.dshHome)
  }

  async waitForNewSessionId(before: ReadonlySet<string>, label: string, timeoutMs = 60_000): Promise<string> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const added = listSessionIds(this.installation.dshHome).filter(id => !before.has(id))
      if (added.length === 1) return added[0]!
      if (added.length > 1) {
        throw new Error(`${label}: ${String(added.length)} new Host Sessions appeared: ${JSON.stringify(added)}`)
      }
      await sleep(50)
    }
    throw new Error(`${label}: no new Host Session appeared within ${String(timeoutMs)}ms`)
  }

  async sessionEvents(sessionId: string): Promise<SessionEvent[] | undefined> {
    return sessionsModule.hostSessionEvents(this.installation.dshHome, sessionId)
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

  async waitForC1WorkEvent(
    workRoot: string,
    predicate: (event: Record<string, any>) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<Record<string, any>> {
    return await fixturesModule.waitForC1WorkEvent(workRoot, predicate, label, timeoutMs)
  }

  async report(event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.#supervisor.request('REPORT', { event, detail }, { timeoutMs: 10_000 })
  }

  async dispose(): Promise<void> {
    const errors: Error[] = []
    for (const client of [...this.#clients].reverse()) {
      try {
        const state = await client.terminal.state().catch(() => undefined)
        if (state !== undefined && state.exited !== null && state.exited !== 0) {
          errors.push(new Error(`${client.label} exited with code ${String(state.exited)}`))
        }
        if (client.closed) continue
        if (state !== undefined && state.exited === null) {
          await client.terminal.submit('/exit').catch(() => undefined)
          await sleep(500)
          const frame = await client.terminal.text().catch(() => '')
          if (frame.includes('Disconnect from dsh-pi-tui') && frame.includes('Keep working and disconnect')) {
            await client.terminal.press('Enter').catch(() => undefined)
          }
          await sleep(500)
        }
      } catch (error) {
        errors.push(new Error(`${client.label} graceful exit failed: ${asError(error).message}`))
      }
      try {
        await client.terminal.closeQuiet()
        client.closed = true
        const state = await client.terminal.state().catch(() => undefined)
        if (state !== undefined && state.exited === null) {
          errors.push(new Error(`${client.label} native close left the session alive`))
        }
      } catch (error) {
        errors.push(new Error(`${client.label} native close failed: ${asError(error).message}`))
      }
    }
    for (const host of [...this.#hosts].reverse()) {
      if (host.exited) {
        if (host.exitResult !== undefined && (host.exitResult.code !== 0 || host.exitResult.signal !== null)) {
          errors.push(new Error(`Host ${host.hostId} exited unexpectedly: ${JSON.stringify(host.exitResult)}`))
        }
        continue
      }
      try {
        await this.shutdownHost(host)
      } catch (error) {
        errors.push(asError(error))
      }
    }
    const leftoverSessions = (await openTuiSessions()).filter((session: string) => session.startsWith('split-s0-'))
    if (leftoverSessions.length > 0) {
      errors.push(new Error(`S0 left native TUI sessions open: ${JSON.stringify(leftoverSessions)}`))
    }
    const clientsClosed = errors.length === 0
    try {
      await this.#supervisor.request('FINALIZE', { clientsClosed }, { timeoutMs: 120_000 })
    } catch (error) {
      errors.push(new Error(`Supervisor FINALIZE failed: ${asError(error).message}`))
    }
    try {
      const exit = await this.#supervisor.waitExit(30_000)
      if (exit.code !== 0 || exit.signal !== null) {
        errors.push(new Error(`Supervisor exited abnormally: ${JSON.stringify(exit)}`))
      }
    } catch (error) {
      errors.push(asError(error))
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `S0 scene cleanup failed with ${String(errors.length)} error(s); evidence root: ${this.workDir}`)
    }
  }

  async #waitForPaintedFrame(terminal: TuiTest, label: string, timeoutMs: number): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const frame = await terminal.text().catch(() => '')
      if (frame.trim() !== '') return
      await sleep(50)
    }
    throw new Error(`${label}: the terminal painted no visible frame within ${String(timeoutMs)}ms`)
  }

  async #waitForClientText(
    terminal: TuiTest,
    text: string,
    label: string,
    timeoutMs: number,
    full: boolean,
  ): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const frame = await terminal.text({ full }).catch(() => '')
      if (frame.includes(text)) return
      await sleep(50)
    }
    const lastFrame = await terminal.text({ full }).catch(() => '')
    throw new Error(`${label}: the terminal never showed ${JSON.stringify(text)} within ${String(timeoutMs)}ms; last frame=${JSON.stringify(lastFrame.slice(-2000))}`)
  }
}

async function createScene(): Promise<Scene> {
  const tmpBase = requireAbsoluteDirectory('S0_TMP_BASE')
  const tarball = requireCandidateTarball()
  const supervisor = new SupervisorClient()
  try {
    const facts = await supervisor.request('BOOTSTRAP', { tarball, tmpBase }, { timeoutMs: 600_000 }) as SceneFacts
    return new Scene(facts, supervisor)
  } catch (error) {
    await supervisor.close()
    throw error
  }
}

export const test = base.extend<{ candidateScene: SplitS0Scene }>({
  candidateScene: async ({}, use) => {
    const scene = await createScene()
    let testError: unknown
    try {
      await use(scene)
    } catch (error) {
      testError = error
      throw error
    } finally {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        if (testError !== undefined) {
          throw new AggregateError([testError, cleanupError],
            'the S0 test failed and its scene cleanup also failed')
        }
        throw cleanupError
      }
    }
  },
})

export { messageText }
