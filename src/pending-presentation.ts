/**
 * The pending-input presentation join (D2.2): the ONE authoritative place that
 * turns the Host-owned pending-input projection plus the client-local
 * submission echoes into the queue-pane rows and the ordered conversation-tail
 * lane (user steering rows interleaved with non-user context occurrences) the
 * TUI renders.
 *
 * The join is identity-only: an authoritative occurrence suppresses a local
 * echo when their `rpcId`/`requestId` match. Text is never a correlation key,
 * so two same-text submissions stay distinct — and a non-user `context`
 * occurrence never correlates with a local echo at all. Authoritative rows
 * always precede client-local echoes.
 *
 * The runner supplies the content text formatter, so this module stays
 * Host-free and transport-free while the single join rule remains shared by the
 * Direct production path and the experimental Remote path.
 *
 * It also owns the queue-PANE row fold (`foldQueueRows` plus the semantic
 * pending-item projection) the mounted surface renders.
 *
 * @module @xmoon76/dsh-pi-tui/pending-presentation
 */

import { pendingSubmissionsNotReplaced } from './pending-submission.ts'
import type { SubmissionPresentationItem } from './submission-presentation.ts'
import type { PendingInputItem, PendingInputSnapshot } from './runtime/pending-input-reader-port.ts'
import type { PendingContextRow, PendingTailRow, PendingUserRow, QueueItem } from './tui-app.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { fileAttachmentSummary } from './domain/media/file-summary.ts'

/** The joined pending-input rows for one subject. */
export interface PendingPresentationRows {
  /** Authoritative `queued` occurrences plus client-local queued echoes. */
  readonly queued: readonly QueueItem[]
  /** The ONE ordered conversation-tail lane: authoritative `steering` rows
   * plus local user echoes, interleaved with authoritative non-user `context`
   * occurrences in projection order. */
  readonly tail: readonly PendingTailRow[]
  /** Activity of the subject (drives the queue-pane steer hint). */
  readonly running: boolean
}

/** Inputs of one join. */
export interface PendingPresentationInput {
  /** The Host-owned projection, or `undefined` when the subject is unavailable. */
  readonly pending: PendingInputSnapshot | undefined
  /** The client-local optimistic echoes for the subject, insertion-ordered. */
  readonly submissions: readonly SubmissionPresentationItem[]
  /** Render one occurrence's detached content as the pane's single-line text. */
  textOf(content: readonly unknown[]): string
}

/**
 * Join authoritative pending-input occurrences with client-local submission
 * echoes. The tail is ONE ordered projection: authoritative `steering` rows,
 * local user echoes and authoritative `context` occurrences render in the
 * snapshot's order (Context A, Steering B, Context C stays A/B/C). Context
 * occurrences have a NON-user visual identity: they never correlate with a
 * local echo (only a real user `rpcId` identity suppresses one) and never
 * enter the queue pane.
 */
