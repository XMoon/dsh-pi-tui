/**
 * The headless ACP CLI runner: the real authenticated-request boundary against
 * a real local HTTP listener, the fixed stdout/stderr/exit contract, the
 * currentness fences and the no-replay write rule.
 *
 * Evidence level: structural + real loopback HTTP. It proves the runner's
 * source -> decision -> sink contract against the real strict status observer
 * and the real strict control-reply parser; the real backed Host/Connection/
 * admission lane is the selectable packed split-process case.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-control.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  inspectInstalledProfileScope,
  LOCAL_PROTOCOL,
  LocalScopeError,
  type LocalScope,
} from '../../src/app/remote-process/local-scope.ts'
import type { DaemonControlProfile } from '../../src/app/remote-process/local-daemon-control.ts'
import {
  runLocalAcpControl,
  type LocalAcpControlDeps,
} from '../../src/app/remote-process/local-acp-control.ts'
import type { LinuxLocalInstanceRecord, VerifiedLocalHost } from '../../src/app/remote-process/local-discovery.ts'
import {
  LOCAL_ACP_CONTROL_ROUTE,
} from '../../src/app/remote-process/local-acp-control-route.ts'
import { LOCAL_ACP_STATUS_ROUTE } from '../../src/app/remote-process/local-acp-status.ts'

const UUID = '11111111-1111-4111-8111-111111111111'
const OTHER_UUID = '22222222-2222-4222-8222-222222222222'
const DSH_VERSION = '0.2.2-rc.5'

interface Fixture {
  readonly profile: DaemonControlProfile
  readonly scope: LocalScope
}

function fixture(t: TestContext): Fixture {
  const root = testLifecycle(t).tempDir('acp-cli-')
  const home = join(root, 'dsh-home')
  const profileDir = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  const anchor = join(root, 'dsh', 'package.json')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'dsh'), { recursive: true, mode: 0o700 })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.8' })}\n`)
  writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export {}\n')
  writeFileSync(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION })}\n`)
  const profile: DaemonControlProfile = {
    name: 'pi-tui',
    dir: profileDir,
    home,
    installAnchor: anchor,
    packageRoot,
    dshVersion: DSH_VERSION,
  }
  const scope = inspectInstalledProfileScope({ dshHome: home, profileDir, packageRoot, dshVersion: DSH_VERSION })
  return { profile, scope }
}

function recordOf(scope: LocalScope, origin: string, overrides: Partial<LinuxLocalInstanceRecord> = {}): LinuxLocalInstanceRecord {
  return {
    schema: 1,
    scopeId: scope.scopeId,
    profileRealpath: scope.profileRealpath,
    instanceId: UUID,
    hostPid: 4242,
    hostStarttime: '12345',
    origin,
    protocol: LOCAL_PROTOCOL,
    bundleVersion: scope.bundleVersion,
    dshVersion: scope.dshVersion,
    buildId: scope.buildId,
    ...overrides,
  }
}

interface HttpCall {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

interface HttpReply {
  readonly status: number
  readonly body: string
  readonly contentType?: string
  readonly cacheControl?: string
  /** Destroy the socket without a response. */
  readonly drop?: boolean
  /** Accept the request and never answer (the client abort/timeout case). */
  readonly hang?: boolean
}

interface LocalServer {
  readonly origin: string
  readonly calls: HttpCall[]
  setReply(reply: HttpReply | ((call: HttpCall) => HttpReply)): void
}

