/**
 * S5-PR4 L6: the Schedule workspace's ONE physical-screen lease.
 *
 * `/schedule` must reuse the repository's single `leaseWorkspaceScreen`
 * primitive: it is mutually exclusive with the Settings/Image/Job workspaces,
 * it closes exactly once through its own close path, a superseded handle can
 * never repaint, and the final teardown closes it (which is what disposes the
 * controller through `onClose`).
 *
 * @module @xmoon76/dsh-pi-tui/schedule-workspace-lease.test
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp, type ScheduleWorkspaceBindings } from '../../src/tui-app.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import type {
  ScheduleIntent,
  ScheduleWorkspaceSnapshot,
} from '../../src/app/schedule/presentation.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => { disposeStartedApps() })

function snapshot(overrides: Partial<ScheduleWorkspaceSnapshot> = {}): ScheduleWorkspaceSnapshot {
  return {
    status: 'ready',
    filter: 'all',
    query: '',
    rows: [],
    total: 0,
    mode: 'list',
    sessions: [],
    busy: false,
    pageEpoch: 0,
    ...overrides,
  }
}

function bindings(overrides: Partial<ScheduleWorkspaceBindings> & { readonly onClose?: () => void } = {}): {
  readonly bindings: ScheduleWorkspaceBindings
  readonly dispatches: ScheduleIntent[]
} {
  const dispatches: ScheduleIntent[] = []
  return {
    dispatches,
    bindings: {
      snapshot: () => snapshot(),
      dispatch: intent => { dispatches.push(intent) },
      ...overrides,
    },
  }
}

function startApp(): { readonly vt: VirtualTerminal; readonly app: TuiApp } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

test('the Schedule workspace is the ONE leased screen with exactly-once close', async () => {
  const { vt, app } = startApp()
  let closes = 0
  const bound = bindings({ onClose: () => { closes += 1 } })
  const handle = app.openScheduleWorkspace(bound.bindings)
  // The lease paints the panel as the physical root.
  await vt.waitForRender()
  const frame = vt.getViewport().map(stripTerminalSequences).join('\n')
  assert.match(frame, /Schedule · Host tasks/u, `the leased panel is painted:\n${frame}`)

  // ONE workspace owns the terminal: a second lease is refused, never nested.
  assert.throws(() => app.openScheduleWorkspace(bindings().bindings), /a workspace screen is already leased/u)

  // The handle publishes a newer snapshot and is inert once superseded.
  handle.update(snapshot({ status: 'stale' }))
  handle.close()
  assert.equal(closes, 1, 'the close path notifies exactly once')
  handle.update(snapshot({ mode: 'detail' }))
  handle.close()
  assert.equal(closes, 1, 'a closed handle can never repaint or double-close')
})

test('the app teardown closes the Schedule lease through the shared owner', () => {
  const { app } = startApp()
  let closes = 0
  app.openScheduleWorkspace(bindings({ onClose: () => { closes += 1 } }).bindings)
  app.dispose()
  assert.equal(closes, 1, 'final disposal closes the leased workspace exactly once')
})
