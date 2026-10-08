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
import { RemoteSubmissionPresentation } from '../src/app/remote/submission-presentation.ts'
import type { RemotePendingSubmission } from '../src/app/remote/submission-presentation.ts'
import type { RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'
import { createObservableGenerationHarness } from './support/remote-generation.ts'
import { buildPendingPresentation } from '../src/app/surface/pending-presentation.ts'

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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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
  const generation = createObservableGenerationHarness()
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

// ── Remote pending Context closure (plan §9.4) ──────────────────────────────

/** One non-user authoritative next-step occurrence inbox. */
function contextInbox(entries: readonly { id: string; text: string }[]): OfficialInbox {
  return {
    'next-turn': [],
    'next-step': entries.map(entry => ({
      id: entry.id,
      content: [{ type: 'text', text: entry.text }],
      source: { kind: 'tool-jobs' },
    })),
  }
}

test('a Remote next-step non-user occurrence renders as the generic pending Context tail', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const host = officialSession({
    inbox: contextInbox([{ id: 'ctx-1', text: 'REMOTE-BACKGROUND-CONTEXT' }]),
    running: true,
    pendingSubmissions: [],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('REMOTE-BACKGROUND-CONTEXT'), `the Remote pending Context preview must render:\n${view}`)
  assert.ok(view.includes('waiting for next step…'), `the running subject reads waiting for next step:\n${view}`)
  // Non-user identity: no user bubble marker, no steering row, no queue row.
  assert.ok(!view.includes('❯ REMOTE-BACKGROUND-CONTEXT'), `context must not render as a user bubble:\n${view}`)
  assert.ok(!view.includes('steering…'), `context must not read as steering:\n${view}`)
  assert.ok(!view.includes('to steer all') && !view.includes('to recall all'),
    `context must never appear as a queue row:\n${view}`)
})

test('a Remote next-step USER occurrence remains pending steering', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const host = officialSession({
    inbox: {
      'next-turn': [],
      'next-step': [{ id: 'occ-user', content: [{ type: 'text', text: 'REMOTE-USER-STEER' }], source: { kind: 'user' } }],
    },
    running: true,
    pendingSubmissions: [],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('❯ REMOTE-USER-STEER'), `the user occurrence stays a pending steering bubble:\n${view}`)
  assert.ok(view.includes('steering…'), `the user occurrence reads steering:\n${view}`)
  assert.ok(!view.includes('waiting for next step…'), `a user row never reads as Context:\n${view}`)
})

test('a Remote Context/User/Context tail preserves the join order', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const host = officialSession({
    inbox: {
      'next-turn': [],
      'next-step': [
        { id: 'ctx-a', content: [{ type: 'text', text: 'CTX-A' }], source: { kind: 'tool-jobs' } },
        { id: 'user-b', content: [{ type: 'text', text: 'USER-B' }], source: { kind: 'user' } },
        { id: 'ctx-c', content: [{ type: 'text', text: 'CTX-C' }], source: { kind: 'subagent-settled' } },
      ],
    },
    running: true,
    pendingSubmissions: [],
  })
  const reader = new RemotePendingInputReader(host.sessions, generation.source)
  const rows = buildPendingPresentation({ pending: reader.snapshot('session-a'), submissions: [], textOf })
  assert.deepEqual(
    rows.tail.map(item => item.kind),
    ['context', 'user', 'context'],
    `the ordered tail preserves Context/User/Context:\n${JSON.stringify(rows.tail)}`,
  )
  app.setPendingInputPresentation(rows)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const contextA = view.indexOf('CTX-A')
  const userB = view.indexOf('USER-B')
  const contextC = view.indexOf('CTX-C')
  assert.ok(contextA >= 0 && userB > contextA && contextC > userB,
    `the rendered order is Context A, User B, Context C:\n${view}`)
})

