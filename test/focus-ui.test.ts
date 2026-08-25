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
import type { ToolPresenter } from '../src/present.ts'
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

/** A MINIMAL settled turn (one bash call, no reasoning): enough turns to
 * exercise the recent-turn derivation. */
function miniTurn(turn: number, baseSeq: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn }, T0 + baseSeq, baseSeq),
    eventAt('user/message', { id: MessageId(`u${turn}`), role: 'user', content: [{ type: 'text', text: `prompt ${turn}` }], source: { kind: 'user' } }, T0 + baseSeq + 1, baseSeq + 1),
    eventAt('tool/call', { turn, step: 0, callId: CallId(`c${turn}`), name: 'bash', arguments: JSON.stringify({ command: `cmd ${turn}` }) }, T0 + baseSeq + 2, baseSeq + 2),
    eventAt('assistant/message', { turn, step: 1, message: { id: MessageId(`a${turn}`), role: 'assistant', content: [{ type: 'text', text: `done ${turn}` }], source: { kind: 'model', provider: 'p', model: 'm' } } }, T0 + baseSeq + 3, baseSeq + 3),
    eventAt('turn/end', { turn, reason: { kind: 'completed' } }, T0 + baseSeq + 4, baseSeq + 4),
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

test('clicking the Thought header expands a RUNNING turn: process visible, Thinking compact by default', async () => {
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
  // The open Thought reveals the process timeline: the tool card is
  // visible (compact) — and the Thinking card is COMPACT with its
  // preview (the disclosure model never hides a block that exists).
  assert.ok(joined.includes('Read src/transcript.ts [running]'), `expanded tool card must appear:\n${joined}`)
  assert.ok(joined.includes('locating the transcript path'), `Thinking must be visible (compact) in Focus:\n${joined}`)
  assert.ok(joined.includes('(click to expand)'), `the compact Thinking card must carry the click hint:\n${joined}`)
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
  // The compact Thinking card is visible by default: click it into full
  // so the reasoning is the live surface.
  let view = vt.getViewport()
  const ty = findRow(view, 'locating the transcript path')
  assert.ok(ty >= 0, `Thinking secondary missing:\n${view.join('\n')}`)
  click(vt, 10, ty + 1)
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

test('Alt+T is the ONE Thinking detail toggle, shared by Focus ON/OFF (unified disclosure contract)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Focus ON: expand the root — Thinking is COMPACT but PRESENT (the
  // disclosure model has no hidden state).
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('locating the transcript path'), 'Focus expanded must show Thinking (compact) by default')
  assert.ok(joined.includes('(click to expand)'), 'the compact Thinking card must carry the click hint')
  // Alt+T: full — the compact hint disappears.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('(click to expand)'), 'Alt+T must expand Thinking (no compact hint)')
  // Focus OFF keeps the SAME preference — there is no second Focus state.
  app.setFocusMode(false)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('(click to expand)'), 'Focus OFF must keep the expanded Thinking preference')
  assert.ok(joined.includes('locating the transcript path'), 'Focus OFF keeps the same Thinking card')
  // Alt+T again: compact — the block stays VISIBLE with its preview.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('(click to expand)'), 'the second Alt+T returns to compact (hint back)')
  assert.ok(joined.includes('locating the transcript path'), 'Alt+T must never remove the Thinking block')
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

// ── secondary disclosures (the 2026-08-24 supplement) ───────────────────

test('a RUNNING turn supports live secondary disclosures (plan §41)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.setWorking(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root.
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  // Thinking is compact by default: click the compact card full.
  assert.ok(view.join('\n').includes('locating the transcript path'), 'the compact Thinking preview must be visible by default')
  // Click the compact Thinking card: full reveal.
  const ty = findRow(view, 'locating the transcript path')
  click(vt, 10, ty + 1)
  await vt.waitForRender()
  // Append a new reasoning delta: it streams into the OPEN secondary.
  folder.apply([
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'checking turn boundaries…' } }, T0 + 4000, 10),
  ])
  show(app, folder)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('checking turn boundaries…'), `new reasoning must stream into the open secondary:\n${joined}`)
  // Click the reasoning body (a DIFFERENT cell than the expand click —
  // the alt screen treats a fast repeat at the same cell as a double-click
  // word selection): the secondary folds, the root stays open.
  const bodyY = findRow(view, 'checking turn boundaries')
  click(vt, 30, bodyY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const after = view.join('\n')
  assert.ok(after.includes('🐳 Thought'), 'the root must stay open')
  // The compact card carries the expand hint; the full one does not.
  assert.ok(after.includes('(click to expand)'), `the secondary must fold back to compact (click hint):\n${after}`)
  assert.ok(after.includes('Working...'), 'the WorkingIndicator must stay')
  app.setFullscreen(false)
  app.stop()
})

