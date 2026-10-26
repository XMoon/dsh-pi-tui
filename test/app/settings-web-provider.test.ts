/**
 * S2/PR-B §3.3/§3.4 — the `/settings` Web Search / Fetch surface (L6).
 *
 * The user-visible chain: `/settings` → the `Tools` category → `Web Search /
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
import { waitForFrame } from '../support/frame-wait.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const DOWN = '\x1b[B'
const HOME = '\x1b[H'
const UP = '\x1b[A'
const ENTER = '\r'
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
  /** How many authority reads SETTLED (returned or threw). Together with
   *  {@link readCount} this witnesses a read reaching its own settlement — the
   *  fact a wall-clock wait cannot prove. */
  readonly settledReadCount: () => number
  /** Every Host write that SETTLED (committed or rejected), in order: the
   *  authoritative settlement of the write itself, distinct from the UI's
   *  read-back verdict. */
  readonly settledWrites: () => readonly string[]
  /** How many Web writes overlapped (must never exceed 1: ONE owner FIFO). */
  readonly maxConcurrentWrites: () => number
  /** The write labels in COMMIT order. */
  readonly log: readonly string[]
  /** Hold the NEXT authority read until the returned release is called. */
  readonly holdRead: () => () => void
  /** Hold EVERY authority read issued until the returned release is called
   *  (a page entry starts its own fresh read; a one-shot gate would miss it). */
  readonly holdAllReads: () => () => void
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
  const settledWrites: string[] = []
  let readGate: { readonly promise: Promise<void>; readonly release: () => void } | undefined
  let readHoldAll: { readonly promise: Promise<void>; readonly release: () => void } | undefined
  let readsIssued = 0
  let readsSettled = 0
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
        settledWrites.push(`failed:${label}`)
        throw new Error(reason)
      }
      writes.push(label)
      log.push(label)
      apply()
      settledWrites.push(label)
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
      // The Models reference view this file's Web->Models case opens needs a
      // mounted provider directory (the real one is the Models suite's job).
      providers: {
        available: () => true,
        listCredentialOptions: () => [],
        readCatalog: () => ({ options: [], profiles: [] }),
        readProfile: (route: string) => ({ route, configured: false, displayName: route, models: [] }),
        configGuide: () => ({ profilePatchPath: '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml' }),
        writeProfile: async () => {},
        writeKeylessProfile: async () => ({ kind: 'written' as const }),
      },
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
          const held = readHoldAll
          // A held read stays the snapshot of the moment it was ISSUED: a real
          // Host read cannot observe a write that happens while it is pending.
          const captured = { ...store.web, api: { ...store.web.api } }
          const throws = store.readThrows
          const unreadable = !store.available || store.readUndefined
          try {
            if (gate !== undefined) await gate.promise
            if (held !== undefined) await held.promise
            if (throws) throw new Error('settings descriptor unreadable')
            if (unreadable) return undefined
            return captured
          } finally {
            // The read's OWN settlement (returned or threw): the witness that a
            // superseded/newest read really reached its end, which a wall-clock
            // wait cannot prove.
            readsSettled += 1
          }
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
    settledReadCount: () => readsSettled,
    settledWrites: () => settledWrites,
    maxConcurrentWrites: () => maxActiveWrites,
    log,
    holdRead: () => {
      let release = (): void => {}
      const promise = new Promise<void>(resolve => { release = () => resolve() })
      readGate = { promise, release }
      return release
    },
    holdAllReads: () => {
      let release = (): void => {}
      const promise = new Promise<void>(resolve => { release = () => resolve() })
      const record = {
        promise,
        release: () => {
          if (readHoldAll === record) readHoldAll = undefined
          release()
        },
      }
      readHoldAll = record
      return record.release
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

/** Wait until the PAINTED frame satisfies `predicate`, with the read/write
 *  settlement witnesses in the failure message.
 *
 *  The wait is real rendered frames (`waitForFrame`), so success is the fact
 *  the surface shows, not a timer guess; the bound is the helper's frame
 *  budget plus the authoritative Host-side counters, so a failure says whether
 *  the Host read/write even started and whether it SETTLED. */
async function settlePainted(
  h: Harness,
  label: string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  try {
    await waitForFrame(() => h.view(), predicate, () => h.vt.waitForRender(), label)
  } catch (error) {
    throw new Error(`${(error as Error).message}\n`
      + `the Host reads: issued ${h.readCount()}, settled ${h.settledReadCount()}; `
      + `writes: ${JSON.stringify(h.writes)}; settled: ${JSON.stringify(h.settledWrites())}`)
  }
  return h.view()
}

/** Wait until at least `expected` authority reads have SETTLED on the Host side
 *  and the surface painted the frame after that settlement.
 *
 *  This is the currentness cases' witness: `release()` only OPENS the gate, it
 *  does not prove the read finished, so a wall-clock wait could assert absence
 *  while the read was still pending — the exact false-negative these cases
 *  exist to rule out. The counter is the Host fake's own settlement, and the
 *  extra painted frame covers the UI continuation scheduled by it. */
async function awaitReadSettlement(h: Harness, expected: number, label: string): Promise<string> {
  try {
    await waitForFrame(
      () => h.view(),
      () => h.settledReadCount() >= expected,
      () => h.vt.waitForRender(),
      label,
    )
  } catch (error) {
    throw new Error(`${(error as Error).message}\n`
      + `the Host reads: issued ${h.readCount()}, settled ${h.settledReadCount()} (expected >= ${expected})`)
  }
  // One more painted frame: the settlement's UI continuation runs on the
  // microtask queue, so observing the settled counter from a later task proves
  // it already ran; this repaint makes its effect observable in the frame.
  await h.vt.waitForRender()
  return h.view()
}

/** The write labels that have SETTLED so far (the ordering witness).
 *
 *  A test that will write the SAME label twice takes this snapshot BEFORE the
 *  action and waits for the entry after it: `settledWrites` is cumulative
 *  history, so "the label appears somewhere" would be satisfied by the earlier
 *  write and the second one could still be in flight. */
function settledWritesMark(h: Harness): number {
  return h.settledWrites().length
}

/** Wait for the write dispatched AFTER `mark` to settle (committed or rejected).
 *
 *  `mark` is {@link settledWritesMark} taken immediately before the gesture, so
 *  a repeated label cannot satisfy the wait with an older record. `label` is
 *  asserted on the NEW entry, which also proves the wait observed THIS write. */
async function awaitWriteSettlement(h: Harness, label: string, mark: number): Promise<string> {
  const matches = (): boolean => {
    const settled = h.settledWrites()
    return settled.length > mark
      && settled.slice(mark).some(entry => entry.endsWith(`:${label}`) || entry === label)
  }
  try {
    await waitForFrame(
      () => h.view(),
      matches,
      () => h.vt.waitForRender(),
      `the Host write ${label} to settle after mark ${mark}`,
    )
  } catch (error) {
    throw new Error(`${(error as Error).message}\nsettled writes: ${JSON.stringify(h.settledWrites())} (mark ${mark})`)
  }
  await h.vt.waitForRender()
  return h.view()
}

/** Move the page LIST cursor to `index` (0-based, the frozen order) from the
 *  list's own Home position. Selection only: nothing opens, nothing writes. */
async function pageListSelect(h: Harness, index: number): Promise<void> {
  await key(h, HOME)
  for (let step = 0; step < index; step += 1) await key(h, DOWN)
}

/** Open the Web page's row Detail for `index` from the LIST. */
async function openWebRow(h: Harness, index: number): Promise<void> {
  await pageListSelect(h, index)
  await key(h, ENTER)
}

/** Return from a row Detail to the page LIST at its first row. Esc from a
 *  Detail only steps back (never writes); the caller must not be at the list
 *  already, where Esc would close the page. */
async function webListTop(h: Harness): Promise<void> {
  await key(h, ESC)
  await key(h, HOME)
}

/** Highlight one candidate of the open choice (Home = first candidate, then
 *  Down). Moving the highlight never writes. */
async function chooseCandidate(h: Harness, index: number): Promise<void> {
  await key(h, HOME)
  for (let step = 0; step < index; step += 1) await key(h, DOWN)
}

/** Open `/settings` and reach the `Tools` rows level (the Web launcher's own
 *  category; Visual tools is the first row). */
async function openOtherRows(h: Harness): Promise<void> {
  h.invoke('settings')
  for (let attempt = 0; attempt < 20 && !h.view().includes('Settings ·'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    await h.vt.waitForRender()
  }
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER)
}

/** Wait for the page's SETTLED facts (the mount triggers a fresh Host read). */
async function settleWebPage(h: Harness): Promise<string> {
  return settlePainted(h, 'the Web page to paint its settled facts', frame =>
    frame.includes('Web Search Provider') && !frame.includes('Loading…'))
}

/** Drive `/settings` → Tools → Web Search / Fetch into the Web page and wait
 *  for its settled authority facts. */
async function openWebPage(h: Harness): Promise<string> {
  await openOtherRows(h)
  await key(h, DOWN)
  await key(h, ENTER)
  return settleWebPage(h)
}

/** Leave the Settings surface through its real Esc ladder (the page may own a
 *  Detail/List level; the workspace itself needs the last Esc). */
async function closeWorkspace(h: Harness): Promise<void> {
  for (let attempt = 0; attempt < 8 && h.view().includes('Settings ·'); attempt += 1) await key(h, ESC)
  assert.doesNotMatch(h.view(), /Settings ·/u, 'the workspace really closed')
}

/** Append to the endpoint editor's seeded draft. The editor opens on the
 *  authoritative value; a REAL write needs a different draft (an unchanged
 *  draft is a zero-write `verified`). */
async function editEndpointDraft(h: Harness, suffix: string): Promise<void> {
  for (const character of suffix) await key(h, character)
}

/** The endpoint editor's settle: its own verdict is PAINTED (a verified save
 *  closes it; Not saved/Outcome unknown stays with its message). */
async function settleEndpointPanel(h: Harness): Promise<string> {
  const submitted = `endpoint:${h.store.web.api.baseURL}`
  return await settlePainted(h, `the endpoint write's painted verdict (${submitted})`, frame =>
    !frame.includes('Saving…')
    && (!frame.includes('Enter confirm · Esc cancel')
      || /Not saved|Outcome unknown/u.test(frame)))
}

test('the workspace row reports the configured providers and opens the Web page focused', async t => {
  const h = setup()
  t.after(h.dispose)
  h.invoke('settings')
  await h.vt.waitForRender()
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER)
  assert.match(h.view(), /Web Search \/ Fetch/u)
  // The launcher's own Detail carries the authoritative summary plus the
  // billing/credential/entry facts (the narrow row column only shows a prefix).
  await key(h, DOWN)
  const rowView = h.view()
  const compactRow = (): string => rowView.replace(/[\u2500-\u257f│]/gu, ' ').replace(/\s+/gu, ' ')
  assert.match(rowView, /Search: Messages · Fetch: HTTP/u, 'the launcher shows the authoritative provider summary')
  assert.match(rowView, /Configure Web…/u, 'the row Detail paints the ONE page entry')
  assert.match(compactRow(), /billed separately/u)
  assert.match(compactRow(), /not an Optional.*?Bundle/u)
  assert.match(compactRow(), /Share Original Question is on by default/u)
  assert.match(compactRow(), /up to 128 characters/u)
  assert.match(compactRow(), /authoritative read-back agree/u)
  assert.match(compactRow(), /credential reference/u)
  assert.match(compactRow(), /Enter opens the Web/u)

  // Enter mounts the SAME-lease Web page and triggers a FRESH Host read.
  await key(h, ENTER)
  const page = await settleWebPage(h)
  assert.match(page, /Settings · Tools · Web Search \/ Fetch/u, 'the page is the Tools row sub-view')
  // The six frozen rows, in order, on one frame (120x40 paints the whole list).
  let previous = -1
  for (const label of ['Web Search Provider', 'Web Fetch Provider', 'Search API Result Count',
    'Share Original Question', 'Search / Fetch Endpoint', 'DeepSeek API Key']) {
    const at = page.indexOf(label)
    assert.ok(at > previous, `the frozen row order holds (${label}):\n${page}`)
    previous = at
  }
  assert.match(page, /Current: Messages/u, 'the selected row states the real Host value')
  assert.match(page, /› Messages · built-in default \[current\]/u,
    'the current candidate carries the [current] chip')
  assert.equal(h.readCount() >= 1, true, 'opening the page really read the Host')

  // Enter opens the Detail, the highlight moves, Enter confirms EXACTLY once.
  await key(h, ENTER)
  await chooseCandidate(h, 1) // Messages -> DeepSeek Search API
  assert.equal(h.writes.length, 0, 'choosing a candidate never writes')
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', 0)
  await settlePainted(h, 'the verified provider Detail', frame =>
    frame.includes('Current: DeepSeek Search API') && frame.includes('Verified'))
  assert.deepEqual(h.writes, ['search:deepseek-search-api'])
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
  assert.match(h.view(), /Verified/u, 'the write is verified by the read-back')
  assert.match(h.view(), /› DeepSeek Search API .*\[current\]/u,
    'the [current] chip follows the verified read-back')
  assert.doesNotMatch(h.view(), /› Messages .*\[current\]/u, 'the old candidate loses the chip')
})

