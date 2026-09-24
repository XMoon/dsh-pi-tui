/**
 * The Direct Plugin Manager adapter (P1-A): the ONLY module that knows the
 * official `@deepseek-ai/dsh-plugin-manager` Host service. It resolves the
 * service from the Cordis context, maps official records onto the detached
 * {@link PluginManagerPort} facts, and forwards semantic operations
 * unchanged. It owns no profile path, no package.json, no pnpm invocation
 * and no second state machine.
 *
 * Full contract: docs/client-server-migration.md §P1 capability ledger and
 * docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/plugin-manager-direct
 */

import type {
  BundleInfo,
  ChangeResult,
  IncompatiblePlugin,
  InstallBundleOptions,
  ManagementError,
  PackageResult,
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
  PluginBundleFact,
  PluginBundleRowFact,
  PluginChangeFact,
  PluginErrorFact,
  PluginExemptionFact,
  PluginIncompatibleFact,
  PluginInstallCancellationFact,
  PluginInstallEvent,
  PluginInstallLogFact,
  PluginInstallPhaseFact,
  PluginInstallRequest,
  PluginManagerPort,
  PluginManagerSnapshot,
  PluginPackageResultFact,
  PluginRegistriesFact,
  PluginRowFact,
  PluginSpecInspectionFact,
} from '../plugin-manager-port.ts'

/** The official localized-text shape (`@deepseek-ai/dsh-package-manifest`),
 * structural so this file never imports the private manifest package. */
type LocalizedTextLike = string | { readonly en: string }

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

/** Resolve one official localized text to the English fallback. */
function localizedText(value: LocalizedTextLike | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value.en
}

function detachIncompatible(entry: IncompatiblePlugin): PluginIncompatibleFact {
  return Object.freeze({
    name: entry.name,
    version: entry.version,
    runtimeVersion: entry.runtimeVersion,
    peers: Object.freeze({ ...entry.peers }),
  })
}

function detachError(error: ManagementError | undefined): PluginErrorFact | undefined {
  if (error === undefined) return undefined
  return Object.freeze({
    code: error.code,
    ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
    ...(error.incompatible === undefined
      ? {}
      : { incompatible: Object.freeze(error.incompatible.map(detachIncompatible)) }),
  })
}

function detachBundle(bundle: BundleInfo): PluginBundleFact {
  const rows: PluginBundleRowFact[] = bundle.rows.map(row => Object.freeze({
    rowId: row.rowId,
    moduleName: row.moduleName,
    ...(row.meta === undefined ? {} : pickMeta(row.meta)),
    ...(row.entryId === undefined ? {} : { entryId: String(row.entryId) }),
  }))
  return Object.freeze({
    name: bundle.name,
    ...(bundle.version === undefined ? {} : { version: bundle.version }),
    ...(bundle.meta === undefined ? {} : pickMeta(bundle.meta)),
    ...(bundle.description === undefined ? {} : { description: bundle.description }),
    enabled: bundle.enabled,
    installed: bundle.installed,
    optional: bundle.optional,
    removable: bundle.removable,
    ...(bundle.readOnlyReason === undefined ? {} : { readOnlyReason: bundle.readOnlyReason }),
    ...(bundle.error === undefined ? {} : { error: detachError(bundle.error) }),
    rows: Object.freeze(rows),
    overrides: Object.freeze([...bundle.overrides]),
  })
}

function pickMeta(meta: { readonly title?: LocalizedTextLike; readonly description?: LocalizedTextLike }): {
  title?: string
  description?: string
} {
  const title = localizedText(meta.title)
  const description = localizedText(meta.description)
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}

function detachPlugin(entry: PluginInfo): PluginRowFact {
  const addressable = 'patchId' in entry
  return Object.freeze({
    entryId: String(entry.entryId),
    moduleName: entry.moduleName,
    ...(entry.meta === undefined ? {} : pickMeta(entry.meta)),
    enabled: entry.enabled,
    fiberPhase: entry.fiberPhase,
    ...(addressable ? { patchId: entry.patchId } : { readOnlyReason: entry.readOnlyReason }),
  })
}

