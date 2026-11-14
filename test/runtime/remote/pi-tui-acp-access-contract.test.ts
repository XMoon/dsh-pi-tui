/**
 * UNIT: the strict `piTuiAcpAccess` wire contract (PO-1B).
 *
 * The Host is the only producer of these frames, but they still cross the wire,
 * so the DTO boundary is real: an extra field (a socket pathname, a launch
 * token, a profile path), an unknown state or a defaulted-away `unavailable`
 * reason must be refused instead of forwarded. Structural tests only — the real
 * Gateway (L5) and the two-OS-process socket proof (L6) live in the dedicated
 * suites.
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-acp-access-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PI_TUI_ACP_ACCESS_GET_STATUS,
  PI_TUI_ACP_ACCESS_GET_STATUS_ENDPOINT,
  PI_TUI_ACP_ACCESS_NAMESPACE,
  PI_TUI_ACP_ACCESS_PACKAGE,
  PI_TUI_ACP_ACCESS_SET_ENABLED,
  PI_TUI_ACP_ACCESS_SET_ENABLED_ENDPOINT,
  parsePiTuiAcpAccessStatus,
} from '../../../src/runtime/remote/pi-tui-acp-access-contract.ts'
import {
  PI_TUI_CLIENT_CONTRIBUTION,
  PI_TUI_HOST_CONTRIBUTION,
  PI_TUI_REMOTE_PACKAGE,
} from '../../../src/runtime/remote/pi-tui-remote-contribution.ts'

test('UNIT: the two descriptors share ONE private namespace and strict endpoint ids', () => {
  assert.equal(PI_TUI_ACP_ACCESS_NAMESPACE, 'piTuiAcpAccess')
  assert.equal(PI_TUI_ACP_ACCESS_PACKAGE, PI_TUI_REMOTE_PACKAGE)
  assert.equal(PI_TUI_ACP_ACCESS_GET_STATUS_ENDPOINT, '@xmoon76/dsh-pi-tui#piTuiAcpAccess/getStatus')
  assert.equal(PI_TUI_ACP_ACCESS_SET_ENABLED_ENDPOINT, '@xmoon76/dsh-pi-tui#piTuiAcpAccess/setEnabled')
  for (const descriptor of [PI_TUI_ACP_ACCESS_GET_STATUS, PI_TUI_ACP_ACCESS_SET_ENABLED]) {
    assert.equal(descriptor.service, PI_TUI_ACP_ACCESS_NAMESPACE)
    assert.equal(descriptor.namespace, PI_TUI_ACP_ACCESS_NAMESPACE)
    assert.equal(descriptor.id, `@xmoon76/dsh-pi-tui#${PI_TUI_ACP_ACCESS_NAMESPACE}/${descriptor.method}`)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
  }
  assert.deepEqual(PI_TUI_ACP_ACCESS_GET_STATUS.parameters.map(p => p.name), [])
  assert.deepEqual(PI_TUI_ACP_ACCESS_SET_ENABLED.parameters.map(p => p.name), ['enabled'])
  const [enabled] = PI_TUI_ACP_ACCESS_SET_ENABLED.parameters
  assert.equal(enabled.wire, 'enabled')
  assert.equal(enabled.source, 'json')
})

test('UNIT: the ONE Host and Client contributions carry the SAME two descriptors exactly once', () => {
  assert.equal(PI_TUI_HOST_CONTRIBUTION.invocations.filter(d => d === PI_TUI_ACP_ACCESS_GET_STATUS).length, 1)
  assert.equal(PI_TUI_HOST_CONTRIBUTION.invocations.filter(d => d === PI_TUI_ACP_ACCESS_SET_ENABLED).length, 1)
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.descriptors.filter(d => d === PI_TUI_ACP_ACCESS_GET_STATUS).length, 1)
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.descriptors.filter(d => d === PI_TUI_ACP_ACCESS_SET_ENABLED).length, 1)
  assert.equal(PI_TUI_HOST_CONTRIBUTION.package, PI_TUI_REMOTE_PACKAGE)
  assert.equal(PI_TUI_CLIENT_CONTRIBUTION.package, PI_TUI_REMOTE_PACKAGE)
})

test('UNIT: the boolean wire parameter uses a strict codec with a stable symbol', () => {
  const parameter = PI_TUI_ACP_ACCESS_SET_ENABLED.parameters[0]
  assert.equal(parameter.codec.mode, 'strict')
  assert.equal(parameter.codec.typeSymbol, '@xmoon76/dsh-pi-tui#piTuiAcpAccess/setEnabled:enabled')
})

test('UNIT: a valid status frame validates; every other shape is refused', () => {
  assert.deepEqual(parsePiTuiAcpAccessStatus({ state: 'enabled' }), { state: 'enabled' })
  assert.deepEqual(parsePiTuiAcpAccessStatus({ state: 'disabled' }), { state: 'disabled' })
  assert.deepEqual(parsePiTuiAcpAccessStatus({ state: 'changing' }), { state: 'changing' })
  assert.deepEqual(
    parsePiTuiAcpAccessStatus({ state: 'unavailable', reason: 'the Host is shutting down' }),
    { state: 'unavailable', reason: 'the Host is shutting down' },
  )
  // A stray field (a socket pathname / token / profile path) is a different shape.
  assert.throws(() => parsePiTuiAcpAccessStatus({ state: 'enabled', socketPath: '/x/acp.sock' }),
    /unexpected result field/u)
  assert.throws(() => parsePiTuiAcpAccessStatus({ state: 'disabled', reason: 'x' }),
    /unexpected result field/u)
  // An `unavailable` result MUST carry a non-empty reason, and no other field.
  assert.throws(() => parsePiTuiAcpAccessStatus({ state: 'unavailable' }), /non-empty reason/u)
  assert.throws(() => parsePiTuiAcpAccessStatus({ state: 'unavailable', reason: '' }), /non-empty reason/u)
  // Unknown state and non-object frames are refused.
  assert.throws(() => parsePiTuiAcpAccessStatus({ state: 'listening' }), /must be disabled, enabled, changing or unavailable/u)
  assert.throws(() => parsePiTuiAcpAccessStatus(null), /must be an object/u)
  assert.throws(() => parsePiTuiAcpAccessStatus('enabled'), /must be an object/u)
})
