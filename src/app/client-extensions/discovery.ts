/**
 * Client-local discovery of external PiTui `./tui` packages.
 *
 * This module is the ONE orchestrator between two independent authorities:
 *
 * - the authenticated Host Plugin Manager snapshot (`bundles[].enabled` plus
 *   the live profile Loader rows in `plugins[]`), supplied by the caller;
 * - the CURRENT Client process's already-installed package table
 *   (`PluginPackages.packageOf`), never a profile path scan or a second
 *   npm resolver.
 *
 * It adds no qualification rules of its own: every per-package decision is
 * the existing pure {@link discoverClientExtension} policy. The result is a
 * `candidate` per enabled bundle whose installed manifest declares PiTui's
 * `tui-local` opt-in and whose trusted Config carrier row is mounted, or a
 * PiTui-only reason why it is not. `candidate` is never an ACTIVE claim —
 * the mount owner still has to create a real Loader Entry/Fiber.
 *
 * @module @xmoon76/dsh-pi-tui/app/client-extensions/discovery
 */

import type { PluginManagerSnapshot } from '../../runtime/plugin-manager-port.ts'
import {
  discoverClientExtension,
  type ClientExtensionRow,
} from '../plugin-manager/client-extension-discovery.ts'

/** The Local package identity the current Client process can resolve. */
export interface CurrentClientPackage {
  /** The manifest package name, as installed (never the bundle alias). */
  readonly name: string
  /** The package's absolute directory in this Client's resolution. */
  readonly dir: string
  /** The parsed installed manifest. */
  readonly manifest: Record<string, unknown>
}

/** The ONE package-lookup capability discovery consumes (`PluginPackages`). */
export interface CurrentClientPackageLookup {
  packageOf(specifier: string, parentURL: string): CurrentClientPackage | undefined
}

/** One enabled Host bundle's PiTui Client outcome. */
export type CurrentClientExtension =
  | {
    readonly kind: 'candidate'
    /** The official bundle name that selected this package. */
    readonly bundleName: string
    readonly packageName: string
    readonly packageDir: string
    readonly configRowId: string
    readonly tuiSpecifier: string
  }
  /** The package is selected and installed but has no PiTui opt-in. */
  | { readonly kind: 'not-opted-in'; readonly bundleName: string; readonly packageName: string }
  /** The package opted in, but its declaration or trusted row is unusable. */
  | { readonly kind: 'invalid-opt-in'; readonly bundleName: string; readonly packageName: string; readonly reason: string }
  /** The selected bundle is not resolvable in the CURRENT Client process. */
  | { readonly kind: 'unresolved'; readonly bundleName: string; readonly reason: string }

/** The live profile Loader rows the official Host snapshot reports. */
function effectiveRowsOf(snapshot: PluginManagerSnapshot): readonly ClientExtensionRow[] {
  const rows: ClientExtensionRow[] = []
  for (const row of snapshot.plugins) {
    // Only a row the official Host considers effectively enabled AND live can
    // be the trusted Config carrier. A pending/failed/disabled row is not a
    // mounted Settings namespace; the ConfigPort read fails closed later.
    if (row.patchId === undefined || !row.enabled || row.fiberPhase !== 'active') continue
    rows.push({ id: row.patchId, name: row.moduleName })
  }
  return rows
}

/**
 * Qualify every ENABLED official bundle against the CURRENT Client's own
 * installed package identity.
 *
 * Order is the official bundle order, so two Clients with the same Host
 * snapshot produce the same deterministic candidate order. A duplicate
 * manifest package name reached through two enabled bundles is a profile
 * identity defect: both outcomes are downgraded to `invalid-opt-in` instead
 * of letting one alias mount a package the other alias also names.
 *
 * @param snapshot - ONE authenticated official Host Plugin Manager snapshot.
 * @param pluginPackages - the current Client process's official package table.
 * @param parentURL - a `file:` URL inside the current Client install whose
 *   Node lookup order applies to `packageOf`.
 * @returns one immutable outcome per enabled bundle, in snapshot order.
 */
export function discoverCurrentClientExtensions(
  snapshot: PluginManagerSnapshot,
  pluginPackages: CurrentClientPackageLookup,
  parentURL: string,
): readonly CurrentClientExtension[] {
  const effectiveRows = effectiveRowsOf(snapshot)
  const outcomes: CurrentClientExtension[] = []
  for (const bundle of snapshot.bundles) {
    if (!bundle.enabled) continue
    const pkg = pluginPackages.packageOf(bundle.name, parentURL)
    if (pkg === undefined) {
      outcomes.push({
        kind: 'unresolved',
        bundleName: bundle.name,
        reason: `the Client process cannot resolve bundle "${bundle.name}"`,
      })
      continue
    }
    const discovery = discoverClientExtension({
      package: { name: pkg.name, manifest: pkg.manifest },
      selectedBundle: true,
      effectiveRows,
    })
    if (discovery.kind === 'candidate') {
      outcomes.push({
        kind: 'candidate',
        bundleName: bundle.name,
        packageName: pkg.name,
        packageDir: pkg.dir,
        configRowId: discovery.configRowId,
        tuiSpecifier: discovery.tuiSpecifier,
      })
    } else if (discovery.kind === 'invalid-opt-in') {
      outcomes.push({ kind: 'invalid-opt-in', bundleName: bundle.name, packageName: pkg.name, reason: discovery.reason })
    } else {
      outcomes.push({ kind: 'not-opted-in', bundleName: bundle.name, packageName: pkg.name })
    }
  }
  return freezeDuplicatePackageOutcomes(outcomes)
}

/** Fail closed when two enabled bundles resolve to one manifest package. */
function freezeDuplicatePackageOutcomes(outcomes: CurrentClientExtension[]): readonly CurrentClientExtension[] {
  const byPackage = new Map<string, number[]>()
  outcomes.forEach((outcome, index) => {
    if (outcome.kind === 'unresolved') return
    const indexes = byPackage.get(outcome.packageName)
    if (indexes === undefined) byPackage.set(outcome.packageName, [index])
    else indexes.push(index)
  })
  for (const [packageName, indexes] of byPackage) {
    if (indexes.length < 2) continue
    for (const index of indexes) {
      const bundleName = outcomes[index].bundleName
      outcomes[index] = {
        kind: 'invalid-opt-in',
        bundleName,
        packageName,
        reason: `multiple enabled bundles resolve to package "${packageName}"`,
      }
    }
  }
  return Object.freeze(outcomes.map(outcome => Object.freeze(outcome)))
}
