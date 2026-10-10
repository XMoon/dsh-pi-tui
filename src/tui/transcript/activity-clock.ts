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
import { isSurfacedInteractionToolName } from '../../domain/transcript/semantics.ts'
import type { TranscriptMessage, TurnActivity } from '../../domain/transcript/types.ts'
import { summarizeWorkSpan } from './work-summary.ts'
import type { TranscriptStructureBlock, TranscriptWorkSpan } from './structure.ts'

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
  /** No following canonical block prevents liveness: every following block
   *  either provably became visible BEFORE this Activity started (a reordered
   *  row) or does not exist. A following block with no proven first-visible
   *  time DOES prevent it (it cannot be shown to precede the Activity). */
  readonly trailing: boolean
}

/** The finalized per-Activity clock handed to the Compact Activity card.
 *
 * `open`/`trailing` are part of the clock's OWN immutable identity (the same
 * snapshot as `startedAt`/`endedAt`): `isLive` reads THESE fields, never a
 * captured lifetime object, so a cached card can never keep a stale structural
 * fact. The volatile environment inputs stay providers, re-read per render. */
export interface ActivityClock {
  readonly startedAt: number
  readonly endedAt?: number
  /** No proven close boundary. */
  readonly open: boolean
  /** The span is the LAST canonical structural block of the window. */
  readonly trailing: boolean
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
 * Close precedence: the EARLIEST real boundary, which is either
 *   (a) the start of a human-interaction tool INSIDE the run (a RUNNING
 *       `ask_user_question` / `exit_plan_mode` is still a Process member — its
 *       active panel owns the UI — but the agent handed control to the human
 *       there, so the waiting time is never part of the Activity), or
 *   (b) the first FOLLOWING canonical block that provably became visible after
 *       this Activity started,
 * and finally the owning turn's `turn/end`. A proven member end is kept as the
 * consistency floor, so a boundary earlier than proven member evidence can
 * never make the duration shrink.
 *
 * The derivation is ORDER-TOLERANT for the boundary itself: cold hydration can
 * order a Conversation row after Process rows it chronologically preceded (the
 * live lane materializes the assistant row on its first visible chunk, the
 * durable settlement appends at its own event index). A row that provably
 * became visible BEFORE the Activity started does not close it, so the boundary
 * is read from the block's own time rather than from its physical position, and
 * one bounded pass collects those times for every span. A following block with
 * NO proven time (a local command card, a synthetic window summary) keeps the
 * span out of the live tail without closing it.
 *
 * The boundary is CAPPED by the owning turn's `turn/end`: an Activity can never
 * end after its turn, so a row of a later turn can never lengthen an
 * already-frozen Activity.
 *
 * KNOWN LIMIT (pinned by `test/activity-clock.test.ts` as a live/cold
 * differential): the canonical Work MEMBERSHIP (which Process rows share one
 * span) is decided by the fold's row ORDER, not by this clock. When cold
 * hydration appends a step's settlement AFTER that step's tool rows while its
 * first visible text preceded them, cold shows ONE Activity where the live fold
 * showed TWO; a raw-adjacent settled-read pair is moreover MERGED by the fold's
 * read grouping before any display rule could act. Converging that belongs to
 * the fold's display-order authority (the `convergeStepLaneOrder` mechanism plus
 * display-aware read grouping) and is tracked as a separate unit.
 * @param structure - the canonical structural blocks for one window.
 * @param turnActivities - the folded turn boundary facts of the SAME snapshot.
 */
