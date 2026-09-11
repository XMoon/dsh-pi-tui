/**
 * Headless tests for the scalable Workflow UI (PR2 plan §16.2–§16.6): the
 * adaptive renderer, the Run/Phase disclosure state machine, Focus
 * integration, direct member navigation authority, and the scoped Task
 * Viewer dataset. The pure projection combinatorics live in
 * workflow-presentation.test.ts; these tests assert structural output and
 * interaction behavior.
 * @module @xmoon76/dsh-pi-tui/workflow-ui.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp, type WorkflowAction } from '../src/tui-app.ts'
import { TranscriptFolder, type TranscriptMessage, type WorkflowMemberView, type WorkflowRunId, type WorkflowRunStatus } from '../src/transcript.ts'
import { workflowMemberViewerTarget, type TaskBrowserRow } from '../src/tasks-browser.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

function startApp(options: ConstructorParameters<typeof TuiApp>[2] = {}): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, options)
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

const member = (seq: number, label: string, phase: string | null, status: WorkflowRunStatus): WorkflowMemberView =>
  ({ seq, label, phase, childId: `child-${seq}` as never, status })

const workflow = (overrides: Partial<Extract<TranscriptMessage, { kind: 'workflow' }>> = {}): Extract<TranscriptMessage, { kind: 'workflow' }> => ({
  kind: 'workflow',
  turn: 0,
  runId: 'run-1' as WorkflowRunId,
  name: 'audit',
  status: 'running',
  members: [],
  ...overrides,
})

/** Send an SGR primary-button press+release (1-based coords) at a screen
 * row. A short delay precedes every click: the fork's terminal decodes two
 * rapid same-position clicks as a DOUBLE-CLICK (word selection), which
 * would swallow the second toggle. */
async function clickCell(vt: { sendInput: (data: string) => void }, x: number, y: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 600))
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
}

/** The 0-based viewport row of the first line containing `needle`. */
function rowOf(view: string, needle: string): number {
  const lines = view.split('\n')
  const index = lines.findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `row ${needle} missing:\n${view}`)
  return index
}

/** The disclosure chevron of the Workflow run header (the icon sits between
 * the chevron and the title, so substring matches must not assume adjacency). */
function runChevron(view: string): string {
  const line = view.split('\n').find(l => stripTerminalSequences(l).includes('Workflow audit'))
  assert.ok(line !== undefined, `workflow run header missing:\n${view}`)
  const match = stripTerminalSequences(line).match(/^[▶▼]/)
  assert.ok(match !== null && match !== undefined, `workflow run header must start with a chevron:\n${view}`)
  return match[0]
}

// ---------------------------------------------------------------------------
// Renderer: adaptive small/large phases (plan §16.2)
// ---------------------------------------------------------------------------

test('small phase renders every member inline with no View entry', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({ members: [
    member(0, 'a', 'Research', 'running'),
    member(1, 'b', 'Research', 'completed'),
    member(2, 'c', 'Research', 'completed'),
  ] })])
  const view = await viewport(vt)
  assert.ok(view.includes('▼ Research 3 agents'), `phase header missing:\n${view}`)
  assert.ok(view.includes('a — running') && view.includes('b — completed') && view.includes('c — completed'),
    `all 3 members must be inline:\n${view}`)
  assert.ok(!view.includes('View 3 agents'), `small phase must not show a View entry:\n${view}`)
})

test('5-member phase stays inline; the 6th member flips it to summary', async () => {
  const { vt, app } = startApp()
  // One running member keeps the phase open (a fully-completed phase
  // auto-closes — plan §7.6).
  app.setTranscript([workflow({ members: [
    ...Array.from({ length: 4 }, (_, i) => member(i, `m${i}`, 'P', 'completed')),
    member(4, 'm4', 'P', 'running'),
  ] })])
  let view = await viewport(vt)
  assert.ok(view.includes('m4 — running'), `5 members must all be inline:\n${view}`)
  assert.ok(!view.includes('View 5 agents'), `5-member phase must not summarize:\n${view}`)
  app.setTranscript([workflow({ members: [
    ...Array.from({ length: 5 }, (_, i) => member(i, `m${i}`, 'P', 'completed')),
    member(5, 'm5', 'P', 'running'),
  ] })])
  view = await viewport(vt)
  assert.ok(view.includes('▼ P 6 agents'), `phase header missing:\n${view}`)
  assert.ok(view.includes('View 6 agents'), `6-member phase must show the scoped entry:\n${view}`)
  assert.ok(!view.includes('m4 — completed'), `summary mode must not inline ordinary members:\n${view}`)
})

