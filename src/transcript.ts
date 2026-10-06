/**
 * Stable transcript facade (TS7): re-exports the ONE transcript semantic
 * authority from \`src/domain/transcript/**\` and keeps the existing Markdown
 * exporter compatibility island.
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
 * This facade owns NO mutable transcript state, constructs no second fold,
 * caches no domain fact and reimplements no classification. The Markdown
 * exporter stays here (outside the domain) through TS8; it consumes the
 * canonical semantic owners but keeps its current visible output.
 * @module @xmoon76/dsh-pi-tui/transcript
 */

import { isReplacementSurfaceEvent, TOOL_NOT_STARTED } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { finalizedBlockFallbackText, fileAttachmentSummary, userBlocksVisibleNow, textWithAttachmentMarkers } from './content-block-presentation.ts'
import { WorkflowProjection } from './domain/transcript/workflow-projection.ts'
import type { TranscriptWorkflowMessage } from './domain/transcript/workflow-projection.ts'

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

export { textWithAttachmentMarkers, userBlocksVisibleNow }

/** Build a markdown fence longer than any backtick run in the payload. */
function markdownCodeFence(payload: string): string {
  let longestRun = 0
  let run = 0
  for (const character of payload) {
    if (character === '`') run += 1
    else {
      longestRun = Math.max(longestRun, run)
      run = 0
    }
  }
  longestRun = Math.max(longestRun, run)
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}json\n${payload}\n${fence}`
}

/** Escape inline presentation text without changing ordinary metadata text. */
function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\`*_{}\[\]()!<>]/g, '\\$&')
}

/** The markdown projection of finalized content blocks: rich attachment
 * metadata remains readable, opaque ids are labeled as attachment identities,
 * and unknown block payloads use the same bounded explicit fallback as the
 * ordinary TUI. Attachment bytes are never embedded. */
function markdownContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') {
      parts.push(buffer)
      buffer = ''
    }
  }
  for (const block of blocks) {
    if (block.type === 'text') {
      buffer += block.text
    } else if (block.type === 'image') {
      flush()
      const attachment = block.attachment
      parts.push(`> 🖼️ ${attachment.name ?? 'image'} · ${attachment.width}×${attachment.height} · attachment \`${attachment.attachmentId}\``)
    } else if (block.type === 'file') {
      flush()
      const attachment = block.attachment
      parts.push(`> ${escapeMarkdownInline(fileAttachmentSummary(attachment))} · attachment \`${attachment.attachmentId}\``)
    } else if (block.type === 'reasoning' || block.type === 'tool-call') {
      // These known process blocks have their existing dedicated transcript
      // semantics; every other finalized block uses the explicit bounded
      // fallback below.
      continue
    } else {
      flush()
      const fallback = finalizedBlockFallbackText(block)
      const newline = fallback.indexOf('\n')
      const heading = newline === -1 ? fallback : fallback.slice(0, newline)
      const payload = newline === -1 ? '' : fallback.slice(newline + 1)
      parts.push(`> ${escapeMarkdownInline(heading)}${payload === '' ? '' : `\n\n${markdownCodeFence(payload)}`}`)
    }
  }
  flush()
  return parts.join('\n\n')
}

