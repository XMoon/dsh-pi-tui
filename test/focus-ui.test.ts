/**
 * Focus Mode headless UI tests (plan §58/§59/§60): the live Thought
 * disclosure — running turns expand/collapse by clicking the header, new
 * events stream into the expanded region, turn/end preserves the user's
 * choice, the final assistant never duplicates, the WorkingIndicator
 * survives every Focus state, and Ctrl+O cannot leak a collapsed turn.
 * The tail of this file locks the fullscreen+Focus interaction supplement
 * (plan 2026-08-25): Ctrl+O owns the Thought-root bulk (expand recent /
 * collapse all) in fullscreen Focus ONLY, and a click on a blank visual
 * row inside an expanded Thought collapses that Thought.
 * @module @xmoon76/dsh-pi-tui/focus-ui.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, windowMessages } from '../src/transcript.ts'
import { EXPAND_RECENT_TURNS, TuiApp } from '../src/tui-app.ts'
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

// ===========================================================================
// Fullscreen + Focus Ctrl+O root bulk disclosure + Thought blank-row
// collapse (plan 2026-08-25 §22/§23): Ctrl+O owns the Thought-root bulk in
// fullscreen Focus ONLY (expand recent / collapse all); a click on a blank
// visual row inside an expanded Thought collapses that Thought (the
// header-offscreen escape hatch). Regular / Focus-OFF / fullscreen+Focus-OFF
// keep their historical behavior.
// ===========================================================================

/** A settled turn with reasoning and a bash tool whose result is LONG
 * (40 lines): the folded card previews only the FIRST lines (merged), so
 * the LAST line (`out N line 39`) proves compact vs full-reveal — it
 * renders only when the secondary is actually expanded. */