function startServer(t: TestContext, initial: HttpReply | ((call: HttpCall) => HttpReply)): Promise<LocalServer> {
  let reply: HttpReply | ((call: HttpCall) => HttpReply) = initial
  const calls: HttpCall[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const call: HttpCall = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body }
      calls.push(call)
      const resolved = typeof reply === 'function' ? reply(call) : reply
      if (resolved.hang === true) return
      if (resolved.drop === true) {
        request.socket.destroy()
        return
      }
      response.writeHead(resolved.status, {
        'content-type': resolved.contentType ?? 'application/json',
        'cache-control': resolved.cacheControl ?? 'no-store',
      })
      response.end(resolved.body)
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  t.after(() => new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy()
    server.close(error => { if (error !== undefined) reject(error); else resolve() })
  }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the test server did not bind a TCP address'))
        return
      }
      resolve({
        origin: `http://127.0.0.1:${String(address.port)}`,
        calls,
        setReply(next) { reply = next },
      })
    })
  })
}

/** The exact existing status-route DTO the strict observer consumes. */
function statusReply(instanceId: string, state: string): HttpReply {
  const status = state === 'unavailable' ? { state, reason: 'private /path' } : { state }
  return { status: 200, body: JSON.stringify({ schema: 1, instanceId, status }) }
}

/** One legal control-route success reply. */
function controlReply(instanceId: string, state: string): HttpReply {
  return { status: 200, body: JSON.stringify({ schema: 1, instanceId, state }) }
}

interface RunOptions {
  readonly current?: () => LinuxLocalInstanceRecord | undefined
  readonly authenticate?: LocalAcpControlDeps['authenticate']
  readonly deps?: Partial<LocalAcpControlDeps>
}

async function run(
  fx: Fixture,
  record: LinuxLocalInstanceRecord,
  verb: 'status' | 'enable' | 'disable',
  options: RunOptions = {},
) {
  const verified: VerifiedLocalHost = { record, cookie: 'signed-cookie', identity: record }
  return await runLocalAcpControl({ verb }, fx.profile, {
    platform: 'linux',
    readRecord: options.current ?? (() => record),
    inspectProcess: () => 'alive',
    authenticate: options.authenticate ?? (async () => verified),
    assertKernelIdentity: () => {},
    ...options.deps,
  })
}

function assertSingleLine(text: string): void {
  assert.match(text, /^[^\n]*\n$/u, `expected exactly one line, got ${JSON.stringify(text)}`)
}

// ── status (pure read through the existing strict observer) ────────────────

test('status prints exactly one legal state and keeps the authenticated Cookie in memory', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, statusReply(UUID, 'disabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.deepEqual(result, { code: 0, stdout: 'acp=disabled\n', stderr: '' })
  assert.equal(server.calls.length, 1)
  assert.equal(server.calls[0].method, 'GET')
  assert.equal(server.calls[0].path, LOCAL_ACP_STATUS_ROUTE)
  assert.equal(server.calls[0].headers.cookie, 'signed-cookie')
})

for (const state of ['enabled', 'changing', 'unavailable'] as const) {
  test(`status reports the legal ${state} state with exit 0`, async (t) => {
    const fx = fixture(t)
    const server = await startServer(t, statusReply(UUID, state))
    const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
    assert.deepEqual(result, { code: 0, stdout: `acp=${state}\n`, stderr: '' })
  })
}

test('status 404 maps to ACP_CLI_UNAVAILABLE (an old Host build)', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 404, body: 'not found', contentType: 'text/plain' })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui acp: ACP_CLI_UNAVAILABLE: /u)
})

test('status never turns a malformed or foreign response into a state', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, statusReply(OTHER_UUID, 'disabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /ACP_CLI_UNAVAILABLE/u)
})

test('status fails closed when the response is not no-store JSON', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { ...statusReply(UUID, 'disabled'), cacheControl: 'public' })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
})

test('status fails closed on a malformed status DTO', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, status: { state: 'running' } }) })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
})

test('a live Host whose status read produces no response is ACP_CLI_UNAVAILABLE, never HOST_NOT_RUNNING', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 0, body: '', drop: true })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui acp: ACP_CLI_UNAVAILABLE: /u)
  assert.doesNotMatch(result.stderr, /HOST_NOT_RUNNING/u)
})

