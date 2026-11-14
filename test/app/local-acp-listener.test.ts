/**
 * Host-owned local ACP v1 listener contracts.
 *
 * These tests drive the REAL listener module over a REAL pathname Unix socket
 * in a test-owned 0700 directory with a raw NDJSON JSON-RPC client, so they
 * prove the socket permission, the ACP v1 initialize handshake, connection
 * isolation, the capacity/backpressure bounds, the fail-closed Session
 * rejections, the unsafe-inode refusals, stale reclaim and fd-shortened long
 * paths without booting a Host. Real Host composition (listen-before-Ready,
 * SIGTERM, SIGKILL stale restart) lives in the split-process smoke.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-listener.test
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { closeSync, openSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { type LocalScope } from '../../src/app/remote-process/local-scope.ts'
import {
  LocalAcpError,
  parseAcpMaxConnections,
  startLocalAcpListener,
  type LocalAcpListener,
} from '../../src/app/remote-process/local-acp-listener.ts'
import type { HostAcpSessionAccess, LiveAgentViewIdentity } from '../../src/app/remote-process/local-acp-session-view.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const QUIET_DIAG: Diag = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  dispose: () => {},
}

/** A diag that records warn codes so a bound-breach test can name the exact cap. */
function recordingDiag(): { diag: Diag; warnings: Array<{ code?: string }> } {
  const warnings: Array<{ code?: string }> = []
  const diag: Diag = {
    debug: () => {},
    info: () => {},
    warn: (_message: string, fields?: Record<string, unknown>) => {
      warnings.push({ code: typeof fields?.code === 'string' ? fields.code : undefined })
    },
    error: () => {},
    dispose: () => {},
  }
  return { diag, warnings }
}

/** One raw NDJSON JSON-RPC client over a real UDS connection. */
class RawClient {
  private readonly socket: ReturnType<typeof connect>
  private buffer = ''
  private readonly queue: unknown[] = []
  private waiter: ((value: unknown) => void) | undefined
  private failure: Error | undefined
  readonly closed: Promise<void>

