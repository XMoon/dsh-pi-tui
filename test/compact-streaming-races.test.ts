/**
 * PR4/F4 hardening: deterministic streaming / Preparing ownership races.
 *
 * One live Preparing call belongs to the turn's still-open trailing Process
 * run only while that run is open; once a Conversation / Context / Attention /
 * turn boundary closes it, the call belongs to an EPHEMERAL pending Process
 * run that must never move backward — and, having no canonical WorkSpan, it
 * fails open as an ordinary live Preparing row (never a fake `▸ Activity`
 * disclosure). No race may duplicate the call, leave a ghost row, or leak an
 * owner across a session / preset / surface switch.
 * @module @xmoon76/dsh-pi-tui/compact-streaming-races.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StreamingToolPreview } from '../src/tui-app.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(preset: DisplayState['preset'] = 'compact'): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** Fold a durable completed turn with a single tool call/result pair. */
function durableToolTurn(turn: number, callId: string, name = 'bash'): TranscriptMessage[] {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn }, 1000, 0)])
  folder.apply([eventAt('assistant/chunk', { turn, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: `reasoning ${turn}` } }, 1001, 1)])
  folder.apply([eventAt('tool/call', { turn, step: 0, callId: ToolCallId(callId), name, arguments: '{"command":"pnpm test"}' }, 1002, 2)])
  folder.apply([eventAt('tool/result', {
    turn, step: 0,
    message: {
      id: MessageId(`r-${callId}`), role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, 1003, 3)])
  return folder.messages()
}

function preview(callId: string, overrides: Partial<StreamingToolPreview> = {}): StreamingToolPreview {
  return { callId, argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'pnpm test', ...overrides }
}

const preparingRows = (view: string): number[] =>
  view.split('\n').flatMap((line, index) => line.includes('Preparing') ? [index] : [])

const workHeaders = (view: string): string[] =>
  view.split('\n').filter(line => /^\s*(?:▸|▾) Activity(?: | ·|$)/.test(line))

// --- S5: Preparing becomes durable ----------------------------------------

test('S5: a durable Process row replaces the ephemeral preview without duplication', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'thinking', turn: 1, text: 'reasoning 1' }], new Map(), undefined, [preview('p1')])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view).length, 1, `one trailing Work span owns the call:\n${view}`)
  assert.equal(preparingRows(view).length, 1, `the ephemeral call renders once:\n${view}`)

  // The durable call + result land: the ephemeral evidence must disappear and
  // the durable Work span owns the finalized Tool row exactly once.
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'reasoning 1' },
    { kind: 'tool', turn: 1, name: 'bash', args: '{"command":"pnpm test"}', result: 'ok', status: 'ok' },
  ], new Map(), undefined, [])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 0, `the ephemeral evidence is gone:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `one durable Work span remains:\n${view}`)
  const toolRows = view.split('\n').filter(line => /Action:\s/.test(line))
  assert.equal(toolRows.length, 1, `exactly one Tool row, never a duplicate:\n${view}`)
  assert.ok(!toolRows[0]!.includes('Preparing'), 'the durable row owns the slot')
})

// --- S6: Preparing disappears / cancels -----------------------------------

test('S6: a cancelled preview leaves no ghost row and no fake pending Activity', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'closed run' },
    { kind: 'assistant', turn: 1, text: 'boundary' },
  ], new Map(), undefined, [preview('p-cancel')])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `precondition: the pending Preparing row is visible:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `the old durable Activity header renders alone:\n${view}`)

  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'closed run' },
    { kind: 'assistant', turn: 1, text: 'boundary' },
  ], new Map(), undefined, [])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 0, `the ghost call is gone:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `only the durable closed run remains:\n${view}`)
})

// --- S7: multiple Preparing calls -----------------------------------------

test('S7: multiple ownerless previews fail open as one full Preparing row each', async () => {
  const { vt, app } = startApp()
  // Deliberately UNORDERED input: the rendered rows must follow the
  // streamingToolPreviewsForTurn() ordering (index, then step, then callId),
  // never the raw arrival order.
  const previews = [
    preview('p-c', { index: 2, name: 'read', summary: 'src/c.ts' }),
    preview('p-a', { index: 0, name: 'read', summary: 'src/a.ts' }),
    preview('p-b', { index: 1, name: 'bash', summary: 'pnpm test' }),
  ]
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'boundary' }], new Map(), undefined, previews)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // No durable WorkSpan exists, so the pending run owns NO Activity header and
  // NO collapsed Tool slot: every live preview renders as its own full
  // fail-open row, in the stable streamingToolPreviewsForTurn() order.
  assert.equal(workHeaders(view).length, 0, `an ownerless pending run never mints an Activity header:\n${view}`)
  const rows = view.split('\n').filter(line => line.includes('Preparing'))
  assert.equal(rows.length, 3, `three previews render three full rows, never an aggregated card:\n${view}`)
  assert.ok(rows[0]!.includes('src/a.ts'), `row 0 is the index-0 preview despite arrival order:\n${view}`)
  assert.ok(rows[1]!.includes('pnpm test'), `row 1 is the index-1 preview despite arrival order:\n${view}`)
  assert.ok(rows[2]!.includes('src/c.ts'), `row 2 is the index-2 preview despite arrival order:\n${view}`)
  assert.ok(!rows.some(row => /\+\d/.test(row)), `no first-row +N aggregation summary:\n${view}`)

  // One settles while the others remain: only the still-live full rows stay.
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'boundary' }], new Map(), undefined, [previews[1]!])
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.equal(workHeaders(after).length, 0, `no ghost Activity header after a partial settle:\n${after}`)
  const afterRows = after.split('\n').filter(line => line.includes('Preparing'))
  assert.equal(afterRows.length, 1, `only the still-live preview row remains:\n${after}`)
  assert.ok(afterRows[0]!.includes('src/a.ts'), `the surviving row is the still-live preview:\n${after}`)
})

// --- S8: turn boundary ----------------------------------------------------

test('S8: no Preparing owner leaks from turn N to turn N+1', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'turn one reasoning' },
    { kind: 'assistant', turn: 1, text: 'turn one answer' },
    { kind: 'user', turn: 2, text: 'turn two prompt' },
  ], new Map(), undefined, [preview('p-t2', { turn: 2, summary: 'turn two call' })])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const turnTwoPrompt = view.split('\n').findIndex(line => line.includes('turn two prompt'))
  assert.ok(turnTwoPrompt >= 0, `the turn 2 prompt renders:\n${view}`)
  assert.equal(preparingRows(view).length, 1, `exactly one call:\n${view}`)
  assert.ok(preparingRows(view)[0]! > turnTwoPrompt,
    `the turn 2 call must not attach to the closed turn 1 run:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `the closed turn 1 durable Activity renders alone:\n${view}`)
})

