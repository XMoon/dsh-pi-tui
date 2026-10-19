import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { TaskBrowserPanel } from '../src/tui/panels/task-panel.ts'
import type { TaskPanelItem } from '../src/app/surface/task-presentation.ts'

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
    mode: 'full', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  assert.equal(panel.visibleItems().length, 20,
    'the projection holds every failure')
  assert.equal(panel.viewportItems().length, 8, 'the viewport renders only maxVisible rows')
  assert.deepEqual(panel.viewportItems().map(item => item.value),
    Array.from({ length: 8 }, (_, i) => `job:f${i}`),
    'the viewport is the scroll window from the top')
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
  // D8 keeps the real Escape outcome last and highest-priority; low-priority
  // query help drops before it when the one-line hint is constrained.
  const searchHint = 'Enter open · ↑↓ select · ←→ edit · Shift+Tab type · type to filter · Esc back'
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
  // Reverse type cycling uses the component keymap's canonical label.
  assert.ok(hintRow.includes('Shift+Tab'), `reverse type cycling must be discoverable:\n${view}`)
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
  assert.ok(afterEsc.includes('a scope'), `normal task actions return after Esc:\n${afterEsc}`)
  panel.dispose()
})

// ── Quick / Full keyboard contract (0.1.6 UX fix) ──────────────────────────

const agentRow = (value: string): TaskPanelItem => ({
  value, label: value, status: 'running', active: true,
  source: 'subagent', type: 'subagent', group: 'subagents',
})

test('Quick Tasks whitelist still navigates, filters types and opens rows', () => {
  let cancelled = 0
  const panel = new TaskBrowserPanel(
    [job('job:a'), job('job:b'), agentRow('agent:c')], 10,
    { mode: 'full', enableSearch: true, header: 'Tasks' },
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
    { mode: 'full', enableSearch: true, header: 'Tasks' },
    value => { opened = value }, () => {}, () => {})
  panel2.handleInput('\r')
  assert.equal(opened, 'job:a', 'Enter opens the selected row')
  panel2.dispose()
})

