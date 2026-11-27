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
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { closeSync, openSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type SessionConfigOption } from '@agentclientprotocol/sdk'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { type LocalScope } from '../../src/app/remote-process/local-scope.ts'
import {
  createBoundedInput,
  createBoundedOutput,
  createReplyDebtStream,
  darwinAcpSocketPaths,
  deriveImageInputBounds,
  LocalAcpError,
  parseAcpMaxConnections,
  startLocalAcpListener,
  type LocalAcpListener,
  deriveImageOutputBounds,
} from '../../src/app/remote-process/local-acp-listener.ts'
import {
  AcpSessionPolicyError,
  type AcpSessionPolicyRequest,
  type AcpSessionPolicyState,
} from '../../src/app/remote-process/local-acp-session-policy.ts'
import {
  AcpSessionViewRegistry,
  LocalAcpViewError,
  type AcpContinuedAnswerOutcome,
  type AcpCreateSessionOutcome,
  type AcpImageLimits,
  type AcpQuestionAnswer,
  type AcpQuestionSnapshot,
  type AcpPromptFactListener,
  type AcpSessionPromptRequest,
  type AcpStoredFileRef,
  type AcpStoredImage,
  type AcpStoredImageRef,
  type HostAcpSessionAccess,
  type LiveAgentViewIdentity,
} from '../../src/app/remote-process/local-acp-session-view.ts'
import type {
  AcpHistoryHeader,
  AcpSessionHistory,
  AcpSessionReadRow,
} from '../../src/app/remote-process/local-acp-projections.ts'
import {
  EMPTY_COMMAND_CATALOG,
  type AcpCommandCatalogRead,
  type AcpNativeSkillCatalog,
} from '../../src/app/remote-process/local-acp-commands.ts'
import type { AcpModelCurrentness, AcpModelOptionRequest } from '../../src/app/remote-process/local-acp-model-selection.ts'
import type { AcpScopedMcpCurrentness, AcpScopedMcpLease } from '../../src/app/remote-process/local-acp-scoped-mcp.ts'
import { AcpModelError } from '../../src/app/remote-process/local-acp-model-selection.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const QUIET_DIAG: Diag = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  dispose: () => {},
}

/** A diag that records warn codes so a bound-breach test can name the exact cap. */
function recordingDiag(): {
  diag: Diag
  warnings: Array<{ code?: string; reason?: string; limit?: number; observedCount?: number }>
} {
  const warnings: Array<{ code?: string; reason?: string; limit?: number; observedCount?: number }> = []
  const diag: Diag = {
    debug: () => {},
    info: () => {},
    warn: (_message: string, fields?: Record<string, unknown>) => {
      warnings.push({
        code: typeof fields?.code === 'string' ? fields.code : undefined,
        reason: typeof fields?.reason === 'string' ? fields.reason : undefined,
        limit: typeof fields?.limit === 'number' ? fields.limit : undefined,
        observedCount: typeof fields?.observedCount === 'number' ? fields.observedCount : undefined,
      })
    },
    error: () => {},
    dispose: () => {},
  }
  return { diag, warnings }
}

/** One raw NDJSON JSON-RPC client over a real UDS connection. */
/** Whether one raw JSON-RPC message is the standard command catalog update. */
function isAvailableCommandsUpdate(message: unknown): boolean {
  const update = (message as { readonly params?: { readonly update?: { readonly sessionUpdate?: unknown } } } | null)
    ?.params?.update
  return update?.sessionUpdate === 'available_commands_update'
}

class RawClient {
  private readonly socket: ReturnType<typeof connect>
  private buffer = ''
  private readonly queue: unknown[] = []
  private readonly catalog: unknown[] = []
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
        // Every attached View now receives the baseline command catalog. It is
        // an independent standard notification; keep it observable through the
        // dedicated queue so historical request/update assertions stay exact.
        if (isAvailableCommandsUpdate(message)) {
          this.catalog.push(message)
          continue
        }
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

  /** Read the catalog notifications this connection actually received. */
  catalogMessages(): readonly unknown[] {
    return [...this.catalog]
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
    let bindStat: ReturnType<typeof lstatSync> | undefined
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(paths.privateBindPath, () => { server.off('error', rejectListen); resolveListen() })
      })
      bindStat = lstatSync(paths.privateBindPath)
      chmodSync(paths.privateBindPath, 0o600)
      linkSync(paths.privateBindPath, paths.publicPath)
      unlinkSync(paths.privateBindPath)
      return { close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())) }
    } catch (error) {
      // A failed listen never bound this name, so the catch must NOT unlink it;
      // after a successful bind the server close owns the private name, and any
      // extra removal is limited to the exact (dev,ino,uid) this helper published.
      if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      if (bindStat !== undefined) {
        for (const path of [paths.privateBindPath, paths.publicPath]) {
          if (!pathExists(path)) continue
          try {
            const current = lstatSync(path)
            if (current.dev === bindStat.dev && current.ino === bindStat.ino && current.uid === bindStat.uid) unlinkSync(path)
          } catch { /* gone or unreadable: never guess */ }
        }
      }
      throw error
    }
  }
  const dirFd = openSync(scope.dir, 'r')
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(`/proc/self/fd/${String(dirFd)}/acp.sock`, () => { server.off('error', rejectListen); resolveListen() })
    })
  } catch (error) {
    closeSync(dirFd)
    throw error
  }
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

function initialize(
  client: RawClient,
  id: number,
  protocolVersion = 1,
  clientCapabilities: Record<string, unknown> = {},
): void {
  client.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, clientCapabilities } })
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
      result?: {
        protocolVersion: number
        agentInfo: { name: string; version: string }
        authMethods: unknown[]
        agentCapabilities: {
          loadSession: boolean
          mcpCapabilities: { http: boolean; sse: boolean }
          sessionCapabilities: Record<string, unknown>
        }
      }
    }
    assert.equal(response.id, 1)
    assert.equal(response.result?.protocolVersion, 1)
    assert.equal(response.result?.agentInfo.name, 'dsh-pi-tui')
    assert.equal(response.result?.agentInfo.version, '9.9.9-test')
    assert.deepEqual(response.result?.authMethods, [])
    assert.equal(response.result?.agentCapabilities.loadSession, false)
    assert.deepEqual(response.result?.agentCapabilities.mcpCapabilities, { http: false, sse: false },
      'a listener with no Host Session View must not advertise HTTP MCP')
    assert.deepEqual(response.result?.agentCapabilities.sessionCapabilities, {},
      'a listener with no Host Session View must not advertise resume/close')
  } finally {
    client.close()
  }
  await listener.close()
  assert.ok(!pathExists(listener.socketPath), 'a graceful close must retire the socket path')
})

test('initialize advertises embeddedContext only when the real Host file seam is complete', async t => {
  for (const [fileInput, expected] of [[true, true], [false, false]] as const) {
    const { scope } = newScope(t)
    const fake = makeFakeAccess({ fileInput })
    const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
    t.after(() => listener.close())
    const client = await RawClient.open(listener.socketPath)
    try {
      initialize(client, 1)
      const init = (await client.next()) as {
        result?: { agentCapabilities: { promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean } } }
      }
      assert.equal(init.result?.agentCapabilities.promptCapabilities.embeddedContext, expected)
      assert.equal(init.result?.agentCapabilities.promptCapabilities.audio, false)
    } finally {
      client.close()
    }
    await listener.close()
  }
})

test('an image-widened raw frame never widens the legacy embedded-resource budget', async t => {
  const { scope } = newScope(t)
  const limits = {
    maxImageBytes: 2 * 1024 * 1024,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 2 * 1024 * 1024,
    mediaTypes: ['image/png'],
  }
  const fake = makeFakeAccess({ fileInput: true, imageLimits: limits, supportsImagePrompts: () => Promise.resolve(true) })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    const init = (await client.next()) as { result?: { agentCapabilities: { promptCapabilities: { image: boolean; embeddedContext: boolean } } } }
    assert.equal(init.result?.agentCapabilities.promptCapabilities.image, true)
    assert.equal(init.result?.agentCapabilities.promptCapabilities.embeddedContext, true)
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host', mcpServers: [] } })
    const created = (await client.next()) as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId as string
    assert.equal(typeof sessionId, 'string')
    const huge = 'x'.repeat(1024 * 1024 + 64)
    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'use this context' },
          { type: 'resource', resource: { uri: 'file:///huge.txt', text: huge } },
        ],
      },
    })
    const rejected = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(rejected.error?.code, -32602, 'the resource budget rejection is a business invalid-params error')
    assert.equal(rejected.error?.data?.code, 'LOCAL_ACP_PROMPT_INVALID_CONTENT')
    assert.equal(fake.prompts.length, 0, 'the oversized resource never reaches the Controller')
    const sibling = await RawClient.open(listener.socketPath)
    try {
      initialize(sibling, 1)
      const siblingInit = (await sibling.next()) as { result?: { protocolVersion: number } }
      assert.equal(siblingInit.result?.protocolVersion, 1, 'the sibling connection stays healthy')
    } finally {
      sibling.close()
    }
  } finally {
    client.close()
  }
  await listener.close()
})

test('initialize advertises the client system prompt append only for the real scoped seam, and a valid append reaches the exact Agent', async t => {
  for (const [seam, expected] of [[true, true], [false, false]] as const) {
    const { scope } = newScope(t)
    const fake = makeFakeAccess({ systemPromptAppend: seam })
    const agent = fake.seed('session-system-prompt', '/host')
    const registry = new AcpSessionViewRegistry(QUIET_DIAG)
    const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access, views: registry })
    t.after(() => listener.close())
    const client = await RawClient.open(listener.socketPath)
    try {
      initialize(client, 1)
      const init = (await client.next()) as {
        result?: { agentCapabilities: { sessionCapabilities: Record<string, unknown> } }
      }
      const capability = init.result?.agentCapabilities.sessionCapabilities.systemPrompt
      assert.equal(capability !== undefined, expected,
        seam
          ? 'a real scoped append seam must advertise the systemPrompt capability'
          : 'a Host without the scoped append seam must not advertise it')
      if (seam) assert.deepEqual(capability, {}, 'append mode is advertised, override is never offered')
      client.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/resume',
        params: {
          sessionId: 'session-system-prompt',
          cwd: '/host',
          systemPrompt: {
            mode: 'append',
            content: [{ type: 'text', text: 'LISTENER_APPEND' }, { type: 'text', text: '{{literal}}' }],
          },
        },
      })
      const reply = (await client.next()) as { result?: unknown; error?: { code: number; data?: { code?: string } } }
      if (seam) {
        assert.deepEqual(reply.result, {})
        assert.equal(fake.systemPromptAppendRegistrations.length, 1)
        const registration = fake.systemPromptAppendRegistrations[0]
        assert.equal(registration?.agent, agent, 'the seam must receive the exact borrowed Agent')
        assert.equal(registration?.session, agent.session, 'the seam must receive the exact borrowed Session')
        assert.equal(registration?.text, 'LISTENER_APPEND\n\n{{literal}}',
          'the listener must forward the literal two-newline normalized append')
        assert.equal(registration?.stillCurrent(), true, 'the committed View provider gate is live')
        client.send({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: 'session-system-prompt' } })
        assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
        assert.equal(registration?.disposeCalls, 1, 'the real close boundary must run the exact disposer')
        assert.equal(registration?.stillCurrent(), false, 'the provider gate must fail closed before release')
      } else {
        assert.equal(reply.error?.code, -32602)
        assert.equal(reply.error?.data?.code, 'LOCAL_ACP_VIEW_INVALID_REQUEST')
        assert.equal(fake.systemPromptAppendRegistrations.length, 0)
        assert.equal(registry.hasClaim('session-system-prompt'), false)
      }
    } finally {
      client.close()
    }
    await listener.close()
  }
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

test('unsupported Session methods are refused by the initialize gate before the handshake and fail closed after it', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    const cases = [
      { id: 10, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } },
      { id: 11, method: 'session/resume', params: { sessionId: 's', cwd: '/tmp' } },
      { id: 12, method: 'session/close', params: { sessionId: 's' } },
      { id: 13, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] } },
      { id: 14, method: 'session/list', params: {} },
      { id: 15, method: 'session/set_config_option', params: { sessionId: 's', configId: 'c', value: 'v' } },
    ]
    // Before initialize every registered Session request is JSON-RPC Invalid
    // Request, refused by the SDK connection gate before any handler runs.
    for (const call of cases) {
      client.send({ jsonrpc: '2.0', ...call })
      const early = (await client.next()) as { id: number; error?: { code: number; message?: string; data?: unknown } }
      assert.equal(early.id, call.id)
      assert.equal(early.error?.code, -32600, `${call.method} must be invalid before initialize`)
      assert.match(early.error?.message ?? '', new RegExp(`must be initialized before '${call.method.replaceAll('/', '\\/')}'`, 'u'))
      assert.equal(early.error?.data, undefined, `${call.method} carries no product diagnostic data before the handshake`)
    }

    initialize(client, 20)
    await client.next()

    // After the handshake the same raw fallback keeps its original -32042
    // business classification; B3 only changed the pre-init protocol error.
    for (const call of cases) {
      client.send({ jsonrpc: '2.0', ...call, id: call.id + 100 })
      const response = (await client.next()) as { id: number; error?: { code: number; data?: { code?: string } } }
      assert.equal(response.id, call.id + 100)
      assert.equal(response.error?.code, -32042, `${call.method} must keep its post-init fail-closed code`)
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

test('initialize negotiates every valid v1-schema version to protocol 1 and keeps handshakes connection-scoped', async t => {
  const { scope } = newScope(t)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG })
  t.after(() => listener.close())
  const two = await RawClient.open(listener.socketPath)
  const max = await RawClient.open(listener.socketPath)
  const malformedType = await RawClient.open(listener.socketPath)
  const malformedMissing = await RawClient.open(listener.socketPath)
  type InitResponse = {
    id: number
    error?: { code: number; data?: { code?: string } }
    result?: {
      protocolVersion: number
      agentInfo: { name: string; title?: string; version: string }
      authMethods: unknown[]
    }
  }
  try {
    initialize(two, 1, 2)
    initialize(max, 1, 65535)
    const [responseTwo, responseMax] = await Promise.all([two.next(), max.next()]) as [InitResponse, InitResponse]
    for (const response of [responseTwo, responseMax]) {
      assert.equal(response.id, 1)
      assert.equal(response.error, undefined, 'a valid non-v1 request version must not be an error')
      assert.equal(response.result?.protocolVersion, 1)
      assert.equal(response.result?.agentInfo.name, 'dsh-pi-tui')
      assert.equal(response.result?.agentInfo.title, 'dsh-pi-tui')
      assert.equal(response.result?.agentInfo.version, '9.9.9-test')
      assert.deepEqual(response.result?.authMethods, [])
    }

    // A duplicate initialize on ONE connection is rejected while the sibling's
    // handshake remains independent.
    initialize(two, 2, 1)
    const duplicate = (await two.next()) as InitResponse
    assert.equal(duplicate.error?.code, -32043)
    assert.equal(duplicate.error?.data?.code, 'LOCAL_ACP_ALREADY_INITIALIZED')

    // The SDK schema remains the parser authority: a legal integer is handled
    // by this listener, while a non-integer or missing protocolVersion is an
    // invalid-params request before the handler runs.
    malformedType.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1', clientCapabilities: {} } })
    const typeResponse = (await malformedType.next()) as InitResponse
    assert.equal(typeResponse.error?.code, -32602)
    malformedMissing.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: {} } })
    const missingResponse = (await malformedMissing.next()) as InitResponse
    assert.equal(missingResponse.error?.code, -32602)

    two.close()
    await two.closed
    // The max-version connection is still live after its sibling disconnects.
    max.send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} })
    const stillWorks = (await max.next()) as { id: number; error?: { code: number } }
    assert.equal(stillWorks.id, 2)
    assert.equal(stillWorks.error?.code, -32042)
  } finally {
    two.close()
    max.close()
    malformedType.close()
    malformedMissing.close()
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

test('a connection whose peer stops reading is closed by its own reply-debt bound and never affects a sibling', async t => {
  const { scope } = newScope(t)
  const recorded = recordingDiag()
  const rows: AcpSessionReadRow[] = Array.from({ length: 60 }, (_, index) => ({
    sessionId: `debt-session-${String(index)}`,
    cwd: '/host/proj',
    title: 'x'.repeat(3_000),
    updatedAt: index,
  }))
  const fake = makeFakeAccess({ sessionRead: true, sessionRows: rows })
  const listener = await startLocalAcpListener({
    scope,
    maxConnections: 4,
    diag: recorded.diag,
    sessionAccess: fake.access,
  })
  t.after(() => listener.close())

  const victim = await RawClient.open(listener.socketPath)
  const healthy = await RawClient.open(listener.socketPath)
  try {
    initialize(victim, 1)
    await victim.next()
    initialize(healthy, 1)
    await healthy.next()
    // The victim stops reading entirely. The first response write waits for
    // drain; the following request-producing records therefore accumulate as
    // reply debt. The 41st record is refused before its handler is dispatched.
    victim.pause()
    // The large bounded roster page fills the kernel send queue; keep the
    // finite request stream under the control-lane's four concurrent handlers
    // so these are real list responses, not the tiny lane-refusal frames.
    for (let index = 0; index < 100; index += 1) {
      victim.send({ jsonrpc: '2.0', id: 1_000 + index, method: 'session/list', params: {} })
      if (index % 4 !== 3) continue
      await new Promise<void>(resolveTick => setImmediate(resolveTick))
      if (recorded.warnings.some(warning => warning.code === 'LOCAL_ACP_OUTPUT_BACKPRESSURE')) break
    }
    let pressure = recorded.warnings.find(warning => warning.code === 'LOCAL_ACP_OUTPUT_BACKPRESSURE')
    for (let attempt = 0; attempt < 1_000 && pressure === undefined; attempt += 1) {
      await new Promise<void>(resolveTick => setImmediate(resolveTick))
      pressure = recorded.warnings.find(warning => warning.code === 'LOCAL_ACP_OUTPUT_BACKPRESSURE')
    }
    assert.ok(pressure !== undefined,
      `the slow-consumer connection must close on LOCAL_ACP_OUTPUT_BACKPRESSURE; saw ${JSON.stringify(recorded.warnings)}`)
    assert.equal(pressure.reason, 'reply-debt-limit')
    assert.equal(pressure.limit, 40)
    assert.equal(pressure.observedCount, 40)
    victim.resume()
    await withTimeout(victim.closed, 20_000, 'the slow consumer connection must close on its reply-debt bound')
    // The sibling connection is untouched and still answers.
    healthy.send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} })
    const response = (await healthy.next()) as { id: number; result?: { sessions?: unknown[] } }
    assert.equal(response.id, 2)
    assert.equal(response.result?.sessions?.length, 50, 'the sibling still receives the real bounded roster page')
  } finally {
    victim.close()
    healthy.close()
  }
})