test('a failed write is reported as Not saved and never claims a save', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  h.store.failNext = 'settings mutate rejected'
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  await key(h, ENTER)
  const refused = await settlePainted(h, 'the failed write reported as Not saved', frame =>
    frame.includes('Not saved') && !frame.includes('Saving…'))
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'the Host store keeps the previous value')
  assert.match(refused, /Not saved · settings mutate rejected/u, `the failure is reported as Not saved:\n${refused}`)
  assert.doesNotMatch(refused, /Verified/u, 'a rejected write is never Verified')
  assert.match(refused, /Current: Messages/u, 'the Detail states the value the Host still holds')
})

test('two confirmed intents commit in FIFO order and never overlap', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.writeDelayMs = 150
  await openWebPage(h)
  // Intent A (search provider): dispatched, deliberately slow.
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  await key(h, ENTER)
  // Intent B (count 10 -> 20) while A is still in flight: it joins the SAME
  // single FIFO, so it can only START after A settled.
  await webListTop(h)
  await openWebRow(h, 2)
  await chooseCandidate(h, 2) // 5,10,20,50 -> 20
  const markB = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'count:20', markB)
  assert.deepEqual(h.log, [
    'begin:search:deepseek-search-api',
    'search:deepseek-search-api',
    'begin:count:20',
    'count:20',
  ], 'the second intent does not even START until the first settled')
  assert.equal(h.maxConcurrentWrites(), 1, 'never two Web writes in flight at once')
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
  assert.equal(h.store.web.api.count, 20)
})

