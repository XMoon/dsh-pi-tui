/** Direct owned-session retirement coverage (exit / HMR / transition): a
 * currently owned Session is retired exactly once in the required order
 * (cancel -> idle -> drain -> flush -> dispose) across every reachable
 * shutdown and transition timing. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { apply as applyRunner, Config as TuiConfigSchema } from '../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import {
  disposeContext,
  event,
  fakeSession,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
} from './support/runner-harness.ts'
import { installProbe } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** A subagents fake recording drainContinuableDescendants calls. */
function retirementSubagents(events: string[]): { drainContinuableDescendants: (parents: readonly unknown[]) => Promise<void> } {
  return {
    drainContinuableDescendants: async (parents: readonly unknown[]) => {
      const parent = parents[0] as { session: { id: string } } | undefined
      events.push(`drain:${parent?.session.id ?? '?'}`)
    },
  }
}

test('fiber unload retires the Direct owned session: cancel → idle → drain → flush → dispose (HMR path)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-hmr-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-hmr-session',
    header: { id: 'retire-hmr-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, (events: string[]) => ({
    drainContinuableDescendants: async () => {
      events.push(`drain:${resumed.id}`)
      // Direct retirement can emit one final session event after the surface
      // has been disposed but before the Cordis listener is detached. The
      // runner must ignore it rather than applying it to dead folders/app.
      context!.emit('session/event', resumed as never, event('turn/start', { turn: 99 }, 99))
      context!.emit('llm/adapters-updated')
      context!.emit('settings/document-updated', 'llm-pi-ai' as never, 99 as never)
    },
  }))
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const transcriptAppliesBeforeRetirement = probe.transcriptApplyCount
  const statsAppliesBeforeRetirement = probe.statsApplyCount
  const welcomeCardsBeforeRetirement = probe.capturedWelcomeModels.length
  // HMR unload: dispose the runner fiber directly (no interactive exit).
  await fiber.dispose()
  fiber = undefined
  assert.equal(probe.transcriptApplyCount, transcriptAppliesBeforeRetirement,
    'a retirement-time session event must not apply to the disposed transcript')
  assert.equal(probe.statsApplyCount, statsAppliesBeforeRetirement,
    'a retirement-time session event must not apply to the disposed stats folder')
  assert.equal(probe.capturedWelcomeModels.length, welcomeCardsBeforeRetirement,
    'retirement-time provider/settings events must not repaint the disposed welcome card')
  // The retirement order is the fixed Direct order; the drain of the
  // continuable descendants happens BEFORE the parent handle dispose.
  const events = harness.retirementEvents
  const cancel = events.filter(event => event === 'cancel:retire-hmr-session')
  const idle = events.filter(event => event === 'idle:retire-hmr-session')
  const drain = events.filter(event => event === 'drain:retire-hmr-session')
  const flush = events.filter(event => event === 'flush:retire-hmr-session')
  const dispose = events.filter(event => event === 'dispose:retire-hmr-session')
  assert.equal(cancel.length, 1, 'the owned agent must be cancelled exactly once')
  assert.equal(drain.length, 1, 'drainContinuableDescendants must be called exactly once')
  assert.equal(dispose.length, 1, 'the owned handle must be disposed exactly once')
  assert.ok(events.indexOf('drain:retire-hmr-session') < events.indexOf('dispose:retire-hmr-session'),
    'descendant drain must complete before the parent handle dispose')
  assert.ok(events.indexOf('flush:retire-hmr-session') < events.indexOf('dispose:retire-hmr-session'),
    'the final flush must complete before the parent handle dispose')
  assert.ok(events.indexOf('cancel:retire-hmr-session') < events.indexOf('drain:retire-hmr-session'),
    'cancel must precede the descendant drain')
  assert.ok(idle.length >= 1, 'whenIdle must be awaited during retirement')
  assert.ok(flush.length >= 1, 'the final flush must run during retirement')
})

