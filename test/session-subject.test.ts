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
  const owner = { session: { id: 's1' } }
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
  const owner = { session: { id: 's1' } }
  const live = slot({ owner, generation: 1 })
  const authority = createSessionSubjectAuthority(live.peek)
  const captured = authority.capture()
  live.set({ owner, generation: 2 })
  assert.equal(authority.isCurrent(captured!), false)
  assert.equal(authority.isCurrent(authority.capture()!), true)
})

test('a different owner with the same session id and generation is not current (exact object identity)', () => {
  const live = slot({ owner: { session: { id: 's1' } }, generation: 5 })
  const authority = createSessionSubjectAuthority(live.peek)
  const captured = authority.capture()
  live.set({ owner: { session: { id: 's1' } }, generation: 5 })
  assert.equal(authority.isCurrent(captured!), false)
})

test('currentness reflects the LIVE slot on every call, never a capture-time snapshot', () => {
  const owner = { session: { id: 's1' } }
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
  const owner = { session: { id: 's1' } }
  const record: { owner: object; generation: number } = { owner, generation: 4 }
  const authority = createSessionSubjectAuthority(() => record)
  const captured = authority.capture()
  assert.equal(authority.isCurrent(captured!), true)
  record.generation = 5
  assert.equal(authority.isCurrent(captured!), false,
    'the captured subject must pin the generation value, not follow the provider record')
  assert.equal(authority.isCurrent(authority.capture()!), true)
  record.owner = { session: { id: 's1' } }
  assert.equal(authority.isCurrent(authority.capture()!), true)
})

test('a foreign object that was never minted is never current', () => {
  const owner = { session: { id: 's1' } }
  const authority = createSessionSubjectAuthority(slot({ owner, generation: 1 }).peek)
  assert.equal(authority.isCurrent({} as SessionSubject), false)
  assert.equal(authority.isCurrent(Object.create(null) as SessionSubject), false)
})