// --- S9: session switch ---------------------------------------------------

test('S9: a session switch drops the stale pending Preparing row and all owner state', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'session A run' },
    { kind: 'assistant', turn: 1, text: 'session A boundary' },
  ], new Map(), undefined, [preview('p-session-a')])
  await vt.waitForRender()
  assert.equal(preparingRows(vt.getViewport().join('\n')).length, 1, 'precondition: session A pending Preparing row is visible')
  assert.equal(app.expandedWorkOwnersForTest().size, 0)

  // A different session's transcript arrives with no live preview.
  app.setTranscript([{ kind: 'user', turn: 1, text: 'session B prompt' }], new Map(), undefined, [])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('session A'), 'no stale session A row survives')
  assert.equal(preparingRows(view).length, 0, 'no stale pending Preparing row survives the session switch')
  assert.equal(workHeaders(view).length, 0, 'no stale Work owner survives')
  assert.equal(app.expandedWorkOwnersForTest().size, 0)
  assert.equal(app.expandedContextClusterOwnersForTest().size, 0)
})

// --- S10: preset / surface switch -----------------------------------------

test('S10: preset and surface switches during Preparing keep one source of truth', async () => {
  const { vt, app } = startApp()
  const messages: TranscriptMessage[] = [
    { kind: 'thinking', turn: 1, text: 'run reasoning' },
    { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'ok', status: 'ok' },
  ]
  app.setTranscript(messages, new Map(), undefined, [preview('p-switch', { summary: 'switch call' })])
  await vt.waitForRender()
  assert.equal(preparingRows(vt.getViewport().join('\n')).length, 1)

  for (const preset of ['focus', 'full', 'compact'] as const) {
    app.setDisplayPreset(preset)
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(preparingRows(view).length <= 1, `preset ${preset}: the call is never duplicated:\n${view}`)
  }
  let view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `returning to Compact reconstructs exactly one call:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `one Work span:\n${view}`)
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'no stale Work owner from the preset switching')

  app.setFullscreen(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(preparingRows(view).length <= 1, `fullscreen never duplicates the call:\n${view}`)
  app.setFullscreen(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `regular Compact reconstructs one call:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `regular Compact keeps one Work span:\n${view}`)
})

