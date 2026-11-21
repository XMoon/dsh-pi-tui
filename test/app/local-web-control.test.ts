/**
 * The headless Web CLI runner: the real authenticated-request boundary against
 * a real local HTTP listener, the fixed stdout/stderr/exit contract, the
 * currentness fences and the Client-local OS opener behaviour.
 *
 * Evidence level: structural + real loopback HTTP. It proves the runner's
 * source -> decision -> sink contract; the real backed Host/Connection/admission
 * lane is the selectable packed split-process case.
 *
 * @module @xmoon76/dsh-pi-tui/local-web-control.test
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
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
  runLocalWebControl,
  type LocalWebControlDeps,
} from '../../src/app/remote-process/local-web-control.ts'
import type { LinuxLocalInstanceRecord, VerifiedLocalHost } from '../../src/app/remote-process/local-discovery.ts'
import { LOCAL_WEB_CONTROL_ROUTE } from '../../src/app/remote-process/local-web-control-route.ts'

const UUID = '11111111-1111-4111-8111-111111111111'
const OTHER_UUID = '22222222-2222-4222-8222-222222222222'
const DSH_VERSION = '0.2.2-rc.5'

interface Fixture {
  readonly profile: DaemonControlProfile
  readonly scope: LocalScope
}

function fixture(t: TestContext): Fixture {
  const root = testLifecycle(t).tempDir('m6web-')
  const home = join(root, 'dsh-home')
  const profileDir = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  const anchor = join(root, 'dsh', 'package.json')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'dsh'), { recursive: true, mode: 0o700 })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.7' })}\n`)
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
}

interface LocalServer {
  readonly origin: string
  readonly calls: HttpCall[]
  setReply(reply: HttpReply | ((call: HttpCall) => HttpReply)): void
}

function startServer(t: TestContext, initial: HttpReply): Promise<LocalServer> {
  let reply: HttpReply | ((call: HttpCall) => HttpReply) = initial
  const calls: HttpCall[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const call: HttpCall = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body }
      calls.push(call)
      const resolved = typeof reply === 'function' ? reply(call) : reply
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
  t.after(() => new Promise<void>((resolve, reject) => {
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

function successState(instanceId: string, state: string): HttpReply {
  return { status: 200, body: JSON.stringify({ schema: 1, instanceId, state }) }
}

interface RunOptions {
  readonly current?: () => LinuxLocalInstanceRecord | undefined
  readonly authenticate?: LocalWebControlDeps['authenticate']
  readonly deps?: Partial<LocalWebControlDeps>
}

async function run(fx: Fixture, record: LinuxLocalInstanceRecord, verb: 'status' | 'enable' | 'disable' | 'url' | 'open', options: RunOptions = {}) {
  const verified: VerifiedLocalHost = { record, cookie: 'signed-cookie', identity: record }
  return await runLocalWebControl({ verb }, fx.profile, {
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

// ── status ────────────────────────────────────────────────────────────────

test('status prints exactly one legal state and keeps the authenticated Cookie in memory', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, successState(UUID, 'disabled'))
  const record = recordOf(fx.scope, server.origin)
  const result = await run(fx, record, 'status')
  assert.deepEqual(result, { code: 0, stdout: 'web=disabled\n', stderr: '' })
  assert.equal(server.calls.length, 1)
  assert.equal(server.calls[0].method, 'GET')
  assert.equal(server.calls[0].path, LOCAL_WEB_CONTROL_ROUTE)
  assert.equal(server.calls[0].headers.cookie, 'signed-cookie')
})

for (const state of ['enabled', 'changing', 'unavailable'] as const) {
  test(`status reports the legal ${state} state with exit 0`, async (t) => {
    const fx = fixture(t)
    const server = await startServer(t, successState(UUID, state))
    const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
    assert.deepEqual(result, { code: 0, stdout: `web=${state}\n`, stderr: '' })
  })
}

test('status 404 maps to WEB_CLI_UNAVAILABLE (an old Host build)', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 404, body: 'not found', contentType: 'text/plain' })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui web: WEB_CLI_UNAVAILABLE: /u)
})

test('status never turns a malformed or foreign response into disabled', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, instanceId: OTHER_UUID, state: 'disabled' }) })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /HOST_IDENTITY_REFUSED/u)
})

test('status fails closed when the response is not no-store JSON', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: successState(UUID, 'disabled').body, cacheControl: 'public' })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'status')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
})

for (const verb of ['status', 'url', 'open'] as const) {
  test(`a live Host whose ${verb} read produces no response is WEB_CLI_UNAVAILABLE, never HOST_NOT_RUNNING`, async (t) => {
    const fx = fixture(t)
    const server = await startServer(t, { status: 0, body: '', drop: true })
    const result = await run(fx, recordOf(fx.scope, server.origin), verb)
    assert.equal(result.code, 4)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^dsh-pi-tui web: WEB_CLI_UNAVAILABLE: /u)
    assert.doesNotMatch(result.stderr, /HOST_NOT_RUNNING/u)
  })
}

test('a read failure with a freshly dead Host is HOST_NOT_RUNNING', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 0, body: '', drop: true })
  const record = recordOf(fx.scope, server.origin)
  let inspections = 0
  const result = await run(fx, record, 'status', {
    deps: {
      inspectProcess: () => {
        inspections += 1
        return inspections === 1 ? 'alive' : 'dead'
      },
    },
  })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui web: HOST_NOT_RUNNING: /u)
})

test('a read failure with a replaced instance is HOST_IDENTITY_REFUSED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 0, body: '', drop: true })
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
  assert.match(result.stderr, /^dsh-pi-tui web: HOST_IDENTITY_REFUSED: /u)
})

// ── Host discovery / authentication fail-closed ───────────────────────────

test('a missing Host is HOST_NOT_RUNNING with the daemon start hint and zero requests', async (t) => {
  const fx = fixture(t)
  let authenticated = 0
  const result = await runLocalWebControl({ verb: 'status' }, fx.profile, {
    platform: 'linux',
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    authenticate: async () => { authenticated += 1; throw new Error('must not authenticate') },
  })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui web: HOST_NOT_RUNNING: /u)
  assert.match(result.stderr, /dsh --profile pi-tui daemon start/u)
  assert.equal(authenticated, 0)
})

test('a dead Host process is HOST_NOT_RUNNING', async (t) => {
  const fx = fixture(t)
  const record = recordOf(fx.scope, 'http://127.0.0.1:1')
  const result = await runLocalWebControl({ verb: 'status' }, fx.profile, {
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

// ── enable / disable ───────────────────────────────────────────────────────

test('enable sends the exact one-shot body and prints the settled state', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, successState(UUID, 'enabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.deepEqual(result, { code: 0, stdout: 'web=enabled\n', stderr: '' })
  assert.equal(server.calls.length, 1)
  assert.equal(server.calls[0].method, 'POST')
  assert.equal(server.calls[0].path, LOCAL_WEB_CONTROL_ROUTE)
  assert.deepEqual(JSON.parse(server.calls[0].body), { schema: 1, instanceId: UUID, op: 'enable' })
  assert.match(String(server.calls[0].headers['content-type']), /^application\/json/u)
})

test('disable sends op=disable and prints web=disabled', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, successState(UUID, 'disabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'disable')
  assert.deepEqual(result, { code: 0, stdout: 'web=disabled\n', stderr: '' })
  assert.deepEqual(JSON.parse(server.calls[0].body), { schema: 1, instanceId: UUID, op: 'disable' })
})

test('a settled state that does not match the requested target is OUTCOME_UNCONFIRMED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, successState(UUID, 'disabled'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, 'web=disabled\n')
  assert.match(result.stderr, /WEB_OUTCOME_UNCONFIRMED/u)
})

test('a settled changing state is printed with exit 5', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, successState(UUID, 'changing'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, 'web=changing\n')
  assert.match(result.stderr, /WEB_OUTCOME_UNCONFIRMED/u)
})

test('a settled unavailable write is WEB_UNAVAILABLE with exit 4', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, successState(UUID, 'unavailable'))
  const result = await run(fx, recordOf(fx.scope, server.origin), 'disable')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, 'web=unavailable\n')
  assert.match(result.stderr, /WEB_UNAVAILABLE/u)
})

test('a lost write response is EMPTY stdout and OUTCOME_UNCONFIRMED, never retried', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 0, body: '', drop: true })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /WEB_OUTCOME_UNCONFIRMED/u)
  assert.equal(server.calls.length, 1, 'a lost POST is never automatically replayed')
})

test('a 503 write response is OUTCOME_UNCONFIRMED, not WEB_CLI_UNAVAILABLE', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 503, body: JSON.stringify({ schema: 1, error: 'WEB_CLI_UNAVAILABLE' }) })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'enable')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /WEB_OUTCOME_UNCONFIRMED/u)
})

test('a Host replaced after a write reply is OUTCOME_UNCONFIRMED', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, successState(UUID, 'enabled'))
  const record = recordOf(fx.scope, server.origin)
  const replacement = recordOf(fx.scope, server.origin, { instanceId: OTHER_UUID })
  let reads = 0
  const result = await run(fx, record, 'enable', {
    current: () => { reads += 1; return reads === 1 ? record : replacement },
  })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /WEB_OUTCOME_UNCONFIRMED/u)
})

// ── url / open ────────────────────────────────────────────────────────────

test('url prints exactly the Host-returned authenticated URL and nothing else', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, {
    status: 200,
    body: JSON.stringify({ schema: 1, instanceId: UUID, url: 'http://127.0.0.1:1/?token=placeholder' }),
  })
  const record = recordOf(fx.scope, server.origin)
  // The Host URL origin must equal the authenticated record origin; point both
  // at the real listener origin instead of the illustrative port above.
  const realUrl = `${server.origin}/?token=opaque-token`
  server.setReply({ status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: realUrl }) })
  const result = await run(fx, record, 'url')
  assert.deepEqual(result, { code: 0, stdout: `${realUrl}\n`, stderr: '' })
  assertSingleLine(result.stdout)
  assert.equal(server.calls.length, 1)
  assert.deepEqual(JSON.parse(server.calls[0].body), { schema: 1, instanceId: UUID, op: 'url' })
})

test('url while disabled is WEB_DISABLED and never calls the URL method', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, error: 'WEB_DISABLED' }) })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'url')
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^dsh-pi-tui web: WEB_DISABLED: /u)
  assert.match(result.stderr, /web enable/u)
})

test('url while changing is WEB_CHANGING with exit 5', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, error: 'WEB_CHANGING' }) })
  const result = await run(fx, recordOf(fx.scope, server.origin), 'url')
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /WEB_CHANGING/u)
})

for (const badUrl of [
  'https://127.0.0.1:4444/?token=x',
  'http://127.0.0.1:4444/?token=x',
  'http://127.0.0.1:4444/other?token=x',
  'http://127.0.0.1:4444/?token=x&extra=y',
  'http://127.0.0.1:4444/?token=',
  'http://127.0.0.1:4444/#frag?token=x',
  'http://user:pass@127.0.0.1:4444/?token=x',
]) {
  test(`url rejects an unexpected URL shape without printing it: ${badUrl}`, async (t) => {
    const fx = fixture(t)
    const server = await startServer(t, {
      status: 200,
      body: JSON.stringify({ schema: 1, instanceId: UUID, url: badUrl }),
    })
    // The record origin is the real listener; only the exact `http://<listener>/?token=` shape is legal.
    const result = await run(fx, recordOf(fx.scope, server.origin), 'url')
    assert.equal(result.code, 4)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /WEB_CLI_UNAVAILABLE/u)
    assert.doesNotMatch(result.stderr, /token|user:pass/u)
  })
}

test('url fails closed when the Host changes before the URL is read', async (t) => {
  const fx = fixture(t)
  const realUrl = `${'http://127.0.0.1:4444'}/?token=x`
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: realUrl }) })
  const record = recordOf(fx.scope, server.origin)
  const replacement = recordOf(fx.scope, server.origin, { instanceId: OTHER_UUID })
  let reads = 0
  const result = await run(fx, record, 'url', { current: () => { reads += 1; return reads === 1 ? record : replacement } })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /HOST_IDENTITY_REFUSED/u)
})

test('open uses the local opener with the authenticated URL and reports only browser=requested', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: `${'http://127.0.0.1:4444'}/?token=x` }) })
  const realUrl = `${server.origin}/?token=opaque`
  server.setReply({ status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: realUrl }) })
  const spawned: { command: string; args: readonly string[] }[] = []
  class FakeChild extends EventEmitter {
    unref(): void {}
  }
  const fakeSpawn = ((command: string, args: readonly string[]) => {
    spawned.push({ command, args })
    const child = new FakeChild()
    setImmediate(() => { child.emit('spawn'); child.emit('exit', 0, null) })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  const result = await run(fx, recordOf(fx.scope, server.origin), 'open', { deps: { spawn: fakeSpawn } })
  assert.deepEqual(result, { code: 0, stdout: 'browser=requested\n', stderr: '' })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, 'xdg-open')
  assert.deepEqual(spawned[0].args, [realUrl])
})

test('open reports a spawn error as BROWSER_LAUNCH_UNAVAILABLE without argv', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: `${'http://127.0.0.1:4444'}/?token=x` }) })
  const realUrl = `${server.origin}/?token=opaque`
  server.setReply({ status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: realUrl }) })
  class FakeChild extends EventEmitter {
    unref(): void {}
  }
  const fakeSpawn = (() => {
    const child = new FakeChild()
    setImmediate(() => { child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })) })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  const result = await run(fx, recordOf(fx.scope, server.origin), 'open', { deps: { spawn: fakeSpawn } })
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /BROWSER_LAUNCH_UNAVAILABLE/u)
  assert.doesNotMatch(result.stderr, /ENOENT|token|xdg-open/u)
})

test('open reports an immediately observable non-zero opener exit as a failure', async (t) => {
  const fx = fixture(t)
  const server = await startServer(t, { status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: `${'http://127.0.0.1:4444'}/?token=x` }) })
  const realUrl = `${server.origin}/?token=opaque`
  server.setReply({ status: 200, body: JSON.stringify({ schema: 1, instanceId: UUID, url: realUrl }) })
  class FakeChild extends EventEmitter {
    unref(): void {}
  }
  const fakeSpawn = (() => {
    const child = new FakeChild()
    setImmediate(() => { child.emit('spawn'); child.emit('exit', 3, null) })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  const result = await run(fx, recordOf(fx.scope, server.origin), 'open', { deps: { spawn: fakeSpawn } })
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /BROWSER_LAUNCH_UNAVAILABLE/u)
})

// ── unsupported platform ───────────────────────────────────────────────────

test('a non-Linux/macOS platform fails closed with exit 3', async (t) => {
  const fx = fixture(t)
  const result = await runLocalWebControl({ verb: 'status' }, fx.profile, { platform: 'win32' })
  assert.equal(result.code, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /UNSUPPORTED_PLATFORM/u)
})
