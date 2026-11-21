/**
 * FR2 real Fullscreen pointer route: the mounted `TuiApp` + `VirtualTerminal`
 * SGR mouse path through the REAL Task Center overlay and `TaskBrowserPanel`.
 * Proves a press→repaint→release sequence still commits the pressed Team task
 * (the last-painted gesture identity survives the press-triggered repaint), and
 * the PR-B Owner-approved exits close through the painted `Close [Esc]` spans.
 *
 * @module @xmoon76/dsh-pi-tui/task-center-pointer.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import { createTaskRuntime, type TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import { pituiTaskCenterPresentation } from '../../src/app/surface/task-presentation-pitui.ts'
import { pituiDisplaySeam } from '../../src/app/surface/display-seam-pitui.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { JobObservedSnapshot } from '../../src/runtime/job-observation-port.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => { disposeStartedApps() })

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

function taskSource(
  subject: SessionSubject,
  descendants: readonly TaskSubagentEntry[] = [],
): TaskSurfaceSource {
  return {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (_row, jobDetail) => jobDetail,
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: {
      open: () => () => {},
      stop: async () => ({ kind: 'requested' as const }),
    },
    jobs: { list: () => [], subscribe: () => () => {} },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({ parentSessionId: 'sess-main', parentAvailable: true, descendants, jobs: [] }),
      // The fixture catalog is settled unless its own entry declares a live
      // activity; the root session (not a descendant) keeps its running fact.
      activityOf: (childId) => {
        const entry = descendants.find(candidate => candidate.id === childId)
        return entry?.kind === 'child' ? entry.activity : 'running'
      },
    },
    teamBoard: {
      read: () => ({
        kind: 'ready' as const,
        enabled: true,
        tasks: [{
          id: 'task-1', revision: 1, subject: 'Ship it', description: 'desc-pointer',
          status: 'pending' as const, ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [],
        }],
      }),
      subscribe: () => () => {},
    },
  }
}

/** A REAL Job roster feed (mutable) + the external Job-observation recorder. */
function jobRosterSource(
  subject: SessionSubject,
  roster: { rows: TaskBrowserJobInput[]; listeners: Array<(event: { type: string }) => void> },
): {
  source: TaskSurfaceSource
  observation: { opens: string[]; closes: string[] }
} {
  const observation = { opens: [] as string[], closes: [] as string[] }
  const base = taskSource(subject)
  const snapshot = (job: TaskBrowserJobInput): JobObservedSnapshot => ({
    jobId: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    detail: job.detail,
    text: `retained output for ${job.id}`,
    gapBefore: false,
    settled: job.status === 'completed' || job.status === 'failed' || job.status === 'timed_out' || job.status === 'lost',
  })
  return {
    observation,
    source: {
      ...base,
      jobs: {
        list: () => roster.rows,
        subscribe: listener => { roster.listeners.push(listener); return () => {} },
      },
      taskRead: {
        ...base.taskRead!,
        readTask: async () => ({ parentSessionId: 'sess-main', parentAvailable: true, descendants: [], jobs: roster.rows }),
      },
      jobObservation: {
        open: (_sessionId, jobId, listener) => {
          observation.opens.push(jobId)
          const job = roster.rows.find(row => row.id === jobId)
          if (job !== undefined) listener(snapshot(job))
          return () => { observation.closes.push(jobId) }
        },
        stop: async () => ({ kind: 'requested' as const }),
      },
    },
  }
}

/** The REAL fullscreen Task Center over a real TuiApp + VirtualTerminal. */
async function startTasks(
  descendants: readonly TaskSubagentEntry[] = [],
  sourceOverride?: TaskSurfaceSource,
): Promise<{
  vt: VirtualTerminal
  app: TuiApp
  tasks: ReturnType<typeof createTaskRuntime>
}> {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {})
  app.start()
  startedApps.add(app)
  const subject = {} as SessionSubject
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => pituiDisplaySeam(app),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
    publishActivity: () => {},
  })
  tasks.attachTasks(sourceOverride ?? taskSource(subject, descendants), { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  await flush()
  app.setFullscreen(true)
  await vt.waitForRender()
  tasks.openTasksBrowser('full')
  await vt.waitForRender()
  return { vt, app, tasks }
}

/** One real SGR press+release on the first painted occurrence of `text`. */
async function clickText(vt: VirtualTerminal, text: string): Promise<void> {
  const viewport = vt.getViewport()
  const row = viewport.findIndex(line => line.includes(text))
  assert.ok(row >= 0, `the frame must paint '${text}':\n${viewport.join('\n')}`)
  const col = viewport[row]!.indexOf(text)
  assert.ok(col >= 0)
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
  await vt.waitForRender()
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
  await vt.waitForRender()
  await flush(2)
}

test('real Fullscreen SGR press → repaint → release expands the pressed Team task', async () => {
  const { vt, app } = await startTasks()
  vt.sendInput('\t') // Work → Team
  await vt.waitForRender()
  const viewport = vt.getViewport()
  const row = viewport.findIndex(line => line.includes('Ship it'))
  assert.ok(row >= 0, `the Team task row must be painted:\n${viewport.join('\n')}`)
  const x = viewport[row]!.indexOf('Ship it')
  assert.ok(x >= 0)
  // REAL SGR pointer route: press, wait for the press-triggered repaint, release.
  vt.sendInput(`\x1b[<0;${x + 1};${row + 1}M`)
  await vt.waitForRender()
  vt.sendInput(`\x1b[<0;${x + 1};${row + 1}m`)
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('desc-pointer'), `the release must expand the pressed Team task:\n${after}`)
  app.stop()
})

