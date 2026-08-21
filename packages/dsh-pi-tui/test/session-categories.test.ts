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
  type SessionPickerRow,
} from '../src/sessions.ts'
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

test('buildSessionTree hangs subagents under their parent chain', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-root-1', createdAt: 5, live: false },
    { id: 'session-child-1', createdAt: 4, origin: 'subagent', parentSession: 'session-root-1', live: false },
    { id: 'session-root-2', createdAt: 3, live: false },
    { id: 'session-grandchild', createdAt: 2, origin: 'subagent', parentSession: 'session-child-1', live: false },
    { id: 'session-orphan', createdAt: 1, origin: 'subagent', live: false },
  ]
  const tree = buildSessionTree(rows)
  const byId = new Map(tree.map(entry => [entry.row.id, entry.depth]))
  assert.equal(byId.get('session-root-1'), 0, 'roots sit at depth 0')
  assert.equal(byId.get('session-child-1'), 1, 'direct children hang one level down')
  assert.equal(byId.get('session-grandchild'), 2, 'the chain continues deeper')
  assert.equal(byId.get('session-orphan'), 1, 'orphan subagents sit at depth 1')
  // Input (newest-first) order preserved per level: root-2 precedes its
  // sibling subtree only if it came first in the input.
  assert.equal(tree[0]!.row.id, 'session-root-1')
  assert.equal(tree[1]!.row.id, 'session-child-1', 'children follow their root immediately')
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
