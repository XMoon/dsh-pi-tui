/**
 * The surface ↔ Plugin Manager lifecycle glue (TS3 §33, TS4 §7-§10).
 *
 * This owner holds the ONE `PluginManagerController` per surface, its
 * token-owned `PluginManagerHostRegistry` and both presentation entries
 * (`/plugins` = direct command, `/settings → Plugins` = submenu). It is exactly
 * the wiring the aggregate used to inline: the controller itself lives in
 * `app/plugin-manager/**` and is NOT reimplemented here, and the concrete
 * terminal panel is selected by the COMPOSITION zone and injected as a narrow
 * factory — this application owner imports no `tui/**` path at all.
 *
 * Preserved rules:
 *
 * - one controller lifetime per surface: the controller OUTLIVES the panel
 *   (opening/closing/reopening the panel never constructs a second controller);
 * - one active host claim at a time: the registry distinguishes a normal close
 *   from an external Settings teardown, and a stale/unclaimed release is inert;
 * - the extension observation projection is the shared runtime's OWN health
 *   records — never a second inventory or manager;
 * - `dispose()` releases only the controller's install-event subscription (it
 *   never cancels a Host install; only the official cancel action does that) and
 *   is idempotent.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/plugin-manager-runtime
 */

import type { Component } from '@xmoon76/pi-tui'
import type { Diag } from '../../diag.ts'
import type { TuiApp } from '../../tui-app.ts'
import type { PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import { PluginManagerController } from '../plugin-manager/controller.ts'
import { PluginManagerHostRegistry, type PluginManagerHostClaim } from '../plugin-manager/host-registry.ts'
import { observeTuiExtensions } from '../plugin-manager/extension-inventory.ts'
import type { SurfaceExtensionService } from './extension-runtime.ts'

/**
 * The narrow concrete-panel factory the composition zone provides (TS4 §8). The
 * application owner knows only this structural shape — never the panel class or
 * its module path.
 */
export type PluginManagerPanelFactory = (
  controller: PluginManagerController,
  requestRender: () => void,
  options: { readonly onDispose?: () => void },
) => Component

/** The Plugin Manager owner: the controller/panel wiring for both entries. */
export interface SurfacePluginManager {
  /** The `/plugins` entry (a second open is a no-op). */
  open(): void
  /** The `/settings → Plugins` entry: the SAME panel hosted as a submenu. */
  submenu(done: (selected?: string) => void): Component
}

/** The acquisition inputs of the Plugin Manager owner; one cohesive lifetime. */
export interface PluginManagerAttachDeps {
  readonly port: PluginManagerPort
  readonly diag: Diag
}

/** The narrow inputs of the Plugin Manager owner; one cohesive lifetime. */
export interface PluginManagerRuntimeOptions {
  /** The mounted app (throws before `start()`), read through the aggregate. */
  readonly mounted: () => TuiApp
  /** The attached extension service, read LATE-BOUND (the observation source). */
  readonly service: () => SurfaceExtensionService | undefined
  /** The concrete terminal panel factory, selected by the composition zone. */
  readonly createPanel: PluginManagerPanelFactory
}

/** The surface Plugin Manager owner `createSurfaceRuntime()` consumes. */
export interface PluginManagerRuntime {
  /** Acquire the ONE controller/panel owner for both entries. */
  attach(deps: PluginManagerAttachDeps): SurfacePluginManager
  /** Release the controller's install-event subscription (idempotent, early position). */
  dispose(): void
}

/** Create the surface Plugin Manager owner. */
export function createPluginManagerRuntime(options: PluginManagerRuntimeOptions): PluginManagerRuntime {
  let pluginManagerController: PluginManagerController | undefined

  return {
    attach(deps) {
      // ONE controller/panel for both entries (`/plugins` and
      // `/settings → Plugins`). The port is the narrow semantic adapter; the
      // presentation classification reads only the shared extension runtime's
      // own health records — never a second inventory or a second manager. The
      // token-owned registry distinguishes a normal close from an external
      // Settings teardown (see its module header).
      const hosts = new PluginManagerHostRegistry()
      const controller = new PluginManagerController(deps.port, {
        requestRender: () => { if (hosts.isOpen()) options.mounted().requestRender() },
        requestClose: () => hosts.closeActive(),
        notify: (message, kind) => options.mounted().notify(message, kind),
        isOpen: () => hosts.isOpen(),
        diag: deps.diag,
      }, {
        observations: () => {
          const extensionService = options.service()
          return extensionService === undefined ? [] : observeTuiExtensions({
            healthSnapshot: () => extensionService._ledger().healthSnapshot(),
            ownerEntryIds: () => extensionService._ownerEntryIds(),
          })
        },
      })
      pluginManagerController = controller
      const open = (): void => {
        // A second open is a no-op: the panel is already the active surface.
        if (hosts.isOpen()) return
        let close: () => void = () => {}
        const claim = hosts.claim(() => close())
        const panel = options.createPanel(controller, () => options.mounted().requestRender(), {
          // Any hide path that disposes the panel releases this owner exactly
          // once (a normal close and an external teardown are the same here).
          onDispose: () => claim.releaseExternally(),
        })
        close = options.mounted().openPluginManagerPanel(panel, () => claim.releaseExternally())
        controller.open('direct-command')
      }
      const submenu = (done: (selected?: string) => void): Component => {
        let claim: PluginManagerHostClaim | undefined
        const panel = options.createPanel(controller, () => options.mounted().requestRender(), {
          // The Settings parent may dispose this submenu WITHOUT calling
          // `done` (the fork's lifecycle contract): release only the OWNER.
          onDispose: () => claim?.releaseExternally(),
        })
        // The user close path returns to Settings; an external teardown must
        // not.
        claim = hosts.claim(() => claim?.closeNormally(), done)
        controller.open('settings-submenu')
        return panel
      }
      return { open, submenu }
    },
    dispose() {
      // Release the Plugin Manager install-event subscription. This never
      // cancels a Host install: only the official cancel action does that.
      pluginManagerController?.dispose()
    },
  }
}
