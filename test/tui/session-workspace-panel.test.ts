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
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@xmoon76/pi-tui'
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
import type { SessionMarkdownReadResult } from '../../src/runtime/session-markdown-port.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'
import { sessionBrowserErrorNotice, shortSessionId } from '../../src/tui/pickers/sessions.ts'
import { color, currentPalette } from '../../src/tui/theme/runtime.ts'
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
  readonly reads: Array<{ readonly sessionId: string; readonly signal: AbortSignal }>
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
  readonly readMarkdown?: (sessionId: string, signal: AbortSignal) => Promise<SessionMarkdownReadResult>
  readonly onNewSession?: (workspaceId: string, settle?: (outcome: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void) => void
  readonly onUseDirectory?: (workspaceId: string, canonicalPath: string) => void
  readonly onInspectorSelection?: (selection: import('../../src/app/command/session-browser-presentation.ts').SessionInspectorSelection | undefined) => void
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
  const reads: Array<{ readonly sessionId: string; readonly signal: AbortSignal }> = []
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
    readMarkdown: (sessionId, signal) => {
      reads.push({ sessionId, signal })
      return options.readMarkdown?.(sessionId, signal)
        ?? Promise.resolve({ kind: 'ready', markdown: `# Transcript ${sessionId}\n\nRead-only committed body.` })
    },
    ...(options.onAddDirectory === undefined ? {} : { onAddDirectory: options.onAddDirectory }),
    ...(options.onListDirectory === undefined ? {} : { onListDirectory: options.onListDirectory }),
    ...(options.onNewSession === undefined ? {} : { onNewSession: options.onNewSession }),
    ...(options.onUseDirectory === undefined ? {} : { onUseDirectory: options.onUseDirectory }),
    ...(options.onInspectorSelection === undefined ? {} : { onInspectorSelection: options.onInspectorSelection }),
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
    reads,
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
test('folder pointer collapses default-expanded active rows and Show more pointer reveals one page', async () => {
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
  assert.ok(opened.includes('History 24'), `reopening restores the watermark this open had already grown:\n${opened}`)
  assert.ok(!opened.includes('History 25'), `the restored watermark stays bounded by the real viewport:\n${opened}`)
  frame = panelFrame(h)
  const moreLine = lineIndexOf(frame, 'Show more sessions')
  await clickCell(h, 3, moreLine)
  const view = h.view()
  assert.ok(/^> .*History 25/m.test(view), `the first newly revealed history row is selected:\n${view}`)
  assert.ok(!view.includes('Show more sessions'), `one pointer page exhausts the remaining five rows:\n${view}`)
  assert.ok(view.includes('Active row'), 'the folder keeps its active row after the reveal')
  assert.deepEqual(h.resumes, [], 'Show more never resumes a Session')
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
test('the browse list paints the header, current marker, and the Return verb', async () => {
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
  assert.ok(lines[lines.length - 1]!.includes('Return [Enter]'),
    `Enter on the selected current row advertises the real Return:\n${lines[lines.length - 1]}`)

  // Enter returns to the Session this Browser was opened from: one close, no Resume.
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Return on the current Session never resumes')
  assert.equal(h.closes, 1, 'Return closes the Browser exactly once')
  assert.equal(h.handle.isDisposed(), true, 'the same leased open really retired')
  assert.equal(h.app.isFullscreen(), false, 'no fullscreen lease survives the Return')
  // The SAME retired handle is owner-origin and cannot notify the owner twice.
  h.handle.close()
  await h.paint()
  assert.equal(h.closes, 1, 'the retired handle cannot close the Browser twice')
})

test('the browse list Enter on a listed non-current row emits one guarded Resume', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(/^> /m.test(h.view()), `the selection marker is the ASCII arrow:\n${h.view()}`)
  const footer = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(footer.includes('Open [Enter]') && !footer.includes('Return [Enter]'),
    `a non-current row keeps Open:\n${footer}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter on a listed non-current row emits one resume intent')
  assert.equal(h.closes, 0, 'the non-current path is unchanged: the owner, not the panel, closes')
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
  for (let step = 0; step < 7; step += 1) {
    h.vt.sendInput('\x1b[B')
    await h.paint()
  }
  const view = h.view()
  assert.ok(view.includes('History 6'), `the selected row scrolls into the painted window:\n${view}`)
  assert.ok(!view.includes('Current session'), `the window moved off the first page:\n${view}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, ['session-tree-scroll-6'], 'the scrolled-to row is a real painted activation target')
})

test('a row the current frame never painted can never be opened, and resizing re-validates it', async () => {
  // 80×2 paints only the header and the action bar: no Session row exists.
  const h = harness({ columns: 80, rows: 2 })
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  await h.paint()
  assert.ok(!h.view().includes('Other session'), 'no row is painted at 2 rows')
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
  const h = harness({ columns: 80, rows: 6 })
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
  await h.paint()
  const hasMoreView = h.view()
  assert.ok(hasMoreView.includes('Refine for more'), `the hasMore fact lives in the fixed context row:\n${hasMoreView}`)
  assert.ok(!hasMoreView.includes('More content matches exist — refine the search.'),
    'the retired transient hasMore notice is gone')
  assert.equal(hasMoreView.split('\n').filter(line => line.includes('Refine for more')).length, 1)
})

test('the session browser error status defers clipping to the live workspace width', async () => {
  const errorMessage = `${'A'.repeat(50)}MARK-A${'B'.repeat(30)}MARK-B${'C'.repeat(30)}MARK-C${'D'.repeat(40)}END`
  const h = harness({ columns: 80, rows: 24, initialMode: 'search' })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'error',
    searchError: errorMessage,
    searchResults: [],
  }), 'needle')
  const fullNotice = sessionBrowserErrorNotice('search', errorMessage)
  h.app.notify(fullNotice, 'error')
  await h.paint()

  const statusLine = (view: string): string => {
    const line = view.split('\n').find(candidate => candidate.includes('Search failed:'))
    assert.ok(line !== undefined, `the search error status line is missing:\n${view}`)
    return line
  }
  let view = h.view()
  let line = statusLine(view)
  assert.ok(line.includes('MARK-A'), `the 80-column status must show content past the old 40-char cut:\n${line}`)
  assert.ok(!line.includes('MARK-B'), `the 80-column status must end at its live width:\n${line}`)
  assert.equal(
    view.split('\n').filter(candidate => candidate.includes('Search failed:')).length,
    1,
    `the panel status and the same-fact app notice paint once:\n${view}`,
  )
  for (const painted of h.vt.getViewport()) {
    assert.ok(visibleWidth(painted) <= 80, `a painted 80-column row overflows: ${JSON.stringify(painted)}`)
  }

  h.vt.resize(120, 24)
  await h.paint()
  line = statusLine(h.view())
  assert.ok(line.includes('MARK-B'), `a wider workspace must reveal the next error segment:\n${line}`)
  assert.ok(!line.includes('MARK-C'), `the 120-column status must not paint the 160-column tail:\n${line}`)
  for (const painted of h.vt.getViewport()) {
    assert.ok(visibleWidth(painted) <= 120, `a painted 120-column row overflows: ${JSON.stringify(painted)}`)
  }

  h.vt.resize(160, 24)
  await h.paint()
  line = statusLine(h.view())
  assert.ok(line.includes('MARK-C'), `the 160-column workspace must reveal a farther tail:\n${line}`)
  assert.ok(!line.includes('END'), `the 160-column status still truncates what does not fit:\n${line}`)

  h.vt.resize(44, 24)
  await h.paint()
  line = statusLine(h.view())
  assert.ok(line.trimEnd().endsWith('…'), `the compact status marks its truncation:\n${line}`)
  assert.ok(visibleWidth(line.trimEnd()) <= 44, `the compact status never exceeds 44 cells:\n${line}`)

  h.vt.resize(160, 24)
  await h.paint()
  assert.ok(statusLine(h.view()).includes('MARK-C'), 'widening again recovers the longer same-fact status')
})

test('a long projection error also clips at the painted workspace width', async () => {
  const projectionError = `projection-${'X'.repeat(80)}-TAIL`
  const h = harness({ columns: 80, rows: 24 })
  h.handle.setSnapshot(snapshot({ projectionError }))
  await h.paint()
  let view = h.view()
  const line = view.split('\n').find(candidate => candidate.includes('Session details unavailable:'))
  assert.ok(line !== undefined, `the projection error status is missing:\n${view}`)
  assert.ok(line.includes('projection-'), 'the readable projection error prefix paints')
  assert.ok(!line.includes('TAIL'), 'the wide status still truncates what does not fit')
  assert.ok(visibleWidth(line.trimEnd()) <= 80, `the projection status exceeds its width:\n${line}`)
  h.vt.resize(44, 24)
  await h.paint()
  view = h.view()
  const squeezed = view.split('\n').find(candidate => candidate.includes('Session details unavailable:'))
  assert.ok(squeezed !== undefined && squeezed.trimEnd().endsWith('…'), `the compact projection status marks truncation:\n${view}`)
  for (const painted of h.vt.getViewport()) {
    assert.ok(visibleWidth(painted) <= 44, `a painted compact row overflows: ${JSON.stringify(painted)}`)
  }
})

test('routine search health repaints the fixed context row without moving the body', async () => {
  const h = harness({ columns: 80, rows: 24, initialMode: 'search' })
  const results = [
    { row: row(CURRENT, 3_000, { title: 'Incident notes' }), source: 'Metadata' as const },
    { row: row(OTHER, 2_000, { title: 'Incident analysis' }), source: 'Metadata' as const },
  ]
  h.handle.setSnapshot(snapshot({ query: 'incident', searchState: 'loading', searchResults: results }), 'incident')
  await h.paint()
  let frame = panelFrame(h)
  const stableRows = {
    input: lineIndexOf(frame, 'Search: incident'),
    firstResult: lineIndexOf(frame, 'Incident notes'),
    footer: lineIndexOf(frame, 'Back [Esc]'),
  }
  assert.ok(frame[1]!.includes('Searching content…'), `loading health lives in the context row:\n${frame.join('\n')}`)
  assert.ok(!frame.some(line => line.includes('Searching sessions…')), 'no routine loading status row is added')

  h.handle.setSnapshot(snapshot({ query: 'incident', searchState: 'unavailable', searchResults: results }))
  await h.paint()
  frame = panelFrame(h)
  assert.ok(frame[1]!.includes('Metadata only'), `unavailable health lives in the context row:\n${frame.join('\n')}`)
  assert.deepEqual({
    input: lineIndexOf(frame, 'Search: incident'),
    firstResult: lineIndexOf(frame, 'Incident notes'),
    footer: lineIndexOf(frame, 'Back [Esc]'),
  }, stableRows, 'a routine health update never moves the input, first result or footer')

  h.handle.setSnapshot(snapshot({ query: 'incident', searchState: 'ready', searchResults: results }))
  await h.paint()
  frame = panelFrame(h)
  assert.ok(frame[1]!.includes('Esc back'), `ready health returns the plain context row:\n${frame.join('\n')}`)
  assert.deepEqual({
    input: lineIndexOf(frame, 'Search: incident'),
    firstResult: lineIndexOf(frame, 'Incident notes'),
    footer: lineIndexOf(frame, 'Back [Esc]'),
  }, stableRows, 'ready never reflows the result body')

  // A REAL provider failure is the one legal extra physical row.
  h.handle.setSnapshot(snapshot({ query: 'incident', searchState: 'error', searchError: 'boom', searchResults: results }))
  await h.paint()
  frame = panelFrame(h)
  assert.ok(frame[1]!.includes('Search failed'), `the error is also stated in the context row:\n${frame.join('\n')}`)
  assert.equal(lineIndexOf(frame, 'Incident notes'), stableRows.firstResult + 1,
    'only the real diagnostic row moves the body')
})

test('an empty search paints one truthful inert placeholder for every stage', async () => {
  const h = harness({ columns: 80, rows: 24, initialMode: 'search' })
  const setEmpty = async (overrides: Partial<SessionBrowserReadSnapshot>): Promise<string> => {
    h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: [], ...overrides }), 'needle')
    await h.paint()
    return h.view()
  }
  const assertSingleEmptyRow = (painted: string, text: string): void => {
    assert.equal(painted.split('\n').filter(line => line.includes(text)).length, 1,
      `exactly one ${JSON.stringify(text)} row is painted:\n${painted}`)
    const frame = panelFrame(h)
    assert.equal(lineIndexOf(frame, text), lineIndexOf(frame, 'Search: needle') + 1,
      `the single ${JSON.stringify(text)} row owns the first empty result row without shifting the body`)
  }

  let view = await setEmpty({ searchState: 'loading' })
  assert.ok(view.includes('Searching message content…'), `a pending content search never claims zero:\n${view}`)
  assert.ok(!view.includes('No matching sessions'), 'a pending search never asserts a final no-match')

  view = await setEmpty({ searchState: 'ready' })
  assert.ok(view.includes('No matching sessions'), `a completed search states its bounded no-match:\n${view}`)
  const emptyRow = lineIndexOf(panelFrame(h), 'No matching sessions')
  await clickCell(h, 10, emptyRow)
  assert.deepEqual(h.resumes, [], 'the empty state is inert, never a result target')
  assert.equal(h.closes, 0)

  view = await setEmpty({ searchState: 'unavailable' })
  assert.ok(view.includes('No metadata matches'), `unavailable only claims the metadata boundary:\n${view}`)
  assert.ok(!view.includes('No matching sessions'), 'unavailable never claims no Session message matched')

  view = await setEmpty({ searchState: 'error', searchError: 'fts boom' })
  assert.ok(view.includes('No metadata matches'), `an error still preserves the metadata-only result fact:\n${view}`)
  assert.ok(view.includes('Search failed: fts boom'), 'the real error reason keeps its own row')

  view = await setEmpty({ listState: 'loading', searchResults: [] })
  assertSingleEmptyRow(view, 'Loading sessions…')
  assert.ok(!view.includes('No matching sessions'), 'a loading roster never claims zero Sessions')
  assert.ok(!view.includes('session persistence unavailable'), 'a loading roster is not also called unavailable')

  view = await setEmpty({ listState: 'unavailable', searchResults: [] })
  assertSingleEmptyRow(view, 'Session list unavailable')
  assert.ok(!view.includes('No matching sessions'), 'an unavailable roster never claims zero matches')
  assert.ok(!view.includes('session persistence unavailable'), 'the roster fact is stated once in Search')

  view = await setEmpty({ listState: 'empty', rows: [], searchResults: [] })
  assertSingleEmptyRow(view, 'No readable sessions')
  assert.ok(!view.includes('No matching sessions'), 'an empty roster never claims a completed query')


  h.dispose()
  const idle = harness({ columns: 80, rows: 24, initialMode: 'search' })
  idle.handle.setSnapshot(snapshot({ query: '', searchState: 'idle', searchResults: [] }))
  await idle.paint()
  assert.ok(idle.view().includes('Type to search sessions and messages'),
    `an unstarted query invites typing instead of claiming a result:\n${idle.view()}`)
  idle.dispose()
})

