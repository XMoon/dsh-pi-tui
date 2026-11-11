/**
 * M5-U-C — the fullscreen PiTUI Session Workspace panel, driven through the
 * REAL `TuiApp.openSessionWorkspace` physical lease and the REAL
 * `VirtualTerminal` input pipeline.
 *
 * These cases own the PRESENTATION contract only: list rendering and
 * selection, the `Current` marker, the in-place Workspace selector, the raw
 * global editor (one-shot seed, user edit wins), the safe two-Enter resume,
 * the Esc ladder, the responsive width matrix and the untrusted-text
 * projection. The cross-layer owner/lifecycle contract lives in
 * `test/app/session-workspace-lifecycle.test.ts`; the two fail for different
 * reasons on purpose.
 * @module @xmoon76/dsh-pi-tui/session-workspace-panel.test
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp, type SessionWorkspaceHandle } from '../../src/tui-app.ts'
import type { SessionWorkspacePanelHost, SessionWorkspacePanelOptions } from '../../src/tui/panels/session-workspace-panel.ts'
import { SessionWorkspacePanel } from '../../src/tui/panels/session-workspace-panel.ts'
import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserReadSnapshot,
  SessionBrowserSubject,
} from '../../src/app/command/session-browser-presentation.ts'
import type { SessionActivityFact } from '../../src/runtime/session-workspace-facts-port.ts'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { HostDirectoryBrowseOutcome } from '../../src/runtime/host-directory-browse-port.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'
import { shortSessionId } from '../../src/tui/pickers/sessions.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started, disposeAll } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeAll()
})

const CURRENT = 'session-current-session'
const OTHER = 'session-other-session'
const THIRD = 'session-third-session'

function row(id: string, updatedAt: number, extra: Record<string, unknown> = {}): SessionBrowserReadSnapshot['rows'][number] {
  return { id, updatedAt, createdAt: updatedAt, cwd: '/ws/project', live: false, ...extra }
}

function snapshot(overrides: Partial<SessionBrowserReadSnapshot> = {}): SessionBrowserReadSnapshot {
  return {
    listState: 'ready',
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
    query: '',
    resumePending: false,
    searchState: 'idle',
    searchResults: [],
    hasMore: false,
    listRevision: 1,
    ...overrides,
  }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly handle: SessionWorkspaceHandle
  readonly resumes: string[]
  readonly queries: string[]
  closes: number
  view(): string
  raw(): string
  paint(): Promise<void>
  /** Release THIS harness's TuiApp so another harness can own the process slot. */
  dispose(): void
}

function harness(options: {
  readonly columns?: number
  readonly rows?: number
  readonly currentSessionId?: string | null
  readonly initialMode?: 'browse' | 'search'
  readonly initialBrowseScope?: 'current' | 'all'
  readonly initialDirectoryChooser?: boolean
  readonly currentWorkspaceId?: string
  readonly initialDirectoryEntry?: boolean
  readonly initialDirectoryPath?: string
  readonly onAddDirectory?: (path: string, settle: (outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void) => void
  readonly onListDirectory?: import('../../src/runtime/host-directory-browse-port.ts').HostDirectoryBrowsePort['list']
  readonly onNewSession?: (workspaceId: string, settle?: (outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void) => void
  readonly onUseDirectory?: (workspaceId: string, canonicalPath: string) => void
  readonly isCurrent?: () => boolean
} = {}): Harness {
  const columns = options.columns ?? 100
  const rows = options.rows ?? 30
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const resumes: string[] = []
  const queries: string[] = []
  const state = { closes: 0 }
  const currentSessionId = options.currentSessionId === null ? undefined : options.currentSessionId ?? CURRENT
  const subject: SessionBrowserSubject = {
    currentSessionId,
    currentCwd: '/ws/project',
    isCurrent: options.isCurrent ?? (() => true),
  }
  const handle = app.openSessionWorkspace({
    subject,
    onQueryChange: (raw) => { queries.push(raw) },
    onResume: (sessionId) => { resumes.push(sessionId) },
    ...(options.onAddDirectory === undefined ? {} : { onAddDirectory: options.onAddDirectory }),
    ...(options.onListDirectory === undefined ? {} : { onListDirectory: options.onListDirectory }),
    ...(options.onNewSession === undefined ? {} : { onNewSession: options.onNewSession }),
    ...(options.onUseDirectory === undefined ? {} : { onUseDirectory: options.onUseDirectory }),
    onClose: () => { state.closes += 1 },
    initialMode: options.initialMode ?? 'browse',
    initialBrowseScope: options.initialBrowseScope ?? 'all',
    initialDirectoryChooser: options.initialDirectoryChooser,
    currentWorkspaceId: options.currentWorkspaceId,
    initialDirectoryEntry: options.initialDirectoryEntry,
    initialDirectoryPath: options.initialDirectoryPath,
  })
  return {
    vt,
    app,
    handle,
    resumes,
    queries,
    get closes() { return state.closes },
    view: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
    raw: () => vt.writes.join(''),
    paint: async () => { await vt.waitForRender() },
    dispose: () => { started.delete(app); app.dispose() },
  }
}

test('the same PiTui Browser path mode preserves rejected input and returns on Host success', async () => {
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const submitted: string[] = []
  const h = harness({
    currentSessionId: null,
    initialBrowseScope: 'all',
    initialDirectoryChooser: true,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  h.handle.setSnapshot(snapshot({ workspace: {
    revision: 1,
    state: 'ready',
    facts: [],
    baselineProven: true,
    answerEligibility: undefined,
  } }))
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  // The root Add row is the FIRST explicit action of the same tree.
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Host directory:'), `Chooser enters the inline Host path editor from the root Add row:\n${h.view()}`)
  h.vt.sendInput('/client/proposed')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/client/proposed'], 'the entered path reaches the Host resolver owner')
  outcomes[0]!({ kind: 'failed', message: 'not available on Host' })
  await h.paint()
  assert.ok(h.view().includes('/client/proposed'), 'a rejected path remains in the same editor')
  assert.ok(h.view().includes('not available on Host'))
  h.vt.sendInput('\r')
  await h.paint()
  outcomes[1]!({ kind: 'registered', workspaceId: 'ws-canonical', path: '/host/canonical' })
  await h.paint()
  assert.equal(h.closes, 1, 'successful Welcome directory selection returns to Welcome')
  assert.equal(h.app.isFullscreen(), false)
})
test('folder pointer collapses default-expanded active rows and Show more pointer expands five history rows', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-panel-history-${index}`, 900 - index, { title: `History ${index}` }))
  const h = harness({ columns: 100, rows: 34 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), row('session-panel-active', 2_000, { title: 'Active row' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-current', path: '/ws', title: 'Current', sessionIds: [CURRENT] },
    { workspaceId: 'ws-other', path: '/other', title: 'Other', sessionIds: ['session-panel-active', ...history.map(item => item.id)] },
  ] })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact('session-panel-active', { running: true, attention: 'none', attentionSourceState: 'known' }),
      ...history.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' }))],
    answerEligibility: [],
  })
  await h.paint()
  assert.ok(h.view().includes('Active row'), 'the confirmed active non-current row is auto-expanded')
  let frame = panelFrame(h)
  const folderLine = lineIndexOf(frame, 'Other · 31')
  await clickCell(h, 2, folderLine)
  assert.ok(!h.view().includes('Active row'), 'one pointer click honors the effective default-expanded state and collapses it')
  assert.ok(!h.view().includes('Show more sessions'), 'a manually collapsed Workspace contains only its folder header')
  h.vt.sendInput('\r')
  await h.paint()
  const opened = h.view()
  assert.ok(opened.includes('Active row'), `Enter explicitly reopens the collapsed Folder:\n${opened}`)
  assert.ok(opened.includes('History 19'), `reopening restores the watermark this open had already grown:\n${opened}`)
  assert.ok(!opened.includes('History 20'), `the restored watermark stays bounded:\n${opened}`)
  frame = panelFrame(h)
  const moreLine = lineIndexOf(frame, 'Show more sessions')
  await clickCell(h, 3, moreLine)
  const view = h.view()
  assert.ok(view.includes('History 24'), `Show more advances the per-Workspace watermark by five:\n${view}`)
  assert.ok(!view.includes('History 25'), `the reveal is bounded to the next five rows:\n${view}`)
  assert.ok(view.includes('Active row'), 'the folder keeps its active row after the reveal')
  assert.ok(/^> .*Show more sessions/m.test(view), 'the cursor stays on the reveal target')
})

test('the sessionless Folder New session action uses the shared command callback', async () => {
  const requested: string[] = []
  const h = harness({
    currentSessionId: null,
    currentWorkspaceId: 'ws-other',
    onNewSession: (workspaceId) => { requested.push(workspaceId) },
  })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-current', path: '/ws', title: 'Current', sessionIds: [] },
    { workspaceId: 'ws-other', path: '/other', title: 'Other', sessionIds: [CURRENT, OTHER] },
  ] })
  await h.paint()
  // The next-create destination is the initial cursor and starts expanded;
  // Right enters its first child, the New row.
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-other'], 'the Folder action delegates one official WorkspaceId')
  assert.equal(h.closes, 0, 'the presentation never closes the Browser by itself; the commit continuation owns it')
})

test('a retained first-submit path enters Browser directly, submits once, and exposes clickable Verify directory', async () => {
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const submitted: string[] = []
  const h = harness({
    currentSessionId: null,
    initialBrowseScope: 'all',
    initialDirectoryChooser: true,
    initialDirectoryEntry: true,
    initialDirectoryPath: '/launch/failed',
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  await h.paint()
  assert.ok(h.view().includes('Host directory:'), 'the inline Host path editor is painted under the root Add row')
  assert.ok(h.view().includes('/launch/failed'))
  h.vt.sendInput('\r')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/launch/failed'], 'the Host path request stays single-flight')
  outcomes[0]!({ kind: 'failed', message: 'refused on Host' })
  await h.paint()
  assert.ok(h.view().includes('/launch/failed'), 'Host refusal leaves the attempted launch path editable')
  // The auto-open handoff must not hide the failure that led here: the app
  // notice (the submission owner's refusal) stays painted in the path editor.
  h.app.notify('could not start a session: the Host refused the proposed workspace directory', 'error')
  await h.paint()
  assert.ok(h.view().includes('could not start a session: the Host refused'),
    `the path editor keeps the originating failure notice:\n${h.view()}`)
  assert.ok(h.view().includes('Verify [Enter]') && h.view().includes('Cancel [Esc]'), 'the path mode paints its actual actions on the ONE bar')
  const actionLine = lineIndexOf(panelFrame(h), 'Verify [Enter]')
  await clickCell(h, 2, actionLine)
  assert.deepEqual(submitted, ['/launch/failed', '/launch/failed'], 'clicking the painted Verify word submits the same retained proposal')
  outcomes[1]!({ kind: 'registered', workspaceId: 'ws-launch', path: '/host/canonical' })
  await h.paint()
  assert.equal(h.closes, 1, 'success returns through the existing chooser owner')
})
test('the browse list paints the header, current marker, selection and guarded Resume', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Sessions · 2'), `the ONE header states the roster count:\n${view}`)
  assert.ok(!view.includes('Current: curren'), 'the header never repeats the Current Session id')
  assert.ok(!view.includes('Workspace:'), 'the header never repeats an All-workspaces scope')
  assert.ok(view.includes('Current session') && view.includes('Other session'), `both titles paint:\n${view}`)
  assert.ok(/^> {3}● current-/m.test(view), `Current keeps only its own row marker:\n${view}`)
  const lines = view.split('\n')
  assert.ok(lines[lines.length - 1]!.includes('Close [Esc]'), 'the action bar is the last physical row')

  // Enter on the selected CURRENT row is a no-op: currentness is not selection.
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Enter on the current Session never resumes')

  // Down selects the next listed row; Enter produces ONE logical intent.
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(/^> /m.test(h.view()), `the selection marker is the ASCII arrow:\n${h.view()}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter on a listed non-current row emits one resume intent')
})

test('the one-shot seed writes the editor once; a real edit wins and never overwrites it', async () => {
  const h = harness({ initialMode: 'search' })
  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: [
    { row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle found' },
  ] }), 'needle')
  await h.paint()
  assert.ok(h.view().includes('Search: needle'), `the one-shot seed reaches the editor:\n${h.view()}`)
  assert.ok(h.view().includes('needle found'), 'the Host snippet paints on the result row')

  // A later ordinary snapshot must never overwrite the editor.
  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: [] }), 'different')
  await h.paint()
  assert.ok(h.view().includes('Search: needle'), 'an ordinary snapshot never rewrites the editor')
  assert.ok(!h.view().includes('different'), 'the superseded seed is ignored')

  // A real edit reports the raw text; a cursor move does not.
  h.vt.sendInput('x')
  await h.paint()
  assert.deepEqual(h.queries, ['needlex'], 'a real text change reports the raw editor value')
  h.vt.sendInput('\x1b[D')
  await h.paint()
  assert.deepEqual(h.queries, ['needlex'], 'a cursor move alone never mints a query generation')

  // Results → editor → browse → close: each Esc removes exactly one level.
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(h.view().includes('Up/Down move'), 'the first Esc restores the browse list')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(h.closes, 1, 'the root Esc notifies the owner exactly once')
})

test('the first Enter moves focus to the first REAL result; only the second Enter resumes', async () => {
  const h = harness({ initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [
      { row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Both', snippet: 'needle a' },
      { row: row(THIRD, 1_000, { title: 'Third session' }), source: 'Content', snippet: 'needle b' },
    ],
  }), 'needle')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Enter from the editor only enters the result list')
  assert.ok(h.view().includes('Back [Esc]'), 'the result list advertises its own Esc')
  h.vt.sendInput('\x1b[B') // second result
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [THIRD], 'Enter from the result list emits the one resume intent')
})

test('Esc restores the pre-search selection and scope; the results list never wraps into browse', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('/')
  await h.paint()
  h.vt.sendInput('session')
  await h.paint()
  assert.ok(h.view().includes('Search all workspaces'))
  // The global search is not the browse list: Tab stays inside the search.
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(h.view().includes('Search all workspaces'), 'Tab never leaves an active global search')
  h.vt.sendInput('\x1b')
  await h.paint()
  const restored = h.view()
  assert.ok(restored.includes('Up/Down move'), 'the browse list is back')
  assert.ok(!restored.includes('Search all workspaces'), 'the global-search context is gone')
  assert.ok(/^> .*Other session/m.test(restored), `the pre-search selection survives:\n${restored}`)
})

test('Workspace-first browse lists every official Workspace without inferring membership from cwd', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  assert.ok(!h.view().includes('▾'), 'without a Host baseline no Folder claim is painted')
  assert.ok(h.view().includes('Other session'), 'without a Host baseline the ordinary roster stays flat and usable')

  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/project', title: 'project', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/other', title: 'other', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const grouped = h.view()
  assert.ok(grouped.includes('project') && grouped.includes('other'), `both official folders are visible:\n${grouped}`)
  assert.ok(!grouped.includes('Workspace:'), 'the official tree is never announced as a scope selector')
  assert.ok(!grouped.includes('Current workspace unavailable'), 'membership is not a browse scope fallback')

  h.handle.updateWorkspaces({ type: 'remove', workspaceId: 'ws-a' })
  await h.paint()
  const after = h.view()
  assert.ok(after.includes('other'), `the remaining official Workspace stays browsable:\n${after}`)
  assert.ok(after.includes('Current workspace unavailable — showing all workspaces'))

  h.handle.workspaceUnavailable('Workspace membership unavailable')
  await h.paint()
  assert.ok(h.view().includes('Workspace membership unavailable'))
  assert.ok(h.view().includes('Other session'), 'a failed follow never hides the flat Session list')
})

test('every Browser entry lists the ONE global Workspace tree', async () => {
  for (const initialBrowseScope of ['current', 'all'] as const) {
    const h = harness({ initialBrowseScope, onAddDirectory: () => {} })
    h.handle.setSnapshot(snapshot())
    h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }] })
    await h.paint()
    const view = h.view()
    assert.ok(view.includes('Add directory'), `the ${initialBrowseScope} entry exposes the root Add row:\n${view}`)
    assert.ok(view.includes('a · 1'), `the ${initialBrowseScope} entry lists the official Folder:\n${view}`)
    assert.ok(!view.includes('Workspace:'), 'no entry borrows the retired scope wording')
    h.app.dispose()
    started.delete(h.app)
  }
})

test('a missing current-session membership remains in the proved Unassigned folder', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-b', path: '/other', title: 'other', sessionIds: [OTHER] }] })
  await h.paint()
  assert.ok(!h.view().includes('Workspace:'))
  assert.ok(h.view().includes('Unassigned'), `the current Session is not guessed into a Workspace:\n${h.view()}`)
})

test('an ambiguous current-session membership stays out of official folders', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [CURRENT] },
    ],
  })
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Membership ambiguous'), `no first-match membership is guessed:\n${view}`)
  assert.ok(view.includes('Current workspace unavailable — showing all workspaces'))
})

test('a later official replace proves the current Workspace folder without stale fallback text', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [{ workspaceId: 'ws-b', path: '/other', title: 'other', sessionIds: [OTHER] }],
  })
  await h.paint()
  assert.ok(h.view().includes('Current workspace unavailable — showing all workspaces'))
  h.handle.updateWorkspaces({
    type: 'replace',
    items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  assert.ok(!h.view().includes('Current workspace unavailable'), 'the old fallback line is cleared')
})

test('Workspace remove/upsert updates official folder rows without cwd inference', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }] })
  await h.paint()
  assert.ok(h.view().includes('a · 1'))
  h.handle.updateWorkspaces({ type: 'remove', workspaceId: 'ws-a' })
  await h.paint()
  assert.ok(!h.view().includes('a · 1'))
  h.handle.updateWorkspaces({ type: 'upsert', workspace: { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] } })
  await h.paint()
  assert.ok(h.view().includes('a · 1'))
  assert.ok(!h.view().includes('Workspace:'), 'the restored membership stays in the global tree')
})

test('replace and upsert refold the official Workspace folders', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' }), row(THIRD, 1_000, { title: 'Third session' })],
  }))
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  assert.ok(h.view().includes('a · 1') && h.view().includes('b · 1'))
  h.handle.updateWorkspaces({ type: 'replace', items: [{ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT, OTHER] }] })
  await h.paint()
  assert.ok(h.view().includes('Other session'), 'a replace membership change updates the official member row')
  h.handle.updateWorkspaces({ type: 'upsert', workspace: { workspaceId: 'ws-c', path: '/third', title: 'c', sessionIds: [THIRD] } })
  await h.paint()
  assert.ok(h.view().includes('c · 1'), 'an official upsert creates its own Folder row')
})

test('w is ordinary global query text and no Workspace scope shortcut is painted', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  const header = panelFrame(h)[1]!
  assert.ok(!header.includes('[w]'))
  h.vt.sendInput('w')
  await h.paint()
  assert.ok(h.view().includes('Search all workspaces'))
  assert.ok(h.view().includes('Search: w'))
  assert.ok(!h.view().includes('Workspace scope:'))
  assert.deepEqual(h.resumes, [])
})

