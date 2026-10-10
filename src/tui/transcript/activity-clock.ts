/**
 * The ONE Activity (Work span) LIFETIME derivation.
 *
 * A {@link TranscriptWorkSpan} is a presentation-only contiguous Process run
 * (`structure.ts`). Its MEMBER timing (`TranscriptTiming` sidecars, aggregated
 * by `summarizeWorkSpan`) ends when the last member settles — but the Activity
 * the user sees is the wall-clock span of the Process work, which continues
 * through the model's silent wait until the next REAL structural boundary: the
 * first actually visible non-Process row (Conversation / Context / settled
 * interaction) or the owning turn's `turn/end`. The two facts are deliberately
 * separate: this module answers only "when did this Activity start, and has a
 * boundary closed it?" — the members' own timing sidecars stay the authority
 * for Think/Tool rows and for the conservative fallback below.
 *
 * The derivation is a single forward pass over the canonical structure, so a
 * span's successor is the block that ACTUALLY follows it — never a preview, a
 * folded state or `workSpans.at(-1)`. Boundary times are read from the row
 * sidecars the fold records from `SessionEvent.time` (a missing sidecar means
 * UNKNOWN: the Activity stays open and no end is synthesized).
 *
 * `ActivityClock` is the small per-card projection TuiApp finalizes from a
 * lifetime plus the CURRENT display-subject activity: `isLive` is the only live
 * fact (the duration then re-reads the wall clock every frame, so the existing
 * WorkingIndicator repaint keeps it moving — no per-card timer).
 *
 * The result is keyed by the span's OWNER message, the same stable identity
 * `workComponents` uses: a render projection (`projectCompact`) re-runs
 * `projectTranscriptStructure` and therefore allocates FRESH span wrappers over
 * the same member objects, so a span-keyed lookup would miss exactly where the
 * clock is consumed.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/activity-clock
 */

import { transcriptTimingOf } from '../../domain/transcript/folder.ts'
import type { TranscriptMessage, TurnActivity } from '../../domain/transcript/types.ts'
import { summarizeWorkSpan } from './work-summary.ts'
import type { TranscriptStructureBlock } from './structure.ts'

/** One Activity's structural lifetime: its proven start, a PROVEN close
 *  boundary (absent while the Activity is still open) and whether the span is
 *  the canonical structure's TRAILING block (the only position from which a
 *  still-open Activity can be live at all). */
export interface WorkLifetime {
  readonly startedAt: number
  /** A proven close: the successor boundary's first-visible time, or the
   *  owning turn's `turn/end` when no such boundary time exists. */
  readonly endedAt?: number
  /** No proven close boundary yet. */
  readonly open: boolean
  /** This span is the LAST canonical structural block of the window. */
  readonly trailing: boolean
}

/** The finalized per-Activity clock handed to the Compact Activity card. */
export interface ActivityClock {
  readonly startedAt: number
  readonly endedAt?: number
  /** Whether the span is provably still executing. This is a RENDER-TIME
   *  predicate, never a latched boolean: plan §5.3 requires the live gating to
   *  read the CURRENT committed display subject, so a Remote snapshot-only
   *  activity flip starts/stops the count even though the transcript was never
   *  re-committed (a frozen `true` would keep extending an Activity forever,
   *  a frozen `false` would never start it). */
  readonly isLive: () => boolean
}

/**
 * Derive every Work span's lifetime from the canonical structure. Spans with
 * no reliable member start produce NO entry (unknown is omitted, never `0s`).
 *
 * Close precedence: the successor block's first-actually-visible time first
 * (the plan's §5.2 rule: a late durable settlement time must never be mistaken
 * for the boundary, and an EARLIER one — a reordered row — proves no close at
 * all), then the owning turn's `turn/end`. A proven member end is kept as the
 * consistency floor, so a boundary earlier than proven member evidence can
 * never make the duration shrink.
 * @param structure - the canonical structural blocks for one window.
 * @param turnActivities - the folded turn boundary facts of the SAME snapshot.
 */
export function resolveWorkLifetimes(
  structure: readonly TranscriptStructureBlock[],
  turnActivities: ReadonlyMap<number, TurnActivity>,
): ReadonlyMap<TranscriptMessage, WorkLifetime> {
  const lifetimes = new Map<TranscriptMessage, WorkLifetime>()
  for (let index = 0; index < structure.length; index += 1) {
    const block = structure[index]
    if (block === undefined || block.kind !== 'work') continue
    const timing = summarizeWorkSpan(block.span).timing
    if (timing === undefined) continue
    const memberEnd = timing.endedAt
    const successor = structure[index + 1]
    const boundary = successor === undefined ? undefined : boundaryTimeOf(successor)
    // A successor proves that THIS Activity closed only when its own
    // first-visible evidence lies AFTER the Activity started. Cold hydration
    // can order a Conversation row after Process rows it chronologically
    // preceded (the live lane materializes the assistant row on its first
    // visible chunk, the durable settlement appends at its own event index), so
    // an early time proves nothing about this span — reading it as an end
    // could even fabricate a `0s` for a still-running member. Such a span is
    // left OPEN but, because a canonical block still follows it, it is NOT
    // live: it renders the conservative member evidence (documented
    // limitation: live/cold can differ for that reordered shape until the fold
    // row order converges).
    const provenBoundary = boundary !== undefined && boundary > timing.startedAt ? boundary : undefined
    let endedAt: number | undefined
    if (provenBoundary !== undefined) {
      endedAt = memberEnd === undefined ? provenBoundary : Math.max(provenBoundary, memberEnd)
    } else {
      const turn = turnActivities.get(block.span.turn)
      if (turn?.completed === true && turn.endedAt !== undefined) {
        endedAt = memberEnd === undefined ? turn.endedAt : Math.max(turn.endedAt, memberEnd)
      }
    }
    lifetimes.set(block.span.owner, {
      startedAt: timing.startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      open: endedAt === undefined,
      trailing: index === structure.length - 1,
    })
  }
  return lifetimes
}

/** Finalize one Activity's clock: only an OPEN, TRAILING span of a live-tail
 * window whose displayed subject is running can be live. Everything else
 * renders from a proven end (or the conservative member fallback). The two
 * environment facts are PROVIDERS, re-read on every render — never values
 * captured once (see {@link ActivityClock.isLive}). */
export function activityClockOf(
  lifetime: WorkLifetime,
  liveTail: () => boolean,
  subjectRunning: () => boolean,
): ActivityClock {
  return {
    startedAt: lifetime.startedAt,
    ...(lifetime.endedAt === undefined ? {} : { endedAt: lifetime.endedAt }),
    isLive: () => lifetime.open && lifetime.trailing && liveTail() && subjectRunning(),
  }
}

/** The first ACTUALLY VISIBLE time of one non-Process boundary block: the
 *  earliest reliable sidecar start among the row(s) that carry the boundary.
 *  `undefined` means the block has no provable first-visible evidence (a
 *  synthetic window summary, a command row, a row the fold could not time) —
 *  the Activity then stays open rather than freezing at a fabricated time. */
function boundaryTimeOf(block: TranscriptStructureBlock): number | undefined {
  if (block.kind === 'message') return transcriptTimingOf(block.message)?.startedAt
  if (block.kind === 'context-cluster') {
    let earliest: number | undefined
    for (const member of block.cluster.members) {
      const at = transcriptTimingOf(member)?.startedAt
      if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at
    }
    return earliest
  }
  return undefined
}