test('turn/end keeps the root and the secondary open; the final appears outside (plan §42)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root, then the Thinking secondary (compact by default).
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const ty = findRow(view, 'locating the transcript path')
  click(vt, 10, ty + 1)
  await vt.waitForRender()
  // turn/end: the root AND the secondary stay open; the final appears.
  folder.apply(settleEvents(0))
  show(app, folder)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'the root must stay open after turn/end')
  assert.ok(joined.includes('locating the transcript path'), 'the secondary must stay open after turn/end')
  assert.ok(joined.includes('The transcript folds events incrementally.'), 'the final must appear outside the Thought')
  app.setFullscreen(false)
  app.stop()
})

test('Ctrl+O cannot force the secondaries full inside an expanded Thought (plan §44)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.setToolOutputExpanded(true) // Ctrl+O master switch ON
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Focus collapsed: no process leak.
  let joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('🐳'), 'Ctrl+O must not leak collapsed process rows')
  // Expand the root: the secondaries stay COMPACT even with Ctrl+O on —
  // Thinking included: the fullscreen click hint marks the click-owned
  // card, and Ctrl+O (the process detail master) never expands it.
  const y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'the root must expand')
  assert.ok(joined.includes('(click to expand)'), 'the Thinking secondary must stay compact under Ctrl+O (click hint)')
  // Focus OFF restores the ordinary Ctrl+O semantics for TOOLS (the
  // recent-turn boundary expands the tool card — no hint) while the
  // Thinking card stays compact and click-owned (fullscreen).
  app.setFocusMode(false)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('Read src/transcript.ts'), 'Focus OFF must restore the Ctrl+O tool expansion')
  assert.ok(joined.includes('(click to expand)'), 'Thinking stays compact: Ctrl+O does not own Thinking detail')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Thinking: compact default, click-full, Alt+T toggles the bulk level (plan §45 → unified)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root: Thinking is COMPACT by default (the unified
  // disclosure model — a block that exists is always present).
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  let joined = view.join('\n')
  assert.ok(joined.includes('locating the transcript path'), 'Thinking must be visible (compact) in Focus')
  assert.ok(joined.includes('(click to expand)'), 'the Thinking secondary must be COMPACT (click hint)')
  // Click it: the full reasoning appears (the hint disappears).
  const ty = findRow(view, 'locating the transcript path')
  click(vt, 10, ty + 1)
  await vt.waitForRender()
  const full = vt.getViewport().join('\n')
  assert.ok(full.includes('locating the transcript path'), 'the full reasoning must appear')
  assert.ok(!full.includes('(click to expand)'), 'the full reasoning must not carry the compact hint')
  // Alt+T toggles the BULK level (clearing the per-card override): full.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  const expanded = vt.getViewport().join('\n')
  assert.ok(expanded.includes('locating the transcript path'), 'Alt+T keeps the block visible')
  assert.ok(!expanded.includes('(click to expand)'), 'bulk expanded: no compact hint')
  // Alt+T again: compact — the block stays PRESENT with its preview
  // (never removed: Alt+T is a detail toggle, not a visibility gate).
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  const collapsed = vt.getViewport().join('\n')
  assert.ok(collapsed.includes('(click to expand)'), 'the second Alt+T must return to compact (hint back)')
  assert.ok(collapsed.includes('locating the transcript path'), 'compact must keep the preview — never remove the block')
  assert.ok(collapsed.includes('🐳 Thought'), 'the root and the rest of the timeline must stay')
  app.setFullscreen(false)
  app.stop()
})

