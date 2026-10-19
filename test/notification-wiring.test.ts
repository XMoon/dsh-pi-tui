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
import { compositionSource } from './support/composition-surface.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexSource = compositionSource()
const surfaceSource = readFileSync(join(root, 'src', 'app', 'surface', 'runtime.ts'), 'utf8')
// TS3 §31: the completion-notification controller, the terminal-focus tracker
// and the notifier moved into their own surface owner (`notification-runtime.ts`),
// so the focus/feed locks read that module. The aggregate only FORWARDS the
// delegate calls; the runner still never reaches the controller.
const notificationSource = readFileSync(join(root, 'src', 'app', 'surface', 'notification-runtime.ts'), 'utf8')
// TS5 §14: the terminal sequences, the focus tracker and the notifier moved to
// the TUI presentation owner; the application owner now delegates through the
// injected structural presentation, so the terminal locks read that module.
const presentationSource = readFileSync(join(root, 'src', 'tui', 'notification', 'runtime.ts'), 'utf8')
// TS3 §36: the presentation event routing moved into its own surface owner.
const routingSource = readFileSync(join(root, 'src', 'app', 'surface', 'event-routing.ts'), 'utf8')
// A5b-5: the TuiApp event adapter (onUserInput / onTerminalFocus / ...) moved
// into its owner, so the per-method wiring locks read the owner module.
const eventsSource = readFileSync(join(root, 'src', 'app', 'surface', 'application-events.ts'), 'utf8')
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
const notificationMethodBody = (name: string): string => methodBody(notificationSource, name)