test('S10b: preset and surface switches during an OWNERLESS pending run keep one source of truth', async () => {
  const { vt, app } = startApp()
  // A boundary closes the run, so the preview is an ownerless pending-run:
  // across every preset/surface switch there is exactly ONE live Preparing
  // evidence, never a second (pending) Activity header, never a stale
  // Action slot, and no disclosure owner is ever minted (plan §5.1 S10).
  const messages: TranscriptMessage[] = [
    { kind: 'thinking', turn: 1, text: 'closed reasoning' },
    { kind: 'assistant', turn: 1, text: 'boundary' },
  ]
  app.setTranscript(messages, new Map(), undefined, [preview('p-switch-ownerless', { summary: 'switch call' })])
  await vt.waitForRender()
  assert.equal(preparingRows(vt.getViewport().join('\n')).length, 1, 'precondition: the fail-open row is visible')

  for (const preset of ['focus', 'full', 'compact'] as const) {
    app.setDisplayPreset(preset)
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(preparingRows(view).length <= 1, `preset ${preset}: the call is never duplicated:\n${view}`)
    assert.ok(workHeaders(view).length <= 1,
      `preset ${preset}: at most the DURABLE closed Activity — a pending run never mints one:\n${view}`)
    assert.ok(!/Action:\s+Preparing/.test(view), `preset ${preset}: no stale pending Action slot:\n${view}`)
    assert.equal(app.expandedWorkOwnersForTest().size, 0, `preset ${preset}: no disclosure owner is minted`)
  }
  // (focus projects no Thought root for a turn without TurnActivity records,
  // so its row count stays 0 there; compact/full show the one fail-open row.)
  let view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `returning to Compact reconstructs exactly one call:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `compact keeps exactly the durable closed Activity:\n${view}`)

  app.setFullscreen(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `fullscreen keeps exactly one ordinary Preparing row:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `fullscreen mints no pending Activity:\n${view}`)
  assert.ok(!/Action:\s+Preparing/.test(view), `fullscreen shows no stale pending Action slot:\n${view}`)
  app.setFullscreen(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `regular Compact reconstructs one call:\n${view}`)
  assert.equal(workHeaders(view).length, 1, `regular Compact keeps the one durable Activity:\n${view}`)
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'no disclosure owner was ever minted')
})

// --- expanded run insertion -----------------------------------------------

test('an expanded trailing run renders the live call once and keeps raw member order', async () => {
  const { vt, app } = startApp()
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'expanded reasoning' }
  app.setTranscript([
    owner,
    { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'ok', status: 'ok' },
  ], new Map(), undefined, [preview('p-expanded')])
  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view).length, 1, `one expanded Work span:\n${view}`)
  assert.equal(preparingRows(view).length, 1, `the live call renders once:\n${view}`)
  assert.ok(!view.includes('Action:  Preparing'), 'an expanded span renders the standalone preview, not a Tool slot')

  // Collapsing returns to the Tool-slot presentation with no residue.
  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  const collapsed = vt.getViewport().join('\n')
  assert.equal(preparingRows(collapsed).length, 1, `the collapsed Tool slot owns the call once:\n${collapsed}`)
})

test('durableToolTurn fixture folds a tool row for the expanded-run path', () => {
  const messages = durableToolTurn(1, 'c1')
  assert.ok(messages.some(message => message.kind === 'tool'), 'the fixture yields a durable tool row')
})

// --- ownerless pending-run has no disclosure affordance ---------------------

/** SGR click on one viewport cell (the fork converts to 0-based). */
function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

