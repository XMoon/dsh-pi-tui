/**
 * M1 contract gate: the extension ledger. Deterministic list ordering,
 * explicit conflicts, owner-scoped disposal, batched invalidation, and the
 * registration-before-surface contract (registration never requires a
 * surface; the ledger is pure registry).
 * @module @xmoon76/dsh-pi-tui/extension-ledger.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { InvalidateBatcher } from '../src/extension/internal/batcher.ts'

function makeLedger(): { ledger: ExtensionLedger; invalidates: number[] } {
  const invalidates: number[] = []
  const ledger = new ExtensionLedger(() => { invalidates.push(1) })
  return { ledger, invalidates }
}

/** Value sentinel for typed contributions. */
const V = (label: string) => ({ label })

test('list slots order contributions by order ASC then id ASC, independent of load order', () => {
  const { ledger } = makeLedger()
  // Loaded out of order deliberately: id sort must dominate the tie.
  ledger.register('chrome.footer.status', { id: 'b', order: 1 }, V('b1'), 'p1')
  ledger.register('chrome.footer.status', { id: 'a', order: 0 }, V('a0'), 'p2')
  ledger.register('chrome.footer.status', { id: 'c', order: 1 }, V('c1'), 'p3')
  const snapshot = ledger.snapshot<{ label: string }>('chrome.footer.status')
  assert.deepEqual(snapshot.records.map(record => record.id), ['a', 'b', 'c'])
  assert.equal(snapshot.semantic, 'list')
  assert.equal(snapshot.winner, undefined, 'list slots have no winner')
})

test('a duplicate (slot, owner, id) registration is an explicit error; the SAME id under a DIFFERENT owner is legal', () => {
  const { ledger } = makeLedger()
  ledger.register('chrome.header.badge', { id: 'dup' }, V('first'), 'owner-a')
  // Same id, DIFFERENT owner: legal (the M4 canonical ext:<owner>/<id>
  // keys stay distinct — the public contract: an id is unique per
  // (slot, owner)). The old (slot, id)-keyed ledger wrongly rejected
  // this (the review's P2).
  const second = ledger.register('chrome.header.badge', { id: 'dup' }, V('second'), 'owner-b')
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 2,
    'the same id under two LIVE owners must coexist')
  // The SAME owner registering the same id again: explicit error carrying
  // the holder.
  assert.throws(
    () => ledger.register('chrome.header.badge', { id: 'dup' }, V('third'), 'owner-a'),
    /duplicate extension registration: slot "chrome.header.badge" id "dup"/,
  )
  assert.throws(
    () => ledger.register('chrome.header.badge', { id: 'dup' }, V('fourth'), 'owner-a'),
    /owner "owner-a" already holds it/,
  )
  // Disposing ONE owner frees only ITS registration: the other owner's
  // same-id record survives, and the (slot, owner, id) triple becomes
  // re-registerable by the disposed owner.
  second.dispose()
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 1)
  assert.equal(ledger.snapshot('chrome.header.badge').records[0]!.owner, 'owner-a')
  ledger.register('chrome.header.badge', { id: 'dup' }, V('again'), 'owner-b')
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 2)
})

test('same-id same-order contributions from DIFFERENT owners order deterministically (owner tie-break)', () => {
  const { ledger } = makeLedger()
  // Identical order + id: only the owner can decide — load order never
  // decides (the owner tie-break keeps the sort total).
  ledger.register('chrome.header.badge', { id: 'shared', order: 0 }, V('z'), 'owner-z')
  ledger.register('chrome.header.badge', { id: 'shared', order: 0 }, V('a'), 'owner-a')
  const snapshot = ledger.snapshot('chrome.header.badge')
  assert.deepEqual(snapshot.records.map(record => record.owner), ['owner-a', 'owner-z'])
  // Reload in the REVERSE order: the same deterministic result.
  const { ledger: ledger2 } = makeLedger()
  ledger2.register('chrome.header.badge', { id: 'shared', order: 0 }, V('a'), 'owner-a')
  ledger2.register('chrome.header.badge', { id: 'shared', order: 0 }, V('z'), 'owner-z')
  assert.deepEqual(ledger2.snapshot('chrome.header.badge').records.map(record => record.owner), ['owner-a', 'owner-z'])
})

