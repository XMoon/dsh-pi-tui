/**
 * Standalone, synthetic TSP Session Browser demo. This entry has no SessionReader,
 * Host, DSH Agent or production session-transition imports: Resume only records a
 * local `wouldResume` event. Run it from a Tern-owned terminal pane.
 *
 *   node --import tsx/esm scripts/tern-session-browser-demo.mts
 */
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { View, connect, ui, type Key, type PickerAction, type PickerGroup, type PickerItem, type PickerProps, type Session, type Surface, type TspEvent } from '@stencil-hq/tern'

interface SessionSummary {
  readonly id: string
  readonly updatedAt: number
  readonly createdAt?: number
  readonly cwd?: string
  readonly preset?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
  readonly live: boolean
}

const WORKSPACE = '/demo/app/backend/研发团队🚀/service-with-a-deliberately-long-synthetic-name'
const WORKSPACES = [WORKSPACE, '/demo/infra/tools', '/demo/docs/research', '/demo/ops/observability', '/demo/client/mobile']
const PRESETS = ['standard', 'ptc', 'minimal'] as const
const now = Date.parse('2026-10-15T12:00:00Z')
const LONG_ID = `session-long-${'Abc123xyz'.repeat(20)}`
const LONG_TITLE = '超长标题🚀'.repeat(34)
const generatedSessions: readonly SessionSummary[] = Array.from({ length: 44 }, (_, index): SessionSummary => ({
  id: `session-synth-${String(index + 1).padStart(3, '0')}`,
  updatedAt: now - (index + 3) * 2_400_000,
  createdAt: now - (14 + index % 30) * 86_400_000,
  cwd: WORKSPACES[index % WORKSPACES.length]!,
  preset: PRESETS[index % PRESETS.length]!,
  live: false,
}))
const sessions: readonly SessionSummary[] = [
  { id: 'session-current-a0000001', updatedAt: now - 2 * 60_000, createdAt: now - 2 * 86_400_000, cwd: WORKSPACE, preset: 'standard', live: true },
  { id: 'session-fork-b0000002', updatedAt: now - 15 * 60_000, createdAt: now - 3 * 86_400_000, cwd: WORKSPACE, preset: 'standard', parentSession: 'session-current-a0000001', live: false },
  { id: 'session-rewind-c0000003', updatedAt: now - 10 * 60_000, createdAt: now - 3 * 86_400_000, cwd: WORKSPACE, preset: 'ptc', parentSession: 'session-fork-b0000002', live: false },
  { id: 'session-persist-d0000004', updatedAt: now - 3 * 3_600_000, createdAt: now - 7 * 86_400_000, cwd: WORKSPACE, preset: 'minimal', live: false },
  { id: 'session-linux-e0000005', updatedAt: now - 24 * 3_600_000, createdAt: now - 12 * 86_400_000, cwd: '/demo/infra/tools', preset: 'standard', live: false },
  { id: 'session-title-f0000006', updatedAt: now - 5 * 3_600_000, createdAt: now - 8 * 86_400_000, cwd: '/demo/infra/tools', preset: 'ptc', live: false },
  { id: 'session-content-g0000007', updatedAt: now - 6 * 3_600_000, createdAt: now - 9 * 86_400_000, cwd: '/demo/docs/research', preset: 'standard', live: false },
  { id: 'session-both-h0000008', updatedAt: now - 7 * 3_600_000, createdAt: now - 10 * 86_400_000, cwd: '/demo/docs/research', preset: 'minimal', live: false },
  { id: 'session-orphan-i0000009', updatedAt: now - 2 * 86_400_000, createdAt: now - 15 * 86_400_000, cwd: WORKSPACE, preset: 'standard', parentSession: 'session-missing-zzzz', live: false },
  { id: 'session-cycle-j0000010', updatedAt: now - 3 * 86_400_000, createdAt: now - 20 * 86_400_000, cwd: WORKSPACE, preset: 'ptc', parentSession: 'session-cycle-j0000010', live: false },
  { id: LONG_ID, updatedAt: now - 9 * 3_600_000, createdAt: now - 30 * 86_400_000, cwd: WORKSPACE, preset: 'standard', live: false },
  ...generatedSessions,
  { id: 'session-subagent-k0000011', updatedAt: now - 4 * 60_000, cwd: WORKSPACE, preset: 'standard', origin: 'subagent', live: false },
  { id: 'session-subagent-l0000012', updatedAt: now - 8 * 60_000, cwd: '/demo/infra/tools', preset: 'ptc', origin: 'subagent', live: false },
]

