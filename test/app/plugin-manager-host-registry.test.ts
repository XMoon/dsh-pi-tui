/**
 * Owner-integration tests for the Plugin Manager host registry (PR2): the ONE
 * embedded `Settings → Plugins` page claims the ONE controller and releases the
 * claim only on a REAL teardown (the page's `onDispose`). A focus yield back to
 * the Categories rail keeps the claim; a duplicate claim is a synchronous
 * programming error; a stale token can never release a newer owner.
 *
 * There is exactly ONE host entry (the Settings lease), so the retired
 * "nested previous owner" / normal-close-callback model is deliberately absent.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-host-registry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import { PluginManagerHostRegistry } from '../../src/app/plugin-manager/host-registry.ts'
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import type { PluginManagerPort } from '../../src/runtime/plugin-manager-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'

const PORT: PluginManagerPort = {
  snapshot: async () => ({
    bundles: [{ name: 'ordinary', official: false, availability: 'profile', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }],
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
  subscribeInvalidation: () => () => {},
}

/** Mirrors the surface runtime/`settingsCommands` wiring over one registry. */
function controller(registry: PluginManagerHostRegistry): PluginManagerController {
  return new PluginManagerController(PORT, {
    requestRender: () => {},
    notify: () => {},
    isOpen: () => registry.isOpen(),
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
}

test('a duplicate claim throws synchronously and a released owner can be claimed again', () => {
  const registry = new PluginManagerHostRegistry()
  assert.equal(registry.isOpen(), false)
  const claim = registry.claim()
  assert.equal(registry.isOpen(), true)
  // The Settings root itself never builds a second page: a second claim is a
  // programming error, never a nested owner.
  assert.throws(() => registry.claim(), /already has an owning page/)
  assert.equal(registry.isOpen(), true, 'the refused claim never replaces the live owner')

  claim.release()
  assert.equal(registry.isOpen(), false)
  const next = registry.claim()
  assert.equal(registry.isOpen(), true, 'after release a new claim is accepted')
  next.release()
  assert.equal(registry.isOpen(), false)
})

test('release() is idempotent and a stale claim can never release a newer owner', () => {
  const registry = new PluginManagerHostRegistry()
  const first = registry.claim()
  first.release()
  first.release()
  assert.equal(registry.isOpen(), false, 'a repeated release is inert')

  const second = registry.claim()
  assert.equal(registry.isOpen(), true)
  // A late teardown of the OLD page must not clear the newer owner.
  first.release()
  assert.equal(registry.isOpen(), true)
  second.release()
  assert.equal(registry.isOpen(), false)
})

test('a real page teardown releases the owner exactly once; a navigation yield never does', () => {
  const registry = new PluginManagerHostRegistry()
  const manager = controller(registry)
  const claim = registry.claim()
  let releases = 0
  let yields = 0
  // The embedded page takes ONLY the new intents (no rows/columns/notice) and
  // releases its claim from the teardown hook, never from a navigation intent.
  const page = new PluginManagerWorkspacePanel(manager, {
    requestRender: () => {},
    onCopy: () => {},
    onYieldNavigation: () => { yields += 1 },
  }, { onDispose: () => { releases += 1; claim.release() } })
  try {
    // Esc at the untouched List root reports a YIELD: the page keeps the claim.
    page.handleInput('\x1b')
    assert.equal(yields, 1, 'the page reported the navigation yield to the Settings root')
    assert.equal(releases, 0, 'a focus yield must not release the owner')
    assert.equal(registry.isOpen(), true, 'the page still owns the controller after yielding')

    // The REAL Settings teardown disposes the page (and only then releases).
    page.dispose()
    page.dispose()
    assert.equal(releases, 1, 'the teardown hook runs exactly once even on a repeated dispose')
    assert.equal(registry.isOpen(), false, 'the real teardown released the owner')
    const reopened = registry.claim()
    assert.equal(registry.isOpen(), true, 'a later Settings → Plugins open can claim again')
    reopened.release()
  } finally {
    manager.dispose()
  }
})