test('a short frame scrolls the Workspace tree so the selected Session stays painted and openable', async () => {
  const history = Array.from({ length: 8 }, (_, index) => row(`session-tree-scroll-${index}`, 8_000 - index, { title: `History ${index}` }))
  const h = harness({ columns: 80, rows: 10 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 9_000, { title: 'Current session' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Project', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  await h.paint()
  // Walk past the first painted page. The tree must scroll with the cursor:
  // a selected row that is not painted can never be opened.
  for (let step = 0; step < 5; step += 1) {
    h.vt.sendInput('\x1b[B')
    await h.paint()
  }
  const view = h.view()
  assert.ok(view.includes('History 4'), `the selected row scrolls into the painted window:\n${view}`)
  assert.ok(!view.includes('Current session'), `the window moved off the first page:\n${view}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, ['session-tree-scroll-4'], 'the scrolled-to row is a real painted activation target')
})

test('a row the current frame never painted can never be opened, and resizing re-validates it', async () => {
  // 80×3 paints only the header/subheader/action bar: no Session row exists.
  const h = harness({ columns: 80, rows: 3 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  await h.paint()
  assert.ok(!h.view().includes('Other session'), 'no row is painted at 3 rows')
  h.vt.sendInput('\x1b[B') // select the non-current row logically
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'an unpainted row can never be opened by a blind Enter')

  // Growing the terminal paints the same logical selection; the activation is
  // now admitted against the actually painted frame.
  h.vt.resize(80, 24)
  await h.paint()
  assert.ok(h.view().includes('Other session'))
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'the re-validated painted row opens')
})

test('status rows that squeeze the whole list out also withhold activation', async () => {
  const h = harness({ columns: 80, rows: 8 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
    projectionError: 'projection failed',
  }))
  h.handle.workspaceUnavailable('Workspace membership unavailable')
  await h.paint()
  const squeezed = h.view()
  assert.ok(squeezed.includes('Sessions · 2'))
  assert.ok(squeezed.includes('Workspace membership unavailable'))
  assert.ok(squeezed.includes('Session details unavailable'), `the projection failure keeps its one status line:\n${squeezed}`)
  assert.ok(!squeezed.includes('Other session'), `status lines consumed the list budget:\n${squeezed}`)
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'a status-squeezed list admits no activation')

  h.vt.resize(80, 24)
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'the visible row opens after the list is painted again')
})

test('the two-Enter search contract cannot open an unpainted result', async () => {
  const h = harness({ columns: 80, rows: 3, initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [{ row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle found' }],
  }), 'needle')
  await h.paint()
  h.vt.sendInput('\r') // editor -> result focus
  h.vt.sendInput('\r') // result Enter, but no result was painted
  await h.paint()
  assert.deepEqual(h.resumes, [], 'an unpainted result can never be opened')

  h.vt.resize(80, 24)
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'the painted result opens after the resize')
})

test('a search fact that is also the app notice paints exactly once in the same frame', async () => {
  const h = harness({ columns: 100, rows: 24, initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'error',
    searchError: 'fts backend exploded',
    searchResults: [],
  }), 'needle')
  h.app.notify('session content search failed: fts backend exploded', 'error')
  await h.paint()
  const view = h.view()
  assert.equal(
    view.split('\n').filter(line => line.includes('session content search failed: fts backend exploded')).length,
    1,
    `the same fact has exactly ONE visible exit in the frame:\n${view}`,
  )

  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', hasMore: true, searchResults: [] }))
  h.app.notify('More content matches exist — refine the search.')
  await h.paint()
  assert.equal(
    h.view().split('\n').filter(line => line.includes('More content matches exist — refine the search.')).length,
    1,
    'the hasMore fact is painted once, never as status + notice',
  )
})

test('the frozen size matrix keeps the Esc row reachable and every painted cell inside the width', async () => {
  const h = harness({ columns: 80, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  await h.paint()
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20], [80, 5], [80, 3]] as const) {
    h.vt.resize(columns, rows)
    await h.paint()
    // The VIEWPORT always has exactly `rows` lines, so assert on the panel's
    // own painted frame: the row budget is the panel's contract, not the
    // emulator's.
    const panel = h.app.focusedComponentForTest()
    assert.ok(panel !== null && panel !== undefined, `${columns}x${rows}: the workspace panel owns the keyboard`)
    const painted = panel.render(columns)
    assert.ok(painted.length <= rows, `${columns}x${rows}: the frame never exceeds the row budget (${painted.length} > ${rows})`)
    assert.ok(stripTerminalSequences(painted[painted.length - 1]!).includes('Esc'),
      `${columns}x${rows}: the Esc row stays reachable`)
    for (const line of painted) {
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows}: a row overflows its width: ${JSON.stringify(line)}`)
    }
    assert.ok(stripTerminalSequences(painted[0]!).includes('Sessions'), `${columns}x${rows}: the header survives`)
  }
})

test('untrusted title/cwd/snippet/error text never carries a terminal escape into the frame or the raw stream', async () => {
  const hostile = '\x1b]0;PWNED\x07\x1b[2J\u009b2Jevil'
  const h = harness({ columns: 80, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: `${hostile} title`, cwd: `/ws\x1b]0;PWNED\x07` }), row(OTHER, 2_000)],
    query: 'needle',
    searchState: 'error',
    searchError: `${hostile} boom`,
    searchResults: [
      { row: row(OTHER, 2_000, { title: `${hostile} hit` }), source: 'Content', snippet: `${hostile} snippet` },
    ],
  }), 'needle')
  await h.paint()
  // The app's ONE transient notice is arbitrary caller/Host/extension bytes and
  // must cross the same one-physical-row projection before this workspace paints
  // it (a background notice can fire while any workspace is open).
  h.app.notify(`${hostile} notice`, 'error')
  await h.paint()
  const raw = h.raw()
  assert.ok(!raw.includes('\x1b]0;PWNED'), 'the injected OSC never reaches the terminal raw stream')
  assert.ok(!raw.includes('\u009b2Jevil'), 'the injected C1 CSI never reaches the terminal raw stream')
  const view = h.view()
  assert.ok(!view.includes('\x1b'), 'the painted frame carries no raw ESC')
  assert.ok(!view.includes('PWNED'), 'the OSC payload never survives as visible text')
  assert.ok(view.includes('evil notice'), `the readable notice text survives the projection:\n${view}`)
  for (const line of h.vt.getViewport()) {
    assert.ok(visibleWidth(line) <= 80, `the hostile notice never widens a row: ${JSON.stringify(line)}`)
  }
})

test('an id-derived header/row label is sanitized like every other Host value', async () => {
  const hostileId = 'session-\x1b]0;PWNED\x07evil'
  const h = harness({ currentSessionId: hostileId })
  h.handle.setSnapshot(snapshot({
    rows: [row(hostileId, 3_000, { title: 'Hostile id row' })],
  }))
  await h.paint()
  const raw = h.raw()
  assert.ok(!raw.includes('\x1b]0;PWNED'), 'an id-derived label never carries the injected OSC')
  const view = h.view()
  assert.ok(!view.includes('\x1b'), `the painted frame carries no raw ESC:\n${view}`)
  assert.ok(view.includes('Hostile id row'), 'the readable title still paints')
})

test('two same-title same-cwd same-age Sessions keep distinct stable ids and resume targets', async () => {
  const shared = { updatedAt: 3_000, cwd: '/app/service', live: false }
  const h = harness({ columns: 44, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { ...shared, title: 'Fix pipeline' }), row(OTHER, 3_000, { ...shared, title: 'Fix pipeline' })],
  }))
  await h.paint()
  for (const width of [44, 80, 120] as const) {
    h.vt.resize(width, 24)
    await h.paint()
    const view = h.view()
    assert.ok(view.includes('current-') && view.includes('other-se'),
      `${width} columns: both stable short ids are painted:\n${view}`)
    // The wide layout ALSO paints the selected row's read-only preview: count
    // the two LIST rows by their identity columns, never the pane total.
    const listRows = view.split('\n').filter(line => /^[ >] *(● )?(current-|other-se)/.test(line))
    assert.equal(listRows.length, 2, `${width} columns: both same-title rows remain painted:\n${view}`)
    for (const line of h.vt.getViewport()) {
      assert.ok(visibleWidth(line) <= width, `${width} columns: a row overflows: ${JSON.stringify(line)}`)
    }
  }
  // The two rows remain different activation identities, not two copies of the
  // same painted label.
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'the second same-title row resumes its own Session id')
})

test('a long cwd or Host snippet never squeezes the Session identity out of a row', async () => {
  const longCwd = '/very/long/shared/workspace/path/with/a/deep/project-alpha'
  const alpha = row(CURRENT, 3_000, { title: 'Alpha session', cwd: longCwd })
  const beta = row(OTHER, 2_000, { title: 'Beta session', cwd: longCwd })
  const h = harness({ columns: 44, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [alpha, beta] }))
  await h.paint()
  for (const width of [44, 80, 120] as const) {
    h.vt.resize(width, 24)
    await h.paint()
    const view = h.view()
    // The Session row is a CHILD of its Folder: the identity starts two cells
    // right of the Folder label, so a 44-column frame truncates the TITLE, not
    // the stable id that keeps two same-cwd rows distinguishable.
    assert.ok(/current-  Alpha/.test(view), `${width} columns: the first identity survives a long cwd:\n${view}`)
    assert.ok(/other-se  Beta/.test(view), `${width} columns: two same-cwd Sessions stay distinguishable:\n${view}`)
    for (const line of h.vt.getViewport()) {
      assert.ok(visibleWidth(line) <= width, `${width} columns: a row overflows: ${JSON.stringify(line)}`)
    }
  }

  // A long Host snippet is a secondary column: it may be truncated or dropped,
  // but it never steals the identity budget.
  h.vt.resize(44, 24)
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [{
      row: { ...alpha, title: 'Alpha session' },
      source: 'Content',
      snippet: 'a very long Host excerpt that does not contain the literal query term and must yield to the identity',
    }],
  }), 'needle')
  await h.paint()
  const searchView = h.view()
  assert.ok(searchView.includes('Alpha session'), `the search identity survives a long snippet:\n${searchView}`)
  for (const line of h.vt.getViewport()) {
    assert.ok(visibleWidth(line) <= 44, `the search row fits 44 columns: ${JSON.stringify(line)}`)
  }
})

test('a released handle is inert and cannot repaint or close a newer workspace', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.handle.close()
  await h.paint()
  assert.equal(h.handle.isDisposed(), true)
  h.handle.setSnapshot(snapshot({ rows: [row(THIRD, 1_000, { title: 'Must not paint' })] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [] })
  h.handle.workspaceUnavailable('must not paint')
  await h.paint()
  assert.ok(!h.view().includes('Must not paint'), 'a stale handle never repaints')
  assert.ok(!h.view().includes('must not paint'), 'a stale handle never raises a workspace status')
  // A newer lease still owns the surface and the old handle cannot close it.
  const second = h.app.openSessionWorkspace({
    subject: { currentSessionId: CURRENT, currentCwd: '/ws/project', isCurrent: () => true },
    onQueryChange: () => {},
    onResume: () => {},
    onClose: () => {},
    initialMode: 'browse',
    initialBrowseScope: 'all',
  })
  second.setSnapshot(snapshot({ rows: [row(THIRD, 1_000, { title: 'Newer workspace' })] }))
  await h.paint()
  h.handle.close()
  await h.paint()
  assert.ok(h.view().includes('Newer workspace'), 'the newer workspace survives the stale closer')
  second.close()
})

// ── M5-U-D: groups, Peek, the full selector, the wide layout and the mouse ──

function fact(sessionId: string, extra: Partial<SessionActivityFact> = {}): SessionActivityFact {
  return {
    sessionId,
    running: undefined,
    pendingKinds: undefined,
    continuedQuestionCallIds: undefined,
    attention: 'unknown',
    attentionSourceState: 'unknown',
    ...extra,
  }
}

function questionFact(sessionId: string, extra: Partial<SessionActivityFact> = {}): SessionActivityFact {
  return fact(sessionId, {
    running: false,
    pendingKinds: ['question'],
    continuedQuestionCallIds: [],
    attention: 'question',
    attentionSourceState: 'known',
    ...extra,
  })
}

function eligibility(sessionId: string, kind: 'question' | 'approval' = 'question'): SessionBrowserAnswerEligibility {
  return { sessionId, kind, live: true }
}

/** The painted panel frame of the LAST render, in panel-relative 0-based rows.
 *  Read from the real physical viewport: calling `render()` again would paint a
 *  newer frame than the one the user (and the mouse gesture) acted on. */
function panelFrame(h: Harness): string[] {
  return h.view().split('\n')
}

function lineIndexOf(frame: readonly string[], needle: string): number {
  const index = frame.findIndex(line => line.includes(needle))
  assert.ok(index >= 0, `the frame paints ${JSON.stringify(needle)}:\n${frame.join('\n')}`)
  return index
}

/** The Folder's OWN painted row (never a preview line that happens to repeat
 *  the title). */
function folderLineIndexOf(frame: readonly string[], title: string): number {
  const index = frame.findIndex(line => line.includes(title) && /[▾▸]/.test(line))
  assert.ok(index >= 0, `the frame paints the ${JSON.stringify(title)} Folder row:\n${frame.join('\n')}`)
  return index
}

/** One SGR primary press + release at the SAME 0-based panel cell. */
async function clickCell(h: Harness, x: number, y: number): Promise<void> {
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
}

/** The right-hand wide Preview column, anchored on its own Host text. */
function previewColumn(h: Harness): string {
  const frame = panelFrame(h)
  const anchor = frame.findIndex(line => line.includes('Host directories · read only'))
  assert.ok(anchor >= 0, `the wide preview paints its Host header:\n${frame.join('\n')}`)
  const start = frame[anchor]!.indexOf('Host directories · read only')
  return frame.slice(anchor).map(line => line.slice(start)).join('\n')
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label}: waitUntil timed out after ${timeoutMs}ms`)
    }
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
  }
}

/** One official Host level built from display names (path = parent + name). */
function hostListing(
  parent: string,
  home: string,
  names: ReadonlyArray<string | [string, boolean]>,
  truncated = false,
): DirectoryListing {
  const separator = home.includes('\\') ? '\\' : '/'
  const entries: DirectoryEntry[] = names.map(item => {
    const name = typeof item === 'string' ? item : item[0]
    const hidden = typeof item === 'string' ? false : item[1]
    return { name, path: `${parent.endsWith(separator) ? parent : `${parent}${separator}`}${name}`, hidden }
  })
  return { path: parent, home, crumbs: [], entries, truncated }
}

function readyHostLevel(value: DirectoryListing): HostDirectoryBrowseOutcome {
  return { kind: 'ready', listing: value }
}

/** Click the named verb segment on the ONE physical Action Bar (last row). */
async function clickBarAction(h: Harness, verb: string): Promise<void> {
  const frame = panelFrame(h)
  const bar = frame[frame.length - 1]!
  const x = bar.indexOf(verb)
  assert.ok(x >= 0, `the bar paints ${JSON.stringify(verb)}:\n${bar}`)
  await clickCell(h, x + 1, frame.length - 1)
}

test('the per-open folder expansion and selection survive one global-search round trip', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/other', title: 'Beta', sessionIds: [OTHER] },
  ] })
  await h.paint()
  assert.ok(!h.view().includes('Other session'), 'the inactive non-current Workspace starts collapsed')
  // The current Session is the initial cursor; the official Folder children
  // then put New session on the next row and Beta's Folder after it.
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(/^> .*Beta/m.test(h.view()), `the cursor walks to the Beta Folder:\n${h.view()}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Other session'), 'Enter expands the selected Folder')
  h.vt.sendInput('/')
  await h.paint()
  h.vt.sendInput('needle')
  await h.paint()
  assert.ok(h.view().includes('Search all workspaces'))
  h.vt.sendInput('\x1b')
  await h.paint()
  const restored = h.view()
  assert.ok(restored.includes('Other session'), `Esc restores the same expanded Folder:\n${restored}`)
  assert.ok(/^> .*Beta/m.test(restored), 'and the same typed Folder selection')
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(!h.view().includes('Other session'), 'the selected Folder itself remains the target for Enter')
})

test('a folder keeps Needs, Working and Recent priority in its Session rows', async () => {
  // A long ordinary history keeps the shared watermark meaningful: the automatic
  // list-height growth raises the folder's ordinary rows but the active rows stay
  // FIRST and the unproved pending row behind the watermark.
  const history = Array.from({ length: 30 }, (_, index) => row(`session-recent-${index}`, 1_000 - index, { title: `Recent ${index}` }))
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [
      row('session-needs', 4_000, { title: 'Needs row' }),
      row('session-working', 3_000, { title: 'Working row' }),
      ...history,
      row('session-unverified', 500, { title: 'Unproved row' }),
    ],
  }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-project', path: '/project', title: 'Project', sessionIds: ['session-needs', 'session-working', 'session-unverified', ...history.map(item => item.id)] }] })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      questionFact('session-needs', { running: true }),
      fact('session-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      questionFact('session-unverified'),
      ...history.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
    ],
    answerEligibility: [eligibility('session-needs')],
  })
  await h.paint()
  const frame = panelFrame(h)
  const view = frame.join('\n')
  assert.ok(view.includes('Project · 33'), `official Workspace membership is the outer group:\n${view}`)
  assert.ok(view.includes('Needs row  Needs attention · Working'), `proved Needs stays in its folder and may also be Working:\n${view}`)
  assert.ok(view.includes('Working row  Working'), `proved running row stays inside the Workspace:\n${view}`)
  const needsLine = lineIndexOf(frame, 'Needs row')
  const workingLine = lineIndexOf(frame, 'Working row')
  const recentLine = lineIndexOf(frame, 'Recent 0')
  assert.ok(needsLine < workingLine && workingLine < recentLine,
    `active priorities stay above the ordinary history in one folder:\n${view}`)
  assert.ok(view.includes('Show more sessions · 15 remaining'), `ordinary history stays behind its per-folder watermark:\n${view}`)
  assert.ok(!view.includes('Pending · not actionable here'), 'a row behind the watermark does not inflate the activity list')
})

