/**
 * The application composition root's process/composition lifecycle
 * orchestration (TS2 §11/§12).
 *
 * This module owns the composition-only lifecycle responsibilities:
 *
 * ```text
 * disposeSurface                       (the ONE idempotent client-surface teardown)
 * registerRunnerDisposal               (the fiber disposal: surface, then retirement, then transport)
 * startup-failure terminal cleanup     (the terminal-total fatal catch)
 * bounded fatal retirement wait
 * fatal exit sequencing
 * ```
 *
 * It is orchestration only: every released resource belongs to an existing
 * owner, and the owner is injected as an explicit callback. It acquires no
 * business ownership, reads no Cordis service, owns no Session/TUI state and
 * does not import the composition facade (`src/app/bootstrap.ts`).
 *
 * The frozen §12 relative teardown order and the non-truncating disposal
 * semantics are preserved exactly:
 *
 * ```text
 * surface completion owner fenced -> terminal focus reporting disabled ->
 * lifecycle abort -> viewer disposal -> draft image/file clear -> command
 * catalog disposal -> Plugin Manager early disposal -> status deferred
 * cancellation -> footer command disposal -> user-shell disposal -> Job event
 * subscription disposal -> Job observation disposal -> Task Browser disposal ->
 * surface.dispose(); then the fiber disposal runs the session retirement to
 * settlement, then the selected transport disposal.
 * ```
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/lifecycle
 */

import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import { DISABLE_FOCUS_REPORTING } from '../../tui/notification/terminal-focus.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { SessionRetirementReport } from '../session/owner-access.ts'

/**
 * The surface-owned teardown face the frozen §12 order releases. This is the
 * narrow lifecycle view of an already-owned surface facade (its seven disposal
 * entry points), never its render/task/plugin-manager state.
 */
export interface SurfaceTeardownOwner {
  retireCompletionOwner(): void
  disableFocusReporting(): void
  disposePluginManager(): void
  disposeJobEvents(): void
  disposeJobObservation(): void
  disposeTaskBrowser(): void
  dispose(): void
  /**
   * PR3-A: the ONE renderer-release promise (settles with the terminal
   * restored). `disposeSurface()` returns it so the exit/fatal/fiber
   * orchestrations can AWAIT the release before writing the resume hint,
   * exiting or starting the next renderer.
   */
  whenRendererReleased(): Promise<void>
}

/**
 * The ordered teardown resources of the client surface; every entry is a
 * lifecycle/disposal callback of an already-owned resource (plan §11). No
 * business owner, model, task reader, command registry or render state is
 * passed.
 */
export interface SurfaceLifecycleDeps {
  /** The runner diagnostics (the disposal failures are recorded here). */
  readonly diag: Diag
  /** The ONE idempotence latch, owned by the composition root. */
  readonly isCleanedUp: () => boolean
  readonly markCleanedUp: () => void
  /** The surface-owned teardown face (frozen §12 surface hooks). */
  readonly surface: SurfaceTeardownOwner
  /** Abort every in-flight lifecycle load (the runner lifetime signal). */
  readonly abortLifecycle: () => void
  readonly disposeViewer: () => void
  readonly clearDraftImages: () => void
  readonly clearDraftFiles: () => void
  readonly disposeCommandCatalog: () => void
  readonly cancelDeferredStatus: () => void
  readonly disposeFooterCommand: () => void
  readonly disposeLocalShell: () => void
  /** The memoized session-retirement coordinator (settles before the transport). */
  readonly retireOwnedSession: () => Promise<SessionRetirementReport>
  /** The selected runtime's transport disposer (awaited after the retirement). */
  readonly disposeSelectedTransport: () => Promise<void>
  /** The Cordis fiber-effect registration (`ctx.effect`); the effect body stays here. */
  readonly registerDisposal: (dispose: () => unknown) => void
}

/** The surface/fiber lifecycle of one composition instance. */
export interface SurfaceLifecycle {
  /**
   * The ONE idempotent client-surface teardown (frozen §12 order). Returns
   * the renderer-release promise when the teardown actually ran (PR3-A: the
   * caller awaits it before hint/exit/retirement); `void` when already
   * cleaned up.
   */
  disposeSurface(): Promise<void> | void
  /** Register the fiber disposer: surface teardown, retirement, transport. */
  registerRunnerDisposal(): void
}

