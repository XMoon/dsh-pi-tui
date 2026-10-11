/**
 * PR-E modal affordance tests (Phase 3A Track C): the footer's Task Center
 * `↓ view` (and the compact `↓` form) must be advertised only where the ↓
 * task-browser trigger can really fire — an EMPTY prompt-mode seat editor
 * with active tasks and NO Question / Approval / Save Location capture.
 * The upstream owner is `TuiApp.taskBrowserAvailable()`, the single
 * classifier behind both the full and the compact builtin task item.
 *
 * Every modal is entered through its production API (`askQuestions` /
 * `showApprovalPrompt` / `askSaveLocation`), never by injecting a blocking
 * boolean; the parked `?N` / failure `!N` attention projections must
 * survive the suppression (only the actionable hint is gated). The
 * assertions read the PAINTED footer, not the private classifier: the
 * user-visible contract is the footer text plus the real ↓ route.
 *
 * Evidence level: L6 UI application-composition (real TuiApp +
 * VirtualTerminal + live FooterComposer/StatusStore subscription +
 * handleInputCore ladder). The onOpenTasks spy is the UI event sink; the
 * real Task Center assembly is covered by the runner/task-runtime fixtures.
 * @module @xmoon76/dsh-pi-tui/surface-modal-affordance.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TuiApp, type TuiQuestion, type TuiQuestionAnswer } from '../src/tui-app.ts'
import type { SaveLocationDeps } from '../src/tui/interaction/save-location.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started here is stopped
 * after each test — the process's single-live-TUI slot (the vendored
 * keybindings are process-global) is held only by LIVE surfaces. */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A real app on a virtual terminal with the Task Center sink counted (the
 * runner's `onOpenTasks` opens the Quick browser; the test only counts the
 * dispatch and never fakes the predicate). */
function startApp(options: { width?: number; rows?: number } = {}): {
  vt: VirtualTerminal
  app: TuiApp
  opened: () => number
} {
  const vt = new VirtualTerminal(options.width ?? 100, options.rows ?? 24)
  let opened = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onOpenTasks: () => { opened += 1 },
  })
  app.start()
  startedApps.add(app)
  return { vt, app, opened: () => opened }
}

/** The painted viewport, after the pending frame. */
async function view(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** The non-rich embedder task setter (one running job). */
function oneRunningTask(app: TuiApp): void {
  app.setTasks([{ id: 'job-1', label: 'pnpm build', status: 'running', kind: 'job' }])
}

/** A bounded Save Location fixture over one real temp directory. */
function saveLocationDeps(root: string): SaveLocationDeps {
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  return {
    resolveDirectory: (input) => input === './' ? cwd : join(cwd, input),
    isDirectory: (path) => path === cwd,
    targetExists: () => false,
    complete: async () => null,
  }
}

const yesQuestion = (id: string, question: string): TuiQuestion =>
  ({ id, question, options: [{ label: 'Yes' }] })

/** Ask a real Question through the production flow; the rejection handler
 * keeps a failing assertion reported as the assertion (never as an
 * unhandled rejection when the app is disposed mid-test). */
function askYes(app: TuiApp, id: string, question: string): Promise<TuiQuestionAnswer[]> {
  const promise = app.askQuestions([yesQuestion(id, question)])
  void promise.catch(() => {})
  return promise
}

/** The ↓ routing negative control: the modal must consume the down arrow
 * (no task-browser dispatch). */
async function assertModalConsumesDown(vt: VirtualTerminal, opened: () => number, expected: number): Promise<void> {
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), expected, 'the modal must consume ↓ — no task-browser dispatch')
}

/** Answer the standard single-option Question: choose option 1, then submit
 * the review page. Position-independent — the ↓ negative control may have
 * moved the option cursor. */
async function answerFirstOption(vt: VirtualTerminal): Promise<void> {
  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
}

