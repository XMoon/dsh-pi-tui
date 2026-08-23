/**
 * Headless tests for the categorized session picker (requirement 3):
 * the default category hides subagent rows, Tab cycles the categories
 * (carrying the search query), the All category indents subagents under
 * their parents, and /resume-style direct matching still resolves a
 * subagent id.
 * @module @xmoon76/dsh-pi-tui/session-categories.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  buildSessionTree,
  headerToPickerRow,
  sessionPickerItem,
  type SessionPickerItem,
  type SessionPickerRow,
} from '../src/sessions.ts'
import { sessionPickerCategories } from '../src/commands.ts'
import type { PickerCategory } from '../src/tui-app.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp; picked: string[] } {
  const vt = new VirtualTerminal(100, 30)
  const picked: string[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app, picked }
}

test('buildSessionTree hangs every parentSession row under its parent chain', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-root-1', createdAt: 5, live: false },
    { id: 'session-child-1', createdAt: 4, origin: 'subagent', parentSession: 'session-root-1', live: false },
    { id: 'session-root-2', createdAt: 3, live: false },
    { id: 'session-grandchild', createdAt: 2, origin: 'subagent', parentSession: 'session-child-1', live: false },
    // A subagent WITHOUT a parentSession is a root now: `parentSession`
    // decides the hierarchy, `origin` only the badge (plan §20).
    { id: 'session-unparented', createdAt: 1, origin: 'subagent', live: false },
  ]
  const tree = buildSessionTree(rows)
  const byId = new Map(tree.map(entry => [entry.row.id, entry.depth]))
  assert.equal(byId.get('session-root-1'), 0, 'roots sit at depth 0')
  assert.equal(byId.get('session-child-1'), 1, 'direct children hang one level down')
  assert.equal(byId.get('session-grandchild'), 2, 'the chain continues deeper')
  assert.equal(byId.get('session-unparented'), 0, 'a row without parentSession is a root')
  // Input (newest-first) order preserved per level: root-2 precedes its
  // sibling subtree only if it came first in the input.
  assert.equal(tree[0]!.row.id, 'session-root-1')
  assert.equal(tree[1]!.row.id, 'session-child-1', 'children follow their root immediately')
})

// ── session lineage (plan §20): /fork + rewind children in the tree ───────

test('S01: a plain /fork child hangs under its parent', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 4, live: false },
    { id: 'session-fork', createdAt: 3, parentSession: 'session-parent', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-fork', 1],
  ])
})

test('S02: a rewind-of-rewind chain nests deeper', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 5, live: false },
    { id: 'session-child1', createdAt: 4, parentSession: 'session-parent', live: false },
    { id: 'session-child2', createdAt: 3, parentSession: 'session-child1', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-child1', 1],
    ['session-child2', 2],
  ])
})

test('S03: a subagent still hangs under its parent', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 4, live: false },
    { id: 'session-sub', createdAt: 3, origin: 'subagent', parentSession: 'session-parent', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-sub', 1],
  ])
})

test('S04: fork and subagent siblings keep the input order', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 5, live: false },
    { id: 'session-fork', createdAt: 4, parentSession: 'session-parent', live: false },
    { id: 'session-sub', createdAt: 3, origin: 'subagent', parentSession: 'session-parent', live: false },
    { id: 'session-parent2', createdAt: 2, live: false },
    { id: 'session-fork2', createdAt: 1, parentSession: 'session-parent2', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-fork', 1],
    ['session-sub', 1],
    ['session-parent2', 0],
    ['session-fork2', 1],
  ])
})

test('S05: an orphan child (parent outside the window) sits at depth 1', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-orphan-fork', createdAt: 3, parentSession: 'session-missing', live: false },
    { id: 'session-root', createdAt: 2, live: false },
    { id: 'session-orphan-sub', createdAt: 1, origin: 'subagent', parentSession: 'session-missing', live: false },
  ]
  const tree = buildSessionTree(rows)
  const byId = new Map(tree.map(entry => [entry.row.id, entry.depth]))
  assert.equal(byId.get('session-root'), 0)
  assert.equal(byId.get('session-orphan-fork'), 1, 'orphan fork children must not be lost')
  assert.equal(byId.get('session-orphan-sub'), 1, 'orphan subagents stay at depth 1')
})

test('S06: parent cycles never loop and each row appears once', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-a', createdAt: 3, parentSession: 'session-b', live: false },
    { id: 'session-b', createdAt: 2, parentSession: 'session-a', live: false },
    { id: 'session-self', createdAt: 1, parentSession: 'session-self', live: false },
  ]
  const tree = buildSessionTree(rows)
  const ids = tree.map(entry => entry.row.id)
  assert.equal(new Set(ids).size, ids.length, 'no row may be output twice')
  assert.ok(!ids.some(id => ids.filter(candidate => candidate === id).length > 1), 'cycle rows must not repeat')
})

test('the All category indents fork children under their parent (plan §20)', () => {
  const plainItem = (row: SessionPickerRow, indent = 0): { value: string; label: string; description: string; group: string } =>
    sessionPickerItem(row, '', indent)
  const categories = sessionPickerCategories(
    [
      { id: 'session-parent', createdAt: 4, cwd: '/ws', live: false },
      { id: 'session-fork', createdAt: 3, cwd: '/ws', parentSession: 'session-parent', live: false },
      { id: 'session-other', createdAt: 2, cwd: '/ws', live: false },
    ],
    '/ws',
    'sessions',
    plainItem,
  )
  const all = categories[1]!.items()
  const parent = all.find(item => item.value === 'session-parent')
  const fork = all.find(item => item.value === 'session-fork')
  assert.ok(parent !== undefined && !parent.label.includes('└─'), 'the root row stays flat')
  assert.ok(fork !== undefined, 'fork child must be listed')
  assert.ok(fork!.label.startsWith('  └─ '), `fork child must be indented:\n${fork!.label}`)
  assert.ok(fork!.description !== undefined && fork!.description.includes('fork'), 'the fork badge stays on the indented row')
})

// ── the Current directory / All directories scopes (plan item 3) ──────────

const pickerRows: SessionPickerRow[] = [
  { id: 'session-current-1', createdAt: 5, cwd: '/ws/project-a', live: false },
  { id: 'session-current-2', createdAt: 4, cwd: '/ws/project-a/', live: false },
  { id: 'session-other', createdAt: 3, cwd: '/ws/project-b', live: false },
  { id: 'session-child', createdAt: 2, cwd: '/ws/project-a', origin: 'subagent', parentSession: 'session-current-1', live: false },
  { id: 'session-unrooted', createdAt: 1, live: false },
]

/** The picker's plain item mapper (no titles, no current marker). */
const plainItem = (row: SessionPickerRow): { value: string; label: string; description: string; group: string } =>
  sessionPickerItem(row, '')

