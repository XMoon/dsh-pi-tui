/**
 * Direct child-view source (M3-5 PR2, plan D1): the Direct implementation of the
 * viewer's {@link ViewerChildSource}. It composes ONLY existing in-process read
 * services — the live Session store, the semantic cold observation, the Agent
 * registry and the live assistant-stream baseline — so the ONE viewer state
 * machine keeps its exact Direct behavior after the selected-source cutover.
 *
 * Direct has no per-child reference lifetime: the Host Session store already
 * owns the attachment map. The handle therefore releases nothing, subscribes to
 * nothing (the Host firehose routes the viewed child through
 * `viewedChildId`), and pages nothing (the fold already holds the full log).
 * @module @xmoon76/dsh-pi-tui/app/direct/child-view
 */

import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type {
  ViewerChildOpenTarget,
  ViewerChildSnapshot,
  ViewerChildSource,
  ViewerChildView,
  ViewerQueueSubject,
} from '../surface/viewer-runtime.ts'
import type { SessionPresentationEvent } from '../surface/session-presentation.ts'

/** One live child Session as the Direct source reads it (official Session log). */
export interface DirectChildSession<Event> {
  readonly header: { readonly cwd?: unknown }
  snapshotEvents(): readonly Event[]
}

/** One semantic cold-session observation of a Direct child, caller-owned. */
export interface DirectChildObservation<Event> {
  readonly events: readonly Event[]
  readonly header: { readonly cwd?: unknown }
  [Symbol.dispose](): void
}

/** The child's live driver status (the Direct Agent registry). */
export interface DirectChildAgent {
  readonly status: string
  readonly session: {
    readonly id: string
    readonly header: { readonly parentSession?: string }
  }
}

/** The in-process reads the Direct child-view source composes. */
export interface DirectChildViewDeps<Event> {
  /** The live child Session, or `undefined` when it is not mounted. */
  childSession(childId: string): DirectChildSession<Event> | undefined
  /** The semantic cold observation seam (absent = no seam). */
  observeChild(childId: string): Promise<DirectChildObservation<Event>> | undefined
  /** The exact live child Agent, or `undefined` when not mounted. */
  childAgent(childId: string): DirectChildAgent | undefined
  /** The live assistant-stream baseline of one exact Agent. */
  assistantStreamBaselineFor(agent: DirectChildAgent): readonly AssistantLiveInput[]
}

/**
 * The Direct child view: the live/cold Session read plus the child's own
 * activity. `snapshot.durableEvents` is the observation cut the viewer merges
 * with its opening-event buffer.
 */
export function createDirectChildViewSource<Event extends SessionPresentationEvent>(
  deps: DirectChildViewDeps<Event>,
): ViewerChildSource<Event> {
  return {
    async open(target: ViewerChildOpenTarget): Promise<ViewerChildView<Event> | undefined> {
      const childId = target.childSessionId
      const initial = deps.childSession(childId)
      let observedEvents: readonly Event[] = initial?.snapshotEvents() ?? []
      let observedHeader: { readonly cwd?: unknown } | undefined = initial?.header
      if (initial === undefined) {
        // An inactive child is no longer in the live store; load its log
        // through the semantic session-query seam.
        const observation = await deps.observeChild(childId)
        if (observation !== undefined) {
          try {
            observedEvents = observation.events
            observedHeader = observation.header
          } finally {
            observation[Symbol.dispose]()
          }
        }
      }
      if (target.signal.aborted) return undefined
      // If the child cold-resumed while observation was in flight, its live
      // Session snapshot is the authoritative durable cut.
      const current = deps.childSession(childId)
      const agent = deps.childAgent(childId)
      const durableEvents = current?.snapshotEvents() ?? observedEvents
      const header = current?.header ?? observedHeader
      let activity: 'running' | 'inactive' = agent === undefined
        ? target.activity
        : agent.status === 'running' ? 'running' : 'inactive'
      if (agent === undefined) {
        for (const event of durableEvents) {
          if (event.type === 'turn/start') activity = 'running'
          else if (event.type === 'turn/end') activity = 'inactive'
        }
      }
      const snapshot: ViewerChildSnapshot<Event> = {
        durableEvents,
        liveInputs: agent === undefined ? [] : deps.assistantStreamBaselineFor(agent),
        activity,
        cwd: typeof header?.cwd === 'string' ? header.cwd : '',
        revision: undefined,
      }
      let released = false
      return {
        childSessionId: childId,
        parentSessionId: target.parentSessionId,
        snapshot,
        ...(agent === undefined ? {} : { viewAgent: agent }),
        // Direct folds the COMPLETE log: there is no bounded window to re-read,
        // so a re-hydrate is a no-op and never a deprecated live read.
        async rehydrate(): Promise<ViewerChildSnapshot<Event> | undefined> {
          return undefined
        },
        // Direct folds the COMPLETE log: there is no older page to load.
        async loadOlder(): Promise<void> {},
        currentActivity: (): 'running' | 'inactive' =>
          deps.childAgent(childId)?.status === 'running' ? 'running' : 'inactive',
        // The Host firehose routes the viewed child; no per-child subscription.
        subscribe: () => undefined,
        release: (): void => {
          if (released) return
          released = true
        },
      }
    },
    childWriterSubject(childId: string): ViewerQueueSubject | undefined {
      const agent = deps.childAgent(childId)
      return agent as ViewerQueueSubject | undefined
    },
  }
}
