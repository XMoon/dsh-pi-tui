/**
 * Neutral surface catalog DTOs (TS8-E): the frozen, detached command +
 * human-skill views a surface needs before the first input, and the pre-mount
 * resolution result.
 *
 * Only discovery metadata crosses the boundary. No Host service interface,
 * context read or process cwd belongs here — the Direct effective read lives in
 * `runtime/direct/surface-catalog.ts` and the pre-mount resolution in
 * `app/direct/initial-catalog.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/catalog/surface
 */

import type { HumanSkillCatalog, HumanSkillSummary } from './skill.ts'

/** Local structural command face, compatible with both npm and Source Mode DSH.
 * The optional identity is part of the official 0.1.6 descriptor; an older
 * runtime's descriptor may omit it. */
export interface SurfaceCommandDescriptor {
  readonly definitionId?: string
  readonly name: string
  readonly description: string
  readonly input?: {
    readonly hint: string
    readonly attachments?: boolean
  }
}

/** Copy one descriptor into a fresh frozen summary (never borrowed). Pure and
 * transport-neutral: both the Direct Host registry read and the Client command
 * registry use it. */
export function commandSummaryOf(descriptor: SurfaceCommandDescriptor): SurfaceCommandSummary {
  return Object.freeze({
    ...descriptor.definitionId === undefined ? {} : { definitionId: descriptor.definitionId },
    name: descriptor.name,
    description: descriptor.description,
    ...descriptor.input === undefined
      ? {}
      : {
          input: Object.freeze({
            hint: descriptor.input.hint,
            ...descriptor.input.attachments === true ? { attachments: true } : {},
          }),
        },
  })
}

/** One effective command's discovery metadata (the official descriptor's
 * display fields and optional stable identity; never a handler or definition). */
export interface SurfaceCommandSummary {
  /** Stable plugin-owned identity from the official command descriptor. */
  readonly definitionId?: string
  readonly name: string
  readonly description: string
  readonly input?: {
    readonly hint: string
    /** The descriptor's attachment declaration (DSH
     * `CommandInputDescriptor.attachments`): ONLY a command declaring it may
     * be invoked with composer attachments (the composer-side half of the
     * contract — the host executor enforces the other half at admission). */
    readonly attachments?: boolean
  }
}

/** One provider's detached failure text (never the thrown value itself). */
export interface SurfaceCatalogIssue {
  readonly provider: 'commands' | 'skills'
  readonly message: string
}

/**
 * The complete frozen catalog view installed before the first input:
 * - `commands` — the full effective view at read time (diagnostics/tests);
 * - `scopedCommands` — effective entries absent from, or shadowing, the
 *   read-time global baseline (completion overrides while sessionless);
 * - `skills` — human-invocable skill summaries (official policy applied);
 * - `issues` — per-provider failures; an absent service is NOT an issue.
 */
export interface SurfaceCatalogSnapshot {
  readonly commands: readonly SurfaceCommandSummary[]
  readonly scopedCommands: readonly SurfaceCommandSummary[]
  readonly skills: readonly HumanSkillSummary[]
  readonly issues: readonly SurfaceCatalogIssue[]
}

/** The pre-mount catalog resolution result: the resume prefetch snapshot or
 * the cold standing-scope skill catalog, plus an optional degradation notice. */
export interface InitialCatalogResolution {
  /** The resume prefetch snapshot to install at mount. */
  readonly snapshot?: SurfaceCatalogSnapshot
  /** The cold standing-scope human skill catalog (deferred start). */
  readonly skills?: HumanSkillCatalog
  /** A user-facing notice when the prefetch/standing read degraded. */
  readonly notice?: string
}
