/**
 * H2 Herdr Session projection boundary (plan §3.1).
 *
 * The projection is a pure function: these cases pin the canonical-id gate,
 * the Direct/Remote split, the exact public argv shape and the upstream Herdr
 * argv legality bounds. No Host, terminal or process is involved.
 *
 * @module @xmoon76/dsh-pi-tui/client/herdr-session.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { herdrSessionProjection } from '../../src/client/herdr/session.ts'

const ID = 'session-0123456789abcdef0123456789abcdef'
const UUID_ID = 'session-123e4567-e89b-12d3-a456-426614174000'

test('HS-01 a legal Direct Session projects the exact five-word public cold-open argv', () => {
  assert.deepEqual(herdrSessionProjection(ID, 'pi-tui'), {
    sessionId: ID,
    resumeArgv: ['dsh', '--profile', 'pi-tui', '--session', ID],
  })
  const projection = herdrSessionProjection(UUID_ID, 'work')
  assert.deepEqual(projection?.resumeArgv, ['dsh', '--profile', 'work', '--session', UUID_ID])
  assert.equal(projection?.resumeArgv?.length, 5, 'the frozen argv is exactly five arguments')
  assert.deepEqual(projection?.resumeArgv?.slice(0, 4), ['dsh', '--profile', 'work', '--session'],
    'the argv order is fixed: dsh --profile <actual> --session <id>')
})

test('HS-02 a Remote Session reports the canonical id only', () => {
  assert.deepEqual(herdrSessionProjection(ID, undefined), { sessionId: ID })
  assert.equal(Object.hasOwn(herdrSessionProjection(ID, undefined) ?? {}, 'resumeArgv'), false,
    'Remote must not carry any resume argv field')
})

test('HS-03 both canonical id forms are accepted', () => {
  for (const id of [
    ID,
    'session_0123456789abcdef0123456789abcdef',
    UUID_ID,
    'session_123E4567-E89B-12D3-A456-426614174000',
  ]) {
    assert.deepEqual(herdrSessionProjection(id, undefined), { sessionId: id })
  }
})

test('HS-04 sessionless and non-canonical ids never become a resume target', () => {
  for (const id of [
    undefined,
    '',
    '0123456789abcdef0123456789abcdef', // bare UUID/hex, no Session prefix
    '123e4567-e89b-12d3-a456-426614174000', // bare hyphenated UUID
    'session-', // prefix only
    'session-0123456789abcdef', // fuzzy prefix
    'session-0123456789abcdef0123456789abcde', // 31 hex chars
    'agent-0123456789abcdef0123456789abcdef',
    'session-0123456789abcdef0123456789abcdef-extra',
  ]) {
    assert.equal(herdrSessionProjection(id, 'pi-tui'), undefined, `id ${String(id)} must not be reportable`)
    assert.equal(herdrSessionProjection(id, undefined), undefined, `Remote id ${String(id)} must not be reportable`)
  }
})

test('HS-05 an illegal Direct profile drops only the resume argv, never the Session id', () => {
  for (const profile of [
    "pro'file",
    'pro\nfile',
    'pro\0file',
    'pro\u001bfile',
    'pro\u007ffile',
    'pro\u009bfile',
  ]) {
    assert.deepEqual(herdrSessionProjection(ID, profile), { sessionId: ID },
      `profile ${JSON.stringify(profile)} must not produce a resume command`)
  }
})

test('HS-06 the upstream 8192-byte argv ceiling drops the resume argv', () => {
  const fixedBytes = ['dsh', '--profile', '--session', ID]
    .reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0)
  const fitting = herdrSessionProjection(ID, 'x'.repeat(8192 - fixedBytes))
  assert.ok(fitting?.resumeArgv !== undefined, 'an argv at exactly 8192 bytes is legal')
  const fittingBytes = fitting.resumeArgv.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0)
  assert.equal(fittingBytes, 8192)

  const over = herdrSessionProjection(ID, 'x'.repeat(8192 - fixedBytes + 1))
  assert.deepEqual(over, { sessionId: ID }, 'one byte over the ceiling drops only the resume argv')
})

test('HS-07 the projection is deterministic for the same id/profile and leaks nothing else', () => {
  const secret = 'herdr-hidden-secret-0123456789'
  const previous = process.env.HERDR_TEST_SECRET
  process.env.HERDR_TEST_SECRET = secret
  try {
    const first = herdrSessionProjection(ID, 'pi-tui')
    const second = herdrSessionProjection(ID, 'pi-tui')
    assert.deepEqual(first, second)
    const rendered = JSON.stringify(first)
    assert.equal(rendered.includes(secret), false, 'no environment value may enter the projection')
    assert.equal(rendered.includes('HOME'), false, 'no environment key may enter the projection')
  } finally {
    if (previous === undefined) delete process.env.HERDR_TEST_SECRET
    else process.env.HERDR_TEST_SECRET = previous
  }
})
