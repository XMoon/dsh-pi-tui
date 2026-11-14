/**
 * PO-1B — the two `/settings → Tools` ACP rows through the REAL `/settings`
 * composition on a `VirtualTerminal`.
 *
 * `ACP Server` is the RUNTIME row (live listener state via the `acpAccess`
 * port); `Auto-enable ACP on Host startup` is the PERSISTED next-launch
 * preference (via `config.acpStartupPreference`). The cases prove: the row
 * values come from the authorities; only a settled enabled/disabled offers a
 * confirmable candidate; a Confirm routes exactly ONE Host mutation and paints
 * Verified only after an agreeing authoritative re-read; Direct shows a
 * truthful Unavailable runtime row while the preference stays editable.
 *
 * FIXTURE: the real command registration + TuiApp + VirtualTerminal.
 * STAND-IN: the Host `acpAccess` port and the ConfigPort ACP preference.
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
  readonly view: () => string
  readonly invoke: () => unknown
  readonly acp: {
    status: AcpAccessStatus
    setEnabledCalls: boolean[]
    failure: string | undefined
    /** Throw BEFORE applying the reached state (a clean rejection / not-saved). */
    failBeforeApply: boolean
    /** Hold the dispatched write until released (a pending, unsettled operation). */
    gate: Promise<void> | undefined
    release: (() => void) | undefined
  }
  readonly pref: { state: AcpStartupPreferenceState | undefined; writes: boolean[]; failNext: string | undefined }
  readonly setReadiness: (readiness: 'ready' | 'stale' | 'unavailable') => void
  /** Simulate a Connection generation change (Host A -> Host B): replace the
   *  opaque generation identity and notify the generation subscribers. */
  readonly bumpGeneration: () => void
  readonly dispose: () => void
}

function setup(options: {
  readonly columns?: number
  readonly rows?: number
  readonly backendKind?: 'direct' | 'remote'
  readonly status?: AcpAccessStatus
  readonly acpUnavailable?: boolean
  readonly pref?: AcpStartupPreferenceState | undefined
  readonly readiness?: 'ready' | 'stale' | 'unavailable'
} = {}): Harness {
  const columns = options.columns ?? 200
  const rows = options.rows ?? 40
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
    failure: undefined as string | undefined,
    failBeforeApply: false,
    gate: undefined as Promise<void> | undefined,
    release: undefined as (() => void) | undefined,
  }
  const pref = {
    state: 'pref' in options ? options.pref : { autoStart: false, revision: 1, userOverridden: false },
    writes: [] as boolean[],
    failNext: undefined as string | undefined,
  }
  // The opaque Connection generation identity (object) the ACP observation binds
  // to; a reconnect (Host A -> Host B) replaces it and notifies subscribers.
  let generation: object | undefined = { id: 1 }
  const generationListeners = new Set<() => void>()
  const acpAccess: AcpAccessPort = {
    getStatus: async () => {
      if (options.acpUnavailable === true) throw new Error('the port is not mounted')
      return acp.status
    },
    setEnabled: async (enabled: boolean, expectedGeneration?: unknown) => {
      if (expectedGeneration !== undefined && !Object.is(generation, expectedGeneration)) {
        throw new Error('superseded: the Host generation changed before dispatch')
      }
      acp.setEnabledCalls.push(enabled)
      if (acp.gate !== undefined) await acp.gate
      if (acp.failBeforeApply) throw new Error('rejected before apply')
      // Apply the reached state BEFORE any fault, so a "dispatched but reply
      // lost" fault models an INDETERMINATE outcome (the reread shows the
      // target while the call still threw), distinct from a clean rejection.
      acp.status = enabled ? { state: 'enabled' } : { state: 'disabled' }
      if (acp.failure !== undefined) {
        const reason = acp.failure
        acp.failure = undefined
        throw new Error(reason)
      }
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
    acpAccess,
    config: settingsDirectPageConfig({
      configReadiness: () => readiness,
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      credentials: { available: () => true, describeReference: async () => ({ configured: true, source: 'file' }) },
      web: { available: () => false },
      acpStartupPreference: {
        read: () => pref.state,
        setAutoStart: async (value: boolean) => {
          pref.writes.push(value)
          if (pref.failNext !== undefined) {
            const reason = pref.failNext
            pref.failNext = undefined
            throw new Error(reason)
          }
          if (pref.state !== undefined) pref.state = { ...pref.state, autoStart: value, userOverridden: true }
        },
      },
    }),
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (): unknown => {
    const definition = defs.find(candidate => candidate.name === 'settings')
    assert.ok(definition?.handler !== undefined, '/settings must be registered')
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/gu, '')).join('\n')
  return {
    vt,
    view,
    invoke,
    acp,
    pref,
    setReadiness: next => { readiness = next },
    bumpGeneration: () => {
      generation = { id: ((generation as { id?: number } | undefined)?.id ?? 0) + 1 }
      for (const listener of [...generationListeners]) listener()
    },
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

/** Open the Tools rows level and settle the async ACP runtime row. */
async function openTools(h: Harness): Promise<void> {
  h.invoke()
  await settle(h, 'the Settings rail', frame => frame.includes('Settings ·'))
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER)
  // The ACP runtime row starts at Loading… then settles from the port read.
  await settle(h, 'the ACP runtime row to settle', frame => frame.includes('ACP Server') && !frame.includes('Loading…'))
}

/** Move the Tools cursor onto a row whose label matches, then assert it is selected. */
async function highlightRow(h: Harness, label: string): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    if (new RegExp(`> ${label}`, 'u').test(h.view())) return
    await key(h, DOWN)
  }
  assert.fail(`the "${label}" row never owned the selection:\n${h.view()}`)
}

