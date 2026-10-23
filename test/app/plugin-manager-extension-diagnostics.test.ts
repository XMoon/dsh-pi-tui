/**
 * C4: the Plugin Manager Diagnostics page (extension contribution health,
 * live registry counts, the actual advertised capabilities, and the
 * unassociated-owner group). These tests drive the REAL ledger / registry
 * snapshots where the contract is about authenticity, and the real page for
 * the reachability/copy contract.
 *
 * Evidence levels: the projection/copy cases are headless. The final cases
 * mount the REAL extension service and ledger, a real TuiApp and the
 * production Plugin Manager runtime/page/projection. The official inventory
 * port and the test-provided `runOwned`, `copySelection` and renderer
 * error/recovery sinks stand in for their host wiring; production
 * `attachSeams` is NOT exercised here.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-extension-diagnostics.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Component } from '@xmoon76/pi-tui'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { safeErrorMessage } from '../../src/runtime/process/errors.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { bundle, openWorkspace, plain, type WorkspaceHarness } from '../support/plugin-workspace-harness.ts'
import { mountRealService } from '../support/extension-lifecycle-helpers.ts'
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import {
  PluginManagerWorkspacePanel,
  createPluginManagerWorkspacePanel,
} from '../../src/tui/plugin-manager/workspace.ts'
import { createPluginManagerRuntime } from '../../src/app/surface/plugin-manager-runtime.ts'
import type { SurfaceExtensionService } from '../../src/app/surface/extension-runtime.ts'
import {
  describeTuiExtensionDiagnostics,
  formatTuiContributionDiagnostic,
  formatTuiExtensionCapabilities,
  formatTuiExtensionRegistryCounts,
  serializeTuiExtensionDiagnostics,
  type TuiContributionDiagnostic,
  type TuiExtensionDiagnostics,
  type TuiExtensionObservationSource,
  type TuiExtensionRegistrySource,
} from '../../src/app/plugin-manager/extension-inventory.ts'
import type { PluginManagerPort } from '../../src/runtime/plugin-manager-port.ts'
import type { ExtensionView } from '../../src/extension/public-types.ts'
import type { EditorRegistry } from '../../src/extension/internal/editor-registry.ts'
import type { RendererRegistry } from '../../src/extension/internal/renderer-registry.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function registrySource(counts: Partial<Record<keyof ReturnType<typeof emptyCounts>, number>> = {}): TuiExtensionRegistrySource {
  const n = (value: number | undefined): readonly { readonly id: string }[] =>
    Array.from({ length: value ?? 0 }, (_, index) => ({ id: String(index) }))
  return {
    commands: { snapshot: () => ({ entries: n(counts.commands) }) },
    themes: { snapshot: () => ({ themes: n(counts.themes) }) },
    settings: { snapshot: () => ({ rows: n(counts.settings) }) },
    autocomplete: { snapshot: () => ({ providers: n(counts.autocomplete) }) },
    keybindings: { snapshot: () => ({ bindings: n(counts.keybindings) }) },
    renderers: {
      snapshot: () => ({
        messageRenderers: n(counts.renderers),
        toolRenderers: [],
      }),
    },
    editors: { snapshot: () => ({ editors: n(counts.editors) }) },
  }
}

function emptyCounts(): TuiExtensionDiagnostics['registryCounts'] {
  return { commands: 0, themes: 0, settings: 0, autocomplete: 0, keybindings: 0, renderers: 0, editors: 0 }
}

function failedEntry(overrides: Partial<TuiContributionDiagnostic> = {}): TuiContributionDiagnostic {
  return {
    owner: 'uid:owner-a',
    entryId: 'entry-a',
    extensionPoint: 'transcript.tool.renderer',
    id: 'broken-renderer',
    state: 'failed',
    lastError: 'renderer exploded',
    ...overrides,
  }
}

function diagnosticsView(overrides: Partial<TuiExtensionDiagnostics> = {}): TuiExtensionDiagnostics {
  return {
    entries: [],
    unmappedEntries: [],
    contributionTotals: { total: 0, active: 0, failed: 0, shadowed: 0, other: 0 },
    registryCounts: emptyCounts(),
    capabilities: [],
    healthSummary: 'all active',
    ...overrides,
  }
}

async function openDiagnosticsPage(
  diagnostics: () => TuiExtensionDiagnostics | undefined,
  options: { readonly columns?: number; readonly rows?: number } = {},
): Promise<WorkspaceHarness> {
  const harness = await openWorkspace({
    ...(options.columns === undefined ? {} : { columns: options.columns }),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
    diagnostics,
  })
  harness.vt.sendInput('d')
  await harness.settle()
  return harness
}

function memoryPort(options: {
  readonly snapshotFailure?: string
  readonly installFailure?: string
} = {}): PluginManagerPort {
  return {
    snapshot: async () => {
      if (options.snapshotFailure !== undefined) throw new Error(options.snapshotFailure)
      return {
        bundles: options.installFailure === undefined
          ? []
          : [bundle({
              name: '@deepseek-ai/dsh-subagent-claude-code',
              official: true,
              availability: 'missing',
              installed: false,
              optional: true,
              removable: false,
              source: undefined,
              installTarget: { spec: '@deepseek-ai/dsh-subagent-claude-code@0.0.0', version: '0.0.0' },
            })],
        plugins: [],
        registries: { registry: null, fallbackRegistries: [], resolved: null },
        exemptions: [],
        exemptionWarnings: [],
      }
    },
    inspect: async (spec: string) => ({
      status: 'accepted',
      kind: 'registry',
      name: spec.split('@')[0] ?? spec,
      version: '0.0.0',
      bundle: true,
      registry: null,
    }),
    setBundleEnabled: async () => ({ changed: false }),
    setPluginEnabled: async () => ({ changed: false }),
    removeBundle: async () => ({ changed: false }),
    startInstall: async (request: { readonly spec: string }) => options.installFailure === undefined
      ? { changed: false, application: 'failed', stage: 'install', target: request.spec }
      : {
          changed: false,
          application: 'failed',
          stage: 'install',
          target: request.spec,
          error: { code: 'host-install-failed', diagnostic: options.installFailure },
          failedAt: 'registry',
        },
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  } as unknown as PluginManagerPort
}

test('diagnostics keep associated and unassociated owners apart, sorted by (owner, slot, id)', () => {
  const source: TuiExtensionObservationSource = {
    healthSnapshot: () => [
      { id: 'zeta', owner: 'owner-b', extensionPoint: 'slot.z', state: 'shadowed' },
      { id: 'beta', owner: 'owner-a', extensionPoint: 'slot.a', state: 'active' },
      { id: 'alpha', owner: 'owner-a', extensionPoint: 'slot.a', state: 'failed', lastError: 'boom 鲸' },
      { id: 'gamma', owner: '@vendor/not-an-entry', extensionPoint: 'slot.c', state: 'active' },
      { id: 'aaa', owner: 'owner-b', extensionPoint: 'slot.a', state: 'active' },
    ],
    ownerEntryIds: () => new Map([['owner-a', 'entry-a'], ['owner-b', 'entry-b']]),
  }
  const view = describeTuiExtensionDiagnostics(
    source,
    registrySource({ commands: 1, themes: 2, renderers: 3 }),
    new Set(['slot.input.widget', 'surface.snapshot']),
  )
  // Owner-first sort: an id-first sort would put `aaa` before alpha/beta.
  assert.deepEqual(view.entries.map(entry => entry.id), ['alpha', 'beta', 'aaa', 'zeta'])
  assert.deepEqual(view.entries.map(entry => entry.owner), ['owner-a', 'owner-a', 'owner-b', 'owner-b'])
  assert.deepEqual(view.unmappedEntries.map(entry => entry.id), ['gamma'])
  assert.equal(view.healthSummary, '1 failed · 1 shadowed')
  assert.deepEqual(view.contributionTotals, { total: 5, active: 3, failed: 1, shadowed: 1, other: 0 })
  assert.deepEqual(view.registryCounts, { ...emptyCounts(), commands: 1, themes: 2, renderers: 3 })
  assert.deepEqual(view.capabilities, ['slot.input.widget', 'surface.snapshot'])
  assert.equal(view.entries[0]?.entryId, 'entry-a')
  assert.equal(view.unmappedEntries[0]?.entryId, undefined, 'no entry id is inferred from a package-looking owner')
})

test('diagnostics exact copy carries the full owner/entry/contribution/state/error block', () => {
  const error = `renderer exploded: ${'鲸'.repeat(120)}`
  const view = describeTuiExtensionDiagnostics(
    {
      healthSnapshot: () => [failedEntry({ lastError: error })],
      ownerEntryIds: () => new Map([['uid:owner-a', 'entry-a']]),
    },
    registrySource({ commands: 1 }),
    new Set(['surface.snapshot']),
  )
  assert.equal(
    formatTuiContributionDiagnostic(view.entries[0]!),
    `Owner: uid:owner-a\nEntry: entry-a\nContribution: transcript.tool.renderer:broken-renderer\nState: failed\nError: ${error}`,
  )
  assert.equal(
    serializeTuiExtensionDiagnostics(view),
    [
      'dsh-pi-tui Plugin Diagnostics',
      'Health: 1 failed · 0 shadowed',
      `Registries: ${formatTuiExtensionRegistryCounts({ ...emptyCounts(), commands: 1 })}`,
      'Capabilities: surface.snapshot',
      '',
      'Owner: uid:owner-a',
      'Entry: entry-a',
      'Contribution: transcript.tool.renderer:broken-renderer',
      'State: failed',
      `Error: ${error}`,
    ].join('\n'),
  )
})

test('diagnostics recovery clears lastError and the health summary', () => {
  let records = [failedEntry()]
  const source: TuiExtensionObservationSource = {
    healthSnapshot: () => records,
    ownerEntryIds: () => new Map([['uid:owner-a', 'entry-a']]),
  }
  const failed = describeTuiExtensionDiagnostics(source, registrySource(), new Set())
  assert.equal(failed.healthSummary, '1 failed · 0 shadowed')
  assert.equal(failed.entries[0]?.lastError, 'renderer exploded')
  records = [failedEntry({ state: 'active', lastError: undefined })]
  const recovered = describeTuiExtensionDiagnostics(source, registrySource(), new Set())
  assert.equal(recovered.healthSummary, 'all active')
  assert.equal(recovered.entries[0]?.lastError, undefined)
  assert.doesNotMatch(serializeTuiExtensionDiagnostics(recovered), /Error:/)
})

test('registry counts and capabilities stay separate facts (an empty registry is not a capability)', () => {
  const view = describeTuiExtensionDiagnostics(
    { healthSnapshot: () => [] },
    registrySource({ renderers: 2 }),
    new Set(),
  )
  assert.equal(view.registryCounts.renderers, 2)
  assert.deepEqual(view.capabilities, [])
  assert.equal(formatTuiExtensionCapabilities(view.capabilities), 'none')
  assert.match(serializeTuiExtensionDiagnostics(view), /Registries: .* ren 2/)
})

test('the diagnostics page paints the grouped facts and every state/error without truncation', async () => {
  const longError = `renderer callback failed: ${'长'.repeat(80)}`
  const entry = failedEntry({ lastError: longError })
  const view = diagnosticsView({
    entries: [entry],
    contributionTotals: { total: 1, active: 0, failed: 1, shadowed: 0, other: 0 },
    healthSummary: '1 failed',
    registryCounts: { ...emptyCounts(), commands: 3, renderers: 2 },
    capabilities: ['surface.snapshot', 'slot.input.widget'],
  })
  const harness = await openDiagnosticsPage(() => view)
  try {
    assert.equal(harness.panel.currentView(), 'diagnostics')
    const frame = harness.view()
    assert.match(frame, /Plugins · Diagnostics/)
    assert.match(frame, /1 contributions · 1 failed · 0 shadowed/)
    assert.match(frame, /Health\s+1 failed/)
    assert.match(frame, /Registries\s+cmd 3 · theme 0 · .* ren 2/)
    assert.match(frame, /Capabilities\s+surface\.snapshot · slot\.input\.widget/)
    assert.match(frame, /Owner: uid:owner-a \(entry: entry-a\)/)
    assert.match(frame, /transcript\.tool\.renderer:broken-renderer\s+\[failed\]/)
    // The error is WRAPPED across rows; no `…` may replace any of its content.
    assert.match(frame, /renderer callback failed/)
    assert.ok(frame.includes('长'), 'the CJK error text is painted')
    assert.doesNotMatch(frame, /…/)
    assert.match(frame, /Copy All \[C\]/)
    assert.match(frame, /Back/)
  } finally {
    harness.close()
    harness.app.dispose()
  }
})

test('c copies the selected fact, C copies all, and r rereads without touching the package inventory', async () => {
  const entry = failedEntry({ lastError: '第一段错误\n第二段错误' })
  const first = diagnosticsView({
    entries: [entry],
    contributionTotals: { total: 1, active: 0, failed: 1, shadowed: 0, other: 0 },
    healthSummary: '1 failed',
  })
  const recovered = diagnosticsView({
    entries: [failedEntry({ state: 'active', lastError: undefined })],
    contributionTotals: { total: 1, active: 1, failed: 0, shadowed: 0, other: 0 },
    healthSummary: 'all active',
  })
  let current = first
  let reads = 0
  const harness = await openDiagnosticsPage(() => {
    reads += 1
    return current
  })
  try {
    const snapshotCalls = harness.snapshotCalls()
    // Health -> Registries -> Capabilities -> the first contribution.
    for (let step = 0; step < 3; step += 1) {
      harness.vt.sendInput('\x1b[B')
      await harness.settle()
    }
    harness.vt.sendInput('c')
    await harness.settle()
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(entry))

    harness.vt.sendInput('C')
    await harness.settle()
    assert.equal(harness.copied.at(-1), serializeTuiExtensionDiagnostics(first))

    current = recovered
    const readsBefore = reads
    harness.vt.sendInput('r')
    await harness.settle()
    assert.equal(reads, readsBefore + 1, 'r rereads the diagnostics projection exactly once')
    assert.equal(harness.snapshotCalls(), snapshotCalls, 'r never refreshes the official package inventory')
    assert.match(harness.view(), /all active/)
    assert.doesNotMatch(harness.view(), /第一段错误/)

    harness.vt.sendInput('\x1b')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'list')
  } finally {
    harness.close()
    harness.app.dispose()
  }
})

test('the diagnostics page paints the unassociated group and copies a shadowed record', async () => {
  const orphan: TuiContributionDiagnostic = {
    owner: 'uid:unmapped',
    extensionPoint: 'slot.input.widget',
    id: 'orphan',
    state: 'shadowed',
    lastError: 'conflict 鲸',
  }
  const view = diagnosticsView({
    unmappedEntries: [orphan],
    contributionTotals: { total: 1, active: 0, failed: 0, shadowed: 1, other: 0 },
    healthSummary: '0 failed · 1 shadowed',
  })
  const harness = await openDiagnosticsPage(() => view)
  try {
    const frame = harness.view()
    assert.match(frame, /Unassociated extension contributions/)
    assert.match(frame, /Owner: uid:unmapped/)
    assert.match(frame, /slot\.input\.widget:orphan\s+\[shadowed\]/)
    assert.match(frame, /conflict 鲸/)
    // Health -> Registries -> Capabilities -> the unassociated record.
    for (let step = 0; step < 3; step += 1) {
      harness.vt.sendInput('\x1b[B')
      await harness.settle()
    }
    harness.vt.sendInput('c')
    await harness.settle()
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(orphan))
  } finally {
    harness.close()
    harness.app.dispose()
  }
})

test('an absent extension service paints Unavailable and copies nothing', async () => {
  const harness = await openWorkspace({ diagnostics: () => undefined })
  try {
    harness.vt.sendInput('d')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'diagnostics')
    assert.match(harness.view(), /Extension diagnostics unavailable/)
    assert.match(harness.view(), /r reread/)
    assert.match(harness.view(), /Esc back/)
    assert.doesNotMatch(harness.view(), /c copy/)
    assert.doesNotMatch(harness.view(), /C copy all/)
    assert.doesNotMatch(harness.view(), /Up\/Down/)
    harness.vt.sendInput('c')
    harness.vt.sendInput('C')
    await harness.settle()
    assert.deepEqual(harness.copied, [])
    harness.vt.sendInput('\x1b')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'list')
  } finally {
    harness.close()
    harness.app.dispose()
  }
})

test('both Plugin Manager entries share the same controller and reach the same Diagnostics page', () => {
  const panels: { panel: PluginManagerWorkspacePanel; controller: PluginManagerController; diagnostics: () => TuiExtensionDiagnostics | undefined }[] = []
  let service: SurfaceExtensionService | undefined
  const fakeService = {
    _ledger: () => ({
      healthSnapshot: () => [failedEntry({ lastError: 'boom' })],
    }),
    _ownerEntryIds: () => new Map([['uid:owner-a', 'entry-a']]),
    commands: { snapshot: () => ({ entries: [{}] }) },
    themes: { snapshot: () => ({ themes: [] }) },
    settings: { snapshot: () => ({ rows: [] }) },
    autocomplete: { snapshot: () => ({ providers: [] }) },
    keybindings: { snapshot: () => ({ bindings: [] }) },
    renderers: { snapshot: () => ({ messageRenderers: [], toolRenderers: [] }) },
    editors: { snapshot: () => ({ editors: [] }) },
    api: () => ({ apiVersion: 2, hostVersion: 'test', capabilities: new Set(['surface.snapshot']), deprecations: new Map() }),
  } as unknown as SurfaceExtensionService
  const hosted: Component[] = []
  const mounted = {
    workspaceRows: () => 40,
    workspaceColumns: () => 120,
    requestRender: () => {},
    workspaceNotice: () => undefined,
    copyWorkspaceText: () => {},
    notify: () => {},
    openPluginManagerWorkspace: (panel: Component) => {
      hosted.push(panel)
      return () => {}
    },
  } as unknown as TuiApp
  const runtime = createPluginManagerRuntime({
    mounted: () => mounted,
    service: () => service,
    createPanel: (controller, deps) => {
      const panel = new PluginManagerWorkspacePanel(controller, {
        rows: deps.rows,
        columns: deps.columns,
        requestRender: deps.requestRender,
        notice: deps.notice,
        onCopy: deps.onCopy,
        diagnostics: deps.diagnostics,
      }, { onDispose: deps.onDispose })
      panels.push({ panel, controller, diagnostics: deps.diagnostics })
      return panel
    },
  })
  const owner = runtime.attach({ port: memoryPort(), diag: createDiag({ filePath: undefined, stderrLevel: 'off' }) })
  try {
    owner.open()
    const first = panels[0]!
    assert.equal(first.diagnostics(), undefined, 'no attached service means the page states Unavailable')
    first.panel.render(120)
    first.panel.handleInput('d')
    assert.equal(first.panel.currentView(), 'diagnostics')
    first.panel.render(120)

    service = fakeService
    const secondComponent = owner.page(() => {})
    assert.ok(secondComponent !== undefined)
    const second = panels[1]!.panel
    assert.equal(panels[1]!.controller, first.controller, 'both entries own exactly ONE controller')
    second.render(120)
    second.handleInput('d')
    assert.equal(second.currentView(), 'diagnostics')
    const diagnostics = panels[1]!.diagnostics()
    assert.ok(diagnostics !== undefined)
    assert.equal(diagnostics.healthSummary, '1 failed · 0 shadowed')
    assert.equal(diagnostics.registryCounts.commands, 1)
    assert.deepEqual(diagnostics.capabilities, ['surface.snapshot'])
  } finally {
    runtime.dispose()
  }
})

interface RealLedgerService {
  registerToolRenderer(contribution: { id: string; toolName: string; render: () => ExtensionView }): unknown
  renderers: RendererRegistry
  editors: EditorRegistry
  _ledger(): {
    healthSnapshot(): readonly { id: string; owner: string; extensionPoint: string; state: string; lastError?: string }[]
    recordError(slot: string, id: string, owner: string, message: string): void
    clearError(slot: string, id: string, owner: string): void
  }
  api(): { capabilities: ReadonlySet<string> }
  _ownerEntryIds(): ReadonlyMap<string, string>
  commands: TuiExtensionRegistrySource['commands']
  themes: TuiExtensionRegistrySource['themes']
  settings: TuiExtensionRegistrySource['settings']
  autocomplete: TuiExtensionRegistrySource['autocomplete']
  keybindings: TuiExtensionRegistrySource['keybindings']
}

async function settlePage(vt: VirtualTerminal, rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  await vt.waitForRender()
}

function expectedDiagnostics(service: RealLedgerService): TuiExtensionDiagnostics {
  return describeTuiExtensionDiagnostics(
    {
      healthSnapshot: () => service._ledger().healthSnapshot(),
      ownerEntryIds: () => service._ownerEntryIds(),
    },
    {
      commands: service.commands,
      themes: service.themes,
      settings: service.settings,
      autocomplete: service.autocomplete,
      keybindings: service.keybindings,
      renderers: service.renderers,
      editors: service.editors,
    },
    service.api().capabilities,
  )
}

interface ProductionPage {
  readonly service: RealLedgerService
  readonly app: TuiApp
  readonly vt: VirtualTerminal
  readonly panel: PluginManagerWorkspacePanel
  readonly copied: readonly string[]
  dispose(): Promise<void>
}

/**
 * Mount the REAL service + a real TuiApp + the production Plugin Manager
 * runtime/page. The only fixture is the official inventory port; the
 * diagnostics read therefore goes through `createPluginManagerRuntime`'s
 * `panelDeps.diagnostics` closure, exactly as production does.
 */
