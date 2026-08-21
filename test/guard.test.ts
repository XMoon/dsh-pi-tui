/**
 * Headless tests for the cross-process divergence guard: stat gating,
 * divergence latching, unreadable logs, unavailable deployments, tail
 * identity comparison, and the one-time force token.
 * @module @xmoon76/dsh-pi-tui/guard.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkDivergence,
  draftFingerprint,
  forceTokenAllows,
  freshGuardState,
  mintForceToken,
  savePayloadIdentity,
  type GuardAction,
  type GuardForceToken,
  type GuardPersistenceLike,
  type GuardSessionLike,
  type GuardStatLike,
} from '../src/guard.ts'

/** A fake persistence with a controllable readFrom and read counter. The
 * committed log holds `events` well-formed events; `tail` replaces the last
 * one (a same-count rewrite by another writer). */
function fakePersistence(options: {
  locate?: { kind: string; path: string } | undefined
  events?: number
  tail?: unknown
  throwRead?: Error | undefined
}): GuardPersistenceLike & { reads: number; events: number; tail: unknown } {
  const state = { reads: 0, events: options.events ?? 0, tail: options.tail }
  const build = (): unknown[] => {
    const log: unknown[] = Array.from({ length: state.events }, (_, i) => ({ seq: i, type: 'user/message', time: 0, data: { text: `event-${i}` } }))
    if (state.tail !== undefined && log.length > 0) log[log.length - 1] = state.tail
    return log
  }
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
    get tail() {
      return state.tail
    },
    set tail(value) {
      state.tail = value
    },
    locate: () => options.locate,
    readFrom: async () => {
      state.reads += 1
      if (options.throwRead !== undefined) throw options.throwRead
      return { events: build() }
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

/** A session whose memory events mirror the fake file's well-formed shape. */
function sessionWithEvents(count: number): GuardSessionLike {
  return {
    id: 'session-test',
    header: { cwd: '/work' },
    events: Array.from({ length: count }, (_, i) => ({ seq: i, type: 'user/message', time: 0, data: { text: `event-${i}` } })),
  }
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

// --- tail identity comparison (same count, different tail) ---

const OTHER_TAIL = { seq: 4, type: 'user/message', time: 0, data: { text: 'written-by-another-process' } }

test('same event count but a different tail reports tail-mismatch', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 5, tail: OTHER_TAIL })
  const stat = fakeStat()
  const state = freshGuardState()
  const first = await checkDivergence(persistence, sessionWithEvents(5), stat.stat, state)
  assert.equal(first.kind, 'tail-mismatch')
  if (first.kind === 'tail-mismatch') {
    assert.equal(first.fileEvents, 5)
    assert.equal(first.memoryEvents, 5)
    assert.ok(first.fileTail.startsWith('4:user/message:'), `fileTail shape: ${first.fileTail}`)
    assert.ok(first.memoryTail.startsWith('4:user/message:'), `memoryTail shape: ${first.memoryTail}`)
    assert.notEqual(first.fileTail, first.memoryTail)
    // The tail identities must not leak the event content.
    assert.ok(!first.fileTail.includes('another-process'), `fileTail leaked content: ${first.fileTail}`)
    assert.ok(!first.memoryTail.includes('event-4'), `memoryTail leaked content: ${first.memoryTail}`)
  }
  // Latched: unchanged file keeps reporting tail-mismatch without a re-read.
  const second = await checkDivergence(persistence, sessionWithEvents(5), stat.stat, state)
  assert.equal(second.kind, 'tail-mismatch')
  assert.equal(persistence.reads, 1)
  // The external rewrite is undone: the file's tail matches memory again.
  persistence.tail = undefined
  stat.set(200, 2)
  assert.equal((await checkDivergence(persistence, sessionWithEvents(5), stat.stat, state)).kind, 'ok')
})

test('same count and matching tail stays ok', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 5 })
  const stat = fakeStat()
  const outcome = await checkDivergence(persistence, sessionWithEvents(5), stat.stat, freshGuardState())
  assert.equal(outcome.kind, 'ok')
})

test('own write-behind (file behind memory) with matching prefix tail stays ok', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 3 })
  const stat = fakeStat()
  const outcome = await checkDivergence(persistence, sessionWithEvents(5), stat.stat, freshGuardState())
  assert.equal(outcome.kind, 'ok')
})

test('file behind memory with a DIFFERENT prefix tail reports tail-mismatch', async () => {
  const persistence = fakePersistence({ locate: ARTIFACT, events: 3, tail: OTHER_TAIL })
  const stat = fakeStat()
  const outcome = await checkDivergence(persistence, sessionWithEvents(5), stat.stat, freshGuardState())
  assert.equal(outcome.kind, 'tail-mismatch')
})

// --- one-time force token ---

function makeToken(overrides: Partial<{ sessionId: string; revision: string; action: GuardAction; draft: string }> = {}): GuardForceToken {
  return mintForceToken({
    sessionId: overrides.sessionId ?? 'session-test',
    revision: overrides.revision ?? '100:1',
    action: overrides.action ?? 'submit',
    draftFingerprint: draftFingerprint(overrides.draft ?? 'hello'),
  })
}

function candidate(overrides: Partial<{ sessionId: string; revision: string; action: GuardAction; draft: string }> = {}): {
  sessionId: string
  revision: string
  action: GuardAction
  draftFingerprint: string
} {
  return {
    sessionId: overrides.sessionId ?? 'session-test',
    revision: overrides.revision ?? '100:1',
    action: overrides.action ?? 'submit',
    draftFingerprint: draftFingerprint(overrides.draft ?? 'hello'),
  }
}

