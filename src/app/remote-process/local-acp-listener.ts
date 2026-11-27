/**
 * Host-owned local ACP v1 front door over a local endpoint (Unix socket or Windows Named Pipe).
 *
 * The one Host process that already owns a canonical profile scope opens a
 * bounded `acp.sock` on ONE platform-specific physical endpoint: Linux keeps the
 * 0700 scope directory and binds through `/proc/self/fd` so an over-long scope
 * pathname still fits the kernel `sun_path`; Darwin publishes the same
 * private-bind inode onto a short profile-scoped
 * `/private/tmp/dpt-<uid>-<scope40>/acp.sock` pathname that stays within the
 * Darwin `sockaddr_un.sun_path` byte limit; native Windows binds one local Named
 * Pipe `\\.\pipe\dsh-pi-tui-acp-<scopeId>` whose pipe object carries the
 * one-shot owner-only/NETWORK-deny DACL. The listener speaks ACP v1 with
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
 * queued-byte cap, and an output writer that paces every frame under a fixed
 * unwritten-backlog bound. A decoded-stream reply-debt admission also bounds
 * the requests whose responses are still waiting for that transport; a breach
 * closes only the offending connection.
 *
 * @module app/remote-process/local-acp-listener
 */

import { constants as bufferConstants } from 'node:buffer'
import { chmodSync, constants, closeSync, linkSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync } from 'node:fs'
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentConnection,
  type AgentContext,
  type AnyMessage,
  type Stream,
  type SessionConfigOption,
  type SessionModeState,
} from '@agentclientprotocol/sdk'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { type LocalScope } from './local-scope.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import { secureWin32AcpPipe } from '../../runtime/native-process/win32.ts'
import { acpPipeAddress } from './local-acp-endpoint.ts'
import {
  AcpSessionViewRegistry,
  LocalAcpViewError,
  type AcpConfigUpdate,
  type AcpConfigUpdateNotifier,
  type AcpElicitationRequester,
  type AcpImageLimits,
  type AcpProjectionNotifier,
  type AcpViewChannels,
  type ConnectionViewState,
  type HostAcpSessionAccess,
} from './local-acp-session-view.ts'
import {
  readSessionListRequest,
  selectSessionPage,
  type AcpNegotiatedCapabilities,
} from './local-acp-projections.ts'
import { invalidPolicyOption, modeOfWireId } from './local-acp-session-policy.ts'

/** The ACP agent identity this front door advertises (never a copied brand). */
const AGENT_NAME = 'dsh-pi-tui'
/** JSON-RPC invalid-request code for a Session request before the handshake completes. */
const JSONRPC_INVALID_REQUEST = -32600
/** JSON-RPC invalid-params code used by connection-local View admission refusals. */
const JSONRPC_INVALID_PARAMS = -32602
/**
 * JSON-RPC resource-not-found code of the standard ACP v1 error table. A
 * Session-scoped request for a Session this connection does not hold is a
 * not-active Session (`-32002` with the requested `sessionId`), never a format
 * rejection; `LOCAL_ACP_VIEW_ALREADY_ATTACHED` keeps its own conflict class.
 */
const JSONRPC_RESOURCE_NOT_FOUND = -32002
/** JSON-RPC internal-error code used by a fail-closed reverse capability refusal. */
const JSONRPC_INTERNAL_ERROR = -32603

/** One input line (a single NDJSON frame) may not exceed one mebibyte. */
const MAX_INPUT_FRAME_BYTES = 1024 * 1024
/**
 * Total unconsumed input on ONE connection is bounded: the current partial
 * line plus complete frames awaiting the SDK plus frames already enqueued into
 * the bounded ReadableStream. All three are summed in bytes against this cap.
 */
const MAX_INPUT_UNCONSUMED_BYTES = 2 * 1024 * 1024
/** At most this many prompt/ordinary requests may be dispatched concurrently on ONE connection. */
const MAX_PENDING_REQUESTS = 8
/**
 * Session lifecycle controls have their own bounded headroom. They must stay
 * reachable while all eight View prompt flights are open: otherwise a legal
 * `session/close` (or a ninth-View capacity rejection) would be misclassified
 * as a connection-wide flood.
 */
const MAX_PENDING_CONTROL_REQUESTS = 4
/**
 * At most this many Session Views may be active, attaching or retained by a
 * terminal fence on ONE physical ACP connection. This is this product's own
 * capacity policy, not an ACP v1 limit.
 */
const MAX_ACP_VIEWS_PER_CONNECTION = 8
/**
 * `session/close` is terminal work, not an ordinary lifecycle control: a
 * close must remain reachable while the new/resume/config lane is occupied by
 * legitimate Host awaits. At most one close per View is useful; the bound is
 * the number of View slots, and an excess close is refused without destroying
 * unrelated Views.
 */
const MAX_PENDING_CLOSE_REQUESTS = MAX_ACP_VIEWS_PER_CONNECTION
/** Bytes reserved per image block for JSON metadata around its encoded data. */
const IMAGE_METADATA_BYTES = 65_536
/** Bytes reserved for the JSON-RPC envelope and its trailing newline. */
const JSON_ENVELOPE_BYTES = 4_096
/**
 * Text allowance of ONE outbound committed event when the connection derives
 * its frame budget from Host attachment limits: a larger derived budget must
 * not reject ordinary large text output that the legacy wire already bounded.
 */
const OUTPUT_TEXT_BYTES = 1024 * 1024

/** The per-connection input bounds; image limits widen only this connection. */
interface ConnectionInputBounds {
  readonly maxFrameBytes: number
  readonly maxUnconsumedBytes: number
}

/** The legacy text-only bounds every connection uses until it negotiates image. */
const TEXT_ONLY_BOUNDS: ConnectionInputBounds = {
  maxFrameBytes: MAX_INPUT_FRAME_BYTES,
  maxUnconsumedBytes: MAX_INPUT_UNCONSUMED_BYTES,
}

/**
 * Derive the bounded input budget of an image-negotiated connection from the
 * Host's OWN boot-frozen attachment limits. The arithmetic models canonical
 * base64, one configured count of image metadata allowances, the preserved
 * text/wire budget and one JSON-RPC envelope. It is not a second image policy:
 * real count/byte/pixel admission remains the official Attachment Store's.
 *
 * @param limits - the exact Host attachment limits, or undefined without a store.
 * @returns the bounds, or undefined when a safe bound cannot be represented.
 */
export function deriveImageInputBounds(limits: AcpImageLimits | undefined): ConnectionInputBounds | undefined {
  if (limits === undefined) return undefined
  const { maxMessageImageBytes, maxImagesPerMessage } = limits
  if (!Number.isSafeInteger(maxMessageImageBytes) || maxMessageImageBytes <= 0
    || !Number.isSafeInteger(maxImagesPerMessage) || maxImagesPerMessage <= 0
    || !Number.isSafeInteger(limits.maxImageBytes) || limits.maxImageBytes <= 0) {
    return undefined
  }
  const encoded = 4 * Math.ceil(maxMessageImageBytes / 3)
  const imageFrameBytes = encoded
    + MAX_INPUT_FRAME_BYTES
    + IMAGE_METADATA_BYTES * maxImagesPerMessage
    + JSON_ENVELOPE_BYTES
  const maxFrameBytes = Math.max(MAX_INPUT_FRAME_BYTES, imageFrameBytes)
  const maxUnconsumedBytes = maxFrameBytes + MAX_INPUT_FRAME_BYTES
  if (!Number.isSafeInteger(encoded) || !Number.isSafeInteger(imageFrameBytes) || !Number.isSafeInteger(maxFrameBytes)
    || !Number.isSafeInteger(maxUnconsumedBytes)
    || maxFrameBytes > bufferConstants.MAX_LENGTH || maxUnconsumedBytes > bufferConstants.MAX_LENGTH) {
    return undefined
  }
  return { maxFrameBytes, maxUnconsumedBytes }
}
/**
 * Derive ONE connection's outbound single-frame budget from the Host's OWN
 * boot-frozen attachment limits. A committed image arrives from the official
 * Store as ONE independently Base64-encoded object, and the Store's
 * `maxMessageImageBytes` is a PROMPT-batch admission limit that does not bound
 * a stored output image. The allowance therefore bounds each image by the
 * Store's per-object admission ceiling (`maxImageBytes`), encodes every image
 * separately and sums those encoded ceilings, then adds one metadata allowance
 * per image, the JSON-RPC envelope and the preserved text allowance.
 *
 * This is a TRANSPORT resource bound, never an image acceptance policy and never
 * a reason to drop, shrink or re-encode content: the official Attachment Store
 * keeps every byte/pixel limit, and its normalization may even produce a stored
 * image larger than `maxImageBytes` (the accepted upstream limitation). A frame
 * above this allowance fails closed with `LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE`
 * before any byte of that frame is written.
 *
 * @param limits - the exact Host attachment limits, or undefined without a store.
 * @returns the per-frame byte budget, or undefined when it cannot be represented.
 */
export function deriveImageOutputBounds(limits: AcpImageLimits | undefined): number | undefined {
  if (limits === undefined) return undefined
  const { maxImagesPerMessage, maxImageBytes } = limits
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes <= 0
    || !Number.isSafeInteger(maxImagesPerMessage) || maxImagesPerMessage <= 0) {
    return undefined
  }
  // Each committed image is Base64-encoded on its own, so the batch ceiling is
  // the SUM of per-image encoded ceilings (never one ceiling of a summed byte
  // count, which would understate the encoded bytes).
  const encodedPerImage = 4 * Math.ceil(maxImageBytes / 3)
  const encoded = maxImagesPerMessage * encodedPerImage
  const candidate = encoded + IMAGE_METADATA_BYTES * maxImagesPerMessage + JSON_ENVELOPE_BYTES + OUTPUT_TEXT_BYTES
  const maxFrameBytes = Math.max(MAX_OUTPUT_FRAME_BYTES, candidate)
  if (!Number.isSafeInteger(encodedPerImage) || !Number.isSafeInteger(encoded)
    || !Number.isSafeInteger(candidate) || !Number.isSafeInteger(maxFrameBytes)
    || maxFrameBytes > bufferConstants.MAX_LENGTH) {
    return undefined
  }
  return maxFrameBytes
}

