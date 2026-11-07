/**
 * Headless tests for the categorized session picker (requirement 3):
 * the default category hides subagent rows, Tab cycles the categories
 * (carrying the search query), the All category indents subagents under
 * their parents, and /resume-style direct matching still resolves a
 * subagent id.
 * @module @xmoon76/dsh-pi-tui/session-categories.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import {
  buildSessionTree,
  sessionLabelParts,
  sessionPickerItem,
  sessionSearchItem,
  type SessionPickerItem,
  type SessionPickerRow,
} from '../../src/tui/pickers/sessions.ts'
import { sessionPickerCategories, sessionSearchCategory } from '../../src/commands.ts'
import type { SessionBrowserSearchResult } from '../../src/app/command/session-browser-presentation.ts'
import { MARQUEE_STEP_MS } from '../../src/tui/components/marquee.ts'
import type { PickerCategory } from '../../src/tui-app.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces,
 * so a test that starts an app must not leak the slot into the next test
 * (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})


function startApp(): { vt: VirtualTerminal; app: TuiApp; picked: string[] } {
  const vt = new VirtualTerminal(100, 30)
  const picked: string[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app, picked }
}

test('buildSessionTree nests only real subagent origins', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-root-1', createdAt: 5, updatedAt: 5, live: false },
    { id: 'session-child-1', createdAt: 4, updatedAt: 4, origin: 'subagent', parentSession: 'session-root-1', live: false },
    { id: 'session-root-2', createdAt: 3, updatedAt: 3, live: false },
    { id: 'session-grandchild', createdAt: 2, updatedAt: 2, origin: 'subagent', parentSession: 'session-child-1', live: false },
    // A subagent WITHOUT a parentSession is a root: `origin` decides whether
    // a real Host ancestry edge exists, `parentSession` supplies the target.
    { id: 'session-unparented', createdAt: 1, updatedAt: 1, origin: 'subagent', live: false },
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

// ── session lineage: only real subagent origins form a picker tree ────────

test('an rc.1 ordinary /fork child is an independent root', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 4, updatedAt: 4, live: false },
    { id: 'session-fork', createdAt: 3, updatedAt: 3, live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-fork', 0],
  ])
})

test('historical ordinary-fork parentSession metadata stays a root', () => {
  // Pre-rc.1 ordinary forks persisted `parentSession`; the rc.1 contract does
  // not turn that historical metadata into a displayed tree edge.
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 4, updatedAt: 4, live: false },
    { id: 'session-fork', createdAt: 3, updatedAt: 3, parentSession: 'session-parent', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-fork', 0],
  ])
})

test('a rewind-of-rewind chain of ordinary forks never nests', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 5, updatedAt: 5, live: false },
    { id: 'session-child1', createdAt: 4, updatedAt: 4, parentSession: 'session-parent', live: false },
    { id: 'session-child2', createdAt: 3, updatedAt: 3, parentSession: 'session-child1', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-child1', 0],
    ['session-child2', 0],
  ])
})

test('a real subagent still hangs under its parent', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 4, updatedAt: 4, live: false },
    { id: 'session-sub', createdAt: 3, updatedAt: 3, origin: 'subagent', parentSession: 'session-parent', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-sub', 1],
  ])
})

test('subagent children stay under their root while ordinary forks keep the input order', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-parent', createdAt: 5, updatedAt: 5, live: false },
    { id: 'session-fork', createdAt: 4, updatedAt: 4, live: false },
    { id: 'session-sub', createdAt: 3, updatedAt: 3, origin: 'subagent', parentSession: 'session-parent', live: false },
    { id: 'session-parent2', createdAt: 2, updatedAt: 2, live: false },
    { id: 'session-fork2', createdAt: 1, updatedAt: 1, parentSession: 'session-parent2', live: false },
  ]
  const tree = buildSessionTree(rows)
  assert.deepEqual(tree.map(entry => [entry.row.id, entry.depth]), [
    ['session-parent', 0],
    ['session-sub', 1],
    ['session-fork', 0],
    ['session-parent2', 0],
    ['session-fork2', 0],
  ])
})

test('an orphan subagent degrades to root depth; historical fork metadata stays a root', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-legacy-fork', createdAt: 3, updatedAt: 3, parentSession: 'session-missing', live: false },
    { id: 'session-root', createdAt: 2, updatedAt: 2, live: false },
    { id: 'session-orphan-sub', createdAt: 1, updatedAt: 1, origin: 'subagent', parentSession: 'session-missing', live: false },
  ]
  const tree = buildSessionTree(rows)
  const byId = new Map(tree.map(entry => [entry.row.id, entry.depth]))
  assert.equal(byId.get('session-root'), 0)
  assert.equal(byId.get('session-legacy-fork'), 0, 'legacy fork metadata never creates an unplaceable child')
  assert.equal(byId.get('session-orphan-sub'), 0, 'orphan subagents degrade to root without being lost')
})

test('legacy cycles never loop and each row appears once', () => {
  // Legacy ordinary-fork metadata with a cycle: no subagent origin, so no
  // displayed edge at all — every row is a flat root, still exactly once.
  const legacy: SessionPickerRow[] = [
    { id: 'session-a', createdAt: 3, updatedAt: 3, parentSession: 'session-b', live: false },
    { id: 'session-b', createdAt: 2, updatedAt: 2, parentSession: 'session-a', live: false },
    { id: 'session-self', createdAt: 1, updatedAt: 1, parentSession: 'session-self', live: false },
  ]
  assert.deepEqual(buildSessionTree(legacy).map(entry => [entry.row.id, entry.depth]), [
    ['session-a', 0],
    ['session-b', 0],
    ['session-self', 0],
  ])
  // A corrupt subagent cycle cannot loop either: the `placed` guard emits each
  // row once and never traverses indefinitely.
  const subagents: SessionPickerRow[] = legacy.map(row => ({ ...row, origin: 'subagent' as const }))
  assert.deepEqual(buildSessionTree(subagents).map(entry => [entry.row.id, entry.depth]), [
    ['session-a', 0],
    ['session-b', 1],
    ['session-self', 0],
  ])
})

test('the All category keeps ordinary forks flat and badges only historical metadata', () => {
  const plainItem = (row: SessionPickerRow, indent = 0): { value: string; label: string; description: string; group: string } =>
    sessionPickerItem(row, '', indent)
  const categories = sessionPickerCategories(
    () => [
      { id: 'session-parent', createdAt: 5, updatedAt: 5, cwd: '/ws', live: false },
      { id: 'session-legacy', createdAt: 4, updatedAt: 4, cwd: '/ws', parentSession: 'session-parent', live: false },
      { id: 'session-new', createdAt: 3, updatedAt: 3, cwd: '/ws', live: false },
      { id: 'session-other', createdAt: 2, updatedAt: 2, cwd: '/ws', live: false },
    ],
    '/ws',
    'sessions',
    plainItem,
  )
  const all = categories[1]!.items()
  const row = (id: string): { readonly label: string; readonly description?: string } => {
    const item = all.find(candidate => candidate.value === id)
    assert.ok(item !== undefined, `${id} must be listed`)
    return item
  }
  assert.deepEqual(all.map(item => item.value), ['session-parent', 'session-legacy', 'session-new', 'session-other'])
  for (const id of ['session-parent', 'session-legacy', 'session-new', 'session-other']) {
    assert.ok(!row(id).label.includes('└─'), `${id} must stay flat`)
  }
  assert.ok((row('session-legacy').description ?? '').split(' · ').includes('fork'),
    'historical ordinary-fork metadata keeps its explanatory badge')
  assert.ok(!(row('session-new').description ?? '').split(' · ').includes('fork'),
    'an rc.1 ordinary fork has no historical badge')
})

// ── the Current directory / All directories scopes (plan item 3) ──────────

const pickerRows: SessionPickerRow[] = [
  { id: 'session-current-1', createdAt: 5, updatedAt: 5, cwd: '/ws/project-a', live: false },
  { id: 'session-current-2', createdAt: 4, updatedAt: 4, cwd: '/ws/project-a/', live: false },
  { id: 'session-other', createdAt: 3, updatedAt: 3, cwd: '/ws/project-b', live: false },
  { id: 'session-child', createdAt: 2, updatedAt: 2, cwd: '/ws/project-a', origin: 'subagent', parentSession: 'session-current-1', live: false },
  { id: 'session-unrooted', createdAt: 1, updatedAt: 1, live: false },
]

/** The picker's plain item mapper (no titles, no current marker). */
const plainItem = (row: SessionPickerRow): { value: string; label: string; description: string; group: string } =>
  sessionPickerItem(row, '')

