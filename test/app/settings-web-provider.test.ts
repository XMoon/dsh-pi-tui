/**
 * S2/PR-B §3.3/§3.4 — the `/settings` Web Search / Fetch surface (L6).
 *
 * The user-visible chain: `/settings` → the `Other` category → `Web Search /
 * Fetch` → the EXISTING legacy editor focused on the Web section → a selector
 * commits through the ConfigPort → the row is reconciled from the authoritative
 * read-back → closing and reopening shows the committed value.
 *
 * FIXTURE (real): the production `/settings` command registration, the real
 * `TuiApp`/Settings workspace/legacy editor, the real key routing and the real
 * `VirtualTerminal` frames. STAND-IN: the Host config service behind the
 * ConfigPort sub-domain (records the exact semantic calls and owns the store the
 * read-back returns) — the real official settings plane is qualified by
 * `web-provider-rc2-integration.test.ts`. ABSENT: a real Session, a real model,
 * the network.
 *
 * @module @xmoon76/dsh-pi-tui/settings-web-provider.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import test, { afterEach } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { TuiSettingsDoc, WebProviderSettings } from '../../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const DOWN = '\x1b[B'
const ENTER = '\r'
const TAB = '\t'
const ESC = '\x1b'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

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
  /** Every semantic Web write, in order. */
  readonly writes: readonly string[]
  /** Every `/login` | `/logout` line the section delegated. */
  readonly delegated: readonly string[]
  /** The live (fake) Host store the read-back answers from. */
  readonly store: {
    web: WebProviderSettings
    available: boolean
    failNext: string | undefined
    readThrows: boolean
    /** A mounted section whose facts do not validate (read() answers undefined). */
    readUndefined: boolean
    /** Artificial delay for one Host write (the FIFO order proof). */
    writeDelayMs: number
    /** The value the Host actually KEEPS after a successful endpoint write (the
     *  official store's canonical form of the submitted base); undefined = the
     *  submitted URL verbatim. */
    endpointStoredValue: string | undefined
    /** The provider id the Host actually KEEPS after a successful mutation (a
     *  competing external writer / the official store's own answer); undefined =
     *  the submitted id verbatim. */
    keptProviderValue: string | undefined
  }
  /** How many authority reads were ISSUED (the newest-read witnesses). */
  readonly readCount: () => number
  /** How many Web writes overlapped (must never exceed 1: ONE owner FIFO). */
  readonly maxConcurrentWrites: () => number
  /** The write labels in COMMIT order. */
  readonly log: readonly string[]
  /** Hold the NEXT authority read until the returned release is called. */
  readonly holdRead: () => () => void
  readonly view: () => string
  readonly invoke: (name?: string) => unknown
  readonly dispose: () => void
}

