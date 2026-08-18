/**
 * The PiTuiExtensionService: the Cordis service third-party plugins inject
 * to register contributions. Provided by the `pi-tui-extension-host` row
 * (src/extensions.ts); owned by that provider's fiber, so provider unload
 * disposes every registration made through it.
 *
 * Owner binding (M1, plan §16): every registration is created inside the
 * CALLER's own `ctx.effect()` (the fiber that read the service). Cordis runs
 * that disposer when the caller's fiber unloads (HMR, plugin disable), so
 * owner-scoped cleanup is exact: unload plugin B removes only B's
 * contributions, and provider restart collapses dependents without manual
 * bookkeeping. Load order never decides conflicts — the ledger's rules do.
 *
 * The caller ctx is available through Cordis's Service tracing: a service
 * method's `this.ctx` is bound to the context that READ the service (the
 * getTraceable tracker, `property: 'ctx'`), so `this.ctx.fiber` inside
 * register() IS the calling plugin's fiber — the same mechanism the skill
 * registry's `layers.effect(ctx, ...)` relies on.
 * @module @xmoon76/dsh-pi-tui/extension/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { ExtensionLedger } from './internal/ledger.ts'
import { InvalidateBatcher } from './internal/batcher.ts'
import { isSlotName, slotSemantic } from './slot-map.ts'
import type { PiTuiApiInfo, RegistrationHandle, RegistrationSpec } from './public-types.ts'

/** The service name plugins inject (`piTuiExtensions` in cordis.patch.yml). */
export const PI_TUI_EXTENSIONS_SERVICE = 'piTuiExtensions'

/** The public service surface plugins consume. */
export interface PiTuiExtensionService {
  /** Host identity: version + capability set (feature-detect, never parse versions). */
  readonly api: () => PiTuiApiInfo
  /**
   * Register one contribution under a slot. The registration is owned by the
   * CALLING fiber: it is disposed automatically when that fiber unloads.
   * @param slot - one of the known slot names.
   * @param spec - registration identity + ordering metadata.
   * @param contribution - the contribution value (typed per slot contract).
   */
  register<T>(slot: string, spec: RegistrationSpec, contribution: T): RegistrationHandle<T>
  /** The semantic of one slot ('list' | 'single'), or undefined when unknown. */
  slotSemantics(slot: string): string | undefined
}

/**
 * Concrete implementation bound to one surface host. The SurfaceHost (M2)
 * attaches a render sink; until then invalidations coalesce into a no-op
 * batch (nothing renders yet — M1 has no UI integration).
 */
export class PiTuiExtensionServiceImpl extends Service implements PiTuiExtensionService {
  private readonly ledger: ExtensionLedger
  private readonly batcher: InvalidateBatcher
  private readonly hostVersion: string

  constructor(ctx: Context, hostVersion: string, requestRender: () => void) {
    super(ctx, PI_TUI_EXTENSIONS_SERVICE)
    this.hostVersion = hostVersion
    this.batcher = new InvalidateBatcher({ requestRender })
    this.ledger = new ExtensionLedger(() => this.batcher.invalidate())
  }

  api(): PiTuiApiInfo {
    // M1: the capability set is populated by the SurfaceHost when it
    // attaches (M2). Until then it is empty — plugins must feature-detect.
    return {
      apiVersion: 1,
      hostVersion: this.hostVersion,
      capabilities: new Set(),
    }
  }

  register<T>(slot: string, spec: RegistrationSpec, contribution: T): RegistrationHandle<T> {
    if (!isSlotName(slot)) {
      throw new Error(
        `unknown extension slot "${slot}" (known: ${['chrome.header.badge', 'input.dock.item', 'chrome.footer.status'].join(', ')})`,
      )
    }
    // `this.ctx` is the CALLER's context (Cordis Service tracing); its fiber
    // owns this registration's lifetime. The ledger keys ownership by the
    // fiber UID (unique per fiber — anonymous sibling plugins share the
    // inherited display name 'root', so the NAME would conflate them); the
    // display name rides along for diagnostics. The fiber-bound effect
    // disposer performs the cleanup on unload. `this.ctx.fiber.effect()`
    // throws INACTIVE_EFFECT when the caller fiber is already disposed —
    // the registration must then be rolled back so the (slot, id) pair is
    // not blocked by a ghost.
    const caller = this.ctx
    const owner = `${caller.fiber.uid}:${caller.fiber.name}`
    const handle = this.ledger.register<T>(slot, spec, contribution, owner)
    let dispose: () => void
    try {
      dispose = caller.fiber.effect(() => () => {
        handle.dispose()
      }, 'piTuiExtensions.register()')
    } catch (error) {
      handle.dispose()
      throw error
    }
    return {
      id: handle.id,
      invalidate: () => handle.invalidate(),
      replace: (next: T) => handle.replace(next),
      // Idempotent AND fiber-bound: an explicit dispose() disposes the
      // contribution immediately; the fiber disposer then no-ops.
      dispose: () => {
        handle.dispose()
        dispose()
      },
    }
  }

  slotSemantics(slot: string): string | undefined {
    if (!isSlotName(slot)) return undefined
    return slotSemantic(slot)
  }

  /** The ledger behind the service (SurfaceHost access in M2). */
  _ledger(): ExtensionLedger {
    return this.ledger
  }
}
