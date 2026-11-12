/** Production TSP Session Browser, observed through the SDK's reconciled pane wire. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, type PickerGroup } from '@stencil-hq/tern'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import { createSessionBrowserReadOwner } from '../../src/app/command/session-browser-read.ts'
import type { SessionBrowserOpenOptions, SessionBrowserReadOwnerOptions } from '../../src/app/command/session-browser-read.ts'
import type { SessionContentSearchPage, SessionProjectionSummary, SessionReader, SessionSummary } from '../../src/runtime/session-reader-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { findSessionMatch, formatSessionAge } from '../../src/tui/pickers/sessions.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import type { SessionScope } from '../../src/app/session/scope.ts'
import type { SessionWorkspaceFactsPort } from '../../src/runtime/session-workspace-facts-port.ts'
import {
  layerNodes,
  pickerActionByBase,
  pickerNode,
  pickerProps,
  scrollOps,
  sendAction,
  sheetText,
  sendActivate,
  sendPickerAction,
  sendResize,
  sendSelect,
  type WireNode,
} from '../support/tsp-picker-wire.ts'

const BROWSER = 'session-browser-'
const props = (pane: TspPane): Record<string, unknown> => pickerProps(pane, BROWSER)
const picker = (pane: TspPane): WireNode | undefined => pickerNode(pane, BROWSER)
const items = (pane: TspPane): Array<Record<string, unknown>> => (props(pane).items ?? []) as Array<Record<string, unknown>>
const order = (pane: TspPane): Array<string | PickerGroup> => props(pane).order as Array<string | PickerGroup>
const details = (pane: TspPane): WireNode | undefined => layerNodes(pane, BROWSER).find((node) => node.k === 'overlay')
const detailBody = (pane: TspPane): WireNode | undefined => layerNodes(pane, BROWSER)
  .find((node) => node.k === 'col' && node.id.includes('session-browser-details-body-'))

/** The Details Reader's facts, read from the WIRE the pane received.
 *
 *  A pane that negotiated `kv` paints a group as one grid whose pairs live in the
 *  node's OWN props, so the observation point is those props — not a text node the
 *  component never built. A pane without `kv` alternates a muted label node with a
 *  wrapped value node, which this reads in the same shape so one helper serves both
 *  branches. Adding a hidden text copy of a gridded fact to keep an old extractor
 *  happy would paint every fact twice and prove nothing about the client. */
function detailGroups(pane: TspPane): Map<string, Array<readonly [string, string]>> {
  const out = new Map<string, Array<readonly [string, string]>>()
  for (const node of layerNodes(pane, BROWSER)) {
    const key = String(node.p.key ?? '')
    if (node.k === 'kv' && key.startsWith('session-browser-kv-')) {
      const items = (node.p.items ?? []) as Array<{ readonly k?: unknown; readonly v?: unknown }>
      out.set(key.slice('session-browser-kv-'.length), items.map((item) => [String(item.k), String(item.v)] as const))
    }
  }
  return out
}

/** Every `kv` node id the layer really carries (a degradation case asserts it is
 *  empty, so "no kv" is a fact about the wire and not about one lookup). */
const kvNodes = (pane: TspPane): WireNode[] => layerNodes(pane, BROWSER).filter((node) => node.k === 'kv')

/** The Reader's text nodes as `label | value` runs, the ORIGINAL shape: used by the
 *  no-`kv` case and by the Host excerpt, which stays wrapped text at every capability. */
const detailTextRuns = (pane: TspPane): string[] => layerNodes(pane, BROWSER)
  .filter((node) => node.k === 'text')
  .map((node) => {
    const spans = node.p.spans
    if (Array.isArray(spans)) {
      return spans.map((entry) => String((entry as { t?: unknown })?.t ?? '')).join('')
    }
    return String(node.p.text ?? '')
  })
  .filter((text) => text !== '')
const row = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  updatedAt: 100,
  createdAt: 10,
  cwd: '/workspace/project',
  live: false,
  ...overrides,
})

