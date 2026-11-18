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
import { createHash } from 'node:crypto'
import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { closeSync, openSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { type LocalScope } from '../../src/app/remote-process/local-scope.ts'
import {
  createBoundedInput,
  darwinAcpSocketPaths,
  deriveImageInputBounds,
  LocalAcpError,
  parseAcpMaxConnections,
  startLocalAcpListener,
  type LocalAcpListener,
  deriveImageOutputBounds,
} from '../../src/app/remote-process/local-acp-listener.ts'
import {
  AcpSessionViewRegistry,
  type AcpImageLimits,
  type AcpPromptFactListener,
  type AcpSessionPromptRequest,
  type AcpStoredImage,
  type AcpStoredImageRef,
  type HostAcpSessionAccess,
  type LiveAgentViewIdentity,
} from '../../src/app/remote-process/local-acp-session-view.ts'
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

  /** Write raw UTF-8 bytes exactly as given (fragmentation/byte-boundary tests). */
  writeRaw(bytes: Uint8Array): void {
    this.socket.write(bytes)
  }

  /** Stop reading from the kernel so the peer's output bound is exercised. */
  pause(): void {
    this.socket.pause()
  }

  /** Resume reading after a `pause()` so the peer's close/replies are observed. */
  resume(): void {
    this.socket.resume()
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

  /** Prove a bounded window of silence (a NOT-YET fact, not a timing guess). */
  async silent(windowMs: number): Promise<boolean> {
    if (this.queue.length > 0) return false
    return await new Promise(resolveSilent => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (silent: boolean): void => {
        if (this.waiter === waiter) this.waiter = undefined
        clearTimeout(timer)
        resolveSilent(silent)
      }
      const waiter = (value: unknown): void => {
        this.queue.unshift(value)
        finish(false)
      }
      this.waiter = waiter
      timer = setTimeout(() => finish(true), windowMs)
    })
  }

  close(): void {
    this.socket.destroy()
  }
}

const IS_DARWIN = process.platform === 'darwin'

/** The public contract pathname of one test scope, by the listener's platform rule. */
function publicSocketPath(scope: LocalScope): string {
  return IS_DARWIN
    ? darwinAcpSocketPaths(scope, process.getuid?.() as number).publicPath
    : join(scope.dir, 'acp.sock')
}

/** The private bind name of one test scope; the listener itself owns its creation. */
function privateBindPathOf(scope: LocalScope): string {
  return IS_DARWIN
    ? darwinAcpSocketPaths(scope, process.getuid?.() as number).privateBindPath
    : join(scope.dir, '.acp-priv', 'acp.sock')
}

/**
 * Create and register THIS test's own Darwin endpoint root. The root is
 * deterministic from the per-test scope id, so it can never name another test's
 * or another profile's directory; teardown removes exactly this root.
 */
function ownDarwinRoot(t: TestContext, scope: LocalScope): void {
  if (!IS_DARWIN) return
  const { privateRoot } = darwinAcpSocketPaths(scope, process.getuid?.() as number)
  mkdirSync(privateRoot, { mode: 0o700 })
  t.after(() => { rmSync(privateRoot, { recursive: true, force: true }) })
}

/**
 * Bind a raw `net.Server` at ONE scope's public contract path the way a second
 * owner would: Linux binds directly inside the 0700 scope; Darwin binds the
 * private name and hard-links it onto the public path. The caller owns and must
 * close the returned server.
 */
async function bindRawServerAtPublicPath(
  scope: LocalScope,
  onConnection: (socket: import('node:net').Socket) => void,
): Promise<{ readonly close: () => Promise<void> }> {
  const server = createServer(onConnection)
  if (IS_DARWIN) {
    const paths = darwinAcpSocketPaths(scope, process.getuid?.() as number)
    mkdirSync(join(paths.privateRoot, '.acp-priv'), { recursive: true, mode: 0o700 })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(paths.privateBindPath, () => { server.off('error', rejectListen); resolveListen() })
    })
    chmodSync(paths.privateBindPath, 0o600)
    linkSync(paths.privateBindPath, paths.publicPath)
    unlinkSync(paths.privateBindPath)
    return { close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())) }
  }
  const dirFd = openSync(scope.dir, 'r')
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(`/proc/self/fd/${String(dirFd)}/acp.sock`, () => { server.off('error', rejectListen); resolveListen() })
  })
  return {
    close: async () => {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      closeSync(dirFd)
    },
  }
}

/** Build a fake LocalScope whose `dir` is the real 0700 directory under test. */
function makeScope(dir: string): LocalScope {
  // The Darwin endpoint is deterministic from the scope id, so every test
  // directory MUST get its own id (hashing the canonical test directory keeps a
  // retry of the same directory on the same id); a fixed id would make unrelated
  // tests contend for one /private/tmp endpoint.
  const scopeId = createHash('sha256').update(realpathSync(dir)).digest('hex')
  return {
    scopeId,
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
  const scope = makeScope(dir)
  ownDarwinRoot(t, scope)
  return { dir, scope }
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
  const fileScope = makeScope(fileDir)
  ownDarwinRoot(t, fileScope)
  const filePath = publicSocketPath(fileScope)
  writeFileSync(filePath, 'not a socket')
  await assert.rejects(
    startLocalAcpListener({ scope: fileScope, maxConnections: 4, diag: QUIET_DIAG }),
    (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_UNSAFE_SOCKET',
  )
  assert.equal(lstatSync(filePath).isFile(), true, 'the foreign regular file must not be removed')

  const linkDir = testLifecycle(t).tempDir('acp-scope-')
  const linkScope = makeScope(linkDir)
  ownDarwinRoot(t, linkScope)
  const linkPath = publicSocketPath(linkScope)
  symlinkSync(join(linkDir, 'target.sock'), linkPath)
  await assert.rejects(
    startLocalAcpListener({ scope: linkScope, maxConnections: 4, diag: QUIET_DIAG }),
    (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_UNSAFE_SOCKET',
  )
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'the symlink must not be removed')

  if (IS_DARWIN) {
    // The Darwin endpoint root has its own admission: a same-UID symlink, file
    // or existing non-0700 directory is refused without being written through or
    // silently repaired. (The Linux contract has no separate /private/tmp root.)
    const { scope } = newScope(t)
    const endpoint = darwinAcpSocketPaths(scope, process.getuid?.() as number)
    rmSync(endpoint.privateRoot, { recursive: true, force: true })
    const target = testLifecycle(t).tempDir('acp-root-target-')
    symlinkSync(target, endpoint.privateRoot)
    await assert.rejects(
      startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG }),
      (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_UNSAFE_SOCKET',
    )
    assert.equal(lstatSync(endpoint.privateRoot).isSymbolicLink(), true, 'the symlink root must survive the refusal')
    assert.equal(readdirSync(target).length, 0, 'the refusal must not write through the symlink')

    rmSync(endpoint.privateRoot, { force: true })
    writeFileSync(endpoint.privateRoot, 'not a directory')
    await assert.rejects(
      startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG }),
      (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_UNSAFE_SOCKET',
    )
    assert.equal(lstatSync(endpoint.privateRoot).isFile(), true, 'the foreign file root must survive the refusal')

    rmSync(endpoint.privateRoot, { force: true })
    mkdirSync(endpoint.privateRoot, { mode: 0o755 })
    chmodSync(endpoint.privateRoot, 0o755)
    await assert.rejects(
      startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG }),
      (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_UNSAFE_SOCKET',
    )
    assert.equal(lstatSync(endpoint.privateRoot).mode & 0o777, 0o755,
      'the existing non-private root mode must not be rewritten')
  }
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
  const scope = makeScope(dir)
  ownDarwinRoot(t, scope)
  const socketPath = publicSocketPath(scope)
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

