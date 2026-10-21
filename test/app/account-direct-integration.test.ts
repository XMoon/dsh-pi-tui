/**
 * Phase 3C / C2-MA — the REAL DeepSeek Account browser-callback contract.
 *
 * PRODUCTION PREREQUISITES REPRODUCED:
 *   - the official `@deepseek-ai/dsh-deepseek-account-platform` service, with
 *     the official `@deepseek-ai/dsh-authorization` registry and the official
 *     file-backed `@deepseek-ai/dsh-credentials-local` store;
 *   - the official `@deepseek-ai/dsh-host-webserver`, listening on a real
 *     loopback socket with an OS-assigned port;
 *   - the TUI's `DirectAccountConfig` adapter over the live `ctx` services;
 *   - the platform's own `/oauth/callback` route, state + PKCE validation and
 *     credential-record commit.
 *
 * TEST STAND-INS: one isolated Platform HTTP endpoint (auth_init,
 * auth_exchange, profile, balance, logout) and a plain HTTP request standing
 * in for the browser. No real user token or browser is involved.
 *
 * DELIBERATELY ABSENT: the React/Web UI, TSP and a physical browser.
 *
 * @module @xmoon76/dsh-pi-tui/account-direct-integration.test
 */

import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import PlatformAccount from '@deepseek-ai/dsh-deepseek-account-platform'
import { DirectAccountConfig, DirectAuthorizationConfig } from '../../src/runtime/direct/config-direct.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { ACCOUNT_AUTHORIZATION_KEY, genericAuthorizationTargets, resolveLoginDestination } from '../../src/app/command/credential-workflow.ts'

function reply(response: ServerResponse, bizData: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: bizData } }))
}

interface PlatformFixture {
  readonly server: Server
  readonly origin: string
  readonly state: { readonly value: string | undefined }
  readonly requests: string[]
}