test('a successful /new retires the OLD owner post-commit (cancel → idle → drain → flush → dispose)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-switch-old',
    header: { id: 'retire-switch-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  await newHandler()
  await settle()
  // The OLD owner was retired post-commit: cancel + drain + dispose exactly
  // once each, and the drain happened before the old handle dispose.
  const events = harness.retirementEvents
  const oldCancel = events.filter(event => event === 'cancel:retire-switch-old')
  const oldDrain = events.filter(event => event === 'drain:retire-switch-old')
  const oldDispose = events.filter(event => event === 'dispose:retire-switch-old')
  assert.equal(oldCancel.length, 1, 'the old agent must be cancelled exactly once post-commit')
  assert.equal(oldDrain.length, 1, 'the old continuable descendants must be drained exactly once post-commit')
  assert.equal(oldDispose.length, 1, 'the old handle must be disposed exactly once post-commit')
  assert.ok(events.indexOf('drain:retire-switch-old') < events.indexOf('dispose:retire-switch-old'),
    'the old descendant drain must precede the old handle dispose')
  // The child stays current: the surface still owns the NEW session.
  const created = harness.createdSessions.at(-1)
  assert.ok(created, '/new must create a child session')
  assert.notEqual(created.id, 'retire-switch-old')
  // A later teardown retires the NEW owner exactly once (the old owner is
  // not retired again — the memoized retirement is per-owner).
  await fiber.dispose()
  fiber = undefined
  const newDispose = events.filter(event => event === `dispose:${created.id}`)
  assert.equal(newDispose.length, 1, 'the new current owner must be retired on teardown')
  assert.equal(oldDispose.length, 1, 'the old owner must never be retired twice')
})

test('a failed child create does NOT drain or dispose the current old owner', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-create-fail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-create-fail-old',
    header: { id: 'retire-create-fail-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The child create throws: the transition must abort with ZERO old-owner
  // side effects (no drain, no dispose — the old session stays current).
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, async () => { throw new Error('create failed') }, retirementSubagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  await newHandler()
  await settle()
  const events = harness.retirementEvents
  assert.ok(!events.some(event => event === 'drain:retire-create-fail-old'),
    'a failed child create must never drain the old owner descendants')
  assert.ok(!events.some(event => event === 'dispose:retire-create-fail-old'),
    'a failed child create must never dispose the old owner handle')
  assert.equal(harness.createdSessions.length, 0, 'a failed create must not publish a child')
  // The old session is still current: teardown retires it exactly once.
  await fiber.dispose()
  fiber = undefined
  assert.equal(events.filter(event => event === 'dispose:retire-create-fail-old').length, 1,
    'the still-current old owner must be retired on teardown')
})

test('exit during an in-flight transition does not deadlock and retires the current owner exactly once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-during-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-during-switch-old',
    header: { id: 'retire-during-switch-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  // The child create awaits the lifecycle signal: an exit during the
  // transition aborts it (the unsafe late commit is prevented).
  let createStarted!: () => void
  const createStartedPromise = new Promise<void>(resolve => { createStarted = resolve })
  const agents = harness.agents as {
    create: (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  agents.create = async ({ signal }) => {
    createStarted()
    if (signal === undefined) throw new Error('test create did not receive a lifecycle signal')
    if (signal.aborted) throw new Error('create cancelled')
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('create cancelled')), { once: true })
    })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await createStartedPromise
  // Exit while the child create is still awaiting: the fiber disposer must
  // not deadlock on the transition gate (the abort settles the create).
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  const oldDispose = events.filter(event => event === 'dispose:retire-during-switch-old')
  assert.equal(oldDispose.length, 1, 'the still-current old owner must be retired exactly once')
  assert.equal(harness.createdSessions.length, 0, 'the aborted create must not publish a child')
})