/** The legacy single outbound ACP frame cap (unchanged for a text-only Host). */
const MAX_OUTPUT_FRAME_BYTES = 256 * 1024
/** Total bytes buffered in the socket awaiting flush on ONE connection. */
const MAX_OUTPUT_BUFFER_BYTES = 256 * 1024
/** The bounded output writer emits at most this many bytes per socket chunk. */
const OUTPUT_WRITE_CHUNK_BYTES = 64 * 1024
/** The longest one kernel-drain wait may block the output writer. */
const OUTPUT_DRAIN_TIMEOUT_MS = 30_000

/**
 * One connection may hold at most this many response-producing records before
 * a response has actually settled on the public SDK writable. The existing
 * lanes admit at most 8 ordinary + 4 control + 8 close = 20 concurrent
 * requests; the other 20 is completion/refusal headroom, so a healthy reader's
 * transient socket backlog cannot turn into an unbounded reply queue.
 */
const REPLY_DEBT_LIMIT = 20 + 20
/** How long a short stale-socket connect probe may run before it is treated as inert-unknown. */
const CONNECT_PROBE_TIMEOUT_MS = 500
/** The logical socket file name inside the 0700 scope directory. */
const SOCKET_FILE = 'acp.sock'
/** Owner-only private subdirectory (inside the 0700 scope) where the server is
 *  actually BOUND before its inode is hard-linked onto the contract path. Node's
 *  server.close() unlink always targets this private dir, so it can never delete
 *  a foreign inode at the contract path. */
const PRIVATE_DIR = '.acp-priv'
/** The trusted, OS-owned sticky parent of the Darwin profile-scoped endpoint. Never
 *  `$TMPDIR`, `DSH_HOME` or the user home: those are variable and unbounded. */
const DARWIN_SOCKET_PARENT = '/private/tmp'
/** Darwin `sockaddr_un.sun_path` capacity in bytes INCLUDING the trailing NUL. */
const DARWIN_SUN_PATH_BYTES = 104
/** Prefix of the one deterministic Darwin endpoint root per profile scope. */
const DARWIN_ROOT_PREFIX = 'dpt-'
/** Scope-id hex characters kept in the Darwin root name (the existing 160-bit
 *  collision budget the local seats already use). */
const DARWIN_SCOPE_PREFIX_HEX = 40

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
  /**
   * The PUBLIC contract endpoint this listener published: Linux
   * `<scope.dir>/acp.sock`, Darwin the short profile-scoped
   * `/private/tmp/dpt-<uid>-<scope40>/acp.sock`, and native Windows the local
   * Named Pipe `\\.\pipe\dsh-pi-tui-acp-<scopeId>`. Never the private bind name
   * and never a client-side fd-shortened alias.
   */
  readonly socketPath: string
  /** The number of live connections this listener currently owns. */
  readonly connectionCount: () => number
  /**
   * Read-only proof that THIS listener is still valid: the bound `net.Server`
   * is listening and, on POSIX, the logical path still carries this process's
   * exact saved socket inode; on Windows the bound server is listening and the
   * one-shot ACL was applied. Never rebinds, never reclaims a foreign inode and
   * never mutates state — it only observes the authoritative ownership facts.
   */
  isListening(): boolean
  /** Stop accepting, tear down every connection, then retire the server. Idempotent. */
  close(): Promise<void>
  /** Synchronous POSIX inode retirement of THIS process's own socket inode;
   *  a no-op on Windows, where the kernel owns the Named Pipe name lifetime. */
  cleanupSync(): void
}

/** Options for `startLocalAcpListener`; no Context, Agent or Session ever enters here. */
export interface StartLocalAcpListenerOptions {
  readonly scope: LocalScope
  readonly maxConnections: number
  readonly diag: Diag
  /**
   * The narrow, already-bound Host Session access. Present ONLY when a real Host
   * installs the connection-scoped shared Session View (PO-2); absent keeps the
   * PO-1 fail-closed Session behaviour (used by the raw socket contracts).
   */
  readonly sessionAccess?: HostAcpSessionAccess
  /**
   * The ONE View/claim registry. The controller owns it across listener
   * rebinds so a retired-turn approval fence (or any claim) survives an
   * Off -> On cycle and the one-View-per-Session rule keeps holding.
   * Omitted keeps the bind-local registry (raw socket contracts).
   */
  readonly views?: AcpSessionViewRegistry
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
  pendingControlRequests: number
  pendingCloseRequests: number
  closed: boolean
  /** Whether THIS connection negotiated inline image prompts during its initialize. */
  imageEnabled: boolean
  /** Whether THIS connection negotiated standard embedded text/blob resources. */
  resourceEnabled: boolean
  /**
   * Whether THIS connection was actually advertised the standard client
   * `systemPrompt` append capability at `initialize`. It is frozen for the whole
   * connection with the other capabilities and is the ONLY admission fact a
   * non-null lifecycle `systemPrompt` is checked against.
   */
  systemPromptAppend: boolean
  /**
   * Whether THIS connection declared the standard ACP v1 form-based
   * elicitation capability during its initialize. A connection that did not
   * declare it never receives an `elicitation/create` request: an ACP-owned
   * question then fails closed instead of being answered by another surface.
   */
  elicitationForm: boolean
  /** The input bounds derived from the Host image limits; text-only until negotiated. */
  inputBounds: ConnectionInputBounds
  /**
   * This connection's outbound single-frame budget. It is derived ONCE at
   * connection establish from the same boot-frozen Host attachment limits (or
   * the legacy cap without a Store); the inbound image capability never widens
   * or narrows it, because output images are committed content, not prompts.
   */
  maxOutputFrameBytes: number
  /**
   * The client capabilities THIS connection declared at `initialize`, frozen
   * once for its whole life. A read-only projection is produced only when the
   * matching capability was declared; no later attach can widen or narrow it.
   */
  capabilities: AcpNegotiatedCapabilities
  /**
   * The bounded per-connection Session View roster; present only when Session
   * View is installed. Each slot is routing/teardown state only — the one
   * Registry claim remains the business authority for its Session.
   */
  views?: Set<ConnectionViewState>
}

/** The listener's accept-time facts shared by the connection factories. */
interface ListenerContext {
  readonly diag: Diag
  readonly bundleVersion: string
  readonly connections: Set<Socket>
  readonly connectionStates: Map<Socket, ConnectionState>
  /** The settled Host Session access, present only when a real Host installs Session View. */
  readonly sessionAccess?: HostAcpSessionAccess
  /** The per-listener View/claim registry; a fresh one per bind. */
  readonly views?: AcpSessionViewRegistry
}

/** The ACP Session methods PO-1 must fail closed (business capability does not exist yet). */
function rejectSessionNotReady(): never {
  throw new RequestError(
    -32042,
    'ACP Session operations are not available on this connection',
    { code: 'LOCAL_ACP_SESSION_NOT_READY' },
  )
}

