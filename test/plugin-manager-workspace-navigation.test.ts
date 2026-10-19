/**
 * Fullscreen Plugin Manager navigation/lifecycle suite (S4-D1 D1-A05/A06/A09/
 * A13): the root lease, the same page/controller across hide-reopen, the
 * removal confirmation default, the resize fence and one-shot external
 * disposal.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-workspace-navigation.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Component } from '@xmoon76/pi-tui'
import { PluginManagerController } from '../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type { PluginBundleFact, PluginChangeFact } from '../src/runtime/plugin-manager-port.ts'
import { SELF_BUNDLE } from '../src/app/plugin-manager/classify.ts'
import { EXPERIMENTAL_NAMES, bundle, openWorkspace, plain, row, type WorkspaceHarness } from './support/plugin-workspace-harness.ts'

const started = new Set<WorkspaceHarness>()
afterEach(() => {
  for (const harness of [...started]) {
    started.delete(harness)
    try { harness.app.dispose() } catch {}
  }
})

async function open(options: Parameters<typeof openWorkspace>[0] = {}): Promise<WorkspaceHarness> {
  const harness = await openWorkspace(options)
  started.add(harness)
  return harness
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** Move the list cursor down to the named card (the card's full value is the
 * stable identity; the test reads it from the controller). */
async function selectCard(harness: WorkspaceHarness, value: string): Promise<void> {
  for (let step = 0; step < 30; step += 1) {
    if (harness.panel.selectedCardValue() === value) return
    harness.vt.sendInput('\x1b[B')
    await harness.settle()
  }
  assert.fail(`card ${value} was not selectable`)
}

test('Esc hides a running install without cancelling it and `i` reopens the SAME request', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = await open({
    columns: 120,
    rows: 40,
    installImpl: () => gate.promise,
    cancelImpl: async () => ({ status: 'too-late' }),
  })
  // Last card = Claude Code (official missing); detail -> Install….
  harness.vt.sendInput('\x1b[F')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.match(harness.view(), /offered version 0.2.1-rc.2/)
  harness.vt.sendInput('\r') // explicit install confirm
  await harness.settle()
  assert.equal(harness.installCalls.length, 1)
  const requestId = harness.installCalls[0]!.requestId

  // A too-late Stop does not fabricate cancellation.
  harness.vt.sendInput('s')
  await harness.settle()
  assert.equal(harness.controller.installView()?.phase, 'applying')
  assert.doesNotMatch(harness.view(), /cancelled/i)

  // Esc hides the running view; the Host operation stays owned by the SAME id.
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list')
  assert.match(plain([harness.viewport().at(-1)!]), /Esc close/)

  harness.vt.sendInput('i')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'install')
  assert.equal(harness.controller.installView()?.requestId, requestId)
  assert.equal(harness.installCalls.length, 1, 'reopening never dispatches a second install')
  gate.resolve({ changed: true, application: 'restart-required', stage: 'install', target: 'x', version: '1.0.0', restartReason: 'no-hmr' })
  await harness.settle()
  assert.match(harness.view(), /Restart required/)
  assert.match(harness.view(), /installed version 1.0.0/)
})

test('the removal confirmation defaults to Cancel and an explicit Remove is required', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  const vendor = '@vendor/foo'
  await selectCard(harness, `bundle:${vendor}`)
  harness.vt.sendInput('\r')
  await harness.settle()
  // Action list: Enable…, Remove…, Back. Move to Remove and open the confirm.
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.match(harness.view(), /Removal confirmation/)
  assert.match(harness.view(), new RegExp(`Remove ${vendor.replace('/', '\\/')}\\?`))
  // The default focus is Cancel: Enter never removes.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.deepEqual(harness.removeBundle, [], 'the default cancel action never mutates')
  assert.match(harness.view(), /\[Details\]/)
  // Re-open and explicitly move to Remove.
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.sendInput('\x1b[A') // Cancel -> Remove
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.deepEqual(harness.removeBundle, [vendor])
})