test('a late non-cooperative child create skips disposed-surface commit work and is retired', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-late-commit-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-late-commit-old',
    header: { id: 'retire-late-commit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  let releaseCreate!: () => void
  const createRelease = new Promise<void>(resolve => { releaseCreate = resolve })
  let createStarted!: () => void
  const createStartedPromise = new Promise<void>(resolve => { createStarted = resolve })
  const harness = makeHarness(
    home,
    resumed,
    { provider: 'p', model: 'm' },
    undefined,
    async () => {
      createStarted()
      await createRelease
    },
    retirementSubagents,
  )
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const welcomeCardsBeforeDispose = probe.capturedWelcomeModels.length
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await createStartedPromise

  // The fake Direct create deliberately ignores lifecycle cancellation. The
  // fiber disposer still runs surface cleanup first, then waits behind the
  // transition gate for the child owner to settle.
  const disposal = fiber.dispose()
  try {
    await settle()
    assert.equal(app.isDisposed(), true, 'surface disposal must finish before the late child resolves')
    releaseCreate()
    await transition
    await disposal
    fiber = undefined
  } finally {
    releaseCreate()
  }

  assert.equal(probe.capturedWelcomeModels.length, welcomeCardsBeforeDispose,
    'a late transition commit must not repaint the disposed welcome card')
  const child = harness.createdSessions.at(-1)
  assert.ok(child, 'the non-cooperative create still produces a child owner')
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'dispose:retire-late-commit-old').length, 1,
    'the old owner must be retired exactly once')
  assert.equal(events.filter(event => event === `dispose:${child.id}`).length, 1,
    'the late committed child owner must be retired exactly once')
})

test('an interactive exit during a non-cooperative transition create cancels each owner exactly once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-late-commit-exit-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-late-commit-exit-old',
    header: { id: 'retire-late-commit-exit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The fake Direct create deliberately ignores lifecycle cancellation: it
  // resolves only when the test releases it, AFTER the interactive exit has
  // already started the appExit root teardown.
  let releaseCreate!: () => void
  const createRelease = new Promise<void>(resolve => { releaseCreate = resolve })
  let createStarted!: () => void
  const createStartedPromise = new Promise<void>(resolve => { createStarted = resolve })
  const harness = makeHarness(
    home,
    resumed,
    { provider: 'p', model: 'm' },
    undefined,
    async () => {
      createStarted()
      await createRelease
    },
    retirementSubagents,
  )
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id }, () => {
    harness.retirementEvents.push('appExit')
    // The launcher's appExit disposes the application tree: the runner fiber
    // disposer joins the memoized retirement.
    void fiber?.dispose()
  })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await createStartedPromise

  // Interactive exit while the create is pending: the exit preparation cancels
  // the CURRENT owner synchronously, before appExit starts the root teardown.
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  const beforeRelease = harness.retirementEvents
  assert.equal(beforeRelease.filter(event => event === 'cancel:retire-late-commit-exit-old').length, 1,
    `the interactive exit must pre-cancel the current owner exactly once: ${JSON.stringify(beforeRelease)}`)
  assert.ok(beforeRelease.indexOf('cancel:retire-late-commit-exit-old') < beforeRelease.indexOf('appExit'),
    `the pre-cancel must land before appExit: ${JSON.stringify(beforeRelease)}`)

  // The non-cooperative create now commits its child after appExit began: the
  // transition's own post-commit retirement must NOT cancel the old owner a
  // second time (that second cancel is the one that can land after the inbox
  // projection was unregistered).
  releaseCreate()
  await settle()
  await transition
  const events = harness.retirementEvents
  const child = harness.createdSessions.at(-1)
  assert.ok(child, 'the non-cooperative create still produces a child owner')
  assert.equal(events.filter(event => event === 'cancel:retire-late-commit-exit-old').length, 1,
    `the replaced owner must not be cancelled again after the root teardown began: ${JSON.stringify(events)}`)
  assert.equal(events.filter(event => event === `cancel:${child.id}`).length, 1,
    `the committed NEW owner must be cancelled exactly once by the retirement: ${JSON.stringify(events)}`)
  assert.equal(events.filter(event => event === 'dispose:retire-late-commit-exit-old').length, 1,
    'the replaced owner must be retired exactly once')
  assert.equal(events.filter(event => event === `dispose:${child.id}`).length, 1,
    'the late committed child owner must be retired exactly once')
})

