/**
 * Unit tests for the pure `GenerationCache` (D2.3 v2 §0.4).
 * @module @xmoon76/dsh-pi-tui/generation-cache.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { GenerationCache } from '../src/runtime/remote/generation-cache.ts'

interface Value {
  default: string
  groups: string[]
}

const detach = (value: Value): Value => ({ default: value.default, groups: [...value.groups] })

test('snapshot returns a detached copy the caller cannot use to mutate the cache', () => {
  const cache = new GenerationCache<Value>(detach)
  const epoch = cache.beginRead()
  assert.equal(cache.publish(epoch, 1, { default: 'm1', groups: ['g'] }), true)
  const first = cache.snapshot(1)!
  first.groups.push('MUTATED')
  first.default = 'MUTATED'
  assert.deepEqual(cache.snapshot(1), { default: 'm1', groups: ['g'] },
    'caller mutation must never reach cached state')
})

test('snapshot is undefined for another generation', () => {
  const cache = new GenerationCache<Value>(detach)
  cache.publish(cache.beginRead(), 1, { default: 'm1', groups: [] })
  assert.equal(cache.snapshot(2), undefined, 'a different connection generation must not read this cache')
})

test('a newer read wins; a superseded read cannot publish', () => {
  const cache = new GenerationCache<Value>(detach)
  const older = cache.beginRead()
  const newer = cache.beginRead()
  assert.equal(cache.publish(newer, 1, { default: 'm-NEW', groups: [] }), true)
  assert.equal(cache.publish(older, 1, { default: 'm-OLD', groups: [] }), false,
    'the older read no longer owns publication')
  assert.equal(cache.snapshot(1)!.default, 'm-NEW')
})

test('invalidate drops the value and supersedes an in-flight read', () => {
  const cache = new GenerationCache<Value>(detach)
  cache.publish(cache.beginRead(), 1, { default: 'm1', groups: [] })
  const inflight = cache.beginRead()
  cache.invalidate()
  assert.equal(cache.publish(inflight, 1, { default: 'm1-again', groups: [] }), false,
    'an invalidation supersedes the read that started before it')
  assert.equal(cache.snapshot(1), undefined)
})

test('a failed read never destroys the last-good same-generation value', () => {
  const cache = new GenerationCache<Value>(detach)
  cache.publish(cache.beginRead(), 1, { default: 'm-good', groups: [] })
  // A failed read starts an epoch but never publishes.
  cache.beginRead()
  assert.equal(cache.snapshot(1)!.default, 'm-good',
    'the last-good value survives a failed refresh of the same generation')
})

test('a value is detached when WRITTEN: the publisher cannot mutate cached state', () => {
  const cache = new GenerationCache<Value>(detach)
  const published: Value = { default: 'm1', groups: ['g'] }
  cache.publish(cache.beginRead(), 1, published)
  published.groups.push('MUTATED')
  published.default = 'MUTATED'
  assert.deepEqual(cache.snapshot(1), { default: 'm1', groups: ['g'] },
    'mutating the object handed to publish must not reach the cache')
})

test('a superseded read is representable independently of its settlement (v2 §0.2.1)', () => {
  // Ownership is a separate axis: a read can be superseded while the caller
  // still receives the newer generation-consistent value.
  const cache = new GenerationCache<Value>(detach)
  const older = cache.beginRead()
  const newer = cache.beginRead()
  cache.publish(newer, 1, { default: 'm-NEW', groups: [] })
  assert.equal(cache.publish(older, 1, { default: 'm-OLD', groups: [] }), false)
  assert.equal(cache.snapshot(1)!.default, 'm-NEW')
})
