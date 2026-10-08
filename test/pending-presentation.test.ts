/**
 * Focused unit tests for the ONE pending-presentation join (plan §9.1–§9.3):
 * the ordered queue/tail split, the identity-only (never text) correlation,
 * and the real-TUI pending Context tail rendering including narrow widths.
 * @module @xmoon76/dsh-pi-tui/pending-presentation.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { buildPendingPresentation } from '../src/app/surface/pending-presentation.ts'
import type { PendingInputSnapshot } from '../src/runtime/pending-input-reader-port.ts'
import type { SubmissionPresentationItem } from '../src/app/submission/presentation.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const textOf = (content: readonly unknown[]): string => content
  .map(block => {
    if (typeof block !== 'object' || block === null) return ''
    const value = block as { readonly type?: unknown; readonly text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
  })
  .join(' ')

const text = (text: string): readonly unknown[] => [{ type: 'text', text }]
const echo = (
  requestId: string,
  placement: SubmissionPresentationItem['placement'],
  echoText: string,
): SubmissionPresentationItem => ({ requestId, placement, createdAt: 1, text: echoText, attachments: [] })

// ── 9.1 Pending presentation ordering ───────────────────────────────────────

test('the join splits queued to the pane and preserves the Context/User/Context tail order', () => {
  const snapshot: PendingInputSnapshot = {
    running: true,
    items: [
      { id: 'q', placement: 'queued', content: text('Q') },
      { id: 'a', placement: 'context', content: text('A') },
      { id: 'b', placement: 'steering', content: text('B'), rpcId: 'rpc-b' },
      { id: 'c', placement: 'context', content: text('C') },
    ],
  }
  const rows = buildPendingPresentation({ pending: snapshot, submissions: [], textOf })
  assert.deepEqual(rows.queued.map(row => row.id), ['q'], 'only the queued occurrence enters the pane')
  assert.deepEqual(
    rows.tail.map(item => item.kind),
    ['context', 'user', 'context'],
    'the ONE ordered tail preserves Context/User/Context',
  )
  assert.deepEqual(
    rows.tail.map(item => item.kind === 'user' ? item.row.text : item.row.text),
    ['A', 'B', 'C'],
  )
})

test('an unavailable pending projection yields an empty join (no fabricated rows)', () => {
  const rows = buildPendingPresentation({ pending: undefined, submissions: [], textOf })
  assert.deepEqual(rows, { queued: [], tail: [], running: false })
})

// ── 9.2 Identity / dedupe ───────────────────────────────────────────────────

test('a context occurrence never correlates with a same-text human local echo', () => {
  const snapshot: PendingInputSnapshot = {
    running: true,
    items: [{ id: 'ctx-1', placement: 'context', content: text('same') }],
  }
  const rows = buildPendingPresentation({
    pending: snapshot,
    submissions: [echo('req-1', 'steering', 'same')],
    textOf,
  })
  // Two distinct rows: the context occurrence has no user rpc identity, so
  // the same-TEXT echo is not suppressed.
  assert.equal(rows.tail.length, 2, `text is never a correlation key: ${JSON.stringify(rows.tail)}`)
  assert.deepEqual(rows.tail.map(item => item.kind), ['context', 'user'])
})

test('only a real user rpcId identity suppresses the matching human local echo', () => {
  const snapshot: PendingInputSnapshot = {
    running: true,
    items: [
      { id: 'occ-1', placement: 'steering', content: text('same'), rpcId: 'req-1' },
      { id: 'ctx-1', placement: 'context', content: text('same') },
    ],
  }
  const rows = buildPendingPresentation({
    pending: snapshot,
    submissions: [
      echo('req-1', 'steering', 'same'),
      echo('req-2', 'steering', 'same'),
    ],
    textOf,
  })
  // req-1's echo is suppressed by the authoritative rpc identity; req-2 stays.
  const userRows = rows.tail.filter(item => item.kind === 'user').map(item => item.row)
  assert.deepEqual(userRows.map(row => row.rpcId), ['req-1', 'req-2'],
    'the authoritative rpc row replaces req-1; req-2 stays distinct')
})

// ── 9.3 Real TUI pending Context render ─────────────────────────────────────

function startApp(width = 80, preset?: 'focus' | 'compact' | 'full'): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, 24)
  const app = new TuiApp(
    vt,
    { onSubmit: () => {}, onExit: () => {} },
    preset === undefined ? {} : { displayState: { preset } },
  )
  app.start()
  startedApps.add(app)
  return { vt, app }
}

test('a placement=context snapshot renders a visible generic Context tail row, never a user bubble or queue row', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setPendingInputPresentation({
    queued: [],
    tail: [{ kind: 'context', row: { id: 'ctx-1', text: 'background result is ready' } }],
    running: true,
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('background result is ready'), `the Context preview must be visible:\n${view}`)
  assert.ok(view.includes('waiting for next step…'), `the running waiting status must render:\n${view}`)
  assert.ok(!view.includes('❯ background result is ready'), `context is not a user bubble:\n${view}`)
  assert.ok(!view.includes('to steer all') && !view.includes('to recall all'),
    `no queue bulk hint may render:\n${view}`)
})

test('a parked context occurrence (subject no longer running) reads waiting for next turn', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setPendingInputPresentation({
    queued: [],
    tail: [{ kind: 'context', row: { id: 'ctx-1', text: 'parked context' } }],
    running: false,
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('waiting for next turn…'), `an idle subject reads waiting for next turn:\n${view}`)
  assert.ok(!view.includes('waiting for next step…'), `the running label must not render:\n${view}`)
})

test('the SAME context occurrence flips its waiting label when the subject parks (running -> idle)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // ONE occurrence identity across both presentations: the flip must repaint
  // the label through the setter's rebuild, never keep the constructed-time
  // status of the first component. This locks the lifecycle against a future
  // content-only refresh optimization of the pending tail.
  const row = { id: 'ctx-1', text: 'flip probe context' }
  app.setPendingInputPresentation({ queued: [], tail: [{ kind: 'context', row }], running: true })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('waiting for next step…'), `a running subject reads next step:\n${view}`)
  assert.ok(!view.includes('waiting for next turn…'), `the parked label must not render yet:\n${view}`)

  app.setPendingInputPresentation({ queued: [], tail: [{ kind: 'context', row }], running: false })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('waiting for next turn…'), `the SAME occurrence must flip to next turn:\n${view}`)
  assert.ok(!view.includes('waiting for next step…'), `the OLD running label must disappear:\n${view}`)
})

test('the pending Context tail renders in every display preset (UI acceptance matrix)', async () => {
  for (const preset of ['focus', 'compact', 'full'] as const) {
    const { vt, app } = startApp(80, preset)
    await vt.waitForRender()
    app.setPendingInputPresentation({
      queued: [],
      tail: [{ kind: 'context', row: { id: 'ctx-1', text: `CONTEXT-IN-${preset}` } }],
      running: true,
    })
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes(`CONTEXT-IN-${preset}`), `${preset}: the pending Context tail must render:\n${view}`)
    assert.ok(!view.includes('to steer all') && !view.includes('to recall all'),
      `${preset}: the Context row must never enter the queue pane:\n${view}`)
    app.dispose()
  }
})

test('a long context preview is bounded to two body rows with an ellipsis', async () => {
  const { vt, app } = startApp(40)
  await vt.waitForRender()
  const long = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ')
  app.setPendingInputPresentation({
    queued: [],
    tail: [{ kind: 'context', row: { id: 'ctx-long', text: long } }],
    running: true,
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('…'), `the truncated preview must ellipsize:\n${view}`)
  assert.ok(!view.includes('word29'), `content beyond the preview bound must not render:\n${view}`)
  // Header + 2 body rows + status: every physical row obeys the width.
  for (const line of vt.getViewport()) {
    if (line.trim() === '') continue
    assert.ok(line.length <= 40, `every row must obey the terminal width: ${JSON.stringify(line)}`)
  }
})

test('a narrow terminal still renders the Context row without overflow', async () => {
  const { vt, app } = startApp(12)
  await vt.waitForRender()
  app.setPendingInputPresentation({
    queued: [],
    tail: [{ kind: 'context', row: { id: 'ctx-narrow', text: 'a fairly long background settlement preview' } }],
    running: true,
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('fairly'), `some preview content must render at a narrow width:\n${view}`)
  for (const line of vt.getViewport()) {
    if (line.trim() === '') continue
    assert.ok(line.length <= 12, `every row must obey the narrow width: ${JSON.stringify(line)}`)
  }
})

// ── 9.6 Pending -> durable transition ───────────────────────────────────────

test('the Host claim removes the Context row and the durable Context replaces it in the same lifecycle', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // Phase 1: the authoritative pending occurrence renders in the tail.
  app.setPendingInputPresentation({
    queued: [],
    tail: [{ kind: 'context', row: { id: 'ctx-1', text: 'claim me durably' } }],
    running: true,
  })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('claim me durably'), `the pending Context preview must be visible:\n${view}`)
  assert.ok(view.includes('waiting for next step…'), `phase 1 reads the pending status:\n${view}`)

  // Phase 2: the Host claims the occurrence — the inbox projection no longer
  // holds it, and the durable `user/message` Context lands in the transcript
  // as an ordinary standalone Context card (its producer label is the durable
  // identity; the payload stays behind the row's own disclosure).
  app.setTranscript([
    {
      kind: 'system', turn: 0, text: 'claim me durably', label: 'Background job', context: true,
      contextPresentation: { form: 'notice', sourceKind: 'tool-jobs', role: 'inject' },
    },
  ], new Map())
  app.setPendingInputPresentation({ queued: [], tail: [], running: true })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Background job'), `the durable Context card must render through the normal transcript path:\n${view}`)
  // The pending lane's status line is gone — the visible row is the durable
  // card, not a retained tail duplicate.
  assert.ok(!view.includes('waiting for next step…'), `no pending tail duplicate may survive the claim:\n${view}`)
  assert.equal(app.pendingInputForTest().tail.length, 0, 'the tail state holds no shadow row')
})
