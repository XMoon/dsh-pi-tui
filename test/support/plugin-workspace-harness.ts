/**
 * Shared real-TuiApp harness for the EMBEDDED Plugin Manager page (PR2 L6):
 * a REAL Settings workspace lease (the ONE alt screen), the production
 * controller and the production page over a fixture semantic port. The page is
 * created by the real `Settings → Plugins` composition path (the Settings root
 * factory), so every suite drives the actual root layout, focus transition,
 * mouse translation and local viewport grant — never a second TuiApp or a
 * hand-built screen owner.
 * @module @xmoon76/dsh-pi-tui/test/support/plugin-workspace-harness
 */

import assert from 'node:assert/strict'
import { TuiApp } from '../../src/tui-app.ts'
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { SELF_BUNDLE } from '../../src/app/plugin-manager/classify.ts'
import type {
  TuiExtensionDiagnostics,
  TuiExtensionObservation,
} from '../../src/app/plugin-manager/extension-inventory.ts'
import type {
  PluginBundleFact,
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginRowFact,
  PluginSpecInspectionFact,
} from '../../src/runtime/plugin-manager-port.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

export function plain(lines: readonly string[]): string {
  return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

export function bundle(overrides: Partial<PluginBundleFact> = {}): PluginBundleFact {
  return {
    name: 'ordinary',
    official: false,
    availability: 'profile',
    source: 'file:/tmp/ordinary',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
    ...overrides,
  }
}

export function row(overrides: Partial<PluginRowFact> = {}): PluginRowFact {
  return {
    entryId: 'e1',
    moduleName: 'm1',
    enabled: true,
    fiberPhase: 'active',
    ...overrides,
  }
}

export const EXPERIMENTAL_NAMES = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
] as const

export interface WorkspaceHarnessOptions {
  readonly columns?: number
  readonly rows?: number
  readonly bundles?: readonly PluginBundleFact[]
  readonly plugins?: readonly PluginRowFact[]
  readonly observations?: readonly TuiExtensionObservation[]
  /** The diagnostics read the page consumes (default: no extension service). */
  readonly diagnostics?: () => TuiExtensionDiagnostics | undefined
  /** The exact-version exemption reader warnings the fixture reports. */
  readonly exemptionWarnings?: readonly string[]
  /** Replaces the fixture install behavior when provided. */
  readonly installImpl?: (request: { requestId: string; spec: string; approvedBuilds?: readonly string[] }) => Promise<PluginChangeFact>
  readonly waitImpl?: (requestId: string) => Promise<PluginChangeFact | null>
  readonly cancelImpl?: (requestId: string) => Promise<{ status: 'cancelled' | 'too-late' | 'not-running' }>
  readonly inspectImpl?: (spec: string) => Promise<PluginSpecInspectionFact>
  /** A REAL Host-backed port (an L6 source->sink test supplies it); the
   *  default fake catalog below is never used in that case. */
  readonly port?: PluginManagerPort
  /** Where the Settings lease opens. `'rail'` starts on the About home with the
   *  keyboard on the Categories rail, so the Plugins category is only SELECTED
   *  and the plugin page is not mounted until the content takes the focus. */
  readonly startOn?: 'plugins' | 'rail'
}

