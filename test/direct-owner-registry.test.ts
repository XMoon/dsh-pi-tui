/**
 * Contract locks for the Direct Agent↔OwnerRef registry (A2 §3.3): stable
 * identity per exact Agent object, distinct owners for distinct Agents even on
 * one session id, and a derived transitional current-attachment read that never
 * caches.
 * @module @xmoon76/dsh-pi-tui/direct-owner-registry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDirectOwnerRegistry } from '../src/app/direct/owner-registry.ts'
import { createSessionOwnershipCore } from '../src/app/session/ownership-core.ts'
import type { SessionHandle } from '../src/runtime/session-lifecycle-port.ts'

function fakeAgent(sessionId: string, agentId: string): Agent {
  return { id: agentId, session: { id: sessionId } } as unknown as Agent
}

function fakeHandle(agent: Agent, sessionId: string): SessionHandle {
  return {
    session: { id: sessionId },
    direct: { agent, ownerHandle: { dispose: () => {} } },
  } as unknown as SessionHandle
}

function core() {
  return createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
}

test('the same exact Agent through different SessionHandle wrappers yields the SAME OwnerRef', () => {
  const agent = fakeAgent('s1', 'a1')
  const registry = createDirectOwnerRegistry(() => undefined)
  const handleA = { session: { id: 's1' }, direct: { agent, ownerHandle: { dispose: () => {} } } } as unknown as SessionHandle
  const handleB = { session: { id: 's1' }, direct: { agent, ownerHandle: { dispose: () => {} } } } as unknown as SessionHandle
  const first = registry.fromHandle(handleA)
  const second = registry.fromHandle(handleB)
  assert.ok(first !== undefined && second !== undefined)
  assert.equal(first, second, 'a re-wrapped parked owner must keep exactly one identity')
  assert.equal(registry.completionIdentity(first!), 'a1')
  assert.equal(registry.sessionId(first!), 's1')
  assert.equal(registry.surfaceAttachment(first!), agent)
  const newestHandle = (handleB as unknown as { direct: { ownerHandle: unknown } }).direct.ownerHandle
  assert.equal(registry.handleOf(first!), newestHandle,
    're-wrapping the same Agent must refresh the handle record to the NEWEST wrapper')
  assert.notEqual(registry.handleOf(first!), (handleA as unknown as { direct: { ownerHandle: unknown } }).direct.ownerHandle,
    'the stale wrapper must not remain the retirement handle')
})

test('a different Agent with the SAME sessionId yields a DIFFERENT OwnerRef', () => {
  const registry = createDirectOwnerRegistry(() => undefined)
  const first = registry.fromHandle(fakeHandle(fakeAgent('s1', 'a1'), 's1'))
  const second = registry.fromHandle(fakeHandle(fakeAgent('s1', 'a2'), 's1'))
  assert.ok(first !== undefined && second !== undefined)
  assert.notEqual(first, second, 'owner identity is the exact Agent object, never the session id')
  assert.equal(registry.sessionId(first!), 's1')
  assert.equal(registry.sessionId(second!), 's1')
})

test('the same OwnerRef on a bumped generation makes the old SessionSubject stale', () => {
  const ownership = core()
  const registry = createDirectOwnerRegistry(() => ownership.owner())
  const agent = fakeAgent('s1', 'a1')
  const owner = registry.fromHandle(fakeHandle(agent, 's1'))!
  ownership.setCurrentOwner(owner, 's1')
  const captured = ownership.captureSubject()
  assert.ok(captured !== undefined)
  assert.equal(ownership.isSubjectCurrent(captured), true)
  ownership.bumpGeneration()
  assert.equal(ownership.isSubjectCurrent(captured), false,
    'a generation bump must invalidate the old subject even for the same owner')
})

test('currentDirectAttachment reads the LIVE current owner on every call (no cache)', () => {
  const ownership = core()
  const registry = createDirectOwnerRegistry(() => ownership.owner())
  assert.equal(registry.currentDirectAttachment(), undefined, 'sessionless: no attachment')
  const agent = fakeAgent('s1', 'a1')
  const owner = registry.fromHandle(fakeHandle(agent, 's1'))!
  ownership.setCurrentOwner(owner, 's1')
  assert.equal(registry.currentDirectAttachment(), agent, 'must project the exact Agent object')
  ownership.setCurrentOwner(undefined, undefined)
  assert.equal(registry.currentDirectAttachment(), undefined, 'clearing the owner clears the projection')
})

test('an unregistered owner fails fast instead of defaulting the session id', () => {
  const registry = createDirectOwnerRegistry(() => undefined)
  const stray = {} as Parameters<typeof registry.sessionId>[0]
  assert.throws(() => registry.sessionId(stray), /not registered/)
})
