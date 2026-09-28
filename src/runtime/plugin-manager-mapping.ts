/**
 * The Plugin Manager pure mapping (Pre-M3 PR2): the official package/profile
 * records mapped onto the detached {@link PluginManagerPort} facts. Both the
 * Direct Host service and the generated `pluginManager` Remote return the
 * SAME official record types, so both adapters share this ONE mapping and the
 * presentation semantics can never drift between them.
 *
 * Nothing here names a transport, a Cordis context, a Host service or a
 * `RemoteResult`: only record shapes and detached facts.
 *
 * Full contract: docs/client-server-migration.md §P1 capability ledger and
 * docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/plugin-manager-mapping
 */

import type {
  BundleInfo,
  ChangeResult,
  IncompatiblePlugin,
  ManagementError,
  PluginInfo,
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
  PluginInstallLogFact,
  PluginInstallPhaseFact,
  PluginManagerSnapshot,
  PluginRegistriesFact,
  PluginRowFact,
  PluginSpecInspectionFact,
} from './plugin-manager-port.ts'

/** The official localized-text shape (`@deepseek-ai/dsh-package-manifest`),
 * structural so this module never imports the private manifest package. */
type LocalizedTextLike = string | { readonly en: string }

/** Generate one install request id (the branded shape is a plain string). */
export function pluginInstallRequestId(value: string): PluginInstallRequestId {
  return value as PluginInstallRequestId
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

/** The official synchronous exemption read's value shape. */
export interface PluginExemptionsValue {
  readonly exemptions: Record<string, string[]>
  readonly warnings: string[]
}

function detachExemptions(value: PluginExemptionsValue): readonly PluginExemptionFact[] {
  return Object.freeze(Object.entries(value.exemptions)
    .map(([packageVersion, runtimeVersions]) => Object.freeze({
      packageVersion,
      runtimeVersions: Object.freeze([...runtimeVersions]),
    })))
}

/** Everything the read-only management surface renders, read together. */
export interface PluginManagerSnapshotInput {
  readonly bundles: readonly BundleInfo[]
  readonly plugins: readonly PluginInfo[]
  readonly registries: PluginRegistries
  readonly exemptions: PluginExemptionsValue
}

/** Map one complete snapshot read onto the detached surface facts. */
export function detachPluginManagerSnapshot(input: PluginManagerSnapshotInput): PluginManagerSnapshot {
  return Object.freeze({
    bundles: Object.freeze(input.bundles.map(detachBundle)),
    plugins: Object.freeze(input.plugins.map(detachPlugin)),
    registries: detachRegistries(input.registries),
    exemptions: detachExemptions(input.exemptions),
    exemptionWarnings: Object.freeze([...input.exemptions.warnings]),
  })
}

/** Map one persisted change and its observed application outcome. */
export function detachChange(result: ChangeResult): PluginChangeFact {
  return Object.freeze({
    changed: result.changed,
    application: result.application,
    stage: result.stage,
    target: result.target,
    ...(result.error === undefined ? {} : { error: detachError(result.error) }),
    ...(result.warnings === undefined ? {} : { warnings: Object.freeze([...result.warnings]) }),
    ...(result.bundle === undefined ? {} : { bundle: result.bundle }),
  })
}

/** Map what a spec names before installation. */
export function detachInspection(inspection: PluginSpecInspection): PluginSpecInspectionFact {
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

/** Map one official install-phase announcement. */
export function detachPhase(progress: PluginInstallProgress): PluginInstallPhaseFact {
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

/** Map one pnpm output chunk. */
export function detachLog(chunk: PluginInstallLogChunk): PluginInstallLogFact {
  return Object.freeze({
    ...(chunk.requestId === undefined ? {} : { requestId: String(chunk.requestId) }),
    jobId: chunk.jobId,
    stream: chunk.stream,
    text: chunk.text,
  })
}
