/**
 * M6 PR-C C3: the Client-local `piTuiPromptPresence` owner.
 *
 * The owner is the ONE place a Split Client declares its current session view;
 * these cases pin its own semantics against a controlled wire capability:
 * revision monotonicity, latest-wins coalescing, stale-ACK and superseded-
 * transport rejection (an ACK never confirms a newer view), the bounded
 * `ackCurrentView` settle (a local change during the await re-syncs before the
 * submission), the truthful refused/unconfirmed propagation with NO automatic
 * replay, and the best-effort withdraw on teardown.
 *
 * @module @xmoon76/dsh-pi-tui/app/prompt-presence-client.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPromptPresenceClient,
  type PromptPresenceLocalView,
} from '../../src/app/remote/prompt-presence-client.ts'
import type {
  RemotePromptPresenceAck,
  RemotePromptPresenceCapability,
} from '../../src/app/application-runtime.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

interface WireCall {
  readonly viewedSessionId: string | null
  readonly displayPreset: string
  readonly revision: number
}

/** One controlled wire capability recording every dispatched call. */
function fakeCapability(
  answer: (call: WireCall) => RemotePromptPresenceAck | { readonly ok: false },
): { calls: WireCall[]; capability: RemotePromptPresenceCapability } {
  const calls: WireCall[] = []
  return {
    calls,
    capability: {
      syncView: (viewedSessionId, displayPreset, revision) => {
        const call: WireCall = { viewedSessionId, displayPreset, revision }
        calls.push(call)
        const result = answer(call)
        return Promise.resolve('kind' in result
          ? { ok: true as const, value: result }
          : { ok: false as const, error: 'wire failure' })
      },
    },
  }
}

function ackOf(call: WireCall): RemotePromptPresenceAck {
  return { kind: 'applied', revision: call.revision }
}

test('the owner dispatches the current view once and records the ACKed view', async () => {
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { calls, capability } = fakeCapability(ackOf)
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    diag: DIAG,
  })
  try {
    const outcome = await owner.sync()
    assert.deepEqual(outcome, { kind: 'applied', revision: 1 })
    assert.equal(calls.length, 1)
    assert.deepEqual(owner.committed(), { viewedSessionId: 'session-x', displayPreset: 'focus', revision: 1 })
  } finally {
    owner.dispose()
  }
})

test('concurrent local changes coalesce into ONE dispatch of the LATEST view', async () => {
  let view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'full' }
  const { calls, capability } = fakeCapability(ackOf)
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    diag: DIAG,
  })
  try {
    const first = owner.sync()
    view = { viewedSessionId: 'session-x', displayPreset: 'focus' }
    const second = owner.sync()
    const outcomes = await Promise.all([first, second])
    assert.equal(calls.length, 1, 'a superseded desired view is never replayed')
    assert.equal(calls[0]?.displayPreset, 'focus', 'the LATEST view is the one dispatched')
    for (const outcome of outcomes) {
      assert.deepEqual(outcome, { kind: 'applied', revision: 1 },
        'both waiters resolve with the outcome of the dispatch that carried the latest view')
    }
    assert.equal(owner.committed()?.displayPreset, 'focus')
  } finally {
    owner.dispose()
  }
})

test('a stale ACK (wrong revision) is unconfirmed and never records a committed view', async () => {
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { capability } = fakeCapability(() => ({ kind: 'applied', revision: 99 }))
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    diag: DIAG,
  })
  try {
    const outcome = await owner.sync()
    assert.deepEqual(outcome, { kind: 'unconfirmed' }, 'an ACK for another revision is not this dispatch\'s ACK')
    assert.equal(owner.committed(), undefined)
  } finally {
    owner.dispose()
  }
})

test('an ACK carried by a superseded transport is unconfirmed and retires the commitment', async () => {
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { capability } = fakeCapability(ackOf)
  let current = true
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    transport: {
      capture: () => ({ generation: 1, binding: {} }),
      isCurrent: () => current,
    },
    diag: DIAG,
  })
  try {
    assert.deepEqual(await owner.sync(), { kind: 'applied', revision: 1 })
    assert.deepEqual(owner.committed(), { viewedSessionId: 'session-x', displayPreset: 'focus', revision: 1 })
    // The Connection generation rolls over between dispatch and ACK.
    current = false
    assert.deepEqual(await owner.sync(), { kind: 'unconfirmed' },
      'an ACK that rode a superseded generation must not confirm presence')
    assert.equal(owner.committed(), undefined, 'an unconfirmed outcome retires the local commitment')
  } finally {
    owner.dispose()
  }
})

