/**
 * The ONE private Owner-only HTTP adapter of the headless ACP CLI.
 *
 * Evidence level: structural. These exercise the real handler module and the
 * shared strict wire parser; the real Connection Owner admission and the real
 * Host process are proven by the selectable packed split-process case, never
 * inferred from these tests.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-control-route.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLocalAcpControlHandler,
  LOCAL_ACP_CONTROL_MAX_REQUEST_BYTES,
  LOCAL_ACP_CONTROL_MAX_RESPONSE_BYTES,
  LOCAL_ACP_CONTROL_ROUTE,
  LOCAL_ACP_CONTROL_TIMEOUT_MS,
  parseLocalAcpControlReply,
  type LocalAcpControlService,
} from '../../src/app/remote-process/local-acp-control-route.ts'
import type { AcpAccessStatus } from '../../src/runtime/acp-access-port.ts'

const INSTANCE = '11111111-1111-4111-8111-111111111111'
const ORIGIN = 'http://127.0.0.1:4517'

interface ServiceCalls {
  status: number
  enabled: (boolean | string)[]
}

function serviceOf(options: {
  status?: AcpAccessStatus
  setEnabled?: (enabled: boolean) => Promise<AcpAccessStatus>
} = {}): { service: LocalAcpControlService; calls: ServiceCalls } {
  const calls: ServiceCalls = { status: 0, enabled: [] }
  const service: LocalAcpControlService = {
    async getStatus() {
      calls.status += 1
      return options.status ?? { state: 'disabled' }
    },
    async setEnabled(enabled: boolean) {
      calls.enabled.push(enabled)
      return await (options.setEnabled?.(enabled) ?? Promise.resolve({ state: enabled ? 'enabled' : 'disabled' }))
    },
  }
  return { service, calls }
}

function handlerOf(service: LocalAcpControlService): (request: Request) => Promise<Response> {
  return createLocalAcpControlHandler(INSTANCE, service)
}

function requestOf(options: {
  method?: string
  body?: string
  contentType?: string | null
} = {}): Request {
  const headers = new Headers()
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json')
  return new Request(`${ORIGIN}${LOCAL_ACP_CONTROL_ROUTE}`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  })
}

function postBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, instanceId: INSTANCE, op: 'enable', ...overrides })
}

async function json(response: Response): Promise<unknown> {
  return await response.json() as unknown
}

test('the route contract constants are the frozen wire facts', () => {
  assert.equal(LOCAL_ACP_CONTROL_ROUTE, '/api/pi-tui.acp-control')
  assert.equal(LOCAL_ACP_CONTROL_MAX_REQUEST_BYTES, 512)
  assert.equal(LOCAL_ACP_CONTROL_MAX_RESPONSE_BYTES, 4096)
  assert.equal(LOCAL_ACP_CONTROL_TIMEOUT_MS, 10_000)
})

test('POST enable calls setEnabled(true) exactly once and returns the reached state', async () => {
  const { service, calls } = serviceOf({ setEnabled: async () => ({ state: 'enabled' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody() }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'enabled' })
  assert.deepEqual(calls.enabled, [true])
  assert.equal(calls.status, 0, 'a write must never read the status first')
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
})

test('POST disable calls setEnabled(false) exactly once', async () => {
  const { service, calls } = serviceOf({ setEnabled: async () => ({ state: 'disabled' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody({ op: 'disable' }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'disabled' })
  assert.deepEqual(calls.enabled, [false])
})

test('the response state is the controller result, never the requested boolean', async () => {
  const { service } = serviceOf({ setEnabled: async () => ({ state: 'disabled' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody({ op: 'enable' }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'disabled' })
})

test('a settled unavailable controller result drops its reason and keeps the state', async () => {
  const { service } = serviceOf({ setEnabled: async () => ({ state: 'unavailable', reason: 'private /path and http://secret' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody() }))
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.deepEqual(JSON.parse(text), { schema: 1, instanceId: INSTANCE, state: 'unavailable' })
  assert.doesNotMatch(text, /secret|\/path|reason/u)
})

test('a changing controller result is a legal reply', async () => {
  const { service } = serviceOf({ setEnabled: async () => ({ state: 'changing' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody() }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'changing' })
})

test('POST maps a controller throw to a fixed code with no message', async () => {
  const { service, calls } = serviceOf({ setEnabled: async () => { throw new Error('raw /home/secret socket /run/acp.sock') } })
  const response = await handlerOf(service)(requestOf({ body: postBody() }))
  assert.equal(response.status, 503)
  const text = await response.text()
  assert.deepEqual(JSON.parse(text), { schema: 1, error: 'ACP_CLI_UNAVAILABLE' })
  assert.doesNotMatch(text, /secret|\/home|\/run|socket/u)
  assert.deepEqual(calls.enabled, [true])
})

test('a wrong instance is refused before any business side effect', async () => {
  const { service, calls } = serviceOf()
  const response = await handlerOf(service)(requestOf({ body: postBody({ instanceId: '22222222-2222-4222-8222-222222222222' }) }))
  assert.equal(response.status, 409)
  assert.deepEqual(await json(response), { schema: 1, error: 'ACP_INSTANCE_MISMATCH' })
  assert.deepEqual(calls.enabled, [])
})

test('every non-POST method is refused with 405 and zero side effects', async () => {
  const { service, calls } = serviceOf()
  const handler = handlerOf(service)
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const response = await handler(requestOf({ method, body: undefined, contentType: null }))
    assert.equal(response.status, 405, `${method} must be a 405`)
    assert.deepEqual(await json(response), { schema: 1, error: 'ACP_INVALID_REQUEST' })
  }
  assert.deepEqual(calls.enabled, [])
  assert.equal(calls.status, 0)
})

test('a non-JSON content type is refused with 415 and zero side effects', async () => {
  const { service, calls } = serviceOf()
  const response = await handlerOf(service)(requestOf({ contentType: 'text/plain', body: postBody() }))
  assert.equal(response.status, 415)
  assert.deepEqual(await json(response), { schema: 1, error: 'ACP_INVALID_REQUEST' })
  assert.deepEqual(calls.enabled, [])
})

test('malformed JSON, unknown fields and unknown ops are refused with 400', async () => {
  const { service, calls } = serviceOf()
  const handler = handlerOf(service)
  for (const body of [
    '{not json',
    postBody({ extra: true }),
    JSON.stringify({ schema: 2, instanceId: INSTANCE, op: 'enable' }),
    JSON.stringify({ schema: 1, instanceId: INSTANCE, op: 'destroy' }),
    JSON.stringify({ schema: 1, instanceId: INSTANCE }),
    JSON.stringify({ schema: 1, instanceId: '', op: 'enable' }),
  ]) {
    const response = await handler(requestOf({ body }))
    assert.equal(response.status, 400, `body ${body} must be a 400`)
    assert.deepEqual(await json(response), { schema: 1, error: 'ACP_INVALID_REQUEST' })
  }
  assert.deepEqual(calls.enabled, [])
})

test('an oversized body is refused before any business side effect', async () => {
  const { service, calls } = serviceOf()
  const oversized = JSON.stringify({ schema: 1, instanceId: INSTANCE, op: 'enable', padding: 'x'.repeat(LOCAL_ACP_CONTROL_MAX_REQUEST_BYTES) })
  const response = await handlerOf(service)(requestOf({ body: oversized }))
  assert.equal(response.status, 400)
  assert.deepEqual(await json(response), { schema: 1, error: 'ACP_INVALID_REQUEST' })
  assert.deepEqual(calls.enabled, [])
})

test('every error response carries the fixed no-store/referrer/nosniff headers', async () => {
  const { service } = serviceOf()
  const response = await handlerOf(service)(requestOf({ contentType: 'text/plain', body: postBody() }))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-type'), 'application/json')
})

test('parseLocalAcpControlReply accepts all exact success and error shapes', () => {
  for (const state of ['enabled', 'disabled', 'changing', 'unavailable'] as const) {
    assert.deepEqual(parseLocalAcpControlReply(JSON.stringify({ schema: 1, instanceId: INSTANCE, state })),
      { kind: 'state', instanceId: INSTANCE, state })
  }
  assert.deepEqual(parseLocalAcpControlReply(JSON.stringify({ schema: 1, error: 'ACP_INSTANCE_MISMATCH' })),
    { kind: 'error', error: 'ACP_INSTANCE_MISMATCH' })
})

test('parseLocalAcpControlReply rejects stray fields, unknown states/errors and wrong schema', () => {
  for (const value of [
    { schema: 1, instanceId: INSTANCE, state: 'enabled', reason: 'x' },
    { schema: 1, instanceId: INSTANCE, state: 'unknown' },
    { schema: 1, error: 'NOT_A_CODE' },
    { schema: 2, instanceId: INSTANCE, state: 'enabled' },
    { schema: 1, instanceId: '', state: 'enabled' },
    { schema: 1, instanceId: INSTANCE, url: 'x' },
  ]) {
    assert.throws(() => parseLocalAcpControlReply(JSON.stringify(value)), TypeError)
  }
  assert.throws(() => parseLocalAcpControlReply('not json'), TypeError)
  assert.throws(() => parseLocalAcpControlReply('[]'), TypeError)
})
