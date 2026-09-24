/**
 * Owner-integration tests for the Plugin Manager host registry (P1-A): the
 * exact chain that matters across the two entries — a normal close runs the
 * user close path, while an EXTERNAL Settings parent teardown releases the
 * owner only, so a later `/plugins` still opens.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-host-registry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManagerController } from '../src/plugin-manager/controller.ts'
import { PluginManagerHostRegistry } from '../src/plugin-manager/host-registry.ts'
import { PluginManagerPanel } from '../src/plugin-manager/panel.ts'
import type { PluginManagerPort } from '../src/runtime/plugin-manager-port.ts'
import { createDiag } from '../src/diag.ts'

function port(): PluginManagerPort {
  return {
    snapshot: async () => ({
      bundles: [{ name: 'ordinary', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }],
      plugins: [],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
    inspect: async () => ({ status: 'refused', problem: 'unknown', reason: 'x' }),
    setBundleEnabled: async () => ({ changed: true, application: 'applied', stage: 'enable', target: '' }),
    setPluginEnabled: async () => ({ changed: true, application: 'applied', stage: 'enable', target: '' }),
    removeBundle: async () => ({ changed: true, application: 'applied', stage: 'remove', target: '' }),
    startInstall: async () => ({ changed: true, application: 'applied', stage: 'install', target: '' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
  }
}

/** Mirrors the src/index.ts wiring of both entries over one registry. */
function wiring(): {
  registry: PluginManagerHostRegistry
  openDirect: () => { panel: PluginManagerPanel } | undefined
  createSubmenu: (done: (selected?: string) => void) => PluginManagerPanel
} {
  const registry = new PluginManagerHostRegistry()
  const controller = new PluginManagerController(port(), {
    requestRender: () => {},
    requestClose: () => registry.closeActive(),
    notify: () => {},
    isOpen: () => registry.isOpen(),
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  return {
    registry,
    openDirect: () => {
      if (registry.isOpen()) return undefined
      let closeSurface: () => void = () => {}
      const claim = registry.claim(() => closeSurface())
      const panel = new PluginManagerPanel(controller, () => {}, { onDispose: () => claim.releaseExternally() })
      // Simulate the overlay: hiding it disposes the panel (its onDispose runs).
      closeSurface = () => panel.dispose()
      controller.open('direct-command')
      return { panel }
    },
    createSubmenu: (done) => {
      let claim: ReturnType<PluginManagerHostRegistry['claim']> | undefined
      const panel = new PluginManagerPanel(controller, () => {}, { onDispose: () => claim?.releaseExternally() })
      claim = registry.claim(() => claim?.closeNormally(), done)
      controller.open('settings-submenu')
      return panel
    },
  }
}

test('an external Settings teardown releases the owner without a user close, and /plugins then opens', () => {
  const { registry, openDirect, createSubmenu } = wiring()
  let doneCalls = 0
  const submenu = createSubmenu(() => { doneCalls += 1 })
  assert.equal(registry.isOpen(), true)

  // The Settings parent is hidden: it disposes the submenu WITHOUT calling done().
  submenu.dispose()
  assert.equal(registry.isOpen(), false, 'the owner must be released')
  assert.equal(doneCalls, 0, 'an external teardown must not fake a user close')

  const direct = openDirect()
  assert.ok(direct !== undefined, '/plugins must open after the external teardown')
  assert.equal(registry.isOpen(), true)
})

test('a normal close runs the user close path exactly once and releases the owner', () => {
  const { registry, createSubmenu } = wiring()
  let doneCalls = 0
  const submenu = createSubmenu(() => { doneCalls += 1 })
  registry.closeActive()
  assert.equal(doneCalls, 1)
  assert.equal(registry.isOpen(), false)
  // The subsequent external dispose of the already-closed panel is a no-op.
  submenu.dispose()
  assert.equal(doneCalls, 1)
})

test('a stale claim can never release a newer owner', () => {
  const registry = new PluginManagerHostRegistry()
  const first = registry.claim(() => {})
  first.releaseExternally()
  assert.equal(registry.isOpen(), false)
  const second = registry.claim(() => {})
  assert.equal(registry.isOpen(), true)
  // A late external teardown of the OLD claim must not clear the new owner.
  first.releaseExternally()
  assert.equal(registry.isOpen(), true)
  second.releaseExternally()
  assert.equal(registry.isOpen(), false)
})

test('the direct host releases its owner on an external overlay teardown', () => {
  const { registry, openDirect } = wiring()
  const direct = openDirect()
  assert.ok(direct !== undefined)
  assert.equal(registry.isOpen(), true)
  direct.panel.dispose()
  assert.equal(registry.isOpen(), false)
  assert.ok(openDirect() !== undefined)
})