test('a healthy paused reader never trips the output bound: all frames wait, then arrive in order', async t => {
  const { scope } = newScope(t)
  const accepted = Promise.withResolvers<Socket>()
  const server = await bindRawServerAtPublicPath(scope, socket => {
    socket.on('error', () => {})
    accepted.resolve(socket)
  })
  const client = connect(publicSocketPath(scope))
  client.on('error', () => {})
  const received: Buffer[] = []
  let receivedBytes = 0
  client.on('data', (chunk: Buffer) => {
    received.push(chunk)
    receivedBytes += chunk.byteLength
  })
  t.after(async () => {
    client.destroy()
    await server.close()
  })
  await withTimeout(new Promise<void>((resolveConnect, rejectConnect) => {
    client.once('connect', resolveConnect)
    client.once('error', rejectConnect)
  }), 5_000, 'raw healthy reader connects')
  client.pause()
  const serverSocket = await withTimeout(accepted.promise, 5_000, 'raw output server accepts')
  const failCodes: string[] = []
  const writer = createBoundedOutput(serverSocket, code => failCodes.push(code), 2 * 1024 * 1024).getWriter()
  // One legal frame above the legacy 256 KiB frame cap plus a finite burst of
  // sub-cap frames. The real paused Unix-socket peer is the pressure gate.
  const chunks = [
    Buffer.alloc(300 * 1024, 0x62),
    ...Array.from({ length: 127 }, () => Buffer.alloc(100 * 1024, 0x61)),
    Buffer.from('tail\n'),
  ]
  const expectedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  let settled = 0
  const writes = chunks.map(chunk => writer.write(chunk).then(() => { settled += 1 }))
  let pressured = false
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (serverSocket.writableNeedDrain || serverSocket.writableLength > 256 * 1024) {
      pressured = true
      break
    }
    await new Promise<void>(resolveTick => setImmediate(resolveTick))
  }
  assert.equal(pressured, true, 'the real paused reader must produce kernel backpressure before resume')
  assert.ok(settled < writes.length, 'at least one current write must still be pending under pressure')
  assert.deepEqual(failCodes, [], 'a healthy but temporarily slow reader must not be failed')
  client.resume()
  await withTimeout(Promise.all(writes), 20_000, 'the bounded writer drains every frame after resume')
  await writer.close()
  for (let attempt = 0; attempt < 2_000 && receivedBytes < expectedBytes; attempt += 1) {
    await new Promise<void>(resolveTick => setImmediate(resolveTick))
  }
  assert.equal(receivedBytes, expectedBytes, 'every byte arrives after the reader resumes')
  assert.deepEqual(Buffer.concat(received), Buffer.concat(chunks), 'frame bytes and order are preserved')
  assert.deepEqual(failCodes, [], 'the connection is never failed on a healthy drain')
  client.end()
})

