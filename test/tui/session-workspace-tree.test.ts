/**
 * PR2 — the PiTUI-only action projection of the Session Workspace tree.
 *
 * These cases own the PURE projection only: official identity, visible
 * expansion and the action ordering. The real keyboard/mouse/rendering
 * contract lives in `test/tui/session-workspace-panel.test.ts`; the shared
 * official projection stays covered by `test/tui/session-workspace-view.test.ts`.
 * @module @xmoon76/dsh-pi-tui/session-workspace-tree.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADD_DIRECTORY_ROW_ID,
  projectPiTuiWorkspaceTree,
} from '../../src/tui/presentation/session-workspace-tree.ts'
import type { WorkspaceBrowserRow } from '../../src/tui/presentation/session-workspace-view.ts'

function folder(workspaceId: string, expanded: boolean): WorkspaceBrowserRow {
  return {
    kind: 'folder',
    id: `workspace:${workspaceId}`,
    workspaceId,
    title: workspaceId,
    path: `/${workspaceId}`,
    total: 1,
    needs: 0,
    working: 0,
    expanded,
    current: false,
    next: false,
  }
}

function session(workspaceId: string, sessionId: string): WorkspaceBrowserRow {
  return { kind: 'session', id: `session:${sessionId}`, workspaceId, sessionId }
}

function showMore(workspaceId: string): WorkspaceBrowserRow {
  return { kind: 'showMore', id: `more:${workspaceId}`, workspaceId, remaining: 3 }
}

const official = (...ids: string[]): ReadonlySet<string> => new Set(ids)

test('an expanded official Folder grows its first-child New row and keeps every shared row in order', () => {
  const base: WorkspaceBrowserRow[] = [folder('ws-a', true), session('ws-a', 's-a'), folder('ws-b', false)]
  const rows = projectPiTuiWorkspaceTree(base, official('ws-a', 'ws-b'), {
    mode: 'browse',
    canAddDirectory: true,
    canNewSession: true,
  })
  assert.deepEqual(rows.map(row => row.kind), ['addDirectory', 'folder', 'newSession', 'session', 'folder'])
  assert.equal(rows[0]!.id, ADD_DIRECTORY_ROW_ID)
  assert.deepEqual(rows.find(row => row.kind === 'newSession'), {
    kind: 'newSession',
    id: 'action:new-session:ws-a',
    workspaceId: 'ws-a',
  })
  // Every shared row keeps its own id and order; only PiTUI rows are added.
  const shared = rows.filter(row => row.kind === 'folder' || row.kind === 'session' || row.kind === 'showMore')
  assert.deepEqual(shared, base)
})

test('synthetic groups, the choose intent, and a missing capability never grow a create action', () => {
  const base: WorkspaceBrowserRow[] = [
    folder('official-expanded', true),
    session('official-expanded', 's-1'),
    folder('unassigned', true),
    session('unassigned', 's-2'),
    folder('ambiguous', true),
    showMore('ambiguous'),
  ]
  const browse = projectPiTuiWorkspaceTree(base, official('official-expanded'), {
    mode: 'browse',
    canAddDirectory: false,
    canNewSession: true,
  })
  assert.equal(browse.filter(row => row.kind === 'addDirectory').length, 0, 'no fabricated Add capability')
  assert.equal(browse.filter(row => row.kind === 'newSession').length, 1, 'only the official Folder grows New')
  assert.equal(browse.find(row => row.kind === 'newSession')!.workspaceId, 'official-expanded')

  const chooser = projectPiTuiWorkspaceTree(base, official('official-expanded'), {
    mode: 'choose-directory',
    canAddDirectory: true,
    canNewSession: true,
  })
  assert.equal(chooser.filter(row => row.kind === 'newSession').length, 0, 'the chooser never paints a create action')
  assert.ok(
    chooser.every(row => row.kind === 'addDirectory' || row.kind === 'folder' || row.kind === 'session' || row.kind === 'showMore'),
    'the chooser has no Use-directory row type',
  )

  const noCapability = projectPiTuiWorkspaceTree(base, official('official-expanded'), {
    mode: 'browse',
    canAddDirectory: false,
    canNewSession: false,
  })
  assert.equal(noCapability.filter(row => row.kind === 'newSession').length, 0, 'no create action without a real callback')
})

test('the adapter is a pure wrapper around the shared visible rows', () => {
  const base: WorkspaceBrowserRow[] = [folder('ws-a', false), showMore('ws-a')]
  const before = structuredClone(base)
  const rows = projectPiTuiWorkspaceTree(base, official('ws-a'), {
    mode: 'browse',
    canAddDirectory: true,
    canNewSession: true,
  })
  assert.deepEqual(base, before, 'the shared rows are never mutated')
  assert.ok(rows.every(row => row.kind !== ('newSession' as string)), 'a collapsed Folder hides New')
  // The TSP Native Picker consumes the shared Folder/Session/Show-more rows;
  // this adapter adds no PiTUI kind to that shared union.
  assert.deepEqual(rows.map(row => row.kind), ['addDirectory', 'folder', 'showMore'])
})
