/**
 * The CLI Session-launch policy (PR2): pure classification over the official
 * main roster and Workspace membership. These tests protect the exact/unique
 * prefix/`-c` decision rules without constructing a runner.
 * @module @xmoon76/dsh-pi-tui/session-launch-intent.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalFullSessionId,
  chooseContinueSession,
  chooseListedSession,
  cliAutoPrefix,
  type LaunchSessionRow,
} from '../../src/app/bootstrap/session-launch-intent.ts'

function rows(...ids: string[]): LaunchSessionRow[] {
  return ids.map(id => ({ id }))
}

// ── canonical full ids ──────────────────────────────────────────────────────

test('a canonical full Session id needs the session prefix and 32 hex characters', () => {
  assert.equal(canonicalFullSessionId(`session-${'a'.repeat(32)}`), true)
  assert.equal(canonicalFullSessionId(`session_${'a'.repeat(32)}`), true)
  assert.equal(canonicalFullSessionId('session-01234567-89ab-cdef-0123-456789abcdef'), true,
    'the canonical hyphenated UUID form is allowed')
  assert.equal(canonicalFullSessionId(`session_${'A'.repeat(32)}`), true, 'hex is case-insensitive')
  assert.equal(canonicalFullSessionId('01234567-89ab-cdef-0123-456789abcdef'), false,
    'a BARE UUID is not a canonical Session id: it must match a listed row')
  assert.equal(canonicalFullSessionId(`${'a'.repeat(32)}`), false, 'a bare hex id has no Session prefix')
  assert.equal(canonicalFullSessionId('session-mysql'), false)
  assert.equal(canonicalFullSessionId(`session-${'a'.repeat(31)}`), false)
  assert.equal(canonicalFullSessionId(`session-${'g'.repeat(32)}`), false)
})

// ── the CLI automatic-prefix gate ───────────────────────────────────────────

test('the CLI automatic prefix is at least four hex characters after an optional prefix', () => {
  assert.equal(cliAutoPrefix('abcd'), 'abcd')
  assert.equal(cliAutoPrefix('session-abcd'), 'abcd')
  assert.equal(cliAutoPrefix('session_abcd'), 'abcd')
  assert.equal(cliAutoPrefix('ABCD'), 'ABCD')
  assert.equal(cliAutoPrefix('abc'), undefined, 'three digits are too short to auto-resume')
  assert.equal(cliAutoPrefix('mysql'), undefined, 'a word is never an automatic prefix')
  assert.equal(cliAutoPrefix('deadbeef-x'), undefined, 'only a pure hex prefix is automatic')
  assert.equal(cliAutoPrefix('session-'), undefined)
  assert.equal(cliAutoPrefix(''), undefined)
})

// ── listed-roster choice ────────────────────────────────────────────────────

test('an official exact row id wins over every prefix candidate', () => {
  const listed = rows('session-abcdef12-0000', 'session-abcdef12-0001')
  assert.equal(chooseListedSession(listed, 'session-abcdef12-0001'), 'session-abcdef12-0001')
})

test('an exact historical non-standard row id can still resume', () => {
  assert.equal(chooseListedSession(rows('imported-session'), 'imported-session'), 'imported-session')
})

test('a unique legal short prefix resolves through the SAME primitive', () => {
  assert.equal(chooseListedSession(rows('session-abcdef12-0000', 'session-fedcba98-0000'), 'abcd'), 'session-abcdef12-0000')
  assert.equal(chooseListedSession(rows('session-abcdef12-0000'), 'session-abcd'), 'session-abcdef12-0000')
})

test('an ambiguous short prefix is never an automatic resume', () => {
  assert.equal(chooseListedSession(rows('session-abcdef12-0000', 'session-abcdef34-0000'), 'abcd'), undefined)
})

test('a word-like or too-short query never auto-resumes a matching id', () => {
  assert.equal(chooseListedSession(rows('session-mysql-0000'), 'mysql'), undefined,
    'a word that merely begins an id must search, not resume')
  assert.equal(chooseListedSession(rows('session-abc1-0000'), 'abc'), undefined)
  assert.equal(chooseListedSession(rows('session-'), 'session-'), undefined)
})

test('a prefix never selects a subagent child, while an explicit exact id is the user intent', () => {
  const listed: LaunchSessionRow[] = [
    { id: 'session-abcdef12-0000', origin: 'subagent' },
    { id: 'session-abcdef99-0000' },
  ]
  assert.equal(chooseListedSession(listed, 'abcd'), 'session-abcdef99-0000',
    'the subagent row is excluded from automatic prefix selection')
  assert.equal(chooseListedSession(listed, 'session-abcdef12-0000'), 'session-abcdef12-0000',
    'an explicitly named full id remains exact')
})

// ── the `-c` choice ─────────────────────────────────────────────────────────

test('-c takes the FIRST roster row in the confirmed Workspace membership', () => {
  const listed = rows('s-global-latest', 's-new', 's-old')
  assert.equal(chooseContinueSession(listed, ['s-old', 's-new']), 's-new',
    'the official roster order is kept; a workspace-foreign newest row is never chosen')
  assert.equal(chooseContinueSession(listed, ['s-old']), 's-old')
})

test('-c never chooses a subagent child or a non-member', () => {
  const listed: LaunchSessionRow[] = [
    { id: 's-sub', origin: 'subagent' },
    { id: 's-member' },
    { id: 's-foreign' },
  ]
  assert.equal(chooseContinueSession(listed, ['s-sub', 's-member']), 's-member')
  assert.equal(chooseContinueSession(listed, ['s-sub']), undefined)
  assert.equal(chooseContinueSession(listed, ['s-foreign']), 's-foreign')
  assert.equal(chooseContinueSession([], ['s-member']), undefined)
  assert.equal(chooseContinueSession(listed, []), undefined)
})
