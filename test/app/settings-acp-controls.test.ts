/**
 * PR-B — the ONE `Settings · Host · ACP access` surface through the REAL
 * `/settings` composition on a `VirtualTerminal`.
 *
 * The cases prove the USER paths, not an isolated page: `Host` owns the frozen
 * row order; `/acp` and the row mount the SAME page in the SAME lease; the
 * runtime toggle reaches the ONE `AcpAccessPort` Host controller with the
 * painted generation and repaints the authoritative read-back; the next-start
 * preference reaches the EXISTING revision-checked `acp-autostart` writer; the
 * Copy action is the proven Profile's exact stdio command and never touches the
 * Host. Direct still opens the truthful page.
 *
 * FIXTURE: the real command registration + TuiApp + VirtualTerminal.
 * STAND-IN: the Host `acpAccess` port, the ConfigPort ACP preference and the
 * Client clipboard.
 *
 * SUX #885 SCF: this file is also the single application-level REAL-queue proof
 * for the three same-root scalar Config decisions (Web next-start, startup
 * backend and Visual tools). They run over the SAME production RemoteConfigPort
 * mirror/queue as the ACP preference above, so the queue-head fence, the
 * accepted/unknown settlement and the Backend side-effect attribution are
 * proved end to end instead of through a precomputed outcome.
 *
 * @module @xmoon76/dsh-pi-tui/settings-acp-controls.test
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../../src/tui-app.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { AcpAccessPort, AcpAccessStatus } from '../../src/runtime/acp-access-port.ts'
import type { WebAccessStatus } from '../../src/runtime/web-access-port.ts'
import type {
  AcpStartupPreferenceState,
  BackendStartupPreferenceConfig,
  SectionMutationOutcome,
  TuiSettingsDoc,
  VisualToolsConfig,
  WebStartupPreferenceConfig,
} from '../../src/runtime/config-port.ts'
import { RemoteConfigPort, type RemoteConfigRuntimeSource, type RemoteSettingsPathOp } from '../../src/runtime/remote/config-remote.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { unconfiguredPolicyObservation } from '../support/session-policy-fake.ts'

const DOWN = '\x1b[B'
const UP = '\x1b[A'
const ENTER = '\r'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => disposeStartedApps())

const DEFAULT_DOC: TuiSettingsDoc = {
  theme: 'dark',
  iconStyle: 'unicode',
  footer: 'default',
  fullscreen: 'off',
  busyEnter: 'queue',
  localShellSandbox: 'bypass',
  homeEndKeys: 'app',
  notificationMode: 'off',
  notificationMethod: 'auto',
  terminalProgress: 'off',
  wheelScrollLines: '3',
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly view: () => string
  readonly invoke: (name: string) => unknown
  readonly acp: {
    status: AcpAccessStatus
    reads: number
    setEnabledCalls: boolean[]
    setEnabledGenerations: unknown[]
    gate: Promise<void> | undefined
    release: (() => void) | undefined
  }
  readonly pref: {
    state: AcpStartupPreferenceState | undefined
    writes: boolean[]
    revisions: number[]
    generations: object[]
    failNext: string | undefined
    /** Synthetic port settlement for the next write (default accepted). */
    outcome: SectionMutationOutcome | undefined
  }
  readonly copied: string[]
  readonly setReadiness: (readiness: 'ready' | 'stale' | 'unavailable') => void
  /** Simulate a Connection generation change (Host A -> Host B). */
  readonly bumpGeneration: () => void
  /** Release every held status read (the preflight and the new Host's read). */
  readonly releaseAcpReads: () => void
  /** Release one held `setEnabled` call (the real Host write). */
  readonly releaseAcpWrite: () => void
  readonly dispose: () => void
  readonly remote: RemoteConfigFixture | undefined
  /** The process-lifetime Backend exit-transition intents this Client recorded. */
  readonly backendTransitions: () => readonly ('daemon-to-direct' | undefined)[]
  readonly diagnostics: string[]
}

interface RemoteConfigFixture {
  readonly ready: Promise<void>
  readonly configAcp: {
    readonly read: () => AcpStartupPreferenceState | undefined
    readonly setAutoStart: (value: boolean, revision: number, generation: object) => Promise<SectionMutationOutcome>
  }
  /** The three scalar Config sub-domains over the SAME real mirror/queue: the
   *  Remote adapters' own typed setters, never a second writer. */
  readonly configWeb: WebStartupPreferenceConfig
  readonly configBackend: BackendStartupPreferenceConfig
  readonly configVisual: VisualToolsConfig
  readonly forwarded: () => readonly { value: boolean; revision: number; generation: object }[]
  readonly scalarForwarded: () => readonly { ns: string; value: unknown; revision: number; generation: object }[]
  readonly nextForwarded: () => Promise<void>
  readonly calls: () => readonly { ns: string; ops: readonly RemoteSettingsPathOp[]; revision: number | undefined; destination: 'A' | 'B' }[]
  readonly holdPredecessor: () => Promise<void>
  readonly submitSibling: () => Promise<SectionMutationOutcome>
  readonly releasePredecessor: () => void
  readonly advanceB: (
    autoStart: boolean,
    revision: number,
    overrides?: {
      readonly web?: { readonly autoStart: boolean; readonly revision: number }
      readonly backend?: { readonly backend: 'direct' | 'daemon'; readonly revision: number }
      readonly visual?: { readonly enabled: boolean; readonly revision: number }
    },
  ) => void
  readonly holdReceipt: (fail?: boolean) => Promise<void>
  readonly releaseReceipt: () => void
  readonly acceptWithoutApply: () => void
  readonly currentGeneration: () => object | undefined
  readonly readiness: () => 'ready' | 'stale' | 'unavailable'
  readonly siblingValue: (destination: 'A' | 'B') => number | undefined
  readonly lastWrite: () => Promise<SectionMutationOutcome> | undefined
}

/**
 * A narrow real-Remote-Config fixture: the production `RemoteConfigPort`
 * mirror/queue/writer run against structural remotes, and the ACP runtime and
 * Config share the caller's ONE generation source. It exists only to hold the
 * actual queue/receipt boundaries; it is not a second runtime/harness.
 */
