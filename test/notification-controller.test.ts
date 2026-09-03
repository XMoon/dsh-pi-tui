/**
 * Completion-notification controller tests (plan §10.1/§10.2): the
 * settled semantics matrix (same live main agent, observed running →
 * idle), the focus semantics matrix (mode × focus), the identity fence
 * (session switch / child agents / resume-idle), and the integration
 * path agent/status → controller → writer. Pure — no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/notification-controller.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CompletionNotificationController, NOTIFICATION_BODY, NOTIFICATION_TITLE } from '../src/notification/controller.ts'
import { parseNotificationMethod, parseNotificationMode } from '../src/notification/settings.ts'
import type { NotificationMethod } from '../src/notification/settings.ts'

// ── settings parsing (plan §4.2) ────────────────────────────────────────

test('parseNotificationMode accepts the three values and fails safe to unfocused', () => {
  assert.equal(parseNotificationMode('unfocused'), 'unfocused')
  assert.equal(parseNotificationMode('always'), 'always')
  assert.equal(parseNotificationMode('off'), 'off')
  assert.equal(parseNotificationMode(undefined), 'unfocused')
  assert.equal(parseNotificationMode(''), 'unfocused')
  assert.equal(parseNotificationMode('yes'), 'unfocused')
  assert.equal(parseNotificationMode('ON'), 'unfocused')
})

test('parseNotificationMethod accepts the four values and fails safe to auto', () => {
  assert.equal(parseNotificationMethod('auto'), 'auto')
  assert.equal(parseNotificationMethod('osc9'), 'osc9')
  assert.equal(parseNotificationMethod('osc777'), 'osc777')
  assert.equal(parseNotificationMethod('bell'), 'bell')
  assert.equal(parseNotificationMethod(undefined), 'auto')
  assert.equal(parseNotificationMethod(''), 'auto')
  assert.equal(parseNotificationMethod('beep'), 'auto')
})

/** A recording sink: every notification's method/title/body. */
function recordingSink(): { calls: Array<{ method: NotificationMethod; title: string; body: string }>; sink: (method: NotificationMethod, title: string, body: string) => void } {
  const calls: Array<{ method: NotificationMethod; title: string; body: string }> = []
  return {
    calls,
    sink: (method, title, body) => { calls.push({ method, title, body }) },
  }
}

/** Drive one status transition on the controller. */
function status(controller: CompletionNotificationController, agentId: string, next: 'running' | 'idle'): void {
  controller.onAgentStatus(agentId, next)
}

test('idle → running → idle notifies exactly once (the settled boundary)', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1, 'one settle → one notification')
  assert.equal(calls[0]!.title, NOTIFICATION_TITLE)
  assert.equal(calls[0]!.body, NOTIFICATION_BODY)
})

test('app start with an already-idle agent never notifies (resume idle)', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 0, 'a first-observed idle is not a settle')
})

test('running → turn/end → idle notifies once (turn/end is never a trigger)', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  // turn/end is NOT fed to the controller at all — and even if it were,
  // only the agent/status transitions matter.
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1)
})

test('running → turn/end → turn/start → idle notifies once (queued continuation)', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  // turn/end and turn/start are SESSION events — the controller only
  // consumes agent/status, so a queued continuation that keeps the
  // driver alive produces NO intermediate status flip.
  assert.equal(calls.length, 0, 'no notification at the intermediate turn boundary')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1, 'the whole running span settles once')
})

test('compaction: turn/end + compaction events never notify early — only the final idle does', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  // The runner's event flow: the agent runs a turn, the turn ends, a
  // compaction runs (summarizing → applying), then the driver finally
  // retires. Only agent/status reaches the controller — the session
  // events (turn/end, compaction/start, compaction/end) are consumed by
  // the runner and never forwarded, so they can never notify early.
  status(controller, 'main', 'running')
  // (session: turn/end — not forwarded)
  // (session: compaction/start — not forwarded)
  // (session: compaction/end — not forwarded)
  assert.equal(calls.length, 0, 'no notification while the driver is still active')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1, 'exactly one notification at the final idle')
})