export function buildPendingPresentation(input: PendingPresentationInput): PendingPresentationRows {
  const queued: QueueItem[] = []
  const tail: PendingTailRow[] = []
  // The rpc identities of authoritative USER occurrences (queued + steering).
  // A `context` occurrence contributes none: it never correlates with a
  // local echo.
  const userRpcIds = new Set<string>()
  const running = input.pending?.running ?? false
  if (input.pending !== undefined) {
    for (const item of input.pending.items) {
      switch (item.placement) {
        case 'queued':
          queued.push({
            id: item.id,
            ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
            text: input.textOf(item.content),
            mode: 'followup',
          })
          break
        case 'steering':
          tail.push({
            kind: 'user',
            row: {
              id: item.id,
              ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
              text: input.textOf(item.content),
              status: 'steering',
              foldableText: isTextOnlyContent(item.content),
            },
          })
          break
        case 'context':
          tail.push({
            kind: 'context',
            row: {
              id: item.id,
              text: input.textOf(item.content),
            },
          })
          break
      }
      if (item.placement !== 'context' && item.rpcId !== undefined) userRpcIds.add(item.rpcId)
    }
  }
  // Suppress a local echo only while an authoritative USER occurrence with
  // the same rpc id is visible. The echo is never deleted here: the Host may
  // claim its pending occurrence before the durable user/message lands, so
  // the echo is re-presented in that window by the caller's next join.
  for (const echo of pendingSubmissionsNotReplaced(input.submissions, userRpcIds)) {
    const text = echoText(echo)
    if (echo.placement === 'queued') {
      queued.push({
        id: echo.requestId,
        rpcId: echo.requestId,
        text,
        mode: 'followup',
        local: true,
      })
    } else {
      tail.push({
        kind: 'user',
        row: {
          id: echo.requestId,
          rpcId: echo.requestId,
          text,
          local: true,
          status: echo.placement === 'transcript' ? 'sending' : 'steering',
          ...(echo.foldableText === undefined ? {} : { foldableText: echo.foldableText }),
        },
      })
    }
  }
  return { queued, tail, running }
}

/**
 * Whether an authoritative pending occurrence's structural content is
 * text-only, so the ephemeral row may join the long-user visual-row fold. Any
 * unrecognized block (image/file/attachment/generic non-text) fails open to
 * the FULL presentation — the pending row must never be folded only to
 * materialize as a full mixed-content durable bubble.
 */
function isTextOnlyContent(content: readonly unknown[]): boolean {
  if (content.length === 0) return false
  return content.every(block =>
    typeof block === 'object'
    && block !== null
    && (block as { type?: unknown }).type === 'text')
}

/**
 * Render one local echo's display text. The Direct ledger carries attachment
 * markers inside `text`; the official Remote pending submission does not, so
 * its structured attachments are appended here — an image-only echo must never
 * render as an empty row.
 */
function echoText(echo: SubmissionPresentationItem): string {
  if (echo.attachments.length === 0) return echo.text
  const markers = echo.attachments.map(attachment =>
    attachment.kind === 'image' ? `[Image: ${attachment.label}]` : `[File: ${attachment.label}]`)
  return [echo.text, ...markers].filter(part => part !== '').join(' ')
}

/** One semantic pending-input item as the queue mirror sees it. */
export interface QueueInboxMessage {
  readonly id: string
  readonly content: readonly ContentBlock[]
}

/** Adapt one semantic pending-input item to the queue pane's presentation
 * projection without reintroducing backend-specific fields. */
export function queueInboxMessageOf(item: PendingInputItem): QueueInboxMessage {
  return {
    id: item.id,
    content: item.content as readonly ContentBlock[],
  }
}

/** The queue-pane rows for one semantic pending-input batch. */
export interface QueueFoldResult {
  readonly rows: QueueItem[]
}

/**
 * The queue-pane display text of one message's content (review finding 5):
 * text blocks verbatim, image blocks as a compact `🖼️ name` summary (the
 * marker carries U+FE0F so fonts with an emoji face render it 2 cells wide
 * — the width math's expectation — and never overlap the name) — an
 * image-only queued message shows `🖼️ shot.png` instead of an empty row,
 * and a mixed message advertises its image. The queue row stays one line.
 */
export function queueTextOf(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(`🖼️ ${block.attachment.name ?? 'image'}`)
    else if (block.type === 'file') parts.push(fileAttachmentSummary(block.attachment))
  }
  return parts.join(' ')
}

/** Build queue-pane rows from semantic pending-input occurrences, preserving
 * their order and content without inspecting backend-specific metadata. */
export function foldQueueRows(
  messages: readonly QueueInboxMessage[],
  mode: 'followup' | 'steer',
): QueueFoldResult {
  return {
    rows: messages.map(message => ({
      id: message.id,
      text: queueTextOf(message.content),
      mode,
    })),
  }
}