test('a long DSH_HOME binds through the platform short endpoint', async t => {
  // A deeply nested, non-standard scope directory whose own `acp.sock` path is
  // far above the kernel sun_path limit must still serve a real ACP connection:
  // Linux shortens the scope through /proc/self/fd; Darwin publishes the short
  // profile-scoped /private/tmp endpoint instead.
  let dir = testLifecycle(t).tempDir('acp-long-home-')
  while (Buffer.byteLength(join(dir, 'acp.sock'), 'utf8') + 1 <= 200) {
    dir = join(dir, `segment-${'x'.repeat(32)}`)
    mkdirSync(dir, { mode: 0o700 })
  }
  const scope = makeScope(dir)

  if (IS_DARWIN) {
    ownDarwinRoot(t, scope)
    const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
    t.after(() => listener.close())
    const endpoint = darwinAcpSocketPaths(scope, process.getuid?.() as number)
    assert.equal(listener.socketPath, endpoint.publicPath, 'the listener must publish the computed short endpoint')
    assert.ok(Buffer.byteLength(listener.socketPath, 'utf8') + 1 <= 104, 'the public endpoint must fit sun_path[104]')
    assert.equal(listener.isListening(), true, 'the short endpoint must report listening')

    const rootInfo = lstatSync(endpoint.privateRoot)
    assert.equal(rootInfo.isDirectory(), true, 'the endpoint root must be a real directory')
    assert.equal(rootInfo.uid, process.getuid?.(), 'the endpoint root must be owned by this uid')
    assert.equal(rootInfo.mode & 0o777, 0o700, 'the endpoint root must be 0700')
    assert.equal(pathExists(endpoint.privateBindPath), false,
      'the private bind name must be gone after the hard-link publish')

    const socketInfo = lstatSync(listener.socketPath)
    assert.equal(socketInfo.isSocket(), true, 'the public endpoint must be a socket')
    assert.equal(socketInfo.uid, process.getuid?.(), 'the public endpoint must be owned by this uid')
    assert.equal(socketInfo.mode & 0o777, 0o600, 'the public endpoint must be 0600')
    assert.equal(socketInfo.nlink, 1, 'the published socket must have exactly ONE name after the private unlink')

    const client = await RawClient.open(listener.socketPath)
    try {
      initialize(client, 1)
      const response = (await client.next()) as { result?: { protocolVersion: number } }
      assert.equal(response.result?.protocolVersion, 1)
    } finally {
      client.close()
    }
    return
  }

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

test('the Darwin endpoint formula is deterministic, profile-scoped and short', async t => {
  const scope = makeScope(testLifecycle(t).tempDir('acp-endpoint-'))
  const uid = process.getuid?.() as number
  const first = darwinAcpSocketPaths(scope, uid)
  const second = darwinAcpSocketPaths(scope, uid)
  assert.deepEqual(second, first, 'the same canonical scope must compute the same endpoint')
  assert.equal(first.privateRoot, join('/private/tmp', `dpt-${String(uid)}-${scope.scopeId.slice(0, 40)}`))
  assert.equal(first.publicPath, join(first.privateRoot, 'acp.sock'))
  assert.equal(first.privateBindPath, join(first.privateRoot, '.acp-priv', 'acp.sock'))
  assert.ok(Buffer.byteLength(first.publicPath, 'utf8') + 1 <= 104, 'the public path must fit sun_path[104] including its NUL')
  assert.ok(Buffer.byteLength(first.privateBindPath, 'utf8') + 1 <= 104, 'the private bind path must fit sun_path[104] including its NUL')
  // A different canonical profile scope selects a different root.
  const other = makeScope(testLifecycle(t).tempDir('acp-endpoint-'))
  assert.notEqual(darwinAcpSocketPaths(other, uid).privateRoot, first.privateRoot)
})

test('two different profile scopes bind their own endpoints at the same time', async t => {
  const first = newScope(t)
  const second = newScope(t)
  const firstListener = await startLocalAcpListener({ scope: first.scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => firstListener.close())
  const secondListener = await startLocalAcpListener({ scope: second.scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => secondListener.close())

  assert.notEqual(firstListener.socketPath, secondListener.socketPath, 'different scopes must not share an endpoint')
  const a = await RawClient.open(firstListener.socketPath)
  const b = await RawClient.open(secondListener.socketPath)
  try {
    initialize(a, 1)
    initialize(b, 1)
    const [ra, rb] = await Promise.all([a.next(), b.next()]) as [{ result?: { protocolVersion: number } }, { result?: { protocolVersion: number } }]
    assert.equal(ra.result?.protocolVersion, 1)
    assert.equal(rb.result?.protocolVersion, 1)
  } finally {
    a.close()
    b.close()
  }
  await firstListener.close()
  assert.equal(secondListener.isListening(), true, 'closing one scope must not disturb the other')
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
  const { scope } = newScope(t)
  const old = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  const logical = old.socketPath
  unlinkSync(logical)
  // A newer listener binds a fresh inode at the SAME logical pathname.
  const newer = await bindRawServerAtPublicPath(scope, socket => socket.destroy())
  try {
    assert.equal(lstatSync(logical).isSocket(), true, 'the newer server owns a socket at the path')
    await old.close()
    assert.ok(pathExists(logical), 'the newer server pathname must survive the old listener retirement')
    const connectable = await new Promise<boolean>(resolve => {
      const client = connect(logical)
      client.once('connect', () => { client.destroy(); resolve(true) })
      client.once('error', () => resolve(false))
    })
    assert.equal(connectable, true, 'the newer server must keep answering at its path after the old retirement')
  } finally {
    await newer.close()
  }
})

test('a live foreign socket at the contract path is refused and never overwritten', async t => {
  const { scope } = newScope(t)
  const logical = publicSocketPath(scope)
  const foreign = await bindRawServerAtPublicPath(scope, socket => socket.destroy())
  const ino = lstatSync(logical).ino
  try {
    await assert.rejects(
      startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG }),
      (error: unknown) => error instanceof LocalAcpError && error.code === 'LOCAL_ACP_SOCKET_IN_USE',
      'a live foreign socket must make our bind refuse with LOCAL_ACP_SOCKET_IN_USE',
    )
    assert.equal(lstatSync(logical).ino, ino, 'the foreign socket inode is untouched (never overwritten)')
    const connectable = await new Promise<boolean>(resolve => {
      const client = connect(logical)
      client.once('connect', () => { client.destroy(); resolve(true) })
      client.once('error', () => resolve(false))
    })
    assert.equal(connectable, true, 'the foreign socket remains connectable at its path')
  } finally {
    await foreign.close()
  }
})

/**
 * A crash BETWEEN the private bind and the private-name unlink (SIGKILL mid
 * startup) leaves a stale `<scope.dir>/.acp-priv/acp.sock`. The next start of the
 * SAME legal Host must recover it — not fail with EADDRINUSE — while the contract
 * pathname is rebuilt as a real 0600 socket that answers ACP v1 initialize.
 */
test('a stale PRIVATE bind socket left by SIGKILL is recovered on the next start', async t => {
  const { scope } = newScope(t)
  const privSock = privateBindPathOf(scope)
  const privDir = join(privSock, '..')
  mkdirSync(privDir, { recursive: true, mode: 0o700 })
  // Child: raw-listen on the private path (crash window state), report, then hang.
  // Linux reaches the long scope dir through its own /proc/self/fd; Darwin binds
  // the direct short private name and never uses /proc.
  const childScript = IS_DARWIN
    ? [
      "const { createServer } = require('node:net')",
      "const srv = createServer(s => s.destroy())",
      "srv.listen(process.env.PRIVSOCK, () => process.stdout.write('LISTENED\\n'))",
      "setInterval(() => {}, 1000)",
    ].join('\n')
    : [
      "const { createServer } = require('node:net')",
      "const { openSync } = require('node:fs')",
      "const fd = openSync(process.env.PRIVDIR, 'r')",
      "const srv = createServer(s => s.destroy())",
      "srv.listen('/proc/self/fd/' + fd + '/acp.sock', () => process.stdout.write('LISTENED\\n'))",
      "setInterval(() => {}, 1000)",
    ].join('\n')
  const child = spawn(process.execPath, ['-e', childScript], {
    env: { ...process.env, PRIVDIR: privDir, PRIVSOCK: privSock },
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
function makeFakeAccess(options: {
  readonly imageLimits?: AcpImageLimits
  readonly supportsImagePrompts?: () => Promise<boolean>
  readonly readOutputImage?: (ref: AcpStoredImageRef, signal: AbortSignal) => Promise<AcpStoredImage>
} = {}): {
  access: HostAcpSessionAccess
  seed: (id: string, cwd: string) => LiveAgentViewIdentity
  agentOf: (id: string) => LiveAgentViewIdentity | undefined
  prompts: AcpSessionPromptRequest[]
  facts: () => AcpPromptFactListener | undefined
  observeCalls: () => number
  removedMessageIds: string[]
  cancelledTurns: Array<{ readonly turn: number; readonly keepInbox: boolean }>
  turnFence: { openTurnStartSeq: number | null; lastTurn: number }
  staleCancel: { value: boolean }
  pendingInbox: Set<string>
} {
  const agents = new Map<string, { id: string; session: { id: string; header: { cwd: string } } }>()
  const prompts: AcpSessionPromptRequest[] = []
  const removedMessageIds: string[] = []
  const cancelledTurns: Array<{ readonly turn: number; readonly keepInbox: boolean }> = []
  const pendingInbox = new Set<string>()
  const turnFence = { openTurnStartSeq: null as number | null, lastTurn: 0 }
  let facts: AcpPromptFactListener | undefined
  let observeCalls = 0
  const staleCancel = { value: false }
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
      imageLimits() {
        return options.imageLimits
      },
      supportsImagePrompts() {
        return options.supportsImagePrompts?.() ?? Promise.resolve(false)
      },
      async readOutputImage(ref: AcpStoredImageRef, signal: AbortSignal) {
        if (options.readOutputImage === undefined) throw new Error('no attachment store')
        return await options.readOutputImage(ref, signal)
      },
      async prompt(request: AcpSessionPromptRequest) {
        prompts.push(request)
        return { accepted: true as const }
      },
      pendingMessage(sessionId: string, agent: LiveAgentViewIdentity, session: object, messageId: string) {
        if (agents.get(sessionId) !== agent || agents.get(sessionId)?.session !== session || agent.session !== session) return 'stale'
        return pendingInbox.has(messageId) ? 'pending' : 'absent'
      },
      cancelPending(sessionId: string, agent: LiveAgentViewIdentity, session: object, messageId: string) {
        if (staleCancel.value) return 'stale'
        if (agents.get(sessionId) !== agent || agents.get(sessionId)?.session !== session) return 'stale'
        if (!pendingInbox.delete(messageId)) return 'not-pending'
        removedMessageIds.push(messageId)
        facts?.onInboxDiscarded(agent, { id: messageId })
        return 'removed'
      },
      cancelCurrentTurn(sessionId: string, agent: LiveAgentViewIdentity, session: object, turn: number) {
        if (agents.get(sessionId) !== agent || agents.get(sessionId)?.session !== session) return 'stale'
        if (turnFence.openTurnStartSeq === null || turnFence.lastTurn !== turn) return 'not-current'
        cancelledTurns.push({ turn, keepInbox: true })
        turnFence.openTurnStartSeq = null
        return 'addressed'
      },
      currentTurn(sessionId: string, agent: LiveAgentViewIdentity, session: object) {
        if (agents.get(sessionId) !== agent || agents.get(sessionId)?.session !== session) return { kind: 'stale' }
        return { kind: 'current' as const, openTurn: turnFence.openTurnStartSeq === null ? null : turnFence.lastTurn }
      },
      observePromptFacts(listener: AcpPromptFactListener) {
        observeCalls += 1
        facts = {
          onInboxInserted(agent, message) {
            pendingInbox.add(message.id)
            listener.onInboxInserted(agent, message)
          },
          onInboxClaimed(agent, message, turn) {
            pendingInbox.delete(message.id)
            listener.onInboxClaimed(agent, message, turn)
          },
          onInboxDiscarded: (agent, message) => listener.onInboxDiscarded(agent, message),
          onSessionEvent(session, event) {
            if (event.type === 'turn/end' && (event.data as { turn?: number }).turn === turnFence.lastTurn) {
              turnFence.openTurnStartSeq = null
            }
            listener.onSessionEvent(session, event)
          },
          onAgentError: (agent, turn) => listener.onAgentError(agent, turn),
          onAgentDisposed: agent => listener.onAgentDisposed(agent),
          onApprovalRequest: (request, next) => listener.onApprovalRequest(request, next),
        }
        return () => { facts = undefined }
      },
    },
    prompts,
    facts: () => facts,
    observeCalls: () => observeCalls,
    agentOf: (id: string) => agents.get(id),
    seed: (id: string, cwd: string) => {
      const agent = { id, session: { id, header: { cwd } } }
      agents.set(id, agent)
      return agent
    },
    removedMessageIds,
    cancelledTurns,
    pendingInbox,
    turnFence,
    staleCancel,
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

    // A prompt on a connection that holds NO View for that Session is refused
    // with the View's own stable code and never reaches the Host.
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } })
    const prompt = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(prompt.error?.code, -32602)
    assert.equal(prompt.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    assert.equal(fake.prompts.length, 0, 'an unattached prompt never reaches the Host')
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
    imageLimits() {
      return undefined
    },
    supportsImagePrompts() {
      return Promise.resolve(false)
    },
    async readOutputImage() {
      throw new Error('no attachment store')
    },
    async prompt() {
      return { accepted: true as const }
    },
    pendingMessage() {
      return 'stale' as const
    },
    cancelPending() {
      return 'stale' as const
    },
    cancelCurrentTurn() {
      return 'stale' as const
    },
    currentTurn() {
      return { kind: 'stale' as const }
    },
    observePromptFacts() {
      return () => {}
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

/** Wait until a recorded fact exists (real async delivery, never a fixed sleep). */
async function waitForFact<T>(read: () => T | undefined, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('session/prompt admits one attached text prompt and answers the real stop reason after the updates', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await client.next()) as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId as string
    assert.equal(typeof sessionId, 'string')

    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
    })
    const request = await waitForFact(() => fake.prompts[0], 'the Host prompt request')
    assert.equal(request.mode, 'queue')
    assert.deepEqual(request.content, [{ type: 'text', text: 'firstsecond' }])
    assert.equal(fake.prompts.length, 1)
    const facts = fake.facts()
    assert.ok(facts !== undefined, 'the listener registered its prompt fact subscription')
    const agent = fake.agentOf(sessionId)
    assert.ok(agent !== undefined, 'session/new attached the exact live Agent')
    const message = { id: 'm-uds', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxClaimed(agent, message, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-uds', content: [{ type: 'text', text: 'wire answer' }] } },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    const update = (await client.next()) as {
      method?: string
      params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: unknown } }
    }
    assert.equal(update.method, 'session/update')
    assert.equal(update.params?.sessionId, sessionId)
    assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
    assert.deepEqual(update.params?.update?.content, { type: 'text', text: 'wire answer' })
    const response = (await client.next()) as { id?: number; result?: { stopReason?: string }; error?: unknown }
    assert.equal(response.id, 3)
    assert.equal(response.error, undefined)
    assert.equal(response.result?.stopReason, 'end_turn')
  } finally {
    client.close()
  }
})