test('a resolved provider mutation the Host does not commit is Not saved, never a save', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  h.store.keptProviderValue = 'deepseek-official'
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  await key(h, ENTER)
  const refused = await settlePainted(h, 'the refused mutation to paint Not saved', frame =>
    frame.includes('Not saved') && !frame.includes('Saving…'))
  assert.deepEqual(h.writes, ['search:deepseek-search-api'], 'the mutation really ran')
  assert.equal(h.store.web.searchProvider, 'deepseek-official', 'the Host kept its own value')
  assert.match(refused, /the Host keeps "Messages" instead of the submitted value/u,
    `the verdict names the value the Host keeps:\n${refused}`)
  assert.match(refused, /Current: Messages/u, 'the Detail reports the Host value, never the request')
  assert.doesNotMatch(refused, /Verified/u)

  // The highlight returns to the value the Host HOLDS: confirming again submits
  // the OTHER candidate (deepseek-search-api), never the rejected intent twice.
  await webListTop(h)
  await openWebRow(h, 0)
  const markSecond = settledWritesMark(h)
  await chooseCandidate(h, 1)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', markSecond)
  assert.deepEqual(h.writes, ['search:deepseek-search-api', 'search:deepseek-search-api'],
    'the selector sits on the Host value, not on the rejected intent')
})