test('a status read cancelled by the caller is a bounded unprovable read', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 0, body: '', hang: true })
  const controller = new AbortController()
  const pending = run(fx, recordOf(fx.scope, server.origin), 'status', { deps: { signal: controller.signal } })
  setTimeout(() => { controller.abort() }, 30)
  const result = await pending
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.equal(server.calls.length, 1)
})

test('a status read with a replaced registry identity is HOST_IDENTITY_REFUSED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, statusReply(UUID, 'disabled'))
  const record = recordOf(fx.scope, server.origin)
  const replacement = recordOf(fx.scope, server.origin, { instanceId: OTHER_UUID })
  let reads = 0
  const result = await run(fx, record, 'status', {
    current: () => {
      reads += 1
      return reads === 1 ? record : replacement
    },
  })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui acp: HOST_IDENTITY_REFUSED: /u)
})

test('a status read with a failing fresh kernel identity is HOST_IDENTITY_REFUSED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, statusReply(UUID, 'disabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status', {
    deps: {
      assertKernelIdentity: () => { throw new LocalScopeError('PROCESS_STARTTIME_UNAVAILABLE', 'the starttime read failed') },
    },
  })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /HOST_IDENTITY_REFUSED/u)
})

// ── Host discovery / authentication fail-closed ───────────────────────────

test('a missing Host is HOST_NOT_RUNNING with the daemon start hint and zero requests', async (t) => {
  const fx = fixture(t)
  let authenticated = 0
  const result = await runLocalAcpControl({ verb: 'status' }, fx.profile, {
    platform: 'linux',
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    authenticate: async () => { authenticated += 1; throw new Error('must not authenticate') },
  })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui acp: HOST_NOT_RUNNING: /u)
  assert.match(result.stderr, /dsh --profile pi-tui daemon start/u)
  assert.equal(authenticated, 0)
})

test('a dead Host process is HOST_NOT_RUNNING', async (t) => {
  const fx = fixture(t)
  const record = recordOf(fx.scope, 'http://127.0.0.1:1')
  const result = await runLocalAcpControl({ verb: 'status' }, fx.profile, {
    platform: 'linux',
    readRecord: () => record,
    inspectProcess: () => 'dead',
    authenticate: async () => { throw new Error('must not authenticate') },
  })
  assert.equal(result.code, 3)
  assert.match(result.stderr, /HOST_NOT_RUNNING/u)
})

test('an incompatible Host protocol is HOST_IDENTITY_REFUSED', async (t) => {
  const fx = fixture(t)
  const record = recordOf(fx.scope, 'http://127.0.0.1:1', { protocol: 'dsh-pi-tui/local/1' as typeof LOCAL_PROTOCOL })
  const result = await run(fx, record, 'status')
  assert.equal(result.code, 3)
  assert.match(result.stderr, /HOST_IDENTITY_REFUSED/u)
})

test('an authentication rejection is HOST_AUTH_FAILED', async (t) => {
  const fx = fixture(t)
  const record = recordOf(fx.scope, 'http://127.0.0.1:1')
  const result = await run(fx, record, 'status', {
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'the cookie was rejected') },
  })
  assert.equal(result.code, 3)
  assert.match(result.stderr, /HOST_AUTH_FAILED/u)
})

test('an already-aborted command sends no request at all', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, controlReply(UUID, 'enabled'))
  const controller = new AbortController()
  controller.abort()
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable', { deps: { signal: controller.signal } })
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /ACP_CLI_UNAVAILABLE/u)
  assert.equal(server.calls.length, 0)
})

test('an unsupported platform fails closed with exit 3', async (t) => {
  const fx = fixture(t)
  const result = await runLocalAcpControl({ verb: 'status' }, fx.profile, { platform: 'aix' })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /UNSUPPORTED_PLATFORM/u)
})

test('the Windows platform reaches the existing authenticated status path', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, statusReply(UUID, 'enabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status', { deps: { platform: 'win32' } })
  assert.deepEqual(result, { code: 0, stdout: 'acp=enabled\n', stderr: '' })
  assert.equal(server.calls.length, 1)
  assert.equal(server.calls[0].path, LOCAL_ACP_STATUS_ROUTE)
})

