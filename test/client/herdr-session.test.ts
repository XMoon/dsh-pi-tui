/**
 * H2 Herdr Session projection boundary (plan §3.1).
 *
 * The projection is a pure function: these cases pin the canonical-id gate,
 * the Direct/daemon resume-target split, the exact public argv shape and the
 * upstream Herdr argv legality bounds. No Host, terminal or process is
 * involved.
 *
 * @module @xmoon76/dsh-pi-tui/client/herdr-session.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { herdrSessionProjection, type HerdrResumeTarget } from '../../src/client/herdr/session.ts'

const ID = 'session-0123456789abcdef0123456789abcdef'
const UUID_ID = 'session-123e4567-e89b-12d3-a456-426614174000'

const DIRECT: HerdrResumeTarget = { kind: 'direct', profile: 'pi-tui' }
const DAEMON: HerdrResumeTarget = { kind: 'daemon', profile: 'tui-custom' }

test('a legal Direct Session projects the exact five-word public cold-open argv', () => {
  assert.deepEqual(herdrSessionProjection(ID, DIRECT), {
    sessionId: ID,
    resumeArgv: ['dsh', '--profile', 'pi-tui', '--session', ID],
  })
  const projection = herdrSessionProjection(UUID_ID, { kind: 'direct', profile: 'work' })
  assert.deepEqual(projection?.resumeArgv, ['dsh', '--profile', 'work', '--session', UUID_ID])
  assert.equal(projection?.resumeArgv?.length, 5, 'the frozen argv is exactly five arguments')
  assert.deepEqual(projection?.resumeArgv?.slice(0, 4), ['dsh', '--profile', 'work', '--session'],
    'the argv order is fixed: dsh --profile <actual> --session <id>')
})

test('a legal daemon Session projects the exact seven-word pinned-backend argv', () => {
  assert.deepEqual(herdrSessionProjection(ID, DAEMON), {
    sessionId: ID,
    resumeArgv: ['env', 'DSH_PI_TUI_BACKEND=daemon', 'dsh', '--profile', 'tui-custom', '--session', ID],
  })
  const projection = herdrSessionProjection(UUID_ID, DAEMON)
  assert.equal(projection?.resumeArgv?.length, 7, 'the daemon argv is exactly seven arguments')
  assert.deepEqual(projection?.resumeArgv?.slice(0, 3), ['env', 'DSH_PI_TUI_BACKEND=daemon', 'dsh'],
    'the daemon argv pins the backend with the PATH command word env')
  assert.deepEqual(projection?.resumeArgv?.slice(3), ['--profile', 'tui-custom', '--session', UUID_ID],
    'the daemon argv keeps the public profile/session grammar')
})

test('an unknown resume target reports the canonical id only', () => {
  assert.deepEqual(herdrSessionProjection(ID, undefined), { sessionId: ID })
  assert.equal(Object.hasOwn(herdrSessionProjection(ID, undefined) ?? {}, 'resumeArgv'), false,
    'an unknown target must not invent a resume argv')
})

test('both canonical id forms are accepted as reportable Sessions', () => {
  for (const id of [
    ID,
    'session_0123456789abcdef0123456789abcdef',
    UUID_ID,
    'session_123E4567-E89B-12D3-A456-426614174000',
  ]) {
    assert.deepEqual(herdrSessionProjection(id, undefined), { sessionId: id })
    assert.deepEqual(herdrSessionProjection(id, DIRECT)?.resumeArgv,
      ['dsh', '--profile', 'pi-tui', '--session', id])
    assert.deepEqual(herdrSessionProjection(id, DAEMON)?.resumeArgv,
      ['env', 'DSH_PI_TUI_BACKEND=daemon', 'dsh', '--profile', 'tui-custom', '--session', id])
  }
})

test('sessionless and non-canonical ids never become a resume target', () => {
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
    assert.equal(herdrSessionProjection(id, DIRECT), undefined, `Direct id ${String(id)} must not be reportable`)
    assert.equal(herdrSessionProjection(id, DAEMON), undefined, `daemon id ${String(id)} must not be reportable`)
    assert.equal(herdrSessionProjection(id, undefined), undefined, `unknown-target id ${String(id)} must not be reportable`)
  }
})

test('an illegal profile drops only the resume argv, never the Session id', () => {
  for (const profile of [
    "pro'file",
    'pro\nfile',
    'pro\0file',
    'pro\u001bfile',
    'pro\u007ffile',
    'pro\u009bfile',
  ]) {
    assert.deepEqual(herdrSessionProjection(ID, { kind: 'direct', profile }), { sessionId: ID },
      `Direct profile ${JSON.stringify(profile)} must not produce a resume command`)
    assert.deepEqual(herdrSessionProjection(ID, { kind: 'daemon', profile }), { sessionId: ID },
      `daemon profile ${JSON.stringify(profile)} must not produce a resume command`)
  }
})

test('the upstream 8192-byte argv ceiling drops the resume argv for both targets', () => {
  const directFixedBytes = ['dsh', '--profile', '--session', ID]
    .reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0)
  const fittingDirect = herdrSessionProjection(ID, { kind: 'direct', profile: 'x'.repeat(8192 - directFixedBytes) })
  assert.ok(fittingDirect?.resumeArgv !== undefined, 'a Direct argv at exactly 8192 bytes is legal')
  assert.equal(fittingDirect.resumeArgv.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0), 8192)
  const overDirect = herdrSessionProjection(ID, { kind: 'direct', profile: 'x'.repeat(8192 - directFixedBytes + 1) })
  assert.deepEqual(overDirect, { sessionId: ID }, 'one byte over the ceiling drops only the resume argv')

  const daemonFixedBytes = ['env', 'DSH_PI_TUI_BACKEND=daemon', 'dsh', '--profile', '--session', ID]
    .reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0)
  const fittingDaemon = herdrSessionProjection(ID, { kind: 'daemon', profile: 'x'.repeat(8192 - daemonFixedBytes) })
  assert.ok(fittingDaemon?.resumeArgv !== undefined, 'a daemon argv at exactly 8192 bytes is legal')
  assert.equal(fittingDaemon.resumeArgv.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8'), 0), 8192)
  const overDaemon = herdrSessionProjection(ID, { kind: 'daemon', profile: 'x'.repeat(8192 - daemonFixedBytes + 1) })
  assert.deepEqual(overDaemon, { sessionId: ID }, 'one byte over the ceiling drops only the resume argv')
})

test('the projection is deterministic and carries no environment value', () => {
  const secret = 'herdr-hidden-secret-0123456789'
  const previous = process.env.HERDR_TEST_SECRET
  process.env.HERDR_TEST_SECRET = secret
  try {
    const first = herdrSessionProjection(ID, DIRECT)
    const second = herdrSessionProjection(ID, DIRECT)
    assert.deepEqual(first, second)
    const rendered = JSON.stringify(first)
    assert.equal(rendered.includes(secret), false, 'no environment value may enter the projection')
    assert.equal(rendered.includes('HOME'), false, 'no environment key may enter the projection')
  } finally {
    if (previous === undefined) delete process.env.HERDR_TEST_SECRET
    else process.env.HERDR_TEST_SECRET = previous
  }
})