test('content hits keep the full source and a readable snippet ahead of age and cwd', async () => {
  const hostile = '\x1b]0;PWNED\x07\x1b[31m'
  const h = harness({ columns: 200, rows: 50, initialMode: 'search' })
  const cwd = '/very/long/secret/workspace/path'
  const alpha = row(CURRENT, 3_000, { title: '发布 🚀 incident 记录', cwd })
  const beta = row(OTHER, 2_000, { title: 'Other incident', cwd: '/other' })
  h.handle.setSnapshot(snapshot({
    rows: [alpha, beta],
    query: 'incident',
    searchState: 'ready',
    searchResults: [
      { row: alpha, source: 'Both', snippet: `${hostile}中文摘要🚀 first visible excerpt that is long enough to truncate safely` },
      { row: beta, source: 'Content', snippet: 'another visible excerpt with its own words' },
    ],
  }), 'incident')
  await h.paint()
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [72, 24], [44, 20]] as const) {
    h.vt.resize(columns, rows)
    await h.paint()
    const frame = panelFrame(h)
    const resultLine = frame.find(line => line.includes(shortSessionId(CURRENT)) && line.includes('Both'))
    assert.ok(resultLine !== undefined, `${columns}x${rows}: the content hit paints its full source:\n${frame.join('\n')}`)
    assert.ok(resultLine.includes('…中文'), `${columns}x${rows}: a readable CJK excerpt prefix leads the row:\n${resultLine}`)
    assert.ok(!resultLine.includes(cwd), `${columns}x${rows}: cwd yields to the Host excerpt:\n${resultLine}`)
    assert.ok(!resultLine.includes('PWNED'), `${columns}x${rows}: hostile snippet payload never paints`)
    assert.ok(visibleWidth(resultLine) <= columns, `${columns}x${rows}: the result row fits its width`)
  }
  assert.ok(!h.raw().includes('\x1b]0;PWNED'), 'the injected OSC never reaches the raw terminal stream')
})

test('wide search preview follows the selected hit with its source and Host excerpt', async () => {
  const h = harness({ columns: 120, rows: 40, initialMode: 'search' })
  const alpha = row(CURRENT, 3_000, { title: 'Alpha session' })
  const beta = row(OTHER, 2_000, { title: 'Beta session' })
  h.handle.setSnapshot(snapshot({
    rows: [alpha, beta],
    query: 'needle',
    searchState: 'ready',
    searchResults: [
      { row: alpha, source: 'Content', snippet: 'alpha first sentence with enough words to wrap over more than one preview line and keep going' },
      { row: beta, source: 'Both', snippet: 'beta different excerpt' },
    ],
  }), 'needle')
  await h.paint()
  let view = h.view()
  assert.ok(view.includes('Match: Content'), `the wide preview states the selected hit source:\n${view}`)
  assert.ok(view.includes('Excerpt:'), 'a real snippet paints its excerpt label')
  assert.ok(view.includes('alpha first sentence'), 'the Host excerpt is readable in the preview')

  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  view = h.view()
  assert.ok(view.includes('Match: Both'), `the preview follows the newly selected hit:\n${view}`)
  assert.ok(view.includes('beta different excerpt'), 'the second hit shows its own Host excerpt')
  assert.ok(!view.includes('Match: Content'), 'the previous selection provenance is gone')

  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: [] }))
  await h.paint()
  assert.ok(h.view().includes('No result selected'), `an emptied result list clears the preview:\n${h.view()}`)
  assert.deepEqual(h.resumes, [], 'preview selection never resumes a Session')
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
  assert.ok(searchView.includes('current-  Alpha'), `the stable id and title prefix survive a long snippet:\n${searchView}`)
  assert.ok(searchView.includes('Content · …a very l'), `the full source and excerpt prefix outrank age/cwd:\n${searchView}`)
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
    readMarkdown: async () => ({ kind: 'unavailable' }),
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

// ── M5-U-D: groups, Reader, the full selector, the wide layout and the mouse ──

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

/** Publish the accepted EMPTY Activity sample of the current roster revision.
 *  The wheel tests target the painted body rows, so no status row may sit
 *  above them. */
function settleActivity(h: Harness): void {
  h.handle.setActivityFacts({ listRevision: 1, facts: [], answerEligibility: [] })
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

/** One real SGR wheel notch at the SAME 0-based panel cell. `up` is the fork's
 *  negative direction (the ArrowUp sign); `alt` adds the SGR Alt bit so the
 *  fork itself applies the accelerated line count. */
async function wheelCell(h: Harness, x: number, y: number, direction: 'up' | 'down', alt = false): Promise<void> {
  const button = (direction === 'up' ? 64 : 65) + (alt ? 8 : 0)
  h.vt.sendInput(`\x1b[<${button};${x + 1};${y + 1}M`)
  await h.paint()
}

/** The first physical body row of the LAST painted panel frame. */
function bodyTopRow(h: Harness): number {
  const separator = panelFrame(h).findIndex(line => line.startsWith('─'))
  assert.ok(separator >= 0, `the frame paints its body separator:\n${h.view()}`)
  return separator + 1
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
  assert.match(view, /Needs row.*‣ Needs attention · Working/, `proved Needs stays in its folder and may also be Working:\n${view}`)
  assert.match(view, /Working row.*‣ Working/, `proved running row stays inside the Workspace:\n${view}`)
  const needsLine = lineIndexOf(frame, 'Needs row')
  const workingLine = lineIndexOf(frame, 'Working row')
  const recentLine = lineIndexOf(frame, 'Recent 0')
  assert.ok(needsLine < workingLine && workingLine < recentLine,
    `active priorities stay above the ordinary history in one folder:\n${view}`)
  assert.ok(view.includes('Show more sessions · 15 remaining'), `ordinary history stays behind its per-folder watermark:\n${view}`)
  assert.ok(!view.includes('Pending · not actionable here'), 'a row behind the watermark does not inflate the activity list')
})

test('Space opens a read-only Reader: no Host write, Esc restores the browse selection, list Enter resumes', async () => {
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
  const reader = h.view()
  assert.ok(reader.includes('Transcript · other-se'), `the Reader names the stable Session id:\n${reader}`)
  assert.ok(reader.includes('Transcript session-other-session'), 'the ready body is the official Markdown read')
  assert.ok(reader.includes('Read-only committed body.'), 'the complete committed content is painted')
  assert.ok(reader.includes('Back [Esc]'), 'the Reader advertises its own exit')
  assert.ok(!/Allow|Deny|Reject|Answer/.test(reader), `Reader carries no answer form:\n${reader}`)
  assert.deepEqual(h.reads.map(read => read.sessionId), [OTHER], 'Space starts exactly ONE official read for the painted target')
  assert.deepEqual(h.resumes, [], 'opening Reader never resumes or writes anything')
  assert.deepEqual(h.queries, [], 'opening Reader never edits the search')

  h.vt.sendInput('\x1b')
  await h.paint()
  const restored = h.view()
  assert.ok(restored.includes('Up/Down move'), 'Esc returns to the browse list')
  assert.ok(/^> .*Other session/m.test(restored), `the Reader returns to the SAME selected row:\n${restored}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter after returning to the list is the ONE re-proved resume intent')
})

test('selection and Preview never read; Space starts one loading read and then shows the complete body', async () => {
  let resolveRead!: (result: SessionMarkdownReadResult) => void
  const calls: Array<{ readonly id: string; readonly signal: AbortSignal }> = []
  const h = harness({
    columns: 120,
    rows: 24,
    readMarkdown: (id, signal) => {
      calls.push({ id, signal })
      return new Promise(resolve => { resolveRead = resolve })
    },
  })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.equal(calls.length, 0, 'changing the typed selection and repainting the Preview never reads Markdown')
  assert.ok(h.view().includes('Space to read committed transcript'), 'the Preview keeps the explicit Read cue')
  h.vt.sendInput(' ')
  await h.paint()
  assert.equal(calls.length, 1, 'Space starts exactly ONE official read')
  assert.equal(calls[0]!.id, OTHER, 'the read uses the typed full Session id')
  assert.ok(h.view().includes('Reading committed transcript…'), 'the Reader first paints its honest loading state')
  assert.deepEqual(h.resumes, [], 'opening the Reader never resumes')

  resolveRead({ kind: 'ready', markdown: '# Title\n\nParagraph with **bold** text.\n\n```bash\nls\n```\n\n- one\n- two' })
  await h.paint()
  const ready = h.view()
  for (const text of ['Title', 'Paragraph with', 'bold', 'ls', 'one', 'two']) {
    assert.ok(ready.includes(text), `the full official Markdown body paints ${text}:\n${ready}`)
  }
  assert.ok(ready.includes('Transcript · other-se'), 'the Reader keeps its typed identity')
  assert.ok(ready.includes('Up/Down scroll') && ready.includes('Back [Esc]'), 'ready content advertises its real navigation')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(calls[0]!.signal.aborted, 'closing the Reader aborts its one read')
  assert.ok(h.view().includes('Up/Down move'), 'Esc returns to the list')
})

test('a live palette switch re-bakes the ready Reader Markdown ANSI', async () => {
  const h = harness({
    columns: 120,
    rows: 30,
    readMarkdown: async () => ({ kind: 'ready', markdown: '# Themed heading\n\nBody [link](https://example.com)\n' }),
  })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const rgb = (hex: string): number => Number.parseInt(hex.slice(1), 16)
  const points = (): { heading: { row: number; col: number }; link: { row: number; col: number } } => {
    const frame = panelFrame(h)
    const headingRow = lineIndexOf(frame, 'Themed heading')
    const linkRow = lineIndexOf(frame, 'link')
    return {
      heading: { row: headingRow, col: frame[headingRow]!.indexOf('Themed heading') },
      link: { row: linkRow, col: frame[linkRow]!.indexOf('link') },
    }
  }
  try {
    let point = points()
    const darkHeading = h.vt.getCellFgRgb(point.heading.row, point.heading.col)
    const darkLink = h.vt.getCellFgRgb(point.link.row, point.link.col)
    assert.equal(darkHeading, rgb(currentPalette.textStrong), 'the dark heading uses textStrong')
    assert.equal(darkLink, rgb(currentPalette.primary), 'the dark link uses primary')
    const wording = h.view()

    h.app.applyTheme('light')
    await h.paint()
    point = points()
    const lightHeading = h.vt.getCellFgRgb(point.heading.row, point.heading.col)
    const lightLink = h.vt.getCellFgRgb(point.link.row, point.link.col)
    assert.equal(h.view(), wording, 'a palette switch changes ANSI, never the Markdown wording or layout')
    assert.equal(lightHeading, rgb(currentPalette.textStrong), 'the ready heading is re-baked in the LIGHT palette')
    assert.equal(lightLink, rgb(currentPalette.primary), 'the ready link is re-baked in the LIGHT palette')
    assert.notEqual(lightHeading, darkHeading, 'the heading really changed colour')
    assert.notEqual(lightLink, darkLink, 'the link really changed colour')

    h.app.applyTheme('dark')
    await h.paint()
    point = points()
    assert.equal(h.vt.getCellFgRgb(point.heading.row, point.heading.col), darkHeading,
      'switching back re-bakes the SAME Markdown component in the original palette')
  } finally {
    h.app.applyTheme('dark')
    h.dispose()
  }
})

test('none, unavailable and a real rejection are distinct, inert states with a real Back', async () => {
  const scenarios = [
    {
      name: 'none',
      read: async (): Promise<SessionMarkdownReadResult> => ({ kind: 'none' }),
      text: 'No committed transcript found for this Session.',
    },
    {
      name: 'unavailable',
      read: async (): Promise<SessionMarkdownReadResult> => ({ kind: 'unavailable' }),
      text: 'Committed transcript unavailable.',
    },
    {
      name: 'error',
      read: async (): Promise<SessionMarkdownReadResult> => { throw new Error('permission denied') },
      text: 'Transcript read failed: permission denied',
    },
  ] as const
  for (const scenario of scenarios) {
    const h = harness({ columns: 100, rows: 24, readMarkdown: scenario.read })
    h.handle.setSnapshot(snapshot())
    await h.paint()
    h.vt.sendInput('\x1b[B')
    await h.paint()
    h.vt.sendInput(' ')
    await h.paint()
    const view = h.view()
    assert.ok(view.includes(scenario.text), `${scenario.name} paints its own truthful state:\n${view}`)
    assert.ok(!view.includes('Title:') && !view.includes('Read-only committed body.'), `${scenario.name} never invents transcript content`)
    assert.ok(view.includes('Back [Esc]'), `${scenario.name} keeps the real Back`)
    assert.equal(h.reads.length, 1, `${scenario.name} is one attempt, not an automatic retry`)
    h.vt.sendInput('\x1b')
    await h.paint()
    assert.ok(!h.view().includes('Transcript · other-se'), `${scenario.name} Back returns to the list`)
    assert.deepEqual(h.resumes, [], `${scenario.name} never resumes`)
    h.dispose()
  }
})

test('a hostile long Reader error is bounded before wrapping and still exposes Back', async () => {
  const body = `${'remote 500 body '.repeat(20_000)}TAIL-MUST-NOT-PAINT`
  const h = harness({
    columns: 44,
    rows: 20,
    readMarkdown: async () => { throw new Error(body) },
  })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Transcript read failed:'), `the real error prefix survives the summary bound:\n${view}`)
  assert.ok(view.includes('…'), `the bounded summary marks its truncation:\n${view}`)
  assert.ok(!view.includes('TAIL-MUST-NOT-PAINT'), 'the unbounded tail is never painted')
  assert.ok(view.includes('Back [Esc]'), 'the bounded failure keeps the real Back')
  h.dispose()
})

test('a late Reader result after close is inert and the captured signal is aborted', async () => {
  let resolveRead!: (result: SessionMarkdownReadResult) => void
  let signal: AbortSignal | undefined
  const h = harness({
    columns: 100,
    rows: 24,
    readMarkdown: (_id, inputSignal) => {
      signal = inputSignal
      return new Promise(resolve => { resolveRead = resolve })
    },
  })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(signal?.aborted, true, 'closing the Reader aborts the captured signal')
  resolveRead({ kind: 'ready', markdown: '# LATE\n\nmust never paint' })
  await h.paint()
  assert.ok(!h.view().includes('LATE'), `a late ready result never repaints the list:\n${h.view()}`)
  assert.deepEqual(h.resumes, [], 'a late result never resumes')
  assert.equal(h.closes, 0, 'a late result never closes the Browser')
})

test('closing the Sessions lease aborts an in-flight Reader read and releases the document', async () => {
  let resolveRead!: (result: SessionMarkdownReadResult) => void
  let signal: AbortSignal | undefined
  const h = harness({
    columns: 100,
    rows: 24,
    readMarkdown: (_id, inputSignal) => {
      signal = inputSignal
      return new Promise(resolve => { resolveRead = resolve })
    },
  })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  h.handle.close()
  assert.equal(signal?.aborted, true, 'the lease close aborts the Reader controller')
  resolveRead({ kind: 'ready', markdown: '# LATE\n\nmust never paint' })
  await h.paint()
  assert.ok(!h.view().includes('LATE'), 'a result settling after lease close is inert')
  assert.equal(h.handle.isDisposed(), true)
})

test('the Reader capacity cap never paints a truncated transcript', async () => {
  const sourceTooLarge = harness({
    columns: 44,
    rows: 20,
    readMarkdown: async () => ({ kind: 'ready', markdown: 'x'.repeat(4_194_305) }),
  })
  sourceTooLarge.handle.setSnapshot(snapshot())
  await sourceTooLarge.paint()
  sourceTooLarge.vt.sendInput('\x1b[B')
  await sourceTooLarge.paint()
  sourceTooLarge.vt.sendInput(' ')
  await sourceTooLarge.paint()
  assert.ok(sourceTooLarge.view().replace(/\s+/g, ' ').includes('Transcript too large to display here. No content was truncated.'),
    `the 4 Mi source cap is stated whole even at 44 columns:\n${sourceTooLarge.view()}`)
  assert.ok(!sourceTooLarge.view().includes('xxxxxxxxxx'), 'no prefix of the oversized source is painted')
  assert.ok(sourceTooLarge.view().includes('Back [Esc]'), 'the too-large state is still escapable')
  sourceTooLarge.dispose()

  const rowsTooLarge = harness({
    columns: 100,
    rows: 24,
    readMarkdown: async () => ({
      kind: 'ready',
      markdown: Array.from({ length: 100_001 }, (_, index) => `- line ${index}`).join('\n'),
    }),
  })
  rowsTooLarge.handle.setSnapshot(snapshot())
  await rowsTooLarge.paint()
  rowsTooLarge.vt.sendInput('\x1b[B')
  await rowsTooLarge.paint()
  rowsTooLarge.vt.sendInput(' ')
  await rowsTooLarge.paint()
  assert.ok(rowsTooLarge.view().includes('Transcript too large to display here. No content was truncated.'),
    `the 100,000-row cap is enforced after the real render:\n${rowsTooLarge.view()}`)
  assert.ok(!rowsTooLarge.view().includes('line 0'), 'no rendered prefix is presented as the complete transcript')
  rowsTooLarge.dispose()
})

test('Reader keeps whole-width content and the Back row across the frozen size matrix', async () => {
  const markdown = `## 标题 🚀\n\n${'可读正文 '.repeat(120)}\n\n\`\`\`bash\nls\n\`\`\``
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
    const h = harness({ columns, rows, readMarkdown: async () => ({ kind: 'ready', markdown }) })
    h.handle.setSnapshot(snapshot())
    await h.paint()
    h.vt.sendInput(' ')
    await h.paint()
    const frame = panelFrame(h)
    const view = frame.join('\n')
    assert.ok(frame[0]!.includes('Sessions'), `${columns}x${rows} keeps the Sessions identity`)
    assert.ok(!frame[0]!.includes('/ Search'), `${columns}x${rows} paints no Search target inside the Reader`)
    assert.ok(view.includes('Transcript · curren'), `${columns}x${rows} keeps the Reader context`)
    assert.ok(view.includes('Read-only'), `${columns}x${rows} keeps the whole read-only fact even when a trailing segment yields`)
    assert.ok(view.includes('标题'), `${columns}x${rows} paints the official CJK content`)
    assert.ok(frame[frame.length - 1]!.includes('Back [Esc]'), `${columns}x${rows} keeps the physical Back row`)
    assert.ok(!view.includes('Space to read committed transcript'), `${columns}x${rows} paints no right Preview`)
    for (const line of frame.concat(h.vt.getViewport())) {
      assert.ok(visibleWidth(stripTerminalSequences(line)) <= columns,
        `${columns}x${rows} keeps every painted Reader cell inside the width: ${JSON.stringify(line)}`)
    }
    h.dispose()
  }
})