/**
 * Create the surface/fiber lifecycle over the composition root's already-owned
 * resources. The factory registers nothing and owns no state beyond the
 * injected callbacks.
 */
export function createSurfaceLifecycle(deps: SurfaceLifecycleDeps): SurfaceLifecycle {
  const {
    diag,
    isCleanedUp,
    markCleanedUp,
    surface,
    abortLifecycle,
    disposeViewer,
    clearDraftImages,
    clearDraftFiles,
    disposeCommandCatalog,
    cancelDeferredStatus,
    disposeFooterCommand,
    disposeLocalShell,
    retireOwnedSession,
    disposeSelectedTransport,
    registerDisposal,
  } = deps

  // Idempotent CLIENT-SURFACE teardown: abort lifecycle loads, stop the
  // TUI. Shared by /exit, the effect cleanup, and the startup-failure
  // path. The Direct owned-session retirement is a SEPARATE step
  // (retireOwnedSession below) that runs after the surface stops — diag
  // stays open until the retirement diagnostics are recorded.
  /**
   * The release promise of the FIRST teardown, kept so an idempotent SECOND
   * cleanup (a second fiber disposer, a late fatal) still AWAITS the same
   * renderer release instead of racing ahead to retirement/transport.
   */
  let disposeRelease: Promise<void> | undefined
  const disposeSurface = (): Promise<void> | void => {
    // Already torn down: hand back the SAME release promise (never `void` —
    // a second caller must still await the tty restore).
    if (isCleanedUp()) return disposeRelease ?? surface.whenRendererReleased()
    markCleanedUp()
    // Fence the completion-notification controller (surface-owned, A4-4):
    // after teardown a late `agent/status` idle from the old live agent must
    // never emit a notification into a dead surface (the identity fence drops
    // every event once the live id is undefined).
    //
    // This is the FINAL-TEARDOWN retirement, not a rebind: it withdraws the
    // notification owner while KEEPING the proven terminal outcome. A settled
    // OSC 7501 `done`/`error` must survive process exit (plan §4.4), so this
    // step must not reset the outcome to `idle` the way a session-switch
    // `setCompletionOwner` does; a still-live interval is retired to `idle` by
    // the same call, and the app's own `dispose()` writes the final physical
    // record.
    // M3-6 PR3: ONE ordered non-truncating batch. A throwing sibling cleanup
    // must never skip a later surface owner, the Session retirement or the
    // selected transport disposal (the plan's frozen top-level order).
    let batchFailure: unknown
    try {
    runSyncDisposalSteps('surface disposal', [
      () => surface.retireCompletionOwner(),
      // Disable terminal focus reporting FIRST among the THROWABLE steps —
      // before any teardown step — so the mode can never leak into the shell
      // even when a later teardown operation throws (idempotent: a startup
      // failure that never enabled it writes a harmless no-op).
      () => surface.disableFocusReporting(),
      // The DSH SessionWriteLease (kernel flock) is the only cross-process
      // writer authority: a clean TUI exit needs no TUI-side lock
      // bookkeeping — the lease is released by the DSH session teardown
      // (the TUI's physical owner.lock / lease / cooling stack is removed
      // legacy).
      () => abortLifecycle(),
      // M3-5 PR2: tear the child viewer down FIRST among the presentation
      // resources — a mounted viewer owns a client child generation + live
      // ingress (Remote) and an in-flight open may own a retained generation.
      // NO painting: the app is going away, and the adapter -> Client disposal
      // follows this step. Late-bound (`viewerRef`): a startup failure can run
      // this cleanup before the viewer owner exists (TDZ guard).
      () => disposeViewer(),
      () => clearDraftImages(),
      () => clearDraftFiles(),
      // Abort any in-flight catalog refresh: its late result must never
      // register commands or repaint after the app is gone.
      () => disposeCommandCatalog(),
      // Release the Plugin Manager install-event subscription at its original
      // EARLY position (a late install event must never notify/repaint a dying
      // surface). The subscription is surface-owned (A4-5).
      () => surface.disposePluginManager(),
      // PR D2: cancel the deferred initial context measure — a stale
      // callback must never measure/repaint into the disposed surface.
      () => cancelDeferredStatus(),
      // M5: release the footer command surface BEFORE the app dies — a
      // late status-store notification must not refresh into a disposed
      // surface. The lifecycle abort above already disposes an armed
      // runner through its own abort listener; the explicit unsubscribe +
      // dispose keeps the release symmetric with the arm path and also
      // covers the teardown-before-arm window (both idempotent).
      () => disposeFooterCommand(),
      () => disposeLocalShell(),
      // TuiApp.dispose() hides overlays without invoking their user cancel
      // callbacks. The Task Center / Job viewer resources are surface-owned
      // (A4-6) and released in their original order: the jobs-event
      // subscription first (no Job listener may refresh a dying surface), then
      // the selected-Job observation, then the browser handle/token.
      () => surface.disposeJobEvents(),
      () => surface.disposeJobObservation(),
      () => surface.disposeTaskBrowser(),
      // The mounted TuiApp, the plugin keybinding sync, the theme-unload hook
      // and the extension surface bridge are released by their surface owner
      // (A4): the runner steps around this call release only what the runner
      // still owns.
      () => surface.dispose(),
    ])
    } catch (error) {
      // runSyncDisposalSteps already attempted EVERY sibling in the frozen
      // order; keep its aggregated failure to surface AFTER the release.
      batchFailure = error
    }
    // NOTE: diag.dispose() is NOT here — the Direct owned-session
    // retirement (retireOwnedSession) records its diagnostics first and
    // closes diag last (see below).
    // PR3-A: the ONE renderer-release promise (immediate on PiTui; the SDK tty
    // release on the TSP branch). Captured on EVERY path — including a
    // throwing sibling — so the exit/fatal/fiber callers always await the tty
    // restore; the aggregated sync failure is then rethrown to their
    // non-truncating recorder (awaited first, never dropped, never truncated).
    const release = surface.whenRendererReleased()
    disposeRelease = release
    if (batchFailure !== undefined) {
      return release.then(
        () => { throw batchFailure },
        releaseError => { throw new AggregateError([batchFailure, releaseError], 'surface disposal') },
      )
    }
    return release
  }

  // Stop the TUI when this fiber is disposed (a loader hot-reload unloads
  // the row; the reloaded row starts its own instance in the same process).
  // The disposer is ASYNC: the fiber unload awaits it (Cordis contract), so
  // an HMR unload retires the Direct owned session exactly like an
  // interactive exit — surface cleanup first, then the Host retirement.
  // A throwing surface step must NEVER skip the retirement: the surface
  // teardown is protected, the error is recorded (diag is still open —
  // retireOwnedSession closes it last), and the retirement promise is
  // always returned.
  const registerRunnerDisposal = (): void => {
    registerDisposal(() => {
      // PR3-A: the surface teardown returns its renderer-release promise (a
      // no-op resolution on PiTui). Await it BEFORE the session retirement so
      // an HMR unload can never start the next renderer while the old SDK
      // still owns stdin; a release failure is recorded and never skips the
      // retirement.
      const released = (() => {
        try {
          return disposeSurface()
        } catch (error) {
          try {
            diag.error('surface dispose failed', { error: safeErrorMessage(error) })
          } catch {
            // No lower sink.
          }
          return undefined
        }
      })()
      const releaseSettled = Promise.resolve(released).catch(error => {
        try {
          diag.error('renderer release failed', { error: safeErrorMessage(error) })
        } catch {
          // No lower sink.
        }
      })
      // M3-4 PR1 teardown order: the session retirement SETTLES first,
      // then the selected runtime's transport disposer runs and is
      // AWAITED (a no-op on Direct today) — the fiber unload observes the
      // full teardown, so a Remote transport graph can never outlive the
      // unloading fiber or race it. The retirement's settlement is the
      // returned outcome; a disposal failure is recorded, never swapped
      // in front of a retirement failure.
      return releaseSettled.then(() => retireOwnedSession())
        .then(
          report => disposeSelectedTransport()
            .catch(error => { diag.warn('selected transport disposal failed', { error: safeErrorMessage(error) }) })
            .then(() => report),
          error => disposeSelectedTransport()
            .catch(disposeError => { diag.warn('selected transport disposal failed', { error: safeErrorMessage(disposeError) }) })
            .then(() => { throw error }),
        )
    })
  }

  return { disposeSurface, registerRunnerDisposal }
}

