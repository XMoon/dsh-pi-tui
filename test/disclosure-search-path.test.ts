/**
 * PR6/F6 UI regressions for the container reveal path and nested Work
 * ownership: a collapsed Focus Thought + nested Work must both reveal
 * temporarily for search, an ordinary dismiss promotes exactly the nodes that
 * were hidden, an explicit collapse revokes the temporary reveal, and an
 * explicit root collapse returns the turn's nested Work to the compact default.
 * @module @xmoon76/dsh-pi-tui/disclosure-search-path.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TurnActivity, TranscriptMessage } from '../src/transcript.ts'
import { TranscriptFolder, windowMessages } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(preset: DisplayState['preset'] = 'focus'): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

function activity(turn: number): TurnActivity {
  return {
    turn,
    startedAt: 1000,
    endedAt: 6000,
    completed: true,
    reason: { kind: 'completed' },
    think: { text: 'work reasoning', running: false },
    tool: { callId: 'tool-1', name: 'read', args: '{}', status: 'ok' },
    tools: new Map([['read', 1]]),
    toolCalls: 1,
    assistantMessages: 1,
    revision: 0,
  }
}

function fixture(): { messages: TranscriptMessage[]; activities: Map<number, TurnActivity>; owner: TranscriptMessage; tool: TranscriptMessage } {
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'work reasoning' }
  const tool: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'READ_RESULT_MARKER', status: 'ok' }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 1, text: 'go' },
    owner,
    tool,
    { kind: 'assistant', turn: 1, text: 'final answer' },
  ]
  return { messages, activities: new Map([[1, activity(1)]]), owner, tool }
}

function targetFor(message: TranscriptMessage, query: string) {
  return {
    query,
    match: { id: 0, turn: 'turn' in message ? message.turn : 0, occurrence: 0, source: { kind: 'message' as const }, sourceOccurrence: 0 },
    message,
  }
}

/** A search target whose semantic source is one delivered file (so the reveal
 * necessity can be judged against the folded limit). */
function deliverableTarget(message: TranscriptMessage, query: string, index: number) {
  return {
    query,
    match: {
      id: 0,
      turn: 'turn' in message ? message.turn : 0,
      occurrence: 0,
      source: { kind: 'assistant-deliverable' as const, index, field: 'path' as const },
      sourceOccurrence: 0,
    },
    message,
  }
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

function isBlankRow(line: string): boolean {
  return line.replace(/[│┃█]$/, '').trim() === ''
}

test('an expanded Compact Work internal spacer collapses that Work (F6 blank-row parity)', async () => {
  const { vt, app } = startApp('compact')
  const { messages, activities, owner } = fixture()
  app.setTranscript(messages, activities)
  app.setFullscreen(true)
  await viewport(vt)
  app.toggleWorkSpan(owner)
  await viewport(vt)
  let view = vt.getViewport()
  assert.ok(view.join('\n').includes('▾ Activity'), `precondition: the Work is open:\n${view.join('\n')}`)
  const toolY = view.findIndex(line => line.includes('Read'))
  assert.ok(toolY > 0, `precondition: the Work member row is visible:\n${view.join('\n')}`)
  assert.ok(isBlankRow(view[toolY - 1]!), `the clicked row must be an internal blank spacer:\n${view.join('\n')}`)
  click(vt, 3, toolY)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'the internal spacer collapses the owning Work')
  assert.ok(view.join('\n').includes('▸ Activity'), `the Work collapses to its header:\n${view.join('\n')}`)
})

test('a collapsed fullscreen Focus reveals root + nested Work temporarily for search', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, owner, tool } = fixture()
  app.setTranscript(messages, activities)
  app.setFullscreen(true)
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'precondition: the root is collapsed')
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'precondition: the Work is collapsed')

  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  const revealed = await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'the root reveal stays temporary (no manual state)')
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'the nested Work reveal stays temporary')
  assert.ok(revealed.includes('▾ Activity'), `the nested Work must be revealed:\n${revealed}`)
  assert.ok(revealed.includes('Read'), `the matched Work member must render:\n${revealed}`)

  // Ordinary dismiss preserves the current reveal: BOTH necessary ancestors are
  // promoted atomically (the root and its nested Work).
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  const promoted = await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().has(1), true, 'the root is promoted')
  assert.equal(app.expandedWorkOwnersForTest().has(owner), true, 'the nested Work is promoted too')
  assert.ok(promoted.includes('▾ Activity'), `the promoted Work stays open:\n${promoted}`)
})

