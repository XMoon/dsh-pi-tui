/**
 * L3 contract tests for the Remote child-view source (M3-5 PR2 Step 4/5/6, plan
 * §5 Must 9-11, §6 Must-not 10-12, §13 Child open).
 *
 * The source owns ONE explicit `tuiChildView` Client reference acquired from the
 * exact durable `SubagentAddress` the Task row carries, hydrates through the ONE
 * shared presentation reader, and installs the ONE shared live ingress fenced by
 * the exact retained binding. These tests use borrow-only fakes so the
 * generation/identity behavior under test is the real reference contract.
 * @module @xmoon76/dsh-pi-tui/remote-child-view.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRemoteChildViewSource,
  type RemoteChildBinding,
  type RemoteChildViewSessions,
} from '../src/app/remote/child-view.ts'
import type { RemoteLiveIngress, RemoteLiveIngressSinks } from '../src/app/remote/live-ingress.ts'
import type { ViewerChildLiveSinks, ViewerChildOpenTarget } from '../src/app/surface/viewer-runtime.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import type { PresentationDurableEvent, PresentationReadSnapshot } from '../src/runtime/presentation-read-port.ts'
import type {
  RemoteSubagentViewAddress,
  TuiSessionReferenceSource,
} from '../src/runtime/remote/session-reference.ts'

/** The event shape this suite casts at the composition seam. */
interface WireEvent {
  readonly tag: 'cast'
  readonly raw: unknown
}

interface RetainRecord {
  readonly address: RemoteSubagentViewAddress
  readonly source: TuiSessionReferenceSource
  readonly signal: AbortSignal | undefined
}

interface ChildSessionsFixture {
  readonly sessions: RemoteChildViewSessions
  readonly retains: RetainRecord[]
  readonly releases: string[]
  setBinding(id: string, binding: RemoteChildBinding | undefined): void
  /** Install the settlement of the NEXT retain's `ready` wait. */
  setReady(factory: (binding: RemoteChildBinding) => Promise<unknown>): void
}

/**
 * A borrow-only child-sessions double: the id is retained only while a
 * reference is held, `binding()` borrows without extending it, and a same-id
 * `setBinding` models a generation replacement the official Client performs.
 */
function childSessions(childId: string, binding: RemoteChildBinding): ChildSessionsFixture {
  const bindings = new Map<string, RemoteChildBinding>([[childId, binding]])
  const counts = new Map<string, number>([[childId, 1]])
  const retains: RetainRecord[] = []
  const releases: string[] = []
  let readyFactory: (held: RemoteChildBinding) => Promise<unknown> = async held => held
  const sessions: RemoteChildViewSessions = {
    binding: id => (counts.get(id) ?? 0) > 0 ? bindings.get(id) : undefined,
    retain: (target, options) => {
      const address = target as RemoteSubagentViewAddress
      const id = String(address.childSessionId)
      retains.push({ address, source: options.source, signal: options.signal })
      options.signal?.throwIfAborted()
      const held = bindings.get(id)
      if (held === undefined) throw new Error(`sessions.retain: unknown session ${id}`)
      counts.set(id, (counts.get(id) ?? 0) + 1)
      let live = true
      return {
        sessionId: id,
        get binding(): unknown {
          if (!live) throw new Error(`Session reference "${id}" is released`)
          return held
        },
        ready: readyFactory(held),
        release: (): void => {
          if (!live) return
          live = false
          releases.push(id)
          const next = (counts.get(id) ?? 1) - 1
          if (next <= 0) counts.delete(id)
          else counts.set(id, next)
        },
      }
    },
  }
  return {
    sessions,
    retains,
    releases,
    setReady(factory) { readyFactory = factory },
    setBinding(id, next) {
      if (next === undefined) {
        bindings.delete(id)
        counts.delete(id)
        return
      }
      bindings.set(id, next)
      if ((counts.get(id) ?? 0) === 0) counts.set(id, 1)
    },
  }
}

