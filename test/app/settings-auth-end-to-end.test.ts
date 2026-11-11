/**
 * Phase 3C / C2-MA — end-to-end through the REAL command coordinator and the
 * REAL Settings workspace lease: `/login` / `/logout` deeplinks open the
 * Models/Account direct pages, the category rail survives, and mouse
 * press/release resolves through the page's last-painted hit map.
 *
 * Only the external Host-ish seams are faked (the ConfigPort sub-domains and
 * the credential store answers); the command registration, workspace lease,
 * page construction, rendering and input routing are production.
 *
 * @module @xmoon76/dsh-pi-tui/settings-auth-end-to-end.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../../src/tui-app.ts'
import type { AccountObservation, AccountObservationLease, AccountView, AuthorizationFlowTarget, CredentialProviderOption } from '../../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    try { if (!app.isDisposed()) app.dispose() } catch {}
  }
})

const OPTIONS: readonly CredentialProviderOption[] = [
  { route: 'deepseek-official', label: 'deepseek official', ref: 'DEEPSEEK_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: false },
  { route: 'acme', label: 'Acme Gateway', ref: 'ACME_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: true },
  { route: 'anthropic', label: 'Anthropic', ref: 'ANTHROPIC_API_KEY', configured: true, declared: false, namesCredential: false, group: 'configured', canProvisionProfile: true },
]

const FLOWS: readonly AuthorizationFlowTarget[] = [
  { kind: 'authorization', key: 'llm-pi-ai/anthropic', route: 'anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  { kind: 'authorization', key: 'deepseek-account-platform/default', label: 'DeepSeek', methods: [{ id: 'browser', label: 'DeepSeek' }], inFlight: false },
  { kind: 'authorization', route: 'mykey', key: 'plugin/mykey', label: 'My Key', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  { kind: 'authorization', route: 'deepseek-official', key: 'llm-pi-ai/deepseek-official', label: 'Official OAuth', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
]

const SIGNED_OUT: AccountView = {
  status: 'signed-out',
  links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' },
  attempt: null,
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly calls: readonly string[]
  readonly holdNextSetReference: () => () => void
  /** The Host account state the Account page reads. */
  readonly setAccountView: (view: AccountView) => void
  /** Hold the NEXT Account sign-in open, like a Host that has not answered. */
  readonly holdNextStartSignIn: () => () => void
  /** The terminal-write count when each catalog read started. */
  readonly catalogReadWrites: number[]
  /** The terminal-write count when each provider-option read started (the
   *  synchronous provider scan inside the stored-credential read). */
  readonly credentialListWrites: number[]
  /** Replace the stored-record rows the fake credentials report. */
  readonly setRecordRows: (rows: readonly { key: string; label: string; kind: 'grant' }[]) => void
  readonly view: () => string
  readonly rows: () => string[]
  /** The exact secrets the UI handed to the official store (fixture-only). */
  readonly writtenSecrets: readonly { ref: string; secret: string }[]
  /** Seed the fake official store's configured state for one reference. */
  readonly setConfigured: (ref: string, configured: boolean) => void
  readonly close: () => void
}

