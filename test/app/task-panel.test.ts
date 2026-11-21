/**
 * Unit tests for the TaskBrowserPanel presentation layer: status groups,
 * aligned columns, group headers, live elapsed ticking, selection movement,
 * search filtering, and the empty state. The row MODEL is tested separately
 * in tasks-browser.test.ts; this file only covers the panel's rendering and
 * input.
 * @module @xmoon76/dsh-pi-tui/task-panel.test
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TaskBrowserPanel, formatElapsed } from '../../src/tui/panels/task-panel.ts'
import { componentKeymap } from '../../src/tui/keybindings/component-keymap.ts'
import { formatKeyId } from '../../src/tui/keybindings/hints.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'
import type { TeamBrowserPresentation, TeamMemberPresentation } from '../../src/app/surface/task-presentation-port.ts'
import type { TeamBoardSnapshot, TeamBoardTask } from '../../src/runtime/team-board-read-port.ts'
import { MARQUEE_STEP_MS } from '../../src/tui/components/marquee.ts'
import { color, setTheme } from '../../src/tui/theme/runtime.ts'

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
  group: 'subagents',
  canStop: true,
  ...overrides,
})

function makePanel(
  items: TaskPanelItem[],
  options: { maxVisible?: number; enableSearch?: boolean; header?: string; team?: TeamBrowserPresentation; interactionCurrent?: () => boolean } = {},
): { panel: TaskBrowserPanel; rendered: () => string[] } {
  const panel = new TaskBrowserPanel(
    items,
    options.maxVisible ?? 10,
    {
      mode: 'full',
      header: options.header ?? 'tasks · subagents',
      enableSearch: options.enableSearch,
      mouseActionsEnabled: () => true,
      noMatchText: 'no active tasks',
      ...(options.team === undefined ? {} : { team: options.team }),
      ...(options.interactionCurrent === undefined ? {} : { interactionCurrent: options.interactionCurrent }),
    },
    () => {},
    () => {},
    () => {},
  )
  // Rendered fresh on every access: input handlers mutate state and the
  // real overlay drives the re-render, so the test must read the CURRENT
  // frame, not a snapshot.
  return { panel, rendered: () => panel.render(100) }
}

test('the action bar advertises a clickable Stop only for a row that can be stopped', () => {
  const stoppable = makePanel([subagent()])
  const stoppableFrame = stoppable.rendered().map(strip).join('\n')
  assert.ok(stoppableFrame.includes('Stop ['), `a stoppable row advertises its live Stop binding:\n${stoppableFrame}`)
  // An external catalog leaf (or any other non-stoppable row) has no Stop
  // action at all — `requestStop()` is a silent no-op there — so the bar must
  // not advertise a key that does nothing.
  const external = makePanel([subagent({ value: 'agent:ext', label: 'external · external run', canStop: false })])
  const externalFrame = external.rendered().map(strip).join('\n')
  assert.ok(!externalFrame.includes('Stop ['), `a non-stoppable row advertises no Stop:\n${externalFrame}`)
  assert.ok(externalFrame.includes('Enter open'), 'the remaining hints stay listed')
})

test('the extreme no-match grant keeps the message over the header', () => {
  const { panel, rendered } = makePanel([runningJob()], { enableSearch: true })
  panel.handleInput('/') // explicit search mode
  // A 2-row panel grant: compact rows are header/search/message/hint; the
  // header must yield BEFORE the no-match message (declared priority:
  // search > message > hint > header).
  panel.setMaxRows(2)
  for (const key of 'zz') panel.handleInput(key) // no match
  const lines = rendered().map(strip)
  const joined = lines.join('\n')
  assert.ok(lines.length <= 2, `the extreme no-match must fit the grant (${lines.length})`)
  assert.ok(joined.includes('no active tasks'), `the message must beat the header:\n${joined}`)
  assert.ok(joined.includes('zz'), 'the search row must survive')
  assert.ok(!joined.includes('tasks · subagents'), `the header must yield:\n${joined}`)
})

test('a 1-row search-mode grant paints only the search input and acks nothing', () => {
  const exposed: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob({ attention: true })],
    10,
    {
      mode: 'full',
      header: 'tasks · subagents',
      enableSearch: true,
      onViewportExpose: (ids) => { exposed.push(...ids) },
    },
    () => {},
    () => {},
    () => {},
  )
  panel.handleInput('/') // explicit search mode
  panel.setMaxRows(1)
  panel.render(100)
  // The degraded layout drops the selected main row (only the search
  // input fits): the exposure ack must NOT claim a row that was never
  // painted — ack scope == paint scope.
  assert.deepEqual(exposed, [], 'nothing may be acked when the selected row is not painted')
  const lines = panel.render(100).map(strip)
  const joined = lines.join('\n')
  assert.ok(lines.length <= 1, `the render must fit the grant (${lines.length})`)
  assert.ok(joined.includes('search…'), 'the search input is the one painted row')
  assert.ok(!joined.includes('bash · pnpm build'), `the selected task must not be painted:\n${joined}`)
})

test('rows render a shared status marker, kind · label, and right-aligned status + elapsed', () => {
  const now = Date.now()
  const { panel, rendered } = makePanel([
    runningJob({ startedAt: now - 2_000 }),
    doneJob(),
  ])
  const lines = rendered().map(strip)
  const joined = lines.join('\n')
  assert.ok(joined.includes('‣ Running'), `shared running status group missing:\n${joined}`)
  assert.ok(joined.includes('bash · pnpm build'), `label missing:\n${joined}`)
  assert.ok(joined.includes('2s'), `elapsed missing:\n${joined}`)
  assert.ok(joined.includes('‣ Completed'), `shared completed status group missing:\n${joined}`)
  assert.ok(joined.includes('2m'), `completed elapsed missing:\n${joined}`)
  for (const glyph of ['●', '○', '◐', '×', '?']) {
    assert.ok(!joined.includes(glyph), `legacy per-status glyph ${glyph} must be absent:\n${joined}`)
  }
  // The right column is right-aligned: the tail ends at the line's end
  // (after trimming, the status/elapsed sit at the far right).
  const row = lines.find(line => line.includes('pnpm build'))!
  assert.ok(row.trimEnd().endsWith('‣ Running 2s'), `tail must be right-aligned:\n${row}`)
  void panel
})

test('all full Task Center states use the shared marker and a readable word', () => {
  const items: TaskPanelItem[] = [
    runningJob({ value: 'job:running', label: 'bash · build' }),
    doneJob({ value: 'job:completed', label: 'bash · complete' }),
    { value: 'job:stopping', label: 'bash · stopping', status: 'stopping', group: 'jobs' },
    { value: 'job:failed', label: 'bash · failure', status: 'failed', group: 'jobs' },
    { value: 'question:q1', label: 'question · input', status: 'awaiting answer', source: 'question', group: 'questions' },
  ]
  const lines = makePanel(items).rendered().map(strip)
  const expected = [
    ['bash · build', '‣ Running'],
    ['bash · complete', '‣ Completed'],
    ['bash · stopping', '‣ Stopping'],
    ['bash · failure', '‣ Failed'],
    ['question · input', '‣ Awaiting answer'],
  ] as const
  for (const [label, status] of expected) {
    const row = lines.find(line => line.includes(label))
    assert.ok(row?.includes(status), `expected ${status} beside ${label}:\n${lines.join('\n')}`)
  }
  assert.equal(lines.filter(line => line.includes('‣')).length, expected.length, 'each row has exactly one shared status marker')
  for (const glyph of ['●', '○', '◐', '×', '?']) {
    assert.ok(!lines.some(line => line.includes(glyph)), `legacy per-status glyph ${glyph} must be absent:\n${lines.join('\n')}`)
  }
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
  assert.ok(joined.includes('1 active'), `running count missing:\n${joined}`)
  assert.ok(joined.includes('1 done'), `done count missing:\n${joined}`)
  assert.ok(joined.includes('1 failed'), `failed count missing:\n${joined}`)
})

test('the full default scope chip reads TRACKED, never ALL (presentation vocabulary)', () => {
  const { rendered } = makePanel([runningJob(), doneJob()])
  const joined = rendered().map(strip).join('\n')
  assert.ok(joined.includes('[TRACKED]'), `the full default scope chip must read TRACKED:\n${joined}`)
  assert.ok(!joined.includes('[ALL]'), `the legacy ALL vocabulary must be gone:\n${joined}`)
})

test('A toggles the scope chip while getViewState().scope stays the internal active/all contract', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()])
  assert.ok(rendered().map(strip).join('\n').includes('[TRACKED]'), 'full starts on the tracked scope')
  assert.equal(panel.getViewState().scope, 'all')
  panel.handleInput('a')
  assert.ok(rendered().map(strip).join('\n').includes('[ACTIVE]'), 'a flips the chip to ACTIVE')
  assert.equal(panel.getViewState().scope, 'active', 'the vocabulary change is presentation-only')
  panel.handleInput('a')
  const joined = rendered().map(strip).join('\n')
  assert.ok(joined.includes('[TRACKED]'), 'a flips the chip back to TRACKED')
  assert.ok(!joined.includes('[ACTIVE]'), `only one scope chip may render:\n${joined}`)
  assert.equal(panel.getViewState().scope, 'all')
})

test('selected row shows the pointer and bold label', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()])
  const first = rendered().map(strip).join('\n')
  assert.ok(first.includes('→ bash · pnpm build'), `selected row must show the pointer:\n${first}`)
  panel.handleInput('\x1b[B')
  const second = rendered().map(strip).join('\n')
  assert.ok(second.includes('→ bash · lint'), `selection must move down:\n${second}`)
  assert.ok(!second.includes('→ bash · pnpm build'), `old row must lose the pointer:\n${second}`)
})

test('↑↓ clamp at the ends (no wrap-around)', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()])
  panel.handleInput('\x1b[A') // at the top: stays
  assert.ok(rendered().map(strip).join('\n').includes('→ bash · pnpm build'), `↑ at top must not move:\n${rendered().map(strip).join('\n')}`)
  panel.handleInput('\x1b[B')
  panel.handleInput('\x1b[B') // at the bottom: stays
  assert.ok(rendered().map(strip).join('\n').includes('→ bash · lint'), `↓ at bottom must not wrap:\n${rendered().map(strip).join('\n')}`)
})

test('Enter fires onSelect with the selected value; Esc fires onCancel', () => {
  let selected: string | undefined
  let cancelled = 0
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob()],
    10,
    { mode: 'full', header: 'tasks' },
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
  // Typing a printable goes to the search input once search mode owns it.
  panel.handleInput('/')
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
  panel.handleInput('/')
  panel.handleInput('s')
  panel.handleInput('u')
  panel.handleInput('b')
  const filtered = rendered().map(strip).join('\n')
  assert.ok(filtered.includes('subagent · research'), `group query must keep the subagent row:\n${filtered}`)
  assert.ok(!filtered.includes('pnpm build'), `job rows must be filtered by the group query:\n${filtered}`)
})

// ── the async-merge focus race (plan item 2) ──────────────────────────────

const typed = (item: TaskPanelItem, type: string): TaskPanelItem => ({ ...item, type })
const DOWN = '\x1b[B'
const UP = '\x1b[A'
/** Apply one type through the explicit `f` filter list (FR2). Opens at the
 *  current type; the caller navigates with DOWN/UP counts from there. */
const openTypeList = (panel: TaskBrowserPanel): void => panel.handleInput('f')

test('an UNTOUCHED selection follows the enriched list head (the /tasks race)', () => {
  // The browser opens on the jobs half only…
  const { panel, rendered } = makePanel([runningJob(), doneJob()], { enableSearch: true })
  assert.ok(rendered().map(strip).join('\n').includes('→ bash · pnpm build'),
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
  assert.ok(enriched.includes('→ subagent · research'),
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
  assert.ok(view.includes('→   ├─ subagent · deep'), `preferred row must be selected:\n${view}`)
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

test('Full Tracked Subagent disclosure responds to Left/Right and survives live re-projection', () => {
  const items: TaskPanelItem[] = [
    { value: 'agent:parent', label: 'subagent · parent', status: 'inactive', group: 'subagents', source: 'subagent', type: 'subagent', active: false, depth: 1, hasChildren: true, suffix: 'continuable' },
    { value: 'agent:old', label: 'subagent · old', status: 'inactive', group: 'subagents', source: 'subagent', type: 'subagent', active: false, parentId: 'agent:parent', depth: 2, hasChildren: true, suffix: 'continuable' },
    { value: 'agent:leaf', label: 'subagent · leaf', status: 'inactive', group: 'subagents', source: 'subagent', type: 'subagent', active: false, parentId: 'agent:old', depth: 3, suffix: 'one-shot' },
    { value: 'agent:live', label: 'subagent · live', status: 'running', group: 'subagents', source: 'subagent', type: 'subagent', active: true, parentId: 'agent:parent', depth: 2, suffix: 'one-shot' },
    // A generic row (no `source`) keeps this disclosure test focused on the
    // Subagent tree; Job-source terminal rows are covered by the jobs tests.
    { value: 'job:build', label: 'bash · build', status: 'completed', group: 'jobs', type: 'bash' },
  ]
  const { panel } = makePanel(items, { maxVisible: 10 })
  assert.deepEqual(panel.visibleItems().map(item => item.value),
    ['agent:parent', 'agent:old', 'agent:leaf', 'agent:live', 'job:build'])
  assert.equal(panel.getViewState().selectedId, 'agent:parent')
  assert.equal(panel.visibleItems()[0]!.expanded, true)

  panel.handleInput('\x1b[D')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'job:build'])
  assert.ok(panel.getViewState().collapsedIds.has('agent:parent'))

  panel.handleInput('\x1b[C')
  assert.deepEqual(panel.visibleItems().map(item => item.value),
    ['agent:parent', 'agent:old', 'agent:leaf', 'agent:live', 'job:build'])
  assert.ok(!panel.getViewState().collapsedIds.has('agent:parent'))

  // Right on an already-expanded parent still enters its first direct child.
  panel.handleInput('\x1b[C')
  assert.equal(panel.getViewState().selectedId, 'agent:old')

  // Return to the parent and leave it explicitly collapsed, then simulate a
  // live row refresh: the user's disclosure survives and the selection stays
  // valid on a real row identity.
  panel.handleInput('\x1b[A')
  assert.equal(panel.getViewState().selectedId, 'agent:parent')
  panel.handleInput('\x1b[D')
  panel.setItems(items.map(item => item.value === 'agent:leaf' ? { ...item, status: 'completed' } : item))
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'job:build'])
  assert.deepEqual(panel.getViewState().collapsedIds, new Set(['agent:parent']))
  assert.equal(panel.getViewState().scope, 'all')
  assert.equal(panel.getViewState().selectedId, 'agent:parent')

  // Active keeps its own membership rule; the explicit collapse still hides
  // the active descendant. Switching back to Tracked keeps that collapse.
  panel.handleInput('a')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent'])
  assert.ok(!panel.visibleItems().some(item => item.value.startsWith('agent:old')))
  panel.handleInput('a')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'job:build'])
  panel.dispose()
})

test('a USER-touched selection survives a later enrichment (no focus stealing)', () => {
  const { panel, rendered } = makePanel(
    [typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true },
  )
  // The user moves down to the second row…
  panel.handleInput('\x1b[B')
  assert.ok(rendered().map(strip).join('\n').includes('→ bash · lint'), `precondition — user on the lint row:\n${rendered().map(strip).join('\n')}`)
  // …then a refresh inserts a running subagent at the head.
  panel.setItems([
    typed(subagent(), 'subagent'),
    typed(runningJob(), 'bash'),
    typed(doneJob(), 'bash'),
  ])
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('→ bash · lint'),
    `a touched selection must stay on the user's row, not jump to the new head:\n${after}`)
  assert.ok(!after.includes('→ subagent · research'), `the head must not steal the focus:\n${after}`)
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
  assert.ok(after.includes('→ bash · pnpm build'), `a vanished row must fall back to the head:\n${after}`)
})

// ── the explicit `f` type filter list (FR2: Tab is no longer a type cycle) ──

test('the f type list applies All → subagent → bash → All and filters rows by type', () => {
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true, header: 'tasks · subagents' },
  )
  const all = rendered().map(strip).join('\n')
  assert.ok(all.includes('subagent · research') && all.includes('pnpm build'), `precondition — All shows everything:\n${all}`)

  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput('\r') // All → subagent
  const agents = rendered().map(strip).join('\n')
  assert.ok(agents.includes('subagent · research'), `subagent filter keeps the agent row:\n${agents}`)
  assert.ok(!agents.includes('pnpm build'), `subagent filter drops job rows:\n${agents}`)
  assert.ok(agents.includes('[subagent]'), `the header must show the active type chip:\n${agents}`)

  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput('\r') // subagent → bash
  const bash = rendered().map(strip).join('\n')
  assert.ok(bash.includes('pnpm build'), `bash filter keeps job rows:\n${bash}`)
  assert.ok(!bash.includes('subagent · research'), `bash filter drops the agent row:\n${bash}`)
  assert.ok(bash.includes('[bash]'), `the chip follows the selection:\n${bash}`)

  openTypeList(panel); panel.handleInput(UP); panel.handleInput(UP); panel.handleInput('\r') // bash → All
  const allAgain = rendered().map(strip).join('\n')
  assert.ok(allAgain.includes('subagent · research') && allAgain.includes('pnpm build'), `All shows everything again:\n${allAgain}`)
  assert.ok(!allAgain.includes('[bash]'), `All shows no chip:\n${allAgain}`)
})