test('a Windows missing-Host hint quotes the profile for PowerShell, not POSIX', async (t) => {
  const fx = fixture(t)
  const profile = { ...fx.profile, name: "pi tui's" }
  const result = await runLocalAcpControl({ verb: 'status' }, profile, {
    platform: 'win32',
    readRecord: () => undefined,
  })
  assert.equal(result.code, 3)
  assert.match(result.stderr, /dsh --profile 'pi tui''s' daemon start/u)
  assert.doesNotMatch(result.stderr, /'\\''/u, 'the POSIX close-reopen quote must not reach a PowerShell hint')
  const typographic = await runLocalAcpControl({ verb: 'status' }, { ...fx.profile, name: 'pi tui\u2019s' }, {
    platform: 'win32',
    readRecord: () => undefined,
  })
  assert.equal(typographic.code, 3)
  assert.match(typographic.stderr, /dsh --profile 'pi tui\u2019\u2019s' daemon start/u)
  const smartDouble = await runLocalAcpControl({ verb: 'status' }, { ...fx.profile, name: 'pi tui\u201cs' }, {
    platform: 'win32',
    readRecord: () => undefined,
  })
  assert.equal(smartDouble.code, 3)
  assert.match(smartDouble.stderr, /dsh --profile 'pi tui\u201cs' daemon start/u)
})

// ── enable / disable (ONE authenticated write, never replayed) ─────────────

test('enable sends the exact one-shot body and prints the settled state', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, controlReply(UUID, 'enabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.deepEqual(result, { code: 0, stdout: 'acp=enabled\n', stderr: '' })
  assert.equal(server.calls.length, 1)
  assert.equal(server.calls[0].method, 'POST')
  assert.equal(server.calls[0].path, LOCAL_ACP_CONTROL_ROUTE)
  assert.deepEqual(JSON.parse(server.calls[0].body), { schema: 1, instanceId: UUID, op: 'enable' })
  assert.equal(server.calls[0].headers.cookie, 'signed-cookie')
  assert.match(String(server.calls[0].headers['content-type']), /^application\/json/u)
})

test('disable sends op=disable and prints acp=disabled', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, controlReply(UUID, 'disabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'disable')
  assert.deepEqual(result, { code: 0, stdout: 'acp=disabled\n', stderr: '' })
  assert.deepEqual(JSON.parse(server.calls[0].body), { schema: 1, instanceId: UUID, op: 'disable' })
})

test('a settled state that does not match the requested target is OUTCOME_UNCONFIRMED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, controlReply(UUID, 'disabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, 'acp=disabled\n')
  assert.match(result.stderr, /^dsh-pi-tui acp: ACP_OUTCOME_UNCONFIRMED: /u)
  assert.match(result.stderr, /acp status/u)
  assert.equal(server.calls.length, 1)
})

test('a settled changing state is printed with exit 5', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, controlReply(UUID, 'changing'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, 'acp=changing\n')
  assert.match(result.stderr, /ACP_OUTCOME_UNCONFIRMED/u)
})

test('a settled unavailable write is ACP_UNAVAILABLE with exit 4', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, controlReply(UUID, 'unavailable'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'disable')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, 'acp=unavailable\n')
  assert.match(result.stderr, /^dsh-pi-tui acp: ACP_UNAVAILABLE: /u)
})

test('a lost write response is EMPTY stdout and OUTCOME_UNCONFIRMED, never retried', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 0, body: '', drop: true })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui acp: ACP_OUTCOME_UNCONFIRMED: /u)
  assert.equal(server.calls.length, 1, 'a lost POST is never automatically replayed')
})

