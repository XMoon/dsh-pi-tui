/**
 * The application presentation bridge (TS2 §8): branch-selection/composition
 * glue for the presentation reads the composition root consumes.
 *
 * It connects ONLY the selected application runtime + the existing Direct
 * `DirectPresentationReader` + the existing Remote presentation source bundle to
 * narrow composition-facing functions. It is NOT a presentation semantic owner:
 * it owns no `TranscriptFolder`, no search/viewport state, no status derivation,
 * no `TuiApp` rendering and no event folding.
 *
 * The composition root keeps every Host lookup, the ownership/currentness reads
 * and the Direct attachment resolution; this module receives narrow values and
 * closures only (no `ctx`, no Host service, no `src/app/bootstrap.ts` import).
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/presentation-bridge
 */

import { DirectPresentationReader } from '../../runtime/direct/presentation-read-direct.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { PresentationReadSnapshot } from '../../runtime/presentation-read-port.ts'
import { computeStats, type SessionStats } from '../../domain/status/stats.ts'
import type { RemoteApplicationSources } from '../application-runtime.ts'

/** The exact Direct attachment face this bridge reads (the branch-selection
 *  check needs the session id; the reader needs the whole-log read). */
export interface DirectAgentReads {
  readonly session: {
    readonly id: string
    snapshotEvents(): readonly unknown[]
  }
}

/** The transport-neutral `{status, session.id}` live-session facts face. */
export interface LiveSessionFacts {
  readonly status: string
  readonly session: { readonly id: string }
}

/** The scope-checked input for an echo install (the live session subject). */
export interface LiveSessionScopeLike {
  readonly sessionId: string
}

/**
 * The exact Direct session face the whole-log stats folds read. The real
 * `Session` satisfies it structurally (its `SessionSeq` argument is a branded
 * `number`, and the method form is checked bivariantly), so this module needs
 * no Host type import. Passing the session through keeps the two deprecated
 * synchronous-reader call sites exactly where they were (relocated, not
 * multiplied): the debt ledger tracks their textual call sites.
 */
export interface DirectSessionReads {
  readonly seq: number | string
  snapshotEvents(): Parameters<typeof computeStats>[0]
  eventAt(seq: number): Parameters<typeof computeStats>[0][number] | undefined
}

/** The narrow values the presentation bridge composes; one cohesive lifetime. */
export interface PresentationBridgeDeps {
  /** The Remote-branch presentation sources (undefined on Direct). */
  readonly remoteSources: RemoteApplicationSources | undefined
  /** The current owner's session id (the ownership core's authority). */
  readonly currentSessionId: () => string | undefined
  /** The exact Direct attachment of the CURRENT owner. */
  readonly currentDirectAgent: () => DirectAgentReads | undefined
  /** The Direct assistant-stream baseline read (late-bound at the root). */
  readonly assistantStreamBaselineFor: (agent: object) => readonly AssistantLiveInput[]
  /** The exact attached Direct session for one fenced session id. */
  readonly directSessionFor: (sessionId: string) => DirectSessionReads
}

/** The composition-facing presentation reads the root consumes. */
export interface PresentationBridge {
  /** Branch-shared loadThrough (Direct full-coverage adapter; Remote official jump loop). */
  loadThrough(sessionId: string, seq: number, signal?: AbortSignal): Promise<PresentationReadSnapshot | undefined>
  /** The Remote `{status, session.id}` projection (undefined on Direct / no owner). */
  remoteLiveSessionFacts(): LiveSessionFacts | undefined
  /** The scope-checked variant used by the echo install. */
  liveSessionFactsFor(scope: LiveSessionScopeLike): LiveSessionFacts | undefined
  /** The official `running` bit of the exact retained binding (Remote). */
  remoteRunningOf(sessionId: string): boolean | undefined
  /** The Direct whole-log stats fold for one exact attachment. */
  directSessionStats(sessionId: string): SessionStats
  /** The Direct last-assistant-message read (single-event lookup, never a full fold). */
  directLastAssistantText(sessionId: string): string | undefined
  /** The official whole-log `sessionStats` projection value (Remote; unknown-shaped). */
  sessionStatsProjectionOf(sessionId: string): unknown
  /** The §6.5 transport-identity fence the Remote compositions re-check. */
  remoteTransportFenceOf(sessionId: string): { isCurrent(): boolean }
}

/**
 * Compose the presentation reads over the selected runtime. The factory is
 * pure composition: it constructs the Direct reader once and returns frozen
 * narrow functions; it registers nothing and owns no state.
 */