function settledThoughtTurn(turn: number, baseSeq: number): SessionEvent[] {
  const lines = Array.from({ length: 40 }, (_, i) => `out ${turn} line ${i}`).join('\n')
  return [
    eventAt('turn/start', { turn }, T0 + baseSeq, baseSeq),
    eventAt('user/message', {
      id: MessageId(`u${turn}`), role: 'user',
      content: [{ type: 'text', text: `prompt ${turn}` }],
      source: { kind: 'user' },
    }, T0 + baseSeq + 1, baseSeq + 1),
    eventAt('assistant/chunk', { turn, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: `reasoning ${turn} line A\nreasoning ${turn} line B` } }, T0 + baseSeq + 2, baseSeq + 2),
    eventAt('tool/call', { turn, step: 0, callId: CallId(`c${turn}`), name: 'bash', arguments: JSON.stringify({ command: `cmd ${turn}` }) }, T0 + baseSeq + 3, baseSeq + 3),
    eventAt('tool/result', {
      turn, step: 0,
      message: {
        id: MessageId(`r${turn}`), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId(`c${turn}`), content: [{ type: 'text', text: lines }] }],
        source: { kind: 'tool', callId: CallId(`c${turn}`) },
      },
    }, T0 + baseSeq + 4, baseSeq + 4),
    eventAt('assistant/message', {
      turn, step: 1,
      message: {
        id: MessageId(`a${turn}`), role: 'assistant',
        content: [{ type: 'text', text: `done ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + baseSeq + 5, baseSeq + 5),
    eventAt('turn/end', { turn, reason: { kind: 'completed' } }, T0 + baseSeq + 6, baseSeq + 6),
  ]
}

/** A settled turn whose FIRST bash result is LONG (120 lines), followed
 * by a SECOND Thinking card and a SECOND (small) tool card before the
 * final — the header-scrolled-out-of-view blank-row scenario (plan
 * §23.1). The blank row above the second tool card is an INTERIOR blank
 * of the expanded Thought (between two of its cards): a click there
 * collapses the Thought, while pre-fix the spacer was charged to the
 * SECONDARY Thinking card and only toggled it — the test discriminates
 * the new fallback. */
function offscreenThoughtTurn(seqBase: number): SessionEvent[] {
  const lines = Array.from({ length: 120 }, (_, i) => `result line ${i}`).join('\n')
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'make it big' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'checking the projection…' } }, T0 + 2, seqBase + 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'seq 1 120' }) }, T0 + 3, seqBase + 3),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: lines }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, T0 + 4, seqBase + 4),
    eventAt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'cross-checking the tail…' } }, T0 + 5, seqBase + 5),
    eventAt('tool/call', { turn: 1, step: 2, callId: CallId('c2'), name: 'bash', arguments: JSON.stringify({ command: 'echo done' }) }, T0 + 6, seqBase + 6),
    eventAt('assistant/message', {
      turn: 1, step: 3,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 7, seqBase + 7),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 8, seqBase + 8),
  ]
}

test('fullscreen Focus Ctrl+O expands ONLY the recent roots; secondaries stay compact (plan §22.1)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 5; turn += 1) folder.apply(settledThoughtTurn(turn, turn * 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'precondition: every root collapsed')
  // Ctrl+O with NOTHING expanded → Expand Recent.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  const expanded = [...app.focusExpandedTurnsForTest()].sort((a, b) => a - b)
  assert.deepEqual(expanded, [3, 4, 5],
    `Ctrl+O must expand exactly the ${EXPAND_RECENT_TURNS} most recent eligible roots (got ${JSON.stringify(expanded)})`)
  // The secondaries stay COMPACT: the folded preview shows only the FIRST
  // merged lines — the LAST result line renders only on a full-reveal, so
  // its absence proves Ctrl+O opens roots only, never the per-card detail
  // (plan §4).
  const joined = vt.getViewport().join('\n')
  for (const turn of [3, 4, 5]) {
    assert.ok(!joined.includes(`out ${turn} line 39`), `Ctrl+O must not full-reveal secondaries (turn ${turn}):\n${joined}`)
  }
  // Thinking still follows the global preference (compact by default):
  // the expanded roots' Thinking cards carry the click hint.
  app.scrollToTop()
  await vt.waitForRender()
  const top = vt.getViewport().join('\n')
  assert.ok(top.includes('🐳 Thought'), `an expanded header must be visible at the top:\n${top}`)
  assert.ok(top.includes('(click to expand)'), `Thinking stays compact under Ctrl+O (click hint):\n${top}`)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Ctrl+O Expand Recent follows a pre-set global Thinking preference (plan §22.1/§5)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 3; turn += 1) folder.apply(settledThoughtTurn(turn, turn * 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Pre-set the bulk Thinking preference (Alt+T) BEFORE the expansion:
  // Expand Recent must neither hide it nor ignore it.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  assert.equal(app.isThinkingExpanded(), true, 'precondition: Thinking bulk-full')
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()].sort(), [1, 2, 3], 'Ctrl+O expanded the recent roots')
  assert.equal(app.isThinkingExpanded(), true, 'Ctrl+O must never change the global Thinking preference')
  const joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('(click to expand)'), `the expanded roots' Thinking cards must follow the bulk-full preference:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Ctrl+O collapses ALL roots once any is expanded (plan §22.2)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 5; turn += 1) folder.apply(settledThoughtTurn(turn, turn * 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  app.toggleFocusTurn(2)
  app.toggleFocusTurn(4)
  app.toggleFocusTurn(5)
  await vt.waitForRender()
  assert.equal(app.focusExpandedTurnsForTest().size, 3, 'precondition: three roots expanded')
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'Ctrl+O must collapse EVERY expanded root')
  const joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('🐳'), `no expanded Thought may remain:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Ctrl+O roundtrip is deterministic: recent-3 → all → recent-3 (plan §22.3)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 5; turn += 1) folder.apply(settledThoughtTurn(turn, turn * 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  for (const want of [[3, 4, 5], [], [3, 4, 5]]) {
    vt.sendInput('\x0f')
    await vt.waitForRender()
    const got = [...app.focusExpandedTurnsForTest()].sort((a, b) => a - b)
    assert.deepEqual(got, want, `Ctrl+O roundtrip step ${JSON.stringify(want)} failed`)
  }
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen Ctrl+O Collapse All clears every secondary override; the global Thinking preference survives (plan §22.4)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root by clicking the header.
  let y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'precondition: root expanded')
  // Local overrides: bulk Thinking ON (Alt+T), then collapse ONLY the
  // Thinking card via a click (the per-card override expresses the
  // opposite of the effective state) — the Thinking card is still above
  // the fold here.
  app.toggleThinkingExpanded()
  await vt.waitForRender()
  const thinkY = findRow(vt.getViewport(), '▾ Thinking')
  assert.ok(thinkY >= 0, `full Thinking card missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 10, thinkY + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('(click to expand)'), 'precondition: the Thinking click collapsed only that card (local override)')
  // Full-reveal the Bash card: the viewport follows the END, so the last
  // result line proves the card is full.
  const bashY = findRow(vt.getViewport(), 'Bash cmd 1')
  assert.ok(bashY >= 0, `Bash card missing:\n${joined}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('out 1 line 39'), 'precondition: the Bash card is locally full (tail visible)')
  // Ctrl+O = Collapse All: every override is dropped, the bulk Thinking
  // preference survives, and the tool master normalizes OFF (plan §8).
  app.setToolOutputExpanded(true) // pre-arm the master: the bulk fold must reset it
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'all roots collapsed')
  assert.equal(app.isToolOutputExpanded(), false, 'Collapse All normalizes the Ctrl+O master OFF (fullscreen Focus path only)')
  assert.equal(app.isThinkingExpanded(), true, 'Collapse All never touches the global Thinking preference')
  // Re-expand: the old local overrides must NOT resurrect.
  y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `collapsed header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), 're-expansion must work after Collapse All')
  assert.ok(!joined.includes('out 1 line 39'), `the old Bash local full-reveal must not resurrect:\n${joined}`)
  assert.ok(!joined.includes('(click to expand)'), `the global Thinking preference must survive Collapse All:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('regular Ctrl+O never writes the fullscreen Focus root set (plan §22.5/§22.6)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(runningTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  // Regular + Focus ON: Ctrl+O toggles the DERIVED reveal — the manual
  // root set must stay empty.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.isToolOutputExpanded(), true, 'regular Ctrl+O still owns the detail master')
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'regular Ctrl+O must never write focusExpandedTurns')
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'regular Focus Ctrl+O must keep deriving the reveal')
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.isToolOutputExpanded(), false, 'second Ctrl+O folds the derived reveal back')
  assert.ok(vt.getViewport().join('\n').includes('🐋 Thought'), 'the derived reveal must fold back')
  // Regular + Focus OFF: the historical master switch only.
  app.setFocusMode(false)
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.isToolOutputExpanded(), true, 'Focus OFF keeps the historical Ctrl+O')
  assert.equal(app.focusExpandedTurnsForTest().size, 0)
  app.stop()
})

test('fullscreen + Focus OFF: Ctrl+O keeps the historical tool master — never the root bulk (plan §22.7)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 3; turn += 1) folder.apply(settledThoughtTurn(turn, turn * 100))
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'Focus OFF must not enter the root-bulk branch')
  assert.equal(app.isToolOutputExpanded(), true, 'the historical tool master keeps toggling')
  app.setFullscreen(false)
  app.stop()
})

test('blank-row collapse works when the Thought header scrolled OUT of view (plan §23.1)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(offscreenThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root, then full-reveal the Bash card: the viewport follows
  // the END, so the Thought header scrolls out of view.
  let y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  const bashY = findRow(vt.getViewport(), 'Bash seq 1 120')
  assert.ok(bashY >= 0, `Bash card missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  let view = vt.getViewport()
  assert.ok(findRow(view, '🐳 Thought') < 0, `precondition: the header must be scrolled out of view:\n${view.join('\n')}`)
  // The tail shows the result body, then a SECOND Thinking card, then a
  // SECOND tool card. The blank row above the tool card is an INTERIOR
  // blank of the same expanded Thought (between two of its cards) — the
  // blank-row escape hatch: pre-fix that spacer belonged to the Thinking
  // secondary (a click toggled only the card), so this test discriminates
  // the new fallback.
  const echoY = findRow(view, 'Bash echo done')
  assert.ok(echoY >= 0, `the second tool card must be visible at the tail:\n${view.join('\n')}`)
  assert.equal(view[echoY - 1].trim(), '', `the clicked row must be a blank visual row:\n${view.join('\n')}`)
  // Click the blank row (0-based `echoY - 1`): the Thought collapses and
  // its header anchors back into view — the existing collapse anchor, no
  // new scrolling (plan §18).
  click(vt, 3, echoY)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐋 Thought'), `the blank-row click must collapse the Thought:\n${joined}`)
  const headerY = findRow(view, '🐋 Thought')
  assert.ok(headerY >= 0 && headerY <= 3, `the collapse anchor must bring the header near the top:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('a secondary content row toggles only the secondary; the adjacent blank row collapses the Thought (plan §23.2)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  // The Bash card's CONTENT row toggles only the secondary: the last
  // result line proves the full-reveal, and the ROOT stays open.
  const bashY = findRow(vt.getViewport(), 'Bash cmd 1')
  assert.ok(bashY >= 0, `Bash card missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('out 1 line 39'), 'the Bash secondary must full-reveal on its own row')
  assert.deepEqual([...app.focusExpandedTurnsForTest()], [1], 'the Thought root must stay expanded')
  // Scroll back to the top: the blank row between Thinking and Bash
  // (charged to the Thinking entry) is now visible again — clicking it
  // collapses the Thought; the card's own rows never do.
  app.scrollToTop()
  await vt.waitForRender()
  const topView = vt.getViewport()
  const topBashY = findRow(topView, 'Bash cmd 1')
  assert.ok(topBashY >= 0, `Bash card missing at the top:\n${topView.join('\n')}`)
  assert.equal(topView[topBashY - 1].trim(), '', `the clicked row must be a blank visual row:\n${topView.join('\n')}`)
  click(vt, 3, topBashY)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐋 Thought'), `the blank row must collapse the Thought:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('clicking the Thinking row toggles the secondary, never the root (plan §23.3)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('(click to expand)'), 'precondition: Thinking compact with the hint')
  const thinkY = findRow(vt.getViewport(), '▸ Thinking')
  assert.ok(thinkY >= 0, `Thinking card missing:\n${joined}`)
  click(vt, 10, thinkY + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('(click to expand)'), `the Thinking click must full-reveal only that card:\n${joined}`)
  assert.ok(joined.includes('🐳 Thought'), `the Thought root must stay expanded:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('a blank-row click collapses ONLY the owning Thought (plan §23.4)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  folder.apply(settledThoughtTurn(2, 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand both roots: click each collapsed header in turn.
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  assert.ok(y >= 0, `first Thought header missing:\n${view.join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  y = findRow(view, '🐋 Thought')
  assert.ok(y >= 0, `second Thought header missing:\n${view.join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.deepEqual([...app.focusExpandedTurnsForTest()].sort(), [1, 2], 'precondition: both roots expanded')
  const joined = view.join('\n')
  assert.equal(joined.split('🐳 Thought').length - 1, 2, `precondition: two expanded headers visible:\n${joined}`)
  // The blank row INSIDE turn 2 (between its Thinking and Bash cards):
  // only turn 2 collapses.
  const bash2Y = findRow(view, 'Bash cmd 2')
  assert.ok(bash2Y >= 0, `turn-2 Bash card missing:\n${joined}`)
  assert.equal(view[bash2Y - 1].trim(), '', `the clicked row must be a blank spacer row:\n${joined}`)
  click(vt, 3, bash2Y)
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()].sort(), [1], 'only the OWNING Thought collapses')
  const after = vt.getViewport().join('\n')
  assert.equal(after.split('🐳 Thought').length - 1, 1, `the other Thought must stay expanded:\n${after}`)
  assert.ok(after.includes('🐋 Thought'), 'the collapsed Thought header must anchor into view')
  app.setFullscreen(false)
  app.stop()
})

test('clicking a blank row that belongs to NO Thought is a no-op (plan §23.5)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  // The rows BELOW the final assistant belong to no Thought: blank clicks
  // there must be no-ops (plan §16 — never guess a "nearest Thought").
  const finalY = findRow(vt.getViewport(), 'done 1')
  assert.ok(finalY >= 0, `final assistant missing:\n${vt.getViewport().join('\n')}`)
  const blankView = vt.getViewport()
  assert.equal(blankView[finalY + 2].trim(), '', `the clicked row must be blank and outside every Thought region:\n${blankView.join('\n')}`)
  const before = [...app.focusExpandedTurnsForTest()]
  click(vt, 3, finalY + 3) // two blank rows below the final
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()], before, 'a global blank must not collapse anything')
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), `the Thought must stay expanded:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('clicks on the editor seat and the footer never collapse a Thought (plan §23.6)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  // Bottom chrome rows: the footer (row 29) and rows above it (editor
  // seat / working / queue chrome). None may reach the blank-row fallback.
  for (const row of [29, 27, 25]) {
    click(vt, 3, row)
    await vt.waitForRender()
    assert.deepEqual([...app.focusExpandedTurnsForTest()], [1],
      `a bottom-chrome click at row ${row} must not collapse the Thought`)
  }
  const joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('🐳 Thought'), `the Thought must stay expanded:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('the blank-row fallback never pierces an open overlay (plan §23.7)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'precondition: root expanded')
  // An open overlay owns the click: the blank row between Thinking and
  // Bash is INSIDE the expanded Thought, yet must NOT collapse it — and
  // must not even reach the secondary (the Thinking card stays compact:
  // pre-fix the spacer click toggled it behind the overlay).
  app.startTranscriptSearch()
  await vt.waitForRender()
  const overlayView = vt.getViewport()
  const bashY = findRow(overlayView, 'Bash cmd 1')
  assert.ok(bashY >= 0, `Bash card missing:\n${overlayView.join('\n')}`)
  assert.equal(overlayView[bashY - 1].trim(), '', `the clicked row must be blank:\n${overlayView.join('\n')}`)
  click(vt, 3, bashY)
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()], [1], 'an open overlay must block the blank-row collapse')
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('(click to expand)'), `the Thinking card must stay untouched behind the overlay:\n${after}`)
  // CONCRETE rows are equally inert behind the overlay: the guard covers
  // the whole transcript hit-test, not just the blank fallback — the
  // Bash content row must not full-reveal either.
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()], [1], 'a content row must not reach the transcript behind the overlay')
  const after2 = vt.getViewport().join('\n')
  assert.ok(!after2.includes('out 1 line 39'), `the Bash card must not full-reveal behind the overlay:\n${after2}`)
  app.closeTranscriptSearch()
  app.setFullscreen(false)
  app.stop()
})

test('resize keeps the blank-row click map aligned (plan §23.8)', async () => {
  const vt = new VirtualTerminal(100, 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(offscreenThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root, then full-reveal the Bash card.
  let y = findRow(vt.getViewport(), '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let view = vt.getViewport()
  const bashY = findRow(view, 'Bash seq 1 120')
  assert.ok(bashY >= 0, `Bash card missing:\n${view.join('\n')}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(findRow(view, 'result line 119') >= 0, 'precondition: the result tail is visible')
  // Resize: rows re-wrap — the y-regions must be re-measured, never stale.
  vt.resize(60, 40)
  await vt.waitForRender()
  view = vt.getViewport()
  const echoY = findRow(view, 'Bash echo done')
  assert.ok(echoY >= 0, `the second tool card missing after resize:\n${view.join('\n')}`)
  assert.equal(view[echoY - 1].trim(), '', `the clicked row must still be the interior blank after resize:\n${view.join('\n')}`)
  // The frame painted at the new size (the paint probe stamped it), so
  // the interior blank above the second tool card collapses the Thought
  // with the header anchored — no stale frame involved.
  click(vt, 3, echoY)
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('🐋 Thought'), `the blank-row collapse must work after resize:\n${after}`)
  app.setFullscreen(false)
  app.stop()
})

test('a blank-row click BEFORE the first paint after a resize is dropped — rebuilds do not re-arm it (round-4 P1)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(offscreenThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root, then full-reveal the long Bash card.
  let y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let view = vt.getViewport()
  const bashY = findRow(view, 'Bash seq 1 120')
  assert.ok(bashY >= 0, `Bash card missing:\n${view.join('\n')}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const preEchoY = findRow(view, 'Bash echo done')
  assert.ok(preEchoY >= 0, `second tool card missing:\n${view.join('\n')}`)
  // Resize AND rebuild in the SAME tick, then click before ANY paint at
  // the new size: the on-screen frame still shows the old geometry — the
  // destructive blank click is dropped (a rebuild only SCHEDULES the
  // paint; it must not re-arm the guard).
  vt.resize(60, 40)
  app.setTranscript(folder.messages(), folder.turnActivities())
  click(vt, 3, preEchoY) // the OLD frame's blank position
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()].sort(), [1], 'the pre-paint blank click must be dropped')
  // After the paint at the new size, the next blank click resolves.
  view = vt.getViewport()
  const echoY = findRow(view, 'Bash echo done')
  assert.ok(echoY >= 0, `second tool card missing after the paint:\n${view.join('\n')}`)
  assert.equal(view[echoY - 1].trim(), '', 'the clicked row must be blank')
  click(vt, 3, echoY)
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('🐋 Thought'), `the post-paint blank click must collapse:\n${after}`)
  app.setFullscreen(false)
  app.stop()
})

test('Collapse All clears a secondary override parked on a WINDOWED-AWAY message (plan §7 review finding)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  folder.apply(settledThoughtTurn(2, 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand turn 1 and full-reveal its Bash card: a per-card override on
  // turn 1's tool message.
  let y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  let view = vt.getViewport()
  const bashY = findRow(view, 'Bash cmd 1')
  assert.ok(bashY >= 0, `Bash card missing:\n${view.join('\n')}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('out 1 line 39'), 'precondition: turn-1 Bash is locally full')
  // Window turn 1 away (the transcript folds to the most recent turn):
  // the override stays PARKED on turn 1's old message objects.
  app.setTranscript(windowMessages(folder.messages(), 1), folder.turnActivities())
  await vt.waitForRender()
  // Ctrl+O #1 with NOTHING expanded IN VIEW expands the visible recent
  // root (turn 2) — the parked turn-1 root stays parked.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  const afterExpand = [...app.focusExpandedTurnsForTest()]
  assert.ok(afterExpand.includes(2), `Ctrl+O must expand the visible root first (got ${JSON.stringify(afterExpand)})`)
  // Ctrl+O #2: a visible expanded root exists → Collapse All — and the
  // bulk fold must ALSO clear the PARKED override (the round-1 contract).
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'Collapse All cleared the roots')
  // Widen the window again: turn 1 returns with the SAME message objects.
  app.setTranscript(folder.messages(), folder.turnActivities())
  await vt.waitForRender()
  // Re-expand turn 1: the parked override must NOT resurrect the old
  // full-reveal (the bulk fold's cleanup contract covers parked state).
  app.scrollToTop()
  await vt.waitForRender()
  y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `collapsed header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('out 1 line 39'), `the parked override must not resurrect the full-reveal:\n${joined}`)
  assert.ok(joined.includes('🐳 Thought'), 're-expansion must work after Collapse All')
  app.setFullscreen(false)
  app.stop()
})

/** A settled turn whose LAST process row is a reasoning-only assistant
 * message (NO text block): the image pipeline keeps it as a zero-height
 * entry, so the Thought's boundary spacer visually follows the tool card
 * — the interior test must follow the VISUAL sequence, never a
 * zero-height entry (round-2 review finding). */
function reasoningTailTurn(seqBase: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } }, T0 + 2, seqBase + 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'x' }) }, T0 + 3, seqBase + 3),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, T0 + 4, seqBase + 4),
    // The reasoning-only assistant message: zero rendered rows.
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('e1'), role: 'assistant',
        content: [{ type: 'reasoning', text: 'only reasoning' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 5, seqBase + 5),
    eventAt('assistant/message', {
      turn: 1, step: 2,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 6, seqBase + 6),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 7, seqBase + 7),
  ]
}

test('a zero-height trailing process row must not turn the boundary spacer into an interior blank (round-2 P1)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(reasoningTailTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  app.toggleFocusTurn(1)
  await vt.waitForRender()
  let view = vt.getViewport()
  assert.ok(view.join('\n').includes('🐳 Thought'), 'precondition: root expanded')
  // The reasoning-only row renders NOTHING: the blank directly above the
  // final is the Thought's BOUNDARY spacer (the final follows visually) —
  // clicking it must be a no-op, never a collapse.
  const doneY = findRow(view, 'Done.')
  assert.ok(doneY >= 0, `final missing:\n${view.join('\n')}`)
  assert.equal(view[doneY - 1].trim(), '', 'precondition: the clicked row is blank')
  click(vt, 3, doneY)
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()], [1], 'the boundary spacer must stay a no-op')
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('🐳 Thought'), `the Thought must stay expanded:\n${after}`)
  app.setFullscreen(false)
  app.stop()
})

test('a Thought with NO process cards: the header trailing spacer stays a no-op', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, T0 + 1, 1),
    eventAt('assistant/message', { turn: 1, step: 0, message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'hi back' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, T0 + 2, 2),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 3, 3),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  app.toggleFocusTurn(1)
  await vt.waitForRender()
  const view = vt.getViewport()
  const headerY = findRow(view, '🐳 Thought')
  assert.ok(headerY >= 0, `expanded header missing:\n${view.join('\n')}`)
  // No process rows follow the header: its trailing spacer is the
  // boundary before the final — a no-op, never a collapse.
  assert.equal(view[headerY + 1].trim(), '', 'precondition: the row below the header is blank')
  click(vt, 3, headerY + 2)
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()], [1], 'the no-card Thought blank must be a no-op')
  app.setFullscreen(false)
  app.stop()
})

test('the boundary spacer between two adjacent Thoughts is a no-op', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  folder.apply(settledThoughtTurn(2, 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand turn 1 only.
  let y = findRow(vt.getViewport(), '🐋 Thought')
  assert.ok(y >= 0, `first Thought header missing:\n${vt.getViewport().join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  const view = vt.getViewport()
  assert.deepEqual([...app.focusExpandedTurnsForTest()].sort(), [1], 'precondition: only turn 1 expanded')
  // The blank above turn 2's header belongs to turn 1's LAST row (the
  // final, unmarked): clicking it must never collapse turn 1 — and must
  // never touch turn 2 (its header row is not the click target).
  const t2y = findRow(view, '🐋 Thought')
  assert.ok(t2y >= 0, `turn-2 header missing:\n${view.join('\n')}`)
  assert.equal(view[t2y - 1].trim(), '', 'precondition: the clicked row is blank')
  click(vt, 3, t2y)
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()].sort(), [1], 'the boundary blank must not collapse the neighbor')
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('🐳 Thought'), `turn 1 must stay expanded:\n${after}`)
  app.setFullscreen(false)
  app.stop()
})