function makeRemoteConfig(
  connection: { readonly getSnapshot: () => object | undefined; readonly subscribe: (listener: () => void) => () => void },
  advanceRuntime: () => void,
  initial: { readonly backend?: 'direct' | 'daemon' } = {},
): RemoteConfigFixture {
  const ACP = 'pi-tui-acp-preferences'
  const SIBLING = 'subagent'
  const WEB = 'pi-tui-web-preferences'
  const STARTUP = 'tui-startup'
  const VISUAL = 'pi-tui-visual-tools'
  let phase: 'A' | 'B' = 'A'
  const aNamespaces: Array<{ ns: string; value?: unknown; base?: unknown; user?: unknown; revision?: number }> = [
    { ns: ACP, base: { autoStart: false }, user: {}, value: { autoStart: false }, revision: 7 },
    { ns: SIBLING, base: { maxDepth: 1, maxActiveSubagents: 8 }, user: {}, value: { maxDepth: 1, maxActiveSubagents: 8 }, revision: 5 },
    { ns: WEB, base: { autoStart: false }, user: { autoStart: false }, value: { autoStart: false }, revision: 4 },
    { ns: STARTUP, base: { backend: 'direct' }, user: { backend: initial.backend ?? 'direct' }, value: { backend: initial.backend ?? 'direct' }, revision: 6 },
    { ns: VISUAL, base: { enabled: true }, user: { enabled: true }, value: { enabled: true }, revision: 3 },
  ]
  let namespaces = aNamespaces
  const calls: Array<{ ns: string; ops: readonly RemoteSettingsPathOp[]; revision: number | undefined; destination: 'A' | 'B' }> = []
  const forwarded: Array<{ value: boolean; revision: number; generation: object }> = []
  const scalarForwarded: Array<{ ns: string; value: unknown; revision: number; generation: object }> = []
  let notifyForwarded: (() => void) | undefined
  let holdMutation: { entered: () => void; released: Promise<void> } | undefined
  let holdReceipt: { entered: () => void; released: Promise<void> } | undefined
  let releasePredecessorFn: (() => void) | undefined
  let releaseReceiptFn: (() => void) | undefined
  let failReceipt = false
  let skipApply = false
  let lastWrite: Promise<SectionMutationOutcome> | undefined

  const settings = {
    describe: async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: structuredClone(namespaces) } }),
    update: async () => ({ ok: true as const, value: {} }),
    replace: async () => ({ ok: true as const, value: {} }),
    mutate: async (ns: string, ops: readonly RemoteSettingsPathOp[], revision: number | undefined) => {
      // Capture the destination synchronously at invocation. A held A request
      // must apply to A's own arrays even after B replaces the live snapshot.
      const destination = phase
      const target = namespaces.find(item => item.ns === ns)
      calls.push({ ns, ops: structuredClone(ops), revision, destination })
      if (holdMutation !== undefined) {
        const held = holdMutation
        holdMutation = undefined
        held.entered()
        await held.released
      }
      if (target === undefined) return { ok: false as const, error: { code: 'settings/absent', message: 'no section' } }
      if (revision !== target.revision) {
        return { ok: false as const, error: { code: 'settings/conflict', message: 'revision changed since it was read' } }
      }
      if (!skipApply) {
        const user = { ...(target.user as Record<string, unknown> | undefined) }
        const base = target.base as Record<string, unknown>
        for (const op of ops) {
          const field = op.path[0]!
          if (op.op === 'set') user[field] = structuredClone(op.value)
          else if (Object.hasOwn(base, field)) user[field] = structuredClone(base[field])
          else Reflect.deleteProperty(user, field)
        }
        target.user = user
        target.value = { ...base, ...user }
        target.revision = (target.revision ?? 0) + 1
      }
      skipApply = false
      if (holdReceipt !== undefined) {
        const held = holdReceipt
        holdReceipt = undefined
        held.entered()
        await held.released
      }
      if (failReceipt) {
        failReceipt = false
        return { ok: false as const, error: { code: 'gateway/internal', message: 'the mutation receipt was lost' } }
      }
      return { ok: true as const, value: {} }
    },
  }
  const remote = {
    settings,
    credentials: {
      describe: async () => ({ ok: true as const, value: {} }),
      set: async () => ({ ok: true as const, value: undefined }),
      unset: async () => ({ ok: true as const, value: undefined }),
    },
    commands: { execute: async () => ({ ok: true as const, value: undefined }) },
    permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
    agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
    llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
    $on: (_event: string, _listener: (...args: unknown[]) => void) => () => {},
  }
  const port = new RemoteConfigPort({ remote, connection: { generation: connection } } as unknown as RemoteConfigRuntimeSource)
  const real = port.acpStartupPreference
  const configAcp = {
    read: () => real.read(),
    setAutoStart: (value: boolean, revision: number, generation: object) => {
      forwarded.push({ value, revision, generation })
      notifyForwarded?.()
      notifyForwarded = undefined
      const write = real.setAutoStart(value, revision, generation)
      lastWrite = write
      return write
    },
  }
  const realWeb = port.webStartupPreference
  const realBackend = port.backendStartupPreference
  const realVisual = port.visualTools
  const configWeb: WebStartupPreferenceConfig = {
    read: () => realWeb.read(),
    setAutoStart: (value, revision, generation) => {
      scalarForwarded.push({ ns: WEB, value, revision, generation })
      notifyForwarded?.(); notifyForwarded = undefined
      const write = realWeb.setAutoStart(value, revision, generation)
      lastWrite = write
      return write
    },
  }
  const configBackend: BackendStartupPreferenceConfig = {
    read: () => realBackend.read(),
    readFresh: () => realBackend.readFresh(),
    setBackend: (value, revision, generation) => {
      scalarForwarded.push({ ns: STARTUP, value, revision, generation })
      notifyForwarded?.(); notifyForwarded = undefined
      const write = realBackend.setBackend(value, revision, generation)
      lastWrite = write
      return write
    },
  }
  const configVisual: VisualToolsConfig = {
    read: () => realVisual.read(),
    setEnabled: (enabled, revision, generation) => {
      scalarForwarded.push({ ns: VISUAL, value: enabled, revision, generation })
      notifyForwarded?.(); notifyForwarded = undefined
      const write = realVisual.setEnabled(enabled, revision, generation)
      lastWrite = write
      return write
    },
  }
  return {
    ready: port.describe(),
    configAcp,
    configWeb,
    configBackend,
    configVisual,
    forwarded: () => forwarded,
    scalarForwarded: () => scalarForwarded,
    nextForwarded: () => new Promise<void>(resolve => { notifyForwarded = resolve }),
    calls: () => calls,
    holdPredecessor: () => new Promise<void>(resolve => {
      let release!: () => void
      const released = new Promise<void>(done => { release = done })
      releasePredecessorFn = release
      holdMutation = { entered: resolve, released }
    }),
    submitSibling: async () => port.subagentLimits.mutate(
      { maxActiveSubagents: { kind: 'set', value: 9 } },
      5,
      connection.getSnapshot()!,
    ),
    releasePredecessor: () => {
      releasePredecessorFn?.()
      releasePredecessorFn = undefined
    },
    advanceB: (autoStart, revision, overrides = {}) => {
      phase = 'B'
      const web = overrides.web ?? { autoStart: false, revision: 4 }
      const backend = overrides.backend ?? { backend: 'direct' as const, revision: 6 }
      const visual = overrides.visual ?? { enabled: true, revision: 3 }
      namespaces = [
        { ns: ACP, base: { autoStart: false }, user: { autoStart }, value: { autoStart }, revision },
        { ns: SIBLING, base: { maxDepth: 1, maxActiveSubagents: 8 }, user: {}, value: { maxDepth: 1, maxActiveSubagents: 8 }, revision: 5 },
        { ns: WEB, base: { autoStart: false }, user: { autoStart: web.autoStart }, value: { autoStart: web.autoStart }, revision: web.revision },
        { ns: STARTUP, base: { backend: 'direct' }, user: { backend: backend.backend }, value: { backend: backend.backend }, revision: backend.revision },
        { ns: VISUAL, base: { enabled: true }, user: { enabled: visual.enabled }, value: { enabled: visual.enabled }, revision: visual.revision },
      ]
      advanceRuntime()
    },
    holdReceipt: (fail = false) => new Promise<void>(resolve => {
      let release!: () => void
      const released = new Promise<void>(done => { release = done })
      failReceipt = fail
      releaseReceiptFn = release
      holdReceipt = { entered: resolve, released }
    }),
    releaseReceipt: () => {
      releaseReceiptFn?.()
      releaseReceiptFn = undefined
    },
    acceptWithoutApply: () => { skipApply = true },
    currentGeneration: () => connection.getSnapshot(),
    readiness: () => port.configReadiness(),
    siblingValue: destination => {
      const source = destination === 'A' ? aNamespaces : namespaces
      const value = source.find(item => item.ns === SIBLING)?.value as { maxActiveSubagents?: number } | undefined
      return value?.maxActiveSubagents
    },
    lastWrite: () => lastWrite,
  }
}