test('the ACP Server row reflects the live listener state and toggles through ONE Host write', async () => {
  const h = setup({ status: { state: 'disabled' } })
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    assert.match(h.view(), /ACP Server/u)
    await key(h, ENTER) // L1 writable -> L2 inline choice
    await settle(h, 'the ACP Server choice', frame => frame.includes('Choose value'))
    assert.match(h.view(), /> Off/u, 'the current candidate is Off (the Host is disabled)')
    await key(h, UP) // Off -> On
    assert.match(h.view(), /> On/u)
    assert.equal(h.acp.setEnabledCalls.length, 0, 'choosing never writes')
    await key(h, ENTER)
    await settle(h, 'the ACP toggle verdict', frame => frame.includes('Verified'))
    assert.deepEqual(h.acp.setEnabledCalls, [true], 'exactly ONE setEnabled(true) reached the Host')
    assert.match(h.view(), /Verified/u, 'an agreeing re-read is Verified')
  } finally {
    h.dispose()
  }
})

test('an enabled listener shows On and toggles Off', async () => {
  const h = setup({ status: { state: 'enabled' } })
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    await key(h, ENTER)
    await settle(h, 'the enabled choice', frame => frame.includes('Choose value'))
    assert.match(h.view(), /> On/u, 'the enabled listener is the On candidate')
    await key(h, DOWN) // On -> Off
    await key(h, ENTER)
    await settle(h, 'the disable verdict', frame => frame.includes('Verified'))
    assert.deepEqual(h.acp.setEnabledCalls, [false])
  } finally {
    h.dispose()
  }
})

test('a Direct backend paints the runtime row Unavailable — Split Host only with no candidate', async () => {
  const h = setup({ backendKind: 'direct', status: { state: 'unavailable', reason: 'The local ACP listener is available only in a Split Host.' } })
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    assert.match(h.view(), /Unavailable — Split Host only/u, `the Direct runtime row states the real gap:\n${h.view()}`)
    await key(h, ENTER)
    assert.doesNotMatch(h.view(), /Choose value/u, 'no candidate exists on Direct')
    assert.equal(h.acp.setEnabledCalls.length, 0)
  } finally {
    h.dispose()
  }
})

test('the Auto-enable ACP row shows the schema default and writes On through the ConfigPort', async () => {
  const h = setup()
  try {
    await openTools(h)
    await highlightRow(h, 'Auto-enable ACP on Host startup')
    assert.match(h.view(), /Off \(default\)/u, 'the default OFF is marked as not user-overridden')
    assert.match(h.view(), /the current ACP listener is unchanged/u,
      'the row states the next-launch lifetime')
    await key(h, ENTER)
    await settle(h, 'the ACP autostart choice', frame => frame.includes('Choose value'))
    await key(h, UP) // Off -> On
    await key(h, ENTER)
    await settle(h, 'the ACP autostart verdict', frame => frame.includes('Verified'))
    assert.deepEqual(h.pref.writes, [true], 'exactly one preference write reached the ConfigPort')
    assert.equal(h.acp.setEnabledCalls.length, 0, 'the preference write never toggles the runtime listener')
  } finally {
    h.dispose()
  }
})