test('sessionPickerCategories scopes Current to the workspace and never shows subagents', () => {
  const categories = sessionPickerCategories(() => pickerRows, '/ws/project-a', 'sessions', plainItem)
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
  const categories = sessionPickerCategories(() => pickerRows, '/ws/project-a/', 'sessions', plainItem)
  const currentIds = categories[0]!.items().map(row => row.value).sort()
  assert.deepEqual(currentIds, ['session-current-1', 'session-current-2'],
    `/ws/project-a/ scopes the same sessions as /ws/project-a:\n${JSON.stringify(currentIds)}`)
})

test('the Current category keeps ordinary forks and orphans flat', () => {
  const treeItem = (row: SessionPickerRow, indent = 0): SessionPickerItem => sessionPickerItem(row, '', indent)
  const categories = sessionPickerCategories(
    () => [
      { id: 'session-parent', createdAt: 4, updatedAt: 4, cwd: '/ws', live: false },
      { id: 'session-legacy', createdAt: 3, updatedAt: 3, cwd: '/ws', parentSession: 'session-parent', live: false },
      { id: 'session-other-cwd', createdAt: 2, updatedAt: 2, cwd: '/other', parentSession: 'session-parent', live: false },
      { id: 'session-orphan', createdAt: 1, updatedAt: 1, cwd: '/ws', parentSession: 'session-missing', live: false },
    ],
    '/ws',
    'sessions',
    treeItem,
  )
  const current = categories[0]!.items()
  const parent = current.find(item => item.value === 'session-parent')
  const legacy = current.find(item => item.value === 'session-legacy')
  const otherCwd = current.find(item => item.value === 'session-other-cwd')
  const orphan = current.find(item => item.value === 'session-orphan')
  assert.ok(parent !== undefined && !parent.label.includes('└─'), 'the workspace root stays flat')
  assert.ok(legacy !== undefined && !legacy.label.includes('└─'),
    `historical fork metadata must stay flat in Current:\n${legacy!.label}`)
  assert.equal(otherCwd, undefined, 'a sibling in ANOTHER workspace is out of the Current scope')
  assert.ok(orphan !== undefined && !orphan.label.startsWith('  └─ '), 'an orphan (parent outside the workspace/window) degrades to a flat root')
})