test('two confirmed selections end on the Host value when the second is not committed', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)

  // First: Messages -> DeepSeek Search API (verified).
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  const markFirst = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', markFirst)
  await settlePainted(h, 'the first selection to paint Verified', frame =>
    frame.includes('Verified') && frame.includes('Current: DeepSeek Search API'))
  assert.deepEqual(h.writes, ['search:deepseek-search-api'])
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')

  // Second: back to Messages, but the Host keeps the first selection.
  await webListTop(h)
  await openWebRow(h, 0)
  h.store.keptProviderValue = 'deepseek-search-api'
  await chooseCandidate(h, 0)
  const markSecond = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-official', markSecond)
  const refused = await settlePainted(h, 'the refused second intent', frame =>
    frame.includes('Not saved') && !frame.includes('Saving…'))
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api', 'the Host keeps the first selection')
  assert.match(refused, /the Host keeps "DeepSeek Search API"/u, `the verdict names the kept value:\n${refused}`)

  // The highlight follows the Host value (index 1), so the next confirm submits
  // the OTHER candidate — never the rejected intent again.
  await webListTop(h)
  await openWebRow(h, 0)
  await chooseCandidate(h, 0)
  const markThird = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-official', markThird)
  assert.deepEqual(
    h.writes,
    ['search:deepseek-search-api', 'search:deepseek-official', 'search:deepseek-official'],
    'the selector sits on the value the Host kept',
  )
})

test('the page deeplink is reachable and Esc cancels without a write', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  await openWebRow(h, 1) // Web Fetch Provider
  assert.match(h.view(), /Current: HTTP/u)
  await chooseCandidate(h, 1) // HTTP -> DeepSeek Fetch API
  assert.equal(h.writes.length, 0, 'moving the highlight writes nothing')
  await key(h, ESC) // Detail -> list, still no write
  assert.deepEqual(h.writes, [])
  assert.match(h.view(), /Enter open/u, 'Esc from the Detail returned to the page list')
  await key(h, ESC) // list -> Tools rows
  // The root keeps the row's Detail focus, exactly like the allowlist picker
  // return: the Tools rows are painted again with the Web row selected.
  assert.match(h.view(), /Rows \(2\)/u, 'Esc from the list returns to the Tools rows')
  assert.match(h.view(), /Configure Web…/u, 'the Web row owns the frame again')
  assert.deepEqual(h.writes, [], 'the whole cancel path wrote nothing')
})

test('closing and reopening the page shows the committed values', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', 0)
  await settlePainted(h, 'the verified write', frame => frame.includes('Verified'))
  assert.deepEqual(h.writes, ['search:deepseek-search-api'])
  // Detail -> list -> Tools rows -> categories -> close.
  await webListTop(h)
  await closeWorkspace(h)
  await openWebPage(h)
  assert.match(h.view(), /Current: DeepSeek Search API/u, 'the reopened page shows the committed value')
})

test('an unavailable section offers no write and no candidates', async t => {
  const h = setup({ available: false })
  t.after(h.dispose)
  const page = await openWebPage(h)
  assert.match(page, /Unavailable/u, 'the rows state the unreadable authority')
  assert.match(page, /the Host Web provider settings are not available on this backend/u, 'the Detail names the real reason')
  // Enter opens the read-only Detail; Enter there must not write.
  await openWebRow(h, 0)
  assert.doesNotMatch(h.view(), /Enter confirm/u, 'no confirm affordance exists without an authority')
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'an unreadable configuration never accepts a write')
})

test('the credential row shows the reference and hands the Models deeplink to the root', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  await openWebRow(h, 5)
  const detail = h.view()
  assert.match(detail, /Reference: DEEPSEEK_API_KEY/u, 'the official credential reference is named')
  assert.match(detail, /State: Configured · source: file/u, 'presence/source come from the store')
  assert.match(detail, /› Configure in Models…/u, 'Configure is the active action')
  assert.match(detail, /Clear in Models…/u, 'Clear is offered for a configured reference')
  assert.doesNotMatch(detail, /secret|sk-/u, 'no secret value is ever painted')

  // Enter mounts the EXISTING Models page in the SAME lease — never `/login`.
  await key(h, ENTER)
  await settlePainted(h, 'the Models page on the DEEPSEEK_API_KEY reference', frame =>
    frame.includes('Settings · Models') && frame.includes('DEEPSEEK_API_KEY'))
  assert.match(h.view(), /Settings · Models/u, 'the root switched to the Models category')
  assert.deepEqual(h.delegated, [], 'no /login command line was executed by the Web page')
})

test('a configured custom provider id stays visible and offers no candidate', async t => {
  const h = setup({ searchProvider: 'acme-search' })
  t.after(h.dispose)
  const page = await openWebPage(h)
  assert.match(page, /acme-search/u, 'the custom route is reported as-is')
  await openWebRow(h, 0)
  const detail = h.view()
  assert.match(detail, /Current: acme-search/u)
  assert.match(detail, /CUSTOM route/u, 'the Detail states that it is not selectable here')
  assert.doesNotMatch(detail, /› /u, 'no selectable candidate is painted')
  assert.doesNotMatch(detail, /Enter confirm/u, 'no Confirm affordance exists for a custom route')
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'a custom route is never silently replaced')
})

