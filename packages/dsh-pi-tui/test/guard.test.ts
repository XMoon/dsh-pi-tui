/**
 * Headless tests for the cross-process divergence guard: stat gating,
 * divergence latching, unreadable logs, and unavailable deployments.
 * @module @xmoon76/dsh-pi-tui/guard.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { checkDivergence, freshGuardState, type GuardPersistenceLike, type GuardSessionLike, type GuardStatLike } from '../src/guard.ts'

/** A fake persistence with a controllable readFrom and read counter. */
function fakePersistence(options: {
  locate?: { kind: string; path: string } | undefined
  events?: number
  throwRead?: Error | undefined
}): GuardPersistenceLike & { reads: number; events: number } {
  const state = { reads: 0, events: options.events ?? 0 }
  return {
    get reads() {
      return state.reads
    },
    get events() {
      return state.events
    },
    set events(value) {
      state.events = value
    },
    locate: () => options.locate,
    readFrom: async () => {
      state.reads += 1
      if (options.throwRead !== undefined) throw options.throwRead
      return { events: Array.from({ length: state.events }, (_, i) => ({ seq: i })) }
    },
  }
}

/** A mutable stat probe with a call counter. */
function fakeStat(): { stat: GuardStatLike; set: (size: number, mtimeMs: number) => void; calls: number } {
  const state = { size: 100, mtimeMs: 1 }
  const calls = { count: 0 }
  return {
    get calls() {
      return calls.count
    },
    stat: () => {
      calls.count += 1
      return { size: state.size, mtimeMs: state.mtimeMs }
    },
    set: (size, mtimeMs) => {
      state.size = size
      state.mtimeMs = mtimeMs
    },
  }
}

function session(memoryEvents: number): GuardSessionLike {
  return { id: 'session-test', header: { cwd: '/work' }, events: Array.from({ length: memoryEvents }) }
}

const ARTIFACT = { kind: 'jsonl', path: '/s/session.jsonl.zstd' }

test('first check reads and reports ok when file and memory agree', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 5 })
  const stat = fakeStat()
  const outcome = await checkDivergence(persistence, session(5), stat.stat, freshGuardState())
  assert.equal(outcome.kind, 'ok')
  assert.equal(persistence.reads, 1)
})

test('unchanged file is gated by stat: no second read', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 5 })
  const stat = fakeStat()
  const state = freshGuardState()
  await checkDivergence(persistence, session(5), stat.stat, state)
  const second = await checkDivergence(persistence, session(5), stat.stat, state)
  assert.equal(second.kind, 'ok')
  assert.equal(persistence.reads, 1)
  assert.equal(stat.calls, 2)
})

test('file ahead of memory reports diverged and latches until the file changes', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 5 })
  const stat = fakeStat()
  const state = freshGuardState()
  // First check consistent at 5/5.
  assert.equal((await checkDivergence(persistence, session(5), stat.stat, state)).kind, 'ok')
  // External writer appends: file 6, memory still 5.
  persistence.events = 6
  stat.set(200, 2)
  const diverged = await checkDivergence(persistence, session(5), stat.stat, state)
  assert.equal(diverged.kind, 'diverged')
  if (diverged.kind === 'diverged') {
    assert.equal(diverged.fileEvents, 6)
    assert.equal(diverged.memoryEvents, 5)
  }
  // Unchanged file: still blocked (latched), no re-read.
  const latched = await checkDivergence(persistence, session(5), stat.stat, state)
  assert.equal(latched.kind, 'diverged')
  assert.equal(persistence.reads, 2)
  // The external writer closes: file returns to memory size → ok again.
  persistence.events = 5
  stat.set(200, 3)
  assert.equal((await checkDivergence(persistence, session(5), stat.stat, state)).kind, 'ok')
})

test('unreadable committed prefix reports unreadable and stays latched', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, throwRead: new Error('corrupt session log: seq gap') })
  const stat = fakeStat()
  const state = freshGuardState()
  const first = await checkDivergence(persistence, session(5), stat.stat, state)
  assert.equal(first.kind, 'unreadable')
  const second = await checkDivergence(persistence, session(5), stat.stat, state)
  assert.equal(second.kind, 'unreadable')
  assert.equal(persistence.reads, 1) // latched: no re-read while unchanged
})

test('own write-behind (file behind memory) is not divergence', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 4 })
  const stat = fakeStat()
  const outcome = await checkDivergence(persistence, session(5), stat.stat, freshGuardState())
  assert.equal(outcome.kind, 'ok')
})

test('missing artifact is unavailable; missing persistence is unavailable', async () => {
  const stat = fakeStat()
  const noArtifact = fakePersistence({ locate: undefined })
  const first = await checkDivergence(noArtifact, session(1), stat.stat, freshGuardState())
  assert.equal(first.kind, 'unavailable')
  if (first.kind === 'unavailable') assert.equal(first.reason, 'no-artifact')
  const noPersistence = await checkDivergence(undefined, session(1), stat.stat, freshGuardState())
  assert.equal(noPersistence.kind, 'unavailable')
  if (noPersistence.kind === 'unavailable') assert.equal(noPersistence.reason, 'no-persistence')
})

test('stat ENOENT (artifact not yet materialized) is ok', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT })
  const stat = (() => {
    const error = new Error('no such file') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }) as unknown as GuardStatLike
  const outcome = await checkDivergence(persistence, session(1), stat, freshGuardState())
  assert.equal(outcome.kind, 'ok')
})

test('stat ENOENT after a previous observation reports removed and latches', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 0 })
  const stat = fakeStat()
  const state = freshGuardState()
  // First check observes a real committed file (one full read).
  const first = await checkDivergence(persistence, session(1), stat.stat, state)
  assert.equal(first.kind, 'ok')
  assert.equal(persistence.reads, 1)
  // The log disappears externally: stat now throws ENOENT.
  const missing = (() => {
    const error = new Error('no such file') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }) as unknown as GuardStatLike
  const second = await checkDivergence(persistence, session(1), missing, state)
  assert.equal(second.kind, 'removed')
  if (second.kind === 'removed') assert.notEqual(second.revision, '')
  // Latches without another full read: still removed on the next check.
  const third = await checkDivergence(persistence, session(1), missing, state)
  assert.equal(third.kind, 'removed')
  assert.equal(persistence.reads, 1)
})

test('removed recovers when the file reappears and reads clean', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 0 })
  const stat = fakeStat()
  const state = freshGuardState()
  await checkDivergence(persistence, session(1), stat.stat, state)
  const missing = (() => {
    const error = new Error('no such file') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }) as unknown as GuardStatLike
  const removed = await checkDivergence(persistence, session(1), missing, state)
  assert.equal(removed.kind, 'removed')
  // A new file with a different revision re-enters the normal read path.
  stat.set(200, 2)
  const recovered = await checkDivergence(persistence, session(1), stat.stat, state)
  assert.equal(recovered.kind, 'ok')
})
