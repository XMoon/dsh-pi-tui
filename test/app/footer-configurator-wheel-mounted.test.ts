/**
 * PR-3 / F3 — the Footer Configurator body wheel through the REAL Settings
 * workspace lease.
 *
 * The composition is the production one: a real `TuiApp` owns the fullscreen
 * `TuiAltScreen`, `app.openSettingsWorkspace` mounts the real
 * `SettingsWorkspacePanel`, and the test's `createFooterConfiguratorPage`
 * factory builds the real `FooterConfiguratorPanel` over the real
 * `FooterConfiguratorModel`, `FooterItemRegistry`, `FooterCustomItemCatalog`
 * and `FooterComposer`. Only the external settings document / save sink is a
 * recording fake, exactly like the command layer's transaction seam.
 *
 * Every pointer step is a REAL SGR sequence delivered through the mounted
 * VirtualTerminal, so this is the Root → Child translation path, not the
 * page-only harness.
 *
 * @module @xmoon76/dsh-pi-tui/app/footer-configurator-wheel-mounted.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp, type SettingsWorkspaceHandle } from '../../src/tui-app.ts'
import { FooterConfiguratorModel } from '../../src/tui/footer/configurator-model.ts'
import { FooterItemRegistry } from '../../src/tui/footer/item-registry.ts'
import { FooterCustomItemCatalog } from '../../src/tui/footer/custom-item-catalog.ts'
import { FooterComposer } from '../../src/tui/footer/composer.ts'
import type { FooterLayoutV1 } from '../../src/domain/footer/layout.ts'
import type { FooterCustomItemSettings } from '../../src/domain/footer/custom-items.ts'
import type {
  SettingsWorkspaceRow,
  SettingsWorkspaceSnapshot,
  SettingsWorkspaceSource,
} from '../../src/tui/panels/settings-workspace-panel.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started, disposeAll } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeAll()
})

const FOOTER_ROW: SettingsWorkspaceRow = {
  id: 'footer-configurator',
  category: 'appearance',
  label: 'Configure footer layout…',
  summary: 'Default footer layout',
  scope: 'Footer runtime · TUI settings document',
  freshness: 'runtime',
  description: 'Open the full-screen footer layout editor.',
  specialist: 'footer-configurator',
  specialistAvailable: true,
}

interface SaveCall {
  readonly layout: FooterLayoutV1
  readonly customItems: readonly FooterCustomItemSettings[] | undefined
}

interface MountedFooter {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly handle: SettingsWorkspaceHandle
  readonly saves: SaveCall[]
  readonly cancels: () => number
  /** Mutable save outcome: set to throw the next attempt. */
  readonly saveError: { value: Error | undefined }
  readonly page: () => FooterConfiguratorModel | undefined
  readonly panel: () => ReturnType<TuiApp['createFooterConfiguratorPanel']> | undefined
  view(): string
  paint(): Promise<void>
  close(): void
}

/** One long custom-item row: the body is really bigger than the child grant. */
function longLayout(count: number): { layout: FooterLayoutV1; custom: FooterCustomItemSettings[] } {
  const custom: FooterCustomItemSettings[] = Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1,
    id: `user:scroll-${String(index).padStart(2, '0')}`,
    kind: 'text',
    text: `value ${index}`,
  }))
  return {
    layout: { schemaVersion: 1, rows: [{ left: custom.map(item => ({ id: item.id })), right: [] }] },
    custom,
  }
}

