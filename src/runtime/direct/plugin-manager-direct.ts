/**
 * The Direct Plugin Manager adapter (P1-A): the ONLY module that knows the
 * official `@deepseek-ai/dsh-plugin-manager` Host service. It resolves the
 * service from the Cordis context, maps official records onto the detached
 * {@link PluginManagerPort} facts through the SHARED pure mapping, and
 * forwards semantic operations unchanged. It owns no profile path, no
 * package.json, no pnpm invocation and no second state machine.
 *
 * Full contract: docs/client-server-migration.md §P1 capability ledger and
 * docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/plugin-manager-direct
 */

import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
  PluginEntryId,
  PluginInfo,
  PluginInstallCancellation,
  PluginInstallLogChunk,
  PluginInstallProgress,
  PluginInstallRequestId,
  PluginRegistries,
  PluginSpecInspection,
} from '@deepseek-ai/dsh-plugin-manager'
import type {
  PluginChangeFact,
  PluginInstallCancellationFact,
  PluginInstallEvent,
  PluginInstallRequest,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginSpecInspectionFact,
} from '../plugin-manager-port.ts'
import {
  detachChange,
  detachInspection,
  detachLog,
  detachPhase,
  detachPluginManagerSnapshot,
  pluginInstallRequestId,
} from '../plugin-manager-mapping.ts'

/** The minimal Cordis context surface this adapter needs (structural — the
 * service resolves from the dsh installation, never a package dependency). */
export interface PluginManagerHostContextLike {
  get(name: string): unknown
  /** Subscribe to the official `plugin-manager/*` events; returns a disposer. */
  on(name: string, listener: (payload: unknown) => void): () => void
}

/** The official Host service shape this adapter consumes. */
export interface PluginManagerServiceLike {
  listBundles(): Promise<BundleInfo[]>
  listPlugins(): Promise<PluginInfo[]>
  registries(): Promise<PluginRegistries>
  listVersionExemptions(): { exemptions: Record<string, string[]>; warnings: string[] }
  inspect(spec: string, options?: { readonly registry?: string | null }, signal?: AbortSignal): Promise<PluginSpecInspection>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>
  removeBundle(name: string): Promise<ChangeResult>
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>
  waitForInstall(requestId: PluginInstallRequestId): Promise<ChangeResult | null>
  cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>
}

/** The Direct backend's Plugin Manager port over the official Host service. */
export class DirectPluginManagerPort implements PluginManagerPort {
  private readonly ctx: PluginManagerHostContextLike

  constructor(ctx: PluginManagerHostContextLike) {
    this.ctx = ctx
  }

  /** The official service, read lazily so the adapter construction never
   * races the composition; a missing row is a fail-loud composition error. */
  private service(): PluginManagerServiceLike {
    const service = this.ctx.get('pluginManager') as PluginManagerServiceLike | undefined
    if (service === undefined) {
      throw new Error('pluginManager service unavailable: the supported DSH base must mount @deepseek-ai/dsh-plugin-manager')
    }
    return service
  }

  async snapshot(): Promise<PluginManagerSnapshot> {
    const service = this.service()
    const [bundles, plugins, registries] = await Promise.all([
      service.listBundles(),
      service.listPlugins(),
      service.registries(),
    ])
    // listVersionExemptions is synchronous and reports reader problems
    // instead of failing; the shared mapping carries the warnings so the
    // surface can show them.
    return detachPluginManagerSnapshot({
      bundles,
      plugins,
      registries,
      exemptions: service.listVersionExemptions(),
    })
  }

  async inspect(spec: string, registry?: string | null, signal?: AbortSignal): Promise<PluginSpecInspectionFact> {
    const inspection = await this.service().inspect(
      spec,
      registry === undefined ? undefined : { registry },
      signal,
    )
    return detachInspection(inspection)
  }

  async setBundleEnabled(name: string, enabled: boolean): Promise<PluginChangeFact> {
    return detachChange(await this.service().setBundleEnabled(name, enabled))
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<PluginChangeFact> {
    return detachChange(await this.service().setPluginEnabled(id as PluginEntryId, enabled))
  }

  async removeBundle(name: string): Promise<PluginChangeFact> {
    return detachChange(await this.service().removeBundle(name))
  }

  async startInstall(request: PluginInstallRequest): Promise<PluginChangeFact> {
    const options: InstallBundleOptions = {
      requestId: pluginInstallRequestId(request.requestId),
      registry: request.registry,
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
    }
    return detachChange(await this.service().installBundle(request.spec, options))
  }

  async waitForInstall(requestId: string): Promise<PluginChangeFact | null> {
    const result = await this.service().waitForInstall(pluginInstallRequestId(requestId))
    return result === null ? null : detachChange(result)
  }

  async cancelInstall(requestId: string): Promise<PluginInstallCancellationFact> {
    const result = await this.service().cancelInstall(pluginInstallRequestId(requestId))
    return Object.freeze({ status: result.status })
  }

  subscribeInstall(listener: (event: PluginInstallEvent) => void): () => void {
    const offState = this.ctx.on('plugin-manager/install-state', (payload) => {
      listener({ kind: 'phase', phase: detachPhase(payload as PluginInstallProgress) })
    })
    const offLog = this.ctx.on('plugin-manager/install-log', (payload) => {
      listener({ kind: 'log', log: detachLog(payload as PluginInstallLogChunk) })
    })
    return () => {
      offState()
      offLog()
    }
  }
}
