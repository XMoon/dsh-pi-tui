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
  SessionBrowserReadSnapshot,
  SessionBrowserSubject,
} from '../../src/app/command/session-browser-presentation.ts'
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
  assert.ok(view.includes('Recent sessions · 2'), `the roster count is stated:\n${view}`)
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

test('the Workspace selector is in-place, two options, and a disabled Current never switches', async () => {
  const h = harness()
  h.handle.setSnapshot(snapshot())
  await h.paint()
  h.vt.sendInput('w')
  await h.paint()
  const open = h.view()
  assert.ok(open.includes('Workspace scope:'), `the selector paints inside the header:\n${open}`)
  assert.ok(open.includes('All workspaces') && open.includes('Current workspace unavailable'), 'both options are stated')
  // Move the selector cursor onto the DISABLED Current option and confirm it
  // cannot switch: the cursor is not the selection authority.
  h.vt.sendInput('\x1b[B')
  await h.paint()
  assert.ok(h.view().includes('Workspace scope:'), 'the selector stays open on the disabled option')
  h.vt.sendInput('\r')
  await h.paint()
  assert.ok(h.view().includes('Workspace: All workspaces [w]'), 'a disabled Current never changes the scope')
  h.vt.sendInput('w')
  await h.paint()
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
  assert.ok(squeezed.includes('Recent sessions · 2'))
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
