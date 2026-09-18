/**
 * D2.2 Remote UI closure (plan §87): the experimental Remote pending-input and
 * submission-presentation adapters, joined by the ONE authoritative presentation
 * rule, must drive the REAL rendered pending surfaces — the queue pane and the
 * ephemeral conversation-tail steering lane — not merely the setter state.
 *
 * The four blocking transitions are asserted against the virtual terminal's
 * viewport: a local queued echo is visible and marked sending; a matching Host
 * occurrence retires the duplicate; a local steering echo lands in the steering
 * lane and never in the queue pane; and a replaced Connection generation leaves
 * no stale Remote presentation behind.
 *
 * @module @xmoon76/dsh-pi-tui/remote-presentation-closure.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { RemotePendingInputReader } from '../src/runtime/remote/pending-input-reader-remote.ts'
import { RemoteSubmissionPresentation } from '../src/submission-presentation.ts'
import type { RemotePendingSubmission } from '../src/submission-presentation.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'
import { buildPendingPresentation } from '../src/pending-presentation.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

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

/** One official durable inbox message shape (id + content + source). */
interface OfficialInboxMessage {
  readonly id: string
  readonly content: readonly unknown[]
  readonly source: { readonly kind?: string; readonly rpcId?: string }
}

/** The official alpha2 durable inbox projection value. */
interface OfficialInbox {
  readonly 'next-turn': readonly OfficialInboxMessage[]
  readonly 'next-step': readonly OfficialInboxMessage[]
}

const EMPTY_INBOX: OfficialInbox = { 'next-turn': [], 'next-step': [] }

/** The official Session read facts both D2.2 Remote adapters consume. */
interface OfficialSnapshot {
  readonly inbox: OfficialInbox
  readonly running: boolean
  readonly pendingSubmissions: readonly RemotePendingSubmission[]
}

interface OfficialSessionFace {
  getSnapshot(): { readonly running: boolean; readonly pendingSubmissions: readonly RemotePendingSubmission[] }
  readonly projections: {
    faceOf(key: string): { getSnapshot(): unknown }
  }
}

/** The ClientSessions face that structurally satisfies BOTH adapters. */
interface BothSessionsSource {
  binding(sessionId: string): { readonly session: OfficialSessionFace } | undefined
}

function officialSession(initial: OfficialSnapshot): {
  readonly sessions: BothSessionsSource
  set(next: Partial<OfficialSnapshot>): void
} {
  let state = initial
  const face: OfficialSessionFace = {
    getSnapshot: () => ({ running: state.running, pendingSubmissions: state.pendingSubmissions }),
    projections: {
      faceOf: key => ({ getSnapshot: () => key === 'inbox' ? state.inbox : undefined }),
    },
  }
  return {
    sessions: { binding: id => id === 'session-a' ? { session: face } : undefined },
    set(next) { state = { ...state, ...next } },
  }
}

const textOf = (content: readonly unknown[]): string => content
  .map(block => {
    if (typeof block !== 'object' || block === null) return ''
    const value = block as { readonly type?: unknown; readonly text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
  })
  .join(' ')

function presentOnce(
  app: TuiApp,
  sessions: BothSessionsSource,
  generation: RemoteConnectionGenerationSource,
  sessionId = 'session-a',
): void {
  const reader = new RemotePendingInputReader(sessions, generation)
  const echoes = new RemoteSubmissionPresentation(sessions, generation)
  const rows = buildPendingPresentation({
    pending: reader.snapshot(sessionId),
    submissions: echoes.snapshot(sessionId) ?? [],
    textOf,
  })
  app.setPendingInputPresentation(rows)
}

test('a Remote local queued echo renders in the real queue pane marked sending', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: EMPTY_INBOX,
    running: true,
    pendingSubmissions: [
      { requestId: 'req-1', placement: 'queued', time: 1, text: 'REMOTE-QUEUED-LOCAL', attachments: [] },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('❯ REMOTE-QUEUED-LOCAL'), `the Remote local queued echo must render:\n${view}`)
  assert.ok(view.includes('sending…'), `the Remote local queued echo must be marked sending:\n${view}`)
})

test('a matching Host queue rpcId retires the Remote local duplicate in the rendered pane', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: {
      'next-turn': [{ id: 'occ-1', content: [{ type: 'text', text: 'REMOTE-QUEUED-LOCAL' }], source: { kind: 'user', rpcId: 'req-1' } }],
      'next-step': [],
    },
    running: true,
    pendingSubmissions: [
      { requestId: 'req-1', placement: 'queued', time: 1, text: 'REMOTE-QUEUED-LOCAL', attachments: [] },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal((view.match(/REMOTE-QUEUED-LOCAL/g) ?? []).length, 1, `the occurrence must render exactly once:\n${view}`)
  assert.ok(!view.includes('sending…'), `the authoritative replacement must not read as a local echo:\n${view}`)
})

test('a Remote local steering echo renders in the steering lane and never in the queue pane', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: EMPTY_INBOX,
    running: true,
    pendingSubmissions: [
      { requestId: 'req-2', placement: 'steering', time: 1, text: 'REMOTE-STEER-LOCAL', attachments: [] },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('❯ REMOTE-STEER-LOCAL'), `the Remote steering lane must render:\n${view}`)
  assert.ok(view.includes('steering…'), `the Remote steering lane must read steering:\n${view}`)
  // The queue pane is empty: no queued row and no bulk-action hint can exist.
  assert.ok(!view.includes('to steer all') && !view.includes('to recall all'),
    `a local steering echo must never appear as a queue row:\n${view}`)
})