test('type filter composes with the search query', () => {
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true },
  )
  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput('\r') // subagent
  panel.handleInput('/') // explicit search mode
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
  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput('\r') // bash
  const filtered = rendered().map(strip).join('\n')
  assert.ok(filtered.includes('bash · lint'), `typed row stays:\n${filtered}`)
  assert.ok(!filtered.includes('bash · pnpm build'), `typeless row hides under a type filter:\n${filtered}`)
})

test('the Work hint advertises the explicit f type list and the Tab Team switch (never Shift+Tab type)', () => {
  const typeHint = `${componentKeymap.keyHint('tasks.type.filter')} type`
  const tabHint = `${componentKeymap.keyHint('tasks.tab.next')} Team`
  const single = makePanel([typed(runningJob(), 'bash')], { enableSearch: true, team: readyTeam([teamTask()]) })
  const singleFrame = single.rendered().map(strip).join('\n')
  assert.ok(singleFrame.includes(typeHint), `a single-kind list still advertises the f type list:\n${singleFrame}`)
  assert.ok(singleFrame.includes(tabHint), `the Work hint advertises the Tab Team switch:\n${singleFrame}`)
  assert.ok(!singleFrame.includes('Shift+Tab type'), `Shift+Tab type must be retired:\n${singleFrame}`)
  const multi = makePanel([typed(runningJob(), 'bash'), typed(subagent(), 'subagent')], { enableSearch: true, team: readyTeam([teamTask()]) })
  const multiFrame = multi.rendered().map(strip).join('\n')
  assert.ok(multiFrame.includes(typeHint), `mixed list advertises the f type list:\n${multiFrame}`)
  assert.ok(multiFrame.includes(tabHint), `mixed list advertises Tab Team:\n${multiFrame}`)
})

test('the Full action bar keeps the real Esc outcome last and visible at 44/80/120 columns', () => {
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob(), subagent()],
    10,
    { mode: 'full', header: 'tasks · subagents', enableSearch: true, mouseActionsEnabled: () => true, initialPreferredValue: 'agent:child-1' },
    () => {},
    () => {},
    () => {},
  )
  const assertEscLast = (width: number, outcome: 'close' | 'back'): void => {
    const rows = panel.render(width).map(strip)
    assertPhysicalRows(rows, width)
    const hint = rows.at(-1)!
    assert.equal(visibleWidth(hint) <= width, true,
      `width ${width}: the painted hint fits (${visibleWidth(hint)} > ${width}): ${JSON.stringify(hint)}`)
    const segments = hint.trim().split(' · ')
    const stopKey = componentKeymap.keysFor('tasks.stop')[0]
    const stopLabel = stopKey === undefined ? 'Stop' : `Stop [${formatKeyId(stopKey)}]`
    const tabHint = `${componentKeymap.keyHint('tasks.tab.next')} Team`
    const typeHint = `${componentKeymap.keyHint('tasks.type.filter')} type`
    const allowed = outcome === 'close'
      ? new Set(['Enter open', '↑↓ select', '←→ tree', stopLabel, 'Stop', '/ search', 'a scope', tabHint, typeHint, 'Close [Esc]'])
      : new Set(['Enter open', '↑↓ select', '←→ edit', tabHint, 'type to filter', 'Back [Esc]'])
    assert.ok(segments.every(segment => allowed.has(segment)),
      `width ${width}: only complete advertised segments remain: ${JSON.stringify(segments)}`)
    assert.equal(segments.at(-1), outcome === 'close' ? 'Close [Esc]' : 'Back [Esc]',
      `width ${width}: the real Esc outcome is the final painted segment:\n${rows.join('\n')}`)
    if (width === 44) {
      const expected = outcome === 'close'
        ? ['Enter open', stopLabel, 'Close [Esc]']
        : ['Enter open', '↑↓ select', 'Back [Esc]']
      assert.deepEqual(segments, expected,
        `width ${width}: lower-priority actions drop whole before Esc`)
    }
  }

  for (const width of [44, 80, 120]) {
    assertEscLast(width, 'close')
    panel.handleInput('/') // enter the real search mode
    assertEscLast(width, 'back')
    panel.handleInput('\x1b') // Esc backs out of search; it does not close Full
    assertEscLast(width, 'close')
    assert.ok(panel.render(width).map(strip).some(line => line.includes('bash · pnpm build')),
      `width ${width}: Esc back leaves the Full Task Center open`)
  }
  panel.dispose()
})

test('a vanished active type snaps the filter back to All on setItems', () => {
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash')],
    { enableSearch: true },
  )
  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput('\r') // subagent
  assert.ok(rendered().map(strip).join('\n').includes('[subagent]'), `precondition — subagent filter active:\n${rendered().map(strip).join('\n')}`)
  // The subagent settles and disappears from the refresh.
  panel.setItems([typed(runningJob(), 'bash')])
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('pnpm build'), `snapped to All shows the remaining row:\n${after}`)
  assert.ok(!after.includes('[subagent]'), `the vanished type must not stay active:\n${after}`)
})

test('an f type filter counts as a user interaction (no head-stealing on refresh)', () => {
  // The explicit `f` filter marks the selection touched, so a later async
  // setItems enrichment must preserve the selection within the user's
  // chosen scope — never re-focus the unfiltered head.
  const { panel, rendered } = makePanel(
    [typed(subagent(), 'subagent'), typed(runningJob(), 'bash'), typed(doneJob(), 'bash')],
    { enableSearch: true },
  )
  // The user picks the bash scope and moves onto the lint row.
  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput(DOWN); panel.handleInput('\r') // bash
  panel.handleInput(DOWN) // onto the lint row
  const before = rendered().map(strip).join('\n')
  assert.ok(before.includes('→ bash · lint'), `precondition — a row selected within the type scope:\n${before}`)
  // An enrichment arrives with a NEW bash job at the head of the filtered
  // scope; the touched selection must not jump.
  panel.setItems([
    typed(runningJob({ value: 'job:bash-new', label: 'bash · fresh' }), 'bash'),
    typed(runningJob(), 'bash'),
    typed(doneJob(), 'bash'),
    typed(subagent(), 'subagent'),
  ])
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('→ bash · lint'),
    `the touched selection must survive the refresh inside the typed scope:\n${after}`)
})

test('search input is editable: backspace removes characters and re-filters', () => {
  const { panel, rendered } = makePanel(
    [runningJob(), doneJob(), subagent()],
    { enableSearch: true },
  )
  panel.handleInput('/')
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
  assert.ok(joined.includes('↑↓ select'), `hint missing:\n${joined}`)
})

test('dispose stops the elapsed tick (no render callbacks after close)', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] })
  t.after(() => mock.timers.reset())
  let renders = 0
  const panel = new TaskBrowserPanel(
    [runningJob({ startedAt: Date.now() - 1_000 })],
    10,
    { mode: 'full', header: 'tasks' },
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
  panel.handleInput('/')
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

test('Kitty CSI-u arrow keys navigate the panel (zellij/WezTerm/Windows Terminal)', () => {
  const { panel, rendered } = makePanel([runningJob(), doneJob()])
  // CSI-u ↓ (`\x1b[1;1B`) and the zellij repro's super-mod form (`\x1b[1;129B`)
  // must both move the selection down; legacy `\x1b[B` still works.
  panel.handleInput('\x1b[1;1B')
  assert.ok(rendered().map(strip).join('\n').includes('→ bash · lint'), `CSI-u down must move the selection:\n${rendered().map(strip).join('\n')}`)
  panel.handleInput('\x1b[1;129B') // at the bottom (2 rows): stays
  assert.ok(rendered().map(strip).join('\n').includes('→ bash · lint'), `CSI-u down (super mod) must keep the selection at the bottom:\n${rendered().map(strip).join('\n')}`)
  panel.handleInput('\x1b[1;1A')
  assert.ok(rendered().map(strip).join('\n').includes('→ bash · pnpm build'), `CSI-u up must move the selection back:\n${rendered().map(strip).join('\n')}`)
  // CSI-u pageUp/pageDown (`\x1b[5;1~` / `\x1b[6;1~`) page the list.
  const { panel: p2, rendered: r2 } = makePanel(Array.from({ length: 15 }, (_, i) => runningJob({ value: `job:b${i}`, label: `bash · job ${i}` })), { maxVisible: 10 })
  p2.handleInput('\x1b[6;1~')
  assert.ok(r2().map(strip).join('\n').includes('→ bash · job 10'), `CSI-u pageDown must page the list:\n${r2().map(strip).join('\n')}`)
  p2.handleInput('\x1b[5;1~')
  assert.ok(r2().map(strip).join('\n').includes('→ bash · job 0'), `CSI-u pageUp must page back:\n${r2().map(strip).join('\n')}`)
})

test('Kitty CSI-u Esc cancels and CSI-u Enter confirms', () => {
  let selected: string | undefined
  let cancelled = 0
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false },
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
    { mode: 'full', header: 'tasks', enableSearch: false },
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
    { mode: 'full', header: 'tasks', enableSearch: false },
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
    { mode: 'full', header: 'tasks', enableSearch: false },
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
    { mode: 'full', header: 'tasks', enableSearch: false, noMatchText: 'no active tasks' },
    () => {},
    () => {},
    () => {},
  )
  const narrow = narrowPanel.render(40).map(strip).join('\n')
  assert.ok(narrow.includes('· one-shot'), `the mode must survive the narrow frame:\n${narrow}`)
  // The SELECTED row marquees (plan §7): the label window shows the label
  // start (the initial pause), never a static ellipsis; the mode suffix
  // stays fixed. Unselected rows keep the ellipsis (covered elsewhere).
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
    new TaskBrowserPanel([item], 10, { mode: 'full', header: 'tasks', enableSearch: false, noMatchText: '' }, () => {}, () => {}, () => {})
      .render(width).map(strip).join('\n')
  // 60 cols: the mode and the tail survive with the label nearly complete
  // (one cell yields to the pad between the mode and the status).
  const wide = render(60)
  assert.ok(wide.includes('subagent · a-very-long-reviewer'), `label clipped too far:\n${wide}`)
  assert.ok(wide.includes('· one-shot'), `mode missing:\n${wide}`)
  assert.ok(wide.includes('‣ Inactive'), `status tail missing:\n${wide}`)
  // 30 cols: the label clips, the mode and the tail survive.
  const medium = render(30)
  assert.ok(medium.includes('· one-shot'), `mode must survive 30 cols:\n${medium}`)
  // The selected row marquees: no static ellipsis (the label window shows
  // the label start during the initial pause), and the mode suffix + the
  // status tail stay fixed (plan §7.5).
  assert.ok(!medium.split('\n').find(line => line.includes('one-shot'))!.includes('…'),
    `a selected overflow row must marquee, not ellipsis:\n${medium}`)
  assert.ok(medium.includes('‣ Inactive'), `status tail must survive 30 cols:\n${medium}`)
  // 16 cols (physically fits `→ one-shot`): the label and tail yield
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
  panel.handleInput('/')
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

test('the selected row marquees under a fake clock while unselected rows stay fixed (review F1)', () => {
  // Panel-level regression for the marquee review finding: every row is
  // rendered through the SAME marquee each frame; the selected row must
  // keep scrolling while unselected rows render before/after it.
  const now = { value: 0 }
  const items: TaskPanelItem[] = [
    { value: 'agent:other', label: 'subagent · a-short-label', suffix: 'one-shot', status: 'inactive', group: 'subagents', treePrefix: '├─ ' },
    { value: 'agent:sel', label: 'subagent · a-very-long-selected-label-that-overflows-its-budget', suffix: 'continuable', status: 'running', group: 'subagents', treePrefix: '  ├─ ' },
    { value: 'job:1', label: 'bash · build', status: 'running', group: 'jobs' },
  ]
  const panel = new TaskBrowserPanel(
    items, 10,
    { mode: 'full', header: 'tasks', enableSearch: false, noMatchText: '', marqueeNow: () => now.value },
    () => {}, () => {}, () => {},
  )
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  // The second row is selected by default (index 0 is selected on open —
  // move down to the long label).
  panel.handleInput('\x1b[B')
  // Initial render: the selected label shows its start (pause).
  // A narrow frame forces the selected label to overflow its budget.
  const initial = panel.render(46).map(strip).join('\n')
  assert.ok(initial.includes('→   ├─ subagent · a-ve'),
    `selected label window (initial pause) must show:\n${initial}`)
  assert.ok(initial.includes('├─ subagent · a-short…'), `unselected tree row must ellipsis:\n${initial}`)
  // Repaint storm with interleaved unselected rows, then advance the clock
  // past the pause: the selected label must MOVE (its cycle was not reset).
  for (let t = 0; t < 800; t += 100) {
    now.value = t
    panel.render(46) // full repaint — unselected rows render through the marquee too
  }
  now.value = 800 + 3 * MARQUEE_STEP_MS
  const moved = panel.render(46).map(strip).join('\n')
  assert.ok(!moved.includes('→   ├─ subagent · a-ve'),
    `the selected label must have scrolled past its start:\n${moved}`)
  assert.ok(moved.includes('├─ subagent · a-short…'), `unselected rows must stay put:\n${moved}`)
  panel.dispose()
})

test('a search/type filter restarts the selected row marquee even when the SAME row survives (review round 3)', () => {
  // The filter can retain the selected row's identity (same value/label/
  // width) — the marquee must still restart from a fresh anchor, or it
  // would continue mid-cycle inside the new filtered view.
  const now = { value: 0 }
  const item: TaskPanelItem = {
    value: 'agent:sel',
    label: 'subagent · a-very-long-selected-label-that-overflows-its-budget',
    suffix: 'continuable',
    status: 'inactive',
    group: 'subagents',
  }
  const panel = new TaskBrowserPanel(
    [item], 10,
    { mode: 'full', header: 'tasks', enableSearch: true, noMatchText: '', marqueeNow: () => now.value },
    () => {}, () => {}, () => {},
  )
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  // Advance the fake clock well into the scroll cycle.
  now.value = 800 + 6 * MARQUEE_STEP_MS
  const mid = panel.render(60).map(strip).join('\n')
  assert.ok(!mid.includes('a-very-long-selected-label-that'),
    `precondition — the label must have scrolled past its start:\n${mid}`)
  // Type a query that MATCHES the same row (identity unchanged).
  panel.handleInput('/')
  panel.handleInput('s')
  now.value = 800 + 8 * MARQUEE_STEP_MS
  const after = panel.render(60).map(strip).join('\n')
  assert.ok(after.includes('a-very-long-selected-l'),
    `the filter must restart the marquee from the fresh anchor:\n${after}`)
  panel.dispose()
})

/** A minimal mouse event for direct component tests. */
function mouse(
  type: 'press' | 'click' | 'wheel',
  x: number,
  y: number,
  width = 100,
  height = 24,
  wheelDelta?: number,
  button: 'left' | 'none' = 'left',
): import('@xmoon76/pi-tui').TuiMouseEvent {
  return {
    type,
    button,
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
    ...(type === 'wheel' ? { wheelDelta: wheelDelta ?? 1 } : {}),
  }
}

function pressPanelText(panel: TaskBrowserPanel, text: string, width = 100, height = 24): {
  x: number
  row: number
  width: number
  height: number
} {
  const lines = panel.render(width).map(strip)
  const row = lines.findIndex(line => line.includes(text))
  assert.ok(row >= 0, `panel action '${text}' must be visible:\n${lines.join('\n')}`)
  const x = lines[row]!.indexOf(text)
  assert.ok(x >= 0)
  const press = panel.handleMouse(mouse('press', x, row, width, height))
  assert.ok(press?.handled, `press on '${text}' must be handled`)
  return { x, row, width, height }
}

function clickPanelText(panel: TaskBrowserPanel, text: string, width = 100, height = 24): boolean {
  const pressed = pressPanelText(panel, text, width, height)
  const click = panel.handleMouse(mouse('click', pressed.x, pressed.row, width, height))
  return click?.handled === true
}

test('task panel: mouse click activates the exact task (mouse parity)', () => {
  const selected: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob(), subagent()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false },
    (value) => { selected.push(value) },
    () => {},
    () => {},
  )
  const rendered = panel.render(100)
  const row = rendered.findIndex(line => line.includes('bash · lint'))
  assert.ok(row >= 0, `done job row missing:\n${rendered.join('\n')}`)
  const press = panel.handleMouse(mouse('press', 10, row, 100, 24))
  assert.ok(press?.handled, 'press on a task row must be handled')
  assert.equal(press?.focus, true, 'press must request focus')
  panel.handleMouse(mouse('click', 10, row, 100, 24))
  assert.deepEqual(selected, ['job:bash-2'], 'click must activate the exact task')
})

test('task panel: only the complete Stop span is clickable in the action row', () => {
  const stopped: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob({ canStop: true })],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false, mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
    () => {},
    () => {},
    () => {},
  )
  const rendered = panel.render(100).map(strip)
  const groupRow = rendered.findIndex(line => line.includes('── jobs ──'))
  const hintRow = rendered.findIndex(line => line.includes('↑↓'))
  const otherHintX = rendered[hintRow]?.indexOf('Enter open') ?? -1
  assert.ok(groupRow >= 0 && hintRow >= 0 && otherHintX >= 0, `chrome rows missing:\n${rendered.join('\n')}`)
  assert.equal(panel.handleMouse(mouse('press', 10, groupRow, 100, 24)), undefined, 'group header must be inert')
  assert.equal(panel.handleMouse(mouse('press', otherHintX, hintRow, 100, 24)), undefined, 'non-action hints stay inert')
  assert.equal(clickPanelText(panel, 'Stop ['), true, 'the fully painted Stop segment accepts a click')
  assert.deepEqual(stopped, [], 'Stop only enters the original pending confirmation')
  assert.ok(panel.render(100).map(strip).some(line => line.includes('Confirm stop [Y]')))
  panel.dispose()
})