/** Build the bounded input side: raw UTF-8 byte lines under the connection's current caps. */
/** @internal The owner test feeds real Unix-socket bytes while holding the stream reader. */
export function createBoundedInput(
  socket: Socket,
  state: ConnectionState,
  fail: (code: string) => void,
): ReadableStream<Uint8Array> {
  /** Fragments of the current, not-yet-terminated line. */
  const line: Buffer[] = []
  let lineBytes = 0
  const queue: Uint8Array[] = []
  let queuedByteCount = 0
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let finished = false
  let controllerClosed = false
  let paused = false

  const closeController = (): void => {
    if (controllerClosed || controller === undefined) return
    controllerClosed = true
    try {
      controller.close()
    } catch {
      // Already closed by a concurrent cancel; the reader observes one end.
    }
  }

  /** The stream's OWN already-enqueued bytes, measured against its fixed high-water mark. */
  const streamBufferedBytes = (): number => controller === undefined
    ? 0
    : Math.max(0, MAX_INPUT_FRAME_BYTES - (controller.desiredSize ?? MAX_INPUT_FRAME_BYTES))

  const pump = (): void => {
    if (controller === undefined) return
    while (queue.length > 0) {
      if ((controller.desiredSize ?? 1) <= 0) break
      const frame = queue.shift()
      if (frame !== undefined) {
        queuedByteCount -= frame.byteLength
        controller.enqueue(frame)
      }
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

  const detach = (): void => {
    socket.off('data', onData)
    socket.off('end', onEnd)
    socket.off('close', onClose)
    socket.off('error', onError)
  }

  const failConnection = (code: string): void => {
    finished = true
    detach()
    fail(code)
  }

  const completeLine = (end: Buffer): void => {
    // The established per-frame cap excludes the terminating newline.
    if (lineBytes - 1 > state.inputBounds.maxFrameBytes) {
      failConnection('LOCAL_ACP_INPUT_FRAME_TOO_LARGE')
      return
    }
    line.push(end)
    // ONE concatenation per complete frame, only when the line spanned chunks;
    // a single-chunk line is copied so no socket pool buffer is retained.
    const frame = line.length === 1
      ? Uint8Array.prototype.slice.call(line[0]) as Uint8Array
      : Buffer.concat(line)
    line.length = 0
    lineBytes = 0
    queue.push(frame)
    queuedByteCount += frame.byteLength
  }

  /**
   * Scan one raw chunk by UTF-8 bytes. Every byte is forwarded verbatim; a
   * newline completes exactly one NDJSON frame, so truncated or multi-byte
   * characters stay intact across chunks.
   */
  const onData = (chunk: Buffer): void => {
    if (finished) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, offset)
      if (newline === -1) {
        const rest = chunk.subarray(offset)
        line.push(rest)
        lineBytes += rest.length
        break
      }
      lineBytes += newline + 1 - offset
      completeLine(chunk.subarray(offset, newline + 1))
      if (finished) return
      offset = newline + 1
    }
    if (lineBytes > state.inputBounds.maxFrameBytes) {
      failConnection('LOCAL_ACP_INPUT_FRAME_TOO_LARGE')
      return
    }
    // Total unconsumed bytes across the partial line, the complete-frame queue
    // and the stream's own already-enqueued buffer stay under the dynamic cap.
    if (queuedByteCount + lineBytes + streamBufferedBytes() > state.inputBounds.maxUnconsumedBytes) {
      failConnection('LOCAL_ACP_INPUT_OVERFLOW')
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
 * Wait for ONE `drain` of this socket under a fixed deadline. A socket
 * `close`/`error` ends the wait immediately (the connection is gone), and the
 * deadline fails this connection alone with the existing backpressure class.
 * Every exit path removes the listeners and the timer.
 */
function waitForOutputDrain(socket: Socket, fail: (code: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    let finished = false
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      socket.off('drain', onDrain)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const finish = (outcome: 'drained' | 'closed' | 'timeout'): void => {
      if (finished) return
      finished = true
      cleanup()
      if (outcome === 'drained') resolve()
      else if (outcome === 'closed') reject(new Error('local acp: output socket closed while draining'))
      else {
        fail('LOCAL_ACP_OUTPUT_BACKPRESSURE')
        reject(new Error('local acp: output drain exceeded its bounded wait'))
      }
    }
    const onDrain = (): void => { finish('drained') }
    const onClose = (): void => { finish('closed') }
    const onError = (): void => { finish('closed') }
    timer = setTimeout(() => { finish('timeout') }, OUTPUT_DRAIN_TIMEOUT_MS)
    socket.once('drain', onDrain)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

/**
 * Write ONE frame in bounded chunks. The connection's unwritten backlog may
 * never exceed `MAX_OUTPUT_BUFFER_BYTES`: before every chunk the writer waits
 * (bounded) for the kernel to drain, and a refused `socket.write()` waits for
 * its own `drain` before the next chunk. A reader that never drains the socket
 * therefore closes THIS connection on the existing backpressure class; the
 * Host, the Agent and every sibling connection are untouched, and no Host
 * prompt is retried.
 */
async function writeChunkedFrame(socket: Socket, frame: Uint8Array, fail: (code: string) => void): Promise<void> {
  let offset = 0
  while (offset < frame.byteLength) {
    const end = Math.min(offset + OUTPUT_WRITE_CHUNK_BYTES, frame.byteLength)
    // The backlog guard is checked BEFORE every chunk, so a chunk is never
    // accepted past the connection's unwritten-output bound.
    while (!socket.destroyed && socket.writableLength + (end - offset) > MAX_OUTPUT_BUFFER_BYTES) {
      await waitForOutputDrain(socket, fail)
    }
    if (socket.destroyed) throw new Error('local acp: output socket closed while writing a frame')
    const accepted = socket.write(frame.subarray(offset, end))
    offset = end
    if (!accepted) await waitForOutputDrain(socket, fail)
  }
}

/**
 * Build the bounded output side.
 *
 * Node reflects bytes accepted but not yet flushed to the kernel in
 * `socket.writableLength`, so the pre-write cap on `writableLength + frame` is
 * the enforced bound on "unwritten output". Every frame — not only one above
 * the legacy per-frame cap — is written through the same bounded chunk loop:
 * `false` means the bytes were accepted but the writer must wait for drain,
 * never that the current frame failed. A reader that does not drain is closed
 * by the existing bounded wait; a healthy reader is not disconnected merely
 * because a legal burst temporarily fills the kernel queue.
 */
export function createBoundedOutput(
  socket: Socket,
  fail: (code: string) => void,
  maxOutputFrameBytes: number,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(frame) {
      if (socket.destroyed) throw new Error('local acp: output socket already closed')
      // The frame-budget refusal happens BEFORE any byte of this frame is
      // written; the connection closes and the content is never truncated.
      if (frame.byteLength > maxOutputFrameBytes) {
        fail('LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE')
        throw new Error('local acp: output frame exceeds the connection frame budget')
      }
      await writeChunkedFrame(socket, frame, fail)
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_OUTPUT_BUFFER_BYTES }))
}

export interface ReplyDebtFailureDetail {
  readonly reason: 'reply-debt-limit'
  readonly limit: number
  readonly observedCount: number
}

type ReplyDebtKind = 'request' | 'response' | 'notification'

function replyDebtKind(message: AnyMessage): ReplyDebtKind {
  const record = message as Record<string, unknown>
  // Match the pinned SDK's envelope predicates exactly. In particular, a
  // malformed record that merely contains a method string is NOT a
  // notification, and a malformed record with a non-string method is NOT
  // response-shaped. Both are invalid requests that the SDK answers with
  // -32600, so they must consume one reply credit and release it on that write.
  if (record.jsonrpc === '2.0' && typeof record.method === 'string' && !('id' in record)) return 'notification'
  if (!('method' in record) && ('id' in record || 'result' in record || 'error' in record)) return 'response'
  return 'request'
}

/**
 * Bound the decoded SDK records that can produce a response before their
 * response bytes have actually reached the transport. The wrapper is demand
 * driven and does not parse or re-encode NDJSON: direct `ndJsonStream` parser
 * errors bypass it exactly as they bypass the SDK application, so they can
 * never release a credit they never held.
 *
 * A response is credited only after the underlying public SDK writable has
 * settled. A reverse request, notification and response-shaped inbound record
 * are not requests and do not consume credit. The 41st request-producing
 * record is refused before it is handed to the SDK, closes this one connection
 * through the existing failure owner, and never dispatches a handler.
 *
 * @internal Exported for the owner-level public-SDK Stream test, following
 * `createBoundedInput`'s existing internal-test seam.
 */
export function createReplyDebtStream(
  stream: Stream,
  options: {
    readonly isClosed: () => boolean
    readonly fail: (code: string, detail: ReplyDebtFailureDetail) => void
  },
): Stream {
  let debt = 0
  let terminal = false
  let inputDone = false
  const reader = stream.readable.getReader()
  let readerReleased = false
  const releaseReader = (): void => {
    if (readerReleased) return
    readerReleased = true
    try { reader.releaseLock() } catch { /* a settled reader may already be released */ }
  }
  const endInput = async (reason?: unknown): Promise<void> => {
    if (inputDone) return
    inputDone = true
    try { await reader.cancel(reason) } catch { /* the underlying stream may already be gone */ }
    releaseReader()
  }

  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      if (terminal || options.isClosed()) {
        try { controller.close() } catch { /* already closed */ }
        await endInput('closed')
        return
      }
      let next: Awaited<ReturnType<typeof reader.read>>
      try {
        next = await reader.read()
      } catch (error) {
        terminal = true
        try { controller.error(error) } catch { /* already errored */ }
        await endInput(error)
        return
      }
      if (terminal || options.isClosed()) {
        try { controller.close() } catch { /* already closed */ }
        await endInput('closed')
        return
      }
      if (next.done) {
        terminal = true
        inputDone = true
        try { controller.close() } catch { /* already closed */ }
        releaseReader()
        return
      }
      const kind = replyDebtKind(next.value)
      if (kind === 'request') {
        if (debt >= REPLY_DEBT_LIMIT) {
          terminal = true
          options.fail('LOCAL_ACP_OUTPUT_BACKPRESSURE', {
            reason: 'reply-debt-limit',
            limit: REPLY_DEBT_LIMIT,
            observedCount: debt,
          })
          try { controller.error(new Error('local acp: reply debt limit exceeded')) } catch { /* already errored */ }
          await endInput('reply-debt-limit')
          return
        }
        debt += 1
      }
      try {
        controller.enqueue(next.value)
      } catch (error) {
        terminal = true
        await endInput(error)
      }
    },
    cancel(reason) {
      terminal = true
      return endInput(reason)
    },
  }, { highWaterMark: 0 })

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      if (terminal || options.isClosed()) throw new Error('local acp: reply stream already closed')
      const response = replyDebtKind(message) === 'response'
      // The SDK shutdown path cancels its receive reader but does not close
      // this outer writable. Hold the public SDK writer only for the operation
      // that needs it; a connection-long lock would survive the real terminal.
      const writer = stream.writable.getWriter()
      try {
        await writer.write(message)
      } finally {
        try { writer.releaseLock() } catch { /* already released */ }
      }
      if (response) {
        if (debt <= 0) throw new Error('local acp: reply debt underflow')
        debt -= 1
      }
    },
    async close() {
      terminal = true
      if (stream.writable.locked) return
      const writer = stream.writable.getWriter()
      try { await writer.close() } finally { try { writer.releaseLock() } catch { /* already released */ } }
    },
    async abort(reason) {
      terminal = true
      if (stream.writable.locked) return
      const writer = stream.writable.getWriter()
      try { await writer.abort(reason) } finally { try { writer.releaseLock() } catch { /* already released */ } }
    },
  })

  return { readable, writable }
}

/** Drop routing-only slots that hold neither an operation nor a Host claim. */
function pruneIdleViewSlots(slots: Set<ConnectionViewState>, views: AcpSessionViewRegistry): void {
  for (const candidate of slots) {
    if (candidate.phase === 'idle' && !views.hasClaimOwnedBy(candidate)) slots.delete(candidate)
  }
}

/** Reserve ONE bounded connection-local View slot BEFORE the first Host await. */
function createSessionViewSlot(
  slots: Set<ConnectionViewState>,
  views: AcpSessionViewRegistry,
): ConnectionViewState {
  pruneIdleViewSlots(slots, views)
  if (slots.size >= MAX_ACP_VIEWS_PER_CONNECTION) {
    throw new LocalAcpViewError(
      'LOCAL_ACP_VIEW_BUSY',
      'this ACP connection holds the maximum number of Session Views',
      JSONRPC_INVALID_PARAMS,
    )
  }
  const view = views.createConnection()
  slots.add(view)
  return view
}

/** Find the exact connection-local slot that owns one Session claim. */
function routeOwnedView(
  slots: Set<ConnectionViewState>,
  views: AcpSessionViewRegistry,
  sessionId: string,
): ConnectionViewState | undefined {
  for (const candidate of slots) {
    if (views.ownsClaim(candidate, sessionId)) return candidate
  }
  return undefined
}

