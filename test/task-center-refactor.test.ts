import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskBrowserPanel, type TaskPanelItem } from '../src/task-panel.ts'

const job = (value: string, status = 'running'): TaskPanelItem => ({
  value,
  label: value,
  status,
  active: status === 'running' || status === 'stopping',
  source: 'job',
  type: 'bash',
  canStop: status === 'running' || status === 'stopping',
  startedAt: Date.now(),
  group: 'jobs',
})

test('Task Center explicit search owns printable keys and Esc exits search first', () => {
  const actions: Array<[string, string]> = []
  const panel = new TaskBrowserPanel([job('stop-me')], 10, {
    mode: 'full',
    enableSearch: true,
    header: 'Tasks',
    onStop: (value) => actions.push([value, 'stop']),
  }, () => {}, () => {}, () => {})
  panel.handleInput('/')
  for (const key of 'issue') panel.handleInput(key)
  assert.equal(panel.getFilter(), 'issue')
  for (const key of ' stop') panel.handleInput(key)
  assert.equal(panel.getFilter(), 'issue stop')
  assert.deepEqual(actions, [])
  panel.handleInput('\x1b')
  assert.equal(panel.getFilter(), 'issue stop')
  panel.dispose()
})

test('Task Center stop is capability-gated and confirmed', () => {
  const actions: Array<[string, string]> = []
  const panel = new TaskBrowserPanel([job('running'), job('done', 'completed')], 10, {
    mode: 'full',
    enableSearch: true,
    header: 'Tasks',
    onStop: (value) => actions.push([value, 'stop']),
  }, () => {}, () => {}, () => {})
  panel.handleInput('S')
  assert.deepEqual(actions, [])
  assert.match(panel.render(100).join('\n'), /confirm stop/i)
  panel.handleInput('y')
  assert.deepEqual(actions, [['running', 'stop']])
  panel.dispose()
})

test('Quick Tasks retains active ancestor closure and exposes shared transition state', () => {
  const parent: TaskPanelItem = {
    value: 'agent:parent', label: 'parent', status: 'inactive', active: false,
    source: 'subagent', type: 'subagent', depth: 1, hasChildren: true, group: 'subagents',
  }
  const child: TaskPanelItem = {
    value: 'agent:child', label: 'child', status: 'running', active: true,
    source: 'subagent', type: 'subagent', depth: 2, parentId: 'agent:parent', group: 'subagents',
  }
  let state: ReturnType<TaskBrowserPanel['getViewState']> | undefined
  const panel = new TaskBrowserPanel([parent, child], 10, {
    mode: 'quick', enableSearch: true, header: 'Tasks', initialExpandedIds: ['agent:parent'],
    onViewFull: next => { state = next },
  }, () => {}, () => {}, () => {})
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'agent:child', 'task:view-all'])
  assert.equal(panel.visibleItems()[0]!.ancestorContext, true)
  // The ONLY keyboard way into Full is the pseudo-row + Enter: no `T`.
  panel.handleInput('\x1b[B')
  panel.handleInput('\x1b[B')
  assert.equal(panel.getViewState().selectedId, 'task:view-all')
  panel.handleInput('\r')
  assert.equal(state?.scope, 'active')
  assert.equal(state?.selectedId, 'task:view-all')
  assert.deepEqual([...(state?.expandedIds ?? [])], ['agent:parent'])
  assert.deepEqual([...(state?.collapsedIds ?? [])], [])
  panel.dispose()
})

test('explicit search mode: Esc exits search first, a second Esc closes the panel', () => {
  let cancelled = 0
  const panel = new TaskBrowserPanel([job('running')], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks',
  }, () => {}, () => { cancelled += 1 }, () => {})
  panel.handleInput('/')
  panel.handleInput('s')
  assert.equal(panel.getFilter(), 's')
  panel.handleInput('\x1b')
  assert.equal(panel.getFilter(), 's', 'first Esc leaves search mode and keeps the query')
  assert.equal(cancelled, 0)
  panel.render(100)
  panel.handleInput('\x1b')
  assert.equal(cancelled, 1, 'second Esc (navigation mode) closes the panel')
  panel.dispose()
})

