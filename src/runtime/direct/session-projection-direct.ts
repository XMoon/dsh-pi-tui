/**
 * The Direct combined session-projection batch reader — the ONE Host read
 * path behind `SessionReader.projectionBatch()` for the /sessions picker.
 *
 * The DSH Harness owns both projections the picker needs: the `title`
 * projection (`titleProjectionDefinition`, state `string | null`) and the
 * `agentPreset` projection (`agentPresetProjectionDefinition`, initialized
 * from the creation header and advanced by preset-selection events). This
 * module consumes exactly those official semantics and never folds a second
 * copy of either:
 *
 * 1. live session  → already-materialized values come from
 *    `sessionProjections.cachedSnapshot()` (in-memory, zero I/O); the preset prefers the agent's CURRENT composed
 *    roster entry (`agentPresets.composedPreset()`) — a deliberate
 *    live-only exception: the running Agent's actual composition is the
 *    authoritative effective preset even while it trails or leads the
 *    durable projection mid-switch — with the projection value as the
 *    fallback;
 * 2. cold + cache  → `sessionProjectionCache.cachedSnapshot(header, keys)`
 *    (a durable checkpoint read keyed by the `list()` header identity — no
 *    full-log fold);
 * 3. cold + miss   → leave the optional fields unknown. The picker must not
 *    activate a historical Session or synthesize a cold observation merely to
 *    fill a label.
 *
 * Per-row cache/resolver failures are isolated instead of hiding the picker:
 * a live teardown race fail-softs silently to the other field, while a broken
 * derived cache value is reported and omitted.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-projection-direct
 */

import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { SessionProjectionSummary, SessionSummary } from '../session-reader-port.ts'
import { resolveProjectedPresetId } from './session-preset-direct.ts'

/** The projection keys this batch reads (the official registered units). */
type ProjectionKey = typeof agentPresetProjectionDefinition.key | 'title' | 'sessionListMetadata'

/** The list metadata capability is provided by the optional API controller;
 * deployments without it simply fall back to header creation time. */
export interface SessionListMetadataLike {
  readonly blank?: boolean
  readonly lastPromptAt?: number | null
}

/** The official live projection read surface (structural subset of
 * `sessionProjections` — the value table carries both keys). */
export interface SessionProjectionReaderLike {
  /** Read only already-materialized cells; never fold the live Session. */
  cachedSnapshot(
    session: Session,
    keys?: readonly ProjectionKey[],
  ): { readonly values?: {
    readonly title?: string | null
    readonly agentPreset?: string | null
    readonly sessionListMetadata?: SessionListMetadataLike
  } } | undefined
}

/** The zero-I/O projection-cache hint (structural subset of
 * `sessionProjectionCache`). A row is possibly stale but never wrong; the
 * caller's `list()` header is the identity witness, so no log read and no
 * second corpus listing is needed. Seeded list headers without an exact cut
 * are deliberately skipped. */
export interface SessionProjectionCacheLike {
  cachedSnapshot(
    meta: SessionHeader,
    inheritedEventCount: ReturnType<typeof SessionLogOffset>,
    keys?: readonly ProjectionKey[],
  ): { readonly values?: {
    readonly title?: string | null
    readonly agentPreset?: string | null
    readonly sessionListMetadata?: SessionListMetadataLike
  } } | undefined
  cachedPredecessorTitle?(
    meta: SessionHeader,
    inheritedEventCount: ReturnType<typeof SessionLogOffset>,
  ): { readonly values?: { readonly title?: string | null } } | undefined
}

/** The diagnostics sink for isolated per-row failures (a structural subset
 * of the runner's Diag channel — the batch never imports the runner). */
export interface SessionReaderDiagLike {
  info(message: string, fields?: Record<string, unknown>): void
}

/** The minimal Host context surface (structural — the services resolve from
 * the dsh installation; never a package dependency). */
export interface SessionProjectionContext {
  get(name: string): unknown
}

/** The presets-service resolver surface shared with the preset adapter. */
export interface PresetsServiceLike {
  readonly defaultId?: string
  resolve(id?: string): Promise<{ readonly id: string }>
}

/** The Host surfaces the batch needs, supplied by the Direct reader (which
 * owns the `list()` header snapshot and the live-agent mapping). */
export interface ProjectionBatchDeps {
  readonly ctx: SessionProjectionContext
  /** The rows to enrich (main rows only — the caller filters subagents). */
  readonly rows: readonly SessionSummary[]
  /** The header identity witness captured by the preceding `list()`. */
  readonly headerOf: (sessionId: string) => SessionHeader | undefined
  /** The currently loaded agent for a session id, when live. */
  readonly liveAgentOf: (sessionId: string) => { readonly session: Session } | undefined
  /** The authoritative live preset composition for a session id. */
  readonly livePresetOf: (sessionId: string) => string | undefined
  /** One roster snapshot shared by the whole batch (legacy `code` mapping). */
  readonly rosterIds: (signal?: AbortSignal) => Promise<readonly string[] | undefined>
  readonly diag?: SessionReaderDiagLike
}

/** Read a typed query-service error without depending on its package surface. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** The exact cache cut available from a lightweight list header. Unseeded
 * sessions always start at cut 0. A seeded list record has no exact inherited
 * cut, so it must skip the cache rather than guessing from unrelated metadata. */