test('running → retry → running → idle notifies once (internal retry is not a settle)', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  status(controller, 'main', 'running') // retry keeps the driver running
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1, 'a retry must not produce a mid-way notification')
})

test('a child agent running → idle never notifies', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  status(controller, 'child-1', 'running')
  status(controller, 'child-1', 'idle')
  assert.equal(calls.length, 0, 'subagent transitions are fenced out')
})

test('a late idle from a switched-away session never notifies (identity fence)', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('session-a')
  controller.setFocus('unfocused')
  status(controller, 'session-a', 'running')
  // The user switches to session B: the controller resets to B.
  controller.setLiveAgent('session-b')
  // A LATE idle from A arrives after the switch.
  status(controller, 'session-a', 'idle')
  assert.equal(calls.length, 0, 'the old session\'s late idle must be inert')
  // B must be observed running before it can notify.
  status(controller, 'session-b', 'idle')
  assert.equal(calls.length, 0, 'a resumed idle session B must not notify')
  status(controller, 'session-b', 'running')
  status(controller, 'session-b', 'idle')
  assert.equal(calls.length, 1, 'session B\'s own settle notifies once')
})

test('setLiveAgent(undefined) fences everything (deferred start)', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent(undefined)
  status(controller, 'whatever', 'running')
  status(controller, 'whatever', 'idle')
  assert.equal(calls.length, 0)
})

test('teardown fences the controller: a late idle after cleanup never notifies', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  // The runner's cleanup() commits the teardown fence (setLiveAgent
  // undefined) — a late idle from the old live agent arriving after the
  // surface exited must not emit a notification into the dead surface.
  controller.setLiveAgent(undefined)
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 0, 'a post-teardown idle must be inert')
})

// ── focus semantics (plan §10.2) ────────────────────────────────────────

test('mode=unfocused (default): focused settle is silent, unfocused settle notifies', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  // Default focus = focused (the safe assumption).
  status(controller, 'main', 'running')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 0, 'focused + main settles → silent')
  // The terminal reports FOCUS_OUT.
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1, 'unfocused + main settles → notify once')
})

test('unfocused → focused before the settle stays silent', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  controller.setFocus('focused') // the user came back before the settle
  status(controller, 'main', 'running')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 0)
})

test('focused → unfocused before the settle notifies', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  status(controller, 'main', 'running')
  controller.setFocus('unfocused')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1)
})

test('mode=always notifies even while focused', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setMode('always')
  status(controller, 'main', 'running')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1)
})

test('mode=off never notifies, even unfocused', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setMode('off')
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 0)
})

test('the sink receives the configured method', () => {
  const { calls, sink } = recordingSink()
  const controller = new CompletionNotificationController(sink)
  controller.setLiveAgent('main')
  controller.setMethod('osc777')
  controller.setFocus('unfocused')
  status(controller, 'main', 'running')
  status(controller, 'main', 'idle')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'osc777')
})

// ── integration path: agent/status → controller → writer (plan §12) ────

test('integration: agent/status transitions drive the writer through the controller', () => {
  const written: string[] = []
  const controller = new CompletionNotificationController((method, title, body) => {
    // The runner's wiring: controller sink → notifier with the method.
    if (method === 'bell') written.push('\x07')
    else if (method === 'osc9') written.push(`\x1b]9;${body}\x07`)
    else if (method === 'osc777') written.push(`\x1b]777;notify;${title};${body}\x07`)
  })
  controller.setLiveAgent('main')
  controller.setFocus('unfocused')
  controller.setMethod('bell')
  // The runner's agent/status handler routes the MAIN agent here.
  controller.onAgentStatus('main', 'running')
  controller.onAgentStatus('main', 'idle')
  assert.deepEqual(written, ['\x07'], 'one settle → exactly one writer sequence')
  // A child's transition routes to the task runtime, never here.
  controller.onAgentStatus('child', 'running')
  controller.onAgentStatus('child', 'idle')
  assert.equal(written.length, 1, 'child transitions never reach the writer')
})