test('Space opens a read-only Peek: no Host write, Esc restores the browse selection, Enter resumes', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session', preset: 'plan' })],
  }))
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact(OTHER),
    ],
    answerEligibility: [],
  })
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const peek = h.view()
  assert.ok(peek.includes('Peek · other-se'), `the Peek names the stable Session id:\n${peek}`)
  assert.ok(peek.includes('Title:') && peek.includes('Other session'), 'the title is a read-only field')
  assert.ok(peek.includes('Workspace: Unknown'), 'a missing baseline is Unknown, never Unassigned')
  assert.ok(peek.includes('Preset: plan'), 'the projected preset is read-only detail')
  assert.ok(peek.includes('Running: No'), 'the official running fact is stated')
  assert.ok(peek.includes('Pending: Pending unverified'), 'no answerability proof is stated as unverified')
  assert.ok(peek.includes('Back [Esc]'), 'the Peek advertises its own exit')
  assert.ok(!/Allow|Deny|Reject|Answer/.test(peek), `Peek carries no answer form:\n${peek}`)
  assert.deepEqual(h.resumes, [], 'opening Peek never resumes or writes anything')
  assert.deepEqual(h.queries, [], 'opening Peek never edits the search')

  h.vt.sendInput('\x1b')
  await h.paint()
  const restored = h.view()
  assert.ok(restored.includes('Up/Down move'), 'Esc returns to the browse list')
  assert.ok(/^> .*Other session/m.test(restored), `the Peek returns to the SAME selected row:\n${restored}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter from Peek is the ONE re-proved resume intent')
})

test('all official Workspace folders, including empty and Unassigned, stay in one browse tree', async () => {
  const h = harness({ columns: 100, rows: 24, initialBrowseScope: 'current', onAddDirectory: () => {} })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 4_000, { title: 'Current session' }), row(OTHER, 3_000, { title: 'Other session' }), row(THIRD, 2_000, { title: 'Cold session' })],
  }))
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
      { workspaceId: 'ws-empty', path: '/ws/empty', title: 'Empty', sessionIds: [] },
    ],
  })
  await h.paint()
  const view = h.view()
  for (const label of ['Add directory', 'Alpha', 'Beta', 'Empty', 'Unassigned']) {
    assert.ok(view.includes(label), `the same browse tree lists ${label}:\n${view}`)
  }
  assert.ok(view.indexOf('Alpha') < view.indexOf('Beta'), 'the current Workspace is first')
  assert.ok(!view.includes('Workspace scope:'), 'there is no secondary scope selector')
})

test('duplicate Workspace titles are disambiguated by the official id, never guessed from a path', async () => {
  const h = harness({ columns: 120, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-duplicate-one', path: '/ws/one', title: 'Same title', sessionIds: [CURRENT] },
      { workspaceId: 'ws-duplicate-two', path: '/ws/two', title: 'Same title', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const view = h.view()
  const folders = view.split('\n').filter(line => /[▾▸] Same title/.test(line))
  assert.equal(folders.length, 2, `both same-title Workspaces are listed:\n${view}`)
  assert.ok(folders.some(line => line.includes('Same title (one)')), `a duplicated Host title is disambiguated:\n${view}`)
  assert.ok(folders.some(line => line.includes('Same title (two)')), `each duplicate keeps its own label:\n${view}`)
})

test('the wide layout paints the read-only preview beside the list; a narrow one stays single-column', async () => {
  const h = harness({ columns: 120, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' })],
    answerEligibility: [],
  })
  await h.paint()
  const wide = panelFrame(h).join('\n')
  assert.ok(wide.includes('Space for read-only details'), `the wide layout paints a preview pane:\n${wide}`)
  assert.ok(wide.includes('Sessions · 2'), 'the list pane stays beside the preview')
  h.vt.resize(80, 24)
  await h.paint()
  assert.ok(!panelFrame(h).join('\n').includes('Space for read-only details'),
    'a narrow terminal never splits into two columns')
  // A short narrow frame still opens Peek and keeps its ONE Esc exit usable.
  h.vt.resize(80, 10)
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const short = h.view()
  assert.ok(short.includes('Peek ·'), `Peek opens on a short terminal:\n${short}`)
  const frame = panelFrame(h)
  assert.ok(frame[frame.length - 1]!.includes('Esc'), 'the Esc action stays the last physical row')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(h.view().includes('Sessions ·'), 'Esc leaves Peek even at 80x10')
  assert.deepEqual(h.resumes, [], 'no invisible row was activated while Peek was open')
})

test('a mouse click only SELECTS a painted row; a repaint between press and release drops the gesture', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact(OTHER, { running: false, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [],
  })
  await h.paint()
  const frame = panelFrame(h)
  const otherLine = lineIndexOf(frame, 'Other session')
  await clickCell(h, 3, otherLine)
  const clicked = h.view()
  assert.ok(/^> .*Other session/m.test(clicked), `clicking a row selects it:\n${clicked}`)
  assert.deepEqual(h.resumes, [], 'a click never implies Enter / Resume')
  // Back to the first row, then a CONTENT change between the press and the
  // release: the official order flips, so the pressed cell now holds a
  // DIFFERENT row. The release must not act on that cell.
  const firstLine = lineIndexOf(panelFrame(h), 'Current session')
  await clickCell(h, 3, firstLine)
  assert.ok(/^> .*Current session/m.test(h.view()), 'the second click selects the first row')
  h.vt.sendInput(`\x1b[<0;3;${otherLine + 1}M`)
  await h.paint()
  // The official roster drops the pressed row between the press and the
  // release: the cell no longer holds the target the user pressed.
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' })] }))
  await h.paint()
  const repainted = panelFrame(h)
  assert.ok(!repainted.some(line => line.includes('Other session')),
    `the pressed row is gone from the new frame:\n${repainted.join('\n')}`)
  h.vt.sendInput(`\x1b[<0;3;${otherLine + 1}m`)
  await h.paint()
  assert.ok(/^> .*Current session/m.test(h.view()),
    'a content change between press and release drops the click instead of selecting whatever moved under the cell')
  assert.deepEqual(h.resumes, [], 'the dropped gesture never resumes a Session')
})

test('the Workspace header exposes only Search while attention stays on its Session row', async () => {
  const h = harness({ columns: 120, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] }],
  })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact(OTHER),
    ],
    answerEligibility: [eligibility(OTHER)],
  })
  await h.paint()
  const frame = panelFrame(h)
  assert.ok(frame.join('\n').includes('Needs attention'), `a proved outside Workspace need stays in its own visible row:\n${frame.join('\n')}`)
  const header = frame[0]!
  assert.ok(!header.includes('[w]'))
  await clickCell(h, header.indexOf('/ Search') + 1, 0)
  assert.ok(h.view().includes('Search all workspaces'), 'the / Search header target enters global search')
})

test('an Activity sample applies immediately, including a revocation, and never moves the cursor', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact(OTHER, { running: false, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [eligibility(OTHER)],
  })
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(/^> .*Other session/m.test(h.view()), 'the second row is selected')
  // The official sample now proves a need on the SELECTED row: the label AND
  // its group membership are live immediately (a group change is a fact
  // change, never a deferred animation), and the cursor keeps its Session.
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact(OTHER),
    ],
    answerEligibility: [eligibility(OTHER)],
  })
  await h.paint()
  const proved = h.view()
  assert.ok(proved.includes('Other session  Needs attention'), `the proved need is painted at once:\n${proved}`)
  assert.ok(/^> .*Other session/m.test(proved), 'the cursor never jumps on an activity update')
  // A revocation is the same class of fact: it disappears in the SAME frame,
  // never behind a delayed group order.
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact(OTHER, { running: true, attention: 'unknown', attentionSourceState: 'unknown' }),
    ],
    answerEligibility: [],
  })
  await h.paint()
  const revoked = h.view()
  assert.ok(!revoked.includes('Needs attention'), `the revoked need never lingers:\n${revoked}`)
  assert.ok(revoked.includes('Working'), `compact rows retain the proved running state:\n${revoked}`)
  assert.ok(!revoked.includes('Pending unknown · Working'))
})

test('a Peek is pinned to its own Session and exits when that Session leaves the roster', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact(OTHER, { running: false, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [],
  })
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Peek · other-se'), 'the Peek names its own Session')
  // The refresh drops the peeked Session and re-anchors the list selection: the
  // Peek must exit instead of silently showing the next selected Session.
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' })] }))
  await h.paint()
  const view = h.view()
  assert.ok(!view.includes('Peek ·'), `the Peek exits when its target is gone:\n${view}`)
  assert.ok(!view.includes('Other session'), 'the removed Session never paints')
  assert.ok(/^> .*Current session/m.test(view), 'the list selection re-anchored on a listed row')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'the Peek exit never resumes any Session')
})

test('a Peek opened from search results also exits when its target leaves the results', async () => {
  const h = harness({ columns: 100, rows: 24, initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [{ row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle' }],
  }), 'needle')
  await h.paint()
  h.vt.sendInput('\r') // editor -> results
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Peek · other-se'))
  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: [] }))
  await h.paint()
  assert.ok(!h.view().includes('Peek ·'), `the Peek exits when the result is gone:\n${h.view()}`)
  assert.ok(h.view().includes('Search all workspaces'), 'the search editor owns the keyboard again')
})

test('the workspace header has no w hit target and Search retains its real hit target', async () => {
  const h = harness({ columns: 60, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [{
      workspaceId: 'ws-long',
      path: '/ws/long',
      // 60 columns: a long Workspace label competes with the trailing Search
      // hint, so the hint starts inside the painted row while the header keeps
      // its single current-membership annotation.
      title: 'Long workspace name pushing hint off row',
      sessionIds: [CURRENT],
    }],
  })
  await h.paint()
  const header = panelFrame(h)[0]!
  assert.ok(header.includes('Sessions · 2'), `the ONE header states the official count:\n${header}`)
  assert.ok(!header.includes('[w]'))
  assert.ok(header.includes('/ Search'))
  await clickCell(h, header.indexOf('/ Search') + 1, 0)
  assert.ok(h.view().includes('Search all workspaces'), 'the Search target enters global search')
})

test('compact Working rows omit unknown pending spam while Peek preserves the source state', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [
      row('session-denied', 3_000, { title: 'Denied row' }),
      row('session-unknown', 2_000, { title: 'Unknown row' }),
      row('session-unavailable', 1_000, { title: 'Unavailable row' }),
    ],
  }))
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact('session-denied', { running: true, attention: 'unknown', attentionSourceState: 'denied' }),
      fact('session-unknown', { running: true, attention: 'unknown', attentionSourceState: 'unknown' }),
      fact('session-unavailable', { running: true, attention: 'unknown', attentionSourceState: 'unavailable' }),
    ],
    answerEligibility: [],
  })
  await h.paint()
  const view = h.view()
  assert.equal(view.split('Working · ').length - 1, 3, `all three running rows retain the Working summary:\n${view}`)
  assert.ok(!view.includes('Pending denied') && !view.includes('Pending unknown') && !view.includes('Pending unavailable'),
    `compact rows do not repeat unknown/unanswerable pending state:\n${view}`)
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const peek = h.view()
  assert.ok(peek.includes('Pending: Pending denied') || peek.includes('Pending: Pending unknown') || peek.includes('Pending: Pending unavailable'),
    `read-only details preserve the authoritative pending source state:\n${peek}`)
})

test('the read-only Peek names the official Workspace title for a unique folder', async () => {
  const h = harness({ columns: 120, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-beta', path: '/ws/beta', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  // Beta has no confirmed activity, so its Folder starts collapsed: Tab jumps
  // to it from the current Session's own Folder, Right expands it, then two
  // Down presses reach its Session row.
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(/^> .*Beta/m.test(h.view()), `the first Tab lands on the next Folder:\n${h.view()}`)
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const peek = h.view()
  assert.ok(peek.includes('Workspace: Beta'),
    `the Peek keeps the official Workspace identity beside the Host title:\n${peek}`)
  assert.ok(peek.includes('Running: Unknown'), 'a missing Activity sample is stated, not guessed')
})

test('Host titles that sanitize identically use distinct Host path-tail Folder labels', async () => {
  const h = harness({ columns: 120, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      // The raw titles differ, but the visible one-physical-row text is the
      // same: a duplicated VISIBLE label needs the official id.
      { workspaceId: 'ws-collision-one', path: '/ws/1', title: 'Alpha\u001b[31m', sessionIds: [CURRENT] },
      { workspaceId: 'ws-collision-two', path: '/ws/2', title: 'Alpha', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const options = h.view().split('\n').filter(line => /[▾▸] Alpha/.test(line))
  assert.equal(options.length, 2, `both colliding Workspaces are listed:\n${h.view()}`)
  assert.ok(options.every(line => /Alpha \((1|2)\)/u.test(line)),
    `a collision after sanitization carries a unique Host path tail:\n${options.join('\n')}`)
})

test('same-title Workspaces use unique Host path tails in Folder rows and Peek', async () => {
  const h = harness({ columns: 160, rows: 30 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'workspace-abcdef-1', path: '/ws/1', title: 'Shared', sessionIds: [CURRENT] },
      { workspaceId: 'workspace-abcdef-2', path: '/ws/2', title: 'Shared', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const options = h.view().split('\n').filter(line => /[▾▸] Shared/.test(line))
  assert.equal(options.length, 2, `both same-title Workspaces are listed:\n${h.view()}`)
  assert.ok(options.some(line => line.includes('Shared (1)')), options.join('\n'))
  assert.ok(options.some(line => line.includes('Shared (2)')), options.join('\n'))
  const folderLines = panelFrame(h).map((line, index) => ({ line, index })).filter(item => item.line.includes('Shared (2)'))
  assert.equal(folderLines.length, 1)
  await clickCell(h, folderLines[0]!.line.indexOf('Shared (2)') + 1, folderLines[0]!.index)
  h.vt.sendInput(' ')
  await h.paint()
  const peek = h.view()
  assert.ok(peek.includes('Shared (2)'),
    `the Peek retains the distinct official Workspace path tail:\n${peek}`)
})

// ── PR2: Workspace tree UX ───────────────────────────────────────────────

test('Tab/Shift+Tab hop between Folder TITLES and never enter a hidden action ring', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-tab-history-${index}`, 9_000 - index, { title: `Tab history ${index}` }))
  const h = harness({ columns: 100, rows: 30, onAddDirectory: () => {} })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 10_000, { title: 'Current session' }), ...history],
  }))
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [] },
      { workspaceId: 'ws-c', path: '/ws/c', title: 'Gamma', sessionIds: [] },
    ],
  })
  await h.paint()
  // Home lands on the root Add row; three Down presses reach an ordinary Session
  // row inside the Folder, which is the starting point for Tab.
  h.vt.sendInput('\x1b[H') // root Add
  await h.paint()
  for (let step = 0; step < 3; step += 1) {
    h.vt.sendInput('\x1b[B')
    await h.paint()
  }
  assert.ok(/^> .*Tab history/m.test(h.view()), `the cursor sits on a Session row inside the Folder:\n${h.view()}`)
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(/^> .*Beta/m.test(h.view()), `one Tab lands on the next Folder title:\n${h.view()}`)
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(/^> .*Gamma/m.test(h.view()), 'Tab wraps to the next Folder')
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(/^> .*Alpha/m.test(h.view()), 'Tab cycles back to the first Folder')
  h.vt.sendInput('\x1b[Z') // Shift+Tab
  await h.paint()
  assert.ok(/^> .*Gamma/m.test(h.view()), 'Shift+Tab reverses around the Folder ring')
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(/^> .*Alpha/m.test(h.view()), 'Tab from Add starts at the first Folder')
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\x1b[Z')
  await h.paint()
  assert.ok(/^> .*Gamma/m.test(h.view()), 'Shift+Tab from Add starts at the last Folder')
  const view = h.view()
  assert.ok(!view.includes('Tab actions'), 'no hidden Actions focus or footer verb exists')
  assert.deepEqual(h.resumes, [], 'Folder navigation never resumes a Session')
  assert.deepEqual(h.queries, [], 'Folder navigation never mints a query')
})

test('one Folder keeps Tab on itself and no Folder is a no-op', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-only', path: '/ws', title: 'Only', sessionIds: [CURRENT, OTHER] }] })
  await h.paint()
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(/^> .*Only/m.test(h.view()), 'Tab on the only Folder stays on it')
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(/^> .*Only/m.test(h.view()), 'the Folder ring of one does not move')
  h.app.dispose()
  started.delete(h.app)

  const flat = harness({ columns: 100, rows: 24 })
  flat.handle.setSnapshot(snapshot())
  await flat.paint()
  flat.vt.sendInput('\t')
  await flat.paint()
  assert.ok(/^> {3}● current-/m.test(flat.view()), 'with no Folder, Tab is a no-op on the flat roster')
})