test('a refused ACK propagates the exact reason and never retries automatically', async () => {
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { calls, capability } = fakeCapability(() => ({ kind: 'refused', reason: 'session-not-live' }))
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    diag: DIAG,
  })
  try {
    assert.deepEqual(await owner.sync(), { kind: 'refused', reason: 'session-not-live' })
    assert.equal(calls.length, 1, 'a refusal is never replayed')
    assert.equal(owner.committed(), undefined)
  } finally {
    owner.dispose()
  }
})

test('ackCurrentView confirms only when the ACKed view is still the current local view', async () => {
  let view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'full' }
  const { calls, capability } = fakeCapability((call) => {
    // The user toggles Focus WHILE the first ACK is in flight.
    if (call.revision === 1) view = { viewedSessionId: 'session-x', displayPreset: 'focus' }
    return ackOf(call)
  })
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    diag: DIAG,
  })
  try {
    const gate = await owner.ackCurrentView()
    assert.deepEqual(gate, { kind: 'confirmed' })
    assert.equal(calls.length, 2, 'the changed view re-syncs before the submission is admitted')
    assert.equal(calls[1]?.displayPreset, 'focus')
    assert.equal(owner.committed()?.displayPreset, 'focus')
  } finally {
    owner.dispose()
  }
})

test('ackCurrentView gives up as unconfirmed when the view keeps changing (bounded settle, no replay)', async () => {
  let view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'full' }
  const { calls, capability } = fakeCapability((call) => {
    view = { viewedSessionId: 'session-x', displayPreset: call.displayPreset === 'focus' ? 'full' : 'focus' }
    return ackOf(call)
  })
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    diag: DIAG,
  })
  try {
    const gate = await owner.ackCurrentView()
    assert.deepEqual(gate, { kind: 'unconfirmed' }, 'a never-settling view is reported unknown, never confirmed')
    assert.equal(calls.length, 3, 'the settle is bounded')
  } finally {
    owner.dispose()
  }
})

test('an unconfirmed presence refuses the gate without any automatic retry', async () => {
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { calls, capability } = fakeCapability(() => ({ ok: false }))
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    diag: DIAG,
  })
  try {
    assert.deepEqual(await owner.ackCurrentView(), { kind: 'unconfirmed' })
    assert.equal(calls.length, 1, 'a lost ACK is never replayed')
  } finally {
    owner.dispose()
  }
})

test('ackCurrentView is local (no wire call) while the committed view is still current', async () => {
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { calls, capability } = fakeCapability(ackOf)
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    transport: {
      capture: () => ({ generation: 1, binding: {} }),
      isCurrent: () => true,
    },
    diag: DIAG,
  })
  try {
    assert.deepEqual(await owner.sync(), { kind: 'applied', revision: 1 })
    const before = calls.length
    assert.deepEqual(await owner.ackCurrentView(), { kind: 'confirmed' },
      'the send-boundary re-check is local while the committed view is current')
    assert.equal(calls.length, before, 'no wire call for an already-ACKed current view')
  } finally {
    owner.dispose()
  }
})

test('a transport reconnect self-heals: the stale committed view re-projects on the new generation', async () => {
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { calls, capability } = fakeCapability(ackOf)
  let generation = 1
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: new AbortController().signal,
    transport: {
      capture: () => ({ generation, binding: {} }),
      isCurrent: (_sessionId, token) => (token as { generation: number }).generation === generation,
    },
    diag: DIAG,
  })
  try {
    assert.deepEqual(await owner.sync(), { kind: 'applied', revision: 1 })
    // The Connection generation rolls over silently (the old Peer's record is
    // gone on the Host); the committed view's transport identity is stale.
    generation = 2
    const before = calls.length
    assert.deepEqual(await owner.ackCurrentView(), { kind: 'confirmed' },
      'the gate re-projects the view on the CURRENT connection and confirms')
    assert.equal(calls.length, before + 1, 'the stale committed view is never trusted across generations')
    assert.equal(calls.at(-1)?.revision, 2)
  } finally {
    owner.dispose()
  }
})

test('the owner withdraws its view and stops dispatching after the lifecycle abort', async () => {
  const abort = new AbortController()
  const view: PromptPresenceLocalView = { viewedSessionId: 'session-x', displayPreset: 'focus' }
  const { calls, capability } = fakeCapability(ackOf)
  const owner = createPromptPresenceClient({
    capability,
    localView: () => view,
    signal: abort.signal,
    diag: DIAG,
  })
  const gateBefore = await owner.ackCurrentView()
  assert.deepEqual(gateBefore, { kind: 'confirmed' })
  abort.abort()
  // The teardown withdraw is best-effort and carries the null view.
  await new Promise(resolveWait => setImmediate(resolveWait))
  await new Promise(resolveWait => setImmediate(resolveWait))
  const last = calls.at(-1)
  assert.equal(last?.viewedSessionId, null, 'the teardown sends the null view (best-effort withdraw)')
  const before = calls.length
  await owner.sync()
  assert.equal(calls.length, before, 'a disposed owner never dispatches again')
})
