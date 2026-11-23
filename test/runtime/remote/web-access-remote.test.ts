/**
 * The Remote `WebAccessPort` (M5-W PR-C / PR-A): the semantic Web frontend
 * control over the private `piTuiWebAccess` Client namespace.
 *
 * Two currentness layers are proven structurally here — the single-call fence
 * (captured before dispatch, compared after it) and the optional
 * `expectedGeneration` pre-dispatch fence a caller uses to bind a user choice
 * to the Host it was displayed under. The real Split Host owns the wire proof;
 * this suite owns the adapter contract, including the LEGACY calls the TSP
 * picker still makes without a generation.
 *
 * @module @xmoon76/dsh-pi-tui/web-access-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteWebAccessPort, type RemoteWebAccessNamespace } from '../../../src/runtime/remote/web-access-remote.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import type { WebAccessStatus, WebAccessUrl } from '../../../src/runtime/web-access-port.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'

/** A generation source a case can replace, notifying subscribers like the
 *  real Connection does. */
function generationSource(initial: RemoteConnectionGeneration | undefined): {
  getSnapshot(): RemoteConnectionGeneration | undefined
  subscribe(listener: () => void): () => void
  set(value: RemoteConnectionGeneration | undefined): void
  listeners(): number
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    listeners: () => listeners.size,
  }
}

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

/** One fresh opaque generation identity (the Connection mints a new object). */
let generationSeq = 0
const nextGeneration = (): RemoteConnectionGeneration => {
  generationSeq += 1
  return { id: generationSeq }
}

/** One namespace whose calls the case observes and can hold/fail. */
function namespace(overrides: Partial<RemoteWebAccessNamespace> = {}): {
  readonly face: RemoteWebAccessNamespace
  readonly calls: string[]
  readonly enabled: boolean[]
} {
  const calls: string[] = []
  const enabled: boolean[] = []
  const face: RemoteWebAccessNamespace = {
    getStatus: async () => {
      calls.push('getStatus')
      return ok<WebAccessStatus>({ state: 'enabled' })
    },
    setEnabled: async (value: boolean) => {
      calls.push(`setEnabled:${String(value)}`)
      enabled.push(value)
      return ok<WebAccessStatus>({ state: value ? 'enabled' : 'disabled' })
    },
    getAuthenticatedUrl: async () => {
      calls.push('getAuthenticatedUrl')
      return ok<WebAccessUrl>({ url: 'http://127.0.0.1:4321/?token=SECRET' })
    },
    ...overrides,
  }
  return { face, calls, enabled }
}

test('the legacy status read is generation-fenced around the call and keeps its shape', async () => {
  const generation = generationSource(nextGeneration())
  const calls = namespace()
  const port = new RemoteWebAccessPort(calls.face, generation)
  assert.deepEqual(await port.getStatus(), { state: 'enabled' })
  assert.deepEqual(calls.calls, ['getStatus'])
  // A generation change DURING the call turns the reply into a superseded read.
  const held = namespace({ getStatus: async () => {
    generation.set(nextGeneration())
    return ok<WebAccessStatus>({ state: 'enabled' })
  } })
  await assert.rejects(new RemoteWebAccessPort(held.face, generation).getStatus(), SupersededReadError)
})

test('a disconnected Client is a definite read failure, never a fabricated state', async () => {
  const disconnected = new RemoteWebAccessPort(namespace().face, generationSource(undefined))
  await assert.rejects(disconnected.getStatus(), /not connected to a Host/u)
  // A Host whose private namespace is not mounted is a definite unavailable,
  // never a Direct fallback.
  const unmounted = new RemoteWebAccessPort(undefined, generationSource(nextGeneration()))
  await assert.rejects(unmounted.getStatus(), /piTuiWebAccess Remote namespace is not mounted/u)
})

test('the legacy toggle/URL calls stay compatible (no expectedGeneration)', async () => {
  const generation = generationSource(nextGeneration())
  const calls = namespace()
  const port = new RemoteWebAccessPort(calls.face, generation)
  assert.deepEqual(await port.setEnabled(true), { state: 'enabled' })
  assert.deepEqual(await port.getAuthenticatedUrl(), { url: 'http://127.0.0.1:4321/?token=SECRET' })
  assert.deepEqual(calls.calls, ['setEnabled:true', 'getAuthenticatedUrl'])
  assert.deepEqual(calls.enabled, [true])
})

test('expectedGeneration refuses BEFORE dispatch when the Host was replaced', async () => {
  const observed = nextGeneration()
  const generation = generationSource(observed)
  const calls = namespace()
  const port = new RemoteWebAccessPort(calls.face, generation)
  generation.set(nextGeneration())
  await assert.rejects(port.setEnabled(false, observed), SupersededReadError)
  await assert.rejects(port.getAuthenticatedUrl(observed), SupersededReadError)
  assert.deepEqual(calls.calls, [], 'zero Host dispatch: not one namespace method was called')
})

test('a matching expectedGeneration dispatches exactly once', async () => {
  const observed = nextGeneration()
  const generation = generationSource(observed)
  const calls = namespace()
  const port = new RemoteWebAccessPort(calls.face, generation)
  assert.deepEqual(await port.setEnabled(false, observed), { state: 'disabled' })
  assert.deepEqual(await port.getAuthenticatedUrl(observed), { url: 'http://127.0.0.1:4321/?token=SECRET' })
  assert.deepEqual(calls.calls, ['setEnabled:false', 'getAuthenticatedUrl'], 'one dispatch per intent, never replayed')
})

test('a reply carried by a replaced Host is superseded, and the request is never resent', async () => {
  const observed = nextGeneration()
  const generation = generationSource(observed)
  let dispatched = 0
  const face = namespace({
    setEnabled: async (value: boolean) => {
      dispatched += 1
      // The Host was replaced while the request was in flight: the reply now
      // belongs to a generation the Client no longer owns.
      generation.set(nextGeneration())
      return ok<WebAccessStatus>({ state: value ? 'enabled' : 'disabled' })
    },
  })
  await assert.rejects(new RemoteWebAccessPort(face.face, generation).setEnabled(true, observed), SupersededReadError)
  assert.equal(dispatched, 1, 'the side-effecting request is never replayed')
})

test('a refusal and a transport rejection are generation-bound too', async () => {
  const generation = generationSource(nextGeneration())
  const refused = namespace({ getStatus: async () => ({ ok: false, error: new Error('refused') } as never) })
  await assert.rejects(new RemoteWebAccessPort(refused.face, generation).getStatus(), /refused/u)
  const stale = namespace({ getStatus: async () => {
    generation.set(nextGeneration())
    return { ok: false, error: new Error('refused') } as never
  } })
  await assert.rejects(new RemoteWebAccessPort(stale.face, generation).getStatus(), SupersededReadError,
    'a stale failure is never presented as the new generation\'s definite state')
})

test('currentGeneration/subscribeGeneration forward the ONE Connection authority', () => {
  const first = nextGeneration()
  const generation = generationSource(first)
  const port = new RemoteWebAccessPort(namespace().face, generation)
  assert.equal(Object.is(port.currentGeneration(), first), true)
  let notified = 0
  const unsubscribe = port.subscribeGeneration(() => { notified += 1 })
  assert.equal(generation.listeners(), 1)
  generation.set(nextGeneration())
  assert.equal(notified, 1, 'the page observes a real Host generation change')
  assert.equal(Object.is(port.currentGeneration(), generation.getSnapshot()), true)
  unsubscribe()
  assert.equal(generation.listeners(), 0, 'the page subscription is released with it')
})