// Titles and bounded excerpts are deliberately separate from SessionSummary.
const titles = new Map<string, string>([
  ['session-current-a0000001', 'Fix API timeout'],
  ['session-fork-b0000002', 'Review API retry strategy'],
  ['session-rewind-c0000003', 'Follow-up: retry budget and backoff'],
  ['session-persist-d0000004', 'Persist session'],
  ['session-linux-e0000005', 'Investigate Linux IO stalls'],
  ['session-title-f0000006', 'Connection timeout in worker pool'],
  ['session-content-g0000007', 'Notes from the nightly run'],
  ['session-both-h0000008', 'Connection timeout: client retry'],
  ['session-orphan-i0000009', 'Detached branch with missing parent'],
  ['session-cycle-j0000010', 'Synthetic self-cycle control'],
  ['session-subagent-k0000011', 'Subagent: inspect tests'],
  ['session-subagent-l0000012', 'Subagent: inspect docs'],
])
for (const [index, session] of generatedSessions.entries()) titles.set(session.id, `Synthetic session ${String(index + 1).padStart(2, '0')}`)
titles.set(LONG_ID, LONG_TITLE)
const longParagraph = '重试预算与退避路径 🚀 · 这是只读合成内容，用来验证长文本滚动到底。'.repeat(14)
const longDetailExcerpt = `Host-mock long excerpt: ${longParagraph} EXCERPT-END-🚩`
const longIdExcerpt = `Host-mock long excerpt: session-long- ${longParagraph} EXCERPT-END-🚩`
const content = new Map<string, string>([
  ['session-current-a0000001', 'Retry after connection timeout; request id DEMO-101.'],
  ['session-fork-b0000002', longDetailExcerpt],
  ['session-title-f0000006', 'The worker pool exited cleanly after the final connection attempt.'],
  ['session-content-g0000007', 'worker log · connection timeout observed in a synthetic Host excerpt.'],
  ['session-both-h0000008', 'Host-mock excerpt: connection timeout observed before the second retry.'],
  [LONG_ID, longIdExcerpt],
])
for (const [index, session] of generatedSessions.slice(0, 12).entries()) {
  content.set(session.id, `Synthetic Host excerpt: demo pagination match ${index + 1}.`)
}

const CURRENT_ID = 'session-current-a0000001'
const eventPath = process.env.TERN_PANE_DIR === undefined
  ? join(tmpdir(), `tern-session-browser-demo-${process.pid}.jsonl`)
  : join(process.env.TERN_PANE_DIR, 'events.jsonl')
const note = (value: unknown): void => appendFileSync(eventPath, `${JSON.stringify(value)}\n`)
const shortId = (id: string): string => id.replace(/^session-/, '').slice(0, 8)
const workspaceLabel = (cwd: string | undefined): string => cwd?.split('/').slice(-2).join('/') ?? '(no workspace)'

type Page = 'browser' | 'details'
type Scope = 'workspace' | 'all'
type Zone = 'list' | 'scopes' | 'actions'
type Scenario = 'normal' | 'loading' | 'error' | 'empty' | 'search-unavailable' | 'has-more'
type SearchHit = { readonly session: SessionSummary; readonly source: 'Content' | 'Metadata' | 'Both'; readonly snippet?: string }

const SCENARIOS: readonly Scenario[] = ['normal', 'loading', 'error', 'empty', 'search-unavailable', 'has-more']
const sessionById = new Map(sessions.map((session) => [session.id, session]))
let scenario: Scenario = 'normal'
let page: Page = 'browser'
let scope: Scope = 'workspace'
let scopeBeforeSearch: Scope | undefined
let selectionBeforeSearch: string | undefined
let query = ''
let selectedId = 'session-fork-b0000002'
let phase: 'loading' | 'ready' | 'error' = 'loading'
let metadataReady = false
let zone: Zone = 'list'
let actionCursor = 2
let resumeNoticeId: string | undefined
let readerId: string | undefined
let pickerId: string | undefined
let renderedNodeIds = new Set<string>()
let scrollSupported = false
let readerEpoch = 0
let revision = 0
let done = false
let repaint!: () => void