test('the collapsed header block trailing spacer stays a no-op — never expands (plan §13/§16)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply(settledThoughtTurn(1, 0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const view = vt.getViewport()
  // The collapsed block = header + preview rows; the blank BELOW the last
  // preview row is its trailing spacer — a no-op (the Thought is not
  // expanded, so nothing collapses; it must not toggle-open either).
  const toolY = findRow(view, 'Tool:')
  assert.ok(toolY >= 0, `collapsed preview missing:\n${view.join('\n')}`)
  assert.equal(view[toolY + 1].trim(), '', 'precondition: the clicked row is blank')
  click(vt, 3, toolY + 2)
  await vt.waitForRender()
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'the collapsed block blank must not expand the Thought')
  const after = vt.getViewport().join('\n')
  assert.ok(!after.includes('🐳'), `no expansion may happen:\n${after}`)
  app.setFullscreen(false)
  app.stop()
})

test('Ctrl+O with a PARKED expansion on a windowed-away root still expands the visible recent roots (round-4 P1)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  for (let turn = 1; turn <= 5; turn += 1) folder.apply(settledThoughtTurn(turn, turn * 100))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand turn 1 by API — the viewport only shows the most recent
  // collapsed headers, so clicking would hit the wrong turn.
  app.toggleFocusTurn(1)
  await vt.waitForRender()
  assert.deepEqual([...app.focusExpandedTurnsForTest()].sort(), [1], 'precondition: turn 1 expanded')
  // Window turn 1 away: its expansion stays PARKED in the disclosure set
  // while the projection no longer shows it.
  app.setTranscript(windowMessages(folder.messages(), 2), folder.turnActivities())
  await vt.waitForRender()
  // Ctrl+O with NOTHING expanded IN VIEW: expand the visible recent
  // roots — the parked turn-1 root must not force Collapse All.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  const expanded = [...app.focusExpandedTurnsForTest()].sort((a, b) => a - b)
  assert.ok(expanded.includes(4) && expanded.includes(5),
    `Ctrl+O must expand the visible recent roots (got ${JSON.stringify(expanded)})`)
  app.setFullscreen(false)
  app.stop()
})

