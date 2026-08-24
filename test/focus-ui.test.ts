/**
 * Focus Mode headless UI tests (plan §58/§59/§60): the live Thought
 * disclosure — running turns expand/collapse by clicking the header, new
 * events stream into the expanded region, turn/end preserves the user's
 * choice, the final assistant never duplicates, the WorkingIndicator
 * survives every Focus state, and Ctrl+O cannot leak a collapsed turn.
 * @module @xmoon76/dsh-pi-tui/focus-ui.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

/** A realistic base time: synthetic fixture events would produce absurd
 * running durations against Date.now(). */
const T0 = Date.now() - 60_000

/** Build an event with a controlled time. */
function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** A running turn with user + thinking + a running tool. */
function runningTurn(seqBase: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'check the transcript' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'locating the transcript path…' } }, T0 + 2, seqBase + 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'read', arguments: JSON.stringify({ path: 'src/transcript.ts' }) }, T0 + 3, seqBase + 3),
  ]
}

/** The remaining events that settle the running turn. */
function settleEvents(seqBase: number): SessionEvent[] {
  return [
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, T0 + 5000, seqBase + 4),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'The transcript folds events incrementally.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 6000, seqBase + 5),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 7000, seqBase + 6),
  ]
}

/** The row (0-based viewport y) whose text contains `needle`, or -1. */
function findRow(view: readonly string[], needle: string): number {
  return view.findIndex(line => line.includes(needle))
}

/** SGR click on one viewport cell (the fork converts to 0-based). */
function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

/** Push a folder snapshot into the app (the runner's repaint contract). */
function show(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities())
}