function childBinding(running: boolean): RemoteChildBinding {
  return {
    session: {
      getSnapshot: () => ({ running }),
      readAttachment: async () => ({ ok: true, value: { attachment: {}, data: new Uint8Array() } }),
    },
  }
}

interface IngressCapture {
  readonly sessionId: string
  readonly sinks: RemoteLiveIngressSinks
  readonly hydrateRevision: number | undefined
  disposeCount: number
}

function fakeIngress(): { readonly ingress: RemoteLiveIngress; readonly captures: IngressCapture[] } {
  const captures: IngressCapture[] = []
  return {
    captures,
    ingress: {
      subscribe(sessionId, sinks, hydrateRevision) {
        const capture: IngressCapture = { sessionId, sinks, hydrateRevision, disposeCount: 0 }
        captures.push(capture)
        return { dispose: () => { capture.disposeCount += 1 } }
      },
    },
  }
}

function snapshotOf(
  revision: number,
  overrides: Partial<PresentationReadSnapshot> = {},
): PresentationReadSnapshot {
  return {
    sessionId: 'child-1',
    durableEvents: [],
    liveInputs: [],
    revision,
    coverage: 'bounded',
    hasMore: false,
    loadingOlder: false,
    openState: 'open',
    ...overrides,
  }
}

function openTarget(overrides: Partial<ViewerChildOpenTarget> = {}): ViewerChildOpenTarget {
  return {
    parentSessionId: 'parent-1',
    childSessionId: 'child-1',
    mode: 'continuable',
    activity: 'running',
    signal: new AbortController().signal,
    ...overrides,
  }
}

const asEvent = (event: unknown): WireEvent => ({ tag: 'cast', raw: event })

function buildSource(options: {
  sessions: RemoteChildViewSessions
  ingress: RemoteLiveIngress
  read?: (sessionId: string, signal?: AbortSignal) => Promise<PresentationReadSnapshot | undefined>
  loadOlder?: (sessionId: string, signal?: AbortSignal) => Promise<PresentationReadSnapshot | undefined>
  childCwd?: (childSessionId: string) => string
}) {
  return createRemoteChildViewSource<WireEvent>({
    sessions: options.sessions,
    reader: {
      read: options.read ?? (async () => snapshotOf(0)),
      loadOlder: options.loadOlder ?? (async () => undefined),
    },
    liveIngress: options.ingress,
    childCwd: options.childCwd ?? (() => ''),
    asEvent,
  })
}

test('open acquires the EXACT durable address with tuiChildView and awaits ready before reading', async () => {
  const binding = childBinding(true)
  const fixture = childSessions('child-1', binding)
  let settleReady!: (value: unknown) => void
  fixture.setReady(() => new Promise(resolve => { settleReady = resolve }))
  const reads: string[] = []
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async (id) => { reads.push(id); return snapshotOf(3) },
  })
  const target = openTarget()

  const opened = source.open(target)
  // The retain is synchronous; `ready` is still pending.
  assert.deepEqual(
    fixture.retains.map(record => ({ address: record.address, source: record.source })),
    [{
      address: { parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable' },
      source: 'tuiChildView',
    }],
    'the reference is acquired from the exact parent+child+catalog-mode address',
  )
  assert.equal(fixture.retains[0]?.signal, target.signal, 'the open cancellation signal reaches the retain')
  assert.deepEqual(reads, [], 'hydration must not start before the initial Client open settles')

  let settled = false
  void opened.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'open awaits `ready` before it resolves')

  settleReady(binding)
  const view = await opened
  assert.ok(view !== undefined)
  assert.deepEqual(reads, ['child-1'], 'hydration runs only after the awaited open')
  assert.equal(view.childSessionId, 'child-1')
  assert.equal(view.parentSessionId, 'parent-1')
  view.release()
})

