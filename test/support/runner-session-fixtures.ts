/** Shared real test primitives for the runner-session integration suites.
 * Only primitives used by two or more split suites live here: the Session v2
 * live assistant-stream frame builders, the production-runner observer probe,
 * and the durable model/selection event builder. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { StatsFolder } from '../../src/domain/status/stats.ts'
import { StatusStore } from '../../src/domain/status/store.ts'
import type { StatusSnapshot } from '../../src/domain/status/types.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TuiApp, type DisplaySubjectPresentation, type StatusData } from '../../src/tui-app.ts'
import type { StreamingToolPreview } from '../../src/app/surface/streaming-tool-preparing.ts'
import type { RunnerHarness } from './runner-harness.ts'

/** One Session v2 live assistant-stream frame (the transient plane
 * replaces durable `assistant/chunk` events). The shape is the EXACT
 * upstream `AssistantStreamFrame`: only `start` carries turn/step; chunk
 * and end name their attempt plus the dense revision and dense index. */
export type LiveStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: unknown }
  | {
    type: 'end'
    attemptId: string
    revision: number
    index: number
    outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq: number } | { kind: 'abandoned' }
  }

let liveStreamRevision = 0
test.beforeEach(() => { liveStreamRevision = 0 })

/** The next dense live-stream revision. The counter is shared by every frame
 * builder below AND by suites that emit a hand-shaped frame (the runner fences
 * exact revision ordering), so its increment is the shared primitive — not a
 * fixture builder of its own. */
export function nextLiveStreamRevision(): number {
  return ++liveStreamRevision
}

/** Start one live attempt (upstream: AssistantStreamAttempt.start). */
export function liveStart(attemptId: string, turn: number, step: number): LiveStreamFrame {
  return { type: 'start', attemptId, revision: ++liveStreamRevision, turn, step }
}

/** One live attempt chunk (upstream push — no turn/step on the wire). */
export function liveChunkFrame(attemptId: string, index: number, chunk: unknown): LiveStreamFrame {
  return { type: 'chunk', attemptId, revision: ++liveStreamRevision, index, time: 1_700_000_000_000 + index, chunk }
}

/** Settle a live attempt after its durable event committed. */
export function liveCommittedEnd(attemptId: string, chunkCount: number, eventType: 'assistant/message' | 'assistant/attempt'): LiveStreamFrame {
  return { type: 'end', attemptId, revision: ++liveStreamRevision, index: chunkCount, outcome: { kind: 'committed', eventType, seq: 100 } }
}

/** Emit one live assistant-stream frame on the Cordis context with the
 * REAL emitting Agent object (the runner's identity fence compares exact
 * Agent identity — never a session id). The event name is master-only
 * (absent from the local Cordis Events map), so the context is read
 * through a loose emit surface. */
export function emitLiveStream(ctx: Context, subject: unknown, frame: LiveStreamFrame): void {
  const emit = (ctx as unknown as { emit(name: string, payload: unknown): void }).emit
  emit('agent/assistant-stream', { agent: subject, frame })
}

/** Resolve a harness's live Agent object by session id (the same object
 * the resume returned — required for the exact-identity fence). */
export function liveAgentOf(harness: RunnerHarness, sessionId: string): unknown {
  const agents = harness.agents as { get?(id: string): unknown }
  const agent = agents.get?.(sessionId)
  assert.ok(agent !== undefined, `live agent for ${sessionId} must exist`)
  return agent
}

export function modelEvent(type: 'model/selection' | 'request/header', data: unknown, seq: number): SessionEvent {
  return {
    type,
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq * 1000,
    data,
  } as unknown as SessionEvent
}

export interface RunnerProbe {
  transcriptApplyCount: number
  statsApplyCount: number
  transcriptHydrateCount: number
  statsHydrateCount: number
  capturedMessages: readonly { kind: string; text?: string }[] | undefined
  capturedActivities: ReadonlyMap<number, unknown> | undefined
  capturedStreamingToolPreviews: readonly StreamingToolPreview[] | undefined
  /** The COMMITTED StatusStore usage of the most recent subagent display
   *  subject (the authoritative child usage the footer composes from). */
  capturedViewerUsage: unknown
  /** The most recent subagent display-subject StatusStore snapshot. */
  capturedChildStatus: StatusSnapshot | undefined
  /** The most recent subagent display-subject commit payload. */
  capturedDisplaySubject: {
    readonly legacy: Partial<StatusData> | undefined
    readonly presentation: DisplaySubjectPresentation | undefined
  } | undefined
  /**
   * The mounted app's OWN current additive display-subject projection — the
   * exact value `syncExtensionState` publishes to the extension surface when a
   * host is attached (`session.displaySubject`). Read through the production
   * method so a runner suite without an extension host can still observe the
   * extension-visible facts.
   */
  displaySubject(): unknown
  capturedViewerMode: unknown
  capturedApproval: { toolName?: string; arguments?: string; danger?: boolean } | undefined
  scrollToBottomCount: number
  capturedModels: string[]
  capturedWelcomeModels: string[]
  /** Every `app.notify(message, kind)` this run surfaced. */
  notices: string[]
  apps: TuiApp[]
  restore: () => void
}

