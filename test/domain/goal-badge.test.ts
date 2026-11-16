/**
 * Goal badge derivation (status derives): the ONE goal badge text rule shared
 * by the log fold, the official projection and the child display subject.
 *
 * FR6: the domain keeps the objective WHOLE — no fixed character threshold
 * (the retired 24-char slice discarded display data before any terminal
 * width was known). The single width-aware truncation is the terminal sink's
 * job (TuiApp's goal line), asserted in test/client/tui-app.test.ts.
 * @module @xmoon76/dsh-pi-tui/goal-badge.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { foldGoal, goalTextOf } from '../../src/domain/status/derive-goal.ts'

test('goalTextOf keeps a long objective whole instead of the fixed 24-character cut', () => {
  const objective = 'ship the 0.5.7 goal dock with full width aware truncation behavior'
  assert.equal(goalTextOf({ phase: 'active', objective }), `goal ● ${objective}`)
})

test('goalTextOf maps every non-complete phase to its mark and hides completion', () => {
  assert.equal(goalTextOf({ phase: 'active', objective: 'fix the build' }), 'goal ● fix the build')
  assert.equal(goalTextOf({ phase: 'paused', objective: 'fix the build' }), 'goal ‖ fix the build')
  assert.equal(goalTextOf({ phase: 'blocked', objective: 'fix the build' }), 'goal ◌ fix the build')
  assert.equal(goalTextOf({ phase: 'complete', objective: 'fix the build' }), undefined)
})

test('the log fold and the projection render IDENTICALLY for the same goal fact', () => {
  const goal = { phase: 'active', objective: 'same objective' }
  const fromLog = foldGoal([{ type: 'goal/change', data: { operation: 'create', goal } }])
  assert.equal(fromLog, goalTextOf(goal))
  // The latest goal/change wins; a clear hides the badge.
  const cleared = foldGoal([
    { type: 'goal/change', data: { operation: 'create', goal } },
    { type: 'goal/change', data: { operation: 'clear', goal } },
  ])
  assert.equal(cleared, undefined)
})
