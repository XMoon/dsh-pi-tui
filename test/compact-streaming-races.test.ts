/**
 * PR4/F4 hardening: deterministic streaming / Preparing ownership races.
 *
 * One live Preparing call belongs to the turn's still-open trailing Process
 * run only while that run is open; once a Conversation / Context / Attention /
 * turn boundary closes it, the call becomes an EPHEMERAL pending Work that
 * must never move backward. No race may duplicate the call, leave a ghost
 * card, or leak an owner across a session / preset / surface switch.
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
      id: MessageId(`r-${callId}`), role: 'user',
      content: [{ type: 'tool-result', toolCallId: ToolCallId(callId), content: [{ type: 'text', text: 'ok' }] }],
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
  view.split('\n').filter(line => /^\s*(?:▸|▾) Work(?: ·|$)/.test(line))

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
  const toolRows = view.split('\n').filter(line => /Tool:\s/.test(line))
  assert.equal(toolRows.length, 1, `exactly one Tool row, never a duplicate:\n${view}`)
  assert.ok(!toolRows[0]!.includes('Preparing'), 'the durable row owns the slot')
})

// --- S6: Preparing disappears / cancels -----------------------------------

test('S6: a cancelled preview leaves no pending Work card and no ghost row', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'closed run' },
    { kind: 'assistant', turn: 1, text: 'boundary' },
  ], new Map(), undefined, [preview('p-cancel')])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(preparingRows(view).length, 1, `precondition: the pending Work is visible:\n${view}`)
  assert.equal(workHeaders(view).length, 2, `precondition: the boundary minted a pending Work:\n${view}`)

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

test('S7: multiple previews stay deterministic and never duplicate the pending Work root', async () => {
  const { vt, app } = startApp()
  const previews = [
    preview('p-a', { index: 0, name: 'read', summary: 'src/a.ts' }),
    preview('p-b', { index: 1, name: 'bash', summary: 'pnpm test' }),
    preview('p-c', { index: 2, name: 'read', summary: 'src/c.ts' }),
  ]
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'boundary' }], new Map(), undefined, previews)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // ONE pending Work root; the collapsed Tool slot names the deterministic
  // latest meaningful preview, never one row per call.
  assert.equal(workHeaders(view).length, 1, `exactly one pending Work root:\n${view}`)
  const toolRows = view.split('\n').filter(line => /Tool:\s/.test(line))
  assert.equal(toolRows.length, 1, `the collapsed slot is one row:\n${view}`)
  assert.ok(!view.includes('Preparing Bash'), 'the collapsed slot names the deterministic first known preview')
  assert.match(view, /Preparing Read \+2/)

  // One settles while another remains: still ONE pending root, no residue.
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'boundary' }], new Map(), undefined, [previews[0]!])
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.equal(workHeaders(after).length, 1, `one pending Work after a partial settle:\n${after}`)
  assert.match(after, /Preparing Read/)
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
  assert.equal(workHeaders(view).length, 2, `the closed turn 1 Work and the pending Work stay distinct:\n${view}`)
})

// --- S9: session switch ---------------------------------------------------

test('S9: a session switch drops the stale pending Work and its owner state', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'session A run' },
    { kind: 'assistant', turn: 1, text: 'session A boundary' },
  ], new Map(), undefined, [preview('p-session-a')])
  await vt.waitForRender()
  assert.equal(preparingRows(vt.getViewport().join('\n')).length, 1, 'precondition: session A pending Work is visible')
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0)

  // A different session's transcript arrives with no live preview.
  app.setTranscript([{ kind: 'user', turn: 1, text: 'session B prompt' }], new Map(), undefined, [])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('session A'), 'no stale session A row survives')
  assert.equal(preparingRows(view).length, 0, 'no stale pending Work survives the session switch')
  assert.equal(workHeaders(view).length, 0, 'no stale Work owner survives')
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0)
  assert.equal(app.compactExpandedClustersForTest().size, 0)
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
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, 'no stale Work owner from the preset switching')

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
  assert.ok(!view.includes('Tool:    Preparing'), 'an expanded span renders the standalone preview, not a Tool slot')

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
