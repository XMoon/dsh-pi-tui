/**
 * Unit tests for the TaskBrowserPanel presentation layer: status dots,
 * aligned columns, group headers, live elapsed ticking, selection movement,
 * search filtering, and the empty state. The row MODEL is tested separately
 * in tasks-browser.test.ts; this file only covers the panel's rendering and
 * input.
 * @module @xmoon76/dsh-pi-tui/task-panel.test
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { TaskBrowserPanel, formatElapsed, type TaskPanelItem } from '../src/task-panel.ts'

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')

const runningJob = (overrides: Partial<TaskPanelItem> = {}): TaskPanelItem => ({
  value: 'job:bash-1',
  label: 'bash · pnpm build',
  status: 'running',
  detail: 'compile step',
  startedAt: Date.now() - 5_000,
  group: 'jobs',
  ...overrides,
})

const doneJob = (overrides: Partial<TaskPanelItem> = {}): TaskPanelItem => ({
  value: 'job:bash-2',
  label: 'bash · lint',
  status: 'completed',
  startedAt: Date.now() - 120_000,
  group: 'jobs',
  ...overrides,
})

const subagent = (overrides: Partial<TaskPanelItem> = {}): TaskPanelItem => ({
  value: 'agent:child-1',
  label: 'subagent · research',
  status: 'running',
  detail: 'has children',
  group: 'subagents',
  interruptible: true,
  ...overrides,
})

function makePanel(
  items: TaskPanelItem[],
  options: { maxVisible?: number; enableSearch?: boolean; header?: string } = {},
): { panel: TaskBrowserPanel; rendered: () => string[] } {
  const panel = new TaskBrowserPanel(
    items,
    options.maxVisible ?? 10,
    { header: options.header ?? 'tasks · subagents', enableSearch: options.enableSearch, noMatchText: 'no active tasks' },
    () => {},
    () => {},
    () => {},
  )
  // Rendered fresh on every access: input handlers mutate state and the
  // real overlay drives the re-render, so the test must read the CURRENT
  // frame, not a snapshot.
  return { panel, rendered: () => panel.render(100) }
}

test('rows render a status dot, kind · label, and right-aligned status + elapsed', () => {
  const now = Date.now()
  const { panel, rendered } = makePanel([
    runningJob({ startedAt: now - 2_000 }),
    doneJob(),
  ])
  const lines = rendered().map(strip)
  const joined = lines.join('\n')
  assert.ok(joined.includes('●'), `status dot missing:\n${joined}`)
  assert.ok(joined.includes('bash · pnpm build'), `label missing:\n${joined}`)
  assert.ok(joined.includes('running'), `status word missing:\n${joined}`)
  assert.ok(joined.includes('2s'), `elapsed missing:\n${joined}`)
  assert.ok(joined.includes('completed'), `completed status missing:\n${joined}`)
  assert.ok(joined.includes('2m'), `completed elapsed missing:\n${joined}`)
  // The right column is right-aligned: the tail ends at the line's end
  // (after trimming, the status/elapsed sit at the far right).
  const row = lines.find(line => line.includes('pnpm build'))!
  assert.ok(row.trimEnd().endsWith('running 2s'), `tail must be right-aligned:\n${row}`)
  void panel
})

test('group headers render as dim dividers between groups', () => {
  const { rendered } = makePanel([
    subagent(),
    runningJob(),
  ])
  const lines = rendered().map(strip)
  const joined = lines.join('\n')
  assert.ok(joined.includes('── subagents ──'), `subagents header missing:\n${joined}`)
  assert.ok(joined.includes('── jobs ──'), `jobs header missing:\n${joined}`)
  const subagentsIdx = lines.findIndex(line => line.includes('── subagents ──'))
  const jobsIdx = lines.findIndex(line => line.includes('── jobs ──'))
  assert.ok(subagentsIdx < jobsIdx, `groups must order subagents before jobs:\n${joined}`)
})

test('the header carries live running/done/failed counts', () => {
  const { rendered } = makePanel([
    runningJob(),
    doneJob(),
    { value: 'job:bash-3', label: 'bash · deploy', status: 'failed', startedAt: Date.now(), group: 'jobs' },
  ])
  const joined = rendered().map(strip).join('\n')
  assert.ok(joined.includes('1 running'), `running count missing:\n${joined}`)
  assert.ok(joined.includes('1 done'), `done count missing:\n${joined}`)
  assert.ok(joined.includes('1 failed'), `failed count missing:\n${joined}`)
})

test('selected row shows the pointer and bold label', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()])
  const first = rendered().map(strip).join('\n')
  assert.ok(first.includes('→ ● bash · pnpm build'), `selected row must show the pointer:\n${first}`)
  panel.handleInput('\x1b[B')
  const second = rendered().map(strip).join('\n')
  assert.ok(second.includes('→ ● bash · lint'), `selection must move down:\n${second}`)
  assert.ok(!second.includes('→ ● bash · pnpm build'), `old row must lose the pointer:\n${second}`)
})

test('↑↓ clamp at the ends (no wrap-around)', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()])
  panel.handleInput('\x1b[A') // at the top: stays
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · pnpm build'), `↑ at top must not move:\n${rendered().map(strip).join('\n')}`)
  panel.handleInput('\x1b[B')
  panel.handleInput('\x1b[B') // at the bottom: stays
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · lint'), `↓ at bottom must not wrap:\n${rendered().map(strip).join('\n')}`)
})

test('Enter fires onSelect with the selected value; Esc fires onCancel', () => {
  let selected: string | undefined
  let cancelled = 0
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob()],
    10,
    { header: 'tasks' },
    (value) => { selected = value },
    () => { cancelled += 1 },
    () => {},
  )
  panel.render(100)
  panel.handleInput('\x1b[B')
  panel.handleInput('\r')
  assert.equal(selected, 'job:bash-2')
  panel.handleInput('\x1b')
  assert.equal(cancelled, 1)
})

test('search filters by label/status and restores selection on setItems', () => {
  const { panel, rendered } = makePanel(
    [runningJob(), doneJob(), subagent()],
    { enableSearch: true },
  )
  // Typing a printable goes to the search input.
  panel.handleInput('l')
  panel.handleInput('i')
  panel.handleInput('n')
  panel.handleInput('t')
  const filtered = rendered().map(strip).join('\n')
  assert.ok(filtered.includes('bash · lint'), `search must filter to lint:\n${filtered}`)
  assert.ok(!filtered.includes('pnpm build'), `non-matching row must be filtered:\n${filtered}`)
  // setItems keeps the active query applied.
  panel.setItems([runningJob(), doneJob(), subagent()])
  const reapplied = rendered().map(strip).join('\n')
  assert.ok(reapplied.includes('bash · lint'), `query must re-apply on setItems:\n${reapplied}`)
})

test('search matches the GROUP name too (the merged /tasks surface)', () => {
  const { panel, rendered } = makePanel(
    [runningJob(), doneJob(), subagent()],
    { enableSearch: true },
  )
  panel.handleInput('s')
  panel.handleInput('u')
  panel.handleInput('b')
  const filtered = rendered().map(strip).join('\n')
  assert.ok(filtered.includes('subagent · research'), `group query must keep the subagent row:\n${filtered}`)
  assert.ok(!filtered.includes('pnpm build'), `job rows must be filtered by the group query:\n${filtered}`)
})

// ── the async-merge focus race (plan item 2) ──────────────────────────────

const typed = (item: TaskPanelItem, type: string): TaskPanelItem => ({ ...item, type })

test('an UNTOUCHED selection follows the enriched list head (the /tasks race)', () => {
  // The browser opens on the jobs half only…
  const { panel, rendered } = makePanel([runningJob(), doneJob()], { enableSearch: true })
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · pnpm build'),
    `precondition — first job selected before enrichment`)
  // …then the subagent catalog lands: the running subagent heads the
  // enriched list, and an untouched selection must MOVE onto it (the old
  // value-preserving setItems left the cursor stuck on the first job).
  panel.setItems([
    typed(subagent(), 'subagent'),
    runningJob({ type: 'bash' }),
    doneJob({ type: 'bash' }),
  ])
  const enriched = rendered().map(strip).join('\n')
  assert.ok(enriched.includes('→ ● subagent · research'),
    `untouched selection must follow the preferred head (first running subagent):\n${enriched}`)
})

test('an UNTOUCHED selection honors an EXPLICIT preferredValue without moving the row (plan §6.6)', () => {
  // The tree order is immutable — the cursor follows the caller's
  // preferred row (first running subagent, else first active job), never
  // a re-sort. Here the preferred value is the SECOND row: a running
  // grandchild BELOW its inactive parent.
  const { panel, rendered } = makePanel([
    { value: 'agent:parent', label: 'subagent · planner', status: 'inactive', group: 'subagents', treePrefix: '├─ ' },
    { value: 'agent:grand', label: 'subagent · deep', status: 'running', group: 'subagents', treePrefix: '  ├─ ' },
  ])
  panel.setItems([
    { value: 'agent:parent', label: 'subagent · planner', status: 'inactive', group: 'subagents', treePrefix: '├─ ' },
    { value: 'agent:grand', label: 'subagent · deep', status: 'running', group: 'subagents', treePrefix: '  ├─ ' },
  ], 'agent:grand')
  const view = rendered().map(strip).join('\n')
  assert.ok(view.includes('→ ●   ├─ subagent · deep'), `preferred row must be selected:\n${view}`)
  // The row ORDER must not have changed (the cursor moved, the tree did
  // not) — the tree renderer never re-sorts for the cursor.
  const parentIndex = view.indexOf('subagent · planner')
  const grandIndex = view.indexOf('subagent · deep')
  assert.ok(parentIndex >= 0 && grandIndex > parentIndex, `tree order must survive:\n${view}`)
})

test('treePrefix renders as a fixed connector region before the label', () => {
  const { panel, rendered } = makePanel([
    { value: 'agent:child-1', label: 'subagent · research', status: 'running', group: 'subagents', treePrefix: '├─ ' },
    { value: 'agent:child-2', label: 'subagent · nested', status: 'inactive', group: 'subagents', treePrefix: '  ├─ ' },
  ])
  const view = rendered().map(strip).join('\n')
  assert.ok(view.includes('├─ subagent · research'), `depth-1 connector missing:\n${view}`)
  assert.ok(view.includes('  ├─ subagent · nested'), `depth-2 connector missing:\n${view}`)
})

test('a USER-touched selection survives a later enrichment (no focus stealing)', () => {
  const { panel, rendered } = makePanel(
    [typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true },
  )
  // The user moves down to the second row…
  panel.handleInput('\x1b[B')
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · lint'), `precondition — user on the lint row:\n${rendered().map(strip).join('\n')}`)
  // …then a refresh inserts a running subagent at the head.
  panel.setItems([
    typed(subagent(), 'subagent'),
    typed(runningJob(), 'bash'),
    typed(doneJob(), 'bash'),
  ])
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('→ ● bash · lint'),
    `a touched selection must stay on the user's row, not jump to the new head:\n${after}`)
  assert.ok(!after.includes('→ ● subagent · research'), `the head must not steal the focus:\n${after}`)
})

test('a user-touched selection whose row vanished resets to the head (not a stale value)', () => {
  const { panel, rendered } = makePanel(
    [typed(runningJob(), 'bash'), typed(subagent(), 'subagent')],
    { enableSearch: true },
  )
  panel.handleInput('\x1b[B') // user moves onto the subagent row
  // The subagent settles and disappears; the refresh must not resurrect it.
  panel.setItems([typed(runningJob(), 'bash')])
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('→ ● bash · pnpm build'), `a vanished row must fall back to the head:\n${after}`)
})

// ── the Tab type filter (initial item 2) ──────────────────────────────────

test('Tab cycles All → subagent → bash → All and filters rows by type', () => {
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true, header: 'tasks · subagents' },
  )
  const all = rendered().map(strip).join('\n')
  assert.ok(all.includes('subagent · research') && all.includes('pnpm build'), `precondition — All shows everything:\n${all}`)

  panel.handleInput('\t')
  const agents = rendered().map(strip).join('\n')
  assert.ok(agents.includes('subagent · research'), `subagent filter keeps the agent row:\n${agents}`)
  assert.ok(!agents.includes('pnpm build'), `subagent filter drops job rows:\n${agents}`)
  assert.ok(agents.includes('[subagent]'), `the header must show the active type chip:\n${agents}`)

  panel.handleInput('\t')
  const bash = rendered().map(strip).join('\n')
  assert.ok(bash.includes('pnpm build'), `bash filter keeps job rows:\n${bash}`)
  assert.ok(!bash.includes('subagent · research'), `bash filter drops the agent row:\n${bash}`)
  assert.ok(bash.includes('[bash]'), `the chip follows the cycle:\n${bash}`)

  panel.handleInput('\t') // bash → All (the cycle wraps)
  const allAgain = rendered().map(strip).join('\n')
  assert.ok(allAgain.includes('subagent · research') && allAgain.includes('pnpm build'), `cycle wraps to All:\n${allAgain}`)
  assert.ok(!allAgain.includes('[bash]'), `All shows no chip:\n${allAgain}`)
})

test('type filter composes with the search query', () => {
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true },
  )
  panel.handleInput('\t') // subagent
  panel.handleInput('r') // query 'r'
  const both = rendered().map(strip).join('\n')
  assert.ok(both.includes('subagent · research'), `type+query keeps the matching agent row:\n${both}`)
  assert.ok(!both.includes('pnpm build'), `type+query keeps job rows out:\n${both}`)
})

test('rows without a type never match a type filter (they only appear under All)', () => {
  const { panel, rendered } = makePanel(
    [runningJob(), typed(doneJob(), 'bash')],
    { enableSearch: true },
  )
  panel.handleInput('\t') // bash
  const filtered = rendered().map(strip).join('\n')
  assert.ok(filtered.includes('bash · lint'), `typed row stays:\n${filtered}`)
  assert.ok(!filtered.includes('bash · pnpm build'), `typeless row hides under a type filter:\n${filtered}`)
})

test('the type hint advertises Tab only when the cycle has two or more entries', () => {
  const single = makePanel([typed(runningJob(), 'bash')], { enableSearch: true })
  assert.ok(!single.rendered().map(strip).join('\n').includes('tab type'),
    `a single-kind list must not advertise the toggle:\n${single.rendered().map(strip).join('\n')}`)
  const multi = makePanel([typed(runningJob(), 'bash'), typed(subagent(), 'subagent')], { enableSearch: true })
  assert.ok(multi.rendered().map(strip).join('\n').includes('tab type'),
    `mixed list advertises the Tab cycle:\n${multi.rendered().map(strip).join('\n')}`)
})

test('a vanished active type snaps the filter back to All on setItems', () => {
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash')],
    { enableSearch: true },
  )
  panel.handleInput('\t') // subagent
  assert.ok(rendered().map(strip).join('\n').includes('[subagent]'), `precondition — subagent filter active:\n${rendered().map(strip).join('\n')}`)
  // The subagent settles and disappears from the refresh.
  panel.setItems([typed(runningJob(), 'bash')])
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('pnpm build'), `snapped to All shows the remaining row:\n${after}`)
  assert.ok(!after.includes('[subagent]'), `the vanished type must not stay active:\n${after}`)
})

test('a Tab type filter counts as a user interaction (no head-stealing on refresh)', () => {
  // Round-1 review finding: Tab cycles the type filter, so a later async
  // setItems enrichment must preserve the selection within the user's
  // chosen scope — never re-focus the unfiltered head.
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true },
  )
  // The user picks the bash scope and moves onto the lint row.
  panel.handleInput('\t') // subagent
  panel.handleInput('\t') // bash (marks the selection touched)
  panel.handleInput('\x1b[B') // onto the lint row
  const before = rendered().map(strip).join('\n')
  assert.ok(before.includes('→ ● bash · lint'), `precondition — a row selected within the type scope:\n${before}`)
  // An enrichment arrives with a NEW bash job at the head of the filtered
  // scope; the touched selection must not jump.
  panel.setItems([
    typed(runningJob({ value: 'job:bash-new', label: 'bash · fresh' }), 'bash'),
    typed(runningJob(), 'bash'),
    typed(doneJob(), 'bash'),
    typed(subagent(), 'subagent'),
  ])
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('→ ● bash · lint'),
    `the touched selection must survive the refresh inside the typed scope:\n${after}`)
})

test('i on a selected subagent row fires the interrupt action while search is closed', () => {
  let acted: { value: string; action: string } | undefined
  const panel = new TaskBrowserPanel(
    [runningJob(), subagent()],
    10,
    {
      header: 'tasks · subagents',
      onAction: (value, action) => { acted = { value, action } },
    },
    () => {},
    () => {},
    () => {},
  )
  panel.render(100)
  // The subagent row is second; move the cursor onto it, then press i.
  panel.handleInput('\x1b[B')
  panel.handleInput('i')
  assert.deepEqual(acted, { value: 'agent:child-1', action: 'interrupt' }, 'i must interrupt the selected subagent')
  // A NON-interruptible row under the cursor (a job, or a one-shot
  // subagent): i does NOT fire — the panel only reports rows the
  // interrupt transport can actually stop.
  acted = undefined
  panel.handleInput('\x1b[A')
  panel.handleInput('i')
  assert.equal(acted, undefined, 'i on a non-interruptible row must not fire the interrupt action')
})

test('a one-shot subagent row never fires the interrupt action (accepted no-op would lie)', () => {
  let acted = 0
  const panel = new TaskBrowserPanel(
    [subagent({ value: 'agent:one-shot-1', label: 'subagent · audit', interruptible: false })],
    10,
    {
      header: 'tasks · subagents',
      onAction: () => { acted += 1 },
    },
    () => {},
    () => {},
    () => {},
  )
  panel.render(100)
  panel.handleInput('i')
  assert.equal(acted, 0, 'one-shot rows are not interruptible')
  // And the hint must not advertise it.
  const joined = panel.render(100).map(strip).join('\n')
  assert.ok(!joined.includes('i interrupt'), `one-shot-only list must not advertise i interrupt:\n${joined}`)
})

test('i is a query character once a search query is active, never an action', () => {
  let acted = 0
  const panel = new TaskBrowserPanel(
    [subagent()],
    10,
    {
      header: 'tasks · subagents',
      enableSearch: true,
      onAction: () => { acted += 1 },
    },
    () => {},
    () => {},
    () => {},
  )
  panel.render(100)
  // With a query in flight, `i` is an ordinary query letter ("task",
  // "git") even on a subagent row.
  panel.handleInput('t')
  panel.handleInput('i')
  assert.equal(acted, 0, 'i must go to the search input while a query is active')
})

test('i interrupts a subagent row from the empty search state (the /tasks production path)', () => {
  let acted: { value: string; action: string } | undefined
  const panel = new TaskBrowserPanel(
    [runningJob(), subagent()],
    10,
    {
      header: 'tasks · subagents',
      enableSearch: true,
      onAction: (value, action) => { acted = { value, action } },
    },
    () => {},
    () => {},
    () => {},
  )
  panel.render(100)
  // The browser opens with an EMPTY query: move onto the subagent row and
  // press i — the interrupt must fire even though search is enabled (the
  // real /tasks surface configures enableSearch: true).
  panel.handleInput('\x1b[B')
  panel.handleInput('i')
  assert.deepEqual(acted, { value: 'agent:child-1', action: 'interrupt' }, 'empty-query i must interrupt the selected subagent')
  // A job row under the cursor with an empty query: i starts a search
  // instead of firing (no subagent selected — no interrupt intent).
  acted = undefined
  panel.handleInput('\x1b[A')
  panel.handleInput('i')
  assert.equal(acted, undefined, 'i on a job row with an empty query must go to the search input')
  // Once the query is non-empty, i is a letter everywhere.
  panel.handleInput('\x1b[B')
  panel.handleInput('b') // query "ib"
  panel.handleInput('i')
  assert.equal(acted, undefined, 'i with a non-empty query must stay a query letter')
})

test('search input is editable: backspace removes characters and re-filters', () => {
  const { panel, rendered } = makePanel(
    [runningJob(), doneJob(), subagent()],
    { enableSearch: true },
  )
  panel.handleInput('l')
  panel.handleInput('i')
  panel.handleInput('n')
  panel.handleInput('t')
  assert.ok(rendered().map(strip).join('\n').includes('bash · lint'), `precondition — lint filtered:\n${rendered().map(strip).join('\n')}`)
  // Backspace (real typing leaves the cursor at the end, so \x7f deletes
  // the last char): the query becomes 'lin' — the filter re-applies.
  panel.handleInput('\x7f')
  assert.equal(panel.getFilter(), 'lin', `backspace must edit the query`)
  assert.ok(rendered().map(strip).join('\n').includes('bash · lint'), `'lin' still matches the lint row:\n${rendered().map(strip).join('\n')}`)
  // Delete the rest: the empty query restores every row.
  panel.handleInput('\x7f')
  panel.handleInput('\x7f')
  panel.handleInput('\x7f')
  assert.equal(panel.getFilter(), '', `cleared query must be empty`)
  const cleared = rendered().map(strip).join('\n')
  assert.ok(cleared.includes('bash · pnpm build'), `cleared query must restore all rows:\n${cleared}`)
})

test('elapsed renders from the startedAt timestamp', () => {
  const start = Date.now() - 1_000
  const { rendered } = makePanel([runningJob({ startedAt: start })])
  const joined = rendered().map(strip).join('\n')
  assert.ok(joined.includes('1s'), `initial elapsed wrong:\n${joined}`)
})

test('formatElapsed humanizes durations', () => {
  assert.equal(formatElapsed(0), '0s')
  assert.equal(formatElapsed(2), '2s')
  assert.equal(formatElapsed(65), '1m5s')
  assert.equal(formatElapsed(3720), '1h2m')
  assert.equal(formatElapsed(undefined), '')
})

test('empty state renders the no-match text and hint', () => {
  const { rendered } = makePanel([], { enableSearch: true })
  const joined = rendered().map(strip).join('\n')
  assert.ok(joined.includes('no active tasks'), `empty text missing:\n${joined}`)
  assert.ok(joined.includes('↑↓ navigate'), `hint missing:\n${joined}`)
})

test('the type chip narrows the header counts to the visible scope', () => {
  // Round-1 review finding: with a type filter active, the counts must
  // describe the visible rows only — a running row outside the scope must
  // not inflate the numbers.
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash')],
    { enableSearch: true, header: 'tasks · subagents' },
  )
  const all = rendered().map(strip).join('\n')
  assert.ok(all.includes('2 running'), `precondition — full surface counts both rows:\n${all}`)
  panel.handleInput('\t') // subagent
  const agents = rendered().map(strip).join('\n')
  assert.ok(agents.includes('[subagent]'), `precondition — type chip:\n${agents}`)
  assert.ok(agents.includes('1 running'), `the subagent scope counts its own row only:\n${agents}`)
  assert.ok(!agents.includes('2 running'), `the hidden bash row must not inflate the count:\n${agents}`)
})

test('the hint advertises i interrupt only while a subagent row is selectable', () => {
  // A subagent row in the list: the interrupt verb shows (the merged /tasks
  // surface's only terminate entry — the old /subagents submenu is gone).
  const withAgent = makePanel([runningJob(), subagent()])
  assert.ok(withAgent.rendered().map(strip).join('\n').includes('i interrupt · ↑↓ navigate'),
    `interrupt hint missing with a subagent row:\n${withAgent.rendered().map(strip).join('\n')}`)
  // Jobs only: `i` would be a search letter, so the verb must stay hidden.
  const jobsOnly = makePanel([runningJob()])
  assert.ok(!jobsOnly.rendered().map(strip).join('\n').includes('i interrupt'),
    `interrupt hint must not advertise on job rows:\n${jobsOnly.rendered().map(strip).join('\n')}`)
  // Empty list: no interrupt either.
  const empty = makePanel([])
  assert.ok(!empty.rendered().map(strip).join('\n').includes('i interrupt'))
})

test('dispose stops the elapsed tick (no render callbacks after close)', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] })
  t.after(() => mock.timers.reset())
  let renders = 0
  const panel = new TaskBrowserPanel(
    [runningJob({ startedAt: Date.now() - 1_000 })],
    10,
    { header: 'tasks' },
    () => {},
    () => {},
    () => { renders += 1 },
  )
  panel.render(100)
  const before = renders
  assert.equal(before, 0, `no render before the first tick`)
  // One tick cycle fires the interval: the live row's elapsed moved, so a
  // render is requested.
  mock.timers.tick(1000)
  assert.equal(renders, 1, `tick must request a render for a live row`)
  // Dispose stops the tick: further time passing must NOT request renders.
  panel.dispose()
  mock.timers.tick(5000)
  assert.equal(renders, 1, `dispose must stop the elapsed tick`)
})

test('search-enabled: k and j are query characters, not list navigation', () => {
  const { panel, rendered } = makePanel(
    [runningJob(), doneJob(), subagent()],
    { enableSearch: true },
  )
  // 'j' and 'k' must land in the search input (queries like "task" or "jq").
  panel.handleInput('j')
  panel.handleInput('o')
  assert.equal(panel.getFilter(), 'jo', `k/j must be query characters when search is on`)
  panel.handleInput('\x7f')
  panel.handleInput('\x7f')
  panel.handleInput('k')
  panel.handleInput('i')
  panel.handleInput('n')
  assert.equal(panel.getFilter(), 'kin', `query must accept k after clearing`)
  void rendered
})

test('search-disabled: k/j keep their vim navigation aliases', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()], { enableSearch: false })
  // Without search, 'j' moves down and 'k' moves up.
  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · lint'), `j must move the selection down:\n${rendered().map(strip).join('\n')}`)
  panel.handleInput('k')
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · pnpm build'), `k must move the selection up:\n${rendered().map(strip).join('\n')}`)
})

test('Kitty CSI-u arrow keys navigate the panel (zellij/WezTerm/Windows Terminal)', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()])
  // CSI-u ↓ (`\x1b[1;1B`) and the zellij repro's super-mod form (`\x1b[1;129B`)
  // must both move the selection down; legacy `\x1b[B` still works.
  panel.handleInput('\x1b[1;1B')
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · lint'), `CSI-u down must move the selection:\n${rendered().map(strip).join('\n')}`)
  panel.handleInput('\x1b[1;129B') // at the bottom (2 rows): stays
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · lint'), `CSI-u down (super mod) must keep the selection at the bottom:\n${rendered().map(strip).join('\n')}`)
  panel.handleInput('\x1b[1;1A')
  assert.ok(rendered().map(strip).join('\n').includes('→ ● bash · pnpm build'), `CSI-u up must move the selection back:\n${rendered().map(strip).join('\n')}`)
  // CSI-u pageUp/pageDown (`\x1b[5;1~` / `\x1b[6;1~`) page the list.
  const { panel: p2, rendered: r2 } = makePanel(Array.from({ length: 15 }, (_, i) => runningJob({ value: `job:b${i}`, label: `bash · job ${i}` })), { maxVisible: 10 })
  p2.handleInput('\x1b[6;1~')
  assert.ok(r2().map(strip).join('\n').includes('→ ● bash · job 10'), `CSI-u pageDown must page the list:\n${r2().map(strip).join('\n')}`)
  p2.handleInput('\x1b[5;1~')
  assert.ok(r2().map(strip).join('\n').includes('→ ● bash · job 0'), `CSI-u pageUp must page back:\n${r2().map(strip).join('\n')}`)
})

test('Kitty CSI-u Esc cancels and CSI-u Enter confirms', () => {
  let selected: string | undefined
  let cancelled = 0
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob()],
    10,
    { header: 'tasks', enableSearch: false },
    (value) => { selected = value },
    () => { cancelled += 1 },
    () => {},
  )
  panel.render(100)
  panel.handleInput('\x1b[27;1u') // CSI-u Esc (plain mod)
  assert.equal(cancelled, 1, `CSI-u Esc must cancel: got ${cancelled}`)
  const panel2 = new TaskBrowserPanel(
    [runningJob(), doneJob()],
    10,
    { header: 'tasks', enableSearch: false },
    (value) => { selected = value },
    () => { cancelled += 1 },
    () => {},
  )
  panel2.render(100)
  panel2.handleInput('\x1b[27;129u') // CSI-u Esc (super mod, zellij repro)
  assert.equal(cancelled, 2, `CSI-u Esc (super mod) must cancel: got ${cancelled}`)
  const panel3 = new TaskBrowserPanel(
    [runningJob(), doneJob()],
    10,
    { header: 'tasks', enableSearch: false },
    (value) => { selected = value },
    () => { cancelled += 1 },
    () => {},
  )
  panel3.render(100)
  panel3.handleInput('\x1b[13;1u') // CSI-u Enter confirms the first row
  assert.equal(selected, 'job:bash-1', `CSI-u Enter must confirm the selected row: got ${selected}`)
  // Legacy Esc still cancels.
  const panel4 = new TaskBrowserPanel(
    [runningJob()],
    10,
    { header: 'tasks', enableSearch: false },
    () => {},
    () => { cancelled += 1 },
    () => {},
  )
  panel4.render(100)
  panel4.handleInput('\x1b')
  assert.equal(cancelled, 3, `legacy Esc must still cancel: got ${cancelled}`)
})

test('the subagent mode suffix renders after the label and survives truncation', () => {
  // The mode (continuable / one-shot) is the panel's non-truncatable
  // SUFFIX: a narrow screen or a long label may clip the label, never the
  // mode — the viewer's interactivity must be readable before Enter.
  const { panel, rendered } = makePanel([
    { value: 'agent:child-1', label: 'subagent · research', suffix: 'continuable', status: 'inactive', group: 'subagents' },
    { value: 'agent:child-2', label: 'subagent · a-very-long-reviewer-label-that-keeps-growing', suffix: 'one-shot', status: 'running', group: 'subagents' },
  ])
  const wide = rendered().map(strip).join('\n')
  assert.ok(wide.includes('subagent · research · continuable'), `mode suffix missing on the wide frame:\n${wide}`)
  assert.ok(wide.includes('subagent · a-very-long-reviewer-label-that-keeps-growing · one-shot'), `full label + suffix missing:\n${wide}`)

  // Narrow frame: the label truncates from its own end, the mode stays.
  const narrowPanel = new TaskBrowserPanel(
    [subagent({ label: 'subagent · a-very-long-reviewer-label-that-keeps-growing', suffix: 'one-shot' })],
    10,
    { header: 'tasks', enableSearch: false, noMatchText: 'no active tasks' },
    () => {},
    () => {},
    () => {},
  )
  const narrow = narrowPanel.render(40).map(strip).join('\n')
  assert.ok(narrow.includes('· one-shot'), `the mode must survive the narrow frame:\n${narrow}`)
  assert.ok(narrow.includes('…'), `the clipped label must show the ellipsis:\n${narrow}`)
  assert.ok(!narrow.includes('keeps-growing'), `the label tail should be clipped on the narrow frame:\n${narrow}`)
})

test('the mode suffix is a HARD layout right: extreme widths compress label and tail, never the mode', () => {
  const item: TaskPanelItem = {
    value: 'agent:child-1',
    label: 'subagent · a-very-long-reviewer-label',
    suffix: 'one-shot',
    status: 'inactive',
    group: 'subagents',
  }
  const render = (width: number): string =>
    new TaskBrowserPanel([item], 10, { header: 'tasks', enableSearch: false, noMatchText: '' }, () => {}, () => {}, () => {})
      .render(width).map(strip).join('\n')
  // 60 cols: the mode and the tail survive with the label nearly complete
  // (one cell yields to the pad between the mode and the status).
  const wide = render(60)
  assert.ok(wide.includes('subagent · a-very-long-reviewer'), `label clipped too far:\n${wide}`)
  assert.ok(wide.includes('· one-shot'), `mode missing:\n${wide}`)
  assert.ok(wide.includes('inactive'), `tail missing:\n${wide}`)
  // 30 cols: the label clips, the mode and the tail survive.
  const medium = render(30)
  assert.ok(medium.includes('· one-shot'), `mode must survive 30 cols:\n${medium}`)
  assert.ok(medium.includes('…'), `clipped label must show the ellipsis:\n${medium}`)
  assert.ok(medium.includes('inactive'), `tail must survive 30 cols:\n${medium}`)
  // 16 cols (physically fits `→ ● one-shot`): the label and tail yield
  // entirely, the MODE stays — the viewer's interactivity is a pre-Enter
  // fact and the final whole-line truncation may never cut it.
  const narrow = render(16)
  assert.ok(narrow.includes('one-shot'), `the mode must survive an extreme width:\n${narrow}`)
  assert.ok(!narrow.includes('long-reviewer'), `the label must yield first:\n${narrow}`)
})

test('search matches the mode suffix too', () => {
  const { panel, rendered } = makePanel([
    subagent({ label: 'subagent · research', suffix: 'continuable', status: 'inactive' }),
    subagent({ label: 'subagent · audit', suffix: 'one-shot', status: 'inactive', value: 'agent:child-2' }),
  ], { enableSearch: true })
  // Type "one-shot" — only the audit row matches (the suffix is part of
  // the searchable text, so the mode is reachable by filter).
  panel.handleInput('o')
  panel.handleInput('n')
  panel.handleInput('e')
  panel.handleInput('-')
  panel.handleInput('s')
  panel.handleInput('h')
  panel.handleInput('o')
  panel.handleInput('t')
  const lines = rendered().map(strip)
  const joined = lines.join('\n')
  assert.ok(joined.includes('subagent · audit · one-shot'), `the one-shot row must match:\n${joined}`)
  assert.ok(!joined.includes('subagent · research · continuable'), `the continuable row must not match:\n${joined}`)
})