test('an explicit Work collapse under search revokes the temporary reveal', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, owner, tool } = fixture()
  app.setTranscript(messages, activities)
  app.setFullscreen(true)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  assert.ok((await viewport(vt)).includes('▾ Activity'), 'precondition: the reveal opens the Work')
  assert.equal(app.expandedWorkOwnersForTest().size, 0)

  app.toggleWorkSpan(owner)
  const collapsed = await viewport(vt)
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'a reveal-only Work collapse writes no manual owner')
  assert.ok(!collapsed.includes('▾ Activity'), `the collapsed Work stays collapsed (no instant reopen):\n${collapsed}`)
})

test('a manual-open Work collapses under an active search without reopening', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, owner, tool } = fixture()
  app.setTranscript(messages, activities)
  app.setFullscreen(true)
  await viewport(vt)
  app.toggleFocusTurn(1)
  await viewport(vt)
  app.toggleWorkSpan(owner)
  assert.ok((await viewport(vt)).includes('▾ Activity'), 'precondition: the Work is manually open')
  // The target lives INSIDE the Work, but the reveal path omits an already-open
  // Work — the explicit collapse must still revoke the grant by ancestry.
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  await viewport(vt)
  app.toggleWorkSpan(owner)
  const collapsed = await viewport(vt)
  assert.equal(app.expandedWorkOwnersForTest().size, 0)
  assert.ok(!collapsed.includes('▾ Activity'), `the manual-open Work must stay collapsed under search:\n${collapsed}`)
})

test('a manual-open cluster collapses under an active search without reopening', async () => {
  const { vt, app } = startApp('compact')
  const first: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'instructions body', label: 'AGENTS.md', context: true,
    contextPresentation: { form: 'instructions', sourceKind: 'agent-instructions', role: 'inject' },
  }
  const second: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'CLUSTER_MEMBER_MARKER', label: 'skill-catalog', context: true,
    contextPresentation: { form: 'catalog', sourceKind: 'plugin', role: 'inject' },
  }
  app.setTranscript([first, second], new Map())
  await viewport(vt)
  app.toggleContextCluster(first)
  assert.ok((await viewport(vt)).includes('▾'), 'precondition: the cluster is manually open')
  app.setTranscriptSearchTarget(targetFor(second, 'CLUSTER_MEMBER_MARKER'))
  await viewport(vt)
  app.toggleContextCluster(first)
  const collapsed = await viewport(vt)
  assert.equal(app.expandedContextClusterOwnersForTest().size, 0)
  assert.ok(!collapsed.includes('▾'), `the manual-open cluster must stay collapsed under search:\n${collapsed}`)
})

test('regular Ctrl+O collapses a search-only-open Work instead of turning the master on', async () => {
  const { vt, app } = startApp('compact')
  const { messages, activities, tool } = fixture()
  app.setTranscript(messages, activities)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  assert.ok((await viewport(vt)).includes('▾ Activity'), 'precondition: search temporarily opened the collapsed Work')
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'Ctrl+O must collapse/revoke, not turn the master on')
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'the reveal-only Work writes no manual owner')
  assert.ok(!(await viewport(vt)).includes('▾ Activity'), 'the search-only Work collapses and its reveal is revoked')
})

test('a Work owner parked behind a collapsed Focus root does not consume the first Ctrl+O', async () => {
  const { vt, app } = startApp('compact')
  const { messages, activities, owner } = fixture()
  app.setTranscript(messages, activities)
  await viewport(vt)
  app.toggleWorkSpan(owner)
  await viewport(vt)
  assert.equal(app.expandedWorkOwnersForTest().has(owner), true, 'precondition: the Compact Work is manually open')
  app.setDisplayPreset('focus')
  await viewport(vt)
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true,
    'the first Ctrl+O must expand the recent Thought, not clear an invisible owner')
})

test('a windowed-away per-card override does not consume the current Ctrl+O', async () => {
  const { vt, app } = startApp('focus')
  const tool1: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'r1', status: 'ok' }
  const tool2: TranscriptMessage = { kind: 'tool', turn: 2, name: 'read', args: '{}', result: 'r2', status: 'ok' }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 1, text: 'go1' }, tool1, { kind: 'assistant', turn: 1, text: 'f1' },
    { kind: 'user', turn: 2, text: 'go2' }, tool2, { kind: 'assistant', turn: 2, text: 'f2' },
  ]
  const activities = new Map([[1, activity(1)], [2, activity(2)]])
  app.setTranscript(messages, activities)
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  overrides.set(tool1, true)
  app.setTranscript(windowMessages(messages, 1), activities)
  await viewport(vt)
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true, 'the windowed-away override must not consume the press')
  assert.equal(overrides.get(tool1), true, 'the parked override is preserved (manual state may survive a window)')
})