test('session/prompt keeps uninitialized, unattached, invalid and in-flight requests fail-closed before dispatch', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-resume', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'session-resume', prompt: [{ type: 'text', text: 'x' }] } })
    const uninitialized = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(uninitialized.error?.code, -32042)
    assert.equal(uninitialized.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_INITIALIZED')

    initialize(client, 2)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-resume', prompt: [{ type: 'text', text: 'x' }] } })
    const unattached = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(unattached.error?.code, -32602)
    assert.equal(unattached.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')

    client.send({ jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 'session-resume', cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})

    for (const [id, prompt] of [
      [5, [{ type: 'text', text: '   ' }]],
      [6, []],
      [7, [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]],
    ] as const) {
      client.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: 'session-resume', prompt } })
      const refused = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
      assert.equal(refused.error?.code, -32602)
      assert.equal(refused.error?.data?.code, 'LOCAL_ACP_PROMPT_INVALID_CONTENT')
    }
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/prompt', params: { sessionId: 'other-session', prompt: [{ type: 'text', text: 'x' }] } })
    const wrongSession = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(wrongSession.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    assert.equal(fake.prompts.length, 0, 'no refused request reached the Host')

    // ONE in-flight prompt; a second request on the same View is refused while
    // session/close with an open flight performs the SCOPED cancellation and
    // settles only after the real Host facts prove it.
    client.send({ jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 'session-resume', prompt: [{ type: 'text', text: 'first' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the first Host prompt')
    client.send({ jsonrpc: '2.0', id: 10, method: 'session/prompt', params: { sessionId: 'session-resume', prompt: [{ type: 'text', text: 'second' }] } })
    const inFlight = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(inFlight.error?.code, -32602)
    assert.equal(inFlight.error?.data?.code, 'LOCAL_ACP_PROMPT_IN_FLIGHT')
    client.send({ jsonrpc: '2.0', id: 11, method: 'session/close', params: { sessionId: 'session-resume' } })
    // The message is durably inserted and still pending: the close's scoped
    // cancellation removes exactly it, then the close detaches.
    const facts = fake.facts()
    const agent = fake.agentOf('session-resume')
    assert.ok(facts !== undefined && agent !== undefined)
    facts.onInboxInserted(agent, { id: 'm-close', source: { kind: 'user', rpcId: request.requestId } })
    const promptResponse = (await client.next()) as { id?: number; result?: { stopReason?: string } }
    assert.equal(promptResponse.id, 9)
    assert.equal(promptResponse.result?.stopReason, 'cancelled', 'the cancelled queued prompt answers cancelled')
    const closeSettled = (await client.next()) as { id?: number; result?: unknown }
    assert.equal(closeSettled.id, 11)
    assert.deepEqual(closeSettled.result, {}, 'the close detaches after the proven removal')
    assert.deepEqual(fake.removedMessageIds, ['m-close'], 'exactly the queued message was removed')
    assert.equal(fake.prompts.length, 1, 'only the admitted prompt reached the Host')
  } finally {
    client.close()
  }
})

test('a physical connection end with an in-flight prompt never affects an independent connection', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-a', '/host/a')
  fake.seed('session-b', '/host/b')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const a = await RawClient.open(listener.socketPath)
  const b = await RawClient.open(listener.socketPath)
  try {
    initialize(a, 1)
    await a.next()
    initialize(b, 1)
    await b.next()
    a.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-a', cwd: '/host/a' } })
    assert.deepEqual(((await a.next()) as { result?: unknown }).result, {})
    b.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-b', cwd: '/host/b' } })
    assert.deepEqual(((await b.next()) as { result?: unknown }).result, {})

    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-a', prompt: [{ type: 'text', text: 'a' }] } })
    await waitForFact(() => fake.prompts[0], 'connection A prompt')
    a.close()
    await a.closed

    // Connection B is independent: its own prompt still settles normally.
    b.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-b', prompt: [{ type: 'text', text: 'b' }] } })
    const request = await waitForFact(() => fake.prompts[1], 'connection B prompt')
    const facts = fake.facts()
    assert.ok(facts !== undefined)
    const agent = fake.agentOf('session-b')
    assert.ok(agent !== undefined)
    const message = { id: 'm-b', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxClaimed(agent, message, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-b', content: [{ type: 'text', text: 'b answer' }] } },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const update = (await b.next()) as { method?: string; params?: { update?: { sessionUpdate?: string } } }
    assert.equal(update.method, 'session/update')
    assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
    const response = (await b.next()) as { result?: { stopReason?: string } }
    assert.equal(response.result?.stopReason, 'end_turn')
  } finally {
    a.close()
    b.close()
  }
})

// ── PO-3B: scoped cancel + reverse permission over the REAL socket ──

test('session/cancel over the real socket removes the exact queued message and answers cancelled', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    fake.seed('session-cancel', '/host/proj')
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-cancel', cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-cancel', prompt: [{ type: 'text', text: 'cancel me' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the queued prompt')
    const facts = fake.facts()
    const agent = fake.agentOf('session-cancel')
    assert.ok(facts !== undefined && agent !== undefined)
    facts.onInboxInserted(agent, { id: 'm-cancel', source: { kind: 'user', rpcId: request.requestId } })
    // The standard cancel notification carries no response.
    client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-cancel' } })
    const response = (await client.next()) as { id?: number; result?: { stopReason?: string }; error?: unknown }
    assert.equal(response.id, 3)
    assert.equal(response.error, undefined)
    assert.equal(response.result?.stopReason, 'cancelled', 'the cancelled queued prompt answers cancelled')
    assert.deepEqual(fake.removedMessageIds, ['m-cancel'], 'exactly the queued message was removed')
    assert.deepEqual(fake.cancelledTurns, [], 'no Agent cancel was issued')
    // The View stays attached and serves the next prompt normally.
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-cancel', prompt: [{ type: 'text', text: 'after cancel' }] } })
    const secondRequest = await waitForFact(() => fake.prompts[1], 'the follow-up prompt')
    facts.onInboxInserted(agent, { id: 'm-next', source: { kind: 'user', rpcId: secondRequest.requestId } })
    facts.onInboxClaimed(agent, { id: 'm-next', source: { kind: 'user', rpcId: secondRequest.requestId } }, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-next', content: [{ type: 'text', text: 'next answer' }] } },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const update = (await client.next()) as { method?: string; params?: { update?: { sessionUpdate?: string } } }
    assert.equal(update.method, 'session/update')
    assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
    const second = (await client.next()) as { result?: { stopReason?: string } }
    assert.equal(second.result?.stopReason, 'end_turn')
  } finally {
    client.close()
  }
})

test('an approval of the ACP-owned turn arrives as a REVERSE session/request_permission with the two one-shot options', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    fake.seed('session-approval', '/host/proj')
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-approval', cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-approval', prompt: [{ type: 'text', text: 'ask me' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the approval prompt')
    const facts = fake.facts()
    const agent = fake.agentOf('session-approval')
    assert.ok(facts !== undefined && agent !== undefined)
    facts.onInboxInserted(agent, { id: 'm-ap', source: { kind: 'user', rpcId: request.requestId } })
    fake.turnFence.openTurnStartSeq = 42
    fake.turnFence.lastTurn = 1
    facts.onInboxClaimed(agent, { id: 'm-ap', source: { kind: 'user', rpcId: request.requestId } }, 1)
    // The Host approval request for the OWNED turn reaches the SAME connection
    // as a reverse request with the standard one-shot options.
    const decided = facts.onApprovalRequest({ agent, toolName: 'bash', callId: 'call-ap' }, async () => 'unavailable')
    const reverse = (await client.next(10_000)) as {
      id?: number
      method?: string
      params?: { sessionId?: string; toolCall?: { toolCallId?: string }; options?: Array<{ optionId?: string; kind?: string }> }
    }
    assert.equal(reverse.method, 'session/request_permission')
    assert.equal(reverse.params?.sessionId, 'session-approval')
    assert.equal(reverse.params?.toolCall?.toolCallId, 'call-ap')
    assert.deepEqual(reverse.params?.options?.map(option => option.optionId), ['allow-once', 'reject-once'])
    assert.deepEqual(reverse.params?.options?.map(option => option.kind), ['allow_once', 'reject_once'])
    client.send({ jsonrpc: '2.0', id: reverse.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    assert.equal(await decided, 'allowed-once')
    // The turn settles and the prompt completes normally.
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-ap', content: [{ type: 'text', text: 'approved answer' }] } },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    // The committed answer arrives first as a session/update notification.
    const update = (await client.next()) as { method?: string; params?: { update?: { sessionUpdate?: string } } }
    assert.equal(update.method, 'session/update')
    assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
    const response = (await client.next()) as { id?: number; result?: { stopReason?: string } }
    assert.equal(response.id, 3)
    assert.equal(response.result?.stopReason, 'end_turn')
  } finally {
    client.close()
  }
})

test('a TUI-owned approval never reaches the ACP connection and a second Session stays isolated', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-tui-owned', '/host/a')
  fake.seed('session-other', '/host/b')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const a = await RawClient.open(listener.socketPath)
  const b = await RawClient.open(listener.socketPath)
  try {
    initialize(a, 1)
    await a.next()
    initialize(b, 1)
    await b.next()
    a.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-tui-owned', cwd: '/host/a' } })
    assert.deepEqual(((await a.next()) as { result?: unknown }).result, {})
    b.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-other', cwd: '/host/b' } })
    assert.deepEqual(((await b.next()) as { result?: unknown }).result, {})
    // The TUI-owned turn (open on the official fence, NOT claimed by any ACP
    // flight) delegates to the TUI channel; the ACP connection sees nothing.
    fake.turnFence.openTurnStartSeq = 10
    fake.turnFence.lastTurn = 5
    const facts = fake.facts()
    const agentA = fake.agentOf('session-tui-owned')
    assert.ok(facts !== undefined && agentA !== undefined)
    let delegated = 0
    assert.equal(await facts.onApprovalRequest({ agent: agentA, toolName: 'bash', callId: 'call-tui' }, async () => {
      delegated += 1
      return 'rejected'
    }), 'rejected')
    assert.equal(delegated, 1, 'the TUI-owned approval is delegated exactly once')
    assert.equal(await a.silent(300), true, 'no reverse request reached the ACP connection')
    // A cancel aimed at a Session this connection holds but with NO flight is inert.
    a.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-tui-owned' } })
    assert.equal(await a.silent(300), true, 'an idle cancel notification produces no response and no side effect')
    assert.deepEqual(fake.cancelledTurns, [], 'the open TUI turn was never cancelled')
  } finally {
    a.close()
    b.close()
  }
})

test('R701-01: a runtime Off keeps the Host fact subscription until the LATE insertion (after Off) is cancelled', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    fake.seed('session-off', '/host/proj')
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-off', cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    // Hold the official admission so the message does NOT exist yet.
    let releaseAdmission!: () => void
    const admissionHeld = new Promise<void>(resolveHeld => { releaseAdmission = resolveHeld })
    const promptsRef = fake.prompts
    const originalPrompt = fake.access.prompt.bind(fake.access)
    ;(fake.access as { prompt: unknown }).prompt = async (request: AcpSessionPromptRequest) => {
      promptsRef.push(request)
      await admissionHeld
      return await originalPrompt(request, new AbortController().signal)
    }
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-off', prompt: [{ type: 'text', text: 'off race' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the held admission call')
    // RUNTIME OFF FIRST: the sockets die and retirement begins while no
    // durable message id exists. Retirement must NOT block on the shared turn
    // and must NOT drop the Host fact subscription.
    const closing = listener.close()
    await new Promise(resolveTick => setImmediate(resolveTick))
    assert.equal(fake.facts() !== undefined, true, 'the subscription survives the Off while work is unsettled')
    // NOW the late insertion happens, strictly AFTER the Off: only the
    // surviving subscription can observe it and remove it exactly.
    releaseAdmission()
    const facts = fake.facts()
    const agent = fake.agentOf('session-off')
    assert.ok(facts !== undefined && agent !== undefined)
    facts.onInboxInserted(agent, { id: 'm-late-off', source: { kind: 'user', rpcId: request.requestId } })
    for (let guard = 0; guard < 200 && fake.removedMessageIds.length === 0; guard += 1) {
      await new Promise(resolveTick => setImmediate(resolveTick))
    }
    assert.deepEqual(fake.removedMessageIds, ['m-late-off'],
      'the message inserted AFTER the Off is removed exactly by the surviving subscription')
    await closing
    assert.equal(fake.facts(), undefined, 'the subscription is disposed once the accepted work settled')
  } finally {
    client.close()
  }
})

test('R701-01b: retirement returns promptly while a shared turn is still running (Off never blocks on work it may not cancel)', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    fake.seed('session-mixed', '/host/proj')
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-mixed', cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-mixed', prompt: [{ type: 'text', text: 'mixed' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the running prompt')
    const facts = fake.facts()
    const agent = fake.agentOf('session-mixed')
    assert.ok(facts !== undefined && agent !== undefined)
    // A MIXED turn: the ACP message and a TUI steer share the running turn, so
    // the View may NOT cancel the Agent (D23) and can only wait for turn/end.
    facts.onInboxInserted(agent, { id: 'm-mixed', source: { kind: 'user', rpcId: request.requestId } })
    fake.turnFence.openTurnStartSeq = 10
    fake.turnFence.lastTurn = 1
    facts.onInboxClaimed(agent, { id: 'm-steer', source: { kind: 'user', rpcId: 'tui-steer' } }, 1)
    facts.onInboxClaimed(agent, { id: 'm-mixed', source: { kind: 'user', rpcId: request.requestId } }, 1)
    // Runtime Off must return promptly even though the turn is still running.
    const startedAt = Date.now()
    await listener.close()
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 5_000, `retirement must not block on a shared turn (took ${String(elapsed)}ms)`)
    assert.equal(listener.isListening(), false, 'the socket entry retired immediately')
    assert.deepEqual(fake.cancelledTurns, [], 'a mixed turn is never Agent-cancelled (D23)')
    // The subscription is STILL alive for the running turn's facts.
    assert.ok(fake.facts() !== undefined, 'the Host fact subscription outlives the network entry')
    // The turn ends for real: the subscription is disposed after that fact.
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    for (let guard = 0; guard < 200 && fake.facts() !== undefined; guard += 1) {
      await new Promise(resolveTick => setImmediate(resolveTick))
    }
    assert.equal(fake.facts(), undefined, 'the subscription is disposed at the real terminal')
  } finally {
    client.close()
  }
})

test('R701-03: an Off -> On overlap keeps exactly ONE Host fact/approval subscription', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  // The controller-owned registry (shared across listener rebinds).
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const listenerA = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access, views: registry })
  const clientA = await RawClient.open(listenerA.socketPath)
  fake.seed('session-old', '/host/old')
  fake.seed('session-new', '/host/new')
  try {
    initialize(clientA, 1)
    await clientA.next()
    clientA.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-old', cwd: '/host/old' } })
    assert.deepEqual(((await clientA.next()) as { result?: unknown }).result, {})
    // Unsettled work on the OLD listener: a claimed turn whose flight fails
    // early, leaving a retired-turn approval fence behind.
    clientA.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-old', prompt: [{ type: 'text', text: 'old' }] } })
    const oldRequest = await waitForFact(() => fake.prompts[0], 'the old prompt')
    const factsA = fake.facts()
    const oldAgent = fake.agentOf('session-old')
    assert.ok(factsA !== undefined && oldAgent !== undefined)
    factsA.onInboxInserted(oldAgent, { id: 'm-old', source: { kind: 'user', rpcId: oldRequest.requestId } })
    fake.turnFence.openTurnStartSeq = 10
    fake.turnFence.lastTurn = 1
    factsA.onInboxClaimed(oldAgent, { id: 'm-old', source: { kind: 'user', rpcId: oldRequest.requestId } }, 1)
    factsA.onAgentError(oldAgent, 1)
    assert.equal(fake.observeCalls(), 1, 'the only subscription is the registry-owned one')
    // RUNTIME OFF: the socket dies, but the fence keeps the work unsettled.
    await listenerA.close()
    assert.equal(fake.facts() !== undefined, true, 'the registry-owned subscription survives the Off')
    // RUNTIME ON immediately: the new listener reuses the SAME registry.
    const listenerB = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access, views: registry })
    try {
      assert.equal(fake.observeCalls(), 1, 'the rebind must NOT register a second subscription')
      const clientB = await RawClient.open(listenerB.socketPath)
      try {
        initialize(clientB, 1)
        await clientB.next()
        clientB.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-new', cwd: '/host/new' } })
        assert.deepEqual(((await clientB.next()) as { result?: unknown }).result, {})
        clientB.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-new', prompt: [{ type: 'text', text: 'new' }] } })
        const newRequest = await waitForFact(() => fake.prompts[1], 'the new prompt')
        const facts = fake.facts()
        const newAgent = fake.agentOf('session-new')
        assert.ok(facts !== undefined && newAgent !== undefined)
        facts.onInboxInserted(newAgent, { id: 'm-new', source: { kind: 'user', rpcId: newRequest.requestId } })
        facts.onInboxClaimed(newAgent, { id: 'm-new', source: { kind: 'user', rpcId: newRequest.requestId } }, 2)
        facts.onSessionEvent(newAgent.session, {
          type: 'assistant/message',
          data: { turn: 2, message: { id: 'm-new', content: [{ type: 'text', text: 'one update' }] } },
        })
        // EXACTLY ONE session/update: a duplicate subscription would emit two.
        const update = (await clientB.next()) as { method?: string; params?: { update?: { sessionUpdate?: string } } }
        assert.equal(update.method, 'session/update')
        assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
        assert.equal(await clientB.silent(500), true, 'no duplicate update arrived from a second subscription')
        facts.onSessionEvent(newAgent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
        const response = (await clientB.next()) as { id?: number; result?: { stopReason?: string } }
        assert.equal(response.id, 3)
        assert.equal(response.result?.stopReason, 'end_turn')
      } finally {
        clientB.close()
      }
      // The OLD work ends for real: its durable turn/end kills the fence and
      // settles the registry.
      const oldFacts = fake.facts()
      assert.ok(oldFacts !== undefined)
      oldFacts.onSessionEvent(oldAgent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } } })
      await registry.whenHostWorkSettled()
      assert.equal(fake.observeCalls(), 1)
    } finally {
      await listenerB.close()
    }
    assert.equal(fake.facts() !== undefined, true, 'the registry still owns its single subscription')
    registry.disposeFacts()
    assert.equal(fake.facts(), undefined, 'the controller-owned registry releases the ONE subscription')
  } finally {
    clientA.close()
  }
})