  private constructor(socket: ReturnType<typeof connect>) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const message: unknown = JSON.parse(line)
        const waiter = this.waiter
        if (waiter !== undefined) {
          this.waiter = undefined
          waiter(message)
        } else {
          this.queue.push(message)
        }
      }
    })
    socket.on('error', error => { this.failure = error })
    this.closed = new Promise<void>(resolveClose => socket.on('close', () => resolveClose()))
  }

  static open(path: string): Promise<RawClient> {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = connect(path)
      socket.once('connect', () => {
        socket.off('error', rejectOpen)
        resolveOpen(new RawClient(socket))
      })
      socket.once('error', rejectOpen)
    })
  }

  send(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  sendRaw(text: string): void {
    this.socket.write(text)
  }

  /** Stop reading from the kernel so the peer's output bound is exercised. */
  pause(): void {
    this.socket.pause()
  }

  next(timeoutMs = 5_000): Promise<unknown> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    const awaitable = new Promise<unknown>((resolveNext, rejectNext) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        rejectNext(new Error(`raw client: no message within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = value => { clearTimeout(timer); resolveNext(value) }
    })
    this.failure = undefined
    return awaitable
  }

  getLastFailure(): Error | undefined {
    return this.failure
  }

  close(): void {
    this.socket.destroy()
  }
}

/** Build a fake LocalScope whose `dir` is the real 0700 directory under test. */
function makeScope(dir: string): LocalScope {
  return {
    scopeId: 'a'.repeat(64),
    dshHome: dir,
    profileRealpath: dir,
    dir,
    hostSocketName: `\0dsh-pi-tui-h-${'h'.repeat(40)}`,
    clientSeatSocketName: `\0dsh-pi-tui-c-${'c'.repeat(40)}`,
    buildId: 'b'.repeat(64),
    bundleVersion: '9.9.9-test',
    dshVersion: '0.0.0-test',
  }
}

/** One test-owned 0700 scope directory plus the LocalScope that names it. */
function newScope(t: TestContext): { dir: string; scope: LocalScope } {
  const dir = testLifecycle(t).tempDir('acp-scope-')
  return { dir, scope: makeScope(dir) }
}

function initialize(client: RawClient, id: number, protocolVersion = 1): void {
  client.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, clientCapabilities: {} } })
}

async function expectClose(client: RawClient): Promise<void> {
  await client.closed
}

test('parseAcpMaxConnections defaults to 4 and rejects out-of-range or malformed values', () => {
  assert.equal(parseAcpMaxConnections(undefined), 4)
  assert.equal(parseAcpMaxConnections('1'), 1)
  assert.equal(parseAcpMaxConnections('16'), 16)
  for (const bad of ['0', '17', 'abc', '', ' 4', '4 ', '04', '-1', '1.0']) {
    assert.throws(() => parseAcpMaxConnections(bad), (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_INVALID_MAX_CONNECTIONS')
  }
})

test('a bound listener answers ACP v1 initialize with the installed bundle version and a 0600 owned socket', async t => {
  const { dir, scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())

  const info = lstatSync(listener.socketPath)
  assert.ok(info.isSocket(), 'the socket path must be a socket')
  assert.equal(info.uid, process.getuid?.(), 'the socket must be owned by this uid')
  assert.equal(info.mode & 0o777, 0o600, 'the socket must be 0600')
  assert.equal(lstatSync(dir).mode & 0o777, 0o700, 'the scope directory must be 0700')

  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    const response = (await client.next()) as {
      id: number
      result?: { protocolVersion: number; agentInfo: { name: string; version: string }; authMethods: unknown[]; agentCapabilities: { loadSession: boolean } }
    }
    assert.equal(response.id, 1)
    assert.equal(response.result?.protocolVersion, 1)
    assert.equal(response.result?.agentInfo.name, 'dsh-pi-tui')
    assert.equal(response.result?.agentInfo.version, '9.9.9-test')
    assert.deepEqual(response.result?.authMethods, [])
    assert.equal(response.result?.agentCapabilities.loadSession, false)
  } finally {
    client.close()
  }
  await listener.close()
  assert.ok(!pathExists(listener.socketPath), 'a graceful close must retire the socket path')
})

test('two connections reuse JSON-RPC id 1 independently and one closing does not affect the other', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())

  const a = await RawClient.open(listener.socketPath)
  const b = await RawClient.open(listener.socketPath)
  try {
    initialize(a, 1)
    initialize(b, 1)
    const [ra, rb] = await Promise.all([a.next(), b.next()]) as [{ id: number; result?: { protocolVersion: number } }, { id: number; result?: { protocolVersion: number } }]
    assert.equal(ra.id, 1)
    assert.equal(rb.id, 1)
    assert.equal(ra.result?.protocolVersion, 1)
    assert.equal(rb.result?.protocolVersion, 1)
    // A duplicate initialize on ONE connection is rejected while the other's
    // identical id is untouched: the per-connection parser is independent.
    initialize(a, 1)
    const duplicate = (await a.next()) as { id: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(duplicate.error?.code, -32043)
    assert.equal(duplicate.error?.data?.code, 'LOCAL_ACP_ALREADY_INITIALIZED')
    a.close()
    await a.closed
    // B is already initialized, so a fresh initialize would be a duplicate;
    // prove B's connection is still live by a Session rejection instead.
    b.send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} })
    const stillWorks = (await b.next()) as { id: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(stillWorks.id, 2)
    assert.equal(stillWorks.error?.code, -32042)
    assert.equal(stillWorks.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY')
  } finally {
    a.close()
    b.close()
  }
})

test('unsupported Session methods fail closed with LOCAL_ACP_SESSION_NOT_READY before and after initialize', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    // Before initialize: still a deterministic, non-success rejection.
    client.send({ jsonrpc: '2.0', id: 10, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] } })
    const early = (await client.next()) as { id: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(early.error?.code, -32042)
    assert.equal(early.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY')

    initialize(client, 1)
    await client.next()

    const calls = [
      { id: 21, method: 'session/list', params: {} },
      { id: 23, method: 'session/set_config_option', params: { sessionId: 's', configId: 'c', value: 'v' } },
      { id: 24, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] } },
    ]
    for (const call of calls) {
      client.send({ jsonrpc: '2.0', ...call })
      const response = (await client.next()) as { id: number; error?: { code: number; data?: { code?: string } } }
      assert.equal(response.id, call.id)
      assert.equal(response.error?.code, -32042, `${call.method} must fail closed`)
      assert.equal(response.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY')
    }
    // A session/cancel notification has no response and no side effect.
    client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } })
  } finally {
    client.close()
  }
})

test('without a Host Session View the lifecycle methods stay fail-closed (raw socket fallback)', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    const calls = [
      { id: 30, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } },
      { id: 31, method: 'session/resume', params: { sessionId: 's', cwd: '/tmp' } },
      { id: 32, method: 'session/close', params: { sessionId: 's' } },
    ]
    for (const call of calls) {
      client.send({ jsonrpc: '2.0', ...call })
      const response = (await client.next()) as { id: number; error?: { code: number; data?: { code?: string } } }
      assert.equal(response.id, call.id)
      assert.equal(response.error?.code, -32042, `${call.method} must fail closed without a Host Session View`)
      assert.equal(response.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY')
    }
  } finally {
    client.close()
  }
})

test('initialize rejects an unsupported protocol version with invalid params', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1, 2)
    const response = (await client.next()) as { id: number; error?: { code: number } }
    assert.equal(response.error?.code, -32602)
  } finally {
    client.close()
  }
})

test('a connection above maxConnections receives a bounded capacity error and is closed', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 2, diag: QUIET_DIAG })
  t.after(() => listener.close())

  const first = await RawClient.open(listener.socketPath)
  const second = await RawClient.open(listener.socketPath)
  try {
    initialize(first, 1)
    initialize(second, 1)
    await first.next()
    await second.next()
    assert.equal(listener.connectionCount(), 2)
    const third = await RawClient.open(listener.socketPath)
    const capacity = (await third.next()) as { id: null; error?: { code: number; data?: { code?: string } } }
    assert.equal(capacity.id, null)
    assert.equal(capacity.error?.code, -32041)
    assert.equal(capacity.error?.data?.code, 'LOCAL_ACP_CAPACITY_EXCEEDED')
    await third.closed
    assert.equal(listener.connectionCount(), 2, 'the rejected connection must never count')
    // Closing one frees a slot for a new connection. The listener removes the
    // closed socket from its Set on the socket's own 'close' event; the slot is
    // then observable as capacity for the next real connection.
    second.close()
    await second.closed
    const fourth = await withTimeout(openWithCapacity(listener, 20_000), 25_000, 'a freed connection slot must accept a new client')
    try {
      initialize(fourth, 1)
      const response = (await fourth.next()) as { result?: { protocolVersion: number } }
      assert.equal(response.result?.protocolVersion, 1)
    } finally {
      fourth.close()
    }
  } finally {
    first.close()
    second.close()
  }
})

test('a connection whose peer stops reading is closed by its own output bound and never affects a sibling', async t => {
  const { scope } = newScope(t)
  const recorded = recordingDiag()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: recorded.diag })
  t.after(() => listener.close())

  const victim = await RawClient.open(listener.socketPath)
  const healthy = await RawClient.open(listener.socketPath)
  try {
    initialize(victim, 1)
    await victim.next()
    initialize(healthy, 1)
    await healthy.next()
    // The victim stops reading entirely; the server's per-connection output
    // bound must close it while the sibling stays healthy.
    victim.pause()
    // Flood small Session rejections in small batches (keeping outstanding
    // requests under the 8 cap) so the bound that trips is the output backlog,
    // not the pending-request cap.
    for (let index = 0; index < 6_000; index += 1) {
      victim.send({ jsonrpc: '2.0', id: 1_000 + index, method: 'session/list', params: {} })
      if (index % 4 === 3) await new Promise<void>(resolveTick => setImmediate(resolveTick))
    }
    await withTimeout(victim.closed, 20_000, 'the slow consumer connection must close on its output bound')
    assert.ok(recorded.warnings.some(warning => warning.code === 'LOCAL_ACP_OUTPUT_BACKPRESSURE'),
      `the slow-consumer connection must close on LOCAL_ACP_OUTPUT_BACKPRESSURE; saw ${JSON.stringify(recorded.warnings.map(w => w.code))}`)
    // The sibling connection is untouched and still answers.
    healthy.send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} })
    const response = (await healthy.next()) as { id: number; error?: { code: number } }
    assert.equal(response.id, 2)
    assert.equal(response.error?.code, -32042)
  } finally {
    victim.close()
    healthy.close()
  }
})

test('an oversized input frame closes only that connection while a sibling stays usable', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())

  const victim = await RawClient.open(listener.socketPath)
  const healthy = await RawClient.open(listener.socketPath)
  try {
    initialize(healthy, 1)
    await healthy.next()
    // One line above the 1 MiB per-frame cap, with no newline.
    victim.sendRaw('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"x":"')
    victim.sendRaw('a'.repeat(1024 * 1024 + 16))
    await expectClose(victim)
    // The sibling connection is unaffected; it is already initialized, so a
    // Session rejection proves the connection still answers.
    healthy.send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} })
    const response = (await healthy.next()) as { id: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(response.id, 2)
    assert.equal(response.error?.code, -32042)
    assert.equal(response.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY')
  } finally {
    victim.close()
    healthy.close()
  }
})

test('a regular file or a symlink at the socket path is refused without being deleted', async t => {
  const fileDir = testLifecycle(t).tempDir('acp-scope-')
  const filePath = join(fileDir, 'acp.sock')
  writeFileSync(filePath, 'not a socket')
  await assert.rejects(
    startLocalAcpListener({ scope: makeScope(fileDir), maxConnections: 4, diag: QUIET_DIAG }),
    (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_UNSAFE_SOCKET',
  )
  assert.equal(lstatSync(filePath).isFile(), true, 'the foreign regular file must not be removed')

  const linkDir = testLifecycle(t).tempDir('acp-scope-')
  const linkPath = join(linkDir, 'acp.sock')
  symlinkSync(join(linkDir, 'target.sock'), linkPath)
  await assert.rejects(
    startLocalAcpListener({ scope: makeScope(linkDir), maxConnections: 4, diag: QUIET_DIAG }),
    (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_UNSAFE_SOCKET',
  )
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'the symlink must not be removed')
})

test('a live listener on the socket path is refused as in-use and never unlinked', async t => {
  const { scope } = newScope(t)
  const first = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => first.close())
  const inodeBefore = lstatSync(first.socketPath).ino
  await assert.rejects(
    startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG }),
    (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_SOCKET_IN_USE',
  )
  assert.equal(lstatSync(first.socketPath).ino, inodeBefore, 'the live socket inode must be untouched')
})

test('a stale socket left by a killed owner is reclaimed only after its identity is rechecked', async t => {
  const dir = testLifecycle(t).tempDir('acp-scope-')
  const socketPath = join(dir, 'acp.sock')
  // A child binds a real pathname socket and blocks; killing it with SIGKILL
  // leaves the socket inode behind (a real stale file, not a fixture).
  const child = spawn(process.execPath, ['-e', `
    const net = require('node:net')
    const server = net.createServer(() => {})
    server.listen(${JSON.stringify(socketPath)}, () => { process.stdout.write('bound\\n') })
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  await new Promise<void>((resolveBound, rejectBound) => {
    // bounded deadline: the child must prove it bound the socket before reclaim.
    const timer = setTimeout(() => rejectBound(new Error('stale child did not bind in time')), 10_000)
    child.stdout?.on('data', data => {
      if (String(data).includes('bound')) { clearTimeout(timer); resolveBound() }
    })
    child.once('exit', () => rejectBound(new Error('stale child exited before binding')))
  })
  assert.ok(lstatSync(socketPath).isSocket(), 'the child must have created a real socket inode')
  child.kill('SIGKILL')
  await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))

  const scope = makeScope(dir)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    const response = (await client.next()) as { result?: { protocolVersion: number } }
    assert.equal(response.result?.protocolVersion, 1, 'the reclaimed socket must serve initialize')
  } finally {
    client.close()
  }
})