function setup(options: {
  readonly columns?: number
  readonly rows?: number
  readonly backendKind?: 'direct' | 'remote'
  readonly status?: AcpAccessStatus
  readonly pref?: AcpStartupPreferenceState | undefined
  readonly readiness?: 'ready' | 'stale' | 'unavailable'
  readonly profile?: string | undefined
  /** Hold every `getStatus` after the page-entry read (the live preflight). */
  readonly holdSecondAcpRead?: boolean
  /** Hold the real `setEnabled` call after it is invoked. */
  readonly holdAcpWrite?: boolean
  /** Compose the REAL RemoteConfigPort for the scalar Config paths. */
  readonly remoteConfig?: boolean
  /** The startup backend Host A starts with (default `direct`). */
  readonly remoteInitialBackend?: 'direct' | 'daemon'
} = {}): Harness {
  const columns = options.columns ?? 200
  const rows = options.rows ?? 44
  const vt = new VirtualTerminal(columns, rows)
  const doc: TuiSettingsDoc = { ...DEFAULT_DOC }
  // A real owned runner: a Confirm write travels the production `runOwned`
  // path instead of a stubbed promise (the workspace `onCommit` requires it).
  const owned: OwnedRunner = (_label, task, runOptions) => {
    void Promise.resolve()
      .then(() => task())
      .then(
        result => runOptions.onResult?.(result),
        error => runOptions.onError?.(error),
      )
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const app = new TuiApp(vt, events)
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  let readiness: 'ready' | 'stale' | 'unavailable' = options.readiness ?? 'ready'
  const acp = {
    status: options.status ?? { state: 'disabled' as const },
    setEnabledCalls: [] as boolean[],
    setEnabledGenerations: [] as unknown[],
    gate: undefined as Promise<void> | undefined,
    release: undefined as (() => void) | undefined,
    reads: 0,
    readGate: undefined as Promise<void> | undefined,
    releaseRead: undefined as (() => void) | undefined,
  }
  const settingsAuthority: object = {}
  const pref = {
    state: ('pref' in options
      ? options.pref
      : { autoStart: false, revision: 1, userOverridden: false, generation: settingsAuthority }) as AcpStartupPreferenceState | undefined,
    writes: [] as boolean[],
    revisions: [] as number[],
    generations: [] as object[],
    failNext: undefined as string | undefined,
    outcome: undefined as SectionMutationOutcome | undefined,
  }
  const copied: string[] = []
  const diagnostics: string[] = []
  const backendTransitions: ('daemon-to-direct' | undefined)[] = []
  let webStatus: WebAccessStatus = { state: 'enabled' }
  // The opaque Connection generation identity (object) the ACP observation binds
  // to; a reconnect (Host A -> Host B) replaces it and notifies subscribers.
  let generation: object | undefined = { id: 1 }
  const generationListeners = new Set<() => void>()
  const remote = options.remoteConfig === true
    ? makeRemoteConfig(
        {
          getSnapshot: () => generation,
          subscribe: listener => {
            generationListeners.add(listener)
            return () => { generationListeners.delete(listener) }
          },
        },
        () => {
          generation = { id: ((generation as { id?: number } | undefined)?.id ?? 0) + 1 }
          for (const listener of [...generationListeners]) listener()
        },
        options.remoteInitialBackend === undefined ? {} : { backend: options.remoteInitialBackend },
      )
    : undefined
  const acpAccess: AcpAccessPort = {
    getStatus: async () => {
      acp.reads += 1
      if (options.holdSecondAcpRead === true && acp.reads >= 2) {
        acp.readGate ??= new Promise<void>(resolve => { acp.releaseRead = resolve })
        await acp.readGate
      }
      return acp.status
    },
    setEnabled: async (enabled: boolean, expectedGeneration?: unknown) => {
      if (expectedGeneration !== undefined && !Object.is(generation, expectedGeneration)) {
        throw new Error('superseded: the Host generation changed before dispatch')
      }
      acp.setEnabledCalls.push(enabled)
      acp.setEnabledGenerations.push(expectedGeneration)
      if (options.holdAcpWrite === true) {
        acp.gate ??= new Promise<void>(resolve => { acp.release = resolve })
        await acp.gate
      }
      acp.status = enabled ? { state: 'enabled' } : { state: 'disabled' }
      return acp.status
    },
    currentGeneration: () => generation,
    subscribeGeneration: listener => {
      generationListeners.add(listener)
      return () => { generationListeners.delete(listener) }
    },
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off', sinks: [{ write: line => { diagnostics.push(line) } }] }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    policy: unconfiguredPolicyObservation(),
    captureLiveSessionScope: () => undefined,
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: options.backendKind ?? 'remote',
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: () => ({ kind: 'unchanged' }),
    refreshStatus: () => {},
    tuiSettings: { get: () => doc, replace: (next: TuiSettingsDoc) => { Object.assign(doc, next) } },
    extensions: undefined,
    createPluginManagerPage: () => undefined,
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    setFocusMode: () => {},
    setNotificationMethod: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {},
    setSessionApprovalPolicy: () => 'applied',
    currentApprovalOverride: () => undefined,
    applyFooterSettings: () => {},
    // The Client-local clipboard of the Copy action (never a Host call).
    copyToClipboard: async (text: string) => { copied.push(text); return true },
    // The official Profile identity the composition proved for THIS launch.
    profileDaemonAdmin: 'profile' in options && options.profile === undefined
      ? undefined
      : {
          profile: options.profile ?? 'pi-tui',
          run: async () => ({ code: 0, stdout: '', stderr: '' }),
        },
    acpAccess,
    // The Split Host's live Web frontend: only the Web UI page reads it, and
    // the scalar cases never toggle it.
    webAccess: {
      getStatus: async () => webStatus,
      setEnabled: async (enabled: boolean) => {
        webStatus = enabled ? { state: 'enabled' } : { state: 'disabled' }
        return webStatus
      },
      getAuthenticatedUrl: async () => ({ url: 'http://127.0.0.1:1/?token=TEST' }),
      currentGeneration: () => generation,
      subscribeGeneration: (listener: () => void) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    },
    recordBackendExitTransition: (transition: 'daemon-to-direct' | undefined) => { backendTransitions.push(transition) },
    config: settingsDirectPageConfig({
      configReadiness: () => remote?.readiness() ?? readiness,
      ...(remote === undefined ? {} : {
        webStartupPreference: remote.configWeb,
        backendStartupPreference: remote.configBackend,
        visualTools: remote.configVisual,
      }),
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentLimits: {
        read: () => ({ kind: 'unavailable' as const, reason: 'not mounted' }),
        refresh: async () => {},
        mutate: async () => ({ kind: 'rejected' as const, reason: 'not mounted' }),
      },
      subagentModelSelection: {
        read: () => ({ kind: 'unavailable' as const, reason: 'not mounted' }),
        refresh: async () => {},
        mutate: async () => ({ kind: 'rejected' as const, reason: 'not mounted' }),
      },
      credentials: { available: () => true, describeReference: async () => ({ configured: true, source: 'file' }) },
      web: { available: () => false },
      sessionLogUpload: {
        read: () => ({
          kind: 'ready' as const,
          generation: {},
          revision: 1,
          effective: { enabled: true },
          inherited: { enabled: true },
          overridden: { enabled: false },
        }),
        refresh: async () => {},
        mutate: async () => ({ kind: 'rejected' as const, reason: 'not mounted' }),
      },
      acpStartupPreference: remote?.configAcp ?? {
        read: () => pref.state,
        setAutoStart: async (value: boolean, revision: number, generation: object) => {
          pref.writes.push(value)
          pref.revisions.push(revision)
          pref.generations.push(generation)
          if (pref.failNext !== undefined) {
            const reason = pref.failNext
            pref.failNext = undefined
            throw new Error(reason)
          }
          if (pref.outcome !== undefined) {
            const outcome = pref.outcome
            pref.outcome = undefined
            return outcome
          }
          if (pref.state !== undefined && !Object.is(generation, pref.state.generation)) {
            return { kind: 'rejected' as const, reason: 'the Host settings authority changed since this choice was read' }
          }
          if (pref.state !== undefined && pref.state.revision !== revision) {
            return { kind: 'conflict' as const, reason: 'the Host settings section changed since it was read' }
          }
          if (pref.state !== undefined) {
            pref.state = {
              autoStart: value,
              revision: revision + 1,
              userOverridden: true,
              generation: pref.state.generation,
            }
          }
          return { kind: 'accepted' as const }
        },
      },
    }),
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name: string): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/gu, '')).join('\n')
  return {
    vt,
    app,
    view,
    invoke,
    acp,
    pref,
    copied,
    setReadiness: next => { readiness = next },
    bumpGeneration: () => {
      generation = { id: ((generation as { id?: number } | undefined)?.id ?? 0) + 1 }
      if (pref.state !== undefined) pref.state = { ...pref.state, generation: {} }
      for (const listener of [...generationListeners]) listener()
    },
    releaseAcpReads: () => { acp.releaseRead?.(); acp.releaseRead = undefined },
    releaseAcpWrite: () => { acp.release?.(); acp.release = undefined },
    remote,
    backendTransitions: () => backendTransitions,
    diagnostics,
    dispose: () => {
      startedApps.delete(app)
      if (!app.isDisposed()) app.dispose()
    },
  }
}