async function mountProductionPage(options: {
  readonly prepare?: (service: RealLedgerService) => void
  readonly configure?: (app: TuiApp, service: RealLedgerService) => void
  readonly snapshotFailure?: string
  readonly installFailure?: string
} = {}): Promise<ProductionPage> {
  const { service: mountedService, dispose: disposeService } = await mountRealService()
  const service = mountedService as unknown as RealLedgerService
  options.prepare?.(service)
  const copied: string[] = []
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The production clipboard route requires the owned-task entry; the copy
    // policy itself is the real `copySelection` capability below.
    runOwned: (_label, task, resultOptions) => {
      void Promise.resolve()
        .then(() => task())
        .then(result => resultOptions.onResult?.(result), error => resultOptions.onError?.(error))
    },
  }, {
    renderers: service.renderers,
    editorRegistry: service.editors,
    copySelection: async (text) => { copied.push(text); return true },
  })
  startedApps.add(app)
  options.configure?.(app, service)
  app.start()
  await settlePage(vt)
  const panels: PluginManagerWorkspacePanel[] = []
  const runtime = createPluginManagerRuntime({
    mounted: () => app,
    service: () => service as unknown as SurfaceExtensionService,
    createPanel: (controller, deps) => {
      const panel = createPluginManagerWorkspacePanel(controller, deps)
      panels.push(panel)
      return panel
    },
  })
  const owner = runtime.attach({
    port: memoryPort({
      ...(options.snapshotFailure === undefined ? {} : { snapshotFailure: options.snapshotFailure }),
      ...(options.installFailure === undefined ? {} : { installFailure: options.installFailure }),
    }),
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  owner.open()
  await settlePage(vt)
  const panel = panels[0]
  assert.ok(panel !== undefined, 'the production runtime must build the Plugin Manager page')
  return {
    service,
    app,
    vt,
    panel,
    copied,
    async dispose() {
      runtime.dispose()
      startedApps.delete(app)
      if (!app.isDisposed()) app.dispose()
      await disposeService()
    },
  }
}

test('a failing Host inventory does not contaminate the real extension diagnostics', async () => {
  // Negative control for RFL-003: a Host inventory failure paints Stale/error
  // on the list, but the extension diagnostics read is a separate truth
  // source and must stay freshly healthy without that Host status.
  const page = await mountProductionPage({ snapshotFailure: 'Host inventory failed: 包' })
  try {
    const list = plain(page.vt.getViewport())
    assert.match(list, /Stale/)
    assert.match(list, /Host inventory failed/)
    page.vt.sendInput('d')
    await settlePage(page.vt)
    assert.equal(page.panel.currentView(), 'diagnostics')
    const frame = plain(page.vt.getViewport())
    const expected = expectedDiagnostics(page.service)
    assert.equal(expected.healthSummary, 'all active')
    assert.equal(expected.contributionTotals.failed, 0)
    assert.equal(expected.contributionTotals.shadowed, 0)
    assert.match(frame, /Health\s+/)
    assert.ok(frame.includes(expected.healthSummary), `the diagnostics health is ${expected.healthSummary}:\n${frame}`)
    assert.doesNotMatch(frame, /Stale/)
    assert.doesNotMatch(frame, /Host inventory failed/)
    assert.doesNotMatch(frame, /\[failed\]|\[shadowed\]/)
  } finally {
    await page.dispose()
  }
})

test('a Host package install failure stays out of the real extension diagnostics', async () => {
  // Negative control for RFL-002: the real production page/ledger stays
  // healthy through a settled Host install failure; the Host failure is only
  // visible in the Install page.
  const page = await mountProductionPage({ installFailure: 'Host package install failed: 包' })
  try {
    const { vt, panel } = page
    vt.sendInput('\x1b[F')
    await settlePage(vt)
    vt.sendInput('\r')
    await settlePage(vt)
    vt.sendInput('\r')
    await settlePage(vt)
    vt.sendInput('\r')
    await settlePage(vt)
    vt.sendInput('\r')
    await settlePage(vt)
    assert.equal(panel.currentView(), 'install')
    const installFrame = plain(vt.getViewport())
    assert.match(installFrame, /install failed/)
    assert.match(installFrame, /Host package install failed/)
    vt.sendInput('\x1b')
    await settlePage(vt)
    vt.sendInput('d')
    await settlePage(vt)
    assert.equal(panel.currentView(), 'diagnostics')
    const frame = plain(vt.getViewport())
    const expected = expectedDiagnostics(page.service)
    assert.equal(expected.healthSummary, 'all active')
    assert.equal(expected.contributionTotals.failed, 0)
    assert.equal(expected.contributionTotals.shadowed, 0)
    assert.ok(frame.includes(expected.healthSummary), `the diagnostics health is ${expected.healthSummary}:\n${frame}`)
    assert.doesNotMatch(frame, /Host package install failed/)
    assert.doesNotMatch(frame, /Stale/)
    assert.doesNotMatch(frame, /\[failed\]|\[shadowed\]/)
  } finally {
    await page.dispose()
  }
})

test('a real renderer failure reaches the Plugin Manager diagnostics and recovers', async () => {
  // Evidence level: real SurfaceExtensionService/ledger + real TuiApp + the
  // production createPluginManagerRuntime/page/projection path. The official
  // inventory port, `runOwned`, `copySelection` and the renderer error/
  // recovery sinks stand in for host wiring; production `attachSeams` is not
  // exercised here.
  const message = `renderer failed: ${'鲸'.repeat(40)}`
  let broken = true
  const page = await mountProductionPage({
    prepare: (service) => {
      service.registerToolRenderer({
        id: 'c4-broken-renderer',
        toolName: 'bash',
        render: () => {
          if (broken) throw new Error(message)
          return { kind: 'text', spans: [{ text: 'recovered' }] }
        },
      })
    },
    configure: (app, service) => {
      app.setRendererErrorSink(({ id, error, slot, owner }) => {
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        service._ledger().recordError(healthSlot, id, owner, safeErrorMessage(error).replace(/\s+/g, ' ').slice(0, 200))
      })
      app.setRendererRecoveredSink(({ id, slot, owner }) => {
        const healthSlot = slot === 'tool' ? 'transcript.tool.renderer' : 'transcript.message.renderer'
        service._ledger().clearError(healthSlot, id, owner)
      })
    },
  })
  try {
    const { app, vt, panel, service, copied } = page
    const tool = { kind: 'tool' as const, turn: 0, name: 'bash', args: '{}', result: 'out', status: 'ok' as const }
    const failed = app.messageCacheEntryForTest?.(tool, 0)
    assert.equal(failed?.rendererId, undefined, 'a throwing renderer abdicates to the host card')
    const health = service._ledger().healthSnapshot().find(record => record.id === 'c4-broken-renderer')
    assert.equal(health?.state, 'failed')
    assert.equal(health?.lastError, message.slice(0, 200))

    vt.sendInput('d')
    await settlePage(vt)
    assert.equal(panel.currentView(), 'diagnostics')
    const expected = expectedDiagnostics(service)
    const contribution = [...expected.entries, ...expected.unmappedEntries]
      .find(entry => entry.id === 'c4-broken-renderer')
    assert.ok(contribution !== undefined)
    assert.equal(contribution.lastError, message.slice(0, 200))
    const frame = plain(vt.getViewport())
    assert.match(frame, /c4-broken-renderer/)
    assert.match(frame, /\[failed\]/)
    assert.match(frame, /renderer failed: 鲸/)

    vt.sendInput('C')
    await settlePage(vt)
    assert.equal(copied.at(-1), serializeTuiExtensionDiagnostics(expected), 'Copy All uses the production projection')

    const facts = [...expected.entries, ...expected.unmappedEntries]
    const down = 3 + facts.findIndex(entry => entry.id === 'c4-broken-renderer')
    for (let step = 0; step < down; step += 1) vt.sendInput('\x1b[B')
    await settlePage(vt)
    vt.sendInput('c')
    await settlePage(vt)
    assert.equal(copied.at(-1), formatTuiContributionDiagnostic(contribution), 'per-fact copy uses the production projection')

    broken = false
    const recovered = app.messageCacheEntryForTest?.({ ...tool, turn: 1 }, 0)
    assert.equal(recovered?.rendererId, 'c4-broken-renderer', 'the recovered renderer claims the new card')
    assert.equal(service._ledger().healthSnapshot().find(record => record.id === 'c4-broken-renderer')?.state, 'active')
    app.requestRender()
    await settlePage(vt)
    const recoveredExpected = expectedDiagnostics(service)
    const recoveredFrame = plain(vt.getViewport())
    assert.ok(
      recoveredFrame.includes(recoveredExpected.healthSummary),
      `the recovered diagnostics health is ${recoveredExpected.healthSummary}:\n${recoveredFrame}`,
    )
    assert.doesNotMatch(recoveredFrame, /renderer failed:/)
    vt.sendInput('C')
    await settlePage(vt)
    assert.equal(copied.at(-1), serializeTuiExtensionDiagnostics(recoveredExpected), 'Copy All reflects recovery')
  } finally {
    await page.dispose()
  }
})