const allMainSessions = (): SessionSummary[] => sessions.filter((session) => session.origin !== 'subagent')
function browseRows(): SessionSummary[] {
  if (phase !== 'ready' || scenario === 'empty') return []
  const rows = allMainSessions()
    .filter((session) => scope === 'all' || session.cwd === WORKSPACE)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const childrenByParent = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const row of rows) {
    const parentId = row.parentSession
    if (parentId === undefined || parentId === row.id || !byId.has(parentId)) {
      roots.push(row)
      continue
    }
    const children = childrenByParent.get(parentId) ?? []
    children.push(row)
    childrenByParent.set(parentId, children)
  }
  const ordered: SessionSummary[] = []
  const visited = new Set<string>()
  const appendTree = (row: SessionSummary): void => {
    if (visited.has(row.id)) return
    visited.add(row.id)
    ordered.push(row)
    for (const child of childrenByParent.get(row.id) ?? []) appendTree(child)
  }
  for (const root of roots) appendTree(root)
  for (const row of rows) appendTree(row)
  const workspaces = [...new Set(ordered.map((row) => row.cwd ?? ''))]
  return workspaces.flatMap((cwd) => ordered.filter((row) => (row.cwd ?? '') === cwd))
}

function searchRows(text: string): SearchHit[] {
  if (phase !== 'ready' || scenario === 'empty') return []
  const needle = text.toLocaleLowerCase()
  const sourceOrder: Record<SearchHit['source'], number> = { Content: 0, Metadata: 1, Both: 2 }
  const hits = allMainSessions()
    .map((session): SearchHit | undefined => {
      const title = metadataReady ? titles.get(session.id) : undefined
      const snippet = content.get(session.id)
      const metadataMatch = [session.id, title, session.cwd, session.preset].some((value) => value?.toLocaleLowerCase().includes(needle) === true)
      const contentMatch = scenario !== 'search-unavailable' && snippet?.toLocaleLowerCase().includes(needle) === true
      if (!metadataMatch && !contentMatch) return undefined
      return { session, source: metadataMatch && contentMatch ? 'Both' : contentMatch ? 'Content' : 'Metadata', ...(contentMatch ? { snippet } : {}) }
    })
    .filter((hit): hit is SearchHit => hit !== undefined)
    .sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || b.session.updatedAt - a.session.updatedAt)
  return scenario === 'has-more' && needle === 'pagination' ? hits.slice(0, 4) : hits
}

function visibleRows(): SessionSummary[] {
  return query === '' ? browseRows() : searchRows(query).map((hit) => hit.session)
}

function rowDepth(row: SessionSummary, visible: readonly SessionSummary[]): number {
  const byId = new Map(visible.map((item) => [item.id, item]))
  const seen = new Set([row.id])
  let parentId = row.parentSession
  let depth = 0
  while (parentId !== undefined && byId.has(parentId)) {
    if (seen.has(parentId)) return 0
    seen.add(parentId)
    depth += 1
    parentId = byId.get(parentId)?.parentSession
  }
  return depth
}

function browsePickerItems(rows: readonly SessionSummary[]): PickerItem[] {
  return rows.map((row) => {
    const fullTitle = metadataReady ? titles.get(row.id) : undefined
    const badges: NonNullable<PickerItem['badges']>[number][] = []
    if (row.id === CURRENT_ID) badges.push({ text: 'Current', tone: 'success', title: 'The current demo session; it will never be resumed by this demo.' })
    if (row.id === resumeNoticeId) badges.push({ text: 'Would resume', tone: 'success', title: 'Demo-only simulation; Current remains unchanged.' })
    if (row.parentSession !== undefined) badges.push({ text: row.parentSession === row.id ? 'Cycle · root' : sessionById.has(row.parentSession) ? 'Fork' : 'Orphan · root', tone: 'muted' })
    return {
      id: row.id,
      label: fullTitle ?? shortId(row.id),
      detail: metadataReady ? `${workspaceLabel(row.cwd)} · ${row.preset ?? 'Unknown preset'} · ${shortId(row.id)}` : `${workspaceLabel(row.cwd)} · ${shortId(row.id)}`,
      title: row.id,
      depth: rowDepth(row, rows),
      badges,
    }
  })
}

function searchPickerItems(hits: readonly SearchHit[]): PickerItem[] {
  return hits.map(({ session, source, snippet }) => ({
    id: session.id,
    label: metadataReady ? titles.get(session.id) ?? shortId(session.id) : shortId(session.id),
    detail: snippet === undefined
      ? `${workspaceLabel(session.cwd)} · ${session.preset ?? 'Unknown preset'} · ${shortId(session.id)}`
      : `${workspaceLabel(session.cwd)} · ${snippet}`,
    title: session.id,
    badges: [{ text: source, tone: source === 'Content' ? 'info' : 'muted', title: 'Search source in synthetic demo data' }],
  }))
}

function browseOrder(rows: readonly SessionSummary[]): (string | PickerGroup)[] {
  const workspaces = [...new Set(rows.map((row) => row.cwd ?? ''))]
  return workspaces.flatMap((cwd) => {
    const groupRows = rows.filter((row) => (row.cwd ?? '') === cwd)
    return [
      { group: `workspace:${cwd}`, label: workspaceLabel(cwd), count: groupRows.length },
      ...groupRows.map((row) => row.id),
    ]
  })
}

