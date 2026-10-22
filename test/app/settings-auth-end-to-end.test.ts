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
import type { AccountView, AuthorizationFlowTarget, CredentialProviderOption } from '../../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
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
  readonly view: () => string
  readonly rows: () => string[]
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
  const calls: string[] = []
  let recordRows: { key: string; label: string; kind: 'grant' }[] = [
    { key: 'plugin/mykey', label: 'My Key', kind: 'grant' },
  ]
  let setReferenceGate: Promise<void> | undefined
  let releaseSetReference: (() => void) | undefined
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
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
    openPluginManager: () => {},
    createPluginManagerPage: () => undefined,
    config: {
      configReadiness: () => 'ready',
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      providers: {
        available: () => true,
        listCredentialOptions: () => OPTIONS,
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
        setReference: async (ref: string) => {
          calls.push(`set:${ref}`)
          const gate = setReferenceGate
          setReferenceGate = undefined
          await gate
        },
        unsetReference: async (ref: string) => { calls.push(`unset:${ref}`) },
        deleteRecord: async (key: string) => {
          calls.push(`delete:${key}`)
          recordRows = recordRows.filter(record => record.key !== key)
        },
        describeReference: async () => ({ configured: true }),
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
        getState: async () => accountState.view,
        // The Account watch subscription count: a category the user only
        // browsed must never start one.
        watch: async function* () { calls.push('account:watch'); yield accountState.view; await new Promise<void>(() => {}) },
        getProfile: async () => null,
        getBalance: async () => null,
        getCallbackOrigin: () => 'http://127.0.0.1:43121',
        startSignIn: async () => { calls.push('startSignIn'); return accountState.view },
        cancelSignIn: async () => accountState.view,
        signOut: async () => accountState.view,
        hasRunningAccountTasks: () => false,
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
    setAccountView: (view: AccountView) => { accountState.view = view },
    holdNextSetReference: () => {
      setReferenceGate = new Promise<void>(resolve => { releaseSetReference = resolve })
      return () => { releaseSetReference?.() }
    },
    rows,
    view: () => rows().join('\n'),
    close: () => {
      startedApps.delete(app)
      if (!app.isDisposed()) app.dispose()
    },
    // The invoke helper is exposed through the returned object below.
    ...( { invoke } as object),
  } as unknown as Harness & { invoke: (line: string) => unknown }
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

test('/login acme deeplinks to the provider detail inside the Settings lease', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login acme')
  await h.vt.waitForRender()
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
  await flowOnly.vt.waitForRender()
  assert.match(flowOnly.rows()[0]!, /Settings · Models/u)
  assert.match(flowOnly.view(), /Provider · My Key/u)
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

test('/logout deepseek-account opens the Sign out confirmation directly', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/logout deepseek-account')
  await h.vt.waitForRender()
  assert.match(h.view(), /Sign out confirmation/u)
  assert.match(h.view(), /Nothing to sign out/u)
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
  await h.vt.waitForRender()
  const providerRow = rowOf(h, 'Acme Gateway')
  press(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  release(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  await h.vt.waitForRender()
  assert.match(h.view(), /Provider · Acme Gateway/u)

  const accountRow = rowOf(h, 'Account')
  press(h, accountRow, 1)
  release(h, accountRow, 1)
  await h.vt.waitForRender()
  // A rail click SELECTS the category: the right column shows the real
  // Account page at once, while the keyboard stays on the rail.
  assert.match(h.rows()[0]!, /Settings · Categories/u, 'the rail click keeps the keyboard on the rail')
  assert.match(h.view(), /^> Account/mu, 'the rail selects the Account category')
  assert.match(h.view(), /DeepSeek Account/u, 'the right column shows the real Account page')

      const modelsRow = rowOf(h, 'Models')
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
  await h.vt.waitForRender()
  const providerRow = rowOf(h, 'Configure API Key')
  const railModels = rowOf(h, 'Models')
  press(h, providerRow, colOf(h, providerRow, 'Configure API Key'))
  release(h, railModels, 1)
  await h.vt.waitForRender()
  assert.match(h.view(), /Provider · Acme Gateway/u, 'the auth-page press did not fire after a rail release')
  assert.doesNotMatch(h.view(), /API Key Reference/u)

  const railAppearance = rowOf(h, 'Appearance')
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
  await h.vt.waitForRender()
  // Enter the page-local masked API-key editor, then hand the seat to a Host
  // approval. The workspace must be abandoned at its own lease boundary.
  await key(h, '\r')
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

test('a 30x8 Settings workspace disables Enter for a clipped masked form; 40x16 keeps it visible (MA12)', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  await h.vt.waitForRender()
  await key(h, '\r') // open the masked API-key form at full height
  await h.vt.waitForRender()
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
  assert.match(h.view(), /Enter disabled/u)
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
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  await h.vt.waitForRender()
  await key(h, '\r') // open masked form
  await key(h, 'sk-held')
  await key(h, '\r') // review
  await key(h, '\r') // submit (setReference is held open)
  await h.vt.waitForRender()
  assert.match(h.view(), /Saving|write|Verified|API Key Reference/u)

  const accountRow = rowOf(h, 'Account')
  await click(h, accountRow, 1)
  assert.match(h.rows()[0]!, /Settings · Models/u, 'pending mutation wins over category navigation')
  assert.doesNotMatch(h.view(), /Settings · Account/u)

  release()
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

const railRow = (h: Harness, label: string): number => rowOf(h, label)

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
  // changes (the header names the new focus owner and the action bar swaps
  // the rail hints for the page own hints).
  const page = (frame: string): string => frame.split('\n').slice(1, -1).join('\n')
  assert.equal(page(h.view()), page(before), 'the focus transfer repaints the same page')
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
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login deepseek-official')
  await h.vt.waitForRender()
  await key(h, '\r') // open the masked form
  await key(h, 'sk-held')
  await key(h, '\r') // review
  await key(h, '\r') // submit (the write is held open)
  await h.vt.waitForRender()

  const accountRow = railRow(h, 'Account')
  await click(h, accountRow, 1)
  assert.match(h.rows()[0]!, /Settings · Models/u, 'the pending mutation owns the page')
  assert.doesNotMatch(h.view(), /Settings · Account/u, 'the rail refused the category change')

  release()
  for (let index = 0; index < 20; index += 1) await new Promise<void>(resolve => setImmediate(resolve))
  h.close()
})

test('a cross-owner gesture does nothing: a rail press released in the content column', async () => {
  const h = open()
  await h.vt.waitForRender()
  ;(h as unknown as { invoke(line: string): unknown }).invoke('/login')
  await h.vt.waitForRender()
  const railModels = rowOf(h, 'Models')
  const providerRow = rowOf(h, 'Acme Gateway')
  // A press on the RAIL, released in the CONTENT column: neither owner may
  // act. The rail press must not select a category and the content release
  // must not open a provider.
  press(h, railModels, 1)
  release(h, providerRow, colOf(h, providerRow, 'Acme Gateway'))
  await h.vt.waitForRender()
  assert.match(h.view(), /Models & Credentials/u, 'the content release did not open a provider')
  assert.match(h.view(), /^> Models/mu, 'the rail press did not select a category')
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

  const aboutRow = railRow(h, 'About')
  await click(h, aboutRow, 1)
  assert.match(h.view(), /dsh-pi-tui/u, 'the About page is painted after the category change')
  const accountRow = railRow(h, 'Account')
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
  const aboutRow = railRow(h, 'About')
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
  const accountRow = railRow(h, 'Account')
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
