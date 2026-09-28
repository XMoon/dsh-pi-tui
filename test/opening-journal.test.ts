import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpeningJournal } from '../src/app/surface/opening-journal.ts'

type Event = { readonly kind: string }

test('opening journal: begin captures an opaque token and reports the opening id', () => {
  const journal = createOpeningJournal<Event>()
  const token = journal.begin('s1')
  assert.equal(typeof token, 'object')
  assert.equal(journal.current(), token)
  assert.equal(journal.isOpening('s1'), true)
  assert.equal(journal.isOpening('s2'), false)
  assert.deepEqual(journal.cut('s1'), { id: 's1', events: [] })
  assert.equal(journal.cut('s2'), undefined)
})

test('opening journal: clear is exact-token guarded, so a newer journal survives a stale clear', () => {
  const journal = createOpeningJournal<Event>()
  const first = journal.begin('s1')
  const second = journal.begin('s2')
  journal.record('s2', { kind: 'kept' })
  // A late clear carrying the SUPERSEDED token must not drop the newer journal.
  journal.clear(first)
  assert.equal(journal.current(), second)
  assert.deepEqual(journal.cut('s2'), { id: 's2', events: [{ kind: 'kept' }] })
  journal.clear(second)
  assert.equal(journal.current(), undefined)
})

test('opening journal: events for a non-opening session are ignored', () => {
  const journal = createOpeningJournal<Event>()
  journal.begin('s1')
  journal.record('s2', { kind: 'wrong' })
  journal.record('s1', { kind: 'right' })
  assert.deepEqual(journal.cut('s1'), { id: 's1', events: [{ kind: 'right' }] })
})

test('opening journal: reset unconditionally clears the current journal', () => {
  const journal = createOpeningJournal<Event>()
  const token = journal.begin('s1')
  journal.reset()
  assert.equal(journal.current(), undefined)
  assert.equal(journal.cut('s1'), undefined)
  // The reset is not an exact-token clear: it must not resurrect on a late clear.
  journal.clear(token)
  assert.equal(journal.current(), undefined)
})

test('opening journal: records land on the live cut consumed by hydration', () => {
  const journal = createOpeningJournal<Event>()
  const token = journal.begin('s1')
  const cut = journal.cut('s1')
  assert.ok(cut !== undefined)
  journal.record('s1', { kind: 'pre-commit' })
  assert.deepEqual(cut.events, [{ kind: 'pre-commit' }])
  journal.clear(token)
})