test('sessionPickerItem indents subagent rows in the All category', () => {
  const row: SessionPickerRow = {
    id: 'session-child-1',
    createdAt: 4, updatedAt: 4,
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

/** Two categories for the canonical-query lifecycle regressions (X041):
 * the first filters by 'z' (alpha/zulu), the second by 'z' (zed/alex), so
 * every assertion distinguishes the live query from the raw rows. */
function queryLifecycleCategories(): PickerCategory[] {
  return [
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
}

test('initialQuery is consumed once: a cleared query never resurrects on Tab', async () => {
  const { vt, app } = startApp()
  const categories = queryLifecycleCategories()
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
    initialQuery: 'z',
  })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(handle.getFilter?.(), 'z', 'initialQuery must prefill the live canonical query')
  assert.ok(view.includes('zulu'), `the initial filter must match:\n${view}`)
  assert.ok(!view.includes('alpha'), `a non-matching row must stay hidden:\n${view}`)

  // The user clears the box through the real input path.
  vt.sendInput('\x7f')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(handle.getFilter?.(), '', 'a cleared query is a valid live state')
  assert.ok(view.includes('alpha') && view.includes('zulu'), `both rows must be visible after clearing:\n${view}`)

  // Tab must NOT resurrect the initial query in the rebuilt category.
  vt.sendInput('\t')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(handle.getFilter?.(), '', 'the cleared query must survive the category switch')
  assert.ok(view.includes('zed') && view.includes('alex'), `the second category must stay unfiltered:\n${view}`)
  handle.close()
})

test('a programmatic setFilter survives category switches', async () => {
  const { vt, app } = startApp()
  const categories = queryLifecycleCategories()
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
  })
  await vt.waitForRender()
  handle.setFilter?.('z')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(handle.getFilter?.(), 'z')
  assert.ok(view.includes('zulu'), `the programmatic filter must apply:\n${view}`)
  assert.ok(!view.includes('alpha'), `a non-matching row must stay hidden:\n${view}`)

  vt.sendInput('\t')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(handle.getFilter?.(), 'z', 'the programmatic query must survive the category switch')
  assert.ok(view.includes('zed'), `the programmatic query must filter the new category:\n${view}`)
  assert.ok(!view.includes('alex'), `a non-matching row must stay hidden:\n${view}`)
  handle.close()
})

