/**
 * The application Task-source bridge (TS2 §9): branch composition for the Task
 * Center SEMANTIC read sources.
 *
 * Direct composes the Host catalog/registry reads through `DirectTaskReader`;
 * Remote composes the official Client projection / Session-list reads from the
 * ONE Remote application graph. Neither branch is a second task model — both
 * satisfy the same semantic Task read port.
 *
 * It owns NO Task Center UI/state (`TaskBrowserRuntime`, task rows, Job viewer
 * selection, task refresh state, question attention stay in `app/surface`), and
 * it resolves no Host service: the composition root passes the already-resolved
 * `jobs`/`subagents` values and the narrow Direct-Agent reads.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/task-source
 */

import {
  DirectTaskReader,
  type DirectTaskAgent,
  type DirectTaskReadSource,
} from '../../runtime/direct/task-read-direct.ts'
import type { TaskSurfaceRead } from '../surface/runtime.ts'
import type { RemoteApplicationSources } from '../application-runtime.ts'

/** The narrow values the Task-source bridge composes; one cohesive lifetime. */
export interface TaskSourceDeps {
  /** The Remote-branch Task sources (undefined on Direct). */
  readonly remoteSources: RemoteApplicationSources | undefined
  /** Official recursive descendant listing (Direct; undefined without the service). */
  readonly subagents: DirectTaskReadSource['subagents'] | undefined
  /** Status-only job snapshots owned by the parent session (Direct; optional service). */
  readonly jobs: DirectTaskReadSource['jobs'] | undefined
  /** The live Direct Agent registry read (the Direct activity projection). */
  readonly agents: { get(sessionId: string): DirectTaskAgent | undefined }
  /** The current owner's session id (the ownership core's authority). */
  readonly currentSessionId: () => string | undefined
  /** The ownership generation (the Task read key's currentness half). */
  readonly generation: () => number
  /** The cleaned-up latch read (a retired runner owns no Task read key). */
  readonly isCleanedUp: () => boolean
  /** The current owner's exact Direct session id (the Direct readTask address). */
  readonly currentDirectSessionId: () => string | undefined
}

/** The composition-facing Task read the root hands to the surface owner. */
export interface TaskSource {
  readonly taskRead: TaskSurfaceRead | undefined
}

/**
 * Compose the branch-selected Task read source. The factory is pure
 * composition: it constructs one `DirectTaskReader` on the Direct branch (the
 * sanctioned composition zone) and returns the narrow semantic read.
 */
export function createTaskSource(deps: TaskSourceDeps): TaskSource {
  const {
    remoteSources,
    subagents,
    jobs,
    agents,
    currentSessionId,
    generation,
    isCleanedUp,
    currentDirectSessionId,
  } = deps

  // The selected Task read source: Direct composes the Host catalog/registry
  // reads; Remote composes the official Client projection/Session-list reads
  // from the ONE Remote application graph. Neither branch is a second task
  // model — both satisfy the same semantic Task read port. The Direct jobs
  // half is optional service-wise (a composition without the jobs service has
  // no roster, exactly as before).
  const directTaskReader = remoteSources !== undefined || subagents === undefined
    ? undefined
    : new DirectTaskReader({
      agentFor: (sessionId) => agents.get(sessionId),
      subagents,
      jobs: { list: (caller) => jobs?.list(caller) ?? [] },
    })
  const taskReadKey = (): string | undefined => {
    const sessionId = currentSessionId()
    return isCleanedUp() || sessionId === undefined ? undefined : `${generation()}:${sessionId}`
  }
  const taskRead: TaskSurfaceRead | undefined = remoteSources === undefined
    ? directTaskReader === undefined ? undefined : {
      currentKey: taskReadKey,
      currentSessionId,
      // The Direct Task read is addressed by the live owner Agent (the
      // semantic read's availability rule is the Direct attachment).
      readTask: () => {
        const sessionId = currentDirectSessionId()
        return sessionId === undefined
          ? Promise.resolve(undefined)
          : directTaskReader.readDescendants(sessionId)
      },
      // The LIVE Direct runtime fact, read at COMMIT time: the Agent
      // registry, never the catalog's store-presence activity.
      activityOf: (childId) => agents.get(childId)?.status,
    }
    : {
      currentKey: taskReadKey,
      currentSessionId,
      readTask: () => {
        const sessionId = currentSessionId()
        return sessionId === undefined
          ? Promise.resolve(undefined)
          : remoteSources.task.readDescendants(sessionId)
      },
      // The official Client current-activity fact, read at COMMIT time from
      // the Session LIST (no descendant binding is borrowed or retained) —
      // never the durable catalog presence.
      activityOf: (childId) => remoteSources.task.activityOf(childId),
    }

  return { taskRead }
}