test('root Add, official first-child New, synthetic exclusion and explicit mouse actions', async () => {
  const requested: string[] = []
  const h = harness({
    columns: 110,
    rows: 30,
    onAddDirectory: () => {},
    onNewSession: (workspaceId, settle) => {
      requested.push(workspaceId)
      settle?.({ kind: 'not-committed' })
    },
  })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Add directory'), `the root Add row paints:\n${view}`)
  assert.ok(view.includes('+ New session'), 'the expanded current Folder paints its first-child New row')
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Host directory:'), 'Home + Enter opens the inline Add editor')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(h.closes, 0, 'cancelling the Add editor returns to the tree')
  // New via the keyboard: Tab selects the Folder, Right enters its first child.
  h.vt.sendInput('\t')
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  assert.ok(/^>   \+ New session/m.test(h.view()), `Right enters the New row:\n${h.view()}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-a'], 'Enter on New hands the official WorkspaceId to the command owner')
  // New via the mouse: one press/release on the same painted row (the fake
  // owner settled the first operation above).
  const newLine = lineIndexOf(panelFrame(h), '+ New session')
  await clickCell(h, 6, newLine)
  assert.deepEqual(requested, ['ws-a', 'ws-a'], 'a painted New click runs the same explicit action')
  // Collapsing the Folder removes New; the synthetic group never grows one.
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\t')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(!h.view().includes('+ New session'), `a collapsed Folder hides New:\n${h.view()}`)
  h.handle.updateWorkspaces({
    type: 'replace',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
})

test('Show more advances by five without resetting the tree to the top', async () => {
  const history = Array.from({ length: 20 }, (_, index) => row(`session-more-${index}`, 900 - index, { title: `History ${index}` }))
  // A 14-row frame leaves the default-expanded Beta at its five manual rows and
  // keeps its Show-more row inside the real list budget.
  const h = harness({ columns: 100, rows: 14 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: history.map(item => item.id) },
  ] })
  await h.paint()
  // Beta is not current: Tab jumps to it, Right expands it with five ordinary
  // history rows, then six Down presses reach the Show-more watermark.
  h.vt.sendInput('\t')
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  for (let step = 0; step < 7; step += 1) {
    h.vt.sendInput('\x1b[B')
    await h.paint()
  }
  const before = h.view()
  assert.ok(before.includes('Show more sessions'), `the watermark row is reachable:\n${before}`)
  assert.ok(/^> .*Show more sessions/m.test(before), 'the cursor reaches the Show-more row')
  h.vt.sendInput('\r')
  await h.paint()
  const after = h.view()
  assert.ok(after.includes('History 9'), `Show more reveals five ordinary rows:\n${after}`)
  assert.ok(!after.includes('History 10'), 'the reveal is bounded to the next five rows')
  assert.ok(/^> .*Show more sessions/m.test(after), 'the cursor stays on the reveal target instead of jumping to the top')
})

test('the Sessionless chooser chooses an existing Folder without creating a Session', async () => {
  const used: Array<[string, string]> = []
  const requested: string[] = []
  const h = harness({
    columns: 100,
    rows: 24,
    currentSessionId: null,
    initialDirectoryChooser: true,
    onAddDirectory: () => {},
    onNewSession: (workspaceId) => { requested.push(workspaceId) },
    onUseDirectory: (workspaceId, canonicalPath) => { used.push([workspaceId, canonicalPath]) },
  })
  h.handle.setSnapshot(snapshot({ rows: [row(OTHER, 2_000, { title: 'Other session' })] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [OTHER] }] })
  await h.paint()
  assert.ok(h.view().includes('Choose workspace'), 'the chooser has its own title')
  assert.ok(!h.view().includes('+ New session'), 'the chooser never paints a create action')
  assert.ok(!h.view().includes('Use directory'), 'the retired Use-directory row does not return')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(used, [['ws-a', '/ws/a']], 'Folder Enter commits the existing official Workspace')
  assert.deepEqual(requested, [], 'choosing a Folder never creates a Session')
  assert.equal(h.closes, 1, 'the chooser returns to the Welcome exactly once')
})

test('chooser Right/Left and disclosure only browse; the label click is the choose action', async () => {
  const used: Array<[string, string]> = []
  const make = (): Harness => {
    const h = harness({
      columns: 100,
      rows: 24,
      currentSessionId: null,
      initialDirectoryChooser: true,
      onUseDirectory: (workspaceId, canonicalPath) => { used.push([workspaceId, canonicalPath]) },
    })
    h.handle.setSnapshot(snapshot({ rows: [row(OTHER, 2_000, { title: 'Other session' })] }))
    h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [OTHER] }] })
    return h
  }
  const h = make()
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  assert.ok(h.view().includes('Other session'), 'Right expands the Folder')
  assert.deepEqual(used, [], 'Right never chooses the Workspace')
  h.vt.sendInput('\x1b[D')
  await h.paint()
  assert.ok(!h.view().includes('Other session'), 'Left collapses the Folder')
  assert.deepEqual(used, [], 'Left never chooses the Workspace')
  const frame = panelFrame(h)
  const folderLine = lineIndexOf(frame, 'Alpha')
  await clickCell(h, 2, folderLine)
  assert.ok(h.view().includes('Other session'), 'the disclosure toggles without choosing')
  assert.deepEqual(used, [], 'the disclosure is not the Folder label')
  const labelLine = lineIndexOf(panelFrame(h), 'Alpha')
  await clickCell(h, 8, labelLine)
  assert.deepEqual(used, [['ws-a', '/ws/a']], 'a click on the Folder label chooses the existing Workspace')
  assert.equal(h.closes, 1)
  h.app.dispose()
  started.delete(h.app)

  // The ordinary Browser never turns Folder Enter into a choose write.
  const plainUsed: Array<[string, string]> = []
  const browse = harness({
    columns: 100,
    rows: 24,
    currentSessionId: null,
    onUseDirectory: (workspaceId, canonicalPath) => { plainUsed.push([workspaceId, canonicalPath]) },
  })
  browse.handle.setSnapshot(snapshot({ rows: [row(OTHER, 2_000, { title: 'Other session' })] }))
  browse.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [OTHER] }] })
  await browse.paint()
  browse.vt.sendInput('\r')
  await browse.paint()
  assert.ok(browse.view().includes('Other session'), 'a plain Folder Enter expands it')
  assert.deepEqual(plainUsed, [], 'a plain Folder Enter never writes the choose intent')
})

test('the typed selection drives Preview, Enter and Space; Folder selection never keeps a stale Session Peek', async () => {
  const h = harness({ columns: 120, rows: 30, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  // Click Beta's Folder label: selection and preview are the Folder.
  const betaLine = folderLineIndexOf(panelFrame(h), 'Beta')
  await clickCell(h, 8, betaLine)
  let view = h.view()
  assert.ok(/^> .*Beta/m.test(view), `the Folder click selects it:\n${view}`)
  assert.ok(view.includes('Sessions: 1'), 'the preview follows the Folder target')
  assert.ok(!view.includes('Space for read-only details'), 'a Folder has no Session preview')
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(!h.view().includes('Peek ·'), 'Space on a Folder never opens a stale Session Peek')
  // Expand with Right, then click the Session row (the disclosure toggle has
  // its own chooser regression).
  h.vt.sendInput('\x1b[C')
  await h.paint()
  const otherLine = lineIndexOf(panelFrame(h), 'Other session')
  await clickCell(h, 8, otherLine)
  view = h.view()
  assert.ok(/^> .*Other session/m.test(view), 'a Session click selects only')
  assert.ok(view.includes('Space for read-only details'), 'the preview follows the Session target')
  assert.deepEqual(h.resumes, [], 'a Session click never resumes')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter opens the selected Session')
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Peek · other-se'), 'Space peeks the selected Session')
})

test('a New-row press is dropped when the official Folder disappears before the release', async () => {
  const requested: string[] = []
  const h = harness({ columns: 110, rows: 30, onNewSession: (workspaceId) => { requested.push(workspaceId) } })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const newLine = lineIndexOf(panelFrame(h), '+ New session')
  h.vt.sendInput(`\x1b[<0;6;${newLine + 1}M`)
  await h.paint()
  // The official folder leaves between press and release.
  h.handle.updateWorkspaces({ type: 'replace', items: [{ workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] }] })
  await h.paint()
  h.vt.sendInput(`\x1b[<0;6;${newLine + 1}m`)
  await h.paint()
  assert.deepEqual(requested, [], 'the stale New press never creates a Session')
})

test('one-line header, truthful Current/Next, and a Footer of the live typed verbs', async () => {
  const h = harness({ columns: 120, rows: 30, onAddDirectory: () => {}, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Sessions · 2'))
  assert.ok(!view.includes('Current: curren'), 'no duplicate Current header')
  assert.ok(!view.includes('Workspace: All workspaces'), 'no duplicate All-workspaces header')
  assert.ok(/^[ >]*[▾▸] Alpha · 1 · Current/m.test(view), 'the official current Folder states Current')
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(/^[ >]*[▾▸] Alpha · 1 · Current/m.test(h.view()), 'a manually collapsed Folder still states Current')
  let lines = h.view().split('\n')
  assert.ok(lines[lines.length - 1]!.includes('Expand [Enter]'), 'the Footer advertises the current Enter verb')
  assert.ok(!lines[lines.length - 1]!.includes('Peek [Space]'), 'a Folder advertises no Peek')
  assert.ok(lines[lines.length - 1]!.includes('Close [Esc]'), 'Esc is always the last segment')
  // Select the Session row: Footer advertises Open + Peek; the row keeps ●.
  h.vt.sendInput('\r') // re-expand Alpha
  await h.paint()
  h.vt.sendInput('\x1b[B') // New session
  await h.paint()
  h.vt.sendInput('\x1b[B') // the current Session row
  await h.paint()
  lines = h.view().split('\n')
  assert.ok(!lines[lines.length - 1]!.includes('Open [Enter]'),
    'the opened Session never advertises the deliberate no-op Enter')
  assert.ok(lines[lines.length - 1]!.includes('Peek [Space]'), 'the opened Session still advertises its Peek')
  assert.ok(/^> ● current-/m.test(h.view()), 'Current is a row marker, not the selection')
})

  assert.ok(lines[lines.length - 1]!.includes('Space peek'), 'the opened Session still advertises its Peek')
  assert.ok(/^> {3}● current-/m.test(h.view()), 'Current is a row marker, not the selection')
  // A non-current Session advertises its real Open verb.
  h.vt.sendInput('\t') // Beta Folder
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  lines = h.view().split('\n')
  assert.ok(lines[lines.length - 1]!.includes('Open [Enter]') && lines[lines.length - 1]!.includes('Peek [Space]'),
    'a non-current Session advertises Open and Peek')
  assert.ok(/^> .*Other session/m.test(h.view()))
  h.app.dispose()
  started.delete(h.app)

  // A sessionless verified next-create destination is Next, never Current.
  const next = harness({ columns: 100, rows: 24, currentSessionId: null, currentWorkspaceId: 'ws-next', onAddDirectory: () => {} })
  next.handle.setSnapshot(snapshot({ rows: [row(OTHER, 2_000, { title: 'Other session' })] }))
  next.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-next', path: '/ws/next', title: 'Next ws', sessionIds: [OTHER] }] })
  await next.paint()
  assert.ok(/^[ >]*[▾▸] Next ws · 1 · Next/m.test(next.view()), 'the verified next destination paints Next')
  assert.ok(!next.view().includes('· Current'), 'a next-create destination is never Current')
})

test('search saves and restores the typed tree target and expansion from any row kind', async () => {
  const h = harness({ columns: 100, rows: 30, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  h.vt.sendInput('\t') // Beta Folder
  await h.paint()
  h.vt.sendInput('\x1b[C') // expand Beta
  await h.paint()
  h.vt.sendInput('\x1b[B') // New session child of Beta
  await h.paint()
  assert.ok(/^>   \+ New session/m.test(h.view()))
  h.vt.sendInput('/')
  await h.paint()
  h.vt.sendInput('needle')
  await h.paint()
  assert.deepEqual(h.queries, ['needle'], 'only a real editor change reaches the query owner')
  h.vt.sendInput('\x1b')
  await h.paint()
  const restored = h.view()
  assert.ok(restored.includes('Other session'), 'the Folder expansion survives the search round trip')
  assert.ok(/^>   \+ New session/m.test(restored), 'the same typed New target is restored, not the last Session id')
  assert.ok(!restored.includes('Search all workspaces'), 'the global-search context is gone')
})

test('Peek is pinned to a Session row, exposes its full identity, and refuses Folder targets', async () => {
  const h = harness({ columns: 120, rows: 30, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  // Folders never open a Peek.
  h.vt.sendInput('\t')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(!h.view().includes('Peek ·'), 'Space on a Folder is a no-op')
  // Open the Session Peek and read the full identity.
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const peek = h.view()
  assert.ok(peek.includes(`Session ID: ${OTHER}`), `Peek names the full sanitized Session id:\n${peek}`)
  assert.ok(peek.includes('Workspace: Beta'), 'Peek keeps the official Workspace identity')
})

test('the inline Add editor stays single-flight, keeps failures, and returns to the tree', async () => {
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const requested: string[] = []
  const submitted: string[] = []
  const h = harness({
    columns: 100,
    rows: 24,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
    onNewSession: (workspaceId) => { requested.push(workspaceId) },
  })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] }] })
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  h.vt.sendInput('/host/new')
  await h.paint()
  h.vt.sendInput('\t') // Tab must never jump the Workspace ring while editing
  await h.paint()
  assert.ok(h.view().includes('Host directory: /host/new'), 'Tab is inert inside the path editor')
  h.vt.sendInput('\r')
  await h.paint()
  h.vt.sendInput('\r') // pending double Enter
  await h.paint()
  assert.deepEqual(submitted, ['/host/new'], 'one path request stays single-flight')
  outcomes[0]!({ kind: 'failed', message: 'not a directory on Host' })
  await h.paint()
  assert.ok(h.view().includes('/host/new'), 'a failure keeps the attempted path')
  assert.ok(h.view().includes('not a directory on Host'))
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(h.closes, 0, 'Esc leaves the editor but never closes the Browser')
  assert.ok(!h.view().includes('Host directory:'), 'the tree is back')
  // A successful ordinary Add returns to the tree and never creates a Session.
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  h.vt.sendInput('/host/added')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  outcomes[1]!({ kind: 'registered', workspaceId: 'ws-added', path: '/host/added' })
  await h.paint()
  assert.ok(!h.view().includes('Host directory:'), 'a registered directory returns to the tree')
  assert.deepEqual(requested, [], 'registering a directory never creates a Session')
})

test('CJK titles and long Host ids keep every action reachable at the frozen sizes', async () => {
  const cjkTitle = '会话管理：非常长的中文标题用于验证裁剪不会破坏布局'
  const longId = 'session-cjk-0123456789abcdefghijklmnopqrstuvwxyz'
  const h = harness({ columns: 80, rows: 24, onAddDirectory: () => {} })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: '当前会话' }), row(longId, 2_000, { title: cjkTitle })],
  }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-cjk', path: '/工作区/目录', title: '工作区', sessionIds: [CURRENT, longId] }] })
  await h.paint()
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [80, 3], [72, 24], [44, 20]] as const) {
    h.vt.resize(columns, rows)
    await h.paint()
    const painted = h.app.focusedComponentForTest()!.render(columns)
    assert.ok(painted.length <= rows, `${columns}x${rows}: the frame fits its budget`)
    assert.ok(stripTerminalSequences(painted[painted.length - 1]!).includes('Esc'), `${columns}x${rows}: Esc survives CJK`)
    for (const line of painted) {
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows}: CJK never overflows: ${JSON.stringify(line)}`)
    }
  }
})

test('a short frame advertises only actions the painted body can really run', async () => {
  // 80x3 with a status line: the status owns the single body row, so NO tree
  // row is painted. The footer must not promise an Enter the guard rejects.
  const squeezed = harness({ columns: 80, rows: 3 })
  squeezed.handle.setSnapshot(snapshot({ projectionError: 'projection failed' }))
  await squeezed.paint()
  const squeezedFrame = panelFrame(squeezed)
  assert.equal(squeezedFrame.length, 3, 'the 3-row frame keeps header/body/action bar')
  assert.ok(!squeezedFrame.join('\n').includes('Other session'), 'the status consumed the only body row')
  const squeezedFooter = squeezedFrame[squeezedFrame.length - 1]!
  assert.ok(squeezedFooter.includes('Close [Esc]'), 'Esc survives the status-squeezed frame')
  assert.ok(!squeezedFooter.includes('[Enter]'), `no phantom Enter is advertised:\n${squeezedFooter}`)
  assert.ok(!squeezedFooter.includes('Tab/Shift+Tab'), 'no Folder ring is advertised with no painted Folder')
  assert.ok(!squeezedFooter.includes('Up/Down'), 'no movement is advertised over zero painted rows')
  squeezed.vt.sendInput('\x1b[B')
  squeezed.vt.sendInput('\r')
  await squeezed.paint()
  assert.deepEqual(squeezed.resumes, [], 'the withheld Enter can never open an unpainted row')
  squeezed.app.dispose()
  started.delete(squeezed.app)

  // The same 3-row frame WITH a painted row advertises the real verb and keeps
  // Esc last; the current Session never advertises its deliberate no-op Enter.
  const painted = harness({ columns: 80, rows: 3 })
  painted.handle.setSnapshot(snapshot())
  painted.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact(OTHER, { running: false, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [],
  })
  await painted.paint()
  let footer = panelFrame(painted)[2]!
  assert.ok(footer.includes('Peek [Space]') && !footer.includes('[Enter]'), `the current row advertises Peek only:\n${footer}`)
  assert.ok(footer.includes('Close [Esc]'))
  painted.vt.sendInput('\x1b[B')
  await painted.paint()
  footer = panelFrame(painted)[2]!
  assert.ok(footer.includes('Open [Enter]'), `the painted non-current row advertises Open:\n${footer}`)
  assert.ok(footer.includes('Close [Esc]'), 'Esc stays the last segment')
  painted.vt.sendInput('\r')
  await painted.paint()
  assert.deepEqual(painted.resumes, [OTHER], 'the advertised Open is admitted by the same frame')
})

