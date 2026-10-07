/**
 * The pending-input presentation join (D2.2 / TS8-E): the ONE authoritative
 * place that turns the Host-owned pending-input projection plus the
 * client-local submission echoes into the queue-pane rows and the ordered
 * conversation-tail lane (user steering rows interleaved with non-user context
 * occurrences) the TUI renders.
 *
 * This is an APPLICATION-presentation projection: it reads the current
 * subject's authoritative pending snapshot and the local optimistic echoes and
 * produces the mounted surface's presentation DTOs. It owns no submission
 * write, no echo lifecycle and no terminal mechanics — the concrete TUI
 * (`tui-app.ts` + `tui/components/**`) only consumes and renders these DTOs.
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
 * @module @xmoon76/dsh-pi-tui/app/surface/pending-presentation
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { pendingSubmissionsNotReplaced } from '../submission/pending-submission.ts'
import type { QueueInboxMessage } from '../submission/pending-input.ts'
import type { SubmissionPresentationItem } from '../submission/presentation.ts'
import type { PendingInputItem, PendingInputSnapshot } from '../../runtime/pending-input-reader-port.ts'
import { fileAttachmentSummary } from '../../domain/media/file-summary.ts'

/** One semantic queued pending-input row for the queue pane. */
export interface QueueItem {
  /** The pending message id (agent inbox identity), or a local request id. */
  id: string
  /** The message text, single-line display form. */
  text: string
  /** next-turn followup vs next-step steer. */
  mode: 'followup' | 'steer'
  /** The correlation identity (authoritative rpc id or local request id). */
  rpcId?: string
  /** A client-local echo not yet backed by an authoritative occurrence. */
  local?: boolean
}

/** One pending user-input row for the ephemeral conversation-tail lane: an
 * authoritative `steering` occurrence or a client-local submission echo. It is
 * never durable transcript content. */
export interface PendingUserRow {
  /** The occurrence id (Host) or request id (local echo). */
  id: string
  /** Display text (attachment markers included). */
  text: string
  /** The correlation identity (authoritative rpc id or local request id). */
  rpcId?: string
  /** A client-local echo not yet backed by an authoritative occurrence. */
  local?: boolean
  /** The pending status line: an accepted steer reads `steering…`, an idle
   * prompt awaiting its durable message reads `sending…`. */
  status?: 'steering' | 'sending'
  /** Whether `text` is the row's COMPLETE content (text-only user input), so
   * the same visual-row disclosure as a durable text-only user message
   * applies. ABSENT means UNKNOWN and fails open to the FULL presentation —
   * a pending row carrying attachment markers must never be folded only to
   * materialize as a full mixed-content durable bubble. */
  foldableText?: boolean
}

/** One pending non-user Context row for the ephemeral conversation-tail
 * lane: an authoritative `placement === 'context'` occurrence (background /
 * injected input parked in the Host inbox before materialization). It has a
 * NON-user visual identity, is never durable transcript content, and never
 * correlates with a client-local echo. */
export interface PendingContextRow {
  /** The Host occurrence id. */
  id: string
  /** Display text (the runner's single-line content projection). */
  text: string
}

/** One ordered conversation-tail row: the join's projection unit for the
 * ephemeral lane — an authoritative `steering` occurrence or a client-local
 * user echo (`user`), or an authoritative non-user `context` occurrence
 * (`context`). It lives beside its row shapes and the join that produces it,
 * so there is exactly one definition. */
export type PendingTailRow =
  | { readonly kind: 'user'; readonly row: PendingUserRow }
  | { readonly kind: 'context'; readonly row: PendingContextRow }

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

/** The single atomic pending-input presentation update. Queue rows, the ONE
 * ordered ephemeral conversation-tail lane (user steering rows interleaved
 * with non-user context occurrences), and the subject's activity move
 * together so a handoff never paints an intermediate blank/duplicate frame. */
export interface PendingInputPresentation {
  /** Authoritative `queued` occurrences plus client-local queued echoes. */
  queued: readonly QueueItem[]
  /** The ordered conversation tail: `steering`/local-user rows plus
   * non-user `context` occurrences, in the join's projection order. */
  tail: readonly PendingTailRow[]
  /** Activity of the same pending-input subject (drives the queue steer hint). */
  running: boolean
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
