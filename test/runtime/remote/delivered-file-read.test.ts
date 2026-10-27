/**
 * Delivered files PR2 / M11: the Remote delivered-file read adapter's semantic
 * mapping and CURRENTNESS fence.
 *
 * The real wire positive lives in `test/integration/delivered-file-preview-wire.test.ts`;
 * this suite proves the parts a real connection cannot be made to reproduce on
 * demand: a reply carried by a SUPERSEDED generation must never become the new
 * generation's definite outcome (late success AND late failure), the official
 * refusal codes map onto the port vocabulary, a missing namespace is a definite
 * "unavailable", and the caller's cancellation is never rewritten as a Host
 * outcome.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/delivered-file-read.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import { DeliveredFileReadError } from '../../../src/runtime/deliverables-port.ts'
import { DELIVERED_FILE_PAGE_LINES } from '../../../src/runtime/deliverables-port.ts'
import { RemoteDeliveredFileReadPort } from '../../../src/runtime/remote/deliverables-remote.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'
import type { RemoteResultLike } from '../../../src/runtime/remote/session-writer-remote.ts'

const abort = new AbortController().signal

/** A controllable Connection generation source. */
function generationSource(initial: RemoteConnectionGeneration): { source: { getSnapshot(): RemoteConnectionGeneration | undefined; subscribe(): () => void }; set(next: RemoteConnectionGeneration): void } {
  let current: RemoteConnectionGeneration | undefined = initial
  return {
    source: {
      getSnapshot: () => current,
      subscribe: () => () => {},
    },
    set: (next) => { current = next },
  }
}

/** A deferred official result. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

function unusedReadError(): Error {
  return Object.assign(new Error('the read path is not exercised here'), { code: 'workspace-file/not-found' })
}

const STAT: RemoteResultLike<{ readonly version: string; readonly bytes?: number }> = {
  ok: true,
  value: { version: 'v1', bytes: 12 },
}

test('a reply from a SUPERSEDED generation is stale, never the new outcome', async () => {
  const wire = deferred<RemoteResultLike<{ readonly version: string }>>()
  const generation = generationSource({ id: 'g1' })
  const port = new RemoteDeliveredFileReadPort(
    { stat: () => wire.promise, read: async () => ({ ok: false, error: unusedReadError() }) },
    generation.source,
  )
  const pending = port.stat('session-1', '/ws/report.md', abort)
  // The connection is replaced while the read is in flight.
  generation.set({ id: 'g2' })
  wire.resolve(STAT)
  await assert.rejects(pending, SupersededReadError)
})

test('a late REFUSAL is stale too (it must not become the new generation failure)', async () => {
  const wire = deferred<RemoteResultLike<{ readonly version: string }>>()
  const generation = generationSource({ id: 'g1' })
  const port = new RemoteDeliveredFileReadPort(
    { stat: () => wire.promise, read: async () => ({ ok: false, error: unusedReadError() }) },
    generation.source,
  )
  const pending = port.stat('session-1', '/ws/report.md', abort)
  generation.set({ id: 'g2' })
  wire.resolve({ ok: false, error: Object.assign(new Error('gone'), { code: 'workspace-file/not-found' }) })
  await assert.rejects(pending, SupersededReadError)
})

test('an unchanged generation preserves the official refusal taxonomy', async () => {
  const generation = generationSource({ id: 'g1' })
  const notText = new RemoteDeliveredFileReadPort(
    {
      stat: async () => ({ ok: false, error: Object.assign(new Error('nul'), { code: 'workspace-file/not-text' }) }),
      read: async () => ({ ok: false, error: Object.assign(new Error('nul'), { code: 'workspace-file/not-text' }) }),
    },
    generation.source,
  )
  await assert.rejects(notText.stat('s', '/ws/a.md', abort), (error: unknown) => {
    assert.ok(error instanceof DeliveredFileReadError)
    assert.equal(error.code, 'not-text')
    return true
  })
  // The generated Remote's assembly refusal for an unresolvable Session scope
  // is the preview's `session-unavailable`, not a missing file.
  const unresolved = new RemoteDeliveredFileReadPort(
    {
      stat: async () => ({ ok: false, error: Object.assign(new Error('typert gateway'), { code: 'gateway/lookup-not-found' }) }),
      read: async () => ({ ok: false, error: Object.assign(new Error('typert gateway'), { code: 'gateway/lookup-not-found' }) }),
    },
    generation.source,
  )
  await assert.rejects(unresolved.stat('missing', '/ws/a.md', abort), (error: unknown) => {
    assert.ok(error instanceof DeliveredFileReadError)
    assert.equal(error.code, 'session-unavailable')
    return true
  })
  // An UNRECOGNIZED official code is not invented into a state.
  const weird = Object.assign(new Error('weird'), { code: 'workspace-file/not-directory' })
  const unknown = new RemoteDeliveredFileReadPort(
    { stat: async () => ({ ok: false, error: weird }), read: async () => ({ ok: false, error: weird }) },
    generation.source,
  )
  await assert.rejects(unknown.stat('s', '/ws/a.md', abort), (error: unknown) => error === weird)
})

test('a missing namespace is a definite unavailable, never a fallback', async () => {
  const port = new RemoteDeliveredFileReadPort(undefined, generationSource({ id: 'g1' }).source)
  await assert.rejects(port.stat('s', '/ws/a.md', abort), (error: unknown) => {
    assert.ok(error instanceof DeliveredFileReadError)
    assert.equal(error.code, 'service-unavailable')
    return true
  })
})

test('the caller\'s cancellation is never rewritten as a Host outcome', async () => {
  const generation = generationSource({ id: 'g1' })
  const controller = new AbortController()
  controller.abort(new Error('caller moved on'))
  const never = new RemoteDeliveredFileReadPort(
    { stat: () => new Promise(() => {}), read: () => new Promise(() => {}) },
    generation.source,
  )
  await assert.rejects(never.stat('s', '/ws/a.md', controller.signal), /caller moved on/)

  // An abort DURING the read is the caller's cancellation, not a stale result.
  const wire = deferred<RemoteResultLike<{ readonly version: string }>>()
  const during = new AbortController()
  const port = new RemoteDeliveredFileReadPort(
    { stat: () => wire.promise, read: async () => ({ ok: false, error: unusedReadError() }) },
    generation.source,
  )
  const pending = port.stat('s', '/ws/a.md', during.signal)
  during.abort(new Error('cancelled while reading'))
  wire.resolve({ ok: false, error: Object.assign(new Error('gateway/cancelled'), { code: 'gateway/cancelled' }) })
  await assert.rejects(pending, /cancelled while reading/)
})

test('the read page carries the PORT page size and the Host version', async () => {
  let askedRange: { offset?: number; limit?: number } | undefined
  const port = new RemoteDeliveredFileReadPort(
    {
      stat: async () => STAT,
      read: async (_session, _path, range) => {
        askedRange = range
        return {
          ok: true,
          value: { version: 'v2', bytes: 20, text: 'beta', lines: 1, eof: false, offset: range.offset ?? 1 },
        }
      },
    },
    generationSource({ id: 'g1' }).source,
  )
  const page = await port.read('s', '/ws/a.md', 2, abort)
  // The caller chooses the OFFSET only: the page bound is the port's contract.
  assert.deepEqual(askedRange, { offset: 2, limit: DELIVERED_FILE_PAGE_LINES })
  assert.deepEqual(page, {
    stat: { version: 'v2', bytes: 20 },
    offset: 2,
    limit: DELIVERED_FILE_PAGE_LINES,
    text: 'beta',
    lines: 1,
    eof: false,
  })
})