test('Reader content is sanitized while Markdown structure, controls and tables survive', async () => {
  const markdown = '# Head\n\nhello \u001b[31mred\u001b]0;evil\u0007 world \u009b2J\n\n```ts\nconst x = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n中文 🚀'
  const h = harness({ columns: 100, rows: 30, readMarkdown: async () => ({ kind: 'ready', markdown }) })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('hello red world'), `the visible prose is preserved without controls:\n${view}`)
  assert.ok(view.includes('const x = 1') && view.includes('中文') && view.includes('🚀'), 'markdown/code/CJK/emoji survive projection')
  assert.ok(!h.raw().includes('evil'), 'OSC payload bytes never reach the frame stream')
  assert.ok(!h.raw().includes('\u009b2J'), 'C1 controls never reach the frame stream')
})

test('Search input space stays text; Search Results Space opens the Reader', async () => {
  const h = harness({
    columns: 100,
    rows: 24,
    initialMode: 'search',
    readMarkdown: async () => ({ kind: 'ready', markdown: '# Search result\n\nbody' }),
  })
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [{ row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle' }],
  }), 'needle')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  assert.equal(h.reads.length, 0, 'a Space typed in the Search editor never reads a transcript')
  assert.ok(h.queries.at(-1) === 'needle ', 'the Space is ordinary query text')
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Open [Enter]') && h.view().includes('Read [Space]'), 'the real result owns the Read action')
  h.vt.sendInput(' ')
  await h.paint()
  assert.deepEqual(h.reads.map(read => read.sessionId), [OTHER], 'Space in the results reads the typed hit')
  assert.ok(h.view().includes('Transcript · other-se'), 'the Search Result Reader opens')
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
  assert.ok(wide.includes('Space to read committed transcript'), `the wide layout paints a preview pane:\n${wide}`)
  assert.ok(wide.includes('Sessions · 2'), 'the list pane stays beside the preview')
  h.vt.resize(80, 24)
  await h.paint()
  assert.ok(!panelFrame(h).join('\n').includes('Space to read committed transcript'),
    'a narrow terminal never splits into two columns')
  // A short narrow frame still opens Reader and keeps its ONE Esc exit usable.
  h.vt.resize(80, 10)
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const short = h.view()
  assert.ok(short.includes('Transcript ·'), `Reader opens on a short terminal:\n${short}`)
  const frame = panelFrame(h)
  assert.ok(frame[frame.length - 1]!.includes('Esc'), 'the Esc action stays the last physical row')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(h.view().includes('Sessions ·'), 'Esc leaves Reader even at 80x10')
  assert.deepEqual(h.resumes, [], 'no invisible row was activated while Reader was open')
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
  assert.match(proved, /Other session.*‣ Needs attention/, `the proved need is painted at once:\n${proved}`)
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

test('a Reader is pinned to its own Session and exits when that Session leaves the roster', async () => {
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
  assert.ok(h.view().includes('Transcript · other-se'), 'the Reader names its own Session')
  const readSignal = h.reads[0]?.signal
  // The refresh drops the read Session and re-anchors the list selection: the
  // Reader must exit and abort its one read instead of silently showing the
  // next selected Session.
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' })] }))
  await h.paint()
  const view = h.view()
  assert.ok(!view.includes('Transcript ·'), `the Reader exits when its target is gone:\n${view}`)
  assert.equal(readSignal?.aborted, true, 'the removed target aborts the captured Markdown read')
  assert.ok(!view.includes('Other session'), 'the removed Session never paints')
  assert.ok(/^> .*Current session/m.test(view), 'the list selection re-anchored on a listed row')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'the Reader exit never resumes any Session')
})

test('a Reader opened from search results also exits when its target leaves the results', async () => {
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
  assert.ok(h.view().includes('Transcript · other-se'), `the Search Reader opens:\n${h.view()}`)
  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: [] }))
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), `the Reader exits when the result is gone:\n${h.view()}`)
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

test('compact Working rows omit unknown pending spam', async () => {
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
  assert.equal(view.split('‣ Working').length - 1, 3, `all three running rows retain the Working summary:\n${view}`)
  assert.ok(!view.includes('Pending denied') && !view.includes('Pending unknown') && !view.includes('Pending unavailable'),
    `compact rows do not repeat unknown/unanswerable pending state:\n${view}`)
})