test('a long logical socket path still binds through the fd-shortened kernel path', async t => {
  // Build a nested 0700 directory whose FULL logical acp.sock path exceeds the
  // Linux sun_path byte limit; the listener must bind and the client must
  // connect through their own directory fd.
  let dir = testLifecycle(t).tempDir('acp-base-')
  while (dir.length + '/acp.sock'.length <= 200) {
    dir = join(dir, `segment-${'x'.repeat(40)}`)
    mkdirSync(dir, { mode: 0o700 })
  }
  const scope = makeScope(dir)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())
  assert.ok(listener.socketPath.length > 108, 'the logical path must exceed the sun_path limit')

  // The client has the same sun_path limit, so it connects via its own fd.
  const clientDirFd = openSync(dir, 'r')
  t.after(() => { try { closeSync(clientDirFd) } catch {} })
  const client = await RawClient.open(`/proc/self/fd/${String(clientDirFd)}/acp.sock`)
  try {
    initialize(client, 1)
    const response = (await client.next()) as { result?: { protocolVersion: number } }
    assert.equal(response.result?.protocolVersion, 1)
  } finally {
    client.close()
  }
  await listener.close()
  assert.equal(pathExists(join(dir, 'acp.sock')), false, 'the long-path socket inode must retire on close')
})

