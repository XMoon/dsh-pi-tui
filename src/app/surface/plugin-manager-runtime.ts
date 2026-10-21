/**
 * The surface ↔ Plugin Manager lifecycle glue (S4-D1).
 *
 * This owner holds the ONE `PluginManagerController` per surface, its
 * token-owned `PluginManagerHostRegistry` and both presentation entries
 * (`/plugins` = direct root page, `Settings → Plugins` = in-place page). It is
 * exactly the wiring the aggregate used to inline: the controller itself lives
 * in `app/plugin-manager/**` and is NOT reimplemented here, and the concrete
 * terminal page is selected by the COMPOSITION zone and injected as a narrow
 * factory — this application owner imports no `tui/**` path at all.
 *
 * Preserved rules:
 *
 * - one controller lifetime per surface: the controller OUTLIVES the page
 *   (opening/closing/reopening the page never constructs a second controller);
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
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { TuiApp } from '../../tui-app.ts'
import type { PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import { PluginManagerController } from '../plugin-manager/controller.ts'
import { PluginManagerHostRegistry, type PluginManagerHostClaim } from '../plugin-manager/host-registry.ts'
import { observeTuiExtensions } from '../plugin-manager/extension-inventory.ts'
import type { SurfaceExtensionService } from './extension-runtime.ts'

/** The presentation capabilities the composition zone injects. */
export interface PluginManagerWorkspacePanelDeps {
  /** The live terminal row budget. */
  readonly rows: () => number
  /** The live terminal column budget. */
  readonly columns: () => number
  /** Repaint the hosting screen. */
  readonly requestRender: () => void
  /** The ONE app-owned transient notice. */
  readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** Copy exact text through the Client-local clipboard owner. */
  readonly onCopy: (text: string) => void
  /** Release the owner on an EXTERNAL teardown (never a normal close). */
  readonly onDispose?: () => void
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

/** The Plugin Manager owner: the controller/page wiring for both entries. */
export interface SurfacePluginManager {
  /** The `/plugins` direct root (a second open is a no-op). */
  open(): void
  /** The lazy `Settings → Plugins` page factory (same controller/page). */
  page(done: () => void): Component | undefined
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
  /** Acquire the ONE controller/page owner for both entries. */
  attach(deps: PluginManagerAttachDeps): SurfacePluginManager
  /** Release the controller's install-event subscription (idempotent, early position). */
  dispose(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Create the surface Plugin Manager owner. */
export function createPluginManagerRuntime(options: PluginManagerRuntimeOptions): PluginManagerRuntime {
  let pluginManagerController: PluginManagerController | undefined

  return {
    attach(deps) {
      // ONE controller/page for both entries (`/plugins` and
      // `Settings → Plugins`). The port is the narrow semantic adapter; the
      // presentation classification reads only the shared extension runtime's
      // own health records — never a second inventory or a second manager. The
      // token-owned registry distinguishes a normal close from an external
      // teardown (see its module header).
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
      const panelDeps = (onDispose: () => void): PluginManagerWorkspacePanelDeps => ({
        rows: () => options.mounted().workspaceRows(),
        columns: () => options.mounted().workspaceColumns(),
        requestRender: () => options.mounted().requestRender(),
        notice: () => options.mounted().workspaceNotice(),
        onCopy: text => options.mounted().copyWorkspaceText(text),
        onDispose,
      })
      const open = (): void => {
        // A second open is a no-op: the page is already the active surface.
        if (hosts.isOpen()) return
        let close: () => void = () => {}
        const claim = hosts.claim(() => close())
        let panel: Component | undefined
        try {
          panel = options.createPanel(controller, panelDeps(() => claim.releaseExternally()))
          close = options.mounted().openPluginManagerWorkspace(panel, () => claim.releaseExternally())
          controller.open('direct-command')
        } catch (error) {
          // A refused lease (blocking modal/Job/transition) never leaves a
          // phantom owner or a half-built page behind.
          claim.releaseExternally()
          panel?.dispose?.()
          options.mounted().notify(`could not open the plugin manager: ${errorMessage(error)}`, 'error')
        }
      }
      const page = (done: () => void): Component | undefined => {
        let claim: PluginManagerHostClaim | undefined
        const panel = options.createPanel(controller, panelDeps(() => claim?.releaseExternally()))
        // The Settings parent may dispose this page WITHOUT calling `done` (the
        // fork's lifecycle contract): release only the OWNER.
        claim = hosts.claim(() => claim?.closeNormally(), done)
        controller.open('settings-entry')
        return panel
      }
      return { open, page }
    },
    dispose() {
      // Release the Plugin Manager install-event subscription. This never
      // cancels a Host install: only the official cancel action does that.
      pluginManagerController?.dispose()
    },
  }
}