test('the public SDK Stream reply-debt owner admits 40 and refuses the 41st before dispatch', async t => {
  let inputController: ReadableStreamDefaultController<Uint8Array> | undefined
  const input = new ReadableStream<Uint8Array>({
    start(controller) { inputController = controller },
  })
  const frames: Array<{ frame: { id?: unknown; method?: unknown; error?: { code?: number }; result?: unknown } }> = []
  let hold = false
  let completedWrites = 0
  const gate = Promise.withResolvers<void>()
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      for (const line of Buffer.from(chunk).toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        frames.push({ frame: JSON.parse(line) as { id?: unknown; method?: unknown } })
      }
      if (hold && frames.at(-1)?.frame.id !== undefined && typeof frames.at(-1)?.frame.id === 'number'
        && (frames.at(-1)?.frame.id as number) >= 1) {
        await gate.promise
      }
      completedWrites += 1
    },
  })
  const app = agent({ name: 'reply-debt-owner' })
  app.onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'reply-debt-owner', version: '0' },
    agentCapabilities: {},
    authMethods: [],
  }))
  app.onRequest('test/echo', params => params, async () => ({ ok: true }))
  let reverseResult: unknown
  app.onRequest('test/reverse', params => params, async ({ client }) => {
    reverseResult = await client.request(methods.client.session.requestPermission, {
      sessionId: 'debt-session',
      toolCall: { toolCallId: 'debt-tool' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    })
    return { ok: true }
  })
  let handlers = 0
  const forty = Promise.withResolvers<void>()
  app.onRequest('test/many', params => params, async () => {
    handlers += 1
    if (handlers === 40) forty.resolve()
    return { ok: true }
  })
  let closed = false
  const failures: Array<{ code: string; detail?: { reason?: string; limit?: number; observedCount?: number } }> = []
  const rawStream = ndJsonStream(output, input)
  const stream = createReplyDebtStream(rawStream, {
    isClosed: () => closed,
    fail: (code, detail) => {
      failures.push({ code, detail })
      closed = true
    },
  })
  const connection = app.connect(stream)
  connection.closed.then(() => { closed = true }, () => { closed = true })
  const send = (message: unknown): void => {
    assert.ok(inputController !== undefined)
    inputController.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`))
  }
  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (predicate()) return
      await new Promise<void>(resolveTick => setImmediate(resolveTick))
    }
    throw new Error(`withTimeout: ${label}`)
  }
  try {
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    await waitFor(() => frames.some(({ frame }) => frame.id === 0), 'initialize response frame')
    await waitFor(() => completedWrites >= 1, 'initialize response write settles')
    // A successful response settles its debt and permits a later admission.
    send({ jsonrpc: '2.0', id: 1, method: 'test/echo', params: {} })
    await waitFor(() => frames.some(({ frame }) => frame.id === 1), 'echo response frame')
    await waitFor(() => completedWrites >= 2, 'echo response write settles')

    // A reverse permission request and its response are not request-producing
    // inbound records: they neither consume nor release a reply credit.
    send({ jsonrpc: '2.0', id: 2, method: 'test/reverse', params: {} })
    await waitFor(() => frames.some(({ frame }) => frame.method === methods.client.session.requestPermission),
      'reverse permission request')
    const reverseFrame = frames.find(({ frame }) => frame.method === methods.client.session.requestPermission)
    assert.ok(reverseFrame?.frame.id !== undefined)
    send({
      jsonrpc: '2.0',
      id: reverseFrame.frame.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    })
    await waitFor(() => frames.some(({ frame }) => frame.id === 2), 'reverse business response')
    assert.deepEqual(reverseResult, { outcome: { outcome: 'selected', optionId: 'allow' } })

    // A direct parser error is written by ndJsonStream itself, bypassing the
    // decoded adapter; it must not release or consume a credit.
    assert.ok(inputController !== undefined)
    inputController.enqueue(new TextEncoder().encode('{not-json\n'))
    send({ jsonrpc: '2.0', id: 3, method: 'test/echo', params: {} })
    await waitFor(() => frames.some(({ frame }) => frame.id === 3), 'echo after direct parser error')
    send({ jsonrpc: '2.0', id: 4, method: 'test/unknown', params: {} })
    await waitFor(() => frames.some(({ frame }) => frame.id === 4), 'unknown method response')
    assert.equal(frames.find(({ frame }) => frame.id === 4)?.frame.error?.code, -32601)

    // Malformed envelopes that are neither an SDK notification nor a
    // response-shaped record are invalid requests: the SDK answers -32600, the
    // decoded adapter must have charged one credit, and the connection must
    // remain usable rather than hitting a debt underflow.
    const invalidCount = (): number => frames.filter(({ frame }) =>
      frame.id === null && frame.error?.code === -32600).length
    const invalidBefore = invalidCount()
    send({ method: 'test/echo' })
    await waitFor(() => invalidCount() === invalidBefore + 1, 'missing jsonrpc invalid record response')
    const afterFirstInvalid = invalidCount()
    send({ jsonrpc: '2.0', id: 7, method: 5 })
    await waitFor(() => invalidCount() === afterFirstInvalid + 1, 'non-string method invalid record response')
    send({ jsonrpc: '2.0', id: 5, method: 'test/echo', params: {} })
    await waitFor(() => frames.some(({ frame }) => frame.id === 5), 'echo after malformed envelopes')
    assert.equal(failures.length, 0)

    hold = true
    for (let id = 100; id < 140; id += 1) {
      send({ jsonrpc: '2.0', id, method: 'test/many', params: {} })
    }
    await withTimeout(forty.promise, 5_000, '40 response-producing records are admitted')
    assert.equal(handlers, 40)
    send({ jsonrpc: '2.0', id: 140, method: 'test/many', params: {} })
    await waitFor(() => failures.length > 0, '41st record is refused')
    assert.equal(failures[0]?.code, 'LOCAL_ACP_OUTPUT_BACKPRESSURE')
    assert.equal(failures[0]?.detail?.reason, 'reply-debt-limit')
    assert.equal(failures[0]?.detail?.limit, 40)
    assert.equal(failures[0]?.detail?.observedCount, 40)
    assert.equal(handlers, 40, 'the refused record must never reach a handler')
    await withTimeout(connection.closed, 5_000, 'debt refusal closes the SDK connection')
    assert.equal(frames.some(({ frame }) => frame.id === 140), false, 'the refused record has no response')
    // The SDK terminal cancels its receive reader but does not close the
    // outer writable. Settle the held write, then observe the public SDK
    // stream locks rather than inferring teardown from connection.closed.
    gate.resolve()
    await waitFor(() => !rawStream.readable.locked && !rawStream.writable.locked,
      'actual SDK terminal releases the public stream reader and writer locks')
  } finally {
    gate.resolve()
    try { connection.close() } catch {}
    try { inputController?.close() } catch {}
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

test('a post-listen publish failure settles the raw server and preserves a foreign public path', async t => {
  const dir = testLifecycle(t).tempDir('acp-scope-')
  const scope = makeScope(dir)
  ownDarwinRoot(t, scope)
  const publicPath = publicSocketPath(scope)
  if (IS_DARWIN) {
    // The private bind/listen succeeds, then the hard-link publication meets a
    // foreign public file: the helper must close its server, settle the private
    // name, and leave the foreign file byte-identical.
    writeFileSync(publicPath, 'FOREIGN-RAW-PUBLISH')
    await assert.rejects(bindRawServerAtPublicPath(scope, socket => socket.destroy()))
    assert.equal(readFileSync(publicPath, 'utf8'), 'FOREIGN-RAW-PUBLISH',
      'the failed publish must not overwrite the foreign public path')
    const paths = darwinAcpSocketPaths(scope, process.getuid?.() as number)
    assert.equal(pathExists(paths.privateBindPath), false, 'the failed publish must settle the private bind name')

    // Failure BEFORE the bind: a live private occupant must keep its inode and
    // remain connectable; this helper never acquired it and must not unlink it.
    const { scope: occupiedScope } = newScope(t)
    const occupiedPaths = darwinAcpSocketPaths(occupiedScope, process.getuid?.() as number)
    mkdirSync(join(occupiedPaths.privateRoot, '.acp-priv'), { recursive: true, mode: 0o700 })
    const occupant = createServer(socket => socket.destroy())
    await new Promise<void>((resolveListen, rejectListen) => {
      occupant.once('error', rejectListen)
      occupant.listen(occupiedPaths.privateBindPath, () => { occupant.off('error', rejectListen); resolveListen() })
    })
    t.after(() => new Promise<void>(resolveClose => occupant.close(() => resolveClose())))
    const occupantInode = lstatSync(occupiedPaths.privateBindPath).ino
    await assert.rejects(bindRawServerAtPublicPath(occupiedScope, socket => socket.destroy()))
    assert.equal(lstatSync(occupiedPaths.privateBindPath).ino, occupantInode,
      'a live private occupant must keep its inode after a failed listen')
    assert.equal(lstatSync(occupiedPaths.privateBindPath).isSocket(), true,
      'a live private occupant must keep its socket name after a failed listen')
    return
  }
  // Linux: a live owner of the logical path makes the helper's /proc-fd listen
  // fail; the helper must close the scope directory fd it opened.
  const blocker = createServer(socket => socket.destroy())
  await new Promise<void>((resolveListen, rejectListen) => {
    blocker.once('error', rejectListen)
    blocker.listen(publicPath, () => { blocker.off('error', rejectListen); resolveListen() })
  })
  const openScopeFds = () => readdirSync('/proc/self/fd').filter(entry => {
    try { return realpathSync(`/proc/self/fd/${entry}`) === realpathSync(dir) } catch { return false }
  })
  const before = openScopeFds().length
  try {
    await assert.rejects(bindRawServerAtPublicPath(scope, socket => socket.destroy()))
    assert.equal(openScopeFds().length, before, 'the failed raw bind must close its scope directory fd')
    // The live path this helper failed to bind must still accept a connection.
    const probe = connect(publicPath)
    await new Promise<void>((resolveConnect, rejectConnect) => {
      probe.once('connect', () => { probe.destroy(); resolveConnect() })
      probe.once('error', rejectConnect)
    })
  } finally {
    await new Promise<void>(resolveClose => blocker.close(() => resolveClose()))
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
  readonly fileInput?: boolean
  readonly systemPromptAppend?: boolean
  readonly imageLimits?: AcpImageLimits
  readonly supportsImagePrompts?: () => Promise<boolean>
  readonly readOutputImage?: (ref: AcpStoredImageRef, signal: AbortSignal) => Promise<AcpStoredImage>
  readonly readOutputFile?: (ref: AcpStoredFileRef, signal: AbortSignal) => AsyncIterable<Uint8Array>
  readonly modelOptions?: (agent: LiveAgentViewIdentity, session: object) => Promise<SessionConfigOption[]>
  readonly selectModelOnly?: (
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpModelOptionRequest,
    signal: AbortSignal,
    stillCurrent: () => AcpModelCurrentness,
  ) => Promise<SessionConfigOption[]>
  readonly sessionPolicy?: (agent: LiveAgentViewIdentity, session: object) => AcpSessionPolicyState
  readonly selectSessionPolicy?: (
    agent: LiveAgentViewIdentity,
    session: object,
    request: AcpSessionPolicyRequest,
    signal: AbortSignal,
    stillCurrent: () => 'current' | 'stale',
  ) => Promise<AcpSessionPolicyState>
  readonly mountScopedMcp?: (
    agent: LiveAgentViewIdentity,
    session: object,
    servers: readonly unknown[],
    stillCurrent: () => AcpScopedMcpCurrentness,
    signal?: AbortSignal,
  ) => Promise<AcpScopedMcpLease | undefined>
  readonly requestRetireScopedMcp?: (lease: AcpScopedMcpLease) => Promise<void>
  readonly questionService?: boolean
  readonly questionSnapshot?: (sessionId: string, agent: LiveAgentViewIdentity, session: object) => AcpQuestionSnapshot
  readonly answerContinued?: (
    sessionId: string,
    agent: LiveAgentViewIdentity,
    session: object,
    callId: string,
    answer: AcpQuestionAnswer,
  ) => AcpContinuedAnswerOutcome
  readonly sessionRead?: boolean
  readonly sessionRows?: readonly AcpSessionReadRow[]
  readonly sessionHistory?: (sessionId: string) => AcpSessionHistory
  readonly sessionHeaderFacts?: (sessionId: string) => AcpHistoryHeader | undefined
  readonly contextPressureValue?: unknown
  readonly sessionTodosValue?: unknown
} = {}): {
  access: HostAcpSessionAccess
  systemPromptAppendRegistrations: Array<{
    readonly agent: LiveAgentViewIdentity
    readonly session: object
    readonly text: string
    readonly stillCurrent: () => boolean
    disposeCalls: number
  }>
  seed: (id: string, cwd: string) => LiveAgentViewIdentity
  agentOf: (id: string) => LiveAgentViewIdentity | undefined
  prompts: AcpSessionPromptRequest[]
  facts: () => AcpPromptFactListener | undefined
  observeCalls: () => number
  removedMessageIds: string[]
  cancelledTurns: Array<{ readonly turn: number; readonly keepInbox: boolean }>
  modelSelections: AcpModelOptionRequest[]
  sessionListReads: () => number
  sessionHistoryReads: () => string[]
  resolveCalls: () => string[]
  turnFence: { openTurnStartSeq: number | null; lastTurn: number }
  staleCancel: { value: boolean }
  pendingInbox: Set<string>
  continuedAnswers: Array<{ readonly callId: string; readonly answer: AcpQuestionAnswer }>
} {
  const agents = new Map<string, { id: string; session: { id: string; header: { cwd: string } } }>()
  const prompts: AcpSessionPromptRequest[] = []
  const modelSelections: AcpModelOptionRequest[] = []
  const removedMessageIds: string[] = []
  const cancelledTurns: Array<{ readonly turn: number; readonly keepInbox: boolean }> = []
  const pendingInbox = new Set<string>()
  const continuedAnswers: Array<{ readonly callId: string; readonly answer: AcpQuestionAnswer }> = []
  const turnFence = { openTurnStartSeq: null as number | null, lastTurn: 0 }
  let facts: AcpPromptFactListener | undefined
  let observeCalls = 0
  const staleCancel = { value: false }
  let counter = 0
  let sessionListReads = 0
  const sessionHistoryReads: string[] = []
  const resolveCalls: string[] = []
  const systemPromptAppendRegistrations: Array<{
    readonly agent: LiveAgentViewIdentity
    readonly session: object
    readonly text: string
    readonly stillCurrent: () => boolean
    disposeCalls: number
  }> = []
  return {
    access: {
      supportsFileInput() {
        return options.fileInput === true
      },
      supportsSystemPromptAppend() {
        return options.systemPromptAppend === true
      },
      registerSystemPromptAppend(agent: LiveAgentViewIdentity, session: object, text: string, stillCurrent: () => boolean) {
        if (options.systemPromptAppend !== true) throw new Error('systemPrompt append is not configured for this listener test')
        const registration = { agent, session, text, stillCurrent, disposeCalls: 0 }
        systemPromptAppendRegistrations.push(registration)
        return { dispose: () => { registration.disposeCalls += 1 } }
      },
      async stageFile() {
        throw new Error('file staging is not configured for this listener test')
      },
      cleanupStagedFiles() {},
      retirePromptReceipts() {},
      hasQuestionService() {
        return options.questionService === true
      },
      questionSnapshot(sessionId: string, agent: LiveAgentViewIdentity, session: object) {
        return options.questionSnapshot === undefined
          ? { kind: 'unavailable' as const }
          : options.questionSnapshot(sessionId, agent, session)
      },
      answerContinued(
        sessionId: string,
        agent: LiveAgentViewIdentity,
        session: object,
        callId: string,
        answer: AcpQuestionAnswer,
      ) {
        if (options.answerContinued === undefined) return { kind: 'unavailable' as const }
        const outcome = options.answerContinued(sessionId, agent, session, callId, answer)
        if (outcome.kind === 'queued') continuedAnswers.push({ callId, answer })
        return outcome
      },
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
        resolveCalls.push(sessionId)
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
      async mountScopedMcp(agent: LiveAgentViewIdentity, session: object, servers: readonly unknown[], stillCurrent: () => AcpScopedMcpCurrentness, signal?: AbortSignal) {
        return options.mountScopedMcp === undefined
          ? undefined
          : await options.mountScopedMcp(agent, session, servers, stillCurrent, signal)
      },
      async requestRetireScopedMcp(lease: AcpScopedMcpLease) {
        if (options.requestRetireScopedMcp !== undefined) await options.requestRetireScopedMcp(lease)
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
      readOutputFile(ref: AcpStoredFileRef, signal: AbortSignal) {
        if (options.readOutputFile === undefined) throw new Error('no attachment store')
        return options.readOutputFile(ref, signal)
      },
      async modelOptions(agent: LiveAgentViewIdentity, session: object) {
        // The real Host omits optional config options when its model catalog is
        // unavailable; keep that default here so existing lifecycle assertions
        // observe the same `{}` resume result.
        if (options.modelOptions === undefined) throw new AcpModelError('LOCAL_ACP_MODEL_UNAVAILABLE', 'no model catalog', -32042)
        return await options.modelOptions(agent, session)
      },
      async selectModelOnly(
        agent: LiveAgentViewIdentity,
        session: object,
        request: AcpModelOptionRequest,
        signal: AbortSignal,
        stillCurrent: () => AcpModelCurrentness,
      ) {
        modelSelections.push(request)
        return options.selectModelOnly === undefined
          ? []
          : await options.selectModelOnly(agent, session, request, signal, stillCurrent)
      },
      readSessionPolicy(agent: LiveAgentViewIdentity, session: object) {
        return options.sessionPolicy?.(agent, session) ?? {}
      },
      readSessionMode(agent: LiveAgentViewIdentity, session: object) {
        return options.sessionPolicy?.(agent, session)?.mode
      },
      async selectSessionPolicy(
        agent: LiveAgentViewIdentity,
        session: object,
        request: AcpSessionPolicyRequest,
        signal: AbortSignal,
        stillCurrent: () => 'current' | 'stale',
      ) {
        if (options.selectSessionPolicy === undefined) return
        await options.selectSessionPolicy(agent, session, request, signal, stillCurrent)
      },
      async prompt(request: AcpSessionPromptRequest) {
        prompts.push(request)
        return { accepted: true as const }
      },
      readCommandCatalog(): AcpCommandCatalogRead {
        return EMPTY_COMMAND_CATALOG
      },
      async readNativeSkills(): Promise<AcpNativeSkillCatalog> {
        return { kind: 'absent' }
      },
      async executeStandaloneCommand() {
        return undefined
      },
      async executeManualCompact() {
        return null
      },
      parseCommand(line: string) {
        return parseCommand(line)
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
      supportsSessionRead() {
        return options.sessionRead === true
      },
      async readSessionList(signal?: AbortSignal) {
        sessionListReads += 1
        signal?.throwIfAborted()
        return options.sessionRows ?? []
      },
      async readSessionHistory(sessionId: string, signal?: AbortSignal) {
        sessionHistoryReads.push(sessionId)
        signal?.throwIfAborted()
        return options.sessionHistory?.(sessionId) ?? { header: { sessionId }, events: [] }
      },
      async sessionHeaderFacts(sessionId: string) {
        return options.sessionHeaderFacts?.(sessionId)
      },
      contextPressure() {
        return options.contextPressureValue
      },
      sessionTodos() {
        return options.sessionTodosValue
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
          onCommandCatalogInvalidated: () => listener.onCommandCatalogInvalidated(),
          onSkillCatalogInvalidated: () => listener.onSkillCatalogInvalidated(),
          onPolicyAvailabilityInvalidated: () => listener.onPolicyAvailabilityInvalidated(),
          onSessionEvent(session, event) {
            if (event.type === 'turn/end' && (event.data as { turn?: number }).turn === turnFence.lastTurn) {
              turnFence.openTurnStartSeq = null
            }
            listener.onSessionEvent(session, event)
          },
          onAgentError: (agent, turn) => listener.onAgentError(agent, turn),
          onAgentDisposed: agent => listener.onAgentDisposed(agent),
          onApprovalRequest: (request, next) => listener.onApprovalRequest(request, next),
          onAssistantStream: (agent, frame) => listener.onAssistantStream(agent, frame),
          onQuestionRequest: (request, next) => listener.onQuestionRequest(request, next),
          onQuestionProjection: (session, key) => listener.onQuestionProjection(session, key),
          onSubagentStart: info => listener.onSubagentStart(info),
          onSubagentEnd: info => listener.onSubagentEnd(info),
        }
        return () => { facts = undefined }
      },
    },
    prompts,
    systemPromptAppendRegistrations,
    facts: () => facts,
    observeCalls: () => observeCalls,
    sessionListReads: () => sessionListReads,
    sessionHistoryReads: () => sessionHistoryReads,
    resolveCalls: () => resolveCalls,
    agentOf: (id: string) => agents.get(id),
    seed: (id: string, cwd: string) => {
      const agent = { id, session: { id, header: { cwd } } }
      agents.set(id, agent)
      return agent
    },
    removedMessageIds,
    cancelledTurns,
    modelSelections,
    pendingInbox,
    continuedAnswers,
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
    // Before initialize the SDK's own connection gate refuses the request, so
    // this product's handler (and its diagnostic data code) never runs.
    client.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/host/x', mcpServers: [] } })
    const pre = (await client.next()) as { error?: { code: number; message?: string; data?: unknown } }
    assert.equal(pre.error?.code, -32600)
    assert.match(pre.error?.message ?? '', /must be initialized before 'session\/new'/u)
    assert.equal(pre.error?.data, undefined)

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

    // ONE physical connection can attach a second Session View. The second
    // session has its own Host Session id and cannot be a duplicate of A.
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const createdB = (await client.next()) as { result?: { sessionId?: string } }
    assert.equal(typeof createdB.result?.sessionId, 'string')
    const sessionB = createdB.result?.sessionId as string
    assert.notEqual(sessionB, sessionId)

    client.send({ jsonrpc: '2.0', id: 5, method: 'session/close', params: { sessionId } })
    const closed = (await client.next()) as { result?: unknown }
    assert.deepEqual(closed.result, {})
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId } })
    const again = (await client.next()) as { result?: unknown }
    assert.deepEqual(again.result, {}, 'a repeated close on the same connection is idempotent')
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/close', params: { sessionId: 'unknown-session' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {},
      'an unknown Session close is an idempotent empty result')

    // A prompt on the closed A View is refused with the standard not-active
    // Session error and the REQUESTED id, and never reaches the Host; the
    // active B View remains a separate claim.
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } })
    const prompt = (await client.next()) as { error?: { code: number; data?: { code?: string; sessionId?: string } } }
    assert.equal(prompt.error?.code, -32002)
    assert.equal(prompt.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    assert.equal(prompt.error?.data?.sessionId, sessionId, 'the refusal carries the requested Session id')
    assert.equal(fake.prompts.length, 0, 'an unattached prompt never reaches the Host')
    client.send({ jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'B remains active' }] } })
    const promptB = await waitForFact(() => fake.prompts[0], 'the B prompt')
    assert.equal(promptB.sessionId, sessionB)
    const facts = fake.facts()
    const agentB = fake.agentOf(sessionB)
    assert.ok(facts !== undefined && agentB !== undefined)
    const messageB = { id: 'm-b', source: { kind: 'user', rpcId: promptB.requestId } }
    facts.onInboxInserted(agentB, messageB)
    fake.turnFence.openTurnStartSeq = 20
    fake.turnFence.lastTurn = 2
    facts.onInboxClaimed(agentB, messageB, 2)
    facts.onSessionEvent(agentB.session, {
      seq: 2,
      type: 'assistant/message',
      data: { turn: 2, message: { id: 'm-b', content: [{ type: 'text', text: 'B answer' }] } },
    })
    facts.onSessionEvent(agentB.session, { seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    let answerB: { id?: number; result?: { stopReason?: string } } | undefined
    for (;;) {
      const message = (await client.next()) as { id?: number; result?: { stopReason?: string } }
      if (message.id === 9) { answerB = message; break }
    }
    assert.equal(answerB.result?.stopReason, 'end_turn')

    // The SAME physical connection may REATTACH its own settled View: the
    // request replaces only this connection's claim generation, borrows the
    // SAME live Host Agent through the one official resolver (no Session
    // create, no second slot) and replays no conversation history on resume.
    const resolvesBefore = fake.resolveCalls().filter(id => id === sessionB).length
    client.send({ jsonrpc: '2.0', id: 10, method: 'session/resume', params: { sessionId: sessionB, cwd: '/host/proj' } })
    let reattached: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await client.next()) as { id?: number; result?: unknown; error?: unknown; method?: string }
      if (frame.method !== undefined) continue
      reattached = frame
      break
    }
    assert.equal(reattached.id, 10)
    assert.equal(reattached.error, undefined, 'a settled same-connection View can be resumed again')
    assert.deepEqual(reattached.result, {}, 'resume answers the standard empty result and replays no history')
    assert.equal(fake.resolveCalls().filter(id => id === sessionB).length, resolvesBefore + 1,
      'the reattach borrows the Agent through the one official resolve')
    assert.equal(fake.agentOf(sessionB), agentB, 'the reattach keeps the exact live Host Agent identity')
    // The refreshed generation is a working View on the SAME Host Session.
    client.send({ jsonrpc: '2.0', id: 11, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'after reattach' }] } })
    const promptAfter = await waitForFact(() => fake.prompts[1], 'the post-reattach prompt')
    assert.equal(promptAfter.sessionId, sessionB, 'the reattached View reaches the same Host Session')
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
    assert.equal(badMcp.error?.data?.code, 'LOCAL_ACP_MCP_INVALID_DECLARATION')

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

test('an unknown or closed Session answers the standard not-active error on every scoped method', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    sessionRead: true,
    sessionHistory: sessionId => ({ header: { sessionId, cwd: '/host/proj' }, events: [] }),
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    // This connection holds no View for the id: prompt/set_mode/set_config
    // answer -32002 with the REQUESTED id and never reach the Host.
    for (const [id, method, params] of [
      [2, 'session/prompt', { sessionId: 'missing', prompt: [{ type: 'text', text: 'x' }] }],
      [3, 'session/set_mode', { sessionId: 'missing', modeId: 'plan' }],
      [4, 'session/set_config_option', { sessionId: 'missing', configId: 'model', value: '["p1","b"]' }],
    ] as const) {
      client.send({ jsonrpc: '2.0', id, method, params })
      const frame = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string; sessionId?: string } } }
      assert.equal(frame.id, id)
      assert.equal(frame.error?.code, -32002, `${method} uses the standard not-active class`)
      assert.equal(frame.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
      assert.equal(frame.error?.data?.sessionId, 'missing')
    }
    assert.equal(fake.prompts.length, 0, 'a not-active prompt never reaches the Host')
    // resume/load of a Session the official owner does not know: -32002 plus
    // the requested id, never a malformed-params or conflict class.
    for (const [id, method, params] of [
      [5, 'session/resume', { sessionId: 'ghost', cwd: '/host/proj' }],
      [6, 'session/load', { sessionId: 'ghost', cwd: '/host/proj', mcpServers: [] }],
    ] as const) {
      client.send({ jsonrpc: '2.0', id, method, params })
      const frame = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string; sessionId?: string } } }
      assert.equal(frame.id, id)
      assert.equal(frame.error?.code, -32002)
      assert.equal(frame.error?.data?.code, 'LOCAL_ACP_VIEW_SESSION_NOT_FOUND')
      assert.equal(frame.error?.data?.sessionId, 'ghost')
    }
    assert.deepEqual(fake.sessionHistoryReads(), [], 'a definite not-found load reads no history')
    // An EMPTY Session id is malformed request shape, never a not-active
    // Session: the same three methods keep -32602 with no Host dispatch.
    for (const [id, method, params] of [
      [10, 'session/prompt', { sessionId: '', prompt: [{ type: 'text', text: 'x' }] }],
      [11, 'session/set_mode', { sessionId: '', modeId: 'plan' }],
      [12, 'session/set_config_option', { sessionId: '', configId: 'model', value: '["p1","b"]' }],
    ] as const) {
      client.send({ jsonrpc: '2.0', id, method, params })
      const frame = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string; sessionId?: unknown } } }
      assert.equal(frame.id, id)
      assert.equal(frame.error?.code, -32602, `${method} with an empty id keeps the invalid-params class`)
      assert.equal(frame.error?.data?.code, 'LOCAL_ACP_VIEW_INVALID_REQUEST')
      assert.equal(frame.error?.data?.sessionId, undefined, 'the malformed request carries no not-active Session id')
    }
    assert.equal(fake.prompts.length, 0, 'no empty-id request reached the Host')
    // Malformed requests keep their own -32602 invalid class; an invalid mode
    // is still checked before any ownership lookup.
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/resume', params: { sessionId: '', cwd: '/host/proj' } })
    const emptyId = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(emptyId.error?.code, -32602)
    assert.equal(emptyId.error?.data?.code, 'LOCAL_ACP_VIEW_INVALID_REQUEST')
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/set_mode', params: { sessionId: '', modeId: 'nope' } })
    const badMode = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(badMode.error?.code, -32602)
    assert.equal(badMode.error?.data?.code, 'LOCAL_ACP_CONFIG_INVALID_OPTION')
    // An unknown Session close stays the standard idempotent `{}`.
    client.send({ jsonrpc: '2.0', id: 9, method: 'session/close', params: { sessionId: 'ghost' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
  } finally {
    client.close()
  }
})

test('malformed HTTP declarations are refused before dispatch for new, resume and load', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    sessionRead: true,
    sessionHistory: sessionId => ({ header: { sessionId, cwd: '/host/proj' }, events: [] }),
  })
  fake.seed('http-invalid-target', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    const malformed = {
      name: 'bad-http',
      type: 'http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Bad Header', value: 'not-sent' }],
    }
    for (const [id, method, params] of [
      [2, 'session/new', { cwd: '/host/proj', mcpServers: [malformed] }],
      [3, 'session/resume', { sessionId: 'http-invalid-target', cwd: '/host/proj', mcpServers: [malformed] }],
      [4, 'session/load', { sessionId: 'http-invalid-target', cwd: '/host/proj', mcpServers: [malformed] }],
    ]) {
      client.send({ jsonrpc: '2.0', id, method, params })
      const refused = (await client.next()) as { id?: number; error?: { code?: number; data?: { code?: string } } }
      assert.equal(refused.id, id)
      assert.equal(refused.error?.code, -32602)
      assert.equal(refused.error?.data?.code, 'LOCAL_ACP_MCP_INVALID_DECLARATION')
    }
    assert.deepEqual(fake.resolveCalls(), [], 'malformed HTTP never resolves a target Agent')
    assert.deepEqual(fake.sessionHistoryReads(), [], 'malformed HTTP load never reads history')
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/resume', params: { sessionId: 'http-invalid-target', cwd: '/host/proj' } })
    const legal = (await client.next()) as { result?: unknown }
    assert.deepEqual(legal.result, {})
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId: 'http-invalid-target' } })
    const closed = (await client.next()) as { result?: unknown }
    assert.deepEqual(closed.result, {})
  } finally {
    client.close()
  }
})

test('one ACP socket routes concurrent prompts and close to their exact Session', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-shared-a', '/host/a')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-shared-a', cwd: '/host/a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/b', mcpServers: [] } })
    const createdB = (await client.next()) as { result?: { sessionId?: string } }
    const sessionB = createdB.result?.sessionId as string
    assert.equal(typeof sessionB, 'string')

    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-shared-a', prompt: [{ type: 'text', text: 'A' }] } })
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'B' }] } })
    await waitForFact(() => fake.prompts.length === 2 ? true : undefined, 'both A and B prompts')
    const promptA = fake.prompts.find(request => request.sessionId === 'session-shared-a')
    const promptB = fake.prompts.find(request => request.sessionId === sessionB)
    assert.ok(promptA !== undefined && promptB !== undefined)
    const facts = fake.facts()
    const agentA = fake.agentOf('session-shared-a')
    const agentB = fake.agentOf(sessionB)
    assert.ok(facts !== undefined && agentA !== undefined && agentB !== undefined)

    const messageA = { id: 'm-a', source: { kind: 'user', rpcId: promptA.requestId } }
    const messageB = { id: 'm-b', source: { kind: 'user', rpcId: promptB.requestId } }
    facts.onInboxInserted(agentA, messageA)
    facts.onInboxInserted(agentB, messageB)
    fake.turnFence.openTurnStartSeq = 10
    fake.turnFence.lastTurn = 11
    facts.onInboxClaimed(agentA, messageA, 11)
    facts.onInboxClaimed(agentB, messageB, 12)

    // B settles independently first; only B's sessionId is on its notifications.
    facts.onSessionEvent(agentB.session, {
      seq: 4,
      type: 'assistant/message',
      data: { turn: 12, message: { id: 'm-b', content: [{ type: 'text', text: 'answer B' }] } },
    })
    facts.onSessionEvent(agentB.session, { seq: 5, type: 'turn/end', data: { turn: 12, reason: { kind: 'completed' } } })
    let responseB: { id?: number; result?: { stopReason?: string } } | undefined
    let updateB: { params?: { sessionId?: string } } | undefined
    for (;;) {
      const message = (await client.next()) as { id?: number; method?: string; params?: { sessionId?: string }; result?: { stopReason?: string } }
      if (message.method === 'session/update') { updateB = message; continue }
      if (message.id === 5) { responseB = message; break }
    }
    assert.equal(updateB?.params?.sessionId, sessionB)
    assert.equal(responseB.result?.stopReason, 'end_turn')

    // A still settles on its own facts and never receives B's response or update.
    facts.onSessionEvent(agentA.session, {
      seq: 6,
      type: 'assistant/message',
      data: { turn: 11, message: { id: 'm-a', content: [{ type: 'text', text: 'answer A' }] } },
    })
    facts.onSessionEvent(agentA.session, { seq: 7, type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } })
    let responseA: { id?: number; result?: { stopReason?: string } } | undefined
    let updateA: { params?: { sessionId?: string } } | undefined
    for (;;) {
      const message = (await client.next()) as { id?: number; method?: string; params?: { sessionId?: string }; result?: { stopReason?: string } }
      if (message.method === 'session/update') { updateA = message; continue }
      if (message.id === 4) { responseA = message; break }
    }
    assert.equal(updateA?.params?.sessionId, 'session-shared-a')
    assert.equal(responseA.result?.stopReason, 'end_turn')

    // Closing A leaves B attached for another full turn.
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId: 'session-shared-a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'B again' }] } })
    const promptBAgain = await waitForFact(() => fake.prompts[2], 'the second B prompt')
    const messageBAgain = { id: 'm-b-2', source: { kind: 'user', rpcId: promptBAgain.requestId } }
    facts.onInboxInserted(agentB, messageBAgain)
    fake.turnFence.lastTurn = 13
    facts.onInboxClaimed(agentB, messageBAgain, 13)
    facts.onSessionEvent(agentB.session, {
      seq: 8,
      type: 'assistant/message',
      data: { turn: 13, message: { id: 'm-b-2', content: [{ type: 'text', text: 'B again answer' }] } },
    })
    facts.onSessionEvent(agentB.session, { seq: 9, type: 'turn/end', data: { turn: 13, reason: { kind: 'completed' } } })
    for (;;) {
      const message = (await client.next()) as { id?: number; result?: { stopReason?: string } }
      if (message.id === 7) {
        assert.equal(message.result?.stopReason, 'end_turn')
        break
      }
    }
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/prompt', params: { sessionId: 'session-shared-a', prompt: [{ type: 'text', text: 'closed A' }] } })
    assert.equal(((await client.next()) as { error?: { data?: { code?: string } } }).error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    client.send({ jsonrpc: '2.0', id: 9, method: 'session/close', params: { sessionId: sessionB } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
  } finally {
    client.close()
  }
})

test('one ACP socket admits a second new while the first is still awaiting Host create', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-first', '/host/first')
  fake.seed('session-second', '/host/second')
  const firstGate = Promise.withResolvers<AcpCreateSessionOutcome>()
  let createCalls = 0
  fake.access.createSession = async () => {
    createCalls += 1
    return createCalls === 1 ? await firstGate.promise : { kind: 'created', sessionId: 'session-second' }
  }
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/first', mcpServers: [] } })
    await waitForFact(() => createCalls === 1 ? true : undefined, 'the first Host create')
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/second', mcpServers: [] } })
    let second: { id?: number; result?: { sessionId?: string } } | undefined
    for (;;) {
      const message = (await client.next()) as { id?: number; result?: { sessionId?: string } }
      if (message.id === 3) { second = message; break }
    }
    assert.equal(second.result?.sessionId, 'session-second', 'B must attach while A is still awaiting Host create')
    firstGate.resolve({ kind: 'created', sessionId: 'session-first' })
    let first: { id?: number; result?: { sessionId?: string }; error?: unknown } | undefined
    for (;;) {
      const message = (await client.next()) as { id?: number; result?: { sessionId?: string }; error?: unknown }
      if (message.id === 2) { first = message; break }
    }
    assert.equal(first.result?.sessionId, 'session-first')
    assert.equal(first.error, undefined)
  } finally {
    client.close()
  }
})

test('one ACP socket scopes cancel to the addressed Session only', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-cancel-a', '/host/a')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-cancel-a', cwd: '/host/a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/b', mcpServers: [] } })
    const sessionB = ((await client.next()) as { result?: { sessionId?: string } }).result?.sessionId as string
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-cancel-a', prompt: [{ type: 'text', text: 'A' }] } })
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'B' }] } })
    await waitForFact(() => fake.prompts.length === 2 ? true : undefined, 'both cancel prompts')
    const promptA = fake.prompts.find(request => request.sessionId === 'session-cancel-a')
    const promptB = fake.prompts.find(request => request.sessionId === sessionB)
    assert.ok(promptA !== undefined && promptB !== undefined)
    const facts = fake.facts()
    const agentA = fake.agentOf('session-cancel-a')
    const agentB = fake.agentOf(sessionB)
    assert.ok(facts !== undefined && agentA !== undefined && agentB !== undefined)
    const messageA = { id: 'm-cancel-a', source: { kind: 'user', rpcId: promptA.requestId } }
    const messageB = { id: 'm-cancel-b', source: { kind: 'user', rpcId: promptB.requestId } }
    facts.onInboxInserted(agentA, messageA)
    facts.onInboxInserted(agentB, messageB)
    fake.pendingInbox.add(messageA.id)
    fake.pendingInbox.add(messageB.id)

    client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionB } })
    let responseB: { id?: number; result?: { stopReason?: string } } | undefined
    for (;;) {
      const message = (await client.next()) as { id?: number; result?: { stopReason?: string } }
      if (message.id === 5) { responseB = message; break }
    }
    assert.equal(responseB.result?.stopReason, 'cancelled')
    assert.deepEqual(fake.removedMessageIds, ['m-cancel-b'])
    assert.equal(fake.pendingInbox.has('m-cancel-a'), true, 'A remains pending')
    client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-cancel-a' } })
    for (;;) {
      const message = (await client.next()) as { id?: number; result?: { stopReason?: string } }
      if (message.id === 4) {
        assert.equal(message.result?.stopReason, 'cancelled')
        break
      }
    }
    assert.deepEqual(fake.removedMessageIds, ['m-cancel-b', 'm-cancel-a'])
  } finally {
    client.close()
  }
})

test('a single socket bounds live View slots at eight and reuses a released slot', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    const sessionIds: string[] = []
    for (let index = 0; index < 8; index += 1) {
      client.send({ jsonrpc: '2.0', id: 10 + index, method: 'session/new', params: { cwd: `/host/${String(index)}`, mcpServers: [] } })
      const created = (await client.next()) as { result?: { sessionId?: string } }
      assert.equal(typeof created.result?.sessionId, 'string')
      sessionIds.push(created.result?.sessionId as string)
    }
    assert.equal(new Set(sessionIds).size, 8, 'all eight Session Views are distinct')
    assert.equal(fake.agentOf('session-9'), undefined, 'the ninth Host Session was never created')
    client.send({ jsonrpc: '2.0', id: 20, method: 'session/new', params: { cwd: '/host/ninth', mcpServers: [] } })
    const ninth = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(ninth.error?.code, -32602)
    assert.equal(ninth.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')
    assert.equal(fake.agentOf('session-9'), undefined, 'the capacity refusal precedes Host create')

    // A full connection can still refresh a View it already holds: the reattach
    // reuses its existing slot and never allocates a ninth one.
    client.send({ jsonrpc: '2.0', id: 19, method: 'session/resume', params: { sessionId: sessionIds[7], cwd: '/host/7' } })
    let refreshed: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await client.next()) as { id?: number; result?: unknown; error?: unknown; method?: string }
      if (frame.method !== undefined) continue
      refreshed = frame
      break
    }
    assert.equal(refreshed.id, 19)
    assert.equal(refreshed.error, undefined, 'a settled View refreshes even at the eight-slot bound')
    assert.deepEqual(refreshed.result, {})
    assert.equal(fake.agentOf('session-9'), undefined, 'the refresh never created a Session')
    client.send({ jsonrpc: '2.0', id: 20, method: 'session/new', params: { cwd: '/host/still-ninth', mcpServers: [] } })
    const stillFull = (await client.next()) as { id?: number; error?: { data?: { code?: string } } }
    assert.equal(stillFull.id, 20)
    assert.equal(stillFull.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY', 'the refresh did not free a capacity slot')

    client.send({ jsonrpc: '2.0', id: 21, method: 'session/close', params: { sessionId: sessionIds[0] } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 22, method: 'session/new', params: { cwd: '/host/reused', mcpServers: [] } })
    const reused = (await client.next()) as { result?: { sessionId?: string } }
    assert.equal(reused.result?.sessionId, 'session-9', 'a settled close frees its slot for the ninth View')
    assert.notEqual(reused.result?.sessionId, sessionIds[0])
  } finally {
    client.close()
  }
})

test('a same-slot request lifetime refuses a competing repeat, and close retires an in-flight refresh generation', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-view', '/host/view')
  fake.seed('session-sibling', '/host/sibling')
  const attachGate = Promise.withResolvers<void>()
  const attachEntered = Promise.withResolvers<void>()
  let heldAttach = false
  fake.access.modelOptions = async () => {
    if (!heldAttach) {
      heldAttach = true
      attachEntered.resolve()
      await attachGate.promise
    }
    throw new AcpModelError('LOCAL_ACP_MODEL_UNAVAILABLE', 'no model catalog', -32042)
  }
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    // The View is attached, but its INITIAL config read is still the admitted
    // request's lifetime: a competing repeat must not supersede it.
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-view', cwd: '/host/view' } })
    await attachEntered.promise
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: 'session-view', cwd: '/host/view' } })
    const busy = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(busy.id, 3)
    assert.equal(busy.error?.code, -32602)
    assert.equal(busy.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')
    assert.deepEqual(fake.resolveCalls(), ['session-view'], 'the refused repeat never reaches the official resolver')
    // A sibling slot is independent: it is answered while the first is held.
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 'session-sibling', cwd: '/host/sibling' } })
    let sibling: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await client.next()) as { id?: number; result?: unknown; error?: unknown; method?: string }
      if (frame.method !== undefined) continue
      if (frame.id === 2) throw new Error('the held attach answered before the sibling slot was served')
      sibling = frame
      break
    }
    assert.equal(sibling.id, 4)
    assert.equal(sibling.error, undefined, 'a sibling View is not serialized behind the held slot')
    attachGate.resolve()
    let original: { id?: number; result?: unknown } | undefined
    for (;;) {
      const frame = (await client.next()) as { id?: number; result?: unknown; method?: string }
      if (frame.method !== undefined) continue
      if (frame.id !== 2) continue
      original = frame
      break
    }
    assert.deepEqual(original.result, {})

    // The slot is settled now: its own repeat is admitted.
    const originalResolve = fake.access.resolveAgent
    const repeatGate = Promise.withResolvers<void>()
    const repeatEntered = Promise.withResolvers<void>()
    const liveAgent = fake.agentOf('session-view')
    let heldResolve = false
    fake.access.resolveAgent = async () => {
      if (!heldResolve) {
        heldResolve = true
        repeatEntered.resolve()
        await repeatGate.promise
      }
      return liveAgent === undefined
        ? { error: { code: 'session/not-found', message: 'not found' } }
        : { agent: liveAgent }
    }
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/resume', params: { sessionId: 'session-view', cwd: '/host/view' } })
    await repeatEntered.promise
    // While the refresh owns the slot, competing prompt/repeat requests are
    // refused before dispatch instead of interleaving with the new generation.
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId: 'session-view', prompt: [{ type: 'text', text: 'too early' }] } })
    const promptBusy = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(promptBusy.id, 6)
    assert.equal(promptBusy.error?.code, -32602)
    assert.equal(promptBusy.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')
    assert.equal(fake.prompts.length, 0, 'the refused prompt never reached the Host')
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/resume', params: { sessionId: 'session-view', cwd: '/host/view' } })
    const repeatBusy = (await client.next()) as { id?: number; error?: { data?: { code?: string } } }
    assert.equal(repeatBusy.id, 7)
    assert.equal(repeatBusy.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')
    // close is never blocked by the refresh marker: it retires the exact new
    // generation, and the late resolve can no longer attach it.
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/close', params: { sessionId: 'session-view' } })
    const closed = (await client.next()) as { id?: number; result?: unknown }
    assert.equal(closed.id, 8)
    assert.deepEqual(closed.result, {})
    repeatGate.resolve()
    const superseded = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(superseded.id, 5)
    assert.equal(superseded.error?.data?.code, 'LOCAL_ACP_VIEW_CLOSED', 'the closed refresh generation never attaches')
    // The exact Host Agent identity survived and the Session attaches normally.
    fake.access.resolveAgent = originalResolve
    client.send({ jsonrpc: '2.0', id: 9, method: 'session/resume', params: { sessionId: 'session-view', cwd: '/host/view' } })
    let after: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await client.next()) as { id?: number; result?: unknown; error?: unknown; method?: string }
      if (frame.method !== undefined) continue
      after = frame
      break
    }
    assert.equal(after.id, 9)
    assert.equal(after.error, undefined, 'a later ordinary attach succeeds after the superseded refresh')
    assert.equal(fake.agentOf('session-view'), liveAgent, 'the same exact Host Agent identity is reused')
  } finally {
    client.close()
  }
})

test('a refused competitor during a refresh never poisons the slot request bookkeeping', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-counter', '/host/counter')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-counter', cwd: '/host/counter' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    const liveAgent = fake.agentOf('session-counter')
    const originalResolve = fake.access.resolveAgent
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let held = false
    fake.access.resolveAgent = async () => {
      if (!held) {
        held = true
        entered.resolve()
        await gate.promise
      }
      return liveAgent === undefined
        ? { error: { code: 'session/not-found', message: 'not found' } }
        : { agent: liveAgent }
    }
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: 'session-counter', cwd: '/host/counter' } })
    await entered.promise
    // The competing prompt is refused before dispatch. Its handler still runs
    // its `finally`, which must release exactly what its own admission added —
    // never a count the refresh still owns.
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-counter', prompt: [{ type: 'text', text: 'x' }] } })
    const refused = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(refused.id, 4)
    assert.equal(refused.error?.code, -32602)
    assert.equal(refused.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')
    assert.equal(fake.prompts.length, 0, 'the refused prompt never reached the Host')
    gate.resolve()
    let firstRefresh: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await client.next()) as { id?: number; result?: unknown; error?: unknown; method?: string }
      if (frame.method !== undefined) continue
      firstRefresh = frame
      break
    }
    assert.equal(firstRefresh.id, 3)
    assert.equal(firstRefresh.error, undefined, 'the held refresh completes after the competing refusal')
    // The SAME slot refreshes again: no negative lifetime was left behind by the
    // refused competitor.
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/resume', params: { sessionId: 'session-counter', cwd: '/host/counter' } })
    let secondRefresh: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await client.next()) as { id?: number; result?: unknown; error?: unknown; method?: string }
      if (frame.method !== undefined) continue
      secondRefresh = frame
      break
    }
    assert.equal(secondRefresh.id, 5)
    assert.equal(secondRefresh.error, undefined, 'a later refresh on the same slot is admitted')
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId: 'session-counter' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    fake.access.resolveAgent = originalResolve
  } finally {
    client.close()
  }
})

test('a cancelled repeat load retires its fresh generation instead of replaying more history', async t => {
  const { scope } = newScope(t)
  const history = {
    header: { sessionId: 'session-cancel-load', cwd: '/host/cancel' },
    events: [
      { seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'old question' }], role: 'user' } },
      { seq: 1, type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'text', text: 'old answer' }] } } },
      { seq: 2, type: 'user/message', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'second question' }], role: 'user' } },
      { seq: 3, type: 'assistant/message', data: { message: { id: 'a2', content: [{ type: 'text', text: 'second answer' }] } } },
    ],
  }
  const fake = makeFakeAccess({ sessionRead: true, sessionHistory: () => history })
  fake.seed('session-cancel-load', '/host/cancel')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  const other = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    initialize(other, 1)
    await other.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'session-cancel-load', cwd: '/host/cancel', mcpServers: [] } })
    for (;;) {
      const frame = (await client.next()) as { id?: number; method?: string }
      if (frame.method === 'session/update') continue
      if (frame.id !== 2) continue
      break
    }
    // The REPEAT load is held on its real canonical read; the client then sends
    // the official SDK cancellation path.
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let armed = false
    let held = false
    const originalHistory = fake.access.readSessionHistory
    fake.access.readSessionHistory = async (sessionId: string, signal?: AbortSignal) => {
      if (armed && !held) {
        held = true
        entered.resolve()
        await gate.promise
      }
      return await originalHistory(sessionId, signal)
    }
    armed = true
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: 'session-cancel-load', cwd: '/host/cancel', mcpServers: [] } })
    await entered.promise
    client.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 3 } })
    // The cancelled refresh must already have retired its fresh generation: a
    // DIFFERENT connection can attach the Session before the held read settles.
    other.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-cancel-load', cwd: '/host/cancel' } })
    let otherAttach: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await other.next()) as { id?: number; method?: string; result?: unknown; error?: unknown }
      if (frame.method !== undefined) continue
      otherAttach = frame
      break
    }
    assert.equal(otherAttach.id, 2)
    assert.equal(otherAttach.error, undefined, 'the cancelled refresh leaves the Session attachable')
    // Release the held read. Any uncommitted replay would now be written on the
    // cancelling connection BEFORE this close response (same socket FIFO).
    gate.resolve()
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: 'session-cancel-load' } })
    let cutClose: { id?: number; result?: unknown } | undefined
    const afterCancel: Array<{ method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string } } }> = []
    for (;;) {
      const frame = (await client.next(5_000)) as { id?: number; method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string } }; result?: unknown }
      if (frame.method === 'session/update') afterCancel.push(frame)
      if (frame.id === 4) {
        cutClose = frame
        break
      }
    }
    assert.deepEqual(cutClose?.result, {}, 'the cancelling connection holds no View after the cancellation')
    assert.deepEqual(afterCancel, [], 'the cancelled replay wrote no uncommitted history after the cancel')
    // The new owner of the Session is untouched by the old generation's late
    // read settling.
    other.send({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: 'session-cancel-load' } })
    assert.deepEqual(((await other.next()) as { result?: unknown }).result, {})
    assert.deepEqual(fake.removedMessageIds, [], 'no Host inbox cancellation was issued')
    assert.deepEqual(fake.cancelledTurns, [], 'no Host turn cancellation was issued')
  } finally {
    client.close()
    other.close()
  }
})

test('a repeat cancelled during the official resolve releases its View slot at the capacity bound', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-resolve-cancel', '/host/resolve-cancel')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  const other = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    initialize(other, 1)
    await other.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-resolve-cancel', cwd: '/host/resolve-cancel' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    const liveAgent = fake.agentOf('session-resolve-cancel')
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let held = false
    const originalResolve = fake.access.resolveAgent
    fake.access.resolveAgent = async (sessionId: string) => {
      if (sessionId !== 'session-resolve-cancel') return await originalResolve(sessionId)
      if (!held) {
        held = true
        entered.resolve()
        await gate.promise
      }
      return liveAgent === undefined
        ? { error: { code: 'session/not-found', message: 'not found' } }
        : { agent: liveAgent }
    }
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: 'session-resolve-cancel', cwd: '/host/resolve-cancel' } })
    await entered.promise
    // The official resolve is a real Host await: cancelling here must retire the
    // fresh generation immediately. The other connection is the positive fact
    // that the cancellation was actually processed before the resolve returns.
    client.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 3 } })
    other.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-resolve-cancel', cwd: '/host/resolve-cancel' } })
    let otherAttach: { id?: number; result?: unknown; error?: unknown } | undefined
    for (;;) {
      const frame = (await other.next()) as { id?: number; method?: string; result?: unknown; error?: unknown }
      if (frame.method !== undefined) continue
      otherAttach = frame
      break
    }
    assert.equal(otherAttach.id, 2)
    assert.equal(otherAttach.error, undefined, 'the cancelled resolve retired its fresh generation immediately')
    gate.resolve()
    const cancelled = (await client.next(5_000)) as { id?: number; error?: { data?: { code?: string } } }
    assert.equal(cancelled.id, 3)
    assert.equal(cancelled.error?.data?.code, 'LOCAL_ACP_VIEW_CLOSED', 'the cancelled resolve never attaches')
    // The connection's full eight-slot budget stays usable: a leaked attaching
    // slot would refuse the eighth new View here.
    for (let index = 0; index < 8; index += 1) {
      client.send({ jsonrpc: '2.0', id: 10 + index, method: 'session/new', params: { cwd: `/host/after-cancel-${String(index)}`, mcpServers: [] } })
      const created = (await client.next()) as { id?: number; result?: { sessionId?: string }; error?: { data?: { code?: string } } }
      assert.equal(created.id, 10 + index)
      assert.equal(typeof created.result?.sessionId, 'string',
        `slot ${String(index + 1)} of 8 must be admitted after the cancelled resolve (${JSON.stringify(created.error)})`)
    }
    other.send({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: 'session-resolve-cancel' } })
    assert.deepEqual(((await other.next()) as { result?: unknown }).result, {})
    assert.deepEqual(fake.removedMessageIds, [], 'no Host inbox cancellation was issued')
    assert.deepEqual(fake.cancelledTurns, [], 'no Host turn cancellation was issued')
  } finally {
    client.close()
    other.close()
  }
})

test('a claim still detached-with-fence answers the retryable busy class instead of not-active', async t => {
  const { scope } = newScope(t)
  const retireGate = Promise.withResolvers<void>()
  const fake = makeFakeAccess({
    mountScopedMcp: async (agent, session) => ({ agent: agent as never, session, serverNames: ['s1'], fibers: [] }),
    requestRetireScopedMcp: async () => { await retireGate.promise },
  })
  fake.seed('session-fenced', '/host/fenced')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  const other = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    initialize(other, 1)
    await other.next()
    client.send({
      jsonrpc: '2.0', id: 2, method: 'session/resume',
      params: { sessionId: 'session-fenced', cwd: '/host/fenced', mcpServers: [{ name: 's1', command: '/bin/true', args: [], env: [] }] },
    })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    // The close detaches immediately but its exact MCP retirement is still in
    // flight: the claim stays fenced and the View is NOT unknown.
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: 'session-fenced' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 'session-fenced', cwd: '/host/fenced' } })
    const fenced = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(fenced.id, 4)
    assert.equal(fenced.error?.code, -32602, 'a fenced View is transient, never the standard not-active class')
    assert.equal(fenced.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')
    other.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-fenced', cwd: '/host/fenced' } })
    const heldOther = (await other.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(heldOther.id, 2)
    assert.equal(heldOther.error?.code, -32602)
    assert.equal(heldOther.error?.data?.code, 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
      'the fenced claim still owns the Session until its Host terminal settles')
    retireGate.resolve()
  } finally {
    client.close()
    other.close()
  }
})

test('a refresh whose post-attach config read fails retires only its fresh generation', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-config-fail', '/host/cfgfail')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  const other = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    initialize(other, 1)
    await other.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-config-fail', cwd: '/host/cfgfail' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    fake.access.readSessionPolicy = () => {
      throw new AcpSessionPolicyError('LOCAL_ACP_CONFIG_STALE', 'the attached session changed during the config read', -32042)
    }
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/resume', params: { sessionId: 'session-config-fail', cwd: '/host/cfgfail' } })
    const failed = (await client.next()) as { id?: number; error?: unknown; result?: unknown }
    assert.equal(failed.id, 3)
    assert.notEqual(failed.error, undefined, 'the refresh answers its real config failure')
    fake.access.readSessionPolicy = () => ({})
    // The fresh generation is retired, so a DIFFERENT connection can attach the
    // Session instead of being told it is already held by a dead request.
    other.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-config-fail', cwd: '/host/cfgfail' } })
    const afterFailure = (await other.next()) as { id?: number; result?: unknown; error?: unknown }
    assert.equal(afterFailure.id, 2)
    assert.equal(afterFailure.error, undefined, 'no fresh claim leaks after a failed post-attach config read')
    assert.deepEqual(afterFailure.result, {})
  } finally {
    client.close()
    other.close()
  }
})

test('eight open prompt flights keep legal close and ninth-View rejection reachable on one socket', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    const sessionIds: string[] = []
    for (let index = 0; index < 8; index += 1) {
      client.send({ jsonrpc: '2.0', id: 10 + index, method: 'session/new', params: { cwd: `/host/pending-${String(index)}`, mcpServers: [] } })
      const created = (await client.next()) as { result?: { sessionId?: string } }
      assert.equal(typeof created.result?.sessionId, 'string')
      sessionIds.push(created.result?.sessionId as string)
    }
    for (let index = 0; index < 8; index += 1) {
      client.send({
        jsonrpc: '2.0', id: 30 + index, method: 'session/prompt',
        params: { sessionId: sessionIds[index], prompt: [{ type: 'text', text: `open flight ${String(index)}` }] },
      })
    }
    await waitForFact(() => fake.prompts.length === 8 ? true : undefined, 'eight held prompt admissions', 10_000)

    // The ninth View is a connection-local capacity refusal, not a global
    // pending-request flood that destroys the socket.
    client.send({ jsonrpc: '2.0', id: 50, method: 'session/new', params: { cwd: '/host/ninth', mcpServers: [] } })
    const ninth = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(ninth.id, 50)
    assert.equal(ninth.error?.code, -32602)
    assert.equal(ninth.error?.data?.code, 'LOCAL_ACP_VIEW_BUSY')

    // A legal close remains reachable while all eight prompt handlers are
    // still open; A has one real pending message that the fake Host removes.
    const facts = fake.facts()
    const agentA = fake.agentOf(sessionIds[0])
    const requestA = fake.prompts.find(request => request.sessionId === sessionIds[0])
    assert.ok(facts !== undefined && agentA !== undefined && requestA !== undefined)
    facts.onInboxInserted(agentA, { id: 'm-held-a', source: { kind: 'user', rpcId: requestA.requestId } })
    client.send({ jsonrpc: '2.0', id: 60, method: 'session/close', params: { sessionId: sessionIds[0] } })
    let closed: { id?: number; result?: unknown; error?: { data?: { code?: string } } } | undefined
    for (;;) {
      const message = (await client.next(10_000)) as typeof closed
      if (message?.id === 60) { closed = message; break }
    }
    assert.deepEqual(closed.result, {}, `the owned close must settle without a sibling teardown: ${JSON.stringify(closed.error)}`)

    // The socket and the remaining seven Views still work: a new slot can be
    // admitted after A's terminal close, while the B..H prompt handlers stay open.
    client.send({ jsonrpc: '2.0', id: 61, method: 'session/new', params: { cwd: '/host/after-close', mcpServers: [] } })
    const afterClose = (await client.next()) as { id?: number; result?: { sessionId?: string } }
    assert.equal(afterClose.id, 61)
    assert.equal(typeof afterClose.result?.sessionId, 'string')
  } finally {
    client.close()
  }
})

test('four slow lifecycle controls cannot make a legal close destroy the socket', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-close-a', '/host/close-a')
  for (let index = 0; index < 4; index += 1) fake.seed(`held-${String(index)}`, `/host/held-${String(index)}`)
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
  let createIndex = 0
  fake.access.createSession = async () => {
    const index = createIndex
    createIndex += 1
    await gates[index]?.promise
    return { kind: 'created' as const, sessionId: `held-${String(index)}` }
  }
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-close-a', cwd: '/host/close-a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    for (let index = 0; index < 4; index += 1) {
      client.send({ jsonrpc: '2.0', id: 10 + index, method: 'session/new', params: { cwd: `/host/held-${String(index)}`, mcpServers: [] } })
    }
    await waitForFact(() => createIndex === 4 ? true : undefined, 'four held Host creates', 10_000)
    client.send({ jsonrpc: '2.0', id: 30, method: 'session/new', params: { cwd: '/host/overload', mcpServers: [] } })
    const overload = (await client.next()) as { id?: number; error?: { data?: { code?: string } } }
    assert.equal(overload.id, 30)
    assert.equal(overload.error?.data?.code, 'LOCAL_ACP_TOO_MANY_PENDING_REQUESTS')
    assert.equal(createIndex, 4, 'the overload must not reach Host create')
    client.send({ jsonrpc: '2.0', id: 20, method: 'session/close', params: { sessionId: 'session-close-a' } })
    const closed = (await client.next()) as { id?: number; result?: unknown; error?: { data?: { code?: string } } }
    assert.equal(closed.id, 20)
    assert.deepEqual(closed.result, {}, `a legal close must not be blocked by four lifecycle controls: ${JSON.stringify(closed.error)}`)
    client.send({ jsonrpc: '2.0', id: 21, method: 'session/close', params: { sessionId: 'unknown-close' } })
    const unknown = (await client.next()) as { id?: number; result?: unknown; error?: unknown }
    assert.equal(unknown.id, 21)
    assert.deepEqual(unknown.result, {}, 'the physical socket remains alive after the held-control close')
    for (const gate of gates) gate.resolve()
    const created = new Map<number, string>()
    for (let remaining = 4; remaining > 0;) {
      const message = (await client.next()) as { id?: number; result?: { sessionId?: string }; error?: unknown }
      if (message.id === undefined) continue
      if (message.id >= 10 && message.id <= 13) {
        assert.equal(typeof message.result?.sessionId, 'string')
        created.set(message.id, message.result?.sessionId as string)
        remaining -= 1
      }
    }
    assert.deepEqual([...created.values()].sort(), ['held-0', 'held-1', 'held-2', 'held-3'])
  } finally {
    client.close()
  }
})

test('Off releases every View slot on the shared registry and a new bind can resume them', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-off-a', '/host/a')
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const listenerA = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access, views: registry })
  const clientA = await RawClient.open(listenerA.socketPath)
  initialize(clientA, 1)
  await clientA.next()
  clientA.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-off-a', cwd: '/host/a' } })
  assert.deepEqual(((await clientA.next()) as { result?: unknown }).result, {})
  clientA.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/b', mcpServers: [] } })
  const sessionB = ((await clientA.next()) as { result?: { sessionId?: string } }).result?.sessionId as string
  assert.equal(registry.claimCount(), 2)
  await listenerA.close()
  await waitForFact(() => registry.claimCount() === 0 ? true : undefined, 'all Off View claims released')
  assert.equal(registry.hasClaim('session-off-a'), false)
  assert.equal(registry.hasClaim(sessionB), false)

  const listenerB = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access, views: registry })
  try {
    const clientB = await RawClient.open(listenerB.socketPath)
    try {
      initialize(clientB, 1)
      await clientB.next()
      clientB.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-off-a', cwd: '/host/a' } })
      assert.deepEqual(((await clientB.next()) as { result?: unknown }).result, {})
      assert.equal(registry.claimCount(), 1, 'the old registry accepts a fresh View after Off -> On')
    } finally {
      clientB.close()
    }
  } finally {
    await listenerB.close()
    registry.disposeFacts()
    clientA.close()
  }
})

test('an Agent disposal releases only its own View and leaves the sibling Session working', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-dispose-a', '/host/a')
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access, views: registry })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-dispose-a', cwd: '/host/a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/b', mcpServers: [] } })
    const sessionB = ((await client.next()) as { result?: { sessionId?: string } }).result?.sessionId as string
    const facts = fake.facts()
    const agentA = fake.agentOf('session-dispose-a')
    const agentB = fake.agentOf(sessionB)
    assert.ok(facts !== undefined && agentA !== undefined && agentB !== undefined)
    assert.equal(registry.claimCount(), 2)
    facts.onAgentDisposed(agentA)
    assert.equal(registry.hasClaim('session-dispose-a'), false, 'the disposed A claim is released')
    assert.equal(registry.hasClaim(sessionB), true, 'the sibling B claim survives')
    assert.equal(registry.claimCount(), 1)

    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'B after A disposal' }] } })
    const request = await waitForFact(() => fake.prompts[0], 'B after A disposal prompt')
    const message = { id: 'm-after-a', source: { kind: 'user', rpcId: request.requestId } }
    facts.onInboxInserted(agentB, message)
    facts.onInboxClaimed(agentB, message, 1)
    facts.onSessionEvent(agentB.session, {
      seq: 10,
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-after-a', content: [{ type: 'text', text: 'B survives' }] } },
    })
    facts.onSessionEvent(agentB.session, { seq: 11, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    for (;;) {
      const response = (await client.next()) as { id?: number; result?: { stopReason?: string } }
      if (response.id === 4) {
        assert.equal(response.result?.stopReason, 'end_turn')
        break
      }
    }
  } finally {
    registry.disposeFacts()
    client.close()
  }
})

test('session/new carries the authoritative created session id in JSON-RPC error data on published-with-error', async t => {
  const { scope } = newScope(t)
  const access: HostAcpSessionAccess = {
    supportsFileInput() {
      return false
    },
    supportsSystemPromptAppend() {
      return false
    },
    registerSystemPromptAppend() {
      throw new Error('systemPrompt append is not configured for this listener test')
    },
    async stageFile() {
      throw new Error('file staging is not configured for this listener test')
    },
    cleanupStagedFiles() {},
    retirePromptReceipts() {},
    hasQuestionService() {
      return false
    },
    questionSnapshot() {
      return { kind: 'unavailable' as const }
    },
    answerContinued() {
      return { kind: 'unavailable' as const }
    },
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
    supportsSessionRead() {
      return false
    },
    async readSessionList() {
      return []
    },
    async readSessionHistory(sessionId: string) {
      return { header: { sessionId }, events: [] }
    },
    async sessionHeaderFacts() {
      return undefined
    },
    contextPressure() {
      return undefined
    },
    sessionTodos() {
      return undefined
    },
    async mountScopedMcp() {
      return undefined
    },
    async requestRetireScopedMcp() {},
    imageLimits() {
      return undefined
    },
    supportsImagePrompts() {
      return Promise.resolve(false)
    },
    async readOutputImage() {
      throw new Error('no attachment store')
    },
    readOutputFile(): AsyncIterable<Uint8Array> {
      throw new Error('no attachment store')
    },
    async modelOptions() {
      return []
    },
    async selectModelOnly() {
      return []
    },
    readSessionPolicy() {
      return {}
    },
    readSessionMode() {
      return undefined
    },
    async selectSessionPolicy() {},
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
    readCommandCatalog() {
      return EMPTY_COMMAND_CATALOG
    },
    async readNativeSkills() {
      return { kind: 'absent' as const }
    },
    async executeStandaloneCommand() {
      return undefined
    },
    async executeManualCompact() {
      return null
    },
    parseCommand(line: string) {
      return parseCommand(line)
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

test('session/new advertises HTTP MCP only with a View and forwards stdio+HTTP declarations unchanged', async t => {
  const { scope } = newScope(t)
  const mounted: Array<{ readonly servers: readonly unknown[] }> = []
  const { access } = makeFakeAccess({
    async mountScopedMcp(agent, session, servers) {
      mounted.push({ servers })
      return { agent: agent as never, session, serverNames: ['mcp-one'], fibers: [] }
    },
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    const initialized = (await client.next()) as {
      result?: { agentCapabilities?: { mcpCapabilities?: { http?: boolean; sse?: boolean } } }
    }
    assert.deepEqual(initialized.result?.agentCapabilities?.mcpCapabilities, { http: true, sse: false })
    const mcpServers = [
      { name: 'mcp one', command: '/bin/true', args: [], env: [{ name: 'SAFE', value: 'value' }] },
      {
        name: 'http-one',
        type: 'http',
        url: 'http://127.0.0.1:8765/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer value' }],
      },
    ]
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host', mcpServers } })
    const response = (await client.next()) as { result?: { sessionId?: string }; error?: unknown }
    assert.equal(typeof response.result?.sessionId, 'string', JSON.stringify(response))
    assert.equal(mounted.length, 1)
    assert.deepEqual(mounted[0].servers, mcpServers)
  } finally {
    client.close()
  }
})

test('session/new rejects an invalid stdio MCP declaration before any Host workspace or session create', async t => {
  const { scope } = newScope(t)
  const { access } = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/host', mcpServers: [{ name: 'bad', command: 'relative', args: [], env: [] }] },
    })
    const response = (await client.next()) as { error?: { code?: number; data?: { code?: string } } }
    assert.equal(response.error?.code, -32602)
    assert.equal(response.error?.data?.code, 'LOCAL_ACP_MCP_INVALID_DECLARATION')
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
    const skillContext = { id: 'm-skill', source: { kind: 'skill-invocation', form: 'instructions' } }
    facts.onInboxInserted(agent, message)
    facts.onInboxInserted(agent, skillContext)
    // The next-step skill context is claimed before the ACP next-turn message.
    facts.onInboxClaimed(agent, skillContext, 1)
    facts.onInboxClaimed(agent, message, 1)
    const subagentContext = { id: 'm-subagent', source: { kind: 'subagent-settled', form: 'notice' } }
    const timeContext = { id: 'm-time', source: { kind: 'time-context', form: 'snapshot' } }
    // Runtime context arriving in the same running turn is also not a user steer.
    facts.onInboxInserted(agent, subagentContext)
    facts.onInboxClaimed(agent, subagentContext, 1)
    facts.onInboxInserted(agent, timeContext)
    facts.onInboxClaimed(agent, timeContext, 1)
    facts.onSessionEvent(agent.session, {
      seq: 12,
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-uds', content: [{ type: 'text', text: 'wire answer' }] } },
    })
    facts.onSessionEvent(agent.session, { seq: 13, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

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
    const uninitialized = (await client.next()) as { error?: { code: number; message?: string; data?: unknown } }
    assert.equal(uninitialized.error?.code, -32600)
    assert.match(uninitialized.error?.message ?? '', /must be initialized before 'session\/prompt'/u)
    assert.equal(uninitialized.error?.data, undefined)

    initialize(client, 2)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'session-resume', prompt: [{ type: 'text', text: 'x' }] } })
    const unattached = (await client.next()) as { error?: { code: number; data?: { code?: string; sessionId?: string } } }
    assert.equal(unattached.error?.code, -32002, 'a Session this connection does not hold is the standard not-active class')
    assert.equal(unattached.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    assert.equal(unattached.error?.data?.sessionId, 'session-resume')

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
    const wrongSession = (await client.next()) as { error?: { code: number; data?: { code?: string; sessionId?: string } } }
    assert.equal(wrongSession.error?.code, -32002)
    assert.equal(wrongSession.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    assert.equal(wrongSession.error?.data?.sessionId, 'other-session')
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
      seq: 14,
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-b', content: [{ type: 'text', text: 'b answer' }] } },
    })
    facts.onSessionEvent(agent.session, { seq: 15, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
      seq: 16,
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-next', content: [{ type: 'text', text: 'next answer' }] } },
    })
    facts.onSessionEvent(agent.session, { seq: 17, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
      seq: 18,
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-ap', content: [{ type: 'text', text: 'approved answer' }] } },
    })
    facts.onSessionEvent(agent.session, { seq: 19, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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

test('permission requests on one socket stay on their exact Session', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-permission-a', '/host/a')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-permission-a', cwd: '/host/a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/b', mcpServers: [] } })
    const sessionB = ((await client.next()) as { result?: { sessionId?: string } }).result?.sessionId as string
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-permission-a', prompt: [{ type: 'text', text: 'A asks' }] } })
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'B asks' }] } })
    await waitForFact(() => fake.prompts.length === 2 ? true : undefined, 'both permission prompts')
    const requestA = fake.prompts.find(request => request.sessionId === 'session-permission-a')
    const requestB = fake.prompts.find(request => request.sessionId === sessionB)
    assert.ok(requestA !== undefined && requestB !== undefined)
    const facts = fake.facts()
    const agentA = fake.agentOf('session-permission-a')
    const agentB = fake.agentOf(sessionB)
    assert.ok(facts !== undefined && agentA !== undefined && agentB !== undefined)
    const messageA = { id: 'm-permission-a', source: { kind: 'user', rpcId: requestA.requestId } }
    const messageB = { id: 'm-permission-b', source: { kind: 'user', rpcId: requestB.requestId } }
    facts.onInboxInserted(agentA, messageA)
    facts.onInboxInserted(agentB, messageB)
    facts.onInboxClaimed(agentA, messageA, 1)
    facts.onInboxClaimed(agentB, messageB, 2)

    fake.turnFence.openTurnStartSeq = 31
    fake.turnFence.lastTurn = 1
    const decidedA = facts.onApprovalRequest({ agent: agentA, toolName: 'bash', callId: 'call-permission-a' }, async () => 'unavailable')
    const reverseA = (await client.next()) as { id?: number; method?: string; params?: { sessionId?: string; toolCall?: { toolCallId?: string } } }
    assert.equal(reverseA.method, 'session/request_permission')
    assert.equal(reverseA.params?.sessionId, 'session-permission-a')
    assert.equal(reverseA.params?.toolCall?.toolCallId, 'call-permission-a')
    client.send({ jsonrpc: '2.0', id: reverseA.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    assert.equal(await decidedA, 'allowed-once')

    fake.turnFence.openTurnStartSeq = 32
    fake.turnFence.lastTurn = 2
    const decidedB = facts.onApprovalRequest({ agent: agentB, toolName: 'bash', callId: 'call-permission-b' }, async () => 'unavailable')
    const reverseB = (await client.next()) as { id?: number; method?: string; params?: { sessionId?: string; toolCall?: { toolCallId?: string } } }
    assert.equal(reverseB.method, 'session/request_permission')
    assert.equal(reverseB.params?.sessionId, sessionB)
    assert.equal(reverseB.params?.toolCall?.toolCallId, 'call-permission-b')
    client.send({ jsonrpc: '2.0', id: reverseB.id, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } })
    assert.equal(await decidedB, 'rejected')

    facts.onSessionEvent(agentA.session, {
      seq: 20,
      type: 'assistant/message', data: { turn: 1, message: { id: 'm-permission-a', content: [{ type: 'text', text: 'A answer' }] } },
    })
    facts.onSessionEvent(agentA.session, { seq: 21, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    facts.onSessionEvent(agentB.session, {
      seq: 22,
      type: 'assistant/message', data: { turn: 2, message: { id: 'm-permission-b', content: [{ type: 'text', text: 'B answer' }] } },
    })
    facts.onSessionEvent(agentB.session, { seq: 23, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    const responses = new Map<number, { result?: { stopReason?: string } }>()
    for (let remaining = 2; remaining > 0;) {
      const message = (await client.next()) as { id?: number; method?: string; result?: { stopReason?: string } }
      if (message.method === 'session/update' || message.id === undefined) continue
      responses.set(message.id, message)
      remaining -= 1
    }
    assert.equal(responses.get(4)?.result?.stopReason, 'end_turn')
    assert.equal(responses.get(5)?.result?.stopReason, 'end_turn')
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
    facts.onSessionEvent(agent.session, { seq: 24, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
          seq: 25,
          type: 'assistant/message',
          data: { turn: 2, message: { id: 'm-new', content: [{ type: 'text', text: 'one update' }] } },
        })
        // EXACTLY ONE session/update: a duplicate subscription would emit two.
        const update = (await clientB.next()) as { method?: string; params?: { update?: { sessionUpdate?: string } } }
        assert.equal(update.method, 'session/update')
        assert.equal(update.params?.update?.sessionUpdate, 'agent_message_chunk')
        assert.equal(await clientB.silent(500), true, 'no duplicate update arrived from a second subscription')
        facts.onSessionEvent(newAgent.session, { seq: 26, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
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
      oldFacts.onSessionEvent(oldAgent.session, { seq: 27, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } } })
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
    facts.onSessionEvent(agent.session, { seq: 28, type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
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

test('an unconfirmed A close stays fail-closed while B continues on the same socket', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  fake.seed('session-unconfirmed-a', '/host/a')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-unconfirmed-a', cwd: '/host/a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/b', mcpServers: [] } })
    const sessionB = ((await client.next()) as { result?: { sessionId?: string } }).result?.sessionId as string
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'session-unconfirmed-a', prompt: [{ type: 'text', text: 'A queued' }] } })
    const requestA = await waitForFact(() => fake.prompts[0], 'the unconfirmed A prompt')
    const facts = fake.facts()
    const agentA = fake.agentOf('session-unconfirmed-a')
    const agentB = fake.agentOf(sessionB)
    assert.ok(facts !== undefined && agentA !== undefined && agentB !== undefined)
    facts.onInboxInserted(agentA, { id: 'm-unconfirmed-a', source: { kind: 'user', rpcId: requestA.requestId } })
    fake.staleCancel.value = true
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/close', params: { sessionId: 'session-unconfirmed-a' } })
    assert.equal(((await client.next()) as { error?: { data?: { code?: string } } }).error?.data?.code,
      'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED')
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId: sessionB, prompt: [{ type: 'text', text: 'B still works' }] } })
    const requestB = await waitForFact(() => fake.prompts[1], 'the B prompt after A close')
    const messageB = { id: 'm-unconfirmed-b', source: { kind: 'user', rpcId: requestB.requestId } }
    facts.onInboxInserted(agentB, messageB)
    facts.onInboxClaimed(agentB, messageB, 1)
    facts.onSessionEvent(agentB.session, {
      seq: 29,
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-unconfirmed-b', content: [{ type: 'text', text: 'B settled' }] } },
    })
    facts.onSessionEvent(agentB.session, { seq: 30, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    for (;;) {
      const response = (await client.next()) as { id?: number; result?: { stopReason?: string } }
      if (response.id === 6) {
        assert.equal(response.result?.stopReason, 'end_turn')
        break
      }
    }
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/close', params: { sessionId: 'session-unconfirmed-a' } })
    assert.equal(((await client.next()) as { error?: { data?: { code?: string } } }).error?.data?.code,
      'LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED', 'a repeat A close must not fabricate success while B is active')
    facts.onAgentDisposed(agentA)
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/close', params: { sessionId: 'session-unconfirmed-a' } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {},
      'the exact Agent disposal is a real terminal fact')
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
    const preComplete = (await client.next()) as { id?: number; error?: { code: number; message?: string; data?: unknown } }
    assert.equal(preComplete.id, 2)
    assert.equal(preComplete.error?.code, -32600)
    assert.match(preComplete.error?.message ?? '', /must be initialized before 'session\/resume'/u,
      'session operations cannot race ahead of the initialize response')
    assert.equal(preComplete.error?.data, undefined)
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
    // This fake Host installs the View but no read seams, so `session/list`
    // stays unadvertised and refuses with its own capability classification.
    assert.equal(reply.error?.data?.code, 'LOCAL_ACP_LIST_UNAVAILABLE')
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
      seq: 31,
      type: 'assistant/message',
      data: { turn: 1, message: { id: 'm-image', content: [{ type: 'text', text: 'large frame accepted' }] } },
    })
    facts.onSessionEvent(agent.session, { seq: 32, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
    assert.equal(reply.error?.data?.code, 'LOCAL_ACP_LIST_UNAVAILABLE', 'the accepted connection stays healthy')
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
      seq: 33,
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
    facts.onSessionEvent(agent.session, { seq: 34, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

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
      seq: 35,
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
    facts.onSessionEvent(agent.session, { seq: 36, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

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
      seq: 37,
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
    facts.onSessionEvent(agent.session, { seq: 38, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
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
      seq: 39,
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
    const siblingResponse = (await healthy.next()) as { id?: number; error?: { code?: number; data?: { code?: string } } }
    assert.equal(siblingResponse.id, 9)
    assert.equal(siblingResponse.error?.data?.code, 'LOCAL_ACP_LIST_UNAVAILABLE')
  } finally {
    victim.close()
    healthy.close()
  }
})

/** One full standard config-option state with an exact current model value. */
function configOptionsFor(currentValue: string): SessionConfigOption[] {
  return [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [{ group: 'group:p1', name: 'Provider 1', options: [{ value: currentValue, name: currentValue }] }],
  }]
}

test('ACP v1 config options are served over the real socket for new/resume/set_config_option and TUI model events', async t => {
  const { scope } = newScope(t)
  const optionsA = configOptionsFor('["p1","a"]')
  const optionsB = configOptionsFor('["p1","b"]')
  let currentA = optionsA
  const fake = makeFakeAccess({
    modelOptions: async () => currentA,
    selectModelOnly: async (_agent, _session, request) => {
      if (request.type === 'boolean' || request.configId !== 'model' || request.value !== '["p1","b"]') {
        throw new AcpModelError('LOCAL_ACP_MODEL_INVALID_OPTION', 'invalid model option', -32602)
      }
      currentA = optionsB
      return optionsB
    },
  })
  fake.seed('session-config', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()

    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await client.next()) as {
      result?: { sessionId?: string; configOptions?: SessionConfigOption[] }
    }
    const sessionId = created.result?.sessionId as string
    assert.equal(typeof sessionId, 'string')
    assert.deepEqual(created.result?.configOptions, optionsA, 'session/new returns the full current option state')

    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_config_option',
      params: { sessionId, configId: 'model', value: '["p1","b"]' },
    })
    const selected = (await client.next()) as { id?: number; result?: { configOptions?: SessionConfigOption[] } }
    assert.equal(selected.id, 3)
    assert.deepEqual(selected.result?.configOptions, optionsB, 'set_config_option returns the full new option state')
    assert.deepEqual(fake.modelSelections, [{ configId: 'model', value: '["p1","b"]' }])
    // A same-value write emits no Session event and must not race a config
    // notification ahead of its own response; the reply already carries the cut.

    const agent = fake.agentOf(sessionId)
    const facts = fake.facts()
    assert.ok(agent !== undefined && facts !== undefined)
    facts.onSessionEvent(agent.session, { seq: 40, type: 'model/selection', data: { provider: 'p1', model: 'b' } })
    const notification = (await client.next()) as {
      method?: string
      params?: { sessionId?: string; update?: { sessionUpdate?: string; configOptions?: SessionConfigOption[] } }
    }
    assert.equal(notification.method, 'session/update')
    assert.equal(notification.params?.sessionId, sessionId)
    assert.equal(notification.params?.update?.sessionUpdate, 'config_option_update')
    assert.deepEqual(notification.params?.update?.configOptions, optionsB)

    // Wrong Session and invalid option values stay fail-closed with no write.
    client.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/set_config_option',
      params: { sessionId: 'other-session', configId: 'model', value: '["p1","b"]' },
    })
    const wrongSession = (await client.next()) as { error?: { code: number; data?: { code?: string; sessionId?: string } } }
    assert.equal(wrongSession.error?.code, -32002)
    assert.equal(wrongSession.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    assert.equal(wrongSession.error?.data?.sessionId, 'other-session')
    client.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/set_config_option',
      params: { sessionId, configId: 'other', value: 'x' },
    })
    const invalidConfig = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(invalidConfig.error?.code, -32602)
    assert.equal(invalidConfig.error?.data?.code, 'LOCAL_ACP_CONFIG_INVALID_OPTION')
    client.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'session/set_config_option',
      params: { sessionId, configId: 'model', type: 'boolean', value: true },
    })
    const booleanConfig = (await client.next()) as { error?: { code: number; data?: { code?: string } } }
    assert.equal(booleanConfig.error?.code, -32602)
    assert.equal(booleanConfig.error?.data?.code, 'LOCAL_ACP_MODEL_INVALID_OPTION')
    // The unknown config id is refused by the config router before any model
    // authority; the boolean-typed model request still reaches the model
    // service, which keeps its own invalid-option classification.
    assert.equal(fake.modelSelections.length, 2, 'only a model/thought_level request reaches the model service')

    // `session/resume` returns the same complete current option state.
    client.send({ jsonrpc: '2.0', id: 7, method: 'session/close', params: { sessionId } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 8, method: 'session/resume', params: { sessionId, cwd: '/host/proj' } })
    const resumed = (await client.next()) as { result?: { configOptions?: SessionConfigOption[] } }
    assert.deepEqual(resumed.result?.configOptions, optionsB)

    // After close the old View can no longer mutate the Session.
    client.send({ jsonrpc: '2.0', id: 9, method: 'session/close', params: { sessionId } })
    assert.deepEqual(((await client.next()) as { result?: unknown }).result, {})
    client.send({ jsonrpc: '2.0', id: 10, method: 'session/set_config_option', params: { sessionId, configId: 'model', value: '["p1","b"]' } })
    const closed = (await client.next()) as { error?: { code: number; data?: { code?: string; sessionId?: string } } }
    assert.equal(closed.error?.code, -32002)
    assert.equal(closed.error?.data?.code, 'LOCAL_ACP_VIEW_NOT_OWNED')
    assert.equal(closed.error?.data?.sessionId, sessionId)
  } finally {
    client.close()
  }
})


test('a model reply whose fenced cut is invalidated during its held read returns the newest complete state first', async t => {
  const { scope } = newScope(t)
  const optionsA = configOptionsFor('["p1","a"]')
  const optionsB = configOptionsFor('["p1","b"]')
  const optionsC = configOptionsFor('["p1","c"]')
  let current = optionsA
  let hold = false
  let reads = 0
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const held = new Promise<void>(resolve => { started = resolve })
  const fake = makeFakeAccess({
    modelOptions: async () => {
      if (hold && reads++ === 0) {
        started()
        await gate
        return optionsA // deliberately the stale pre-invalidation snapshot
      }
      return current
    },
    selectModelOnly: async () => {
      current = optionsB
      return optionsB
    },
  })
  fake.seed('session-reply-order', '/host/proj')
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
    hold = true
    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_config_option',
      params: { sessionId, configId: 'model', value: '["p1","b"]' },
    })
    await held
    const agent = fake.agentOf(sessionId)
    const facts = fake.facts()
    assert.ok(agent !== undefined && facts !== undefined)
    current = optionsC
    facts.onSessionEvent(agent.session, { seq: 1, type: 'model/selection', data: { provider: 'p1', model: 'c' } })
    release()
    let response: { id?: number; result?: { configOptions?: SessionConfigOption[] } } | undefined
    let notification: {
      method?: string
      params?: { update?: { sessionUpdate?: string; configOptions?: SessionConfigOption[] } }
    } | undefined
    for (let seen = 0; seen < 2; seen++) {
      const message = (await client.next()) as typeof response & typeof notification
      if (message?.id === 3) {
        assert.equal(response, undefined, 'exactly one setter response')
        response = message
      } else {
        assert.equal(notification, undefined, 'exactly one config notification')
        notification = message
      }
    }
    assert.deepEqual(response?.result?.configOptions, optionsC,
      'the response must carry the newest complete cut after exactly one bounded retry')
    assert.equal(notification?.method, 'session/update')
    assert.equal(notification?.params?.update?.sessionUpdate, 'config_option_update')
    assert.deepEqual(notification?.params?.update?.configOptions, optionsC,
      'both frames carry the newest complete state; neither may deliver the stale B cut')
  } finally {
    client.close()
  }
})


test('ACP v1 modes and the negotiated boolean config option are served on the official session policy authority', async t => {
  const { scope } = newScope(t)
  const options = configOptionsFor('["p1","a"]')
  let policy: AcpSessionPolicyState = { mode: 'default', agentTeam: false }
  const writes: AcpSessionPolicyRequest[] = []
  const fake = makeFakeAccess({
    modelOptions: async () => options,
    sessionPolicy: () => policy,
    selectSessionPolicy: async (_agent, _session, request) => {
      writes.push(request)
      policy = request.kind === 'mode'
        ? { ...policy, mode: request.mode }
        : { ...policy, agentTeam: request.enabled }
      return policy
    },
  })
  fake.seed('session-modes', '/host/modes')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1, 1, { session: { configOptions: { boolean: {} } } })
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/modes', mcpServers: [] } })
    const created = (await client.next()) as {
      result?: { sessionId?: string; modes?: { currentModeId?: string; availableModes?: Array<{ id: string }> }; configOptions?: SessionConfigOption[] }
    }
    const sessionId = created.result?.sessionId as string
    assert.equal(created.result?.modes?.currentModeId, 'default')
    assert.deepEqual(created.result?.modes?.availableModes?.map(mode => mode.id), ['default', 'plan'])
    const initialIds = (created.result?.configOptions ?? []).map(option => option.id)
    assert.deepEqual(initialIds, ['model', 'mode', 'agent_team'], 'all three authorities are projected in fixed order')

    client.send({ jsonrpc: '2.0', id: 3, method: 'session/set_mode', params: { sessionId, modeId: 'plan' } })
    const frames: Array<Record<string, any>> = []
    for (let index = 0; index < 3; index++) frames.push(await client.next() as Record<string, any>)
    const response = frames.find(frame => frame.id === 3)
    assert.deepEqual(response?.result, {}, 'the standard set_mode response is empty')
    const modeUpdates = frames.filter(frame => frame.params?.update?.sessionUpdate === 'current_mode_update')
    assert.equal(modeUpdates.length, 1)
    assert.equal(modeUpdates[0]?.params?.update?.currentModeId, 'plan')
    const configUpdates = frames.filter(frame => frame.params?.update?.sessionUpdate === 'config_option_update')
    assert.equal(configUpdates.length, 1, 'set_mode also refreshes the complete config list')
    const configMode = (configUpdates[0]?.params?.update?.configOptions as SessionConfigOption[])
      .find(option => option.id === 'mode')
    assert.equal((configMode as { currentValue?: string }).currentValue, 'plan')
    assert.deepEqual(writes, [{ kind: 'mode', mode: 'plan' }])

    client.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/set_config_option',
      params: { sessionId, configId: 'agent_team', type: 'boolean', value: true },
    })
    const teamFrames: Array<Record<string, any>> = []
    for (let index = 0; index < 2; index++) teamFrames.push(await client.next() as Record<string, any>)
    const teamResponse = teamFrames.find(frame => frame.id === 4)
    const teamOptions = teamResponse?.result?.configOptions as SessionConfigOption[]
    assert.equal((teamOptions.find(option => option.id === 'agent_team') as { currentValue?: boolean }).currentValue, true)
    const teamUpdate = teamFrames.find(frame => frame.params?.update?.sessionUpdate === 'config_option_update')
    assert.ok(teamUpdate !== undefined, 'the boolean write refreshes the full config list too')
    assert.deepEqual(writes, [{ kind: 'mode', mode: 'plan' }, { kind: 'agent-team', enabled: true }])
  } finally {
    client.close()
  }
})

test('legacy session/set_mode rejects an unknown mode id with the config invalid-option classification', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    modelOptions: async () => configOptionsFor('["p1","a"]'),
    sessionPolicy: () => ({ mode: 'default' }),
  })
  fake.seed('session-bad-mode', '/host/modes')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-bad-mode', cwd: '/host/modes' } })
    await client.next()
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/set_mode', params: { sessionId: 'session-bad-mode', modeId: 'x' } })
    const invalid = (await client.next()) as { id?: number; error?: { code?: number; data?: { code?: string } } }
    assert.equal(invalid.id, 3)
    assert.equal(invalid.error?.code, -32602)
    assert.equal(invalid.error?.data?.code, 'LOCAL_ACP_CONFIG_INVALID_OPTION')
  } finally {
    client.close()
  }
})

test('model options and config updates stay scoped to their Session on one socket', async t => {
  const { scope } = newScope(t)
  const optionsA = configOptionsFor('["p1","a"]')
  const optionsB = configOptionsFor('["p1","b"]')
  const selected: Array<{ readonly agent: string; readonly value: string }> = []
  const current = new Map<string, SessionConfigOption[]>([['session-model-a', optionsA]])
  const fake = makeFakeAccess({
    modelOptions: async agent => current.get(String(agent.id)) ?? optionsB,
    selectModelOnly: async (agent, _session, request) => {
      selected.push({ agent: String(agent.id), value: String(request.value) })
      const next = agent.id === 'session-model-a' ? optionsB : optionsA
      current.set(String(agent.id), next)
      return next
    },
  })
  fake.seed('session-model-a', '/host/a')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-model-a', cwd: '/host/a' } })
    const resumedA = (await client.next()) as { result?: { configOptions?: SessionConfigOption[] } }
    assert.deepEqual(resumedA.result?.configOptions, optionsA)
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/host/b', mcpServers: [] } })
    const createdB = (await client.next()) as { result?: { sessionId?: string; configOptions?: SessionConfigOption[] } }
    const sessionB = createdB.result?.sessionId as string
    assert.deepEqual(createdB.result?.configOptions, optionsB)

    client.send({ jsonrpc: '2.0', id: 4, method: 'session/set_config_option', params: { sessionId: 'session-model-a', configId: 'model', value: '["p1","a2"]' } })
    const selectedA = (await client.next()) as { id?: number; result?: { configOptions?: SessionConfigOption[] } }
    assert.equal(selectedA.id, 4)
    assert.deepEqual(selectedA.result?.configOptions, optionsB)
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/set_config_option', params: { sessionId: sessionB, configId: 'model', value: '["p1","b2"]' } })
    const selectedB = (await client.next()) as { id?: number; result?: { configOptions?: SessionConfigOption[] } }
    assert.equal(selectedB.id, 5)
    assert.deepEqual(selectedB.result?.configOptions, optionsA)
    assert.deepEqual(selected, [
      { agent: 'session-model-a', value: '["p1","a2"]' },
      { agent: sessionB, value: '["p1","b2"]' },
    ])

    const facts = fake.facts()
    const agentA = fake.agentOf('session-model-a')
    const agentB = fake.agentOf(sessionB)
    assert.ok(facts !== undefined && agentA !== undefined && agentB !== undefined)
    facts.onSessionEvent(agentA.session, { seq: 41, type: 'model/selection', data: { provider: 'p1', model: 'a2' } })
    const notificationA = (await client.next()) as { method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string; configOptions?: SessionConfigOption[] } } }
    assert.equal(notificationA.params?.sessionId, 'session-model-a')
    assert.deepEqual(notificationA.params?.update?.configOptions, optionsB)
    facts.onSessionEvent(agentB.session, { seq: 42, type: 'model/selection', data: { provider: 'p1', model: 'b2' } })
    const notificationB = (await client.next()) as { method?: string; params?: { sessionId?: string; update?: { configOptions?: SessionConfigOption[] } } }
    assert.equal(notificationB.params?.sessionId, sessionB)
    assert.deepEqual(notificationB.params?.update?.configOptions, optionsA)
  } finally {
    client.close()
  }
})

test('the initial attach response is submitted before any config notification after an invalidation during its read', async t => {
  const { scope } = newScope(t)
  let catalogStarted!: () => void
  let releaseCatalog!: () => void
  const started = new Promise<void>(resolveStarted => { catalogStarted = resolveStarted })
  const catalogGate = new Promise<void>(resolveCatalog => { releaseCatalog = resolveCatalog })
  let reads = 0
  let model = '["p1","a"]'
  const fake = makeFakeAccess({
    modelOptions: async () => {
      reads += 1
      if (reads === 1) {
        catalogStarted()
        await catalogGate
      }
      return configOptionsFor(model)
    },
  })
  fake.seed('session-attach-order', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-attach-order', cwd: '/host/proj' } })
    await started
    const agent = fake.agentOf('session-attach-order')
    const facts = fake.facts()
    assert.ok(agent !== undefined && facts !== undefined)
    model = '["p1","a2"]'
    facts.onSessionEvent(agent.session, { seq: 1, type: 'model/selection', data: { provider: 'p1', model: 'a2' } })
    releaseCatalog()
    const response = (await client.next()) as { id?: number; result?: { configOptions?: SessionConfigOption[] } }
    assert.equal(response.id, 2, 'the attach response is never preceded by a config notification')
    assert.deepEqual(response.result?.configOptions, configOptionsFor('["p1","a2"]'))
    // The invalidation observed during the held read survives even though the
    // fenced response already carries the newest value; the deferred attach
    // refresh closes the last dirty fact without a third external event.
    const notification = (await client.next()) as {
      method?: string
      params?: { sessionId?: string; update?: { sessionUpdate?: string; configOptions?: SessionConfigOption[] } }
    }
    assert.equal(notification.method, 'session/update')
    assert.equal(notification.params?.sessionId, 'session-attach-order')
    assert.equal(notification.params?.update?.sessionUpdate, 'config_option_update')
    assert.deepEqual(notification.params?.update?.configOptions, configOptionsFor('["p1","a2"]'))
  } finally {
    client.close()
  }
})

test('a concurrent close during resume config read propagates STALE instead of a false success', async t => {
  const { scope } = newScope(t)
  let catalogStarted!: () => void
  const started = new Promise<void>(resolveStarted => { catalogStarted = resolveStarted })
  let releaseCatalog!: () => void
  const catalogGate = new Promise<void>(resolveCatalog => { releaseCatalog = resolveCatalog })
  let reads = 0
  const fake = makeFakeAccess({
    modelOptions: async () => {
      reads += 1
      if (reads === 1) {
        catalogStarted()
        await catalogGate
      }
      return configOptionsFor('["p1","a"]')
    },
  })
  fake.seed('session-close-race', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-close-race', cwd: '/host/proj' } })
    await started
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: 'session-close-race' } })
    const closed = (await client.next()) as { id?: number; result?: unknown }
    assert.equal(closed.id, 3)
    assert.deepEqual(closed.result, {})
    releaseCatalog()
    const stale = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(stale.id, 2)
    assert.equal(stale.error?.code, -32042)
    assert.equal(stale.error?.data?.code, 'LOCAL_ACP_CONFIG_STALE',
      'the old resume must not report a successful attachment after its View closed')

    // The same connection may attach a NEW View; it reads the catalog cleanly.
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 'session-close-race', cwd: '/host/proj' } })
    const resumed = (await client.next()) as { id?: number; result?: { configOptions?: SessionConfigOption[] } }
    assert.equal(resumed.id, 4)
    assert.deepEqual(resumed.result?.configOptions, configOptionsFor('["p1","a"]'))
  } finally {
    client.close()
  }
})

test('an omitted initial full list retains its dirty fact and converges to the newest complete update', async t => {
  const { scope } = newScope(t)
  let catalogStarted!: () => void
  let releaseCatalog!: () => void
  const started = new Promise<void>(resolveStarted => { catalogStarted = resolveStarted })
  const catalogGate = new Promise<void>(resolveCatalog => { releaseCatalog = resolveCatalog })
  let reads = 0
  let model = '["p1","a"]'
  const fake = makeFakeAccess({
    sessionPolicy: () => ({ mode: 'default' }),
    modelOptions: async () => {
      reads += 1
      if (reads === 1) {
        catalogStarted()
        await catalogGate
      }
      if (reads <= 2) throw new AcpModelError('LOCAL_ACP_MODEL_UNAVAILABLE', 'catalog unavailable', -32042)
      return configOptionsFor(model)
    },
  })
  fake.seed('session-omitted-dirty', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-omitted-dirty', cwd: '/host/proj' } })
    await started
    const agent = fake.agentOf('session-omitted-dirty')
    const facts = fake.facts()
    assert.ok(agent !== undefined && facts !== undefined)
    model = '["p1","newest"]'
    facts.onSessionEvent(agent.session, { seq: 1, type: 'model/selection', data: { provider: 'p1', model: 'newest' } })
    releaseCatalog()
    const response = (await client.next()) as { id?: number; result?: { modes?: unknown; configOptions?: SessionConfigOption[] } }
    assert.equal(response.id, 2, 'the omitted attach response is still first')
    assert.equal(response.result?.configOptions, undefined, 'the failed optional catalog omits the full list')
    assert.ok(response.result?.modes !== undefined, 'the independently readable legacy modes are kept')
    const notification = (await client.next()) as {
      method?: string
      params?: { sessionId?: string; update?: { sessionUpdate?: string; configOptions?: SessionConfigOption[] } }
    }
    assert.equal(notification.method, 'session/update')
    assert.equal(notification.params?.sessionId, 'session-omitted-dirty')
    assert.equal(notification.params?.update?.sessionUpdate, 'config_option_update')
    assert.equal(notification.params?.update?.configOptions?.[0]?.currentValue, '["p1","newest"]',
      'the omitted dirty cut converges to the newest complete list without another external event')
    assert.equal(notification.params?.update?.configOptions?.find(option => option.id === 'mode')?.currentValue, 'default')
  } finally {
    client.close()
  }
})

test('a rejected optional catalog read after concurrent close propagates STALE, never a false attach', async t => {
  const { scope } = newScope(t)
  let catalogStarted!: () => void
  const started = new Promise<void>(resolveStarted => { catalogStarted = resolveStarted })
  let releaseCatalog!: () => void
  const catalogGate = new Promise<void>(resolveCatalog => { releaseCatalog = resolveCatalog })
  let reads = 0
  const fake = makeFakeAccess({
    modelOptions: async () => {
      reads += 1
      if (reads === 1) {
        catalogStarted()
        await catalogGate
        throw new AcpModelError('LOCAL_ACP_MODEL_UNAVAILABLE', 'catalog unavailable', -32042)
      }
      return configOptionsFor('["p1","a"]')
    },
  })
  fake.seed('session-reject-race', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-reject-race', cwd: '/host/proj' } })
    await started
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: 'session-reject-race' } })
    const closed = (await client.next()) as { id?: number; result?: unknown }
    assert.equal(closed.id, 3)
    assert.deepEqual(closed.result, {})
    releaseCatalog()
    const stale = (await client.next()) as { id?: number; error?: { code: number; data?: { code?: string } } }
    assert.equal(stale.id, 2)
    assert.equal(stale.error?.code, -32042)
    assert.equal(stale.error?.data?.code, 'LOCAL_ACP_CONFIG_STALE',
      'a stale original View must win over the optional catalog-unavailable fallback')

    client.send({ jsonrpc: '2.0', id: 4, method: 'session/resume', params: { sessionId: 'session-reject-race', cwd: '/host/proj' } })
    const resumed = (await client.next()) as { id?: number; result?: { configOptions?: SessionConfigOption[] } }
    assert.equal(resumed.id, 4)
    assert.deepEqual(resumed.result?.configOptions, configOptionsFor('["p1","a"]'))
  } finally {
    client.close()
  }
})

test('an unexpected optional-model-read error never becomes a successful attach', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    modelOptions: async () => { throw new Error('unexpected model projection failure') },
  })
  fake.seed('session-generic-error', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'session-generic-error', cwd: '/host/proj' } })
    const response = (await client.next()) as { id?: number; result?: unknown; error?: { code?: number } }
    assert.equal(response.id, 2)
    assert.ok(response.error !== undefined, 'an unexpected Host read error must not be swallowed')
    assert.equal(response.result, undefined, 'the Session must not be reported as successfully attached')
  } finally {
    client.close()
  }
})

// ---------------------------------------------------------------------------
// G-ACP2-PR1: the standard ACP v1 form elicitation channel over the real socket.
// ---------------------------------------------------------------------------

/** Read wire messages until BOTH named observations arrived (bounded). */
async function nextUntil(
  client: RawClient,
  matches: (message: Record<string, unknown>) => string | undefined,
  expected: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const seen: Record<string, Record<string, unknown>> = {}
  for (let attempt = 0; attempt < 24 && Object.keys(seen).length < expected.length; attempt += 1) {
    const message = (await client.next()) as Record<string, unknown>
    const key = matches(message)
    if (key !== undefined && expected.includes(key)) seen[key] = message
  }
  assert.deepEqual(Object.keys(seen).sort(), [...expected].sort(), `all expected wire messages arrived: ${JSON.stringify(seen)}`)
  return seen
}

/** The standard JSON-RPC method name of one reverse elicitation request. */
const ELICITATION_CREATE = 'elicitation/create'

test('G-ACP2-PR1 QU-01 wire: an owned question becomes ONE standard form elicitation/create and the accepted answer returns to the waterfall', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    questionService: true,
    questionSnapshot: () => ({ kind: 'current', continued: [], settled: new Set() }),
    answerContinued: () => ({ kind: 'queued' }),
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1, 1, { elicitation: { form: {} } })
    assert.equal(((await client.next()) as { result?: { protocolVersion?: number } }).result?.protocolVersion, 1)
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const created = (await client.next()) as { result?: { sessionId?: string } }
    const sessionId = created.result?.sessionId
    assert.equal(typeof sessionId, 'string')
    const agent = fake.agentOf(sessionId!)!
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'ask me' }] } })
    const dispatched = await waitForFact(() => fake.prompts[0], 'the owned prompt dispatch')
    assert.equal(dispatched.sessionId, sessionId)
    const facts = fake.facts()
    assert.ok(facts !== undefined)
    const message = { id: 'm-owned', source: { kind: 'user', rpcId: dispatched.requestId } }
    facts.onInboxInserted(agent, message)
    fake.turnFence.openTurnStartSeq = 40
    fake.turnFence.lastTurn = 4
    facts.onInboxClaimed(agent, message, 4)

    const answerPromise = facts.onQuestionRequest(
      {
        agent,
        questions: [
          { id: 'native-one', question: 'Which one?', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] },
          { id: 'native-two', question: 'Anything else?' },
        ],
        wait: { callId: 'call-question' },
      },
      async () => ({ answers: [] }),
    )
    const wire = (await client.next()) as {
      readonly id?: number
      readonly method?: string
      readonly params?: Record<string, unknown>
    }
    assert.equal(wire.method, ELICITATION_CREATE)
    assert.equal(wire.params?.['mode'], 'form')
    assert.equal(wire.params?.['sessionId'], sessionId)
    assert.equal(wire.params?.['toolCallId'], 'call-question')
    assert.equal(typeof wire.params?.['message'], 'string')
    const schema = wire.params?.['requestedSchema'] as {
      readonly type?: string
      readonly required?: readonly string[]
      readonly properties?: Record<string, Record<string, unknown>>
    }
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, [])
    assert.deepEqual(Object.keys(schema.properties ?? {}), ['q0', 'q0__other', 'q1'])
    assert.deepEqual(schema.properties?.['q0']?.['oneOf'], [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }])
    assert.equal(schema.properties?.['q1']?.['type'], 'string')
    // The client's standard response travels back to the ORIGINAL waterfall.
    client.send({ jsonrpc: '2.0', id: wire.id, result: { action: 'accept', content: { q0: 'B', q1: 'late text' } } })
    assert.deepEqual(await answerPromise, {
      answers: [
        { id: 'native-one', selected: ['B'] },
        { id: 'native-two', selected: [], custom: 'late text' },
      ],
    })
    // The owned prompt then settles on its own durable facts.
    facts.onSessionEvent(agent.session, {
      seq: 1,
      type: 'assistant/message',
      data: { turn: 4, step: 1, message: { id: 'm-answer', content: [{ type: 'text', text: 'done' }] } },
    })
    facts.onSessionEvent(agent.session, { seq: 2, type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    const settled = await nextUntil(client, message => {
      if (message['id'] === 3) return 'prompt'
      if (message['method'] === 'session/update') return 'update'
      return undefined
    }, ['prompt'])
    assert.deepEqual((settled['prompt'] as { result?: { stopReason?: string } }).result, { stopReason: 'end_turn' })
  } finally {
    client.close()
  }
})

test('G-ACP2-PR1 QU-01 wire: a connection WITHOUT form capability never receives an elicitation/create and the owned question fails closed', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({ questionService: true })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1) // no elicitation capability negotiated
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const sessionId = ((await client.next()) as { result?: { sessionId?: string } }).result?.sessionId
    const agent = fake.agentOf(sessionId!)!
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'ask me' }] } })
    const dispatched = await waitForFact(() => fake.prompts[0], 'the owned prompt dispatch')
    const facts = fake.facts()!
    const message = { id: 'm-owned', source: { kind: 'user', rpcId: dispatched.requestId } }
    facts.onInboxInserted(agent, message)
    fake.turnFence.openTurnStartSeq = 41
    fake.turnFence.lastTurn = 5
    facts.onInboxClaimed(agent, message, 5)
    let delegated = 0
    await assert.rejects(
      facts.onQuestionRequest(
        { agent, questions: [{ id: 'native', question: 'q?', options: [{ label: 'A' }] }] },
        async () => { delegated += 1; return { answers: [] } },
      ),
      (error: unknown) => error instanceof LocalAcpViewError && error.code === 'LOCAL_ACP_QUESTION_UNAVAILABLE',
    )
    assert.equal(delegated, 0, 'an ACP-owned question is never delegated to another answerer')
    assert.equal(await client.silent(250), true, 'no reverse elicitation request was ever sent on this connection')
  } finally {
    client.close()
  }
})

test('G-ACP2-PR1 QU-04 wire: session/resume offers the official continued question on the SAME connection after the response', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    questionService: true,
    questionSnapshot: () => ({
      kind: 'current',
      continued: [{ callId: 'call-resumed', questions: [{ id: 'native', question: 'still answerable?', options: [{ label: 'yes' }] }] }],
      settled: new Set(),
    }),
    answerContinued: () => ({ kind: 'queued' }),
  })
  fake.seed('S-resume', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1, 1, { elicitation: { form: {} } })
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'S-resume', cwd: '/host/proj' } })
    const observed = await nextUntil(client, message => {
      if (message['id'] === 2) return 'resume'
      if (message['method'] === ELICITATION_CREATE) return 'form'
      return undefined
    }, ['resume', 'form'])
    assert.deepEqual((observed['resume'] as { result?: unknown }).result, {})
    const form = observed['form'] as { readonly id?: number; readonly params?: Record<string, unknown> }
    assert.equal(form.params?.['sessionId'], 'S-resume')
    assert.equal(form.params?.['toolCallId'], 'call-resumed')
    client.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { q0: 'yes' } } })
    for (let wait = 0; wait < 20 && fake.continuedAnswers.length === 0; wait += 1) {
      await new Promise(resolveWait => setTimeout(resolveWait, 10))
    }
    assert.deepEqual(fake.continuedAnswers, [{
      callId: 'call-resumed',
      answer: { answers: [{ id: 'native', selected: ['yes'] }] },
    }])
  } finally {
    client.close()
  }
})

test('G-ACP2-PR1 LC-01 wire: a physical socket end releases the outstanding form of that connection only', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    questionService: true,
    questionSnapshot: () => ({ kind: 'current', continued: [], settled: new Set() }),
    answerContinued: () => ({ kind: 'queued' }),
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  initialize(client, 1, 1, { elicitation: { form: {} } })
  await client.next()
  client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
  const sessionId = ((await client.next()) as { result?: { sessionId?: string } }).result?.sessionId
  const agent = fake.agentOf(sessionId!)!
  client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'ask me' }] } })
  const dispatched = await waitForFact(() => fake.prompts[0], 'the owned prompt dispatch')
  const facts = fake.facts()!
  const message = { id: 'm-owned', source: { kind: 'user', rpcId: dispatched.requestId } }
  facts.onInboxInserted(agent, message)
  fake.turnFence.openTurnStartSeq = 42
  fake.turnFence.lastTurn = 6
  facts.onInboxClaimed(agent, message, 6)
  const answerPromise = facts.onQuestionRequest(
    { agent, questions: [{ id: 'native', question: 'q?', options: [{ label: 'A' }] }] },
    async () => ({ answers: [] }),
  )
  const wire = (await client.next()) as { readonly method?: string }
  assert.equal(wire.method, ELICITATION_CREATE)
  // The connection dies with the form outstanding: the reverse request is
  // aborted with this claim, and nothing is fabricated as an answer.
  client.close()
  await assert.rejects(answerPromise)
  assert.deepEqual(fake.continuedAnswers, [])
})

test('G-ACP2-PR1 ST-01 wire: transient deltas reach the ACP client before the durable commit and are never re-sent', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess()
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/host/proj', mcpServers: [] } })
    const sessionId = ((await client.next()) as { result?: { sessionId?: string } }).result?.sessionId
    const agent = fake.agentOf(sessionId!)!
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'stream' }] } })
    const dispatched = await waitForFact(() => fake.prompts[0], 'the owned prompt dispatch')
    const facts = fake.facts()!
    const message = { id: 'm-stream', source: { kind: 'user', rpcId: dispatched.requestId } }
    facts.onInboxInserted(agent, message)
    fake.turnFence.openTurnStartSeq = 60
    fake.turnFence.lastTurn = 7
    facts.onInboxClaimed(agent, message, 7)

    const attemptId = 'wire:1'
    facts.onAssistantStream(agent, { type: 'start', attemptId, revision: 1, turn: 7, step: 1 })
    facts.onAssistantStream(agent, { type: 'chunk', attemptId, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } })
    facts.onAssistantStream(agent, { type: 'chunk', attemptId, revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: 'b' } })
    const first = (await client.next()) as { readonly method?: string; readonly params?: { readonly update?: { readonly sessionUpdate?: string; readonly content?: { readonly text?: string }; readonly messageId?: string } } }
    const second = (await client.next()) as typeof first
    assert.equal(first.method, 'session/update')
    assert.equal(first.params?.update?.sessionUpdate, 'agent_message_chunk')
    assert.equal(first.params?.update?.content?.text, 'a')
    assert.equal(second.params?.update?.content?.text, 'b')
    const streamedId = first.params?.update?.messageId
    assert.equal(typeof streamedId, 'string')
    assert.equal(second.params?.update?.messageId, streamedId)
    assert.equal(await client.silent(120), true, 'the durable message has not committed yet')

    facts.onSessionEvent(agent.session, {
      seq: 1,
      type: 'assistant/message',
      data: { turn: 7, step: 1, message: { id: 'm-durable', content: [{ type: 'text', text: 'ab' }] } },
    })
    facts.onAssistantStream(agent, {
      type: 'end', attemptId, revision: 4, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
    })
    assert.equal(await client.silent(120), true, 'the durable text was already delivered: no duplicate update')
    facts.onSessionEvent(agent.session, { seq: 2, type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    const settled = (await client.next()) as { readonly id?: number; readonly result?: { readonly stopReason?: string } }
    assert.equal(settled.id, 3)
    assert.deepEqual(settled.result, { stopReason: 'end_turn' })
  } finally {
    client.close()
  }
})

// ───────────────────── G-ACP2-PR2 list/load over the real socket ────────────

test('G-ACP2-PR2 LIST-01 wire: the authorized root roster is listed without activating an Agent', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    sessionRead: true,
    sessionRows: [
      { sessionId: 's-root', cwd: '/host/proj', updatedAt: 1_700_000_000_000, title: 'Real title' },
      { sessionId: 's-child', cwd: '/host/proj', updatedAt: 1_700_000_000_500, origin: 'subagent' },
      { sessionId: 's-cold', cwd: '/host/other', updatedAt: 1_600_000_000_000 },
    ],
  })
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    const init = (await client.next()) as {
      result?: { agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: { list?: unknown } } }
    }
    assert.equal(init.result?.agentCapabilities?.loadSession, true, 'a Host with the read seams advertises session/load')
    assert.notEqual(init.result?.agentCapabilities?.sessionCapabilities?.list, undefined, 'and session/list')

    // An uninitialized connection never reaches the handler (SDK gate).
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} })
    const listed = (await client.next()) as {
      result?: { sessions?: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>; nextCursor?: string }
    }
    assert.deepEqual(listed.result?.sessions, [
      {
        sessionId: 's-root',
        cwd: '/host/proj',
        title: 'Real title',
        updatedAt: new Date(1_700_000_000_000).toISOString(),
      },
      {
        sessionId: 's-cold',
        cwd: '/host/other',
        updatedAt: new Date(1_600_000_000_000).toISOString(),
      },
    ], 'the subagent row is never a top-level session and titles come from the official fold')
    assert.equal(fake.sessionListReads(), 1)
    assert.deepEqual(fake.resolveCalls(), [], 'listing never resolves or activates an Agent')

    // A cwd filter narrows to its exact authorized rows.
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/list', params: { cwd: '/host/other' } })
    const filtered = (await client.next()) as { result?: { sessions?: Array<{ sessionId: string }> } }
    assert.deepEqual(filtered.result?.sessions?.map(row => row.sessionId), ['s-cold'])

    // A relative cwd and a malformed cursor are the standard invalid-params refusal.
    client.send({ jsonrpc: '2.0', id: 4, method: 'session/list', params: { cwd: 'relative' } })
    const badCwd = (await client.next()) as { error?: { code?: number; data?: { code?: string } } }
    assert.equal(badCwd.error?.code, -32602)
    assert.equal(badCwd.error?.data?.code, 'LOCAL_ACP_LIST_INVALID_REQUEST')
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/list', params: { cursor: 'not-a-cursor' } })
    const badCursor = (await client.next()) as { error?: { code?: number; data?: { code?: string } } }
    assert.equal(badCursor.error?.code, -32602)
    assert.equal(badCursor.error?.data?.code, 'LOCAL_ACP_LIST_INVALID_REQUEST')
    assert.deepEqual(fake.resolveCalls(), [], 'no list refusal ever activates a Session')
  } finally {
    client.close()
  }
})

test('G-ACP2-PR2 LOAD-01 wire: session/load replays the canonical history before its response, while resume replays none', async t => {
  const { scope } = newScope(t)
  const fake = makeFakeAccess({
    sessionRead: true,
    sessionHistory: sessionId => ({
      header: { sessionId, cwd: '/host/proj' },
      events: [
        { seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'earlier question' }], role: 'user' } },
        { seq: 1, type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'text', text: 'earlier answer' }] } } },
      ],
    }),
  })
  fake.seed('loaded', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()

    // First a plain resume of the same Session: it must never replay history.
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'loaded', cwd: '/host/proj' } })
    const resumed = (await client.next()) as { result?: unknown }
    assert.deepEqual(resumed.result, {})
    client.send({ jsonrpc: '2.0', id: 3, method: 'session/list', params: {} })
    const probe = (await client.next()) as { id?: number; result?: unknown; method?: string }
    assert.equal(probe.id, 3, 'no session/update frame is interleaved after a resume')
    assert.equal(probe.method, undefined)
    assert.equal(fake.sessionHistoryReads().length, 0, 'resume never reads canonical history')

    client.send({ jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: 'loaded' } })
    await client.next()

    // Now load the SAME Session: every historical fact arrives BEFORE the response.
    client.send({ jsonrpc: '2.0', id: 5, method: 'session/load', params: { sessionId: 'loaded', cwd: '/host/proj', mcpServers: [] } })
    const frames: Array<{ id?: number; method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } }; result?: unknown; error?: unknown }> = []
    for (;;) {
      const frame = (await client.next()) as { id?: number; method?: string }
      frames.push(frame as never)
      if (frame.id === 5) break
    }
    const updates = frames.filter(frame => frame.method === 'session/update')
    assert.deepEqual(updates.map(frame => frame.params?.update?.sessionUpdate), ['user_message_chunk', 'agent_message_chunk'])
    assert.deepEqual(updates.map(frame => frame.params?.update?.content?.text), ['earlier question', 'earlier answer'])
    assert.equal(frames[frames.length - 1]?.id, 5, 'the response is the LAST frame: the history was fully drained first')
    assert.deepEqual(frames[frames.length - 1]?.result, {})
    assert.deepEqual(fake.sessionHistoryReads(), ['loaded'])

    // The SAME connection may load its own settled View again: a fresh claim
    // generation replays the complete canonical history for THIS request again
    // (no closed connection, no leaked dedupe state, no stale history).
    client.send({ jsonrpc: '2.0', id: 6, method: 'session/load', params: { sessionId: 'loaded', cwd: '/host/proj', mcpServers: [] } })
    const reloadFrames: Array<{ id?: number; method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } }; result?: unknown; error?: unknown }> = []
    for (;;) {
      const frame = (await client.next()) as { id?: number; method?: string }
      reloadFrames.push(frame as never)
      if (frame.id === 6) break
    }
    const reloadUpdates = reloadFrames.filter(frame => frame.method === 'session/update')
    assert.deepEqual(reloadUpdates.map(frame => frame.params?.update?.sessionUpdate), ['user_message_chunk', 'agent_message_chunk'],
      'the repeat load replays the whole history again instead of reusing the first load')
    assert.deepEqual(reloadUpdates.map(frame => frame.params?.update?.content?.text), ['earlier question', 'earlier answer'])
    assert.equal(reloadFrames[reloadFrames.length - 1]?.id, 6, 'the repeat load also answers only after its ordered drain')
    assert.deepEqual(reloadFrames[reloadFrames.length - 1]?.error, undefined)
    assert.deepEqual(fake.sessionHistoryReads(), ['loaded', 'loaded'], 'each load request performs its own canonical read')
  } finally {
    client.close()
  }
})

test('PR4D wire: the connection frozen frame budget bounds a load file and the verified resource precedes the reply', async t => {
  const { scope } = newScope(t)
  const fileId = `sha256:${'d'.repeat(64)}`
  const fileBytes = Uint8Array.from([0x00, 0xff, 0x80, 0x0a, 0x00, 0x41])
  const reads: AcpStoredFileRef[] = []
  const fake = makeFakeAccess({
    sessionRead: true,
    sessionHistory: sessionId => ({
      header: { sessionId, cwd: '/host/proj' },
      events: [{
        seq: 0,
        type: 'assistant/message',
        data: { message: { id: 'a-file', content: [{ type: 'file', attachment: { attachmentId: fileId, name: 'wire file.bin', bytes: fileBytes.byteLength } }] } },
      }],
    }),
    readOutputFile: (ref) => (async function* storeFile() {
      reads.push(ref)
      yield fileBytes
    })(),
  })
  fake.seed('wire-file', '/host/proj')
  const listener = await startLocalAcpListener({ scope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: fake.access })
  t.after(() => listener.close())
  const client = await RawClient.open(listener.socketPath)
  try {
    initialize(client, 1)
    await client.next()
    client.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'wire-file', cwd: '/host/proj', mcpServers: [] } })
    const frames: Array<{ id?: number; method?: string; params?: { update?: { sessionUpdate?: string; content?: { type?: string; resource?: { uri?: string; blob?: string } } } }; result?: unknown }> = []
    for (;;) {
      const frame = (await client.next()) as { id?: number; method?: string }
      frames.push(frame as never)
      if (frame.id === 2) break
    }
    assert.deepEqual(frames.map(frame => frame.method ?? frame.id), ['session/update', 2])
    assert.deepEqual(frames[0]?.params?.update?.sessionUpdate, 'agent_message_chunk')
    assert.equal(frames[0]?.params?.update?.content?.type, 'resource')
    assert.equal(frames[0]?.params?.update?.content?.resource?.uri,
      `dsh-attachment://sha256/${'d'.repeat(64)}/wire%20file.bin`)
    assert.equal(frames[0]?.params?.update?.content?.resource?.blob, Buffer.from(fileBytes).toString('base64'))
    assert.deepEqual(reads, [{ attachmentId: fileId, name: 'wire file.bin', bytes: fileBytes.byteLength }],
      'the real listener budget lets this event read its exact committed reference once')
    assert.deepEqual(frames[frames.length - 1]?.result, {})
  } finally {
    client.close()
  }

  // The legacy text-only connection cap is 256 KiB. A 200,000-byte file
  // encodes to 266,668 Base64 characters (> 262,144), so the real per-connection
  // budget must reach the View and refuse the event BEFORE any Store read.
  const oversizedScope = newScope(t).scope
  let oversizedRead = false
  const oversizedBytes = 200_000
  const oversized = makeFakeAccess({
    sessionRead: true,
    sessionHistory: sessionId => ({
      header: { sessionId, cwd: '/host/proj' },
      events: [{
        seq: 0,
        type: 'assistant/message',
        data: { message: { id: 'a-big', content: [{ type: 'file', attachment: { attachmentId: `sha256:${'e'.repeat(64)}`, name: 'big.bin', bytes: oversizedBytes } }] } },
      }],
    }),
    readOutputFile: () => (async function* mustNotRead() {
      oversizedRead = true
      yield new Uint8Array(oversizedBytes)
    })(),
  })
  oversized.seed('wire-big', '/host/proj')
  const bigListener = await startLocalAcpListener({ scope: oversizedScope, maxConnections: 4, diag: QUIET_DIAG, sessionAccess: oversized.access })
  t.after(() => bigListener.close())
  const bigClient = await RawClient.open(bigListener.socketPath)
  try {
    initialize(bigClient, 1)
    await bigClient.next()
    bigClient.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'wire-big', cwd: '/host/proj', mcpServers: [] } })
    const frame = (await bigClient.next()) as { id?: number; error?: { code?: number; data?: { code?: string } } }
    assert.equal(frame.id, 2)
    assert.equal(frame.error?.code, -32603)
    assert.equal(frame.error?.data?.code, 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE')
    assert.equal(oversizedRead, false, 'the per-connection budget refused the event before its Store read')
  } finally {
    bigClient.close()
  }
})