test('cleanupSync removes only this listener own socket inode and is a no-op after close', async t => {
  const { scope } = newScope(t)
  const listener: LocalAcpListener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  try {
    // cleanupSync retires THIS process's own socket inode synchronously.
    listener.cleanupSync()
    assert.equal(pathExists(listener.socketPath), false, 'cleanupSync retires this listener own socket inode')
  } finally {
    await listener.close()
  }
  // A cleanupSync after close stays a no-op instead of throwing on a retired path.
  listener.cleanupSync()
  assert.equal(pathExists(listener.socketPath), false, 'cleanupSync after close is a no-op')
})

/**
 * Wait until a freshly opened client is ACCEPTED rather than capacity-refused.
 * The listener drops a closed connection from its Set on that socket's 'close'
 * event, so the freed slot may lag the client-side `close` by one tick; opening
 * again until the listener counts below capacity is the authoritative signal.
 */
async function openWithCapacity(listener: LocalAcpListener, _timeoutMs: number): Promise<RawClient> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (listener.connectionCount() < 2) {
      return await RawClient.open(listener.socketPath)
    }
    await new Promise<void>(resolveTick => setImmediate(resolveTick))
  }
  throw new Error('openWithCapacity: the listener never freed a connection slot')
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Bound one awaited promise; a missed bound is a loud failure, never a hang. */
async function withTimeout<T>(value: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`withTimeout: ${label}`)), timeoutMs)
  })
  try {
    return await Promise.race([value, bound])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * PO-1B: the read-only `isListening()` fact the runtime controller relies on to
 * report `enabled`. It proves the bound server and the exact owned socket inode,
 * never a rebind, and turns false the moment the owned inode is gone.
 */
test('isListening() is true while bound, false after close, and close is idempotent', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  assert.equal(listener.isListening(), true, 'a freshly bound, 0600-owned socket must report listening')
  await listener.close()
  assert.equal(listener.isListening(), false, 'a closed listener must never report listening')
  // Repeated close is inert (never throws, never resurrects the socket).
  await listener.close()
  assert.equal(listener.isListening(), false, 'a repeated close stays not-listening')
})

