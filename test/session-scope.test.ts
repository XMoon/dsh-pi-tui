/**
 * Unit tests for the atomic session-scope authority (A3 §1.1): ONE synchronous
 * capture pins `{ owner subject, generation, sessionId }`; a LIVE capture is
 * fenced by the exact owner object AND generation, while a SESSIONLESS capture
 * stays current only while the surface still has no owner AND the generation is
 * unchanged — so it fails inside the first-session commit's publish-before-bump
 * window (owner published, generation not yet bumped).
 * @module @xmoon76/dsh-pi-tui/session-scope.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createSessionScopeAuthority,
  type SessionScope,
  type SessionScopeLive,
} from '../src/app/session/scope.ts'
import {
  createSessionSubjectAuthority,
  type SessionOwnerRef,
} from '../src/app/session/subject.ts'
import { SupersededReadError } from '../src/runtime/read-error.ts'
import { sessionScopeFacts } from './session-scope-facts.ts'

type FakeAgent = { session: { id: string } }

function fakeAgent(sessionId: string): FakeAgent {
  return { session: { id: sessionId } }
}

/**
 * A mutable stand-in for the runtime's single owner slot. A subject authority
 * and a scope authority read the SAME slot, exactly like the production
 * ownership core wires them (so a subject token minted here is the scope
 * authority's `isSubjectCurrent` delegate).
 */
function slot(initial: { agent: FakeAgent | undefined; generation: number }) {
  let state = initial
  let reads = 0
  const subjectAuthority = createSessionSubjectAuthority(() =>
    state.agent === undefined
      ? undefined
      : { owner: state.agent as unknown as SessionOwnerRef, generation: state.generation })
  const authority = createSessionScopeAuthority({
    current: () => {
      reads += 1
      const agentNow = state.agent
      if (agentNow === undefined) {
        return { subject: undefined, sessionId: undefined, generation: state.generation }
      }
      const subject = subjectAuthority.capture()
      if (subject === undefined) throw new Error('a live ownership subject must carry a session id')
      return { subject, sessionId: agentNow.session.id, generation: state.generation }
    },
    isSubjectCurrent: (subject) => subjectAuthority.isCurrent(subject),
  })
  return {
    authority,
    agent: () => state.agent,
    generation: () => state.generation,
    reads: () => reads,
    setAgent: (next: FakeAgent | undefined) => { state = { ...state, agent: next } },
    setGeneration: (next: number) => { state = { ...state, generation: next } },
  }
}

test('a live capture stays current across unrelated reads, then goes stale on an agent swap or a generation bump', () => {
  const live = slot({ agent: fakeAgent('s1'), generation: 3 })
  const captured = live.authority.capture()
  assert.equal(live.authority.isCurrent(captured), true)
  // Unrelated reads must never move an already-captured record.
  live.authority.capture()
  live.authority.captureLive()
  assert.equal(live.authority.isCurrent(captured), true)
  // The SAME session id on a NEW agent object is a different owner.
  live.setAgent(fakeAgent('s1'))
  assert.equal(live.authority.isCurrent(captured), false)
  // The SAME owner on a NEW generation is stale.
  const owner = fakeAgent('s2')
  const bumped = slot({ agent: owner, generation: 1 })
  const bumpedCapture = bumped.authority.capture()
  bumped.setGeneration(2)
  assert.equal(bumped.authority.isCurrent(bumpedCapture), false)
})

test('a sessionless capture is current while the surface is still sessionless at the same generation', () => {
  const live = slot({ agent: undefined, generation: 0 })
  const captured = live.authority.capture()
  assert.equal(captured.sessionId, undefined)
  assert.equal(live.authority.isCurrent(captured), true)
  assert.equal(live.authority.captureLive(), undefined)
})

