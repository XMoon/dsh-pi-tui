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
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createSurfaceRuntime, type SurfaceEventRoutingSource } from '../../src/app/surface/runtime.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'

/** The null terminal notification presentation (this fixture exercises the
 *  surface aggregate, never terminal sequences). */
const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function assistant(seq: number, turn: number, text: string): SessionEvent {
  return event('assistant/message', {
    turn,
    step: 0,
    message: {
      id: MessageId(`assistant-${turn}-${seq}`),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
    stream: [],
  }, seq)
}

function delivery(seq: number, turn: number, files: readonly Record<string, unknown>[]): SessionEvent {
  return event('deliverables/presented', { turn, callId: `present-${turn}`, files: [...files] }, seq)
}

/** One Turn's real durable lifecycle, closing with a delivered Assistant. */
function deliveredTurn(turn: number, files: readonly Record<string, unknown>[], base: number): SessionEvent[] {
  return [
    event('turn/start', { turn }, base),
    delivery(base + 1, turn, files),
    assistant(base + 2, turn, `final ${turn}`),
    event('turn/end', { turn, reason: { kind: 'completed' } }, base + 3),
  ]
}

/** The stub event-routing source: only the members the snapshot reads are
 *  meaningful, every other member is an inert placeholder. */
function routingSource(facts: {
  sessionId: () => string | undefined
  mainFolder: () => TranscriptFolder
  viewedChildId?: () => string | undefined
  viewedChildFolder?: () => TranscriptFolder
}): SurfaceEventRoutingSource<never> {
  const window = new TranscriptWindowController()
  return {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: facts.sessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      setTranscript: () => {},
      setStreamingToolPreviews: () => {},
      setTurnActivity: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: facts.viewedChildId ?? (() => undefined),
    viewedChild: () => ({
      window,
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    mainFolder: facts.mainFolder,
    viewedChildFolder: facts.viewedChildFolder ?? (() => { throw new Error('no viewed child') }),
  } as unknown as SurfaceEventRoutingSource<never>
}

type Surface = ReturnType<typeof createSurfaceRuntime>

function mountedSurface(source: SurfaceEventRoutingSource<never>): Surface {
  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  surface.attachEventRouting(source as never)
  return surface
}

const surfaces: Surface[] = []
afterEach(() => {
  while (surfaces.length > 0) surfaces.pop()?.dispose()
})

function surfaceFor(source: SurfaceEventRoutingSource<never>): Surface {
  const surface = mountedSurface(source)
  surfaces.push(surface)
  return surface
}

function deliveredFolder(): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.hydrate([
    ...deliveredTurn(1, [{ path: '/ws/a.md', description: 'first' }], 0),
    ...deliveredTurn(2, [{ path: '/ws/b.md' }], 10),
    ...deliveredTurn(3, [{ path: '/ws/docs/report.md', description: 'Final' }], 20),
  ])
  return folder
}

test('the snapshot derives every delivered Turn of the selected main subject', () => {
  const folder = deliveredFolder()
  const surface = surfaceFor(routingSource({ sessionId: () => 's1', mainFolder: () => folder }))

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
  const folder = deliveredFolder()
  const surface = surfaceFor(routingSource({ sessionId: () => 's1', mainFolder: () => folder }))

  // The DISPLAY window really is bounded: only the newest Turn survives.
  const boundedTurns = new Set(folder.messages({ maxTurns: 1 }).flatMap(message => 'turn' in message ? [message.turn] : []))
  assert.deepEqual([...boundedTurns], [3])

  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.turns.map(turn => turn.turn), [3, 2, 1],
    'the catalog comes from the full projection, never the bounded display window')
})

test('the viewed child is the subject, never the parent session', () => {
  const main = deliveredFolder()
  const child = new TranscriptFolder()
  child.hydrate([...deliveredTurn(7, [{ path: '/ws/child/report.md', description: 'child only' }], 0)])
  const surface = surfaceFor(routingSource({
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
  const surface = surfaceFor(routingSource({ sessionId: () => 's1', mainFolder: () => new TranscriptFolder() }))
  assert.equal(surface.deliveredFilesSnapshot(), undefined,
    'a cold fold without deliveries produces no overlay data')
})

test('no selected session at all yields no snapshot', () => {
  const folder = deliveredFolder()
  const surface = surfaceFor(routingSource({ sessionId: () => undefined, mainFolder: () => folder }))
  assert.equal(surface.deliveredFilesSnapshot(), undefined)
})

test('a replaced Folder for the same session makes the old snapshot stale', () => {
  let folder = deliveredFolder()
  const surface = surfaceFor(routingSource({ sessionId: () => 's1', mainFolder: () => folder }))
  const before = surface.deliveredFilesSnapshot()
  assert.ok(before !== undefined)
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(before), true)

  // Cold rehydrate: the SAME session id gets a freshly built Folder.
  folder = deliveredFolder()
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
  const folder = deliveredFolder()
  const surface = surfaceFor(routingSource({ sessionId: () => sessionId, mainFolder: () => folder }))
  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  sessionId = 's2'
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(snapshot), false)
})

test('a disposed surface answers nothing', () => {
  const folder = deliveredFolder()
  const surface = mountedSurface(routingSource({ sessionId: () => 's1', mainFolder: () => folder }))
  const snapshot = surface.deliveredFilesSnapshot()
  assert.ok(snapshot !== undefined)
  surface.dispose()
  assert.equal(surface.deliveredFilesSnapshot(), undefined)
  assert.equal(surface.isDeliveredFilesSnapshotCurrent(snapshot), false)
})