test('a rejected ready releases the reference and rethrows (a real open failure is never swallowed)', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  fixture.setReady(() => Promise.reject(new Error('the child open failed')))
  const { ingress } = fakeIngress()
  const source = buildSource({ sessions: fixture.sessions, ingress })

  await assert.rejects(source.open(openTarget()), /the child open failed/)
  assert.deepEqual(fixture.releases, ['child-1'], 'the failed acquisition releases its reference exactly once')
})

test('an aborted open signal releases the reference and returns undefined silently', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  let rejectReady!: (error: unknown) => void
  fixture.setReady(() => new Promise((_resolve, reject) => { rejectReady = reject }))
  const { ingress } = fakeIngress()
  const source = buildSource({ sessions: fixture.sessions, ingress })

  const controller = new AbortController()
  const opened = source.open(openTarget({ signal: controller.signal }))
  controller.abort()
  rejectReady(new Error('the superseded open failed'))

  assert.equal(await opened, undefined, 'a superseded open commits nothing, silently')
  assert.deepEqual(fixture.releases, ['child-1'])
})

test('F6 regression: the official openState:error releases the reference and surfaces the REAL error, never an empty child', async () => {
  const officialFailure = new Error('the Host history stream failed')
  // The official `Session.doOpen` records a real RemoteFailure as
  // `openState: 'error'` + `openError` and RESOLVES the promise, so `ready`
  // never rejects and the reader still returns a window.
  const errored: RemoteChildBinding = {
    session: {
      getSnapshot: () => ({ running: false, openState: 'error', openError: officialFailure }),
      readAttachment: async () => ({ ok: true, value: { attachment: {}, data: new Uint8Array() } }),
    },
  }
  const fixture = childSessions('child-1', errored)
  let reads = 0
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async () => { reads += 1; return snapshotOf(1, { openState: 'error' }) },
  })

  await assert.rejects(source.open(openTarget()), error => error === officialFailure,
    'the official recorded failure is preserved, not replaced by a generic one')
  assert.equal(reads, 1, 'the window was read before the open state was classified')
  assert.deepEqual(fixture.releases, ['child-1'], 'a failed open releases its reference exactly once')
})

test('F6 regression: an errored window is never re-folded by rehydrate', async () => {
  let openState: 'open' | 'error' = 'open'
  const mutable: RemoteChildBinding = {
    session: {
      getSnapshot: () => ({
        running: false,
        openState,
        ...(openState === 'error' ? { openError: new Error('the child history stream failed') } : {}),
      }),
      readAttachment: async () => ({ ok: true, value: { attachment: {}, data: new Uint8Array() } }),
    },
  }
  const fixture = childSessions('child-1', mutable)
  const { ingress } = fakeIngress()
  const source = buildSource({ sessions: fixture.sessions, ingress, read: async () => snapshotOf(1) })
  const view = await source.open(openTarget())
  assert.ok(view !== undefined)
  assert.notEqual(await view.rehydrate(), undefined, 'an OPEN window re-folds normally')
  openState = 'error'
  assert.equal(await view.rehydrate(), undefined,
    'an errored window must never be re-folded as a legitimate (empty) child')
  view.release()
})

test('the snapshot carries durableEvents, liveInputs, official running activity, child cwd and reader revision', async () => {
  const durable = [
    { type: 'turn/start', seq: 1, time: 10 },
    { type: 'turn/end', seq: 2, time: 20 },
  ] satisfies PresentationDurableEvent[]
  const liveInputs: AssistantLiveInput[] = [
    { kind: 'start', sessionId: 'child-1', attemptId: 'attempt-a', turn: 0, step: 0 },
  ]
  const fixture = childSessions('child-1', childBinding(true))
  const { ingress } = fakeIngress()
  const cwdCalls: string[] = []
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async () => snapshotOf(9, { durableEvents: durable, liveInputs }),
    childCwd: (id) => { cwdCalls.push(id); return '/child/work' },
  })

  const view = await source.open(openTarget())
  assert.ok(view !== undefined)
  assert.deepEqual(view.snapshot.durableEvents, durable)
  assert.deepEqual(view.snapshot.liveInputs, liveInputs)
  assert.equal(view.snapshot.activity, 'running', 'activity comes from the official binding running bit')
  assert.equal(view.snapshot.cwd, '/child/work', 'cwd comes from the child session-status read')
  assert.equal(view.snapshot.revision, 9, 'the reader revision is the ingress hydration baseline')
  assert.deepEqual(cwdCalls, ['child-1'])
  view.release()
})

