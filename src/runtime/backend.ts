/**
 * The backend vocabulary (M1.1): the TUI consumes Host domains through
 * semantic ports, and a backend is the assembly of the ports serving one
 * transport. `direct` is the current production backend (in-process, full
 * Host access); `remote` / `wire-local` adapters join in later milestones
 * (M2/M3) behind the SAME port interfaces — never a second feature
 * semantics. M1.2 adds the first port (`subagent`) to this surface.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/backend
 */

import { CAPABILITIES, type CapabilitySet } from './capability.ts'

/** The transport backends the TUI can run on. `direct` is the only one
 * today; the migration adds opt-in backends milestone by milestone. */
export type BackendKind = 'direct'

/** The semantic surface a backend serves: one narrow port per domain. */
export interface Backend {
  readonly kind: BackendKind
  /** The capabilities this backend serves (direct = everything). */
  readonly capabilities: CapabilitySet
}

/** The current production backend: in-process, full Host access. */
export const directBackend: Backend = {
  kind: 'direct',
  capabilities: new Set(CAPABILITIES),
}