test('Full Task Center: N / Shift+N / T have no effect (removed actions)', () => {
  let viewFull = 0
  const panel = new TaskBrowserPanel(
    [{ ...job('job:done', 'completed') }, job('job:r1'), job('job:r2')], 10,
    { mode: 'full', enableSearch: true, header: 'Tasks' },
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

test('Full Task Center hint advertises the management verbs without N/T/R', () => {
  const panel = new TaskBrowserPanel([job('job:a')], 10,
    { mode: 'full', enableSearch: true, header: 'Tasks' }, () => {}, () => {}, () => {})
  const view = panel.render(100).join('\n')
  for (const verb of ['/ search', 'a scope', 'Shift+Tab type', 's stop', 'Esc close']) {
    assert.ok(view.includes(verb), `Full hint must advertise '${verb}':\n${view}`)
  }
  for (const stale of ['N next running', 'T Task Center', 'R refresh']) {
    assert.ok(!view.includes(stale), `Full hint must not advertise '${stale}':\n${view}`)
  }
  panel.dispose()
})

// ── Host-text terminal display safety (independent fix PR) ─────────────────
//
// A Task Center row is a projection of arbitrary Host/external text (a Job or
// Subagent label, a parent label, a Job detail, an Error.message). The panel
// is the LAST boundary before the terminal, so every dynamic text must be
// projected to one SAFE physical row there — before the theme's color.* is
// applied, so legitimate SGR survives.

/** The task's verified hostile fixture: an OSC 52 clipboard write (with a
 *  base64 payload), readable text, and a CSI erase. */
const HOSTILE = '\x1b]52;c;UFdORUQ=\x07echo ok\x1b[2J'

const hostileFree = (text: string): boolean =>
  !text.includes(']52;c;') && !text.includes('UFdORUQ=') && !text.includes('\x1b[2J')

test('S-01 a hostile Job label is projected to one safe row in the list, the detail and the Stop confirmation', () => {
  const item: TaskPanelItem = { ...job('job:hostile'), label: `bash · ${HOSTILE}` }
  let stopped: string | undefined
  const panel = new TaskBrowserPanel([item], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks',
    onStop: value => { stopped = value },
  }, () => {}, () => {}, () => {})

  for (const width of [60, 80, 100, 120, 160]) {
    const lines = panel.render(width)
    const plain = lines.join('\n')
    assert.ok(hostileFree(plain), `width ${width}: no Host OSC/CSI/payload may reach the frame:\n${plain}`)
    assert.ok(plain.includes('echo ok'), `width ${width}: the readable label content stays visible:\n${plain}`)
    // One returned element is one physical terminal row: a CR/LF here would
    // wrap past the row budget and the mouse hit map.
    assert.ok(lines.every(line => !line.includes('\n') && !line.includes('\r')),
      `width ${width}: every rendered element is exactly one physical row`)
    // A long hostile label is still truncated to the row budget on a narrow
    // terminal (the sanitize step must not defeat the width contract).
    const labelRow = lines.find(line => line.includes('echo ok'))
    assert.ok(labelRow !== undefined, `width ${width}: the label row must render`)
    assert.ok(visibleWidth(labelRow) <= width,
      `width ${width}: the label row overflows its budget: ${JSON.stringify(labelRow)}`)
  }

  // The S → Y confirmation embeds the label on the detail pane: it must show
  // the readable text and still Stop the RAW row identity.
  panel.handleInput('S')
  const confirm = panel.render(120).join('\n')
  assert.match(confirm, /Stop bash · echo ok\?/, `the confirmation must carry the sanitized label:\n${confirm}`)
  assert.ok(hostileFree(confirm), 'the confirmation carries no Host sequence')
  panel.handleInput('y')
  assert.equal(stopped, 'job:hostile', 'Stop still targets the raw row identity, never the display text')
  assert.ok(item.label.includes('\x1b]52;c;'), 'the runtime row label is never rewritten')
  panel.dispose()
})

test('S-01b a long hostile-bearing label is really truncated to a narrow grant, still safely', () => {
  // 50 readable cells + a sentinel + the hostile sequence: at 60 columns the
  // row must actually DROP the tail (proving truncation really ran), while
  // never emitting the Host bytes; at 160 columns the same label is long
  // enough to fit, so the narrow case is not a short-label no-op.
  const item: TaskPanelItem = { ...job('job:long'), label: `bash · ${'x'.repeat(50)}SENTINEL${HOSTILE}` }
  const panel = new TaskBrowserPanel([item], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks', marqueeNow: () => 0,
  }, () => {}, () => {}, () => {})

  const narrow = panel.render(60)
  const narrowRow = narrow.find(line => line.includes('xxxx'))
  assert.ok(narrowRow !== undefined, `the long row must paint:\n${narrow.join('\n')}`)
  assert.ok(visibleWidth(narrowRow) <= 60, 'the long label row stays inside the 60-column grant')
  assert.ok(!narrow.join('\n').includes('SENTINEL'),
    `the tail beyond the narrow grant must be really dropped:\n${narrow.join('\n')}`)
  assert.ok(hostileFree(narrow.join('\n')), 'no Host sequence leaks even from a truncated label')
  assert.ok(narrow.every(line => !line.includes('\n') && !line.includes('\r')),
    'a truncated label still owns exactly one physical row')

  const wide = panel.render(160)
  assert.ok(wide.join('\n').includes('SENTINEL'),
    `the same label must be long enough to fit a wide grant:\n${wide.join('\n')}`)
  assert.ok(wide.join('\n').includes('echo ok'), 'the wide grant shows the readable hostile-fixture text')
  assert.ok(hostileFree(wide.join('\n')), 'the wide grant is safe too')
  panel.dispose()
})

test('S-04 the projection preserves ordinary text, one-row geometry and theme ANSI', () => {
  const item: TaskPanelItem = { ...job('job:plain'), label: 'bash · 构建 🚀 done' }
  const panel = new TaskBrowserPanel([item], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  const lines = panel.render(100)
  const plain = lines.join('\n')
  assert.ok(plain.includes('构建 🚀 done'), `ordinary CJK/emoji must survive verbatim:\n${plain}`)
  assert.ok(lines.every(line => !line.includes('\n') && !line.includes('\r')), 'no element carries a row break')
  // The theme's own ANSI is applied AFTER the Host-text projection, so a
  // legal SGR color must never be stripped with the Host's sequences.
  assert.ok(lines.some(line => /\x1b\[/.test(line)), 'theme SGR codes must survive')
  panel.dispose()

  // A CR/LF (or tab) inside a dynamic label never adds a physical row.
  const multiline: TaskPanelItem = { ...job('job:ml'), label: 'alpha\r\nbeta\ngamma' }
  const two = new TaskBrowserPanel([multiline], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks',
  }, () => {}, () => {}, () => {})
  const rendered = two.render(100)
  assert.ok(rendered.every(line => !line.includes('\n') && !line.includes('\r')),
    'CR/LF must not leak a physical row break')
  assert.ok(rendered.join('\n').includes('alpha beta gamma'),
    `the whole label stays visible on one row:\n${rendered.join('\n')}`)
  assert.ok(multiline.label.includes('\r\n'), 'the raw item label keeps its CR/LF')
  two.dispose()
})

test('S-04 the Task Center chrome (header, refresh banner, no-match text) is projected too', () => {
  const listed = new TaskBrowserPanel([{ ...job('job:a'), label: 'bash · build' }], 10, {
    mode: 'full', enableSearch: true, header: `Tasks · ${HOSTILE}`,
    refreshError: `catalog failed · ${HOSTILE}`,
  }, () => {}, () => {}, () => {})
  const listedView = listed.render(120).join('\n')
  assert.ok(hostileFree(listedView), `chrome must not carry a Host sequence:\n${listedView}`)
  assert.ok(listedView.includes('Tasks · echo ok'), 'the header keeps its readable content')
  assert.ok(listedView.includes('catalog failed · echo ok'), 'the refresh banner keeps its readable content')
  listed.dispose()

  // Empty list: the caller's no-match text is the dynamic row.
  const empty = new TaskBrowserPanel([], 10, {
    mode: 'full', enableSearch: true, header: 'Tasks', noMatchText: `nothing · ${HOSTILE}`,
  }, () => {}, () => {}, () => {})
  const emptyView = empty.render(120).join('\n')
  assert.ok(hostileFree(emptyView), `the no-match row must not carry a Host sequence:\n${emptyView}`)
  assert.ok(emptyView.includes('nothing · echo ok'), 'the no-match text keeps its readable content')
  empty.dispose()
})