/** The runner's force-or-block loop, exactly as index.ts composes it. */
function runGuardFlow(): { send: (action: GuardAction, draft: string) => 'blocked' | 'forced' } {
  let token: GuardForceToken | undefined
  return {
    send: (action, draft) => {
      const c = candidate({ action, draft })
      if (forceTokenAllows(token, c)) {
        token = undefined
        return 'forced'
      }
      token = mintForceToken(c)
      return 'blocked'
    },
  }
}

test('blocked → identical second action forces → token consumed (third blocks again)', () => {
  const flow = runGuardFlow()
  assert.equal(flow.send('submit', 'hello'), 'blocked')
  assert.equal(flow.send('submit', 'hello'), 'forced')
  // The token was consumed: no free pass for a third identical send.
  assert.equal(flow.send('submit', 'hello'), 'blocked')
  assert.equal(flow.send('submit', 'hello'), 'forced')
})

test('a submit token cannot force a Ctrl+S save, and vice versa', () => {
  assert.equal(forceTokenAllows(makeToken({ action: 'submit' }), candidate({ action: 'save' })), false)
  assert.equal(forceTokenAllows(makeToken({ action: 'save' }), candidate({ action: 'submit' })), false)
  assert.equal(forceTokenAllows(makeToken({ action: 'save' }), candidate({ action: 'save' })), true)
})

test('an edited draft invalidates the token (fingerprint mismatch)', () => {
  const token = makeToken({ draft: 'hello' })
  assert.equal(forceTokenAllows(token, candidate({ draft: 'hello' })), true)
  assert.equal(forceTokenAllows(token, candidate({ draft: 'hello world' })), false)
})

test('a changed file revision invalidates the token', () => {
  const token = makeToken({ revision: '100:1' })
  assert.equal(forceTokenAllows(token, candidate({ revision: '100:1' })), true)
  assert.equal(forceTokenAllows(token, candidate({ revision: '120:2' })), false)
})

test('a different session invalidates the token', () => {
  const token = makeToken({ sessionId: 'session-a' })
  assert.equal(forceTokenAllows(token, candidate({ sessionId: 'session-b' })), false)
})

test('an undefined token never forces', () => {
  assert.equal(forceTokenAllows(undefined, candidate()), false)
})

test('draft fingerprints are stable, differ per draft, and do not contain the draft', () => {
  const a = draftFingerprint('hello')
  assert.equal(draftFingerprint('hello'), a)
  assert.notEqual(draftFingerprint('hello world'), a)
  assert.ok(!a.includes('hello'))
  assert.match(a, /^[0-9a-f]{16}$/)
})

test('savePayloadIdentity covers queue order and draft, never the message content', () => {
  const m = (id: string): { id: string } => ({ id })
  assert.equal(savePayloadIdentity([], 'hi'), '|hi')
  assert.equal(savePayloadIdentity([m('a')], 'hi'), 'a|hi')
  assert.equal(savePayloadIdentity([m('a'), m('b')], 'hi'), 'a,b|hi')
  // Any queue change — add, remove, reorder — changes the identity.
  assert.notEqual(savePayloadIdentity([m('a')], 'hi'), savePayloadIdentity([m('a'), m('c')], 'hi'))
  assert.notEqual(savePayloadIdentity([m('a'), m('b')], 'hi'), savePayloadIdentity([m('b'), m('a')], 'hi'))
  // A changed draft changes the identity too.
  assert.notEqual(savePayloadIdentity([m('a')], 'hi'), savePayloadIdentity([m('a')], 'bye'))
  // Only message IDs participate — the message body never feeds the
  // identity, so nothing sensitive reaches the fingerprint.
  assert.equal(savePayloadIdentity([m('id-only')], ''), 'id-only|')
  assert.equal(savePayloadIdentity([{ id: 'x' }, { id: 'y' }], 'draft'), 'x,y|draft')
})

test('a changed queue payload invalidates the save token (fingerprint mismatch)', () => {
  const payload = (queued: readonly { id: string }[], draft: string): string =>
    draftFingerprint(savePayloadIdentity(queued, draft))
  const base = { sessionId: 'session-s', revision: 'r1', action: 'save' as GuardAction }
  const token = mintForceToken({ ...base, draftFingerprint: payload([{ id: 'a' }, { id: 'b' }], 'hi') })
  // The identical payload still forces (second identical Ctrl+S).
  assert.equal(forceTokenAllows(token, { ...base, draftFingerprint: payload([{ id: 'a' }, { id: 'b' }], 'hi') }), true)
  // A queue splice between the block and the retry invalidates the token:
  // the second Ctrl+S would steer a DIFFERENT payload — it must re-block.
  assert.equal(forceTokenAllows(token, { ...base, draftFingerprint: payload([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'hi') }), false, 'an added queued message must invalidate the token')
  assert.equal(forceTokenAllows(token, { ...base, draftFingerprint: payload([{ id: 'a' }], 'hi') }), false, 'a removed queued message must invalidate the token')
  assert.equal(forceTokenAllows(token, { ...base, draftFingerprint: payload([{ id: 'b' }, { id: 'a' }], 'hi') }), false, 'a reordered queue must invalidate the token')
  assert.equal(forceTokenAllows(token, { ...base, draftFingerprint: payload([{ id: 'a' }, { id: 'b' }], 'bye') }), false, 'an edited draft must invalidate the token')
})
