/**
 * Read-only Client-extension qualification over ONE active DSH profile.
 *
 * This module is a pure projection: the caller supplies the official package
 * identity, whether the active profile selects it, and the Loader rows the
 * official resolution actually mounted. Nothing here calls npm, mounts a
 * fiber, imports a package's `./tui` entry, writes the profile or changes the
 * native DSH plugin-manager state — the result only says whether PiTui may
 * treat the package as a Client extension candidate later. It is NOT a second
 * plugin manager, and `candidate` is never an ACTIVE-surface claim.
 *
 * @module @xmoon76/dsh-pi-tui/app/plugin-manager/client-extension-discovery
 */

import { createHash } from 'node:crypto'

/** The ONE trusted Host-safe module every opted-in package's row names. */
export const EXTENSION_CONFIG_MODULE = '@xmoon76/dsh-pi-tui/extension-config'

/** The package subpath a Client extension opt-in must export. */
export const CLIENT_TUI_ENTRY_EXPORT = './tui'

/** The only opt-in value PiTui currently understands. */
export const CLIENT_TUI_LOCAL = 'tui-local'

/** The only `dshPiTui.manifestVersion` PiTui currently understands. */
export const CLIENT_MANIFEST_VERSION = 1

/**
 * Derive one package's profile-owned Config row id.
 *
 * The id is `sha256(packageName)`'s first 32 lowercase hex characters under a
 * stable prefix: the exact UTF-8 npm `package.json#name`, never a display name,
 * alias, directory or version. One function owns this rule so fixture
 * generation, discovery and the qualification gate cannot drift; Node-only
 * callers (profile/package discovery) may use it, the TUI never needs to.
 *
 * @param packageName - the resolved npm package name (the manifest `name`).
 * @returns the Loader row id that package's patch must insert.
 */
export function extensionConfigRowId(packageName: string): string {
  return `pi-tui-extcfg-${createHash('sha256').update(packageName, 'utf8').digest('hex').slice(0, 32)}`
}

/** The official package identity discovery needs. */
export interface ClientExtensionPackage {
  /** Resolved manifest `name` from the official package resolution. */
  readonly name: string
  /** The parsed package manifest, exactly as installed. */
  readonly manifest: Record<string, unknown>
}

/** One Loader row of the active profile (id + module specifier). */
export interface ClientExtensionRow {
  readonly id: string
  readonly name: string
}

/** One package's discovery input, all of it caller-supplied official data. */
export interface DiscoverClientExtensionInput {
  /** The resolved package identity and installed manifest. */
  readonly package: ClientExtensionPackage
  /** Whether the active profile's official bundle list selects the package. */
  readonly selectedBundle: boolean
  /** Every row the active profile's official resolution mounted. */
  readonly effectiveRows: readonly ClientExtensionRow[]
}

/** The three qualification outcomes. */
export type ClientExtensionDiscovery =
  | {
    readonly kind: 'candidate'
    /** The resolved npm package name (also the row-hash input). */
    readonly packageName: string
    /** The Config row id the package's patch must insert. */
    readonly configRowId: string
    /** The module specifier the future Client loader would import. */
    readonly tuiSpecifier: string
  }
  /** The ACTIVE profile has no Client-extension opt-in for this package. */
  | { readonly kind: 'not-opted-in' }
  /** The package opted in, but the declaration cannot be honored. */
  | { readonly kind: 'invalid-opt-in'; readonly reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Qualify one package as a PiTui Client extension candidate.
 *
 * `not-opted-in` means the active profile has no opt-in for the package: it
 * declares no `dshPiTui` metadata, or the profile does not select its bundle
 * (an installed but unselected package contributes no Loader row at all).
 * `invalid-opt-in` means the profile selects a package that DID declare the
 * opt-in but the declaration and its mounted row cannot be honored; `reason`
 * names the first exact inconsistency. Neither outcome changes the native
 * installed/enabled state — the caller only loses or gains a Client candidate.
 *
 * @param input - official package identity, selection fact and mounted rows.
 * @returns the candidate, a non-opt-in, or the exact opt-in defect.
 */
export function discoverClientExtension(input: DiscoverClientExtensionInput): ClientExtensionDiscovery {
  const { package: pkg, selectedBundle, effectiveRows } = input
  const meta = pkg.manifest.dshPiTui
  if (meta === undefined) return { kind: 'not-opted-in' }
  // An unselected package is not part of the active profile at all, so no
  // declaration defect can matter here: the profile has no opt-in for it.
  if (!selectedBundle) return { kind: 'not-opted-in' }
  if (!isRecord(meta)) return { kind: 'invalid-opt-in', reason: 'dshPiTui metadata is not an object' }
  if (meta.manifestVersion !== CLIENT_MANIFEST_VERSION) {
    return { kind: 'invalid-opt-in', reason: `dshPiTui.manifestVersion is not ${String(CLIENT_MANIFEST_VERSION)}` }
  }
  const entrypoints = meta.entrypoints
  if (!isRecord(entrypoints) || entrypoints[CLIENT_TUI_ENTRY_EXPORT] !== CLIENT_TUI_LOCAL) {
    return { kind: 'invalid-opt-in', reason: `dshPiTui.entrypoints["${CLIENT_TUI_ENTRY_EXPORT}"] is not "${CLIENT_TUI_LOCAL}"` }
  }
  const exportsField = pkg.manifest.exports
  if (!isRecord(exportsField) || !Object.hasOwn(exportsField, CLIENT_TUI_ENTRY_EXPORT)) {
    return { kind: 'invalid-opt-in', reason: `package exports declare no "${CLIENT_TUI_ENTRY_EXPORT}" entry` }
  }
  const configRowId = extensionConfigRowId(pkg.name)
  const rows = effectiveRows.filter(row => row.id === configRowId)
  if (rows.length === 0) {
    return { kind: 'invalid-opt-in', reason: `profile has no Loader row "${configRowId}"` }
  }
  if (rows.length > 1) {
    return { kind: 'invalid-opt-in', reason: `profile mounts "${configRowId}" ${String(rows.length)} times` }
  }
  if (rows[0].name !== EXTENSION_CONFIG_MODULE) {
    return { kind: 'invalid-opt-in', reason: `Load row "${configRowId}" mounts "${rows[0].name}", not "${EXTENSION_CONFIG_MODULE}"` }
  }
  return {
    kind: 'candidate',
    packageName: pkg.name,
    configRowId,
    tuiSpecifier: `${pkg.name}/tui`,
  }
}
