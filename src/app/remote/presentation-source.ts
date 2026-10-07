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
import type { SubmissionPresentationSource } from '../submission/presentation.ts'
import { RemoteSubmissionPresentation } from './submission-presentation.ts'
import { RemoteTaskReader } from '../../runtime/remote/task-read-remote.ts'
import { CURRENT_STATUS_PROJECTION_KEYS } from '../../runtime/remote/session-reader-remote.ts'
import type { RemoteConnectionGenerationSource } from '../../runtime/remote/session-reader-remote.ts'
import { createRemoteLiveIngress, type RemoteLiveIngress } from './live-ingress.ts'
import { createRemoteChildViewSource } from './child-view.ts'
import { createRemoteCommandSource, type RemoteCommandSource } from './command-source.ts'
import type { ExperimentalRemoteRuntime, RemoteBackendRuntime } from './runtime.ts'
import type { RemoteApplicationSources,
  RemoteTransportLifetime,
} from '../application-runtime.ts'
import type { SessionPresentationEvent } from '../surface/session-presentation.ts'

/**
 * The neutral application presentation facts the Remote branch supplies to
 * the bootstrap's surface/status owners. Field shapes stay the shared
 * semantic ports — never a Client object, never an Agent-shaped wrapper.
 */
export interface RemoteApplicationSource extends RemoteApplicationSources {
  /** The ONE shared presentation reader (identity: the M3-3A adapter). */
  readonly presentationReader: PresentationReader
  /** The branch-specific command authority read (PR4 §D1): Host command +
   *  human-skill metadata behind one generation-fenced snapshot. */
  readonly commandSource: RemoteCommandSource
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
  /** The official whole-log `sessionStats` projection value (PR4 §3.3). */
  sessionStatsProjection(sessionId: string): unknown
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
  // The ONE shared live-ingress factory, referenced by both the main-surface
  // bundle member and the child-view source (never a second instance).
  const liveIngress = createRemoteLiveIngress(sessions, generation, CURRENT_STATUS_PROJECTION_KEYS)
  // The ONE semantic Task read over the SAME Client faces. It retains the root
  // Job roster watch for the session it last read.
  const taskReader = new RemoteTaskReader(sessions, wire.client.jobs, generation)
  return {
    presentationReader: backendRuntime.semantics.presentationReader,
    // PR4 §D1: the branch-specific command authority read, assembled from the
    // SAME wire faces (the generated commands/skills namespaces + the ONE
    // Connection generation) — never a second graph.
    commandSource: createRemoteCommandSource({
      // The generated namespaces (commands/skills) exist because the Client
      // runtime mounted their /remote contributions; the structural source
      // face is the same one remote-official-contract.test.ts proves.
      authority: wire.client.remote,
      generation,
      // §16: the SAME shared sessions service is the exact-binding fence
      // source (a same-id release/re-retain invalidates a settled read).
      bindings: sessions,
    }),
    submissionPresentation: new RemoteSubmissionPresentation(sessions, generation),
    liveIngress,
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
      sessionStatsProjection(sessionId: string): unknown {
        if (generation.getSnapshot() === undefined) return undefined
        const binding = planSource.binding(sessionId)
        if (binding === undefined) return undefined
        return binding.session.projections.faceOf('sessionStats').getSnapshot()
      },
      isTransportTokenCurrent(sessionId: string, token: unknown): boolean {
        const captured = token as RemoteTransportLifetime | undefined
        if (captured === undefined || typeof captured !== 'object') return false
        if (!Object.is(captured.generation, generation.getSnapshot())) return false
        return sessions.binding(sessionId as never) === captured.binding
      },
    },
    // M3-5 PR2 Step 1/2: the ONE semantic Task read (descendant catalog + root
    // Job roster) plus the official Client model's roster/activity reads and
    // invalidation subscriptions. The reader owns its retained root `watchRows`
    // lease; the two subscriptions are plain observable hints whose
    // authoritative answer is always the next semantic read.
    task: {
      readDescendants: (parentSessionId, signal) => taskReader.readDescendants(parentSessionId, signal),
      jobs: sessionId => wire.client.jobs.state.getSnapshot().rows[sessionId] ?? [],
      // The commit-time activity read: the official Session-LIST fact, never a
      // borrowed binding (the listing retains no descendant).
      activityOf: childSessionId => {
        const byId = sessions.list.getSnapshot().byId as Readonly<
          Record<string, { readonly running: boolean } | undefined>
        >
        const entry = byId[childSessionId]
        return entry === undefined ? undefined : entry.running ? 'running' : 'inactive'
      },
      subscribeJobs: listener => wire.client.jobs.state.subscribe(listener),
      subscribeSessions: listener => sessions.list.subscribe(listener),
      // The reader owns the retained root roster watch: release it through this
      // owner before the Client Context goes away.
      dispose: () => taskReader.dispose(),
    },
    // M3-5 PR2 Step 4/5: the child viewer's exact retained generation, hydrated
    // through the SAME presentation reader and live ingress (no child-specific
    // transport).
    childView: createRemoteChildViewSource<SessionPresentationEvent>({
      sessions,
      reader: backendRuntime.semantics.presentationReader,
      liveIngress,
      childCwd: sessionId => {
        const cwd = sessionReader.sessionStatus(sessionId)?.cwd
        return typeof cwd === 'string' ? cwd : ''
      },
      asEvent: event => event as unknown as SessionPresentationEvent,
    }),
    // M3-5 PR2 Step 9: the durable image read of the OWNING presentation's
    // retained Session. `expectedLifetime` is REQUIRED and carries the EXACT binding
    // the presentation was created with. The PRE-dispatch fence compares the BINDING
    // IDENTITY only: a same-binding Connection generation rollover is the official
    // ADOPTION (the retained binding survives a rollover — see `RemoteLiveIngress`),
    // while a DIFFERENT binding, a MISSING binding or a malformed/missing lifetime
    // retires the presentation and fails closed BEFORE any Session is touched. The
    // read's own Connection generation + binding identity are then re-checked before
    // the bytes are committed, so bytes obtained across a rollover are still dropped.
    // No cold retain, no Host attachment access.
    attachments: {
      async readDurableImage(
        sessionId: string,
        attachmentId: string,
        expectedLifetime: RemoteTransportLifetime,
      ): Promise<{ ref: unknown; data: Uint8Array }> {
        const capturedGeneration = generation.getSnapshot()
        if (capturedGeneration === undefined) {
          throw new Error(`the Remote connection is not ready to read an attachment of ${sessionId}`)
        }
        if (expectedLifetime === undefined || typeof expectedLifetime !== 'object') {
          throw new Error(`the attachment read of ${sessionId} carries no presentation lifetime`)
        }
        const binding = sessions.binding(sessionId as never)
        if (binding === undefined) {
          throw new Error(`no retained Session binding for ${sessionId}`)
        }
        if (binding !== expectedLifetime.binding) {
          throw new Error(`the presentation's Session binding for ${sessionId} is retired`)
        }
        const result = await binding.session.readAttachment(attachmentId as never)
        if (!Object.is(capturedGeneration, generation.getSnapshot())
          || sessions.binding(sessionId as never) !== binding) {
          throw new Error(`the Session binding for ${sessionId} changed while the attachment was read`)
        }
        if (!result.ok) throw result.error
        return { ref: result.value.attachment, data: result.value.data }
      },
    },
  }
}