test('responsive widths: list-only, inline detail, and two-column detail pane', () => {
  const items: TaskPanelItem[] = [
    { ...job('job:1'), label: 'build', detail: 'compile step' },
    { value: 'agent:a', label: 'planner', status: 'running', active: true, source: 'subagent', type: 'subagent', depth: 1, group: 'subagents', canStop: true },
  ]
  for (const width of [60, 80, 100, 120, 160]) {
    const panel = new TaskBrowserPanel(items, 10, {
      mode: 'full', enableSearch: true, header: 'Tasks', groupLabels: true,
    }, () => {}, () => {}, () => {})
    const lines = panel.render(width)
    assert.ok(lines.length > 0, `width ${width} must render`)
    const plain = lines.join('\n')
    if (width < 70) {
      assert.ok(!plain.includes('Selected'), `width ${width}: list-only, no detail pane`)
      assert.ok(!plain.includes('compile step'), `width ${width}: no inline detail below 70`)
    } else if (width < 110) {
      assert.ok(/kind\s+bash/.test(plain), `width ${width}: inline detail appears 70-109`)
      assert.ok(/status\s+running/.test(plain), `width ${width}: inline detail carries status`)
      assert.ok(!plain.includes('│ Selected'), `width ${width}: no two-column pane below 110`)
    } else {
      assert.ok(plain.includes('Selected'), `width ${width}: detail pane appears at 110+`)
      assert.ok(plain.includes('│'), `width ${width}: pane separator rendered`)
      assert.ok(plain.includes('kind      bash'), `width ${width}: job detail pane fields`)
    }
    panel.dispose()
  }
})

