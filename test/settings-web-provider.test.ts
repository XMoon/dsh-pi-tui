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
import test, { afterEach } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { TuiCommandRunner } from '../src/commands.ts'
import { TuiApp } from '../src/tui-app.ts'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type { TuiSettingsDoc, WebProviderSettings } from '../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from './support/register-tui-commands.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const DOWN = '\x1b[B'
const ENTER = '\r'
const TAB = '\t'
const ESC = '\x1b'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
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
  }
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
  readonly available?: boolean
  readonly searchProvider?: string
}
= {}): Harness {
  const columns = options.columns ?? 140
  const vt = new VirtualTerminal(columns, 40)
  const writes: string[] = []
  const delegated: string[] = []
  let activeWrites = 0
  let maxActiveWrites = 0
  const log: string[] = []
  let readGate: { readonly promise: Promise<void>; readonly release: () => void } | undefined
  const store = {
    available: options.available ?? true,
    failNext: undefined as string | undefined,
    readThrows: false,
    readUndefined: false,
    writeDelayMs: 0,
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
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: () => ({ kind: 'unchanged' }),
    refreshStatus: () => {},
    tuiSettings: { get: () => doc, replace: (next: TuiSettingsDoc) => { Object.assign(doc, next) } },
    config: {
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
        setSearchProvider: async (id: string) => { await write(`search:${id}`, () => { store.web.searchProvider = id }, store.writeDelayMs) },
        setFetchProvider: async (id: string) => { await write(`fetch:${id}`, () => { store.web.fetchProvider = id }) },
        setSearchApiCount: async (count: number) => { await write(`count:${count}`, () => { store.web.api.count = count }) },
        setSendOriginalQuestion: async (enabled: boolean) => { await write(`ori:${String(enabled)}`, () => { store.web.api.sendOriginalQuestion = enabled }) },
        setSearchApiBaseURL: async (url: string) => { await write(`endpoint:${url}`, () => { store.web.api.baseURL = url }) },
      },
    },
    catalog: { models: { available: () => false } },
    // Explicitly ABSENT: the Proxy fallback would otherwise hand the legacy
    // editor a truthy function for a missing optional owner.
    extensions: undefined,
    openPluginManager: () => {},
    createPluginManagerSubmenu: () => ({ render: () => [], dispose: () => {} }),
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
  const keys = h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, ENTER] : [DOWN, DOWN, ENTER]
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

test('the workspace row reports the configured providers and opens the Web section focused', async t => {
  const h = setup()
  t.after(h.dispose)
  h.invoke('settings')
  await h.vt.waitForRender()
  // The Other category's Web row carries the live configured summary.
  for (const pressed of [TAB, TAB, DOWN, DOWN, ENTER]) await key(h, pressed)
  assert.match(h.view(), /Web Search \/ Fetch/u)
  // Select the launcher row: its Detail carries the authoritative summary and
  // the billing/credential/Enter-configure facts (the narrow row column only
  // shows the summary prefix).
  await key(h, DOWN)
  const rowView = h.view()
  assert.match(rowView, /Search: Messages · Fetch: HTTP/u, 'the launcher shows the authoritative provider summary')
  assert.match(rowView, /billed separately/u)
  assert.match(rowView, /credential reference/u)
  assert.match(rowView, /Enter configure/u)

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
  h.invoke('settings')
  // The held read cannot settle, so every frame painted before it settles is
  // the pending state (without the pre-snapshot pending entry these frames
  // would carry the previous summary as current).
  await h.vt.waitForRender()
  for (const pressed of h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, ENTER] : [DOWN, DOWN, ENTER]) await key(h, pressed)
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
  h.invoke('settings')
  await h.vt.waitForRender()
  for (const pressed of h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, ENTER] : [DOWN, DOWN, ENTER]) await key(h, pressed)
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
  await key(h, ESC)
  await key(h, ESC) // leave the Settings surface entirely
  // Re-enter: the workspace open starts a read, which the gate holds.
  h.invoke('settings')
  await h.vt.waitForRender()
  for (const pressed of h.vt.columns >= 96 ? [TAB, TAB, DOWN, DOWN, ENTER] : [DOWN, DOWN, ENTER]) await key(h, pressed)
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
