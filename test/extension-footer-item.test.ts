/**
 * M4 contract gate: the configurable footer item slot (plan §16). A real
 * Cordis tree (startup + extension host) + a real TuiApp + VirtualTerminal
 * proves: registration through the PUBLIC service API, the canonical
 * `ext:<owner>/<id>` config key, live replace()/dispose(), the composer
 * rendering the item, the configurator listing it, and the legacy
 * chrome.footer.status slot staying untouched.
 * @module @xmoon76/dsh-pi-tui/extension-footer-item.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Text } from '@xmoon76/pi-tui'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import type { FooterItemContribution } from '../src/extension/public-types.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { TuiApp } from '../src/tui-app.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Mount startup + extension host; returns the service + ledger. */
async function mountTree(ctx: Context): Promise<{ service: PiTuiExtensionServiceLike }> {
  await ctx.plugin(Loader)
  const startupFiber = ctx.plugin((c) => {
    c.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
  })
  await startupFiber
  const hostFiber = ctx.plugin(applyExtensionHost)
  await hostFiber
  return { service: ctx.get('piTuiExtensions') as unknown as PiTuiExtensionServiceLike }
}

interface PiTuiExtensionServiceLike {
  register<T>(slot: string, spec: { id: string; order?: number; description?: string }, value: T): {
    id: string
    replace(next: T): void
    dispose(): void
  }
  _ledger(): { snapshot(slot: string): { records: Array<{ id: string; owner: string; value: unknown }> } }
  attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
}

/** The canonical config key for one ledger record: ext:<stableOwner>/<id>.
 * The key derives from the record's HMR-STABLE owner (the fiber NAME — a
 * reloaded plugin gets a new uid but the same name); the ledger's runtime
 * `owner` stays uid-qualified for uniqueness/disposal. */
function canonicalKey(service: PiTuiExtensionServiceLike, slot: string, id: string): string {
  const record = service._ledger().snapshot(slot).records.find(entry => entry.id === id) as
    { id: string; owner: string; stableOwner?: string } | undefined
  assert.ok(record !== undefined, `record ${id} missing`)
  // Match the host's canonical key construction (the stable owner's `/` —
  // an npm scoped plugin name — is percent-encoded, injectively).
  return `ext:${encodeURIComponent(record.stableOwner ?? record.owner)}/${record.id}`
}

/** Attach a live TuiApp + SurfaceHost to the tree. */
function attachApp(service: PiTuiExtensionServiceLike): { vt: VirtualTerminal; app: TuiApp; host: SurfaceHost } {
  const vt = new VirtualTerminal(100, 30)
  const ledger = service._ledger() as never
  const host = new SurfaceHost(ledger, () => app.requestRender())
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId, generation: 1, width: 100, height: 30, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  service.attachSurface(
    { subscribe: (listener) => host.subscribeState(listener as never) },
    host.capabilitiesOf() as ReadonlySet<string>,
    host.surfaceId,
  )
  return { vt, app, host }
}

