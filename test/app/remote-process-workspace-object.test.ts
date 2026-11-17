/**
 * The Host-owned read-only Workspace directory-object route contract.
 *
 * These are L2/L3 unit tests for the handler and the Client observation
 * helper: exact request/response shapes, the request/path/response bounds, the
 * instance fence and the fail-closed mapping. The OFFICIAL Owner-only Cookie
 * admission and the real Host inode fact are proven by the packed macOS L6
 * smoke, not here.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-workspace-object.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  createWorkspaceObjectHandler,
  LOCAL_WORKSPACE_OBJECT_ROUTE,
  observeHostWorkspaceObject,
} from '../../src/app/remote-process/local-workspace-object.ts'

const INSTANCE = '11111111-1111-4111-8111-111111111111'
const ORIGIN = 'http://127.0.0.1:41001'

function tempDir(t: TestContext): string {
  return testLifecycle(t).tempDir('dsh-workspace-object-')
}

function request(body: unknown, init: { method?: string; contentType?: string | null; raw?: string } = {}): Request {
  const headers = new Headers()
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json')
  return new Request(`${ORIGIN}${LOCAL_WORKSPACE_OBJECT_ROUTE}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.raw ?? JSON.stringify(body),
  })
}

/** One authenticated-fetch stand-in with a fixed response. */
function fetchOf(response: () => Response): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async () => response()
}

test('the handler returns the exact decimal Host directory object for a real directory', async t => {
  const dir = tempDir(t)
  const handler = createWorkspaceObjectHandler(INSTANCE)
  const response = await handler(request({ instanceId: INSTANCE, path: dir }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.text()
  assert.ok(Buffer.byteLength(body, 'utf8') <= 1024)
  assert.deepEqual(Object.keys(JSON.parse(body) as Record<string, unknown>).sort(), ['device', 'inode', 'instanceId', 'schema'])
  const value = JSON.parse(body) as { readonly schema: number; readonly instanceId: string; readonly device: string; readonly inode: string }
  assert.equal(value.schema, 1)
  assert.equal(value.instanceId, INSTANCE)
  assert.match(value.device, /^\d+$/u)
  assert.match(value.inode, /^\d+$/u)
  // The observation is read-only: the directory gained no entry.
  assert.deepEqual(readdirSync(dir), [])
})

test('a symlinked alias of the SAME directory reports the same object', async t => {
  const root = tempDir(t)
  const dir = join(root, 'real')
  mkdirSync(dir)
  const alias = join(root, 'alias')
  symlinkSync(dir, alias)
  const handler = createWorkspaceObjectHandler(INSTANCE)
  const real = JSON.parse(await (await handler(request({ instanceId: INSTANCE, path: dir }))).text()) as { device: string; inode: string }
  const linked = JSON.parse(await (await handler(request({ instanceId: INSTANCE, path: alias }))).text()) as { device: string; inode: string }
  assert.equal(linked.device, real.device)
  assert.equal(linked.inode, real.inode)
})

test('the handler refuses every method, body, instance and path shape outside its contract', async t => {
  const root = tempDir(t)
  const dir = join(root, 'dir')
  mkdirSync(dir)
  const file = join(root, 'file.txt')
  writeFileSync(file, 'x')
  const handler = createWorkspaceObjectHandler(INSTANCE)
  const status = async (req: Request): Promise<number> => {
    const response = await handler(req)
    await response.body?.cancel()
    return response.status
  }
  assert.equal(await status(new Request(`${ORIGIN}${LOCAL_WORKSPACE_OBJECT_ROUTE}`, { method: 'GET' })), 405)
  assert.equal(await status(request({ instanceId: INSTANCE, path: dir }, { contentType: 'text/plain' })), 400)
  assert.equal(await status(request(undefined, { raw: 'not-json' })), 400)
  assert.equal(await status(request({ instanceId: INSTANCE, path: dir, extra: 1 })), 400)
  assert.equal(await status(request({ instanceId: INSTANCE })), 400)
  assert.equal(await status(request({ instanceId: '22222222-2222-4222-8222-222222222222', path: dir })), 409)
  assert.equal(await status(request({ instanceId: INSTANCE, path: '' })), 400)
  assert.equal(await status(request({ instanceId: INSTANCE, path: 'relative/path' })), 400)
  assert.equal(await status(request({ instanceId: INSTANCE, path: `${dir}\0tail` })), 400)
  assert.equal(await status(request({ instanceId: INSTANCE, path: `/${'a'.repeat(4096)}` })), 400)
  assert.equal(await status(request({ instanceId: INSTANCE, path: file })), 404)
  assert.equal(await status(request({ instanceId: INSTANCE, path: join(root, 'missing') })), 404)
  // An oversize body is refused before JSON parsing.
  assert.equal(await status(request(undefined, { raw: JSON.stringify({ instanceId: INSTANCE, path: dir, pad: 'x'.repeat(9 * 1024) }) })), 413)
})

test('the Client observation accepts only the exact positive response', async () => {
  const observed = await observeHostWorkspaceObject(
    fetchOf(() => Response.json(
      { schema: 1, instanceId: INSTANCE, device: '123', inode: '456' },
      { headers: { 'cache-control': 'no-store' } },
    )),
    ORIGIN,
    INSTANCE,
    '/tmp/workspace',
  )
  assert.deepEqual(observed, { kind: 'observed', device: '123', inode: '456' })

  const cases: readonly [string, Response][] = [
    ['a non-200 status', new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } })],
    ['a non-JSON content type', Response.json(
      { schema: 1, instanceId: INSTANCE, device: '1', inode: '2' },
      { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } },
    )],
    ['a missing no-store', Response.json({ schema: 1, instanceId: INSTANCE, device: '1', inode: '2' })],
    ['an extra response key', Response.json(
      { schema: 1, instanceId: INSTANCE, device: '1', inode: '2', path: '/leak' },
      { headers: { 'cache-control': 'no-store' } },
    )],
    ['another instance', Response.json(
      { schema: 1, instanceId: '22222222-2222-4222-8222-222222222222', device: '1', inode: '2' },
      { headers: { 'cache-control': 'no-store' } },
    )],
    ['a number instead of a decimal string', Response.json(
      { schema: 1, instanceId: INSTANCE, device: 1, inode: '2' },
      { headers: { 'cache-control': 'no-store' } },
    )],
    ['an oversized response', Response.json(
      { schema: 1, instanceId: INSTANCE, device: '1', inode: '2', pad: 'x'.repeat(2 * 1024) },
      { headers: { 'cache-control': 'no-store' } },
    )],
  ]
  for (const [label, response] of cases) {
    const verdict = await observeHostWorkspaceObject(fetchOf(() => response), ORIGIN, INSTANCE, '/tmp/workspace')
    assert.equal(verdict.kind, 'unverified', label)
  }
  const unreachable = await observeHostWorkspaceObject(async () => { throw new Error('connection lost') }, ORIGIN, INSTANCE, '/tmp/workspace')
  assert.equal(unreachable.kind, 'unverified')
})
