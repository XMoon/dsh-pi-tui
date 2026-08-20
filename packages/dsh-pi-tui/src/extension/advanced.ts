/**
 * The ADVANCED extension tier entry: `@xmoon76/dsh-pi-tui/extensions/advanced`.
 *
 * Phase-1 surface (plan §5): the module exists, carries tier/version
 * metadata and the reserved capability namespace — no advanced capability is
 * implemented yet, and no Host-private surface is exposed.
 *
 * Third-party plugins import ONLY this entry (and the unstable sibling)
 * — never the stable `./extensions` entry's internals, `TuiApp`,
 * `TuiMainScreen`, `TuiAltScreen` or repository-relative paths.
 * @module @xmoon76/dsh-pi-tui/extensions/advanced
 */

import type { ExtensionTier } from './public-types.ts'

/** API level of the advanced tier. Bumped only on advanced breaking changes. */
export const ADVANCED_API_LEVEL = 0 as const

/** The advanced capability namespace (reserved; no capability is advertised yet). */
export const ADVANCED_CAPABILITY_NAMESPACE = 'advanced.' as const

/** A capability under the advanced namespace. */
export type AdvancedCapability = `advanced.${string}`

/** The shared tier metadata (re-exported for advanced-tier consumers). */
export type { ExtensionTier }