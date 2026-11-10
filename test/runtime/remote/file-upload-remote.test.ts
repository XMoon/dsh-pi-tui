/**
 * L3 contract coverage for the ONE Client-side raw file upload adapter:
 * the official `/api/session/uploadFileBinary` request shape, the two-layer
 * (HTTP + business) response validation, Host metadata extraction and the
 * source/carrier cancellation boundary. The fetch face is a structural
 * stand-in; a real wire proof lives in the split-process lane.
 *
 * @module @xmoon76/dsh-pi-tui/file-upload-remote.test
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { preparePrompt } from '../../../src/app/submission/prepared-prompt.ts'
import { DraftFileStore } from '../../../src/client/media/attachment/file-draft.ts'
import { probeAttachment } from '../../../src/client/media/attachment/intake.ts'
import {
  createRemoteFileReceiptUploader,
  RemoteFileUploadError,
  type RemoteFileReceiptUploader,
} from '../../../src/runtime/remote/file-upload-remote.ts'
import type { PreparedFile } from '../../../src/runtime/prepared-prompt.ts'
import { testLifecycle } from '../../support/temp-lifecycle.ts'

/** One prepared Client file with a countable, chunked source. */
function preparedFile(chunks: readonly Uint8Array[], onClose?: () => void): PreparedFile {
  return {
    name: 'report.bin',
    byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    source: {
      kind: 'client-stream',
      async *open(signal) {
        try {
          for (const chunk of chunks) {
            signal.throwIfAborted()
            yield chunk
          }
        } finally {
          onClose?.()
        }
      },
    },
  }
}

interface SeenRequest {
  readonly url: string
  readonly method: string | undefined
  readonly contentType: string | null
  readonly duplex: unknown
  readonly signal: AbortSignal | undefined
  readonly body: Uint8Array
}

/** One fetch double that drains the streaming body and answers `response`. */
function fetchOf(seen: SeenRequest[], response: () => Response): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const body = init.body as ReadableStream<Uint8Array>
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
    seen.push({
      url: String(input),
      method: init.method,
      contentType: new Headers(init.headers).get('content-type'),
      duplex: (init as { duplex?: unknown }).duplex,
      signal: init.signal ?? undefined,
      body: new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))),
    })
    return response()
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

const receipt = {
  ok: true,
  value: {
    receiptId: 'host-receipt-1',
    file: { attachmentId: 'host-file-1', name: 'report.bin', bytes: 5 },
  },
}

test('the raw upload addresses the official route with the authenticated streaming request', async () => {
  const seen: SeenRequest[] = []
  const uploader: RemoteFileReceiptUploader = createRemoteFileReceiptUploader(fetchOf(seen, () => jsonResponse(receipt)))
  const signal = new AbortController().signal
  const uploaded = await uploader.upload('session-a', preparedFile([
    new Uint8Array([1, 2]),
    new Uint8Array([3, 4, 5]),
  ]), signal)

  assert.deepEqual(uploaded, {
    receiptId: 'host-receipt-1',
    file: { attachmentId: 'host-file-1', name: 'report.bin', bytes: 5 },
  })
  assert.equal(seen.length, 1)
  const request = seen[0]!
  const url = new URL(request.url, 'http://dsh.invalid/')
  assert.equal(url.pathname, '/api/session/uploadFileBinary')
  assert.equal(url.searchParams.get('sessionId'), 'session-a')
  assert.equal(url.searchParams.get('name'), 'report.bin')
  assert.equal(request.method, 'POST')
  assert.equal(request.contentType, 'application/octet-stream')
  assert.equal(request.duplex, 'half', 'the Node carrier must stream the request body')
  assert.equal(request.signal, signal, 'the caller cancellation reaches the carrier')
  assert.deepEqual(Buffer.from(request.body), Buffer.from([1, 2, 3, 4, 5]),
    'the body is the source bytes, never a base64/JSON envelope')
  assert.equal(request.url.includes('base64'), false)
})

test('a non-2xx carrier response fails with the HTTP status and never claims a receipt', async () => {
  const seen: SeenRequest[] = []
  const uploader = createRemoteFileReceiptUploader(fetchOf(seen, () => new Response('unauthorized', { status: 401 })))
  await assert.rejects(
    uploader.upload('session-a', preparedFile([new Uint8Array([1])]), new AbortController().signal),
    (error: unknown) => error instanceof RemoteFileUploadError
      && error.code === 'session/prompt-upload-http-failed'
      && error.message.includes('401'),
  )
})

test('an HTTP 200 business refusal preserves the official code and message', async () => {
  const seen: SeenRequest[] = []
  const uploader = createRemoteFileReceiptUploader(fetchOf(seen, () => jsonResponse({
    ok: false,
    error: { code: 'session/not-found', message: 'session "session-z" not found', details: { sessionId: 'session-z' } },
  })))
  await assert.rejects(
    uploader.upload('session-a', preparedFile([new Uint8Array([1])]), new AbortController().signal),
    (error: unknown) => error instanceof RemoteFileUploadError
      && error.code === 'session/not-found'
      && error.message === 'session "session-z" not found',
  )
})

