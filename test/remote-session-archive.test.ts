/**
 * L3 adapter contract tests for the Remote session-archive port
 * (`runtime/remote/session-archive-remote.ts`, M3-3B): the official
 * `GET /api/session.export` mapping through the composition-owned fetch —
 * the upstream filename, the live (never buffered) byte stream, the
 * absent-session vs unavailable-services distinction, real-failure
 * propagation and caller-abort propagation.
 * @module @xmoon76/dsh-pi-tui/remote-session-archive.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSessionArchive } from '../src/runtime/remote/session-archive-remote.ts'

interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

function archive(response: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): {
  readonly port: RemoteSessionArchive
  readonly calls: Recorded[]
} {
  const calls: Recorded[] = []
  const port = new RemoteSessionArchive({
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      return response(url, init)
    },
  })
  return { port, calls }
}

function bytesResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dsh-session-s1.zip"', ...headers },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

test('open maps a ready export to the upstream filename and the live stream', async () => {
  const { port, calls } = archive(() => bytesResponse([new Uint8Array([1, 2]), new Uint8Array([3])]))
  const result = await port.open('s1')
  assert.equal(result.kind, 'ready')
  assert.ok(result.kind === 'ready')
  assert.equal(result.artifact.filename, 'dsh-session-s1.zip')
  assert.deepEqual([...await readAll(result.artifact.stream)], [1, 2, 3])
  assert.equal(calls.length, 1, 'one GET is the single round trip')
  assert.match(calls[0]!.url, /^\/api\/session\.export\?sessionId=s1&includeDescendants=true$/u)
  assert.equal(calls[0]!.init?.method, 'GET')
})

test('open reports none for a missing root Session and unavailable for missing Host services', async () => {
  const missing = archive(() => new Response('session not found', { status: 404 }))
  assert.deepEqual(await missing.port.open('ghost'), { kind: 'none' })

  const unavailable = archive(() => new Response(
    'session log export is unavailable: missing session-query, session-persistence, or attachments service',
    { status: 500 },
  ))
  assert.deepEqual(await unavailable.port.open('s1'), { kind: 'unavailable' })
})

test('open rejects a real failure instead of collapsing it to none', async () => {
  const failed = archive(() => new Response('boom', { status: 503 }))
  await assert.rejects(() => failed.port.open('s1'), /HTTP 503/u)

  const transport = archive(() => { throw new Error('socket closed') })
  await assert.rejects(() => transport.port.open('s1'), /socket closed/u)

  const noFilename = archive(() => new Response(new Uint8Array([1]), { status: 200 }))
  await assert.rejects(() => noFilename.port.open('s1'), /no filename or no body/u)
})

test('open propagates caller abort before dispatch and through the stream', async () => {
  const preAborted = new AbortController()
  preAborted.abort(new Error('user cancelled the export'))
  const { port, calls } = archive(() => bytesResponse([new Uint8Array([1])]))
  await assert.rejects(() => port.open('s1', preAborted.signal), /user cancelled the export/u)
  assert.equal(calls.length, 0, 'an aborted open never dispatches')

  // A stream tied to the fetch signal must error on abort rather than
  // yielding a truncated-but-successful artifact.
  const abortMid = new AbortController()
  const streaming = archive((_url, init) => {
    const signal = init?.signal ?? undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        signal?.addEventListener('abort', () => { controller.error(new Error('export aborted')) }, { once: true })
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="dsh-session-s1.zip"' },
    })
  })
  const opened = await streaming.port.open('s1', abortMid.signal)
  assert.ok(opened.kind === 'ready')
  const reader = opened.artifact.stream.getReader()
  assert.deepEqual([...(await reader.read()).value ?? []], [1])
  abortMid.abort(new Error('export aborted'))
  await assert.rejects(() => reader.read(), /export aborted/u)
})
