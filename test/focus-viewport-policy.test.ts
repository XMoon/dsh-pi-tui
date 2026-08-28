/**
 * Fullscreen + Focus viewport policy (plan 2026-08-25, the expanded
 * viewport fix): expanding a Thought must NOT steal the user's historical
 * viewport. The rule is scroll-intent + running-ness — never "expanded →
 * scrollToEnd()".
 *
 *   - click a SETTLED Thought → preserve the current scrollTop, disable
 *     follow-end (a completed Thought has no live output to chase);
 *   - click a RUNNING Thought while the user is already following the end
 *     → keep following (live-progress view);
 *   - click a RUNNING Thought while the user has scrolled into history
 *     → preserve the viewport (scroll intent wins);
 *   - Ctrl+O Expand Recent → follow-end ONLY when the user was following
 *     the end AND the expanded set contains a running Thought; every other
 *     case preserves the viewport.
 *
 * Collapse (single header, blank row) keeps its PR #29 anchor behavior;
 * search owns its own jump; Regular is untouched.
 *
 * Failing-on-main expectation: the SETTLED-click and history Ctrl+O tests
 * (plan §21.1/§21.2/§21.4/§21.6/§21.7) are the discriminators — pre-fix
 * they all end at maxScrollTop with follow-end ON.
 * @module @xmoon76/dsh-pi-tui/focus-viewport-policy.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(columns = 100, rows = 30): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

const T0 = Date.now() - 60_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

function show(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities())
}

function findRow(view: readonly string[], needle: string): number {
  return view.findIndex(line => line.includes(needle))
}

/** The LAST row (viewport y) containing `needle` — the newest projected
 * turn's Thought header sits at the transcript bottom, so when the target
 * is the LATEST block findRow alone may hit an older visible one. */