test('the Reader opens the exact selected Session official Markdown', async () => {
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
  const reader = h.view()
  assert.ok(reader.includes('Transcript · other-se'), `the Reader is pinned to the selected Session:\n${reader}`)
  assert.deepEqual(h.reads.map(read => read.sessionId), [OTHER], 'the official Port receives the full typed Session id')
  assert.ok(reader.includes(`Transcript ${OTHER}`), 'the ready body is the official Markdown read')
  assert.ok(reader.includes('Read-only committed body.'), 'the complete committed content is painted in the Reader')
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

test('same-title Workspaces use unique Host path tails in Folder rows and Preview', async () => {
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
  const selected = h.view()
  assert.ok(selected.includes('Path: /ws/2'),
    `the read-only Preview resolves the selected duplicate to its own Host path:\n${selected}`)
  assert.equal(h.reads.length, 0, 'a Folder selection never starts a Markdown read')
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

test('Show more reveals one painted page and selects the first new history row', async () => {
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
  // history rows, then seven Down presses reach the Show-more watermark.
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
  assert.ok(after.includes('History 6'), `Show more reveals the whole painted page from the current watermark:\n${after}`)
  assert.ok(/^> .*History 6/m.test(after), 'the cursor lands on the first newly revealed history row')
  assert.ok(!after.includes('History 16'), 'the reveal is bounded by the painted page size')
  assert.ok(!after.includes('Show more sessions'), 'the page exhausted the remaining history')
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

test('the typed selection drives Preview, Enter and Space; Folder selection never keeps a stale Session Reader', async () => {
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
  assert.ok(!view.includes('Space to read committed transcript'), 'a Folder has no Session preview')
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'Space on a Folder never opens a stale Session Reader')
  // Expand with Right, then click the Session row (the disclosure toggle has
  // its own chooser regression).
  h.vt.sendInput('\x1b[C')
  await h.paint()
  const otherLine = lineIndexOf(panelFrame(h), 'Other session')
  await clickCell(h, 8, otherLine)
  view = h.view()
  assert.ok(/^> .*Other session/m.test(view), 'a Session click selects only')
  assert.ok(view.includes('Space to read committed transcript'), 'the preview follows the Session target')
  assert.deepEqual(h.resumes, [], 'a Session click never resumes')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter opens the selected Session')
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Transcript · other-se'), 'Space reads the selected Session')
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
  assert.ok(!lines[lines.length - 1]!.includes('Read [Space]'), 'a Folder advertises no Reader')
  assert.ok(lines[lines.length - 1]!.includes('Close [Esc]'), 'Esc is always the last segment')
  // Select the Session row: Footer advertises Open + Reader; the row keeps ●.
  h.vt.sendInput('\r') // re-expand Alpha
  await h.paint()
  h.vt.sendInput('\x1b[B') // New session
  await h.paint()
  h.vt.sendInput('\x1b[B') // the current Session row
  await h.paint()
  lines = h.view().split('\n')
  assert.ok(!lines[lines.length - 1]!.includes('Open [Enter]'),
    'the opened Session never advertises the deliberate no-op Enter')
  assert.ok(lines[lines.length - 1]!.includes('Read [Space]'), 'the opened Session still advertises its Reader')
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
  assert.ok(lines[lines.length - 1]!.includes('Open [Enter]') && lines[lines.length - 1]!.includes('Read [Space]'),
    'a non-current Session advertises Open and Reader')
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

test('Reader is pinned to a Session row and refuses Folder targets', async () => {
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
  // Folders never open a Reader.
  h.vt.sendInput('\t')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'Space on a Folder is a no-op')
  assert.equal(h.reads.length, 0, 'a Folder never starts a Markdown read')
  // Open the Session Reader and read the full identity.
  h.vt.sendInput('\x1b[C')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const reader = h.view()
  assert.ok(reader.includes('Transcript · other-se'), `Reader opens for the selected Session row:\n${reader}`)
  assert.deepEqual(h.reads.map(read => read.sessionId), [OTHER],
    'the full typed Session id, not the short header label, is the Markdown read target')
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
  assert.equal(squeezed.closes, 0, 'the withheld Enter can never return through an unpainted current row')
  squeezed.app.dispose()
  started.delete(squeezed.app)

  // The same 3-row frame WITH a painted row advertises the real verb and keeps
  // Esc last; the current Session advertises Return, never Open.
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
  assert.ok(footer.includes('Return [Enter]') && !footer.includes('Open [Enter]'),
    `the current row advertises Return:\n${footer}`)
  assert.ok(footer.includes('Read [Space]'), `the current row still advertises Reader:\n${footer}`)
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

test('a current Session search hit advertises Return and its second Enter returns', async () => {
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
  assert.ok(footer.includes('Read [Space]'), `the current result still advertises Reader:\n${footer}`)
  assert.ok(footer.includes('Return [Enter]'), `the current result advertises its real Return:\n${footer}`)
  assert.ok(!footer.includes('Open [Enter]'), `the current result never advertises Open:\n${footer}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Return on the current search hit never resumes')
  assert.equal(h.closes, 1, 'Return on the current search hit closes the Browser once')
  assert.equal(h.handle.isDisposed(), true)
  assert.equal(h.app.isFullscreen(), false)
})

test('the current Session Reader Enter is inert; Escape returns to the list Return', async () => {
  const h = harness({ columns: 120, rows: 30 })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Transcript · curren'), `the current Session Reader opens:\n${view}`)
  assert.ok(!view.includes('Open [Enter]') && !view.includes('Return [Enter]'),
    `the Reader advertises no Session activation:\n${view}`)
  assert.ok(view.includes('Back [Esc]'), 'the Reader Back stays on the ONE global bar')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Enter inside the current Reader never resumes')
  assert.equal(h.closes, 0, 'Enter inside the Reader never closes the Browser')
  assert.ok(h.view().includes('Transcript · curren'), 'Enter leaves the Reader on its exact Session')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'Esc closes only the Reader layer')
  await clickBarAction(h, 'Return [Enter]')
  assert.equal(h.closes, 1, 'the list Return remains the ONE explicit current-Session return')
})

test('current Reader Space and Esc back out without switching or closing', async () => {
  const h = harness({ columns: 120, rows: 30 })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Transcript · curren'))
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'Space still closes the Reader layer')
  assert.ok(h.view().includes('Return [Enter]'), 'the browse Return is back')
  assert.equal(h.closes, 0, 'Space on the Reader never closes the Browser')
  assert.deepEqual(h.resumes, [])
  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Transcript · curren'))
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'Esc still closes the Reader layer')
  assert.equal(h.closes, 0, 'Esc on the Reader never closes the Browser')
  assert.deepEqual(h.resumes, [])
})

test('a non-current Reader Enter is inert; return to the list keeps its one Resume', async () => {
  const h = harness({ columns: 120, rows: 30 })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const footer = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(!footer.includes('Open [Enter]') && !footer.includes('Return [Enter]'),
    `the non-current Reader advertises no Session activation:\n${footer}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Enter inside the Reader never resumes')
  assert.equal(h.closes, 0)
  h.vt.sendInput('\x1b')
  await h.paint()
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'the list Enter remains the ONE guarded Resume')
})

test('painted Return leaves the two lists and the Reader Back stays local', async () => {
  const browse = harness()
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  await clickBarAction(browse, 'Return [Enter]')
  assert.equal(browse.closes, 1, 'the Browse Return press+release closes the Browser once')
  assert.deepEqual(browse.resumes, [], 'the Browse Return never emits a Resume')
  assert.equal(browse.handle.isDisposed(), true)
  browse.app.dispose()
  started.delete(browse.app)

  const results = harness({ columns: 100, rows: 24, initialMode: 'search' })
  results.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [
      { row: row(CURRENT, 3_000, { title: 'Current session' }), source: 'Both', snippet: 'needle current' },
      { row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle other' },
    ],
  }), 'needle')
  await results.paint()
  results.vt.sendInput('\r') // editor -> the first (current) result
  await results.paint()
  await clickBarAction(results, 'Return [Enter]')
  assert.equal(results.closes, 1, 'the Search-results Return press+release closes the Browser once')
  assert.deepEqual(results.resumes, [])
  results.app.dispose()
  started.delete(results.app)

  const reader = harness({ columns: 120, rows: 30 })
  reader.handle.setSnapshot(snapshot())
  await reader.paint()
  reader.vt.sendInput(' ')
  await reader.paint()
  await clickBarAction(reader, 'Back [Esc]')
  assert.equal(reader.closes, 0, 'the Reader Back press+release closes only the Reader')
  assert.ok(!reader.view().includes('Transcript ·'), 'the Reader layer is gone')
  await clickBarAction(reader, 'Return [Enter]')
  assert.equal(reader.closes, 1, 'the list Return still closes the Browser once')
  assert.deepEqual(reader.resumes, [])
  reader.app.dispose()
  started.delete(reader.app)
})

test('a current Session row click only selects; the painted bar is the only Return', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  const frame = panelFrame(h)
  await clickCell(h, 4, lineIndexOf(frame, '● current-'))
  assert.equal(h.closes, 0, 'a Session row click never returns to a session')
  assert.deepEqual(h.resumes, [], 'a Session row click never resumes another session')
  assert.ok(/^> {3}● current-/m.test(h.view()), `the click only moved the selection:\n${h.view()}`)
  await clickBarAction(h, 'Return [Enter]')
  assert.equal(h.closes, 1, 'the painted Return bar segment is the one return action')
})

test('a Return press invalidated by a resize cannot act on release', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  const frame = panelFrame(h)
  const bar = frame[frame.length - 1]!
  const x = bar.indexOf('Return [Enter]') + 2
  const y = frame.length
  h.vt.sendInput(`\x1b[<0;${x};${y}M`)
  await h.paint()
  h.vt.resize(90, 28)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x};${y}m`)
  await h.paint()
  assert.equal(h.closes, 0, 'a stale press revision drops the release without a Return')
  assert.deepEqual(h.resumes, [])
  await clickBarAction(h, 'Return [Enter]')
  assert.equal(h.closes, 1, 'a fresh press+release on the repainted frame still returns')
})

test('an old Return click and its handle never close a newer Browser', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  const frame = panelFrame(h)
  const bar = frame[frame.length - 1]!
  const x = bar.indexOf('Return [Enter]') + 2
  const y = frame.length
  h.vt.sendInput(`\x1b[<0;${x};${y}M`)
  await h.paint()
  h.handle.close()
  let secondCloses = 0
  const second = h.app.openSessionWorkspace({
    subject: { currentSessionId: CURRENT, currentCwd: '/ws/project', isCurrent: () => true },
    onQueryChange: () => {},
    onResume: () => {},
    readMarkdown: async () => ({ kind: 'unavailable' }),
    onClose: () => { secondCloses += 1 },
    initialMode: 'browse',
    initialBrowseScope: 'all',
  })
  second.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x};${y}m`)
  await h.paint()
  assert.equal(secondCloses, 0, 'a press held by the retired panel never activates the newer Browser')
  assert.equal(second.isDisposed(), false, 'the newer Browser stays open')
  await clickBarAction(h, 'Return [Enter]')
  assert.equal(secondCloses, 1, 'the newer Browser still owns its own Return')
  second.close()
})

test('Return is withheld while pending, empty, or without a painted listed current row', async () => {
  const pending = harness()
  pending.handle.setSnapshot(snapshot({ resumePending: true }))
  await pending.paint()
  let footer = panelFrame(pending)[panelFrame(pending).length - 1]!
  assert.ok(!footer.includes('Return [Enter]') && !footer.includes('Open [Enter]'),
    `a pending switch advertises no activation:\n${footer}`)
  pending.vt.sendInput('\r')
  await pending.paint()
  assert.equal(pending.closes, 0, 'a pending switch never returns through Enter')
  assert.deepEqual(pending.resumes, [])
  pending.app.dispose()
  started.delete(pending.app)

  const empty = harness()
  empty.handle.setSnapshot(snapshot({ listState: 'empty', rows: [] }))
  await empty.paint()
  empty.vt.sendInput('\r')
  await empty.paint()
  assert.equal(empty.closes, 0, 'an empty roster never returns through a leftover cursor')
  assert.deepEqual(empty.resumes, [])
  empty.app.dispose()
  started.delete(empty.app)

  const squeezed = harness({ columns: 80, rows: 24 })
  squeezed.handle.setSnapshot(snapshot())
  await squeezed.paint()
  squeezed.handle.setSnapshot(snapshot({ projectionError: 'projection failed' }))
  squeezed.vt.resize(80, 3)
  await squeezed.paint()
  footer = panelFrame(squeezed)[panelFrame(squeezed).length - 1]!
  assert.ok(!footer.includes('Return [Enter]'), `an unpainted current row advertises no Return:\n${footer}`)
  squeezed.vt.sendInput('\r')
  await squeezed.paint()
  assert.equal(squeezed.closes, 0, 'a stale cursor on an unpainted current row never returns')
  assert.deepEqual(squeezed.resumes, [])
})

test('Return stays readable, clickable and inside the frame at the frozen sizes', async () => {
  for (const [columns, rows] of [[120, 40], [80, 10], [44, 20]] as const) {
    const h = harness({ columns, rows })
    h.handle.setSnapshot(snapshot())
    await h.paint()
    const frame = panelFrame(h)
    assert.ok(frame.length <= rows, `${columns}x${rows}: the frame fits its budget`)
    for (const line of frame) {
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows}: no overflow: ${JSON.stringify(line)}`)
    }
    const bar = frame[frame.length - 1]!
    // The existing whole-segment layout may fall back to its short form on a
    // narrow bar; the segment must still be a complete, real Return verb.
    assert.ok(/\bReturn\b/u.test(bar), `${columns}x${rows}: Return is painted:\n${bar}`)
    assert.ok(bar.includes('Close [Esc]'), `${columns}x${rows}: Esc stays last:\n${bar}`)
    const x = bar.indexOf('Return') + 1
    await clickCell(h, x, frame.length - 1)
    assert.equal(h.closes, 1, `${columns}x${rows}: the painted Return really closes once`)
    assert.deepEqual(h.resumes, [])
    h.app.dispose()
    started.delete(h.app)
  }
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
    readMarkdown: async () => ({ kind: 'unavailable' }),
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
  assert.ok(!footer.includes('Open [Enter]') && !footer.includes('Read [Space]'),
    `no blocked session action is advertised while pending:\n${footer}`)
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  footer = panelFrame(browse)[panelFrame(browse).length - 1]!
  assert.ok(footer.includes('Open [Enter]') && footer.includes('Read [Space]'),
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
  assert.ok(!footer.includes('Open [Enter]') && !footer.includes('Read [Space]'),
    `search results advertise no blocked action while pending:\n${footer}`)
  results.handle.setSnapshot(searchSnapshot)
  await results.paint()
  footer = panelFrame(results)[panelFrame(results).length - 1]!
  assert.ok(footer.includes('Open [Enter]') && footer.includes('Read [Space]'), 'search actions return after settlement')
  results.app.dispose()
  started.delete(results.app)

  const reader = harness({ columns: 120, rows: 30 })
  reader.handle.setSnapshot(snapshot())
  await reader.paint()
  reader.vt.sendInput('\x1b[B')
  await reader.paint()
  reader.vt.sendInput(' ')
  await reader.paint()
  reader.handle.setSnapshot(snapshot({ resumePending: true }))
  await reader.paint()
  footer = panelFrame(reader)[panelFrame(reader).length - 1]!
  assert.ok(!footer.includes('Open [Enter]') && !footer.includes('Read [Space]'),
    `Reader advertises no Session activation while a switch pends:\n${footer}`)
  assert.ok(footer.includes('Back [Esc]'), 'the Reader back stays available while a switch pends')
  reader.handle.setSnapshot(snapshot())
  await reader.paint()
  footer = panelFrame(reader)[panelFrame(reader).length - 1]!
  assert.ok(!footer.includes('Open [Enter]') && !footer.includes('Read [Space]') && footer.includes('Back [Esc]'),
    'a settled switch does not turn the Reader into a list action bar')
  reader.vt.sendInput('\x1b')
  await reader.paint()
  footer = panelFrame(reader)[panelFrame(reader).length - 1]!
  assert.ok(footer.includes('Open [Enter]') && footer.includes('Read [Space]'),
    'returning to the list restores its settled actions')
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

test('Preview and Reader keep one truthful pending admission', async () => {
  const browse = harness({ columns: 120, rows: 30 })
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  browse.vt.sendInput('\x1b[B')
  await browse.paint()
  browse.handle.setSnapshot(snapshot({ resumePending: true }))
  await browse.paint()
  let view = browse.view()
  assert.ok(!view.includes('Space to read committed transcript'), `the Preview hides the blocked Reader cue:\n${view}`)
  assert.ok(!view.includes('Open [Enter]') && !view.includes('Read [Space]'), 'the Footer hides both blocked verbs')
  browse.handle.setSnapshot(snapshot())
  await browse.paint()
  assert.ok(browse.view().includes('Space to read committed transcript'), 'the Preview cue returns after settlement')
  browse.app.dispose()
  started.delete(browse.app)

  const reader = harness({ columns: 120, rows: 30 })
  reader.handle.setSnapshot(snapshot())
  await reader.paint()
  reader.vt.sendInput('\x1b[B')
  await reader.paint()
  reader.vt.sendInput(' ')
  await reader.paint()
  reader.handle.setSnapshot(snapshot({ resumePending: true }))
  await reader.paint()
  view = reader.view()
  assert.ok(!view.includes('Open [Enter]') && !view.includes('Read [Space]'),
    `the Reader hides every blocked Session action:\n${view}`)
  assert.ok(view.includes('Back [Esc]'), 'the real exit stays on the ONE global bar')
  reader.handle.setSnapshot(snapshot())
  await reader.paint()
  assert.ok(!reader.view().includes('Open [Enter]') && !reader.view().includes('Read [Space]'),
    'a settled switch does not expose list actions inside the Reader')
  reader.app.dispose()
  started.delete(reader.app)

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

test('the painted Read bar opens the Reader; its body is inert and scrolls by the real viewport', async () => {
  const markdown = [...Array.from({ length: 40 }, (_, index) => `- item ${String(index).padStart(2, '0')}`)].join('\n')
  const h = harness({ columns: 100, rows: 8, readMarkdown: async () => ({ kind: 'ready', markdown }) })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  const browseBar = panelFrame(h)[panelFrame(h).length - 1]!
  assert.ok(browseBar.includes('Read [Space]') && browseBar.includes('Close [Esc]'),
    `the Browse bar is the ONE physical bar:\n${browseBar}`)
  assert.equal(visibleWidth(browseBar), 100, 'the painted bar keeps the historical full-row width')
  await clickBarAction(h, 'Read [Space]')
  let view = h.view()
  assert.ok(view.includes('Transcript · other-se'), `the bar Read opens the committed body:\n${view}`)
  assert.ok(view.includes('item 00'), 'the first official Markdown row is painted')
  assert.ok(!view.includes('Space close') && !view.includes('Esc back'),
    'the Reader body carries no local action row')
  assert.ok(panelFrame(h)[panelFrame(h).length - 1]!.includes('Back [Esc]'),
    'the ONE global bar owns the Reader Back')
  // Body content is read-only: a click never closes the Reader or resumes.
  await clickCell(h, 2, 5)
  assert.ok(h.view().includes('Transcript · other-se'), 'a body click never closes the Reader')
  assert.deepEqual(h.resumes, [], 'opening and clicking the body never resumes')
  const readerBar = panelFrame(h)[panelFrame(h).length - 1]!
  const separator = readerBar.indexOf(' · ')
  assert.ok(separator >= 0, `the Reader bar separates its segments:\n${readerBar}`)
  await clickCell(h, separator + 1, panelFrame(h).length - 1)
  assert.ok(h.view().includes('Transcript · other-se'), 'the bar separator is decoration, never a target')
  assert.deepEqual(h.resumes, [], 'the separator cell never resumes')
  // PageDown pages by the REAL painted body height (three rows), and repeated
  // presses clamp at the last full page instead of inventing a blank tail.
  h.vt.sendInput('\x1b[6~')
  await h.paint()
  assert.ok(!h.view().includes('item 00'), `PageDown advances a real page:\n${h.view()}`)
  for (let step = 0; step < 20; step += 1) {
    h.vt.sendInput('\x1b[6~')
    await h.paint()
  }
  view = h.view()
  assert.ok(view.includes('item 39'), `the Reader clamps at its last content row:\n${view}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'Enter never resumes from the Reader')
  assert.ok(h.view().includes('Transcript · other-se'), 'Enter leaves the Reader open on its Session')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(!h.view().includes('Transcript · other-se'), 'Esc returns to the browse list')
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
  await clickBarAction(h, 'Read [Space]')
  assert.ok(h.view().includes('Transcript · other-se'), 'control: an unchanged bar press/release opens the Reader')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'control: the keyboard Esc closes it again')
  // Press Read, move the tree selection, release on the old cell: inert.
  let frame = panelFrame(h)
  let bar = frame[frame.length - 1]!
  let x = bar.indexOf('Read [Space]') + 1
  let y = frame.length - 1
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  h.vt.sendInput('\x1b[H')
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'a scroll between press and release drops the Read gesture')
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
    readMarkdown: async () => ({ kind: 'unavailable' }),
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
  await clickCell(h, 2, folderLineIndexOf(panelFrame(h), 'Beta'))
  assert.ok(!h.view().includes('Other title'), 'a fresh press/release on the new frame acts exactly once')
  assert.deepEqual(h.resumes, [], 'no gesture resumed a Session')
})

test('H01: the real list height fills ordinary history until the roster or viewport is exhausted', async () => {
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
    assert.ok(visible > 0 && visible <= 30, `${rows} rows: ordinary history never exceeds the real roster:\n${view}`)
    assert.ok(frame[frame.length - 1]!.includes('Close [Esc]'), `${rows} rows: the Footer keeps its last physical row`)
    const more = frame.find(line => line.includes('Show more sessions'))
    if (more === undefined) {
      assert.equal(visible, 30, `${rows} rows: a missing Show more means the whole roster is painted:\n${view}`)
    } else {
      const remaining = Number(/· (\d+) remaining/.exec(more)?.[1])
      assert.equal(remaining, 30 - visible, `${rows} rows: the remaining count matches the painted watermark`)
    }
    h.dispose()
  }
  assert.ok(counts[1]! >= counts[0]!, `a taller list never shows less ordinary history: ${counts.join(', ')}`)
  assert.ok(counts[2]! >= counts[1]!, `a taller list never shows less ordinary history: ${counts.join(', ')}`)
  assert.ok(counts[1]! > 20, `40 rows reveal more than the retired 20-row cap: ${counts.join(', ')}`)
  assert.equal(counts[2], 30, `60 rows exhaust the 30-row roster instead of leaving a fixed-cap gap: ${counts.join(', ')}`)
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
  assert.ok(at40 > 20, `a taller frame fills past the retired 20-row cap: ${at24} -> ${at40}`)
  assert.ok(/^> .*H02 9/m.test(h.view()), 'the selection keeps its own row id across the resize')
  h.vt.resize(100, 10)
  await h.paint()
  assert.ok(/^> .*H02 9/m.test(h.view()), 'the selected row stays painted on the short frame')
  assert.ok(count() <= 6, `a short frame paints only what its body budget holds: ${count()}`)
  h.vt.resize(100, 40)
  await h.paint()
  assert.equal(count(), at40, 'returning to the same size never grows the watermark again')
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
  assert.ok(actionBar.includes('Collapse [Enter]'),
    `the Footer still advertises the re-anchored row's real verb:\n${actionBar}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(!/H02B \d+/.test(h.view()), 'Enter acts on the painted Folder instead of an invisible target')
  h.app.dispose()
  started.delete(h.app)

  // A REAL Host status line is the budget control: removing it frees the row
  // that lets automatic growth finish the remaining history, so the selected
  // Show-more row disappears and the cursor must re-anchor on its Folder. No
  // transient Activity freshness row exists in either frame.
  const settledHistory = Array.from({ length: 14 }, (_, index) => row(`session-h02c-${index}`, 900 - index, { title: `H02C ${index}` }))
  const settledRows = [row(CURRENT, 3_000, { title: 'H02C current' }), ...settledHistory]
  const status = harness({ columns: 100, rows: 20 })
  status.handle.setSnapshot(snapshot({ rows: settledRows, refreshError: 'host roster refresh failed' }))
  status.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-s', path: '/ws/s', title: 'Status', sessionIds: [CURRENT, ...settledHistory.map(item => item.id)] },
  ] })
  await status.paint()
  status.vt.sendInput('\x1b[F')
  await status.paint()
  assert.ok(/^> .*Show more sessions/m.test(status.view()), `the cursor sits on the Show-more row:\n${status.view()}`)
  assert.ok(status.view().includes('session list refresh failed: host roster refresh failed'),
    `the real Host status line is painted:\n${status.view()}`)
  // The real status line disappears with the next settled snapshot: one body
  // row returns and automatic growth exhausts the remaining one row of history.
  status.handle.setSnapshot(snapshot({ rows: settledRows }))
  await status.paint()
  const settled = status.view()
  assert.ok(!settled.includes('Show more sessions'), `the freed row lets growth exhaust the remaining history:\n${settled}`)
  assert.ok(/^> .*Status/m.test(settled), `the cursor re-anchored on the parent Folder:\n${settled}`)
  assert.ok(panelFrame(status).at(-1)!.includes('Collapse [Enter]'), 'the Footer advertises the painted row')
  // Re-adding the real status line never resurrects a transient Activity row.
  status.handle.setSnapshot(snapshot({ rows: settledRows, refreshError: 'host roster refresh failed' }))
  await status.paint()
  assert.ok(status.view().includes('session list refresh failed: host roster refresh failed'))
  assert.ok(!status.view().includes('Reading session activity…'), 'no status transition paints the retired transient row')
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
  assert.ok(roomy.includes('A history 44'), `the priority Workspace fills the whole viewport with its real history:\n${roomy}`)
  assert.ok(!roomy.includes('A history 45'), 'the reveal stops at the real roster')
  assert.ok(roomy.includes('B history 1'), `the other expanded Workspace receives the remaining spare rows:\n${roomy}`)
  assert.ok(!roomy.includes('B history 2'), 'the sibling never over-allocates past the real budget')
  assert.ok(roomy.includes('Show more sessions · 8 remaining'), `the remaining count is the real unwatermarked roster:\n${roomy}`)
  assert.ok(roomy.includes('B need') && roomy.includes('B working'), 'the active priority rows stay painted')
  assert.ok(roomy.includes('+ New session'), 'the expanded official Folders keep their New row')
  assert.ok(!roomy.includes('C history'), 'the allocation never expands a collapsed Folder')
  assert.ok(/[▸▾] Gamma/.test(roomy), 'the collapsed Folder row itself stays in the complete tree')
})

test('H04: Show more reveals one painted page from the current watermark and keeps it across collapse and resize', async () => {
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
  assert.ok(automatic > 20 && automatic < 45, `the automatic watermark fills the real viewport, not a fixed cap: ${automatic}`)
  const firstMore = panelFrame(h).find(line => line.includes('Show more sessions'))
  assert.ok(firstMore !== undefined, `the remaining history stays behind Show more:\n${h.view()}`)
  const remaining = Number(/· (\d+) remaining/.exec(firstMore)?.[1])
  await clickCell(h, 8, lineIndexOf(panelFrame(h), 'Show more sessions'))
  const grown = count()
  assert.ok(grown > automatic, `Show more reveals the next painted page: ${automatic} -> ${grown}`)
  assert.ok(grown <= 45, `the reveal is bounded by the real roster: ${automatic} -> ${grown}`)
  assert.ok(/^> .*H04 \d+/m.test(h.view()), `the cursor lands on the first new history row:\n${h.view()}`)
  const selected = /^> .*H04 (\d+)/m.exec(h.view())?.[1]
  assert.equal(Number(selected), automatic,
    `the first row beyond the old watermark is the one newly selected (was ${remaining} remaining)`)
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

test('H04B: two consecutive Show more pages each select their own first new row without resuming', async () => {
  const history = Array.from({ length: 60 }, (_, index) => row(`session-h04b-${index}`, 900 - index, { title: `H04B ${index}` }))
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H04B current' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  await h.paint()
  const selectedIndex = (): number => {
    const match = /^> .*H04B (\d+)/m.exec(h.view())
    assert.ok(match !== null, `a newly revealed history row is selected:\n${h.view()}`)
    return Number(match[1])
  }
  h.vt.sendInput('\x1b[F')
  await h.paint()
  await clickCell(h, 8, lineIndexOf(panelFrame(h), 'Show more sessions'))
  const first = selectedIndex()
  h.vt.sendInput('\x1b[F')
  await h.paint()
  await clickCell(h, 12, lineIndexOf(panelFrame(h), 'Show more sessions'))
  const second = selectedIndex()
  assert.ok(second > first, `each page lands on its own first new history row: ${first} -> ${second}`)
  assert.deepEqual(h.resumes, [], 'Show more never resumes or opens a Session')
  assert.equal(h.closes, 0, 'Show more never closes the Browser')
  h.dispose()
})

test('Needs attention and Working stay complete right-aligned status groups across widths', async () => {
  const longCjkTitle = '修复流水线'.repeat(20)
  const h = harness({ columns: 44, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 3_000, { title: 'Current session' }),
    row('session-status-needs', 2_500, { title: longCjkTitle }),
    row('session-status-working', 2_000, { title: 'Working title' }),
    row('session-status-pending', 1_500, { title: 'Pending title' }),
  ] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-status', path: '/ws/status', title: 'Status', sessionIds: [CURRENT, 'session-status-needs', 'session-status-working', 'session-status-pending'] },
  ] })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact('session-status-needs', { running: true }),
      fact('session-status-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      questionFact('session-status-pending'),
    ],
    answerEligibility: [eligibility('session-status-needs')],
  })
  for (const width of [44, 72, 80, 120, 200] as const) {
    h.vt.resize(width, 24)
    await h.paint()
    const frame = panelFrame(h)
    const needsLine = frame.find(line => line.includes('status-n'))
    assert.ok(needsLine !== undefined, `${width} columns: the Needs row is painted:\n${frame.join('\n')}`)
    assert.ok(needsLine.includes('‣ Needs attention'), `${width} columns: the primary status word is complete:\n${needsLine}`)
    assert.equal((needsLine.match(/‣/g) ?? []).length, 1, `${width} columns: one status group uses one marker:\n${needsLine}`)
    assert.ok(needsLine.includes('status-n'), `${width} columns: the stable short id survives the status:\n${needsLine}`)
    assert.ok(needsLine.includes('修复流水'), `${width} columns: a recognisable CJK title prefix survives:\n${needsLine}`)
    assert.equal(needsLine.includes('Working'), width >= 72,
      `${width} columns: Working is kept whole when it fits and dropped whole when it does not:\n${needsLine}`)
    const workingLine = frame.find(line => line.includes('status-w'))
    assert.ok(workingLine?.includes('‣ Working'), `${width} columns: the Working group is complete:\n${workingLine}`)
    const pendingLine = frame.find(line => line.includes('status-p'))
    assert.ok(pendingLine?.includes('‣ Pending unverified'), `${width} columns: pending is neutral and never Needs:\n${pendingLine}`)
    assert.ok(!frame.join('\n').includes('Needs attent…'), `${width} columns: a status word is never truncated mid-word`)
    for (const painted of h.vt.getViewport()) {
      assert.ok(visibleWidth(painted) <= width, `${width} columns: a painted row overflows: ${JSON.stringify(painted)}`)
    }
  }
  const raw = h.raw()
  assert.ok(raw.includes(color.warning('‣ Needs attention')), 'the Needs group carries the warning token')
  assert.ok(raw.includes(color.primary('‣ Working')), 'the Working group carries the primary token')
  assert.ok(raw.includes(color.textDim('‣ Pending unverified')), 'Pending unverified is neutral, not Needs ink')
})

test('a 50/52-column CJK row drops the optional Working segment before the title prefix', async () => {
  const longCjkTitle = '修复流水线需要输入的问题非常长的标题用于验证截断不会吃掉状态词'
  const make = (columns: number, currentSessionId: string): Harness => {
    const h = harness({ columns, rows: 24, currentSessionId })
    h.handle.setSnapshot(snapshot({ rows: [
      row(CURRENT, 3_000, { title: 'Current session' }),
      row('session-status-needs', 2_500, { title: longCjkTitle }),
    ] }))
    h.handle.updateWorkspaces({ type: 'baseline', items: [
      { workspaceId: 'ws-status', path: '/ws/status', title: 'Status', sessionIds: [CURRENT, 'session-status-needs'] },
    ] })
    h.handle.setActivityFacts({
      listRevision: 1,
      facts: [
        fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
        questionFact('session-status-needs', { running: true }),
      ],
      answerEligibility: [eligibility('session-status-needs')],
    })
    return h
  }
  // 50 columns, non-current: the old two-cell admission counted 46 and kept
  // Working; the real ' · ' separator needs 47, so the optional word must yield
  // and the reserved 8-cell title prefix must survive.
  const nonCurrent = make(50, CURRENT)
  await nonCurrent.paint()
  let needsLine = panelFrame(nonCurrent).find(line => line.includes('status-n'))
  assert.ok(needsLine !== undefined, `the non-current Needs row is painted:\n${nonCurrent.view()}`)
  assert.ok(needsLine.includes('‣ Needs attention'), `the primary status stays complete:\n${needsLine}`)
  assert.ok(!needsLine.includes('Working'), `the optional Working segment yields at its real separator width:\n${needsLine}`)
  assert.ok(needsLine.includes('修复流水'), `the reserved CJK title prefix survives:\n${needsLine}`)
  nonCurrent.dispose()

  // 52 columns, current: the 2-cell bullet makes the same admission boundary;
  // the complete Needs status and 8-cell title prefix must still win.
  const current = make(52, 'session-status-needs')
  await current.paint()
  needsLine = panelFrame(current).find(line => line.includes('status-n'))
  assert.ok(needsLine !== undefined, `the current Needs row is painted:\n${current.view()}`)
  assert.match(needsLine, /^> .*‣ Needs attention/m, `the current primary status stays complete:\n${needsLine}`)
  assert.ok(!needsLine.includes('Working'), `the current bullet does not buy the optional Working segment:\n${needsLine}`)
  assert.ok(needsLine.includes('修复流水'), `the CJK title prefix survives beside the current bullet:\n${needsLine}`)
  current.dispose()
})

test('a collapsed Folder keeps complete Needs/Working counts that follow same-frame reclassification', async () => {
  const h = harness({ columns: 80, rows: 24 })
  const rows = [
    row(CURRENT, 3_000, { title: 'Current session' }),
    row('session-folder-needs', 2_500, { title: 'Needs title' }),
    row('session-folder-working', 2_000, { title: 'Working title' }),
    row('session-folder-history', 1_000, { title: 'History title' }),
  ]
  h.handle.setSnapshot(snapshot({ rows }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws/a', title: 'Alpha', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/ws/b', title: 'Beta', sessionIds: ['session-folder-needs', 'session-folder-working', 'session-folder-history'] },
  ] })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact('session-folder-needs'),
      fact('session-folder-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      fact('session-folder-history', { running: false, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [eligibility('session-folder-needs')],
  })
  await h.paint()
  await clickCell(h, 2, folderLineIndexOf(panelFrame(h), 'Beta'))
  let betaLine = panelFrame(h)[folderLineIndexOf(panelFrame(h), 'Beta')]!
  assert.ok(betaLine.includes('1 Needs') && betaLine.includes('1 Working'),
    `a collapsed Folder keeps both trustworthy counts whole:\n${betaLine}`)
  assert.ok(!h.view().includes('Needs title'), 'the manual collapse hides every child')
  // The counts are part of the row's one click target, not a separate button.
  await clickCell(h, betaLine.indexOf('1 Working'), folderLineIndexOf(panelFrame(h), 'Beta'))
  assert.ok(h.view().includes('Needs title'), `a click on the count area runs the one Folder toggle:\n${h.view()}`)
  await clickCell(h, 2, folderLineIndexOf(panelFrame(h), 'Beta'))
  // The same official facts reclassify this roster revision: Needs is revoked.
  h.handle.setSnapshot(snapshot({ rows, listRevision: 2 }))
  h.handle.setActivityFacts({
    listRevision: 2,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact('session-folder-needs', { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact('session-folder-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      fact('session-folder-history', { running: false, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [],
  })
  await h.paint()
  betaLine = panelFrame(h)[folderLineIndexOf(panelFrame(h), 'Beta')]!
  assert.ok(betaLine.includes('0 Needs') && betaLine.includes('1 Working'),
    `the collapsed Folder repaints the trustworthy counts in the same frame:\n${betaLine}`)
  assert.ok(!betaLine.includes('1 Needs'), 'a revoked Need never lingers in the Folder summary')
  assert.ok(!h.view().includes('Needs title'), 'the reclassification never expands a manually collapsed Folder')
})

test('a 44-column Folder drops zero counts before the Workspace identity', async () => {
  const h = harness({ columns: 44, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 3_000, { title: 'Current session' }),
    row('session-folder-needs2', 2_500, { title: 'Needs child' }),
  ] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'team-accounts-service', sessionIds: [CURRENT] },
    { workspaceId: 'ws-beta', path: '/ws/beta', title: 'incident-response-service', sessionIds: ['session-folder-needs2'] },
  ] })
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact('session-folder-needs2'),
    ],
    answerEligibility: [eligibility('session-folder-needs2')],
  })
  await h.paint()
  let frame = panelFrame(h)
  let alphaLine = frame[folderLineIndexOf(frame, 'team-accounts-service')]!
  assert.ok(alphaLine.includes('team-accounts-service'),
    `the healthy Folder keeps its complete identity instead of zero-count chrome:\n${alphaLine}`)
  assert.ok(alphaLine.includes('Current'), `the Current identity survives:\n${alphaLine}`)
  assert.ok(!alphaLine.includes('Needs') && !alphaLine.includes('Working'),
    `a 0/0 Folder paints no dead count group:\n${alphaLine}`)
  let betaLine = frame[folderLineIndexOf(frame, 'incident-response-service')]!
  assert.ok(betaLine.includes('incident-response-service'),
    `the mixed-positive Folder keeps its identity while expanded:\n${betaLine}`)
  assert.ok(betaLine.includes('1 Needs'), `the non-zero Needs word stays whole:\n${betaLine}`)
  assert.ok(!betaLine.includes('0 Working'), `the zero Working segment yields before the label:\n${betaLine}`)
  // A manual collapse keeps the same truthful count group and identity.
  await clickCell(h, 2, folderLineIndexOf(panelFrame(h), 'incident-response-service'))
  assert.ok(!h.view().includes('Needs child'), 'the manual collapse hides the child row')
  betaLine = panelFrame(h)[folderLineIndexOf(panelFrame(h), 'incident-response-service')]!
  assert.ok(betaLine.includes('incident-response-service') && betaLine.includes('1 Needs') && !betaLine.includes('0 Working'),
    `the collapsed Folder keeps its identity and non-zero count right-aligned:\n${betaLine}`)
})

test('roster and Activity refreshes add no transient layout row and keep the painted selection', async () => {
  const history = Array.from({ length: 24 }, (_, index) => row(`session-activity-${index}`, 900 - index, { title: `Activity ${index}` }))
  const rows = [row(CURRENT, 3_000, { title: 'Current session' }), ...history]
  const h = harness({ columns: 100, rows: 40 })
  h.handle.setSnapshot(snapshot({ rows }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  const knownFacts = [
    fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
    ...history.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
  ]
  h.handle.setActivityFacts({ listRevision: 1, facts: knownFacts, answerEligibility: [] })
  await h.paint()
  const firstY = lineIndexOf(panelFrame(h), 'Activity 0')
  // Revision 2 is accepted before its Activity sample: the known facts may be
  // Unknown for one frame, but that is not a new layout row.
  h.handle.setSnapshot(snapshot({ rows, listRevision: 2 }))
  await h.paint()
  const sampled = h.view()
  assert.ok(!sampled.includes('Reading session activity…'), `the sampling interval paints no transient row:\n${sampled}`)
  assert.equal(lineIndexOf(panelFrame(h), 'Activity 0'), firstY, 'the list does not shift while Activity is re-sampled')
  assert.ok(/^> .*Current session/m.test(sampled), 'the typed selection keeps its Session id')
  h.handle.setActivityFacts({ listRevision: 2, facts: knownFacts, answerEligibility: [] })
  await h.paint()
  assert.ok(!h.view().includes('Reading session activity…'), 'the settled sample removes no row because none was added')
  assert.equal(lineIndexOf(panelFrame(h), 'Activity 0'), firstY, 'the settled sample keeps the same physical list origin')
  // A real failure is a real status line, not the retired transient row.
  h.handle.setSnapshot(snapshot({ rows, listRevision: 3 }))
  h.handle.activityUnavailable('scan failed')
  await h.paint()
  const failed = h.view()
  assert.ok(failed.includes('Activity unavailable: scan failed'), `a real Activity failure stays visible:\n${failed}`)
  assert.ok(!failed.includes('Reading session activity…'), 'the failure path never paints the transient row')
  // A real classification change may reorder rows, but the cursor keeps its id.
  h.handle.setSnapshot(snapshot({ rows, listRevision: 4 }))
  h.handle.setActivityFacts({
    listRevision: 4,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      ...history.map((item, index) => fact(item.id, {
        running: index === 0,
        attention: 'none',
        attentionSourceState: 'known',
      })),
    ],
    answerEligibility: [],
  })
  await h.paint()
  const changed = h.view()
  assert.match(changed, /Activity 0.*‣ Working/, `a real running fact updates the row in the same frame:\n${changed}`)
  assert.ok(/^> .*Current session/m.test(changed), 'the cursor never jumps to another Session on an Activity change')
  assert.ok(!changed.includes('Reading session activity…'), 'no Activity path paints the transient row')
})

test('H07: the Sessionless Choose workspace chooser never grows the history watermark', async () => {
  const history = Array.from({ length: 34 }, (_, index) => row(`session-h07-${index}`, 900 - index, { title: `H07 history ${index}` }))
  const used: Array<[string, string]> = []
  const chooser = harness({
    columns: 120,
    rows: 40,
    currentSessionId: null,
    initialDirectoryChooser: true,
    onAddDirectory: () => {},
    onNewSession: () => {},
    onUseDirectory: (workspaceId, canonicalPath) => { used.push([workspaceId, canonicalPath]) },
  })
  chooser.handle.setSnapshot(snapshot({ rows: [row('session-h07-working', 10_000, { title: 'H07 working' }), ...history] }))
  chooser.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: ['session-h07-working', ...history.map(item => item.id)] },
  ] })
  chooser.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact('session-h07-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      ...history.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
    ],
    answerEligibility: [],
  })
  await chooser.paint()
  const left = (lines: readonly string[]): string[] => lines.map(line => line.slice(0, 66))
  let frame = panelFrame(chooser)
  assert.ok(left(frame).some(line => line.includes('H07 working')),
    `the confirmed Working row keeps the chooser Folder expanded:\n${frame.join('\n')}`)
  assert.ok(!left(frame).some(line => /H07 history \d+/.test(line)),
    `the chooser never fills its spare height with unrelated history:\n${frame.join('\n')}`)
  assert.ok(left(frame).some(line => line.includes('Show more sessions · 34 remaining')),
    `the chooser keeps the shared zero-history watermark:\n${frame.join('\n')}`)
  // The chooser verbs are unchanged: the disclosure toggles, the title chooses.
  await clickCell(chooser, 2, folderLineIndexOf(frame, 'Alpha'))
  assert.ok(!chooser.view().includes('H07 working'), 'the disclosure only collapses the chooser Folder')
  assert.deepEqual(used, [], 'the disclosure never chooses a Workspace')
  assert.equal(chooser.closes, 0)
  await clickCell(chooser, 5, folderLineIndexOf(panelFrame(chooser), 'Alpha'))
  assert.deepEqual(used, [['ws-alpha', '/ws/alpha']], 'the Folder title click is the ONE choose action')
  assert.equal(chooser.closes, 1, 'the chooser returns after the choose')
  chooser.app.dispose()
  started.delete(chooser.app)

  // Positive control: the same roster and size in ORDINARY Browse still grows.
  const browse = harness({ columns: 120, rows: 40 })
  browse.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 10_000, { title: 'H07 current' }), ...history] }))
  browse.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  browse.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      ...history.map(item => fact(item.id, { running: false, attention: 'none', attentionSourceState: 'known' })),
    ],
    answerEligibility: [],
  })
  await browse.paint()
  const grown = browse.view().split('\n').map(line => line.slice(0, 66))
  const count = grown.filter(line => /H07 history \d+/.test(line)).length
  assert.ok(count > 20, `ordinary Browse at the same size fills its real viewport instead of stopping at 20:\n${grown.join('\n')}`)
  assert.ok(count <= 34, 'the positive control never exceeds the real roster')
})

test('H08: the wide two-column list spends its own pane budget on history', async () => {
  const history = Array.from({ length: 30 }, (_, index) => row(`session-h08-${index}`, 900 - index, { title: `H08 ${index}` }))
  // 120x24 is the wide layout. Its global status lines are charged by renderBody
  // BEFORE renderListPane (none during a settled frame), so the list must charge
  // them exactly once: 20 body rows - 0 head status = 20 list rows, i.e. a
  // 17-row watermark (current row is forced visible and costs no extra row).
  const h = harness({ columns: 120, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'H08 current' }), ...history] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-a', path: '/ws', title: 'Alpha', sessionIds: [CURRENT, ...history.map(item => item.id)] },
  ] })
  await h.paint()
  let frame = panelFrame(h)
  assert.ok(frame.join('\n').includes('Workspace: Alpha (ws-a)'),
    `the wide layout paints the read-only preview:\n${frame.join('\n')}`)
  let visible = frame.map(line => line.slice(0, 66)).filter(line => /H08 \d+/.test(line)).length
  assert.equal(visible, 17,
    `the wide pane budget grows to exactly 17 ordinary rows:\n${frame.join('\n')}`)
  assert.ok(frame.map(line => line.slice(0, 66)).some(line => line.includes('Show more sessions · 13 remaining')),
    'the remaining count matches the wide watermark')
  h.vt.resize(160, 60)
  await h.paint()
  frame = panelFrame(h)
  visible = frame.map(line => line.slice(0, 88)).filter(line => /H08 \d+/.test(line)).length
  assert.equal(visible, 30,
    `160x60 paints the whole 30-row roster:\n${frame.join('\n')}`)
  assert.ok(!frame.map(line => line.slice(0, 88)).some(line => line.includes('Show more sessions')),
    'an exhausted roster removes Show more')
})

test('H05: search, Reader, the Host editor and tiny frames never move the Browse watermark', async () => {
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
  assert.ok(h.view().includes('Transcript ·'), `Space opens the read-only Reader:\n${h.view()}`)
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.equal(count(), browse, 'Reader never moves the watermark')
  assert.deepEqual(h.resumes, [], 'search and Reader never resume a Session')
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

// ── F2: Session Workspace wheel (Browse / Search Results / pinned Reader) ──

test('F2/W01+W08: Browse wheel moves the typed selection by the fork delta, in the keyboard sign, and clamps', async () => {
  const history = Array.from({ length: 11 }, (_, index) => row(`session-wheel-browse-${index}`, 900 - index, { title: `Wheel row ${index}` }))
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), ...history] }))
  settleActivity(h)
  await h.paint()
  const top = bodyTopRow(h)
  assert.ok(/^> .*Current session/m.test(h.view()), `the Browser opens on the typed current row:\n${h.view()}`)

  await wheelCell(h, 5, top + 1, 'down')
  assert.ok(/^> .*Wheel row 0/m.test(h.view()), `a wheel-down notch is the next keyboard Down:\n${h.view()}`)
  await wheelCell(h, 5, top, 'up')
  assert.ok(/^> .*Current session/m.test(h.view()), `a wheel-up notch is the previous keyboard Up:\n${h.view()}`)

  // The fork already turned one Alt notch into five lines; the panel must not
  // multiply the Wheel Lines setting again.
  await wheelCell(h, 5, top, 'down', true)
  assert.ok(/^> .*Wheel row 4/m.test(h.view()), `Alt+wheel uses the fork's accelerated delta exactly once:\n${h.view()}`)
  await wheelCell(h, 5, top, 'up', true)
  assert.ok(/^> .*Current session/m.test(h.view()), 'Alt+wheel-up returns by the same five-line delta')

  // A boundary wheel is a real navigation intent, but never walks past the
  // painted typed rows.
  await wheelCell(h, 5, top, 'up')
  assert.ok(/^> .*Current session/m.test(h.view()), 'the first row clamps the wheel')
  for (let step = 0; step < 14; step += 1) await wheelCell(h, 5, top, 'down')
  assert.ok(/^> .*Wheel row 10/m.test(h.view()), `the last row clamps the wheel:\n${h.view()}`)
  await wheelCell(h, 5, top + 1, 'down')
  assert.ok(/^> .*Wheel row 10/m.test(h.view()), 'no wheel notch walks past the last typed row')

  assert.deepEqual(h.queries, [], 'the wheel never changes the Host query')
  assert.deepEqual(h.resumes, [], 'the wheel never resumes or opens a Session')
  assert.equal(h.closes, 0, 'the wheel never closes the Browser')
})

test('F2/W02: a 44x20 long list keeps the wheel-selected typed row painted and never expands a Folder', async () => {
  const sessions = Array.from({ length: 39 }, (_, index) => row(`session-wheel-short-${index}`, 900 - index, { title: `Short ${index}` }))
  const h = harness({ columns: 44, rows: 20 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), ...sessions] }))
  settleActivity(h)
  await h.paint()
  const top = bodyTopRow(h)
  for (let step = 0; step < 25; step += 1) await wheelCell(h, 3, top, 'down')
  const view = h.view()
  assert.ok(/^> .*Short 24/m.test(view), `the wheel walks past the first painted page and keeps the typed row:\n${view}`)
  assert.ok(!view.includes('Short 0'), `the viewport really scrolled off the first page:\n${view}`)
  assert.ok(view.includes('Sessions · 40'), 'the logical roster is unchanged by the wheel')
  assert.deepEqual(h.resumes, [], 'the wheel never emits a Resume')
  h.dispose()

  // A Folder is never expanded by the wheel: the cursor moves, the presentation
  // does not open another group.
  const tree = harness({ columns: 100, rows: 24 })
  tree.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 3_000, { title: 'Current session' }),
    row(OTHER, 2_000, { title: 'Other session' }),
    row(THIRD, 1_000, { title: 'Third session' }),
  ] }))
  tree.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [CURRENT] },
    { workspaceId: 'ws-beta', path: '/ws/beta', title: 'Beta', sessionIds: [OTHER] },
    { workspaceId: 'ws-gamma', path: '/ws/gamma', title: 'Gamma', sessionIds: [THIRD] },
  ] })
  settleActivity(tree)
  await tree.paint()
  const treeTop = bodyTopRow(tree)
  await wheelCell(tree, 5, treeTop, 'down')
  assert.ok(/^> .*Beta/m.test(tree.view()), `the wheel selects the next typed Folder:\n${tree.view()}`)
  assert.ok(!tree.view().includes('Other session'), 'a wheel selection never expands the Folder')
  await wheelCell(tree, 5, treeTop, 'down')
  assert.ok(/^> .*Gamma/m.test(tree.view()), `the next notch selects the next Folder:\n${tree.view()}`)
  assert.ok(!tree.view().includes('Third session'), 'the wheel never reveals or expands unopened history')
  assert.ok(!tree.view().includes('Show more sessions'), 'the wheel never triggers Show more')
  await wheelCell(tree, 5, treeTop, 'up')
  await wheelCell(tree, 5, treeTop, 'up')
  assert.ok(/^> .*Current session/m.test(tree.view()), 'wheel-up returns to the same typed Session')
  assert.deepEqual(tree.resumes, [])
  assert.equal(tree.closes, 0)
  tree.dispose()

  // A painted Show more row is a typed selection target: the wheel selects it
  // but never runs its explicit reveal or grows this open's watermark.
  const more = harness({ columns: 100, rows: 24 })
  const moreHistory = Array.from({ length: 30 }, (_, index) => row(`session-wheel-more-${index}`, 900 - index, { title: `More ${index}` }))
  more.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), ...moreHistory] }))
  more.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-more', path: '/ws', title: 'More', sessionIds: [CURRENT, ...moreHistory.map(item => item.id)] },
  ] })
  settleActivity(more)
  await more.paint()
  const moreRow = lineIndexOf(panelFrame(more), 'Show more sessions')
  const remaining = Number(/· (\d+) remaining/.exec(panelFrame(more)[moreRow]!)?.[1])
  const visibleMore = panelFrame(more).filter(line => /More \d+/.test(line)).length
  more.vt.sendInput('\x1b[F')
  await more.paint()
  assert.ok(/^> .*Show more sessions/m.test(more.view()), `the wheel selects the painted Show more row:\n${more.view()}`)
  await wheelCell(more, 5, moreRow, 'down')
  const afterMore = panelFrame(more)[lineIndexOf(panelFrame(more), 'Show more sessions')]!
  assert.equal(Number(/· (\d+) remaining/.exec(afterMore)?.[1]), remaining,
    'a wheel over Show more never invokes the reveal or changes the watermark')
  assert.equal(panelFrame(more).filter(line => /More \d+/.test(line)).length, visibleMore,
    'the wheel reveals no hidden history')
  more.vt.sendInput('\r')
  await more.paint()
  const revealed = more.view()
  assert.ok(!revealed.includes('Show more sessions'), `Enter reveals the whole painted page and exhausts the roster:\n${revealed}`)
  assert.ok(/^> .*More 17/m.test(revealed), `Enter selects the first newly revealed history row:\n${revealed}`)
  more.dispose()
})