test('an active Question drops the ↓ view hint and never routes ↓ to the task browser', async () => {
  const { vt, app, opened } = startApp()
  oneRunningTask(app)
  let screen = await view(vt)
  assert.ok(screen.includes('[1 task running · ↓ view]'), `the idle footer must advertise ↓:\n${screen}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'the empty-editor ↓ must open the browser')

  const promise = askYes(app, 'q1', 'proceed?')
  screen = await view(vt)
  assert.ok(screen.includes('proceed?'), `the Question must own the seat:\n${screen}`)
  assert.ok(screen.includes('1 task running'), `the task badge must survive the modal:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `a Question capture must drop the ↓ hint:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 1)
  assert.ok((await view(vt)).includes('proceed?'), 'the Question must stay answerable')
  await answerFirstOption(vt)
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the hint must return once the Question settles:\n${screen}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 2, 'the restored ↓ must reach the sink')
})

test('parked Question attention keeps ?N and the hint; a presented Question only hides the hint', async () => {
  const { vt, app, opened } = startApp()
  app.setQuestionAttention(2)
  let screen = await view(vt)
  assert.ok(screen.includes('? 2 awaiting'), `parked attention must render:\n${screen}`)
  assert.ok(screen.includes('↓ view'), `attention-only state still allows the browser:\n${screen}`)

  const promise = askYes(app, 'q1', 'proceed?')
  screen = await view(vt)
  assert.ok(screen.includes('? 2 awaiting'), `the parked count must not be cleared by the modal:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `the presented Question must drop the hint:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 0)

  await answerFirstOption(vt)
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  screen = await view(vt)
  assert.ok(screen.includes('? 2 awaiting'), `the parked count must survive the round-trip:\n${screen}`)
  assert.ok(screen.includes('↓ view'), `the hint must return once the Question settles:\n${screen}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'the restored ↓ must reach the sink while attention stays parked')
})

test('an active Approval drops the hint in the full and compact footers and keeps its decision keys', async () => {
  const { vt, app, opened } = startApp()
  oneRunningTask(app)
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  let screen = await view(vt)
  assert.ok(screen.includes('Approve bash?'), `the approval dialog missing:\n${screen}`)
  assert.ok(screen.includes('1 task running'), `the task badge must survive the approval:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `an Approval capture must drop the ↓ hint:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 0)
  vt.sendInput('n')
  assert.equal(await decision, 'rejected')
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the hint must return after the Approval settles:\n${screen}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'the restored ↓ must reach the sink')

  // The responsive compact density (`[1t·↓]`) is the second consumer of the
  // same context flag: a pending Approval must drop and restore it too.
  vt.resize(28, 24)
  screen = await view(vt)
  assert.ok(screen.includes('[1t·↓]'), `the compact item must advertise ↓:\n${screen}`)
  const compactDecision = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  screen = await view(vt)
  assert.ok(screen.includes('pprove'), `the narrow approval dialog must stay painted:\n${screen}`)
  assert.ok(!screen.includes('[1t·↓]') && !screen.includes('↓ view'),
    `the compact ↓ must drop under an Approval:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 1)
  vt.sendInput('n')
  assert.equal(await compactDecision, 'rejected')
  screen = await view(vt)
  assert.ok(screen.includes('[1t·↓]'), `the compact ↓ must return after the Approval settles:\n${screen}`)
})

test('a Save Location prompt drops the hint in the full and compact footers and restores it on cancel', async (t) => {
  const life = testLifecycle(t)
  const deps = saveLocationDeps(life.tempDir('dsh-pr-e-save-'))
  const { vt, app, opened } = startApp()
  oneRunningTask(app)
  const promise = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    deps,
  )
  void promise.catch(() => {})
  let screen = await view(vt)
  assert.ok(screen.includes('Save session archive'), `the prompt must own the seat:\n${screen}`)
  assert.ok(screen.includes('1 task running'), `the task badge must survive the prompt:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `a Save Location capture must drop the ↓ hint:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 0)

  vt.sendInput('\x1b')
  assert.deepEqual(await promise, { kind: 'cancelled' })
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the hint must return after the prompt settles:\n${screen}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'the restored ↓ must reach the sink')

  // Same boundary at the compact density.
  vt.resize(28, 24)
  screen = await view(vt)
  assert.ok(screen.includes('[1t·↓]'), `the compact item must advertise ↓:\n${screen}`)
  const compact = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    deps,
  )
  void compact.catch(() => {})
  screen = await view(vt)
  assert.ok(screen.includes('Save session archive'), `the narrow prompt must own the seat:\n${screen}`)
  assert.ok(!screen.includes('[1t·↓]') && !screen.includes('↓ view'),
    `the compact ↓ must drop under a Save Location capture:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 1)
  vt.sendInput('\x1b')
  assert.deepEqual(await compact, { kind: 'cancelled' })
  screen = await view(vt)
  assert.ok(screen.includes('[1t·↓]'), `the compact ↓ must return after the prompt settles:\n${screen}`)
})

test('a queued Question handover never flashes the hint between flows', async () => {
  const { vt, app, opened } = startApp()
  oneRunningTask(app)
  const first = askYes(app, 'q1', 'first?')
  const second = askYes(app, 'q2', 'second?')
  let screen = await view(vt)
  assert.ok(screen.includes('first?'), `the first Question must own the seat:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `the first Question must drop the hint:\n${screen}`)

  await answerFirstOption(vt)
  assert.deepEqual(await first, [{ id: 'q1', selected: ['Yes'] }])
  screen = await view(vt)
  assert.ok(screen.includes('second?'), `the second Question must take the seat:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `the handover must not flash the hint:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 0)

  await answerFirstOption(vt)
  assert.deepEqual(await second, [{ id: 'q2', selected: ['Yes'] }])
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the hint must return after the LAST flow:\n${screen}`)
})