test('LC-01 (UDS): an unconfirmed unclaimed cancellation fails the first AND the repeat close until a real terminal fact', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const a = await RawClient.open(listener.socketPath)
  try {
    initialize(a, 1)
    await a.next()
    fake.seed('session-lc1', '/host/proj')
    a.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-lc1', cwd: '/host/proj' } })
    assert.deepEqual(((await a.next()) as { result?: unknown }).result, {})
    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-lc1', prompt: [{ type: 'text', text: 'queued' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the ACP prompt')
    const facts = fake.facts()
    const agent = fake.agentOf('session-lc1')
    assert.ok(facts !== undefined && agent !== undefined)
    // The exact message exists but was never claimed.
    facts.onInboxInserted(agent, { id: 'm-lc1', source: { kind: 'user', rpcId: request.requestId } })
    // The official identity check fails: the pending removal cannot be proven.
    fake.staleCancel.value = true
    a.send({ jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: 'session-lc1' } })
    const first = (await a.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(first.error?.data?.code, 'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED')
    a.send({ jsonrpc: '2.0', id: 5, method: 'session/close', params: { sessionId: 'session-lc1' } })
    const repeat = (await a.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(repeat.error?.data?.code, 'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED',
      'a repeat close must not turn the unconfirmed cancellation into success')
    assert.deepEqual(fake.removedMessageIds, [], 'no removal was ever proven')
    // Another ACP connection cannot silently take over the Session.
    const b = await RawClient.open(listener.socketPath)
    try {
      initialize(b, 1)
      await b.next()
      b.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-lc1', cwd: '/host/proj' } })
      const conflict = (await b.next()) as { error?: { data?: { code?: string } } }
      assert.equal(conflict.error?.data?.code, 'LOCAL_ACP_VIEW_ALREADY_ATTACHED')
    } finally {
      b.close()
    }
    // The exact Agent's disposal is the real terminal fact.
    facts.onAgentDisposed(agent)
    a.send({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId: 'session-lc1' } })
    let settled: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const message = (await a.next()) as { id?: number; result?: unknown; error?: unknown }
      if (message.id === 6) { settled = message; break }
    }
    assert.deepEqual(settled.result, {}, 'the real terminal fact allows the detach')
  } finally {
    a.close()
  }
})