/** Release a handler's slot only when no attach operation or Host claim remains. */
function releaseIdleViewSlot(
  slots: Set<ConnectionViewState>,
  views: AcpSessionViewRegistry,
  view: ConnectionViewState,
): void {
  if (view.phase === 'idle' && !views.hasClaimOwnedBy(view)) slots.delete(view)
}

/** Build the per-connection ACP agent app whose handlers own only connection-local state. */
function buildAgentApp(
  state: ConnectionState,
  context: ListenerContext,
  fail: (code: string) => void,
) {
  const app = agent({ name: AGENT_NAME })
  let initializeComplete = false

  type RequestAdmission = 'ordinary' | 'control' | 'close'
  const beginRequest = (mode: RequestAdmission = 'ordinary'): void => {
    const count = mode === 'close'
      ? state.pendingCloseRequests
      : mode === 'control'
        ? state.pendingControlRequests
        : state.pendingRequests
    const limit = mode === 'close'
      ? MAX_PENDING_CLOSE_REQUESTS
      : mode === 'control'
        ? MAX_PENDING_CONTROL_REQUESTS
        : MAX_PENDING_REQUESTS
    if (mode === 'close') state.pendingCloseRequests += 1
    else if (mode === 'control') state.pendingControlRequests += 1
    else state.pendingRequests += 1
    if (count + 1 <= limit) return
    // A control/close refusal is per-request backpressure. It must not destroy
    // the socket or unrelated Views; only the ordinary prompt/input lane keeps
    // the connection-wide abuse fail-closed.
    if (mode === 'close') state.pendingCloseRequests -= 1
    else if (mode === 'control') state.pendingControlRequests -= 1
    else state.pendingRequests -= 1
    if (mode === 'ordinary') fail('LOCAL_ACP_TOO_MANY_PENDING_REQUESTS')
    throw new RequestError(
      -32044,
      mode === 'close'
        ? 'too many outstanding ACP close requests on this connection'
        : mode === 'control'
          ? 'too many outstanding ACP control requests on this connection'
          : 'too many outstanding ACP requests on this connection',
      { code: 'LOCAL_ACP_TOO_MANY_PENDING_REQUESTS' },
    )
  }

  const endRequest = (mode: RequestAdmission = 'ordinary'): void => {
    if (mode === 'close') state.pendingCloseRequests -= 1
    else if (mode === 'control') state.pendingControlRequests -= 1
    else state.pendingRequests -= 1
  }

  app.onRequest(methods.agent.initialize, async ({ params }) => {
    beginRequest()
    try {
      if (state.initialized) {
        throw new RequestError(
          -32043,
          'ACP connection is already initialized',
          { code: 'LOCAL_ACP_ALREADY_INITIALIZED' },
        )
      }
      // ACP v1 version negotiation: this Host supports only v1, but a valid
      // integer request for a different version is answered with v1 rather than
      // rejected. The SDK schema remains the authority for the legal integer
      // range; the client decides whether v1 is acceptable.
      // Commit the initialized state before the response leaves the handler so
      // a pipelined duplicate initialize is rejected deterministically. The
      // capability itself is resolved ONCE, before the response: the Host's own
      // exact default route and attachment store decide it, and the connection
      // keeps this frozen result for every later session/prompt.
      state.initialized = true
      // The client's standard form-based elicitation capability is negotiated
      // ONCE for this connection. Supplying `{}` advertises it; an absent or
      // null value does not, and no question Form is ever sent to such a client.
      state.elicitationForm = params.clientCapabilities?.elicitation?.form != null
      // The optional read-only projection capabilities are frozen HERE for the
      // whole connection: a later attach can never widen what this client said
      // it understands, and no notice is ever sent without a real producer.
      state.capabilities = {
        plan: params.clientCapabilities?.plan != null,
        compaction: params.clientCapabilities?.session?.compaction != null,
        subagents: params.clientCapabilities?.subagents != null,
        notices: params.clientCapabilities?.session?.notices != null,
        booleanConfigOptions: params.clientCapabilities?.session?.configOptions?.boolean != null,
      }
      state.resourceEnabled = context.sessionAccess !== undefined
        && state.views !== undefined
        && context.sessionAccess.supportsFileInput() === true
      // The client append capability is frozen ONCE for this connection, exactly
      // like the resource/image capabilities: the real shared Session View and
      // the official scoped section seam must both exist, or the capability is
      // never advertised and every non-null request stays invalid params.
      state.systemPromptAppend = context.sessionAccess !== undefined
        && state.views !== undefined
        && context.sessionAccess.supportsSystemPromptAppend() === true
      if (context.sessionAccess !== undefined && state.views !== undefined) {
        const imageEnabled = await context.sessionAccess.supportsImagePrompts()
        const bounds = imageEnabled ? deriveImageInputBounds(context.sessionAccess.imageLimits()) : undefined
        if (bounds !== undefined) {
          state.imageEnabled = true
          state.inputBounds = bounds
        }
      }
      initializeComplete = true
      // History/roster reads are advertised ONLY when the official Session
      // Controller/Query read seams are all bound: a Host that cannot read the
      // canonical log never claims `loadSession` and never claims `list`.
      const sessionReadReady = context.sessionAccess?.supportsSessionRead() === true
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: AGENT_NAME, title: AGENT_NAME, version: context.bundleVersion },
        agentCapabilities: {
          loadSession: sessionReadReady,
          promptCapabilities: { image: state.imageEnabled, audio: false, embeddedContext: state.resourceEnabled },
          // HTTP MCP support follows the REAL Session View composition: without
          // Session access/View slots this listener cannot mount a scoped lease,
          // so it must not advertise the transport. Legacy SSE has no official
          // DSH transport and stays unsupported.
          mcpCapabilities: {
            http: context.sessionAccess !== undefined && state.views !== undefined,
            sse: false,
          },
          // Advertise the shared-Session capability ONLY when this Host really
          // installed the connection-scoped View; `list` joins it only when the
          // authorized roster and canonical history read seams are ready.
          sessionCapabilities: context.sessionAccess !== undefined
            ? {
              resume: {},
              close: {},
              ...(sessionReadReady ? { list: {} } : {}),
              ...(state.systemPromptAppend ? { systemPrompt: {} } : {}),
            }
            : {},
        },
        authMethods: [],
      }
    } finally {
      endRequest()
    }
  })

  const rejectSessionOperation = (_request: { params: unknown }): never => {
    beginRequest('control')
    try {
      if (!state.initialized || !initializeComplete) {
        throw new RequestError(
          JSONRPC_INVALID_REQUEST,
          'ACP Session operations require a completed initialize',
          { code: 'LOCAL_ACP_SESSION_NOT_READY' },
        )
      }
      rejectSessionNotReady()
    } finally {
      endRequest('control')
    }
  }
  // Register with a permissive params parser for the STILL-UNSUPPORTED methods:
  // a schema rejection would otherwise answer -32602 instead of the
  // deterministic fail-closed business code, and a client's params are
  // irrelevant because the capability simply does not exist yet.
  const acceptAnyParams = (params: unknown): unknown => params

  const access = context.sessionAccess
  const views = context.views
  const slots = state.views
  if (access !== undefined && views !== undefined && slots !== undefined) {
    // PO-2 shared Session View: the three lifecycle methods are decoded with the
    // SDK's STANDARD schema (typed params), and any View rejection is mapped
    // onto a JSON-RPC RequestError that keeps the stable data code.
    const requireInitialized = (): void => {
      if (!state.initialized || !initializeComplete) {
        throw new RequestError(
          JSONRPC_INVALID_REQUEST,
          'ACP Session operations require a completed initialize',
          { code: 'LOCAL_ACP_VIEW_NOT_INITIALIZED' },
        )
      }
    }
    const asRequestError = (error: unknown): unknown =>
      error instanceof LocalAcpViewError
        ? new RequestError(error.rpcCode, error.message, { ...error.data, code: error.code })
        : error
    const listInvalidRequest = (): LocalAcpViewError => new LocalAcpViewError(
      'LOCAL_ACP_LIST_INVALID_REQUEST',
      'the session/list request cwd or cursor is not representable',
      JSONRPC_INVALID_PARAMS,
    )
    const notOwned = (sessionId: string): LocalAcpViewError => new LocalAcpViewError(
      'LOCAL_ACP_VIEW_NOT_OWNED',
      'this ACP connection holds no view for that session',
      JSONRPC_RESOURCE_NOT_FOUND,
      { sessionId },
    )
    /**
     * The three View-borrowing methods keep the ACP request-shape contract: a
     * Session id is opaque and non-empty, so an empty id is malformed
     * parameters (`-32602`) before any routing or Host lookup — never the
     * standard not-active Session, which names a real requested id.
     */
    const requireSessionId = (sessionId: string): void => {
      if (sessionId.length === 0) {
        throw new LocalAcpViewError(
          'LOCAL_ACP_VIEW_INVALID_REQUEST',
          'a non-empty sessionId is required',
          JSONRPC_INVALID_PARAMS,
        )
      }
    }
    /**
     * The listener-owned lifetime of the wire requests currently dispatched on
     * ONE view slot: from request admission to the handler's `finally`,
     * INCLUDING the post-attach initial config read. It is deliberately not a
     * Host status mirror: a repeat request is only admitted when the target
     * slot has no other unsettled request, and the exclusive `refreshing`
     * marker makes competing same-slot requests refuse instead of being
     * serialized behind an arbitrary Host await. Entries die with their slot.
     */
    interface SlotActivity {
      pending: number
      refreshing: boolean
    }
    const slotActivity = new WeakMap<ConnectionViewState, SlotActivity>()
    const activityOf = (view: ConnectionViewState): SlotActivity => {
      let activity = slotActivity.get(view)
      if (activity === undefined) {
        activity = { pending: 0, refreshing: false }
        slotActivity.set(view, activity)
      }
      return activity
    }
    const slotBusy = (message: string): LocalAcpViewError => new LocalAcpViewError(
      'LOCAL_ACP_VIEW_BUSY',
      message,
      JSONRPC_INVALID_PARAMS,
    )
    /** Record ONE admitted slot-scoped request for its whole handler lifetime. */
    const beginSlotRequest = (view: ConnectionViewState): void => {
      activityOf(view).pending += 1
    }
    const endSlotRequest = (view: ConnectionViewState): void => {
      activityOf(view).pending -= 1
    }
    /**
     * Admit ONE ordinary same-slot request (prompt/mode/config). It is refused
     * only while a reattach owns the slot; ordinary requests are NOT serialized
     * behind each other — the existing per-claim Host obligations do that. The
     * lifetime count is recorded BEFORE the refusal so the caller's `finally`
     * has exactly one matching decrement on every path (including a refusal);
     * the refused entry never outlives this synchronous frame.
     */
    const admitSameSlotRequest = (view: ConnectionViewState): void => {
      const activity = activityOf(view)
      activity.pending += 1
      if (activity.refreshing) throw slotBusy('this ACP connection is refreshing that session view')
    }
    /**
     * Reserve the EXCLUSIVE same-slot reattach gate. It is taken synchronously
     * before the first await when the target slot has no other unsettled
     * request, so a competing prompt/config/mode/repeat can never interleave a
     * request admitted against the outgoing claim generation.
     */
    const beginSlotRefresh = (view: ConnectionViewState): void => {
      const activity = activityOf(view)
      if (activity.pending !== 0 || activity.refreshing) {
        throw slotBusy('this ACP connection has an unsettled request for that session view')
      }
      activity.pending = 1
      activity.refreshing = true
    }
    const endSlotRefresh = (view: ConnectionViewState): void => {
      const activity = activityOf(view)
      activity.pending -= 1
      activity.refreshing = false
    }
    /**
     * Read the initial complete config state of the EXACT View just attached by
     * this new/resume/load call. The optional model catalog omits only the
     * complete config list (never a partial one) while the legacy mode list
     * still comes from the SAME policy cut. A stale/closed View identity is a
     * lifecycle failure and propagates instead of falsely confirming attach.
     */
    const readConfigStateOrLog = async (
      sessionId: string,
      view: ConnectionViewState,
    ): Promise<{ modes?: SessionModeState; configOptions?: SessionConfigOption[] }> => {
      try {
        const snapshot = await views.sessionConfigState(view, access, sessionId)
        if (snapshot.configOptions === undefined && snapshot.omitted === 'policy') {
          context.diag.warn('local-acp.session-policy-unavailable', {
            code: 'LOCAL_ACP_CONFIG_UNAVAILABLE',
            reason: 'LOCAL_ACP_CONFIG_UNAVAILABLE',
          })
        } else if (snapshot.configOptions === undefined) {
          context.diag.warn('local-acp.model-catalog-unavailable', {
            code: 'LOCAL_ACP_MODEL_CATALOG_UNAVAILABLE',
            reason: 'LOCAL_ACP_MODEL_UNAVAILABLE',
          })
        }
        return {
          ...(snapshot.modes === undefined ? {} : { modes: snapshot.modes }),
          ...(snapshot.configOptions === undefined ? {} : { configOptions: [...snapshot.configOptions] }),
        }
      } catch (error) {
        // A lifecycle failure (stale identity/replaced View) propagates; an
        // optional display omission is already represented by the snapshot, so
        // there is no catch-all that could falsely confirm an attach.
        throw error
      }
    }
    /** The transient config notification sink of ONE connection's attached View. */
    const configNotifierFor = (client: AgentContext): AcpConfigUpdateNotifier =>
      async (sessionId: string, update: AcpConfigUpdate) => {
        if (update.kind === 'mode') {
          await client.notify(methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'current_mode_update', currentModeId: update.currentModeId },
          })
          return
        }
        await client.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: [...update.configOptions] },
        })
      }
    /**
     * The ONE connection-scoped reverse elicitation channel of an attached View.
     * It is built from the SAME SDK client context as the `session/new|resume`
     * request (exactly like `configNotifierFor`), so it stays usable after that
     * request settles while its connection lives — and only then: a torn-down
     * connection refuses without touching a second socket or a Host Session.
     */
    const requestElicitationFor = (client: AgentContext): AcpElicitationRequester =>
      async (request, options) => {
        if (state.closed || !state.elicitationForm) {
          throw new LocalAcpViewError(
            'LOCAL_ACP_QUESTION_UNAVAILABLE',
            'this ACP connection cannot receive a question form',
            JSONRPC_INTERNAL_ERROR,
          )
        }
        const response = await client.request(methods.client.elicitation.create, {
          mode: 'form',
          message: request.message,
          sessionId: request.sessionId,
          ...request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId },
          requestedSchema: request.requestedSchema,
        }, { cancellationSignal: options.signal })
        return 'content' in response
          ? { action: response.action, content: response.content }
          : { action: response.action }
      }
    /**
     * The ONE read-only projection sink of an attached View. It is built from
     * the SAME SDK client context as the attach request (exactly like the
     * config-options notifier), so it stays usable after that request settles
     * while this connection lives and never reaches another connection.
     */
    const projectionNotifierFor = (client: AgentContext): AcpProjectionNotifier =>
      async (sessionId, update) => {
        await client.notify(methods.client.session.update, { sessionId, update })
      }
    /** The per-connection transient channels an attached View may use. */
    const viewChannelsFor = (client: AgentContext): AcpViewChannels => ({
      notifyConfigUpdate: configNotifierFor(client),
      notifyProjection: projectionNotifierFor(client),
      capabilities: state.capabilities,
      maxOutputFrameBytes: state.maxOutputFrameBytes,
      systemPromptAppend: state.systemPromptAppend,
      ...state.elicitationForm ? { requestElicitation: requestElicitationFor(client) } : {},
    })
    app.onRequest(methods.agent.session.new, async ({ params, client, signal }) => {
      beginRequest('control')
      let view: ConnectionViewState | undefined
      try {
        requireInitialized()
        view = createSessionViewSlot(slots, views)
        // The fresh attach owns the slot exclusively through its initial config
        // read: no same-slot prompt/config can start on a generation whose
        // attach response the client has not received yet.
        beginSlotRefresh(view)
        const result = await views.newSession(view, access, params, viewChannelsFor(client), signal)
        const sessionId = result.sessionId
        const attachedView = view
        const onAbort = (): void => { views.retireFailedAttach(attachedView, sessionId, access) }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (signal.aborted) {
            views.retireFailedAttach(attachedView, sessionId, access)
            signal.throwIfAborted()
          }
          const config = await readConfigStateOrLog(sessionId, attachedView)
          if (signal.aborted) {
            views.retireFailedAttach(attachedView, sessionId, access)
            signal.throwIfAborted()
          }
          return { ...result, ...config }
        } catch (error) {
          // A committed fresh attach whose initial config terminal failed also
          // retires exactly this generation; the client never saw a success.
          views.retireFailedAttach(attachedView, sessionId, access)
          throw error
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      } catch (error) {
        throw asRequestError(error)
      } finally {
        if (view !== undefined) {
          if (activityOf(view).refreshing) endSlotRefresh(view)
          else endSlotRequest(view)
          releaseIdleViewSlot(slots, views, view)
        }
        views.clearAttachAbort(signal)
        endRequest('control')
      }
    })
    app.onRequest(methods.agent.session.resume, async ({ params, client, signal }) => {
      beginRequest('control')
      let view: ConnectionViewState | undefined
      try {
        requireInitialized()
        // The SAME physical connection may already hold this Session: reloading
        // its own settled View is a reattach, not a conflict. It reuses the
        // existing routing slot (never a ninth/ninth-new slot) and replaces only
        // this connection's exact claim generation.
        const existing = routeOwnedView(slots, views, params.sessionId)
        if (existing !== undefined) {
          beginSlotRefresh(existing)
          view = existing
          const result = await views.resumeSession(existing, access, params, viewChannelsFor(client), signal, true)
          try {
            const config = await readConfigStateOrLog(params.sessionId, existing)
            signal.throwIfAborted()
            return { ...result, ...config }
          } catch (error) {
            // The refresh already committed a fresh claim the client never saw
            // succeed: a post-commit config failure or an abort retires ONLY
            // that exact generation (never the old one, never a Host cancel or
            // close). A concurrent close/EOF that already retired it is a no-op.
            views.retireFailedRefresh(existing, params.sessionId)
            signal.throwIfAborted()
            throw error
          }
        }
        view = createSessionViewSlot(slots, views)
        beginSlotRefresh(view)
        const result = await views.resumeSession(view, access, params, viewChannelsFor(client), signal)
        const attachedView = view
        const sessionId = params.sessionId
        const onAbort = (): void => { views.retireFailedAttach(attachedView, sessionId, access) }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (signal.aborted) {
            views.retireFailedAttach(attachedView, sessionId, access)
            signal.throwIfAborted()
          }
          const config = await readConfigStateOrLog(sessionId, attachedView)
          if (signal.aborted) {
            views.retireFailedAttach(attachedView, sessionId, access)
            signal.throwIfAborted()
          }
          return { ...result, ...config }
        } catch (error) {
          // A committed fresh attach whose initial config terminal failed also
          // retires exactly this generation; the client never saw a success.
          views.retireFailedAttach(attachedView, sessionId, access)
          throw error
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      } catch (error) {
        throw asRequestError(error)
      } finally {
        if (view !== undefined) {
          if (activityOf(view).refreshing) endSlotRefresh(view)
          else endSlotRequest(view)
          releaseIdleViewSlot(slots, views, view)
        }
        views.clearAttachAbort(signal)
        endRequest('control')
      }
    })
    // `session/load` is `session/resume` PLUS the complete canonical history:
    // the same official attach (one cold resume at most, same slot/MCP policy)
    // and the View-owned replay barrier that answers only after the ordered
    // drain. It is registered only when the Host read seams are all ready.
    const sessionReadReady = access.supportsSessionRead()
    app.onRequest(methods.agent.session.load, async ({ params, client, signal }) => {
      beginRequest('control')
      let view: ConnectionViewState | undefined
      try {
        requireInitialized()
        if (!sessionReadReady) {
          throw new LocalAcpViewError(
            'LOCAL_ACP_LOAD_UNAVAILABLE',
            'this Host cannot replay canonical Session history',
            JSONRPC_INVALID_PARAMS,
          )
        }
        // Same-connection reattach: the whole canonical history is re-read for
        // THIS request on a fresh claim generation; no new slot is allocated.
        const existing = routeOwnedView(slots, views, params.sessionId)
        if (existing !== undefined) {
          beginSlotRefresh(existing)
          view = existing
          const result = await views.loadSession(existing, access, params, viewChannelsFor(client), signal, true)
          try {
            const config = await readConfigStateOrLog(params.sessionId, existing)
            signal.throwIfAborted()
            return { ...result, ...config }
          } catch (error) {
            // A replay success followed by a failed/aborted post-attach config
            // read is still this refresh's fresh generation: retire exactly it.
            views.retireFailedRefresh(existing, params.sessionId)
            signal.throwIfAborted()
            throw error
          }
        }
        view = createSessionViewSlot(slots, views)
        beginSlotRefresh(view)
        const result = await views.loadSession(view, access, params, viewChannelsFor(client), signal)
        const attachedView = view
        const sessionId = params.sessionId
        const onAbort = (): void => { views.retireFailedAttach(attachedView, sessionId, access) }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (signal.aborted) {
            views.retireFailedAttach(attachedView, sessionId, access)
            signal.throwIfAborted()
          }
          const config = await readConfigStateOrLog(sessionId, attachedView)
          if (signal.aborted) {
            views.retireFailedAttach(attachedView, sessionId, access)
            signal.throwIfAborted()
          }
          return { ...result, ...config }
        } catch (error) {
          // A committed fresh attach whose initial config terminal failed also
          // retires exactly this generation; the client never saw a success.
          views.retireFailedAttach(attachedView, sessionId, access)
          throw error
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      } catch (error) {
        throw asRequestError(error)
      } finally {
        if (view !== undefined) {
          if (activityOf(view).refreshing) endSlotRefresh(view)
          else endSlotRequest(view)
          releaseIdleViewSlot(slots, views, view)
        }
        views.clearAttachAbort(signal)
        endRequest('control')
      }
    })
    // `session/list` reads ONLY the authorized official roster: it never
    // creates a claim, resumes an Agent or touches a Session writer.
    app.onRequest(methods.agent.session.list, async ({ params, signal }) => {
      beginRequest('control')
      try {
        requireInitialized()
        if (!sessionReadReady) {
          throw new LocalAcpViewError(
            'LOCAL_ACP_LIST_UNAVAILABLE',
            'this Host has no authorized Session roster',
            JSONRPC_INVALID_PARAMS,
          )
        }
        let request: { readonly cwd?: string; readonly cursor?: string }
        try {
          request = readSessionListRequest(params)
        } catch {
          throw listInvalidRequest()
        }
        signal.throwIfAborted()
        const rows = await access.readSessionList(signal)
        signal.throwIfAborted()
        let page: ReturnType<typeof selectSessionPage>
        try {
          page = selectSessionPage(rows, request)
        } catch {
          throw listInvalidRequest()
        }
        return {
          sessions: page.sessions.map(row => ({
            sessionId: row.sessionId,
            cwd: row.cwd,
            ...(row.title === undefined ? {} : { title: row.title }),
            updatedAt: row.updatedAt,
          })),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        }
      } catch (error) {
        // A roster read failure is never a fabricated empty page; a caller
        // abort keeps its own transport classification.
        signal.throwIfAborted()
        throw asRequestError(error)
      } finally {
        endRequest('control')
      }
    })
    app.onRequest(methods.agent.session.close, async ({ params }) => {
      beginRequest('close')
      let view: ConnectionViewState | undefined
      try {
        requireInitialized()
        view = routeOwnedView(slots, views, params.sessionId)
        // Unknown, inactive or foreign Session: the standard idempotent `{}`
        // without any Host operation.
        if (view === undefined) return {}
        // Close is never blocked by the reattach marker: it must stay reachable
        // while a refresh or another settled request holds the slot.
        beginSlotRequest(view)
        return await views.closeSession(view, access, params.sessionId)
      } catch (error) {
        throw asRequestError(error)
      } finally {
        // Only this exact slot can become reclaimable; another Session's View
        // is never observed or mutated.
        if (view !== undefined) {
          endSlotRequest(view)
          releaseIdleViewSlot(slots, views, view)
        }
        endRequest('close')
      }
    })
    // PO-3B: ONE text prompt per attached View. The request's own SDK context
    // supplies the abort lifecycle and the ONLY notification + reverse-request
    // sinks — this connection's client. Routing selects the exact claiming slot;
    // no last-active Session or mutable connection-wide view exists.
    app.onRequest(methods.agent.session.prompt, async ({ params, signal, client }) => {
      beginRequest()
      let view: ConnectionViewState | undefined
      try {
        requireInitialized()
        requireSessionId(params.sessionId)
        view = routeOwnedView(slots, views, params.sessionId)
        if (view === undefined) throw notOwned(params.sessionId)
        admitSameSlotRequest(view)
        return await views.promptSession(view, access, params, signal, state.imageEnabled, async update => {
          await client.notify(methods.client.session.update, { sessionId: params.sessionId, update })
        }, async (permissionParams, options) => {
          return await client.request(methods.client.session.requestPermission, {
            sessionId: permissionParams.sessionId,
            toolCall: permissionParams.toolCall,
            options: permissionParams.options,
          }, options === undefined ? undefined : { cancellationSignal: options.signal })
        }, { enabled: state.resourceEnabled, budget: MAX_INPUT_FRAME_BYTES })
      } catch (error) {
        throw asRequestError(error)
      } finally {
        if (view !== undefined) endSlotRequest(view)
        state.pendingRequests -= 1
      }
    })
    // Standard ACP v1 session mode: the legacy `modes` list admitted at attach
    // is the delivery eligibility fact; the View applies the exact-claim and
    // official-maintenance admission before any Session write.
    app.onRequest(methods.agent.session.setMode, async ({ params, signal }) => {
      beginRequest('control')
      let view: ConnectionViewState | undefined
      try {
        requireInitialized()
        // The standard mode vocabulary is validated as an ordinary shape
        // refusal, independent of claim ownership: an unknown id must never
        // become method-not-found or a Host side effect.
        if (modeOfWireId(params.modeId) === undefined) {
          const invalid = invalidPolicyOption('the requested session mode is not selectable')
          throw new LocalAcpViewError(invalid.code, invalid.message, invalid.rpcCode)
        }
        requireSessionId(params.sessionId)
        view = routeOwnedView(slots, views, params.sessionId)
        if (view === undefined) throw notOwned(params.sessionId)
        admitSameSlotRequest(view)
        return await views.setMode(view, access, params.sessionId, params.modeId, signal)
      } catch (error) {
        throw asRequestError(error)
      } finally {
        if (view !== undefined) endSlotRequest(view)
        endRequest('control')
      }
    })
    // Session config-option subset: standard typed handler (the SDK parses the
    // request against the pinned v1 schema); the View routes mode/Team to the
    // official policy and model/thought_level to the existing model service.
    app.onRequest(methods.agent.session.setConfigOption, async ({ params, signal }) => {
      beginRequest('control')
      let view: ConnectionViewState | undefined
      try {
        requireInitialized()
        requireSessionId(params.sessionId)
        view = routeOwnedView(slots, views, params.sessionId)
        if (view === undefined) throw notOwned(params.sessionId)
        admitSameSlotRequest(view)
        const configOptions = await views.setConfigOption(view, access, params, signal)
        return { configOptions }
      } catch (error) {
        throw asRequestError(error)
      } finally {
        if (view !== undefined) endSlotRequest(view)
        endRequest('control')
      }
    })
  } else {
    // No real Host Session View installed (raw socket contracts): the lifecycle
    // methods stay fail-closed exactly like PO-1.
    app.onRequest(methods.agent.session.new, acceptAnyParams, rejectSessionOperation)
    app.onRequest(methods.agent.session.resume, acceptAnyParams, rejectSessionOperation)
    app.onRequest(methods.agent.session.close, acceptAnyParams, rejectSessionOperation)
    app.onRequest(methods.agent.session.prompt, acceptAnyParams, rejectSessionOperation)
    app.onRequest(methods.agent.session.setMode, acceptAnyParams, rejectSessionOperation)
    app.onRequest(methods.agent.session.setConfigOption, acceptAnyParams, rejectSessionOperation)
    app.onRequest(methods.agent.session.load, acceptAnyParams, rejectSessionOperation)
    app.onRequest(methods.agent.session.list, acceptAnyParams, rejectSessionOperation)
  }

  if (access !== undefined && views !== undefined && slots !== undefined) {
    // A `session/cancel` notification carries no response. PO-3B scopes it to
    // the exact connection-local View that owns the Session: an idle View (or a
    // Session this connection does not hold) is a no-op that never touches a
    // Host Agent; a queued/running flight is addressed through the same scoped
    // cancellation the close path uses, and the request settles on the real
    // Host facts alone.
    app.onNotification(methods.agent.session.cancel, ({ params }) => {
      if (!state.initialized) return
      if (typeof params?.sessionId !== 'string' || params.sessionId === '') return
      const view = routeOwnedView(slots, views, params.sessionId)
      if (view !== undefined) views.cancelSession(view, access, params.sessionId)
    })
  } else {
    // No Host Session View installed: a cancel notification stays a no-op.
    app.onNotification(methods.agent.session.cancel, () => {})
  }

  return app
}