test('a throwing shutdown cancel inside the abort listener is contained and retried, never an uncaught exception', async (t) => {
  const life = testLifecycle(t)
  /** One full shutdown run for the value thrown on the first cancel. */
  const scenario = async (label: string, thrown: unknown) => {
    const home = life.tempDir(`dsh-pi-tui-retire-abort-throw-${label}-`)
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    life.defer(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    const probe = installProbe()
    life.defer(probe.restore)
    let context: Context | undefined
    let fiber: { dispose: () => Promise<unknown> } | undefined
    life.defer(() => { if (context !== undefined) return disposeContext(context) })
    life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
    const sessionId = `retire-abort-throw-${label}-old`
    const resumed: FakeSession = fakeSession({
      id: sessionId,
      header: { id: sessionId, cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: sessionEvents('old answer'),
    })
    // The FIRST whenIdle (startup resume) settles; the SECOND (the /new
    // pre-commit quiesce) hangs, so the transition parks in `whenIdleOrAbort`
    // with its lifecycle-abort listener armed.
    let idleCalls = 0
    const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents, async () => {
      idleCalls += 1
      if (idleCalls > 1) await new Promise<void>(() => {})
    })
    context = new Context()
    fiber = await mountRunner(context, home, harness, { sessionId }, { sessionId })
    const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
    assert.ok(newHandler, 'the real runner must register the /new transition command')
    const transition = newHandler()
    await settle()
    assert.equal(idleCalls, 2, 'the /new pre-commit quiesce must be awaiting the stuck whenIdle')

    // The FIRST shutdown cancel throws — exactly the
    // `cannot read inbox state: its projection registration is not active`
    // failure the hardening exists for. An AbortSignal listener is a Node
    // EventTarget: an escaping throw would become an uncaughtException that no
    // `try { disposeSurface() } catch` can see.
    const liveAgent = (harness.agents as { get(id: string): { cancel(): void } | undefined }).get(sessionId)
    assert.ok(liveAgent, 'the resumed session must have a live Agent')
    const originalCancel = liveAgent.cancel.bind(liveAgent)
    let cancelAttempts = 0
    liveAgent.cancel = () => {
      cancelAttempts += 1
      if (cancelAttempts === 1) throw thrown
      originalCancel()
    }
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', onUncaught)
    life.defer(() => { process.off('uncaughtException', onUncaught) })

    await fiber.dispose()
    fiber = undefined
    await transition
    await settle()
    return { sessionId, uncaught, cancelAttempts, events: harness.retirementEvents }
  }

  // A plain Error AND a non-Error value whose coercion itself throws: the
  // listener must not format the value at all, because ANY formatting step
  // (`String(value)`, an unprotected `instanceof`, a `.message` read) can throw
  // for the hostile value and would then escape as an uncaughtException.
  const hostile: unknown = Object.create(null)
  for (const [label, thrown] of [
    ['error', new Error('cancel exploded before the projection was torn down')],
    ['hostile', hostile],
  ] as const) {
    const { sessionId, uncaught, cancelAttempts, events } = await scenario(label, thrown)
    assert.deepEqual(uncaught, [], `a ${label} shutdown cancel must never escape the abort listener`)
    assert.equal(cancelAttempts, 2, `the failed ${label} cancel must be retried by the retirement cancel phase`)
    assert.equal(events.filter(event => event === `cancel:${sessionId}`).length, 1,
      `only the successful ${label} retry cancels the fake agent`)
    assert.equal(events.filter(event => event === `dispose:${sessionId}`).length, 1,
      `the ${label} owner must still be disposed exactly once`)
  }
})

test('an interactive exit retires the owned session through the appExit disposal', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-interactive-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-interactive-session',
    header: { id: 'retire-interactive-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  let exitCalls = 0
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id }, () => {
    exitCalls += 1
    // Recorded in the SAME event log as the retirement phases so the test can
    // assert that the first cancel lands BEFORE the root teardown starts.
    harness.retirementEvents.push('appExit')
    // The launcher's appExit disposes the application tree: the runner
    // fiber disposer runs the Direct owned-session retirement.
    void fiber?.dispose()
  })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  // Interactive exit: submit the plain `exit` prompt (shell muscle memory).
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.equal(exitCalls, 1, 'the interactive exit must request appExit exactly once')
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'cancel:retire-interactive-session').length, 1,
    'the interactive exit must cancel the owned agent exactly once (pre-cancel and the retirement cancel phase are the same Agent)')
  assert.equal(events.filter(event => event === 'drain:retire-interactive-session').length, 1,
    'the interactive exit must drain the continuable descendants')
  assert.equal(events.filter(event => event === 'dispose:retire-interactive-session').length, 1,
    'the interactive exit must dispose the owned handle')
  // The hardening contract: the FIRST cancel is synchronous shutdown
  // preparation and must precede appExit, because the root teardown
  // unregisters the inbox projection the later cancel depends on. Only the
  // cancel comes forward — idle/drain/flush/dispose stay inside the
  // appExit-bounded disposal.
  const cancelIndex = events.indexOf('cancel:retire-interactive-session')
  const appExitIndex = events.indexOf('appExit')
  assert.ok(cancelIndex >= 0 && appExitIndex >= 0 && cancelIndex < appExitIndex,
    `the pre-cancel must land before appExit (cancel at ${cancelIndex}, appExit at ${appExitIndex}): ${JSON.stringify(events)}`)
  assert.ok(events.indexOf('drain:retire-interactive-session') > appExitIndex,
    'the descendant drain must stay inside the appExit disposal')
  assert.ok(events.indexOf('dispose:retire-interactive-session') > events.indexOf('drain:retire-interactive-session'),
    'the descendant drain must precede the parent handle dispose on the interactive path too')
})

