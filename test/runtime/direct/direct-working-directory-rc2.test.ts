/**
 * S2/PR-B §B2 — the Direct EFFECTIVE Session working directory (L5).
 *
 * SOURCE → DECISION → SINK: the OFFICIAL `working_directory` tool commits a
 * durable `working-directory/change` through `@deepseek-ai/dsh-working-directory`;
 * the Session header keeps the ORIGINAL project; every TUI Direct read that
 * executes or scopes an operation in the Session's directory follows the
 * committed value (session status cwd → footer/OSC7/history, Host `@`
 * completion scope, skill catalog scope), and a vanished directory recovers
 * through the official `ensure()`.
 *
 * FIXTURE (real): the official Agent-loop prerequisite services (the testkit's
 * own `workingDirectory` switch mounts the real directory owner + local
 * filesystem), a real JSONL Session log, a real Agent created with
 * `meta.cwd` = the original project, the real `working_directory` tool row,
 * the real skill registry. STAND-INS: the skill provider source (a fixture
 * provider on the REAL registry — the assertion is the scope the real service
 * hands it). ABSENT: network, a real model request (no prompt is submitted),
 * the user's real DSH_HOME.
 *
 * @module @xmoon76/dsh-pi-tui/direct-working-directory-rc2.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionSeq, buildForkSeed, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as toolWorkingDirectory from '@deepseek-ai/dsh-tool-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DirectSessionReader } from '../../../src/runtime/direct/session-direct.ts'
import { DirectHostFilePort } from '../../../src/runtime/direct/host-file-direct.ts'
import { readSurfaceCatalog, type SurfaceCatalogContext } from '../../../src/runtime/direct/surface-catalog.ts'
import {
  effectiveAgentCwd,
  projectedWorkingDirectory,
  type WorkingDirectoryServiceLike,
} from '../../../src/runtime/direct/working-directory-direct.ts'
import { testLifecycle, type TestLifecycle } from '../../support/temp-lifecycle.ts'

const SESSION = 'session-direct-wd'
const signal = new AbortController().signal
let callCounter = 0

interface Fixture {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly workRoot: string
  /** Every scope the REAL skill registry asked its provider for. */
  readonly skillScopes: Array<{ readonly cwd?: string }>
}