test('an ownerless pending-run preview renders no Activity affordance and mints no Work owner', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'boundary' }], new Map(), undefined, [preview('p-ownerless')])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `the Preparing row is visible:\n${view}`)
  assert.equal(workHeaders(view).length, 0, `no Activity header is minted for the pending run:\n${view}`)
  assert.ok(!view.includes('Action:'), `no pseudo Action summary without an Activity owner:\n${view}`)
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'no Work disclosure owner exists')

  // Fullscreen mouse: clicking the fail-open row must neither crash nor
  // toggle any container — it is an ordinary row, not an Activity header.
  app.setFullscreen(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  const rows = preparingRows(view)
  assert.equal(rows.length, 1, `the fail-open row survives the fullscreen switch:\n${view}`)
  assert.equal(workHeaders(view).length, 0, `fullscreen keeps the pending run free of Activity chrome:\n${view}`)
  click(vt, 5, rows[0]! + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'a click on the fail-open row mints no Work owner')
  assert.equal(workHeaders(view).length, 0, `the click triggers no pseudo disclosure toggle:\n${view}`)
  assert.equal(preparingRows(view).length, 1, `the ordinary row presentation is unchanged:\n${view}`)
})

// --- trailing real WorkSpan keeps real Activity presentation ----------------

test('a live Preparing of an open trailing WorkSpan keeps the real Activity disclosure', async () => {
  const { vt, app } = startApp()
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'trailing reasoning' }
  app.setTranscript([
    owner,
    { kind: 'tool', turn: 1, name: 'bash', args: '{}', result: 'ok', status: 'ok' },
  ], new Map(), undefined, [preview('p-trail')])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view).length, 1, `exactly one real Activity:\n${view}`)
  assert.match(view, /Action:\s+Preparing/, `the live call still owns the Activity preview slot:\n${view}`)

  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view).length, 1, `expanding keeps the one real Activity:\n${view}`)
  assert.equal(preparingRows(view).length, 1, `the live call renders as a full row after the durable members:\n${view}`)
  assert.ok(!/Action:\s+Preparing/.test(view),
    `an expanded span renders the standalone preview, not a Tool slot:\n${view}`)
  assert.ok(app.expandedWorkOwnersForTest().has(owner), 'the expanded owner is the canonical span owner')
})

// --- Surfaced-interaction boundary closes the trailing run ----------------

/** A live turn: user, read tool, then a SETTLED surfaced-interaction card.
 * The durable projection is `Work(read) | interaction`, so the interaction is
 * a Work boundary and a following Preparing call must start a NEW run. */
function interactionTurn(name: 'ask_user_question' | 'exit_plan_mode'): {
  folder: TranscriptFolder
  interactionMarker: string
} {
  const folder = new TranscriptFolder()
  const args = name === 'ask_user_question'
    ? JSON.stringify({ questions: [{ id: 'q', question: 'Go?' }] })
    : JSON.stringify({ plan: '# Plan' })
  const result = name === 'ask_user_question'
    ? JSON.stringify({ answers: [{ id: 'q', selected: ['y'] }] })
    : 'PLAN_APPROVED_MARKER'
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, 1001, 1),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, 1002, 2),
    eventAt('tool/result', { turn: 1, step: 0, message: { id: MessageId('r1'), role: 'tool', toolCallId: ToolCallId('c1'),
    content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('c1') } } }, 1003, 3),
    eventAt('tool/call', { turn: 1, step: 1, callId: ToolCallId('q1'), name, arguments: args }, 1004, 4),
    eventAt('tool/result', { turn: 1, step: 1, message: { id: MessageId('qr1'), role: 'tool', toolCallId: ToolCallId('q1'),
    content: [{ type: 'text', text: result }], source: { kind: 'tool', callId: ToolCallId('q1') } } }, 1005, 5),
  ] as SessionEvent[])
  return { folder, interactionMarker: name === 'ask_user_question' ? '1/1 answered' : 'PLAN_APPROVED_MARKER' }
}

