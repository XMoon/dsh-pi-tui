/**
 * UNIT: the strict `piTuiSessionPolicy` wire contract (M6-1 F8).
 *
 * The Host is the only producer of these frames, but they still cross the
 * wire, so the DTO boundary is a real one: an extra field (a Host session
 * path, an Agent object, a workspace root), a bad session id, an unknown
 * enum, an open-ended state union or a defaulted-away override must be
 * refused instead of forwarded. Structural tests only — the real Gateway
 * (L5) and two-Client OS-process (L6) proofs live in the dedicated suites.
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-session-policy-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PI_TUI_SESSION_POLICY_NAMESPACE,
  PI_TUI_SESSION_POLICY_PACKAGE,
  PI_TUI_SESSION_POLICY_READ,
  PI_TUI_SESSION_POLICY_READ_ENDPOINT,
  PI_TUI_SESSION_POLICY_SET_APPROVAL,
  PI_TUI_SESSION_POLICY_SET_APPROVAL_ENDPOINT,
  parseSessionPolicyRead,
  parseSessionApprovalPolicy,
  parseSessionPolicySessionId,
  parseSessionPolicySetWireOutcome,
} from '../../../src/runtime/remote/pi-tui-session-policy-contract.ts'
import {
  PI_TUI_CLIENT_CONTRIBUTION,
  PI_TUI_HOST_CONTRIBUTION,
  PI_TUI_REMOTE_PACKAGE,
} from '../../../src/runtime/remote/pi-tui-remote-contribution.ts'

test('UNIT: the two descriptors share ONE private namespace and strict endpoint ids', () => {
  assert.equal(PI_TUI_SESSION_POLICY_NAMESPACE, 'piTuiSessionPolicy')
  assert.equal(PI_TUI_SESSION_POLICY_PACKAGE, PI_TUI_REMOTE_PACKAGE)
  for (const descriptor of [PI_TUI_SESSION_POLICY_READ, PI_TUI_SESSION_POLICY_SET_APPROVAL]) {
    assert.equal(descriptor.service, PI_TUI_SESSION_POLICY_NAMESPACE)
    assert.equal(descriptor.namespace, PI_TUI_SESSION_POLICY_NAMESPACE)
    assert.equal(descriptor.id, `@xmoon76/dsh-pi-tui#${PI_TUI_SESSION_POLICY_NAMESPACE}/${descriptor.method}`)
    assert.equal(descriptor.cancellation?.parameter, 'signal')
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    assert.equal(descriptor.mode, undefined, 'both methods are direct unary invocations')
  }
  assert.deepEqual(PI_TUI_SESSION_POLICY_READ.parameters.map(p => p.name), ['sessionId'])
  assert.deepEqual(PI_TUI_SESSION_POLICY_SET_APPROVAL.parameters.map(p => p.name), ['sessionId', 'policy'])
  for (const parameter of [...PI_TUI_SESSION_POLICY_READ.parameters, ...PI_TUI_SESSION_POLICY_SET_APPROVAL.parameters]) {
    assert.equal(parameter.wire, parameter.name, 'the wire name is the literal parameter name')
    assert.equal(parameter.source, 'json')
  }
})

test('UNIT: the ONE Host and Client contributions carry the SAME two descriptors exactly once', () => {
  assert.equal(PI_TUI_HOST_CONTRIBUTION.invocations.filter(d => d === PI_TUI_SESSION_POLICY_READ).length, 1)
  assert.equal(PI_TUI_HOST_CONTRIBUTION.invocations.filter(d => d === PI_TUI_SESSION_POLICY_SET_APPROVAL).length, 1)
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.descriptors.filter(d => d === PI_TUI_SESSION_POLICY_READ).length, 1)
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.descriptors.filter(d => d === PI_TUI_SESSION_POLICY_SET_APPROVAL).length, 1)
  assert.equal(PI_TUI_HOST_CONTRIBUTION.package, PI_TUI_REMOTE_PACKAGE)
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.package, PI_TUI_REMOTE_PACKAGE)
})

test('UNIT: a ready read frame validates with exact fields; an absent override stays absent', () => {
  const parsed = parseSessionPolicyRead({
    kind: 'ready',
    sessionId: 'session-a',
    approval: { state: 'ready', effective: 'never', override: 'never' },
    sandbox: { state: 'ready', effective: 'read-only' },
  })
  assert.deepEqual(parsed, {
    kind: 'ready',
    sessionId: 'session-a',
    approval: { state: 'ready', effective: 'never', override: 'never' },
    sandbox: { state: 'ready', effective: 'read-only' },
  })
  assert.ok(parsed.kind === 'ready')
  // No override on the sandbox side: the field is ABSENT, never `undefined`
  // spelled on the wire, and no default is invented.
  assert.equal('override' in parsed.sandbox, false)
})

test('UNIT: an unavailable read frame carries the closed reason; unknown kinds and extra fields are refused', () => {
  assert.deepEqual(parseSessionPolicyRead({ kind: 'unavailable', sessionId: 's', reason: 'session-not-live' }), {
    kind: 'unavailable', sessionId: 's', reason: 'session-not-live',
  })
  assert.throws(() => parseSessionPolicyRead({ kind: 'ready', sessionId: 's', approval: { state: 'ready', effective: 'ask' }, sandbox: { state: 'ready', effective: 'read-only' }, extra: true }), /unexpected field/u)
  assert.throws(() => parseSessionPolicyRead({ kind: 'unknown' }), /unknown kind/u)
  assert.throws(() => parseSessionPolicyRead({ kind: 'unavailable', sessionId: 's', reason: 'made-up' }), /unknown unavailable reason/u)
  assert.throws(() => parseSessionPolicyRead({ kind: 'ready', sessionId: '', approval: { state: 'ready', effective: 'ask' }, sandbox: { state: 'ready', effective: 'read-only' } }), /non-empty/u)
})

test('UNIT: per-side failures stay independent and closed (service-not-installed only)', () => {
  const parsed = parseSessionPolicyRead({
    kind: 'ready',
    sessionId: 's',
    approval: { state: 'unavailable', reason: 'service-not-installed' },
    sandbox: { state: 'ready', effective: 'danger-full-access', override: 'danger-full-access' },
  })
  assert.ok(parsed.kind === 'ready')
  assert.deepEqual(parsed.approval, { state: 'unavailable', reason: 'service-not-installed' })
  assert.deepEqual(parsed.sandbox, { state: 'ready', effective: 'danger-full-access', override: 'danger-full-access' })
  assert.throws(() => parseSessionPolicyRead({
    kind: 'ready', sessionId: 's',
    approval: { state: 'unavailable', reason: 'wire-loss' },
    sandbox: { state: 'ready', effective: 'read-only' },
  }), /unknown unavailable reason/u)
  assert.throws(() => parseSessionPolicyRead({
    kind: 'ready', sessionId: 's',
    approval: { state: 'ready', effective: 'sometimes' },
    sandbox: { state: 'ready', effective: 'read-only' },
  }), /ask or never/u)
  assert.throws(() => parseSessionPolicyRead({
    kind: 'ready', sessionId: 's',
    approval: { state: 'ready', effective: 'ask' },
    sandbox: { state: 'ready', effective: 'full' },
  }), /unknown sandbox mode/u)
})

test('UNIT: the setApproval result is the closed applied/refused union; unconfirmed never crosses the wire', () => {
  assert.deepEqual(parseSessionPolicySetWireOutcome({ kind: 'applied', sessionId: 's' }), { kind: 'applied', sessionId: 's' })
  assert.deepEqual(parseSessionPolicySetWireOutcome({ kind: 'refused', reason: 'agent-not-live' }), { kind: 'refused', reason: 'agent-not-live' })
  assert.throws(() => parseSessionPolicySetWireOutcome({ kind: 'unconfirmed', reason: 'x' }), /unknown kind/u)
  assert.throws(() => parseSessionPolicySetWireOutcome({ kind: 'refused', reason: 'wire-loss' }), /unknown refusal reason/u)
  assert.throws(() => parseSessionPolicySetWireOutcome({ kind: 'applied', sessionId: 's', extra: 1 }), /unexpected field/u)
})

test('UNIT: parameter codecs reject bad ids and open policy vocabularies', () => {
  assert.equal(parseSessionPolicySessionId('session-a'), 'session-a')
  assert.throws(() => parseSessionPolicySessionId(''), /non-empty/u)
  assert.throws(() => parseSessionPolicySessionId(42 as never), /non-empty/u)
  assert.equal(parseSessionApprovalPolicy('never'), 'never')
  assert.equal(parseSessionApprovalPolicy('ask'), 'ask')
  assert.throws(() => parseSessionApprovalPolicy('always'), /ask or never/u)
})

test('UNIT: no Host-internal identity rides the frame vocabulary', () => {
  // The strict parsers accept ONLY the detached vocabulary: every field name
  // outside the closed set is refused and the two enums are closed unions, so
  // a Host session path, workspace root or Agent-shaped value cannot be
  // spelled into a valid frame anywhere except the opaque session-id string.
  assert.throws(() => parseSessionPolicyRead({ kind: 'ready', sessionId: 's', workspace: '/home/host' }), /unexpected field/u)
  assert.throws(() => parseSessionPolicyRead({ kind: 'ready', sessionId: 's', agent: {} }), /unexpected field/u)
})