export interface WorkspaceHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  /** The live Settings workspace handle (the ONE screen lease). */
  readonly settings: { close(): void }
  readonly controller: PluginManagerController
  /** The mounted page; throws when the lazy policy has not mounted it yet. */
  readonly panel: PluginManagerWorkspacePanel
  /** The page instance, or `undefined` while the lazy policy keeps it unmounted. */
  readonly panelInstance: () => PluginManagerWorkspacePanel | undefined
  readonly copied: string[]
  /** How many official inventory snapshots the controller requested. */
  readonly snapshotCalls: () => number
  readonly installCalls: Array<{ requestId: string; spec: string; approvedBuilds?: readonly string[] }>
  readonly setBundle: Array<{ name: string; enabled: boolean }>
  readonly setPlugin: Array<{ entryId: string; enabled: boolean }>
  readonly removeBundle: string[]
  /** Every Host `cancelInstall` call (empty proves no cancel was dispatched). */
  readonly cancelInstallCalls: string[]
  readonly invalidate: () => void
  readonly emit: (event: PluginInstallEvent) => void
  close(): void
  /** Re-open a Settings lease on the SAME app. The previous owner must have
   *  been released; a phantom claim makes the production factory return
   *  `undefined` and this throws instead of faking a success. */
  reopen(options?: { readonly startOn?: 'plugins' | 'rail' }): Promise<void>
  /** Drain a bounded number of microtask turns, then let the renderer settle via
   *  `VirtualTerminal.waitForRender()` (which itself yields a short timer before
   *  flushing the terminal write). This is NOT a frame-identity signal — it is a
   *  bounded wait for the render pipeline to settle after a redraw was already
   *  requested; use it only after driving such a request.
   *  (Named `waitForFrame`, not `settle`: a same-named fixed-wait helper in
   *  `test/support` would make the New Test Policy guard read every call as a
   *  blind sleep.) */
  waitForFrame(rounds?: number): Promise<void>
  view(): string
  viewport(): readonly string[]
}

