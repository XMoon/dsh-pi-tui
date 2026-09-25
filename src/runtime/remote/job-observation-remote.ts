/**
 * The experimental Remote selected-Job observation adapter (Pre-M3 PR2): the
 * semantic {@link JobObservationPort} over the official Client `IJobs`
 * service (`@deepseek-ai/dsh-api-job-controller/client`).
 *
 * The official `ClientJobs` owns every transport-shaped piece — reconnecting
 * roster/observation streams, the resume cursor, stream sharing by reference
 * count, gap handling, the bounded render tail and terminal stream lifecycle.
 * This adapter therefore owns NO follow/cursor/reconnect state machine and
 * never slices the tail again; it only projects the two official authorities
 * onto {@link JobObservedSnapshot}:
 *
 * - `state.rows[sessionId]`  -> kind / label / status / progress / detail
 * - `state.observed[jobId]`  -> text / gapBefore / streaming / error
 *
 * NOT composed into production: M3 owns Remote backend composition.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/job-observation-remote
 */

import type { JobObservationPort, JobObservedSnapshot } from '../job-observation-port.ts'

/** One official client-safe Job roster row (`JobView`) subset used here. */
export interface RemoteObservedJobRow {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
}

/** The official `ObservedJob` subset: the bounded tail and its stream facts. */
export interface RemoteObservedJobState {
  readonly jobId: string
  readonly text: string
  readonly gapBefore: boolean
  readonly streaming: boolean
  readonly error?: string
}

/** The official Client `IJobs` subset this adapter consumes. */
export interface RemoteJobObservationSource {
  readonly state: {
    getSnapshot(): {
      readonly rows: Readonly<Record<string, readonly RemoteObservedJobRow[]>>
      readonly observed: Readonly<Record<string, RemoteObservedJobState | undefined>>
    }
    subscribe(listener: () => void): () => void
  }
  /** Reference-counted roster watch for one session. */
  watchRows(sessionId: string): () => void
  /** Reference-counted observation for one job (undefined = unowned job). */
  observe(sessionId: string | undefined, jobId: string): () => void
}

/** The experimental Remote Job observation port over official `IJobs`. */
export class RemoteJobObservationPort implements JobObservationPort {
  private readonly jobs: RemoteJobObservationSource

  constructor(jobs: RemoteJobObservationSource) {
    this.jobs = jobs
  }

  open(
    sessionId: string | undefined,
    jobId: string,
    listener: (snapshot: JobObservedSnapshot) => void,
  ): () => void {
    const jobs = this.jobs
    let closed = false
    /** Every acquired lease, released exactly once by `close`. A synchronous
     * callback may close the observer while an acquisition is still in flight,
     * so an already-closed acquisition is released immediately. */
    const owned: Array<() => void> = []
    const own = (release: () => void): void => {
      if (closed) release()
      else owned.push(release)
    }
    /** The last roster row this observer saw: a roster that momentarily drops
     * the job must not blank the viewer's title/status metadata. */
    let lastRow: RemoteObservedJobRow | undefined

    const emit = (): void => {
      if (closed) return
      const snapshot = jobs.state.getSnapshot()
      const row = sessionId === undefined
        ? undefined
        : snapshot.rows[sessionId]?.find(candidate => candidate.id === jobId)
      if (row !== undefined) lastRow = row
      const observed = snapshot.observed[jobId]
      const progress = row?.progress ?? lastRow?.progress
      const detail = row?.detail ?? lastRow?.detail
      // An observation FAILURE is also `streaming: false`: settlement requires
      // both a terminal stream and no stream error.
      const settled = observed !== undefined && observed.streaming === false && observed.error === undefined
      listener(Object.freeze({
        jobId,
        kind: row?.kind ?? lastRow?.kind ?? '',
        label: row?.label ?? lastRow?.label ?? '',
        status: row?.status ?? lastRow?.status ?? 'running',
        ...(progress === undefined ? {} : { progress }),
        ...(detail === undefined ? {} : { detail }),
        text: observed?.text ?? '',
        gapBefore: observed?.gapBefore ?? false,
        settled,
        ...(observed?.error === undefined ? {} : { error: observed.error }),
      }))
    }

    own(jobs.state.subscribe(emit))
    if (!closed && sessionId !== undefined) own(jobs.watchRows(sessionId))
    if (!closed) own(jobs.observe(sessionId, jobId))
    // The official snapshot may already hold a row/tail before this observer
    // acquired either lease, so the first observation is emitted immediately.
    emit()

    return () => {
      if (closed) return
      closed = true
      for (const release of owned.splice(0)) release()
    }
  }
}