function reader(overrides: Partial<SessionReader> = {}): SessionReader {
  return {
    list: async () => [],
    projectionBatch: async () => new Map(),
    search: async () => undefined,
    blank: () => undefined,
    measureContext: () => undefined,
    turnOutline: () => undefined,
    sessionStatus: () => undefined,
    ...overrides,
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((ok) => { resolve = ok })
  return { promise, resolve }
}

async function mounted(t: { after(fn: () => unknown): void }, read: SessionReader = reader({
  // rc.1 ordinary forks are independent Sessions, so these LEGACY
  // parentSession rows must stay flat roots; real subagent rows are excluded
  // from the Browser by the read owner. The grouping/orphan/cycle fixtures
  // below therefore exercise flat ordering and membership, not nesting.
  list: async () => [
    row('session-current', { live: true }),
    row('session-other', { cwd: '/workspace/project', parentSession: 'session-current' }),
    row('session-content', { cwd: '/workspace/other', parentSession: 'session-other' }),
    row('session-cross-child', { cwd: '/workspace/project', parentSession: 'session-content' }),
    row('session-orphan', { cwd: '/workspace/other', parentSession: 'session-not-listed' }),
    row('session-cycle-a', { cwd: '/workspace/other', parentSession: 'session-cycle-b' }),
    row('session-cycle-b', { cwd: '/workspace/other', parentSession: 'session-cycle-a' }),
    row('session-subagent', { origin: 'subagent' }),
  ],
  projectionBatch: async (rows) => new Map(rows.map((entry) => [entry.id, {
    title: entry.id === 'session-current' ? 'Needle current\u001b[31m title\u001b[0m'
      : entry.id === 'session-other' ? 'Other title' : 'Unrelated title',
    preset: 'reviewer',
  }])),
  search: async () => ({
    items: [
      { sessionId: 'session-content', snippet: '\u001b[31mHost content excerpt\u001b[0m' },
      { sessionId: 'session-current', snippet: 'Host current excerpt' },
      { sessionId: 'session-subagent', snippet: 'subagent is not a main row' },
      { sessionId: 'session-foreign', snippet: 'unlisted hit' },
    ],
    hasMore: true,
  }),
}), waitForProjection = true, expectedState: 'ready' | 'loading' | 'error' = 'ready', openOptions: SessionBrowserOpenOptions = {},
  // The pane's OWN advertised capability set. A case defaults to the native Browser
  // opt-in; a case that must prove the no-`kv` degradation passes its kinds verbatim,
  // so `nativeKv` always arrives through the real handshake and is never a value the
  // test forced on the View.
  paneOptions: Parameters<typeof installTspPane>[0] = { sessionBrowser: true },
  workspaceFacts?: SessionWorkspaceFactsPort,
  ownerCallbacks: Pick<SessionBrowserReadOwnerOptions, 'onAddDirectory' | 'onUseDirectory' | 'onWorkspaceNewSession'> = {},
  currentSessionId: string | null = 'session-current',
  nextCreateWorkspaceId?: string,
) {
  const pane = installTspPane(paneOptions)
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  const fatals: unknown[] = []
  const renderer = mountTspRenderer(session, { copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => { fatals.push(error) },
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => assert.fail('the read-only Browser must capture Enter'),
    steer() {},
    pasteMedia: () => {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true,
  })
  const browserPresentation = renderer.sessionBrowserPresentation
  assert.ok(browserPresentation, 'the pane advertises picker, row, overlay, text and scroll')
  let presentedDirectoryEntry: boolean | undefined
  let presentedInitialDirectoryEntry: boolean | undefined
  let presentedInitialDirectoryPath: string | undefined
  let presentedHandleDisposed: boolean | undefined
  let latestPresentedHandle: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserPanelHandle | undefined
  const readPresentation = {
    open: (request: Parameters<typeof browserPresentation.open>[0]) => {
      presentedDirectoryEntry = request.initialDirectoryChooser
      presentedInitialDirectoryEntry = request.initialDirectoryEntry
      presentedInitialDirectoryPath = request.initialDirectoryPath
      const handle = browserPresentation.open(request)
      latestPresentedHandle = handle
      presentedHandleDisposed = handle.isDisposed()
      return handle
    },
    notify: browserPresentation.notify,
  }
  const diag = createDiag({ stderrLevel: 'off' })
  t.after(() => diag.dispose())
  const resumeIntents: Array<{ sessionId: string; currentSessionId: string | undefined; source: string }> = []
  const resumeSettlements: Array<(outcome: import('../../src/app/command/session-browser-read.ts').SessionBrowserResumeSettlement) => void> = []
  let current = true
  const owner = createSessionBrowserReadOwner({
    reader: read,
    presentation: readPresentation,
    captureSubject: () => ({
      subject: {
        currentSessionId: currentSessionId ?? undefined,
        currentCwd: '/workspace/project',
        ...(currentSessionId === null && nextCreateWorkspaceId !== undefined ? { currentWorkspaceId: nextCreateWorkspaceId } : {}),
        isCurrent: () => current,
      },
      scope: { sessionId: currentSessionId ?? undefined } as SessionScope,
    }),
    diag,
    sessionId: () => currentSessionId ?? undefined,
    sessionWorkspaceFacts: workspaceFacts,
    ...ownerCallbacks,
    onResumeIntent: (intent, _scope, settle) => { resumeIntents.push(intent); resumeSettlements.push(settle) },
  })
  t.after(() => owner.dispose())
  const readHandle = owner.open(openOptions)
  if (openOptions.initialDirectoryChooser !== true) {
    await waitUntil(`the Session Browser picker is ${expectedState}`, () => props(pane).state === expectedState)
  }
  if (waitForProjection) {
    await waitUntil('the first projection batch is visible', () => items(pane).some((entry) => entry.label === 'Needle current title'))
  }
  return {
    pane,
    renderer,
    owner,
    readHandle,
    resumeIntents,
    resumeSettlements,
    fatals,
    presentedDirectoryEntry: () => presentedDirectoryEntry,
    presentedInitialDirectoryEntry: () => presentedInitialDirectoryEntry,
    presentedInitialDirectoryPath: () => presentedInitialDirectoryPath,
    presentedHandleDisposed: () => presentedHandleDisposed,
    presentedHandleIsDisposed: () => latestPresentedHandle?.isDisposed(),
    moveSubject: () => { current = false },
  }
}

test('raw query text and cursor survive a late projection while input continues', async (t) => {
  const projection = deferred<Map<string, SessionProjectionSummary>>()
  const searches: string[] = []
  let projectionStarted = false
  const m = await mounted(t, reader({
    list: async () => [row('session-current', { live: true }), row('session-query-result')],
    projectionBatch: async () => {
      projectionStarted = true
      return projection.promise
    },
    search: async (query) => {
      searches.push(query)
      return { items: [], hasMore: false }
    },
  }), false, 'ready', { initialQuery: 'hello' })
  const { pane } = m

  assert.equal(props(pane).query, 'hello', 'the explicit initial query seeds the native input once')
  assert.equal(props(pane).cursor, 5)
  assert.deepEqual(searches, ['hello'])
  await waitUntil('the first projection batch is held', () => projectionStarted)
  pane.key(' ')
  await waitUntil('the trailing space reaches the native input', () => props(pane).query === 'hello ')
  assert.equal(props(pane).cursor, 6)

  projection.resolve(new Map([['session-query-result', { title: 'hello projected result' }]]))
  await waitUntil('the late projection contributes a metadata result', () =>
    items(pane).some((item) => item.id === 'session:session-query-result'))
  assert.equal(props(pane).query, 'hello ')
  assert.equal(props(pane).cursor, 6)
  assert.deepEqual(searches, ['hello'], 'the same canonical query does not restart Host Search')

  pane.key('world')
  await waitUntil('typing continues after the retained separator', () => props(pane).query === 'hello world')
  assert.equal(props(pane).cursor, 11)
  assert.equal(m.fatals.length, 0)
})

test('whitespace-only input while typed Resume loads suppresses the native direct switch', async (t) => {
  const listed = deferred<SessionSummary[] | undefined>()
  const searches: string[] = []
  t.after(() => listed.resolve([row('session-target')]))
  const m = await mounted(t, reader({
    list: async () => listed.promise,
    search: async (query) => {
      searches.push(query)
      return undefined
    },
  }), false, 'loading', {
    directMatch: { query: 'session-target', find: findSessionMatch },
  })
  const { pane } = m

  pane.key(' ')
  await waitUntil('the whitespace-only edit reaches the native input', () => props(pane).query === ' ')
  assert.equal(props(pane).cursor, 1)
  listed.resolve([row('session-current', { live: true }), row('session-target')])

  assert.deepEqual(await m.readHandle.settlement, { kind: 'ready' })
  await waitUntil('the Browser remains open with the listed target', () =>
    picker(pane) !== undefined && items(pane).some((item) => item.id === 'session:session-target'))
  assert.deepEqual(m.resumeIntents, [], 'whitespace-only user editing supersedes typed /resume')
  assert.deepEqual(searches, [], 'an unchanged canonical query does not start Host Search')
  assert.equal(props(pane).query, ' ')
  assert.equal(props(pane).cursor, 1)
  assert.equal(m.fatals.length, 0)
})

test('workspace-first TSP browse uses official Workspace ids and emits real folder items', async (t) => {
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'baseline' as const,
          items: [
            { workspaceId: 'ws-project', path: '/srv/project', title: 'Project', sessionIds: ['session-current'] },
            { workspaceId: 'ws-other', path: '/srv/other', title: 'Other', sessionIds: ['session-other'] },
          ],
        }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({
    list: async () => [row('session-current'), row('session-other', { cwd: '/unrelated' })],
  }), false, 'ready', {}, { sessionBrowser: true }, facts)
  await waitUntil('official Workspace folder item', () => items(m.pane).some(item => item.id === 'workspace:ws-project'))
  assert.ok(items(m.pane).some(item => item.id === 'workspace:ws-other'))
  assert.ok(items(m.pane).some(item => item.id === 'session:session-current'))
  assert.ok(!order(m.pane).some(entry => typeof entry !== 'string'), 'Workspace identity is a real PickerItem, not a PickerGroup header')
})
test('keyboard Enter toggles the selected Folder and reveals selected Show more rows, never resuming a stale Session', async (t) => {
  const sessionRows = [row('session-current', { live: true }), ...Array.from({ length: 10 }, (_, index) => row(`session-history-${index}`, { updatedAt: 900 - index }))]
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [{ workspaceId: 'ws-current', path: '/srv/project', title: 'Project', sessionIds: sessionRows.map(item => item.id) }] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({ list: async () => sessionRows }), false, 'ready', {}, { sessionBrowser: true }, facts)
  const { pane } = m
  await waitUntil('official folder and Show more rows are painted', () => items(pane).some(item => item.id === 'more:ws-current'))
  sendSelect(pane, 'workspace:ws-current', picker(pane)!.id)
  pane.key('\r')
  await waitUntil('Enter collapses the selected folder', () => items(pane).some(item => item.id === 'workspace:ws-current' && item.open === false))
  assert.deepEqual(m.resumeIntents, [], 'Folder Enter never resumes the previously selected current Session')
  assert.ok(!items(pane).some(item => item.id === 'session:session-current'), 'manual collapse never pins an active or current Session row')
  assert.ok(!items(pane).some(item => item.id === 'more:ws-current'), 'collapsed folders contain only the Folder item')
  pane.key('\r')
  await waitUntil('Enter explicitly reopens the Folder and its history watermark', () => items(pane).some(item => item.id === 'session:session-history-7'))
  sendSelect(pane, 'more:ws-current', picker(pane)!.id)
  await waitUntil('the Show more typed row is selected', () => props(pane).selected === 'more:ws-current')
  pane.key('\r')
  await waitUntil('Show more Enter exposes the previously hidden history row', () => items(pane).some(item => item.id === 'session:session-history-9'))
  assert.deepEqual(m.resumeIntents, [], 'Show more Enter never resumes a stale Session')
})

test('expanding a non-current TSP folder reveals its first five history rows', async (t) => {
  const history = Array.from({ length: 7 }, (_, index) => row(`session-tsp-history-${index}`, { updatedAt: 900 - index }))
  const allRows = [row('session-current', { live: true }), ...history]
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-current', path: '/srv/current', title: 'Current', sessionIds: ['session-current'] },
          { workspaceId: 'ws-other', path: '/srv/other', title: 'Other', sessionIds: history.map(item => item.id) },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({ list: async () => allRows }), false, 'ready', {}, { sessionBrowser: true }, facts)
  const { pane } = m
  await waitUntil('non-current folder begins collapsed', () => items(pane).some(item => item.id === 'workspace:ws-other'))
  assert.ok(!items(pane).some(item => item.id === 'more:ws-other'))
  assert.ok(!items(pane).some(item => item.id === 'session:session-tsp-history-0'))
  sendSelect(pane, 'workspace:ws-other', picker(pane)!.id)
  await waitUntil('Folder selection commits before Enter', () => props(pane).selected === 'workspace:ws-other')
  pane.key('\r')
  await waitUntil('explicit expansion reveals the first history batch', () => items(pane).some(item => item.id === 'session:session-tsp-history-4'))
  assert.ok(items(pane).some(item => item.id === 'session:session-tsp-history-0'))
  assert.ok(!items(pane).some(item => item.id === 'session:session-tsp-history-5'), 'first expansion exposes five rows, not all history')
  assert.deepEqual(m.resumeIntents, [], 'folder expansion is never Resume')
})
test('sessionless TSP Browse prioritizes the Host-confirmed next-create Workspace without claiming Session membership', async (t) => {
  const nextRows = Array.from({ length: 10 }, (_, index) => row(`session-next-${index}`, { updatedAt: 1000 - index }))
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-other', path: '/other', title: 'Other', sessionIds: [] },
          { workspaceId: 'ws-next', path: '/next', title: 'Next target', sessionIds: nextRows.map(item => item.id) },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({ list: async () => nextRows }), false, 'ready', {}, { sessionBrowser: true }, facts, {}, null, 'ws-next')
  const { pane } = m
  await waitUntil('sessionless Workspace rows are ready', () => items(pane).some(item => item.id === 'workspace:ws-next'))
  const rows = items(pane) as Array<{ readonly id: string; readonly label: string }>
  assert.equal(rows[0]?.id, 'workspace:ws-next', 'the Host-confirmed destination is the first official folder')
  assert.ok(rows[0]?.label.includes('Next'), 'the folder is marked as a next-create destination, not Current Session membership')
  assert.equal(rows.filter(item => item.id.startsWith('session:session-next-')).length, 8, 'the next-create Workspace gets the current-directory history watermark')
  assert.ok(rows.some(item => item.id === 'more:ws-next'), 'remaining history stays incrementally discoverable')
  assert.equal(m.resumeIntents.length, 0, 'showing a next-create Workspace does not activate any Session')
})
test('Welcome chooser lists official folders and Add directory retains rejected paths before returning on success', async (t) => {
  const submittedPaths: string[] = []
  const settlements: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  let selectedWorkspace: { readonly id: string; readonly path: string } | undefined
  const workspaceFacts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [{ workspaceId: 'ws-existing', path: '/srv/existing', title: 'Existing', sessionIds: [] }] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({ list: async () => [] }), false, 'ready', {
    initialDirectoryChooser: true,
  }, { sessionBrowser: true }, workspaceFacts, {
    onAddDirectory: (path, settle) => { submittedPaths.push(path); settlements.push(settle) },
    onUseDirectory: (id, path) => { selectedWorkspace = { id, path } },
  }, null)
  const { pane } = m
  assert.equal(m.presentedDirectoryEntry(), true, 'ReadOwner passes Welcome chooser mode to the same TSP presentation')
  await waitUntil('Welcome chooser presents a real official Workspace Folder', () => items(pane).some(item => item.id === 'workspace:ws-existing'))
  assert.equal(props(pane).title, 'Sessions', 'the chooser starts at the common Browser folder list')
  sendSelect(pane, 'workspace:ws-existing', picker(pane)!.id)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(pickerActionByBase(pane, 'use-directory', BROWSER), `selected=${String(props(pane).selected)}; actions=${JSON.stringify(props(pane).actions)}; items=${JSON.stringify(items(pane).map(item => item.id))}`)
  await waitUntil('the sessionless folder selection is committed before actions', () => {
    const action = pickerActionByBase(pane, 'use-directory', BROWSER)
    return action !== undefined && action.disabled === undefined
  })
  sendPickerAction(pane, 'add-directory', BROWSER)
  await waitUntil('Add directory uses the same Picker path query', () => props(pane).title === 'Add directory')
  pane.key('/client/proposed')
  await waitUntil('absolute path edits reach the native Picker query', () => props(pane).query === '/client/proposed')
  pane.key('\r')
  await waitUntil('the Host path reaches the registered resolver owner', () => submittedPaths.length === 1)
  settlements[0]!({ kind: 'failed', message: 'unavailable on Host' })
  await waitUntil('a rejected Host path leaves the chooser input intact', () => props(pane).query === '/client/proposed')
  assert.ok(sheetText(pane, 'dock').includes('unavailable on Host'), 'the path refusal remains visible in shared Dock notice')
  pane.key('\r')
  await waitUntil('retry submits the retained absolute path', () => submittedPaths.length === 2)
  assert.deepEqual(submittedPaths, ['/client/proposed', '/client/proposed'])
  settlements[1]!({ kind: 'registered', workspaceId: 'ws-new', path: '/host/canonical' })
  await waitUntil('successful chooser registration returns to Welcome', () => picker(pane) === undefined)
  assert.equal(m.fatals.length, 0)
})