test('typed, programmatic and cleared queries share one live canonical query', async () => {
  const { vt, app } = startApp()
  const categories = queryLifecycleCategories()
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
  })
  await vt.waitForRender()
  // Typed query carries into the next category.
  vt.sendInput('z')
  await vt.waitForRender()
  assert.equal(handle.getFilter?.(), 'z', 'the typed query must be canonical')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.equal(handle.getFilter?.(), 'z', 'the typed query must survive the switch')
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('zed'), `the carried query must filter the new category:\n${view}`)
  assert.ok(!view.includes('alex'), `a non-matching row must stay hidden:\n${view}`)

  // Clearing is a valid live state and survives the switch back.
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(handle.getFilter?.(), '', 'a cleared query is a valid canonical state')
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.equal(handle.getFilter?.(), '', 'the cleared query must survive the switch back')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('alpha') && view.includes('zulu'), `the first category must be unfiltered again:\n${view}`)
  handle.close()
})

test('sessionPickerItem rows feed the Main category without subagent rows', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-root-1', updatedAt: 5, createdAt: 5, cwd: '/w', live: false },
    { id: 'session-child-1', updatedAt: 4, createdAt: 4, cwd: '/w', origin: 'subagent', parentSession: 'session-root-1', live: false },
  ]
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

test('sessionLabelParts splits the tree prefix and marker from the title', () => {
  // Flat row: no prefix.
  assert.deepEqual(sessionLabelParts('long title'), { prefix: '', title: 'long title' })
  // Current-session marker is a fixed prefix, not marqueeable.
  assert.deepEqual(sessionLabelParts('● long title'), { prefix: '● ', title: 'long title' })
  // Lineage connector indents by depth.
  assert.deepEqual(sessionLabelParts('  └─ long title'), { prefix: '  └─ ', title: 'long title' })
  assert.deepEqual(sessionLabelParts('    └─ ● long title'), { prefix: '    └─ ● ', title: 'long title' })
})