test('a replaced Remote Connection generation clears a stale pending Context row', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const host = officialSession({
    inbox: contextInbox([{ id: 'ctx-stale', text: 'REMOTE-STALE-CONTEXT' }]),
    running: true,
    pendingSubmissions: [],
  })
  // The replacement generation has not re-bound the addressed Session yet
  // (the real reconnect window): the old binding is gone, so the reader must
  // report the session unavailable, never replay the previous generation's
  // rows.
  let rebindable = true
  const sessions: BothSessionsSource = {
    binding: id => rebindable && id === 'session-a' ? { session: host.sessions.binding(id)!.session } : undefined,
  }
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('REMOTE-STALE-CONTEXT'))

  generation.set({ id: 2 })
  rebindable = false
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('REMOTE-STALE-CONTEXT'), `stale Context presentation survived:\n${view}`)
})

test('a same-generation durable re-bind keeps the Context row (reconnect is not data loss)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const host = officialSession({
    inbox: contextInbox([{ id: 'ctx-durable', text: 'REMOTE-DURABLE-CONTEXT' }]),
    running: true,
    pendingSubmissions: [],
  })
  const sessions: BothSessionsSource = {
    binding: id => id === 'session-a' ? { session: host.sessions.binding(id)!.session } : undefined,
  }
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('REMOTE-DURABLE-CONTEXT'))

  // The durable inbox projection SURVIVES a reconnect: a replaced generation
  // whose new binding carries the same durable rows keeps them on screen —
  // the clear in the generation test comes from the un-rebound window, not
  // from dropping durable data.
  generation.set({ id: 2 })
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('REMOTE-DURABLE-CONTEXT'),
    `a re-bound durable Context must survive the generation replacement:\n${view}`)
})

test('a SAME-generation unavailable binding retains no stale pending Context (case 6)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const host = officialSession({
    inbox: contextInbox([{ id: 'ctx-unbound', text: 'REMOTE-UNBOUND-CONTEXT' }]),
    running: true,
    pendingSubmissions: [],
  })
  let bindable = true
  const sessions: BothSessionsSource = {
    binding: id => bindable && id === 'session-a' ? { session: host.sessions.binding(id)!.session } : undefined,
  }
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('REMOTE-UNBOUND-CONTEXT'))

  // ONLY the binding becomes unavailable; the generation is UNCHANGED. The
  // reader must report the session as unavailable (never replay the previous
  // binding's rows), so the Context row leaves the rendered surface.
  bindable = false
  presentOnce(app, sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('REMOTE-UNBOUND-CONTEXT'),
    `an unavailable same-generation binding must not retain stale Context:\n${view}`)
})

test('a Remote session switch clears the previous session pending Context row', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const a = officialSession({
    inbox: contextInbox([{ id: 'ctx-a', text: 'SESSION-A-CONTEXT' }]),
    running: true,
    pendingSubmissions: [],
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
  assert.ok(vt.getViewport().join('\n').includes('SESSION-A-CONTEXT'))

  presentOnce(app, sessions, generation.source, 'session-b')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('SESSION-A-CONTEXT'), `previous session's Context row survived:\n${view}`)
})

test('a same-text Remote Context occurrence and human local echo never correlate', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const generation = createObservableGenerationHarness()
  const host = officialSession({
    inbox: contextInbox([{ id: 'ctx-same', text: 'SAME-WORDS' }]),
    running: true,
    pendingSubmissions: [
      { requestId: 'req-human', placement: 'steering', time: 1, text: 'SAME-WORDS', attachments: [] },
    ],
  })
  presentOnce(app, host.sessions, generation.source)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // The non-user Context occurrence has no rpc identity, so the same-TEXT
  // human echo is NOT suppressed: both rows render as distinct lanes.
  assert.equal((view.match(/SAME-WORDS/g) ?? []).length, 2,
    `text is never a correlation key — context occurrence plus human echo both render:\n${view}`)
  assert.ok(view.includes('❯ SAME-WORDS'), `the human echo keeps its user bubble:\n${view}`)
  assert.ok(!view.includes('❯ Context'), `the context row is not a user bubble:\n${view}`)
})