test('the same id may register under DIFFERENT slots', () => {
  const { ledger } = makeLedger()
  ledger.register('chrome.header.badge', { id: 'shared' }, V('h'), 'p1')
  ledger.register('input.dock.item', { id: 'shared' }, V('d'), 'p1')
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 1)
  assert.equal(ledger.snapshot('input.dock.item').records.length, 1)
})

test('unknown slots are rejected at registration and snapshot time', () => {
  const { ledger } = makeLedger()
  assert.throws(() => ledger.register('no.such.slot', { id: 'x' }, V('x'), 'p1'), /unknown extension slot/)
  assert.throws(() => ledger.snapshot('no.such.slot'), /unknown extension slot/)
})

test('prototype members are not valid slot names (the "constructor" trap)', () => {
  const { ledger } = makeLedger()
  // `'constructor' in SLOT_SEMANTICS` is true via the prototype chain — the
  // guard must use hasOwn, or the ledger would accept it as a slot.
  assert.throws(() => ledger.register('constructor', { id: 'x' }, V('x'), 'p1'), /unknown extension slot/)
  assert.throws(() => ledger.register('toString', { id: 'x' }, V('x'), 'p1'), /unknown extension slot/)
  assert.throws(() => ledger.snapshot('valueOf'), /unknown extension slot/)
})

test('list slots project every record and no winner (structural)', () => {
  const { ledger } = makeLedger()
  ledger.register('chrome.header.badge', { id: 'x' }, V('x'), 'p1')
  const snapshot = ledger.snapshot('chrome.header.badge')
  assert.equal(snapshot.records.length, 1)
  assert.equal(snapshot.winner, undefined)
})

test('single slots: lowest priority wins, ties are rejected, and the winner projects (P2-2)', () => {
  // The shipped slot map is all-list; the test-only semantic override
  // exercises the ledger's single-winner branch (priority tie error +
  // priority-ASC winner sort) so it is not dead code.
  const single = new ExtensionLedger(() => {}, new Map([['chrome.header.badge', 'single']]))
  single.register('chrome.header.badge', { id: 'a', priority: 10 }, V('a'), 'p1')
  single.register('chrome.header.badge', { id: 'b', priority: 2 }, V('b'), 'p2')
  single.register('chrome.header.badge', { id: 'c', priority: 7 }, V('c'), 'p3')
  const snapshot = single.snapshot<{ label: string }>('chrome.header.badge')
  assert.equal(snapshot.semantic, 'single')
  assert.equal(snapshot.winner?.id, 'b', 'lowest priority must win')
  assert.equal(snapshot.records.length, 1, 'single slots project the winner only')
  assert.equal(snapshot.records[0]?.value.label, 'b')
  // A priority TIE is an explicit error (never a registration-time guess).
  assert.throws(
    () => single.register('chrome.header.badge', { id: 'd', priority: 2 }, V('d'), 'p4'),
    /single-slot priority tie/,
  )
})

test('single slots: disposing the winner promotes the next lowest (P2-2)', () => {
  const single = new ExtensionLedger(() => {}, new Map([['chrome.header.badge', 'single']]))
  const hb = single.register('chrome.header.badge', { id: 'b', priority: 2 }, V('b'), 'p2')
  single.register('chrome.header.badge', { id: 'a', priority: 10 }, V('a'), 'p1')
  assert.equal(single.snapshot('chrome.header.badge').winner?.id, 'b')
  hb.dispose()
  assert.equal(single.snapshot('chrome.header.badge').winner?.id, 'a', 'next-lowest priority must become the winner')
})

test('dispose is idempotent and removes the contribution; a disposed handle is inert', () => {
  const { ledger } = makeLedger()
  const handle = ledger.register('chrome.header.badge', { id: 'gone' }, V('g'), 'p1')
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 1)
  handle.dispose()
  handle.dispose()
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 0)
  // Inert: no throw, no re-registration.
  handle.invalidate()
  handle.replace(V('new'))
  handle.dispose()
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 0)
})