test('isListening() is false when the owned socket inode is removed externally', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  assert.equal(listener.isListening(), true)
  unlinkSync(listener.socketPath)
  assert.equal(listener.isListening(), false, 'the bound server must not claim a path it no longer owns')
  await listener.close()
})

test('a second listener after close re-binds the same pathname and reports listening', async t => {
  const { scope } = newScope(t)
  const first = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  const path = first.socketPath
  await first.close()
  assert.equal(pathExists(path), false, 'the first close retires its owned inode')
  const second = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  assert.equal(second.socketPath, path, 'a re-enable reuses the same logical socket pathname')
  assert.equal(second.isListening(), true)
  await second.close()
})

/**
 * PO-1B / Finding 1 — retirement must never delete an inode this process does
 * not own. Node's `net.Server.close()` unlinks the pathname it was told to
 * listen on; after the owned inode is gone and the path is replaced (a regular
 * file, or a newer live server's socket), that automatic unlink must NOT delete
 * the foreign entry. Two real negative controls on the target runtime.
 */
test('retiring a listener never deletes a foreign replacement file at the path', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  const path = listener.socketPath
  // A foreign process removes our socket inode and drops a regular file in place.
  unlinkSync(path)
  writeFileSync(path, 'REPLACEMENT')
  await listener.close()
  assert.ok(pathExists(path), 'the foreign replacement file must survive retirement')
  assert.equal(lstatSync(path).isFile(), true, 'the replacement is still the foreign file')
})