test('a failed Activity sample is ONE low-noise diagnostic and never fabricates idle facts', async (t) => {
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => { throw new Error('activity sample refused') },
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-folder', path: '/srv/folder', title: 'Folder', sessionIds: ['session-current', 'session-other'] },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({
    list: async () => [row('session-current'), row('session-other', { updatedAt: 90 })],
  }), false, 'ready', {}, { sessionBrowser: true }, facts)
  const { pane } = m
  await waitUntil('the failed Activity sample is diagnosed', () =>
    String(props(pane).message ?? '').includes('Activity unavailable: activity sample refused'))
  const currentItem = items(pane).find(item => item.id === 'session:session-current')
  assert.ok(currentItem !== undefined, 'the roster stays usable after a failed Activity read')
  assert.doesNotMatch(String(currentItem?.detail), /Working|Needs attention/u, 'no idle/working fact is fabricated')
  sendSelect(pane, 'session:session-current', picker(pane)!.id)
  await waitUntil('the row is selected', () => props(pane).selected === 'session:session-current')
  pane.key('\t')
  await waitUntil('the Footer focuses Details', () =>
    ((pickerProps(pane, BROWSER).actions ?? []) as Array<{ readonly label?: unknown }>).some(action => String(action.label).includes('Details [Enter]')))
  pane.key('\r')
  await waitUntil('Details opens', () => details(pane) !== undefined)
  const grids = detailGroups(pane)
  assert.deepEqual(grids.get('activity')?.filter(([label]) => ['Running', 'Pending', 'Source'].includes(label)), [
    ['Running', 'Unknown'],
    ['Pending', 'Pending unknown'],
    ['Source', 'unknown'],
  ], 'a failed sample stays Unknown, never idle/none')
})

test('a Folder or Show more selection never inherits the previous Session actions', async (t) => {
  const history = Array.from({ length: 12 }, (_, index) => row(`session-history-${index}`, { updatedAt: 80 - index }))
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-folder', path: '/srv/folder', title: 'Folder', sessionIds: ['session-current', 'session-other', ...history.map(item => item.id)] },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({
    list: async () => [row('session-current'), row('session-other', { updatedAt: 90 }), ...history],
  }), false, 'ready', {}, { sessionBrowser: true }, facts)
  const { pane } = m
  await waitUntil('the Folder and its children are listed', () => items(pane).some(item => item.id === 'workspace:ws-folder'))
  sendSelect(pane, 'workspace:ws-folder', picker(pane)!.id)
  await waitUntil('the Folder is the typed selection', () => props(pane).selected === 'workspace:ws-folder')
  assert.equal(pickerActionByBase(pane, 'resume', BROWSER)?.disabled, 'Select a session to resume.',
    'Resume never targets the Session selected before the Folder')
  assert.equal(pickerActionByBase(pane, 'details', BROWSER)?.disabled, 'Select a session to read its details.')
  sendPickerAction(pane, 'resume', BROWSER)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(m.resumeIntents, [], 'a disabled Folder-era Resume dispatches nothing')
  // A real re-expanded Folder exposes Show more; selecting it has the same rule.
  pane.key('\r')
  await waitUntil('Enter collapses the currently expanded Folder', () =>
    items(pane).some(item => item.id === 'workspace:ws-folder' && item.open === false))
  pane.key('\r')
  await waitUntil('Enter expands the Folder and reveals Show more', () => items(pane).some(item => item.id === 'more:ws-folder'))
  sendSelect(pane, 'more:ws-folder', picker(pane)!.id)
  await waitUntil('Show more is the typed selection', () => props(pane).selected === 'more:ws-folder')
  assert.equal(pickerActionByBase(pane, 'resume', BROWSER)?.disabled, 'Select a session to resume.')
  sendSelect(pane, 'session:session-other', picker(pane)!.id)
  await waitUntil('a Session row is selected again', () => props(pane).selected === 'session:session-other')
  await waitUntil('Resume is enabled for that Session', () => pickerActionByBase(pane, 'resume', BROWSER)?.disabled === undefined)
})

test('synthetic Unassigned/ambiguous groups never authorize a Host create or directory adoption', async (t) => {
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-empty', path: '/srv/empty', title: 'Empty', sessionIds: [] },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({
    list: async () => [row('session-unassigned')],
  }), false, 'ready', {}, { sessionBrowser: true }, facts, {
    onUseDirectory: () => { throw new Error('synthetic groups must never adopt a directory') },
    onWorkspaceNewSession: () => { throw new Error('synthetic groups must never create a Session') },
  }, null)
  const { pane } = m
  await waitUntil('the synthetic Unassigned group is listed', () => items(pane).some(item => item.id === 'workspace:unassigned'))
  sendSelect(pane, 'workspace:unassigned', picker(pane)!.id)
  await waitUntil('the synthetic group is selected', () => props(pane).selected === 'workspace:unassigned')
  assert.equal(pickerActionByBase(pane, 'new-session', BROWSER)?.disabled, 'Select an official Workspace folder first.')
  assert.equal(pickerActionByBase(pane, 'use-directory', BROWSER)?.disabled, 'Select an official Workspace while sessionless.')
  sendPickerAction(pane, 'new-session', BROWSER)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(m.fatals.length, 0, 'no Host create or adoption was attempted for the synthetic group')
})

test('the same Activity facts paint the compact row status and the complete Details facts', async (t) => {
  const activity = [
    {
      sessionId: 'session-current',
      running: true,
      pendingKinds: [] as const,
      continuedQuestionCallIds: [] as const,
      attention: 'none' as const,
      attentionSourceState: 'known' as const,
    },
  ]
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => activity,
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-folder', path: '/srv/folder', title: 'Folder', sessionIds: ['session-current', 'session-other'] },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({
    list: async () => [row('session-current'), row('session-other', { updatedAt: 90 })],
  }), false, 'ready', {}, { sessionBrowser: true }, facts)
  const { pane } = m
  // Wait for the accepted Activity sample to be painted: the row detail is the
  // authoritative observation, and it also settles the frame revision before
  // the Details action is dispatched.
  await waitUntil('the working row paints its positive status', () => String(
    items(pane).find(item => item.id === 'session:session-current')?.detail ?? '',
  ).includes('Working'))
  const currentItem = items(pane).find(item => item.id === 'session:session-current')!
  assert.match(String(currentItem.detail), /Working/u, 'the compact row carries the positive working fact')
  sendSelect(pane, 'session:session-current', picker(pane)!.id)
  await waitUntil('the current row is selected', () => props(pane).selected === 'session:session-current')
  // Use the Footer keyboard route (Tab focuses the FIRST enabled action, Enter
  // activates it). Unlike a raw `action` event id, this carries no revision, so
  // the just-published Activity frame cannot invalidate it.
  pane.key('\t')
  await waitUntil('the Footer focuses Details', () =>
    ((pickerProps(pane, BROWSER).actions ?? []) as Array<{ readonly label?: unknown }>).some(action => String(action.label).includes('Details [Enter]')))
  pane.key('\r')
  await waitUntil('Details opens', () => details(pane) !== undefined)
  const grids = detailGroups(pane)
  assert.deepEqual(grids.get('activity')?.filter(([label]) => ['Running', 'Pending', 'Source'].includes(label)), [
    ['Running', 'Yes'],
    ['Pending', 'No pending'],
    ['Source', 'known'],
  ], `Details keeps the complete activity truth: ${JSON.stringify(grids.get('activity'))}`)
})