test('a malformed success payload fails closed instead of fabricating a receipt', async () => {
  for (const payload of [
    { ok: true, value: { receiptId: '', file: { attachmentId: 'a', name: 'n', bytes: 1 } } },
    { ok: true, value: { receiptId: 'r', file: { attachmentId: '', name: 'n', bytes: 1 } } },
    { ok: true, value: { receiptId: 'r', file: { attachmentId: 'a', name: 'n', bytes: -1 } } },
    { ok: true, value: { receiptId: 'r', file: { attachmentId: 'a', name: 'n', bytes: 1.5 } } },
    { ok: true, value: { receiptId: 'r' } },
    { ok: false, error: {} },
  ]) {
    const seen: SeenRequest[] = []
    const uploader = createRemoteFileReceiptUploader(fetchOf(seen, () => jsonResponse(payload)))
    await assert.rejects(
      uploader.upload('session-a', preparedFile([new Uint8Array([1])]), new AbortController().signal),
      (error: unknown) => error instanceof RemoteFileUploadError
        && error.code === 'session/prompt-upload-invalid-response',
      JSON.stringify(payload),
    )
  }
})

test('a caller abort closes the Client source stream and the carrier never sees a later chunk', async () => {
  let closed = 0
  let releaseChunk!: () => void
  const gate = new Promise<void>(resolve => { releaseChunk = resolve })
  const controller = new AbortController()
  const uploader = createRemoteFileReceiptUploader(async (_input, init = {}) => {
    const body = init.body as ReadableStream<Uint8Array>
    const reader = body.getReader()
    // First chunk proves the stream is live; then the caller aborts while the
    // source is parked between chunks. WHATWG fetch aborts the request body
    // stream, which is the adapter's cancel path.
    const first = await reader.read()
    assert.equal(first.done, false)
    assert.deepEqual(Buffer.from(first.value!), Buffer.from([7]))
    releaseChunk()
    controller.abort()
    await reader.cancel('aborted')
    throw new DOMException('upload aborted', 'AbortError')
  })
  const file: PreparedFile = {
    name: 'slow.bin',
    byteLength: 2,
    source: {
      kind: 'client-stream',
      async *open(signal) {
        try {
          yield new Uint8Array([7])
          await gate
          signal.throwIfAborted()
          yield new Uint8Array([8])
        } finally {
          closed += 1
        }
      },
    },
  }
  await assert.rejects(uploader.upload('session-a', file, controller.signal))
  assert.equal(closed, 1, 'the source iterator finalizer closes the Client-local stream exactly once')
})

test('a recalled file source is refused before any network request', async () => {
  let requests = 0
  const uploader = createRemoteFileReceiptUploader(async () => {
    requests += 1
    return jsonResponse(receipt)
  })
  await assert.rejects(
    uploader.upload('session-a', { name: 'old.bin', byteLength: 3, source: { kind: 'recalled-unsupported' } }, new AbortController().signal),
    (error: unknown) => error instanceof RemoteFileUploadError
      && error.code === 'session/prompt-file-unsupported',
  )
  assert.equal(requests, 0)
})

test('a source changed after /attach fails locally before the Host upload request', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-f4-upload-changed-')
  const path = join(root, 'changed.bin')
  writeFileSync(path, Buffer.alloc(128, 1))
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const files = new DraftFileStore()
  const draft = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  const prepared = preparePrompt('session-a', `x ${draft.placeholder}`, {
    images: { values: () => [] },
    files,
  })
  const fileSegment = prepared.segments.find(segment => segment.type === 'file')
  assert.ok(fileSegment !== undefined && fileSegment.type === 'file')
  writeFileSync(path, Buffer.alloc(3, 2))
  let requests = 0
  const uploader = createRemoteFileReceiptUploader(async () => {
    requests += 1
    return jsonResponse(receipt)
  })
  await assert.rejects(
    uploader.upload('session-a', fileSegment!.file, new AbortController().signal),
    (error: unknown) => error instanceof Error && error.message.includes('changed since it was attached'),
  )
  assert.equal(requests, 0, 'the Host never receives an upload request for an invalidated source')
})

// ── Real-carrier teardown: the request body must be released on early exits ──

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

