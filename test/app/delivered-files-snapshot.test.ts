/**
 * Delivered-files snapshot (Delivered files PR1 / M2): the application owner
 * derives the CURRENT display subject's delivered Turns from the selected
 * Folder's FULL grouped projection, and the identity fence that makes an older
 * snapshot inoperable after a subject/Fold replacement.
 *
 * The fixtures use the REAL `TranscriptFolder` over real `deliverables/presented`
 * events, so the assertion chain is canonical event → fold → snapshot; nothing
 * pre-computes the expected `turns` for the snapshot.
 * @module @xmoon76/dsh-pi-tui/app/delivered-files-snapshot.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TranscriptFolder } from '../../src/transcript.ts'
import {
  deliveredFolder,
  deliveredSurfaceRouting,
  mountDeliveredSurface,
} from '../support/delivered-files.ts'

type Surface = ReturnType<typeof mountDeliveredSurface>

const surfaces: Surface[] = []
afterEach(() => {
  while (surfaces.length > 0) surfaces.pop()?.dispose()
})

function surfaceFor(source: ReturnType<typeof deliveredSurfaceRouting>): Surface {
  const surface = mountDeliveredSurface(source)
  surfaces.push(surface)
  return surface
}

test('the snapshot derives every delivered Turn of the selected main subject', () => {
  const folder = deliveredFolder([
    { turn: 1, files: [{ path: '/ws/a.md', description: 'first' }] },
    { turn: 2, files: ['/ws/b.md'] },
    { turn: 3, files: [{ path: '/ws/docs/report.md', description: 'Final' }] },
  ])
  const surface = surfaceFor(deliveredSurfaceRouting({ sessionId: () => 's1', mainFolder: () => folder }))

  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.subjectKind, 'main')
  assert.equal(snapshot.sessionId, 's1')
  assert.deepEqual(snapshot.turns, [
    { turn: 3, files: [{ path: '/ws/docs/report.md', description: 'Final' }] },
    { turn: 2, files: [{ path: '/ws/b.md' }] },
    { turn: 1, files: [{ path: '/ws/a.md', description: 'first' }] },
  ])
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(snapshot), true)
})

test('a bounded display window never truncates the delivered history', () => {
  const folder = deliveredFolder([
    { turn: 1, files: [{ path: '/ws/a.md', description: 'first' }] },
    { turn: 2, files: ['/ws/b.md'] },
    { turn: 3, files: [{ path: '/ws/docs/report.md', description: 'Final' }] },
  ])
  const surface = surfaceFor(deliveredSurfaceRouting({ sessionId: () => 's1', mainFolder: () => folder }))

  // The DISPLAY window really is bounded: only the newest Turn survives.
  const boundedTurns = new Set(folder.messages({ maxTurns: 1 }).flatMap(message => 'turn' in message ? [message.turn] : []))
  assert.deepEqual([...boundedTurns], [3])

  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.turns.map(turn => turn.turn), [3, 2, 1],
    'the catalog comes from the full projection, never the bounded display window')
})

test('the viewed child is the subject, never the parent session', () => {
  const main = deliveredFolder([{ turn: 1, files: ['/ws/parent.md'] }])
  const child = deliveredFolder([{ turn: 7, files: [{ path: '/ws/child/report.md', description: 'child only' }] }])
  const surface = surfaceFor(deliveredSurfaceRouting({
    sessionId: () => 'parent-1',
    mainFolder: () => main,
    viewedChildId: () => 'child-1',
    viewedChildFolder: () => child,
  }))

  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.subjectKind, 'viewed-child')
  assert.equal(snapshot.sessionId, 'child-1')
  assert.deepEqual(snapshot.turns, [{ turn: 7, files: [{ path: '/ws/child/report.md', description: 'child only' }] }],
    'the parent delivery never leaks into the child subject')
})

test('an empty delivery catalog is a valid "no subject data" answer', () => {
  const surface = surfaceFor(deliveredSurfaceRouting({ sessionId: () => 's1', mainFolder: () => new TranscriptFolder() }))
  assert.equal(surface.deliveredFilesSnapshot(), undefined,
    'a cold fold without deliveries produces no overlay data')
})

test('no selected session at all yields no snapshot', () => {
  const folder = deliveredFolder([
    { turn: 1, files: [{ path: '/ws/a.md', description: 'first' }] },
    { turn: 2, files: ['/ws/b.md'] },
    { turn: 3, files: [{ path: '/ws/docs/report.md', description: 'Final' }] },
  ])
  const surface = surfaceFor(deliveredSurfaceRouting({ sessionId: () => undefined, mainFolder: () => folder }))
  assert.equal(surface.deliveredFilesSnapshot(), undefined)
})

test('a replaced Folder for the same session makes the old snapshot stale', () => {
  let folder = deliveredFolder([{ turn: 1, files: ['/ws/a.md'] }])
  const surface = surfaceFor(deliveredSurfaceRouting({ sessionId: () => 's1', mainFolder: () => folder }))
  const before = surface.deliveredFilesSnapshot()
  assert.ok(before !== undefined)
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(before), true)

  // Cold rehydrate: the SAME session id gets a freshly built Folder.
  folder = deliveredFolder([{ turn: 1, files: ['/ws/a.md'] }])
  const after = surface.deliveredFilesSnapshot()
  assert.ok(after !== undefined)
  assert.notEqual(after.sourceIdentity, before.sourceIdentity,
    'the projection identity is the opaque per-source token, not the session id')
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(before), false,
    'an old panel must not read the replaced projection')
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(after), true)
})

test('a session-id change alone invalidates the snapshot', () => {
  let sessionId = 's1'
  const folder = deliveredFolder([
    { turn: 1, files: [{ path: '/ws/a.md', description: 'first' }] },
    { turn: 2, files: ['/ws/b.md'] },
    { turn: 3, files: [{ path: '/ws/docs/report.md', description: 'Final' }] },
  ])
  const surface = surfaceFor(deliveredSurfaceRouting({ sessionId: () => sessionId, mainFolder: () => folder }))
  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  sessionId = 's2'
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(snapshot), false)
})

test('a disposed surface answers nothing', () => {
  const folder = deliveredFolder([
    { turn: 1, files: [{ path: '/ws/a.md', description: 'first' }] },
    { turn: 2, files: ['/ws/b.md'] },
    { turn: 3, files: [{ path: '/ws/docs/report.md', description: 'Final' }] },
  ])
  const surface = mountDeliveredSurface(deliveredSurfaceRouting({ sessionId: () => 's1', mainFolder: () => folder }))
  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  surface.dispose()
  assert.equal(surface.deliveredFilesSnapshot(), undefined)
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(snapshot), false)
})