test('replace() keeps the handle identity (owner, id, lifetime) and updates the value', () => {
  const { ledger } = makeLedger()
  const handle = ledger.register('chrome.footer.status', { id: 'r', order: 2 }, V('old'), 'owner-x')
  handle.replace(V('new'))
  const snapshot = ledger.snapshot<{ label: string }>('chrome.footer.status')
  assert.equal(snapshot.records.length, 1)
  assert.equal(snapshot.records[0]?.value.label, 'new')
  assert.equal(snapshot.records[0]?.owner, 'owner-x')
  assert.equal(snapshot.records[0]?.id, 'r')
  assert.equal(snapshot.records[0]?.order, 2)
})

test('disposeOwner removes exactly that owner’s contributions', () => {
  const { ledger } = makeLedger()
  ledger.register('chrome.header.badge', { id: 'a' }, V('a'), 'plugin-a')
  ledger.register('chrome.header.badge', { id: 'b' }, V('b'), 'plugin-b')
  ledger.register('chrome.footer.status', { id: 'c' }, V('c'), 'plugin-a')
  ledger.disposeOwner('plugin-a')
  assert.deepEqual(ledger.snapshot('chrome.header.badge').records.map(record => record.id), ['b'])
  assert.equal(ledger.snapshot('chrome.footer.status').records.length, 0)
})

test('disposeAll clears every slot', () => {
  const { ledger } = makeLedger()
  ledger.register('chrome.header.badge', { id: 'a' }, V('a'), 'p1')
  ledger.register('input.dock.item', { id: 'b' }, V('b'), 'p2')
  ledger.disposeAll()
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 0)
  assert.equal(ledger.snapshot('input.dock.item').records.length, 0)
})

test('registrations SURVIVE surface recreation — the ledger is service-lifetime (P1-2)', () => {
  const { ledger } = makeLedger()
  // The caller fiber registers BEFORE any surface.
  const handle = ledger.register('chrome.header.badge', { id: 'survivor' }, V('before'), 'p1')
  // Surface A attaches (the ledger records the sink owner; registrations
  // are NOT generation-stamped — a surface dispose must not remove them).
  const tokenA = {}
  ledger.markAttachment(tokenA)
  // Surface A disposes: the sink ownership is released (the surface-owned
  // sink becomes a no-op), but the REGISTRATION stays live.
  ledger.restoreSinkIfCurrent(tokenA)
  handle.replace(V('after-A'))
  assert.equal(ledger.snapshot<{ label: string }>('chrome.header.badge').records[0]?.value.label, 'after-A',
    'the old handle must STAY live across the surface recreation (P1-2)')
  // Surface B attaches to the SAME ledger: it reads the SAME still-live
  // registration.
  const tokenB = {}
  ledger.markAttachment(tokenB)
  const snapB = ledger.snapshot<{ label: string }>('chrome.header.badge')
  assert.equal(snapB.records.length, 1, 'surface B sees the still-live registration')
  assert.equal(snapB.records[0]?.value.label, 'after-A')
  // The old handle keeps working on B (replace/invalidate/dispose all
  // affect the CURRENT ledger — never surface-bound).
  handle.replace(V('on-B'))
  assert.equal(ledger.snapshot<{ label: string }>('chrome.header.badge').records[0]?.value.label, 'on-B')
  // B disposes too: still live (only the owner fiber unload or an explicit
  // dispose makes the handle inert).
  ledger.restoreSinkIfCurrent(tokenB)
  handle.replace(V('after-B'))
  assert.equal(ledger.snapshot<{ label: string }>('chrome.header.badge').records[0]?.value.label, 'after-B')
  // ONLY the caller-fiber unload (or explicit dispose) makes it inert.
  handle.dispose()
  assert.equal(ledger.snapshot('chrome.header.badge').records.length, 0)
})

test('a surface dispose never invalidates the ledger (no freeze flush)', () => {
  const { ledger, invalidates } = makeLedger()
  const token = {}
  ledger.markAttachment(token)
  ledger.register('chrome.header.badge', { id: 'x' }, V('x'), 'p1')
  const before = invalidates.length
  ledger.restoreSinkIfCurrent(token)
  ledger.restoreSinkIfCurrent(token) // idempotent
  assert.equal(invalidates.length, before, 'a surface dispose is a consumer detach — it must not invalidate the ledger')
})