test('a sessionless capture goes stale as soon as an owner appears, BEFORE the generation bump', () => {
  const live = slot({ agent: undefined, generation: 0 })
  const captured = live.authority.capture()
  assert.equal(live.authority.isCurrent(captured), true)
  // The first-session commit publishes the owner BEFORE it bumps the
  // generation; the sessionless fence must already fail in that window.
  live.setAgent(fakeAgent('s1'))
  assert.equal(live.generation(), 0, 'the publish-before-bump window keeps the generation unchanged')
  assert.equal(live.authority.isCurrent(captured), false)
})

test('a sessionless capture goes stale when the generation changes', () => {
  const live = slot({ agent: undefined, generation: 5 })
  const captured = live.authority.capture()
  assert.equal(live.authority.isCurrent(captured), true)
  live.setGeneration(6)
  assert.equal(live.authority.isCurrent(captured), false)
})

test('capture() pins the whole record from ONE synchronous read', () => {
  const live = slot({ agent: fakeAgent('s1'), generation: 4 })
  const before = live.reads()
  const captured = live.authority.capture()
  assert.equal(live.reads() - before, 1, 'capture() must read the live slot exactly once')
  // Mutate every live field between the capture and the check: the captured
  // session id and (proved through isCurrent) subject/generation must not move.
  live.setAgent(fakeAgent('s2'))
  live.setGeneration(9)
  assert.equal(captured.sessionId, 's1', 'the captured session id must not follow the live slot')
  assert.equal(live.authority.isCurrent(captured), false,
    'the captured subject/generation must not follow the live slot')
})

test('a provider that reuses and mutates ONE live record cannot move a captured scope', () => {
  // The authority must COPY the captured values. A provider that returns the SAME
  // mutable record object every time (and mutates it in place) must never move an
  // already-captured scope — this is the failure mode a by-reference pin would have.
  let agent: FakeAgent | undefined = fakeAgent('s1')
  let generation = 3
  const subjectAuthority = createSessionSubjectAuthority(() =>
    agent === undefined
      ? undefined
      : { owner: agent as unknown as SessionOwnerRef, generation })
  const live = {
    subject: subjectAuthority.capture(),
    sessionId: 's1',
    generation,
  }
  const authority = createSessionScopeAuthority({
    current: () => live as unknown as SessionScopeLive,
    isSubjectCurrent: (subject) => subjectAuthority.isCurrent(subject),
  })
  const captured = authority.capture()
  assert.equal(captured.sessionId, 's1')
  assert.equal(authority.isCurrent(captured), true)
  // Mutate the SAME returned record in place: new owner object + new generation,
  // same session id.
  agent = fakeAgent('s1')
  generation = 4
  live.subject = subjectAuthority.capture()
  live.generation = 4
  assert.equal(captured.sessionId, 's1', 'the captured session id must not follow the reused record')
  assert.equal(authority.isCurrent(captured), false,
    'the captured owner/generation must not follow the reused record')
})

test('isCurrent is false for a scope minted by another authority or a foreign object', () => {
  const first = slot({ agent: fakeAgent('s1'), generation: 1 })
  const second = slot({ agent: fakeAgent('s1'), generation: 1 })
  const captured = first.authority.capture()
  assert.equal(first.authority.isCurrent(captured), true)
  assert.equal(second.authority.isCurrent(captured), false,
    'a scope belongs to the authority that minted it')
  assert.equal(first.authority.isCurrent({} as SessionScope), false)
  assert.equal(first.authority.isCurrent(Object.create(null) as SessionScope), false)
  const sessionless = slot({ agent: undefined, generation: 2 })
  assert.equal(first.authority.isCurrent(sessionless.authority.capture()), false)
})

test('two live captures without a transition mint DIFFERENT subject tokens and BOTH are current', () => {
  const live = slot({ agent: fakeAgent('s1'), generation: 7 })
  const first = live.authority.captureLive()
  const second = live.authority.captureLive()
  assert.notEqual(first, undefined)
  assert.notEqual(second, undefined)
  // Every capture mints a FRESH subject token, so comparing tokens by object
  // equality would wrongly invalidate an otherwise untouched owner.
  assert.notEqual(first!.subject, second!.subject, 'each live capture must mint a new subject token')
  assert.equal(live.authority.isCurrent(first!), true)
  assert.equal(live.authority.isCurrent(second!), true)
})

