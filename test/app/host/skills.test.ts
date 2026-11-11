/**
 * The private `piTuiSkills` Host service (M6-1 F6).
 *
 * Evidence level: the REAL Cordis Context + Typert registry with controlled
 * Host authorities standing in for the official Workspace/preset/Skills
 * services. The service code under test is the production one; the two real
 * OS-process wire proof lives in the split-process `skills` suite.
 *
 * Contract pinned here:
 * - the Host resolves the confirmed WorkspaceId through the official
 *   Workspace registry and reads the Host canonical path (never a Client cwd);
 * - the official `agentPresets.acquireScope()` revision lease is requested
 *   with the exact preset id and released exactly once on every path;
 * - only human-invocable metadata crosses (no body/path/locator/scope key),
 *   sorted by name, with `complete` passed through unchanged;
 * - an unknown Workspace, a cancelled read and a failing read fail loudly
 *   instead of fabricating an empty complete catalog;
 * - the invalidation stream opens with one startup frame, coalesces a Host
 *   burst into one pending bit, and ends with abort or plugin disposal.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/skills.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { PiTuiSkillsHostService } from '../../../src/app/host/features/skills.ts'
import {
  PI_TUI_SKILLS_NAMESPACE,
  parsePiTuiSkillsStandingResult,
  type PiTuiSkillsInvalidationFrame,
} from '../../../src/runtime/remote/pi-tui-skills-contract.ts'

const FIBER_ACTIVE = 2

interface SnapshotOptions {
  readonly cwd: string
  readonly scope?: object
  readonly signal: AbortSignal
}

interface FixtureOptions {
  readonly workspacePath?: string | undefined
  readonly presetError?: Error
  readonly snapshot?: (options: SnapshotOptions) => Promise<{
    readonly skills: readonly Record<string, unknown>[]
    readonly complete: boolean
  }>
}

interface Fixture {
  readonly ctx: Context
  readonly service: PiTuiSkillsHostService
  readonly fiber: Fiber
  readonly snapshotCalls: SnapshotOptions[]
  readonly scopeRequests: Array<string | undefined>
  readonly leaseDisposals: number
  readonly releases: number
  dispose(): Promise<void>
}

/** Build the real Host Context the production service is mounted into. */
async function hostFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const workspacePath = options.workspacePath === undefined ? '/host/canonical/ws-1' : options.workspacePath
  const snapshotCalls: SnapshotOptions[] = []
  const scopeRequests: Array<string | undefined> = []
  const state = { leaseDisposals: 0, releases: 0 }
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === 'ws-1' && workspacePath !== undefined ? { path: workspacePath } : undefined,
  })
  ctx.provide('skills', {
    snapshot: async (snapshotOptions: SnapshotOptions) => {
      snapshotCalls.push(snapshotOptions)
      if (options.snapshot !== undefined) return options.snapshot(snapshotOptions)
      return { skills: [], complete: true }
    },
  })
  ctx.provide('agentPresets', {
    acquireScope: async (id?: string) => {
      scopeRequests.push(id)
      if (options.presetError !== undefined) throw options.presetError
      return {
        key: { scope: id ?? 'default' },
        [Symbol.asyncDispose]: async () => { state.leaseDisposals += 1 },
      }
    },
  })
  let service!: PiTuiSkillsHostService
  const fiber = ctx.inject(['typert', 'workspaceRegistry', 'skills', 'agentPresets'], pluginCtx => {
    service = new PiTuiSkillsHostService(pluginCtx)
  })
  await fiber
  assert.equal(fiber.state, FIBER_ACTIVE)
  return {
    ctx,
    service,
    fiber,
    snapshotCalls,
    scopeRequests,
    get leaseDisposals() { return state.leaseDisposals },
    get releases() { return state.releases },
    dispose: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** Bounded failure guard: a hung stream read must fail the case, not the lane. */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000)
    }),
  ])
}