test('Regular Task Browser keeps its keyboard-only Stop hint and inert mouse row', () => {
  const panel = new TaskBrowserPanel(
    [runningJob({ canStop: true })],
    10,
    { mode: 'full', header: 'tasks' },
    () => {},
    () => {},
    () => {},
  )
  const lines = panel.render(120).map(strip)
  const actionRow = lines.at(-1) ?? ''
  assert.ok(actionRow.includes('s stop'))
  assert.ok(!actionRow.includes('Stop [S]'))
  const row = lines.length - 1
  const x = actionRow.indexOf('s stop')
  assert.equal(panel.handleMouse(mouse('press', x, row, 120, 24)), undefined)
  panel.handleInput('s')
  const pending = panel.render(120).map(strip).join('\n')
  assert.ok(pending.includes('Y confirm stop · Esc cancel'))
  assert.ok(pending.includes('Stop bash · pnpm build?'))
  assert.ok(!pending.includes('Stop bash · pnpm build?  Y confirm'))
  panel.dispose()
})

test('Fullscreen Task Action Bar uses quiet ink roles and muted keycaps', () => {
  setTheme('dark')
  const panel = new TaskBrowserPanel(
    [runningJob({ value: 'job:a', canStop: true })],
    10,
    { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true },
    () => {},
    () => {},
    () => {},
  )
  const normal = panel.render(120).at(-1)!
  assert.equal(visibleWidth(normal), visibleWidth(strip(normal)), 'ink must not change the painted cell width')
  assert.ok(normal.includes(color.textDim('Stop')), `Stop is secondary ink:\n${normal}`)
  assert.ok(normal.includes(color.textMuted(' [S]')), `the Stop keycap is muted:\n${normal}`)
  assert.ok(normal.includes(color.textMuted('Enter open')), `pure keyboard hints are muted:\n${normal}`)
  assert.ok(normal.includes(color.textDim('Close')) && normal.includes(color.textMuted(' [Esc]')),
    `the close verb is secondary ink with a muted keycap:\n${normal}`)
  assert.ok(normal.includes(color.textMuted(' · ')), `the separator is muted:\n${normal}`)
  assert.ok(!normal.includes(color.primary('Stop')), `Stop is not flooded with primary ink:\n${normal}`)

  panel.handleInput('s')
  const pending = panel.render(120).at(-1)!
  assert.ok(pending.includes(color.text('Confirm stop')) && pending.includes(color.textMuted(' [Y]')),
    `Confirm stop is primary with a muted keycap:\n${pending}`)
  assert.ok(pending.includes(color.textDim('Cancel')) && pending.includes(color.textMuted(' [Esc]')),
    `Cancel is secondary with a muted keycap:\n${pending}`)
  assert.ok(!pending.includes(color.primary('Confirm stop')), `Confirm is not flooded with primary ink:\n${pending}`)
  panel.dispose()
})

test('Fullscreen pending stop details identify the task once and leave verbs in the Action Bar', () => {
  const target = runningJob({ value: 'job:a', label: 'bash · release', canStop: true })
  const panel = new TaskBrowserPanel(
    [target],
    10,
    { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true },
    () => {},
    () => {},
    () => {},
  )
  panel.handleInput('s')
  const rows = panel.render(120).map(strip)
  const joined = rows.join('\n')
  assert.ok(joined.includes('Stop bash · release?'), `the detail names the confirmation target:\n${joined}`)
  assert.equal(joined.match(/Confirm stop \[Y\]/gu)?.length ?? 0, 1)
  assert.equal(joined.match(/Cancel \[Esc\]/gu)?.length ?? 0, 1)
  assert.ok(!joined.includes('Y confirm') && !joined.includes('Esc cancel'), `details do not repeat the bar verbs:\n${joined}`)
  panel.dispose()
})

test('task panel: Stop, Cancel and Confirm share the original pending state and sink', () => {
  const stopped: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob({ value: 'job:a', canStop: true })],
    10,
    { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
    () => {},
    () => {},
    () => {},
  )

  assert.equal(clickPanelText(panel, 'Stop ['), true)
  assert.ok(panel.render(100).map(strip).some(line => line.includes('Confirm stop [Y]')))
  assert.deepEqual(stopped, [], 'Stop only arms the existing confirmation')
  assert.equal(clickPanelText(panel, 'Cancel [Esc]'), true)
  assert.deepEqual(stopped, [], 'Cancel clears pending without calling onStop')
  assert.ok(panel.render(100).map(strip).some(line => line.includes('Stop [')))

  assert.equal(clickPanelText(panel, 'Stop ['), true)
  const pressed = pressPanelText(panel, 'Confirm stop [Y]')
  assert.ok(panel.handleMouse(mouse('click', pressed.x, pressed.row, pressed.width, pressed.height))?.handled)
  assert.deepEqual(stopped, ['job:a'], 'Confirm reaches the original onStop sink exactly once')
  panel.handleMouse(mouse('click', pressed.x, pressed.row, pressed.width, pressed.height))
  assert.deepEqual(stopped, ['job:a'], 'a duplicate release has no confirmation latch')
  panel.dispose()
})

test('task panel: capability loss between Confirm press and release never reaches onStop', () => {
  const stopped: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob({ value: 'job:a', canStop: true })],
    10,
    { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
    () => {},
    () => {},
    () => {},
  )
  assert.equal(clickPanelText(panel, 'Stop ['), true)
  const pressed = pressPanelText(panel, 'Confirm stop [Y]')
  panel.setItems([runningJob({ value: 'job:a', canStop: false })])
  panel.render(100)
  panel.handleMouse(mouse('click', pressed.x, pressed.row, pressed.width, pressed.height))
  assert.deepEqual(stopped, [])
  panel.dispose()
})

test('task panel: the first pending other-row click only cancels and selects', () => {
  const selected: string[] = []
  const stopped: string[] = []
  const panel = new TaskBrowserPanel(
    [
      runningJob({ value: 'job:a', label: 'first task', canStop: true }),
      runningJob({ value: 'job:b', label: 'second task', canStop: true }),
    ],
    10,
    { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
    value => selected.push(value),
    () => {},
    () => {},
  )
  panel.handleInput('s')
  let rendered = panel.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('Confirm stop [Y]')))
  const row = rendered.findIndex(line => line.includes('second task'))
  assert.ok(row >= 0)
  assert.ok(panel.handleMouse(mouse('press', 10, row, 100, 24))?.handled)
  assert.equal(panel.getViewState().selectedId, 'job:b')
  assert.ok(!panel.render(100).map(strip).some(line => line.includes('Confirm stop [Y]')))
  const firstRelease = panel.handleMouse(mouse('click', 10, row, 100, 24))
  assert.equal(firstRelease?.handled, true, 'the selection-only release is consumed by the browser')
  assert.deepEqual(selected, [], 'the release from the cancellation press cannot open the row')
  assert.deepEqual(stopped, [])

  rendered = panel.render(100).map(strip)
  const nextRow = rendered.findIndex(line => line.includes('second task'))
  assert.ok(panel.handleMouse(mouse('press', 10, nextRow, 100, 24))?.handled)
  panel.handleMouse(mouse('click', 10, nextRow, 100, 24))
  assert.deepEqual(selected, ['job:b'], 'a second, independent click opens the selected row')
  panel.dispose()
})

test('task panel: stale Stop releases lose their subject, capability, filter, size or owner', () => {
  const invalidations: Array<{
    name: string
    apply(panel: TaskBrowserPanel): number
  }> = [
    { name: 'item replacement', apply: panel => { panel.setItems([runningJob({ value: 'job:b', canStop: true })]); return 100 } },
    { name: 'capability revocation', apply: panel => { panel.setItems([runningJob({ value: 'job:a', canStop: false })]); return 100 } },
    { name: 'search entry', apply: panel => { panel.handleInput('/'); return 100 } },
    { name: 'resize', apply: panel => { panel.render(80); return 80 } },
    { name: 'dispose', apply: panel => { panel.dispose(); return 100 } },
  ]
  for (const invalidation of invalidations) {
    const stopped: string[] = []
    const panel = new TaskBrowserPanel(
      [runningJob({ value: 'job:a', canStop: true })],
      10,
      { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
      () => {},
      () => {},
      () => {},
    )
    const pressed = pressPanelText(panel, 'Stop [')
    const releaseWidth = invalidation.apply(panel)
    panel.handleMouse(mouse('click', pressed.x, pressed.row, releaseWidth, pressed.height))
    assert.deepEqual(stopped, [], `${invalidation.name} must revoke the action gesture`)
    if (invalidation.name !== 'dispose') panel.dispose()
  }
})

test('task panel: compact Stop spans remain clickable in the short final hint row', () => {
  for (const [width, rows] of [[44, 10], [72, 10], [80, 8], [80, 10], [100, 10], [120, 10]]) {
    const stopped: string[] = []
    const panel = new TaskBrowserPanel(
      [runningJob({ value: `job:${width}-${rows}`, canStop: true })],
      10,
      { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
      () => {},
      () => {},
      () => {},
    )
    panel.setMaxRows(rows)
    const lines = panel.render(width).map(strip)
    assertPhysicalRows(lines, width)
    assert.ok(lines.at(-1)?.includes('Stop'), `Stop remains on the final hint row at ${width}x${rows}:\n${lines.join('\n')}`)
    assert.equal(clickPanelText(panel, 'Stop', width, rows), true, `Stop is clickable at ${width}x${rows}`)
    assert.ok(panel.render(width).map(strip).some(line => line.includes('Confirm stop')))
    panel.dispose()
  }
})

test('a refresh that moves the selection cancels the pending stop instead of painting a dead Confirm', () => {
  const stopped: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob({ value: 'job:a', label: 'first task', canStop: true }), runningJob({ value: 'job:b', label: 'second task', canStop: true })],
    10,
    { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
    () => {},
    () => {},
    () => {},
  )
  panel.render(120)
  panel.handleInput('s')
  assert.ok(panel.render(120).map(strip).some(line => line.includes('Confirm stop [Y]')), 'precondition — job:a armed')
  panel.setItems([
    runningJob({ value: 'job:b', label: 'second task', canStop: true }),
    runningJob({ value: 'job:a', label: 'first task', canStop: true }),
  ], 'job:b')
  assert.equal(panel.getViewState().selectedId, 'job:b')
  const refreshed = panel.render(120).map(strip).join('\n')
  assert.ok(!refreshed.includes('Confirm stop [Y]'), `the refresh must clear the stale confirmation:\n${refreshed}`)
  assert.ok(refreshed.includes('Stop ['), `the refreshed bar must offer Stop for the selected row:\n${refreshed}`)
  panel.handleInput('y')
  assert.deepEqual(stopped, [], 'keyboard confirm cannot stop the pre-refresh target')
  panel.dispose()
})

test('task panel: search Input click repositions the query cursor (mouse parity)', () => {
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: true },
    () => {},
    () => {},
    () => {},
  )
  panel.render(100)
  panel.handleInput('/') // explicit search mode paints the search row
  panel.handleInput('ab')
  panel.render(100)
  // The search row is ' ' + the Input render (prompt stripped): the value
  // starts at row x=1, so value column 1 (between a and b) is at x=2.
  const result = panel.handleMouse(mouse('press', 2, 2, 100, 24))
  assert.ok(result?.handled, 'press on the search row must be handled')
  panel.handleInput('X')
  const rendered = panel.render(100).map(strip)
  assert.ok(rendered.some(line => line.includes('aXb')), 'typing after the click must insert at the clicked query column')
})

test('task panel: wheel moves the selection (mouse parity)', () => {
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob(), subagent()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false },
    () => {},
    () => {},
    () => {},
  )
  panel.render(100)
  const firstRow = 3 // header 0, blank 1, group 2, first item 3
  const down = panel.handleMouse(mouse('wheel', 10, firstRow, 100, 24, 1))
  assert.ok(down?.handled, 'wheel must be handled')
  const rendered = panel.render(100)
  const marked = rendered.findIndex(line => line.includes('→'))
  assert.ok(marked >= 0)
  assert.ok(rendered[marked]?.includes('bash · lint'), 'wheel down must move the selection to the second task')
})

test('task panel: async enrichment between press and click cannot transfer activation (mouse parity)', () => {
  const selected: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false },
    (value) => { selected.push(value) },
    () => {},
    () => {},
  )
  let rendered = panel.render(100)
  const row = rendered.findIndex(line => line.includes('bash · pnpm build'))
  assert.ok(row >= 0)
  panel.handleMouse(mouse('press', 10, row, 100, 24))
  // Async enrichment: a different job moves into the same physical row.
  panel.setItems([doneJob({ value: 'job:other', label: 'bash · other' })])
  rendered = panel.render(100)
  assert.ok(rendered.some(line => line.includes('bash · other')), 'the enriched row must be painted')
  panel.handleMouse(mouse('click', 10, row, 100, 24))
  assert.deepEqual(selected, [], 'activation must not transfer to the new item')
})

test('task panel: tiny-budget hit map never references omitted rows (mouse parity)', () => {
  const selected: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob(), subagent()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false },
    (value) => { selected.push(value) },
    () => {},
    () => {},
  )
  panel.setMaxRows(2)
  const rendered = panel.render(100)
  assert.ok(rendered.length <= 2, `tiny budget must cap rows: ${rendered.length}`)
  // The visible row is the selected main row: clicking it activates.
  const press = panel.handleMouse(mouse('press', 10, 0, 100, 2))
  assert.ok(press?.handled, 'the visible row must be clickable')
  panel.handleMouse(mouse('click', 10, 0, 100, 2))
  assert.deepEqual(selected, ['job:bash-1'], 'the visible row must activate the selected task')
  // Rows beyond the painted frame are not in the hit map.
  assert.equal(panel.handleMouse(mouse('press', 10, 5, 100, 2)), undefined, 'omitted rows must be inert')
})

test('task panel: delegated search press replaces the stale pressed value (mouse parity)', () => {
  const selected: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob(), doneJob(), subagent()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: true },
    (value) => { selected.push(value) },
    () => {},
    () => {},
  )
  panel.render(100)
  panel.handleInput('/') // explicit search mode paints the search row
  // Normal layout: search at row 2, item A (bash · lint) at row 7.
  const rowA = panel.render(100).findIndex(line => line.includes('bash · lint'))
  assert.ok(rowA >= 0, `item A row missing:\n${panel.render(100).join('\n')}`)
  // 1. Press item A: the gesture latch is A.
  panel.handleMouse(mouse('press', 10, rowA, 100, 24))
  // 2. Press the search row: the Input handles it (handled+focus), but
  //    the parent's gesture identity must be REPLACED — a delegated
  //    press is a fresh gesture, not a continuation of the item press.
  const searchPress = panel.handleMouse(mouse('press', 10, 2, 100, 24))
  assert.ok(searchPress?.handled, 'press on the search row must be handled')
  // 3. The terminal shrinks: the degraded layout moves item A (the
  //    selected row) onto the search row's old cell (row 2).
  panel.setMaxRows(4)
  const degraded = panel.render(100)
  assert.ok(degraded[2]?.includes('bash · lint'), `item A must move to row 2:\n${degraded.join('\n')}`)
  // 4. Release on the same physical cell: the synthesized click must
  //    NOT activate A — the stale latch was replaced by the search press.
  panel.handleMouse(mouse('click', 10, 2, 100, 4))
  assert.deepEqual(selected, [], 'the stale pressed value must not activate the moved item')
})

test('task panel: async enrichment WITHOUT a repaint between press and click cannot transfer activation (mouse parity)', () => {
  const selected: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false },
    (value) => { selected.push(value) },
    () => {},
    () => {},
  )
  const rendered = panel.render(100)
  const row = rendered.findIndex(line => line.includes('bash · pnpm build'))
  assert.ok(row >= 0)
  panel.handleMouse(mouse('press', 10, row, 100, 24))
  // Async enrichment WITHOUT a repaint: the hit map is still last-painted
  // geometry, but the CURRENT filtered list has a different item at the
  // same index. The click must resolve by the pressed VALUE, not the
  // stale index.
  panel.setItems([doneJob({ value: 'job:other', label: 'bash · other' })])
  panel.handleMouse(mouse('click', 10, row, 100, 24))
  assert.deepEqual(selected, [], 'activation must not transfer to the replacement at the stale index')
})

test('task panel: async enrichment WITHOUT a repaint between paint and press cannot select the replacement (mouse parity)', () => {
  const panel = new TaskBrowserPanel(
    [runningJob()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: false },
    () => {},
    () => {},
    () => {},
  )
  const rendered = panel.render(100)
  const row = rendered.findIndex(line => line.includes('bash · pnpm build'))
  assert.ok(row >= 0)
  // Async enrichment WITHOUT a repaint: the hit map is still last-painted
  // geometry, but the CURRENT filtered list has a different item at the
  // same index. The press must resolve by the pressed VALUE, not the
  // stale index.
  panel.setItems([doneJob({ value: 'job:other', label: 'bash · other' })])
  const press = panel.handleMouse(mouse('press', 10, row, 100, 24))
  assert.equal(press, undefined, 'a press on a row whose value no longer exists must be rejected')
})