/** Observe the production runner without replacing its TUI or projection code. */
export function installProbe(): RunnerProbe {
  const probe: RunnerProbe = {
    transcriptApplyCount: 0,
    statsApplyCount: 0,
    transcriptHydrateCount: 0,
    statsHydrateCount: 0,
    capturedMessages: undefined,
    capturedActivities: undefined,
    capturedStreamingToolPreviews: undefined,
    capturedViewerUsage: undefined,
    capturedChildStatus: undefined,
    capturedDisplaySubject: undefined,
    displaySubject: () => undefined,
    capturedViewerMode: undefined,
    capturedApproval: undefined,
    scrollToBottomCount: 0,
    capturedModels: [],
    capturedWelcomeModels: [],
    notices: [],
    apps: [],
    restore: () => {},
  }
  const originalTranscriptApply = TranscriptFolder.prototype.apply
  const originalStatsApply = StatsFolder.prototype.apply
  const originalTranscriptHydrate = TranscriptFolder.prototype.hydrate
  const originalStatsHydrate = StatsFolder.prototype.hydrate
  const originalSetTranscript = TuiApp.prototype.setTranscript
  const originalCommitDisplaySubject = TuiApp.prototype.commitDisplaySubject
  const originalStatusUpdate = StatusStore.prototype.update
  const originalSetViewerMode = TuiApp.prototype.setViewerMode
  const originalShowApprovalPrompt = TuiApp.prototype.showApprovalPrompt
  const originalSetStatus = TuiApp.prototype.setStatus
  const originalSetWelcomeCard = TuiApp.prototype.setWelcomeCard
  const originalNotify = TuiApp.prototype.notify
  const originalStart = TuiApp.prototype.start
  const originalScrollToBottom = TuiApp.prototype.scrollToBottom
  TranscriptFolder.prototype.apply = function (events) {
    probe.transcriptApplyCount += 1
    return originalTranscriptApply.call(this, events)
  }
  StatsFolder.prototype.apply = function (events) {
    probe.statsApplyCount += 1
    return originalStatsApply.call(this, events)
  }
  TranscriptFolder.prototype.hydrate = function (events) {
    probe.transcriptHydrateCount += 1
    return originalTranscriptHydrate.call(this, events)
  }
  StatsFolder.prototype.hydrate = function (events) {
    probe.statsHydrateCount += 1
    return originalStatsHydrate.call(this, events)
  }
  TuiApp.prototype.setTranscript = function (messages, activities, window, streamingToolPreviews, searchPresentation) {
    probe.capturedMessages = messages
    probe.capturedActivities = activities
    probe.capturedStreamingToolPreviews = streamingToolPreviews
    return originalSetTranscript.call(this, messages, activities, window, streamingToolPreviews, searchPresentation)
  }
  StatusStore.prototype.update = function (patch) {
    const result = originalStatusUpdate.call(this, patch)
    const snapshot = this.snapshot()
    if (snapshot.view.subject.kind === 'subagent') {
      // The COMMITTED child usage — the exact facts the footer consumes.
      probe.capturedViewerUsage = snapshot.usage
      probe.capturedChildStatus = snapshot
    }
    return result
  }
  TuiApp.prototype.commitDisplaySubject = function (patch, legacy, presentation) {
    // Every SUBAGENT commit carries a presentation projection; a main commit
    // never does. Recording on the projection (not on `patch.view`, which is
    // omitted while the subject is unchanged) keeps the LATEST child commit.
    if (presentation !== undefined) probe.capturedDisplaySubject = { legacy, presentation }
    return originalCommitDisplaySubject.call(this, patch, legacy, presentation)
  }
  TuiApp.prototype.setViewerMode = function (mode) {
    probe.capturedViewerMode = mode
    return originalSetViewerMode.call(this, mode)
  }
  TuiApp.prototype.showApprovalPrompt = function (request) {
    probe.capturedApproval = request
    return Promise.resolve('cancelled')
  }
  TuiApp.prototype.setStatus = function (status) {
    if (typeof status.model === 'string') probe.capturedModels.push(status.model)
    return originalSetStatus.call(this, status)
  }
  TuiApp.prototype.start = function () {
    probe.apps.push(this)
    return originalStart.call(this)
  }
  TuiApp.prototype.setWelcomeCard = function (facts: { cwd: string; sessionId: string; model: string; version: string; preset?: string }) {
    probe.capturedWelcomeModels.push(facts.model)
    return originalSetWelcomeCard.call(this, facts)
  }
  TuiApp.prototype.scrollToBottom = function (options: { disableFollow?: boolean } = {}) {
    probe.scrollToBottomCount += 1
    return originalScrollToBottom.call(this, options)
  }
  TuiApp.prototype.notify = function (...args: Parameters<typeof originalNotify>) {
    probe.notices.push(`${args[1] ?? 'info'}:${String(args[0])}`)
    return originalNotify.apply(this, args)
  }
  probe.displaySubject = () => {
    const current = probe.apps.at(-1) as unknown as { displaySubjectSnapshot?: () => unknown } | undefined
    return current?.displaySubjectSnapshot?.()
  }
  probe.restore = () => {
    TranscriptFolder.prototype.apply = originalTranscriptApply
    StatsFolder.prototype.apply = originalStatsApply
    TranscriptFolder.prototype.hydrate = originalTranscriptHydrate
    StatsFolder.prototype.hydrate = originalStatsHydrate
    TuiApp.prototype.setTranscript = originalSetTranscript
    TuiApp.prototype.commitDisplaySubject = originalCommitDisplaySubject
    StatusStore.prototype.update = originalStatusUpdate
    TuiApp.prototype.setViewerMode = originalSetViewerMode
    TuiApp.prototype.showApprovalPrompt = originalShowApprovalPrompt
    TuiApp.prototype.setStatus = originalSetStatus
    TuiApp.prototype.setWelcomeCard = originalSetWelcomeCard
    TuiApp.prototype.notify = originalNotify
    TuiApp.prototype.start = originalStart
    TuiApp.prototype.scrollToBottom = originalScrollToBottom
  }
  return probe
}