for (const name of ['ask_user_question', 'exit_plan_mode'] as const) {
  test(`a settled ${name} closes the trailing run: Preparing starts a NEW fail-open run, never the prior span`, async () => {
    const { folder, interactionMarker } = interactionTurn(name)
    const previews = [preview('pB', { step: 2, summary: 'bash B' })]

    // Compact collapsed: the durable projection is Work(read) | interaction, so
    // the live call is a NEW ownerless run AFTER the interaction — never the
    // previous span's Tool slot, and never a second fake Activity header.
    {
      const { vt, app } = startApp('compact')
      app.setTranscript(folder.messages(), folder.turnActivities(), undefined, previews)
      await vt.waitForRender()
      const view = vt.getViewport().join('\n')
      assert.equal(workHeaders(view).length, 1, `only Work(read) renders an Activity; the pending run fails open:\n${view}`)
      assert.equal(preparingRows(view).length, 1, `the pending run renders one fail-open Preparing row:\n${view}`)
      const interactionRow = view.split('\n').findIndex(line => line.includes(interactionMarker))
      assert.ok(interactionRow >= 0, `the settled interaction renders:\n${view}`)
      assert.ok(preparingRows(view).every(row => row > interactionRow),
        `the live call follows the interaction, never the prior span:\n${view}`)
      app.dispose()
      startedApps.delete(app)
    }

    // Compact expanded: the preview must also follow the interaction, not be
    // spliced back into the previous span's members.
    {
      const { vt, app } = startApp('compact')
      app.setTranscript(folder.messages(), folder.turnActivities(), undefined, previews)
      const owner = folder.messages().find(message => message.kind === 'thinking' || (message.kind === 'tool' && message.name === 'read'))
      assert.ok(owner !== undefined)
      app.toggleWorkSpan(owner)
      await vt.waitForRender()
      const view = vt.getViewport().join('\n')
      const interactionRow = view.split('\n').findIndex(line => line.includes(interactionMarker))
      assert.ok(interactionRow >= 0, `the settled interaction renders:\n${view}`)
      assert.ok(preparingRows(view).every(row => row > interactionRow),
        `the expanded prior span never absorbs the call past the interaction:\n${view}`)
      app.dispose()
      startedApps.delete(app)
    }

    // Focus expanded: the temporary preview lands at the process tail, after
    // the persistent interaction fence.
    {
      const { vt, app } = startApp('focus')
      app.setTranscript(folder.messages(), folder.turnActivities(), undefined, previews)
      app.expandFocusTurn(1)
      await vt.waitForRender()
      const view = vt.getViewport().join('\n')
      const interactionRow = view.split('\n').findIndex(line => line.includes(interactionMarker))
      assert.ok(interactionRow >= 0, `the settled interaction renders in expanded Focus:\n${view}`)
      assert.ok(preparingRows(view).every(row => row > interactionRow),
        `expanded Focus keeps raw chronology: the call follows the interaction:\n${view}`)
      app.dispose()
      startedApps.delete(app)
    }
  })
}

test('a trailing ambient cluster is a durable fence: the live call follows it in expanded Focus', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, 1001, 1),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, 1002, 2),
    eventAt('tool/result', { turn: 1, step: 0, message: { id: MessageId('r1'), role: 'tool', toolCallId: ToolCallId('c1'),
    content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: ToolCallId('c1') } } }, 1003, 3),
    eventAt('user/message', { id: MessageId('ctx-a'), role: 'user', content: [{ type: 'text', text: 'ambient A body' }], source: { kind: 'plugin', form: 'instructions', plugin: 'agent-instructions' } }, 1004, 4),
    eventAt('user/message', { id: MessageId('ctx-b'), role: 'user', content: [{ type: 'text', text: 'ambient B body' }], source: { kind: 'plugin', form: 'catalog', plugin: 'skill-catalog' } }, 1005, 5),
  ] as SessionEvent[])
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset: 'focus' } })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  app.setTranscript(folder.messages(), folder.turnActivities(), undefined, [preview('pC', { step: 2, summary: 'bash C' })])
  app.expandFocusTurn(1)
  await vt.waitForRender()
  const view = vt.getViewport()
  const clusterRow = view.findIndex(line => /Context · 2 injections/.test(line))
  assert.ok(clusterRow >= 0, `the fullscreen ambient cluster renders:\n${view.join('\n')}`)
  const rows = preparingRows(view.join('\n'))
  assert.equal(rows.length, 1, `exactly one live call:\n${view.join('\n')}`)
  assert.ok(rows[0]! > clusterRow, `the live call follows the trailing cluster:\n${view.join('\n')}`)
})
