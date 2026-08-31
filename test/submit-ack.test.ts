/**
 * Headless tests for the local submit acknowledgement (plan D): the
 * submit-ack state machine (accept → settle, idempotent settles, elapsed)
 * and the working-row rendering ("Submitting…" / "Queued…" above the
 * editor, before any authoritative DSH event).
 * @module @xmoon76/dsh-pi-tui/submit-ack.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptSubmitAck,
  freshSubmitAckState,
  settleSubmitAck,
  submitAckLabel,
  submitAckPending,
} from '../src/submit-ack.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

// ── state machine ───────────────────────────────────────────────────────────

test('fresh state is idle; pending/settle is round-trip with elapsed', () => {
  const state = freshSubmitAckState()
  assert.equal(submitAckPending(state), false)
  assert.equal(settleSubmitAck(state, 1000), undefined, 'settle on idle is a no-op')
  acceptSubmitAck(state, { detail: 'submit', now: 1000 })
  assert.equal(submitAckPending(state), true)
  const elapsed = settleSubmitAck(state, 1123)
  assert.equal(elapsed, 123)
  assert.equal(submitAckPending(state), false)
})

test('settle is idempotent: a double settle never double-notifies', () => {
  const state = freshSubmitAckState()
  acceptSubmitAck(state, { detail: 'queued', now: 500 })
  assert.equal(settleSubmitAck(state, 600), 100)
  assert.equal(settleSubmitAck(state, 700), undefined)
  assert.equal(settleSubmitAck(state, 800), undefined)
})

test('accepting overwrites an older pending state (the newest gesture wins)', () => {
  const state = freshSubmitAckState()
  acceptSubmitAck(state, { detail: 'submit', now: 100 })
  acceptSubmitAck(state, { detail: 'queued', now: 200 })
  assert.equal(state.detail, 'queued')
  const elapsed = settleSubmitAck(state, 250)
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
  const elapsed = settleSubmitAck(state, 400)
  assert.equal(elapsed, 100, 'elapsed measures the newest acceptance')
  assert.equal(submitAckPending(state), false)
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