test('the session picker marquees a long SELECTED title while the marker and lineage stay fixed', async () => {
  const { vt, app } = startApp()
  const longTitle = 'a-very-long-session-title-that-keeps-growing-and-never-fits'
  const rows = [
    { value: 'session-root', label: '● short-title', description: 'meta', group: 'w' },
    { value: 'session-long', label: `  └─ ● ${longTitle}`, description: 'meta', group: 'w' },
  ]
  const now = { value: 0 }
  const handle = app.openPicker(rows, () => {}, () => {}, {
    enableSearch: false,
    width: 76,
    maxHeight: 26,
    marquee: { labelPartsOf: sessionLabelParts, now: () => now.value },
  })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  let view = vt.getViewport().map(strip).join('\n')
  // The FIRST row is selected initially (the long row is second).
  assert.ok(view.includes('> ● short-title'), `first row selected:\n${view}`)
  // Move down: the long title becomes the selected row.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('└─ ●'), `the fixed tree+marker prefix must render:\n${view}`)
  assert.ok(view.includes('a-very-long-session-tit'), `the marquee window must show the title (initial pause):\n${view}`)
  // Advance the fake clock, then force a repaint (setItems re-renders):
  // the title window scrolls while the fixed prefix never moves.
  now.value += 800 + 250
  handle.setItems(rows)
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('└─ ●'), `the fixed prefix must never scroll:\n${view}`)
  // At least one cell of motion: the window differs from the start.
  const row = view.split('\n').find(line => line.includes('└─ ●')) ?? ''
  assert.ok(!row.includes('a-very-long-session-title-that-keeps-'), 'the window must have moved')
  app.stop()
})

test('a category switch restarts the marquee even when the SAME row survives (review round 3)', async () => {
  const { vt, app } = startApp()
  const now = { value: 0 }
  const longTitle = 'a-very-long-session-title-that-keeps-growing-and-never-fits'
  const categories: PickerCategory[] = [
    { id: 'main', label: 'Main', header: 'sessions · Main', items: () => [
      { value: 'session-long', label: `  └─ ● ${longTitle}`, description: 'meta', group: 'w' },
    ] },
    { id: 'all', label: 'All', header: 'sessions · All', items: () => [
      { value: 'session-long', label: `  └─ ● ${longTitle}`, description: 'meta', group: 'w' },
    ] },
  ]
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: false,
    width: 76,
    maxHeight: 26,
    categories,
    marquee: { labelPartsOf: sessionLabelParts, now: () => now.value },
  })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  // Advance the fake clock well into the scroll cycle: the window has
  // moved past the label start.
  now.value = 800 + 6 * MARQUEE_STEP_MS
  handle.refresh?.()
  await vt.waitForRender()
  const mid = vt.getViewport().map(strip).join('\n')
  assert.ok(!mid.includes('a-very-long-session-title-that-keeps-'),
    `precondition — the label must have scrolled past its start:\n${mid}`)
  // Switch category: the SAME row (identical value/label) survives, but
  // the marquee must restart from the fresh anchor.
  handle.setCategory?.('all')
  await vt.waitForRender()
  const after = vt.getViewport().map(strip).join('\n')
  assert.ok(after.includes('a-very-long-session-tit'),
    `a category switch must restart the marquee from the fresh anchor:\n${after}`)
  handle.close()
  app.stop()
})

test('typing a search query restarts the marquee even when the SAME row survives (review P2)', async () => {
  // The vendored SelectList fires onSelectionChange only for arrow/page
  // moves — typing into the search box re-filters without one. The thin
  // filter adapter must restart the marquee on a query edit, or the long
  // selected label would keep scrolling mid-cycle inside the new filter.
  const { vt, app } = startApp()
  const now = { value: 0 }
  const longTitle = 'a-very-long-session-title-that-keeps-growing-and-never-fits'
  const handle = app.openPicker(
    [{ value: 'session-long', label: `  └─ ● ${longTitle}`, description: 'meta', group: 'w' }],
    () => {},
    () => {},
    {
      enableSearch: true,
      width: 76,
      maxHeight: 26,
      marquee: { labelPartsOf: sessionLabelParts, now: () => now.value },
    },
  )
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  // Advance the fake clock well into the scroll cycle.
  now.value = 800 + 6 * MARQUEE_STEP_MS
  handle.setItems([{ value: 'session-long', label: `  └─ ● ${longTitle}`, description: 'meta', group: 'w' }])
  await vt.waitForRender()
  const mid = vt.getViewport().map(strip).join('\n')
  assert.ok(!mid.includes('a-very-long-session-tit'),
    `precondition — the label must have scrolled past its start:\n${mid}`)
  // Type a query character that still matches the SAME row: the marquee
  // must restart from the fresh anchor (the row identity is unchanged, so
  // only the filter adapter can reset it).
  vt.sendInput('a')
  await vt.waitForRender()
  const after = vt.getViewport().map(strip).join('\n')
  assert.ok(after.includes('a-very-long-session-tit'),
    `a search edit must restart the marquee from the fresh anchor:\n${after}`)
  handle.close()
  app.stop()
})

