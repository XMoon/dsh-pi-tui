/**
 * OSC 7501 program-status encoding and pure projection (plan §2/§4.2/§6.1).
 *
 * L1 client semantics only: byte-exact wire sequences, the closed record
 * vocabulary, the running/phase/agentInputWait/settled projection and the
 * semantic dedupe key. No Host, no terminal, no I/O.
 * @module @xmoon76/dsh-pi-tui/program-status-osc7501.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveProgramStatus,
  programStatusSequence,
  sameProgramStatus,
  type ProgramStatus,
} from '../src/tui/terminal/program-status.ts'
import type { RunPhase } from '../src/domain/status/types.ts'
import type { TerminalProgressOutcome } from '../src/domain/terminal-progress/settings.ts'

const ST = '\x1b\\'

test('every record encodes to its exact OSC 7501 sequence', () => {
  // Byte-exact wire contract (plan §2): `ESC ] 7501 ;` payload `ST`, with the
  // fixed `app` field last, `kind` only for blocked, and a bare clear.
  const cases: ReadonlyArray<readonly [ProgramStatus, string]> = [
    [{ state: 'idle' }, `\x1b]7501;state=idle:app=dsh-pi-tui${ST}`],
    [{ state: 'working' }, `\x1b]7501;state=working:app=dsh-pi-tui${ST}`],
    [{ state: 'blocked', kind: 'permission' }, `\x1b]7501;state=blocked:kind=permission:app=dsh-pi-tui${ST}`],
    [{ state: 'blocked', kind: 'question' }, `\x1b]7501;state=blocked:kind=question:app=dsh-pi-tui${ST}`],
    [{ state: 'done' }, `\x1b]7501;state=done:app=dsh-pi-tui${ST}`],
    [{ state: 'error' }, `\x1b]7501;state=error:app=dsh-pi-tui${ST}`],
    [{ state: 'clear' }, `\x1b]7501;state=clear${ST}`],
  ]
  for (const [report, expected] of cases) {
    assert.equal(programStatusSequence(report), expected, `wire bytes for ${report.state}`)
    assert.ok(programStatusSequence(report).endsWith(ST), 'ST must be ESC backslash, never BEL')
    assert.ok(!programStatusSequence(report).includes('\x07'), 'never BEL-terminated')
  }
})

test('working and blocked records carry no fabricated progress/title/msg fields', () => {
  // The v1 decision is root-only: `progress`, `title` and `msg` must never be
  // invented from a state that has no such fact.
  for (const report of [
    { state: 'working' } as const,
    { state: 'blocked', kind: 'permission' } as const,
    { state: 'blocked', kind: 'question' } as const,
    { state: 'idle' } as const,
  ] as const) {
    const sequence = programStatusSequence(report)
    assert.ok(!sequence.includes('progress='), `no fabricated progress in ${report.state}`)
    assert.ok(!sequence.includes('title='), `no fabricated title in ${report.state}`)
    assert.ok(!sequence.includes('msg='), `no fabricated msg in ${report.state}`)
    assert.ok(!sequence.includes('id='), 'the root record omits id')
  }
  assert.equal(programStatusSequence({ state: 'clear' }), `\x1b]7501;state=clear${ST}`,
    'clear carries no other field')
})

test('a non-running Agent never reports blocked, however the phase looks', () => {
  const settledCases: TerminalProgressOutcome[] = ['idle', 'done', 'error']
  for (const settled of settledCases) {
    for (const phase of ['idle', 'working', 'waiting-approval', 'waiting-question', 'compacting'] as RunPhase[]) {
      assert.deepEqual(deriveProgramStatus(false, phase, true, settled), { state: settled },
        `not running + ${phase} + wait must stay ${settled}`)
    }
  }
})

test('a running Agent reports blocked ONLY for a proven Agent-blocking wait', () => {
  assert.deepEqual(deriveProgramStatus(true, 'waiting-approval', true, 'idle'), { state: 'blocked', kind: 'permission' })
  assert.deepEqual(deriveProgramStatus(true, 'waiting-question', true, 'idle'), { state: 'blocked', kind: 'question' })
  // The SAME phase without the lifecycle-owned Agent-wait fact is working: a
  // Client-local modal (/login, a plugin confirm) and a CONTINUED late answer
  // whose Agent already moved on both keep the pane working.
  assert.deepEqual(deriveProgramStatus(true, 'waiting-approval', false, 'idle'), { state: 'working' })
  assert.deepEqual(deriveProgramStatus(true, 'waiting-question', false, 'idle'), { state: 'working' })
  assert.deepEqual(deriveProgramStatus(true, 'working', false, 'idle'), { state: 'working' })
  assert.deepEqual(deriveProgramStatus(true, 'compacting', false, 'idle'), { state: 'working' })
  // A stale settled outcome can never leak into a running interval.
  assert.deepEqual(deriveProgramStatus(true, 'working', false, 'done'), { state: 'working' })
})

test('the dedupe key compares the full semantic record (state + kind)', () => {
  assert.equal(sameProgramStatus({ state: 'working' }, { state: 'working' }), true)
  assert.equal(sameProgramStatus({ state: 'idle' }, { state: 'done' }), false)
  assert.equal(sameProgramStatus({ state: 'blocked', kind: 'permission' }, { state: 'blocked', kind: 'question' }), false,
    'a blocked kind switch is a NEW record')
  assert.equal(sameProgramStatus({ state: 'blocked', kind: 'question' }, { state: 'blocked', kind: 'question' }), true)
  assert.equal(sameProgramStatus({ state: 'clear' }, { state: 'clear' }), true)
  assert.equal(sameProgramStatus({ state: 'clear' }, { state: 'idle' }), false)
})

test('an unchanged semantic record produces no second write', () => {
  // The writer's dedupe contract in isolation: the same (running, phase, wait,
  // settled) inputs must fold to a record `sameProgramStatus` calls equal, so
  // a repeated status/phase commit is physically inert.
  const first = deriveProgramStatus(true, 'waiting-question', true, 'idle')
  const second = deriveProgramStatus(true, 'waiting-question', true, 'idle')
  assert.equal(sameProgramStatus(first, second), true)
  const switched = deriveProgramStatus(true, 'waiting-approval', true, 'idle')
  assert.equal(sameProgramStatus(first, switched), false, 'a permission/question switch is observable')
})