test('a changing listener shows Changing… and offers no confirmable candidate', async () => {
  const h = setup({ status: { state: 'changing' } })
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    assert.match(h.view(), /Changing…/u, 'an in-flight transition is stated, not a fabricated On/Off')
    await key(h, ENTER)
    assert.doesNotMatch(h.view(), /Choose value/u, 'a changing listener offers no second Confirm')
    assert.equal(h.acp.setEnabledCalls.length, 0)
  } finally {
    h.dispose()
  }
})

test('a dispatched toggle whose reply is lost stays indeterminate and is never replayed', async () => {
  const h = setup({ status: { state: 'disabled' } })
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    await key(h, ENTER)
    await settle(h, 'the ACP choice', frame => frame.includes('Choose value'))
    await key(h, UP) // Off -> On
    h.acp.failure = 'connection lost after dispatch'
    await key(h, ENTER)
    await settle(h, 'the indeterminate verdict', frame => frame.includes('Outcome unknown'))
    assert.deepEqual(h.acp.setEnabledCalls, [true], 'the write was dispatched exactly once and never replayed')
    assert.equal(h.acp.status.state, 'enabled', 'the reread shows the reached state while the outcome stays unprovable')
  } finally {
    h.dispose()
  }
})

test('the refresh key re-reads the ACP runtime state from the Host', async () => {
  const h = setup({ status: { state: 'disabled' } })
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    assert.match(h.view(), /> ACP Server\s+Off\b/u, 'the row starts on the Host\'s Off state')
    // Another Client enables the listener on the Host while this page is open.
    h.acp.status = { state: 'enabled' }
    await key(h, 'r')
    await settle(h, 'the ACP row to reflect a fresh read', frame => /> ACP Server\s+On\b/u.test(frame))
    assert.equal(h.acp.setEnabledCalls.length, 0, 'r is read-only and never toggles the listener')
  } finally {
    h.dispose()
  }
})

test('a stale Host is never presented as the current ACP listener state', async () => {
  const h = setup({ status: { state: 'enabled' } })
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    assert.match(h.view(), /> ACP Server\s+On\b/u, 'the current Host state is shown')
    // The Host disconnects; the configuration plane goes stale.
    h.setReadiness('stale')
    await key(h, 'r') // re-reads/re-paints through the one ACP read owner
    await settle(h, 'the stale row to stop claiming On', frame => /Checking…/u.test(frame))
    assert.doesNotMatch(h.view(), /> ACP Server\s+On\b/u, 'a stale Host must not present a cached On as the current fact')
    await key(h, ENTER)
    assert.doesNotMatch(h.view(), /Choose value/u, 'a stale Host offers no confirmable candidate')
    assert.equal(h.acp.setEnabledCalls.length, 0)
  } finally {
    h.dispose()
  }
})

test('a reconnect to a DIFFERENT Host revokes the prior ACP state without a key press', async () => {
  const h = setup({ status: { state: 'enabled' } }) // Host A: ACP On
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    assert.match(h.view(), /> ACP Server\s+On\b/u, 'Host A shows its real On state')
    // Host A drops (config goes stale), then a DIFFERENT Host B reconnects and is
    // ready with ACP Off. The generation changes and notifies subscribers — the
    // real reconnect path — WITHOUT the user pressing `r`.
    h.setReadiness('stale')
    h.acp.status = { state: 'disabled' }
    h.setReadiness('ready')
    h.bumpGeneration()
    await settle(h, 'the row to reflect Host B without r', frame => /> ACP Server\s+Off\b/u.test(frame))
    assert.doesNotMatch(h.view(), /> ACP Server\s+On\b/u,
      'the previous Host A On must never be revived as Host B\'s current fact')
    assert.equal(h.acp.setEnabledCalls.length, 0, 'the generation-change repaint is a READ, never a write')
  } finally {
    h.dispose()
  }
})

