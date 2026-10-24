/**
 * B3-A2: the REAL Task Runtime → TSP Work Hub → read-only Reader composition.
 *
 * This suite closes the source → decision → sink chain the Reader must not
 * bypass: the production `createTaskRuntime` projects the current Task rows
 * through the production `TaskCenterPresentationPort`, the production
 * `TspWorkHub` resolves the CURRENT row, and `mountTspRenderer` opens the ONE
 * temporary Screen whose document is read back from the SDK wire.
 *
 * STANDS-IN: the tty is the scripted pane and the Host task source is a fixture
 * (the same narrow `TaskSurfaceSource` the Task Runtime tests use) — never a
 * re-implemented runtime. A2 is `PROJECTION_ONLY`: `supportsTaskCenter` stays
 * false, so the browser is opened through the internal port exactly as the
 * still-gated `/tasks` path would.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-work-reader-composition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { createTaskRuntime } from '../../src/app/surface/task-runtime.ts'
import type { TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { QuestionAttentionRow } from '../../src/app/surface/question-controller.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import {
  pickerNode,
  pickerProps,
  surfaceNodes,
  surfaceScrollOps,
  surfaceTexts,
} from '../support/tsp-picker-wire.ts'

const HUB = 'work-hub-'

interface Composition {
  readonly pane: TspPane
  renderer: TspRenderer
  tasks: ReturnType<typeof createTaskRuntime>
  readonly selects: string[]
  readonly stops: string[]
  /** Replace the Host's Job roster and re-read it through the REAL runtime. */
  setJobs(jobs: readonly TaskBrowserJobInput[]): void
  /** Replace the controller's detached Question attention rows. */
  setAttention(rows: readonly QuestionAttentionRow[]): void
  readerId(): string | undefined
  /** The `scroll` targets one surface received, in order. */
  scrollOps(sf: string): string[]
  dispose(): Promise<void>
}

const JOBS: TaskBrowserJobInput[] = [
  { id: 'job-1', kind: 'bash', label: 'integration build', status: 'running', startedAt: 1_000 },
  { id: 'job-2', kind: 'pwsh', label: 'windows smoke', status: 'failed', startedAt: 2_000, finishedAt: 5_000, detail: 'exit code 1' },
]

const DESCENDANTS: TaskSubagentEntry[] = [
  {
    kind: 'child',
    id: 'child-1',
    label: 'integration review',
    mode: 'continuable',
    activity: 'running',
    hasChildren: false,
    parentId: '',
    depth: 1,
  },
]

/**
 * A catalog-v2 EXTERNAL leaf: the durable classification lives in the child
 * entry's own `mode`, never in a separate row kind.
 */
const EXTERNAL: TaskSubagentEntry[] = [
  {
    kind: 'child',
    id: 'external-1',
    label: 'remote review',
    mode: 'external',
    activity: 'inactive',
    hasChildren: false,
    parentId: '',
    depth: 1,
  },
]