test('a nonCapturing notice keeps the hint while a focused capturing overlay suppresses it', async () => {
  const { vt, app } = startApp()
  oneRunningTask(app)
  const notice = app.showExtensionOverlay(
    { kind: 'text', spans: [{ text: 'notice: build finished' }] },
    { nonCapturing: true },
  )
  let screen = await view(vt)
  assert.ok(screen.includes('notice: build finished'), `the notice must paint:\n${screen}`)
  assert.ok(screen.includes('↓ view'), `a nonCapturing notice must not suppress the hint:\n${screen}`)

  const capturing = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'modal notice' }] })
  screen = await view(vt)
  assert.ok(screen.includes('modal notice'), `the capturing overlay must paint:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `a focused capturing overlay must suppress the hint:\n${screen}`)

  capturing.close()
  notice.close()
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the hint must return once every overlay is gone:\n${screen}`)
})

test('failure and parked attention badges survive a Question; only the hint is gated', async () => {
  const { vt, app, opened } = startApp()
  app.setTaskSummary({
    runningJobs: 0,
    totalJobs: 0,
    runningAgents: 0,
    totalAgents: 0,
    failedAttention: 1,
    failedTotal: 1,
  })
  app.setQuestionAttention(2)
  let screen = await view(vt)
  assert.ok(screen.includes('! 1 failed'), `the failure attention must render:\n${screen}`)
  assert.ok(screen.includes('? 2 awaiting'), `the parked attention must render:\n${screen}`)
  assert.ok(screen.includes('↓ view'), `attention-only state still allows the browser:\n${screen}`)
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(opened(), 1, 'attention-only state must route ↓ to the sink')

  const promise = askYes(app, 'q1', 'proceed?')
  screen = await view(vt)
  assert.ok(screen.includes('! 1 failed'), `the failure attention must survive the modal:\n${screen}`)
  assert.ok(screen.includes('? 2 awaiting'), `the parked attention must survive the modal:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `the presented Question must drop the hint:\n${screen}`)
  await assertModalConsumesDown(vt, opened, 1)

  await answerFirstOption(vt)
  await promise
  screen = await view(vt)
  assert.ok(screen.includes('! 1 failed'), `the failure attention must survive the round-trip:\n${screen}`)
  assert.ok(screen.includes('↓ view'), `the hint must return after the Question settles:\n${screen}`)
})

test('the full, responsive-compact and fullscreen footers hide and restore the hint', async () => {
  const { vt, app } = startApp()
  oneRunningTask(app)
  let screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the default full footer must advertise ↓:\n${screen}`)
  const wideQuestion = askYes(app, 'q1', 'wide?')
  screen = await view(vt)
  assert.ok(!screen.includes('↓ view'), `the full footer Question must drop the hint:\n${screen}`)
  // Enter → cancel → the affordance returns (the plan's enter/reopen axis).
  vt.sendInput('\x1b')
  await assert.rejects(wideQuestion, /cancelled/)
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the full footer hint must return after a cancel:\n${screen}`)

  // Width pressure re-renders the SAME builtin task item at its compact
  // density (`[1t·↓]`): the second consumer of the one context flag.
  vt.resize(28, 24)
  screen = await view(vt)
  assert.ok(screen.includes('[1t·↓]'), `the responsive compact item must advertise ↓:\n${screen}`)
  const narrowQuestion = askYes(app, 'q2', 'narrow?')
  screen = await view(vt)
  // The Question frame's own `↑↓ select` hint is not the footer affordance:
  // assert the footer's two forms specifically.
  assert.ok(!screen.includes('[1t·↓]') && !screen.includes('↓ view'),
    `the compact ↓ must drop under a Question:\n${screen}`)
  await answerFirstOption(vt)
  await narrowQuestion
  screen = await view(vt)
  assert.ok(screen.includes('[1t·↓]'), `the compact ↓ must return after settle:\n${screen}`)

  vt.resize(100, 24)
  app.setFullscreen(true)
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the fullscreen full footer must advertise ↓:\n${screen}`)
  const fullscreenQuestion = askYes(app, 'q3', 'fullscreen?')
  screen = await view(vt)
  assert.ok(screen.includes('fullscreen?'), `the fullscreen Question must own the seat:\n${screen}`)
  assert.ok(!screen.includes('↓ view'), `the fullscreen Question must drop the hint:\n${screen}`)
  await answerFirstOption(vt)
  await fullscreenQuestion
  screen = await view(vt)
  assert.ok(screen.includes('↓ view'), `the fullscreen hint must return after settle:\n${screen}`)
})