test('100-agent phase stays bounded: aggregate + capped abnormal preview only', async () => {
  const { vt, app } = startApp()
  const members: WorkflowMemberView[] = [
    ...Array.from({ length: 90 }, (_, i) => member(i, `done-${i}`, 'Migration', 'completed')),
    ...Array.from({ length: 5 }, (_, i) => member(90 + i, `run-${i}`, 'Migration', 'running')),
    member(95, 'fail-1', 'Migration', 'failed'),
    member(96, 'cancel-1', 'Migration', 'cancelled'),
    member(97, 'interrupt-1', 'Migration', 'interrupted'),
    member(98, 'fail-2', 'Migration', 'failed'),
    member(99, 'fail-3', 'Migration', 'failed'),
  ]
  app.setTranscript([workflow({ members })])
  const view = await viewport(vt)
  assert.ok(view.includes('100 agents · 5 running · 90 completed · 3 failed · 1 cancelled · 1 interrupted'),
    `run summary missing:\n${view}`)
  assert.ok(view.includes('5 running · 90 completed · 3 failed · 1 cancelled · 1 interrupted'),
    `phase counts missing:\n${view}`)
  // The preview shows exactly the first 3 abnormal in seq order — never a
  // running/completed top-N, never the 4th/5th abnormal.
  assert.ok(view.includes('fail-1') && view.includes('cancel-1') && view.includes('interrupt-1'),
    `abnormal preview missing:\n${view}`)
  assert.ok(!view.includes('fail-2') && !view.includes('fail-3'), `preview must cap at 3:\n${view}`)
  assert.ok(view.includes('2 more abnormal'), `hidden abnormal count missing:\n${view}`)
  assert.ok(!view.includes('done-0') && !view.includes('run-0'), `ordinary members must not inline:\n${view}`)
  assert.ok(view.includes('View 100 agents'), `scoped entry missing:\n${view}`)
  // Bounded: the card is ~10 rows, never 100 member rows.
  const lines = view.split('\n')
  assert.ok(lines.length < 30, `transcript must stay bounded (${lines.length} rows):\n${view}`)
})

test('null and empty phase labels render distinctly', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({ members: [
    member(0, 'a', null, 'running'),
    member(1, 'b', '', 'running'),
  ] })])
  const view = await viewport(vt)
  assert.ok(view.includes('▼ Unassigned 1 agent'), `null phase label missing:\n${view}`)
  assert.ok(view.includes('▼ Empty 1 agent'), `empty phase label missing:\n${view}`)
})

test('failed uses the error glyph; cancelled/interrupted use the warning glyph', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({ members: [
    member(0, 'f', 'P', 'failed'),
    member(1, 'c', 'P', 'cancelled'),
    member(2, 'i', 'P', 'interrupted'),
  ] })])
  const view = await viewport(vt)
  assert.ok(view.includes('✗ f'), `failed must render the error mark:\n${view}`)
  assert.ok(view.includes('! c') && view.includes('! i'), `cancelled/interrupted must render the warning mark:\n${view}`)
})

test('run-level View all appears only for multi-phase runs over the limit', async () => {
  const { vt, app } = startApp()
  // Single large phase: the phase entry covers the run — no run-level entry.
  app.setTranscript([workflow({ members: [
    ...Array.from({ length: 5 }, (_, i) => member(i, `m${i}`, 'P', 'completed')),
    member(5, 'm5', 'P', 'running'),
  ] })])
  let view = await viewport(vt)
  assert.ok(view.includes('View 6 agents'), `phase entry missing:\n${view}`)
  assert.ok(!view.includes('View all 6 agents'), `single-phase run must not repeat the entry:\n${view}`)
  // Two phase groups, total > 5: the run-level entry is useful.
  app.setTranscript([workflow({ members: [
    ...Array.from({ length: 4 }, (_, i) => member(i, `a${i}`, 'A', 'completed')),
    ...Array.from({ length: 3 }, (_, i) => member(4 + i, `b${i}`, 'B', 'completed')),
  ] })])
  view = await viewport(vt)
  assert.ok(view.includes('View all 7 agents'), `run-level entry missing:\n${view}`)
})

// ---------------------------------------------------------------------------
// Disclosure state machine (plan §16.3)
// ---------------------------------------------------------------------------

test('initial disclosure: running/abnormal runs open, completed runs closed', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({ status: 'running', members: [member(0, 'a', 'P', 'running')] })])
  let view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `running run must open:\n${view}`)
  assert.ok(view.includes('a — running'), `open run must show members:\n${view}`)
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    app.setTranscript([workflow({ status, members: [member(0, 'a', 'P', status)] })])
    view = await viewport(vt)
    assert.equal(runChevron(view), '▼', `${status} run must open:\n${view}`)
  }
  app.setTranscript([workflow({ status: 'completed', members: [member(0, 'a', 'P', 'completed')] })])
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `completed run must close:\n${view}`)
  assert.ok(!view.includes('a — completed'), `closed run must not leak members:\n${view}`)
})