function searchOrder(hits: readonly SearchHit[]): (string | PickerGroup)[] {
  const sources: SearchHit['source'][] = ['Content', 'Metadata', 'Both']
  return sources.flatMap((source) => {
    const groupHits = hits.filter((hit) => hit.source === source)
    if (groupHits.length === 0) return []
    const label = scenario === 'search-unavailable'
      ? 'Global · Content unavailable'
      : scenario === 'has-more' && query.toLocaleLowerCase() === 'pagination' && source === 'Content'
        ? 'Global · More matches · refine'
        : `Global · ${source} matches`
    return [
      { group: `search:${source}`, label, count: groupHits.length },
      ...groupHits.map((hit) => hit.session.id),
    ]
  })
}

function actionIds(token: number): readonly string[] {
  return ['close', 'details', 'resume'].map((base) => `${base}#${token}`)
}

function actionItems(token: number, rows: readonly SessionSummary[]): PickerAction[] {
  const selected = rows.find((row) => row.id === selectedId)
  const action = actionIds(token)
  const detailsDisabled = phase === 'loading'
    ? 'Sessions are loading'
    : phase === 'error'
      ? 'Session details are unavailable'
      : selected === undefined
        ? query === '' ? 'Select a session first' : 'No matching session'
        : !scrollSupported
          ? 'This Tern client did not negotiate scroll'
          : undefined
  const resumeDisabled = phase === 'loading'
    ? 'Sessions are loading'
    : phase === 'error'
      ? 'Session listing failed'
      : selected === undefined
        ? query === '' ? 'Select a session first' : 'No matching session'
        : selected.id === CURRENT_ID ? 'Already current' : undefined
  return [
    { id: action[0]!, label: zone === 'actions' && actionCursor === 0 ? 'Close [Enter]' : 'Close', keys: ['Esc'] },
    {
      id: action[1]!,
      label: zone === 'actions' && actionCursor === 1 && detailsDisabled === undefined ? 'Details [Enter]' : 'Details',
      keys: ['Enter'],
      disabled: detailsDisabled,
    },
    {
      id: action[2]!,
      label: zone === 'actions' && actionCursor === 2 && resumeDisabled === undefined ? 'Resume [Enter]' : 'Resume',
      keys: ['Enter'],
      primary: true,
      disabled: resumeDisabled,
    },
  ]
}

function detailLayer(row: SessionSummary) {
  const title = metadataReady ? titles.get(row.id) ?? shortId(row.id) : shortId(row.id)
  const excerpt = query === '' ? undefined : searchRows(query).find((hit) => hit.session.id === row.id)?.snippet
  const bodyKey = `session-browser-reader-body-${readerEpoch}`
  return ui.col(
    { key: 'session-browser-layer' },
    ui.overlay(
      { key: `session-browser-reader-${readerEpoch}`, head: title, size: 'lg', modal: true },
      ui.row(
        { key: `session-browser-back-${readerEpoch}`, onClick: () => { backToBrowser() } },
        ui.text('← Back to sessions · Esc'),
      ),
      ui.col(
        { key: bodyKey, gap: 'sm' },
        ui.text({ wrap: 'char' }, 'DEMO ONLY · Read-only details · No real session will be switched'),
        ui.text({ wrap: 'char' }, `Title\n${title}`),
        ui.text({ wrap: 'char' }, `Session ID\n${row.id}`),
        ui.text({ wrap: 'char' }, `Workspace\n${row.cwd ?? 'Unknown'}`),
        ui.text({ wrap: 'char' }, `Updated\n${new Date(row.updatedAt).toISOString()}`),
        ui.text({ wrap: 'char' }, `Created\n${row.createdAt === undefined ? 'Unknown' : new Date(row.createdAt).toISOString()}`),
        ui.text({ wrap: 'char' }, `Preset\n${metadataReady ? row.preset ?? 'Unknown' : 'Loading…'}`),
        ui.text({ wrap: 'char' }, `Parent session\n${row.parentSession ?? 'None'}`),
        ui.text({ wrap: 'char' }, `Origin\n${row.origin ?? 'main session'}`),
        ui.text({ wrap: 'char' }, `Status\n${row.id === CURRENT_ID ? 'Current demo session' : 'Demo session · not live'}`),
        ...(excerpt === undefined ? [] : [ui.text({ wrap: 'char' }, `Search excerpt (synthetic Host mock)\n${excerpt}`)]),
        ui.text({ wrap: 'char' }, `Read-only identity confirmation\n${row.id} · ${title} · ${row.cwd ?? 'Unknown'} · ${row.preset ?? 'Unknown'}`),
      ),
    ),
  )
}

