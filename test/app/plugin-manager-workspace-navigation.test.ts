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
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { PluginBundleFact, PluginChangeFact } from '../../src/runtime/plugin-manager-port.ts'
import { SELF_BUNDLE } from '../../src/app/plugin-manager/classify.ts'
import { EXPERIMENTAL_NAMES, bundle, openWorkspace, plain, row, type WorkspaceHarness } from '../support/plugin-workspace-harness.ts'

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
    await harness.waitForFrame()
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
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  // A Detail action that the first frame could not paint is revealed first and
  // admitted on the NEXT frame; the loop keeps pressing only while we are
  // still on the Details page.
  for (let attempt = 0; attempt < 3 && harness.panel.currentView() === 'details'; attempt += 1) {
    harness.vt.sendInput('\r')
    // Fixed wait with a stated window: the reveal is admitted on the NEXT frame,
    // so each bounded attempt needs one settle before the view is re-read.
    await harness.waitForFrame()
  }
  assert.equal(harness.panel.currentView(), 'install', 'the explicit Install action opened the editor')
  assert.match(harness.view(), /offered version 0.2.1-rc.2/)
  harness.vt.sendInput('\r') // explicit install confirm
  await harness.waitForFrame()
  assert.equal(harness.installCalls.length, 1)
  const requestId = harness.installCalls[0]!.requestId

  // A too-late Stop does not fabricate cancellation.
  harness.vt.sendInput('s')
  await harness.waitForFrame()
  assert.equal(harness.controller.installView()?.phase, 'applying')
  assert.doesNotMatch(harness.view(), /cancelled/i)

  // Esc hides the running view; the Host operation stays owned by the SAME id.
  harness.vt.sendInput('\x1b')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'list')
  assert.match(plain([harness.viewport().at(-1)!]), /Esc back/,
    'hiding the running install returns to the embedded List, whose Esc yields to Categories')

  harness.vt.sendInput('i')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'install')
  assert.equal(harness.controller.installView()?.requestId, requestId)
  assert.equal(harness.installCalls.length, 1, 'reopening never dispatches a second install')
  gate.resolve({ changed: true, application: 'restart-required', stage: 'install', target: 'x', version: '1.0.0', restartReason: 'no-hmr' })
  await harness.waitForFrame()
  assert.match(harness.view(), /Restart required/)
  assert.match(harness.view(), /installed version 1.0.0/)
})

test('the removal confirmation defaults to Cancel and an explicit Remove is required', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  const vendor = '@vendor/foo'
  await selectCard(harness, `bundle:${vendor}`)
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  // Action list: Enable…, Remove…, Back. Move to Remove and open the confirm.
  harness.vt.sendInput('\x1b[B')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.match(harness.view(), /Plugins · Confirm/u, 'the shared pane header names the full-width Confirm page')
  assert.match(harness.view(), new RegExp(`Remove ${vendor.replace('/', '\\/')}\\?`))
  // The default focus is Cancel: Enter never removes.
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.deepEqual(harness.removeBundle, [], 'the default cancel action never mutates')
  assert.match(harness.view(), /\[Details\]/)
  // Re-open and explicitly move to Remove.
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[A') // Cancel -> Remove
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
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
  await harness.waitForFrame()
  for (const character of 'pkg') harness.vt.sendInput(character)
  await harness.waitForFrame()
  harness.vt.sendInput('\r') // inspect
  await harness.waitForFrame()
  harness.vt.sendInput('\r') // install
  await harness.waitForFrame()
  assert.equal(harness.controller.installView()?.phase, 'failed')
  harness.vt.sendInput('c')
  await harness.waitForFrame()
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
  await harness.waitForFrame()
  for (const character of 'pkg') harness.vt.sendInput(character)
  await harness.waitForFrame()
  harness.vt.sendInput('\r') // inspect
  await harness.waitForFrame()
  harness.vt.sendInput('\r') // install -> starting (held)
  await harness.waitForFrame()
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
  await harness.waitForFrame()
  const retained = harness.controller.installView()!.log
  assert.ok(retained.length > 0)
  harness.vt.sendInput('c')
  await harness.waitForFrame()
  assert.equal(harness.copied.length, 1)
  assert.ok(harness.copied[0]!.endsWith(retained.join('\n')),
    'the clipboard payload ends with the exact retained log, without a display projection')
  assert.ok(harness.copied[0]!.includes('! raw\tline'), 'stderr prefix and TAB are preserved byte-exact')
  assert.ok(harness.copied[0]!.includes('\u001b]52;c;YXR0YWNr\u0007'), 'the raw OSC sequence is preserved')
  assert.ok(!harness.view().includes('YXR0YWNr'), 'the display projection still strips the payload')
  gate.resolve({ changed: true, application: 'applied', stage: 'install', target: 'pkg' })
  await harness.waitForFrame()
})