/** Wire one accepted socket to its own SDK connection; only this connection is affected by a fault. */
function serveConnection(socket: Socket, context: ListenerContext): void {
  const viewRoster = context.views === undefined ? undefined : new Set<ConnectionViewState>()
  const state: ConnectionState = {
    initialized: false,
    pendingRequests: 0,
    pendingControlRequests: 0,
    pendingCloseRequests: 0,
    closed: false,
    imageEnabled: false,
    resourceEnabled: false,
    systemPromptAppend: false,
    elicitationForm: false,
    capabilities: { plan: false, compaction: false, subagents: false, notices: false, booleanConfigOptions: false },
    inputBounds: TEXT_ONLY_BOUNDS,
    maxOutputFrameBytes: deriveImageOutputBounds(context.sessionAccess?.imageLimits()) ?? MAX_OUTPUT_FRAME_BYTES,
    ...(viewRoster === undefined ? {} : { views: viewRoster }),
  }
  context.connectionStates.set(socket, state)

  let tornDown = false
  let connection: AgentConnection | undefined

  const fail = (code: string, detail?: ReplyDebtFailureDetail): void => {
    if (state.closed) return
    state.closed = true
    context.diag.warn('local-acp.error', { code, ...(detail ?? {}), connections: context.connections.size })
    socket.destroy()
  }

  const teardown = (): void => {
    if (tornDown) return
    tornDown = true
    state.closed = true
    // BOTH `session/close` and a physical socket end/error/destroy (or Host Off)
    // release through the SAME idempotent View path, once per view slot. A
    // claim with an open flight keeps its scoped cancellation running (late
    // insertions included) and is released only by its proven settlement; no
    // Host Agent/Session is disposed or flushed. The snapshot is required
    // because releaseConnection may retire claims for every slot.
    if (viewRoster !== undefined) {
      const snapshot = [...viewRoster]
      for (const view of snapshot) context.views?.releaseConnection(view, context.sessionAccess)
      viewRoster.clear()
    }
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

  const input = createBoundedInput(socket, state, fail)
  const output = createBoundedOutput(socket, fail, state.maxOutputFrameBytes)
  const app = buildAgentApp(state, context, fail)
  const stream = createReplyDebtStream(ndJsonStream(output, input), {
    isClosed: () => state.closed || socket.destroyed,
    fail: (code, detail) => fail(code, detail),
  })
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

/** The physical, profile-scoped endpoint the Darwin Host binds and publishes. */
export interface DarwinAcpSocketPaths {
  /** The public contract pathname independent ACP peers connect to. */
  readonly publicPath: string
  /** The deterministic 0700 root owned by this uid and profile scope. */
  readonly privateRoot: string
  /** The private bind name the inode is published from (never a client address). */
  readonly privateBindPath: string
}

/**
 * Compute the FROZEN Darwin endpoint from the real profile scope id and the
 * current OS uid: `/private/tmp/dpt-<decimal-uid>-<scope40>` holds one 0700 root
 * whose `acp.sock` is the public address and whose `.acp-priv/acp.sock` is the
 * private bind name. No configuration, environment variable or user path can
 * change it, and both names must fit `sun_path[104]` INCLUDING the NUL. The
 * caller creates/admits the root; this function performs no filesystem IO.
 *
 * @param scope - the canonical profile scope (its `scopeId` is a 64-hex SHA-256).
 * @param uid - the current process uid; the root is scoped to this exact uid.
 * @returns the public, root and private bind pathnames.
 * @throws {LocalAcpError} `LOCAL_ACP_SOCKET_PATH_UNSUPPORTED` when a name exceeds
 *   the Darwin kernel path capacity.
 */
export function darwinAcpSocketPaths(scope: LocalScope, uid: number): DarwinAcpSocketPaths {
  const privateRoot = join(DARWIN_SOCKET_PARENT, `${DARWIN_ROOT_PREFIX}${String(uid)}-${scope.scopeId.slice(0, DARWIN_SCOPE_PREFIX_HEX)}`)
  const publicPath = join(privateRoot, SOCKET_FILE)
  const privateBindPath = join(privateRoot, PRIVATE_DIR, SOCKET_FILE)
  if (Buffer.byteLength(publicPath, 'utf8') + 1 > DARWIN_SUN_PATH_BYTES
    || Buffer.byteLength(privateBindPath, 'utf8') + 1 > DARWIN_SUN_PATH_BYTES) {
    throw new LocalAcpError(
      'LOCAL_ACP_SOCKET_PATH_UNSUPPORTED',
      'local acp: the Darwin endpoint exceeds the kernel sun_path byte limit',
    )
  }
  return { publicPath, privateRoot, privateBindPath }
}

/**
 * Admit the trusted Darwin parent and create/reuse the ONE deterministic 0700
 * root of this profile scope. `/private/tmp` must be the OS-owned, root-owned
 * sticky directory the frozen endpoint contract relies on; the root itself must
 * be a real directory owned by this uid (a symlink, file, foreign-owned entry or
 * an EXISTING directory that is not 0700 is refused and never written through or
 * silently repaired). The root is REUSED across ACP Off/On and Host crashes —
 * only this scope's root is ever touched.
 */
function ensureDarwinSocketRoot(privateRoot: string, uid: number): void {
  let parent: ReturnType<typeof lstatSync>
  try {
    parent = lstatSync(DARWIN_SOCKET_PARENT)
  } catch (error) {
    throw new LocalAcpError('LOCAL_ACP_SOCKET_PATH_UNSUPPORTED', 'local acp: the Darwin socket parent is not available', error)
  }
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o1000) === 0) {
    throw new LocalAcpError(
      'LOCAL_ACP_SOCKET_PATH_UNSUPPORTED',
      'local acp: the Darwin socket parent is not a root-owned sticky directory',
    )
  }
  let created = true
  try {
    mkdirSync(privateRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new LocalAcpError('LOCAL_ACP_SOCKET_PATH_UNSUPPORTED', 'local acp: the Darwin endpoint root could not be created', error)
    }
    created = false
  }
  const info = lstatSync(privateRoot)
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) {
    throw new LocalAcpError(
      'LOCAL_ACP_UNSAFE_SOCKET',
      'local acp: the Darwin endpoint root is not a private directory owned by this uid',
    )
  }
  if (created) {
    // The endpoint contract is 0700 for the root THIS run just created; force it
    // so the caller's umask can never weaken the mode.
    chmodSync(privateRoot, 0o700)
    return
  }
  // An EXISTING root must already be the private directory the contract names.
  // It is never silently repaired: a non-private mode means the directory is not
  // the one this contract created.
  if ((info.mode & 0o777) !== 0o700) {
    throw new LocalAcpError(
      'LOCAL_ACP_UNSAFE_SOCKET',
      'local acp: the existing Darwin endpoint root is not a 0700 directory owned by this uid',
    )
  }
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