test('a write cancelled after dispatch keeps the unknown outcome and never replays', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 0, body: '', hang: true })
  const controller = new AbortController()
  const pending = run(fx, recordOf(fx.scope, server.origin), 'disable', { deps: { signal: controller.signal } })
  setTimeout(() => { controller.abort() }, 30)
  const result = await pending
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /ACP_OUTCOME_UNCONFIRMED/u)
  assert.equal(server.calls.length, 1)
})

test('a 503 write response is OUTCOME_UNCONFIRMED, not ACP_CLI_UNAVAILABLE', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 503, body: JSON.stringify({ schema: 1, error: 'ACP_CLI_UNAVAILABLE' }) })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /ACP_OUTCOME_UNCONFIRMED/u)
})

test('a Host replaced after a write reply is OUTCOME_UNCONFIRMED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, controlReply(UUID, 'enabled'))
  const record = recordOf(fx.scope, server.origin)
  const replacement = recordOf(fx.scope, server.origin, { instanceId: OTHER_UUID })
  let reads = 0
  const result = await run(fx, record, 'enable', {
    current: () => { reads += 1; return reads === 1 ? record : replacement },
  })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /ACP_OUTCOME_UNCONFIRMED/u)
})

test('a write reply that is not strict no-store JSON is OUTCOME_UNCONFIRMED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { ...controlReply(UUID, 'enabled'), cacheControl: 'public' })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.equal(server.calls.length, 1)
})

for (const [status, code, expected] of [
  [401, 3, 'HOST_AUTH_FAILED'],
  [403, 3, 'HOST_AUTH_FAILED'],
  [404, 4, 'ACP_CLI_UNAVAILABLE'],
  [409, 3, 'HOST_IDENTITY_REFUSED'],
  [400, 4, 'ACP_CLI_UNAVAILABLE'],
  [405, 4, 'ACP_CLI_UNAVAILABLE'],
  [415, 4, 'ACP_CLI_UNAVAILABLE'],
] as const) {
  test(`a deterministic pre-dispatch ${status} is ${expected} with empty stdout`, async (t) => {
    const fx = fixture(t)
    const server = await startServer(t, { status, body: JSON.stringify({ schema: 1, error: 'ACP_INVALID_REQUEST' }) })
    const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
    assert.equal(result.code, code)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(`^dsh-pi-tui acp: ${expected}: `, 'u'))
    assert.equal(server.calls.length, 1)
  })
}

test('an authenticated sequence reuses the same Host across status/enable/status', async (t) => {
  const fx = fixture(t)
  const replies: HttpReply[] = [statusReply(UUID, 'disabled'), controlReply(UUID, 'enabled'), statusReply(UUID, 'enabled')]
  const server = await startServer(t, () => replies.shift()!)
  const record = recordOf(fx.scope, server.origin)
  assert.deepEqual(await run(fx, record, 'status'), { code: 0, stdout: 'acp=disabled\n', stderr: '' })
  assert.deepEqual(await run(fx, record, 'enable'), { code: 0, stdout: 'acp=enabled\n', stderr: '' })
  assert.deepEqual(await run(fx, record, 'status'), { code: 0, stdout: 'acp=enabled\n', stderr: '' })
  assert.deepEqual(server.calls.map(call => `${call.method} ${call.path}`), [
    `GET ${LOCAL_ACP_STATUS_ROUTE}`,
    `POST ${LOCAL_ACP_CONTROL_ROUTE}`,
    `GET ${LOCAL_ACP_STATUS_ROUTE}`,
  ])
})

// ── output hygiene ─────────────────────────────────────────────────────────

test('every failure line stays one sanitized line without private paths or credentials', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 500, body: JSON.stringify({ schema: 1, error: 'ACP_CLI_UNAVAILABLE' }) })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assertSingleLine(result.stderr)
  assert.equal(result.stdout, '')
  assert.doesNotMatch(result.stderr, new RegExp(fx.scope.dir, 'u'))
  assert.doesNotMatch(result.stderr, /signed-cookie|token=/u)
})
