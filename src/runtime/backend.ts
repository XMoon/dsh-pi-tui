/**
 * The backend vocabulary (M1.1) + assembly (M1.2): the TUI consumes Host
 * domains through semantic ports, and a backend is the assembly of the
 * ports serving one transport. `direct` is the current production backend
 * (in-process, full Host access); `remote` / `wire-local` adapters join in
 * later milestones (M2/M3) behind the SAME port interfaces — never a second
 * feature semantics.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/backend
 */

import { DIRECT_IMPLEMENTED_CAPABILITIES, type CapabilitySet } from './capability.ts'
import type { SubagentPort } from './subagent-port.ts'
import type { SessionReader } from './session-reader-port.ts'
import type { SessionWriter } from './session-writer-port.ts'
import type { SessionLifecycle } from './session-lifecycle-port.ts'
import type { InteractionPort } from './interaction-port.ts'
import type { Catalog } from './catalog-port.ts'
import type { ConfigPort } from './config-port.ts'
import type { HostFilePort } from './host-file-port.ts'
import type { SessionArchivePort } from './session-archive-port.ts'
import type { HostCommandPort } from './host-command-port.ts'

/** The transport backends the TUI can run on. `direct` is the only one
 * today; the migration adds opt-in backends milestone by milestone. */
export type BackendKind = 'direct'

/** The semantic surface a backend serves: one narrow port per domain. */
export interface Backend {
  readonly kind: BackendKind
  /** The capabilities this backend serves (direct = everything). */
  readonly capabilities: CapabilitySet
  /** The subagent domain port (M1.2; more ports join in later cuts). */
  readonly subagent: SubagentPort
  /** The session READ domain port (M1.3). */
  readonly sessionReader: SessionReader
  /** The session WRITE domain port (D2.1 contract convergence). */
  readonly sessionWriter: SessionWriter
  /** The session LIFECYCLE domain port (D2.1 semantic open). */
  readonly sessionLifecycle: SessionLifecycle
  /** The interaction domain port (M1.6). */
  readonly interaction: InteractionPort
  /** The catalog domain port (M1.8): models/providers, presets, skills. */
  readonly catalog: Catalog
  /** The config domain port (M1.9): settings, provider profiles,
   * credentials, authorization, permissions, preset default. */
  readonly config: ConfigPort
  /** The Host-file domain port (M1.10): `@`-reference discovery and
   * canonicalization against the Host filesystem. */
  readonly hostFile: HostFilePort
  /** The session ARCHIVE domain port (Pre-Stage-D): one complete
   * Session-tree archive stream per root Session. */
  readonly sessionArchive: SessionArchivePort
  /** The Host command execution domain port (D2.1). */
  readonly hostCommand: HostCommandPort
}

/** Assemble the Direct backend: in-process adapters over `ctx.*` services.
 * The runner depends on the returned `Backend`, never on `ctx.*` directly
 * for the ported domains. */
export function createDirectBackend(
  subagent: SubagentPort,
  sessionReader: SessionReader,
  sessionWriter: SessionWriter,
  sessionLifecycle: SessionLifecycle,
  interaction: InteractionPort,
  catalog: Catalog,
  config: ConfigPort,
  hostFile: HostFilePort,
  sessionArchive: SessionArchivePort,
  hostCommand: HostCommandPort,
): Backend {
  return {
    kind: 'direct',
    capabilities: new Set(DIRECT_IMPLEMENTED_CAPABILITIES),
    subagent,
    sessionReader,
    sessionWriter,
    sessionLifecycle,
    interaction,
    catalog,
    config,
    hostFile,
    sessionArchive,
    hostCommand,
  }
}