function setup(options: {
  readonly columns?: number
  readonly rows?: number
  readonly available?: boolean
  readonly searchProvider?: string
}
= {}): Harness {
  const columns = options.columns ?? 140
  const vt = new VirtualTerminal(columns, options.rows ?? 40)
  const writes: string[] = []
  const delegated: string[] = []
  let activeWrites = 0
  let maxActiveWrites = 0
  const log: string[] = []
  let readGate: { readonly promise: Promise<void>; readonly release: () => void } | undefined
  let readsIssued = 0
  const store = {
    available: options.available ?? true,
    failNext: undefined as string | undefined,
    readThrows: false,
    readUndefined: false,
    writeDelayMs: 0,
    endpointStoredValue: undefined as string | undefined,
    keptProviderValue: undefined as string | undefined,
    web: {
      searchProvider: options.searchProvider ?? 'deepseek-official',
      fetchProvider: 'http',
      api: { baseURL: 'https://api.deepseek.com/v1/tools', count: 10, sendOriginalQuestion: true },
      credential: { configured: true, source: 'file' },
    } as WebProviderSettings,
  }
  const doc: TuiSettingsDoc = { ...DEFAULT_DOC }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const clientCommands = createClientCommandRegistry(parseCommand)
  const originalExecute = clientCommands.execute.bind(clientCommands)
  clientCommands.execute = async request => {
    delegated.push(request.line)
    return originalExecute(request)
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  const write = async (label: string, apply: () => void, delayMs = 0): Promise<void> => {
    activeWrites += 1
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
    log.push(`begin:${label}`)
    try {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      if (store.failNext !== undefined) {
        const reason = store.failNext
        store.failNext = undefined
        throw new Error(reason)
      }
      writes.push(label)
      log.push(label)
      apply()
    } finally {
      activeWrites -= 1
    }
  }
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands,
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    // C3 About seams: this fixture composes no StatusRuntime, so the
    // sessionless capture is the only reachable state (no scoped read can
    // start). The subscription STILL must return a real disposer: opening
    // `/settings` builds the About controller, its close calls `dispose()`,
    // and a non-function return would abort the TuiApp teardown and leak the
    // process slot into every later test.
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: () => ({ kind: 'unchanged' }),
    refreshStatus: () => {},
    tuiSettings: { get: () => doc, replace: (next: TuiSettingsDoc) => { Object.assign(doc, next) } },
    config: settingsDirectPageConfig({
      configReadiness: () => 'ready',
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      credentials: {
        available: () => true,
        describeReference: async () => ({ configured: true, source: 'file' }),
      },
      web: {
        available: () => store.available,
        read: async () => {
          readsIssued += 1
          const gate = readGate
          readGate = undefined
          // A held read stays the snapshot of the moment it was ISSUED: a real
          // Host read cannot observe a write that happens while it is pending.
          const captured = { ...store.web, api: { ...store.web.api } }
          const throws = store.readThrows
          const unreadable = !store.available || store.readUndefined
          if (gate !== undefined) await gate.promise
          if (throws) throw new Error('settings descriptor unreadable')
          if (unreadable) return undefined
          return captured
        },
        setSearchProvider: async (id: string) => { await write(`search:${id}`, () => { store.web.searchProvider = store.keptProviderValue ?? id }, store.writeDelayMs) },
        setFetchProvider: async (id: string) => { await write(`fetch:${id}`, () => { store.web.fetchProvider = id }) },
        setSearchApiCount: async (count: number) => { await write(`count:${count}`, () => { store.web.api.count = count }) },
        setSendOriginalQuestion: async (enabled: boolean) => { await write(`ori:${String(enabled)}`, () => { store.web.api.sendOriginalQuestion = enabled }) },
        setSearchApiBaseURL: async (url: string) => { await write(`endpoint:${url}`, () => { store.web.api.baseURL = store.endpointStoredValue ?? url }) },
      },
    }),
    catalog: { models: { available: () => false } },
    // Explicitly ABSENT: the Proxy fallback would otherwise hand the legacy
    // editor a truthy function for a missing optional owner.
    extensions: undefined,
    openPluginManager: () => {},
    createPluginManagerPage: () => undefined,
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    setFocusMode: () => {},
    setNotificationMethod: () => {},
    setNotificationMode: () => {},
    setTerminalProgressMode: () => {},
    setSessionApprovalPolicy: () => 'applied',
    currentApprovalOverride: () => undefined,
    applyFooterSettings: () => {},
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name = 'settings'): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/gu, '')).join('\n')
  return {
    vt,
    writes,
    delegated,
    store,
    readCount: () => readsIssued,
    maxConcurrentWrites: () => maxActiveWrites,
    log,
    holdRead: () => {
      let release = (): void => {}
      const promise = new Promise<void>(resolve => { release = () => resolve() })
      readGate = { promise, release }
      return release
    },
    view,
    invoke,
    dispose: () => {
      startedApps.delete(app)
      if (!app.isDisposed()) app.dispose()
    },
  }
}

/** One key press, rendered to quiescence (the workspace routes input through
 *  its own render loop, so a burst without renders races the projection). */
async function key(h: Harness, data: string): Promise<void> {
  h.vt.sendInput(data)
  await h.vt.waitForRender()
}

/** Open `/settings` and reach the `Other settings` rows level. */
async function openOtherRows(h: Harness): Promise<void> {
  h.invoke('settings')
  for (let attempt = 0; attempt < 20 && !h.view().includes('Settings ·'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await h.vt.waitForRender()
  }
  // The rail order is About, Models, Account, Appearance, Display, Plugins,
  // Other settings: six Down presses reach the legacy launcher category.
  const downs = Array.from({ length: 6 }, () => DOWN)
  // The workspace opens on the About home: walk the rail to the legacy
  // launcher category, then enter its Rows level.
  await selectSettingsCategory(h.vt, 'Other settings')
  const keys = h.vt.columns >= 96 ? [TAB, TAB, ENTER] : [ENTER]
  for (const pressed of keys) await key(h, pressed)
}

/** Drive `/settings` to the Web Search / Fetch row through the real workspace
 *  keys (categories → Other settings → the Web row), then open it. */
async function openWebSection(h: Harness): Promise<void> {
  await openOtherRows(h)
  await key(h, DOWN)
  await key(h, ENTER)
  // Both the Workspace row and the section start PENDING and settle with the
  // authoritative read; every assertion below is about the settled facts (the
  // transient frames have their own tests, which hold the read themselves).
  for (let attempt = 0; attempt < 40 && h.view().includes('Loading…'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await h.vt.waitForRender()
  }
}

/** Let one asynchronous settle land and render to quiescence. */
async function settle(h: Harness, ms = 20): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
  await h.vt.waitForRender()
}

/** Open the Web section's endpoint editor on its CURRENT value and confirm the
 *  draft through the real panel keys (Enter opens the submenu, Enter submits). */
async function confirmEndpointDraft(h: Harness): Promise<void> {
  for (let index = 0; index < 4; index += 1) await key(h, DOWN)
  await key(h, ENTER)
  await key(h, ENTER)
  await settle(h)
}

test('the workspace row reports the configured providers and opens the Web section focused', async t => {
  const h = setup()
  t.after(h.dispose)
  h.invoke('settings')
  await h.vt.waitForRender()
  // The Other category's Web row carries the live configured summary. The
  // workspace opens on the About home: walk the rail to Other settings first.
  await selectSettingsCategory(h.vt, 'Other settings')
  for (const pressed of [TAB, TAB, ENTER]) await key(h, pressed)
  assert.match(h.view(), /Web Search \/ Fetch/u)
  // Select the launcher row: its Detail carries the authoritative summary and
  // the billing/credential/Enter-configure facts (the narrow row column only
  // shows the summary prefix).
  await key(h, DOWN)
  const rowView = h.view()
  const compactRow = (): string => rowView.replace(/[\u2500-\u257f│]/gu, ' ').replace(/\s+/gu, ' ')
  assert.match(rowView, /Search: Messages · Fetch: HTTP/u, 'the launcher shows the authoritative provider summary')
  assert.match(compactRow(), /billed separately/u)
  assert.match(compactRow(), /not an Optional.*?Bundle/u)
  assert.match(compactRow(), /Share Original Question is on by default/u)
  assert.match(compactRow(), /up to 128 characters/u)
  assert.match(compactRow(), /authoritative read-back agree/u)
  assert.match(compactRow(), /credential reference/u)
  assert.match(compactRow(), /Enter configure/u)

  // Enter on the launcher row crosses the real Workspace -> Legacy handoff.
  await key(h, ENTER)
  assert.match(h.view(), /Web Search Provider/u, 'the legacy editor opened at the Web section')
  assert.match(h.view(), /Web Search Provider +\[current\] \[default\]/u,
    'the current value and the packaged default are INDEPENDENT state chips')
  assert.match(h.view(), /Current: Messages/u, 'the selected row states the current value in full')
  // The deeplink focused the FIRST Web row: Enter commits the search provider.
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, ['search:deepseek-search-api'])
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
  assert.match(h.view(), /Web Search Provider +\[current\] +│/u,
    'the verified read-back keeps the current chip on the selected candidate')
  assert.match(h.view(), /Current: DeepSeek Search API/u, 'the selected row states the new value in full')
  assert.doesNotMatch(h.view(), /Web Search Provider +\[current\] \[default\]/u,
    'the non-default candidate never claims the packaged default')
})

