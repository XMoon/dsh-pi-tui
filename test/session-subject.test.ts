/**
 * Unit tests for the opaque session-subject authority (A2 §9.6): identity is
 * the exact owner object AND the generation, never the session id and never the
 * token object; the authority reads the live slot on every call.
 * @module @xmoon76/dsh-pi-tui/session-subject.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSessionSubjectAuthority,
  type SessionSubject,
  type SessionOwnerRef,
  type SessionSubjectRecord,
} from '../src/app/session/subject.ts'

/** A mutable stand-in for the runtime's single owner/generation slot. */
function slot(initial: SessionSubjectRecord | undefined) {
  let record = initial
  return {
    peek: () => record,
    set: (next: SessionSubjectRecord | undefined) => { record = next },
  }
}

test('a sessionless slot captures no subject and keeps nothing current', () => {
  const authority = createSessionSubjectAuthority(slot(undefined).peek)
  assert.equal(authority.current(), undefined)
  assert.equal(authority.capture(), undefined)
  assert.equal(authority.isCurrent({} as SessionSubject), false)
})

test('a captured subject stays current while the exact owner and generation are unchanged', () => {
  const owner = { session: { id: 's1' } } as unknown as SessionOwnerRef
  const live = slot({ owner, generation: 3 })
  const authority = createSessionSubjectAuthority(live.peek)
  const captured = authority.capture()
  assert.notEqual(captured, undefined)
  assert.equal(authority.isCurrent(captured!), true)
  assert.equal(authority.isCurrent(authority.current()!), true)
  // Distinct tokens, same pinned record.
  assert.notEqual(authority.capture(), captured)
  assert.equal(authority.isCurrent(authority.capture()!), true)
})

test('the same owner on a NEW generation invalidates the old subject (re-retain fence)', () => {
  const owner = { session: { id: 's1' } } as unknown as SessionOwnerRef
  const live = slot({ owner, generation: 1 })
  const authority = createSessionSubjectAuthority(live.peek)
  const captured = authority.capture()
  live.set({ owner, generation: 2 })
  assert.equal(authority.isCurrent(captured!), false)
  assert.equal(authority.isCurrent(authority.capture()!), true)
})

test('a different owner with the same session id and generation is not current (exact object identity)', () => {
  const live = slot({ owner: { session: { id: 's1' } } as unknown as SessionOwnerRef, generation: 5 })
  const authority = createSessionSubjectAuthority(live.peek)
  const captured = authority.capture()
  live.set({ owner: { session: { id: 's1' } } as unknown as SessionOwnerRef, generation: 5 })
  assert.equal(authority.isCurrent(captured!), false)
})

test('currentness reflects the LIVE slot on every call, never a capture-time snapshot', () => {
  const owner = { session: { id: 's1' } } as unknown as SessionOwnerRef
  const live = slot({ owner, generation: 7 })
  const authority = createSessionSubjectAuthority(live.peek)
  const captured = authority.capture()
  assert.equal(authority.isCurrent(captured!), true)
  live.set(undefined)
  assert.equal(authority.isCurrent(captured!), false)
  live.set({ owner, generation: 7 })
  assert.equal(authority.isCurrent(captured!), true)
})

test('a provider that mutates ONE record in place cannot move an already-captured subject', () => {
  // A reused mutable record: the same object is updated in place.
  const owner = { session: { id: 's1' } } as unknown as SessionOwnerRef
  const record: { owner: SessionOwnerRef; generation: number } = { owner, generation: 4 }
  const authority = createSessionSubjectAuthority(() => record)
  const captured = authority.capture()
  assert.equal(authority.isCurrent(captured!), true)
  record.generation = 5
  assert.equal(authority.isCurrent(captured!), false,
    'the captured subject must pin the generation value, not follow the provider record')
  assert.equal(authority.isCurrent(authority.capture()!), true)
  record.owner = { session: { id: 's1' } } as unknown as SessionOwnerRef
  assert.equal(authority.isCurrent(authority.capture()!), true)
})

test('a foreign object that was never minted is never current', () => {
  const owner = { session: { id: 's1' } } as unknown as SessionOwnerRef
  const authority = createSessionSubjectAuthority(slot({ owner, generation: 1 }).peek)
  assert.equal(authority.isCurrent({} as SessionSubject), false)
  assert.equal(authority.isCurrent(Object.create(null) as SessionSubject), false)
})

// ── PR3-B §7.3 (B2 F2 P3): the ownerReplaced axis — the ONE discriminator ──

test('ownerReplaced answers on the OWNER axis: a same-ID new owner ref IS replaced, a same-owner bump is NOT', () => {
  // The ownership-contract alignment the external review asked for: the
  // active-draft drop (session runtime) and the stale-restore suppression
  // (submission runtime) must read the SAME axis. ownerReplaced compares
  // opaque owner refs — so a same-session-id re-publication (a NEW owner
  // ref under the same id) answers TRUE (genuinely replaced: the old owner
  // object is retired) and a same-owner generation bump answers FALSE (the
  // owner stands; only its captures were invalidated).
  const ownerA = {} as SessionOwnerRef
  const ownerA2 = {} as SessionOwnerRef // a DIFFERENT ref, same session id
  const state = slot({ owner: ownerA, generation: 1 })
  const authority = createSessionSubjectAuthority(state.peek)
  const captured = authority.capture()
  // Same-owner generation bump: NOT replaced.
  state.set({ owner: ownerA, generation: 2 })
  assert.equal(authority.ownerReplaced(captured), false,
    'a same-owner generation invalidation is not a replacement')
  // A different owner ref under the SAME session id: replaced.
  state.set({ owner: ownerA2, generation: 3 })
  assert.equal(authority.ownerReplaced(captured), true,
    'a new owner ref is a replacement even under the same session id (the drop and the stale restore agree)')
  // Sessionless/absent shapes: never "replaced".
  assert.equal(authority.ownerReplaced(undefined), false, 'an absent subject is never replaced')
  assert.equal(authority.ownerReplaced({} as SessionSubject), false, 'a foreign token is never replaced')
})

test('ownerReplaced is false when the live slot is empty (nothing replaced the captures)', () => {
  const ownerA = {} as SessionOwnerRef
  const state = slot({ owner: ownerA, generation: 1 })
  const authority = createSessionSubjectAuthority(state.peek)
  const captured = authority.capture()
  state.set(undefined)
  assert.equal(authority.ownerReplaced(captured), false,
    'an emptied slot is not a replacement (never a drop on the sessionless shape)')
})
