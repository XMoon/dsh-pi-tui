/**
 * M3-4 PR2 / S3-R0 live-ingress contract tests (L3): the change partition, the
 * staleness fences, the hydrate→subscribe gap recovery, and the S3-R0
 * **delivery-sequence contract** — an incremental change is only a valid fold
 * input while it is CONTIGUOUS with what the fold holds; every generation
 * rollover, revision discontinuity, window replace/prepend, missing change or
 * hydrate gap enters `recovering`, suppresses partial delivery, and asks the
 * fold owner to reconcile the current official window before it acknowledges
 * the committed revision.
 *
 * These lock the ingress module's own semantics; the L5/L6 suites prove the
 * same wiring over the real wire (official Host → Client binding → ingress →
 * main/child fold → viewport).
 *
 * @module @xmoon76/dsh-pi-tui/remote-live-ingress.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteLiveIngress, type RemoteLiveIngressBinding, type RemoteLiveIngressSinks, type RemoteLiveIngressSessions } from '../src/app/remote/live-ingress.ts'

interface WindowState {
  entries: Array<{ type: 'event'; event: unknown } | { type: 'transient'; event: unknown }>
  revision: number
  hasMore: boolean
  change?: { kind: string; entries?: unknown[]; attemptId?: string; entry?: { type: 'event'; event: unknown } }
}

function sourceWith(initial: WindowState): {
  sessions: RemoteLiveIngressSessions
  binding: RemoteLiveIngressBinding
  publish(next: WindowState): void
  publishSnapshot(): void
  publishProjection(key: string): void
  projectionKeyCount(): number
  replaceBinding(withBinding: RemoteLiveIngressBinding | undefined): void
  getBinding(): RemoteLiveIngressBinding | undefined
  setOpenState(state: 'cold' | 'loading' | 'open' | 'error'): void
} {
  let window = initial
  let openState: 'cold' | 'loading' | 'open' | 'error' = 'open'
  let current: RemoteLiveIngressBinding | undefined = {
    session: {
      getSnapshot: () => ({ openState }),
      subscribe: (listener: () => void) => {
        snapshotListeners.add(listener)
        return () => { snapshotListeners.delete(listener) }
      },
      projections: {
        faceOf: (key: string) => ({
          subscribe: (listener: () => void) => {
            projectionListeners.get(key)?.add(listener) ?? projectionListeners.set(key, new Set([listener]))
            return () => { projectionListeners.get(key)?.delete(listener) }
          },
        }),
      },
    },
    eventSource: {
      getSnapshot: () => window as never,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
  const listeners = new Set<() => void>()
  const snapshotListeners = new Set<() => void>()
  const projectionListeners = new Map<string, Set<() => void>>()
  return {
    sessions: { binding: () => current },
    binding: current,
    publish(next) {
      window = next
      for (const listener of listeners) listener()
    },
    publishSnapshot() {
      for (const listener of snapshotListeners) listener()
    },
    publishProjection(key) {
      for (const listener of projectionListeners.get(key) ?? []) listener()
    },
    projectionKeyCount: () => projectionListeners.size,
    replaceBinding(withBinding) { current = withBinding },
    getBinding: () => current,
    setOpenState(state) {
      openState = state
      for (const listener of snapshotListeners) listener()
    },
  }
}

interface SinkLog {
  durable: Array<{ type: string }>
  live: Array<{ kind: string }>
  /** The unified recovery wakeups (`onWindowRefoldRequired`). */
  refolds: string[]
  snapshots?: string[]
  projections?: string[]
}

function transientEntry(attemptId: string, turn: number, step: number, index: number, text: string) {
  return {
    type: 'transient' as const,
    event: {
      type: 'assistant/live-chunk' as const,
      seq: 0,
      time: 1,
      data: { attemptId, turn, step, chunk: { type: 'text-delta', index, text } },
    },
  }
}

function appendChange(entries: unknown[]) {
  return { kind: 'append', entries } as never
}

function durableEntry(type: string, seq: number) {
  return { type: 'event', event: { type, seq, time: 1, data: {} } }
}

function sinksOf(log: SinkLog): RemoteLiveIngressSinks {
  return {
    onDurableEvent: (_id, event) => { log.durable.push({ type: (event as { type: string }).type }) },
    onLiveInput: input => { log.live.push(input as { kind: string }) },
    onWindowRefoldRequired: id => { log.refolds.push(id) },
    onSessionSnapshotChanged: id => { log.snapshots?.push(id) },
    onProjectionsChanged: id => { log.projections?.push(id) },
  }
}