test('Folder New is locked by ONE per-operation settlement, never by a notice', async () => {
  const requested: string[] = []
  const settles: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void> = []
  const h = harness({
    columns: 120,
    rows: 30,
    onNewSession: (workspaceId, settle) => {
      requested.push(workspaceId)
      assert.ok(settle !== undefined, 'production supplies the per-operation settle callback')
      settles.push(settle)
    },
  })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-a'], 'the first New dispatch reaches the command owner')
  assert.ok(h.view().includes('Starting session…'), 'the pending state is visible')
  const pendingFooter = () => panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(pendingFooter().includes('Starting session…'))
  assert.ok(!pendingFooter().includes('Enter New session'))

  // B5.1/B5.2: an unrelated notice, its expiry, and a changed notice NEVER
  // settle the operation. Only the operation's own callback may do that.
  h.app.notify('an unrelated info notice', 'info')
  await h.paint()
  h.app.notify('an unrelated error notice', 'error')
  await h.paint()
  h.app.clearNotify()
  await h.paint()
  assert.ok(h.view().includes('Starting session…'), 'no notice transition settles the New operation')
  h.vt.sendInput('\r')
  await h.paint()
  const newLine = lineIndexOf(panelFrame(h), '+ New session')
  await clickCell(h, 6, newLine)
  assert.deepEqual(requested, ['ws-a'], 'notification changes never unlock a pending New')

  // B5.3: the SAME repeated failure settles each operation independently; a
  // third deliberate retry is admitted.
  settles[0]!({ kind: 'failed', message: 'fresh session creation failed: refused' })
  await h.paint()
  assert.ok(!h.view().includes('Starting session…'), 'the explicit failure settles the pending operation')
  // Show the identical failure notice while the next operation starts: the
  // notice is presentation only and must never unlock or lock the operation.
  h.app.notify('fresh session creation failed: refused', 'error')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-a', 'ws-a'], 'a failed New can be retried while its old notice is live')
  assert.ok(h.view().includes('Starting session…'), 'the identical live notice never settles the new operation')
  settles[1]!({ kind: 'failed', message: 'fresh session creation failed: refused' })
  await h.paint()
  assert.ok(!h.view().includes('Starting session…'), 'an identical repeated failure still settles')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-a', 'ws-a', 'ws-a'], 'a third deliberate retry is admitted')
  assert.equal(settles.length, 3)

  // B5.4: a late callback from operation A must not unlock operation C.
  settles[0]!({ kind: 'failed', message: 'late duplicate' })
  await h.paint()
  assert.ok(h.view().includes('Starting session…'), 'a stale callback from A never clears C')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-a', 'ws-a', 'ws-a'], 'the stale callback cannot unlock a retry')

  // B5.5: while C is pending, New on a DIFFERENT Workspace is ignored too.
  h.vt.sendInput('\t') // Beta Folder (navigation is still allowed)
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(/^>   \+ New session/m.test(h.view()), `the cursor reaches Beta's New row:\n${h.view()}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-a', 'ws-a', 'ws-a'], 'a different Workspace New is ignored while one is pending')
  settles[2]!({ kind: 'cancelled' })
  await h.paint()
  assert.ok(!h.view().includes('Starting session…'), 'cancellation releases the pending lock')
})

test('a completed Folder New unlocks a fresh pending object for the next operation', async () => {
  const requested: string[] = []
  const settles: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void> = []
  const h = harness({
    columns: 120,
    rows: 30,
    onNewSession: (workspaceId, settle) => {
      requested.push(workspaceId)
      settles.push(settle!)
    },
  })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] }] })
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  settles[0]!({ kind: 'committed' })
  await h.paint()
  assert.ok(!h.view().includes('Starting session…'), 'committed settles the same operation')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(requested, ['ws-a', 'ws-a'], 'committed does not wedge the next Folder New')
})

test('official reorder keeps the typed Folder and removal re-anchors on its neighbor', async () => {
  const h = harness({ columns: 120, rows: 30 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
      { workspaceId: 'ws-c', path: '/ws/c', title: 'Gamma', sessionIds: [] },
    ],
  })
  await h.paint()
  h.vt.sendInput('\t') // from the current Session's Alpha -> Beta
  await h.paint()
  assert.ok(/^> .*Beta/m.test(h.view()))
  // An official order frame never steals a typed selection.
  h.handle.updateWorkspaces({ type: 'order', workspaceIds: ['ws-c', 'ws-b', 'ws-a'] })
  await h.paint()
  assert.ok(/^> .*Beta/m.test(h.view()), `the same Folder row id survives the reorder:\n${h.view()}`)
  // The selected Folder is removed: re-anchor on the nearest surviving Folder,
  // never on Current and never on no selection.
  h.handle.updateWorkspaces({ type: 'remove', workspaceId: 'ws-b' })
  await h.paint()
  assert.ok(/^> .*Gamma/m.test(h.view()), `the removed Folder re-anchors on its neighbor:\n${h.view()}`)
  assert.ok(h.view().includes('Sessions: 0'), `the Preview follows the re-anchored Folder target:\n${h.view()}`)
})

test('a synchronous owner close from New/Choose leaves no stale panel write', async () => {
  const h = harness({
    columns: 110,
    rows: 30,
    onNewSession: () => { h.handle.close() },
  })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] }] })
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.equal(h.handle.isDisposed(), true, 'the owner-origin close disposes the same open')
  assert.equal(h.app.isFullscreen(), false, 'no stale fullscreen lease survives the callback close')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'a disposed panel can never write a later activation')
  h.app.dispose()
  started.delete(h.app)

  const chooser = harness({
    columns: 110,
    rows: 30,
    currentSessionId: null,
    initialDirectoryChooser: true,
    onUseDirectory: () => { chooser.handle.close() },
  })
  chooser.handle.setSnapshot(snapshot({ rows: [row(OTHER, 2_000, { title: 'Other session' })] }))
  chooser.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [OTHER] }] })
  await chooser.paint()
  chooser.vt.sendInput('\r')
  await chooser.paint()
  assert.equal(chooser.handle.isDisposed(), true, 'the chooser write callback may close synchronously')
  assert.equal(chooser.app.isFullscreen(), false, 'the chooser close is idempotent, never a second lease')
  assert.equal(chooser.closes, 0, 'an owner-origin close never re-enters the close notification')
})

test('a current Session search hit never advertises the deliberate no-op Enter', async () => {
  const h = harness({ columns: 100, rows: 24, initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [
      { row: row(CURRENT, 3_000, { title: 'Current session' }), source: 'Both', snippet: 'needle current' },
      { row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle other' },
    ],
  }), 'needle')
  await h.paint()
  h.vt.sendInput('\r') // editor -> first (current) result
  await h.paint()
  let footer = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(footer.includes('Peek [Space]'), `the current result still advertises Peek:\n${footer}`)
  assert.ok(!footer.includes('Open [Enter]'), `the current result never advertises its no-op Enter:\n${footer}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Enter on the current search hit is a no-op')
  h.vt.sendInput('\x1b[B') // the non-current result
  await h.paint()
  footer = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(footer.includes('Open [Enter]'), `the non-current result advertises Open:\n${footer}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'the advertised Open on a non-current result really resumes')
})

test('the current Session Peek never advertises its no-op Enter', async () => {
  const h = harness({ columns: 120, rows: 30 })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Peek · curren'), `the current Session Peek opens:\n${view}`)
  assert.ok(!view.includes('Open [Enter]') && !view.includes('Open: Enter'),
    `neither the body hint nor the footer advertises Open:\n${view}`)
  assert.ok(view.includes('Back [Esc]') && !view.includes('Space close'), 'the Peek Back stays on the ONE global bar')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Enter on the current Peek is a no-op')
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(!h.view().includes('Peek ·'), 'Space still closes the Peek')
})

test('a late settlement from a disposed open is inert for the next open', async () => {
  let settleFirst: ((outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void) | undefined
  const h = harness({
    columns: 120,
    rows: 30,
    onNewSession: (_workspaceId, settle) => { settleFirst = settle },
  })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] }] })
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Starting session…'))
  h.handle.close()
  await h.paint()
  assert.equal(h.handle.isDisposed(), true)
  const second = h.app.openSessionWorkspace({
    subject: { currentSessionId: CURRENT, currentCwd: '/ws/project', isCurrent: () => true },
    onQueryChange: () => {},
    onResume: () => {},
    onNewSession: () => {},
    onClose: () => {},
    initialMode: 'browse',
    initialBrowseScope: 'all',
  })
  second.setSnapshot(snapshot({ rows: [row(THIRD, 1_000, { title: 'Newer workspace' })] }))
  await h.paint()
  settleFirst!({ kind: 'failed', message: 'late settlement from the closed open' })
  await h.paint()
  assert.ok(h.view().includes('Newer workspace'), 'the closed open never repaints the newer Browser')
  assert.ok(!h.view().includes('Starting session…'), 'the late settlement never mutates the newer Browser pending state')
  second.close()
})

test('the inline Host path editor and the global search never coexist', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 120,
    rows: 30,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  h.vt.sendInput('/host/add')
  await h.paint()
  const editing = panelFrame(h)
  assert.ok(editing[0]!.includes('Sessions'), 'the header still names the workspace')
  assert.ok(!editing[0]!.includes('/ Search'), 'the Search target is not painted while the path editor owns the keyboard')
  assert.ok(h.view().includes('Host directory: /host/add'), 'the inline editor stays visible')
  assert.ok(!h.view().includes('Enter Add directory'), 'the Preview does not advertise the already-open Add verb')
  assert.ok(h.view().includes('Enter Verify directory · Esc Cancel'), 'the Preview states the editor verbs')
  // The old header cell is now inert: it can never enter a search presentation
  // behind the editor.
  await clickCell(h, editing[0]!.indexOf('Search') < 0 ? 110 : editing[0]!.indexOf('Search') + 1, 0)
  assert.ok(!h.view().includes('Search all workspaces'), 'a header click cannot enter search while editing')
  assert.ok(h.view().includes('Host directory: /host/add'), 'the editor remains the visible keyboard owner')
  // Enter still submits the VISIBLE path editor exactly once.
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/host/add'], 'Enter submits the path editor once, never a hidden search action')
  outcomes[0]!({ kind: 'failed', message: 'not a directory on Host' })
  await h.paint()
  assert.ok(h.view().includes('/host/add'), 'the rejection keeps the attempted path')
  // Esc cancels the editor back to the tree and never closes the Browser.
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(h.closes, 0)
  assert.ok(!h.view().includes('Host directory:'), 'the tree is back')
  assert.ok(!h.view().includes('Search all workspaces'), 'no search presentation was created behind the editor')
})

test('the Footer suppresses session actions while a resume is pending', async () => {
  const browse = harness({ columns: 120, rows: 30 })
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  browse.vt.sendInput('\x1b[B')
  await browse.paint()
  browse.handle.setSnapshot(snapshot({ resumePending: true }))
  await browse.paint()
  let footer = panelFrame(browse)[panelFrame(browse).length - 1]!
  assert.ok(browse.view().includes('Opening session…'), 'the pending fact is painted')
  assert.ok(!footer.includes('Open [Enter]') && !footer.includes('Peek [Space]'),
    `no blocked session action is advertised while pending:\n${footer}`)
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  footer = panelFrame(browse)[panelFrame(browse).length - 1]!
  assert.ok(footer.includes('Open [Enter]') && footer.includes('Peek [Space]'),
    'the actions return when the resume settles')
  browse.app.dispose()
  started.delete(browse.app)

  const results = harness({ columns: 100, rows: 24, initialMode: 'search' })
  const searchSnapshot = snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [{ row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle' }],
  })
  results.handle.setSnapshot(searchSnapshot, 'needle')
  await results.paint()
  results.vt.sendInput('\r')
  await results.paint()
  results.handle.setSnapshot({ ...searchSnapshot, resumePending: true })
  await results.paint()
  footer = panelFrame(results)[panelFrame(results).length - 1]!
  assert.ok(!footer.includes('Open [Enter]') && !footer.includes('Peek [Space]'),
    `search results advertise no blocked action while pending:\n${footer}`)
  results.handle.setSnapshot(searchSnapshot)
  await results.paint()
  footer = panelFrame(results)[panelFrame(results).length - 1]!
  assert.ok(footer.includes('Open [Enter]') && footer.includes('Peek [Space]'), 'search actions return after settlement')
  results.app.dispose()
  started.delete(results.app)

  const peek = harness({ columns: 120, rows: 30 })
  peek.handle.setSnapshot(snapshot())
  await peek.paint()
  peek.vt.sendInput('\x1b[B')
  await peek.paint()
  peek.vt.sendInput(' ')
  await peek.paint()
  peek.handle.setSnapshot(snapshot({ resumePending: true }))
  await peek.paint()
  footer = panelFrame(peek)[panelFrame(peek).length - 1]!
  assert.ok(!footer.includes('Open [Enter]'), `Peek advertises no blocked Open while pending:\n${footer}`)
  assert.ok(footer.includes('Back [Esc]') && !footer.includes('Space close'), 'the Peek exits stay on the ONE global bar')
  peek.handle.setSnapshot(snapshot())
  await peek.paint()
  footer = panelFrame(peek)[panelFrame(peek).length - 1]!
  assert.ok(footer.includes('Open [Enter]'), 'the Peek Open cue returns after settlement')
})

test('an initial search open with the path editor keeps only the path editor', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 100,
    rows: 24,
    initialMode: 'search',
    initialDirectoryEntry: true,
    initialDirectoryPath: '/launch/failed',
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  await h.paint()
  const frame = panelFrame(h)
  assert.ok(h.view().includes('Host directory: /launch/failed'), 'the path editor is the ONE keyboard owner')
  assert.ok(!h.view().includes('Search all workspaces'), 'no search context is painted behind the editor')
  assert.ok(!h.view().includes('Search: '), 'the raw search editor is not painted behind the path editor')
  assert.ok(!frame[0]!.includes('/ Search'), 'the header has no Search target while the editor is open')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/launch/failed'], 'Enter submits the visible path editor once')
  outcomes[0]!({ kind: 'failed', message: 'not a directory on Host' })
  await h.paint()
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(h.closes, 0, 'Esc cancels the editor back to the tree, never closes the Browser')
  assert.ok(!h.view().includes('Host directory:'), 'the tree is back')
  assert.ok(!h.view().includes('Search all workspaces'), 'no search presentation survives the cancel')
})

test('missing optional capabilities paint no fake Add or New action', async () => {
  const assertTree = async (options: {
    readonly onAddDirectory?: () => void
    readonly onNewSession?: () => void
  }, expectAdd: boolean, expectNew: boolean): Promise<void> => {
    const h = harness({ columns: 120, rows: 30, ...options })
    h.handle.setSnapshot(snapshot())
    h.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] }] })
    await h.paint()
    assert.equal(h.view().includes('Add directory'), expectAdd,
      expectAdd ? 'a real Add callback paints the root Add row' : 'no Add callback paints no fake Add row')
    assert.equal(h.view().includes('+ New session'), expectNew,
      expectNew ? 'a real New callback paints the official Folder New row' : 'no New callback paints no fake New row')
    h.app.dispose()
    started.delete(h.app)
  }
  await assertTree({}, false, false)
  await assertTree({ onAddDirectory: () => {} }, true, false)
  await assertTree({ onNewSession: () => {} }, false, true)
})

test('Preview and Peek state the same pending admission as the Footer', async () => {
  const browse = harness({ columns: 120, rows: 30 })
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  browse.vt.sendInput('\x1b[B')
  await browse.paint()
  browse.handle.setSnapshot(snapshot({ resumePending: true }))
  await browse.paint()
  let view = browse.view()
  assert.ok(!view.includes('Space for read-only details'), `the Preview hides the blocked Peek cue:\n${view}`)
  assert.ok(!view.includes('Open [Enter]') && !view.includes('Peek [Space]'), 'the Footer hides both blocked verbs')
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  assert.ok(browse.view().includes('Space for read-only details'), 'the Preview cue returns after settlement')
  browse.app.dispose()
  started.delete(browse.app)

  const peek = harness({ columns: 120, rows: 30 })
  peek.handle.setSnapshot(snapshot())
  await peek.paint()
  peek.vt.sendInput('\x1b[B')
  await peek.paint()
  peek.vt.sendInput(' ')
  await peek.paint()
  peek.handle.setSnapshot(snapshot({ resumePending: true }))
  await peek.paint()
  view = peek.view()
  assert.ok(!view.includes('Open: Enter'), `the Peek body hides its blocked Open cue:\n${view}`)
  assert.ok(!view.includes('Open [Enter]'), 'the Peek bar hides the blocked Open cue')
  assert.ok(view.includes('Back [Esc]') && !view.includes('Space close'), 'the real exit stays on the ONE global bar')
  peek.handle.setSnapshot(snapshot())
  await peek.paint()
  assert.ok(!peek.view().includes('Open: Enter') && peek.view().includes('Open [Enter]'),
    'only the global bar carries the Peek Open cue after settlement')
  peek.app.dispose()
  started.delete(peek.app)

  const settles: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void> = []
  const create = harness({
    columns: 120,
    rows: 30,
    onNewSession: (_workspaceId, settle) => { settles.push(settle!) },
  })
  create.handle.setSnapshot(snapshot())
  create.handle.updateWorkspaces({ type: 'baseline', items: [{ workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] }] })
  await create.paint()
  create.vt.sendInput('\x1b[H')
  await create.paint()
  create.vt.sendInput('\x1b[B')
  await create.paint()
  create.vt.sendInput('\x1b[C')
  await create.paint()
  create.vt.sendInput('\r')
  await create.paint()
  view = create.view()
  assert.ok(view.includes('Starting session…'), `the pending fact is painted:\n${view}`)
  assert.ok(!view.includes('Enter New session'), 'the New Preview hides the already-started verb')
  settles[0]!({ kind: 'failed', message: 'refused' })
  await create.paint()
  assert.ok(create.view().includes('Enter New session'), 'the New Preview verb returns after settlement')
})

test('the pending path verification blocks mouse tree actions and inert editor verbs', async () => {
  const requested: string[] = []
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 120,
    rows: 30,
    onNewSession: (workspaceId) => { requested.push(workspaceId) },
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  h.vt.sendInput('/host/pending')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/host/pending'], 'the pending Host verification started once')
  let view = h.view()
  assert.ok(view.includes('Verifying directory…'), 'the pending verification is visible')
  assert.ok(!view.includes('Verify [Enter]') && !view.includes('Cancel [Esc]'),
    `no inert editor verb is advertised while verifying:\n${view}`)
  assert.ok(!panelFrame(h)[panelFrame(h).length - 1]!.includes('Verify [Enter]'),
    'the Footer advertises only the verifying state')
  // A REAL painted New row is still visible under the editor; clicking it must
  // not start a second operation while the Host verification pends.
  const newLine = lineIndexOf(panelFrame(h), '+ New session')
  await clickCell(h, 6, newLine)
  assert.deepEqual(requested, [], 'a mouse New activation is ignored while the path verification pends')
  // A Folder label click must not steal the selection/Preview from the editor.
  const folderLine = folderLineIndexOf(panelFrame(h), 'Beta')
  await clickCell(h, 20, folderLine)
  view = h.view()
  assert.ok(/^> Add directory/m.test(view), `the path editor keeps the cursor:\n${view}`)
  assert.ok(view.includes('Host directory: /host/pending'), 'the editor keeps its path')
  assert.ok(view.includes('Verifying directory…'), 'the pending verification is still the Preview fact')
  outcomes[0]!({ kind: 'failed', message: 'not a directory on Host' })
  await h.paint()
  view = h.view()
  assert.ok(view.includes('Enter Verify directory · Esc Cancel'), 'the editor verbs return after the refusal')
  assert.deepEqual(requested, [], 'no tree action ran during or after the pending verification')
})

test('a tiny frame never submits a Host path it did not paint', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 80,
    rows: 24,
    initialDirectoryEntry: true,
    initialDirectoryPath: '/launch/failed',
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  await h.paint()
  assert.ok(h.view().includes('Host directory: /launch/failed'), 'the retained path is first visible')
  for (const rows of [3, 4] as const) {
    h.vt.resize(80, rows)
    await h.paint()
    assert.ok(h.view().includes('Host directory: /launch/failed'),
      `${rows} rows: the editable path line is preferred over the decorative Add row`)
    assert.ok(panelFrame(h)[panelFrame(h).length - 1]!.includes('Verify [Enter]'),
      `${rows} rows: the advertised Enter belongs to the painted input`)
  }
  // No body line at all: the input is invisible, so Enter must be a no-op and
  // the Footer must not advertise it.
  h.vt.resize(80, 2)
  await h.paint()
  assert.ok(!h.view().includes('Host directory:'), 'no input row is painted at 2 rows')
  let footer = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(!footer.includes('Verify [Enter]'), `no unseen submit is advertised:\n${footer}`)
  assert.ok(footer.includes('Cancel [Esc]'), 'Esc remains available to leave the editor')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, [], 'Enter cannot submit a path the frame did not paint')
  // Restoring the body re-paints the retained input; the same Enter now submits.
  h.vt.resize(80, 3)
  await h.paint()
  assert.ok(h.view().includes('Host directory: /launch/failed'), 'the retained input returns with the body')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/launch/failed'], 'the visible input submits once')
  outcomes[0]!({ kind: 'failed', message: 'not a directory on Host' })
  await h.paint()
  assert.ok(h.view().includes('/launch/failed'), 'a refusal keeps the attempted path')
  footer = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(footer.includes('Verify [Enter]') && footer.includes('Cancel [Esc]'),
    'the editor verbs return after the refusal')
})

// ── PR3: the Host-directory inline chooser ──────────────────────────────────

test('the inline Add editor prefills the Host home, paints official candidates and Tab completes one level', async () => {
  const homeListing = hostListing('/host/home', '/host/home', [
    'project-a',
    'project-b',
    ['.config', true],
  ])
  const projectListing = hostListing('/host/home/project-b', '/host/home', ['child'])
  const listCalls: Array<string | undefined> = []
  const submitted: string[] = []
  const h = harness({
    columns: 120,
    rows: 40,
    currentSessionId: null,
    onAddDirectory: (path) => { submitted.push(path) },
    onListDirectory: async (path) => {
      listCalls.push(path)
      if (path === undefined) return readyHostLevel(homeListing)
      if (path === '/host/home/project-b/') return readyHostLevel(projectListing)
      return readyHostLevel(hostListing(path, '/host/home', []))
    },
  })
  h.handle.setSnapshot(snapshot({ rows: [] }))
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'Home suggestions resolve')
  const opened = h.view()
  assert.ok(opened.includes('Host directory: /host/home/'), `the Host home prefills the real Input:\n${opened}`)
  assert.ok(opened.includes('Suggestions (Host)'), `the Host source owns the block label:\n${opened}`)
  assert.ok(opened.includes('> project-a/'), `the first candidate is the painted active row:\n${opened}`)
  assert.ok(opened.includes('project-b/') && opened.includes('.config/'), 'every child directory is painted; hidden entries are not filtered')
  assert.ok(opened.includes('Host home: /host/home'), 'the wide preview states the official Host home')
  assert.ok(opened.includes('Host directories · read only'), 'the preview never claims a writable browser')
  assert.ok(!opened.includes('/client/home'), 'no Client directory may enter the Host suggestion projection')
  assert.deepEqual(listCalls, [undefined], 'the Home read is reused; list(home) is not issued twice')
  assert.deepEqual(submitted, [], 'browsing registers nothing')

  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\t')
  await h.paint()
  await waitUntil(() => h.view().includes('child/'), 'the accepted candidate lists its next level')
  const completed = h.view()
  assert.ok(completed.includes('Host directory: /host/home/project-b/'), 'Tab writes the official entry.path plus the Host separator')
  assert.deepEqual(listCalls, [undefined, '/host/home/project-b/'], 'the exact official path becomes the next Host level')
  assert.deepEqual(submitted, [], 'Tab is a completion, never a registration')
})

test('a Home answer arriving after a real edit keeps raw/cursor, and clearing never restores Home', async () => {
  let resolveHome!: (outcome: HostDirectoryBrowseOutcome) => void
  let resolveQuery!: (outcome: HostDirectoryBrowseOutcome) => void
  const calls: Array<string | undefined> = []
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: () => {},
    onListDirectory: (path) => {
      calls.push(path)
      return new Promise<HostDirectoryBrowseOutcome>((resolve) => {
        if (path === undefined) resolveHome = resolve
        else resolveQuery = resolve
      })
    },
  })
  await h.paint()
  h.vt.sendInput('/srv/pr')
  await h.paint()
  assert.ok(h.view().includes('/srv/pr'), 'the user can type while the Home read is pending')
  assert.deepEqual(calls, [undefined], 'no parent list is issued before the Host dialect is known')
  resolveHome(readyHostLevel(hostListing('/host/home', '/host/home', ['unrelated'])))
  await waitUntil(() => calls.length === 2, 'the Home dialect starts the latest raw query')
  assert.equal(calls[1], '/srv')
  const typed = h.view()
  assert.ok(typed.includes('Host directory: /srv/pr'), `the Home answer never rewrites real input:\n${typed}`)
  resolveQuery(readyHostLevel(hostListing('/srv', '/host/home', ['pr-one', 'other'])))
  await waitUntil(() => h.view().includes('pr-one/'), 'the prefix-filtered candidates paint')
  const filtered = h.view()
  assert.ok(filtered.includes('pr-one/') && !filtered.includes('other/'),
    `only official name prefixes match:\n${filtered}`)

  h.vt.sendInput('\u0015')
  await h.paint()
  await waitUntil(() => h.view().includes('Host directory: ') && !h.view().includes('/srv/pr'),
    'Ctrl+U clears the editor')
  const cleared = h.view()
  assert.ok(cleared.includes('Host directory: ') && !cleared.includes('/srv/pr'), `cleared input stays cleared:\n${cleared}`)
  // reason: the 150ms debounce window is the contract that must not refire.
  await new Promise<void>(resolve => { setTimeout(resolve, 220) })
  assert.ok(h.view().includes('Host directory: ') && !h.view().includes('/srv/pr'), 'no late Home initialization restores the value')
})

test('a recovered initial path outranks Home and every refusal keeps the same raw value editable', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const calls: Array<string | undefined> = []
  const h = harness({
    columns: 120,
    rows: 30,
    currentSessionId: null,
    initialDirectoryChooser: true,
    initialDirectoryEntry: true,
    initialDirectoryPath: '/launch/failed',
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
    onListDirectory: async (path) => {
      calls.push(path)
      if (path === undefined) return readyHostLevel(hostListing('/host/home', '/host/home', ['project']))
      return readyHostLevel(hostListing('/launch', '/host/home', ['failed']))
    },
  })
  await h.paint()
  await waitUntil(() => h.view().includes('Host directory: /launch/failed'), 'the retained path is painted')
  assert.equal(calls[0], undefined, 'the Host home is still read to learn the dialect')
  assert.deepEqual(calls.slice(1), ['/launch'], 'the retained path starts its own level query')
  assert.ok(!h.view().includes('Host directory: /host/home/'), 'Home never overwrites the retained path')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/launch/failed'], 'Enter verifies the raw retained path')
  outcomes[0]!({ kind: 'failed', message: 'not a directory on Host' })
  await h.paint()
  assert.ok(h.view().includes('Host directory: /launch/failed'), 'the refusal keeps the exact raw value')
  assert.ok(h.view().includes('not a directory on Host'))
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/launch/failed', '/launch/failed'], 'only an explicit second Enter issues the next Host write')
})

test('Enter is verify, Tab is completion and the first Esc only hides the painted candidates', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
    onListDirectory: async (path) => path === undefined || path === '/host/home'
      ? readyHostLevel(hostListing('/host/home', '/host/home', ['project-a', 'project-b']))
      : readyHostLevel(hostListing(path, '/host/home', ['child'])),
  })
  h.handle.setSnapshot(snapshot({ rows: [] }))
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'Home candidates paint')
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(/^  > project-b\//m.test(h.view()), `Down moves the painted selection:\n${h.view()}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/host/home/'], 'Enter verifies the raw Input, never the highlighted candidate')
  outcomes[0]!({ kind: 'failed', message: 'verification refused' })
  await h.paint()
  // A refused verification leaves the real Input editable; a new edit starts a
  // fresh suggestion generation.
  h.vt.sendInput('p')
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'the edit reopens the suggestions')
  h.vt.sendInput('\x1b')
  await h.paint()
  const hidden = h.view()
  assert.ok(hidden.includes('Host directory: /host/home/p'), 'the first Esc keeps the editor and raw value')
  assert.ok(!hidden.includes('project-a/') && !hidden.includes('project-b/'), 'the first Esc hides the suggestion block')
  assert.ok(hidden.includes('Cancel [Esc]'), 'the remaining Esc verb is the real cancel verb')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(!h.view().includes('Host directory:'), 'the second Esc returns to the tree')
  assert.equal(h.closes, 0, 'cancelling the inline editor never closes the surface')
})

test('a painted candidate click is a Tab, and an input click positions the private cursor', async () => {
  const submitted: string[] = []
  const calls: Array<string | undefined> = []
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: (path) => { submitted.push(path) },
    onListDirectory: async (path) => {
      calls.push(path)
      if (path === undefined) return readyHostLevel(hostListing('/host/home', '/host/home', ['project-a', 'project-b']))
      return readyHostLevel(hostListing(path, '/host/home', []))
    },
  })
  await h.paint()
  await waitUntil(() => h.view().includes('project-b/'), 'Home candidates paint')
  const candidateLine = lineIndexOf(panelFrame(h), 'project-b/')
  await clickCell(h, 4, candidateLine)
  await waitUntil(() => h.view().includes('Host directory: /host/home/project-b/'), 'the candidate click completes')
  assert.deepEqual(submitted, [], 'a candidate click never registers a Workspace')
  assert.equal(calls.at(-1), '/host/home/project-b/', 'the click accepts the official entry.path')

  // The Input prompt is 16 columns; clicking five cells into the value lands
  // the private cursor after the first five characters.
  const inputLine = lineIndexOf(panelFrame(h), 'Host directory:')
  await clickCell(h, 16 + 5, inputLine)
  h.vt.sendInput('X')
  await h.paint()
  assert.ok(h.view().includes('Host directory: /hostX/home/project-b/'),
    `the click-to-position contract accepts the real local cell:\n${h.view()}`)
  assert.deepEqual(submitted, [], 'editing never writes a Workspace')
})