function open(width = 120, height = 40, authorizationOverride?: unknown): Harness {
  const vt = new VirtualTerminal(width, height)
  const owned: OwnedRunner = (_label, task, options) => {
    void Promise.resolve().then(() => task()).then(
      result => options.onResult?.(result),
      error => options.onError?.(error),
    )
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const app = new TuiApp(vt, events, { copySelection: async () => true })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const accountState: { view: AccountView } = { view: SIGNED_OUT }
  const currentAccountLeases = new Set<AccountObservationLease>()
  const accountObservation = (view = accountState.view, lease = {} as AccountObservationLease): AccountObservation => {
    currentAccountLeases.add(lease)
    return { view, lease }
  }
  const calls: string[] = []
  /** The references the fake official store really reports as configured. */
  const configuredRefs = new Set(['DEEPSEEK_API_KEY', 'ACME_API_KEY', 'ANTHROPIC_API_KEY'])
  /** The exact secret the UI handed to setReference (fixture-only; never painted). */
  const writtenSecrets: { ref: string; secret: string }[] = []
  let recordRows: { key: string; label: string; kind: 'grant' }[] = [
    { key: 'plugin/mykey', label: 'My Key', kind: 'grant' },
  ]
  let setReferenceGate: Promise<void> | undefined
  let releaseSetReference: (() => void) | undefined
  let signInGate: Promise<void> | undefined
  let releaseSignIn: (() => void) | undefined
  /** The terminal-write count when each Host read starts: the paint-order
   *  tests assert that the frame carrying the read's Loading/Reading state
   *  was already written (never a setTimeout guess at the frame throttle). */
  const catalogReadWrites: number[] = []
  const credentialListWrites: number[] = []
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    // C2-R2: the completion controller's read-only facts. This composition's
    // Settings rows read them back; /settings itself stays the same surface.
    currentNotificationMode: () => 'unfocused' as const,
    currentNotificationMethod: () => 'auto' as const,
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    // C3 About seams (no StatusRuntime in this stub; sessionless capture).
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => app.displayPreset() === 'focus',
    setDisplayPreset: (preset: string) => ({ kind: 'unchanged', preset }),
    refreshStatus: () => {},
    copyToClipboard: async () => true,
    tuiSettings: {
      get: () => ({
        theme: 'dark', iconStyle: 'symbols', footer: 'default', fullscreen: 'off', busyEnter: 'queue',
        localShellSandbox: 'off', homeEndKeys: 'default', notificationMode: 'unfocused',
        notificationMethod: 'auto', terminalProgress: '9;4+7501', wheelScrollLines: '1',
      }),
      replace: () => {},
    },
    extensions: undefined,
    createPluginManagerPage: () => undefined,
    config: {
      configReadiness: () => 'ready',
      visualTools: {
        read: () => ({ enabled: true, revision: 1, userOverridden: false, applied: true }),
        setEnabled: async (_enabled: boolean, _revision: number) => {},
      },
      webStartupPreference: {
        read: () => ({ autoStart: false, revision: 1, userOverridden: false }),
        setAutoStart: async (_value: boolean, _revision: number) => {},
      },
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      // C2-R4: the Tools Web page is mountable for the credential deeplink case.
      web: {
        available: () => true,
        read: async () => ({
          searchProvider: 'deepseek-official',
          fetchProvider: 'http',
          api: { baseURL: 'https://api.deepseek.com/v1/tools', count: 10, sendOriginalQuestion: true },
          credential: configuredRefs.has('DEEPSEEK_API_KEY')
            ? { configured: true, source: 'file' }
            : { configured: false },
        }),
      },
      providers: {
        available: () => true,
        listCredentialOptions: () => {
          credentialListWrites.push(vt.writes.length)
          return OPTIONS
        },
        readCatalog: () => {
          catalogReadWrites.push(vt.writes.length)
          return {
            options: OPTIONS,
            profiles: OPTIONS.map(option => (option.route === 'acme'
              ? { route: option.route, configured: true, displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://acme.example/v1', models: ['acme-1'] }
              : { route: option.route, configured: true, displayName: option.route, models: [] })),
          }
        },
        readProfile: (route: string) => route === 'acme'
          ? { route, configured: true, displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://acme.example/v1', models: ['acme-1'] }
          : { route, configured: true, displayName: route, models: [] },
        configGuide: () => ({ profilePatchPath: '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml' }),
        writeProfile: async () => {},
        writeKeylessProfile: async () => ({ kind: 'written' as const }),
      },
      credentials: {
        available: () => true,
        recordsSupported: () => true,
        setReference: async (ref: string, secret: string) => {
          calls.push(`set:${ref}`)
          writtenSecrets.push({ ref, secret })
          const gate = setReferenceGate
          setReferenceGate = undefined
          await gate
          configuredRefs.add(ref)
        },
        unsetReference: async (ref: string) => {
          calls.push(`unset:${ref}`)
          configuredRefs.delete(ref)
        },
        deleteRecord: async (key: string) => {
          calls.push(`delete:${key}`)
          recordRows = recordRows.filter(record => record.key !== key)
        },
        describeReference: async (ref: string) => configuredRefs.has(ref)
          ? { configured: true, source: 'file' }
          : { configured: false },
        listRecords: async () => recordRows.map(record => ({ ...record })),
        onChanged: () => () => {},
      },
      authorization: authorizationOverride ?? {
        available: () => true,
        listTargets: () => FLOWS,
        begin: async () => ({ kind: 'unavailable' as const }),
        onEvent: () => () => {},
        respond: async () => {},
        cancel: async () => {},
      },
      account: {
        available: () => true,
        isObservationCurrent: (lease: AccountObservationLease) => currentAccountLeases.has(lease),
        getState: async () => accountObservation(),
        // The Account watch subscription count: a category the user only
        // browsed must never start one.
        watch: async function* (signal: AbortSignal) {
          calls.push('account:watch')
          const lease = {} as AccountObservationLease
          try {
            yield { kind: 'current' as const, observation: accountObservation(accountState.view, lease) }
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          } finally {
            currentAccountLeases.delete(lease)
          }
        },
        getProfile: async (_lease: AccountObservationLease) => null,
        getBalance: async (_lease: AccountObservationLease) => null,
        getCallbackOrigin: () => 'http://127.0.0.1:43121',
        startSignIn: async (_client: unknown, lease: AccountObservationLease) => {
          calls.push('startSignIn')
          const gate = signInGate
          signInGate = undefined
          await gate
          return accountObservation(accountState.view, lease)
        },
        cancelSignIn: async (_id: string, lease: AccountObservationLease) => accountObservation(accountState.view, lease),
        signOut: async (_client: unknown, lease: AccountObservationLease) => {
          calls.push('signOut')
          return accountObservation(accountState.view, lease)
        },
        hasRunningAccountTasks: async (_lease: AccountObservationLease) => {
          calls.push('hasRunningAccountTasks')
          return false
        },
      },
    },
    catalog: { models: { available: () => true, discoverModels: async () => [{ id: 'acme-1' }] } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (line: string): unknown => {
    const [name, ...rest] = line.replace(/^\//u, '').split(/\s+/u)
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: rest.join(' ') })
  }
  const rows = (): string[] => vt.getViewport().map(stripTerminalSequences)
  return {
    vt,
    app,
    calls,
    catalogReadWrites,
    credentialListWrites,
    setAccountView: (view: AccountView) => { accountState.view = view },
    setRecordRows: (next: readonly { key: string; label: string; kind: 'grant' }[]) => {
      recordRows = next.map(record => ({ ...record }))
    },
    holdNextStartSignIn: () => {
      signInGate = new Promise<void>(resolve => { releaseSignIn = resolve })
      return () => { releaseSignIn?.() }
    },
    holdNextSetReference: () => {
      setReferenceGate = new Promise<void>(resolve => { releaseSetReference = resolve })
      return () => { releaseSetReference?.() }
    },
    rows,
    writtenSecrets,
    setConfigured: (ref: string, configured: boolean) => {
      if (configured) configuredRefs.add(ref)
      else configuredRefs.delete(ref)
    },
    view: () => rows().join('\n'),
    close: () => {
      startedApps.delete(app)
      if (!app.isDisposed()) app.dispose()
    },
    // The invoke helper is exposed through the returned object below.
    ...( { invoke } as object),
  } as unknown as Harness & { invoke: (line: string) => unknown }
}

/** Wait for a stable Host-side fact (the fake records every credential write
 *  before awaiting the held gate). This is a state barrier, not a fixed sleep:
 *  a painted frame alone does not prove the pending mutation started. */
async function waitForCall(
  h: Harness,
  predicate: (call: string) => boolean,
  label: string,
): Promise<void> {
  const started = Date.now()
  while (!h.calls.some(predicate)) {
    if (Date.now() - started > 5_000) assert.fail(`${label}; calls: ${h.calls.join(', ')}`)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

const rowOf = (h: Harness, needle: string): number => {
  const row = h.rows().findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the frame must contain ${JSON.stringify(needle)}:\n${h.view()}`)
  return row
}
const colOf = (h: Harness, row: number, needle: string): number => {
  const line = h.rows()[row]!
  return visibleWidth(line.slice(0, line.indexOf(needle)))
}
const press = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`) }
const release = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`) }
const click = async (h: Harness, row: number, col: number): Promise<void> => {
  h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
  await h.vt.waitForRender()
  h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
  await h.vt.waitForRender()
}
const key = async (h: Harness, data: string): Promise<void> => {
  h.vt.sendInput(data)
  await h.vt.waitForRender()
}

/**
 * Wait for one painted stage of the held `/login` write.
 *
 * A key that a fence drops (not holds) is lost for good, so every Enter below
 * is sent only after the frame proves the action it needs is really on screen.
 */
async function waitForHeldWriteStage(
  h: Harness,
  predicate: (frame: string) => boolean,
  stage: string,
): Promise<void> {
  try {
    await waitForFrame(h.view, predicate, () => h.vt.waitForRender(), stage)
  } catch (error) {
    throw new Error(`${(error as Error).message}\ncalls: ${h.calls.join(', ')}`)
  }
}

/**
 * Drive `/login deepseek-official` from its real painted reference page to the
 * Host writer entry: the actionable Configure action, the masked form, the
 * typed mask, the review page and the final submit are each gated on the frame
 * that grants the next key, and the Host call is the positive witness that the
 * submit was accepted. The held gate then keeps the Host write in flight.
 */
async function submitHeldOfficialKey(h: Harness): Promise<void> {
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  await waitForHeldWriteStage(
    h,
    frame => /Stored\s+(?:Configured|Not set)/u.test(frame) && frame.includes('> Configure API Key…'),
    'the official reference page with an actionable Configure API Key',
  )
  await key(h, '\r') // open the masked form
  await waitForHeldWriteStage(
    h,
    frame => frame.includes('Enter the API key') && frame.includes('Enter continue'),
    'the masked API-key form with its Enter continue grant',
  )
  // Type through the real editor one key at a time (the same route the other
  // masked-form cases use): a single multi-character chunk is not how a user
  // types a secret, and the mask must follow the editor's own value.
  for (const character of 'sk-held') await key(h, character)
  await waitForHeldWriteStage(
    h,
    frame => /•{7}/u.test(frame) && !frame.includes('sk-held'),
    'the masked field painting the typed key without exposing it',
  )
  await key(h, '\r') // review
  await waitForHeldWriteStage(
    h,
    frame => frame.includes('Review your answer before submit') && frame.includes('↵ submit')
      && !frame.includes('sk-held'),
    'the review page with its submit command',
  )
  await key(h, '\r') // submit
  // A painted frame alone does not prove the pending mutation started: the fake
  // records the call BEFORE it awaits the held gate, so this is the Host write's
  // real entry point for THIS reference.
  await waitForCall(h, call => call === 'set:DEEPSEEK_API_KEY',
    'the held API-key write must start before the rail click')
  await waitForHeldWriteStage(
    h,
    frame => frame.includes('saving — the Host has not confirmed yet'),
    'the reference page reporting the pending Host write',
  )
}

test('/login acme deeplinks to the provider detail inside the Settings lease', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login acme')
  // The Models page reads its provider catalog after its first frame, so the
  // deep link paints the Loading state first and the detail after the read.
  // (The Loading frame itself is asserted deterministically in the page-level
  // suite: the app harness only ever holds the latest painted frame.)
  await waitForFrame(h.view, frame => /Provider · Acme Gateway/u.test(frame), () => h.vt.waitForRender(), 'the /login deeplink must reach the provider detail')
  assert.match(h.rows()[0]!, /Settings · Models/u)
  assert.match(h.view(), /Provider · Acme Gateway/u)
  assert.match(h.view(), /https:\/\/acme\.example\/v1/u)
  h.close()

  const add = open()
  await add.vt.waitForRender()
  ;(add as unknown as { invoke(line: string): unknown }).invoke('/login new-route')
  await add.vt.waitForRender()
  assert.match(add.rows()[0]!, /Settings · Models/u)
  assert.match(add.view(), /Add Provider/u)
  assert.match(add.view(), /new-route/u)
  add.close()

  const noHyphen = open()
  await noHyphen.vt.waitForRender()
  ;(noHyphen as unknown as { invoke(line: string): unknown }).invoke('/login newroute')
  await noHyphen.vt.waitForRender()
  assert.match(noHyphen.view(), /Add Provider/u)
  assert.match(noHyphen.view(), /newroute/u)
  noHyphen.close()

  const flowOnly = open()
  await flowOnly.vt.waitForRender()
  ;(flowOnly as unknown as { invoke(line: string): unknown }).invoke('/login mykey')
  await waitForFrame(flowOnly.view, frame => /Sign-in · My Key/u.test(frame), () => flowOnly.vt.waitForRender(), 'the /login deeplink must reach the sign-in detail')
  assert.match(flowOnly.rows()[0]!, /Settings · Models/u)
  // A flow-only route is a SIGN-IN, not a provider profile: the detail shows
  // the sign-in key and never a fake provider profile.
  assert.match(flowOnly.view(), /Sign-in · My Key/u)
  assert.match(flowOnly.view(), /Sign-in key/u)
  assert.doesNotMatch(flowOnly.view(), /API protocol/u)
  assert.doesNotMatch(flowOnly.view(), /Endpoint/u)
  flowOnly.close()

  const builtin = open()
  await builtin.vt.waitForRender()
  ;(builtin as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  await builtin.vt.waitForRender()
  assert.match(builtin.view(), /API Key Reference · deepseek official/u)
  assert.doesNotMatch(builtin.view(), /Provider · deepseek official/u)
  builtin.close()
})

test('/login bare opens the Models list; /login deepseek-account opens Account', async () => {
  const h = open()
  await h.vt.waitForRender()
  const invoke = (h as unknown as { invoke(line: string): unknown }).invoke
  invoke('/login')
  await h.vt.waitForRender()
  assert.match(h.view(), /Models & Credentials/u)
  assert.match(h.view(), /DeepSeek Account/u)
  assert.doesNotMatch(h.view(), /llm-pi-ai\/anthropic/u, 'the account flow is not a generic row')
  h.close()

  const h2 = open()
  await h2.vt.waitForRender()
  ;(h2 as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-account')
  await h2.vt.waitForRender()
  assert.match(h2.rows()[0]!, /Settings · Account/u)
  assert.match(h2.view(), /DeepSeek Account/u)
  assert.match(h2.view(), /Signed out/u)
  h2.close()
})

test('/logout deepseek-account with no stored credential reports signed out without a task check', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/logout deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.view(), /Signed out \/ no stored credential/u)
  assert.match(h.view(), /Nothing to sign out/u)
  assert.match(h.view(), /Sign in/u)
  assert.doesNotMatch(h.view(), /Sign out confirmation|Checking running account tasks|Could not verify/u)
  assert.equal(h.calls.includes('hasRunningAccountTasks'), false)
  h.close()
})

test('/login invalid! reports the unknown-target error without opening the workspace', async () => {
  const h = open()
  await h.vt.waitForRender()
  const result = (h as unknown as { invoke(line: string): unknown }).invoke('/login not valid!') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unknown credential target/u)
  assert.doesNotMatch(h.view(), /Settings ·/u)
  h.close()
})

test('mouse: a painted provider row opens its detail, the category rail switches pages', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login')
  await waitForFrame(h.view, frame => frame.includes('Acme Gateway'), () => h.vt.waitForRender(), 'the Models page must list the provider before the press')
  const providerRow = rowOf(h, 'Acme Gateway')
  press(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  release(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  await h.vt.waitForRender()
  assert.match(h.view(), /Provider · Acme Gateway/u)

  const accountRow = railEntryRow(h, 'Account')
  press(h, accountRow, 1)
  release(h, accountRow, 1)
  await h.vt.waitForRender()
  // A rail click SELECTS the category: the right column shows the real
  // Account page at once, while the keyboard stays on the rail.
  assert.match(h.rows()[0]!, /Settings · Categories/u, 'the rail click keeps the keyboard on the rail')
  assert.match(h.view(), /^> Account/mu, 'the rail selects the Account category')
  assert.match(h.view(), /DeepSeek Account/u, 'the right column shows the real Account page')

  const modelsRow = railEntryRow(h, 'Models')
  press(h, modelsRow, 1)
  release(h, modelsRow, 1)
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Categories/u)
  assert.match(h.view(), /^> Models/mu, 'the rail selects the Models category')
  assert.match(h.view(), /Models & Credentials/u)
  h.close()
})

test('Esc from an auth page returns to the category rail and the outer Esc closes the workspace', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login')
  await h.vt.waitForRender()
  await key(h, '\u001b')
  assert.match(h.rows()[0]!, /Settings · Categories/u)
  await key(h, '\u001b')
  assert.doesNotMatch(h.view(), /Settings · Categories/u)
  h.close()
})

test('a cross-owner mouse drag never reuses the other owner press (RFL-004)', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login acme')
  // The Models page reads its provider catalog AFTER its first frame: the
  // Configure action is only painted once the read settles, and the mouse
  // gesture must resolve against that painted row, never the Loading frame.
  await waitForFrame(
    h.view,
    frame => frame.includes('Provider · Acme Gateway') && frame.includes('> Configure API Key…'),
    () => h.vt.waitForRender(),
    'the Acme provider action must be painted before the cross-owner drag',
  )
  const providerRow = rowOf(h, 'Configure API Key')
  const railModels = railEntryRow(h, 'Models')
  press(h, providerRow, colOf(h, providerRow, 'Configure API Key'))
  release(h, railModels, 1)
  await h.vt.waitForRender()
  assert.match(h.view(), /Provider · Acme Gateway/u, 'the auth-page press did not fire after a rail release')
  assert.doesNotMatch(h.view(), /API Key Reference/u)

  const railAppearance = railEntryRow(h, 'Appearance')
  press(h, railAppearance, 1)
  release(h, providerRow, colOf(h, providerRow, 'Configure API Key'))
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Models/u, 'the rail press did not fire after a page release')
  assert.match(h.view(), /Provider · Acme Gateway/u)
  h.close()
})

test('a Host approval preempts Models input, abandons the workspace and never revives the old prompt', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  // The Enter below must open the masked editor: wait for the page's OWN
  // actionable frame (the stored-state read answered and the selected
  // Configure action is enabled), never a single render that can still be
  // `Stored reading…` with a disabled action a fence would drop.
  await waitForFrame(
    h.view,
    frame => /Stored\s+(?:Configured|Not set)/u.test(frame) && frame.includes('> Configure API Key…'),
    () => h.vt.waitForRender(),
    'the /login deeplink must reach the actionable API Key Reference page',
  )
  // Enter the page-local masked API-key editor, then hand the seat to a Host
  // approval. The workspace must be abandoned at its own lease boundary.
  await key(h, '\r')
  assert.match(h.view(), /Enter the API key/u)
  const decision = h.app.showApprovalPrompt({ toolName: 'bash', reason: 'MA13 blocking-owner probe' })
  await h.vt.waitForRender()
  assert.match(h.view(), /Allow once/u)
  assert.doesNotMatch(h.view(), /Settings · Models/u)
  await key(h, 'y')
  assert.equal(await decision, 'allowed-once')
  await h.vt.waitForRender()
  assert.doesNotMatch(h.view(), /Settings · Models/u)
  assert.doesNotMatch(h.view(), /API Key Reference/u)
  h.close()
})

test('/logout mykey deletes the flow RECORD, never the MYKEY reference (RFL-001 logout symmetry)', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/logout mykey')
  await h.vt.waitForRender()
  assert.match(h.view(), /plugin\/mykey/u)
  assert.match(h.view(), /Clear stored credential/u)
  await key(h, '\r')
  await h.vt.waitForRender()
  assert.ok(h.calls.includes('delete:plugin/mykey'), h.calls.join(','))
  assert.equal(h.calls.some(call => call.startsWith('unset:')), false, h.calls.join(','))
  h.close()
})

test('a keyboard Esc between a bar press and release never cancels the embedded QuestionFlow', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  await waitForFrame(
    h.view,
    frame => /Stored\s+(?:Configured|Not set)/u.test(frame) && frame.includes('> Configure API Key…'),
    () => h.vt.waitForRender(),
    'the /login deeplink must reach the API Key Reference page',
  )
  await key(h, '\r')
  await waitForFrame(
    h.view,
    frame => frame.includes('Enter the API key') && frame.includes('Enter continue'),
    () => h.vt.waitForRender(),
    'Enter must open the masked embedded QuestionFlow',
  )
  const frame = h.rows()
  const barRow = frame.length - 1
  const col = frame[barRow]!.indexOf('Back [Esc]')
  assert.ok(col >= 0, `the embedded question bar paints Back:\n${frame[barRow]}`)

  // PRESS the bar's Back, then let the KEYBOARD Esc leave only the QuestionFlow's
  // current Esc state (edit -> navigation; the question itself stays).
  press(h, barRow, col)
  await key(h, '\x1b')
  await h.vt.waitForRender()
  assert.match(h.view(), /Enter the API key/u, 'the keyboard Esc left the question in place')
  const after = h.rows()
  const afterRow = after.length - 1
  assert.equal(after[afterRow]!.indexOf('Back [Esc]'), col, 'the repaint keeps the same Back cells')

  // RELEASE on the old cells: the keyboard input revoked the press, so it must
  // NOT run a second Esc and cancel the question.
  release(h, barRow, col)
  await h.vt.waitForRender()
  assert.match(h.view(), /Enter the API key/u, 'the stale release did not cancel the QuestionFlow')
  assert.equal(h.calls.some(call => call.startsWith('set:')), false, 'no Host write was attempted')
  h.close()
})

test('one fresh bar click runs exactly ONE Esc step of the embedded QuestionFlow', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  await waitForFrame(
    h.view,
    frame => /Stored\s+(?:Configured|Not set)/u.test(frame) && frame.includes('> Configure API Key…'),
    () => h.vt.waitForRender(),
    'the /login deeplink must reach the API Key Reference page',
  )
  await key(h, '\r')
  await waitForFrame(
    h.view,
    frame => frame.includes('Enter the API key') && frame.includes('Enter continue'),
    () => h.vt.waitForRender(),
    'Enter must open the masked embedded QuestionFlow',
  )
  const barCell = (): { row: number; col: number } => {
    const rows = h.rows()
    const row = rows.length - 1
    const col = rows[row]!.indexOf('Back [Esc]')
    assert.ok(col >= 0, `the embedded question bar paints Back:\n${rows[row]}`)
    return { row, col }
  }
  const first = barCell()
  await click(h, first.row, first.col)
  assert.match(h.view(), /Enter the API key/u,
    'the first click ran only the edit-exit Esc (the flow stays)')
  // Two rapid clicks on the same cell are read as a terminal double click; give
  // the gesture window time to reset so this is a SECOND independent click.
  await new Promise<void>(resolve => setTimeout(resolve, 900))
  const second = barCell()
  await click(h, second.row, second.col)
  assert.doesNotMatch(h.view(), /Enter the API key/u,
    'the second independent click ran the navigation-state Esc exactly once (the flow cancels)')
  assert.match(h.rows()[0]!, /Settings · Models/u, 'the Settings lease stays on the Models page')
  h.close()
})

test('a Host prompt takeover between a bar press and release leaves the old press inert', async () => {
  const listeners = new Set<(event: unknown) => void>()
  const responds: string[] = []
  const emit = (event: unknown): void => {
    for (const listener of listeners) listener(event)
  }
  const auth = {
    available: () => true,
    listTargets: () => FLOWS,
    begin: async () => {
      queueMicrotask(() => {
        emit({
          kind: 'prompt',
          attemptId: 'auth-takeover',
          promptId: 'p1',
          prompt: { kind: 'text', message: 'FIRST PROMPT' },
        })
        // The second prompt arrives BEFORE the press: it queues behind p1, so
        // the owner serial is already at its current value when the press is
        // recorded and p1's withdrawal is the ONLY thing that changes hands.
        emit({
          kind: 'prompt',
          attemptId: 'auth-takeover',
          promptId: 'p2',
          prompt: { kind: 'text', message: 'SECOND PROMPT' },
        })
      })
      return { kind: 'started' as const, attemptId: 'auth-takeover' }
    },
    onEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    respond: async (attemptId: string, promptId: string, answer: string | null) => {
      responds.push(`${attemptId}:${promptId}:${answer === null ? 'null' : answer}`)
    },
    cancel: async () => {},
  }
  const h = open(120, 40, auth)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login anthropic')
  await waitForFrame(
    h.view,
    frame => frame.includes('Provider · Anthropic') && frame.includes('> Sign in (provider)'),
    () => h.vt.waitForRender(),
    'the /login deeplink must reach the actionable Anthropic provider page',
  )
  await key(h, '\r')
  await waitForFrame(
    h.view,
    frame => frame.includes('FIRST PROMPT') && frame.includes('Back [Esc]'),
    () => h.vt.waitForRender(),
    'the first Host prompt must own the painted question bar',
  )
  const barCell = (): { row: number; col: number } => {
    const rows = h.rows()
    const row = rows.length - 1
    const col = rows[row]!.indexOf('Back [Esc]')
    assert.ok(col >= 0, `the embedded question bar paints Back:\n${rows[row]}`)
    return { row, col }
  }
  const first = barCell()
  press(h, first.row, first.col)

  // The Host withdraws the VISIBLE first prompt: the queued second one takes
  // over the same bar cells while p1's press is still recorded.
  emit({ kind: 'prompt-withdrawn', attemptId: 'auth-takeover', promptId: 'p1' })
  await waitForFrame(
    h.view,
    frame => frame.includes('SECOND PROMPT') && frame.includes('Back [Esc]'),
    () => h.vt.waitForRender(),
    'the withdrawn first prompt must hand the question UI to the queued prompt',
  )
  assert.doesNotMatch(h.view(), /FIRST PROMPT/u)
  assert.equal(barCell().col, first.col, 'the takeover keeps the same Back cells')

  // The OLD press belongs to p1: releasing on the same cells must be inert and
  // leave p2 in its EDIT state (the flow's own hint still says `esc back`, not
  // the navigation state's `esc cancel`).
  release(h, first.row, first.col)
  await h.vt.waitForRender()
  assert.match(h.view(), /SECOND PROMPT/u)
  assert.match(h.view(), /esc back/u, 'the stale release did not run p2 edit exit')
  assert.deepEqual(responds, [], 'the stale release answered no prompt')

  // A FRESH complete click is a new gesture: it runs exactly ONE Esc step (the
  // edit exit), so the takeover prompt survives. Two rapid clicks would be a
  // double click; wait out that terminal gesture window before this click.
  await new Promise<void>(resolve => setTimeout(resolve, 900))
  const fresh = barCell()
  await click(h, fresh.row, fresh.col)
  assert.match(h.view(), /SECOND PROMPT/u, 'one fresh click ran exactly one Esc step')
  assert.deepEqual(responds, [], 'one fresh click never cancels the prompt')

  // A second independent click runs the navigation-state Esc exactly once and
  // answers exactly the takeover prompt; the same double-click window applies.
  await new Promise<void>(resolve => setTimeout(resolve, 900))
  const cancelling = barCell()
  await click(h, cancelling.row, cancelling.col)
  assert.deepEqual(responds, ['auth-takeover:p2:null'],
    'the second independent click cancelled exactly the takeover prompt')
  assert.doesNotMatch(h.view(), /SECOND PROMPT/u)
  h.close()
})

test('a 30x8 Settings workspace disables Enter for a clipped masked form; 40x16 keeps it visible (MA12)', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  // Wait for the ACTIONABLE reference page, not just its header: the Enter below
  // must open the masked form, so the frame that grants that action has to be
  // painted first (a single render after the deeplink can still be the Loading
  // or provider frame under load).
  await waitForFrame(
    h.view,
    frame => /Stored\s+(?:Configured|Not set)/u.test(frame) && frame.includes('> Configure API Key…'),
    () => h.vt.waitForRender(),
    'the /login deeplink must reach the API Key Reference page before Enter',
  )
  // Open the masked form. The page refuses a key while a changed row grant
  // awaits its paint (a safe fail-closed admission), and a frame can land
  // between the wait above and the keypress under CI load; retry the key after
  // that frame. A genuinely broken Enter still never paints the form and fails.
  const settledFormPainted = async (): Promise<boolean> => {
    for (let frame = 0; frame < 8; frame += 1) {
      const painted = h.view()
      if (painted.includes('Enter the API key') && painted.includes('Enter continue')) return true
      await h.vt.waitForRender()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    return false
  }
  await key(h, '\r')
  if (!(await settledFormPainted())) {
    // Retry ONLY while the reference page is still the live owner: a frame that
    // already advanced to the form/review must never receive a second submit.
    assert.match(h.view(), /Configure API Key|API Key Reference/u,
      'the retry is only safe while the reference page still owns the frame')
    await key(h, '\r')
    assert.ok(await settledFormPainted(),
      'Enter on the reference page must open the masked form with its real submit hint')
  }
  assert.match(h.view(), /API Key Reference|Enter the API key/u)

  h.vt.resize(40, 16)
  await h.vt.waitForRender()
  assert.doesNotMatch(h.view(), /Enter is disabled/u)
  assert.match(h.view(), /Enter continue/u)

  h.vt.resize(30, 8)
  h.vt.sendInput('\r') // Enter in the resize-before-frame gap
  await h.vt.waitForRender()
  assert.equal(h.calls.some(call => call.startsWith('set:')), false, 'the input-path geometry guard blocks the race')
  assert.match(h.view(), /Resize the terminal/u)
  assert.doesNotMatch(h.view(), /Enter continue/u, 'a clipped form never advertises a hidden submit')
  assert.match(h.view(), /Cancel \[Esc\]/u, 'the only real key of the clipped question is its cancel')
  assert.doesNotMatch(h.view(), /type to edit/u, 'the frame does not advertise editing it refuses')
  await key(h, 'a')
  await key(h, '\r')
  await h.vt.waitForRender()
  assert.equal(h.calls.some(call => call.startsWith('set:')), false, 'a clipped form must never submit')
  h.close()
})

test('the category rail cannot abandon a pending API-key write (pending mutation ownership)', async () => {
  const h = open()
  await h.vt.waitForRender()
  const release = h.holdNextSetReference()
  try {
    await submitHeldOfficialKey(h)

    const accountRow = railEntryRow(h, 'Account')
    await click(h, accountRow, 2)
    assert.match(h.rows()[0]!, /Settings · Models/u, 'pending mutation wins over category navigation')
    assert.doesNotMatch(h.view(), /^> Account/mu, 'the rail did not select the Account category')
    assert.deepEqual(h.calls.filter(call => call.startsWith('set:')), ['set:DEEPSEEK_API_KEY'],
      'the held write is the ONE Host mutation of this reference')
  } finally {
    release()
    for (let index = 0; index < 20; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
    h.close()
  }
})

test('a pending Host mutation owns the page: the rail click cannot take the keyboard away from it', async () => {
  const h = open()
  await h.vt.waitForRender()
  const release = h.holdNextSetReference()
  try {
    await submitHeldOfficialKey(h)
    assert.match(h.rows()[0]!, /Settings · Models/u, 'the content owns the keyboard')

    // A click on the ALREADY selected category must not take the keyboard away
    // from the page that owns the pending write: the rail would otherwise be a
    // way around the page's own refusal.
    const modelsRow = railEntryRow(h, 'Models')
    await click(h, modelsRow, 2)
    assert.match(h.rows()[0]!, /Settings · Models/u, 'the focus stayed with the page that owns the pending write')
    assert.doesNotMatch(h.rows()[0]!, /Settings · Categories/u, 'the rail did not take the keyboard')

    // The page's own Esc refuses the pending write, and the workspace stays open.
    await key(h, '\u001b')
    assert.match(h.view(), /Settings ·/u, 'the workspace is not closed while the write is pending')
    assert.match(h.view(), /in flight/u, 'the page states that the write is still in flight')
    assert.deepEqual(h.calls.filter(call => call.startsWith('set:')), ['set:DEEPSEEK_API_KEY'],
      'the held write is the ONE Host mutation of this reference')
  } finally {
    release()
    for (let index = 0; index < 20; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
    h.close()
  }
})

test('a pending Account operation keeps the keyboard: the painted Back action does not leave the page', async () => {
  const h = open()
  await h.vt.waitForRender()
  const releaseHost = h.holdNextStartSignIn()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the deeplink lands in the content')

  // The page's own Sign in starts a Host operation the Host has not answered
  // yet: the page is busy from now on.
  await key(h, '\r')
  await h.vt.waitForRender()
  assert.equal(h.calls.filter(call => call === 'startSignIn').length, 1, 'the sign-in reached the Host')
  assert.match(h.view(), /the Host has not confirmed yet/u, 'the page states that the operation is in flight')

  // The page's own painted Back action must not take the keyboard away from
  // the operation that is still in flight.
  const backRow = rowOf(h, '← Settings')
  const backCol = colOf(h, backRow, '← Settings')
  press(h, backRow, backCol)
  release(h, backRow, backCol)
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the content kept the keyboard')
  assert.doesNotMatch(h.rows()[0]!, /Settings · Categories/u, 'the rail did not take the keyboard')

  // The keyboard path is the same action: Esc must not leave the page either.
  await key(h, '\u001b')
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the content still owns the keyboard')
  assert.match(h.view(), /still in flight/u, 'the page states that the operation is still in flight')

  // The clipped fallback must name the same real effect: Esc waits for the
  // Host, it neither leaves nor cancels the in-flight operation.
  h.vt.resize(120, 2)
  await h.vt.waitForRender()
  assert.match(h.rows().at(-1) ?? '', /Wait \[Esc\]/u, 'the zero-body fallback states that Esc waits')
  await key(h, '\u001b')
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the pending operation still owns the content')

  releaseHost()
  for (let index = 0; index < 20; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
  h.close()
})

test('the Account page mouse Back exits to the Settings category rail (F6)', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Account/u)
  const backRow = rowOf(h, '← Settings')
  const backCol = colOf(h, backRow, '← Settings')
  press(h, backRow, backCol)
  release(h, backRow, backCol)
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Categories/u)
  h.close()
})

test('real Settings 30x8 hides a clipped select prompt and refuses Enter (F7)', async () => {
  const listeners = new Set<(event: unknown) => void>()
  let respondCalls = 0
  const auth = {
    available: () => true,
    listTargets: () => FLOWS,
    begin: async () => {
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ kind: 'notice', attemptId: 'auth-short', notice: { message: 'Continue in your browser', url: 'https://example.test/authorize', code: 'ABCD' } })
          listener({ kind: 'prompt', attemptId: 'auth-short', promptId: 'p1', prompt: { kind: 'select', message: 'Choose a method', options: [{ id: 'oauth', label: 'OAuth' }, { id: 'device', label: 'Device code' }] } })
        }
      })
      return { kind: 'started' as const, attemptId: 'auth-short' }
    },
    onEvent: (listener: (event: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    respond: async () => { respondCalls += 1 },
    cancel: async () => {},
  }
  const h = open(120, 40, auth)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login anthropic')
  await h.vt.waitForRender()
  await key(h, '\r') // start provider-native sign-in
  await h.vt.waitForRender()
  // The direct projection gives the content column the frame's remaining rows,
  // so the select prompt stops fitting one row earlier than in the legacy
  // projection: five terminal rows are the point where it is clipped.
  h.vt.resize(30, 5)
  await h.vt.waitForRender()
  assert.match(h.view(), /Resize the terminal/u)
  assert.doesNotMatch(h.view(), /OAuth|Device code/u)
  await key(h, '\r')
  assert.equal(respondCalls, 0, 'Enter cannot answer an invisible select prompt')
  h.close()
})

// ── Phase 3C / C2-A: the true two-pane navigation (root focus + real pages) ─
//
// The category rail SELECTS; the right column shows the selected page at
// once; Enter/Right hands the keyboard to that page. These cases drive the
// REAL command coordinator, the REAL workspace lease and the REAL pages.

/**
 * The physical row of one CATEGORY RAIL entry. The rail owns the first 22
 * cells of the frame, so a rail entry is found by its own cell — a plain
 * "first row containing the label" would find the CONTENT column instead.
 */
const railEntryRow = (h: Harness, label: string): number => {
  const row = h.rows().findIndex(line => {
    const cell = line.slice(0, 22).trim()
    return cell === label || cell === `> ${label}`
  })
  assert.ok(row >= 0, `the category rail must paint ${JSON.stringify(label)}:\n${h.view()}`)
  return row
}

test('the category rail paints the real Models and Account pages while the keyboard stays on the rail', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await h.vt.waitForRender()
  assert.match(h.view(), /dsh-pi-tui/u, 'the About home is the first frame')

  // Down to Models: the right column shows the REAL Models page at once.
  await key(h, '\u001b[B')
  assert.match(h.view(), /Models & Credentials/u, 'the rail shows the real Models page')
  assert.match(h.rows()[0]!, /Settings · Categories/u, 'the keyboard stays on the rail')

  // Down to Account: the right column shows the REAL Account page at once.
  await key(h, '\u001b[B')
  assert.match(h.view(), /DeepSeek Account/u, 'the rail shows the real Account page')
  assert.match(h.rows()[0]!, /Settings · Categories/u, 'the keyboard stays on the rail')
  assert.equal(h.calls.some(call => call.startsWith('signIn')), false, 'moving the rail never signs in')
  h.close()
})

test('Enter on the rail hands the keyboard to the SAME Account page without running its action', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await h.vt.waitForRender()
  await key(h, '\u001b[B')
  await key(h, '\u001b[B')
  assert.match(h.view(), /DeepSeek Account/u, 'the Account page is already on screen')
  const before = h.view()

  await key(h, '\r')
  assert.match(h.rows()[0]!, /Settings · Account/u, 'Enter moved the focus into the content')
  assert.equal(h.calls.some(call => call.includes('startSignIn')), false,
    'the focus transfer must not run the highlighted Sign in action')
  // The SAME page instance is still painted: only the chrome around it
  // changes (the header names the new focus owner, the pane header moves the
  // active device to `[Account]`, and the action bar swaps the rail hints for
  // the page's own hints). This 120x40 frame spends its first four rows on
  // chrome: header, metadata, top rule and the pane header.
  const page = (frame: string): string => frame.split('\n').slice(4, -1).join('\n')
  assert.equal(page(h.view()), page(before), 'the focus transfer repaints the same page body')
  h.close()
})

test('the content focus runs the page own action, and Esc returns to the rail without closing the lease', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the deeplink lands in the content')
  // The page's own Enter runs the page's own action (the sign-in attempt).
  await key(h, '\r')
  await h.vt.waitForRender()
  assert.equal(h.calls.some(call => call.includes('startSignIn')), true,
    'the content focus runs the Account page own sign-in')
  // Esc returns to the rail: the SAME lease, the SAME page instance.
  await key(h, '\u001b')
  assert.match(h.rows()[0]!, /Settings · Categories/u, 'Esc returns to the category rail')
  assert.match(h.view(), /DeepSeek Account/u, 'the page is still mounted behind the rail')
  h.close()
})

test('a rail selection is refused while the page owns a pending Host mutation', async () => {
  const h = open()
  await h.vt.waitForRender()
  const release = h.holdNextSetReference()
  try {
    await submitHeldOfficialKey(h)

    const accountRow = railEntryRow(h, 'Account')
    await click(h, accountRow, 1)
    assert.match(h.rows()[0]!, /Settings · Models/u, 'the pending mutation owns the page')
    assert.doesNotMatch(h.view(), /Settings · Account/u, 'the rail refused the category change')
    assert.deepEqual(h.calls.filter(call => call.startsWith('set:')), ['set:DEEPSEEK_API_KEY'],
      'the held write is the ONE Host mutation of this reference')
  } finally {
    release()
    for (let index = 0; index < 20; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
    h.close()
  }
})

test('a cross-owner gesture does nothing: a rail press released in the content column', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login')
  await waitForFrame(
    h.view,
    frame => frame.includes('Acme Gateway'),
    () => h.vt.waitForRender(),
    'the Models provider row must be painted before the cross-owner gesture',
  )
  const railModels = railEntryRow(h, 'Models')
  const providerRow = rowOf(h, 'Acme Gateway')
  // A press on the RAIL, released in the CONTENT column: neither owner may
  // act. The rail press must not select a category and the content release
  // must not open a provider.
  press(h, railModels, 1)
  release(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  await h.vt.waitForRender()
  assert.match(h.view(), /Models & Credentials/u, 'the content release did not open a provider')
  assert.match(h.view(), /^> Models/mu, 'the rail press did not select a category')
  // The rail press must not even take the KEYBOARD: re-selecting the already
  // selected category would leave the rail as the focus owner while the same
  // Models content stays painted, so the header is the witness that no rail
  // action ran at all.
  assert.match(h.rows()[0]!, /Settings · Models/u, 'the rail press did not take the keyboard from the content')

  // Control: the SAME content cell is a real target. A matching press and
  // release opens the provider detail, so the refusal above is a real
  // cross-owner refusal, not an inert coordinate.
  press(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  release(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  await h.vt.waitForRender()
  assert.match(h.view(), /Provider · Acme Gateway/u, 'the content cell is a real provider target')
  h.close()
})

test('a resize cycle keeps the selected category, the content focus and the page instance', async () => {
  const h = open(200, 50)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the deeplink lands in the content')

  for (const [columns, rows] of [[72, 24], [44, 20], [100, 40], [200, 50]] as const) {
    h.vt.resize(columns, rows)
    await h.vt.waitForRender()
    assert.match(h.view(), /DeepSeek Account/u, `the Account page survives ${columns}x${rows}`)
  }
  // The content focus survived the cycle: the page still owns the keyboard.
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the content focus survived the resize cycle')
  h.close()
})

test('the Account page keeps its Host browser attempt when the rail leaves and returns', async () => {
  // The Host owns a browser attempt that is WAITING for the callback: the page
  // only reads it. Leaving the page must end the page's own watch, never the
  // Host attempt.
  const attempt = {
    id: 'attempt-1',
    phase: 'waiting-browser' as const,
    authorizeUrl: 'https://platform.example/dsh/authorize?state=abc',
    expiresAt: Date.now() + 60_000,
  }
  const h = open()
  h.setAccountView({ status: 'signed-out', links: { usageUrl: 'https://u', topUpUrl: 'https://t' }, attempt })
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.view(), /waiting-browser/u, 'the running Host attempt is on screen')
  assert.match(h.view(), /platform\.example/u, 'the authorize URL is on screen')

  const aboutRow = railEntryRow(h, 'About')
  await click(h, aboutRow, 1)
  assert.match(h.view(), /dsh-pi-tui/u, 'the About page is painted after the category change')
  const accountRow = railEntryRow(h, 'Account')
  await click(h, accountRow, 1)
  assert.match(h.view(), /waiting-browser/u, 'the returned page re-reads the Host attempt')
  assert.equal(h.calls.some(call => call.includes('cancelSignIn')), false,
    'leaving the Account page never cancels the Host attempt')
  h.close()
})

test('a Host callback that settles after a category change never repaints the new category', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-account')
  await h.vt.waitForRender()
  const before = h.view()
  // Switch to the About home WHILE the Account watch is still settling.
  const aboutRow = railEntryRow(h, 'About')
  await click(h, aboutRow, 1)
  for (let index = 0; index < 20; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
  assert.match(h.view(), /dsh-pi-tui/u, 'the About page is still painted after the settlement')
  assert.doesNotMatch(h.view(), /DeepSeek Account/u, 'the disposed Account page never repaints the new category')
  assert.notEqual(h.view(), before, 'the frame really changed')
  h.close()
})

test('a narrow rail selection never creates the invisible Account page, and Enter creates it exactly once', async () => {
  const h = open(44, 20)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await h.vt.waitForRender()
  // The narrow first frame is the About CONTENT: Esc returns to the list.
  await key(h, '\u001b')
  assert.match(h.rows()[0]!, /Settings · Categories/u, 'the narrow rail owns the list')

  // Browsing the invisible Account category must not start a Host watch.
  await key(h, '\u001b[B')
  await key(h, '\u001b[B')
  assert.equal(h.calls.filter(call => call === 'account:watch').length, 0,
    'browsing an invisible category never starts the Account watch')
  assert.equal(h.calls.filter(call => call === 'startSignIn').length, 0,
    'browsing an invisible category never signs in')

  // Enter creates the page exactly ONCE and shows it.
  await key(h, '\r')
  await h.vt.waitForRender()
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the content focus shows the Account page')
  assert.equal(h.calls.filter(call => call === 'account:watch').length, 1,
    'the Account page starts exactly one watch')
  h.close()
})

test('the wide rail previews the real page with exactly ONE watch, and the focus transfer reuses it', async () => {
  const h = open(120, 40)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await h.vt.waitForRender()
  await key(h, '\u001b[B')
  await key(h, '\u001b[B')
  assert.match(h.view(), /DeepSeek Account/u, 'the rail previews the real Account page')
  assert.equal(h.calls.filter(call => call === 'account:watch').length, 1,
    'the wide rail preview starts exactly ONE watch')

  // The focus transfer reuses the SAME page: no second watch.
  await key(h, '\r')
  assert.match(h.rows()[0]!, /Settings · Account/u, 'the focus moved into the content')
  assert.equal(h.calls.filter(call => call === 'account:watch').length, 1,
    'the focus transfer reuses the mounted page: no second watch')
  h.close()
})

test('a content press released on the rail does not select the category', async () => {
  const h = open(120, 40)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await h.vt.waitForRender()
  const accountRow = railEntryRow(h, 'Account')
  await key(h, '\u001b[B')
  await key(h, '\u001b[B')
  const contentRow = rowOf(h, 'Status')
  // A press in the CONTENT, released on the RAIL: the rail must not act on it.
  // The selection stays exactly where the rail navigation left it, and the
  // content press never runs a page action.
  press(h, contentRow, colOf(h, contentRow, 'Status'))
  release(h, accountRow, 1)
  await h.vt.waitForRender()
  assert.match(h.view(), /^> Account/mu, 'the rail release did not change the selected category')
  assert.equal(h.calls.some(call => call.includes('startSignIn')), false,
    'the content press never ran a page action')
  h.close()
})

test('a narrow rail selection is mounted when the terminal grows and the content column appears', async () => {
  const h = open(44, 20)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await h.vt.waitForRender()
  // The narrow first frame is the About content: Esc returns to the list.
  await key(h, '\u001b')
  await key(h, '\u001b[B')
  await key(h, '\u001b[B')
  assert.match(h.view(), /^> Account/mu, 'the narrow rail selected the Account category')
  assert.equal(h.calls.filter(call => call === 'account:watch').length, 0,
    'the narrow rail browsed an invisible category: no Account watch was started')

  // The terminal grows: the right column appears and the SELECTED page must
  // be there, created once, with exactly one Host watch.
  h.vt.resize(100, 40)
  await h.vt.waitForRender()
  assert.match(h.view(), /DeepSeek Account/u, 'the widened frame shows the real Account page')
  assert.equal(h.calls.filter(call => call === 'account:watch').length, 1,
    'the widened frame created the page exactly once')
  h.close()
})

test('the Models page is mounted the same way when the terminal grows', async () => {
  const h = open(44, 20)
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await h.vt.waitForRender()
  await key(h, '\u001b')
  await key(h, '\u001b[B')
  assert.match(h.view(), /^> Models/mu, 'the narrow rail selected the Models category')
  h.vt.resize(120, 40)
  await h.vt.waitForRender()
  assert.match(h.view(), /Models & Credentials/u, 'the widened frame shows the real Models page')
  h.close()
})

/** Every terminal-bound byte written before `limit` writes. */
const writtenBefore = (h: Harness, limit: number): string => h.vt.writes.slice(0, limit).join('')

/** Paint one frame BEFORE the measured input, leaving the renderer inside its
 *  16 ms throttle window: the next frame is delayed, so a `setTimeout(0)` read
 *  would run first. */
const paintFrameNow = async (h: Harness): Promise<void> => {
  const before = h.vt.writes.length
  h.app.requestRender(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(h.vt.writes.length > before, 'the forced frame must be written before the measured input')
}

/**
 * The paint → read order. The forced frame leaves the renderer inside its
 * 16 ms throttle window, so the next frame is delayed — the exact window
 * where a `setTimeout(0)` read would run before the Loading/Reading frame
 * ever reached the terminal. The read's recorded write count must already
 * include that frame.
 */
test('paint order: the catalog R refresh starts only after the Refreshing frame is written', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login')
  await waitForFrame(h.view, frame => /Models & Credentials/u.test(frame) && /Acme Gateway/u.test(frame), () => h.vt.waitForRender(), 'the Models list must settle first')
  h.catalogReadWrites.length = 0
  // Only the measured window's bytes count: an earlier frame may legitimately
  // contain the same status text (e.g. the initial Loading/Reading frame).
  h.vt.writes.length = 0
  await paintFrameNow(h)
  h.vt.sendInput('r')
  await h.vt.waitForRender()
  assert.equal(h.catalogReadWrites.length, 1, 'the R refresh starts exactly one catalog read')
  assert.match(writtenBefore(h, h.catalogReadWrites[0]!), /Refreshing…/u,
    'the catalog read must start only after the frame carrying the Refreshing state was written')
  h.close()
})

test('paint order: the records R refresh starts only after the Reading frame is written', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/logout')
  await waitForFrame(h.view, frame => /Stored credentials/u.test(frame) && /plugin\/mykey/u.test(frame), () => h.vt.waitForRender(), 'the stored-credential list must settle first')
  h.credentialListWrites.length = 0
  // Only the measured window's bytes count: an earlier frame may legitimately
  // contain the same status text (e.g. the initial Loading/Reading frame).
  h.vt.writes.length = 0
  await paintFrameNow(h)
  h.vt.sendInput('r')
  await h.vt.waitForRender()
  assert.equal(h.credentialListWrites.length, 1, 'the R refresh starts exactly one stored-credential read')
  assert.match(writtenBefore(h, h.credentialListWrites[0]!), /Reading the credential store…/u,
    'the stored-credential read must start only after the Reading frame was written')
  h.close()
})

test('paint order: opening the record clear confirmation starts its read only after the Reading frame is written', async () => {
  const h = open()
  h.setRecordRows([{ key: 'llm-pi-ai/anthropic', label: 'Anthropic', kind: 'grant' }])
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login anthropic')
  await waitForFrame(h.view, frame => /Provider · Anthropic/u.test(frame) && /Signed in/u.test(frame), () => h.vt.waitForRender(), 'the Anthropic detail must settle with its stored record')
  h.credentialListWrites.length = 0
  // Only the measured window's bytes count: an earlier frame may legitimately
  // contain the same status text (e.g. the initial Loading/Reading frame).
  h.vt.writes.length = 0
  await paintFrameNow(h)
  h.vt.sendInput('\u001b[B') // Sign in (provider) -> Clear stored credential
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.equal(h.credentialListWrites.length, 1, 'the clear target read starts exactly once')
  assert.match(writtenBefore(h, h.credentialListWrites[0]!), /Reading the credential store…/u,
    'the record-clear read must start only after the Reading frame was written')
  h.close()
})

test('a shrink before repaint revokes a selected sign-out action; the short fallback keeps only Esc live', async () => {
  const h = open()
  h.setAccountView({
    status: 'credential-stored',
    links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' },
    attempt: null,
  })
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/logout deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.view(), /Sign out confirmation/u)
  assert.match(h.view(), /Sign out/u, 'the real Sign out action is painted and selected at the full height')
  assert.equal(h.calls.filter(call => call === 'signOut').length, 0, 'opening the confirmation never signs out')

  // Shrink below the three-action confirmation and press Enter BEFORE the new
  // frame paints: the old frame's action grant is stale and must not sign out.
  h.vt.resize(120, 3)
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  // The dispatch is an owned async task: let it reach the fake Host before
  // asserting the negative fact, so a wrongly dispatched sign-out cannot hide
  // behind the render wait.
  for (let index = 0; index < 10; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.calls.filter(call => call === 'signOut').length, 0,
    'the stale Enter after a shrink never dispatches the old sign-out grant')
  assert.match(h.rows().at(-1) ?? '', /Cancel \[Esc\]/u, 'the short fallback names the real Esc cancel')

  // Even after the fallback paints, Enter and the hidden refresh stay inert.
  await key(h, '\r')
  await key(h, 'r')
  assert.equal(h.calls.filter(call => call === 'signOut').length, 0,
    'the painted Esc-only fallback grants no hidden Enter')
  await key(h, '\u001b') // the real cancel still works
  h.vt.resize(120, 40)
  await h.vt.waitForRender()
  assert.doesNotMatch(h.view(), /Sign out confirmation/u, 'Esc really cancelled the confirmation')
  h.close()
})


test('a resize to 120x7 rejects a mouse press/release on the old sign-out row', async () => {
  const h = open(120, 8)
  h.setAccountView({
    status: 'credential-stored',
    links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' },
    attempt: null,
  })
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/logout deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.view(), /> Sign out/u, 'the 8-row confirmation paints its selected action')
  const oldSignOutRow = h.rows().findIndex(line => line.includes('> Sign out'))
  assert.equal(oldSignOutRow, 4, 'the selected Sign out action is the old y=4 row')
  const oldSignOutCol = h.rows()[oldSignOutRow]!.indexOf('Sign out')

  h.vt.resize(120, 7)
  press(h, oldSignOutRow, oldSignOutCol)
  release(h, oldSignOutRow, oldSignOutCol)
  await h.vt.waitForRender()
  for (let index = 0; index < 10; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.calls.filter(call => call === 'signOut').length, 0,
    'the stale old-frame mouse gesture never signs out')
  assert.match(h.view(), /> Sign out/u, 'the confirmation is still open after the rejected gesture')
  await key(h, '\u001b')
  h.close()
})

// ── C2-R4: the Web page's credential row is the SAME official reference ─────

/** Open `/settings → Tools → Web Search / Fetch` and select the credential row
 *  of the real Web page (Home + five Downs within the page list). */
async function openWebCredentialRow(h: Harness): Promise<void> {
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/settings')
  await waitForFrame(h.view, frame => frame.includes('Settings ·'), () => h.vt.waitForRender(), 'the Settings workspace')
  for (let step = 0; step < 7; step += 1) await key(h, '\x1b[B') // About -> Tools
  await key(h, '\r') // rows level
  // Walk the Tools rows until the Web launcher owns the selection (the M5-W
  // PR-C preference row sits between Visual tools and it).
  for (let step = 0; step < 6 && !/> Web Search \/ Fetch/u.test(h.view()); step += 1) await key(h, '\x1b[B')
  await key(h, '\r') // the SAME-lease Web page
  await waitForFrame(h.view, frame => frame.includes('Web Search Provider') && !frame.includes('Loading…'),
    () => h.vt.waitForRender(), 'the Web Search / Fetch page')
  await key(h, '\x1b[H')
  for (let step = 0; step < 5; step += 1) await key(h, '\x1b[B')
  await key(h, '\r') // the credential row Detail
  await waitForFrame(h.view, frame => frame.includes('Reference: DEEPSEEK_API_KEY'),
    () => h.vt.waitForRender(), 'the credential row Detail')
}

test('the Web page Configure deeplink completes a REAL masked set on the SAME reference and the page reads the fresh presence', async () => {
  const h = open(140, 40)
  await h.vt.waitForRender()
  h.setConfigured('DEEPSEEK_API_KEY', false)
  await openWebCredentialRow(h)
  assert.match(h.view(), /State: Not configured/u, 'the row starts from the official Not-configured fact')
  await key(h, '\r') // Configure in Models… (the only enabled action)
  // Wait for the ACTIONABLE reference page, not just its header or a disabled
  // action label: the page paints `  Configure API Key…` even while the
  // reference read is pending (a dropped Enter is exactly the CI race). The
  // settled state is proven by `Stored Not set` AND the ENABLED+SELECTED
  // marker `> Configure API Key…` (paintAction only adds `>` for an enabled
  // selected action).
  await waitForFrame(h.view, frame => frame.includes('Settings · Models')
    && /Stored\s+Not set/u.test(frame)
    && frame.includes('> Configure API Key…'),
    () => h.vt.waitForRender(), 'the Models reference page with an actionable Configure')
  assert.match(h.view(), /DEEPSEEK_API_KEY/u, 'Models owns the SAME official reference')
  // The masked editor: Enter opens the key prompt, the fake secret is typed,
  // Enter reviews and Enter submits to the official store.
  await key(h, '\r')
  await waitForFrame(h.view, frame => /Enter the API key/u.test(frame),
    () => h.vt.waitForRender(), 'the masked key prompt')
  for (const character of 'sk-r4-secret') await key(h, character)
  await key(h, '\r')
  await key(h, '\r')
  await waitForFrame(h.view, frame => frame.includes('Verified'),
    () => h.vt.waitForRender(), 'the verified credential set')
  assert.deepEqual(h.calls.filter(call => call.startsWith('set:')), ['set:DEEPSEEK_API_KEY'],
    'exactly the official reference was written through the store')
  assert.deepEqual(h.writtenSecrets, [{ ref: 'DEEPSEEK_API_KEY', secret: 'sk-r4-secret' }],
    'the masked input reached the store verbatim')
  assert.doesNotMatch(h.view(), /sk-r4-secret/u, 'the secret is never rendered back')
  // Leave the whole workspace and re-enter through Tools → Web: the page must
  // read the FRESH official presence, not a cached pre-set snapshot.
  for (let attempt = 0; attempt < 8 && h.view().includes('Settings ·'); attempt += 1) await key(h, '\x1b')
  assert.doesNotMatch(h.view(), /Settings ·/u, 'the workspace really closed')
  await openWebCredentialRow(h)
  assert.match(h.view(), /State: Configured · source: file/u, `the fresh Web presence is Configured:\n${h.view()}`)
  assert.doesNotMatch(h.view(), /sk-r4-secret/u)
  h.close()
})

test('the Web page Clear deeplink completes a REAL unset on the SAME reference and the page reads the fresh absence', async () => {
  const h = open(140, 40)
  await h.vt.waitForRender()
  await openWebCredentialRow(h)
  assert.match(h.view(), /State: Configured/u)
  await key(h, '\x1b[B') // Configure -> the enabled Clear in Models…
  await key(h, '\r')
  await waitForFrame(h.view, frame => frame.includes('Settings · Models') && frame.includes('> Clear credential'),
    () => h.vt.waitForRender(), 'the Models clear confirmation with an enabled action')
  assert.match(h.view(), /DEEPSEEK_API_KEY/u, 'the clear target is the SAME official reference')
  await key(h, '\r') // the ONE explicit clear confirmation
  await waitForFrame(h.view, frame => /API key DEEPSEEK_API_KEY cleared|cleared/u.test(frame),
    () => h.vt.waitForRender(), 'the confirmed clear result')
  assert.deepEqual(h.calls.filter(call => call.startsWith('unset:')), ['unset:DEEPSEEK_API_KEY'],
    'exactly the official reference was unset through the store')
  // Re-enter through Tools → Web: the fresh official absence is displayed.
  for (let attempt = 0; attempt < 8 && h.view().includes('Settings ·'); attempt += 1) await key(h, '\x1b')
  assert.doesNotMatch(h.view(), /Settings ·/u, 'the workspace really closed')
  await openWebCredentialRow(h)
  assert.match(h.view(), /State: Not configured/u, `the fresh Web presence is Not configured:\n${h.view()}`)
  h.close()
})

test('the Web page Clear deeplink cancel writes nothing', async () => {
  const h = open(140, 40)
  await h.vt.waitForRender()
  await openWebCredentialRow(h)
  await key(h, '\x1b[B') // Clear in Models…
  await key(h, '\r')
  await waitForFrame(h.view, frame => frame.includes('Settings · Models') && frame.includes('> Clear credential'),
    () => h.vt.waitForRender(), 'the Models clear confirmation with an enabled action')
  await key(h, '\x1b') // cancel
  assert.deepEqual(h.calls.filter(call => call.startsWith('unset:')), [],
    'a cancelled clear performs ZERO credential writes')
  h.close()
})

test('a Models/Account physical bar click replays the page own Esc exactly like the keyboard', async () => {
  const normalize = (text: string): string => text.replace(/Refreshed \d\d:\d\d/u, 'Refreshed --:--')
  for (const command of ['/login acme', '/login deepseek-account']) {
    // ONE live TuiApp per process: run the click path first, capture the frame
    // after EACH of the two Esc steps, close it, then drive the keyboard path
    // the same way and compare every step.
    const viaClick = open()
    await viaClick.vt.waitForRender()
    ;(viaClick as unknown as { invoke(line: string): unknown }).invoke(command)
    await viaClick.vt.waitForRender()
    const barRow = viaClick.rows().length - 1
    assert.match(viaClick.rows()[barRow]!, /Back \[Esc\]/u, `${command}: the direct page names its real Esc outcome`)
    await click(viaClick, barRow, colOf(viaClick, barRow, 'Back [Esc]'))
    const clicked = normalize(viaClick.view())
    viaClick.close()

    const viaKey = open()
    await viaKey.vt.waitForRender()
    ;(viaKey as unknown as { invoke(line: string): unknown }).invoke(command)
    await viaKey.vt.waitForRender()
    await key(viaKey, '\x1b')
    const keyed = normalize(viaKey.view())
    viaKey.close()

    assert.equal(clicked, keyed, `${command}: the click runs the SAME Esc ladder step as the keyboard`)
  }
})
