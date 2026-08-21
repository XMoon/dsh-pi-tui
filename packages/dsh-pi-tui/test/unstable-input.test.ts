/**
 * Phase 3 tests (plan §16): the UNSTABLE raw input registry — observe
 * never consumes, consume/rewrite decisions, deterministic ordering,
 * exclusive raw ownership (explicit conflict), owner unload cleanup,
 * rewrite never re-enters the chain, and throwing-handler isolation
 * (fail-open).
 * @module @xmoon76/dsh-pi-tui/unstable-input.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { UnstableInputRegistry } from '../src/extension/internal/unstable-input.ts'
import type { UnstableRawInputEvent, UnstableRawInputResult } from '../src/extension/unstable-types.ts'

/** A raw capture spec factory with a recording handler. */
function capture(
  id: string,
  mode: 'observe' | 'capture' | 'exclusive' = 'capture',
  options: { priority?: number; when?: () => boolean; decide?: UnstableRawInputResult; throwOn?: string } = {},
): { spec: Parameters<UnstableInputRegistry['register']>[0]; events: UnstableRawInputEvent[] } {
  const events: UnstableRawInputEvent[] = []
  const spec = {
    id,
    mode,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.when === undefined ? {} : { when: options.when }),
    handle: (event: UnstableRawInputEvent): UnstableRawInputResult | void => {
      events.push(event)
      if (options.throwOn !== undefined && event.data === options.throwOn) {
        throw new Error(`boom on ${options.throwOn}`)
      }
      return options.decide
    },
  }
  return { spec, events }
}

const event = (data: string): UnstableRawInputEvent => ({ data, surfaceId: 's1' })

test('observe never consumes or rewrites; the chunk still reaches capture handlers', () => {
  const registry = new UnstableInputRegistry()
  const observer = capture('obs', 'observe')
  const consumer = capture('cap', 'capture', { decide: { action: 'consume' } })
  registry.register(observer.spec, 'owner')
  registry.register(consumer.spec, 'owner')
  assert.deepEqual(registry.route(event('a')), { action: 'consume' })
  assert.equal(observer.events.length, 1, 'the observer saw the chunk')
  assert.equal(consumer.events.length, 1, 'the capture saw the chunk')
})

test('a passing capture lets the chunk continue; a consuming one stops it', () => {
  const registry = new UnstableInputRegistry()
  const first = capture('first', 'capture')
  const second = capture('second', 'capture', { decide: { action: 'consume' } })
  registry.register(first.spec, 'owner')
  registry.register(second.spec, 'owner')
  assert.deepEqual(registry.route(event('a')), { action: 'consume' })
  assert.equal(first.events.length, 1, 'the first capture saw the chunk (it passed)')
  assert.equal(second.events.length, 1, 'the second capture saw the chunk')
})

test('a rewrite replaces the chunk for the Host decoder (applied exactly once)', () => {
  const registry = new UnstableInputRegistry()
  const rewriter = capture('rewrite', 'capture', { decide: { action: 'rewrite', data: 'REPLACED' } })
  registry.register(rewriter.spec, 'owner')
  assert.deepEqual(registry.route(event('original')), { action: 'rewrite', data: 'REPLACED' })
  // The rewritten data never re-enters the chain: a second route call is
  // a NEW chunk (the Host applies the outcome once and continues).
  assert.equal(rewriter.events.length, 1)
})

test('priority ASC then id ASC is deterministic (load order never decides)', () => {
  const registry = new UnstableInputRegistry()
  const low = capture('low', 'capture', { priority: 10, decide: { action: 'consume' } })
  const high = capture('high', 'capture', { priority: 1, decide: { action: 'consume' } })
  const sameA = capture('a', 'capture', { priority: 5, decide: { action: 'consume' } })
  const sameB = capture('b', 'capture', { priority: 5, decide: { action: 'consume' } })
  registry.register(sameB.spec, 'owner')
  registry.register(sameA.spec, 'owner')
  registry.register(high.spec, 'owner')
  registry.register(low.spec, 'owner')
  assert.deepEqual(registry.route(event('a')), { action: 'consume' })
  assert.equal(high.events.length, 1, 'priority 1 runs first')
  assert.equal(sameA.events.length, 0, 'the priority-5 id-ASC capture never ran (the winner decided)')
  assert.equal(sameB.events.length, 0)
  assert.equal(low.events.length, 0)
})

test('exclusive is the SOLE raw consumer; capture-mode captures are skipped', () => {
  const registry = new UnstableInputRegistry()
  const exclusive = capture('ex', 'exclusive', { decide: { action: 'consume' } })
  const regular = capture('reg', 'capture', { decide: { action: 'consume' } })
  const observer = capture('obs', 'observe')
  registry.register(regular.spec, 'owner')
  registry.register(exclusive.spec, 'owner')
  registry.register(observer.spec, 'owner')
  assert.deepEqual(registry.route(event('a')), { action: 'consume' })
  assert.equal(exclusive.events.length, 1, 'the exclusive capture saw the chunk')
  assert.equal(regular.events.length, 0, 'capture-mode captures are NOT consulted under exclusive')
  assert.equal(observer.events.length, 1, 'observers still run under exclusive')
})