function closeLoopback(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

/** One Client source that records its generator finalizer and pulled chunks. */
function trackedSource(chunks: number, onChunk?: () => void, gate?: (signal: AbortSignal) => Promise<void>): {
  readonly file: PreparedFile
  closed(): number
  pulled(): number
} {
  let closed = 0
  let pulled = 0
  return {
    file: {
      name: 'tracked.bin',
      byteLength: chunks * 64 * 1024,
      source: {
        kind: 'client-stream',
        async *open(signal) {
          try {
            for (let index = 0; index < chunks; index += 1) {
              signal.throwIfAborted()
              pulled += 1
              onChunk?.()
              yield new Uint8Array(64 * 1024).fill(index)
            }
            await gate?.(signal)
          } finally {
            closed += 1
          }
        },
      },
    },
    closed: () => closed,
    pulled: () => pulled,
  }
}

test('a real early HTTP refusal closes the Client source iterator and its finalizer', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(401)
    response.end('unauthorized')
  })
  t.after(() => closeLoopback(server))
  const port = await listenOnLoopback(server)
  const source = trackedSource(8)
  const uploader = createRemoteFileReceiptUploader((input, init) =>
    fetch(new URL(String(input), `http://127.0.0.1:${port}`), init))

  await assert.rejects(
    uploader.upload('session-a', source.file, new AbortController().signal),
    (error: unknown) => error instanceof RemoteFileUploadError && error.code === 'session/prompt-upload-http-failed',
  )
  assert.equal(source.closed(), 1,
    'the streamer finalizer (file-descriptor close) runs even when the carrier refuses the upload')
  assert.ok(source.pulled() >= 1, 'the source really reached the carrier before the refusal')
})

test('a carrier that returns a refusal without consuming or canceling the body still closes the Client source', async () => {
  // Deterministic early-exit carrier: it reads ONE chunk, then returns 401 and
  // never touches the body again. Before the explicit close boundary the
  // generator stayed suspended at its yield (its finally, and the file
  // descriptor, leaked); the Client must own that release.
  const source = trackedSource(8)
  let requests = 0
  const uploader = createRemoteFileReceiptUploader(async (_input, init = {}) => {
    requests += 1
    const reader = (init.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    return new Response('unauthorized', { status: 401 })
  })

  await assert.rejects(
    uploader.upload('session-a', source.file, new AbortController().signal),
    (error: unknown) => error instanceof RemoteFileUploadError && error.code === 'session/prompt-upload-http-failed',
  )
  assert.equal(requests, 1)
  assert.equal(source.closed(), 1,
    'the Client closes the source iterator even though the carrier never canceled the request body')
  assert.ok(source.pulled() < 8, 'the carrier abandoned the body before EOF')
})

test('a carrier cancel racing the upload failure shares one close completion before the refusal settles', async () => {
  let closed = 0
  let releaseGate!: () => void
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const file: PreparedFile = {
    name: 'racing.bin',
    byteLength: 64 * 1024,
    source: {
      kind: 'client-stream',
      async *open() {
        try {
          yield new Uint8Array(64 * 1024)
          await gate
        } finally {
          closed += 1
        }
      },
    },
  }
  let cancelStarted: Promise<void> | undefined
  const uploader = createRemoteFileReceiptUploader(async (_input, init = {}) => {
    const reader = (init.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    // Deliberately NOT awaited: the carrier's cancel runs concurrently with
    // the upload's own failure-path close.
    cancelStarted = reader.cancel('early-refusal')
    return new Response('unauthorized', { status: 401 })
  })
  let settled = false
  const pending = uploader.upload('session-a', file, new AbortController().signal)
    .finally(() => { settled = true })
  for (let round = 0; round < 50 && cancelStarted === undefined; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.ok(cancelStarted !== undefined, 'the carrier really started its own cancel')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false,
    'the refusal must not settle while the in-flight source close is still parked')
  releaseGate()
  await assert.rejects(pending)
  await cancelStarted
  assert.equal(closed, 1, 'both callers observed the SAME completed close')
})

test('a real carrier that drops the connection still closes the Client source', async (t) => {
  const server = createServer(request => {
    request.socket.destroy()
  })
  t.after(() => closeLoopback(server))
  const port = await listenOnLoopback(server)
  const source = trackedSource(8)
  const uploader = createRemoteFileReceiptUploader((input, init) =>
    fetch(new URL(String(input), `http://127.0.0.1:${port}`), init))

  await assert.rejects(uploader.upload('session-a', source.file, new AbortController().signal))
  assert.equal(source.closed(), 1, 'a carrier failure before EOF still releases the Client source')
})

test('a real abort of a parked carrier closes the Client source', async (t) => {
  const server = createServer(() => {
    // Keep the request open: the body is consumed slowly and no response ever
    // arrives, so only the caller abort can end the carrier.
  })
  t.after(() => closeLoopback(server))
  const port = await listenOnLoopback(server)
  const source = trackedSource(1, undefined, signal => new Promise<void>(resolve => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  }))
  const controller = new AbortController()
  const uploader = createRemoteFileReceiptUploader((input, init) =>
    fetch(new URL(String(input), `http://127.0.0.1:${port}`), init))

  const pending = uploader.upload('session-a', source.file, controller.signal)
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending)
  assert.equal(source.closed(), 1, 'the abort path releases the Client source through the same close boundary')
})