test('the embedded page always names its real Esc destination', async () => {
  const harness = await open({ columns: 120, rows: 30 })
  assert.match(plain([harness.viewport().at(-1)!]), /Esc back/,
    'the List root yields to Categories, it never closes the Settings lease')
  harness.vt.sendInput('i')
  await harness.waitForFrame()
  assert.match(plain([harness.viewport().at(-1)!]), /Esc back/,
    'the install editor returns to the LIST, so it must not claim Esc close')
  harness.vt.sendInput('\t') // spec -> registry focus
  await harness.waitForFrame()
  const editor = plain(harness.viewport())
  assert.match(editor, /Reg\s+> /, 'registry focus uses the existing > selection device')
  assert.doesNotMatch(editor, /‹/, 'no third focus glyph is introduced')
  harness.vt.sendInput('\x1b')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'list')
  assert.equal(harness.snapshotCalls(), 1, 'hiding the install view never re-reads the inventory')
  // The List root yields to the rail, whose ONE bar names the real close.
  harness.vt.sendInput('\x1b')
  await harness.waitForFrame()
  assert.match(plain([harness.viewport().at(-1)!]), /Esc close/,
    'the rail owns the physical last row after the yield')
  assert.equal(harness.panel.focused, false, 'the rail owns the input focus')
})

test('80x10 keeps the removal consequence and both choices reachable', async () => {
  const harness = await open({ columns: 80, rows: 10 })
  await selectCard(harness, 'bundle:@vendor/foo')
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[B') // Enable… -> Remove…
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
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
  await harness.waitForFrame()
  harness.vt.sendInput('\r') // Details
  await harness.waitForFrame()
  harness.vt.sendInput('\r') // first Enter reveals the offscreen action
  await harness.waitForFrame()
  assert.match(harness.view(), /Actions/)
  assert.match(harness.view(), /Install…/)
  harness.vt.sendInput('\r') // now the painted action is admitted
  await harness.waitForFrame()
  assert.match(harness.view(), /offered version 0\.2\.1-rc\.2/)
  assert.match(harness.view(), /Activates the bundle/)
  assert.match(harness.view(), /Install/)
  assert.match(plain([harness.viewport().at(-1)!]), /Esc edit/)
})

test('a resize mid-install keeps the same request and a truthful last-row bar', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = await open({ columns: 140, rows: 40, installImpl: () => gate.promise })
  harness.vt.sendInput('\x1b[F')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.installCalls.length, 1)
  const requestId = harness.installCalls[0]!.requestId
  harness.vt.resize(80, 24)
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'install')
  assert.equal(harness.controller.installView()?.requestId, requestId)
  assert.match(plain([harness.viewport().at(-1)!]), /Esc hide/)
  for (const line of harness.viewport()) {
    assert.ok(plain([line]).length <= 80)
  }
  gate.resolve({ changed: true, application: 'applied', stage: 'install', target: 'x' })
  await harness.waitForFrame()
})

