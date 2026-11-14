/**
 * FR2 real Fullscreen pointer route: the mounted `TuiApp` + `VirtualTerminal`
 * SGR mouse path through the REAL Task Center overlay and `TaskBrowserPanel`.
 * Proves a press→repaint→release sequence still commits the pressed Team task
 * (the last-painted gesture identity survives the press-triggered repaint).
 *
 * @module @xmoon76/dsh-pi-tui/task-center-pointer.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import { createTaskRuntime, type TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import { pituiTaskCenterPresentation } from '../../src/app/surface/task-presentation-pitui.ts'
import { pituiDisplaySeam } from '../../src/app/surface/display-seam-pitui.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => { disposeStartedApps() })

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('real Fullscreen SGR press → repaint → release expands the pressed Team task', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {})
  app.start()
  startedApps.add(app)
  const subject = {} as SessionSubject
  const source: TaskSurfaceSource = {
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
      readTask: async () => ({ parentSessionId: 'sess-main', parentAvailable: true, descendants: [], jobs: [] }),
      activityOf: () => 'running',
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
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => pituiDisplaySeam(app),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
    publishActivity: () => {},
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  await flush()

  app.setFullscreen(true)
  await vt.waitForRender()
  tasks.openTasksBrowser('full')
  await vt.waitForRender()
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