test('a same-id edit stays pending over UDS, true removal settles, and a later borrowed TUI turn keeps its responder', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const agent = fake.seed('session-checkpoint', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: agent.id, cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: agent.id, prompt: [{ type: 'text', text: 'edit me' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the editable queued prompt')
    const facts = fake.facts()!
    const message = { id: 'm-checkpoint', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxDiscarded(agent, message)
    facts.onInboxInserted(agent, message)
    // A socket round trip crosses the checkpoint and proves the live Flight stayed reserved.
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: agent.id, prompt: [{ type: 'text', text: 'too early' }] } })
    const blocked = (await client.next()) as { id?: number; error?: { data?: { code?: string } } }
    assert.equal(blocked.id, 4)
    assert.equal(blocked.error?.data?.code, 'LOCAL_ACP_PROMPT_IN_FLIGHT')
    fake.pendingInbox.delete(message.id)
    facts.onInboxDiscarded(agent, message)
    const removed = (await client.next()) as { id?: number; result?: { stopReason?: string } }
    assert.equal(removed.id, 3)
    assert.equal(removed.result?.stopReason, 'cancelled')
    assert.deepEqual(fake.removedMessageIds, [], 'an external remove is observed without a second removal')

    // The TUI turn is already open before the next ACP Flight exists.
    fake.turnFence.openTurnStartSeq = 100
    fake.turnFence.lastTurn = 5
    facts.onInboxClaimed(agent, { id: 'm-tui', source: { kind: 'user', rpcId: 'tui' } }, 5)
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: agent.id, prompt: [{ type: 'text', text: 'steer me' }] } })
    const borrowed = await waitForFact(() => fake.prompts[1], 'the borrowed-turn prompt')
    const borrowedMessage = { id: 'm-borrowed', source: { kind: 'user', rpcId: borrowed.requestId } }
    facts.onInboxInserted(agent, borrowedMessage)
    fake.pendingInbox.delete(borrowedMessage.id)
    facts.onInboxDiscarded(agent, borrowedMessage)
    facts.onInboxInserted(agent, borrowedMessage)
    facts.onInboxClaimed(agent, borrowedMessage, 5)
    let delegated = 0
    assert.equal(await facts.onApprovalRequest({ agent, toolName: 'bash', callId: 'tui-ask' }, async () => {
      delegated += 1
      return 'allowed-once'
    }), 'allowed-once')
    assert.equal(delegated, 1, 'the original TUI outcome is preserved exactly once')
    client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: agent.id } })
    // An unrelated request is a delivery barrier for the preceding cancel notification.
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/list', params: {} })
    const barrier = (await client.next()) as { id?: number }
    assert.equal(barrier.id, 6, 'no ACP permission or prompt settlement was sent for the TUI-owned running turn')
    assert.deepEqual(fake.cancelledTurns, [], 'the shared TUI turn is never cancelled')
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    const mixed = (await client.next()) as { id?: number; error?: { data?: { code?: string } } }
    assert.equal(mixed.id, 5)
    assert.equal(mixed.error?.data?.code, 'LOCAL_ACP_PROMPT_MIXED_TURN')
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/close', params: { sessionId: agent.id } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/resume', params: { sessionId: agent.id, cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {}, 'real terminal settlement permits reattach')
  } finally {
    client.close()
  }
})