test('task panel: a mouse press that changes selection cancels a pending stop confirmation (mouse parity)', () => {
  const stopped: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob({ value: 'job:a', label: 'first', canStop: true }), runningJob({ value: 'job:b', label: 'second', canStop: true })],
    24,
    { header: 'tasks', enableSearch: false, mode: 'full', mouseActionsEnabled: () => true, onStop: value => stopped.push(value) },
    () => {},
    () => {},
    () => {},
  )
  // S on the selected first job: pending stop on job:a.
  panel.handleInput('s')
  let rendered = panel.render(100)
  assert.ok(rendered.map(strip).join('\n').includes('Confirm stop [Y]'), `precondition — pending stop on the first job:\n${rendered.map(strip).join('\n')}`)
  // Mouse press on the second job: changing selection cancels the
  // pending destructive confirmation (mirror the keyboard navigation).
  const row = rendered.findIndex(line => line.includes('second'))
  assert.ok(row >= 0)
  panel.handleMouse(mouse('press', 10, row, 100, 24))
  // Y must NOT stop job:a (the confirmation was cancelled).
  panel.handleInput('y')
  assert.deepEqual(stopped, [], 'the cancelled confirmation must not stop the previously pending job')
})

test('task panel: a click cannot bypass a pending stop confirmation (mouse parity)', () => {
  const selected: string[] = []
  const panel = new TaskBrowserPanel(
    [runningJob({ value: 'job:a', label: 'first', canStop: true }), runningJob({ value: 'job:b', label: 'second', canStop: true })],
    24,
    { header: 'tasks', enableSearch: false, mode: 'full', mouseActionsEnabled: () => true },
    value => selected.push(value),
    () => {},
    () => {},
  )
  // S on the selected first job: pending stop on job:a.
  panel.handleInput('s')
  const rendered = panel.render(100)
  assert.ok(rendered.map(strip).join('\n').includes('Confirm stop [Y]'), 'precondition — pending stop on the first job')
  // Press + click on the SAME row (selection unchanged, pending kept):
  // the click must NOT bypass the confirmation and open the job.
  const row = rendered.findIndex(line => line.includes('first'))
  assert.ok(row >= 0)
  panel.handleMouse(mouse('press', 10, row, 100, 24))
  panel.handleMouse(mouse('click', 10, row, 100, 24))
  assert.deepEqual(selected, [], 'the click must not bypass the pending confirmation')
})

// --- single-physical-row containment (presentation boundary) ---

/** Every returned element is ONE physical terminal row: no embedded CR/LF
 * can escape the row budget, and nothing paints wider than the grant. */
function assertPhysicalRows(lines: readonly string[], width: number): void {
  for (const line of lines) {
    assert.equal(/[\r\n]/.test(line), false, `an embedded row break leaked into a row: ${JSON.stringify(line)}`)
    assert.ok(visibleWidth(line) <= width, `a row exceeds the grant (${visibleWidth(line)} > ${width}): ${JSON.stringify(line)}`)
  }
}

const multilineJob = (): TaskPanelItem => runningJob({
  label: "bash · set -e\necho 'build'\r\npnpm test",
})

test('Quick Tasks: a multiline job label stays ONE physical row and the raw item is untouched', () => {
  const item = multilineJob()
  const panel = new TaskBrowserPanel(
    [item],
    10,
    { mode: 'full' },
    () => {},
    () => {},
    () => {},
  )
  const lines = panel.render(100).map(strip)
  assertPhysicalRows(lines, 100)
  // The three command lines did not leak as extra terminal rows: the
  // collapsed projection carries them on the ONE main row instead.
  const joined = lines.join('\n')
  assert.ok(joined.includes("set -e echo 'build' pnpm test"), `the collapsed projection must stay visible:\n${joined}`)
  assert.ok(item.label.includes('\n'), 'the raw runtime label must keep its newlines (no data rewrite)')
  panel.dispose()
})

test('Full Task Center: a multiline job main row stays ONE physical row', () => {
  const panel = new TaskBrowserPanel(
    [multilineJob(), doneJob()],
    10,
    { mode: 'full', header: 'tasks · subagents' },
    () => {},
    () => {},
    () => {},
  )
  const lines = panel.render(100).map(strip)
  assertPhysicalRows(lines, 100)
  assert.ok(lines.join('\n').includes("set -e echo 'build' pnpm test"), 'the collapsed label must stay visible')
  panel.dispose()
})

test('Full Task Center detail: multiline label/detail project to single rows in BOTH layouts', () => {
  const item: TaskPanelItem = runningJob({
    label: 'job first\njob second',
    detail: 'detail first\r\ndetail second',
  })
  const panel = new TaskBrowserPanel(
    [item],
    10,
    { mode: 'full', header: 'tasks' },
    () => {},
    () => {},
    () => {},
  )
  // Wide width: the side detail pane renders detailLines rows.
  const wide = panel.render(120).map(strip)
  assertPhysicalRows(wide, 120)
  const wideJoined = wide.join('\n')
  assert.ok(wideJoined.includes('job first job second'), `wide pane must show the collapsed label:\n${wideJoined}`)
  assert.ok(wideJoined.includes('detail first detail second'), `wide pane must show the collapsed detail:\n${wideJoined}`)
  // Medium width: the compact inline detail under the selected row (it
  // carries label/status/elapsed — the full detail rows live in the wide
  // side pane above).
  const medium = panel.render(100).map(strip)
  assertPhysicalRows(medium, 100)
  const mediumJoined = medium.join('\n')
  assert.ok(mediumJoined.includes('job first job second'), `inline detail must show the collapsed label:\n${mediumJoined}`)
  assert.ok(mediumJoined.includes('job first job second · status'), `inline detail stays one collapsed row:\n${mediumJoined}`)
  // The raw domain text is never rewritten.
  assert.equal(item.label, 'job first\njob second')
  assert.equal(item.detail, 'detail first\r\ndetail second')
  panel.dispose()
})

test('multiline input respects the row budget: every painted row is one physical row', () => {
  const panel = new TaskBrowserPanel(
    [multilineJob(), doneJob(), runningJob({ value: 'job:c', label: 'bash · test' })],
    10,
    { mode: 'full', header: 'tasks' },
    () => {},
    () => {},
    () => {},
  )
  panel.setMaxRows(6)
  const lines = panel.render(100).map(strip)
  assertPhysicalRows(lines, 100)
  assert.ok(lines.length <= 6, `the multiline input must not break the row budget (${lines.length} > 6)`)
  panel.dispose()
})

test('caller-provided header and no-match text project to ONE physical row', () => {
  const panel = new TaskBrowserPanel(
    [runningJob()],
    10,
    { mode: 'full', header: 'Workflow · foo\nbar', enableSearch: true, noMatchText: 'nothing\nhere' },
    () => {},
    () => {},
    () => {},
  )
  // The header embeds caller/durable text (the Workflow scoped Task
  // Center passes run name + phase label) — it must not carry CR/LF past
  // the row budget.
  const lines = panel.render(100).map(strip)
  assertPhysicalRows(lines, 100)
  assert.ok(lines.some(line => line.includes('Workflow · foo bar')), `the collapsed header must render:\n${lines.join('\n')}`)
  // The no-match message is caller text on one row.
  panel.handleInput('/')
  for (const key of 'zz') panel.handleInput(key)
  const noMatch = panel.render(100).map(strip)
  assertPhysicalRows(noMatch, 100)
  assert.ok(noMatch.some(line => line.includes('nothing here')), `the collapsed no-match text must render:\n${noMatch.join('\n')}`)
  // Narrow grants: a LONG no-match message is also width-truncated (the
  // same one-row contract as the refresh-error banner). The Task Center hint
  // has separate rendered-row width and Esc-order coverage above.
  const longPanel = new TaskBrowserPanel(
    [],
    10,
    { mode: 'full', enableSearch: true, noMatchText: `nothing here${' padding'.repeat(6)}\nend` },
    () => {},
    () => {},
    () => {},
  )
  for (const narrowWidth of [20, 30]) {
    const narrow = longPanel.render(narrowWidth).map(strip)
    const noMatchRows = narrow.filter(line => line.includes('nothing'))
    assert.ok(noMatchRows.length >= 1, `width ${narrowWidth}: the truncated no-match row must stay visible:\n${narrow.join('\n')}`)
    for (const line of noMatchRows) {
      assert.equal(/[\r\n]/.test(line), false, `width ${narrowWidth}: the no-match row must be one physical row: ${JSON.stringify(line)}`)
      assert.ok(visibleWidth(line) <= narrowWidth, `width ${narrowWidth}: the no-match row must fit the grant (${visibleWidth(line)} > ${narrowWidth}): ${JSON.stringify(line)}`)
    }
  }
  longPanel.dispose()
  panel.dispose()
})

test('a multiline refresh error stays ONE physical row', () => {
  const panel = new TaskBrowserPanel(
    [multilineJob()],
    10,
    { mode: 'full', header: 'tasks' },
    () => {},
    () => {},
    () => {},
  )
  panel.setRefreshState('stale', 'fetch failed\nretry later\nEOF')
  const lines = panel.render(100).map(strip)
  assertPhysicalRows(lines, 100)
  assert.ok(lines.join('\n').includes('fetch failed retry later EOF'), 'the collapsed error must stay visible')
  assert.ok(lines.length <= 12, 'the banner must stay a single row')
  // Narrow grant: the banner is also WIDTH-truncated — a long dynamic
  // error must not wrap into extra terminal rows in a direct embedding.
  // The Task Center hint has separate rendered-row width and Esc-order coverage.
  const narrow = panel.render(20).map(strip)
  const banner = narrow.filter(line => line.includes('fetch failed'))
  assert.ok(banner.length >= 1, `the truncated banner must stay visible:\n${narrow.join('\n')}`)
  for (const line of banner) {
    assert.equal(/[\r\n]/.test(line), false, `the banner must be one physical row: ${JSON.stringify(line)}`)
    assert.ok(visibleWidth(line) <= 20, `the banner must fit the narrow grant (${visibleWidth(line)} > 20): ${JSON.stringify(line)}`)
  }
  panel.dispose()
})

const questionRow = (overrides: Partial<TaskPanelItem> = {}): TaskPanelItem => ({
  value: 'question:session-a:call-1',
  label: 'Use staging or production?',
  status: 'awaiting answer',
  group: 'Needs attention',
  source: 'question',
  canOpen: true,
  canStop: false,
  ...overrides,
})

test('the Full Task Center shows a parked Question in Needs attention ABOVE active work', () => {
  const panel = new TaskBrowserPanel(
    [questionRow(), runningJob(), subagent()],
    10,
    { mode: 'full', header: 'tasks' },
    () => {},
    () => {},
    () => {},
  )
  const lines = panel.render(100).map(strip)
  const joined = lines.join('\n')
  assert.ok(joined.includes('Needs attention'), `the attention group renders:\n${joined}`)
  const question = lines.find(line => line.includes('Use staging or production?'))
  assert.ok(question?.includes('‣ Awaiting answer'), `the Question row uses the shared status group:\n${joined}`)
  assert.ok(!question?.includes('? Use staging or production?'), `the old Question glyph is retired:\n${joined}`)
  assert.ok(
    joined.indexOf('Needs attention') < joined.indexOf('jobs') || !joined.includes('jobs'),
    'attention precedes the work groups',
  )
})

test('a pending Question stays visible in the Full Task Center with running work', () => {
  // The generic failure-attention rule only includes inactive rows when there
  // is NO live work; a human-required Question must not depend on that.
  const panel = new TaskBrowserPanel(
    [questionRow(), runningJob()],
    10,
    { mode: 'full', header: 'tasks' },
    () => {},
    () => {},
    () => {},
  )
  const joined = panel.render(100).map(strip).join('\n')
  assert.ok(joined.includes('Use staging or production?'), `the Question survives active work:\n${joined}`)
  assert.ok(joined.includes('bash · pnpm build'), 'and the active work is still listed')
})

test('a visible Question is answering, and Question rows are searchable', () => {
  const panel = new TaskBrowserPanel(
    [questionRow({ status: 'answering' }), runningJob()],
    10,
    { mode: 'full', header: 'tasks', enableSearch: true, noMatchText: 'no matches' },
    () => {},
    () => {},
    () => {},
  )
  const joined = panel.render(100).map(strip).join('\n')
  assert.ok(joined.includes('‣ Answering'), `Full renders the Title Case answering status group:\n${joined}`)

  panel.handleInput('/')
  for (const char of 'staging') panel.handleInput(char)
  const searched = panel.render(100).map(strip).join('\n')
  assert.ok(searched.includes('Use staging or production?'), `search finds the Question row:\n${searched}`)
  assert.ok(!searched.includes('bash · pnpm build'), 'and filters the non-matching work out')
})

test('Question rows never expose a stop affordance', () => {
  const stopped: string[] = []
  const panel = new TaskBrowserPanel(
    [questionRow()],
    10,
    { mode: 'full', header: 'tasks' },
    (value) => { stopped.push(value) },
    () => {},
    () => {},
  )
  // `s` is the (Job-only) stop key; a Question row must not raise a stop
  // request for it (the row carries `canStop: false`, and the surface's stop
  // path only addresses work rows in any case).
  panel.handleInput('s')
  assert.deepEqual(stopped, [], 'no stop request is issued for a Question row')
  const row = questionRow()
  assert.equal(row.canStop, false)
  assert.equal(row.source, 'question')
})

// ── FR2: Work/Team dual page + explicit type filter state machine ──────────

const teamTask = (overrides: Partial<TeamBoardTask> = {}): TeamBoardTask => ({
  id: 'task-1', revision: 1, subject: 'Implement adapter', description: 'a read-only board',
  status: 'in_progress', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [],
  ...overrides,
})
const member = (id: string, name: string, activity: TeamMemberPresentation['activity'] = 'running', kind: TeamMemberPresentation['kind'] = 'subagent', depth = 1): TeamMemberPresentation =>
  ({ value: `member:${id}`, id, name, activity, kind, depth })
const readyTeam = (tasks: TeamBoardTask[], enabled = true): TeamBrowserPresentation =>
  ({ snapshot: { kind: 'ready', enabled, tasks }, members: [member('s-root', 'lead', 'running', 'root', 0)] })
const teamDto = (snapshot: TeamBoardSnapshot, members: TeamMemberPresentation[]): TeamBrowserPresentation => ({ snapshot, members })

test('FR2: Tab switches Work↔Team and each page keeps its own state', () => {
  const { panel, rendered } = makePanel(
    [subagent(), runningJob()],
    { enableSearch: true, team: readyTeam([teamTask()]) },
  )
  const work = rendered().map(strip).join('\n')
  assert.ok(work.includes('[Work]') && work.includes('subagent · research'), `Work page header + rows:\n${work}`)
  panel.handleInput('\t')
  const team = rendered().map(strip).join('\n')
  assert.ok(team.includes('[Team]'), `Team page tab:\n${team}`)
  assert.ok(team.includes('Members') && team.includes('lead') && team.includes('Implement adapter'), `Team page members + tasks:\n${team}`)
  panel.handleInput('\x1b[Z') // Shift+Tab back
  assert.ok(rendered().map(strip).join('\n').includes('subagent · research'), 'Work page state survives the round trip')
  panel.dispose()
})

test('FR2: Tab does nothing without a Team page (Work-only), and s/a/f are inert on the Team page', () => {
  const workOnly = makePanel([subagent()], { enableSearch: true })
  workOnly.panel.handleInput('\t')
  assert.ok(!workOnly.rendered().map(strip).join('\n').includes('[Team]'), 'no Team tab without a Team DTO')
  workOnly.panel.dispose()

  const { panel, rendered } = makePanel([subagent()], { enableSearch: true, team: readyTeam([teamTask()]) })
  panel.handleInput('\t') // Team
  const before = rendered().map(strip).join('\n')
  for (const key of ['f', 'a', 's']) panel.handleInput(key)
  const after = rendered().map(strip).join('\n')
  assert.ok(!after.includes('Type filter'), 'f must not open the Work type filter on the Team page')
  assert.equal(after, before, 's/a/f must have no effect on the Team page')
  panel.dispose()
})

test('FR2: a pending Work Stop forbids the Tab page switch', () => {
  const { panel, rendered } = makePanel([subagent()], { enableSearch: true, team: readyTeam([teamTask()]) })
  panel.handleInput('s') // request Stop on the stoppable subagent
  assert.ok(rendered().map(strip).join('\n').includes('Confirm stop'), 'precondition — Stop is pending')
  panel.handleInput('\t')
  const stillWork = rendered().map(strip).join('\n')
  assert.ok(stillWork.includes('Confirm stop'), 'a pending Stop keeps the Work page')
  assert.ok(!stillWork.includes('Members'), 'Tab must not switch pages while a Stop is pending')
  panel.dispose()
})

test('FR2: Enter on a Team task toggles its single disclosure; a member row has no write', () => {
  const { panel, rendered } = makePanel([], {
    enableSearch: true,
    team: teamDto({ kind: 'ready', enabled: true, tasks: [teamTask({ subject: 'Ship it', status: 'completed' })] }, []),
  })
  panel.handleInput('\t') // Team page; the only selectable row is the task
  const before = rendered().map(strip).join('\n')
  assert.ok(before.includes('Ship it') && !before.includes('desc: a read-only board'), `not expanded yet:\n${before}`)
  panel.handleInput('\r')
  const after = rendered().map(strip).join('\n')
  assert.ok(after.includes('desc: a read-only board'), `Enter expands the task detail:\n${after}`)
  panel.handleInput('\r')
  assert.ok(!rendered().map(strip).join('\n').includes('desc: a read-only board'), 'Enter again collapses it')
  panel.dispose()
})

