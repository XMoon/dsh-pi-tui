/**
 * M3-4 PR2 live-ingress contract tests (L3): the change partition, the
 * staleness fences, and the hydrate→subscribe gap recovery. These lock the
 * ingress module's own semantics; the L6 suites prove the same wiring over
 * the real wire.
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
} {
  let window = initial
  let current: RemoteLiveIngressBinding | undefined = {
    session: {
      getSnapshot: () => ({ openState: 'open' as const }),
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
  }
}

interface SinkLog {
  durable: Array<{ type: string }>
  live: Array<{ kind: string }>
  replaced: string[]
  prepended?: string[]
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

function sinksOf(log: SinkLog): RemoteLiveIngressSinks {
  return {
    onDurableEvent: (_id, event) => { log.durable.push({ type: (event as { type: string }).type }) },
    onLiveInput: input => { log.live.push(input as { kind: string }) },
    onWindowReplaced: id => { log.replaced.push(id) },
    onWindowPrepended: id => { (log.prepended ??= []).push(id) },
    onSessionSnapshotChanged: id => { log.snapshots?.push(id) },
    onProjectionsChanged: id => { log.projections?.push(id) },
  }
}

function generationSource() {
  let gen: { id: number } | undefined = { id: 1 }
  return {
    getSnapshot: () => gen,
    subscribe: () => () => {},
    replace: () => { gen = { id: 2 } },
  }
}

test('append change routes durable events and synthesizes one start per attempt tuple', () => {
  const log = { durable: [], live: [], replaced: [] }
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
  assert.deepEqual(log.replaced, [])
  handle.dispose()
})

test('a Connection generation rollover drives the authoritative re-hydrate for the SAME binding', () => {
  const log = { durable: [], live: [], replaced: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation)
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  generation.replace()
  // The rollover must NOT dead-lock the subscription: the dead generation's
  // revision numbers are forgotten, so the very next publication is processed
  // instead of being swallowed as a duplicate revision.
  source.publish({ entries: [], revision: 2, hasMore: false, change: { kind: 'append', entries: [{ type: 'event', event: { type: 'user/message', seq: 6, time: 1, data: {} } }] } })
  assert.deepEqual(log.durable, [{ type: 'user/message' }],
    'the new generation routes live again (a swallowed publication was the dead-surface defect)')
  assert.deepEqual(log.replaced, [], 'an append needs no re-hydrate')
  // The new generation's authoritative baseline REPLACE drives the re-hydrate.
  source.publish({ entries: [], revision: 3, hasMore: false, change: { kind: 'replace', entries: [] } })
  assert.deepEqual(log.replaced, ['s'],
    'the new baseline replaces the dead window and re-hydrates the presentation')
  source.publish({ entries: [], revision: 4, hasMore: false, change: { kind: 'append', entries: [{ type: 'event', event: { type: 'user/message', seq: 5, time: 1, data: {} } }] } })
  assert.deepEqual(log.durable, [{ type: 'user/message' }, { type: 'user/message' }],
    'the adopted generation routes its own publications')
  source.publish({ entries: [], revision: 4, hasMore: false, change: { kind: 'append', entries: [{ type: 'event', event: { type: 'user/message', seq: 5, time: 1, data: {} } }] } })
  assert.deepEqual(log.durable, [{ type: 'user/message' }, { type: 'user/message' }],
    'the SAME revision is never routed twice (no replay regression)')
  handle.dispose()
})

test('a same-id binding replacement detaches the subscription (exact binding identity)', () => {
  const log = { durable: [], live: [], replaced: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.replaceBinding({ ...source.getBinding()! })
  source.publish({ entries: [], revision: 2, hasMore: false, change: { kind: 'append', entries: [{ type: 'event', event: { type: 'user/message', seq: 7, time: 1, data: {} } }] } })
  assert.deepEqual(log.durable, [], 'a NEW binding object for the same id must not receive the OLD subscription')
  handle.dispose()
})

test('the hydrate→subscribe GAP is recovered through onWindowReplaced, never lost', () => {
  const log = { durable: [], live: [], replaced: [] }
  // The subscription-time revision (3) is HIGHER than the caller's hydrate
  // snapshot revision (1): an event landed in between and will never arrive
  // as an incremental change.
  const source = sourceWith({ entries: [], revision: 3, hasMore: false, change: { kind: 'append', entries: [] } })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log), 1)
  assert.ok(handle !== undefined)
  assert.deepEqual(log.replaced, ['s'],
    'the gap is surfaced as the authoritative window-replacement recovery')
  handle.dispose()
})

test('no gap: the subscription-time revision equals the hydrate revision (the normal path)', () => {
  const log = { durable: [], live: [], replaced: [] }
  const source = sourceWith({ entries: [], revision: 5, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log), 5)
  assert.ok(handle !== undefined)
  assert.deepEqual(log.replaced, [], 'no gap ⇒ no recovery')
  handle.dispose()
})

test('a settle-assistant change routes its durable settlement entry exactly once', () => {
  const log = { durable: [], live: [], replaced: [] }
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

test('a prepend change routes the front-page re-hydrate (F10: ANY official loadOlder consumer)', () => {
  // An older-history page joined the window front: the append-only folds
  // cannot take it incrementally, and the page may have been requested by
  // ANY official reader consumer (keyboard extension, /status facts
  // composition, copy paging) — so the ingress must surface it, never stay
  // silent (the silent version left the footer on the stale pre-page fold).
  const log: SinkLog = { durable: [], live: [], replaced: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: true })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({ entries: [], revision: 2, hasMore: false, change: { kind: 'prepend', entries: [{ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } }] } })
  assert.deepEqual(log.prepended ?? [], ['s'],
    'the front page routes the dedicated re-hydrate sink (never silent)')
  assert.deepEqual(log.replaced, [], 'a prepend is not a reconnect: no full re-hydrate')
  assert.deepEqual(log.durable, [], 'the front-joined events are NOT routed incrementally (the fold re-takes the whole window)')
  handle.dispose()
})

test('a replace change clears the attempt-tuple memory and triggers the re-hydrate', () => {
  const log = { durable: [], live: [], replaced: [] }
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  source.publish({ entries: [], revision: 2, hasMore: false, change: { kind: 'replace', entries: [] } })
  assert.deepEqual(log.replaced, ['s'])
  // After the replace, a NEW transient tuple synthesizes a fresh start.
  source.publish({
    entries: [],
    revision: 3,
    hasMore: false,
    change: {
      kind: 'append',
      entries: [{ type: 'transient', event: { type: 'assistant/live-chunk', time: 1, data: { attemptId: 'a2', turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'z' } } } }],
    },
  })
  assert.deepEqual(log.live.map(input => (input as { kind: string }).kind), ['start', 'chunk'],
    'a fresh attempt after the replacement restarts with a synthetic start')
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
    bootstrap.indexOf('const disposeRemoteIngress') >= 0
      ? bootstrap.indexOf('const initRemoteLiveSurface') + 2000
      : bootstrap.indexOf('const initRemoteLiveSurface') + 2600,
  )
  assert.ok(init.includes('if (hydrate === undefined) return'),
    'an uncommitted hydrate (undefined outcome) aborts BEFORE subscribing')
  assert.ok(init.includes('ownership.currentSessionId() !== sessionId || ownership.generation() !== initGeneration'),
    'an owner rollover during the hydrate await aborts BEFORE subscribing')
})

test('TUPLE BASELINE: a chunk for an ALREADY-ACTIVE tuple (seeded from the hydrated window) does NOT re-synthesize a start', () => {
  const log: SinkLog = { durable: [], live: [], replaced: [] }
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

test('TUPLE REPLACE: a chunk for a tuple present in the REPLACEMENT window does NOT re-synthesize a start', () => {
  const log: SinkLog = { durable: [], live: [], replaced: [] }
  const source = sourceWith({ entries: [transientEntry('a1', 1, 1, 0, 'old')], revision: 1, hasMore: false })
  const ingress = createRemoteLiveIngress(source.sessions, generationSource())
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  // The authoritative replacement window carries a DIFFERENT attempt (b2)
  // whose baseline the re-hydrate will synthesize: the memory must re-seed
  // from the NEW window so b2's next chunk is a bare chunk too.
  source.publish({
    entries: [transientEntry('b2', 2, 1, 0, 'replacement')],
    revision: 2,
    hasMore: false,
    change: { kind: 'replace', entries: [] } as never,
  })
  assert.deepEqual(log.replaced, ['s'], 'the replace still triggers the authoritative re-hydrate')
  source.publish({
    entries: [transientEntry('b2', 2, 1, 0, 'replacement'), transientEntry('b2', 2, 1, 1, 'next')],
    revision: 3,
    hasMore: false,
    change: appendChange([transientEntry('b2', 2, 1, 1, 'next')]),
  })
  assert.deepEqual(log.live.map(input => (input as { kind: string }).kind), ['chunk'],
    'the replacement baseline re-seeded the tuple memory (no duplicate start for b2)')
  handle.dispose()
})

test('TUPLE SETTLE: settling an attempt retires its tuple, so a later chunk may start it again', () => {
  const log: SinkLog = { durable: [], live: [], replaced: [] }
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
  // token; this locks the CONSUMER side: the bootstrap seed must stamp the
  // entry with `hydrate.transportToken`. A fresh `captureTransportToken`
  // there would let a post-fence rollover stamp the OLD fold as CURRENT.
  const { readFileSync } = await import('node:fs')
  const bootstrap = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const seedStart = bootstrap.indexOf('remoteWorkingFoldFor = {')
  assert.ok(seedStart >= 0, 'the seed site exists')
  const seed = bootstrap.slice(seedStart, bootstrap.indexOf('}', seedStart) + 1)
  assert.ok(seed.includes('transportToken: hydrate.transportToken'),
    'the seed stamps the token the HYDRATE was fenced under')
  assert.ok(!seed.includes('captureTransportToken'),
    'the seed must NOT re-capture the transport identity at seed time')
  assert.ok(seed.includes('generation: initGeneration') && seed.includes('sessionId,'),
    'the owner fence travels with the seed')
})

test('a projection change reaches the sink through the per-key faces, coalesced, and a stale generation detaches', async () => {
  const source = sourceWith({ entries: [], revision: 1, hasMore: false })
  const generation = generationSource()
  const ingress = createRemoteLiveIngress(source.sessions, generation, ['title', 'tokenUsage'])
  const log: SinkLog = { durable: [], live: [], replaced: [], projections: [] }
  const handle = ingress.subscribe('s', sinksOf(log))
  assert.ok(handle !== undefined)
  assert.equal(source.projectionKeyCount(), 2,
    'the ingress follows exactly the current-fact keys it was given (per-key faces)')
  // ONE Host frame updating both keys must coalesce into ONE refresh.
  source.publishProjection('title')
  source.publishProjection('tokenUsage')
  await Promise.resolve()
  assert.deepEqual(log.projections, ['s'], 'coalesced into one projection refresh')
  // A later frame refreshes again.
  source.publishProjection('title')
  await Promise.resolve()
  assert.deepEqual(log.projections, ['s', 's'])
  // A Connection generation rollover does NOT retire the retained binding: the
  // projection faces read LIVE store values, so the rollover re-hydrates (the
  // window channel) while these value notifications keep flowing.
  generation.replace()
  source.publishProjection('title')
  await Promise.resolve()
  assert.deepEqual(log.projections, ['s', 's', 's'],
    'a value channel reads live state: a rollover neither detaches it nor leaks a stale value')
  handle.dispose()
})