test('copying a failed install preserves duplicate output lines', async () => {
  const harness = await open({
    columns: 120,
    rows: 40,
    installImpl: async () => ({
      changed: true,
      application: 'failed',
      stage: 'install',
      target: 'pkg',
      error: { code: 'operation-error' },
      packageResult: { exitCode: 1, output: 'same line\nsame line\nsame\tline\n\u001b]52;c;YXR0YWNr\u0007\r\n', truncated: false },
    }),
  })
  harness.vt.sendInput('i')
  await harness.settle()
  for (const character of 'pkg') harness.vt.sendInput(character)
  await harness.settle()
  harness.vt.sendInput('\r') // inspect
  await harness.settle()
  harness.vt.sendInput('\r') // install
  await harness.settle()
  assert.equal(harness.controller.installView()?.phase, 'failed')
  harness.vt.sendInput('c')
  await harness.settle()
  assert.equal(harness.copied.length, 1)
  assert.equal(harness.copied[0]!.split('\n').filter(line => line === 'same line').length, 2,
    'the exact raw diagnostic output is copied without global line de-duplication')
  assert.ok(harness.copied[0]!.includes('same\tline'), 'TAB survives byte-exact copy')
  assert.ok(harness.copied[0]!.includes('\u001b]52;c;YXR0YWNr\u0007'), 'the raw OSC sequence survives byte-exact copy')
  assert.ok(harness.copied[0]!.includes('\r'), 'the raw CR survives byte-exact copy')
  assert.ok(!harness.view().includes('YXR0YWNr'), 'the display projection still strips the payload')
})

test('a running install copies its retained log byte-exact while the display stays projected', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = await open({ columns: 120, rows: 40, installImpl: () => gate.promise })
  harness.vt.sendInput('i')
  await harness.settle()
  for (const character of 'pkg') harness.vt.sendInput(character)
  await harness.settle()
  harness.vt.sendInput('\r') // inspect
  await harness.settle()
  harness.vt.sendInput('\r') // install -> starting (held)
  await harness.settle()
  const requestId = harness.installCalls[0]!.requestId
  harness.emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  harness.emit({
    kind: 'log',
    log: {
      requestId,
      jobId: 'j',
      stream: 'stderr',
      text: 'raw\tline\nline2\nline3\r\n\u001b]52;c;YXR0YWNr\u0007',
    },
  })
  await harness.settle()
  const retained = harness.controller.installView()!.log
  assert.ok(retained.length > 0)
  harness.vt.sendInput('c')
  await harness.settle()
  assert.equal(harness.copied.length, 1)
  assert.ok(harness.copied[0]!.endsWith(retained.join('\n')),
    'the clipboard payload ends with the exact retained log, without a display projection')
  assert.ok(harness.copied[0]!.includes('! raw\tline'), 'stderr prefix and TAB are preserved byte-exact')
  assert.ok(harness.copied[0]!.includes('\u001b]52;c;YXR0YWNr\u0007'), 'the raw OSC sequence is preserved')
  assert.ok(!harness.view().includes('YXR0YWNr'), 'the display projection still strips the payload')
  gate.resolve({ changed: true, application: 'applied', stage: 'install', target: 'pkg' })
  await harness.settle()
})

test('Esc advertises the real destination per entry host', async () => {
  const direct = await open({ columns: 120, rows: 30 })
  assert.match(plain([direct.viewport().at(-1)!]), /Esc close/)
  direct.vt.sendInput('i')
  await direct.settle()
  assert.match(plain([direct.viewport().at(-1)!]), /Esc back/,
    'the direct install editor returns to the LIST, so it must not claim Esc close')
  direct.vt.sendInput('\t') // spec -> registry focus
  await direct.settle()
  const editor = plain(direct.viewport())
  assert.match(editor, /Reg\s+> /, 'registry focus uses the existing > selection device')
  assert.doesNotMatch(editor, /‹/, 'no third focus glyph is introduced')
  direct.vt.sendInput('\x1b')
  await direct.settle()
  assert.equal(direct.panel.currentView(), 'list')
  direct.app.dispose()
  started.delete(direct)

  const settings = await open({ columns: 120, rows: 30, entryHost: 'settings-entry' })
  assert.match(plain([settings.viewport().at(-1)!]), /Esc back/)
  settings.vt.sendInput('i')
  await settings.settle()
  assert.match(plain([settings.viewport().at(-1)!]), /Esc back/)
})