function browserLayer(keyRevision: number, surface: Surface, session: Session) {
  const rows = visibleRows()
  const hits = query === '' ? [] : searchRows(query)
  const items = query === '' ? browsePickerItems(rows) : searchPickerItems(hits)
  const hasMore = scenario === 'has-more' && query.toLocaleLowerCase() === 'pagination'
  const total = hasMore ? 12 : items.length
  const scopeValue: Scope = query === '' ? scope : 'all'
  const scopes = (query === ''
    ? [
        { id: 'workspace', label: 'This workspace', count: phase === 'ready' ? browseRowsFor('workspace').length : undefined },
        { id: 'all', label: 'All workspaces', count: phase === 'ready' ? allMainSessions().length : undefined },
      ]
    : []) satisfies NonNullable<PickerProps['scopes']>
  const actions = actionItems(keyRevision, rows)
  const unavailableNoMatch = scenario === 'search-unavailable' && query !== '' && hits.length === 0
  const message = phase === 'loading' ? 'Loading synthetic sessions…'
    : phase === 'error' ? 'Synthetic roster unavailable · no real session access'
      : unavailableNoMatch ? 'No metadata matches; content search unavailable.' : undefined
  return ui.col(
    { key: 'session-browser-layer' },
    ui.picker({
      key: 'session-browser-picker',
      title: 'DEMO ONLY',
      subtitle: query === ''
        ? `${scope === 'workspace' ? 'This workspace' : 'All workspaces'} · Current ${shortId(CURRENT_ID)} · Selected ${shortId(selectedId)}`
        : `${hits.length} synthetic matches · All workspaces`,
      layout: query === '' ? 'tree' : 'cards',
      size: 'lg',
      preview: 'none',
      query,
      cursor: query.length,
      placeholder: 'Search sessions and messages…',
      noun: 'sessions',
      focus: zone === 'scopes' ? 'scopes' : zone === 'actions' ? undefined : 'list',
      state: unavailableNoMatch ? 'error' : phase,
      message,
      empty: scenario === 'empty' ? 'No synthetic sessions in this scenario.' : query === '' ? 'No sessions are available in this scope.' : 'No sessions match this search.',
      total,
      items,
      order: query === '' ? browseOrder(rows) : searchOrder(hits),
      selected: rows.some((row) => row.id === selectedId) ? selectedId : undefined,
      current: [CURRENT_ID],
      scopes,
      scope: scopeValue,
      actions,
      onSelect: (event) => onPickerEvent(event, keyRevision, surface, session),
      onActivate: (event) => onPickerEvent(event, keyRevision, surface, session),
      onAction: {
        [actions[0]!.id]: (event) => onPickerEvent(event, keyRevision, surface, session),
        [actions[1]!.id]: (event) => onPickerEvent(event, keyRevision, surface, session),
        [actions[2]!.id]: (event) => onPickerEvent(event, keyRevision, surface, session),
      },
    }),
  )
}

function browseRowsFor(which: Scope): SessionSummary[] {
  return allMainSessions().filter((session) => which === 'all' || session.cwd === WORKSPACE)
}

async function onPickerEvent(event: TspEvent, frameRevision: number, surface: Surface, session: Session): Promise<void> {
  if (event.ev !== 'select' && event.ev !== 'activate' && event.ev !== 'action') return
  note({ event: { ev: event.ev, sf: event.sf, id: event.id, item: 'item' in event ? event.item : undefined, act: 'act' in event ? event.act : undefined, value: 'value' in event ? event.value : undefined } })
  if (event.sf !== surface.id) {
    note({ rejected: 'foreign-surface', sf: event.sf, expected: surface.id })
    return
  }
  if (!renderedNodeIds.has(event.id)) {
    note({ rejected: 'stale-or-unknown-node', id: event.id })
    return
  }
  if (page !== 'browser' || frameRevision !== revision) {
    note({ rejected: 'stale-or-wrong-page', event: event.ev, frameRevision, currentRevision: revision })
    return
  }
  if ((event.ev === 'select' || event.ev === 'activate') && event.item !== undefined) {
    if (event.item === 'workspace' || event.item === 'all') {
      setScope(event.item)
      return
    }
    const row = visibleRows().find((candidate) => candidate.id === event.item)
    if (row === undefined) {
      note({ rejected: 'not-a-visible-session', item: event.item })
      return
    }
    selectedId = row.id
    resumeNoticeId = undefined
    zone = 'list'
    actionCursor = 2
    if (event.ev === 'activate') simulateResume(row.id, 'row-activate')
    else repaint()
    return
  }
  if (event.ev !== 'action') return
  const match = /^(close|details|resume)#(\d+)$/u.exec(event.act)
  const offered = actionItems(frameRevision, visibleRows()).find((action) => action.id === event.act)
  if (match === null || Number(match[2]) !== frameRevision || frameRevision !== revision || offered === undefined || offered.disabled !== undefined) {
    note({ rejected: 'stale-disabled-or-unoffered-action', act: event.act })
    return
  }
  await performAction(match[1] as 'close' | 'details' | 'resume', 'footer-action', surface, session)
}

