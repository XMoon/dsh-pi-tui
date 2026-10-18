/**
 * S2/PR-B §B1 / S2-16 — a REAL unreadable stored Session on the REAL Session
 * Picker path (L6, no authority stand-in).
 *
 * SOURCE → DECISION → SINK: an on-disk JSONL artifact written in a NEWER format
 * version is opened by the official JSONL persistence through the real agent
 * loop; the refusal travels to the real `/sessions` picker on a real `TuiApp`
 * and the unreadable log is never mounted.
 *
 * FIXTURE (real): the official agent-loop testkit, the official JSONL
 * persistence + query engine, a real Session artifact tree, the real runner and
 * a real `VirtualTerminal`. STAND-INS: the peripheral registries the runner
 * injects (command registry, loader, default model) only.
 *
 * @module @xmoon76/dsh-pi-tui/session-picker-real-refusal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import { visibleWidth } from '@xmoon76/pi-tui'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { apply as applyRunner, Config as TuiConfigSchema } from '../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import {
  disposeContext,
  installVirtualProcessTerminal,
  makeHarness,
  settle,
} from './support/runner-harness.ts'
import { installProbe } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const CURRENT = SessionId('session-real-current')
/** A current-format artifact whose BODY is unreadable: its header lists (so the
 *  picker shows the row) while opening it must be refused by the reader. */
const CORRUPT = SessionId('session-real-corrupt')
/** A newer-format artifact: the reader cannot even list it as a Session. */
const NEWER = SessionId('session-real-newer')

/** The backend roots each Session under exactly one project directory. */
function sessionDirOf(root: string, sessionId: string): string {
  for (const project of readdirSync(root)) {
    const candidate = join(root, project, sessionId)
    if (readdirSync(join(root, project)).includes(sessionId)) return candidate
  }
  throw new Error(`no session directory for ${sessionId} under ${root}`)
}

/** Write one generation artifact exactly like the backend does (zstd frames). */
function placeArtifact(path: string, plainJsonl: string): void {
  const newline = plainJsonl.indexOf('\n')
  const head = zstdCompressSync(Buffer.from(plainJsonl.slice(0, newline + 1)))
  const rest = zstdCompressSync(Buffer.from(plainJsonl.slice(newline + 1)))
  writeFileSync(path, Buffer.concat([head, rest]))
}