function inheritedCutOf(header: SessionHeader): ReturnType<typeof SessionLogOffset> | undefined {
  return header.isSeeded === false ? SessionLogOffset(0) : undefined
}

/**
 * Read the projection-cache hint for one header. A seeded header without an
 * exact inherited cut skips the cache entirely — a guessed cut could seed
 * values folded from an unrelated log prefix (master contract §3.5).
 */
function safeCachedSnapshot(
  cache: SessionProjectionCacheLike | undefined,
  header: SessionHeader,
): { readonly values?: { readonly title?: string | null; readonly agentPreset?: string | null } } | undefined {
  if (cache === undefined) return undefined
  const cut = inheritedCutOf(header)
  if (cut === undefined) return undefined
  try {
    return cache.cachedSnapshot(header, cut, ['title', 'agentPreset'])
      ?? cache.cachedPredecessorTitle?.(header, cut)
  } catch {
    return undefined
  }
}

/** The live fast path: title and cached fallback preset from already-materialized
 * projection cells (zero history folding), with preset first from the authoritative composed
 * composition (a DELIBERATE live-only exception: the composed roster entry
 * reflects the running Agent's actual composition, which can trail or lead
 * the durable projection during a switch; the projection value remains the
 * fallback). BOTH reads are per-row isolated — one throwing read degrades to
 * the other field instead of failing the batch. Absent/`null` title means
 * the session genuinely has none. */
function liveProjection(
  deps: ProjectionBatchDeps,
  projections: SessionProjectionReaderLike | undefined,
  sessionId: string,
): SessionProjectionSummary | undefined {
  let preset: string | undefined
  try {
    preset = deps.livePresetOf(sessionId)
  } catch {
    // A composition read racing teardown is not a picker error; the title
    // (or the short-id presentation) still applies.
  }
  let live: { readonly session: Session } | undefined
  try {
    live = deps.liveAgentOf(sessionId)
  } catch {
    // Same teardown race as above: the title still applies.
  }
  let title: string | undefined
  if (live !== undefined && projections !== undefined) {
    try {
      const values = projections.cachedSnapshot(live.session, ['title', 'agentPreset'])?.values
      if (typeof values?.title === 'string') title = values.title
      if (preset === undefined && typeof values?.agentPreset === 'string') preset = values.agentPreset
    } catch {
      // A live session being torn down is not a picker error; the preset or
      // the short-id presentation still applies.
    }
  }
  if (title === undefined && preset === undefined) return undefined
  return {
    ...(title === undefined ? {} : { title }),
    ...(preset === undefined ? {} : { preset }),
  }
}

/**
 * The combined projection batch (the port's `projectionBatch` semantics):
 * live fast path → zero-I/O cache fast path → unknown fields on a cold miss.
 * A picker enrichment must never activate a historical Session or replay its
 * full log merely to fill a label. Cancellation still rejects the whole batch.
 */
export async function projectionBatch(
  deps: ProjectionBatchDeps,
  signal?: AbortSignal,
): Promise<Map<string, SessionProjectionSummary>> {
  const result = new Map<string, SessionProjectionSummary>()
  if (deps.rows.length === 0) return result
  signal?.throwIfAborted()

  const projections = deps.ctx.get('sessionProjections') as SessionProjectionReaderLike | undefined
  const cache = deps.ctx.get('sessionProjectionCache') as SessionProjectionCacheLike | undefined
  const presets = deps.ctx.get('agentPresets') as PresetsServiceLike | undefined

  // (1) Live rows: only the live branch may read live composed/cached values.
  // A live row with no cached title must never fall through to a cold cache
  // hint, which could expose stale persisted metadata.
  const coldRows: SessionSummary[] = []
  for (const row of deps.rows) {
    if (row.live) {
      const live = liveProjection(deps, projections, row.id)
      if (live !== undefined) result.set(row.id, live)
    } else {
      coldRows.push(row)
    }
  }
  if (coldRows.length === 0) return result

  // One roster snapshot shared by every cold row: legacy `code` data maps to
  // `ptc` only when the roster proves no real `code` preset exists.
  const rosterIds = await deps.rosterIds(signal)

  // (2) Zero-I/O cache hints. `title: null` means "no title yet" while an
  // unusable cached preset identity stays fail-closed; a cold cache miss does
  // not trigger a historical observation or a second raw-log read.
  for (const row of coldRows) {
    const header = deps.headerOf(row.id)
    const cached = header === undefined ? undefined : safeCachedSnapshot(cache, header)
    if (cached === undefined) continue
    const values = cached.values ?? {}
    if (typeof values.title === 'string') {
      result.set(row.id, { ...result.get(row.id), title: values.title })
    }
    if (typeof values.agentPreset === 'string') {
      try {
        const resolved = await resolveProjectedPresetId(values.agentPreset, rosterIds, presets)
        if (resolved !== undefined) {
          result.set(row.id, { ...result.get(row.id), preset: resolved })
        }
      } catch (error) {
        signal?.throwIfAborted()
        deps.diag?.info('session projection unavailable', {
          session: row.id,
          code: errorCodeOf(error),
          reason: safeErrorMessage(error),
        })
      }
    }
  }
  return result
}
