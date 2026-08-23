/**
 * Regression tests for the viewer capability gate on SEMANTIC plugin
 * actions (viewerActionCapability, src/index.ts): a plugin keybinding can
 * reach the runner even inside a continuable viewer (the router lets
 * non-reserved chords through), so the semantic action layer must block
 * every action with PARENT-session side effects while a viewer is open —
 * otherwise Ctrl+Alt+X → cancel-activity would interrupt the PARENT
 * agent from inside the child view.
 * @module @xmoon76/dsh-pi-tui/viewer-action-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { viewerActionCapability } from '../src/index.ts'
import type { TuiAction } from '../src/extension/public-types.ts'

const continuable = { mode: 'continuable' as const }
const oneShot = { mode: 'one-shot' as const }

test('with NO viewer open every semantic action passes (the gate is a viewer-only restriction)', () => {
  const actions: TuiAction[] = [
    'submit-draft', 'queue-draft', 'steer-draft', 'cancel-activity',
    'open-search', 'toggle-fullscreen', 'cycle-permission',
  ]
  for (const action of actions) {
    assert.equal(viewerActionCapability(action, undefined), true, `${action} must pass without a viewer`)
  }
})

test('in a continuable viewer only child- or surface-local actions pass', () => {
  // Allowed: these route to the CHILD (submitDraft is viewer-aware) or
  // stay surface-local.
  assert.equal(viewerActionCapability('submit-draft', continuable), true)
  assert.equal(viewerActionCapability('queue-draft', continuable), true)
  assert.equal(viewerActionCapability('toggle-fullscreen', continuable), true)
  // Blocked: every one of these would act on the PARENT session.
  assert.equal(viewerActionCapability('steer-draft', continuable), false, 'steer must never reach the parent')
  assert.equal(viewerActionCapability('cancel-activity', continuable), false, 'interrupting the parent is forbidden')
  assert.equal(viewerActionCapability('cycle-permission', continuable), false, 'parent permission is host-owned')
  assert.equal(viewerActionCapability('open-search', continuable), false, 'the main transcript search is parent-scoped')
})

test('the gate applies to a one-shot viewer identically', () => {
  assert.equal(viewerActionCapability('submit-draft', oneShot), true, 'submitDraft hard-rejects in one-shot viewers itself')
  assert.equal(viewerActionCapability('cancel-activity', oneShot), false)
  assert.equal(viewerActionCapability('cycle-permission', oneShot), false)
  assert.equal(viewerActionCapability('steer-draft', oneShot), false)
})
