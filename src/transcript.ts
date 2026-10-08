/**
 * Stable transcript facade (TS7/TS8-D): re-exports the ONE transcript semantic
 * authority from `src/domain/transcript/**`.
 *
 * Canonical owners:
 *   domain/transcript/types.ts               carrier types + shared constants
 *   domain/transcript/semantics.ts           classification + row provenance
 *   domain/transcript/context-semantics.ts   Context form/provenance/ambient
 *   domain/transcript/workflow-projection.ts ONE Workflow projection
 *   domain/transcript/search.ts              search corpus/source/match identity
 *   domain/transcript/grouping.ts            read-grouping eligibility
 *   domain/transcript/window.ts              window semantics + controller
 *   domain/transcript/folder.ts              ONE TranscriptFolder fold authority
 *
 * TS8-D moved the `/transcript` Markdown artifact formatter out to
 * `src/client/artifact/transcript-markdown.ts`. This facade now owns NO local
 * implementation, no Markdown helper, and imports neither `client/**` nor
 * `tui/**`: it re-exports the canonical semantic surface (including the
 * transcript-neutral content-block helpers) and nothing else.
 * @module @xmoon76/dsh-pi-tui/transcript
 */

export { isPostTurnReplayEvidence } from './domain/transcript/semantics.ts'

export { PTC_MAX_DEPTH, THINKING_TAIL_CAP, TURN_END_REASON_KINDS } from './domain/transcript/types.ts'
export type {
  AssistantDisplayBlock,
  CommandId,
  FoldOptions,
  PresentedFilePresentation,
  SessionEventSeq,
  TranscriptCommandMessage,
  TranscriptCommandOutcome,
  TranscriptItemId,
  TranscriptMessage,
  TranscriptSystemOrigin,
  TranscriptTiming,
  TranscriptToolMessage,
  TranscriptToolOrigin,
  TurnActivity,
  TurnEndReason,
} from './domain/transcript/types.ts'

export { WorkflowProjection, workflowPhaseKey, workflowReadablePhase } from './domain/transcript/workflow-projection.ts'
export type {
  TranscriptWorkflowMessage,
  WorkflowChildSessionId,
  WorkflowMemberView,
  WorkflowOwner,
  WorkflowRunId,
  WorkflowRunStatus,
} from './domain/transcript/workflow-projection.ts'

export {
  transcriptSearchCorpus,
  transcriptSearchMatchKey,
  transcriptSearchSourceKey,
  transcriptSearchText,
} from './domain/transcript/search.ts'
export type {
  TranscriptSearchCorpus,
  TranscriptSearchCorpusSpan,
  TranscriptSearchMatch,
  TranscriptSearchSource,
} from './domain/transcript/search.ts'

export { groupConsecutiveReads, isGroupableRead, recentTurnThreshold } from './domain/transcript/grouping.ts'
export { windowMessages } from './domain/transcript/window.ts'
export type { TranscriptWindow } from './domain/transcript/window.ts'

export {
  activeSubCallsOf,
  assistantBlocksVisibleNow,
  assistantCommittedBeforeSteer,
  assistantEntryVisibleNow,
  assistantLatestStepOf,
  assistantPresentationRevision,
  assistantStepOf,
  childOwnEvents,
  foldTranscript,
  subCallDisplayStatus,
  terminalFailureFromResult,
  textOf,
  transcriptTimingOf,
  TranscriptFolder,
} from './domain/transcript/folder.ts'

export { textWithAttachmentMarkers, userBlocksVisibleNow } from './domain/transcript/content-blocks.ts'