test('fully completed phase closes; active/abnormal phase opens', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({ members: [
    member(0, 'done', 'A', 'completed'),
    member(1, 'live', 'B', 'running'),
  ] })])
  const view = await viewport(vt)
  assert.ok(view.includes('▶ A 1 agent'), `completed phase must close:\n${view}`)
  assert.ok(!view.includes('done — completed'), `closed phase must not leak members:\n${view}`)
  assert.ok(view.includes('▼ B 1 agent'), `active phase must open:\n${view}`)
  assert.ok(view.includes('live — running'), `active phase members visible:\n${view}`)
})

test('user close persists across ordinary live updates', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([workflow({ members: [member(0, 'a', 'P', 'running')] })])
  let view = await viewport(vt)
  const headerRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `user close must fold the run:\n${view}`)
  // A normal live update (new member, still running) must not reopen it.
  app.setTranscript([workflow({ members: [member(0, 'a', 'P', 'running'), member(1, 'b', 'P', 'running')] })])
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `ordinary updates must not override the user choice:\n${view}`)
  assert.ok(!view.includes('a — running'), `closed run must stay closed:\n${view}`)
})

test('first abnormal edge auto-opens once; a later user close persists', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-x' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `running run must open:\n${view}`)
  // The first abnormal edge (a member fails) keeps the run open — the
  // exception stays visible.
  folder.apply([
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'failed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.ok(view.includes('a — failed'), `abnormal member must stay visible:\n${view}`)
  // The user closes the run; a further abnormal update must not reopen it.
  const headerRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `user close must fold the run:\n${view}`)
  folder.apply([
    { type: 'tool-workflow/agent-start', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', seq: 1, label: 'b', childId: 'session-y' } } as SessionEvent,
    { type: 'tool-workflow/agent-end', seq: 5, time: 1_700_000_000_005, data: { runId: 'run-1', seq: 1, outcome: 'cancelled' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `abnormal updates must not reopen a user-closed run:\n${view}`)
})

test('completion auto-closes once; a new running member reopens the phase', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-x' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  assert.ok(view.includes('▼ Unassigned 1 agent'), `active phase must open:\n${view}`)
  // Completion: the phase auto-closes once.
  folder.apply([
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'completed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.ok(view.includes('▶ Unassigned 1 agent'), `completed phase must auto-close:\n${view}`)
  // A new running member in the SAME phase reopens it (plan §7.7).
  folder.apply([
    { type: 'tool-workflow/agent-start', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', seq: 1, label: 'b', childId: 'session-y' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.ok(view.includes('▼ Unassigned 2 agents'), `phase must reopen for the new running member:\n${view}`)
  assert.ok(view.includes('b — running'), `new member visible:\n${view}`)
  // The outer run stays open too (it is still running — the reopen never
  // folds it; plan §7.7 "phase + run reopen").
  assert.equal(runChevron(view), '▼', `the outer run must stay open:\n${view}`)
})

test('outer run close/open never clears the phase user choice', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([workflow({ members: [member(0, 'a', 'P', 'running')] })])
  let view = await viewport(vt)
  // Close the phase by hand.
  const phaseRow = rowOf(view, '▼ P 1 agent')
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  assert.ok(view.includes('▶ P 1 agent'), `phase must fold on click:\n${view}`)
  // Close and reopen the outer run.
  const headerRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `run must fold:\n${view}`)
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  // The phase stays closed — the user's choice survives the run round-trip.
  assert.ok(view.includes('▶ P 1 agent'), `phase choice must survive the run toggle:\n${view}`)
  assert.ok(!view.includes('a — running'), `closed phase must not leak members:\n${view}`)
})

// ---------------------------------------------------------------------------
// Focus integration (plan §16.4)
// ---------------------------------------------------------------------------

test('collapsed Focus hides the Workflow card; expanded Focus shows one Run disclosure', async () => {
  const { vt, app } = startApp()
  app.setFocusMode(true)
  app.setTranscript([workflow({ members: [member(0, 'a', 'P', 'running')] })])
  let view = await viewport(vt)
  assert.ok(!view.includes('Workflow audit'), `collapsed Focus must hide the workflow card:\n${view}`)
  app.expandFocusTurn(0)
  view = await viewport(vt)
  assert.ok(view.includes('Workflow audit [running]'), `expanded Focus must show the workflow card:\n${view}`)
  // Exactly ONE run disclosure — never a generic fold wrapped around it.
  const chevrons = view.split('\n').filter(line => stripTerminalSequences(line).includes('Workflow audit')).length
  assert.equal(chevrons, 1, `exactly one workflow run row:\n${view}`)
})

test('workflow card clicks never collapse the owning Focus turn', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setFocusMode(true)
  app.setTranscript([workflow({ members: [member(0, 'a', 'P', 'running')] })])
  app.expandFocusTurn(0)
  let view = await viewport(vt)
  assert.ok(view.includes('Workflow audit [running]'), `workflow card must be visible:\n${view}`)
  // Click the run header (toggle), the phase header (toggle), and a member
  // row — none may collapse the Focus turn.
  const headerRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `run header click must toggle the run:\n${view}`)
  assert.ok(view.includes('Workflow audit'), `Focus must stay expanded after a run click:\n${view}`)
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  const phaseRow = rowOf(view, '▼ P 1 agent')
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  assert.ok(view.includes('▶ P 1 agent'), `phase header click must toggle the phase:\n${view}`)
  assert.ok(view.includes('Workflow audit'), `Focus must stay expanded after a phase click:\n${view}`)
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  const memberRow = rowOf(view, 'a — running')
  await clickCell(vt, 10, memberRow)
  view = await viewport(vt)
  assert.ok(view.includes('Workflow audit'), `Focus must stay expanded after a member click:\n${view}`)
})

// ---------------------------------------------------------------------------
// Direct member navigation (plan §16.5)
// ---------------------------------------------------------------------------

test('workflowMemberViewerTarget: the full authority matrix', () => {
  const root = 'session-main'
  const directRunning: TaskBrowserRow = {
    kind: 'subagent', value: 'agent:child-1', childId: 'child-1', label: 'checker',
    mode: 'one-shot', activity: 'running', hasChildren: false, parentId: '', depth: 1,
  }
  const runningMember = { status: 'running' as const, childId: 'child-1' }
  // running + direct + exact parent + running driver → target.
  const target = workflowMemberViewerTarget(runningMember, directRunning, root)
  assert.ok(target !== undefined)
  assert.equal(target.parentSessionId, root)
  assert.equal(target.childSessionId, 'child-1')
  assert.equal(target.label, 'checker')
  assert.equal(target.mode, 'one-shot')
  assert.equal(target.activity, 'running')
  // Terminal member → no direct opener.
  assert.equal(workflowMemberViewerTarget({ status: 'completed', childId: 'child-1' }, directRunning, root), undefined)
  assert.equal(workflowMemberViewerTarget({ status: 'failed', childId: 'child-1' }, directRunning, root), undefined)
  assert.equal(workflowMemberViewerTarget({ status: 'cancelled', childId: 'child-1' }, directRunning, root), undefined)
  assert.equal(workflowMemberViewerTarget({ status: 'interrupted', childId: 'child-1' }, directRunning, root), undefined)
  // Missing catalog row (agent-start before the listing) → noninteractive.
  assert.equal(workflowMemberViewerTarget(runningMember, undefined, root), undefined)
  // Wrong parent → noninteractive.
  const wrongParent: TaskBrowserRow = { ...directRunning, parentId: 'session-other' }
  assert.equal(workflowMemberViewerTarget(runningMember, wrongParent, root), undefined)
  // Nested (depth 2) → noninteractive.
  const nested: TaskBrowserRow = { ...directRunning, parentId: 'session-mid', depth: 2 }
  assert.equal(workflowMemberViewerTarget(runningMember, nested, root), undefined)
  // Inactive driver → noninteractive.
  const inactive: TaskBrowserRow = { ...directRunning, activity: 'inactive' }
  assert.equal(workflowMemberViewerTarget(runningMember, inactive, root), undefined)
  // A job row is never a member target.
  const jobRow: TaskBrowserRow = {
    kind: 'job', value: 'job:j1', jobId: 'j1', jobKind: 'bash', label: 'job', status: 'running', startedAt: 1,
  }
  assert.equal(workflowMemberViewerTarget(runningMember, jobRow, root), undefined)
})

test('running member click emits open-member; terminal member rows have no hit', async () => {
  const actions: WorkflowAction[] = []
  const { vt, app } = startApp({ onWorkflowAction: action => actions.push(action) })
  app.setFullscreen(true)
  app.setTranscript([workflow({ members: [
    member(0, 'live', 'P', 'running'),
    member(1, 'done', 'P', 'completed'),
  ] })])
  let view = await viewport(vt)
  const liveRow = rowOf(view, 'live — running')
  await clickCell(vt, 10, liveRow)
  await vt.waitForRender()
  assert.deepEqual(actions, [{ kind: 'open-member', runId: 'run-1', seq: 0, childId: 'child-0' }],
    `running member click must emit the semantic action`)
  // A terminal member row consumes the click but emits nothing.
  actions.length = 0
  view = await viewport(vt)
  const doneRow = rowOf(view, 'done — completed')
  await clickCell(vt, 10, doneRow)
  await vt.waitForRender()
  assert.deepEqual(actions, [], `terminal member must never emit open-member`)
})

test('View N agents clicks emit the scoped phase/run actions', async () => {
  const actions: WorkflowAction[] = []
  const { vt, app } = startApp({ onWorkflowAction: action => actions.push(action) })
  app.setFullscreen(true)
  app.setTranscript([workflow({ name: 'audit', members: [
    ...Array.from({ length: 5 }, (_, i) => member(i, `a${i}`, 'A', 'completed')),
    member(5, 'a5', 'A', 'running'),
    ...Array.from({ length: 2 }, (_, i) => member(6 + i, `b${i}`, 'B', 'completed')),
    member(8, 'b2', 'B', 'running'),
  ] })])
  let view = await viewport(vt)
  const phaseRow = rowOf(view, 'View 6 agents')
  await clickCell(vt, 10, phaseRow)
  await vt.waitForRender()
  assert.deepEqual(actions, [{
    kind: 'open-phase-agents', runId: 'run-1', name: 'audit', phaseLabel: 'A',
    childIds: ['child-0', 'child-1', 'child-2', 'child-3', 'child-4', 'child-5'],
  }], `phase View click must emit the scoped action`)
  actions.length = 0
  view = await viewport(vt)
  const runRow = rowOf(view, 'View all 9 agents')
  await clickCell(vt, 10, runRow)
  await vt.waitForRender()
  assert.deepEqual(actions, [{
    kind: 'open-run-agents', runId: 'run-1', name: 'audit',
    childIds: ['child-0', 'child-1', 'child-2', 'child-3', 'child-4', 'child-5', 'child-6', 'child-7', 'child-8'],
  }], `run View-all click must emit the scoped action`)
})

// ---------------------------------------------------------------------------
// Review round 1 fixes (P1/P2 regressions)
// ---------------------------------------------------------------------------

test('a run settling abnormal with only completed members reopens once after user close (review P1)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-x' } } as SessionEvent,
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'completed' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  // The user closes the run while it is still running with a completed member.
  const headerRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `user close must fold the run:\n${view}`)
  // The run settles FAILED with only completed members: the abnormal RUN
  // status is an abnormal edge — it must reopen once.
  folder.apply([
    { type: 'tool-workflow/run-end', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', stopReason: 'error' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `an abnormal run status must reopen the run once:\n${view}`)
  assert.ok(view.includes('Workflow audit [failed]'), `failed run status missing:\n${view}`)
})

test('a cold-replayed abnormal run with zero members opens by default (review P1)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({ status: 'failed', members: [] })])
  const view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `a zero-member failed run must open:\n${view}`)
  assert.ok(view.includes('Workflow audit [failed]'), `failed run status missing:\n${view}`)
})

test('a closed completed run still shows the aggregate summary (review P1, plan §5.6)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({
    status: 'completed',
    members: Array.from({ length: 100 }, (_, i) => member(i, `m${i}`, 'P', 'completed')),
  })])
  const view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `completed run must close:\n${view}`)
  assert.ok(view.includes('100 agents · 100 completed'), `closed run must keep the aggregate summary:\n${view}`)
  assert.ok(!view.includes('m0 — completed'), `closed run must not leak members:\n${view}`)
})