/**
 * The terminal-total fatal catch's narrow inputs (plan §11: abort the runner
 * lifecycle, clear the startup status, write diagnostics, dispose, request
 * process exit). The three late-bound refs stay OWNED by the composition root:
 * an undefined ref means the startup root never reached that owner.
 */
export interface FatalLifecycleDeps {
  readonly diag: Diag
  readonly clearStartupStatus: () => void
  readonly logFatal: (message: string) => void
  readonly writeOutput: (text: string) => void
  readonly abortLifecycle: () => void
  /** The surface-cleanup authority, undefined until the surface owner exists. */
  readonly surfaceCleanup: () => (() => void) | undefined
  /** The memoized retirement coordinator, undefined until the session runtime exists. */
  readonly retireOwnedSession: () => (() => Promise<SessionRetirementReport>) | undefined
  /** The selected-transport disposer, undefined until the selection seam ran. */
  readonly disposeSelectedTransport: () => (() => Promise<void>) | undefined
  /** The launcher's bounded exit request. */
  readonly exit: (code: number) => void
}

/** The terminal-total fatal catch of the startup lifecycle root. */
export interface FatalLifecycle {
  handleStartupFailure(error: unknown): Promise<void>
}

/**
 * Create the terminal-total fatal catch. The factory is created at runner
 * scope (before the startup root runs) so a failure at ANY earlier point still
 * reaches it; it reads the late-bound owner refs through getters.
 */