function generationSource() {
  let gen: { id: number } | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => gen,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    replace: (id = 2) => {
      gen = { id }
      for (const listener of [...listeners]) listener()
    },
    drop: () => {
      gen = undefined
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The recovery wakeup is deferred by exactly one microtask (reentrancy rule),
 *  so every recovery assertion flushes it first. */
async function flushWakeup(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** The exact ACK proof shape (see `PresentationWindowRefoldProof`). */
function proofOf(
  source: ReturnType<typeof sourceWith>,
  generation: ReturnType<typeof generationSource>,
  revision: number,
): { generation: unknown; binding: unknown; revision: number } {
  return { generation: generation.getSnapshot(), binding: source.getBinding(), revision }
}

test('append change routes durable events and synthesizes one start per attempt tuple', () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({
    entries: [],
    revision: 2,
    hasMore: false,
    change: {
      kind: 'append',
      entries: [
        { type: 'transient', event: { type: 'assistant/live-chunk', time: 1, data: { attemptId: 'a1', turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } } },
        { type: 'transient', event: { type: 'assistant/live-chunk', time: 2, data: { attemptId: 'a1', turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'y' } } } },
        { type: 'event', event: { type: 'user/message', seq: 5, time: 3, data: {} } },
      ],
    },
  })
  assert.deepEqual(log.live.map(input => (input as { kind: string }).kind), ['start', 'chunk', 'chunk'],
    'one synthetic start per attempt tuple, then chunks')
  assert.deepEqual(log.durable.map(event => (event as { type: string }).type), ['user/message'])
  assert.deepEqual(log.refolds, [])
  handle.dispose()
})

test('R0: a Connection generation rollover NEVER delivers a partial increment as if it were whole', async () => {
  // The upstream eventSource contract (dsh-v0.2.1-rc.2
  // `api/session-controller/src/client/contract/events.ts`) defines the window
  // as the CURRENT complete contiguous window and `change` as the LAST
  // synchronous delta: an append-only change after a rollover carries ONE
  // entry, never the whole missing turn. Delivering it as if the fold were
  // current is exactly the S3-R0 defect (footer moves, transcript stays on the
  // dead window), so a rollover must always reconcile the full window.
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  generation.replace()
  source.publish({ entries: [], revision: 2, hasMore: false, change: appendChange([durableEntry('user/message', 6)]) })
  assert.deepEqual(log.durable, [], 'no partial increment may reach the fold across a rollover')
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'], 'a generation rollover requires the full-window reconcile')
  handle.dispose()
})

test('R0: a same-generation revision discontinuity requires the full-window reconcile', async () => {
  // A skipped revision means the intervening deltas are unobservable: the
  // window is authoritative, the latest change is not.
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 2, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({ entries: [], revision: 5, hasMore: false, change: appendChange([durableEntry('user/message', 9)]) })
  assert.deepEqual(log.durable, [], 'the partial delta of a jumped revision is not a fold input')
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'], 'a revision jump (2 -> 5) is a gap, not an increment')
  handle.dispose()
})

test('R0: continuous same-generation appends stay incremental (no over-triggered refold)', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  for (const revision of [2, 3, 4]) {
    source.publish({ entries: [], revision, hasMore: false, change: appendChange([durableEntry('user/message', revision)]) })
  }
  await flushWakeup()
  assert.deepEqual(log.refolds, [], 'a contiguous append sequence is the normal incremental path')
  assert.deepEqual(log.durable.map(event => (event as { type: string }).type),
    ['user/message', 'user/message', 'user/message'])
  handle.dispose()
})

test('R0: the acknowledge resumes incremental delivery, and a stale revision never does', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  generation.replace()
  source.publish({ entries: [], revision: 2, hasMore: false, change: appendChange([durableEntry('user/message', 6)]) })
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'])
  // While recovering, further increments are suppressed even when contiguous.
  source.publish({ entries: [], revision: 3, hasMore: false, change: appendChange([durableEntry('user/message', 7)]) })
  assert.deepEqual(log.durable, [], 'recovering suppresses every partial increment')
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s', 's'], 'a newer revision re-arms the wakeup (no lost wakeup)')
  // A stale proof (revision already superseded) must not resume delivery.
  assert.equal(handle.acknowledgeWindowRefold(proofOf(source, generation, 2)), false,
    'a superseded revision cannot acknowledge the recovery')
  assert.equal(handle.acknowledgeWindowRefold(proofOf(source, generation, 3)), true,
    'the committed revision acknowledges and resumes')
  source.publish({ entries: [], revision: 4, hasMore: false, change: appendChange([durableEntry('user/message', 8)]) })
  assert.deepEqual(log.durable.map(event => (event as { type: string }).type), ['user/message'],
    'delivery resumes from the acknowledged revision')
  handle.dispose()
})

