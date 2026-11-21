/**
 * Mouse PR4 real-client subject: the PRODUCTION TSP renderer with the
 * first-party Tasks status segment carrying its click action.
 *
 * It mounts the shipped `mountTspRenderer`, installs the read-only status
 * reader through the shipped `bindStatusReader`, binds the application input
 * contract through the shipped `bindInput` (the production requirement for any
 * click admission), and drives the shipped display completion point. Every node
 * the client paints therefore comes from the production `dockView()` and the
 * production `nativeStatuslineRows()`; the fixture supplies only the
 * `StatusSnapshot` the surface would have written and the answer to the one
 * business-entry question.
 *
 * The sibling A/B case is the SAME fixture with `tasksBrowserUiAvailable()`
 * returning false: the identical badge must then carry no action at all. A flow
 * that did not compare both would not discriminate the action from the text.
 *
 * `TERN_TSP7_CASE` (or the run directory's `case` file) selects:
 *   action — the registered `/tasks` entry is available: the badge is clickable
 *   inert  — the same facts, no entry: the badge must stay status-only
 *
 * Usage: node --import tsx/esm scripts/tern-pane-tasks-action-subject.mts
 * @module scripts/tern-pane-tasks-action-subject
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { deriveActivityStatus } from '../src/domain/status/derive-activity.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
const caseFile = `${dir}/case`
const testCase = (existsSync(caseFile) ? readFileSync(caseFile, 'utf8').trim() : '')
  || process.env.TERN_TSP7_CASE || 'action'

/** The one fixture: a main subject with a real running Task roster. */
function snapshot(): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    workspace: { cwd: '/workspaces/status-line', branch: 'statusline-evidence' },
    access: { permissionPreset: { id: 'workspace-write' } },
    activity: deriveActivityStatus(
      { working: true, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
      true,
      { queuedCount: 0, taskCount: 2, childAgentCount: 1, taskTotalCount: 4, childAgentTotalCount: 3, todoCount: 0 },
    ),
    usage: { ...base.usage, context: { usedTokens: 250_000, windowTokens: 1_000_000, percent: 25 } },
  } as unknown as StatusSnapshot
}

const session = await connect({ app: 'tasks-action-evidence', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')

let closing: Promise<void> | undefined
function shutdown(reason: string): Promise<void> {
  closing ??= (async () => {
    note({ closed: true, reason })
    await renderer.dispose()
  })()
  return closing
}

const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit: () => { process.exitCode = 0; shutdown('exit-requested') },
})

const current = snapshot()
renderer.bindStatusReader({ snapshot: () => current })
// The application input contract. Only the Tasks entry is exercised by this
// subject; the remaining members are the inert shape the production binding
// always supplies. Availability is the A/B switch of this subject.
renderer.bindInput({
  exit: () => { void shutdown('input-exit') },
  cancel: () => {},
  submit: () => {},
  steer: () => {},
  pasteMedia: () => {},
  pastedPath: () => {},
  admitPastedPathDelivery: () => true,
  shouldRememberInput: () => true,
  noteUserInput: () => {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  openModelPicker: () => {},
  openModelQuick: () => {},
  openSessionBrowser: () => {},
  sessionBrowserAvailable: () => false,
  openTasksBrowserUi: () => { note({ tasksOpen: 1 }) },
  tasksBrowserUiAvailable: () => testCase === 'action',
})
renderer.display.commitStatusFacts({ sessionTitle: `tasks-action ${testCase}` })
renderer.display.commitDisplaySubject({}, {}, undefined)
note({ ready: true, case: testCase })

await new Promise((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