test('a binding whose official running bit is false hydrates as inactive, never from catalog presence', async () => {
  const fixture = childSessions('child-1', childBinding(false))
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async () => snapshotOf(1, { durableEvents: [{ type: 'turn/start', seq: 1, time: 1 }] }),
  })

  const view = await source.open(openTarget({ activity: 'running' }))
  assert.ok(view !== undefined)
  assert.equal(view.snapshot.activity, 'inactive', 'the durable transcript presence never decides activity')
  view.release()
})

test('subscribe forwards every ingress sink and passes the hydrated revision as hydrateRevision', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  const { ingress, captures } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async () => snapshotOf(7, { liveInputs: [{ kind: 'start', sessionId: 'child-1', attemptId: 'a', turn: 0, step: 0 }] }),
  })
  const view = await source.open(openTarget())
  assert.ok(view !== undefined)

  const durable: WireEvent[] = []
  const live: AssistantLiveInput[] = []
  const calls: string[] = []
  const sinks: ViewerChildLiveSinks<WireEvent> = {
    onDurableEvent: event => { durable.push(event) },
    onLiveInput: input => { live.push(input) },
    onWindowReplaced: () => { calls.push('replaced') },
    onWindowPrepended: () => { calls.push('prepended') },
    onSessionSnapshotChanged: () => { calls.push('snapshot') },
    onProjectionsChanged: () => { calls.push('projections') },
  }
  const handle = view.subscribe(sinks)
  assert.ok(handle !== undefined)
  assert.equal(captures.length, 1)
  const capture = captures[0]!
  assert.equal(capture.sessionId, 'child-1')
  assert.equal(capture.hydrateRevision, 7, 'the hydrated reader revision fences the subscribe gap')

  const raw = { type: 'turn/start', seq: 4, time: 40 }
  capture.sinks.onDurableEvent('child-1', raw)
  assert.deepEqual(durable, [{ tag: 'cast', raw }], 'the durable event crosses the composition cast seam')

  const input: AssistantLiveInput = { kind: 'start', sessionId: 'child-1', attemptId: 'a', turn: 0, step: 0 }
  capture.sinks.onLiveInput(input)
  assert.equal(live.length, 1)
  assert.equal(live[0], input, 'the live input is forwarded by identity')

  capture.sinks.onWindowReplaced('child-1')
  capture.sinks.onWindowPrepended('child-1')
  capture.sinks.onSessionSnapshotChanged('child-1')
  capture.sinks.onProjectionsChanged('child-1')
  assert.deepEqual(calls, ['replaced', 'prepended', 'snapshot', 'projections'])
  view.release()
})

test('release is idempotent, disposes the live subscription and releases the reference exactly once', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  const { ingress, captures } = fakeIngress()
  const source = buildSource({ sessions: fixture.sessions, ingress })
  const view = await source.open(openTarget())
  assert.ok(view !== undefined)
  const handle = view.subscribe({
    onDurableEvent: () => {},
    onLiveInput: () => {},
    onWindowReplaced: () => {},
    onWindowPrepended: () => {},
    onSessionSnapshotChanged: () => {},
    onProjectionsChanged: () => {},
  })
  assert.ok(handle !== undefined)

  view.release()
  view.release()
  assert.equal(captures[0]?.disposeCount, 1, 'the child ingress goes down exactly once')
  assert.deepEqual(fixture.releases, ['child-1'], 'the reference releases exactly once')
  assert.equal(view.subscribe({
    onDurableEvent: () => {},
    onLiveInput: () => {},
    onWindowReplaced: () => {},
    onWindowPrepended: () => {},
    onSessionSnapshotChanged: () => {},
    onProjectionsChanged: () => {},
  }), undefined, 'a released view never installs a new subscription')
})