test('an explicit Focus root collapse returns its nested Work to the compact default', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, owner } = fixture()
  app.setTranscript(messages, activities)
  app.setFullscreen(true)
  await viewport(vt)
  app.toggleFocusTurn(1)
  await viewport(vt)
  app.toggleWorkSpan(owner)
  await viewport(vt)
  assert.equal(app.expandedWorkOwnersForTest().has(owner), true, 'precondition: the nested Work is manually open')

  // The explicit root collapse is the "reopen compact" contract.
  app.toggleFocusTurn(1)
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'the root is collapsed')
  assert.equal(app.expandedWorkOwnersForTest().has(owner), false, 'the nested Work manual state is cleared')

  // Reopening the root starts at Compact depth.
  app.toggleFocusTurn(1)
  const reopened = await viewport(vt)
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'reopening must not resurrect the old Work expansion')
  assert.ok(!reopened.includes('READ_RESULT_MARKER'), `the nested Work starts collapsed:\n${reopened}`)
})

test('a regular Focus with the disclosure action disabled fails the nested Work open (no dead header)', async () => {
  const { vt, app } = startApp('focus')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  const { messages, activities, tool } = fixture()
  app.setTranscript(messages, activities)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  const revealed = await viewport(vt)
  assert.ok(!revealed.includes('▸ Activity'), `no collapsed Work header may render without an operable action:\n${revealed}`)
  assert.ok(!revealed.includes('▾ Activity'), `no Work container may render without an operable action:\n${revealed}`)
  assert.ok(revealed.includes('Read'), `the nested Work members must fail open flat:\n${revealed}`)
})

test('the reveal path re-evaluates open state after a master toggle (no stale memo)', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, tool } = fixture()
  app.setTranscript(messages, activities)
  app.setTranscriptDetailExpanded(true)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  assert.ok((await viewport(vt)).includes('▾ Activity'), 'precondition: the derived master opened the recent Work')

  // Turning the master OFF re-hides the Work, so the still-granted reveal must
  // now open it — the memoized ancestry must not be served a stale open state.
  app.setTranscriptDetailExpanded(false)
  const stillRevealed = await viewport(vt)
  assert.ok(stillRevealed.includes('▾ Activity'), `the granted reveal must open the now-hidden Work:\n${stillRevealed}`)
})

test('a regular Ctrl+O never clears a settled surfaced-interaction card override', async () => {
  const { vt, app } = startApp('focus')
  const interaction: TranscriptMessage = {
    kind: 'tool', turn: 1, name: 'ask_user_question', args: '{}', result: 'ok', status: 'ok',
  }
  app.setTranscript(
    [{ kind: 'user', turn: 1, text: 'go' }, interaction, { kind: 'assistant', turn: 1, text: 'final' }],
    new Map([[1, activity(1)]]),
  )
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  overrides.set(interaction, true)
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(overrides.get(interaction), true,
    'the settled surfaced-interaction card is independent of the regular transcript-detail master')
})

test('a fail-open regular surface renders a live call without Work chrome', async () => {
  const { vt, app } = startApp('focus')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  const { messages, activities } = fixture()
  app.setTranscript(messages, activities, undefined, [
    { callId: 'p1', turn: 1, step: 0, index: 0, name: 'edit', argumentBytes: 0 },
  ])
  app.expandFocusTurn(1)
  const view = await viewport(vt)
  assert.ok(!view.includes('▸ Activity') && !view.includes('▾ Activity'), `no Work chrome may render on a fail-open surface:\n${view}`)
  assert.ok(view.includes('Preparing Edit'), `the live call renders as an ordinary preview:\n${view}`)
})

test('a visible collapsed-Focus compaction override is collapsed by the first Ctrl+O', async () => {
  const { vt, app } = startApp('focus')
  const compaction: TranscriptMessage = { kind: 'compaction', turn: 1, text: 'COMPACTION_BODY_MARKER', items: 3, tokens: 10 }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 1, text: 'go' }, compaction, { kind: 'assistant', turn: 1, text: 'final' },
  ]
  const activities = new Map([[1, activity(1)]])
  app.setTranscript(messages, activities)
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  overrides.set(compaction, true)
  app.setTranscript(messages, activities)
  assert.ok((await viewport(vt)).includes('COMPACTION_BODY_MARKER'),
    'precondition: the compaction override is visible while the root is collapsed')
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the visible compaction override must be collapsed by the first press')
  assert.notEqual(overrides.get(compaction), true, 'the materialized override is cleared')
})

