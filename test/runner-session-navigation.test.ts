/** Runner-level regression coverage for Session navigation/adoption:
 * /fork, /rewind, /new transition ownership, fork source retirement ordering,
 * command settlement, navigation supersession, parked Direct child ownership,
 * stale-callback fencing, and Host-owned fork anchors. */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldPendingModelSelection } from '../src/domain/session/model-selection.ts'
import {
  disposeContext,
  event,
  fakeSession,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
  type RunnerHarness,
} from './support/runner-harness.ts'
import { installProbe, liveAgentOf, modelEvent } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import type { TspPane, TspWireFrame } from './support/tsp-terminal-fixture.ts'
import { ownTspBoot, waitUntil, type OwnedTspRunner } from './support/tsp-runner-harness.ts'

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

  let releaseDrain: (() => void) | undefined
  let signalDrainReached!: () => void
  const drainReached = new Promise<void>(resolve => { signalDrainReached = resolve })
  // The held gate MUST have a fallback release: any failing assertion (or a
  // timeout) would otherwise leave the drain parked and hang the teardown.
  life.defer(() => { releaseDrain?.() })
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

test('PR5 R7-4 positive control: a rewind LOAD failure whose picker identity is still current is shown', async (t) => {
  // §3C-4: a throw from the PRE-ADMISSION region (here the `loadThrough` read)
  // belongs to the picker identity, and while that identity is current the
  // failure must be reported truthfully.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-load-ok-')
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
    id: 'rewind-load-ok',
    header: { id: 'rewind-load-ok', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      event('user/message', { id: MessageId('load-ok-1'), role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } } as never, 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      event('user/message', { id: MessageId('load-ok-2'), role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } } as never, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TuiApp for the rewind picker')
  // The picker is OPEN (its outline already read). Now the SELECTION's detail
  // read fails: the §3C-4 pre-admission throw path.
  const original = source.snapshotEvents
  life.defer(() => { source.snapshotEvents = original })
  source.snapshotEvents = () => { throw new Error('rewind load failed (fixture)') }
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\x1b[B')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    return predicate()
  }
  assert.equal(await until(() => probe.notices.some(notice => notice.includes('rewind load failed (fixture)')), 8_000), true,
    `a current pre-admission load failure must be shown: ${probe.notices.join(', ')}`)
})

test('PR5 R6-5: a rewind settling after an EXTERNAL navigation never notifies the replacement surface (mounted stale negative)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-stale-')
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

  // TWO persisted sessions: the rewind SOURCE and an independent switch
  // target B (a distinct full-id match for the /resume direct path).
  const source = fakeSession({
    id: 'rewind-stale-source',
    header: { id: 'rewind-stale-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      event('user/message', {
        id: MessageId('rewind-stale-one'),
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
        source: { kind: 'user' },
      } as never, 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      event('user/message', {
        id: MessageId('rewind-stale-two'),
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
        source: { kind: 'user' },
      } as never, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  const targetB = fakeSession({
    id: 'rewind-stale-target-b',
    header: { id: 'rewind-stale-target-b', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      event('user/message', {
        id: MessageId('rewind-stale-b-one'),
        role: 'user',
        content: [{ type: 'text', text: 'session b content' }],
        source: { kind: 'user' },
      } as never, 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
    ],
  })

  let releaseDrain: (() => void) | undefined
  let signalDrainReached!: () => void
  const drainReached = new Promise<void>(resolve => { signalDrainReached = resolve })
  // The held drain MUST have a fallback release: any failing assertion above the
  // in-body release would otherwise leave the gate parked and turn a plain
  // failure into a teardown HANG (the harness's own cleanup, registered earlier,
  // awaits the parked execution first — a later after-hook is too late).
  life.defer(() => { releaseDrain?.() })
  let drainCalls = 0
  const harness = makeHarness(home, [source, targetB], { provider: 'global', model: 'fallback' }, undefined, undefined, () => ({
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

  // Start the rewind: the real /rewind opens the picker; Enter selects the
  // older turn. The fork adopts, and the source-retirement drain PARKS —
  // the adoption commit has happened (the identity was minted) but the
  // final settlement has NOT.
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TuiApp for the rewind picker')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\x1b[B')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  const reachedDrain = await Promise.race([
    drainReached.then(() => true),
    new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 5_000) }),
  ])
  assert.equal(reachedDrain, true, 'the rewind fork must reach (and park in) the source-retirement drain phase after the adoption commit')

  // ── The EXTERNAL NAVIGATION inside the parked window ─────────────────────
  // A REAL `/resume <B>` submit through the mounted editor. The navigation
  // epoch advances SYNCHRONOUSLY at the entry (`switchSession` bumps BEFORE it
  // enters the transition gate), while the switch itself queues behind the
  // rewind's held gate. That is the production entry the stale fence exists for
  // — and because the drain is still parked, the rewind's own settlement cannot
  // have run yet.
  const submit = app as unknown as { setDraft(text: string): void; submitDraft(): void }
  submit.setDraft('/resume rewind-stale-target-b')
  submit.submitDraft()
  // Give the submitted /resume its bounded chance to reach `switchSession`
  // INSIDE the parked window: the picker resolves the direct-match listing
  // asynchronously, and only then does the synchronous pre-gate
  // `bumpNavigationEpoch()` run. (The switch itself cannot commit yet — it
  // queues behind the rewind's held gate.) This wait only PLACES the external
  // navigation inside the window; it is never the evidence — the post-release
  // facts below fail loudly if the navigation did not make it there.
  const deadline = Date.now() + 700
  while (Date.now() < deadline && !probe.notices.some(notice => notice.includes('rewound to turn'))) {
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }

  // Release the drain: the old rewind's post-commit tail runs, and its
  // settlement publishes (or is fenced) now.
  releaseDrain?.()

  // POSITIVE liveness facts BEFORE the negative assertion, so "no toast" can
  // never be satisfied vacuously by an operation that never got there:
  //  (a) the rewind's settlement really reached its end — its source owner was
  //      retired exactly once (the post-commit tail's own effect);
  //  (b) the external navigation really executed — B's authoritative switch
  //      ran (it was queued behind the same gate, so this completes here too).
  const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    return predicate()
  }
  assert.equal(await until(() =>
    harness.retirementEvents.filter(entry => entry === `dispose:${source.id}`).length === 1, 10_000), true,
    'the rewind settlement really ran: its source owner was retired EXACTLY once')
  // `resumeSessionIds` only records that `agents.resume` was ENTERED (the fake
  // pushes before the handle/setup/return, and even before a resumeError throw),
  // so it cannot prove the switch. B's authoritative appearance is its
  // transcript: the surface installs it only once the switch really committed.
  assert.equal(await until(() =>
    (probe.capturedMessages ?? []).some(row => JSON.stringify(row).includes('session b content')), 10_000), true,
    'the external /resume really switched the surface to B (its transcript is installed)')
  await settle()

  // The paired positive control is the sibling test above ("a rewind-picker fork
  // awaits source retirement before its handoff completes"): the SAME park with
  // NO external navigation DOES publish "rewound to turn N". Together the two
  // prove the toast is suppressed by the superseded operation-owned identity,
  // not by the settlement never happening.
    assert.ok(!probe.notices.some(notice => notice.includes('rewound to turn')),
    `the stale rewind settlement must not notify the replacement surface: ${probe.notices.join(', ')}`)
})


test('PR5 R6-5: a cancellation detected at N+2 is suppressed once navigation advances to N+3 (consumer-level fence)', async (t) => {
  // The structured-error contract: the error's OWN notificationNavigation
  // (the live identity at detection) decides publishability. This locks the
  // consumer gate directly — the mounted A→B→A positive (above) proves the
  // N+2-still-current case; this sibling proves the N+3 advance suppresses.
  const published: string[] = []
  let live: { sessionId: string | undefined; navigationEpoch: number } = { sessionId: 'a', navigationEpoch: 2 }
  const isCurrent = (identity: { sessionId: string | undefined; navigationEpoch: number }): boolean =>
    identity.sessionId === live.sessionId && identity.navigationEpoch === live.navigationEpoch
  // The presentation's error gate, verbatim semantics:
  //   fence = outcome.notificationNavigation ?? pickerIdentity
  //   if (!isNavigationCurrent(fence)) return
  //   notify(...)
  const settleError = (outcome: { notificationNavigation?: typeof live; text: string }): void => {
    const fence = outcome.notificationNavigation ?? { sessionId: 'a', navigationEpoch: 0 }
    if (!isCurrent(fence)) return
    published.push(outcome.text)
  }
  // The cancellation detected at A/N+2 (what forkSession returns for the
  // A→B→A stale picker), and the refusal detected inside the claim.
  const cancellationAt2 = { text: 'session changed — rewind cancelled', notificationNavigation: { sessionId: 'a', navigationEpoch: 2 } }
  settleError(cancellationAt2)
  assert.deepEqual(published, ['session changed — rewind cancelled'],
    'the cancellation is publishable while A/N+2 is still current')
  // A later N+3 advance: the SAME cancellation outcome (had it settled
  // later) is suppressed.
  live = { sessionId: 'a', navigationEpoch: 3 }
  settleError(cancellationAt2)
  assert.deepEqual(published, ['session changed — rewind cancelled'],
    'the N+2 cancellation is suppressed once navigation advanced to N+3')

  // Case 2 of the four-case contract: an admitted Host REJECTION (fence =
  // the ADMISSION identity N+1) publishes while N+1 is current, and is
  // suppressed by a later N+2 advance.
  const rejectAtClaim = { text: 'fork refused by Host (gateway/internal)', notificationNavigation: { sessionId: 'a', navigationEpoch: 1 } }
  const publishedReject: string[] = []
  const settle = (outcome: { text: string; notificationNavigation: { sessionId: string; navigationEpoch: number } }): void => {
    if (!isCurrent(outcome.notificationNavigation)) return
    publishedReject.push(outcome.text)
  }
  live = { sessionId: 'a', navigationEpoch: 1 }
  settle(rejectAtClaim)
  assert.deepEqual(publishedReject, ['fork refused by Host (gateway/internal)'],
    'an admitted rejection publishes while its CLAIM identity is current')
  live = { sessionId: 'a', navigationEpoch: 2 }
  settle(rejectAtClaim)
  assert.deepEqual(publishedReject, ['fork refused by Host (gateway/internal)'],
    'the same rejection is suppressed after a later navigation advance (N+2)')
  void t
})

// ── PR3-B B3 (finding C): an answerable Question under a REAL transition ────
//
// These witnesses boot the REAL composition root (`mountRunner` →
// `applyRunner` → `startRunner`, TSP opt-in over the scripted pane) and drive
// the REAL registered `/new`, `/fork` and `/resume` commands: the
// `SessionTransitionGate`, the session core, the owner mapping and the owner
// retirement (cancel → idle → drain → flush → dispose) are the production
// ones, and so is every currentness read they drive.
//
// The HOST BACKEND behind them is the suite's existing one-sided stand-in
// (`test/support/runner-harness.ts`): `fakeSession` (the in-memory Session log +
// header) and `fakeAgent` (status/whenIdle/cancel/followup/steer, with the
// `whenIdleGate` busy window this section uses), driven through the fake
// `persistence` / `sessionQuery` / `agents` / `sessions` / `agentDefaultModel` /
// `llm` / `commands` services the composition root resolves. On top of that this
// section installs the official interaction plane (`userQuestions` +
// `sessionProjections`) through the same Cordis provide path. Nothing here
// substitutes a session id, an owner, a publication or a retirement fact: the
// assertions read the pane WIRE (the `layer`/`dock` ops the real renderer
// committed) and the harness's real retirement log.

/** One official question payload the witnesses ask. */
interface B3Question {
  readonly id: string
  readonly question: string
  readonly options?: readonly { readonly label: string }[]
}

/** The one-sided official Host plane (see the section comment). */
interface B3HostPlane {
  readonly services: { readonly userQuestions: unknown; readonly sessionProjections: unknown }
  /**
   * Deliver one LIVE official request through the official waterfall (the Agent
   * is the dispatch scope, exactly like `UserQuestionService.ask`) and return
   * the answer promise the Host's tool call awaits.
   */
  ask(agent: unknown, sessionId: string, callId: string, questions: readonly B3Question[], signal: AbortSignal): Promise<unknown>
  /** Seed one CONTINUED call into the durable projection (the cold shape). */
  seedContinued(sessionId: string, callId: string, questions: readonly B3Question[]): void
  /** Fire the projection change subscription for one unit. */
  changed(sessionId: string, key: 'userQuestions' | 'inbox'): void
  /** The late answers the Host's own sink accepted. */
  readonly answers: readonly { readonly callId: string; readonly answer: unknown }[]
  /**
   * Every official projection read the port performed, by session id and unit
   * (external review P2-C): the commit-time withdrawal must produce NONE.
   */
  readonly projectionReads: readonly { readonly id: string; readonly key: string }[]
  /** Arm a THROW for one session id's projection reads (the commit-window probe). */
  failProjectionFor: string | undefined
  /** How many armed reads actually fired (must stay 0 for a state-only commit). */
  readonly projectionFailures: { value: number }
}

function b3HostPlane(
  waterfall: (agent: unknown, name: string, payload: unknown, fallback: () => Promise<unknown>) => Promise<unknown>,
): B3HostPlane {
  const states = new Map<string, { questions: { active: unknown[]; settled: unknown[] } }>()
  const callSessions = new Map<string, string>()
  const listeners = new Set<(session: unknown, key: string) => void>()
  const answers: { callId: string; answer: unknown }[] = []
  const projectionReads: { id: string; key: string }[] = []
  const projectionFailures = { value: 0 }
  const stateOf = (sessionId: string): { questions: { active: unknown[]; settled: unknown[] } } => {
    const existing = states.get(sessionId)
    if (existing !== undefined) return existing
    const created = { questions: { active: [] as unknown[], settled: [] as unknown[] } }
    states.set(sessionId, created)
    return created
  }
  const plane: B3HostPlane = {
    services: {
      userQuestions: {
        // These witnesses never claim a timed wait (the B3 L6 F6.1 suite owns
        // the claim/countdown semantics): a silent no-op here would fabricate a
        // Host wait, so the call fails loudly instead.
        attachWait: () => { throw new Error('the B3 navigation Host plane never claims a timed wait') },
        answer: (_agent: unknown, callId: string, answer: unknown) => {
          answers.push({ callId, answer })
          const sessionId = callSessions.get(callId)
          if (sessionId !== undefined) {
            stateOf(sessionId).questions.settled.push({
              callId,
              answers: (answer as { readonly answers: unknown }).answers,
            })
          }
          return true
        },
      },
      sessionProjections: {
        stateOf: (session: unknown, key: string) => {
          const id = (session as { readonly id?: unknown } | undefined)?.id
          if (typeof id !== 'string') return undefined
          projectionReads.push({ id, key })
          if (plane.failProjectionFor === id) {
            projectionFailures.value += 1
            throw new Error(`the armed projection read fired for ${id}`)
          }
          // The Inbox unit carries no queued `user-question-reply` in these
          // witnesses: the queued-reply fact has its own L6 coverage.
          if (key === 'inbox') return { 'next-step': [], 'next-turn': [] }
          if (key !== 'userQuestions') return undefined
          return stateOf(id)
        },
        onChanged: (listener: (session: unknown, key: string) => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    ask(agent, sessionId, callId, questions, signal) {
      callSessions.set(callId, sessionId)
      return waterfall(agent, 'user-questions/request', {
        agent,
        wait: { callId, timed: false },
        questions,
        signal,
      }, () => Promise.reject(new Error('no user-questions answerer accepted the request')))
    },
    seedContinued(sessionId, callId, questions) {
      callSessions.set(callId, sessionId)
      stateOf(sessionId).questions.active.push({ callId, questions, state: 'continued' })
    },
    changed(sessionId, key) {
      for (const listener of [...listeners]) listener({ id: sessionId }, key)
    },
    answers,
    projectionReads,
    failProjectionFor: undefined,
    projectionFailures,
  }
  return plane
}

/** The Cordis plane as the official `provide`/`emit` surface. */
function ctxOf(context: Context): B3CordisPlane & { provide(name: string, value: unknown): void } {
  return context as unknown as B3CordisPlane & { provide(name: string, value: unknown): void }
}

/** The Cordis plane the witnesses drive (the official event/waterfall API). */
interface B3CordisPlane {
  emit(name: string, ...args: unknown[]): void
  waterfall(agent: unknown, name: string, payload: unknown, fallback: () => Promise<unknown>): Promise<unknown>
  /**
   * Register one official waterfall listener. `prepend` puts it BEFORE the
   * registered answerers, which is how a witness models a legal upstream
   * middleware that awaits before calling `next`.
   */
  on(name: string, listener: (...args: unknown[]) => unknown, options?: { readonly prepend?: boolean }): unknown
}

/** Boot the REAL runner with the TSP opt-in plus the official Host plane. */
async function bootB3Tsp(options: {
  readonly life: import('./support/temp-lifecycle.ts').TestLifecycle
  readonly home: string
  /** The standing sessions the Direct harness owns. */
  readonly standing: FakeSession | readonly FakeSession[]
  /** The session the runner RESUMES at startup. */
  readonly resume: string
  /** The Direct Agent's busy window, per session (see `ownTspBoot`). */
  readonly idleGates?: Map<string, Promise<void>>
  /** The raw idle gate (see `ownTspBoot`); it wins over `idleGates` when given. */
  readonly whenIdleGate?: (sessionId: string) => Promise<void>
  /** The Host session-create gate (see `ownTspBoot`): the opening-window hold. */
  readonly createGate?: () => Promise<unknown>
}): Promise<{ owned: OwnedTspRunner; plane: B3HostPlane; harness: RunnerHarness; ctx: B3CordisPlane }> {
  let plane: B3HostPlane | undefined
  let cordis: B3CordisPlane | undefined
  const owned = await ownTspBoot({
    life: options.life,
    home: options.home,
    logFile: join(options.home, 'diag.log'),
    session: options.standing as never,
    resumeId: options.resume,
    ...options.whenIdleGate !== undefined
      ? { whenIdleGate: options.whenIdleGate }
      : options.idleGates === undefined
        ? {}
        : { whenIdleGate: (sessionId: string) => options.idleGates?.get(sessionId) ?? Promise.resolve() },
    ...options.createGate === undefined ? {} : { createGate: options.createGate },
    provide: rawCtx => {
      const ctx = rawCtx as unknown as B3CordisPlane
      cordis = ctx
      plane = b3HostPlane((agent, name, payload, fallback) => ctx.waterfall(agent, name, payload, fallback))
      rawCtx.provide('userQuestions', plane.services.userQuestions)
      rawCtx.provide('sessionProjections', plane.services.sessionProjections)
    },
  })
  assert.ok(plane !== undefined && cordis !== undefined, 'the Host plane must be provided before the boot')
  return { owned, plane, harness: owned.harness as unknown as RunnerHarness, ctx: cordis }
}

/** The harness's REGISTERED command handler (the production command entry). */
function commandOf(owned: OwnedTspRunner, name: string): (...args: never[]) => unknown {
  const commands = (owned.harness as unknown as RunnerHarness).commands as {
    handler(name: string): ((...args: never[]) => unknown) | undefined
  }
  const handler = commands.handler(name)
  assert.ok(handler !== undefined, `the real runner must register /${name}`)
  return handler
}

/** The live `layer.modal-*` ids after replaying `frames` in order. */
function liveLayerModals(frames: readonly TspWireFrame[]): string[] {
  const live = new Set<string>()
  for (const frame of frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add' && /^layer\.modal-\d+$/u.test(op[1])) live.add(op[1])
      else if (op[0] === 'del' && /^layer\.modal-\d+$/u.test(op[1])) live.delete(op[1])
    }
  }
  return [...live]
}

/**
 * The live `layer.modal-*` ids at the FIRST frame that presents `text` (one
 * Session's own identity on the wire). `undefined` when that frame never came,
 * so a publication that never happened can never satisfy the assertion.
 */
function liveLayerModalsAt(frames: readonly TspWireFrame[], text: string): string[] | undefined {
  const live = new Set<string>()
  for (const frame of frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add' && /^layer\.modal-\d+$/u.test(op[1])) live.add(op[1])
      else if (op[0] === 'del' && /^layer\.modal-\d+$/u.test(op[1])) live.delete(op[1])
    }
    if (JSON.stringify(frame.ops).includes(text)) return [...live]
  }
  return undefined
}

/** Whether the pane's CURRENT frame owns the dock's continued-Question line. */
function attentionLineLive(frames: readonly TspWireFrame[]): boolean {
  let live = false
  for (const frame of frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add' && op[1] === 'dock.question-attention') live = true
      else if (op[0] === 'del' && op[1] === 'dock.question-attention') live = false
    }
  }
  return live
}

/** The Session ids whose welcome card the renderer has presented, in order. */
function presentedSessions(pane: TspPane): string[] {
  const presented: string[] = []
  for (const match of pane.output.text().matchAll(/DSH session ([^\s\\"]+)/gu)) {
    const id = match[1] as string
    if (presented.at(-1) !== id) presented.push(id)
  }
  return presented
}

/** The recorded outcome of one Host tool call (never a bare rejection). */
type B3RequestOutcome =
  | { readonly kind: 'answered'; readonly answer: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }

function outcomeOf(pending: Promise<unknown>): Promise<B3RequestOutcome> {
  return pending.then(
    answer => ({ kind: 'answered' as const, answer }),
    error => ({ kind: 'rejected' as const, error }),
  )
}

/** One live question payload the witnesses ask. */
const B3_QUESTION: readonly B3Question[] = [
  { id: 'q-c', question: 'Which target?', options: [{ label: 'alpha' }, { label: 'beta' }] },
]

test('B3 finding C (1): the real /new quiesce parks on a LIVE Question — A keeps the presentation until the user really answers', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-new-')
  const sessionA = fakeSession({
    id: 'b3-c-new-a',
    header: { id: 'b3-c-new-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  // The Direct Agent's busy window is the HOST's own fact: an unanswered
  // question keeps the tool call open, so the Agent is not idle until that
  // request really settles. The test never releases the gate by hand.
  const idleGates = new Map<string, Promise<void>>()
  const releaseIdle = new Map<string, () => void>()
  const { owned, plane, harness } = await bootB3Tsp({ life, home, standing: sessionA, resume: sessionA.id, idleGates })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    idleGates.set(sessionA.id, new Promise<void>(resolve => { releaseIdle.set(sessionA.id, resolve) }))
    // A held gate always has a fallback release: a failure path must never park
    // the Agent's `whenIdle` on a promise nobody resolves.
    life.defer(() => { releaseIdle.get(sessionA.id)?.() })
    const abort = new AbortController()
    // The Host's own tool call: the busy gate ends with the request, and the
    // outcome is recorded (never a bare rejection that could mask a later
    // assertion failure as an unhandled rejection).
    const delivered = outcomeOf(plane.ask(
      liveAgentOf(harness, sessionA.id), sessionA.id, 'call-c-new', B3_QUESTION, abort.signal,
    ))
    void delivered.then(() => { releaseIdle.get(sessionA.id)?.() })
    await waitUntil('the live form on the pane', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    assert.ok(owned.pane.output.text().includes('Which target?'), 'the official question text is rendered')

    // The REAL /new. It is the registered command ENTRY, not a composer draft:
    // the modal seat owns every key while the question is live (the modal-first
    // contract), so the command plane is the production path to a transition.
    const transition = commandOf(owned, 'new')()
    await waitUntil('the pre-commit quiesce', () => harness.retirementEvents.includes(`idle:${sessionA.id}`), 15_000)
    await settle()

    assert.equal(harness.createdSessions.length, 0, 'the parked quiesce must not have created B')
    assert.deepEqual(
      harness.retirementEvents.filter(entry => entry === `cancel:${sessionA.id}` || entry === `dispose:${sessionA.id}`),
      [], 'A must not be retired while its Question is unanswered')
    assert.deepEqual(presentedSessions(owned.pane), [sessionA.id], 'A still owns the presented Session')
    assert.equal(liveLayerModals(owned.pane.frames()).length, 1, 'the live form still owns the modal seat')

    // The REAL answer on the pane resolves the ORIGINAL official sink ...
    owned.pane.key('\r')
    owned.pane.key('\r')
    assert.deepEqual(await delivered, { kind: 'answered', answer: { answers: [{ id: 'q-c', selected: ['alpha'] }] } },
      'the official producer observed the real answer')

    // ... which idles the Agent, so the SAME transition commits B and retires A.
    await transition
    await waitUntil('the /new child', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).at(-1) === sessionB, 15_000)
    assert.ok(harness.retirementEvents.includes(`cancel:${sessionA.id}`), 'the committed switch cancels A')
    assert.ok(harness.retirementEvents.includes(`dispose:${sessionA.id}`), 'the committed switch disposes A')
  } finally {
    await owned.settle()
  }
})

test('B3 finding C (2): the real /fork publication withdraws A\'s live modal while the Host cancellation is STILL in flight', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-fork-')
  const sessionA = fakeSession({
    id: 'b3-c-fork-a',
    header: { id: 'b3-c-fork-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const { owned, plane, harness } = await bootB3Tsp({ life, home, standing: sessionA, resume: sessionA.id })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    const abort = new AbortController()
    const aAgent = liveAgentOf(harness, sessionA.id) as { cancel: () => void }
    const originalCancel = aAgent.cancel
    // The official Agent cancel ENDS the in-flight tool call — but the Host's
    // cancellation is a real, asynchronous backend step: the Agent is cancelled
    // NOW while the request lifetime ends only when the cancellation COMPLETES.
    // The test holds that completion (never the abort itself), which is exactly
    // the window finding C is about: the presentation must already be gone.
    let completeCancellation: (() => void) | undefined
    const cancellationCompletion = new Promise<void>(resolve => { completeCancellation = resolve })
    let cancels = 0
    aAgent.cancel = () => {
      cancels += 1
      void cancellationCompletion.then(() => { abort.abort() })
      originalCancel.call(aAgent)
    }
    life.defer(() => { aAgent.cancel = originalCancel })
    // The held cancellation completion always has a fallback release: a failure
    // path must never leave the fake Host's cancel half-finished.
    life.defer(() => { completeCancellation?.() })
    let requestOutcome: B3RequestOutcome | undefined
    const delivered = outcomeOf(plane.ask(aAgent, sessionA.id, 'call-c-fork', B3_QUESTION, abort.signal))
    void delivered.then(outcome => { requestOutcome = outcome })
    await waitUntil('the live form on the pane', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    const aModal = liveLayerModals(owned.pane.frames())[0]

    const fork = commandOf(owned, 'fork')()
    await waitUntil('the fork child', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).includes(sessionB), 15_000)

    // THE finding-C contract: B's OWN publication frame must not present A's
    // modal — and it must not be the Host cancellation that removed it.
    assert.deepEqual(liveLayerModalsAt(owned.pane.frames(), `DSH session ${sessionB}`), [],
      'B\'s publication frame must not present the replaced subject\'s modal')
    assert.equal(requestOutcome, undefined,
      'A\'s Host request is still in flight: the withdrawal is presentation-only, never a fabricated settlement')

    // The REAL post-`command/done` source retirement ends the request as the
    // official Host abort — exactly once, never a user cancel.
    await fork
    await waitUntil('A retirement', () => harness.retirementEvents.includes(`dispose:${sessionA.id}`), 15_000)
    assert.equal(cancels, 1, 'the replaced owner is cancelled exactly once by the real retirement')
    assert.equal(requestOutcome, undefined, 'the held cancellation has not completed yet, so the request still stands')
    completeCancellation!()
    const outcome = await delivered
    assert.equal(outcome.kind, 'rejected', 'the retired request must never resolve with answers')
    assert.equal((outcome as { readonly error?: { readonly code?: unknown } }).error?.code, 'ASK_ABORTED',
      'the completed Host cancellation classifies the request ASK_ABORTED')

    // A Question that arrives for the replacement subject gets a FRESH seat
    // identity and answers into ITS OWN request.
    const bAbort = new AbortController()
    const bDelivered = outcomeOf(plane.ask(liveAgentOf(harness, sessionB), sessionB, 'call-c-b',
      [{ id: 'q-b', question: 'B target?', options: [{ label: 'yes' }] }], bAbort.signal))
    await waitUntil('B\'s own form', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    const bModal = liveLayerModals(owned.pane.frames())[0]
    assert.notEqual(bModal, aModal, 'the replacement subject gets a fresh seat identity')
    assert.ok(owned.pane.output.text().includes('B target?'), 'B\'s own question is presented')
    owned.pane.key('\r')
    owned.pane.key('\r')
    assert.deepEqual(await bDelivered, { kind: 'answered', answer: { answers: [{ id: 'q-b', selected: ['yes'] }] } },
      'the replacement subject\'s request settles with its own answer')
    await waitUntil('the answered modal leaves the seat', () => liveLayerModals(owned.pane.frames()).length === 0, 15_000)
  } finally {
    await owned.settle()
  }
})

test('B3 finding C (3): a real publication withdraws a MOUNTED continued form and re-scopes its attention', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-switch-')
  const sessionA = fakeSession({
    id: 'b3-c-switch-a',
    header: { id: 'b3-c-switch-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const { owned, plane, harness, ctx } = await bootB3Tsp({ life, home, standing: sessionA, resume: sessionA.id })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    // The Host's durable projection lists one CONTINUED call for A, and a REAL
    // routed event re-derives reachability (the production trigger).
    plane.seedContinued(sessionA.id, 'call-c-switch',
      [{ id: 'q-switch', question: 'Late answer?', options: [{ label: 'yes' }, { label: 'no' }] }])
    ctx.emit('session/event', sessionA, event('model/selection', { provider: 'p', model: 'm' }, sessionA.snapshotEvents().length))
    await waitUntil('the parked count', () => attentionLineLive(owned.pane.frames()), 15_000)
    assert.ok(owned.pane.output.text().includes('Continued questions: 1 · Alt+Q'), 'the dock presents the parked count')
    assert.deepEqual(liveLayerModals(owned.pane.frames()), [], 'a cold discovery mounts no form')

    // Alt+Q (the real CSI-u sequence the pane sends) → the transient list →
    // Enter reopens the SAME logical call through the controller's own recheck.
    owned.pane.key('\u001b[113;3u')
    await waitUntil('the continued list', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    const listModal = liveLayerModals(owned.pane.frames())[0]
    owned.pane.key('\r')
    await waitUntil('the mounted late-answer form', () => {
      const live = liveLayerModals(owned.pane.frames())
      return live.length === 1 && live[0] !== listModal
    }, 15_000)
    const aModal = liveLayerModals(owned.pane.frames())[0]
    assert.ok(owned.pane.output.text().includes('Late answer?'), 'the official continued question is on the form')

    // The REAL publication of a replacement Session. The TSP renderer has no
    // session picker in this build (its `/sessions`/`/resume` overlay needs the
    // PiTui app), so the registered `/new` entry is the production switch path
    // the modal seat leaves free — the composer is fenced while the form is up.
    const transition = commandOf(owned, 'new')()
    await waitUntil('the replacement Session', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).includes(sessionB), 15_000)
    assert.deepEqual(liveLayerModalsAt(owned.pane.frames(), `DSH session ${sessionB}`), [],
      'the replacement publication frame must not present the continued form')
    assert.equal(attentionLineLive(owned.pane.frames()), false,
      'the replaced subject\'s parked count leaves the dock with its form')
    // The official side is untouched: the local model was dropped, the Host's
    // call stays answerable, and no answer was dispatched for the replacement.
    assert.deepEqual(plane.answers, [], 'a session switch never dispatches an official answer')
    await transition
    await waitUntil('A retirement', () => harness.retirementEvents.includes(`dispose:${sessionA.id}`), 15_000)
    assert.notEqual(aModal, undefined, 'the withdrawn form owned the seat before the switch')
  } finally {
    await owned.settle()
  }
})

test('B3 finding C (4): switching away and BACK restores the continued entry from the official projection', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-return-')
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
  const sessionA = fakeSession({
    id: 'b3-c-return-a',
    header: { id: 'b3-c-return-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const sessionB = fakeSession({
    id: 'b3-c-return-b',
    header: { id: 'b3-c-return-b', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('session b content'),
  })
  const harness = makeHarness(home, [sessionA, sessionB])
  context = new Context()
  const plane = b3HostPlane((agent, name, payload, fallback) => ctxOf(context!).waterfall(agent, name, payload, fallback))
  ctxOf(context).provide?.('userQuestions', plane.services.userQuestions)
  ctxOf(context).provide?.('sessionProjections', plane.services.sessionProjections)
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  await settle()

  // The TSP renderer has no session picker in this build, so the ordinary
  // switch/return half of finding C runs on the PiTui mount — the renderer whose
  // `/resume` picker IS production-complete. The withdrawn form half is proven on
  // the TSP pane by witness (3); this witness proves the OTHER half: the entry is
  // dropped on the way out and RESTORED from the official projection on return.
  plane.seedContinued(sessionA.id, 'call-c-return',
    [{ id: 'q-return', question: 'Late answer?', options: [{ label: 'yes' }, { label: 'no' }] }])
  ctxOf(context).emit('session/event', sessionA, event('model/selection', { provider: 'p', model: 'm' }, sessionA.snapshotEvents().length))
  await waitUntil('the parked count', () => probe.capturedQuestionAttention.at(-1) === 1, 15_000)

  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TuiApp')
  const submit = app as unknown as { setDraft(text: string): void; submitDraft(): void }
  const shown = (): string => JSON.stringify(probe.capturedMessages ?? [])
  submit.setDraft(`/resume ${sessionB.id}`)
  submit.submitDraft()
  await waitUntil('B switched in', () => shown().includes('session b content'), 15_000)
  assert.equal(probe.capturedQuestionAttention.at(-1), 0,
    'the replaced subject\'s parked entry leaves the presentation with it')
  assert.deepEqual(plane.answers, [], 'a session switch never dispatches an official answer')

  // Back to A: the OFFICIAL projection is the restore source (a fresh parked
  // entry), never a retained local form.
  submit.setDraft(`/resume ${sessionA.id}`)
  submit.submitDraft()
  await waitUntil('A switched back', () => shown().includes('A standing state') && !shown().includes('session b content'), 15_000)
  await waitUntil('the restored parked count', () => probe.capturedQuestionAttention.at(-1) === 1, 15_000)
  assert.deepEqual(plane.answers, [], 'the restore dispatches no answer either')
})

test('B3 finding C/F6 (5): a real publication withdraws A\'s live APPROVAL prompt while its request is still in flight', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-approval-')
  const sessionA = fakeSession({
    id: 'b3-c-approval-a',
    header: { id: 'b3-c-approval-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const { owned, harness, ctx } = await bootB3Tsp({ life, home, standing: sessionA, resume: sessionA.id })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    const aAgent = liveAgentOf(harness, sessionA.id) as { cancel: () => void }
    const originalCancel = aAgent.cancel
    // The official Agent cancel ends the in-flight approval request (its signal
    // aborts) — held here until the test completes it, exactly like the LIVE
    // Question witness: the withdrawal must not depend on this cancellation.
    let completeCancellation: (() => void) | undefined
    const cancellationCompletion = new Promise<void>(resolve => { completeCancellation = resolve })
    const approvalAbort = new AbortController()
    let cancels = 0
    aAgent.cancel = () => {
      cancels += 1
      void cancellationCompletion.then(() => { approvalAbort.abort() })
      originalCancel.call(aAgent)
    }
    life.defer(() => { aAgent.cancel = originalCancel })
    life.defer(() => { completeCancellation?.() })
    // The official approval waterfall (the Direct adapter derives the Session
    // identity from the request's OWN Agent, exactly like dsh's `ask`).
    let approvalOutcome: string | undefined
    void ctx.waterfall(
      aAgent,
      'approval/request',
      { agent: aAgent, callId: 'call-c-approval', toolName: 'bash', reason: 'C needs the shell', signal: approvalAbort.signal },
      () => Promise.resolve('unavailable'),
    ).then(
      value => { approvalOutcome = String(value) },
      (error: unknown) => { approvalOutcome = `rejected:${String(error)}` },
    )
    await waitUntil('the approval prompt', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    assert.ok(owned.pane.output.text().includes('C needs the shell'), 'the official approval reason is rendered')
    const aModal = liveLayerModals(owned.pane.frames())[0]

    const fork = commandOf(owned, 'fork')()
    await waitUntil('the fork child', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).includes(sessionB), 15_000)
    assert.deepEqual(liveLayerModalsAt(owned.pane.frames(), `DSH session ${sessionB}`), [],
      'B\'s publication frame must not present the replaced subject\'s approval prompt')
    assert.equal(approvalOutcome, undefined,
      'the approval request is still in flight: the withdrawal is presentation-only, never an implicit allow')

    // The REAL post-`command/done` retirement completes the Host cancellation.
    await fork
    await waitUntil('A retirement', () => harness.retirementEvents.includes(`dispose:${sessionA.id}`), 15_000)
    assert.equal(cancels, 1, 'the replaced owner is cancelled exactly once by the real retirement')
    assert.equal(approvalOutcome, undefined, 'the held cancellation has not completed yet')
    completeCancellation!()
    await waitUntil('the approval settled fail-closed', () => approvalOutcome !== undefined, 15_000)
    assert.equal(approvalOutcome, 'cancelled',
      'the Host cancellation settles the withdrawn approval `cancelled` — never an allow')

    // The replacement subject's own approval takes a FRESH seat identity and is
    // answered explicitly.
    const bAbort = new AbortController()
    let bOutcome: string | undefined
    void ctx.waterfall(
      liveAgentOf(harness, sessionB),
      'approval/request',
      { agent: liveAgentOf(harness, sessionB), callId: 'call-c-b-approval', toolName: 'bash', reason: 'B needs the shell', signal: bAbort.signal },
      () => Promise.resolve('unavailable'),
    ).then(value => { bOutcome = String(value) })
    await waitUntil('B\'s own approval prompt', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    assert.notEqual(liveLayerModals(owned.pane.frames())[0], aModal, 'the replacement subject gets a fresh seat identity')
    assert.ok(owned.pane.output.text().includes('B needs the shell'), 'B\'s own approval is presented')
    owned.pane.key('y')
    await waitUntil('the explicit allow', () => bOutcome === 'allowed-once', 15_000)
    await waitUntil('the answered prompt leaves the seat', () => liveLayerModals(owned.pane.frames()).length === 0, 15_000)
  } finally {
    await owned.settle()
  }
})

test('B3 finding F10 (6): a replaced subject\'s request that arrives AFTER the publication is never mounted (production path)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-late-')
  const sessionA = fakeSession({
    id: 'b3-c-late-a',
    header: { id: 'b3-c-late-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const { owned, harness, ctx } = await bootB3Tsp({ life, home, standing: sessionA, resume: sessionA.id })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    const aAgent = liveAgentOf(harness, sessionA.id) as { cancel: () => void }
    const originalCancel = aAgent.cancel
    let completeCancellation: (() => void) | undefined
    const cancellationCompletion = new Promise<void>(resolve => { completeCancellation = resolve })
    const approvalAbort = new AbortController()
    aAgent.cancel = () => {
      void cancellationCompletion.then(() => { approvalAbort.abort() })
      originalCancel.call(aAgent)
    }
    life.defer(() => { aAgent.cancel = originalCancel })
    life.defer(() => { completeCancellation?.() })

    // A LEGAL upstream waterfall middleware that awaits before calling `next`:
    // A's request exists while A is still the owner, but reaches this answerer
    // only after B has been published (its cancellation has not completed).
    let releaseMiddleware: (() => void) | undefined
    const middlewareHold = new Promise<void>(resolve => { releaseMiddleware = resolve })
    life.defer(() => { releaseMiddleware?.() })
    let admitted = false
    ctx.on(
      'approval/request',
      (...args: unknown[]) => {
        const next = args[1] as () => unknown
        return middlewareHold.then(() => {
          admitted = true
          return next()
        })
      },
      { prepend: true },
    )

    let approvalOutcome: string | undefined
    void ctx.waterfall(
      aAgent,
      'approval/request',
      { agent: aAgent, callId: 'call-c-late', toolName: 'bash', reason: 'late request', signal: approvalAbort.signal },
      () => Promise.resolve('unavailable'),
    ).then(
      value => { approvalOutcome = String(value) },
      (error: unknown) => { approvalOutcome = `rejected:${String(error)}` },
    )
    await settle()
    assert.deepEqual(liveLayerModals(owned.pane.frames()), [],
      'the held request has not reached the answerer yet: nothing is presented')

    // B is published BEFORE the request is admitted.
    const fork = commandOf(owned, 'fork')()
    await waitUntil('the fork child', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).includes(sessionB), 15_000)

    // The delayed request is admitted now: the proof is the REAL admission (not a
    // timer), and it must NEVER be mounted.
    releaseMiddleware!()
    await waitUntil('the delayed request reached the answerer', () => admitted, 15_000)
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(liveLayerModalsAt(owned.pane.frames(), `DSH session ${sessionB}`), [],
      'B\'s publication frame presents nothing of the replaced subject')
    assert.deepEqual(liveLayerModals(owned.pane.frames()), [],
      'the late request is never mounted into the replacement')
    assert.equal(approvalOutcome, undefined, 'it keeps its own lifetime (no fabricated settlement)')

    // Only the Host's own (real, held) cancellation settles it, fail-closed.
    await fork
    await waitUntil('A retirement', () => harness.retirementEvents.includes(`dispose:${sessionA.id}`), 15_000)
    assert.equal(approvalOutcome, undefined, 'the held cancellation has not completed yet')
    completeCancellation!()
    await waitUntil('the late request settled fail-closed', () => approvalOutcome !== undefined, 15_000)
    assert.equal(approvalOutcome, 'cancelled', 'the Host cancellation settles it `cancelled` — never an allow')

    // POSITIVE CONTROL: the CURRENT subject's own approval is still answered.
    const bAbort = new AbortController()
    let bOutcome: string | undefined
    void ctx.waterfall(
      liveAgentOf(harness, sessionB),
      'approval/request',
      {
        agent: liveAgentOf(harness, sessionB),
        callId: 'call-c-late-b',
        toolName: 'bash',
        reason: 'B needs the shell',
        signal: bAbort.signal,
      },
      () => Promise.resolve('unavailable'),
    ).then(value => { bOutcome = String(value) })
    await waitUntil('B\'s own approval prompt', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    owned.pane.key('y')
    await waitUntil('the explicit allow', () => bOutcome === 'allowed-once', 15_000)
  } finally {
    await owned.settle()
  }
})

test('B3 finding F13: the DEFAULT PiTui branch still forwards a foreign-session request to the app (the new policy is renderer-owned only)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-pitui-')
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
  const sessionA = fakeSession({
    id: 'b3-c-pitui-a',
    header: { id: 'b3-c-pitui-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const sessionB = fakeSession({
    id: 'b3-c-pitui-b',
    header: { id: 'b3-c-pitui-b', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('session b content'),
  })
  const harness = makeHarness(home, [sessionA, sessionB])
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  await settle()
  assert.ok(probe.apps.at(-1), 'the default branch mounts the real TuiApp')

  // A request whose Session is NOT the one this surface shows — the same shape the
  // renderer-owned branch refuses at admission. On the DEFAULT branch it must be
  // forwarded to the app exactly as before this slice (the new policy is scoped to
  // the TSP renderer mount; there is no authority scope adjustment for PiTui).
  context.emit('approval/request', {
    agent: { session: { id: sessionB.id } },
    callId: 'call-c-pitui-foreign',
    toolName: 'bash',
    reason: 'foreign-session request',
  } as never, undefined as never)
  await settle()
  assert.equal(probe.capturedApproval?.toolName, 'bash',
    'the default branch delegated the foreign-session request to the app')
})

test('B3 finding F14 (7): a REAL opening rollback retires the opening target\'s presentation with NO extra trigger', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-c-rollback-')
  const sessionA = fakeSession({
    id: 'b3-c-rollback-a',
    header: { id: 'b3-c-rollback-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  // The Host's create is HELD inside the transition's opening window, then made to
  // FAIL: the real rollback path (the transition's own `clearOpening`).
  let releaseCreate: (() => void) | undefined
  const createHeld = new Promise<void>(resolve => { releaseCreate = resolve })
  let refuseCreate = false
  const { owned, harness, ctx } = await bootB3Tsp({
    life, home, standing: sessionA, resume: sessionA.id,
    createGate: async () => {
      await createHeld
      if (refuseCreate) throw new Error('the Host refused to create the session')
    },
  })
  let releaseMiddleware: (() => void) | undefined
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    // Discover the opening target's id from the production create call itself (the
    // journal already opened it at admission, before this call).
    const agents = harness.agents as { create: (options: { sessionId: string }) => Promise<unknown> }
    const originalCreate = agents.create
    let target: string | undefined
    agents.create = options => {
      target = options.sessionId
      return originalCreate.call(agents, options)
    }
    life.defer(() => { agents.create = originalCreate })

    const transition = commandOf(owned, 'new')()
    await waitUntil('the opening target', () => target !== undefined, 15_000)
    // The target's own requests are ADMITTED while the journal is opening it.
    const questionAbort = new AbortController()
    let questionOutcome: string | undefined
    const targetId = target as string
    void ctx.waterfall(
      { session: { id: targetId } },
      'user-questions/request',
      {
        agent: { session: { id: targetId } },
        wait: { callId: 'call-rollback' },
        questions: [{ id: 'q-rollback', question: 'Opening target?', options: [{ label: 'yes' }] }],
        signal: questionAbort.signal,
      },
      () => Promise.reject(new Error('no answerer')),
    ).then(
      () => { questionOutcome = 'answered' },
      (error: unknown) => { questionOutcome = String((error as { readonly code?: unknown }).code) },
    )
    const approvalAbort = new AbortController()
    let approvalOutcome: string | undefined
    void ctx.waterfall(
      { session: { id: targetId } },
      'approval/request',
      { agent: { session: { id: targetId } }, callId: 'call-rollback-approval', toolName: 'bash', reason: 'opening approval', signal: approvalAbort.signal },
      () => Promise.resolve('unavailable'),
    ).then(value => { approvalOutcome = String(value) })
    await waitUntil('the opening target\'s own presentation', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    assert.equal(harness.createdSessions.length, 0, 'the create is still held inside the opening window')

    // The create FAILS: the real transition rolls the opening back. NO session
    // event, NO manual reconcile and NO other presentation trigger is issued by
    // the test.
    refuseCreate = true
    releaseCreate!()
    await transition
    // The scripted pane's SDK loop advances on terminal input, so the witness
    // PUMPS it with one neutral event: that only lets an already-committed frame
    // land (the same withdrawal lands unpumped in the L6 harness, and the real
    // pane paints continuously) — it is never a presentation trigger.
    owned.pane.event({ ev: 'focus' })
    await waitUntil('the rolled-back target\'s presentation left the surface',
      () => liveLayerModals(owned.pane.frames()).length === 0, 15_000)
    assert.equal(harness.createdSessions.length, 0, 'no session was created (the opening was rolled back)')
    // Presentation-only: both official requests keep their OWN lifetimes.
    assert.equal(questionOutcome, undefined, 'the question is still in flight')
    assert.equal(approvalOutcome, undefined, 'the approval is still in flight')
    questionAbort.abort()
    approvalAbort.abort()
    await waitUntil('the Host ends settle them', () => questionOutcome !== undefined && approvalOutcome !== undefined, 15_000)
    assert.equal(questionOutcome, 'ASK_ABORTED', 'the Host end classifies the retired flow ASK_ABORTED')
    assert.equal(approvalOutcome, 'cancelled', 'the retired approval settles fail-closed')
  } finally {
    releaseMiddleware?.()
    releaseCreate?.()
    await owned.settle()
  }
})

test('B3 P2-2 (8): signal-less live requests are settled by the REAL retirement, not by TUI exit', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-nosig-')
  const sessionA = fakeSession({
    id: 'b3-nosig-a',
    header: { id: 'b3-nosig-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const { owned, harness, ctx } = await bootB3Tsp({ life, home, standing: sessionA, resume: sessionA.id })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    const aAgent = liveAgentOf(harness, sessionA.id)
    // The official signal is OPTIONAL for both kinds — these requests have no
    // lifetime of their own, so a real subject replacement is their only owner.
    let questionOutcome: string | undefined
    let approvalOutcome: string | undefined
    void ctx.waterfall(
      aAgent,
      'user-questions/request',
      {
        agent: aAgent,
        wait: { callId: 'call-nosig' },
        questions: [{ id: 'q-nosig', question: 'No signal?', options: [{ label: 'yes' }] }],
      },
      () => Promise.reject(new Error('no answerer')),
    ).then(
      () => { questionOutcome = 'answered' },
      (error: unknown) => { questionOutcome = String((error as { readonly code?: unknown }).code) },
    )
    void ctx.waterfall(
      aAgent,
      'approval/request',
      { agent: aAgent, callId: 'call-nosig-approval', toolName: 'bash', reason: 'no signal' },
      () => Promise.resolve('unavailable'),
    ).then(value => { approvalOutcome = String(value) })
    await waitUntil('A\'s signal-less presentation', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)

    const fork = commandOf(owned, 'fork')()
    await waitUntil('the fork child', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).includes(sessionB), 15_000)
    assert.deepEqual(liveLayerModalsAt(owned.pane.frames(), `DSH session ${sessionB}`), [],
      'B\'s publication frame must not present the replaced subject\'s signal-less request')

    await fork
    await waitUntil('both signal-less requests settled',
      () => questionOutcome !== undefined && approvalOutcome !== undefined, 15_000)
    assert.equal(questionOutcome, 'ASK_ABORTED', 'a session-driven end, never a user cancel')
    assert.equal(approvalOutcome, 'cancelled', 'the approval stays fail-closed, never an allow')
    assert.deepEqual(liveLayerModals(owned.pane.frames()), [], 'no stale slot survives the replacement')
  } finally {
    await owned.settle()
  }
})

test('B3 P3 (9): an open Alt+Q list does not survive a real Session replacement', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-altq-switch-')
  const sessionA = fakeSession({
    id: 'b3-altq-switch-a',
    header: { id: 'b3-altq-switch-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  const { owned, harness, ctx, plane } = await bootB3Tsp({ life, home, standing: sessionA, resume: sessionA.id })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    // One parked continued call, then the transient list opens over it.
    plane.seedContinued(sessionA.id, 'call-altq-switch',
      [{ id: 'q-altq', question: 'Parked?', options: [{ label: 'yes' }] }])
    ctx.emit('session/event', sessionA, event('model/selection', { provider: 'p', model: 'm' }, sessionA.snapshotEvents().length))
    await waitUntil('the parked count', () => attentionLineLive(owned.pane.frames()), 15_000)
    owned.pane.key('\u001b[113;3u')
    await waitUntil('the transient list', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)

    // A REAL replacement (the composer is fenced by the modal seat, so the
    // registered command entry is the production path).
    const transition = commandOf(owned, 'new')()
    await waitUntil('the replacement Session', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).includes(sessionB), 15_000)
    await transition
    assert.deepEqual(liveLayerModalsAt(owned.pane.frames(), `DSH session ${sessionB}`), [],
      'the transient list must not cross the replacement')
    assert.deepEqual(liveLayerModals(owned.pane.frames()), [], 'no overlay left the replacement seat')
    // The replacement owns the INPUT again: the last caret request the renderer
    // committed is the composer (never the vanished list).
    owned.pane.event({ ev: 'focus' })
    await waitUntil('the composer owns the caret again', () => {
      const focuses = owned.pane.frames().flatMap(frame => frame.ops).filter(op => op[0] === 'focus')
      return focuses.length > 0 && focuses[focuses.length - 1]?.[1] === 'dock.composer'
    }, 15_000)
  } finally {
    await owned.settle()
  }
})

async function expectPublicationWindowCurrentness(
  t: import('node:test').TestContext,
  command: 'fork' | 'new',
): Promise<void> {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-pubwindow-')
  const sessionA = fakeSession({
    id: 'b3-pubwindow-a',
    header: { id: 'b3-pubwindow-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  // The CHILD's idle gate is HELD: the transition parks in its post-commit child
  // quiesce, i.e. B is already the published owner while its initialization
  // (hydration, the later reconcile) has NOT run — the exact window the review
  // named.
  let releaseChildIdle: (() => void) | undefined
  const childIdle = new Promise<void>(resolve => { releaseChildIdle = resolve })
  let childGateEntered = false
  const { owned, harness, ctx } = await bootB3Tsp({
    life, home, standing: sessionA, resume: sessionA.id,
    whenIdleGate: sessionId => {
      if (sessionId === sessionA.id) return Promise.resolve()
      childGateEntered = true
      return childIdle
    },
  })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    const aAgent = liveAgentOf(harness, sessionA.id) as { cancel: () => void }
    const originalCancel = aAgent.cancel
    const approvalAbort = new AbortController()
    const questionAbort = new AbortController()
    // The Host's cancellation of the replaced owner is HELD: A's requests stay in
    // flight through the whole window, so the modal's absence there can only be
    // the presentation currentness at publication — never a settlement.
    let completeCancellation: (() => void) | undefined
    const cancellationCompletion = new Promise<void>(resolve => { completeCancellation = resolve })
    aAgent.cancel = () => {
      void cancellationCompletion.then(() => {
        approvalAbort.abort()
        questionAbort.abort()
      })
      originalCancel.call(aAgent)
    }
    life.defer(() => { aAgent.cancel = originalCancel })
    life.defer(() => { completeCancellation?.() })
    life.defer(() => { releaseChildIdle?.() })

    // A's own modal: a live approval (answered by `y`) and a live Question
    // (answered by Enter).
    let approvalOutcome: string | undefined
    let questionOutcome: string | undefined
    void ctx.waterfall(
      aAgent,
      'approval/request',
      { agent: aAgent, callId: 'call-window-approval', toolName: 'bash', reason: 'A window approval', signal: approvalAbort.signal },
      () => Promise.resolve('unavailable'),
    ).then(value => { approvalOutcome = String(value) })
    void ctx.waterfall(
      aAgent,
      'user-questions/request',
      {
        agent: aAgent,
        wait: { callId: 'call-window-question' },
        questions: [{ id: 'q-window', question: 'A window question?', options: [{ label: 'yes' }] }],
        signal: questionAbort.signal,
      },
      () => Promise.reject(new Error('no answerer')),
    ).then(
      () => { questionOutcome = 'answered' },
      (error: unknown) => { questionOutcome = String((error as { readonly code?: unknown }).code) },
    )
    await waitUntil('A\'s modal', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)

    const transition = commandOf(owned, command)()
    await waitUntil('the child create', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    // THE WINDOW: the commit published B and the transition is parked in the
    // post-commit child quiesce — nothing has been hydrated yet.
    await waitUntil('the post-commit child quiesce', () => childGateEntered, 15_000)
    assert.equal(presentedSessions(owned.pane).includes(sessionB), false,
      'B is the published owner but not initialized yet (the window is real)')
    assert.equal(approvalOutcome, undefined, 'the held Host cancellation has not completed: A\'s approval is in flight')
    assert.equal(questionOutcome, undefined, 'the held Host cancellation has not completed: A\'s Question is in flight')

    // The commit-time withdrawal must already have left a committed frame — with
    // BOTH requests still pending, so this is presentation currentness alone.
    owned.pane.event({ ev: 'focus' })
    await waitUntil('the replaced modal left the seat AT publication',
      () => liveLayerModals(owned.pane.frames()).length === 0, 15_000)

    // Keys can no longer ANSWER A: `y`, Enter and Esc are no longer the modal
    // seat's (they belong to the composer and, for Esc, to the application's own
    // cancel intent — the correct owner once the modal is gone). Each key is sent
    // alone, so the witness shows the input ownership step by step.
    const settleKeys = async (): Promise<void> => {
      owned.pane.event({ ev: 'focus' })
      await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    }
    owned.pane.key('y')
    await settleKeys()
    assert.notEqual(approvalOutcome, 'allowed-once', '`y` cannot answer the replaced subject\'s approval')
    assert.ok(owned.pane.output.text().includes('y'), 'the key reached the composer instead of a modal seat')
    owned.pane.key('\r')
    await settleKeys()
    assert.notEqual(questionOutcome, 'answered', 'Enter cannot answer the replaced subject\'s question')
    owned.pane.key('\u001b')
    await settleKeys()
    assert.equal(approvalOutcome, undefined, 'none of `y`/Enter/Esc can settle the replaced subject\'s approval')
    assert.equal(questionOutcome, undefined, 'none of `y`/Enter/Esc can settle the replaced subject\'s Question')

    // Release the child quiesce: the transition completes, and A's requests are
    // still owned by their own Host lifetimes.
    releaseChildIdle!()
    await transition
    await waitUntil('B hydrated', () => presentedSessions(owned.pane).includes(sessionB), 15_000)
    await waitUntil('A retired', () => harness.retirementEvents.includes(`dispose:${sessionA.id}`), 15_000)
    completeCancellation!()
    await waitUntil('A\'s requests settled by their own lifetimes',
      () => approvalOutcome !== undefined && questionOutcome !== undefined, 15_000)
    assert.equal(approvalOutcome, 'cancelled', 'the Host cancellation settles the approval fail-closed')
    assert.equal(questionOutcome, 'ASK_ABORTED', 'the Host cancellation ends the question ASK_ABORTED')
  } finally {
    releaseChildIdle?.()
    await owned.settle()
  }
}

test('B3 P2-B (10): the replaced modal leaves the seat AT the owner publication, before the new owner is initialized (fork and /new)', async (t) => {
  await expectPublicationWindowCurrentness(t, 'fork')
  await expectPublicationWindowCurrentness(t, 'new')
})

test('B3 P2-C (11): the commit-time withdrawal performs NO Host projection read (a throwing read cannot reach it)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-b3-commitread-')
  const sessionA = fakeSession({
    id: 'b3-commitread-a',
    header: { id: 'b3-commitread-a', cwd: home, createdAt: 0, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A standing state'),
  })
  // Two holds: the CREATE gate (so the child's id is known and its projection read
  // can be ARMED before the commit) and the child's post-commit idle gate (the
  // publication window).
  let releaseCreate: (() => void) | undefined
  const createHeld = new Promise<void>(resolve => { releaseCreate = resolve })
  let releaseChildIdle: (() => void) | undefined
  const childIdle = new Promise<void>(resolve => { releaseChildIdle = resolve })
  let childGateEntered = false
  let target: string | undefined
  const { owned, harness, ctx, plane } = await bootB3Tsp({
    life, home, standing: sessionA, resume: sessionA.id,
    createGate: () => createHeld,
    whenIdleGate: sessionId => {
      if (sessionId === sessionA.id) return Promise.resolve()
      childGateEntered = true
      return childIdle
    },
  })
  try {
    await waitUntil('A\'s welcome card', () => presentedSessions(owned.pane).includes(sessionA.id), 15_000)
    // A MOUNTED continued form for A: the commit-time drop must have real work to
    // do (the path that used to publish attention, i.e. read the Host).
    plane.seedContinued(sessionA.id, 'call-commit-read',
      [{ id: 'q-commit-read', question: 'Parked?', options: [{ label: 'yes' }] }])
    ctx.emit('session/event', sessionA, event('model/selection', { provider: 'p', model: 'm' }, sessionA.snapshotEvents().length))
    await waitUntil('the parked count', () => attentionLineLive(owned.pane.frames()), 15_000)
    owned.pane.key('\u001b[113;3u')
    await waitUntil('the continued list', () => liveLayerModals(owned.pane.frames()).length === 1, 15_000)
    owned.pane.key('\r')
    await waitUntil('the mounted continued form', () => owned.pane.output.text().includes('Parked?'), 15_000)

    // Discover the child's id from the production create call, then hold the create.
    const agents = harness.agents as { create: (options: { sessionId: string }) => Promise<unknown> }
    const originalCreate = agents.create
    agents.create = options => {
      target = options.sessionId
      return originalCreate.call(agents, options)
    }
    life.defer(() => { agents.create = originalCreate })
    const transition = commandOf(owned, 'new')()
    await waitUntil('the create hold', () => target !== undefined, 15_000)
    // ARM the child's projection reads BEFORE the commit: a state-only commit
    // never triggers one, and a read that DOES reach the commit would throw there.
    plane.failProjectionFor = target
    releaseCreate!()
    await waitUntil('the publication window', () => childGateEntered, 15_000)

    const childReads = plane.projectionReads.filter(read => read.id === target && read.key === 'userQuestions')
    assert.deepEqual(childReads, [],
      'the commit-time withdrawal performed NO Host projection read for the new owner')
    assert.equal(plane.projectionFailures.value, 0, 'the armed read never fired inside the commit')
    // The replaced subject's mounted continued form left the interactive seat.
    owned.pane.event({ ev: 'focus' })
    await waitUntil('the replaced continued form left the seat',
      () => liveLayerModals(owned.pane.frames()).length === 0, 15_000)

    // Disarm and finish: the transition completes normally (the commit bookkeeping
    // was never disturbed) and the new owner is published.
    plane.failProjectionFor = undefined
    releaseChildIdle!()
    await transition
    await waitUntil('the new owner published', () => harness.createdSessions.length === 1, 15_000)
    const sessionB = harness.createdSessions[0]!.id
    await waitUntil('B publication', () => presentedSessions(owned.pane).at(-1) === sessionB, 15_000)
    assert.ok(harness.retirementEvents.includes(`dispose:${sessionA.id}`), 'the replaced owner was retired exactly once')
  } finally {
    releaseCreate?.()
    releaseChildIdle?.()
    await owned.settle()
  }
})