test('local shell cards stay folded in fullscreen Focus even with the Ctrl+O master on (round-4 P1)', async () => {
  const vt = new VirtualTerminal(100, 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const long = Array.from({ length: 30 }, (_, i) => `shell line ${i}`).join('\n')
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: long, status: 'ok',
  })
  // Regular: Ctrl+O turns the shell master ON and the card expands.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.isToolOutputExpanded(), true, 'precondition: master ON')
  assert.ok(vt.getViewport().join('\n').includes('shell line 0'), 'precondition: the card is expanded in regular')
  // Switch to fullscreen Focus: Ctrl+O owns the Thought roots there, so
  // the shell card keeps its folded state (the documented contract).
  app.setFocusMode(true)
  app.setFullscreen(true)
  await vt.waitForRender()
  let joined = vt.getViewport().join('\n')
  assert.ok(!joined.includes('shell line 0'), `the shell card must be folded in fullscreen Focus:\n${joined}`)
  assert.ok(joined.includes('shell line 29'), `the folded tail must still show:\n${joined}`)
  // The MOUSE can still full-reveal it (the per-card override wins).
  const shellY = findRow(vt.getViewport(), 'ls -la')
  assert.ok(shellY >= 0, `shell card row missing:\n${joined}`)
  click(vt, 10, shellY + 1)
  await vt.waitForRender()
  joined = vt.getViewport().join('\n')
  assert.ok(joined.includes('shell line 0'), `a mouse click must full-reveal the shell card:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})
