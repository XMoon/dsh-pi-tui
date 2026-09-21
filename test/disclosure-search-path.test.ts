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
import type { TurnActivity, TranscriptMessage } from '../src/transcript.ts'
import { windowMessages } from '../src/transcript.ts'
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
  assert.ok(view.join('\n').includes('▾ Work'), `precondition: the Work is open:\n${view.join('\n')}`)
  const toolY = view.findIndex(line => line.includes('Read'))
  assert.ok(toolY > 0, `precondition: the Work member row is visible:\n${view.join('\n')}`)
  assert.ok(isBlankRow(view[toolY - 1]!), `the clicked row must be an internal blank spacer:\n${view.join('\n')}`)
  click(vt, 3, toolY)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'the internal spacer collapses the owning Work')
  assert.ok(view.join('\n').includes('▸ Work'), `the Work collapses to its header:\n${view.join('\n')}`)
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
  assert.ok(revealed.includes('▾ Work'), `the nested Work must be revealed:\n${revealed}`)
  assert.ok(revealed.includes('Read'), `the matched Work member must render:\n${revealed}`)

  // Ordinary dismiss preserves the current reveal: BOTH necessary ancestors are
  // promoted atomically (the root and its nested Work).
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  const promoted = await viewport(vt)
  assert.equal(app.focusExpandedTurnsForTest().has(1), true, 'the root is promoted')
  assert.equal(app.expandedWorkOwnersForTest().has(owner), true, 'the nested Work is promoted too')
  assert.ok(promoted.includes('▾ Work'), `the promoted Work stays open:\n${promoted}`)
})

test('an explicit Work collapse under search revokes the temporary reveal', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, owner, tool } = fixture()
  app.setTranscript(messages, activities)
  app.setFullscreen(true)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  assert.ok((await viewport(vt)).includes('▾ Work'), 'precondition: the reveal opens the Work')
  assert.equal(app.expandedWorkOwnersForTest().size, 0)

  app.toggleWorkSpan(owner)
  const collapsed = await viewport(vt)
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'a reveal-only Work collapse writes no manual owner')
  assert.ok(!collapsed.includes('▾ Work'), `the collapsed Work stays collapsed (no instant reopen):\n${collapsed}`)
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
  assert.ok((await viewport(vt)).includes('▾ Work'), 'precondition: the Work is manually open')
  // The target lives INSIDE the Work, but the reveal path omits an already-open
  // Work — the explicit collapse must still revoke the grant by ancestry.
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  await viewport(vt)
  app.toggleWorkSpan(owner)
  const collapsed = await viewport(vt)
  assert.equal(app.expandedWorkOwnersForTest().size, 0)
  assert.ok(!collapsed.includes('▾ Work'), `the manual-open Work must stay collapsed under search:\n${collapsed}`)
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
  assert.ok((await viewport(vt)).includes('▾ Work'), 'precondition: search temporarily opened the collapsed Work')
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), false, 'Ctrl+O must collapse/revoke, not turn the master on')
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'the reveal-only Work writes no manual owner')
  assert.ok(!(await viewport(vt)).includes('▾ Work'), 'the search-only Work collapses and its reveal is revoked')
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
  assert.ok(!revealed.includes('▸ Work'), `no collapsed Work header may render without an operable action:\n${revealed}`)
  assert.ok(!revealed.includes('▾ Work'), `no Work container may render without an operable action:\n${revealed}`)
  assert.ok(revealed.includes('Read'), `the nested Work members must fail open flat:\n${revealed}`)
})

test('the reveal path re-evaluates open state after a master toggle (no stale memo)', async () => {
  const { vt, app } = startApp('focus')
  const { messages, activities, tool } = fixture()
  app.setTranscript(messages, activities)
  app.setTranscriptDetailExpanded(true)
  await viewport(vt)
  app.setTranscriptSearchTarget(targetFor(tool, 'READ_RESULT_MARKER'))
  assert.ok((await viewport(vt)).includes('▾ Work'), 'precondition: the derived master opened the recent Work')

  // Turning the master OFF re-hides the Work, so the still-granted reveal must
  // now open it — the memoized ancestry must not be served a stale open state.
  app.setTranscriptDetailExpanded(false)
  const stillRevealed = await viewport(vt)
  assert.ok(stillRevealed.includes('▾ Work'), `the granted reveal must open the now-hidden Work:\n${stillRevealed}`)
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
  assert.ok(!view.includes('▸ Work') && !view.includes('▾ Work'), `no Work chrome may render on a fail-open surface:\n${view}`)
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

test('regular Focus Ctrl+O keeps toggling after a search dismiss promotes a manual root and Work', async () => {
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

  // Press 1 collapses the master-owned Work (the manual root keeps its own full
  // reveal); press 2 must turn the master ON instead of wedging on the
  // root-derived Work that the master cannot close.
  vt.sendInput('\x0f')
  await viewport(vt)
  vt.sendInput('\x0f')
  await viewport(vt)
  assert.equal(app.isTranscriptDetailExpanded(), true,
    'Ctrl+O must not wedge when a manual Focus root keeps its Work open')
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
