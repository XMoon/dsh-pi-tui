/**
 * TS5 §14.3 runtime path: the application notification owner drives the injected
 * terminal presentation end to end. The authoritative `agent/status` feed decides
 * the notification through the moved domain controller, the presentation writes
 * the real terminal bytes, the focus-reporting mode rides the same guarded writer,
 * and a broken writer is contained — the runtime evidence the wiring source audit
 * in `test/notification-wiring.test.ts` deliberately is not.
 * @module @xmoon76/dsh-pi-tui/notification-presentation-path.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createNotificationRuntime } from '../src/app/surface/notification-runtime.ts'
import { createTerminalNotificationPresentation } from '../src/tui/notification/runtime.ts'
import { DISABLE_FOCUS_REPORTING, ENABLE_FOCUS_REPORTING } from '../src/tui/notification/terminal-focus.ts'

/** The real application owner over the real terminal presentation + a recorder. */
function createPath(mode = 'always', method = 'bell') {
  const writes: string[] = []
  const presentation = createTerminalNotificationPresentation({
    writer: { write: (sequence: string) => { writes.push(sequence) } },
  })
  const runtime = createNotificationRuntime({ presentation, notificationMode: mode, notificationMethod: method })
  return { writes, runtime }
}

test('TS5: agent/status running -> idle reaches the injected terminal presentation once', () => {
  const { writes, runtime } = createPath()
  runtime.setCompletionOwner('agent-1')
  runtime.onAgentStatus('agent-1', 'running')
  assert.deepEqual(writes, [], 'running alone never notifies')
  runtime.onAgentStatus('agent-1', 'idle')
  assert.deepEqual(writes, ['\x07'], 'the settle writes exactly one bell')
  runtime.onAgentStatus('agent-1', 'idle')
  assert.deepEqual(writes, ['\x07'], 'a repeated idle never re-notifies')
  runtime.onAgentStatus('retired', 'idle')
  assert.deepEqual(writes, ['\x07'], 'a retired agent id can never notify')
})

test('TS5: the mode/method policy flows through the presentation', () => {
  const { writes, runtime } = createPath('always', 'osc9')
  runtime.setCompletionOwner('a')
  runtime.onAgentStatus('a', 'running')
  runtime.onAgentStatus('a', 'idle')
  assert.deepEqual(writes, ['\x1b]9;Turn complete\x07'], 'osc9 writes the body payload')

  runtime.setMode('off')
  runtime.onAgentStatus('a', 'running')
  runtime.onAgentStatus('a', 'idle')
  assert.equal(writes.length, 1, 'mode off never notifies')

  runtime.setMode('unfocused')
  runtime.noteUserInput()
  runtime.onAgentStatus('a', 'running')
  runtime.onAgentStatus('a', 'idle')
  assert.equal(writes.length, 1, 'a focused terminal suppresses the unfocused mode')

  runtime.handleTerminalFocus(false)
  runtime.onAgentStatus('a', 'running')
  runtime.onAgentStatus('a', 'idle')
  assert.equal(writes.length, 2, 'the unfocused report lets the next settle through')
})

test('TS5: focus reporting rides the same writer', () => {
  const { writes, runtime } = createPath()
  runtime.enableFocusReporting()
  assert.deepEqual(writes, [ENABLE_FOCUS_REPORTING])
  runtime.disableFocusReporting()
  assert.deepEqual(writes, [ENABLE_FOCUS_REPORTING, DISABLE_FOCUS_REPORTING])
})

test('TS5: a broken terminal writer can never crash the surface', () => {
  const presentation = createTerminalNotificationPresentation({
    writer: { write: () => { throw new Error('EPIPE') } },
  })
  const runtime = createNotificationRuntime({ presentation, notificationMode: 'always', notificationMethod: 'bell' })
  runtime.setCompletionOwner('a')
  runtime.onAgentStatus('a', 'running')
  assert.doesNotThrow(() => runtime.onAgentStatus('a', 'idle'))
  assert.doesNotThrow(() => runtime.enableFocusReporting())
  assert.doesNotThrow(() => runtime.disableFocusReporting())
})
