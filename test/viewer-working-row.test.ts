/**
 * UX-1 (three-UX-fixes plan §4): the working row follows the COMMITTED display
 * subject. On the main subject the Main machine facts drive it unchanged; in the
 * child viewer the SAME row shows the displayed child's own activity while the
 * public extension `activity.working` and `session.busy` keep reporting the
 * LIVE/Main session.
 *
 * The row is read from the rendered viewport (the zero-row inactive state is a
 * real disappearance, not a label change) and the extension facts from the real
 * `SurfaceHost` snapshot.
 * @module @xmoon76/dsh-pi-tui/viewer-working-row.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Text, stripTerminalSequences } from '@xmoon76/pi-tui'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { TuiApp } from '../src/tui-app.ts'
import {
  enterChildDisplaySubject,
  exitChildDisplaySubject,
  type ChildDisplaySubject,
} from './support/display-subject.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Every TuiApp constructed here is disposed after each test — the process
 *  slot (the vendored fork keybindings are process-global) is released only by
 *  the FINAL dispose, never by stop() (see src/tui/process-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(): { vt: VirtualTerminal; app: TuiApp; host: SurfaceHost } {
  const vt = new VirtualTerminal(90, 24)
  const ledger = new ExtensionLedger(() => {})
  const host = new SurfaceHost(ledger, () => app.requestRender())
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  startedApps.add(app)
  return { vt, app, host }
}

async function view(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().map(line => stripTerminalSequences(line)).join('\n')
}

const CHILD_A: ChildDisplaySubject = {
  id: 'child-a', label: 'child A', mode: 'continuable', activity: 'running',
  cwd: '/ws/a', turns: 1, steps: 1,
}
const CHILD_B: ChildDisplaySubject = {
  id: 'child-b', label: 'child B', mode: 'continuable', activity: 'inactive',
  cwd: '/ws/b', turns: 1, steps: 1,
}

/** Commit ONLY the child's activity flip — no `setViewerMode` call, so the
 *  viewer's own entry-time activity snapshot (`viewerMode.activity`) keeps its
 *  stale value, exactly like the official Remote snapshot channel. */
function commitChildActivity(app: TuiApp, activity: 'running' | 'inactive', child = CHILD_A): void {
  app.commitDisplaySubject(
    { view: { subject: { kind: 'subagent', id: child.id, label: child.label, mode: child.mode, activity } } },
    {},
    { sessionId: child.id, workspaceRoot: child.cwd, title: '', todos: [], goal: undefined },
  )
}

test('main running + child inactive: the child surface hides the Main working row and its compaction label', async () => {
  const { vt, app, host } = startApp()
  app.setWorking(true)
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 90, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  assert.ok((await view(vt)).includes('Working...'), 'precondition: the Main working row is visible')
  enterChildDisplaySubject(app, { ...CHILD_A, activity: 'inactive' })
  const childView = await view(vt)
  assert.ok(!childView.includes('Working...'), `the child surface must hide the Main working row:\n${childView}`)
  // A Main compaction running underneath must neither show its label nor its
  // progress suffix on the child surface.
  app.setCompactionPhase('summarizing')
  const compacting = await view(vt)
  assert.ok(!compacting.includes('Compacting context…'),
    `the Main compaction label must not leak into the child surface:\n${compacting}`)
  assert.ok(!compacting.includes('Working...'),
    `the child surface must stay clear while the child is inactive:\n${compacting}`)
  // The extension keeps reporting the LIVE/Main session.
  assert.equal(host.state().activity.working, true,
    'activity.working is the LIVE session activity, never the visible child row')
  assert.equal(host.state().session.busy, false, 'the session busy flag is untouched')
  app.setBusy(true)
  assert.equal(host.state().session.busy, true, 'setBusy keeps reporting the LIVE session')
  app.setBusy(false)
})