async function key(h: Harness, data: string): Promise<void> {
  h.vt.sendInput(data)
  await h.vt.waitForRender()
}

async function settle(h: Harness, label: string, predicate: (frame: string) => boolean): Promise<string> {
  await waitForFrame(() => h.view(), predicate, () => h.vt.waitForRender(), label)
  return h.view()
}

/** Drain the page's owned microtasks/timers and paint the resulting frame. */
async function drain(h: Harness, rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  await h.vt.waitForRender()
}

/** Open `/settings` on the `Host` Rows level. */
async function openHostRows(h: Harness): Promise<void> {
  h.invoke('settings')
  await settle(h, 'the Settings rail', frame => frame.includes('Settings ·'))
  await selectSettingsCategory(h.vt, 'Host')
  await key(h, ENTER)
  await settle(h, 'the Host rows', frame => frame.includes('Backend'))
}

/** Open the ONE `Host → ACP access` page from the Host Rows level. */
async function openAcpAccess(h: Harness): Promise<void> {
  await highlightRow(h, 'ACP access')
  await key(h, ENTER)
  await settle(h, 'the ACP access page', frame => frame.includes('Current Host') && !frame.includes('Checking…'))
}

/** Move the Rows cursor onto a row whose label matches, then assert it is selected. */
async function highlightRow(h: Harness, label: string): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    if (new RegExp(`> ${label}`, 'u').test(h.view())) return
    await key(h, DOWN)
  }
  assert.fail(`the "${label}" row never owned the selection:\n${h.view()}`)
}

/** Open the real ACP page and stage its next-start On confirmation. */
async function stageAcpPreferenceConfirm(h: Harness): Promise<void> {
  await openHostRows(h)
  await openAcpAccess(h)
  await highlightRow(h, 'Start automatically')
  await key(h, ENTER) // candidates
  await key(h, ENTER) // stage On
  assert.match(h.view(), /Save the next Host start preference as On\?/u)
}

test('a queued ACP preference request is fenced at the real Remote queue head', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true, status: { state: 'enabled' } })
  await h.remote!.ready
  await stageAcpPreferenceConfirm(h)

  // A real sibling Config mutation owns the shared queue and is held before the
  // predecessor's official mutation returns.
  const entered = h.remote!.holdPredecessor()
  const predecessor = h.remote!.submitSibling()
  await entered
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER) // Confirm save: A is admitted to the REAL port and queued
  await forwarded
  assert.equal(h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences').length, 0,
    'A is queued behind the predecessor; no ACP RPC yet')

  // Host B is ready at the SAME revision and value; release the predecessor.
  h.remote!.advanceB(false, 7)
  h.remote!.releasePredecessor()
  await predecessor
  // The held predecessor applied to its captured A descriptor, never to B.
  assert.equal(h.remote!.siblingValue('A'), 9, 'the predecessor mutation stayed on A')
  assert.equal(h.remote!.siblingValue('B'), 8, 'B\'s sibling descriptor was not edited')
  await settle(h, 'the queue-head refusal', frame => /Status\s+Not saved/u.test(frame))
  assert.equal(h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences').length, 0,
    'the old A intent dispatched ZERO ACP mutations against B')
  assert.match(h.view(), /Start automatically\s+Off\b/u, 'B still reads its own Off value')

  // A fresh, explicit B gesture is the only request that reaches B.
  await highlightRow(h, 'Start automatically')
  await key(h, ENTER)
  await key(h, ENTER)
  await key(h, ENTER)
  await settle(h, 'the fresh B verification', frame => /Status\s+Verified/u.test(frame))
  const acpCalls = h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences')
  assert.equal(acpCalls.length, 1, 'exactly ONE ACP mutation was dispatched, by the fresh B intent')
  assert.equal(acpCalls[0]!.revision, 7, 'B used its own captured revision')
  assert.equal(acpCalls[0]!.destination, 'B')
  assert.equal(acpCalls[0]!.ops[0]?.op === 'set' ? acpCalls[0]!.ops[0]!.value : undefined, true)
  assert.equal(h.remote!.forwarded().length, 2, 'both requests crossed the real adapter path')
  assert.equal(h.remote!.forwarded()[1]!.generation, h.remote!.currentGeneration(),
    'the fresh request carried the CURRENT B authority identity')
  await h.remote!.lastWrite()
  h.dispose()
})

test('an invoked ACP preference accepted by A is Unverified, never attributed from B', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true, status: { state: 'enabled' } })
  await h.remote!.ready
  await stageAcpPreferenceConfirm(h)

  const received = h.remote!.holdReceipt()
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER) // the REAL ACP mutation applies On and holds its receipt
  await forwarded
  await received
  const aCalls = h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences')
  assert.equal(aCalls.length, 1)
  assert.equal(aCalls[0]!.destination, 'A')

  // B exposes the SAME revision and the SAME requested On value: B's value must
  // not turn A's accepted receipt into Verified.
  h.remote!.advanceB(true, 7)
  h.remote!.releaseReceipt()
  await settle(h, 'the cross-generation unverified settlement', frame => /Status\s+Unverified/u.test(frame))
  assert.match(h.view(), /no current same-generation readback/u)
  assert.equal(h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences').length, 1,
    'A is never replayed and B receives no implicit mutation')
  h.dispose()
})

test('an unknown ACP receipt is Outcome unconfirmed even when B matches the request', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true, status: { state: 'enabled' } })
  await h.remote!.ready
  await stageAcpPreferenceConfirm(h)

  const received = h.remote!.holdReceipt(true)
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(true, 7)
  h.remote!.releaseReceipt()
  await settle(h, 'the unknown receipt settlement', frame => /Status\s+Outcome unconfirmed/u.test(frame))
  assert.doesNotMatch(h.view(), /Status\s+Not saved/u, 'an uncertain post-invoke failure is never guessed as Not saved')
  assert.equal(h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences').length, 1,
    'the uncertain A call is not replayed against B')
  h.dispose()
})

test('an accepted same-generation ACP write with a disagreeing readback is Unverified', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true, status: { state: 'enabled' } })
  await h.remote!.ready
  await stageAcpPreferenceConfirm(h)
  h.remote!.acceptWithoutApply()
  await key(h, ENTER)
  await settle(h, 'the same-generation mismatch', frame => /Status\s+Unverified/u.test(frame))
  assert.match(h.view(), /the same-generation readback reads Off/u)
  const calls = h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.destination, 'A')
  h.dispose()
})

test('a pending ACP Config write Back does not revive or replay after its late completion', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true, status: { state: 'enabled' } })
  await h.remote!.ready
  await stageAcpPreferenceConfirm(h)

  const received = h.remote!.holdReceipt()
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(true, 7)
  const write = h.remote!.lastWrite()
  assert.ok(write !== undefined)
  await key(h, '\x1b') // Back is allowed for a pending CONFIG write
  await settle(h, 'the Rows level after Back', frame => /Settings · Host · Rows/u.test(frame))
  h.remote!.releaseReceipt()
  // Wait for the real adapter write lifetime to settle AND the retired page's
  // owner to diagnose the terminal outcome; a painted Rows frame alone is not
  // proof that the late write finished.
  const lateOutcome = await write
  assert.equal(lateOutcome.kind, 'accepted', 'the late A receipt is known-accepted')
  await waitForFrame(
    () => h.diagnostics.join('\n'),
    text => /acp access preference write/u.test(text) && /outcome=unverified/u.test(text),
    () => h.vt.waitForRender(),
    'the retired page\'s late owner diagnostic',
  )
  assert.match(h.view(), /Settings · Host · Rows/u, 'Rows stays current after settlement')
  assert.doesNotMatch(h.view(), /Settings · Host · ACP access/u, 'the retired page never revives to paint its late outcome')
  assert.equal(h.remote!.calls().filter(call => call.ns === 'pi-tui-acp-preferences').length, 1,
    'late completion neither replays A nor issues a B write')
  h.dispose()
})