test('a press is invalidated when the painted candidate frame changes before release', async () => {
  const submitted: string[] = []
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: (path) => { submitted.push(path) },
    onListDirectory: async (path) => path === undefined
      ? readyHostLevel(hostListing('/host/home', '/host/home', ['project-a', 'project-b']))
      : readyHostLevel(hostListing(path, '/host/home', [])),
  })
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'Home candidates paint')
  const candidateLine = lineIndexOf(panelFrame(h), 'project-a/')
  h.vt.sendInput(`\x1b[<0;4;${candidateLine + 1}M`)
  await h.paint()
  // A real selection move repaints the candidate block (new frame revision).
  h.vt.sendInput('\x1b[B')
  await h.paint()
  const beforeRelease = h.view()
  h.vt.sendInput(`\x1b[<0;4;${candidateLine + 1}m`)
  await h.paint()
  assert.ok(h.view().includes('Host directory: /host/home/'), 'the stale release does not complete a candidate')
  assert.ok(!beforeRelease.includes('Host directory: /host/home/project-a/'))
  assert.deepEqual(submitted, [], 'a rejected stale gesture performs no write')
})

test('the editor paints distinct empty, refused, unavailable, truncated and hidden states', async () => {
  const empty = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: () => {},
    onListDirectory: async () => readyHostLevel(hostListing('/host/home', '/host/home', [])),
  })
  await empty.paint()
  await waitUntil(() => empty.view().includes('No child directories'), 'the empty official level is stated')
  assert.ok(!empty.view().includes('unreachable'), 'an empty Host level is not called unreachable')
  empty.dispose()

  const refused = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    initialDirectoryPath: '/srv/missing',
    onAddDirectory: () => {},
    onListDirectory: async (path) => {
      if (path === undefined) return readyHostLevel(hostListing('/host/home', '/host/home', []))
      return { kind: 'failed', reason: 'the directory does not exist', code: 'directory-picker/unreadable' }
    },
  })
  await refused.paint()
  await waitUntil(() => refused.view().includes('Directory unreadable: the directory does not exist'),
    'the Host refusal is painted truthfully')
  refused.dispose()

  const unavailable = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: () => {},
    onListDirectory: async () => ({ kind: 'unavailable', reason: 'transport disconnected', code: 'gateway/peer-disposed' }),
  })
  await unavailable.paint()
  await waitUntil(() => unavailable.view().includes('Directory suggestions unavailable: transport disconnected'),
    'the unavailable browse surface is stated')
  assert.ok(!unavailable.view().includes('No child directories'), 'an unavailable surface never becomes an empty directory')
  unavailable.vt.sendInput('/manual/absolute')
  await unavailable.paint()
  unavailable.vt.sendInput('\r')
  await unavailable.paint()
  assert.ok(unavailable.view().includes('Host directory: /manual/absolute'),
    'manual absolute verification stays available when suggestions are unavailable')
  unavailable.dispose()

  const truncated = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: () => {},
    onListDirectory: async () => readyHostLevel(hostListing('/host/home', '/host/home', ['alpha', 'beta'], true)),
  })
  await truncated.paint()
  await waitUntil(() => truncated.view().includes('alpha/'), 'the truncated level still paints its rows')
  truncated.vt.sendInput('zzz')
  await truncated.paint()
  await waitUntil(() => truncated.view().includes('No matching child directories'), 'the filtered level states the prefix result')
  const truncatedFrame = truncated.view()
  assert.ok(truncatedFrame.includes('Directory listing truncated; type a more specific path'),
    `a truncated level never claims a complete no-match:\n${truncatedFrame}`)
  truncated.dispose()

  const hidden = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: () => {},
    onListDirectory: async () => readyHostLevel(hostListing('/host/home', '/host/home', [['.config', true]])),
  })
  await hidden.paint()
  await waitUntil(() => hidden.view().includes('.config/'), 'a hidden official child stays visible')
})

test('a pending verification owns the editor: no Tab/mouse/arrow write until the settlement returns', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
    onListDirectory: async (path) => path === undefined
      ? readyHostLevel(hostListing('/host/home', '/host/home', ['project-a', 'project-b']))
      : readyHostLevel(hostListing(path, '/host/home', [])),
  })
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'Home candidates paint')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/host/home/'])
  const pending = h.view()
  assert.ok(pending.includes('Verifying directory…'), `the pending verification is visible:\n${pending}`)
  const footer = panelFrame(h).at(-1)!
  assert.ok(footer.includes('Verifying directory') && !footer.includes('Tab Complete') && !footer.includes('Enter Verify'),
    `the footer advertises only the real pending state:\n${footer}`)
  h.vt.sendInput('\t')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/host/home/'], 'no second write may start while the first is pending')
  outcomes[0]!({ kind: 'failed', message: 'refused again' })
  await h.paint()
  assert.ok(h.view().includes('Host directory: /host/home/'), 'the settlement keeps the same raw input')
  assert.ok(h.view().includes('Verify [Enter]'), 'the explicit verbs return after the refusal')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/host/home/', '/host/home/'], 'a deliberate new Enter is the only new write')
  outcomes[1]!({ kind: 'registered', workspaceId: 'ws-new', path: '/host/home' })
  await h.paint()
  assert.ok(!h.view().includes('Host directory:'), 'a registered directory retires the inline editor')
  assert.ok(h.view().includes('Directory added: /host/home'), 'the registered fact is stated in the tree status')
})

test('tiny and narrow frames paint only executable editor verbs', async () => {
  const sizes: ReadonlyArray<{ readonly columns: number; readonly rows: number }> = [
    { columns: 80, rows: 2 },
    { columns: 80, rows: 3 },
    { columns: 80, rows: 4 },
    { columns: 80, rows: 10 },
    { columns: 44, rows: 20 },
    { columns: 80, rows: 24 },
  ]
  for (const size of sizes) {
    const submitted: string[] = []
    const h = harness({
      columns: size.columns,
      rows: size.rows,
      initialDirectoryEntry: true,
      onAddDirectory: (path) => { submitted.push(path) },
      onListDirectory: async (path) => path === undefined
        ? readyHostLevel(hostListing('/host/项目', '/host/项目', ['项目-one', '项目-two']))
        : readyHostLevel(hostListing(path, '/host/项目', [])),
    })
    await h.paint()
    const lines = panelFrame(h)
    assert.equal(lines.length, size.rows, `${size.columns}x${size.rows} keeps the exact physical height`)
    const visible = h.view()
    if (size.rows === 2) {
      assert.ok(!visible.includes('Host directory:'), '80x2 has no body row for an Input')
      assert.ok(lines.at(-1)!.includes('Cancel [Esc]'), `80x2 advertises only the real cancel:\n${lines.at(-1)}`)
      assert.ok(!lines.at(-1)!.includes('Verify [Enter]'), '80x2 never advertises an unpainted Enter')
      h.vt.sendInput('\r')
      await h.paint()
      assert.deepEqual(submitted, [], '80x2 Enter is a NO-OP')
      h.vt.sendInput('\x1b')
      await h.paint()
      assert.ok(!h.view().includes('Host directory:'))
    } else {
      assert.ok(visible.includes('Host directory: '), `${size.columns}x${size.rows} paints the real Input`)
      const footer = lines.at(-1)!
      assert.ok(!footer.includes('…'), `${size.columns}x${size.rows} action bar drops whole segments only:\n${footer}`)
      if (footer.includes('Tab Complete')) {
        assert.ok(/项目-(one|two)\//.test(visible), 'Tab Complete is advertised only when a candidate is really painted')
      }
      // Esc always reaches the tree within the two-layer ladder.
      h.vt.sendInput('\x1b')
      await h.paint()
      if (h.view().includes('Host directory:')) {
        h.vt.sendInput('\x1b')
        await h.paint()
      }
      assert.ok(!h.view().includes('Host directory:'), `${size.columns}x${size.rows} Esc always exits the editor`)
    }
    h.dispose()
  }
})

test('an absent Host browse capability keeps manual absolute verification and paints no fake suggestions', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  await h.paint()
  const opened = h.view()
  assert.ok(opened.includes('Directory suggestions unavailable: Host directory browsing is unavailable in this session.'),
    `the absent capability is an explicit unavailable state:\n${opened}`)
  assert.ok(!opened.includes('Suggestions (Host)'), 'no fake Suggestions block is painted')
  h.vt.sendInput('/srv/work')
  await h.paint()
  h.vt.sendInput('\t')
  await h.paint()
  assert.ok(h.view().includes('Host directory: /srv/work'), 'Tab is inert without a candidate')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/srv/work'], 'the manual absolute path still reaches the ONE Host resolve owner')
  outcomes[0]!({ kind: 'registered', workspaceId: 'ws-manual', path: '/srv/work' })
  await h.paint()
  assert.ok(h.view().includes('Directory added: /srv/work'))
})

test('Host-controlled path bytes never reach the terminal while the raw value stays exact', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  // A LEGAL POSIX directory name can carry ESC/OSC/LF. Both the displayed name
  // and the accepted official path must cross the single-row display policy;
  // the raw value that Enter submits must stay byte-exact.
  const maliciousName = 'evil\u001b]8;;https://evil.invalid\u0007name'
  const maliciousPath = '/host/home/evil\u001b]0;pi-tui-pr3-pwned\u0007\nnext'
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
    onListDirectory: async (path) => path === undefined
      ? readyHostLevel({
        path: '/host/home',
        home: '/host/home',
        crumbs: [],
        entries: [{ name: maliciousName, path: maliciousPath, hidden: false }],
        truncated: false,
      })
      : readyHostLevel(hostListing(path, '/host/home', [])),
  })
  await h.paint()
  await waitUntil(() => h.view().includes('evilname/'), 'the sanitized Host candidate paints')
  assert.ok(!h.raw().includes('evil.invalid'),
    'an OSC 8 hyperlink from the Host name reached the terminal output')
  assert.ok(h.view().includes('evilname/'), 'the visible text of the name survives projection')

  h.vt.sendInput('\t')
  await h.paint()
  await waitUntil(() => h.view().includes('No child directories'), 'the accepted path level is read')
  const lines = panelFrame(h)
  assert.equal(lines.length, 30, 'a line-breaking Host byte never changes the physical row count')
  assert.ok(lines.at(-1)!.includes('Verify [Enter]'),
    `the action bar is still the last physical row:\n${lines.join('\n')}`)
  assert.ok(!h.raw().includes('pi-tui-pr3-pwned'),
    'the accepted official path injected its OSC sequence into the terminal output')

  // For a value that needed projection the display caret cannot be mapped
  // exactly, so the Input click is inert: the click cannot move the raw cursor
  // and typing appends to the raw value's END.
  const inputLine = lineIndexOf(panelFrame(h), 'Host directory:')
  await clickCell(h, 20, inputLine)
  h.vt.sendInput('Z')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0], `${maliciousPath}/Z`,
    'the submitted Host path keeps every raw control byte and the appended tail')
  assert.ok(!h.raw().includes('pi-tui-pr3-pwned'),
    'the verified frame still emits no Host-controlled terminal sequence')
})

// ── PR3 external-review fixes ───────────────────────────────────────────────

