/**
 * Headless tests for the local submit acknowledgement (plan D): the
 * submit-ack state machine (accept → settle, idempotent settles, elapsed)
 * and the working-row rendering ("Submitting…" / "Queued…" above the
 * editor, before any authoritative DSH event).
 * @module @xmoon76/dsh-pi-tui/submit-ack.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  acceptSubmitAck,
  freshSubmitAckState,
  settleSubmitAck,
  submitAckLabel,
  submitAckPending,
} from '../src/submit-ack.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

// ── state machine ───────────────────────────────────────────────────────────

test('fresh state is idle; pending/settle is round-trip with elapsed', () => {
  const state = freshSubmitAckState()
  assert.equal(submitAckPending(state), false)
  assert.equal(settleSubmitAck(state, { now: 1000 }), undefined, 'settle on idle is a no-op')
  const token = acceptSubmitAck(state, { detail: 'submit', now: 1000 })
  assert.equal(token, 1, 'the first accept mints epoch 1')
  assert.equal(submitAckPending(state), true)
  const elapsed = settleSubmitAck(state, { now: 1123, token })
  assert.equal(elapsed, 123)
  assert.equal(submitAckPending(state), false)
})

test('settle is idempotent: a double settle never double-notifies', () => {
  const state = freshSubmitAckState()
  const token = acceptSubmitAck(state, { detail: 'queued', now: 500 })
  assert.equal(settleSubmitAck(state, { now: 600, token }), 100)
  assert.equal(settleSubmitAck(state, { now: 700, token }), undefined)
  assert.equal(settleSubmitAck(state, { now: 800, token }), undefined)
})

test('accepting overwrites an older pending state (the newest gesture wins)', () => {
  const state = freshSubmitAckState()
  acceptSubmitAck(state, { detail: 'submit', now: 100 })
  acceptSubmitAck(state, { detail: 'queued', now: 200 })
  assert.equal(state.detail, 'queued')
  const elapsed = settleSubmitAck(state, { now: 250 })
  assert.equal(elapsed, 50, 'the elapsed measures against the LATEST acceptance')
})

test('COALESCING (documented): a late authoritative event settles the CURRENT row without identity', () => {
  // Same-session writes are barrier-serialized, so an in-flight older
  // submission's event truthfully ends the row the user is looking at.
  const state = freshSubmitAckState()
  acceptSubmitAck(state, { detail: 'queued', now: 100 }) // submission 1 (still in flight)
  acceptSubmitAck(state, { detail: 'submit', now: 300 }) // submission 2 (newest, owns the row)
  // An authoritative event from submission 1's delivery lands: it settles
  // the CURRENT (newest) row — the documented coalescing, no identity.
  const elapsed = settleSubmitAck(state, { now: 400 })
  assert.equal(elapsed, 100, 'elapsed measures the newest acceptance')
  assert.equal(submitAckPending(state), false)
})

// ── gesture epoch: an older submission's TERMINAL exit never clears a
// newer gesture (the review's `!sleep` / `!echo` repro, pinned pure) ────────

test('EPOCH: a stale terminal settle (older gesture) never clears the newer pending row', () => {
  const state = freshSubmitAckState()
  const tokenA = acceptSubmitAck(state, { detail: 'submit', now: 100 }) // `!sleep 10` (A)
  const tokenB = acceptSubmitAck(state, { detail: 'submit', now: 300 }) // `!echo` (B, newest)
  assert.equal(tokenB, tokenA + 1)
  // A dies late (abort/cancel/failure): its terminal settle carries A's
  // token and MUST be ignored — B is what the user is waiting on.
  assert.equal(settleSubmitAck(state, { now: 400, token: tokenA }), undefined,
    'a stale terminal settle must be a no-op')
  assert.equal(submitAckPending(state), true, 'B must remain pending')
  assert.equal(state.detail, 'submit', 'B\'s label untouched')
  // B's own terminal settle (current token) works.
  assert.equal(settleSubmitAck(state, { now: 450, token: tokenB }), 150)
  assert.equal(submitAckPending(state), false)
})

test('EPOCH: a stale terminal settle does not block the later coalescing settle', () => {
  const state = freshSubmitAckState()
  const tokenA = acceptSubmitAck(state, { detail: 'submit', now: 100 })
  const tokenB = acceptSubmitAck(state, { detail: 'queued', now: 200 })
  assert.equal(settleSubmitAck(state, { now: 300, token: tokenA }), undefined, 'A stale')
  // The authoritative event for B arrives: tokenless coalescing settles.
  assert.equal(settleSubmitAck(state, { now: 350 }), 150)
  assert.equal(submitAckPending(state), false)
})

test('EPOCH: a terminal settle for the CURRENT token still settles', () => {
  const state = freshSubmitAckState()
  const token = acceptSubmitAck(state, { detail: 'submit', now: 100 })
  assert.equal(settleSubmitAck(state, { now: 200, token }), 100)
})

test('submitAckLabel: submit → Submitting…, queued → Queued…', () => {
  assert.equal(submitAckLabel('submit'), 'Submitting…')
  assert.equal(submitAckLabel('queued'), 'Queued…')
})

// ── working-row rendering (the immediate feedback surface) ─────────────────

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('a submit ack renders the Submitting… row immediately and clears', async (t) => {
  const { vt, app } = startApp()
  t.after(() => app.dispose())
  app.setSubmitPending('submit')
  const pending = await viewport(vt)
  assert.ok(pending.includes('Submitting…'), `pending row missing:\n${pending}`)
  app.setSubmitPending(undefined)
  const settled = await viewport(vt)
  assert.ok(!settled.includes('Submitting…'), `row survived the settle:\n${settled}`)
})

test('a queued ack renders Queued… (the agent is running; the input rides the inbox)', async (t) => {
  const { vt, app } = startApp()
  t.after(() => app.dispose())
  app.setSubmitPending('queued')
  const pending = await viewport(vt)
  assert.ok(pending.includes('Queued…'), `queued row missing:\n${pending}`)
  assert.ok(!pending.includes('Submitting…'), `submit label shown for queued:\n${pending}`)
  app.setSubmitPending(undefined)
})

test('the ack row coexists with the working row: the pending label wins until it settles', async (t) => {
  const { vt, app } = startApp()
  t.after(() => app.dispose())
  // A submission accepted while the agent is busy: pending shows Queued…
  app.setWorking(false)
  app.setSubmitPending('queued')
  let view = await viewport(vt)
  assert.ok(view.includes('Queued…'), `queued row missing:\n${view}`)
  // A turn starting does not blank the row: the pending label keeps
  // leading (in production the runner settles the ack at turn/start, so
  // the Working base label takes over through the settle).
  app.setWorking(true)
  view = await viewport(vt)
  assert.ok(view.includes('Queued…'), `the pending row must stay while the turn runs:\n${view}`)
  app.setWorking(false)
  view = await viewport(vt)
  // The pending ack was not settled by the runner yet (defensive): the row
  // returns to the pending label instead of vanishing mid-wait.
  assert.ok(view.includes('Queued…'), `pending row lost after turn end:\n${view}`)
  app.setSubmitPending(undefined)
  view = await viewport(vt)
  assert.ok(!view.includes('Queued…') && !view.includes('Submitting…'), `row survived the clear:\n${view}`)
})