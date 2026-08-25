/**
 * The server/client migration capability vocabulary (M1.1,
 * review-corrected): the domain capabilities the TUI consumes through
 * semantic ports. The vocabulary is deliberately NOT a god interface —
 * consumers depend only on the capability they use.
 *
 * A backend may advertise a capability ONLY when it actually serves the
 * corresponding port: `DIRECT_IMPLEMENTED_CAPABILITIES` is the truth for
 * the Direct backend today (M1 complete — every vocabulary entry has a
 * port; see docs/client-server-migration.md).
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/capability
 */

/** The domain capabilities of the TUI's Host consumption (the full
 * migration vocabulary — NOT every entry is implemented yet). */
export const CAPABILITIES = [
  'session-read',
  'session-write',
  'session-lifecycle',
  'subagent',
  'interaction',
  'catalog',
  'config',
  'host-file',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** The capabilities a backend serves (a subset for remote/wire backends). */
export type CapabilitySet = ReadonlySet<Capability>

/** The capabilities the Direct backend ACTUALLY serves today: one port per
 * entry, nothing more — never advertise what is not served. */
export const DIRECT_IMPLEMENTED_CAPABILITIES: readonly Capability[] = [
  'session-read',
  'session-write',
  'session-lifecycle',
  'subagent',
  'interaction',
  'catalog',
  'config',
  'host-file',
]
