/**
 * M3-6 PR1 Remote Client UI subtree: the ONE PiTui-specific Client-local UI
 * composition owner on the EXISTING official Client Context
 * (`wire.client.context` — `app/remote/client-runtime.ts` keeps owning the
 * official transport/data core and creates that Context exactly once).
 *
 * It mounts exactly three fibers, in this order:
 *
 * ```text
 * 1. Client-local tuiStartup facts provider (detached sessionId/presetId)
 * 2. @xmoon76/dsh-pi-tui/extensions plugin module (the extension host)
 * 3. @xmoon76/dsh-pi-tui/builtins plugin module (first-party contributions)
 * ```
 *
 * The extension service resolved from THAT Context is the Remote runner's UI
 * extension authority (`RemoteApplicationOverride.extensionService`); the
 * ordinary Host-context `piTuiExtensions` is never consulted on the Remote
 * branch. No second Client Context is created and no callback crosses any
 * wire: the same TUI-local modules (`src/extensions.ts` / `src/builtins.ts`)
 * that the Direct profile composition mounts on the ordinary Host Context
 * are mounted here as Cordis plugin fibers, so inject/caller-fiber lifecycle
 * semantics stay real.
 *
 * Disposal is explicit, idempotent and reverse (builtins -> extension host
 * -> startup facts); it never disposes the supplied Client Context itself —
 * the Remote application runtime disposes this subtree BEFORE the official
 * Client core.
 *
 * @module app/remote/client-ui-runtime
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as extensionHostPlugin from '../../extensions.ts'
import * as builtinsPlugin from '../../builtins.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '../../extensions.ts'
import { TUI_STARTUP_SERVICE } from '../../startup.ts'
import type { ClientUiStartupFacts } from '../application-runtime.ts'
import { mergeCause } from './host-runtime.ts'

/** The composed Client UI subtree. Not exported from the package root. */
export interface RemoteClientUiRuntime {
  /** The ONE Client-local extension service (identity-equal to the Client
   * Context's `piTuiExtensions` value). */
  readonly extensionService: PiTuiExtensionService
  /** Dispose exactly the three subtree fibers (reverse order), idempotent.
   * Never disposes the Client Context itself. */
  dispose(): Promise<void>
}

export interface RemoteClientUiRuntimeOptions {
  /** The EXISTING official Client Context (`wire.client.context`). */
  readonly context: Context
  readonly startup: ClientUiStartupFacts
}

/** Run one fiber disposal step, collecting its failure (never throwing). */
async function collectDisposeError(dispose: () => Promise<void> | void): Promise<unknown[]> {
  try {
    await dispose()
  } catch (error) {
    return [error]
  }
  return []
}

/**
 * Compose the PiTui Client UI subtree on the supplied Client Context.
 *
 * Failure semantics: on any construction failure the already-mounted fibers
 * unwind in reverse order (a cleanup failure rides the original error's
 * cause chain, never masking it) and no Client UI service survives.
 */
export async function createRemoteClientUiRuntime(
  options: RemoteClientUiRuntimeOptions,
): Promise<RemoteClientUiRuntime> {
  const { context } = options
  // A fresh immutable facts value: the caller's object is copied (never
  // passed by reference) and the Host-only `markSurfaceMounted` callback is
  // structurally absent — the Client subtree gets data facts only.
  const startupFacts = Object.freeze({
    ...(options.startup.sessionId === undefined ? {} : { sessionId: options.startup.sessionId }),
    ...(options.startup.presetId === undefined ? {} : { presetId: options.startup.presetId }),
  })

  // Each fiber is assigned BEFORE it is awaited (the client-runtime.ts
  // partial-unwind discipline): a plugin whose startup rejects is still
  // owned by the reverse unwind below at its own stage position.
  let startupFiber: Fiber | undefined
  let extensionHostFiber: Fiber | undefined
  let builtinsFiber: Fiber | undefined

  /** Reverse-order unwind of the subtree fibers; per-step error isolation
   * (a failing step never skips the later ones). Returns the collected
   * cleanup errors in encounter order. Fibers never reached by the failed
   * construction stay `undefined` and are skipped — they own nothing to
   * unwind (the client-runtime.ts partial-unwind discipline). */
  const unwind = async (): Promise<unknown[]> => {
    const errors: unknown[] = []
    for (const fiber of [builtinsFiber, extensionHostFiber, startupFiber]) {
      errors.push(...await collectDisposeError(() => fiber?.dispose()))
    }
    return errors
  }

  try {
    startupFiber = context.plugin(clientCtx => {
      clientCtx.provide(TUI_STARTUP_SERVICE, startupFacts)
    })
    await startupFiber

    extensionHostFiber = context.plugin(extensionHostPlugin)
    await extensionHostFiber

    builtinsFiber = context.plugin(builtinsPlugin)
    await builtinsFiber

    const extensionService = context.get(PI_TUI_EXTENSIONS_SERVICE)
    if (extensionService === undefined) {
      throw new Error('remote client UI runtime: piTuiExtensions service did not mount')
    }
    let disposed = false
    return {
      extensionService,
      async dispose(): Promise<void> {
        if (disposed) return
        disposed = true
        const errors = await unwind()
        if (errors.length > 0) {
          const failure = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
          if (errors.length > 1) {
            mergeCause(failure, new AggregateError(errors.slice(1), 'remote client UI runtime: remaining disposal failures'))
          }
          throw failure
        }
      },
    }
  } catch (error) {
    // The original construction failure stays primary; any unwind failures
    // ride its cause chain instead of masking it.
    const cleanupErrors = await unwind()
    const failure = error instanceof Error ? error : new Error(String(error))
    if (cleanupErrors.length > 0) {
      const secondary = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'remote client UI runtime: unwind disposal failures')
      mergeCause(failure, secondary)
    }
    throw failure
  }
}