test('Quick view-all pseudo-row carries no status tail (review round: cosmetic)', () => {
  const panel = new TaskBrowserPanel([job('running')], 10, {
    mode: 'quick', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  const plain = panel.render(80).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  const row = plain.split('\n').find(line => line.includes('Open Task Center'))!
  assert.ok(row.includes('Open Task Center · 0 agents · 1 job…'),
    `pseudo-row present with separate agent/job counts:\n${plain}`)
  assert.ok(!/Open Task Center[^\n]*completed/.test(row), `no completed tail:\n${row}`)
  panel.dispose()
})

test('a stale restored type filter snaps to All instead of a dead view', () => {
  const panel = new TaskBrowserPanel([job('running')], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks', initialTypeFilter: 'pwsh',
  }, () => {}, () => {}, () => {})
  const plain = panel.render(80).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(plain.includes('build') || plain.includes('running'), `restored type must not hide rows:\n${plain}`)
  assert.ok(!plain.includes('[pwsh]'), `vanished type must not stay active:\n${plain}`)
  panel.dispose()
})

test('acknowledge scope is the VIEWPORT, not the whole projection (PR review M1)', () => {
  // 20 failures, Quick shows the attention projection with maxVisible 8:
  // opening the browser acknowledges ONLY the first 8 (the ones actually
  // rendered); the 12 below the fold keep their footer attention.
  const failures: TaskPanelItem[] = Array.from({ length: 20 }, (_, i) => ({
    value: `job:f${i}`, label: `failure ${i}`, status: 'failed', active: false, attention: true,
    source: 'job', type: 'bash', startedAt: Date.now(), group: 'jobs',
  }))
  const panel = new TaskBrowserPanel(failures, 8, {
    mode: 'quick', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  assert.equal(panel.visibleItems().filter(item => item.kind !== 'view-full').length, 20,
    'the projection holds every failure (plus the quick view-all pseudo-row)')
  assert.equal(panel.viewportItems().length, 8, 'the viewport renders only maxVisible rows')
  assert.deepEqual(panel.viewportItems().map(item => item.value),
    Array.from({ length: 8 }, (_, i) => `job:f${i}`),
    'the viewport is the scroll window from the top (the pseudo-row is beyond the fold)')
  assert.ok(panel.viewportItems().every(item => item.attention === true), 'every visible row is an attention row')
  panel.dispose()
})

test('scrolling new attention rows into view exposes them exactly once (PR review P1/P2)', () => {
  // 20 failures in an 8-row viewport: the FIRST frame exposes the top 8,
  // scrolling exposes the next rows — each row exactly once, and rows
  // that scroll back out are never re-exposed.
  const failures: TaskPanelItem[] = Array.from({ length: 20 }, (_, i) => ({
    value: `job:f${i}`, label: `failure ${i}`, status: 'failed', active: false, attention: true,
    source: 'job', type: 'bash', startedAt: Date.now(), group: 'jobs',
  }))
  const exposed: string[] = []
  const panel = new TaskBrowserPanel(failures, 8, {
    mode: 'full', enableSearch: true, header: 'Tasks',
    onViewportExpose: ids => exposed.push(...ids),
  }, () => {}, () => {}, () => {})
  // First render: the top of the viewport is exposed.
  panel.render(80)
  assert.deepEqual(exposed, Array.from({ length: 8 }, (_, i) => `job:f${i}`))
  // Scroll down row by row (the scroll window overlaps by maxVisible-1,
  // so every cursor step admits exactly one NEW row into the viewport):
  // each newly visible failure is exposed exactly once.
  for (let step = 0; step < 12; step += 1) {
    panel.handleInput('\x1b[B')
    panel.render(80)
  }
  assert.deepEqual(exposed,
    [...Array.from({ length: 8 }, (_, i) => `job:f${i}`), ...Array.from({ length: 5 }, (_, i) => `job:f${i + 8}`)],
    'rows entering the viewport are exposed exactly once, in order')
  // Scroll back to the top: previously-seen rows are never re-exposed.
  for (let step = 0; step < 12; step += 1) {
    panel.handleInput('\x1b[A')
    panel.render(80)
  }
  assert.equal(exposed.length, 13, 'no re-exposure of already-seen rows')
  panel.dispose()
})

test('a STABLE id re-entering failure is exposed again (P2 edge: id reuse)', () => {
  // The runtime supports stable-id reuse: when the same job id exits the
  // failure set and later re-enters it, that is a NEW attention event.
  // The panel's seen-set must forget the old exposure accordingly.
  const exposed: string[] = []
  const panel = new TaskBrowserPanel([
    { ...job('job:j1'), status: 'failed', active: false, attention: true },
  ], 8, {
    mode: 'full', enableSearch: true, header: 'Tasks',
    onViewportExpose: ids => exposed.push(...ids),
  }, () => {}, () => {}, () => {})
  panel.render(80)
  assert.deepEqual(exposed, ['job:j1'], 'first failure is exposed once')
  // The job leaves the failure set (e.g. it is retried and now runs).
  panel.setItems([{ ...job('job:j1') }])
  panel.render(80)
  assert.equal(exposed.length, 1, 'while not failing, no exposure happens')
  // The SAME id fails again: a fresh attention event must re-expose it.
  panel.setItems([
    { ...job('job:j1'), status: 'failed', active: false, attention: true },
  ])
  panel.render(80)
  assert.deepEqual(exposed, ['job:j1', 'job:j1'],
    'the second failure of the same id must be exposed again (the runtime treats it as new)')
  panel.dispose()
})

test('search mode renders its own hint — query actions, never the task actions', () => {
  const panel = new TaskBrowserPanel([
    { ...job('stop-me'), label: 'build' },
    { ...job('job:2'), status: 'completed' },
  ], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  panel.handleInput('/')
  const view = panel.render(100).join('\n')
  // esc back leads the verb list: a 1-line hint on an 80-column terminal
  // truncates its tail, so the escape verb must never be the clipped part.
  const searchHint = 'type to filter · Esc back · ←→ edit · ↑↓ select · Tab/⇧Tab type · Enter open'
  assert.ok(view.includes(searchHint), `search-mode hint must advertise the query actions:\n${view}`)
  for (const stale of ['A scope', 'N next running', 'S stop', 'R refresh', '←→ tree']) {
    assert.ok(!view.includes(stale), `search-mode hint must not advertise '${stale}':\n${view}`)
  }
  panel.dispose()
})

test('search-mode hint keeps Esc back visible at 80 columns', () => {
  const panel = new TaskBrowserPanel([job('build')], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  panel.handleInput('/')
  const view = panel.render(80).join('\n')
  const hintRow = view.split('\n').find(line => line.includes('type to filter'))
  assert.ok(hintRow !== undefined, `search hint missing at 80 cols:\n${view}`)
  assert.ok(hintRow.includes('Esc back'), `Esc back must survive the 80-column hint:\n${view}`)
  // Shift+Tab reverse type cycling must be discoverable in search mode too.
  assert.ok(hintRow.includes('⇧Tab'), `reverse type cycling must be discoverable:\n${view}`)
  // The ordinary task actions stay out of search mode here too.
  assert.ok(!view.includes('A scope') && !view.includes('S stop'), `no task actions in search mode:\n${view}`)
  panel.dispose()
})

test('search mode: A/S/R/N are query text, ←→ edit the query (never tree actions)', () => {
  const panel = new TaskBrowserPanel([job('stop-me')], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  panel.handleInput('/')
  // Every ordinary task action letter is a query character in search mode.
  for (const key of ['A', 'S', 'R', 'N', 's', 'a', 'n', 'r']) panel.handleInput(key)
  assert.equal(panel.getFilter(), 'ASRNsanr')
  assert.deepEqual(panel.visibleItems(), [],
    'a non-matching query filters the list (no task action side effects)')
  // ←→ edit the query text (cursor movement), never tree expand/collapse.
  panel.handleInput('\x1b[D') // Left
  panel.handleInput('X')
  assert.equal(panel.getFilter(), 'ASRNsanXr', 'Left + X must insert before the last character')
  const expandedBefore = [...panel.visibleItems()]
  panel.handleInput('\x1b[C') // Right — moves the cursor, no tree action
  assert.equal(panel.getFilter(), 'ASRNsanXr', 'Right must not alter the query')
  assert.deepEqual(panel.visibleItems(), expandedBefore, 'Right must not expand/collapse rows')
  // Esc still exits search mode (query kept) and the normal task hint
  // returns (the search-mode hint is gone).
  panel.handleInput('\x1b')
  const afterEsc = panel.render(100).join('\n')
  assert.ok(!afterEsc.includes('type to filter · Esc back'), `first Esc must leave search mode:\n${afterEsc}`)
  assert.ok(afterEsc.includes('A scope'), `normal task actions return after Esc:\n${afterEsc}`)
  panel.dispose()
})

// ── Quick / Full keyboard contract (0.1.6 UX fix) ──────────────────────────

const agentRow = (value: string): TaskPanelItem => ({
  value, label: value, status: 'running', active: true,
  source: 'subagent', type: 'subagent', group: 'subagents',
})

test('Quick Tasks ignores every non-whitelisted keyboard action', () => {
  const calls = { stop: [] as string[], refresh: 0, viewFull: 0, cancel: 0 }
  const panel = new TaskBrowserPanel(
    [job('job:a'), job('job:b')], 10,
    {
      mode: 'quick', enableSearch: true, header: 'Tasks',
      onStop: value => calls.stop.push(value),
      onRefresh: () => { calls.refresh += 1 },
      onViewFull: () => { calls.viewFull += 1 },
    },
    () => {}, () => { calls.cancel += 1 }, () => {})
  const before = panel.getViewState()
  assert.equal(before.selectedId, 'job:a')
  for (const key of ['/', 'a', 'A', 'n', 'N', 's', 'S', 'r', 'R', 't', 'T', 'x', '\x1b[5~', '\x1b[6~', '\x1b[Z']) {
    panel.handleInput(key)
  }
  const after = panel.getViewState()
  assert.equal(after.scope, before.scope, 'scope must not change')
  assert.equal(after.searchMode, false, 'Quick never enters search')
  assert.equal(after.searchQuery, '')
  assert.equal(after.typeFilter, before.typeFilter, 'non-whitelisted input must not change the type filter')
  assert.equal(after.selectedId, before.selectedId, 'non-whitelisted input must not move the selection')
  assert.equal(panel.getFilter(), '')
  assert.deepEqual(calls.stop, [], 'no stop action')
  assert.equal(calls.refresh, 0, 'no refresh action')
  assert.equal(calls.viewFull, 0, 'no Quick → Full transition')
  assert.equal(calls.cancel, 0, 'nothing but Esc closes Quick')
  assert.ok(!panel.render(100).join('\n').includes('confirm stop'), 'no hidden stop confirmation')
  panel.handleInput('\x1b')
  assert.equal(calls.cancel, 1, 'a single Esc closes Quick')
  panel.dispose()
})

test('Quick Tasks: the original S → Esc regression closes exactly once', () => {
  let cancelled = 0
  const panel = new TaskBrowserPanel([job('job:a')], 10, {
    mode: 'quick', enableSearch: true, header: 'Tasks', onStop: () => {},
  }, () => {}, () => { cancelled += 1 }, () => {})
  panel.handleInput('S')
  assert.ok(!panel.render(100).join('\n').includes('confirm stop'),
    'S must not arm a stop confirmation in Quick')
  panel.handleInput('\x1b')
  assert.equal(cancelled, 1, 'one Esc closes Quick instead of cancelling hidden state')
  panel.dispose()
})

test('Quick Tasks: / and T followed by a single Esc each close Quick', () => {
  for (const key of ['/', 'T']) {
    let cancelled = 0
    const panel = new TaskBrowserPanel([job('job:a')], 10, {
      mode: 'quick', enableSearch: true, header: 'Tasks',
    }, () => {}, () => { cancelled += 1 }, () => {})
    panel.handleInput(key)
    panel.handleInput('\x1b')
    assert.equal(cancelled, 1, `${key} must be a no-op followed by a single-Esc close`)
    panel.dispose()
  }
})

test('Quick Tasks whitelist still navigates, filters types and opens rows', () => {
  let cancelled = 0
  const panel = new TaskBrowserPanel(
    [job('job:a'), job('job:b'), agentRow('agent:c')], 10,
    { mode: 'quick', enableSearch: true, header: 'Tasks' },
    () => {}, () => { cancelled += 1 }, () => {})
  panel.handleInput('\x1b[B')
  assert.equal(panel.getViewState().selectedId, 'job:b', '↓ moves the selection')
  panel.handleInput('\x1b[A')
  assert.equal(panel.getViewState().selectedId, 'job:a', '↑ moves the selection')
  panel.handleInput('\t')
  assert.equal(panel.getViewState().typeFilter, 'bash', 'Tab cycles the type filter forward')
  panel.handleInput('\t')
  assert.equal(panel.getViewState().typeFilter, 'subagent')
  panel.handleInput('\t')
  assert.equal(panel.getViewState().typeFilter, null)
  panel.handleInput('\x1b')
  assert.equal(cancelled, 1, 'Esc closes Quick')
  panel.dispose()

  let opened: string | undefined
  const panel2 = new TaskBrowserPanel([job('job:a')], 10,
    { mode: 'quick', enableSearch: true, header: 'Tasks' },
    value => { opened = value }, () => {}, () => {})
  panel2.handleInput('\r')
  assert.equal(opened, 'job:a', 'Enter opens the selected row')
  panel2.dispose()
})

test('Quick Tasks ←→ still expand and collapse the tree', () => {
  const parent: TaskPanelItem = {
    value: 'agent:parent', label: 'parent', status: 'inactive', active: false,
    source: 'subagent', type: 'subagent', hasChildren: true, group: 'subagents',
  }
  const child: TaskPanelItem = {
    value: 'agent:child', label: 'child', status: 'completed', active: false,
    source: 'subagent', type: 'subagent', parentId: 'agent:parent', group: 'subagents',
  }
  const panel = new TaskBrowserPanel([parent, child], 10,
    { mode: 'quick', header: 'Tasks', initialScope: 'all' },
    () => {}, () => {}, () => {})
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'task:view-all'],
    'a settled branch starts collapsed')
  panel.handleInput('\x1b[C')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'agent:child', 'task:view-all'],
    '→ expands the branch')
  assert.equal(panel.getViewState().expandedIds.has('agent:parent'), true)
  panel.handleInput('\x1b[D')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'task:view-all'],
    '← collapses the branch')
  panel.dispose()
})