test('global Cards search never keeps a Folder-only Footer action target', async (t) => {
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-folder', path: '/srv/folder', title: 'Folder', sessionIds: ['session-current', 'session-other'] },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({
    list: async () => [row('session-current'), row('session-other', { updatedAt: 90 })],
  }), false, 'ready', {}, { sessionBrowser: true }, facts)
  const { pane } = m
  await waitUntil('the Folder is listed', () => items(pane).some(item => item.id === 'workspace:ws-folder'))
  sendSelect(pane, 'workspace:ws-folder', picker(pane)!.id)
  await waitUntil('the Folder is selected with its action', () => props(pane).selected === 'workspace:ws-folder'
    && pickerActionByBase(pane, 'new-session', BROWSER)?.disabled === undefined)
  pane.key('needle')
  await waitUntil('typing enters the global Cards search', () => props(pane).layout === 'cards')
  assert.equal(pickerActionByBase(pane, 'new-session', BROWSER), undefined,
    'Cards never offer a Folder-only New session with an invisible prior target')
  assert.equal(pickerActionByBase(pane, 'use-directory', BROWSER), undefined)
  pane.key('\x1b')
  await waitUntil('clearing the query restores the browse Folder selection', () =>
    props(pane).layout === 'tree' && props(pane).selected === 'workspace:ws-folder')
  await waitUntil('the Folder action is restored with the visible Folder', () =>
    pickerActionByBase(pane, 'new-session', BROWSER)?.disabled === undefined)
})

test('the Folder New session action delegates its exact Workspace and retires only on the commit continuation', async (t) => {
  const requests: Array<{ readonly workspaceId: string; readonly close: () => void }> = []
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [
          { workspaceId: 'ws-folder', path: '/srv/folder', title: 'Folder', sessionIds: ['session-current', 'session-other'] },
        ] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({
    list: async () => [row('session-current'), row('session-other', { updatedAt: 90 })],
  }), false, 'ready', {}, { sessionBrowser: true }, facts, {
    onWorkspaceNewSession: (workspaceId, closeAfterCommit) => { requests.push({ workspaceId, close: closeAfterCommit }) },
  })
  const { pane } = m
  await waitUntil('the official folder is listed', () => items(pane).some(item => item.id === 'workspace:ws-folder'))
  sendSelect(pane, 'workspace:ws-folder', picker(pane)!.id)
  await waitUntil('the Folder is selected before its action', () => props(pane).selected === 'workspace:ws-folder')
  const action = pickerActionByBase(pane, 'new-session', BROWSER)
  assert.ok(action !== undefined && action.disabled === undefined, 'New session is offered for the selected Folder')
  sendPickerAction(pane, 'new-session', BROWSER)
  await waitUntil('the action reaches the shared command owner', () => requests.length === 1)
  assert.equal(requests[0]!.workspaceId, 'ws-folder', 'the existing /new transaction receives the official WorkspaceId')
  assert.ok(picker(pane) !== undefined, 'a refusal (no commit continuation) keeps the same Browser open')
  assert.deepEqual(m.resumeIntents, [], 'Folder New session never becomes a Resume intent')
  requests[0]!.close()
  await waitUntil('the committed transaction continuation retires the Browser', () => picker(pane) === undefined)
})

test('a failed first-submit chooser opens the same TSP Browser prefilled in Host path mode and submits once per settlement', async (t) => {
  const submittedPaths: string[] = []
  const settlements: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const m = await mounted(t, reader({ list: async () => [] }), false, 'ready', {
    initialDirectoryChooser: true,
    initialDirectoryEntry: true,
    initialDirectoryPath: '/launch/failed',
  }, { sessionBrowser: true }, undefined, {
    onAddDirectory: (path, settle) => { submittedPaths.push(path); settlements.push(settle) },
  }, null)
  const { pane } = m
  assert.equal(m.presentedDirectoryEntry(), true)
  assert.equal(m.presentedInitialDirectoryEntry(), true)
  assert.equal(m.presentedInitialDirectoryPath(), '/launch/failed')
  await waitUntil('the same Browser opens directly in the retained Host path mode', () =>
    props(pane).title === 'Add directory' && props(pane).query === '/launch/failed')
  pane.key('\r')
  await waitUntil('the failed launch path reaches Host resolution once', () => submittedPaths.length === 1)
  pane.key('\r')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(submittedPaths, ['/launch/failed'], 'the verification owner is single-flight until settlement')
  settlements[0]!({ kind: 'failed', message: 'refused on Host' })
  await waitUntil('failure retains the launch path in the same submode', () => props(pane).query === '/launch/failed')
  assert.equal(props(pane).title, 'Add directory')
  // Escape from the action-focused path submode cancels the PATH ENTRY, never
  // the whole Browser: the retained path and the same Picker stay live.
  pane.key('\t')
  await waitUntil('Tab focuses the path actions', () => props(pane).focus !== 'list')
  pane.key('\u001b')
  await waitUntil('Escape in path mode cancels only the path entry', () => picker(pane) !== undefined && props(pane).title === 'Sessions')
  sendPickerAction(pane, 'add-directory', BROWSER)
  await waitUntil('the path editor reopens for the same Browser', () => props(pane).title === 'Add directory')
  assert.equal(props(pane).query, '', 'a cancelled path entry starts empty')
  pane.key('/launch/failed')
  pane.key('\t')
  pane.key('\r')
  await waitUntil('the visible Use directory action retries the retained path', () => submittedPaths.length === 2)
  settlements[1]!({ kind: 'registered', workspaceId: 'ws-launch', path: '/host/canonical' })
  await waitUntil('Host success closes the existing chooser lease', () => picker(pane) === undefined)
  assert.equal(m.fatals.length, 0)
})
test('Use directory selects a canonical official Workspace and closes the sessionless chooser', async (t) => {
  let selectedWorkspace: { readonly id: string; readonly path: string } | undefined
  const workspaceFacts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: (signal) => ({
      dispose() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline' as const, items: [{ workspaceId: 'ws-existing', path: '/srv/canonical', title: 'Existing', sessionIds: [] }] }
        if (signal?.aborted === true) return
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }),
  }
  const m = await mounted(t, reader({ list: async () => [] }), false, 'ready', { initialDirectoryChooser: true },
    { sessionBrowser: true }, workspaceFacts, {
      onUseDirectory: (id, path) => { selectedWorkspace = { id, path } },
    }, null)
  await waitUntil('official chooser Folder is visible', () => items(m.pane).some(item => item.id === 'workspace:ws-existing'))
  sendSelect(m.pane, 'workspace:ws-existing', picker(m.pane)!.id)
  await waitUntil('Use directory is enabled for the selected sessionless folder', () => {
    const action = pickerActionByBase(m.pane, 'use-directory', BROWSER)
    return action !== undefined && action.disabled === undefined
  })
  sendPickerAction(m.pane, 'use-directory', BROWSER)
  await waitUntil('Use directory returns from the same Browser', () => picker(m.pane) === undefined)
  assert.deepEqual(selectedWorkspace, { id: 'ws-existing', path: '/srv/canonical' })
})

test('native Browser flat fallback keeps all listed Sessions, then a global cards union with Host-owned excerpts', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const initial = props(pane)
  assert.equal(initial.layout, 'tree')
  assert.equal(initial.size, 'lg')
  assert.deepEqual(initial.current, ['session:session-current'])
  assert.equal(initial.selected, 'session:session-current')
  assert.equal(initial.scopes, undefined)
  assert.deepEqual(items(pane).map((entry) => entry.id), [
    'session:session-current',
    'session:session-other',
    'session:session-content',
    'session:session-cross-child',
    'session:session-orphan',
    'session:session-cycle-a',
    'session:session-cycle-b',
  ])
  assert.deepEqual(items(pane).map((entry) => entry.depth), [0, 0, 0, 0, 0, 0, 0],
    'missing official Workspace baseline paints one flat fallback, never cwd groups')
  assert.deepEqual(order(pane), items(pane).map(entry => String(entry.id)))
  assert.equal(items(pane)[0]?.label, 'Needle current title', 'terminal sequences are removed from projected titles')

  const pickerId = picker(pane)!.id
  const surfaceId = pane.frames().at(-1)!.sf
  const currentResume = pickerActionByBase(pane, 'resume', BROWSER)
  assert.equal(currentResume?.disabled, 'The current session is already active.')
  sendPickerAction(pane, 'resume', BROWSER)
  assert.equal(m.resumeIntents.length, 0, 'Current cannot emit a Footer Resume intent')
  assert.ok(picker(pane) !== undefined, 'the disabled Footer Resume is inert, never a Return')
  sendSelect(pane, 'session:session-other', pickerId)
  await waitUntil('a non-current row is selected', () => props(pane).selected === 'session:session-other')
  assert.deepEqual(props(pane).current, ['session:session-current'])
  const resumeAction = pickerActionByBase(pane, 'resume', BROWSER)
  assert.ok(resumeAction)
  assert.equal(resumeAction.disabled, undefined, 'a listed non-current row enables Resume')
  assert.equal(resumeAction.primary, true, 'Resume is the enabled primary footer action')
  const oldResumeActionId = String(resumeAction.id)
  assert.match(oldResumeActionId, /^resume#/u, 'the rendered Resume action carries its frame revision')

  sendAction(pane, oldResumeActionId, undefined, pickerId)
  await waitUntil('footer activation dispatches one resume intent', () => m.resumeIntents.length === 1)
  assert.deepEqual(m.resumeIntents[0], {
    sessionId: 'session-other', currentSessionId: 'session-current', source: 'footer',
  })
  await waitUntil('the pending switch disables another Resume', () =>
    pickerActionByBase(pane, 'resume', BROWSER)?.disabled === 'Switching sessions…')
  sendPickerAction(pane, 'resume', BROWSER)
  sendActivate(pane, 'session:session-other', pickerId)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(m.resumeIntents.length, 1, 'Footer and row repeats during pending cannot dispatch twice')
  m.resumeSettlements[0]!({ kind: 'switched', sessionId: 'session-other' })
  await waitUntil('settling the operation re-enables Resume', () =>
    pickerActionByBase(pane, 'resume', BROWSER)?.disabled === undefined)

  const settledResumeAction = pickerActionByBase(pane, 'resume', BROWSER)
  assert.ok(settledResumeAction)
  assert.notEqual(String(settledResumeAction.id), oldResumeActionId,
    'the settled Footer action belongs to a newer frame revision')
  pane.event({ ev: 'action', sf: surfaceId, id: pickerId, act: oldResumeActionId })
  pane.event({ ev: 'action', sf: `${surfaceId}-foreign`, id: pickerId, act: String(settledResumeAction.id) })
  pane.event({ ev: 'select', sf: surfaceId, id: pickerId, item: 'session:not-listed' })
  sendSelect(pane, 'session:session-cross-child', pickerId)
  await waitUntil('later valid selection is processed', () => props(pane).selected === 'session:session-cross-child')
  assert.equal(m.resumeIntents.length, 1,
    'an old resume#revision, foreign surface, or unlisted row dispatches no extra Resume')
  assert.equal(details(pane), undefined, 'stale action tokens and unlisted row ids cannot enter Details')
  assert.deepEqual(props(pane).current, ['session:session-current'])

  pane.key('needle')
  await waitUntil('global cards search is ready', () => props(pane).layout === 'cards' && props(pane).state === 'ready')
  assert.equal(props(pane).query, 'needle')
  assert.deepEqual(items(pane).map((entry) => entry.id), ['session:session-current', 'session:session-content'])
  assert.deepEqual(order(pane), items(pane).map((entry) => entry.id), 'global search Cards do not carry workspace groups')
  const currentCard = items(pane)[0]!
  const contentCard = items(pane)[1]!
  assert.equal((currentCard.badges as Array<Record<string, unknown>>)[0]?.text, 'Both')
  assert.ok((contentCard.badges as Array<Record<string, unknown>>).some((badge) => badge.text === 'Content'))
  assert.match(String(contentCard.detail), /Host content excerpt/u)
  assert.doesNotMatch(String(contentCard.detail), /\u001b/u, 'Host excerpt is terminal-sanitized at presentation')
  assert.equal(props(pane).total, 2)
  assert.match(String(props(pane).message), /refine the query/u, 'hasMore is a refine hint, never a page request')
  assert.equal(m.fatals.length, 0)
})

