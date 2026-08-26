/**
 * M11 tests (plan §16): API v1 hardening — the deprecation policy
 * surface, the /status extension-health rows, and the stability contract
 * (capability feature-detect).
 * @module @xmoon76/dsh-pi-tui/extension-api-v1.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

test('API v1: the deprecation map is part of the api() contract and empty at v1', async () => {
  // Mount the REAL service (startup + extension host) and read api()
  // from it — the contract is asserted against the implementation, not a
  // locally fabricated object.
  const { mountRealService } = await import('./extension-lifecycle-helpers.ts')
  const { service, dispose } = await mountRealService()
  try {
    const info = service.api()
    assert.equal(info.apiVersion, 1)
    assert.equal(info.deprecations.size, 0, 'nothing is deprecated at API v1')
  } finally {
    dispose()
  }
})

test('API v1: capabilities are feature-detected, never version-parsed', async () => {
  // The REAL service advertises the full slot set from provide-time (no
  // surface attached yet) — the feature-detect contract plugins rely on.
  const { mountRealService } = await import('./extension-lifecycle-helpers.ts')
  const { service, dispose } = await mountRealService()
  try {
    const advertised = service.api().capabilities
    for (const slot of ['slot.chrome.header.badge', 'slot.input.dock.item', 'slot.chrome.footer.status', 'slot.chrome.footer.item', 'slot.input.widget']) {
      assert.ok(advertised.has(slot), `the real service must advertise ${slot} pre-surface`)
    }
  } finally {
    dispose()
  }
  // The documented stability contract: a plugin checks capabilities.has()
  // and treats an absent capability as unavailable.
  const capabilities = new Set(['slot.input.widget', 'slot.input.dock.item'])
  assert.equal(capabilities.has('slot.chrome.header.badge'), false)
  assert.equal(capabilities.has('slot.input.widget'), true)
  // The full M1–M10 capability set is a superset of the first-wave set.
  const full = new Set([
    'slot.chrome.header.badge',
    'slot.input.dock.item',
    'slot.chrome.footer.status',
    'slot.chrome.footer.item',
    'slot.input.widget',
    'surface.snapshot',
  ])
  for (const capability of capabilities) assert.ok(full.has(capability))
})

test('M11: extensionHealthRows reports the live registry counts', async () => {
  const { extensionHealthRows } = await import('../src/commands.ts')
  const { CommandBridge } = await import('../src/command-bridge.ts')
  const { ThemeRegistry } = await import('../src/theme-registry.ts')
  const { SettingsRegistry } = await import('../src/settings-registry.ts')
  const { AutocompleteRegistry } = await import('../src/autocomplete-registry.ts')
  const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const commands = new CommandBridge()
  commands.register({ id: 'c1', name: 'vimmode', description: '', execution: 'local' }, 'owner')
  const themes = new ThemeRegistry()
  const settings = new SettingsRegistry()
  const autocomplete = new AutocompleteRegistry()
  const keybindings = new KeybindingRegistry()
  const renderers = new RendererRegistry()
  renderers.registerToolRenderer({ id: 't1', toolName: 'bash', render: () => undefined }, 'owner')
  const editors = new EditorRegistry()
  const runner = { extensions: { commands, themes, settings, autocomplete, keybindings, renderers, editors } }
  const rows = extensionHealthRows(runner as never)
  assert.ok(rows.length >= 3, 'the health section renders')
  const counts = rows.find(row => row.id === 'ext-registry-counts')
  assert.ok(counts !== undefined)
  assert.ok(counts.currentValue.includes('cmd 1'), 'the command count is reported')
  assert.ok(counts.currentValue.includes('ren 1'), 'the renderer count is reported')
  // The capability row reflects the REAL api() set (round-1 finding 1):
  // fake ids ('slots'/'overlays'/'editor-sdk') must never appear; the
  // registry-type row is a separate diagnostic.
  const capabilities = rows.find(row => row.id === 'ext-capabilities')
  assert.ok(capabilities !== undefined)
  assert.ok(!capabilities.currentValue.includes('editor-sdk'), 'no fake capability ids')
  assert.ok(!capabilities.currentValue.includes('overlays'), 'no fake capability ids')
  const registries = rows.find(row => row.id === 'ext-registries')
  assert.ok(registries !== undefined)
  assert.ok(registries.currentValue.includes('commands'), 'live registry types are a diagnostic')
  assert.ok(registries.currentValue.includes('renderers'), 'live registry types are a diagnostic')
  // Without the extension service the rows vanish (no crash).
  assert.deepEqual(extensionHealthRows({ extensions: undefined } as never), [])
})

test('M11: the capability row reflects the real capability set across states (round-1 finding 1)', async () => {
  const { extensionHealthRows } = await import('../src/commands.ts')
  const { CommandBridge } = await import('../src/command-bridge.ts')
  const { ThemeRegistry } = await import('../src/theme-registry.ts')
  const { SettingsRegistry } = await import('../src/settings-registry.ts')
  const { AutocompleteRegistry } = await import('../src/autocomplete-registry.ts')
  const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  // EMPTY registries + a real capability set (the api() source of truth).
  const base = {
    commands: new CommandBridge(),
    themes: new ThemeRegistry(),
    settings: new SettingsRegistry(),
    autocomplete: new AutocompleteRegistry(),
    keybindings: new KeybindingRegistry(),
    renderers: new RendererRegistry(),
    editors: new EditorRegistry(),
    api: () => ({ apiVersion: 1 as const, hostVersion: '0.2.0', capabilities: new Set(['slot.input.widget', 'surface.snapshot']), deprecations: new Map() }),
  }
  const rows = extensionHealthRows({ extensions: base } as never)
  const capabilities = rows.find(row => row.id === 'ext-capabilities')
  assert.ok(capabilities !== undefined)
  assert.ok(capabilities.currentValue.includes('slot.input.widget'), 'real capability ids render')
  assert.ok(capabilities.currentValue.includes('surface.snapshot'), 'real capability ids render')
  assert.ok(!capabilities.currentValue.includes('commands'), 'a registry with zero contributions is not a capability')
  const registries = rows.find(row => row.id === 'ext-registries')
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  assert.equal(strip(registries?.currentValue ?? ''), 'none', 'empty registries report none')
})

test('M11: a large transcript with extension renderers stays healthy (plan §23)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { RendererRegistry } = await import('../src/renderer-registry.ts')
  const registry = new RendererRegistry()
  registry.registerToolRenderer({
    id: 'perf-bash', toolName: 'bash',
    render: (snapshot) => ({
      kind: 'text',
      spans: [{ text: `custom ${snapshot.status}` }],
    }),
  }, 'plugin')
  const vt = new VirtualTerminal(120, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  await vt.waitForRender()
  // 500 tool messages through the cache + renderer chain.
  const messages = Array.from({ length: 500 }, (_, index) => ({
    kind: 'tool' as const,
    turn: index,
    name: 'bash',
    args: JSON.stringify({ command: `echo ${index}` }),
    result: `out ${index}`,
    status: 'ok' as const,
  }))
  const start = performance.now()
  for (const message of messages) {
    const entry = app.messageCacheEntryForTest?.(message, 0)
    assert.equal(entry?.rendererId, 'perf-bash', 'the renderer claims the card')
  }
  const elapsed = performance.now() - start
  // 500 builds well under 2s (the renderer chain + cache identity stay
  // O(1)-ish per message — plan §23).
  assert.ok(elapsed < 2000, `large-transcript renderer pass took ${elapsed.toFixed(0)}ms`)
  // Unload: the cache entries rebuild to the host card (the identity
  // gate drops the renderer).
  registry.disposeOwner('plugin')
  for (const message of messages.slice(0, 20)) {
    const entry = app.messageCacheEntryForTest?.(message, 0)
    assert.equal(entry?.rendererId, undefined, 'unload drops the renderer identity')
  }
  app.stop()
})

test('the runner health bridge is OWNER-LESS: (slot, id, error) resolves the owner internally and the record lands', async () => {
  // The review's P2: the service's runner-facing bridges must NOT carry an
  // owner parameter — the runner's structural copy (index.ts) is the
  // authoritative protocol, and a drift silently misaligns EVERY call
  // site (the Error object lands in the owner slot and the health record
  // never matches). The owner is resolved HERE from the registry's own
  // record by (slot, id) — including the theme registry's SELECTABLE
  // name, which the runner addresses themes by.
  const { Context } = await import('@deepseek-ai/cordis')
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const { apply: applyExtensionHost } = await import('../src/extensions.ts')
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startup = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
    })
    await startup
    await ctx.plugin(applyExtensionHost)
    const service = ctx.get('piTuiExtensions') as unknown as {
      registerTheme(contribution: { id: string; name: string; palette: unknown }): unknown
      _recordRegistryError(slot: string, id: string, error: unknown): void
      _clearRegistryError(slot: string, id: string): void
      _ledger(): { healthSnapshot(): Array<{ id: string; owner: string; state: string; lastError?: string }> }
    }
    const themeFiber = ctx.plugin({ name: 'health-owner', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerTheme(c: { id: string; name: string; palette: unknown }): unknown }
      svc.registerTheme({ id: 'health-theme', name: 'Health Theme', palette: {} })
    } })
    await themeFiber
    // The runner-facing protocol: (slot, id, error) — no owner slot. The
    // record must land keyed by the CONTRIBUTION id with the owner
    // resolved from the theme NAME.
    service._recordRegistryError('theme', 'Health Theme', new Error('palette boom'))
    const health = service._ledger().healthSnapshot()
    const record = health.find(entry => entry.id === 'health-theme')
    assert.ok(record !== undefined, 'the bridge must land the record (owner resolved internally)')
    assert.ok(record.owner.endsWith(':health-owner'), `the resolved owner must be the registering fiber: ${record.owner}`)
    assert.equal(record.state, 'failed')
    assert.equal(record.lastError, 'palette boom')
    // Recovery through the same owner-less bridge clears exactly this
    // record.
    service._clearRegistryError('theme', 'Health Theme')
    const after = service._ledger().healthSnapshot().find(entry => entry.id === 'health-theme')
    assert.equal(after?.state, 'active', 'the owner-less clear must recover the record')
    // An UNKNOWN id is skipped: a ghost error must not mint a record.
    service._recordRegistryError('theme', 'No Such Theme', new Error('ghost'))
    assert.equal(service._ledger().healthSnapshot().length, 1, 'a ghost error must not mint a health record')
    // The name/id cross-resolution (the review's P2): another theme whose
    // CONTRIBUTION ID equals this theme's SELECTABLE name must not shadow
    // it — the name matches FIRST (an id-first lookup would land the
    // error on the wrong owner).
    const secondFiber = ctx.plugin({ name: 'id-clash-owner', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerTheme(c: { id: string; name: string; palette: unknown }): unknown }
      svc.registerTheme({ id: 'Health Theme', name: 'other-name', palette: {} })
    } })
    await secondFiber
    service._recordRegistryError('theme', 'Health Theme', new Error('name-first boom'))
    const clash = service._ledger().healthSnapshot().find(entry => entry.id === 'health-theme')
    assert.equal(clash?.lastError, 'name-first boom',
      'the selectable-name match must win over a same-string contribution id')
    assert.ok(clash?.owner.endsWith(':health-owner'), `the error must land on the NAMED theme's owner: ${clash?.owner}`)
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})