test('F2/W03: the wide left list takes the wheel while the right Preview and the column gap stay inert', async () => {
  const h = harness({ columns: 120, rows: 40 })
  h.handle.setSnapshot(snapshot({ rows: [
    row(CURRENT, 3_000, { title: 'Current session' }),
    row(OTHER, 2_000, { title: 'Other session' }),
    row(THIRD, 1_000, { title: 'Third session' }),
  ] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [CURRENT, OTHER] },
    { workspaceId: 'ws-beta', path: '/ws/beta', title: 'Beta', sessionIds: [THIRD] },
  ] })
  settleActivity(h)
  await h.paint()
  assert.ok(h.view().includes('Space to read committed transcript'), 'the wide frame paints its read-only right Preview')
  const top = bodyTopRow(h)
  await wheelCell(h, 5, top, 'down')
  assert.ok(/^> .*Other session/m.test(h.view()), `the left column wheel moves the tree selection:\n${h.view()}`)
  const selected = h.view()
  // The wide frame is 120 cells: left 0..65, a two-cell gap 66..67, right 68+.
  await wheelCell(h, 80, top + 1, 'down')
  assert.equal(h.view(), selected, 'the right read-only Preview is not a wheel sink')
  await wheelCell(h, 66, top + 1, 'down')
  assert.equal(h.view(), selected, 'the two-cell column gap is inert')
  await wheelCell(h, 80, top, 'up')
  assert.equal(h.view(), selected, 'the wide Preview never scrolls or re-selects the tree')
  assert.deepEqual(h.resumes, [])
  assert.equal(h.closes, 0)
})

