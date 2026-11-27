/**
 * The one shared local ACP endpoint shape. These are pure string-contract
 * cases: the real Windows Named Pipe/OACL behavior is proved by the native
 * qualification, never by a fake ACL here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACP_PIPE_PREFIX,
  acpPipeAddress,
  isAcpPipeAddress,
  isSafeLocalAcpEndpoint,
} from '../../src/app/remote-process/local-acp-endpoint.ts'

const SCOPE_ID = '0123456789abcdef'.repeat(4)

test('the endpoint helper derives the exact profile-scoped local Named Pipe address', () => {
  assert.equal(ACP_PIPE_PREFIX, '\\\\.\\pipe\\dsh-pi-tui-acp-')
  assert.equal(acpPipeAddress(SCOPE_ID), `\\\\.\\pipe\\dsh-pi-tui-acp-${SCOPE_ID}`)
  assert.equal(isAcpPipeAddress(acpPipeAddress(SCOPE_ID)), true)
})

test('the endpoint helper rejects a scope id that is not a canonical 64-character lowercase hex hash', () => {
  for (const invalid of ['', 'abc', SCOPE_ID.slice(1), `${SCOPE_ID}0`, SCOPE_ID.toUpperCase(), `${SCOPE_ID.slice(0, 63)}g`]) {
    assert.throws(() => acpPipeAddress(invalid), /canonical profile scope id/u)
    assert.equal(isAcpPipeAddress(`\\\\.\\pipe\\dsh-pi-tui-acp-${invalid}`), false)
  }
})

test('only the exact local product pipe is admitted as a Windows ACP endpoint', () => {
  const accepted = acpPipeAddress(SCOPE_ID)
  assert.equal(isSafeLocalAcpEndpoint(accepted, 'win32'), true)
  const rejected = [
    '',
    '/tmp/acp.sock',
    'C:\\temp\\acp.sock',
    `\\\\\\\\server\\\\pipe\\\\dsh-pi-tui-acp-${SCOPE_ID}`,
    `\\\\?\\pipe\\dsh-pi-tui-acp-${SCOPE_ID}`,
    `\\\\.\\pipe\\dsh-pi-tui-acp-${SCOPE_ID}-extra`,
    `\\\\.\\pipe\\dsh-pi-tui-acp-${SCOPE_ID} `,
    `\\\\.\\pipe\\other-acp-${SCOPE_ID}`,
    `\\\\.\\pipe\\dsh-pi-tui-acp-${SCOPE_ID.toUpperCase()}`,
  ]
  for (const value of rejected) assert.equal(isSafeLocalAcpEndpoint(value, 'win32'), false, value)
})

test('POSIX keeps the absolute-no-control path rule and never accepts the Windows pipe', () => {
  assert.equal(isSafeLocalAcpEndpoint('/tmp/acp.sock', 'linux'), true)
  assert.equal(isSafeLocalAcpEndpoint('/private/tmp/dpt-501-scope/acp.sock', 'darwin'), true)
  assert.equal(isSafeLocalAcpEndpoint('acp.sock', 'linux'), false)
  assert.equal(isSafeLocalAcpEndpoint('/tmp/bad\npath', 'linux'), false)
  assert.equal(isSafeLocalAcpEndpoint(acpPipeAddress(SCOPE_ID), 'linux'), false)
})