test('retiring an old listener never deletes a newer live server\'s socket path', async t => {
  const { dir, scope } = newScope(t)
  const old = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  const logical = old.socketPath
  unlinkSync(logical)
  // A newer listener binds a fresh inode at the SAME logical pathname.
  const newerDirFd = openSync(dir, 'r')
  const newer = createServer(s => s.destroy())
  await new Promise<void>((resolveListen, rejectListen) => {
    newer.once('error', rejectListen)
    newer.listen(`/proc/self/fd/${String(newerDirFd)}/acp.sock`, () => {
      newer.off('error', rejectListen)
      resolveListen()
    })
  })
  assert.equal(lstatSync(logical).isSocket(), true, 'the newer server owns a socket at the path')
  await old.close()
  assert.equal(newer.listening, true, 'the newer server must keep listening after the old retirement')
  assert.ok(pathExists(logical), 'the newer server pathname must survive the old listener retirement')
  await new Promise<void>(resolveClose => newer.close(() => resolveClose()))
  closeSync(newerDirFd)
})

test('a live foreign socket at the contract path is refused and never overwritten', async t => {
  const { dir, scope } = newScope(t)
  const logical = join(scope.dir, 'acp.sock')
  const scopeFd = openSync(dir, 'r')
  const foreign = createServer(socket => socket.destroy())
  await new Promise<void>((resolveListen, rejectListen) => {
    foreign.once('error', rejectListen)
    foreign.listen(`/proc/self/fd/${String(scopeFd)}/acp.sock`, () => { foreign.off('error', rejectListen); resolveListen() })
  })
  const ino = lstatSync(logical).ino
  try {
    await assert.rejects(
      startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG }),
      (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_SOCKET_IN_USE',
      'a live foreign socket must make our bind refuse with LOCAL_ACP_SOCKET_IN_USE',
    )
    assert.equal(foreign.listening, true, 'the foreign server keeps listening')
    assert.equal(lstatSync(logical).ino, ino, 'the foreign socket inode is untouched (never overwritten)')
    const connectable = await new Promise<boolean>(resolve => {
      const client = connect(logical)
      client.once('connect', () => { client.destroy(); resolve(true) })
      client.once('error', () => resolve(false))
    })
    assert.equal(connectable, true, 'the foreign socket remains connectable at its path')
  } finally {
    await new Promise<void>(resolveClose => foreign.close(() => resolveClose()))
    closeSync(scopeFd)
  }
})

/**
 * A crash BETWEEN the private bind and the private-name unlink (SIGKILL mid
 * startup) leaves a stale `<scope.dir>/.acp-priv/acp.sock`. The next start of the
 * SAME legal Host must recover it — not fail with EADDRINUSE — while the contract
 * pathname is rebuilt as a real 0600 socket that answers ACP v1 initialize.
 */
