/**
 * Host-owned local ACP v1 front door over a pathname Unix domain socket.
 *
 * The one Host process that already owns a canonical profile scope opens a
 * bounded `acp.sock` inside that 0700 scope. The listener speaks ACP v1 with
 * the official `@agentclientprotocol/sdk` stream and request/notification
 * dispatch, but it owns NO Agent, Session or business method in this phase: a
 * valid `initialize` is answered with the installed bundle's own identity and
 * every Session request fails closed with a machine-readable code. The listener
 * is a Host-entry-local lifecycle object (`startLocalAcpListener()`), never a
 * package export and never a second Host authority: the existing entry keeps the
 * one Ready commit (`writeLocalRecord`) and the one shutdown owner, and the
 * listener is bound BEFORE that Ready commit so a published registry never
 * points at a socket that is not yet accepting.
 *
 * The SDK's default NDJSON stream uses an unbounded `LineBuffer` and no output
 * backpressure, so this module wraps the socket in TWO bounded streams: an
 * input reader that scans raw UTF-8 bytes for newlines under a per-frame and a
 * queued-byte cap, and an output writer that refuses a frame or a buffered
 * total above its cap. A cap breach closes only the offending connection.
 *
 * @module app/remote-process/local-acp-listener
 */

import { chmodSync, constants, closeSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentConnection,
} from '@agentclientprotocol/sdk'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { type LocalScope } from './local-scope.ts'
import { runDetached } from '../../runtime/process/tasks.ts'

/** The ACP agent identity this front door advertises (never a copied brand). */
const AGENT_NAME = 'dsh-pi-tui'

/** One input line (a single NDJSON frame) may not exceed one mebibyte. */
const MAX_INPUT_FRAME_BYTES = 1024 * 1024
/**
 * Total unconsumed input on ONE connection is bounded: the current partial
 * line plus complete frames awaiting the SDK plus frames already enqueued into
 * the bounded ReadableStream. All three are summed in bytes against this cap.
 */
const MAX_INPUT_UNCONSUMED_BYTES = 2 * 1024 * 1024
/** At most this many requests may be dispatched concurrently on ONE connection. */
const MAX_PENDING_REQUESTS = 8
/** A single outbound ACP frame may not exceed this many bytes. */
const MAX_OUTPUT_FRAME_BYTES = 256 * 1024
/** Total bytes buffered in the socket awaiting flush on ONE connection. */
const MAX_OUTPUT_BUFFER_BYTES = 256 * 1024
/** How long a short stale-socket connect probe may run before it is treated as inert-unknown. */
const CONNECT_PROBE_TIMEOUT_MS = 500
/** The logical socket file name inside the 0700 scope directory. */
const SOCKET_FILE = 'acp.sock'
/** Owner-only private subdirectory (inside the 0700 scope) where the server is
 *  actually BOUND before its inode is renamed onto the contract path. Node's
 *  server.close() unlink always targets this private dir, so it can never delete
 *  a foreign inode at the contract path. */
const PRIVATE_DIR = '.acp-priv'

const NEWLINE = 0x0a