test('a failed write reverts the row and never reports a save', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  h.store.failNext = 'settings mutate rejected'
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'the Host store keeps the previous value')
  assert.match(h.view(), /Web settings · Not saved: settings mutate rejected/u, 'the failure is reported as Not saved')
})

test('rapid conflicting selections commit in order and the row ends on the verified value', async t => {
  const h = setup({ searchProvider: 'deepseek-search-api' })
  t.after(h.dispose)
  await openWebSection(h)
  // Two intents in the same burst: never two concurrent writes, last one wins.
  await key(h, ENTER)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, ['search:deepseek-official', 'search:deepseek-search-api'])
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
  assert.match(h.view(), /DeepSeek Search API/u, 'the row shows the authoritative read-back')
})

test('a resolved provider mutation the Host does not commit is Not saved, never a save', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /Current: Messages/u, 'the section starts from the settled facts')

  // The mutation RESOLVES, but the Host's own answer keeps Messages (a competing
  // external writer / the official store's canonical answer): only the read-back
  // decides, so this is never reported as a save.
  h.store.keptProviderValue = 'deepseek-official'
  await key(h, ENTER)
  await settle(h)
  assert.deepEqual(h.writes, ['search:deepseek-search-api'], 'the mutation really ran')
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'the Host kept its own value')
  const refusedRow = h.view().split('\n').find(line => line.includes('Web Search Provider')) ?? ''
  assert.match(refusedRow, /\[Not saved\]/u, `the row reports the Host's answer:\n${h.view()}`)
  assert.doesNotMatch(refusedRow, /\[current\]/u, 'the row never claims a verified value')
  assert.match(h.view(), /Current: Not saved/u, 'the row Detail states the same verdict')

  // The selector went back to the value the Host HOLDS: the next Enter resumes
  // the cycle from Messages (-> DeepSeek Search API), never from the rejected
  // intent — which would have submitted Messages a second time.
  await key(h, ENTER)
  await settle(h)
  assert.deepEqual(h.writes, ['search:deepseek-search-api', 'search:deepseek-search-api'],
    'the selector sits on the Host value, not on the rejected intent')
})

test('two selections on the same row end on the Host value when the second is not committed', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)

  // First intent (Messages -> DeepSeek Search API): committed and verified.
  await key(h, ENTER)
  await settle(h)
  assert.deepEqual(h.writes, ['search:deepseek-search-api'])
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
  const verifiedRow = h.view().split('\n').find(line => line.includes('Web Search Provider')) ?? ''
  assert.match(verifiedRow, /\[current\]/u, 'the first selection is verified')

  // Second intent on the SAME row (back to Messages) resolves, but the Host
  // keeps the first selection.
  h.store.keptProviderValue = 'deepseek-search-api'
  await key(h, ENTER)
  await settle(h)
  assert.deepEqual(h.writes, ['search:deepseek-search-api', 'search:deepseek-official'],
    'the second intent really ran')
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api', 'the Host keeps the first selection')
  const refusedRow = h.view().split('\n').find(line => line.includes('Web Search Provider')) ?? ''
  assert.match(refusedRow, /\[Not saved\]/u, `the row reports the refused second intent:\n${h.view()}`)

  // The row's cursor is the value the Host kept, so the next cycle submits
  // Messages again; a transient verdict word in that field (or the rejected
  // intent left in it) would have resumed the cycle from the wrong position.
  await key(h, ENTER)
  await settle(h)
  assert.deepEqual(
    h.writes,
    ['search:deepseek-search-api', 'search:deepseek-official', 'search:deepseek-official'],
    'the selector sits on the value the Host kept',
  )
})