test('slot.chrome.footer.item is advertised BEFORE any surface exists', async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    // No surface attached: the advertised baseline must already expose the
    // item slot so a plugin can feature-detect at apply() time and
    // register-before-surface (the plan's registration contract).
    const api = (service as unknown as { api(): { capabilities: ReadonlySet<string> } }).api()
    assert.ok(api.capabilities.has('slot.chrome.footer.item'),
      'the item slot capability must be advertised from service-provide time')
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a plugin registers a configurable footer item; the composer renders it under the canonical key', async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    const { vt, app } = attachApp(service)
    // The capability is advertised (feature-detect).
    const api = (service as unknown as { api(): { capabilities: Set<string> } }).api()
    assert.ok(api.capabilities.has('slot.chrome.footer.item'), 'the new slot capability must be live')

    // A third-party-shaped plugin registers through the PUBLIC API.
    const quota = service.register<FooterItemContribution>('chrome.footer.item', {
      id: 'quota',
      order: 200,
      description: 'API quota footer item',
    }, {
      label: 'API quota',
      defaultZone: 'right',
      importance: 50,
      segment: { spans: [{ text: 'quota 82%', tone: 'success' }], minWidth: 8 },
    })
    await settle()
    await vt.waitForRender()

    // The canonical config key: ext:<owner>/<id> (the fiber identity).
    const key = canonicalKey(service, 'chrome.footer.item', 'quota')
    assert.ok(hostFooterIds(app).includes(key), `the canonical key must be exposed: ${key}`)
    // The SEGMENT's minWidth is the single min-width authority and MUST
    // reach the composer's item definition (the review's P2: the old
    // top-level duplicate was never forwarded).
    const def = app.getFooterItemRegistry().get(key)
    assert.equal(def?.minWidth, 8, `segment.minWidth must reach the item definition: ${JSON.stringify(def)}`)
    // And the composer honours it: at a width that cannot hold 8 cells,
    // the item is DROPPED (never truncated below its minWidth).
    const { FooterComposer } = await import('../src/footer/composer.ts')
    const { emptyStatusSnapshot } = await import('../src/status/types.ts')
    const composer = new FooterComposer(app.getFooterItemRegistry())
    const narrow = composer.render({
      snapshot: emptyStatusSnapshot(),
      layout: {
        schemaVersion: 1,
        rows: [{ left: [{ id: 'model' }], right: [{ id: key }] }],
      },
      width: 6,
      context: { taskBrowserAvailable: false, extensionFooterText: '' },
    })
    assert.ok(!narrow.includes('quota'), `below its minWidth the item must be dropped, never truncated:\n${narrow}`)
    // The DEPRECATED top-level minWidth is honored as a fallback when the
    // segment carries none (type-level compatibility), but the segment
    // WINS when both are set.
    service.register<FooterItemContribution>('chrome.footer.item', { id: 'legacy-width', order: 300 }, {
      label: 'Legacy width', segment: { spans: [{ text: 'legacy' }] }, minWidth: 12,
    })
    await settle()
    const legacyKey = canonicalKey(service, 'chrome.footer.item', 'legacy-width')
    assert.equal(app.getFooterItemRegistry().get(legacyKey)?.minWidth, 12,
      'the deprecated top-level minWidth must still be honored when the segment has none')
    service.register<FooterItemContribution>('chrome.footer.item', { id: 'both-widths', order: 99 }, {
      label: 'Both widths', segment: { spans: [{ text: 'both' }], minWidth: 4 }, minWidth: 12,
    })
    await settle()
    const bothKey = canonicalKey(service, 'chrome.footer.item', 'both-widths')
    assert.equal(app.getFooterItemRegistry().get(bothKey)?.minWidth, 4,
      'the segment minWidth must WIN over the deprecated top-level field')

    // A custom layout referencing the item renders it.
    app.setFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: 'model' }], right: [{ id: key }] }],
    })
    app.setStatus({ model: 'm', cwd: 'c' })
    await vt.waitForRender()
    let view = vt.getViewport().join('\n')
    assert.ok(view.includes('quota 82%'), `the extension item must render:\n${view}`)

    // replace() updates the LIVE render.
    quota.replace({
      label: 'API quota',
      defaultZone: 'right',
      importance: 50,
      segment: { spans: [{ text: 'quota 21%', tone: 'warning' }], minWidth: 8 },
    })
    await settle()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('quota 21%'), `replace() must re-render:\n${view}`)
    assert.ok(!view.includes('quota 82%'), `the stale value must be gone:\n${view}`)

    // dispose() removes the item (the config reference stays — the render
    // skips it).
    quota.dispose()
    await settle()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(!view.includes('quota 21%'), `a disposed item must not render:\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('the configurator lists extension items in the Available section and can add them', async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    const { vt, app } = attachApp(service)
    service.register<FooterItemContribution>('chrome.footer.item', {
      id: 'current',
      order: 100,
    }, {
      label: 'Kubernetes context',
      segment: { spans: [{ text: 'kube:prod' }] },
    })
    await settle()
    await vt.waitForRender()

    // Open the configurator: the extension item appears in Available.
    const { FooterConfiguratorModel } = await import('../src/footer/configurator-model.ts')
    const { DEFAULT_FOOTER_LAYOUT } = await import('../src/footer/presets.ts')
    const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
    app.openFooterConfigurator({
      model,
      registry: app.getFooterItemRegistry(),
      onSave: () => {},
      onCancel: () => {},
    })
    await vt.waitForRender()
    let view = vt.getViewport().join('\n')
    assert.ok(view.includes('Configure Footer'), `the configurator must open:\n${view}`)
    // Scroll to the BOTTOM of the Available section (the extension item is
    // the last available id — the content windows around the cursor).
    while (!model.state().cursorInAvailable) model.moveCursorDown()
    for (let i = 0; i < 20; i += 1) model.moveCursorDown()
    app.requestRender()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('Kubernetes context'), `the extension item must be listed:\n${view}`)

    // Add the item (the model is the authority; the preview renders below
    // the fold).
    vt.sendInput(' ')
    await vt.waitForRender()
    const layout = model.preview()
    const added = layout.rows.some(row => [...row.left, ...row.right].some(ref => ref.id.startsWith('ext:')))
    assert.ok(added, 'the extension item must be added to the draft')
    // Scroll to the bottom: the preview shows the added item.
    for (let i = 0; i < 12; i += 1) model.moveCursorDown()
    app.requestRender()
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('kube:prod'), `the added item must render in the preview:\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('named plugins keep distinct config keys; a same-plugin reload RECOVERS the key (HMR contract)', async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    const { vt, app } = attachApp(service)
    // NAMED plugins: the owner is the stable plugin name, so two
    // DIFFERENT plugins with the same item id get distinct config keys.
    const fiberA = ctx.plugin({ name: 'quota-a', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as PiTuiExtensionServiceLike
      svc.register<FooterItemContribution>('chrome.footer.item', { id: 'quota' }, {
        label: 'Quota A', segment: { spans: [{ text: 'A' }] },
      })
    } })
    await fiberA
    const keyA = canonicalKey(service, 'chrome.footer.item', 'quota')
    assert.ok(hostFooterIds(app).includes(keyA), `owner-a key missing: ${keyA}`)
    // A PERSISTED layout references the canonical key (the plan's HMR
    // recovery contract: the reference is kept across unload/reload and
    // recovers when the plugin comes back).
    app.setFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: keyA }], right: [] }],
    })
    app.setStatus({})
    await vt.waitForRender()
    assert.ok(vt.getViewport().join('\n').includes('A'), 'the layout must render the live item first')

    // A DIFFERENT named plugin with the same id registers WHILE owner-a
    // is still LIVE: both must coexist (the review's P2 — the old
    // (slot, id)-keyed ledger threw a duplicate here; the public contract
    // is unique per (slot, owner), and the canonical keys embed the
    // owner).
    const fiberB = ctx.plugin({ name: 'quota-b', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as PiTuiExtensionServiceLike
      svc.register<FooterItemContribution>('chrome.footer.item', { id: 'quota' }, {
        label: 'Quota B', segment: { spans: [{ text: 'B' }] },
      })
    } })
    await fiberB
    const records = service._ledger().snapshot('chrome.footer.item').records
    const keyOf = (stableOwner: string): string => {
      const record = records.find(entry => (entry as { stableOwner?: string }).stableOwner === stableOwner)
      assert.ok(record !== undefined, `record for stable owner ${stableOwner} missing`)
      return `ext:${encodeURIComponent((record as { stableOwner?: string }).stableOwner ?? record.owner)}/${record.id}`
    }
    const keyA2 = keyOf('quota-a')
    const keyB = keyOf('quota-b')
    assert.equal(keyA2, keyA, 'owner-a keeps its key')
    assert.ok(keyB !== keyA, 'the same id under a different NAMED plugin must be a NEW config key')
    assert.ok(hostFooterIds(app).includes(keyA), 'both live keys must be exposed')
    assert.ok(hostFooterIds(app).includes(keyB), `owner-b key missing: ${keyB}`)

    // Unloading ONE owner removes only ITS key: the other owner's same-id
    // item survives (owner-scoped disposal).
    await (fiberA as { dispose(): Promise<void> }).dispose()
    await settle()
    assert.ok(!hostFooterIds(app).includes(keyA), `the unloaded owner's key must disappear: ${keyA}`)
    assert.ok(hostFooterIds(app).includes(keyB), `the surviving owner's key must stay: ${keyB}`)
    await (fiberB as { dispose(): Promise<void> }).dispose()
    await settle()

    // HMR RELOAD of the SAME plugin: the new fiber gets a new uid but the
    // SAME name — the canonical key must be IDENTICAL, and the PERSISTED
    // layout (set above, still active) must recover automatically: the
    // item renders again without any layout change.
    const fiberC = ctx.plugin({ name: 'quota-a', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as PiTuiExtensionServiceLike
      svc.register<FooterItemContribution>('chrome.footer.item', { id: 'quota' }, {
        label: 'Quota A reloaded', segment: { spans: [{ text: 'A2' }] },
      })
    } })
    await fiberC
    const keyC = canonicalKey(service, 'chrome.footer.item', 'quota')
    assert.equal(keyC, keyA, 'a reloaded plugin must recover the SAME config key')
    assert.ok(hostFooterIds(app).includes(keyC), `the recovered key must be live: ${keyC}`)
    // The persisted layout still points at the key: the reloaded item
    // renders WITHOUT touching the layout.
    app.setStatus({})
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('A2'), `the recovered item must render in the persisted layout:\n${view}`)
    await (fiberC as { dispose(): Promise<void> }).dispose()
    await settle()

    // The legacy chrome.footer.status slot still works through ext:*
    // (the default layout).
    app.setFooterLayout(undefined)
    const legacy = service.register<{ spans: Array<{ text: string }> }>('chrome.footer.status', { id: 'legacy-seg' }, { spans: [{ text: '[LEGACY]' }] })
    await settle()
    await vt.waitForRender()
    const legacyView = vt.getViewport().join('\n')
    assert.ok(legacyView.includes('[LEGACY]'), `the legacy status segment must still render:\n${legacyView}`)
    legacy.dispose()
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