export function createPresentationBridge(deps: PresentationBridgeDeps): PresentationBridge {
  const { remoteSources, currentSessionId, currentDirectAgent, assistantStreamBaselineFor, directSessionFor } = deps

  /** The Direct presentation reader (PR4 §4.3): the full-coverage adapter
   *  over the exact attachment map + the assistant-stream baseline — the
   *  SAME sources the parity shadow consumes; never a second fold. */
  const directPresentationReader = new DirectPresentationReader({
    agentFor: (sessionId) => {
      const agent = currentDirectAgent()
      return agent !== undefined && agent.session.id === sessionId ? agent : undefined
    },
    assistantStreamBaselineFor,
  })

  /** PR4 §4.3: the branch-shared loadThrough read (Direct maps to its
   *  full-coverage adapter; Remote runs the official jump loop off the
   *  exact retained binding, generation-fenced inside the reader). */
  const loadThrough = async (
    sessionId: string,
    seq: number,
    signal?: AbortSignal,
  ): Promise<PresentationReadSnapshot | undefined> => {
    const reader = remoteSources === undefined
      ? directPresentationReader
      : remoteSources.presentationReader
    return reader.loadThrough(sessionId, seq, signal)
  }

  /** The Remote live-session facts projection (M3-4 PR3 §11): the structural
   *  {status, session.id} face every transport-neutral consumer reads. Only
   *  meaningful on the Remote branch (`remoteSources !== undefined`); returns
   *  undefined when no current owner exists. */
  const remoteLiveSessionFacts = (): LiveSessionFacts | undefined => {
    if (remoteSources === undefined) return undefined
    const sessionId = currentSessionId()
    if (sessionId === undefined) return undefined
    return {
      status: remoteSources.sessionFacts.running(sessionId) === true ? 'running' : 'idle',
      session: { id: sessionId },
    }
  }

  /** The scope-checked projection for an echo install: the session id must
   *  match the scope's own (never "whatever is current"), undefined when the
   *  scope's session has no current owner. */
  const liveSessionFactsFor = (scope: LiveSessionScopeLike): LiveSessionFacts | undefined => {
    const facts = remoteLiveSessionFacts()
    return facts !== undefined && facts.session.id === scope.sessionId ? facts : undefined
  }

  /** The official `running` bit of the exact retained binding (Remote). */
  const remoteRunningOf = (sessionId: string): boolean | undefined =>
    remoteSources === undefined ? undefined : remoteSources.sessionFacts.running(sessionId)

  /** The DIRECT fold reads the exact attachment's whole log. */
  const directSessionStats = (sessionId: string): SessionStats =>
    computeStats(directSessionFor(sessionId).snapshotEvents())

  const directLastAssistantText = (sessionId: string): string | undefined => {
    const session = directSessionFor(sessionId)
    // Single-event lookup: walk BACKWARDS with eventAt (alpha.4) — never
    // materialize the whole log for one message.
    for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (event?.type !== 'assistant/message') continue
      return event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text)
        .join('')
    }
    return undefined
  }

  /** The official whole-log `sessionStats` projection value off the
   *  exact retained binding (PR4 §3.3; unknown-shaped until the composer
   *  narrows it; an absent projection reads unmeasured totals). */
  const sessionStatsProjectionOf = (sessionId: string): unknown =>
    remoteSources === undefined ? undefined : remoteSources.sessionFacts.sessionStatsProjection(sessionId)

  /** The §6.5 transport-identity fence the Remote compositions re-check
   *  after every await (Connection generation + exact binding object).
   *  The token is captured ONCE at construction (the operation's
   *  admission); `isCurrent` only ever COMPARES that frozen token — a
   *  same-session-id binding rollover between capture and settle must
   *  read stale, never re-capture the replacement as current. */
  const remoteTransportFenceOf = (sessionId: string): { isCurrent(): boolean } => {
    const sources = remoteSources
    const token = sources === undefined ? undefined : sources.sessionFacts.captureTransportToken(sessionId)
    return {
      isCurrent: () => {
        if (sources === undefined || token === undefined) return false
        return sources.sessionFacts.isTransportTokenCurrent(sessionId, token)
      },
    }
  }

  return Object.freeze({
    loadThrough,
    remoteLiveSessionFacts,
    liveSessionFactsFor,
    remoteRunningOf,
    directSessionStats,
    directLastAssistantText,
    sessionStatsProjectionOf,
    remoteTransportFenceOf,
  })
}
