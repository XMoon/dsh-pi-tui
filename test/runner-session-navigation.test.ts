/** Runner-level regression coverage for Session navigation/adoption:
 * /fork, /rewind, /new transition ownership, fork source retirement ordering,
 * command settlement, navigation supersession, parked Direct child ownership,
 * stale-callback fencing, and Host-owned fork anchors. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldPendingModelSelection } from '../src/model-selection.ts'
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
import { installProbe, modelEvent } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((entry, index) => ({
    ...entry,
    seq: SessionSeq(index),
    time: 1_700_000_000_000 + index * 1000,
  }))
}

test('/fork inherits the Host-chosen completed prefix including the trailing source switch', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-selection-')
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

  const currentSelection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const sourceEvents = resequence([
    modelEvent('model/selection', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
    }, 1),
    ...sessionEvents('source answer'),
    // The source's current switch stands after the completed turn with no
    // queued-input boundary behind it, so the alpha.2 latest-completed-prefix
    // cut INCLUDES it: the child inherits the pending switch as Host state.
    modelEvent('model/selection', currentSelection, 6),
  ])
  const source: FakeSession = fakeSession({
    id: 'fork-selection-source',
    header: { id: 'fork-selection-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sourceEvents,
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await forkHandler()
  await settle()

  assert.equal(harness.createdSessions.length, 1, 'fork creates one child')
  const child = harness.createdSessions[0]!
  const inheritedPrefix = sourceEvents
  assert.deepEqual(harness.createInheritedEventCounts, [inheritedPrefix.length],
    'the alpha.2 latest-completed-prefix cut extends through the trailing stable selection')
  assert.deepEqual(child.snapshotEvents().slice(0, inheritedPrefix.length), inheritedPrefix,
    'the child keeps the exact inherited prefix')
  assert.deepEqual(source.snapshotEvents(), sourceEvents, 'fork does not mutate the source log')
  const childBoundary = child.snapshotEvents()[inheritedPrefix.length]
  assert.equal((childBoundary as unknown as { type?: unknown } | undefined)?.type, 'session/end-seed',
    'the child-owned end-seed marker (not a runner write) sits at the inherited cut')
  const childSelections = child.snapshotEvents().filter(event => (event as unknown as { type?: unknown }).type === 'model/selection')
  assert.deepEqual((childSelections.at(-1) as unknown as { data?: unknown } | undefined)?.data, currentSelection,
    'the child inherits the source current switch that stands inside the completed prefix')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).lastUsed, {
    provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
  }, 'the child effective selection remains the consumed historical A selection')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).pending, currentSelection,
    'the inherited trailing switch stays a pending intent, Host-owned')
  // M3-2 regression: the Direct fork handle is already owned, so the adoption
  // must resolve it directly — the Remote publication→open adoption path must
  // never add a second `lifecycle.open` (a resume/compose) for the child.
  assert.ok(!harness.resumeSessionIds.includes(child.id),
    'a Direct fork adoption must not open/resume the child a second time')
  assert.deepEqual(harness.resumeSessionIds, [source.id],
    'only the startup resume ran; the fork child was adopted through its owned handle')
})

test('/fork leaves the source Session attached until the executor appends command/done', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-settlement-')
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

  const source = fakeSession({
    id: 'fork-settlement-source',
    header: { id: 'fork-settlement-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const harness = makeHarness(home, source)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()

  assert.equal(harness.createdSessions.length, 1, '/fork must fork one child through the command plane')
  // The official executor appends `command/done` to the SOURCE Session only
  // after the handler settles; appending to a detached Session never reaches
  // the persistence writer. The source owner must therefore still be live at
  // that append — retiring it inside the handler (which detaches the Session)
  // is the regression this asserts.
  const sourceSettlements = harness.commandSettlements.filter(entry => entry.sessionId === source.id)
  assert.deepEqual(sourceSettlements.map(entry => entry.phase), ['run', 'done'])
  assert.equal(sourceSettlements.at(-1)?.ownerLive, true,
    'the source owner must stay attached through the command/done append')
  const eventTypes = source.snapshotEvents().map(event => (event as unknown as { type?: unknown }).type)
  assert.ok(eventTypes.includes('command/run') && eventTypes.includes('command/done'),
    `the source log must keep the run/done pairing: ${JSON.stringify(eventTypes)}`)

  // The retirement still happens — just after settlement, never lost.
  await settle()
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'the source owner must still be disposed after the command settled')
})

test('/fork teardown awaits the command settlement and retires the source exactly once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-teardown-')
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

  let releaseCreate!: () => void
  let signalCreateStarted!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  let releaseSettlement!: () => void
  let signalSettlementReached!: () => void
  const settlementReached = new Promise<void>(resolve => { signalSettlementReached = resolve })
  const source = fakeSession({
    id: 'fork-teardown-source',
    header: { id: 'fork-teardown-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const harness = makeHarness(home, source, undefined, undefined, async () => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  })
  // Hold the executor's post-handler `command/done` append open, so the test can
  // observe whether teardown respects the in-flight command settlement.
  ;(harness.commands as { settlementGate?: () => Promise<void> }).settlementGate = async () => {
    signalSettlementReached()
    await new Promise<void>(resolve => { releaseSettlement = resolve })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await createStarted

  // Tear the surface down WHILE the `/fork` command is inside `agents.create`,
  // then let the fork settle but keep `command/done` open.
  const disposal = fiber.dispose()
  await settle()
  releaseCreate()
  await settlementReached
  await settle()
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length, 0,
    'teardown must not retire the source while its own command is still settling')

  releaseSettlement()
  await disposal
  await settle()

  const sourceSettlements = harness.commandSettlements.filter(entry => entry.sessionId === source.id)
  assert.deepEqual(sourceSettlements.map(entry => entry.phase), ['run', 'done'],
    'the executor must still settle the source command')
  assert.equal(sourceSettlements.at(-1)?.ownerLive, true,
    'teardown must not detach the source Session before its own command/done')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length, 1,
    'teardown must retire the source owner exactly once')
  // Exactly-once shutdown cancel across BOTH owners of an in-flight `/fork`.
  // The source was the CURRENT owner when the shutdown pre-cancelled it, so its
  // own retirement cancel phase must be a no-op; the child — which the teardown
  // parks because `cleanedUp` was already set — is cancelled once by the
  // parked-owner retirement. A second cancel on either owner is the ordering
  // that can land after the root teardown unregistered the inbox projection.
  assert.equal(harness.retirementEvents.filter(event => event === `cancel:${source.id}`).length, 1,
    'teardown must cancel the fork source owner exactly once')
  const forkedChild = harness.createdSessions.at(-1)
  assert.ok(forkedChild, 'the in-flight /fork must have created its child Session')
  assert.equal(harness.retirementEvents.filter(event => event === `cancel:${forkedChild.id}`).length, 1,
    'teardown must cancel the parked fork child exactly once')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${forkedChild.id}`).length, 1,
    'teardown must retire the parked fork child exactly once')
})

test('a rewind-picker fork awaits source retirement before its handoff completes', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-retirement-')
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

  let releaseDrain!: () => void
  let signalDrainReached!: () => void
  const drainReached = new Promise<void>(resolve => { signalDrainReached = resolve })
  const source = fakeSession({
    id: 'rewind-retirement-source',
    header: { id: 'rewind-retirement-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      event('user/message', {
        id: MessageId('rewind-retirement-one'),
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
        source: { kind: 'user' },
      } as never, 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      event('user/message', {
        id: MessageId('rewind-retirement-two'),
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
        source: { kind: 'user' },
      } as never, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  // Gate the retirement's drain phase: the source owner must not be observable
  // as retired (nor the handoff reported complete) until teardown finishes. The
  // gate is ONE-SHOT — the teardown retirement's own drain call must pass
  // through, or the disposer would block forever.
  let drainCalls = 0
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback' }, undefined, undefined, () => ({
    drainContinuableDescendants: async () => {
      drainCalls += 1
      if (drainCalls !== 1) return
      signalDrainReached()
      await new Promise<void>(resolve => { releaseDrain = resolve })
    },
    listDescendants: async () => [],
  }))
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  const reachedDrain = await Promise.race([
    drainReached.then(() => true),
    new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 3_000) }),
  ])
  try {
    assert.equal(reachedDrain, true, 'the picker fork must reach the source-retirement drain phase')
    // Give a DETACHED handoff every chance to finish: if the picker path did not
    // await the retirement, `forkSession` would resolve here and report success.
    await settle()
    // A DSH command defers its source retirement; the picker path must NOT: the
    // handoff cannot report success (nor dispose the source) while the old owner
    // is still retiring — otherwise an immediate /resume could observe a live,
    // lease-held source.
    assert.ok(!probe.notices.some(notice => notice.includes('rewound to turn')),
      `the rewind handoff must wait for source retirement: ${probe.notices.join(', ')}`)
    assert.equal(harness.retirementEvents.filter(entry => entry === `dispose:${source.id}`).length, 0,
      'the source must not be disposed while its retirement is still draining')
  } finally {
    // Always release the gate so a failing assertion still leaves a clean
    // teardown (the disposer awaits this retirement).
    releaseDrain?.()
    await settle()
  }
  assert.ok(probe.notices.some(notice => notice.includes('rewound to turn')),
    `the picker fork must still report success: ${probe.notices.join(', ')}`)
  assert.equal(harness.retirementEvents.filter(entry => entry === `dispose:${source.id}`).length, 1,
    'the source owner must be retired exactly once')
})

test('/fork settles when the source disposal fails (contained, never a hang)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-dispose-fail-')
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

  const source = fakeSession({
    id: 'fork-dispose-fail-source',
    header: { id: 'fork-dispose-fail-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const harness = makeHarness(home, source)
  // A failing `dispose()` leaks the handle (the write lease stays held), which
  // `retireDirectOwnedSession` CONTAINS and records. The admission pin must
  // still settle, or the command workflow (which awaits the retirement) would
  // hang forever.
  harness.disposeFailures.add(source.id)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.equal(harness.createdSessions.length, 1, 'the fork must settle even when the source disposal fails')
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'the source disposal must be attempted (and its failure contained)')
  const sourceSettlements = harness.commandSettlements.filter(entry => entry.sessionId === source.id)
  assert.deepEqual(sourceSettlements.map(entry => entry.phase), ['run', 'done'],
    'the source command must still settle after a contained dispose failure')
})

test('/fork does not release the submit FIFO before the source retirement completes', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-fifo-retire-')
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

  const header = (id: string) => ({ id, cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION })
  const source = fakeSession({ id: 'fifo-retire-source', header: header('fifo-retire-source'), events: sessionEvents('source answer') })
  const other = fakeSession({ id: 'fifo-retire-other', header: header('fifo-retire-other'), events: sessionEvents('other answer') })
  let releaseDrain!: () => void
  let signalDrainReached!: () => void
  const drainReached = new Promise<void>(resolve => { signalDrainReached = resolve })
  let drainCalls = 0
  const harness = makeHarness(home, [source, other], undefined, undefined, undefined, () => ({
    drainContinuableDescendants: async () => {
      drainCalls += 1
      if (drainCalls !== 1) return
      signalDrainReached()
      await new Promise<void>(resolve => { releaseDrain = resolve })
    },
    listDescendants: async () => [],
  }))
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  const reached = await Promise.race([
    drainReached.then(() => true),
    new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 3_000) }),
  ])
  try {
    assert.equal(reached, true, 'the /fork source retirement must reach its drain phase')
    const runsWhileGated = harness.commandSettlements.filter(entry => entry.phase === 'run').length
    // Durability is already satisfied: command/done landed before the drain gate.
    assert.deepEqual(harness.commandSettlements.filter(entry => entry.sessionId === source.id).map(entry => entry.phase), ['run', 'done'],
      'command/done must land before the source retirement completes')
    // The command must NOT have released the submit FIFO yet: a queued second
    // submission must stay pending until the retirement finishes.
    app.setDraft(`/resume ${other.id}`)
    ;(app as unknown as { submitDraft(): void }).submitDraft()
    await settle()
    assert.equal(harness.commandSettlements.filter(entry => entry.phase === 'run').length, runsWhileGated,
      'the submit FIFO must stay held until the source retirement completes')
  } finally {
    releaseDrain?.()
    await settle()
  }
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'the source must be disposed once the held retirement completes')
})

test('/fork dispatches at admission without waiting for a busy source', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-busy-')
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

  let releaseCreate!: () => void
  let signalCreateStarted!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const source = fakeSession({
    id: 'fork-busy-source',
    header: { id: 'fork-busy-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('busy source answer'),
  })
  let sourceBusy = false
  let releaseSourceIdle!: () => void
  const sourceIdleGate = async (sessionId: string): Promise<void> => {
    if (sessionId === source.id && sourceBusy) {
      await new Promise<void>(resolve => { releaseSourceIdle = resolve })
    }
  }
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback' }, undefined, createGate, undefined, sourceIdleGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  await settle()
  await new Promise(resolve => setTimeout(resolve, 70))
  const idleBeforeFork = harness.retirementEvents.filter(event => event === `idle:${source.id}`).length
  sourceBusy = true
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')

  const forkPromise = forkHandler()
  await createStarted
  assert.equal(harness.retirementEvents.filter(event => event === `idle:${source.id}`).length, idleBeforeFork,
    'fork dispatch must not wait for the source Agent to become idle')
  releaseCreate()
  sourceBusy = false
  releaseSourceIdle?.()
  await forkPromise
  await settle()
  assert.equal(harness.createdSessions.length, 1)
})

test('/fork navigation supersession parks a Direct child for later claim', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-superseded-')
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

  let releaseCreate!: () => void
  let signalCreateStarted!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const source = fakeSession({
    id: 'fork-superseded-source',
    header: { id: 'fork-superseded-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const target = fakeSession({
    id: 'fork-superseded-target',
    header: { id: 'fork-superseded-target', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  assert.ok(resumeHandler, 'the real runner must register /resume')

  const forkPromise = forkHandler()
  await createStarted
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown
  await resume({ rawInput: target.id })
  await settle()
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'a newer navigation must commit without waiting for the pending Host fork')

  releaseCreate()
  await forkPromise
  await settle()
  const child = harness.createdSessions[0]
  assert.ok(child, 'the pending fork must still publish its child')
  assert.equal(harness.createdSessions.length, 1)

  const resumesBeforeClaim = harness.resumeSignals.length
  await resume({ rawInput: child.id })
  await settle()
  assert.equal(harness.resumeSignals.length, resumesBeforeClaim,
    'opening a parked child must claim its existing Direct owner, not resume a second writer')
  const mountedFiber = fiber
  assert.ok(mountedFiber)
  await mountedFiber.dispose()
  fiber = undefined
  await settle()
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${child.id}`).length, 1,
    'claiming a parked child must leave exactly one teardown owner')
})

test('/fork retires an unclaimed parked Direct owner during teardown', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-parked-teardown-')
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

  let signalCreateStarted!: () => void
  let releaseCreate!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const source = fakeSession({
    id: 'fork-parked-teardown-source',
    header: { id: 'fork-parked-teardown-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const target = fakeSession({
    id: 'fork-parked-teardown-target',
    header: { id: 'fork-parked-teardown-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  assert.ok(resumeHandler, 'the real runner must register /resume')

  const forkPromise = forkHandler()
  await createStarted
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  const mountedFiber = fiber
  assert.ok(mountedFiber)
  const teardown = mountedFiber.dispose()
  releaseCreate()
  await Promise.all([forkPromise, teardown])
  fiber = undefined
  await settle()

  const child = harness.createdSessions[0]
  assert.ok(child, 'the superseded fork must publish before teardown drains its parked owner')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${child.id}`).length, 1,
    'an unclaimed parked Direct owner must be disposed exactly once during teardown')
})

test("an unclaimed parked owner's flush failure still warns the user (merged retirement durability)", async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-parked-flush-warn-')
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

  let signalCreateStarted!: () => void
  let releaseCreate!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const source = fakeSession({
    id: 'fork-parked-flush-source',
    header: { id: 'fork-parked-flush-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const target = fakeSession({
    id: 'fork-parked-flush-target',
    header: { id: 'fork-parked-flush-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  // The CURRENT owner's retirement stays CLEAN; only the parked fork child's
  // final flush fails. That durability failure must still reach the user, which
  // requires the runner to report the MERGED (current + parked) report. The
  // predicate is timing-independent: the fork child is the only session that is
  // neither the source nor the resumed target.
  ;(harness.sessions as { flush: (session?: unknown) => Promise<unknown> }).flush = async (session?: unknown) => {
    const id = (session as { id?: string } | undefined)?.id
    if (id !== undefined && id !== source.id && id !== target.id) throw new Error('disk full')
  }
  const stderrWrites: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  life.defer(() => { process.stderr.write = originalWrite })

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  assert.ok(resumeHandler, 'the real runner must register /resume')

  const forkPromise = forkHandler()
  await createStarted
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  const mountedFiber = fiber
  assert.ok(mountedFiber)
  const teardown = mountedFiber.dispose()
  releaseCreate()
  await settle()
  const child = harness.createdSessions.at(-1)
  assert.ok(child, 'the superseded fork must publish a child before teardown drains it')
  await Promise.all([forkPromise, teardown])
  fiber = undefined
  await settle()
  const output = stderrWrites.join('')
  assert.ok(output.includes('session flush failed during retirement'),
    `the parked owner's durability failure must reach the user: ${JSON.stringify(output)}`)
})

test('/fork suppresses a delayed failure after navigation supersession', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-failure-stale-')
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

  let signalCreateStarted!: () => void
  let releaseFailure!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const failure = new Promise<never>((_, reject) => { releaseFailure = () => reject(new Error('delayed fork failure')) })
  const createGate = async (): Promise<never> => {
    signalCreateStarted()
    return failure
  }
  const source = fakeSession({
    id: 'fork-failure-source',
    header: { id: 'fork-failure-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const target = fakeSession({
    id: 'fork-failure-target',
    header: { id: 'fork-failure-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  assert.ok(resumeHandler, 'the real runner must register /resume')

  const forkPromise = forkHandler()
  await createStarted
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  releaseFailure()
  await forkPromise
  await settle()

  assert.equal(harness.createdSessions.length, 0, 'a failed fork must not publish a child')
  assert.ok(!probe.notices.some(notice => notice.includes('delayed fork failure')),
    `a stale fork failure must not notify the newer session: ${probe.notices.join(', ')}`)
})

test('/rewind rejects an A to B to A stale picker selection', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-aba-')
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

  const userMessage = (id: string, text: string, seq: number): SessionEvent => event('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, seq)
  const source = fakeSession({
    id: 'rewind-aba-source',
    header: { id: 'rewind-aba-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      userMessage('rewind-aba-one', 'first', 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      userMessage('rewind-aba-two', 'second', 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  const target = fakeSession({
    id: 'rewind-aba-target',
    header: { id: 'rewind-aba-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  assert.ok(resumeHandler, 'the real runner must register /resume')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')

  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: source.id })
  await settle()
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()

  assert.equal(harness.createdSessions.length, 0, 'A → B → A must not revive the old A picker row into a fork')
  assert.ok(probe.notices.some(notice => notice.includes('rewind cancelled')),
    `the stale A picker selection must be cancelled: ${probe.notices.join(', ')}`)
})

test('/rewind stale callback cannot invalidate an admitted A fork', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-stale-admitted-fork-')
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

  let signalCreateStarted!: () => void
  let releaseCreate!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const userMessage = (id: string, text: string, seq: number): SessionEvent => event('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, seq)
  const source = fakeSession({
    id: 'rewind-stale-admitted-source',
    header: { id: 'rewind-stale-admitted-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      userMessage('rewind-stale-admitted-one', 'first', 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      userMessage('rewind-stale-admitted-two', 'second', 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  const target = fakeSession({
    id: 'rewind-stale-admitted-target',
    header: { id: 'rewind-stale-admitted-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  assert.ok(resumeHandler, 'the real runner must register /resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')

  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: source.id })
  await settle()

  const sourceDisposesBeforeFork = harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length
  const forkPromise = forkHandler()
  await createStarted
  // This is the old picker callback, now stale. It must return before
  // consuming the epoch admitted by the legitimate /fork above.
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()
  releaseCreate()
  await forkPromise
  await settle()

  assert.equal(harness.createdSessions.length, 1, 'the admitted /fork must still publish one child')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length, sourceDisposesBeforeFork + 1,
    'the admitted /fork must adopt and retire A rather than parking its child')
})

test('/rewind forwards the Host-owned fork anchor through the real picker callback', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-selection-')
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

  const currentSelection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const withHumanPrompt = (text: string): SessionEvent[] => {
    const turn = sessionEvents(text)
    return [
      turn[0]!,
      event('user/message', {
        id: MessageId(`rewind-${text}`),
        role: 'user',
        content: [{ type: 'text', text: `prompt ${text}` }],
        source: { kind: 'user' },
      } as never, 1),
      ...turn.slice(1),
    ]
  }
  const firstTurn = withHumanPrompt('first answer')
  // PR4 §4: the second span carries turn 1 — the REAL Host invariant the
  // official turnOutline projection (and the Direct compat fold) relies on:
  // turn numbers are host-assigned and monotone. The legacy fixture reused
  // turn 0 for both spans, which the old full-log fold happened to tolerate
  // but a whole-log outline correctly collapses.
  const secondTurn = withHumanPrompt('second answer').map(event => ({
    ...event,
    seq: event.seq + firstTurn.length,
    time: event.time + firstTurn.length * 1000,
    ...('turn' in (event.data as Record<string, unknown>)
      ? { data: { ...(event.data as Record<string, unknown>), turn: 1 } }
      : {}),
  })) as unknown as SessionEvent[]
  const sourceEvents = resequence([
    modelEvent('model/selection', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
    }, 1),
    ...firstTurn,
    ...secondTurn,
    // The current switch stands after the selected rewind cursor, so the
    // exact predecessor-turn cut must exclude it from the child.
    modelEvent('model/selection', currentSelection, firstTurn.length + secondTurn.length + 2),
  ])
  const source: FakeSession = fakeSession({
    id: 'rewind-selection-source',
    header: { id: 'rewind-selection-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sourceEvents,
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the real runner must mount a TUI for the rewind picker')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()

  const child = harness.createdSessions[0]!
  const inheritedPrefix = sourceEvents.slice(0, 2 + firstTurn.length)
  assert.deepEqual(harness.createInheritedEventCounts, [inheritedPrefix.length])
  assert.deepEqual(child.snapshotEvents().slice(0, inheritedPrefix.length), inheritedPrefix,
    'rewind keeps the exact historical prefix')
  assert.deepEqual(source.snapshotEvents(), sourceEvents, 'rewind does not mutate the source log')
  assert.equal((child.snapshotEvents()[inheritedPrefix.length] as unknown as { type?: unknown } | undefined)?.type,
    'session/end-seed',
    'the child-owned end-seed marker — never the source current-selection event — sits at the exact cut')
  const childSelections = child.snapshotEvents().filter(event => (event as unknown as { type?: unknown }).type === 'model/selection')
  assert.deepEqual((childSelections.at(-1) as unknown as { data?: unknown } | undefined)?.data, {
    provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
  }, 'rewind preserves the historical A selection')
})

test('/rewind surfaces a current Host fork rejection', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-rejection-')
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

  const userMessage = (id: string, text: string, seq: number): SessionEvent => event('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, seq)
  const source = fakeSession({
    id: 'rewind-rejection-source',
    header: { id: 'rewind-rejection-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: resequence([
      event('turn/start', { turn: 0 }, 0),
      userMessage('rewind-rejection-one', 'first prompt', 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      userMessage('rewind-rejection-two', 'second prompt', 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ]),
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback' }, undefined, async () => {
    throw new Error('fork refused by Host')
  })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()

  assert.equal(harness.createdSessions.length, 0, 'a rejected Host fork must not publish a child')
  assert.ok(probe.notices.some(notice => notice.includes('fork refused by Host')),
    `the current rewind failure must remain visible: ${probe.notices.join(', ')}`)
})

test('/fork inherits the source-only reasoning-effort change standing inside the completed prefix', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-selection-effort-')
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

  const currentSelection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const sourceEvents = resequence([
    modelEvent('model/selection', { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' } },
    }, 1),
    ...sessionEvents('source answer'),
    modelEvent('model/selection', currentSelection, 6),
  ])
  const source: FakeSession = fakeSession({
    id: 'fork-selection-effort-source',
    header: { id: 'fork-selection-effort-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sourceEvents,
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await forkHandler()
  await settle()

  const child = harness.createdSessions[0]!
  assert.deepEqual(harness.createInheritedEventCounts, [9],
    'the alpha.2 completed prefix extends through the trailing source-only effort change')
  assert.equal((child.snapshotEvents()[9] as unknown as { type?: unknown } | undefined)?.type, 'session/end-seed',
    'the child-owned end-seed marker sits at the inherited cut')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).lastUsed, {
    provider: 'provider-b', model: 'model-b', reasoningEffort: 'high',
  }, 'the child preserves the historical reasoning effort as the consumed selection')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).pending, currentSelection,
    'the source-only effort change stays a pending intent inside the child prefix')
})

test('/fork avoids a duplicate selection when the inherited prefix already matches', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-selection-same-')
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

  const selection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const source: FakeSession = fakeSession({
    id: 'fork-selection-same-source',
    header: { id: 'fork-selection-same-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: resequence([
      modelEvent('model/selection', selection, 0),
      modelEvent('request/header', { header: { config: selection } }, 1),
      ...sessionEvents('source answer'),
    ]),
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await forkHandler()
  await settle()

  const childSelections = harness.createdSessions[0]!.snapshotEvents().filter(event => (event as unknown as { type?: unknown }).type === 'model/selection')
  assert.deepEqual(childSelections.map(event => (event as unknown as { data: unknown }).data), [selection],
    'matching inherited state must not append a redundant child selection')
})
