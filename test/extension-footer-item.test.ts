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

/** The canonical config key for one ledger record: ext:<owner>/<id>. */
function canonicalKey(service: PiTuiExtensionServiceLike, slot: string, id: string): string {
  const record = service._ledger().snapshot(slot).records.find(entry => entry.id === id)
  assert.ok(record !== undefined, `record ${id} missing`)
  return `ext:${record.owner}/${record.id}`
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
    await (fiberA as { dispose(): Promise<void> }).dispose()
    await settle()
    assert.ok(!hostFooterIds(app).includes(keyA), `the unloaded owner's key must disappear: ${keyA}`)

    // A DIFFERENT named plugin with the same id: a distinct config key.
    const fiberB = ctx.plugin({ name: 'quota-b', apply(c) {
      const svc = c.get('piTuiExtensions') as unknown as PiTuiExtensionServiceLike
      svc.register<FooterItemContribution>('chrome.footer.item', { id: 'quota' }, {
        label: 'Quota B', segment: { spans: [{ text: 'B' }] },
      })
    } })
    await fiberB
    const keyB = canonicalKey(service, 'chrome.footer.item', 'quota')
    assert.ok(keyB !== keyA, 'the same id under a different NAMED plugin must be a NEW config key')
    assert.ok(hostFooterIds(app).includes(keyB), `owner-b key missing: ${keyB}`)
    await (fiberB as { dispose(): Promise<void> }).dispose()
    await settle()

    // HMR RELOAD of the SAME plugin: the new fiber gets a new uid but the
    // SAME name — the canonical key must be IDENTICAL so a persisted
    // layout referencing ext:<owner>/<id> recovers automatically.
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
    // The layout reference resolves again: a persisted layout pointing at
    // the recovered key renders the reloaded plugin's item.
    app.setFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: keyC }], right: [] }],
    })
    app.setStatus({})
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('A2'), `the recovered item must render:\n${view}`)
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