test('the per-method body slicer is exact (mutation guard for the focus locks)', () => {
  // Prove the slicer isolates ONE member with a unique SENTINEL — body content
  // must appear in ITS OWN slice and in no other member's. (Emptying a method
  // would not prove isolation: a degenerate whole-file slice would also stop
  // finding the removed text.)
  const SENTINEL = 'SENTINEL_TERMINAL_FOCUS_BODY'
  const sentineled = notificationSource.replace(
    /    handleTerminalFocus\(focused\) \{[\s\S]*?\n    \},/u,
    `    handleTerminalFocus(focused) {\n      ${SENTINEL}\n    },`,
  )
  assert.notEqual(sentineled, notificationSource, 'the fixture must actually rewrite handleTerminalFocus')
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
  assert.equal(notificationSource.split('completionController.onAgentStatus').length - 1, 1,
    'the surface notification owner must expose exactly one controller feed')
  // A4-7: the routing decision is surface-owned; the runner keeps a thin
  // delegation. The single controller feed is inside the surface routing body.
  assert.equal(indexSource.split('surface.routeAgentStatus(').length - 1, 1,
    'exactly one runner registration delegates to the surface routing')
  const marker = "ctx.on('agent/status', ({ agent, status }) => surface.routeAgentStatus(agent.id, status))"
  assert.ok(indexSource.includes(marker),
    'the agent/status handler must delegate to the surface routing')
  // TS3 §36: the routing body moved into the presentation event router owner.
  const routing = routingSource.slice(
    routingSource.indexOf('const routeAgentStatus = '),
    routingSource.indexOf('const routeProviderRefresh = '),
  )
  assert.ok(routing.includes('options.feedCompletionStatus(agentId, status)'),
    'the agent/status handler must route the main agent to the controller')
  assert.ok(routing.includes('if (!options.hasTaskChild(agentId)) return'),
    'the child membership gate must stay (children never notify and never repaint)')
  assert.ok(routing.includes('options.refreshAgentRuntimeOnly()'),
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
  assert.equal(indexSource.split('surface.retireCompletionOwner()').length - 1, 1,
    'the cleanup fence must withdraw the completion identity exactly once through the final-teardown retirement')
  assert.equal(indexSource.split('surface.setCompletionOwner(undefined)').length - 1, 0,
    'the final teardown must NOT use the rebind seam (it would erase a retainable terminal outcome)')
  assert.equal(notificationSource.split('completionController.setLiveAgent').length - 1, 1,
    'the completion controller must be reached ONLY through the single setCompletionOwner seam')
  assert.equal(indexSource.split('completionController').length - 1, 0,
    'the runner must not reach the notification controller directly (A4-4 surface ownership)')
})

test('focus reporting is enabled at mount and disabled on EVERY exit path', () => {
  // A4-4 + TS5 §14.2: the TUI presentation owns the mount enable and the
  // disable write; the application surface delegates through the injected
  // presentation (so no terminal sequence reaches the application owner); the
  // terminal-total fatal catch (outside the startup IIFE) keeps its own guarded
  // write, because the surface owner is not in scope on that path.
  assert.equal(presentationSource.split('ENABLE_FOCUS_REPORTING').length - 1, 2,
    'the terminal presentation enables focus reporting exactly once (the constant use + import)')
  assert.equal(presentationSource.split('DISABLE_FOCUS_REPORTING').length - 1, 2,
    'the terminal presentation disables focus reporting exactly once (the constant use + import)')
  assert.equal(notificationSource.split('ENABLE_FOCUS_REPORTING').length - 1, 0,
    'the application notification owner must not carry a terminal sequence')
  assert.equal(notificationSource.split('DISABLE_FOCUS_REPORTING').length - 1, 0,
    'the application notification owner must not carry a terminal sequence')
  assert.equal(notificationSource.split('presentation.enableFocusReporting()').length - 1, 1,
    'the application owner delegates the mount enable to the injected presentation')
  assert.equal(indexSource.split('notificationWriter.write(ENABLE_FOCUS_REPORTING)').length - 1, 0,
    'the runner no longer enables focus reporting itself')
  // TS2 §11 moved the terminal-total fatal catch into the bootstrap composition
  // zone (`app/bootstrap/lifecycle.ts`); it keeps exactly ONE runner-side
  // disable of focus reporting. The write goes through the INJECTED guarded
  // writer, and that seam's wiring is asserted too — so "some writeOutput call
  // exists" can never stand in for the real guarded write.
  assert.equal(indexSource.split('writeOutput(DISABLE_FOCUS_REPORTING)').length - 1, 1,
    'the fatal catch keeps the one runner-side disable')
  assert.equal(indexSource.split('writeOutput: (text) => { notificationWriter.write(text) }').length - 1, 1,
    'the fatal catch writes through the runner guarded notification writer')
  // The normal cleanup disables BEFORE the app dies (first teardown
  // step, before any throwable operation).
  const cleanupStart = indexSource.indexOf('const disposeSurface = (')
  assert.ok(cleanupStart >= 0, 'the composition zone still owns the surface teardown')
  const cleanup = indexSource.slice(cleanupStart, indexSource.indexOf('diag.dispose()', cleanupStart) + 20)
  const disableIndex = cleanup.indexOf('surface.disableFocusReporting()')
  const disposeIndex = cleanup.indexOf('surface.dispose()')
  assert.ok(disableIndex >= 0 && disposeIndex > disableIndex,
    'cleanup must disable focus reporting before disposing the app')
  // The startup-failure catch disables too (the body may have thrown
  // AFTER the mount enabled the mode).
  const fatalCatch = indexSource.slice(indexSource.indexOf('Terminal-total final catch'))
  assert.ok(fatalCatch.includes('writeOutput(DISABLE_FOCUS_REPORTING)'),
    'the fatal catch must disable focus reporting')
})

test('user activity restores the tracker to focused (the onUserInput wiring)', () => {
  // The runner's onUserInput seam must restore the tracker (a missed
  // FOCUS_IN must never leave an 'unfocused' tracker that would falsely
  // notify while the user watches) and re-sync the controller. The lock is
  // PER METHOD: each surface entry must itself do both halves — a future edit
  // that drops one half of one path must fail here (a whole-file `includes`
  // check would keep passing).
  const wiringStart = eventsSource.indexOf('onUserInput: () => {')
  assert.ok(wiringStart >= 0, 'the app events must wire onUserInput')
  const wiring = eventsSource.slice(wiringStart, wiringStart + 300)
  assert.ok(wiring.includes('deps.surface.noteUserInput()'),
    'onUserInput must route to the surface tracker restore')
  const restoreBody = notificationMethodBody('noteUserInput')
  assert.ok(restoreBody.includes('presentation.markFocused()'),
    'noteUserInput must restore the terminal tracker to focused through the presentation')
  assert.ok(restoreBody.includes('completionController.setFocus(presentation.focusState())'),
    'noteUserInput must re-sync the controller focus')
  // The onTerminalFocus wiring keeps feeding the tracker + controller.
  const focusStart = eventsSource.indexOf('onTerminalFocus: (focused) => {')
  assert.ok(focusStart >= 0, 'the app events must wire onTerminalFocus')
  const focusWiring = eventsSource.slice(focusStart, focusStart + 300)
  assert.ok(focusWiring.includes('deps.surface.handleTerminalFocus(focused)'),
    'onTerminalFocus must route to the surface tracker')
  const focusBody = notificationMethodBody('handleTerminalFocus')
  assert.ok(focusBody.includes('presentation.handleFocusReport('),
    'handleTerminalFocus must feed the terminal tracker through the presentation')
  assert.ok(focusBody.includes('completionController.setFocus(presentation.focusState())'),
    'handleTerminalFocus must re-sync the controller focus')
})