test('a Remote local transcript echo renders in the tail lane marked sending', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: EMPTY_INBOX,
    running: false,
    pendingSubmissions: [
      { requestId: 'req-3', placement: 'transcript', time: 1, text: 'REMOTE-TRANSCRIPT-LOCAL', attachments: [] },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('❯ REMOTE-TRANSCRIPT-LOCAL'), `the Remote transcript lane must render:\n${view}`)
  assert.ok(view.includes('sending…'), `an idle transcript echo must read sending:\n${view}`)
  assert.ok(!view.includes('to steer all') && !view.includes('to recall all'),
    `a transcript echo must never appear as a queue row:\n${view}`)
})

test('a replaced Connection generation clears the stale Remote presentation from the rendered surfaces', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: EMPTY_INBOX,
    running: true,
    pendingSubmissions: [
      { requestId: 'req-1', placement: 'queued', time: 1, text: 'REMOTE-STALE-QUEUED', attachments: [] },
      { requestId: 'req-2', placement: 'steering', time: 2, text: 'REMOTE-STALE-STEER', attachments: [] },
    ],
  })
  // The replacement generation has not re-bound the addressed Session yet, so
  // the old binding is gone; the adapters must report unavailable, not replay
  // the previous generation's rows.
  let bindable = true
  const sessions: BothSessionsSource = {
    binding: id => bindable && id === 'session-a' ? { session: host.sessions.binding(id)!.session } : undefined,
  }
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('REMOTE-STALE-QUEUED'))

  generation.set({ id: 2 })
  bindable = false
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('REMOTE-STALE-QUEUED'), `stale queued presentation survived:\n${view}`)
  assert.ok(!view.includes('REMOTE-STALE-STEER'), `stale steering presentation survived:\n${view}`)
})

test('a rendered SESSION switch clears the previous session Remote presentation', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const a = officialSession({
    inbox: EMPTY_INBOX,
    running: true,
    pendingSubmissions: [
      { requestId: 'req-a', placement: 'queued', time: 1, text: 'SESSION-A-QUEUED', attachments: [] },
      { requestId: 'req-a2', placement: 'steering', time: 2, text: 'SESSION-A-STEER', attachments: [] },
    ],
  })
  const b = officialSession({ inbox: EMPTY_INBOX, running: false, pendingSubmissions: [] })
  const faces: Record<string, OfficialSessionFace> = {
    'session-a': a.sessions.binding('session-a')!.session,
    'session-b': b.sessions.binding('session-a')!.session,
  }
  const sessions: BothSessionsSource = {
    binding: id => faces[id] === undefined ? undefined : { session: faces[id] },
  }
  presentOnce(app, sessions, generation.source, 'session-a')
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('SESSION-A-QUEUED'))

  presentOnce(app, sessions, generation.source, 'session-b')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('SESSION-A-QUEUED'), `previous session's queued row survived:\n${view}`)
  assert.ok(!view.includes('SESSION-A-STEER'), `previous session's steering row survived:\n${view}`)
})

test('a Remote image-only local queued echo renders a non-empty attachment marker', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: EMPTY_INBOX,
    running: true,
    pendingSubmissions: [
      {
        requestId: 'req-img',
        placement: 'queued',
        time: 1,
        text: '',
        attachments: [{ type: 'image', value: { previewUrl: 'blob:x', name: 'shot.png' } }],
      },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('[Image: shot.png]'), `an image-only echo must not render blank:\n${view}`)
  assert.ok(view.includes('sending…'), `the image-only queued echo must be marked sending:\n${view}`)
})

test('a Remote image-only local steering echo renders in the lane, never the queue', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: EMPTY_INBOX,
    running: true,
    pendingSubmissions: [
      {
        requestId: 'req-img-steer',
        placement: 'steering',
        time: 1,
        text: '',
        attachments: [{ type: 'image', value: { previewUrl: 'blob:y', name: 'diagram.png' } }],
      },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('[Image: diagram.png]'), `the image-only steering echo must render:\n${view}`)
  assert.ok(view.includes('steering…'), `the image-only steering echo must read steering:\n${view}`)
  assert.ok(!view.includes('to steer all') && !view.includes('to recall all'),
    `an image-only steering echo must never appear as a queue row:\n${view}`)
})

test('the same authoritative occurrence is presented once even for two same-text Remote echoes', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = generationHarness()
  const host = officialSession({
    inbox: {
      'next-turn': [{ id: 'occ-1', content: [{ type: 'text', text: 'SAME-TEXT' }], source: { kind: 'user', rpcId: 'req-1' } }],
      'next-step': [],
    },
    running: true,
    pendingSubmissions: [
      { requestId: 'req-1', placement: 'queued', time: 1, text: 'SAME-TEXT', attachments: [] },
      { requestId: 'req-2', placement: 'queued', time: 2, text: 'SAME-TEXT', attachments: [] },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // req-1's echo is suppressed by the authoritative occurrence; req-2 stays a
  // distinct local row. Two rendered rows total, never deduped by text.
  assert.equal((view.match(/SAME-TEXT/g) ?? []).length, 2, `identity, not text, decides the duplicate:\n${view}`)
})
