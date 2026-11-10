import assert from 'node:assert/strict'
import test from 'node:test'
import { focusEvidenceTier, isPinnedFocusClient } from '../../scripts/tern-pane-focus-turns.mjs'

test('Focus qualification accepts only the Owner-pinned Tern 0.9.13 executable identity', () => {
  assert.equal(isPinnedFocusClient(
    'tern 0.9.13 (8c6dfbd)',
    'ffa3c7c85cf557b5e0ee690cd62efc32e79dbc77044d475dce0edc3a4ac2cd99',
  ), true)
  assert.equal(isPinnedFocusClient('tern 0.9.13 (8c6dfbd)', 'wrong-hash'), false)
  assert.equal(isPinnedFocusClient('tern 0.9.12 (e498b49)', 'ffa3c7c85cf557b5e0ee690cd62efc32e79dbc77044d475dce0edc3a4ac2cd99'), false)
})

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