test('Host owns Backend, Web UI, ACP access and Session log in order; Tools has no ACP row left', async () => {
  const h = setup({ columns: 200, rows: 50 })
  await openHostRows(h)
  const rows = h.view()
  const hostOrder = ['Backend', 'Web UI', 'ACP access', 'Session log upload']
    .map(label => rows.split('\n').findIndex(line => line.includes(label)))
  for (const [index, position] of hostOrder.entries()) {
    assert.ok(position >= 0, `Host paints ${JSON.stringify(hostOrder[index])}:\n${rows}`)
  }
  assert.deepEqual([...hostOrder].sort((left, right) => left - right), hostOrder, 'Host keeps the frozen order')
  assert.doesNotMatch(rows, /Start ACP automatically|ACP Server/u, 'the retired rows are gone, not duplicated')

  await key(h, '\x1b') // rows -> the category rail
  await key(h, '\x1b[H') // Home makes the walk absolute (the rail keeps its selection)
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER)
  await settle(h, 'the Tools rows', frame => frame.includes('Visual tools'))
  const tools = h.view()
  for (const label of ['Visual tools', 'Shell execution', 'Web Search / Fetch']) {
    assert.ok(tools.includes(label), `Tools keeps ${label}`)
  }
  assert.doesNotMatch(tools, /ACP Server|Start ACP automatically/u, 'the retired ACP rows left Tools and Host')
  h.dispose()
})

test('the /acp deep link mounts the ONE ACP access page in the SAME lease and writes nothing on open', async () => {
  const h = setup({ status: { state: 'disabled' } })
  const resultPromise = h.invoke('acp') as Promise<{ kind: string }>
  await settle(h, 'the /acp deep link page', frame => frame.includes('Settings · Host · ACP access'))
  const result = await resultPromise
  assert.deepEqual(result, { kind: 'success' })
  assert.match(h.view(), /> Enable ACP/mu, 'the disabled Host offers its ONE runtime action')
  assert.match(h.view(), /Client Setup/u)
  assert.equal(h.app.overlayGraphState().handles, 0, 'ONE Settings lease: no second overlay is mounted')
  assert.equal(h.acp.setEnabledCalls.length, 0, 'opening the page dispatches no Host write')
  assert.deepEqual(h.pref.writes, [], 'opening the page writes no preference')
  assert.deepEqual(h.copied, [], 'opening the page copies nothing')
  h.dispose()
})

test('the typed /acp deep link reaches Direct and states Split Host only', async () => {
  const h = setup({ backendKind: 'direct' })
  const resultPromise = h.invoke('acp') as Promise<{ kind: string }>
  await settle(h, 'the Direct /acp page', frame => frame.includes('Settings · Host · ACP access'))
  assert.deepEqual(await resultPromise, { kind: 'success' })
  assert.match(h.view(), /Listener\s+Unavailable · Split Host only/u)
  assert.doesNotMatch(h.view(), /> (?:Enable ACP|Disable ACP…)/u)
  h.dispose()
})

test('the page toggles the live listener through ONE Host write and repaints the read-back', async () => {
  const h = setup({ status: { state: 'disabled' } })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /Listener\s+Disabled/u)
  await key(h, ENTER) // Enable ACP
  await settle(h, 'the verified enable', frame => /Status\s+Verified/u.test(frame))
  assert.deepEqual(h.acp.setEnabledCalls, [true], 'exactly ONE Host toggle')
  assert.match(h.view(), /Listener\s+Enabled/u)
  assert.match(h.view(), /Copy client command/u)
  assert.match(h.view(), /Disable ACP…/u)
  await key(h, DOWN) // Copy -> Disable ACP…
  assert.match(h.view(), /> Disable ACP…/mu)
  await key(h, ENTER) // stage the confirmation only
  assert.match(h.view(), /Disable the local ACP listener\?/u)
  assert.deepEqual(h.acp.setEnabledCalls, [true], 'the first step never writes')
  await key(h, '\x1b') // cancel
  assert.match(h.view(), /Listener\s+Enabled/u)
  assert.deepEqual(h.acp.setEnabledCalls, [true])
  h.dispose()
})

test('the next-start preference writes through the EXISTING acp-autostart revision writer', async () => {
  const h = setup({ status: { state: 'enabled' } })
  await openHostRows(h)
  await openAcpAccess(h)
  await highlightRow(h, 'Start automatically')
  await key(h, ENTER) // candidates
  assert.match(h.view(), /Choose the value the next Host start applies:/u)
  await key(h, ENTER) // stage the opposite (On)
  assert.match(h.view(), /Save the next Host start preference as On\?/u)
  assert.deepEqual(h.pref.writes, [], 'the ladder staged zero writes')
  await key(h, ENTER) // Confirm save
  await settle(h, 'the verified preference', frame => /Status\s+Verified/u.test(frame))
  assert.deepEqual(h.pref.writes, [true], 'the existing writer received the value once')
  assert.deepEqual(h.pref.revisions, [1], 'the captured revision is the decision fence')
  assert.match(h.view(), /Start automatically\s+On · Change…/u, 'the persisted fact is re-read')
  assert.deepEqual(h.acp.setEnabledCalls, [], 'a preference save never toggles the running Host')
  h.dispose()
})

test('a non-current configuration leaves the next-start preference read-only with zero writes', async () => {
  const h = setup({ status: { state: 'enabled' }, readiness: 'stale' })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /Start automatically\s+Off \(default\) · last known/u)
  assert.doesNotMatch(h.view(), /Change…/u, 'no edit affordance under a non-current authority')
  assert.match(h.view(), /The Host configuration is stale; the next-start preference is read-only\./u)
  await key(h, ENTER)
  assert.deepEqual(h.pref.writes, [])
  assert.deepEqual(h.acp.setEnabledCalls, [])
  h.dispose()
})

/** The ONE next-start ladder every write-classification case uses. */
async function confirmAcpPreference(h: Harness): Promise<void> {
  await openHostRows(h)
  await openAcpAccess(h)
  await highlightRow(h, 'Start automatically')
  await key(h, ENTER) // candidates
  await key(h, ENTER) // stage On
  await key(h, ENTER) // Confirm save
}

test('a typed refusal is Not saved while an unknown settlement is unconfirmed', async () => {
  const rejected = setup({ status: { state: 'enabled' } })
  rejected.pref.outcome = { kind: 'rejected', reason: 'the Host settings authority changed before dispatch' }
  await confirmAcpPreference(rejected)
  await settle(rejected, 'the refused preference', frame => /Status\s+Not saved/u.test(frame))
  assert.match(rejected.view(), /authority changed before dispatch/u)
  rejected.dispose()

  const conflict = setup({ status: { state: 'enabled' } })
  conflict.pref.outcome = { kind: 'conflict', reason: 'the Host settings section changed since it was read' }
  await confirmAcpPreference(conflict)
  await settle(conflict, 'the conflicted preference', frame => /Status\s+Not saved/u.test(frame))
  assert.match(conflict.view(), /section changed since it was read/u)
  conflict.dispose()

  const unknown = setup({ status: { state: 'enabled' } })
  unknown.pref.outcome = { kind: 'outcome-unconfirmed', reason: 'the settings reply was lost after dispatch' }
  await confirmAcpPreference(unknown)
  await settle(unknown, 'the unconfirmed preference', frame => /Status\s+Outcome unconfirmed/u.test(frame))
  assert.match(unknown.view(), /settings reply was lost after dispatch/u)
  unknown.dispose()
})


