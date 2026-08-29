/**
 * One cold-session UI hydration path.
 *
 * The transcript and stats folders intentionally keep separate folds because
 * they own different projections, but a session bootstrap must create and
 * populate both together. Keeping that operation in one small adapter makes
 * it harder for a resume path to pre-fold the same event log and then hydrate
 * it again when the live surface is installed.
 * @module @xmoon76/dsh-pi-tui/session-ui-hydrate
 */

import { StatsFolder } from './stats.ts'
import { TranscriptFolder } from './transcript.ts'

type SessionEvents = Parameters<TranscriptFolder['apply']>[0]

/** The two incremental projections owned by one hydrated session surface. */
export interface HydratedSessionUi {
  readonly folder: TranscriptFolder
  readonly statsFolder: StatsFolder
  /** Wall time spent in each projection fold, for launch diagnostics. */
  readonly scanTimings: {
    readonly transcriptMs: number
    readonly statsMs: number
  }
}

/**
 * Hydrate the session-owned UI projections exactly once from one event log.
 * Later live events must be applied as one-event suffixes to the returned
 * folders; callers should not pre-fold the same log before calling this.
 */
export function hydrateSessionUi(events: SessionEvents): HydratedSessionUi {
  const transcriptStarted = performance.now()
  const folder = new TranscriptFolder()
  folder.hydrate(events)
  const transcriptMs = performance.now() - transcriptStarted
  const statsStarted = performance.now()
  const statsFolder = new StatsFolder()
  statsFolder.hydrate(events)
  const statsMs = performance.now() - statsStarted
  return {
    folder,
    statsFolder,
    scanTimings: { transcriptMs, statsMs },
  }
}