async function startPlatform(): Promise<PlatformFixture> {
  const state: { value: string | undefined } = { value: undefined }
  const requests: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      requests.push(`${request.method ?? 'GET'} ${url.pathname}`)
      const port = (server.address() as AddressInfo).port
      const origin = `http://127.0.0.1:${port}`
      if (request.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_init') {
        const input = JSON.parse(body) as { state: string }
        state.value = input.state
        reply(response, {
          authorize_url: `${origin}/dsh/authorize?state=${encodeURIComponent(input.state)}`,
          authorize_id: 'auth-1',
          expires_in: 600,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_exchange') {
        reply(response, {
          token: 'grant-token-1',
          authorized_url: `${origin}/dsh/authorized`,
          user: {
            id: 'user-1',
            email: 'moon@example.com',
            id_profile: { name: 'Moon', picture: null },
          },
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_cancel') {
        reply(response, {})
        return
      }
      if (request.method === 'GET' && url.pathname === '/auth-api/v0/users/current') {
        reply(response, {
          id: 'user-1',
          email: 'moon@example.com',
          id_profile: { name: 'Moon', picture: null },
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/v0/users/get_user_summary') {
        reply(response, {
          normal_wallets: [{ currency: 'CNY', balance: '12.50' }],
          bonus_wallets: [{ currency: 'CNY', balance: '3.0000000000000000' }],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth-api/v0/users/logout') {
        reply(response, {})
        return
      }
      response.writeHead(404).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, origin, state, requests }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the Host state')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

test('REAL PlatformAccount + official WebServer callback: state, PKCE, grant, profile, balance and sign-out', async t => {
  const life = testLifecycle(t)
  const platform = await startPlatform()
  life.defer(() => new Promise<void>(resolve => platform.server.close(() => resolve())))
  const home = life.tempDir('dsh-pi-tui-c2-account-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(PlatformAccount, {
      platformOrigin: platform.origin,
      allowLoopbackHttp: true,
      inferenceOrigin: platform.origin,
      requestTimeoutMs: 2000,
      attemptTimeoutMs: 5000,
      logoutMaxRetries: 0,
    })

    const webServer = ctx.get('webServer') as WebServer
    const callbackOrigin = webServer.getOrigin()
    assert.match(callbackOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u)
    // The listener is REAL: the callback path exists (404 before an attempt).
    const before = await fetch(`${callbackOrigin}/oauth/callback?code=x&state=y`)
    assert.equal(before.status, 404)

    const adapter = new DirectAccountConfig({ get: name => ctx.get(name) })
    assert.equal(adapter.available(), true)
    const authorization = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    const targets = authorization.listTargets()
    assert.ok(targets.some(target => target.key === ACCOUNT_AUTHORIZATION_KEY), 'the real Host list contains the account flow')
    assert.deepEqual(resolveLoginDestination('deepseek-account', [], targets), { kind: 'account', view: 'page' })
    assert.equal(genericAuthorizationTargets(targets).length, 0, 'the account flow is never offered as a provider-native sign-in')
    assert.equal(adapter.getCallbackOrigin(), callbackOrigin)
    const metadata = { version: '0.5.3', locale: 'en-US', timezoneOffsetSeconds: 0 }
    const initial = await adapter.getState()
    assert.equal(initial.status, 'signed-out')

    const started = await adapter.startSignIn(metadata)
    assert.notEqual(started.attempt, null)
    const waiting = await waitFor(async () => {
      const view = await adapter.getState()
      return view.attempt?.phase === 'waiting-browser' ? view : undefined
    })
    const attempt = waiting.attempt
    assert.ok(attempt !== null && attempt !== undefined)
    assert.match(attempt.authorizeUrl ?? '', /\/dsh\/authorize/u)
    assert.equal(platform.state.value !== undefined, true)

    // The Host validates state and PKCE: a wrong state never reaches auth_exchange.
    const wrong = await fetch(`${callbackOrigin}/oauth/callback?code=code-1&state=wrong`)
    assert.equal(wrong.status, 400)
    assert.equal(platform.requests.includes('POST /auth-api/v0/dsh/auth_exchange'), false)

    // The browser lands on the Host's own route with the generated state.
    const callback = await fetch(`${callbackOrigin}/oauth/callback?code=code-1&state=${encodeURIComponent(platform.state.value!)}`, { redirect: 'manual' })
    assert.equal(callback.status, 302)
    const stored = await waitFor(async () => {
      const view = await adapter.getState()
      return view.status === 'credential-stored' ? view : undefined
    })
    assert.equal(stored.attempt?.phase, 'succeeded')
    assert.equal(platform.requests.includes('POST /auth-api/v0/dsh/auth_exchange'), true)

    const credentials = ctx.get('credentials') as { listRecords(): Promise<readonly { key: string; kind?: string }[]> }
    const records = await credentials.listRecords()
    assert.ok(records.some(record => record.key === 'deepseek-account-platform/default' && record.kind === 'grant'))

    const profile = await adapter.getProfile(metadata)
    assert.deepEqual(profile, {
      status: 'ready',
      value: { id: 'user-1', name: 'Moon', contact: 'moon@example.com', avatarUrl: null },
    })
    const balance = await adapter.getBalance(metadata)
    assert.deepEqual(balance, {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '12.50' }],
      bonusWallets: [{ currency: 'CNY', balance: '3.0000000000000000' }],
    })

    const credentialsForRef = ctx.get('credentials') as {
      set(ref: string, value: string): Promise<unknown>
      describe(ref: string): Promise<{ configured: boolean; source?: string }>
    }
    await credentialsForRef.set('DEEPSEEK_API_KEY', 'sk-keep')
    const signedOut = await adapter.signOut(metadata)
    assert.equal(signedOut.status, 'signed-out')
    const remaining = await credentials.listRecords()
    assert.equal(remaining.some(record => record.key === 'deepseek-account-platform/default'), false)
    // The remote revocation is a background Host request that must never
    // restore the already-removed local grant.
    await waitFor(async () => platform.requests.includes('POST /auth-api/v0/users/logout') ? true : undefined)
    assert.equal((await adapter.getState()).status, 'signed-out')
    const keptKey = await credentialsForRef.describe('DEEPSEEK_API_KEY')
    assert.equal(keptKey.configured, true, 'an independent API key survives the account sign-out')

    // Cancellation is bound to the exact attempt id: a stale id cancels nothing.
    const second = await adapter.startSignIn(metadata)
    const secondWaiting = await waitFor(async () => {
      const view = await adapter.getState()
      return view.attempt?.phase === 'waiting-browser' ? view : undefined
    })
    const attemptId = secondWaiting.attempt!.id
    const stale = await adapter.cancelSignIn('not-the-current-attempt')
    assert.equal(stale.attempt?.id, attemptId)
    assert.equal(stale.attempt?.phase, 'waiting-browser')
    const cancelled = await adapter.cancelSignIn(attemptId)
    assert.equal(cancelled.attempt?.phase, 'cancelled')
    assert.notEqual(second.attempt?.id, undefined)

    // The webserver listener remains alive after sign-out and page closure.
    const after = await fetch(`${callbackOrigin}/oauth/callback?code=x&state=y`)
    assert.equal(after.status, 404)
  }
})

test('the bundle patch mounts the official WebServer with a loopback OS-assigned port under tuiStartup', async () => {
  const patch = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- id: webserver\n\s+name: '@deepseek-ai\/dsh-host-webserver'\n\s+inject: \[tuiStartup\]\n\s+config:\n\s+host: 127\.0\.0\.1\n\s+port: 0/u)
  assert.match(patch, /inject: \[[^\]]*deepseekAccount[^\]]*webServer[^\]]*\]/u)
})