test('the wide Add preview advertises the SAME painted Esc ladder as the body and footer', async () => {
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 120,
    rows: 40,
    onAddDirectory: (_path, settle) => { outcomes.push(settle) },
    onListDirectory: async (path) => path === undefined
      ? readyHostLevel(hostListing('/host/home', '/host/home', ['project-a', 'project-b']))
      : readyHostLevel(hostListing(path, '/host/home', [])),
  })
  h.handle.setSnapshot(snapshot({ rows: [] }))
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'Home candidates paint')
  assert.match(previewColumn(h), /Enter Verify directory · Esc Hide suggestions/,
    'the expanded Preview promises the real first Esc step')
  assert.doesNotMatch(previewColumn(h), /Esc Cancel/u)
  assert.match(panelFrame(h).at(-1)!, /Hide suggestions \[Esc\]/u, 'the footer agrees with the Preview Esc step')

  h.vt.sendInput('\x1b')
  await h.paint()
  assert.match(previewColumn(h), /Enter Verify directory · Esc Cancel/,
    'after the fold the Preview promises the real close step')
  assert.doesNotMatch(previewColumn(h), /Esc Hide suggestions/u)
  assert.match(panelFrame(h).at(-1)!, /Cancel \[Esc\]/u)

  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(!h.view().includes('Host directory:'), 'the second Esc closes the editor')

  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'the reopened editor paints candidates')
  h.vt.sendInput('\r')
  await h.paint()
  const pendingPreview = previewColumn(h)
  assert.match(pendingPreview, /Verifying directory…/)
  assert.doesNotMatch(pendingPreview, /Enter Verify directory|Esc Cancel|Esc Hide suggestions/u,
    'a pending verification advertises only the pending state')
  outcomes[0]!({ kind: 'failed', message: 'refused after the probe' })
  await h.paint()
})

test('a replaced Home generation paints a stopped browse state and keeps manual verification + reopen', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  let calls = 0
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
    onListDirectory: async (path) => {
      calls += 1
      if (calls === 1) throw new SupersededReadError('the Host connection generation changed')
      if (path === undefined) return readyHostLevel(hostListing('/host/home', '/host/home', ['project-a']))
      return readyHostLevel(hostListing(path, '/host/home', []))
    },
  })
  await h.paint()
  await waitUntil(() => h.view().includes('Directory suggestions stopped'), 'the superseded Home read settles visibly')
  const stopped = h.view()
  assert.ok(!stopped.includes('Reading Host directories…'), 'a terminal request never leaves a permanent loading claim')
  assert.ok(!stopped.includes('project-a/'), 'a replaced read never becomes a fake listing')
  h.vt.sendInput('/srv/manual')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(submitted, ['/srv/manual'], 'manual absolute verification stays available after the replaced Home read')
  outcomes[0]!({ kind: 'registered', workspaceId: 'ws-manual', path: '/srv/manual' })
  await h.paint()
  assert.ok(!h.view().includes('Host directory:'), 'the verified directory retires the editor')

  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  await waitUntil(() => h.view().includes('Host directory: /host/home/'), 'a reopened editor starts a NEW Home read')
  assert.equal(calls, 2, 'reopening creates a fresh chooser generation, never an automatic retry inside the old one')
})

test('a replaced prefix query settles stopped and a real edit recovers the next Host level', async () => {
  let calls = 0
  const h = harness({
    columns: 100,
    rows: 30,
    initialDirectoryEntry: true,
    onAddDirectory: () => {},
    onListDirectory: async (path) => {
      calls += 1
      if (calls === 1) return readyHostLevel(hostListing('/host/home', '/host/home', ['project-a']))
      if (calls === 2) throw new SupersededReadError('the Host connection generation changed')
      return readyHostLevel(hostListing('/host/home', '/host/home', ['project-b']))
    },
  })
  await h.paint()
  await waitUntil(() => h.view().includes('project-a/'), 'Home candidates paint')
  h.vt.sendInput('p')
  await h.paint()
  await waitUntil(() => h.view().includes('Edit the path to retry'), 'the replaced prefix query settles stopped')
  const stopped = h.view()
  assert.ok(!stopped.includes('project-a/'), 'the replaced query result is not presented')
  assert.ok(!stopped.includes('Reading Host directories…'), 'the stopped query is not a permanent loader')
  h.vt.sendInput('r')
  await h.paint()
  await waitUntil(() => h.view().includes('project-b/'), 'a real edit starts and settles the next query generation')
  assert.equal(calls, 3)
  assert.ok(h.view().includes('Host directory: /host/home/pr'), 'the raw edit value is unchanged')
})

test('the Peek bar is the only exit: the removed local row is inert and Open resumes once', async () => {
  const h = harness({ columns: 100, rows: 8 })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  const browseBar = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(browseBar.includes('Peek [Space]') && browseBar.includes('Close [Esc]'),
    `the Browse bar is the ONE physical bar:\n${browseBar}`)
  assert.equal(visibleWidth(browseBar), 100, 'the painted bar keeps the historical full-row width')
  await clickBarAction(h, 'Peek')
  let view = h.view()
  assert.ok(view.includes('Peek · other-se'), `the bar Peek opens the read-only detail:\n${view}`)
  assert.ok(!view.includes('Space close') && !view.includes('Esc back'),
    'the Peek body carries no local action row')
  assert.ok(panelFrame(h)[panelFrame(h).length - 1]!.includes('Back [Esc]'),
    'the ONE global bar owns the Peek Back')
  // At this height the removed local action row occupied the fourth body row
  // (physical row 5): it is now read-only content and must be inert.
  await clickCell(h, 2, 5)
  assert.ok(h.view().includes('Peek · other-se'), 'a body click never closes the Peek')
  assert.deepEqual(h.resumes, [], 'opening and clicking the body never resumes')
  const peekBar = panelFrame(h)[panelFrame(h).length - 1]!
  const separator = peekBar.indexOf(' · ')
  assert.ok(separator >= 0, `the Peek bar separates its segments:\n${peekBar}`)
  await clickCell(h, separator + 1, panelFrame(h).length - 1)
  assert.ok(h.view().includes('Peek · other-se'), 'the bar separator is decoration, never a target')
  assert.deepEqual(h.resumes, [], 'the separator cell never resumes')
  // PageDown pages by the REAL painted row count (four rows), and neither the
  // page key nor Down can scroll past the last full page.
  h.vt.sendInput('\x1b[6~')
  await h.paint()
  assert.ok(h.view().includes('cwd:'), `PageDown lands on the next page without skipping rows:\n${h.view()}`)
  for (let step = 0; step < 5; step += 1) {
    h.vt.sendInput('\x1b[B')
    await h.paint()
  }
  view = h.view()
  assert.ok(view.includes('Source:') && !view.includes('Peek · other-se'),
    `the Peek scroll stops at the last full page:\n${view}`)
  await clickBarAction(h, 'Open')
  assert.deepEqual(h.resumes, [OTHER], 'the bar Open is the ONE re-proved resume intent')
})

test('the Search bar Results verb only enters the result list and never resumes', async () => {
  const h = harness({ initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [{ row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle other' }],
  }), 'needle')
  await h.paint()
  assert.ok(panelFrame(h)[panelFrame(h).length - 1]!.includes('Results [Enter]'))
  await clickBarAction(h, 'Results')
  assert.deepEqual(h.resumes, [], 'the bar Results never resumes the first hit')
  const resultsBar = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(resultsBar.includes('Open [Enter]') && resultsBar.includes('Back [Esc]'),
    `the bar now names the result-list verbs:\n${resultsBar}`)
  await clickBarAction(h, 'Open')
  assert.deepEqual(h.resumes, [OTHER], 'the result-list Open is the deliberate second Enter')
})

test('the bar Verify submits the painted Host path once and is inert while verifying', async () => {
  const submitted: string[] = []
  const outcomes: Array<(outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void> = []
  const h = harness({
    columns: 100,
    rows: 24,
    initialDirectoryEntry: true,
    initialDirectoryPath: '/host/verify',
    onAddDirectory: (path, settle) => { submitted.push(path); outcomes.push(settle) },
  })
  await h.paint()
  assert.ok(h.view().includes('Host directory: /host/verify'), 'the retained path is painted')
  const bar = () => panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(bar().includes('Verify [Enter]') && bar().includes('Cancel [Esc]'),
    `the path editor verbs live on the ONE bar:\n${bar()}`)
  const verifyX = bar().indexOf('Verify') + 1
  const cancelX = bar().indexOf('Cancel') + 1
  await clickBarAction(h, 'Verify')
  assert.deepEqual(submitted, ['/host/verify'], 'the bar Verify reaches the existing onAddDirectory')
  assert.ok(bar().includes('Verifying directory…'), 'the submitting fact replaces the verbs')
  // The former Verify/Cancel cells now hold a fact: a pending verification is
  // never submitted twice and never cancelled.
  await clickCell(h, verifyX, panelFrame(h).length - 1)
  await clickCell(h, cancelX, panelFrame(h).length - 1)
  assert.deepEqual(submitted, ['/host/verify'], 'a pending verification never submits twice')
  assert.equal(h.closes, 0, 'a pending verification is never cancelled by a click')
  assert.ok(h.view().includes('Host directory: /host/verify'), 'the editor stays the visible owner')
})

test('a bar gesture is dropped by any frame change between press and release', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  // Positive control: the exact same gesture on an UNCHANGED frame fires.
  await clickBarAction(h, 'Peek')
  assert.ok(h.view().includes('Peek · other-se'), 'control: an unchanged bar press/release opens the Peek')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(!h.view().includes('Peek ·'), 'control: the keyboard Esc closes it again')
  // Press Peek, move the tree selection, release on the old cell: inert.
  let frame = panelFrame(h)
  let bar = frame[frame.length - 1]!
  let x = bar.indexOf('Peek') + 1
  let y = frame.length - 1
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
  assert.ok(!h.view().includes('Peek ·'), 'a scroll between press and release drops the Peek gesture')
  // Press Open, resize, release on the old cell: inert.
  h.vt.sendInput('\x1b[B')
  await h.paint()
  frame = panelFrame(h)
  bar = frame[frame.length - 1]!
  x = bar.indexOf('Open') + 1
  y = frame.length - 1
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  h.vt.resize(80, 20)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
  assert.deepEqual(h.resumes, [], 'a resize between press and release drops the Open gesture')
  assert.equal(h.closes, 0, 'the dropped Open gesture never closes the Browser')
  // Press Results in the search editor, clear the real results, release: inert.
  h.vt.sendInput('/')
  await h.paint()
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [{ row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle' }],
  }), 'needle')
  await h.paint()
  frame = panelFrame(h)
  bar = frame[frame.length - 1]!
  x = bar.indexOf('Results') + 1
  y = frame.length - 1
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: [] }), 'needle')
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
  assert.deepEqual(h.resumes, [], 'a changed search state between press and release never resumes')
  assert.equal(h.closes, 0, 'a changed search state never closes through the old bar cell')
  assert.ok(h.view().includes('Search all workspaces'), 'the search editor keeps its own focus')
})

test('a bar gesture is revoked by a resize that has not repainted yet', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  const frame = panelFrame(h)
  const bar = frame[frame.length - 1]!
  const x = bar.indexOf('Open') + 1
  const y = frame.length - 1
  assert.ok(x > 0, `the bar paints its Open affordance:\n${bar}`)

  // PRESS, then let the terminal change geometry WITHOUT waiting for a frame,
  // then RELEASE on the old physical cell. The pre-repaint resize must revoke
  // the gesture instead of replaying the old bar action.
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  h.vt.resize(80, 20)
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
  assert.deepEqual(h.resumes, [], 'a resize before the next paint never resumes the old target')
  assert.equal(h.closes, 0, 'the stale release never closes the workspace')

  // Positive control: the same cells on an unchanged frame still resume once.
  const current = panelFrame(h)
  const currentBar = current[current.length - 1]!
  const currentX = currentBar.indexOf('Open')
  if (currentX >= 0) {
    await clickBarAction(h, 'Open')
    assert.deepEqual(h.resumes, [OTHER], 'an unchanged frame still runs the ONE resume intent')
  }
})

test('the bar gesture is pinned to the live terminal grant, not only the frame revision', () => {
  const resumes: string[] = []
  let closes = 0
  let rows = 24
  let columns = 100
  const host: SessionWorkspacePanelHost = {
    rows: () => rows,
    columns: () => columns,
    requestRender: () => {},
    notice: () => undefined,
    onQueryChange: () => {},
    onResume: (sessionId) => { resumes.push(sessionId) },
    onClose: () => { closes += 1 },
  }
  const options: SessionWorkspacePanelOptions = {
    initialMode: 'browse',
    initialBrowseScope: 'current',
    currentSessionId: CURRENT,
  }
  const panel = new SessionWorkspacePanel(host, options)
  panel.setSnapshot(snapshot())
  panel.handleInput('\x1b[B') // move from the current Session to `OTHER`
  const paint = (): string => stripTerminalSequences(panel.render(columns).at(-1) ?? '')
  const bar = paint()
  const x = bar.indexOf('Open')
  assert.ok(x >= 0, `the bar paints Open for the selected non-current Session:\n${bar}`)

  // PRESS, change the LIVE grant WITHOUT a new frame, then RELEASE on the same
  // cell: the stale cell must not reach resumeSelected.
  panel.onCellPress(x, rows - 1)
  rows = 20
  panel.onCellClick(x, 23)
  assert.deepEqual(resumes, [], 'a pre-repaint row resize revokes the bar gesture')

  // The same fence covers a width-only change.
  rows = 24
  panel.onCellPress(x, 23)
  columns = 80
  panel.onCellClick(x, 23)
  assert.deepEqual(resumes, [], 'a pre-repaint width change revokes the bar gesture')

  // Positive control: the unchanged frame still runs the ONE resume intent.
  columns = 100
  panel.onCellPress(x, 23)
  panel.onCellClick(x, 23)
  assert.deepEqual(resumes, [OTHER], 'an unchanged frame still resumes the selected Session once')
  assert.equal(closes, 0, 'no bar gesture ever closed the workspace')
  panel.dispose()
})

test('a one-row frame has no action bar, and a truncated bar segment has no hit', async () => {
  const headerOnly = harness({ columns: 80, rows: 1 })
  headerOnly.handle.setSnapshot(snapshot())
  await headerOnly.paint()
  assert.equal(panelFrame(headerOnly).length, 1, 'height=1 paints the header only')
  await clickCell(headerOnly, 2, 0)
  assert.equal(headerOnly.closes, 0, 'the one-row header never creates a bar target')
  assert.deepEqual(headerOnly.resumes, [])
  headerOnly.app.dispose()
  started.delete(headerOnly.app)

  // Two cells cannot paint even the compact Esc verb whole: the row truncates
  // with the ellipsis and yields no spans, so it must stay inert.
  const narrow = harness({ columns: 2, rows: 3 })
  narrow.handle.setSnapshot(snapshot())
  await narrow.paint()
  const frame = panelFrame(narrow)
  assert.equal(frame.length, 3, 'the 3-row frame keeps its physical last row')
  assert.ok(!frame[2]!.includes('Esc'), `the truncated Esc is never painted whole:\n${frame[2]}`)
  await clickCell(narrow, 0, 2)
  assert.equal(narrow.closes, 0, 'a truncated bar segment has no hit region')
  assert.deepEqual(narrow.resumes, [])
})

// ── Tree geometry, Folder click semantics and the per-open history watermark ──