function findLastRow(view: readonly string[], needle: string): number {
  let last = -1
  for (let i = 0; i < view.length; i += 1) {
    if (view[i]!.includes(needle)) last = i
  }
  return last
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

/** A COMPLETED turn with reasoning + a bash tool whose result is LONG
 * (120 rendered rows): expanding the root meaningfully grows the content
 * height, so the preserve-vs-follow discriminator is real. */
function settledTurn(turn: number, seqBase: number): SessionEvent[] {
  const lines = Array.from({ length: 120 }, (_, i) => `result ${turn} line ${i}`).join('\n')
  return [
    eventAt('turn/start', { turn }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId(`u${turn}`), role: 'user',
      content: [{ type: 'text', text: `prompt ${turn}` }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: `reason ${turn} A\nreason ${turn} B` } }, T0 + 2, seqBase + 2),
    eventAt('tool/call', { turn, step: 0, callId: ToolCallId(`c${turn}`), name: 'bash', arguments: JSON.stringify({ command: `cmd ${turn}` }) }, T0 + 3, seqBase + 3),
    eventAt('tool/result', {
      turn, step: 0,
      message: {
        id: MessageId(`r${turn}`), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId(`c${turn}`), content: [{ type: 'text', text: lines }] }],
        source: { kind: 'tool', callId: ToolCallId(`c${turn}`) },
      },
    }, T0 + 4, seqBase + 4),
    eventAt('assistant/message', {
      turn, step: 1,
      message: {
        id: MessageId(`a${turn}`), role: 'assistant',
        content: [{ type: 'text', text: `done ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 5, seqBase + 5),
    eventAt('turn/end', { turn, reason: { kind: 'completed' } }, T0 + 6, seqBase + 6),
  ]
}

/** The FIRST events of a turn, left RUNNING (no turn/end yet). */
function runningTurnStart(turn: number, seqBase: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn }, T0, seqBase),
    eventAt('user/message', {
      id: MessageId(`u${turn}`), role: 'user',
      content: [{ type: 'text', text: `prompt ${turn}` }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: `reason ${turn} A` } }, T0 + 2, seqBase + 2),
    eventAt('tool/call', { turn, step: 0, callId: ToolCallId(`c${turn}`), name: 'bash', arguments: JSON.stringify({ command: `cmd ${turn}` }) }, T0 + 3, seqBase + 3),
  ]
}

/** Build a fullscreen+Focus app whose transcript holds the given turns. */
async function fullscreenFocusApp(
  turns: Array<{ events: SessionEvent[]; running?: boolean }>,
): Promise<{ vt: VirtualTerminal; app: TuiApp }> {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  for (const turn of turns) folder.apply(turn.events)
  app.setFocusMode(true)
  if (turns.some(turn => turn.running)) app.setWorking(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  return { vt, app }
}

// --- 21.1: a SETTLED Thought click must preserve the historical viewport
// (the discriminator — pre-fix scrollTop lands on maxScrollTop) ---

test('settled Thought expansion preserves the historical viewport (plan §21.1)', async () => {
  // ENOUGH settled turns that one PageUp from the bottom lands strictly
  // INSIDE the transcript (a page ≈ viewport height 25; total scroll ≥ 50).
  const turns = [1, 2, 3, 4, 5, 6, 7, 8].map(turn => ({ events: settledTurn(turn, turn * 100) }))
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    // Start at the bottom (following), then PageUp into history: the real
    // user gesture that LEAVES follow-end at a NONZERO mid position.
    app.scrollToBottom()
    await vt.waitForRender()
    const bottom = app.fullscreenScrollForTest()
    assert.ok(bottom !== undefined && bottom.maxScrollTop > 30, 'precondition: the transcript overflows')
    vt.sendInput('\x1b[5~') // PageUp (legacy) — alt screen pages up
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined, 'fullscreen scroll must exist')
    assert.ok(before.scrollTop > 0 && before.scrollTop < before.maxScrollTop,
      `precondition: nonzero historical position (${before.scrollTop} of ${before.maxScrollTop})`)
    assert.equal(before.isFollowingEnd, false, 'precondition: not following the end')
    // A settled Thought header is visible in the current band.
    const view = vt.getViewport()
    const headerY = findRow(view, '🐋 Thought')
    assert.ok(headerY >= 0, `Thought header missing:\n${view.join('\n')}`)
    click(vt, 3, headerY + 1)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.scrollTop, before.scrollTop, 'settled Thought expansion preserves scrollTop')
    assert.equal(after.isFollowingEnd, false, 'settled Thought expansion must disable follow-end')
    assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'the root must actually expand')
  } finally {
    app.stop()
  }
})

// --- 21.2: the settled rule holds even when the user was at the bottom ---

test('a settled Thought keeps the viewport even while at the bottom (plan §21.2)', async () => {
  const turns = [1, 2, 3, 4].map(turn => ({ events: settledTurn(turn, turn * 100) }))
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    app.scrollToBottom()
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    assert.equal(before.isFollowingEnd, true, 'precondition: following the end')
    assert.equal(before.scrollTop, before.maxScrollTop, 'precondition: at the bottom')
    // The newest settled turn's header is visible at the bottom (the LAST
    // projected Thought header).
    const view = vt.getViewport()
    const headerY = findLastRow(view, '🐋 Thought')
    assert.ok(headerY >= 0, `Thought header missing:\n${view.join('\n')}`)
    click(vt, 3, headerY + 1)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.isFollowingEnd, false, 'a completed Thought must disable follow even when the user was following')
    // The pre-click bottom scrollTop is preserved verbatim (a taller
    // content may raise maxScrollTop; the position only clamps DOWN, never
    // re-aims at the new bottom — plan §12).
    assert.equal(after.scrollTop, before.scrollTop, 'the preserved scrollTop equals the pre-click value')
    assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'the root must expand')
  } finally {
    app.stop()
  }
})

// --- 21.3: running + following the end keeps following (a REGRESSION
// guard — pre-fix AND post-fix both pass) ---

test('running Thought + user following the end keeps following (plan §21.3)', async () => {
  const turns = [
    { events: settledTurn(1, 100) },
    { events: settledTurn(2, 200) },
    { events: settledTurn(3, 300) },
    { events: runningTurnStart(4, 400), running: true },
  ]
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    app.scrollToBottom()
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    assert.equal(before.isFollowingEnd, true, 'precondition: following the end')
    // The running Thought (turn 4) is the LAST projected block: its header
    // is the LAST '🐋 Thought' in the viewport.
    const view = vt.getViewport()
    const headerY = findLastRow(view, '🐋 Thought')
    assert.ok(headerY >= 0, `running Thought header missing:\n${view.join('\n')}`)
    assert.ok(view.join('\n').includes('prompt 4'), `the running turn must be the visible one:\n${view.join('\n')}`)
    click(vt, 3, headerY + 1)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.isFollowingEnd, true, 'running + following must keep following')
    assert.equal(after.scrollTop, after.maxScrollTop, 'the viewport must sit at the end')
    assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'the running root must expand')
    // A new event streams in: the viewport must keep chasing the tail.
    const folder = new TranscriptFolder()
    for (let turn = 1; turn <= 3; turn += 1) folder.apply(settledTurn(turn, turn * 100))
    folder.apply(runningTurnStart(4, 400))
    folder.apply([
      eventAt('tool/result', {
        turn: 4, step: 0,
        message: {
          id: MessageId('r4'), role: 'user',
          content: [{ type: 'tool-result', toolCallId: ToolCallId('c4'), content: [{ type: 'text', text: 'fresh output line' }] }],
          source: { kind: 'tool', callId: ToolCallId('c4') },
        },
      }, T0 + 44000, 900),
    ])
    show(app, folder)
    await vt.waitForRender()
    const final = app.fullscreenScrollForTest()
    assert.ok(final !== undefined)
    assert.equal(final.isFollowingEnd, true, 'the viewport must keep following live output')
    assert.equal(final.scrollTop, final.maxScrollTop, 'the viewport stays at the new end')
  } finally {
    app.stop()
  }
})

// --- 21.4: running BUT the user scrolled into history → preserve (the
// key discriminator: scroll intent wins over running-ness). The running
// turn is the EARLIEST so its header sits at the top after scrollToTop. ---

test('running Thought + user scrolled into history preserves the viewport (plan §21.4)', async () => {
  const turns = [
    { events: runningTurnStart(1, 100), running: true },
    { events: settledTurn(2, 200) },
    { events: settledTurn(3, 300) },
    { events: settledTurn(4, 400) },
  ]
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    app.scrollToTop()
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    assert.equal(before.isFollowingEnd, false, 'precondition: scrolled away from the end')
    // The running Thought (turn 1) is the FIRST projected block.
    const view = vt.getViewport()
    const headerY = findRow(view, '🐋 Thought')
    assert.ok(headerY >= 0, `running Thought header missing:\n${view.join('\n')}`)
    assert.ok(view.join('\n').includes('prompt 1'), `the running turn must be the visible one:\n${view.join('\n')}`)
    click(vt, 3, headerY + 1)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.isFollowingEnd, false, 'running + scrolled-up must NOT follow')
    assert.equal(after.scrollTop, before.scrollTop, 'running + scrolled-up must preserve scrollTop')
    assert.ok(vt.getViewport().join('\n').includes('🐳 Thought'), 'the running root must expand')
  } finally {
    app.stop()
  }
})

// --- Ctrl+O Expand Recent (plan §14/§15) ---

/** Ctrl+O — fullscreen Focus root bulk toggle. */
function ctrlO(vt: VirtualTerminal): void {
  vt.sendInput('\x0f')
}

test('Ctrl+O Expand Recent follows the end when following + a recent root runs (plan §21.5)', async () => {
  const turns = [
    { events: settledTurn(1, 100) },
    { events: settledTurn(2, 200) },
    { events: settledTurn(3, 300) },
    { events: settledTurn(4, 400) },
    { events: runningTurnStart(5, 500), running: true },
  ]
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    app.scrollToBottom()
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    assert.equal(before.isFollowingEnd, true, 'precondition: following the end')
    ctrlO(vt)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.isFollowingEnd, true, 'Ctrl+O must keep following (recent contains running)')
    assert.equal(after.scrollTop, after.maxScrollTop, 'the viewport stays at the end')
    const expanded = [...app.focusExpandedTurnsForTest()].sort((a, b) => a - b)
    assert.deepEqual(expanded, [3, 4, 5], 'Ctrl+O must expand the recent roots')
  } finally {
    app.stop()
  }
})

test('Ctrl+O at a historical position never jumps to the tail — even with a running root (plan §21.6)', async () => {
  // ENOUGH settled turns that one PageUp from the bottom lands strictly
  // INSIDE the transcript (a page ≈ viewport height 25; total scroll ≥ 50).
  const turns = [
    { events: settledTurn(1, 100) },
    { events: settledTurn(2, 200) },
    { events: settledTurn(3, 300) },
    { events: settledTurn(4, 400) },
    { events: settledTurn(5, 500) },
    { events: settledTurn(6, 600) },
    { events: settledTurn(7, 700) },
    { events: runningTurnStart(8, 800), running: true },
  ]
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    // Start at the bottom (following), then PageUp into history: the real
    // user gesture that LEAVES follow-end.
    app.scrollToBottom()
    await vt.waitForRender()
    const bottom = app.fullscreenScrollForTest()
    assert.ok(bottom !== undefined && bottom.maxScrollTop > 30, 'precondition: the transcript overflows')
    vt.sendInput('\x1b[5~') // PageUp (legacy) — alt screen pages up
    await vt.waitForRender()
    // Move to a NONZERO historical position strictly below the end: the
    // strongest proof that Ctrl+O does not relocate.
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    assert.equal(before.isFollowingEnd, false, 'precondition: scrolled into history')
    assert.ok(before.scrollTop > 0 && before.scrollTop < before.maxScrollTop,
      `precondition: nonzero historical position (${before.scrollTop} of ${before.maxScrollTop})`)
    ctrlO(vt)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.isFollowingEnd, false, 'Ctrl+O must not steal the historical position')
    assert.equal(after.scrollTop, before.scrollTop, 'Ctrl+O must preserve scrollTop in history')
    const expanded = [...app.focusExpandedTurnsForTest()].sort((a, b) => a - b)
    assert.deepEqual(expanded, [6, 7, 8], 'Ctrl+O must still expand the recent roots')
  } finally {
    app.stop()
  }
})

test('Ctrl+O with all-completed recent roots preserves even while at the bottom (plan §21.7)', async () => {
  const turns = [1, 2, 3, 4, 5].map(turn => ({ events: settledTurn(turn, turn * 100) }))
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    app.scrollToBottom()
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    assert.equal(before.isFollowingEnd, true, 'precondition: following the end')
    ctrlO(vt)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.isFollowingEnd, false, 'all-completed recent roots must disable follow-end')
    // The pre-Ctrl+O bottom scrollTop is preserved verbatim (a taller
    // content may raise maxScrollTop; the position only clamps DOWN, never
    // re-aims at the new bottom — plan §12).
    assert.equal(after.scrollTop, before.scrollTop, 'the preserved scrollTop equals the pre-Ctrl+O value')
    const expanded = [...app.focusExpandedTurnsForTest()].sort((a, b) => a - b)
    assert.deepEqual(expanded, [3, 4, 5], 'Ctrl+O must still expand the recent roots')
  } finally {
    app.stop()
  }
})

// --- unknown activity (§4.3): a turn whose TurnActivity is missing from
// `turnActivities` cannot be judged running — the expansion must NEVER steal
// the viewport (preserve + disable follow). Guarded because `toggleFocusTurn`
// is public and hosts (or a stale snapshot) can reach it for such a turn. ---

test('an unknown-activity Thought expansion preserves the viewport (plan §4.3)', async () => {
  const turns = [1, 2, 3, 4, 5, 6, 7, 8].map(turn => ({ events: settledTurn(turn, turn * 100) }))
  const { vt, app } = await fullscreenFocusApp(turns)
  try {
    app.scrollToBottom()
    await vt.waitForRender()
    const bottom = app.fullscreenScrollForTest()
    assert.ok(bottom !== undefined && bottom.maxScrollTop > 30, 'precondition: the transcript overflows')
    vt.sendInput('\x1b[5~') // PageUp: leave follow-end at a nonzero mid position
    await vt.waitForRender()
    const before = app.fullscreenScrollForTest()
    assert.ok(before !== undefined)
    assert.equal(before.isFollowingEnd, false, 'precondition: not following the end')
    assert.ok(before.scrollTop > 0, 'precondition: at a nonzero position')
    assert.equal(app.focusExpandedTurnsForTest().size, 0, 'precondition: nothing expanded')
    // Turn 9 has NO TurnActivity in the folder — an unknown activity state.
    app.toggleFocusTurn(9)
    await vt.waitForRender()
    const after = app.fullscreenScrollForTest()
    assert.ok(after !== undefined)
    assert.equal(after.scrollTop, before.scrollTop, 'unknown activity must preserve scrollTop')
    assert.equal(after.isFollowingEnd, false, 'unknown activity must stay follow-end disabled')
  } finally {
    app.stop()
  }
})