test('LC-02 (UDS): a disconnect keeps the unconfirmed obligation and the observer until a real terminal fact', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const a = await RawClient.open(listener.socketPath)
  fake.seed('session-lc2', '/host/proj')
  initialize(a, 1)
  await a.next()
  a.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-lc2', cwd: '/host/proj' } })
  assert.deepEqual(((await a.next()) as { result?: unknown }).result, {})
  a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-lc2', prompt: [{ type: 'text', text: 'queued' }] } })
  const request = await waitForFact(() => fake.prompts[0], 'the ACP prompt')
  const facts = fake.facts()
  const agent = fake.agentOf('session-lc2')
  assert.ok(facts !== undefined && agent !== undefined)
  facts.onInboxInserted(agent, { id: 'm-lc2', source: { kind: 'user', rpcId: request.requestId } })
  fake.staleCancel.value = true
  a.send({ jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: 'session-lc2' } })
  const failed = (await a.next()) as { error?: { data?: { code?: string } } }
  assert.equal(failed.error?.data?.code, 'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED')
  // The physical socket goes away; the Host responsibility must not.
  a.close()
  await a.closed
  const b = await RawClient.open(listener.socketPath)
  try {
    initialize(b, 1)
    await b.next()
    b.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-lc2', cwd: '/host/proj' } })
    const conflict = (await b.next()) as { error?: { data?: { code?: string } } }
    assert.equal(conflict.error?.data?.code, 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
      'the disconnected but unresolved obligation still holds the Session')
    assert.ok(fake.facts() !== undefined, 'the Host fact observer survives the disconnect')
    const message = { id: 'm-lc2', source: { kind: 'user', rpcId: request.requestId } }
    // replace commits the same id before discarded(old), then inserted(new).
    facts.onInboxDiscarded(agent, message)
    facts.onInboxInserted(agent, message)
    await Promise.resolve()
    assert.equal(fake.pendingInbox.has(message.id), true)
    b.send({ jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: 'session-lc2', cwd: '/host/proj' } })
    const stillHeld = (await b.next()) as { error?: { data?: { code?: string } } }
    assert.equal(stillHeld.error?.data?.code, 'LOCAL_ACP_VIEW_ALREADY_ATTACHED', 'edit retains the disconnected obligation')
    // Only an exact, live checkpoint proving real absence releases the claim.
    fake.pendingInbox.delete(message.id)
    facts.onInboxDiscarded(agent, message)
    await Promise.resolve()
    b.send({ jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 'session-lc2', cwd: '/host/proj' } })
    assert.deepEqual(((await b.next()) as { result?: unknown }).result, {}, 'the Session is attachable after true removal')
  } finally {
    b.close()
  }
})

// ── PO-4A: image negotiation and bounded image input over the REAL socket ──

test('the image input budget derives only from safe Host attachment limits', () => {
  const bounds = deriveImageInputBounds({
    maxImageBytes: 64,
    maxImagesPerMessage: 3,
    maxMessageImageBytes: 300,
    mediaTypes: ['image/png'],
  })
  assert.deepEqual(bounds, {
    maxFrameBytes: 400 + 1024 * 1024 + 65_536 * 3 + 4_096,
    maxUnconsumedBytes: 400 + 1024 * 1024 + 65_536 * 3 + 4_096 + 1024 * 1024,
  })
  const larger = deriveImageInputBounds({
    maxImageBytes: 128,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 600,
    mediaTypes: ['image/png'],
  })
  assert.ok(larger !== undefined)
  assert.ok(larger.maxFrameBytes > bounds.maxFrameBytes, 'the frame budget grows with configured Host image limits')
  assert.ok(larger.maxUnconsumedBytes > bounds.maxUnconsumedBytes, 'the unconsumed budget grows with Host limits')
  assert.equal(deriveImageInputBounds(undefined), undefined, 'no store means no image budget')
  for (const limits of [
    { maxImageBytes: 0, maxImagesPerMessage: 1, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
    { maxImageBytes: 1, maxImagesPerMessage: 0, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
    { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: -1, mediaTypes: ['image/png'] },
    { maxImageBytes: 1, maxImagesPerMessage: Number.MAX_SAFE_INTEGER, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
  ]) {
    assert.equal(deriveImageInputBounds(limits), undefined, 'unsafe arithmetic cannot advertise image')
  }
})

test('initialize advertises image only when Host capability and usable limits agree', async t => {
  const { scope } = newScope(t)
  const limits = { maxImageBytes: 64, maxImagesPerMessage: 2, maxMessageImageBytes: 300, mediaTypes: ['image/png'] }
  const imageFake = makeFakeAccess({ imageLimits: limits, supportsImagePrompts: () => Promise.resolve(true) })
  const imageListener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: imageFake.access })
  t.after(() => imageListener.close())
  const client = await RawClient.open(imageListener.socketPath)
  try {
    initialize(client, 1)
    const init = (await client.next()) as {
      result?: { agentCapabilities: { promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean } } }
    }
    assert.equal(init.result?.agentCapabilities.promptCapabilities.image, true)
    assert.equal(init.result?.agentCapabilities.promptCapabilities.audio, false)
    assert.equal(init.result?.agentCapabilities.promptCapabilities.embeddedContext, false)
  } finally {
    client.close()
  }

  const noStoreFake = makeFakeAccess({ supportsImagePrompts: () => Promise.resolve(true) })
  const noStoreScope = newScope(t).scope
  const noStoreListener = await startLocalAcpListener({ scope: noStoreScope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: noStoreFake.access })
  t.after(() => noStoreListener.close())
  const noStoreClient = await RawClient.open(noStoreListener.socketPath)
  try {
    initialize(noStoreClient, 1)
    const init = (await noStoreClient.next()) as { result?: { agentCapabilities: { promptCapabilities: { image: boolean } } } }
    assert.equal(init.result?.agentCapabilities.promptCapabilities.image, false, 'no image store means no image capability')
  } finally {
    noStoreClient.close()
  }
})

test('pipelined Session operations stay uninitialized until asynchronous image capability settles', async t => {
  const { scope } = newScope(t)
  const capability = Promise.withResolvers<boolean>()
  const entered = Promise.withResolvers<void>()
  const fake = makeFakeAccess({
    imageLimits: { maxImageBytes: 64, maxImagesPerMessage: 2, maxMessageImageBytes: 300, mediaTypes: ['image/png'] },
    supportsImagePrompts: () => { entered.resolve(); return capability.promise },
  })
  fake.seed('session-pipeline', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await entered.promise
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-pipeline', cwd: '/host/proj' } })
    const preComplete = (await client.next()) as { id?: number; error?: { data?: { code?: string } } }
    assert.equal(preComplete.id, 2)
    assert.equal(preComplete.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_INITIALIZED',
      'session operations cannot race ahead of the initialize response')
    capability.resolve(true)
    const init = (await client.next()) as { id?: number; result?: { agentCapabilities?: { promptCapabilities?: { image?: boolean } } } }
    assert.equal(init.id, 1)
    assert.equal(init.result?.agentCapabilities?.promptCapabilities?.image, true)
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: 'session-pipeline', cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {},
      'the Session becomes available after capability and initialize response commit')
  } finally {
    client.close()
  }
})

test('an uninitialized sibling keeps the text-only input cap while an image connection stays usable', async t => {
  const { scope } = newScope(t)
  const limits = { maxImageBytes: 64, maxImagesPerMessage: 2, maxMessageImageBytes: 300, mediaTypes: ['image/png'] }
  const fake = makeFakeAccess({ imageLimits: limits, supportsImagePrompts: () => Promise.resolve(true) })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const imageConnection = await RawClient.open(listener.socketPath)
  const textSibling = await RawClient.open(listener.socketPath)
  try {
    initialize(imageConnection, 1)
    const init = (await imageConnection.next()) as { result?: { agentCapabilities: { promptCapabilities: { image: boolean } } } }
    assert.equal(init.result?.agentCapabilities.promptCapabilities.image, true)
    // The sibling never negotiated image: its own frame cap stays at 1 MiB.
    textSibling.sendRaw('{"jsonrpc":"2.0","id":1,"method":"session/list","params":{"x":"')
    textSibling.sendRaw('a'.repeat(1024 * 1024 + 16))
    await expectClose(textSibling)
    // The image connection was not affected by the sibling's breach.
    imageConnection.send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} })
    const reply = (await imageConnection.next()) as { error?: { data?: { code?: string } } }
    assert.equal(reply.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY')
  } finally {
    imageConnection.close()
    textSibling.close()
  }
})

/** One canonical-base64-ish image prompt frame padded to an exact UTF-8 byte length. */
function imagePromptFrame(sessionId: string, contentBytes: number): string {
  const skeleton = JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: '' }] },
  })
  const dataLength = contentBytes - skeleton.length
  assert.ok(dataLength > 0, 'the requested frame is too small for its JSON envelope')
  return JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(dataLength) }] },
  }) + '\n'
}

test('a fragmented image prompt frame above 1 MiB reaches the attached View intact', async t => {
  const { scope } = newScope(t)
  const limits = { maxImageBytes: 2 * 1024 * 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 2 * 1024 * 1024, mediaTypes: ['image/png'] }
  const fake = makeFakeAccess({ imageLimits: limits, supportsImagePrompts: () => Promise.resolve(true) })
  fake.seed('session-image', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    const init = (await client.next()) as { result?: { agentCapabilities: { promptCapabilities: { image: boolean } } } }
    assert.equal(init.result?.agentCapabilities.promptCapabilities.image, true)
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-image', cwd: '/host/proj' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})

    const data = 'A'.repeat(1_200_000)
    const frame = JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: {
        sessionId: 'session-image',
        prompt: [{ type: 'text', text: '前🙂后' }, { type: 'image', mimeType: 'image/png', data }],
      },
    }) + '\n'
    const bytes = Buffer.from(frame, 'utf8')
    assert.ok(bytes.length > 1024 * 1024, 'the frame must cross the legacy 1 MiB cap')
    // Fragments split the JSON envelope, the multi-byte CJK/emoji text and the
    // base64 payload; the reader must forward every UTF-8 byte in order.
    const cuts = [0, 1, 7, 4_093, 65_536, 700_000, 1_200_000, bytes.length]
    for (let index = 1; index < cuts.length; index += 1) {
      client.writeRaw(bytes.subarray(cuts[index - 1], cuts[index]))
    }
    const request = await waitForFact(() => fake.prompts[0], 'the fragmented large image prompt')
    assert.equal(request.content[0]?.type, 'text')
    assert.equal((request.content[0] as { text: string }).text, '前🙂后')
    assert.equal(request.content[1]?.type, 'image')
    assert.equal((request.content[1] as { mediaType: string }).mediaType, 'image/png')
    assert.equal((request.content[1] as { data: string }).data, data)

    const facts = fake.facts()
    const agent = fake.agentOf('session-image')
    assert.ok(facts !== undefined && agent !== undefined)
    const message = { id: 'm-image', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxClaimed(agent, message, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-image', content: [{ type: 'text', text: 'large frame accepted' }] } },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const update = (await client.next()) as { method?: string; params?: { update?: { sessionUpdate?: string } } }
    assert.equal(update.method, 'session/update')
    assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
    const response = (await client.next()) as { id?: number; result?: { stopReason?: string } }
    assert.equal(response.id, 3)
    assert.equal(response.result?.stopReason, 'end_turn')
  } finally {
    client.close()
  }
})