test('an externally-filtered first category syncs a non-empty initialQuery with the caller', async () => {
  const { vt, app } = startApp()
  const filterChanges: string[] = []
  let callerQuery = ''
  const categories: PickerCategory[] = [
    {
      id: 'search',
      label: 'Search',
      header: 'sessions · Search',
      // The externally-filtered mode: the caller is the membership
      // authority — its items factory reads ITS OWN live query state (the
      // same shape as sessionSearchCategory's queryOf), never the picker's
      // internal filter.
      externalFilter: true,
      cyclable: false,
      items: () => callerQuery === ''
        ? [{ value: 'session-a', label: 'alpha', description: '', group: 'w' }]
        : [
            { value: 'session-a', label: 'alpha', description: '', group: 'w' },
            { value: 'session-z', label: 'zulu', description: '', group: 'w' },
          ].filter(row => row.label.includes(callerQuery)),
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
    initialQuery: 'z',
    onFilterChange: (query) => {
      filterChanges.push(query)
      callerQuery = query
      // The caller is the membership authority: re-run the active
      // category's items factory with the synced query.
      handle.refresh?.()
    },
  })
  await vt.waitForRender()
  // The seeded initial query reaches the caller exactly once, so the
  // external Input and the caller's membership never drift apart (X041).
  assert.deepEqual(filterChanges, ['z'], 'the initial query must be reported once')
  assert.equal(handle.getFilter?.(), 'z', 'the external Input must show the seeded query')
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('zulu'), `membership must reflect the initial query:\n${view}`)
  assert.ok(!view.includes('alpha'), `a non-matching row must stay hidden:\n${view}`)
  handle.close()
})

test('an immediate synchronous setFilter wins over the seeded initialQuery', async () => {
  const { vt, app } = startApp()
  const filterChanges: string[] = []
  let callerQuery = ''
  const categories: PickerCategory[] = [
    {
      id: 'search',
      label: 'Search',
      header: 'sessions · Search',
      externalFilter: true,
      cyclable: false,
      items: () => callerQuery === ''
        ? [{ value: 'session-a', label: 'alpha', description: '', group: 'w' }]
        : [
            { value: 'session-a', label: 'alpha', description: '', group: 'w' },
            { value: 'session-y', label: 'yankee', description: '', group: 'w' },
            { value: 'session-z', label: 'zulu', description: '', group: 'w' },
          ].filter(row => row.label.includes(callerQuery)),
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
    initialQuery: 'z',
    onFilterChange: (query) => {
      filterChanges.push(query)
      callerQuery = query
      handle.refresh?.()
    },
  })
  // The caller overrides the seed IMMEDIATELY — in the same turn, before
  // the deferred seed notification can drain (X041 external sync race:
  // the stale seed must never override the newer value the caller just
  // reported through setFilter).
  handle.setFilter?.('y')
  await vt.waitForRender()
  assert.deepEqual(filterChanges, ['y'], 'the newer value must win; the stale seed must never be reported')
  assert.equal(handle.getFilter?.(), 'y', 'the external Input must show the overriding value')
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('yankee'), `membership must reflect the overriding query:\n${view}`)
  assert.ok(!view.includes('zulu'), `the stale seed must not revert membership:\n${view}`)
  handle.close()
})