test('a hidden mid-turn notice override does not consume the first Ctrl+O', async () => {
  const { vt, app } = startApp('focus')
  const notice: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'NOTICE_BODY_MARKER', label: 'Background job', context: true,
    contextPresentation: { form: 'notice', sourceKind: 'tool-jobs', role: 'inject' },
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 1, text: 'go' },
    { kind: 'thinking', turn: 1, text: 'work reasoning' },
    { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'r', status: 'ok' },
    notice,
    { kind: 'assistant', turn: 1, text: 'final' },
  ]
  const activities = new Map([[1, activity(1)]])
  app.setTranscript(messages, activities)
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  overrides.set(notice, true)
  app.setTranscript(messages, activities)
  assert.ok(!(await viewport(vt)).includes('NOTICE_BODY_MARKER'),
    'precondition: collapsed Focus hides the mid-turn notice')
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true, 'the hidden notice override must not consume the first press')
  assert.equal(overrides.get(notice), true, 'the parked notice override is preserved')
})

test('regular Focus Ctrl+O ignores a redundant Work owner covered by a manual root', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, owner, tool } = fixture()
  app.setTranscript(messages, activities)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().has(1), true, 'precondition: the dismiss promoted the root')
  assert.equal(app.expandedWorkOwnersForTest().has(owner), true, 'precondition: the dismiss promoted the Work')

  // The manual root already full-reveals the Work, so the manual Work owner is
  // redundant: the FIRST press must turn the master ON (removing the latent
  // owner changes nothing on screen), never a two-step no-op cleanup.
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true,
    'a redundant descendant owner must not consume the first Ctrl+O')
})

test('a parked cluster-member override behind a collapsed cluster does not consume Ctrl+O', async () => {
  const { vt, app } = startApp('compact')
  const first: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'instructions body', label: 'AGENTS.md', context: true,
    contextPresentation: { form: 'instructions', sourceKind: 'agent-instructions', role: 'inject' },
  }
  const second: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'CLUSTER_MEMBER_MARKER', label: 'skill-catalog', context: true,
    contextPresentation: { form: 'catalog', sourceKind: 'plugin', role: 'inject' },
  }
  app.setTranscript([first, second], new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(second, 'CLUSTER_MEMBER_MARKER'))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  assert.equal(app.expandedContextClusterOwnersForTest().has(first), true, 'precondition: the dismiss promoted the cluster')
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  assert.equal(overrides.get(second), true, 'precondition: the dismiss promoted the member override')

  app.toggleContextCluster(first)
  await viewport(vt)
  assert.equal(app.expandedContextClusterOwnersForTest().size, 0, 'precondition: the cluster is explicitly collapsed')
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true, 'the parked member override must not consume the first press')
  assert.equal(overrides.get(second), true, 'the parked override is preserved (manual state survives)')
})

test('a visible local shell card override is collapsed by the first regular Ctrl+O', async () => {
  const { vt, app } = startApp('compact')
  const long = Array.from({ length: 30 }, (_, index) => `shell line ${index}`).join('\n')
  const card = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell', args: 'ls -la', result: long, status: 'ok',
  })
  await viewport(vt)
  // Simulate a fullscreen click-expand that survives the return to regular.
  ;(app as unknown as { toggleMessageExpanded(message: TranscriptMessage): void }).toggleMessageExpanded(card)
  const expanded = await viewport(vt)
  assert.ok(expanded.includes('shell line 0'), 'precondition: the local shell card is expanded')
  assert.equal(app.isTranscriptDetailExpanded(), false, 'precondition: the master is off')

  vt.sendInput('\x0f')
  const collapsed = await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the visible local card must be collapsed by the first press')
  assert.ok(!collapsed.includes('shell line 0'), `the local card folds:\n${collapsed}`)
})

function deliveredFilesTurn(): { messages: TranscriptMessage[]; assistant: TranscriptMessage } {
  const deliverables = Array.from({ length: 5 }, (_, index) => ({
    path: `src/file-${index + 1}.ts`,
    description: `file ${index + 1}`,
  }))
  const assistant: TranscriptMessage = { kind: 'assistant', turn: 1, text: 'done', deliverables }
  return { messages: [{ kind: 'user', turn: 1, text: 'go' }, assistant], assistant }
}

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** A real folded settled turn (so the final assistant is selected and emitted
 * by the collapsed Focus projection) carrying five delivered files. */
