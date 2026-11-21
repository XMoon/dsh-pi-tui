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
 * After the application runtime exists, the same owner can activate external
 * PiTui `./tui` packages through the ONE {@link ClientExtensionMountOwner}
 * over this Client's EXISTING official Loader/package table. External entries
 * are unloaded FIRST (reverse order, each awaited), then builtins, extension
 * host and startup facts; the supplied Client Context is never disposed here.
 *
 * @module app/remote/client-ui-runtime
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import * as extensionHostPlugin from '../../extensions.ts'
import * as builtinsPlugin from '../../builtins.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '../../extensions.ts'
import { TUI_STARTUP_SERVICE } from '../../startup.ts'
import type { ClientUiStartupFacts } from '../application-runtime.ts'
import type { ConfigPort } from '../../runtime/config-port.ts'
import type { PluginManagerPort, PluginManagerSnapshot } from '../../runtime/plugin-manager-port.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { createClientExtensionMountOwner, type ClientExtensionMountOwner, type ClientExtensionObservation, type ClientExtensionObservationSource } from '../client-extensions/mount-owner.ts'
import type { CurrentClientPackageLookup } from '../client-extensions/discovery.ts'
import { mergeCause } from './dispose-cause.ts'

/** The composed Client UI subtree. Not exported from the package root. */
export interface RemoteClientUiRuntime {
  /** The ONE Client-local extension service (identity-equal to the Client
   * Context's `piTuiExtensions` value). */
  readonly extensionService: PiTuiExtensionService
  /**
   * Activate external PiTui `./tui` packages for THIS Client revision: read
   * ONE current official Host inventory snapshot and reconcile the owner.
   * Must run after the application runtime (and its PluginManager/Config
   * ports) exists, and before the surface's first attach.
   */
  activateClientExtensions(deps: RemoteClientExtensionDeps): Promise<void>
  /**
   * Reconcile against ONE already-committed official Host inventory snapshot
   * (the Plugin Manager's explicit refresh / invalidation read commit).
   */
  reconcileClientExtensions(snapshot: PluginManagerSnapshot): Promise<void>
  /**
   * Read-only Client-local facts for tests and the future status projection.
   * Never a second Host inventory and never a public package export.
   */
  clientExtensionObservation(): readonly ClientExtensionObservation[]
  /** The SAME observations as a read/revision/subscribe source for the
   *  Plugin Manager's `This Client` projection. Process-local only. */
  clientExtensionObservationSource(): ClientExtensionObservationSource
  /** Dispose external entries first, then the three subtree fibers (reverse
   * order), idempotent. Never disposes the Client Context itself. */
  dispose(): Promise<void>
}

/** The narrow application ports external package activation needs. */
export interface RemoteClientExtensionDeps {
  readonly pluginManager: PluginManagerPort
  readonly config: ConfigPort
}

/** The Client-local loader/package facts the process composition supplies. */
export interface RemoteClientExtensionSource {
  /** The SAME official Loader already installed on the Client Context. */
  readonly loader: Loader
  /** The SAME official `PluginPackages` service of the Client process. */
  readonly pluginPackages: CurrentClientPackageLookup
  /** A `file:` URL inside this Client's install for package resolution. */
  readonly parentURL: string
  /** The Client revision/lifecycle signal. */
  readonly signal?: AbortSignal
  readonly diag?: Diag
}

