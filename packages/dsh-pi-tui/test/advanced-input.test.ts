/**
 * Phase 2 tests (plan §14): the ADVANCED normalized input capture
 * registry — observe never consumes, capture consumes, deterministic
 * priority ordering, exclusive ownership (explicit conflict), owner unload
 * cleanup, stale-surface no-op, and throwing-handler isolation (fail-open).
 * @module @xmoon76/dsh-pi-tui/advanced-input.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { AdvancedInputRegistry } from '../src/extension/internal/advanced-input.ts'
import { normalizeInputEvent } from '../src/extension/internal/input-events.ts'
import type { AdvancedInputEvent } from '../src/extension/advanced-types.ts'

/** The registry's shared normalization (the Host's decoder). */
const normalize = (data: string): AdvancedInputEvent | undefined => normalizeInputEvent(data)

/** A capture spec factory with a recording handler. */
function capture(
  id: string,
  mode: 'observe' | 'capture' | 'exclusive' = 'capture',
  options: { priority?: number; when?: () => boolean; consume?: boolean; throwOn?: string } = {},
): { spec: Parameters<AdvancedInputRegistry['register']>[0]; events: AdvancedInputEvent[] } {
  const events: AdvancedInputEvent[] = []
  const spec = {
    id,
    mode,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.when === undefined ? {} : { when: options.when }),
    handle: (event: AdvancedInputEvent): boolean | void => {
      events.push(event)
      if (options.throwOn !== undefined && event.kind === 'key' && event.key.key === options.throwOn) {
        throw new Error(`boom on ${options.throwOn}`)
      }
      return options.consume === true
    },
  }
  return { spec, events }
}

test('observe never consumes; the event still reaches capture handlers', () => {
  const registry = new AdvancedInputRegistry()
  const observer = capture('obs', 'observe')
  const consumer = capture('cap', 'capture', { consume: true })
  registry.register(observer.spec, 'owner')
  registry.register(consumer.spec, 'owner')
  assert.equal(registry.route('a', normalize), 'consumed')
  assert.equal(observer.events.length, 1, 'the observer saw the event')
  assert.equal(consumer.events.length, 1, 'the capture saw the event')
})

test('capture consumes; a non-consuming capture passes the event on', () => {
  const registry = new AdvancedInputRegistry()
  const first = capture('first', 'capture')
  const second = capture('second', 'capture', { consume: true })
  registry.register(first.spec, 'owner')
  registry.register(second.spec, 'owner')
  assert.equal(registry.route('a', normalize), 'consumed')
  assert.equal(first.events.length, 1, 'the first capture saw the event')
  assert.equal(second.events.length, 1, 'the second capture saw the event (the first passed)')
})

test('priority ASC then id ASC is deterministic (load order never decides)', () => {
  const registry = new AdvancedInputRegistry()
  const low = capture('low', 'capture', { priority: 10, consume: true })
  const high = capture('high', 'capture', { priority: 1, consume: true })
  const sameA = capture('a', 'capture', { priority: 5, consume: true })
  const sameB = capture('b', 'capture', { priority: 5, consume: true })
  // Register in REVERSE order: the rules, not load order, must decide.
  registry.register(sameB.spec, 'owner')
  registry.register(sameA.spec, 'owner')
  registry.register(high.spec, 'owner')
  registry.register(low.spec, 'owner')
  assert.equal(registry.route('a', normalize), 'consumed')
  assert.equal(high.events.length, 1, 'priority 1 runs first')
  assert.equal(sameA.events.length, 0, 'the priority-5 id-ASC capture never ran (the winner consumed)')
  assert.equal(sameB.events.length, 0, 'the priority-5 id-B capture never ran')
  assert.equal(low.events.length, 0, 'the priority-10 capture never ran')
})

test('exclusive is the SOLE capture consumer; capture-mode captures are skipped', () => {
  const registry = new AdvancedInputRegistry()
  const exclusive = capture('ex', 'exclusive', { consume: true })
  const regular = capture('reg', 'capture', { consume: true })
  const observer = capture('obs', 'observe')
  registry.register(regular.spec, 'owner')
  registry.register(exclusive.spec, 'owner')
  registry.register(observer.spec, 'owner')
  assert.equal(registry.route('a', normalize), 'consumed')
  assert.equal(exclusive.events.length, 1, 'the exclusive capture saw the event')
  assert.equal(regular.events.length, 0, 'capture-mode captures are NOT consulted under exclusive')
  assert.equal(observer.events.length, 1, 'observers still run under exclusive (they never consume)')
})

test('a second exclusive registration is an explicit error (never a load-order winner)', () => {
  const registry = new AdvancedInputRegistry()
  registry.register(capture('ex1', 'exclusive').spec, 'owner-a')
  assert.throws(
    () => registry.register(capture('ex2', 'exclusive').spec, 'owner-b'),
    /exclusive advanced input capture conflict/,
  )
  // The conflict must not have registered anything.
  assert.equal(registry.snapshot().captures.length, 1)
})

test('an exclusive capture that passes lets the event continue (fail-open)', () => {
  const registry = new AdvancedInputRegistry()
  const exclusive = capture('ex', 'exclusive') // never consumes
  registry.register(exclusive.spec, 'owner')
  assert.equal(registry.route('a', normalize), 'passed', 'a passing exclusive does not block the ladder')
})

