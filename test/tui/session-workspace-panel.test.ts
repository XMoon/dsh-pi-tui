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
import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserReadSnapshot,
  SessionBrowserSubject,
} from '../../src/app/command/session-browser-presentation.ts'
import type { SessionActivityFact } from '../../src/runtime/session-workspace-facts-port.ts'
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
}

function harness(options: {
  readonly columns?: number
  readonly rows?: number
  readonly currentSessionId?: string
  readonly initialMode?: 'browse' | 'search'
  readonly initialBrowseScope?: 'current' | 'all'
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
  const currentSessionId = options.currentSessionId ?? CURRENT
  const subject: SessionBrowserSubject = {
    currentSessionId,
    currentCwd: '/ws/project',
    isCurrent: options.isCurrent ?? (() => true),
  }
  const handle = app.openSessionWorkspace({
    subject,
    onQueryChange: (raw) => { queries.push(raw) },
    onResume: (sessionId) => { resumes.push(sessionId) },
    onClose: () => { state.closes += 1 },
    initialMode: options.initialMode ?? 'browse',
    initialBrowseScope: options.initialBrowseScope ?? 'all',
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
  }
}

test('the browse list paints the header, the current marker and the selected row, and only a listed non-current row resumes', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Sessions'), `the header names the workspace:\n${view}`)
  assert.ok(view.includes('Current: curren'), `the current Session is stated separately from the selection:\n${view}`)
  assert.ok(view.includes('Workspace: All workspaces [w]'), `the browse scope is stated:\n${view}`)
  assert.ok(view.includes('Sessions · 2'), `the roster count is stated:\n${view}`)
  assert.ok(view.includes('Current session') && view.includes('Other session'), `both titles paint:\n${view}`)
  const lines = view.split('\n')
  assert.ok(lines[lines.length - 1]!.includes('Esc close'), 'the action bar is the last physical row')

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
  assert.ok(h.view().includes('Workspace: All workspaces [w]'), 'the first Esc restores the browse list')
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
  assert.ok(h.view().includes('Esc back'), 'the result list advertises its own Esc')
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
  assert.ok(restored.includes('Workspace: All workspaces [w]'))
  assert.ok(/^> .*Other session/m.test(restored), `the pre-search selection survives:\n${restored}`)
})

test('Current is proved only by the official workspace membership; a lost proof falls back to All once', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  assert.ok(h.view().includes('Checking current workspace…'),
    'before the official baseline no membership judgment is painted')
  assert.ok(h.view().includes('Other session'), 'the pending scope filters nothing')

  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws/project', title: 'project', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/other', title: 'other', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  const scoped = h.view()
  assert.ok(scoped.includes('Workspace: Current workspace [w]'), `the official membership is applied:\n${scoped}`)
  assert.ok(scoped.includes('Current session'))
  assert.ok(!scoped.includes('Other session'), 'a Session outside the proved Workspace is hidden in Current')

  // `order` never creates an unknown Workspace, and removing the proved one is
  // ONE visible fallback to All — not an empty list and not a stale membership.
  h.handle.updateWorkspaces({ type: 'order', workspaceIds: ['ghost'] })
  await h.paint()
  assert.ok(h.view().includes('Workspace: Current workspace [w]'), 'order never invents a membership')
  h.handle.updateWorkspaces({ type: 'remove', workspaceId: 'ws-a' })
  await h.paint()
  const fallback = h.view()
  assert.ok(fallback.includes('Workspace: All workspaces [w]'), 'the lost proof falls back to All')
  assert.ok(fallback.includes('Other session'), 'All restores every listed row')
  assert.ok(fallback.includes('Current workspace unavailable — showing all workspaces'),
    'the fallback is stated once instead of a silent scope change')

  h.handle.workspaceUnavailable('Workspace scope unavailable')
  await h.paint()
  assert.ok(h.view().includes('Workspace scope unavailable'), 'a failed stream degrades to one visible status')
  assert.ok(h.view().includes('Other session'), 'a failed workspace stream never hides the Session list')
})

