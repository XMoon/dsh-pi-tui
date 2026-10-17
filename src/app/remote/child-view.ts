/**
 * Remote child-view source (M3-5 PR2, plan D4/D5/D6): the Remote implementation
 * of the viewer's {@link ViewerChildSource}. It owns ONE explicit `tuiChildView`
 * Client Session reference per viewer session, acquired from the exact durable
 * `SubagentAddress` the Task row carries — never by plain id, never a Host
 * Agent. The retained generation is the lifetime authority for the child's
 * transcript, live ingress, paging and durable image reads.
 *
 * Composition reuses the ONE existing Remote graph: the shared
 * `PresentationReader`, the shared `RemoteLiveIngress` factory and the official
 * Session/attachment faces. No child-specific transport, transcript store or
 * status cache exists here.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/child-view
 */

import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { PresentationReadSnapshot } from '../../runtime/presentation-read-port.ts'
import type {
  RemoteRetainSource,
  RemoteSubagentViewAddress,
} from '../../runtime/remote/session-reference.ts'
import { acquireChildViewReference } from '../../runtime/remote/session-reference.ts'
import type {
  ViewerChildLiveSinks,
  ViewerChildOpenTarget,
  ViewerChildSnapshot,
  ViewerChildSource,
  ViewerChildView,
} from '../surface/viewer-runtime.ts'
import type { RemoteConnectionGenerationSource } from '../../runtime/remote/session-reader-remote.ts'
import type { RemoteLiveIngress, RemoteLiveIngressHandle } from './live-ingress.ts'

/** The official attachment read result (structural `RemoteResult`). */
export type RemoteAttachmentReadResult =
  | { readonly ok: true; readonly value: { readonly attachment: unknown; readonly data: Uint8Array } }
  | { readonly ok: false; readonly error: unknown }

/** One retained Client binding as the child view reads it: the official
 *  `running`/`openState`/`openError` facts and the authenticated attachment read
 *  of THIS Session. */
export interface RemoteChildBinding {
  readonly session: {
    getSnapshot(): {
      readonly running: boolean
      /** The official open state. `'error'` means the shared open attempt
       *  FAILED: the official `Session.doOpen` records it and RESOLVES the
       *  returned promise, so `reference.ready` cannot be the only failure
       *  signal. */
      readonly openState?: 'cold' | 'loading' | 'open' | 'error'
      /** The official failure the Client recorded for `openState: 'error'`. */
      readonly openError?: unknown
    }
    readAttachment(attachmentId: string): Promise<RemoteAttachmentReadResult>
  }
  /** The official event window source (S3-R0: the child re-fold fence must
   *  prove its read is still the CURRENT revision before it commits). */
  readonly eventSource?: {
    getSnapshot(): { readonly revision: number }
  }
}

/** Structural subset of official `ClientSessions` (retain + borrow). */
export interface RemoteChildViewSessions extends RemoteRetainSource {
  binding(id: string): RemoteChildBinding | undefined
}

