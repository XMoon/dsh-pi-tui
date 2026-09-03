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
    mode: 'quick', enableSearch: true, header: 'Tasks', onViewFull: next => { state = next },
  }, () => {}, () => {}, () => {})
  assert.deepEqual(panel.visibleItems().map(item => item.value), ['agent:parent', 'agent:child', 'task:view-all'])
  assert.equal(panel.visibleItems()[0]!.ancestorContext, true)
  panel.handleInput('t')
  assert.equal(state?.scope, 'active')
  assert.equal(state?.selectedId, 'agent:parent')
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
  const row = plain.split('\n').find(line => line.includes('View all 1 tasks'))!
  assert.ok(row.includes('View all 1 tasks'), `pseudo-row present:\n${plain}`)
  assert.ok(!/View all 1 tasks[^\n]*completed/.test(row), `no completed tail:\n${row}`)
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