test('a missing initial Current membership falls back to All with one explicit status', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [{ workspaceId: 'ws-b', path: '/other', title: 'other', sessionIds: [OTHER] }],
  })
  await h.paint()
  assert.ok(h.view().includes('Workspace: All workspaces [w]'), 'a missing membership falls back to All')
  assert.ok(h.view().includes('Current workspace unavailable — showing all workspaces'),
    'the fallback is not silent')
})

test('an ambiguous initial Current membership falls back to All with one explicit status', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [CURRENT] },
    ],
  })
  await h.paint()
  assert.ok(h.view().includes('Workspace: All workspaces [w]'),
    'two Workspaces containing the current Session are not a unique proof')
  assert.ok(h.view().includes('Current workspace unavailable — showing all workspaces'),
    'an ambiguous membership is stated once')
})

test('a missing-Current fallback status is cleared when a later replace proves Current', async () => {
  const h = harness({ initialBrowseScope: 'current' })
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [{ workspaceId: 'ws-b', path: '/other', title: 'other', sessionIds: [OTHER] }],
  })
  await h.paint()
  assert.ok(h.view().includes('Current workspace unavailable — showing all workspaces'))
  // A LATER `replace` proves the unique membership: the stale fallback line must
  // not contradict the now-enabled Current scope.
  h.handle.updateWorkspaces({
    type: 'replace',
    items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  assert.ok(!h.view().includes('Current workspace unavailable'), 'the old fallback line is cleared')
  h.vt.sendInput('w')
  await h.paint()
  assert.ok(h.view().includes('Workspace scope:') && !h.view().includes('Current workspace unavailable'),
    'the Current option is enabled again without a contradictory status')
})

test('a lost-Current fallback status is cleared when a later upsert re-proves it', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [{ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }],
  })
  await h.paint()
  h.vt.sendInput('w')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Workspace: Current workspace [w]'))
  h.handle.updateWorkspaces({ type: 'remove', workspaceId: 'ws-a' })
  await h.paint()
  assert.ok(h.view().includes('Current workspace unavailable — showing all workspaces'))
  h.handle.updateWorkspaces({
    type: 'upsert',
    workspace: { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
  })
  await h.paint()
  assert.ok(!h.view().includes('Current workspace unavailable'),
    'a re-proved membership clears the lost-membership status')
})

test('replace and upsert refold the official membership used by Current', async () => {
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
  h.vt.sendInput('w')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Workspace: Current workspace [w]'))
  assert.ok(!h.view().includes('Other session'))
  // replace: the SAME Workspace gains a member.
  h.handle.updateWorkspaces({
    type: 'replace',
    items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT, OTHER] },
      { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [] },
    ],
  })
  await h.paint()
  assert.ok(h.view().includes('Other session'), 'a replace membership change is applied to Current')
  // upsert adds a workspace that does not contain the current Session: Current
  // stays anchored to the unique proven Workspace.
  h.handle.updateWorkspaces({
    type: 'upsert',
    workspace: { workspaceId: 'ws-c', path: '/third', title: 'c', sessionIds: [THIRD] },
  })
  await h.paint()
  assert.ok(h.view().includes('Workspace: Current workspace [w]'))
  assert.ok(!h.view().includes('Third session'), 'an upsert never creates a Current member')
})

test('a scope/membership change re-anchors the selection and never resumes a hidden row', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot({
    rows: [row(CURRENT, 3_000, { title: 'Current session' }), row(OTHER, 2_000, { title: 'Other session' })],
  }))
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [
      { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] },
    ],
  })
  await h.paint()
  h.vt.sendInput('\x1b[B') // select the other-workspace row in All
  await h.paint()
  h.vt.sendInput('w')
  await h.paint()
  h.vt.sendInput('\x1b[B') // the selector starts on All; move to Current
  h.vt.sendInput('\r')
  await h.paint()
  const scoped = h.view()
  assert.ok(scoped.includes('Workspace: Current workspace [w]'))
  assert.ok(!scoped.includes('Other session'), 'the other-workspace row is hidden')
  assert.ok(/^> .*Current session/m.test(scoped), 'the selection re-anchored inside the visible set')
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [], 'the hidden row can never be resumed')

  h.handle.updateWorkspaces({ type: 'remove', workspaceId: 'ws-a' })
  await h.paint()
  assert.ok(h.view().includes('Workspace: All workspaces [w]'), 'a lost proof falls back to All')
  assert.ok(h.view().includes('Other session'), 'All restores every listed row')
})