test('an OPEN ACP choice is revoked on a Host generation change and cannot write to the new Host', async () => {
  const h = setup({ status: { state: 'enabled' } }) // Host A: ACP On
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    await key(h, ENTER) // open the inline choice (current On)
    await settle(h, 'the ACP choice to open', frame => frame.includes('Choose value'))
    await key(h, DOWN) // On -> Off: the user's PENDING selection, not yet confirmed
    assert.equal(h.acp.setEnabledCalls.length, 0, 'choosing a candidate never writes')
    // Host A -> Host B (also On); the Connection generation changes and notifies.
    h.setReadiness('stale')
    h.acp.status = { state: 'enabled' }
    h.setReadiness('ready')
    h.bumpGeneration()
    // The stale choosing phase must be REVOKED (not merely re-painted).
    await settle(h, 'the stale choice to be revoked', frame => !frame.includes('Choose value'))
    // The old Enter must NOT dispatch the stale Off to Host B.
    await key(h, ENTER)
    await h.vt.waitForRender()
    assert.equal(h.acp.setEnabledCalls.length, 0,
      'the old Host-A Off selection must never be written to Host B')
  } finally {
    h.dispose()
  }
})

test('a settled not-saved ACP retry is revoked on generation change (no cross-Host write)', async () => {
  const h = setup({ status: { state: 'enabled' } }) // Host A: ACP On
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    await key(h, ENTER)
    await settle(h, 'the ACP choice to open', frame => frame.includes('Choose value'))
    await key(h, DOWN) // On -> Off
    h.acp.failBeforeApply = true // a clean rejection (nothing applied) -> Not saved
    await key(h, ENTER)
    await settle(h, 'the not-saved verdict', frame => /Not saved/u.test(frame))
    // Host A -> Host B (also On). The settled Retry must be revoked.
    h.acp.failBeforeApply = false
    h.setReadiness('stale')
    h.acp.status = { state: 'enabled' }
    h.setReadiness('ready')
    h.bumpGeneration()
    await settle(h, 'the stale not-saved retry to be revoked', frame => !/Not saved|Retry save/u.test(frame))
    const before = h.acp.setEnabledCalls.length
    await key(h, ENTER)
    await h.vt.waitForRender()
    assert.equal(h.acp.setEnabledCalls.length, before, 'the old Host-A retry must never be written to Host B')
  } finally {
    h.dispose()
  }
})

test('a pending ACP write that settles after a generation change leaves no cross-Host retry', async () => {
  const h = setup({ status: { state: 'enabled' } }) // Host A: ACP On
  try {
    await openTools(h)
    await highlightRow(h, 'ACP Server')
    await key(h, ENTER)
    await settle(h, 'the ACP choice to open', frame => frame.includes('Choose value'))
    await key(h, DOWN) // On -> Off
    let releaseGate: (() => void) | undefined
    h.acp.gate = new Promise<void>(resolve => { releaseGate = resolve })
    h.acp.failBeforeApply = true // after release the dispatched write rejects (not-saved)
    await key(h, ENTER) // dispatch -> pending (setEnabled awaits the gate)
    // Host A -> Host B (also On) WHILE the write is still pending.
    h.setReadiness('stale')
    h.acp.status = { state: 'enabled' }
    h.setReadiness('ready')
    h.bumpGeneration()
    // Release the pending old-Host write; its late settlement must be inert.
    h.acp.gate = undefined
    releaseGate?.()
    await h.vt.waitForRender()
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    await h.vt.waitForRender()
    assert.doesNotMatch(h.view(), /Retry save|Not saved/u, 'a cross-generation pending settlement must not create a retry')
    const before = h.acp.setEnabledCalls.length
    await key(h, ENTER)
    await h.vt.waitForRender()
    assert.equal(h.acp.setEnabledCalls.length, before, 'no additional write to Host B after the stale pending settlement')
  } finally {
    h.dispose()
  }
})

test('an unreadable ACP preference offers no confirmable candidate', async () => {
  const h = setup({ pref: undefined })
  try {
    await openTools(h)
    await highlightRow(h, 'Auto-enable ACP on Host startup')
    assert.match(h.view(), /Unavailable/u, 'an absent section is reported, never the schema default')
    await key(h, ENTER)
    assert.doesNotMatch(h.view(), /Choose value/u)
    assert.equal(h.pref.writes.length, 0)
  } finally {
    h.dispose()
  }
})