test('F2/W04+W05: Search Results wheel takes focus, moves only the selection, clamps and re-anchors', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot())
  settleActivity(h)
  await h.paint()
  h.vt.sendInput('\x1b[B') // select the pre-search Browse row
  await h.paint()
  h.vt.sendInput('/')
  await h.paint()
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [
      { row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Both', snippet: 'needle a' },
      { row: row(THIRD, 1_000, { title: 'Third session' }), source: 'Content', snippet: 'needle b' },
    ],
  }), 'needle')
  await h.paint()
  assert.ok(h.view().includes('Search: needle'), 'the seeded global search paints before the wheel')
  assert.deepEqual(h.queries, [], 'the one-shot seed is not a user query generation')

  const top = bodyTopRow(h)
  const inputFrame = h.view()
  // The Search Input row itself is not a scroll sink.
  await wheelCell(h, 5, top, 'down')
  assert.equal(h.view(), inputFrame, 'the global Search Input is never a wheel sink')
  const firstResult = lineIndexOf(panelFrame(h), 'Other session')
  await wheelCell(h, 5, firstResult, 'down')
  assert.ok(/^> .*Third session/m.test(h.view()), `the Results wheel moves its own selection:\n${h.view()}`)
  assert.ok(h.view().includes('Search: needle'), 'the query text is untouched by the wheel')
  assert.deepEqual(h.queries, [], 'the wheel never issues a Host query')

  // Clamp inside the painted result viewport in both directions.
  for (let step = 0; step < 4; step += 1) await wheelCell(h, 5, firstResult, 'down')
  assert.ok(/^> .*Third session/m.test(h.view()), 'the last result clamps the wheel')
  for (let step = 0; step < 4; step += 1) await wheelCell(h, 5, firstResult, 'up')
  assert.ok(/^> .*Other session/m.test(h.view()), 'the first result clamps the wheel')
  // Walk back onto the result the refresh below will remove.
  await wheelCell(h, 5, firstResult, 'down')
  assert.ok(/^> .*Third session/m.test(h.view()), `the wheel returns to the second result:\n${h.view()}`)

  // Esc returns to the editor without leaving the global search.
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(h.view().includes('Search: needle') && h.view().includes('Search all workspaces'),
    `the first Esc returns to the same Search editor:\n${h.view()}`)

  // A refreshed result page re-anchors on a CURRENT result: a removed result
  // can never be resurrected by the wheel.
  h.handle.setSnapshot(snapshot({
    query: 'needle',
    searchState: 'ready',
    searchResults: [
      { row: row(CURRENT, 3_000, { title: 'Current session' }), source: 'Content', snippet: 'needle c' },
      { row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'needle a' },
    ],
  }))
  await h.paint()
  assert.ok(/^> .*Current session/m.test(h.view()), `a refreshed result page re-anchors the selection:\n${h.view()}`)
  await wheelCell(h, 5, lineIndexOf(panelFrame(h), 'Current session'), 'down')
  assert.ok(/^> .*Other session/m.test(h.view()), 'the wheel only walks the CURRENT painted results')
  assert.ok(!h.view().includes('Third session'), 'a removed result is never repainted by the wheel')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'the second Enter still resumes only the painted result')

  h.vt.sendInput('\x1b')
  await h.paint()
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(/^> .*Other session/m.test(h.view()), `Esc restores the pre-search Browse selection:\n${h.view()}`)
  assert.ok(!h.view().includes('Search all workspaces'), 'the second Esc leaves the global search')
})