test('G01: a Session child row indents two cells inside its Folder and keeps every column inside the pane', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-g01-history-${index}`, 900 - index, { title: `History ${index}` }))
  history[3] = row('session-g01-history-3', 897, { title: '中文会话 标题' })
  const h = harness({ columns: 100, rows: 24, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current title' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-current', path: '/ws', title: 'dsh-pi-tui', sessionIds: [CURRENT, ...history.map(item => item.id)] },
    { workspaceId: 'ws-other', path: '/other', title: 'Unassigned Other', sessionIds: [] },
  ] })
  await h.paint()
  const frame = panelFrame(h)
  const view = frame.join('\n')
  const folderLine = folderLineIndexOf(frame, 'dsh-pi-tui')
  assert.equal(frame[folderLine]!.indexOf('▾'), 2, `the Folder disclosure starts at column 2:\n${view}`)
  assert.equal(frame[lineIndexOf(frame, '+ New session')]!.indexOf('+ New session'), 4,
    `the New action keeps its relative indent at column 4:\n${view}`)
  const historyLine = lineIndexOf(frame, 'History 0')
  assert.equal(frame[historyLine]!.indexOf(shortSessionId('session-g01-history-0')), 4,
    `a non-current Session identity starts at column 4:\n${view}`)
  const currentLine = lineIndexOf(frame, 'Current title')
  assert.equal(frame[currentLine]!.indexOf('●'), 4, `the Current bullet follows the Session indent at column 4:\n${view}`)
  assert.equal(frame[currentLine]!.indexOf(shortSessionId(CURRENT)), 6,
    `the Current identity follows its bullet at column 6:\n${view}`)
  assert.equal(frame[lineIndexOf(frame, 'Show more sessions')]!.indexOf('Show more sessions'), 6,
    `the Show-more label keeps its relative indent at column 6:\n${view}`)
  assert.ok(view.includes('中文会话'), 'a CJK title paints in the indented row')
  for (const line of frame) {
    assert.ok(visibleWidth(line) <= 100, `every painted row fits the pane: ${JSON.stringify(line)}`)
  }
  assert.ok(/^> {3}● current-/m.test(view), `the fixed "> " gutter stays outside the tree indent:\n${view}`)
})

test('G02: the flat search result keeps its own columns while Browse indents its Session children', async () => {
  const h = harness({ columns: 80, rows: 24, initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current title' }), row(OTHER, 2_000, { title: 'Other title' })],
    query: 'needle',
    searchState: 'ready',
    searchResults: [
      { row: row(CURRENT, 3_000, { title: 'Current title' }), source: 'Content', snippet: 'needle a' },
      { row: row(OTHER, 2_000, { title: 'Other title' }), source: 'Metadata' },
    ],
  }), 'needle')
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, OTHER] },
  ] })
  await h.paint()
  let frame = panelFrame(h)
  const currentResult = lineIndexOf(frame, 'Current title')
  assert.equal(frame[currentResult]!.indexOf('●'), 2, `a search Current bullet stays at column 2:\n${frame.join('\n')}`)
  assert.equal(frame[currentResult]!.indexOf(shortSessionId(CURRENT)), 4, 'and its identity follows at column 4')
  const otherResult = lineIndexOf(frame, 'Other title')
  assert.equal(frame[otherResult]!.indexOf(shortSessionId(OTHER)), 2,
    `a flat search result carries no tree indent:\n${frame.join('\n')}`)
  h.vt.sendInput('\x1b')
  await h.paint()
  frame = panelFrame(h)
  assert.equal(frame[lineIndexOf(frame, 'Other title')]!.indexOf(shortSessionId(OTHER)), 4,
    `the same Session is indented two cells in the Browse tree:\n${frame.join('\n')}`)
})

test('M01: a Browse Folder title click toggles it once and never writes the official Workspace', async () => {
  const created: string[] = []
  const h = harness({ columns: 100, rows: 24, onNewSession: (workspaceId) => { created.push(workspaceId) } })
  h.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 3_000, { title: 'Current title' }),
    row(OTHER, 2_000, { title: 'Other title' }),
    row(THIRD, 1_000, { title: 'Third title' }),
  ] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [CURRENT, OTHER] },
    { workspaceId: 'ws-beta', path: '/ws/beta', title: 'Beta', sessionIds: [THIRD] },
  ] })
  await h.paint()
  assert.ok(h.view().includes('Other title'), 'the current Folder starts expanded')
  await clickCell(h, 6, folderLineIndexOf(panelFrame(h), 'Alpha'))
  const collapsed = h.view()
  assert.ok(!collapsed.includes('Other title'), `a title click collapses the Folder:\n${collapsed}`)
  assert.ok(/^> .*▸ Alpha · 2 · Current/m.test(collapsed),
    `one gesture toggles exactly once, selects the Folder and keeps its official label:\n${collapsed}`)
  assert.ok(collapsed.includes('Sessions · 3'), 'the roster count is unchanged: a click never writes a Workspace')
  // A click on a DIFFERENT word of the same title row is a separate gesture (the
  // terminal reserves a same-word double click for text selection), and it
  // reopens the Folder with New as its first child.
  await clickCell(h, 20, folderLineIndexOf(panelFrame(h), 'Alpha'))
  const reopened = panelFrame(h)
  const folderLine = folderLineIndexOf(reopened, 'Alpha')
  assert.ok(reopened[folderLine + 1]!.includes('+ New session'),
    `reopening makes New the first child row:\n${reopened.join('\n')}`)
  assert.ok(h.view().includes('Other title'), 'the children are back')
  assert.deepEqual(created, [], 'a Folder click never starts a Session create')
  assert.equal(h.closes, 0)
})

test('M02: the disclosure and the blank title area are the same one-shot Folder toggle', async () => {
  const h = harness({ columns: 100, rows: 24, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 3_000, { title: 'Current title' }),
    row(OTHER, 2_000, { title: 'Other title' }),
    row(THIRD, 1_000, { title: 'Third title' }),
  ] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [CURRENT, OTHER] },
    { workspaceId: 'ws-beta', path: '/ws/beta', title: 'Beta', sessionIds: [THIRD] },
  ] })
  await h.paint()
  await clickCell(h, 2, folderLineIndexOf(panelFrame(h), 'Alpha'))
  assert.ok(!h.view().includes('Other title'), 'the disclosure collapses the Folder')
  await clickCell(h, 90, folderLineIndexOf(panelFrame(h), 'Alpha'))
  assert.ok(h.view().includes('Other title'), 'the blank tail of the same row expands it')
  assert.ok(/^> .*▾ Alpha/m.test(h.view()), 'one blank click toggles once, never twice')
  assert.deepEqual(h.resumes, [], 'Folder clicks never resume a Session')
  await clickCell(h, 6, lineIndexOf(panelFrame(h), 'Other title'))
  assert.ok(/^> .*Other title/m.test(h.view()), 'a Session row click only selects it')
  assert.deepEqual(h.resumes, [], 'the Session click itself is not a resume')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter is still the guarded resume verb')
})

test('M03: the Sessionless chooser keeps title=choose and disclosure=browse', async () => {
  const used: Array<[string, string]> = []
  const h = harness({
    columns: 100,
    rows: 24,
    currentSessionId: null,
    initialDirectoryChooser: true,
    onAddDirectory: () => {},
    onNewSession: () => {},
    onUseDirectory: (workspaceId, canonicalPath) => { used.push([workspaceId, canonicalPath]) },
  })
  h.handle.setSnapshot(snapshot({ rows: [row(OTHER, 2_000, { title: 'Other title' })] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [OTHER] },
  ] })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [fact(OTHER, { running: true, attention: 'none', attentionSourceState: 'known' })],
    answerEligibility: [],
  })
  await h.paint()
  assert.ok(h.view().includes('Choose workspace'), 'the chooser keeps its own title')
  assert.ok(!h.view().includes('+ New session'), 'the chooser never paints a create action')
  assert.ok(h.view().includes('Other title'), 'a Folder with a confirmed Working row starts expanded')
  await clickCell(h, 2, folderLineIndexOf(panelFrame(h), 'Alpha'))
  assert.ok(!h.view().includes('Other title'), 'the disclosure only collapses the Folder')
  assert.deepEqual(used, [], 'the disclosure never chooses a Workspace')
  assert.equal(h.closes, 0)
  await clickCell(h, 5, folderLineIndexOf(panelFrame(h), 'Alpha'))
  assert.deepEqual(used, [['ws-alpha', '/ws/alpha']], 'the Folder title click is the ONE choose action')
  assert.equal(h.closes, 1, 'the chooser returns after the choose')
})

test('M04: a Folder gesture is dropped when the frame changes between press and release', async () => {
  const h = harness({ columns: 100, rows: 24, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 3_000, { title: 'Current title' }),
    row(OTHER, 2_000, { title: 'Other title' }),
  ] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [CURRENT] },
    { workspaceId: 'ws-beta', path: '/ws/beta', title: 'Beta', sessionIds: [OTHER] },
  ] })
  await h.paint()
  const line = folderLineIndexOf(panelFrame(h), 'Beta')
  h.vt.sendInput(`\x1b[<0;7;${line + 1}M`)
  await h.paint()
  // The Activity sample makes Beta's only Session working, so the OFFICIAL
  // default expands the Folder between the two halves of the gesture.
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact(OTHER, { running: true, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [],
  })
  await h.paint()
  assert.ok(h.view().includes('Other title'), 'the re-painted frame default-expands the now-Working Folder')
  h.vt.sendInput(`\x1b[<0;7;${line + 1}m`)
  await h.paint()
  assert.ok(h.view().includes('Other title'), 'the stale release must not toggle the re-painted Folder')
  await clickCell(h, 7, folderLineIndexOf(panelFrame(h), 'Beta'))
  assert.ok(!h.view().includes('Other title'), 'a fresh press/release on the new frame acts exactly once')
  assert.deepEqual(h.resumes, [], 'no gesture resumed a Session')
})

test('H01: the real list height drives ordinary history up to the automatic cap', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-h01-${index}`, 900 - index, { title: `H01 ${index}` }))
  const counts: number[] = []
  for (const rows of [24, 40, 60] as const) {
    const h = harness({ columns: 100, rows })
    h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H01 current' }), ...history] }))
    h.handle.updateWorkspaces({ type: 'baseline', items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
    ] })
    await h.paint()
    const frame = panelFrame(h)
    const view = frame.join('\n')
    const visible = frame.filter(line => /H01 \d+/.test(line)).length
    counts.push(visible)
    assert.ok(visible > 0 && visible <= 20, `${rows} rows: ordinary history stays within the automatic cap:\n${view}`)
    assert.ok(frame[frame.length - 1]!.includes('Esc close'), `${rows} rows: the Footer keeps its last physical row`)
    const more = frame.find(line => line.includes('Show more sessions'))
    assert.ok(more !== undefined, `${rows} rows: the remaining history stays behind Show more:\n${view}`)
    const remaining = Number(/· (\d+) remaining/.exec(more)?.[1])
    assert.equal(remaining, 30 - visible, `${rows} rows: the remaining count matches the painted watermark`)
    h.dispose()
  }
  assert.ok(counts[1]! >= counts[0]!, `a taller list never shows less ordinary history: ${counts.join(', ')}`)
  assert.ok(counts[2]! <= 20)
  assert.equal(counts[2], 19,
    `a tall frame reaches the automatic 20-row watermark, one of whose rows is the current Session: ${counts.join(', ')}`)
})

test('H02: resizing never rewinds a watermark and never moves the typed selection', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-h02-${index}`, 900 - index, { title: `H02 ${index}` }))
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H02 current' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  await h.paint()
  for (let step = 0; step < 10; step += 1) {
    h.vt.sendInput('\x1b[B')
    await h.paint()
  }
  assert.ok(/^> .*H02 9/m.test(h.view()), `the cursor sits in the later half of the ordinary history:\n${h.view()}`)
  const count = (): number => panelFrame(h).filter(line => /H02 \d+/.test(line)).length
  const at24 = count()
  h.vt.resize(100, 40)
  await h.paint()
  const at40 = count()
  assert.ok(at40 >= at24, `growing the terminal adds ordinary history, never removes it: ${at24} -> ${at40}`)
  assert.ok(/^> .*H02 9/m.test(h.view()), 'the selection keeps its own row id across the resize')
  h.vt.resize(100, 10)
  await h.paint()
  assert.ok(/^> .*H02 9/m.test(h.view()), 'the selected row stays painted on the short frame')
  assert.ok(count() <= 6, `a short frame paints only what its body budget holds: ${count()}`)
  h.vt.resize(100, 40)
  await h.paint()
  assert.equal(count(), at40, 'returning to the same size never grows the watermark again')
  assert.ok(count() <= 20)
  assert.ok(/^> .*H02 9/m.test(h.view()), 'the cursor never jumped back to the top')
  // A real press repaints the SAME content: the frame revision must survive it,
  // so the release still selects another painted row. A hidden re-allocation on
  // that second render would drop the gesture.
  await clickCell(h, 6, lineIndexOf(panelFrame(h), 'H02 10'))
  assert.ok(/^> .*H02 10/m.test(h.view()),
    'a same-size press repaint keeps its frame revision: no hidden re-allocation on the second render')
})

test('H02B: a growth that exhausts the selected Show more row keeps a painted cursor', async () => {
  const history = Array.from({ length: 14 }, (_, index) => row(`session-h02b-${index}`, 900 - index, { title: `H02B ${index}` }))
  const h = harness({ columns: 100, rows: 16 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H02B current' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  await h.paint()
  h.vt.sendInput('\x1b[F')
  await h.paint()
  assert.ok(/^> .*Show more sessions/m.test(h.view()), `the cursor sits on the Show-more row:\n${h.view()}`)
  // The taller frame reveals ALL remaining history, so the Show-more row the
  // cursor sits on disappears in the same render.
  h.vt.resize(100, 40)
  await h.paint()
  const grown = h.view()
  assert.ok(!grown.includes('Show more sessions'), `the grown tree exhausted the remaining history:\n${grown}`)
  assert.ok(/^> .*Alpha/m.test(grown),
    `the cursor re-anchored on its parent Folder instead of vanishing:\n${grown}`)
  const actionBar = panelFrame(h).at(-1)!
  assert.ok(actionBar.includes('Enter Collapse'),
    `the Footer still advertises the re-anchored row's real verb:\n${actionBar}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(!/H02B \d+/.test(h.view()), 'Enter acts on the painted Folder instead of an invisible target')
  h.app.dispose()
  started.delete(h.app)

  // The same orphaning cannot happen through a status row that stops painting:
  // one row of budget appears, the growth exhausts the selected Show more row.
  const settledHistory = Array.from({ length: 14 }, (_, index) => row(`session-h02c-${index}`, 900 - index, { title: `H02C ${index}` }))
  const status = harness({ columns: 100, rows: 20 })
  status.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H02C current' }), ...settledHistory] }))
  status.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-s', path: '/ws/s', title: 'Status', sessionIds: [CURRENT, ...settledHistory.map(item => item.id)] },
  ] })
  await status.paint()
  status.vt.sendInput('\x1b[F')
  await status.paint()
  assert.ok(/^> .*Show more sessions/m.test(status.view()), `the cursor sits on the Show-more row:\n${status.view()}`)
  status.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      ...settledHistory.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
    ],
    answerEligibility: [],
  })
  await status.paint()
  const settled = status.view()
  assert.ok(!settled.includes('Show more sessions'), `the settled sample frees a row and exhausts the history:\n${settled}`)
  assert.ok(/^> .*Status/m.test(settled), `the cursor re-anchored on the parent Folder:\n${settled}`)
  assert.ok(panelFrame(status).at(-1)!.includes('Enter Collapse'), 'the Footer advertises the painted row')
})

test('H03: spare rows fill the priority Workspace first and then the other expanded ones', async () => {
  const a = Array.from({ length: 45 }, (_, index) => row(`session-h03-a-${index}`, 9_000 - index, { title: `A history ${index}` }))
  const b = Array.from({ length: 10 }, (_, index) => row(`session-h03-b-${index}`, 8_000 - index, { title: `B history ${index}` }))
  const c = Array.from({ length: 10 }, (_, index) => row(`session-h03-c-${index}`, 7_000 - index, { title: `C history ${index}` }))
  const h = harness({ columns: 100, rows: 14, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 10_000, { title: 'Current session' }),
    row('session-h03-needs', 9_500, { title: 'B need' }),
    row('session-h03-working', 9_400, { title: 'B working' }),
    ...a,
    ...b,
    ...c,
  ] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: ['session-h03-needs', 'session-h03-working', ...b.map(item => item.id)] },
    { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT, ...a.map(item => item.id)] },
    { workspaceId: 'ws-c', path: '/ws/c', title: 'Gamma', sessionIds: c.map(item => item.id) },
  ] })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact('session-h03-needs'),
      fact('session-h03-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      ...a.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
      ...b.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
      ...c.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
    ],
    answerEligibility: [eligibility('session-h03-needs')],
  })
  await h.paint()
  // The base tree already exceeds this frame: walk the cursor onto Alpha's own
  // Show-more row and read the SHARED watermark it paints. It is still the
  // default eight ordinary rows (46 recent - 8 = 38 remaining), so the
  // overflowing frame grew nothing; an unconditional allocation would paint a
  // smaller `remaining` here.
  for (let step = 0; step < 8; step += 1) {
    h.vt.sendInput('\x1b[B')
    await h.paint()
  }
  const tight = h.view()
  assert.ok(/^> .*Show more sessions/m.test(tight), `the cursor reaches Alpha's Show-more row:\n${tight}`)
  assert.ok(tight.includes('Show more sessions · 38 remaining'),
    `a frame whose base tree already overflows keeps the shared watermark:\n${tight}`)
  h.vt.resize(100, 60)
  await h.paint()
  const roomy = h.view()
  assert.ok(roomy.includes('A history 18'), `the priority Workspace grows up to the automatic cap:\n${roomy}`)
  assert.ok(!roomy.includes('A history 19'), `and stops there instead of revealing the whole history:\n${roomy}`)
  assert.ok(roomy.includes('B history 9'), `the other expanded Workspace then receives the spare rows:\n${roomy}`)
  assert.ok(roomy.includes('B need') && roomy.includes('B working'), 'the active priority rows stay painted')
  assert.ok(roomy.includes('+ New session'), 'the expanded official Folders keep their New row')
  assert.ok(!roomy.includes('C history'), 'the allocation never expands a collapsed Folder')
  assert.ok(/[▸▾] Gamma/.test(roomy), 'the collapsed Folder row itself stays in the complete tree')
})

test('H04: manual collapse, Show more beyond the cap and a later shrink keep the per-open watermark', async () => {
  const history = Array.from({ length: 45 }, (_, index) => row(`session-h04-${index}`, 900 - index, { title: `H04 ${index}` }))
  const other = Array.from({ length: 10 }, (_, index) => row(`session-h04-other-${index}`, 800 - index, { title: `Other ${index}` }))
  const h = harness({ columns: 100, rows: 40 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H04 current' }), ...history, ...other] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
    { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: other.map(item => item.id) },
  ] })
  await h.paint()
  const count = (): number => panelFrame(h).filter(line => /H04 \d+/.test(line)).length
  const automatic = count()
  assert.ok(automatic <= 20, `the automatic watermark stays capped: ${automatic}`)
  await clickCell(h, 8, lineIndexOf(panelFrame(h), 'Show more sessions'))
  const grown = count()
  assert.ok(grown > automatic, `Show more adds five more rows beyond the automatic watermark: ${automatic} -> ${grown}`)
  assert.ok(grown <= automatic + 5, `Show more advances exactly one batch: ${automatic} -> ${grown}`)
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(!/H04 \d+/.test(h.view()), `a manual collapse hides every ordinary child:\n${h.view()}`)
  assert.ok(!h.view().includes('Show more sessions'), 'and its Show more row')
  h.vt.sendInput('\r')
  await h.paint()
  assert.equal(count(), grown, 'reopening restores the watermark this open had already gained')
  h.vt.resize(100, 14)
  await h.paint()
  assert.ok(count() <= 10, `a shrink only changes the viewport: ${count()}`)
  h.vt.resize(100, 40)
  await h.paint()
  assert.equal(count(), grown, 'resizing never rewinds the watermark')
  assert.ok(!h.view().includes('Other 0'), 'the allocation never opened the collapsed Folder')
})

test('H05: search, Peek, the Host editor and tiny frames never move the Browse watermark', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-h05-${index}`, 900 - index, { title: `H05 ${index}` }))
  const h = harness({
    columns: 44,
    rows: 20,
    onAddDirectory: () => {},
  })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H05 current' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  await h.paint()
  const count = (): number => panelFrame(h).filter(line => /H05 \d+/.test(line)).length
  const browse = count()
  assert.ok(browse >= 1)
  h.vt.sendInput('/')
  await h.paint()
  h.vt.sendInput('needle')
  await h.paint()
  assert.ok(h.view().includes('Search all workspaces'))
  assert.ok(!/H05 \d+/.test(h.view()), 'the search presentation paints no Browse tree')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(count(), browse, 'one search round trip never moves the watermark')
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Peek ·'), `Space opens the read-only Peek:\n${h.view()}`)
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(count(), browse, 'Peek never moves the watermark')
  assert.deepEqual(h.resumes, [], 'search and Peek never resume a Session')
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Host directory:'), `Add opens the inline Host editor:\n${h.view()}`)
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(count(), browse, 'the Host editor never moves the watermark')
  assert.equal(h.closes, 0)
  h.vt.resize(80, 2)
  await h.paint()
  assert.ok(!/H05 \d+/.test(h.view()), 'an 80x2 frame paints no list row')
  h.vt.resize(80, 3)
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'a row the tiny frame never painted cannot be opened')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(h.closes, 1, 'Esc still closes the Browse from a tiny frame')
})

test('H06: without an official Workspace baseline the roster stays flat and fabricates no Folder', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-h06-${index}`, 900 - index, { title: `H06 ${index}` }))
  const h = harness({ columns: 100, rows: 24, onNewSession: () => {} })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H06 current' }), ...history] }))
  await h.paint()
  const frame = panelFrame(h)
  const view = frame.join('\n')
  assert.ok(!frame.some(line => /[▾▸]/.test(line)), `no Folder is painted without a baseline:\n${view}`)
  assert.ok(!view.includes('+ New session'), 'no create action is fabricated')
  assert.ok(!view.includes('Show more sessions'), 'no watermark row is fabricated')
  assert.ok(view.includes('H06 current') && view.includes('H06 0'), 'the flat roster is the whole list')
  h.handle.workspaceUnavailable('workspace follow failed')
  await h.paint()
  const degraded = h.view()
  assert.ok(!degraded.includes('▸'), 'a lost Workspace stream keeps the flat fallback')
  assert.ok(degraded.includes('workspace follow failed'))
  assert.ok(degraded.includes('H06 0'))
})