test('Focus ON running: the Thought card is collapsed with previews, the process is hidden, the WorkingIndicator stays', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.setWorking(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const view = vt.getViewport()
  const joined = view.join('\n')
  // The collapsed card: running symbol + the muted summary previews.
  assert.ok(joined.includes('🐋 Thought'), `running Thought header missing:\n${joined}`)
  assert.ok(joined.includes('Think:   locating the transcript path…'), `narrative preview missing:\n${joined}`)
  assert.ok(joined.includes('Tool:    Read src/transcript.ts'), `operation preview missing:\n${joined}`)
  // The FULL process rows must NOT render (no thinking card, no tool card).
  assert.ok(!joined.includes('🐳'), `collapsed must hide the thinking card:\n${joined}`)
  assert.ok(!joined.includes('📖'), `collapsed must hide the tool card:\n${joined}`)
  // The WorkingIndicator (the whale row above the editor) stays — plan §59.
  assert.ok(joined.includes('Working...'), `WorkingIndicator must remain visible:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('clicking the Thought header expands a RUNNING turn and reveals the live process', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.setWorking(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport()
  const y = findRow(view, '🐋 Thought')
  assert.ok(y >= 0, `Thought header row missing:\n${view.join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐳 Thought'), `expanded symbol missing after click:\n${joined}`)
  // The open Thought reveals the full process rows (thinking card with the
  // whale bullet, tool card with its header).
  assert.ok(joined.includes('locating the transcript path'), `expanded reasoning must appear:\n${joined}`)
  assert.ok(joined.includes('Read src/transcript.ts [running]'), `expanded tool card must appear:\n${joined}`)
  // The WorkingIndicator is untouched by the expansion.
  assert.ok(joined.includes('Working...'), `WorkingIndicator must stay while expanded:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('new events stream into the RUNNING expansion', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  // The turn keeps running: a second tool call + reasoning land live.
  folder.apply([
    eventAt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'checking turn boundaries…' } }, T0 + 4000, 10),
    eventAt('tool/call', { turn: 1, step: 1, callId: CallId('c2'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, T0 + 4100, 11),
  ])
  show(app, folder)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('checking turn boundaries…'), `new reasoning must stream into the expansion:\n${joined}`)
  assert.ok(joined.includes('pnpm test'), `new tool call must stream into the expansion:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('turn/end preserves a running expansion (▾) and settles the final below it', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'running turn must expand')
  // turn/end: the expansion choice SURVIVES (plan §16.2); the symbol flips
  // ◐→▾ (already expanded) and the final assistant appears after the
  // process — exactly once.
  folder.apply(settleEvents(0))
  show(app, folder)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'turn/end must keep the expansion (plan Invariant 7)')
  assert.ok(joined.includes('The transcript folds events incrementally.'), `final assistant missing:\n${joined}`)
  assert.equal((joined.match(/The transcript folds events incrementally\./g) ?? []).length, 1,
    'the final assistant must never duplicate')
  app.setFullscreen(false)
  app.stop()
})

test('a collapsed running turn stays collapsed after turn/end (◐ → ▸) and shows only the final', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐋 Thought'), 'starts collapsed')
  folder.apply(settleEvents(0))
  show(app, folder)
  await vt.waitForRender()
  const view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐋 Thought'), `completed collapsed symbol missing:\n${joined}`)
  assert.ok(!joined.includes('🐳'), 'collapsed process stays hidden after turn/end (no thinking card)')
  assert.ok(!joined.includes('📖'), 'collapsed process stays hidden after turn/end (no tool card)')
  assert.ok(joined.includes('The transcript folds events incrementally.'), `final assistant must show below the card:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('clicking the expanded header collapses the turn again while it runs', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'))
  // The header row is now the FIRST row of the block: click it again.
  y = findRow(vt.getViewport(), '🐳 Thought')
  click(vt, 20, y + 1) // a different cell: the whole header row is the hit area
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), `collapse must return to 🐋:\n${joined}`)
  assert.ok(!joined.includes('📖 Read src/transcript.ts'), `collapse must hide the process again:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('Ctrl+O cannot leak a collapsed Focus turn (outer gate)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.setToolOutputExpanded(true) // Ctrl+O master switch ON
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('🐳'), `Ctrl+O must not leak collapsed thinking:\n${joined}`)
  assert.ok(!joined.includes('📖'), `Ctrl+O must not leak collapsed tools:\n${joined}`)
  // Focus OFF restores the normal Ctrl+O semantics (the same snapshot now
  // renders the process because the projection no longer hides it).
  app.setFocusMode(false)
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('locating the transcript path'), `Focus OFF must restore Ctrl+O expansion:\n${restored}`)
  app.setFullscreen(false)
  app.stop()
})

test('session switch clears the Focus disclosures (transient state)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'))
  // A session switch clears the per-session disclosures (plan §16.3) — the
  // persisted preference survives. The runner repaints right after.
  app.clearSessionOverrides()
  show(app, folder)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), `switch must re-collapse the turn:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('the subagent-viewer scope preserves and restores the parent disclosures', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'parent turn expanded')
  // Enter the child scope: the parent's expansion must NOT leak into the
  // child (its turn numbers are a separate namespace — plan §26), and the
  // child shows the turn collapsed again.
  app.enterFocusViewerScope()
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐋 Thought'), 'viewer scope starts collapsed')
  // Exit: the parent's disclosure choice is restored (review fix — the
  // saved set must be a COPY, never the live set that gets cleared).
  app.exitFocusViewerScope()
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'parent expansion must be restored')
  app.setFullscreen(false)
  app.stop()
})

test('discardFocusViewerScope never restores the parked disclosures (Esc exits restore; swaps discard)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'parent turn expanded')
  app.enterFocusViewerScope()
  await vt.waitForRender()
  // Discard WITHOUT a session-override clear: the parked snapshot must be
  // dropped, never restored (the swap teardown's explicit intent).
  app.discardFocusViewerScope()
  show(app, folder)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), `discard must leave the turn collapsed:\n${joined}`)
  assert.ok(!joined.includes('🐳 Thought'), `discard must never restore the old disclosure:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('a session switch while viewing DISCARDS the parent Focus disclosures (never restores them)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'session A turn expanded')
  // Enter the child scope: the parent's expansion parks in the stack.
  app.enterFocusViewerScope()
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐋 Thought'), 'viewer scope starts collapsed')
  // Session swap while viewing: the runner clears the old session's
  // transient state, then tears the viewer down. The swap must DISCARD
  // the parked parent disclosure — restoring it (the old exitFocusViewerScope
  // in the teardown) would leak Session A's turn expansion into Session B,
  // which the new session's SAME turn number would then render expanded.
  app.clearSessionOverrides()
  app.discardFocusViewerScope()
  show(app, folder)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), `the new session must NOT inherit the old disclosure:\n${joined}`)
  assert.ok(!joined.includes('🐳 Thought'), `no restore into the new session:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('a session switch with the SAME turn number and revision renders the NEW activity (no stale Thought)', async () => {
  const { vt, app } = startApp()
  // Session A: turn 1 with one read call (revision 2 after 2 events).
  const folderA = new TranscriptFolder()
  folderA.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('ca'), name: 'read', arguments: JSON.stringify({ path: 'a.ts' }) }, T0 + 1, 1),
  ])
  app.setFocusMode(true)
  show(app, folderA)
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('read ×1'), 'session A shows its read activity')
  // Session B: the SAME turn number with the SAME revision count but a
  // DIFFERENT activity (bash). The activity-object identity in the cache
  // key must force a rebuild — never a stale parent component (review fix).
  const folderB = new TranscriptFolder()
  folderB.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('cb'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, T0 + 1, 1),
  ])
  app.clearSessionOverrides() // the runner's session-switch cleanup
  show(app, folderB)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('bash ×1'), `session B must render its OWN activity:\n${joined}`)
  assert.ok(!joined.includes('read ×'), `session A's activity must not leak into B:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('boot restore: a persisted Focus ON applies to the app BEFORE the first frame (runner contract)', async () => {
  // The runner restores the persisted focusMode into focusState and then —
  // at the boot visual-settings stage, BEFORE the first normal display —
  // calls app.setFocusMode(focusState.enabled) (index.ts). This test locks
  // THAT ordering contract: an app receiving setFocusMode before its first
  // transcript snapshot renders a running turn collapsed WITHOUT any
  // /focus command — the model-side and UI-side halves of Focus cannot
  // split across restarts (review blocker).
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true) // boot restore — no /focus involved
  show(app, folder)      // the first snapshot lands AFTER the restore
  app.setFullscreen(true)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), `restored Focus must project the running turn:\n${joined}`)
  assert.ok(!joined.includes('🐳'), `restored Focus must hide the process:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('Alt+T (hideThinking) cannot hide thinking inside an EXPANDED Thought; Focus OFF restores it', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.toggleThinkingHidden() // Alt+T: hideThinking = true
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Collapsed: thinking stays hidden (the process rows are absent anyway).
  assert.ok(!vt.getViewport().join('\n').includes('🐳'), 'collapsed stays hidden under Alt+T')
  // Expand: the user asked for the full turn — thinking must appear even
  // though hideThinking is on (plan §15.1; review fix).
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  const expanded = vt.getViewport().join('\n')
  assert.ok(expanded.includes('🐳'), `an expanded Thought must reveal thinking under Alt+T:\n${expanded}`)
  // Focus OFF: the plain Alt+T semantics come back (thinking hidden again).
  app.setFocusMode(false)
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(!restored.includes('locating the transcript path'), `Focus OFF must restore hideThinking:\n${restored}`)
  app.setFullscreen(false)
  app.stop()
})

test('Focus OFF renders the ordinary transcript (strong regression)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('locating the transcript path'), `Focus OFF must keep current behavior:\n${joined}`)
  assert.ok(!joined.includes('Thought'), 'no Focus card when Focus is off')
  app.setFullscreen(false)
  app.stop()
})

test('a failed turn collapses to ⚠ with the error line and no final', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply([
    ...runningTurn(0),
    eventAt('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E_BOOM', message: 'tool failed' } } }, T0 + 8000, 20),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Failed after 8s'), `failed header missing:\n${joined}`)
  assert.ok(joined.includes('Error:   E_BOOM: tool failed'), `error line missing:\n${joined}`)
  assert.ok(!joined.includes('The transcript folds events incrementally.'), 'no final for a failed turn')
  app.setFullscreen(false)
  app.stop()
})

test('max-tokens keeps the settled output with the truncated marker', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply([
    ...runningTurn(0),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a2'), role: 'assistant',
        content: [{ type: 'text', text: 'Useful partial conclusion.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 6000, 21),
    eventAt('turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, T0 + 7000, 22),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Max tokens'), `max-tokens header missing:\n${joined}`)
  assert.ok(joined.includes('Useful partial conclusion.'), `settled output must stay visible:\n${joined}`)
  assert.ok(joined.includes('output may be truncated'), `truncated marker missing:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})
