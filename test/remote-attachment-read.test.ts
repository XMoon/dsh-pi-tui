/**
 * L3 contract tests for the Remote durable-image read capability (M3-5 PR2
 * Step 9, plan §5 Must 20, §6 Must-not 10-12, §13 Images).
 *
 * `createRemotePresentationSource` assembles `attachments.readDurableImage`
 * over the ONE Remote graph. The read must borrow the EXACT retained binding,
 * capture the Connection generation + binding identity, read through that
 * Session's own `readAttachment`, and re-check BOTH before the bytes become a
 * current result. No cold `retain()`, no Host attachment service.
 * @module @xmoon76/dsh-pi-tui/remote-attachment-read.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { RemoteAttachmentSource } from '../src/app/application-runtime.ts'
import type { RemoteAttachmentReadResult } from '../src/app/remote/child-view.ts'
import { createRemotePresentationSource } from '../src/app/remote/presentation-source.ts'
import type { ExperimentalRemoteRuntime, RemoteBackendRuntime } from '../src/app/remote/runtime.ts'
import type { RemoteSessionReferenceLike } from '../src/runtime/remote/session-reference.ts'

interface AttachmentBinding {
  readonly session: {
    getSnapshot(): { readonly running: boolean }
    readAttachment(attachmentId: string): Promise<RemoteAttachmentReadResult>
  }
}

interface AttachmentHarness {
  readonly attachments: RemoteAttachmentSource
  /** The attachment ids the CURRENT binding's `readAttachment` was asked for. */
  readonly reads: string[]
  /** Every `sessions.retain` call; a durable image read must never make one. */
  readonly retains: unknown[]
  setBinding(binding: AttachmentBinding | undefined): void
  /** A DISTINCT binding object over the same read behavior (a rollover). */
  newBinding(): AttachmentBinding
  setGeneration(generation: object | undefined): void
}

interface AttachmentHarnessOptions {
  readAttachment?: (attachmentId: string) => Promise<RemoteAttachmentReadResult>
}

/**
 * Build the REAL Remote presentation bundle over a borrow-only sessions face.
 * `retain` throws by construction: the image read is a borrow-only capability,
 * so any retain on this path is a loud failure rather than a silent cold-open.
 */
function attachmentHarness(options: AttachmentHarnessOptions = {}): AttachmentHarness {
  const reads: string[] = []
  const retains: unknown[] = []
  const run = options.readAttachment ?? (async (attachmentId: string): Promise<RemoteAttachmentReadResult> => ({
    ok: true,
    value: { attachment: { attachmentId }, data: new Uint8Array([attachmentId.length]) },
  }))
  const makeBinding = (): AttachmentBinding => ({
    session: {
      getSnapshot: () => ({ running: true }),
      readAttachment: async attachmentId => {
        reads.push(attachmentId)
        return await run(attachmentId)
      },
    },
  })
  let binding: AttachmentBinding | undefined = makeBinding()
  let generation: object | undefined = { id: 'generation-1' }

  const sessions = {
    binding: (id: string): AttachmentBinding | undefined => id === 'session-1' ? binding : undefined,
    retain: (target: unknown, options2: unknown): RemoteSessionReferenceLike => {
      retains.push({ target, options: options2 })
      throw new Error('a durable image read must never cold-retain a Session')
    },
    list: { subscribe: () => () => {} },
  }
  const wire = {
    client: {
      sessions,
      connection: { generation: { getSnapshot: () => generation } },
      jobs: { state: { getSnapshot: () => ({ rows: {} }), subscribe: () => () => {} } },
      remote: {
        commands: { list: async () => ({ ok: true, value: [] }) },
        skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
      },
    },
  } as unknown as ExperimentalRemoteRuntime
  const backendRuntime = {
    semantics: {
      sessionReader: { sessionStatus: () => undefined },
      presentationReader: {
        read: async () => undefined,
        loadOlder: async () => undefined,
        loadThrough: async () => undefined,
      },
    },
  } as unknown as RemoteBackendRuntime

  return {
    attachments: createRemotePresentationSource(wire, backendRuntime).attachments,
    reads,
    retains,
    setBinding(next) { binding = next },
    newBinding: makeBinding,
    setGeneration(next) { generation = next },
  }
}

test('reads through the EXACT retained binding readAttachment with no cold retain', async () => {
  const harness = attachmentHarness()
  const result = await harness.attachments.readDurableImage('session-1', 'attach-7')

  assert.deepEqual(harness.reads, ['attach-7'], 'the exact attachment id reaches the retained Session')
  assert.deepEqual(harness.retains, [], 'a durable image read never calls sessions.retain')
  assert.deepEqual(result.ref, { attachmentId: 'attach-7' }, 'the official attachment ref is returned unwrapped')
  assert.deepEqual(result.data, new Uint8Array([8]), 'the exact bytes are returned')
})

test('an unwrapped RemoteResult failure rejects (a visible load failure, never empty bytes)', async () => {
  const denied = new Error('attachment denied by the Host')
  const harness = attachmentHarness({ readAttachment: async () => ({ ok: false, error: denied }) })

  await assert.rejects(
    harness.attachments.readDurableImage('session-1', 'attach-7'),
    error => error === denied,
    'the official failure error is surfaced by identity',
  )
  assert.deepEqual(harness.retains, [], 'a rejected read still never cold-retains')
})

test('a binding replaced while the read is in flight is refused, not committed as current bytes', async () => {
  let releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  const harness = attachmentHarness({
    readAttachment: async (attachmentId) => {
      await gate
      return { ok: true, value: { attachment: { attachmentId, stale: true }, data: new Uint8Array([9]) } }
    },
  })

  const pending = harness.attachments.readDurableImage('session-1', 'attach-7')
  await Promise.resolve()
  assert.deepEqual(harness.reads, ['attach-7'], 'the read is in flight against the original binding')
  harness.setBinding(harness.newBinding())
  releaseRead()

  await assert.rejects(pending, /the Session binding for session-1 changed while the attachment was read/)
  assert.deepEqual(harness.retains, [], 'the refused read never cold-retains')
})

test('a Connection generation replacement while the read is in flight is refused', async () => {
  let releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  const harness = attachmentHarness({ readAttachment: async () => { await gate; return { ok: true, value: { attachment: {}, data: new Uint8Array([1]) } } } })

  const pending = harness.attachments.readDurableImage('session-1', 'attach-7')
  await Promise.resolve()
  harness.setGeneration({ id: 'generation-2' })
  releaseRead()

  await assert.rejects(pending, /changed while the attachment was read/)
})

test('an unretained session rejects and never cold-retains one', async () => {
  const harness = attachmentHarness()
  harness.setBinding(undefined)

  await assert.rejects(
    harness.attachments.readDurableImage('session-1', 'attach-7'),
    /no retained Session binding for session-1/,
  )
  assert.deepEqual(harness.reads, [], 'no binding means no read at all')
  assert.deepEqual(harness.retains, [], 'and no cold retain to manufacture one')
})

test('a missing Connection generation rejects as a not-ready transport, not an empty read', async () => {
  const harness = attachmentHarness()
  harness.setGeneration(undefined)

  await assert.rejects(
    harness.attachments.readDurableImage('session-1', 'attach-7'),
    /the Remote connection is not ready to read an attachment of session-1/,
  )
  assert.deepEqual(harness.reads, [], 'a disconnected transport reads nothing')
  assert.deepEqual(harness.retains, [], 'and cold-retains nothing')
})