test('a session switch clears the secondary expansions with the other overrides (plan §30)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root, then the Thinking secondary (compact by default).
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const ty = findRow(view, 'locating the transcript path')
  click(vt, 10, ty + 1)
  await vt.waitForRender()
  // Session switch: the secondary overrides are cleared with the rest —
  // the THINKING bulk preference is a runtime UI preference and survives
  // (plan §5.3).
  app.clearSessionOverrides()
  show(app, folder)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐋 Thought'), 'the switch must re-collapse the turn')
  // Reopen: the Thinking secondary is compact again (the per-card
  // override was cleared; the category is still visible).
  y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const reopened = view.join('\n')
  assert.ok(reopened.includes('🐳 Thought'), 'the root must reopen')
  assert.ok(reopened.includes('(click to expand)'), 'the secondary must be compact after the switch')
  app.setFullscreen(false)
  app.stop()
})

test('revealSearchMatch opens the owner Thought and full-reveals the matched secondary (plan §28)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // The search hit is the THINKING card (a secondary) inside the collapsed
  // turn: the jump must open the Thought AND full-reveal the matched card,
  // or the hit would stay hidden in the compact timeline.
  const messages = folder.messages()
  const thinking = messages.find(m => m.kind === 'thinking')
  assert.ok(thinking !== undefined, 'fixture: the thinking card exists')
  app.revealSearchMatch(thinking)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('🐳 Thought'), 'the owner Thought must open')
  assert.ok(view.includes('locating the transcript path'), 'the matched reasoning must be visible')
  assert.ok(!view.includes('(click to expand)'), 'the matched secondary must be full-revealed (no compact hint)')
  app.setFullscreen(false)
  app.stop()
})