function detachRegistries(registries: PluginRegistries): PluginRegistriesFact {
  return Object.freeze({
    registry: registries.registry,
    fallbackRegistries: Object.freeze([...registries.fallbackRegistries]),
    resolved: registries.resolved,
  })
}

function detachPackageResult(result: PackageResult | undefined): PluginPackageResultFact | undefined {
  if (result === undefined) return undefined
  return Object.freeze({
    exitCode: result.exitCode,
    ...(result.kind === undefined ? {} : { kind: result.kind }),
    ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
    truncated: result.truncated,
    logPath: result.logPath,
    output: result.output,
    ...(result.incompatible === undefined
      ? {}
      : { incompatible: Object.freeze(result.incompatible.map(detachIncompatible)) }),
  })
}

function detachChange(result: ChangeResult): PluginChangeFact {
  return Object.freeze({
    changed: result.changed,
    application: result.application,
    stage: result.stage,
    target: result.target,
    ...(result.enabled === undefined ? {} : { enabled: result.enabled }),
    ...(result.error === undefined ? {} : { error: detachError(result.error) }),
    ...(result.warnings === undefined ? {} : { warnings: Object.freeze([...result.warnings]) }),
    ...(result.bundle === undefined ? {} : { bundle: result.bundle }),
    ...(result.pendingBuilds === undefined ? {} : { pendingBuilds: Object.freeze([...result.pendingBuilds]) }),
    ...(result.registries === undefined ? {} : { registries: Object.freeze([...result.registries]) }),
    ...(result.failedAt === undefined ? {} : { failedAt: result.failedAt }),
    ...(result.packageResult === undefined ? {} : { packageResult: detachPackageResult(result.packageResult)! }),
  })
}

function detachInspection(inspection: PluginSpecInspection): PluginSpecInspectionFact {
  if (inspection.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      kind: inspection.kind,
      ...(inspection.name === undefined ? {} : { name: inspection.name }),
      ...(inspection.version === undefined ? {} : { version: inspection.version }),
      ...(inspection.description === undefined ? {} : { description: inspection.description }),
      bundle: inspection.bundle,
      registry: inspection.registry,
      ...(inspection.host === undefined ? {} : { host: inspection.host }),
    })
  }
  return Object.freeze({
    status: 'refused',
    problem: inspection.problem,
    reason: inspection.reason,
    ...(inspection.registries === undefined ? {} : { registries: Object.freeze([...inspection.registries]) }),
  })
}

function detachPhase(progress: PluginInstallProgress): PluginInstallPhaseFact {
  return Object.freeze({
    requestId: String(progress.requestId),
    phase: progress.phase,
    ...(progress.attempt === undefined
      ? {}
      : {
        attempt: Object.freeze({
          registry: progress.attempt.registry,
          index: progress.attempt.index,
          total: progress.attempt.total,
        }),
      }),
  })
}

function detachLog(chunk: PluginInstallLogChunk): PluginInstallLogFact {
  return Object.freeze({
    ...(chunk.requestId === undefined ? {} : { requestId: String(chunk.requestId) }),
    jobId: chunk.jobId,
    stream: chunk.stream,
    text: chunk.text,
    ...(chunk.exitCode === undefined ? {} : { exitCode: chunk.exitCode }),
  })
}

/** Generate one install request id (the branded shape is a plain string). */
export function pluginInstallRequestId(value: string): PluginInstallRequestId {
  return value as PluginInstallRequestId
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
    // instead of failing; carry the warnings so the surface can show them.
    const exemptions = service.listVersionExemptions()
    const exemptionFacts: PluginExemptionFact[] = Object.entries(exemptions.exemptions)
      .map(([packageVersion, runtimeVersions]) => Object.freeze({
        packageVersion,
        runtimeVersions: Object.freeze([...runtimeVersions]),
      }))
    return Object.freeze({
      bundles: Object.freeze(bundles.map(detachBundle)),
      plugins: Object.freeze(plugins.map(detachPlugin)),
      registries: detachRegistries(registries),
      exemptions: Object.freeze(exemptionFacts),
      exemptionWarnings: Object.freeze([...exemptions.warnings]),
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
      ...(request.approvedBuilds === undefined ? {} : { approvedBuilds: [...request.approvedBuilds] }),
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