function settledTurnFixture(): {
  messages: TranscriptMessage[]
  activities: ReadonlyMap<number, TurnActivity>
  user: TranscriptMessage
  assistant: TranscriptMessage
} {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1000, 0),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'USER_PROMPT_MARKER' }],
      source: { kind: 'user' },
    }, 1001, 1),
    eventAt('assistant/chunk', {
      turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning' },
    }, 1002, 2),
    eventAt('tool/call', {
      turn: 1, step: 0, callId: ToolCallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'x' }),
    }, 1003, 3),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'PROCESS_RESULT_MARKER' }] }],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
    }, 1004, 4),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'FINAL_ANSWER_MARKER' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, 1005, 5),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1006, 6),
  ])
  const messages = folder.messages()
  const user = messages.find(message => message.kind === 'user')
  const assistant = messages.find(message => message.kind === 'assistant')
  assert.ok(user !== undefined && assistant !== undefined && assistant.kind === 'assistant', 'fixture: folded turn')
  ;(assistant as Extract<TranscriptMessage, { kind: 'assistant' }>).deliverables = Array.from({ length: 5 }, (_, index) => ({
    path: `src/file-${index + 1}.ts`,
    description: `file ${index + 1}`,
  }))
  return { messages, activities: folder.turnActivities(), user, assistant }
}

test('a search-revealed delivered-files tail is collapsed by the first regular Ctrl+O', async () => {
  const { vt, app } = startApp('compact')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  assert.ok((await viewport(vt)).includes('src/file-5.ts'), 'precondition: the reveal expands the capped tail')
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the reveal-only tail must be collapsed, not turn the master on')
  assert.ok(!(await viewport(vt)).includes('src/file-5.ts'), 'the collapsed tail hides file 5 again')
})

test('an ordinary dismiss promotes the delivered-files disclosure on a master-owned surface', async () => {
  const { vt, app } = startApp('compact')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  const promoted = await viewport(vt)
  assert.ok(promoted.includes('src/file-5.ts'), `the promoted tail stays expanded:\n${promoted}`)
})

test('fullscreen Focus fails delivered files open instead of inheriting the regular master', async () => {
  const { vt, app } = startApp('focus')
  const { messages } = deliveredFilesTurn()
  app.setTranscript(messages, new Map([[1, activity(1)]]))
  app.setTranscriptDetailExpanded(true)
  assert.ok((await viewport(vt)).includes('src/file-5.ts'), 'precondition: the regular master expands the tail')

  app.setFocusMode(true)
  app.setFullscreen(true)
  app.expandFocusTurn(1)
  const fullscreen = await viewport(vt)
  assert.ok(fullscreen.includes('src/file-5.ts'),
    `fullscreen Focus has no delivered-files owner, so the tail must fail open:\n${fullscreen}`)
})

test('a regular Focus manual root does not wedge Ctrl+O on a delivered-files reveal', async () => {
  const { vt, app } = startApp('focus')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map([[1, activity(1)]]))
  await viewport(vt)
  app.toggleFocusTurn(1)
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  assert.ok((await viewport(vt)).includes('src/file-5.ts'), 'precondition: the reveal expands the capped tail')

  vt.sendInput('\x0f')
  const afterFirst = await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'press 1 collapses the reveal-owned tail')
  assert.ok(!afterFirst.includes('src/file-5.ts'), `the reveal is revoked even with a manual root:\n${afterFirst}`)
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true, 'press 2 must turn the master on (no wedge)')
})

test('a search-revealed delivered-files tail is collapsed by the first fullscreen Full Ctrl+O', async () => {
  const { vt, app } = startApp('full')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  app.setFullscreen(true)
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  assert.ok((await viewport(vt)).includes('src/file-5.ts'), 'precondition: the reveal expands the capped tail')
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the reveal-only tail must be collapsed, not turn the master on')
  assert.ok(!(await viewport(vt)).includes('src/file-5.ts'), 'the reveal is revoked')
})

test('a promoted delivered-files override is cleared by fullscreen Full Ctrl+O', async () => {
  const { vt, app } = startApp('full')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  app.setFullscreen(true)
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  assert.equal(overrides.get(assistant), true, 'precondition: the dismiss promoted the override')
  vt.sendInput('\x0f')
  const collapsed = await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false)
  assert.notEqual(overrides.get(assistant), true, 'the promoted override is cleared')
  assert.ok(!collapsed.includes('src/file-5.ts'), `the tail collapses:\n${collapsed}`)
})

test('fullscreen Compact fails delivered files open (no operable owner)', async () => {
  const { vt, app } = startApp('compact')
  const { messages } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  app.setFullscreen(true)
  const view = await viewport(vt)
  assert.ok(view.includes('src/file-5.ts'), `delivered files have no fullscreen owner, so they must fail open:\n${view}`)
})

test('fullscreen Focus fails delivered files open (no operable owner)', async () => {
  const { vt, app } = startApp('focus')
  const { messages } = deliveredFilesTurn()
  app.setTranscript(messages, new Map([[1, activity(1)]]))
  app.setFullscreen(true)
  app.expandFocusTurn(1)
  const view = await viewport(vt)
  assert.ok(view.includes('src/file-5.ts'), `delivered files have no fullscreen owner, so they must fail open:\n${view}`)
})

