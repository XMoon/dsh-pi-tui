import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TestContext } from 'node:test'

import { TuiTest, sessions as openTuiSessions } from '@microsoft/tui-test'
import { test as base } from 'vitest'

import { testLifecycle } from './temp-lifecycle.ts'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(SUPPORT_DIR, '..', '..'))

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
}

interface C1WorkFixture {
  patchPath: string
}

interface SessionEvent {
  type?: string
  data?: Record<string, any>
}

interface SplitSmokeProfileModule {
  inspectSplitCandidate(explicitPath: string): CandidateFacts
  createSplitSmokeProfile(options: { tarball: string; targetDshVersion: string; workDir: string }): SplitInstallation
}

interface SplitSmokeFixturesModule {
  writeC1WorkFixture(profileDir: string, workDir: string): C1WorkFixture
  readC1WorkEvents(workRoot: string): Record<string, any>[]
  waitForC1WorkEvent(
    workRoot: string,
    predicate: (event: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
}

interface SplitSmokeSessionsModule {
  hostSessionEvents(dshHome: string, sessionId: string): SessionEvent[] | undefined
  hostSessionHeader(dshHome: string, sessionId: string): SessionEvent | undefined
  hostUserTexts(events: SessionEvent[]): string[]
  waitForHostSessionHeader(dshHome: string, sessionId: string, label: string, timeoutMs?: number): Promise<SessionEvent>
  waitForHostSessionEvent(
    dshHome: string,
    sessionId: string,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
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

const profileModule = await loadModule<SplitSmokeProfileModule>('scripts/lib/split-smoke-profile.mjs')
const fixturesModule = await loadModule<SplitSmokeFixturesModule>('scripts/lib/split-smoke-fixtures.mjs')
const sessionsModule = await loadModule<SplitSmokeSessionsModule>('scripts/lib/split-smoke-sessions.mjs')

/** One live Host process owned by this test scene. */
interface HostHandle {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Record<string, any>
  readonly workRoot: string
  readonly records: Record<string, any>[]
  readonly stderr: { value: string }
  exited: boolean
  exitResult?: { code: number | null; signal: NodeJS.Signals | null }
  shutdownRequested?: boolean
}

/** One live real-PTY Client owned by this test scene. */
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
  c1WorkEvents(workRoot: string): Promise<Record<string, any>[]>
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
  const real = realpathSync(raw)
  const stats = statSync(real)
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
  const real = realpathSync(raw)
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

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      reject(new Error(`child ${String(child.pid)} did not exit within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('close', onClose)
  })
}

class Scene implements SplitS0Scene {
  readonly workDir: string
  readonly installation: SplitInstallation
  readonly candidate: CandidateFacts
  readonly #resourcePath: string
  readonly #resources: {
    workDir: string
    startedAt: string
    hosts: Record<string, any>[]
    clients: Record<string, any>[]
  }
  readonly #c1WorkFixture: C1WorkFixture
  readonly #hosts: HostHandle[] = []
  readonly #clients: ClientHandle[] = []
  #clientSequence = 0

  constructor(
    tmpBase: string,
    workDir: string,
    installation: SplitInstallation,
    candidate: CandidateFacts,
    c1WorkFixture: C1WorkFixture,
  ) {
    this.workDir = workDir
    this.installation = installation
    this.candidate = candidate
    this.#c1WorkFixture = c1WorkFixture
    const evidenceRoot = join(tmpBase, 's0-resources')
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
    this.#resourcePath = join(evidenceRoot, `${workDir.split(sep).pop() ?? 'scene'}.json`)
    this.#resources = { workDir, startedAt: new Date().toISOString(), hosts: [], clients: [] }
    this.#writeResources()
    mkdirSync(join(workDir, 'trace'), { recursive: true, mode: 0o700 })
    mkdirSync(join(workDir, 'artifacts'), { recursive: true, mode: 0o700 })
    mkdirSync(join(workDir, 'clients'), { recursive: true, mode: 0o700 })
  }

  async startHost(scenario: string, extraEnv: Record<string, string> = {}): Promise<HostHandle> {
    const workRoot = join(this.workDir, `c1-${scenario}`)
    mkdirSync(workRoot, { recursive: true, mode: 0o700 })
    chmodSync(workRoot, 0o700)
    const env: Record<string, string> = {
      ...this.installation.base.env,
      SPLIT_PROCESS_EXTRA_PATCH: this.#c1WorkFixture.patchPath,
      C1_SCENARIO: scenario,
      C1_WORK_ROOT: workRoot,
      DSH_PI_TUI_ENTRY_RECORDS: '1',
      SPLIT_PROCESS_DSH_ANCHOR: this.installation.anchor,
      SPLIT_PROCESS_PROFILE: 'pi-tui',
      SPLIT_PROCESS_SCRATCH: join(this.workDir, `host-scratch-${scenario}`),
      ...extraEnv,
    }
    mkdirSync(env.SPLIT_PROCESS_SCRATCH, { recursive: true, mode: 0o700 })
    const child = spawn(process.execPath, [this.installation.entries.host], {
      cwd: this.installation.base.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    const records: Record<string, any>[] = []
    const stderr = { value: '' }
    createInterface({ input: child.stdout }).on('line', line => {
      const trimmed = line.trim()
      if (trimmed === '') return
      try {
        records.push(JSON.parse(trimmed) as Record<string, any>)
      } catch {
        stderr.value += `${trimmed}\n`
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr.value += chunk })
    const host: HostHandle = {
      child,
      ready: {},
      workRoot,
      records,
      stderr,
      exited: false,
    }
    const exitPromise = waitForChildExit(child, 24 * 60 * 60_000).then(result => {
      host.exited = true
      host.exitResult = result
      return result
    }).catch(() => undefined)
    void exitPromise
    const ready = await this.#waitForHostRecord(host, record => record.m4a0 === 'ready' || record.m4a0 === 'failure',
      `${scenario} Host ready`, 180_000)
    if (ready.m4a0 === 'failure') {
      throw new Error(`${scenario} Host boot failed: ${JSON.stringify({
        code: ready.code,
        error: ready.error,
        phase: ready.phase,
      })} stderr=${JSON.stringify(stderr.value.slice(-2000))}`)
    }
    ;(host as { ready: Record<string, any> }).ready = ready
    this.#hosts.push(host)
    this.#resources.hosts.push({
      scenario,
      businessPid: ready.pid ?? null,
      childPid: child.pid ?? null,
      workRoot,
      startedAt: new Date().toISOString(),
    })
    this.#writeResources()
    return host
  }

  async shutdownHost(host: HostHandle): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (host.shutdownRequested === true && host.exitResult !== undefined) return host.exitResult
    host.shutdownRequested = true
    if (!host.exited) {
      host.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
      try {
        const result = await waitForChildExit(host.child, 30_000)
        host.exited = true
        host.exitResult = result
      } catch (error) {
        this.#killOwnedHost(host)
        throw new Error(`Host ${String(host.child.pid)} did not settle its official shutdown: ${asError(error).message}`)
      }
    }
    const result = host.exitResult ?? { code: host.child.exitCode, signal: host.child.signalCode }
    this.#writeResources()
    assert(result.code === 0 && result.signal === null,
      `Host ${String(host.child.pid)} shutdown was ${JSON.stringify(result)}`)
    return result
  }

  async hostStatus(host: HostHandle): Promise<Record<string, any>> {
    assert(!host.exited, `Host ${String(host.child.pid)} is not alive`)
    const requestId = `s0-status-${String(Date.now())}-${String(Math.random()).slice(2)}`
    host.child.stdin.write(`${JSON.stringify({ op: 'status', requestId })}\n`)
    return await this.#waitForHostRecord(host,
      record => record.m4a0 === 'status' && record.requestId === requestId,
      `Host status ${requestId}`, 30_000)
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
    })
    await this.#waitForPaintedFrame(terminal, `${label} painted its first frame`, 30_000)
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
          const frame = await terminal.text().catch(() => '')
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
    this.#resources.clients.push({
      label,
      session: terminal.session,
      shellPid: opened.shell_pid ?? null,
      workDir: scratch,
      startedAt: new Date().toISOString(),
    })
    this.#writeResources()
    return client
  }

  async exitClient(client: ClientHandle): Promise<void> {
    if (client.closed) return
    const state = await client.terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
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
        this.#writeResources()
        assert(!(await openTuiSessions()).includes(client.terminal.session),
          `${client.label} left its native TUI session open after exit`)
        return
      }
      if (!choiceTaken) {
        const frame = await client.terminal.text().catch(() => '')
        if (frame.includes('Disconnect from dsh-pi-tui')) {
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

  async c1WorkEvents(workRoot: string): Promise<Record<string, any>[]> {
    return fixturesModule.readC1WorkEvents(workRoot)
  }

  async dispose(): Promise<void> {
    const errors: Error[] = []
    this.#writeResources()
    for (const client of [...this.#clients].reverse()) {
      if (client.closed) continue
      try {
        const state = await client.terminal.state().catch(() => undefined)
        if (state !== undefined && state.exited === null) {
          await client.terminal.submit('/exit').catch(() => undefined)
          await sleep(1_000)
          await client.terminal.press('Enter').catch(() => undefined)
          await sleep(1_000)
        }
      } catch (error) {
        errors.push(new Error(`${client.label} graceful exit failed: ${asError(error).message}`))
      }
      try {
        await client.terminal.closeQuiet()
        client.closed = true
      } catch (error) {
        errors.push(new Error(`${client.label} native close failed: ${asError(error).message}`))
      }
    }
    for (const host of [...this.#hosts].reverse()) {
      if (host.exited) continue
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
    if (errors.length === 0) {
      rmSync(this.workDir, { recursive: true, force: true })
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `S0 scene cleanup failed with ${String(errors.length)} error(s); evidence root: ${this.workDir}`)
    }
  }

  async #waitForHostRecord(
    host: HostHandle,
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs: number,
  ): Promise<Record<string, any>> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const existing = host.records.find(predicate)
      if (existing !== undefined) return existing
      if (host.exited) {
        throw new Error(`${label}: Host exited before the record; stderr=${JSON.stringify(host.stderr.value.slice(-2000))}`)
      }
      await sleep(20)
    }
    throw new Error(`${label}: timed out after ${String(timeoutMs)}ms; stderr=${JSON.stringify(host.stderr.value.slice(-2000))}`)
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

  #killOwnedHost(host: HostHandle): void {
    try {
      process.kill(-host.child.pid!, 'SIGTERM')
    } catch {
      try { host.child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  #writeResources(): void {
    this.#resources.hosts = this.#resources.hosts.map(host => ({
      ...host,
      exited: this.#hosts.find(candidate => candidate.child.pid === host.childPid)?.exited ?? false,
    }))
    this.#resources.clients = this.#resources.clients.map(client => ({
      ...client,
      exited: this.#clients.find(candidate => candidate.label === client.label
        && candidate.terminal.session === client.session)?.closed ?? false,
    }))
    const payload = JSON.stringify({ ...this.#resources, updatedAt: new Date().toISOString() }, null, 2) + '\n'
    writeFileSync(this.#resourcePath, payload, { mode: 0o600 })
  }
}

async function createScene(): Promise<Scene> {
  const tmpBase = requireAbsoluteDirectory('S0_TMP_BASE')
  const tarball = requireCandidateTarball()
  // The repository temp-hygiene gate requires every test-owned temp root to
  // come from the ONE lifecycle helper; this fixture owns its own deletion, so
  // the helper is used only as the permitted creation seam.
  const tempLife = testLifecycle({ after: () => {} } as unknown as TestContext)
  const workDir = tempLife.tempDir('scene-', tmpBase)
  chmodSync(workDir, 0o700)
  try {
    const candidate = profileModule.inspectSplitCandidate(tarball)
    const installation = profileModule.createSplitSmokeProfile({
      tarball: candidate.tarball,
      targetDshVersion: candidate.targetDshVersion,
      workDir,
    })
    const c1WorkFixture = fixturesModule.writeC1WorkFixture(installation.profileDir, workDir)
    return new Scene(tmpBase, workDir, installation, candidate, c1WorkFixture)
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true })
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