/** The fixed capacity rejection an over-limit connection receives before it is ended. */
const CAPACITY_ERROR_LINE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: null,
  error: {
    code: -32041,
    message: 'ACP connection capacity exceeded',
    data: { code: 'LOCAL_ACP_CAPACITY_EXCEEDED' },
  },
})}\n`

/**
 * The stable failure codes this module classifies. They are part of the
 * internal Host contract (diagnostics and qualification assert them) and are
 * never a substitute for an ACP method error code.
 */
export type LocalAcpErrorCode =
  | 'LOCAL_ACP_INVALID_MAX_CONNECTIONS'
  | 'LOCAL_ACP_UNSAFE_SOCKET'
  | 'LOCAL_ACP_SOCKET_IN_USE'
  | 'LOCAL_ACP_SOCKET_PATH_UNSUPPORTED'

/** A startup failure that carries one stable local-ACP classification code. */
export class LocalAcpError extends Error {
  /** Stable classification asserted by the Host entry failure record. */
  readonly code: LocalAcpErrorCode

  constructor(code: LocalAcpErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LocalAcpError'
    this.code = code
  }
}

/** The one Host-entry-local lifecycle handle for the bound local ACP listener. */
export interface LocalAcpListener {
  /** The logical socket pathname inside the 0700 scope (never the fd-shortened bind path). */
  readonly socketPath: string
  /** The number of live connections this listener currently owns. */
  readonly connectionCount: () => number
  /**
   * Read-only proof that THIS listener is still valid: the bound `net.Server`
   * is listening AND the logical path still carries this process's exact saved
   * socket inode. Never rebinds, never reclaims a foreign inode and never
   * mutates state — it only observes the authoritative ownership facts.
   */
  isListening(): boolean
  /** Stop accepting, tear down every connection, then retire the server. Idempotent. */
  close(): Promise<void>
  /** Synchronous, inode-identity-checked retirement of THIS process's own socket inode. */
  cleanupSync(): void
}

/** Options for `startLocalAcpListener`; no Context, Agent or Session ever enters here. */
export interface StartLocalAcpListenerOptions {
  readonly scope: LocalScope
  readonly maxConnections: number
  readonly diag: Diag
}

/**
 * Parse the Host start-time connection limit from the raw environment value.
 *
 * Missing means the default of 4. Any present value MUST match `1..16` with no
 * surrounding noise; a malformed value is a hard startup failure so a typo
 * cannot silently widen or collapse the bound.
 */
export function parseAcpMaxConnections(raw: string | undefined): number {
  if (raw === undefined) return 4
  if (raw === '' || !/^(?:[1-9]|1[0-6])$/u.test(raw)) {
    throw new LocalAcpError(
      'LOCAL_ACP_INVALID_MAX_CONNECTIONS',
      'local acp: DSH_PI_TUI_ACP_MAX_CONNECTIONS must be an integer in 1..16',
    )
  }
  return Number(raw)
}

/** A live connection's internal bookkeeping; it never leaves this module. */
interface ConnectionState {
  initialized: boolean
  pendingRequests: number
  closed: boolean
}

/** The listener's accept-time facts shared by the connection factories. */
interface ListenerContext {
  readonly diag: Diag
  readonly bundleVersion: string
  readonly connections: Set<Socket>
  readonly connectionStates: Map<Socket, ConnectionState>
}

/** The ACP Session methods PO-1 must fail closed (business capability does not exist yet). */
function rejectSessionNotReady(): never {
  throw new RequestError(
    -32042,
    'ACP Session operations are not available on this connection',
    { code: 'LOCAL_ACP_SESSION_NOT_READY' },
  )
}

/** Build the bounded input side: raw UTF-8 byte lines under frame/queue caps. */
function createBoundedInput(
  socket: Socket,
  fail: (code: string) => void,
): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = []
  let pending: Buffer = Buffer.alloc(0)
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let finished = false
  let controllerClosed = false
  let paused = false

  const queuedBytes = (): number => queue.reduce((total, frame) => total + frame.byteLength, 0)

  const closeController = (): void => {
    if (controllerClosed || controller === undefined) return
    controllerClosed = true
    try {
      controller.close()
    } catch {
      // Already closed by a concurrent cancel; the reader observes one end.
    }
  }

  const pump = (): void => {
    if (controller === undefined) return
    while (queue.length > 0) {
      if ((controller.desiredSize ?? 1) <= 0) break
      const frame = queue.shift()
      if (frame !== undefined) controller.enqueue(frame)
    }
    if (queue.length > 0) {
      if (!paused) {
        paused = true
        socket.pause()
      }
      return
    }
    if (paused) {
      paused = false
      socket.resume()
    }
    if (finished) closeController()
  }

  const onData = (chunk: Buffer): void => {
    if (finished) return
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    for (;;) {
      const newline = pending.indexOf(NEWLINE)
      if (newline === -1) break
      if (newline > MAX_INPUT_FRAME_BYTES) {
        finished = true
        detach()
        fail('LOCAL_ACP_INPUT_FRAME_TOO_LARGE')
        return
      }
      // Copy line + newline out of the shared buffer so later `subarray` views
      // never alias a buffer that is still being appended to.
      const frame = Uint8Array.prototype.slice.call(pending, 0, newline + 1) as Uint8Array
      pending = pending.subarray(newline + 1)
      queue.push(frame)
    }
    if (pending.length > MAX_INPUT_FRAME_BYTES) {
      finished = true
      detach()
      fail('LOCAL_ACP_INPUT_FRAME_TOO_LARGE')
      return
    }
    // Total unconsumed bytes across the partial line, the frame queue and the
    // stream's own already-enqueued (backpressured) buffer stay under the cap.
    const streamBuffered = controller === undefined
      ? 0
      : Math.max(0, MAX_INPUT_FRAME_BYTES - (controller.desiredSize ?? MAX_INPUT_FRAME_BYTES))
    if (queuedBytes() + pending.length + streamBuffered > MAX_INPUT_UNCONSUMED_BYTES) {
      finished = true
      detach()
      fail('LOCAL_ACP_INPUT_OVERFLOW')
      return
    }
    pump()
  }

  const onEnd = (): void => {
    // A trailing fragment with no newline is an incomplete NDJSON frame and is
    // discarded at end-of-stream; only complete lines ever reach the SDK.
    finished = true
    pump()
  }

  const onClose = (): void => {
    finished = true
    closeController()
  }

  const onError = (): void => {
    finished = true
    closeController()
  }

  const detach = (): void => {
    socket.off('data', onData)
    socket.off('end', onEnd)
    socket.off('close', onClose)
    socket.off('error', onError)
  }

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      socket.on('data', onData)
      socket.on('end', onEnd)
      socket.on('close', onClose)
      socket.on('error', onError)
    },
    pull() {
      pump()
    },
    cancel() {
      finished = true
      detach()
      socket.destroy()
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_INPUT_FRAME_BYTES }))
}

/**
 * Build the bounded output side.
 *
 * Node reflects bytes accepted but not yet flushed to the kernel in
 * `socket.writableLength`, so the pre-write cap on `writableLength + frame` is
 * the enforced bound on "unwritten output": it closes a slow reader's
 * connection instead of letting the queue grow without limit. We deliberately
 * resolve each sink write after `socket.write()` accepts the bytes rather than
 * chaining an unbounded drain wait; the cap above is what terminates a stalled
 * consumer and keeps memory bounded.
 */
function createBoundedOutput(
  socket: Socket,
  fail: (code: string) => void,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(frame) {
      if (socket.destroyed) throw new Error('local acp: output socket already closed')
      if (frame.byteLength > MAX_OUTPUT_FRAME_BYTES) {
        fail('LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE')
        throw new Error('local acp: output frame exceeds the per-frame cap')
      }
      if (socket.writableLength + frame.byteLength > MAX_OUTPUT_BUFFER_BYTES) {
        fail('LOCAL_ACP_OUTPUT_BACKPRESSURE')
        throw new Error('local acp: output backlog exceeds the connection cap')
      }
      socket.write(frame)
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_OUTPUT_BUFFER_BYTES }))
}

/** Build the per-connection ACP agent app whose handlers own only connection-local state. */
function buildAgentApp(state: ConnectionState, context: ListenerContext, fail: (code: string) => void) {
  const app = agent({ name: AGENT_NAME })

  const beginRequest = (): void => {
    state.pendingRequests += 1
    if (state.pendingRequests > MAX_PENDING_REQUESTS) {
      state.pendingRequests -= 1
      fail('LOCAL_ACP_TOO_MANY_PENDING_REQUESTS')
      throw new RequestError(
        -32044,
        'too many outstanding ACP requests on this connection',
        { code: 'LOCAL_ACP_TOO_MANY_PENDING_REQUESTS' },
      )
    }
  }

  app.onRequest(methods.agent.initialize, async request => {
    beginRequest()
    try {
      if (state.initialized) {
        throw new RequestError(
          -32043,
          'ACP connection is already initialized',
          { code: 'LOCAL_ACP_ALREADY_INITIALIZED' },
        )
      }
      const requested = request.params?.protocolVersion
      if (requested !== PROTOCOL_VERSION) {
        throw RequestError.invalidParams(
          { code: 'LOCAL_ACP_PROTOCOL_UNSUPPORTED' },
          `unsupported ACP protocol version ${String(requested)}; this endpoint supports ${String(PROTOCOL_VERSION)}`,
        )
      }
      // Commit the initialized state before the response leaves the handler so
      // a pipelined duplicate initialize is rejected deterministically.
      state.initialized = true
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: AGENT_NAME, title: AGENT_NAME, version: context.bundleVersion },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: {},
        },
        authMethods: [],
      }
    } finally {
      state.pendingRequests -= 1
    }
  })

  const rejectSessionOperation = (_request: { params: unknown }): never => {
    beginRequest()
    try {
      rejectSessionNotReady()
    } finally {
      state.pendingRequests -= 1
    }
  }
  // Register with a permissive params parser: these methods are unsupported in
  // PO-1 regardless of whether a client's params happen to be schema-valid, so
  // the deterministic fail-closed code must reach EVERY such request (a schema
  // rejection would otherwise answer -32602 for malformed params).
  const acceptAnyParams = (params: unknown): unknown => params
  app.onRequest(methods.agent.session.new, acceptAnyParams, rejectSessionOperation)
  app.onRequest(methods.agent.session.list, acceptAnyParams, rejectSessionOperation)
  app.onRequest(methods.agent.session.resume, acceptAnyParams, rejectSessionOperation)
  app.onRequest(methods.agent.session.setConfigOption, acceptAnyParams, rejectSessionOperation)
  app.onRequest(methods.agent.session.prompt, acceptAnyParams, rejectSessionOperation)
  app.onRequest(methods.agent.session.close, acceptAnyParams, rejectSessionOperation)

  // A `session/cancel` notification carries no response. PO-1 has no View, so
  // the handler is an explicit no-op: it must never touch a Host Agent.
  app.onNotification(methods.agent.session.cancel, () => {})

  return app
}

/** Wire one accepted socket to its own SDK connection; only this connection is affected by a fault. */
function serveConnection(socket: Socket, context: ListenerContext): void {
  const state: ConnectionState = { initialized: false, pendingRequests: 0, closed: false }
  context.connectionStates.set(socket, state)

  let tornDown = false
  let connection: AgentConnection | undefined

  const fail = (code: string): void => {
    if (state.closed) return
    state.closed = true
    context.diag.warn('local-acp.error', { code, connections: context.connections.size })
    socket.destroy()
  }

  const teardown = (): void => {
    if (tornDown) return
    tornDown = true
    state.closed = true
    try {
      connection?.close()
    } catch {
      // Closing an already-closed SDK connection is inert.
    }
    if (!socket.destroyed) socket.destroy()
    context.connections.delete(socket)
    context.connectionStates.delete(socket)
    context.diag.info('local-acp.connection.close', { connections: context.connections.size })
  }

  socket.on('error', error => {
    context.diag.warn('local-acp.error', {
      code: (error as NodeJS.ErrnoException).code ?? 'LOCAL_ACP_SOCKET_ERROR',
      connections: context.connections.size,
    })
    socket.destroy()
  })
  socket.on('close', teardown)

  const input = createBoundedInput(socket, fail)
  const output = createBoundedOutput(socket, fail)
  const app = buildAgentApp(state, context, fail)
  const stream = ndJsonStream(output, input)
  connection = app.connect(stream)
  const connected = connection
  // Observe the SDK connection's own close so a peer close tears down this ONE
  // connection's resources through the repository owned-task model rather than
  // a bare fire-and-forget promise.
  runDetached('local acp: connection teardown', () => connected.closed.then(teardown, teardown), { diag: context.diag })
}

/** Open the scope directory and require `/proc/self/fd` so a long path can be bound by short fd path. */
function openScopeDirFd(scope: LocalScope): number {
  let dirFd: number
  try {
    dirFd = openSync(scope.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the scope directory could not be opened without following a link', error)
  }
  if (process.platform !== 'linux') {
    closeSync(dirFd)
    throw new LocalAcpError('LOCAL_ACP_SOCKET_PATH_UNSUPPORTED', 'local acp: the fd-shortened socket path requires Linux /proc/self/fd')
  }
  return dirFd
}

/** The short kernel-bind path derived from an open directory fd (Linux only). */
function fdSocketPath(dirFd: number): string {
  return `/proc/self/fd/${String(dirFd)}/${SOCKET_FILE}`
}

/** A ≤500ms connect probe used only to distinguish an inert stale socket from a live one. */
function probeSocket(path: string): Promise<'open' | 'refused' | 'unknown'> {
  return new Promise(resolve => {
    let settled = false
    const target = netConnect(path)
    const finish = (verdict: 'open' | 'refused' | 'unknown'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      target.destroy()
      resolve(verdict)
    }
    const timer = setTimeout(() => finish('unknown'), CONNECT_PROBE_TIMEOUT_MS)
    target.once('connect', () => finish('open'))
    target.once('error', error => {
      finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'unknown')
    })
  })
}

/** One saved socket inode identity: the only authority this module may unlink. */
interface SavedInode {
  readonly dev: number
  readonly ino: number
  readonly uid: number
}

/** Read the socket inode identity at one path, or reject a non-socket / foreign / symlink entry. */
function readSavedInode(path: string, uid: number): SavedInode {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isSocket() || info.uid !== uid) {
    throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the socket path is not a socket owned by this uid')
  }
  return { dev: info.dev, ino: info.ino, uid: info.uid }
}

/**
 * Start the one Host-owned local ACP listener for this scope.
 *
 * Ordering: probe/reclaim the logical path, bind the fd-shortened path, force
 * the inode to 0600 and prove it, and only then return. The caller is
 * responsible for committing Ready AFTER this resolves.
 */
export async function startLocalAcpListener(options: StartLocalAcpListenerOptions): Promise<LocalAcpListener> {
  const { scope, maxConnections, diag } = options
  const uid = process.getuid?.()
  if (typeof uid !== 'number') {
    throw new LocalAcpError('LOCAL_ACP_SOCKET_PATH_UNSUPPORTED', 'local acp: the current uid is unavailable')
  }
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 16) {
    throw new LocalAcpError('LOCAL_ACP_INVALID_MAX_CONNECTIONS', 'local acp: maxConnections must be an integer in 1..16')
  }
  const logicalPath = join(scope.dir, SOCKET_FILE)
  // The scope dirfd is used ONLY to probe/reclaim a stale pathname BEFORE bind.
  const scopeDirFd = openScopeDirFd(scope)
  const scopeProbePath = fdSocketPath(scopeDirFd)
  // The server is BOUND inside a private, owner-only subdirectory (fd-shortened)
  // and its inode is then renamed onto the contract path. Node's
  // net.Server.close() unlinks the path it was told to listen on; because that
  // path lives inside THIS private directory (and the inode was renamed out of
  // it), the automatic unlink is always ENOENT and can never touch a foreign
  // inode at the contract path. The private dirfd is kept OPEN across close, so
  // its /proc/self/fd path can never be redirected to another directory by
  // fd-number reuse — the fix does NOT rely on a released fd staying unused.
  const privDir = join(scope.dir, PRIVATE_DIR)
  let privFd: number | undefined
  let scopeDirFdClosed = false
  let privFdClosed = false

  let saved: SavedInode | undefined
  let server: Server | undefined
  let stopping = false
  let closed: Promise<void> | undefined

  const context: ListenerContext = {
    diag,
    bundleVersion: scope.bundleVersion,
    connections: new Set<Socket>(),
    connectionStates: new Map<Socket, ConnectionState>(),
  }

  const closeScopeDirFd = (): void => {
    if (scopeDirFdClosed) return
    scopeDirFdClosed = true
    try {
      closeSync(scopeDirFd)
    } catch {
      // The fd was already closed by an earlier cleanup; nothing to release.
    }
  }

  const closePrivFd = (): void => {
    if (privFdClosed || privFd === undefined) return
    privFdClosed = true
    try {
      closeSync(privFd)
    } catch {
      // Already closed.
    }
  }

  const removePrivDir = (): void => {
    try {
      rmdirSync(privDir)
    } catch {
      // Not empty or already gone; best effort (never blocks retirement).
    }
  }

  /**
   * Remove ONLY this process's owned socket inode. Identity-checked against the
   * exact saved (dev, ino, uid): a foreign inode that has since replaced the
   * pathname is never unlinked. Used by graceful retire, bind-failure cleanup and
   * the synchronous process-exit mirror.
   */
  const cleanupSync = (): void => {
    if (saved === undefined) return
    let current: ReturnType<typeof lstatSync>
    try {
      current = lstatSync(logicalPath)
    } catch {
      return
    }
    if (!current.isSocket() || current.uid !== saved.uid) return
    if (current.dev !== saved.dev || current.ino !== saved.ino) return
    try {
      unlinkSync(logicalPath)
    } catch {
      // Another owner retired it first; the inode no longer needs this cleanup.
    }
  }

  const retireServer = (): Promise<void> => {
    if (closed !== undefined) return closed
    stopping = true
    closed = (async () => {
      for (const socket of context.connections) socket.destroy()
      if (server !== undefined) {
        // Keep privFd OPEN across close so the stored private bind path always
        // resolves to OUR (now-empty) private dir → ENOENT; it can never be
        // redirected to another directory by fd-number reuse.
        await new Promise<void>(resolveClose => {
          server!.close(() => resolveClose())
        })
      }
      // Remove ONLY our owned contract-path inode (identity-checked).
      cleanupSync()
      closeScopeDirFd()
      closePrivFd()
      removePrivDir()
    })()
    return closed
  }

  try {
    // 1. Inspect any existing logical path BEFORE binding. A non-socket,
    //    symlink or foreign-owner entry is never removed.
    let existing: ReturnType<typeof lstatSync> | undefined
    try {
      existing = lstatSync(logicalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the socket path is not accessible', error)
      }
    }
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isSocket() || existing.uid !== uid) {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: a non-socket, symlink or foreign-owned entry occupies the socket path')
      }
      const verdict = await probeSocket(scopeProbePath)
      if (verdict === 'open') {
        throw new LocalAcpError('LOCAL_ACP_SOCKET_IN_USE', 'local acp: a live listener already answers on the socket path')
      }
      if (verdict !== 'refused') {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the existing socket path could not be proven stale')
      }
      // Refused AND the inode identity is unchanged since the probe: reclaim it.
      const recheck = readSavedInode(logicalPath, uid)
      if (recheck.dev !== existing.dev || recheck.ino !== existing.ino) {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the socket inode changed during the stale reclaim')
      }
      unlinkSync(logicalPath)
    }

    // 2. Prepare the private owner-only dir and BIND the fd-shortened private path.
    mkdirSync(privDir, { recursive: true, mode: 0o700 })
    chmodSync(privDir, 0o700)
    privFd = openSync(privDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const privBindPath = fdSocketPath(privFd)
    server = createServer(socket => {
      if (stopping) {
        socket.destroy()
        return
      }
      if (context.connections.size >= maxConnections) {
        diag.warn('local-acp.connection.reject', { code: 'LOCAL_ACP_CAPACITY_EXCEEDED', connections: context.connections.size })
        // A rejected socket is never tracked by serveConnection, so attach the
        // one error guard here: a peer reset racing the bounded error write must
        // not surface as an unhandled 'error' that could terminate the Host.
        socket.on('error', () => socket.destroy())
        socket.end(CAPACITY_ERROR_LINE, () => socket.destroy())
        return
      }
      context.connections.add(socket)
      diag.info('local-acp.connection.open', { connections: context.connections.size })
      serveConnection(socket, context)
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once('error', rejectListen)
      server!.listen(privBindPath, () => {
        server!.off('error', rejectListen)
        resolveListen()
      })
    })
    // Keep one live error listener on the server for its whole lifetime so a
    // late accept/backlog error is a classified diagnostic, never an unhandled
    // 'error' event that would crash the Host.
    server.on('error', error => {
      diag.warn('local-acp.error', { code: (error as NodeJS.ErrnoException).code ?? 'LOCAL_ACP_SERVER_ERROR' })
    })

    // 3. Force the private inode to 0600, then RENAME it onto the contract path.
    chmodSync(join(privDir, SOCKET_FILE), 0o600)
    // Refuse to clobber a foreign entry that appeared between the stale
    // inspection and the rename: never overwrite an inode we do not own.
    let appeared = true
    try {
      lstatSync(logicalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the socket path is not accessible', error)
      }
      appeared = false
    }
    if (appeared) {
      throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: an entry appeared at the socket path during bind')
    }
    renameSync(join(privDir, SOCKET_FILE), logicalPath)
    // Capture the contract-path inode identity IMMEDIATELY so any later startup
    // failure can remove ONLY our inode (never a foreign one).
    const info = lstatSync(logicalPath)
    if (!info.isSocket() || info.uid !== uid) {
      throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the renamed socket is not a socket owned by this uid')
    }
    saved = { dev: info.dev, ino: info.ino, uid: info.uid }
    if ((info.mode & 0o777) !== 0o600) {
      throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the bound socket is not a 0600 socket owned by this uid')
    }
    closeScopeDirFd()
    diag.info('local-acp.listen', { connections: 0 })
  } catch (error) {
    // Any failure after bind must not leave OUR bound socket behind, and must
    // never delete a foreign inode. Keep privFd open across close (private bind
    // path → ENOENT), remove only our contract-path inode, then release fds.
    for (const socket of context.connections) socket.destroy()
    if (server !== undefined) {
      try {
        await new Promise<void>(resolveClose => {
          server!.close(() => resolveClose())
        })
      } catch {
        // The bind may never have completed; closing is best effort here.
      }
    }
    cleanupSync()
    closeScopeDirFd()
    closePrivFd()
    removePrivDir()
    throw error
  }

  const isListening = (): boolean => {
    // A stopping/closed server or a never-bound one is definitively not listening.
    if (stopping || closed !== undefined || server === undefined || !server.listening) return false
    if (saved === undefined) return false
    // The owned bound server can outlive an externally removed/replaced inode;
    // only the exact saved (dev,ino,uid) socket proves this listener still owns
    // the pathname it advertises.
    let current: ReturnType<typeof lstatSync>
    try {
      current = lstatSync(logicalPath)
    } catch {
      return false
    }
    return current.isSocket()
      && current.uid === saved.uid
      && current.dev === saved.dev
      && current.ino === saved.ino
  }

  const handle: LocalAcpListener = {
    socketPath: logicalPath,
    connectionCount: () => context.connections.size,
    isListening,
    close: retireServer,
    cleanupSync,
  }

  // The `stopping` flag now governs the accept callback for the server lifetime.
  // A graceful close retires the path; a SIGKILL leaves it for the next seat
  // winner to classify and reclaim.
  return handle
}