test('the Web section deeplink is reachable from the workspace and Esc cancels without a write', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  await key(h, DOWN)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, ['fetch:deepseek-fetch-api'], 'the second row is the fetch provider')
  await key(h, ESC)
  assert.deepEqual(h.writes, ['fetch:deepseek-fetch-api'], 'Esc after a commit writes nothing else')
})

test('closing and reopening the section shows the committed values', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, ['search:deepseek-search-api'])
  // Esc from the Web section restores the Workspace (v2 §B3.4); the restored
  // workspace then needs its own Esc ladder to reach the conversation.
  await key(h, ESC)
  assert.match(h.view(), /Settings · Other/u)
  await key(h, ESC)
  await key(h, ESC)
  // Reopen the whole surface: the row summary and the section read the store.
  await openWebSection(h)
  assert.match(h.view(), /DeepSeek Search API/u, 'the reopened section shows the committed value')
})

test('an unavailable section offers no write and no submenu', async t => {
  const h = setup({ available: false })
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /\[unavailable\]/u, 'every Web row states the unavailable fact')
  // The rows carry no values to cycle and no submenu: Enter is inert, and the
  // workspace summary states the backend limitation.
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [])
})

test('the credential row delegates to the existing /login and /logout command lines', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  // Reach the credential row (the sixth Web row) and open its action panel.
  for (let index = 0; index < 5; index += 1) await key(h, DOWN)
  await key(h, ENTER)
  assert.match(h.view(), /DeepSeek API Key/u)
  assert.match(h.view(), /Configure/u)
  assert.match(h.view(), /Configured/u, 'the live presence/source comes from the credential store')
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.delegated, ['/login DEEPSEEK_API_KEY'],
    'the panel closed the editor and delegated to the existing command path')
})

test('Esc from the Web section restores the Settings workspace on the Web launcher row', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  await key(h, ESC)
  assert.match(h.view(), /Settings · Other/u, 'the legacy editor closed back into the Settings workspace')
  assert.match(h.view(), /Web Search \/ Fetch/u)
  // The restored workspace carries the Web row's OWN detail (the launcher row),
  // never the default theme row.
  assert.match(h.view(), /Host Web settings/u)
  assert.match(h.view(), /Search: Messages · Fetch: HTTP/u)
})

test('a configured custom provider id stays visible, marked unavailable and not selectable', async t => {
  const h = setup({ searchProvider: 'acme-search' })
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /acme-search/u, 'the custom route is reported as-is')
  assert.match(h.view(), /\[unavailable\]/u, 'it is marked unavailable for this selector')
  assert.match(h.view(), /Current: acme-search/u)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'a custom route is never silently replaced by a cycle')
})

test('the endpoint editor joins the SAME FIFO: no Web write overlaps another', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.writeDelayMs = 150
  await openWebSection(h)
  // Queue the (slow) provider write, then immediately open the endpoint editor
  // and confirm it: with ONE owner FIFO the endpoint write starts only after the
  // provider write settled.
  await key(h, ENTER)
  for (let index = 0; index < 4; index += 1) await key(h, DOWN)
  await key(h, ENTER)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 200))
  await h.vt.waitForRender()
  assert.deepEqual(h.log, [
    'begin:search:deepseek-search-api',
    'search:deepseek-search-api',
    'begin:endpoint:https://api.deepseek.com/v1/tools',
    'endpoint:https://api.deepseek.com/v1/tools',
  ], 'the endpoint write does not even START until the pending selection settled')
  assert.equal(h.maxConcurrentWrites(), 1, 'never two Web writes in flight at once')
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
})

test('an unreadable authority after a successful read drops to Unavailable, never a stale current', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /\[current\]/u, 'the first read paints the verified state')
  // Leave the editor, close the workspace and make the authority fail.
  await key(h, ESC)
  await key(h, ESC)
  await key(h, ESC)
  h.store.readThrows = true
  await openOtherRows(h)
  assert.match(h.view(), /Unavailable/u, 'the launcher states the failure')
  assert.doesNotMatch(h.view(), /Search: Messages/u, 'the old summary never survives as current')
  await key(h, DOWN)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  const providerLine = h.view().split('\n').find(line => line.includes('Web Search Provider')) ?? ''
  assert.doesNotMatch(providerLine, /\[current\]|\[default\]/u,
    'no legacy row claims a current/default value it cannot read')
  assert.match(providerLine, /\[unavailable\]|Unavailable/u)
  assert.match(h.view(), /Current: Unavailable/u)
})

test('a half-mounted Web configuration is unavailable and offers no write', async t => {
  const h = setup({ available: false })
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /\[unavailable\]/u)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'an unreadable configuration never accepts a write')
})

