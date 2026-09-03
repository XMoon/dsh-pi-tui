/**
 * Source-audit tests for the completion-notification WIRING (the runner
 * cannot be booted headlessly — the task-browser-runtime precedent): the
 * controller is fed ONLY by `agent/status` (turn/end can never notify),
 * the live-agent identity resets at every commit site plus teardown, and
 * terminal focus reporting is enabled at mount and disabled on EVERY
 * exit path (normal cleanup AND the startup-failure catch).
 * @module @xmoon76/dsh-pi-tui/notification-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const indexSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
  'utf8',
)

test('the ONLY completion-controller feed is agent/status (turn/end can never notify)', () => {
  // The controller's status input appears exactly ONCE in the whole
  // runner — inside the agent/status handler. Session events (turn/end,
  // turn/start, compaction/…) are never forwarded, so they can never
  // trigger a notification (plan: turn/end is outcome recording only).
  const occurrences = indexSource.split('completionController.onAgentStatus').length - 1
  assert.equal(occurrences, 1, 'exactly one feed path — agent/status')
  const marker = "ctx.on('agent/status', ({ agent, status }) => {"
  const handler = indexSource.slice(indexSource.indexOf(marker), indexSource.indexOf(marker) + 500)
  assert.ok(handler.includes('completionController.onAgentStatus(agent.id, status)'),
    'the agent/status handler must route the main agent to the controller')
  assert.ok(handler.includes('if (taskRuntime?.has(agent.id) !== true) return'),
    'the child membership gate must stay (children never notify and never repaint)')
  assert.ok(handler.includes('refreshAgentRuntimeOnly()'),
    'the child runtime refresh must stay')
})

test('the live-agent identity resets at every commit site plus teardown', () => {
  // Startup resume (setLiveAgent(liveAgent?.id)), session switch
  // (/new /fork rewind /sessions — ONE commit point), the first-session
  // creation, and the cleanup fence: exactly four resets.
  const occurrences = indexSource.split('completionController.setLiveAgent').length - 1
  assert.equal(occurrences, 4,
    'setLiveAgent must run at startup resume, the switch commit, first-session create and cleanup')
})

test('focus reporting is enabled at mount and disabled on EVERY exit path', () => {
  const enables = indexSource.split('notificationWriter.write(ENABLE_FOCUS_REPORTING)').length - 1
  assert.equal(enables, 1, 'enable exactly once at TUI mount')
  const disables = indexSource.split('notificationWriter.write(DISABLE_FOCUS_REPORTING)').length - 1
  assert.equal(disables, 2, 'disable exactly twice: the normal cleanup AND the startup-failure catch')
  // The normal cleanup disables BEFORE the app dies (first teardown
  // step, before any throwable operation).
  const cleanupStart = indexSource.indexOf('const cleanup = (): void => {')
  const cleanup = indexSource.slice(cleanupStart, indexSource.indexOf('diag.dispose()', cleanupStart) + 20)
  const disableIndex = cleanup.indexOf('notificationWriter.write(DISABLE_FOCUS_REPORTING)')
  const disposeIndex = cleanup.indexOf('app?.dispose()')
  assert.ok(disableIndex >= 0 && disposeIndex > disableIndex,
    'cleanup must disable focus reporting before disposing the app')
  // The startup-failure catch disables too (the body may have thrown
  // AFTER the mount enabled the mode).
  const fatalCatch = indexSource.slice(indexSource.indexOf('Terminal-total final catch'))
  assert.ok(fatalCatch.includes('notificationWriter.write(DISABLE_FOCUS_REPORTING)'),
    'the fatal catch must disable focus reporting')
})

test('user activity restores the tracker to focused (the onUserInput wiring)', () => {
  // The runner's onUserInput seam must restore the tracker (a missed
  // FOCUS_IN must never leave an 'unfocused' tracker that would falsely
  // notify while the user watches) and re-sync the controller.
  const wiringStart = indexSource.indexOf('onUserInput: () => {')
  assert.ok(wiringStart >= 0, 'the app events must wire onUserInput')
  const wiring = indexSource.slice(wiringStart, wiringStart + 300)
  assert.ok(wiring.includes('terminalFocusTracker.markFocused()'),
    'onUserInput must restore the tracker to focused')
  assert.ok(wiring.includes('completionController.setFocus(terminalFocusTracker.state)'),
    'onUserInput must re-sync the controller focus')
  // The onTerminalFocus wiring keeps feeding the tracker + controller.
  const focusStart = indexSource.indexOf('onTerminalFocus: (focused) => {')
  const focusWiring = indexSource.slice(focusStart, focusStart + 300)
  assert.ok(focusWiring.includes('terminalFocusTracker.handleFocusReport'),
    'onTerminalFocus must feed the tracker')
  assert.ok(focusWiring.includes('completionController.setFocus(terminalFocusTracker.state)'),
    'onTerminalFocus must re-sync the controller focus')
})