test('a plugin tool renderer sees the EFFECTIVE expansion inside an expanded Thought (review finding)', async () => {
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerToolRenderer({
    id: 'probe', toolName: 'read',
    render: (snapshot) => ({ kind: 'text', spans: [{ text: `probe ${snapshot.expanded}` }] }),
  }, 'plugin')
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root: the tool secondary stays COMPACT — the plugin
  // renderer must see expanded=false (the host's effective rule), never
  // the old boundary-driven full state.
  const y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('probe false'), `the plugin renderer must see the compact state:\n${view}`)
  // The per-card override full-reveals it: expanded=true.
  const ty = findRow(vt.getViewport(), 'probe false')
  click(vt, 10, ty + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('probe true'), `the plugin renderer must see the full state:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

test('regular mode: Ctrl+O is the Focus detail master (review contract)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  await vt.waitForRender()
  // Regular + Focus + Ctrl+O OFF: compact card, no process rows.
  let view = vt.getViewport()
  let joined = view.join('\n')
  assert.ok(joined.includes('🐋 Thought'), 'regular Focus starts compact')
  assert.ok(!joined.includes('Read src/transcript.ts [running]'), 'no process rows while compact')
  // Ctrl+O ON: the recent Focus Thought full-reveals (the keyboard
  // master); Thinking appears COMPACT (never hidden — Alt+T owns its
  // detail).
  app.setToolOutputExpanded(true)
  await vt.waitForRender()
  view = vt.getViewport()
  joined = view.join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'Ctrl+O must expand the recent Focus Thought')
  assert.ok(joined.includes('Read src/transcript.ts [running]'), 'the tool card must be revealed')
  assert.ok(joined.includes('locating the transcript path'), 'Thinking stays present (compact) in the regular detail mode')
  assert.ok(joined.includes('(alt+t to expand)'), 'the compact Thinking card carries the Alt+T hint')
  // Alt+T: the FULL Thinking appears (regular has no secondary click).
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('locating the transcript path'), 'Alt+T must expand Thinking in regular detail mode')
  assert.ok(!joined.includes('(alt+t to expand)'), 'the full card must not carry the compact hint')
  // Ctrl+O OFF: back to compact.
  app.setToolOutputExpanded(false)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), 'Ctrl+O must collapse the recent Focus Thoughts')
  assert.ok(!joined.includes('Read src/transcript.ts [running]'), 'the process must hide again')
  // The bulk Thinking preference is untouched by Ctrl+O: reopening the
  // root (Alt+T-independent) still renders Thinking full.
  app.setToolOutputExpanded(true)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('(alt+t to expand)'), 'Thinking stays full — Ctrl+O never touches its detail')
  app.stop()
})

test('switching to fullscreen drops the Ctrl+O-derived reveal; back to regular it returns (plan §16)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  app.setToolOutputExpanded(true) // regular Ctrl+O master ON
  show(app, folder)
  await vt.waitForRender()
  // Regular: the derived reveal is active.
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'regular Ctrl+O reveals the recent Thought')
  // Enter fullscreen: the derived state must NOT carry over — the manual
  // disclosures (focusExpandedTurns) are the only fullscreen state.
  app.setFullscreen(true)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), 'fullscreen must not inherit the Ctrl+O-derived reveal')
  // Back to regular: the keyboard master is still ON — the reveal returns.
  app.setFullscreen(false)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'regular must restore the Ctrl+O full detail')
  app.stop()
})

test('regular mode: a manually revealed turn full-reveals its process (no dead compact cards)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  await vt.waitForRender()
  // Manually expand the turn (the search-reveal path).
  app.expandFocusTurn(1)
  await vt.waitForRender()
  // Regular has no mouse: ANY expanded Focus root full-reveals its
  // non-Thinking process — never a dead `(ctrl+o to expand)` card that
  // Ctrl+O cannot open. Thinking renders COMPACT with its Alt+T hint
  // (its own disclosure owner).
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'the manual reveal opens the Thought')
  assert.ok(joined.includes('Read src/transcript.ts [running]'), 'the tool card must be revealed')
  assert.ok(!joined.includes('(ctrl+o to expand)'), 'no compact secondary affordance in regular mode')
  assert.ok(joined.includes('locating the transcript path'), 'Thinking is present (compact preview)')
  assert.ok(joined.includes('(alt+t to expand)'), 'the compact Thinking card carries the Alt+T hint')
  // Alt+T: the FULL Thinking appears.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('locating the transcript path'), 'Alt+T expands the Thinking')
  assert.ok(!joined.includes('(alt+t to expand)'), 'the full Thinking is never compact')
  app.stop()
})

test('regular Ctrl+O derives ONLY the recent Focus turns; older roots stay collapsed (plan §11)', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 4; turn += 1) folder.apply(miniTurn(turn, turn * 100))
  app.setFocusMode(true)
  show(app, folder)
  await vt.waitForRender()
  // Ctrl+O OFF: everything compact.
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), 'starts compact')
  assert.ok(!joined.includes('🖥️  Bash cmd 2'), 'no process rows while compact')
  // Ctrl+O ON: the RECENT 3 turns derive-expand (their tool cards appear);
  // the OLDEST turn stays collapsed (its process stays hidden).
  app.setToolOutputExpanded(true)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  const expandedHeaders = (joined.match(/🐳 Thought/g) ?? []).length
  assert.equal(expandedHeaders, 3, `exactly the recent 3 turns derive-expand:\n${joined}`)
  assert.ok(joined.includes('🖥️  Bash cmd 4'), 'the newest turn full-reveals')
  assert.ok(joined.includes('🖥️  Bash cmd 2'), 'the boundary turn full-reveals')
  assert.ok(!joined.includes('🖥️  Bash cmd 1'), 'the OLDEST turn stays collapsed (no derived reveal)')
  app.stop()
})

test('regular search reveal of a NON-recent root full-reveals its process (no dead compact cards)', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 4; turn += 1) folder.apply(miniTurn(turn, turn * 100))
  app.setFocusMode(true)
  app.setToolOutputExpanded(true) // Ctrl+O ON: turns 2-4 derive
  show(app, folder)
  await vt.waitForRender()
  // The search reveals the OLDEST turn — NOT inside the recent boundary:
  // regular mode must still full-reveal its process (a manual root is
  // never a dead compact timeline).
  const oldestTool = folder.messages().find(m => m.kind === 'tool' && m.turn === 1)
  assert.ok(oldestTool !== undefined, 'fixture: the oldest turn has a tool card')
  app.revealSearchMatch(oldestTool)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🖥️  Bash cmd 1'), 'the non-recent root full-reveals its tool card in regular mode')
  assert.ok(!joined.includes('(ctrl+o to expand)'), 'no dead compact secondary affordance')
  app.stop()
})

test('regular Focus expanded roots render large diffs in FULL (no mouse, no cap)', async () => {
  const vt = new VirtualTerminal(100, 40)
  const newLines = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n')
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({
        card: 'diff' as const,
        title: 'Edit src/big.ts',
        diffs: [{ path: 'src/big.ts', oldText: null, newText: newLines }],
        locations: [],
      }),
      result: () => undefined,
    },
  })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('tool/call', {
      turn: 1, step: 0, callId: CallId('cdiff'),
      name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/big.ts', old_string: 'a\nb\nc', new_string: newLines }),
    }, T0 + 1, 1),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 2, 2),
  ])
  app.setFocusMode(true)
  show(app, folder)
  await vt.waitForRender()
  // Ctrl+O OFF: the collapsed turn's process is absent.
  let joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('new 15'), 'no process rows while compact')
  // Ctrl+O ON: the derived root full-reveals — the large diff renders in
  // FULL (regular has no mouse affordance to open a capped body).
  app.setToolOutputExpanded(true)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'the derived root must expand')
  assert.ok(joined.includes('new 15'), 'the regular Focus expanded root must render the diff in FULL')
  assert.ok(!joined.includes('more changes hidden'), 'no cap footer in the regular Focus reveal')
  app.stop()
})

test('cache identity: Ctrl+O ON caps a large diff, then /focus on FULL-REVEALS the same component (review finding)', async () => {
  const vt = new VirtualTerminal(100, 40)
  const newLines = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n')
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({
        card: 'diff' as const,
        title: 'Edit src/big.ts',
        diffs: [{ path: 'src/big.ts', oldText: null, newText: newLines }],
        locations: [],
      }),
      result: () => undefined,
    },
  })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('cdiff'), name: 'edit', arguments: JSON.stringify({ file_path: 'src/big.ts', old_string: 'a\nb\nc', new_string: newLines }) }, T0 + 1, 1),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 2, 2),
  ])
  // Focus OFF + Ctrl+O ON: the ordinary fold expands the card, the diff CAPS.
  app.setToolOutputExpanded(true)
  show(app, folder)
  await vt.waitForRender()
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('Edit src/big.ts'), 'the card renders')
  assert.ok(!joined.includes('new 15'), 'the diff is capped (Focus OFF ordinary fold)')
  // /focus on: the SAME card with the SAME expanded state — but the
  // surface contract full-reveals the diff. The cache MUST rebuild.
  app.setFocusMode(true)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('new 15'), 'the same tool must become FULL after /focus on')
  assert.ok(!joined.includes('more changes hidden'), 'no cap footer after /focus on')
  app.stop()
})

test('cache identity: /focus off restores the ordinary CAPPED diff presentation (review finding)', async () => {
  const vt = new VirtualTerminal(100, 40)
  const newLines = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n')
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({
        card: 'diff' as const,
        title: 'Edit src/big.ts',
        diffs: [{ path: 'src/big.ts', oldText: null, newText: newLines }],
        locations: [],
      }),
      result: () => undefined,
    },
  })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('cdiff'), name: 'edit', arguments: JSON.stringify({ file_path: 'src/big.ts', old_string: 'a\nb\nc', new_string: newLines }) }, T0 + 1, 1),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 2, 2),
  ])
  // Focus ON + Ctrl+O ON: the derived root full-reveals the diff.
  app.setFocusMode(true)
  app.setToolOutputExpanded(true)
  show(app, folder)
  await vt.waitForRender()
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('new 15'), 'the Focus reveal renders the diff FULL')
  // /focus off: the ordinary fold must restore the CAPPED presentation —
  // the cache must rebuild (same expanded state, fullReveal changed).
  app.setFocusMode(false)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('new 15'), 'Focus OFF must restore the capped ordinary presentation')
  assert.ok(joined.includes('more changes hidden'), 'the cap footer returns')
  app.stop()
})

test('cache identity: the Thinking hint rebuilds on surface switches (alt+t ↔ click)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'secret reasoning' }])
  await vt.waitForRender()
  // Regular compact Thinking carries the Alt+T hint.
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('(alt+t to expand)'), 'regular compact Thinking shows the Alt+T hint')
  // Fullscreen: the SAME compact card must rebuild to the click hint
  // (the surface switch changed the hint owner — never reuse the old).
  app.setFullscreen(true)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('(click to expand)'), 'fullscreen must rebuild the hint to click')
  assert.ok(!joined.includes('(alt+t to expand)'), 'the Alt+T hint must not survive the surface switch')
  // Back to regular: the Alt+T hint rebuilds again.
  app.setFullscreen(false)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('(alt+t to expand)'), 'regular must restore the Alt+T hint')
  assert.ok(!joined.includes('(click to expand)'), 'the click hint must not survive back into regular')
  app.stop()
})

/** A realistic multiline Bash heredoc (the ghost-row repro shape). */
const MULTILINE_BASH_COMMAND = [
  "python3 - <<'PYEOF'",
  'p = "src/commands.ts"',
  's = open(p).read()',
  'old = "..."',
  'assert old in s',
  'PYEOF',
].join('\n')

/** A presenter whose bash call returns the FULL multiline command as the
 * terminal card title (the DSH bash presenter's real shape). */
function bashHeredocPresenter(): ToolPresenter {
  return {
    call(name) {
      return name === 'bash'
        ? { card: 'terminal', title: MULTILINE_BASH_COMMAND, description: 'Patch commands test' }
        : undefined
    },
    result() { return undefined },
  }
}

/** A running turn with ONE multiline Bash call (no reasoning). */
function multilineBashTurn(seqBase: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'run the patch' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: MULTILINE_BASH_COMMAND }) }, T0 + 2, seqBase + 2),
  ]
}

/** The same turn WITHOUT the tool call: the clean baseline frame that
 * establishes the alt-screen diff state before the call arrives. */
function noToolTurn(seqBase: number): SessionEvent[] {
  return multilineBashTurn(seqBase).slice(0, 2)
}

/** The remaining events that settle the multiline Bash turn (✓ ok). */
function settleMultilineBashTurn(seqBase: number): SessionEvent[] {
  return [
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, T0 + 5000, seqBase + 3),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'patched.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 6000, seqBase + 4),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 7000, seqBase + 5),
  ]
}

test('fullscreen Focus: a multiline Bash heredoc stays ONE row and never ghosts across repeated repaints (ghost-row fix)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: bashHeredocPresenter() })
  app.start()
  const folder = new TranscriptFolder()
  // Baseline frame WITHOUT the tool: the alt screen's diff state is
  // established cleanly (a first frame with the multiline row would be a
  // full redraw that self-heals — the ghost only escapes when the row is
  // written by a DIFF frame whose following rows are unchanged).
  folder.apply(noToolTurn(0))
  app.setFocusMode(true)
  app.setWorking(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const assertNoGhost = (label: string) => {
    const joined = vt.getViewport().join('\n')
    assert.ok(joined.includes("python3 - <<'PYEOF'"), `${label}: the Tool preview must carry the command:\n${joined}`)
    for (const ghost of ['p = "src/commands.ts"', 's = open(p)', 'assert old']) {
      assert.ok(!joined.includes(ghost), `${label}: heredoc line leaked as a ghost row:\n${joined}`)
    }
  }
  // The multiline tool call arrives in a DIFF frame: pre-fix its embedded
  // newlines escape onto the unchanged rows below the Tool slot.
  folder.apply(multilineBashTurn(0).slice(2))
  show(app, folder)
  await vt.waitForRender()
  assertNoGhost('tool call frame')
  // The turn settles: the Tool row is rewritten (✓ prefix) — pre-fix that
  // rewrite re-ghosts; the final assistant row lands below it.
  folder.apply(settleMultilineBashTurn(0))
  show(app, folder)
  await vt.waitForRender()
  assertNoGhost('settle frame')
  // Repeated repaints (the runner's snapshot contract / streaming
  // heartbeats) WITHOUT any resize must not accumulate ghost rows.
  for (let i = 0; i < 3; i++) {
    show(app, folder)
    await vt.waitForRender()
    assertNoGhost(`repaint ${i + 1}`)
  }
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Focus expand/collapse: the expanded Bash card keeps the multiline command, collapse returns to ONE line (ghost-row fix)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { present: bashHeredocPresenter() })
  app.start()
  const folder = new TranscriptFolder()
  // Same diff-frame sequence: clean baseline, then ONLY the appended
  // suffix (tool/call + settle) lands in one later frame — a real
  // append-only event stream, never a duplicated user/message.
  folder.apply(noToolTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  folder.apply([...multilineBashTurn(0).slice(2), ...settleMultilineBashTurn(0)])
  show(app, folder)
  await vt.waitForRender()
  // Collapsed: the Tool slot is ONE row with the command identity only.
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes("python3 - <<'PYEOF'"), `collapsed preview missing:\n${joined}`)
  assert.ok(!joined.includes('p = "src/commands.ts"'), `heredoc leaked while collapsed:\n${joined}`)
  // Expand the Thought: the Bash full card renders the complete multiline
  // command (expanded mode legitimately uses multiple physical rows).
  let y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${joined}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  // The folded card caps the command; clicking the cap marker (fullscreen
  // mouse-owned disclosure) full-reveals it.
  let capY = findRow(vt.getViewport(), 'more command lines')
  assert.ok(capY >= 0, `cap marker missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 10, capY + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), `expansion failed:\n${joined}`)
  assert.ok(joined.includes('p = "src/commands.ts"'), `expanded Bash card must keep the full command:\n${joined}`)
  assert.ok(joined.includes('assert old in s'), `expanded Bash card must keep the full command:\n${joined}`)
  // Collapse again: only the single-line preview may remain — the old
  // multiline command rows must not be left behind (no resize anywhere).
  y = findRow(vt.getViewport(), '🐳 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), `collapse failed:\n${joined}`)
  assert.ok(joined.includes("python3 - <<'PYEOF'"), `collapsed preview missing after collapse:\n${joined}`)
  assert.ok(!joined.includes('p = "src/commands.ts"'), `old multiline command rows must not survive the collapse:\n${joined}`)
  assert.ok(!joined.includes('assert old in s'), `old multiline command rows must not survive the collapse:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('gutter blocker: the fullscreen Focus hit-map stays aligned across the disclosure sequence and a resize (40 → 16)', async () => {
  // The right-gutter contract's blocker test (2026-08-26 plan §8.3): with
  // the transcript content 2 cells narrower than the terminal, every click
  // must still hit the SAME visual block — collapsed Thought → thinking
  // secondary → resize → secondary again → root collapse — with no
  // one-row drift anywhere in the sequence.
  const vt = new VirtualTerminal(40, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'run the flow' }],
      source: { kind: 'user' },
    }, T0 + 1, 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'alpha reasoning\nalpha latest' } }, T0 + 2, 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, T0 + 3, 3),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, T0 + 4, 4),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'the final answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 5, 5),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 6, 6),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // 1. The collapsed Thought header: a click expands the process timeline.
  let lines = vt.getViewport()
  let y = findRow(lines, '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${lines.join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('▸ Thinking'), `the process timeline must appear under the expanded Thought:\n${view}`)
  assert.ok(view.includes('(click to expand)'), `the Thinking secondary must be compact with the click hint:\n${view}`)
  // 2. Click the Thinking secondary → the FULL reasoning body renders.
  lines = vt.getViewport()
  let ty = findRow(lines, '▸ Thinking')
  assert.ok(ty >= 0, `Thinking secondary missing:\n${lines.join('\n')}`)
  click(vt, 3, ty + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('alpha reasoning'), `the secondary click must reveal the full reasoning body:\n${view}`)
  assert.ok(!view.includes('(click to expand)'), `the expanded secondary must drop the click hint:\n${view}`)
  // 3. Resize 40 → 16: the hit map re-derives; clicking the SAME block
  // (now 14 content cols) collapses the secondary again. A DIFFERENT
  // cell than the previous click — the alt screen treats a fast repeat
  // at the same cell as a double-click word selection (the established
  // fullscreen-click convention).
  vt.resize(16, 24)
  await vt.waitForRender()
  lines = vt.getViewport()
  ty = lines.findIndex(line => line.includes('▸ Thinking') || line.includes('Thin'))
  assert.ok(ty >= 0, `secondary missing after resize:\n${lines.join('\n')}`)
  click(vt, 14, ty + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  // At 14 content cols the compact hint truncates ('(click to e…'), so
  // the COMPACT MARKER (▸) and the missing full body prove the collapse.
  assert.ok(view.includes('▸ Thinking'), `the post-resize click must collapse the secondary back:\n${view}`)
  assert.ok(!view.includes('alpha reasoning'), `the collapsed secondary must hide the full body:\n${view}`)
  // 4. Click the Thought header again → the whole process collapses; the
  // click map must still land on the root, never a stray row.
  lines = vt.getViewport()
  y = findRow(lines, '🐳 Thought')
  assert.ok(y >= 0, `expanded Thought header missing:\n${lines.join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('🐋 Thought'), `the root collapse must land on the Thought:\n${view}`)
  assert.ok(!view.includes('▸ Thinking'), `the collapsed root must hide the process timeline:\n${view}`)
  app.setFullscreen(false)
  app.stop()
})