export function createFatalLifecycle(deps: FatalLifecycleDeps): FatalLifecycle {
  const {
    diag,
    clearStartupStatus,
    logFatal,
    writeOutput,
    abortLifecycle,
    surfaceCleanup,
    retireOwnedSession,
    disposeSelectedTransport,
    exit,
  } = deps

  /**
   * Terminal-total final catch of the startup lifecycle root: error
   * observation, logging, abort, dispose and exit are each individually
   * protected, so a hostile rejection or a throwing dependency can never skip
   * the teardown or leak a rejection from this discarded chain.
   */
  const handleStartupFailure = async (error: unknown): Promise<void> => {
    const message = safeErrorMessage(error)
    // Release the shared terminal row BEFORE the first log line. The pre-mount
    // status owns the current row, and a TTY shares one cursor between stdout
    // and stderr: logging first would append the failure to `Starting DSH…`
    // (or `Resuming session…`/`Preparing conversation…`), and the abort
    // listener's later clear would then erase part of that error line. This is
    // the same "clear the status, then write the log" rule the resume-failure
    // path already follows; here it also covers a body failure that threw
    // before its own stage cleanup ran.
    // Contained like every other step of this terminal root: the status writer
    // is an injected output seam with NO never-throws contract (and the Loader
    // barrier's own `finally` clear can land here too), so a throwing clear must
    // not reject this discarded `.catch` chain — that would skip the logs, the
    // abort, the owner retirement and `exit(1)`.
    try {
      clearStartupStatus()
    } catch {
      // A broken status stream must not block the teardown.
    }
    try {
      logFatal(message)
    } catch {
      // The cordis logger must not block the teardown.
    }
    try {
      diag.error('fatal', { error: message, ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) })
    } catch {
      // A throwing diagnostics channel must not block the teardown.
    }
    // Startup failure: cancel every in-flight lifecycle load, then tear
    // down. (The runner-internal cleanup() never ran — the body threw.)
    // The pre-mount status line has already been cleared above; the lifecycle
    // abort listener's clear is idempotent.
    // M3-6 PR3 D3: a startup failure AFTER the surface owner exists runs the
    // SAME cleanup authority the fiber disposer uses (`disposeSurface`), which
    // itself disables terminal focus reporting and aborts the lifecycle before
    // its own throwable steps. Before the owner exists (`disposeSurfaceRef`
    // undefined — a failure during the resume/settings/migration barrier) the
    // minimal focus/abort safety is retained here: the fatal catch must never
    // assume a mounted surface.
    const cleanup = surfaceCleanup()
    if (cleanup !== undefined) {
      // PR3-A: AWAIT the renderer release (a no-op on PiTui; the SDK tty
      // restore on the TSP branch) BEFORE the retirement/exit below, so the
      // fatal path never exits with the previous renderer still owning the
      // terminal. A failure is recorded and never blocks the exit.
      try {
        await cleanup()
      } catch (cleanupError) {
        // Cleanup errors are secondary diagnostics; they must never replace
        // the fatal root or block the retirement/exit below.
        try {
          diag.error('surface dispose failed', { error: safeErrorMessage(cleanupError) })
        } catch {
          // A throwing diagnostics channel must not block the teardown.
        }
      }
    } else {
      // Terminal focus reporting (CSI ? 1004) may already be enabled when
      // the body threw BEFORE the surface owner existed — disable it here so
      // the mode never leaks into the shell on the startup-failure path
      // (idempotent when the mount never ran; the guarded writer swallows
      // broken-stream errors, a synchronous throw is contained).
      try {
        writeOutput(DISABLE_FOCUS_REPORTING)
      } catch {
        // The stream may already be gone during the fatal path.
      }
      try {
        abortLifecycle()
      } catch {
        // The abort must not block dispose/exit.
      }
    }
    // A startup failure AFTER the Direct owner was created (the resume
    // succeeded, then a later initialization threw) must still retire the
    // owned session — the SAME memoized teardown the fiber disposer uses.
    // The wait is BOUNDED: a busy LLM could hang the retirement's whenIdle,
    // and the fatal exit must never wait unboundedly in front of appExit
    // (the same constraint as the interactive exit). When the fiber
    // disposer is registered, the appExit disposal below joins the same
    // memoized promise under the DSH process-shutdown watchdog; when it is
    // NOT registered (a pre-mount failure), this bounded wait is the only
    // window the retirement gets before the process exits — the bound is
    // generous because the retirement is cancel-first and a healthy
    // teardown settles in milliseconds. diag is closed by the
    // retirement's own finalizer (or by the no-owner branch below).
    try {
      let retirementSettled = false
      // The retirement coordinator covers MORE than the current Direct owner:
      // it also drains parked owners and pending forks (the same facts the
      // pre-mount abort path checks). Running it whenever it exists — never
      // gating it on a Direct-handle owner-presence check — keeps those
      // states from being falsely declared settled (a parked-owner drain is
      // still a retirement the transport disposal must not race).
      const retirement = retireOwnedSession()?.()
      if (retirement !== undefined) {
        let timer: NodeJS.Timeout | undefined
        try {
          await Promise.race([
            retirement.finally(() => { retirementSettled = true }),
            new Promise<void>(resolve => { timer = setTimeout(resolve, 2000) }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      } else {
        // The coordinator is defined BEFORE any owner can exist (see the
        // hoisted declaration); an undefined coordinator means the startup
        // root never reached the session runtime — nothing to retire.
        diag.dispose()
        retirementSettled = true
      }
      // M3-4 PR1 ordering guard: the selected transport disposes ONLY after
      // the session retirement SETTLED. A timed-out fatal retirement leaves
      // the transport undisposed (the process-exit watchdog owns the rest)
      // rather than racing Client/Host disposal against the still-running
      // retirement — plan §4: retirement -> transport disposal, never the
      // reverse. Direct is a no-op either way.
      if (retirementSettled) {
        try {
          await disposeSelectedTransport()?.()
        } catch {
          // The last disposal attempt; never block the fatal exit.
        }
      }
    } catch {
      // TDZ (startup failed before the live-owner declarations ran — no
      // owner existed then either) or a synchronous retirement failure:
      // never block the fatal exit. The transport disposal is skipped for
      // the same ordering reason — an unknown retirement state must not be
      // raced by transport disposal.
      try {
        diag.dispose()
      } catch {
        // The dispose must not block the process exit.
      }
    }
    try {
      exit(1)
    } catch {
      // The last step; there is no lower sink.
    }
  }

  return { handleStartupFailure }
}