/** Drain the generator's own microtask/macrotask propagation (no timer inside). */
async function settleTurns(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('standing resolves the Host canonical workspace, reads the exact lease scope, and releases it once', async () => {
  const fixture = await hostFixture({
    snapshot: async () => ({
      skills: [
        { name: 'zeta', description: 'Z', invocation: { userInvocable: true, modelInvocable: true } },
        { name: 'alpha', description: 'A', whenToUse: 'when A', invocation: { userInvocable: true, modelInvocable: false } },
      ],
      complete: true,
    }),
  })
  try {
    const result = parsePiTuiSkillsStandingResult(
      await fixture.service.standing({ workspaceId: 'ws-1', presetId: 'standard' }, new AbortController().signal),
    )
    assert.deepEqual(fixture.scopeRequests, ['standard'], 'the EXACT preset id is leased')
    assert.equal(fixture.snapshotCalls.length, 1)
    assert.equal(fixture.snapshotCalls[0]!.cwd, '/host/canonical/ws-1', 'the Host canonical path, never a Client cwd')
    assert.deepEqual(fixture.snapshotCalls[0]!.scope, { scope: 'standard' })
    assert.equal(fixture.leaseDisposals, 1, 'the revision lease is released once after the read')
    assert.deepEqual(result.skills, [
      { name: 'alpha', description: 'A', whenToUse: 'when A', modelInvocable: false },
      { name: 'zeta', description: 'Z', modelInvocable: true },
    ], 'human metadata only, sorted by name')
    assert.equal(result.complete, true)
    assert.equal(result.notice, undefined)
  } finally {
    await fixture.dispose()
  }
})

test('standing excludes model-only and malformed invocation entries', async () => {
  const fixture = await hostFixture({
    snapshot: async () => ({
      skills: [
        { name: 'human', description: 'h', invocation: { userInvocable: true, modelInvocable: true } },
        { name: 'model-only', description: 'm', invocation: { userInvocable: false, modelInvocable: true } },
        { name: 'malformed', description: 'x', invocation: { modelInvocable: true } },
        { name: 'no-invocation', description: 'n' },
      ],
      complete: true,
    }),
  })
  try {
    const result = await fixture.service.standing({ workspaceId: 'ws-1' }, new AbortController().signal)
    assert.deepEqual(result.skills.map(skill => skill.name), ['human'])
  } finally {
    await fixture.dispose()
  }
})

test('an unknown or revoked WorkspaceId is refused before any lease or catalog read', async () => {
  const fixture = await hostFixture()
  try {
    await assert.rejects(
      () => fixture.service.standing({ workspaceId: 'ws-revoked' }, new AbortController().signal),
      /workspace is unavailable/,
    )
    assert.deepEqual(fixture.scopeRequests, [])
    assert.deepEqual(fixture.snapshotCalls, [])
    assert.equal(fixture.leaseDisposals, 0)
  } finally {
    await fixture.dispose()
  }
})

test('a failing preset lease degrades to the global layer with a notice and no scope', async () => {
  const fixture = await hostFixture({
    presetError: new Error('preset mount broken'),
    snapshot: async () => ({ skills: [], complete: true }),
  })
  try {
    const result = await fixture.service.standing({ workspaceId: 'ws-1', presetId: 'broken' }, new AbortController().signal)
    assert.equal(fixture.snapshotCalls.length, 1)
    assert.equal(fixture.snapshotCalls[0]!.scope, undefined, 'the fallback read carries no standing scope')
    assert.equal(result.notice, 'Preset scope is unavailable; showing global skills.')
    assert.equal(fixture.leaseDisposals, 0)
  } finally {
    await fixture.dispose()
  }
})

test('an incomplete Host observation is passed through as incomplete', async () => {
  const fixture = await hostFixture({ snapshot: async () => ({ skills: [], complete: false }) })
  try {
    const result = await fixture.service.standing({ workspaceId: 'ws-1' }, new AbortController().signal)
    assert.equal(result.complete, false)
  } finally {
    await fixture.dispose()
  }
})

test('an already-aborted read performs no lease or snapshot call', async () => {
  const fixture = await hostFixture()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => fixture.service.standing({ workspaceId: 'ws-1' }, controller.signal),
      (error: unknown) => (error as { name?: string }).name === 'AbortError',
    )
    assert.deepEqual(fixture.scopeRequests, [])
    assert.deepEqual(fixture.snapshotCalls, [])
  } finally {
    await fixture.dispose()
  }
})

test('an abort during the scoped read still releases the lease exactly once', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fixture = await hostFixture({
    snapshot: async (snapshotOptions) => {
      await gate
      snapshotOptions.signal.throwIfAborted()
      return { skills: [], complete: true }
    },
  })
  try {
    const controller = new AbortController()
    const pending = fixture.service.standing({ workspaceId: 'ws-1' }, controller.signal)
    await settleTurns()
    controller.abort()
    release()
    await assert.rejects(pending, (error: unknown) => (error as { name?: string }).name === 'AbortError')
    assert.equal(fixture.leaseDisposals, 1)
  } finally {
    await fixture.dispose()
  }
})

test('the invalidation stream opens with the startup frame and coalesces a Host burst into one pending wake', async () => {
  const fixture = await hostFixture()
  const controller = new AbortController()
  const iterator = fixture.service.watchInvalidations(controller.signal)
  try {
    const opening = await withTimeout(iterator.next(), 'the startup invalidation frame')
    assert.deepEqual(opening.value, { kind: 'invalidated' })

    for (let index = 0; index < 5; index += 1) fixture.ctx.emit('skills/change')
    const burst = await withTimeout(iterator.next(), 'one coalesced burst frame')
    assert.deepEqual(burst.value, { kind: 'invalidated' })

    // No frame is pending after the single coalesced delivery: the generator's
    // pending bit is process-local and has no timer of its own, so one drained
    // macrotask turn is the complete settlement path for "nothing more queued".
    let additional: PiTuiSkillsInvalidationFrame | undefined
    const pendingNext = iterator.next()
    void pendingNext.then(next => { if (next.done !== true) additional = next.value })
    await settleTurns()
    assert.equal(additional, undefined, 'five synchronous Host events wake ONE pending invalidation')

    fixture.ctx.emit('skills/change')
    const next = await withTimeout(pendingNext, 'the next invalidation frame')
    assert.deepEqual(next.value, { kind: 'invalidated' })
  } finally {
    controller.abort()
    await fixture.dispose()
  }
})

test('abort and plugin disposal end the stream and release the Host listener', async () => {
  const first = await hostFixture()
  const controller = new AbortController()
  const iterator = first.service.watchInvalidations(controller.signal)
  await withTimeout(iterator.next(), 'the startup frame')
  controller.abort()
  const ended = await withTimeout(iterator.next(), 'the aborted stream')
  assert.equal(ended.done, true)
  await first.dispose()

  const second = await hostFixture()
  const disposerController = new AbortController()
  const secondIterator = second.service.watchInvalidations(disposerController.signal)
  await withTimeout(secondIterator.next(), 'the second startup frame')
  await second.dispose()
  const closed = await withTimeout(secondIterator.next(), 'the disposed stream')
  assert.equal(closed.done, true)
  // The Host listener is gone with the fiber: a later event cannot wake anyone.
  second.ctx.emit('skills/change')
  await settleTurns()
})