test('a FAILING pre-cancel is not recorded as done: appExit still runs and the retirement retries the cancel', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-precancel-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-precancel-failure-session',
    header: { id: 'retire-precancel-failure-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  let exitCalls = 0
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id }, () => {
    exitCalls += 1
    harness.retirementEvents.push('appExit')
    void fiber?.dispose()
  })
  // The FIRST cancel throws (exactly the projection-already-unregistered
  // failure this hardening exists for); the retirement's own cancel phase
  // must retry it rather than treating the failed preparation as done.
  const liveAgent = (harness.agents as { get(id: string): { cancel(): void } | undefined }).get(resumed.id)
  assert.ok(liveAgent, 'the resumed session must have a live Agent')
  const originalCancel = liveAgent.cancel.bind(liveAgent)
  let cancelAttempts = 0
  liveAgent.cancel = () => {
    cancelAttempts += 1
    if (cancelAttempts === 1) throw new Error('cancel exploded before the projection was torn down')
    originalCancel()
  }
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.equal(exitCalls, 1, 'a failing preparation must never block appExit')
  assert.equal(cancelAttempts, 2, 'the failed pre-cancel must be retried by the retirement cancel phase')
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'cancel:retire-precancel-failure-session').length, 1,
    'only the successful retry cancels the fake agent')
  assert.equal(events.filter(event => event === 'dispose:retire-precancel-failure-session').length, 1,
    'the retirement must still dispose the owner exactly once')
  assert.ok(events.indexOf('appExit') >= 0, 'appExit must have been requested')
})

test('exit after a transition COMMITTED retires the NEW current owner, never the old twice', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-after-commit-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-after-commit-old',
    header: { id: 'retire-after-commit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The child create is gated: the transition commits only after the gate
  // releases, so the test can exit in the post-commit window.
  let releaseCreate!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, () => createGate, retirementSubagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await settle()
  // The child create completes and the transition commits.
  releaseCreate()
  await settle()
  // Exit in the post-commit window: the retirement must target the NEW
  // current owner (the old owner was already retired post-commit).
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  const created = harness.createdSessions.at(-1)
  assert.ok(created, '/new must create a child session')
  const oldDisposes = events.filter(event => event === 'dispose:retire-after-commit-old')
  const newDisposes = events.filter(event => event === `dispose:${created.id}`)
  assert.equal(oldDisposes.length, 1, 'the old owner must be retired exactly once (post-commit)')
  assert.equal(newDisposes.length, 1, 'the NEW current owner must be the shutdown target')
  assert.ok(events.indexOf(`dispose:${created.id}`) > events.indexOf('dispose:retire-after-commit-old'),
    'the new owner retirement must follow the old owner retirement')
})

