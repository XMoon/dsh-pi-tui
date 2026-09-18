/**
 * Contract tests for the D2.2 submission-presentation seam: the Direct ledger and
 * the official Client `pendingSubmissions` both feed one read-only presentation
 * source, correlated by identity and never by text.
 * @module @xmoon76/dsh-pi-tui/submission-presentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingSubmissions, pendingSubmissionsNotReplaced } from '../src/pending-submission.ts'
import {
  DirectSubmissionPresentation,
  RemoteSubmissionPresentation,
  type RemoteSubmissionSessionFace,
  type RemoteSubmissionSessionsSource,
} from '../src/submission-presentation.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'

function generationHarness(): { source: RemoteConnectionGenerationSource; set(value: RemoteConnectionGeneration | undefined): void } {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function remoteSessions(byId: Readonly<Record<string, RemoteSubmissionSessionFace>>): RemoteSubmissionSessionsSource {
  return { binding: id => byId[id] === undefined ? undefined : { session: byId[id] } }
}

function sessionFace(pendingSubmissions: readonly unknown[]): RemoteSubmissionSessionFace {
  return { getSnapshot: () => ({ pendingSubmissions }) as ReturnType<RemoteSubmissionSessionFace['getSnapshot']> }
}

test('the Direct source preserves the ledger order, identity, placement, and text', () => {
  const ledger = new PendingSubmissions()
  ledger.begin({ requestId: 'req-a', placement: 'transcript', text: 'A', createdAt: 10, sessionId: 'session-a', generation: 1 })
  ledger.begin({ requestId: 'req-b', placement: 'queued', text: 'B', createdAt: 11, sessionId: 'session-a', generation: 1 })
  ledger.begin({ requestId: 'req-other', placement: 'queued', text: 'C', createdAt: 12, sessionId: 'session-b', generation: 1 })

  const source = new DirectSubmissionPresentation(ledger)
  assert.deepEqual(source.snapshot('session-a'), [
    { requestId: 'req-a', placement: 'transcript', text: 'A', createdAt: 10, attachments: [] },
    { requestId: 'req-b', placement: 'queued', text: 'B', createdAt: 11, attachments: [] },
  ])
  assert.deepEqual(source.snapshot('session-c'), [])
})

test('two same-text submissions remain identity-distinct and are never deduped by text', () => {
  const ledger = new PendingSubmissions()
  ledger.begin({ requestId: 'req-1', placement: 'queued', text: 'same', createdAt: 1, sessionId: 's', generation: 1 })
  ledger.begin({ requestId: 'req-2', placement: 'queued', text: 'same', createdAt: 2, sessionId: 's', generation: 1 })
  const items = new DirectSubmissionPresentation(ledger).snapshot('s')
  assert.equal(items.length, 2)
  assert.deepEqual(items.map(item => item.requestId), ['req-1', 'req-2'])
  // A Host occurrence matching only req-1 suppresses exactly that echo.
  assert.deepEqual(
    pendingSubmissionsNotReplaced(items, new Set(['req-1'])).map(item => item.requestId),
    ['req-2'],
  )
})

test('the Remote source maps official pending submissions and attachment labels', () => {
  const generation = generationHarness()
  const source = new RemoteSubmissionPresentation(remoteSessions({
    'session-a': sessionFace([
      { requestId: 'req-1', placement: 'queued', time: 100, text: 'A', attachments: [] },
      {
        requestId: 'req-2',
        placement: 'steering',
        time: 101,
        text: 'B',
        attachments: [
          { type: 'image', value: { previewUrl: 'blob:x', name: 'shot.png' } },
          { type: 'file', value: { attachmentId: 'a', name: 'notes.txt', bytes: 3 } },
        ],
      },
    ]),
  }), generation.source)

  assert.deepEqual(source.snapshot('session-a'), [
    { requestId: 'req-1', placement: 'queued', text: 'A', createdAt: 100, attachments: [], foldableText: true },
    {
      requestId: 'req-2',
      placement: 'steering',
      text: 'B',
      createdAt: 101,
      attachments: [{ kind: 'image', label: 'shot.png' }, { kind: 'file', label: 'notes.txt' }],
      foldableText: false,
    },
  ])
})

test('the Remote source preserves the transcript placement for an idle submission', () => {
  const generation = generationHarness()
  const source = new RemoteSubmissionPresentation(remoteSessions({
    'session-a': sessionFace([
      { requestId: 'req-3', placement: 'transcript', time: 200, text: 'C', attachments: [] },
    ]),
  }), generation.source)
  assert.deepEqual(source.snapshot('session-a'), [
    { requestId: 'req-3', placement: 'transcript', text: 'C', createdAt: 200, attachments: [], foldableText: true },
  ])
})

test('an unnamed image keeps a stable label', () => {  const generation = generationHarness()
  const source = new RemoteSubmissionPresentation(remoteSessions({
    'session-a': sessionFace([
      { requestId: 'req-1', placement: 'queued', time: 1, text: '', attachments: [{ type: 'image', value: { previewUrl: 'blob:x' } }] },
    ]),
  }), generation.source)
  assert.deepEqual(source.snapshot('session-a')?.[0]?.attachments, [{ kind: 'image', label: 'image' }])
})

test('switching sessions drops the previous session echoes', () => {
  const generation = generationHarness()
  const source = new RemoteSubmissionPresentation(remoteSessions({
    'session-a': sessionFace([{ requestId: 'req-a', placement: 'queued', time: 1, text: 'A', attachments: [] }]),
    'session-b': sessionFace([{ requestId: 'req-b', placement: 'transcript', time: 2, text: 'B', attachments: [] }]),
  }), generation.source)
  assert.deepEqual(source.snapshot('session-a')?.map(item => item.requestId), ['req-a'])
  assert.deepEqual(source.snapshot('session-b')?.map(item => item.requestId), ['req-b'])
})

test('a replaced generation is unavailable rather than a stale echo', () => {
  const generation = generationHarness()
  const face: RemoteSubmissionSessionFace = {
    getSnapshot: () => {
      generation.set({ id: 2 })
      return { pendingSubmissions: [{ requestId: 'req-a', placement: 'queued', time: 1, text: 'A', attachments: [] }] }
    },
  }
  const source = new RemoteSubmissionPresentation(remoteSessions({ 'session-a': face }), generation.source)
  assert.equal(source.snapshot('session-a'), undefined)
})

test('a disconnected generation or absent binding has no presentation', () => {
  const generation = generationHarness()
  generation.set(undefined)
  const source = new RemoteSubmissionPresentation(remoteSessions({
    'session-a': sessionFace([]),
  }), generation.source)
  assert.equal(source.snapshot('session-a'), undefined)
  generation.set({ id: 1 })
  assert.equal(source.snapshot('missing'), undefined)
})

test('the Remote source reports no active session as undefined, never an empty list', () => {
  const generation = generationHarness()
  const source = new RemoteSubmissionPresentation(remoteSessions({}), generation.source)
  assert.equal(source.snapshot(undefined), undefined)
})