/** Open the REAL Settings lease with the REAL Footer page factory. */
function mountFooter(options: {
  readonly columns?: number
  readonly rows?: number
  readonly items?: number
  readonly entry?: 'deeplink' | 'row'
  readonly gateSave?: Promise<void>
  /** Reuse a started app (same-app close/reopen currentness); owns it=false. */
  readonly app?: TuiApp
  readonly vt?: VirtualTerminal
} = {}): MountedFooter {
  const columns = options.columns ?? 100
  const rows = options.rows ?? 40
  const vt = options.vt ?? new VirtualTerminal(columns, rows)
  const app = options.app ?? new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  if (options.app === undefined) {
    app.start()
    started.add(app)
  }
  const generated = longLayout(options.items ?? 24)
  app.setFooterCustomItems(generated.custom)
  app.setFooterLayout(generated.layout)
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  const saves: SaveCall[] = []
  const state = { cancels: 0 }
  const saveError: { value: Error | undefined } = { value: undefined }
  let model: FooterConfiguratorModel | undefined
  let panel: ReturnType<TuiApp['createFooterConfiguratorPanel']> | undefined
  const source: SettingsWorkspaceSource = {
    readSnapshot: (): SettingsWorkspaceSnapshot => ({
      configReadiness: 'ready',
      rows: [FOOTER_ROW],
      capturedAt: 1,
    }),
  }
  const createPage = (done: () => void): ReturnType<TuiApp['createFooterConfiguratorPanel']> => {
    const registry = new FooterItemRegistry(app.getFooterItemRegistry())
    const catalog = new FooterCustomItemCatalog(app.getFooterCustomItems())
    registry.setCustomSource(catalog)
    const composer = new FooterComposer(registry)
    model = new FooterConfiguratorModel(app.getEffectiveFooterLayout(), registry, catalog)
    panel = app.createFooterConfiguratorPanel({
      model,
      registry,
      composer,
      sessionOnly: false,
      onSave: async (layout, customItems) => {
        saves.push({ layout, customItems })
        if (saveError.value !== undefined) throw saveError.value
        await options.gateSave
        done()
      },
      onCancel: () => {
        state.cancels += 1
        done()
      },
    })
    return panel
  }
  const handle = app.openSettingsWorkspace(source, {
    aboutVersionFacts: { tui: 'test', dsh: 'test' },
    createFooterConfiguratorPage: (done) => createPage(done),
    ...options.entry === 'row'
      ? { initialRowId: 'footer-configurator' as const }
      : {
          initialRowId: 'footer-configurator' as const,
          initialSpecialist: 'footer-configurator' as const,
        },
  })
  return {
    vt,
    app,
    handle,
    saves,
    cancels: () => state.cancels,
    saveError,
    page: () => model,
    panel: () => panel,
    view: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
    paint: async () => { await vt.waitForRender() },
    close: () => { handle.close() },
  }
}

/** One SGR wheel notch at a real screen row (0-based row; x=5 cells in). */
function wheel(vt: VirtualTerminal, row: number, direction: 'up' | 'down'): void {
  const button = direction === 'up' ? 64 : 65
  vt.sendInput(`\x1b[<${button};6;${row + 1}M`)
}