test('a second workspace lease is refused; an external disposal notifies exactly once', async () => {
  const harness = await open({ columns: 100, rows: 30 })
  // The Plugin Manager never leases a screen of its own: a second Settings
  // lease (which is what an independent plugin screen used to be) is refused.
  assert.throws(() => harness.app.openSettingsWorkspace(
    { readSnapshot: () => ({ configReadiness: 'ready', rows: [], capturedAt: Date.now() }) },
    { aboutVersionFacts: { tui: 'test', dsh: undefined } },
  ), /already leased/)

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
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  let disposals = 0
  const panel = new PluginManagerWorkspacePanel(controller, {
    requestRender: () => {},
    onCopy: () => {},
    onYieldNavigation: () => {},
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

test('disable opens the shared risk confirmation and writes only after the explicit choice', async () => {
  const harness = await open(autoReviewCatalog())
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  // The first Detail action is Disable….
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'confirm')
  assert.match(compact(harness.view()), new RegExp(AUTO_WARNING.replace(/[.]/gu, '\\.')))
  assert.deepEqual(harness.setBundle, [], 'opening the confirmation never mutates the Host')

  // Default focus is Cancel: Enter abandons without a write.
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'details')
  assert.deepEqual(harness.setBundle, [])

  // Re-open and explicitly choose the dangerous action: exactly one official
  // OFF write is dispatched (never a toggle inversion).
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[A') // Cancel -> Disable Auto Review
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.deepEqual(harness.setBundle, [{ name: AUTO_REVIEW, enabled: false }])
})

test('row disable cannot bypass the confirmation and writes the exact entry id', async () => {
  const harness = await open(autoReviewCatalog())
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  // Actions: Disable… (0), Disable row e-auto (1), Back (2).
  harness.vt.sendInput('\x1b[B')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'confirm')
  assert.match(compact(harness.view()), /Disable e-auto in Auto Review\?/)
  assert.match(compact(harness.view()), new RegExp(AUTO_WARNING.replace(/[.]/gu, '\\.')))
  assert.deepEqual(harness.setPlugin, [], 'a row toggle opens the confirmation instead of writing')

  harness.vt.sendInput('\x1b[A') // Cancel -> Disable Auto Review
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.deepEqual(harness.setPlugin, [{ entryId: 'e-auto', enabled: false }])
})

test('stale confirmation never writes after the authoritative inventory changed', async () => {
  const harness = await open(autoReviewCatalog())
  await selectCard(harness, `bundle:${AUTO_REVIEW}`)
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'confirm')
  // A reread invalidates the epoch the confirmation was opened against.
  harness.controller.refresh()
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[A')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.deepEqual(harness.setBundle, [], 'a stale confirmation dispatches no Host write')
  assert.match(harness.view(), /Auto Review changed since the confirmation opened/)
})

test('remove uses the same confirmation view with the same risk warning', async () => {
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
  await harness.waitForFrame()
  // Actions: Disable… (0), Remove… (1), Disable row (2), Back.
  harness.vt.sendInput('\x1b[B')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
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
    await harness.waitForFrame()
  }
  if (harness.panel.currentView() === 'details') {
    // The earlier Cancel can leave the Details cursor anywhere; the first
    // action is always the bundle-level Disable….
    harness.vt.sendInput('\x1b[A')
    harness.vt.sendInput('\x1b[A')
    harness.vt.sendInput('\r')
    await harness.waitForFrame()
  }
  assert.equal(harness.panel.currentView(), 'confirm')
}

test('danger primary is withheld on 80×5 and 44×8 until its consequence is fully visible', async () => {
  for (const [columns, rows] of [[80, 5], [44, 8]] as const) {
    const harness = await open(autoReviewCatalog())
    await openAutoConfirm(harness)
    const fullPrimaryRow = rowOf(harness, 'Disable Auto Review')
    const fullPrimaryCol = plain([harness.viewport()[fullPrimaryRow]!]).indexOf('Disable Auto Review')
    assert.ok(fullPrimaryRow >= 0, 'the full frame offers the dangerous primary')
    harness.vt.resize(columns, rows)
    await harness.waitForFrame()
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
    await harness.waitForFrame()
    assert.deepEqual(harness.setBundle, [])
    const reopened = harness.panel.currentView()
    if (reopened !== 'confirm') {
      // Cancel closed the page; reopen at a full size to test the mouse path.
      harness.vt.resize(140, 40)
      await harness.waitForFrame()
      await openAutoConfirm(harness)
      harness.vt.resize(columns, rows)
      await harness.waitForFrame()
    }
    press(harness, fullPrimaryRow, fullPrimaryCol)
    release(harness, fullPrimaryRow, fullPrimaryCol)
    await harness.waitForFrame()
    assert.deepEqual(harness.setBundle, [], 'a click at the old dangerous target cannot write')
    harness.vt.sendInput('\x1b[6~') // PgDn
    await harness.waitForFrame()
    assert.deepEqual(harness.setBundle, [], 'scrolling at this size cannot make an incomplete warning complete')
    harness.vt.sendInput('\x1b')
    await harness.waitForFrame()
    started.delete(harness)
    harness.app.dispose()
  }
})

test('danger primary disappears when the warning scrolls out and returns with it', async () => {
  const harness = await open(autoReviewCatalog())
  await openAutoConfirm(harness)
  assert.match(harness.view(), /Disable Auto Review/)
  harness.vt.resize(80, 10)
  await harness.waitForFrame()
  assert.match(harness.view(), /Disable Auto Review/, '80×10 can show the whole warning with both choices')
  harness.vt.sendInput('\x1b[6~') // PgDn: the warning top scrolls out of the 3-row viewport
  await harness.waitForFrame()
  assert.doesNotMatch(harness.view(), /^  Disable Auto Review\s*$/mu,
    'the dangerous primary is withheld once its warning is no longer fully visible')
  assert.match(plain([harness.viewport().at(-1)!]), /Enter cancel/u)
  assert.match(harness.view(), /^> Cancel\s*$/mu,
    'the withheld frame paints the cursor on Cancel')
  harness.vt.sendInput('\r') // Enter dispatches the PAINTED Cancel, not a hidden primary
  await harness.waitForFrame()
  assert.deepEqual(harness.setBundle, [])
  assert.equal(harness.panel.currentView(), 'details')

  // Re-open; PgDn hides the warning, PgUp restores it. The cursor must remain
  // on Cancel in the SAME frame that paints the primary, so a direct Enter is
  // Cancel (no Host write); only Up+Enter may perform the dangerous action.
  harness.vt.resize(140, 40)
  await harness.waitForFrame()
  await openAutoConfirm(harness)
  harness.vt.resize(80, 10)
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[6~')
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[5~') // PgUp
  await harness.waitForFrame()
  assert.match(harness.view(), /^(?:> |  )Disable Auto Review\s*$/mu)
  assert.match(harness.view(), /^> Cancel\s*$/mu,
    'the re-revealed frame keeps the cursor on the safe default Cancel')
  assert.match(plain([harness.viewport().at(-1)!]), /Enter confirm/u)
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.deepEqual(harness.setBundle, [], 'a direct Enter after PgUp cancels instead of writing')
  assert.equal(harness.panel.currentView(), 'details')

  // Third pass: the explicit Up+Enter choice is the dangerous write.
  harness.vt.resize(140, 40)
  await harness.waitForFrame()
  await openAutoConfirm(harness)
  harness.vt.resize(80, 10)
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[6~')
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[5~')
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b[A') // Cancel -> primary (visible, consequence complete)
  await harness.waitForFrame()
  assert.match(harness.view(), /^> Disable Auto Review\s*$/mu)
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.deepEqual(harness.setBundle, [{ name: AUTO_REVIEW, enabled: false }])
})

test('ordinary Bundle Remove is withheld at 80×5 but reachable at 80×10', async () => {
  const short = await open({ columns: 140, rows: 40 })
  await selectCard(short, 'bundle:@vendor/foo')
  short.vt.sendInput('\r')
  await short.waitForFrame()
  short.vt.sendInput('\x1b[B') // Enable… -> Remove…
  await short.waitForFrame()
  short.vt.sendInput('\r')
  await short.waitForFrame()
  assert.equal(short.panel.currentView(), 'confirm')
  short.vt.resize(80, 5)
  await short.waitForFrame()
  assert.doesNotMatch(short.view(), /^  Remove\s*$/mu, '80×5 cannot show the unload consequence with Remove')
  assert.match(plain([short.viewport().at(-1)!]), /Enter cancel/u)
  short.vt.sendInput('\r')
  await short.waitForFrame()
  assert.deepEqual(short.removeBundle, [])
  started.delete(short)
  short.app.dispose()

  const tall = await open({ columns: 140, rows: 40 })
  await selectCard(tall, 'bundle:@vendor/foo')
  tall.vt.sendInput('\r')
  await tall.waitForFrame()
  tall.vt.sendInput('\x1b[B')
  await tall.waitForFrame()
  tall.vt.sendInput('\r')
  await tall.waitForFrame()
  tall.vt.resize(80, 10)
  await tall.waitForFrame()
  assert.match(tall.view(), /^  Remove\s*$/mu, '80×10 shows the consequence with Remove')
  tall.vt.sendInput('\x1b[A')
  await tall.waitForFrame()
  tall.vt.sendInput('\r')
  await tall.waitForFrame()
  assert.deepEqual(tall.removeBundle, ['@vendor/foo'])
})

test('a zero-row list frame advertises no Enter invite and keeps the real Esc', async t => {
  const harness = await open({ columns: 140, rows: 40 })
  t.after(() => { try { harness.app.dispose() } catch {} })
  harness.vt.resize(80, 2)
  await harness.waitForFrame()
  const bar = plain([harness.viewport().at(-1)!])
  assert.equal(bar.trim(), 'Esc back', 'the zero-row list bar advertises ONLY the real Esc destination')
  // The hidden row is not just a missing hint: the navigation admission must
  // agree with it (Enter and Right cannot enter an invisible card's Details).
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'list', 'Enter on a zero-row list cannot enter Details')
  harness.vt.sendInput('\x1b[C')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'list', 'Right on a zero-row list cannot enter Details')
})

test('a zero-row search edit advertises only the real Esc and refuses the apply', async t => {
  const harness = await open({ columns: 140, rows: 40 })
  t.after(() => { try { harness.app.dispose() } catch {} })
  harness.vt.sendInput('/')
  await harness.waitForFrame()
  for (const character of 'foo') harness.vt.sendInput(character)
  await harness.waitForFrame()
  harness.vt.resize(80, 2)
  await harness.waitForFrame()
  const bar = plain([harness.viewport().at(-1)!])
  assert.doesNotMatch(bar, /Enter apply/u, 'the frozen short-screen rule drops the invisible apply hint')
  assert.match(bar, /Esc clear search/u, 'the real Esc effect stays advertised')
  // The hint is truthful: the zero-row Enter cannot apply an input whose body
  // cell is not painted. Enter and ordinary typing are both dropped.
  harness.vt.sendInput('x')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'list')
  harness.vt.resize(140, 40)
  await harness.waitForFrame()
  assert.match(harness.view(), /Search: foo/u, 'the zero-row typing never reached the input')
  assert.match(plain([harness.viewport().at(-1)!]), /Enter apply/u,
    'the zero-row Enter did not apply the search; the editor is still open')
  // The advertised real Esc still works on the zero-row frame.
  harness.vt.resize(80, 2)
  await harness.waitForFrame()
  harness.vt.sendInput('\x1b')
  await harness.waitForFrame()
  harness.vt.resize(140, 40)
  await harness.waitForFrame()
  assert.doesNotMatch(harness.view(), /Search: foo/u, 'Esc cleared the search')
  assert.doesNotMatch(plain([harness.viewport().at(-1)!]), /Enter apply/u, 'Esc left the search editor')
})

test('a resize before the repaint cannot enter invisible Details via Enter/Right', async t => {
  for (const key of ['\r', '\x1b[C'] as const) {
    const harness = await open({ columns: 140, rows: 40 })
    try {
      // No settle between resize and the key: the panel's paintedChrome still
      // carries the 140x40 body, while the terminal is already 80x2.
      harness.vt.resize(80, 2)
      harness.vt.sendInput(key)
      await harness.waitForFrame()
      assert.equal(harness.panel.currentView(), 'list',
        `${key === '\r' ? 'Enter' : 'Right'} must not enter Details from a stale frame`)
    } finally {
      started.delete(harness)
      harness.app.dispose()
    }
  }

  const recovered = await open({ columns: 140, rows: 40 })
  t.after(() => { try { recovered.app.dispose() } catch {} })
  recovered.vt.resize(80, 2)
  await recovered.waitForFrame()
  recovered.vt.sendInput('\r')
  await recovered.waitForFrame()
  assert.equal(recovered.panel.currentView(), 'list', 'the zero-row painted frame still refuses')
  recovered.vt.resize(140, 40)
  await recovered.waitForFrame()
  recovered.vt.sendInput('\r')
  await recovered.waitForFrame()
  assert.equal(recovered.panel.currentView(), 'details', 'a repainted full-size frame admits Enter again')
})

test('a zero-row body revokes the B03 danger action until it is painted again', async () => {
  const harness = await open(autoReviewCatalog())
  await openAutoConfirm(harness)
  harness.vt.sendInput('\x1b[A') // select the dangerous primary
  await harness.waitForFrame()
  assert.match(harness.view(), /^> Disable Auto Review\s*$/mu)

  harness.vt.resize(80, 2)
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'confirm')
  const zeroBar = plain([harness.viewport().at(-1)!])
  assert.doesNotMatch(zeroBar, /Enter/u, 'a zero-row frame never advertises a no-op Enter')
  assert.match(zeroBar, /Esc cancel/u, 'the real Esc destination stays advertised')
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'confirm', 'Enter on a zero-row frame is a no-op')
  assert.deepEqual(harness.setBundle, [])

  harness.vt.resize(140, 40)
  await harness.waitForFrame()
  assert.match(harness.view(), /^> Cancel\s*$/mu,
    'the restored frame defaults back to Cancel, not the previous dangerous index')
  assert.match(harness.view(), /Disable Auto Review/)
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.equal(harness.panel.currentView(), 'details')
  assert.deepEqual(harness.setBundle, [])

  await openAutoConfirm(harness)
  harness.vt.sendInput('\x1b[A')
  await harness.waitForFrame()
  harness.vt.sendInput('\r')
  await harness.waitForFrame()
  assert.deepEqual(harness.setBundle, [{ name: AUTO_REVIEW, enabled: false }])
})

test('a zero-row body revokes ordinary Remove and Detail actions', async () => {
  const remove = await open({ columns: 140, rows: 40 })
  await selectCard(remove, 'bundle:@vendor/foo')
  remove.vt.sendInput('\r')
  await remove.waitForFrame()
  remove.vt.sendInput('\x1b[B') // Enable… -> Remove…
  await remove.waitForFrame()
  remove.vt.sendInput('\r')
  await remove.waitForFrame()
  remove.vt.sendInput('\x1b[A') // Cancel -> Remove
  await remove.waitForFrame()
  remove.vt.resize(80, 2)
  await remove.waitForFrame()
  const removeBar = plain([remove.viewport().at(-1)!])
  assert.doesNotMatch(removeBar, /Enter/u, 'a zero-row confirm never advertises Enter')
  assert.match(removeBar, /Esc cancel/u)
  remove.vt.sendInput('\r')
  await remove.waitForFrame()
  assert.deepEqual(remove.removeBundle, [], 'a zero-row Remove frame cannot write')
  remove.vt.resize(140, 40)
  await remove.waitForFrame()
  assert.match(remove.view(), /^> Cancel\s*$/mu)
  remove.vt.sendInput('\r')
  await remove.waitForFrame()
  assert.deepEqual(remove.removeBundle, [])
  started.delete(remove)
  remove.app.dispose()

  const detail = await open({ columns: 140, rows: 40 })
  await selectCard(detail, 'bundle:@vendor/foo')
  detail.vt.sendInput('\r')
  await detail.waitForFrame()
  assert.equal(detail.panel.currentView(), 'details')
  detail.vt.resize(80, 2)
  await detail.waitForFrame()
  const detailBar = plain([detail.viewport().at(-1)!])
  assert.doesNotMatch(detailBar, /Enter/u, 'a zero-row Detail never advertises Enter action')
  assert.match(detailBar, /Esc back/u)
  detail.vt.sendInput('\r')
  await detail.waitForFrame()
  assert.equal(detail.panel.currentView(), 'details', 'a zero-row Detail frame cannot activate an action')
  started.delete(detail)
  detail.app.dispose()
})