test('F2/W05: a result page longer than the viewport scrolls with the wheel selection', async () => {
  const results = Array.from({ length: 24 }, (_, index) => ({
    row: row(`session-wheel-result-${index}`, 1_000 - index, { title: `Result ${index}` }),
    source: 'Content' as const,
    snippet: `needle ${index}`,
  }))
  const h = harness({ columns: 100, rows: 24, initialMode: 'search' })
  h.handle.setSnapshot(snapshot({ query: 'needle', searchState: 'ready', searchResults: results }), 'needle')
  settleActivity(h)
  await h.paint()
  assert.ok(h.view().includes('Search: needle'), `the Search editor keeps its seeded query:\n${h.view()}`)
  const firstResult = lineIndexOf(panelFrame(h), 'Result 0')
  for (let step = 0; step < 20; step += 1) await wheelCell(h, 5, firstResult, 'down')
  const view = h.view()
  assert.ok(/^> .*Result 20/m.test(view), `the result viewport follows the wheel selection:\n${view}`)
  assert.ok(!view.includes('Result 0 ') && !view.includes('Result 2 '), `the first result page scrolled away:\n${view}`)
  assert.ok(view.includes('Result 3'), 'the rebased result page starts at the real painted row')
  assert.ok(h.view().includes('Search: needle'), 'scrolling the results never edits the query')
  assert.deepEqual(h.queries, [], 'the wheel never issues a Host query')
  assert.deepEqual(h.resumes, [], 'the wheel never resumes a result')
  for (let step = 0; step < 20; step += 1) await wheelCell(h, 5, firstResult, 'up')
  assert.ok(/^> .*Result 0/m.test(h.view()), `the wheel returns to the first painted result:\n${h.view()}`)
  assert.ok(h.view().includes('Result 17') && !h.view().includes('Result 18'),
    'the result viewport rebases back to the first page')
})

test('F2/W06+W07: Reader wheel scrolls only its real body; chrome and Preview stay inert', async () => {
  const markdown = [...Array.from({ length: 40 }, (_, index) => `- item ${String(index).padStart(2, '0')}`)].join('\n')
  const h = harness({ columns: 120, rows: 12, readMarkdown: async () => ({ kind: 'ready', markdown }) })
  h.handle.setSnapshot(snapshot())
  settleActivity(h)
  await h.paint()
  h.vt.sendInput('\x1b[B') // the pinned target is OTHER
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const top = bodyTopRow(h)
  assert.ok(h.view().includes('Transcript · other-se'), `the Reader pins its own Session id:\n${h.view()}`)
  assert.ok(h.view().includes('item 00'), 'the Reader owns the full body with its official Markdown')
  assert.equal(h.view().split('\n').filter(line => line.includes('Back [Esc]')).length, 1,
    'the Reader paints no local exit row: only the ONE global bar leaves it')

  await wheelCell(h, 80, top + 1, 'down')
  const scrolled = h.view()
  assert.ok(!scrolled.includes('item 00') && scrolled.includes('item 01'),
    `the Reader body wheel advances the real content:\n${scrolled}`)
  assert.ok(scrolled.includes('Transcript · other-se'), 'the fixed Reader context never scrolls away')
  assert.deepEqual(h.resumes, [], 'scrolling a Reader never resumes or activates anything')

  // The Reader header is inert: the leased screen consumes the wheel but never
  // scrolls content from a non-body row.
  const beforeHeader = h.view()
  await wheelCell(h, 80, 0, 'down')
  assert.equal(h.view(), beforeHeader, 'the Reader header is not a wheel target')

  await wheelCell(h, 80, top + 1, 'up')
  assert.ok(h.view().includes('item 00'), 'wheel-up returns to the top of the same official body')

  // Closing the Reader restores the ordinary read-only Preview, which is not a
  // scroll sink either.
  h.vt.sendInput('\x1b')
  await h.paint()
  const browse = h.view()
  assert.ok(browse.includes('Space to read committed transcript'), 'Esc restores the ordinary Preview')
  await wheelCell(h, 80, top + 1, 'down')
  assert.equal(h.view(), browse, 'the ordinary Preview never scrolls the closed Reader')
  assert.ok(/^> .*Other session/m.test(h.view()), 'the typed Browse selection survives the Reader round trip')
  h.dispose()

  // A narrow 80x9 Reader owns the whole body and clamps at its real last row.
  const narrow = harness({ columns: 80, rows: 9, readMarkdown: async () => ({ kind: 'ready', markdown }) })
  narrow.handle.setSnapshot(snapshot())
  settleActivity(narrow)
  await narrow.paint()
  narrow.vt.sendInput('\x1b[B')
  await narrow.paint()
  narrow.vt.sendInput(' ')
  await narrow.paint()
  const narrowTop = bodyTopRow(narrow)
  assert.ok(narrow.view().includes('item 00'))
  await wheelCell(narrow, 5, narrowTop, 'down')
  assert.ok(!narrow.view().includes('item 00') && narrow.view().includes('item 01'),
    `the narrow wheel scrolls its real body:\n${narrow.view()}`)
  for (let step = 0; step < 60; step += 1) await wheelCell(narrow, 5, narrowTop, 'down')
  assert.ok(narrow.view().includes('item 39'), `the short Reader clamps at its own last content row:\n${narrow.view()}`)
  assert.deepEqual(narrow.resumes, [], 'a narrow Reader wheel never activates a Session')

  // The ONE global Back click leaves the Reader without closing the Browser; the
  // typed selection and anchor survive.
  await clickBarAction(narrow, 'Back [Esc]')
  assert.equal(narrow.closes, 0, 'the painted Back closes only the Reader')
  assert.ok(/^> .*Other session/m.test(narrow.view()), `Esc/Back returns to the same typed selection:\n${narrow.view()}`)
  narrow.vt.sendInput('\x1b')
  await narrow.paint()
  assert.equal(narrow.closes, 1, 'the root Esc still closes the Browser')
})

test('F2/W09: a boundary wheel retires a painted bar press while an inert wheel keeps it legal', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot())
  settleActivity(h)
  await h.paint()
  h.vt.sendInput('\x1b[B') // select the LAST typed row (OTHER)
  await h.paint()
  const top = bodyTopRow(h)
  const frame = panelFrame(h)
  const bar = frame[frame.length - 1]!
  const x = bar.indexOf('Open [Enter]') + 1
  const y = frame.length - 1
  assert.ok(x > 0 && bar.includes('Open [Enter]'), `the painted bar offers the explicit Open:\n${bar}`)

  // PRESS the painted Open, then wheel at the LAST row: the selection cannot
  // move, so the frame stays byte-identical; only the wheel retirement may drop
  // the old press.
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  const pressedFrame = panelFrame(h).join('\n')
  await wheelCell(h, 5, top + 1, 'down')
  assert.equal(panelFrame(h).join('\n'), pressedFrame, 'the boundary wheel repaints the same frame')
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
  assert.deepEqual(h.resumes, [], 'a boundary wheel is a real intent: the old press cannot open a Session')
  assert.equal(h.closes, 0)

  // An inert wheel (header) is consumed but keeps a legal bar press intact.
  // A DIFFERENT verb avoids the terminal's same-word double-click selection.
  const peekX = bar.indexOf('Read [Space]') + 1
  assert.ok(peekX > 0 && bar.includes('Read [Space]'), `the painted bar offers its own Reader:\n${bar}`)
  h.vt.sendInput(`\x1b[<0;${peekX + 1};${y + 1}M`)
  await h.paint()
  await wheelCell(h, 5, 0, 'down')
  h.vt.sendInput(`\x1b[<0;${peekX + 1};${y + 1}m`)
  await h.paint()
  assert.ok(h.view().includes('Transcript · other-se'), 'an inert wheel never cancels a legal bar gesture')
  assert.deepEqual(h.resumes, [], 'the kept bar press runs its own Reader verb, not a resume')
})

test('F2/W10+W11: inert cells consume the wheel without navigating and the chooser never chooses', async () => {
  // A status row squeezed above the list is not a scroll sink; the list below
  // it still navigates.
  const status = harness({ columns: 100, rows: 24 })
  status.handle.setSnapshot(snapshot())
  status.handle.workspaceUnavailable('membership unavailable')
  await status.paint()
  const statusRow = bodyTopRow(status)
  assert.ok(panelFrame(status)[statusRow]!.includes('membership unavailable'), `the status row paints above the list:\n${status.view()}`)
  const statusFrame = status.view()
  await wheelCell(status, 5, statusRow, 'down')
  assert.equal(status.view(), statusFrame, 'a status row is not a wheel sink')
  await wheelCell(status, 5, lineIndexOf(panelFrame(status), 'Other session'), 'down')
  assert.ok(/^> .*Other session/m.test(status.view()), 'the real list body below the status rows still navigates')
  status.dispose()

  // The inline Host-directory editor owns the body: its input and suggestion
  // area are inert and a wheel never verifies/registers a Host path.
  const submitted: string[] = []
  const editor = harness({
    currentSessionId: null,
    initialBrowseScope: 'all',
    initialDirectoryChooser: true,
    initialDirectoryEntry: true,
    initialDirectoryPath: '/launch/failed',
    onAddDirectory: (path) => { submitted.push(path) },
  })
  await editor.paint()
  assert.ok(editor.view().includes('Host directory:'), `the inline Host editor paints its input:\n${editor.view()}`)
  const editorFrame = editor.view()
  const inputRow = lineIndexOf(panelFrame(editor), 'Host directory:')
  await wheelCell(editor, 5, inputRow, 'down')
  await wheelCell(editor, 5, inputRow, 'up')
  assert.equal(editor.view(), editorFrame, 'the inline Host editor is never a wheel sink')
  assert.deepEqual(submitted, [], 'a wheel never verifies or registers a Host directory')
  assert.equal(editor.closes, 0)
  editor.dispose()

  // The Sessionless Choose workspace Browser: a wheel only moves the typed
  // Folder selection; choosing still needs the explicit Enter/click.
  const used: Array<[string, string]> = []
  const chooser = harness({
    columns: 100,
    rows: 24,
    currentSessionId: null,
    initialDirectoryChooser: true,
    onUseDirectory: (workspaceId, canonicalPath) => { used.push([workspaceId, canonicalPath]) },
    onAddDirectory: () => {},
    onNewSession: () => {},
  })
  chooser.handle.setSnapshot(snapshot({ rows: [row(OTHER, 2_000, { title: 'Other session' })] }))
  chooser.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-alpha', path: '/ws/alpha', title: 'Alpha', sessionIds: [OTHER] },
    { workspaceId: 'ws-beta', path: '/ws/beta', title: 'Beta', sessionIds: [] },
  ] })
  settleActivity(chooser)
  await chooser.paint()
  const chooserTop = bodyTopRow(chooser)
  assert.ok(chooser.view().includes('Choose workspace'))
  await wheelCell(chooser, 5, chooserTop, 'down')
  assert.ok(/^> .*Beta/m.test(chooser.view()), `the chooser wheel selects the next typed Folder:\n${chooser.view()}`)
  assert.deepEqual(used, [], 'a wheel never chooses a Workspace')
  assert.equal(chooser.closes, 0)
  assert.ok(!chooser.view().includes('Other session'), 'the chooser wheel never expands or creates a Session')
  chooser.vt.sendInput('\r')
  await chooser.paint()
  assert.deepEqual(used, [['ws-beta', '/ws/beta']], 'Enter is still the explicit choose')
  assert.equal(chooser.closes, 1, 'the chooser returns only through its explicit choose')
})

