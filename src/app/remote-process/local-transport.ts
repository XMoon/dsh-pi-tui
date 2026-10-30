/**
 * M4-B1 official Client transport over the authenticated local Host.
 *
 * This module installs exactly the three DSH rc.4 Node Client halves on the
 * caller-owned A0 Client Context: the Typert registry, the official Connection
 * (explicit Cookie-bearing fetch/WebSocket carrier), and the API Gateway
 * Client. It never creates a second Context, never sets `ownsHost`, never uses
 * an in-process RPC bridge, and never owns a Host shutdown.
 *
 * @module app/remote-process/local-transport
 */

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { mergeCause } from '../remote/dispose-cause.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import {
  LocalScopeError,
  readProcessStarttime,
  type LocalScope,
} from './local-scope.ts'
import {
  connectForCookie,
  readLaunchMaterial,
  readLocalRecord,
  type LocalInstanceRecord,
  type VerifiedLocalHost,
} from './local-discovery.ts'

/** The three official Node Client module entry specifiers. */
const NODE_CLIENT_MODULES = [
  '@deepseek-ai/dsh-typert-registry/client',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-api-gateway/client',
] as const

/** Bound on the first real Gateway generation after HTTP authentication. */
const GENERATION_READY_TIMEOUT_MS = 30_000

/** Connection states the official handle publishes. */
export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

/** Host facts carried by one ready generation. */
export interface ConnectionGeneration {
  readonly id: number
  readonly host: { readonly home: string }
}

/** The official Connection surface this transport derives status from. */
export interface LocalTransportConnection {
  readonly state: { getSnapshot(): ConnectionState | undefined }
  readonly generation: {
    getSnapshot(): ConnectionGeneration | undefined
    subscribe(listener: () => void): () => void
  }
}

/** A status snapshot built at call time from the official Connection. */
export interface LocalTransportStatus {
  readonly transport: ConnectionState
  readonly generationId?: number
  readonly hostHome?: string
  /** Active lazy wrappers; qualification observes this stays bounded. */
  readonly activeWrappers: number
  /** Physical mux sockets still owned; one for a connected generation. */
  readonly liveSockets: number
}

/** One live official Client transport; the caller owns its disposal. */
export interface LocalClientTransport {
  readonly connection: LocalTransportConnection
  status(): LocalTransportStatus
  /**
   * Borrow the SAME authenticated HTTP fetch the official Connection owns:
   * the verified Host origin, the live per-peer Cookie and the no-store /
   * manual-redirect policy from `cookieFetch`. It creates no second
   * Connection, Peer or persistent Cookie copy; before every call it refuses
   * when the transport was disposed/went fatal or has no current Host
   * generation, then refreshes the per-peer Cookie exactly like a later socket
   * attempt. A real HTTP/transport failure propagates unchanged.
   */
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>
  /** Qualification-only physical carrier drop: closes the live mux socket. */
  dropWebSocketsForQualification(): void
  dispose(): Promise<void>
}

/** The installed-but-not-yet-ready official Client transport.
 *
 * `installLocalTransport` mounts the three official Node Client halves and
 * returns this handle BEFORE the first Connection generation exists. That is
 * what lets the surface composition mount the official Session resolver and
 * the root interaction listeners while the official Loader still holds the
 * Gateway's `connection.start()` back. The caller then releases the Loader
 * gate and awaits {@link InstalledLocalClientTransport.awaitReady}. */
export interface InstalledLocalClientTransport extends LocalClientTransport {
  /** Await the first real generation and the authenticated identity audit. */
  awaitReady(options?: { readonly signal?: AbortSignal }): Promise<LocalClientTransport>
}

export interface StartLocalTransportOptions {
  /** Installed `@deepseek-ai/dsh/package.json` anchor. */
  readonly dshAnchor: string
  /** Optional lifecycle signal for the first-generation wait. */
  readonly signal?: AbortSignal
  /** Authenticated Host candidate and this Client process's Cookie. */
  readonly host: VerifiedLocalHost
  /** Client scope used to re-check the authenticated Host identity. */
  readonly scope: LocalScope
  /** Client entry diagnostics sink for the owned socket-opening task. */
  readonly diag: Diag
  /**
   * Terminal transport failure. The Client entry must stop and report this
   * error; the official Connection loop must not silently retry a replaced
   * Host identity.
   */
  readonly onFatal?: (error: unknown) => void
}