test('R0: the acknowledge validates the EXACT binding and Connection generation identity', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({ entries: [], revision: 5, hasMore: false, change: appendChange([durableEntry('user/message', 5)]) })
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'])
  assert.equal(handle.acknowledgeWindowRefold({ generation: generation.getSnapshot(), binding: {}, revision: 5 }), false,
    'a different binding object can never acknowledge this handle')
  assert.equal(handle.acknowledgeWindowRefold({ generation: { id: 99 }, binding: source.getBinding(), revision: 5 }), false,
    'a different Connection generation object can never acknowledge this handle')
  // A closed/loading Session cannot acknowledge either.
  source.setOpenState('loading')
  assert.equal(handle.acknowledgeWindowRefold(proofOf(source, generation, 5)), false,
    'a Session that is not open cannot acknowledge the recovery')
  source.setOpenState('open')
  assert.equal(handle.acknowledgeWindowRefold(proofOf(source, generation, 5)), true)
  handle.dispose()
})

test('R0: a disposed handle acknowledges nothing and publishes nothing', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({ entries: [], revision: 4, hasMore: false, change: appendChange([durableEntry('user/message', 4)]) })
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'])
  handle.dispose()
  assert.equal(handle.acknowledgeWindowRefold(proofOf(source, generation, 4)), false,
    'a disposed handle cannot acknowledge')
  generation.replace(3)
  source.publish({ entries: [], revision: 5, hasMore: false, change: appendChange([durableEntry('user/message', 5)]) })
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'], 'a disposed handle never wakes the owner again')
  assert.deepEqual(log.durable, [], 'a disposed handle never delivers')
})

test('R0: a rollover observed on the GENERATION channel wakes the owner without any publication', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 4, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  generation.replace()
  // No eventSource publication at all: the new generation may not have opened
  // its window yet, but the delivered sequence is already void.
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'], 'the generation channel alone is a recovery trigger')
  handle.dispose()
})

test('R0: the loading→open transition re-arms an unsettled recovery at the same revision', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 2, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log), 1)
  assert.ok(handle !== undefined)
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'], 'the hydrate gap is the first wakeup')
  // No acknowledgement: the owner could not fold yet. The official Session
  // becoming OPEN is the next real signal (not a timer).
  source.setOpenState('loading')
  source.setOpenState('open')
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s', 's'], 'the open transition re-wakes the unsettled recovery')
  handle.dispose()
})

test('the hydrate→subscribe GAP is recovered through onWindowRefoldRequired, never lost', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  // The subscription-time revision (3) is HIGHER than the caller's hydrate
  // snapshot revision (1): an event landed in between and will never arrive
  // as an incremental change.
  const source = sourceWith({ entries: [], revision: 3, hasMore: false, change: { kind: 'append', entries: [] } })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log), 1)
  assert.ok(handle !== undefined)
  // The wakeup is deferred by exactly one microtask: the caller's
  // `handle = subscribe(...)` assignment must complete before the owner may
  // start an async re-fold (reentrancy), so it is not observable synchronously.
  assert.deepEqual(log.refolds, [], 'the wakeup never precedes the handle assignment')
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'],
    'the gap is surfaced as the authoritative window-recovery requirement')
  handle.dispose()
})

test('no gap: the subscription-time revision equals the hydrate revision (the normal path)', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 5, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log), 5)
  assert.ok(handle !== undefined)
  await flushWakeup()
  assert.deepEqual(log.refolds, [], 'no gap ⇒ no recovery')
  handle.dispose()
})

test('a settle-assistant change routes its durable settlement entry exactly once', () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({
    entries: [],
    revision: 2,
    hasMore: false,
    change: { kind: 'settle-assistant', attemptId: 'a1', entry: { type: 'event', event: { type: 'assistant/message', seq: 9, time: 1, data: {} } } },
  })
  assert.deepEqual(log.durable.map(event => (event as { type: string }).type), ['assistant/message'],
    'the settlement durable entry routes through the ordinary durable plane')
  handle.dispose()
})