export async function openWorkspace(options: WorkspaceHarnessOptions = {}): Promise<WorkspaceHarness> {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const bundles = options.bundles ?? [
    bundle({ name: SELF_BUNDLE, source: 'file:/tmp/tui', rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'e-tui' }] }),
    bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', source: undefined }),
    bundle({ name: '@vendor/foo', source: 'https://user:secret@example.com/foo.git', enabled: false }),
    ...EXPERIMENTAL_NAMES.map(name => bundle({
      name,
      official: true,
      availability: 'missing',
      installed: false,
      optional: true,
      removable: false,
      source: undefined,
      installTarget: { spec: `${name}@0.2.1-rc.2`, version: '0.2.1-rc.2' },
    })),
  ]
  const plugins = options.plugins ?? [
    row({ entryId: 'e-tui', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
    row({ entryId: 'e-free', moduleName: 'free-extension', patchId: 'free' }),
  ]
  const snapshot: PluginManagerSnapshot = {
    bundles,
    plugins,
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: options.exemptionWarnings ?? [],
  }
  const installListeners = new Set<(event: PluginInstallEvent) => void>()
  const invalidateListeners = new Set<() => void>()
  const installCalls: Array<{ requestId: string; spec: string; approvedBuilds?: readonly string[] }> = []
  let snapshotCalls = 0
  const setBundle: Array<{ name: string; enabled: boolean }> = []
  const setPlugin: Array<{ entryId: string; enabled: boolean }> = []
  const removeBundle: string[] = []
  /** Host `cancelInstall` calls (a WRITE-side operation on the port). */
  const cancelCalls: string[] = []
  const fixturePort: PluginManagerPort = {
    snapshot: async () => { snapshotCalls += 1; return snapshot },
    inspect: options.inspectImpl ?? (async (spec: string) => ({
      status: 'accepted',
      kind: 'registry',
      name: spec.split('@')[0] ?? spec,
      version: '0.2.1-rc.2',
      bundle: true,
      registry: null,
    })),
    setBundleEnabled: async (name, enabled) => {
      setBundle.push({ name, enabled })
      return { changed: true, application: 'applied', stage: 'enable', target: name }
    },
    setPluginEnabled: async (entryId, enabled) => {
      setPlugin.push({ entryId: String(entryId), enabled })
      return { changed: true, application: 'applied', stage: 'enable', target: String(entryId) }
    },
    removeBundle: async (name) => {
      removeBundle.push(name)
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    startInstall: async (request) => {
      installCalls.push(request)
      if (options.installImpl !== undefined) return options.installImpl(request)
      return { changed: true, application: 'applied', stage: 'install', target: request.spec, version: '0.2.1-rc.2' }
    },
    waitForInstall: async (requestId) => options.waitImpl === undefined ? null : options.waitImpl(requestId),
    cancelInstall: async (requestId) => {
      cancelCalls.push(String(requestId))
      return options.cancelImpl === undefined
        ? { status: 'not-running' }
        : options.cancelImpl(requestId)
    },
    subscribeInstall: (listener) => { installListeners.add(listener); return () => installListeners.delete(listener) },
    subscribeInvalidation: (listener) => { invalidateListeners.add(listener); return () => invalidateListeners.delete(listener) },
  }
  const port = options.port ?? fixturePort
  const copied: string[] = []
  const controller = new PluginManagerController(port, {
    requestRender: () => app.requestRender(),
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => options.observations ?? [] })
  // The page is created by the REAL Settings → Plugins factory on the first
  // visible paint of the plugin content column; the harness never builds a
  // second screen or a second owner.
  let panel: PluginManagerWorkspacePanel | undefined
  let settings: { close(): void } | undefined
  /** Open ONE Settings lease on this app. The page factory is the SAME one the
   *  first lease used, so a re-open exercises the production owner release. */
  const openLease = (startOn: 'plugins' | 'rail'): { close(): void } => app.openSettingsWorkspace(
    {
      readSnapshot: () => ({
        configReadiness: 'ready',
        rows: [],
        capturedAt: Date.now(),
      }),
    },
    {
      aboutVersionFacts: { tui: 'test-bundle', dsh: undefined },
      onClose: () => {},
      initialCategory: startOn === 'rail' ? 'about' : 'plugins',
      onOpenPlugins: (onYieldNavigation) => {
        panel = new PluginManagerWorkspacePanel(controller, {
          requestRender: () => app.requestRender(),
          onCopy: (text) => { copied.push(text) },
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
          onYieldNavigation,
        }, { onDispose: () => {} })
        // PRODUCTION SEMANTICS: `PluginManagerRuntime.page()` opens the
        // controller on EVERY successful page creation, so a re-mount after a
        // dispose starts a NEW inventory read (and advances the read
        // generation). The harness must not smooth that over with a "first
        // mount only" flag, or a reopen would prove a path production never
        // takes.
        controller.open()
        return panel
      },
    },
  )
  settings = openLease(options.startOn === 'rail' ? 'rail' : 'plugins')

  const waitForFrame = async (rounds = 8): Promise<void> => {
    for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
    await vt.waitForRender()
  }
  await waitForFrame()
  if (options.startOn !== 'rail') {
    assert.ok(panel !== undefined, 'the Settings root must mount the Plugin page on its first visible paint')
  } else {
    assert.equal(panel, undefined, 'a narrow rail that merely selects Plugins mounts nothing')
  }
  return {
    vt,
    app,
    get settings(): { close(): void } {
      assert.ok(settings !== undefined, 'no Settings lease is open')
      return settings
    },
    controller,
    get panel(): PluginManagerWorkspacePanel {
      assert.ok(panel !== undefined, 'the Plugin page is not mounted in this scenario')
      return panel
    },
    panelInstance: () => panel,
    copied,
    snapshotCalls: () => snapshotCalls,
    installCalls,
    setBundle,
    setPlugin,
    removeBundle,
    cancelInstallCalls: cancelCalls,
    invalidate: () => { for (const listener of [...invalidateListeners]) listener() },
    emit: event => { for (const listener of [...installListeners]) listener(event) },
    close: () => settings!.close(),
    reopen: async (reopenOptions = {}) => {
      settings = openLease(reopenOptions.startOn === 'rail' ? 'rail' : 'plugins')
      await waitForFrame()
    },
    waitForFrame,
    view: () => plain(vt.getViewport()),
    viewport: () => vt.getViewport(),
  }
}
