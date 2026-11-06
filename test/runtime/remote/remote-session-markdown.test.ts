/**
 * L3 adapter contract tests for the Remote Session Markdown port
 * (`runtime/remote/session-markdown-remote.ts`, S5-PR3): the official
 * authenticated `GET /api/session.markdown` mapping through the
 * composition-owned fetch — exact bytes, the official refusal vocabulary,
 * auth/permission/transport failures kept distinct from `none`/`unavailable`,
 * and caller-abort propagation.
 * @module @xmoon76/dsh-pi-tui/remote-session-markdown.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSessionMarkdown } from '../../../src/runtime/remote/session-markdown-remote.ts'

interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

function markdownPort(
  response: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { readonly port: RemoteSessionMarkdown; readonly calls: Recorded[] } {
  const calls: Recorded[] = []
  const port = new RemoteSessionMarkdown({
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      return response(url, init)
    },
  })
  return { port, calls }
}

function markdownResponse(body: string, contentType = 'text/markdown; charset=utf-8'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

test('read maps the official route and returns the exact Markdown bytes', async () => {
  const body = '# Title 汉字 🙂\n\n> 问题\n\n```html\n<details>literal</details>\n```\n\nanswer\n'
  const { port, calls } = markdownPort(() => markdownResponse(body))
  const read = await port.read('session a/b?c')
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal(read.markdown, body, 'the body is never trimmed, recoded, sanitized or prefixed')
  assert.equal(read.markdown.endsWith('\n'), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, '/api/session.markdown?sessionId=session+a%2Fb%3Fc',
    'the official path with a URL-encoded session id')
  assert.equal(calls[0]!.init?.method, 'GET')
})

test('read forwards the caller AbortSignal through the composition-owned fetch', async () => {
  const controller = new AbortController()
  const { port, calls } = markdownPort(() => markdownResponse('# t\n'))
  const read = await port.read('s1', controller.signal)
  assert.equal(read.kind, 'ready')
  assert.equal(calls[0]!.init?.signal, controller.signal, 'the caller signal is the fetch signal')
})

test('read classifies the official refusals: missing session vs missing route vs missing service', {
  concurrency: false,
}, async () => {
  const notFound = markdownPort(() => new Response('session not found', { status: 404 }))
  assert.deepEqual(await notFound.port.read('ghost'), { kind: 'none' })

  const unknownRoute = markdownPort(() => new Response('<html>404 Not Found</html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  }))
  assert.deepEqual(await unknownRoute.port.read('s1'), { kind: 'unavailable' },
    'an unknown 404 is a missing route, never a missing Session')

  const emptyNotFound = markdownPort(() => new Response(null, { status: 404 }))
  assert.deepEqual(await emptyNotFound.port.read('s1'), { kind: 'unavailable' })

  const missingService = markdownPort(() => new Response(
    'session markdown export is unavailable: missing session-query service',
    { status: 500 },
  ))
  assert.deepEqual(await missingService.port.read('s1'), { kind: 'unavailable' })
})

test('read rejects auth, generic 5xx, malformed success and transport failures instead of faking success', async () => {
  for (const status of [400, 401, 403]) {
    const denied = markdownPort(() => new Response('no', { status }))
    await assert.rejects(() => denied.port.read('s1'), new RegExp(`HTTP ${String(status)}`, 'u'),
      `${String(status)} must reject`)
  }

  const generic500 = markdownPort(() => new Response('session markdown export failed to read the stored log', { status: 500 }))
  await assert.rejects(() => generic500.port.read('s1'), /HTTP 500/u,
    'a non-missing-service 500 is a real failure, never unavailable')

  const unavailable503 = markdownPort(() => new Response('down', { status: 503 }))
  await assert.rejects(() => unavailable503.port.read('s1'), /HTTP 503/u)

  const html200 = markdownPort(() => markdownResponse('<html>login</html>', 'text/html; charset=utf-8'))
  await assert.rejects(() => html200.port.read('s1'), /unexpected content type/u,
    'an HTML 200 is a wire-contract violation')

  const missingType = markdownPort(() => new Response(null, { status: 200 }))
  await assert.rejects(() => missingType.port.read('s1'), /unexpected content type/u)

  const empty = markdownPort(() => markdownResponse(''))
  await assert.rejects(() => empty.port.read('s1'), /empty body/u,
    'an empty 200 is never a fabricated empty transcript')

  const offline = markdownPort(() => { throw new Error('socket closed') })
  await assert.rejects(() => offline.port.read('s1'), /socket closed/u)
})

test('read propagates caller abort before dispatch and while the body is unread', async () => {
  const preAborted = new AbortController()
  preAborted.abort(new Error('user cancelled the export'))
  const { port, calls } = markdownPort(() => markdownResponse('# t\n'))
  await assert.rejects(() => port.read('s1', preAborted.signal), /user cancelled the export/u)
  assert.equal(calls.length, 0, 'an already-aborted read never dispatches')

  const midBody = new AbortController()
  const streaming = markdownPort((_url, init) => {
    const signal = init?.signal ?? undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('# partial'))
        signal?.addEventListener('abort', () => {
          controller.error(Object.assign(new Error('aborted body'), { name: 'AbortError' }))
        }, { once: true })
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    })
  })
  const pending = streaming.port.read('s1', midBody.signal)
  midBody.abort()
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError',
    'a partial body is never returned as a complete transcript')
})
