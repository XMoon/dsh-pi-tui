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
import type { AcpStartupPreferenceState, TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { unconfiguredPolicyObservation } from '../support/session-policy-fake.ts'

const DOWN = '\x1b[B'
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
    setEnabledCalls: boolean[]
    setEnabledGenerations: unknown[]
    gate: Promise<void> | undefined
    release: (() => void) | undefined
  }
  readonly pref: {
    state: AcpStartupPreferenceState | undefined
    writes: boolean[]
    revisions: number[]
    failNext: string | undefined
  }
  readonly copied: string[]
  readonly setReadiness: (readiness: 'ready' | 'stale' | 'unavailable') => void
  /** Simulate a Connection generation change (Host A -> Host B). */
  readonly bumpGeneration: () => void
  /** Release every held status read (the preflight and the new Host's read). */
  readonly releaseAcpReads: () => void
  readonly dispose: () => void
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
  const pref = {
    state: 'pref' in options ? options.pref : { autoStart: false, revision: 1, userOverridden: false },
    writes: [] as boolean[],
    revisions: [] as number[],
    failNext: undefined as string | undefined,
  }
  const copied: string[] = []
  // The opaque Connection generation identity (object) the ACP observation binds
  // to; a reconnect (Host A -> Host B) replaces it and notifies subscribers.
  let generation: object | undefined = { id: 1 }
  const generationListeners = new Set<() => void>()
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
      if (acp.gate !== undefined) await acp.gate
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
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
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
    config: settingsDirectPageConfig({
      configReadiness: () => readiness,
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
      acpStartupPreference: {
        read: () => pref.state,
        setAutoStart: async (value: boolean, revision: number) => {
          pref.writes.push(value)
          pref.revisions.push(revision)
          if (pref.failNext !== undefined) {
            const reason = pref.failNext
            pref.failNext = undefined
            throw new Error(reason)
          }
          if (pref.state !== undefined) pref.state = { autoStart: value, revision: revision + 1, userOverridden: true }
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
      for (const listener of [...generationListeners]) listener()
    },
    releaseAcpReads: () => { acp.releaseRead?.(); acp.releaseRead = undefined },
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
  assert.match(h.view(), /^> Enable ACP/mu, 'the disabled Host offers its ONE runtime action')
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
  assert.match(h.view(), /^> Disable ACP…/mu)
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

test('the Copy action is the proven Profile command and never reaches the Host', async () => {
  const h = setup({ status: { state: 'enabled' }, profile: 'work profile' })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /^> Copy client command/mu)
  assert.match(h.view(), /dsh --profile 'work profile' acp stdio/u)
  await key(h, ENTER)
  await settle(h, 'the copied client command', frame => /Status\s+Client command copied/u.test(frame))
  assert.deepEqual(h.copied, ["dsh --profile 'work profile' acp stdio"])
  assert.deepEqual(h.acp.setEnabledCalls, [])
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
  assert.match(h.view(), /^> Enable ACP/mu)
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
  assert.match(h.view(), /^> Copy client command/mu, 'the replacement Host state owns the action')
  assert.deepEqual(h.acp.setEnabledCalls, [], 'the stale preflight reply never dispatches')
  h.dispose()
})

test('a Host generation change repaints the new Host fact and never reuses the old action', async () => {
  const h = setup({ status: { state: 'disabled' } })
  await openHostRows(h)
  await openAcpAccess(h)
  assert.match(h.view(), /^> Enable ACP/mu)
  // The Host is replaced while the page is open; the new Host's listener is ON.
  h.acp.status = { state: 'enabled' }
  h.bumpGeneration()
  await settle(h, 'the new Host fact', frame => /Listener\s+Enabled/u.test(frame))
  assert.deepEqual(h.acp.setEnabledCalls, [], 'the rollover itself writes nothing')
  assert.match(h.view(), /^> Copy client command/mu, 'the new Host offers its own enabled-state action')
  h.dispose()
})