test('the REAL Session Picker refuses an unreadable newer-format artifact', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s2b-real-picker-')
  const home = life.tempDir('dsh-s2b-real-picker-home-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(120, 40)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)

  // ── Boot 1: write the real artifact tree through the official persistence ──
  const first = new Context()
  await mountAgentLoopTestDependencies(first, { workingDirectory: true })
  const firstPersistence = await first.plugin(JsonlSessionPersistence, { root })
  void firstPersistence
  const persistence = first.get('sessionPersistence') as unknown as {
    create(init: {
      readonly id: ReturnType<typeof SessionId>
      readonly createdAt: number
      readonly version: number
      readonly cwd: string
      readonly isSeeded: boolean
      readonly delegationDepth: number
    }): Promise<{ flush(): Promise<void>; close(): Promise<void> }>
  }
  const current = await persistence.create({
    id: CURRENT,
    createdAt: 1_700_000_000_000,
    version: SESSION_FORMAT_VERSION,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0,
  })
  await current.flush()
  await current.close()
  const corrupt = await persistence.create({
    id: CORRUPT,
    createdAt: 1_700_000_001_000,
    version: SESSION_FORMAT_VERSION,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0,
  })
  await corrupt.flush()
  await corrupt.close()
  const newer = await persistence.create({
    id: NEWER,
    createdAt: 1_700_000_002_000,
    version: SESSION_FORMAT_VERSION,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0,
  })
  await newer.flush()
  await newer.close()
  await first.fiber.dispose()

  const replaceArtifact = (id: string, plainJsonl: string, version: number): void => {
    const dir = sessionDirOf(root, id)
    for (const name of readdirSync(dir)) {
      if (name.startsWith('session.') && name !== 'session.lock') rmSync(join(dir, name), { force: true })
    }
    placeArtifact(join(dir, `session.v${version}.jsonl.zstd`), plainJsonl)
  }
  // A CURRENT-format artifact with an unreadable body: its header still lists,
  // so the picker shows the row and the OPEN is what refuses.
  replaceArtifact(String(CORRUPT), `${JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: String(CORRUPT),
    createdAt: 1_700_000_001_000, cwd: '/work', delegationDepth: 0,
  })}\n${JSON.stringify({ type: 'totally/unknown-event', seq: 1, time: 1, data: {} })}\n`, SESSION_FORMAT_VERSION)
  // A NEWER-format artifact: the reader cannot present it as a Session at all.
  const futureVersion = SESSION_FORMAT_VERSION + 1
  replaceArtifact(String(NEWER), `${JSON.stringify({
    type: 'session', version: futureVersion, id: String(NEWER),
    createdAt: 1_700_000_002_000, cwd: '/work', delegationDepth: 0,
  })}\n${JSON.stringify({ type: 'turn/start', seq: 1, time: 1, data: { turn: 0 } })}\n`, futureVersion)

  // ── Boot 2: the real stack + the real runner, over the SAME artifact tree ──
  const context = new Context()
  life.defer(() => disposeContext(context))
  await mountAgentLoopTestDependencies(context, { workingDirectory: true })
  await context.plugin(JsonlSessionPersistence, { root })
  await context.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  context.provide('appExit', () => {})
  context.provide(TUI_STARTUP_SERVICE, { sessionId: String(CURRENT), shippedPresetRoot: home } as never)
  // The PERIPHERAL registries (command registry + default model) are stand-ins:
  // the authority under test (persistence, agent loop, session query, runner) is
  // real. The registry serves the runner's own registrations to the real
  // submission path; `execute` never touches a Session (this fixture owns none
  // for model-invoked commands).
  // The OFFICIAL command runtime: the session-scoped catalog `/sessions` is
  // resolved against must be the real one, not a registry double.
  await context.plugin(CommandRuntime)
  const peripherals = makeHarness(home, [], { provider: 'p', model: 'm' })
  context.provide('loader', { await: async () => {} } as never)
  // The production AgentLoop row itself (the agent factory `agents.resume`
  // needs); the testkit mounts it after its prerequisites are in place.
  await mountAgentLoopTestHarness(context)
  context.provide('agentDefaultModel', peripherals.defaultModel as never)
  const fiber = await context.plugin(pluginCtx => applyRunner(pluginCtx, TuiConfigSchema({ sessionId: String(CURRENT) } as never)))
  life.defer(() => fiber.dispose())
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  // The REAL agent loop resumes the stored Session: wait (bounded) for the
  // runner's first painted frame instead of assuming a fixed number of ticks.
  for (let attempt = 0; attempt < 80 && !view().includes('dsh-pi-tui'); attempt += 1) {
    await settle()
    await new Promise(resolve => setTimeout(resolve, 25))
    await vt.waitForRender()
  }
  assert.match(view(), /dsh-pi-tui/u, `the real runner painted:\n${view()}`)

  // ── The real picker: an unreadable artifact is NEVER presented ──
  vt.sendInput('/sessions')
  await settle()
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  const listed = view()
  for (const line of vt.getViewport()) {
    assert.ok(visibleWidth(line) <= 120, `no frame row overflows: ${JSON.stringify(line)}`)
  }
  assert.match(listed, /1\/1/u,
    `only the readable Session is presented:\n${listed}`)
  assert.doesNotMatch(listed, /real-newer|real-corrupt/u,
    'an unreadable artifact is never listed (and never shown as an empty Session)')

  // ── The same real stack, opened by id: the OFFICIAL refusal ──
  const persistence2 = context.get('sessionPersistence') as unknown as {
    open(id: unknown, mode: string): Promise<unknown>
  }
  const corruptRefusal = await persistence2.open(CORRUPT, 'read').then(() => undefined, (error: unknown) => error as Error)
  assert.ok(corruptRefusal !== undefined, 'opening the unreadable current-format artifact must fail')
  const newerRefusal = await persistence2.open(NEWER, 'read').then(() => undefined, (error: unknown) => error as Error)
  assert.ok(newerRefusal !== undefined, 'opening the newer-format artifact must fail')
  assert.match(newerRefusal.message, new RegExp(`v${SESSION_FORMAT_VERSION + 1}`),
    `the refusal names the stored version: ${newerRefusal.message}`)

  // The surface keeps the readable Session: nothing was replaced by a refused log.
  assert.match(view(), /session-real-current/u, 'the refused artifacts never replace the current Session')
  assert.doesNotMatch(view(), /no messages yet|type a message to start a session/u,
    'a refused format is never presented as an empty Session')
})