test('F2/W12: an async Activity refresh keeps the wheel-selected Session and a vanished Reader target exits', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' }), row(THIRD, 1_000, { title: 'Third session' })] }))
  settleActivity(h)
  await h.paint()
  const top = bodyTopRow(h)
  await wheelCell(h, 5, top, 'down')
  assert.ok(/^> .*Other session/m.test(h.view()), 'the wheel selects Other')
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      fact(CURRENT, { running: false, attention: 'none', attentionSourceState: 'known' }),
      fact(OTHER, { running: false, attention: 'none', attentionSourceState: 'known' }),
      questionFact(THIRD),
    ],
    answerEligibility: [eligibility(THIRD)],
  })
  await h.paint()
  assert.ok(/^> .*Other session/m.test(h.view()), 'an async Activity reorder keeps the same typed Session id')
  assert.deepEqual(h.queries, [], 'the wheel itself issues no Host query')

  h.vt.sendInput(' ')
  await h.paint()
  assert.ok(h.view().includes('Transcript · other-se'), 'the wheel-selected Session opens its own Reader')
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(THIRD, 1_000, { title: 'Third session' })] }))
  await h.paint()
  assert.ok(!h.view().includes('Transcript · other-se'), `the Reader exits when its pinned Session leaves the roster:\n${h.view()}`)
  assert.ok(h.view().includes('Sessions · 2') && h.view().includes('Up/Down move'), 'the list stays usable after the Reader exits')
  await wheelCell(h, 5, bodyTopRow(h), 'up')
  assert.ok(/^> .*Third session/m.test(h.view()), `the wheel walks the new painted rows, never the removed target:\n${h.view()}`)
  assert.deepEqual(h.resumes, [])
  assert.equal(h.closes, 0)
})

test('F2/W13: a zero delta or a stale grant is consumed without acting; only a painted wheel navigates', async () => {
  let renders = 0
  let closes = 0
  let rows = 24
  let columns = 100
  const host: SessionWorkspacePanelHost = {
    rows: () => rows,
    columns: () => columns,
    requestRender: () => { renders += 1 },
    notice: () => undefined,
    onQueryChange: () => {},
    onResume: () => {},
    readMarkdown: async () => ({ kind: 'unavailable' }),
    onClose: () => { closes += 1 },
  }
  const panel = new SessionWorkspacePanel(host, { initialMode: 'browse', initialBrowseScope: 'all', currentSessionId: CURRENT })
  panel.setSnapshot(snapshot())
  panel.setActivityFacts({ listRevision: 1, facts: [], answerEligibility: [] })
  panel.render(columns)
  renders = 0
  const event = (overrides: Partial<TuiMouseEvent>): TuiMouseEvent => ({
    type: 'wheel',
    button: 'none',
    x: 5,
    y: 2,
    screenX: 5,
    screenY: 2,
    width: columns,
    height: rows,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 1,
    ...overrides,
  })
  // Primary clicks stay on the fork's onCellPress/onCellClick pair.
  assert.equal(panel.handleMouse(event({ type: 'press', button: 'left' })), undefined,
    'a non-wheel event is left to the original click path')
  // A zero delta is consumed but never reverses a press or navigates.
  assert.deepEqual(panel.handleMouse(event({ wheelDelta: 0 })), { handled: true, render: false })
  assert.equal(renders, 0, 'a zero-delta wheel never requests a repaint')
  // A wheel with no painted scroll pane is consumed, not leaked to the background.
  assert.deepEqual(panel.handleMouse(event({ y: 0 })), { handled: true, render: false })
  assert.equal(renders, 0, 'an inert wheel never requests a repaint')
  // The event grant must be the root box this frame was painted for.
  assert.deepEqual(panel.handleMouse(event({ height: 20 })), { handled: true, render: false })
  assert.equal(renders, 0, 'a grant mismatch never acts on the old hit map')
  // A resize that has not repainted yet is inert.
  rows = 20
  assert.deepEqual(panel.handleMouse(event({ height: 20 })), { handled: true, render: false })
  assert.equal(renders, 0, 'a pre-repaint resize never replays an old cell')
  rows = 24
  // A zero-delta wheel keeps a legal press alive: its release still acts.
  const bar = stripTerminalSequences(panel.render(columns).at(-1) ?? '')
  const barX = bar.indexOf('Return [Enter]') + 1
  assert.ok(barX > 0, `the fake frame paints its Return verb:\n${bar}`)
  panel.onCellPress(barX, rows - 1)
  assert.deepEqual(panel.handleMouse(event({ wheelDelta: 0 })), { handled: true, render: false })
  assert.equal(renders, 0, 'the zero-delta wheel never requests a repaint')
  panel.onCellClick(barX, rows - 1)
  assert.equal(closes, 1, 'a zero-delta wheel never cancels the legal press')
  // The painted frame still navigates through the existing move method once.
  assert.deepEqual(panel.handleMouse(event({})), { handled: true, render: false })
  assert.equal(renders, 1, 'a valid wheel runs exactly one existing navigation request')
  panel.dispose()
})

test('F2/W13: a pre-repaint resize never replays an old wheel cell, and the repainted frame works', async () => {
  const extra = Array.from({ length: 6 }, (_, index) => row(`session-wheel-resize-${index}`, 900 - index, { title: `Resize ${index}` }))
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), ...extra] }))
  settleActivity(h)
  await h.paint()
  const top = bodyTopRow(h)
  // Resize and wheel WITHOUT a frame between the two inputs: the event still
  // names the old painted layout, so it must not act on it.
  h.vt.resize(80, 10)
  h.vt.sendInput(`\x1b[<65;6;${top + 1}M`)
  await h.paint()
  assert.ok(/^> .*Current session/m.test(h.view()), `the pre-repaint wheel is inert:\n${h.view()}`)
  // The resized frame is a fresh grant and the same cells navigate normally.
  const resizedTop = bodyTopRow(h)
  await wheelCell(h, 3, resizedTop, 'down')
  assert.ok(/^> .*Resize 0/m.test(h.view()), `the repainted frame accepts the wheel:\n${h.view()}`)
  assert.deepEqual(h.resumes, [])
  assert.equal(h.closes, 0)
})

test('F2/W13: wheel hit zones follow the 110/112 column threshold and tiny frames', async () => {
  const sessions = Array.from({ length: 8 }, (_, index) => row(`session-wheel-threshold-${index}`, 900 - index, { title: `Threshold ${index}` }))
  const h = harness({ columns: 120, rows: 40 })
  h.handle.setSnapshot(snapshot({ rows: [row(CURRENT, 3_000, { title: 'Current session' }), ...sessions] }))
  h.handle.updateWorkspaces({ type: 'baseline', items: [
    { workspaceId: 'ws-threshold', path: '/ws', title: 'Threshold', sessionIds: [CURRENT, ...sessions.map(item => item.id)] },
  ] })
  settleActivity(h)
  await h.paint()
  await wheelCell(h, 5, bodyTopRow(h), 'down')
  assert.ok(/^> .*Threshold 0/m.test(h.view()), `the wide left column navigates:\n${h.view()}`)
  // 110x12 is BELOW the 112 threshold: one full-width body scrolls.
  h.vt.resize(110, 12)
  await h.paint()
  await wheelCell(h, 60, bodyTopRow(h), 'down')
  assert.ok(/^> .*Threshold 1/m.test(h.view()), `110x12 is one column and its whole body navigates:\n${h.view()}`)
  // 112x12 crosses the threshold: only the left column navigates.
  h.vt.resize(112, 12)
  await h.paint()
  await wheelCell(h, 5, bodyTopRow(h), 'down')
  assert.ok(/^> .*Threshold 2/m.test(h.view()), `112x12 splits and its left column navigates:\n${h.view()}`)
  const splitFrame = h.view()
  await wheelCell(h, 100, bodyTopRow(h), 'down')
  assert.equal(h.view(), splitFrame, 'the right Preview is inert at the exact two-column threshold')
  // Shrink -> grow: the left column is live again, but the old press is not.
  h.vt.resize(120, 40)
  await h.paint()
  await wheelCell(h, 5, bodyTopRow(h), 'down')
  assert.ok(/^> .*Threshold 3/m.test(h.view()), `the grown round trip keeps the left column live:\n${h.view()}`)
  const frame = panelFrame(h)
  const bar = frame[frame.length - 1]!
  const x = bar.indexOf('Read [Space]') + 1
  const y = frame.length - 1
  assert.ok(x > 0 && bar.includes('Read [Space]'), `the wide bar paints its Reader:\n${bar}`)
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  h.vt.resize(80, 10)
  await h.paint()
  h.vt.resize(120, 40)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
  assert.ok(!h.view().includes('Transcript ·'), 'a shrink/grow repaint never revives the old bar press')
  await clickBarAction(h, 'Open [Enter]')
  assert.deepEqual(h.resumes, ['session-wheel-threshold-3'], 'a fresh press on the repainted bar still acts')
  h.dispose()

  // Tiny frames: only a body row that was really painted may navigate. The
  // hidden selection is revealed by growing the SAME open afterwards, so an
  // erroneous navigation cannot hide behind a header/bar-only viewport.
  const one = harness({ columns: 80, rows: 1 })
  one.handle.setSnapshot(snapshot())
  settleActivity(one)
  await one.paint()
  await wheelCell(one, 5, 0, 'down')
  one.vt.resize(80, 24)
  await one.paint()
  assert.ok(/^> .*Current session/m.test(one.view()), `the one-row header never moved the hidden selection:\n${one.view()}`)
  one.dispose()

  const two = harness({ columns: 80, rows: 2 })
  two.handle.setSnapshot(snapshot())
  settleActivity(two)
  await two.paint()
  await wheelCell(two, 5, 1, 'down')
  two.vt.resize(80, 24)
  await two.paint()
  assert.ok(/^> .*Current session/m.test(two.view()), `a two-row frame paints no body and never moves the selection:\n${two.view()}`)
  two.dispose()

  const three = harness({ columns: 80, rows: 3 })
  three.handle.setSnapshot(snapshot())
  settleActivity(three)
  await three.paint()
  await wheelCell(three, 5, 1, 'down')
  assert.ok(/^> .*Other session/m.test(three.view()), `the ONE painted 3-row body row really navigates:\n${three.view()}`)
  const threeFrame = three.view()
  // wheel-UP on the bar row: a wrongly painted bar zone would move the
  // selection back to Current and visibly change this frame.
  await wheelCell(three, 5, 2, 'up')
  assert.equal(three.view(), threeFrame, 'the tiny action bar row is not a wheel sink')
  assert.ok(/^> .*Other session/m.test(three.view()), 'the bar wheel never moved the selection')
  three.dispose()
})

// ── Session Workspace PR2: the real presenter selection report ──────────────

test('the real panel reports ONLY its painted typed Session target across tree/Reader updates', async () => {
  const reports: Array<import('../../src/app/command/session-browser-presentation.ts').SessionInspectorSelection | undefined> = []
  const h = harness({ onInspectorSelection: selection => reports.push(selection) })
  const workspace = {
    revision: 1,
    state: 'ready' as const,
    facts: [
      { workspaceId: 'ws-current', path: '/ws', title: 'Current', sessionIds: [CURRENT] },
      { workspaceId: 'ws-other', path: '/other', title: 'Other', sessionIds: [OTHER] },
    ],
    baselineProven: true,
    answerEligibility: undefined,
  }
  const base = snapshot({ workspace })
  h.handle.setSnapshot(base)
  await h.paint()
  assert.deepEqual(reports.at(-1), { sessionId: CURRENT, origin: 'browse' }, 'the initial typed current-Session row is reported')

  h.handle.setSnapshot({ ...base, refreshError: 'a nonfatal roster fact' })
  await h.paint()
  assert.deepEqual(reports.at(-1), { sessionId: CURRENT, origin: 'browse' }, 'a same-id repaint reports the same selected Session')

  h.vt.sendInput('\x1b[A')
  await h.paint()
  assert.equal(reports.at(-1), undefined, 'a Folder row is never reported as a Session target')
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.deepEqual(reports.at(-1), { sessionId: CURRENT, origin: 'browse' }, 'returning to the Session row reports it again')

  h.vt.sendInput(' ')
  await h.paint()
  assert.equal(reports.at(-1), undefined, 'the full-screen Reader paints no selectable Session target')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.deepEqual(reports.at(-1), { sessionId: CURRENT, origin: 'browse' }, 'leaving the Reader reports the restored typed selection')

  h.handle.setSnapshot(base)
  await h.paint()
  const before = h.view()
  h.handle.setSnapshot({
    ...base,
    inspector: {
      sessionId: CURRENT,
      state: 'ready',
      data: { sessionId: CURRENT, asOfSeq: 3 },
      refreshing: false,
    },
  })
  await h.paint()
  assert.equal(h.view(), before, 'receiving the same-id Inspector snapshot changes no painted frame')
  assert.deepEqual(reports.at(-1), { sessionId: CURRENT, origin: 'browse' }, 'the same-id Inspector snapshot changes no selection')
})

test('the real panel reports a Search result target and reports no target in the inline directory editor', async () => {
  const searchReports: Array<import('../../src/app/command/session-browser-presentation.ts').SessionInspectorSelection | undefined> = []
  const search = harness({ initialMode: 'search', onInspectorSelection: selection => searchReports.push(selection) })
  search.handle.setSnapshot(snapshot({
    query: 'other',
    searchState: 'ready',
    searchResults: [{ row: row(OTHER, 2_000, { title: 'Other session' }), source: 'Content', snippet: 'hit' }],
    hasMore: false,
  }))
  await search.paint()
  assert.deepEqual(searchReports.at(-1), { sessionId: OTHER, origin: 'search' }, 'the selected Search result row is a real Session target')
  search.handle.setSnapshot(snapshot({
    query: 'third',
    searchState: 'ready',
    searchResults: [{ row: row(THIRD, 1_000, { title: 'Third session' }), source: 'Metadata' }],
    hasMore: false,
  }))
  await search.paint()
  assert.deepEqual(searchReports.at(-1), { sessionId: THIRD, origin: 'search' }, 'a different accepted result target is reported')
  // Esc leaves the global search but keeps the query text; the restored Browse
  // row is a BROWSE target, never inferred as Search from the retained query.
  search.vt.sendInput('\x1b')
  await search.paint()
  assert.deepEqual(searchReports.at(-1), { sessionId: CURRENT, origin: 'browse' },
    'Browse after Esc with a retained query reports Browse provenance')
  search.dispose()

  const directoryReports: Array<import('../../src/app/command/session-browser-presentation.ts').SessionInspectorSelection | undefined> = []
  const directory = harness({
    initialDirectoryEntry: true,
    initialDirectoryPath: '/host/proposed',
    onInspectorSelection: selection => directoryReports.push(selection),
  })
  directory.handle.setSnapshot(snapshot())
  await directory.paint()
  assert.equal(directoryReports.at(-1), undefined,
    'the inline directory editor owns the keyboard and reports no Session target')
})