test('a mounted but MALFORMED Web section reads as unavailable and accepts no write', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.readUndefined = true
  await openWebSection(h)
  assert.match(h.view(), /Unavailable/u, 'an unreadable section is stated, never shown as current')
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'a malformed section never accepts a write')
  const providerLine = h.view().split('\n').find(line => line.includes('Web Search Provider')) ?? ''
  assert.doesNotMatch(providerLine, /\[current\]/u)
})

test('a workspace opened while the authority is pending paints Loading…, never the previous state', async t => {
  const h = setup()
  t.after(h.dispose)
  // A first, settled read: the summary is known and would be the cached value.
  await openWebSection(h)
  assert.match(h.view(), /\[current\]/u, 'the settled read paints the verified state')
  await key(h, ESC)
  await key(h, ESC)
  await key(h, ESC)

  const release = h.holdRead()
  t.after(release)
  h.invoke('settings')
  // The held read cannot settle, so every frame painted before it settles is
  // the pending state (without the pre-snapshot pending entry these frames
  // would carry the previous summary as current).
  await h.vt.waitForRender()
  for (const pressed of h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER] : [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]) await key(h, pressed)
  const firstFrame = h.view()
  assert.match(firstFrame, /Loading…/u, `the first frames of the reopened workspace are pending:\n${firstFrame}`)
  assert.doesNotMatch(firstFrame, /Search: Messages/u,
    'the previous summary is never presented as the current state')

  // The settled read then repaints the SAME generation.
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  const settled = h.view()
  assert.match(settled, /Search: Messages/u, `the settled read paints the facts:\n${settled}`)
  assert.doesNotMatch(settled, /Loading…/u)
})

test('a new read clears the previous read ERROR: pending, not a stale Unavailable', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.readThrows = true
  await openWebSection(h)
  assert.match(h.view(), /Unavailable/u, 'the failed read is stated')
  await key(h, ESC)
  await key(h, ESC)
  await key(h, ESC)

  h.store.readThrows = false
  const release = h.holdRead()
  t.after(release)
  h.invoke('settings')
  await h.vt.waitForRender()
  for (const pressed of h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER] : [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]) await key(h, pressed)
  const firstFrame = h.view()
  assert.match(firstFrame, /Loading…/u, `the reopened workspace is pending again:\n${firstFrame}`)
  assert.doesNotMatch(firstFrame, /Unavailable/u, 'the previous error state does not survive into the new read')
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.match(h.view(), /Search: Messages/u)
})

test('the workspace `r` refresh re-enters pending instead of repainting the cached summary', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  // Esc returns to the Workspace ON the Web row (rows level, already focused).
  await key(h, ESC)
  assert.match(h.view(), /Settings · Other settings/u, 'Esc restored the Workspace rows level')
  assert.match(h.view(), /Search: Messages/u, 'the settled summary is visible on the rows level')

  const release = h.holdRead()
  t.after(release)
  await key(h, 'r')
  const pending = h.view()
  assert.match(pending, /Loading…/u, `the refresh enters the pending state:\n${pending}`)
  assert.doesNotMatch(pending, /Search: Messages/u, 'the cached summary is not repainted while the read is pending')
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.match(h.view(), /Search: Messages/u)
})

test('entering the legacy Web section paints Loading…, never the last-known value', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /\[current\]/u, 'the settled section paints the verified state')
  await key(h, ESC)
  assert.match(h.view(), /Settings · Other settings/u)

  // Hold the read the section's own mount will request.
  const release = h.holdRead()
  t.after(release)
  await key(h, ENTER)
  const pending = h.view()
  assert.match(pending, /\[Loading…\]/u, `the section starts pending:\n${pending}`)
  const pendingRow = pending.split('\n').find(line => line.includes('Web Search Provider')) ?? ''
  assert.doesNotMatch(pendingRow, /\[current\]|\[default\]/u,
    'no row claims a current/default value while the read is in flight')
  assert.match(pending, /Current: Loading…/u, 'the description states the pending fact')

  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  const settled = h.view()
  assert.match(settled, /\[current\]/u, `the mounted read repaints the verified state:\n${settled}`)
  assert.match(settled, /Current: Messages/u)
  assert.doesNotMatch(settled, /Loading…/u)
})

test('a section reopened after a FAILED read states Loading…, not the stale error', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.readThrows = true
  await openWebSection(h)
  assert.match(h.view(), /Unavailable/u, 'the failure is stated')
  await key(h, ESC)

  h.store.readThrows = false
  const release = h.holdRead()
  t.after(release)
  await key(h, ENTER)
  const pending = h.view()
  assert.match(pending, /\[Loading…\]/u, `the reopened section is pending:\n${pending}`)
  assert.doesNotMatch(pending, /Current: Unavailable/u, 'the previous read error does not survive into the new read')
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.match(h.view(), /Current: Messages/u)
})

