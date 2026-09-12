/**
 * Direct implementation of the M2 surface-authority read seam.
 *
 * This adapter deliberately reuses the existing live surface collector. It
 * resolves an already-live Agent only; catalog discovery never creates an
 * Agent, activates a Session, probes a preset, or mutates Host state.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/surface-authority-direct
 */

import {
  readSurfaceCatalog,
  type SurfaceCatalogContext,
} from '../../surface-catalog.ts'
import type {
  SurfaceAuthorityReader,
  SurfaceAuthoritySnapshot,
} from '../surface-authority-port.ts'

/** Structural Host context consumed by the existing surface collector. */
export interface DirectSurfaceAuthorityContext {
  get(name: string): unknown
}

/** Structural live-Agent slice needed to select the skill read cwd. */
export interface DirectSurfaceAuthorityAgent {
  readonly session: {
    readonly header: {
      readonly cwd?: string
    }
  }
}

/** Read the Direct authority for an already-live Session. */
export class DirectSurfaceAuthorityReader implements SurfaceAuthorityReader {
  private readonly ctx: DirectSurfaceAuthorityContext
  private readonly agentFor: (sessionId: string) => DirectSurfaceAuthorityAgent | undefined

  constructor(
    ctx: DirectSurfaceAuthorityContext,
    agentFor: (sessionId: string) => DirectSurfaceAuthorityAgent | undefined,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  async read(sessionId: string, signal?: AbortSignal): Promise<SurfaceAuthoritySnapshot | undefined> {
    signal?.throwIfAborted()
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return undefined
    const readSignal = signal ?? new AbortController().signal
    const catalog = await readSurfaceCatalog(
      agent as Parameters<typeof readSurfaceCatalog>[0],
      readSignal,
      this.ctx as unknown as SurfaceCatalogContext,
    )
    readSignal.throwIfAborted()
    if (catalog.issues.length > 0) {
      throw new Error(
        `surface authority read failed: ${catalog.issues.map(issue => `${issue.provider}: ${issue.message}`).join('; ')}`,
      )
    }
    return Object.freeze({
      commands: catalog.commands,
      skills: catalog.skills,
    })
  }
}