test('exit during a transition stuck in pre-commit whenIdle: the pre-cancel unblocks it and the old owner is retired', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-whenidle-stuck-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-whenidle-stuck-old',
    header: { id: 'retire-whenidle-stuck-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The FIRST whenIdle (startup resume) settles; the SECOND (the /new
  // pre-commit quiesce) hangs — the old agent is "busy" and its whenIdle
  // does not observe the lifecycle signal, exactly like a real LLM turn.
  let idleCalls = 0
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents, async () => {
    idleCalls += 1
    if (idleCalls >= 2) {
      await new Promise<void>(() => {})
    }
  })
  // The child create observes the lifecycle signal: the exit aborts it.
  const agents = harness.agents as {
    create: (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  agents.create = async ({ signal }) => {
    if (signal === undefined) throw new Error('test create did not receive a lifecycle signal')
    if (signal.aborted) throw new Error('create cancelled')
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('create cancelled')), { once: true })
    })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await settle()
  assert.equal(idleCalls, 2, 'the /new pre-commit quiesce must be awaiting the stuck whenIdle')
  // Exit while the transition is stuck in its pre-commit quiesce: the
  // retirement pre-cancel must unblock the whenIdle (no deadlock), the
  // aborted create must fail the transition, and the still-current old
  // owner must be retired.
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'dispose:retire-whenidle-stuck-old').length, 1,
    'the still-current old owner must be retired exactly once')
  assert.equal(events.filter(event => event === 'cancel:retire-whenidle-stuck-old').length, 1,
    'the old owner must be cancelled EXACTLY once: the lifecycle-abort cancel and the shutdown pre-cancel are the same cancel')
  assert.equal(harness.createdSessions.length, 0, 'the aborted create must not publish a child')
})

