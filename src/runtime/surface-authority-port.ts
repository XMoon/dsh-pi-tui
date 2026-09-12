/**
 * The live Session surface-authority read seam used by the M2 migration shadow.
 * It carries only detached command and human-skill metadata; production
 * completion and execution remain on the Direct path.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/surface-authority-port
 */

import type { HumanSkillSummary } from '../skill-catalog.ts'
import type { SurfaceCommandSummary } from '../surface-catalog.ts'

/** Detached command/skill authority for one live Session. */
export interface SurfaceAuthoritySnapshot {
  readonly commands: readonly SurfaceCommandSummary[]
  readonly skills: readonly HumanSkillSummary[]
}

/** Read-only authority reader for a live Session. */
export interface SurfaceAuthorityReader {
  /**
   * Read the effective command and human-skill catalog for one live Session.
   * `undefined` means no authoritative view is currently reachable; an empty
   * snapshot is a reachable, authoritative empty catalog.
   */
  read(sessionId: string, signal?: AbortSignal): Promise<SurfaceAuthoritySnapshot | undefined>
}