test('Full Task Center: N / Shift+N / T have no effect (removed actions)', () => {
  let viewFull = 0
  const panel = new TaskBrowserPanel(
    [{ ...job('job:done', 'completed') }, job('job:r1'), job('job:r2')], 10,
    { mode: 'full', enableSearch: true, header: 'Tasks', onViewFull: () => { viewFull += 1 } },
    () => {}, () => {}, () => {})
  assert.equal(panel.getViewState().selectedId, 'job:done')
  panel.handleInput('n')
  assert.equal(panel.getViewState().selectedId, 'job:done', 'N must not jump to running rows')
  panel.handleInput('N')
  assert.equal(panel.getViewState().selectedId, 'job:done', 'Shift+N must not jump between running rows')
  panel.handleInput('t')
  assert.equal(panel.getViewState().mode, 'full', 'T must not change the view mode')
  assert.equal(panel.getFilter(), '', 'T must not become search text in normal mode')
  assert.equal(viewFull, 0)
  panel.dispose()
})

test('Full Task Center: Tab and Shift+Tab cycle the type filter in both directions', () => {
  const panel = new TaskBrowserPanel([job('job:a'), agentRow('agent:c')], 10,
    { mode: 'full', enableSearch: true, header: 'Tasks' }, () => {}, () => {}, () => {})
  assert.equal(panel.getViewState().typeFilter, null)
  panel.handleInput('\t')
  assert.equal(panel.getViewState().typeFilter, 'bash')
  panel.handleInput('\t')
  assert.equal(panel.getViewState().typeFilter, 'subagent')
  panel.handleInput('\t')
  assert.equal(panel.getViewState().typeFilter, null, 'forward past the last type returns to All')
  // Reverse from All enters at the LAST type and wraps back to All.
  panel.handleInput('\x1b[Z')
  assert.equal(panel.getViewState().typeFilter, 'subagent')
  panel.handleInput('\x1b[Z')
  assert.equal(panel.getViewState().typeFilter, 'bash')
  panel.handleInput('\x1b[Z')
  assert.equal(panel.getViewState().typeFilter, null, 'reverse past the first type returns to All')
  panel.dispose()
})