test('captureLive() returns a subject + string sessionId while live, undefined while sessionless', () => {
  const live = slot({ agent: fakeAgent('s1'), generation: 2 })
  const scope = live.authority.captureLive()
  assert.notEqual(scope, undefined)
  assert.equal(typeof scope!.sessionId, 'string')
  assert.equal(scope!.sessionId, 's1')
  assert.notEqual(scope!.subject, undefined)
  assert.equal(live.authority.isCurrent(scope!), true)
  live.setAgent(undefined)
  assert.equal(live.authority.captureLive(), undefined)
})

test('a scope-bound read facade throws SupersededReadError on a stale scope; a valid absent value returns undefined', () => {
  // The A3-2 frozen contract (§3.2): `undefined` means "the domain value is
  // absent", NEVER "stale". The helpers mirror the production providers (the
  // REAL scope authority + the same sync admission check).
  const live = slot({ agent: fakeAgent('s1'), generation: 3 })
  const facts = sessionScopeFacts(
    () => live.agent() as unknown as Agent,
    () => live.generation(),
  )
  const scope = facts.captureLiveSessionScope()
  assert.notEqual(scope, undefined)
  // A valid scope with an absent domain value returns undefined.
  assert.equal(facts.currentApprovalOverride(scope!), undefined, 'no override is an absent value')
  assert.equal(facts.lastAssistantText(scope!), undefined, 'no assistant message is an absent value')
  assert.deepEqual(facts.currentSessionActivity(scope!), { running: false })
  // The SAME session id on a NEW owner object is a different owner: every
  // scope-bound read must refuse instead of retargeting to the new owner.
  live.setAgent(fakeAgent('s1'))
  for (const read of [
    () => facts.currentApprovalOverride(scope!),
    () => facts.currentSessionActivity(scope!),
    () => facts.currentSessionRouting(scope!),
    () => facts.currentSessionStats(scope!),
    () => facts.lastAssistantText(scope!),
  ]) {
    assert.throws(read, (error: unknown) => error instanceof SupersededReadError,
      'a stale scope must throw SupersededReadError, never return undefined')
  }
  // A generation bump on the same owner is stale too.
  const stable = slot({ agent: fakeAgent('s2'), generation: 1 })
  const stableFacts = sessionScopeFacts(
    () => stable.agent() as unknown as Agent,
    () => stable.generation(),
  )
  const stableScope = stableFacts.captureLiveSessionScope()
  assert.notEqual(stableScope, undefined)
  stable.setGeneration(2)
  assert.throws(() => stableFacts.currentApprovalOverride(stableScope!),
    (error: unknown) => error instanceof SupersededReadError)
})

test('a scope-bound WRITE refuses a stale scope before dispatching (never retargets)', async () => {
  // The §3.2 write contract: a stale scope takes an EXPLICIT refusal path
  // (`superseded`) and its sessionId is never dispatched to the replacement
  // owner — the exact failure mode a retained `/settings` panel scope hits.
  const live = slot({ agent: fakeAgent('s1'), generation: 3 })
  const facts = sessionScopeFacts(
    () => live.agent() as unknown as Agent,
    () => live.generation(),
  )
  const scope = facts.captureLiveSessionScope()
  assert.notEqual(scope, undefined)
  // A current scope applies.
  assert.equal(facts.setSessionApprovalPolicy(scope!, 'never'), 'applied')
  assert.deepEqual(await facts.applyPermissionPreset(scope!, 'danger-full-access'), { kind: 'applied' })
  // The SAME session id on a NEW owner object: both writes refuse.
  live.setAgent(fakeAgent('s1'))
  assert.equal(facts.setSessionApprovalPolicy(scope!, 'never'), 'superseded',
    'a stale sync write must refuse, not dispatch to the replacement owner')
  assert.deepEqual(await facts.applyPermissionPreset(scope!, 'danger-full-access'), { kind: 'superseded' },
    'a stale async write must refuse and never present a settlement')
})
