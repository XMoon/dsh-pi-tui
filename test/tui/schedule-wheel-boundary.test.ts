/**
 * PR-4 R3 boundary control: a zero-effect wheel must keep the legitimate
 * same-cell press (the wheel only retires a gesture when the pointed pane's
 * viewport really moved). Kept in its own file/process so the SGR input route
 * is not affected by the large schedule matrix' preceding tests.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-wheel-boundary.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import type { ScheduleCatalogEntry } from '../../src/app/schedule/presentation.ts'
import { ScheduleWorkspaceController } from '../../src/app/schedule/workspace-controller.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const task = (overrides: { readonly id: string; readonly title: string }): ScheduleCatalogEntry => ({
  id: overrides.id,
  title: overrides.title,
  kind: 'daily',
  time: '09:00:00',
  timeZone: 'Asia/Shanghai',
  scheduledAt: '2026-06-01T09:00:00.000Z',
  prompt: 'prompt',
  target: { kind: 'session', sessionId: 'session-target' },
  involvedSessionIds: [],
  status: 'active',
  updatedAt: '2026-06-01T08:00:00.000Z',
} as unknown as ScheduleCatalogEntry)

const port = {
  async catalog() { return [task({ id: 'task-alpha', title: 'Alpha report' })] },
  async list() { const rows = [task({ id: 'task-alpha', title: 'Alpha report' })]; return { items: rows, shown: rows.length, total: rows.length, limit: 100, offset: 0 } },
  async view() { return task({ id: 'task-alpha', title: 'Alpha report' }) },
  async history(request: { readonly id: string }) { return { id: request.id, status: 'ready', nextBefore: null, records: [] } },
  async deliveryLimits() { return { newSessionIntervalSeconds: 60 } },
  async create(request: unknown) { return request },
  async edit(request: unknown) { return request },
  async run() { return task({ id: 'task-alpha', title: 'Alpha report' }) },
  async deleteInactive() { return { deleted: 0 } },
  onChanged() { return () => {} },
}

test('PR-4 R3: a zero-effect boundary wheel keeps the legitimate same-cell list press', async () => {
  const controller = new ScheduleWorkspaceController({
    port: port as never,
    sessionReader: {} as never,
    runOwned: (_label, run) => { void run() },
    captureSessionSwitch: () => async () => ({ kind: 'failed', message: 'unused' }),
    closeWorkspace: () => {},
  })
  controller.open()
  const vt = new VirtualTerminal(120, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const handle = app.openScheduleWorkspace({
    snapshot: () => controller.snapshot(),
    dispatch: intent => { controller.dispatch(intent) },
    onClose: () => {},
  })
  const unsubscribe = controller.subscribe(() => handle.update(controller.snapshot()))
  try {
    await controller.whenIdle()
    handle.update(controller.snapshot())
    for (let turn = 0; turn < 6; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
      await vt.waitForRender()
    }
    const rows = (): string[] => vt.getViewport().map(stripTerminalSequences)
    const row = rows().findIndex(line => line.includes('Alpha report'))
    assert.ok(row >= 0, `the list row is painted:\n${rows().join('\n')}`)
    const column = rows()[row]!.indexOf('Alpha report')
    const press = (): void => { vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`) }
    const release = (): void => { vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`) }
    press()
    await vt.waitForRender()
    const beforeWheel = rows().join('\n')
    vt.sendInput(`\x1b[<64;6;${Math.min(row + 2, rows().length - 2)}M`)
    await vt.waitForRender()
    assert.equal(rows().join('\n'), beforeWheel, 'the top-boundary wheel changed nothing')
    release()
    await vt.waitForRender()
    assert.equal(controller.snapshot().mode, 'detail', 'a zero-effect wheel keeps the legitimate same-cell row press')
  } finally {
    unsubscribe()
    app.dispose()
    controller.dispose()
  }
})
