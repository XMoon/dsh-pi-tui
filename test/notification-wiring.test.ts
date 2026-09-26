/**
 * Source-audit tests for the completion-notification WIRING (the runner
 * cannot be booted headlessly — the task-browser-runtime precedent): the
 * controller is fed ONLY by `agent/status` (turn/end can never notify),
 * the live-agent identity resets at every commit site plus teardown, and
 * terminal focus reporting is enabled at mount and disabled on EVERY
 * exit path (normal cleanup AND the startup-failure catch).
 *
 * A4-4: the controller, the focus tracker and the notifier moved into
 * `app/surface/runtime.ts`, so the audit reads both sources and pins the new
 * owner boundary instead of the old runner-internal symbols.
 * @module @xmoon76/dsh-pi-tui/notification-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexSource = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const surfaceSource = readFileSync(join(root, 'src', 'app', 'surface', 'runtime.ts'), 'utf8')
const commitOrderSource = readFileSync(join(root, 'src', 'app', 'session', 'commit-order.ts'), 'utf8')

/**
 * The text of one member method of the surface runtime object literal: from
 * `    <name>(` to the NEXT `\n    },` member boundary. Per-method slicing is
 * what makes the focus locks exact — a whole-file `includes` check keeps
 * passing after one path's sync is deleted.
 */
function methodBody(source: string, name: string): string {
  const marker = `    ${name}(`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `the surface runtime must define ${name}(`)
  const end = source.indexOf('\n    },', start)
  assert.ok(end > start, `${name} must end with the runtime's member layout`)
  return source.slice(start, end)
}
const surfaceMethodBody = (name: string): string => methodBody(surfaceSource, name)

test('the per-method body slicer is exact (mutation guard for the focus locks)', () => {
  // Prove the slicer isolates ONE member with a unique SENTINEL — body content
  // must appear in ITS OWN slice and in no other member's. (Emptying a method
  // would not prove isolation: a degenerate whole-file slice would also stop
  // finding the removed text.)
  const SENTINEL = 'SENTINEL_TERMINAL_FOCUS_BODY'
  const sentineled = surfaceSource.replace(
    /    handleTerminalFocus\(focused\) \{[\s\S]*?\n    \},/u,
    `    handleTerminalFocus(focused) {\n      ${SENTINEL}\n    },`,
  )
  assert.notEqual(sentineled, surfaceSource, 'the fixture must actually rewrite handleTerminalFocus')
  const focusSlice = methodBody(sentineled, 'handleTerminalFocus')
  assert.ok(focusSlice.includes(SENTINEL), 'the target method slice must contain its own body')
  assert.ok(!focusSlice.includes('terminalFocusTracker.markFocused()'),
    'the target slice must stop at its member boundary (no noteUserInput body)')
  assert.ok(!methodBody(sentineled, 'noteUserInput').includes(SENTINEL),
    'another member slice must never contain the sentinel — the slicer isolates one member')
})

test('the ONLY completion-controller feed is agent/status (turn/end can never notify)', () => {
  // The controller's status input is reached through exactly ONE surface entry
  // (`SurfaceRuntime.onAgentStatus`), fed by exactly ONE runner call inside the
  // agent/status handler. Session events (turn/end, turn/start, compaction/…)
  // are never forwarded, so they can never trigger a notification (plan:
  // turn/end is outcome recording only).
  assert.equal(surfaceSource.split('completionController.onAgentStatus').length - 1, 1,
    'the surface must expose exactly one controller feed')
  const occurrences = indexSource.split('surface.onAgentStatus(').length - 1
  assert.equal(occurrences, 1, 'exactly one runner feed path — agent/status')
  const marker = "ctx.on('agent/status', ({ agent, status }) => {"
  const handler = indexSource.slice(indexSource.indexOf(marker), indexSource.indexOf(marker) + 900)
  assert.ok(handler.includes('surface.onAgentStatus(agent.id, status)'),
    'the agent/status handler must route the main agent to the controller')
  assert.ok(handler.includes('if (!surface.hasTask(agent.id)) return'),
    'the child membership gate must stay (children never notify and never repaint)')
  assert.ok(handler.includes('surface.refreshAgentRuntimeOnly()'),
    'the child runtime refresh must stay')
})