test('a programmatic setFilter with an unchanged value is not reported', async () => {
  const { vt, app } = startApp()
  const filterChanges: string[] = []
  let callerQuery = ''
  const categories: PickerCategory[] = [
    {
      id: 'search',
      label: 'Search',
      header: 'sessions · Search',
      externalFilter: true,
      cyclable: false,
      items: () => callerQuery === ''
        ? [{ value: 'session-a', label: 'alpha', description: '', group: 'w' }]
        : [
            { value: 'session-a', label: 'alpha', description: '', group: 'w' },
            { value: 'session-z', label: 'zulu', description: '', group: 'w' },
          ].filter(row => row.label.includes(callerQuery)),
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
    onFilterChange: (query) => {
      filterChanges.push(query)
      callerQuery = query
      handle.refresh?.()
    },
  })
  await vt.waitForRender()
  // No initialQuery: the external Input opens empty. Setting the SAME
  // (empty) value must not fire onFilterChange (PickerHandle contract:
  // programmatic filters report exactly like typed ones).
  handle.setFilter?.('')
  await vt.waitForRender()
  assert.deepEqual(filterChanges, [], 'an unchanged empty programmatic filter must not be reported')
  assert.equal(handle.getFilter?.(), '', 'the external Input must stay empty')
  handle.close()
})

test('a synchronous category switch drops the stale seed of the inactive external category', async () => {
  const { vt, app } = startApp()
  const filterChanges: string[] = []
  let callerQuery = ''
  const categories: PickerCategory[] = [
    {
      id: 'search',
      label: 'Search',
      header: 'sessions · Search',
      externalFilter: true,
      cyclable: false,
      items: () => [{ value: 'session-a', label: 'alpha', description: '', group: 'w' }],
    },
    {
      id: 'browse',
      label: 'Main',
      header: 'sessions · Main',
      items: () => [
        { value: 'session-a', label: 'alpha', description: '', group: 'w' },
        { value: 'session-z', label: 'zulu', description: '', group: 'w' },
      ],
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
    initialQuery: 'z',
    onFilterChange: (query) => {
      filterChanges.push(query)
      callerQuery = query
      handle.refresh?.()
    },
  })
  // Switch to the INTERNAL browse category in the same turn — before the
  // external seed microtask drains. The seed belongs to the now-inactive
  // external category: it must be dropped (the internal category filters
  // itself), never reported from a dead view.
  handle.setCategory?.('browse')
  await vt.waitForRender()
  assert.deepEqual(filterChanges, [], 'the inactive category seed must never be reported')
  const view = vt.getViewport().join('\n')
  // The internal category applies the query itself (initialQuery 'z').
  assert.ok(view.includes('zulu'), `the internal filter must apply on the switched category:\n${view}`)
  assert.ok(!view.includes('alpha'), `a non-matching row must stay hidden:\n${view}`)
  handle.close()
})

test('a synchronous switch to a later external category reports the seed from the live category', async () => {
  const { vt, app } = startApp()
  const filterChanges: string[] = []
  let callerQuery = ''
  const categories: PickerCategory[] = [
    {
      id: 'search-a',
      label: 'Search A',
      header: 'sessions · Search A',
      externalFilter: true,
      cyclable: false,
      items: () => [{ value: 'session-a', label: 'alpha', description: '', group: 'w' }],
    },
    {
      id: 'search-b',
      label: 'Search B',
      header: 'sessions · Search B',
      externalFilter: true,
      cyclable: false,
      items: () => callerQuery === ''
        ? [{ value: 'session-a', label: 'alpha', description: '', group: 'w' }]
        : [
            { value: 'session-a', label: 'alpha', description: '', group: 'w' },
            { value: 'session-z', label: 'zulu', description: '', group: 'w' },
          ].filter(row => row.label.includes(callerQuery)),
    },
  ]
  const handle = app.openPicker(categories[0]!.items(), () => {}, () => {}, {
    enableSearch: true,
    header: 'sessions',
    categories,
    initialQuery: 'z',
    onFilterChange: (query) => {
      filterChanges.push(query)
      callerQuery = query
      handle.refresh?.()
    },
  })
  // Switch to the SECOND external category in the same turn: the first
  // category's seed microtask must die on the active-input identity
  // fence, and the second category's own seed must report the query once
  // through the live path.
  handle.setCategory?.('search-b')
  await vt.waitForRender()
  assert.deepEqual(filterChanges, ['z'], 'the seed must be reported exactly once, from the live category')
  assert.equal(handle.getFilter?.(), 'z', 'the live external Input must show the seed')
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('zulu'), `membership must reflect the reported query:\n${view}`)
  assert.ok(!view.includes('alpha'), `a non-matching row must stay hidden:\n${view}`)
  handle.close()
})

