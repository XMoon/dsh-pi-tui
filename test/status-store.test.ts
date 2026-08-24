/**
 * Headless tests for the StatusStore (plan §12.3): synchronous snapshots,
 * section-level patch merging, same-value no-notify discipline, revision
 * monotonicity, and listener error isolation.
 * @module @xmoon76/dsh-pi-tui/status-store.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { StatusStore } from '../src/status/store.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

function snapshotWith(overrides: Partial<StatusSnapshot>): StatusSnapshot {
  return { ...emptyStatusSnapshot(), ...overrides }
}

test('store starts from the empty snapshot and reports revision 0', () => {
  const store = new StatusStore()
  assert.equal(store.revision(), 0)
  assert.deepEqual(store.snapshot(), emptyStatusSnapshot())
})

test('update merges sections and keeps untouched sections by identity', () => {
  const store = new StatusStore()
  const workspace = { cwd: '/a/b', branch: 'main' }
  store.update({ workspace })
  const first = store.snapshot()
  assert.equal(first.workspace, workspace)
  assert.equal(store.revision(), 1)
  // A second update touching a DIFFERENT section keeps the workspace
  // reference (the footer cache can rely on section identity).
  store.update({ interaction: { focusMode: true } })
  const second = store.snapshot()
  assert.equal(second.workspace, workspace)
  assert.equal(second.interaction.focusMode, true)
  assert.equal(store.revision(), 2)
})

test('same-value updates do not notify (no render storm)', () => {
  const store = new StatusStore()
  let notified = 0
  store.subscribe(() => { notified += 1 })
  const workspace = { cwd: '/a/b' }
  store.update({ workspace })
  assert.equal(notified, 1)
  // Same section object again: no change.
  store.update({ workspace })
  assert.equal(notified, 1)
  // A NEW object with equal content IS a change (identity semantics).
  store.update({ workspace: { cwd: '/a/b' } })
  assert.equal(notified, 2)
})

test('replace swaps the whole snapshot and notifies once', () => {
  const store = new StatusStore()
  let notified = 0
  store.subscribe(() => { notified += 1 })
  const next = snapshotWith({ interaction: { focusMode: true } })
  store.replace(next)
  assert.equal(store.snapshot(), next)
  assert.equal(notified, 1)
})

test('subscribe returns a disposer; a throwing listener is isolated', () => {
  const store = new StatusStore()
  const seen: number[] = []
  const boom = (): void => { throw new Error('listener boom') }
  store.subscribe(boom)
  store.subscribe(() => { seen.push(store.revision()) })
  store.update({ interaction: { focusMode: true } })
  assert.deepEqual(seen, [1])
  const dispose = store.subscribe(() => { seen.push(99) })
  dispose()
  store.update({ interaction: { focusMode: false } })
  assert.deepEqual(seen, [1, 2])
})

test('undefined patch values are skipped', () => {
  const store = new StatusStore()
  store.update({ workspace: undefined, interaction: { focusMode: true } })
  assert.equal(store.snapshot().interaction.focusMode, true)
  assert.equal(store.revision(), 1)
})
