/**
 * The command-surface facade's Session-runtime hooks.
 *
 * `TuiCommandRunner` declares the create-boundary AUTO Workspace re-proof as
 * `validateAutoWorkspace`, and the sessionless `/new` handler consults it right
 * before the create. The session runtime is the only holder of that local
 * evidence, so `createCommandSurface` must FORWARD the hook into the runner
 * facade. Regression: the member was declared in the deps shape but never
 * mapped, so the handler always saw `undefined` and refused every Remote
 * sessionless `/new` whose Workspace had just been auto-confirmed by the mount
 * preflight (issue #665).
 *
 * @module @xmoon76/dsh-pi-tui/command-surface-session-hooks.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createCommandSurface } from '../../src/app/command/surface.ts'
import type { CommandSurfaceDeps } from '../../src/app/command/surface.ts'
import type { ModelSelectionValue } from '../../src/domain/session/model-selection.ts'

type SurfaceDeps = CommandSurfaceDeps<ModelSelectionValue, never>

/**
 * Compose the REAL command surface over the narrowest possible Remote-shaped
 * deps: only the members `createCommandSurface`/`attachRuntime` touch are
 * meaningful, and every unused capability is an empty cast rather than a fake
 * with invented behaviour. The one real fact under test is the `session` hook.
 */
function composeSurface(session: { readonly validateAutoWorkspace?: () => boolean }) {
  const app = new TuiApp(new VirtualTerminal(80, 24), { onSubmit: () => {}, onExit: () => {} })
  const ctx = new Context()
  const scopeFacts = sessionScopeFacts(() => undefined, () => 0)
  const deps = {
    ctx,
    logError: () => {},
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    signal: new AbortController().signal,
    app: () => app,
    notify: () => {},
    liveAgent: () => undefined,
    sessionScope: {
      capture: () => scopeFacts.captureSessionScope(),
      captureLive: () => undefined,
      isCurrent: (scope: never) => scopeFacts.isSessionScopeCurrent(scope),
    },
    ownership: { generation: () => 0, currentSessionId: () => undefined },
    transition: { pending: () => false, run: async (task: () => Promise<unknown>) => task() },
    commandsRegistry: () => undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    direct: {
      listScopedCommands: () => [],
      sessionStats: async () => undefined,
      lastAssistantText: async () => undefined,
      promptAdmission: async (_agent: never, _hasImages: boolean, task: () => Promise<unknown>) => task(),
    },
    catalog: { skills: {} } as never,
    toCatalogAgent: (agent: never) => agent,
    presets: {
      launch: undefined,
      pending: () => undefined,
      setPending: () => {},
      current: () => undefined,
      blank: () => undefined,
    },
    clientCwd: '/client',
    surface: {
      setNotificationMode: () => {},
      setNotificationMethod: () => {},
      currentNotificationMode: () => 'focused',
      currentNotificationMethod: () => 'auto',
      setTerminalProgressMode: () => {},
      openJobView: () => {},
      openTasksBrowser: () => {},
      openScheduleWorkspace: () => ({ kind: 'success' }),
      composer: () => app,
      deliveredFilesSnapshot: () => undefined,
      installTspCommandCompletions: () => {},
      installTspInlineAttachmentStager: () => {},
      tspCommandPickerCapabilities: () => ({}),
    },
    backend: {
      kind: 'remote',
      sessionReader: {} as never,
      sessionWorkspaceFacts: {} as never,
      hostDirectoryBrowse: {} as never,
      sessionWriter: {} as never,
      interaction: {} as never,
      catalog: {} as never,
      config: {} as never,
      hostFile: {} as never,
      webAccess: {} as never,
      acpAccess: {} as never,
      hostShellCompletion: {} as never,
    },
    session: {
      ...session,
      ensureSession: async () => {},
      withWriter: async (_scope: never, task: () => Promise<unknown>) => task(),
      switchSession: async () => undefined,
      forkSession: async () => ({ kind: 'committed', value: undefined }),
      isNavigationCurrent: () => false,
      transitionTo: async () => ({ ok: false, message: 'not exercised' }),
    },
    status: {
      forceContextMeasurement: () => undefined,
      forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
      sessionCwd: () => '/client',
      refresh: () => {},
      updateWelcomeCard: () => {},
      subscribeSessionScopeInvalidation: () => () => {},
    },
    settings: { applyFooterSettings: () => {}, setDisplayPreset: () => ({ applied: true }) },
    model: {} as never,
    viewer: { enterView: async () => {} },
    drafts: { images: {} as never, files: {} as never },
    extensions: { current: () => undefined, recordError: () => {}, clearError: () => {} },
    pluginManager: { page: () => undefined },
    client: { runCopyCommand: async () => true, copyEnv: {} },
    submission: {
      prepareDeps: () => ({}) as never,
      settleQueueRecalls: () => {},
      beginClientWrite: () => () => {},
    },
    promptState: {
      progressUpdates: { mode: 'milestones' },
      responseStyle: { style: 'default' },
      gitAttribution: { mode: 'off' },
    },
    tuiSettings: undefined,
    displayState: { preset: 'full' } as never,
    agents: {} as never,
    imageLimits: () => undefined,
    openRewindPicker: () => {},
    requestExit: () => {},
    exit: () => {},
  } as unknown as SurfaceDeps
  const surface = createCommandSurface(deps)
  surface.attachRuntime()
  return surface
}

test('the command facade forwards the session create-boundary AUTO Workspace validator', () => {
  const surface = composeSurface({ validateAutoWorkspace: () => true })
  assert.equal(surface.runner().validateAutoWorkspace?.(), true,
    'the facade must forward the session AUTO Workspace validator; a dropped member refuses a confirmed Remote sessionless /new')
})

test('the forwarded AUTO Workspace validator reads the live proof at call time', () => {
  let current = true
  const surface = composeSurface({ validateAutoWorkspace: () => current })
  const forwarded = surface.runner().validateAutoWorkspace
  assert.equal(forwarded?.(), true, 'the live proof is current at the first call')
  current = false
  assert.equal(forwarded?.(), false,
    'a later call must observe the revoked proof instead of a captured value')
})

test('the facade keeps the AUTO Workspace validator absent when the session supplies none', () => {
  const surface = composeSurface({})
  assert.equal(surface.runner().validateAutoWorkspace, undefined,
    'a Direct/sessionless composition without the hook must not invent a validator')
})