test('a stale PRIVATE bind socket left by SIGKILL is recovered on the next start', async t => {
  const { dir, scope } = newScope(t)
  const privDir = join(dir, '.acp-priv')
  mkdirSync(privDir, { recursive: true, mode: 0o700 })
  const privSock = join(privDir, 'acp.sock')
  // Child: raw-listen on the private path (crash window state), report, then hang.
  const childScript = [
    "const { createServer } = require('node:net')",
    "const { openSync } = require('node:fs')",
    "const fd = openSync(process.env.PRIVDIR, 'r')",
    "const srv = createServer(s => s.destroy())",
    "srv.listen('/proc/self/fd/' + fd + '/acp.sock', () => process.stdout.write('LISTENED\\n'))",
    "setInterval(() => {}, 1000)",
  ].join('\n')
  const child = spawn(process.execPath, ['-e', childScript], {
    env: { ...process.env, PRIVDIR: privDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  // bounded deadline: fail fast if the child never prints LISTENED (a real
  // readiness signal, not a blind sleep). `withTimeout` clears its own timer.
  await withTimeout(new Promise<void>((resolveReady, rejectReady) => {
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.includes('LISTENED')) resolveReady()
    })
    child.on('exit', code => rejectReady(new Error(`private-bind child exited early: ${String(code)}`)))
  }), 15_000, 'private-bind child never reported LISTENED')
  child.kill('SIGKILL')
  await new Promise<void>(resolveExit => child.on('exit', () => resolveExit()))
  assert.equal(lstatSync(privSock).isSocket(), true, 'the SIGKILL must leave a stale private socket')

  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  try {
    const info = lstatSync(listener.socketPath)
    assert.equal(info.isSocket(), true, 'the contract path is a real socket after recovery')
    assert.equal(info.mode & 0o777, 0o600, 'the recovered contract socket is 0600')
    assert.equal(pathExists(privSock), false, 'the stale private bind name is removed during recovery')
    const client = await RawClient.open(listener.socketPath)
    try {
      initialize(client, 1)
      const reply = await client.next()
      assert.equal((reply as { result?: { protocolVersion?: number } })?.result?.protocolVersion, 1,
        'the recovered socket answers ACP v1 initialize')
    } finally {
      client.close()
    }
  } finally {
    await listener.close()
  }
  assert.equal(pathExists(listener.socketPath), false, 'normal close retires the contract inode')
  assert.equal(pathExists(privSock), false, 'the private bind name stays gone after close')
})

/** A minimal in-memory Host Session access that keeps EXACT object identity. */
function makeFakeAccess(): {
  access: HostAcpSessionAccess
  seed: (id: string, cwd: string) => LiveAgentViewIdentity
} {
  const agents = new Map<string, { id: string; session: { id: string; header: { cwd: string } } }>()
  let counter = 0
  return {
    access: {
      async createWorkspace(path: string) {
        return { kind: 'created' as const, workspaceId: `ws-${path}`, path }
      },
      async createSession(workspaceId: string) {
        counter += 1
        const id = `session-${String(counter)}`
        agents.set(id, { id, session: { id, header: { cwd: `/host/${workspaceId}` } } })
        return { kind: 'created' as const, sessionId: id }
      },
      async resolveAgent(sessionId: string) {
        const agent = agents.get(sessionId)
        return agent === undefined
          ? { error: { code: 'session/not-found', message: 'not found' } }
          : { agent }
      },
      currentAgent(sessionId: string) {
        return agents.get(sessionId)
      },
      currentSession(sessionId: string) {
        return agents.get(sessionId)?.session
      },
    },
    seed: (id: string, cwd: string) => {
      const agent = { id, session: { id, header: { cwd } } }
      agents.set(id, agent)
      return agent
    },
  }
}