test('Full search mode: Shift+Tab cycles the type filter backward without becoming query text', () => {
  const panel = new TaskBrowserPanel([job('build-1'), agentRow('agent:c')], 10,
    { mode: 'full', enableSearch: true, header: 'Tasks' }, () => {}, () => {}, () => {})
  panel.handleInput('/')
  panel.handleInput('b')
  panel.handleInput('u')
  assert.equal(panel.getFilter(), 'bu')
  panel.handleInput('\x1b[Z')
  assert.equal(panel.getViewState().typeFilter, 'subagent', 'Shift+Tab uses the reverse type action')
  assert.equal(panel.getFilter(), 'bu', 'the query must be preserved')
  assert.equal(panel.getViewState().searchMode, true, 'Shift+Tab must not leave search mode')
  panel.dispose()
})

test('Quick Tasks hint advertises only the navigation whitelist', () => {
  const panel = new TaskBrowserPanel([job('job:a')], 10,
    { mode: 'quick', enableSearch: true, header: 'Tasks' }, () => {}, () => {}, () => {})
  const view = panel.render(100).join('\n')
  assert.ok(view.includes('↑↓ select · ←→ tree · Tab type · Enter open · Esc close'),
    `Quick hint must advertise the whitelist:\n${view}`)
  for (const stale of ['/ search', 'A scope', 'A active/all', 'N next running', 'S stop', 'R refresh', 'T Task Center', 'pgup/pgdn']) {
    assert.ok(!view.includes(stale), `Quick hint must not advertise '${stale}':\n${view}`)
  }
  panel.dispose()
})