async function performAction(action: 'close' | 'details' | 'resume', source: 'footer-action' | 'footer-keyboard', surface: Surface, session: Session): Promise<void> {
  if (action === 'close') {
    done = true
    await surface.close({ keep: false })
    await session.close()
    return
  }
  if (action === 'details') {
    openDetails()
    return
  }
  simulateResume(selectedId, source)
}

function routeUnhandledEvent(event: TspEvent, surface: Surface): void {
  if (event.ev !== 'action') return
  note({ event: { ev: event.ev, sf: event.sf, id: event.id, act: event.act, value: event.value } })
  if (event.sf !== surface.id) {
    note({ rejected: 'foreign-surface', sf: event.sf, expected: surface.id })
    return
  }
  if (event.id !== pickerId || !renderedNodeIds.has(event.id)) {
    note({ rejected: 'stale-or-unknown-picker', id: event.id, expected: pickerId ?? null })
    return
  }
  if (page !== 'browser') {
    note({ rejected: 'action-outside-browser', page })
    return
  }
  if (event.act !== 'scope' || query !== '' || (event.value !== 'workspace' && event.value !== 'all')) {
    note({ rejected: 'unoffered-unhandled-action', act: event.act, value: event.value ?? null })
    return
  }
  note({ admitted: 'scope-action', value: event.value, surface: event.sf, node: event.id, revision, frameRevisionAvailable: false })
  setScope(event.value)
}

function setScope(nextScope: Scope): void {
  if (query !== '') return
  scope = nextScope
  const rows = browseRows()
  if (!rows.some((row) => row.id === selectedId)) selectedId = rows[0]?.id ?? ''
  if (!rows.some((row) => row.id === resumeNoticeId)) resumeNoticeId = undefined
  zone = 'list'
  repaint()
}

function openDetails(): void {
  const row = visibleRows().find((candidate) => candidate.id === selectedId)
  if (row === undefined) return
  page = 'details'
  readerEpoch += 1
  resumeNoticeId = undefined
  zone = 'list'
  repaint()
}

function backToBrowser(): void {
  page = 'browser'
  readerId = undefined
  repaint()
}

function simulateResume(id: string | undefined, source: string): void {
  const row = id === undefined ? undefined : visibleRows().find((candidate) => candidate.id === id)
  if (page !== 'browser' || phase !== 'ready' || row === undefined || row.id === CURRENT_ID) {
    note({ rejected: 'would-resume', source, id: id ?? null, reason: row?.id === CURRENT_ID ? 'already-current' : 'not-offered' })
    repaint()
    return
  }
  note({ wouldResume: row.id, source, count: 1 })
  resumeNoticeId = row.id
  repaint()
}

function editedQuery(key: Key, current: string): string | undefined {
  if (key.ctrl || key.alt || key.meta) return undefined
  if (key.name === 'backspace') {
    const parts = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(current)]
    return parts.slice(0, -1).map((part) => part.segment).join('')
  }
  if (key.name === 'delete') return ''
  if (key.text === undefined) return undefined
  return current + key.text
}

function changeQuery(nextQuery: string): void {
  const wasEmpty = query === ''
  query = nextQuery
  if (wasEmpty && query !== '') {
    scopeBeforeSearch = scope
    selectionBeforeSearch = selectedId
    scope = 'all'
  }
  if (query === '') {
    scope = scopeBeforeSearch ?? scope
    scopeBeforeSearch = undefined
    selectedId = selectionBeforeSearch ?? selectedId
    selectionBeforeSearch = undefined
  } else if (!searchRows(query).some((hit) => hit.session.id === selectedId)) {
    selectedId = searchRows(query)[0]?.session.id ?? ''
  }
  resumeNoticeId = undefined
  zone = 'list'
  repaint()
}