test('the endpoint editor joins the SAME FIFO: no Web write overlaps another', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.writeDelayMs = 150
  await openWebPage(h)
  // Queue the (slow) provider write first.
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  await key(h, ENTER)
  // Then open the endpoint editor and confirm its draft: with ONE owner FIFO the
  // endpoint write starts only after the provider write settled.
  await webListTop(h)
  await openWebRow(h, 4) // Enter on the endpoint row mounts its editor
  await editEndpointDraft(h, '/v2')
  const markEndpoint = settledWritesMark(h)
  await key(h, ENTER) // confirm the endpoint draft
  await awaitWriteSettlement(h, 'endpoint:https://api.deepseek.com/v1/tools/v2', markEndpoint)
  assert.deepEqual(h.log, [
    'begin:search:deepseek-search-api',
    'search:deepseek-search-api',
    'begin:endpoint:https://api.deepseek.com/v1/tools/v2',
    'endpoint:https://api.deepseek.com/v1/tools/v2',
  ], 'the endpoint write does not even START until the pending selection settled')
  assert.equal(h.maxConcurrentWrites(), 1, 'never two Web writes in flight at once')
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
})

test('an unreadable authority after a successful read drops to Unavailable, never a stale current', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  assert.match(h.view(), /\[current\]/u, 'the first read paints the verified state')
  await closeWorkspace(h)
  h.store.readThrows = true
  await openOtherRows(h)
  assert.match(h.view(), /Unavailable/u, 'the launcher states the failure')
  assert.doesNotMatch(h.view(), /Search: Messages/u, 'the old summary never survives as current')
  await key(h, DOWN)
  await key(h, ENTER)
  const page = await settlePainted(h, 'the page to paint the failed read', frame =>
    frame.includes('Web Search Provider') && !frame.includes('Loading…'))
  assert.match(page, /Unavailable/u)
  assert.match(page, /settings descriptor unreadable/u, 'the reason is the real read failure')
  assert.doesNotMatch(page, /\[current\]/u, 'no row claims a current value it cannot read')
  assert.deepEqual(h.writes, [])
})

test('a mounted but MALFORMED Web section reads as unavailable and accepts no write', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.readUndefined = true
  const page = await openWebPage(h)
  assert.match(page, /Unavailable/u, 'an unreadable section is stated, never shown as current')
  assert.doesNotMatch(page, /\[current\]/u)
  await openWebRow(h, 0)
  await key(h, ENTER)
  await new Promise(resolve => setTimeout(resolve, 10))
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'a malformed section never accepts a write')
})

test('a workspace opened while the authority is pending paints Loading…, never the previous state', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  assert.match(h.view(), /\[current\]/u, 'the settled read paints the verified state')
  await closeWorkspace(h)

  const release = h.holdAllReads()
  t.after(release)
  h.invoke('settings')
  await h.vt.waitForRender()
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER)
  const firstFrame = h.view()
  assert.match(firstFrame, /Loading…/u, `the reopened workspace is pending:\n${firstFrame}`)
  assert.doesNotMatch(firstFrame, /Search: Messages/u,
    'the previous summary is never presented as the current state')

  // Entering the page starts its OWN fresh read, which is held too: the page's
  // first frames state Loading… instead of a last-known value.
  await key(h, DOWN)
  await key(h, ENTER)
  const pendingPage = h.view()
  assert.match(pendingPage, /Web Search Provider/u)
  assert.match(pendingPage, /Loading…/u, `the page starts pending:\n${pendingPage}`)
  assert.doesNotMatch(pendingPage, /\[current\]/u)

  release()
  const settled = await settlePainted(h, 'the held reads to settle the page', frame =>
    frame.includes('Current: Messages') && !frame.includes('Loading…'))
  assert.match(settled, /\[current\]/u)
})

test('a new read clears the previous read ERROR: pending, not a stale Unavailable', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.readThrows = true
  await openWebPage(h)
  assert.match(h.view(), /Unavailable/u, 'the failed read is stated')
  await closeWorkspace(h)

  h.store.readThrows = false
  const release = h.holdAllReads()
  t.after(release)
  h.invoke('settings')
  await h.vt.waitForRender()
  await selectSettingsCategory(h.vt, 'Tools')
  await key(h, ENTER)
  const firstFrame = h.view()
  assert.match(firstFrame, /Loading…/u, `the reopened workspace is pending again:\n${firstFrame}`)
  assert.doesNotMatch(firstFrame, /Unavailable/u, 'the previous error state does not survive into the new read')
  release()
  await settlePainted(h, 'the new read to paint the facts', frame =>
    frame.includes('Search: Messages') && !frame.includes('Loading…'))
})

test('the workspace `r` refresh re-enters pending instead of repainting the cached summary', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  await key(h, ESC) // list -> Tools rows (the Web row stays selected)
  assert.match(h.view(), /Settings · Tools/u, 'Esc restored the Workspace rows level')
  assert.match(h.view(), /Search: Messages/u, 'the settled summary is visible on the rows level')

  const release = h.holdAllReads()
  t.after(release)
  await key(h, 'r')
  const pending = h.view()
  assert.match(pending, /Loading…/u, `the refresh enters the pending state:\n${pending}`)
  assert.doesNotMatch(pending, /Search: Messages/u, 'the cached summary is not repainted while the read is pending')
  release()
  await settlePainted(h, 'the refreshed read to paint the facts', frame =>
    frame.includes('Search: Messages') && !frame.includes('Loading…'))
})