test('the live-agent identity resets at every commit site plus teardown', () => {
  // The four commit shapes (startup resume, ordinary switch, fork adoption,
  // first-session create) apply their completion reset through the shared
  // ordering helpers (A2 plan §4A-D); the runner keeps exactly ONE direct call
  // for the cleanup fence. The controller is reached ONLY through the single
  // setCompletionOwner seam.
  assert.equal(commitOrderSource.split('seams.setCompletionOwner(').length - 1, 4,
    'all four commit shapes must reset the completion owner through the seam')
  assert.equal(indexSource.split('surface.setCompletionOwner(undefined)').length - 1, 1,
    'the cleanup fence must reset the completion identity to undefined exactly once')
  assert.equal(surfaceSource.split('completionController.setLiveAgent').length - 1, 1,
    'the completion controller must be reached ONLY through the single setCompletionOwner seam')
  assert.equal(indexSource.split('completionController').length - 1, 0,
    'the runner must not reach the notification controller directly (A4-4 surface ownership)')
})

test('focus reporting is enabled at mount and disabled on EVERY exit path', () => {
  // A4-4: the surface owns the mount enable + the normal-cleanup disable; the
  // terminal-total fatal catch (outside the startup IIFE) keeps its own guarded
  // write, because the surface owner is not in scope on that path.
  assert.equal(surfaceSource.split('ENABLE_FOCUS_REPORTING').length - 1, 2,
    'the surface enables focus reporting exactly once (the constant use + import)')
  assert.equal(surfaceSource.split('DISABLE_FOCUS_REPORTING').length - 1, 2,
    'the surface disables focus reporting exactly once (the constant use + import)')
  assert.equal(indexSource.split('notificationWriter.write(ENABLE_FOCUS_REPORTING)').length - 1, 0,
    'the runner no longer enables focus reporting itself')
  assert.equal(indexSource.split('notificationWriter.write(DISABLE_FOCUS_REPORTING)').length - 1, 1,
    'the fatal catch keeps the one runner-side disable')
  // The normal cleanup disables BEFORE the app dies (first teardown
  // step, before any throwable operation).
  const cleanupStart = indexSource.indexOf('const disposeSurface = (): void => {')
  const cleanup = indexSource.slice(cleanupStart, indexSource.indexOf('diag.dispose()', cleanupStart) + 20)
  const disableIndex = cleanup.indexOf('surface.disableFocusReporting()')
  const disposeIndex = cleanup.indexOf('surface.dispose()')
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
  // notify while the user watches) and re-sync the controller. The lock is
  // PER METHOD: each surface entry must itself do both halves — a future edit
  // that drops one half of one path must fail here (a whole-file `includes`
  // check would keep passing).
  const wiringStart = indexSource.indexOf('onUserInput: () => {')
  assert.ok(wiringStart >= 0, 'the app events must wire onUserInput')
  const wiring = indexSource.slice(wiringStart, wiringStart + 300)
  assert.ok(wiring.includes('surface.noteUserInput()'),
    'onUserInput must route to the surface tracker restore')
  const restoreBody = surfaceMethodBody('noteUserInput')
  assert.ok(restoreBody.includes('terminalFocusTracker.markFocused()'),
    'noteUserInput must restore the tracker to focused')
  assert.ok(restoreBody.includes('completionController.setFocus(terminalFocusTracker.state)'),
    'noteUserInput must re-sync the controller focus')
  // The onTerminalFocus wiring keeps feeding the tracker + controller.
  const focusStart = indexSource.indexOf('onTerminalFocus: (focused) => {')
  assert.ok(focusStart >= 0, 'the app events must wire onTerminalFocus')
  const focusWiring = indexSource.slice(focusStart, focusStart + 300)
  assert.ok(focusWiring.includes('surface.handleTerminalFocus(focused)'),
    'onTerminalFocus must route to the surface tracker')
  const focusBody = surfaceMethodBody('handleTerminalFocus')
  assert.ok(focusBody.includes('terminalFocusTracker.handleFocusReport('),
    'handleTerminalFocus must feed the tracker')
  assert.ok(focusBody.includes('completionController.setFocus(terminalFocusTracker.state)'),
    'handleTerminalFocus must re-sync the controller focus')
})