test('the when gate controls consultation; a throwing gate is skipped and recorded', () => {
  const registry = new AdvancedInputRegistry()
  const errors: string[] = []
  const gated = capture('gated', 'capture', { when: () => false, consume: true })
  const throwing = capture('throwing-gate', 'capture', {
    when: () => { throw new Error('gate boom') },
    consume: true,
  })
  registry.register(gated.spec, 'owner')
  registry.register(throwing.spec, 'owner')
  assert.equal(registry.route('a', normalize), 'passed', 'a false gate skips the capture')
  assert.equal(gated.events.length, 0)
  assert.equal(throwing.events.length, 0, 'a throwing gate is treated as false')
  // The throwing gate is recorded in health (the registry's health hook).
  const health = new AdvancedInputRegistry(() => {}, {
    track: () => {},
    untrack: () => {},
    recordError: (id, message) => errors.push(`${id}:${message}`),
    clearError: () => {},
  })
  health.register(throwing.spec, 'owner')
  health.route('a', normalize)
  assert.equal(errors.length, 1)
  assert.ok(errors[0]!.includes('gate boom'))
})

test('a throwing handler is isolated and FAILS OPEN (the event continues)', () => {
  const errors: string[] = []
  // 'a-thrower' sorts BEFORE 'b-fallback' (priority ASC, id ASC), so the
  // throwing capture is consulted first and must fail open to the fallback.
  const throwing = capture('a-thrower', 'capture', { consume: true, throwOn: 'x' })
  const fallback = capture('b-fallback', 'capture', { consume: true })
  const health = new AdvancedInputRegistry(() => {}, {
    track: () => {},
    untrack: () => {},
    recordError: (id, message) => errors.push(`${id}:${message}`),
    clearError: () => {},
  })
  health.register(throwing.spec, 'owner')
  health.register(fallback.spec, 'owner')
  // 'x' makes the first handler throw; the event must continue to the
  // fallback capture and be consumed there.
  assert.equal(health.route('x', normalize), 'consumed')
  assert.equal(fallback.events.length, 1, 'the fallback capture saw the event after the throw')
  assert.equal(errors.length, 1)
  assert.ok(errors[0]!.includes('boom on x'))
  // A successful consume clears the failure (the next failure starts a
  // NEW error generation).
  health.route('y', normalize)
  assert.equal(errors.length, 1, 'a successful consume clears the recorded error')
})

test('a throwing EXCLUSIVE handler fails open to the Host (never stalls the ladder)', () => {
  const registry = new AdvancedInputRegistry()
  const exclusive = capture('ex', 'exclusive', { consume: true, throwOn: 'x' })
  registry.register(exclusive.spec, 'owner')
  assert.equal(registry.route('x', normalize), 'passed', 'a throwing exclusive never consumes')
})

test('owner unload removes exactly the owner’s captures; the rest keep working', () => {
  const registry = new AdvancedInputRegistry()
  const a = capture('a', 'capture', { consume: true })
  const b = capture('b', 'capture', { consume: true })
  registry.register(a.spec, 'owner-a')
  registry.register(b.spec, 'owner-b')
  registry.disposeOwner('owner-a')
  assert.equal(registry.route('x', normalize), 'consumed')
  assert.equal(a.events.length, 0, 'owner-a’s capture is gone')
  assert.equal(b.events.length, 1, 'owner-b’s capture still works')
  // An exclusive conflict with a disposed exclusive is allowed again.
  const registry2 = new AdvancedInputRegistry()
  const ex1 = capture('ex1', 'exclusive')
  registry2.register(ex1.spec, 'owner-a')
  registry2.disposeOwner('owner-a')
  registry2.register(capture('ex2', 'exclusive').spec, 'owner-b')
  assert.equal(registry2.snapshot().captures.length, 1)
})

test('dispose is idempotent; a disposed capture is inert', () => {
  const registry = new AdvancedInputRegistry()
  const handle = registry.register(capture('c', 'capture', { consume: true }).spec, 'owner')
  handle.dispose()
  handle.dispose()
  assert.equal(registry.route('a', normalize), 'passed')
  assert.equal(registry.snapshot().captures.length, 0)
})

test('duplicate ids are an explicit error', () => {
  const registry = new AdvancedInputRegistry()
  registry.register(capture('dup', 'capture').spec, 'owner-a')
  assert.throws(
    () => registry.register(capture('dup', 'capture').spec, 'owner-b'),
    /duplicate advanced input capture id/,
  )
})

test('protocol artifacts and unparseable sequences never reach a capture', () => {
  const registry = new AdvancedInputRegistry()
  const observer = capture('obs', 'observe')
  registry.register(observer.spec, 'owner')
  // Kitty release event (flag-2 encoding).
  assert.equal(registry.route('\x1b[1;1:3u', normalize), 'passed')
  // A control sequence that is not a key (unparseable).
  assert.equal(registry.route('\x1b[999~', normalize), 'passed')
  assert.equal(observer.events.length, 0, 'no capture ever sees protocol artifacts')
})

test('a paste chunk is delivered as a paste event; a printable run as text', () => {
  const registry = new AdvancedInputRegistry()
  const observer = capture('obs', 'observe')
  registry.register(observer.spec, 'owner')
  registry.route('\x1b[200~hello\x1b[201~', normalize)
  assert.deepEqual(observer.events[0], { kind: 'paste', text: 'hello' })
  registry.route('abc', normalize)
  assert.deepEqual(observer.events[1], { kind: 'text', text: 'abc' })
  registry.route('a', normalize)
  assert.equal(observer.events[2]?.kind, 'key')
})