/** The loose carrier operations this transport uses; `ws` supplies them. */
interface RawSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  addEventListener(type: string, listener: (event: unknown) => void, options?: { readonly once?: boolean }): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  once(event: string, listener: (...args: never[]) => void): void
}

/** Structural WebSocket surface accepted by the official Connection client. */
interface ConnectionWebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(
    event: string,
    listener: (event: { readonly data?: unknown }) => void,
    options?: { readonly once?: boolean },
  ): void
  removeEventListener(event: string, listener: (event: { readonly data?: unknown }) => void): void
}

interface PluginModule {
  readonly apply: (ctx: Context) => void
  readonly inject?: readonly string[]
}

interface ConnectionClientModule extends PluginModule {
  readonly installConnection: (ctx: Context, options: {
    readonly interactions: 'answer'
    readonly transport: {
      readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
      readonly createWebSocket: (url: string) => ConnectionWebSocketLike
      readonly streamBaseUrl: string
    }
  }) => void
}

interface GatewayClientModule extends PluginModule {}
interface TypertClientModule extends PluginModule {}

interface LoadedLocalTransportModules {
  readonly typert: TypertClientModule
  readonly connection: ConnectionClientModule
  readonly gateway: GatewayClientModule
}

/** Resolve and import the three Node Client halves from the installed DSH anchor. */
async function loadLocalTransportModules(dshAnchor: string): Promise<LoadedLocalTransportModules> {
  const requireFromDsh = createRequire(realpathSync(dshAnchor))
  const importResolved = async <T>(specifier: string): Promise<T> => {
    const resolved = requireFromDsh.resolve(specifier)
    if (!/client\.node\.js$/u.test(resolved)) {
      throw new Error(`local transport: ${specifier} did not resolve to the Node client entry (${resolved})`)
    }
    return await import(pathToFileURL(resolved).href) as T
  }
  const [typert, connection, gateway] = await Promise.all([
    importResolved<TypertClientModule>(NODE_CLIENT_MODULES[0]),
    importResolved<ConnectionClientModule>(NODE_CLIENT_MODULES[1]),
    importResolved<GatewayClientModule>(NODE_CLIENT_MODULES[2]),
  ])
  if (typeof typert.apply !== 'function') throw new Error('local transport: the installed Typert client has no apply')
  if (typeof connection.installConnection !== 'function' || typeof connection.apply !== 'function') {
    throw new Error('local transport: the installed Connection client has no installConnection/apply')
  }
  if (typeof gateway.apply !== 'function') throw new Error('local transport: the installed API Gateway client has no apply')
  return { typert, connection, gateway }
}

/** Node's `RequestInit` omits the cache mode; B1 requires `no-store` explicitly. */
type LocalRequestInit = RequestInit & { readonly cache?: 'no-store' }

/** Resolve a relative logical route and require the authenticated Host origin. */
function cookieFetch(
  origin: string,
  currentCookie: () => string,
  includeCookie: boolean,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  // Qualification-only post-dispatch prompt ACK drop (T35): the request reaches
  // the Host, then the response is discarded so the caller observes a real
  // post-write transport failure. It fires exactly once and never replays the
  // write. Production never sets this variable.
  const dropPromptAck = process.env.SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK === '1'
  let promptAckDropped = false
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.href, `${origin}/`)
    if (url.origin !== origin) {
      throw new Error(`local transport: refusing a cross-origin request to ${url.origin}`)
    }
    const headers = new Headers(init.headers)
    if (includeCookie) headers.set('cookie', currentCookie())
    const request: LocalRequestInit = { ...init, headers, redirect: 'manual', cache: 'no-store' }
    if (dropPromptAck && !promptAckDropped && typeof init.body === 'string') {
      let method: unknown
      try {
        method = (JSON.parse(init.body) as { readonly method?: unknown }).method
      } catch {
        method = undefined
      }
      if (method === 'session/prompt') {
        promptAckDropped = true
        const response = await fetch(url, request)
        await response.body?.cancel()
        throw new Error('local transport: qualification dropped the session/prompt ACK after Host receipt')
      }
    }
    return await fetch(url, request)
  }
}

