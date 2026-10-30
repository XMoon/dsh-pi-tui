/**
 * The narrow split-Client surface composition bridge (M4-B2-S §7.1).
 *
 * It owns exactly two pieces of state for the ONE real Client surface:
 *
 * - the `SurfaceReady` promise: resolved when the runner reports that
 *   `surface.start(...)` returned and the physical tty ownership settled;
 *   rejected with the ORIGINAL startup error when the runner's startup root
 *   fails first;
 * - the `SurfaceStop` idempotent latch: every TUI exit route (Esc, `/exit`,
 *   the renderer's own exit, a terminal EOF observation) collapses onto ONE
 *   process-stop request.
 *
 * It imports no `app/bootstrap.ts`, creates no Context, Backend, Domain,
 * Client UI or TUI, and owns no telemetry. The only caller is the Client
 * process composition root (`local-client-entry.ts`), inside the lazy
 * `mountRunner` callback registered after the official `PluginPackages`
 * resolution is live.
 *
 * @module app/remote-process/local-client-surface
 */

/** The ONE surface readiness + stop bridge of a split Client process. */
export interface LocalClientSurfaceBridge {
  /** Resolves when the real surface mounted; rejects on startup failure. */
  readonly ready: Promise<void>
  /** Settle once from the runner's `surfaceReady`. */
  markMounted(): void
  /** Settle once from the runner's `surfaceFailed`; the first failure wins. */
  fail(error: unknown): void
  /** Request the ONE process stop; the first request wins (idempotent). */
  requestStop(code: number): void
  /**
   * Resolves with the first requested exit code. A startup that is still
   * waiting for `ready` must treat this as cancellation instead of hanging.
   */
  readonly stopped: Promise<number>
}

/**
 * Create the bridge around the supplied process-stop owner. `stop` is invoked
 * at most once, and only by the first `requestStop` caller; the promise and
 * the failure latch are likewise one-shot (a late `markMounted` after a
 * failure never resurrects a mounted surface).
 */
export function createLocalClientSurfaceBridge(stop: (code: number) => void): LocalClientSurfaceBridge {
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: unknown) => void) | undefined
  let settled = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let resolveStopped: ((code: number) => void) | undefined
  const stopped = new Promise<number>(resolve => {
    resolveStopped = resolve
  })
  // A rejected readiness is always observed by `startLocalClient`; this no-op
  // handler only prevents an unhandled rejection if a later caller abandons
  // the handle.
  ready.catch(() => {})
  let stopRequested = false
  return {
    ready,
    markMounted(): void {
      if (settled) return
      settled = true
      resolveReady?.()
    },
    fail(error: unknown): void {
      if (settled) return
      settled = true
      rejectReady?.(error)
    },
    requestStop(code: number): void {
      if (stopRequested) return
      stopRequested = true
      resolveStopped?.(code)
      stop(code)
    },
    stopped,
  }
}
