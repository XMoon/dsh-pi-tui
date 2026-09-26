/**
 * The pending-input presentation join (D2.2): the ONE authoritative place that
 * turns the Host-owned pending-input projection plus the client-local
 * submission echoes into the queue-pane and steering-lane rows the TUI renders.
 *
 * The join is identity-only: an authoritative occurrence suppresses a local
 * echo when their `rpcId`/`requestId` match. Text is never a correlation key,
 * so two same-text submissions stay distinct. Authoritative rows always precede
 * client-local echoes, and `context` occurrences never enter the pending USER
 * surface.
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
import type { PendingUserRow, QueueItem } from './tui-app.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { fileAttachmentSummary } from './content-block-presentation.ts'

/** The joined pending-input rows for one subject. */
export interface PendingPresentationRows {
  /** Authoritative `queued` occurrences plus client-local queued echoes. */
  readonly queued: readonly QueueItem[]
  /** Authoritative `steering` occurrences plus local user echoes. */
  readonly steering: readonly PendingUserRow[]
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
 * echoes. `context` is deliberately excluded: this surface owns pending USER
 * input only.
 */
export function buildPendingPresentation(input: PendingPresentationInput): PendingPresentationRows {
  const queued: QueueItem[] = []
  const steering: PendingUserRow[] = []
  const running = input.pending?.running ?? false
  if (input.pending !== undefined) {
    for (const item of input.pending.items) {
      if (item.placement === 'queued') {
        queued.push({
          id: item.id,
          ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
          text: input.textOf(item.content),
          mode: 'followup',
        })
      } else if (item.placement === 'steering') {
        steering.push({
          id: item.id,
          ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
          text: input.textOf(item.content),
          status: 'steering',
          foldableText: isTextOnlyContent(item.content),
        })
      }
    }
  }
  // Suppress a local echo only while an authoritative occurrence with the same
  // rpc id is visible. The echo is never deleted here: the Host may claim its
  // pending occurrence before the durable user/message lands, so the echo is
  // re-presented in that window by the caller's next join.
  const authoritativeRpcIds = new Set<string>()
  for (const row of [...queued, ...steering]) {
    if (row.rpcId !== undefined) authoritativeRpcIds.add(row.rpcId)
  }
  for (const echo of pendingSubmissionsNotReplaced(input.submissions, authoritativeRpcIds)) {
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
      steering.push({
        id: echo.requestId,
        rpcId: echo.requestId,
        text,
        local: true,
        status: echo.placement === 'transcript' ? 'sending' : 'steering',
        ...(echo.foldableText === undefined ? {} : { foldableText: echo.foldableText }),
      })
    }
  }
  return { queued, steering, running }
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