test('80x10 keeps the removal consequence and both choices reachable', async () => {
  const harness = await open({ columns: 80, rows: 10 })
  await selectCard(harness, 'bundle:@vendor/foo')
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.sendInput('\x1b[B') // Enable… -> Remove…
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  const view = harness.view()
  assert.match(view, /Remove @vendor\/foo\?/, 'the exact package is visible')
  assert.match(view, /unloads the bundle/, 'the dependency consequence is visible')
  assert.match(view, /Cancel/)
  assert.match(view, /Remove/)
  assert.match(plain([harness.viewport().at(-1)!]), /Esc cancel/)
})

test('80x10 reveals then admits the official Install action and keeps its intent visible', async () => {
  const harness = await open({ columns: 80, rows: 10 })
  harness.vt.sendInput('\x1b[F')
  await harness.settle()
  harness.vt.sendInput('\r') // Details
  await harness.settle()
  harness.vt.sendInput('\r') // first Enter reveals the offscreen action
  await harness.settle()
  assert.match(harness.view(), /Actions/)
  assert.match(harness.view(), /Install…/)
  harness.vt.sendInput('\r') // now the painted action is admitted
  await harness.settle()
  assert.match(harness.view(), /offered version 0\.2\.1-rc\.2/)
  assert.match(harness.view(), /Activates the bundle/)
  assert.match(harness.view(), /Install/)
  assert.match(plain([harness.viewport().at(-1)!]), /Esc edit/)
})

test('a resize mid-install keeps the same request and a truthful last-row bar', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = await open({ columns: 140, rows: 40, installImpl: () => gate.promise })
  harness.vt.sendInput('\x1b[F')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.installCalls.length, 1)
  const requestId = harness.installCalls[0]!.requestId
  harness.vt.resize(80, 24)
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'install')
  assert.equal(harness.controller.installView()?.requestId, requestId)
  assert.match(plain([harness.viewport().at(-1)!]), /Esc hide/)
  for (const line of harness.viewport()) {
    assert.ok(plain([line]).length <= 80)
  }
  gate.resolve({ changed: true, application: 'applied', stage: 'install', target: 'x' })
  await harness.settle()
})

