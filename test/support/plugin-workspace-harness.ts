/**
 * Shared real-TuiApp harness for the fullscreen Plugin Manager workspace
 * (S4-D1 L6): a REAL TuiAltScreen lease, the production controller and the
 * workspace panel over a fixture semantic port.
 * @module @xmoon76/dsh-pi-tui/test/support/plugin-workspace-harness
 */

import { TuiApp } from '../../src/tui-app.ts'
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { SELF_BUNDLE } from '../../src/app/plugin-manager/classify.ts'
import type { TuiExtensionObservation } from '../../src/app/plugin-manager/extension-inventory.ts'
import type {
  PluginBundleFact,
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginRowFact,
  PluginSpecInspectionFact,
} from '../../src/runtime/plugin-manager-port.ts'
import { VirtualTerminal } from '../virtual-terminal.ts'

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
  /** Replaces the fixture install behavior when provided. */
  readonly installImpl?: (request: { requestId: string; spec: string; approvedBuilds?: readonly string[] }) => Promise<PluginChangeFact>
  readonly waitImpl?: (requestId: string) => Promise<PluginChangeFact | null>
  readonly cancelImpl?: (requestId: string) => Promise<{ status: 'cancelled' | 'too-late' | 'not-running' }>
  readonly inspectImpl?: (spec: string) => Promise<PluginSpecInspectionFact>
  /** The entry host the controller reports (Esc wording only). */
  readonly entryHost?: 'direct-command' | 'settings-entry'
}

export interface WorkspaceHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly controller: PluginManagerController
  readonly panel: PluginManagerWorkspacePanel
  readonly copied: string[]
  readonly installCalls: Array<{ requestId: string; spec: string; approvedBuilds?: readonly string[] }>
  readonly setBundle: Array<{ name: string; enabled: boolean }>
  readonly removeBundle: string[]
  readonly invalidate: () => void
  readonly emit: (event: PluginInstallEvent) => void
  close(): void
  settle(rounds?: number): Promise<void>
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
    exemptionWarnings: [],
  }
  const installListeners = new Set<(event: PluginInstallEvent) => void>()
  const invalidateListeners = new Set<() => void>()
  const installCalls: Array<{ requestId: string; spec: string; approvedBuilds?: readonly string[] }> = []
  const setBundle: Array<{ name: string; enabled: boolean }> = []
  const removeBundle: string[] = []
  const port: PluginManagerPort = {
    snapshot: async () => snapshot,
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
    setPluginEnabled: async () => ({ changed: true, application: 'applied', stage: 'enable', target: 'row' }),
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
    cancelInstall: async (requestId) => options.cancelImpl === undefined
      ? { status: 'not-running' }
      : options.cancelImpl(requestId),
    subscribeInstall: (listener) => { installListeners.add(listener); return () => installListeners.delete(listener) },
    subscribeInvalidation: (listener) => { invalidateListeners.add(listener); return () => invalidateListeners.delete(listener) },
  }
  let closeSurface: () => void = () => {}
  const copied: string[] = []
  const controller = new PluginManagerController(port, {
    requestRender: () => app.requestRender(),
    requestClose: () => closeSurface(),
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => options.observations ?? [] })
  const panel = new PluginManagerWorkspacePanel(controller, {
    rows: () => vt.rows,
    columns: () => vt.columns,
    requestRender: () => app.requestRender(),
    notice: () => undefined,
    onCopy: (text) => { copied.push(text) },
  }, { onDispose: () => {} })
  closeSurface = app.openPluginManagerWorkspace(panel, () => {})
  controller.open(options.entryHost ?? 'direct-command')

  const settle = async (rounds = 8): Promise<void> => {
    for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
    await vt.waitForRender()
  }
  await settle()
  return {
    vt,
    app,
    controller,
    panel,
    copied,
    installCalls,
    setBundle,
    removeBundle,
    invalidate: () => { for (const listener of [...invalidateListeners]) listener() },
    emit: event => { for (const listener of [...installListeners]) listener(event) },
    close: () => closeSurface(),
    settle,
    view: () => plain(vt.getViewport()),
    viewport: () => vt.getViewport(),
  }
}
