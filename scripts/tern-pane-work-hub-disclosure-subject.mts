/**
 * PR3 real-client subject: the PRODUCTION TSP Work Hub with the retained-Job
 * disclosure.
 *
 * It mounts the shipped `mountTspRenderer`, binds the application input
 * contract (the production requirement for any key/action admission) and opens
 * the ONE Work Hub through `renderer.taskPresentation.openBrowser()` with
 * already-committed `TaskPanelItem` facts — the same values the production
 * `TaskRuntime` publishes. Every painted node therefore comes from the real
 * `src/tui/tsp/work-hub.ts`; the fixture supplies only the committed row set.
 *
 * `case` (run directory or `TERN_PANE_CASE`) selects the fixture:
 *   full          a Question, a three-depth Subagent tree, one active Job and
 *                 two retained terminal Jobs (the default collapsed view)
 *   history-only  only retained terminal Jobs (no active work)
 *   empty         a genuinely empty roster
 *   long          a long Subagent tree plus the same active/terminal Jobs
 *   scoped        a Workflow-style child subset with no Jobs at all
 *   baseline      the pre-PR visible shape (all rows, Close + View details only):
 *                 the terminal Jobs carry `active: true` in this FIXTURE ONLY so
 *                 the same production presenter paints the historical first
 *                 screen for the PR's before/after screenshot comparison
 *
 * The flow reads `events.jsonl` back as the subject's own positive control:
 * `select`, `stop`, `expose` and `refresh` must all stay zero for every local
 * disclosure/Reader gesture; only `retire` records the real user close.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-work-hub-disclosure-subject.mts
 * @module scripts/tern-pane-work-hub-disclosure-subject
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import type { TaskPanelItem } from '../src/app/surface/task-presentation.ts'
import type { TaskBrowserPresentationOpen } from '../src/app/surface/task-presentation-port.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => { appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`) }
const caseFile = `${dir}/case`
const CASE = (existsSync(caseFile) ? readFileSync(caseFile, 'utf8').trim() : '') || process.env.TERN_PANE_CASE || 'full'

const question = (): TaskPanelItem => ({
  value: 'question:sess-a:call-a',
  label: 'confirm deployment',
  status: 'awaiting answer',
  source: 'question',
  group: 'Needs attention',
  canStop: false,
  active: false,
})

const subagents = (): TaskPanelItem[] => [
  {
    value: 'agent:build-plan', label: 'subagent · build plan', status: 'inactive', source: 'subagent',
    type: 'subagent', mode: 'continuable', suffix: 'continuable', depth: 1, treePrefix: '▾ ',
    active: false, hasChildren: true,
  },
  {
    value: 'agent:implement', label: 'subagent · implement', status: 'running', source: 'subagent',
    type: 'subagent', mode: 'one-shot', suffix: 'one-shot', depth: 2, treePrefix: '  ├ ',
    parentId: 'agent:build-plan', parentLabel: 'subagent · build plan', active: true,
  },
  {
    value: 'agent:test', label: 'subagent · test', status: 'inactive', source: 'subagent',
    type: 'subagent', mode: 'one-shot', suffix: 'one-shot', depth: 3, treePrefix: '  │ └ ',
    parentId: 'agent:implement', parentLabel: 'subagent · implement', active: false,
  },
]

const jobs = (): TaskPanelItem[] => [
  { value: 'job:run', label: 'bash · compile', status: 'running', source: 'job', type: 'bash', active: true },
  { value: 'job:done', label: 'bash · old lint', status: 'completed', source: 'job', type: 'bash', active: false },
  { value: 'job:failed', label: 'bash · deploy', status: 'failed', source: 'job', type: 'bash', active: false, attention: true },
]

const longTree = (): TaskPanelItem[] => [
  ...Array.from({ length: 12 }, (_, index) => ({
    value: `agent:deep-${index + 1}`,
    label: `subagent · ${{ 0: 'plan', 1: 'implement', 2: 'test', 3: 'review' }[index % 4] ?? 'work'} ${index + 1}`,
    status: index % 3 === 0 ? 'running' : 'inactive',
    source: 'subagent' as const,
    type: 'subagent',
    mode: index % 2 === 0 ? 'continuable' : 'one-shot',
    suffix: index % 2 === 0 ? 'continuable' : 'one-shot',
    depth: (index % 3) + 1,
    treePrefix: `${'  '.repeat(index % 3)}${index % 3 === 0 ? '▾' : '└'} `,
    active: index === 0,
  })),
  ...jobs(),
]

const fixture = (): TaskPanelItem[] => {
  if (CASE === 'empty') return []
  if (CASE === 'history-only') return jobs().filter(item => item.active !== true)
  if (CASE === 'long') return longTree()
  if (CASE === 'scoped') return subagents()
  if (CASE === 'baseline') {
    return [question(), ...subagents(), ...jobs().map(item => item.active === true ? item : { ...item, active: true })]
  }
  return [question(), ...subagents(), ...jobs()]
}

const session = await connect({ app: 'pr3-work-hub-disclosure', timeout: 2000 })
if (session === null) throw new Error('this subject must run inside a real Tern pane')
note({ caps: session.caps })

let disposed = false
const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit: () => { process.exitCode = 0 },
})
renderer.bindInput({
  exit() {},
  cancel() {},
  submit() {},
  steer() {},
  pasteMedia() {},
  pastedPath() {},
  admitPastedPathDelivery: () => true,
  shouldRememberInput: () => true,
  noteUserInput() {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  openModelPicker() {},
  openModelQuick() {},
  openSessionBrowser() {},
  sessionBrowserAvailable: () => false,
  openTasksBrowserUi() {},
  tasksBrowserUiAvailable: () => true,
})

const options: TaskBrowserPresentationOpen = {
  header: 'Tasks',
  mode: 'full',
  openedFrom: 'command',
  scope: 'all',
  enableSearch: true,
  expandedIds: [],
  collapsedIds: [],
  maxVisible: 18,
  loading: false,
  groupLabels: true,
  onRefresh: () => note({ refresh: 1 }),
  onStop: value => note({ stop: value }),
  onViewportExpose: ids => note({ expose: [...ids] }),
  onRetired: reason => note({ retired: reason }),
}

renderer.taskPresentation.openBrowser(
  fixture(),
  value => { note({ select: value }); return 'close' },
  () => note({ close: 1 }),
  options,
)
note({ ready: true, case: CASE, opened: true })

const shutdown = async (reason: string): Promise<void> => {
  if (disposed) return
  disposed = true
  note({ closed: true, reason })
  await renderer.dispose()
}
await new Promise<void>((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