test('an OLD read settling after a write never repaints the reopened Workspace (owner-generation fence)', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /Current: Messages/u, 'the section starts from the settled facts')
  await key(h, ESC)
  assert.match(h.view(), /Settings · Other settings/u, 'Esc restored the Workspace rows level')

  // Hold the Workspace's own read (R_ws1): it observes the PRE-write Host state
  // and will settle LAST, after the write and a newer Workspace read.
  const release = h.holdRead()
  t.after(release)
  await key(h, ESC)
  await key(h, ESC) // leave the Settings surface entirely
  // Re-enter: the workspace open starts a read, which the gate holds.
  h.invoke('settings')
  await h.vt.waitForRender()
  for (const pressed of h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER] : [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]) await key(h, pressed)
  await key(h, DOWN)
  await key(h, ENTER)
  for (let attempt = 0; attempt < 40 && h.view().includes('Loading…'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await h.vt.waitForRender()
  }
  assert.match(h.view(), /\[current\]/u, 'the section settled from the newest read')

  // A real write, then Esc back to the Workspace (whose own read is newer).
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, ['search:deepseek-search-api'], 'the write committed')
  await key(h, ESC)
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  assert.match(h.view(), /Search: DeepSeek Search API/u, `the Workspace shows the committed facts:\n${h.view()}`)

  // The OLD held read settles now: it must NOT repaint the Workspace with the
  // pre-write summary.
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  const after = h.view()
  assert.match(after, /Search: DeepSeek Search API/u, `the committed facts survive the stale settlement:\n${after}`)
  assert.doesNotMatch(after, /Search: Messages/u, 'the pre-write summary never comes back')
})

test('a SUPERSEDED write readback never decides the verdict (owner-generation fence)', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  assert.match(h.view(), /Current: Messages/u)

  // The write's readback captures an UNREADABLE Host (the mutation itself still
  // commits); it is held while a NEWER read observes the post-write facts.
  h.store.readUndefined = true
  const release = h.holdRead()
  t.after(release)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, ['search:deepseek-search-api'], 'the mutation committed')

  // A newer read (Esc → the restored Workspace) observes the post-write Host and
  // commits those facts.
  h.store.readUndefined = false
  await key(h, ESC)
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  assert.match(h.view(), /Search: DeepSeek Search API/u, 'the newer read committed the post-write facts')

  // The superseded readback settles now: it must not turn the committed result
  // into a stale `Outcome unknown`/`Not saved`, and the rows keep the newest
  // authority facts.
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  const after = h.view()
  assert.doesNotMatch(after, /Outcome unknown|Not saved/u,
    `no stale verdict leaks into the surface:\n${after}`)
  assert.match(after, /Search: DeepSeek Search API/u, 'the newest facts survive')

  // Re-open the section: the superseded readback must not have left a stale
  // verdict phase on the row (the reopened row states the verified value).
  await key(h, ENTER)
  for (let attempt = 0; attempt < 40 && h.view().includes('Loading…'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await h.vt.waitForRender()
  }
  const reopened = h.view()
  assert.doesNotMatch(reopened, /\[Outcome unknown\]|\[Not saved\]/u,
    `the reopened row carries no stale verdict:\n${reopened}`)
  assert.match(reopened, /\[current\]/u, 'the reopened row states the verified value')
})

test('a superseded readback settling while the newer read is STILL pending never judges', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)

  // R1 (the write's readback) captures an unreadable Host and is held.
  h.store.readUndefined = true
  const releaseR1 = h.holdRead()
  t.after(releaseR1)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, ['search:deepseek-search-api'], 'the mutation committed')

  // A NEWER read R2 starts (Esc → the restored Workspace) and is ALSO held, so
  // it is pending when R1 settles.
  const releaseR2 = h.holdRead()
  t.after(releaseR2)
  h.store.readUndefined = false
  await key(h, ESC)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.match(h.view(), /Loading…/u, 'the newer read is still pending')

  // R1 settles first: the row must stay PENDING, never a stale verdict.
  releaseR1()
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  const pending = h.view()
  assert.doesNotMatch(pending, /Outcome unknown|Not saved/u,
    `a superseded readback must not judge while the newer read is pending:\n${pending}`)

  // R2 settles: the newest facts decide, with no stale verdict left behind.
  releaseR2()
  await new Promise(resolve => setTimeout(resolve, 20))
  await h.vt.waitForRender()
  const settled = h.view()
  assert.match(settled, /Search: DeepSeek Search API/u, `the newest facts win:\n${settled}`)
  await key(h, ENTER)
  for (let attempt = 0; attempt < 40 && h.view().includes('Loading…'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await h.vt.waitForRender()
  }
  const reopened = h.view()
  assert.doesNotMatch(reopened, /\[Outcome unknown\]|\[Not saved\]/u,
    `the reopened row carries no stale verdict:\n${reopened}`)
  assert.match(reopened, /\[current\]/u)
})

/**
 * One SUPERSEDED endpoint-readback scenario. R1 (the write's verification read)
 * is held while it observes an UNREADABLE Host, so a verdict taken from the
 * superseded snapshot would be wrong in every scenario; the verdict must come
 * from the NEWEST read. `arrangeNewest` sets what that newest read observes and
 * `assertVerdict` checks the row's settled state.
 */
