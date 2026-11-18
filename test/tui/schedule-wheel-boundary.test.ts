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

test('a zero-effect boundary wheel keeps the legitimate same-cell list press', async () => {
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

test('boundary/no-op wheels keep the legitimate press in the other modes too (no over-retirement)', async () => {
  // A longer list + a help page long enough to scroll + an editor whose caret
  // sits at the end (the caret-follow reveal clamps every wheel back): in all
  // three the wheel changes the raw offset but the PAINTED window stays put.
  const rows = Array.from({ length: 40 }, (_, index) => ({
    ...task({ id: `task-${index}`, title: `Task ${String(index).padStart(2, '0')}` }),
    prompt: index === 0 ? Array.from({ length: 60 }, (_, line) => `caret proof line ${String(line).padStart(2, '0')}`).join('\n') : 'short prompt',
  }))
  const portWithRows = {
    ...port,
    async catalog() { return rows },
    async list() { return { items: rows, shown: rows.length, total: rows.length, limit: 100, offset: 0 } },
    async view() { return rows[0] },
  }
  const controller = new ScheduleWorkspaceController({
    port: portWithRows as never,
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
    const rowsOf = (): string[] => vt.getViewport().map(stripTerminalSequences)
    const window = (pattern: RegExp): string => rowsOf().map(line => pattern.exec(line)?.[1]).filter((v): v is string => v !== undefined).join(',')
    const press = (row: number, col: number): void => { vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`) }
    const release = (row: number, col: number): void => { vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`) }
    const wheel = (row: number, col: number): void => { vt.sendInput(`\x1b[<65;${col + 1};${row + 1}M`) }

    // ── List at the BOTTOM: wheel-down is clamped (the window cannot move) ──
    for (let step = 0; step < 80; step += 1) vt.sendInput(`\x1b[<65;6;10M`)
    await vt.waitForRender()
    const listWindow = window(/Task (\d{2})/)
    const listRow = rowsOf().findIndex(line => /Task \d{2}/.test(line))
    const listCol = rowsOf()[listRow]!.indexOf('Task ')
    // Press a visible task row, then a bottom-boundary wheel, then release.
    press(listRow, listCol + 2)
    wheel(listRow + 2, 6)
    await vt.waitForRender()
    assert.equal(window(/Task (\d{2})/), listWindow, 'the bottom-boundary list wheel left the painted list window unchanged')
    release(listRow, listCol + 2)
    await vt.waitForRender()
    assert.equal(controller.snapshot().mode, 'detail', 'a clamped bottom-boundary list wheel keeps the legitimate row press')

    // ── Help at the BOTTOM: the down wheel is clamped ──
    vt.sendInput('\x1b')
    await vt.waitForRender()
    vt.sendInput('\t')
    await vt.waitForRender()
    vt.sendInput('?')
    await vt.waitForRender()
    for (let step = 0; step < 80; step += 1) vt.sendInput(`\x1b[<65;20;10M`)
    await vt.waitForRender()
    const helpRow = rowsOf().findIndex(line => line.includes('Esc close help'))
    const helpCol = rowsOf()[helpRow]!.indexOf('Esc close help')
    const beforeHelp = rowsOf().join('\n')
    press(helpRow, helpCol)
    wheel(Math.max(2, helpRow - 2), 20)
    await vt.waitForRender()
    assert.equal(rowsOf().join('\n'), beforeHelp, 'the bottom-boundary help wheel left the painted Help page unchanged')
    release(helpRow, helpCol)
    await vt.waitForRender()
    assert.notEqual(controller.snapshot().mode, 'help', 'a clamped bottom-boundary help wheel keeps the legitimate close-help press')

    // ── RAW Editor: caret at the end, the reveal clamps every wheel back ──
    vt.sendInput('\r')
    await vt.waitForRender()
    vt.sendInput('e')
    await vt.waitForRender()
    assert.equal(controller.snapshot().mode, 'editor', 'the editor page is open')
    // Tab from Title to the Instruction RAW textarea, then walk the caret to
    // the LAST line: the caret-follow reveal anchors the window on that line.
    vt.sendInput('\t')
    await vt.waitForRender()
    for (let step = 0; step < 60; step += 1) vt.sendInput('\x1b[B')
    await vt.waitForRender()
    assert.ok(rowsOf().some(line => line.includes('caret proof line 59')), 'the caret-follow window is anchored on the last line')
    const escRow = rowsOf().findIndex(line => line.includes('Esc back'))
    const escCol = rowsOf()[escRow]!.indexOf('Esc back')
    const beforeEditor = rowsOf().join('\n')
    press(escRow, escCol)
    // The bottom caret makes a wheel-UP window move get revealed back to the
    // caret: the painted window must not change, so the press stays valid.
    vt.sendInput(`\x1b[<64;30;${Math.max(2, escRow - 2)}M`)
    await vt.waitForRender()
    assert.equal(rowsOf().join('\n'), beforeEditor, 'the caret-reveal-clamped wheel left the painted editor window unchanged')
    release(escRow, escCol)
    await vt.waitForRender()
    assert.notEqual(controller.snapshot().mode, 'editor', 'a caret-reveal-clamped wheel keeps the legitimate Esc-back press')
  } finally {
    unsubscribe()
    app.dispose()
    controller.dispose()
  }
})