/** The screen row of the first painted line containing `needle`. */
function rowOf(view: string, needle: string): number {
  const row = view.split('\n').findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the frame paints ${JSON.stringify(needle)}:\n${view}`)
  return row
}

test('the real Settings root delegates the wheel to the Footer body and the fixed shell stays', async () => {
  const h = mountFooter({ columns: 100, rows: 40, items: 32 })
  await h.handle.whenInitialSpecialistSettled()
  await h.paint()
  // The page opens on the Row Selector; Enter opens Row 1 (the long body).
  h.vt.sendInput('\r')
  await h.paint()
  const before = h.view()
  assert.ok(before.includes('Footer layout'), `the real Footer page is mounted:\n${before}`)
  assert.ok(before.includes('scroll-00'), `the first body item is painted:\n${before}`)
  assert.ok(!before.includes('scroll-31'), `the last item is cut off before scrolling:\n${before}`)
  const previewRow = rowOf(before, 'Preview')
  const shell = before.split('\n').slice(previewRow)
  const model = h.page()!
  const cursorBefore = model.state().cursor

  const target = rowOf(before, 'scroll-10')
  for (let step = 0; step < 4; step += 1) wheel(h.vt, target, 'down')
  await h.paint()
  const after = h.view()
  assert.ok(!after.includes('scroll-00') && !after.includes('Left'),
    `the first body page scrolled away:\n${after}`)
  assert.ok(after.includes('scroll-31'), `the real last body item became visible:\n${after}`)
  assert.equal(after.split('\n').slice(rowOf(after, 'Preview')).join('\n'), shell.join('\n'),
    'the fixed preview/help/bar block never moves with the body')
  assert.equal(model.state().cursor, cursorBefore, 'the wheel never moves the model cursor')
  assert.equal(model.isDirty(), false)
  assert.deepEqual(h.saves, [], 'the wheel never saves')
  assert.equal(h.cancels(), 0, 'the wheel never cancels')
  h.close()
  h.app.dispose()
  started.delete(h.app)

  // The same journey on the 44x20 short frame: the same real root/child path.
  const short = mountFooter({ columns: 44, rows: 20, items: 20 })
  await short.handle.whenInitialSpecialistSettled()
  await short.paint()
  short.vt.sendInput('\r')
  await short.paint()
  const shortBefore = short.view()
  assert.ok(shortBefore.includes('scroll-00'), `the 44x20 body paints its first page:\n${shortBefore}`)
  const shortShell = shortBefore.split('\n').slice(rowOf(shortBefore, 'Preview'))
  for (let step = 0; step < 5; step += 1) wheel(short.vt, rowOf(shortBefore, 'scroll-05'), 'down')
  await short.paint()
  const shortAfter = short.view()
  assert.ok(!shortAfter.includes('scroll-00'), `the 44x20 body really scrolled:\n${shortAfter}`)
  assert.ok(shortAfter.includes('scroll-16'), `the 44x20 last rows became visible:\n${shortAfter}`)
  assert.equal(shortAfter.split('\n').slice(rowOf(shortAfter, 'Preview')).join('\n'), shortShell.join('\n'),
    'the 44x20 fixed shell stays put')
  assert.equal(short.page()!.state().cursor, 0)
  assert.deepEqual(short.saves, [])
  short.close()
  short.app.dispose()
  started.delete(short.app)
})

test('wheel -> painted item edit -> explicit Save once; a failed save keeps the draft editable', async () => {
  // Pointer-only positive journey: wheel reveals a hidden item, click that
  // painted item, click its visible Hide-in-TSP option, click the Root Esc span
  // twice back to the Row Selector, then click Save changes.
  const h = mountFooter({ columns: 100, rows: 40, items: 32, entry: 'row' })
  await h.paint()
  assert.ok(h.view().includes('Configure footer layout…'), `the Appearance row is painted:\n${h.view()}`)
  h.vt.sendInput('\r') // the selected Appearance row -> the real Footer page
  await h.paint()
  assert.ok(h.view().includes('Footer layout'), `the normal entry mounts the Footer page:\n${h.view()}`)
  assert.equal(h.page()!.state().mode, 'rows')
  h.vt.sendInput('\r') // Row Selector -> the long Edit Row body
  await h.paint()
  assert.equal(h.page()!.state().mode, 'row')
  assert.ok(!h.view().includes('scroll-31'), `the last item is NOT painted before the wheel:\n${h.view()}`)

  // REAL wheel first: the last item becomes visible, then click THAT item.
  const targetRow = rowOf(h.view(), 'scroll-10')
  for (let step = 0; step < 3; step += 1) wheel(h.vt, targetRow, 'down')
  await h.paint()
  assert.ok(h.view().includes('scroll-31'), `the wheel revealed the last body item:\n${h.view()}`)
  const itemRow = rowOf(h.view(), 'scroll-31')
  h.vt.sendInput(`\x1b[<0;6;${itemRow + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${itemRow + 1}m`)
  await h.paint()
  assert.equal(h.page()!.state().mode, 'item', 'the wheel-revealed painted item opens its editor')
  assert.equal(h.page()!.state().cursor, 31)

  // Click a VISIBLE item option: Hide in TSP toggles the draft (pointer only).
  const hideRow = rowOf(h.view(), 'Hide in TSP')
  h.vt.sendInput(`\x1b[<0;6;${hideRow + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${hideRow + 1}m`)
  await h.paint()
  assert.equal(h.page()!.state().mode, 'item')
  assert.equal(h.page()!.state().layout.rows[0]!.left[31]!.hideInTsp, true,
    'the painted Hide-in-TSP click applied the option')
  assert.ok(h.page()!.isDirty())

  // Click the Root-owned Esc span (the ONE physical last row) back to the Row
  // Selector: item -> row, row -> rows.
  const clickRootEscape = async (): Promise<void> => {
    const rows = h.vt.getViewport()
    const bar = rows[rows.length - 1]!
    const needle = bar.includes('Back [Esc]') ? 'Back [Esc]' : bar.includes('Close [Esc]') ? 'Close [Esc]' : 'Esc'
    const index = bar.indexOf(needle)
    assert.ok(index >= 0, `the Root bar paints its Esc span:\n${bar}`)
    const x = index + 1 // 0-based cell inside the painted span
    h.vt.sendInput(`\x1b[<0;${x + 1};${rows.length}M`)
    await h.paint()
    h.vt.sendInput(`\x1b[<0;${x + 1};${rows.length}m`)
    await h.paint()
  }
  await clickRootEscape()
  assert.equal(h.page()!.state().mode, 'row')
  await clickRootEscape()
  assert.equal(h.page()!.state().mode, 'rows', 'the Root Esc span runs the page ladder back to the selector')

  // Explicit painted Save row: ONE save, the edited draft, page closes.
  let saveRow = rowOf(h.view(), 'Save changes')
  h.vt.sendInput(`\x1b[<0;6;${saveRow + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${saveRow + 1}m`)
  await h.paint()
  assert.equal(h.saves.length, 1, 'the explicit painted Save click runs the ONE save path once')
  assert.equal(h.saves[0]!.layout.rows[0]!.left[31]!.hideInTsp, true, 'the saved draft carries the clicked option')
  assert.ok(h.panel()!.isDisposed(), 'a successful save closes the page')
  h.close()
  h.app.dispose()
  started.delete(h.app)

  // Failure recovery: reopen the SAME real page, dirty it, fail the save, then
  // retry with a fresh explicit Save. The wheel never wrote anything itself.
  const retry = mountFooter({ columns: 100, rows: 40, items: 24 })
  await retry.handle.whenInitialSpecialistSettled()
  await retry.paint()
  retry.vt.sendInput('\r')
  await retry.paint()
  retry.vt.sendInput(' ')
  await retry.paint()
  retry.vt.sendInput('\x1b')
  await retry.paint()
  assert.equal(retry.page()!.state().mode, 'rows')
  saveRow = rowOf(retry.view(), 'Save changes')
  retry.saveError.value = new Error('refused by the settings authority')
  retry.vt.sendInput(`\x1b[<0;6;${saveRow + 1}M`)
  await retry.paint()
  retry.vt.sendInput(`\x1b[<0;6;${saveRow + 1}m`)
  await retry.paint()
  assert.equal(retry.saves.length, 1, 'one failed save attempt reached the sink')
  assert.equal(retry.page()!.state().saving, false)
  assert.ok(retry.page()!.isDirty(), 'the failed save keeps the draft dirty')
  assert.equal(retry.panel()!.isDisposed(), false, 'the failed save keeps the editor open')
  // The failed draft is still really editable: an observable remove, then save.
  const itemsAfterFailure = retry.page()!.state().layout.rows[0]!.left.length
  retry.vt.sendInput('\r') // rows -> the selected row
  await retry.paint()
  assert.equal(retry.page()!.state().mode, 'row')
  retry.vt.sendInput(' ')
  await retry.paint()
  assert.equal(retry.page()!.state().layout.rows[0]!.left.length, itemsAfterFailure - 1,
    'the rejected draft stays editable')
  retry.vt.sendInput('\x1b')
  await retry.paint()
  assert.equal(retry.page()!.state().mode, 'rows')
  retry.saveError.value = undefined
  retry.vt.sendInput('s') // retry through the ONE save path
  await retry.paint()
  assert.equal(retry.saves.length, 2, 'the retry reaches the ONE save sink exactly once more')
  assert.equal(retry.saves[1]!.layout.rows[0]!.left.length, itemsAfterFailure - 1,
    'the retry persists the post-failure edit')
  assert.ok(retry.panel()!.isDisposed(), 'the successful retry closes the page')
  retry.close()
  retry.app.dispose()
  started.delete(retry.app)
})

test('wheel never submits the dirty-exit guard; the explicit Keep/Discard clicks still own the exit', async () => {
  const h = mountFooter({ columns: 100, rows: 40, items: 24 })
  await h.handle.whenInitialSpecialistSettled()
  await h.paint()
  h.vt.sendInput('\r') // Row 1
  await h.paint()
  h.vt.sendInput(' ') // remove one item → dirty
  await h.paint()
  h.vt.sendInput('\x1b') // row → selector
  await h.paint()
  assert.equal(h.page()!.state().mode, 'rows')
  h.vt.sendInput('\x1b') // dirty selector → exit-confirm
  await h.paint()
  const exitView = h.view()
  assert.equal(h.page()!.state().mode, 'exit-confirm')
  assert.ok(exitView.includes('Save & Exit') && exitView.includes('Discard & Exit') && exitView.includes('Keep Editing'),
    `the dirty guard paints its three explicit choices:\n${exitView}`)
  const guardRow = rowOf(exitView, 'Save & Exit')
  for (let step = 0; step < 4; step += 1) wheel(h.vt, guardRow, 'down')
  await h.paint()
  assert.equal(h.page()!.state().mode, 'exit-confirm', 'wheel never chooses an exit action')
  assert.equal(h.view(), exitView, 'the guard frame does not scroll and keeps every choice')
  assert.deepEqual(h.saves, [], 'wheel never saves on the guard')
  assert.equal(h.cancels(), 0, 'wheel never discards on the guard')

  // The existing keyboard Keep path is unchanged (Esc on the guard).
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(h.page()!.state().mode, 'rows', 'Esc/Keep Editing returns to the selector')
  assert.deepEqual(h.saves, [])
  assert.equal(h.cancels(), 0)
  h.vt.sendInput('\x1b') // dirty → guard again
  await h.paint()
  const discardView = h.view()
  h.vt.sendInput(`\x1b[<0;6;${rowOf(discardView, 'Discard & Exit') + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${rowOf(discardView, 'Discard & Exit') + 1}m`)
  await h.paint()
  assert.equal(h.cancels(), 1, 'Discard & Exit uses the ONE cancel path')
  assert.deepEqual(h.saves, [], 'Discard & Exit never claims a save')
  h.close()
  h.app.dispose()
  started.delete(h.app)
})

test('mounted press -> wheel -> release never activates the footer row; zero delta keeps it and fresh press acts', async () => {
  const h = mountFooter({ columns: 100, rows: 40, items: 32 })
  await h.handle.whenInitialSpecialistSettled()
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  // Scroll the long body down, then press a really painted item row.
  const scrolled = h.view()
  for (let step = 0; step < 4; step += 1) wheel(h.vt, rowOf(scrolled, 'scroll-10'), 'down')
  await h.paint()
  let view = h.view()
  let targetLine = rowOf(view, 'scroll-20')
  h.vt.sendInput(`\x1b[<0;6;${targetLine + 1}M`)
  await h.paint()
  wheel(h.vt, rowOf(view, 'scroll-20'), 'down')
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${targetLine + 1}m`)
  await h.paint()
  assert.equal(h.page()!.state().mode, 'row', 'a real wheel retires the pressed row action')

  // Zero delta is the only direct negative control (the fork never emits one).
  view = h.view()
  targetLine = rowOf(view, 'scroll-20')
  h.vt.sendInput(`\x1b[<0;6;${targetLine + 1}M`)
  await h.paint()
  const panel = h.panel()!
  assert.deepEqual(panel.handleMouse({
    type: 'wheel',
    button: 'none',
    x: 4,
    y: targetLine,
    screenX: 4,
    screenY: targetLine,
    width: 100,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 0,
  }), { handled: true, render: false })
  h.vt.sendInput(`\x1b[<0;6;${targetLine + 1}m`)
  await h.paint()
  assert.equal(h.page()!.state().mode, 'item', 'a zero-delta wheel never cancels the legal press')

  h.vt.sendInput('\x1b') // item → row
  await h.paint()
  // A fresh press on a painted row still acts.
  view = h.view()
  targetLine = rowOf(view, 'scroll-20')
  h.vt.sendInput(`\x1b[<0;6;${targetLine + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${targetLine + 1}m`)
  await h.paint()
  assert.equal(h.page()!.state().mode, 'item', 'a fresh painted press still opens the item editor')
  h.close()
  h.app.dispose()
  started.delete(h.app)
})

test('a pre-repaint resize never replays the old cell; the repainted frame and a reopened lease still work', async () => {
  const h = mountFooter({ columns: 100, rows: 40, items: 32 })
  await h.handle.whenInitialSpecialistSettled()
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  const before = h.view()
  assert.ok(before.includes('Left'), 'the 100x40 body paints its first page')
  // Resize WITHOUT a frame, then wheel at a cell that was in the old body.
  h.vt.resize(80, 12)
  h.vt.sendInput('\x1b[<65;6;6M')
  await h.paint()
  const resized = h.view()
  assert.equal(h.page()!.state().cursor, 0)
  assert.ok(resized.includes('Left'), 'the unrepainted resize never applies the old wheel offset')
  // The repainted 80x12 frame accepts a fresh wheel on its real body row.
  const target = rowOf(h.view(), 'scroll-01')
  wheel(h.vt, target, 'down')
  await h.paint()
  assert.equal(h.page()!.state().mode, 'row')
  assert.notEqual(h.view(), resized, 'the repainted frame really scrolls')
  h.close()
  h.app.dispose()
  started.delete(h.app)

  // Root notice: a chrome change moves the child box; a wheel against the old
  // cell before the new frame paints is refused and a fresh frame works.
  const notice = mountFooter({ columns: 100, rows: 40, items: 32 })
  await notice.handle.whenInitialSpecialistSettled()
  await notice.paint()
  notice.vt.sendInput('\r')
  await notice.paint()
  notice.app.notify('a notice moves the painted chrome', 'info')
  notice.vt.sendInput('\x1b[<65;6;6M') // old body cell, before the notice repaint
  await notice.paint()
  assert.ok(notice.view().includes('scroll-00'), 'the notice-stale wheel never scrolls the moved body')
  const noticeTarget = rowOf(notice.view(), 'scroll-10')
  for (let step = 0; step < 3; step += 1) wheel(notice.vt, noticeTarget, 'down')
  await notice.paint()
  assert.ok(!notice.view().includes('scroll-00'), 'the freshly painted body scrolls again')
  notice.close()
  notice.app.dispose()
  started.delete(notice.app)

  // SAME app, close/reopen: the retired page is inert, and the new lease never
  // inherits the old panel's cell.
  const shared = mountFooter({ columns: 100, rows: 40, items: 32 })
  await shared.handle.whenInitialSpecialistSettled()
  await shared.paint()
  shared.vt.sendInput('\r')
  await shared.paint()
  const retiredPanel = shared.panel()!
  const retiredModel = shared.page()!
  const retiredItemCount = retiredModel.state().layout.rows[0]!.left.length
  shared.close() // close the lease, SAME app stays alive
  assert.deepEqual(retiredPanel.handleMouse({
    type: 'wheel',
    button: 'none',
    x: 4,
    y: 4,
    screenX: 4,
    screenY: 4,
    width: 100,
    height: 40,
    shift: false,
    alt: true,
    ctrl: false,
    wheelDelta: 5,
  }), undefined, 'a retired page never consumes or scrolls a late wheel')
  assert.equal(retiredModel.state().layout.rows[0]!.left.length, retiredItemCount)
  const reopened = mountFooter({ app: shared.app, vt: shared.vt, columns: 100, rows: 40, items: 32 })
  reopened.vt.sendInput('\x1b[<65;6;6M') // stale cell before the reopened frame paints
  await reopened.handle.whenInitialSpecialistSettled()
  await reopened.paint()
  reopened.vt.sendInput('\r')
  await reopened.paint()
  assert.ok(reopened.view().includes('scroll-00'), 'the same-app reopened lease ignores the old cell')
  const reopenedTarget = rowOf(reopened.view(), 'scroll-10')
  for (let step = 0; step < 3; step += 1) wheel(reopened.vt, reopenedTarget, 'down')
  await reopened.paint()
  assert.ok(!reopened.view().includes('scroll-00'), 'the same-app reopened lease accepts a fresh wheel')
  reopened.close()
  shared.app.dispose()
  started.delete(shared.app)
})


test('the hidden-cursor fence stays armed through synchronous keys before cursor-follow paints', async () => {
  const h = mountFooter({ columns: 100, rows: 40, items: 32 })
  await h.handle.whenInitialSpecialistSettled()
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  const itemsBefore = h.page()!.state().layout.rows[0]!.left.length

  const hide = async (): Promise<void> => {
    const view = h.view()
    const bodyRow = rowOf(view, 'scroll-10')
    for (let step = 0; step < 6; step += 1) wheel(h.vt, bodyRow, 'down')
    await h.paint()
    assert.equal(h.page()!.state().cursor, 0)
    assert.ok(!h.view().includes('›'),
      `the model cursor is outside the painted body:\n${h.view()}`)
  }

  // Two dangerous keys in the SAME input tick: the first requests the
  // cursor-follow frame, the second must not slip through before it paints.
  await hide()
  h.vt.sendInput(' ')
  h.vt.sendInput(' ')
  await h.paint()
  assert.equal(h.page()!.state().mode, 'row')
  assert.equal(h.page()!.state().layout.rows[0]!.left.length, itemsBefore,
    'a synchronous second Space never removes an unseen item')
  assert.ok(h.view().includes('› scroll-00'), 'the restored frame paints the same selection')

  // A no-op key then a dangerous key in the same tick: the fence is still
  // armed on the last PAINTED frame.
  await hide()
  const itemsAfter = h.page()!.state().layout.rows[0]!.left.length
  h.vt.sendInput('x')
  h.vt.sendInput(' ')
  await h.paint()
  assert.equal(h.page()!.state().layout.rows[0]!.left.length, itemsAfter,
    'a no-op key never disarms the hidden-cursor fence')
  assert.ok(h.view().includes('› scroll-00'), 'the cursor-follow frame still restores the selection')

  // Two Enters in the same tick cannot open the hidden item editor either.
  await hide()
  h.vt.sendInput('\r')
  h.vt.sendInput('\r')
  await h.paint()
  assert.equal(h.page()!.state().mode, 'row', 'synchronous Enters never activate the hidden selection')
  assert.ok(h.view().includes('› scroll-00'), 'the visible selection is restored before the next action')
  h.close()
  h.app.dispose()
  started.delete(h.app)
})