test('a same-id binding rollover while the open awaits ready commits nothing and releases the reference', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  let settleReady!: (value: unknown) => void
  fixture.setReady(() => new Promise(resolve => { settleReady = resolve }))
  const reads: string[] = []
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async (id) => { reads.push(id); return snapshotOf(1) },
  })

  const opened = source.open(openTarget())
  // The retain owns generation A; a same-id replacement lands before the read.
  fixture.setBinding('child-1', childBinding(false))
  settleReady(childBinding(true))

  assert.equal(await opened, undefined, 'a rolled-over generation must never hydrate the new binding')
  assert.deepEqual(reads, [], 'the rolled-over open never reaches the reader')
  assert.deepEqual(fixture.releases, ['child-1'], 'the superseded generation is released')
})

test('a rollover during the in-flight read releases the reference and surfaces the unreadable window', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  let releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  let readStarted = false
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async () => { readStarted = true; await gate; return snapshotOf(1) },
  })

  const opened = source.open(openTarget())
  await Promise.resolve()
  assert.equal(readStarted, true, 'the read is in flight before the rollover')
  fixture.setBinding('child-1', childBinding(false))
  releaseRead()

  // A stale read is not a silently empty child: the settled generation is
  // refused and the viewer owner surfaces the unreadable window.
  await assert.rejects(opened, /the child session child-1 has no readable window/)
  assert.deepEqual(fixture.releases, ['child-1'], 'the superseded generation is released')
})

test('rehydrate returns undefined after a same-id rollover and after release', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  const reads: string[] = []
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async (id) => { reads.push(id); return snapshotOf(reads.length) },
  })
  const view = await source.open(openTarget())
  assert.ok(view !== undefined)
  assert.equal(reads.length, 1)

  const refreshed = await view.rehydrate()
  assert.equal(refreshed?.revision, 2, 'a live exact generation rehydrates normally')
  assert.equal(reads.length, 2)

  fixture.setBinding('child-1', childBinding(false))
  assert.equal(await view.rehydrate(), undefined, 'a same-id rollover reads stale')
  assert.equal(reads.length, 2, 'the rolled-over generation is refused before any reader call')

  view.release()
  assert.equal(await view.rehydrate(), undefined, 'a released view never rehydrates')
  assert.equal(reads.length, 2)
})

test('loadOlder pages the reader for the exact child and stops after release', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  const pages: string[] = []
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    loadOlder: async (id) => { pages.push(id); return snapshotOf(2) },
  })
  const view = await source.open(openTarget())
  assert.ok(view !== undefined)

  await view.loadOlder()
  assert.deepEqual(pages, ['child-1'], 'paging addresses the exact child, never the parent')

  view.release()
  await view.loadOlder()
  assert.deepEqual(pages, ['child-1'], 'a released child view never pages')
})

test('a missing readable window releases the reference and throws instead of fabricating an empty child', async () => {
  const fixture = childSessions('child-1', childBinding(true))
  const { ingress } = fakeIngress()
  const source = buildSource({
    sessions: fixture.sessions,
    ingress,
    read: async () => undefined,
  })

  await assert.rejects(source.open(openTarget()), /the child session child-1 has no readable window/)
  assert.deepEqual(fixture.releases, ['child-1'])
})

test('childWriterSubject fabricates no Remote Agent subject and retains nothing', () => {
  const fixture = childSessions('child-1', childBinding(true))
  const { ingress } = fakeIngress()
  const source = buildSource({ sessions: fixture.sessions, ingress })

  assert.equal(source.childWriterSubject('child-1'), undefined,
    'Remote has no Agent-bound writer subject; the viewer publishes its own token')
  assert.deepEqual(fixture.retains, [], 'resolving a writer subject must not acquire a reference')
})