export function resolveWorkLifetimes(
  structure: readonly TranscriptStructureBlock[],
  turnActivities: ReadonlyMap<number, TurnActivity>,
): ReadonlyMap<TranscriptMessage, WorkLifetime> {
  // ONE bounded pass collects every PROVEN first-visible boundary time and one
  // backward pass marks whether any FOLLOWING block lacks such a time (the tail
  // rule). Per-span work is then one binary search plus the row's own members —
  // the structure is never re-walked per Work (a 100-Work window costs 2 passes,
  // not 10k reads).
  const boundaryTimes: number[] = []
  const noTimeAfter = new Array<boolean>(structure.length + 1).fill(false)
  for (let index = structure.length - 1; index >= 0; index -= 1) {
    const at = boundaryTimeOf(structure[index]!)
    noTimeAfter[index] = noTimeAfter[index + 1]! || at === undefined
    if (at !== undefined) boundaryTimes.push(at)
  }
  boundaryTimes.sort((left, right) => left - right)
  const earliestBoundaryAfter = (startedAt: number): number | undefined => {
    let low = 0
    let high = boundaryTimes.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (boundaryTimes[middle]! <= startedAt) low = middle + 1
      else high = middle
    }
    return boundaryTimes[low]
  }
  const lifetimes = new Map<TranscriptMessage, WorkLifetime>()
  for (let index = 0; index < structure.length; index += 1) {
    const block = structure[index]
    if (block === undefined || block.kind !== 'work') continue
    const timing = summarizeWorkSpan(block.span).timing
    if (timing === undefined) continue
    const memberEnd = timing.endedAt
    const startedAt = timing.startedAt
    let boundary = interactionBoundaryOf(block.span)
    const following = earliestBoundaryAfter(startedAt)
    if (following !== undefined && (boundary === undefined || following < boundary)) boundary = following
    // The owning turn's end is a CAP, never a fallback: an Activity can never
    // end after its turn ended, and a row of a LATER turn (or a much later
    // prompt in the same window) must never lengthen an already-frozen
    // Activity.
    const turn = turnActivities.get(block.span.turn)
    const turnEnd = turn?.completed === true ? turn.endedAt : undefined
    if (turnEnd !== undefined) boundary = boundary === undefined ? turnEnd : Math.min(boundary, turnEnd)
    const endedAt = boundary === undefined
      ? undefined
      : memberEnd === undefined ? boundary : Math.max(boundary, memberEnd)
    lifetimes.set(block.span.owner, {
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      open: endedAt === undefined,
      trailing: !noTimeAfter[index + 1]!,
    })
  }
  return lifetimes
}

/** Finalize one Activity's clock: only an OPEN, TRAILING span of a live-tail
 * window whose displayed subject is running can be live. Everything else
 * renders from a proven end (or the conservative member fallback).
 *
 * The structural fields are SNAPSHOT into the clock (and therefore into the
 * component-cache signature); the two environment facts are PROVIDERS,
 * re-read on every render — never values captured once (see
 * {@link ActivityClock.isLive}). */
export function activityClockOf(
  lifetime: WorkLifetime,
  liveTail: () => boolean,
  subjectRunning: () => boolean,
): ActivityClock {
  const clock: ActivityClock = {
    startedAt: lifetime.startedAt,
    ...(lifetime.endedAt === undefined ? {} : { endedAt: lifetime.endedAt }),
    open: lifetime.open,
    trailing: lifetime.trailing,
    isLive: () => clock.open && clock.trailing && liveTail() && subjectRunning(),
  }
  return clock
}

/** The earliest start of a human-interaction tool INSIDE the run: the agent
 *  handed control to the human there, so the waiting time is never part of the
 *  Activity. The row is matched by NAME while running exactly like the fold's
 *  work accounting (`compactActionSourceOf` excludes it regardless of status),
 *  so the Activity freezes at the same instant whether the tool is still
 *  waiting (a Process member) or has settled (a following interaction card).
 *  A member's own start is never earlier than the span start (the span start IS
 *  the earliest member start), so no ordering guard applies: when the
 *  interaction is the Activity's FIRST and only member the hand-over IS the
 *  Activity, which closes it immediately and renders no duration. */
function interactionBoundaryOf(span: TranscriptWorkSpan): number | undefined {
  let earliest: number | undefined
  for (const member of span.members) {
    if (member.kind !== 'tool' || !isSurfacedInteractionToolName(member.name)) continue
    const at = transcriptTimingOf(member)?.startedAt
    if (at === undefined) continue
    if (earliest === undefined || at < earliest) earliest = at
  }
  return earliest
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