test('FR2: Team OFF shows the enable hint with retained tasks; stale/unavailable are explicit; empty ready is honest', () => {
  const off = makePanel([], { enableSearch: true, team: readyTeam([teamTask({ subject: 'Retained task', status: 'pending', ready: true })], false) })
  off.panel.handleInput('\t')
  const offView = off.rendered().map(strip).join('\n')
  assert.ok(offView.includes('Team is Off'), `OFF hint:\n${offView}`)
  assert.ok(offView.includes('Retained task'), `retained tasks still show:\n${offView}`)
  assert.ok(!offView.includes('No shared tasks'), `OFF is not an empty board:\n${offView}`)
  off.panel.dispose()

  const stale = makePanel([], { enableSearch: true, team: teamDto({ kind: 'stale', reason: 'the Host connection is not ready' }, []) })
  stale.panel.handleInput('\t')
  const staleView = stale.rendered().map(strip).join('\n')
  assert.ok(staleView.includes('stale: the Host connection is not ready'), `stale reason:\n${staleView}`)
  assert.ok(!staleView.includes('No shared tasks'), `stale is never fabricated empty:\n${staleView}`)
  stale.panel.dispose()

  const empty = makePanel([], { enableSearch: true, team: teamDto({ kind: 'ready', enabled: true, tasks: [] }, []) })
  empty.panel.handleInput('\t')
  assert.ok(empty.rendered().map(strip).join('\n').includes('No shared tasks'), 'a ready empty board is honest')
  empty.panel.dispose()
})

test('FR2: each page keeps its own search draft across a Tab round trip', () => {
  const { panel, rendered } = makePanel(
    [subagent(), runningJob()],
    { enableSearch: true, team: readyTeam([teamTask({ subject: 'review contract' })]) },
  )
  // Work query 'bu' (matches the build job only).
  panel.handleInput('/'); panel.handleInput('b'); panel.handleInput('u')
  assert.equal(panel.getFilter(), 'bu')
  panel.handleInput('\t') // Team, Work query preserved
  // Team query 'review'.
  panel.handleInput('/'); panel.handleInput('r'); panel.handleInput('e'); panel.handleInput('v')
  assert.ok(rendered().map(strip).join('\n').includes('rev'), 'the Team search row shows its draft')
  panel.handleInput('\x1b[Z') // back to Work
  assert.equal(panel.getFilter(), 'bu', 'the Work query is preserved, never appended with Team text')
  panel.handleInput('\t') // back to Team
  assert.ok(rendered().map(strip).join('\n').includes('rev'), 'the Team draft is preserved across the round trip')
  panel.dispose()
})

test('FR2: a Team task row is never a Work Open/Stop route; a member Enter is inert', () => {
  let opens = 0
  const panel = new TaskBrowserPanel(
    [],
    10,
    { mode: 'full', enableSearch: true, header: 'Tasks', team: readyTeam([teamTask({ id: 't1', subject: 'Only task' })]) },
    () => { opens += 1 },
    () => {},
    () => {},
  )
  panel.handleInput('\t') // Team
  panel.handleInput('\x1b[B') // onto the task (after the lead member)
  panel.handleInput('\r') // toggle disclosure, NOT onSelect
  assert.equal(opens, 0, 'Enter on a Team task never opens a Work row')
  panel.handleInput('\x1b[A') // back onto the lead member
  panel.handleInput('\r') // member Enter is inert
  assert.equal(opens, 0, 'Enter on a Team member never opens anything')
  panel.dispose()
})

test('FR2: at 88 columns Enter reveals description/blockedBy/scopes/warnings inline', () => {
  const task = teamTask({
    subject: 'Ship', status: 'pending', ready: false, description: 'the detail line',
    blockedBy: ['task-0'], writeScopes: ['src/x'], writeScopeWarnings: ['overlap with task-9'],
  })
  const { panel } = makePanel([], { enableSearch: true, team: teamDto({ kind: 'ready', enabled: true, tasks: [task] }, []) })
  panel.handleInput('\t')
  panel.handleInput('\r')
  const frame = panel.render(88).map(strip).join('\n')
  assert.ok(frame.includes('desc: the detail line'), `description reachable at 88:\n${frame}`)
  assert.ok(frame.includes('blocked by: task-0'), `blockedBy reachable at 88:\n${frame}`)
  assert.ok(frame.includes('scopes: src/x'), `writeScopes reachable at 88:\n${frame}`)
  assert.ok(frame.includes('warning: overlap with task-9'), `writeScopeWarnings reachable at 88:\n${frame}`)
  // A 44x8 grant may degrade the detail lines away, but must keep the selected
  // row reachable and an exit hint.
  panel.setMaxRows(8)
  const tiny = panel.render(44).map(strip).join('\n')
  assert.ok(tiny.includes('Ship') || tiny.includes('Close'), `44x8 keeps the selected row or close:\n${tiny}`)
  panel.dispose()
})

// ── External review: Team mouse, pending-Stop tab, short-screen selection ──

function headerColOf(frame: string[], label: string): number {
  const header = strip(frame[0] ?? '')
  const col = header.indexOf(label)
  assert.ok(col >= 0, `header must contain ${label}: ${header}`)
  return col + 1 // inside the label (not its first cell edge)
}

test('FR2-ext1: a real press→release on a Team task expands it (mouse parity)', () => {
  const task = teamTask({ subject: 'Ship it', description: 'detail-line-x', status: 'pending', ready: true })
  const { panel } = makePanel([], {
    enableSearch: true,
    header: 'Tasks',
    team: teamDto({ kind: 'ready', enabled: true, tasks: [task] }, []),
    interactionCurrent: () => true,
  })
  const W = 100
  panel.handleInput('\t') // Team
  const y = panel.render(W).map(strip).findIndex(line => line.includes('Ship it'))
  assert.ok(y >= 0)
  panel.handleMouse(mouse('press', 1, y, W))
  panel.handleMouse(mouse('click', 1, y, W))
  assert.ok(panel.render(W).map(strip).join('\n').includes('desc: detail-line-x'),
    'press→release on the task row must expand its details')
  panel.dispose()
})

test('FR2-ext1: a release on a DIFFERENT row (or after the row moved) never expands', () => {
  const a = teamTask({ id: 't-a', subject: 'Alpha task', description: 'alpha-desc' })
  const b = teamTask({ id: 't-b', subject: 'Beta task', description: 'beta-desc' })
  const { panel } = makePanel([], {
    enableSearch: true, header: 'Tasks',
    team: teamDto({ kind: 'ready', enabled: true, tasks: [a, b] }, []),
    interactionCurrent: () => true,
  })
  const W = 100
  panel.handleInput('\t') // Team
  const frame = panel.render(W).map(strip)
  const ya = frame.findIndex(line => line.includes('Alpha task'))
  const yb = frame.findIndex(line => line.includes('Beta task'))
  assert.ok(ya >= 0 && yb >= 0 && ya !== yb)
  panel.handleMouse(mouse('press', 1, ya, W))
  panel.handleMouse(mouse('click', 1, yb, W)) // cross-row release
  assert.ok(!panel.render(W).map(strip).join('\n').includes('desc:'),
    'a cross-row release must not expand any task')
  panel.dispose()
})

test('FR2-ext2: a pending Work Stop forbids the MOUSE Tab switch (not just keyboard)', () => {
  const { panel } = makePanel([subagent()], { enableSearch: true, header: 'Tasks', team: readyTeam([teamTask()]), interactionCurrent: () => true })
  const W = 100
  panel.render(W)
  panel.handleInput('s') // arm Stop on the stoppable subagent
  assert.ok(panel.render(W).map(strip).join('\n').includes('Confirm stop'), 'precondition — Stop pending')
  const before = panel.render(W)
  const x = headerColOf(before, 'Team')
  panel.handleMouse(mouse('press', x, 0, W))
  panel.handleMouse(mouse('click', x, 0, W))
  const after = panel.render(W).map(strip).join('\n')
  assert.ok(after.includes('Confirm stop'), 'the pending Stop survives the mouse Tab attempt')
  assert.ok(!after.includes('Members'), 'a mouse Tab must not switch pages while a Stop is pending')
  // Once cancelled, the same mouse Tab does switch.
  panel.handleInput('\x1b') // cancel pending stop
  panel.render(W)
  panel.handleMouse(mouse('press', x, 0, W))
  panel.handleMouse(mouse('click', x, 0, W))
  assert.ok(panel.render(W).map(strip).join('\n').includes('Members'), 'after cancel, mouse Tab switches to Team')
  panel.dispose()
})

test('FR2-ext2: the mouse Tab only hits the painted label, not the whole header row', () => {
  const { panel } = makePanel([], { enableSearch: true, header: 'Tasks', team: readyTeam([teamTask()]), interactionCurrent: () => true })
  const W = 100
  const frame = panel.render(W)
  const x = headerColOf(frame, 'Team')
  // A press far to the RIGHT of the Team label (in the stats area) is NOT a tab.
  panel.handleMouse(mouse('press', W - 2, 0, W))
  panel.handleMouse(mouse('click', W - 2, 0, W))
  assert.ok(!panel.render(W).map(strip).join('\n').includes('Members'), 'the stats area is inert')
  // The real label column does switch.
  panel.handleMouse(mouse('press', x, 0, W))
  panel.handleMouse(mouse('click', x, 0, W))
  assert.ok(panel.render(W).map(strip).join('\n').includes('Members'), 'the painted Team label switches')
  panel.dispose()
})

test('FR2-ext3: on a short grant the SELECTED Team row stays visible (search + many members)', () => {
  const members = [
    member('s-root', 'lead', 'running', 'root', 0),
    member('m-1', 'alpha', 'inactive'),
    member('m-2', 'beta', 'inactive'),
    member('m-3', 'gamma', 'inactive'),
  ]
  const { panel } = makePanel([], { enableSearch: true, header: 'Tasks', team: teamDto({ kind: 'ready', enabled: true, tasks: [] }, members), interactionCurrent: () => true })
  panel.handleInput('\t') // Team
  panel.setMaxRows(8)
  panel.handleInput('/') // team search mode, empty query
  for (let i = 0; i < 3; i += 1) panel.handleInput(DOWN) // select the 4th member (gamma)
  const frame = panel.render(44).map(strip)
  const selected = frame.find(line => line.includes('gamma'))
  assert.ok(selected !== undefined, `the selected member must be painted:\n${frame.join('\n')}`)
  assert.ok(selected!.includes('→'), `the selected marker must be on gamma:\n${selected}`)
  assert.ok(frame.join('\n').includes('Back [Esc]'), 'the exit hint stays')
  panel.dispose()
})

test('FR2-ext3: on a short grant a selected TASK across the group boundary stays visible', () => {
  const members = [member('s-root', 'lead', 'running', 'root', 0), member('m-1', 'alpha', 'inactive')]
  const tasks = [teamTask({ id: 't-a', subject: 'Alpha task' }), teamTask({ id: 't-b', subject: 'Beta task' })]
  const { panel } = makePanel([], { enableSearch: true, header: 'Tasks', team: teamDto({ kind: 'ready', enabled: true, tasks }, members), interactionCurrent: () => true })
  panel.handleInput('\t') // Team
  panel.setMaxRows(8)
  for (let i = 0; i < 3; i += 1) panel.handleInput(DOWN) // lead,alpha,Alpha→Beta item index 3
  const frame = panel.render(44).map(strip)
  const selected = frame.find(line => line.includes('Beta task'))
  assert.ok(selected !== undefined, `the selected task must be painted:\n${frame.join('\n')}`)
  assert.ok(selected!.includes('→'), `the selected marker must be on the Beta task:\n${selected}`)
  panel.dispose()
})

test('FR2-ext4: wheel (button none) moves the Team selection and the filter cursor', () => {
  const members = [member('s-root', 'lead', 'running', 'root', 0), member('m-1', 'alpha', 'inactive'), member('m-2', 'beta', 'inactive')]
  const W = 100
  const team = makePanel([], { enableSearch: true, header: 'Tasks', team: teamDto({ kind: 'ready', enabled: true, tasks: [] }, members), interactionCurrent: () => true })
  team.panel.handleInput('\t') // Team
  const ty = team.panel.render(W).map(strip).findIndex(line => line.includes('alpha'))
  assert.ok(ty >= 0)
  team.panel.handleMouse(mouse('wheel', 1, ty, W, 24, 1, 'none'))
  const afterTeam = team.panel.render(W).map(strip)
  const alphaLine = afterTeam.find(line => line.includes('alpha'))!
  assert.ok(alphaLine.includes('→'), `wheel must move the Team selection to alpha:\n${afterTeam.join('\n')}`)
  team.panel.dispose()

  const filter = makePanel([typed(runningJob(), 'bash'), typed(subagent(), 'subagent')], { enableSearch: true, header: 'Tasks', interactionCurrent: () => true })
  filter.panel.handleInput('f')
  const fy = filter.panel.render(W).map(strip).findIndex(line => line.includes('All'))
  assert.ok(fy >= 0)
  filter.panel.handleMouse(mouse('wheel', 1, fy, W, 24, 1, 'none'))
  const afterFilter = filter.panel.render(W).map(strip)
  const bashRow = afterFilter.find(line => line.includes('bash'))!
  assert.ok(bashRow.includes('>'), `wheel must move the filter cursor:\n${afterFilter.join('\n')}`)
  filter.panel.dispose()
})

test('FR2-ext5: a hostile Job.kind type name stays one safe, truncated physical row at 44 columns', () => {
  const longType = `super-long-custom-kind-${'x'.repeat(80)}\u001b[31mRED\u001b[0m\r\nINJECT中文类型`
  const { panel } = makePanel([typed(runningJob(), longType)], { enableSearch: true, header: 'Tasks' })
  panel.handleInput('f')
  const lines = panel.render(44)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 44, `no filter row may exceed 44 cells: ${JSON.stringify(line)} (${visibleWidth(line)})`)
    assert.ok(!line.includes('\r') && !line.includes('\n'), 'no control newline may enter a painted row')
  }
  // The candidate row is a single truncated physical line.
  assert.ok(lines.some(line => strip(line).includes('…')), `the long type must truncate:\n${lines.map(strip).join('\n')}`)
  panel.dispose()
})

test('FR2-ext6: applying the Work type filter by mouse uses the PRESSED identity, never a re-indexed row', () => {
  const W = 100
  const { panel } = makePanel([typed(runningJob(), 'bash'), typed(subagent(), 'subagent')], { enableSearch: true, header: 'Tasks', interactionCurrent: () => true })
  panel.handleInput('f')
  const yBash = panel.render(W).map(strip).findIndex(line => line.includes('bash'))
  assert.ok(yBash >= 0)
  panel.handleMouse(mouse('press', 1, yBash, W))
  // The candidate set/order changes between press and release.
  panel.setItems([typed(subagent(), 'subagent'), typed(runningJob(), 'bash')])
  panel.render(W)
  panel.handleMouse(mouse('click', 1, yBash, W)) // same physical row now means a DIFFERENT type
  assert.equal(panel.getViewState().typeFilter, null, 'a re-indexed release must not submit a wrong type')
  assert.ok(panel.render(W).map(strip).join('\n').includes('Type filter'), 'the list stays open (no wrong commit)')
  panel.dispose()
})

test('FR2-ext6: a click with no preceding press never applies a filter; a matching press→release does', () => {
  const W = 100
  const { panel } = makePanel([typed(runningJob(), 'bash'), typed(subagent(), 'subagent')], { enableSearch: true, header: 'Tasks', interactionCurrent: () => true })
  panel.handleInput('f')
  panel.render(W)
  const yBash = panel.render(W).map(strip).findIndex(line => line.includes('bash'))
  panel.handleMouse(mouse('click', 1, yBash, W)) // no press
  assert.equal(panel.getViewState().typeFilter, null, 'a bare click must not apply a filter')
  // A real press→release on the same painted row applies it.
  panel.handleMouse(mouse('press', 1, yBash, W))
  panel.handleMouse(mouse('click', 1, yBash, W))
  assert.equal(panel.getViewState().typeFilter, 'bash', 'a matching press→release applies the pressed type')
  panel.dispose()
})

test('FR2-ext3b: an EXPANDED lower task stays selected on a very short narrow grant', () => {
  const members = [member('s-root', 'lead', 'running', 'root', 0), member('m-1', 'alpha', 'inactive'), member('m-2', 'beta', 'inactive')]
  const tasks = [teamTask({ id: 't-1', subject: 'Task One' }), teamTask({ id: 't-2', subject: 'Task Two', description: 'detail-two' })]
  const { panel } = makePanel([], { enableSearch: true, header: 'Tasks', team: teamDto({ kind: 'ready', enabled: true, tasks }, members), interactionCurrent: () => true })
  panel.handleInput('\t') // Team
  panel.setMaxRows(9)
  for (let i = 0; i < 4; i += 1) panel.handleInput(DOWN) // lead,alpha,beta,Task One,Task Two
  panel.render(44)
  panel.handleInput('\r') // expand Task Two (adds inline detail lines, forcing a fit shrink)
  panel.setMaxRows(8)
  const frame = panel.render(44).map(strip)
  const selected = frame.find(line => line.includes('Task Two'))
  assert.ok(selected !== undefined, `the expanded selected task must still be painted:\n${frame.join('\n')}`)
  assert.ok(selected!.includes('→'), `the selected marker must stay on Task Two:\n${selected}`)
  assert.ok(frame.join('\n').includes('Close [Esc]'), 'the exit hint stays')
  panel.dispose()
})

