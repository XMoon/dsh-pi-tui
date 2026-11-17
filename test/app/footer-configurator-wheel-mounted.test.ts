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
} = {}): MountedFooter {
  const columns = options.columns ?? 100
  const rows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const generated = longLayout(options.items ?? 24)
  app.setFooterCustomItems(generated.custom)
  app.setFooterLayout(generated.layout)
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  const saves: SaveCall[] = []
  const state = { cancels: 0 }
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

test('a real SGR wheel and a painted click reach the real page; the recording save fires once', async () => {
  const h = mountFooter({ columns: 100, rows: 40, entry: 'row' })
  await h.paint()
  // Normal Appearance entry: Enter on the Footer row opens the SAME real page.
  assert.ok(h.view().includes('Configure footer layout…'), `the Appearance row is painted:\n${h.view()}`)
  h.vt.sendInput('\r') // the selected Appearance row -> the typed specialist page
  await h.paint()
  assert.ok(h.view().includes('Footer layout'), `the normal entry mounts the Footer page:\n${h.view()}`)
  // Open Row 1 and make the draft dirty through the real keyboard path.
  h.vt.sendInput('\r')
  await h.paint()
  assert.equal(h.page()!.state().mode, 'row')
  h.vt.sendInput(' ') // remove the first item → dirty
  await h.paint()
  h.vt.sendInput('\x1b') // back to the Row Selector
  await h.paint()
  assert.equal(h.page()!.state().mode, 'rows')
  assert.ok(h.page()!.isDirty())
  const saveRow = rowOf(h.view(), 'Save changes')
  // Real SGR click on the painted Save changes row.
  h.vt.sendInput(`\x1b[<0;6;${saveRow + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${saveRow + 1}m`)
  await h.paint()
  assert.equal(h.saves.length, 1, 'the explicit painted Save click runs the ONE save path once')
  assert.equal(h.saves[0]!.layout.rows[0]!.left.length, 23, 'the saved layout is the edited draft')
  h.close()
  h.app.dispose()
  started.delete(h.app)
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

  // A fresh lease with the SAME app-level layout never inherits the old cell.
  const next = mountFooter({ columns: 100, rows: 40, items: 32 })
  await next.handle.whenInitialSpecialistSettled()
  await next.paint()
  const nextBefore = next.view()
  next.vt.sendInput('\x1b[<65;6;6M')
  await next.paint()
  assert.ok(next.view().includes('Select row to edit'), 'the fresh lease opens on its own selector')
  next.vt.sendInput('\r')
  await next.paint()
  assert.ok(next.view().includes('scroll-00'), 'an old wheel cell cannot scroll the new lease')
  assert.notEqual(next.view(), nextBefore)
  next.close()
  next.app.dispose()
  started.delete(next.app)
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