test('the Copy action is the proven Profile command and never reaches the Host', async () => {
  const h = setup({ status: { state: 'enabled' }, profile: 'work profile' })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /> Copy client command/mu)
  assert.match(h.view(), /dsh --profile 'work profile' acp stdio/u)
  const readsBefore = h.acp.reads
  await key(h, ENTER)
  await settle(h, 'the copied client command', frame => /Status\s+Client command copied/u.test(frame))
  assert.deepEqual(h.copied, ["dsh --profile 'work profile' acp stdio"])
  assert.equal(h.acp.reads, readsBefore, 'a Client-local copy performs no Host read')
  assert.deepEqual(h.acp.setEnabledCalls, [], 'a copy performs no Host write')
  assert.deepEqual(h.pref.writes, [], 'a copy performs no preference write')
  h.dispose()
})

test('without a proven Profile the page states the limitation and offers no Copy target', async () => {
  const h = setup({ status: { state: 'enabled' }, profile: undefined })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.doesNotMatch(h.view(), /Copy client command/u)
  assert.match(h.view(), /Client command unavailable · Profile identity not verified/u)
  await key(h, ENTER) // the enabled first focus is the ONE runtime action
  await settle(h, 'the staged disable confirmation', frame => frame.includes('Disable the local ACP listener?'))
  await key(h, '\x1b')
  assert.deepEqual(h.copied, [])
  h.dispose()
})

test('a Host replacement during the live preflight is a definitive zero-write Not changed', async () => {
  const h = setup({ status: { state: 'disabled' }, holdSecondAcpRead: true })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /> Enable ACP/mu)
  await key(h, ENTER) // Enable ACP: the live preflight read is held unresolved
  assert.match(h.view(), /Waiting for the answer…/u)
  // Host A is replaced by Host B while the preflight has NOT invoked a write.
  h.acp.status = { state: 'enabled' }
  h.bumpGeneration()
  await settle(h, 'the definitive pre-dispatch word', frame => /Status\s+Not changed/u.test(frame))
  assert.match(h.view(), /the Host changed before the request was sent/u)
  assert.doesNotMatch(h.view(), /Outcome unconfirmed/u)
  assert.deepEqual(h.acp.setEnabledCalls, [], 'no Host write was invoked before the preflight settled')
  h.releaseAcpReads()
  await settle(h, 'the replacement Host fact', frame => /Listener\s+Enabled/u.test(frame))
  assert.match(h.view(), /> Copy client command/mu, 'the replacement Host state owns the action')
  assert.deepEqual(h.acp.setEnabledCalls, [], 'the stale preflight reply never dispatches')
  h.dispose()
})

test('a Host generation change repaints the new Host fact and never reuses the old action', async () => {
  const h = setup({ status: { state: 'disabled' } })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /> Enable ACP/mu)
  // The Host is replaced while the page is open; the new Host's listener is ON.
  h.acp.status = { state: 'enabled' }
  h.bumpGeneration()
  await settle(h, 'the new Host fact', frame => /Listener\s+Enabled/u.test(frame))
  assert.deepEqual(h.acp.setEnabledCalls, [], 'the rollover itself writes nothing')
  assert.match(h.view(), /> Copy client command/mu, 'the new Host offers its own enabled-state action')
  h.dispose()
})

test('a /acp first frame without one real Detail row reports the command error and starts no read', async () => {
  const h = setup({ columns: 200, rows: 2, status: { state: 'disabled' } })
  const pending = h.invoke('acp') as Promise<{ readonly kind: string; readonly text?: string }>
  await settle(h, 'the closed refused lease', frame => !frame.includes('Settings ·'))
  const result = await pending
  assert.equal(result.kind, 'error', 'the command reports its real failure')
  assert.match(result.text ?? '', /could not open ACP access/u)
  assert.doesNotMatch(h.view(), /Settings ·/u, 'the failed lease is closed, never a silent Rows fallback')
  assert.equal(h.acp.reads, 0, 'no Host read starts without a real Detail grant')
  assert.equal(h.app.overlayGraphState().handles, 0)
  h.dispose()
})

test('a mounted preflight write can be left by the page Back and never invokes the Host', async () => {
  const h = setup({ status: { state: 'disabled' }, holdSecondAcpRead: true })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /> Enable ACP/u)
  await key(h, ENTER) // Enable ACP: the live preflight read is held
  await settle(h, 'the pending preflight', frame => frame.includes('Waiting for the answer…'))
  assert.equal(h.acp.reads, 2)
  await key(h, '\x1b') // the page's own explicit Back leaves the tenant
  await settle(h, 'the Host Rows level', frame => frame.includes('Settings · Host · Rows'))
  h.releaseAcpReads()
  await drain(h)
  assert.deepEqual(h.acp.setEnabledCalls, [], 'the retired preflight never invoked a Host mutation')
  assert.match(h.view(), /Settings · Host · Rows/u, 'the late preflight reply never revives the page')
  assert.doesNotMatch(h.view(), /Waiting for the answer…/u)
  h.dispose()
})

test('a mounted invoked write can be left by the page Back while its owner settles', async () => {
  const h = setup({ status: { state: 'disabled' }, holdAcpWrite: true })
  await openHostRows(h)
  await openAcpAccess(h)
  await key(h, ENTER) // Enable ACP: `setEnabled` is really invoked and held
  await settle(h, 'the pending invoked write', frame => frame.includes('Waiting for the answer…'))
  assert.deepEqual(h.acp.setEnabledCalls, [true], 'the real Host write was invoked exactly once')
  await key(h, '\x1b') // the page's documented pending exit
  await settle(h, 'the Host Rows level', frame => frame.includes('Settings · Host · Rows'))
  h.releaseAcpWrite()
  await drain(h)
  assert.match(h.view(), /Settings · Host · Rows/u, 'the late settlement never revives the page')
  assert.doesNotMatch(h.view(), /Waiting for the answer…/u)
  assert.deepEqual(h.acp.setEnabledCalls, [true], 'the dispatched write is never cancelled or replayed')
  h.dispose()
})

// ── SUX #885 SCF: the three scalar Config decisions on the SAME real queue ───

/** Open `/web` and stage its next-start On confirmation. */
async function stageWebPreferenceConfirm(h: Harness): Promise<void> {
  void h.invoke('web')
  await settle(h, 'the Web UI page', frame => /Settings · Host · Web UI/u.test(frame))
  await highlightRow(h, 'Start automatically')
  await key(h, ENTER) // candidates
  await key(h, ENTER) // stage On
  assert.match(h.view(), /Save the next Host start preference as On\?/u)
}

/** Open the Host Rows level and the Backend inline choice. */
async function openBackendChoice(h: Harness): Promise<void> {
  await openHostRows(h)
  await key(h, ENTER) // writable row -> L2 inline choice
  await settle(h, 'the Backend choice', frame => /Choose value/u.test(frame))
}

/** Open the Tools Rows level and the Visual tools inline choice. */
async function openVisualChoice(h: Harness): Promise<void> {
  h.invoke('settings')
  await settle(h, 'the Settings rail', frame => frame.includes('Settings ·'))
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER) // categories -> rows
  await key(h, ENTER) // writable row -> L2 inline choice
  await settle(h, 'the Visual tools choice', frame => /Choose value/u.test(frame))
}

const scalarCalls = (h: Harness, ns: string): number =>
  h.remote!.calls().filter(call => call.ns === ns).length