test('a Host Session View advertises resume/close and serves new/close over the real ACP socket', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    // Before initialize a lifecycle request is refused with the View code.
    client.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/host/x', mcpServers: [] } })
    const pre = (await client.next()) as { error?: { data?: { code?: string } } }
    assert.equal(pre.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_INITIALIZED')

    initialize(client, 2)
    const init = (await client.next()) as {
      result?: { agentCapabilities: { loadSession: boolean; sessionCapabilities: { resume?: unknown; close?: unknown } } }
    }
    assert.equal(init.result?.agentCapabilities.loadSession, false)
    assert.ok(init.result?.agentCapabilities.sessionCapabilities.resume !== undefined, 'resume capability is advertised')
    assert.ok(init.result?.agentCapabilities.sessionCapabilities.close !== undefined, 'close capability is advertised')

    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await client.next()) as { result?: { sessionId?: string } }
    assert.equal(typeof created.result?.sessionId, 'string')
    const sessionId = created.result?.sessionId as string

    // A second new while attached is refused as busy (no second Host create).
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const busy = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(busy.error?.code, -32602)
    assert.equal(busy.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')

    client.send({ jsonrpc: '2.0', id: 5, method: 'session/close', params: { sessionId } })
    const closed = (await client.next()) as { result?: unknown }
    assert.deepEqual(closed.result, {})
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId } })
    const again = (await client.next()) as { result?: unknown }
    assert.deepEqual(again.result, {}, 'a repeated close on the same connection is idempotent')

    // A still-unsupported method keeps the misleading-free fail-closed code.
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } })
    const prompt = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(prompt.error?.code, -32042)
    assert.equal(prompt.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY')
  } finally {
    client.close()
  }
})

test('a second ACP connection cannot attach an already-held Session; invalid requests fail before dispatch', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-resume', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const a = await RawClient.open(listener.socketPath)
  const b = await RawClient.open(listener.socketPath)
  try {
    initialize(a, 1)
    await a.next()
    initialize(b, 1)
    await b.next()

    a.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-resume', cwd: 'relative' } })
    const badCwd = (await a.next()) as { error?: { data?: { code?: string } } }
    assert.equal(badCwd.error?.data?.code, 'LOCAL_ACP_VIEW_INVALID_REQUEST')

    a.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [{ name: 'srv', command: 'x', args: [], env: [] }] } })
    const badMcp = (await a.next()) as { error?: { data?: { code?: string } } }
    assert.equal(badMcp.error?.data?.code, 'LOCAL_ACP_VIEW_INVALID_REQUEST')

    a.send({ jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 'session-resume', cwd: '/host/proj' } })
    const ok = (await a.next()) as { result?: unknown }
    assert.deepEqual(ok.result, {})

    b.send({ jsonrpc: '2.0', id: 5, method: 'session/resume', params: { sessionId: 'session-resume', cwd: '/host/proj' } })
    const conflict = (await b.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(conflict.error?.code, -32602)
    assert.equal(conflict.error?.data?.code, 'LOCAL_ACP_VIEW_ALREADY_ATTACHED')

    // Connection A is unaffected and can still detach; then B may attach.
    a.send({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId: 'session-resume' } })
    const closedA = (await a.next()) as { result?: unknown }
    assert.deepEqual(closedA.result, {})
    b.send({ jsonrpc: '2.0', id: 7, method: 'session/resume', params: { sessionId: 'session-resume', cwd: '/host/proj' } })
    const okB = (await b.next()) as { result?: unknown }
    assert.deepEqual(okB.result, {})
  } finally {
    a.close()
    b.close()
  }
})

test('session/new carries the authoritative created session id in JSON-RPC error data on published-with-error', async t => {
  const { scope } = newScope(t)
  const access: HostAcpSessionAccess = {
    async createWorkspace() {
      return { kind: 'created', workspaceId: 'ws-po2', path: '/host' }
    },
    async createSession() {
      return { kind: 'published-with-error', sessionId: 'session-created-po2', code: 'session/workspace-attach-failed' }
    },
    async resolveAgent() {
      return { error: { code: 'session/not-found', message: 'not found' } }
    },
    currentAgent() {
      return undefined
    },
    currentSession() {
      return undefined
    },
  }
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host', mcpServers: [] } })
    const response = (await client.next()) as {
      error?: { code: number; data?: { code?: string; sessionId?: string } }
    }
    assert.equal(response.error?.code, -32603)
    assert.equal(response.error?.data?.code, 'LOCAL_ACP_VIEW_CREATE_ATTACH_FAILED')
    assert.equal(response.error?.data?.sessionId, 'session-created-po2',
      'the JSON-RPC error data must preserve the created Session id')
  } finally {
    client.close()
  }
})