test('entering the Web page paints Loading…, never the last-known value', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  assert.match(h.view(), /\[current\]/u, 'the settled page paints the verified state')
  await key(h, ESC)
  assert.match(h.view(), /Settings · Tools/u)

  // The page's own mount read is held: its first frame states Loading….
  const release = h.holdAllReads()
  t.after(release)
  await key(h, ENTER)
  const pending = h.view()
  assert.match(pending, /Loading…/u, `the page starts pending:\n${pending}`)
  assert.doesNotMatch(pending, /\[current\]/u,
    'no row claims a current value while the read is in flight')
  release()
  const settled = await settlePainted(h, 'the mounted read to repaint the verified state', frame =>
    /\[current\]/u.test(frame) && frame.includes('Current: Messages'))
  assert.doesNotMatch(settled, /Loading…/u)
})

test('a page reopened after a FAILED read states Loading…, not the stale error', async t => {
  const h = setup()
  t.after(h.dispose)
  h.store.readThrows = true
  await openWebPage(h)
  assert.match(h.view(), /Unavailable/u, 'the failure is stated')
  await key(h, ESC)

  h.store.readThrows = false
  const release = h.holdAllReads()
  t.after(release)
  await key(h, ENTER)
  const pending = h.view()
  assert.match(pending, /Loading…/u, `the reopened page is pending:\n${pending}`)
  assert.doesNotMatch(pending, /Current: Unavailable/u, 'the previous read error does not survive into the new read')
  release()
  await settlePainted(h, 'the reopened page to repaint the settled facts', frame =>
    frame.includes('Current: Messages') && !frame.includes('Loading…'))
})

test('an OLD read settling after a write never repaints the page with the pre-write state', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  assert.match(h.view(), /Current: Messages/u)
  await key(h, ESC) // list -> Tools rows

  // R1 observes the pre-write Host and is held; the page's own entry read (R2)
  // supersedes it before any write.
  const releaseR1 = h.holdRead()
  t.after(releaseR1)
  await key(h, 'r')
  assert.match(h.view(), /Loading…/u, 'R1 is pending on the rows level')
  await key(h, ENTER)
  const settledPage = await settlePainted(h, 'the page entry read R2 to settle', frame =>
    frame.includes('Current: Messages') && !frame.includes('Loading…'))

  // A real write, then the held R1 settles: its pre-write snapshot must not
  // overwrite the committed facts.
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  const markWrite = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', markWrite)
  await settlePainted(h, 'the verified write', frame => frame.includes('Verified'))

  const settledBeforeRelease = h.settledReadCount()
  releaseR1()
  await awaitReadSettlement(h, settledBeforeRelease + 1, 'the stale pre-write read to settle')
  const after = h.view()
  assert.match(after, /Current: DeepSeek Search API/u, `the committed facts survive the stale settlement:\n${after}`)
  assert.doesNotMatch(after, /Current: Messages/u, 'the pre-write value never comes back')
})

test('a SUPERSEDED write readback never decides the verdict', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)

  // The write's readback R1 observes an UNREADABLE Host and is held while a
  // NEWER read R2 (the page's `r`) observes the post-write facts.
  h.store.readUndefined = true
  const releaseR1 = h.holdRead()
  t.after(releaseR1)
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  const markMutation = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', markMutation)
  assert.match(h.view(), /Saving…/u, 'the write really issued its verification read (R1 is pending)')

  h.store.readUndefined = false
  await key(h, 'r')
  const newer = await settlePainted(h, 'the newer read R2 to commit the post-write facts', frame =>
    frame.includes('Current: DeepSeek Search API') && !frame.includes('Loading…'))
  assert.doesNotMatch(newer, /Not saved|Outcome unknown/u, 'R2 committed the post-write facts')

  // R1 settles now (unreadable, superseded): it must not turn the committed
  // result into a stale verdict.
  const settledBeforeRelease = h.settledReadCount()
  releaseR1()
  await awaitReadSettlement(h, settledBeforeRelease + 1, 'the superseded readback to settle')
  const after = h.view()
  assert.doesNotMatch(after, /Not saved|Outcome unknown/u,
    `no stale verdict leaks into the surface:\n${after}`)
  assert.match(after, /Current: DeepSeek Search API/u, 'the newest facts survive')
})

test('a superseded readback settling while the newer read is STILL pending never judges', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)

  h.store.readUndefined = true
  const releaseR1 = h.holdRead()
  t.after(releaseR1)
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  const markR1Write = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', markR1Write)
  assert.match(h.view(), /Saving…/u, 'R1 is pending')

  // R2 is ALSO held, so it is pending when R1 settles.
  h.store.readUndefined = false
  const releaseR2 = h.holdAllReads()
  t.after(releaseR2)
  await key(h, 'r')
  assert.match(h.view(), /Loading…/u, 'the newer read R2 is still pending')

  const settledBeforeR1 = h.settledReadCount()
  releaseR1()
  const settledAfterR1 = await awaitReadSettlement(h, settledBeforeR1 + 1, 'the superseded readback R1 to settle')
  assert.doesNotMatch(settledAfterR1, /Not saved|Outcome unknown/u,
    `a superseded readback must not judge while the newer read is pending:\n${settledAfterR1}`)

  // R2 settles: the newest facts decide.
  const settledBeforeR2 = h.settledReadCount()
  releaseR2()
  await awaitReadSettlement(h, settledBeforeR2 + 1, 'the newest read R2 to settle')
  const settled = await settlePainted(h, 'the newest read to paint its facts', frame =>
    frame.includes('Current: DeepSeek Search API') && !frame.includes('Loading…'))
  assert.doesNotMatch(settled, /Not saved|Outcome unknown/u, `the newest facts win:\n${settled}`)
})