function supersededEndpointCase(
  name: string,
  arrangeNewest: (h: Harness) => void,
  assertVerdict: (frame: string, columns: number, h: Harness) => Promise<void> | void,
): void {
  for (const [columns, rows] of SUPERSEDED_SIZES) test(`a superseded endpoint readback is judged by the NEWEST read at ${columns}x${rows}: ${name}`, async t => {
    const h = setup({ columns, rows })
    t.after(h.dispose)
    await openWebSection(h)
    const readsBefore = h.readCount()

    h.store.readUndefined = true
    const releaseR1 = h.holdRead()
    t.after(releaseR1)
    await confirmEndpointDraft(h)
    assert.deepEqual(h.writes, ['endpoint:https://api.deepseek.com/v1/tools'], 'the endpoint mutation committed')
    assert.match(h.view(), /Saving…/u, 'the real endpoint panel verifies before it settles')
    assert.equal(h.readCount(), readsBefore + 1, 'the write issued its verification read R1')

    // R2: the FIRST Esc only cancels the panel (the open submenu owns the key);
    // the SECOND leaves the Web section, and the RESTORED Workspace starts the
    // newer read — held, so it is still pending when R1 settles.
    h.store.readUndefined = false
    arrangeNewest(h)
    const releaseR2 = h.holdRead()
    t.after(releaseR2)
    await key(h, ESC)
    // The endpoint row's LABEL truncates at the 44-column floor, so the needle
    // is the part every size keeps: the first Esc closed only the submenu.
    assert.ok(h.view().includes('Search / Fetch'), 'the first Esc only closed the endpoint submenu')
    await key(h, ESC)
    assert.ok(h.view().includes('Settings · Other'), 'the restored Workspace owns the surface')
    assert.match(h.view(), /Loading…/u, 'the newer read R2 is pending')
    assert.equal(h.readCount(), readsBefore + 2, 'R2 really started — never a no-op witness')

    // R1 settles while R2 is pending: the superseded snapshot must NOT decide.
    releaseR1()
    await settle(h)
    assert.doesNotMatch(h.view(), /\[Outcome unknown\]|\[Not saved\]/u,
      `a superseded readback must not judge while the newest read is pending:\n${h.view()}`)

    // A read STARTED during the wait (re-entering the section) is the newer
    // authority: R2's own settlement must not decide either.
    const releaseR3 = h.holdRead()
    t.after(releaseR3)
    await key(h, ENTER)
    assert.equal(h.readCount(), readsBefore + 3, 're-entering the section issued the newer read R3')
    releaseR2()
    await settle(h)
    assert.doesNotMatch(h.view(), /\[Outcome unknown\]|\[Not saved\]/u,
      `R2 must not judge while R3 is pending:\n${h.view()}`)

    // R3 (the newest authority) settles: ITS facts decide the verdict.
    releaseR3()
    await settle(h)
    for (let index = 0; index < 4; index += 1) await key(h, DOWN)
    await assertVerdict(h.view(), columns, h)
  })
}

/** The frozen sizes for the changed verdict sink. */
const SUPERSEDED_SIZES = [[120, 40], [80, 10], [44, 20]] as const

supersededEndpointCase(
  'the newest read observed the submitted endpoint',
  () => {},
  (frame, columns) => {
    assert.doesNotMatch(frame, /\[Outcome unknown\]|\[Not saved\]/u, `a verified write leaves no verdict:\n${frame}`)
    if (columns >= 120) {
      assert.ok(frame.includes('Current: https://api.deepseek.com/v1/tools'),
        `the row states the verified endpoint:\n${frame}`)
    }
  },
)

supersededEndpointCase(
  'the Host kept another value',
  h => { h.store.web.api.baseURL = 'https://other.example/v1' },
  async (frame, columns, h) => {
    // R1 was UNREADABLE: an `Outcome unknown` here would be the superseded
    // snapshot's answer, so `Not saved` proves the NEWEST facts decided.
    assert.match(frame, /\[Not saved\]/u, `a kept value is reported as Not saved:\n${frame}`)
    assert.doesNotMatch(frame, /Outcome unknown/u, `the superseded snapshot never decides:\n${frame}`)
    // The endpoint panel (whose own message named the Host's value) is already
    // closed when a superseded verdict lands, so the ROW's Detail has to carry
    // the newest authority value or the user never sees it.
    // The 44-column floor drops the Detail description (the frozen drop order):
    // there the value is read from the endpoint editor, which always opens on
    // the authoritative value.
    if (columns < 80) {
      await key(h, ENTER)
      assert.ok(h.view().includes('https://other.example/v1'),
        `the endpoint editor opens on the value the Host keeps at ${columns} columns:\n${h.view()}`)
      await key(h, ESC)
    }
    if (columns >= 80) {
      assert.ok(frame.includes('Current: Not saved'), `the row states the verdict:\n${frame}`)
      assert.ok(frame.includes('the Host keeps "https://other.example/v1"'),
        `the row reports the value the Host actually keeps:\n${frame}`)
    }
  },
)