test('a second exclusive registration is an explicit error (never a load-order winner)', () => {
  const registry = new UnstableInputRegistry()
  registry.register(capture('ex1', 'exclusive').spec, 'owner-a')
  assert.throws(
    () => registry.register(capture('ex2', 'exclusive').spec, 'owner-b'),
    /exclusive unstable raw capture conflict/,
  )
  assert.equal(registry.snapshot().captures.length, 1)
})

test('a throwing handler is isolated and FAILS OPEN (the chunk passes through)', () => {
  const errors: string[] = []
  const throwing = capture('a-thrower', 'capture', { decide: { action: 'consume' }, throwOn: 'x' })
  const fallback = capture('b-fallback', 'capture', { decide: { action: 'consume' } })
  const health = new UnstableInputRegistry(() => {}, {
    track: () => {},
    untrack: () => {},
    recordError: (id, message) => errors.push(`${id}:${message}`),
    clearError: () => {},
  })
  health.register(throwing.spec, 'owner')
  health.register(fallback.spec, 'owner')
  // 'x' makes the first handler throw; the chunk must continue to the
  // fallback capture and be consumed there.
  assert.deepEqual(health.route(event('x')), { action: 'consume' })
  assert.equal(fallback.events.length, 1, 'the fallback capture saw the chunk after the throw')
  assert.equal(errors.length, 1)
  assert.ok(errors[0]!.includes('boom on x'))
  // A successful decision clears the failure.
  health.route(event('y'))
  assert.equal(errors.length, 1, 'a successful decision clears the recorded error')
})

test('a throwing EXCLUSIVE handler fails open to the Host (never stalls the ladder)', () => {
  const registry = new UnstableInputRegistry()
  const exclusive = capture('ex', 'exclusive', { decide: { action: 'consume' }, throwOn: 'x' })
  registry.register(exclusive.spec, 'owner')
  assert.deepEqual(registry.route(event('x')), { action: 'pass' }, 'a throwing exclusive never consumes')
})

test('the when gate controls consultation; a throwing gate is skipped and recorded', () => {
  const registry = new UnstableInputRegistry()
  const gated = capture('gated', 'capture', { when: () => false, decide: { action: 'consume' } })
  registry.register(gated.spec, 'owner')
  assert.deepEqual(registry.route(event('a')), { action: 'pass' }, 'a false gate skips the capture')
  assert.equal(gated.events.length, 0)
  // A THROWING gate is treated as false (the capture is skipped) AND
  // recorded in health (round-3 follow-up: the throwing-gate branch was
  // never directly asserted).
  const errors: string[] = []
  const throwing = capture('throwing-gate', 'capture', {
    when: () => { throw new Error('gate boom') },
    decide: { action: 'consume' },
  })
  const health = new UnstableInputRegistry(() => {}, {
    track: () => {},
    untrack: () => {},
    recordError: (id, message) => errors.push(`${id}:${message}`),
    clearError: () => {},
  })
  health.register(throwing.spec, 'owner')
  assert.deepEqual(health.route(event('a')), { action: 'pass' }, 'a throwing gate never consumes')
  assert.equal(throwing.events.length, 0, 'a throwing gate skips the handler')
  assert.equal(errors.length, 1)
  assert.ok(errors[0]!.includes('gate boom'))
})

test('owner unload removes exactly the owner’s captures; the rest keep working', () => {
  const registry = new UnstableInputRegistry()
  const a = capture('a', 'capture', { decide: { action: 'consume' } })
  const b = capture('b', 'capture', { decide: { action: 'consume' } })
  registry.register(a.spec, 'owner-a')
  registry.register(b.spec, 'owner-b')
  registry.disposeOwner('owner-a')
  assert.deepEqual(registry.route(event('x')), { action: 'consume' })
  assert.equal(a.events.length, 0, 'owner-a’s capture is gone')
  assert.equal(b.events.length, 1, 'owner-b’s capture still works')
  // An exclusive conflict with a disposed exclusive is allowed again.
  const registry2 = new UnstableInputRegistry()
  registry2.register(capture('ex1', 'exclusive').spec, 'owner-a')
  registry2.disposeOwner('owner-a')
  registry2.register(capture('ex2', 'exclusive').spec, 'owner-b')
  assert.equal(registry2.snapshot().captures.length, 1)
})

test('dispose is idempotent; a disposed capture is inert; disposeAll clears everything', () => {
  const registry = new UnstableInputRegistry()
  const handle = registry.register(capture('c', 'capture', { decide: { action: 'consume' } }).spec, 'owner')
  handle.dispose()
  handle.dispose()
  assert.deepEqual(registry.route(event('a')), { action: 'pass' })
  registry.register(capture('d', 'capture', { decide: { action: 'consume' } }).spec, 'owner')
  registry.disposeAll()
  assert.deepEqual(registry.route(event('a')), { action: 'pass' })
  assert.equal(registry.snapshot().captures.length, 0)
})

test('duplicate ids are an explicit error', () => {
  const registry = new UnstableInputRegistry()
  registry.register(capture('dup', 'capture').spec, 'owner-a')
  assert.throws(
    () => registry.register(capture('dup', 'capture').spec, 'owner-b'),
    /duplicate unstable raw capture id/,
  )
})