test('workflowMemberViewerTarget rejects a mismatched row and a continuable row (review P2)', () => {
  const root = 'session-main'
  const runningMember = { status: 'running' as const, childId: 'child-1' }
  // A row for a DIFFERENT child must never combine with the member identity.
  const mismatched: TaskBrowserRow = {
    kind: 'subagent', value: 'agent:child-9', childId: 'child-9', label: 'other',
    mode: 'one-shot', activity: 'running', hasChildren: false, parentId: '', depth: 1,
  }
  assert.equal(workflowMemberViewerTarget(runningMember, mismatched, root), undefined,
    'a mismatched row must never resolve')
  // A continuable catalog row is never a Workflow member target (one-shot
  // authority — the viewer must never grant an interactive editor).
  const continuable: TaskBrowserRow = {
    kind: 'subagent', value: 'agent:child-1', childId: 'child-1', label: 'checker',
    mode: 'continuable', activity: 'running', hasChildren: false, parentId: '', depth: 1,
  }
  assert.equal(workflowMemberViewerTarget(runningMember, continuable, root), undefined,
    'a continuable row must never resolve as a Workflow member target')
})

test('the running run pill uses the primary semantic color (review P2, plan §8.2)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([workflow({ status: 'running', members: [] })])
  const view = await viewport(vt)
  // The pill cell must carry the PRIMARY truecolor (0x4FA8FF), never the
  // dim gray (0x888888) of the old textDim pill (plan §8.2: running →
  // active/primary).
  const row = rowOf(view, '[running]')
  const col = stripTerminalSequences(view.split('\n')[row]!).indexOf('[running]')
  assert.equal(vt.getCellFgRgb(row, col), 0x4FA8FF,
    `running pill must use the primary semantic color:\n${view}`)
  assert.notEqual(vt.getCellFgRgb(row, col), 0x888888,
    `running pill must not use the dim color:\n${view}`)
})