test('FR2-ext4b: a stale panel (interactionCurrent=false) ignores Team and filter wheel', () => {
  const W = 100
  let alive = true
  const members = [member('s-root', 'lead', 'running', 'root', 0), member('m-1', 'alpha', 'inactive'), member('m-2', 'beta', 'inactive')]
  const team = makePanel([], { enableSearch: true, header: 'Tasks', team: teamDto({ kind: 'ready', enabled: true, tasks: [] }, members), interactionCurrent: () => alive })
  team.panel.handleInput('\t')
  const ty = team.panel.render(W).map(strip).findIndex(line => line.includes('alpha'))
  alive = false
  team.panel.handleMouse(mouse('wheel', 1, ty, W, 24, 1, 'none'))
  alive = true
  const leadLine = team.panel.render(W).map(strip).find(line => line.includes('lead'))!
  assert.ok(leadLine.includes('→'), 'a stale wheel must not move the Team selection')
  team.panel.dispose()

  let aliveF = true
  const filter = makePanel([typed(runningJob(), 'bash'), typed(subagent(), 'subagent')], { enableSearch: true, header: 'Tasks', interactionCurrent: () => aliveF })
  filter.panel.handleInput('f')
  const fy = filter.panel.render(W).map(strip).findIndex(line => line.includes('All'))
  aliveF = false
  filter.panel.handleMouse(mouse('wheel', 1, fy, W, 24, 1, 'none'))
  aliveF = true
  const allRow = filter.panel.render(W).map(strip).find(line => line.includes('All'))!
  assert.ok(allRow.includes('>'), 'a stale wheel must not move the filter cursor')
  filter.panel.dispose()
})

test('FR2-ext-r3-F1: a Work-only panel applies the type filter by mouse (fence supplied)', () => {
  const W = 100
  const { panel } = makePanel([typed(runningJob(), 'bash'), typed(subagent(), 'subagent')], { enableSearch: true, header: 'Tasks', interactionCurrent: () => true })
  panel.handleInput('f')
  const y = panel.render(W).map(strip).findIndex(line => line.includes('bash'))
  assert.ok(y >= 0)
  panel.handleMouse(mouse('press', 1, y, W))
  panel.handleMouse(mouse('click', 1, y, W))
  assert.equal(panel.getViewState().typeFilter, 'bash', 'the Work-only filter applies the pressed type by mouse')
  panel.dispose()
})

test('FR2-ext-r3-F2: at 120 columns the Team right detail pane is inert', () => {
  const W = 120
  const tasks = [teamTask({ id: 't-a', subject: 'Alpha task' }), teamTask({ id: 't-b', subject: 'Beta task' })]
  const { panel } = makePanel([], { enableSearch: true, header: 'Tasks', team: teamDto({ kind: 'ready', enabled: true, tasks }, []), interactionCurrent: () => true })
  panel.handleInput('\t') // Team
  const frame = panel.render(W).map(strip)
  const yBeta = frame.findIndex(line => line.includes('Beta task'))
  assert.ok(yBeta >= 0)
  // The right detail pane (x well past listWidth) must NOT select/activate the row.
  panel.handleMouse(mouse('press', W - 2, yBeta, W))
  panel.handleMouse(mouse('click', W - 2, yBeta, W))
  const afterDetail = panel.render(W).map(strip)
  assert.ok(afterDetail.some(line => line.includes('→') && line.includes('Alpha task')), 'the detail-pane click must not move the selection')
  // The left list cell of the same row does select it.
  panel.handleMouse(mouse('press', 2, yBeta, W))
  panel.handleMouse(mouse('click', 2, yBeta, W))
  assert.ok(panel.render(W).map(strip).some(line => line.includes('→') && line.includes('Beta task')), 'the left list cell selects the row')
  panel.dispose()
})

test('FR2-ext-r3-F3: setTeamPage(undefined) revokes the Team page back to Work-only', () => {
  const { panel } = makePanel([subagent()], { enableSearch: true, header: 'Tasks', team: readyTeam([teamTask()]), interactionCurrent: () => true })
  panel.handleInput('\t') // Team
  assert.ok(panel.render(100).map(strip).join('\n').includes('Members'), 'precondition — Team page shown')
  panel.setTeamPage(undefined)
  const frame = panel.render(100).map(strip).join('\n')
  assert.ok(!frame.includes('[Team]') && !frame.includes('Members'), 'the Team page is revoked')
  assert.ok(frame.includes('subagent · research'), 'the Work page is shown')
  panel.dispose()
})

test('FR2-ext-r3-F4: a real Job type named __all__ is selectable by mouse (no All collision)', () => {
  const W = 100
  const { panel } = makePanel([typed(runningJob(), '__all__')], { enableSearch: true, header: 'Tasks', interactionCurrent: () => true })
  panel.handleInput('f')
  const y = panel.render(W).map(strip).findIndex(line => line.includes('__all__'))
  assert.ok(y >= 0)
  panel.handleMouse(mouse('press', 1, y, W))
  panel.handleMouse(mouse('click', 1, y, W))
  assert.equal(panel.getViewState().typeFilter, '__all__', 'the __all__ type must apply as the type, not as All')
  panel.dispose()
})

test('FR2-ext-r4: press → REAL render → release still selects/expands a long Team list row', () => {
  const members = [member('s-root', 'lead', 'running', 'root', 0)]
  for (let i = 1; i <= 9; i += 1) members.push(member(`m-${i}`, `agent-${i}`, 'inactive'))
  const W = 60
  const { panel } = makePanel([], { enableSearch: true, header: 'Tasks', team: teamDto({ kind: 'ready', enabled: true, tasks: [] }, members), interactionCurrent: () => true })
  panel.handleInput('\t') // Team
  panel.setMaxRows(12) // budget 7 → a press-driven recenter would move the clicked row
  const frame = panel.render(W).map(strip)
  const y = frame.findIndex(line => line.includes('agent-5'))
  assert.ok(y >= 0, `agent-5 must be visible:\n${frame.join('\n')}`)
  panel.handleMouse(mouse('press', 1, y, W, 12))
  panel.render(W) // the real press-triggered repaint
  panel.handleMouse(mouse('click', 1, y, W, 12))
  const after = panel.render(W).map(strip)
  assert.ok(after.some(line => line.includes('→') && line.includes('agent-5')),
    `press→render→release must select the pressed row, not a repositioned one:\n${after.join('\n')}`)
  panel.dispose()
})

test('FR2-ext-r4: press → REAL render → release applies a short-screen filter type', () => {
  const items: TaskPanelItem[] = []
  for (let i = 0; i < 8; i += 1) items.push(typed(runningJob({ value: `job:${i}`, label: `job ${i}` }), `t${i}`))
  const W = 60
  const { panel } = makePanel(items, { enableSearch: true, header: 'Tasks', interactionCurrent: () => true })
  panel.setMaxRows(9) // budget 4 → All,t0,t1,t2 visible while the list still scrolls
  panel.handleInput('f')
  const frame = panel.render(W).map(strip)
  const y = frame.findIndex(line => line.includes('t2'))
  assert.ok(y >= 0, `t2 must be visible before press:\n${frame.join('\n')}`)
  panel.handleMouse(mouse('press', 1, y, W, 9))
  panel.render(W) // the real press-triggered repaint
  panel.handleMouse(mouse('click', 1, y, W, 9))
  assert.equal(panel.getViewState().typeFilter, 't2', 'press→render→release must apply the pressed type')
  panel.dispose()
})

test('FR2-r5-P3: the Team hint advertises Enter details only where it has a visible effect', () => {
  const { panel } = makePanel([], { enableSearch: true, header: 'Tasks', team: readyTeam([teamTask()]), interactionCurrent: () => true })
  panel.handleInput('\t') // Team
  const narrow = panel.render(100).map(strip).join('\n')
  assert.ok(narrow.includes('Enter details'), `narrow layout expands inline details on Enter:\n${narrow}`)
  const wide = panel.render(120).map(strip).join('\n')
  assert.ok(!wide.includes('Enter details'), `wide layout always shows the detail pane, so Enter is not advertised:\n${wide}`)
  assert.ok(wide.includes('Close [Esc]'), 'the exit hint remains')
  panel.dispose()
})

test('B2: an invalidation revokes an armed Action Bar press until the next paint', () => {
  const { panel, closes } = makeExitPanel([runningJob()])
  const frame = panel.render(100).map(strip)
  const hintRow = frame.findLastIndex(line => line.includes('Close [Esc]'))
  const closeCol = frame[hintRow]!.indexOf('Close [Esc]')
  assert.ok(panel.handleMouse(mouse('press', closeCol, hintRow, 100, 24))?.handled)
  panel.invalidate()
  assert.equal(panel.handleMouse(mouse('click', closeCol, hintRow, 100, 24)), undefined,
    'a press from the invalidated frame can never complete before the next paint')
  assert.equal(closes.length, 0, 'the invalidated gesture never closes the browser')
  // The next paint republishes the span; a fresh independent click works.
  const repainted = panel.render(100).map(strip)
  const nextRow = repainted.findLastIndex(line => line.includes('Close [Esc]'))
  const nextCol = repainted[nextRow]!.indexOf('Close [Esc]')
  assert.ok(panel.handleMouse(mouse('press', nextCol, nextRow, 100, 24))?.handled)
  assert.ok(panel.handleMouse(mouse('click', nextCol, nextRow, 100, 24))?.handled)
  assert.equal(closes.length, 1)
  panel.dispose()
})

// ── PR2: compact header tabs and filter exit hit parity ─────────────────────

test('PR2: compact Work/Team headers keep the complete painted tab labels clickable', () => {
  const { panel } = makePanel([subagent()], {
    enableSearch: false,
    header: 'Tasks',
    team: readyTeam([teamTask()]),
    interactionCurrent: () => true,
  })
  panel.setMaxRows(3)
  const work = panel.render(100).map(strip)
  assert.ok(work[0]?.includes('[Work]') && work[0]?.includes('Team'), `the degraded Work header paints its tabs:\n${work.join('\n')}`)
  assert.equal(clickPanelText(panel, 'Team', 100, 3), true)
  assert.ok(panel.render(100).map(strip).join('\n').includes('[Team]'), 'the degraded Work Header Team label switches pages')
  panel.setMaxRows(2)
  const team = panel.render(44).map(strip)
  assert.ok(team.length <= 2 && team[0]?.includes('[Team]') && team[0]?.includes('Work'),
    `the Team slim branch still paints complete tabs:\n${team.join('\n')}`)
  assert.equal(clickPanelText(panel, 'Work', 44, 2), true)
  panel.setMaxRows(3)
  assert.ok(panel.render(44).map(strip).join('\n').includes('[Work]'), 'the slim Team Header Work label switches back')
  // The compact hit path shares the pending-Stop admission gate.
  panel.handleInput('s')
  const pending = panel.render(44)
  assert.ok(pending.map(strip).join('\n').includes('Confirm stop'), `precondition — compact Stop pending:\n${pending.map(strip).join('\n')}`)
  const pendingTeam = pending.map(strip).find(line => line.includes('Team'))!
  const pendingCol = pendingTeam.indexOf('Team')
  assert.equal(panel.handleMouse(mouse('press', pendingCol, 0, 44, 3)), undefined,
    'a pending Stop refuses the compact mouse Tab press')
  panel.handleMouse(mouse('click', pendingCol, 0, 44, 3))
  assert.ok(panel.render(44).map(strip).join('\n').includes('[Work]'), 'a pending Stop forbids the compact mouse Tab')
  panel.dispose()
})

test('PR2: empty-with-history Work header publishes its tab hit', () => {
  const { panel } = makePanel([jobItem({ value: 'job:old', label: 'bash · old', status: 'completed', active: false, canStop: false })], {
    header: 'Tasks',
    team: readyTeam([teamTask()]),
    interactionCurrent: () => true,
  })
  panel.setMaxRows(5)
  const frame = panel.render(100).map(strip).join('\n')
  assert.ok(frame.includes('[Work]') && frame.includes('Show 1 jobs'), `the empty-with-history Work header paints:\n${frame}`)
  assert.equal(clickPanelText(panel, 'Team', 100, 5), true)
  assert.ok(panel.render(100).map(strip).join('\n').includes('[Team]'), 'the same painted tab switches to Team')
  panel.dispose()
})

test('PR2: complete compact tab geometry across widths with a CJK header', () => {
  for (const cols of [44, 72, 80, 100, 120] as const) {
    const { panel } = makePanel([subagent()], {
      enableSearch: false,
      header: 'Tasks · 任务',
      team: readyTeam([teamTask()]),
      interactionCurrent: () => true,
    })
    panel.setMaxRows(3)
    const frame = panel.render(cols).map(strip)
    for (const line of frame) assert.ok(visibleWidth(line) <= cols, `${cols}: no row may overflow: ${JSON.stringify(line)}`)
    const header = frame[0]!
    const teamIndex = header.indexOf('Team')
    assert.ok(teamIndex >= 0, `${cols}: Team must paint: ${header}`)
    const teamCol = visibleWidth(header.slice(0, teamIndex))
    assert.ok(panel.handleMouse(mouse('press', teamCol, 0, cols, 3))?.handled, `${cols}: Team press must hit`)
    assert.ok(panel.handleMouse(mouse('click', teamCol, 0, cols, 3))?.handled, `${cols}: Team click must hit`)
    assert.ok(panel.render(cols).map(strip).join('\n').includes('[Team]'), `${cols}: the complete Team label switches`)
    panel.dispose()
  }
})

test('PR2: keyboard navigation retires a pressed compact Header tab', () => {
  const { panel } = makePanel([subagent()], {
    enableSearch: false,
    header: 'Tasks',
    team: readyTeam([teamTask()]),
    interactionCurrent: () => true,
  })
  panel.setMaxRows(3)
  const frame = panel.render(44)
  const header = frame.map(strip)[0]!
  const col = header.indexOf('Team')
  assert.ok(col >= 0, `the compact Team label must paint:\n${header}`)
  assert.ok(panel.handleMouse(mouse('press', col, 0, 44, 3))?.handled)
  // A keyboard navigation event between press and release retires the tab
  // gesture even when the label remains at the same painted cells.
  panel.handleInput(DOWN)
  panel.render(44)
  assert.equal(panel.handleMouse(mouse('click', col, 0, 44, 3)), undefined,
    'a keyboard intervention retires the compact tab press')
  assert.ok(panel.render(44).map(strip).join('\n').includes('[Work]'), 'the stale tab release changes no page')
  // A fresh independent press still switches.
  assert.equal(clickPanelText(panel, 'Team', 44, 3), true)
  assert.ok(panel.render(44).map(strip).join('\n').includes('[Team]'), 'a fresh compact tab click still works')
  panel.dispose()
})

test('PR2: a truncated compact header publishes no clipped tab target, and widening restores it', () => {
  const longHeader = `${'x'.repeat(36)}\u001b[31m任务\u001b[0m`
  const { panel } = makePanel([subagent()], {
    enableSearch: false,
    header: longHeader,
    team: readyTeam([teamTask()]),
    interactionCurrent: () => true,
  })
  panel.setMaxRows(3)
  const clipped = panel.render(44).map(strip)
  for (const line of clipped) assert.ok(visibleWidth(line) <= 44, `no clipped header line may exceed 44 cells: ${JSON.stringify(line)}`)
  assert.ok(!clipped.join('\n').includes('Members'), 'precondition — Work page')
  panel.handleMouse(mouse('press', 43, 0, 44, 3))
  panel.handleMouse(mouse('click', 43, 0, 44, 3))
  assert.ok(!panel.render(44).map(strip).join('\n').includes('[Team]'),
    'a clipped tab tail is inert, not a hidden Team switch')
  const wide = panel.render(200).map(strip)
  const wideRow = wide.findIndex(line => line.includes('Team'))
  const wideText = wide[wideRow]!
  const wideCol = visibleWidth(wideText.slice(0, wideText.indexOf('Team')))
  panel.handleMouse(mouse('press', wideCol, wideRow, 200, 3))
  panel.handleMouse(mouse('click', wideCol, wideRow, 200, 3))
  assert.ok(panel.render(200).map(strip).join('\n').includes('[Team]'),
    'widening restores the complete tab target')
  panel.dispose()
})

test('PR2: Fullscreen filter grants 3/2 paint a complete clickable Cancel; grant 1 paints no phantom exit', () => {
  const { panel, closes } = makeExitPanel([typed(runningJob(), 'bash'), typed(subagent(), 'job')])
  panel.handleInput('f')
  panel.setMaxRows(3)
  const three = panel.render(44).map(strip)
  assert.equal(three.length, 3, `grant 3 paints exactly its three rows:\n${three.join('\n')}`)
  assert.ok(three[0]!.includes('Type filter') && three[1]!.includes('All') && three[2]!.includes('Cancel [Esc]'),
    `grant 3 keeps title + candidate + Action Bar:\n${three.join('\n')}`)
  assert.equal(clickPanelText(panel, 'Cancel [Esc]', 44, 3), true)
  assert.ok(!panel.render(44).map(strip).join('\n').includes('Type filter'), 'grant 3 Cancel closes only the filter list')
  assert.equal(panel.getViewState().typeFilter, null, 'Cancel keeps the active type')
  assert.equal(closes.length, 0)
  panel.handleInput('f')
  panel.setMaxRows(2)
  const two = panel.render(44).map(strip)
  assert.equal(two.length, 2, `grant 2 paints exactly its two rows:\n${two.join('\n')}`)
  assert.ok(!two[0]!.includes('Type filter') && two[1]!.includes('Cancel [Esc]'),
    `grant 2 drops the title but keeps candidate + Cancel:\n${two.join('\n')}`)
  assert.equal(clickPanelText(panel, 'Cancel [Esc]', 44, 2), true)
  assert.ok(!panel.render(44).map(strip).join('\n').includes('Type filter'), 'grant 2 Cancel closes only the filter list')
  panel.handleInput('f')
  panel.setMaxRows(1)
  const one = panel.render(44).map(strip)
  assert.equal(one.length, 1, `grant 1 paints exactly its one selected row:\n${one.join('\n')}`)
  assert.ok(one[0]!.includes('All') && !one.join('\n').includes('Cancel') && !one.join('\n').includes('Esc'),
    `grant 1 must publish no unpainted exit:\n${one.join('\n')}`)
  assert.equal(clickPanelText(panel, 'All', 44, 1), true)
  assert.ok(!panel.render(44).map(strip).join('\n').includes('Type filter'), 'the visible selected candidate still applies')
  panel.dispose()
})

