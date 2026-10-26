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
import type { TranscriptFolder } from '../../domain/transcript/folder.ts'
import { assistantStepOf } from '../../domain/transcript/folder.ts'
import { eligibleFinalAssistant } from '../../domain/transcript/final-assistant.ts'
import { visibleAssistantTextForCopy } from '../../domain/visual/display-copy.ts'
import type { VisualEventSnapshot } from '../../domain/visual/presentation.ts'
import {
  collectPublishedVisuals,
  isModelOnlyReplacement,
} from '../../domain/visual/publication.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
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

/** The ContentBlock shape the display-copy projection consumes, taken from the
 * domain module so this composition seam needs no Host package import (the
 * Client-boundary gate counts even a TYPE-ONLY one). */
type CopyContentBlocks = NonNullable<Parameters<typeof visibleAssistantTextForCopy>[0]['content']>

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
  /**
   * The EXISTING main transcript fold of the current owner, if any. Used only
   * to prove the final-Assistant identity of a display `/copy`; never a second
   * Folder and never a Host read.
   */
  readonly mainFolder: () => TranscriptFolder | undefined
  /** The ownership generation (bumped by every owner/binding commit). */
  readonly currentGeneration: () => number
  /**
   * The EXISTING visual-event snapshot selector for the CURRENT Direct main
   * subject: the exact committed log the PR2 sidecar was derived from, or
   * undefined on Remote / no live owner. The display copy reuses this one
   * read-only seam rather than opening a second session-log reader.
   */
  readonly mainVisualSnapshot: () => VisualEventSnapshot | undefined
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
  /**
   * The Direct last-assistant-message read (single-event lookup, never a full
   * fold): the ORIGINAL official bytes, minus the marker spans the display
   * renderer consumed. Throws {@link SupersededReadError} when the latest
   * official message carries published-visual markers whose final-row identity
   * cannot be proven (a torn read must never be silently copied).
   */
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
  const {
    remoteSources,
    currentSessionId,
    currentDirectAgent,
    assistantStreamBaselineFor,
    directSessionFor,
    mainFolder,
    currentGeneration,
    mainVisualSnapshot,
  } = deps

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

  /**
   * The Direct display `/copy` payload.
   *
   * Fast path: the latest official `assistant/message` text blocks joined
   * exactly as before (single-event backwards lookup; no full fold). Only a
   * text that CONTAINS the marker candidate prefix pays the qualification cost:
   *
   * ```text
   * official latest event -> same-Session main Folder -> the exact settlement
   * seq of (turn, step) -> eligibleFinalAssistant() on that turn's rows
   * -> collectPublishedVisuals(same Session snapshot) -> shared planner
   * -> text spans only -> existing post-await scope fence -> clipboard
   * ```
   *
   * The candidate string never DECIDES a removal: if the Session has no
   * published visual for that turn the original bytes are returned even when
   * they look like a marker. If it HAS one and any identity link is torn (the
   * folder never settled that exact seq, the eligible final row is another
   * step/text, or the ownership changed), the read fails closed instead of
   * guessing which span to drop.
   */
  const directLastAssistantText = (sessionId: string): string | undefined => {
    const session = directSessionFor(sessionId)
    let latest: {
      readonly seq: number
      readonly turn: number
      readonly step: number
      readonly text: string
      readonly content: CopyContentBlocks
    } | undefined
    // Single-event lookup: walk BACKWARDS with eventAt (alpha.4) — never
    // materialize the whole log for one message.
    for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (event?.type !== 'assistant/message') continue
      // A compaction/model-only surface replacement is NOT the human-visible
      // latest answer: the transcript fold and the raw export both keep the
      // append-origin message, so the display copy must read the same one.
      if (isModelOnlyReplacement(event)) continue
      const content = event.data.message.content
      latest = {
        seq: Number(event.seq),
        turn: event.data.turn,
        step: event.data.step,
        text: content
          .filter(block => block.type === 'text')
          .map(block => (block as { text: string }).text)
          .join(''),
        content,
      }
      break
    }
    if (latest === undefined) return undefined
    // A candidate only BUYS the proof; it never authorizes a deletion.
    if (!latest.text.includes('[dsh-visual-')) return latest.text
    const generation = currentGeneration()
    if (currentSessionId() !== sessionId) {
      throw new SupersededReadError('the session changed while reading the last assistant text')
    }
    // Reuse the EXISTING render-time visual snapshot seam: it is the exact
    // committed log the PR1/PR2 projection was derived from, fenced to the
    // current main Direct Session. No second session-log reader.
    const snapshot = mainVisualSnapshot()
    if (snapshot === undefined || snapshot.session !== session || snapshot.sessionId !== sessionId) {
      throw new SupersededReadError('the session changed while reading the last assistant text')
    }
    const publications = collectPublishedVisuals(sessionId, snapshot.events)
    const turnPublications = publications.filter(publication => publication.turn === latest.turn)
    // No PR1-authorized publication for this turn: the marker-shaped bytes are
    // ordinary prose, never a consumed display span.
    if (turnPublications.length === 0) return latest.text
    const transcript = mainFolder()
    if (transcript === undefined) {
      throw new SupersededReadError('the published visual source cannot be qualified in the current transcript')
    }
    const settlementSeq = transcript.assistantSettlementSeq(latest.turn, latest.step)
    if (settlementSeq !== latest.seq) {
      throw new SupersededReadError('the latest assistant message is not the committed final step of this transcript')
    }
    const group = transcript.messages().filter(message => 'turn' in message && message.turn === latest.turn)
    const final = eligibleFinalAssistant(transcript.turnActivity(latest.turn), group)
    if (final === undefined
      || assistantStepOf(final.message) !== latest.step
      || final.message.text !== latest.text) {
      throw new SupersededReadError('the published visual source does not match the eligible final assistant row')
    }
    if (currentGeneration() !== generation || currentSessionId() !== sessionId) {
      throw new SupersededReadError('the session changed while deriving the last assistant text')
    }
    return visibleAssistantTextForCopy({
      text: latest.text,
      content: latest.content,
      publications: turnPublications,
    })
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