test('a verified endpoint save closes the editor on the Host value', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  await openWebRow(h, 4) // Enter on the endpoint row mounts its editor
  assert.match(h.view(), /Enter confirm · Esc cancel/u)
  await editEndpointDraft(h, '/v2')
  await key(h, ENTER) // confirm the edited draft value
  await settleEndpointPanel(h)
  assert.deepEqual(h.writes, ['endpoint:https://api.deepseek.com/v1/tools/v2'], 'the mutation committed')
  assert.doesNotMatch(h.view(), /Enter confirm · Esc cancel/u, 'the verified save closed the editor')
  assert.ok(h.view().includes('Current: https://api.deepseek.com/v1/tools'),
    `the row states the verified endpoint:\n${h.view()}`)
})

test('the endpoint editor reports Not saved with the value the Host actually kept', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  h.store.endpointStoredValue = 'https://other.example/v1'
  await openWebRow(h, 4)
  await editEndpointDraft(h, '/v2')
  await key(h, ENTER)
  await settleEndpointPanel(h)
  const frame = h.view()
  assert.match(frame, /Not saved/u, `the editor states the Host's own answer:\n${frame}`)
  assert.ok(frame.includes('the Host keeps "https://other.example/v1"'),
    `the editor reports the value the Host kept:\n${frame}`)
  assert.ok(frame.includes('Enter confirm · Esc cancel'), 'the draft stays in the editor for correction')
})

test('the endpoint editor reports Outcome unknown when the read-back is unreadable', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  h.store.readUndefined = true
  await openWebRow(h, 4)
  await editEndpointDraft(h, '/v2')
  await key(h, ENTER)
  await settleEndpointPanel(h)
  const frame = h.view()
  assert.match(frame, /Outcome unknown/u, `an unobservable result is never a save:\n${frame}`)
  assert.ok(frame.includes('the Host write could not be verified'),
    `the editor states what could not be observed:\n${frame}`)
  assert.doesNotMatch(frame, /Not saved/u, 'an unreadable read-back is never reported as not-saved')
})

/** One SUPERSEDED endpoint-readback scenario over the frozen sizes: R1 (the
 *  write's verification read) observes an UNREADABLE Host and is held; R2 (the
 *  page's `r`) observes the NEWEST facts and is also held. R1 settles while R2
 *  is pending, then R2 decides. A verdict from the superseded R1 would be wrong
 *  in every scenario. */
function supersededEndpointCase(
  name: string,
  arrangeNewest: (h: Harness) => void,
  assertVerdict: (frame: string, h: Harness) => Promise<void> | void,
): void {
  for (const [columns, rows] of SUPERSEDED_SIZES) {
    test(`a superseded endpoint readback is judged by the NEWEST read at ${columns}x${rows}: ${name}`, async t => {
      const h = setup({ columns, rows })
      t.after(h.dispose)
      await openWebPage(h)
      h.store.readUndefined = true
      const releaseR1 = h.holdRead()
      t.after(releaseR1)
      await openWebRow(h, 4) // Enter on the endpoint row mounts its editor
      await editEndpointDraft(h, '/v2')
      await key(h, ENTER) // dispatch the endpoint write
      await settlePainted(h, 'the endpoint editor to state Saving…', frame => frame.includes('Saving…'))

      h.store.readUndefined = false
      arrangeNewest(h)
      const releaseR2 = h.holdAllReads()
      t.after(releaseR2)
      // Leave the editor (zero write): the dispatced write keeps settling in the
      // command owner, and the page's own `r` then starts the NEWER read R2.
      await key(h, ESC)
      await key(h, 'r')
      assert.match(h.view(), /Loading…/u, 'the newer read R2 is pending')

      const settledBeforeR1 = h.settledReadCount()
      releaseR1()
      await awaitReadSettlement(h, settledBeforeR1 + 1, 'the superseded readback R1 to settle')
      assert.doesNotMatch(h.view(), /Not saved|Outcome unknown/u,
        `a superseded readback must not judge while the newer read is pending:\n${h.view()}`)

      const settledBeforeR2 = h.settledReadCount()
      releaseR2()
      await awaitReadSettlement(h, settledBeforeR2 + 1, 'the newest read R2 to settle')
      await settlePainted(h, 'the newest read to paint its verdict', frame =>
        !frame.includes('Loading…') && !frame.includes('Saving…'))
      await assertVerdict(h.view(), h)
    })
  }
}

/** The frozen sizes for the changed verdict sink. */
const SUPERSEDED_SIZES = [[120, 40], [80, 10], [44, 20]] as const

supersededEndpointCase(
  'the newest read observed the submitted endpoint',
  () => {},
  async (frame, h) => {
    assert.doesNotMatch(frame, /Not saved|Outcome unknown/u, `a verified write leaves no verdict:\n${frame}`)
    // The endpoint editor always opens on the authoritative value: seeing it
    // there proves the newest read decided (the row's own slot truncates).
    await openWebRow(h, 4)
    assert.ok(h.view().includes('https://api.deepseek.com/v1/tools'),
      `the editor opens on the verified endpoint:\n${h.view()}`)
    await key(h, ESC)
  },
)