/**
 * A Connection-owned WebSocket whose real carrier starts after an optional
 * Cookie refresh. The official Connection client attaches its listeners
 * synchronously, so this wrapper buffers them until the real socket exists;
 * a failed refresh is delivered as the carrier's error/close pair.
 */
function lazyWebSocket(
  open: () => Promise<RawSocket>,
  adopt: (socket: RawSocket) => void,
  diag: Diag,
  release: () => void,
): ConnectionWebSocketLike {
  interface Buffered {
    readonly type: string
    readonly listener: (event: { readonly data?: unknown }) => void
    readonly once: boolean
  }
  const buffered: Buffered[] = []
  let real: RawSocket | undefined
  let closed = false
  let failed = false
  const notify = (type: string, event: unknown): void => {
    for (const entry of [...buffered]) {
      if (entry.type !== type) continue
      if (entry.once) {
        const index = buffered.indexOf(entry)
        if (index >= 0) buffered.splice(index, 1)
      }
      entry.listener(event as { readonly data?: unknown })
    }
  }
  const fail = (error: Error): void => {
    if (closed || failed) return
    failed = true
    closed = true
    notify('error', { error })
    notify('close', {})
    release()
  }
  const start = async (): Promise<void> => {
    try {
      const socket = await open()
      if (closed) {
        // A CONNECTING ws socket emits 'error' from terminate(); consume it
        // here because the real carrier was never adopted by the gateway.
        socket.addEventListener('error', () => {})
        socket.terminate()
        release()
        return
      }
      real = socket
      adopt(socket)
      socket.addEventListener('open', event => { notify('open', event) }, { once: true })
      socket.addEventListener('error', event => { notify('error', event) })
      socket.addEventListener('message', event => { notify('message', event) })
      socket.addEventListener('close', event => { closed = true; notify('close', event); release() }, { once: true })
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }
  runDetached('local transport: open authenticated socket', () => start(), { diag })
  return {
    get readyState(): number {
      if (real !== undefined) return real.readyState
      return closed ? WebSocket.CLOSED : WebSocket.CONNECTING
    },
    send(data: string): void {
      if (real === undefined || real.readyState !== WebSocket.OPEN) {
        throw new Error('local transport: the physical WebSocket is not open')
      }
      real.send(data)
    },
    close(code?: number, reason?: string): void {
      if (closed) return
      if (real !== undefined) {
        real.close(code, reason)
        return
      }
      closed = true
      notify('close', {})
      release()
    },
    addEventListener(type, listener, options): void {
      buffered.push({ type, listener, once: options?.once === true })
    },
    removeEventListener(type, listener): void {
      for (let index = buffered.length - 1; index >= 0; index -= 1) {
        if (buffered[index].type === type && buffered[index].listener === listener) buffered.splice(index, 1)
      }
    },
  }
}

/**
 * Create one Cookie-bearing physical mux socket on the authenticated origin.
 * The first socket uses the Cookie verified by the identity probe; every later
 * attempt refreshes the per-peer API Cookie first, because the Host releases
 * that Peer when its mux socket closes.
 */
function cookieWebSocketFactory(
  origin: string,
  currentCookie: () => string,
  refreshCookie: () => Promise<void>,
  sockets: Set<RawSocket>,
  wrappers: Set<ConnectionWebSocketLike>,
  diag: Diag,
  includeCookie: boolean,
): (url: string) => ConnectionWebSocketLike {
  const port = new URL(origin).port
  let created = 0
  return url => {
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'ws:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hostname !== '127.0.0.1'
      || parsed.port !== port
    ) {
      throw new Error(`local transport: refusing a WebSocket outside the authenticated Host origin (${url})`)
    }
    const attempt = created
    created += 1
    const wrapper = lazyWebSocket(async () => {
      if (attempt > 0) await refreshCookie()
      return new WebSocket(url, includeCookie ? { headers: { Cookie: currentCookie() } } : {}) as unknown as RawSocket
    }, socket => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
    }, diag, () => { wrappers.delete(wrapper) })
    wrappers.add(wrapper)
    return wrapper
  }
}

/**
 * Wait for the first real `$events` generation, bounded so a Client without a
 * serving Host fails instead of spinning forever. Generation identity comes
 * only from the official Connection handle.
 */