test('a second workspace lease is refused; an external disposal notifies exactly once', async () => {
  const harness = await open({ columns: 100, rows: 30 })
  const dummy: Component = { render: () => [], invalidate: () => {} }
  assert.throws(() => harness.app.openPluginManagerWorkspace(dummy), /already leased/)

  const controller = new PluginManagerController({
    snapshot: async () => ({
      bundles: [],
      plugins: [],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
    inspect: async () => ({ status: 'refused', problem: 'unknown', reason: 'x' }),
    setBundleEnabled: async () => ({ changed: false, application: 'applied', stage: 'enable', target: '' }),
    setPluginEnabled: async () => ({ changed: false, application: 'applied', stage: 'enable', target: '' }),
    removeBundle: async () => ({ changed: false, application: 'applied', stage: 'remove', target: '' }),
    startInstall: async () => ({ changed: false, application: 'applied', stage: 'install', target: '' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  let disposals = 0
  const panel = new PluginManagerWorkspacePanel(controller, {
    rows: () => 24,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  }, { onDispose: () => { disposals += 1 } })
  panel.dispose()
  panel.dispose()
  assert.equal(disposals, 1, 'an external teardown releases its owner exactly once')
})

// ── B03 Auto Review safety confirmation (D2-2) ─────────────────────────────

const AUTO_REVIEW = '@deepseek-ai/dsh-experimental-auto-review'
const AUTO_WARNING = 'Disabling Auto Review can change existing Auto sessions to Full access. Auto Review is not a sandbox. Continue?'

/** The real catalog shape with B03 enabled and one addressable live row. */
function autoReviewCatalog(): NonNullable<Parameters<typeof open>[0]> {
  const missing = (name: string) => bundle({
    name,
    official: true,
    availability: 'missing',
    installed: false,
    optional: true,
    removable: false,
    source: undefined,
    installTarget: { spec: `${name}@0.2.1-rc.2`, version: '0.2.1-rc.2' },
  })
  return {
    columns: 140,
    rows: 40,
    bundles: [
      bundle({ name: SELF_BUNDLE, source: 'file:/tmp/tui', enabled: true, rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'e-tui' }] }),
      bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', source: undefined }),
      bundle({
        name: AUTO_REVIEW,
        official: true,
        availability: 'installation',
        installed: false,
        optional: true,
        removable: false,
        enabled: true,
        source: undefined,
        rows: [{ rowId: 'auto-review', moduleName: AUTO_REVIEW, entryId: 'e-auto', title: 'Auto Review' }],
      }),
      ...EXPERIMENTAL_NAMES.filter(name => name !== AUTO_REVIEW).map(name => missing(name)),
    ],
    plugins: [
      row({ entryId: 'e-tui', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
      row({ entryId: 'e-auto', moduleName: AUTO_REVIEW, patchId: 'auto-review', enabled: true, fiberPhase: 'active' }),
    ],
  }
}

const compact = (view: string): string => view.replace(/\s+/gu, ' ')

test('B03 disable opens the shared risk confirmation and writes only after the explicit choice', async () => {
  const harness = await open(autoReviewCatalog())
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  harness.vt.sendInput('\r')
  await harness.settle()
  // The first Detail action is Disable….
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'confirm')
  assert.match(compact(harness.view()), new RegExp(AUTO_WARNING.replace(/[.]/gu, '\\.')))
  assert.deepEqual(harness.setBundle, [], 'opening the confirmation never mutates the Host')

  // Default focus is Cancel: Enter abandons without a write.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'details')
  assert.deepEqual(harness.setBundle, [])

  // Re-open and explicitly choose the dangerous action: exactly one official
  // OFF write is dispatched (never a toggle inversion).
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.sendInput('\x1b[A') // Cancel -> Disable Auto Review
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.deepEqual(harness.setBundle, [{ name: AUTO_REVIEW, enabled: false }])
})

test('B03 row disable cannot bypass the confirmation and writes the exact entry id', async () => {
  const harness = await open(autoReviewCatalog())
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  harness.vt.sendInput('\r')
  await harness.settle()
  // Actions: Disable… (0), Disable row e-auto (1), Back (2).
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'confirm')
  assert.match(compact(harness.view()), /Disable e-auto in Auto Review\?/)
  assert.match(compact(harness.view()), new RegExp(AUTO_WARNING.replace(/[.]/gu, '\\.')))
  assert.deepEqual(harness.setPlugin, [], 'a row toggle opens the confirmation instead of writing')

  harness.vt.sendInput('\x1b[A') // Cancel -> Disable Auto Review
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.deepEqual(harness.setPlugin, [{ entryId: 'e-auto', enabled: false }])
})

test('B03 stale confirmation never writes after the authoritative inventory changed', async () => {
  const harness = await open(autoReviewCatalog())
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'confirm')
  // A reread invalidates the epoch the confirmation was opened against.
  harness.controller.refresh()
  await harness.settle()
  harness.vt.sendInput('\x1b[A')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.deepEqual(harness.setBundle, [], 'a stale confirmation dispatches no Host write')
  assert.match(harness.view(), /Auto Review changed since the confirmation opened/)
})

test('B03 remove uses the same confirmation view with the same risk warning', async () => {
  const catalog = autoReviewCatalog()
  const harness = await open({
    ...catalog,
    bundles: (catalog.bundles as readonly PluginBundleFact[]).map(entry =>
      entry.name === AUTO_REVIEW
        ? { ...entry, availability: 'profile', installed: true, removable: true, enabled: true, source: 'file:/tmp/auto-review' }
        : entry),
  })
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  harness.vt.sendInput('\r')
  await harness.settle()
  // Actions: Disable… (0), Remove… (1), Disable row (2), Back.
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'confirm')
  assert.match(compact(harness.view()), new RegExp(AUTO_WARNING.replace(/[.]/gu, '\\.')))
  assert.deepEqual(harness.removeBundle, [], 'the default Cancel removes nothing')
})

// ── B03 risk-visibility gating (external review P1) ────────────────────────

const rowOf = (harness: WorkspaceHarness, text: string): number =>
  harness.viewport().findIndex(line => plain([line]).includes(text))
const press = (harness: WorkspaceHarness, row: number, col: number): void => {
  harness.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const release = (harness: WorkspaceHarness, row: number, col: number): void => {
  harness.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}

async function openAutoConfirm(harness: WorkspaceHarness): Promise<void> {
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  if (harness.panel.currentView() === 'list') {
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  if (harness.panel.currentView() === 'details') {
    // The earlier Cancel can leave the Details cursor anywhere; the first
    // action is always the bundle-level Disable….
    harness.vt.sendInput('\x1b[A')
    harness.vt.sendInput('\x1b[A')
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  assert.equal(harness.panel.currentView(), 'confirm')
}

test('B03 danger primary is withheld on 80×5 and 44×8 until its consequence is fully visible', async () => {
  for (const [columns, rows] of [[80, 5], [44, 8]] as const) {
    const harness = await open(autoReviewCatalog())
    await openAutoConfirm(harness)
    const fullPrimaryRow = rowOf(harness, 'Disable Auto Review')
    const fullPrimaryCol = plain([harness.viewport()[fullPrimaryRow]!]).indexOf('Disable Auto Review')
    assert.ok(fullPrimaryRow >= 0, 'the full frame offers the dangerous primary')
    harness.vt.resize(columns, rows)
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'confirm')
    assert.doesNotMatch(plain([harness.viewport().at(-1)!]), /Enter confirm/u)
    assert.match(plain([harness.viewport().at(-1)!]), /Enter cancel/u)
    assert.match(harness.view(), /^> Cancel\s*$/mu,
      `${columns}×${rows}: the only action is Cancel and it carries the visible cursor`)
    assert.doesNotMatch(harness.view(), /^  Disable Auto Review\s*$/mu,
      `${columns}×${rows}: the primary is not painted with an incomplete consequence`)

    // Keyboard Up+Enter, a stale press/release at the old primary, and scroll
    // must never dispatch the Host write while the warning is incomplete.
    harness.vt.sendInput('\x1b[A')
    harness.vt.sendInput('\r')
    await harness.settle()
    assert.deepEqual(harness.setBundle, [])
    const reopened = harness.panel.currentView()
    if (reopened !== 'confirm') {
      // Cancel closed the page; reopen at a full size to test the mouse path.
      harness.vt.resize(140, 40)
      await harness.settle()
      await openAutoConfirm(harness)
      harness.vt.resize(columns, rows)
      await harness.settle()
    }
    press(harness, fullPrimaryRow, fullPrimaryCol)
    release(harness, fullPrimaryRow, fullPrimaryCol)
    await harness.settle()
    assert.deepEqual(harness.setBundle, [], 'a click at the old dangerous target cannot write')
    harness.vt.sendInput('\x1b[6~') // PgDn
    await harness.settle()
    assert.deepEqual(harness.setBundle, [], 'scrolling at this size cannot make an incomplete warning complete')
    harness.vt.sendInput('\x1b')
    await harness.settle()
    started.delete(harness)
    harness.app.dispose()
  }
})

test('B03 danger primary disappears when the warning scrolls out and returns with it', async () => {
  const harness = await open(autoReviewCatalog())
  await openAutoConfirm(harness)
  assert.match(harness.view(), /Disable Auto Review/)
  harness.vt.resize(80, 10)
  await harness.settle()
  assert.match(harness.view(), /Disable Auto Review/, '80×10 can show the whole warning with both choices')
  harness.vt.sendInput('\x1b[6~') // PgDn: the warning top scrolls out of the 3-row viewport
  await harness.settle()
  assert.doesNotMatch(harness.view(), /^  Disable Auto Review\s*$/mu,
    'the dangerous primary is withheld once its warning is no longer fully visible')
  assert.match(plain([harness.viewport().at(-1)!]), /Enter cancel/u)
  assert.match(harness.view(), /^> Cancel\s*$/mu,
    'the withheld frame paints the cursor on Cancel')
  harness.vt.sendInput('\r') // Enter dispatches the PAINTED Cancel, not a hidden primary
  await harness.settle()
  assert.deepEqual(harness.setBundle, [])
  assert.equal(harness.panel.currentView(), 'details')

  // Re-open; PgDn hides the warning, PgUp restores it. The cursor must remain
  // on Cancel in the SAME frame that paints the primary, so a direct Enter is
  // Cancel (no Host write); only Up+Enter may perform the dangerous action.
  harness.vt.resize(140, 40)
  await harness.settle()
  await openAutoConfirm(harness)
  harness.vt.resize(80, 10)
  await harness.settle()
  harness.vt.sendInput('\x1b[6~')
  await harness.settle()
  harness.vt.sendInput('\x1b[5~') // PgUp
  await harness.settle()
  assert.match(harness.view(), /^(?:> |  )Disable Auto Review\s*$/mu)
  assert.match(harness.view(), /^> Cancel\s*$/mu,
    'the re-revealed frame keeps the cursor on the safe default Cancel')
  assert.match(plain([harness.viewport().at(-1)!]), /Enter confirm/u)
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.deepEqual(harness.setBundle, [], 'a direct Enter after PgUp cancels instead of writing')
  assert.equal(harness.panel.currentView(), 'details')

  // Third pass: the explicit Up+Enter choice is the dangerous write.
  harness.vt.resize(140, 40)
  await harness.settle()
  await openAutoConfirm(harness)
  harness.vt.resize(80, 10)
  await harness.settle()
  harness.vt.sendInput('\x1b[6~')
  await harness.settle()
  harness.vt.sendInput('\x1b[5~')
  await harness.settle()
  harness.vt.sendInput('\x1b[A') // Cancel -> primary (visible, consequence complete)
  await harness.settle()
  assert.match(harness.view(), /^> Disable Auto Review\s*$/mu)
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.deepEqual(harness.setBundle, [{ name: AUTO_REVIEW, enabled: false }])
})

test('ordinary Bundle Remove is withheld at 80×5 but reachable at 80×10', async () => {
  const short = await open({ columns: 140, rows: 40 })
  await selectCard(short, 'bundle:@vendor/foo')
  short.vt.sendInput('\r')
  await short.settle()
  short.vt.sendInput('\x1b[B') // Enable… -> Remove…
  await short.settle()
  short.vt.sendInput('\r')
  await short.settle()
  assert.equal(short.panel.currentView(), 'confirm')
  short.vt.resize(80, 5)
  await short.settle()
  assert.doesNotMatch(short.view(), /^  Remove\s*$/mu, '80×5 cannot show the unload consequence with Remove')
  assert.match(plain([short.viewport().at(-1)!]), /Enter cancel/u)
  short.vt.sendInput('\r')
  await short.settle()
  assert.deepEqual(short.removeBundle, [])
  started.delete(short)
  short.app.dispose()

  const tall = await open({ columns: 140, rows: 40 })
  await selectCard(tall, 'bundle:@vendor/foo')
  tall.vt.sendInput('\r')
  await tall.settle()
  tall.vt.sendInput('\x1b[B')
  await tall.settle()
  tall.vt.sendInput('\r')
  await tall.settle()
  tall.vt.resize(80, 10)
  await tall.settle()
  assert.match(tall.view(), /^  Remove\s*$/mu, '80×10 shows the consequence with Remove')
  tall.vt.sendInput('\x1b[A')
  await tall.settle()
  tall.vt.sendInput('\r')
  await tall.settle()
  assert.deepEqual(tall.removeBundle, ['@vendor/foo'])
})