supersededEndpointCase(
  'the newest read could not read the Host',
  h => { h.store.readUndefined = true },
  (frame, columns) => {
    assert.match(frame, /\[Outcome unknown\]/u, `an unobservable result is Outcome unknown:\n${frame}`)
    if (columns >= 120) {
      assert.ok(frame.includes('Current: Outcome unknown'), `the row states the same verdict:\n${frame}`)
    }
  },
)

test('a superseded write holds the ONE owner FIFO until the newest read settles', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.writeDelayMs = 150
  await openWebSection(h)

  // write1 (a slow provider selection) is queued first and its verification read
  // R1 is HELD. write2 (the endpoint save) is queued behind it while write1's
  // Host write still runs — the rows stay selectable until a read starts.
  const releaseR1 = h.holdRead()
  t.after(releaseR1)
  await key(h, ENTER)
  for (let index = 0; index < 4; index += 1) await key(h, DOWN)
  await key(h, ENTER)
  await key(h, ENTER)
  await settle(h, 250)
  assert.deepEqual(h.writes, ['search:deepseek-search-api'], 'write1 committed while write2 still waits')
  assert.equal(h.maxConcurrentWrites(), 1, 'never two Web writes in flight at once')
  const readsBeforeR2 = h.readCount()

  // R2 (the restored Workspace's read) supersedes R1 and stays pending.
  const releaseR2 = h.holdRead()
  t.after(releaseR2)
  await key(h, ESC)
  await key(h, ESC)
  assert.match(h.view(), /Loading…/u, 'the newer read R2 is pending')
  assert.equal(h.readCount(), readsBeforeR2 + 1, 'R2 really started')

  // R1 settles: write1's verdict waits for R2, so its successor must NOT start.
  releaseR1()
  await settle(h)
  assert.ok(!h.log.some(entry => entry.startsWith('begin:endpoint:')),
    `write2 must not start while the newest read is pending:\n${h.log.join('\n')}`)
  releaseR2()
  await settle(h)
  assert.ok(h.log.some(entry => entry.startsWith('begin:endpoint:')),
    `write2 starts once the newest read settled:\n${h.log.join('\n')}`)
  assert.deepEqual(h.writes, ['search:deepseek-search-api', 'endpoint:https://api.deepseek.com/v1/tools'])
})

test('a verified endpoint save closes the panel on the Host value', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  await confirmEndpointDraft(h)
  assert.deepEqual(h.writes, ['endpoint:https://api.deepseek.com/v1/tools'], 'the mutation committed')
  assert.doesNotMatch(h.view(), /Enter confirm · Esc cancel/u, 'the verified save closed the panel')
  assert.ok(h.view().includes('Current: https://api.deepseek.com/v1/tools'),
    `the row states the verified endpoint:\n${h.view()}`)
})

test('the endpoint editor reports Not saved with the value the Host actually kept', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  // The official store KEEPS a canonical form of the submitted base: the
  // read-back differs from the request, so the write is never verified.
  h.store.endpointStoredValue = 'https://other.example/v1'
  await confirmEndpointDraft(h)
  const frame = h.view()
  assert.match(frame, /Not saved/u, `the panel states the Host's own answer:\n${frame}`)
  assert.ok(frame.includes('the Host keeps "https://other.example/v1"'),
    `the panel reports the value the Host kept:\n${frame}`)
  assert.ok(frame.includes('Enter confirm · Esc cancel'), 'the draft stays in the panel for correction')
})

test('the endpoint editor reports Outcome unknown when the read-back is unreadable', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  h.store.readUndefined = true
  await confirmEndpointDraft(h)
  const frame = h.view()
  assert.match(frame, /Outcome unknown/u, `an unobservable result is never a save:\n${frame}`)
  assert.ok(frame.includes('the endpoint write could not be verified'),
    `the panel states what could not be observed:\n${frame}`)
  assert.doesNotMatch(frame, /Not saved/u, 'an unreadable read-back is never reported as not-saved')
})

// ── D3-2: the existing Web rows state the real rc.2 help ───────────────────

test('the Web provider and Share Original Question rows state defaults, billing and the ori_question boundary', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebSection(h)
  const compact = (): string => h.view().replace(/[\u2500-\u257f│]/gu, ' ').replace(/\s+/gu, ' ')
  assert.match(compact(), /Messages is the official default and does not call the billed Search API/u)
  assert.match(compact(), /DeepSeek Search API is opt-in and separately billed \(a Messages plan does not guarantee coverage\)/u)
  assert.match(compact(), /up to 128 characters of the triggering question are sent as ori_question/u)
  assert.match(compact(), /The choice applies to the next search/u)
  // The endpoint row is base-owned Web configuration, not a Bundle, and states
  // the trusted-https/credential boundary.
  for (let index = 0; index < 3; index += 1) await key(h, DOWN)
  assert.match(compact(), /On \(packed default for the DeepSeek Search API\)/u)
  assert.match(compact(), /never the full history or system prompt/u)
  await key(h, DOWN)
  assert.match(compact(), /base-owned, not an Optional Bundle/u)
  assert.match(compact(), /Changing it sends the credential and query there; confirm only a trusted HTTPS base/u)
})
