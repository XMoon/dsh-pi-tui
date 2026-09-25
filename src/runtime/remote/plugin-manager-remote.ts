/**
 * The experimental Remote Plugin Manager adapter (Pre-M3 PR2): the semantic
 * {@link PluginManagerPort} over the official generated `pluginManager`
 * Remote face, mapped through the SAME pure mapping as the Direct adapter.
 *
 * The generated Remote is the client half of the official Host service, so
 * this adapter owns no package/profile truth, no install state machine and no
 * retry: a `RemoteResult` refusal is normalized to ONE thrown Error (the
 * controller's operation-failure entry point) and the official Host remains
 * the only authority for installed/enabled truth.
 *
 * NOT composed into production: M3 owns Remote backend composition.
 *
 * Full contract: docs/client-server-migration.md §P1 capability ledger and
 * docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/plugin-manager-remote
 */

import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
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
  type PluginExemptionsValue,
} from '../plugin-manager-mapping.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import { remoteFailureMessage } from './write-failure.ts'

/**
 * The official generated `pluginManager` Remote face this adapter consumes:
 * the same record types and the forwarded `plugin-manager/*` install events
 * the Direct Host service exposes.
 */
export interface RemotePluginManagerRemotes {
  listBundles(): Promise<RemoteResultLike<BundleInfo[]>>
  listPlugins(): Promise<RemoteResultLike<PluginInfo[]>>
  registries(): Promise<RemoteResultLike<PluginRegistries>>
  listVersionExemptions(): Promise<RemoteResultLike<PluginExemptionsValue>>
  inspect(
    spec: string,
    options?: { readonly registry?: string | null },
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<PluginSpecInspection>>
  setBundleEnabled(name: string, enabled: boolean): Promise<RemoteResultLike<ChangeResult>>
  setPluginEnabled(id: string, enabled: boolean): Promise<RemoteResultLike<ChangeResult>>
  removeBundle(name: string): Promise<RemoteResultLike<ChangeResult>>
  installBundle(spec: string, options?: InstallBundleOptions): Promise<RemoteResultLike<ChangeResult>>
  waitForInstall(requestId: PluginInstallRequestId): Promise<RemoteResultLike<ChangeResult | null>>
  cancelInstall(requestId: PluginInstallRequestId): Promise<RemoteResultLike<PluginInstallCancellation>>
  $on(event: 'plugin-manager/install-state', listener: (payload: PluginInstallProgress) => void): () => void
  $on(event: 'plugin-manager/install-log', listener: (payload: PluginInstallLogChunk) => void): () => void
}

/** One refused Remote call, normalized to the port's throw-based failure entry. */
function unwrapRemote<T>(result: RemoteResultLike<T>, operation: string): T {
  if (result.ok) return result.value
  throw new Error(`pluginManager.${operation} failed: ${remoteFailureMessage(result.error)}`)
}

/** The experimental Remote Plugin Manager port over the generated Remote. */
export class RemotePluginManagerPort implements PluginManagerPort {
  private readonly remote: RemotePluginManagerRemotes

  constructor(remote: RemotePluginManagerRemotes) {
    this.remote = remote
  }

  async snapshot(): Promise<PluginManagerSnapshot> {
    const [bundles, plugins, registries, exemptions] = await Promise.all([
      this.remote.listBundles(),
      this.remote.listPlugins(),
      this.remote.registries(),
      this.remote.listVersionExemptions(),
    ])
    return detachPluginManagerSnapshot({
      bundles: unwrapRemote(bundles, 'listBundles'),
      plugins: unwrapRemote(plugins, 'listPlugins'),
      registries: unwrapRemote(registries, 'registries'),
      exemptions: unwrapRemote(exemptions, 'listVersionExemptions'),
    })
  }

  async inspect(spec: string, registry?: string | null, signal?: AbortSignal): Promise<PluginSpecInspectionFact> {
    const result = await this.remote.inspect(
      spec,
      registry === undefined ? undefined : { registry },
      signal,
    )
    return detachInspection(unwrapRemote(result, 'inspect'))
  }

  async setBundleEnabled(name: string, enabled: boolean): Promise<PluginChangeFact> {
    return detachChange(unwrapRemote(await this.remote.setBundleEnabled(name, enabled), 'setBundleEnabled'))
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<PluginChangeFact> {
    return detachChange(unwrapRemote(await this.remote.setPluginEnabled(id, enabled), 'setPluginEnabled'))
  }

  async removeBundle(name: string): Promise<PluginChangeFact> {
    return detachChange(unwrapRemote(await this.remote.removeBundle(name), 'removeBundle'))
  }

  async startInstall(request: PluginInstallRequest): Promise<PluginChangeFact> {
    const options: InstallBundleOptions = {
      requestId: pluginInstallRequestId(request.requestId),
      registry: request.registry,
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
    }
    return detachChange(unwrapRemote(await this.remote.installBundle(request.spec, options), 'installBundle'))
  }

  async waitForInstall(requestId: string): Promise<PluginChangeFact | null> {
    const result = unwrapRemote(
      await this.remote.waitForInstall(pluginInstallRequestId(requestId)),
      'waitForInstall',
    )
    return result === null ? null : detachChange(result)
  }

  async cancelInstall(requestId: string): Promise<PluginInstallCancellationFact> {
    const result = unwrapRemote(
      await this.remote.cancelInstall(pluginInstallRequestId(requestId)),
      'cancelInstall',
    )
    return Object.freeze({ status: result.status })
  }

  subscribeInstall(listener: (event: PluginInstallEvent) => void): () => void {
    const offState = this.remote.$on('plugin-manager/install-state', (payload) => {
      listener({ kind: 'phase', phase: detachPhase(payload) })
    })
    const offLog = this.remote.$on('plugin-manager/install-log', (payload) => {
      listener({ kind: 'log', log: detachLog(payload) })
    })
    return () => {
      offState()
      offLog()
    }
  }
}
