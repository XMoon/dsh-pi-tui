/**
 * Renderer-neutral Compact Activity span summary.
 *
 * One Activity span is the user-visible identity of a presentation-only
 * contiguous Process run (see `structure.ts`): the INTERNAL owner kind stays
 * `work` (`TranscriptWorkSpan`), while the USER-VISIBLE container name is
 * `Activity` (post-F6 plan §3.3/§6.1 — no internal rename). This module derives
 * the span's OWN aggregate facts in ONE member walk — the shared Action stats,
 * the latest reasoning tail, the latest meaningful Action by chronology and the
 * span-local wall-clock timing — never the whole turn's `TurnActivity` counts
 * (the span is not the turn).
 *
 * It is deliberately width/component/theme-free: the collapsed card, its width
 * degradation ladder and the `Thought` identity belong to
 * `tui/components/transcript/compact-work.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/work-summary
 */

import { type TranscriptWorkSpan } from './structure.ts'
import {
  addCompactActionStats,
  compactActionSourceOf,
  newCompactActionStats,
  type CompactActionSource,
  type CompactActionStats,
} from './process-summary.ts'
import { transcriptTimingOf } from '../../domain/transcript/folder.ts'
import { THINKING_TAIL_CAP, type TranscriptTiming } from '../../domain/transcript/types.ts'

/** The span-local aggregate facts the collapsed Activity card renders. */
export interface CompactWorkSummary {
  /** The span's shared Action stats (addendum v2 §22/§23): genuine
   * `tool/call` cardinality by `callCount`, plus one per retry occurrence —
   * aggregated in the SAME single member walk, with the same authority the
   * Focus header uses. An orphan result adds nothing, and neither a command
   * row nor a subagent descriptor (child identity metadata) is ever a
   * member. */
  readonly actionStats: CompactActionStats
  /** The latest reasoning member's bounded tail + live lifecycle fact. */
  readonly think?: { readonly text: string; readonly running: boolean }
  /** The LATEST eligible non-Thinking Process evidence of the span — the
   * presentation-only collapsed Action source (addendum v2 §23).
   * Chronology owns selection: a chronologically-later retry overwrites an
   * earlier genuine tool without touching the stats. */
  readonly action?: CompactActionSource
  /** The span-local wall-clock span of the members' OWN timed Process
   * evidence (post-F6 plan §12.12) — absent when no member carries
   * reliable timing (unknown is omitted, never `0s`). */
  readonly timing?: TranscriptTiming
}

/**
 * Derive one Activity span's aggregate facts from its own members, in raw
 * order. The LAST reasoning member owns the Think slot; the LAST eligible
 * non-Thinking Process member owns the presentation-only Action slot
 * (addendum v2 §23 — chronology decides, never a per-type
 * priority). The Action stats and the Action winner come from the ONE
 * shared classifier in the SAME single walk (addendum v2 §23): a genuine
 * tool contributes its `callCount` (a merged read group of two reads is
 * TWO actions), a retry row contributes one action of its own subtype, an
 * orphan result contributes nothing, and
 * a surfaced-interaction tool (question / Plan review) contributes and
 * presents nothing (its interaction surface owns it). Timing aggregates the
 * members' OWN sidecar evidence in the same walk — earliest start, latest
 * end, any running — never a second scan (post-F6 plan §12.12).
 * @param span - the presentation-only Activity (Work) span.
 */
export function summarizeWorkSpan(span: TranscriptWorkSpan): CompactWorkSummary {
  const actionStats = newCompactActionStats()
  let think: CompactWorkSummary['think']
  let action: CompactActionSource | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  let running = false
  for (const member of span.members) {
    // Span-local wall timing from the member's OWN sidecar evidence
    // (post-F6 plan §12.2/§12.12): point rows simply have
    // start === end; members without evidence contribute nothing.
    const memberTiming = transcriptTimingOf(member)
    if (memberTiming !== undefined) {
      startedAt = startedAt === undefined ? memberTiming.startedAt : Math.min(startedAt, memberTiming.startedAt)
      if (memberTiming.endedAt !== undefined) {
        endedAt = endedAt === undefined ? memberTiming.endedAt : Math.max(endedAt, memberTiming.endedAt)
      }
      running = running || memberTiming.running
    }
    if (member.kind === 'thinking') {
      // The preview carries the BOUNDED tail only (post-F6 plan §8.3/§20):
      // the summary — and therefore the component-cache signature — must
      // never hold (or re-hash) the full ever-growing reasoning body.
      think = {
        text: member.text.length > THINKING_TAIL_CAP ? member.text.slice(-THINKING_TAIL_CAP) : member.text,
        running: member.running === true,
      }
      continue
    }
    // One shared classifier serves the stats cardinality AND the Action
    // slot (addendum v2 §8/§23): `tool` kinds are exactly the
    // genuine-call rows, and every other eligible kind (retry / orphan)
    // carries its own subtype. A subagent descriptor and a command row are
    // excluded by the classifier entirely.
    const source = compactActionSourceOf(member)
    if (source === undefined) continue
    addCompactActionStats(actionStats, source)
    action = source
  }
  return {
    actionStats,
    ...think === undefined ? {} : { think },
    ...action === undefined ? {} : { action },
    ...(startedAt === undefined ? {} : {
      timing: {
        startedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
        running,
      },
    }),
  }
}
