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

test('the runner health bridge is a CAPTURED REF: (slot, id) at invocation start, settlement against the ref', async () => {
  // The review's P2: the runner-facing protocol is a captured identity —
  // capture {slot, id, owner} at INVOCATION START and report settlements
  // against the ref (an HMR reload may replace the id with a new owner
  // by settle time; resolving from the LIVE registry at settle time
  // lands stale errors on the reloaded plugin).
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
      _recordRegistryHealthRef(slot: string, id: string): { slot: string; id: string; owner: string } | undefined
      _recordRegistryError(ref: { slot: string; id: string; owner: string }, error: unknown): void
      _clearRegistryError(ref: { slot: string; id: string; owner: string }): void
      _ledger(): { healthSnapshot(): Array<{ id: string; owner: string; state: string; lastError?: string }> }
    }
    const themeFiber = ctx.plugin({ name: 'health-owner', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerTheme(c: { id: string; name: string; palette: unknown }): unknown }
      svc.registerTheme({ id: 'health-theme', name: 'Health Theme', palette: {} })
    } })
    await themeFiber
    // Capture at invocation start (VALUE-addressed, the unified theme
    // protocol — the source-qualified selectable value); the settlement
    // reports against the captured ref.
    const selectable = 'plugin:health-owner/health-theme'
    const ref = service._recordRegistryHealthRef('theme', selectable)
    assert.ok(ref !== undefined, 'the capture must resolve the live contribution')
    assert.equal(ref.id, 'health-theme', 'the ref must carry the normalized contribution id')
    assert.ok(ref.owner.endsWith(':health-owner'), `the ref must carry the invoking owner: ${ref.owner}`)
    service._recordRegistryError(ref, new Error('palette boom'))
    const health = service._ledger().healthSnapshot()
    const record = health.find(entry => entry.id === 'health-theme')
    assert.ok(record !== undefined, 'the ref settlement must land the record')
    assert.equal(record.state, 'failed')
    assert.equal(record.lastError, 'palette boom')
    // Recovery through the same captured ref clears exactly this record.
    service._clearRegistryError(ref)
    const after = service._ledger().healthSnapshot().find(entry => entry.id === 'health-theme')
    assert.equal(after?.state, 'active', 'the ref clear must recover the record')
    // An UNKNOWN value yields no ref: the caller skips health reporting —
    // a ghost error must not mint a record. A BARE NAME (the old
    // protocol) also never resolves — a name is a label, not an identity
    // (the review's P2).
    assert.equal(service._recordRegistryHealthRef('theme', 'No Such Theme'), undefined)
    assert.equal(service._recordRegistryHealthRef('theme', 'Health Theme'), undefined,
      'a bare display name must never resolve a health ref')
    assert.equal(service._ledger().healthSnapshot().length, 1, 'a ghost error must not mint a health record')
    // The value/id cross-resolution (the review's P2): another theme whose
    // CONTRIBUTION ID equals this theme's SELECTABLE value string must not
    // shadow it — the value-addressed protocol resolves the VALUE only.
    const secondFiber = ctx.plugin({ name: 'id-clash-owner', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerTheme(c: { id: string; name: string; palette: unknown }): unknown }
      svc.registerTheme({ id: 'plugin:health-owner/health-theme', name: 'other-name', palette: {} })
    } })
    await secondFiber
    const clashRef = service._recordRegistryHealthRef('theme', selectable)
    assert.ok(clashRef !== undefined)
    service._recordRegistryError(clashRef, new Error('value-first boom'))
    const clash = service._ledger().healthSnapshot().find(entry => entry.id === 'health-theme')
    assert.equal(clash?.lastError, 'value-first boom',
      'the value-addressed capture must win over a same-string contribution id')
    assert.ok(clash?.owner.endsWith(':health-owner'), `the error must land on the VALUED theme's owner: ${clash?.owner}`)
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a captured health ref is a GENERATION FENCE: stale settlements never land on a reloaded owner', async () => {
  // The review's P2 HMR scenario: owner A starts an async contribution
  // (the ref is captured against A), A unloads and B reloads under the
  // SAME id — A's stale settlement (error OR success) must never mint a
  // record for B nor clear B's real failure.
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
      _recordRegistryHealthRef(slot: string, id: string): { slot: string; id: string; owner: string } | undefined
      _recordRegistryError(ref: { slot: string; id: string; owner: string }, error: unknown): void
      _clearRegistryError(ref: { slot: string; id: string; owner: string }): void
      _ledger(): { healthSnapshot(): Array<{ id: string; owner: string; state: string; lastError?: string }> }
    }
    // Owner A registers the theme and an async invocation captures its ref
    // (VALUE-addressed — the source-qualified selectable value, stable
    // across HMR because the stableOwner is the plugin NAME).
    const fiberA = ctx.plugin({ name: 'gen-a', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerTheme(c: { id: string; name: string; palette: unknown }): unknown }
      svc.registerTheme({ id: 'gen-theme', name: 'Gen Theme', palette: {} })
    } })
    await fiberA
    const selectable = 'plugin:gen-a/gen-theme'
    const refA = service._recordRegistryHealthRef('theme', selectable)
    assert.ok(refA !== undefined)
    // HMR: A unloads (its health record is untracked), B reloads the
    // same theme id under a NEW owner — but the SAME plugin name, so the
    // selectable value is identical (the persisted identity recovers).
    await (fiberA as { dispose(): Promise<void> }).dispose()
    await Promise.resolve()
    await Promise.resolve()
    const fiberB = ctx.plugin({ name: 'gen-a', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerTheme(c: { id: string; name: string; palette: unknown }): unknown }
      svc.registerTheme({ id: 'gen-theme', name: 'Gen Theme', palette: {} })
    } })
    await fiberB
    const refB = service._recordRegistryHealthRef('theme', selectable)
    assert.ok(refB !== undefined)
    assert.notEqual(refB.owner, refA.owner, 'the reloaded owner must differ from the captured one')
    assert.equal(refB.id, 'gen-theme', 'the value resolves the same contribution id after reload')
    // A's STALE failure settles: the captured ref must not mint a NEW
    // record (A's health was untracked on dispose) and must not mark B's
    // fresh record failed.
    service._recordRegistryError(refA, new Error('stale boom'))
    let health = service._ledger().healthSnapshot()
    let record = health.find(entry => entry.id === 'gen-theme')
    assert.equal(health.filter(entry => entry.id === 'gen-theme').length, 1,
      'the stale settlement must not mint an extra health record')
    assert.equal(record?.state, 'active', 'the stale settlement must not fail the reloaded owner\'s record')
    assert.equal(record?.lastError, undefined, 'the stale error message must not reach the reloaded owner')
    // B's REAL failure lands on B and stays: A's stale SUCCESS settling
    // afterwards must not clear it.
    service._recordRegistryError(refB, new Error('real boom'))
    health = service._ledger().healthSnapshot()
    record = health.find(entry => entry.id === 'gen-theme')
    assert.ok(record !== undefined && record.state === 'failed' && record.lastError === 'real boom')
    service._clearRegistryError(refA)
    health = service._ledger().healthSnapshot()
    record = health.find(entry => entry.id === 'gen-theme')
    assert.equal(record?.state, 'failed', 'a stale clear must never clear the reloaded owner\'s real failure')
    assert.equal(record?.lastError, 'real boom')
    // B's own recovery still works.
    service._clearRegistryError(refB)
    assert.equal(service._ledger().healthSnapshot().find(entry => entry.id === 'gen-theme')?.state, 'active')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the theme-unload hook fires with the SOURCE-QUALIFIED selectable value, and its release is generation-leased', async () => {
  // The review's P2: when the currently-applied plugin theme unloads, the
  // HOST must restore the builtin palette — the registry alone only
  // removes the record and repaints. The service notifies the runner's
  // hook (which owns the selection knowledge) with the SOURCE-QUALIFIED
  // selectable value on EVERY unload path (fiber unload, explicit
  // dispose). The setter returns a DISPOSER, and only the CURRENT token's
  // disposer clears the callback — an old runner generation's cleanup
  // must never clear a newer generation's hook (the stale-app trap).
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
      registerTheme(contribution: { id: string; name: string; palette: unknown }): { id: string; dispose(): void }
      setThemeUnloadedHook(hook: (unloaded: { selectableValue: string; name: string }) => void): () => void
    }
    const unloaded: string[] = []
    const release = service.setThemeUnloadedHook(({ selectableValue, name }) => {
      unloaded.push(selectableValue)
      unloaded.push(name)
    })
    const fiber = ctx.plugin({ name: 'theme-unload', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerTheme(c: { id: string; name: string; palette: unknown }): { id: string; dispose(): void } }
      svc.registerTheme({ id: 't1', name: 'Foo Theme', palette: {} })
    } })
    await fiber
    // Fiber unload: the hook fires with the SOURCE-QUALIFIED value (the
    // plugin's stable name 'theme-unload' + the id) AND the display name.
    await (fiber as { dispose(): Promise<void> }).dispose()
    await Promise.resolve()
    await Promise.resolve()
    assert.ok(unloaded.includes('plugin:theme-unload/t1'), `the hook must receive the selectable value on owner unload: ${unloaded}`)
    assert.ok(unloaded.includes('Foo Theme'), `the hook must receive the display name on owner unload: ${unloaded}`)
    // Explicit dispose (registered from the ROOT fiber — the stable name
    // is 'root'): the hook fires too. (The same theme may notify again
    // when its fiber's effect disposer runs at teardown — the host
    // fallback is idempotent: only a value matching the LIVE selection
    // triggers the restore, so repeats are no-ops.)
    const handle = service.registerTheme({ id: 't2', name: 'Bar Theme', palette: {} })
    handle.dispose()
    assert.ok(unloaded.includes('plugin:root/t2'), `the hook must receive the selectable value on explicit dispose: ${unloaded}`)
    // GENERATION LEASE: releasing the OLD generation's hook must not
    // clear the NEW generation's hook (the HMR window the review flagged).
    const second: string[] = []
    const releaseSecond = service.setThemeUnloadedHook(({ selectableValue }) => second.push(selectableValue))
    release() // THIS runner (old generation) unloads...
    const handle2 = service.registerTheme({ id: 't3', name: 'Baz Theme', palette: {} })
    handle2.dispose()
    assert.ok(second.includes('plugin:root/t3'),
      `a stale release must never clear the NEWER generation's hook: ${second}`)
    // The NEW generation's own release clears ITS hook — a later unload
    // no longer notifies.
    releaseSecond()
    const handle3 = service.registerTheme({ id: 't4', name: 'Qux Theme', palette: {} })
    handle3.dispose()
    assert.ok(!second.includes('plugin:root/t4'), 'releasing the current hook must stop notifications')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the invocation-time command health capture resolves a command registered AFTER submit (the dispatch window)', async () => {
  // The review's P2: the dispatch re-captures the command health ref at
  // INVOCATION time — it must NOT be gated on the submit-time id. A
  // plugin that registers during the async ensureSession phase is
  // therefore covered. This is the mechanism-level repro of that window:
  // a capture BEFORE registration is undefined, and a capture AFTER the
  // plugin appears resolves — exactly what the dispatch's second capture
  // relies on.
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
      registerCommand(contribution: { id: string; name: string; description: string; execution: 'local' }): unknown
      commands: { idFor(name: string): string | undefined }
      _recordRegistryHealthRef(slot: string, id: string): { slot: string; id: string; owner: string } | undefined
    }
    // SUBMIT time: the command is not registered yet — a submit-time
    // capture is undefined (the old gate short-circuited here and the
    // invocation was never health-tracked).
    assert.equal(service.commands.idFor('deploy'), undefined, 'pre-registration: no command id')
    assert.equal(service._recordRegistryHealthRef('command', 'deploy'), undefined)
    // The plugin loads during the async phase (HMR / first registration).
    const fiber = ctx.plugin({ name: 'late-command', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as { registerCommand(contribution: { id: string; name: string; description: string; execution: 'local' }): unknown }
      svc.registerCommand({ id: 'deploy-cmd', name: 'deploy', description: 'deploy', execution: 'local' })
    } })
    await fiber
    // INVOCATION time: the re-capture resolves — the dispatched command
    // is the new owner's, and its failures land on it.
    const id = service.commands.idFor('deploy')
    assert.equal(id, 'deploy-cmd')
    const ref = service._recordRegistryHealthRef('command', id)
    assert.ok(ref !== undefined, 'the invocation-time capture must resolve the late-registered command')
    assert.ok(ref.owner.endsWith(':late-command'), `the ref must name the late-registering owner: ${ref.owner}`)
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})