test('a prepend change requires the front-page window reconcile (F10: ANY official loadOlder consumer)', async () => {
  // An older-history page joined the window front: the append-only folds
  // cannot take it incrementally, and the page may have been requested by
  // ANY official reader consumer (keyboard extension, /status facts
  // composition, copy paging) — so the ingress must surface it, never stay
  // silent (the silent version left the footer on the stale pre-page fold).
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: true })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({ entries: [], revision: 2, hasMore: false, change: { kind: 'prepend', entries: [durableEntry('user/message', 1)] } })
  assert.deepEqual(log.durable, [], 'the front-joined events are NOT routed incrementally (the fold re-takes the whole window)')
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'], 'a prepend joins the front: the fold must re-fold the widened window')
  handle.dispose()
})

test('a replace change requires the window reconcile and re-seeds the tuple memory on acknowledge', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [transientEntry('a1', 1, 1, 0, 'old')], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  // The authoritative replacement window carries a DIFFERENT attempt (b2)
  // whose baseline the owner's re-fold will synthesize: the tuple memory must
  // re-seed from the NEW window so b2's next chunk is a bare chunk too.
  source.publish({
    entries: [transientEntry('b2', 2, 1, 0, 'replacement')],
    revision: 2,
    hasMore: false,
    change: { kind: 'replace', entries: [] } as never,
  })
  await flushWakeup()
  assert.deepEqual(log.refolds, ['s'], 'the replace requires the authoritative window reconcile')
  assert.equal(handle.acknowledgeWindowRefold(proofOf(source, generation, 2)), true)
  source.publish({
    entries: [transientEntry('b2', 2, 1, 0, 'replacement'), transientEntry('b2', 2, 1, 1, 'next')],
    revision: 3,
    hasMore: false,
    change: appendChange([transientEntry('b2', 2, 1, 1, 'next')]),
  })
  assert.deepEqual(log.live.map(input => (input as { kind: string }).kind), ['chunk'],
    'the acknowledge re-seeded the tuple memory from the replacement window (no duplicate start for b2)')
  handle.dispose()
})

test('R0: no live generation or no retained binding means NO subscription (the owner retries on its next commit)', () => {
  // C7: the ingress never installs a subscription it cannot fence. The caller's
  // owner commit/acquire path is the only place that re-subscribes, so there is
  // never a second, unowned publisher.
  const missingGeneration = generationSource()
  missingGeneration.drop()
  const sourceA = sourceWith({ entries: [], revision: 1, hasMore: false })
  const ingressA = createRemoteLiveIngress(sourceA.sessions, missingGeneration)
  assert.equal(ingressA.subscribe('s', sinksOf({ durable: [], live: [], refolds: [] })), undefined,
    'no Connection generation → no subscription')
  const sourceB = sourceWith({ entries: [], revision: 1, hasMore: false })
  sourceB.replaceBinding(undefined)
  const ingressB = createRemoteLiveIngress(sourceB.sessions, generationSource())
  assert.equal(ingressB.subscribe('s', sinksOf({ durable: [], live: [], refolds: [] })), undefined,
    'no retained binding → no subscription')
})

test('a same-id binding replacement detaches the subscription (exact binding identity)', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  const oldBinding = source.getBinding()!
  source.replaceBinding({ ...oldBinding })
  source.publish({ entries: [], revision: 2, hasMore: false, change: appendChange([durableEntry('user/message', 7)]) })
  await flushWakeup()
  assert.deepEqual(log.durable, [], 'a NEW binding object for the same id must not receive the OLD subscription')
  assert.deepEqual(log.refolds, [], 'a detached handle never wakes the owner')
  assert.equal(handle.acknowledgeWindowRefold({ generation: generation.getSnapshot(), binding: oldBinding, revision: 2 }), false,
    'the replaced binding can never acknowledge')
  handle.dispose()
})

test('a duplicate revision is never routed twice (no replay regression)', () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  const change = appendChange([durableEntry('user/message', 6)])
  source.publish({ entries: [], revision: 2, hasMore: false, change })
  source.publish({ entries: [], revision: 2, hasMore: false, change })
  assert.deepEqual(log.durable.map(event => (event as { type: string }).type), ['user/message'])
  handle.dispose()
})

test('the bootstrap caller-side abort rule is present in source (subscribe never runs for a dropped hydrate)', async () => {
  // The caller-side rule lives in app/bootstrap.ts (initRemoteLiveSurface):
  // an undefined hydrateRevision (fence-dropped commit) or an owner rollover
  // during the await RETURNS BEFORE liveIngress.subscribe. This module-level
  // test cannot execute bootstrap; it locks the rule's source shape, and the
  // runtime behavior is exercised by the L6 suites over the real runner.
  const { readFileSync } = await import('node:fs')
  const bootstrap = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const init = bootstrap.slice(
    bootstrap.indexOf('const initRemoteLiveSurface'),
    bootstrap.indexOf('const initRemoteLiveSurface') + 2600,
  )
  assert.ok(init.includes('if (hydrate === undefined) return'),
    'an uncommitted hydrate (undefined outcome) aborts BEFORE subscribing')
  assert.ok(init.includes('ownership.currentSessionId() !== sessionId || ownership.generation() !== initGeneration'),
    'an owner rollover during the hydrate await aborts BEFORE subscribing')
})

