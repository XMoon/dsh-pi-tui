/**
 * The server/client migration capability vocabulary (M1.1): the domain
 * capabilities the TUI consumes through semantic ports. A backend declares
 * which of these it serves (`src/runtime/backend.ts`); a port is the narrow
 * interface for ONE domain. The vocabulary is deliberately NOT a god
 * interface — consumers depend only on the capability they use.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/capability
 */

/** The domain capabilities of the TUI's Host consumption. */
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