function waitForFirstGeneration(
  connection: LocalTransportConnection,
  signal?: AbortSignal,
): Promise<ConnectionGeneration> {
  const current = connection.generation.getSnapshot()
  if (current !== undefined) return Promise.resolve(current)
  return new Promise<ConnectionGeneration>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      unsubscribe?.()
      signal?.removeEventListener('abort', aborted)
    }
    const aborted = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal?.reason ?? new Error('local transport: startup generation wait aborted'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new LocalScopeError(
        'HOST_UNRESPONSIVE',
        `local transport: no official Connection generation within ${String(GENERATION_READY_TIMEOUT_MS / 1000)}s`,
      ))
    }, GENERATION_READY_TIMEOUT_MS)
    const finish = (generation: ConnectionGeneration): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(generation)
    }
    unsubscribe = connection.generation.subscribe(() => {
      const generation = connection.generation.getSnapshot()
      if (generation !== undefined) finish(generation)
    })
    if (signal !== undefined) {
      if (signal.aborted) {
        aborted()
        return
      }
      signal.addEventListener('abort', aborted, { once: true })
    }
    const afterSubscribe = connection.generation.getSnapshot()
    if (afterSubscribe !== undefined) finish(afterSubscribe)
  })
}

/**
 * Re-read the private registry and current kernel starttime after the
 * generation is ready. A Host replacement between authentication and
 * `connected` is terminal; no operation is replayed.
 */
function assertIdentityStillCurrent(scope: LocalScope, expected: LocalInstanceRecord): void {
  const current = readLocalRecord(scope)
  if (current === undefined) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local transport: the Host registry disappeared before connected')
  }
  for (const key of [
    'scopeId',
    'profileRealpath',
    'instanceId',
    'hostPid',
    'hostStarttime',
    'origin',
    'protocol',
    'bundleVersion',
    'dshVersion',
    'buildId',
  ] as const) {
    if (current[key] !== expected[key]) {
      throw new LocalScopeError('HOST_IDENTITY_MISMATCH', `local transport: the Host identity changed at ${key} before connected`)
    }
  }
  const liveStarttime = readProcessStarttime(expected.hostPid)
  if (liveStarttime === undefined) {
    throw new LocalScopeError('PROCESS_STARTTIME_UNAVAILABLE', 'local transport: the Host process starttime is unavailable')
  }
  if (liveStarttime !== expected.hostStarttime) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local transport: the Host PID is no longer the authenticated process')
  }
}

/** Wait for a set of sockets to close, bounded so disposal cannot park forever. */
async function closeRemainingSockets(sockets: Set<RawSocket>): Promise<void> {
  if (sockets.size === 0) return
  const closures: Promise<void>[] = []
  for (const socket of sockets) {
    if (socket.readyState < WebSocket.CLOSED) socket.terminate()
    if (socket.readyState >= WebSocket.CLOSED) continue
    closures.push(new Promise<void>(resolve => {
      socket.once('close', () => resolve())
    }))
  }
  if (closures.length === 0) return
  await Promise.race([
    Promise.all(closures),
    new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  ])
}

/**
 * Install the official three-layer Client transport on the caller's Client
 * Context. Each fiber is recorded before it is awaited; a construction failure
 * unwinds the recorded fibers in reverse order while the root stays with the
 * caller.
 */