test('several individually bounded frames exceed the per-connection unconsumed budget without harming a UDS sibling', async t => {
  const { dir, scope } = newScope(t)
  const limits = {
    maxImageBytes: 250_000,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 250_000,
    mediaTypes: ['image/png'],
  }
  const bounds = deriveImageInputBounds(limits)
  assert.ok(bounds !== undefined)
  const largerBounds = deriveImageInputBounds({ ...limits, maxImageBytes: 500_000, maxMessageImageBytes: 500_000 })
  assert.ok(largerBounds !== undefined && largerBounds.maxUnconsumedBytes > bounds.maxUnconsumedBytes,
    'the real connection budget is derived from the current Host limits')
  const perFrameBytes = 1_300_000
  assert.ok(perFrameBytes < bounds.maxFrameBytes, 'each queued frame stays under the negotiated per-frame cap')
  assert.ok(2 * (perFrameBytes + 1) > bounds.maxUnconsumedBytes,
    'the combined frames exceed only the total unconsumed cap')
  const frame = (id: number): string => {
    const make = (blob: string): string => JSON.stringify({
      jsonrpc: '2.0', id, method: 'session/list', params: { blob },
    })
    const emptyLength = Buffer.byteLength(make(''))
    const payload = make('x'.repeat(perFrameBytes - emptyLength))
    assert.equal(Buffer.byteLength(payload), perFrameBytes)
    return `${payload}\n`
  }

  // The bounded-input contract is platform-neutral; only the raw bind address
  // differs: Linux shortens the test dir through /proc/self/fd, Darwin binds a
  // short name inside the test scope's own endpoint root.
  let dirFd: number | undefined
  let socketPath: string
  if (IS_DARWIN) {
    socketPath = join(darwinAcpSocketPaths(scope, process.getuid?.() as number).privateRoot, 'bounded-input.sock')
  } else {
    dirFd = openSync(dir, 'r')
    socketPath = `/proc/self/fd/${String(dirFd)}/bounded-input.sock`
  }
  const failed = Promise.withResolvers<string>()
  const peers: Array<{ readonly socket: import('node:net').Socket; readonly reader?: ReadableStreamDefaultReader<Uint8Array> }> = []
  const server = createServer((socket) => {
    const input = createBoundedInput(socket, { inputBounds: bounds } as never, code => {
      failed.resolve(code)
      socket.destroy()
    })
    peers.push({ socket, ...(peers.length === 1 ? { reader: input.getReader() } : {}) })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(socketPath, resolveListen)
  })
  const victim = await RawClient.open(socketPath)
  const healthy = await RawClient.open(socketPath)
  try {
    await waitForFact(() => peers.length === 2 ? peers : undefined, 'both bounded-input UDS peers')
    assert.equal(peers.length, 2, 'both test clients are accepted by the real Unix socket server')
    const healthyPeer = peers[1]!
    assert.ok(healthyPeer.reader !== undefined)
    const healthyRead = healthyPeer.reader.read()
    const smallFrame = '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"healthy"}}\n'
    healthy.sendRaw(smallFrame)
    const firstHealthy = await withTimeout(healthyRead, 5_000, 'healthy UDS input frame')
    assert.deepEqual(Buffer.from(firstHealthy.value!), Buffer.from(smallFrame), 'the sibling consumes its exact wire bytes')

    // The victim stream intentionally has no reader yet: the producer/consumer
    // gap is the real bounded-input backpressure state being qualified.
    victim.sendRaw(frame(10) + frame(11))
    const code = await withTimeout(failed.promise, 5_000, 'aggregate unconsumed input overflow')
    assert.equal(code, 'LOCAL_ACP_INPUT_OVERFLOW', 'neither complete frame crosses its own bound')
    await withTimeout(victim.closed, 5_000, 'victim socket closes on only its aggregate overflow')

    const healthyNext = healthyPeer.reader.read()
    healthy.sendRaw(smallFrame)
    const secondHealthy = await withTimeout(healthyNext, 5_000, 'healthy sibling remains readable')
    assert.deepEqual(Buffer.from(secondHealthy.value!), Buffer.from(smallFrame))
    const healthyAgain = healthyPeer.reader.read()
    healthy.sendRaw(smallFrame)
    const thirdHealthy = await withTimeout(healthyAgain, 5_000, 'healthy sibling remains open after victim overflow')
    assert.deepEqual(Buffer.from(thirdHealthy.value!), Buffer.from(smallFrame))
  } finally {
    victim.close()
    healthy.close()
    for (const peer of peers) peer.reader?.releaseLock()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    if (dirFd !== undefined) closeSync(dirFd)
  }
})

test('the derived frame budget accepts exactly its bound and rejects one byte above', async t => {
  const { scope } = newScope(t)
  const limits: AcpImageLimits = {
    maxImageBytes: 64,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 3,
    mediaTypes: ['image/png'],
  }
  const bounds = deriveImageInputBounds(limits)
  assert.ok(bounds !== undefined)
  const fake = makeFakeAccess({ imageLimits: limits, supportsImagePrompts: () => Promise.resolve(true) })
  fake.seed('session-at', '/host/proj')
  fake.seed('session-above', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())

  const accepted = await RawClient.open(listener.socketPath)
  const rejected = await RawClient.open(listener.socketPath)
  try {
    initialize(accepted, 1)
    await accepted.next()
    initialize(rejected, 1)
    await rejected.next()
    accepted.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-at', cwd: '/host/proj' } })
    assert.deepEqual(((await accepted.next()) as { result?: unknown }).result, {})
    rejected.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-above', cwd: '/host/proj' } })
    assert.deepEqual(((await rejected.next()) as { result?: unknown }).result, {})

    accepted.sendRaw(imagePromptFrame('session-at', bounds.maxFrameBytes))
    const request = await waitForFact(() => fake.prompts[0], 'the at-bound image prompt')
    assert.equal(request.sessionId, 'session-at')
    rejected.sendRaw(imagePromptFrame('session-above', bounds.maxFrameBytes + 1))
    await expectClose(rejected)
    accepted.send({ jsonrpc: '2.0', id: 4, method: 'session/list', params: {} })
    const reply = (await accepted.next()) as { error?: { data?: { code?: string } } }
    assert.equal(reply.error?.data?.code, 'LOCAL_ACP_SESSION_NOT_READY', 'the accepted connection stays healthy')
  } finally {
    accepted.close()
    rejected.close()
  }
})