test('shutdown during an ordinary transition that still COMMITS: the final retirement re-reads and retires the NEW owner', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-shutdown-commit-new-owner-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const source: FakeSession = fakeSession({
    id: 'shutdown-commit-source',
    header: { id: 'shutdown-commit-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  let signalCreateStarted!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  let releaseCreate!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  const harness = makeHarness(home, source, { provider: 'p', model: 'm' }, undefined, async () => {
    signalCreateStarted()
    await createGate
  })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await createStarted
  // Shutdown begins while the transition is parked in its `create`: the
  // pre-cancel captures the OLD owner (A) and the memoized retirement waits for
  // the transition gate the /new task still holds.
  const disposal = fiber.dispose()
  fiber = undefined
  await settle()
  // The create now resolves, so the transition COMMITS the NEW owner (B) and
  // releases the gate. The final shutdown retirement MUST re-read the current
  // owner rather than reuse the pre-cancelled capture.
  releaseCreate()
  // Lock the microtask BUDGET: the committed child's disposal must land within
  // ONE bounded settle() (40 microtask turns), before any explicit await on the
  // transition or on the disposal promise — awaiting them first would hide a
  // deeper retirement chain.
  await settle()
  const child = harness.createdSessions.at(-1)
  assert.ok(child, 'the transition must have created its child Session')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${child.id}`).length, 1,
    `the shutdown retirement must dispose the NEW current owner within the settle budget: ${JSON.stringify(harness.retirementEvents)}`)
  await transition
  await disposal
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === `cancel:${source.id}`).length, 1,
    'the pre-cancel must cancel the OLD owner exactly once')
  assert.equal(events.filter(event => event === `cancel:${child.id}`).length, 1,
    'the final retirement must cancel the NEW current owner exactly once')
  assert.equal(events.filter(event => event === `dispose:${source.id}`).length, 1,
    'the transition retire-old must dispose the OLD owner exactly once')
  assert.equal(events.filter(event => event === `dispose:${child.id}`).length, 1,
    'the shutdown retirement must dispose the NEW current owner exactly once, not the pre-cancelled one')
})

test('a pre-mount unload while the resume whenIdle is pending cancels the agent and retires the owner', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-premount-whenidle-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  const resumed: FakeSession = fakeSession({
    id: 'premount-whenidle-session',
    header: { id: 'premount-whenidle-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  // The resume whenIdle hangs (a busy agent): the pre-mount wait must be
  // broken by the lifecycle abort, not left hanging forever.
  let whenIdleStarted!: () => void
  const whenIdleStartedPromise = new Promise<void>(resolve => { whenIdleStarted = resolve })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents, async () => {
    whenIdleStarted()
    await new Promise<void>(() => {})
  })
  context = new Context()
  // Provide the same host services as mountRunner, but do NOT await the
  // startup settle: the IIFE is stuck in the pre-mount whenIdle. The early
  // lifecycle-cancellation effect is registered before the resume, so
  // disposing the context aborts the signal.
  context.provide('appExit', () => {})
  context.provide(TUI_STARTUP_SERVICE, { sessionId: resumed.id, shippedPresetRoot: home })
  context.provide('sessionPersistence', harness.persistence as never)
  context.provide('sessionQuery', harness.sessionQuery as never)
  context.provide('agents', harness.agents as never)
  context.provide('sessions', harness.sessions as never)
  context.provide('agentDefaultModel', harness.defaultModel as never)
  context.provide('llm', harness.llm as never)
  context.provide('commands', harness.commands as never)
  context.provide('subagents', harness.subagents as never)
  context.provide('loader', { await: async () => {} } as never)
  const fiber = context.plugin((pluginCtx) => applyRunner(pluginCtx, TuiConfigSchema({ sessionId: resumed.id } as never)))
  await fiber
  await whenIdleStartedPromise
  await disposeContext(context)
  context = undefined
  await settle()
  const events = harness.retirementEvents
  assert.ok(events.some(event => event === 'cancel:premount-whenidle-session'),
    'the abort must cancel the agent so the pre-mount whenIdle settles')
  assert.equal(events.filter(event => event === 'dispose:premount-whenidle-session').length, 1,
    'the just-created owner must be retired exactly once')
  assert.equal(probe.apps.length, 0, 'the cancelled startup must not mount a TUI')
})

test('exit with TWO queued transitions: the second quiesce is abort-aware and the current owner is retired', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-two-queued-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-two-queued-old',
    header: { id: 'retire-two-queued-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The FIRST /new create is gated; the SECOND /new queues behind it. The
  // second transition's quiesce targets the FIRST transition's committed
  // child, whose whenIdle hangs (busy) — the exit must cancel it.
  let releaseCreateA!: () => void
  const createGateA = new Promise<void>(resolve => { releaseCreateA = resolve })
  let createCalls = 0
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, async () => {
    createCalls += 1
    if (createCalls === 1) await createGateA
  }, retirementSubagents, async (sessionId) => {
    // The FIRST child (committed by the first /new) is busy: its whenIdle
    // hangs in BOTH the first transition's post-commit child quiesce and
    // the second transition's pre-commit quiesce.
    if (sessionId !== 'retire-two-queued-old') {
      await new Promise<void>(() => {})
    }
  })
  // The SECOND create observes the lifecycle signal: the exit aborts it.
  const agents = harness.agents as {
    create: (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  const originalCreate = agents.create as (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  agents.create = async (options) => {
    createCalls += 1
    if (createCalls === 1) {
      await createGateA
      return originalCreate(options)
    }
    if (options.signal === undefined) throw new Error('test create did not receive a lifecycle signal')
    if (options.signal.aborted) throw new Error('create cancelled')
    return await new Promise<never>((_, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('create cancelled')), { once: true })
    })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const first = newHandler()
  const second = newHandler()
  await settle()
  releaseCreateA()
  await settle()
  // Exit: the pre-cancel (and the abort-aware quiesce) must unblock the
  // first transition's post-commit child quiesce AND the second
  // transition's pre-commit quiesce, the aborted create must fail the
  // second transition, and the current owner must be retired.
  await fiber.dispose()
  fiber = undefined
  await first
  await second
  const events = harness.retirementEvents
  const created = harness.createdSessions.at(-1)
  assert.ok(created, 'the first /new must create a child')
  assert.equal(events.filter(event => event === 'dispose:retire-two-queued-old').length, 1,
    'the original owner must be retired exactly once (first transition post-commit)')
  assert.equal(events.filter(event => event === `dispose:${created.id}`).length, 1,
    'the still-current first child must be retired exactly once (teardown)')
  assert.equal(events.filter(event => event === `cancel:${created.id}`).length, 1,
    'the first child must be cancelled EXACTLY once (abort-aware quiesce and retirement share one cancel)')
})

test('exit during the post-commit child quiesce skips surface init and retires the committed child', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-child-idle-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'exit-after-commit-old',
    header: { id: 'exit-after-commit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  let releaseCreate!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, () => createGate, retirementSubagents, async (sessionId) => {
    // The committed child is busy: its post-commit quiesce hangs.
    if (sessionId !== 'exit-after-commit-old') {
      await new Promise<void>(() => {})
    }
  })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await settle()
  releaseCreate()
  await settle()
  // The transition committed the child and is now stuck in the post-commit
  // child quiesce. Exit: the abort-aware quiesce cancels the child, the
  // surface init is skipped, and the committed child is retired.
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  const created = harness.createdSessions.at(-1)
  assert.ok(created, '/new must create a child session')
  assert.equal(events.filter(event => event === 'dispose:exit-after-commit-old').length, 1,
    'the old owner must be retired exactly once (post-commit)')
  assert.equal(events.filter(event => event === `dispose:${created.id}`).length, 1,
    'the committed child must be retired exactly once (teardown)')
  assert.equal(events.filter(event => event === `cancel:${created.id}`).length, 1,
    'the committed child must be cancelled EXACTLY once by the abort-aware quiesce, not again by retirement')
})

test('a retirement flush failure warns the user on stderr (durability is not silently lost)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-warn-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-warn-session',
    header: { id: 'retire-warn-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  // The final retirement flush fails (disk full): the user must see a
  // warning, not a silent clean exit.
  ;(harness.sessions as { flush: (session?: unknown) => Promise<unknown> }).flush = async () => {
    throw new Error('disk full')
  }
  const stderrWrites: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  life.defer(() => { process.stderr.write = originalWrite })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  await fiber.dispose()
  fiber = undefined
  assert.ok(stderrWrites.some(write => write.includes('session flush failed during retirement') && write.includes('disk full')),
    `the user must see the flush-failure warning on stderr: ${JSON.stringify(stderrWrites)}`)
  assert.ok(stderrWrites.some(write => write.includes('the latest events may not be persisted')),
    'the warning must state the durability consequence')
})

test('a retirement descendant-drain failure warns with the failing phases (not the flush wording)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-warn-drain-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-warn-drain-session',
    header: { id: 'retire-warn-drain-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  // The descendant drain fails: the warning must name the failing phases,
  // NOT use the flush-specific durability wording.
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, (events: string[]) => ({
    drainContinuableDescendants: async () => {
      events.push('drain:retire-warn-drain-session')
      throw new Error('drain exploded')
    },
  }))
  const stderrWrites: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  life.defer(() => { process.stderr.write = originalWrite })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  await fiber.dispose()
  fiber = undefined
  assert.ok(stderrWrites.some(write => write.includes('session retirement failed during descendants')),
    `the warning must name the failing phase: ${JSON.stringify(stderrWrites)}`)
  assert.ok(!stderrWrites.some(write => write.includes('the latest events may not be persisted')),
    'a non-flush failure must not claim a durability loss')
})
