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
 * 1. live session  → `sessionProjections.snapshot(...)` (in-memory, zero I/O);
 * 2. cold + cache  → `sessionProjectionCache.cachedSnapshot(header, keys)`
 *    (a durable checkpoint read keyed by the `list()` header identity — no
 *    full-log fold);
 * 3. cold + miss   → ONE `sessionQuery.observeSession(id, …)` per session,
 *    whose projection cut resolves BOTH title and agentPreset together
 *    (never two independent cold scans of the same log), then
 *    `observation[Symbol.dispose]()`.
 *
 * Everything is bounded (one worker pool per batch) and cancellable (an
 * aborted signal rejects the whole batch; per-row corruption is isolated
 * with a diagnostic instead of hiding the picker).
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-projection-direct
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { SessionProjectionSummary, SessionSummary } from '../session-reader-port.ts'
import { resolveProjectedPresetId } from './session-preset-direct.ts'

/** The projection keys this batch reads (the official registered units). */
type ProjectionKey = typeof agentPresetProjectionDefinition.key | 'title'

/** The official live projection read surface (structural subset of
 * `sessionProjections` — the value table carries both keys). */
export interface SessionProjectionReaderLike {
  snapshot(
    session: Session,
    keys?: readonly ProjectionKey[],
  ): { readonly asOfSeq: number; readonly values?: { readonly title?: string | null; readonly agentPreset?: string | null } } | undefined
}

/** The zero-I/O projection-cache hint (structural subset of
 * `sessionProjectionCache`). A row is possibly stale but never wrong; the
 * caller's `list()` header is the identity witness, so no log read and no
 * second corpus listing is needed. */
export interface SessionProjectionCacheLike {
  cachedSnapshot(
    meta: SessionHeader,
    keys?: readonly ProjectionKey[],
  ): { readonly asOfSeq: number; readonly values?: { readonly title?: string | null; readonly agentPreset?: string | null } } | undefined
}

/** The official observation lease (structural subset of `SessionObservation`,
 * widened to both projection values). */
export interface SessionObservationLike {
  readonly source: 'live' | 'prepared'
  readonly header: SessionHeader
  readonly projections?: { readonly values?: { readonly title?: string | null; readonly agentPreset?: string | null } }
  [Symbol.dispose](): void
}