test('sessionPickerCategories scopes Current to the workspace and never shows subagents', () => {
  const categories = sessionPickerCategories(pickerRows, '/ws/project-a', 'sessions', plainItem)
  assert.deepEqual(categories.map(category => category.label), ['Current directory', 'All directories'],
    'the old Main/Subagents/All triad is gone')
  assert.equal(categories[0]!.header, 'sessions · Current directory')
  assert.equal(categories[1]!.header, 'sessions · All directories')

  const current = categories[0]!.items()
  const currentIds = current.map(item => item.value).sort()
  assert.deepEqual(currentIds, ['session-current-1', 'session-current-2'],
    `Current keeps only main sessions in the current workspace:\n${JSON.stringify(currentIds)}`)
  assert.ok(!current.some(item => item.value === 'session-child'), 'subagent children never appear in Current')

  const all = categories[1]!.items()
  const allIds = all.map(item => item.value).sort()
  assert.deepEqual(allIds, ['session-current-1', 'session-current-2', 'session-other', 'session-unrooted'],
    `All lists every main session:\n${JSON.stringify(allIds)}`)
  assert.ok(!all.some(item => item.value === 'session-child'), 'subagent children never appear in All either')
})

test('sessionPickerCategories treats a trailing-slash cwd as the same workspace', () => {
  const categories = sessionPickerCategories(pickerRows, '/ws/project-a/', 'sessions', plainItem)
  const currentIds = categories[0]!.items().map(row => row.value).sort()
  assert.deepEqual(currentIds, ['session-current-1', 'session-current-2'],
    `/ws/project-a/ scopes the same sessions as /ws/project-a:\n${JSON.stringify(currentIds)}`)
})

test('the Current category indents fork children in the current workspace', () => {
  const treeItem = (row: SessionPickerRow, indent = 0): SessionPickerItem => sessionPickerItem(row, '', indent)
  const categories = sessionPickerCategories(
    [
      { id: 'session-parent', createdAt: 4, cwd: '/ws', live: false },
      { id: 'session-fork', createdAt: 3, cwd: '/ws', parentSession: 'session-parent', live: false },
      { id: 'session-other-cwd', createdAt: 2, cwd: '/other', parentSession: 'session-parent', live: false },
      { id: 'session-orphan', createdAt: 1, cwd: '/ws', parentSession: 'session-missing', live: false },
    ],
    '/ws',
    'sessions',
    treeItem,
  )
  const current = categories[0]!.items()
  const parent = current.find(item => item.value === 'session-parent')
  const fork = current.find(item => item.value === 'session-fork')
  const otherCwd = current.find(item => item.value === 'session-other-cwd')
  const orphan = current.find(item => item.value === 'session-orphan')
  assert.ok(parent !== undefined && !parent.label.includes('└─'), 'the workspace root stays flat')
  assert.ok(fork !== undefined && fork.label.startsWith('  └─ '), `a fork child in the current workspace must be indented:\n${fork!.label}`)
  assert.equal(otherCwd, undefined, 'a child in ANOTHER workspace is out of the Current scope')
  assert.ok(orphan !== undefined && orphan!.label.startsWith('  └─ '), 'an orphan (parent outside the workspace/window) sits at depth 1, never lost')
})