export async function installLocalTransport(
  context: Context,
  options: StartLocalTransportOptions,
): Promise<InstalledLocalClientTransport> {
  const { dshAnchor, host, scope, diag } = options
  const modules = await loadLocalTransportModules(dshAnchor)
  const origin = host.record.origin
  let disposed = false
  const disposal = new AbortController()
  let fatalReported = false
  let live = false
  let fatalError: unknown
  let rejectFatal: ((error: unknown) => void) | undefined
  const fatal = new Promise<never>((_, reject) => { rejectFatal = reject })
  // A fatal that arrives after the startup already passed is delivered through
  // onFatal; the startup promise's unused rejection branch must not be orphaned.
  fatal.catch(() => {})
  let cookie = host.cookie
  let refreshPromise: Promise<void> | undefined
  let forcedRetryableRefresh = false
  const reportFatal = (error: unknown): void => {
    if (disposed || fatalReported) return
    fatalReported = true
    fatalError = error
    if (live) {
      options.onFatal?.(error)
      return
    }
    rejectFatal?.(error)
  }
  const isTerminalRefreshFailure = (error: unknown): boolean =>
    !(error instanceof LocalScopeError && error.code === 'HOST_UNRESPONSIVE')
  const refreshCookie = async (): Promise<void> => {
    if (process.env.SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE === '1' && !forcedRetryableRefresh) {
      // Qualification-only probe: a transient refresh failure must remain an
      // ordinary carrier loss for the official same-Host retry, not a fatal.
      forcedRetryableRefresh = true
      throw new LocalScopeError('HOST_UNRESPONSIVE', 'local transport: qualification forced retryable refresh failure')
    }
    if (refreshPromise === undefined) {
      refreshPromise = (async () => {
        try {
          const launch = readLaunchMaterial(scope, host.identity)
          cookie = await connectForCookie(host.identity, launch)
        } catch (error) {
          // Identity/auth/file/build failures are terminal. A transient
          // transport-level HOST_UNRESPONSIVE remains an ordinary carrier loss
          // for the official Connection retry.
          if (isTerminalRefreshFailure(error)) reportFatal(error)
          throw error
        }
      })().finally(() => { refreshPromise = undefined })
    }
    await refreshPromise
  }
  const sockets = new Set<RawSocket>()
  const wrappers = new Set<ConnectionWebSocketLike>()
  // Qualification-only mutation control for the T02 negative: the Client still
  // performs the discovery identity probe, then omits its Cookie from the
  // official transport carrier.
  const includeCookie = process.env.SPLIT_PROCESS_CLIENT_OMIT_COOKIE !== '1'
  // The borrowed HTTP fetch for the Remote archive adapter: the SAME origin
  // and Cookie policy the official Connection's unary carrier uses.
  const fetchAuthenticated = cookieFetch(origin, () => cookie, includeCookie)

  let typertFiber: Fiber | undefined
  let connectionFiber: Fiber | undefined
  let gatewayFiber: Fiber | undefined
  let connection: LocalTransportConnection | undefined

  const unwind = async (): Promise<unknown[]> => {
    disposed = true
    disposal.abort(new Error('local transport: disposed'))
    const errors: unknown[] = []
    // Close the carrier before the official fibers: a fiber disposing while a
    // lazy socket is still connecting can otherwise wait on a close event that
    // only this transport can produce.
    for (const wrapper of wrappers) {
      try {
        wrapper.close()
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await closeRemainingSockets(sockets)
    } catch (error) {
      errors.push(error)
    }
    for (const [label, fiber] of [
      ['gateway', gatewayFiber],
      ['connection', connectionFiber],
      ['typert', typertFiber],
    ] as const) {
      if (fiber === undefined) continue
      try {
        await Promise.race([
          fiber.dispose(),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`local transport: ${label} disposal timed out`)), 5_000)
          }),
        ])
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }

  try {
    options.signal?.throwIfAborted()
    typertFiber = context.plugin(modules.typert)
    await typertFiber
    options.signal?.throwIfAborted()

    connectionFiber = context.plugin(connectionContext => {
      modules.connection.installConnection(connectionContext, {
        interactions: 'answer',
        transport: {
          fetch: cookieFetch(origin, () => cookie, includeCookie),
          createWebSocket: cookieWebSocketFactory(origin, () => cookie, refreshCookie, sockets, wrappers, diag, includeCookie),
          streamBaseUrl: origin,
        },
      })
    })
    await connectionFiber
    options.signal?.throwIfAborted()

    gatewayFiber = context.plugin(modules.gateway)
    await gatewayFiber
    options.signal?.throwIfAborted()

    const installed = context.get('connection') as LocalTransportConnection | undefined
    if (installed === undefined) {
      throw new Error('local transport: the official Connection service did not install')
    }
    connection = installed
    if (process.env.SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL === '1') {
      // Qualification-only probe: exercise a fatal that arrives before the
      // startup wait returns. It must reject this startup exactly once.
      reportFatal(new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local transport: qualification forced startup identity failure'))
    }
    let readyPromise: Promise<LocalClientTransport> | undefined

    const handle: InstalledLocalClientTransport = {
      connection: installed,
      status(): LocalTransportStatus {
        const state = installed.state.getSnapshot()
        const generation = installed.generation.getSnapshot()
        const transport: ConnectionState = state === 'disconnected'
          ? 'disconnected'
          : state === 'connected' && generation !== undefined
            ? 'connected'
            : 'connecting'
        return {
          transport,
          ...(transport === 'connected' && generation !== undefined
            ? { generationId: generation.id, hostHome: generation.host.home }
            : {}),
          activeWrappers: wrappers.size,
          liveSockets: sockets.size,
        }
      },
      async awaitReady(readyOptions: { readonly signal?: AbortSignal } = {}): Promise<LocalClientTransport> {
        readyPromise ??= (async () => {
          if (disposed) throw new Error('local transport: disposed before readiness')
          const startupLifetime = new AbortController()
          const aborted = (): void => { startupLifetime.abort(readyOptions.signal?.reason) }
          if (readyOptions.signal?.aborted === true) aborted()
          else readyOptions.signal?.addEventListener('abort', aborted, { once: true })
          const readySignal = readyOptions.signal === undefined
            ? AbortSignal.any([startupLifetime.signal, disposal.signal])
            : AbortSignal.any([startupLifetime.signal, disposal.signal, readyOptions.signal])
          try {
            await Promise.race([waitForFirstGeneration(installed, readySignal), fatal])
          } finally {
            readyOptions.signal?.removeEventListener('abort', aborted)
            startupLifetime.abort()
          }
          if (fatalError !== undefined) throw fatalError
          assertIdentityStillCurrent(scope, host.identity)
          if (fatalError !== undefined) throw fatalError
          live = true
          return handle
        })()
        return await readyPromise
      },
      async authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
        if (disposed || !live) {
          throw new Error('local transport: the authenticated fetch is unavailable before connection or after disposal')
        }
        if (fatalError !== undefined) throw fatalError
        // The generation gate: a rolled-over/absent generation means this
        // borrowed origin/Cookie pair no longer speaks for the current Host.
        if (installed.generation.getSnapshot() === undefined) {
          throw new LocalScopeError('HOST_UNRESPONSIVE', 'local transport: no current authenticated Host generation')
        }
        // A later peer always needs the refreshed Cookie (the Host releases the
        // old peer when its mux socket closed); the archive call is a one-shot
        // user action, never a hot-loop path.
        await refreshCookie()
        if (disposed) throw new Error('local transport: the authenticated fetch is unavailable after disposal')
        if (fatalError !== undefined) throw fatalError
        return await fetchAuthenticated(input, init)
      },
      dropWebSocketsForQualification(): void {
        for (const socket of [...sockets]) {
          if (socket.readyState < WebSocket.CLOSED) socket.terminate()
        }
      },
      async dispose(): Promise<void> {
        if (disposed) return
        disposed = true
        const errors = await unwind()
        if (errors.length === 0) return
        const primary = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
        for (const secondary of errors.slice(1)) mergeCause(primary, secondary)
        ;(primary as Error & { cleanupFailed?: boolean }).cleanupFailed = true
        throw primary
      },
    }
    return handle
  } catch (error) {
    const cleanupErrors = await unwind()
    const primary = error instanceof Error ? error : new Error(String(error))
    for (const cleanupError of cleanupErrors) mergeCause(primary, cleanupError)
    if (cleanupErrors.length > 0) (primary as Error & { cleanupFailed?: boolean }).cleanupFailed = true
    throw primary
  }
}

/**
 * Wait for the installed transport's first real generation and identity audit.
 * The official Gateway may only start after the interaction-owner Loader gate
 * has been released; this is the caller's second startup stage.
 */
export async function awaitLocalTransportReady(
  transport: InstalledLocalClientTransport,
  options: { readonly signal?: AbortSignal } = {},
): Promise<LocalClientTransport> {
  return await transport.awaitReady(options)
}

/**
 * The frozen B1/qualification convenience wrapper: install the official
 * transport and immediately await its first generation. The staged surface
 * composition uses {@link installLocalTransport} + {@link awaitLocalTransportReady}
 * so the Domain prerequisites and interaction listeners exist first.
 */
export async function startLocalTransport(
  context: Context,
  options: StartLocalTransportOptions,
): Promise<LocalClientTransport> {
  const installed = await installLocalTransport(context, options)
  return await awaitLocalTransportReady(installed, options.signal === undefined ? {} : { signal: options.signal })
}