/** Render one session's log as a readable markdown transcript for `/transcript`. */
export function renderTranscriptMarkdown(session: {
  header: SessionHeader
  snapshotEvents(): readonly SessionEvent[]
}): string {
  const lines: string[] = [
    `# Session ${session.header.id}`,
    `- cwd: ${session.header.cwd ?? 'unknown'}`,
    ...session.header.agentPreset === undefined
      ? []
      : [`- agent preset: ${session.header.agentPreset}`],
    '',
  ]
  // Workflow runs: the SHARED semantic projection (the same owner-tracking
  // engine as the visual Transcript fold) folds the durable lifecycle events
  // into one readable block per run, flushed at run-end (or at export end
  // for a run without one — plan §7.4: no rich format, the new semantic
  // kind must not regress the export). Reusing the projection means the
  // export can never drift from the UI on run/member statuses — an
  // owner-closed run without a terminal fact exports as `interrupted`, not
  // `running`.
  const workflow = new WorkflowProjection()
  // The visual fold's replay fences: a step/start or step/end for a turn
  // whose turn/end already passed is a replay artifact and must not reopen
  // the owner lifecycle (the export applies the same fence so a replayed
  // fragment can never diverge from the visual projection).
  const completedTurns = new Set<number>()
  // The visual fold's current-turn rule: only the turn/start of the NEWEST
  // turn opens the workflow turn (a late turn/start for an older turn — or
  // for a closed turn — is a no-op).
  let currentTurn = -1
  // Unresolved assistant tool-request names by call id (TOOL_NOT_STARTED
  // compat): the export walks the same durable evidence as the visual fold
  // — a `tool-call` block requests a tool, `tool/call` starts it, and a
  // `TOOL_NOT_STARTED` result settles the request as a never-started
  // diagnostic without inventing a `### Tool <name>` call heading.
  const requestedToolNames = new Map<string, { turn: number; step: number; name: string }>()
  // Call identities with an OBSERVED durable `tool/call`, scoped by the
  // same composite fence as request identity (call id + turn + step): an
  // observation from an earlier turn/step never leaks into a later reused
  // id's recovery export (the fold's `pending === undefined` guard,
  // mirrored here).
  const observedToolCalls = new Set<string>()
  // Alpha.4 Session shape: the event log arrives as a snapshot read, never a
  // live array — the markdown export is a full-log fold by definition.
  for (const event of session.snapshotEvents()) {
    // The same append-origin contract as the transcript fold: a surface
    // replacement is a model-only rewrite (pruned tool result, compaction
    // summary checkpoint) and must never be replayed in a human-facing
    // export — the append-origin original is already rendered at its log
    // position. Unmarked legacy events keep their current behavior.
    if (isReplacementSurfaceEvent(event)) continue
    switch (event.type) {
      // Owner lifecycle: the shared projection tracks the open step/turn so
      // run-start captures the same owner the visual fold would. The
      // completed-turn fence mirrors the visual fold's activity.completed
      // gate (a late step/start or step/end after turn/end is a no-op).
      case 'step/start': {
        if (!completedTurns.has(event.data.turn)) workflow.onStepStart(event.data.turn, event.data.step)
        break
      }
      case 'step/end': {
        if (!completedTurns.has(event.data.turn)) workflow.onStepEnd(event.data.turn, event.data.step)
        break
      }
      case 'turn/start': {
        // The visual fold's exact gate: the turn is opened only for the
        // NEWEST turn's first turn/start, and never for a closed turn (the
        // projection's monotonic open-turn rule covers a mid-turn replay of
        // the open turn itself).
        if (event.data.turn > currentTurn) currentTurn = event.data.turn
        if (!completedTurns.has(event.data.turn) && event.data.turn === currentTurn) {
          workflow.onTurnStart(event.data.turn)
        }
        break
      }
      case 'turn/end': {
        completedTurns.add(event.data.turn)
        workflow.onTurnEnd(event.data.turn)
        break
      }
      case 'user/message': {
        const text = markdownContent(event.data.content)
        if (text !== '') lines.push(`## User\n\n${text}\n`)
        break
      }
      case 'assistant/message': {
        const text = markdownContent(event.data.message.content)
        if (text !== '') lines.push(`## Assistant\n\n${text}\n`)
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            requestedToolNames.set(block.id, { turn: event.data.turn, step: event.data.step, name: block.name })
          }
        }
        break
      }
      case 'tool/call': {
        requestedToolNames.delete(event.data.callId)
        observedToolCalls.add(`${event.data.turn}:${event.data.step}:${event.data.callId}`)
        const args = typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments)
        lines.push(`### Tool ${event.data.name}\n\n\`\`\`json\n${args}\n\`\`\`\n`)
        break
      }
      case 'tool/result': {
        const request = requestedToolNames.get(event.data.message.toolCallId)
        requestedToolNames.delete(event.data.message.toolCallId)
        const text = markdownContent(event.data.message.content)
        if (event.data.error?.code === TOOL_NOT_STARTED
          && !observedToolCalls.has(`${event.data.turn}:${event.data.step}:${event.data.message.toolCallId}`)) {
          // A not-started recovery has NO durable tool/call behind it: the
          // heading states the fact instead of inventing one. The name is
          // proven only under the full call-id + turn + step fence.
          const name = request !== undefined
            && request.turn === event.data.turn
            && request.step === event.data.step
            ? request.name : undefined
          lines.push(`### Tool request not started${name === undefined ? '' : `: ${name}`}\n`)
          if (text !== '') lines.push(`<details><summary>recovery</summary>\n\n${text}\n\n</details>\n`)
          break
        }
        if (text !== '') lines.push(`<details><summary>result</summary>\n\n${text}\n\n</details>\n`)
        break
      }
      // PTC nested sub-dispatches (alpha.2 log-only events): the outer
      // curated result may not carry the nested output, so the export
      // keeps the sub-call args and rendered content (simple indented
      // form — no new export format).
      case 'tool/ptc-dispatch-start': {
        const data = event.data as { name: string; subCallId: string; arguments: unknown }
        const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments)
        lines.push(`### Nested tool ${data.name} [${data.subCallId}]\n\n\`\`\`json\n${args}\n\`\`\`\n`)
        break
      }
      case 'tool/ptc-dispatch': {
        const data = event.data as { subCallId: string; isError: boolean; content: readonly ContentBlock[] }
        const text = markdownContent(data.content ?? [])
        if (text !== '') {
          lines.push(`<details><summary>${data.isError === true ? 'nested error' : 'nested result'} [${data.subCallId}]</summary>\n\n${text}\n\n</details>\n`)
        }
        break
      }
      case 'command/run': {
        lines.push(`> /${event.data.name}${event.data.args === '' ? '' : ` ${event.data.args}`}\n`)
        break
      }
      case 'tool-workflow/run-start': {
        workflow.onRunStart(event.data.runId, event.data.name, 0)
        break
      }
      case 'tool-workflow/agent-start': {
        const { runId, seq, label, phase, childId } = event.data
        workflow.onAgentStart(runId, seq, label, phase === undefined ? null : phase, childId)
        break
      }
      case 'tool-workflow/agent-end': {
        workflow.onAgentEnd(event.data.runId, event.data.seq, event.data.outcome)
        break
      }
      case 'tool-workflow/run-end': {
        const message = workflow.onRunEnd(event.data.runId, event.data.stopReason)
        if (message !== undefined) lines.push(workflowMarkdownBlock(message))
        break
      }
      default:
        break
    }
  }
  // A run without a terminal event still exports its current state (the
  // export is a full-log fold — never drop the record).
  for (const message of workflow.activeRuns()) {
    lines.push(workflowMarkdownBlock(message))
  }
  return lines.join('\n')
}

/** One readable Workflow export block (plan §7.4): the run line with its
 * projected status, then the member rows in arrival order. The statuses
 * come from the shared {@link WorkflowProjection} — the same vocabulary as
 * the visual Transcript (`error` renders as `failed`; an owner-closed run
 * without a terminal fact renders `interrupted`). */
function workflowMarkdownBlock(message: TranscriptWorkflowMessage): string {
  const memberLines = message.members.map(member => {
    const identity = member.phase === null || member.phase === ''
      ? member.label
      : `${member.phase} / ${member.label}`
    return `  ${identity} — ${member.status}`
  })
  return [`Workflow: ${message.name} — ${message.status}`, ...memberLines].join('\n')
}
