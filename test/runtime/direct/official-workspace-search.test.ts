/**
 * Unit contract for the bounded official workspace search cache
 * (`runtime/direct/file-completion/official-workspace-search.ts`, M6-1/F5-B
 * §4.4): at most four resident official indexes, least-recently-read eviction
 * while idle, no eviction of an index that is still answering, one temporary
 * official search when every slot is busy, `tool/result` invalidation, and a
 * disposal that aborts and releases every index.
 *
 * The official `WorkspaceFileSearch` itself is the published DSH primitive; it
 * is never re-implemented here.
 *
 * @module @xmoon76/dsh-pi-tui/official-workspace-search.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
} from '@deepseek-ai/dsh-file-reference-local/search'
import { OfficialWorkspaceSearchPool } from '../../../src/runtime/direct/file-completion/official-workspace-search.ts'
import { testLifecycle, type TestLifecycle } from '../../support/temp-lifecycle.ts'

const abort = new AbortController().signal

function fixtureRoot(life: TestLifecycle, label: string, file: string): string {
  const root = life.tempDir(`dsh-f5b-search-${label}-`)
  writeFileSync(join(root, file), 'x')
  return root
}

test('a repeated Workspace query reuses ONE resident official index', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureRoot(life, 'reuse', 'wanted.ts')
  const pool = new OfficialWorkspaceSearchPool()
  try {
    const first = await pool.list({ workspaceId: 'w', path: root }, 'wanted', abort)
    const second = await pool.list({ workspaceId: 'w', path: root }, 'wanted', abort)
    assert.deepEqual(second, first)
    assert.equal(pool.residentIndexes, 1)
  } finally {
    pool.dispose()
  }
})

test('the cache keeps at most FOUR resident indexes, evicting the least-recently-read', async (t) => {
  const life = testLifecycle(t)
  const roots = ['a', 'b', 'c', 'd', 'e'].map(label => ({ workspaceId: label, path: fixtureRoot(life, `cap-${label}`, 'x.ts') }))
  const pool = new OfficialWorkspaceSearchPool()
  try {
    for (const root of roots.slice(0, 4)) {
      await pool.list(root, 'x', abort)
    }
    // Re-read the FIRST one so it is the most recent; the second is now LRU.
    await pool.list(roots[0]!, 'x', abort)
    assert.equal(pool.residentIndexes, 4)
    await pool.list(roots[4]!, 'x', abort)
    assert.equal(pool.residentIndexes, 4, 'the fifth index never grows the cache past its budget')
  } finally {
    pool.dispose()
  }
})

test('a fifth Workspace queried while all four indexes are answering runs a TEMPORARY official search', async (t) => {
  const life = testLifecycle(t)
  const roots = ['a', 'b', 'c', 'd', 'e'].map(label => ({ workspaceId: label, path: fixtureRoot(life, `busy-${label}`, 'busy.ts') }))
  const pool = new OfficialWorkspaceSearchPool()
  try {
    // Four scans are in flight synchronously (`active` increments before the
    // official traversal await), so no slot is idle for the fifth query.
    const busy = roots.slice(0, 4).map(root => pool.list(root, 'busy', abort))
    const fifth = pool.list(roots[4]!, 'busy', abort)
    const fifthItems = await fifth
    assert.deepEqual(fifthItems, [{ path: 'busy.ts', kind: 'file' }], 'the busy case still answers from the official engine')
    await Promise.all(busy)
    assert.equal(pool.residentIndexes, 4, 'a live index is never interrupted and the map never exceeds the budget')
  } finally {
    pool.dispose()
  }
})

test('invalidateAll marks every resident index stale; dispose aborts and releases them', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureRoot(life, 'invalidate', 'before.ts')
  const pool = new OfficialWorkspaceSearchPool()
  const original = WorkspaceFileSearch.prototype.invalidate
  let invalidations = 0
  WorkspaceFileSearch.prototype.invalidate = function invalidateSpy(this: WorkspaceFileSearch): void {
    invalidations += 1
    original.call(this)
  }
  try {
    await pool.list({ workspaceId: 'w', path: root }, 'before', abort)
    pool.invalidateAll()
    assert.equal(invalidations, 1, 'the Host tool/result hook invalidates the ONE resident index')
    mkdirSync(join(root, 'later'))
    writeFileSync(join(root, 'later', 'after.ts'), 'x')
    // The official stale index answers while its replacement builds; the
    // rebuilt index observes the new path on a later bare query.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const items = await pool.list({ workspaceId: 'w', path: root }, 'after', abort)
      if (items.some(item => item.path === 'later/after.ts')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const items = await pool.list({ workspaceId: 'w', path: root }, 'after', abort)
    assert.ok(items.some(item => item.path === 'later/after.ts'),
      `the invalidated index never observed the new file: ${JSON.stringify(items)}`)
    assert.ok(items.length <= DEFAULT_FILE_SEARCH_MAX_RESULTS)
  } finally {
    WorkspaceFileSearch.prototype.invalidate = original
    pool.dispose()
  }
  assert.equal(pool.residentIndexes, 0, 'dispose released every resident index')
  await assert.rejects(pool.list({ workspaceId: 'w', path: root }, 'x', abort), /disposed/u)
})