// ── PR-B B2: the Owner-approved Fullscreen exit whitelist ───────────────────

/** A Full Task Center panel with a recording onCancel; `interactionCurrent`
 *  mirrors the production-mounted Browser (task-runtime supplies it). */
function makeExitPanel(
  items: TaskPanelItem[],
  options: {
    team?: TeamBrowserPresentation
    enableSearch?: boolean
    mouseActionsEnabled?: () => boolean
  } = {},
): { panel: TaskBrowserPanel; closes: unknown[] } {
  const closes: unknown[] = []
  const panel = new TaskBrowserPanel(
    items,
    10,
    {
      mode: 'full',
      header: 'Tasks',
      enableSearch: options.enableSearch ?? true,
      mouseActionsEnabled: options.mouseActionsEnabled ?? (() => true),
      interactionCurrent: () => true,
      ...(options.team === undefined ? {} : { team: options.team }),
    },
    () => {},
    () => { closes.push(undefined) },
    () => {},
  )
  return { panel, closes }
}

test('B2: Work Close [Esc] calls the original onCancel and only its complete span is a target', () => {
  const { panel, closes } = makeExitPanel([runningJob()])
  const frame = panel.render(100).map(strip)
  assert.ok(frame.join('\n').includes('Close [Esc]'), `the Work bar paints the complete close span:\n${frame.join('\n')}`)
  // Non-whitelisted hints stay inert chrome.
  const hintRow = frame.findLastIndex(line => line.includes('Enter open'))
  assert.ok(hintRow >= 0)
  const enterCol = frame[hintRow]!.indexOf('Enter open')
  assert.equal(panel.handleMouse(mouse('press', enterCol, hintRow, 100, 24)), undefined,
    '`Enter open` stays a keyboard hint')
  assert.equal(clickPanelText(panel, 'Close [Esc]'), true)
  assert.equal(closes.length, 1, 'the close span enters the existing onCancel exactly once')
  panel.dispose()
})

test('B2: Work search Back [Esc] exits the search mode, keeps the query and never closes the browser', () => {
  const { panel, closes } = makeExitPanel([runningJob()], { enableSearch: true })
  panel.handleInput('/')
  panel.handleInput('a')
  const search = panel.render(100).map(strip).join('\n')
  assert.ok(search.includes('Back [Esc]'), `the search state advertises the back span:\n${search}`)
  assert.equal(clickPanelText(panel, 'Back [Esc]'), true)
  assert.equal(panel.getViewState().searchMode, false, 'the click leaves search mode')
  assert.equal(panel.getFilter(), 'a', 'the query is preserved')
  assert.equal(closes.length, 0, 'Back never closes the Full Task Center')
  assert.ok(panel.render(100).map(strip).join('\n').includes('Close [Esc]'), 'the Work bar returns')
  panel.dispose()
})

test('B2: Work filter Cancel [Esc] closes only the filter list and keeps the active type', () => {
  const { panel, closes } = makeExitPanel([typed(runningJob(), 'bash'), typed(subagent(), 'job')])
  panel.handleInput('f')
  panel.handleInput(DOWN) // All → bash
  panel.handleInput('\r')
  assert.ok(panel.render(100).map(strip).join('\n').includes('[bash]'), 'precondition — the type was applied')
  panel.handleInput('f')
  const frame = panel.render(100).map(strip).join('\n')
  assert.ok(frame.includes('Cancel [Esc]'), `the filter paints its complete cancel span:\n${frame}`)
  assert.equal(clickPanelText(panel, 'Cancel [Esc]'), true)
  const after = panel.render(100).map(strip).join('\n')
  assert.ok(!after.includes('Type filter'), 'the filter list is closed')
  assert.ok(after.includes('[bash]'), 'the active type is untouched')
  assert.equal(closes.length, 0)
  panel.dispose()
})

test('B2: the Team page Close [Esc] closes through the same onCancel', () => {
  const { panel, closes } = makeExitPanel([], { team: readyTeam([teamTask()]) })
  panel.handleInput('\t')
  const team = panel.render(100).map(strip).join('\n')
  assert.ok(team.includes('Close [Esc]'), `the Team bar paints the complete close span:\n${team}`)
  assert.equal(clickPanelText(panel, 'Close [Esc]'), true)
  assert.equal(closes.length, 1)
  panel.dispose()
})

test('B2: Team search Back [Esc] exits the team query without closing the browser', () => {
  const { panel, closes } = makeExitPanel([], {
    team: readyTeam([teamTask({ subject: 'Implement adapter' })]),
  })
  panel.handleInput('\t')
  panel.handleInput('/')
  panel.handleInput('a')
  const searching = panel.render(100).map(strip).join('\n')
  assert.ok(searching.includes('Back [Esc]'), `the Team search state advertises back:\n${searching}`)
  assert.equal(clickPanelText(panel, 'Back [Esc]'), true)
  assert.equal(closes.length, 0, 'the browser stays open')
  const after = panel.render(100).map(strip).join('\n')
  assert.ok(after.includes('Members'), 'the Team page is still painted')
  // The query survives: re-entering search paints the retained `a`.
  panel.handleInput('/')
  const reopened = panel.render(100).map(line => stripTerminalSequences(strip(line)))
  assert.ok(reopened.some(line => line.trim() === 'a'), `the retained query is painted:\n${reopened.join('\n')}`)
  panel.dispose()
})

test('B2: a pending Stop offers no Close and cannot be bypassed by an armed Work close press', () => {
  const { panel, closes } = makeExitPanel([subagent()])
  assert.ok(panel.render(100).map(strip).join('\n').includes('Close [Esc]'))
  // Arm the Work close span, then enter the destructive confirmation: the
  // keyboard latch clear means the release has no action at all.
  const frame = panel.render(100).map(strip)
  const hintRow = frame.findLastIndex(line => line.includes('Close [Esc]'))
  const closeCol = frame[hintRow]!.indexOf('Close [Esc]')
  assert.ok(panel.handleMouse(mouse('press', closeCol, hintRow, 100, 24))?.handled)
  panel.handleInput('s')
  const pending = panel.render(100).map(strip).join('\n')
  assert.ok(pending.includes('Confirm stop [Y]') && pending.includes('Cancel [Esc]'), `pending bar:\n${pending}`)
  assert.ok(!pending.includes('Close [Esc]'), 'a pending Stop never advertises a close')
  panel.handleMouse(mouse('click', closeCol, hintRow, 100, 24))
  assert.equal(closes.length, 0, 'the old close press cannot step around the confirmation')
  assert.ok(panel.render(100).map(strip).join('\n').includes('Confirm stop [Y]'), 'the confirmation survives')
  // The existing Cancel span still clears it, and the close returns.
  assert.equal(clickPanelText(panel, 'Cancel [Esc]'), true)
  assert.ok(panel.render(100).map(strip).join('\n').includes('Close [Esc]'))
  panel.dispose()
})

test('B2: a page switch between the press and release never completes the old exit', () => {
  const { panel, closes } = makeExitPanel([], { team: readyTeam([teamTask()]) })
  panel.handleInput('\t') // Team
  const frame = panel.render(100).map(strip)
  const hintRow = frame.findLastIndex(line => line.includes('Close [Esc]'))
  const closeCol = frame[hintRow]!.indexOf('Close [Esc]')
  assert.ok(panel.handleMouse(mouse('press', closeCol, hintRow, 100, 24))?.handled)
  panel.handleInput('\t') // Team → Work while the press is live
  panel.handleMouse(mouse('click', closeCol, hintRow, 100, 24))
  assert.equal(closes.length, 0, 'a release after a page switch is inert')
  assert.ok(panel.render(100).map(strip).join('\n').includes('Work'), 'the page switch stands')
  panel.dispose()
})

test('B2: Regular/Main keeps its keyboard-only bar and no exit target', () => {
  const { panel, closes } = makeExitPanel([runningJob()], { mouseActionsEnabled: () => false })
  const frame = panel.render(100).map(strip)
  const hintRow = frame.findLastIndex(line => line.includes('Esc close'))
  assert.ok(hintRow >= 0, `Regular keeps the historical hint:\n${frame.join('\n')}`)
  assert.ok(!frame[hintRow]!.includes('Close [Esc]'), 'no fullscreen affordance is painted')
  const col = frame[hintRow]!.indexOf('Esc close')
  assert.equal(panel.handleMouse(mouse('press', col, hintRow, 100, 24)), undefined)
  panel.handleMouse(mouse('click', col, hintRow, 100, 24))
  assert.equal(closes.length, 0)
  panel.dispose()
})

// ── Full Tracked terminal-Job history disclosure (PR2) ────────────────────

/** A Job-source row: the only rows that participate in the history disclosure. */
function jobItem(overrides: Partial<TaskPanelItem> = {}): TaskPanelItem {
  return {
    value: 'job:build',
    label: 'bash · build',
    status: 'running',
    active: true,
    source: 'job',
    type: 'bash',
    group: 'jobs',
    canStop: true,
    startedAt: Date.now(),
    ...overrides,
  }
}

test('job history: default hides terminal Jobs; j shows them and selects the first history row', () => {
  const { panel, rendered } = makePanel([
    jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
    jobItem({ value: 'job:old', label: 'bash · old', status: 'completed', active: false, canStop: false }),
  ])
  const collapsed = rendered().map(strip).join('\n')
  assert.ok(collapsed.includes('▸ Show 1 past jobs [J]'), `the fixed Show entry must sit above the list:\n${collapsed}`)
  assert.ok(!collapsed.includes('▾ Hide'), 'a collapsed history never advertises Hide')
  assert.ok(!collapsed.includes('bash · old'), 'a terminal Job row is hidden by default')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['job:live'])

  panel.handleInput('j')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['job:live', 'job:old'])
  assert.equal(panel.getViewState().selectedId, 'job:old', 'expanding selects the FIRST history Job')
  const expanded = rendered().map(strip).join('\n')
  assert.ok(expanded.includes('▾ Hide 1 past jobs [J]'), `the expanded entry flips its verb:\n${expanded}`)
  assert.ok(expanded.includes('bash · old'))

  panel.handleInput('j')
  assert.ok(!rendered().map(strip).join('\n').includes('bash · old'))
  assert.equal(panel.getViewState().selectedId, 'job:live', 'collapsing returns the cursor to a visible row')
})

test('job history: only terminal Jobs paint Show + the honest empty message, never a phantom group', () => {
  const { panel, rendered } = makePanel([
    jobItem({ value: 'job:a', label: 'bash · failed build', status: 'failed', active: false, attention: true, canStop: false }),
  ])
  const collapsed = rendered().map(strip).join('\n')
  assert.ok(collapsed.includes('▸ Show 1 jobs [J]'), 'the no-active wording drops "past"')
  assert.ok(collapsed.includes('!1 unreviewed'), 'the hidden failure attention is surfaced')
  assert.ok(collapsed.includes('No active tasks in this view'), 'the view states the truth instead of a no-match lie')
  assert.ok(!collapsed.includes('── jobs ──'), 'no empty Jobs header is fabricated')
  assert.ok(!collapsed.includes('bash · failed build'))

  panel.handleInput('j')
  const expanded = rendered().map(strip).join('\n')
  assert.ok(expanded.includes('── jobs ──'), 'the Jobs group appears only when its rows are visible')
  assert.ok(expanded.includes('bash · failed build'))

  const none = makePanel([])
  const noneView = none.rendered().map(strip).join('\n')
  assert.ok(!noneView.includes('jobs [J]') && !noneView.includes('Hide'), 'no candidates → no history control')
  none.panel.handleInput('j')
  assert.deepEqual(none.panel.visibleItems(), [], 'j is a no-op without terminal Job candidates')
  assert.equal(none.panel.getViewState().selectedId, null)
})

test('a running Job settling to terminal is hidden, cancels its pending Stop and yields the active Job', () => {
  const { panel, rendered } = makePanel([
    jobItem({ value: 'job:a', label: 'bash · first', status: 'running' }),
    jobItem({ value: 'job:b', label: 'bash · second', status: 'running' }),
  ])
  panel.handleInput('s')
  assert.ok(rendered().map(strip).join('\n').includes('Confirm stop [Y]'), 'precondition — Stop is armed')

  panel.setItems([
    jobItem({ value: 'job:a', label: 'bash · first', status: 'completed', active: false, canStop: false }),
    jobItem({ value: 'job:b', label: 'bash · second', status: 'running' }),
  ])
  assert.equal(panel.getViewState().selectedId, 'job:b', 'the first still-visible ACTIVE Job takes the cursor')
  assert.ok(!rendered().map(strip).join('\n').includes('Confirm stop'), 'a settled target must clear the pending confirmation')
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['job:b'])

  // An already-expanded history keeps a Job that settles while expanded
  // visible instead of silently collapsing it.
  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('Hide 1 past jobs [J]'))
  panel.setItems([
    jobItem({ value: 'job:a', label: 'bash · first', status: 'completed', active: false, canStop: false }),
    jobItem({ value: 'job:b', label: 'bash · second', status: 'completed', active: false, canStop: false }),
  ])
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['job:a', 'job:b'])
  assert.ok(rendered().map(strip).join('\n').includes('Hide 2 past jobs [J]'),
    'an active Job settling while history is expanded joins the visible history')
})

test('a terminal Job that disappears without an active Job falls back to the nearest visible row', () => {
  const { panel } = makePanel([
    jobItem({ value: 'job:a', label: 'bash · settle me', status: 'running' }),
    { value: 'agent:child', label: 'subagent · child', status: 'inactive', active: false, source: 'subagent', type: 'subagent', group: 'subagents' },
  ])
  assert.equal(panel.getViewState().selectedId, 'job:a')
  panel.handleInput('s')
  panel.setItems([
    jobItem({ value: 'job:a', label: 'bash · settle me', status: 'completed', active: false, canStop: false }),
    { value: 'agent:child', label: 'subagent · child', status: 'inactive', active: false, source: 'subagent', type: 'subagent', group: 'subagents' },
  ])
  assert.equal(panel.getViewState().selectedId, 'agent:child', 'the nearest visible non-Job row is selected')
  assert.ok(!panel.visibleItems().some(item => item.value === 'job:a'))
})

test('job history state survives refreshes, scope/type/Tab/resize and resets only with the terminal roster', () => {
  const active = jobItem({ value: 'job:live', label: 'bash · live', status: 'running' })
  const oldBash = jobItem({ value: 'job:old-bash', label: 'bash · old', status: 'completed', active: false, canStop: false })
  const oldPwsh = jobItem({ value: 'job:old-pwsh', label: 'pwsh · old', status: 'failed', active: false, canStop: false, type: 'pwsh' })
  const child: TaskPanelItem = { value: 'agent:child', label: 'subagent · child', status: 'inactive', active: false, source: 'subagent', type: 'subagent', group: 'subagents' }
  const { panel, rendered } = makePanel([active, oldBash, oldPwsh, child], { team: readyTeam([teamTask()]) })
  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('▾ Hide 2 past jobs [J]'))

  // setItems: the manual expansion survives and a NEW terminal row joins it.
  panel.setItems([
    active,
    oldBash,
    oldPwsh,
    jobItem({ value: 'job:new', label: 'bash · new', status: 'completed', active: false, canStop: false }),
    child,
  ])
  assert.ok(rendered().map(strip).join('\n').includes('▾ Hide 3 past jobs [J]'), 'a refresh never collapses the manual disclosure')

  // a: Active hides the control but keeps the flag; back to Tracked restores it.
  panel.handleInput('a')
  const activeView = rendered().map(strip).join('\n')
  assert.ok(!activeView.includes('Hide 3 past jobs') && !activeView.includes('Show 3 past jobs'))
  panel.handleInput('a')
  assert.ok(rendered().map(strip).join('\n').includes('▾ Hide 3 past jobs [J]'))

  // f: the control counts the CURRENT type candidates; the flag survives.
  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput('\r') // bash
  assert.ok(rendered().map(strip).join('\n').includes('▾ Hide 2 past jobs [J]'),
    'the bash filter counts only bash terminal candidates')
  openTypeList(panel); panel.handleInput(UP); panel.handleInput(UP); panel.handleInput('\r') // All
  assert.ok(rendered().map(strip).join('\n').includes('▾ Hide 3 past jobs [J]'))

  // Tab Work→Team→Work keeps the Work disclosure and selection.
  panel.handleInput('\t')
  assert.ok(rendered().map(strip).join('\n').includes('[Team]'))
  panel.handleInput('\t')
  assert.ok(rendered().map(strip).join('\n').includes('▾ Hide 3 past jobs [J]'))

  // A resize repaint (live row budget) keeps the state.
  panel.setMaxRows(8)
  assert.ok(panel.render(100).map(strip).join('\n').includes('▾ Hide 3 past jobs [J]'))

  // Completely losing the terminal roster resets the flag; a later terminal
  // row starts from the default collapsed state.
  panel.setItems([active, child])
  assert.ok(!rendered().map(strip).join('\n').includes('Hide'))
  panel.setItems([active, oldBash, child])
  assert.ok(rendered().map(strip).join('\n').includes('▸ Show 1 past jobs [J]'),
    'a new terminal row starts collapsed after the roster emptied')

  // A new browser instance always starts collapsed.
  const fresh = makePanel([active, oldBash])
  assert.ok(fresh.rendered().map(strip).join('\n').includes('▸ Show 1 past jobs [J]'))
  assert.ok(!fresh.rendered().map(strip).join('\n').includes('▾ Hide'))
})

