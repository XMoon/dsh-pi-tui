/**
 * The UNSTABLE extension tier entry: `@xmoon76/dsh-pi-tui/extensions/unstable`.
 *
 * Phase-1 surface (plan §5): the module exists, carries tier/version
 * metadata and the reserved capability namespace — no capability is implemented
 * yet, and no Host-private surface is exposed.
 *
 * Third-party plugins import ONLY this entry (and the advanced sibling) —
 * never the stable `./extensions` entry internals, `PiTuiApp`,
 * `PiTuiMainScreen`, `PiTuiAltScreen` or repository-relative paths.
 * @module @xmoon76/dsh-pi-tui/extensions/unstable
 */

import type { ExtensionTier } from './public-types.ts'

/** API level of the unstable tier. Bumped only on unstable breaking changes. */
export const UNSTABLE_API_LEVEL = 0 as const

/** The unstable capability namespace (reserved; nothing is advertised yet). */
export const UNSTABLE_CAPABILITY_NAMESPACE = 'unstable.' as const

/** A capability under the unstable namespace. */
export type UnstableCapability = `unstable.${string}`

/** The shared tier metadata (re-exported for unstable-tier consumers). */
export type { ExtensionTier }