export interface RemoteClientUiRuntimeOptions {
  /** The EXISTING official Client Context (`wire.client.context`). */
  readonly context: Context
  readonly startup: ClientUiStartupFacts
  /**
   * Split-Client only: the process-owned official Loader and package table.
   * Absent in qualification/component compositions that mount no external
   * packages; `activateClientExtensions` is then a no-op.
   */
  readonly clientExtensions?: RemoteClientExtensionSource
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
    ...(options.startup.sessionLaunch === undefined ? {} : { sessionLaunch: options.startup.sessionLaunch }),
  })

  // Each fiber is assigned BEFORE it is awaited (the client-runtime.ts
  // partial-unwind discipline): a plugin whose startup rejects is still
  // owned by the reverse unwind below at its own stage position.
  let startupFiber: Fiber | undefined
  let extensionHostFiber: Fiber | undefined
  let builtinsFiber: Fiber | undefined
  let extensionMountOwner: ClientExtensionMountOwner | undefined
  let disposeOwnerObservation: (() => void) | undefined
  const observationListeners = new Set<() => void>()
  let disposed = false

  /** Reverse-order unwind of the subtree fibers; per-step error isolation
   * (a failing step never skips the later ones). Returns the collected
   * cleanup errors in encounter order. Fibers never reached by the failed
   * construction stay `undefined` and are skipped — they own nothing to
   * unwind (the client-runtime.ts partial-unwind discipline). */
  const unwind = async (): Promise<unknown[]> => {
    const errors: unknown[] = []
    if (extensionMountOwner !== undefined) {
      errors.push(...await collectDisposeError(() => extensionMountOwner!.dispose()))
    }
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
    return {
      extensionService,
      async activateClientExtensions(deps: RemoteClientExtensionDeps): Promise<void> {
        if (disposed) throw new Error('remote client UI runtime: activateClientExtensions after dispose')
        if (options.clientExtensions === undefined) return
        if (extensionMountOwner !== undefined) {
          throw new Error('remote client UI runtime: client extensions are already activated')
        }
        const owner = createClientExtensionMountOwner({
          context,
          loader: options.clientExtensions.loader,
          pluginPackages: options.clientExtensions.pluginPackages,
          config: deps.config.extensionConfigs,
          parentURL: options.clientExtensions.parentURL,
          notifyReloadRequired: packageName => {
            ;(extensionService as unknown as {
              _advancedUiNotify?: (message: string, options?: { readonly type?: 'info' | 'error' }) => void
            })._advancedUiNotify?.(`Client reload required: /reload-client to load ${packageName}`, { type: 'error' })
          },
          ...(options.clientExtensions.signal === undefined ? {} : { signal: options.clientExtensions.signal }),
          ...(options.clientExtensions.diag === undefined ? {} : { diag: options.clientExtensions.diag }),
        })
        extensionMountOwner = owner
        // Forward the owner's semantic changes to every current source
        // subscriber. The listener set is the ONLY relay: no observation copy
        // and no second cache.
        disposeOwnerObservation = owner.subscribe(() => {
          for (const listener of [...observationListeners]) listener()
        })
        try {
          const snapshot = await deps.pluginManager.snapshot()
          if (disposed) return
          await owner.reconcile(snapshot)
        } catch (error) {
          // A failed inventory read only costs external Client extensions; it
          // never fails the already-mounted Client surface or the Host install.
          options.clientExtensions.diag?.warn('remote client UI runtime: client extension inventory read failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
      async reconcileClientExtensions(snapshot: PluginManagerSnapshot): Promise<void> {
        if (disposed) return
        if (extensionMountOwner === undefined) return
        await extensionMountOwner.reconcile(snapshot)
      },
      clientExtensionObservation(): readonly ClientExtensionObservation[] {
        return extensionMountOwner?.observation() ?? []
      },
      clientExtensionObservationSource(): ClientExtensionObservationSource {
        return {
          observation: () => extensionMountOwner?.observation() ?? [],
          revision: () => extensionMountOwner?.revision() ?? 0,
          subscribe: listener => {
            if (disposed) return () => {}
            observationListeners.add(listener)
            let active = true
            return () => {
              if (!active) return
              active = false
              observationListeners.delete(listener)
            }
          },
        }
      },
      async dispose(): Promise<void> {
        if (disposed) return
        disposed = true
        disposeOwnerObservation?.()
        disposeOwnerObservation = undefined
        observationListeners.clear()
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