test('workflow cards stay host-owned under a message renderer registry (review P2)', async () => {
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerMessageRenderer({
    id: 'workflow-plugin',
    render: () => ({ kind: 'text', spans: [{ text: 'PLUGIN WORKFLOW' }] }),
  }, 'test-owner')
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)
  app.setTranscript([workflow({ members: [member(0, 'a', 'P', 'running')] })])
  const view = await viewport(vt)
  // Workflow records are HOST-owned (semanticSnapshotOf returns undefined):
  // a message renderer registry never takes the card over, so the host hit
  // map stays authoritative (the !hostBuilt cleanup is defensive for the
  // future, unreachable for workflow today).
  assert.ok(view.includes('Workflow audit [running]'), `host must render the workflow card:\n${view}`)
  assert.ok(!view.includes('PLUGIN WORKFLOW'), `a plugin must never own the workflow card:\n${view}`)
  const hits = (app as unknown as { workflowHitsByMessage: Map<object, unknown> }).workflowHitsByMessage
  assert.equal(hits.size, 1, `the host-rendered card must record its hit rows`)
})

test('View-agent clicks inside an expanded Focus never collapse the owning turn (review P2)', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setFocusMode(true)
  app.setTranscript([workflow({ name: 'audit', members: [
    ...Array.from({ length: 5 }, (_, i) => member(i, `a${i}`, 'A', 'completed')),
    member(5, 'a5', 'A', 'running'),
    ...Array.from({ length: 2 }, (_, i) => member(6 + i, `b${i}`, 'B', 'completed')),
    member(8, 'b2', 'B', 'running'),
  ] })])
  app.expandFocusTurn(0)
  let view = await viewport(vt)
  assert.ok(view.includes('Workflow audit [running]'), `workflow card must be visible:\n${view}`)
  // Phase View N agents click: the scoped action fires, Focus stays expanded.
  const phaseRow = rowOf(view, 'View 6 agents')
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  assert.ok(view.includes('Workflow audit'), `Focus must stay expanded after a phase View click:\n${view}`)
  // Run View all click: same protection.
  const runRow = rowOf(view, 'View all 9 agents')
  await clickCell(vt, 10, runRow)
  view = await viewport(vt)
  assert.ok(view.includes('Workflow audit'), `Focus must stay expanded after a run View-all click:\n${view}`)
})

