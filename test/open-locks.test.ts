/**
 * Tests for the multi-slot open-lock holder (src/open-locks.ts): a session
 * transition may hold the OLD and the TARGET lock at once — the old lock is
 * never released before the target is acquired (review round 5: the old
 * release-first order opened a vacuum window where another process could
 * take the old session while a switch was still failing; a failed re-acquire
 * then left the current session live WITHOUT its lock).
 * @module @xmoon76/dsh-pi-tui/open-locks.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenLockHolder } from '../src/open-locks.ts'

test('a transition holds the OLD and the TARGET lock at once', () => {
  const holder = new OpenLockHolder()
  const released: string[] = []
  holder.add('session-a', () => { released.push('session-a') })
  // The target is acquired while the old lock is still held — the handoff
  // order that closes the vacuum window.
  assert.equal(holder.add('session-b', () => { released.push('session-b') }), true)
  assert.equal(holder.size, 2)
  assert.equal(holder.has('session-a'), true)
  assert.equal(holder.has('session-b'), true)
  // Commit: the old lock is released, the target stays.
  holder.release('session-a')
  assert.deepEqual(released, ['session-a'])
  assert.equal(holder.has('session-a'), false)
  assert.equal(holder.has('session-b'), true)
  holder.release('session-b')
  assert.deepEqual(released, ['session-a', 'session-b'])
  assert.equal(holder.size, 0)
})

test('adding an already-held session is an idempotent no-op (the first release wins)', () => {
  const holder = new OpenLockHolder()
  const released: string[] = []
  holder.add('session-a', () => { released.push('first') })
  assert.equal(holder.add('session-a', () => { released.push('second') }), false)
  assert.equal(holder.size, 1)
  holder.release('session-a')
  assert.deepEqual(released, ['first'], 'the FIRST release must win — a re-acquire never overwrites')
})

test('releasing an unknown session is a no-op', () => {
  const holder = new OpenLockHolder()
  holder.release('session-nope')
  assert.equal(holder.size, 0)
})

test('releaseAll covers the clean-exit path (a transition may hold two)', () => {
  const holder = new OpenLockHolder()
  const released: string[] = []
  holder.add('session-a', () => { released.push('session-a') })
  holder.add('session-b', () => { released.push('session-b') })
  holder.releaseAll()
  assert.deepEqual(released.sort(), ['session-a', 'session-b'])
  assert.equal(holder.size, 0)
  assert.equal(holder.has('session-a'), false)
  // releaseAll is idempotent.
  holder.releaseAll()
  assert.deepEqual(released.sort(), ['session-a', 'session-b'])
})