supersededEndpointCase(
  'the Host kept another value',
  h => { h.store.web.api.baseURL = 'https://other.example/v1' },
  async (frame, h) => {
    // R1 was UNREADABLE: an `Outcome unknown` here would be the superseded
    // snapshot's answer, so `Not saved` proves the NEWEST facts decided.
    assert.match(frame, /Not saved/u, `a kept value is reported as Not saved:\n${frame}`)
    assert.doesNotMatch(frame, /Outcome unknown/u, `the superseded snapshot never decides:\n${frame}`)
    if (!frame.includes('the Host keeps "https://other.example/v1"')) {
      // The narrow page paints only the list, so the kept value is read from
      // the endpoint editor, which always opens on the authoritative value.
      await openWebRow(h, 4)
      assert.ok(h.view().includes('https://other.example/v1'),
        `the editor opens on the value the Host keeps:\n${h.view()}`)
      await key(h, ESC)
    }
  },
)

supersededEndpointCase(
  'the newest read could not read the Host',
  h => { h.store.readUndefined = true },
  (frame) => {
    assert.match(frame, /Outcome unknown/u, `an unobservable result is Outcome unknown:\n${frame}`)
    assert.doesNotMatch(frame, /Not saved/u)
  },
)

test('the page and the legacy Web row share ONE authority and one FIFO', async t => {
  const h = setup()
  t.after(h.dispose)
  // A PAGE write commits first (deliberately slow, so a second overlapping
  // write would be observable).
  h.store.writeDelayMs = 100
  await openWebPage(h)
  await openWebRow(h, 0)
  await chooseCandidate(h, 1)
  const markPage = settledWritesMark(h)
  await key(h, ENTER)
  await awaitWriteSettlement(h, 'search:deepseek-search-api', markPage)
  assert.equal(h.store.web.searchProvider, 'deepseek-search-api')
  await closeWorkspace(h)

  // The still-supported LEGACY editor is reachable through its transition row.
  // Its Web rows read the SAME authority and write through the SAME FIFO.
  h.invoke('settings')
  await h.vt.waitForRender()
  await selectSettingsCategory(h.vt, 'Input & Terminal')
  await key(h, ENTER) // rows level
  for (let step = 0; step < 6; step += 1) await key(h, DOWN) // the transition row
  await key(h, ENTER) // hand off to the existing editor at Keyboard shortcuts
  await settlePainted(h, 'the legacy editor to mount on its row', frame =>
    frame.includes('Keyboard shortcuts'))
  // Up from the editor's last item walks back to the Web rows; Up*4 is the
  // Search API Result Count row.
  for (let step = 0; step < 4; step += 1) await key(h, UP)
  assert.match(h.view(), /Search API Result Count/u, `the legacy editor still owns the Web rows:\n${h.view()}`)
  const markLegacy = settledWritesMark(h)
  await key(h, ENTER) // cycle 10 -> 20 through the legacy row
  await awaitWriteSettlement(h, 'count:20', markLegacy)
  assert.equal(h.maxConcurrentWrites(), 1, 'ONE FIFO: never two Web writes in flight')
  assert.equal(h.store.web.api.count, 20)

  // Up to the provider row: the legacy row reports the PAGE's committed value,
  // so both surfaces read the same authority (never a private copy).
  for (let step = 0; step < 2; step += 1) await key(h, UP)
  const providerRow = h.view()
  assert.match(providerRow, /Web Search Provider/u)
  assert.match(providerRow, /Current: DeepSeek Search API/u,
    `the legacy row reads the value the page committed:\n${providerRow}`)
  await key(h, ESC) // leave the legacy editor (no Web-return path any more)

  // Re-entering the page shows BOTH committed values from one fresh read.
  await openWebPage(h)
  assert.match(h.view(), /Current: DeepSeek Search API/u)
  await key(h, DOWN)
  await key(h, DOWN)
  assert.match(h.view(), /Current: 20/u, `the page reads the legacy write:\n${h.view()}`)
})

// ── D3-2: the page states the real rc.2 facts ──────────────────────────────

test('the page states defaults, billing, the ori_question boundary and the endpoint trust warning', async t => {
  const h = setup()
  t.after(h.dispose)
  await openWebPage(h)
  const compact = (): string => h.view().replace(/[\u2500-\u257f│]/gu, ' ').replace(/\s+/gu, ' ')
  assert.match(compact(), /Messages is the official default and does not call the billed Search API/u)
  assert.match(compact(), /DeepSeek Search API is opt-in and separately billed/u)
  assert.match(compact(), /a Messages plan does not guarantee coverage/u)
  assert.match(compact(), /No write happens without an explicit Enter/u)
  // The Share Original Question row states the packed ON default and the exact
  // payload boundary (not the full history/system prompt).
  await pageListSelect(h, 3)
  assert.match(compact(), /Current: on/u)
  assert.match(compact(), /packed default for the DeepSeek Search API/u)
  assert.match(compact(), /up to 128 characters of the triggering human question as ori_question/u)
  assert.match(compact(), /never the full history or the system prompt/u)
  // The endpoint row is base-owned Web configuration, not a Bundle, and states
  // the trusted-HTTPS/credential boundary.
  await pageListSelect(h, 4)
  assert.match(compact(), /Enter opens the endpoint editor/u)
  assert.match(compact(), /Changing it sends the/u)
  assert.match(compact(), /DeepSeek API credential and the query to that target/u)
  assert.match(compact(), /confirm only a trusted HTTPS base/u)
  assert.match(compact(), /the URL shape/u)
  assert.match(compact(), /is checked, not the host's trust/u)
  assert.match(compact(), /Official base: https:\/\/api\.deepseek\.com\/v1\/tools/u)
})