interface ListenerRuntime {
  readonly context: ListenerContext
  readonly releasePromptFacts: () => void
  readonly disposeFactsWhenSettled: () => void
}

/**
 * The ONE connection/fact runtime shared by the POSIX and Windows listeners.
 * A BIND-LOCAL registry is owned by this listener and is disposed after its
 * accepted work settles; a CONTROLLER-owned (shared) registry outlives listener
 * rebinds and is disposed by the controller, so an Off -> On overlap never
 * registers the same registry twice (R701-03). Installation is idempotent
 * either way. Nothing here performs IO or binds a transport.
 */
function createListenerRuntime(options: StartLocalAcpListenerOptions): ListenerRuntime {
  const { scope, diag, sessionAccess, views: sharedViews } = options
  const context: ListenerContext = {
    diag,
    bundleVersion: scope.bundleVersion,
    connections: new Set<Socket>(),
    connectionStates: new Map<Socket, ConnectionState>(),
    ...(sessionAccess === undefined
      ? {}
      : { sessionAccess, views: sharedViews ?? new AcpSessionViewRegistry(diag) }),
  }
  const views = context.views
  const ownsFacts = views !== undefined && sessionAccess !== undefined && sharedViews === undefined
  if (views !== undefined && sessionAccess !== undefined) views.observeFacts(sessionAccess)
  const releasePromptFacts = (): void => {
    if (!ownsFacts) return
    views?.disposeFacts()
  }
  /**
   * Dispose the ONE Host fact subscription once every ACCEPTED piece of work
   * has settled on real Host facts (a pending admission inserted/classified,
   * a queued removal committed, the owned turn's terminal drained, or a
   * retired-turn fence ended). It never cancels work the ACP View may not
   * cancel (D23 mixed turns) and never guesses with a timer: the registry's
   * own settlement transitions resolve it. Detached, so retirement and Host
   * shutdown are never blocked by a shared turn's duration.
   */
  const disposeFactsWhenSettled = (): void => {
    if (views === undefined || !ownsFacts) return
    runDetached('local acp: Host fact subscription retirement', async () => {
      await views.whenHostWorkSettled()
      releasePromptFacts()
    }, { diag })
  }
  return { context, releasePromptFacts, disposeFactsWhenSettled }
}