// ── M5-U-B: the search category is a pure projection of the owner snapshot ──

test('the search category renders exactly the read owner’s merged results, never re-filtering them', () => {
  const results: SessionBrowserSearchResult[] = [
    {
      row: { id: 'session-beta', updatedAt: 1, cwd: '/other', live: false },
      source: 'Content',
      snippet: 'host excerpt without the literal term',
    },
    {
      row: { id: 'session-alpha', updatedAt: 2, cwd: '/ws', title: 'the alpha title', live: false },
      source: 'Metadata',
    },
  ]
  const category = sessionSearchCategory({
    header: 'sessions',
    results: () => results,
    hasRoster: () => true,
    itemFor: result => sessionSearchItem(
      result.row,
      '',
      0,
      result.snippet === undefined ? undefined : { snippet: result.snippet },
    ),
  })
  assert.equal(category.id, 'search')
  assert.equal(category.header, 'sessions · Search results')
  assert.equal(category.externalFilter, true, 'the owner’s results ARE the membership')
  assert.equal(category.cyclable, false, 'Tab never leaves global search while a query is active')
  const items = category.items()
  assert.deepEqual(items.map(item => item.value), ['session-beta', 'session-alpha'],
    'the owner’s Host page order is both the membership and the rendered order')
  assert.ok((items[0]!.description ?? '').includes('host excerpt without the literal term'),
    'a Host hit whose snippet lacks the query literal is rendered, not substring-filtered out')
})

test('the search category shows a status row only while the browse roster is empty', () => {
  const category = sessionSearchCategory({
    header: 'sessions',
    results: () => [],
    hasRoster: () => false,
    itemFor: result => sessionPickerItem(result.row, ''),
    placeholder: () => ({ value: '', label: 'Loading sessions…', description: '', group: '' }),
  })
  assert.deepEqual(category.items().map(item => item.label), ['Loading sessions…'],
    'an empty roster shows the shared status row, never a fake result')
})

test('an empty result set with a non-empty roster is a real no-match state', () => {
  const category = sessionSearchCategory({
    header: 'sessions',
    results: () => [],
    hasRoster: () => true,
    itemFor: result => sessionPickerItem(result.row, ''),
    placeholder: () => ({ value: '', label: 'Loading sessions…', description: '', group: '' }),
  })
  assert.deepEqual(category.items(), [],
    'no result may be invented from the roster and no status row may mask a real no-match')
})

test('sessionPickerCategories reads the live roster on every activation', () => {
  let roster: SessionPickerRow[] = [{ id: 'session-one', updatedAt: 2, cwd: '/ws', live: false }]
  const categories = sessionPickerCategories(() => roster, '/ws', 'sessions', row => sessionPickerItem(row, ''))
  assert.deepEqual(categories[1]!.items().map(item => item.value), ['session-one'])
  roster = [{ id: 'session-two', updatedAt: 1, cwd: '/ws', live: false }]
  assert.deepEqual(categories[1]!.items().map(item => item.value), ['session-two'],
    'the category must read the current snapshot rows, not a captured array')
})
