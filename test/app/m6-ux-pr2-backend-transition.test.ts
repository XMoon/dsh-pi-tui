/**
 * M6 UX PR2 Step D: the ONE transient user-conversion intent.
 *
 * Evidence level: decision-rule contract (L3). These tests prove the intent is
 * set ONLY by a verified `daemon → direct` save made by a process still running
 * the daemon backend, cleared by a verified reverse save, and never faked by a
 * same-value confirm, a failed/unknown outcome, or a Direct-process save. The
 * full source→decision→sink chain (Settings verified write → intent → exit
 * owner ask) is exercised by `test/app/lifecycle.test.ts`.
 * @module @xmoon76/dsh-pi-tui/m6-ux-pr2-backend-transition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyBackendExitTransition } from '../../src/tui/commands/settings.ts'

test('a verified daemon→direct save by the running Daemon Client grants the intent', () => {
  assert.equal(classifyBackendExitTransition('daemon', 'direct', 'remote'), 'daemon-to-direct')
})

test('a Direct-process save never grants the intent (the current backend stays Direct)', () => {
  assert.equal(classifyBackendExitTransition('daemon', 'direct', 'direct'), 'none')
})

test('a verified direct→daemon reverse save clears the intent', () => {
  assert.equal(classifyBackendExitTransition('direct', 'daemon', 'remote'), 'clear')
  assert.equal(classifyBackendExitTransition('direct', 'daemon', 'direct'), 'clear')
})

test('a same-value confirm never changes the intent', () => {
  assert.equal(classifyBackendExitTransition('daemon', 'daemon', 'remote'), 'none')
  assert.equal(classifyBackendExitTransition('direct', 'direct', 'remote'), 'none')
  assert.equal(classifyBackendExitTransition('direct', 'direct', 'direct'), 'none')
})

test('an env-override Daemon launch with an already-Direct Profile is not a conversion', () => {
  // The Profile reads `direct`; a `DSH_PI_TUI_BACKEND=daemon` launch never
  // writes it, so no verified daemon→direct save ever happened here.
  assert.equal(classifyBackendExitTransition('direct', 'direct', 'remote'), 'none')
})