test('real Fullscreen SGR clicks close the Work and Team Task Center through Close [Esc]', async () => {
  const { vt, app, tasks } = await startTasks()
  const work = vt.getViewport().join('\n')
  assert.ok(work.includes('Close [Esc]'), `the Work bar paints its close span:\n${work}`)
  await clickText(vt, 'Close [Esc]')
  const closedWork = vt.getViewport().join('\n')
  assert.ok(!closedWork.includes('Ship it') && !closedWork.includes('[Work]'),
    `the Work close span dismisses the Task Center:\n${closedWork}`)
  // Reopen through the real runtime entry, switch to Team, and close it through
  // the SAME painted span.
  tasks.openTasksBrowser('full')
  await vt.waitForRender()
  vt.sendInput('\t')
  await vt.waitForRender()
  const team = vt.getViewport().join('\n')
  assert.ok(team.includes('Members') && team.includes('Close [Esc]'), `the Team bar paints its close span:\n${team}`)
  await clickText(vt, 'Close [Esc]')
  const closedTeam = vt.getViewport().join('\n')
  assert.ok(!closedTeam.includes('Ship it') && !closedTeam.includes('Members') && !closedTeam.includes('[Team]'),
    `the Team close span dismisses the Task Center:\n${closedTeam}`)
  app.stop()
})

test('real Fullscreen Tracked Work paints every retained settled Subagent branch in pre-order', async () => {
  const descendants: TaskSubagentEntry[] = [
    { kind: 'child', id: 'p', label: 'parent', mode: 'continuable', activity: 'inactive', hasChildren: true, parentId: '', depth: 1 },
    { kind: 'child', id: 'c', label: 'child', mode: 'one-shot', activity: 'inactive', hasChildren: true, parentId: 'p', depth: 2 },
    { kind: 'child', id: 'leaf', label: 'nested leaf', mode: 'one-shot', activity: 'inactive', hasChildren: false, parentId: 'c', depth: 3 },
  ]
  const { vt, app } = await startTasks(descendants)
  const viewport = vt.getViewport()
  const joined = viewport.join('\n')
  assert.ok(joined.includes('── Subagents / transcripts ──'), `the subagents group is painted:\n${joined}`)
  assert.ok(!joined.includes('── Jobs'), `no Jobs group exists without Job rows:\n${joined}`)
  const parentIndex = viewport.findIndex(line => line.includes('subagent · parent'))
  const childIndex = viewport.findIndex(line => line.includes('subagent · child'))
  const leafIndex = viewport.findIndex(line => line.includes('subagent · nested leaf'))
  assert.ok(parentIndex >= 0 && childIndex > parentIndex && leafIndex > childIndex,
    `the settled tree paints in catalog pre-order:\n${joined}`)
  assert.ok(viewport[parentIndex]!.includes('· continuable'), `the parent keeps its mode suffix:\n${viewport[parentIndex]}`)
  assert.ok(viewport[childIndex]!.includes('· one-shot'), `the nested child keeps its mode suffix:\n${viewport[childIndex]}`)
  app.stop()
})

// ── Real Fullscreen Job-history disclosure journey ────────────────────────

