/**
 * The pre-mount catalog RESOLUTION implementation (TS8-E): the resume
 * prefetch or the cold standing-scope skill read, with their one-shot
 * degradation notices.
 *
 * Its options are STRUCTURAL (`SurfaceCatalogResolutionOptions`); the published
 * `ResolveInitialCatalogOptions` (which keeps the Host `Agent` type for
 * compatibility) is declared in `src/index.ts`, which delegates here. The
 * implementation consumes the Direct effective read and the Direct skill
 * adapter, and the neutral result DTOs from `domain/catalog/surface.ts`.
 * @module @xmoon76/dsh-pi-tui/app/direct/initial-catalog
 */

import { safeErrorMessage } from '../../error-boundary.ts'
import { isCancellation } from '../../detached.ts'
import type { Diag } from '../../diag.ts'
import {
  readSurfaceCatalog,
  type SurfaceCatalogAgent,
  type SurfaceCatalogContext,
} from '../../runtime/direct/surface-catalog.ts'
import {
  readHumanSkillCatalog,
  resolveColdSkillTarget,
  type SkillCatalogContext,
} from '../../runtime/direct/skill-catalog.ts'
import type { HumanSkillCatalog } from '../../domain/catalog/skill.ts'
import type { InitialCatalogResolution, SurfaceCatalogSnapshot } from '../../domain/catalog/surface.ts'

/**
 * The STRUCTURAL resolution options the implementation consumes. The PUBLISHED
 * `ResolveInitialCatalogOptions` (which declares `liveAgent?: Agent`) is the
 * package entry's declaration; `src/index.ts` delegates here with the same
 * object, so this application module never imports a Host type (A5a review P1:
 * the public property shape must not change).
 */
export interface SurfaceCatalogResolutionOptions {
  /** The resumed live agent, if any (prefetch path). */
  readonly liveAgent?: SurfaceCatalogAgent
  /** The effective preset id for the cold standing read (undefined = the
   * deployment default; only consulted for the deferred start). */
  readonly presetId?: string
  readonly signal: AbortSignal
  /** The context surface the collectors read services from. */
  readonly ctx: SurfaceCatalogContext
  readonly diag: Diag
  /** Suspend the pre-mount startup status before an ordinary log write
   * (the status owns the current terminal line; a TTY shares one cursor
   * between stdout and stderr). Called right before every diag.warn this
   * function may emit. */
  readonly onLog?: () => void
}

/**
 * The pre-mount surface catalog resolution:
 * - an explicit `--session` start PREFETCHES the resumed agent's effective
 *   catalog (a live read emits no session events);
 * - the deferred start (no `--session`) reads the cold HUMAN SKILL catalog
 *   through the preset's STANDING SCOPE — no Agent, no session, no turn —
 *   so the first input sees human-invocable skills without any durable
 *   side effect (the mechanism that avoids the probe dead end: host
 *   `session/created` observers write durable knob events into every fresh
 *   session).
 *
 * The snapshot (resume) or the skill catalog (cold) installs synchronously
 * after mount (the ready barrier).
 *
 * Failure taxonomy (plan appendix B):
 * - lifecycle cancellation: nothing installed, no notice;
 * - a prefetch/standing read failure degrades to a one-shot notice (the
 *   TUI mounts with the global view and built-in commands);
 * - a missing/unknown preset or a broken standing mount degrades the cold
 *   target to the global layer with a one-shot notice — never a probe
 *   Agent, never a startup failure;
 * - an ordinary provider read failure never rejects here: it becomes an
 *   empty field + detached issue inside the catalog.
 * @param options - injected dependencies (see {@link SurfaceCatalogResolutionOptions}).
 * @returns the snapshot / skill catalog to install and an optional notice.
 */
export async function resolveInitialCatalog(options: SurfaceCatalogResolutionOptions): Promise<InitialCatalogResolution> {
  const { liveAgent, presetId, signal, ctx, diag, onLog } = options
  if (liveAgent !== undefined) {
    try {
      const snapshot = await readSurfaceCatalog(liveAgent, signal, ctx)
      diag.info('surface catalog prefetched', {
        commands: snapshot.commands.length,
        scopedCommands: snapshot.scopedCommands.length,
        skills: snapshot.skills.length,
      })
      return { snapshot }
    } catch (error) {
      if (isCancellation(error)) return {}
      const message = safeErrorMessage(error)
      onLog?.()
      diag.warn('surface catalog unavailable', { phase: 'resume', error: message })
      return { notice: `surface catalog unavailable: ${message}` }
    }
  }
  // Deferred start: the cold standing-scope skill read. No Agent, no
  // session, no turn — and no probe fallback on any failure. The standing
  // scope rides the official revision lease; it is released once the read
  // settles on ANY path (the lease must never outlive its read).
  const target = await resolveColdSkillTarget(ctx as unknown as SkillCatalogContext, presetId, process.cwd())
  if (target.target === undefined) return {}
  try {
    const catalog = await readHumanSkillCatalog(target.target.registry, {
      cwd: target.target.cwd,
      scope: target.target.scope,
      signal,
    })
    diag.info('skill catalog standing ready', {
      preset: presetId ?? 'default',
      skills: catalog.skills.length,
      complete: catalog.complete,
    })
    return { skills: catalog, ...target.degraded === undefined ? {} : { notice: target.degraded } }
  } catch (error) {
    if (isCancellation(error)) return {}
    const message = safeErrorMessage(error)
    onLog?.()
    diag.warn('skill catalog unavailable', { phase: 'cold', error: message })
    return { notice: `skill catalog unavailable: ${message}` }
  } finally {
    await target.release?.()
  }
}
