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
 * The derivation is bounded and reuses ONE structure walk plus an exact
 * position/time-qualified lookup: two bounded passes over the canonical
 * structure, two sorts and one Fenwick (binary-indexed tree) query per Activity
 * — O(n log n) total, never a per-Activity re-walk of the window (the reads are
 * locked by a Proxy-count regression). A span's close boundary is the block that
 * actually FOLLOWS it, never a preview, a folded state or `workSpans.at(-1)`.
 * Boundary times are read from the row sidecars the fold records from
 * `SessionEvent.time` (a missing sidecar means UNKNOWN: the Activity stays open
 * and no end is synthesized).
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
   *  either does not exist, or provably became visible STRICTLY BEFORE this
   *  Activity started (a reordered row). A following block with no proven
   *  first-visible time DOES prevent it (it cannot be shown to precede the
   *  Activity), and a following block whose time EQUALS the Activity's start
   *  closes the Activity instead (`open` false, a point span that hides its
   *  duration) rather than being ignored here. */
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
 *   (b) the first canonical block POSITIONED AFTER this Activity that provably
 *       became visible after it started,
 * and finally the owning turn's `turn/end`. A proven member end is kept as the
 * consistency floor, so a boundary earlier than proven member evidence can
 * never make the duration shrink.
 *
 * The derivation is POSITION- AND TIME-QUALIFIED: a close boundary is a
 * boundary block POSITIONED AFTER the Activity whose own proven time is not
 * EARLIER than the Activity's start. A preceding row (a Context the Activity
 * started after) and a PROVABLY STRICTLY EARLIER reordered row therefore close
 * nothing; an equal-time following row, by contrast, is already visible and
 * closes the Activity from the same instant (a point span hides its duration —
 * a coarse clock must never leave it live). A following block with NO proven
 * time (a local command card, a synthetic window summary) keeps the span out of
 * the live tail without closing it. The lookup is an exact offline 2D
 * dominance-min, so no ordering assumption about the Activities' starts is
 * needed.
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
  const size = structure.length
  // PASS 1 — one bounded walk collects each block's proven first-visible
  // boundary time (a context cluster is walked once), the suffix fact "some
  // FOLLOWING block has no proven time" (the tail rule) and every Work span's
  // own inputs. The structure is never re-walked per Activity.
  interface SpanInput {
    readonly owner: TranscriptMessage
    readonly index: number
    readonly startedAt: number
    readonly memberEnd: number | undefined
    readonly turnEnd: number | undefined
    readonly interaction: number | undefined
  }
  const boundaryAt = new Array<number | undefined>(size)
  const noTimeAfter = new Array<boolean>(size + 1).fill(false)
  const spans: SpanInput[] = []
  for (let index = size - 1; index >= 0; index -= 1) {
    const block = structure[index]!
    const at = block.kind === 'work' ? undefined : boundaryTimeOf(block)
    boundaryAt[index] = at
    noTimeAfter[index] = noTimeAfter[index + 1]! || at === undefined
    if (block.kind !== 'work') continue
    const timing = summarizeWorkSpan(block.span).timing
    if (timing === undefined) continue
    const turn = turnActivities.get(block.span.turn)
    spans.push({
      owner: block.span.owner,
      index,
      startedAt: timing.startedAt,
      memberEnd: timing.endedAt,
      turnEnd: turn?.completed === true ? turn.endedAt : undefined,
      interaction: interactionBoundaryOf(block.span),
    })
  }

  // PASS 2 — the EXACT close boundary: the earliest proven time among the
  // boundary blocks POSITIONED AFTER the Activity whose own time is greater
  // than its start. A preceding row (a Context the Activity started after) or a
  // reordered row can never close it, and no ordering assumption about the
  // spans' starts is needed: this is an offline 2D dominance-min. Sweeping the
  // spans by DESCENDING start while inserting every qualifying boundary into a
  // Fenwick over reversed positions storing the insertion order means the
  // LARGEST insertion order inside a position range is the SMALLEST qualifying
  // time (all inserted entries already exceed the current start, and they were
  // inserted in descending time). Two sorts + one O(log n) query per Activity.
  const entries: { readonly position: number; readonly time: number }[] = []
  for (let index = 0; index < size; index += 1) {
    const at = boundaryAt[index]
    if (at !== undefined) entries.push({ position: index, time: at })
  }
  entries.sort((left, right) => right.time - left.time)
  const orderedSpans = [...spans].sort((left, right) => right.startedAt - left.startedAt)
  const bestOrder = new Int32Array(size + 1)
  const orderTime: number[] = []
  const insert = (position: number, order: number): void => {
    for (let slot = size - position; slot <= size; slot += slot & -slot) {
      if (order > bestOrder[slot]!) bestOrder[slot] = order
    }
  }
  const latestOrderAfter = (position: number): number => {
    let best = 0
    for (let slot = size - 1 - position; slot > 0; slot -= slot & -slot) {
      if (bestOrder[slot]! > best) best = bestOrder[slot]!
    }
    return best
  }
  const followingBoundary = new Map<number, number>()
  let cursor = 0
  let order = 0
  for (const span of orderedSpans) {
    // A following boundary closes the Activity from the SAME instant on: only a
    // row that is PROVABLY STRICTLY EARLIER (a reordered row that became visible
    // before the Activity started) may be ignored. Coarse clocks legitimately
    // stamp a whole step (reasoning, its block-end and the first visible text)
    // with one millisecond, and an equal-time Conversation is already visible —
    // the Activity must close there (a point span hides its duration) rather
    // than staying live.
    while (cursor < entries.length && entries[cursor]!.time >= span.startedAt) {
      order += 1
      insert(entries[cursor]!.position, order)
      orderTime[order] = entries[cursor]!.time
      cursor += 1
    }
    const best = latestOrderAfter(span.index)
    if (best > 0) followingBoundary.set(span.index, orderTime[best]!)
  }

  const lifetimes = new Map<TranscriptMessage, WorkLifetime>()
  for (const span of spans) {
    let boundary = span.interaction
    const following = followingBoundary.get(span.index)
    if (following !== undefined && (boundary === undefined || following < boundary)) boundary = following
    // The owning turn's end closes the Activity when nothing earlier did, and it
    // is ALSO the final CAP: a late member settlement (a pending tool card that
    // legitimately settles after its own turn ended) may extend the member's own
    // timing but never the Activity's lifetime.
    const candidate = boundary ?? span.turnEnd
    let endedAt = candidate === undefined
      ? undefined
      : span.memberEnd === undefined ? candidate : Math.max(candidate, span.memberEnd)
    if (endedAt !== undefined && span.turnEnd !== undefined) endedAt = Math.min(endedAt, span.turnEnd)
    lifetimes.set(span.owner, {
      startedAt: span.startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      open: endedAt === undefined,
      trailing: !noTimeAfter[span.index + 1]!,
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