test('Full Task Center hint advertises the management verbs without N/T/R', () => {
  const panel = new TaskBrowserPanel([job('job:a')], 10,
    { mode: 'full', enableSearch: true, header: 'Tasks' }, () => {}, () => {}, () => {})
  const view = panel.render(100).join('\n')
  for (const verb of ['/ search', 'A scope', 'Tab type', 'S stop', 'Esc close']) {
    assert.ok(view.includes(verb), `Full hint must advertise '${verb}':\n${view}`)
  }
  for (const stale of ['N next running', 'T Task Center', 'R refresh']) {
    assert.ok(!view.includes(stale), `Full hint must not advertise '${stale}':\n${view}`)
  }
  panel.dispose()
})

test('Quick Tasks ignores a search query restored from the full view (no hidden-query dead end)', () => {
  // index.ts reopens Quick with the full view's CURRENT state after
  // Full → Esc → Esc; that state may carry the search query typed in Full
  // (searchMode already false after the first Esc). Quick owns no search,
  // so the query must be dropped — otherwise the projection filters every
  // row and the pseudo-row (appended only for an empty query) disappears,
  // removing the only keyboard path back to Full.
  let state: ReturnType<TaskBrowserPanel['getViewState']> | undefined
  const panel = new TaskBrowserPanel([job('job:a'), job('job:b')], 10, {
    mode: 'quick', enableSearch: true, header: 'Tasks',
    initialQuery: 'no-match', initialSearchMode: false,
    onViewFull: next => { state = next },
  }, () => {}, () => {}, () => {})
  assert.equal(panel.getFilter(), '', 'Quick must not retain a restored query')
  assert.equal(panel.getViewState().searchMode, false)
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['job:a', 'job:b', 'task:view-all'],
    'every row and the pseudo-row must stay visible')
  const view = panel.render(80).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(view.includes('Open Task Center'), `the pseudo-row must render:\n${view}`)
  assert.ok(!view.includes('no-match'), `the stale query must not filter the view:\n${view}`)
  // The pseudo-row + Enter path back to Full still works.
  panel.handleInput('\x1b[B')
  panel.handleInput('\x1b[B')
  panel.handleInput('\r')
  assert.equal(state?.selectedId, 'task:view-all')
  panel.dispose()
})