test('Current keyboard Enter closes the native Browser with no Resume intent', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  assert.equal(props(pane).selected, 'session:session-current', 'the current row is the initial selection')
  assert.deepEqual(props(pane).current, ['session:session-current'])
  assert.equal(pickerActionByBase(pane, 'resume', BROWSER)?.disabled, 'The current session is already active.')
  pane.key('\r')
  await waitUntil('Current Enter closes the Browser', () => picker(pane) === undefined)
  assert.deepEqual(m.resumeIntents, [], 'Current Enter is a Return, never a Resume intent')
  assert.equal(m.presentedHandleIsDisposed(), true, 'the same read handle is disposed by the Return')
  assert.equal(m.fatals.length, 0, 'returning to the same Session never fails')
})

test('Current native activate closes while native select only selects', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const pickerId = picker(pane)!.id
  sendSelect(pane, 'session:session-current', pickerId)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(picker(pane) !== undefined, 'a native select on the current row only selects')
  assert.equal(props(pane).selected, 'session:session-current')
  assert.deepEqual(m.resumeIntents, [], 'native select never emits a Resume intent')
  sendActivate(pane, 'session:session-current', pickerId)
  await waitUntil('Current activate closes the Browser', () => picker(pane) === undefined)
  assert.deepEqual(m.resumeIntents, [], 'Current activate is a Return, never a Resume intent')
  assert.equal(m.presentedHandleIsDisposed(), true, 'the same read handle is disposed by the Return')
  assert.equal(m.fatals.length, 0)
})

test('disabled current Resume is inert while native Close still closes', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  sendPickerAction(pane, 'resume', BROWSER)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(picker(pane) !== undefined, 'the disabled Footer Resume never closes the Browser')
  assert.deepEqual(m.resumeIntents, [], 'the disabled Footer Resume emits no intent')
  assert.equal(pickerActionByBase(pane, 'resume', BROWSER)?.disabled, 'The current session is already active.')
  sendPickerAction(pane, 'close', BROWSER)
  await waitUntil('native Close retires the Browser', () => picker(pane) === undefined)
  assert.deepEqual(m.resumeIntents, [])
})

test('a retired native Picker identity never closes or resumes the newer Browser', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const oldPickerId = picker(pane)!.id
  const oldSurface = pane.frames().at(-1)!.sf
  pane.key('\r')
  await waitUntil('the first Browser returns on the current row', () => picker(pane) === undefined)

  m.owner.open()
  await waitUntil('the second Browser is ready', () => picker(pane) !== undefined && props(pane).state === 'ready')
  const newPickerId = picker(pane)!.id
  assert.notEqual(newPickerId, oldPickerId, 'a new open gets its own Picker identity')
  pane.event({ ev: 'activate', sf: oldSurface, id: oldPickerId, item: 'session:session-current' })
  pane.event({ ev: 'select', sf: oldSurface, id: oldPickerId, item: 'session:session-other' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(picker(pane) !== undefined, 'the retired identity cannot close the newer Browser')
  assert.equal(props(pane).selected, 'session:session-current', 'the retired identity cannot select in the newer Browser')
  assert.deepEqual(m.resumeIntents, [], 'the retired identity cannot resume')

  // A LIVE non-current activate keeps the pre-existing guarded Resume intent.
  sendSelect(pane, 'session:session-other', newPickerId)
  await waitUntil('the newer Browser selects the non-current row', () => props(pane).selected === 'session:session-other')
  sendActivate(pane, 'session:session-other', newPickerId)
  await waitUntil('the live non-current activate reaches the read owner', () => m.resumeIntents.length === 1)
  assert.deepEqual(m.resumeIntents[0], {
    sessionId: 'session-other', currentSessionId: 'session-current', source: 'activate',
  })
})

test('footer keyboard focus visits only enabled actions', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const actionLabels = (): string[] => (props(pane).actions as Array<Record<string, unknown>>)
    .map((action) => String(action.label))

  pane.key('\t')
  await waitUntil('the first Tab focuses enabled Footer actions', () => props(pane).focus !== 'list' && actionLabels().includes('Details [Enter]'))
  assert.deepEqual(actionLabels().filter((label) => label.endsWith('[Enter]')), ['Details [Enter]'])
  assert.equal(pickerActionByBase(pane, 'resume', BROWSER)?.disabled, 'The current session is already active.')

  pane.key('\u001b[C')
  await waitUntil('ArrowRight skips disabled Resume and wraps to Close', () => actionLabels().includes('Close [Enter]'))
  assert.deepEqual(actionLabels().filter((label) => label.endsWith('[Enter]')), ['Close [Enter]'])
  pane.key('\u001b[C')
  await waitUntil('the enabled footer ring returns to Details', () => actionLabels().includes('Details [Enter]'))
  assert.deepEqual(actionLabels().filter((label) => label.endsWith('[Enter]')), ['Details [Enter]'])
})

test('empty Browser footer focus falls back to enabled Close', async (t) => {
  const m = await mounted(t, reader({ list: async () => [] }), false)
  const { pane } = m
  const actionLabels = (): string[] => (props(pane).actions as Array<Record<string, unknown>>)
    .map((action) => String(action.label))

  pane.key('\t')
  await waitUntil('the first Tab focuses enabled Close action', () => actionLabels().includes('Close [Enter]'))
  assert.deepEqual(actionLabels().filter((label) => label.endsWith('[Enter]')), ['Close [Enter]'])
  assert.equal(pickerActionByBase(pane, 'details', BROWSER)?.disabled, 'Select a session to read its details.')
  assert.equal(pickerActionByBase(pane, 'resume', BROWSER)?.disabled, 'Select a session to resume.')

  const previousFrames = pane.frameCount()
  pane.key('\u001b[C')
  await waitUntil('the single enabled action retains focus', () => pane.frameCount() > previousFrames
    && actionLabels().includes('Close [Enter]'))
  assert.deepEqual(actionLabels().filter((label) => label.endsWith('[Enter]')), ['Close [Enter]'])
})

for (const listState of ['empty', 'loading', 'unavailable', 'error'] as const) {
  test(`Resume is disabled and inert while the persisted list is ${listState}`, async (t) => {
    let resolveList!: (rows: SessionSummary[] | undefined) => void
    const loadingList = new Promise<SessionSummary[] | undefined>((resolve) => { resolveList = resolve })
    const m = await mounted(t, reader({
      list: async () => {
        if (listState === 'loading') return loadingList
        if (listState === 'unavailable') return undefined
        if (listState === 'error') throw new Error('controlled listing failure')
        return []
      },
    }), false, listState === 'loading' ? 'loading' : listState === 'empty' ? 'ready' : 'error')
    try {
      const expectedEmpty = {
        empty: 'No persisted sessions are available.',
        loading: 'Loading persisted sessions…',
        unavailable: 'No session listing capability is available.',
        error: 'The session list could not be loaded.',
      } as const
      assert.equal(props(m.pane).empty, expectedEmpty[listState])
      const resume = pickerActionByBase(m.pane, 'resume', BROWSER)
      assert.ok(resume)
      assert.notEqual(resume.disabled, undefined, 'no list result offers an enabled Resume')
      if (listState === 'loading') {
        assert.equal(resume.disabled, 'Sessions are still loading.')
      } else {
        assert.equal(resume.disabled, 'Select a session to resume.')
      }
      sendPickerAction(m.pane, 'resume', BROWSER)
      assert.equal(m.resumeIntents.length, 0, 'a disabled Footer event is inert')
      assert.equal(m.fatals.length, 0)
    } finally {
      if (listState === 'loading') resolveList([])
    }
  })
}