/**
 * The native Windows family of the ONE listener: a profile-scoped Named Pipe
 * with the same accept callback, capacity bound, `serveConnection`, ACP SDK,
 * View registry and fact subscription as the POSIX endpoint. The one-shot
 * owner-only/NETWORK-deny DACL is applied BEFORE the handle can report
 * `enabled`; retirement is kernel name lifetime only (no filesystem inode).
 */
async function startWin32LocalAcpListener(
  options: StartLocalAcpListenerOptions,
  runtime: ListenerRuntime,
): Promise<LocalAcpListener> {
  const { scope, maxConnections, diag } = options
  const { context, releasePromptFacts, disposeFactsWhenSettled } = runtime
  const pipeName = acpPipeAddress(scope.scopeId)
  let server: Server | undefined
  let stopping = false
  let closed: Promise<void> | undefined
  let secured = false

  const retire = (): Promise<void> => {
    if (closed !== undefined) return closed
    stopping = true
    closed = (async () => {
      for (const socket of context.connections) socket.destroy()
      if (server !== undefined) {
        await new Promise<void>(resolveClose => {
          server!.close(() => resolveClose())
        })
      }
      disposeFactsWhenSettled()
    })()
    return closed
  }

  try {
    server = createServer(socket => {
      if (stopping) {
        socket.destroy()
        return
      }
      // The Node/libuv first instance exists with the process default DACL
      // before the one-shot protected DACL can be written. A socket accepted in
      // that short window is destroyed here and never enters the connection
      // registry, `serveConnection`, the peer cap or any ACP byte stream.
      if (!secured) {
        socket.destroy()
        return
      }
      if (context.connections.size >= maxConnections) {
        diag.warn('local-acp.connection.reject', { code: 'LOCAL_ACP_CAPACITY_EXCEEDED', connections: context.connections.size })
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
      server!.listen(pipeName, () => {
        server!.off('error', rejectListen)
        resolveListen()
      })
    })
    server.on('error', error => {
      diag.warn('local-acp.error', { code: (error as NodeJS.ErrnoException).code ?? 'LOCAL_ACP_SERVER_ERROR' })
    })
    try {
      secureWin32AcpPipe(pipeName)
      // Deliver any connection accepted by the pre-ACL instance through the
      // gate above (and destroy it) before reporting the listener enabled.
      await new Promise<void>(resolve => setImmediate(resolve))
      secured = true
    } catch (error) {
      throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the Windows named-pipe endpoint could not be secured', error)
    }
    diag.info('local-acp.listen', { connections: 0 })
  } catch (error) {
    for (const socket of context.connections) socket.destroy()
    releasePromptFacts()
    if (server !== undefined) {
      try {
        await new Promise<void>(resolveClose => {
          server!.close(() => resolveClose())
        })
      } catch {
        // The bind may never have completed; closing is best effort here.
      }
    }
    if (error instanceof LocalAcpError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      throw new LocalAcpError('LOCAL_ACP_SOCKET_IN_USE', 'local acp: a live listener already answers on the named-pipe endpoint', error)
    }
    throw new LocalAcpError('LOCAL_ACP_SOCKET_PATH_UNSUPPORTED', 'local acp: the Windows named-pipe endpoint could not be bound', error)
  }

  const isListening = (): boolean => {
    if (stopping || closed !== undefined || server === undefined || !server.listening) return false
    return secured
  }

  return {
    socketPath: pipeName,
    connectionCount: () => context.connections.size,
    isListening,
    close: retire,
    cleanupSync: () => {},
  }
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
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 16) {
    throw new LocalAcpError('LOCAL_ACP_INVALID_MAX_CONNECTIONS', 'local acp: maxConnections must be an integer in 1..16')
  }
  const platform = process.platform
  const darwin = platform === 'darwin'
  if (platform !== 'linux' && !darwin && platform !== 'win32') {
    throw new LocalAcpError('LOCAL_ACP_SOCKET_PATH_UNSUPPORTED', 'local acp: the local ACP endpoint is supported on Linux, macOS and Windows only')
  }
  if (platform === 'win32') {
    const runtime = createListenerRuntime(options)
    return await startWin32LocalAcpListener(options, runtime)
  }
  const uid = process.getuid?.()
  if (typeof uid !== 'number') {
    throw new LocalAcpError('LOCAL_ACP_SOCKET_PATH_UNSUPPORTED', 'local acp: the current uid is unavailable')
  }
  // ONE platform-specific physical endpoint: Linux keeps the scope directory and
  // shortens the bind through /proc/self/fd; Darwin publishes the inode onto the
  // short, profile-scoped /private/tmp endpoint. Both are derived from the SAME
  // canonical scope fact, never from $TMPDIR, $HOME or the current directory.
  const darwinPaths = darwin ? darwinAcpSocketPaths(scope, uid) : undefined
  const logicalPath = darwinPaths === undefined ? join(scope.dir, SOCKET_FILE) : darwinPaths.publicPath
  let scopeDirFd: number | undefined
  if (darwinPaths === undefined) {
    // The scope dirfd is used ONLY to probe/reclaim a stale pathname BEFORE bind.
    scopeDirFd = openScopeDirFd(scope)
  } else {
    // Admit the OS-owned sticky parent and create/reuse THIS scope's 0700 root
    // before any probe, bind or publish uses the endpoint.
    ensureDarwinSocketRoot(darwinPaths.privateRoot, uid)
  }
  const scopeProbePath = scopeDirFd === undefined ? logicalPath : fdSocketPath(scopeDirFd)
  // The server is BOUND inside a private, owner-only subdirectory (fd-shortened
  // on Linux, a direct short name on Darwin) and its inode is then hard-linked
  // onto the contract path (then the private name is unlinked). Node's
  // net.Server.close() unlinks the path it was told to listen on; because that
  // private name is already gone, the automatic unlink is always ENOENT and can
  // never touch a foreign inode at the contract path. On Linux the private dirfd
  // is kept OPEN across close, so its /proc/self/fd path can never be redirected
  // to another directory by fd-number reuse — the fix does NOT rely on a released
  // fd staying unused. Darwin holds no directory fd and never uses /proc or
  // /dev/fd.
  const privDir = darwinPaths === undefined ? join(scope.dir, PRIVATE_DIR) : join(darwinPaths.privateRoot, PRIVATE_DIR)
  let privFd: number | undefined
  let scopeDirFdClosed = false
  let privFdClosed = false

  let saved: SavedInode | undefined
  let server: Server | undefined
  let stopping = false
  let closed: Promise<void> | undefined

  const runtime = createListenerRuntime(options)
  const { context, releasePromptFacts, disposeFactsWhenSettled } = runtime

  const closeScopeDirFd = (): void => {
    if (scopeDirFdClosed || scopeDirFd === undefined) return
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
      // Retirement is the NETWORK entry's lifetime, never the Host work's:
      // stop accepting, close the sockets and retire our inode immediately so
      // a runtime Off or SIGTERM can always progress to the official Host
      // shutdown (R701-01b). The ONE Host fact subscription is handed to its
      // own settled-driven disposer instead of blocking here.
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
      disposeFactsWhenSettled()
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
    //    Create it NON-recursively and VALIDATE an existing entry as a real dir we
    //    own BEFORE any chmod (never chmod through a symlink / foreign dir).
    let privCreated = true
    try {
      mkdirSync(privDir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the private bind directory could not be created', error)
      }
      privCreated = false
    }
    if (!privCreated) {
      const dirInfo = lstatSync(privDir)
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || dirInfo.uid !== uid) {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the private bind path is not a directory owned by this uid')
      }
    }
    chmodSync(privDir, 0o700)
    let privBindPath: string
    if (darwinPaths === undefined) {
      privFd = openSync(privDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      privBindPath = fdSocketPath(privFd)
    } else {
      // Darwin binds the direct short private name; no directory fd is held and
      // no /proc or /dev/fd shortcut is used.
      privBindPath = darwinPaths.privateBindPath
    }
    // Recover a stale PRIVATE bind name left by a crash BETWEEN the private bind
    // and the private-name unlink (e.g. SIGKILL mid-startup). Only this one
    // anchored private name is considered — never a scope-wide scan, never another
    // .acp-* entry. A live/foreign/unsafe occupant is refused; a proven-stale own
    // socket inode is unlinked so the next bind does not hit EADDRINUSE.
    let privExisting: ReturnType<typeof lstatSync> | undefined
    try {
      privExisting = lstatSync(privBindPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the private bind path is not accessible', error)
      }
    }
    if (privExisting !== undefined) {
      if (privExisting.isSymbolicLink() || !privExisting.isSocket() || privExisting.uid !== uid) {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the private bind path is occupied by a non-socket, symlink or foreign-owned entry')
      }
      const privVerdict = await probeSocket(privBindPath)
      if (privVerdict === 'open') {
        throw new LocalAcpError('LOCAL_ACP_SOCKET_IN_USE', 'local acp: a live listener already occupies the private bind path')
      }
      if (privVerdict !== 'refused') {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the private bind path could not be proven stale')
      }
      const privRecheck = readSavedInode(privBindPath, uid)
      if (privRecheck.dev !== privExisting.dev || privRecheck.ino !== privExisting.ino) {
        throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the private socket inode changed during the stale recover')
      }
      unlinkSync(privBindPath)
    }
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

    // 3. Force the private inode to 0600, then publish it onto the contract path
    //    with a no-replace hard link and drop the private name (see below).
    chmodSync(join(privDir, SOCKET_FILE), 0o600)
    // Publish the socket with a KERNEL-ATOMIC NO-REPLACE operation: hard-link the
    // private socket inode onto the contract path. If ANY foreign entry occupies
    // the path — including one that appeared during the race — linkSync fails
    // EEXIST and we NEVER overwrite it. This closes the check-then-rename TOCTOU.
    try {
      linkSync(join(privDir, SOCKET_FILE), logicalPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        throw new LocalAcpError('LOCAL_ACP_SOCKET_IN_USE', 'local acp: a foreign entry occupies the socket path (refusing to overwrite it)')
      }
      throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the socket path could not be published', error)
    }
    // The contract path now references OUR inode; capture identity immediately so
    // any later failure removes only ours. Then drop the private name (the inode
    // is kept by the contract link and the listening server fd); Node's later
    // close-unlink targets this now-absent private name → ENOENT, never foreign.
    const linked = lstatSync(logicalPath)
    saved = { dev: linked.dev, ino: linked.ino, uid: linked.uid }
    if (!linked.isSocket() || linked.uid !== uid) {
      throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the published socket is not a socket owned by this uid')
    }
    unlinkSync(join(privDir, SOCKET_FILE))
    if ((linked.mode & 0o777) !== 0o600) {
      throw new LocalAcpError('LOCAL_ACP_UNSAFE_SOCKET', 'local acp: the bound socket is not a 0600 socket owned by this uid')
    }
    closeScopeDirFd()
    diag.info('local-acp.listen', { connections: 0 })
  } catch (error) {
    // Any failure after bind must not leave OUR bound socket behind, and must
    // never delete a foreign inode. Keep privFd open across close (private bind
    // path → ENOENT), remove only our contract-path inode, then release fds.
    for (const socket of context.connections) socket.destroy()
    releasePromptFacts()
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