test('Quick Tasks stale banner does not advertise the Full-only R retry', () => {
  const items = [job('job:a')]
  const quick = new TaskBrowserPanel(items, 10, {
    mode: 'quick', enableSearch: true, header: 'Tasks', refreshError: 'catalog failed',
  }, () => {}, () => {}, () => {})
  const quickView = quick.render(80).join('\n')
  assert.ok(quickView.includes('catalog failed'), `Quick must still show the error:\n${quickView}`)
  assert.ok(!quickView.includes('R retry'), `Quick R is a no-op; the banner must not advertise it:\n${quickView}`)
  quick.dispose()

  const full = new TaskBrowserPanel(items, 10, {
    mode: 'full', enableSearch: true, header: 'Tasks', refreshError: 'catalog failed',
  }, () => {}, () => {}, () => {})
  const fullView = full.render(80).join('\n')
  assert.ok(fullView.includes('catalog failed · R retry'), `Full must keep the retry verb:\n${fullView}`)
  full.dispose()
})

test('legacy mode-less panels keep Shift+Tab inert (no reverse type action)', () => {
  // Mode-less direct callers keep their historical behavior: the new
  // Shift+Tab reverse type action belongs to the explicit Full surface only,
  // so a legacy panel must not silently change its type filter on it.
  const panel = new TaskBrowserPanel([job('job:a'), agentRow('agent:c')], 10,
    { header: 'tasks' }, () => {}, () => {}, () => {})
  assert.equal(panel.getViewState().typeFilter, null)
  panel.handleInput('\x1b[Z')
  assert.equal(panel.getViewState().typeFilter, null, 'legacy Shift+Tab must stay inert')
  panel.dispose()
})