test('query over failed listing remains an error instead of content-search loading', async (t) => {
  let searchCalls = 0
  const m = await mounted(t, reader({
    list: async () => { throw new Error('list failed') },
    search: async () => { searchCalls++; return undefined },
  }), false, 'error')
  const { pane } = m

  pane.key('needle')
  await waitUntil('failed-list query is captured', () => props(pane).query === 'needle')
  assert.equal(props(pane).state, 'error')
  assert.match(String(props(pane).message), /Session listing failed: list failed/u)
  assert.doesNotMatch(String(props(pane).message), /Searching session content/u)
  assert.equal(props(pane).empty, 'The session list could not be loaded.')
  assert.equal(searchCalls, 0)
})

test('browse row activity age uses updatedAt rather than createdAt', async (t) => {
  const createdAt = Date.now() - 40 * 24 * 60 * 60 * 1000
  const updatedAt = Date.now() - 60 * 1000
  assert.notEqual(formatSessionAge(createdAt), formatSessionAge(updatedAt), 'the fixture separates creation and activity ages')
  const m = await mounted(t, reader({
    list: async () => [row('session-recent', { createdAt, updatedAt })],
    projectionBatch: async () => new Map(),
  }), false)
  const detail = String(items(m.pane)[0]?.detail)
  assert.ok(detail.includes(`Updated ${formatSessionAge(updatedAt)}`), detail)
})

test('55-row projection batches keep the native Picker identity and selected row', async (t) => {
  const rows = Array.from({ length: 55 }, (_, index) => {
    const id = `session-row-${String(index).padStart(2, '0')}`
    const parentSession = index === 0 ? undefined : `session-row-${String(index - 1).padStart(2, '0')}`
    return row(id, {
      cwd: index % 2 === 0 ? '/workspace/project' : '/workspace/other',
      parentSession,
    })
  })
  const firstBatch = deferred<Map<string, SessionProjectionSummary>>()
  const batchSizes: number[] = []
  const m = await mounted(t, reader({
    list: async () => rows,
    projectionBatch: async (batch) => {
      batchSizes.push(batch.length)
      return batch[0]?.id === 'session-row-00'
        ? firstBatch.promise
        : new Map(batch.map((entry) => [entry.id, { preset: 'reviewer' }]))
    },
  }), false)
  const { pane } = m
  assert.equal(items(pane).length, 55, 'the missing Workspace baseline keeps the complete roster in flat fallback')
  pane.key('\u001b[F')
  await waitUntil('End selects the final main row', () => props(pane).selected === 'session:session-row-54')
  pane.key('\u001b[H')
  await waitUntil('Home selects the first main row', () => props(pane).selected === 'session:session-row-00')
  pane.key('\u001b[6~')
  await waitUntil('PageDown advances the native selection by five', () => props(pane).selected === 'session:session-row-05')
  pane.key('\u001b[5~')
  await waitUntil('PageUp returns to the top selection', () => props(pane).selected === 'session:session-row-00')
  const pickerId = picker(pane)!.id
  const selected = props(pane).selected
  firstBatch.resolve(new Map([['session-row-00', { title: 'Projected αβ🙂 title', preset: 'reviewer' }]]))
  await waitUntil('first projection enriches the current Picker', () => items(pane)[0]?.label === 'Projected αβ🙂 title')
  assert.equal(picker(pane)!.id, pickerId)
  assert.equal(props(pane).selected, selected)
  assert.equal(items(pane).length, 55)
  await waitUntil('remaining 35 main rows receive projection enrichment', () => String(items(pane).at(-1)?.detail).includes('Preset reviewer'))
  assert.deepEqual(batchSizes, [20, 35], 'the first projection page yields before the remaining main rows')
})

test('unavailable Host search with no metadata match is not presented as an ordinary empty search', async (t) => {
  const m = await mounted(t, reader({
    list: async () => [row('session-other')],
    projectionBatch: async (batch) => new Map(batch.map((entry) => [entry.id, { title: 'An unrelated title' }])),
    search: async () => undefined,
  }), false)
  const { pane } = m
  pane.key('needle')
  await waitUntil('content capability unavailable', () => props(pane).state === 'error'
    && props(pane).empty === 'No metadata matches; content search is unavailable.')
  assert.deepEqual(items(pane), [])
  assert.match(String(props(pane).message), /content search is unavailable/iu)
})

test('projection failure does not mask unavailable Host search status', async (t) => {
  const m = await mounted(t, reader({
    list: async () => [row('needle-session')],
    projectionBatch: async () => { throw new Error('Projection unavailable') },
    search: async () => undefined,
  }), false)
  const { pane } = m
  await waitUntil('projection failure is visible before search', () =>
    String(props(pane).message).includes('Some session details are unavailable'))
  pane.key('needle')
  await waitUntil('metadata match and both partial-state messages are visible', () => {
    const message = String(props(pane).message)
    return props(pane).state === 'error'
      && message.includes('Content search is unavailable')
      && message.includes('Some session details are unavailable')
  })
  assert.deepEqual(items(pane).map((item) => item.id), ['session:needle-session'])
})

test('projection failure does not mask thrown Host search status', async (t) => {
  const m = await mounted(t, reader({
    list: async () => [row('needle-session')],
    projectionBatch: async () => { throw new Error('Projection unavailable') },
    search: async () => { throw new Error('Host index failed') },
  }), false)
  const { pane } = m
  await waitUntil('projection failure is visible before search', () =>
    String(props(pane).message).includes('Some session details are unavailable'))
  pane.key('needle')
  await waitUntil('metadata match and both failure messages are visible', () => {
    const message = String(props(pane).message)
    return props(pane).state === 'error'
      && message.includes('Content search failed: Host index failed')
      && message.includes('Some session details are unavailable')
  })
  assert.deepEqual(items(pane).map((item) => item.id), ['session:needle-session'])
})

test('projection failure remains secondary to loading and hasMore search status', async (t) => {
  const page = deferred<SessionContentSearchPage | undefined>()
  let searchCalls = 0
  const m = await mounted(t, reader({
    list: async () => [row('needle-session')],
    projectionBatch: async () => { throw new Error('Projection unavailable') },
    search: async () => { searchCalls += 1; return page.promise },
  }), false)
  const { pane } = m
  await waitUntil('projection failure is visible before search', () =>
    String(props(pane).message).includes('Some session details are unavailable'))
  pane.key('needle')
  await waitUntil('loading remains visible while Host search is pending', () => {
    const message = String(props(pane).message)
    return searchCalls === 1 && props(pane).state === 'loading'
      && message.includes('Searching session content…')
      && message.includes('Some session details are unavailable')
  })
  page.resolve({ items: [], hasMore: true })
  await waitUntil('hasMore remains explicit after Host search completes', () => {
    const message = String(props(pane).message)
    return props(pane).state === 'ready'
      && message.includes('More matches are available; refine the query.')
      && message.includes('Some session details are unavailable')
  })
  assert.deepEqual(items(pane).map((item) => item.id), ['session:needle-session'])
})

test('no Workspace baseline renders a flat fallback; official baseline has a dedicated folder-item proof above', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  assert.equal(order(pane).length, items(pane).length)
  assert.ok(order(pane).every(entry => typeof entry === 'string'))
  assert.ok(items(pane).every(entry => !String(entry.id).startsWith('workspace:')))
})

