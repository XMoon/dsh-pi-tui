import assert from 'node:assert/strict'
import test from 'node:test'
import { focusEvidenceTier } from '../../scripts/tern-pane-focus-turns.mjs'

test('Focus qualification evidence tier names the client mode actually observed', () => {
  assert.equal(
    focusEvidenceTier(false),
    'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT + official Direct application',
  )
  assert.equal(
    focusEvidenceTier(true),
    'REAL_TERN_GUI + CONTROL_INJECTED_INPUT + official Direct application',
  )
})