async function handleKey(key: Key, surface: Surface, session: Session): Promise<void> {
  note({ key: { name: key.name, text: key.text, ctrl: key.ctrl, alt: key.alt, shift: key.shift } })
  if (key.name === 'f10') {
    done = true
    return
  }
  if (key.name === 'f1' && page === 'browser') {
    scenario = SCENARIOS[(SCENARIOS.indexOf(scenario) + 1) % SCENARIOS.length]!
    phase = scenario === 'loading' ? 'loading' : scenario === 'error' ? 'error' : 'ready'
    resumeNoticeId = undefined
    zone = 'list'
    actionCursor = 2
    const rows = visibleRows()
    if (!rows.some((row) => row.id === selectedId)) selectedId = rows[0]?.id ?? ''
    note({ control: 'scenario-cycle', scenario, phase, visibleRows: rows.length })
    repaint()
    return
  }
  if (key.name === 'f5' && page === 'browser') {
    metadataReady = !metadataReady
    note({ control: 'metadata-availability', available: metadataReady })
    repaint()
    return
  }
  if (key.name === 'f2' && page === 'browser') {
    note({ control: 'stale-action', revision, selectedId })
    const staleRevision = revision - 1
    await onPickerEvent({ ev: 'action', sf: surface.id, id: pickerId!, act: `resume#${staleRevision}`, raw: {} }, staleRevision, surface, session)
    return
  }
  if (key.name === 'f3' && page === 'browser') {
    note({ control: 'wrong-session-id', revision, selectedId })
    await onPickerEvent({ ev: 'activate', sf: surface.id, id: pickerId!, item: 'session-never-offered', raw: {} }, revision, surface, session)
    return
  }
  if (key.name === 'f4' && page === 'details') {
    note({ control: 'details-page-resume', revision, selectedId })
    await onPickerEvent({ ev: 'action', sf: surface.id, id: readerId!, act: `resume#${revision}`, raw: {} }, revision, surface, session)
    return
  }
  if (page === 'details') {
    if (key.name === 'escape') {
      backToBrowser()
      return
    }
    const scroll: Record<string, 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'start' | 'end'> = {
      up: 'line-up', down: 'line-down', page_up: 'page-up', page_down: 'page-down', home: 'start', end: 'end',
    }
    const destination = scroll[key.name]
    if (destination !== undefined && readerId !== undefined) {
      if (scrollSupported) {
        surface.scroll(readerId, destination)
        note({ readerScroll: destination, readerId, epoch: readerEpoch })
      } else {
        note({ readerScrollUnavailable: true, destination, epoch: readerEpoch })
      }
    }
    return
  }
  if (key.name === 'escape') {
    if (query !== '') changeQuery('')
    else done = true
    return
  }
  if (key.name === 'tab') {
    const ring: Zone[] = query === '' ? ['list', 'scopes', 'actions'] : ['list', 'actions']
    const at = ring.indexOf(zone)
    zone = ring[(at + (key.shift ? -1 : 1) + ring.length) % ring.length]!
    repaint()
    return
  }
  if (zone === 'scopes') {
    if (key.name === 'left' || key.name === 'right' || key.name === 'enter') setScope(scope === 'workspace' ? 'all' : 'workspace')
    return
  }
  if (zone === 'actions') {
    if (key.name === 'left' || key.name === 'up') actionCursor = (actionCursor + 2) % 3
    else if (key.name === 'right' || key.name === 'down') actionCursor = (actionCursor + 1) % 3
    else if (key.name === 'enter') {
      const action = (['close', 'details', 'resume'] as const)[actionCursor]!
      const offered = actionItems(revision, visibleRows()).find((item) => item.id === `${action}#${revision}`)
      if (offered === undefined || offered.disabled !== undefined) {
        note({ rejected: 'disabled-keyboard-action', action, revision })
        return
      }
      await performAction(action, 'footer-keyboard', surface, session)
      return
    }
    repaint()
    return
  }
  if (key.name === 'enter') {
    simulateResume(selectedId, 'list-enter')
    return
  }
  const rows = visibleRows()
  const at = rows.findIndex((row) => row.id === selectedId)
  const move = (next: number): void => {
    if (rows.length === 0) return
    selectedId = rows[Math.max(0, Math.min(rows.length - 1, next))]!.id
    resumeNoticeId = undefined
    actionCursor = 2
    repaint()
  }
  if (key.name === 'up') { move(Math.max(0, at - 1)); return }
  if (key.name === 'down') { move(at < 0 ? 0 : at + 1); return }
  if (key.name === 'home') { move(0); return }
  if (key.name === 'end') { move(rows.length - 1); return }
  if (key.name === 'page_up') { move(Math.max(0, at - 5)); return }
  if (key.name === 'page_down') { move(Math.min(rows.length - 1, Math.max(0, at) + 5)); return }
  const nextQuery = editedQuery(key, query)
  if (nextQuery !== undefined && nextQuery !== query) changeQuery(nextQuery)
}