/** The app's registry ids (builtin + live extension items). */
function hostFooterIds(app: TuiApp): string[] {
  return app.getFooterItemRegistry().ids()
}

test("a configurable footer item span text is SANITIZED (no terminal control reaches the render)", async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    const { vt, app } = attachApp(service)
    const evil = '\u001b]0;title\u0007\u001b[2J\u001b[?1049hOSC52:\u001b]52;c;YQ==\u0007clean \u001b[31mred\u001b[0m \u009b1;1H'
    service.register<FooterItemContribution>('chrome.footer.item', { id: 'evil', order: 100 }, {
      label: 'Evil',
      segment: { spans: [{ text: evil }], minWidth: 4 },
    })
    await settle()
    await vt.waitForRender()
    const key = canonicalKey(service, 'chrome.footer.item', 'evil')
    app.setFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: key }], right: [] }],
    })
    app.setStatus({})
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    // The plain text survives; every control sequence is stripped.
    assert.ok(view.includes('clean'), `the plain text must survive:\n${view}`)
    assert.ok(view.includes('red'), `the SGR body text must survive (sequence stripped):\n${view}`)
    assert.ok(!view.includes('\u001b'), `no ESC sequence may reach the terminal:\n${JSON.stringify(view)}`)
    assert.ok(!view.includes('\u009b'), `no C1 CSI may reach the terminal:\n${JSON.stringify(view)}`)
    assert.ok(!view.includes('YQ=='), `the OSC 52 clipboard payload must be stripped:\n${view}`)
    assert.ok(!view.includes('1;1H'), `the C1 CSI cursor move must be stripped:\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a malformed item contribution degrades gracefully (never breaks the footer)', async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    const { vt, app } = attachApp(service)
    // Null segment, non-array spans, non-string text: the M4 boundary must
    // produce a safe (empty) definition — the footer keeps rendering.
    service.register<FooterItemContribution>('chrome.footer.item', { id: 'broken', order: 100 }, { label: 42 as unknown as string, segment: null as unknown as FooterItemContribution['segment'] })
    await settle()
    await vt.waitForRender()
    const key = canonicalKey(service, 'chrome.footer.item', 'broken')
    app.setFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: 'model' }], right: [{ id: key }] }],
    })
    app.setStatus({ model: 'm', cwd: 'c' })
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('m'), `the footer must keep rendering:\n${view}`)
    // The broken item renders NOTHING (its empty segment is skipped) —
    // graceful degradation, never a crash or a corrupted footer.
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('M4 footer items are MAIN-SUBJECT gated: they do not render while the subagent viewer is open', async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    const { vt, app } = attachApp(service)
    service.register<FooterItemContribution>('chrome.footer.item', { id: 'quota', order: 200 }, {
      label: 'API quota',
      segment: { spans: [{ text: 'quota 82%', tone: 'success' }], minWidth: 8 },
    })
    // A legacy chrome.footer.status segment (the ext:* bridge) for the
    // consistency assertion (both hide while viewing).
    service.register<{ spans: Array<{ text: string }> }>('chrome.footer.status', { id: 'legacy-seg', order: 100 }, { spans: [{ text: '[LEGACY]' }] })
    await settle()
    await vt.waitForRender()
    const key = canonicalKey(service, 'chrome.footer.item', 'quota')
    app.setFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: key }, { id: 'cwd' }, { id: 'ext:*' }], right: [] }],
    })
    app.setStatus({ model: 'm', cwd: 'c' })
    await vt.waitForRender()
    let view = vt.getViewport().join('\n')
    assert.ok(view.includes('quota 82%'), `the item must render on the main subject:\n${view}`)
    assert.ok(view.includes('[LEGACY]'), `the legacy segment must render on the main subject:\n${view}`)
    // Enter the subagent viewer: the data source switches to the CHILD,
    // and a static plugin contribution (which has no snapshot access to
    // self-gate) must not describe the viewed child.
    app.setViewerFooter({
      label: 'child',
      childSessionId: 'child-1',
      mode: 'one-shot',
      activity: 'inactive',
      cwd: '/child-ws',
      turns: 1,
      steps: 1,
      usage: undefined,
      statsLine: '',
    })
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(!view.includes('quota 82%'), `the M4 item must not render while viewing:\n${view}`)
    assert.ok(!view.includes('[LEGACY]'), `the legacy ext:* bridge must hide while viewing too:\n${view}`)
    assert.ok(view.includes('child-ws'), `the child workspace must show:\n${view}`)
    // Leaving the viewer restores it.
    app.setViewerFooter(undefined)
    await vt.waitForRender()
    view = vt.getViewport().join('\n')
    assert.ok(view.includes('quota 82%'), `the item must return after the viewer closes:\n${view}`)
    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

test('a chrome.footer.item registration id containing "/" is rejected; a SCOPED plugin owner is escaped, not rejected', async () => {
  const ctx = new Context()
  try {
    const { service } = await mountTree(ctx)
    assert.throws(
      () => service.register<FooterItemContribution>('chrome.footer.item', { id: 'a/b', order: 100 }, {
        label: 'bad', segment: { spans: [{ text: 'x' }] },
      }),
      /must not contain "\/"/,
      'a slash in the registration id must be rejected',
    )
    // A control-character id is the same injection class (the id is
    // persisted into user layouts and rendered raw by the configurator
    // when the plugin is gone): rejected too — and the REJECTION ERROR
    // itself must not interpolate the raw controls (host logs/diagnostics
    // would receive the ESC sequence).
    assert.throws(
      () => service.register<FooterItemContribution>('chrome.footer.item', { id: 'bad\u001b]52;c;x\u0007id', order: 100 }, {
        label: 'bad', segment: { spans: [{ text: 'x' }] },
      }),
      (error: Error) => {
        assert.match(error.message, /control characters/)
        assert.ok(!error.message.includes('\u001b'), 'the rejection error must not carry the raw ESC')
        assert.ok(!error.message.includes('\u0007'), 'the rejection error must not carry the raw BEL')
        assert.ok(error.message.includes('bad]52;c;xid'), 'the sanitized id text stays readable in the error')
        return true
      },
      'a control-char registration id must be rejected (error message sanitized)',
    )
    // The check is SCOPED to chrome.footer.item: other slots keep their
    // own id semantics (slash ids remain valid — their keys are not
    // parsed as owner/id).
    const legacy = service.register<{ spans: Array<{ text: string }> }>('chrome.footer.status', { id: 'legacy/seg', order: 100 }, { spans: [{ text: 'x' }] })
    await settle()
    legacy.dispose()
    const widget = service.register('input.dock.item', { id: 'dock/item', order: 100 }, { label: [{ text: 'x' }] })
    await settle()
    widget.dispose()
    // An npm-SCOPED plugin (fiber name `@scope/name` contains `/`) must
    // STILL be able to register a chrome.footer.item: its owner is
    // percent-encoded in the canonical key (encodeURIComponent — the
    // INJECTIVE encoding; the old `/`→`~` escape collided with literal
    // `~` owners).
    const scopedFiber = ctx.plugin({ name: '@quota/scope', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as PiTuiExtensionServiceLike
      svc.register<FooterItemContribution>('chrome.footer.item', { id: 'quota', order: 100 }, {
        label: 'scoped quota', segment: { spans: [{ text: 's' }] },
      })
    } })
    await scopedFiber
    const scopedKey = canonicalKey(service, 'chrome.footer.item', 'quota')
    assert.equal(scopedKey, 'ext:%40quota%2Fscope/quota', `the scoped owner must be encoded exactly: ${scopedKey}`)
    assert.ok(!scopedKey.includes('@quota/scope/'), `a raw slash owner must never appear: ${scopedKey}`)
    await (scopedFiber as { dispose(): Promise<void> }).dispose()
    await settle()
    // The encoding is INJECTIVE: a literal `~` owner and a slash owner
    // can never produce the same key (the review's P2 — the old `/`→`~`
    // escape mapped both `@scope/name` and `@scope~name` to the same
    // key). `~` survives the encoding untouched; `/` and `@` are
    // percent-encoded.
    assert.equal(encodeURIComponent('@scope~name'), '%40scope~name', '~ is left as-is by the encoding')
    assert.equal(encodeURIComponent('@scope/name'), '%40scope%2Fname', '/ and @ are percent-encoded')
    assert.notEqual(
      `ext:${encodeURIComponent('@scope~name')}/quota`,
      `ext:${encodeURIComponent('@scope/name')}/quota`,
      'a literal ~ owner must never collide with an encoded slash owner',
    )
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})