test('search owns j as query text and finds collapsed terminal Jobs; clearing restores the manual state', () => {
  const { panel, rendered } = makePanel([
    jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
    jobItem({ value: 'job:failed', label: 'bash · failed lint', status: 'failed', active: false, attention: true, canStop: false }),
    jobItem({ value: 'job:done', label: 'pwsh · completed deploy', status: 'completed', active: false, canStop: false, type: 'pwsh' }),
  ], { enableSearch: true })
  const initial = rendered().map(strip).join('\n')
  assert.ok(initial.includes('▸ Show 2 past jobs [J]') && initial.includes('!1 unreviewed'))

  panel.handleInput('/')
  panel.handleInput('j')
  assert.equal(panel.getFilter(), 'j', 'search-mode j is query text, never a disclosure toggle')
  panel.handleInput('\x7f') // Backspace
  for (const key of 'failed') panel.handleInput(key)
  assert.ok(panel.visibleItems().some(item => item.value === 'job:failed'), 'search reaches a hidden terminal Job')
  assert.ok(rendered().map(strip).join('\n').includes('bash · failed lint'))
  assert.ok(!rendered().map(strip).join('\n').includes('Show 2 past jobs'), 'search owns the row: no Show/Hide control')

  panel.handleInput('\x1b') // exit search with the query kept
  assert.ok(panel.visibleItems().some(item => item.value === 'job:failed'), 'the kept query keeps the search result visible')
  panel.handleInput('/')
  for (let i = 0; i < 'failed'.length; i += 1) panel.handleInput('\x7f')
  panel.handleInput('\x1b') // exit search, query now empty
  const restored = rendered().map(strip).join('\n')
  assert.ok(restored.includes('▸ Show 2 past jobs [J]'), 'clearing the query restores the previous collapsed choice')
  assert.ok(!restored.includes('bash · failed lint'))
})

test('j is inert on Team, in the type list, during a pending Stop and after switching to Active', () => {
  const items = [
    jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
    jobItem({ value: 'job:old', label: 'bash · old', status: 'completed', active: false, canStop: false }),
  ]
  const { panel, rendered } = makePanel(items, { team: readyTeam([teamTask()]) })
  // Team page
  panel.handleInput('\t')
  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('[Team]'), 'j never leaves/affects the Team page')
  panel.handleInput('\t')
  // Type filter list
  openTypeList(panel)
  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('Type filter'), 'j stays inert while the type list owns input')
  panel.handleInput('\x1b')
  // Pending Stop
  panel.handleInput('s')
  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('Confirm stop [Y]'), 'j never dismisses a pending Stop')
  panel.handleInput('\x1b')
  // Active scope
  panel.handleInput('a')
  panel.handleInput('j')
  assert.ok(!rendered().map(strip).join('\n').includes('Hide 1 past jobs'), 'j is inert in Active scope')
})

test('hidden failure attention is acknowledged only when the Job row is actually painted', () => {
  const exposed: string[] = []
  const panel = new TaskBrowserPanel(
    [
      jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
      jobItem({ value: 'job:f1', label: 'bash · failed one', status: 'failed', active: false, attention: true, canStop: false }),
      jobItem({ value: 'job:f2', label: 'bash · failed two', status: 'failed', active: false, attention: true, canStop: false }),
    ],
    10,
    { mode: 'full', header: 'tasks', onViewportExpose: ids => exposed.push(...ids) },
    () => {}, () => {}, () => {},
  )
  panel.render(100)
  assert.deepEqual(exposed, [], 'the collapsed Show row (even with !N) never acknowledges a failure')
  const collapsed = panel.render(100).map(strip).join('\n')
  assert.ok(collapsed.includes('!2 unreviewed'))
  panel.handleInput('j')
  panel.render(100)
  assert.deepEqual(exposed, ['job:f1', 'job:f2'], 'expanded painted rows acknowledge exactly once')
  panel.render(100)
  assert.deepEqual(exposed, ['job:f1', 'job:f2'], 'a repaint never re-acknowledges')
  panel.dispose()
})

test('type-filtered empty-with-history: Show stays reachable and disappears with the roster', () => {
  const { panel, rendered } = makePanel([
    jobItem({ value: 'job:old', label: 'bash · old build', status: 'completed', active: false, canStop: false }),
    { value: 'agent:child', label: 'subagent · child', status: 'inactive', active: false, source: 'subagent', type: 'subagent', group: 'subagents' },
  ])
  openTypeList(panel); panel.handleInput(DOWN); panel.handleInput('\r') // bash
  const filtered = rendered().map(strip).join('\n')
  assert.ok(filtered.includes('▸ Show 1 jobs [J]'), 'the filtered history remains reachable')
  assert.ok(filtered.includes('No active tasks in this view'))
  assert.ok(!filtered.includes('── jobs ──') && !filtered.includes('bash · old build'), 'no phantom row or group header')

  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('bash · old build'))
  panel.setItems([])
  const gone = rendered().map(strip).join('\n')
  assert.ok(!gone.includes('jobs [J]') && !gone.includes('── jobs ──'), 'the control and group disappear with the roster')
})

test('job-history mouse: complete label only, press→repaint→release toggles once, item row opens', () => {
  const selected: string[] = []
  const panel = new TaskBrowserPanel(
    [
      jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
      jobItem({ value: 'job:old', label: 'bash · old', status: 'completed', active: false, canStop: false, attention: true }),
    ],
    10,
    { mode: 'full', header: 'tasks', mouseActionsEnabled: () => true, interactionCurrent: () => true },
    value => { selected.push(value) },
    () => {}, () => {},
  )
  const frame = panel.render(100).map(strip)
  const controlRow = frame.findIndex(line => line.includes('Show 1 past jobs [J]'))
  assert.ok(controlRow >= 0)
  const controlCol = frame[controlRow]!.indexOf('Show')
  // A release without a press is inert.
  assert.equal(panel.handleMouse(mouse('click', controlCol, controlRow, 100, 24)), undefined)
  // The suffix is outside the complete action label: inert.
  const suffixCol = frame[controlRow]!.indexOf('!1 unreviewed')
  assert.equal(panel.handleMouse(mouse('press', suffixCol, controlRow, 100, 24)), undefined)
  // Real press → repaint → release toggles exactly once.
  assert.ok(panel.handleMouse(mouse('press', controlCol, controlRow, 100, 24))?.handled)
  panel.render(100)
  assert.ok(panel.handleMouse(mouse('click', controlCol, controlRow, 100, 24))?.handled)
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['job:live', 'job:old'])
  // Wheel on the control row never toggles the disclosure; it stays on the
  // SAME list-scroll owner and moves the selection.
  const expandedFrame = panel.render(100).map(strip)
  const hideRow = expandedFrame.findIndex(line => line.includes('Hide 1 past jobs [J]'))
  const hideCol = expandedFrame[hideRow]!.indexOf('Hide')
  assert.equal(panel.getViewState().selectedId, 'job:old')
  panel.handleMouse(mouse('wheel', hideCol, hideRow, 100, 24, -1, 'none'))
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['job:live', 'job:old'])
  assert.equal(panel.getViewState().selectedId, 'job:live', 'the control-row wheel scrolls/selects through the existing list owner')
  // Clicking the history Job row goes through the ONE existing select sink.
  const rowIndex = expandedFrame.findIndex(line => line.includes('bash · old'))
  const rowCol = expandedFrame[rowIndex]!.indexOf('bash · old')
  assert.ok(panel.handleMouse(mouse('press', rowCol, rowIndex, 100, 24))?.handled)
  assert.ok(panel.handleMouse(mouse('click', rowCol, rowIndex, 100, 24))?.handled)
  assert.deepEqual(selected, ['job:old'])
  panel.dispose()
})

test('stale job-history gestures never toggle after content/state/owner changes', () => {
  const make = (interactionCurrent: () => boolean = () => true, mouseActionsEnabled = true): TaskBrowserPanel =>
    new TaskBrowserPanel(
      [
        jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
        jobItem({ value: 'job:old', label: 'bash · old', status: 'completed', active: false, canStop: false }),
      ],
      10,
      { mode: 'full', header: 'tasks', mouseActionsEnabled: () => mouseActionsEnabled, interactionCurrent },
      () => {}, () => {}, () => {},
    )
  const control = (panel: TaskBrowserPanel, verb = 'Show'): { x: number; row: number } => {
    const frame = panel.render(100).map(strip)
    const row = frame.findIndex(line => line.includes(`${verb} 1 past jobs [J]`))
    assert.ok(row >= 0, `control missing:\n${frame.join('\n')}`)
    return { x: frame[row]!.indexOf(verb), row }
  }

  // Content replaced with the same candidate count: setItems invalidates.
  {
    const panel = make()
    const { x, row } = control(panel)
    assert.ok(panel.handleMouse(mouse('press', x, row, 100, 24))?.handled)
    panel.setItems([
      jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
      jobItem({ value: 'job:old', label: 'bash · replaced old', status: 'completed', active: false, canStop: false }),
    ])
    panel.render(100)
    panel.handleMouse(mouse('click', x, row, 100, 24))
    assert.ok(!panel.visibleItems().some(item => item.label.includes('replaced old')))
    panel.dispose()
  }
  // Keyboard input between press and release invalidates.
  {
    const panel = make()
    const { x, row } = control(panel)
    assert.ok(panel.handleMouse(mouse('press', x, row, 100, 24))?.handled)
    panel.handleInput('a')
    panel.handleInput('a')
    panel.render(100)
    panel.handleMouse(mouse('click', x, row, 100, 24))
    assert.ok(!panel.visibleItems().some(item => item.value === 'job:old'))
    panel.dispose()
  }
  // Resize between press and release invalidates by grant.
  {
    const panel = make()
    const { x, row } = control(panel)
    assert.ok(panel.handleMouse(mouse('press', x, row, 100, 24))?.handled)
    panel.handleMouse(mouse('click', x, row, 120, 30))
    assert.ok(!panel.visibleItems().some(item => item.value === 'job:old'))
    panel.dispose()
  }
  // A resize that comes back to the SAME grant before release still revokes
  // the old press: the resize itself is the boundary.
  {
    const panel = make()
    const { x, row } = control(panel)
    assert.ok(panel.handleMouse(mouse('press', x, row, 100, 24))?.handled)
    panel.setMaxRows(8)
    panel.render(100)
    panel.setMaxRows(10)
    panel.render(100)
    panel.handleMouse(mouse('click', x, row, 100, 24))
    assert.ok(!panel.visibleItems().some(item => item.value === 'job:old'), 'a resize boundary permanently revokes the press')
    panel.dispose()
  }
  // A stale Work control hit after switching to Team (before the next paint)
  // must not wheel the hidden Work selection.
  {
    const panel = new TaskBrowserPanel(
      [
        jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
        jobItem({ value: 'job:old', label: 'bash · old', status: 'completed', active: false, canStop: false }),
      ],
      10,
      {
        mode: 'full', header: 'tasks', mouseActionsEnabled: () => true,
        interactionCurrent: () => true, team: readyTeam([teamTask()]),
      },
      () => {}, () => {}, () => {},
    )
    panel.handleInput('j') // expanded history selects the terminal Job (index 1)
    const expandedFrame = panel.render(100).map(strip)
    const hideRow = expandedFrame.findIndex(line => line.includes('Hide 1 past jobs [J]'))
    const hideCol = expandedFrame[hideRow]!.indexOf('Hide')
    panel.handleInput('\t') // Team page, deliberately no repaint yet
    panel.handleMouse(mouse('wheel', hideCol, hideRow, 100, 24, -1, 'none'))
    panel.handleInput('\t') // back to Work
    panel.render(100)
    assert.equal(panel.getViewState().selectedId, 'job:old', 'a stale Team-page wheel never moves the hidden Work selection')
    panel.dispose()
  }
  // invalidate() revokes the armed frame.
  {
    const panel = make()
    const { x, row } = control(panel)
    assert.ok(panel.handleMouse(mouse('press', x, row, 100, 24))?.handled)
    panel.invalidate()
    panel.render(100)
    panel.handleMouse(mouse('click', x, row, 100, 24))
    assert.ok(!panel.visibleItems().some(item => item.value === 'job:old'))
    panel.dispose()
  }
  // dispose() revokes the armed frame and a disposed panel never toggles.
  {
    const panel = make()
    const { x, row } = control(panel)
    assert.ok(panel.handleMouse(mouse('press', x, row, 100, 24))?.handled)
    panel.dispose()
    assert.equal(panel.handleMouse(mouse('click', x, row, 100, 24)), undefined)
  }
  // A fresh press after a rejected gesture can still succeed.
  {
    const panel = make()
    const { x, row } = control(panel)
    assert.ok(panel.handleMouse(mouse('press', x, row, 100, 24))?.handled)
    panel.invalidate()
    panel.render(100)
    panel.handleMouse(mouse('click', x, row, 100, 24))
    assert.ok(!panel.visibleItems().some(item => item.value === 'job:old'))
    const fresh = control(panel)
    assert.ok(panel.handleMouse(mouse('press', fresh.x, fresh.row, 100, 24))?.handled)
    assert.ok(panel.handleMouse(mouse('click', fresh.x, fresh.row, 100, 24))?.handled)
    assert.ok(panel.visibleItems().some(item => item.value === 'job:old'), 'a fresh gesture after a rejected stale press still works')
    panel.dispose()
  }
  // A stale owner fence or non-fullscreen surface never arms a press.
  {
    const stale = make(() => false)
    const { x, row } = control(stale)
    assert.equal(stale.handleMouse(mouse('press', x, row, 100, 24)), undefined)
    stale.dispose()
    const regular = make(() => true, false)
    const point = control(regular)
    assert.equal(regular.handleMouse(mouse('press', point.x, point.row, 100, 24)), undefined)
    regular.handleInput('j')
    assert.ok(regular.visibleItems().some(item => item.value === 'job:old'), 'keyboard j still works in Regular/Main')
    regular.dispose()
  }
})

test('job-history row budget stays within the grant across the frozen size matrix', () => {
  const history: TaskPanelItem[] = Array.from({ length: 14 }, (_, index) => jobItem({
    value: `job:old-${index}`,
    label: `bash · ${index === 3 ? '构建 🚀 long job label ' : ''}old job ${index}`,
    status: index % 3 === 0 ? 'failed' : 'completed',
    active: false,
    attention: index % 3 === 0,
    canStop: false,
  }))
  const live = jobItem({ value: 'job:live', label: 'bash · 正在运行 live', status: 'running' })
  for (const [width, height] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
    const { panel } = makePanel([live, ...history], { interactionCurrent: () => true })
    panel.setMaxRows(height)
    const lines = panel.render(width).map(strip)
    assert.ok(lines.length <= height, `${width}x${height}: render overflowed (${lines.length})`)
    assert.ok(lines.at(-1)?.includes('Esc'), `${width}x${height}: the safe exit must stay on the last row:\n${lines.join('\n')}`)
    const selectedId = panel.getViewState().selectedId
    assert.ok(panel.viewportItems().some(item => item.value === selectedId),
      `${width}x${height}: the selected row must be in the painted viewport`)
    panel.dispose()
  }
  // A 1–3 row empty grant keeps the safe exit and the history control, and j
  // still toggles even when the control itself had to yield.
  const empty = makePanel(history, { interactionCurrent: () => true })
  for (const rows of [3, 2]) {
    empty.panel.setMaxRows(rows)
    const lines = empty.panel.render(80).map(strip)
    assert.ok(lines.length <= rows, `${rows}-row empty grant overflowed (${lines.length})`)
    assert.ok(lines.join('\n').includes('Esc'), 'the exit survives')
    assert.ok(lines.join('\n').includes('Show'), 'the history control survives above the message')
  }
  empty.panel.setMaxRows(1)
  const one = empty.panel.render(80).map(strip)
  assert.equal(one.length, 1)
  assert.ok(one[0]!.includes('Esc'), 'a 1-row grant keeps the exit')
  empty.panel.handleInput('j')
  assert.equal(empty.panel.visibleItems().length, 14, 'j still expands without a painted control')
  empty.panel.dispose()
})

test('the header stays the honest roster count when history is hidden', () => {
  const { panel, rendered } = makePanel([
    jobItem({ value: 'job:live', label: 'bash · live', status: 'running' }),
    jobItem({ value: 'job:done', label: 'bash · done', status: 'completed', active: false, canStop: false }),
    jobItem({ value: 'job:failed', label: 'bash · failed', status: 'failed', active: false, canStop: false }),
  ])
  const collapsed = rendered().map(strip).join('\n')
  assert.ok(collapsed.includes('1 active'), 'the running Job still counts as active')
  assert.ok(collapsed.includes('1 done') && collapsed.includes('1 failed'), 'roster outcomes are not hidden by presentation')
  assert.ok(collapsed.includes('1/3 shown'), 'the header distinguishes visible rows from roster size')
  assert.ok(collapsed.includes('[TRACKED]') && !collapsed.includes('[ACTIVE]'))
  panel.handleInput('j')
  assert.ok(rendered().map(strip).join('\n').includes('3/3 shown'), 'expanding updates only the shown count')
})
