/**
 * The ONE private Owner-only HTTP adapter of the headless Web CLI.
 *
 * Evidence level: structural. These exercise the real handler module and the
 * shared strict wire parser; the real Connection Owner admission and the real
 * Host process are proven by the selectable packed split-process case, never
 * inferred from these tests.
 *
 * @module @xmoon76/dsh-pi-tui/local-web-control-route.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLocalWebControlHandler,
  LOCAL_WEB_CONTROL_MAX_REQUEST_BYTES,
  LOCAL_WEB_CONTROL_ROUTE,
  parseLocalWebControlReply,
  type LocalWebControlService,
} from '../../src/app/remote-process/local-web-control-route.ts'
import type {
  PiTuiWebAccessAuthenticatedUrl,
  PiTuiWebAccessStatus,
} from '../../src/runtime/remote/pi-tui-web-access-contract.ts'

const INSTANCE = '11111111-1111-4111-8111-111111111111'
const ORIGIN = 'http://127.0.0.1:4517'

interface ServiceCalls {
  status: number
  enabled: (boolean | string)[]
  urls: number
}

function serviceOf(options: {
  status?: PiTuiWebAccessStatus
  setEnabled?: (enabled: boolean) => Promise<PiTuiWebAccessStatus>
  getAuthenticatedUrl?: () => Promise<PiTuiWebAccessAuthenticatedUrl>
} = {}): { service: LocalWebControlService; calls: ServiceCalls } {
  const calls: ServiceCalls = { status: 0, enabled: [], urls: 0 }
  const service: LocalWebControlService = {
    async getStatus() {
      calls.status += 1
      return options.status ?? { state: 'disabled' }
    },
    async setEnabled(enabled: boolean) {
      calls.enabled.push(enabled)
      return await (options.setEnabled?.(enabled) ?? Promise.resolve({ state: enabled ? 'enabled' : 'disabled' } as PiTuiWebAccessStatus))
    },
    async getAuthenticatedUrl() {
      calls.urls += 1
      return await (options.getAuthenticatedUrl?.() ?? Promise.resolve({ url: `${ORIGIN}/?token=secret-token` }))
    },
  }
  return { service, calls }
}

function handlerOf(service: LocalWebControlService): (request: Request) => Promise<Response> {
  return createLocalWebControlHandler(INSTANCE, service)
}

function requestOf(options: {
  method?: string
  body?: string
  contentType?: string | null
} = {}): Request {
  const headers = new Headers()
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json')
  return new Request(`${ORIGIN}${LOCAL_WEB_CONTROL_ROUTE}`, {
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

test('GET returns the exact status DTO and no reason', async () => {
  const { service, calls } = serviceOf({ status: { state: 'unavailable', reason: 'private /path and http://secret' } })
  const response = await handlerOf(service)(requestOf({ method: 'GET', body: undefined, contentType: null }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'unavailable' })
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(calls.status, 1)
  assert.deepEqual(calls.enabled, [])
  assert.equal(calls.urls, 0)
})

test('GET reports a read failure as a fixed code, never a guessed disabled', async () => {
  const { service } = serviceOf()
  service.getStatus = async () => { throw new Error('raw error at /home/secret') }
  const response = await handlerOf(service)(requestOf({ method: 'GET', body: undefined, contentType: null }))
  assert.equal(response.status, 503)
  assert.deepEqual(await json(response), { schema: 1, error: 'WEB_CLI_UNAVAILABLE' })
})

test('POST enable calls setEnabled(true) exactly once and returns the reached state', async () => {
  const { service, calls } = serviceOf({ setEnabled: async () => ({ state: 'enabled' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody() }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'enabled' })
  assert.deepEqual(calls.enabled, [true])
  assert.equal(calls.urls, 0)
})

test('POST disable calls setEnabled(false) exactly once', async () => {
  const { service, calls } = serviceOf({ setEnabled: async () => ({ state: 'disabled' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody({ op: 'disable' }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'disabled' })
  assert.deepEqual(calls.enabled, [false])
})

test('the response state is the service result, never the requested boolean', async () => {
  const { service } = serviceOf({ setEnabled: async () => ({ state: 'disabled' }) })
  const response = await handlerOf(service)(requestOf({ body: postBody({ op: 'enable' }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, state: 'disabled' })
})

test('POST enable maps a service throw to a fixed code with no message', async () => {
  const { service } = serviceOf({ setEnabled: async () => { throw new Error('raw /home/secret') } })
  const response = await handlerOf(service)(requestOf({ body: postBody() }))
  assert.equal(response.status, 503)
  const text = await response.text()
  assert.deepEqual(JSON.parse(text), { schema: 1, error: 'WEB_CLI_UNAVAILABLE' })
  assert.doesNotMatch(text, /secret|\/home/u)
})

test('a wrong instance is refused before any business side effect', async () => {
  const { service, calls } = serviceOf()
  const response = await handlerOf(service)(requestOf({ body: postBody({ instanceId: '22222222-2222-4222-8222-222222222222' }) }))
  assert.equal(response.status, 409)
  assert.deepEqual(await json(response), { schema: 1, error: 'WEB_INSTANCE_MISMATCH' })
  assert.deepEqual(calls.enabled, [])
})

test('a non-JSON content type is refused with 415 and zero side effects', async () => {
  const { service, calls } = serviceOf()
  const response = await handlerOf(service)(requestOf({ contentType: 'text/plain', body: postBody() }))
  assert.equal(response.status, 415)
  assert.deepEqual(await json(response), { schema: 1, error: 'WEB_INVALID_REQUEST' })
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
  ]) {
    const response = await handler(requestOf({ body }))
    assert.equal(response.status, 400, `body ${body} must be a 400`)
    assert.deepEqual(await json(response), { schema: 1, error: 'WEB_INVALID_REQUEST' })
  }
  assert.deepEqual(calls.enabled, [])
})

test('an oversized body is refused before any business side effect', async () => {
  const { service, calls } = serviceOf()
  const oversized = JSON.stringify({ schema: 1, instanceId: INSTANCE, op: 'enable', padding: 'x'.repeat(LOCAL_WEB_CONTROL_MAX_REQUEST_BYTES) })
  const response = await handlerOf(service)(requestOf({ body: oversized }))
  assert.equal(response.status, 400)
  assert.deepEqual(await json(response), { schema: 1, error: 'WEB_INVALID_REQUEST' })
  assert.deepEqual(calls.enabled, [])
})

test('POST url reads the live state and calls the existing URL authority once', async () => {
  const { service, calls } = serviceOf({ status: { state: 'enabled' }, getAuthenticatedUrl: async () => ({ url: `${ORIGIN}/?token=abc` }) })
  const response = await handlerOf(service)(requestOf({ body: postBody({ op: 'url' }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await json(response), { schema: 1, instanceId: INSTANCE, url: `${ORIGIN}/?token=abc` })
  assert.equal(calls.status, 1)
  assert.equal(calls.urls, 1)
  assert.deepEqual(calls.enabled, [])
})

for (const [state, expected] of [
  ['disabled', { status: 200, body: { schema: 1, error: 'WEB_DISABLED' } }],
  ['changing', { status: 200, body: { schema: 1, error: 'WEB_CHANGING' } }],
  ['unavailable', { status: 503, body: { schema: 1, error: 'WEB_CLI_UNAVAILABLE' } }],
] as const) {
  test(`POST url with a ${state} Host returns the fixed code without touching the URL method`, async () => {
    const status: PiTuiWebAccessStatus = state === 'unavailable' ? { state, reason: 'not composed' } : { state }
    const { service, calls } = serviceOf({ status })
    const response = await handlerOf(service)(requestOf({ body: postBody({ op: 'url' }) }))
    assert.equal(response.status, expected.status)
    assert.deepEqual(await json(response), expected.body)
    assert.equal(calls.urls, 0)
    assert.deepEqual(calls.enabled, [])
  })
}

test('POST url maps a URL-method throw to WEB_CLI_UNAVAILABLE with no message', async () => {
  const { service } = serviceOf({
    status: { state: 'enabled' },
    getAuthenticatedUrl: async () => { throw new Error('raw /home/secret http://secret/?token=x') },
  })
  const response = await handlerOf(service)(requestOf({ body: postBody({ op: 'url' }) }))
  assert.equal(response.status, 503)
  const text = await response.text()
  assert.deepEqual(JSON.parse(text), { schema: 1, error: 'WEB_CLI_UNAVAILABLE' })
  assert.doesNotMatch(text, /secret|token/u)
})

test('every error response carries the fixed no-store/referrer/nosniff headers', async () => {
  const { service } = serviceOf()
  const response = await handlerOf(service)(requestOf({ contentType: 'text/plain', body: postBody() }))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-type'), 'application/json')
})

test('parseLocalWebControlReply accepts all exact success and error shapes', () => {
  assert.deepEqual(parseLocalWebControlReply(JSON.stringify({ schema: 1, instanceId: INSTANCE, state: 'changing' })),
    { kind: 'state', instanceId: INSTANCE, state: 'changing' })
  assert.deepEqual(parseLocalWebControlReply(JSON.stringify({ schema: 1, instanceId: INSTANCE, url: `${ORIGIN}/?token=x` })),
    { kind: 'url', instanceId: INSTANCE, url: `${ORIGIN}/?token=x` })
  assert.deepEqual(parseLocalWebControlReply(JSON.stringify({ schema: 1, error: 'WEB_DISABLED' })),
    { kind: 'error', error: 'WEB_DISABLED' })
})

test('parseLocalWebControlReply rejects stray fields, unknown states/errors and wrong schema', () => {
  for (const value of [
    { schema: 1, instanceId: INSTANCE, state: 'enabled', reason: 'x' },
    { schema: 1, instanceId: INSTANCE, state: 'unknown' },
    { schema: 1, error: 'NOT_A_CODE' },
    { schema: 2, instanceId: INSTANCE, state: 'enabled' },
    { schema: 1, instanceId: '', state: 'enabled' },
    { schema: 1, instanceId: INSTANCE, url: '' },
  ]) {
    assert.throws(() => parseLocalWebControlReply(JSON.stringify(value)), TypeError)
  }
  assert.throws(() => parseLocalWebControlReply('not json'), TypeError)
})
