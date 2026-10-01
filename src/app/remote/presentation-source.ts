/**
 * M3-4 PR2 Remote application presentation source: the branch-specific
 * read/presentation bundle the bootstrap consumes when the internal selection
 * seam picked the Remote runtime — built from the SAME PR1 wire/client graph
 * (the aggregate), never from a second Connection or a reconstructed Client.
 *
 * Composition (plan §7.4 "preferred ownership"): the Remote application
 * aggregate constructs/exposes branch-specific application read sources;
 * the selection/composition seam presents only neutral application
 * interfaces to the surface/status owners. Concretely this bundle carries:
 *
 * - `presentationReader` — the EXISTING `RemoteM3ASemantics.presentationReader`
 *   (identity reuse; this module never constructs a second adapter);
 * - `submissionPresentation` — the official `SessionSnapshot.pendingSubmissions`
 *   source (the ONLY optimistic identity on the Remote path);
 * - `liveIngress` — the eventSource subscription ingress factory that feeds
 *   the existing session-presentation pipeline (durable appends + transient
 *   assistant chunks + window replaces), fenced by the exact binding object
 *   and the Connection generation;
 * - `sessionFacts` — the official Session-scoped status projection read
 *   (`SessionReader.sessionStatus`) plus the `plan` projection the status
 *   surface needs, both off the exact retained binding.
 *
 * No public package export, no CLI/config/env switch, no static
 * bootstrap -> app/remote import (the aggregate reaches this module inside
 * `app/remote/**`; bootstrap receives the constructed bundle through the
 * selection composition input).
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/presentation-source
 */

import type { PresentationReader } from '../../runtime/presentation-read-port.ts'
import type { SessionReader } from '../../runtime/session-reader-port.ts'
import type { SubmissionPresentationSource } from '../../submission-presentation.ts'
import { RemoteSubmissionPresentation } from '../../submission-presentation.ts'
import { CURRENT_STATUS_PROJECTION_KEYS } from '../../runtime/remote/session-reader-remote.ts'
import type { RemoteConnectionGenerationSource } from '../../runtime/remote/session-reader-remote.ts'
import { createRemoteLiveIngress, type RemoteLiveIngress } from './live-ingress.ts'
import type { ExperimentalRemoteRuntime, RemoteBackendRuntime } from './runtime.ts'
import type { RemoteApplicationSources } from '../application-runtime.ts'

/**
 * The neutral application presentation facts the Remote branch supplies to
 * the bootstrap's surface/status owners. Field shapes stay the shared
 * semantic ports — never a Client object, never an Agent-shaped wrapper.
 */
export interface RemoteApplicationSource extends RemoteApplicationSources {
  /** The ONE shared presentation reader (identity: the M3-3A adapter). */
  readonly presentationReader: PresentationReader
  /** The official pending-submissions optimistic echo source. */
  readonly submissionPresentation: SubmissionPresentationSource
  /** Subscribe the CURRENT binding's eventSource into the surface pipeline. */
  readonly liveIngress: RemoteLiveIngress
  /** The official Session-scoped status projection read (sessionStatus). */
  readonly sessionFacts: RemoteSessionFacts
}

/**
 * The Session-scoped official facts the status/presentation owners read.
 * `undefined` = the session is not materialized/retained to this backend;
 * an absent FIELD means the projection/capability is unavailable for the
 * session — never a parent/main-session fallback, never a zero-filled guess.
 */
export interface RemoteSessionFacts {
  /** The semantic session-status projection read (model/preset/cwd/todos/
   * usage/context of THIS session). */
  readonly sessionStatus: SessionReader['sessionStatus']
  /** The official `plan` projection wire view of THIS session
   * (`{ active, pending }`), or undefined when the projection/session is
   * unavailable. */
  plan(sessionId: string): { readonly active: boolean; readonly pending: boolean } | undefined
  /** The official `running` bit of the exact retained binding
   *  (`SessionSnapshot.running`), or undefined when no binding is retained
   *  for the session / the generation is absent. */
  running(sessionId: string): boolean | undefined
  /**
   * The §6.5 transport identity token (the Connection generation snapshot +
   * the exact binding object at capture time). `isTransportTokenCurrent`
   * compares BOTH: a Connection/binding rollover that did not commit a new
   * TUI owner still invalidates a pending visible commit.
   */
  captureTransportToken(sessionId: string): unknown
  /** Whether the captured transport token still matches the live identity. */
  isTransportTokenCurrent(sessionId: string, token: unknown): boolean
}

/** The structural binding face the projection/running reads borrow. */
interface RemotePlanBindingSource {
  binding(id: string): {
    readonly session: {
      readonly projections: { faceOf(key: string): { getSnapshot(): unknown } }
      getSnapshot(): { readonly running: boolean }
    }
  } | undefined
}

/** Narrow the official `plan` projection wire view (a foreign shape reads
 *  unknown — never a guessed active/pending). */
function detachedPlan(value: unknown): { readonly active: boolean; readonly pending: boolean } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const plan = value as { readonly active?: unknown; readonly pending?: unknown }
  if (typeof plan.active !== 'boolean') return undefined
  if (plan.pending !== undefined && typeof plan.pending !== 'boolean') return undefined
  return { active: plan.active, pending: plan.pending === true }
}

/**
 * Assemble the Remote application presentation source from the ONE Remote
 * application aggregate. Every member reuses a face the aggregate already
 * owns: `semantics.presentationReader` by identity, the wire's
 * `sessions`/`connection.generation` for the official projection/echo reads,
 * and the eventSource borrow for the live ingress. Constructing this bundle
 * installs no subscription and owns no disposal — the ingress subscription
 * is created lazily by the bootstrap and disposed through its own handle.
 */
export function createRemotePresentationSource(
  wire: ExperimentalRemoteRuntime,
  backendRuntime: RemoteBackendRuntime,
): RemoteApplicationSource {
  const sessions = wire.client.sessions
  const generation = wire.client.connection.generation as RemoteConnectionGenerationSource
  const sessionReader = backendRuntime.semantics.sessionReader
  const planSource = sessions as RemotePlanBindingSource
  return {
    presentationReader: backendRuntime.semantics.presentationReader,
    submissionPresentation: new RemoteSubmissionPresentation(sessions, generation),
    liveIngress: createRemoteLiveIngress(sessions, generation, CURRENT_STATUS_PROJECTION_KEYS),
    sessionFacts: {
      sessionStatus: sessionId => sessionReader.sessionStatus(sessionId),
      plan(sessionId: string) {
        if (generation.getSnapshot() === undefined) return undefined
        const binding = planSource.binding(sessionId)
        if (binding === undefined) return undefined
        return detachedPlan(binding.session.projections.faceOf('plan').getSnapshot())
      },
      running(sessionId: string) {
        if (generation.getSnapshot() === undefined) return undefined
        const captured = generation.getSnapshot()
        const binding = planSource.binding(sessionId)
        if (binding === undefined) return undefined
        const running = binding.session.getSnapshot().running
        if (!Object.is(captured, generation.getSnapshot())) return undefined
        return running
      },
      captureTransportToken: (sessionId: string): unknown => ({
        generation: generation.getSnapshot(),
        binding: sessions.binding(sessionId as never) as object | undefined,
      }),
      isTransportTokenCurrent(sessionId: string, token: unknown): boolean {
        const captured = token as { generation?: unknown; binding?: unknown } | undefined
        if (captured === undefined || typeof captured !== 'object') return false
        if (!Object.is(captured.generation, generation.getSnapshot())) return false
        return sessions.binding(sessionId as never) === captured.binding
      },
    },
  }
}