test('TUPLE BASELINE: a chunk for an ALREADY-ACTIVE tuple (seeded from the hydrated window) does NOT re-synthesize a start', () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  // The window ALREADY carries tuple a1's transient baseline: the cold
  // hydrate synthesized+applied its start. A chunk published afterwards must
  // arrive as a bare chunk — a duplicate start would reset the attempt's
  // live blocks (transcript.ts) and drop painted transient text.
  const source = sourceWith({
    entries: [transientEntry('a1', 1, 1, 0, 'first')],
    revision: 1,
    hasMore: false,
  })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({
    entries: [transientEntry('a1', 1, 1, 0, 'first'), transientEntry('a1', 1, 1, 1, 'second')],
    revision: 2,
    hasMore: false,
    change: appendChange([transientEntry('a1', 1, 1, 1, 'second')]),
  })
  assert.deepEqual(log.live.map(input => (input as { kind: string }).kind), ['chunk'],
    'an already-active tuple resumes with a chunk — never a second start')
  handle.dispose()
})

test('TUPLE SETTLE: settling an attempt retires its tuple, so a later chunk may start it again', () => {
  const log: SinkLog = { durable: [], live: [], refolds: [] }
  const source = sourceWith({ entries: [transientEntry('a1', 1, 1, 0, 'live')], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  // The settlement retires a1's tuple keys (set hygiene).
  source.publish({
    entries: [],
    revision: 2,
    hasMore: false,
    change: { kind: 'settle-assistant', attemptId: 'a1', entry: { type: 'event', event: { type: 'assistant/message', seq: 9, time: 1, data: {} } } } as never,
  })
  assert.deepEqual(log.durable.map(event => (event as { type: string }).type), ['assistant/message'])
  // A LATER chunk naming a1 finds no live tuple: it re-synthesizes a start
  // (the settled attempt's transient plane restarted — bounded by the
  // folder's completed-turn replay guard downstream).
  source.publish({
    entries: [transientEntry('a1', 1, 1, 0, 'late')],
    revision: 3,
    hasMore: false,
    change: appendChange([transientEntry('a1', 1, 1, 0, 'late')]),
  })
  assert.deepEqual(log.live.map(input => (input as { kind: string }).kind), ['start', 'chunk'],
    'a retired tuple restarts with a synthetic start (retirement is real)')
  handle.dispose()
})

test('the compaction cache SEED uses the hydrate outcome token, never a fresh capture (source lock)', async () => {
  // The presentation-level regression proves the outcome carries the fenced
  // token; this locks the CONSUMER side: the composition root's seed stamp must
  // carry `hydrate.transportToken`. A fresh `captureTransportToken` there would
  // let a post-fence rollover stamp the OLD fold as CURRENT. TS2 §13 moved the
  // fold's STORAGE into `app/bootstrap/session-startup.ts`
  // (`seedWorkingFold`), but the seed site — the fact this lock is about — is
  // still the composition root.
  const { readFileSync } = await import('node:fs')
  const bootstrap = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const seedStart = bootstrap.indexOf('seedWorkingFold({')
  assert.ok(seedStart >= 0, 'the seed site exists')
  const seedEnd = bootstrap.indexOf('})', seedStart)
  assert.ok(seedEnd > seedStart, 'the seed entry literal is closed')
  const seed = bootstrap.slice(seedStart, seedEnd + 2)
  assert.ok(seed.includes('transportToken: hydrate.transportToken'),
    'the seed must carry the hydrate outcome token, never a fresh capture')
})

test('a projection change reaches the sink through the per-key faces, coalesced, and a stale generation detaches', async () => {
  const log: SinkLog = { durable: [], live: [], refolds: [], projections: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation, ['model'])
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publishProjection('model')
  source.publishProjection('model')
  await Promise.resolve()
  assert.deepEqual(log.projections, ['s'], 'one Host frame coalesces into one projection refresh')
  assert.equal(source.projectionKeyCount(), 1, 'only the declared keys are followed')
  source.replaceBinding({ ...source.getBinding()! })
  source.publishProjection('model')
  await Promise.resolve()
  assert.deepEqual(log.projections, ['s'], 'a replaced binding detaches the projection subscription too')
  handle.dispose()
})