test('main idle + child running: the child surface shows the child row while extension activity.working stays false', async () => {
  const { vt, app, host } = startApp()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 90, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  enterChildDisplaySubject(app, { ...CHILD_A, activity: 'running' })
  const running = await view(vt)
  assert.ok(running.includes('Working...'), `the child working row must render:\n${running}`)
  assert.equal(host.state().activity.working, false,
    'the LIVE session is idle, so activity.working must stay false')
  // A plugin working-label override relabels the MAIN row only: it must never
  // replace the child's own `Working...` label.
  app.advancedHostStateForTest().setWorkingMessage('plugin working')
  const overridden = await view(vt)
  assert.ok(overridden.includes('Working...') && !overridden.includes('plugin working'),
    `the plugin override must not leak into the child surface:\n${overridden}`)
  app.advancedHostStateForTest().setWorkingMessage(undefined)
  // The child going inactive clears the row again.
  commitChildActivity(app, 'inactive')
  const cleared = await view(vt)
  assert.ok(!cleared.includes('Working...'), `the inactive child must clear the row:\n${cleared}`)
})

test('both running shows exactly one row; both idle shows none', async () => {
  const { vt, app, host } = startApp()
  app.setWorking(true)
  enterChildDisplaySubject(app, { ...CHILD_A, activity: 'running' })
  const both = await view(vt)
  assert.equal(both.split('Working...').length - 1, 1,
    `exactly one working row may render:\n${both}`)
  assert.equal(host.state().activity.working, true)
  app.setWorking(false)
  commitChildActivity(app, 'inactive')
  const idle = await view(vt)
  assert.ok(!idle.includes('Working...'), `both idle must render no working row:\n${idle}`)
  assert.equal(host.state().activity.working, false)
})

test('the committed display subject owns the row, not the viewer entry-time activity snapshot', async () => {
  const { vt, app } = startApp()
  // Enter with the child committed INACTIVE: the row is hidden.
  enterChildDisplaySubject(app, { ...CHILD_A, activity: 'inactive' })
  assert.ok(!(await view(vt)).includes('Working...'),
    'precondition: the inactive child renders no row')
  // The official Remote Session-snapshot flip alone (`onSessionSnapshotChanged`
  // → `refreshStatus`): only the view subject changes, `viewerMode.activity`
  // keeps the stale 'inactive' entry value. The row must follow the committed
  // subject.
  commitChildActivity(app, 'running')
  assert.ok((await view(vt)).includes('Working...'),
    'a subject-activity flip alone must reveal the row')
  commitChildActivity(app, 'inactive')
  assert.ok(!(await view(vt)).includes('Working...'),
    'the reverse flip must clear the row again')
})

test('child A -> child B follows the newly displayed child immediately', async () => {
  const { vt, app } = startApp()
  enterChildDisplaySubject(app, { ...CHILD_A, activity: 'running' })
  assert.ok((await view(vt)).includes('Working...'), 'precondition: child A is running')
  // The production switch is setViewerMode(B) + the atomic child-B commit.
  enterChildDisplaySubject(app, { ...CHILD_B, activity: 'inactive' })
  const bView = await view(vt)
  assert.ok(!bView.includes('Working...'),
    `child B is inactive, so A's running row must not linger:\n${bView}`)
  assert.ok(bView.includes('child B'), `the subject bar must show B:\n${bView}`)
})

test('exit restores the LATEST Main working state, not the entry-time snapshot', async () => {
  const { vt, app } = startApp()
  // Main is idle at entry; the child runs.
  enterChildDisplaySubject(app, { ...CHILD_A, activity: 'running' })
  assert.ok((await view(vt)).includes('Working...'), 'precondition: the child row is visible')
  // Main turns run, then compact, entirely WHILE the child owns the surface.
  app.setWorking(true)
  app.setCompactionPhase('summarizing')
  app.setSubmitPending('queued')
  const childView = await view(vt)
  assert.ok(childView.includes('Working...') && !childView.includes('Queued…')
    && !childView.includes('Compacting context…'),
  `the Main drivers must not leak into the child surface:\n${childView}`)
  // Exit: the Main subject commit re-derives the row from the LATEST fields.
  exitChildDisplaySubject(app)
  const mainView = await view(vt)
  assert.ok(mainView.includes('Queued…'),
    `the LATEST Main pending label must return on exit:\n${mainView}`)
  app.setSubmitPending(undefined)
  app.setCompactionPhase('applying')
  const applying = await view(vt)
  assert.ok(applying.includes('Applying compacted context…'),
    `the LATEST Main compaction stage must return on exit:\n${applying}`)
})