test('real Fullscreen job history: Show → history Job → Job Workspace → back → Hide → Close', async () => {
  const roster = {
    rows: [
      { id: 'job-1', kind: 'bash', label: 'bash · build', status: 'running', startedAt: 1 },
      { id: 'job-2', kind: 'bash', label: 'bash · lint', status: 'completed', startedAt: 2, finishedAt: 3 },
      { id: 'job-3', kind: 'bash', label: 'bash · failed', status: 'failed', startedAt: 4, finishedAt: 5 },
    ] as TaskBrowserJobInput[],
    listeners: [] as Array<(event: { type: string }) => void>,
  }
  const { source, observation } = jobRosterSource({} as SessionSubject, roster)
  const { vt, app } = await startTasks([], source)

  const collapsed = vt.getViewport().join('\n')
  assert.ok(collapsed.includes('Show 2 past jobs [J]'), `the fixed Show entry must paint:\n${collapsed}`)
  assert.ok(!collapsed.includes('bash · lint') && !collapsed.includes('bash · failed'),
    'terminal Job rows are NOT painted by default')
  assert.ok(collapsed.includes('!1 unreviewed'), 'the collapsed control surfaces unacknowledged failure attention')

  await clickText(vt, 'Show 2 past jobs')
  const expanded = vt.getViewport().join('\n')
  assert.ok(expanded.includes('Hide 2 past jobs [J]'), `the real SGR release expands history:\n${expanded}`)
  assert.ok(expanded.includes('bash · lint') && expanded.includes('bash · failed'))

  await clickText(vt, 'bash · failed')
  await flush(2)
  const jobFrame = vt.getViewport().join('\n')
  assert.ok(jobFrame.includes('Job · job-3 · bash'), `clicking the history row opens the existing Job Workspace:\n${jobFrame}`)
  assert.deepEqual(observation.opens, ['job-3'])
  await clickText(vt, 'Back [Esc]') // the Job Action Bar's own complete Esc span
  await vt.waitForRender()
  const back = vt.getViewport().join('\n')
  assert.ok(back.includes('Hide 2 past jobs [J]'), `Esc returns to the SAME expanded browser:\n${back}`)
  assert.ok(back.includes('bash · lint') && back.includes('bash · failed'))

  await clickText(vt, 'Hide 2 past jobs')
  const hidden = vt.getViewport().join('\n')
  assert.ok(hidden.includes('Show 2 past jobs [J]'), `the real Hide span collapses history:\n${hidden}`)
  assert.ok(!hidden.includes('bash · lint') && !hidden.includes('bash · failed'))
  await clickText(vt, 'Close [Esc]')
  assert.ok(!vt.getViewport().join('\n').includes('[TRACKED]'), 'the painted Close span dismisses the browser')
  assert.deepEqual(observation.closes, ['job-3'], 'the Job observer is released exactly once')
  app.stop()
})

test('real Fullscreen failure attention stays pending until the expanded Job row is physically painted', async () => {
  const roster = {
    rows: [
      { id: 'job-1', kind: 'bash', label: 'bash · build', status: 'running', startedAt: 1 },
    ] as TaskBrowserJobInput[],
    listeners: [] as Array<(event: { type: string }) => void>,
  }
  const { source } = jobRosterSource({} as SessionSubject, roster)
  const { vt, app, tasks } = await startTasks([], source)
  assert.ok(!vt.getViewport().join('\n').includes('bash · failed'))

  roster.rows.push({ id: 'job-2', kind: 'bash', label: 'bash · failed', status: 'failed', startedAt: 2, finishedAt: 3 })
  for (const listener of roster.listeners) listener({ type: 'changed' })
  await flush(12)
  await vt.waitForRender()
  const pending = vt.getViewport().join('\n')
  assert.ok(pending.includes('Show 1 past jobs [J]') && pending.includes('!1 unreviewed'),
    `the failure is summarised on the control:\n${pending}`)
  assert.ok(pending.includes('! 1 failed'), 'the footer failure summary is still armed before any row is painted')

  await clickText(vt, 'Show 1 past jobs')
  await flush(4)
  await vt.waitForRender()
  const painted = vt.getViewport().join('\n')
  assert.ok(painted.includes('bash · failed'), 'the expanded row is painted')
  assert.ok(!painted.includes('!1 unreviewed'), 'the physically painted row is acknowledged exactly once')
  assert.ok(!painted.includes('! 1 failed'), 'the footer summary drops only after the row is really visible')

  // Collapsing and re-opening the acknowledged history never re-arms the
  // failure attention; an asynchronous roster update keeps the SAME id
  // acknowledged too.
  vt.sendInput('j')
  await vt.waitForRender()
  vt.sendInput('j')
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('bash · failed'), 'the history re-opens')
  assert.ok(!vt.getViewport().join('\n').includes('! 1 failed'), 'an acknowledged row is not a new attention event')
  for (const listener of roster.listeners) listener({ type: 'changed' })
  await flush(8)
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('! 1 failed'), 'a same-roster update never re-arms an acknowledged failure')

  // Session replacement must not leak the old failure id into the new session.
  tasks.resetTasks()
  await flush(4)
  assert.deepEqual(tasks.globalRows(), [], 'a reset drops the old roster/attention rows')
  app.stop()
})