test('Details preserves search state, scrolls its own body, and emits read-only Resume intents', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  pane.key('needle')
  await waitUntil('global cards search is ready', () => props(pane).layout === 'cards' && props(pane).state === 'ready')
  sendSelect(pane, 'session:session-content', picker(pane)!.id)
  await waitUntil('content hit selected', () => props(pane).selected === 'session:session-content')
  sendPickerAction(pane, 'details', BROWSER)
  await waitUntil('Details overlay replaces the picker', () => details(pane) !== undefined)
  assert.equal(picker(pane), undefined)
  assert.equal(layerNodes(pane, BROWSER).filter((node) => node.k === 'overlay').length, 1)
  assert.ok(detailBody(pane))
  const firstDetails = sheetText(pane, BROWSER)
  // The four fact groups reach the pane as grids, so the text sheet carries only
  // what is genuinely text here: the overlay head, the Back row, each group head
  // and the Host excerpt. The FACTS are read from the grids' own props below.
  assert.match(firstDetails, /Identity/u)
  assert.match(firstDetails, /Host content excerpt/u, 'the excerpt source names the group in its head')
  assert.match(firstDetails, /Matching content/u, 'and the excerpt label stays a text row')
  const grids = detailGroups(pane)
  assert.deepEqual([...grids.keys()], ['identity', 'activity', 'relationship', 'configuration'],
    'each group is exactly ONE grid, in the reading order, and the excerpt is not one')
  assert.deepEqual(grids.get('identity'), [
    ['Session ID', 'session-content'],
    ['Title', 'Unrelated title'],
    ['State', 'Persisted session'],
    ['Workspace', '/workspace/other'],
  ], 'Identity carries the row\'s own complete facts in order')
  assert.deepEqual(grids.get('activity'), [
    ['Created', new Date(10).toISOString()],
    ['Updated', new Date(100).toISOString()],
    ['Running', 'Unknown'],
    ['Pending', 'Unknown'],
    ['Source', 'unknown'],
  ], 'Activity is the ISO stamps plus the complete, unproven-by-default activity facts')
  assert.deepEqual(grids.get('relationship'), [['Parent session', 'session-other']],
    'Lineage is the projection\'s own parent')
  assert.deepEqual(grids.get('configuration'), [['Agent preset', 'reviewer']],
    'Configuration is the projected preset')
  for (const [, value] of [...grids.get('identity')!, ...grids.get('activity')!]) {
    assert.doesNotMatch(value, /\u001b/u, `no grid value carries a control sequence: ${value}`)
  }
  // The excerpt is matched CONTENT, so it is one complete wrapped text node and not
  // a grid pair — even on a pane that negotiated `kv`.
  assert.equal(
    kvNodes(pane).some((node) => String(node.p.key ?? '').endsWith('excerpt')),
    false,
    'the excerpt group holds no grid',
  )
  assert.ok(detailTextRuns(pane).some((text) => text === 'Host content excerpt'),
    'and the excerpt body is the complete text the Host returned')
  assert.doesNotMatch(firstDetails, /\u001b/u)
  const firstBackId = layerNodes(pane, BROWSER).find((node) => node.k === 'row' && node.id.includes('session-browser-back-'))!.id
  const bodyId = detailBody(pane)!.id
  const before = scrollOps(pane).length
  pane.key('\u001b[B')
  await waitUntil('Reader line scroll is sent to the current body', () => scrollOps(pane).length === before + 1)
  assert.deepEqual(scrollOps(pane).at(-1), { id: bodyId, to: 'line-down' })
  pane.key('\u001b[6~')
  await waitUntil('Reader page scroll is sent to the same body', () => scrollOps(pane).length === before + 2)
  assert.deepEqual(scrollOps(pane).at(-1), { id: bodyId, to: 'page-down' })

  pane.key('\u001b')
  await waitUntil('Esc returns to the same browse page', () => details(pane) === undefined && picker(pane) !== undefined)
  assert.equal(props(pane).query, 'needle')
  assert.equal(props(pane).selected, 'session:session-content')
  sendPickerAction(pane, 'details', BROWSER)
  await waitUntil('second Details reading opens', () => details(pane) !== undefined)
  const secondBodyId = detailBody(pane)!.id
  assert.notEqual(secondBodyId, bodyId, 'each reading gets its own scroll-body identity')
  const beforeSecondScroll = scrollOps(pane).length
  pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: firstBackId, act: 'click' })
  pane.key('\u001b[A')
  await waitUntil('second Reader scroll uses its own body', () => scrollOps(pane).length === beforeSecondScroll + 1)
  assert.deepEqual(scrollOps(pane).at(-1), { id: secondBodyId, to: 'line-up' })
  assert.ok(details(pane), 'the retired Reader Back event cannot close the newer reading')
  pane.key('\u001b')
  await waitUntil('second Reader returns to the same browse state', () => details(pane) === undefined && picker(pane) !== undefined)
  assert.equal(props(pane).query, 'needle')
  assert.equal(props(pane).selected, 'session:session-content')
  pane.key('\u001b')
  await waitUntil('clearing search restores the Browse selection', () => props(pane).layout === 'tree' && props(pane).selected === 'session:session-current')
  assert.equal(props(pane).selected, 'session:session-current', 'clearing search restores the pre-search selection')
  sendSelect(pane, 'session:session-current', picker(pane)!.id)
  await waitUntil('Current is independently selected', () => props(pane).selected === 'session:session-current')
  // A row SELECT never activates: the current row is deliberately not returned
  // from this selection path (the dedicated Current Enter case owns the Return).
  sendSelect(pane, 'session:session-content', picker(pane)!.id)
  await waitUntil('a later selection still processes', () => props(pane).selected === 'session:session-content')
  assert.equal(m.resumeIntents.length, 0, 'selecting the current Session never resumes it')
  sendActivate(pane, 'session:session-content', picker(pane)!.id)
  await waitUntil('activation emits only a Resume intent', () => m.resumeIntents.length === 1)
  assert.deepEqual(m.resumeIntents[0], {
    sessionId: 'session-content',
    currentSessionId: 'session-current',
    source: 'activate',
  })
  m.resumeSettlements[0]!({ kind: 'switched', sessionId: 'session-content' })
  await waitUntil('activation settlement clears the pending state', () =>
    pickerActionByBase(pane, 'resume', BROWSER)?.disabled === undefined)
  pane.key('\r')
  await waitUntil('Enter emits only a Resume intent', () => m.resumeIntents.length === 2)
  assert.deepEqual(m.resumeIntents[1], {
    sessionId: 'session-content',
    currentSessionId: 'session-current',
    source: 'enter',
  })
  assert.equal(m.fatals.length, 0)
})

test('host migration-required state is read-only in row detail, content hits, and Details', async (t) => {
  const m = await mounted(t, reader({
    list: async () => [
      row('session-current', { live: true, formatStatus: 'current' }),
      row('session-other', { formatStatus: 'migration-required' }),
      row('session-absent', { cwd: '/workspace/other' }),
    ],
    projectionBatch: async (rows) => new Map(rows.map((entry) => [entry.id, { title: `${entry.id} title` }])),
    search: async () => ({
      items: [{ sessionId: 'session-other', snippet: 'Host content excerpt' }],
      hasMore: false,
    }),
  }), false)
  const { pane } = m
  await waitUntil('the three rows are listed', () => items(pane).length === 3)
  const detailOf = (id: string): string => String(items(pane).find((entry) => entry.id === `session:${id}`)?.detail)
  const migrating = detailOf('session-other')
  assert.ok(migrating.includes('Migration required'), migrating)
  assert.ok(migrating.indexOf('Updated') < migrating.indexOf('Migration required'),
    `the read-only state item follows Updated: ${migrating}`)
  assert.doesNotMatch(detailOf('session-current'), /Migration required/u, 'formatStatus=current adds nothing')
  assert.doesNotMatch(detailOf('session-absent'), /Migration required/u, 'an absent fact is never invented')

  // A Host content hit rebuilds the detail string: the state label must survive.
  pane.key('session-other')
  await waitUntil('the content-hit card is ready', () => props(pane).layout === 'cards' && props(pane).state === 'ready')
  const card = items(pane).find((entry) => entry.id === 'session:session-other')
  assert.ok(card, 'the migration-required row is a search card')
  assert.match(String(card?.detail), /Migration required/u)
  assert.match(String(card?.detail), /Host content excerpt/u)

  const framesBeforeSelect = pane.frameCount()
  sendSelect(pane, 'session:session-other', picker(pane)!.id)
  await waitUntil('the migration-required row is selected', () => props(pane).selected === 'session:session-other')
  // The single card may already be selected, so wait for the frame that carries
  // the fresh revision-scoped action before sending it.
  await waitUntil('the selection frame is rendered', () => pane.frameCount() > framesBeforeSelect)
  sendPickerAction(pane, 'details', BROWSER)
  await waitUntil('Details opens for the migration-required row', () => details(pane) !== undefined, 3_000)
  // The Host-authoritative state word reaches the grid value INTACT: the KV layout
  // aligns the pair, it never recomputes, reorders or drops the fact `rowStateText`
  // produced from the authoritative `formatStatus`.
  const grids = detailGroups(pane)
  assert.deepEqual(grids.get('identity')?.find(([label]) => label === 'State'),
    ['State', 'Persisted session · Migration required'],
    `the migration state survives into the grid value: ${JSON.stringify([...grids])}`)
  assert.equal(m.fatals.length, 0)
})

test('Details reports Unknown rather than inferring an absent createdAt', async (t) => {
  const m = await mounted(t, reader({
    list: async () => [row('session-current', { createdAt: undefined, updatedAt: 3_000, live: true })],
    projectionBatch: async () => new Map(),
  }), false)
  const { pane } = m
  await waitUntil('current row without createdAt is listed', () => items(pane).some((item) => item.id === 'session:session-current'))
  sendPickerAction(pane, 'details', BROWSER)
  await waitUntil('Details opens for row without createdAt', () => details(pane) !== undefined)
  const grids = detailGroups(pane)
  assert.deepEqual(grids.get('activity'), [
    ['Created', 'Unknown'],
    ['Updated', new Date(3_000).toISOString()],
    ['Running', 'Unknown'],
    ['Pending', 'Unknown'],
    ['Source', 'unknown'],
  ], `the absent stamp stays Unknown while the real one keeps its full ISO value: ${JSON.stringify([...grids])}`)
})

test('modal seat suspends Browser events and restores the same query/selection afterward', async (t) => {
  const m = await mounted(t)
  const { pane, renderer } = m
  pane.key('needle')
  await waitUntil('global cards search is ready', () => props(pane).layout === 'cards' && props(pane).state === 'ready')
  sendSelect(pane, 'session:session-content', picker(pane)!.id)
  await waitUntil('content hit selected', () => props(pane).selected === 'session:session-content')
  const pickerId = picker(pane)!.id
  const approval = renderer.interaction.showApprovalPrompt({ toolName: 'bash', reason: 'read-only modal priority' }, true)
  await waitUntil('modal overlay takes the layer', () => layerNodes(pane, 'modal-').some((node) => node.k === 'overlay'))
  sendSelect(pane, 'session:session-current', pickerId)
  pane.key('y')
  assert.equal(await approval, 'allowed-once')
  await waitUntil('Browser layer returns', () => picker(pane) !== undefined)
  assert.equal(props(pane).query, 'needle')
  assert.equal(props(pane).layout, 'cards')
  assert.equal(props(pane).selected, 'session:session-content', 'the hidden Browser did not receive the modal event')

  const question = renderer.interaction.askQuestions([
    { id: 'browser-question', question: 'Continue reading?', options: [{ label: 'Keep reading' }] },
  ], undefined, undefined, false)
  await waitUntil('Question form takes the layer', () => layerNodes(pane, 'modal-').some((node) => node.k === 'overlay'))
  sendSelect(pane, 'session:session-current', pickerId)
  pane.key('\u001b')
  await assert.rejects(question, /question flow cancelled/u)
  await waitUntil('Browser returns after Question cancellation', () => picker(pane) !== undefined)
  assert.equal(props(pane).query, 'needle')
  assert.equal(props(pane).selected, 'session:session-content', 'Question events do not change the suspended Browser')
})