test('a running run auto-closes once on run-end completed; an explicit user open persists (review P2)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-x' } } as SessionEvent,
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'completed' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `a running run must open:\n${view}`)
  // run-end completed: the OUTER run auto-closes once (plan §7.6).
  folder.apply([
    { type: 'tool-workflow/run-end', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', stopReason: 'completed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `a completed run must auto-close once:\n${view}`)
  // The user explicitly reopens it: the choice persists (no second
  // auto-close can fire — the transition is one-shot).
  const headerRow = rowOf(view, 'Workflow audit [completed]')
  await clickCell(vt, 10, headerRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `the explicit user open must persist:\n${view}`)
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `an unchanged re-render must keep the user choice:\n${view}`)
})

test('a phase folds and unfolds across ANY number of running→clean cycles (review P2)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setTranscript(folder.messages())
  const cycle = async (seq: number, label: string): Promise<string> => {
    folder.apply([
      { type: 'tool-workflow/agent-start', seq, time: 1_700_000_000_000 + seq, data: { runId: 'run-1', seq: seq - 2, label, childId: `session-${label}` } } as SessionEvent,
    ])
    app.setTranscript(folder.messages())
    let view = await viewport(vt)
    assert.ok(view.includes('▼ Unassigned'), `${label} start must open the phase:\n${view}`)
    folder.apply([
      { type: 'tool-workflow/agent-end', seq: seq + 1, time: 1_700_000_000_000 + seq + 1, data: { runId: 'run-1', seq: seq - 2, outcome: 'completed' } } as SessionEvent,
    ])
    app.setTranscript(folder.messages())
    view = await viewport(vt)
    assert.ok(view.includes('▶ Unassigned'), `${label} completion must close the phase again:\n${view}`)
    return view
  }
  // A start -> open, A complete -> close.
  await cycle(2, 'a')
  // B start -> open, B complete -> close (the SECOND cycle — the old
  // one-shot completionClosed/reopened flags would leave it stuck open).
  await cycle(4, 'b')
  // C start -> open (a THIRD cycle still works).
  folder.apply([
    { type: 'tool-workflow/agent-start', seq: 6, time: 1_700_000_000_006, data: { runId: 'run-1', seq: 4, label: 'c', childId: 'session-c' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  const view = await viewport(vt)
  assert.ok(view.includes('▼ Unassigned'), `the third cycle must open the phase again:\n${view}`)
})

test('an explicit user open survives the interrupted edge and late terminal facts (review P2)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-x' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  // The user closes and reopens the PHASE, then the RUN: both choices are
  // now explicit opens (userOpen = true).
  const phaseRow = rowOf(view, '▼ Unassigned 1 agent')
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  const runRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, runRow)
  view = await viewport(vt)
  await clickCell(vt, 10, runRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `the run must be explicitly open:\n${view}`)
  assert.ok(view.includes('▼ Unassigned 1 agent'), `the phase must be explicitly open:\n${view}`)
  // The owner closes without terminal facts: run + member project
  // interrupted (PR1). The first abnormal edge must NOT clear the user's
  // explicit opens.
  folder.apply([
    { type: 'turn/end', seq: 3, time: 1_700_000_000_003, data: { turn: 0, reason: { kind: 'completed' } } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `the interrupted edge must keep the explicit run open:\n${view}`)
  assert.ok(view.includes('▼ Unassigned 1 agent'), `the interrupted edge must keep the explicit phase open:\n${view}`)
  // Late durable terminal facts recover completed (PR1 late-terminal
  // contract). The final facts are ALL clean, so the completion edge
  // auto-closes both the run and the phase (Web: new clean facts =>
  // close) — the explicit opens were consumed by the clean transition.
  folder.apply([
    { type: 'tool-workflow/agent-end', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', seq: 0, outcome: 'completed' } } as SessionEvent,
    { type: 'tool-workflow/run-end', seq: 5, time: 1_700_000_000_005, data: { runId: 'run-1', stopReason: 'completed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `all-clean late completion must auto-close the run:\n${view}`)
  // Reopen the run: the phase's clean transition already consumed the
  // explicit open, so the phase is folded too (Web: new clean facts =>
  // close).
  const closedRunRow = rowOf(view, 'Workflow audit [completed]')
  await clickCell(vt, 10, closedRunRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `the run must reopen on click:\n${view}`)
  assert.ok(view.includes('▶ Unassigned 1 agent'), `all-clean late completion must auto-close the phase:\n${view}`)
})

test('a new running cycle reopens a user-closed run and phase (review P2, plan §7.7)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-a' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  // The user folds the phase and the whole run.
  const phaseRow = rowOf(view, '▼ Unassigned 1 agent')
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  const runRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, runRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `the run must be user-closed:\n${view}`)
  // A completes: the phase is clean — the user's close persists.
  folder.apply([
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'completed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `a clean phase must keep the user close:\n${view}`)
  // B starts in the SAME phase: a NEW CYCLE — the phase AND the run reopen
  // (plan §7.7), overriding the prior user close.
  folder.apply([
    { type: 'tool-workflow/agent-start', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', seq: 1, label: 'b', childId: 'session-b' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `a new cycle must reopen the run:\n${view}`)
  assert.ok(view.includes('▼ Unassigned 2 agents'), `a new cycle must reopen the phase:\n${view}`)
})

test('a new member in a still-running phase is an ordinary update, not a new cycle (review P2)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-a' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 1, label: 'b', childId: 'session-b' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  // The user folds the phase and the run while both are still running.
  const phaseRow = rowOf(view, '▼ Unassigned 2 agents')
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  const runRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, runRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `the run must be user-closed:\n${view}`)
  // C starts while the phase is STILL running: an ordinary update — the
  // user's close persists (plan §7.4).
  folder.apply([
    { type: 'tool-workflow/agent-start', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', seq: 2, label: 'c', childId: 'session-c' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `an ordinary update must keep the user close:\n${view}`)
})

test('a completed run with a failed member is abnormal and opens by default (review P2, Web parity)', async () => {
  const { vt, app } = startApp()
  // Cold replay: the script handled the child's null and returned
  // successfully — run-end completed, member failed. Web runDisclosureFacts
  // says abnormal (any phase abnormal) → the run and the phase open.
  app.setTranscript([workflow({ status: 'completed', members: [
    member(0, 'a', 'P', 'failed'),
  ] })])
  const view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `a completed run with a failed member must open:\n${view}`)
  assert.ok(view.includes('Workflow audit [completed]'), `the durable status pill stays completed:\n${view}`)
  assert.ok(view.includes('▼ P 1 agent'), `the failed phase must open:\n${view}`)
  assert.ok(view.includes('a — failed'), `the failed member must be visible:\n${view}`)
})

test('a run stays abnormal/open after run-end completed when a member failed (review P2)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-a' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `a running run must open:\n${view}`)
  // The member fails: the run becomes abnormal (still open).
  folder.apply([
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'failed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `an abnormal run must stay open:\n${view}`)
  // run-end completed: the run is STILL abnormal (member failed) — it must
  // NOT collapse to the clean default.
  folder.apply([
    { type: 'tool-workflow/run-end', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', stopReason: 'completed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `run-end completed must not collapse an abnormal run:\n${view}`)
  assert.ok(view.includes('Workflow audit [completed]'), `the durable status pill stays completed:\n${view}`)
  assert.ok(view.includes('a — failed'), `the failed member stays visible:\n${view}`)
})

test('a clean phase whose member count changed reopens a user-closed run (Web phaseStartedCycle parity)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-a' } } as SessionEvent,
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'completed' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  // The user folds the run while the phase is clean.
  const runRow = rowOf(view, 'Workflow audit [running]')
  await clickCell(vt, 10, runRow)
  view = await viewport(vt)
  assert.equal(runChevron(view), '▶', `the run must be user-closed:\n${view}`)
  // B starts AND settles within one facts update: the phase stays clean
  // but its member count changed — Web's phaseStartedCycle still fires
  // (facts.activityCount !== previous.activityCount) and reopens the run.
  folder.apply([
    { type: 'tool-workflow/agent-start', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', seq: 1, label: 'b', childId: 'session-b' } } as SessionEvent,
    { type: 'tool-workflow/agent-end', seq: 5, time: 1_700_000_000_005, data: { runId: 'run-1', seq: 1, outcome: 'completed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `a clean phase with a changed member count must reopen the run:\n${view}`)
})

test('a clean phase manually opened then batch-grown closes while the run reopens (Web parity)', async () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 0 } } as SessionEvent,
    { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_001, data: { runId: 'run-1', name: 'audit' } } as SessionEvent,
    { type: 'tool-workflow/agent-start', seq: 2, time: 1_700_000_000_002, data: { runId: 'run-1', seq: 0, label: 'a', childId: 'session-a' } } as SessionEvent,
    { type: 'tool-workflow/agent-end', seq: 3, time: 1_700_000_000_003, data: { runId: 'run-1', seq: 0, outcome: 'completed' } } as SessionEvent,
  ])
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript(folder.messages())
  let view = await viewport(vt)
  // The user manually opens the clean phase (userOpen = true).
  const phaseRow = rowOf(view, '▶ Unassigned 1 agent')
  await clickCell(vt, 10, phaseRow)
  view = await viewport(vt)
  assert.ok(view.includes('▼ Unassigned 1 agent'), `the phase must be explicitly open:\n${view}`)
  // B starts AND settles within one facts update: the phase stays clean
  // but its member count changed. Web: the clean facts consume the user's
  // open (phase folds) while the outer run reopens (new clean cycle).
  folder.apply([
    { type: 'tool-workflow/agent-start', seq: 4, time: 1_700_000_000_004, data: { runId: 'run-1', seq: 1, label: 'b', childId: 'session-b' } } as SessionEvent,
    { type: 'tool-workflow/agent-end', seq: 5, time: 1_700_000_000_005, data: { runId: 'run-1', seq: 1, outcome: 'completed' } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  view = await viewport(vt)
  assert.equal(runChevron(view), '▼', `a new clean cycle must reopen the run:\n${view}`)
  assert.ok(view.includes('▶ Unassigned 2 agents'), `the clean phase must fold despite the explicit open:\n${view}`)
})

test('a workflow member press cannot transfer to the aggregate View row after a 5→6 switch (mouse parity)', async () => {
  const actions: WorkflowAction[] = []
  const { vt, app } = startApp({ onWorkflowAction: action => actions.push(action) })
  app.setFullscreen(true)
  const message = workflow({ members: [
    ...Array.from({ length: 5 }, (_, i) => member(i, `a${i}`, 'A', 'running')),
  ] })
  app.setTranscript([message])
  let view = await viewport(vt)
  const memberRow = rowOf(view, 'a1 — running')
  // Press the second member (no release): the press identity is
  // workflow:member:run-1:1:child-1 — the cell the aggregate View row
  // takes over after the 5→6 switch.
  vt.sendInput(`\x1b[<0;10;${memberRow + 1}M`)
  await vt.waitForRender()
  // The SIXTH member arrives: the SAME message object mutates in place
  // (the object token is unchanged) and the phase switches to the
  // aggregate summary layout — the pressed cell becomes the View row.
  message.members = [...message.members, member(5, 'a5', 'A', 'running')]
  app.setTranscript([message])
  await vt.waitForRender()
  view = await viewport(vt)
  const viewRow = rowOf(view, 'View 6 agents')
  assert.equal(viewRow, memberRow, `the aggregate View row must occupy the pressed cell:\n${view}`)
  // Release on the same cell: the click must NOT emit the phase-agents
  // action (the press identity is the member, not the aggregate row).
  vt.sendInput(`\x1b[<0;10;${memberRow + 1}m`)
  await vt.waitForRender()
  assert.deepEqual(actions, [], `the stale member press must not open the aggregate view:\n${vt.getViewport().join('\n')}`)
  // A fresh click on the aggregate row emits the scoped action.
  await clickCell(vt, 10, viewRow)
  await vt.waitForRender()
  assert.deepEqual(actions, [{
    kind: 'open-phase-agents', runId: 'run-1', name: 'audit', phaseLabel: 'A',
    childIds: ['child-0', 'child-1', 'child-2', 'child-3', 'child-4', 'child-5'],
  }], `a fresh aggregate click must emit the scoped action`)
  app.stop()
})
