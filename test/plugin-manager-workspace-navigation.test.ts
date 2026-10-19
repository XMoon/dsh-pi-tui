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
import type { PluginChangeFact } from '../src/runtime/plugin-manager-port.ts'
import { openWorkspace, plain, type WorkspaceHarness } from './support/plugin-workspace-harness.ts'

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

test('Esc advertises the real destination per entry host', async () => {
  const direct = await open({ columns: 120, rows: 30 })
  assert.match(plain([direct.viewport().at(-1)!]), /Esc close/)
  direct.vt.sendInput('i')
  await direct.settle()
  assert.match(plain([direct.viewport().at(-1)!]), /Esc back/,
    'the direct install editor returns to the LIST, so it must not claim Esc close')
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