test('the Workspace selector is in-place, lists every official option, and a disabled option never switches', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('w')
  await h.paint()
  const open = h.view()
  assert.ok(open.includes('Workspace scope:'), `the selector paints inside the header header row:\n${open}`)
  assert.ok(open.includes('All workspaces'), 'the All option is stated')
  assert.ok(open.includes('Current workspace unavailable'), 'an unproven Current is stated as unavailable')
  // Move the selector cursor onto the DISABLED Current option and confirm it
  // cannot switch: the cursor is not the scope authority and Enter is inert.
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(h.view().includes('Workspace scope:'), 'the selector stays open on the disabled option')
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Workspace scope:'), 'Enter on a disabled option is inert')
  h.vt.sendInput('\x1b')
  await h.paint()
  assert.ok(h.view().includes('Workspace: All workspaces [w]'), 'Esc cancels without changing the scope')
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
  h.handle.workspaceUnavailable('Workspace scope unavailable')
  await h.paint()
  const squeezed = h.view()
  assert.ok(squeezed.includes('Sessions · 2'))
  assert.ok(squeezed.includes('Workspace scope unavailable'))
  assert.ok(squeezed.includes('Some session details are unavailable'))
  assert.ok(!squeezed.includes('Other session'), `status rows consumed the list budget:\n${squeezed}`)
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
    assert.ok(view.includes('Alpha session'), `${width} columns: the first identity survives a long cwd:\n${view}`)
    assert.ok(view.includes('Beta session'), `${width} columns: two same-cwd Sessions stay distinguishable:\n${view}`)
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

/** One SGR primary press + release at the SAME 0-based panel cell. */
async function clickCell(h: Harness, x: number, y: number): Promise<void> {
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  await h.paint()
  h.vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
  await h.paint()
}

test('the grouped list paints Needs attention → Working → Recent with plain status labels and counts', async () => {
  const h = harness({ columns: 100, rows: 24 })
  h.handle.setSnapshot(snapshot({
    rows: [
      row('session-needs', 4_000, { title: 'Needs row' }),
      row('session-working', 3_000, { title: 'Working row' }),
      row('session-unverified', 2_000, { title: 'Unproved row' }),
      row('session-recent', 1_000, { title: 'Recent row' }),
    ],
  }))
  h.handle.setActivityFacts({
    listRevision: 1,
    facts: [
      questionFact('session-needs', { running: true }),
      fact('session-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      questionFact('session-unverified'),
      fact('session-recent', { running: false, attention: 'none', attentionSourceState: 'known' }),
    ],
    answerEligibility: [eligibility('session-needs')],
  })
  await h.paint()
  const view = h.view()
  assert.ok(view.includes('Needs attention · 1'), `the Needs group is stated with its count:\n${view}`)
  assert.ok(view.includes('Working · 1'), `the Working group is stated:\n${view}`)
  assert.ok(view.includes('Recent · 2'), `the unproved and idle rows stay in Recent:\n${view}`)
  assert.ok(/Question · Working/.test(view), `a needs+running row carries the running sub-fact:\n${view}`)
  assert.ok(view.includes('Pending unverified'),
    `a pending candidate this Client cannot answer is never a Needs row:\n${view}`)
  assert.ok(!view.includes('Running unknown'), 'a proved running fact never paints Running unknown')
  // The group order is frozen: Needs first, Recent last.
  assert.ok(view.indexOf('Needs attention · 1') < view.indexOf('Working · 1'))
  assert.ok(view.indexOf('Working · 1') < view.indexOf('Recent · 2'))
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
  assert.ok(peek.includes('Esc back'), 'the Peek advertises its own exit')
  assert.ok(!/Allow|Deny|Reject|Answer/.test(peek), `Peek carries no answer form:\n${peek}`)
  assert.deepEqual(h.resumes, [], 'opening Peek never resumes or writes anything')
  assert.deepEqual(h.queries, [], 'opening Peek never edits the search')

  h.vt.sendInput('\x1b')
  await h.paint()
  const restored = h.view()
  assert.ok(restored.includes('Workspace: All workspaces [w]'), 'Esc returns to the browse list')
  assert.ok(/^> .*Other session/m.test(restored), `the Peek returns to the SAME selected row:\n${restored}`)
  h.vt.sendInput('\r')
  await h.paint()
  assert.deepEqual(h.resumes, [OTHER], 'Enter from Peek is the ONE re-proved resume intent')
})

test('the selector lists every official Workspace, filters by the official membership and keeps Unassigned proved-only', async () => {
  const h = harness({ columns: 100, rows: 24 })
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
  h.vt.sendInput('w')
  await h.paint()
  const open = h.view()
  for (const label of ['All workspaces', 'Current workspace', 'Alpha', 'Beta', 'Empty', 'Unassigned']) {
    assert.ok(open.includes(label), `the selector lists ${label}:\n${open}`)
  }
  // all → current → Alpha → Beta → Empty → Unassigned: choose Beta.
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  const scoped = h.view()
  assert.ok(scoped.includes('Workspace: Beta'), `the official WorkspaceId scope is applied:\n${scoped}`)
  assert.ok(scoped.includes('Other session'), 'the official member is listed')
  assert.ok(!scoped.includes('Current session'), 'a non-member is filtered out')
  // Unassigned lists only the Session no official Workspace contains.
  h.vt.sendInput('w')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  const unassigned = h.view()
  assert.ok(unassigned.includes('Workspace: Unassigned'), `the Unassigned scope is applied:\n${unassigned}`)
  assert.ok(unassigned.includes('Cold session'), 'a zero-membership Session is listed')
  assert.ok(!unassigned.includes('Other session'), 'a proved member is never Unassigned')
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
  h.vt.sendInput('w')
  await h.paint()
  const view = h.view()
  const options = view.split('\n').filter(line => line.includes('Same title'))
  assert.equal(options.length, 2, `both same-title Workspaces are listed:\n${view}`)
  assert.ok(options.some(line => line.includes('ws-duplicate')),
    `a duplicated Host title carries the official id:\n${view}`)
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
  assert.ok(h.view().includes('Workspace: All workspaces [w]'), 'Esc leaves Peek even at 80x10')
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

test('the header affordances are real hit targets: w, / Search and the outside-attention line', async () => {
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
  // Current scope proves the outside need; the header states it without a guess.
  h.vt.sendInput('w')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  const scoped = panelFrame(h)
  assert.ok(scoped.join('\n').includes('1 other session needs attention'),
    `the outside attention line states the proved count:\n${scoped.join('\n')}`)
  const outsideLine = lineIndexOf(scoped, 'needs attention')
  const attentionText = scoped[outsideLine]!
  await clickCell(h, attentionText.indexOf('needs attention'), outsideLine)
  assert.ok(h.view().includes('Workspace: All workspaces [w]'),
    'clicking the outside-attention affordance returns to All')
  // The `[w]` header hint opens the in-place selector.
  const subHeader = panelFrame(h)[1]!
  await clickCell(h, subHeader.indexOf('[w]') + 1, 1)
  assert.ok(h.view().includes('Workspace scope:'), 'the [w] hint opens the selector')
  h.vt.sendInput('\x1b')
  await h.paint()
  // The `/ Search` hint focuses the global editor.
  const searchHeader = panelFrame(h)[1]!
  await clickCell(h, searchHeader.indexOf('/ Search') + 1, 1)
  assert.ok(h.view().includes('Search all workspaces'), 'the / Search hint enters the global search')
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
  assert.ok(proved.includes('Needs attention · 1'), `the proved need is painted at once:\n${proved}`)
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
  assert.ok(revoked.includes('Pending unknown · Working'),
    `the row keeps its unproved pending state while working:\n${revoked}`)
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

test('a clipped [w] hint keeps no hit region: the painted / Search wins the click', async () => {
  const h = harness({ columns: 60, rows: 24 })
  h.handle.setSnapshot(snapshot())
  h.handle.updateWorkspaces({
    type: 'baseline',
    items: [{
      workspaceId: 'ws-long',
      path: '/ws/long',
      // 40 columns: the applied scope label plus ` [w]` is 55 cells, so the
      // hint is clipped by the trailing reservation but still STARTS inside the
      // painted row — the exact overlap a naive hit map would create.
      title: 'Long workspace name pushing hint off row',
      sessionIds: [CURRENT],
    }],
  })
  await h.paint()
  h.vt.sendInput('w')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\r')
  await h.paint()
  const subHeader = panelFrame(h)[1]!
  assert.ok(subHeader.includes('Workspace: Long workspace'), 'the long official title is the applied scope label')
  assert.ok(!subHeader.includes('[w]'), `the hint is really clipped at 60 columns:\n${subHeader}`)
  assert.ok(subHeader.includes('/ Search'), `the painted trailing affordance:\n${subHeader}`)
  await clickCell(h, subHeader.indexOf('/ Search') + 1, 1)
  const view = h.view()
  assert.ok(view.includes('Search all workspaces'), `the painted / Search opens the search:\n${view}`)
  assert.ok(!view.includes('Workspace scope:'), 'the clipped [w] never opens the selector')
})

test('a Working row keeps its unproved Pending state visible', async () => {
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
  assert.ok(view.includes('Working · 3'), `all three running rows share the Working group:\n${view}`)
  assert.ok(view.includes('Pending denied · Working'), `a denied pending state stays visible:\n${view}`)
  assert.ok(view.includes('Pending unknown · Working'), `an unknown pending state stays visible:\n${view}`)
  assert.ok(view.includes('Pending unavailable · Working'), `an unavailable pending state stays visible:\n${view}`)
})

test('the read-only Peek names the OFFICIAL Workspace id, not only its title', async () => {
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
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const peek = h.view()
  assert.ok(peek.includes('Beta (ws-beta)'),
    `the Peek keeps the official Workspace identity beside the Host title:\n${peek}`)
  assert.ok(peek.includes('Running: Unknown'), 'a missing Activity sample is stated, not guessed')
})

test('Host titles that sanitize to the same visible text are still distinguishable', async () => {
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
  h.vt.sendInput('w')
  await h.paint()
  const options = h.view().split('\n').filter(line => line.includes('Alpha'))
  assert.equal(options.length, 2, `both colliding Workspaces are listed:\n${h.view()}`)
  assert.ok(options.every(line => line.includes('ws-collision')),
    `a collision after sanitization still carries the official id:\n${options.join('\n')}`)
})

test('official Workspace ids that share a prefix stay distinguishable in the selector and Peek', async () => {
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
  h.vt.sendInput('w')
  await h.paint()
  const options = h.view().split('\n').filter(line => line.includes('Shared'))
  assert.equal(options.length, 2, `both same-title Workspaces are listed:\n${h.view()}`)
  // A fixed-length truncation would render both labels identically; the labels
  // must resolve to DIFFERENT official identities.
  assert.ok(options.some(line => line.includes('workspace-abcdef-1')), options.join('\n'))
  assert.ok(options.some(line => line.includes('workspace-abcdef-2')), options.join('\n'))
  h.vt.sendInput('\x1b')
  await h.paint()
  h.vt.sendInput('\x1b[B')
  await h.paint()
  h.vt.sendInput(' ')
  await h.paint()
  const peek = h.view()
  assert.ok(peek.includes('(workspace-abcdef-2)'),
    `the Peek carries the FULL official Workspace id:\n${peek}`)
})