/** Inputs for the Remote child-view source. */
export interface RemoteChildViewSourceOptions<Event> {
  readonly sessions: RemoteChildViewSessions
  /** The ONE shared presentation reader (never a second adapter). */
  readonly reader: {
    read(sessionId: string, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
    loadOlder(sessionId: string, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
  }
  /** The ONE shared live-ingress factory. */
  readonly liveIngress: RemoteLiveIngress
  /** The official Connection generation source (S3-R0 child re-fold fence). */
  readonly generation: RemoteConnectionGenerationSource
  /** The official child Session's own workspace, or '' when unavailable. */
  readonly childCwd: (childSessionId: string) => string
  /** The cast at the composition seam: the wire event satisfies the TUI's
   *  structural presentation event. */
  readonly asEvent: (event: unknown) => Event
}

function childActivity(binding: RemoteChildBinding | undefined): 'running' | 'inactive' {
  return binding?.session.getSnapshot().running === true ? 'running' : 'inactive'
}

/** Whether one binding's official Session is fully open (`openState` absent
 *  means the structural double does not model the official state). */
function isOpen(binding: RemoteChildBinding): boolean {
  const state = binding.session.getSnapshot().openState
  return state === undefined || state === 'open'
}

/** The visible failure for one un-openable child: the OFFICIAL recorded error
 *  when the Client kept one, else a truthful description of the open state. An
 *  errored window is never presented as a legitimate (empty) child. */
function childOpenFailure(
  childSessionId: string,
  openState: 'cold' | 'loading' | 'error',
  openError: unknown,
): Error {
  if (openState === 'error' && openError instanceof Error) return openError
  return new Error(
    openState === 'error'
      ? `the child session ${childSessionId} failed to open${openError === undefined ? '' : `: ${String(openError)}`}`
      : `the child session ${childSessionId} is not open yet (${openState})`,
  )
}

/**
 * Build the Remote child-view source over the ONE Remote application graph.
 */
export function createRemoteChildViewSource<Event>(
  options: RemoteChildViewSourceOptions<Event>,
): ViewerChildSource<Event> {
  const { sessions, reader, liveIngress } = options
  return {
    async open(target: ViewerChildOpenTarget): Promise<ViewerChildView<Event> | undefined> {
      const childId = target.childSessionId
      // The exact durable address: parent + child + catalog mode. Never a plain
      // id (plan Must-not 10) and never a Host Agent.
      const address: RemoteSubagentViewAddress = {
        parentSessionId: target.parentSessionId,
        childSessionId: childId,
        mode: target.mode,
      }
      const reference = acquireChildViewReference(sessions, address, target.signal)
      try {
        // The reference's cancellable wait for the shared initial open attempt.
        await reference.ready
      } catch (error) {
        reference.release()
        if (target.signal.aborted) return undefined
        throw error
      }
      // Re-check the exact generation this reference owns: a same-id rollover
      // between retain and read would otherwise hydrate the wrong binding.
      const ownedBinding = (): RemoteChildBinding | undefined => {
        const current = sessions.binding(childId)
        return current !== undefined && current === reference.bindingIdentity ? current : undefined
      }
      if (target.signal.aborted || ownedBinding() === undefined) {
        reference.release()
        return undefined
      }
      let read: PresentationReadSnapshot | undefined
      // The cold open is a READ→COMMIT too: capture the official generation
      // BEFORE the await and prove after it that the generation did not roll
      // over and the window is still the revision that was read (a same-id
      // rollover or a reconnect between them would otherwise hydrate a dead
      // generation's window into the viewer).
      const openFenceGeneration = options.generation.getSnapshot()
      try {
        read = await reader.read(childId, target.signal)
      } catch (error) {
        // An aborted signal is a SUPERSEDED open (the viewer exited/switched):
        // release and commit nothing, silently. A real read failure propagates.
        reference.release()
        if (target.signal.aborted) return undefined
        throw error
      }
      if (target.signal.aborted) {
        reference.release()
        return undefined
      }
      const binding = ownedBinding()
      if (read === undefined || binding === undefined) {
        reference.release()
        if (target.signal.aborted) return undefined
        throw new Error(`the child session ${childId} has no readable window`)
      }
      // The OFFICIAL open settlement: `Session.doOpen` records a real
      // RemoteFailure as `openState: 'error'` + `openError` and RESOLVES the
      // promise, so `reference.ready` does NOT reject and the reader still
      // returns a window. A failed open must release the reference and leave the
      // mounted surface untouched — never hydrate an empty child transcript.
      const opened = binding.session.getSnapshot()
      if (!isOpen(binding)) {
        reference.release()
        throw childOpenFailure(childId, opened.openState as 'cold' | 'loading' | 'error', opened.openError)
      }
      if (!Object.is(openFenceGeneration, options.generation.getSnapshot())
        || binding.eventSource?.getSnapshot().revision !== read.revision) {
        // The transport rolled over (or the window moved) while the child was
        // being opened: commit nothing and let the caller's next open observe
        // the CURRENT official state (no stale child, no retry loop here).
        reference.release()
        return undefined
      }
      const hydrated = (snapshot: PresentationReadSnapshot, current: RemoteChildBinding | undefined): ViewerChildSnapshot<Event> => ({
        durableEvents: snapshot.durableEvents as unknown as readonly Event[],
        liveInputs: snapshot.liveInputs,
        activity: childActivity(current),
        cwd: options.childCwd(childId),
        revision: snapshot.revision,
      })
      const snapshot = hydrated(read, binding)
      let released = false
      let live: RemoteLiveIngressHandle | undefined
      return {
        childSessionId: childId,
        parentSessionId: target.parentSessionId,
        snapshot,
        async rehydrate(): Promise<ViewerChildSnapshot<Event> | undefined> {
          if (released) return undefined
          // The reference still owns this exact generation; a same-id rollover
          // cannot slip in while it is held. An errored open is never re-folded
          // as a legitimate (empty) window.
          const before = ownedBinding()
          if (before === undefined || !isOpen(before)) return undefined
          const fenceGeneration = options.generation.getSnapshot()
          const next = await reader.read(childId)
          const current = ownedBinding()
          if (next === undefined || current === undefined || !isOpen(current)) return undefined
          // S3-R0 read→commit fence: the async read may have been overtaken by a
          // Connection rollover or a newer official revision. Committing it
          // would both lose the newer events and acknowledge a superseded
          // recovery, so the fold is valid only while the official window still
          // IS the revision that was read.
          if (!Object.is(fenceGeneration, options.generation.getSnapshot())) return undefined
          if (current.eventSource?.getSnapshot().revision !== next.revision) return undefined
          const snapshot = hydrated(next, current)
          return {
            ...snapshot,
            // The viewer performs the actual fold write through THIS closure so
            // the identity proof, the write and the acknowledgement are one
            // synchronous step (plan §2.5: last-moment read→commit). `false`
            // means the transport/window moved after the read: the write is
            // refused, nothing is acknowledged, and the child ingress has
            // already re-armed its recovery requirement.
            commit: (write: () => void): boolean => {
              if (released) return false
              if (!Object.is(fenceGeneration, options.generation.getSnapshot())) return false
              const bindingNow = ownedBinding()
              if (bindingNow === undefined || bindingNow !== current || !isOpen(bindingNow)) return false
              if (bindingNow.eventSource?.getSnapshot().revision !== next.revision) return false
              // Provenance BEFORE the write: while the retained window still
              // belongs to the generation that rolled over, the fold must not be
              // replaced at all (the ingress's acknowledgement gate alone would
              // run too late).
              if (live !== undefined && !live.refoldEligible(next.revision)) return false
              write()
              // No live ingress (the viewer has not subscribed yet, e.g. a
              // re-fold requested before the subscription): the write itself is
              // the commit and there is nothing to acknowledge.
              if (live === undefined) return true
              return live.acknowledgeWindowRefold({
                generation: fenceGeneration,
                binding: current,
                revision: next.revision,
              })
            },
          }
        },
        async loadOlder(): Promise<void> {
          if (released) return
          await reader.loadOlder(childId)
        },
        currentActivity: (): 'running' | 'inactive' => childActivity(ownedBinding()),
        subscribe(sinks: ViewerChildLiveSinks<Event>): { dispose(): void } | undefined {
          if (released) return undefined
          const handle = liveIngress.subscribe(childId, {
            onDurableEvent: (_id, event) => sinks.onDurableEvent(options.asEvent(event)),
            onLiveInput: (input: AssistantLiveInput) => sinks.onLiveInput(input),
            onWindowRefoldRequired: () => sinks.onWindowRefoldRequired(),
            onSessionSnapshotChanged: () => sinks.onSessionSnapshotChanged(),
            onProjectionsChanged: () => sinks.onProjectionsChanged(),
          }, {
            revision: read.revision,
            transportToken: { generation: openFenceGeneration, binding },
          })
          live = handle
          return {
            dispose: (): void => {
              handle.dispose()
              if (live === handle) live = undefined
            },
          }
        },
        release: (): void => {
          if (released) return
          released = true
          // The ingress must go down BEFORE the generation is released: a
          // synchronous teardown effect must not publish into a dead viewer.
          live?.dispose()
          live = undefined
          reference.release()
        },
      }
    },
    // Remote has no Agent-bound writer subject: the viewer publishes its own
    // token, so nothing is resolved here.
    childWriterSubject: () => undefined,
  }
}
