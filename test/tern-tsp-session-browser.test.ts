/** Production TSP Session Browser, observed through the SDK's reconciled pane wire. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, type PickerGroup } from '@stencil-hq/tern'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import { createSessionBrowserReadOwner } from '../src/app/command/session-browser-read.ts'
import type { SessionContentSearchPage, SessionProjectionSummary, SessionReader, SessionSummary } from '../src/runtime/session-reader-port.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { formatSessionAge } from '../src/tui/pickers/sessions.ts'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'
import { waitUntil } from './support/tsp-runner-harness.ts'
import type { SessionScope } from '../src/app/session/scope.ts'
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
  sendSelect,
  type WireNode,
} from './support/tsp-picker-wire.ts'

const BROWSER = 'session-browser-'
const props = (pane: TspPane): Record<string, unknown> => pickerProps(pane, BROWSER)
const picker = (pane: TspPane): WireNode | undefined => pickerNode(pane, BROWSER)
const items = (pane: TspPane): Array<Record<string, unknown>> => (props(pane).items ?? []) as Array<Record<string, unknown>>
const order = (pane: TspPane): Array<string | PickerGroup> => props(pane).order as Array<string | PickerGroup>
const details = (pane: TspPane): WireNode | undefined => layerNodes(pane, BROWSER).find((node) => node.k === 'overlay')
const detailBody = (pane: TspPane): WireNode | undefined => layerNodes(pane, BROWSER)
  .find((node) => node.k === 'col' && node.id.includes('session-browser-details-body-'))
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
}), waitForProjection = true, expectedState: 'ready' | 'loading' | 'error' = 'ready') {
  const pane = installTspPane({ sessionBrowser: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  const fatals: unknown[] = []
  const renderer = mountTspRenderer(session, {
    requestExit() {},
    onFatal: (error) => { fatals.push(error) },
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => assert.fail('the read-only Browser must capture Enter'),
    steer() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
  })
  const browserPresentation = renderer.sessionBrowserPresentation
  assert.ok(browserPresentation, 'the pane advertises picker, row, overlay, text and scroll')
  const diag = createDiag({ stderrLevel: 'off' })
  t.after(() => diag.dispose())
  const resumeIntents: Array<{ sessionId: string; currentSessionId: string | undefined; source: string }> = []
  const resumeSettlements: Array<() => void> = []
  let current = true
  const owner = createSessionBrowserReadOwner({
    reader: read,
    presentation: browserPresentation,
    captureSubject: () => ({
      subject: {
        currentSessionId: 'session-current',
        currentCwd: '/workspace/project',
        isCurrent: () => current,
      },
      scope: { sessionId: 'session-current' } as SessionScope,
    }),
    diag,
    sessionId: () => 'session-current',
    onResumeIntent: (intent, _scope, settle) => { resumeIntents.push(intent); resumeSettlements.push(settle) },
  })
  t.after(() => owner.dispose())
  const readHandle = owner.open()
  await waitUntil(`the Session Browser picker is ${expectedState}`, () => props(pane).state === expectedState)
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
    moveSubject: () => { current = false },
  }
}

test('native Browser is one workspace tree, then a global cards union with Host-owned excerpts', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const initial = props(pane)
  assert.equal(initial.layout, 'tree')
  assert.equal(initial.size, 'lg')
  assert.equal(initial.scope, 'workspace')
  assert.deepEqual(initial.current, ['session:session-current'])
  assert.equal(initial.selected, 'session:session-current')
  assert.deepEqual((initial.scopes as Array<Record<string, unknown>>).map((scope) => scope.count), [3, 7])
  assert.deepEqual(items(pane).map((entry) => entry.id), [
    'session:session-current', 'session:session-other', 'session:session-cross-child',
  ])
  assert.deepEqual(items(pane).map((entry) => entry.depth), [0, 1, 0])
  assert.deepEqual(order(pane), [
    { group: 'workspace-run:0', label: 'workspace/project', count: 3 },
    'session:session-current',
    'session:session-other',
    'session:session-cross-child',
  ])
  assert.equal(items(pane)[0]?.label, 'Needle current title', 'terminal sequences are removed from projected titles')

  const pickerId = picker(pane)!.id
  const surfaceId = pane.frames().at(-1)!.sf
  const currentResume = pickerActionByBase(pane, 'resume', BROWSER)
  assert.equal(currentResume?.disabled, 'The current session is already active.')
  sendPickerAction(pane, 'resume', BROWSER)
  sendActivate(pane, 'session:session-current', pickerId)
  assert.equal(m.resumeIntents.length, 0, 'Current cannot emit a Footer or row-activation Resume intent')
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
  m.resumeSettlements[0]!()
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

test('footer keyboard focus visits only enabled actions', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const actionLabels = (): string[] => (props(pane).actions as Array<Record<string, unknown>>)
    .map((action) => String(action.label))

  pane.key('\t')
  await waitUntil('the first Tab enters workspace scopes', () => props(pane).focus === 'scopes')
  pane.key('\t')
  await waitUntil('Details receives the initial enabled footer focus', () => actionLabels().includes('Details [Enter]'))
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
  await waitUntil('the first Tab enters workspace scopes', () => props(pane).focus === 'scopes')
  pane.key('\t')
  await waitUntil('empty footer focuses enabled Close, not disabled Details', () => actionLabels().includes('Close [Enter]'))
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
  assert.equal(items(pane).length, 28, 'workspace scope filters membership without mutating the source rows')
  sendAction(pane, 'scope', 'all', picker(pane)!.id)
  await waitUntil('55-row all-workspaces tree', () => props(pane).scope === 'all' && items(pane).length === 55)
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

test('All workspaces groups contiguous workspace runs without changing lineage, orphans, and cycle members', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  sendAction(pane, 'scope', 'all', picker(pane)!.id)
  await waitUntil('all-workspaces scope', () => props(pane).scope === 'all')
  assert.deepEqual(items(pane).map((entry) => entry.id), [
    'session:session-current',
    'session:session-other',
    'session:session-content',
    'session:session-cross-child',
    'session:session-orphan',
    'session:session-cycle-a',
    'session:session-cycle-b',
  ])
  assert.deepEqual(items(pane).map((entry) => entry.depth), [0, 1, 2, 3, 0, 0, 1])
  const allOrder = order(pane)
  const groups = allOrder.filter((entry): entry is PickerGroup => typeof entry !== 'string')
  assert.deepEqual(allOrder, [
    { group: 'workspace-run:0', label: 'workspace/project', count: 2 },
    'session:session-current',
    'session:session-other',
    { group: 'workspace-run:1', label: 'workspace/other', count: 1 },
    'session:session-content',
    { group: 'workspace-run:2', label: 'workspace/project', count: 1 },
    'session:session-cross-child',
    { group: 'workspace-run:3', label: 'workspace/other', count: 3 },
    'session:session-orphan',
    'session:session-cycle-a',
    'session:session-cycle-b',
  ])
  assert.equal(new Set(groups.map((group) => group.group)).size, groups.length, 'repeated workspace labels still have unique run identities')
  assert.deepEqual(groups.map((group) => group.count), [2, 1, 1, 3], 'every listed row belongs to exactly one contiguous workspace run')
})

test('Details preserves search state, scrolls its own body, and emits read-only Resume intents', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  sendAction(pane, 'scope', 'all', picker(pane)!.id)
  await waitUntil('all-workspaces scope', () => props(pane).scope === 'all')
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
  assert.match(firstDetails, /session-content/u)
  assert.match(firstDetails, /Unrelated title/u)
  assert.match(firstDetails, /Host content excerpt/u)
  assert.ok(firstDetails.includes(`Created | ${new Date(10).toISOString()}`), firstDetails)
  assert.ok(firstDetails.includes(`Updated | ${new Date(100).toISOString()}`), firstDetails)
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
  assert.equal(props(pane).scope, undefined, 'global search hides the browse-only scope control')
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
  assert.equal(props(pane).scope, undefined)
  assert.equal(props(pane).selected, 'session:session-content')
  pane.key('\u001b')
  await waitUntil('clearing search restores the all-workspaces browse scope', () => props(pane).layout === 'tree' && props(pane).scope === 'all')
  assert.equal(props(pane).selected, 'session:session-current', 'clearing search restores the pre-search selection')
  sendSelect(pane, 'session:session-current', picker(pane)!.id)
  await waitUntil('Current is independently selected', () => props(pane).selected === 'session:session-current')
  pane.key('\r')
  sendSelect(pane, 'session:session-content', picker(pane)!.id)
  await waitUntil('later selection processes after Current Enter', () => props(pane).selected === 'session:session-content')
  assert.equal(m.resumeIntents.length, 0, 'the current Session cannot be resumed')
  sendActivate(pane, 'session:session-content', picker(pane)!.id)
  await waitUntil('activation emits only a Resume intent', () => m.resumeIntents.length === 1)
  assert.deepEqual(m.resumeIntents[0], {
    sessionId: 'session-content',
    currentSessionId: 'session-current',
    source: 'activate',
  })
  m.resumeSettlements[0]!()
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

test('Details reports Unknown rather than inferring an absent createdAt', async (t) => {
  const m = await mounted(t, reader({
    list: async () => [row('session-current', { createdAt: undefined, updatedAt: 3_000, live: true })],
    projectionBatch: async () => new Map(),
  }), false)
  const { pane } = m
  await waitUntil('current row without createdAt is listed', () => items(pane).some((item) => item.id === 'session:session-current'))
  sendPickerAction(pane, 'details', BROWSER)
  await waitUntil('Details opens for row without createdAt', () => details(pane) !== undefined)
  const text = sheetText(pane, BROWSER)
  assert.ok(text.includes('Created | Unknown'), text)
  assert.ok(text.includes(`Updated | ${new Date(3_000).toISOString()}`), text)
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
      renderer = mountTspRenderer(session, { requestExit() {}, onFatal: (error) => assert.fail(String(error)) })
      assert.equal(renderer.sessionBrowserPresentation, undefined, entry.name)
      assert.equal(pane.frames().flatMap((frame) => frame.ops).filter((op) => op[0] === 'scroll').length, 0)
    } finally {
      await renderer?.dispose()
      pane.restore()
    }
  }
})
