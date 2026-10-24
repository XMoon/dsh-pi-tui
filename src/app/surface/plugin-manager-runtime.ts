/**
 * The surface ↔ Plugin Manager lifecycle glue (S4-D1 / PR2).
 *
 * This owner holds the ONE `PluginManagerController` per surface and the
 * token-owned `PluginManagerHostRegistry` fencing the ONE embedded page hosted
 * by the `Settings → Plugins` workspace. It is exactly the wiring the aggregate
 * used to inline: the controller itself lives in `app/plugin-manager/**` and is
 * NOT reimplemented here, and the concrete terminal page is selected by the
 * COMPOSITION zone and injected as a narrow factory — this application owner
 * imports no `tui/**` path at all.
 *
 * Preserved rules:
 *
 * - one controller lifetime per surface: the controller OUTLIVES the page
 *   (yielding the keyboard to Categories, or closing Settings, never constructs
 *   a second controller);
 * - one active host claim at a time: the Settings root claims the controller
 *   when it mounts the page and releases it exactly once in `onDispose`; a
 *   focus yield never releases, and a stale token can never release a newer
 *   claim;
 * - the extension observation projection is the shared runtime's OWN health
 *   records — never a second inventory or manager;
 * - `dispose()` releases only the controller's install-event subscription (it
 *   never cancels a Host install; only the official cancel action does that) and
 *   is idempotent.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/plugin-manager-runtime
 */

import type { Component } from '@xmoon76/pi-tui'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { TuiApp } from '../../tui-app.ts'
import type { PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import { PluginManagerController } from '../plugin-manager/controller.ts'
import { PluginManagerHostRegistry, type PluginManagerHostClaim } from '../plugin-manager/host-registry.ts'
import {
  describeTuiExtensionDiagnostics,
  observeTuiExtensions,
  type TuiExtensionDiagnostics,
} from '../plugin-manager/extension-inventory.ts'
import type { SurfaceExtensionService } from './extension-runtime.ts'

/**
 * The presentation capabilities the composition zone injects. The page lays
 * itself out inside its GRANTED viewport (the Settings root sets it per frame),
 * so it never reads the physical terminal size, and the App notice is painted
 * once by the Settings root — never forwarded here as a second notice store.
 */
export interface PluginManagerWorkspacePanelDeps {
  /** Repaint the hosting screen. */
  readonly requestRender: () => void
  /** Copy exact text through the Client-local clipboard owner. */
  readonly onCopy: (text: string) => void
  /** Read the CURRENT extension diagnostics on an explicit page read/refresh.
   *  `undefined` means the extension service is not attached (render
   *  Unavailable, never an empty healthy report). */
  readonly diagnostics: () => TuiExtensionDiagnostics | undefined
  /** The Settings root's navigation yield: the page reports the intent (Esc /
   *  Left / Shift+Tab at the list root) and the ROOT commits the focus change.
   *  It never closes the page or releases the owner. */
  readonly onYieldNavigation: () => void
  /** Release the owner once, on a REAL teardown (never a navigation yield). */
  readonly onDispose: () => void
}

/**
 * The narrow concrete-page factory the composition zone provides. The
 * application owner knows only this structural shape — never the page class or
 * its module path.
 */
export type PluginManagerPanelFactory = (
  controller: PluginManagerController,
  deps: PluginManagerWorkspacePanelDeps,
) => Component

/** The Plugin Manager owner: the ONE controller and its embedded page. */
export interface SurfacePluginManager {
  /**
   * Build the `Settings → Plugins` page for the CURRENT Settings lease. A
   * second request while a page still owns the controller returns `undefined`
   * instead of nesting a second owner. The page is created lazily: opening
   * Settings alone never calls this and therefore never reads the inventory.
   */
  page(onYieldNavigation: () => void): Component | undefined
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
  /** The concrete terminal page factory, selected by the composition zone. */
  readonly createPanel: PluginManagerPanelFactory
}

/** The surface Plugin Manager owner `createSurfaceRuntime()` consumes. */
export interface PluginManagerRuntime {
  /** Acquire the ONE controller/page owner. */
  attach(deps: PluginManagerAttachDeps): SurfacePluginManager
  /** Release the controller's install-event subscription (idempotent, early position). */
  dispose(): void
}

/** Create the surface Plugin Manager owner. */
export function createPluginManagerRuntime(options: PluginManagerRuntimeOptions): PluginManagerRuntime {
  let pluginManagerController: PluginManagerController | undefined

  return {
    attach(deps) {
      // ONE controller for the ONE embedded page. The port is the narrow
      // semantic adapter; the presentation classification reads only the shared
      // extension runtime's own health records — never a second inventory or a
      // second manager. The token-owned registry fences the single page owner
      // (see its module header).
      const hosts = new PluginManagerHostRegistry()
      const controller = new PluginManagerController(deps.port, {
        requestRender: () => { if (hosts.isOpen()) options.mounted().requestRender() },
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
      const panelDeps = (
        claim: PluginManagerHostClaim,
        onYieldNavigation: () => void,
      ): PluginManagerWorkspacePanelDeps => ({
        requestRender: () => options.mounted().requestRender(),
        onCopy: text => options.mounted().copyWorkspaceText(text),
        diagnostics: () => {
          const extensionService = options.service()
          if (extensionService === undefined) return undefined
          return describeTuiExtensionDiagnostics(
            {
              healthSnapshot: () => extensionService._ledger().healthSnapshot(),
              ownerEntryIds: () => extensionService._ownerEntryIds(),
            },
            extensionService,
            extensionService.api().capabilities,
          )
        },
        onYieldNavigation,
        onDispose: () => { claim.release() },
      })
      const page = (onYieldNavigation: () => void): Component | undefined => {
        // The Settings root hosts exactly ONE page: a still-living page keeps
        // its claim (and its query/selection/scroll) instead of nesting a
        // second owner.
        if (hosts.isOpen()) return undefined
        let claim: PluginManagerHostClaim | undefined
        let panel: Component | undefined
        try {
          // Claim BEFORE any synchronous callback can observe the new page.
          claim = hosts.claim()
          panel = options.createPanel(controller, panelDeps(claim, onYieldNavigation))
        } catch (error) {
          // A failed factory never leaves a phantom owner or a half-built page
          // behind; the error stays the caller's (no fabricated success).
          claim?.release()
          panel?.dispose?.()
          throw error
        }
        // The inventory read happens exactly once, on the real first mount.
        controller.open()
        return panel
      }
      return { page }
    },
    dispose() {
      // Release the Plugin Manager install-event subscription. This never
      // cancels a Host install: only the official cancel action does that.
      pluginManagerController?.dispose()
    },
  }
}