async function main(): Promise<void> {
  const connected = await connect({ app: 'tern-session-browser-demo', timeout: 2000 })
  if (connected === null) throw new Error('Run this demo inside a Tern terminal pane.')
  const session: Session = connected
  const requiredKinds = ['picker', 'overlay', 'col', 'row', 'text']
  const missingKinds = requiredKinds.filter((kind) => !session.caps.kinds.includes(kind))
  if (missingKinds.length > 0) throw new Error(`Tern client does not advertise required kinds: ${missingKinds.join(', ')}`)
  scrollSupported = session.caps.features.includes('scroll')
  const surface = session.open({ mode: 'inline', title: 'Session Browser Demo' })
  note({ ready: true, caps: { term: session.caps.term, ver: session.caps.ver, kinds: session.caps.kinds, features: session.caps.features, scrollSupported, cols: session.caps.cols, cell: session.caps.cell } })
  if (!scrollSupported) note({ unsupported: 'scroll', reason: 'Tern client did not advertise the scroll feature' })

  function render(): void {
    revision += 1
    const currentRows = visibleRows()
    const row = page === 'details' ? currentRows.find((candidate) => candidate.id === selectedId) : undefined
    const layer = row === undefined ? browserLayer(revision, surface, session) : detailLayer(row)
    const view = { layer }
    const tree = View.from(view).regions[2]
    const nextNodeIds = new Set<string>()
    let nextPickerId: string | undefined
    let nextReaderId: string | undefined
    const bodyKey = `session-browser-reader-body-${readerEpoch}`
    const visit = (node: typeof tree): void => {
      if (node === undefined) return
      nextNodeIds.add(node.id)
      if (node.props['key'] === 'session-browser-picker') nextPickerId = node.id
      if (row !== undefined && node.props['key'] === bodyKey) nextReaderId = node.id
      for (const child of node.children) visit(child)
    }
    visit(tree)
    surface.render(view)
    renderedNodeIds = nextNodeIds
    pickerId = nextPickerId
    readerId = nextReaderId
    const selectedRow = currentRows.find((candidate) => candidate.id === selectedId)
    const currentHits = query === '' ? [] : searchRows(query)
    const hasMore = scenario === 'has-more' && query.toLocaleLowerCase() === 'pagination'
    note({
      frame: {
        revision,
        page,
        phase,
        scenario,
        metadataReady,
        query,
        scope: query === '' ? scope : 'all',
        selectedId: selectedRow?.id ?? null,
        selectedTitle: selectedRow === undefined || !metadataReady ? null : titles.get(selectedRow.id) ?? null,
        selectedIndex: selectedRow === undefined ? -1 : currentRows.findIndex((candidate) => candidate.id === selectedRow.id),
        zone,
        actionCursor,
        layout: query === '' ? 'tree' : 'cards',
        ids: currentRows.map((candidate) => candidate.id),
        mainCount: allMainSessions().length,
        workspaceCount: new Set(allMainSessions().map((candidate) => candidate.cwd ?? '')).size,
        total: hasMore ? 12 : currentRows.length,
        hasMore,
        depths: page === 'browser' && query === '' ? currentRows.map((candidate) => ({ id: candidate.id, depth: rowDepth(candidate, currentRows) })) : [],
        searchSources: currentHits.map((hit) => ({ id: hit.session.id, source: hit.source, cwd: hit.session.cwd ?? null })),
        resumeNoticeId: resumeNoticeId ?? null,
        pickerId: pickerId ?? null,
        readerId: readerId ?? null,
        actionIds: page === 'browser' ? actionIds(revision) : [],
        readerEpoch,
      },
    })
  }
  repaint = render

  try {
    repaint()
    await new Promise((resolve) => setTimeout(resolve, 350))
    phase = 'ready'
    repaint()
    await new Promise((resolve) => setTimeout(resolve, 250))
    metadataReady = true
    repaint()
    for await (const input of session) {
      if (input.type === 'key') {
        await handleKey(input.key, surface, session)
        if (done) break
        continue
      }
      if (input.event.ev === 'resize') {
        note({ resize: { cols: input.event.cols, cell: input.event.cell ?? null } })
        repaint()
        continue
      }
      if (input.event.ev === 'action') {
        routeUnhandledEvent(input.event, surface)
        continue
      }
      if (input.event.ev !== 'ack') note({ event: input.event.raw })
    }
  } finally {
    if (!session.closed) {
      await surface.close({ keep: false })
      await session.close()
    }
    note({ closed: true })
  }
}

await main()