/** The official observation seam (structural subset of `sessionQuery`). */
export interface SessionQueryObservationLike {
  observeSession(
    sessionId: SessionId,
    options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' },
  ): Promise<SessionObservationLike>
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

/** Keep cold-session projection observations below the persistence engine's
 * own small inspection batch size. This bounds log replay/FD/memory pressure
 * when the picker contains many historical sessions. ONE pool serves the
 * whole combined batch — never one per field. */
export const SESSION_PROJECTION_READ_CONCURRENCY = 4

/** Read a typed query-service error without depending on its package surface. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Read the projection-cache hint for one header WITHOUT letting a throwing
 * cache read escalate: the cache is derived data (DSH's own consumers do the
 * same), so damage falls through to the authoritative observation instead of
 * failing the row.
 */
function safeCachedSnapshot(
  cache: SessionProjectionCacheLike | undefined,
  header: SessionHeader,
): { readonly values?: { readonly title?: string | null; readonly agentPreset?: string | null } } | undefined {
  if (cache === undefined) return undefined
  try {
    return cache.cachedSnapshot(header, ['title', 'agentPreset'])
  } catch {
    return undefined
  }
}

/** The live fast path: title from the official projection snapshot over the
 * in-memory log (zero I/O), preset from the authoritative composed
 * composition. Absent/`null` title means the session genuinely has none. */
function liveProjection(
  deps: ProjectionBatchDeps,
  projections: SessionProjectionReaderLike | undefined,
  sessionId: string,
): SessionProjectionSummary | undefined {
  const preset = deps.livePresetOf(sessionId)
  const live = deps.liveAgentOf(sessionId)
  let title: string | undefined
  if (live !== undefined && projections !== undefined) {
    try {
      const values = projections.snapshot(live.session, ['title'])?.values
      if (typeof values?.title === 'string') title = values.title
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

/** Run one bounded worker pool over the batch's cold observations. Claims are
 * synchronous after the abort check, so a worker that observes cancellation
 * never starts another cold read. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      signal?.throwIfAborted()
      const index = next++
      if (index >= items.length) return
      results[index] = await map(items[index]!, index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()),
  )
  return results
}

/**
 * The combined projection batch (the port's `projectionBatch` semantics):
 * live fast path → zero-I/O cache fast path → at most ONE observation per
 * remaining cold row, whose cut resolves title AND agentPreset together.
 *
 * Per-row isolation: a corrupt/unsupported session is omitted (short-id /
 * preset-less presentation survives) with an info diagnostic carrying the
 * engine's code — never a fallback second raw-log read. Cancellation: an
 * aborted signal rejects the WHOLE batch as an AbortError (the detached
 * caller classifies it as a cancellation, not a failure).
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
  const query = deps.ctx.get('sessionQuery') as SessionQueryObservationLike | undefined
  const presets = deps.ctx.get('agentPresets') as PresetsServiceLike | undefined

  // (1) Live rows: the in-memory projection cut is authoritative and free.
  for (const row of deps.rows) {
    const live = liveProjection(deps, projections, row.id)
    if (live !== undefined) result.set(row.id, live)
  }

  const coldRows = deps.rows.filter(row => !result.has(row.id))
  if (coldRows.length === 0) return result

  // One roster snapshot shared by every cold row: legacy `code` data maps to
  // `ptc` only when the roster proves no real `code` preset exists.
  const rosterIds = await deps.rosterIds(signal)

  // (2) Zero-I/O cache hints. `title: null` IS a final answer ("no title
  // yet") while an unusable cached preset identity stays fail-closed (a
  // later selection may have landed after the checkpoint) — a `null`
  // agentPreset is NOT a usable identity.
  const misses: SessionSummary[] = []
  for (const row of coldRows) {
    const header = deps.headerOf(row.id)
    const cached = header === undefined ? undefined : safeCachedSnapshot(cache, header)
    let titleKnown = false
    let presetKnown = false
    if (cached !== undefined) {
      const values = cached.values ?? {}
      if ('title' in values) {
        titleKnown = true
        if (typeof values.title === 'string') {
          result.set(row.id, { ...result.get(row.id), title: values.title })
        }
      }
      if (typeof values.agentPreset === 'string') {
        // An identity that fails roster resolution is final for this batch:
        // the observation would return the same value and resolve the same
        // way, so spending a cold read on it would buy nothing.
        presetKnown = true
        const resolved = await resolveProjectedPresetId(values.agentPreset, rosterIds, presets)
        if (resolved !== undefined) {
          result.set(row.id, { ...result.get(row.id), preset: resolved })
        }
      }
    }
    if ((titleKnown && presetKnown) || query === undefined) continue
    misses.push(row)
  }
  // Without the observation seam there is nothing authoritative left to do:
  // partial cache hints stay as they are.
  if (query === undefined || misses.length === 0) return result

  // (3) ONE observation per cold miss — its projection cut resolves BOTH
  // fields, replacing any partial cached values with the fresher read.
  const values = await mapConcurrent(misses, SESSION_PROJECTION_READ_CONCURRENCY, async row => {
    try {
      const observation = await query.observeSession(SessionId(row.id), { signal, projectionMode: 'all' })
      try {
        const observed = observation.projections?.values ?? {}
        const title = typeof observed.title === 'string' ? observed.title : undefined
        const preset = await resolveProjectedPresetId(observed.agentPreset, rosterIds, presets)
        return { title, preset }
      } finally {
        observation[Symbol.dispose]()
      }
    } catch (error) {
      // Cancellation is the ONE error that outlives row isolation: re-checked
      // first so an aborted batch never degrades into per-row omissions.
      signal?.throwIfAborted()
      // Fail closed per row: a corrupt/unsupported log cannot invent a title
      // or an effective preset, but it must not hide other valid picker rows
      // either — and it never falls back to a second raw-log read.
      deps.diag?.info('session projection unavailable', {
        session: row.id,
        code: errorCodeOf(error),
        reason: safeErrorMessage(error),
      })
      return undefined
    }
  }, signal)
  signal?.throwIfAborted()
  for (let index = 0; index < misses.length; index += 1) {
    const value = values[index]
    if (value === undefined) continue
    const summary: SessionProjectionSummary = {
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(value.preset === undefined ? {} : { preset: value.preset }),
    }
    if (titleOrPreset(summary)) result.set(misses[index]!.id, summary)
  }
  return result
}

/** Whether a summary carries at least one usable field (an all-empty summary
 * is an omission, not an enrichment). */
function titleOrPreset(summary: SessionProjectionSummary): boolean {
  return summary.title !== undefined || summary.preset !== undefined
}