async function compose(
  t: { after(fn: () => unknown): void },
  descendants: readonly TaskSubagentEntry[],
  attentionRows: readonly QuestionAttentionRow[] = [],
  options: { readonly realDisplaySeam?: boolean } = {},
): Promise<Composition> {
  const pane = installTspPane({ sessionBrowser: true, workDetails: true })
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  let disposed = false
  t.after(() => { if (!disposed) pane.restore() })

  const selects: string[] = []
  const stops: string[] = []
  const fatals: unknown[] = []
  const jobRoster: { jobs: readonly TaskBrowserJobInput[] } = { jobs: JOBS }
  const attention: { rows: readonly QuestionAttentionRow[] } = { rows: attentionRows }
  const subject = {}
  const composition: Composition = {
    pane,
    renderer: undefined as unknown as TspRenderer,
    tasks: undefined as unknown as ReturnType<typeof createTaskRuntime>,
    selects,
    stops,
    setJobs(jobs) {
      jobRoster.jobs = jobs
    },
    setAttention(rows) {
      attention.rows = rows
    },
    readerId: () => [...pane.openSurfaces()].reverse().find(entry => entry.mode === 'screen')?.id,
    scrollOps: sf => surfaceScrollOps(pane, sf).map(entry => entry.to),
    dispose: async () => {
      try {
        composition.tasks.resetTasks()
        await composition.renderer.dispose()
      } finally {
        disposed = true
        pane.restore()
      }
    },
  }
  const renderer = mountTspRenderer(session, {
    requestExit() {},
    onFatal: (error) => { fatals.push(error) },
  })
  t.after(() => {
    composition.tasks.resetTasks()
    void composition.renderer.dispose().catch(() => {})
  })
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => { throw new Error('the Reader path must never reach the composer') },
    steer() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
  })
  composition.renderer = renderer

  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject as never,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (_row, jobDetail) => jobDetail,
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: {
      open: () => () => {},
      stop: async (value: string) => {
        stops.push(value)
        return { kind: 'requested' } as never
      },
    },
    jobs: { list: () => jobRoster.jobs, subscribe: () => () => {} },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({ parentSessionId: 'sess-main', parentAvailable: true, descendants, jobs: jobRoster.jobs }),
      activityOf: () => 'running',
    },
  }
  const tasks = createTaskRuntime({
    mounted: () => { throw new Error('the TSP branch must never read a mounted PiTui app') },
    // Two modes: the presentation sink (so the internal port can open the Hub
    // exactly as A3 will), and the PRODUCTION seam (which truthfully declares
    // no Task Center, so the real `/tasks` entry must refuse).
    display: () => options.realDisplaySeam === true
      ? renderer.display
      : displaySeamStub({ supportsTaskCenter: true }),
    // The PRODUCTION sink: the surface wrapper over the internal Work Hub.
    presentation: () => renderer.taskPresentation,
    isCleanedUp: () => false,
    // The REAL attention projection (`fullQuestionRows`) is what turns these
    // rows into panel items; the Reader consumes the projected row only.
    attention: { rows: () => attention.rows, reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  composition.tasks = tasks
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  // The Task Runtime's first read settles on the microtask/macrotask queue; a
  // bounded drain lets the initial commit land before the browser opens.
  for (let index = 0; index < 12; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  tasks.openTasksBrowser('full')
  if (options.realDisplaySeam !== true) {
    await waitUntil('the real Task Runtime rows reach the Work Hub', () => pickerNode(pane, HUB) !== undefined)
  } else {
    // A refused open has no positive signal to await, so this is the bounded
    // negative-observation window for "the production entry mounted nothing".
    await new Promise<void>(resolve => setTimeout(resolve, 80)) // reason: bounded negative-observation window
  }
  // The browser's own `onSelect` is the BUSINESS router; the Reader must never use it.
  const presentation = renderer.taskPresentation
  assert.ok(typeof presentation.openBrowser === 'function')
  return composition
}

/** Select one real projected row in the Hub. */
async function selectRow(composition: Composition, value: string): Promise<void> {
  composition.pane.event({
    ev: 'select',
    sf: 's1',
    id: pickerNode(composition.pane, HUB)!.id,
    item: value,
  })
  await waitUntil(`the row ${value} is selected`, () => pickerProps(composition.pane, HUB).selected === value)
}

/** Enter the Reader for the current row. */
async function enterReader(composition: Composition): Promise<string> {
  composition.pane.key('\r')
  await waitUntil('the Reader document is mounted', () => {
    const id = composition.readerId()
    return id !== undefined && surfaceNodes(composition.pane, id).length > 0
  })
  return composition.readerId()!
}

test('the production /tasks entry still refuses in A2 and mounts no Work Hub or Reader', async (t) => {
  // The REAL TSP display seam is installed in the Task Runtime, so this is the
  // production reachability truth (not a stub): A2 must leave `/tasks`
  // explicit-unavailable, mount no browser and acquire no Screen. The
  // `mounted()` callback throws for any PiTui read, which never happens here.
  const composition = await compose(t, DESCENDANTS, [], { realDisplaySeam: true })
  assert.equal(composition.renderer.display.supportsTaskCenter, false,
    'the production seam declares no Task Center in A2')
  const hubKeys = composition.pane.frames().flatMap(frame => frame.ops)
    .filter(op => op[0] === 'add')
    .map(op => String((op[4] as unknown as { p?: { key?: string } }).p?.key ?? ''))
    .filter(key => key.startsWith(HUB))
  assert.deepEqual(hubKeys, [], 'the refused /tasks entry mounted NO Work Hub')
  assert.equal(composition.pane.openSurfaces().filter(entry => entry.mode === 'screen').length, 0,
    'no Reader can be reached without the Work Hub')
  // The refusal is expressed to the user, never a silent no-op.
  assert.ok(composition.pane.output.text().includes('Work Hub is not available in this renderer yet.'),
    'the refused entry states itself once')
})

test('a real Job row reaches the temporary Reader with its own facts and no business selection', async (t) => {
  const composition = await compose(t, DESCENDANTS)
  const ids = ((pickerProps(composition.pane, HUB).items ?? []) as Array<{ id: string }>).map(item => item.id)
  assert.ok(ids.includes('job:job-2'), `the real projected Job row is present: ${ids.join(',')}`)
  await selectRow(composition, 'job:job-2')
  const reader = await enterReader(composition)

  const content = surfaceTexts(composition.pane, reader)
  assert.equal(content[0], '← Work')
  assert.ok(content.some(line => line.includes('windows smoke')),
    `the Job label is the real projected label: ${content.join(' | ')}`)
  assert.ok(content.includes('Job · failed'), 'the real Job status is stated')
  assert.ok(content.includes('Stable ID job:job-2'), 'the durable Job id is the identity')
  assert.ok(content.includes('Type      pwsh'), 'the real Job kind is projected as a fact')
  assert.ok(content.includes('exit code 1'), 'the real Job detail is projected')
  assert.ok(content.includes('Started   1970-01-01T00:00:02.000Z'), 'the real start time is UTC ISO 8601')
  assert.ok(content.includes('Finished  1970-01-01T00:00:05.000Z'), 'the real finish time is UTC ISO 8601')
  assert.deepEqual(composition.scrollOps(reader), ['start'], 'the reading starts once at the top')
  assert.equal(composition.renderer.display.supportsTaskCenter, false,
    'A2 keeps the production Task Center capability false')

  // Back returns to the SAME real Hub with the same row.
  composition.pane.key('\u001b')
  await waitUntil('the Reader closed', () => composition.pane.closedSurfaceIds().includes(reader))
  assert.equal(pickerProps(composition.pane, HUB).selected, 'job:job-2')
  assert.deepEqual(composition.stops, [], 'reading a Job never stops it')
})

test('a real continuable Subagent row is read as a subagent fact set, not as a Job', async (t) => {
  const composition = await compose(t, DESCENDANTS)
  await selectRow(composition, 'agent:child-1')
  const reader = await enterReader(composition)
  const content = surfaceTexts(composition.pane, reader)
  assert.ok(content.includes('Subagent · running'), 'the classification is the row kind')
  assert.ok(content.includes('Stable ID agent:child-1'))
  assert.ok(content.includes('Mode      continuable'), 'the durable mode is stated')
  assert.ok(content.includes('Depth     1'))
  assert.ok(!content.some(line => line.startsWith('Type      bash')), 'no Job kind is borrowed')
  assert.deepEqual(composition.stops, [], 'reading a subagent never interrupts it')
  composition.pane.key('\u001b')
  await waitUntil('the Reader closed', () => composition.pane.closedSurfaceIds().includes(reader))
})

test('a real external leaf is read truthfully and offers no local viewer authority', async (t) => {
  const composition = await compose(t, [...DESCENDANTS, ...EXTERNAL])
  const ids = ((pickerProps(composition.pane, HUB).items ?? []) as Array<{ id: string }>).map(item => item.id)
  const externalId = ids.find(id => id.includes('external-1'))
  assert.ok(externalId !== undefined, `the external leaf is a projected row: ${ids.join(',')}`)
  await selectRow(composition, externalId)
  const reader = await enterReader(composition)
  const content = surfaceTexts(composition.pane, reader)
  assert.ok(content.includes('External'), 'the external classification is stated')
  assert.ok(content.includes('Mode      external'), 'the durable external mode is a fact')
  assert.ok(!content.some(line => line.startsWith('Access')), 'no local access is invented')
  assert.ok(!JSON.stringify(surfaceNodes(composition.pane, reader)).includes('interactive-direct-child'),
    'the external row never claims a local child Session')
  composition.pane.key('\u001b')
  await waitUntil('the Reader closed', () => composition.pane.closedSurfaceIds().includes(reader))
})

test('a real parked Question row is read as human attention and offers no answer control', async (t) => {
  const composition = await compose(t, DESCENDANTS, [
    {
      sessionId: 'sess-main',
      callId: 'call-1',
      presentation: 'parked',
      questions: [{ id: 'q1', header: 'Choose a deployment region', question: 'Which region should ship?' }],
    },
  ])
  const ids = ((pickerProps(composition.pane, HUB).items ?? []) as Array<{ id: string }>).map(item => item.id)
  const questionId = ids.find(id => id.startsWith('question:'))
  assert.ok(questionId !== undefined, `the real Question attention row is projected: ${ids.join(',')}`)
  await selectRow(composition, questionId)
  const reader = await enterReader(composition)
  const content = surfaceTexts(composition.pane, reader)
  assert.ok(content.includes('Question · awaiting answer'), 'the row is classified as human attention')
  assert.ok(content.some(line => line.startsWith('Stable ID question:')), 'the row identity is the authority value')
  const wire = JSON.stringify(surfaceNodes(composition.pane, reader))
  for (const control of ['Answer', 'Respond', 'Skip', 'Awaiting input']) {
    assert.ok(!wire.includes(`"${control}"`), `the Reader paints no ${control} control`)
  }
  assert.deepEqual(composition.stops, [], 'reading a Question never stops or answers it')
  composition.pane.key('\u001b')
  await waitUntil('the Reader closed', () => composition.pane.closedSurfaceIds().includes(reader))
})

test('a real background Job update repaints the open Reader without a new reading', async (t) => {
  const composition = await compose(t, DESCENDANTS)
  await selectRow(composition, 'job:job-1')
  const reader = await enterReader(composition)
  assert.ok(surfaceTexts(composition.pane, reader).includes('Job · running'))
  const openedScreens = composition.pane.openSurfaces().filter(entry => entry.mode === 'screen').length

  composition.setJobs([
    { id: 'job-1', kind: 'bash', label: 'integration build', status: 'failed', startedAt: 1_000, finishedAt: 9_000, detail: 'exit code 2' },
    JOBS[1]!,
  ])
  composition.tasks.openTasksBrowser('full')
  await waitUntil('the reader repaints the real status change', () =>
    surfaceTexts(composition.pane, reader).includes('Job · failed'))

  const content = surfaceTexts(composition.pane, reader)
  assert.ok(content.includes('exit code 2'), 'the new real detail is projected')
  assert.ok(content.includes('Finished  1970-01-01T00:00:09.000Z'), 'the real finish time reaches the Reader')
  assert.deepEqual(composition.scrollOps(reader), ['start'], 'the repaint never resets the reading anchor')
  assert.equal(composition.pane.openSurfaces().filter(entry => entry.mode === 'screen').length, openedScreens,
    'no second Screen was acquired for the update')
  assert.deepEqual(composition.stops, [], 'a failed Job is never stopped by rendering it')
})
