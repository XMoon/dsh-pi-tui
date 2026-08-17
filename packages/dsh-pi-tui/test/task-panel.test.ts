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