test('the revision bumps on every structural change and is stable on reads', () => {
  const { ledger } = makeLedger()
  const before = ledger.snapshot('chrome.header.badge').revision
  const handle = ledger.register('chrome.header.badge', { id: 'r' }, V('r'), 'p1')
  const after = ledger.snapshot('chrome.header.badge').revision
  assert.ok(after > before)
  assert.equal(ledger.snapshot('chrome.header.badge').revision, after)
  handle.replace(V('r2'))
  assert.ok(ledger.snapshot('chrome.header.badge').revision > after, 'replace() is a content change: outlets must re-bake (F-16)')
  handle.dispose()
  assert.ok(ledger.snapshot('chrome.header.badge').revision > after)
})

test('health records track lifecycle states and deduplicate error generations', () => {
  const { ledger } = makeLedger()
  ledger.register('chrome.header.badge', { id: 'h' }, V('h'), 'p1')
  let health = ledger.healthSnapshot()
  assert.equal(health.length, 1)
  assert.equal(health[0]?.state, 'active')
  ledger.recordError('chrome.header.badge', 'h', 'render boom')
  health = ledger.healthSnapshot()
  assert.equal(health[0]?.state, 'failed')
  assert.equal(health[0]?.lastError, 'render boom')
  // Same failure generation: deduplicated (message unchanged).
  ledger.recordError('chrome.header.badge', 'h', 'render boom again')
  health = ledger.healthSnapshot()
  assert.equal(health[0]?.lastError, 'render boom')
  // Disposal removes the record.
  const handle = ledger.register('chrome.header.badge', { id: 'h2' }, V('h2'), 'p1')
  handle.dispose()
  health = ledger.healthSnapshot()
  assert.equal(health.length, 1)
})

test('a contribution recovers after a successful render and a NEW failure starts a NEW generation (P2)', () => {
  const { ledger } = makeLedger()
  ledger.register('chrome.header.badge', { id: 'r' }, V('r'), 'p1')
  // Failure 1: generation 1.
  ledger.recordError('chrome.header.badge', 'r', 'first boom')
  let health = ledger.healthSnapshot()
  assert.equal(health[0]?.state, 'failed')
  assert.equal(health[0]?.errorGeneration, 1)
  // Recovery: the outlet's success path calls clearError — the record is
  // active again and the error generation is dropped.
  ledger.clearError('chrome.header.badge', 'r')
  health = ledger.healthSnapshot()
  assert.equal(health[0]?.state, 'active')
  assert.equal(health[0]?.errorGeneration, undefined)
  assert.equal(health[0]?.lastError, undefined)
  // Failure 2: a NEW generation (the old failure must not be conflated).
  ledger.recordError('chrome.header.badge', 'r', 'second boom')
  health = ledger.healthSnapshot()
  assert.equal(health[0]?.state, 'failed')
  assert.equal(health[0]?.errorGeneration, 2, 'a post-recovery failure must start a NEW generation (P2)')
  assert.equal(health[0]?.lastError, 'second boom')
})

test('invalidation coalesces into one batched sink call per tick', async () => {
  const invalidates: number[] = []
  const batcher = new InvalidateBatcher({ requestRender: (force) => invalidates.push(force ? 1 : 0) })
  const batched = new ExtensionLedger(() => batcher.invalidate())
  const handle = batched.register('chrome.header.badge', { id: 'b' }, V('b'), 'p1')
  handle.invalidate()
  handle.invalidate()
  handle.replace(V('b2'))
  handle.invalidate()
  assert.equal(invalidates.length, 0, 'nothing flushes before the microtask')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(invalidates.length, 1, 'a burst of invalidates yields ONE sink call')
})

test('registration before any surface exists works (the M1 contract)', () => {
  // The ledger has no surface dependency: registration, snapshot, replace,
  // dispose all work with zero UI attached.
  const { ledger } = makeLedger()
  const handle = ledger.register('chrome.footer.status', { id: 'pre' }, V('pre'), 'p1')
  assert.equal(ledger.snapshot('chrome.footer.status').records.length, 1)
  handle.dispose()
  assert.equal(ledger.snapshot('chrome.footer.status').records.length, 0)
})