/** Mount the real directory-aware Agent composition. */
async function boot(life: TestLifecycle): Promise<Fixture> {
  const workRoot = life.tempDir('dsh-s2b-wd-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(toolWorkingDirectory)
  await ctx.plugin(SkillRegistry, {})
  const skillScopes: Array<{ readonly cwd?: string }> = []
  const registry = ctx.get('skills') as unknown as { registerProvider(provider: unknown): unknown }
  registry.registerProvider((_control: unknown) => ({
    name: 's2b-directory-fixture',
    list: async (options: { readonly cwd?: string }) => {
      skillScopes.push({ ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
      return [{
        name: 'directory-skill',
        description: 'one skill',
        rank: 10,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 's2b-directory-fixture',
        locator: { name: 'directory-skill' },
      }]
    },
    snapshot: async (options: { readonly cwd?: string }) => {
      skillScopes.push({ ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
      return { skills: [], complete: true }
    },
  }))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = workRoot
  life.defer(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })
  return { ctx, harness, workRoot, skillScopes }
}

/** Execute one tool through the real ToolRuntime pipeline. */
function callTool(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`s2b-wd-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

/** The tool result's text content. */
function text(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.text ?? '').join('')
}

/** The TUI's Direct session-status read over the SAME real Session. */
function readerOf(fixture: Fixture, agent: Agent): DirectSessionReader {
  const id = String(agent.session.id)
  return new DirectSessionReader(
    fixture.ctx as never,
    {
      sessionOf: candidate => String(candidate) === id ? agent.session as Session : undefined,
      agentOf: candidate => String(candidate) === id ? agent : undefined,
    },
    { durableProjectionForSession: () => ({ next: null, lastUsed: null }) },
  )
}

test('the official tool commits the change; status/header/scope follow the effective directory', async t => {
  const life = testLifecycle(t)
  const fixture = await boot(life)
  const { ctx, workRoot } = fixture
  const originalProject = join(workRoot, 'project')
  // A distinctive child directory exists ONLY under the committed directory:
  // a scope resolved against the original project cannot produce it.
  mkdirSync(join(originalProject, 'moved', 'deep'), { recursive: true })
  writeFileSync(join(originalProject, 'moved', 'deep', 'inner.txt'), 'inner')
  const agent = await fixture.harness.create(SessionId(SESSION), {}, { cwd: originalProject })
  assert.equal(agent.session.header.cwd, originalProject, 'the header starts at the original project')

  const result = await callTool(ctx, 'working_directory', { cd: 'moved' }, agent)
  const committed = join(originalProject, 'moved')
  assert.equal(text(result), committed, 'the tool reports the canonical committed directory')

  // DURABLE EVENT: the change is a Session event, not a TUI-side value.
  const changes = (agent.session.snapshotEvents() as unknown as readonly {
    readonly type: string
    readonly data?: { readonly cwd?: unknown }
  }[])
    .filter(event => event.type === 'working-directory/change')
    .map(event => event.data?.cwd)
  assert.deepEqual(changes, [committed], 'exactly one durable working-directory/change was committed')
  assert.equal(agent.session.header.cwd, originalProject, 'the header keeps the ORIGINAL project')

  // OFFICIAL PROJECTION: the same value the official fs/shell tools read.
  const projections = ctx.get('sessionProjections') as { stateOf(session: unknown, key: string): unknown }
  assert.equal(projections.stateOf(agent.session, 'workingDirectory'), committed)

  // SINK 1 — the TUI session status the footer/welcome/OSC7/history read.
  assert.equal(readerOf(fixture, agent).sessionStatus(SESSION)?.cwd, committed)

  // SINK 2 — the Host `@` completion scope of an explicit path query: the
  // relative scope resolves against the COMMITTED directory.
  const port = new DirectHostFilePort(
    candidate => String(candidate) === SESSION ? agent : undefined,
    null,
    ctx as never,
  )
  const completion = await port.listReferences({ kind: 'session', sessionId: SESSION }, 'deep/', { signal })
  assert.equal(completion.kind, 'ok')
  assert.deepEqual(
    completion.kind === 'ok' ? completion.items.map(item => item.path) : [],
    ['deep/inner.txt'],
    'the relative @ scope is the Session EFFECTIVE directory, not the header project',
  )

  // SINK 3 — the skill catalog scope handed to the REAL skill service.
  fixture.skillScopes.length = 0
  const catalog = await readSurfaceCatalog(
    agent as unknown as Parameters<typeof readSurfaceCatalog>[0],
    signal,
    ctx as unknown as SurfaceCatalogContext,
  )
  assert.equal(catalog.issues.length, 0)
  assert.ok(fixture.skillScopes.length > 0, 'the skill service was read')
  assert.deepEqual(
    fixture.skillScopes.map(scope => scope.cwd),
    fixture.skillScopes.map(() => committed),
    'every skill scope is the effective directory',
  )
})

test('a vanished effective directory recovers through the official ensure() and the TUI read follows', async t => {
  const life = testLifecycle(t)
  const fixture = await boot(life)
  const { ctx, workRoot } = fixture
  const originalProject = join(workRoot, 'project')
  const temporary = join(workRoot, 'temporary')
  mkdirSync(originalProject, { recursive: true })
  mkdirSync(temporary, { recursive: true })
  const agent = await fixture.harness.create(SessionId(`${SESSION}-recover`), {}, { cwd: originalProject })

  await callTool(ctx, 'working_directory', { cd: temporary }, agent)
  assert.equal(readerOf(fixture, agent).sessionStatus(`${SESSION}-recover`)?.cwd, temporary)

  // The directory disappears: the official Host owner restores the original
  // project (committing the recovery) the next time it is asked to validate.
  rmSync(temporary, { recursive: true, force: true })
  const workingDirectory = ctx.get('workingDirectory') as { ensure(agent: unknown, signal?: AbortSignal): Promise<string> }
  assert.equal(await workingDirectory.ensure(agent, signal), originalProject)
  assert.equal(
    readerOf(fixture, agent).sessionStatus(`${SESSION}-recover`)?.cwd,
    originalProject,
    'the TUI read follows the committed recovery instead of a stale directory',
  )
})

test('a REAL fork child keeps the original project in its header and the cut directory as effective cwd', async t => {
  const life = testLifecycle(t)
  const fixture = await boot(life)
  const { ctx, workRoot } = fixture
  const originalProject = join(workRoot, 'fork-project')
  mkdirSync(join(originalProject, 'moved'), { recursive: true })
  const agent = await fixture.harness.create(SessionId(`${SESSION}-fork-source`), {}, { cwd: originalProject })
  const committed = join(originalProject, 'moved')
  await callTool(ctx, 'working_directory', { cd: 'moved' }, agent)

  // The OFFICIAL fork helper over the REAL log, exactly like the Direct
  // lifecycle: the cut is the newest event, and the child meta repeats the
  // source HEADER (the original project).
  const sourceEvents = agent.session.snapshotEvents() as readonly SessionEvent[]
  const boundary = sourceEvents.length - 1
  const seed = buildForkSeed(sourceEvents, SessionSeq(boundary))
  const childId = SessionId(`${SESSION}-fork-child`)
  const handle = await ctx.agents.create({
    sessionId: childId,
    seed,
    inheritedEventCount: SessionLogOffset(boundary + 1),
    meta: { cwd: originalProject, parentSession: SessionId(String(agent.session.id)), isSeeded: true },
    setup: () => {},
  })
  const child = handle.agent
  assert.equal(child.session.header.cwd, originalProject, 'the child header is the ORIGINAL project')
  const workingDirectory = ctx.get('workingDirectory') as { get(session: unknown): string }
  assert.equal(
    workingDirectory.get(child.session),
    committed,
    'the inherited events carry the cut directory as the child EFFECTIVE cwd',
  )
  assert.equal(
    new DirectSessionReader(
      ctx as never,
      {
        sessionOf: candidate => String(candidate) === String(childId) ? child.session as Session : undefined,
        agentOf: candidate => String(candidate) === String(childId) ? child : undefined,
      },
      { durableProjectionForSession: () => ({ next: null, lastUsed: null }) },
    ).sessionStatus(String(childId))?.cwd,
    committed,
    'the TUI status read of the fork child follows the cut directory',
  )
})

test('two Sessions never exchange their effective directories', async t => {
  const life = testLifecycle(t)
  const fixture = await boot(life)
  const { ctx, workRoot } = fixture
  const projectA = join(workRoot, 'a')
  const projectB = join(workRoot, 'b')
  mkdirSync(join(projectA, 'moved'), { recursive: true })
  mkdirSync(projectB, { recursive: true })
  const agentA = await fixture.harness.create(SessionId(`${SESSION}-a`), {}, { cwd: projectA })
  const agentB = await fixture.harness.create(SessionId(`${SESSION}-b`), {}, { cwd: projectB })

  await callTool(ctx, 'working_directory', { cd: 'moved' }, agentA)
  const statuses = new Map<string, ReturnType<DirectSessionReader['sessionStatus']>>()
  for (const agent of [agentA, agentB]) {
    const id = String(agent.session.id)
    statuses.set(id, new DirectSessionReader(
      ctx as never,
      {
        sessionOf: candidate => String(candidate) === id ? agent.session as Session : undefined,
        agentOf: candidate => String(candidate) === id ? agent : undefined,
      },
      { durableProjectionForSession: () => ({ next: null, lastUsed: null }) },
    ).sessionStatus(id))
  }
  assert.equal(statuses.get(String(agentA.session.id))?.cwd, join(projectA, 'moved'))
  assert.equal(statuses.get(String(agentB.session.id))?.cwd, projectB, 'the other Session keeps its own directory')
})

test('the resolution helper falls back to the header only when no directory owner is mounted', async t => {
  const life = testLifecycle(t)
  const fixture = await boot(life)
  const project = join(fixture.workRoot, 'project')
  mkdirSync(project, { recursive: true })
  const agent = await fixture.harness.create(SessionId(`${SESSION}-compat`), {}, { cwd: project })

  const owner = fixture.ctx.get('workingDirectory') as WorkingDirectoryServiceLike
  assert.equal(effectiveAgentCwd(owner, agent), project, 'the official owner answers')
  assert.equal(effectiveAgentCwd(undefined, agent), project, 'an absent owner keeps the header read')
  assert.equal(projectedWorkingDirectory(null), undefined, 'the legal null (no recorded directory) stays unavailable')
  assert.equal(projectedWorkingDirectory(project), project)
})

test('a THROWING status read is remembered, and a later non-throwing empty read clears it', async t => {
  const life = testLifecycle(t)
  const fixture = await boot(life)
  const project = join(fixture.workRoot, 'project')
  mkdirSync(project, { recursive: true })
  const agent = await fixture.harness.create(SessionId(`${SESSION}-failure-bit`), {}, { cwd: project })
  const reader = readerOf(fixture, agent)
  const sessionId = String(agent.session.id)
  assert.equal(reader.sessionStatus(sessionId)?.cwd, project, 'the healthy read answers the header initial value')

  const projections = fixture.ctx.get('sessionProjections') as {
    snapshot(session: unknown, keys?: readonly string[]): unknown
  }
  const original = projections.snapshot.bind(projections)
  let mode: 'throw' | 'empty' | 'ok' = 'throw'
  projections.snapshot = ((session: unknown, keys?: readonly string[]) => {
    if (mode === 'throw') throw new Error('projection authority unavailable')
    // A snapshot object WITHOUT a values table: the reader's
    // `values === undefined` branch (no recorded value, no throw).
    if (mode === 'empty') return {}
    return original(session, keys)
  }) as typeof projections.snapshot

  // 1) The authority THROWS: the read is UNKNOWN and the failure is remembered,
  //    so no consumer substitutes the header for it.
  assert.equal(reader.sessionStatus(sessionId), undefined, 'the throwing read answers UNKNOWN')
  assert.equal(reader.sessionStatusFailed(sessionId), true, 'the failure is remembered for this Session')

  // 2) A LATER read returns a snapshot WITHOUT that key and does not throw: that
  //    is "no recorded value", not a failure — the bit clears and the Session's
  //    own header initial value is available again.
  mode = 'empty'
  assert.equal(reader.sessionStatus(sessionId), undefined, 'a snapshot without values still answers no value')
  assert.equal(reader.sessionStatusFailed(sessionId), false,
    'a non-throwing empty read must clear the previous failure bit')

  // 3) The healthy read restores the effective directory.
  mode = 'ok'
  assert.equal(reader.sessionStatus(sessionId)?.cwd, project)
  assert.equal(reader.sessionStatusFailed(sessionId), false)
  void agent
})