test('fullscreen Full fails delivered files open when the expand key is disabled', async () => {
  const { vt, app } = startApp('full')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  const { messages } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  app.setFullscreen(true)
  const view = await viewport(vt)
  assert.ok(view.includes('src/file-5.ts'), `a disabled key leaves no owner, so the tail must fail open:\n${view}`)
})

test('a search dismiss on a fail-open card mints no override', async () => {
  const { vt, app } = startApp('compact')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  const tool: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'RESULT_MARKER', status: 'ok' }
  app.setTranscript([{ kind: 'user', turn: 1, text: 'go' }, tool], new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'RESULT_MARKER'))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  assert.notEqual(overrides.get(tool), true, 'a fail-open card hides nothing, so search must not mint an override')
})

test('searching an already-visible delivered file does not expand the tail', async () => {
  const { vt, app } = startApp('compact')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-1', 0))
  const view = await viewport(vt)
  assert.ok(view.includes('src/file-1.ts'), 'the matched visible file is present')
  assert.ok(!view.includes('src/file-5.ts'), `a visible match must not expand the hidden tail:\n${view}`)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  assert.notEqual(overrides.get(assistant), true, 'dismiss must not mint an override for an already-visible file')
})

test('a dismiss does not promote an already-expanded delivered tail', async () => {
  const { vt, app } = startApp('compact')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  app.setTranscriptDetailExpanded(true)
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('src/file-5.ts'), 'precondition: the master already expanded the tail')
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  assert.notEqual(overrides.get(assistant), true,
    'an already-expanded tail must not mint a durable override on dismiss')
  app.setTranscriptDetailExpanded(false)
  const folded = await viewport(vt)
  assert.ok(!folded.includes('src/file-5.ts'), `the tail folds with the master (no ghost owner):\n${folded}`)
})

test('a dismiss does not promote an already-expanded long user prompt', async () => {
  const { vt, app } = startApp('compact')
  const prompt = Array.from({ length: 40 }, (_, index) => `long line ${index}`).join('\n')
  const message: TranscriptMessage = { kind: 'user', turn: 1, text: prompt }
  app.setTranscript([message], new Map())
  app.setTranscriptDetailExpanded(true)
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('long line 20'), 'precondition: the master already expanded the prompt')
  app.setTranscriptSearchTarget(targetFor(message, 'long line 20'))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  assert.notEqual(overrides.get(message), true,
    'an already-expanded user prompt must not mint a durable override on dismiss')
  app.setTranscriptDetailExpanded(false)
  const folded = await viewport(vt)
  assert.ok(!folded.includes('long line 20'), `the prompt folds with the master (no ghost owner):\n${folded}`)
})

test('a cluster reveal promotes the cluster owner on an ordinary dismiss', async () => {
  const { vt, app } = startApp('compact')
  const first: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'instructions body', label: 'AGENTS.md', context: true,
    contextPresentation: { form: 'instructions', sourceKind: 'agent-instructions', role: 'inject' },
  }
  const second: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'CLUSTER_MEMBER_MARKER', label: 'skill-catalog', context: true,
    contextPresentation: { form: 'catalog', sourceKind: 'plugin', role: 'inject' },
  }
  app.setTranscript([first, second], new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(second, 'CLUSTER_MEMBER_MARKER'))
  await viewport(vt)
  assert.equal(app.expandedContextClusterOwnersForTest().size, 0, 'the reveal stays presentation-only')

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  const promoted = await viewport(vt)
  assert.equal(app.expandedContextClusterOwnersForTest().has(first), true, 'the cluster owner is promoted')
  assert.ok(promoted.includes('CLUSTER_MEMBER_MARKER'), `the promoted cluster stays open:\n${promoted}`)
})

test('a disabled Ctrl+O still reveals a matched Thinking body (Alt+T owns it)', async () => {
  const { vt, app } = startApp('compact')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  const lines = [
    'head',
    'r1', 'r2', 'r3', 'r4',
    'MID_REASONING_MARKER',
    't1', 't2', 't3', 'tail',
  ]
  const thinking: TranscriptMessage = { kind: 'thinking', turn: 1, text: lines.join('\n') }
  app.setTranscript([{ kind: 'user', turn: 1, text: 'go' }, thinking], new Map())
  await viewport(vt)
  assert.ok(!(await viewport(vt)).includes('MID_REASONING_MARKER'), 'precondition: compact Thinking hides the middle')
  app.setTranscriptSearchTarget(targetFor(thinking, 'MID_REASONING_MARKER'))
  const revealed = await viewport(vt)
  assert.ok(revealed.includes('MID_REASONING_MARKER'),
    `a disabled Ctrl+O must not block the Alt+T-owned Thinking reveal:\n${revealed}`)
  assert.equal(app.isThinkingExpanded(), false, 'the reveal is temporary, never the bulk preference')
})