test('PO-4C C-L5-01: committed output images are delivered even when the connection never negotiated image PROMPTS', async t => {
  const { scope } = newScope(t)
  const imageBytes = Uint8Array.from({ length: 4096 }, (_value, index) => index % 251)
  const fake = makeFakeAccess({
    // No image prompt capability at all: no limits, no model modality.
    supportsImagePrompts: () => Promise.resolve(false),
    readOutputImage: async ref => {
      assert.equal(ref.attachmentId, 'sha256:out-1')
      return { data: imageBytes, mediaType: 'image/png' }
    },
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    const init = (await client.next()) as { result?: { agentCapabilities?: { promptCapabilities?: { image?: boolean } } } }
    assert.equal(init.result?.agentCapabilities?.promptCapabilities?.image, false, 'the connection did not negotiate image prompts')
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await client.next()) as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId as string
    assert.equal(typeof sessionId, 'string')

    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'draw' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the Host prompt request')
    const agent = fake.agentOf(sessionId)
    assert.ok(agent !== undefined)
    const facts = fake.facts()
    assert.ok(facts !== undefined)
    const message = { id: 'm-output-image', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxClaimed(agent, message, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: {
          id: 'm-output-image',
          content: [{
            type: 'image',
            attachment: { attachmentId: 'sha256:out-1', mediaType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 },
          }],
        },
      },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    const update = (await client.next()) as {
      method?: string
      params?: { sessionId?: string; update?: { sessionUpdate?: string; messageId?: string; content?: unknown } }
    }
    assert.equal(update.method, 'session/update')
    assert.equal(update.params?.sessionId, sessionId)
    assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
    assert.deepEqual(update.params?.update?.content, {
      type: 'image',
      data: Buffer.from(imageBytes).toString('base64'),
      mimeType: 'image/png',
    })
    const response = (await client.next()) as { id?: number; result?: { stopReason?: string }; error?: unknown }
    assert.equal(response.id, 3)
    assert.equal(response.error, undefined)
    assert.equal(response.result?.stopReason, 'end_turn', 'an image-only committed answer is a real end_turn')
  } finally {
    client.close()
  }
})

test('PO-4C C-L5-02: a derived outbound budget carries one complete ACP image frame above the legacy 256 KiB cap', async t => {
  const limits = { maxImageBytes: 400_000, maxImagesPerMessage: 2, maxMessageImageBytes: 400_000, mediaTypes: ['image/png'] }
  assert.equal(deriveImageOutputBounds(undefined), undefined, 'no Store keeps the legacy frame budget')
  assert.equal(deriveImageOutputBounds({
    maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 3, mediaTypes: ['image/png'],
  }), 4 + 65_536 + 4_096 + 1024 * 1024, 'the derived budget keeps the bounded metadata/envelope/text allowances')
  // Each image is Base64-encoded on its own, so the batch ceiling sums the
  // per-image ceilings (3 * 4*ceil(10/3) = 48) instead of one ceiling of the
  // summed byte count (which would be 40 and understate the wire bytes).
  assert.equal(deriveImageOutputBounds({
    maxImageBytes: 10, maxImagesPerMessage: 3, maxMessageImageBytes: 3, mediaTypes: ['image/png'],
  }), 3 * (4 * 4) + 3 * 65_536 + 4_096 + 1024 * 1024, 'the per-image encoded ceilings sum exactly')
  const derived = deriveImageOutputBounds(limits)
  assert.equal(derived, 2 * (4 * Math.ceil(400_000 / 3)) + 2 * 65_536 + 4_096 + 1024 * 1024,
    'the derived budget is the per-image canonical Base64 ceiling sum plus bounded metadata, envelope and text allowance')
  // A prompt-batch limit is NOT part of the outbound budget: an output image is
  // bounded by the Store's per-object admission ceiling instead.
  assert.equal(deriveImageOutputBounds({
    maxImageBytes: 400_000, maxImagesPerMessage: 2, maxMessageImageBytes: 1, mediaTypes: ['image/png'],
  }), derived, 'maxMessageImageBytes never narrows the outbound allowance')
  for (const unsafe of [
    { maxImageBytes: 0, maxImagesPerMessage: 1, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
    { maxImageBytes: 1, maxImagesPerMessage: 0, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
    { maxImageBytes: -1, maxImagesPerMessage: 1, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
    { maxImageBytes: 1, maxImagesPerMessage: Number.MAX_SAFE_INTEGER, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
    { maxImageBytes: Number.MAX_SAFE_INTEGER, maxImagesPerMessage: Number.MAX_SAFE_INTEGER, maxMessageImageBytes: 3, mediaTypes: ['image/png'] },
  ]) {
    assert.equal(deriveImageOutputBounds(unsafe), undefined, 'unsafe arithmetic cannot derive a frame budget')
  }

  const { scope } = newScope(t)
  // 300_000 stored bytes -> ~400 KiB of canonical Base64 in ONE frame.
  const imageBytes = Uint8Array.from({ length: 300_000 }, (_value, index) => (index * 7) % 251)
  const fake = makeFakeAccess({
    imageLimits: limits,
    readOutputImage: async () => ({ data: imageBytes, mediaType: 'image/png' }),
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await client.next()) as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId as string
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'big' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the Host prompt request')
    const agent = fake.agentOf(sessionId)
    assert.ok(agent !== undefined)
    const facts = fake.facts()
    assert.ok(facts !== undefined)
    const message = { id: 'm-big-image', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxClaimed(agent, message, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: {
          id: 'm-big-image',
          content: [{
            type: 'image',
            attachment: { attachmentId: 'sha256:big', mediaType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 },
          }],
        },
      },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    const update = (await client.next(30_000)) as {
      method?: string
      params?: { update?: { content?: { type?: string; data?: string; mimeType?: string } } }
    }
    assert.equal(update.method, 'session/update')
    const content = update.params?.update?.content
    assert.equal(content?.type, 'image')
    assert.equal(content?.mimeType, 'image/png')
    const received = Buffer.from(content?.data ?? '', 'base64')
    assert.deepEqual(received, Buffer.from(imageBytes), 'the complete Base64 payload decodes to the exact stored bytes')
    const frameBytes = Buffer.byteLength(`${JSON.stringify(update)}\n`, 'utf8')
    assert.ok(frameBytes > 256 * 1024, `the delivered ACP frame must exceed the legacy 256 KiB cap (got ${String(frameBytes)})`)
    assert.ok(frameBytes <= derived, 'the frame fits the derived outbound budget')
    const response = (await client.next()) as { id?: number; result?: { stopReason?: string } }
    assert.equal(response.id, 3)
    assert.equal(response.result?.stopReason, 'end_turn')
  } finally {
    client.close()
  }
})

test('PO-4C C-L5-02: a frame above the derived budget closes only that connection before any frame byte is written', async t => {
  const { scope } = newScope(t)
  const recorded = recordingDiag()
  // 1.2 MiB stored -> ~1.6 MiB Base64, above the small derived budget below.
  const limits = { maxImageBytes: 400_000, maxImagesPerMessage: 1, maxMessageImageBytes: 300_000, mediaTypes: ['image/png'] }
  // The verified stored object here is larger than the seam's per-object
  // admission ceiling: the official normalization may keep its smallest ladder
  // output above the target (the accepted upstream limitation), so the frame
  // budget must still fail closed instead of truncating or guessing.
  const imageBytes = Uint8Array.from({ length: 2_000_000 }, (_value, index) => (index * 3) % 251)
  const fake = makeFakeAccess({
    imageLimits: limits,
    readOutputImage: async () => ({ data: imageBytes, mediaType: 'image/png' }),
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: recorded.diag, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await client.next()) as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId as string
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'too big' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'the Host prompt request')
    const agent = fake.agentOf(sessionId)
    assert.ok(agent !== undefined)
    const facts = fake.facts()
    assert.ok(facts !== undefined)
    const message = { id: 'm-too-big', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxClaimed(agent, message, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: {
          id: 'm-too-big',
          content: [{
            type: 'image',
            attachment: { attachmentId: 'sha256:too-big', mediaType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 },
          }],
        },
      },
    })
    facts.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await withTimeout(client.closed, 20_000, 'the over-budget frame must close its own connection')
    assert.ok(recorded.warnings.some(warning => warning.code === 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE'),
      `the over-budget frame keeps its own class; saw ${JSON.stringify(recorded.warnings.map(warning => warning.code))}`)
    assert.equal(JSON.stringify(client.getLastFailure?.() ?? null).includes('too-big'), false)
  } finally {
    client.close()
  }
})

test('PO-4C C-L5-03: a slow reader is closed by the bounded chunked drain while a sibling keeps working', async t => {
  // The drain deadline is the ONE timer this test drives: the mocked clock
  // proves the writer really waited for kernel drain instead of rejecting on
  // the frame cap, so every wait below uses immediate event-loop turns.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  const waitForImmediate = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    for (let attempt = 0; attempt < 50_000; attempt += 1) {
      const value = read()
      if (value !== undefined) return value
      await new Promise<void>(resolveTick => setImmediate(resolveTick))
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const { scope } = newScope(t)
  const recorded = recordingDiag()
  const limits = { maxImageBytes: 2 * 1024 * 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 8 * 1024 * 1024, mediaTypes: ['image/png'] }
  // ~900 KiB of stored bytes -> ~1.2 MiB of canonical Base64 in ONE frame,
  // above every kernel send buffer so the writer really blocks on drain.
  const imageBytes = Uint8Array.from({ length: 900_000 }, (_value, index) => (index * 11) % 251)
  const fake = makeFakeAccess({
    imageLimits: limits,
    readOutputImage: async () => ({ data: imageBytes, mediaType: 'image/png' }),
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: recorded.diag, sessionAccess: fake.access })
  t.after(() => listener.close())
  const victim = await RawClient.open(listener.socketPath)
  const healthy = await RawClient.open(listener.socketPath)
  try {
    initialize(victim, 1)
    await victim.next()
    initialize(healthy, 1)
    await healthy.next()
    victim.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await victim.next()) as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId as string
    victim.pause()
    victim.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'stall' }] } })
    const request = await waitForImmediate(() => fake.prompts[0], 'the Host prompt request')
    const agent = fake.agentOf(sessionId)
    assert.ok(agent !== undefined)
    const facts = fake.facts()
    assert.ok(facts !== undefined)
    const message = { id: 'm-stall', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agent, message)
    facts.onInboxClaimed(agent, message, 1)
    facts.onSessionEvent(agent.session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: {
          id: 'm-stall',
          content: [{
            type: 'image',
            attachment: { attachmentId: 'sha256:stall', mediaType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 },
          }],
        },
      },
    })
    // Advance the mocked clock only after real event-loop turns: once the
    // chunked writer is waiting on the kernel drain, its 30s deadline closes
    // ONLY this connection and nothing here ever waits on an unmocked sleep.
    const sawBackpressure = (): boolean => recorded.warnings.some(warning => warning.code === 'LOCAL_ACP_OUTPUT_BACKPRESSURE')
    for (let attempt = 0; attempt < 400 && !sawBackpressure(); attempt += 1) {
      await new Promise<void>(resolveTick => setImmediate(resolveTick))
      t.mock.timers.tick(30_000)
    }
    assert.equal(sawBackpressure(), true, 'the bounded drain closed the slow reader with the existing backpressure class')
    // A paused reader only observes its peer's close once it reads again.
    t.mock.timers.reset()
    victim.resume()
    await withTimeout(victim.closed, 10_000, 'the dead slow-reader connection is observed by its client')
    // The sibling connection is entirely unaffected.
    healthy.send({ jsonrpc: '2.0', id: 9, method: 'session/list', params: {} })
    const siblingResponse = (await healthy.next()) as { id?: number; error?: { code?: number } }
    assert.equal(siblingResponse.id, 9)
    assert.equal(siblingResponse.error?.code, -32042)
  } finally {
    victim.close()
    healthy.close()
  }
})