test('a queued Web next-start decision is fenced at the REAL Remote queue head', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await stageWebPreferenceConfirm(h)

  const entered = h.remote!.holdPredecessor()
  const predecessor = h.remote!.submitSibling()
  await entered
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER) // Confirm save: A is admitted and queued
  await forwarded
  assert.equal(scalarCalls(h, 'pi-tui-web-preferences'), 0, 'A is queued; no Web RPC yet')

  // B exposes the SAME revision and value; release the predecessor.
  h.remote!.advanceB(false, 7, { web: { autoStart: false, revision: 4 } })
  h.remote!.releasePredecessor()
  await predecessor
  assert.equal(h.remote!.siblingValue('A'), 9, 'the predecessor stayed on Host A')
  assert.equal(h.remote!.siblingValue('B'), 8, 'Host B received no queued A work')
  await settle(h, 'the Web queue-head refusal', frame => /Status\s+Not saved/u.test(frame))
  assert.equal(scalarCalls(h, 'pi-tui-web-preferences'), 0,
    'the old A intent dispatched ZERO Web mutations against B')
  assert.match(h.view(), /Start automatically\s+Off\b/u, 'B keeps its own Off value')

  // A fresh explicit B gesture is the only request that reaches B.
  await highlightRow(h, 'Start automatically')
  await key(h, ENTER)
  await key(h, ENTER)
  await key(h, ENTER)
  await settle(h, 'the fresh Web verification', frame => /Status\s+Verified/u.test(frame))
  assert.equal(scalarCalls(h, 'pi-tui-web-preferences'), 1, 'exactly ONE Web mutation, by the fresh B intent')
  const call = h.remote!.calls().find(entry => entry.ns === 'pi-tui-web-preferences')!
  assert.equal(call.revision, 4)
  assert.equal(call.destination, 'B')
  assert.equal(h.remote!.scalarForwarded().at(-1)!.generation, h.remote!.currentGeneration(),
    'the fresh request carried the CURRENT B authority identity')
  h.dispose()
})

test('a queued Backend decision is fenced at the REAL Remote queue head and records no follow-up', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await openBackendChoice(h)
  await key(h, DOWN) // Direct -> Daemon
  const entered = h.remote!.holdPredecessor()
  const predecessor = h.remote!.submitSibling()
  await entered
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER) // Confirm: A is admitted and queued
  await forwarded
  assert.equal(scalarCalls(h, 'tui-startup'), 0, 'A is queued; no startup RPC yet')

  h.remote!.advanceB(false, 7, { backend: { backend: 'direct', revision: 6 } })
  h.remote!.releasePredecessor()
  await predecessor
  assert.equal(h.remote!.siblingValue('A'), 9, 'the predecessor stayed on Host A')
  assert.equal(h.remote!.siblingValue('B'), 8, 'Host B received no queued A work')
  await settle(h, 'the Backend queue-head refusal', frame => /Status\s+Not saved/u.test(frame))
  assert.equal(scalarCalls(h, 'tui-startup'), 0, 'the old A intent dispatched ZERO startup mutations against B')
  assert.deepEqual(h.backendTransitions(), [], 'a refused A decision records no exit transition')
  assert.doesNotMatch(h.view(), /Install service|Not now/u, 'B matching A never earns the install follow-up')

  await key(h, ENTER) // fresh explicit Change against the current B row
  await key(h, DOWN)
  await key(h, ENTER)
  await settle(h, 'the fresh Backend verification', frame => /Status\s+Verified/u.test(frame))
  assert.equal(scalarCalls(h, 'tui-startup'), 1, 'exactly ONE startup mutation, by the fresh B intent')
  const call = h.remote!.calls().find(entry => entry.ns === 'tui-startup')!
  assert.equal(call.revision, 6)
  assert.equal(call.destination, 'B')
  assert.deepEqual(h.backendTransitions(), [undefined], 'the fresh verified direct→daemon clears the exit intent')

  // The verified transition offers its ONE follow-up; dismiss it (zero admin IO).
  await settle(h, 'the install follow-up', frame => /Optional OS supervision/u.test(frame))
  await key(h, '\x1b')
  await settle(h, 'the follow-up retirement', frame => !/Optional OS supervision/u.test(frame))

  // Confirming the CURRENT Daemon again is a verified no-op: no NEW follow-up
  // and no new transition intent.
  await key(h, ENTER)
  await key(h, ENTER)
  await settle(h, 'the same-value Backend verification', frame => /Status\s+Verified/u.test(frame))
  assert.doesNotMatch(h.view(), /Optional OS supervision|Install service|Not now/u,
    'a same-value save never repaints the follow-up')
  assert.deepEqual(h.backendTransitions(), [undefined], 'a same-value save records no new intent')

  // A fresh verified Daemon -> Direct records exactly ONE exit intent and
  // performs no Host stop.
  await key(h, ENTER)
  await key(h, '\x1b[A')
  await key(h, ENTER)
  await settle(h, 'the reverse Backend verification', frame => /Status\s+Verified/u.test(frame))
  assert.deepEqual(h.backendTransitions(), [undefined, 'daemon-to-direct'],
    'the fresh verified Daemon -> Direct records ONE exit intent')
  const mutations = h.remote!.calls().filter(entry => entry.ns === 'tui-startup')
  assert.equal(mutations.length, 3, 'three real B mutations: Daemon, same-value Daemon, Direct')
  assert.deepEqual(mutations.map(entry => entry.destination), ['B', 'B', 'B'])
  assert.deepEqual(mutations.at(-1)!.ops, [{ op: 'set', path: ['backend'], value: 'direct' }])
  h.dispose()
})

test('a queued Visual tools decision is fenced at the REAL Remote queue head', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await openVisualChoice(h)
  await key(h, DOWN) // On -> Off
  const entered = h.remote!.holdPredecessor()
  const predecessor = h.remote!.submitSibling()
  await entered
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  assert.equal(scalarCalls(h, 'pi-tui-visual-tools'), 0, 'A is queued; no visual-tools RPC yet')

  h.remote!.advanceB(false, 7, { visual: { enabled: true, revision: 3 } })
  h.remote!.releasePredecessor()
  await predecessor
  assert.equal(h.remote!.siblingValue('A'), 9, 'the predecessor stayed on Host A')
  assert.equal(h.remote!.siblingValue('B'), 8, 'Host B received no queued A work')
  await settle(h, 'the Visual tools queue-head refusal', frame => /Status\s+Not saved/u.test(frame))
  assert.equal(scalarCalls(h, 'pi-tui-visual-tools'), 0, 'the old A intent dispatched ZERO visual-tools mutations against B')

  await key(h, ENTER) // fresh explicit Change against the current B row
  await key(h, DOWN)
  await key(h, ENTER)
  await settle(h, 'the fresh Visual tools verification', frame => /Status\s+Verified/u.test(frame))
  assert.equal(scalarCalls(h, 'pi-tui-visual-tools'), 1, 'exactly ONE visual-tools mutation, by the fresh B intent')
  const call = h.remote!.calls().find(entry => entry.ns === 'pi-tui-visual-tools')!
  assert.equal(call.revision, 3)
  assert.equal(call.destination, 'B')
  h.dispose()
})

test('an accepted Web write whose readback belongs to B is Unverified, never Verified', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await stageWebPreferenceConfirm(h)

  const received = h.remote!.holdReceipt()
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER) // the real A mutation applies On and holds its receipt
  await forwarded
  await received
  h.remote!.advanceB(true, 7, { web: { autoStart: true, revision: 4 } })
  h.remote!.releaseReceipt()
  await settle(h, 'the cross-generation Web settlement', frame => /Status\s+Unverified/u.test(frame))
  assert.match(h.view(), /no current same-generation readback/u)
  assert.equal(scalarCalls(h, 'pi-tui-web-preferences'), 1, 'A is never replayed and B receives no implicit mutation')
  h.dispose()
})

test('an accepted Backend write whose readback belongs to B is Unverified and emits no transition', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await openBackendChoice(h)
  await key(h, DOWN)

  const received = h.remote!.holdReceipt()
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(false, 7, { backend: { backend: 'daemon', revision: 6 } })
  h.remote!.releaseReceipt()
  await settle(h, 'the cross-generation Backend settlement', frame => /Commit accepted · verification unavailable/u.test(frame))
  assert.deepEqual(h.backendTransitions(), [], 'B matching the request never records a transition intent')
  assert.doesNotMatch(h.view(), /Install service|Not now/u, 'B matching the request never earns the follow-up')
  assert.equal(scalarCalls(h, 'tui-startup'), 1, 'A is never replayed')
  h.dispose()
})