test('collapsed Focus + a visible user prompt search does not open or promote the Thought', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, user } = settledTurnFixture()
  app.setTranscript(messages, activities)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(user, 'USER_PROMPT_MARKER'))
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'a visible user prompt must not open the Thought')
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'dismiss must not promote the root')
})

test('collapsed Focus + a visible final answer search does not open or promote the Thought', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, assistant } = settledTurnFixture()
  app.setTranscript(messages, activities)
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('FINAL_ANSWER_MARKER'), 'precondition: the final answer is visible')
  app.setTranscriptSearchTarget(targetFor(assistant, 'FINAL_ANSWER_MARKER'))
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'a visible final answer must not open the Thought')
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'dismiss must not promote the root')
})

test('fullscreen Focus + a fail-open delivered file search does not open or promote the Thought', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, assistant } = settledTurnFixture()
  app.setTranscript(messages, activities)
  app.setFullscreen(true)
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('src/file-5.ts'), 'precondition: the tail fails open and is visible')
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'an already-visible delivered file must not open the Thought')
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'dismiss must not promote the root')
})

test('a reveal-only compaction is collapsed and revoked by the first regular Ctrl+O', async () => {
  const { vt, app } = startApp('compact')
  const compaction: TranscriptMessage = { kind: 'compaction', turn: 1, text: 'COMPACTION_MARKER', items: 3, tokens: 10 }
  app.setTranscript([{ kind: 'user', turn: 1, text: 'go' }, compaction], new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(compaction, 'COMPACTION_MARKER'))
  assert.ok((await viewport(vt)).includes('COMPACTION_MARKER'), 'precondition: the reveal expands the compaction')
  vt.sendInput('\x0f')
  const collapsed = await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'press 1 collapses/revokes instead of turning the master on')
  assert.ok(!collapsed.includes('COMPACTION_MARKER'), `the reveal is revoked:\n${collapsed}`)
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true, 'press 2 turns the master on')
})

test('a regular surface without Alt+T fails Thinking open (no dead compact card)', async () => {
  const { vt, app } = startApp('full')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleThinking': false }))
  const thinking: TranscriptMessage = {
    kind: 'thinking', turn: 1,
    text: ['head', 'r1', 'r2', 'r3', 'MID_THINKING_MARKER', 't1', 't2', 't3', 'tail'].join('\n'),
  }
  app.setTranscript([{ kind: 'user', turn: 1, text: 'go' }, thinking], new Map())
  const view = await viewport(vt)
  assert.ok(view.includes('MID_THINKING_MARKER'), `Thinking must fail open without an operable owner:\n${view}`)
  assert.ok(!view.includes('alt+t'), `no dead Alt+T hint may render:\n${view}`)
})

test('a disabled Alt+T mints no Thinking override on search dismiss', async () => {
  const { vt, app } = startApp('compact')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleThinking': false }))
  const thinking: TranscriptMessage = {
    kind: 'thinking', turn: 1,
    text: ['head', 'r1', 'r2', 'r3', 'MID_THINKING_MARKER', 't1', 't2', 't3', 'tail'].join('\n'),
  }
  app.setTranscript([{ kind: 'user', turn: 1, text: 'go' }, thinking], new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(thinking, 'MID_THINKING_MARKER'))
  await viewport(vt)
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  assert.notEqual(overrides.get(thinking), true, 'a fail-open Thinking must not mint an override on dismiss')
})

test('an already-visible delivered file does not consume the first regular Ctrl+O', async () => {
  const { vt, app } = startApp('compact')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-1', 0))
  await viewport(vt)
  assert.ok(!(await viewport(vt)).includes('src/file-5.ts'), 'precondition: the tail stays folded')
  vt.sendInput('\x0f')
  const after = await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true, 'the first press must turn the master on')
  assert.ok(after.includes('src/file-5.ts'), `the tail expands with the master:\n${after}`)
})

test('a collapsing regular Ctrl+O revokes a hidden delivered-file reveal', async () => {
  const { vt, app } = startApp('compact')
  const { messages, assistant } = deliveredFilesTurn()
  app.setTranscript(messages, new Map())
  app.setTranscriptDetailExpanded(true)
  await viewport(vt)
  app.setTranscriptSearchTarget(deliverableTarget(assistant, 'file-5', 4))
  await viewport(vt)
  vt.sendInput('\x0f')
  const after = await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the master collapses')
  assert.ok(!after.includes('src/file-5.ts'), `the reveal is revoked so the tail stays folded:\n${after}`)
})

