/**
 * Surface-owned compaction/context presentation folds (A4-7, plan §16).
 *
 * These are the PURE presentation folds the `session/event` routing applies:
 * compaction lifecycle pairing, the matched-settle surface effects, the
 * turn-boundary busy rule and the context re-measure classification. They read
 * no Host identity and no persistence, so they belong to the surface routing
 * owner (the boundary test: they only decide WHICH presentation view updates
 * and WHEN it repaints).
 *
 * `src/index.ts` re-exports them unchanged to keep the public entry point
 * byte-compatible (the published package and the regression suites import them
 * from the package root).
 *
 * @module app/surface/presentation-folds
 */

import type { CompactionPhase } from '../../tui-app.ts'

/** One fold of a compaction lifecycle event over the in-flight compaction
 * state. Pure (the routing applies the returned surface effects):
 * dsh-compaction is not a peer, so the event is read structurally. */
export interface CompactionFold {
  /** The updated in-flight compaction id (the newest start wins). */
  id: string | undefined
  /** compaction/start: the compacting flag turns ON (footer/working row). */
  active: boolean
  /** A MATCHED compaction/end: the compacting flag turns OFF and busy is
   * re-derived from the turn log (a stale end never clears a newer
   * compaction's state). */
  clear: boolean
  /** The compaction phase the event implies: compaction/start →
   * 'summarizing', a MATCHED compaction/summary → 'applying'. Undefined
   * when the event does not advance the phase (a stale summary, any
   * compaction/end — the settle clears via {@link clear}). */
  phase?: Exclude<CompactionPhase, 'idle'>
  /** The settle notification for compaction/end, when one fires. */
  notify: { text: string; kind: 'info' | 'error' } | undefined
}

/** Fold one compaction lifecycle event over the in-flight state. */
export function foldCompactionEvent(
  state: { id: string | undefined },
  event: { type: string; data: { compactionId?: unknown; error?: unknown } },
): CompactionFold {
  if (event.type === 'compaction/start') {
    return {
      id: typeof event.data.compactionId === 'string' ? event.data.compactionId : undefined,
      active: true,
      clear: false,
      phase: 'summarizing',
      notify: undefined,
    }
  }
  if (event.type === 'compaction/summary') {
    // ONLY a summary matching the in-flight compaction advances the phase
    // to 'applying': a stale summary (another compaction's, or an id-less
    // orphan) must not flip the label while the current compaction is
    // still summarizing.
    const matched = typeof event.data.compactionId === 'string' && event.data.compactionId === state.id
    return {
      id: state.id,
      active: false,
      clear: false,
      phase: matched ? 'applying' : undefined,
      notify: undefined,
    }
  }
  if (event.type === 'compaction/end') {
    const error = typeof event.data.error === 'string' && event.data.error !== '' ? event.data.error : undefined
    // ONLY an end whose id matches the in-flight compaction settles it:
    // a stale end (another compaction's, or an id-less orphan from a
    // foreign/corrupt log) must neither clear the state nor notify.
    const matched = typeof event.data.compactionId === 'string' && event.data.compactionId === state.id
    return {
      id: matched ? undefined : state.id,
      active: false,
      clear: matched,
      notify: matched
        ? {
          text: error === undefined ? 'Context compacted' : `Compaction failed: ${error}`,
          kind: error === undefined ? 'info' : 'error',
        }
        : undefined,
    }
  }
  return { id: state.id, active: false, clear: false, notify: undefined }
}

/** The minimal compaction-settle surface the routing passes in — STRUCTURAL
 * on purpose: referencing the full {@link TuiApp} class from a public
 * export would inline the whole surface (and its internal registry/
 * presentation dependencies) into the published declaration bundle. The
 * settle contract only needs the three phase/busy/working setters. */
export interface CompactionSettleSurface {
  setCompactionPhase(phase: 'idle'): void
  setBusy(busy: boolean): void
  setWorking(busy: boolean): void
}

/** The UI side effects of a MATCHED compaction settle: clear the phase,
 * hand the working row back to the turn state, and re-measure the session
 * surface so the footer context reflects the compacted log IMMEDIATELY —
 * the next step/start or turn/end would otherwise delay the refresh.
 * Exported as a seam so the settle contract is testable without a full
 * runner driver (the firehose closure is not). */
export function settleCompactionSurface(
  app: CompactionSettleSurface,
  refreshStatus: () => void,
  busyNow: boolean,
): void {
  app.setCompactionPhase('idle')
  app.setBusy(busyNow)
  app.setWorking(busyNow)
  refreshStatus()
}

/** The busy flag after a turn-boundary event: a turn end must NOT clear
 * the busy state while a compaction is still in flight — an interrupted
 * turn can close (turn/end) before its compaction settles, and the
 * single-Esc cancel must stay armed until compaction/end. */
export function busyAfterTurnBoundary(eventType: 'turn/start' | 'turn/end', compacting: boolean): boolean {
  return eventType === 'turn/start' || compacting
}

/** PR D2 test seam: whether a session event type marks the model-visible
 * context dirty (re-measure through the SessionReader port) or only
 * repaints cheaply (cached measurement). The firehose routes every event
 * through this classification — the single source of truth for the
 * status/measurement split. `compaction/end` is classified 'measure' but
 * the firehose deliberately SKIPS it here: a matched compaction settle
 * re-measures through the fold-outcome path (settleCompactionSurface), so
 * a STALE compaction/end can never trigger a measurement. */
export function contextRefreshKind(eventType: string): 'measure' | 'cheap' {
  switch (eventType) {
    case 'step/start':
    case 'turn/end':
    case 'compaction/end':
      return 'measure'
    default:
      return 'cheap'
  }
}