test('Model, Browser, and Preset retire one another through the shared TSP layer', async (t) => {
  const m = await mounted(t)
  const { pane, renderer, owner } = m
  const retiredBrowserPickerId = picker(pane)!.id
  const model = renderer.modelPresentation!.open({
    subject: { sessionless: false },
    entry: 'models',
    apply: async () => 'rejected' as const,
    retry() {},
    isCurrent: () => true,
    runOwned: () => assert.fail('the exclusivity test must not submit a model operation'),
  })
  await waitUntil('Model takes the shared layer', () => pickerNode(pane, 'model-') !== undefined)
  assert.equal(picker(pane), undefined, 'opening Model retires Browser')
  owner.open()
  await waitUntil('Browser reclaims the shared layer', () => picker(pane) !== undefined && props(pane).state === 'ready')
  assert.equal(model.isDisposed(), true, 'opening Browser retires the previous Model panel')
  pane.event({
    ev: 'activate',
    sf: pane.frames().at(-1)!.sf,
    id: retiredBrowserPickerId,
    item: 'session:session-other',
  })
  pane.key('needle')
  await waitUntil('the replacement Browser processes input after the retired event', () => props(pane).query === 'needle')
  assert.equal(m.resumeIntents.length, 0, 'an activation addressed to the retired Browser panel is rejected')

  const preset = renderer.presetPresentation!.open({
    subject: { sessionless: false },
    apply: async () => ({ kind: 'rejected', message: 'unused' }),
    setDefault: async () => ({ kind: 'saved', preset: 'unused' }),
    retry() {},
    isCurrent: () => true,
    runOwned: () => assert.fail('the exclusivity test must not submit a preset operation'),
  })
  await waitUntil('Preset takes the shared layer', () => pickerNode(pane, 'preset-') !== undefined)
  assert.equal(picker(pane), undefined, 'the retired Browser is removed from the layer')
  const nextRead = owner.open()
  await waitUntil('a new Browser read reclaims the shared layer', () => picker(pane) !== undefined && props(pane).state === 'ready')
  assert.equal(preset.isDisposed(), true, 'opening Browser retires the previous Preset panel')
  assert.equal(pickerNode(pane, 'preset-'), undefined)
  nextRead.close()
})

test('capability negotiation fails closed without required Browser kinds or scroll', async () => {
  const cases = [
    {
      name: 'missing text',
      kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'picker', 'row', 'overlay'],
      features: ['flow', 'styles', 'scroll'],
    },
    {
      name: 'missing scroll',
      kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'picker', 'row', 'overlay', 'text'],
      features: ['flow', 'styles'],
    },
  ] as const
  for (const entry of cases) {
    const pane = installTspPane({ kinds: entry.kinds, features: entry.features })
    let renderer: ReturnType<typeof mountTspRenderer> | undefined
    try {
      const session = await connect({ timeout: 500, exitHooks: false })
      assert.ok(session)
      renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit() {}, onFatal: (error) => assert.fail(String(error)) })
      assert.equal(renderer.sessionBrowserPresentation, undefined, entry.name)
      assert.equal(pane.frames().flatMap((frame) => frame.ops).filter((op) => op[0] === 'scroll').length, 0)
    } finally {
      await renderer?.dispose()
      pane.restore()
    }
  }
})

test('native Session: a pane WITHOUT the kv kind still opens the complete text Details', async (t) => {
  // The degradation is a HANDSHAKE fact: this pane advertises exactly the base the
  // Browser entry already required (`picker`/`row`/`overlay`/`text`) plus the `scroll`
  // feature it requires, and NO `kv`. Details must still open with the ORIGINAL text
  // facts in the same order, Back must still return to the same query/selection, and
  // the missing display kind must not turn a read-only page into a write.
  const m = await mounted(t, reader({
    list: async () => [row('session-current', { live: true, preset: 'reviewer', parentSession: undefined })],
    projectionBatch: async (rows) => new Map(rows.map((entry) => [entry.id, { title: 'Current title', preset: 'reviewer' }])),
    search: async () => undefined,
  }), false, 'ready', {}, {
    kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'picker', 'row', 'overlay', 'text'],
    features: ['flow', 'styles', 'scroll'],
  })
  const { pane } = m
  assert.ok(m.renderer.sessionBrowserPresentation, 'the missing `kv` kind refuses no business entry')
  await waitUntil('the row is listed', () => items(pane).some((item) => item.id === 'session:session-current'))
  // Use the Footer keyboard route (Tab focuses the FIRST enabled action, Enter
  // activates it). Unlike a raw `action` event id, this carries no revision, so
  // the just-published Activity frame cannot invalidate it.
  pane.key('\t')
  await waitUntil('the Footer focuses Details', () =>
    ((pickerProps(pane, BROWSER).actions ?? []) as Array<{ readonly label?: unknown }>).some(action => String(action.label).includes('Details [Enter]')))
  pane.key('\r')
  await waitUntil('Details opens', () => details(pane) !== undefined)
  assert.equal(kvNodes(pane).length, 0, 'not one `kv` node reached a pane that cannot draw one')
  assert.equal(detailGroups(pane).size, 0, 'and no grid is read as the fact source')
  const runs = detailTextRuns(pane)
  // Every original fact, in the original order, complete — the pre-`kv` shape.
  for (const fact of [
    'Identity', 'Session ID', 'session-current', 'Title', 'Current title',
    'State', 'Current session', 'Workspace', '/workspace/project',
    'Activity', 'Created', new Date(10).toISOString(), 'Updated', new Date(100).toISOString(),
    'Lineage', 'Parent session', 'No parent session',
    'Configuration', 'Agent preset', 'reviewer',
  ]) {
    assert.ok(runs.includes(fact), `the degraded Details still carries ${JSON.stringify(fact)}: ${JSON.stringify(runs)}`)
  }
  assert.ok(runs.indexOf('Session ID') < runs.indexOf('Created'), 'the groups stay in their reading order')
  const before = scrollOps(pane).length
  pane.key('\u001b[B')
  await waitUntil('the degraded Reader still scrolls its own body', () => scrollOps(pane).length === before + 1)
  assert.deepEqual(scrollOps(pane).at(-1), { id: detailBody(pane)!.id, to: 'line-down' })
  pane.key('\u001b')
  await waitUntil('Esc returns from the degraded Details', () => details(pane) === undefined && picker(pane) !== undefined)
  assert.equal(m.resumeIntents.length, 0, 'a degraded Reader is still read-only')
})

test('native Session: a KV re-render and a resize never remount the Reader body', async (t) => {
  // The Reader's scroll target is the body node the frame REALLY drew, addressed by
  // the id the SDK assigned it. The grid keys identify a GROUP within one reading, so
  // a repaint (a re-read, or a resize at 1280 -> 400 -> 900) must keep the SAME body
  // id and must not delete/re-add the scroll container out from under the scroll op.
  const m = await mounted(t)
  const { pane } = m
  await waitUntil('the rows are listed', () => items(pane).length > 0)
  sendSelect(pane, 'session:session-other', picker(pane)!.id)
  await waitUntil('the row is selected', () => props(pane).selected === 'session:session-other')
  // Use the Footer keyboard route (Tab focuses the FIRST enabled action, Enter
  // activates it). Unlike a raw `action` event id, this carries no revision, so
  // the just-published Activity frame cannot invalidate it.
  pane.key('\t')
  await waitUntil('the Footer focuses Details', () =>
    ((pickerProps(pane, BROWSER).actions ?? []) as Array<{ readonly label?: unknown }>).some(action => String(action.label).includes('Details [Enter]')))
  pane.key('\r')
  await waitUntil('Details opens', () => details(pane) !== undefined)
  assert.equal(kvNodes(pane).length, 4, 'each of the four fact groups is one grid')
  const bodyId = detailBody(pane)!.id
  const gridIds = kvNodes(pane).map((node) => node.id)
  const factsBefore = detailGroups(pane)
  for (const cols of [160, 50, 112]) {
    sendResize(pane, cols)
    await waitUntil(`the Details survive the resize to ${cols} columns`, () => details(pane) !== undefined)
    assert.equal(detailBody(pane)!.id, bodyId, `the body keeps its drawn id at ${cols} columns`)
    assert.deepEqual(detailGroups(pane), factsBefore, `every grid fact is unchanged at ${cols} columns`)
    assert.deepEqual(kvNodes(pane).map((node) => node.id), gridIds, `the grids keep their ids at ${cols} columns`)
  }
  const before = scrollOps(pane).length
  pane.key('\u001b[B')
  await waitUntil('the scroll still addresses the drawn body', () => scrollOps(pane).length === before + 1)
  assert.deepEqual(scrollOps(pane).at(-1), { id: bodyId, to: 'line-down' }, 'scroll names the id the client received')
  // A re-read of the SAME row is a NEW reading: it must take a new body identity, so an
  // op queued by the previous reading can never address this one.
  pane.key('\u001b')
  await waitUntil('Esc returns to the browse page', () => details(pane) === undefined && picker(pane) !== undefined)
  sendPickerAction(pane, 'details', BROWSER)
  await waitUntil('the second reading opens', () => details(pane) !== undefined)
  assert.notEqual(detailBody(pane)!.id, bodyId, 'a new reading gets its own scroll body')
  assert.deepEqual(detailGroups(pane), factsBefore, 'and it reads the same facts again')
  assert.equal(m.resumeIntents.length, 0, 'nothing on this page wrote or resumed')
})