test('a search target already full-revealed by a manual root does not consume Ctrl+O', async () => {
  const { vt, app } = startApp('focus')
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'work reasoning' }
  const tool: TranscriptMessage = {
    kind: 'tool', turn: 1, name: 'bash', args: JSON.stringify({ command: 'x' }),
    result: 'TOOL_RESULT_MARKER', status: 'ok',
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 1, text: 'go' },
    owner,
    tool,
    { kind: 'assistant', turn: 1, text: 'final' },
  ]
  app.setTranscript(messages, new Map([[1, activity(1)]]))
  await viewport(vt)
  app.toggleFocusTurn(1)
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('TOOL_RESULT_MARKER'),
    'precondition: the manual root full-reveals the Work member')
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'precondition: no manual Work owner')
  app.setTranscriptSearchTarget(targetFor(tool, 'TOOL_RESULT_MARKER'))
  await viewport(vt)
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true,
    'an already-visible reveal target must not consume the first Ctrl+O')
})

test('collapsing a derived Focus root revokes the reveal so search cannot reopen it', async () => {
  const { vt, app } = startApp('focus')
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'work reasoning' }
  const tool: TranscriptMessage = {
    kind: 'tool', turn: 1, name: 'bash', args: JSON.stringify({ command: 'x' }),
    result: 'TOOL_RESULT_MARKER', status: 'ok',
  }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 1, text: 'go' },
    owner,
    tool,
    { kind: 'assistant', turn: 1, text: 'final' },
  ]
  app.setTranscript(messages, new Map([[1, activity(1)]]))
  app.setTranscriptDetailExpanded(true)
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('TOOL_RESULT_MARKER'), 'precondition: the derived master root opens the Work')
  assert.equal(app.focusExpandedTurnsForTest().has(1), false, 'precondition: the root is derived, not manual')

  app.setTranscriptSearchTarget(targetFor(tool, 'TOOL_RESULT_MARKER'))
  await viewport(vt)
  vt.sendInput('\x0f')
  const collapsed = await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'the master collapses')
  assert.equal(app.focusExpandedTurnsForTest().size, 0, 'the derived root was never manual state')
  assert.ok(!collapsed.includes('TOOL_RESULT_MARKER'),
    `the revoked reveal must not reopen the collapsed Thought/Work:\n${collapsed}`)
})

test('collapsed Focus + a hidden process row search still opens the Thought', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities } = settledTurnFixture()
  const tool = messages.find(message => message.kind === 'tool')
  assert.ok(tool !== undefined, 'fixture: the process tool exists')
  app.setTranscript(messages, activities)
  await viewport(vt)
  assert.ok(!(await viewport(vt)).includes('PROCESS_RESULT_MARKER'), 'precondition: collapsed Focus hides the process result')
  app.setTranscriptSearchTarget(targetFor(tool, 'PROCESS_RESULT_MARKER'))
  const revealed = await viewport(vt)
  assert.ok(revealed.includes('PROCESS_RESULT_MARKER'),
    `a genuinely hidden process row must still open its Thought:\n${revealed}`)
})

test('a standalone command card owns its own disclosure, independent of the Focus root', async () => {
  const { vt, app } = startApp('focus')
  const tool: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'r', status: 'ok' }
  const command: TranscriptMessage = { kind: 'tool', turn: 1, name: '/compact', args: '', result: 'executed', status: 'ok', origin: 'command' }
  const messages: TranscriptMessage[] = [
    { kind: 'user', turn: 1, text: 'go' },
    tool,
    command,
    { kind: 'assistant', turn: 1, text: 'f1' },
  ]
  app.setTranscript(messages, new Map([[1, activity(1)]]))
  app.setFullscreen(true)
  await viewport(vt)
  const overrides = (app as unknown as { expandedOverride: Map<TranscriptMessage, boolean> }).expandedOverride
  overrides.set(tool, true)
  overrides.set(command, true)
  // Expand the turn's Thought root, then collapse it (the explicit Collapse
  // All path resets that turn's SECONDARY expansions).
  app.toggleFocusTurn(1)
  await viewport(vt)
  app.toggleFocusTurn(1)
  await viewport(vt)
  assert.equal(overrides.get(command), true,
    'the standalone command (a turn-less boundary) keeps its own fold across the root collapse')
  assert.equal(overrides.get(tool), undefined,
    'a Thought-owned process detail is still reset by the root collapse')
})