test('sessionPickerItem indents subagent rows in the All category', () => {
  const row: SessionPickerRow = {
    id: 'session-child-1',
    createdAt: 4,
    origin: 'subagent',
    parentSession: 'session-root-1',
    live: false,
  }
  const flat = sessionPickerItem(row, '', 0)
  assert.ok(!flat.label.startsWith('  └─ '), `flat row must not be indented:\n${flat.label}`)
  const indented = sessionPickerItem(row, '', 2)
  assert.ok(indented.label.startsWith('    └─ '), `depth-2 row must be indented:\n${indented.label}`)
  assert.ok(indented.description.includes('sub'), 'the sub marker must stay on indented rows')
})

test('a categorized picker defaults to the first category and Tab cycles it', async () => {
  const { vt, app, picked } = startApp()
  const categories: PickerCategory[] = [
    {
      id: 'main',
      label: 'Main',
      header: 'sessions · Main',
      items: () => [{ value: 'session-root', label: 'alpha', description: 'main row', group: 'w' }],
    },
    {
      id: 'sub',
      label: 'Subagents',
      header: 'sessions · Subagents',
      items: () => [{ value: 'session-child', label: '  └─ subby', description: 'sub row', group: 'w' }],
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), (value) => picked.push(value), () => {}, {
    enableSearch: true,
    header: categories[0]!.header,
    categories,
  })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('alpha'), `default category row missing:\n${view}`)
  assert.ok(!view.includes('subby'), `default category must hide subagent rows:\n${view}`)
  assert.ok(view.includes('sessions · Main'), `default header missing:\n${view}`)

  vt.sendInput('\t')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('subby'), `Tab must switch to the subagent category:\n${view}`)
  assert.ok(!view.includes('alpha'), `the previous category rows must be gone:\n${view}`)
  assert.ok(view.includes('sessions · Subagents'), `the header must track the category:\n${view}`)

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(picked, ['session-child'], 'selecting in the switched category must pick its row')
  handle.close()
})

test('the search query is carried across category switches', async () => {
  const { vt, app, picked } = startApp()
  const categories: PickerCategory[] = [
    {
      id: 'main',
      label: 'Main',
      header: 'sessions · Main',
      items: () => [
        { value: 'session-root', label: 'alpha', description: '', group: 'w' },
        { value: 'session-z', label: 'zulu', description: '', group: 'w' },
      ],
    },
    {
      id: 'sub',
      label: 'Subagents',
      header: 'sessions · Subagents',
      items: () => [
        { value: 'session-child', label: '  └─ zed', description: '', group: 'w' },
        { value: 'session-other', label: '  └─ alex', description: '', group: 'w' },
      ],
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), (value) => picked.push(value), () => {}, {
    enableSearch: true,
    header: categories[0]!.header,
    categories,
  })
  await vt.waitForRender()
  vt.sendInput('z')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('zulu'), `filtered row missing:\n${view}`)
  assert.ok(!view.includes('alpha'), `non-matching row visible:\n${view}`)

  vt.sendInput('\t')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('zed'), `the query must carry into the new category:\n${view}`)
  assert.ok(!view.includes('alex'), `the query must filter the new category:\n${view}`)
  handle.close()
})

test('headerToPickerRow + sessionPickerItem feed the Main category without subagent rows', () => {
  const headers: SessionHeader[] = [
    { version: 0, id: SessionId('session-root-1'), createdAt: 5, cwd: '/w' },
    { version: 0, id: SessionId('session-child-1'), createdAt: 4, cwd: '/w', origin: 'subagent', parentSession: SessionId('session-root-1') },
  ]
  const rows = headers.map(header => headerToPickerRow(header, false))
  const main = rows.filter(row => row.origin !== 'subagent')
  assert.equal(main.length, 1, 'the Main category keeps only non-subagent rows')
  assert.equal(main[0]!.id, 'session-root-1')
})

test('an ALREADY-aborted signal never mounts the categorized picker', async () => {
  const { vt, app } = startApp()
  let cancelled = 0
  const controller = new AbortController()
  controller.abort()
  const categories: PickerCategory[] = [
    {
      id: 'main',
      label: 'Main',
      header: 'sessions · Main',
      items: () => [{ value: 'session-root', label: 'alpha', description: '', group: 'w' }],
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => { cancelled += 1 }, {
    enableSearch: true,
    header: categories[0]!.header,
    categories,
    signal: controller.signal,
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(cancelled, 1, 'the pre-aborted signal must cancel immediately')
  assert.ok(!view.includes('alpha'), `a cancelled picker must never mount:\n${view}`)
  assert.ok(!view.includes('sessions · Main'), `the cancelled picker frame must not render:\n${view}`)
  // The handle is inert but safe to close.
  handle.close()
  app.stop()
})