test('an accepted Visual tools write whose readback belongs to B is Unverified', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await openVisualChoice(h)
  await key(h, DOWN)

  const received = h.remote!.holdReceipt()
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(false, 7, { visual: { enabled: false, revision: 3 } })
  h.remote!.releaseReceipt()
  await settle(h, 'the cross-generation Visual tools settlement', frame => /Commit accepted · verification unavailable/u.test(frame))
  assert.equal(scalarCalls(h, 'pi-tui-visual-tools'), 1, 'A is never replayed')
  h.dispose()
})

test('an unknown Web receipt keeps B\'s own Off value and stays Outcome unconfirmed', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await stageWebPreferenceConfirm(h)
  const received = h.remote!.holdReceipt(true)
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  // B keeps the ORIGINAL Off value at the same revision: an old classifier
  // reading B's value would call this a refusal, but the receipt is unknown.
  h.remote!.advanceB(false, 7, { web: { autoStart: false, revision: 4 } })
  h.remote!.releaseReceipt()
  await settle(h, 'the unknown Web receipt', frame => /Status\s+Outcome unconfirmed/u.test(frame))
  assert.doesNotMatch(h.view(), /Status\s+Not saved/u)
  assert.doesNotMatch(h.view(), /Status\s+Verified/u)
  const calls = h.remote!.calls().filter(call => call.ns === 'pi-tui-web-preferences')
  assert.equal(calls.length, 1, 'exactly the A request, never replayed')
  assert.equal(calls[0]!.destination, 'A')
  assert.equal(calls[0]!.revision, 4)
  assert.deepEqual(calls[0]!.ops, [{ op: 'set', path: ['autoStart'], value: true }])
  h.dispose()
})

test('an unknown Backend receipt keeps B\'s own Direct value and stays Outcome unknown', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await openBackendChoice(h)
  await key(h, DOWN)
  const received = h.remote!.holdReceipt(true)
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(false, 7, { backend: { backend: 'direct', revision: 6 } })
  h.remote!.releaseReceipt()
  await settle(h, 'the unknown Backend receipt', frame => /Status\s+Outcome unknown/u.test(frame))
  assert.doesNotMatch(h.view(), /Status\s+Not saved/u)
  assert.doesNotMatch(h.view(), /Status\s+Verified/u)
  assert.deepEqual(h.backendTransitions(), [], 'an unknown outcome records no exit intent')
  const calls = h.remote!.calls().filter(call => call.ns === 'tui-startup')
  assert.equal(calls.length, 1, 'exactly the A request, never replayed')
  assert.equal(calls[0]!.destination, 'A')
  assert.equal(calls[0]!.revision, 6)
  assert.deepEqual(calls[0]!.ops, [{ op: 'set', path: ['backend'], value: 'daemon' }])
  h.dispose()
})

test('an unknown Visual tools receipt keeps B\'s own On value and stays Outcome unknown', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await openVisualChoice(h)
  await key(h, DOWN)
  const received = h.remote!.holdReceipt(true)
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(false, 7, { visual: { enabled: true, revision: 3 } })
  h.remote!.releaseReceipt()
  await settle(h, 'the unknown Visual tools receipt', frame => /Status\s+Outcome unknown/u.test(frame))
  assert.doesNotMatch(h.view(), /Status\s+Not saved/u)
  assert.doesNotMatch(h.view(), /Status\s+Verified/u)
  const calls = h.remote!.calls().filter(call => call.ns === 'pi-tui-visual-tools')
  assert.equal(calls.length, 1, 'exactly the A request, never replayed')
  assert.equal(calls[0]!.destination, 'A')
  assert.equal(calls[0]!.revision, 3)
  assert.deepEqual(calls[0]!.ops, [{ op: 'set', path: ['enabled'], value: false }])
  h.dispose()
})

test('a matching Host B never grants daemon→direct exit intent from an accepted A receipt', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true, remoteInitialBackend: 'daemon' })
  await h.remote!.ready
  await openBackendChoice(h)
  await key(h, UP) // Daemon -> Direct
  const received = h.remote!.holdReceipt()
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(false, 7, { backend: { backend: 'direct', revision: 6 } })
  h.remote!.releaseReceipt()
  await settle(h, 'the cross-generation daemon→direct settlement', frame => /Commit accepted · verification unavailable/u.test(frame))
  assert.deepEqual(h.backendTransitions(), [],
    'the matching B direct value never records a daemon-to-direct intent for the A request')
  assert.equal(scalarCalls(h, 'tui-startup'), 1, 'A is never replayed')
  h.dispose()
})

test('an accepted but unapplied write is Unverified on all three real scalar branches', async () => {
  const cases = [
    {
      ns: 'pi-tui-web-preferences',
      prepare: async (h: Harness) => { await stageWebPreferenceConfirm(h) },
      expected: /Status\s+Unverified/u,
    },
    {
      ns: 'tui-startup',
      prepare: async (h: Harness) => { await openBackendChoice(h); await key(h, DOWN) },
      expected: /Commit accepted · verification unavailable/u,
    },
    {
      ns: 'pi-tui-visual-tools',
      prepare: async (h: Harness) => { await openVisualChoice(h); await key(h, DOWN) },
      expected: /Commit accepted · verification unavailable/u,
    },
  ] as const
  for (const item of cases) {
    const h = setup({ columns: 200, rows: 44, remoteConfig: true })
    await h.remote!.ready
    await item.prepare(h)
    // The genuine accepted receipt, no Host replacement: the readback simply
    // still carries the base value.
    h.remote!.acceptWithoutApply()
    await key(h, ENTER)
    await settle(h, `the unapplied ${item.ns} settlement`, frame => item.expected.test(frame))
    assert.doesNotMatch(h.view(), /Status\s+Not saved/u, 'an accepted mismatch is never a refusal')
    assert.doesNotMatch(h.view(), /Status\s+Verified/u)
    const calls = h.remote!.calls().filter(call => call.ns === item.ns)
    assert.equal(calls.length, 1, 'one invocation on the same authority')
    assert.equal(calls[0]!.destination, 'A')
    if (item.ns === 'tui-startup') {
      assert.deepEqual(h.backendTransitions(), [], 'an unverified Backend save records no side effect')
    }
    h.dispose()
  }
})

test('a pending Web preference Back does not revive or replay after its late completion', async () => {
  const h = setup({ columns: 200, rows: 44, remoteConfig: true })
  await h.remote!.ready
  await stageWebPreferenceConfirm(h)

  const received = h.remote!.holdReceipt()
  const forwarded = h.remote!.nextForwarded()
  await key(h, ENTER)
  await forwarded
  await received
  h.remote!.advanceB(true, 7, { web: { autoStart: true, revision: 4 } })
  const write = h.remote!.lastWrite()
  assert.ok(write !== undefined)
  await key(h, '\x1b') // Back is allowed for a pending CONFIG write
  await settle(h, 'the Host Rows after Web Back', frame => /Settings · Host · Rows/u.test(frame))
  h.remote!.releaseReceipt()
  const late = await write
  assert.equal(late.kind, 'accepted', 'the late A receipt is known-accepted')
  await waitForFrame(
    () => h.diagnostics.join('\n'),
    text => /web ui preference write/u.test(text) && /outcome=unverified/u.test(text),
    () => h.vt.waitForRender(),
    'the retired Web page late-owner diagnostic',
  )
  assert.match(h.view(), /Settings · Host · Rows/u, 'Rows stays current after settlement')
  assert.doesNotMatch(h.view(), /Settings · Host · Web UI/u, 'the retired page never revives')
  assert.equal(h.remote!.calls().filter(call => call.ns === 'pi-tui-web-preferences').length, 1,
    'late completion neither replays A nor issues a B write')
  h.dispose()
})
